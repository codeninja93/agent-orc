/**
 * AD-24 — run ceilings: three of them, degradation at eighty percent of any one, hibernation on reaching
 * one. CAP-16's "halts and notifies instead of continuing", as arithmetic the reconciler can ask.
 *
 * This module is the *decision*, and it is pure: it measures what a run has consumed, compares it against
 * what the run was allowed, and says `within`, `degrade` or `hibernate`. It opens no file and starts
 * nothing. The reconciler owns acting on the answer — the `budget.degraded` line, the state change, the
 * escape hatch — because AD-7 puts every action in one loop and AD-29 gives the log one writer.
 *
 * Four things are load-bearing, and each is a place the obvious code goes wrong:
 *
 * **The boundary is exact, and it is integer arithmetic.** Eighty percent is the trigger, not the last
 * safe point, so a run sitting *on* it degrades; and a run sitting on its ceiling hibernates rather than
 * degrading a second time. Computed as `consumed × 100 ≥ ceiling × percent` over whole numbers, never as
 * `consumed / ceiling ≥ 0.8`: the quotient is the kind of floating-point value that reads `0.7999999…` for
 * a run that is exactly at eighty percent, and the boundary is precisely where that rounding would decide.
 *
 * **Wall-clock is the run's own, from `run.created`, less the time it waited on a person.** A run slowed by
 * one long step and a run slowed by many quick ones must trip the same ceiling, so elapsed time is measured
 * from the run's recorded start — the fold sets `created_at` from the `run.created` line — and never from when
 * the current step began. Time in `drafting` or `blocked` is subtracted: see {@link PERSON_WAITING_STATES}.
 *
 * **Consumed rate-limit budget is read, never assumed, and is never money.** It is the token counts the CLI
 * reported on each `step.terminated` line, summed the way story 2-7's note totals are, as a share of the
 * run's declared allowance. AD-24 gives a run "no currency dimension" and R10 makes usage subscription
 * usage, so the one non-token figure the CLI reports is not read here at all.
 *
 * **An unreadable measurement is treated as reached.** `NaN ≥ x` is false, so a wall clock computed from
 * a timestamp that did not parse, or a ceiling of zero, would sail past every comparison and leave a run
 * with no ceiling at all. That is the direction `promotionFor` refuses for its count, for the same reason:
 * the only safe reading of "I cannot tell how much is left" is "none is".
 */
import {
  BUDGET_EXHAUSTED_EVENT_TYPE,
  BUDGET_PAYLOAD_KEYS,
  CEILING_DIMENSIONS,
  GATE_FAILED_EVENT_TYPE,
  GATE_PASSED_EVENT_TYPE,
  GATE_SKIPPED_EVENT_TYPE,
  MODEL_RUNGS,
  PLACEHOLDER_RATE_LIMIT_WINDOW_TOKENS,
  USAGE_PAYLOAD_KEY,
  isModelRung,
  totalUsage,
  usageFromPayload,
} from '../contracts/index.js';
import type {
  Budget,
  CeilingDimension,
  Ceilings,
  EventEnvelope,
  FeatureState,
  GateResult,
  ModelRung,
  RunState,
  StepPhase,
  StepUsage,
} from '../contracts/index.js';

import { COMMAND_EVENT_TYPES } from './commands.js';
import { LOWEST_MODEL_RUNG, ModelRungUnrecognised } from './promotion.js';
import { ENGINE_EVENT_TYPES } from './rebuild.js';

/**
 * The wall-clock ceiling a run falls back to when its configuration snapshot declares none.
 *
 * Story 1-3 declared this as the allowance a step input carried "so the contract is satisfied", an
 * unchanging constant with a comment saying story 2-9 would replace it. It is not replaced so much as
 * given its job: it is now a *ceiling* a real elapsed duration is compared against, and the declared
 * `ceilings.wall_clock_minutes` of the run's AD-9 snapshot takes precedence wherever one exists.
 */
export const DECLARED_WALL_CLOCK_MS = 60 * 60 * 1000;

/**
 * The ceilings a run with no declared ceilings is held to: AD-24 says *every* run carries three.
 *
 * A run reaches this only when its AD-9 snapshot holds no profile at all — which production does not
 * produce, since the installer writes `ceilings` into every profile and the spawn refuses a run with no
 * snapshot. It is not a default invented to be convenient: an absent declaration answered with *no*
 * ceiling would be the one reading of AD-24 that lets a run go on for ever. The step and rate-limit values
 * are the installer's own suggested answers; the wall clock is {@link DECLARED_WALL_CLOCK_MS}; the window
 * size is the profile's own placeholder default.
 */
export const DECLARED_FALLBACK_CEILINGS: Ceilings = Object.freeze({
  steps: 60,
  wall_clock_minutes: DECLARED_WALL_CLOCK_MS / 60_000,
  rate_limit_budget_percent: 50,
  // No profile means nobody declared a window either, so the run gets the same placeholder a profile
  // would have defaulted to — named in `src/contracts/installer.ts` as a placeholder, not a measurement.
  rate_limit_window_tokens: PLACEHOLDER_RATE_LIMIT_WINDOW_TOKENS,
});

/**
 * Eighty percent of any one ceiling degrades the run (AD-24). A percent, compared as a whole number.
 *
 * Inclusive: a run *at* eighty percent degrades. The spine's word is "at", and the matrix pins the
 * boundary itself (row 15), because the last safe point and the trigger are different claims.
 */
export const DEGRADATION_THRESHOLD_PERCENT = 80;

/** Reaching a ceiling — one hundred percent of it, inclusive — hibernates the run (AD-24, row 16). */
export const HIBERNATION_THRESHOLD_PERCENT = 100;

/** A run's three ceilings, each in the unit its consumption is measured in. */
export interface RunCeilings {
  /** Step attempts: every start, re-run and resume the executor was handed. */
  readonly steps: number;
  readonly wallClockMs: number;
  /** The profile's declared size of one rate-limit window, in tokens. */
  readonly rateLimitWindowTokens: number;
  /** The share of that window this run may consume, in whole percent. */
  readonly rateLimitPercent: number;
}

/**
 * The declared ceilings, in the units they are compared in.
 *
 * The rate-limit allowance is kept as its two declared factors rather than multiplied out here: a window a
 * person declared need not be a multiple of a hundred, so `window × percent / 100` can be a fraction, and the
 * boundary comparison must never meet one. {@link readCeilings} compares in hundredths of a token instead.
 */
export const runCeilingsFrom = (declared: Ceilings): RunCeilings => ({
  steps: declared.steps,
  wallClockMs: declared.wall_clock_minutes * 60_000,
  rateLimitWindowTokens: declared.rate_limit_window_tokens,
  rateLimitPercent: declared.rate_limit_budget_percent,
});

/** What a run has consumed against its three ceilings, as the log and the clock say. */
export interface RunConsumption {
  /** Step attempts so far, summed over every step record. */
  readonly steps: number;
  /** Milliseconds since the run's own recorded start, less time spent waiting on a person. */
  readonly wallClockMs: number;
  /**
   * Tokens the CLI reported across every attempt, or `null` when no attempt reported any.
   *
   * `null` rather than zero, because absence is absence (R8). It is *compared* as zero — nothing recorded
   * can be held against a ceiling — but a surface that states it says "not recorded", not "none consumed".
   */
  readonly rateLimitTokens: number | null;
}

/**
 * The token counts held against the rate-limit budget: fresh input, output, and cache writes.
 *
 * Listed rather than derived from `STEP_USAGE_FIELDS`, because that list also holds the one figure that is
 * not a token count, and reading "every field" here would put that figure into a ceiling AD-24 says has no
 * such dimension.
 *
 * **`cache_read_input_tokens` is deliberately not counted.** A multi-turn `claude -p` session re-reads its
 * whole cached context on every turn, so cache reads grow with the *length of a conversation* rather than
 * with the work done, and routinely outnumber every other figure by an order of magnitude. Counted at full
 * weight against a placeholder window they would degrade ordinary runs for reasons unrelated to what they
 * consumed; weighted, they would need a discount factor nobody has published. Leaving them out undercounts
 * rather than overcounts, and the three that remain are unweighted — no factor is invented here.
 */
const TOKEN_FIELDS = [
  'input_tokens',
  'output_tokens',
  'cache_creation_input_tokens',
] as const satisfies readonly (keyof StepUsage)[];

const tokensIn = (usage: StepUsage | null): number | null => {
  if (usage === null) return null;
  const counted = TOKEN_FIELDS.map((field) => usage[field]).filter(
    (value): value is number => value !== null,
  );
  return counted.length === 0 ? null : counted.reduce((sum, value) => sum + value, 0);
};

/**
 * The states in which a run is waiting on a person, and its wall clock is therefore stopped.
 *
 * `drafting` waits for the criteria to be confirmed (CAP-2) and `blocked` for a gate to be approved (CAP-12).
 * Neither spends anything, and the ceilings are only asked before a spend — so counting them let a run sit
 * blocked overnight, accrue its whole allowance unchecked, and hibernate on the first pass after the person
 * approved it, having done no work in that time. AD-24's wall clock bounds how long a run *works*.
 * `interrupted` is not here: a crashed engine or a closed laptop is the run's own time lost, not a person's.
 *
 * Story 2-11 adds `awaiting_merge`: the run's push and pull request have landed and the only thing left is
 * a person merging it, exactly the same shape as `blocked` waiting on an approval — the run is not doing
 * anything, so its wait costs nothing against the ceiling that bounds how long a run *works*.
 */
export const PERSON_WAITING_STATES: readonly FeatureState[] = ['drafting', 'blocked', 'awaiting_merge'];

const stringField = (event: EventEnvelope, key: string): string | null => {
  const value = event.payload[key];
  return typeof value === 'string' ? value : null;
};

/**
 * Milliseconds the run has spent in {@link PERSON_WAITING_STATES}, read from its lifecycle lines.
 *
 * Every line that moves the feature state is read in `seq` order — `run.created` enters `drafting`,
 * `feature.state_changed` and a steering `command.applied` carry the state entered — and each interval that
 * began in a waiting state is summed, including the one still open at `now`.
 */
const personWaitingMs = (events: readonly EventEnvelope[], now: Date): number => {
  let current: string | null = null;
  let since = Number.NaN;
  let total = 0;
  const waiting = (state: string | null): boolean =>
    state !== null && (PERSON_WAITING_STATES as readonly string[]).includes(state);
  for (const event of [...events].sort((left, right) => left.seq - right.seq)) {
    const entered =
      event.type === ENGINE_EVENT_TYPES.RunCreated
        ? 'drafting'
        : event.type === ENGINE_EVENT_TYPES.FeatureStateChanged
          ? stringField(event, 'to')
          : event.type === COMMAND_EVENT_TYPES.Applied
            ? stringField(event, 'to_state')
            : null;
    if (entered === null) continue;
    const at = Date.parse(event.ts);
    if (waiting(current)) total += at - since;
    current = entered;
    since = at;
  }
  if (waiting(current)) total += now.getTime() - since;
  return total;
};

/**
 * Measure a run's consumption from its checkpoint, its log and the clock.
 *
 * **Every attempt counts, including a failed one.** A step that failed after twenty turns consumed exactly
 * what one that succeeded did, which is why story 1-11 records usage on every disposition; a ceiling that
 * read only completions would under-count precisely the thrashing run it exists to stop.
 *
 * **Each `step.terminated` figure is summed once, as the CLI reported it for that one process.** Whether a
 * resumed session's result line reports that invocation alone or the whole session is not established — no
 * successful resume has been recorded in this repository. It cannot double-count by construction today: a
 * resume only follows an `interrupted` attempt, and an attempt interrupted by a signal has no result line and
 * so records no usage. The one exception is a timed-out attempt whose result line had already arrived; if a
 * resumed result proves cumulative, that case over-counts, and this sum is where it would be corrected. A
 * killed or crashed attempt records nothing and so adds nothing — undercounting what it spent, which is the
 * known, documented cost of reading only what the CLI reported.
 */
export const measureConsumption = (request: {
  readonly state: RunState;
  readonly events: readonly EventEnvelope[];
  readonly now: Date;
}): RunConsumption => ({
  steps: request.state.steps.reduce((sum, record) => sum + record.attempts, 0),
  // `created_at` is the `run.created` line's timestamp — the fold assigns it from that line — so this is
  // the run's clock and not any one step's `started_at`, less the time it spent waiting on a person.
  wallClockMs:
    request.now.getTime() -
    Date.parse(request.state.created_at) -
    personWaitingMs(request.events, request.now),
  rateLimitTokens: tokensIn(
    totalUsage(
      request.events
        .filter((event) => event.type === ENGINE_EVENT_TYPES.StepTerminated)
        .map((event) => usageFromPayload(event.payload[USAGE_PAYLOAD_KEY])),
    ),
  ),
});

/** One ceiling, read: what was consumed against what was allowed. */
export interface CeilingReading {
  readonly dimension: CeilingDimension;
  readonly consumed: number;
  readonly ceiling: number;
  /**
   * `consumed / ceiling`, for a person and a payload to read — **never** for the decision.
   *
   * Reported unclamped, so an overshoot says it was one (R12). The decision uses {@link atLeast}, whose
   * integer comparison is exact at the boundary where this quotient is not.
   */
  readonly fraction: number;
  /**
   * False when the consumption or the ceiling is not a number that can be compared — a ceiling of zero, a
   * timestamp that did not parse. Such a reading is decided as reached (see {@link atLeast}), its `fraction`
   * is set to exactly `1` so the log says "reached" rather than serialising `NaN` or `Infinity` as `null`,
   * and this flag travels in the payload so a reader can tell a measured one hundred percent from this.
   */
  readonly measurable: boolean;
  /**
   * The same comparison in whole numbers, scaled by a common factor — what {@link atLeast} decides on.
   *
   * Equal to `consumed` and `ceiling` for steps and wall clock. For the rate-limit budget both are in
   * hundredths of a token, so a declared window that is not a multiple of a hundred still yields an
   * integer allowance and the eighty-percent boundary is decided exactly.
   */
  readonly scaled: { readonly consumed: number; readonly ceiling: number };
}

const readingOf = (
  dimension: CeilingDimension,
  consumed: number,
  ceiling: number,
  scale: { readonly consumed: number; readonly ceiling: number } = { consumed, ceiling },
): CeilingReading => {
  const measurable =
    Number.isFinite(scale.consumed) && Number.isFinite(scale.ceiling) && scale.ceiling > 0;
  return {
    dimension,
    consumed,
    ceiling,
    fraction: measurable ? scale.consumed / scale.ceiling : 1,
    measurable,
    scaled: scale,
  };
};

/** Read all three ceilings, in {@link CEILING_DIMENSIONS} order. */
export const readCeilings = (
  consumption: RunConsumption,
  ceilings: RunCeilings,
): readonly CeilingReading[] =>
  CEILING_DIMENSIONS.map((dimension) => {
    switch (dimension) {
      case 'steps':
        return readingOf(dimension, consumption.steps, ceilings.steps);
      case 'wall_clock':
        return readingOf(dimension, consumption.wallClockMs, ceilings.wallClockMs);
      case 'rate_limit_budget': {
        const tokens = consumption.rateLimitTokens ?? 0;
        const allowanceHundredths = ceilings.rateLimitWindowTokens * ceilings.rateLimitPercent;
        return readingOf(dimension, tokens, allowanceHundredths / 100, {
          consumed: tokens * 100,
          ceiling: allowanceHundredths,
        });
      }
    }
  });

/**
 * True when a reading has reached `percent` of its ceiling, inclusive, decided exactly.
 *
 * A ceiling that is not a positive finite number, or a consumption that is not a finite number, reads as
 * reached — the fail-safe direction this module's header gives the reason for.
 */
export const atLeast = (reading: CeilingReading, percent: number): boolean => {
  if (!reading.measurable) return true;
  return reading.scaled.consumed * 100 >= reading.scaled.ceiling * percent;
};

/** What the ceilings say about a run's next spending action. */
export type CeilingVerdict =
  | { readonly kind: 'within'; readonly readings: readonly CeilingReading[] }
  | {
      readonly kind: 'degrade' | 'hibernate';
      /** The ceiling that decided it: the fullest one past the threshold, ties to the declared order. */
      readonly reading: CeilingReading;
      readonly readings: readonly CeilingReading[];
    };

/**
 * `hibernate` when any ceiling is reached, else `degrade` when any is at eighty percent, else `within`.
 *
 * Hibernation is asked first, and that order is row 16: a run exactly at a ceiling is past eighty percent
 * too, and answering `degrade` for it would be the "degrades a second time" the matrix rules out.
 */
export const ceilingVerdict = (readings: readonly CeilingReading[]): CeilingVerdict => {
  const fullest = (percent: number): CeilingReading | null =>
    readings
      .filter((reading) => atLeast(reading, percent))
      .reduce<CeilingReading | null>(
        // Strictly greater, so a tie keeps the earlier reading: `CEILING_DIMENSIONS` order decides it.
        (best, reading) => (best === null || reading.fraction > best.fraction ? reading : best),
        null,
      );
  const reached = fullest(HIBERNATION_THRESHOLD_PERCENT);
  if (reached !== null) return { kind: 'hibernate', reading: reached, readings };
  const close = fullest(DEGRADATION_THRESHOLD_PERCENT);
  if (close !== null) return { kind: 'degrade', reading: close, readings };
  return { kind: 'within', readings };
};

const readingFor = (readings: readonly CeilingReading[], dimension: CeilingDimension): CeilingReading | null =>
  readings.find((reading) => reading.dimension === dimension) ?? null;

/**
 * The step input's `budget`, from the same readings the decision was made from.
 *
 * `steps_remaining` is passed in unchanged: it has always been computed from the plan — declared steps less
 * completed ones — which is a different question from the step-attempt ceiling, and matrix row 14 keeps it.
 *
 * The other two are clamped into `BudgetSchema`'s bounds, and only here. A step input is only ever written
 * for a run the verdict let continue, so a reading past its ceiling cannot legitimately reach this; the clamp
 * is what keeps a clock that moved between the verdict and the write from making the input unparseable, not
 * a way of reporting an overshoot as something else — the `budget.exhausted` payload carries it unclamped.
 */
export const budgetFrom = (stepsRemaining: number, readings: readonly CeilingReading[]): Budget => {
  const wall = readingFor(readings, 'wall_clock');
  const rate = readingFor(readings, 'rate_limit_budget');
  const remaining = wall === null ? 0 : wall.ceiling - wall.consumed;
  const share = rate === null ? 0 : rate.fraction;
  return {
    steps_remaining: stepsRemaining,
    wall_clock_ms_remaining: Number.isFinite(remaining) ? Math.max(remaining, 0) : 0,
    rate_limit_budget_consumed: Number.isFinite(share) ? Math.min(Math.max(share, 0), 1) : 1,
  };
};

/** One sentence naming which ceiling decided, and by how much, for the log and the hand-off document. */
export const describeReading = (reading: CeilingReading): string => {
  if (!reading.measurable) {
    return (
      `the ${reading.dimension.replace(/_/g, '-')} ceiling could not be measured — its consumption or its ` +
      'declared limit is not a comparable number — so it is treated as reached rather than as absent'
    );
  }
  const percent = Number.isFinite(reading.fraction) ? Math.floor(reading.fraction * 100) : 100;
  switch (reading.dimension) {
    case 'steps':
      return (
        `the run has spent ${String(reading.consumed)} of its ${String(reading.ceiling)} step attempts ` +
        `(${String(percent)}% of the step ceiling)`
      );
    case 'wall_clock':
      return (
        `the run has been going ${String(Math.floor(reading.consumed / 60_000))} of its ` +
        `${String(Math.floor(reading.ceiling / 60_000))} wall-clock minutes (${String(percent)}% of the ` +
        'wall-clock ceiling, measured from the run’s own start)'
      );
    case 'rate_limit_budget':
      return (
        `the run has consumed ${String(reading.consumed)} of the ${String(reading.ceiling)} tokens its ` +
        `rate-limit budget allows (${String(percent)}% of that ceiling)`
      );
  }
};

// -------------------------------------------------------------------------------------------------
// Degradation's two effects: a lower rung, and no model-judged review
// -------------------------------------------------------------------------------------------------

/** What a budget-triggered downshift decided. */
export interface DownshiftDecision {
  readonly from: ModelRung;
  readonly to: ModelRung;
  /** False when `from` is already the floor: there is nothing below it, and nothing is recorded. */
  readonly moved: boolean;
  readonly reason: string;
}

/**
 * One rung toward the floor, for a degraded run's next attempt (AD-24's "downshifting model tier").
 *
 * **Not `promotionFor` run backwards, and not bounded like it.** Promotion answers a *step's failure* and
 * the Stack caps it at one per step per run, because an unbounded climb is a retry loop wearing a model
 * decision. A downshift answers *the run's budget*, and the only bound it needs is the floor: descending
 * spends less by construction, so a second one is not a loop to be stopped. Sharing the ceiling machinery
 * would make the two triggers indistinguishable in the log and would cap a budget decision with a rule
 * written for failures.
 *
 * One rung per selection rather than straight to the floor: "toward the floor" is the spine's word, and a
 * degraded run that keeps re-running a step reaches the floor within the length of the ladder anyway.
 *
 * A rung this build cannot place is refused by name, exactly as the ladder refuses one: `indexOf` answers
 * `-1` for it, and the rung "below" index `-1` is not a rung at all.
 */
export const downshiftFor = (rung: string): DownshiftDecision => {
  if (!isModelRung(rung)) {
    throw new ModelRungUnrecognised(rung, 'the rung a degraded run downshifts from');
  }
  const floor = MODEL_RUNGS.indexOf(LOWEST_MODEL_RUNG);
  const position = MODEL_RUNGS.indexOf(rung);
  // The floor is the whole bound: one step down, but never past the lowest rung.
  const target = position - 1 < floor ? floor : position - 1;
  const to = MODEL_RUNGS[target];
  if (to === undefined) {
    throw new ModelRungUnrecognised(String(target), 'a position below the model ladder');
  }
  return {
    from: rung,
    to,
    moved: to !== rung,
    reason:
      to === rung
        ? `The run is degraded (AD-24) and ${rung} is already the lowest rung, so the step stays on it.`
        : `The run is degraded (AD-24), so the step is downshifted from ${rung} to ${to} rather than ` +
          'following the ordinary starting-tier or promotion rule.',
  };
};

/**
 * Whether a degraded run's verification step skips its model-based review — "narrowing scope".
 *
 * **This is the only thing narrowing scope means, and the list of what it does not mean is the point.**
 * AD-24 names the behaviour in one clause and nothing elaborates it, so story 2-9 commits to the one
 * mechanism that is already optional, spending and safe to cut: CAP-13's second tier. The deterministic
 * gates still run, still gate, and a failing one is disposed exactly as it would be in any run — which is
 * why this is asked only *after* they have run and returned outcomes. No acceptance criterion is dropped,
 * no planned step is skipped, and no gate is weakened.
 *
 * **Only when a gate actually passed, and none failed.** A repository that declares no gate at all has a
 * first tier made entirely of `skipped` — nothing verified the step — and cutting the review there too would
 * leave it verified by nothing at all, which is exactly what this story's Boundaries rule out ("the
 * deterministic gates still run and still gate correctness"). A review round once argued the other way —
 * that "none passed because none exist" shouldn't count against narrowing, since a repository's own choice
 * to declare no gates shouldn't buy it a mandatory review — and that reading was tried and reverted: cost
 * discipline never outranks the floor of at least one real check. `gate.skipped` lines still say, on every
 * surface, that nothing ran; they just don't buy the review a matching skip.
 */
export const skipsModelReview = (request: {
  readonly degraded: boolean;
  readonly phase: StepPhase;
  readonly gates: readonly { readonly outcome: GateResult }[];
}): boolean =>
  request.degraded &&
  request.phase === 'verification' &&
  request.gates.some((gate) => gate.outcome === 'passed') &&
  !request.gates.some((gate) => gate.outcome === 'failed');

/**
 * What the deterministic gates returned on a step's latest attempt, read back from the log.
 *
 * A resume does not re-run the gates (the reconciler's `resume-step` says why), so a resumed verification
 * step's review-skip decision has to be taken from the outcomes its attempt already recorded — the lines
 * after that step's last `step.started`.
 */
export const gateOutcomesOfLatestAttempt = (
  events: readonly EventEnvelope[],
  step: string,
): readonly { readonly outcome: GateResult }[] => {
  const ordered = [...events].sort((left, right) => left.seq - right.seq);
  let outcomes: { readonly outcome: GateResult }[] = [];
  for (const event of ordered) {
    if (event.step !== step) continue;
    if (event.type === ENGINE_EVENT_TYPES.StepStarted) outcomes = [];
    else if (event.type === GATE_PASSED_EVENT_TYPE) outcomes.push({ outcome: 'passed' });
    else if (event.type === GATE_FAILED_EVENT_TYPE) outcomes.push({ outcome: 'failed' });
    else if (event.type === GATE_SKIPPED_EVENT_TYPE) outcomes.push({ outcome: 'skipped' });
  }
  return outcomes;
};

/** A hibernation the log has already recorded: the reading and the reason its `budget.exhausted` carried. */
export interface RecordedExhaustion {
  /** The recorded reading, or `null` when the line did not carry one this build can read (AD-5). */
  readonly reading: CeilingReading | null;
  readonly reason: string;
}

/**
 * The first `budget.exhausted` line, read back — so finishing a crashed hibernation says what was decided.
 *
 * Re-measuring instead would describe whatever the ceilings read *now*: after a restart the clock has moved,
 * and a run that hibernated at its ceiling would be written up as "0 of its 10 wall-clock minutes (0%)".
 */
export const recordedExhaustion = (events: readonly EventEnvelope[]): RecordedExhaustion | null => {
  const line = [...events]
    .sort((left, right) => left.seq - right.seq)
    .find((event) => event.type === BUDGET_EXHAUSTED_EVENT_TYPE);
  if (line === undefined) return null;
  const number = (key: string): number | null => {
    const value = line.payload[key];
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
  };
  const dimension = stringField(line, BUDGET_PAYLOAD_KEYS.Dimension);
  const consumed = number(BUDGET_PAYLOAD_KEYS.Consumed);
  const ceiling = number(BUDGET_PAYLOAD_KEYS.Ceiling);
  const fraction = number(BUDGET_PAYLOAD_KEYS.Fraction);
  const known = CEILING_DIMENSIONS.find((candidate) => candidate === dimension);
  const reading: CeilingReading | null =
    known === undefined || consumed === null || ceiling === null || fraction === null
      ? null
      : {
          dimension: known,
          consumed,
          ceiling,
          fraction,
          measurable: line.payload[BUDGET_PAYLOAD_KEYS.Measurable] !== false,
          scaled: { consumed, ceiling },
        };
  return {
    reading,
    reason:
      stringField(line, BUDGET_PAYLOAD_KEYS.Reason) ??
      'The run’s log records that it reached a ceiling, and the hibernation that began then is finished here.',
  };
};
