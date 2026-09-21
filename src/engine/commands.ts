/**
 * AD-19 — command transport is durable intent files.
 *
 * Every steering command is a file under `runs/<run-id>/commands/`, and that file is the only thing
 * the reconciler consumes. There is no socket, no queue and no second path: story 3-1's loopback
 * server writes these same files, so with the server down every control still works.
 *
 * This module owns the *file*: writing one atomically, enumerating what a pass found, parsing it
 * against the contract, refusing what it cannot understand, and putting the pass's intents in a
 * deterministic order. It decides no effects at all — `steering.ts` does that — because the two
 * failure modes are different: a file this module misreads is a transport bug, and an effect
 * `steering.ts` misapplies is a steering bug, and keeping them apart is what lets each be tested
 * without the other.
 *
 * Four rules shape it, and each is load-bearing:
 *
 * **Delivery is at-least-once; the effect is exactly-once.** Nothing here deletes a file it has read.
 * An intent is moved aside only once its effect is durable ({@link retireIntent}), so a crash in the
 * wrong millisecond redelivers rather than loses — losing a disengage the user already pressed is
 * strictly worse than delivering one twice. What makes that safe is the `intent_id` the effect carries
 * into the log, which `steering.ts` and the fold key on.
 *
 * **A file the loop cannot understand is quarantined, never retried for ever.** A partial JSON write
 * is given a grace period, because a writer may still be finishing it — and *after* that grace it is
 * treated as abandoned and moved out of the way. Anything structurally undeliverable — a command
 * outside the enum, a missing principal, an intent addressed to another run — is quarantined on sight.
 * Neither case becomes a poison file the next pass meets again.
 *
 * **An intent id must survive the log.** The exactly-once key travels in an event *payload*, where
 * AD-21's entropy sweep replaces any unbroken alphanumeric run long enough to look like a secret. An
 * id that would be redacted is therefore refused at the door rather than silently losing the key that
 * makes redelivery safe — and {@link mintIntentId} produces a punctuated id that cannot be reached by
 * that sweep.
 *
 * **Two intents arriving together are ordered by what is on disk, not by what `readdir` returned.**
 * A restart has to reach the same state, and directory order is not a promise any filesystem makes.
 */
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

import {
  COMMANDS,
  CommandIntentSchema,
  CURRENT_SCHEMA_VERSION,
  formatTimestamp,
} from '../contracts/index.js';
import type { Command, CommandIntent, EventEnvelope } from '../contracts/index.js';
import {
  INTENT_FILE_EXTENSION,
  INTENT_ID_PATTERN,
  INTENT_TEMP_SUFFIX,
  MAX_INTENT_ID_TOKEN_RUN,
  fsyncDirectory,
  isLoggableIntentId,
} from '../runtime/commands.js';
import { isStopCommand } from '../runtime/steering-view.js';
import type { RunPaths } from '../runtime/index.js';

/**
 * The two event types the transport writes, declared here rather than in the engine's general
 * vocabulary because the fold's handling of them *is* the exactly-once mechanism.
 *
 * `command.applied` is the ledger entry **and** the effect in one line. That is not a stylistic
 * choice: a ledger written before the effect could lose the effect to a crash in between, and one
 * written after could apply it twice. One append does both, so the two cannot come apart.
 */
export const COMMAND_EVENT_TYPES = {
  /** An intent's effect, carrying the `intent_id` the fold keys exactly-once on. */
  Applied: 'command.applied',
  /** An intent the loop refused, recorded so a refusal is visible rather than merely silent. */
  Refused: 'command.refused',
} as const;

export type CommandEventType = (typeof COMMAND_EVENT_TYPES)[keyof typeof COMMAND_EVENT_TYPES];

/**
 * The intent file's *mechanics* now live in `src/runtime/commands.ts`, and are re-exported here.
 *
 * The move settles a contradiction story 1-9 inherited. The spine's dependency rule is absolute — "No
 * renderer, step subprocess, tool server or installer may import the engine; renderers reach it only by
 * writing command intent files per AD-19" — while this module was where a renderer's three functions
 * lived. A renderer needing `writeCommandIntent`, `newCommandIntent` and `mintIntentId` *from the
 * engine* is a renderer importing the engine, so one of the two had to give, and it was not going to be
 * the rule.
 *
 * What moved is the format, the atomic write and the id minting: durable-file mechanics, which
 * `src/runtime/` already owns for the log, the paths and the fetch record. What stayed is everything the
 * engine does *with* those files — enumerate, parse, refuse, order, quarantine, retire, apply — because
 * none of it is a renderer's concern. Every moved name is re-exported below, so no caller of this module
 * changed.
 */
export {
  INTENT_ID_PREFIX,
  UnloggableIntentId,
  intentFileName,
  mintIntentId,
  mintRandomIntentId,
  newCommandIntent,
  writeCommandIntent,
  writeCommandIntentTruncated,
} from '../runtime/commands.js';
export {
  INTENT_FILE_EXTENSION,
  INTENT_ID_PATTERN,
  INTENT_TEMP_SUFFIX,
  MAX_INTENT_ID_TOKEN_RUN,
  isLoggableIntentId,
};
export {
  ABANDONED_TEMPORARY_GRACE_MS,
  INTENT_SEED_PATTERN,
  UnusableIntentSeed,
  sweepCommandTemporaries,
} from '../runtime/commands.js';
export type { NewCommandIntent } from '../runtime/commands.js';

/** The suffix of the sidecar written beside a quarantined intent, naming why it was refused. */
export const REFUSAL_SIDECAR_EXTENSION = '.refusal.json';

/**
 * How long a file that is not whole JSON is left alone before it is treated as abandoned.
 *
 * The matrix asks for two things that pull in opposite directions: a torn file is "not treated as
 * consumed", and no file becomes "a poison file that is retried forever". A writer mid-`write` is
 * indistinguishable from a writer that died mid-`write`, so the only honest discriminator is time.
 * Inside the grace the file is left for its writer to finish; outside it, nothing is coming.
 */
export const TORN_INTENT_GRACE_MS = 5_000;

/**
 * How far into the future a file's modification time may sit before it is read as a skewed clock.
 *
 * A *tiny* negative age is ordinary and means nothing: a filesystem records mtime with sub-millisecond
 * precision while `Date.now()` truncates to the millisecond, so a file written microseconds ago
 * legitimately reads as a fraction of a millisecond "in the future". A second is orders of magnitude
 * above that jitter and orders of magnitude below a skew worth acting on, so it is the line between "just
 * written" and "written by a machine whose clock disagrees with this one".
 *
 * Beyond it, the mtime is not a time this process can wait out: a grace measured against a clock an hour
 * ahead expires in an hour, during which the torn file is met by every pass and every 25ms poll.
 */
export const CLOCK_SKEW_TOLERANCE_MS = 1_000;

/** Why an intent file was refused. Every reason is a constant, so a refusal is never free text. */
export const INTENT_REFUSAL_REASONS = [
  /** Not whole JSON, and older than the grace a writer is given to finish. */
  'abandoned-partial-write',
  /** Whole JSON, but not the declared `command.intent` shape. */
  'malformed',
  /** A `command` outside the enum: a control this build does not have. */
  'unrecognised-command',
  /** No principal, so the command is unattributable (AD-19). */
  'missing-principal',
  /** An id that could not be carried into the log, so exactly-once could not be guaranteed. */
  'unloggable-intent-id',
  /** An intent naming a different run than the directory it sits in. */
  'misaddressed',
  /** A run with no state at all: nothing to steer. */
  'unknown-run',
  /** The run has reached a terminal state, which nothing walks back. */
  'terminal-run',
  /** The command's target is not in a state that takes it. */
  'wrong-target-state',
  /**
   * A question command carrying no free text, so there is nothing to record as the decision.
   *
   * Refused rather than applied because the decision is durable: a rejection with no reason would lose
   * the reason the interface contract makes its whole point, and an empty answer would win the AD-25
   * compare-and-set and record that the user said nothing.
   */
  'missing-answer',
  /** A question command for a run with no question to answer, or none still open. */
  'no-open-question',
  /** The command is declared but not honoured by this build; the owning story is named. */
  'not-yet-honoured',
  /**
   * The id is in the log against a *different* command, so it is not a redelivery of this one.
   *
   * The exactly-once ledger keys on the id. Without the command beside it, a second intent reusing an
   * id would be recognised as "already applied" and dropped with no effect and no refusal — a command
   * that vanished. A reused id is a writer's fault, not a redelivery, and is refused as one.
   */
  'intent-id-reused',
  /**
   * The file exists but could not be read at all — EACCES, EIO, a directory where a file should be.
   *
   * Refused rather than skipped. A silent `continue` put the file in none of the three classes, so no
   * pass reported it and no pass ever quarantined it: met and stepped over for ever, which is exactly
   * the poison file the transport must not leave behind.
   */
  'unreadable-file',
  /**
   * Applying the effect threw, so the intent is not a transport fault but is not applicable either.
   *
   * Quarantined rather than left pending, because an intent whose effect throws throws again on every
   * pass and on every 25ms mid-step poll — a poison file wearing an effect's clothes.
   */
  'effect-failed',
] as const;

export type IntentRefusalReason = (typeof INTENT_REFUSAL_REASONS)[number];

/** One refused intent: what was refused, why, and where the file went. */
export interface IntentRefusal {
  readonly reason: IntentRefusalReason;
  /** The file's name inside `commands/`, which is all that is known for an unparseable file. */
  readonly fileName: string;
  /** The intent id, when the file was whole enough to carry one. */
  readonly intentId: string | null;
  /** The command, when the file named a recognised one. */
  readonly command: Command | null;
  /** One sentence a person can act on. Never a stack trace. */
  readonly detail: string;
  /** Where the file was moved to, once it was quarantined. */
  readonly quarantinedTo: string | null;
}

/** One intent a pass may act on: the parsed contract and the file it came from. */
export interface PendingIntent {
  readonly intent: CommandIntent;
  readonly fileName: string;
  readonly path: string;
  /**
   * How long ago the file was written, or `null` when that could not be read.
   *
   * Carried because one caller has to give a *valid* intent a grace period too, not only a torn one: an
   * intent written between a run directory's creation and its first log append belongs to a run that
   * carries no state yet, and quarantining it on sight destroys a command the user issued a millisecond
   * too early. Age is the only thing that tells that case from an intent addressed to a run that will
   * never exist.
   */
  readonly ageMs: number | null;
}

/** What one read of `commands/` found. */
export interface IntentDirectoryRead {
  /** Intents in the deterministic order a pass applies them in. */
  readonly pending: readonly PendingIntent[];
  /** Files refused on sight. Quarantining them is a separate, explicit step. */
  readonly refused: readonly IntentRefusal[];
  /** Files not whole JSON yet, still inside the grace a writer is given. Left untouched. */
  readonly incomplete: readonly string[];
}

const refusal = (
  fileName: string,
  reason: IntentRefusalReason,
  detail: string,
  extra: { readonly intentId?: string | null; readonly command?: Command | null } = {},
): IntentRefusal => ({
  reason,
  fileName,
  intentId: extra.intentId ?? null,
  command: extra.command ?? null,
  detail,
  quarantinedTo: null,
});

/**
 * The field paths a Zod failure named, rendered for a person rather than dumped.
 *
 * A failure at the *root* — the document is a string, a number or an array rather than an object —
 * names no field at all, and the sentence built from it used to end "the declared shape rejects " with
 * nothing after it. So the empty case is answered in words instead: the fault is the document, not a
 * field of it.
 */
const namedFields = (issues: readonly { readonly path: readonly PropertyKey[] }[]): string => {
  const named = [
    ...new Set(issues.map((issue) => issue.path.map(String).join('.')).filter((path) => path !== '')),
  ];
  return named.length === 0
    ? 'the document itself, which is valid JSON but not an object with the declared fields'
    : named.join(', ');
};

/**
 * Order the intents of one pass.
 *
 * **A stop gesture goes first, whatever its issue time.** This is not a tidiness rule: a person who
 * presses disengage while a `confirm_spec` or an `approve` is still sitting in `commands/` has pressed it
 * *to override that command*, and applying the earlier one first walks the run into execution before
 * stopping it. `issued_at` cannot arbitrate that — it is writer-supplied, so a skewed clock on the
 * machine that wrote the approval is enough to put it first — and CAP-5's "always available" is not a
 * promise a queue position can keep. The mid-step watcher already gives these three the same precedence;
 * this makes the pass agree with it.
 *
 * After that: issue time, then the intent id, then the file name — three more total keys, so two intents
 * arriving in one pass are applied in the same order however the directory was listed and however many
 * times the pass is repeated. A restart that applied them the other way round could reach a different
 * state, which is the one thing AD-7 does not allow.
 */
export const orderIntents = (intents: readonly PendingIntent[]): readonly PendingIntent[] =>
  [...intents].sort((a, b) => {
    const stopA = isStopCommand(a.intent.command);
    const stopB = isStopCommand(b.intent.command);
    if (stopA !== stopB) return stopA ? -1 : 1;
    if (a.intent.issued_at !== b.intent.issued_at) {
      return a.intent.issued_at < b.intent.issued_at ? -1 : 1;
    }
    if (a.intent.intent_id !== b.intent.intent_id) {
      return a.intent.intent_id < b.intent.intent_id ? -1 : 1;
    }
    return a.fileName < b.fileName ? -1 : a.fileName > b.fileName ? 1 : 0;
  });

export { STOP_COMMANDS, isStopCommand } from '../runtime/steering-view.js';

/** Names of the files in `commands/` that could be intents, ignoring the two quarantine directories. */
const intentFileNames = (paths: RunPaths): readonly string[] => {
  let entries: string[];
  try {
    entries = readdirSync(paths.commandsDir, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name);
  } catch {
    // No commands directory is the ordinary case: a run nobody has steered.
    return [];
  }
  /**
   * No sidecar filter. A refusal sidecar is only ever written into `commands/refused/`, which this
   * non-recursive listing never descends into, and an intent id may no longer contain a `.` — so no file
   * in `commands/` can be named like one. The filter that used to sit here was dead in both directions,
   * and worse than dead: it was the mechanism by which an id ending `.refusal` produced a file this
   * reader hid from itself, so a disengage written with such an id was never read, never refused and
   * never reported. The fix is in `INTENT_ID_PATTERN`, where a name can no longer be built that way.
   */
  return entries
    .filter((name) => name.endsWith(INTENT_FILE_EXTENSION) && !name.endsWith(INTENT_TEMP_SUFFIX))
    .sort();
};

/**
 * How long ago a file was last written, or `null` when that cannot be read.
 *
 * A *negative* age is reported as it is rather than clamped to zero. Clamping made a file whose mtime
 * was in the future — a clock that stepped back, an NFS server a minute ahead — look permanently
 * freshly-written, so a torn one stayed inside its grace on every pass and was classified `incomplete`
 * for ever. A skew cannot be waited out, so the caller treats it as age rather than as youth.
 */
const ageMs = (path: string, now: number): number | null => {
  try {
    const age = now - statSync(path).mtimeMs;
    /**
     * Jitter is clamped to zero; a real skew is not.
     *
     * A file written microseconds ago reads as a fraction of a millisecond in the future, because the
     * filesystem records sub-millisecond mtimes and `Date.now()` truncates — that is a brand-new file and
     * is reported as one. A mtime a *second or more* ahead is a clock that disagrees, and the caller has
     * to be able to tell: clamping it to zero (which is what this used to do to everything) made such a
     * file look permanently freshly-written, so a torn one sat inside its grace on every pass until real
     * time caught up, which for a badly-skewed clock is hours.
     */
    return age < 0 && age > -CLOCK_SKEW_TOLERANCE_MS ? 0 : age;
  } catch {
    return null;
  }
};

/**
 * Read `commands/`: parse every candidate, classify every failure, and order what survived.
 *
 * Nothing is moved, deleted or recorded here. A read that quarantined as it went could not be used by
 * the mid-step watcher, which reads this directory while a step is running and must not write to the
 * log from inside somebody else's action.
 */
export const readIntentFiles = (
  paths: RunPaths,
  options: {
    readonly now?: () => Date;
    readonly tornGraceMs?: number;
    /**
     * How a file's bytes are read. The default is `readFileSync`, and nothing in production passes another.
     *
     * A seam, for the same reason `now` is one: the `EACCES`/`EIO` class — a file that is present and
     * cannot be read — has no portable way to be produced on a filesystem. `chmod 000` does nothing when
     * the suite runs as root, which it does in the container, and a directory is filtered out by the
     * listing before it is ever read. Without the seam the branch that classifies it would be untestable,
     * and it is the branch whose absence used to create a file no pass ever reported.
     */
    readonly readFile?: (path: string) => string;
  } = {},
): IntentDirectoryRead => {
  const now = (options.now ?? ((): Date => new Date()))().getTime();
  const grace = options.tornGraceMs ?? TORN_INTENT_GRACE_MS;
  const readFile = options.readFile ?? ((path: string): string => readFileSync(path, 'utf8'));

  const pending: PendingIntent[] = [];
  const refused: IntentRefusal[] = [];
  const incomplete: string[] = [];

  for (const fileName of intentFileNames(paths)) {
    const path = join(paths.commandsDir, fileName);

    const age = ageMs(path, now);

    let raw: string;
    try {
      raw = readFile(path);
    } catch (thrown: unknown) {
      /**
       * `ENOENT` is the one benign case: the file was retired, quarantined or renamed between the
       * listing and this read, so there is nothing here to refuse and nothing to report.
       *
       * Everything else — `EACCES`, `EIO`, `EISDIR` — is a file that exists and cannot be read, and it
       * used to be `continue`d silently. That put it in none of the three classes: no pass reported it,
       * no pass quarantined it, and every pass and every 25ms mid-step poll met it again. That is the
       * poison file this module exists to make impossible, created by the reader itself.
       */
      const code = (thrown as { code?: string } | null)?.code;
      if (code === 'ENOENT') continue;
      refused.push(
        refusal(
          fileName,
          'unreadable-file',
          `the file is present but could not be read (${code ?? 'no error code'}), so nothing about it ` +
            'can be decided. It is moved out of the way rather than met again by every later pass.',
        ),
      );
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      /**
       * A partial JSON write. Inside the grace it is the writer's business and is left alone — the
       * matrix's "the file is not treated as consumed". Outside it, no writer is coming back, and a
       * file left for ever would be met by every later pass.
       *
       * An unreadable mtime is treated as *outside* the grace, not inside it. A file whose age cannot be
       * read will never become readable by waiting, so leaving it `incomplete` leaves it `incomplete` for
       * ever — the same poison file by a different route. A future mtime lands here too, because
       * {@link ageMs} reports skew as a negative age rather than clamping it away.
       */
      if (age !== null && age >= 0 && age < grace) {
        incomplete.push(fileName);
        continue;
      }
      refused.push(
        refusal(
          fileName,
          'abandoned-partial-write',
          age === null
            ? 'the file is not whole JSON and its modification time could not be read, so there is no ' +
              'grace period that could tell a live writer from a dead one'
            : age < 0
              ? `the file is not whole JSON and its modification time is ${String(
                  Math.round(-age / 1000),
                )}s in the future, so a grace period measured against it cannot be waited out`
              : `the file is not whole JSON and was last written ${String(Math.round(age / 1000))}s ago, ` +
                'so the writer that started it is not going to finish it',
        ),
      );
      continue;
    }

    const record: Record<string, unknown> =
      typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
    const declaredId = typeof record['intent_id'] === 'string' ? record['intent_id'] : null;
    const declaredCommand = record['command'];

    const result = CommandIntentSchema.safeParse(parsed);
    if (!result.success) {
      const issues = result.error.issues;
      const paths_ = new Set(issues.map((issue) => issue.path.map(String).join('.')));

      if (typeof declaredCommand === 'string' && !(COMMANDS as readonly string[]).includes(declaredCommand)) {
        refused.push(
          refusal(
            fileName,
            'unrecognised-command',
            `"${declaredCommand}" is not one of the declared commands (${COMMANDS.join(', ')}). ` +
              'The Command enum is defined once (AD-3), so a control this build does not have is a ' +
              'control no renderer can have issued.',
            { intentId: declaredId },
          ),
        );
        continue;
      }
      /**
       * Reported as a missing principal only when the principal is the *only* thing wrong.
       *
       * A file that is nothing like an intent is missing a principal too, and naming that as the fault
       * would send a person looking for one field in a file that needs all of them.
       */
      const onlyThePrincipal =
        paths_.size > 0 && [...paths_].every((path) => path.startsWith('principal'));
      if (onlyThePrincipal) {
        refused.push(
          refusal(
            fileName,
            'missing-principal',
            'the field "principal" is absent or not a declared principal. AD-19 requires every ' +
              'command to record its principal, so an approval is attributable to a person, a ' +
              'timeout or an agent — an unattributable approval is never applied.',
            { intentId: declaredId },
          ),
        );
        continue;
      }
      refused.push(
        refusal(
          fileName,
          'malformed',
          `the file is whole JSON but not a command intent: the declared shape rejects ` +
            `${namedFields(issues)}`,
          { intentId: declaredId },
        ),
      );
      continue;
    }

    const intent = result.data;
    if (!isLoggableIntentId(intent.intent_id)) {
      refused.push(
        refusal(
          fileName,
          'unloggable-intent-id',
          `the intent id "${intent.intent_id}" cannot be carried into an event payload unchanged, ` +
            'so applying it could not be made exactly-once. An id must match ' +
            `${String(INTENT_ID_PATTERN)} with no unbroken run longer than ` +
            `${String(MAX_INTENT_ID_TOKEN_RUN)} alphanumeric characters.`,
          { intentId: intent.intent_id, command: intent.command },
        ),
      );
      continue;
    }
    if (intent.run !== paths.runId) {
      refused.push(
        refusal(
          fileName,
          'misaddressed',
          `the intent names run "${intent.run}" but sits in the commands directory of ` +
            `"${paths.runId}", so there is no run here it could steer`,
          { intentId: intent.intent_id, command: intent.command },
        ),
      );
      continue;
    }

    pending.push({ intent, fileName, path, ageMs: age });
  }

  return { pending: orderIntents(pending), refused, incomplete };
};

/**
 * How many suffixed names a collision is given before the name is made unique by other means.
 *
 * A bound rather than a `while` loop, because the loop it replaces was unbounded: a directory holding
 * every suffix would spin it, and the thing being protected is a pass that must finish.
 */
const MOVE_ASIDE_SUFFIX_LIMIT = 100;

/**
 * Move a file aside, giving it a fresh name if something already sits there.
 *
 * The name is reserved by an **exclusive create**, not by an `existsSync` test. The test-then-rename it
 * replaces was a time-of-check/time-of-use gap on a directory two processes write to: both could see the
 * same free name, and the second `rename` would replace — silently destroying the first quarantined
 * file, which is the one copy of the evidence. `wx` decides the name atomically, and `rename` over the
 * reservation this process owns is then safe.
 *
 * The first collision is named `.1`, which is what a reader expects of the first duplicate; the old
 * numbering started at `.2` and left `.1` permanently unused.
 */
const moveAside = (from: string, intoDir: string, fileName: string): string => {
  mkdirSync(intoDir, { recursive: true });
  for (let suffix = 0; suffix <= MOVE_ASIDE_SUFFIX_LIMIT; suffix += 1) {
    const target = join(intoDir, suffix === 0 ? fileName : `${fileName}.${String(suffix)}`);
    try {
      closeSync(openSync(target, 'wx'));
    } catch (thrown: unknown) {
      if ((thrown as { code?: string } | null)?.code === 'EEXIST') continue;
      throw thrown;
    }
    renameSync(from, target);
    fsyncDirectory(intoDir);
    return target;
  }
  // Every suffix taken. A name nothing can collide with, rather than a refusal: the file still has to
  // leave `commands/`, or the pass that refused it meets it again.
  const unique = join(
    intoDir,
    `${fileName}.${String(process.pid)}.${String(Date.now())}${INTENT_FILE_EXTENSION}`,
  );
  renameSync(from, unique);
  fsyncDirectory(intoDir);
  return unique;
};

/**
 * Quarantine a refused intent: move it into `commands/refused/` and write why beside it.
 *
 * Moved rather than deleted, and recorded on disk rather than only in the log, because the run whose
 * intent this was may have no log to record into — an intent for a directory carrying no state is one
 * of the refusals, and it is the case where a file is most likely to be the only evidence.
 */
export const quarantineIntent = (paths: RunPaths, found: IntentRefusal): IntentRefusal => {
  const source = join(paths.commandsDir, found.fileName);
  let quarantinedTo: string | null = null;
  try {
    quarantinedTo = moveAside(source, paths.commandsRefusedDir, found.fileName);
    // As in `retireIntent`: the rename out of `commands/` is what stops the file being met again, so the
    // directory it left is synced as well as the one it arrived in.
    fsyncDirectory(paths.commandsDir);
  } catch {
    // The file is already gone, or the move failed. Either way the sidecar below still records the
    // refusal, and a file that cannot be moved is reported rather than retried silently.
    quarantinedTo = null;
  }

  /**
   * The sidecar is named after where the file *landed*, not after what it was called.
   *
   * Two files quarantined under one name is the ordinary consequence of {@link moveAside}'s suffixing,
   * and a sidecar named from `found.fileName` would have been written twice to the same path — so the
   * second refusal's explanation overwrote the first's, on the one artifact that is the only record when
   * the run has no log to write to.
   */
  const sidecarFor = quarantinedTo === null ? found.fileName : basenameOf(quarantinedTo);
  try {
    writeFileSync(
      join(paths.commandsRefusedDir, `${sidecarFor}${REFUSAL_SIDECAR_EXTENSION}`),
      `${JSON.stringify(
        {
          schema_version: CURRENT_SCHEMA_VERSION,
          reason: found.reason,
          detail: found.detail,
          intent_id: found.intentId,
          command: found.command,
          file: found.fileName,
          refused_at: formatTimestamp(new Date()),
        },
        null,
        2,
      )}\n`,
      'utf8',
    );
  } catch {
    // A sidecar that could not be written loses the explanation, never the quarantine itself.
  }

  return { ...found, quarantinedTo };
};

/**
 * Retire an intent whose effect is durable: move it into `commands/applied/`.
 *
 * Called *after* the effect's line is in the log and never before — that order is the whole of
 * at-least-once delivery. Moving rather than deleting keeps the evidence of what steered a run, and a
 * file that fails to move is redelivered, which the `intent_id` ledger already makes harmless.
 */
export const retireIntent = (paths: RunPaths, pending: PendingIntent): string | null => {
  try {
    const moved = moveAside(pending.path, paths.commandsAppliedDir, pending.fileName);
    // The rename *out of* `commands/` is what stops the intent being redelivered, so that directory's
    // own metadata is synced too: a crash that lost this rename would redeliver a command whose effect
    // is already in the log. The id ledger makes that harmless, but harmless is not the same as durable.
    fsyncDirectory(paths.commandsDir);
    return moved;
  } catch {
    return null;
  }
};

/** The final path segment, used to name a sidecar after the file it explains. */
const basenameOf = (path: string): string => path.slice(path.lastIndexOf('/') + 1);

/**
 * How many retired and refused intents a run keeps before the oldest are removed.
 *
 * `applied/` and `refused/` are evidence, not state: nothing reads them, and the log holds every fact
 * they carry. Unbounded, they are one file per keystroke for the life of a run — so they are pruned to a
 * window that still answers "what steered this run recently" without growing without limit. Newest kept,
 * because that is the window a person looks at.
 */
export const RETIRED_INTENT_KEEP = 200;

/**
 * Prune `commands/applied/` and `commands/refused/` to the most recent {@link RETIRED_INTENT_KEEP}.
 *
 * Ordering is by file name, which begins with the issue timestamp, so it is chronological without a
 * `stat` per file. A refusal sidecar is pruned with the file it explains rather than counted separately:
 * an explanation whose subject is gone explains nothing.
 */
export const pruneRetiredIntents = (paths: RunPaths, keep: number = RETIRED_INTENT_KEEP): number => {
  let removed = 0;
  for (const directory of [paths.commandsAppliedDir, paths.commandsRefusedDir]) {
    let names: string[];
    try {
      names = readdirSync(directory).sort();
    } catch {
      continue;
    }
    const subjects = names.filter((name) => !name.endsWith(REFUSAL_SIDECAR_EXTENSION));
    if (subjects.length <= keep) continue;
    for (const name of subjects.slice(0, subjects.length - keep)) {
      for (const victim of [name, `${name}${REFUSAL_SIDECAR_EXTENSION}`]) {
        try {
          unlinkSync(join(directory, victim));
          removed += 1;
        } catch {
          // Already gone, or not ours to remove. Neither is a fault: the prune is best-effort tidying.
        }
      }
    }
  }
  return removed;
};

/**
 * Every intent id the log says has already been applied, **and which command it was applied for**.
 *
 * This is the exactly-once ledger, and it lives in the log because AD-4 makes the log the only
 * durable truth: a ledger kept anywhere else would be a second authority for the one fact that
 * decides whether a user's approval is applied twice.
 *
 * The command travels with the id because the id alone cannot tell a *redelivery* from a *reuse*. An
 * intent whose id is already in the log against a different command is not the same gesture arriving
 * twice — it is a second, different command that the ledger would have swallowed as "already applied",
 * with no effect, no refusal and nothing anywhere saying it did nothing. A `Map` makes that
 * distinguishable; a `Set` could not.
 *
 * The value is `null` for a logged line whose `command` field is absent or not a declared command: the
 * id has been applied, but what it was applied *for* is unknown, so a later intent carrying it cannot be
 * called a mismatch on evidence the log does not have.
 */
export const appliedIntentIds = (
  events: readonly EventEnvelope[],
): ReadonlyMap<string, Command | null> => {
  const applied = new Map<string, Command | null>();
  for (const event of events) {
    if (event.type !== COMMAND_EVENT_TYPES.Applied) continue;
    const id = event.payload['intent_id'];
    if (typeof id !== 'string' || id === '') continue;
    const command = event.payload['command'];
    const declared =
      typeof command === 'string' && (COMMANDS as readonly string[]).includes(command)
        ? (command as Command)
        : null;
    // The first line for an id is the one that applied it; a later one is the redelivery the fold
    // already ignores, so it does not get to restate what the command was.
    if (!applied.has(id)) applied.set(id, declared);
  }
  return applied;
};
