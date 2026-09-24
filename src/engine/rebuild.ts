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
  BUDGET_DEGRADED_EVENT_TYPE,
  BUDGET_PAYLOAD_KEYS,
  CEILING_DIMENSIONS,
  CURRENT_SCHEMA_VERSION,
  FEATURE_STATES,
  GATE_FAILED_EVENT_TYPE,
  GATE_PASSED_EVENT_TYPE,
  GATE_SKIPPED_EVENT_TYPE,
  MODEL_RUNGS,
  NOTE_INJECTED_EVENT_TYPE,
  NOTE_INJECTED_PAYLOAD_KEYS,
  NOTE_KINDS,
  OrchErrorSchema,
  REVERSIBILITY_CLASSES,
  REVIEW_SKIPPED_EVENT_TYPE,
  RUN_MODES,
  STEP_DISPOSITIONS,
  STEP_PHASES,
  STEP_TIER_DOWNSHIFTED_EVENT_TYPE,
  WRITE_GATE_APPROVED_EVENT_TYPE,
  WRITE_GATE_BATCH_ENTRY_PAYLOAD_KEYS,
  WRITE_GATE_OPENED_EVENT_TYPE,
  WRITE_GATE_OPENED_PAYLOAD_KEYS,
  WRITE_GATE_REJECTED_EVENT_TYPE,
  WRITE_INTENT_KINDS,
  formatTimestamp,
} from '../contracts/index.js';
import type {
  Degradation,
  EventEnvelope,
  FeatureState,
  Handoff,
  ModelRung,
  OrchError,
  PendingGate,
  PendingGateBatchEntry,
  PendingGateResolution,
  PendingNote,
  RunMode,
  RunState,
  StepDisposition,
  StepPhase,
  StepRecord,
} from '../contracts/index.js';

import { COMMAND_EVENT_TYPES } from './commands.js';
import { ModelRungUnrecognised } from './promotion.js';
import { writeIntentSettled } from './write-executor.js';

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
  /**
   * AD-24 — the run crossed eighty percent of a ceiling. Folded into `degradation`, once: the first line
   * stands and a later one changes nothing, because degradation is a standing condition (story 2-9).
   */
  BudgetDegraded: BUDGET_DEGRADED_EVENT_TYPE,
  /**
   * AD-24 — a step was put on a lower rung because the run is degraded, not because it failed.
   *
   * Its own type rather than `step.tier_promoted` with a direction, because the two have different triggers
   * — a failed gate climbs, budget pressure descends — and a reader counting promotions against the Stack's
   * one-per-step ceiling must never count a downshift as one. Not folded: `step.started` already carries the
   * rung the attempt ran on, and a second line that moved `model_tier` would be a second authority on it.
   */
  StepTierDownshifted: STEP_TIER_DOWNSHIFTED_EVENT_TYPE,
  /**
   * One deterministic gate ran, was skipped, or failed — CAP-13's first tier, recorded per gate.
   *
   * Three types rather than one with an `outcome` field, because a reader asking "did anything fail"
   * should not have to parse a payload to find out, and because `gate.skipped` is the one a person
   * most needs to see: a repository that declares no tests is not a repository whose tests pass, and
   * the difference has to be legible in the log and not only in the artifact.
   *
   * None of the three folds into the checkpoint. They are the record of what the *engine* did before
   * a spawn, and the spawn's own outcome is what the fold already tracks; a gate line that changed
   * step state would be a second authority on a step's disposition (AD-4).
   */
  GatePassed: GATE_PASSED_EVENT_TYPE,
  GateFailed: GATE_FAILED_EVENT_TYPE,
  GateSkipped: GATE_SKIPPED_EVENT_TYPE,
  /**
   * The model-based review was not spawned, and why — CAP-13's economics, said out loud.
   *
   * The *absence* of `agent.spawned` is what proves no review was spent (a counter can read zero
   * because nothing incremented it), and this is the positive statement beside it: absence alone
   * cannot say whether a review was skipped or the run never got that far.
   */
  ReviewSkipped: REVIEW_SKIPPED_EVENT_TYPE,
  /**
   * Story 4-1 — AD-12's reversibility gate opened by `settlePreMergeWrites`, before it would otherwise
   * have called the write executor. Folded into `pendingGate`; the checkpoint's one durable record that a
   * write is waiting on a person, distinct from a step's own `blocked` disposition because no step failed.
   */
  WriteGateOpened: WRITE_GATE_OPENED_EVENT_TYPE,
  /** A person approved the pending gate (CAP-12), so the write executor may proceed. Clears `pendingGate`. */
  WriteGateApproved: WRITE_GATE_APPROVED_EVENT_TYPE,
  /** A person rejected the pending gate (CAP-23), so the run hands off. Clears `pendingGate`. */
  WriteGateRejected: WRITE_GATE_REJECTED_EVENT_TYPE,
  /**
   * Story 4-3 — a durable note or person-initiated narrowing landed against the run. Folded into
   * `pendingNote`; the next `step.started` for this run clears it, mirroring `pendingGate`'s own
   * set-by-one-event, cleared-by-a-later-one shape.
   */
  NoteInjected: NOTE_INJECTED_EVENT_TYPE,
} as const;

export type EngineEventType = (typeof ENGINE_EVENT_TYPES)[keyof typeof ENGINE_EVENT_TYPES];

/**
 * The additive payload key that marks a `step.resume_attempted` line as counting against the bound.
 *
 * A build boundary, written into the log rather than inferred from it. `step.resume_attempted` predates
 * the attempt bound — it was emitted for the record and folded for nothing — so a log written before the
 * bound existed already holds those lines, and counting them retroactively means a run that was
 * mid-flight when the bound landed can jump straight past its eight engagements and hand off on the
 * first pass after the upgrade. There is nothing in an old line to tell it apart from a new one, so the
 * new one says so.
 *
 * Additive and optional, so AD-5 makes it invisible to an older reader, exactly like
 * {@link REPAIRED_PAYLOAD_KEY}. The direction of the default is the safe one: an unmarked line is
 * *not* counted, so the worst case is a pre-upgrade run getting a fresh allowance rather than a
 * live run being handed off for engagements it spent under different rules.
 */
export const RESUME_COUNTS_TOWARD_BOUND_KEY = 'counts_toward_attempt_bound';

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
  ENGINE_EVENT_TYPES.BudgetDegraded,
  /** Story 4-1 — the standing gate, set by the first and cleared by whichever of the other two lands. */
  ENGINE_EVENT_TYPES.WriteGateOpened,
  ENGINE_EVENT_TYPES.WriteGateApproved,
  ENGINE_EVENT_TYPES.WriteGateRejected,
  /** Story 4-3 — the standing note, set by `note.injected` and cleared by the run's next `step.started`. */
  ENGINE_EVENT_TYPES.NoteInjected,
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
  /**
   * Story 3-2 (AD-27) — the real, already-merged feature's merge commit this run shadows, or `null`/absent
   * for a live run. Read by the write executor's `pull_request` performer under `mode: 'shadow'` to tell
   * the one pull request a shadow run *expects* to find (the historical one it is reproducing, never
   * destructive) apart from any other, genuinely unexpected one (destructive) — see
   * `src/engine/write-executor.ts`'s own docblock. Optional so no existing caller or fixture that builds a
   * `FeaturePlan` needs to change.
   */
  readonly shadowRealMergeCommit?: string | null;
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

/**
 * A `write.gate_opened` line's `batch`, narrowed to the persisted shape — `intent_id`/`kind` only, never
 * `target` (that richer disclosure lives on the event payload itself; see {@link PendingGateBatchEntry}'s
 * own docblock for why the two shapes differ). `null` for anything not shaped as an array of entries this
 * build can place, the same defence every other gate field here gives an unplaceable value: a batch this
 * reader cannot describe is not a batch it can safely claim covers anything.
 */
const payloadGateBatch = (event: EventEnvelope, key: string): PendingGateBatchEntry[] | null => {
  const value = event.payload[key];
  if (!Array.isArray(value)) return null;
  const entries: PendingGateBatchEntry[] = [];
  for (const item of value) {
    if (typeof item !== 'object' || item === null) return null;
    const intentId = (item as Record<string, unknown>)[WRITE_GATE_BATCH_ENTRY_PAYLOAD_KEYS.IntentId];
    const kind = (item as Record<string, unknown>)[WRITE_GATE_BATCH_ENTRY_PAYLOAD_KEYS.Kind];
    if (typeof intentId !== 'string' || !isOneOf(WRITE_INTENT_KINDS, kind)) return null;
    entries.push({ intent_id: intentId, kind });
  }
  return entries;
};

/**
 * A pending gate record with its `resolution` replaced, everything else carried over.
 *
 * A plain top-level function, taking the open gate as a parameter, rather than an inline
 * `{ ...pendingGate, resolution }` at the fold's own call site. The loop-carried `let pendingGate`
 * variable is reassigned in an earlier `case` of the very same `switch`, and TypeScript's control-flow
 * narrowing for a mutable loop variable spread back into itself in a later case collapses to `never` at
 * that point (a known compiler limitation with no useful workaround short of this one) — a plain
 * function call breaks that direct self-reference, because a parameter is typed by its declaration, not
 * by the call site's own control-flow history.
 */
const withGateResolution = (gate: PendingGate, resolution: PendingGateResolution): PendingGate => ({
  step: gate.step,
  intent_id: gate.intent_id,
  kind: gate.kind,
  reversibility: gate.reversibility,
  batch: gate.batch,
  resolution,
});

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
    degradation: null,
    pending_gate: null,
    pending_note: null,
  };
};

/**
 * Fold the event log into a checkpoint.
 *
 * The events are folded in `seq` order, which is the only ordering authority (AD-29): timestamps
 * carry none across processes, so the fold sorts by `seq` rather than trusting the file's order.
 */
/**
 * The rung a log line names, or the fallback when it names none.
 *
 * **A line that names a rung this build cannot place is refused, not replaced.** The fold used to answer
 * `existing?.model_tier ?? plan.starting_model_tier` for an unplaceable value, which is the exact case
 * `src/engine/promotion.ts` refuses by name — so the two modules disagreed about the same fact, and the
 * fold's answer was the more dangerous of the two: it silently put a step back on the starting tier,
 * which for a step that had been promoted is the ladder running backwards, recorded as history rather
 * than as a decision. AD-4 makes the log the truth and AD-28 refuses an artifact this build does not
 * understand; a rung it cannot place is that, and `config.invalid` reaches a person.
 *
 * An *absent* value is a different answer and keeps the fallback: older lines, and lines from emitters
 * that never carried the field, say nothing about the rung rather than saying something wrong. `null` and
 * `undefined` are both that absence, because `payloadString` spells a missing key one way and a present
 * non-string the other.
 */
const loggedRung = (logged: string | null | undefined, fallback: ModelRung, step: string): ModelRung => {
  if (logged === undefined || logged === null) return fallback;
  if (!isOneOf(MODEL_RUNGS, logged)) {
    throw new ModelRungUnrecognised(logged, `the rung logged for step "${step}"`);
  }
  return logged;
};

export const rebuildFromLog = (
  events: readonly EventEnvelope[],
  options: RebuildOptions,
): RunState => {
  const ordered = [...events].sort((a, b) => a.seq - b.seq);
  const planByStep = new Map(options.plan.steps.map((step) => [step.step, step]));

  let state: FeatureState = 'drafting';
  let mode: RunMode = options.plan.mode;
  let handoff: Handoff | null = null;
  let degradation: Degradation | null = null;
  let pendingGate: PendingGate | null = null;
  /** Story 4-3 — the standing note, set by `note.injected` and cleared by the run's next `step.started`. */
  let pendingNote: PendingNote | null = null;
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
        /**
         * Story 4-3 — this is "whichever step's input is built next" (the one moment `stepInput`
         * delivers a pending note into), so any `step.started` line for this run clears it, unconditionally
         * — the note was either delivered into *this* step's own input, or there was none pending at all.
         * Cleared even if the line names no readable step below, because the fact this clears is about the
         * run having started a step, not about which one.
         */
        pendingNote = null;
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
          model_tier: loggedRung(
            declaredTier,
            existing?.model_tier ?? options.plan.starting_model_tier,
            id,
          ),
          promotions: existing?.promotions ?? 0,
          attempts: (existing?.attempts ?? 0) + 1,
          credited_attempts: existing?.credited_attempts ?? 0,
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
          // CAP-12 — and it credits the attempts already spent, or a step sitting at the bound would
          // hand off instead of running the attempt the person just authorised.
          credited_attempts: record.attempts,
        });
        break;
      }

      case ENGINE_EVENT_TYPES.StepResumeAttempted: {
        /**
         * Story 4-3, round-1 review — a resume is "the next input this run writes" exactly as much as a
         * fresh start is (row 13): `stepInput()` is called on the resume path too, and a note pending when
         * the resume began was delivered into *this* attempt's own input (or there was none pending at
         * all). Clearing only on `step.started` left a note injected while a step was `interrupted`
         * uncleared for ever, since a resume never emits that type. Unconditional, the same as the
         * `step.started` case's own clear: the fact this clears is about the run having resumed a step,
         * not about which one or whether the bound-counting line below even applies.
         */
        pendingNote = null;
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
         *
         * Only a line carrying {@link RESUME_COUNTS_TOWARD_BOUND_KEY} counts. A log written before the
         * bound existed already holds `step.resume_attempted` lines, and counting those retroactively
         * would hand off a run that was mid-flight when the bound landed, for engagements it spent when
         * they cost nothing. An unmarked line is still folded as it always was — which is to say it
         * changes nothing — so this is a narrowing of what the count reads, not of what the fold sees.
         */
        if (event.payload[RESUME_COUNTS_TOWARD_BOUND_KEY] !== true) break;
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
          model_tier: loggedRung(to, record.model_tier, record.step),
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

        /**
         * Story 4-1, round-1 review — a *rejected* gate is cleared here, once its own hand-off
         * transition actually lands; an *approved* one is cleared later, once its whole batch actually
         * settles (see the post-loop finalisation this fold does after the `for` above, right before the
         * checkpoint is returned) — never here, because `settlePreMergeWrites` still needs to find
         * `resolution: 'approved'` on a later pass to run the batch at all (rows 3, 12).
         *
         * `state !== 'blocked'` rather than `to === 'handed_off'` specifically: a rejected gate's own
         * transition is always to `handed_off`, but a `kill`/`disengage`/`take_over` landing first (this
         * story changes no guard on those — see its own Never list) also moves the run off `blocked`,
         * and a stale rejected-gate record serves nothing once the run has left it behind either way.
         */
        if (pendingGate !== null && pendingGate.resolution === 'rejected' && state !== 'blocked') {
          pendingGate = null;
        }

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
            /**
             * CAP-12 — an approval credits the attempts already spent on the step.
             *
             * `clears_step_error` marks the one effect that is a person saying "continue": it turns the
             * step's disposition to `interrupted`, which returns to the same step, so a step standing at
             * the attempt bound when someone approved it handed off on the very next pass rather than
             * running the attempt they had just authorised. The bound exists to stop *unattended*
             * looping; a human gesture is the opposite of unattended, and every credit costs another one.
             */
            credited_attempts: spent ? record.attempts : record.credited_attempts,
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

      case ENGINE_EVENT_TYPES.BudgetDegraded: {
        /**
         * `??=`, so the first line stands. A second `budget.degraded` should never be written — the engine
         * guards on this very field — but a log is data, and a duplicated line must not move the record of
         * *when* and *why* the run degraded to a later, different answer.
         */
        const dimension = payloadString(event, BUDGET_PAYLOAD_KEYS.Dimension);
        degradation ??= {
          dimension: isOneOf(CEILING_DIMENSIONS, dimension) ? dimension : null,
          recorded_at: event.ts,
        };
        break;
      }

      case ENGINE_EVENT_TYPES.WriteGateOpened: {
        /**
         * Story 4-1 — a line naming a kind, a reversibility class or a batch this build cannot place is
         * ignored rather than folded as a guess, the same defence {@link loggedRung} gives an unplaceable
         * rung: a gate this reader cannot describe is not a gate it can safely claim is open.
         */
        const intentId = payloadString(event, WRITE_GATE_OPENED_PAYLOAD_KEYS.IntentId);
        const kind = payloadString(event, WRITE_GATE_OPENED_PAYLOAD_KEYS.Kind);
        const reversibility = payloadString(event, WRITE_GATE_OPENED_PAYLOAD_KEYS.Reversibility);
        const step = payloadString(event, WRITE_GATE_OPENED_PAYLOAD_KEYS.Step);
        const batch = payloadGateBatch(event, WRITE_GATE_OPENED_PAYLOAD_KEYS.Batch);
        if (
          intentId !== null &&
          isOneOf(WRITE_INTENT_KINDS, kind) &&
          isOneOf(REVERSIBILITY_CLASSES, reversibility) &&
          batch !== null
        ) {
          pendingGate = {
            step: step ?? '',
            intent_id: intentId,
            kind,
            reversibility,
            batch,
            resolution: 'pending',
          };
        }
        break;
      }

      case ENGINE_EVENT_TYPES.NoteInjected: {
        /**
         * A second `note.injected` before the first is consumed **replaces** it — this is a plain
         * assignment, never an append, which is the whole of "only one pending note at a time" (I/O
         * matrix row 5). A line naming a `kind` this build cannot place is ignored rather than folded as
         * a guess, the same defence {@link loggedRung} gives an unplaceable rung.
         */
        const text = payloadString(event, NOTE_INJECTED_PAYLOAD_KEYS.Text);
        const kind = payloadString(event, NOTE_INJECTED_PAYLOAD_KEYS.Kind);
        if (text !== null && isOneOf(NOTE_KINDS, kind)) {
          pendingNote = { text, kind };
        }
        break;
      }

      /**
       * Story 4-1, round-1 review's most serious fix — `resolution` is what these two lines change, never
       * the whole record going to `null` directly. Clearing straight to `null` here raced the *separate*
       * `command.applied` line the resolving effect also emits (folded below, in its own case): a crash
       * landing this line durably but not that one left `pending_gate` reading `null` while `state.state`
       * was still `blocked`, so a later, redelivered `Command.Approve` found no gate on record and — for a
       * rejection — silently reversed it. Setting `resolution` in place instead leaves a fully truthful
       * intermediate fold across that exact crash; only the `command.applied` line's own `to_state`, once
       * it lands, clears the whole record (see that case, below).
       *
       * A line naming a gate this fold has no open record for is ignored: there is nothing to resolve.
       */
      case ENGINE_EVENT_TYPES.WriteGateApproved:
      case ENGINE_EVENT_TYPES.WriteGateRejected: {
        if (pendingGate === null) break;
        pendingGate = withGateResolution(
          pendingGate,
          event.type === ENGINE_EVENT_TYPES.WriteGateApproved ? 'approved' : 'rejected',
        );
        break;
      }

      default:
        // AD-5 — a reader ignores an unknown type rather than erroring.
        break;
    }
  }

  /**
   * Story 4-1, round-1 review — the *only* place an `'approved'` gate is cleared to `null`.
   *
   * Not on the resolving `command.applied` line the way a `'rejected'` gate is (above): rows 3 and 12
   * both require `settlePreMergeWrites` to still find `resolution: 'approved'` on a *later* pass, so it
   * can run the whole remaining batch without a per-intent lookup or a second approval — clearing the
   * record the moment the approval's own `running`/`degraded` transition landed would erase exactly the
   * fact that later pass depends on, before the batch it approves has actually settled. So an approved
   * gate stays on record until every intent in its own `batch` carries a `write.executed`/
   * `write.suppressed` line — `writeIntentSettled` is the same idempotency check `settlePreMergeWrites`
   * itself already makes per intent, read here once, after the whole log is folded, rather than
   * threaded through the loop above as a running tally.
   */
  if (pendingGate !== null && pendingGate.resolution === 'approved') {
    if (pendingGate.batch.every((entry) => writeIntentSettled(ordered, entry.intent_id))) {
      pendingGate = null;
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
    degradation,
    pending_gate: pendingGate,
    pending_note: pendingNote,
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
  // A checkpoint that has forgotten a degradation the log records would put a degraded run back on the
  // ordinary tier and the ordinary review, which is the un-degrading story 2-9 forbids.
  compare('degradation', checkpoint.degradation, rebuilt.degradation);
  // A checkpoint that has forgotten a pending gate the log still holds open would let `approve`/`reject`
  // fall through to the ordinary step-failure branches for a run where no step failed (story 4-1).
  compare('pending_gate', checkpoint.pending_gate, rebuilt.pending_gate);
  // A checkpoint that has forgotten a pending note would build the run's next step input with no
  // `steering_note`, silently dropping a person's own words (story 4-3).
  compare('pending_note', checkpoint.pending_note, rebuilt.pending_note);

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
    compare(
      `steps.${record.step}.credited_attempts`,
      record.credited_attempts,
      logged.credited_attempts,
    );
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
