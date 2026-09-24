/**
 * Story 3-3 — `interruptionCount`, matrix rows 6-8.
 *
 * Hand-built `EventEnvelope[]` fixtures, matching `tests/engine.rework-rate.test.ts`'s own style: this is
 * a pure fold, and the exact lines the matrix describes prove the fold directly.
 */
import { describe, expect, it } from 'vitest';

import type { EventEnvelope } from '../src/contracts/index.js';
import { ENGINE_EVENT_TYPES, interruptionCount } from '../src/engine/index.js';

const FEATURE = 'interruption-feature';

let seq = 0;

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
const resumeAttempted = (step: string, run = 'run-a'): EventEnvelope =>
  envelope(ENGINE_EVENT_TYPES.StepResumeAttempted, step, {}, FEATURE, run);

describe('interruptionCount — matrix rows 6-8', () => {
  it('counts an interrupted termination (row 7)', () => {
    const events = [started('implement'), terminated('implement', 'interrupted')];
    expect(interruptionCount(events, FEATURE)).toBe(1);
  });

  it('reports a real zero when no step was ever interrupted (row 8)', () => {
    const events = [started('implement'), terminated('implement', 'completed')];
    expect(interruptionCount(events, FEATURE)).toBe(0);
  });

  it('reports zero for a feature with no events at all', () => {
    expect(interruptionCount([], FEATURE)).toBe(0);
  });

  it('leaves the count unaffected by a redelivered duplicate of the same termination (row 6)', () => {
    const start = started('implement');
    const one = terminated('implement', 'interrupted');
    const duplicate: EventEnvelope = { ...one, seq: one.seq + 1 };
    const events = [start, one, duplicate];
    expect(interruptionCount(events, FEATURE)).toBe(1);
  });

  it('counts a genuine second interruption after a fresh step.started, not merely the duplicate case', () => {
    const events = [
      started('implement'),
      terminated('implement', 'interrupted'),
      started('implement'), // AD-26 reset-and-rerun clears the slot
      terminated('implement', 'interrupted'),
    ];
    expect(interruptionCount(events, FEATURE)).toBe(2);
  });

  it('measures each feature over its own lines only', () => {
    const events = [started('implement'), terminated('implement', 'interrupted')];
    expect(interruptionCount(events, 'some-other-feature')).toBe(0);
  });

  it('counts interrupt, resume, interrupt again as one interruption, not two', () => {
    // No fresh `step.started` between the two terminations, so the slot never clears — the second
    // `interrupted` line is read as the same at-least-once redelivery matrix row 6 already covers, not a
    // second genuine interruption.
    const events = [
      started('implement'),
      terminated('implement', 'interrupted'),
      resumeAttempted('implement'),
      terminated('implement', 'interrupted'),
    ];
    expect(interruptionCount(events, FEATURE)).toBe(1);
  });

  it('folds two separate runs of the same feature without a false interruption or a false miss (row 18)', () => {
    // The first run's step is interrupted; the second run's identically-named step completes cleanly.
    // Keying by (run, step) keeps the two apart — a name-only key would read the second run's `implement`
    // as already carrying the first run's `interrupted` slot.
    const events = [
      started('implement', 'run-a'),
      terminated('implement', 'interrupted', 'run-a'),
      started('implement', 'run-b'),
      terminated('implement', 'completed', 'run-b'),
    ];
    expect(interruptionCount(events, FEATURE)).toBe(1);
  });

  it('folds two separate runs where both genuinely interrupt, without under- or over-counting (row 18)', () => {
    const events = [
      started('implement', 'run-a'),
      terminated('implement', 'interrupted', 'run-a'),
      started('implement', 'run-b'),
      terminated('implement', 'interrupted', 'run-b'),
    ];
    expect(interruptionCount(events, FEATURE)).toBe(2);
  });
});
