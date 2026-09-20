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
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
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
  isLoggableIntentId,
} from '../runtime/commands.js';
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

/** The field paths a Zod failure named, rendered for a person rather than dumped. */
const namedFields = (issues: readonly { readonly path: readonly PropertyKey[] }[]): string =>
  [...new Set(issues.map((issue) => issue.path.map(String).join('.')).filter((path) => path !== ''))]
    .join(', ');

/**
 * Order the intents of one pass.
 *
 * Issue time first, then the intent id, then the file name: three total keys, so two intents arriving
 * in one pass are applied in the same order however the directory was listed and however many times
 * the pass is repeated. A restart that applied them the other way round could reach a different state,
 * which is the one thing AD-7 does not allow.
 */
export const orderIntents = (intents: readonly PendingIntent[]): readonly PendingIntent[] =>
  [...intents].sort((a, b) => {
    if (a.intent.issued_at !== b.intent.issued_at) {
      return a.intent.issued_at < b.intent.issued_at ? -1 : 1;
    }
    if (a.intent.intent_id !== b.intent.intent_id) {
      return a.intent.intent_id < b.intent.intent_id ? -1 : 1;
    }
    return a.fileName < b.fileName ? -1 : a.fileName > b.fileName ? 1 : 0;
  });

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
  return entries
    .filter((name) => name.endsWith(INTENT_FILE_EXTENSION) && !name.endsWith(INTENT_TEMP_SUFFIX))
    .filter((name) => !name.endsWith(REFUSAL_SIDECAR_EXTENSION))
    .sort();
};

/** How long ago a file was last written, or `null` when that cannot be read. */
const ageMs = (path: string, now: number): number | null => {
  try {
    return Math.max(now - statSync(path).mtimeMs, 0);
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
  options: { readonly now?: () => Date; readonly tornGraceMs?: number } = {},
): IntentDirectoryRead => {
  const now = (options.now ?? ((): Date => new Date()))().getTime();
  const grace = options.tornGraceMs ?? TORN_INTENT_GRACE_MS;

  const pending: PendingIntent[] = [];
  const refused: IntentRefusal[] = [];
  const incomplete: string[] = [];

  for (const fileName of intentFileNames(paths)) {
    const path = join(paths.commandsDir, fileName);

    let raw: string;
    try {
      raw = readFileSync(path, 'utf8');
    } catch {
      // Read after a concurrent rename, or a permission fault. Neither is a refusal: the file may
      // well be there on the next pass, and refusing would quarantine something never inspected.
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
       */
      const age = ageMs(path, now);
      if (age === null || age < grace) {
        incomplete.push(fileName);
        continue;
      }
      refused.push(
        refusal(
          fileName,
          'abandoned-partial-write',
          `the file is not whole JSON and was last written ${String(Math.round(age / 1000))}s ago, ` +
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

    pending.push({ intent, fileName, path });
  }

  return { pending: orderIntents(pending), refused, incomplete };
};

/** Move a file aside, giving it a fresh name if something already sits there. */
const moveAside = (from: string, intoDir: string, fileName: string): string => {
  mkdirSync(intoDir, { recursive: true });
  let target = join(intoDir, fileName);
  let suffix = 1;
  while (existsSync(target)) {
    suffix += 1;
    target = join(intoDir, `${fileName}.${String(suffix)}`);
  }
  renameSync(from, target);
  return target;
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
  } catch {
    // The file is already gone, or the move failed. Either way the sidecar below still records the
    // refusal, and a file that cannot be moved is reported rather than retried silently.
    quarantinedTo = null;
  }

  try {
    writeFileSync(
      join(paths.commandsRefusedDir, `${found.fileName}${REFUSAL_SIDECAR_EXTENSION}`),
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
    return moveAside(pending.path, paths.commandsAppliedDir, pending.fileName);
  } catch {
    return null;
  }
};

/**
 * Every intent id the log says has already been applied.
 *
 * This is the exactly-once ledger, and it lives in the log because AD-4 makes the log the only
 * durable truth: a ledger kept anywhere else would be a second authority for the one fact that
 * decides whether a user's approval is applied twice.
 */
export const appliedIntentIds = (events: readonly EventEnvelope[]): ReadonlySet<string> => {
  const applied = new Set<string>();
  for (const event of events) {
    if (event.type !== COMMAND_EVENT_TYPES.Applied) continue;
    const id = event.payload['intent_id'];
    if (typeof id === 'string' && id !== '') applied.add(id);
  }
  return applied;
};
