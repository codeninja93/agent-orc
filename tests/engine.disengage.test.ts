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
import { Recorder, readEventLog, runPaths } from '../src/runtime/index.js';
import {
  COMMAND_EVENT_TYPES,
  DECLARED_DISENGAGE_BOUND_MS,
  DECLARED_DISENGAGE_OBSERVATION_BOUND_MS,
  ENGINE_EVENT_TYPES,
  EXECUTOR_KILL_GRACE_MS,
  Reconciler,
  ResumeRefused,
  STEERING_EVENT_TYPES,
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

const createStoppableExecutor = (resumable = false): Stoppable => {
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
      /**
       * A resume that stays in flight exactly as `start` does, because that is what a resume *is*.
       *
       * The `resume-step` path had no watcher at all, so a disengage written during a resume was not
       * observed: the child stayed live past the declared bound, the step finished on its own recording
       * `completed`, and the run was left `interrupted`. Proving that needs a resume that hangs, which the
       * rejecting double below could not be.
       */
      resume: (request): Promise<StepTermination> =>
        resumable
          ? new Promise<StepTermination>((resolve) => {
              started.push(request);
              request.onSessionId(request.sessionId);
              live.set(key(request.run, request.step), resolve);
            })
          : Promise.reject(new ResumeRefused(request.step, request.sessionId, 'this suite never resumes')),
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
const writeIntent = (
  run: string,
  command: Command,
  options: { readonly step?: string | null; readonly argument?: string } = {},
): string => {
  const intent = newCommandIntent({
    intentId: mintIntentId(mintRunId()),
    command,
    run,
    feature: 'engine-reconciler',
    step: options.step ?? null,
    principal: { kind: 'user', id: 'deep' },
    source: 'tui',
    ...(options.argument === undefined ? {} : { argument: options.argument }),
  });
  writeCommandIntent(runPaths(run, home), intent);
  return intent.intent_id;
};

const eventsOf = (run: string, type: string): readonly { payload: Record<string, unknown> }[] =>
  readEventLog(runPaths(run, home).eventLog).filter((event) => event.type === type);

/**
 * A step recorded as started, with a session id, and never terminated.
 *
 * What an engine killed inside a step leaves on disk, and the only input the `resume-step` path has: the
 * next pass adopts it as `interrupted` and the pass after that resumes it by the recorded session id
 * (AD-8). Written through a real recorder rather than by hand, so the log the fold reads is a real log.
 */
const appendOrphanedStart = (run: string, step: string, sessionId: string): void => {
  const recorder = Recorder.open({ runId: run, feature: 'engine-reconciler', orchHome: home });
  try {
    recorder.record({
      feature: 'engine-reconciler',
      run,
      step,
      emitter: 'engine.reconciler',
      type: ENGINE_EVENT_TYPES.StepStarted,
      payload: {
        attempt: 1,
        phase: 'implementation',
        contract_id: 'step.output',
        model_tier: 'claude-haiku-4-5',
        mode: 'live',
        input: `steps/${step}/input.json`,
      },
      baseline_ref: BASELINE,
    });
    recorder.record({
      feature: 'engine-reconciler',
      run,
      step,
      emitter: 'engine.reconciler',
      type: ENGINE_EVENT_TYPES.StepSessionRecorded,
      payload: { attempt: 1 },
      // On the envelope, not in the payload: the session id is an envelope field, and the fold reads it
      // from there. A payload copy would be a second spelling the fold never looks at.
      session_id: sessionId,
      baseline_ref: BASELINE,
    });
  } finally {
    // A test fixture's file descriptor, not a production cleanup path: AD-32's rule is about the engine.
    recorder.close();
  }
};

const checkpointOnDisk = (run: string): RunState =>
  JSON.parse(readFileSync(join(runPaths(run, home).runDir, RUN_STATE_FILE_NAME), 'utf8')) as RunState;

describe('the declared bound', () => {
  it('is a real number, and larger than the interval it is built from', () => {
    // "Instant" is a measurable claim, so it has a number; the number has to cover the poll it rests on.
    expect(DECLARED_DISENGAGE_OBSERVATION_BOUND_MS).toBeGreaterThan(STEERING_POLL_INTERVAL_MS * 4);
  });

  it('exceeds the kill grace it cannot shorten, because the grace is the authoritative number', () => {
    /**
     * The story declared 2s end to end, and that number was wrong *by construction*.
     *
     * Story 1-4 gives a child that ignores `SIGTERM` a further `EXECUTOR_KILL_GRACE_MS` before `SIGKILL`,
     * and that decision belongs to the unit that signals the child: a bound declared in the loop cannot
     * shorten it, only describe the total honestly. So the end-to-end bound has to exceed the grace, and
     * the 2s that remains is the loop's own share — gesture on disk to stop delivered — which is what the
     * measurements in this suite are against.
     *
     * Asserted here rather than computed in `reconciler.ts`, because the reconciler deliberately does not
     * import the spawner: it reaches the executor through a port, and importing a constant would drag
     * `node:child_process` into the loop's graph to read a number. A test may import both, and does.
     */
    expect(DECLARED_DISENGAGE_BOUND_MS).toBeGreaterThan(EXECUTOR_KILL_GRACE_MS);
    expect(DECLARED_DISENGAGE_BOUND_MS).toBeGreaterThan(DECLARED_DISENGAGE_OBSERVATION_BOUND_MS);
    expect(DECLARED_DISENGAGE_BOUND_MS).toBeGreaterThanOrEqual(
      EXECUTOR_KILL_GRACE_MS + DECLARED_DISENGAGE_OBSERVATION_BOUND_MS,
    );
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
    expect(elapsed).toBeLessThan(DECLARED_DISENGAGE_OBSERVATION_BOUND_MS);
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
    expect(performance.now() - at).toBeLessThan(DECLARED_DISENGAGE_OBSERVATION_BOUND_MS);

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

describe('a disengage written while a *resumed* step is running', () => {
  it('stops the live child within the loop’s bound, exactly as it does for a fresh step', async () => {
    /**
     * `watchForStopIntents` was called from exactly one place — `driveStep` — so `resume-step` started a
     * child with no watcher and no post-termination consumption. A disengage written during a resume was
     * not observed at all: the child was still live past the declared bound, the step finished on its own
     * recording `completed`, and the run was left `interrupted`. CAP-5 failed for the long-running case it
     * exists for, which is precisely a step resumed after a crash.
     */
    const first = createStoppableExecutor(true);
    const { reconciler: crashing } = openReconciler({ stoppable: first, wireTheStopper: true });
    const accepted = crashing.acceptFeature(makePlan());
    crashing.confirm(accepted.run);
    crashing.close();

    // A step recorded as started with a session id and never terminated: what an engine killed inside a
    // step leaves behind, and the only input the resume path has.
    appendOrphanedStart(accepted.run, 'implement', 'sess-implement');

    const second = createStoppableExecutor(true);
    const { reconciler } = openReconciler({ stoppable: second, wireTheStopper: true });
    const adoption = await reconciler.pass();
    expect(adoption.actions.map((action) => action.kind)).toStrictEqual(['adopt-orphan']);
    expect(reconciler.load(accepted.run).state.steps[0]?.disposition).toBe('interrupted');

    // The resume, deliberately not awaited: the resumed step is in flight for as long as this test wants.
    const resuming = reconciler.pass();
    await second.waitForStart();
    expect(second.started[0]?.step).toBe('implement');

    const at = performance.now();
    const intentId = writeIntent(accepted.run, 'disengage');
    const result = await resuming;
    const elapsed = performance.now() - at;

    expect(result.actions.map((action) => action.kind)).toStrictEqual(['resume-step']);
    expect(elapsed).toBeLessThan(DECLARED_DISENGAGE_OBSERVATION_BOUND_MS);

    const state = reconciler.load(accepted.run).state;
    expect(state.steps[0]?.disposition).toBe('killed');
    expect(state.state).toBe('killed');

    // Recorded once, with the gesture applied inside the same action rather than on a later pass.
    const applied = eventsOf(accepted.run, COMMAND_EVENT_TYPES.Applied);
    expect(applied.filter((event) => event.payload['intent_id'] === intentId)).toHaveLength(1);
    expect(readIntentFiles(runPaths(accepted.run, home)).pending).toStrictEqual([]);
  });
});

describe('only a stop command stops a live step', () => {
  it('leaves a step alone when the pending intent is one nothing consumes yet', async () => {
    /**
     * The mid-step watcher filters on `STOP_COMMANDS`. Replace that filter with `read.pending[0]` and the
     * whole suite stays green — which matters because an `awaiting` intent sits in `commands/`
     * indefinitely *by design*: `narrow`, `pause`, `fork` and `inject_note` are written and left for the
     * story that owns them. So a single such file would kill every subsequent step of that run, recording
     * `killed` on work nothing ever re-runs (AD-8).
     */
    const stoppable = createStoppableExecutor();
    const { reconciler } = openReconciler({ stoppable, wireTheStopper: true });
    const accepted = reconciler.acceptFeature(makePlan());
    reconciler.confirm(accepted.run);

    const passing = reconciler.pass();
    await stoppable.waitForStart();
    // `narrow` is `awaiting`: the file is deliberately kept, unconsumed and unrecorded.
    const intentId = writeIntent(accepted.run, 'narrow', { argument: 'just the refund path' });

    // Given every chance to be noticed, and then the step is allowed to finish on its own.
    await delay(STEERING_POLL_INTERVAL_MS * 6);
    expect(stoppable.finish(accepted.run, 'implement')).toBe(true);
    await passing;

    // The step's own outcome stands. Nothing was killed, and nothing was relabelled.
    expect(reconciler.load(accepted.run).state.steps[0]?.disposition).toBe('completed');
    expect(reconciler.load(accepted.run).state.state).toBe('running');

    // And the intent is still there for its owner, which is the whole point of `awaiting`.
    const pending = readIntentFiles(runPaths(accepted.run, home)).pending;
    expect(pending.map((entry) => entry.intent.intent_id)).toStrictEqual([intentId]);
    expect(eventsOf(accepted.run, COMMAND_EVENT_TYPES.Applied)).toHaveLength(1); // the confirmation only
  });

  it('ignores a stop intent that names a different step than the one in flight', async () => {
    /**
     * Matching on the command alone made an intent naming step "verify" stop whatever happened to be
     * running. AD-8 never re-runs a killed step, so the wrong child stopped is permanent.
     */
    const stoppable = createStoppableExecutor();
    const { reconciler } = openReconciler({ stoppable, wireTheStopper: true });
    const accepted = reconciler.acceptFeature(makePlan());
    reconciler.confirm(accepted.run);

    const passing = reconciler.pass();
    await stoppable.waitForStart();
    expect(stoppable.started[0]?.step).toBe('implement');
    writeIntent(accepted.run, 'kill', { step: 'verify' });

    await delay(STEERING_POLL_INTERVAL_MS * 6);
    expect(stoppable.finish(accepted.run, 'implement')).toBe(true);
    await passing;

    // "implement" ran to its own end; it was never signalled and never relabelled.
    expect(reconciler.load(accepted.run).state.steps[0]?.disposition).toBe('completed');
    // The gesture is not lost: it is applied between passes, where a run-level kill belongs.
    await reconciler.pass();
    expect(reconciler.load(accepted.run).state.state).toBe('killed');
  });
});

describe('the mid-step gesture is reported, not only applied', () => {
  it('surfaces the outcome of an intent consumed inside a step in PassResult.steering', async () => {
    /**
     * `if (watch.observed() !== null) { this.consumeIntents(...) }` discarded the `IntentPassOutcome`, so
     * an intent applied mid-step never appeared in `PassResult.steering` and a refusal raised there was
     * invisible — which contradicts `steering` being how a refusal becomes visible rather than silent.
     */
    const stoppable = createStoppableExecutor();
    const { reconciler } = openReconciler({ stoppable, wireTheStopper: true });
    const accepted = reconciler.acceptFeature(makePlan());
    reconciler.confirm(accepted.run);

    const passing = reconciler.pass();
    await stoppable.waitForStart();
    const intentId = writeIntent(accepted.run, 'disengage');
    const result = await passing;

    const applied = result.steering.flatMap((entry) => entry.applied);
    expect(applied.map((entry) => entry.intentId)).toContain(intentId);
    expect(applied.find((entry) => entry.intentId === intentId)?.kind).toBe('applied');
    // And the delivery itself is recorded, so "did my disengage reach it?" has an answer in the log.
    const delivered = eventsOf(accepted.run, STEERING_EVENT_TYPES.StopDelivered);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]?.payload['intent_id']).toBe(intentId);
    expect(delivered[0]?.payload['command']).toBe('disengage');
    expect(delivered[0]?.payload['stopped']).toBe(true);
  });
});

describe('an engine with no stopper says so, once per run', () => {
  it('records the missing capability rather than behaving like a slow disengage', async () => {
    /**
     * CAP-5's mid-step property is inert as this build is assembled: nothing in `src/` constructs a
     * `Reconciler`, so `stopStep` reaches it from nowhere. Wiring it is the assembly story's, and until
     * then the *silence* is the fixable part — a run that ignored a disengage looked exactly like a run
     * whose disengage was merely slow.
     */
    const stoppable = createStoppableExecutor();
    const { reconciler } = openReconciler({ stoppable, wireTheStopper: false });
    const accepted = reconciler.acceptFeature(makePlan());
    reconciler.confirm(accepted.run);

    const passing = reconciler.pass();
    await stoppable.waitForStart();
    expect(stoppable.finish(accepted.run, 'implement')).toBe(true);
    await passing;

    const unwired = eventsOf(accepted.run, STEERING_EVENT_TYPES.StopperUnwired);
    expect(unwired).toHaveLength(1);
    expect(String(unwired[0]?.payload['reason'])).toContain('no step stopper');
    expect(unwired[0]?.payload['capability']).toBe('mid-step stop (CAP-5)');

    // A second step on the same run does not say it again: the fact is about the assembly, not the step.
    const second = reconciler.pass();
    await delay(STEERING_POLL_INTERVAL_MS * 2);
    stoppable.finish(accepted.run, 'verify');
    await second;
    expect(eventsOf(accepted.run, STEERING_EVENT_TYPES.StopperUnwired)).toHaveLength(1);
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
