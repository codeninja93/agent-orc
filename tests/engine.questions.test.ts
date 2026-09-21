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

import { COMMAND_SOURCES, isDeclaredEventType, makeError, writesToDecisionLedger } from '../src/contracts/index.js';
import type { CommandSource, QuestionDraft, QuestionState } from '../src/contracts/index.js';
import {
  DEFAULT_HIGH_ENTROPY_MIN_LENGTH,
  QUESTION_OUTCOME_FILE_NAME,
  QUESTION_STATE_FILE_NAME,
  REDACTION_MARKER,
  questionPaths,
  readEventLog,
  runPaths,
} from '../src/runtime/index.js';
import {
  DECISION_EVENT_TYPE,
  MAX_QUESTION_ID_TOKEN_RUN,
  MAX_QUESTION_WINDOW_MS,
  QUESTION_DRAFT_FIELDS,
  QUESTION_EVENT_TYPES,
  QUESTION_RESOLVER_NAMES,
  QUESTION_SEED_PATTERN,
  QuestionDraftRefused,
  QuestionFileUnreadable,
  QuestionOutcomeSchema,
  REDACTED_FIELDS_PAYLOAD_KEY,
  Reconciler,
  SteeringRefused,
  TornQuestionState,
  UnknownQuestion,
  UnloggableQuestionId,
  UnusableQuestionSeed,
  askQuestion,
  attemptQuestionResolution,
  createRecordingResetter,
  createScriptedExecutor,
  decidedQuestionIds,
  decisionFor,
  decisionsInLog,
  isLoggableQuestionId,
  listQuestionIds,
  mintIntentId,
  mintQuestionId,
  mintRunId,
  parseOptionSelection,
  questionDefaultDueAt,
  questionResolution,
  readQuestionDirectory,
  readQuestionOutcome,
  readQuestionState,
  resolverForSource,
  settleQuestion,
  settledQuestionIds,
  survivesRedaction,
  sweepQuestionTemporaries,
  terminated,
} from '../src/engine/index.js';
import type { ScriptedExecutorOptions } from '../src/engine/index.js';

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
      readFileSync(
        join(runPaths(run, home).questionsDir, asked.question.id, QUESTION_STATE_FILE_NAME),
        'utf8',
      ),
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
    writeFileSync(
      join(tornDir, QUESTION_STATE_FILE_NAME),
      '{"schema_version": 1, "question": {"id": "q-',
      'utf8',
    );

    const result = await reconciler.pass();
    const questions = result.questions.find((entry) => entry.run === run);
    expect(questions?.refused.map((entry) => entry.questionId)).toStrictEqual([tornId]);
    expect(questions?.refused[0]?.code).toBe('internal.invariant_violated');
    // No transition against the torn question, and no outcome file invented for it.
    expect(existsSync(join(tornDir, QUESTION_OUTCOME_FILE_NAME))).toBe(false);
    // The healthy question is untouched and still open.
    expect(questions?.open).toContain(healthy.question.id);
  });

  it('refuses a read of a torn state file directly, rather than returning a partial question', () => {
    const reconciler = openReconciler();
    const run = aRun(reconciler);
    const questionId = mintQuestionId(mintRunId());
    const dir = join(runPaths(run, home).questionsDir, questionId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, QUESTION_STATE_FILE_NAME), '{"schema_version": 1, "stat', 'utf8');
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

// -------------------------------------------------------------------------------------------------
// Which question an answer resolves, and what each durable line carries
// -------------------------------------------------------------------------------------------------

/**
 * Two seeds whose minted ids sort in a known order, so a test can say *which* question it means.
 *
 * Explicit rather than minted from the clock: the property under test is that targeting is decided by the
 * declared rule — the earliest question id — and a fixture whose ids happened to be in creation order
 * could not tell that apart from "whatever `readdir` returned first".
 */
const SEEDS = [
  '01K5NQ9ZJ7V3M2P9XQWRTC4BDA',
  '01K5NQ9ZJ7V3M2P9XQWRTC4BDB',
  '01K5NQ9ZJ7V3M2P9XQWRTC4BDC',
  '01K5NQ9ZJ7V3M2P9XQWRTC4BDD',
] as const;

const questionIdOf = (index: number): string => mintQuestionId(SEEDS[index] ?? SEEDS[0]);

describe('two questions open at once: an answer resolves one of them, by rule', () => {
  it('resolves the earliest still-asked question and leaves the other asked', () => {
    /**
     * No test anywhere had two questions open on one run, and two mutations survived because of it:
     * dropping `.sort()` from `listQuestionIds`, and flipping `activeQuestion` from earliest to latest.
     * Either one attaches a person's answer, principal and decision record to a question they were never
     * shown, while the one they answered stays open until its window defaults.
     */
    const reconciler = openReconciler();
    const run = aRun(reconciler);
    const first = questionIdOf(0);
    const second = questionIdOf(1);
    // Asked in *reverse* id order, so creation order and id order disagree and the assertion is about
    // the rule rather than about the directory.
    reconciler.ask(run, aDraft({ prompt: 'the later id, asked first' }), { questionId: second });
    reconciler.ask(run, aDraft({ prompt: 'the earlier id, asked second' }), { questionId: first });
    expect(questionDirs(run)).toStrictEqual([first, second]);

    reconciler.answer(run, 'ignore', { principal: { kind: 'user', id: 'deep' } });

    const earliest = settleQuestion(runPaths(run, home), first);
    const latest = settleQuestion(runPaths(run, home), second);
    expect(earliest.state.status).toBe('resolved');
    expect(earliest.state.resolution?.answer).toBe('ignore');
    // The other question is untouched: no outcome, no resolution, still waiting for somebody.
    expect(latest.state.status).toBe('asked');
    expect(latest.outcome).toBeNull();

    // And the durable record names the question that was resolved, not merely "a question".
    const decisions = decisionsInLog(readEventLog(runPaths(run, home).eventLog));
    expect(decisions).toHaveLength(1);
    expect(decisions[0]?.['question_id']).toBe(first);
    const resolved = eventsOf(run).filter((event) => event.type === QUESTION_EVENT_TYPES.Resolved);
    expect(resolved.map((event) => event.payload['question_id'])).toStrictEqual([first]);
  });

  it('lists question ids in minted order however the directory was created', () => {
    // The ordering `activeQuestion` rests on. Created in descending id order, so an unsorted listing
    // would have to be wrong about at least one of them.
    const reconciler = openReconciler();
    const run = aRun(reconciler);
    const ids = [0, 1, 2, 3].map(questionIdOf);
    for (const questionId of [...ids].reverse()) reconciler.ask(run, aDraft(), { questionId });
    expect(listQuestionIds(runPaths(run, home))).toStrictEqual(ids);
  });

  it('answers the second question once the first is resolved, never re-resolving the first', () => {
    const reconciler = openReconciler();
    const run = aRun(reconciler);
    const first = questionIdOf(0);
    const second = questionIdOf(1);
    reconciler.ask(run, aDraft(), { questionId: first });
    reconciler.ask(run, aDraft(), { questionId: second });

    reconciler.answer(run, 'reject', { principal: { kind: 'user', id: 'first-answer' } });
    reconciler.answer(run, 'ignore', { principal: { kind: 'user', id: 'second-answer' } });

    expect(settleQuestion(runPaths(run, home), first).state.resolution?.principal.id).toBe('first-answer');
    expect(settleQuestion(runPaths(run, home), second).state.resolution?.principal.id).toBe(
      'second-answer',
    );
    expect(decisionsInLog(readEventLog(runPaths(run, home).eventLog))).toHaveLength(2);
  });
});

describe('the four durable payloads carry what story 5-3 will index', () => {
  /**
   * Four mutations each left the suite green: deleting `option_id` from the decision payload, deleting
   * `question` and `resolved_at` from it, deleting `resolver`/`principal_kind`/`principal_id` from the
   * resolved payload, and deleting `source`/`anchor` from the deflected one. They survived because every
   * test asserting a resolver, a principal or an option read the *derived* `state.json` through
   * `settleQuestion` — and AD-4 makes the log the only authority, with story 5-3 indexing exactly these
   * lines. So these assertions are on the payloads as the log holds them.
   */
  const lineOf = (run: string, type: string): Record<string, unknown> => {
    const found = eventsOf(run).find((event) => event.type === type);
    expect(found, `no ${type} line in the log`).toBeDefined();
    return found?.payload ?? {};
  };

  it('names the resolver, the principal, the option and the instant on question.resolved', () => {
    const reconciler = openReconciler();
    const run = aRun(reconciler);
    const asked = reconciler.ask(run, aDraft());
    reconciler.answer(run, 'ignore', { principal: { kind: 'user', id: 'deep' }, source: 'tui' });

    const payload = lineOf(run, QUESTION_EVENT_TYPES.Resolved);
    expect(payload['question_id']).toBe(asked.question.id);
    // AD-25 — the winning transition records its resolver *and* its principal, in the log.
    expect(payload['resolver']).toBe('tui');
    expect(payload['principal_kind']).toBe('user');
    expect(payload['principal_id']).toBe('deep');
    expect(payload['option_id']).toBe('ignore');
    expect(payload['answer']).toBe('ignore');
    expect(payload['resolved_at']).toBe(
      settleQuestion(runPaths(run, home), asked.question.id).state.resolution?.resolved_at,
    );
  });

  it('names the option and the instant on the decision record, and the question as it was put', () => {
    const reconciler = openReconciler();
    const run = aRun(reconciler);
    const asked = reconciler.ask(run, aDraft());
    reconciler.answer(run, 'reject', { principal: { kind: 'user', id: 'deep' } });

    const decision = lineOf(run, DECISION_EVENT_TYPE);
    expect(decision['question_id']).toBe(asked.question.id);
    // Q7 — a later run reads the option back to avoid asking the same question twice, so it is the field
    // whose absence would be invisible and expensive.
    expect(decision['option_id']).toBe('reject');
    expect(decision['answer']).toBe('reject');
    expect(decision['resolver']).toBe('tui');
    expect(decision['principal_kind']).toBe('user');
    expect(decision['principal_id']).toBe('deep');
    expect(String(decision['question'])).toContain('unknown field');
    expect(decision['resolved_at']).toBe(
      settleQuestion(runPaths(run, home), asked.question.id).state.resolution?.resolved_at,
    );
    // The type is declared, so the ledger AD-25 requires is not written under a name no contract knows.
    expect(isDeclaredEventType(DECISION_EVENT_TYPE)).toBe(true);
  });

  it('names the source and the anchor on question.deflected, and no resolver at all', () => {
    const reconciler = openReconciler();
    const run = aRun(reconciler);
    const asked = reconciler.ask(run, aDraft());
    reconciler.deflect(run, asked.question.id, {
      source: 'git_history',
      answer: 'the convention has been "reject" since the contracts landed',
      anchor: 'src/contracts/step.ts',
    });

    const payload = lineOf(run, QUESTION_EVENT_TYPES.Deflected);
    expect(payload['question_id']).toBe(asked.question.id);
    // Where the answer came from, and the durable anchor a reader follows back to the evidence (Q4).
    expect(payload['source']).toBe('git_history');
    expect(payload['anchor']).toBe('src/contracts/step.ts');
    expect(String(payload['answer'])).toContain('since the contracts landed');
    expect(payload['deflected_at']).toBe(
      settleQuestion(runPaths(run, home), asked.question.id).state.deflection?.deflected_at,
    );
    // Nobody was asked, so nothing is attributed and nothing is recorded as a decision (AD-25).
    expect(payload['resolver']).toBeUndefined();
    expect(payload['principal_id']).toBeUndefined();
  });

  it('names the resolver and the timeout principal on question.default_taken', async () => {
    /**
     * Driven through a real pass rather than through the payload builder, because the assertion is about
     * the line the log holds: the claim lands first and the pass reports it, which is also the crash
     * ordering. The window suite covers expiry; what is covered here is the payload's own shape.
     */
    const reconciler = openReconciler();
    const run = aRun(reconciler);
    const asked = reconciler.ask(run, aDraft());
    const claim = attemptQuestionResolution(
      runPaths(run, home),
      asked.question.id,
      questionResolution({
        resolver: 'timeout_default',
        principal: { kind: 'timeout', id: 'question.window' },
        answer: 'the window passed and the recommended default was taken',
        optionId: 'reject',
      }),
    );
    expect(claim.created).toBe(true);
    await reconciler.pass();

    const payload = lineOf(run, QUESTION_EVENT_TYPES.DefaultTaken);
    expect(payload['question_id']).toBe(asked.question.id);
    // `timeout` is a declared principal kind precisely so a default has an honest one: nobody decided
    // this, the window did, and the log says so rather than naming the user who did not answer (AD-19).
    expect(payload['resolver']).toBe('timeout_default');
    expect(payload['principal_kind']).toBe('timeout');
    expect(payload['principal_id']).toBe('question.window');
    expect(payload['option_id']).toBe('reject');
    expect(payload['resolved_at']).toBe(claim.outcome?.resolution?.resolved_at);
    // And the decision carries the same option, which is what Q7's "asked once becomes a rule" reads back.
    expect(lineOf(run, DECISION_EVENT_TYPE)['option_id']).toBe('reject');
  });
});

describe('a command source maps to a resolver exhaustively, so a new source is a compile error', () => {
  it('counts a cli answer as the tui resolver rather than falling through to it', () => {
    /**
     * `resolverForSource` was `source === 'web' ? 'web' : source === 'timeout' ? 'timeout_default' :
     * 'tui'`, while `COMMAND_SOURCES` is four long. So a CLI-issued answer recorded a durable decision
     * naming a resolver that did not make it, and a fifth source would have joined the same bucket in
     * silence — the non-exhaustive default `steering.ts` forbids in its own comment.
     */
    expect(resolverForSource('cli')).toBe('tui');
    expect(resolverForSource('tui')).toBe('tui');
    expect(resolverForSource('web')).toBe('web');
    expect(resolverForSource('timeout')).toBe('timeout_default');
  });

  it('maps every declared source to a declared resolver, with nothing undefined', () => {
    /**
     * The *exhaustiveness* is enforced by the type system rather than here — the map is a total
     * `Record<CommandSource, QuestionResolver>`, so adding a fifth source to `COMMAND_SOURCES` is a
     * compile error at the map rather than a silent extra member of the `tui` bucket. What this asserts is
     * the other half: every declared source reaches a resolver AD-25 declares, with no hole a `??` or a
     * trailing ternary could fill in for it.
     */
    const sources: readonly CommandSource[] = COMMAND_SOURCES;
    for (const source of sources) {
      expect(QUESTION_RESOLVER_NAMES, source).toContain(resolverForSource(source));
    }
  });
});

describe('a minted question id is checked at both ends, as story 1-7’s intent id is', () => {
  it('refuses a degenerate seed rather than returning the bare prefix', () => {
    // `mintQuestionId('')` returned the literal "q-", which is a loggable id — so two questions minted
    // that way shared one directory and one idempotence key, and the second was read as the first.
    expect(() => mintQuestionId('')).toThrowError(UnusableQuestionSeed);
    expect(() => mintQuestionId('short')).toThrowError(UnusableQuestionSeed);
    expect(() => mintQuestionId('lower-case-not-a-ulid-at-all')).toThrowError(UnusableQuestionSeed);
    expect(QUESTION_SEED_PATTERN.test(mintRunId())).toBe(true);
  });

  it('asserts its own output against the policy that will redact it', () => {
    const ulid = mintRunId();
    const minted = mintQuestionId(ulid);
    expect(isLoggableQuestionId(minted)).toBe(true);
    /**
     * The *active* policy decides, not a constant copied at some past moment. A build that lowered
     * `highEntropyMinLength` would otherwise keep minting ids this module called loggable while the
     * recorder replaced them with the marker, and the ledger every question append is keyed on would hold
     * `[redacted]` instead of a key.
     */
    expect(isLoggableQuestionId(minted, { highEntropyMinLength: 4 })).toBe(false);
    expect(() => mintQuestionId(ulid, { highEntropyMinLength: 4 })).toThrowError(UnloggableQuestionId);
    // One number, derived rather than copied: 23 written out here would drift from the pass's threshold.
    expect(MAX_QUESTION_ID_TOKEN_RUN).toBe(DEFAULT_HIGH_ENTROPY_MIN_LENGTH - 1);
  });
});

describe('an intent id in an outcome is validated by the command contract, not by the question’s rules', () => {
  it('claims an outcome under a real minted intent id and recognises its redelivery', () => {
    /**
     * `QuestionOutcomeSchema.intent_id` borrowed `QuestionSchema.shape.id`, coupling the validity of an
     * intent id to whatever rule a question id carries — and every existing test put a hand-made `'cmd-1'`
     * through it, so no test ever passed a real one. A real minted id is 30-odd characters of punctuated
     * ULID, which is what the transport actually writes.
     */
    const reconciler = openReconciler();
    const run = aRun(reconciler);
    const asked = reconciler.ask(run, aDraft());
    const intentId = mintIntentId(mintRunId());
    const resolution = questionResolution({
      resolver: 'tui',
      principal: { kind: 'user', id: 'deep' },
      answer: 'reject',
      optionId: 'reject',
    });

    const first = attemptQuestionResolution(runPaths(run, home), asked.question.id, resolution, {
      intentId,
    });
    expect(first.accepted).toBe(true);
    expect(first.outcome?.intent_id).toBe(intentId);

    // The same gesture arriving twice is the winner, which is the whole point of recording the id.
    const redelivered = attemptQuestionResolution(runPaths(run, home), asked.question.id, resolution, {
      intentId,
    });
    expect(redelivered.accepted).toBe(true);
    expect(redelivered.created).toBe(false);

    // And the outcome file on disk round-trips through the contract that now declares its shape.
    const onDisk = readQuestionOutcome(questionPaths(runPaths(run, home), asked.question.id));
    expect(onDisk?.intent_id).toBe(intentId);
    expect(onDisk?.resolution?.resolver).toBe('tui');
  });

  it('accepts a minted intent id in the declared outcome shape', () => {
    const parsed = QuestionOutcomeSchema.safeParse({
      schema_version: 1,
      question_id: mintQuestionId(mintRunId()),
      resolution: null,
      deflection: {
        source: 'repository',
        answer: 'the convention is already in the tree',
        anchor: 'src/contracts/question.ts',
        deflected_at: '2026-09-20T10:00:00.000Z',
      },
      intent_id: mintIntentId(mintRunId()),
      claimed_at: '2026-09-20T10:00:00.000Z',
    });
    expect(parsed.success).toBe(true);
  });
});

describe('a free-text answer AD-21 rewrites is a divergence the record names', () => {
  it('keeps the answer verbatim in the question file, redacts it in the log, and says so', () => {
    /**
     * Q6 imposes no format on a human, so an answer may contain anything — and an answer carrying a SHA, a
     * token or a bare identifier is an unbroken high-entropy run, which AD-21 replaces on the way into the
     * log. That is the pass working as specified and there is no remedy for it that is not a wider
     * allow-list, which AD-21 forbids. What was wrong was the silence: `state.json` kept the answer
     * verbatim while the log kept the marker, with nothing recording that the two disagreed.
     *
     * Driven with a real ULID at ~4 bits per character, because `'a'.repeat(n)` carries no entropy and
     * would pass this test while the real thing was being rewritten — the false pass this project has
     * recorded three times.
     */
    const identifier = mintRunId();
    expect(survivesRedaction(identifier)).toBe(false);

    const reconciler = openReconciler();
    const run = aRun(reconciler);
    const asked = reconciler.ask(run, aDraft());
    const answer = `reject, and keep the behaviour introduced in ${identifier}`;
    reconciler.answer(run, answer, { principal: { kind: 'user', id: 'deep' } });

    // The question file holds what the person wrote, in full. The decision is not lost.
    const settled = settleQuestion(runPaths(run, home), asked.question.id);
    expect(settled.state.resolution?.answer).toBe(answer);
    expect(settled.state.resolution?.answer).toContain(identifier);

    for (const type of [QUESTION_EVENT_TYPES.Resolved, DECISION_EVENT_TYPE]) {
      const payload = eventsOf(run).find((event) => event.type === type)?.payload ?? {};
      // The log holds the marker, not the identifier: AD-21 is a write-path invariant.
      expect(String(payload['answer']), type).toContain(REDACTION_MARKER);
      expect(String(payload['answer']), type).not.toContain(identifier);
      // And the line says which of its own fields was rewritten, so a reader knows the marker is a
      // rewritten value rather than the words a person typed, and knows the answer survives in questions/.
      expect(payload[REDACTED_FIELDS_PAYLOAD_KEY], type).toBe('answer');
      // The question id is untouched, which is what the punctuation is for.
      expect(payload['question_id'], type).toBe(asked.question.id);
    }
  });

  it('says nothing about redaction when nothing was redacted', () => {
    const reconciler = openReconciler();
    const run = aRun(reconciler);
    reconciler.ask(run, aDraft());
    reconciler.answer(run, 'ignore');
    for (const event of eventsOf(run)) {
      expect(event.payload[REDACTED_FIELDS_PAYLOAD_KEY], event.type).toBeUndefined();
    }
  });
});

describe('a question directory a pass cannot use is reported, never hidden', () => {
  it('refuses a directory name that is not a loggable question id', async () => {
    /**
     * `listQuestionIds` filtered such a name away, which made the question invisible to every pass: no
     * window taken, no event, no refusal, nobody told. An id from an older build — or one story 3-1's web
     * resolver minted differently — would have vanished without trace, while a torn state file beside it
     * was reported.
     */
    const reconciler = openReconciler();
    const run = aRun(reconciler);
    const healthy = reconciler.ask(run, aDraft());
    const bareUlid = mintRunId();
    mkdirSync(join(runPaths(run, home).questionsDir, bareUlid), { recursive: true });

    const listing = readQuestionDirectory(runPaths(run, home));
    expect(listing.ids).toStrictEqual([healthy.question.id]);
    expect(listing.unloggable).toStrictEqual([bareUlid]);

    const result = await reconciler.pass();
    const questions = result.questions.find((entry) => entry.run === run);
    expect(questions?.refused.map((entry) => entry.questionId)).toStrictEqual([bareUlid]);
    expect(questions?.refused[0]?.code).toBe('config.invalid');
    expect(questions?.refused[0]?.reason).toContain('cannot be logged');
    // The healthy question is untouched and still open.
    expect(questions?.open).toStrictEqual([healthy.question.id]);
  });
});

describe('a read that failed is not absence', () => {
  it('refuses an unreadable state file rather than reporting the question as unknown', () => {
    /**
     * `catch { throw new UnknownQuestion }` treated EACCES, EIO and EISDIR as "there is no such question".
     * A directory where the state file belongs is the deterministic form of the same fault — EISDIR for
     * every user, no privileges involved — and the distinction is what keeps a pass from taking a second
     * default over a decision it merely could not read.
     */
    const reconciler = openReconciler();
    const run = aRun(reconciler);
    const questionId = mintQuestionId(mintRunId());
    const dir = join(runPaths(run, home).questionsDir, questionId);
    mkdirSync(join(dir, QUESTION_STATE_FILE_NAME), { recursive: true });

    const paths = questionPaths(runPaths(run, home), questionId);
    let raised: unknown = null;
    try {
      readQuestionState(paths);
    } catch (thrown: unknown) {
      raised = thrown;
    }
    expect(raised).toBeInstanceOf(QuestionFileUnreadable);
    expect(raised).not.toBeInstanceOf(UnknownQuestion);
    expect((raised as QuestionFileUnreadable).file).toBe(QUESTION_STATE_FILE_NAME);
  });

  it('refuses an unreadable outcome file rather than reporting the question as unclaimed', async () => {
    const reconciler = openReconciler();
    const run = aRun(reconciler);
    const asked = reconciler.ask(run, aDraft());
    const paths = questionPaths(runPaths(run, home), asked.question.id);
    mkdirSync(paths.outcome, { recursive: true });

    // Never `null`: a claimed question reading as unclaimed is what lets a second default be taken over a
    // decision that is already durable.
    expect(() => readQuestionOutcome(paths)).toThrowError(QuestionFileUnreadable);

    const result = await reconciler.pass();
    const questions = result.questions.find((entry) => entry.run === run);
    expect(questions?.refused.map((entry) => entry.questionId)).toStrictEqual([asked.question.id]);
    // And no transition was attempted against it.
    expect(typesOf(run)).not.toContain(QUESTION_EVENT_TYPES.DefaultTaken);
    expect(typesOf(run)).not.toContain(QUESTION_EVENT_TYPES.Resolved);
  });

  it('still reports a genuinely absent question as unknown', () => {
    const reconciler = openReconciler();
    const run = aRun(reconciler);
    expect(() =>
      readQuestionState(questionPaths(runPaths(run, home), mintQuestionId(mintRunId()))),
    ).toThrowError(UnknownQuestion);
  });
});

describe('an outcome that disagrees with its question is refused, not half-reported', () => {
  it('refuses a question whose outcome names an option it never offered', async () => {
    /**
     * `deriveState` returned the *unchanged* state when the pure transition refused, so `settleQuestion`
     * handed back an `asked` state while still reporting the event type the outcome called for — and the
     * pass then tried to emit `question.resolved` for a question carrying no resolution, throwing from
     * inside the append. The disagreement is named at the one place that can see both halves of it.
     */
    const reconciler = openReconciler();
    const run = aRun(reconciler);
    const asked = reconciler.ask(run, aDraft());
    const paths = questionPaths(runPaths(run, home), asked.question.id);
    writeFileSync(
      paths.outcome,
      `${JSON.stringify({
        schema_version: 1,
        question_id: asked.question.id,
        resolution: {
          resolver: 'tui',
          principal: { kind: 'user', id: 'deep' },
          answer: 'an option from another build',
          option_id: 'never-offered',
          resolved_at: '2026-09-20T10:00:00.000Z',
        },
        deflection: null,
        intent_id: null,
        claimed_at: '2026-09-20T10:00:00.000Z',
      })}\n`,
      'utf8',
    );

    expect(() => settleQuestion(runPaths(run, home), asked.question.id)).toThrowError(TornQuestionState);
    const result = await reconciler.pass();
    const questions = result.questions.find((entry) => entry.run === run);
    expect(questions?.refused.map((entry) => entry.questionId)).toStrictEqual([asked.question.id]);
    expect(typesOf(run)).not.toContain(QUESTION_EVENT_TYPES.Resolved);
  });
});

describe('every required draft field is refused by name, from the table that names them', () => {
  /** One unaskable value per required field, so the table and the checks cannot drift apart. */
  const brokenDraft: Readonly<Record<string, Partial<QuestionDraft>>> = {
    prompt: { prompt: '   ' },
    brief: { brief: '' },
    options: { options: [] },
    escape: { escape: { id: 'esc', label: '  ', consequence: 'nothing happens' } },
    recommended_option_id: { recommended_option_id: '' },
    default_action: { default_action: '' },
    default_window_ms: { default_window_ms: 0 },
  };

  it('covers every field of QUESTION_DRAFT_FIELDS', () => {
    const reconciler = openReconciler();
    const run = aRun(reconciler);
    for (const field of QUESTION_DRAFT_FIELDS) {
      let raised: QuestionDraftRefused | null = null;
      try {
        reconciler.ask(run, aDraft(brokenDraft[field]));
      } catch (thrown: unknown) {
        raised = thrown as QuestionDraftRefused;
      }
      expect(raised, field).toBeInstanceOf(QuestionDraftRefused);
      expect(raised?.field, field).toBe(field);
    }
    expect(questionDirs(run)).toStrictEqual([]);
  });

  it('refuses a fractional window and one whose due instant no timestamp can express', () => {
    /**
     * `Number.isFinite(w) && w > 0` accepted `0.5`, which is not a count of milliseconds, and accepted a
     * window large enough that `asked_at + window` is not a representable instant — so CAP-4's own "when
     * does this default" threw a `RangeError` out of a renderer's countdown rather than answering.
     */
    const reconciler = openReconciler();
    const run = aRun(reconciler);
    for (const window of [0.5, -1, MAX_QUESTION_WINDOW_MS + 1, Number.MAX_SAFE_INTEGER]) {
      let raised: QuestionDraftRefused | null = null;
      try {
        reconciler.ask(run, aDraft({ default_window_ms: window }));
      } catch (thrown: unknown) {
        raised = thrown as QuestionDraftRefused;
      }
      expect(raised?.field, String(window)).toBe('default_window_ms');
    }
    expect(questionDirs(run)).toStrictEqual([]);
    // The bound is not decorative: this is the failure it prevents.
    expect(() =>
      questionDefaultDueAt({
        asked_at: '2026-09-20T10:00:00.000Z',
        default_window_ms: Number.MAX_SAFE_INTEGER,
      }),
    ).toThrowError(RangeError);
  });
});

describe('a resolver’s temporary file is swept rather than left to accumulate', () => {
  it('removes an abandoned temporary and leaves the two published files alone', () => {
    const reconciler = openReconciler();
    const run = aRun(reconciler);
    const asked = reconciler.ask(run, aDraft());
    reconciler.answer(run, 'reject');
    const dir = join(runPaths(run, home).questionsDir, asked.question.id);
    // Exactly what a resolver killed between its write and its link leaves behind.
    writeFileSync(join(dir, `${QUESTION_OUTCOME_FILE_NAME}.99999.1.tmp`), '{"partial":', 'utf8');

    // A live writer's temporary is left alone: the engine is not the only writer in questions/.
    expect(sweepQuestionTemporaries(runPaths(run, home))).toBe(0);
    expect(readdirSync(dir).sort()).toHaveLength(3);

    // Past the grace, it is debris and nothing reads it.
    expect(sweepQuestionTemporaries(runPaths(run, home), { graceMs: 0 })).toBe(1);
    expect(readdirSync(dir).sort()).toStrictEqual([
      QUESTION_OUTCOME_FILE_NAME,
      QUESTION_STATE_FILE_NAME,
    ]);
  });
});

describe('a rejection at an approval gate is refused without describing a question nobody saw', () => {
  it('names the gate, says the gate still stands, and records nothing', async () => {
    /**
     * `approve` is an `effect` command that acts on a blocked run; `reject` is a `question` command, so it
     * only works when a question happens to be open. Its own note cites CAP-18 — rejection at an approval
     * gate — which is exactly the case it cannot serve. What a rejection at a gate should *do* to the run
     * is not a transition this build declares, so the fix here is the refusal's honesty: a person looking
     * at a gate is told about the gate rather than about machinery under `questions/` they never saw.
     */
    const blocking: ScriptedExecutorOptions = {
      onStart: (request) =>
        request.step === 'implement'
          ? terminated(request.step, 'completed', { sessionId: 'sess-implement' })
          : terminated(request.step, 'blocked', {
              sessionId: 'sess-verify',
              error: makeError('permission.denied', 'an irreversible gate needs a person'),
            }),
    };
    const reconciler = Reconciler.open({
      orchHome: home,
      executor: createScriptedExecutor(blocking),
      plans: planProvider(makePlan()),
      baseline: createRecordingResetter(BASELINE),
    });
    toClose.push(reconciler);
    const run = reconciler.acceptFeature(makePlan()).run;
    reconciler.confirm(run);
    await reconciler.runUntilSettled();
    expect(reconciler.load(run).state.state).toBe('blocked');

    let raised: SteeringRefused | null = null;
    try {
      reconciler.reject(run, 'this migration is not reversible; do not run it');
    } catch (thrown: unknown) {
      raised = thrown as SteeringRefused;
    }

    expect(raised).toBeInstanceOf(SteeringRefused);
    expect(raised?.message).toContain('blocked at a gate');
    expect(raised?.message).toContain('the gate still stands');
    // Never a sentence about a question the person never saw.
    expect(raised?.message).not.toContain('under questions/');
    // And nothing durable happened: no decision, and the run is still blocked for a person.
    expect(decisionsInLog(readEventLog(runPaths(run, home).eventLog))).toStrictEqual([]);
    expect(reconciler.load(run).state.state).toBe('blocked');
  });
});
