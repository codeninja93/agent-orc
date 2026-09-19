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

export const WriteIntentSchema = z.object({
  /** Combined with the run id, this is the AD-15 idempotency key. */
  intent_id: z.string(),
  kind: z.enum(WRITE_INTENT_KINDS),
  target: z.string(),
  summary: z.string(),
  reversibility: z.enum(REVERSIBILITY_CLASSES),
});

export type WriteIntent = z.infer<typeof WriteIntentSchema>;

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
