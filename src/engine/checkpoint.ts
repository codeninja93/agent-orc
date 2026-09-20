/**
 * AD-4 / Consistency Conventions — the reconciler is the sole writer of a `state.json`, and every
 * state write is atomic.
 *
 * Atomic means a temporary file in the *same directory* and then a rename: a reader sees either the
 * previous checkpoint or the new one, never a partial. Writing in place would make a process killed
 * mid-write leave a truncated JSON document indistinguishable from a real checkpoint, and AD-7
 * requires the opposite — that killing the engine at any instant leaves a state a restart can read.
 *
 * Reading has two outcomes that must not be confused:
 *
 * - a checkpoint this build cannot *recognise* — an unrecognised `schema_version` — is **refused**,
 *   because AD-28 gives configuration and state no forward-compatibility latitude at all;
 * - a checkpoint this build cannot *trust* — absent, unparseable, or not the declared shape — is
 *   **discarded**, because AD-4 makes it a derived artifact and the log can produce another.
 *
 * Refusing the second case would strand a run on a corrupt derived file; discarding the first would
 * be the silent implicit upgrade AD-28 forbids.
 */
import {
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  closeSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { join } from 'node:path';

import {
  RUN_STATE_FILE_NAME,
  RunStateSchema,
  SchemaVersionRefusal,
  parseVersionedArtifact,
} from '../contracts/index.js';
import type { RunState } from '../contracts/index.js';
import { runPaths } from '../runtime/index.js';
import type { RunPaths } from '../runtime/index.js';

/** `runs/<run-id>/state.json`. */
export const checkpointPath = (paths: RunPaths): string => join(paths.runDir, RUN_STATE_FILE_NAME);

/** The artifact name a refusal or a discard names, so a message points at a file a person can find. */
export const checkpointArtifactName = (runId: string): string =>
  `runs/${runId}/${RUN_STATE_FILE_NAME}`;

/** Why a checkpoint on disk was not usable. Every one of them means "rebuild from the log". */
export const CHECKPOINT_DISCARD_REASONS = [
  'absent',
  'unreadable',
  'not-json',
  'not-a-run-state',
  'foreign-run',
] as const;

export type CheckpointDiscardReason = (typeof CHECKPOINT_DISCARD_REASONS)[number];

export interface CheckpointDiscarded {
  readonly reason: CheckpointDiscardReason;
  readonly detail: string;
}

/**
 * What a read found. Exactly one of `state` and `discarded` is non-null, so a caller cannot forget
 * to handle the discard: there is no third "empty but fine" outcome to fall through.
 */
export interface CheckpointRead {
  readonly state: RunState | null;
  readonly discarded: CheckpointDiscarded | null;
  readonly path: string;
}

const discard = (
  path: string,
  reason: CheckpointDiscardReason,
  detail: string,
): CheckpointRead => ({ state: null, discarded: { reason, detail }, path });

/**
 * Read `runs/<run-id>/state.json`.
 *
 * An unrecognised `schema_version` throws {@link SchemaVersionRefusal} rather than being reported as
 * a discard: this build must not operate on a state file it does not understand, and rebuilding over
 * it would destroy the evidence of which installer wrote it.
 */
export const readCheckpoint = (paths: RunPaths): CheckpointRead => {
  const path = checkpointPath(paths);
  const artifact = checkpointArtifactName(paths.runId);
  if (!existsSync(path)) return discard(path, 'absent', `${artifact} does not exist`);

  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (thrown: unknown) {
    return discard(
      path,
      'unreadable',
      `${artifact} could not be read: ${thrown instanceof Error ? thrown.message : String(thrown)}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // A truncated checkpoint from a kill mid-write lands here. It is derived, so it is discarded.
    return discard(path, 'not-json', `${artifact} is not whole JSON`);
  }

  let state: RunState;
  try {
    state = parseVersionedArtifact(RunStateSchema, parsed, artifact);
  } catch (thrown: unknown) {
    // AD-28 has no latitude for a version this build does not recognise: it is refused, not rebuilt.
    if (thrown instanceof SchemaVersionRefusal) throw thrown;
    return discard(
      path,
      'not-a-run-state',
      `${artifact} does not carry the declared run.state shape: ` +
        `${thrown instanceof Error ? thrown.message : String(thrown)}`,
    );
  }

  if (state.run !== paths.runId) {
    // A checkpoint copied from another run would otherwise be served as this run's, which is the
    // two-authorities-for-one-fact failure AD-4 forbids, arriving by a copied file.
    return discard(
      path,
      'foreign-run',
      `${artifact} names run "${state.run}" but sits in the directory of "${paths.runId}"`,
    );
  }

  return { state, discarded: null, path };
};

/** The suffix of a checkpoint's temporary file, so a sweep can recognise its own debris. */
const TEMP_SUFFIX = '.tmp';

const tempPrefix = (): string => `${RUN_STATE_FILE_NAME}.${String(process.pid)}.`;

/** A monotonic per-process counter, so two writes in one millisecond cannot share a temp name. */
let tempCounter = 0;

/**
 * Remove temporary checkpoints this process's predecessors left behind.
 *
 * A rename either happened or did not, so a surviving temporary file is always debris from a killed
 * write and never a checkpoint a reader should see. Only files matching the checkpoint's own temp
 * shape are touched: nothing else in the run directory is this unit's to delete.
 */
export const sweepCheckpointTemporaries = (paths: RunPaths): number => {
  let removed = 0;
  let names: string[];
  try {
    names = readdirSync(paths.runDir);
  } catch {
    return 0;
  }
  for (const name of names) {
    if (!name.startsWith(`${RUN_STATE_FILE_NAME}.`) || !name.endsWith(TEMP_SUFFIX)) continue;
    try {
      unlinkSync(join(paths.runDir, name));
      removed += 1;
    } catch {
      // Another engine's live temporary, or a permission fault. Neither is this sweep's business.
    }
  }
  return removed;
};

/**
 * Write the checkpoint atomically: temporary file in the same directory, fsync, rename, fsync the
 * directory.
 *
 * Both fsyncs matter and for different reasons. The first makes the temporary file's *contents*
 * durable before it is given the real name, so a crash cannot promote a half-written file. The
 * second makes the *rename itself* durable, so a crash cannot lose a checkpoint that was reported
 * written. A filesystem that refuses either does not make the rename less atomic, so neither failure
 * is fatal.
 */
export const writeCheckpoint = (paths: RunPaths, state: RunState): RunState => {
  // Validated before the write, not after: an invalid checkpoint must never reach disk, where the
  // next reader would discard it and silently lose everything the fold had established.
  const validated = RunStateSchema.parse(state);
  if (validated.run !== paths.runId) {
    throw new Error(
      `Refusing to write ${checkpointArtifactName(paths.runId)}: the checkpoint names run ` +
        `"${validated.run}". Only the reconciler writes a state.json, and it writes each run's own.`,
    );
  }

  mkdirSync(paths.runDir, { recursive: true });
  const target = checkpointPath(paths);
  tempCounter += 1;
  const temp = join(paths.runDir, `${tempPrefix()}${String(tempCounter)}${TEMP_SUFFIX}`);

  writeFileSync(temp, `${JSON.stringify(validated, null, 2)}\n`, 'utf8');
  const fd = openSync(temp, 'r');
  try {
    fsyncSync(fd);
  } catch {
    // Contents unsynced is a durability weakness, not a torn checkpoint: the rename is still atomic.
  } finally {
    closeSync(fd);
  }

  renameSync(temp, target);

  try {
    const dir = openSync(paths.runDir, 'r');
    try {
      fsyncSync(dir);
    } finally {
      closeSync(dir);
    }
  } catch {
    // Directory fsync is unsupported on some platforms; the rename has still replaced the file.
  }

  return validated;
};

/**
 * A checkpoint writer bound to one run.
 *
 * Instantiating it is what a unit does to *become* the sole writer for that run, which makes the
 * "only the reconciler writes a state.json" convention visible in the type rather than left to a
 * comment. Exclusivity itself is the AD-30 engine lock's job: one engine per `ORCH_HOME` means one
 * writer per checkpoint, so nothing here takes a second lock of its own.
 */
export class Checkpoint {
  readonly paths: RunPaths;

  constructor(paths: RunPaths) {
    this.paths = paths;
  }

  static forRun(runId: string, orchHome?: string): Checkpoint {
    return new Checkpoint(runPaths(runId, orchHome));
  }

  get path(): string {
    return checkpointPath(this.paths);
  }

  read(): CheckpointRead {
    return readCheckpoint(this.paths);
  }

  write(state: RunState): RunState {
    return writeCheckpoint(this.paths, state);
  }

  sweep(): number {
    return sweepCheckpointTemporaries(this.paths);
  }
}

/** Every run id with a directory under `ORCH_HOME/runs/`, in ULID order (chronological). */
export const listRunIds = (runsDirectory: string): string[] => {
  let entries: string[];
  try {
    entries = readdirSync(runsDirectory, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
  return entries.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
};

/**
 * A single `writeSync` of the serialised checkpoint, used by nothing in production and exported so a
 * test can *demonstrate* the non-atomic alternative it is asserting against. Keeping the comparison
 * in the same module as the real writer is what stops the atomicity test from drifting into a test of
 * a helper nobody uses.
 */
export const writeCheckpointNonAtomically = (paths: RunPaths, serialised: string): void => {
  mkdirSync(paths.runDir, { recursive: true });
  const fd = openSync(checkpointPath(paths), 'w');
  try {
    writeSync(fd, serialised);
  } finally {
    closeSync(fd);
  }
};
