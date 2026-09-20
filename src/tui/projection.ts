/**
 * The fold from `events.jsonl` to view state. Nearly all of the TUI is this function.
 *
 * AD-4 makes the event log the sole durable truth and every surface a projection of it, so the shell
 * holds no authoritative state of its own: what it shows is what the fold computed, and folding the
 * same events twice gives the same view. That is not a stylistic preference — it is the property that
 * makes it impossible for the terminal to disagree with the log about what happened.
 *
 * Three rules govern what this module reads:
 *
 * - **An unknown event type is ignored, never an error** (AD-5). A newer engine's log renders in an
 *   older shell, which is what makes adding an event type a non-breaking change. The fold therefore
 *   updates *nothing* — not a counter, not a timestamp — from a type it does not handle, so a view
 *   folded from a log carrying an unknown type is identical to one folded from the log without it.
 * - **The vocabulary is read as data, not imported from the engine.** The type names below are the
 *   strings the log holds, and the spine forbids a renderer importing `src/engine/`. Keeping them here
 *   as declared constants is what lets the dependency rule hold; `tests/tui.projection.test.ts`
 *   asserts they still agree with the engine's own tables, which is where a drift would be caught
 *   without a renderer ever importing the engine.
 * - **Everything is addressed by feature name** (R6). The view carries no run id and no agent name at
 *   all, so no render can require a person to know either.
 *
 * What the fold does *not* do: reach a clock. Elapsed time against an estimate has to keep moving
 * while nothing is happening, so the view carries the two instants the log recorded and the shell
 * supplies `now` at the moment it renders. A fold that read the clock would not be a fold.
 */
import { REDACTION_MARKER, readEventLog } from '../runtime/index.js';
import { EventLogCorruptError } from '../runtime/index.js';
import type { EventEnvelope, FeatureState, RunMode, StepPhase } from '../contracts/index.js';
import { FEATURE_STATES, compareEventOrder } from '../contracts/index.js';

import { DEFAULT_AUTONOMY_MODE, applyCommandToMode, modeForFeatureState } from './mode.js';
import type { AutonomyMode } from './mode.js';

/**
 * The event types this fold acts on, as the log spells them.
 *
 * Declared here rather than imported, because `src/tui/` may not import `src/engine/` — and the log is
 * data on disk, not an engine API. Every name in this table is one the engine writes today; a name
 * added to the log later is ignored until a story adds it here, which is AD-5 working as intended.
 */
export const TUI_EVENT_TYPES = {
  RunCreated: 'run.created',
  FeatureStateChanged: 'feature.state_changed',
  StepStarted: 'step.started',
  StepTerminated: 'step.terminated',
  StepBaselineReset: 'step.baseline_reset',
  StepTierPromoted: 'step.tier_promoted',
  CommandApplied: 'command.applied',
  CommandRefused: 'command.refused',
  QuestionAsked: 'question.asked',
  QuestionResolved: 'question.resolved',
  QuestionDefaultTaken: 'question.default_taken',
  QuestionDeflected: 'question.deflected',
  BudgetDegraded: 'budget.degraded',
  BudgetExhausted: 'budget.exhausted',
  HandoffRecorded: 'handoff.recorded',
  PermissionDenied: 'permission.denied',
  RedactionFailed: 'redaction.failed',
} as const;

export type TuiEventType = (typeof TUI_EVENT_TYPES)[keyof typeof TUI_EVENT_TYPES];

/** Every type the fold acts on. A type outside this set changes nothing at all (AD-5). */
export const FOLDED_TUI_EVENT_TYPES: readonly string[] = Object.freeze(
  Object.values(TUI_EVENT_TYPES),
);

export const isFoldedTuiEventType = (type: string): type is TuiEventType =>
  FOLDED_TUI_EVENT_TYPES.includes(type);

/**
 * The payload keys the fold reads, spelled once.
 *
 * A key read in two places under two spellings is a field that silently stops being displayed the day
 * one of them changes, and the fold has no schema of its own to catch that.
 */
export const TUI_PAYLOAD_KEYS = {
  Mode: 'mode',
  StepCount: 'step_count',
  StateTo: 'to',
  Reason: 'reason',
  Phase: 'phase',
  Disposition: 'disposition',
  Command: 'command',
  IntentId: 'intent_id',
  ToState: 'to_state',
  Effect: 'effect',
  QuestionId: 'question_id',
  Prompt: 'prompt',
  RecommendedOptionId: 'recommended_option_id',
  DefaultAction: 'default_action',
  DefaultWindowMs: 'default_window_ms',
  Resolver: 'resolver',
  Answer: 'answer',
  Source: 'source',
  RateLimitBudgetConsumed: 'rate_limit_budget_consumed',
  WallClockMsRemaining: 'wall_clock_ms_remaining',
  WallClockMsEstimate: 'wall_clock_ms_estimate',
  Code: 'code',
} as const;

/** How a value the AD-21 pass replaced is presented: as redacted, never as a value and never as an error. */
export const REDACTED_PRESENTATION = '(redacted in the log)';

/** How a value the log has not recorded is presented. Uncertainty is surfaced as uncertainty (R12). */
export const UNRECORDED_PRESENTATION = '(not recorded)';

/**
 * Present a field the log may hold redacted, may not hold at all, or may hold plainly.
 *
 * Story 1-2's redaction pass means `[redacted]` is a legitimate value in a log, and a renderer that
 * showed it as the answer, or threw on meeting it, would be wrong in two different directions.
 */
export const presentValue = (value: string | null): string =>
  value === null ? UNRECORDED_PRESENTATION : value === REDACTION_MARKER ? REDACTED_PRESENTATION : value;

/** Whether a field's value is the redaction marker rather than content. */
export const isRedacted = (value: string | null): boolean => value === REDACTION_MARKER;

/** One step, as the log describes it. Named, never numbered (Consistency Conventions). */
export interface StepView {
  readonly step: string;
  readonly phase: StepPhase | null;
  /** `null` while the step is in flight; every termination records one (AD-8). */
  readonly disposition: string | null;
  readonly startedAt: string | null;
  readonly terminatedAt: string | null;
}

/** Progress, as R7 defines it: the current step's name and the next gate. Never a share of a whole. */
export interface ProgressView {
  /** The step in flight, or `null` when none is. */
  readonly currentStep: string | null;
  readonly currentStepPhase: StepPhase | null;
  /** What the run is waiting for next, in a person's words. */
  readonly nextGate: string;
  readonly stepsStarted: number;
  readonly stepsCompleted: number;
  /** How many steps the plan declared, when the log recorded it. */
  readonly plannedSteps: number | null;
  readonly steps: readonly StepView[];
}

/**
 * The ambient numbers R10 and R11 require to be visible without a command being issued.
 *
 * `rateLimitBudgetConsumed` is a share of the subscription's rate-limit budget between 0 and 1 — AD-24
 * declares three ceilings and no currency dimension, so nothing here is money and nothing here can be
 * rendered as money.
 */
export interface UsageView {
  readonly rateLimitBudgetConsumed: number | null;
  /** The first instant the log recorded, so the shell can measure elapsed against its own clock. */
  readonly startedAt: string | null;
  /** The last instant the fold acted on, which is how far the log has got. */
  readonly lastActivityAt: string | null;
  /** Elapsed between those two instants, for a run the log has finished describing. */
  readonly recordedElapsedMs: number | null;
  /** The wall-clock estimate, when the log carries one, whether stated or implied by a remaining. */
  readonly estimateMs: number | null;
}

/** What the question slot holds. The slot exists in every state; only its contents change (R14). */
export const QUESTION_SLOT_STATES = ['empty', 'pending', 'resolved', 'defaulted', 'deflected'] as const;

export type QuestionSlotState = (typeof QUESTION_SLOT_STATES)[number];

export interface QuestionSlotView {
  readonly state: QuestionSlotState;
  readonly prompt: string | null;
  readonly recommendedOptionId: string | null;
  readonly defaultAction: string | null;
  readonly defaultWindowMs: number | null;
  /** Who or what resolved it: a person, or the clock taking the default (AD-25). */
  readonly resolver: string | null;
  readonly answer: string | null;
  /**
   * The outcome in a sentence, including when the default was taken while somebody was typing.
   *
   * Story 1-8 established that a losing resolver must be told plainly what happened; this is where
   * that stops being a field in a log and becomes something a person reads.
   */
  readonly outcome: string | null;
}

const EMPTY_QUESTION_SLOT: QuestionSlotView = Object.freeze({
  state: 'empty',
  prompt: null,
  recommendedOptionId: null,
  defaultAction: null,
  defaultWindowMs: null,
  resolver: null,
  answer: null,
  outcome: null,
});

/** One thing worth saying that is not the mode, the status or the question. Bounded, so nothing scrolls. */
export interface NoticeView {
  readonly at: string;
  readonly text: string;
}

/**
 * How many notices the view keeps.
 *
 * Bounded rather than unbounded because the question slot must not scroll away (R14): a frame whose
 * notice list grows without limit eventually pushes the slot off the terminal, and the cheapest place
 * to hold that line is here, where the view is built, rather than in the component that draws it.
 */
export const MAX_NOTICES = 4;

/** Everything one render needs, and nothing a person would have to know a run id to use. */
export interface ShellView {
  /** The feature, by name. The only identifier a person ever needs (R6). */
  readonly feature: string | null;
  readonly runMode: RunMode;
  readonly autonomy: AutonomyMode;
  readonly featureState: FeatureState | null;
  readonly progress: ProgressView;
  readonly usage: UsageView;
  readonly question: QuestionSlotView;
  readonly notices: readonly NoticeView[];
  /**
   * A plain statement of why this view is not a projection of a log, or `null` when it is.
   *
   * A log the reader refuses leaves the shell up and saying so. The alternative — a stack trace over a
   * dead terminal — is the one outcome the matrix names twice.
   */
  readonly problem: string | null;
}

/**
 * The view of a run with no events: coherent, and carrying a mode like every other state.
 *
 * Defined as the fold of no events rather than as a second literal, so there is exactly one rule for
 * what an idle run says — a hand-written idle view is the kind of thing that stops agreeing with the
 * fold the first time a field is added.
 */
export const idleShellView = (feature: string | null = null): ShellView => ({
  ...foldEvents([]),
  feature,
});

/** A string payload field, or `null` when the payload does not carry one. */
const text = (payload: Record<string, unknown>, key: string): string | null => {
  const value = payload[key];
  return typeof value === 'string' && value !== '' ? value : null;
};

/** A finite numeric payload field, or `null`. */
const num = (payload: Record<string, unknown>, key: string): number | null => {
  const value = payload[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
};

/**
 * A feature state this build declares, or `null` for one it does not.
 *
 * AD-5's latitude is for event *types*, and this is the same instinct applied to a field's value: a
 * lifecycle state a newer engine invented is not one this shell can say anything true about, so it
 * leaves the state unset — and `nextGateFor` already has an answer for a run whose state is unknown —
 * rather than displaying a word it cannot place in the lifecycle.
 */
const featureState = (value: string | null): FeatureState | null =>
  value !== null && (FEATURE_STATES as readonly string[]).includes(value)
    ? (value as FeatureState)
    : null;

const stepPhase = (value: string | null): StepPhase | null =>
  value === 'implementation' || value === 'verification' ? value : null;

/** Milliseconds between two recorded instants, or `null` when either is missing or unparseable. */
export const elapsedBetween = (from: string | null, to: string | null): number | null => {
  if (from === null || to === null) return null;
  const start = Date.parse(from);
  const end = Date.parse(to);
  if (Number.isNaN(start) || Number.isNaN(end)) return null;
  return Math.max(end - start, 0);
};

interface MutableStep {
  step: string;
  phase: StepPhase | null;
  disposition: string | null;
  startedAt: string | null;
  terminatedAt: string | null;
}

/**
 * What the run is waiting for, in a person's words.
 *
 * This is the "next gate" half of R7, and it is prose rather than a number for the reason R7 gives: a
 * share of a whole tells a person nothing about whether they are needed, and the gate tells them
 * exactly that.
 */
const nextGateFor = (facts: {
  readonly question: QuestionSlotView;
  readonly state: FeatureState | null;
  readonly current: MutableStep | null;
}): string => {
  if (facts.question.state === 'pending') return 'your answer to the question below';
  switch (facts.state) {
    case 'drafting':
      return 'your confirmation of the acceptance criteria';
    case 'confirmed':
      return 'the first step, which the reconciler claims next';
    case 'blocked':
      return facts.current === null
        ? 'your approval at the gate this run is blocked at'
        : `your approval at the gate step "${facts.current.step}" is blocked at`;
    case 'verifying':
      return 'the verification gates';
    case 'interrupted':
      return 'a resume, or a re-run from the step baseline';
    case 'degraded':
      return 'the narrowed scope to finish';
    case 'committed':
      return 'nothing: the work is committed and needs you for nothing';
    case 'killed':
      return 'nothing: the run was stopped';
    case 'handed_off':
      return 'you: the run handed off and wrote a note';
    case 'hibernated':
      return 'nothing: the run hibernated at a ceiling';
    case 'running':
    case null:
      if (facts.current === null) {
        return facts.state === null
          ? 'the first step, once the feature is confirmed'
          : 'the next step, which the reconciler claims on its next pass';
      }
      return facts.current.phase === 'verification'
        ? 'the verification gates'
        : 'verification, once the implementation steps are done';
  }
};

/**
 * Fold an event log into one view.
 *
 * Pure: the same events give the same view, and nothing here reads a clock, a file or an environment.
 * Events are ordered by `seq` first, because AD-29 gives `seq` the ordering authority and a timestamp
 * none.
 */
export const foldEvents = (events: readonly EventEnvelope[]): ShellView => {
  const ordered = [...events].sort(compareEventOrder);

  let feature: string | null = null;
  let runMode: RunMode = 'live';
  let autonomy: AutonomyMode = DEFAULT_AUTONOMY_MODE;
  let state: FeatureState | null = null;
  let plannedSteps: number | null = null;
  let rateLimitBudgetConsumed: number | null = null;
  let estimateMs: number | null = null;
  let startedAt: string | null = null;
  let lastActivityAt: string | null = null;
  let question: QuestionSlotView = EMPTY_QUESTION_SLOT;
  let pendingQuestionId: string | null = null;

  const steps = new Map<string, MutableStep>();
  const stepOrder: string[] = [];
  const notices: NoticeView[] = [];
  const appliedIntents = new Set<string>();

  const notice = (at: string, textLine: string): void => {
    notices.push({ at, text: textLine });
    if (notices.length > MAX_NOTICES) notices.shift();
  };

  const stepOf = (name: string): MutableStep => {
    const existing = steps.get(name);
    if (existing !== undefined) return existing;
    const created: MutableStep = {
      step: name,
      phase: null,
      disposition: null,
      startedAt: null,
      terminatedAt: null,
    };
    steps.set(name, created);
    stepOrder.push(name);
    return created;
  };

  for (const event of ordered) {
    // AD-5 — a type this build does not handle changes nothing, not even a counter or a timestamp.
    if (!isFoldedTuiEventType(event.type)) continue;

    feature ??= event.feature;
    startedAt ??= event.ts;
    lastActivityAt = event.ts;
    const payload = event.payload;

    switch (event.type) {
      case TUI_EVENT_TYPES.RunCreated: {
        const declared = text(payload, TUI_PAYLOAD_KEYS.Mode);
        if (declared === 'shadow' || declared === 'live') runMode = declared;
        plannedSteps = num(payload, TUI_PAYLOAD_KEYS.StepCount) ?? plannedSteps;
        estimateMs = num(payload, TUI_PAYLOAD_KEYS.WallClockMsEstimate) ?? estimateMs;
        state ??= 'drafting';
        break;
      }

      case TUI_EVENT_TYPES.FeatureStateChanged: {
        state = featureState(text(payload, TUI_PAYLOAD_KEYS.StateTo)) ?? state;
        break;
      }

      case TUI_EVENT_TYPES.StepStarted: {
        if (event.step === null) break;
        const record = stepOf(event.step);
        record.phase = stepPhase(text(payload, TUI_PAYLOAD_KEYS.Phase)) ?? record.phase;
        record.startedAt = event.ts;
        record.disposition = null;
        record.terminatedAt = null;
        break;
      }

      case TUI_EVENT_TYPES.StepTerminated: {
        if (event.step === null) break;
        const record = stepOf(event.step);
        record.disposition = text(payload, TUI_PAYLOAD_KEYS.Disposition);
        record.terminatedAt = event.ts;
        break;
      }

      case TUI_EVENT_TYPES.StepBaselineReset:
      case TUI_EVENT_TYPES.StepTierPromoted: {
        // Folded so the run's elapsed advances with them, and deliberately silent otherwise: neither
        // is something a person has to act on, and R1 makes silence the default.
        break;
      }

      case TUI_EVENT_TYPES.CommandApplied: {
        const intentId = text(payload, TUI_PAYLOAD_KEYS.IntentId);
        // The exactly-once key, for the same reason the engine's fold keys on it: at-least-once
        // delivery means one keystroke can appear twice, and a notice repeated is a notice distrusted.
        if (intentId !== null && appliedIntents.has(intentId)) break;
        if (intentId !== null) appliedIntents.add(intentId);
        const command = text(payload, TUI_PAYLOAD_KEYS.Command);
        if (command !== null) autonomy = applyCommandToMode(autonomy, command);
        state = featureState(text(payload, TUI_PAYLOAD_KEYS.ToState)) ?? state;
        if (command !== null) {
          notice(
            event.ts,
            `${command.replace(/_/g, ' ')} applied: ${
              text(payload, TUI_PAYLOAD_KEYS.Effect) ?? 'acknowledged'
            }`,
          );
        }
        break;
      }

      case TUI_EVENT_TYPES.CommandRefused: {
        notice(
          event.ts,
          `a control was refused (${text(payload, TUI_PAYLOAD_KEYS.Reason) ?? 'no reason recorded'}) — ` +
            'nothing changed',
        );
        break;
      }

      case TUI_EVENT_TYPES.QuestionAsked: {
        pendingQuestionId = text(payload, TUI_PAYLOAD_KEYS.QuestionId);
        question = {
          state: 'pending',
          prompt: text(payload, TUI_PAYLOAD_KEYS.Prompt),
          recommendedOptionId: text(payload, TUI_PAYLOAD_KEYS.RecommendedOptionId),
          defaultAction: text(payload, TUI_PAYLOAD_KEYS.DefaultAction),
          defaultWindowMs: num(payload, TUI_PAYLOAD_KEYS.DefaultWindowMs),
          resolver: null,
          answer: null,
          outcome: null,
        };
        break;
      }

      case TUI_EVENT_TYPES.QuestionResolved:
      case TUI_EVENT_TYPES.QuestionDefaultTaken:
      case TUI_EVENT_TYPES.QuestionDeflected: {
        const questionId = text(payload, TUI_PAYLOAD_KEYS.QuestionId);
        // An outcome for a question this view is not holding is still worth reporting, but it must not
        // clear a *different* question's pending slot: two questions in one run would otherwise take
        // turns erasing each other.
        if (pendingQuestionId !== null && questionId !== null && questionId !== pendingQuestionId) {
          notice(event.ts, 'another question was settled');
          break;
        }
        pendingQuestionId = null;
        const resolver = text(payload, TUI_PAYLOAD_KEYS.Resolver);
        const answer = text(payload, TUI_PAYLOAD_KEYS.Answer);
        const slotState: QuestionSlotState =
          event.type === TUI_EVENT_TYPES.QuestionDeflected
            ? 'deflected'
            : event.type === TUI_EVENT_TYPES.QuestionDefaultTaken
              ? 'defaulted'
              : 'resolved';
        question = {
          ...question,
          state: slotState,
          resolver,
          answer,
          outcome:
            slotState === 'defaulted'
              ? 'the window closed and the recommended default was taken — if you were typing, your ' +
                'answer did not land'
              : slotState === 'deflected'
                ? 'answered from the repository, history or ledger; nobody was asked'
                : `answered${resolver === null ? '' : ` by the ${resolver.replace(/_/g, ' ')} resolver`}`,
        };
        break;
      }

      case TUI_EVENT_TYPES.BudgetDegraded:
      case TUI_EVENT_TYPES.BudgetExhausted: {
        rateLimitBudgetConsumed =
          num(payload, TUI_PAYLOAD_KEYS.RateLimitBudgetConsumed) ?? rateLimitBudgetConsumed;
        const remaining = num(payload, TUI_PAYLOAD_KEYS.WallClockMsRemaining);
        const stated = num(payload, TUI_PAYLOAD_KEYS.WallClockMsEstimate);
        if (stated !== null) estimateMs = stated;
        else if (remaining !== null) {
          const soFar = elapsedBetween(startedAt, event.ts);
          if (soFar !== null) estimateMs = soFar + remaining;
        }
        notice(
          event.ts,
          event.type === TUI_EVENT_TYPES.BudgetExhausted
            ? 'a ceiling was reached: the run hibernated and wrote a note'
            : 'a ceiling is close: the model tier was downshifted and the scope narrowed',
        );
        break;
      }

      case TUI_EVENT_TYPES.HandoffRecorded: {
        notice(
          event.ts,
          `handed off (${text(payload, TUI_PAYLOAD_KEYS.Code) ?? 'no code recorded'}): ` +
            `${text(payload, TUI_PAYLOAD_KEYS.Reason) ?? 'no reason recorded'}`,
        );
        break;
      }

      case TUI_EVENT_TYPES.PermissionDenied: {
        notice(event.ts, 'a tool was denied by the permission surface; the step continued without it');
        break;
      }

      case TUI_EVENT_TYPES.RedactionFailed: {
        notice(event.ts, 'an artifact was dropped rather than written unredacted');
        break;
      }
    }
  }

  const forced = modeForFeatureState(state);
  if (forced !== null) autonomy = forced;

  const stepViews: StepView[] = stepOrder.flatMap((name) => {
    const record = steps.get(name);
    return record === undefined
      ? []
      : [
          {
            step: record.step,
            phase: record.phase,
            disposition: record.disposition,
            startedAt: record.startedAt,
            terminatedAt: record.terminatedAt,
          },
        ];
  });

  const current = stepOrder
    .map((name) => steps.get(name))
    .filter((record): record is MutableStep => record !== undefined)
    .findLast((record) => record.disposition === null && record.startedAt !== null) ?? null;

  return {
    feature,
    runMode,
    autonomy,
    featureState: state,
    progress: {
      currentStep: current?.step ?? null,
      currentStepPhase: current?.phase ?? null,
      nextGate: nextGateFor({ question, state, current }),
      stepsStarted: stepViews.filter((step) => step.startedAt !== null).length,
      stepsCompleted: stepViews.filter((step) => step.disposition === 'completed').length,
      plannedSteps,
      steps: stepViews,
    },
    usage: {
      rateLimitBudgetConsumed,
      startedAt,
      lastActivityAt,
      recordedElapsedMs: elapsedBetween(startedAt, lastActivityAt),
      estimateMs,
    },
    question,
    notices,
    problem: null,
  };
};

/**
 * Read a run's log and fold it, or say plainly why not.
 *
 * The refusal path is the point. `readEventLog` throws on a line that is not whole JSON or not an AD-5
 * envelope, and the matrix is explicit about what a person should then see: the problem stated, the
 * mode still displayed, the shell still up. So the throw is caught here and becomes a field of the
 * view rather than an exception the shell dies of.
 */
export const loadShellView = (
  eventLogPath: string,
  options: { readonly feature?: string | null } = {},
): ShellView => {
  const fallbackFeature = options.feature ?? null;
  try {
    const events = readEventLog(eventLogPath);
    const view = foldEvents(events);
    return view.feature === null && fallbackFeature !== null
      ? { ...view, feature: fallbackFeature }
      : view;
  } catch (thrown: unknown) {
    const why =
      thrown instanceof EventLogCorruptError
        ? thrown.message
        : thrown instanceof Error
          ? thrown.message
          : 'the log could not be read';
    return {
      ...idleShellView(fallbackFeature),
      problem: `This run's event log could not be read, so nothing below is a projection of it: ${why}`,
    };
  }
};
