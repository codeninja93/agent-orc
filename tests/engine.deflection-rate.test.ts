/**
 * Q4 — the deflection rate, folded from `question.asked` and `question.deflected` lines alone.
 *
 * Matrix rows 13 and 14. Row 13 is driven end to end through the real emitters: six questions asked by
 * the reconciler, five of them deflected by a deflection this story *constructs* and applies through the
 * existing compare-and-set, and the `question.deflected` lines appended by the reconciler's own pass
 * when it settles them. A rate folded from hand-written lines would prove the fold agrees with this file.
 *
 * Row 14 is its own test and not a side effect of the arithmetic: a feature that raised nothing has no
 * rate, which is a different fact from a rate of zero, and the result's shape is what says so.
 */
import { rmSync } from 'node:fs';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { EventEnvelope, QuestionDraft } from '../src/contracts/index.js';
import { readEventLog, runPaths } from '../src/runtime/index.js';
import {
  QUESTION_EVENT_TYPES,
  Reconciler,
  applyDeflection,
  constructDeflection,
  createRecordingResetter,
  createScriptedExecutor,
  deflectionRate,
  terminated,
} from '../src/engine/index.js';

import { makeHome, makePlan, planProvider } from './helpers/engine-fixture.js';

const BASELINE = 'ddd9bed4d286ac1f8a0f4f7bfef9530046605787';

let home: string;
const toClose: Reconciler[] = [];

beforeEach(() => {
  home = makeHome('engine-deflection-rate');
});

afterEach(() => {
  for (const reconciler of toClose.splice(0)) reconciler.close();
  rmSync(home, { recursive: true, force: true });
});

const openReconciler = (): Reconciler => {
  const reconciler = Reconciler.open({
    orchHome: home,
    executor: createScriptedExecutor({
      onStart: (request) => terminated(request.step, 'completed', { sessionId: `sess-${request.step}` }),
    }),
    plans: planProvider(makePlan()),
    baseline: createRecordingResetter(BASELINE),
  });
  toClose.push(reconciler);
  return reconciler;
};

const aDraft = (n: number): QuestionDraft => ({
  prompt: `Question ${String(n)}: should widget${String(n)} be cached?`,
  brief: 'A cache makes the second read cheap and the first one stale.',
  options: [
    { id: 'cache', label: 'Cache it', consequence: 'Reads are cheap and may be stale.' },
    { id: 'fresh', label: 'Read fresh', consequence: 'Reads are slow and never stale.' },
  ],
  escape: { id: 'later', label: 'Ask me later', consequence: 'The step waits.' },
  recommended_option_id: 'fresh',
  default_action: 'Every read is fresh.',
  default_window_ms: 15 * 60 * 1000,
});

const eventsOf = (run: string): readonly EventEnvelope[] => readEventLog(runPaths(run, home).eventLog);

describe('the rate is deflected over raised, read from the log (matrix 13)', () => {
  it('reports 5/6 for six questions raised, five deflected and one asked', async () => {
    const reconciler = openReconciler();
    const run = reconciler.acceptFeature(makePlan()).run;
    const asked = [1, 2, 3, 4, 5, 6].map((n) => reconciler.ask(run, aDraft(n)));
    for (const state of asked.slice(0, 5)) {
      const deflection = constructDeflection({
        source: 'repository',
        anchor: 'widgetCache',
        answer: 'CLAUDE.md: widgets are never cached.',
        evidence: 'CLAUDE.md',
        run: null,
      });
      expect(applyDeflection(runPaths(run, home), state.question.id, deflection).accepted).toBe(true);
    }
    // The pass settles each question and appends its `question.deflected` line; nothing here writes one.
    await reconciler.pass();

    const events = eventsOf(run);
    expect(events.filter((event) => event.type === QUESTION_EVENT_TYPES.Asked)).toHaveLength(6);
    expect(events.filter((event) => event.type === QUESTION_EVENT_TYPES.Deflected)).toHaveLength(5);

    const rate = deflectionRate(events, 'engine-reconciler');
    expect(rate).toStrictEqual({
      kind: 'measured',
      feature: 'engine-reconciler',
      raised: 6,
      deflected: 5,
      reachedUser: 1,
      rate: 5 / 6,
      summary: 'engine-reconciler deflected 5 of 6 raised questions; 1 reached a person.',
    });
  });

  it('counts a question once however many times its lines appear, so a repeated pass does not move the rate', async () => {
    const reconciler = openReconciler();
    const run = reconciler.acceptFeature(makePlan()).run;
    const [first] = [reconciler.ask(run, aDraft(1)), reconciler.ask(run, aDraft(2))];
    if (first === undefined) throw new Error('the fixture asked two questions');
    applyDeflection(
      runPaths(run, home),
      first.question.id,
      constructDeflection({ source: 'git_history', anchor: 'widgetCache', answer: 'commit abc: no', evidence: 'abc', run: null }),
    );
    await reconciler.pass();
    const events = eventsOf(run);
    // The same lines handed in twice, as a reader concatenating a log with its own replay would.
    expect(deflectionRate([...events, ...events], 'engine-reconciler')).toMatchObject({ raised: 2, deflected: 1, rate: 0.5 });
  });

  it('measures each feature over its own lines only', async () => {
    const reconciler = openReconciler();
    const run = reconciler.acceptFeature(makePlan()).run;
    reconciler.ask(run, aDraft(1));
    await reconciler.pass();
    expect(deflectionRate(eventsOf(run), 'engine-reconciler')).toMatchObject({ kind: 'measured', raised: 1, rate: 0 });
    expect(deflectionRate(eventsOf(run), 'some-other-feature').kind).toBe('inapplicable');
  });
});

describe('a feature that raised no questions has no rate, not a rate of zero (matrix 14)', () => {
  it('reports inapplicable, with no rate for a reader to mistake for 0%', async () => {
    const reconciler = openReconciler();
    const run = reconciler.acceptFeature(makePlan()).run;
    await reconciler.pass();

    const rate = deflectionRate(eventsOf(run), 'engine-reconciler');

    expect(rate.kind).toBe('inapplicable');
    expect(rate.raised).toBe(0);
    expect('rate' in rate).toBe(false);
    expect('deflected' in rate).toBe(false);
    expect(rate.summary).toBe(
      'engine-reconciler raised no questions, so it has no deflection rate — none were deflected because none were asked.',
    );
  });

  it('keeps "none deflected" distinct: one question asked and not deflected is a measured 0', () => {
    const reconciler = openReconciler();
    const run = reconciler.acceptFeature(makePlan()).run;
    reconciler.ask(run, aDraft(1));
    const rate = deflectionRate(eventsOf(run), 'engine-reconciler');
    expect(rate).toMatchObject({ kind: 'measured', raised: 1, deflected: 0, reachedUser: 1, rate: 0 });
  });
});
