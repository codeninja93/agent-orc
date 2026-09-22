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
import { REDACTION_MARKER, readCompleteEventLines } from '../runtime/index.js';
import { EventLogCorruptError } from '../runtime/index.js';
import type {
  EventEnvelope,
  FeatureState,
  RunMode,
  StepDisposition,
  StepPhase,
  StepUsage,
} from '../contracts/index.js';
import {
  DECLARATION_PAYLOAD_KEYS,
  FEATURE_STATES,
  SPEC_CRITERION_EDITED_EVENT_TYPE,
  SPEC_RECORDED_EVENT_TYPE,
  STEP_PHASES,
  USAGE_PAYLOAD_KEY,
  addUsage,
  compareEventOrder,
  usageFromPayload,
} from '../contracts/index.js';

import { DEFAULT_AUTONOMY_MODE, applyCommandToMode, modeForFeatureState } from './mode.js';
import type { AutonomyMode } from './mode.js';

/**
 * The event types this fold acts on, as the log spells them.
 *
 * Declared here rather than imported from the engine, because `src/tui/` may not import `src/engine/` —
 * and the log is data on disk, not an engine API. Every name in this table is one the engine writes today;
 * a name added to the log later is ignored until a story adds it here, which is AD-5 working as intended.
 *
 * The names story 1-11 added are *referenced* from `src/contracts/`, which both layers may import, rather
 * than spelled a third time here. A string a writer and a reader each spell separately is a field that
 * silently stops being read the day one of them changes, which is what this table's own purpose is.
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
  /** CAP-2 — the request and the ordered acceptance criteria, which story 1-11 put in the log. */
  SpecRecorded: SPEC_RECORDED_EVENT_TYPE,
  /** One criterion amended, so the card renders the current text rather than the original. */
  SpecCriterionEdited: SPEC_CRITERION_EDITED_EVENT_TYPE,
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
  HandoffCode: 'handoff_code',
  HandoffReason: 'handoff_reason',
  /** CAP-2 — `spec.recorded`: the user's own words, and the criteria in their declared order. */
  Request: DECLARATION_PAYLOAD_KEYS.Request,
  AcceptanceCriteria: DECLARATION_PAYLOAD_KEYS.AcceptanceCriteria,
  /** `spec.criterion_edited`: which line, and what it now says. */
  CriterionLine: DECLARATION_PAYLOAD_KEYS.CriterionLine,
  CriterionText: DECLARATION_PAYLOAD_KEYS.CriterionText,
  /**
   * `question.asked`, enriched by story 1-11.
   *
   * `offered_options` is a *new* key beside the older `options` string rather than a change to it: AD-5
   * makes adding a key non-breaking and changing one's meaning breaking, so a log written by either build
   * folds here. `Brief` and `AskedAt` are what Q3 and Q2 need from the log alone — the consequence of each
   * option, and the instant a countdown is measured from.
   */
  OfferedOptions: DECLARATION_PAYLOAD_KEYS.OfferedOptions,
  Brief: DECLARATION_PAYLOAD_KEYS.Brief,
  AskedAt: DECLARATION_PAYLOAD_KEYS.AskedAt,
  /** `step.terminated`: what the attempt cost and consumed, when the CLI reported it (R10). */
  Usage: USAGE_PAYLOAD_KEY,
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
 *
 * **The marker is matched anywhere in the value, not only as the whole of it.** `redactString`
 * substitutes the marker *inside* a longer string — AD-21 replaces the credential it found and leaves
 * the sentence around it — so `use [redacted] to auth` is a partly redacted value, and testing for
 * equality read it as ordinary content and leaked the engine's internal marker into prose a person
 * reads. Every occurrence is presented as redaction, and a value that is nothing but the marker reads
 * as one phrase rather than as a sentence with a hole in it.
 */
export const presentValue = (value: string | null): string =>
  value === null
    ? UNRECORDED_PRESENTATION
    : value === REDACTION_MARKER
      ? REDACTED_PRESENTATION
      : value.split(REDACTION_MARKER).join(REDACTED_PRESENTATION);

/** Whether a field's value carries the redaction marker — in whole or in part — rather than content. */
export const isRedacted = (value: string | null): boolean =>
  value?.includes(REDACTION_MARKER) === true;

/**
 * A field presented for a notice: redaction-aware, with a caller's own words when the log has none.
 *
 * `presentValue`'s own `(not recorded)` is right inside a slot that names the field; inside a sentence
 * it is not, which is why each notice keeps the phrase it already read.
 */
/**
 * The one sentence that says a run was handed off and why.
 *
 * Exported so the notice a person reads in the shell's own list and the headline on the handoff card are
 * the same words because they are the same function, rather than because two spellings currently agree.
 */
export const handoffSentence = (handoff: HandoffView): string =>
  `handed off (${presentOr(handoff.code, 'no code recorded')}): ` +
  `${presentOr(handoff.reason, 'no reason recorded')}`;

const presentOr = (value: string | null, fallback: string): string =>
  value === null ? fallback : presentValue(value);

/**
 * The disposition that counts a step as done, read from the contract rather than spelled here.
 *
 * Typed as a `StepDisposition`, so the literal below and `STEP_DISPOSITIONS` cannot drift: renaming the
 * member in `src/contracts/` fails this file's typecheck instead of silently zeroing the completed count
 * in every frame. This is the "read in two places under two spellings" the payload-key table above warns
 * about, applied to a field's *value*.
 */
export const COMPLETED_STEP_DISPOSITION: StepDisposition = 'completed';

/** One step, as the log describes it. Named, never numbered (Consistency Conventions). */
export interface StepView {
  readonly step: string;
  readonly phase: StepPhase | null;
  /**
   * `null` while the step is in flight; every termination records one (AD-8).
   *
   * Deliberately wider than `StepDisposition`: AD-5's ignore-what-you-do-not-know says a newer engine's
   * value must not break this reader, and narrowing it would mean mapping an unrecognised disposition to
   * `null` — which in this fold means *in flight*, so a terminated step would read as still running.
   * Carrying the recorded word is the honest reading; the comparison that matters uses the typed
   * constant above.
   */
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
  /**
   * The run's total, summed over every `step.terminated` that carried one, or `null`.
   *
   * `null` rather than a zero when nothing recorded any, and that distinction is the whole of R8 applied to
   * a number: a step nobody measured is not a step that was free, and `$0.00` is a claim the log never
   * made. {@link addUsage} keeps absence absent through the summation, so two unmeasured steps total to
   * `null` rather than to zero.
   *
   * Every attempt counts, including a failed one and a re-run: what a feature consumed is what it
   * consumed, and a total that only counted successes would under-report a thrashing run.
   */
  readonly total: StepUsage | null;
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

/** One option as the log records it: what it is, what it costs, and whether it is the escape (Q1). */
export interface QuestionOptionView {
  readonly id: string;
  readonly label: string;
  /** Q1 — the consequence of taking this option. Absent from a log an older build wrote. */
  readonly consequence: string;
  /** True for the one option that exists because the concrete ones may all be wrong. */
  readonly escape: boolean;
}

export interface QuestionSlotView {
  readonly state: QuestionSlotState;
  readonly prompt: string | null;
  /** Q3 — the self-contained mini-brief, which story 1-11 put in the log. */
  readonly brief: string | null;
  /** Q1 — every option with its consequence, the escape last and flagged. Empty for an older log. */
  readonly options: readonly QuestionOptionView[];
  /** Q2 — the instant the window starts from, so a card can count down from the log alone. */
  readonly askedAt: string | null;
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
  brief: null,
  options: Object.freeze([]),
  askedAt: null,
  recommendedOptionId: null,
  defaultAction: null,
  defaultWindowMs: null,
  resolver: null,
  answer: null,
  outcome: null,
});

/**
 * Why this run was handed off, as a fact rather than as a sentence in a bounded list.
 *
 * The handoff card used to recover this by scanning {@link ShellView.notices} for the substring
 * `'handed off'`, which is wrong in three ways at once: it matches any *other* notice that happens to
 * contain the words, it falls back silently the day the projection rewords its own notice, and the notice
 * list is bounded by {@link MAX_NOTICES} — so a hand-off followed by four later notices lost the reason
 * entirely, on the one card whose whole purpose is to state it.
 *
 * Folded from `handoff.recorded` **and** from the `handoff_code` / `handoff_reason` a `command.applied`
 * line carries, because both record the same fact and a log written before the engine appended the former
 * on the take-over path carries only the latter (AD-5).
 */
export interface HandoffView {
  /** The AD-35 code, or `null` when the line carried none. */
  readonly code: string | null;
  readonly reason: string | null;
  /** The instant the line was appended. */
  readonly at: string;
}

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

/**
 * One acceptance criterion, as the log records it and as a person addresses it.
 *
 * Numbered from 1 because CAP-2 requires the criteria to be editable line by line, and "that line" is only
 * meaningful if a person and the system agree what it names. `edited` is carried so the card can state that
 * a criterion was amended rather than silently showing different words than the ones first recorded.
 */
export interface SpecCriterionView {
  readonly line: number;
  readonly text: string;
  readonly edited: boolean;
}

/**
 * CAP-2 — what this run is being built against, folded from the log.
 *
 * Before story 1-11 the criteria reached disk only in a step input file and `state.json`, both of which
 * AD-4 ranks below the log — so this was the one required surface a completed run's log could not
 * reconstruct. `recorded` is false for a log written before the type existed, and the spec echo then says
 * so rather than offering to confirm an empty set.
 */
export interface SpecView {
  /** The user's original words, or `null` when the log does not carry them. */
  readonly request: string | null;
  readonly criteria: readonly SpecCriterionView[];
  /** True when a `spec.recorded` line was folded, whatever it carried. */
  readonly recorded: boolean;
}

/** Everything one render needs, and nothing a person would have to know a run id to use. */
export interface ShellView {
  /** The feature, by name. The only identifier a person ever needs (R6). */
  readonly feature: string | null;
  readonly runMode: RunMode;
  readonly autonomy: AutonomyMode;
  readonly featureState: FeatureState | null;
  readonly progress: ProgressView;
  readonly usage: UsageView;
  readonly spec: SpecView;
  readonly question: QuestionSlotView;
  /** Why the run was handed off, when the log says, or `null`. Read by the handoff card (CAP-23). */
  readonly handoff: HandoffView | null;
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
 * The options a `question.asked` payload offers, or an empty list.
 *
 * Read defensively, key by key, and that is not paranoia: AD-5 makes this reader responsible for surviving
 * a payload an older build wrote without the key at all, and a newer one wrote with fields this build does
 * not know. An entry with no id is dropped, because an option nobody can name is not one a person can
 * choose; a missing consequence reads as unrecorded rather than as an empty promise.
 */
const optionList = (payload: Record<string, unknown>, key: string): readonly QuestionOptionView[] => {
  const raw = payload[key];
  if (!Array.isArray(raw)) return [];
  const out: QuestionOptionView[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue;
    const option = entry as Record<string, unknown>;
    const id = option['id'];
    if (typeof id !== 'string' || id === '') continue;
    const label = option['label'];
    const consequence = option['consequence'];
    out.push({
      id,
      label: typeof label === 'string' && label !== '' ? label : id,
      consequence: typeof consequence === 'string' ? consequence : UNRECORDED_PRESENTATION,
      escape: option['escape'] === true,
    });
  }
  return out;
};

/**
 * The criteria a `spec.recorded` payload carries, numbered as a person counts them.
 *
 * **Numbered from the declared position, before anything is dropped.** Filtering first and numbering the
 * survivors renumbered every criterion after an entry this build could not read — a number, a null, a
 * nested object from a writer AD-5 requires this reader to survive — so criterion 4 became criterion 3 and
 * an `edit_criterion` naming a line then amended a different one. A gap in the numbering is honest: it says
 * the log holds an entry at that position that this reader cannot state, and every other line keeps the
 * number the engine's own parse will read back.
 */
const criteriaList = (payload: Record<string, unknown>): readonly SpecCriterionView[] => {
  const raw = payload[TUI_PAYLOAD_KEYS.AcceptanceCriteria];
  if (!Array.isArray(raw)) return [];
  const out: SpecCriterionView[] = [];
  raw.forEach((entry, index) => {
    if (typeof entry !== 'string') return;
    out.push({ line: index + 1, text: entry, edited: false });
  });
  return out;
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

/**
 * A phase the vocabulary declares, or `null` for one this build cannot place.
 *
 * Driven from `STEP_PHASES` rather than from a pair of literals. The literal version read
 * `value === 'implementation' || value === 'verification'`, so story 2-4's `analysis` and `planning` would
 * have rendered as no phase at all — a card silently omitting the phase of every step of the first half of
 * a run, with no test failing, because the two the literals named still worked. A projection derives its
 * vocabulary from the contract; it does not re-spell it.
 */
const stepPhase = (value: string | null): StepPhase | null =>
  value !== null && (STEP_PHASES as readonly string[]).includes(value)
    ? (value as StepPhase)
    : null;

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
 * What a run in each phase is waiting for, in a person's words.
 *
 * A total map over `STEP_PHASES` rather than a conditional, so adding a phase is a type error here and
 * cannot be answered by whichever branch happens to be the `else`.
 */
const NEXT_UP_BY_PHASE: Readonly<Record<StepPhase, string>> = {
  analysis: 'the analysis to state what the work is',
  planning: 'the plan the analysis is turned into',
  implementation: 'the tests the change has to survive',
  testing: 'verification, once the tests are written',
  verification: 'the verification gates',
};

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
      /**
       * What the run is waiting for, said from the phase it is *in* rather than from one of two.
       *
       * The branch this replaced read `phase === 'verification' ? … : 'verification, once the
       * implementation steps are done'`, which was true while a plan held two steps and became a false
       * statement the moment one held four: an `analysis` step took the else branch and the card told a
       * person the implementation steps were done before any had started. Derived from the phase so the
       * next widening of `STEP_PHASES` is a compile error here, not a sentence nobody re-reads.
       */
      // A phase this build cannot place folds to `null` in `stepPhase`, and says so rather than picking
      // a sentence: AD-5's ignore-unknown rule applied to a screen.
      return facts.current.phase === null
        ? 'the next step, whose phase this build does not recognise'
        : NEXT_UP_BY_PHASE[facts.current.phase];
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
  let handoff: HandoffView | null = null;
  /**
   * Every question the log has asked and not yet settled, in the order it asked them.
   *
   * A queue rather than one slot, because R14 gives the *active* question a slot and story 1-8's review
   * established that the engine resolves the **earliest** still-asked question. Overwriting the slot with
   * a second question therefore showed a person the question their next answer would not go to, and made
   * the first one — the one actually being answered — disappear from the only place that reports it. The
   * earliest keeps the slot; a later one is announced and takes the slot when the earlier is settled.
   */
  const pendingQuestions: { id: string | null; slot: QuestionSlotView }[] = [];
  let specRequest: string | null = null;
  let specRecorded = false;
  let totalUsageSoFar: StepUsage | null = null;
  let criteria: readonly SpecCriterionView[] = [];

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
        // R10 — every attempt's usage adds to the run's total, including a failure and a re-run. A
        // termination carrying no usage key adds nothing, which is how the total stays `null` for a run
        // nothing measured rather than becoming a zero nobody claimed.
        totalUsageSoFar = addUsage(totalUsageSoFar, usageFromPayload(payload[TUI_PAYLOAD_KEYS.Usage]));
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
        /**
         * The hand-off a steering command carries, which is where a take-over's reason lives.
         *
         * `command.applied` has carried `handoff_code` and `handoff_reason` since story 1-3 and this fold
         * ignored them, so a run handed off by a person had its reason in the log and nowhere on screen.
         * Read here as well as from `handoff.recorded` so a log written before the engine appended that
         * line on the intent path still states why (AD-5).
         */
        const appliedCode = text(payload, TUI_PAYLOAD_KEYS.HandoffCode);
        if (appliedCode !== null) {
          handoff = {
            code: appliedCode,
            reason: text(payload, TUI_PAYLOAD_KEYS.HandoffReason),
            at: event.ts,
          };
        }
        if (command !== null) {
          // Every interpolated field goes through `presentValue`: AD-21's marker is an *internal* token,
          // and a notice reading "reject applied: [redacted]" would put it in front of a person as if it
          // were the effect. What was redacted is said to have been redacted.
          notice(
            event.ts,
            `${command.replace(/_/g, ' ')} applied: ${presentOr(
              text(payload, TUI_PAYLOAD_KEYS.Effect),
              'acknowledged',
            )}`,
          );
        }
        break;
      }

      case TUI_EVENT_TYPES.CommandRefused: {
        notice(
          event.ts,
          `a control was refused (${presentOr(
            text(payload, TUI_PAYLOAD_KEYS.Reason),
            'no reason recorded',
          )}) — nothing changed`,
        );
        break;
      }

      case TUI_EVENT_TYPES.QuestionAsked: {
        const askedSlot: QuestionSlotView = {
          state: 'pending',
          prompt: text(payload, TUI_PAYLOAD_KEYS.Prompt),
          // Q1–Q3 from the log alone. Each is absent from a log an older engine wrote, and each then
          // folds to its empty value rather than throwing: the card says which part is unrecorded.
          brief: text(payload, TUI_PAYLOAD_KEYS.Brief),
          options: optionList(payload, TUI_PAYLOAD_KEYS.OfferedOptions),
          askedAt: text(payload, TUI_PAYLOAD_KEYS.AskedAt),
          recommendedOptionId: text(payload, TUI_PAYLOAD_KEYS.RecommendedOptionId),
          defaultAction: text(payload, TUI_PAYLOAD_KEYS.DefaultAction),
          defaultWindowMs: num(payload, TUI_PAYLOAD_KEYS.DefaultWindowMs),
          resolver: null,
          answer: null,
          outcome: null,
        };
        pendingQuestions.push({ id: text(payload, TUI_PAYLOAD_KEYS.QuestionId), slot: askedSlot });
        if (pendingQuestions.length === 1) {
          question = askedSlot;
        } else {
          // Announced rather than swapped in. Silence here would be a question a person never learns is
          // waiting, and a slot that changed under them would be the question they are mid-answer to.
          notice(
            event.ts,
            'a second question is waiting behind the one in the slot; it takes the slot once this one ' +
              'is settled',
          );
        }
        break;
      }

      case TUI_EVENT_TYPES.SpecRecorded: {
        /**
         * The later set **replaces** the earlier one.
         *
         * Replacement rather than accumulation, because a second `spec.recorded` is a correction of what
         * the feature is being built against, and a fold that concatenated would show every criterion
         * twice and offer to confirm a set the run never had. Every `edited` flag resets with it: an
         * amendment applies to the criteria that were current when it was made.
         */
        specRecorded = true;
        specRequest = text(payload, TUI_PAYLOAD_KEYS.Request) ?? specRequest;
        criteria = criteriaList(payload);
        break;
      }

      case TUI_EVENT_TYPES.SpecCriterionEdited: {
        const line = num(payload, TUI_PAYLOAD_KEYS.CriterionLine);
        const amended = text(payload, TUI_PAYLOAD_KEYS.CriterionText);
        if (amended === null) break;
        const target = criteria.find((criterion) => criterion.line === line);
        if (line === null || target === undefined) {
          // An amendment naming no line this build can place is stated rather than discarded: Q6 admits
          // free text, so "criterion four" against three criteria is a person's words, not a fault.
          notice(event.ts, `a criterion was amended in words that name no numbered line: ${amended}`);
          break;
        }
        criteria = criteria.map((criterion) =>
          criterion.line === line ? { ...criterion, text: amended, edited: true } : criterion,
        );
        break;
      }

      case TUI_EVENT_TYPES.QuestionResolved:
      case TUI_EVENT_TYPES.QuestionDefaultTaken:
      case TUI_EVENT_TYPES.QuestionDeflected: {
        const questionId = text(payload, TUI_PAYLOAD_KEYS.QuestionId);
        const resolver = text(payload, TUI_PAYLOAD_KEYS.Resolver);
        const answer = text(payload, TUI_PAYLOAD_KEYS.Answer);
        const slotState: QuestionSlotState =
          event.type === TUI_EVENT_TYPES.QuestionDeflected
            ? 'deflected'
            : event.type === TUI_EVENT_TYPES.QuestionDefaultTaken
              ? 'defaulted'
              : 'resolved';
        const settle = (slot: QuestionSlotView): QuestionSlotView => ({
          ...slot,
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
        });

        // An outcome naming no question, or one asked by a log line this view never saw, settles the slot
        // it is holding; an outcome for a question further down the queue must not clear the slot the
        // earliest one holds — two questions in one run would otherwise take turns erasing each other.
        const settledIndex = pendingQuestions.findIndex(
          (entry) => entry.id === null || questionId === null || entry.id === questionId,
        );
        if (settledIndex < 0) {
          if (pendingQuestions.length > 0) {
            notice(event.ts, 'another question was settled');
            break;
          }
          question = settle(question);
          break;
        }
        if (settledIndex > 0) {
          pendingQuestions.splice(settledIndex, 1);
          notice(event.ts, 'another question was settled');
          break;
        }

        const settled = settle(pendingQuestions[0]?.slot ?? question);
        pendingQuestions.shift();
        const next = pendingQuestions[0];
        if (next === undefined) {
          question = settled;
        } else {
          // The slot belongs to the question that is now active (R14), so the outcome of the one that
          // just closed is stated as a notice rather than disappearing with it.
          question = next.slot;
          notice(event.ts, `the question in the slot was settled: ${settled.outcome ?? 'settled'}`);
        }
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
        handoff = {
          code: text(payload, TUI_PAYLOAD_KEYS.Code),
          reason: text(payload, TUI_PAYLOAD_KEYS.Reason),
          at: event.ts,
        };
        notice(event.ts, handoffSentence(handoff));
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
      stepsCompleted: stepViews.filter(
        (step) => step.disposition === COMPLETED_STEP_DISPOSITION,
      ).length,
      plannedSteps,
      steps: stepViews,
    },
    usage: {
      rateLimitBudgetConsumed,
      total: totalUsageSoFar,
      startedAt,
      lastActivityAt,
      recordedElapsedMs: elapsedBetween(startedAt, lastActivityAt),
      estimateMs,
    },
    spec: { request: specRequest, criteria, recorded: specRecorded },
    question,
    handoff,
    notices,
    problem: null,
  };
};

/** What a shell hands the loader: the feature to fall back on, and the frame it is replacing. */
export interface LoadShellViewOptions {
  readonly feature?: string | null;
  /**
   * The view this reader last produced, kept rather than discarded when a read fails.
   *
   * The mode is the reason. A renderer that reset to {@link idleShellView} on a failed read displayed
   * `mode interactive` — the idle default — over a run that was `paused`, `stopped` or `taken-over`,
   * which is exactly the false belief `interface-contract.md` calls the primary interface hazard of a
   * system with autonomy tiers. What the last good fold said is still the best answer available, and it
   * is carried with the problem attached rather than replaced by a default that asserts something
   * untrue.
   */
  readonly previous?: ShellView | null;
}

/** How a frame says its final line was still arriving. Stated, so the person knows it is one behind. */
export const INCOMPLETE_TAIL_PROBLEM =
  "The log's last line was still being appended as this frame was read, so one event is not in it " +
  'yet. Everything below is folded from the lines that are whole.';

/**
 * Read a run's log and fold it, or say plainly why not.
 *
 * Two failure paths, and they are different failures:
 *
 * - **The last line has no newline yet.** That is not corruption, it is the recorder mid-`write`: a
 *   renderer polls the file the recorder appends to (AD-4, AD-29), so meeting a half-written final line
 *   is an ordinary race — the same one the engine's intent reader was given `TORN_INTENT_GRACE_MS` for.
 *   The whole lines are folded and the frame says one is arriving. Before this, the throw landed in the
 *   catch below and the frame reset to an idle view whose autonomy is `interactive`, so a stopped or
 *   paused run read as interactive for that frame — mode confusion produced by a race rather than by a
 *   disagreement with the log.
 * - **A complete line is not whole JSON or not an AD-5 envelope.** Nothing that is still writing
 *   produces one, so it is reported: the matrix is explicit that a person then sees the problem stated,
 *   the mode still displayed and the shell still up. The last good view carries the mode if the caller
 *   has one; only a reader that has never succeeded falls back to idle.
 */
export const loadShellView = (
  eventLogPath: string,
  options: LoadShellViewOptions = {},
): ShellView => {
  const fallbackFeature = options.feature ?? null;
  const named = (view: ShellView): ShellView =>
    view.feature === null && fallbackFeature !== null ? { ...view, feature: fallbackFeature } : view;
  try {
    const read = readCompleteEventLines(eventLogPath);
    const view = named(foldEvents(read.events));
    return read.incompleteTail ? { ...view, problem: INCOMPLETE_TAIL_PROBLEM } : view;
  } catch (thrown: unknown) {
    const why =
      thrown instanceof EventLogCorruptError
        ? thrown.message
        : thrown instanceof Error
          ? thrown.message
          : 'the log could not be read';
    const base = options.previous ?? null;
    return {
      ...(base === null ? idleShellView(fallbackFeature) : named(base)),
      problem: `This run's event log could not be read, so nothing below is a projection of it: ${why}`,
    };
  }
};
