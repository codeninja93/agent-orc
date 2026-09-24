/**
 * Story 3-3 — "how often does the pipeline need a do-over": the stage-3 gate's rework rate.
 *
 * **A fold over lines the log already carries, never a counter**, in `deflectionRate`'s own idiom
 * (`src/engine/deflection-rate.ts`): order by `seq`, walk once, derive. No new event type is needed
 * because rework is already durably distinguishable in the existing step-attempt vocabulary — a fresh
 * `step.started` for a step name only ever follows a genuine redo, never a resume.
 *
 * **A step is reworked when its final `attempts` count is greater than one** — exactly the count
 * `rebuild.ts`'s `StepStarted` case already keeps, one per `step.started` line folded for that step name
 * *within one run's own `RunState`*. This is standalone rather than a consumer of `RunState`, the same way
 * `deflectionRate` is: importing `rebuildFromLog` here would pull in a `FeaturePlan` and a checkpoint shape
 * this fold has no use for, to recompute a count `rebuild.ts`'s own case already shows how to take.
 *
 * **The internal map is keyed by `(event.run, event.step)`, never by step name alone.** A step name
 * (`implement`, `verify`, ...) is identical across every run of every feature, and this fold's own
 * docblock (in `deflectionRate`'s words) invites folding several runs' events together for one feature.
 * `deflectionRate` can do that safely because it keys by a globally-unique `questionId`; a step name is
 * not unique across runs, so a fold keyed by name alone would report two separate runs' single,
 * unreworked `implement` attempts as one step started twice — a false rework the moment a live run and a
 * later re-attempt or shadow of the same feature are folded together (matrix row 18).
 *
 * **A resume never adds a `step.started` line, and that is the whole mechanism.** AD-8's resume path is
 * `step.resume_attempted`, which continues the same attempt; only `step.baseline_reset` (AD-26's
 * reset-and-rerun) or `step.tier_promoted` (a model-ladder promotion) are followed by a fresh
 * `step.started`, and either is what "reworked" means here. A step interrupted and resumed to completion
 * with no reset or promotion therefore counts as not reworked, having started exactly once.
 *
 * **"No steps started" is not "none reworked".** A feature that never started a step has no rate to
 * report — 0 reworked of 0 total is not 0%, and reporting it as 0% would claim a measurement that was
 * never taken. So the result is a tagged union, matching `DeflectionRate`'s own shape, and the
 * inapplicable arm carries no `rate` field at all for a reader to mistake for one.
 */
import { compareEventOrder } from '../contracts/index.js';
import type { EventEnvelope } from '../contracts/index.js';

import { ENGINE_EVENT_TYPES } from './rebuild.js';

/** A rework rate that was measured: at least one step started. */
export interface MeasuredReworkRate {
  readonly kind: 'measured';
  readonly feature: string;
  /** Distinct step names that emitted at least one `step.started` for this feature. */
  readonly totalSteps: number;
  /** Steps whose final `attempts` count is greater than one. */
  readonly reworkedSteps: number;
  /** `reworkedSteps / totalSteps`, between 0 and 1. */
  readonly rate: number;
  /** R3 — one line that stands alone. */
  readonly summary: string;
}

/** A feature that never started a step, for which a rework rate does not exist. */
export interface InapplicableReworkRate {
  readonly kind: 'inapplicable';
  readonly feature: string;
  readonly totalSteps: 0;
  /** R3 — one line that stands alone, and says why there is no number. */
  readonly summary: string;
}

export type ReworkRate = MeasuredReworkRate | InapplicableReworkRate;

/**
 * The rework rate of one feature, folded from its events.
 *
 * The feature is read from the envelope, exactly as `deflectionRate` reads it, so events from several
 * runs or several features can be handed in together and each feature is measured over its own lines
 * only. Only `event.step` (never a payload field) identifies which step a line is about, matching every
 * other fold in this codebase's own convention that an identifier travels in an envelope field.
 */
export const reworkRate = (events: readonly EventEnvelope[], feature: string): ReworkRate => {
  // Keyed by run, then by step name within that run — a nested map rather than a single map keyed by a
  // composite string, so two different runs' `implement` steps are two different slots by construction
  // and can never collide on a shared key.
  const attemptsByRun = new Map<string, Map<string, number>>();
  for (const event of [...events].sort(compareEventOrder)) {
    if (event.feature !== feature) continue;
    if (event.type !== ENGINE_EVENT_TYPES.StepStarted) continue;
    const step = event.step;
    if (step === null) continue;
    const attempts = attemptsByRun.get(event.run) ?? new Map<string, number>();
    attempts.set(step, (attempts.get(step) ?? 0) + 1);
    attemptsByRun.set(event.run, attempts);
  }

  let totalSteps = 0;
  let reworkedSteps = 0;
  for (const attempts of attemptsByRun.values()) {
    totalSteps += attempts.size;
    for (const count of attempts.values()) {
      if (count > 1) reworkedSteps += 1;
    }
  }

  if (totalSteps === 0) {
    return {
      kind: 'inapplicable',
      feature,
      totalSteps: 0,
      summary: `${feature} never started a step, so it has no rework rate.`,
    };
  }

  return {
    kind: 'measured',
    feature,
    totalSteps,
    reworkedSteps,
    rate: reworkedSteps / totalSteps,
    summary: `${feature} reworked ${String(reworkedSteps)} of ${String(totalSteps)} steps.`,
  };
};
