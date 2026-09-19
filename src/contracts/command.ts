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
 * A durable steering intent file. The loopback HTTP server is an accelerator that writes these
 * same files; with it down, every control remains available through the file path (AD-19).
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
});

export type CommandIntent = z.infer<typeof CommandIntentSchema>;
