/**
 * Story 3-3 — `usagePerFeature`, matrix rows 9-10.
 *
 * Hand-built `EventEnvelope[]` fixtures, matching `tests/engine.rework-rate.test.ts`'s own style: this is
 * glue over `usageFromPayload`/`totalUsage`, both already covered by `tests/contracts.usage.test.ts`; what
 * this file proves is the fold that reaches them from `step.terminated` lines.
 */
import { describe, expect, it } from 'vitest';

import { USAGE_PAYLOAD_KEY } from '../src/contracts/index.js';
import type { EventEnvelope } from '../src/contracts/index.js';
import { ENGINE_EVENT_TYPES, usagePerFeature } from '../src/engine/index.js';

const FEATURE = 'usage-feature';

let seq = 0;

const envelope = (
  type: string,
  step: string | null,
  payload: Record<string, unknown> = {},
  feature = FEATURE,
): EventEnvelope => {
  seq += 1;
  return {
    ts: '2026-09-24T10:00:00.000Z',
    seq,
    feature,
    run: 'run-a',
    step,
    emitter: 'engine.reconciler',
    type,
    payload,
  };
};

const terminatedWithUsage = (step: string, usage: Record<string, unknown> | null): EventEnvelope =>
  envelope(ENGINE_EVENT_TYPES.StepTerminated, step, usage === null ? {} : { [USAGE_PAYLOAD_KEY]: usage });

describe('usagePerFeature — matrix rows 9-10', () => {
  it('sums the steps that recorded usage and skips the ones that did not (row 9)', () => {
    const events = [
      terminatedWithUsage('implement', {
        cost_usd: 0.5,
        input_tokens: 100,
        output_tokens: 20,
        cache_creation_input_tokens: null,
        cache_read_input_tokens: null,
      }),
      terminatedWithUsage('verify', null),
      terminatedWithUsage('test', {
        cost_usd: 0.25,
        input_tokens: 50,
        output_tokens: 10,
        cache_creation_input_tokens: 5,
        cache_read_input_tokens: null,
      }),
    ];
    expect(usagePerFeature(events, FEATURE)).toStrictEqual({
      cost_usd: 0.75,
      input_tokens: 150,
      output_tokens: 30,
      cache_creation_input_tokens: 5,
      cache_read_input_tokens: null,
    });
  });

  it('reports null, never 0, when no usage was recorded anywhere (row 10)', () => {
    const events = [terminatedWithUsage('implement', null), terminatedWithUsage('verify', null)];
    expect(usagePerFeature(events, FEATURE)).toBeNull();
  });

  it('reports null for a feature with no terminated steps at all', () => {
    expect(usagePerFeature([], FEATURE)).toBeNull();
  });

  it('measures each feature over its own lines only', () => {
    const events = [
      terminatedWithUsage('implement', {
        cost_usd: 1,
        input_tokens: 1,
        output_tokens: 1,
        cache_creation_input_tokens: null,
        cache_read_input_tokens: null,
      }),
    ];
    expect(usagePerFeature(events, 'some-other-feature')).toBeNull();
  });
});
