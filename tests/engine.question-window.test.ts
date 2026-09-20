/**
 * CAP-4 — the window, and the collision between a person and a clock.
 *
 * The timeout is a *resolver*, not a special case: it competes in the same compare-and-set the TUI and web
 * answers compete in, which is why the interesting tests here are the two orderings rather than the happy
 * path. An answer arriving before expiry must win and the default must never be taken; an answer arriving
 * after the default was taken must be told, plainly, that it timed out — because a user who believes their
 * answer landed and a system that took the default have diverged about a decision AD-25 has already made
 * durable.
 *
 * The clock is injected rather than waited on. A suite that slept for a real window would be slow *and*
 * flaky, and it would test the scheduler rather than the transition: what matters is what the loop decides
 * when `now` is past the due instant, and that is a property of the decision, not of elapsed time.
 */
import { rmSync } from 'node:fs';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { QuestionDraft } from '../src/contracts/index.js';
import { readEventLog, runPaths } from '../src/runtime/index.js';
import {
  DECISION_EVENT_TYPE,
  QUESTION_EVENT_TYPES,
  QUESTION_TIMEOUT_PRINCIPAL,
  Reconciler,
  SteeringRefused,
  createRecordingResetter,
  createScriptedExecutor,
  decisionsInLog,
  describeQuestions,
  isQuestionDefaultDue,
  mintIntentId,
  mintRunId,
  newCommandIntent,
  questionDefaultDueAt,
  questionDefaultDueAtMs,
  questionWindowRemainingMs,
  settleQuestion,
  takeQuestionDefault,
  terminated,
  writeCommandIntent,
} from '../src/engine/index.js';

import { makeHome, makePlan, planProvider } from './helpers/engine-fixture.js';

const BASELINE = 'ddd9bed4d286ac1f8a0f4f7bfef9530046605787';
const WINDOW_MS = 15 * 60 * 1000;

let home: string;
let clock: Date;
const toRemove: string[] = [];
const toClose: Reconciler[] = [];

beforeEach(() => {
  home = makeHome('engine-question-window');
  toRemove.push(home);
  clock = new Date('2026-09-20T10:00:00.000Z');
});

afterEach(() => {
  for (const reconciler of toClose.splice(0)) reconciler.close();
  for (const dir of toRemove.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const advance = (ms: number): void => {
  clock = new Date(clock.getTime() + ms);
};

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

const aDraft = (overrides: Partial<QuestionDraft> = {}): QuestionDraft => ({
  prompt: 'Should the committer squash the step commits before opening the pull request?',
  brief:
    'Each step commits its own work so a re-run can reset to a baseline. That leaves one commit per step ' +
    'on the feature branch, which is either useful history or noise depending on the reviewer.',
  options: [
    { id: 'squash', label: 'Squash to one commit', consequence: 'The branch reads as one change.' },
    { id: 'keep', label: 'Keep the step commits', consequence: 'The branch shows each step.' },
  ],
  escape: {
    id: 'ask-at-review',
    label: 'Decide at the review',
    consequence: 'The pull request is opened with the step commits and squashed on merge if asked.',
  },
  recommended_option_id: 'keep',
  default_action: 'The step commits are kept, and the pull request is opened as it stands.',
  default_window_ms: WINDOW_MS,
  ...overrides,
});

const typesOf = (run: string): readonly string[] =>
  readEventLog(runPaths(run, home).eventLog).map((event) => event.type);

const payloadOf = (run: string, type: string): Record<string, unknown> | undefined =>
  readEventLog(runPaths(run, home).eventLog).find((event) => event.type === type)?.payload;

describe('when the window is due is a function of the question, not of the loop', () => {
  it('computes the due instant from asked_at plus the declared window', () => {
    const reconciler = openReconciler();
    const run = reconciler.acceptFeature(makePlan()).run;
    const asked = reconciler.ask(run, aDraft());

    expect(questionDefaultDueAtMs(asked.question)).toBe(clock.getTime() + WINDOW_MS);
    expect(questionDefaultDueAt(asked.question)).toBe('2026-09-20T10:15:00.000Z');
    expect(questionWindowRemainingMs(asked.question, clock)).toBe(WINDOW_MS);
    expect(isQuestionDefaultDue(asked, clock)).toBe(false);

    advance(WINDOW_MS - 1);
    expect(isQuestionDefaultDue(asked, clock)).toBe(false);
    expect(questionWindowRemainingMs(asked.question, clock)).toBe(1);

    advance(1);
    // At the instant it is due, not merely after it: a window that expires "eventually" is not a window.
    expect(isQuestionDefaultDue(asked, clock)).toBe(true);
    expect(questionWindowRemainingMs(asked.question, clock)).toBe(0);
  });

  it('never reports a resolved question as due, so no second default is ever taken', () => {
    const reconciler = openReconciler();
    const run = reconciler.acceptFeature(makePlan()).run;
    reconciler.ask(run, aDraft());
    reconciler.answer(run, 'squash');
    advance(WINDOW_MS * 10);

    const settled = reconciler.questions(run)[0];
    expect(settled?.state.status).toBe('resolved');
    expect(isQuestionDefaultDue(settled?.state ?? (null as never), clock)).toBe(false);
  });
});

describe('the window expires: the default is taken, and it is a decision like any other', () => {
  it('takes the default during a pass, emits question.default_taken, and records the decision', async () => {
    const reconciler = openReconciler();
    const run = reconciler.acceptFeature(makePlan()).run;
    const asked = reconciler.ask(run, aDraft());

    // Before the window, a pass leaves it alone and reports it as open.
    const early = await reconciler.pass();
    expect(early.questions.find((entry) => entry.run === run)?.open).toStrictEqual([asked.question.id]);
    expect(typesOf(run)).not.toContain(QUESTION_EVENT_TYPES.DefaultTaken);

    advance(WINDOW_MS);
    const result = await reconciler.pass();

    const outcome = result.questions.find((entry) => entry.run === run);
    expect(outcome?.settled.map((entry) => entry.kind)).toStrictEqual(['default-taken']);
    expect(outcome?.settled[0]?.decisionRecorded).toBe(true);
    expect(outcome?.open).toStrictEqual([]);
    // One line a renderer can show, naming the question and what became of it (R2, R7).
    expect(describeQuestions(outcome ?? (null as never))).toContain('default-taken');

    // `question.default_taken`, not `question.resolved`: the mapping lives in story 1-1's one function.
    expect(typesOf(run)).toContain(QUESTION_EVENT_TYPES.DefaultTaken);
    expect(typesOf(run)).not.toContain(QUESTION_EVENT_TYPES.Resolved);

    const settled = settleQuestion(runPaths(run, home), asked.question.id);
    expect(settled.state.status).toBe('resolved');
    expect(settled.state.resolution?.resolver).toBe('timeout_default');
    // Nobody decided this; the window did, and `timeout` is a declared principal kind precisely so the
    // record can say so rather than attributing it to the user who did not answer.
    expect(settled.state.resolution?.principal).toStrictEqual(QUESTION_TIMEOUT_PRINCIPAL);
    expect(settled.state.resolution?.principal.kind).toBe('timeout');
    expect(settled.state.resolution?.option_id).toBe('keep');

    // Non-response is a valid input, so it leaves the same record an answer would.
    const decisions = decisionsInLog(readEventLog(runPaths(run, home).eventLog));
    expect(decisions).toHaveLength(1);
    expect(decisions[0]?.['resolver']).toBe('timeout_default');
    expect(decisions[0]?.['principal_kind']).toBe('timeout');
    expect(String(decisions[0]?.['answer'])).toContain('Keep the step commits');
  });

  it('takes it exactly once, however many passes follow', async () => {
    const reconciler = openReconciler();
    const run = reconciler.acceptFeature(makePlan()).run;
    reconciler.ask(run, aDraft());
    advance(WINDOW_MS);

    await reconciler.pass();
    await reconciler.pass();
    await reconciler.pass();

    expect(typesOf(run).filter((type) => type === QUESTION_EVENT_TYPES.DefaultTaken)).toHaveLength(1);
    expect(decisionsInLog(readEventLog(runPaths(run, home).eventLog))).toHaveLength(1);
  });

  it('repeats the question’s own stated consequence back, rather than inventing a sentence', async () => {
    const reconciler = openReconciler();
    const run = reconciler.acceptFeature(makePlan()).run;
    reconciler.ask(run, aDraft());
    advance(WINDOW_MS);
    await reconciler.pass();

    // Q2 already required the question to say what happens if it is ignored, so the decision record says
    // that, not a paraphrase the system made up after the fact.
    const payload = payloadOf(run, QUESTION_EVENT_TYPES.DefaultTaken);
    expect(String(payload?.['answer'])).toContain('The step commits are kept');
  });

  it('does not take a default against a terminal run, which nothing walks backwards', async () => {
    const reconciler = openReconciler();
    const run = reconciler.acceptFeature(makePlan()).run;
    reconciler.ask(run, aDraft());
    reconciler.disengage(run);
    advance(WINDOW_MS * 5);

    await reconciler.pass();

    // The question keeps its `asked` state, which is the honest record: it was asked and never answered.
    expect(typesOf(run)).not.toContain(QUESTION_EVENT_TYPES.DefaultTaken);
    expect(reconciler.questions(run)[0]?.state.status).toBe('asked');
    expect(decisionsInLog(readEventLog(runPaths(run, home).eventLog))).toStrictEqual([]);
  });
});

describe('an answer arriving before expiry wins, and the default is never taken', () => {
  it('resolves by the answer, and no later pass takes a default over it', async () => {
    const reconciler = openReconciler();
    const run = reconciler.acceptFeature(makePlan()).run;
    const asked = reconciler.ask(run, aDraft());

    advance(WINDOW_MS - 1);
    reconciler.answer(run, 'squash', { principal: { kind: 'user', id: 'deep' } });

    const settled = settleQuestion(runPaths(run, home), asked.question.id);
    expect(settled.state.resolution?.resolver).toBe('tui');
    expect(settled.state.resolution?.option_id).toBe('squash');

    // Well past the window now. The default must still never be taken: the question is not `asked`.
    advance(WINDOW_MS * 10);
    await reconciler.pass();
    await reconciler.pass();

    expect(typesOf(run)).toContain(QUESTION_EVENT_TYPES.Resolved);
    expect(typesOf(run)).not.toContain(QUESTION_EVENT_TYPES.DefaultTaken);
    expect(decisionsInLog(readEventLog(runPaths(run, home).eventLog))).toHaveLength(1);
  });

  it('lets an answer written before expiry win even when it is consumed after it', async () => {
    /**
     * The scheduling case, and the reason a pass consumes intents *before* it settles windows. The answer
     * is on disk before the window passes; the pass that would take the default is the pass that consumes
     * the answer. If the order were the other way round, "an answer arriving before expiry wins" would be a
     * race against the loop's own timing rather than a property of the system.
     */
    const reconciler = openReconciler();
    const run = reconciler.acceptFeature(makePlan()).run;
    const asked = reconciler.ask(run, aDraft());

    writeCommandIntent(
      runPaths(run, home),
      newCommandIntent({
        intentId: mintIntentId(mintRunId()),
        command: 'answer',
        run,
        feature: 'engine-reconciler',
        principal: { kind: 'user', id: 'deep' },
        source: 'tui',
        argument: 'squash',
        issuedAt: clock,
      }),
    );
    advance(WINDOW_MS * 2);

    const result = await reconciler.pass();
    expect(result.steering.find((entry) => entry.run === run)?.applied.map((entry) => entry.kind)).toStrictEqual(
      ['resolved-question'],
    );
    expect(settleQuestion(runPaths(run, home), asked.question.id).state.resolution?.resolver).toBe('tui');
    expect(typesOf(run)).not.toContain(QUESTION_EVENT_TYPES.DefaultTaken);
  });
});

describe('the window beats the answer: the human is told it timed out', () => {
  it('refuses the late answer, names the window and the default, and leaves the default standing', async () => {
    const reconciler = openReconciler();
    const run = reconciler.acceptFeature(makePlan()).run;
    const asked = reconciler.ask(run, aDraft());

    advance(WINDOW_MS);
    await reconciler.pass();
    expect(typesOf(run)).toContain(QUESTION_EVENT_TYPES.DefaultTaken);

    let raised: SteeringRefused | null = null;
    try {
      reconciler.answer(run, 'squash', { principal: { kind: 'user', id: 'deep' } });
    } catch (thrown: unknown) {
      raised = thrown as SteeringRefused;
    }

    // Not silently discarded. The losing path's message is part of the contract: it names the window, when
    // it passed, and the decision that stands.
    expect(raised).toBeInstanceOf(SteeringRefused);
    expect(raised?.message).toContain('timed out');
    expect(raised?.message).toContain('2026-09-20T10:15:00.000Z');
    expect(raised?.message).toContain('Keep the step commits');
    expect(raised?.message).toContain('wrote nothing');

    // The default stands, unchanged, and no second resolution or decision was written.
    const settled = settleQuestion(runPaths(run, home), asked.question.id);
    expect(settled.state.resolution?.resolver).toBe('timeout_default');
    expect(settled.state.resolution?.option_id).toBe('keep');
    expect(typesOf(run).filter((type) => type === QUESTION_EVENT_TYPES.DefaultTaken)).toHaveLength(1);
    expect(typesOf(run)).not.toContain(QUESTION_EVENT_TYPES.Resolved);
    expect(decisionsInLog(readEventLog(runPaths(run, home).eventLog))).toHaveLength(1);
    expect(typesOf(run).filter((type) => type === DECISION_EVENT_TYPE)).toHaveLength(1);
  });

  it('loses the O_EXCL create rather than comparing timestamps, when a default races an answer', () => {
    /**
     * The direct form of the same property, asserted at the primitive. `takeQuestionDefault` does not ask
     * whether it is "later" than the answer — it attempts the exclusive create and loses. Any design that
     * decided this by comparing `resolved_at` values would pass a single-process test and fail in
     * production, which is the whole reason the claim is a file.
     */
    const reconciler = openReconciler();
    const run = reconciler.acceptFeature(makePlan()).run;
    const asked = reconciler.ask(run, aDraft());
    reconciler.answer(run, 'squash');

    advance(WINDOW_MS);
    const claim = takeQuestionDefault(runPaths(run, home), asked.question.id, asked.question, clock);
    expect(claim.accepted).toBe(false);
    expect(claim.created).toBe(false);
    expect(claim.refusal).toContain('already');
    expect(claim.state.resolution?.resolver).toBe('tui');
  });
});
