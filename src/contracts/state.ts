/**
 * AD-4 / AD-7 — the `state.json` checkpoint, as an on-disk contract.
 *
 * `events.jsonl` is the sole durable truth and this file is a checkpoint *derived* from it. Where
 * the two disagree the log wins and the checkpoint is discarded and rebuilt, so nothing here may be
 * the only home of a fact: every run-state field below is reconstructable by folding the log
 * (`src/engine/rebuild.ts`), and the declared-configuration fields come from the feature's plan.
 *
 * Only the reconciler writes this file (Consistency Conventions), and every write is atomic — a
 * temporary file in the same directory, then rename — so a reader sees either the previous
 * checkpoint or the new one and never a partial. It carries `schema_version` per AD-28, so a version
 * this build does not recognise is refused rather than silently upgraded.
 *
 * Zod rules that bind this module, carried forward from stories 1-1 and 1-2: no `z.int()` (it
 * exports safe-integer bounds), no `z.date()` (it cannot be exported at all), and refinements emit
 * no JSON Schema keywords, so a bound expressed as one stays out of the draft-7 export. This is an
 * `artifact`-kind contract, so the structured-outputs subset guard does not bind it — but the
 * registry's artifact sweep does, and it asserts the `schema_version` field is present.
 */
import { z } from 'zod';

import { TimestampSchema } from './event.js';
import { OrchErrorSchema } from './error.js';
import { versioned } from './schema-version.js';
import { RUN_MODES, STEP_DISPOSITIONS } from './step.js';

/** The registry id this artifact is registered under (AD-17), spelled once. */
export const RUN_STATE_CONTRACT_ID = 'run.state';

/** The file name of the checkpoint inside a run directory. */
export const RUN_STATE_FILE_NAME = 'state.json';

/**
 * The feature state lifecycle, exactly as the spine's state diagram records it in the checkpoint.
 *
 * `degraded` and `hibernated` are declared here because the lifecycle has them, but nothing enters
 * them until AD-24's ceilings arrive in story 2-9: a state the enum omitted would be a contract
 * change then, and a state the reconciler never writes is not.
 */
export const FEATURE_STATES = [
  'drafting',
  'confirmed',
  'running',
  'blocked',
  'degraded',
  'interrupted',
  'verifying',
  'committed',
  'hibernated',
  'killed',
  'handed_off',
] as const;

export type FeatureState = (typeof FEATURE_STATES)[number];

export const FeatureStateSchema = z.enum(FEATURE_STATES);

/**
 * The four states the diagram draws an arrow to `[*]` from.
 *
 * AD-32 hangs on this list: a resource whose run holds a terminal state is reclaimed on the next
 * reconcile pass, and nothing is reclaimed while its run holds a non-terminal one.
 */
export const TERMINAL_FEATURE_STATES: readonly FeatureState[] = [
  'committed',
  'hibernated',
  'killed',
  'handed_off',
];

export const isTerminalFeatureState = (state: FeatureState): boolean =>
  TERMINAL_FEATURE_STATES.includes(state);

/**
 * Which phase of the pipeline a step belongs to. CAP-13 runs deterministic gates after the
 * implementation steps, and the lifecycle's `running` → `verifying` → `committed` path is exactly
 * the boundary between the two.
 *
 * **The names are the agent ids, deliberately, and this is an enum widening AD-28 covers.** `analysis`
 * and `planning` arrived in story 2-4; the roster's six built-ins and ADR-003's grant table use the same
 * six words, so a phase is the key a spawn resolves its AD-17 grant by and re-encoding the pair would
 * give the engine a mapping to get wrong. Widening an enum on an artifact the engine writes is
 * `schema_version`-relevant: a `state.json` written by a build that knows a phase this one does not is
 * refused by `parseVersionedArtifact` with `config.schema_version_unrecognised` — the version is checked
 * before the shape, so the refusal names the artifact and the installer rather than surfacing as a Zod
 * issue about an enum. Every *reader* of this list derives from it rather than spelling its members,
 * which is what makes adding one a one-line change (`src/tui/projection.ts` was the one that did not).
 */
export const STEP_PHASES = [
  'analysis',
  'planning',
  'implementation',
  'verification',
] as const;

export type StepPhase = (typeof STEP_PHASES)[number];

/**
 * The model ladder of the Stack table: a starting tier and a promotion policy, never a fixed
 * assignment (AD-17). One promotion per step per run, on a failed verification gate or a second
 * schema-invalid output.
 */
export const MODEL_RUNGS = ['claude-haiku-4-5', 'claude-sonnet-5', 'claude-opus-5'] as const;

export type ModelRung = (typeof MODEL_RUNGS)[number];

export const ModelRungSchema = z.enum(MODEL_RUNGS);

/** AD-1 / Stack — one promotion per step per run. */
export const MAX_PROMOTIONS_PER_STEP = 1;

/**
 * The rung above this one, or `null` at the top of the ladder — and `null` for a rung this build does
 * not know.
 *
 * The unknown case is guarded explicitly because `indexOf` answers `-1`, and `MODEL_RUNGS[-1 + 1]` is
 * the *lowest* rung: an unrecognised tier would look like a valid promotion target and the ladder would
 * run backwards. A rung this build cannot place is not a rung it can promote from.
 */
export const nextModelRung = (rung: ModelRung): ModelRung | null => {
  const position = MODEL_RUNGS.indexOf(rung);
  return position < 0 ? null : (MODEL_RUNGS[position + 1] ?? null);
};

/**
 * A non-negative whole count. Spelled as a refinement rather than `z.int().min(0)` so the draft-7
 * export carries no `minimum` or safe-integer bounds, which keeps this module's habits identical to
 * the step contracts' even though the subset does not bind an artifact.
 */
const countField = z
  .number()
  .refine((value) => Number.isInteger(value) && value >= 0, {
    message: 'must be a non-negative whole number',
  });

/**
 * One step of a run, as the checkpoint records it.
 *
 * Every field is either folded from the event log or taken from the feature's declared plan. The
 * three that carry AD-8 and AD-26 are load-bearing:
 *
 * - `disposition` is `null` only while the step is in flight. A step found in that state after a
 *   restart was interrupted by the crash, and the reconciler adopts it as `interrupted`.
 * - `session_id` is the `claude` session id, recorded as soon as the subprocess reports it, and is
 *   what a resume is attempted by. Only an `interrupted` disposition is resumable.
 * - `baseline_ref` is the exact commit the run worktree stood at when the step began, and a re-run
 *   resets to it first, which is what makes a step re-runnable any number of times with identical
 *   effect.
 */
export const StepRecordSchema = z.object({
  /** A stable declared name, never a positional index (Consistency Conventions). */
  step: z.string(),
  phase: z.enum(STEP_PHASES),
  /** The registered contract id this step's output is validated against (AD-17). */
  contract_id: z.string(),
  /** `null` while in flight; every termination records one (AD-8). */
  disposition: z.enum(STEP_DISPOSITIONS).nullable(),
  /** The `claude` session id a resume is attempted by, or `null` (AD-8). */
  session_id: z.string().nullable(),
  /** AD-26 — the commit a re-run resets the worktree to before this step begins again. */
  baseline_ref: z.string(),
  model_tier: ModelRungSchema,
  /** Promotions already spent on this step in this run; at most {@link MAX_PROMOTIONS_PER_STEP}. */
  promotions: countField,
  /**
   * How many times the step has been handed to the executor: every start, every re-run, and every
   * resume by session id. It is what the engine's one attempt bound counts, so it covers every
   * disposition that returns to the same step rather than only the ones that report a failure.
   */
  attempts: countField,
  /**
   * Attempts a person's approval has credited back, so the bound counts *unauthorised* engagements.
   *
   * CAP-12 — approving a gate a step blocked at is an explicit instruction to continue, and the fold
   * turns it into an `interrupted` step, which is a disposition that returns to the same step. Without
   * this, a step sitting at the attempt bound when a person approved it handed off immediately rather
   * than running the attempt they had just authorised: the bound refusing the person it exists to
   * protect. On an approval this takes the value of `attempts`, so the difference between the two is
   * zero and the step gets the full allowance again.
   *
   * Separate from `attempts` rather than resetting it, because `attempts` is a total the hand-off
   * document quotes to a person ("failed on all N attempts") and a counter that silently restarts is a
   * number that lies. The bound is a bound on unattended looping, and every credit here costs a human
   * gesture, so it cannot itself become a loop.
   */
  credited_attempts: countField,
  /** How many times the worktree was reset to `baseline_ref` for this step. */
  resets: countField,
  started_at: TimestampSchema.nullable(),
  terminated_at: TimestampSchema.nullable(),
  /** The error the termination reported, dispositioned per AD-35. */
  error: OrchErrorSchema.nullable(),
});

export type StepRecord = z.infer<typeof StepRecordSchema>;

/** CAP-23 — what a hand-off recorded, so a stuck run explains itself rather than thrashing. */
export const HandoffSchema = z.object({
  /** The error code that routed here, or the disposition that did. */
  code: z.string(),
  reason: z.string(),
  /** The step the hand-off happened at, or `null` for a run-level hand-off. */
  step: z.string().nullable(),
  recorded_at: TimestampSchema,
});

export type Handoff = z.infer<typeof HandoffSchema>;

/**
 * `runs/<run-id>/state.json`.
 *
 * `last_event_seq` is the hinge of AD-4: it names the log position this checkpoint was folded from,
 * so a checkpoint claiming a position the log does not reach, or lagging one it does, is detectable
 * without trusting the checkpoint's own account of the run. Comparison and the discard-and-rebuild
 * decision live in `src/engine/rebuild.ts`.
 */
export const RunStateSchema = versioned({
  /** The run id: a ULID minted solely by the engine (AD-29). */
  run: z.string(),
  /** The feature slug, kebab-case (Consistency Conventions). */
  feature: z.string(),
  /** AD-27 — a shadow run is an ordinary run carrying a mode flag. */
  mode: z.enum(RUN_MODES),
  state: FeatureStateSchema,
  /**
   * The declared file territory this feature claims. Reconciliation is concurrent across features
   * but serialises any two whose territories overlap (Consistency Conventions).
   */
  territory: z.array(z.string()),
  /** The run's steps in the order they were first started. */
  steps: z.array(StepRecordSchema),
  /** The `seq` of the last log line folded into this checkpoint; 0 before any line exists. */
  last_event_seq: countField,
  created_at: TimestampSchema,
  updated_at: TimestampSchema,
  handoff: HandoffSchema.nullable(),
}).refine(
  (state) => new Set(state.steps.map((step) => step.step)).size === state.steps.length,
  {
    message: 'a step id appears at most once in a run, because a re-run updates its record (AD-26)',
    path: ['steps'],
  },
);

export type RunState = z.infer<typeof RunStateSchema>;

/** Look a step's record up by id. `null` rather than `undefined`, so a miss is a decision. */
export const findStepRecord = (state: RunState, step: string): StepRecord | null =>
  state.steps.find((record) => record.step === step) ?? null;

/**
 * The step in flight, if any: the one record carrying no disposition.
 *
 * A checkpoint read after a crash names the step the engine was killed inside, which is what lets
 * the reconciler adopt it as `interrupted` rather than guess.
 */
export const inFlightStep = (state: RunState): StepRecord | null =>
  state.steps.find((record) => record.disposition === null) ?? null;

/**
 * The lifecycle-significant identity of a run state.
 *
 * "Killing the engine at any instant and restarting must produce identical behaviour to never having
 * stopped" (AD-7) is a claim about the state the run converges on, not about counters: an
 * interrupted run resumes, so it legitimately records one more attempt and one more reset than an
 * uninterrupted one. This renders the part that must match — the feature state and every step's
 * disposition in order — so the crash-injection suite compares the property AD-7 states rather than
 * a byte image that would fail for the wrong reason.
 */
export const featureStateFingerprint = (state: RunState): string =>
  [
    state.state,
    ...state.steps.map((record) => `${record.step}:${record.disposition ?? 'in-flight'}`),
  ].join('|');
