/**
 * Matrix 10 and 12 — cost and tokens are read off the CLI, and absence is recorded as absence.
 *
 * The whole suite is about one distinction: `null` means nobody measured, and `0` means somebody measured
 * zero. Every assertion here exists because collapsing the two produces `$0.00` on a completion notice —
 * a claim that a step was free, made by a surface nobody told anything to.
 *
 * The parse is asserted against the **recorded** transcripts under `tests/fixtures/stream-json/`, not
 * against lines this suite wrote: a parser tested only on fixtures written from its own assumptions proves
 * that it agrees with itself, which is the point story 1-4's own suite makes.
 */
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  STEP_USAGE_FIELDS,
  StepUsageSchema,
  addUsage,
  hasRecordedUsage,
  totalUsage,
  usageFromPayload,
} from '../src/contracts/index.js';
import type { StepUsage } from '../src/contracts/index.js';
import { parseStream, usageFromResultLine } from '../src/engine/index.js';

const fixture = (name: string): string =>
  readFileSync(new URL(`fixtures/stream-json/${name}`, import.meta.url), 'utf8');

/** The terminal result of a recorded transcript. */
const resultOf = (name: string): { readonly usage: StepUsage | null } => {
  const record = parseStream(fixture(name)).find((entry) => entry.kind === 'result');
  if (record?.kind !== 'result') throw new Error(`${name} carries no terminal result line`);
  return record;
};

const usage = (fields: Partial<StepUsage>): StepUsage =>
  StepUsageSchema.parse({
    cost_usd: null,
    input_tokens: null,
    output_tokens: null,
    cache_creation_input_tokens: null,
    cache_read_input_tokens: null,
    ...fields,
  });

describe('the cost and the token counts come off a real recorded result line', () => {
  it('reads the cost and all four token counts a completed attempt reported', () => {
    // Every number here is what `tests/fixtures/stream-json/completed.jsonl` actually holds.
    expect(resultOf('completed.jsonl').usage).toStrictEqual(
      usage({
        cost_usd: 0.0354739,
        input_tokens: 18,
        output_tokens: 524,
        cache_creation_input_tokens: 15647,
        cache_read_input_tokens: 15419,
      }),
    );
  });

  it('reads a genuine zero as a zero, because the CLI reporting nothing consumed is a measurement', () => {
    // The refused-resume transcript really does report `total_cost_usd: 0` and a usage block of zeros: the
    // attempt opened no session and spent nothing. That is a number, not an absence.
    const refused = resultOf('resume-refused.jsonl').usage;
    expect(refused).not.toBeNull();
    expect(refused?.cost_usd).toBe(0);
    expect(refused?.output_tokens).toBe(0);
    expect(hasRecordedUsage(refused)).toBe(true);
  });

  it('records no usage rather than a zero when the result carries none', () => {
    // An older CLI, or a result line truncated to its verdict: no `total_cost_usd`, no `usage` block and no
    // `modelUsage`. Every recorded fixture carries usage, so this shape is synthesised — it is the one case
    // R8 is about and the one a real transcript cannot supply.
    expect(
      usageFromResultLine({ type: 'result', subtype: 'success', is_error: false, num_turns: 3 }),
    ).toBeNull();
  });

  it('reads the per-model map when the top-level block did not carry a field', () => {
    // `modelUsage` is the secondary spelling and fills a gap rather than overwriting: a cost read from the
    // top level stands, and a token count only the map carried is still recovered.
    const merged = usageFromResultLine({
      total_cost_usd: 0.5,
      modelUsage: {
        'claude-haiku-4-5': { costUSD: 0.25, inputTokens: 10, outputTokens: 20 },
        'claude-sonnet-5': { costUSD: 0.25, inputTokens: 5, outputTokens: 1, cacheReadInputTokens: 7 },
      },
    });
    expect(merged?.cost_usd).toBe(0.5);
    expect(merged?.input_tokens).toBe(15);
    expect(merged?.output_tokens).toBe(21);
    expect(merged?.cache_read_input_tokens).toBe(7);
  });

  it('reads an unusable field as unreported rather than as a number the schema would refuse', () => {
    const odd = usageFromResultLine({
      total_cost_usd: Number.NaN,
      usage: { input_tokens: 'lots', output_tokens: 12.5, cache_read_input_tokens: 4 },
    });
    // Only the one readable count survives; a fractional token count is not a count and NaN is not a cost.
    expect(odd).toStrictEqual(usage({ cache_read_input_tokens: 4 }));
  });
});

describe('a run total is the sum of its steps, and absence stays absent through it', () => {
  it('sums every field of two recorded steps', () => {
    expect(
      addUsage(
        usage({ cost_usd: 0.25, input_tokens: 10, output_tokens: 2 }),
        usage({ cost_usd: 0.5, input_tokens: 4, output_tokens: 3, cache_read_input_tokens: 9 }),
      ),
    ).toStrictEqual(
      usage({ cost_usd: 0.75, input_tokens: 14, output_tokens: 5, cache_read_input_tokens: 9 }),
    );
  });

  it('totals two unmeasured steps to nothing recorded, never to zero', () => {
    expect(totalUsage([null, null])).toBeNull();
    expect(hasRecordedUsage(totalUsage([null, null]))).toBe(false);
  });

  it('leaves a measured field alone when the other step did not report it', () => {
    const total = totalUsage([usage({ cost_usd: 0.25 }), null, usage({ input_tokens: 7 })]);
    expect(total).toStrictEqual(usage({ cost_usd: 0.25, input_tokens: 7 }));
    // The fields neither step reported are still absent, so a surface says so rather than showing zeros.
    expect(total?.output_tokens).toBeNull();
    expect(total?.cache_read_input_tokens).toBeNull();
  });

  it('treats a recorded zero as recorded, so a genuinely free step is not reported as unmeasured', () => {
    expect(hasRecordedUsage(usage({ cost_usd: 0 }))).toBe(true);
    expect(totalUsage([usage({ cost_usd: 0 }), usage({ cost_usd: 0 })])?.cost_usd).toBe(0);
  });
});

describe('reading a usage record back out of an event payload (AD-5)', () => {
  it('reads what the engine wrote, field for field', () => {
    const written = usage({ cost_usd: 0.01, input_tokens: 3, output_tokens: 4 });
    expect(usageFromPayload(JSON.parse(JSON.stringify(written)) as unknown)).toStrictEqual(written);
  });

  it('survives a payload an older or newer build wrote, and never throws', () => {
    for (const odd of [undefined, null, 'usage', 42, [], {}, { input_tokens: null }]) {
      expect(() => usageFromPayload(odd)).not.toThrow();
      expect(usageFromPayload(odd)).toBeNull();
    }
    // A key this build does not know is ignored, and the ones it does know are still read.
    expect(usageFromPayload({ input_tokens: 5, thinking_tokens: 99 })).toStrictEqual(
      usage({ input_tokens: 5 }),
    );
  });

  it('names every field exactly once, so no reader spells one differently', () => {
    expect(new Set(STEP_USAGE_FIELDS).size).toBe(STEP_USAGE_FIELDS.length);
    for (const field of STEP_USAGE_FIELDS) {
      expect(Object.keys(StepUsageSchema.shape)).toContain(field);
    }
    expect(Object.keys(StepUsageSchema.shape).sort()).toStrictEqual([...STEP_USAGE_FIELDS].sort());
  });
});
