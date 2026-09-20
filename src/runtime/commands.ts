/**
 * AD-19 — the *mechanics* of a durable command intent file: its format, its atomic write and its id
 * minting.
 *
 * This module exists to settle a contradiction, and the contradiction is worth stating because the
 * shape of the module follows from it. The spine's dependency rule is absolute: "No renderer, step
 * subprocess, tool server or installer may import the engine; renderers reach it only by writing
 * command intent files per AD-19." Story 1-7 nevertheless put `writeCommandIntent`,
 * `newCommandIntent` and `mintIntentId` in `src/engine/commands.ts` and recorded that a renderer
 * "needs only" those three. Both cannot hold: a renderer that needs those three from the engine is a
 * renderer that imports the engine.
 *
 * The resolution keeps the rule intact and moves the code. Writing a durable file atomically is what
 * `src/runtime/` already owns — the recorder, the AD-9 paths, the fetch record — so the intent file's
 * mechanics live here, beside the paths that name where they go, and `src/engine/commands.ts`
 * re-exports every name so no existing caller changes. What stays in the engine is what the engine
 * actually does with these files: enumerating a pass, parsing, refusing, ordering, quarantining,
 * retiring and applying. A renderer needs none of that, and now imports none of it.
 *
 * Nothing here decides an effect, reads a directory or touches the event log. The two guarantees it
 * does carry are the ones a writer cannot get wrong twice:
 *
 * - **The file appears whole or not at all.** A reader arrives unannounced — the reconciler polls
 *   `commands/` while a step is in flight — so the write is a temporary file in the same directory,
 *   then a rename.
 * - **An intent id must survive the log.** The exactly-once key travels in an event *payload*, where
 *   AD-21's entropy sweep replaces any unbroken alphanumeric run long enough to look like a secret. An
 *   id that would be redacted is refused at the door rather than silently losing the key that makes
 *   redelivery safe, and {@link mintIntentId} punctuates so a minted id cannot be reached by that
 *   sweep at all.
 */
import { randomUUID } from 'node:crypto';
import { closeSync, fsyncSync, mkdirSync, openSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  CURRENT_SCHEMA_VERSION,
  CommandIntentSchema,
  formatTimestamp,
} from '../contracts/index.js';
import type {
  Command,
  CommandIntent,
  CommandSource,
  Principal,
} from '../contracts/index.js';

import type { RunPaths } from './paths.js';

/** The extension every intent file carries. A file with another extension is not an intent. */
export const INTENT_FILE_EXTENSION = '.json';

/**
 * The suffix of a partly-written intent file, so an atomic write's debris is recognisable.
 *
 * Exported because the writer and the reader must agree on it: the engine's pass skips a file
 * carrying this suffix rather than reading a rename that has not happened yet, and two spellings of
 * the suffix would be two agreements.
 */
export const INTENT_TEMP_SUFFIX = '.tmp';

/**
 * The longest unbroken alphanumeric run an intent id may contain.
 *
 * AD-21's high-entropy rule considers runs of `[A-Za-z0-9+/=]` and redacts one that is at least 24
 * characters and carries enough entropy per character. An id whose runs all stay under that length
 * cannot be reached by the rule at all, whatever its entropy — so the guard is on *shape*, which is
 * checkable here, rather than on entropy, which depends on a policy this module does not own.
 */
export const MAX_INTENT_ID_TOKEN_RUN = 23;

/** The shape an intent id must take: safe in a file name, and short enough runs to survive the log. */
export const INTENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

const LONGEST_TOKEN_RUN = /[A-Za-z0-9+/=]+/g;

/**
 * True when this id can be written to a payload and read back unchanged.
 *
 * Two conditions, and the second is the one that matters: the id is a safe file-name segment, and no
 * unbroken token run in it reaches the length AD-21's entropy sweep considers. A ULID fails the second
 * — 26 unbroken characters at 4.1 bits each is exactly what that sweep exists to catch — which is why
 * {@link mintIntentId} punctuates.
 */
export const isLoggableIntentId = (id: string): boolean => {
  if (!INTENT_ID_PATTERN.test(id)) return false;
  for (const run of id.match(LONGEST_TOKEN_RUN) ?? []) {
    if (run.length > MAX_INTENT_ID_TOKEN_RUN) return false;
  }
  return true;
};

/** The prefix every minted intent id carries, so a file in `commands/` is recognisable at a glance. */
export const INTENT_ID_PREFIX = 'cmd';

/**
 * Mint an intent id from a ULID, punctuated into groups.
 *
 * The groups are what make it loggable: the same 26 characters unbroken would be redacted out of the
 * payload that carries the exactly-once key, and the key would then be lost precisely when the log is
 * the only thing that remembers it. Uniqueness and ordering come from the ULID underneath.
 */
export const mintIntentId = (ulid: string): string => {
  const groups = (ulid.match(/.{1,8}/g) ?? [ulid]).join('-');
  return `${INTENT_ID_PREFIX}-${groups}`;
};

/**
 * An intent id for a caller that has no ULID minter, which is every renderer.
 *
 * AD-29 gives the engine sole ownership of *run* id minting, and that is the rule this respects by
 * not reaching for it: a run id is the engine's to mint, an intent id is the writer's, and the ULID
 * minter lives in the engine where AD-29 put it. So the randomness comes from `node:crypto` and the
 * grouping is {@link mintIntentId}'s, which is what keeps the id loggable.
 *
 * Ordering is not lost by using randomness rather than a ULID: an intent file is ordered by the
 * `issued_at` it carries first and by its id only as a tiebreak, so two intents issued in the same
 * millisecond are ordered deterministically without the id itself being chronological.
 */
export const mintRandomIntentId = (uuid: () => string = randomUUID): string =>
  mintIntentId(uuid().replace(/-/g, '').toUpperCase());

/** What a caller supplies to build an intent; everything else is filled in here. */
export interface NewCommandIntent {
  readonly intentId: string;
  readonly command: Command;
  readonly run: string;
  readonly feature: string;
  /** The step the command targets, or `null` for a run-level command. */
  readonly step?: string | null;
  /** AD-19 — every command records its principal, so an approval is attributable. */
  readonly principal: Principal;
  readonly source: CommandSource;
  /** Free text; the system parses. Never impose a format on the human (Q6). */
  readonly argument?: string | null;
  readonly issuedAt?: Date;
}

/** Build a durable intent, validated against the registered `command.intent` contract. */
export const newCommandIntent = (declared: NewCommandIntent): CommandIntent =>
  CommandIntentSchema.parse({
    schema_version: CURRENT_SCHEMA_VERSION,
    intent_id: declared.intentId,
    command: declared.command,
    run: declared.run,
    feature: declared.feature,
    step: declared.step ?? null,
    principal: declared.principal,
    source: declared.source,
    issued_at: formatTimestamp(declared.issuedAt ?? new Date()),
    argument: declared.argument ?? null,
  });

/**
 * The file name an intent is written under: its issue time, then its id.
 *
 * Time first so a directory listing reads chronologically for a person, and the id second so two
 * intents issued in the same millisecond cannot collide. The name is never *parsed* back — ordering
 * reads the file's own fields — so a renamed file is still a valid intent.
 */
export const intentFileName = (intent: CommandIntent): string =>
  `${intent.issued_at.replace(/[:.]/g, '-')}__${intent.intent_id}${INTENT_FILE_EXTENSION}`;

/** An intent id this build cannot carry into the log, refused rather than written. */
export class UnloggableIntentId extends Error {
  readonly code = 'config.invalid';
  readonly intentId: string;

  constructor(intentId: string) {
    super(
      `Refusing to write an intent whose id is "${intentId}": an intent id must match ` +
        `${String(INTENT_ID_PATTERN)} and contain no unbroken run of more than ` +
        `${String(MAX_INTENT_ID_TOKEN_RUN)} alphanumeric characters, so it survives the AD-21 ` +
        'redaction pass in the event payload that carries it. That payload is the only record of ' +
        'which intents have been applied, so an id that cannot be logged cannot be made exactly-once.',
    );
    this.name = 'UnloggableIntentId';
    this.intentId = intentId;
  }
}

/**
 * Write an intent atomically: a temporary file in the same directory, fsync, then rename.
 *
 * Atomic because a reader arrives unannounced — the reconciler polls this directory while a step is in
 * flight — and a half-written file it read as whole would be a command nobody issued. The rename makes
 * the file appear complete or not appear at all; the grace period in the engine's `readIntentFiles`
 * covers a writer that is *not* this one.
 */
export const writeCommandIntent = (paths: RunPaths, intent: CommandIntent): string => {
  const validated = CommandIntentSchema.parse(intent);
  if (!isLoggableIntentId(validated.intent_id)) throw new UnloggableIntentId(validated.intent_id);
  if (validated.run !== paths.runId) {
    throw new Error(
      `Refusing to write intent ${validated.intent_id} into run ${paths.runId}'s commands ` +
        `directory: it names run "${validated.run}". An intent lives in the directory of the run it ` +
        'steers, so a misfiled command is never applied to the wrong feature.',
    );
  }

  mkdirSync(paths.commandsDir, { recursive: true });
  const target = join(paths.commandsDir, intentFileName(validated));
  const temp = `${target}.${String(process.pid)}${INTENT_TEMP_SUFFIX}`;

  writeFileSync(temp, `${JSON.stringify(validated, null, 2)}\n`, 'utf8');
  const fd = openSync(temp, 'r');
  try {
    fsyncSync(fd);
  } catch {
    // Unsynced contents are a durability weakness, not a torn file: the rename is still atomic.
  }
  // Closed on both paths without a `finally`: nothing here may read as cleanup on an exit path (AD-32).
  closeSync(fd);
  renameSync(temp, target);
  return target;
};

/**
 * A single non-atomic write of an intent, used by nothing in production.
 *
 * Exported so a suite can *demonstrate* the torn file it asserts against, beside the real writer, for
 * the same reason `writeCheckpointNonAtomically` is: a torn-file test that built its own writer would
 * drift away from the file shape the transport actually meets.
 */
export const writeCommandIntentTruncated = (
  paths: RunPaths,
  intent: CommandIntent,
  keepChars: number,
): string => {
  mkdirSync(paths.commandsDir, { recursive: true });
  const target = join(paths.commandsDir, intentFileName(intent));
  writeFileSync(target, JSON.stringify(intent, null, 2).slice(0, keepChars), 'utf8');
  return target;
};
