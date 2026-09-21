/**
 * The ambient status segment: step count, consumed rate-limit budget, elapsed against estimate.
 *
 * R10 and R11 are the whole specification. "Consumed rate-limit budget and step count are always
 * visible without issuing a command. Cost is subscription usage, never currency." and
 * "Elapsed-versus-estimate is always visible, so abandoning early is easy." Both are *always*: the
 * segment is part of every frame, in every state, with no command to reveal it.
 *
 * Two things this module refuses to render, and both refusals are the contract's:
 *
 * - **No currency.** AD-24 declares three ceilings — step count, wall-clock and consumed rate-limit
 *   budget — "and no currency dimension". Model usage is prepaid by subscription and costs nothing at
 *   the margin, so a number with a currency mark on it would be a fiction about the thing a person is
 *   deciding with.
 * - **No share of a whole as progress.** R7 makes progress the current step name and the next gate,
 *   which `projection.ts` derives; the budget share this module *does* show is a consumed budget, not
 *   progress, and it is spelled as a ratio against its own ceiling rather than as a claim about how
 *   much of the work is done.
 *
 * Nothing here reads a clock of its own: `now` is passed in, so a frame is reproducible.
 */
import { hasRecordedUsage } from '../contracts/index.js';
import type { StepUsage } from '../contracts/index.js';

import { STOPPED_FEATURE_STATES } from './mode.js';
import { UNRECORDED_PRESENTATION } from './projection.js';
import type { ShellView } from './projection.js';

/** The label each ambient field carries, so the grammar is stable and learnable (R5). */
export const STATUS_LABELS = {
  Steps: 'steps',
  Budget: 'rate-limit budget',
  Elapsed: 'elapsed',
} as const;

/** What the segment says when the log has not recorded a value yet. Uncertainty stays uncertainty (R12). */
export const STATUS_UNRECORDED = 'not yet recorded';

/**
 * The separator between ambient fields.
 *
 * Three characters wide — a space, a middle dot and a space — and the dot is two bytes in UTF-8. The
 * comment here used to say "one character, so a narrow terminal still fits three fields", which was
 * wrong in both halves and mattered in the second: what fits a 40-column terminal is decided by
 * {@link displayWidth} over the composed line, not by a claim about this constant.
 */
export const STATUS_SEPARATOR = ' · ';

const SECOND_MS = 1_000;
const MINUTE_MS = 60 * SECOND_MS;
const HOUR_MS = 60 * MINUTE_MS;

/**
 * A duration a person reads at a glance: `4s`, `3m12s`, `2h05m`.
 *
 * Coarse on purpose. The decision R11 exists to support is "is this worth abandoning", and a duration
 * to the millisecond answers a question nobody asked while making the segment wider than a narrow
 * terminal has room for.
 */
export const formatDuration = (milliseconds: number | null): string => {
  if (milliseconds === null || !Number.isFinite(milliseconds) || milliseconds < 0) {
    return STATUS_UNRECORDED;
  }
  // Written as subtraction rather than with a remainder operator on purpose: the operator's character
  // is the one this story's verification greps `src/tui/` for, because progress must never be rendered
  // as a share of a whole (R7). Keeping the character out of the directory makes that grep meaningful.
  const totalSeconds = Math.floor(milliseconds / SECOND_MS);
  if (milliseconds < MINUTE_MS) return `${String(totalSeconds)}s`;
  const totalMinutes = Math.floor(milliseconds / MINUTE_MS);
  if (milliseconds < HOUR_MS) {
    const seconds = totalSeconds - totalMinutes * 60;
    return `${String(totalMinutes)}m${String(seconds).padStart(2, '0')}s`;
  }
  const hours = Math.floor(milliseconds / HOUR_MS);
  const minutes = totalMinutes - hours * 60;
  return `${String(hours)}h${String(minutes).padStart(2, '0')}m`;
};

/**
 * The consumed share of the rate-limit budget, as a ratio against its ceiling.
 *
 * Spelled `0.42 of 1.00` rather than as a share out of a hundred, and never with a currency mark: the
 * number is a subscription's rate limit being used up, which is the only cost dimension AD-24 admits.
 */
export const formatBudgetShare = (share: number | null): string => {
  if (share === null || !Number.isFinite(share)) return STATUS_UNRECORDED;
  if (share < 0 || share > 1) {
    /**
     * Out of range is reported, not clamped.
     *
     * Clamping turned a figure recorded on some other scale — a later story emitting `42` for 42 parts in
     * a hundred is the obvious one — into `1.00 of 1.00`, a value that is in range, plausible, and a
     * fiction. R12 is explicit that uncertainty is surfaced as uncertainty rather than as a confident
     * wrong answer, and this is the ambient number a person decides whether to abandon a run by. The
     * recorded figure is shown as recorded, and said to be outside the scale AD-24 declares.
     */
    return `${share.toFixed(2)} of 1.00 — outside the 0 to 1 scale this is recorded on`;
  }
  return `${share.toFixed(2)} of 1.00`;
};

/**
 * Group a count with thin separators, so five figures are readable at a glance rather than counted.
 *
 * Written with a plain comma rather than a locale format, because the same terminal has to show the same
 * string on every machine: a frame whose width depends on the reader's locale is a frame whose 40-column
 * bound is untested.
 */
const grouped = (count: number): string => {
  const digits = Math.trunc(Math.abs(count)).toString();
  const chunks: string[] = [];
  for (let at = digits.length; at > 0; at -= 3) chunks.unshift(digits.slice(Math.max(at - 3, 0), at));
  return `${count < 0 ? '-' : ''}${chunks.join(',')}`;
};

/**
 * The token counts one usage record reports, or that it reports none.
 *
 * **This is what "cost" is on a surface, and it is deliberately not money.** R10 is explicit — "Cost is
 * subscription usage, never currency" — and AD-24 gives a run three ceilings "and no currency dimension".
 * Model usage is prepaid by subscription and costs nothing at the margin, so a figure with a currency mark
 * on it would be a fiction about the thing a person is deciding with. The CLI's own `total_cost_usd` is
 * recorded in the log because story 2-9's ceilings and story 3-3's measurement are specified to read it,
 * and it is rendered here and in no other segment: nowhere at all.
 *
 * The counts are stated in the order a person reads them — what went in, what came out, then what the cache
 * did — which is not `STEP_USAGE_FIELDS`' order and deliberately so: that list is every field once,
 * for a reader that must not miss one, and this is a sentence.
 *
 * An unrecorded field is omitted from the phrase rather than printed as `0`: a count nobody measured is not
 * a count of nothing (R8, R12). A record with nothing in it reads `(not recorded)`.
 */
export const formatTokenUsage = (usage: StepUsage | null): string => {
  if (!hasRecordedUsage(usage) || usage === null) return UNRECORDED_PRESENTATION;
  const parts = [
    usage.input_tokens === null ? null : `${grouped(usage.input_tokens)} in`,
    usage.output_tokens === null ? null : `${grouped(usage.output_tokens)} out`,
    usage.cache_read_input_tokens === null
      ? null
      : `${grouped(usage.cache_read_input_tokens)} cache read`,
    usage.cache_creation_input_tokens === null
      ? null
      : `${grouped(usage.cache_creation_input_tokens)} cache written`,
  ].filter((part): part is string => part !== null);
  return parts.length === 0
    ? // The CLI reported a cost and no token counts, which is a real shape. The cost is not rendered
      // anywhere (R10), so this phrase is all a person gets, and it says plainly that the counts are absent.
      'no token counts recorded'
    : `${parts.join(' · ')} tokens`;
};

/**
 * Why there is no cost formatter here.
 *
 * The CLI's `total_cost_usd` IS recorded, by story 1-11, because AD-24's ceilings and stage 3's
 * measurement both read the log. It is deliberately never rendered. R10 is unconditional — "cost is
 * subscription usage, never currency" — and a line reading `0.0396 usd` is a currency amount whether or
 * not a `$` precedes it. Recording a figure and showing it are different acts, and only the second is what
 * R10 governs. What a person sees is the consumed rate-limit budget and the token counts.
 */

/** The step count: how many have run, against the plan's total when the log recorded one. */
export const formatStepCount = (view: ShellView): string => {
  const started = view.progress.stepsStarted;
  const planned = view.progress.plannedSteps;
  return planned === null || planned === 0
    ? `${String(started)} started`
    : `${String(started)} of ${String(planned)}`;
};

/**
 * Elapsed time: the shell's clock while the run is in flight, the log's own span once it has finished.
 *
 * Both halves are R11. A run waiting on a question has a log that stopped moving and a wall clock that
 * did not, and "abandoning early is easy" depends on the number a person reads being the one that is
 * still growing — so while the run is live the clock wins. A run that has reached a terminal state is
 * not taking any more time, and measuring it against `now` made a four-second committed run read
 * `elapsed 26h00m` the next day: an elapsed that keeps growing after the work stopped is not an elapsed,
 * and it is the figure a person would judge the next run's estimate by.
 */
export const elapsedMsAt = (view: ShellView, now: Date): number | null => {
  const finished =
    view.featureState !== null && STOPPED_FEATURE_STATES.includes(view.featureState);
  // A terminal run whose log recorded no span at all still says what it can rather than nothing.
  if (finished && view.usage.recordedElapsedMs !== null) return view.usage.recordedElapsedMs;
  if (view.usage.startedAt === null) return view.usage.recordedElapsedMs;
  const start = Date.parse(view.usage.startedAt);
  if (Number.isNaN(start)) return view.usage.recordedElapsedMs;
  return Math.max(now.getTime() - start, 0);
};

/** Elapsed against estimate, as one phrase, stating plainly when there is no estimate to compare to. */
export const formatElapsed = (view: ShellView, now: Date): string => {
  const elapsed = formatDuration(elapsedMsAt(view, now));
  // Nothing to compare against says so once, not twice: a run whose log has recorded no instant has no
  // elapsed *and* no estimate, and saying both would be noise where the sentence is already complete.
  if (elapsed === STATUS_UNRECORDED) return elapsed;
  return view.usage.estimateMs === null
    ? `${elapsed}, no estimate recorded`
    : `${elapsed} of ~${formatDuration(view.usage.estimateMs)} estimated`;
};

/** The three ambient values, as facts, so a suite asserts the values and not the punctuation. */
export interface StatusFields {
  readonly steps: string;
  readonly budget: string;
  readonly elapsed: string;
  /** The consumed token counts the log recorded, or `(not recorded)` (R10). */
  readonly tokens: string;
}

export const statusFields = (view: ShellView, now: Date = new Date()): StatusFields => ({
  steps: formatStepCount(view),
  budget: formatBudgetShare(view.usage.rateLimitBudgetConsumed),
  elapsed: formatElapsed(view, now),
  tokens: formatTokenUsage(view.usage.total),
});

/**
 * The always-visible segment, in one line.
 *
 * All three fields are always present, including when a value has not been recorded — a field that
 * disappeared when its value was unknown would make "always visible" untrue exactly when a person is
 * most likely to be deciding whether to wait.
 */
export const formatStatusSegment = (view: ShellView, now: Date = new Date()): string => {
  const fields = statusFields(view, now);
  return [
    `${STATUS_LABELS.Steps} ${fields.steps}`,
    // "consumed" belongs to a number: a budget that has not been recorded has consumed nothing yet, and
    // saying "not yet recorded consumed" would be a sentence nobody reads twice.
    view.usage.rateLimitBudgetConsumed === null
      ? `${STATUS_LABELS.Budget} ${fields.budget}`
      : `${STATUS_LABELS.Budget} ${fields.budget} consumed`,
    `${STATUS_LABELS.Elapsed} ${fields.elapsed}`,
  ].join(STATUS_SEPARATOR);
};
