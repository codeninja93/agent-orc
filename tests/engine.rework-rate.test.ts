/**
 * Story 3-3 — `reworkRate`, matrix rows 1-5.
 *
 * Every fixture here is a hand-built `EventEnvelope[]`, in `tests/engine.deflection-rate.test.ts`'s own
 * "the count is a structured payload field" style: `reworkRate` is a pure fold, and driving a real
 * reconciler through a scripted executor would prove nothing about the fold itself that constructing the
 * exact lines the matrix describes does not prove more directly.
 */
import { describe, expect, it } from 'vitest';

import type { EventEnvelope } from '../src/contracts/index.js';
import { ENGINE_EVENT_TYPES, reworkRate } from '../src/engine/index.js';

const FEATURE = 'rework-feature';

let seq = 0;

/** One envelope, in the AD-5 shape, defaulting every field a test does not care about. */
const envelope = (
  type: string,
  step: string | null,
  payload: Record<string, unknown> = {},
  feature = FEATURE,
  run = 'run-a',
): EventEnvelope => {
  seq += 1;
  return {
    ts: '2026-09-24T10:00:00.000Z',
    seq,
    feature,
    run,
    step,
    emitter: 'engine.reconciler',
    type,
    payload,
  };
};

const started = (step: string, run = 'run-a'): EventEnvelope =>
  envelope(ENGINE_EVENT_TYPES.StepStarted, step, {}, FEATURE, run);
const terminated = (step: string, disposition: string, run = 'run-a'): EventEnvelope =>
  envelope(ENGINE_EVENT_TYPES.StepTerminated, step, { disposition }, FEATURE, run);
const baselineReset = (step: string): EventEnvelope => envelope(ENGINE_EVENT_TYPES.StepBaselineReset, step);
const tierPromoted = (step: string): EventEnvelope => envelope(ENGINE_EVENT_TYPES.StepTierPromoted, step);
const resumeAttempted = (step: string): EventEnvelope =>
  envelope(ENGINE_EVENT_TYPES.StepResumeAttempted, step);

describe('reworkRate — matrix rows 1-5', () => {
  it('counts nothing reworked when every step ran once and terminated (row 1)', () => {
    const events = [
      started('implement'),
      terminated('implement', 'completed'),
      started('verify'),
      terminated('verify', 'completed'),
    ];
    expect(reworkRate(events, FEATURE)).toStrictEqual({
      kind: 'measured',
      feature: FEATURE,
      totalSteps: 2,
      reworkedSteps: 0,
      rate: 0,
      summary: `${FEATURE} reworked 0 of 2 steps.`,
    });
  });

  it('counts a step reworked after a baseline reset and re-run (row 2)', () => {
    const events = [
      started('implement'),
      baselineReset('implement'),
      started('implement'),
      terminated('implement', 'completed'),
    ];
    expect(reworkRate(events, FEATURE)).toStrictEqual({
      kind: 'measured',
      feature: FEATURE,
      totalSteps: 1,
      reworkedSteps: 1,
      rate: 1,
      summary: `${FEATURE} reworked 1 of 1 steps.`,
    });
  });

  it('counts a step reworked after a tier promotion and re-run, the same mechanism as row 2 (row 3)', () => {
    const events = [
      started('implement'),
      tierPromoted('implement'),
      started('implement'),
      terminated('implement', 'completed'),
    ];
    expect(reworkRate(events, FEATURE)).toStrictEqual({
      kind: 'measured',
      feature: FEATURE,
      totalSteps: 1,
      reworkedSteps: 1,
      rate: 1,
      summary: `${FEATURE} reworked 1 of 1 steps.`,
    });
  });

  it('does not count a step reworked for an interruption resumed to completion (row 4)', () => {
    const events = [
      started('implement'),
      terminated('implement', 'interrupted'),
      resumeAttempted('implement'),
      terminated('implement', 'completed'),
    ];
    expect(reworkRate(events, FEATURE)).toStrictEqual({
      kind: 'measured',
      feature: FEATURE,
      totalSteps: 1,
      reworkedSteps: 0,
      rate: 0,
      summary: `${FEATURE} reworked 0 of 1 steps.`,
    });
  });

  it('reports inapplicable, never 0%, for a feature that never started a step (row 5)', () => {
    const rate = reworkRate([], FEATURE);
    expect(rate).toStrictEqual({
      kind: 'inapplicable',
      feature: FEATURE,
      totalSteps: 0,
      summary: `${FEATURE} never started a step, so it has no rework rate.`,
    });
    expect('rate' in rate).toBe(false);
    expect('reworkedSteps' in rate).toBe(false);
  });

  it('measures each feature over its own lines only', () => {
    const events = [started('implement'), terminated('implement', 'completed')];
    expect(reworkRate(events, 'some-other-feature').kind).toBe('inapplicable');
  });

  it('is unaffected by a duplicate step.terminated line, since it never reads step.terminated at all (row 6)', () => {
    const events = [
      started('implement'),
      terminated('implement', 'completed'),
      terminated('implement', 'completed'),
    ];
    expect(reworkRate(events, FEATURE)).toMatchObject({ totalSteps: 1, reworkedSteps: 0, rate: 0 });
  });

  it('counts a step reworked exactly once when it is both reset and promoted before completion', () => {
    // Three `step.started` lines for one step name: the threshold is "> 1", not an exact count, so a
    // double-signal step (reset, then also promoted) still counts as one reworked step, not two.
    const events = [
      started('implement'),
      baselineReset('implement'),
      started('implement'),
      tierPromoted('implement'),
      started('implement'),
      terminated('implement', 'completed'),
    ];
    expect(reworkRate(events, FEATURE)).toStrictEqual({
      kind: 'measured',
      feature: FEATURE,
      totalSteps: 1,
      reworkedSteps: 1,
      rate: 1,
      summary: `${FEATURE} reworked 1 of 1 steps.`,
    });
  });

  it('folds two separate runs of the same feature without a false rework (row 18)', () => {
    // Both runs start `implement` exactly once, with no reset or promotion in either — the step name is
    // identical across the two runs, but keying by (run, step) keeps their attempt counts apart, so
    // neither run's single attempt is mistaken for the other run's second attempt at the same step.
    const events = [
      started('implement', 'run-a'),
      terminated('implement', 'completed', 'run-a'),
      started('implement', 'run-b'),
      terminated('implement', 'completed', 'run-b'),
    ];
    expect(reworkRate(events, FEATURE)).toStrictEqual({
      kind: 'measured',
      feature: FEATURE,
      totalSteps: 2,
      reworkedSteps: 0,
      rate: 0,
      summary: `${FEATURE} reworked 0 of 2 steps.`,
    });
  });
});
