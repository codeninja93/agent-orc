/**
 * CAP-5 — a disengage or a kill lands **while a step is running**, within a declared bound.
 *
 * This is the property story 1-3 deferred, and the reason it deferred it is the reason this suite is
 * shaped the way it is: a reconcile action drives a step synchronously to termination, so an intent that
 * arrives between passes proves nothing at all about "instant". Every test here therefore writes the
 * intent file *after the executor has reported a step in flight and before it has terminated*, and the
 * step only ever terminates because the steering command stopped it — if the mechanism were absent the
 * step would hang and the test would time out rather than quietly pass.
 *
 * The intent is written with `writeCommandIntent`, exactly as a renderer with no server would: no method
 * on the engine is called, which is also the evidence for "with the server down every control remains
 * available through the file path".
 */
import { readFileSync, rmSync } from 'node:fs';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { RUN_STATE_FILE_NAME } from '../src/contracts/index.js';
import type { RunState } from '../src/contracts/index.js';
import { readEventLog, runPaths } from '../src/runtime/index.js';
import {
  COMMAND_EVENT_TYPES,
  DECLARED_DISENGAGE_BOUND_MS,
  Reconciler,
  ResumeRefused,
  STEERING_POLL_INTERVAL_MS,
  createRecordingResetter,
  mintIntentId,
  mintRunId,
  newCommandIntent,
  readIntentFiles,
  stepStopperFrom,
  terminated,
  writeCommandIntent,
} from '../src/engine/index.js';
import type { Command } from '../src/contracts/index.js';
import type {
  StepExecutor,
  StepStartRequest,
  StepStopper,
  StepTermination,
} from '../src/engine/index.js';

import { makeHome, makePlan, planProvider } from './helpers/engine-fixture.js';
import { join } from 'node:path';

const BASELINE = 'ddd9bed4d286ac1f8a0f4f7bfef9530046605787';

let home: string;
const toRemove: string[] = [];
const toClose: Reconciler[] = [];

beforeEach(() => {
  home = makeHome('engine-disengage');
  toRemove.push(home);
});

afterEach(() => {
  for (const reconciler of toClose.splice(0)) reconciler.close();
  for (const dir of toRemove.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * An executor whose step stays in flight until something stops it.
 *
 * This is the shape a real `claude -p` has and the scripted double does not: `start` returns a promise
 * that has not settled, so there is a genuine window for an intent to arrive *during* a step. The stop
 * resolves it as `killed`, which is what story 1-4's spawner reports for an executor-initiated stop and
 * what AD-8 requires of a step stopped by a steering command.
 */
interface Stoppable {
  readonly executor: StepExecutor;
  readonly started: readonly StepStartRequest[];
  readonly stop: StepStopper;
  /** Let a step finish on its own, as it would if nothing stopped it. */
  readonly finish: (run: string, step: string) => boolean;
  readonly waitForStart: () => Promise<void>;
}

const createStoppableExecutor = (): Stoppable => {
  const started: StepStartRequest[] = [];
  const live = new Map<string, (termination: StepTermination) => void>();
  const key = (run: string, step: string): string => `${run}\u0000${step}`;

  const settle = (run: string, step: string, termination: StepTermination): boolean => {
    const resolve = live.get(key(run, step));
    if (resolve === undefined) return false;
    live.delete(key(run, step));
    resolve(termination);
    return true;
  };

  return {
    started,
    executor: {
      start: (request: StepStartRequest): Promise<StepTermination> =>
        new Promise<StepTermination>((resolve) => {
          started.push(request);
          request.onSessionId(`sess-${request.step}`);
          live.set(key(request.run, request.step), resolve);
        }),
      resume: (request) =>
        Promise.reject(new ResumeRefused(request.step, request.sessionId, 'this suite never resumes')),
    },
    stop: (target): boolean =>
      settle(
        target.run,
        target.step,
        terminated(target.step, 'killed', { sessionId: `sess-${target.step}` }),
      ),
    finish: (run, step): boolean =>
      settle(run, step, terminated(step, 'completed', { sessionId: `sess-${step}` })),
    waitForStart: async (): Promise<void> => {
      for (let waited = 0; waited < 2_000 && started.length === 0; waited += 2) await delay(2);
      if (started.length === 0) throw new Error('the executor never reported a step in flight');
    },
  };
};

const openReconciler = (options: {
  readonly stoppable: Stoppable;
  readonly wireTheStopper: boolean;
}): {
  readonly reconciler: Reconciler;
  readonly resetter: ReturnType<typeof createRecordingResetter>;
} => {
  const resetter = createRecordingResetter(BASELINE);
  const reconciler = Reconciler.open({
    orchHome: home,
    executor: options.stoppable.executor,
    plans: planProvider(makePlan()),
    baseline: resetter,
    ...(options.wireTheStopper ? { stopStep: options.stoppable.stop } : {}),
  });
  toClose.push(reconciler);
  return { reconciler, resetter };
};

/** Write an intent as a renderer would: a file, and nothing else. */
const writeIntent = (run: string, command: Command): string => {
  const intent = newCommandIntent({
    intentId: mintIntentId(mintRunId()),
    command,
    run,
    feature: 'engine-reconciler',
    principal: { kind: 'user', id: 'deep' },
    source: 'tui',
  });
  writeCommandIntent(runPaths(run, home), intent);
  return intent.intent_id;
};

const checkpointOnDisk = (run: string): RunState =>
  JSON.parse(readFileSync(join(runPaths(run, home).runDir, RUN_STATE_FILE_NAME), 'utf8')) as RunState;

describe('the declared bound', () => {
  it('is a real number, and larger than the interval it is built from', () => {
    // "Instant" is a measurable claim, so it has a number; the number has to cover the poll it rests on.
    expect(DECLARED_DISENGAGE_BOUND_MS).toBeGreaterThan(STEERING_POLL_INTERVAL_MS * 4);
  });
});

describe('a disengage written while a step is running', () => {
  it('stops the live child within the declared bound and halts the run', async () => {
    const stoppable = createStoppableExecutor();
    const { reconciler, resetter } = openReconciler({ stoppable, wireTheStopper: true });
    const accepted = reconciler.acceptFeature(makePlan());
    reconciler.confirm(accepted.run);

    // The pass is deliberately not awaited: the step is in flight for as long as this test wants.
    const passing = reconciler.pass();
    await stoppable.waitForStart();
    expect(reconciler.load(accepted.run).state.steps[0]?.disposition).toBeNull();

    const at = performance.now();
    const intentId = writeIntent(accepted.run, 'disengage');
    const result = await passing;
    const elapsed = performance.now() - at;

    // The property: the gesture reached the running child, not the gap after it.
    expect(elapsed).toBeLessThan(DECLARED_DISENGAGE_BOUND_MS);
    expect(stoppable.started).toHaveLength(1);
    expect(result.actions.map((action) => action.kind)).toStrictEqual(['run-step']);

    const state = reconciler.load(accepted.run).state;
    expect(state.steps[0]?.disposition).toBe('killed');
    expect(state.state).toBe('killed');

    // Recorded once, with its principal, and the file retired rather than deleted.
    const applied = readEventLog(runPaths(accepted.run, home).eventLog).filter(
      (event) => event.type === COMMAND_EVENT_TYPES.Applied,
    );
    expect(applied.filter((event) => event.payload['intent_id'] === intentId)).toHaveLength(1);
    expect(readIntentFiles(runPaths(accepted.run, home)).pending).toStrictEqual([]);

    // Nothing was rolled back on the way out.
    expect(resetter.resets).toStrictEqual([]);
  });

  it('leaves resumable state on disk', async () => {
    const stoppable = createStoppableExecutor();
    const { reconciler } = openReconciler({ stoppable, wireTheStopper: true });
    const accepted = reconciler.acceptFeature(makePlan());
    reconciler.confirm(accepted.run);

    const passing = reconciler.pass();
    await stoppable.waitForStart();
    writeIntent(accepted.run, 'disengage');
    await passing;

    // The checkpoint is on disk, whole, and agrees with the log.
    const onDisk = checkpointOnDisk(accepted.run);
    expect(onDisk.state).toBe('killed');
    expect(onDisk.run).toBe(accepted.run);

    const record = onDisk.steps[0];
    // Everything a person or a later story needs to pick the work up: which session ran, from which
    // commit, and what the step was.
    expect(record?.session_id).toBe('sess-implement');
    expect(record?.baseline_ref).toBe(BASELINE);
    expect(record?.started_at).not.toBeNull();
    expect(record?.terminated_at).not.toBeNull();
    expect(reconciler.load(accepted.run).disagreements).toStrictEqual([]);

    // And the typed input the step ran from is still there, unchanged.
    const inputPath = join(runPaths(accepted.run, home).runDir, 'steps', 'implement', 'input.json');
    expect(JSON.parse(readFileSync(inputPath, 'utf8'))).toMatchObject({ step: 'implement' });
  });
});

describe('a kill written while a step is running', () => {
  it('records killed on that step, and no later pass resumes or re-runs it', async () => {
    const stoppable = createStoppableExecutor();
    const { reconciler, resetter } = openReconciler({ stoppable, wireTheStopper: true });
    const accepted = reconciler.acceptFeature(makePlan());
    reconciler.confirm(accepted.run);

    const passing = reconciler.pass();
    await stoppable.waitForStart();
    const at = performance.now();
    writeIntent(accepted.run, 'kill');
    await passing;
    expect(performance.now() - at).toBeLessThan(DECLARED_DISENGAGE_BOUND_MS);

    expect(reconciler.load(accepted.run).state.steps[0]?.disposition).toBe('killed');

    for (let index = 0; index < 5; index += 1) {
      const result = await reconciler.pass();
      expect(result.actions).toStrictEqual([]);
    }

    // AD-8, twice over: the recorded session id would have allowed a resume, and nothing used it.
    expect(stoppable.started).toHaveLength(1);
    expect(resetter.resets).toStrictEqual([]);
    expect(reconciler.load(accepted.run).state.steps[0]?.disposition).toBe('killed');
  });
});

describe('a take-over written while a step is running', () => {
  it('stops the live child too, so the system and a person never edit one worktree at once', async () => {
    const stoppable = createStoppableExecutor();
    const { reconciler } = openReconciler({ stoppable, wireTheStopper: true });
    const accepted = reconciler.acceptFeature(makePlan());
    reconciler.confirm(accepted.run);

    const passing = reconciler.pass();
    await stoppable.waitForStart();
    writeIntent(accepted.run, 'take_over');
    await passing;

    const state = reconciler.load(accepted.run).state;
    expect(state.steps[0]?.disposition).toBe('killed');
    expect(state.state).toBe('handed_off');
  });
});

describe('with no stopper wired in, the gap is visible rather than silent', () => {
  it('consumes the intent only after the step it arrived during has finished on its own', async () => {
    const stoppable = createStoppableExecutor();
    const { reconciler } = openReconciler({ stoppable, wireTheStopper: false });
    const accepted = reconciler.acceptFeature(makePlan());
    reconciler.confirm(accepted.run);

    const passing = reconciler.pass();
    await stoppable.waitForStart();
    writeIntent(accepted.run, 'disengage');

    // Nothing can stop the child, so the step runs to its own end.
    await delay(STEERING_POLL_INTERVAL_MS * 4);
    expect(stoppable.finish(accepted.run, 'implement')).toBe(true);
    await passing;

    // The step's own outcome stands — it was never stopped — and the run is still running.
    expect(reconciler.load(accepted.run).state.steps[0]?.disposition).toBe('completed');
    expect(reconciler.load(accepted.run).state.state).toBe('running');

    // The intent was not lost, though: the next pass applies it, because nothing deleted it.
    await reconciler.pass();
    expect(reconciler.load(accepted.run).state.state).toBe('killed');
  });
});

describe('the whole control surface works through files alone', () => {
  it('needs no method call and no server to stop a running step', async () => {
    const stoppable = createStoppableExecutor();
    const { reconciler } = openReconciler({ stoppable, wireTheStopper: true });
    const accepted = reconciler.acceptFeature(makePlan());

    // Even the confirmation arrives as a file.
    writeIntent(accepted.run, 'confirm_spec');
    await reconciler.pass();
    expect(reconciler.load(accepted.run).state.state).toBe('confirmed');

    const passing = reconciler.pass();
    await stoppable.waitForStart();
    writeIntent(accepted.run, 'disengage');
    await passing;

    expect(reconciler.load(accepted.run).state.state).toBe('killed');
  });
});

describe('the stopper adapter', () => {
  it('narrows a spawner kill to one run’s attempt', () => {
    const calls: { step: string; run?: string }[] = [];
    const stopper = stepStopperFrom({
      kill: (step, run): boolean => {
        calls.push(run === undefined ? { step } : { step, run });
        return true;
      },
    });

    stopper({ run: 'run-a', step: 'implement', command: 'kill', reason: 'because' });
    // One spawner serves every run, so a step name alone would stop whichever child was found first.
    expect(calls).toStrictEqual([{ step: 'implement', run: 'run-a' }]);
  });
});
