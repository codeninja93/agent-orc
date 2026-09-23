/**
 * Q4 — the deflection rate, folded from `question.asked` and `question.deflected` lines alone.
 *
 * Matrix rows 13, 14, 27 and 28. Row 13 is driven end to end through the real emitters: six questions asked by
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
  mergeByAnchor,
  terminated,
} from '../src/engine/index.js';
import type { DeflectionMatch } from '../src/engine/index.js';

import { makeHome, makePlan, planProvider } from './helpers/engine-fixture.js';

const BASELINE = 'ddd9bed4d286ac1f8a0f4f7bfef9530046605787';

let home: string;
let clock: Date;
const toClose: Reconciler[] = [];

beforeEach(() => {
  home = makeHome('engine-deflection-rate');
  clock = new Date('2026-09-23T10:00:00.000Z');
});

const advance = (ms: number): void => {
  clock = new Date(clock.getTime() + ms);
};

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
    now: () => clock,
  });
  toClose.push(reconciler);
  return reconciler;
};

const WINDOW_MS = 15 * 60 * 1000;

const aDraft = (n: number, windowMs = WINDOW_MS): QuestionDraft => ({
  prompt: `Question ${String(n)}: should widget${String(n)} be cached?`,
  brief: 'A cache makes the second read cheap and the first one stale.',
  options: [
    { id: 'cache', label: 'Cache it', consequence: 'Reads are cheap and may be stale.' },
    { id: 'fresh', label: 'Read fresh', consequence: 'Reads are slow and never stale.' },
  ],
  escape: { id: 'later', label: 'Ask me later', consequence: 'The step waits.' },
  recommended_option_id: 'fresh',
  default_action: 'Every read is fresh.',
  default_window_ms: windowMs,
});

const fromRepository: DeflectionMatch = {
  source: 'repository',
  anchor: { symbol: 'widgetCache', aspect: 'cached' },
  answer: 'CLAUDE.md: widgets are never cached.',
  evidence: 'CLAUDE.md',
  run: null,
};

const eventsOf = (run: string): readonly EventEnvelope[] => readEventLog(runPaths(run, home).eventLog);

describe('the rate is deflected over raised, read from the log (matrix 13)', () => {
  it('reports 5/6 for six questions raised, five deflected and one asked', async () => {
    const reconciler = openReconciler();
    const run = reconciler.acceptFeature(makePlan()).run;
    const asked = [1, 2, 3, 4, 5, 6].map((n) => reconciler.ask(run, aDraft(n)));
    for (const state of asked.slice(0, 5)) {
      const deflection = constructDeflection(fromRepository, clock);
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
      // The sixth is asked and not yet answered: nobody has decided it yet.
      reachedUser: 0,
      defaultTaken: 0,
      unsettled: 1,
      rate: 5 / 6,
      summary:
        'engine-reconciler deflected 5 of 6 raised questions; 0 answered by a person, 0 by the timeout ' +
        'default, 1 unsettled.',
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
      constructDeflection(fromRepository, clock),
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

describe('reachedUser means a person settled it, and a timeout or an open question is its own count (matrix 27)', () => {
  it('reports each way a question left asked in its own field', async () => {
    const reconciler = openReconciler();
    const run = reconciler.acceptFeature(makePlan()).run;
    const deflected = reconciler.ask(run, aDraft(1));
    reconciler.ask(run, aDraft(2));
    reconciler.ask(run, aDraft(3));
    reconciler.ask(run, aDraft(4, WINDOW_MS * 4));
    applyDeflection(runPaths(run, home), deflected.question.id, constructDeflection(fromRepository, clock));
    // An answer goes to the earliest question still asked — the second, now the first is deflected.
    reconciler.answer(run, 'cache');
    advance(WINDOW_MS);
    // The third's window has passed and the pass takes its default; the fourth's has not.
    await reconciler.pass();

    expect(deflectionRate(eventsOf(run), 'engine-reconciler')).toMatchObject({
      kind: 'measured',
      raised: 4,
      deflected: 1,
      reachedUser: 1,
      defaultTaken: 1,
      unsettled: 1,
      rate: 0.25,
    });
  });
});

describe('a merged card counts as the raised questions it stands for (matrix 28)', () => {
  it('puts all three questions a card replaced in the denominator, not one', async () => {
    const reconciler = openReconciler();
    const run = reconciler.acceptFeature(makePlan()).run;
    const anchorOf = { symbol: 'widgetCache', aspect: 'cached' };
    const merged = mergeByAnchor([1, 2, 3].map(() => ({ draft: aDraft(1), anchor: anchorOf, step: 'implement' })));
    const card = merged.questions[0];
    if (card === undefined) throw new Error('three same-anchor questions merge into one card');
    reconciler.ask(run, card.draft, { raisedQuestionCount: card.raised.length });
    const lone = reconciler.ask(run, aDraft(9));
    applyDeflection(runPaths(run, home), lone.question.id, constructDeflection(fromRepository, clock));
    await reconciler.pass();

    const events = eventsOf(run);
    expect(events.filter((event) => event.type === QUESTION_EVENT_TYPES.Asked)).toHaveLength(2);
    expect(deflectionRate(events, 'engine-reconciler')).toMatchObject({
      raised: 4,
      deflected: 1,
      unsettled: 3,
      rate: 0.25,
    });
  });
});

describe('the count is a structured payload field, and the brief is only a fallback for older lines', () => {
  /** One `question.asked` envelope, as a reader meets it in the log. */
  const askedLine = (seq: number, payload: Record<string, unknown>): EventEnvelope => ({
    ts: '2026-09-23T10:00:00.000Z',
    seq,
    feature: 'engine-reconciler',
    run: 'r',
    step: null,
    emitter: 'engine',
    type: QUESTION_EVENT_TYPES.Asked,
    payload,
  });

  it('states the count on every question.asked line, 1 for an unmerged question', async () => {
    const reconciler = openReconciler();
    const run = reconciler.acceptFeature(makePlan()).run;
    reconciler.ask(run, aDraft(1));
    reconciler.ask(run, aDraft(2), { raisedQuestionCount: 3 });
    await reconciler.pass();
    const counts = eventsOf(run)
      .filter((event) => event.type === QUESTION_EVENT_TYPES.Asked)
      .map((event) => event.payload['raised_question_count']);
    expect(counts).toStrictEqual([1, 3]);
  });

  it('takes the field over the brief, so a brief without the merge sentence cannot undercount', () => {
    // A card whose brief was reworded or cut: the sentence is gone, the field is not.
    const events = [askedLine(1, { question_id: 'q-a', brief: 'Reworded entirely.', raised_question_count: 3 })];
    expect(deflectionRate(events, 'engine-reconciler')).toMatchObject({ raised: 3 });
  });

  it('falls back to the brief only for a line with no field, as an older build wrote it', () => {
    const brief = 'Why.\n\nThis one question stands for 2 raised questions: they share the anchor "x:y"';
    expect(deflectionRate([askedLine(1, { question_id: 'q-a', brief })], 'engine-reconciler')).toMatchObject({
      raised: 2,
    });
  });

  it('does not trust an unusable count, which would drop a question from the denominator', () => {
    const events = [askedLine(1, { question_id: 'q-a', brief: 'Why.', raised_question_count: 0 })];
    expect(deflectionRate(events, 'engine-reconciler')).toMatchObject({ raised: 1 });
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
    expect(rate).toMatchObject({ kind: 'measured', raised: 1, deflected: 0, reachedUser: 0, unsettled: 1, rate: 0 });
  });
});
