/**
 * The attempt bound: one step may be handed to the executor a declared number of times, whatever sent
 * it back.
 *
 * Two loops existed before this bound, and they are the reason it is one bound rather than two. Story
 * 1-3 left `retry-with-backoff` unbounded: a step whose failure is declared retryable is re-run for
 * ever. Story 1-7 bounded that half by counting the `failed` disposition, which left the other half
 * open — an `interrupted` step resumed by session id records no failure at all, so it never reached the
 * limit and looped instead. Both spend a subscription-funded model call per lap, and neither stops until
 * a person notices.
 *
 * So the rule asserted here is deliberately not "three failures": it is that the *loop coming back to
 * the same step* is what counts, whether it came back by a re-run, by a promotion or by a resume. Each
 * of the four cases below is driven through real passes rather than through `decideAction`, because a
 * bound that holds in the decision function and is walked past by the loop is not a bound — and the
 * count it reads is folded from the event log, so the restart case is the one that proves a crash is not
 * a way to start again from zero (AD-4).
 */
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { RUN_STATE_FILE_NAME, makeError } from '../src/contracts/index.js';
import { readEventLog, runPaths } from '../src/runtime/index.js';
import {
  DECLARED_STEP_ATTEMPT_LIMIT,
  ENGINE_EVENT_TYPES,
  Reconciler,
  attemptBoundReached,
  createRecordingResetter,
  createScriptedExecutor,
  returnsToSameStep,
  terminated,
} from '../src/engine/index.js';
import type { FeaturePlan, ScriptedExecutorOptions } from '../src/engine/index.js';

import { makeHome, makePlan, planProvider } from './helpers/engine-fixture.js';

const BASELINE = 'ddd9bed4d286ac1f8a0f4f7bfef9530046605787';

let home: string;
const toRemove: string[] = [];
const toClose: Reconciler[] = [];

beforeEach(() => {
  home = makeHome('engine-retry-bound');
  toRemove.push(home);
});

afterEach(() => {
  for (const reconciler of toClose.splice(0)) reconciler.close();
  for (const dir of toRemove.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const openReconciler = (script: ScriptedExecutorOptions, plan: FeaturePlan = makePlan()): Reconciler => {
  const reconciler = Reconciler.open({
    orchHome: home,
    executor: createScriptedExecutor(script),
    plans: planProvider(plan),
    baseline: createRecordingResetter(BASELINE),
  });
  toClose.push(reconciler);
  return reconciler;
};

/** A run confirmed out of `drafting`, so the next pass claims the first step. */
const startRun = (reconciler: Reconciler, plan: FeaturePlan = makePlan()): string => {
  const accepted = reconciler.acceptFeature(plan);
  reconciler.confirm(accepted.run);
  return accepted.run;
};

/**
 * How many times the log says the step was handed to the executor.
 *
 * Counted from the lines themselves rather than read from the checkpoint, so the assertions below
 * compare the count the engine acts on against the durable truth it is supposed to be derived from. A
 * fold that invented, reset or double-counted an engagement disagrees with this number.
 */
const engagementsInLog = (run: string, step: string): number =>
  readEventLog(runPaths(run, home).eventLog).filter(
    (event) =>
      event.step === step &&
      (event.type === ENGINE_EVENT_TYPES.StepStarted ||
        event.type === ENGINE_EVENT_TYPES.StepResumeAttempted),
  ).length;

const stepRecord = (reconciler: Reconciler, run: string, step = 'implement'): {
  readonly attempts: number;
  readonly disposition: string | null;
} => {
  const record = reconciler.load(run).state.steps.find((entry) => entry.step === step);
  expect(record, `the log records no step "${step}"`).toBeDefined();
  return { attempts: record?.attempts ?? -1, disposition: record?.disposition ?? null };
};

/** Every failure is the declared-retryable kind, so the AD-35 table says re-run, every time. */
const alwaysRetryable: ScriptedExecutorOptions = {
  sessionIdFor: () => null,
  onStart: (request) =>
    terminated(request.step, 'failed', {
      error: makeError('step.timed_out', 'the test command never returned'),
    }),
};

/**
 * Every attempt is interrupted and carries a session id, and every resume is interrupted again.
 *
 * This is the shape story 1-7 recorded and could not bound: no failure is ever reported, so a bound that
 * counted failures saw nothing to count, and AD-8's resume path ran for ever.
 */
const alwaysInterrupted: ScriptedExecutorOptions = {
  sessionIdFor: (request) => `sess-${request.step}`,
  onStart: (request) => terminated(request.step, 'interrupted', { sessionId: `sess-${request.step}` }),
  onResume: (request) => terminated(request.step, 'interrupted', { sessionId: request.sessionId }),
};

describe('the bound covers every disposition that returns to the same step', () => {
  it('names the three actions that come back to the step, and only those', () => {
    expect(returnsToSameStep('resume')).toBe(true);
    expect(returnsToSameStep('reset-and-rerun')).toBe(true);
    expect(returnsToSameStep('promote-model-tier')).toBe(true);
    // The four that do not: two terminal, one that waits for a person, one that moves on.
    expect(returnsToSameStep('advance')).toBe(false);
    expect(returnsToSameStep('escalate-to-human')).toBe(false);
    expect(returnsToSameStep('hand-off')).toBe(false);
    expect(returnsToSameStep('stop')).toBe(false);
  });

  it('reaches the bound at the declared count and not before it', () => {
    expect(attemptBoundReached(DECLARED_STEP_ATTEMPT_LIMIT - 1)).toBe(false);
    expect(attemptBoundReached(DECLARED_STEP_ATTEMPT_LIMIT)).toBe(true);
  });

  /**
   * The bound is a declared number, so it is pinned here rather than only compared against itself.
   *
   * Every other assertion in this file reads the constant, which is right — they are about the *rule* —
   * but it means the number itself could be changed without a single test noticing, and the number is a
   * promise about how much of a person's subscription one stuck step may spend. The arithmetic behind it:
   * three attempts is what AD-35's retry path is allowed, and each interruption legitimately costs two
   * more engagements (a resume, and the re-run behind a refused one), so two crashes during a failing
   * step is seven. Eight is that with one to spare.
   */
  it('declares a bound of eight, which is the arithmetic and not a round number', () => {
    expect(DECLARED_STEP_ATTEMPT_LIMIT).toBe(8);
    expect(DECLARED_STEP_ATTEMPT_LIMIT).toBeGreaterThan(3 + 2 * 2);
  });
});

describe('a step that keeps failing retryably', () => {
  it('stops at the bound rather than re-running for ever', async () => {
    const reconciler = openReconciler(alwaysRetryable);
    const run = startRun(reconciler);

    await reconciler.runUntilSettled();

    const state = reconciler.load(run).state;
    expect(state.state).toBe('handed_off');
    expect(stepRecord(reconciler, run).attempts).toBe(DECLARED_STEP_ATTEMPT_LIMIT);
    expect(engagementsInLog(run, 'implement')).toBe(DECLARED_STEP_ATTEMPT_LIMIT);

    // Terminal means terminal: no later pass finds anything to do, so this is a stop and not a pause.
    expect((await reconciler.pass()).actions).toStrictEqual([]);
  });

  it('explains itself rather than thrashing, naming the count and the bound', async () => {
    const reconciler = openReconciler(alwaysRetryable);
    const run = startRun(reconciler);

    await reconciler.runUntilSettled();

    const document = readFileSync(runPaths(run, home).handoffDocument, 'utf8');
    expect(existsSync(runPaths(run, home).handoffDocument)).toBe(true);
    expect(document).toContain(`failed on all ${String(DECLARED_STEP_ATTEMPT_LIMIT)} attempts`);
    expect(reconciler.load(run).state.handoff?.reason).toContain(
      String(DECLARED_STEP_ATTEMPT_LIMIT),
    );
  });
});

describe('a step that keeps being interrupted and resumed', () => {
  it('stops at the same bound, so the resume path is not a way around it', async () => {
    const reconciler = openReconciler(alwaysInterrupted);
    const run = startRun(reconciler);

    // Without the bound covering `interrupted`, this never settles: the step reports no failure, so
    // nothing ever counted, and `runUntilSettled` would exhaust its pass budget instead of returning.
    await reconciler.runUntilSettled();

    const state = reconciler.load(run).state;
    expect(state.state).toBe('handed_off');
    expect(stepRecord(reconciler, run).attempts).toBe(DECLARED_STEP_ATTEMPT_LIMIT);
    expect((await reconciler.pass()).actions).toStrictEqual([]);
  });

  it('counts the resumes, which is what the step itself never reports as a failure', async () => {
    const reconciler = openReconciler(alwaysInterrupted);
    const run = startRun(reconciler);

    await reconciler.runUntilSettled();

    const log = readEventLog(runPaths(run, home).eventLog);
    const starts = log.filter((event) => event.type === ENGINE_EVENT_TYPES.StepStarted);
    const resumes = log.filter((event) => event.type === ENGINE_EVENT_TYPES.StepResumeAttempted);
    // One start and the rest resumes: every lap after the first went through AD-8's resume, and the
    // count the bound read is the sum of the two.
    expect(starts).toHaveLength(1);
    expect(resumes).toHaveLength(DECLARED_STEP_ATTEMPT_LIMIT - 1);
    // Not one `failed` disposition anywhere, which is exactly why counting failures could not bound it.
    expect(
      log.filter((event) => event.payload['disposition'] === 'failed'),
    ).toStrictEqual([]);
  });
});

describe('a step that succeeds on its last permitted attempt', () => {
  it('succeeds, so the bound is not off by one', async () => {
    const reconciler = openReconciler({
      sessionIdFor: () => null,
      onStart: (request) => {
        if (request.step !== 'implement') return terminated(request.step, 'completed');
        // `request.attempt` is folded from the log, so this script is a function of durable state and
        // says the same thing to a restart as to the first pass.
        return request.attempt < DECLARED_STEP_ATTEMPT_LIMIT
          ? terminated(request.step, 'failed', { error: makeError('step.timed_out', 'slow') })
          : terminated(request.step, 'completed');
      },
    });
    const run = startRun(reconciler);

    await reconciler.runUntilSettled();

    const state = reconciler.load(run).state;
    // The last permitted attempt is spent and it succeeded: the feature advanced through the whole plan
    // rather than being handed off on the attempt it was entitled to.
    expect(state.state).toBe('committed');
    expect(state.handoff).toBeNull();
    expect(stepRecord(reconciler, run).disposition).toBe('completed');
    expect(stepRecord(reconciler, run).attempts).toBe(DECLARED_STEP_ATTEMPT_LIMIT);
  });
});

describe('the count is reconstructed from the log', () => {
  it('survives a restart, because the checkpoint is not what the bound reads', async () => {
    const first = openReconciler(alwaysRetryable);
    const run = startRun(first);

    // Three passes: the step is started, fails, is reset and re-run. Enough that a count starting again
    // from zero would be visibly different from the log's.
    await first.pass();
    await first.pass();
    await first.pass();
    const attemptsBefore = stepRecord(first, run).attempts;
    expect(attemptsBefore).toBeGreaterThan(1);
    expect(attemptsBefore).toBe(engagementsInLog(run, 'implement'));
    first.close();

    /**
     * The checkpoint is rewritten to claim the step has never been attempted.
     *
     * This is the sharpest form of "a restart is not a way to reset it": not a crash, but a `state.json`
     * that actively disagrees with the log. AD-4 says the log wins and the checkpoint is discarded, so
     * the bound has to read the rebuilt count and the disagreement has to be reported rather than
     * absorbed.
     */
    const checkpointPath = join(runPaths(run, home).runDir, RUN_STATE_FILE_NAME);
    const tampered = JSON.parse(readFileSync(checkpointPath, 'utf8')) as {
      steps: { step: string; attempts: number }[];
    };
    for (const record of tampered.steps) record.attempts = 0;
    writeFileSync(checkpointPath, `${JSON.stringify(tampered, null, 2)}\n`, 'utf8');

    const second = openReconciler(alwaysRetryable);
    const loaded = second.load(run);
    expect(loaded.state.steps[0]?.attempts).toBe(attemptsBefore);
    expect(loaded.disagreements.map((entry) => entry.field)).toContain('steps.implement.attempts');

    // And the bound still ends the run at the declared count *in total*, not at the declared count
    // again: a restart buys no further attempts.
    await second.runUntilSettled();
    expect(second.load(run).state.state).toBe('handed_off');
    expect(stepRecord(second, run).attempts).toBe(DECLARED_STEP_ATTEMPT_LIMIT);
    expect(engagementsInLog(run, 'implement')).toBe(DECLARED_STEP_ATTEMPT_LIMIT);
  });

  it('carries the resumes across a restart too, so an interrupted step cannot loop for ever', async () => {
    const first = openReconciler(alwaysInterrupted);
    const run = startRun(first);

    await first.pass();
    await first.pass();
    await first.pass();
    const attemptsBefore = stepRecord(first, run).attempts;
    // At least one resume is already counted: the thing the previous bound could not see.
    expect(attemptsBefore).toBeGreaterThan(1);
    first.close();

    const second = openReconciler(alwaysInterrupted);
    expect(second.load(run).state.steps[0]?.attempts).toBe(attemptsBefore);

    await second.runUntilSettled();
    expect(second.load(run).state.state).toBe('handed_off');
    expect(stepRecord(second, run).attempts).toBe(DECLARED_STEP_ATTEMPT_LIMIT);
  });
});
