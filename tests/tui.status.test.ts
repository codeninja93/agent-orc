/**
 * The ambient segment: R10 and R11, as assertions.
 *
 * R10: "Consumed rate-limit budget and step count are always visible without issuing a command. Cost is
 * subscription usage, never currency." R11: "Elapsed-versus-estimate is always visible, so abandoning
 * early is easy."
 *
 * Both rules are about *always*, so the tests are about absence as much as presence: every value is in
 * every frame, including when the log has not recorded it, and no currency mark appears in any frame of
 * any render state. The currency check is the one that would otherwise rot quietly — AD-24 declares
 * three ceilings "and no currency dimension", and the day a cost estimate is added in a helpful mood is
 * the day this suite has to fail.
 */
import { describe, expect, it } from 'vitest';

import {
  STATUS_LABELS,
  STATUS_UNRECORDED,
  foldEvents,
  formatBudgetShare,
  formatDuration,
  formatStatusSegment,
  shellFrameText,
  statusFields,
} from '../src/tui/index.js';
import type { ShellView } from '../src/tui/index.js';

import {
  FIXTURE_RUN_START_MS,
  budgetDegraded,
  buildLog,
  commandApplied,
  featureStateChanged,
  questionAsked,
  runCreated,
  stepStarted,
  stepTerminated,
} from './helpers/tui-log.js';

/** Ten minutes into the fixture run, so elapsed is a number a person would actually read. */
const NOW = new Date(FIXTURE_RUN_START_MS + 10 * 60 * 1_000);

/** A run with recorded usage: two steps of a three-step plan, and a budget sample. */
const usageRun = (): ShellView =>
  foldEvents(
    buildLog([
      runCreated({ mode: 'live', step_count: 3 }),
      featureStateChanged('running'),
      stepStarted('implement'),
      stepTerminated('implement'),
      stepStarted('verify', 'verification'),
      budgetDegraded(0.42, 5 * 60 * 1_000),
    ]),
  );

describe('the three ambient values are visible with no command issued', () => {
  it('shows the step count, the consumed rate-limit budget and elapsed against estimate', () => {
    const view = usageRun();
    const fields = statusFields(view, NOW);

    expect(fields.steps).toBe('2 of 3');
    expect(fields.budget).toBe('0.42 of 1.00');
    // The estimate is what the log implied: the wall clock remaining at the sample, plus the elapsed
    // the log had already recorded by then.
    expect(fields.elapsed).toContain('of ~');

    const segment = formatStatusSegment(view, NOW);
    expect(segment).toContain(STATUS_LABELS.Steps);
    expect(segment).toContain(STATUS_LABELS.Budget);
    expect(segment).toContain(STATUS_LABELS.Elapsed);
    // In the frame itself, with nothing invoked to reveal it. Asserted field by field rather than as
    // one string, because the frame wraps to the terminal's width and a wrapped line is still visible.
    const frame = shellFrameText(view, { now: NOW });
    expect(frame).toContain(`${STATUS_LABELS.Steps} ${fields.steps}`);
    expect(frame).toContain(`${STATUS_LABELS.Budget} ${fields.budget}`);
    expect(frame).toContain(STATUS_LABELS.Elapsed);
  });

  it('keeps all three fields when the log has recorded none of them', () => {
    const fields = statusFields(foldEvents([]), NOW);
    expect(fields.steps).toBe('0 started');
    expect(fields.budget).toBe(STATUS_UNRECORDED);
    // One unrecorded sentence, not two: with no instant in the log there is neither an elapsed nor an
    // estimate to compare it against.
    expect(fields.elapsed).toBe(STATUS_UNRECORDED);

    const segment = formatStatusSegment(foldEvents([]), NOW);
    for (const label of Object.values(STATUS_LABELS)) expect(segment).toContain(label);
  });

  it('measures elapsed against the clock, not against the log, so it keeps moving while nothing does', () => {
    const view = usageRun();
    const early = statusFields(view, new Date(FIXTURE_RUN_START_MS + 30_000)).elapsed;
    const later = statusFields(view, new Date(FIXTURE_RUN_START_MS + 20 * 60 * 1_000)).elapsed;
    expect(early).not.toBe(later);
    expect(early.startsWith('30s')).toBe(true);
    expect(later.startsWith('20m00s')).toBe(true);
  });

  /**
   * R11 is about a decision — "abandoning early is easy" — and the decision is only live while the run is.
   *
   * `elapsedMsAt` measured every run against `now`, so a four-second committed run read `elapsed 26h00m`
   * a day later: a number about the reader's clock rather than about the work, and the figure a person
   * would judge the next estimate by. A terminal run's elapsed is the span the log recorded; a run still
   * in flight keeps the live clock, which is what the test above pins.
   */
  it('stops the clock once the run has reached a terminal state', () => {
    const committed = foldEvents(
      buildLog([
        runCreated(),
        stepStarted('implement'),
        stepTerminated('implement'),
        featureStateChanged('committed', 'verifying'),
      ]),
    );
    const aDayLater = new Date(FIXTURE_RUN_START_MS + 24 * 60 * 60 * 1_000);

    expect(committed.usage.recordedElapsedMs).toBe(3_000);
    expect(statusFields(committed, aDayLater).elapsed).toContain('3s');
    expect(statusFields(committed, aDayLater).elapsed).not.toContain('h');
    // And the same log before it finished still reads off the wall clock, because that run may be waiting.
    const running = foldEvents(
      buildLog([runCreated(), stepStarted('implement'), featureStateChanged('running')]),
    );
    expect(statusFields(running, aDayLater).elapsed).toContain('h');
  });

  it('reads an estimate the log states outright, when a later story records one', () => {
    const view = foldEvents(
      buildLog([runCreated({ mode: 'live', step_count: 2, wall_clock_ms_estimate: 900_000 })]),
    );
    expect(view.usage.estimateMs).toBe(900_000);
    expect(statusFields(view, NOW).elapsed).toBe('10m00s of ~15m00s estimated');
  });
});

describe('cost is subscription usage, never currency (R10, AD-24)', () => {
  /** Every way a currency amount arrives. A frame containing any of these is the defect. */
  const CURRENCY_MARKERS = ['$', '€', '£', '¥', 'usd', 'eur', 'gbp', 'dollar', 'cent', 'price', 'cost'];

  const states: Readonly<Record<string, ShellView>> = {
    idle: foldEvents([]),
    'with usage': usageRun(),
    'question pending': foldEvents(
      buildLog([runCreated(), stepStarted('implement'), questionAsked('q-01')]),
    ),
    exhausted: foldEvents(
      buildLog([
        runCreated(),
        { ...budgetDegraded(0.8, 60_000) },
        { type: 'budget.exhausted', payload: { rate_limit_budget_consumed: 1 } },
      ]),
    ),
    stopped: foldEvents(buildLog([runCreated(), commandApplied('disengage')])),
  };

  it.each(Object.keys(states))('renders no currency amount when %s', (state) => {
    const view = states[state];
    const frame = shellFrameText(view ?? foldEvents([]), { now: NOW }).toLowerCase();
    for (const marker of CURRENCY_MARKERS) {
      expect(frame, `${state} rendered "${marker}"`).not.toContain(marker);
    }
  });

  it('renders no share of a whole either, in any of those states', () => {
    for (const [state, view] of Object.entries(states)) {
      const frame = shellFrameText(view, { now: NOW });
      expect(frame, state).not.toContain('%');
      expect(frame.toLowerCase(), state).not.toContain('percent');
    }
  });

  it('spells the consumed budget as a ratio against its own ceiling', () => {
    expect(formatBudgetShare(0)).toBe('0.00 of 1.00');
    expect(formatBudgetShare(0.815)).toBe('0.81 of 1.00');
    expect(formatBudgetShare(1)).toBe('1.00 of 1.00');
    /**
     * A value outside the declared range is *reported*, not clamped into one that looks fine.
     *
     * Clamping turned a figure recorded on another scale — 42 meaning 42 parts in a hundred is the
     * obvious one a later story could emit — into `1.00 of 1.00`: in range, plausible, and false. R12
     * says uncertainty is surfaced as uncertainty rather than as a confident wrong answer, and this is
     * the number a person decides whether to abandon a run by. The figure is shown as recorded and said
     * to be off the scale.
     */
    expect(formatBudgetShare(4)).toContain('4.00 of 1.00');
    expect(formatBudgetShare(4)).toContain('outside the 0 to 1 scale');
    expect(formatBudgetShare(-1)).toContain('-1.00 of 1.00');
    expect(formatBudgetShare(-1)).toContain('outside the 0 to 1 scale');
    expect(formatBudgetShare(null)).toBe(STATUS_UNRECORDED);
  });
});

describe('a duration reads at a glance', () => {
  it('formats seconds, minutes and hours', () => {
    expect(formatDuration(0)).toBe('0s');
    expect(formatDuration(45_000)).toBe('45s');
    expect(formatDuration(192_000)).toBe('3m12s');
    expect(formatDuration(3_600_000)).toBe('1h00m');
    expect(formatDuration(7_500_000)).toBe('2h05m');
  });

  it('says so rather than inventing a number it does not have', () => {
    expect(formatDuration(null)).toBe(STATUS_UNRECORDED);
    expect(formatDuration(Number.NaN)).toBe(STATUS_UNRECORDED);
    expect(formatDuration(-1)).toBe(STATUS_UNRECORDED);
  });
});

describe('the segment is a projection like everything else', () => {
  it('gives the same text for the same view and the same instant', () => {
    const view = usageRun();
    expect(formatStatusSegment(view, NOW)).toBe(formatStatusSegment(view, NOW));
  });

  it('reads the budget from the latest sample the log carries', () => {
    const view = foldEvents(
      buildLog([
        runCreated(),
        budgetDegraded(0.5),
        budgetDegraded(0.9),
      ]),
    );
    expect(view.usage.rateLimitBudgetConsumed).toBe(0.9);
  });
});
