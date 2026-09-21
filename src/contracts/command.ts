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
 * The key a cross-field refusal carries in its Zod issue `params`, and the rules that use it.
 *
 * A cross-field rule has to report *somewhere*, and Zod's only place to report is a field path — so both
 * rules below borrow a path from one of the two fields they relate. That misleads a reader on its own:
 * `readIntentFiles` classified any issue under `principal` as "the field is absent or not a declared
 * principal", so an intent whose principal was present, well-formed and simply paired with the wrong
 * source was refused with a sentence about a missing field. The marker is what lets a consumer tell "this
 * field is wrong" from "these two fields disagree", without re-implementing the rule to find out.
 */
export const INTENT_RULE_PARAM_KEY = 'intent_rule';

export const INTENT_RULES = {
  /** The command is one of {@link ARGUMENT_REQUIRED_COMMANDS} and carries no usable text. */
  ArgumentRequired: 'argument-required',
  /** `source: 'timeout'` and `principal.kind: 'timeout'` are not the same answer. */
  PrincipalAttribution: 'principal-attribution',
} as const;

export type IntentRule = (typeof INTENT_RULES)[keyof typeof INTENT_RULES];

/**
 * The rule a Zod issue reports, when it reports one of the cross-field rules rather than a field.
 *
 * Typed against `unknown` rather than against Zod's issue union: only the `custom` member of that union
 * carries `params` at all, so a structural parameter type is rejected for every other member — and a
 * caller holding `error.issues` holds the union. The narrowing is done here, once, instead of at each
 * caller.
 */
export const intentRuleOfIssue = (issue: unknown): IntentRule | null => {
  const params = (issue as { params?: unknown } | null)?.params;
  if (typeof params !== 'object' || params === null) return null;
  const declared = (params as Record<string, unknown>)[INTENT_RULE_PARAM_KEY];
  return typeof declared === 'string' &&
    (Object.values(INTENT_RULES) as readonly string[]).includes(declared)
    ? (declared as IntentRule)
    : null;
};

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
      params: { [INTENT_RULE_PARAM_KEY]: INTENT_RULES.ArgumentRequired },
    },
  )
  /**
   * AD-19 — a command records its principal so approvals are attributable, and the clock and the
   * `timeout` source are the *same* fact stated twice.
   *
   * So the rule is an equivalence, not an implication. The implication it replaces —
   * `source !== 'timeout' || principal.kind !== 'user'` — guarded only the benign direction: it refused a
   * clock's default wearing a person's name, and accepted the dangerous inverse, a `tui`-sourced intent
   * claiming a `timeout` principal. That is a person's decision recorded as the clock's, which launders a
   * human choice into "the system did it automatically" and which the decision ledger (CAP-18) then keeps
   * for ever. Both directions are wrong for the same reason and both are refused here.
   *
   * `agent` and `user` principals are free to use any of the other three sources; only the `timeout`
   * pairing is fixed, because only the clock has a source of its own.
   */
  .refine((intent) => (intent.source === 'timeout') === (intent.principal.kind === 'timeout'), {
    message:
      'the "timeout" source and the "timeout" principal are one fact: a clock-sourced intent is always ' +
      'attributed to the clock, and an intent attributed to the clock always comes from it (AD-19)',
    path: ['principal', 'kind'],
    params: { [INTENT_RULE_PARAM_KEY]: INTENT_RULES.PrincipalAttribution },
  });

export type CommandIntent = z.infer<typeof CommandIntentSchema>;
