/**
 * The typed step envelope. A step agent is a pure function over exactly these two files: one
 * typed input file in, one typed output file out, no hidden state and no knowledge of what ran
 * before or runs next.
 *
 * Everything in this module is a *step contract* and so stays inside the structured-outputs
 * subset AD-2 declares: no date types, no recursion, no `minLength`, no `minItems` above one and
 * no `minimum`. That rules out `z.int()` (which exports safe-integer bounds), `z.record()` and
 * `z.unknown()` (which export open objects), and `.optional()` in favour of `.nullable()`, so
 * every property stays required and the shape stays closed. `tests/contracts.subset-guard.test.ts`
 * holds the line, because a violation is invisible until a spawn fails.
 */
import { z } from 'zod';

import { TimestampSchema } from './event.js';
import { OrchErrorSchema } from './error.js';
import { QuestionDraftSchema } from './question.js';
import { versioned } from './schema-version.js';

/** AD-27 — a shadow run is an ordinary run carrying a mode flag. */
export const RUN_MODES = ['live', 'shadow'] as const;

export type RunMode = (typeof RUN_MODES)[number];

/** AD-8 — every step termination records a disposition; only `interrupted` is resumable. */
export const STEP_DISPOSITIONS = [
  'completed',
  'blocked',
  'failed',
  'interrupted',
  'killed',
] as const;

export type StepDisposition = (typeof STEP_DISPOSITIONS)[number];

export const RESUMABLE_STEP_DISPOSITIONS: readonly StepDisposition[] = ['interrupted'];

export const isResumable = (disposition: StepDisposition): boolean =>
  RESUMABLE_STEP_DISPOSITIONS.includes(disposition);

/** The status a step agent reports about its own work. */
export const STEP_STATUSES = ['completed', 'blocked', 'failed'] as const;

export type StepStatus = (typeof STEP_STATUSES)[number];

/** AD-23 — evidence never enters the control plane; it is referenced by pointer. */
export const EVIDENCE_KINDS = [
  'transcript',
  'diff',
  'fetch_record',
  'telemetry',
  'artifact',
  'log',
] as const;

export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];

export const EvidencePointerSchema = z.object({
  kind: z.enum(EVIDENCE_KINDS),
  /** A path within the run's evidence plane. Never the content itself. */
  path: z.string(),
  description: z.string(),
});

export type EvidencePointer = z.infer<typeof EvidencePointerSchema>;

/** A decision carried on the control plane; the ledger's unit (CAP-18). */
export const DecisionRecordSchema = z.object({
  question: z.string(),
  answer: z.string(),
  rationale: z.string(),
});

export type DecisionRecord = z.infer<typeof DecisionRecordSchema>;

/**
 * AD-24 — three ceilings and no currency dimension.
 *
 * The bounds are refinements rather than JSON Schema keywords: `minimum` and integer bounds are
 * outside the structured-outputs subset, while a refinement emits nothing and still holds at parse
 * time, which is where AD-1 re-validates a step's output. The subset guard confirms the export stays
 * clean.
 */
export const BudgetSchema = z
  .object({
    steps_remaining: z.number(),
    wall_clock_ms_remaining: z.number(),
    /** Consumed share of the rate-limit budget, 0 to 1. Never a currency amount. */
    rate_limit_budget_consumed: z.number(),
  })
  .refine((budget) => Number.isInteger(budget.steps_remaining) && budget.steps_remaining >= 0, {
    message: 'steps_remaining must be a non-negative whole number of steps',
    path: ['steps_remaining'],
  })
  .refine((budget) => budget.wall_clock_ms_remaining >= 0, {
    message: 'wall_clock_ms_remaining must not be negative',
    path: ['wall_clock_ms_remaining'],
  })
  .refine(
    (budget) =>
      budget.rate_limit_budget_consumed >= 0 && budget.rate_limit_budget_consumed <= 1,
    {
      message: 'rate_limit_budget_consumed is a share of the budget and must lie between 0 and 1',
      path: ['rate_limit_budget_consumed'],
    },
  );

export type Budget = z.infer<typeof BudgetSchema>;

/** AD-12 / architecture.md — the blast-radius class that decides an action's gate. */
export const REVERSIBILITY_CLASSES = ['reversible', 'recoverable', 'irreversible'] as const;

export type ReversibilityClass = (typeof REVERSIBILITY_CLASSES)[number];

/** AD-15 — the enumerated write surface. An agent declares an intent; only the engine executes it. */
export const WRITE_INTENT_KINDS = [
  'git_push',
  'pull_request',
  'git_note',
  'git_tag',
  'domain_mutation',
] as const;

export type WriteIntentKind = (typeof WRITE_INTENT_KINDS)[number];

/**
 * One declared write, in the only shape the engine executes one from.
 *
 * **A force-push is inexpressible here, and that is the design rather than an omission.** ADR-001 states
 * flatly that "force-push is never permitted". The weaker way to hold that is a `force` field the
 * executor is trusted to ignore — which leaves the refusal in a unit nobody reads while the artifact goes
 * on saying a force was asked for. This shape has no boolean at all: `kind` is a closed vocabulary,
 * `target` names *what* is written and `summary` says why, and there is nowhere to put a flag that
 * changes how. It is the same choice story 2-6 made for the command runner, where an arbitrary command is
 * structurally impossible rather than rejected, and `tests/contracts.committing.test.ts` holds the field
 * list to exactly these five so a later story cannot add one back without a test failing.
 *
 * **Strict, so an extra key is refused rather than stripped.** The draft-7 export already carries
 * `additionalProperties: false`, so `claude -p` refuses an intent carrying a sixth field — but the Zod
 * re-parse AD-1 performs on the way back in *stripped* it silently, and the two halves of one contract
 * disagreed on exactly the field this shape exists not to have. An intent carrying `force: true` is now
 * refused by both.
 */
export const WriteIntentSchema = z
  .object({
    /** Combined with the run id, this is the AD-15 idempotency key. */
    intent_id: z
      .string()
      .describe(
        'This intent’s id. With the run id it is AD-15’s idempotency key, which is how the ' +
          'executor recognises a re-run of the same step as a repeat rather than as a second write, so ' +
          'it is derived from what the intent is and never from a clock, a counter or randomness.',
      ),
    kind: z
      .enum(WRITE_INTENT_KINDS)
      .describe('Which member of AD-15’s enumerated write surface this is.'),
    target: z
      .string()
      .describe(
        'What is written: the branch for a push, the branch a pull request is opened from, the single ' +
          'named ref for a note. Never blank.',
      ),
    summary: z
      .string()
      .describe('What this write does and why, in one line that stands alone. Never blank.'),
    reversibility: z
      .enum(REVERSIBILITY_CLASSES)
      .describe('The blast-radius class that decides which gate this write stops at (AD-12).'),
  })
  .strict();

export type WriteIntent = z.infer<typeof WriteIntentSchema>;

/**
 * What one deterministic gate did, as the **engine** recorded it (CAP-13's first tier).
 *
 * This shape is on the step *input* because the engine runs the gates before it spawns anything, and
 * a step that had to discover the outcomes for itself would have to run every one of them again —
 * doubling the container time the economics exist to save, and inviting it to report facts it never
 * observed. `step.verification`'s own `gates` field is the model's *report* of these, checked back
 * against them; this is the record it copies from.
 *
 * `command` is a plain string rather than an enum, because this file is written by the engine and
 * read by a step: the profile's vocabulary lives in `src/contracts/installer.ts`, which imports this
 * module, so naming the enum here would be a cycle. The names that appear are `typecheck`, `lint`
 * and `test`, which is what `DETERMINISTIC_GATE_NAMES` declares.
 */
export const GATE_RESULTS = ['passed', 'failed', 'skipped'] as const;

export type GateResult = (typeof GATE_RESULTS)[number];

export const GateOutcomeSchema = z.object({
  command: z
    .string()
    .describe('Which gate this is: one of typecheck, lint or test, the gates CAP-13 names.'),
  declared: z
    .string()
    .describe(
      'The command line the profile declares for this gate, verbatim. Empty when it declares none.',
    ),
  outcome: z
    .enum(GATE_RESULTS)
    .describe(
      'What the gate did: "passed" for an exit status of zero, "failed" for anything else, ' +
        '"skipped" when the profile declares no command and nothing ran.',
    ),
  exit_status: z
    .number()
    .nullable()
    .describe(
      'The exit status the command returned, or null when nothing ran to have one — a skipped gate, ' +
        'or one the runtime could not get a status from because it timed out or was signalled.',
    ),
  evidence: z
    .string()
    .describe(
      'Where this gate\u2019s output was written, relative to the run directory (AD-23). The output ' +
        'itself never enters the control plane. Empty for a gate that ran nothing.',
    ),
});

export type GateOutcome = z.infer<typeof GateOutcomeSchema>;

/**
 * The typed input file a step reads. Written by the engine, on disk, so it carries
 * `schema_version` per AD-28.
 *
 * `request` is the original feature request verbatim — never a summary of a summary — because
 * every agent re-grounds on it.
 */
export const StepInputSchema = versioned({
  /** The registered contract id this step's output is validated against (AD-17). */
  contract_id: z.string(),
  run: z.string(),
  feature: z.string(),
  step: z.string(),
  mode: z.enum(RUN_MODES),
  /** AD-26 — the commit a re-run resets the worktree to before this step begins again. */
  baseline_ref: z.string(),
  /** The user's original words, verbatim. */
  request: z.string(),
  acceptance_criteria: z.array(z.string()),
  /** Ledger answers already given, so the step does not ask again (CAP-18, Q7). */
  decisions: z.array(DecisionRecordSchema),
  /** Pointers into the evidence plane the step may read on demand (AD-23). */
  evidence: z.array(EvidencePointerSchema),
  /**
   * What the deterministic gates did before this step was spawned, or an empty list.
   *
   * Empty for every phase but `verification`, and for a verification step whose run declares no gate
   * command at all. It is never a step's job to fill this in: the engine ran them, the engine knows
   * what they returned, and a step that re-derived them would be reporting something it had to spend
   * a container to find out twice.
   */
  gates: z.array(GateOutcomeSchema),
  budget: BudgetSchema,
  created_at: TimestampSchema,
});

export type StepInput = z.infer<typeof StepInputSchema>;

/**
 * The typed output a step produces. This is the contract handed to
 * `claude -p --json-schema`, and the same schema the engine re-parses `structured_output` against
 * before accepting the result (AD-1).
 *
 * It deliberately carries no `schema_version`: it is the model-facing contract, not the on-disk
 * artifact. The versioned wrapper the recorder writes around it belongs to the runtime recorder.
 */
export const StepOutputSchema = z.object({
  contract_id: z.string(),
  step: z.string(),
  status: z.enum(STEP_STATUSES),
  /** One line that stands alone (interface-contract R3). */
  summary: z.string(),
  /** Every claim carries the step that produced it. */
  provenance: z.array(z.string()),
  decisions: z.array(DecisionRecordSchema),
  /** Evidence the step wrote, referenced by pointer, never inlined (AD-23). */
  artifacts: z.array(EvidencePointerSchema),
  /** Questions raised, for compression by the Interviewer before any reaches the user (CAP-3). */
  questions: z.array(QuestionDraftSchema),
  /** Declared, never performed: the engine executes the write surface (AD-15). */
  write_intents: z.array(WriteIntentSchema),
  /** Present when `status` is `failed` or `blocked`; dispositioned per AD-35. */
  error: OrchErrorSchema.nullable(),
});

export type StepOutput = z.infer<typeof StepOutputSchema>;
