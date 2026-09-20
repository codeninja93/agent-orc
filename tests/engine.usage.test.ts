/**
 * Matrix 10, 11 and 12 — what a step cost reaches the log, and what nothing measured stays unmeasured.
 *
 * Driven through a real reconciler, because the claim spans three units: the spawner parses the numbers off
 * the stream, the executor port carries them out on the termination, and the reconciler writes them onto
 * `step.terminated`. A suite that asserted the parser alone would pass while the numbers never reached a
 * log, which is precisely the state this story found the codebase in — the fields were not discarded, they
 * were never read.
 *
 * Matrix 12 is the one that matters most and it is the easiest to get wrong in the safe-looking direction:
 * a step whose result carried no usage must record **no usage key at all**, so the surfaces read
 * `(not recorded)`. A zero would be a claim that the work was free, made by nobody.
 */
import { rmSync } from 'node:fs';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { StepUsageSchema, USAGE_PAYLOAD_KEY, makeError, totalUsage } from '../src/contracts/index.js';
import type { EventEnvelope, StepUsage } from '../src/contracts/index.js';
import {
  ENGINE_EVENT_TYPES,
  Reconciler,
  createRecordingResetter,
  createScriptedExecutor,
  terminated,
} from '../src/engine/index.js';
import { readEventLog, runPaths } from '../src/runtime/index.js';
import {
  UNRECORDED_PRESENTATION,
  buildBriefCard,
  buildCompletionCard,
  buildKillCard,
  cardText,
  foldEvents,
  foldFleet,
} from '../src/tui/index.js';

import { makeHome, makePlan, planProvider } from './helpers/engine-fixture.js';

const BASELINE = 'ddd9bed4d286ac1f8a0f4f7bfef9530046605787';

const usage = (fields: Partial<StepUsage>): StepUsage =>
  StepUsageSchema.parse({
    cost_usd: null,
    input_tokens: null,
    output_tokens: null,
    cache_creation_input_tokens: null,
    cache_read_input_tokens: null,
    ...fields,
  });

/** What each step of the fixture plan reported. `implement` is dearer than `verify`, as in life. */
const IMPLEMENT_USAGE = usage({
  cost_usd: 0.0354739,
  input_tokens: 18,
  output_tokens: 524,
  cache_creation_input_tokens: 15647,
  cache_read_input_tokens: 15419,
});
const VERIFY_USAGE = usage({
  cost_usd: 0.0041,
  input_tokens: 6,
  output_tokens: 90,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 31_066,
});

let home: string;
const toClose: Reconciler[] = [];
const toRemove: string[] = [];

beforeEach(() => {
  home = makeHome('engine-usage');
  toRemove.push(home);
});

afterEach(() => {
  for (const reconciler of toClose.splice(0)) reconciler.close();
  for (const dir of toRemove.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Run the two-step fixture plan to `committed`, with each step reporting whatever the script says. */
const runToCommitted = async (
  usageFor: (step: string) => StepUsage | null,
): Promise<{ readonly run: string; readonly events: readonly EventEnvelope[] }> => {
  const plan = makePlan({ feature: 'engine-usage' });
  const reconciler = Reconciler.open({
    orchHome: home,
    executor: createScriptedExecutor({
      onStart: (request) => {
        const reported = usageFor(request.step);
        return terminated(request.step, 'completed', {
          // Absent rather than null when the script says nothing: the port's own default is what a double
          // that knows nothing about usage produces, and that is the case matrix 12 is about.
          ...(reported === null ? {} : { usage: reported }),
        });
      },
    }),
    plans: planProvider(plan),
    baseline: createRecordingResetter(BASELINE),
  });
  toClose.push(reconciler);
  const accepted = reconciler.acceptFeature(plan);
  reconciler.confirm(accepted.run);
  await reconciler.runUntilSettled();
  expect(reconciler.load(accepted.run).state.state).toBe('committed');
  reconciler.close();
  toClose.pop();
  return { run: accepted.run, events: readEventLog(runPaths(accepted.run, home).eventLog) };
};

const terminations = (events: readonly EventEnvelope[]): readonly EventEnvelope[] =>
  events.filter((event) => event.type === ENGINE_EVENT_TYPES.StepTerminated);

describe('a completed step records its cost and its token counts (matrix 10)', () => {
  it('puts the usage on the step.terminated line, per step', async () => {
    const { events } = await runToCommitted((step) =>
      step === 'implement' ? IMPLEMENT_USAGE : VERIFY_USAGE,
    );
    const lines = terminations(events);
    expect(lines.map((line) => line.step)).toStrictEqual(['implement', 'verify']);
    expect(lines[0]?.payload[USAGE_PAYLOAD_KEY]).toStrictEqual(IMPLEMENT_USAGE);
    expect(lines[1]?.payload[USAGE_PAYLOAD_KEY]).toStrictEqual(VERIFY_USAGE);
  });

  it('carries the numbers through the AD-21 pass untouched, because they are numbers', async () => {
    const { events } = await runToCommitted(() => IMPLEMENT_USAGE);
    expect(JSON.stringify(terminations(events))).not.toContain('[redacted]');
  });
});

describe('a run of several steps totals to the sum of its steps (matrix 11)', () => {
  it('folds the run total from the log, and it is the sum', async () => {
    const { events } = await runToCommitted((step) =>
      step === 'implement' ? IMPLEMENT_USAGE : VERIFY_USAGE,
    );
    const view = foldEvents(events);
    expect(view.usage.total).toStrictEqual(totalUsage([IMPLEMENT_USAGE, VERIFY_USAGE]));
    expect(view.usage.total?.cost_usd).toBeCloseTo(0.0395739, 10);
    expect(view.usage.total?.output_tokens).toBe(614);
    expect(view.usage.total?.cache_read_input_tokens).toBe(46_485);
  });

  it('shows the total on the completion notice rather than (not recorded)', async () => {
    const { events } = await runToCommitted((step) =>
      step === 'implement' ? IMPLEMENT_USAGE : VERIFY_USAGE,
    );
    const card = buildCompletionCard({ view: foldEvents(events) });
    expect(card.tokens).not.toBe(UNRECORDED_PRESENTATION);
    expect(card.tokens).toContain('614 out');
    expect(card.tokens).toContain('46,485 cache read');
    // R10 — the log records the CLI's cost, and no surface renders it. Asserting the recorded figure is
    // absent from the rendered card is what keeps "recorded but not shown" from silently becoming "shown".
    expect(card.usage).not.toBe(UNRECORDED_PRESENTATION);
    expect(cardText(card)).not.toContain('0.0396');
    expect(cardText(card)).not.toMatch(/[$£€]|usd/i);
  });

  it('shows it on the morning brief too, which is where a person decides what to abandon (CAP-22)', async () => {
    // The run must still be in flight to appear in the brief, so this one stops at `running`.
    const plan = makePlan({ feature: 'brief-usage' });
    const reconciler = Reconciler.open({
      orchHome: home,
      executor: createScriptedExecutor({
        onStart: (request) =>
          terminated(request.step, request.step === 'implement' ? 'completed' : 'failed', {
            usage: IMPLEMENT_USAGE,
          }),
      }),
      plans: planProvider(plan),
      baseline: createRecordingResetter(BASELINE),
    });
    toClose.push(reconciler);
    const accepted = reconciler.acceptFeature(plan);
    reconciler.confirm(accepted.run);
    await reconciler.pass();
    await reconciler.pass();
    reconciler.close();
    toClose.pop();

    const brief = buildBriefCard({ fleet: foldFleet({ orchHome: home }) });
    const entry = brief.entries.find((candidate) => candidate.feature === 'brief-usage');
    expect(entry).toBeDefined();
    // Both steps reported the same figures, so the run's total is twice one step's: the brief states what
    // the feature has consumed so far, not what its last step did.
    expect(entry?.usage).toContain('1,048 out');
    expect(entry?.usage).not.toBe(UNRECORDED_PRESENTATION);
  });

  it('counts a failed attempt and a re-run, because both consumed what they consumed', async () => {
    const plan = makePlan({ feature: 'retry-usage' });
    const reconciler = Reconciler.open({
      orchHome: home,
      executor: createScriptedExecutor({
        onStart: (request, attemptOfStep) =>
          request.step === 'implement' && attemptOfStep === 1
            ? terminated(request.step, 'failed', {
                // A *retryable* code, so AD-35 routes a reset and a re-run rather than a hand-off: an
                // unknown code is abandon-and-hand-off and would never reach a second attempt.
                error: makeError('step.timed_out', 'the first attempt always times out in this fixture'),
                usage: usage({ cost_usd: 0.01, output_tokens: 100 }),
              })
            : terminated(request.step, 'completed', {
                usage: usage({ cost_usd: 0.02, output_tokens: 200 }),
              }),
      }),
      plans: planProvider(plan),
      baseline: createRecordingResetter(BASELINE),
    });
    toClose.push(reconciler);
    const accepted = reconciler.acceptFeature(plan);
    reconciler.confirm(accepted.run);
    await reconciler.runUntilSettled();
    reconciler.close();
    toClose.pop();

    const view = foldEvents(readEventLog(runPaths(accepted.run, home).eventLog));
    // One failure at 100 output tokens, then the re-run and the verify step at 200 each.
    expect(view.usage.total?.output_tokens).toBe(500);
    expect(view.usage.total?.cost_usd).toBeCloseTo(0.05, 10);
  });
});

describe('a result carrying no usage block records none, and the surfaces say so (matrix 12)', () => {
  it('writes no usage key on step.terminated at all', async () => {
    const { events } = await runToCommitted(() => null);
    for (const line of terminations(events)) {
      expect(Object.keys(line.payload)).not.toContain(USAGE_PAYLOAD_KEY);
      // Not a zero, and not a null either: the key's absence is the record.
      expect(line.payload[USAGE_PAYLOAD_KEY]).toBeUndefined();
    }
  });

  it('folds to no total, never to zero', async () => {
    const { events } = await runToCommitted(() => null);
    expect(foldEvents(events).usage.total).toBeNull();
  });

  it('reads (not recorded) on every surface, and never a zero figure', async () => {
    const { events } = await runToCommitted(() => null);
    const view = foldEvents(events);

    const completion = buildCompletionCard({ view });
    expect(completion.tokens).toBe(UNRECORDED_PRESENTATION);
    expect(cardText(completion)).toContain(`usage: ${UNRECORDED_PRESENTATION}`);
    // The three spellings of the fabricated zero this story exists to keep off a surface.
    expect(cardText(completion)).not.toContain('$0.00');
    expect(cardText(completion)).not.toContain('0.0000');
    expect(cardText(completion)).not.toContain('0 out');
    expect(cardText(completion)).toContain('unmeasured rather than nothing');

    const kill = buildKillCard({ view });
    expect(kill.tokens).toBe(UNRECORDED_PRESENTATION);
    expect(cardText(kill)).not.toContain('0 in');
  });

  it('states a recorded zero as a zero, because the CLI reporting nothing consumed is a measurement', async () => {
    // The distinction the whole story turns on, from the other side: a genuine zero must not read as
    // unrecorded, or a free step would look unmeasured.
    const { events } = await runToCommitted(() => usage({ cost_usd: 0, output_tokens: 0 }));
    const view = foldEvents(events);
    expect(view.usage.total?.cost_usd).toBe(0);
    const completion = buildCompletionCard({ view });
    // The distinction survives the fact that cost is never rendered (R10): the log keeps the zero, and
    // what a person sees carries it as a token count, which is a measurement and not an absence.
    expect(completion.tokens).not.toBe(UNRECORDED_PRESENTATION);
    expect(completion.tokens).toContain('0 out');
  });
});
