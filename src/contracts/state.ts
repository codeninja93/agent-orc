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
import { REVERSIBILITY_CLASSES, RUN_MODES, STEP_DISPOSITIONS, WRITE_INTENT_KINDS } from './step.js';

/** The registry id this artifact is registered under (AD-17), spelled once. */
export const RUN_STATE_CONTRACT_ID = 'run.state';

/** The file name of the checkpoint inside a run directory. */
export const RUN_STATE_FILE_NAME = 'state.json';

/**
 * The feature state lifecycle, exactly as the spine's state diagram records it in the checkpoint.
 *
 * `degraded` and `hibernated` were declared here before anything entered them, so story 2-9's ceilings
 * arrived as behaviour rather than as a contract change. `src/engine/ceilings.ts` is what enters them:
 * `degraded` at eighty percent of any ceiling, `hibernated` on reaching one.
 */
export const FEATURE_STATES = [
  'drafting',
  'confirmed',
  'running',
  'blocked',
  'degraded',
  'interrupted',
  'verifying',
  /**
   * Story 2-11 — between the write-executor's `git_push`/`pull_request` intents landing and the AD-22
   * note being written. Non-terminal: AD-32 reclaims a run's resources on reaching a terminal state, and
   * the note's own commit (the merge commit) does not exist until a human merges the pull request, so
   * `committed` cannot mean "pushed and opened" without the worktree being reclaimed out from under it.
   * `PERSON_WAITING_STATES` in `src/engine/ceilings.ts` excludes this wait from the wall-clock ceiling,
   * the same way `drafting`/`blocked` already are: this is the run waiting on a person, not spending.
   */
  'awaiting_merge',
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
 * Which phase of the pipeline a step belongs to.
 *
 * Four of them, in the order a run meets them: a feature is analysed, planned, implemented and then
 * verified. CAP-13 runs the deterministic gates in the last of those, and the lifecycle's `running` →
 * `verifying` → `committed` path is the boundary between `verification` and everything before it — not, as
 * this comment said while the enum held two members, a boundary between two halves.
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
  // Story 2-6. `testing` was a declared agent with no phase, so nothing could spawn it: the roster
  // offered it, the installer wrote its TOML, and the one word that lets a step be planned for it was
  // missing — a member of the built-in roster that could never run. The list is in the order the
  // standard plan runs them, which is also the order a person reads a run in.
  'testing',
  'verification',
  // Story 2-7, and the same gap one phase later: `committing` was a declared agent with no phase, so
  // nothing could spawn it — the roster offered it and ADR-003 fixed its grant, while the one word that
  // lets a step be planned for it was missing. It is last because AD-22 has the committer write the note
  // on the merge commit, which is the end of the run and nothing else's input.
  'committing',
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

/**
 * True when a string is a rung this build can place on the ladder.
 *
 * Beside {@link MODEL_RUNGS} rather than at a caller, because the question "is this a rung" and the
 * list of rungs must be one fact: a reader that answers it for itself is the second authority whose
 * disagreement with {@link nextModelRung} lets an unplaceable rung be treated as the lowest.
 */
export const isModelRung = (value: string): value is ModelRung =>
  (MODEL_RUNGS as readonly string[]).includes(value);

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
 * AD-24's three ceilings, by name — step count, wall clock, consumed rate-limit budget — and no fourth.
 *
 * There is no currency member and there never may be: AD-24 says "no currency dimension" and R10 says cost
 * is subscription usage. The list is the vocabulary a `budget.degraded` line names its trigger in, so a
 * dimension a later build adds is one this build folds as `null` rather than refuses (AD-5).
 */
export const CEILING_DIMENSIONS = ['steps', 'wall_clock', 'rate_limit_budget'] as const;

export type CeilingDimension = (typeof CEILING_DIMENSIONS)[number];

/**
 * AD-24 — that the run degraded, when, and on which ceiling first. Folded from the first `budget.degraded`.
 *
 * **Why this is a field and not a `FeatureState`.** `degraded` *is* a feature state, and the run enters it.
 * But story 2-9 makes degradation a standing condition — once a run crosses eighty percent of any ceiling it
 * stays degraded for the rest of its life, so the person reading `budget.degraded` gets one honest signal
 * rather than a flapping one — and the feature state is one slot that `blocked` and `interrupted` overwrite
 * on their way through. A degraded run that is interrupted and resumed must come back *degraded*, not
 * `running`, and the only way the loop can know that from the checkpoint alone (AD-7) is a fact the state
 * slot cannot erase. This is that fact; the state slot says where the run is right now.
 *
 * Nothing clears it. There is no event that un-degrades a run, deliberately, and the fold keeps the *first*
 * line's values so a later ceiling crossing eighty percent changes nothing here either.
 */
export const DegradationSchema = z.object({
  dimension: z
    .enum(CEILING_DIMENSIONS)
    .nullable()
    .describe(
      'The ceiling that crossed eighty percent first. Null when the line named a dimension this build ' +
        'does not know: the run is still degraded, which is the fact that matters (AD-5).',
    ),
  recorded_at: TimestampSchema.describe('When the first budget.degraded line was recorded.'),
});

export type Degradation = z.infer<typeof DegradationSchema>;

/**
 * Story 4-1 — AD-12's reversibility gate, standing until a person answers it.
 *
 * **Parallel to {@link HandoffSchema}, never a repurposing of it, and never a step disposition either.**
 * `settlePreMergeWrites` (`src/engine/reconciler.ts`) checks a composed commit's declared `reversibility`
 * against the project's `gated_reversibility_classes` *after* the committing step has already completed
 * — so nothing about any step failed, and folding this into a synthetic `blocked` step disposition would
 * corrupt AD-8's termination record for a failure that never happened. This is its own fact instead: the
 * gated write's identity, so `decideSteering`'s `approve`/`reject` cases (`src/engine/steering.ts`) know
 * there is a gate to resolve without asking `blockedStepOf`'s question — "which step failed" — of a run
 * where none did.
 *
 * **`resolution` is what changes; the record itself is never nulled by a resolving event — round-1
 * review's most serious finding.** The first version cleared this whole record to `null` directly on
 * `write.gate_approved`/`write.gate_rejected`, which races the *separate* `feature.state_changed` line the
 * same effect also emits (to `running`/`degraded` for an approval, `handed_off` for a rejection): a crash
 * landing the resolving event durably but not the state-change one left `pending_gate` reading `null`
 * while `state.state` was still `blocked`. For a rejection that is not merely untidy — a later, redelivered
 * `Command.Approve` would find no gate on record, fall through to the pre-existing step-failure branch
 * (which finds no blocked step and answers `toState: 'running'` unconditionally), and silently reverse a
 * person's explicit rejection of an irreversible write. So `write.gate_approved`/`write.gate_rejected` set
 * `resolution` on *this same* record instead; only the `feature.state_changed` line that follows — once it
 * actually lands — clears the whole record to `null`. A crash in between therefore leaves a fully truthful
 * intermediate fold: "this gate was rejected, and the run hasn't finished handing off yet."
 */
export const PENDING_GATE_RESOLUTIONS = ['pending', 'approved', 'rejected'] as const;

export type PendingGateResolution = (typeof PENDING_GATE_RESOLUTIONS)[number];

/**
 * One intent still unsettled when the gate opened — the disclosure round-1 review added.
 *
 * `settlePreMergeWrites`'s own settlement loop has no gate check inside it: once the one gate on a
 * composed commit clears, every remaining intent runs in the same pass. The first version's disclosure
 * named only the intent whose `reversibility` triggered the check, which understated what a person's one
 * approval actually authorises. `kind`, not `target`, because this is the *persisted* identity a later
 * fold reads back to know which writes this gate covers — the richer disclosure (`target` included) lives
 * on the `write.gate_opened` event payload itself, read once, at the moment a person needs to see it.
 */
export const PendingGateBatchEntrySchema = z.object({
  intent_id: z.string(),
  kind: z.enum(WRITE_INTENT_KINDS),
});

export type PendingGateBatchEntry = z.infer<typeof PendingGateBatchEntrySchema>;

export const PendingGateSchema = z.object({
  /** The committing step this write's intent belongs to. Never a step that "failed": none did. */
  step: z.string(),
  /** The AD-15 idempotency key of the intent whose `reversibility` triggered this gate. */
  intent_id: z.string(),
  kind: z.enum(WRITE_INTENT_KINDS),
  /** Always one of the project's own `gated_reversibility_classes` — that is why this gate exists at all. */
  reversibility: z.enum(REVERSIBILITY_CLASSES),
  /** Every intent still unsettled when this gate opened, `intent_id` included — the whole remaining batch. */
  batch: z.array(PendingGateBatchEntrySchema),
  resolution: z.enum(PENDING_GATE_RESOLUTIONS),
});

export type PendingGate = z.infer<typeof PendingGateSchema>;

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
  /**
   * AD-24 — the standing degradation, or `null` for a run that has never crossed eighty percent.
   *
   * Defaulted to `null` on the way in rather than required, so a `state.json` written before story 2-9 still
   * parses as the checkpoint it is; the log then decides, as it always does (AD-4) — a run whose log carries
   * `budget.degraded` disagrees with such a checkpoint and the checkpoint is rebuilt.
   */
  degradation: DegradationSchema.nullable().default(null),
  /**
   * Story 4-1 — the standing AD-12 gate, or `null` for a run with none open.
   *
   * Defaulted to `null` on the way in, exactly as `degradation` is and for the same reason: a
   * `state.json` written before this story still parses as the checkpoint it is, and the log then
   * decides, as it always does (AD-4) — a run whose log carries `write.gate_opened` disagrees with such
   * a checkpoint and the checkpoint is rebuilt.
   */
  pending_gate: PendingGateSchema.nullable().default(null),
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
