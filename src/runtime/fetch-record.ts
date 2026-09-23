/**
 * AD-13 / AD-14 — the run shared fetch record.
 *
 * Every external read is recorded, through the AD-21 pass, to both `events.jsonl` (as
 * `fetch.recorded`) and `runs/<run-id>/fetch-record.json`. A request already present is served from
 * the record and the domain is not contacted, so within one run an external record has exactly one
 * value and a re-run is deterministic.
 *
 * The record is written by whoever holds the run's log: a `Recorder` is required rather than a path,
 * which makes the AD-29 single-writer claim cover this artifact too. Writes are atomic — a temporary
 * file in the same directory, then a rename — per the Consistency Conventions.
 */
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';

import {
  CURRENT_SCHEMA_VERSION,
  renderCause,
  FETCH_RECORD_CONTRACT_ID,
  FetchRecordSchema,
  emptyFetchRecord,
  fetchRequestKey,
  findFetchRecordEntry,
  formatTimestamp,
  parseVersionedArtifact,
} from '../contracts/index.js';
import type { FetchRecord, FetchRecordEntry, FetchRequest, FetchResponse } from '../contracts/index.js';

import { createFileExclusively } from './exclusive-create.js';
import { FETCH_RECORD_FILE_NAME, runPaths } from './paths.js';
import type { RunPaths } from './paths.js';
import { RedactionFailedError } from './recorder.js';
import type { Recorder } from './recorder.js';
import { createRedactor } from './redaction.js';
import type { RedactionFailure, RedactionPolicy, Redactor } from './redaction.js';

/** A record file belonging to another run. Serving it would make this run's replay someone else's. */
export class ForeignFetchRecordError extends Error {
  readonly code = 'config.invalid';
  readonly expectedRun: string;
  readonly foundRun: string;

  constructor(path: string, expectedRun: string, foundRun: string) {
    super(
      `Refusing ${path}: it records run "${foundRun}" but this is run "${expectedRun}". ` +
        'AD-14 scopes a fetch record to one run; a record copied from another run is not this ' +
        "run's evidence and is never served as if it were.",
    );
    this.name = 'ForeignFetchRecordError';
    this.expectedRun = expectedRun;
    this.foundRun = foundRun;
  }
}

/** Where a served value came from. A re-run of a recorded read never says `domain`. */
export const FETCH_SOURCES = ['domain', 'record'] as const;

export type FetchSource = (typeof FETCH_SOURCES)[number];

export interface ServedFetch {
  readonly entry: FetchRecordEntry;
  readonly response: FetchResponse;
  readonly source: FetchSource;
}

export interface RunFetchRecordOptions {
  /** The holder of the run's log; its claim covers this artifact and its redactor is shared. */
  readonly recorder: Recorder;
  /** The step attributed with a first fetch, or null for a run-level read. */
  readonly step?: string | null;
}

/**
 * Story 2-10 — what a genuinely separate OS process needs to open this run's fetch record when it
 * holds no live `Recorder` and cannot acquire the AD-29 `events.jsonl` writer claim.
 *
 * A Jira MCP server is spawned as a step's own child while the engine's reconciler already holds that
 * claim for the run's whole lifetime, so `Recorder.open()` is not an option for it (review pass 1's
 * finding). {@link RunFetchRecord.openStandalone} is the other door: its own dedicated exclusive lock
 * over `fetch-record.json` alone, and no `events.jsonl` append from this path at all — the reconciler
 * backfills that mirror once it next holds its own live `Recorder` for the run.
 */
export interface StandaloneRunFetchRecordOptions {
  readonly runId: string;
  /** `ORCH_HOME`; defaults to the AD-9 resolution. */
  readonly orchHome?: string;
  /** The step attributed with a first fetch, or null for a run-level read. */
  readonly step?: string | null;
  /** The AD-21 redaction policy. A standalone caller supplies its own; there is no shared `Recorder`. */
  readonly redaction?: RedactionPolicy;
  /**
   * Reclaim a lock whose recorded pid is verifiably gone on this host (AD-30's rule, applied to this
   * dedicated lock). Never reclaims a live holder's lock. Defaults to true.
   */
  readonly reclaimStaleLock?: boolean;
}

/** The holder of a run's standalone fetch-record writer claim, as recorded in the lock file. */
interface FetchRecordWriterClaim {
  readonly pid: number;
  readonly host: string;
  readonly run: string;
  readonly since: string;
}

const isFetchRecordWriterClaim = (value: unknown): value is FetchRecordWriterClaim => {
  if (typeof value !== 'object' || value === null) return false;
  const claim = value as Record<string, unknown>;
  return (
    typeof claim['pid'] === 'number' &&
    typeof claim['host'] === 'string' &&
    typeof claim['run'] === 'string' &&
    typeof claim['since'] === 'string'
  );
};

/** True when a pid is running on this host. A pid that is gone can have its lock reclaimed. */
const fetchRecordPidIsAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (thrown: unknown) {
    // EPERM means the process exists but belongs to another user.
    return (thrown as { code?: string } | null)?.code === 'EPERM';
  }
};

const readFetchRecordClaim = (lockPath: string): FetchRecordWriterClaim | null => {
  try {
    const parsed = parseJson(readFileSync(lockPath, 'utf8'));
    return isFetchRecordWriterClaim(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

const describeFetchRecordHolder = (holder: FetchRecordWriterClaim | null): string =>
  holder === null
    ? 'the claim is held by an unreadable lock file'
    : `the claim is held by pid ${String(holder.pid)} on ${holder.host} since ${holder.since}`;

/**
 * A second standalone writer for one run's fetch record. There is no fallback to unsynchronised
 * writes: a caller that cannot establish this dedicated claim does not write.
 *
 * The same primitive `Recorder`'s own AD-29 writer claim and story 1-8's compare-and-set already use
 * (`createFileExclusively`), scoped to `fetch-record.json` alone rather than to `events.jsonl` — so a
 * standalone tool-server process never collides with the engine's own claim, and two standalone
 * processes for the same run never race each other's read-modify-write of the same file (matrix row
 * 9's sibling: AD-14's "exactly one value" holding regardless of which process reached it first).
 */
export class FetchRecordWriterConflictError extends Error {
  readonly code = 'engine.lock_held';
  readonly path: string;
  readonly holder: FetchRecordWriterClaim | null;

  constructor(path: string, holder: FetchRecordWriterClaim | null, detail: string) {
    super(
      `Refusing to open ${path} for standalone writing: ${detail}. A dedicated lock gives this run's ` +
        'fetch record exactly one standalone writer at a time, the same discipline AD-29 gives ' +
        'events.jsonl, so two tool-server processes for one run never race on the same file.',
    );
    this.name = 'FetchRecordWriterConflictError';
    this.path = path;
    this.holder = holder;
  }
}

/** The suffix a standalone writer's dedicated lock file takes, sibling to the record itself. */
const FETCH_RECORD_LOCK_SUFFIX = '.lock';

/** The emitter name a `fetch.recorded` event carries, whether emitted live or backfilled later. */
export const FETCH_RECORD_EMITTER = 'runtime.fetch-record';

/** The event type AD-13 records every external read under. */
export const FETCH_RECORDED_EVENT_TYPE = 'fetch.recorded';

/**
 * The `fetch.recorded` payload for one entry, shared by the live emitter here and the reconciler's
 * backfill of an entry a standalone writer recorded without one — one shape, so the two can never
 * disagree about what this event says.
 */
export const fetchRecordedEventPayload = (
  entry: FetchRecordEntry,
  source: FetchSource,
): Record<string, unknown> => ({
  key: entry.key,
  domain: entry.request.domain,
  operation: entry.request.operation,
  source,
  ok: entry.response.ok,
  status: entry.response.status,
  recorded_at: entry.recorded_at,
  record: FETCH_RECORD_FILE_NAME,
});

const parseJson = (text: string): unknown => JSON.parse(text) as unknown;

/** The temporary-file shape `write` uses, so a crashed write can be swept rather than left forever. */
const TEMPORARY_SUFFIX = '.tmp';

/** Remove temporary files a crashed write left behind. A rename is atomic, so a leftover is debris. */
const sweepStaleTemporaries = (directory: string): void => {
  try {
    for (const name of readdirSync(directory)) {
      if (name.startsWith(`${FETCH_RECORD_FILE_NAME}.`) && name.endsWith(TEMPORARY_SUFFIX)) {
        unlinkSync(join(directory, name));
      }
    }
  } catch {
    // Debris that cannot be removed is harmless: the next write picks its own temporary name.
  }
};

/** Flush a file or directory entry to disk, ignoring a filesystem that refuses the request. */
const fsyncPath = (path: string): void => {
  let fd: number | null = null;
  try {
    fd = openSync(path, 'r');
    fsyncSync(fd);
  } catch {
    // Durability is best-effort here; atomicity comes from the rename and does not depend on it.
  } finally {
    if (fd !== null) closeSync(fd);
  }
};

/** Read the record through the AD-28 version gate and the AD-14 run-identity check. */
const readRecordFile = (path: string, expectedRun: string): FetchRecord => {
  const parsed = parseVersionedArtifact(
    FetchRecordSchema,
    parseJson(readFileSync(path, 'utf8')),
    FETCH_RECORD_FILE_NAME,
  );
  if (parsed.run !== expectedRun) {
    throw new ForeignFetchRecordError(path, expectedRun, parsed.run);
  }
  return parsed;
};

export class RunFetchRecord {
  readonly path: string;
  private readonly paths: RunPaths;
  private readonly redactor: Redactor;
  /** The live `Recorder`, when one was supplied; `null` for a standalone instance. */
  private readonly recorderRef: Recorder | null;
  private readonly step: string | null;
  private record: FetchRecord;
  /** Releases this instance's own dedicated lock. A no-op for a `Recorder`-backed instance. */
  private readonly releaseLock: () => void;

  private constructor(
    paths: RunPaths,
    redactor: Redactor,
    recorderRef: Recorder | null,
    step: string | null,
    record: FetchRecord,
    releaseLock: () => void,
  ) {
    this.paths = paths;
    this.redactor = redactor;
    this.recorderRef = recorderRef;
    this.step = step;
    this.record = record;
    this.path = paths.fetchRecord;
    this.releaseLock = releaseLock;
  }

  /**
   * Load the run's record, or start an empty one.
   *
   * An existing file is parsed through the AD-28 gate: an unrecognised `schema_version` is refused,
   * naming the installer version that wrote it, and never silently upgraded.
   *
   * Unchanged from before story 2-10: a caller that already holds the run's AD-29 `Recorder` shares
   * its redactor and appends `fetch.recorded` to `events.jsonl` live, exactly as it always has.
   */
  static open(options: RunFetchRecordOptions): RunFetchRecord {
    const { recorder } = options;
    mkdirSync(recorder.paths.runDir, { recursive: true });
    const path = recorder.paths.fetchRecord;
    const step = options.step ?? null;
    sweepStaleTemporaries(recorder.paths.runDir);

    const record = existsSync(path)
      ? readRecordFile(path, recorder.paths.runId)
      : emptyFetchRecord(recorder.paths.runId, CURRENT_SCHEMA_VERSION);
    return new RunFetchRecord(
      recorder.paths,
      recorder.redactor,
      recorder,
      step,
      record,
      // A Recorder-backed instance releases nothing of its own: the Recorder's lifecycle belongs to
      // whoever opened it.
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      (): void => {},
    );
  }

  /**
   * Open this run's fetch record with no live `Recorder` — the door a genuinely separate OS process
   * uses (story 2-10's Jira tool server) when the engine's reconciler already holds the run's AD-29
   * `events.jsonl` claim for the run's whole lifetime.
   *
   * Reads and writes `fetch-record.json` exactly as {@link open} does, under its own dedicated
   * exclusive lock rather than the AD-29 claim. **Never appends to `events.jsonl`**: that mirror is
   * the reconciler's to backfill, at a point in its own pass where it already holds its own live
   * `Recorder`. The record on disk is the durable, authoritative source of "was this served from
   * record", unconditionally and immediately; the event-log mirror is a convenience for a reader of
   * `events.jsonl` alone, and only that mirror is ever delayed.
   */
  static openStandalone(options: StandaloneRunFetchRecordOptions): RunFetchRecord {
    const paths = runPaths(options.runId, options.orchHome);
    mkdirSync(paths.runDir, { recursive: true });
    sweepStaleTemporaries(paths.runDir);

    const lockPath = `${paths.fetchRecord}${FETCH_RECORD_LOCK_SUFFIX}`;
    const claim: FetchRecordWriterClaim = {
      pid: process.pid,
      host: hostname(),
      run: paths.runId,
      since: formatTimestamp(),
    };
    const claimLine = `${JSON.stringify(claim)}\n`;

    if (!createFileExclusively(lockPath, claimLine)) {
      // Losing the create is the only thing that means another standalone writer holds this run's
      // fetch record. Every other failure throws out of the create rather than being read as a race.
      const existing = readFetchRecordClaim(lockPath);
      const reclaimable =
        (options.reclaimStaleLock ?? true) &&
        existing !== null &&
        existing.host === claim.host &&
        existing.pid !== process.pid &&
        !fetchRecordPidIsAlive(existing.pid);
      if (!reclaimable) {
        throw new FetchRecordWriterConflictError(
          paths.fetchRecord,
          existing,
          `${describeFetchRecordHolder(existing)}${
            existing !== null && fetchRecordPidIsAlive(existing.pid) ? ' and that process is alive' : ''
          }`,
        );
      }
      // AD-30's rule, applied to this lock: a stale claim is reclaimed only once the recorded pid is
      // verifiably gone.
      unlinkSync(lockPath);
      if (!createFileExclusively(lockPath, claimLine)) {
        throw new FetchRecordWriterConflictError(
          paths.fetchRecord,
          readFetchRecordClaim(lockPath),
          'the claim was taken while a stale lock was being reclaimed',
        );
      }
    }

    let released = false;
    const releaseLock = (): void => {
      if (released) return;
      released = true;
      try {
        // Only this instance's own claim is released: once another instance has reclaimed a stale
        // lock, the file describes *that* holder, and unlinking it would strip a live writer's claim.
        const held = readFetchRecordClaim(lockPath);
        if (held !== null && held.pid === claim.pid && held.host === claim.host) {
          unlinkSync(lockPath);
        }
      } catch {
        // A lock file that cannot be removed is reclaimed by the pid-liveness check on next open.
      }
    };

    const record = existsSync(paths.fetchRecord)
      ? readRecordFile(paths.fetchRecord, paths.runId)
      : emptyFetchRecord(paths.runId, CURRENT_SCHEMA_VERSION);
    return new RunFetchRecord(
      paths,
      createRedactor(options.redaction ?? {}),
      null,
      options.step ?? null,
      record,
      releaseLock,
    );
  }

  /**
   * Release this instance's own resources.
   *
   * For a standalone instance this releases the dedicated lock, so a later short-lived caller for the
   * same run is not refused by a claim this process no longer needs. For a `Recorder`-backed instance
   * this does nothing: the `Recorder`'s own lifecycle belongs to whoever opened it.
   */
  close(): void {
    this.releaseLock();
  }

  /** The contract id this artifact is registered under (AD-17). */
  static readonly contractId: string = FETCH_RECORD_CONTRACT_ID;

  /**
   * The key for a request, derived from the *redacted* request — the same one the record stores.
   *
   * Keying the raw request would make the stored key unre-derivable: a later reader holding an entry
   * could not compute its key from `entry.request` and so could not verify or rebuild the record.
   * A request whose parameters carry a credential is therefore keyed by its redacted form, which is
   * also the only form that ever reaches disk.
   */
  keyFor(request: FetchRequest): string {
    return fetchRequestKey(this.redactRequest(request));
  }

  /** What the record holds for a request, or null when the domain has not been contacted for it. */
  lookup(request: FetchRequest): FetchRecordEntry | null {
    return findFetchRecordEntry(this.record, this.keyFor(request));
  }

  /**
   * The request as it will be stored and keyed. A request that cannot be redacted is dropped, not
   * looked up: AD-21 has no partial outcome, and a key over a value that may not be written is not
   * a key at all.
   */
  private redactRequest(request: FetchRequest): FetchRequest {
    const redacted = this.redactor.redact(request);
    if (!redacted.ok) {
      this.reportRedactionFailure(redacted);
      throw new RedactionFailedError(redacted);
    }
    return redacted.value;
  }

  /**
   * Tell the run's log a redaction failed, when there is a live `Recorder` to tell it through.
   *
   * A standalone instance has no `events.jsonl` claim and so cannot append `redaction.failed` either
   * — the caller still learns of the failure by exception (`RedactionFailedError`), which is the part
   * AD-21's fail-closed rule actually requires; only the *event-log record* of it is unavailable here,
   * on the same short delay every other fact this path defers to the reconciler is.
   */
  private reportRedactionFailure(failure: RedactionFailure): void {
    this.recorderRef?.recordRedactionFailure(failure, {
      step: this.step,
      droppedType: 'fetch.recorded',
    });
  }

  /** Every recorded read of this run, in the order the domain was contacted. */
  get entries(): readonly FetchRecordEntry[] {
    return this.record.entries;
  }

  /**
   * Serve a request: from the record when it is already recorded, otherwise by performing the read
   * and recording it.
   *
   * `perform` is not called for a request already in the record — that is the AD-14 guarantee, and
   * the reason this method exists rather than a bare `record`.
   */
  async serve(
    request: FetchRequest,
    perform: () => Promise<FetchResponse> | FetchResponse,
  ): Promise<ServedFetch> {
    const recorded = this.lookup(request);
    if (recorded !== null) {
      this.emitRecorded(recorded, 'record');
      return { entry: recorded, response: recorded.response, source: 'record' };
    }
    let response: FetchResponse;
    try {
      response = await perform();
    } catch (thrown: unknown) {
      // AD-13 records *every* external read, and a read that failed is a read: the failure is
      // recorded as an `ok: false` value and emitted, then handed back to the caller unchanged.
      this.put(request, {
        ok: false,
        status: null,
        body: { error: renderCause(thrown) },
      });
      throw thrown;
    }
    const entry = this.put(request, response);
    return { entry, response: entry.response, source: 'domain' };
  }

  /**
   * Record a request and its response, through redaction.
   *
   * On a redaction failure nothing is written to the record, a `redaction.failed` event is appended
   * in the artifact's place, and the caller is told by exception: AD-21 has no partial outcome. A key
   * already present keeps its first value — within one run an external record has exactly one value.
   */
  put(request: FetchRequest, response: FetchResponse): FetchRecordEntry {
    const redactedRequest = this.redactRequest(request);
    const key = fetchRequestKey(redactedRequest);
    const existing = findFetchRecordEntry(this.record, key);
    if (existing !== null) {
      this.emitRecorded(existing, 'record');
      return existing;
    }

    const redacted = this.redactor.redact(response);
    if (!redacted.ok) {
      this.reportRedactionFailure(redacted);
      throw new RedactionFailedError(redacted);
    }

    const entry: FetchRecordEntry = {
      key,
      request: redactedRequest,
      response: redacted.value,
      recorded_at: formatTimestamp(),
      recorded_by_step: this.step,
    };

    // Re-read immediately before writing, so a second live instance's entries are not clobbered by
    // this one's snapshot. The first recorded value for a key still wins — AD-14 gives one run one
    // value per record, whichever instance got there first.
    this.record = this.reload();
    const already = findFetchRecordEntry(this.record, key);
    if (already !== null) {
      this.emitRecorded(already, 'record');
      return already;
    }

    const next: FetchRecord = {
      ...this.record,
      entries: [...this.record.entries, entry],
    };
    // Parse before writing: the artifact on disk is always one this build would accept reading.
    this.record = FetchRecordSchema.parse(next);
    this.write();
    this.emitRecorded(entry, 'domain');
    return entry;
  }

  /**
   * AD-4 — the event log carries the same read the record does, when there is a live `Recorder` to
   * carry it through. The payload names the key and the request as redacted, never the response body:
   * the body is evidence plane (AD-23) and lives in the record, referenced from the log by key.
   *
   * A standalone instance has no claim over `events.jsonl` and does not attempt this append at all —
   * the reconciler backfills it once it next holds its own live `Recorder` for the run. The record on
   * disk (below) is written either way: that is the durable, authoritative source of "was this served
   * from record", and only the event-log mirror is ever delayed.
   */
  private emitRecorded(entry: FetchRecordEntry, source: FetchSource): void {
    if (this.recorderRef === null) return;
    this.recorderRef.record({
      feature: this.recorderRef.feature,
      run: this.paths.runId,
      step: this.step,
      emitter: FETCH_RECORD_EMITTER,
      type: FETCH_RECORDED_EVENT_TYPE,
      payload: fetchRecordedEventPayload(entry, source),
    });
  }

  /** What the file holds right now, or an empty record when there is no file yet. */
  private reload(): FetchRecord {
    if (!existsSync(this.path)) {
      return emptyFetchRecord(this.paths.runId, CURRENT_SCHEMA_VERSION);
    }
    return readRecordFile(this.path, this.paths.runId);
  }

  /**
   * Atomic and durable: a temporary file in the same directory, fsynced, then renamed, then the
   * directory itself fsynced so the rename survives a crash. The event log fsyncs each append for
   * the same reason; a record that is atomic but not durable can still vanish after a power loss.
   */
  private write(): void {
    const directory = this.paths.runDir;
    const temporary = join(directory, `${FETCH_RECORD_FILE_NAME}.${String(process.pid)}.tmp`);
    try {
      writeFileSync(temporary, `${JSON.stringify(this.record, null, 2)}\n`, 'utf8');
      fsyncPath(temporary);
      renameSync(temporary, this.path);
      fsyncPath(directory);
    } catch (thrown: unknown) {
      if (existsSync(temporary)) {
        try {
          unlinkSync(temporary);
        } catch {
          // The temporary file is in the run directory and is overwritten by the next attempt.
        }
      }
      throw thrown;
    }
  }
}
