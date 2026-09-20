/**
 * AD-25 — asking a question durably, resolving it once, and what each outcome records.
 *
 * Nine of the matrix's fifteen rows live here: the four draft refusals, asking, the happy resolution, the
 * losing resolver, deflection, the rejection reason, the torn state file and the crash mid-transition. The
 * three-way race is in `engine.question-race.test.ts`, because a cross-process guarantee cannot be tested
 * in one process; the window is in `engine.question-window.test.ts`.
 *
 * Two of these tests are about *shape* rather than behaviour, and getting them wrong would be silent. The
 * question id is the key every later append is made idempotent by, and it travels in an event payload —
 * where story 1-7 already watched AD-21's entropy sweep eat a bare ULID. So the round-trip here is driven
 * through a real recorder with a real minted id, and the negative case asserts a bare ULID would in fact
 * have been refused: an assertion against a low-entropy stand-in would prove nothing, which is the mistake
 * stories 1-2 and 1-3 each paid for once.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { writesToDecisionLedger } from '../src/contracts/index.js';
import type { QuestionDraft, QuestionState } from '../src/contracts/index.js';
import { REDACTION_MARKER, readEventLog, runPaths } from '../src/runtime/index.js';
import {
  DECISION_EVENT_TYPE,
  MAX_QUESTION_ID_TOKEN_RUN,
  QUESTION_EVENT_TYPES,
  QuestionDraftRefused,
  Reconciler,
  SteeringRefused,
  TornQuestionState,
  UnloggableQuestionId,
  askQuestion,
  attemptQuestionResolution,
  createRecordingResetter,
  createScriptedExecutor,
  decidedQuestionIds,
  decisionFor,
  decisionsInLog,
  isLoggableQuestionId,
  mintQuestionId,
  mintRunId,
  parseOptionSelection,
  questionResolution,
  settleQuestion,
  settledQuestionIds,
  terminated,
} from '../src/engine/index.js';

import { makeHome, makePlan, planProvider } from './helpers/engine-fixture.js';

const BASELINE = 'ddd9bed4d286ac1f8a0f4f7bfef9530046605787';

let home: string;
const toRemove: string[] = [];
const toClose: Reconciler[] = [];

beforeEach(() => {
  home = makeHome('engine-questions');
  toRemove.push(home);
});

afterEach(() => {
  for (const reconciler of toClose.splice(0)) reconciler.close();
  for (const dir of toRemove.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A reconciler over one plan, whose steps never run: this suite never advances a feature. */
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

/**
 * A draft that satisfies Q1, Q2 and Q3, so every refusal test can take exactly one thing away.
 *
 * Built from a whole valid draft rather than assembled per test, because the refusals are the point: a
 * fixture that was missing two fields would pass a test asserting the wrong one.
 */
const aDraft = (overrides: Partial<QuestionDraft> = {}): QuestionDraft => ({
  prompt: 'Should an unknown field in a step’s output be rejected or ignored?',
  brief:
    'The step output contract is validated twice: once by the model’s own structured output and once by ' +
    'the reconciler re-parsing it. Rejecting an unknown field makes a schema drift loud; ignoring it lets ' +
    'a newer step run against an older engine.',
  options: [
    { id: 'reject', label: 'Reject unknown fields', consequence: 'A drifted step fails loudly and re-runs.' },
    { id: 'ignore', label: 'Ignore unknown fields', consequence: 'A newer step runs against this engine.' },
  ],
  escape: {
    id: 'decide-later',
    label: 'Leave it open and ask me at the review',
    consequence: 'The step is not run until the question is answered.',
  },
  recommended_option_id: 'reject',
  default_action: 'Unknown fields are rejected, and the step re-runs against the declared contract.',
  default_window_ms: 15 * 60 * 1000,
  ...overrides,
});

const aRun = (reconciler: Reconciler): string => reconciler.acceptFeature(makePlan()).run;

const eventsOf = (run: string): readonly { type: string; payload: Record<string, unknown> }[] =>
  readEventLog(runPaths(run, home).eventLog);

const typesOf = (run: string): readonly string[] => eventsOf(run).map((event) => event.type);

const questionDirs = (run: string): readonly string[] => {
  try {
    return readdirSync(runPaths(run, home).questionsDir).sort();
  } catch {
    return [];
  }
};

describe('a draft the interface contract forbids asking is refused, naming the field', () => {
  it('refuses a draft with no recommended default, because CAP-4 would have nothing to take', () => {
    const reconciler = openReconciler();
    const run = aRun(reconciler);
    let raised: QuestionDraftRefused | null = null;
    try {
      reconciler.ask(run, aDraft({ recommended_option_id: '' }));
    } catch (thrown: unknown) {
      raised = thrown as QuestionDraftRefused;
    }
    expect(raised).toBeInstanceOf(QuestionDraftRefused);
    expect(raised?.field).toBe('recommended_option_id');
    // Nothing reached disk: a refused draft is not a question anybody could answer or default.
    expect(questionDirs(run)).toStrictEqual([]);
  });

  it('refuses a draft whose window is zero, which would take the default as it was asked', () => {
    const reconciler = openReconciler();
    const run = aRun(reconciler);
    expect(() => reconciler.ask(run, aDraft({ default_window_ms: 0 }))).toThrowError(
      /default_window_ms/,
    );
    expect(questionDirs(run)).toStrictEqual([]);
  });

  it('refuses a draft with no self-contained brief (Q3)', () => {
    const reconciler = openReconciler();
    const run = aRun(reconciler);
    let raised: QuestionDraftRefused | null = null;
    try {
      reconciler.ask(run, aDraft({ brief: '   ' }));
    } catch (thrown: unknown) {
      raised = thrown as QuestionDraftRefused;
    }
    expect(raised?.field).toBe('brief');
    expect(raised?.message).toContain('Q3');
    expect(questionDirs(run)).toStrictEqual([]);
  });

  it('refuses a draft with no stated consequence of silence (Q2)', () => {
    const reconciler = openReconciler();
    const run = aRun(reconciler);
    let raised: QuestionDraftRefused | null = null;
    try {
      reconciler.ask(run, aDraft({ default_action: '' }));
    } catch (thrown: unknown) {
      raised = thrown as QuestionDraftRefused;
    }
    expect(raised?.field).toBe('default_action');
    expect(questionDirs(run)).toStrictEqual([]);
  });

  it('refuses a draft offering four options, because Q1 allows at most three plus an escape', () => {
    const reconciler = openReconciler();
    const run = aRun(reconciler);
    let raised: QuestionDraftRefused | null = null;
    try {
      reconciler.ask(
        run,
        aDraft({
          options: [
            { id: 'a', label: 'A', consequence: 'a' },
            { id: 'b', label: 'B', consequence: 'b' },
            { id: 'c', label: 'C', consequence: 'c' },
            { id: 'd', label: 'D', consequence: 'd' },
          ],
        }),
      );
    } catch (thrown: unknown) {
      raised = thrown as QuestionDraftRefused;
    }
    expect(raised).toBeInstanceOf(QuestionDraftRefused);
    expect(raised?.field).toBe('options');
    expect(questionDirs(run)).toStrictEqual([]);
  });

  it('refuses a draft with no concrete option at all, which is the open-ended question Q1 forbids', () => {
    const reconciler = openReconciler();
    const run = aRun(reconciler);
    expect(() => reconciler.ask(run, aDraft({ options: [] }))).toThrowError(QuestionDraftRefused);
    expect(questionDirs(run)).toStrictEqual([]);
  });

  it('carries the declared question.unanswerable code, so a refusal routes rather than surprises', () => {
    const refused = new QuestionDraftRefused('brief', 'no brief');
    expect(refused.code).toBe('question.unanswerable');
  });
});

describe('asking a question makes it durable before it makes it visible', () => {
  it('writes the state file under questions/ and emits question.asked', () => {
    const reconciler = openReconciler();
    const run = aRun(reconciler);
    const asked = reconciler.ask(run, aDraft(), { step: 'implement' });

    expect(asked.status).toBe('asked');
    expect(asked.resolution).toBeNull();
    expect(questionDirs(run)).toStrictEqual([asked.question.id]);

    const onDisk = JSON.parse(
      readFileSync(join(runPaths(run, home).questionsDir, asked.question.id, 'state.json'), 'utf8'),
    ) as QuestionState;
    expect(onDisk.question.id).toBe(asked.question.id);
    expect(onDisk.question.step).toBe('implement');
    expect(onDisk.status).toBe('asked');

    expect(typesOf(run)).toContain(QUESTION_EVENT_TYPES.Asked);
    // Nothing is decided by asking, so nothing is recorded as a decision.
    expect(typesOf(run)).not.toContain(DECISION_EVENT_TYPE);
  });

  it('is idempotent on the question id, so a retried ask produces one question', () => {
    const reconciler = openReconciler();
    const run = aRun(reconciler);
    const questionId = mintQuestionId(mintRunId());
    reconciler.ask(run, aDraft(), { questionId });
    reconciler.ask(run, aDraft({ prompt: 'a different prompt entirely' }), { questionId });

    expect(questionDirs(run)).toStrictEqual([questionId]);
    // One line, not two: the second ask found the question already durable.
    expect(typesOf(run).filter((type) => type === QUESTION_EVENT_TYPES.Asked)).toHaveLength(1);
    // The first draft stands. A second ask under one id is a retry, never an amendment.
    expect(reconciler.questions(run)[0]?.state.question.prompt).toContain('unknown field');
  });

  it('carries the question id, the window and the consequence of silence into the payload', () => {
    const reconciler = openReconciler();
    const run = aRun(reconciler);
    const asked = reconciler.ask(run, aDraft());
    const line = eventsOf(run).find((event) => event.type === QUESTION_EVENT_TYPES.Asked);

    expect(line?.payload['question_id']).toBe(asked.question.id);
    expect(line?.payload['recommended_option_id']).toBe('reject');
    expect(line?.payload['default_window_ms']).toBe(15 * 60 * 1000);
    expect(line?.payload['default_action']).toContain('rejected');
    // Q1 — the offered ids include the escape, so a reader can tell what could have been selected.
    expect(String(line?.payload['options'])).toContain('decide-later');
  });
});

describe('the question id survives the log, which is what makes every append idempotent', () => {
  it('mints an id with no run long enough for the AD-21 entropy sweep to reach', () => {
    const ulid = mintRunId();
    // A bare ULID: 26 unbroken characters at ~4.1 bits each, which is exactly what AD-21 sweeps. Asserted
    // against a real minted ULID rather than a stand-in, because a low-entropy fixture would pass here
    // while the real thing was being redacted in production.
    expect(isLoggableQuestionId(ulid)).toBe(false);
    const minted = mintQuestionId(ulid);
    expect(isLoggableQuestionId(minted)).toBe(true);
    for (const token of minted.match(/[A-Za-z0-9+/=]+/g) ?? []) {
      expect(token.length).toBeLessThanOrEqual(MAX_QUESTION_ID_TOKEN_RUN);
    }
  });

  it('refuses to ask a question under an id the redaction pass would replace', () => {
    const reconciler = openReconciler();
    const run = aRun(reconciler);
    expect(() => reconciler.ask(run, aDraft(), { questionId: mintRunId() })).toThrowError(
      UnloggableQuestionId,
    );
    expect(questionDirs(run)).toStrictEqual([]);
  });

  it('reads a minted id back out of a real event log unchanged, in all three of its lines', () => {
    const reconciler = openReconciler();
    const run = aRun(reconciler);
    const asked = reconciler.ask(run, aDraft());
    reconciler.answer(run, 'reject');

    const carrying = eventsOf(run).filter((event) =>
      [QUESTION_EVENT_TYPES.Asked, QUESTION_EVENT_TYPES.Resolved, DECISION_EVENT_TYPE].includes(
        event.type,
      ),
    );
    expect(carrying).toHaveLength(3);
    for (const event of carrying) {
      // Verbatim, not `[redacted]`. A redacted id would make every later pass re-emit these same three
      // lines for ever, and the run would otherwise keep working — which is why this is a real round trip.
      expect(event.payload['question_id'], event.type).toBe(asked.question.id);
      expect(JSON.stringify(event.payload)).not.toContain(REDACTION_MARKER);
    }
    expect(settledQuestionIds(readEventLog(runPaths(run, home).eventLog)).has(asked.question.id)).toBe(
      true,
    );
  });
});

describe('the first resolver wins and records who it was', () => {
  it('records the resolver and the principal, and writes the decision', () => {
    const reconciler = openReconciler();
    const run = aRun(reconciler);
    const asked = reconciler.ask(run, aDraft());

    reconciler.answer(run, 'ignore', { principal: { kind: 'user', id: 'deep' }, source: 'tui' });

    const settled = settleQuestion(runPaths(run, home), asked.question.id);
    expect(settled.state.status).toBe('resolved');
    expect(settled.state.resolution?.resolver).toBe('tui');
    expect(settled.state.resolution?.principal).toStrictEqual({ kind: 'user', id: 'deep' });
    // Q6 — free text, and the system parses: the words named an offered option, so it was selected.
    expect(settled.state.resolution?.option_id).toBe('ignore');
    expect(settled.state.resolution?.answer).toBe('ignore');

    expect(typesOf(run)).toContain(QUESTION_EVENT_TYPES.Resolved);
    expect(typesOf(run)).not.toContain(QUESTION_EVENT_TYPES.DefaultTaken);

    const decisions = decisionsInLog(readEventLog(runPaths(run, home).eventLog));
    expect(decisions).toHaveLength(1);
    expect(decisions[0]?.['resolver']).toBe('tui');
    expect(decisions[0]?.['principal_id']).toBe('deep');
    expect(decisions[0]?.['answer']).toBe('ignore');
  });

  it('records free text that names no option as the prose it is, rather than guessing', () => {
    const reconciler = openReconciler();
    const run = aRun(reconciler);
    const asked = reconciler.ask(run, aDraft());
    reconciler.answer(run, 'whichever keeps the schema drift loud, but log it either way');

    const settled = settleQuestion(runPaths(run, home), asked.question.id);
    // A wrong option silently attributed to a person is worse than no option at all: the decision is
    // durable, and AD-25's attribution rule exists to stop exactly that.
    expect(settled.state.resolution?.option_id).toBeNull();
    expect(settled.state.resolution?.answer).toContain('schema drift');
  });

  it('parses an option by its label as well as by its id, and nothing else', () => {
    const question = { ...aDraft(), id: 'q-1', feature: 'f', run: 'r', step: null, asked_at: '' };
    expect(parseOptionSelection(question, ' Reject Unknown Fields ')).toBe('reject');
    expect(parseOptionSelection(question, 'IGNORE')).toBe('ignore');
    expect(parseOptionSelection(question, 'decide-later')).toBe('decide-later');
    expect(parseOptionSelection(question, 'rej')).toBeNull();
    expect(parseOptionSelection(question, '')).toBeNull();
  });
});

describe('a second resolver receives an already-resolved result and writes nothing', () => {
  it('refuses a later answer, leaves the first outcome standing, and retires the file', () => {
    const reconciler = openReconciler();
    const run = aRun(reconciler);
    const asked = reconciler.ask(run, aDraft());
    reconciler.answer(run, 'reject', { principal: { kind: 'user', id: 'first' } });

    let raised: SteeringRefused | null = null;
    try {
      reconciler.answer(run, 'ignore', { principal: { kind: 'user', id: 'second' } });
    } catch (thrown: unknown) {
      raised = thrown as SteeringRefused;
    }

    expect(raised).toBeInstanceOf(SteeringRefused);
    expect(raised?.message).toMatch(/already|stands/i);

    // The first outcome stands, down to the principal it was attributed to.
    const settled = settleQuestion(runPaths(run, home), asked.question.id);
    expect(settled.state.resolution?.principal.id).toBe('first');
    expect(settled.state.resolution?.answer).toBe('reject');

    // One resolution line and one decision: the loser wrote nothing at all.
    expect(typesOf(run).filter((type) => type === QUESTION_EVENT_TYPES.Resolved)).toHaveLength(1);
    expect(decisionsInLog(readEventLog(runPaths(run, home).eventLog))).toHaveLength(1);

    // And the losing intent is not met again by every later pass.
    expect(readdirSync(runPaths(run, home).commandsDir).filter((name) => name.endsWith('.json'))).toStrictEqual(
      [],
    );
  });

  it('tells the same gesture delivered twice that it won, rather than that it lost to itself', () => {
    // AD-19 makes delivery at-least-once, so one keystroke can leave two files. The second must not be
    // reported to the user as having lost the race to their own answer.
    const reconciler = openReconciler();
    const run = aRun(reconciler);
    const asked = reconciler.ask(run, aDraft());
    const resolution = questionResolution({
      resolver: 'tui',
      principal: { kind: 'user', id: 'deep' },
      answer: 'reject',
      optionId: 'reject',
    });
    const paths = runPaths(run, home);

    const first = attemptQuestionResolution(paths, asked.question.id, resolution, { intentId: 'cmd-1' });
    expect(first.accepted).toBe(true);
    expect(first.created).toBe(true);

    const redelivered = attemptQuestionResolution(paths, asked.question.id, resolution, {
      intentId: 'cmd-1',
    });
    expect(redelivered.accepted).toBe(true);
    expect(redelivered.created).toBe(false);
    expect(redelivered.refusal).toBeNull();

    const other = attemptQuestionResolution(paths, asked.question.id, resolution, { intentId: 'cmd-2' });
    expect(other.accepted).toBe(false);
    expect(other.refusal).toContain('already');
  });

  it('refuses a resolution selecting an option nobody offered, before anything is contended for', () => {
    const reconciler = openReconciler();
    const run = aRun(reconciler);
    const asked = reconciler.ask(run, aDraft());
    const claim = attemptQuestionResolution(
      runPaths(run, home),
      asked.question.id,
      questionResolution({
        resolver: 'tui',
        principal: { kind: 'user', id: 'deep' },
        answer: 'something else',
        optionId: 'never-offered',
      }),
    );
    expect(claim.accepted).toBe(false);
    expect(claim.created).toBe(false);
    expect(claim.refusal).toContain('never offered');
    // A malformed answer is not a lost race: the question is still open for the resolver that got it right.
    expect(settleQuestion(runPaths(run, home), asked.question.id).state.status).toBe('asked');
  });
});

describe('an answer with no question is refused by name', () => {
  it('refuses and quarantines an answer for a run that has asked nothing', () => {
    const reconciler = openReconciler();
    const run = aRun(reconciler);
    expect(() => reconciler.answer(run, 'the first option')).toThrowError(/nothing to resolve/);
    // Nothing recorded as a decision: an answer to no question is not a decision.
    expect(typesOf(run)).not.toContain(DECISION_EVENT_TYPE);
  });
});

describe('only a resolved question leaves a decision record', () => {
  it('records nothing for a deflected question, because nobody was asked', () => {
    const reconciler = openReconciler();
    const run = aRun(reconciler);
    const asked = reconciler.ask(run, aDraft());

    const claim = reconciler.deflect(run, asked.question.id, {
      source: 'decision_ledger',
      answer: 'the same question was answered "reject" for this area last week',
      anchor: 'tests/contracts.round-trip.test.ts',
    });

    expect(claim.accepted).toBe(true);
    expect(claim.state.status).toBe('deflected');
    expect(claim.state.resolution).toBeNull();
    expect(writesToDecisionLedger(claim.state)).toBe(false);

    expect(typesOf(run)).toContain(QUESTION_EVENT_TYPES.Deflected);
    expect(typesOf(run)).not.toContain(QUESTION_EVENT_TYPES.Resolved);
    // The rule AD-25 states, made observable rather than inferred: no decision line at all.
    expect(decisionsInLog(readEventLog(runPaths(run, home).eventLog))).toStrictEqual([]);
    expect(decisionFor(claim.state)).toBeNull();
  });

  it('refuses an answer to a deflected question: the deflection is a transition like any other', () => {
    const reconciler = openReconciler();
    const run = aRun(reconciler);
    const asked = reconciler.ask(run, aDraft());
    reconciler.deflect(run, asked.question.id, {
      source: 'git_history',
      answer: 'the convention has been "reject" since the contracts landed',
      anchor: 'src/contracts/step.ts',
    });
    expect(() => reconciler.answer(run, 'ignore')).toThrowError(SteeringRefused);
    expect(settleQuestion(runPaths(run, home), asked.question.id).state.status).toBe('deflected');
  });
});

describe('a rejection carries its reason into the decision', () => {
  it('records the reason as the decision, never discarding it', () => {
    const reconciler = openReconciler();
    const run = aRun(reconciler);
    reconciler.ask(run, aDraft());
    const reason = 'neither option is right: the contract should carry a version instead';

    reconciler.reject(run, reason);

    const decisions = decisionsInLog(readEventLog(runPaths(run, home).eventLog));
    expect(decisions).toHaveLength(1);
    // "Rejection is one keystroke plus a reason, and the reason becomes a ledger entry."
    expect(decisions[0]?.['answer']).toBe(reason);
    expect(decisions[0]?.['principal_kind']).toBe('user');
  });

  it('carries an amended criterion through the same transition (CAP-2)', () => {
    const reconciler = openReconciler();
    const run = aRun(reconciler);
    const asked = reconciler.ask(run, aDraft());
    reconciler.editCriterion(run, 'the parser rejects unknown fields and names the field');

    const settled = settleQuestion(runPaths(run, home), asked.question.id);
    expect(settled.state.status).toBe('resolved');
    expect(settled.state.resolution?.answer).toContain('names the field');
  });
});

describe('a torn question state file is refused, and no transition is attempted', () => {
  it('refuses the question, reports it against its id, and leaves every other question alone', async () => {
    const reconciler = openReconciler();
    const run = aRun(reconciler);
    const healthy = reconciler.ask(run, aDraft());

    // A state file half written by a process that died inside the write. The real writer is atomic, so
    // this is hand-made — which is the point: the loop must refuse it rather than read part of it.
    const tornId = mintQuestionId(mintRunId());
    const tornDir = join(runPaths(run, home).questionsDir, tornId);
    mkdirSync(tornDir, { recursive: true });
    writeFileSync(join(tornDir, 'state.json'), '{"schema_version": 1, "question": {"id": "q-', 'utf8');

    const result = await reconciler.pass();
    const questions = result.questions.find((entry) => entry.run === run);
    expect(questions?.refused.map((entry) => entry.questionId)).toStrictEqual([tornId]);
    expect(questions?.refused[0]?.code).toBe('internal.invariant_violated');
    // No transition against the torn question, and no outcome file invented for it.
    expect(existsSync(join(tornDir, 'outcome.json'))).toBe(false);
    // The healthy question is untouched and still open.
    expect(questions?.open).toContain(healthy.question.id);
  });

  it('refuses a read of a torn state file directly, rather than returning a partial question', () => {
    const reconciler = openReconciler();
    const run = aRun(reconciler);
    const questionId = mintQuestionId(mintRunId());
    const dir = join(runPaths(run, home).questionsDir, questionId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'state.json'), '{"schema_version": 1, "stat', 'utf8');
    expect(() => settleQuestion(runPaths(run, home), questionId)).toThrowError(TornQuestionState);
  });
});

describe('a crash between the durable claim and its effect produces exactly one outcome', () => {
  it('finishes the transition on a later pass, appending each line exactly once', async () => {
    const reconciler = openReconciler();
    const run = aRun(reconciler);
    const asked = reconciler.ask(run, aDraft());
    const paths = runPaths(run, home);

    /**
     * The claim, with nothing recorded. This is precisely the state a process killed between the `O_EXCL`
     * create and the append leaves: the decision is made and durable, and the log does not know it yet.
     */
    const claim = attemptQuestionResolution(
      paths,
      asked.question.id,
      questionResolution({
        resolver: 'web',
        principal: { kind: 'user', id: 'deep' },
        answer: 'reject',
        optionId: 'reject',
      }),
    );
    expect(claim.created).toBe(true);
    expect(typesOf(run)).not.toContain(QUESTION_EVENT_TYPES.Resolved);

    await reconciler.pass();
    expect(typesOf(run).filter((type) => type === QUESTION_EVENT_TYPES.Resolved)).toHaveLength(1);
    expect(decisionsInLog(readEventLog(paths.eventLog))).toHaveLength(1);

    // Neither lost nor doubled: every later pass finds the lines already there and appends nothing.
    await reconciler.pass();
    await reconciler.pass();
    expect(typesOf(run).filter((type) => type === QUESTION_EVENT_TYPES.Resolved)).toHaveLength(1);
    expect(decisionsInLog(readEventLog(paths.eventLog))).toHaveLength(1);
    expect(decidedQuestionIds(readEventLog(paths.eventLog)).size).toBe(1);
  });

  it('appends the question.asked line a crash lost, without asking a second question', async () => {
    const reconciler = openReconciler();
    const run = aRun(reconciler);
    const paths = runPaths(run, home);

    // `askQuestion` is the durable half on its own: the file lands, and nothing is recorded. That is the
    // state a kill between the write and the append leaves.
    const asked = askQuestion({
      paths,
      questionId: mintQuestionId(mintRunId()),
      feature: 'engine-reconciler',
      draft: aDraft(),
    });
    expect(typesOf(run)).not.toContain(QUESTION_EVENT_TYPES.Asked);

    await reconciler.pass();
    expect(typesOf(run).filter((type) => type === QUESTION_EVENT_TYPES.Asked)).toHaveLength(1);
    await reconciler.pass();
    expect(typesOf(run).filter((type) => type === QUESTION_EVENT_TYPES.Asked)).toHaveLength(1);
    expect(questionDirs(run)).toStrictEqual([asked.state.question.id]);
  });
});
