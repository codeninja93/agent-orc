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
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

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
import { DEFAULT_HIGH_ENTROPY_MIN_LENGTH } from './redaction.js';
import type { RedactionPolicy } from './redaction.js';

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
 * The longest unbroken alphanumeric run an intent id may contain under the default policy.
 *
 * AD-21's high-entropy rule considers runs of `[A-Za-z0-9+/=]` and redacts one that is at least
 * {@link DEFAULT_HIGH_ENTROPY_MIN_LENGTH} characters and carries enough entropy per character. An id
 * whose runs all stay *under* that length cannot be reached by the rule at all, whatever its entropy —
 * so the guard is on *shape*, which is checkable here, rather than on entropy, which depends on a
 * policy this module does not own.
 *
 * Derived from the redaction module's own threshold rather than written out as `23`, because the two
 * numbers have to move together: an id declared loggable against a stale threshold is an id whose
 * exactly-once key is silently replaced by the marker in the one payload that carries it.
 */
export const MAX_INTENT_ID_TOKEN_RUN = DEFAULT_HIGH_ENTROPY_MIN_LENGTH - 1;

/**
 * The shape an intent id must take: safe in a file name, and short enough runs to survive the log.
 *
 * `.` is deliberately **not** admitted. The file an intent is written to embeds its id, and the
 * reader's own quarantine sidecars end `.refusal.json` — so an id ending `.refusal` would produce a
 * file the reader filtered out of its own listing: never read, never refused, never reported, and
 * therefore a disengage that vanished. A dot buys an id nothing, and the two hyphenated separators
 * {@link mintIntentId} produces are already enough to break a token run.
 */
export const INTENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

const LONGEST_TOKEN_RUN = /[A-Za-z0-9+/=]+/g;

/**
 * True when this id can be written to a payload and read back unchanged.
 *
 * Two conditions, and the second is the one that matters: the id is a safe file-name segment, and no
 * unbroken token run in it reaches the length AD-21's entropy sweep considers. A ULID fails the second
 * — 26 unbroken characters at 4.1 bits each is exactly what that sweep exists to catch — which is why
 * {@link mintIntentId} punctuates.
 *
 * The threshold is read from the *active* policy when one is given. A build that lowered
 * `highEntropyMinLength` would otherwise keep accepting ids this function called loggable while the
 * recorder replaced them, and the exactly-once ledger would quietly hold the redaction marker instead
 * of a key.
 */
export const isLoggableIntentId = (id: string, policy: RedactionPolicy = {}): boolean => {
  if (!INTENT_ID_PATTERN.test(id)) return false;
  const longestAllowed = (policy.highEntropyMinLength ?? DEFAULT_HIGH_ENTROPY_MIN_LENGTH) - 1;
  for (const run of id.match(LONGEST_TOKEN_RUN) ?? []) {
    if (run.length > longestAllowed) return false;
  }
  return true;
};

/** The prefix every minted intent id carries, so a file in `commands/` is recognisable at a glance. */
export const INTENT_ID_PREFIX = 'cmd';

/**
 * The shape a seed must have before an intent id is built from it.
 *
 * Two callers and two encodings: the engine's AD-29 ULID minter produces 26 characters of Crockford
 * base32, and {@link mintRandomIntentId} produces 32 hex characters from `randomUUID`, because AD-29
 * keeps the ULID minter in the engine and this module may not import it. Both are upper-case
 * alphanumerics of at least 26 characters, which is what this admits — the length floor is the
 * *uniqueness* floor, and it is the thing that actually matters here.
 *
 * Without it, `mintIntentId('')` returned the literal `"cmd-"`, which passes
 * {@link isLoggableIntentId}: two such intents share the exactly-once key the whole at-least-once
 * argument rests on, and the second is silently dropped as already applied. So a caller's degenerate
 * seed is refused at the mint rather than at the ledger, where the symptom is a command that vanished.
 */
export const INTENT_SEED_PATTERN = /^[0-9A-Z]{26,64}$/;

/** A seed with too little in it to be an exactly-once key. Refused rather than punctuated. */
export class UnusableIntentSeed extends Error {
  readonly code = 'internal.invariant_violated';
  readonly seed: string;

  constructor(seed: string) {
    super(
      `Refusing to mint an intent id from "${seed}": a seed must match ` +
        `${String(INTENT_SEED_PATTERN)} — the 26 Crockford base32 characters of a ULID, or the 32 hex ` +
        'characters of a UUID. The minted id is the exactly-once key for a command, so a seed that ' +
        'carries no uniqueness produces two intents that share one key and the second is dropped as ' +
        'already applied (AD-19).',
    );
    this.name = 'UnusableIntentSeed';
    this.seed = seed;
  }
}

/**
 * Mint an intent id from a ULID, punctuated into groups.
 *
 * The groups are what make it loggable: the same 26 characters unbroken would be redacted out of the
 * payload that carries the exactly-once key, and the key would then be lost precisely when the log is
 * the only thing that remembers it. Uniqueness and ordering come from the ULID underneath.
 *
 * Both ends are checked. The seed has to be able to carry uniqueness ({@link INTENT_SEED_PATTERN}), and
 * the id this produces has to survive the log ({@link isLoggableIntentId}) — asserted rather than
 * assumed, because the punctuation that makes it survive is computed here and a change to the grouping
 * would otherwise fail silently, in the one payload nothing else can reconstruct.
 */
export const mintIntentId = (ulid: string, policy: RedactionPolicy = {}): string => {
  if (!INTENT_SEED_PATTERN.test(ulid)) throw new UnusableIntentSeed(ulid);
  const groups = (ulid.match(/.{1,8}/g) ?? [ulid]).join('-');
  const id = `${INTENT_ID_PREFIX}-${groups}`;
  if (!isLoggableIntentId(id, policy)) throw new UnloggableIntentId(id);
  return id;
};

/**
 * How many characters the time prefix of a minted seed takes.
 *
 * Base-36, upper case, zero-padded: ten characters hold every millisecond up to the year 5138, and a
 * fixed width is what makes a plain string comparison order two seeds by the instant they were minted.
 */
const SEED_TIME_CHARS = 10;

/** How many characters the within-process counter takes. Fixed width, for the same reason. */
const SEED_COUNTER_CHARS = 8;

/**
 * The count of ids this process has minted, so two minted in the same millisecond still sort in order.
 *
 * A process-local counter rather than more randomness: the tiebreak `orderIntents` applies after
 * `issued_at` is the id itself, and `issued_at` is a millisecond timestamp — so two intents issued
 * inside one millisecond are ordered by their ids alone. With a random tiebreak that order is a coin
 * toss rather than the order the person pressed the keys, which is the one order a steering surface
 * may not get wrong.
 */
let mintedSoFar = 0;

/** A number as fixed-width upper-case base 36, so lexicographic order is numeric order. */
const paddedBase36 = (value: number, width: number): string =>
  Math.trunc(value).toString(36).toUpperCase().padStart(width, '0').slice(-width);

/**
 * An intent id for a caller that has no ULID minter, which is every renderer.
 *
 * AD-29 gives the engine sole ownership of *run* id minting, and that is the rule this respects by
 * not reaching for it: a run id is the engine's to mint, an intent id is the writer's, and the ULID
 * minter lives in the engine where AD-29 put it. So the randomness comes from `node:crypto` and the
 * grouping is {@link mintIntentId}'s, which is what keeps the id loggable.
 *
 * **The seed is chronological, and that is load-bearing rather than cosmetic.** `orderIntents` sorts a
 * pass's intents by `issued_at` and breaks a tie on the intent id, and `issued_at` has millisecond
 * resolution — so for two commands issued in the same millisecond the id *is* the order they are
 * applied in. A seed that was random throughout ordered those two by a coin toss; this one is a
 * fixed-width millisecond timestamp, then a fixed-width count of what this process has already minted,
 * then the UUID that carries the uniqueness. Lexicographic order over equal-length seeds is therefore
 * issue order within a process, and the UUID still makes the id unique across processes and restarts —
 * which is what the exactly-once key of AD-19 actually needs.
 */
export const mintRandomIntentId = (
  uuid: () => string = randomUUID,
  now: () => number = Date.now,
): string => {
  mintedSoFar += 1;
  const seed =
    paddedBase36(now(), SEED_TIME_CHARS) +
    paddedBase36(mintedSoFar, SEED_COUNTER_CHARS) +
    uuid().replace(/-/g, '').toUpperCase();
  return mintIntentId(seed);
};

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
  fsyncDirectory(paths.commandsDir);
  return target;
};

/**
 * Make a rename in this directory durable.
 *
 * The file's own `fsync` makes its *contents* survive; only the directory's makes the *name* survive.
 * A crash after the rename and before the directory's metadata reached the platter loses the intent
 * entirely — which is precisely the disengage that at-least-once delivery exists never to lose, and the
 * reason this is not treated as an optional nicety the way the contents' sync is. It still cannot be
 * fatal: some platforms refuse to open a directory for reading at all, and a refusal there does not make
 * the rename any less atomic.
 */
export const fsyncDirectory = (directory: string): void => {
  let dir: number;
  try {
    dir = openSync(directory, 'r');
  } catch {
    return;
  }
  try {
    fsyncSync(dir);
  } catch {
    // Unsupported on this platform or filesystem; the rename has still replaced the name.
  }
  // Closed on both paths without a `finally`, for the same AD-32 reason as the write above.
  closeSync(dir);
};

/**
 * Remove intent temporaries a writer died between writing and renaming.
 *
 * A rename either happened or did not, so a surviving `<name>.<pid>.tmp` is always debris and never a
 * command a reader should see. The reader already skips these names, so they are not a poison file —
 * they are an unbounded leak, in the one directory a renderer writes to on every keystroke, and the
 * counterpart of `sweepCheckpointTemporaries` for the same reason: a directory that only ever grows is
 * a slower version of the same fault.
 *
 * Only this shape is touched, and only a name that also matches the intent extension: nothing else in
 * `commands/` is this sweep's to delete.
 *
 * And only a temporary older than {@link ABANDONED_TEMPORARY_GRACE_MS}. The engine is not the only
 * writer here — every renderer writes into this directory — so a sweep that deleted on sight would race
 * a live writer between its `write` and its `rename` and destroy the very intent it was writing. Age is
 * the same discriminator the reader uses for a torn file, and for the same reason: a writer mid-write
 * and a writer that died mid-write differ only by time.
 */
export const sweepCommandTemporaries = (
  paths: RunPaths,
  options: { readonly now?: () => Date; readonly graceMs?: number } = {},
): number => {
  const now = (options.now ?? ((): Date => new Date()))().getTime();
  const grace = options.graceMs ?? ABANDONED_TEMPORARY_GRACE_MS;

  let names: string[];
  try {
    names = readdirSync(paths.commandsDir);
  } catch {
    // No commands directory is the ordinary case: a run nobody has steered.
    return 0;
  }
  let removed = 0;
  for (const name of names) {
    if (!name.endsWith(INTENT_TEMP_SUFFIX) || !name.includes(INTENT_FILE_EXTENSION)) continue;
    const path = join(paths.commandsDir, name);
    let age: number;
    try {
      age = now - statSync(path).mtimeMs;
    } catch {
      continue;
    }
    /**
     * Sub-millisecond jitter counts as "just written"; a real skew does not.
     *
     * A filesystem records mtime below the millisecond while `Date.now()` truncates, so a file written
     * microseconds ago legitimately reads as a fraction of a millisecond in the future — that is the live
     * writer this sweep must not touch. A mtime a second or more ahead is a clock that disagrees, and no
     * amount of waiting resolves it, so it is treated as age.
     */
    const jitter = age < 0 && age > -CLOCK_SKEW_TOLERANCE_MS ? 0 : age;
    if (jitter >= 0 && jitter < grace) continue;
    try {
      unlinkSync(path);
      removed += 1;
    } catch {
      // Another writer's live temporary, or a permission fault. Neither is this sweep's business.
    }
  }
  return removed;
};

/**
 * How long a temporary intent file is left alone before it is treated as a dead writer's debris.
 *
 * Generous on purpose. The cost of waiting too long is one stale file in a directory; the cost of
 * sweeping too soon is deleting a live renderer's half-written disengage.
 */
export const ABANDONED_TEMPORARY_GRACE_MS = 60_000;

/**
 * How far ahead of this clock a modification time may sit before it is read as skew rather than as youth.
 *
 * Declared here as well as in the engine's reader because both units face the same filesystem and the same
 * truncation, and `src/runtime/` may not import `src/engine/`. One number, two places that cannot import
 * each other — so it is named identically and documented identically rather than passed between them.
 */
export const CLOCK_SKEW_TOLERANCE_MS = 1_000;

/** What {@link writeFileIfChanged} did: a new file, a rewritten one, or bytes already exactly these. */
export type WriteDisposition = 'created' | 'updated' | 'unchanged';

/**
 * Write one file atomically, or leave it alone because it already holds exactly these bytes.
 *
 * Moved here (story 5-2) from `src/installer/write.ts`, where story 2-1 put it when the installer was
 * its only caller. `src/engine/knowledge-sweep.ts` is the second caller — the sweep rewrites
 * `profile.toml` with the same skip-if-unchanged idiom the installer already uses for that file — and
 * the spine's dependency rule lets the engine import `src/runtime/` but never `src/installer/`, which is
 * the same reason `src/contracts/toml.ts` holds the TOML codec rather than `src/installer/toml.ts`
 * holding it alone. `src/installer/write.ts` re-exports this, so no existing caller changed.
 *
 * Reading before writing is not an optimisation. It is the difference between "the installer is
 * idempotent" and "the installer rewrites the same bytes and calls that idempotent": only the skip
 * leaves a re-run's tree indistinguishable from the first run's.
 */
export const writeFileIfChanged = (absolute: string, contents: string): WriteDisposition => {
  const exists = existsSync(absolute);
  if (exists && readFileSync(absolute, 'utf8') === contents) return 'unchanged';

  const directory = dirname(absolute);
  // The temporary lives beside its target, because `rename` cannot cross a filesystem boundary and
  // a temporary elsewhere would fail with EXDEV on exactly the machines that separate them.
  const temp = `${absolute}.${String(process.pid)}.tmp`;
  writeFileSync(temp, contents, { encoding: 'utf8', mode: 0o644 });
  const fd = openSync(temp, 'r');
  try {
    fsyncSync(fd);
  } catch {
    // Unsynced contents are a durability weakness, not a torn file: the rename is still atomic.
  }
  // Closed on both paths without a `finally`, matching this module's own idiom above.
  closeSync(fd);
  renameSync(temp, absolute);
  // Only now is the *name* durable; the file's own fsync makes only its contents so.
  fsyncDirectory(directory);
  return exists ? 'updated' : 'created';
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
