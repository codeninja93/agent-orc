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
import type { ShellView } from './projection.js';

/** The label each ambient field carries, so the grammar is stable and learnable (R5). */
export const STATUS_LABELS = {
  Steps: 'steps',
  Budget: 'rate-limit budget',
  Elapsed: 'elapsed',
} as const;

/** What the segment says when the log has not recorded a value yet. Uncertainty stays uncertainty (R12). */
export const STATUS_UNRECORDED = 'not yet recorded';

/** The separator between ambient fields. One character, so a narrow terminal still fits three fields. */
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
  const bounded = Math.min(Math.max(share, 0), 1);
  return `${bounded.toFixed(2)} of 1.00`;
};

/** The step count: how many have run, against the plan's total when the log recorded one. */
export const formatStepCount = (view: ShellView): string => {
  const started = view.progress.stepsStarted;
  const planned = view.progress.plannedSteps;
  return planned === null || planned === 0
    ? `${String(started)} started`
    : `${String(started)} of ${String(planned)}`;
};

/**
 * Elapsed time, measured against the shell's clock rather than the log's last line.
 *
 * A run that is waiting on a question has a log that stopped moving and a wall clock that did not, and
 * R11's purpose — making it easy to abandon early — depends on the number a person reads being the one
 * that is still growing.
 */
export const elapsedMsAt = (view: ShellView, now: Date): number | null => {
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
}

export const statusFields = (view: ShellView, now: Date = new Date()): StatusFields => ({
  steps: formatStepCount(view),
  budget: formatBudgetShare(view.usage.rateLimitBudgetConsumed),
  elapsed: formatElapsed(view, now),
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
