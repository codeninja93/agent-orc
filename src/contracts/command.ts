/**
 * AD-3 — every steering control is a member of a single `Command` enum defined once.
 *
 * Both renderers (Ink TUI, loopback web control surface) are built against this enum, so a
 * control present in one and absent from the other is a compile error rather than a difference a
 * user discovers. The controls enumerated here are exactly those named by `interface-contract.md`
 * ("Mode and control", "Required surfaces") and by CAP-5, CAP-15 and CAP-23.
 *
 * AD-19 — a command reaches the engine only as a durable intent file under
 * `runs/<run-id>/commands/`. The intent's shape is declared here beside the enum; writing and
 * consuming those files is the engine's and the renderers' work in later stories.
 */
import { z } from 'zod';

import { TimestampSchema } from './event.js';
import { versioned } from './schema-version.js';

export const Command = {
  /** Answer the active question. Free text; the system parses (interface-contract Q6). */
  Answer: 'answer',
  /** Confirm the spec echo's acceptance criteria as written (CAP-2). */
  ConfirmSpec: 'confirm_spec',
  /** Amend one acceptance-criterion line without re-prompting from scratch (CAP-2). */
  EditCriterion: 'edit_criterion',
  /** Approve an irreversible action waiting at a gate (CAP-12). */
  Approve: 'approve',
  /** Reject, with a reason that becomes a ledger entry (CAP-18). */
  Reject: 'reject',
  /** Continue past a kill card without changing scope (CAP-15). */
  Continue: 'continue',
  /** Narrow the run's scope rather than killing it (CAP-16, CAP-15). */
  Narrow: 'narrow',
  /** Pause the run, leaving clean resumable state (CAP-15). */
  Pause: 'pause',
  /** Inject a note into a running agent's next input (CAP-15). */
  InjectNote: 'inject_note',
  /** Terminate the current step; records the `killed` disposition, never resumed (AD-8). */
  Kill: 'kill',
  /** Fork the run from its current point (CAP-15). */
  Fork: 'fork',
  /** Take manual control, producing an ordinary branch holding partial work (CAP-23). */
  TakeOver: 'take_over',
  /** Instant, always-available stop gesture (CAP-5). */
  Disengage: 'disengage',
  /** Stop asking, use judgement, review at the end (interface-contract, first-class). */
  JustDoIt: 'just_do_it',
} as const;

export type Command = (typeof Command)[keyof typeof Command];

/** Every command, in declaration order. */
export const COMMANDS: readonly Command[] = Object.freeze(Object.values(Command));

export const CommandSchema = z.enum(Command);

/**
 * A total map from command to `T`. Renderers type their control tables with this, which is what
 * makes a missing control a compile error rather than a runtime gap (AD-3).
 */
export type CommandMap<T> = Readonly<Record<Command, T>>;

/** AD-19 — every command records its principal, so approvals are attributable. */
export const PRINCIPAL_KINDS = ['user', 'timeout', 'agent'] as const;

export type PrincipalKind = (typeof PRINCIPAL_KINDS)[number];

export const PrincipalSchema = z.object({
  kind: z.enum(PRINCIPAL_KINDS),
  id: z.string(),
});

export type Principal = z.infer<typeof PrincipalSchema>;

/** Which renderer or mechanism wrote the intent file. Never a second command path (AD-19). */
export const COMMAND_SOURCES = ['tui', 'web', 'cli', 'timeout'] as const;

export type CommandSource = (typeof COMMAND_SOURCES)[number];

/**
 * The commands that carry no meaning without text.
 *
 * An `answer` with nothing in it is not an answer, a `reject` with no reason writes an empty ledger
 * entry (CAP-18), an `edit_criterion` with no replacement line amends nothing, a `narrow` names no
 * narrower scope and an `inject_note` injects nothing. Each of those is an intent the consumer can
 * only accept and then silently do nothing about, which is the worst of the three possible outcomes:
 * the user believes they steered the run.
 *
 * Declared here beside the enum, rather than as a second list in each consumer, so the renderers'
 * input handling and the engine's acceptance cannot disagree about which controls need text.
 */
export const ARGUMENT_REQUIRED_COMMANDS: readonly Command[] = Object.freeze([
  Command.Answer,
  Command.Reject,
  Command.EditCriterion,
  Command.Narrow,
  Command.InjectNote,
]);

export const commandRequiresArgument = (command: Command): boolean =>
  ARGUMENT_REQUIRED_COMMANDS.includes(command);

/**
 * A durable steering intent file. The loopback HTTP server is an accelerator that writes these
 * same files; with it down, every control remains available through the file path (AD-19).
 *
 * Two cross-field rules are part of the shape rather than of a consumer's checking, because an
 * intent file is read by the engine, by both renderers and by any later replay: a rule enforced at
 * one reader is a rule the other readers do not have.
 */
export const CommandIntentSchema = versioned({
  intent_id: z.string(),
  command: CommandSchema,
  run: z.string(),
  feature: z.string(),
  step: z.string().nullable(),
  principal: PrincipalSchema,
  source: z.enum(COMMAND_SOURCES),
  issued_at: TimestampSchema,
  /** Free text; the system parses. Never impose a format on the human (Q6). */
  argument: z.string().nullable(),
})
  /**
   * Whitespace is not text. A `narrow` carrying `"   "` reaches a consumer as a scope change with
   * nothing in it, which is the same unactionable intent as `null` wearing a different coat. Trimming
   * to decide, never to rewrite: Q6's "never impose a format on the human" still holds, so the
   * argument the consumer reads is exactly what was written.
   */
  .refine(
    (intent) =>
      !commandRequiresArgument(intent.command) ||
      (intent.argument !== null && intent.argument.trim() !== ''),
    {
      message:
        'this command is meaningless without text, so an intent carrying no argument is refused ' +
        'rather than accepted and silently doing nothing',
      path: ['argument'],
    },
  )
  /**
   * AD-19 — a command records its principal so approvals are attributable. A clock's default is
   * nobody's approval: pairing `source: 'timeout'` with a `user` principal would put a person's name
   * on a decision they never made, and the decision ledger (CAP-18) keeps that attribution for ever.
   */
  .refine((intent) => intent.source !== 'timeout' || intent.principal.kind !== 'user', {
    message:
      'a timeout-sourced intent is the clock acting, so it is never attributed to a user principal ' +
      '(AD-19)',
    path: ['principal', 'kind'],
  });

export type CommandIntent = z.infer<typeof CommandIntentSchema>;
