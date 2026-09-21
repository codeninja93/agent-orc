/**
 * AD-4 — `events.jsonl` is the sole durable truth and `state.json` is a checkpoint derived from it.
 * Where they disagree the log wins and the checkpoint is discarded and rebuilt.
 *
 * This module is that fold, and the comparison that decides a disagreement. The fold is a pure
 * function of the log: it opens no file, so the same events always produce the same checkpoint, and a
 * test can drive it with a handful of envelopes instead of a run.
 *
 * Two rules shape the fold and are worth stating before the code:
 *
 * **An unknown event type is ignored, never an error** (AD-5). Adding an event type is never a
 * breaking change, so a log written by a later build folds here without refusing the run.
 *
 * **Identifiers arrive in envelope fields, never in payloads.** Story 1-2's redaction pass replaces an
 * unbroken ULID or commit SHA wherever it appears, so the run id reaches the fold as the envelope's
 * `run`, the baseline ref as the envelope's `baseline_ref` and the session id as the envelope's
 * `session_id` — all three on the verbatim allow-list. A payload carries only short, punctuated,
 * low-entropy values: an enum member, a dotted contract id, a small count, a run-relative path.
 */
import {
  CURRENT_SCHEMA_VERSION,
  FEATURE_STATES,
  MODEL_RUNGS,
  OrchErrorSchema,
  RUN_MODES,
  STEP_DISPOSITIONS,
  STEP_PHASES,
  formatTimestamp,
} from '../contracts/index.js';
import type {
  EventEnvelope,
  FeatureState,
  Handoff,
  ModelRung,
  OrchError,
  RunMode,
  RunState,
  StepDisposition,
  StepPhase,
  StepRecord,
} from '../contracts/index.js';

import { COMMAND_EVENT_TYPES } from './commands.js';

/** The emitter name every event the reconciler originates carries. */
export const ENGINE_EMITTER = 'engine.reconciler';

/**
 * The engine's event vocabulary. Dot-namespaced and past-tense, per the Consistency Conventions.
 *
 * `step.started` is already in the contracts' declared list; the rest are types this story adds. AD-5
 * makes that safe without a contracts change — a reader ignores a type it does not know, so adding
 * one is never breaking — and it keeps the engine's internal vocabulary out of the shared enum that
 * both renderers and every tool server compile against.
 */
export const ENGINE_EVENT_TYPES = {
  /** A run id was minted and the feature entered `drafting` (AD-29). */
  RunCreated: 'run.created',
  /** A lifecycle transition, carrying the state left and the state entered. */
  FeatureStateChanged: 'feature.state_changed',
  /** A step began; the envelope carries the AD-26 `baseline_ref` it began at. */
  StepStarted: 'step.started',
  /** The subprocess reported its session id, which is what a resume is attempted by (AD-8). */
  StepSessionRecorded: 'step.session_recorded',
  /** A step ended, carrying its disposition. Every termination records one (AD-8). */
  StepTerminated: 'step.terminated',
  /** A resume by recorded session id was attempted (AD-8). */
  StepResumeAttempted: 'step.resume_attempted',
  /** The executor rejected the resume, so the recorded session id is spent (AD-8). */
  StepResumeRefused: 'step.resume_refused',
  /** The worktree was reset to a step's `baseline_ref` before a re-run (AD-26). */
  StepBaselineReset: 'step.baseline_reset',
  /** One model-ladder promotion was spent on a step (Stack: one per step per run). */
  StepTierPromoted: 'step.tier_promoted',
  /**
   * A person approved the gate a step blocked at (CAP-12), so the step may continue.
   *
   * The fold turns it into an `interrupted` step with no session id and no error, which is what makes
   * "blocked → running: approval taken" a continuation rather than a second escalation: the next
   * routing reaches AD-26's reset-and-re-run on its own, and the error that caused the block no longer
   * stands to be re-escalated.
   */
  StepApproved: 'step.approved',
  /** A run stopped and explained itself rather than thrashing (CAP-23, AD-35). */
  HandoffRecorded: 'handoff.recorded',
} as const;

export type EngineEventType = (typeof ENGINE_EVENT_TYPES)[keyof typeof ENGINE_EVENT_TYPES];

/**
 * Every type the fold acts on. A type outside this set is ignored, per AD-5.
 *
 * `step.resume_attempted` is folded for exactly one fact: the attempt count. It still changes no
 * lifecycle state — the *outcome* is what a termination or the `step.resume_refused` that spends the
 * session id records — but a resume is a hand of the step to the executor, and the attempt bound is a
 * bound on those. Leaving it out is what made the bound miss AD-8's resume path: a step interrupted and
 * resumed for ever recorded one attempt and looped. The constant is enumerated rather than taken from
 * `ENGINE_EVENT_TYPES` so it cannot claim to fold a type the switch below has no case for.
 */
export const FOLDED_EVENT_TYPES: readonly string[] = Object.freeze([
  ENGINE_EVENT_TYPES.RunCreated,
  ENGINE_EVENT_TYPES.FeatureStateChanged,
  ENGINE_EVENT_TYPES.StepStarted,
  ENGINE_EVENT_TYPES.StepSessionRecorded,
  ENGINE_EVENT_TYPES.StepTerminated,
  ENGINE_EVENT_TYPES.StepApproved,
  ENGINE_EVENT_TYPES.StepResumeAttempted,
  ENGINE_EVENT_TYPES.StepResumeRefused,
  ENGINE_EVENT_TYPES.StepBaselineReset,
  ENGINE_EVENT_TYPES.StepTierPromoted,
  ENGINE_EVENT_TYPES.HandoffRecorded,
  /**
   * AD-19's ledger entry *and* the effect it records, in one line.
   *
   * It is folded here rather than in a module of its own because it is the mechanism that makes
   * at-least-once delivery safe: the fold keys on the `intent_id` it carries and ignores an id it has
   * already seen, so a redelivered intent — or a duplicated line — has the effect exactly once.
   */
  COMMAND_EVENT_TYPES.Applied,
]);

/** One step of a feature's declared plan: a stable name, its contract, and which phase it is in. */
export interface PlanStep {
  /** A stable declared name, never a positional index (Consistency Conventions). */
  readonly step: string;
  /** The registered contract id the step's output is validated against (AD-17). */
  readonly contract_id: string;
  readonly phase: StepPhase;
}

/**
 * A feature's declared configuration: everything about a run that is *not* run state.
 *
 * It is supplied to the engine rather than folded from the log, and the division is deliberate. The
 * log records what *happened*; the plan records what was *declared*. Declared configuration has a home of
 * its own (AD-9's per-run config snapshot), and this is its in-memory shape until story 1-7 sources it from
 * the interview.
 *
 * **Story 1-11 records the declaration in the log as well, and that is not a second authority.** A live pass
 * still reads the plan; `spec.recorded` and `feature.territory_declared` exist so a *replay* can reconstruct
 * what a run was built against and why two features were serialised, which AD-4 requires of everything the
 * log is the truth about. The caveat this comment used to give as a reason not to do it is real and is
 * handled by the reader rather than avoided: a repository path long enough with no dot and no hyphen is one
 * unbroken high-entropy run and the AD-21 pass replaces it, so `territoryFromEvents` counts the entries it
 * could not read and treats an incomplete territory as colliding with everything — a feature serialised
 * unnecessarily at worst, never one admitted wrongly.
 */
export interface FeaturePlan {
  /** The feature slug, kebab-case. */
  readonly feature: string;
  /** AD-27 — `shadow` is an ordinary run carrying a mode flag. */
  readonly mode: RunMode;
  /** The declared file territory. Overlap between two features serialises them. */
  readonly territory: readonly string[];
  /** The ordered steps: the implementation phase, then the verification phase. */
  readonly steps: readonly PlanStep[];
  /** The user's original words, verbatim, for the step input file. */
  readonly request: string;
  readonly acceptance_criteria: readonly string[];
  /** The rung a step starts on; never a fixed assignment (AD-17). */
  readonly starting_model_tier: ModelRung;
  /** The worktree a step's baseline ref is taken in and reset against (AD-26). */
  readonly worktree: string;
}

const isOneOf = <T extends string>(members: readonly T[], value: unknown): value is T =>
  typeof value === 'string' && (members as readonly string[]).includes(value);

const payloadString = (event: EventEnvelope, key: string): string | null => {
  const value = event.payload[key];
  return typeof value === 'string' ? value : null;
};

const payloadError = (event: EventEnvelope, key: string): OrchError | null => {
  const value = event.payload[key];
  if (typeof value !== 'object' || value === null) return null;
  const parsed = OrchErrorSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
};

/** The envelope field, when it is a non-empty string. `null` covers absent, null and blank alike. */
const envelopeString = (event: EventEnvelope, key: 'baseline_ref' | 'session_id'): string | null => {
  const value = event[key];
  return typeof value === 'string' && value !== '' ? value : null;
};

export interface RebuildOptions {
  /** The run id, from the directory the log was read from — never from a payload. */
  readonly run: string;
  /** The declared configuration half of the checkpoint. */
  readonly plan: FeaturePlan;
  /** Injectable clock, used only when the log is empty and there is no event timestamp to adopt. */
  readonly now?: () => Date;
}

/** The empty checkpoint a run with no log lines folds to. */
export const emptyRunState = (options: RebuildOptions): RunState => {
  const at = formatTimestamp(options.now?.() ?? new Date());
  return {
    schema_version: CURRENT_SCHEMA_VERSION,
    run: options.run,
    feature: options.plan.feature,
    mode: options.plan.mode,
    state: 'drafting',
    territory: [...options.plan.territory],
    steps: [],
    last_event_seq: 0,
    created_at: at,
    updated_at: at,
    handoff: null,
  };
};

/**
 * Fold the event log into a checkpoint.
 *
 * The events are folded in `seq` order, which is the only ordering authority (AD-29): timestamps
 * carry none across processes, so the fold sorts by `seq` rather than trusting the file's order.
 */
export const rebuildFromLog = (
  events: readonly EventEnvelope[],
  options: RebuildOptions,
): RunState => {
  const ordered = [...events].sort((a, b) => a.seq - b.seq);
  const planByStep = new Map(options.plan.steps.map((step) => [step.step, step]));

  let state: FeatureState = 'drafting';
  let mode: RunMode = options.plan.mode;
  let handoff: Handoff | null = null;
  let createdAt: string | null = null;
  let updatedAt: string | null = null;
  let lastSeq = 0;

  /** Step records in first-started order, which is the order the checkpoint declares them in. */
  const steps = new Map<string, StepRecord>();

  /**
   * Intent ids whose effect this fold has already taken.
   *
   * AD-19's delivery is at-least-once, so the same intent can reach the log twice — a crash between
   * appending the effect and retiring the file leaves the file behind, and a renderer may legitimately
   * re-write one. The fold ignoring an id it has already seen is what turns that into one effect, and
   * it is why the ledger entry and the effect are the same line: neither can arrive without the other.
   */
  const appliedIntents = new Set<string>();

  const stepOf = (event: EventEnvelope): StepRecord | null => {
    const id = event.step;
    if (id === null) return null;
    return steps.get(id) ?? null;
  };

  for (const event of ordered) {
    lastSeq = event.seq;
    updatedAt = event.ts;
    createdAt ??= event.ts;

    switch (event.type) {
      case ENGINE_EVENT_TYPES.RunCreated: {
        createdAt = event.ts;
        const declared = payloadString(event, 'mode');
        if (isOneOf(RUN_MODES, declared)) mode = declared;
        state = 'drafting';
        break;
      }

      case ENGINE_EVENT_TYPES.FeatureStateChanged: {
        const to = payloadString(event, 'to');
        if (isOneOf(FEATURE_STATES, to)) state = to;
        break;
      }

      case ENGINE_EVENT_TYPES.StepStarted: {
        const id = event.step;
        if (id === null) break;
        const existing = steps.get(id);
        const declaredPhase = payloadString(event, 'phase');
        const declaredTier = payloadString(event, 'model_tier');
        const declaredContract = payloadString(event, 'contract_id');
        const fromPlan = planByStep.get(id);
        const phase: StepPhase = isOneOf(STEP_PHASES, declaredPhase)
          ? declaredPhase
          : (existing?.phase ?? fromPlan?.phase ?? 'implementation');
        steps.set(id, {
          step: id,
          phase,
          contract_id:
            declaredContract ?? existing?.contract_id ?? fromPlan?.contract_id ?? 'step.output',
          // In flight from here until a termination is folded. A record still carrying `null` when
          // the fold ends is a step the engine was killed inside, and the reconciler adopts it.
          disposition: null,
          // A start clears any session id: the previous attempt's is not this attempt's.
          session_id: null,
          baseline_ref: envelopeString(event, 'baseline_ref') ?? existing?.baseline_ref ?? '',
          model_tier: isOneOf(MODEL_RUNGS, declaredTier)
            ? declaredTier
            : (existing?.model_tier ?? options.plan.starting_model_tier),
          promotions: existing?.promotions ?? 0,
          attempts: (existing?.attempts ?? 0) + 1,
          resets: existing?.resets ?? 0,
          started_at: event.ts,
          terminated_at: null,
          error: null,
        });
        break;
      }

      case ENGINE_EVENT_TYPES.StepSessionRecorded: {
        const record = stepOf(event);
        const session = envelopeString(event, 'session_id');
        if (record !== null && session !== null) {
          steps.set(record.step, { ...record, session_id: session });
        }
        break;
      }

      case ENGINE_EVENT_TYPES.StepTerminated: {
        const record = stepOf(event);
        if (record === null) break;
        const declared = payloadString(event, 'disposition');
        const disposition: StepDisposition = isOneOf(STEP_DISPOSITIONS, declared)
          ? declared
          : 'failed';
        steps.set(record.step, {
          ...record,
          disposition,
          session_id: envelopeString(event, 'session_id') ?? record.session_id,
          terminated_at: event.ts,
          error: payloadError(event, 'error'),
        });
        break;
      }

      case ENGINE_EVENT_TYPES.StepApproved: {
        const record = stepOf(event);
        if (record === null) break;
        // The approval settles the condition the step blocked on, so the error is spent. Leaving it
        // standing would make the next pass escalate the very thing a person has just answered.
        steps.set(record.step, {
          ...record,
          disposition: 'interrupted',
          session_id: null,
          error: null,
        });
        break;
      }

      case ENGINE_EVENT_TYPES.StepResumeAttempted: {
        const record = stepOf(event);
        if (record === null) break;
        /**
         * A resume counts as an attempt at the step, and nothing else about the record moves.
         *
         * The disposition deliberately stays `interrupted` rather than going back to `null`: an
         * `interrupted` step whose resume was cut short by a crash is resumed again by the next pass,
         * which is what AD-8 prescribes, and each of those resumes is one more line here — so the loop
         * a permanently-interrupted step used to make is now a loop that counts, and the bound in
         * `decideAction` ends it.
         */
        steps.set(record.step, { ...record, attempts: record.attempts + 1 });
        break;
      }

      case ENGINE_EVENT_TYPES.StepResumeRefused: {
        const record = stepOf(event);
        if (record === null) break;
        // The recorded session id is spent: a refused resume is never retried against the same id,
        // so the next routing decision falls to the baseline reset and re-run of AD-8.
        steps.set(record.step, { ...record, session_id: null });
        break;
      }

      case ENGINE_EVENT_TYPES.StepBaselineReset: {
        const record = stepOf(event);
        if (record === null) break;
        steps.set(record.step, {
          ...record,
          resets: record.resets + 1,
          baseline_ref: envelopeString(event, 'baseline_ref') ?? record.baseline_ref,
        });
        break;
      }

      case ENGINE_EVENT_TYPES.StepTierPromoted: {
        const record = stepOf(event);
        if (record === null) break;
        const to = payloadString(event, 'to');
        steps.set(record.step, {
          ...record,
          model_tier: isOneOf(MODEL_RUNGS, to) ? to : record.model_tier,
          promotions: record.promotions + 1,
        });
        break;
      }

      case COMMAND_EVENT_TYPES.Applied: {
        const intentId = payloadString(event, 'intent_id');
        /**
         * No usable id, no fold. This line's *whole* safety is the id: exactly-once is "skip an id already
         * seen", so a line carrying no id — absent, empty, not a string, or replaced by the AD-21 marker —
         * was folded on every replay and applied its state change again each time. An approval folds to
         * `interrupted`, so a doubled one re-runs a finished step, which is precisely the cost story 1-3's
         * review measured. A line the ledger cannot key on is therefore ignored rather than trusted: the
         * writer guards the id at the door (`isLoggableIntentId`), so a line reaching here without one is a
         * corrupt or foreign line, and ignoring an unrecognised line is what AD-5 already says to do.
         */
        if (intentId === null || intentId === '') break;
        // Exactly-once, and the whole of it: a second line for one intent changes nothing.
        if (appliedIntents.has(intentId)) break;
        appliedIntents.add(intentId);

        const to = payloadString(event, 'to_state');
        if (isOneOf(FEATURE_STATES, to)) state = to;

        const record = stepOf(event);
        const declared = payloadString(event, 'step_disposition');
        if (record !== null && isOneOf(STEP_DISPOSITIONS, declared)) {
          /**
           * An approval spends the condition the step blocked on, so its error and its session id go
           * with it: leaving the error standing would make the next pass escalate the very thing a
           * person has just answered, and leaving the session id would resume a step whose blocking
           * gate is what needs re-deciding.
           */
          const spent = event.payload['clears_step_error'] === true;
          steps.set(record.step, {
            ...record,
            disposition: declared,
            session_id: spent ? null : (envelopeString(event, 'session_id') ?? record.session_id),
            terminated_at: record.terminated_at ?? event.ts,
            error: spent ? null : record.error,
          });
        }

        const handoffCode = payloadString(event, 'handoff_code');
        if (handoffCode !== null) {
          handoff = {
            code: handoffCode,
            reason:
              payloadString(event, 'handoff_reason') ??
              'a steering command handed the run off without a recorded reason',
            step: event.step,
            recorded_at: event.ts,
          };
        }
        break;
      }

      case ENGINE_EVENT_TYPES.HandoffRecorded: {
        handoff = {
          code: payloadString(event, 'code') ?? 'internal.invariant_violated',
          reason: payloadString(event, 'reason') ?? 'the run handed off without a recorded reason',
          step: event.step,
          recorded_at: event.ts,
        };
        break;
      }

      default:
        // AD-5 — a reader ignores an unknown type rather than erroring.
        break;
    }
  }

  const base = emptyRunState(options);
  return {
    ...base,
    mode,
    state,
    steps: [...steps.values()],
    last_event_seq: lastSeq,
    created_at: createdAt ?? base.created_at,
    updated_at: updatedAt ?? base.updated_at,
    handoff,
  };
};

/** One fact the checkpoint and the log disagree about. The log's value is the one that stands. */
export interface CheckpointDisagreement {
  /** A dotted path into the checkpoint, e.g. `steps.implement.disposition`. */
  readonly field: string;
  /** What the checkpoint claimed. */
  readonly checkpoint: string;
  /** What the log says, which is what the rebuilt checkpoint carries. */
  readonly log: string;
}

/**
 * Render a compared value for a disagreement message.
 *
 * Comparison is on the rendering, so the rendering has to be total: a value that stringified to
 * `[object Object]` would make two different objects compare equal and a real divergence read as
 * agreement.
 */
const render = (value: unknown): string => {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return value.toString();
  }
  if (typeof value === 'object') return JSON.stringify(value) ?? '[unserialisable]';
  // A symbol or a function is not a fact a checkpoint field can hold; it is reported by kind rather
  // than stringified, so two of them never compare equal by accident.
  return `[${typeof value}]`;
};

/**
 * Compare a checkpoint found on disk against the checkpoint the log folds to.
 *
 * Only facts the log is the authority for are compared. `territory` and the plan-derived fields are
 * declared configuration rather than run state, so a difference there is a configuration change and
 * not a checkpoint diverging from the truth.
 */
export const compareCheckpointToLog = (
  checkpoint: RunState,
  rebuilt: RunState,
): readonly CheckpointDisagreement[] => {
  const disagreements: CheckpointDisagreement[] = [];

  const compare = (field: string, mine: unknown, theirs: unknown): void => {
    if (render(mine) !== render(theirs)) {
      disagreements.push({ field, checkpoint: render(mine), log: render(theirs) });
    }
  };

  compare('state', checkpoint.state, rebuilt.state);
  compare('last_event_seq', checkpoint.last_event_seq, rebuilt.last_event_seq);
  compare('mode', checkpoint.mode, rebuilt.mode);
  compare('handoff.code', checkpoint.handoff?.code ?? null, rebuilt.handoff?.code ?? null);

  const fromLog = new Map(rebuilt.steps.map((record) => [record.step, record]));
  for (const record of checkpoint.steps) {
    const logged = fromLog.get(record.step);
    if (logged === undefined) {
      // The headline case: a checkpoint naming a step the log never started. The checkpoint is a
      // derived artifact, so the step it invents has no standing at all.
      disagreements.push({
        field: `steps.${record.step}`,
        checkpoint: `present, disposition ${render(record.disposition)}`,
        log: 'the log never started this step',
      });
      continue;
    }
    compare(`steps.${record.step}.disposition`, record.disposition, logged.disposition);
    compare(`steps.${record.step}.session_id`, record.session_id, logged.session_id);
    compare(`steps.${record.step}.baseline_ref`, record.baseline_ref, logged.baseline_ref);
    compare(`steps.${record.step}.attempts`, record.attempts, logged.attempts);
    compare(`steps.${record.step}.model_tier`, record.model_tier, logged.model_tier);
  }

  const inCheckpoint = new Set(checkpoint.steps.map((record) => record.step));
  for (const record of rebuilt.steps) {
    if (!inCheckpoint.has(record.step)) {
      disagreements.push({
        field: `steps.${record.step}`,
        checkpoint: 'absent',
        log: `started, disposition ${render(record.disposition)}`,
      });
    }
  }

  return disagreements;
};

/** The outcome of reconciling a checkpoint against the log. The returned state is always the log's. */
export interface ReconciledCheckpoint {
  /** The state to act on. Always the rebuilt one: the log wins, unconditionally. */
  readonly state: RunState;
  /** Empty when the checkpoint agreed, or when there was no checkpoint to disagree. */
  readonly disagreements: readonly CheckpointDisagreement[];
  /** True when a checkpoint existed and was discarded in favour of the log's version. */
  readonly checkpointDiscarded: boolean;
}

/**
 * Decide between a checkpoint and the log, in the log's favour.
 *
 * The log wins *unconditionally*, not "when they disagree": making the rebuilt state the return value
 * in both branches is what stops a future change from quietly reintroducing a second authority for
 * one fact, which is precisely what AD-4 forbids. The disagreement list exists to be reported, not to
 * decide anything.
 */
export const reconcileCheckpointAgainstLog = (
  checkpoint: RunState | null,
  rebuilt: RunState,
): ReconciledCheckpoint => {
  if (checkpoint === null) {
    return { state: rebuilt, disagreements: [], checkpointDiscarded: false };
  }
  const disagreements = compareCheckpointToLog(checkpoint, rebuilt);
  return { state: rebuilt, disagreements, checkpointDiscarded: disagreements.length > 0 };
};
