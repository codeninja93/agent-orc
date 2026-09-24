/**
 * AD-7, AD-8, AD-26, AD-29, AD-35 — the loop.
 *
 * Twelve of the sixteen matrix rows land here: the minted run id, one action per pass, the lifecycle
 * transitions, disposition routing, resume-then-re-run, `killed` never resumed, re-run idempotence
 * against a real worktree, the unknown failure code, and the two territory rows driven through a real
 * pass rather than through the admission function alone.
 *
 * The suite also holds the dependency-direction guard for `src/engine/`, and the assertion that the
 * engine never opens `events.jsonl` itself — both structural, both invisible until a later story
 * breaks them.
 */
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  BRANCH_PROTECTION_ASSERTED_EVENT_TYPE,
  CommittingOutputSchema,
  PULL_REQUEST_MERGE_FIDELITY_EVENT_TYPE,
  PULL_REQUEST_MERGE_FIDELITY_PAYLOAD_KEYS,
  RUN_STATE_FILE_NAME,
  StepInputSchema,
  StepOutputSchema,
  WRITE_GATE_APPROVED_EVENT_TYPE,
  WRITE_GATE_APPROVED_PAYLOAD_KEYS,
  WRITE_GATE_OPENED_EVENT_TYPE,
  WRITE_GATE_OPENED_PAYLOAD_KEYS,
  WRITE_GATE_REJECTED_EVENT_TYPE,
  WRITE_GATE_REJECTED_PAYLOAD_KEYS,
  dispositionFor,
  makeError,
} from '../src/contracts/index.js';
import type {
  EventEnvelope,
  ModelRung,
  OrchError,
  QuestionDraft,
  ReversibilityClass,
  StepDisposition,
} from '../src/contracts/index.js';
import { Recorder, RunFetchRecord, readEventLog, runPaths, runsDir } from '../src/runtime/index.js';
import {
  BaselineResetError,
  COMPOSED_COMMIT_RELATIVE_PATH,
  ENGINE_EMITTER,
  ENGINE_EVENT_TYPES,
  SPEC_RECORDED_EVENT_TYPE,
  STANDARD_PLAN_STEPS,
  TERRITORY_DECLARED_EVENT_TYPE,
  Reconciler,
  ResumeRefused,
  SteeringRefused,
  StepSpawnFailed,
  createRecordingResetter,
  createScriptedExecutor,
  createUlidMinter,
  gitBaselineResetter,
  isUlid,
  measureConsumption,
  performWriteIntent,
  rebuildFromLog,
  routeRefusedResume,
  routeTermination,
  takeConfigSnapshot,
  terminated,
} from '../src/engine/index.js';
import type {
  BaselineResetter,
  FeaturePlan,
  GhCall,
  GitCall,
  MergeCheck,
  MergeCheckPort,
  ScriptedExecutorOptions,
  WriteExecutorPort,
} from '../src/engine/index.js';

import {
  fixturePermissions,
  fixtureProfile,
  makeWorkspace,
  writePermissions,
  writeProfile,
} from './helpers/config-fixture.js';
import { makeGitWorktree, makeHome, makePlan, planProvider } from './helpers/engine-fixture.js';

/**
 * A real commit SHA. `'a'.repeat(40)` carries 0.00 bits per character and so is never touched by the
 * redaction pass — using it in the round-trip test that exists to guard the allow-list would have made
 * that test vacuous, which is precisely the mistake story 1-2 made with its run ids.
 */
const BASELINE = 'ddd9bed4d286ac1f8a0f4f7bfef9530046605787';

let home: string;
const toRemove: string[] = [];
const toClose: Reconciler[] = [];

beforeEach(() => {
  home = makeHome('engine-reconciler');
  toRemove.push(home);
});

afterEach(() => {
  for (const reconciler of toClose.splice(0)) reconciler.close();
  for (const dir of toRemove.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A reconciler over one plan, driving a scripted executor and a resetter that mutates nothing. */
const openReconciler = (options: {
  readonly plan?: FeaturePlan;
  readonly script: ScriptedExecutorOptions;
  readonly baseline?: BaselineResetter;
  readonly orchHome?: string;
  readonly onDurableBoundary?: (label: string) => void;
  readonly redaction?: { readonly secrets?: readonly string[] };
}): {
  readonly reconciler: Reconciler;
  readonly plan: FeaturePlan;
  readonly executor: ReturnType<typeof createScriptedExecutor>;
} => {
  const plan = options.plan ?? makePlan();
  const executor = createScriptedExecutor(options.script);
  const reconciler = Reconciler.open({
    orchHome: options.orchHome ?? home,
    executor,
    plans: planProvider(plan),
    baseline: options.baseline ?? createRecordingResetter(BASELINE),
    ...(options.onDurableBoundary === undefined
      ? {}
      : { onDurableBoundary: options.onDurableBoundary }),
    ...(options.redaction === undefined ? {} : { redaction: options.redaction }),
  });
  toClose.push(reconciler);
  return { reconciler, plan, executor };
};

/** A script where every step completes on its first attempt. */
const alwaysCompletes: ScriptedExecutorOptions = {
  onStart: (request) => terminated(request.step, 'completed', { sessionId: `sess-${request.step}` }),
  sessionIdFor: (request) => `sess-${request.step}`,
};

const eventTypes = (run: string, orchHome = home): readonly string[] =>
  readEventLog(runPaths(run, orchHome).eventLog).map((event) => event.type);

/**
 * Append a `step.started` with no termination, exactly as a SIGKILL inside the executor leaves one.
 *
 * Reached through the log rather than by making the port throw, because a thrown port rejection is now a
 * *termination* — the AD-35 table answers it — so it can no longer be used to manufacture an orphan. The
 * reconciler must be closed first: it holds the run's single-writer claim, which is itself the state a
 * crashed engine leaves behind.
 */
const appendOrphanedStart = (
  run: string,
  feature: string,
  step: string,
  sessionId: string | null = null,
): void => {
  const recorder = Recorder.open({ runId: run, feature, orchHome: home });
  try {
    recorder.record({
      feature,
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
    if (sessionId !== null) {
      recorder.record({
        feature,
        run,
        step,
        emitter: 'engine.reconciler',
        type: ENGINE_EVENT_TYPES.StepSessionRecorded,
        payload: { attempt: 1 },
        session_id: sessionId,
        baseline_ref: BASELINE,
      });
    }
  } finally {
    recorder.close();
  }
};

describe('a new feature is accepted with a minted run id', () => {
  it('mints a 26-character Crockford base32 ULID and records the checkpoint at drafting', () => {
    const { reconciler } = openReconciler({ script: alwaysCompletes });
    const accepted = reconciler.acceptFeature(makePlan());

    expect(isUlid(accepted.run)).toBe(true);
    expect(accepted.run).toHaveLength(26);
    expect(accepted.state.state).toBe('drafting');
    expect(accepted.state.steps).toStrictEqual([]);
    expect(existsSync(join(runPaths(accepted.run, home).runDir, RUN_STATE_FILE_NAME))).toBe(true);
    // Story 1-11 added the two run-level declarations, in this order: the run exists, then what it is
    // being built against (CAP-2), then the territory its overlap is recomputed from. All three land
    // before anything can read them, which is what lets the spec echo offer a confirmation at `drafting`.
    // Story 2-7 added the fourth, last: ADR-001's branch-protection assertion is *about this run*, so a
    // refusal has to have a run to be recorded against, and the three above are what make one readable.
    expect(eventTypes(accepted.run)).toStrictEqual([
      ENGINE_EVENT_TYPES.RunCreated,
      SPEC_RECORDED_EVENT_TYPE,
      TERRITORY_DECLARED_EVENT_TYPE,
      BRANCH_PROTECTION_ASSERTED_EVENT_TYPE,
    ]);
  });

  it('mints monotonic ids, so two features accepted in one millisecond sort in acceptance order', () => {
    const { reconciler } = openReconciler({
      script: alwaysCompletes,
      plan: makePlan({ feature: 'a' }),
    });
    const minted = Reconciler.open({
      orchHome: makeHome('engine-minter'),
      executor: createScriptedExecutor(alwaysCompletes),
      plans: planProvider(makePlan()),
      minter: createUlidMinter({ now: () => 1_770_000_000_000 }),
    });
    toClose.push(minted);
    toRemove.push(minted.orchHome);

    const first = minted.acceptFeature(makePlan());
    const second = minted.acceptFeature(makePlan());
    expect(second.run > first.run).toBe(true);
    expect(reconciler.runIds()).toStrictEqual([]);
  });

  it('takes no step until the criteria are confirmed (CAP-2)', async () => {
    const { reconciler, executor } = openReconciler({ script: alwaysCompletes });
    const accepted = reconciler.acceptFeature(makePlan());

    const first = await reconciler.pass();
    expect(first.actions.map((action) => action.kind)).toStrictEqual(['await-confirmation']);
    expect(executor.started).toStrictEqual([]);
    expect(reconciler.load(accepted.run).state.state).toBe('drafting');
  });
});

describe('AD-7 — at most one action per pass', () => {
  it('takes exactly one action and writes the checkpoint before the pass returns', async () => {
    const { reconciler } = openReconciler({ script: alwaysCompletes });
    const accepted = reconciler.acceptFeature(makePlan());
    reconciler.confirm(accepted.run);

    const result = await reconciler.pass();
    expect(result.actions).toHaveLength(1);
    expect(result.actions[0]?.kind).toBe('run-step');
    expect(result.actions[0]?.step).toBe('implement');

    // The checkpoint on disk already reflects the action, before the pass returned.
    const onDisk = JSON.parse(
      readFileSync(join(runPaths(accepted.run, home).runDir, RUN_STATE_FILE_NAME), 'utf8'),
    ) as { state: string; steps: { step: string; disposition: string }[] };
    expect(onDisk.state).toBe('running');
    expect(onDisk.steps).toStrictEqual([
      expect.objectContaining({ step: 'implement', disposition: 'completed' }),
    ]);
  });

  it('advances one step per pass, never two', async () => {
    const { reconciler, executor } = openReconciler({ script: alwaysCompletes });
    const accepted = reconciler.acceptFeature(makePlan());
    reconciler.confirm(accepted.run);

    await reconciler.pass();
    expect(executor.started.map((request) => request.step)).toStrictEqual(['implement']);
    await reconciler.pass();
    expect(executor.started.map((request) => request.step)).toStrictEqual(['implement', 'verify']);
  });

  it('walks the whole lifecycle to committed: drafting, confirmed, running, verifying, committed', async () => {
    const { reconciler } = openReconciler({ script: alwaysCompletes });
    const accepted = reconciler.acceptFeature(makePlan());
    expect(reconciler.load(accepted.run).state.state).toBe('drafting');
    expect(reconciler.confirm(accepted.run).state).toBe('confirmed');

    const taken = await reconciler.runUntilSettled();
    const states = taken.map((action) => action.to);
    expect(states).toContain('running');
    expect(states).toContain('verifying');
    expect(reconciler.load(accepted.run).state.state).toBe('committed');
    expect(reconciler.fingerprint(accepted.run)).toBe('committed|implement:completed|verify:completed');
  });

  it('takes no further action once the run is terminal', async () => {
    const { reconciler } = openReconciler({ script: alwaysCompletes });
    const accepted = reconciler.acceptFeature(makePlan());
    reconciler.confirm(accepted.run);
    await reconciler.runUntilSettled();

    const before = readEventLog(runPaths(accepted.run, home).eventLog).length;
    const settled = await reconciler.pass();
    // A terminal run is excluded from the pass entirely, so nothing is even reported for it.
    expect(settled.actions).toStrictEqual([]);
    expect(readEventLog(runPaths(accepted.run, home).eventLog)).toHaveLength(before);
  });

  it('writes the step input file once and re-runs from the same bytes', async () => {
    const worktree = makeGitWorktree('input-reuse');
    toRemove.push(worktree.dir);
    const plan = makePlan({ worktree: worktree.dir, steps: [
      { step: 'implement', contract_id: 'step.output', phase: 'implementation' },
    ] });

    let attempts = 0;
    const { reconciler, executor } = openReconciler({
      plan,
      baseline: createRecordingResetter(worktree.head),
      script: {
        onStart: (request) => {
          attempts += 1;
          return attempts === 1
            ? terminated(request.step, 'failed', { error: makeError('step.timed_out', 'slow') })
            : terminated(request.step, 'completed');
        },
      },
    });
    const accepted = reconciler.acceptFeature(plan);
    reconciler.confirm(accepted.run);
    await reconciler.runUntilSettled();

    const inputPath = join(runPaths(accepted.run, home).runDir, 'steps', 'implement', 'input.json');
    const input = StepInputSchema.parse(JSON.parse(readFileSync(inputPath, 'utf8')));
    expect(input.baseline_ref).toBe(worktree.head);
    expect(input.request).toBe(plan.request);
    expect(input.acceptance_criteria).toStrictEqual(plan.acceptance_criteria);
    // Both attempts were handed the identical input object: a re-run is from the typed input file.
    expect(executor.started).toHaveLength(2);
    expect(executor.started[1]?.input).toStrictEqual(executor.started[0]?.input);
    expect(executor.started[1]?.inputPath).toBe(inputPath);
  });
});

/**
 * Story 2-10, task 5 — the Jira tool server's standalone fetch-record writes are mirrored into
 * `events.jsonl` once the reconciler next holds its own live `Recorder` for the run, at the point in
 * its own pass where it already processes a step's disposition.
 */
describe('story 2-10 — a standalone fetch-record write is backfilled into events.jsonl', () => {
  it('mirrors an entry a standalone Jira server wrote before the step it belongs to terminates', async () => {
    const { reconciler } = openReconciler({ script: alwaysCompletes });
    const accepted = reconciler.acceptFeature(makePlan());
    reconciler.confirm(accepted.run);

    // What the Jira MCP child of the about-to-run "implement" step would have done: served a read
    // through its own dedicated lock, with no Recorder of its own and so no events.jsonl append.
    const standalone = RunFetchRecord.openStandalone({ runId: accepted.run, orchHome: home, step: 'implement' });
    await standalone.serve(
      { domain: 'jira', operation: 'get_issue', parameters: { key: 'PROJ-1' } },
      () => ({ ok: true, status: 200, body: { key: 'PROJ-1' } }),
    );
    standalone.close();
    expect(eventTypes(accepted.run)).not.toContain('fetch.recorded');

    // The pass that runs "implement" to completion also processes its disposition, which is where
    // the backfill happens.
    await reconciler.pass();

    const events = readEventLog(runPaths(accepted.run, home).eventLog).filter(
      (event) => event.type === 'fetch.recorded',
    );
    expect(events).toHaveLength(1);
    expect(events[0]?.payload['domain']).toBe('jira');
    expect(events[0]?.payload['operation']).toBe('get_issue');
    expect(events[0]?.payload['source']).toBe('domain');
    expect(events[0]?.step).toBe('implement');

    // Backfilling is idempotent: a later pass must not re-mirror the same entry a second time.
    await reconciler.pass();
    const afterSecondPass = readEventLog(runPaths(accepted.run, home).eventLog).filter(
      (event) => event.type === 'fetch.recorded',
    );
    expect(afterSecondPass).toHaveLength(1);
  });
});

describe('AD-8 — resume, then re-run from the baseline', () => {
  /** A step that reports a session id, is interrupted, and completes on its next attempt. */
  const interruptedThenCompletes = (
    onResume?: ScriptedExecutorOptions['onResume'],
  ): ScriptedExecutorOptions => {
    let starts = 0;
    return {
      sessionIdFor: (request) => `sess-${request.step}`,
      onStart: (request) => {
        if (request.step !== 'implement') return terminated(request.step, 'completed');
        starts += 1;
        return starts === 1
          ? terminated(request.step, 'interrupted', { sessionId: `sess-${request.step}` })
          : terminated(request.step, 'completed', { sessionId: `sess-${request.step}` });
      },
      ...(onResume === undefined ? {} : { onResume }),
    };
  };

  it('attempts a resume by the recorded session id', async () => {
    const { reconciler, executor } = openReconciler({
      script: interruptedThenCompletes((request) =>
        terminated(request.step, 'completed', { sessionId: request.sessionId }),
      ),
    });
    const accepted = reconciler.acceptFeature(makePlan());
    reconciler.confirm(accepted.run);

    await reconciler.pass(); // runs `implement`, which reports interrupted
    expect(reconciler.load(accepted.run).state.state).toBe('interrupted');
    expect(reconciler.load(accepted.run).state.steps[0]?.session_id).toBe('sess-implement');

    await reconciler.pass(); // resumes by that id
    expect(executor.resumed.map((request) => request.sessionId)).toStrictEqual(['sess-implement']);
    expect(eventTypes(accepted.run)).toContain(ENGINE_EVENT_TYPES.StepResumeAttempted);
    expect(reconciler.load(accepted.run).state.steps[0]?.disposition).toBe('completed');
  });

  it('resets to baseline_ref and re-runs from the typed input when the resume is rejected', async () => {
    const resetter = createRecordingResetter(BASELINE);
    const { reconciler, executor } = openReconciler({
      baseline: resetter,
      // No `onResume`: the double refuses every resume, which is the matrix row.
      script: interruptedThenCompletes(),
    });
    const accepted = reconciler.acceptFeature(makePlan());
    reconciler.confirm(accepted.run);

    await reconciler.pass(); // interrupted
    await reconciler.pass(); // resume refused; the recorded session id is spent
    expect(executor.resumed).toHaveLength(1);
    expect(eventTypes(accepted.run)).toContain(ENGINE_EVENT_TYPES.StepResumeRefused);
    expect(reconciler.load(accepted.run).state.steps[0]?.session_id).toBeNull();
    expect(resetter.resets).toStrictEqual([]);

    await reconciler.pass(); // the recovery: reset to baseline_ref, then re-run
    expect(resetter.resets).toStrictEqual([{ worktree: makePlan().worktree, ref: BASELINE }]);
    expect(eventTypes(accepted.run)).toContain(ENGINE_EVENT_TYPES.StepBaselineReset);
    expect(executor.started.map((request) => request.step)).toStrictEqual(['implement', 'implement']);
    // The third engagement of the step: the first start, the refused resume, and now the re-run. A
    // resume is a hand of the step to the executor, so it counts — which is what makes the attempt
    // bound cover AD-8's resume path rather than only the failures.
    expect(executor.started[1]?.attempt).toBe(3);
    expect(reconciler.load(accepted.run).state.steps[0]?.disposition).toBe('completed');
  });

  it('re-runs straight away for an interruption with no recorded session id', async () => {
    const resetter = createRecordingResetter(BASELINE);
    let starts = 0;
    const { reconciler, executor } = openReconciler({
      baseline: resetter,
      script: {
        // No `sessionIdFor`, so nothing is ever recorded to resume against.
        onStart: (request) => {
          if (request.step !== 'implement') return terminated(request.step, 'completed');
          starts += 1;
          return starts === 1
            ? terminated(request.step, 'interrupted')
            : terminated(request.step, 'completed');
        },
      },
    });
    const accepted = reconciler.acceptFeature(makePlan());
    reconciler.confirm(accepted.run);

    await reconciler.pass();
    await reconciler.pass();
    expect(executor.resumed).toStrictEqual([]);
    expect(resetter.resets).toHaveLength(1);
  });

  it('adopts a step the engine died inside as interrupted, rather than guessing', async () => {
    const first = openReconciler({ script: alwaysCompletes });
    const accepted = first.reconciler.acceptFeature(makePlan());
    first.reconciler.confirm(accepted.run);
    // The engine dies inside the step: the log keeps a start with no termination, and the claim is left
    // behind for the next engine to reclaim.
    first.reconciler.close();
    appendOrphanedStart(accepted.run, 'engine-reconciler', 'implement');

    const { reconciler } = openReconciler({ script: alwaysCompletes });
    expect(reconciler.load(accepted.run).state.steps[0]?.disposition).toBeNull();

    const adoption = await reconciler.advance(accepted.run);
    expect(adoption.kind).toBe('adopt-orphan');
    expect(reconciler.load(accepted.run).state.steps[0]?.disposition).toBe('interrupted');
    expect(reconciler.load(accepted.run).state.state).toBe('interrupted');
  });

  it('records the session id the moment it is reported, not only at termination', async () => {
    const { reconciler } = openReconciler({
      script: {
        sessionIdFor: () => 'sess-early',
        // The step never reports the id on termination, so the only way it can be known is the callback.
        onStart: (request) => terminated(request.step, 'completed'),
      },
    });
    const accepted = reconciler.acceptFeature(makePlan());
    reconciler.confirm(accepted.run);
    await reconciler.pass();

    const log = readEventLog(runPaths(accepted.run, home).eventLog);
    const recorded = log.find((event) => event.type === ENGINE_EVENT_TYPES.StepSessionRecorded);
    expect(recorded?.session_id).toBe('sess-early');
    const started = log.findIndex((event) => event.type === ENGINE_EVENT_TYPES.StepStarted);
    const sessionAt = log.findIndex(
      (event) => event.type === ENGINE_EVENT_TYPES.StepSessionRecorded,
    );
    // Before the termination, so a crash in between still leaves an id to resume against.
    expect(sessionAt).toBeGreaterThan(started);
    expect(reconciler.load(accepted.run).state.steps[0]?.session_id).toBe('sess-early');
  });
});

describe('AD-8 — a killed step is never resumed and never re-run', () => {
  it('records killed on the step in flight, and takes no further action across many passes', async () => {
    const first = openReconciler({ script: alwaysCompletes });
    const accepted = first.reconciler.acceptFeature(makePlan());
    first.reconciler.confirm(accepted.run);
    first.reconciler.close();
    // A step genuinely in flight, with a session id recorded — everything a resume would need.
    appendOrphanedStart(accepted.run, 'engine-reconciler', 'implement', 'sess-implement');

    const resetter = createRecordingResetter(BASELINE);
    const { reconciler, executor } = openReconciler({ baseline: resetter, script: alwaysCompletes });

    const killed = reconciler.kill(accepted.run);
    expect(killed.state).toBe('killed');
    expect(killed.steps[0]?.disposition).toBe('killed');

    for (let index = 0; index < 5; index += 1) await reconciler.pass();

    // Never resumed and never re-run, though the recorded session id would have allowed both.
    expect(executor.resumed).toStrictEqual([]);
    expect(executor.started).toStrictEqual([]);
    expect(resetter.resets).toStrictEqual([]);
    expect(reconciler.load(accepted.run).state.steps[0]?.disposition).toBe('killed');
  });

  it('never rewrites a finished step when the kill arrives between passes', async () => {
    /**
     * The normal case: a kill lands in the gap when no step is running, and the last record is a step that
     * has already *completed*. Rewriting it as `killed` would put a permanent line in the log saying work
     * that was done never happened — and since a killed step is never re-run, nothing would put it back.
     */
    const { reconciler } = openReconciler({ script: alwaysCompletes });
    const accepted = reconciler.acceptFeature(makePlan());
    reconciler.confirm(accepted.run);
    await reconciler.pass();
    expect(reconciler.load(accepted.run).state.steps[0]?.disposition).toBe('completed');

    const killed = reconciler.kill(accepted.run);
    expect(killed.state).toBe('killed');
    // The finished step keeps its truthful record; only the feature stops.
    expect(killed.steps[0]?.disposition).toBe('completed');
    expect(killed.steps).toHaveLength(1);

    const after = await reconciler.pass();
    expect(after.actions).toStrictEqual([]);
  });

  it('routes a killed disposition to stop even where an error code would say retry', () => {
    // A kill outranks the AD-35 table: the code below is declared retry-with-backoff, and the routing
    // must still refuse to re-run it.
    expect(dispositionFor('step.timed_out')).toBe('retry-with-backoff');
    const routing = routeTermination({
      step: 'implement',
      disposition: 'killed',
      sessionId: 'sess-implement',
      error: makeError('step.timed_out', 'slow'),
      modelTier: 'claude-haiku-4-5',
      promotions: 0,
    });
    expect(routing.action).toBe('stop');
    expect(routing.reason).toContain('never resumed and never re-run');
  });
});

describe('AD-35 — every failure routes through the declared disposition table', () => {
  it.each<[string, StepDisposition, OrchError | null, string]>([
    ['a retryable code re-runs', 'failed', makeError('step.timed_out', 'slow'), 'reset-and-rerun'],
    [
      'a verification failure promotes the rung',
      'failed',
      makeError('step.verification_failed', 'gate failed'),
      'promote-model-tier',
    ],
    [
      'a human-only condition escalates',
      'blocked',
      makeError('permission.denied', 'needs approval'),
      'escalate-to-human',
    ],
    [
      'a declared abandon code hands off',
      'failed',
      makeError('redaction.failed', 'a secret was in the artifact'),
      'hand-off',
    ],
    ['an unknown code hands off', 'failed', makeError('nope.not.declared', 'mystery'), 'hand-off'],
    ['no error at all hands off', 'failed', null, 'hand-off'],
    ['a completed step advances', 'completed', null, 'advance'],
  ])('%s', (_label, disposition, error, expected) => {
    expect(
      routeTermination({
        step: 'implement',
        disposition,
        sessionId: null,
        error,
        modelTier: 'claude-haiku-4-5',
        promotions: 0,
      }).action,
    ).toBe(expected);
  });

  it('never retries an unrecognised code, and says the code was absent from the table', async () => {
    const resetter = createRecordingResetter(BASELINE);
    const { reconciler, executor } = openReconciler({
      baseline: resetter,
      script: {
        onStart: (request) =>
          terminated(request.step, 'failed', {
            error: makeError('some.code.this.build.never.declared', 'unrecognised'),
          }),
      },
    });
    const accepted = reconciler.acceptFeature(makePlan());
    reconciler.confirm(accepted.run);

    const taken = await reconciler.runUntilSettled();
    expect(taken.map((action) => action.kind)).toContain('hand-off');

    const state = reconciler.load(accepted.run).state;
    expect(state.state).toBe('handed_off');
    expect(state.handoff?.code).toBe('some.code.this.build.never.declared');
    expect(state.handoff?.reason).toContain('absent from the AD-35 disposition table');
    // No retry was attempted: the step ran exactly once and the worktree was never reset.
    expect(executor.started).toHaveLength(1);
    expect(resetter.resets).toStrictEqual([]);
  });

  it('promotes a verification failure once, then escalates rather than promoting again', async () => {
    const resetter = createRecordingResetter(BASELINE);
    const { reconciler, executor } = openReconciler({
      baseline: resetter,
      script: {
        onStart: (request) =>
          request.step === 'implement'
            ? terminated(request.step, 'completed')
            : terminated(request.step, 'failed', {
                error: makeError('step.verification_failed', 'the gate failed'),
              }),
      },
    });
    const accepted = reconciler.acceptFeature(makePlan());
    reconciler.confirm(accepted.run);
    const taken = await reconciler.runUntilSettled();

    const verifyAttempts = executor.started.filter((request) => request.step === 'verify');
    // One promotion per step per run: two attempts, the second on the higher rung, then a person.
    expect(verifyAttempts).toHaveLength(2);
    expect(verifyAttempts[0]?.modelTier).toBe('claude-haiku-4-5');
    expect(verifyAttempts[1]?.modelTier).toBe('claude-sonnet-5');
    expect(taken.map((action) => action.kind)).toContain('escalate-to-human');
    expect(reconciler.load(accepted.run).state.state).toBe('blocked');
    expect(eventTypes(accepted.run)).toContain(ENGINE_EVENT_TYPES.StepTierPromoted);
  });

  it('waits for a person while blocked, and continues once approved', async () => {
    let failVerify = true;
    const { reconciler } = openReconciler({
      script: {
        onStart: (request) => {
          if (request.step === 'implement') return terminated(request.step, 'completed');
          return failVerify
            ? terminated(request.step, 'blocked', {
                error: makeError('permission.denied', 'an irreversible gate'),
              })
            : terminated(request.step, 'completed');
        },
      },
    });
    const accepted = reconciler.acceptFeature(makePlan());
    reconciler.confirm(accepted.run);
    await reconciler.runUntilSettled();
    expect(reconciler.load(accepted.run).state.state).toBe('blocked');

    const waiting = await reconciler.pass();
    expect(waiting.actions[0]?.kind).toBe('await-approval');

    failVerify = false;
    reconciler.approve(accepted.run);
    await reconciler.runUntilSettled();
    expect(reconciler.load(accepted.run).state.state).toBe('committed');
  });

  it('reports the refused-resume recovery as the AD-35 retry it is', () => {
    const routing = routeRefusedResume('implement');
    expect(routing.action).toBe('reset-and-rerun');
    expect(routing.code).toBe('step.resume_failed');
    expect(routing.errorDisposition).toBe(dispositionFor('step.resume_failed'));
  });
});

describe('AD-26 — a re-run from one baseline has identical effect', () => {
  it('leaves the same worktree state after two re-runs, with effects not doubled', async () => {
    const worktree = makeGitWorktree('idempotence');
    toRemove.push(worktree.dir);
    const plan = makePlan({
      worktree: worktree.dir,
      steps: [{ step: 'implement', contract_id: 'step.output', phase: 'implementation' }],
    });

    /**
     * An ignored path, written before the run and read back directly afterwards.
     *
     * `clean` is deliberately given `-fd` and **not** `-x`: ignored paths — `node_modules`, build caches,
     * the runtime paths the installer adds to `.gitignore` — are not a step's effects, and destroying them
     * would turn every re-run into a cold rebuild. The omission is invisible to `listing()`, which uses
     * `--exclude-standard` and so by construction cannot see an ignored path, so this is asserted with a
     * direct read.
     */
    worktree.write('ignored-cache/build.log', 'expensive to rebuild\n');
    expect(worktree.listing()).not.toContain('ignored-cache/build.log');

    let attempt = 0;
    const { reconciler } = openReconciler({
      plan,
      // The real resetter against a real repository: a doubled effect is only observable there, and a
      // recording double would report two resets while the worktree carried three copies of the edit.
      baseline: gitBaselineResetter,
      script: {
        onStart: (request) => {
          attempt += 1;
          // The step's effects: one new untracked file, and an edit to a tracked one. Appending rather
          // than overwriting is deliberate — a missing reset would show as a doubled line.
          const existing = worktree.read('src/existing.ts') ?? '';
          worktree.write('src/existing.ts', `${existing}export const added = ${String(attempt)};\n`);
          worktree.write('src/created.ts', `export const created = ${String(attempt)};\n`);
          return attempt < 3
            ? terminated(request.step, 'failed', { error: makeError('step.timed_out', 'slow') })
            : terminated(request.step, 'completed');
        },
      },
    });

    const accepted = reconciler.acceptFeature(plan);
    reconciler.confirm(accepted.run);
    await reconciler.runUntilSettled();

    expect(attempt).toBe(3);
    // Three attempts, each from the same baseline: exactly one `added` line, not three.
    const contents = worktree.read('src/existing.ts') ?? '';
    expect(contents.match(/export const added/g)).toHaveLength(1);
    expect(contents).toContain('export const added = 3;');
    expect(worktree.read('src/created.ts')).toBe('export const created = 3;\n');
    expect(worktree.listing()).toStrictEqual(['.gitignore', 'src/created.ts', 'src/existing.ts']);
    // Two resets later, the ignored path is still there. `clean -fdx` would have removed it.
    expect(worktree.read('ignored-cache/build.log')).toBe('expensive to rebuild\n');

    const record = reconciler.load(accepted.run).state.steps[0];
    expect(record?.baseline_ref).toBe(worktree.head);
    expect(record?.attempts).toBe(3);
    expect(record?.resets).toBe(2);
  });

  it('records the baseline once and never moves it between attempts', async () => {
    const resetter = createRecordingResetter(BASELINE);
    let attempt = 0;
    const { reconciler, executor } = openReconciler({
      baseline: resetter,
      script: {
        onStart: (request) => {
          attempt += 1;
          return attempt < 3
            ? terminated(request.step, 'failed', { error: makeError('step.spawn_failed', 'no') })
            : terminated(request.step, 'completed');
        },
      },
    });
    const accepted = reconciler.acceptFeature(makePlan());
    reconciler.confirm(accepted.run);
    await reconciler.runUntilSettled();

    // Every attempt was handed the same ref, and every reset targeted it.
    const refs = new Set(executor.started.map((request) => request.baselineRef));
    expect([...refs]).toStrictEqual([BASELINE]);
    expect(resetter.resets.every((reset) => reset.ref === BASELINE)).toBe(true);
  });
});

describe('the run id and the baseline ref survive a round trip through the log', () => {
  it('reads both back from the envelope, where the AD-21 pass leaves them intact', async () => {
    const { reconciler } = openReconciler({ script: alwaysCompletes });
    const accepted = reconciler.acceptFeature(makePlan());
    reconciler.confirm(accepted.run);
    await reconciler.runUntilSettled();

    const log = readEventLog(runPaths(accepted.run, home).eventLog);
    expect(log.length).toBeGreaterThan(0);

    // The run id is an unbroken 26-character ULID and the ref an unbroken 40-character SHA: both read as
    // high-entropy secret material to the pass, and both are preserved by the declared field allow-list.
    for (const event of log) {
      expect(event.run).toBe(accepted.run);
      expect(event.run).not.toContain('[redacted]');
      expect(event.feature).toBe('engine-reconciler');
    }
    const started = log.filter((event) => event.type === ENGINE_EVENT_TYPES.StepStarted);
    expect(started.length).toBeGreaterThan(0);
    for (const event of started) expect(event.baseline_ref).toBe(BASELINE);

    // And the fold reads them back, which is what the checkpoint rebuild depends on.
    for (const record of reconciler.load(accepted.run).state.steps) {
      expect(record.baseline_ref).toBe(BASELINE);
    }
  });

  it('keeps every payload field the fold reads intact, none replaced by a marker', async () => {
    const { reconciler } = openReconciler({ script: alwaysCompletes });
    const accepted = reconciler.acceptFeature(makePlan());
    reconciler.confirm(accepted.run);
    await reconciler.runUntilSettled();

    const started = readEventLog(runPaths(accepted.run, home).eventLog).find(
      (event) => event.type === ENGINE_EVENT_TYPES.StepStarted,
    );
    // Payloads carry only short, punctuated, low-entropy values for exactly this reason.
    expect(started?.payload).toStrictEqual({
      attempt: 1,
      phase: 'implementation',
      contract_id: 'step.output',
      model_tier: 'claude-haiku-4-5',
      mode: 'live',
      input: 'steps/implement/input.json',
    });
  });

  it('emits every event through the recorder, with the engine as the emitter', async () => {
    const { reconciler } = openReconciler({ script: alwaysCompletes });
    const accepted = reconciler.acceptFeature(makePlan());
    reconciler.confirm(accepted.run);
    await reconciler.runUntilSettled();

    const log = readEventLog(runPaths(accepted.run, home).eventLog);
    for (const [index, event] of log.entries()) {
      // `seq` is the recorder's alone, 1..n with no gaps — evidence the engine went through it.
      expect(event.seq).toBe(index + 1);
      expect(event.emitter).toBe(ENGINE_EMITTER);
    }
  });
});

describe('reconciliation is concurrent across features and serialised on overlap', () => {
  it('advances only one of two features whose territories overlap', async () => {
    // Separate worktrees, so the *declared territory* is the only thing that can serialise these two.
    const overlappingA = makePlan({ feature: 'alpha', territory: ['src/engine'], worktree: '/tmp/wt-alpha' });
    const overlappingB = makePlan({
      feature: 'beta',
      territory: ['src/engine/lock.ts'],
      worktree: '/tmp/wt-beta',
    });
    const reconciler = Reconciler.open({
      orchHome: home,
      executor: createScriptedExecutor(alwaysCompletes),
      plans: planProvider(overlappingA, overlappingB),
      baseline: createRecordingResetter(BASELINE),
    });
    toClose.push(reconciler);

    const first = reconciler.acceptFeature(overlappingA);
    const second = reconciler.acceptFeature(overlappingB);
    reconciler.confirm(first.run);
    reconciler.confirm(second.run);

    const result = await reconciler.pass();
    expect(result.actions).toHaveLength(1);
    expect(result.deferred).toHaveLength(1);
    // The older run holds the territory, so the winner is the same on every pass and after a restart.
    expect(result.actions[0]?.run).toBe(first.run);
    expect(result.deferred[0]?.run).toBe(second.run);
    expect(result.deferred[0]?.overlap).toStrictEqual(['src/engine/lock.ts']);

    // The deferred feature has taken no step at all while the other holds the territory.
    expect(reconciler.load(second.run).state.steps).toStrictEqual([]);
  });

  it('lets the serialised feature advance once the first run reaches a terminal state', async () => {
    const overlappingA = makePlan({ feature: 'alpha', territory: ['src/engine'], worktree: '/tmp/wt-alpha' });
    const overlappingB = makePlan({
      feature: 'beta',
      territory: ['src/engine/lock.ts'],
      worktree: '/tmp/wt-beta',
    });
    const reconciler = Reconciler.open({
      orchHome: home,
      executor: createScriptedExecutor(alwaysCompletes),
      plans: planProvider(overlappingA, overlappingB),
      baseline: createRecordingResetter(BASELINE),
    });
    toClose.push(reconciler);

    const first = reconciler.acceptFeature(overlappingA);
    const second = reconciler.acceptFeature(overlappingB);
    reconciler.confirm(first.run);
    reconciler.confirm(second.run);

    await reconciler.runUntilSettled();
    expect(reconciler.load(first.run).state.state).toBe('committed');
    expect(reconciler.load(second.run).state.state).toBe('committed');
  });

  it('serialises two features sharing one worktree, however disjoint their declared territories', async () => {
    /**
     * A declared territory says which files a feature means to change; the worktree says what it can
     * destroy. A re-run resets its worktree with `reset --hard` plus `clean -fd`, which discards the other
     * feature's work wholesale — so only the worktree bounds the conflict domain of a reset, and two
     * features cannot hold one at the same time no matter how disjoint their file lists are.
     */
    const shared = '/tmp/wt-shared';
    const left = makePlan({ feature: 'alpha', territory: ['src/engine'], worktree: shared });
    const right = makePlan({ feature: 'beta', territory: ['docs/specs'], worktree: shared });
    const reconciler = Reconciler.open({
      orchHome: home,
      executor: createScriptedExecutor(alwaysCompletes),
      plans: planProvider(left, right),
      baseline: createRecordingResetter(BASELINE),
    });
    toClose.push(reconciler);

    const first = reconciler.acceptFeature(left);
    const second = reconciler.acceptFeature(right);
    reconciler.confirm(first.run);
    reconciler.confirm(second.run);

    const result = await reconciler.pass();
    expect(result.actions).toHaveLength(1);
    expect(result.actions[0]?.run).toBe(first.run);
    expect(result.deferred).toHaveLength(1);
    expect(result.deferred[0]?.overlap).toStrictEqual([shared]);
    expect(result.deferred[0]?.reason).toContain('One worktree admits one feature at a time');
  });

  it('advances two features with disjoint territories in the same pass', async () => {
    const left = makePlan({ feature: 'alpha', territory: ['src/engine'], worktree: '/tmp/wt-alpha' });
    const right = makePlan({ feature: 'beta', territory: ['docs/specs'], worktree: '/tmp/wt-beta' });
    const reconciler = Reconciler.open({
      orchHome: home,
      executor: createScriptedExecutor(alwaysCompletes),
      plans: planProvider(left, right),
      baseline: createRecordingResetter(BASELINE),
    });
    toClose.push(reconciler);

    const first = reconciler.acceptFeature(left);
    const second = reconciler.acceptFeature(right);
    reconciler.confirm(first.run);
    reconciler.confirm(second.run);

    const result = await reconciler.pass();
    expect(result.actions).toHaveLength(2);
    expect(result.deferred).toStrictEqual([]);
    expect(result.actions.map((action) => action.run).sort()).toStrictEqual(
      [first.run, second.run].sort(),
    );
  });
});

describe('a declared failure routes through the table instead of escaping the pass', () => {
  it('routes a rejected spawn as the termination its code describes, and the pass survives', async () => {
    /**
     * `step.started` is already in the log when the port rejects. Letting the rejection propagate would
     * kill the whole pass and leave the step recorded as in flight, so the next pass would adopt it as
     * `interrupted`, re-run it and fail identically — a non-terminating loop built out of a code the AD-35
     * table answers perfectly well.
     */
    expect(dispositionFor('step.spawn_failed')).toBe('retry-with-backoff');
    const resetter = createRecordingResetter(BASELINE);
    let attempts = 0;
    const { reconciler, executor } = openReconciler({
      baseline: resetter,
      script: {
        onStart: (request) => {
          attempts += 1;
          if (attempts === 1) throw new StepSpawnFailed(request.step, 'no executable on PATH');
          return terminated(request.step, 'completed');
        },
      },
    });
    const accepted = reconciler.acceptFeature(makePlan());
    reconciler.confirm(accepted.run);

    // The pass resolves rather than rejecting, and reports the action it took.
    const first = await reconciler.pass();
    expect(first.refusals).toStrictEqual([]);
    expect(first.actions[0]?.kind).toBe('run-step');

    const failed = reconciler.load(accepted.run).state.steps[0];
    expect(failed?.disposition).toBe('failed');
    expect(failed?.error?.code).toBe('step.spawn_failed');

    // Retried through AD-26: reset to the baseline, then re-run from the typed input.
    await reconciler.runUntilSettled();
    expect(resetter.resets.map((reset) => reset.ref)).toContain(BASELINE);
    expect(executor.started.length).toBeGreaterThan(1);
    expect(reconciler.load(accepted.run).state.state).toBe('committed');
  });

  it('hands off a rejection carrying no declared code, and never retries it', async () => {
    const resetter = createRecordingResetter(BASELINE);
    const { reconciler, executor } = openReconciler({
      baseline: resetter,
      script: {
        onStart: () => {
          throw new Error('something the port never declared');
        },
      },
    });
    const accepted = reconciler.acceptFeature(makePlan());
    reconciler.confirm(accepted.run);
    await reconciler.runUntilSettled();

    const state = reconciler.load(accepted.run).state;
    expect(state.state).toBe('handed_off');
    expect(state.handoff?.code).toBe('internal.invariant_violated');
    // Handed off, not retried: one attempt, no reset.
    expect(executor.started).toHaveLength(1);
    expect(resetter.resets).toStrictEqual([]);
  });

  it('hands off when the worktree cannot be returned to the step baseline', async () => {
    /**
     * AD-26 makes the reset the precondition of a re-run, and `git.baseline_reset_failed` is declared
     * `abandon-and-hand-off` precisely so a worktree of unknown shape is never re-run into.
     */
    expect(dispositionFor('git.baseline_reset_failed')).toBe('abandon-and-hand-off');
    const refusingResetter = {
      currentRef: (): string => BASELINE,
      resetTo: (worktree: string, ref: string): void => {
        throw new BaselineResetError(worktree, ref, 'another process holds the index lock');
      },
    };
    const { reconciler } = openReconciler({
      baseline: refusingResetter,
      script: {
        onStart: (request) =>
          terminated(request.step, 'failed', { error: makeError('step.timed_out', 'slow') }),
      },
    });
    const accepted = reconciler.acceptFeature(makePlan());
    reconciler.confirm(accepted.run);

    const taken = await reconciler.runUntilSettled();
    expect(taken.map((action) => action.kind)).toContain('reset-and-rerun');

    const state = reconciler.load(accepted.run).state;
    expect(state.state).toBe('handed_off');
    expect(state.handoff?.code).toBe('git.baseline_reset_failed');
    expect(state.handoff?.reason).toContain('index lock');
    // The re-run never happened: the step was not started a second time against a worktree of unknown shape.
    expect(state.steps[0]?.attempts).toBe(1);
  });

  it('abandons an action whose event the redaction pass dropped, rather than performing it unrecorded', async () => {
    /**
     * AD-21 fails closed, so an unredactable line is replaced by `redaction.failed` — and the fold then
     * cannot see the action at all. Proceeding would leave the loop re-deciding the same action forever
     * against a log that never remembers it. Reached here by registering a literal that appears in the
     * serialised `step.terminated` line, which is the one part of an engine event a caller can predict.
     */
    const { reconciler } = openReconciler({
      redaction: { secrets: ['"disposition":"completed"'] },
      script: alwaysCompletes,
    });
    const accepted = reconciler.acceptFeature(makePlan());
    reconciler.confirm(accepted.run);

    const result = await reconciler.pass();
    expect(result.actions).toStrictEqual([]);
    expect(result.refusals).toHaveLength(1);
    expect(result.refusals[0]?.run).toBe(accepted.run);
    expect(result.refusals[0]?.code).toBe('redaction.failed');
    // The step is left recorded as in flight, which the next pass adopts as an interruption — the
    // honest outcome, and not a completion the log never recorded.
    expect(reconciler.load(accepted.run).state.steps[0]?.disposition).toBeNull();
  });

  it('routes the earliest unrouted failure, not merely the last record', async () => {
    /**
     * A failed step followed in the record by a completed one. Taking the last record would leave the
     * earlier failure unrouted, and the fall-through would then pick that same step as "the next step with
     * no completed record" and start it again — a re-run with no baseline reset, forever.
     */
    const first = openReconciler({ script: alwaysCompletes });
    const accepted = first.reconciler.acceptFeature(makePlan());
    first.reconciler.confirm(accepted.run);
    first.reconciler.close();

    const recorder = Recorder.open({ runId: accepted.run, feature: 'engine-reconciler', orchHome: home });
    const line = (step: string, type: string, payload: Record<string, unknown>): void => {
      recorder.record({
        feature: 'engine-reconciler',
        run: accepted.run,
        step,
        emitter: 'engine.reconciler',
        type,
        payload,
        baseline_ref: BASELINE,
      });
    };
    line('implement', ENGINE_EVENT_TYPES.StepStarted, {
      attempt: 1,
      phase: 'implementation',
      contract_id: 'step.output',
      model_tier: 'claude-haiku-4-5',
      mode: 'live',
      input: 'steps/implement/input.json',
    });
    line('implement', ENGINE_EVENT_TYPES.StepTerminated, {
      disposition: 'failed',
      error: makeError('step.timed_out', 'slow'),
    });
    line('verify', ENGINE_EVENT_TYPES.StepStarted, {
      attempt: 1,
      phase: 'verification',
      contract_id: 'step.output',
      model_tier: 'claude-haiku-4-5',
      mode: 'live',
      input: 'steps/verify/input.json',
    });
    // A *second* unrouted failure, later in the record. Two are needed for this test to discriminate:
    // with only one, "the earliest" and "the last" name the same record and the assertion proves nothing.
    line('verify', ENGINE_EVENT_TYPES.StepTerminated, {
      disposition: 'failed',
      error: makeError('step.verification_failed', 'the gate failed'),
    });
    recorder.close();

    const resetter = createRecordingResetter(BASELINE);
    const { reconciler } = openReconciler({ baseline: resetter, script: alwaysCompletes });
    const action = await reconciler.advance(accepted.run);

    // The earliest failure is routed. `verify` fails later in the list and would win if the router took
    // the last record — leaving `implement`'s failure never routed, and re-run without a baseline reset
    // by the fall-through that picks the first step with no completed record.
    expect(action.kind).toBe('reset-and-rerun');
    expect(action.step).toBe('implement');
    expect(action.reason).toContain('step.timed_out');
    expect(resetter.resets).toStrictEqual([{ worktree: makePlan().worktree, ref: BASELINE }]);
  });
});

describe('a steering command is refused once the run is past taking it', () => {
  const settled = async (): Promise<{ readonly reconciler: Reconciler; readonly run: string }> => {
    const { reconciler } = openReconciler({ script: alwaysCompletes });
    const accepted = reconciler.acceptFeature(makePlan());
    reconciler.confirm(accepted.run);
    await reconciler.runUntilSettled();
    expect(reconciler.load(accepted.run).state.state).toBe('committed');
    return { reconciler, run: accepted.run };
  };

  it('refuses to confirm a terminal run, rather than walking it back to running', async () => {
    const { reconciler, run } = await settled();
    expect(() => reconciler.confirm(run)).toThrowError(SteeringRefused);
    expect(reconciler.load(run).state.state).toBe('committed');
  });

  it('refuses to approve a terminal run', async () => {
    const { reconciler, run } = await settled();
    expect(() => reconciler.approve(run)).toThrowError(SteeringRefused);
    expect(reconciler.load(run).state.state).toBe('committed');
  });

  it('refuses to kill a terminal run', async () => {
    const { reconciler, run } = await settled();
    expect(() => reconciler.kill(run)).toThrowError(SteeringRefused);
    expect(reconciler.load(run).state.state).toBe('committed');
  });

  it('refuses to approve a killed run, so a killed step is never resurrected', async () => {
    const first = openReconciler({ script: alwaysCompletes });
    const accepted = first.reconciler.acceptFeature(makePlan());
    first.reconciler.confirm(accepted.run);
    first.reconciler.close();
    appendOrphanedStart(accepted.run, 'engine-reconciler', 'implement', 'sess-implement');

    const { reconciler, executor } = openReconciler({ script: alwaysCompletes });
    reconciler.kill(accepted.run);

    // AD-8 twice over: the state refuses the command, and the step record is never rewritten.
    expect(() => reconciler.approve(accepted.run)).toThrowError(SteeringRefused);
    expect(reconciler.load(accepted.run).state.steps[0]?.disposition).toBe('killed');
    await reconciler.pass();
    expect(executor.started).toStrictEqual([]);
    expect(executor.resumed).toStrictEqual([]);
  });

  it('refuses an approve for a run with no gate to approve, and rewrites no step', async () => {
    /**
     * CAP-2 — `confirm_spec` is the only gate into execution, and `approve` answers CAP-12's blocked gate.
     *
     * A run that is merely `running` has no gate to approve, so the command is refused rather than moving
     * the run. Without this guard `approve` returned `toState: 'running'` for *any* non-terminal state, so
     * an approve on a `drafting` run put a feature whose acceptance criteria were never confirmed straight
     * into execution — a second, unguarded way in, past the one gate CAP-2 has.
     *
     * The original assertions stand and say more than they did: no `step.approved` line exists, and the
     * step the approval would have targeted is still exactly as it was recorded.
     */
    const { reconciler } = openReconciler({ script: alwaysCompletes });
    const accepted = reconciler.acceptFeature(makePlan());
    reconciler.confirm(accepted.run);
    await reconciler.pass();
    expect(reconciler.load(accepted.run).state.state).toBe('running');

    expect(() => reconciler.approve(accepted.run)).toThrowError(SteeringRefused);
    expect(eventTypes(accepted.run)).not.toContain(ENGINE_EVENT_TYPES.StepApproved);
    expect(reconciler.load(accepted.run).state.steps[0]?.disposition).toBe('completed');
    expect(reconciler.load(accepted.run).state.state).toBe('running');
  });
});

describe('one unreadable run does not stop every other feature', () => {
  it('reports a refusal for a run whose checkpoint version it cannot read, and advances the rest', async () => {
    const healthy = makePlan({ feature: 'alpha', territory: ['src/alpha'], worktree: '/tmp/wt-alpha' });
    const broken = makePlan({ feature: 'beta', territory: ['src/beta'], worktree: '/tmp/wt-beta' });
    const reconciler = Reconciler.open({
      orchHome: home,
      executor: createScriptedExecutor(alwaysCompletes),
      plans: planProvider(healthy, broken),
      baseline: createRecordingResetter(BASELINE),
    });
    toClose.push(reconciler);

    const good = reconciler.acceptFeature(healthy);
    const bad = reconciler.acceptFeature(broken);
    reconciler.confirm(good.run);
    reconciler.confirm(bad.run);

    // A `state.json` this build does not recognise: AD-28 refuses it, per artifact.
    const statePath = join(runPaths(bad.run, home).runDir, RUN_STATE_FILE_NAME);
    const real = JSON.parse(readFileSync(statePath, 'utf8')) as Record<string, unknown>;
    writeFileSync(statePath, JSON.stringify({ ...real, schema_version: 99 }), 'utf8');

    const result = await reconciler.pass();
    expect(result.refusals).toHaveLength(1);
    expect(result.refusals[0]?.run).toBe(bad.run);
    expect(result.refusals[0]?.code).toBe('config.schema_version_unrecognised');
    // The healthy feature advanced in the same pass. "Never continue a run whose log the reader
    // refuses" is per run, not per engine.
    expect(result.actions).toHaveLength(1);
    expect(result.actions[0]?.run).toBe(good.run);
    expect(reconciler.load(good.run).state.steps[0]?.disposition).toBe('completed');
  });

  it('steps over a run directory holding neither a log nor a checkpoint', async () => {
    const { reconciler } = openReconciler({ script: alwaysCompletes });
    const accepted = reconciler.acceptFeature(makePlan());
    reconciler.confirm(accepted.run);

    // What a crash between creating the directory and recording run.created leaves behind. It carries no
    // state and no feature, so a pass must step over it — for ever, not once.
    mkdirSync(join(runsDir(home), '01K5NQ9ZJ7V3M2P9XQWRTC4BDE'), { recursive: true });

    for (let index = 0; index < 3; index += 1) {
      const result = await reconciler.pass();
      expect(result.refusals).toStrictEqual([]);
    }
    expect(reconciler.load(accepted.run).state.state).toBe('committed');
  });

  it('does not let a feature awaiting confirmation hold its territory', async () => {
    /**
     * An inert action performs no worktree I/O, so it cannot conflict with anything. If it contended, a
     * feature parked in `drafting` would hold its whole territory for as long as the user took to confirm
     * and every overlapping feature would wait behind it indefinitely.
     */
    const waiting = makePlan({ feature: 'alpha', territory: ['src/engine'], worktree: '/tmp/wt-alpha' });
    const working = makePlan({
      feature: 'beta',
      territory: ['src/engine/lock.ts'],
      worktree: '/tmp/wt-beta',
    });
    const reconciler = Reconciler.open({
      orchHome: home,
      executor: createScriptedExecutor(alwaysCompletes),
      plans: planProvider(waiting, working),
      baseline: createRecordingResetter(BASELINE),
    });
    toClose.push(reconciler);

    // The older run is left unconfirmed, so it is the one that would hold the territory.
    const parked = reconciler.acceptFeature(waiting);
    const active = reconciler.acceptFeature(working);
    reconciler.confirm(active.run);

    const result = await reconciler.pass();
    expect(result.deferred).toStrictEqual([]);
    expect(result.actions.map((action) => action.kind).sort()).toStrictEqual([
      'await-confirmation',
      'run-step',
    ]);
    expect(reconciler.load(active.run).state.steps).toHaveLength(1);
    expect(reconciler.load(parked.run).state.state).toBe('drafting');
  });
});

describe('the checkpoint is discarded and rebuilt when it disagrees with the log', () => {
  it('reports the rebuild and acts from the log’s version, not the checkpoint’s', async () => {
    const { reconciler } = openReconciler({ script: alwaysCompletes });
    const accepted = reconciler.acceptFeature(makePlan());
    reconciler.confirm(accepted.run);
    await reconciler.pass();

    // Hand-write a checkpoint claiming the whole run is done, which the log does not support.
    const statePath = join(runPaths(accepted.run, home).runDir, RUN_STATE_FILE_NAME);
    const real = JSON.parse(readFileSync(statePath, 'utf8')) as Record<string, unknown>;
    const { writeFileSync: write } = await import('node:fs');
    write(statePath, JSON.stringify({ ...real, state: 'committed' }), 'utf8');

    const action = await reconciler.advance(accepted.run);
    expect(action.checkpointRebuilt).toBe(true);
    expect(action.disagreements.map((entry) => entry.field)).toContain('state');
    // The log said `running` with `implement` complete, so the next action is the verification step —
    // not the nothing a `committed` checkpoint would have implied.
    expect(action.kind).toBe('run-step');
    expect(action.step).toBe('verify');
  });

  it('rebuilds from the log when the checkpoint has been deleted entirely', async () => {
    const { reconciler } = openReconciler({ script: alwaysCompletes });
    const accepted = reconciler.acceptFeature(makePlan());
    reconciler.confirm(accepted.run);
    await reconciler.pass();

    const statePath = join(runPaths(accepted.run, home).runDir, RUN_STATE_FILE_NAME);
    rmSync(statePath);

    const reloaded = reconciler.load(accepted.run);
    expect(reloaded.checkpointRebuilt).toBe(true);
    expect(reloaded.state.state).toBe('running');
    expect(reloaded.state.steps[0]?.disposition).toBe('completed');
    await reconciler.runUntilSettled();
    expect(reconciler.load(accepted.run).state.state).toBe('committed');
  });
});

describe('AD-30 — one engine per ORCH_HOME, enforced by the reconciler itself', () => {
  it('refuses a second reconciler against the same home', () => {
    openReconciler({ script: alwaysCompletes });
    expect(() =>
      Reconciler.open({
        orchHome: home,
        executor: createScriptedExecutor(alwaysCompletes),
        plans: planProvider(makePlan()),
      }),
    ).toThrowError(/AD-30/);
  });

  it('releases the lock on close, so the next engine starts', () => {
    const { reconciler } = openReconciler({ script: alwaysCompletes });
    reconciler.close();
    const second = Reconciler.open({
      orchHome: home,
      executor: createScriptedExecutor(alwaysCompletes),
      plans: planProvider(makePlan()),
    });
    toClose.push(second);
    expect(second.lock?.isHeld).toBe(true);
  });

  it('refuses to act after close', async () => {
    const { reconciler } = openReconciler({ script: alwaysCompletes });
    reconciler.close();
    await expect(reconciler.pass()).rejects.toThrowError(/released its ORCH_HOME lock/);
  });
});

describe('the dependency direction is fixed', () => {
  const engineDir = new URL('../src/engine/', import.meta.url);
  const files = readdirSync(engineDir).filter((name) => name.endsWith('.ts'));

  const IMPORT_PATTERNS = [
    /^\s*(?:import|export)\b[^'";]*\bfrom\s*['"]([^'"]+)['"]/gm,
    /^\s*import\s*['"]([^'"]+)['"]/gm,
    /\bimport\s*\(\s*['"]([^'"]+)['"]/g,
    /\brequire\s*\(\s*['"]([^'"]+)['"]/g,
  ];

  const importsOf = (source: string): string[] =>
    IMPORT_PATTERNS.flatMap((pattern) =>
      [...source.matchAll(pattern)].map((match) => match[1] ?? ''),
    );

  /**
   * Comments are stripped before the structural greps below.
   *
   * These modules explain *why* they never open the log and *why* the resume flag is story 1-4's, so a
   * naive grep matches its own documentation. The claim is about code, so the check is about code.
   */
  const codeOf = (file: string): string =>
    readFileSync(new URL(file, engineDir), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^[ \t]*\/\/.*$/gm, '');

  it('has source files to inspect, and reads the imports it claims to', () => {
    expect(files.length).toBeGreaterThan(0);
    const source = readFileSync(new URL('reconciler.ts', engineDir), 'utf8');
    expect(importsOf(source)).toContain('../contracts/index.js');
    expect(importsOf(source)).toContain('../runtime/index.js');
    expect(importsOf(source)).toContain('node:fs');
  });

  it.each(files)('%s imports only src/contracts/, src/runtime/ and node: builtins', (file) => {
    const source = readFileSync(new URL(file, engineDir), 'utf8');
    for (const specifier of importsOf(source)) {
      if (!specifier.startsWith('.')) {
        expect(specifier.startsWith('node:'), `${file} imports "${specifier}"`).toBe(true);
        continue;
      }
      if (specifier.startsWith('../')) {
        expect(
          specifier.startsWith('../contracts/') || specifier.startsWith('../runtime/'),
          `${file} imports "${specifier}"`,
        ).toBe(true);
        continue;
      }
      expect(specifier.startsWith('./'), `${file} imports "${specifier}"`).toBe(true);
      expect(specifier.slice(2)).not.toContain('/');
    }
  });

  it('reads the code it claims to inspect, with comments stripped', () => {
    const code = codeOf('rebuild.ts');
    // The docblock names events.jsonl; the code does not. If stripping ever broke, this fails first.
    expect(code).not.toContain('events.jsonl');
    expect(code).toContain('rebuildFromLog');
  });

  it.each(files)('%s never opens events.jsonl itself', (file) => {
    // AD-29 gives the log one writer and one `seq` assigner. The engine emits through the recorder, so
    // no engine file names the log file, reaches for its lock, or touches its path except to hand it to
    // the runtime's own reader — reading the durable truth is the point; writing it is not the engine's.
    const code = codeOf(file);
    expect(code, file).not.toContain('events.jsonl');
    expect(code, file).not.toContain('EVENT_LOG_FILE_NAME');
    expect(code, file).not.toContain('EVENT_LOG_LOCK_FILE_NAME');
    expect(code.replace(/readEventLog\([^)]*\)/g, ''), file).not.toContain('eventLog');
  });

  it.each(files)('%s writes no diagnostics to stdout', (file) => {
    const code = codeOf(file);
    expect(code, file).not.toContain('process.stdout');
    expect(code, file).not.toMatch(/\bconsole\.\w+\(/);
  });

  /**
   * The four files story 1-4 added, which are the spawn contract and are *supposed* to name its flags.
   *
   * Story 1-3 asserted that no engine file named a `claude -p` flag, which proved that story had not
   * quietly started doing story 1-4's job. Now that 1-4 has landed, the claim worth holding is the
   * narrower one it was always standing in for: the *loop* and the *port* still know nothing about
   * process handling, so the reconciler was not edited to fit the executor. Exempting these four by
   * name keeps that check sharp on every other file rather than deleting it.
   */
  const SPAWN_CONTRACT_FILES = ['cli.ts', 'node-path.ts', 'stream.ts', 'spawner.ts'];

  it('keeps the loop and the port free of process handling', () => {
    for (const file of files) {
      if (SPAWN_CONTRACT_FILES.includes(file)) continue;
      // `baseline.ts` runs `git`, which is the one AD-26 mutation the loop performs; nothing else in
      // the engine outside the spawn contract spawns `claude`, passes `--resume` or names a model flag.
      const code = codeOf(file);
      expect(code, file).not.toContain('--resume');
      expect(code, file).not.toContain('--json-schema');
      expect(code, file).not.toContain('stream-json');
      expect(code, file).not.toMatch(/['"]claude['"]/);
    }
  });

  it('has a spawn contract to exempt, and exempts nothing that does not exist', () => {
    // A stale exemption would silently switch the check off for a file that had been renamed away.
    for (const file of SPAWN_CONTRACT_FILES) expect(files, file).toContain(file);
  });

  it('leaves the container boundary to AD-20\'s single wrapper', () => {
    // AD-20 gives one wrapper sole ownership of every container flag, and that wrapper is story 1-5.
    // Asserted over the whole file, comments included: a prose mention is how a flag gets composed
    // here "just for now", and the spawner's seam means nothing if the runtime is named beside it.
    for (const file of files) {
      const source = readFileSync(new URL(file, engineDir), 'utf8');
      expect(source.toLowerCase(), file).not.toContain('docker');
    }
  });

  it('reports a refused resume as an exception rather than a step failure', async () => {
    const refusal = new ResumeRefused('implement', 'sess-implement', 'the session is gone');
    expect(refusal.code).toBe('step.resume_failed');
    await expect(Promise.reject(refusal)).rejects.toBeInstanceOf(ResumeRefused);
  });
});

/**
 * Matrix 31 — an unplaceable rung reaches a person, and does not escape the pass.
 *
 * `rungForAttempt` refuses a rung the build cannot place rather than clamping it to the cheapest, which
 * is right — and it refuses by throwing, from inside `driveStep`, where neither call site caught it. An
 * uncaught throw there does not just fail this feature: `pass` is how *every* feature advances, so one
 * corrupt declaration would take every other feature's pass down with it, with nothing recorded to say
 * why. The baseline reset a few lines below has always been wrapped for exactly this reason.
 *
 * `config.invalid` is `escalate-to-human` in the AD-35 table, so the feature blocks and waits.
 */
describe('a rung the build cannot place blocks the feature rather than crashing the pass', () => {
  const UNPLACEABLE = 'claude-sonnet-4-5';

  it('records the refusal and blocks, leaving the pass able to return', async () => {
    const { reconciler } = openReconciler({
      plan: makePlan({ starting_model_tier: UNPLACEABLE as ModelRung }),
      script: alwaysCompletes,
    });
    const accepted = reconciler.acceptFeature(makePlan({ starting_model_tier: UNPLACEABLE as ModelRung }));
    reconciler.confirm(accepted.run);

    // The pass returns rather than throwing, which is the whole of the row.
    await expect(reconciler.pass()).resolves.toBeDefined();

    const state = reconciler.load(accepted.run).state;
    expect(state.state).toBe('blocked');
    // Nothing was spawned on a rung nobody can place.
    expect(state.steps).toStrictEqual([]);
    // And the reason names the rung and the ladder, so a person can fix the declaration.
    const reasons = readEventLog(runPaths(accepted.run, home).eventLog)
      .filter((event) => event.type === ENGINE_EVENT_TYPES.FeatureStateChanged)
      .map((event) => (typeof event.payload['reason'] === 'string' ? event.payload['reason'] : ''));
    expect(reasons.join(' ')).toContain(UNPLACEABLE);
    expect(dispositionFor('config.invalid')).toBe('escalate-to-human');
  });

  it('runs the same plan normally once the rung is one the ladder holds', async () => {
    // The positive control: the refusal above is about the value, not about this fixture.
    const { reconciler } = openReconciler({ script: alwaysCompletes });
    const accepted = reconciler.acceptFeature(makePlan());
    reconciler.confirm(accepted.run);
    await reconciler.pass();

    expect(reconciler.load(accepted.run).state.steps[0]?.model_tier).toBe('claude-haiku-4-5');
  });
});

// -------------------------------------------------------------------------------------------------
// Story 2-11 — `awaiting_merge` and the bounded per-pass merge check (matrix rows 1, 4, 5, 7)
// -------------------------------------------------------------------------------------------------

/**
 * A committing step's output, exactly as `tests/engine.committer.test.ts` composes one: prose only, no
 * step disposition of its own — the engine supplies the record, per story 2-7.
 */
const committingOutput = (step: string): Record<string, unknown> => ({
  contract_id: 'step.committing',
  step,
  status: 'completed',
  summary: 'Composed the pull-request prose.',
  provenance: ['commit: src/engine/committer.ts'],
  decisions: [],
  artifacts: [],
  questions: [],
  write_intents: [],
  error: null,
  pull_request_title: 'Write surface: awaiting_merge and the bounded check',
  pull_request_body: 'The write executor lands the push and pull request; the engine waits for the merge.',
});

/** Every phase completes on its first attempt; the committing phase also composes real prose. */
const committingCapableScript = (): ScriptedExecutorOptions => ({
  onStart: (request) => {
    if (request.phase !== 'committing') return terminated(request.step, 'completed', {});
    const raw = committingOutput(request.step);
    return terminated(request.step, 'completed', {
      output: StepOutputSchema.parse(raw),
      contractOutput: CommittingOutputSchema.parse(raw),
    });
  },
});

/** One entry per write-executor call this fixture's double received, in order. */
interface RecordedWrite {
  readonly kind: string;
  readonly mergeCommit: string | null;
}

/**
 * A write executor that never touches `git`/`gh`: it records the call and durably emits the same
 * `write.attempted`/`write.executed` pair the real one does, through the context it is handed — which is
 * what the reconciler's own durability ordering and event-log assertions below are about, not whether a
 * particular shell command ran.
 */
const recordingWriteExecutor = (writes: RecordedWrite[]): WriteExecutorPort => {
  const port: WriteExecutorPort = (intent, context) => {
    writes.push({ kind: intent.kind, mergeCommit: context.mergeCommit });
    context.emit('write.attempted', {
      intent_id: intent.intent_id,
      kind: intent.kind,
      target: intent.target,
    });
    context.emit('write.executed', {
      intent_id: intent.intent_id,
      kind: intent.kind,
      target: intent.target,
      already_present: false,
      detail: 'recorded by the test double',
    });
    return Promise.resolve({
      status: 'executed' as const,
      alreadyPresent: false,
      detail: 'recorded by the test double',
    });
  };
  return port;
};

/**
 * A write executor whose per-kind failure is a mutable set, so a test can make one kind fail and then
 * clear it, exactly as a real `git`/`gh` call recovers between reconcile passes.
 */
const flakyWriteExecutor = (): {
  readonly checker: WriteExecutorPort;
  readonly writes: RecordedWrite[];
  readonly failing: Set<string>;
} => {
  const writes: RecordedWrite[] = [];
  const failing = new Set<string>();
  const checker: WriteExecutorPort = (intent, context) => {
    writes.push({ kind: intent.kind, mergeCommit: context.mergeCommit });
    context.emit('write.attempted', { intent_id: intent.intent_id, kind: intent.kind, target: intent.target });
    if (failing.has(intent.kind)) {
      context.emit('write.failed', {
        intent_id: intent.intent_id,
        kind: intent.kind,
        target: intent.target,
        code: 'write.push_failed',
        reason: 'the test double is failing this kind for now',
      });
      return Promise.resolve({
        status: 'failed' as const,
        error: makeError('write.push_failed', 'the test double is failing this kind for now'),
      });
    }
    context.emit('write.executed', {
      intent_id: intent.intent_id,
      kind: intent.kind,
      target: intent.target,
      already_present: false,
      detail: 'recorded by the test double',
    });
    return Promise.resolve({
      status: 'executed' as const,
      alreadyPresent: false,
      detail: 'recorded by the test double',
    });
  };
  return { checker, writes, failing };
};

/** A merge checker whose answer is a mutable field, so one test can change it mid-run. */
const controllableMergeChecker = (): { readonly checker: MergeCheckPort; readonly state: { calls: number; answer: MergeCheck } } => {
  const state = { calls: 0, answer: { state: 'OPEN', mergeCommit: null } as MergeCheck };
  const checker: MergeCheckPort = () => {
    state.calls += 1;
    return Promise.resolve(state.answer);
  };
  return { checker, state };
};

/**
 * Story 4-1 — a real config snapshot whose permissions explicitly gate nothing.
 *
 * Round-1 review's row-9 fix makes an *absent* snapshot fall back to the installer's own default
 * (`irreversible` gated), so every fixture below that composes a real commit and never cared about
 * gating before this story would otherwise now block on it incidentally. This gives such a fixture an
 * explicit, present, empty `gated_reversibility_classes` — row 6's own policy — so its pre-existing
 * subject (`awaiting_merge`, a shadow run's suppression, a flaky write retrying) stays undisturbed.
 */
const ungatedConfigSnapshot = (runId: string, orchHome: string): void => {
  const repository = makeWorkspace('ungated-repo');
  toRemove.push(repository);
  // Blank mechanics commands, so CAP-13's deterministic gates are declared *none* rather than
  // dispatched to a real runner none of these fixtures wire — the same reason `buildGatedRun` blanks
  // them below; a real snapshot's own default commands would otherwise try to run for real.
  writeProfile(
    repository,
    fixtureProfile({
      mechanics: {
        package_manager: 'npm',
        commands: { test: '', typecheck: '', lint: '', build: '', run: '' },
        source_layout: ['src', 'tests'],
        resources: 'none',
      },
    }),
  );
  writePermissions(repository, fixturePermissions({ gated_reversibility_classes: [] }));
  takeConfigSnapshot({ repository, runId, orchHome });
};

describe('AD-22, AD-15 — awaiting_merge and the bounded merge check', () => {
  const buildRun = (): {
    readonly reconciler: Reconciler;
    readonly run: string;
    readonly writes: RecordedWrite[];
    readonly merge: ReturnType<typeof controllableMergeChecker>;
  } => {
    const orchHome = makeHome('awaiting-merge');
    toRemove.push(orchHome);
    const plan = makePlan({ feature: 'awaiting-merge-wiring', steps: STANDARD_PLAN_STEPS });
    const writes: RecordedWrite[] = [];
    const merge = controllableMergeChecker();
    const reconciler = Reconciler.open({
      orchHome,
      plans: planProvider(plan),
      baseline: { currentRef: () => 'a'.repeat(40), resetTo: () => undefined },
      executor: createScriptedExecutor(committingCapableScript()),
      writeExecutor: recordingWriteExecutor(writes),
      mergeChecker: merge.checker,
    });
    toClose.push(reconciler);
    const accepted = reconciler.acceptFeature(plan);
    // Story 4-1 — an ungated snapshot, so this suite's own subject (`awaiting_merge`) is undisturbed by
    // the AD-12 gate a run with no snapshot at all would now hit by default (row 9's own fallback).
    ungatedConfigSnapshot(accepted.run, orchHome);
    reconciler.confirm(accepted.run);
    return { reconciler, run: accepted.run, writes, merge };
  };

  /**
   * Analyse, plan, implement, test, verify, commit — one pass each, `STANDARD_PLAN_STEPS`'s own order —
   * then the pass that executes the pre-merge intents and transitions to `awaiting_merge`. Seven passes,
   * exactly: `tests/engine.committer.test.ts` already drives the same six steps to a completed `commit`
   * step in six, and this story adds exactly one more action (the `advance-state` that now settles the
   * write surface before it can claim `committed`).
   */
  const driveToAwaitingMerge = async (reconciler: Reconciler): Promise<void> => {
    for (let index = 0; index < 7; index += 1) await reconciler.pass();
  };

  it('lands git_push and pull_request and enters awaiting_merge, not committed (matrix row 1)', async () => {
    const { reconciler, run, writes } = buildRun();
    await driveToAwaitingMerge(reconciler);

    expect(reconciler.load(run).state.state).toBe('awaiting_merge');
    expect(writes.map((write) => write.kind)).toStrictEqual(['git_push', 'pull_request']);
    // Neither pre-merge intent ever sees a merge commit: it does not exist yet.
    expect(writes.every((write) => write.mergeCommit === null)).toBe(true);
  });

  it('makes one bounded check and writes no note while the pull request is still open (matrix row 4)', async () => {
    const { reconciler, run, writes, merge } = buildRun();
    await driveToAwaitingMerge(reconciler);
    writes.length = 0; // isolate the merge-check pass under test from the setup above

    await reconciler.pass();

    expect(merge.state.calls).toBe(1);
    expect(reconciler.load(run).state.state).toBe('awaiting_merge');
    expect(writes).toStrictEqual([]);
  });

  it('writes the note on the real merge commit and reaches committed once merged (matrix row 5)', async () => {
    const { reconciler, run, writes, merge } = buildRun();
    await driveToAwaitingMerge(reconciler);
    const mergeCommit = 'f'.repeat(40);
    merge.state.answer = { state: 'MERGED', mergeCommit };
    writes.length = 0;

    await reconciler.pass();

    expect(reconciler.load(run).state.state).toBe('committed');
    expect(writes).toStrictEqual([{ kind: 'git_note', mergeCommit }]);

    const events = readEventLog(runPaths(run, reconciler.orchHome).eventLog);
    const attempted = events.filter(
      (event) => event.type === 'write.attempted' && event.payload['kind'] === 'git_note',
    );
    const executed = events.filter(
      (event) => event.type === 'write.executed' && event.payload['kind'] === 'git_note',
    );
    expect(attempted).toHaveLength(1);
    expect(executed).toHaveLength(1);
  });

  /**
   * Story 3-3 — the trust record's one new durable fact, emitted at exactly this call site, once,
   * alongside the transition to `committed`. Fixture SHAs are real (non-repeated-character) hex, not
   * `'a'.repeat(40)`-style zero-entropy stand-ins, so these tests exercise the same AD-21 redaction path a
   * real run's payload goes through — a repeated-character fixture has zero Shannon entropy and would
   * never trip the pass, silently hiding the exact defect row 21 exists to catch.
   */
  describe('pull_request.merge_fidelity — matrix rows 12, 19, 20', () => {
    const buildMergeFidelityRun = (
      label: string,
      mergeFidelityGit: GitCall,
    ): {
      readonly reconciler: Reconciler;
      readonly run: string;
      readonly merge: ReturnType<typeof controllableMergeChecker>;
    } => {
      const orchHome = makeHome(label);
      toRemove.push(orchHome);
      const plan = makePlan({ feature: label, steps: STANDARD_PLAN_STEPS });
      const writes: RecordedWrite[] = [];
      const merge = controllableMergeChecker();
      const reconciler = Reconciler.open({
        orchHome,
        plans: planProvider(plan),
        baseline: { currentRef: () => 'a'.repeat(40), resetTo: () => undefined },
        executor: createScriptedExecutor(committingCapableScript()),
        writeExecutor: recordingWriteExecutor(writes),
        mergeChecker: merge.checker,
        mergeFidelityGit,
      });
      toClose.push(reconciler);
      const accepted = reconciler.acceptFeature(plan);
      ungatedConfigSnapshot(accepted.run, orchHome);
      reconciler.confirm(accepted.run);
      return { reconciler, run: accepted.run, merge };
    };

    /** A fake `git` covering `mergeFidelityOf`'s exact call sequence, canned per test. */
    const fakeMergeFidelityGit = (options: {
      readonly proposedHead: string;
      readonly mergeCommit: string;
      readonly mergeBase: string;
      readonly touchedPaths: readonly string[];
      readonly comparisonStdout: string;
    }): GitCall => {
      const { proposedHead, mergeCommit, mergeBase, touchedPaths, comparisonStdout } = options;
      return (args) => {
        if (args[0] === 'rev-parse' && args[1] === 'HEAD') {
          return { status: 0, stdout: `${proposedHead}\n`, stderr: '' };
        }
        if (args[0] === 'rev-parse' && args[1] === '--verify') {
          return { status: 0, stdout: `${mergeCommit}\n`, stderr: '' };
        }
        if (args[0] === 'merge-base') return { status: 0, stdout: `${mergeBase}\n`, stderr: '' };
        if (args[0] === 'diff' && args[2] === mergeBase) {
          return { status: 0, stdout: touchedPaths.length === 0 ? '' : `${touchedPaths.join('\n')}\n`, stderr: '' };
        }
        if (args[0] === 'diff' && args[2] === proposedHead) {
          return { status: 0, stdout: comparisonStdout, stderr: '' };
        }
        throw new Error(`unexpected git call in mergeFidelityOf fixture: ${args.join(' ')}`);
      };
    };

    it('records outcome: corrected when the merge commit differs on this run’s own touched path (row 12)', async () => {
      const proposedHead = 'c1de83cbc3a7312c08d943dbecc23783912b82cd';
      const mergeCommit = '2c40b18d69d0996f02eade0028dbcd0ee646ced5';
      const mergeBase = 'a9af53ccce93aa8c1025571c7500f36788fabdf9';
      const { reconciler, run, merge } = buildMergeFidelityRun(
        'merge-fidelity-corrected',
        fakeMergeFidelityGit({
          proposedHead,
          mergeCommit,
          mergeBase,
          touchedPaths: ['src/a.ts'],
          comparisonStdout: 'src/a.ts\n',
        }),
      );
      await driveToAwaitingMerge(reconciler);
      merge.state.answer = { state: 'MERGED', mergeCommit };

      await reconciler.pass();

      expect(reconciler.load(run).state.state).toBe('committed');
      const events = readEventLog(runPaths(run, reconciler.orchHome).eventLog);
      const fidelity = events.filter((event) => event.type === PULL_REQUEST_MERGE_FIDELITY_EVENT_TYPE);
      expect(fidelity).toHaveLength(1);
      // The real, non-repeated-character SHAs survive the AD-21 pass verbatim (row 21, exercised here too).
      const payload = fidelity[0]?.payload ?? {};
      expect(payload).toMatchObject({
        [PULL_REQUEST_MERGE_FIDELITY_PAYLOAD_KEYS.Outcome]: 'corrected',
        [PULL_REQUEST_MERGE_FIDELITY_PAYLOAD_KEYS.HeadRefOid]: proposedHead,
        [PULL_REQUEST_MERGE_FIDELITY_PAYLOAD_KEYS.MergeCommit]: mergeCommit,
      });
      expect(Object.keys(payload)).toHaveLength(4);
      expect(typeof payload[PULL_REQUEST_MERGE_FIDELITY_PAYLOAD_KEYS.Detail]).toBe('string');
    });

    it('records outcome: unchanged when only unrelated main drift differs, never a false correction (row 19)', async () => {
      // The touched-paths diff (mergeBase..proposedHead) says this run only ever touched `src/a.ts`. The
      // final comparison is restricted to exactly that path and finds it unchanged — so this reports
      // `unchanged` regardless of whatever else `main` picked up on other paths between fork and merge; a
      // whole-tree comparison would have had no way to tell that drift apart from a real correction.
      const proposedHead = 'e78c0692580b39a09582a11611be0e8139cdce93';
      const mergeCommit = 'e9d50f06faec4c587fb25e73cfc435ee6078c6bc';
      const mergeBase = '33c8fd427ee0179acf4234c7eaf7383fcad9d853';
      const { reconciler, run, merge } = buildMergeFidelityRun(
        'merge-fidelity-unchanged-main-drift',
        fakeMergeFidelityGit({
          proposedHead,
          mergeCommit,
          mergeBase,
          touchedPaths: ['src/a.ts'],
          comparisonStdout: '',
        }),
      );
      await driveToAwaitingMerge(reconciler);
      merge.state.answer = { state: 'MERGED', mergeCommit };

      await reconciler.pass();

      expect(reconciler.load(run).state.state).toBe('committed');
      const events = readEventLog(runPaths(run, reconciler.orchHome).eventLog);
      const fidelity = events.filter((event) => event.type === PULL_REQUEST_MERGE_FIDELITY_EVENT_TYPE);
      expect(fidelity).toHaveLength(1);
      const payload = fidelity[0]?.payload ?? {};
      expect(payload).toMatchObject({
        [PULL_REQUEST_MERGE_FIDELITY_PAYLOAD_KEYS.Outcome]: 'unchanged',
        [PULL_REQUEST_MERGE_FIDELITY_PAYLOAD_KEYS.HeadRefOid]: proposedHead,
        [PULL_REQUEST_MERGE_FIDELITY_PAYLOAD_KEYS.MergeCommit]: mergeCommit,
      });
      expect(Object.keys(payload)).toHaveLength(4);
      expect(typeof payload[PULL_REQUEST_MERGE_FIDELITY_PAYLOAD_KEYS.Detail]).toBe('string');
    });

    it('records code, never a guessed outcome, when the comparison itself cannot be made (row 13)', async () => {
      const mergeCommit = '1aa05d03b5192ef1e76faa214c9a5c5009aac4c4';
      const { reconciler, run, merge } = buildMergeFidelityRun('merge-fidelity-unreadable', () => ({
        status: 1,
        stdout: '',
        stderr: 'boom',
      }));
      await driveToAwaitingMerge(reconciler);
      merge.state.answer = { state: 'MERGED', mergeCommit };

      await reconciler.pass();

      expect(reconciler.load(run).state.state).toBe('committed');
      const events = readEventLog(runPaths(run, reconciler.orchHome).eventLog);
      const fidelity = events.filter((event) => event.type === PULL_REQUEST_MERGE_FIDELITY_EVENT_TYPE);
      expect(fidelity).toHaveLength(1);
      expect(fidelity[0]?.payload[PULL_REQUEST_MERGE_FIDELITY_PAYLOAD_KEYS.Outcome]).toBeUndefined();
      expect(fidelity[0]?.payload[PULL_REQUEST_MERGE_FIDELITY_PAYLOAD_KEYS.Code]).toBe(
        'pull_request.merge_fidelity_head_unreadable',
      );
    });

    it('never emits a second line when the run’s log already carries one (row 20)', async () => {
      const mergeCommit = '5ea6748cb81c7e053093927c9815d5e559fcaabb';
      const mergeFidelityGit: GitCall = () => {
        throw new Error('mergeFidelityOf must not be called once the line is already recorded');
      };
      const { reconciler, run, merge } = buildMergeFidelityRun(
        'merge-fidelity-idempotent',
        mergeFidelityGit,
      );
      await driveToAwaitingMerge(reconciler);

      // Simulate the established crash-injection seam: a prior pass already recorded the line and crashed
      // before the following `committed`-transition emit landed, so the run is still `awaiting_merge`.
      const paths = runPaths(run, reconciler.orchHome);
      const before = readEventLog(paths.eventLog);
      const maxSeq = before.reduce((max, event) => Math.max(max, event.seq), 0);
      const priorLine = {
        ts: '2026-09-24T10:00:00.000Z',
        seq: maxSeq + 1,
        feature: before[0]?.feature ?? 'merge-fidelity-idempotent',
        run,
        step: null,
        emitter: 'engine.reconciler',
        type: PULL_REQUEST_MERGE_FIDELITY_EVENT_TYPE,
        payload: {
          [PULL_REQUEST_MERGE_FIDELITY_PAYLOAD_KEYS.Outcome]: 'unchanged',
          [PULL_REQUEST_MERGE_FIDELITY_PAYLOAD_KEYS.HeadRefOid]: 'a-prior-pass-already-recorded-this',
          [PULL_REQUEST_MERGE_FIDELITY_PAYLOAD_KEYS.MergeCommit]: mergeCommit,
          [PULL_REQUEST_MERGE_FIDELITY_PAYLOAD_KEYS.Detail]: 'recorded by a prior, interrupted pass',
        },
      };
      appendFileSync(paths.eventLog, `${JSON.stringify(priorLine)}\n`, 'utf8');
      expect(reconciler.load(run).state.state).toBe('awaiting_merge');

      merge.state.answer = { state: 'MERGED', mergeCommit };
      await reconciler.pass();

      expect(reconciler.load(run).state.state).toBe('committed');
      const events = readEventLog(paths.eventLog);
      const fidelity = events.filter((event) => event.type === PULL_REQUEST_MERGE_FIDELITY_EVENT_TYPE);
      expect(fidelity).toHaveLength(1);
      expect(fidelity[0]?.payload[PULL_REQUEST_MERGE_FIDELITY_PAYLOAD_KEYS.HeadRefOid]).toBe(
        'a-prior-pass-already-recorded-this',
      );
    });
  });

  /**
   * The exactly-once claim, demonstrated at the reach this suite can reach without two real engine
   * processes racing one lock. `write.attempted`/`write.executed` are the row's real guarantee (AD-15,
   * proven above); what this test adds is that once `committed` is reached — a terminal state — no
   * further pass performs another write at all: `decideAction`'s very first test is
   * `isTerminalFeatureState`, so a second and third pass never even reach the write executor. AD-29's
   * single-writer claim on the run's own log is what would serialise two truly concurrent passes; that
   * mechanism is `src/runtime/recorder.ts`'s own subject and is exercised by its own suite, not repeated
   * here.
   */
  it('performs no further write once committed, across repeated later passes (matrix row 7)', async () => {
    const { reconciler, run, writes, merge } = buildRun();
    await driveToAwaitingMerge(reconciler);
    merge.state.answer = { state: 'MERGED', mergeCommit: 'f'.repeat(40) };
    await reconciler.pass();
    expect(reconciler.load(run).state.state).toBe('committed');
    writes.length = 0;

    await reconciler.pass();
    await reconciler.pass();

    expect(writes).toStrictEqual([]);
  });

  it('surfaces a closed-without-merging pull request to a person rather than checking forever', async () => {
    const { reconciler, run, merge } = buildRun();
    await driveToAwaitingMerge(reconciler);
    merge.state.answer = { state: 'CLOSED', mergeCommit: null };

    await reconciler.pass();

    expect(reconciler.load(run).state.state).toBe('blocked');
  });

  /**
   * `settlePreMergeWrites`'s `'unsettled'` return, exercised through a real reconciler pass rather than
   * asserted about the private method directly: a failed write neither commits nor enters
   * `awaiting_merge`, and the run stays exactly where the failure found it.
   */
  it('does not enter awaiting_merge when a pre-merge write fails, and retries from the top once it clears', async () => {
    const orchHome = makeHome('awaiting-merge-unsettled');
    toRemove.push(orchHome);
    const plan = makePlan({ feature: 'awaiting-merge-unsettled', steps: STANDARD_PLAN_STEPS });
    const flaky = flakyWriteExecutor();
    flaky.failing.add('git_push');
    const reconciler = Reconciler.open({
      orchHome,
      plans: planProvider(plan),
      baseline: { currentRef: () => 'a'.repeat(40), resetTo: () => undefined },
      executor: createScriptedExecutor(committingCapableScript()),
      writeExecutor: flaky.checker,
    });
    toClose.push(reconciler);
    const accepted = reconciler.acceptFeature(plan);
    ungatedConfigSnapshot(accepted.run, orchHome);
    reconciler.confirm(accepted.run);

    for (let index = 0; index < 6; index += 1) await reconciler.pass(); // analyse .. commit
    await reconciler.pass(); // the settlement pass: git_push fails, so this is 'unsettled'

    expect(reconciler.load(accepted.run).state.state).not.toBe('awaiting_merge');
    expect(reconciler.load(accepted.run).state.state).not.toBe('committed');
    expect(flaky.writes.map((write) => write.kind)).toStrictEqual(['git_push']);

    // The failure clears; the next pass retries from the top and this time settles all the way through.
    flaky.failing.delete('git_push');
    flaky.writes.length = 0;
    await reconciler.pass();

    expect(reconciler.load(accepted.run).state.state).toBe('awaiting_merge');
    expect(flaky.writes.map((write) => write.kind)).toStrictEqual(['git_push', 'pull_request']);
  });

  /**
   * The partial-settlement case: `git_push` already `executed`, `pull_request` not yet. A retry must
   * resume from `writeIntentSettled`'s reading of the log, never re-attempt the whole set from scratch —
   * proven by asserting `git_push` is not called a second time on the pass that finally succeeds.
   */
  it('resumes a partially settled write via the log rather than re-attempting from scratch', async () => {
    const orchHome = makeHome('awaiting-merge-partial');
    toRemove.push(orchHome);
    const plan = makePlan({ feature: 'awaiting-merge-partial', steps: STANDARD_PLAN_STEPS });
    const flaky = flakyWriteExecutor();
    flaky.failing.add('pull_request');
    const reconciler = Reconciler.open({
      orchHome,
      plans: planProvider(plan),
      baseline: { currentRef: () => 'a'.repeat(40), resetTo: () => undefined },
      executor: createScriptedExecutor(committingCapableScript()),
      writeExecutor: flaky.checker,
    });
    toClose.push(reconciler);
    const accepted = reconciler.acceptFeature(plan);
    ungatedConfigSnapshot(accepted.run, orchHome);
    reconciler.confirm(accepted.run);

    for (let index = 0; index < 6; index += 1) await reconciler.pass();
    await reconciler.pass(); // git_push succeeds; pull_request fails -> 'unsettled'

    expect(flaky.writes.map((write) => write.kind)).toStrictEqual(['git_push', 'pull_request']);
    expect(reconciler.load(accepted.run).state.state).not.toBe('awaiting_merge');

    flaky.failing.delete('pull_request');
    flaky.writes.length = 0;
    await reconciler.pass();

    // git_push is not attempted a second time: `writeIntentSettled` found its `write.executed` line.
    expect(flaky.writes.map((write) => write.kind)).toStrictEqual(['pull_request']);
    expect(reconciler.load(accepted.run).state.state).toBe('awaiting_merge');
  });
});

// -------------------------------------------------------------------------------------------------
// Story 4-1 (AD-12) — the reversibility gate: every row of the story's own I/O matrix.
// -------------------------------------------------------------------------------------------------

/**
 * A run whose project declares a real `gated_reversibility_classes` policy, read the way
 * `settlePreMergeWrites` reads every project's: from the AD-9 config snapshot, never a hardcoded
 * constant. `takeConfigSnapshot` is called between `acceptFeature` and `confirm`, exactly the order
 * `tests/engine.gate-economics.test.ts` already establishes for a run that needs one.
 */
const buildGatedRun = (options: {
  readonly label: string;
  readonly gatedClasses: readonly ReversibilityClass[];
  readonly mode?: 'live' | 'shadow';
  /**
   * Row 9 — omit `permissions.toml` from the snapshot entirely, rather than writing one that
   * declares `gatedClasses`. `options.gatedClasses` is then unused; the point of the row is what the
   * *absence* of the file falls back to.
   */
  readonly noPermissionsFile?: boolean;
}): {
  readonly reconciler: Reconciler;
  readonly run: string;
  readonly writes: RecordedWrite[];
  readonly feature: string;
} => {
  const orchHome = makeHome(options.label);
  toRemove.push(orchHome);
  const repository = makeWorkspace(`${options.label}-repo`);
  toRemove.push(repository);
  // Blank mechanics commands, so CAP-13's deterministic gates are declared *none* rather than
  // dispatched to a real runner this fixture never wires — the fixture's own concern is AD-12's write
  // gate, not the gate economics `tests/engine.gate-economics.test.ts` already covers.
  writeProfile(
    repository,
    fixtureProfile({
      mechanics: {
        package_manager: 'npm',
        commands: { test: '', typecheck: '', lint: '', build: '', run: '' },
        source_layout: ['src', 'tests'],
        resources: 'none',
      },
    }),
  );
  if (options.noPermissionsFile !== true) {
    writePermissions(
      repository,
      fixturePermissions({ gated_reversibility_classes: [...options.gatedClasses] }),
    );
  }
  const plan = makePlan({
    feature: options.label,
    mode: options.mode ?? 'live',
    steps: STANDARD_PLAN_STEPS,
  });
  const writes: RecordedWrite[] = [];
  const reconciler = Reconciler.open({
    orchHome,
    plans: planProvider(plan),
    baseline: { currentRef: () => 'a'.repeat(40), resetTo: () => undefined },
    executor: createScriptedExecutor(committingCapableScript()),
    writeExecutor:
      options.mode === 'shadow' ? recordingShadowWriteExecutor(writes) : recordingWriteExecutor(writes),
  });
  toClose.push(reconciler);
  const accepted = reconciler.acceptFeature(plan);
  takeConfigSnapshot({ repository, runId: accepted.run, orchHome });
  reconciler.confirm(accepted.run);
  return { reconciler, run: accepted.run, writes, feature: options.label };
};

describe('AD-12, CAP-12, story 4-1 — the reversibility gate', () => {
  it(
    'emits write.gate_opened for the first unsettled intent, blocks, and never calls the write ' +
      'executor (matrix row 1)',
    async () => {
      const { reconciler, run, writes } = buildGatedRun({
        label: 'gate-row-1',
        gatedClasses: ['irreversible'],
      });
      for (let index = 0; index < 7; index += 1) await reconciler.pass();

      const state = reconciler.load(run).state;
      expect(state.state).toBe('blocked');
      expect(writes).toStrictEqual([]);
      expect(state.pending_gate).toStrictEqual({
        step: 'commit',
        intent_id: 'commit.git_push',
        kind: 'git_push',
        reversibility: 'irreversible',
        // The whole remaining batch, not only the triggering intent — round-1 review's disclosure fix.
        batch: [
          { intent_id: 'commit.git_push', kind: 'git_push' },
          { intent_id: 'commit.pull_request', kind: 'pull_request' },
        ],
        resolution: 'pending',
      });

      const events = readEventLog(runPaths(run, reconciler.orchHome).eventLog);
      const opened = events.filter((event) => event.type === WRITE_GATE_OPENED_EVENT_TYPE);
      expect(opened).toHaveLength(1);
      expect(opened[0]?.payload[WRITE_GATE_OPENED_PAYLOAD_KEYS.IntentId]).toBe('commit.git_push');
      expect(opened[0]?.payload[WRITE_GATE_OPENED_PAYLOAD_KEYS.Kind]).toBe('git_push');
      expect(opened[0]?.payload[WRITE_GATE_OPENED_PAYLOAD_KEYS.Reversibility]).toBe('irreversible');
      expect(opened[0]?.payload[WRITE_GATE_OPENED_PAYLOAD_KEYS.Step]).toBe('commit');
      expect(opened[0]?.payload[WRITE_GATE_OPENED_PAYLOAD_KEYS.Batch]).toStrictEqual([
        { intent_id: 'commit.git_push', kind: 'git_push', target: 'feature/gate-row-1' },
        { intent_id: 'commit.pull_request', kind: 'pull_request', target: 'feature/gate-row-1' },
      ]);
    },
  );

  it('records write.gate_approved and returns to running with no step disposition touched (matrix row 2)', async () => {
    const { reconciler, run } = buildGatedRun({ label: 'gate-row-2', gatedClasses: ['irreversible'] });
    for (let index = 0; index < 7; index += 1) await reconciler.pass();
    const commitStepBefore = reconciler.load(run).state.steps.find((record) => record.step === 'commit');

    const after = reconciler.approve(run);

    expect(after.state).toBe('running');
    // The record stays on disk with `resolution: 'approved'` until the whole batch it names actually
    // settles (round-1 review, rows 3/12) — cleared only once every intent in it carries a
    // `write.executed`/`write.suppressed` line, which approving alone does not yet make happen.
    expect(after.pending_gate?.resolution).toBe('approved');
    expect(after.pending_gate?.intent_id).toBe('commit.git_push');
    // No step's disposition changed — the committing step's own record is untouched.
    expect(after.steps.find((record) => record.step === 'commit')).toStrictEqual(commitStepBefore);

    const events = readEventLog(runPaths(run, reconciler.orchHome).eventLog);
    const approved = events.filter((event) => event.type === WRITE_GATE_APPROVED_EVENT_TYPE);
    expect(approved).toHaveLength(1);
    expect(approved[0]?.payload[WRITE_GATE_APPROVED_PAYLOAD_KEYS.IntentId]).toBe('commit.git_push');
  });

  it('calls the write executor on the next pass once approved, and never re-opens the gate (matrix row 3)', async () => {
    const { reconciler, run, writes } = buildGatedRun({ label: 'gate-row-3', gatedClasses: ['irreversible'] });
    for (let index = 0; index < 7; index += 1) await reconciler.pass();
    reconciler.approve(run);
    expect(writes).toStrictEqual([]); // approving itself performs no write

    await reconciler.pass();

    expect(writes.map((write) => write.kind)).toStrictEqual(['git_push', 'pull_request']);
    expect(reconciler.load(run).state.state).toBe('awaiting_merge');
    const events = readEventLog(runPaths(run, reconciler.orchHome).eventLog);
    expect(events.filter((event) => event.type === WRITE_GATE_OPENED_EVENT_TYPE)).toHaveLength(1);
  });

  it('records write.gate_rejected with the reason and hands the run off, never retrying (matrix row 4)', async () => {
    const { reconciler, run, writes } = buildGatedRun({ label: 'gate-row-4', gatedClasses: ['irreversible'] });
    for (let index = 0; index < 7; index += 1) await reconciler.pass();

    const after = reconciler.reject(run, 'This push touches a path nobody has reviewed yet.');

    expect(after.state).toBe('handed_off');
    expect(after.pending_gate).toBeNull();
    expect(after.handoff?.code).toBe('user.gate_rejected');
    expect(writes).toStrictEqual([]);

    const events = readEventLog(runPaths(run, reconciler.orchHome).eventLog);
    const rejected = events.filter((event) => event.type === WRITE_GATE_REJECTED_EVENT_TYPE);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.payload[WRITE_GATE_REJECTED_PAYLOAD_KEYS.IntentId]).toBe('commit.git_push');
    expect(rejected[0]?.payload[WRITE_GATE_REJECTED_PAYLOAD_KEYS.Reason]).toBe(
      'This push touches a path nobody has reviewed yet.',
    );

    // A further pass does not retry the rejected write: the run is terminal.
    await reconciler.pass();
    expect(writes).toStrictEqual([]);
  });

  it(
    'leaves approve/reject byte-for-byte unchanged for an ordinary step-failure block, with no gate ' +
      'pending (matrix row 5)',
    () => {
      // A run that never composed a commit at all has no `pendingGate` and no write to gate — the
      // ordinary `permission.denied` escalation this suite already drives elsewhere is `approve`'s other,
      // pre-existing branch, unreached here on purpose: this asserts the *refusal* half of row 5, that an
      // approval finds nothing to approve when no gate and no step failure exist, exactly as before this
      // story.
      const { reconciler, run } = buildGatedRun({ label: 'gate-row-5', gatedClasses: ['irreversible'] });
      expect(reconciler.load(run).state.pending_gate).toBeNull();
      expect(() => reconciler.approve(run)).toThrow(SteeringRefused);
      // `reject` with no gate pending falls through unchanged to its pre-existing question handling,
      // which finds no open question either and refuses — never the new gate-scoped branch.
      expect(() => reconciler.reject(run, 'nothing to reject here')).toThrow(SteeringRefused);
    },
  );

  it('performs the write immediately when the project’s policy does not gate irreversible writes (matrix row 6)', async () => {
    const { reconciler, run, writes } = buildGatedRun({ label: 'gate-row-6', gatedClasses: [] });
    for (let index = 0; index < 7; index += 1) await reconciler.pass();

    expect(reconciler.load(run).state.state).toBe('awaiting_merge');
    expect(writes.map((write) => write.kind)).toStrictEqual(['git_push', 'pull_request']);
    const events = readEventLog(runPaths(run, reconciler.orchHome).eventLog);
    expect(events.some((event) => event.type === WRITE_GATE_OPENED_EVENT_TYPE)).toBe(false);
  });

  it('reads no reversibility at all once every intent is already settled — a re-entered pass (matrix row 7)', async () => {
    const { reconciler, run, writes, feature } = buildGatedRun({
      label: 'gate-row-7',
      gatedClasses: ['irreversible'],
    });
    for (let index = 0; index < 6; index += 1) await reconciler.pass(); // analyse .. commit; not yet settled

    // Simulate the crash-recovery re-entrancy `settlePreMergeWrites`'s own docblock describes: both
    // pre-merge intents already landed durably, but the `feature.state_changed` to `awaiting_merge` did
    // not — so the next pass re-enters `settlePreMergeWrites` and must find both already settled.
    const paths = runPaths(run, reconciler.orchHome);
    const before = readEventLog(paths.eventLog);
    const maxSeq = before.reduce((max, event) => Math.max(max, event.seq), 0);
    const priorLine = (seq: number, intentId: string, kind: string) => ({
      ts: '2026-09-24T10:00:00.000Z',
      seq,
      feature,
      run,
      step: null,
      emitter: 'engine.reconciler',
      type: 'write.executed',
      payload: {
        intent_id: intentId,
        kind,
        target: 'feature/gate-row-7',
        already_present: false,
        detail: 'pre-settled by a prior, interrupted pass',
      },
    });
    appendFileSync(paths.eventLog, `${JSON.stringify(priorLine(maxSeq + 1, 'commit.git_push', 'git_push'))}\n`, 'utf8');
    appendFileSync(
      paths.eventLog,
      `${JSON.stringify(priorLine(maxSeq + 2, 'commit.pull_request', 'pull_request'))}\n`,
      'utf8',
    );

    await reconciler.pass(); // the re-entered settlement pass

    expect(writes).toStrictEqual([]); // the executor is never called for either
    const events = readEventLog(paths.eventLog);
    expect(events.some((event) => event.type === WRITE_GATE_OPENED_EVENT_TYPE)).toBe(false);
    expect(reconciler.load(run).state.state).toBe('awaiting_merge');
  });

  it('gates a shadow run exactly the same as a live run (matrix row 8)', async () => {
    const { reconciler, run, writes } = buildGatedRun({
      label: 'gate-row-8',
      gatedClasses: ['irreversible'],
      mode: 'shadow',
    });
    for (let index = 0; index < 7; index += 1) await reconciler.pass();

    expect(reconciler.load(run).state.state).toBe('blocked');
    expect(writes).toStrictEqual([]);
    const opened = readEventLog(runPaths(run, reconciler.orchHome).eventLog).filter(
      (event) => event.type === WRITE_GATE_OPENED_EVENT_TYPE,
    );
    expect(opened).toHaveLength(1);

    // Once approved, a shadow run settles exactly the way `mode: 'shadow'` already does for an ungated
    // one (story 3-2): all three intents suppress in the one pass and it reaches `committed` directly.
    reconciler.approve(run);
    for (
      let index = 0;
      index < 5 && reconciler.load(run).state.state !== 'committed';
      index += 1
    ) {
      await reconciler.pass();
    }
    expect(reconciler.load(run).state.state).toBe('committed');
    expect(writes.map((write) => write.kind)).toStrictEqual(['git_push', 'pull_request', 'git_note']);
  });

  it('falls back to the installer’s own default when permissions.toml is absent, and still gates (matrix row 9)', async () => {
    const { reconciler, run, writes } = buildGatedRun({
      label: 'gate-row-9',
      gatedClasses: [],
      noPermissionsFile: true,
    });
    for (let index = 0; index < 7; index += 1) await reconciler.pass();

    expect(reconciler.load(run).state.state).toBe('blocked');
    expect(writes).toStrictEqual([]);
    const opened = readEventLog(runPaths(run, reconciler.orchHome).eventLog).filter(
      (event) => event.type === WRITE_GATE_OPENED_EVENT_TYPE,
    );
    expect(opened).toHaveLength(1);
    expect(opened[0]?.payload[WRITE_GATE_OPENED_PAYLOAD_KEYS.Reversibility]).toBe('irreversible');
  });

  it(
    'refuses a reject naming both a pending gate and an open question, resolving neither (matrix row 10)',
    async () => {
      const { reconciler, run, writes } = buildGatedRun({
        label: 'gate-row-10',
        gatedClasses: ['irreversible'],
      });
      for (let index = 0; index < 7; index += 1) await reconciler.pass();
      expect(reconciler.load(run).state.state).toBe('blocked');

      const draft: QuestionDraft = {
        prompt: 'Does this touch a shared config file?',
        brief: 'A long-window question left open while the run reached the commit step and gated.',
        options: [
          { id: 'yes', label: 'Yes', consequence: 'Narrow the territory.' },
          { id: 'no', label: 'No', consequence: 'Proceed as declared.' },
        ],
        escape: { id: 'decide-later', label: 'Ask me later', consequence: 'Nothing changes yet.' },
        recommended_option_id: 'no',
        default_action: 'No is assumed.',
        default_window_ms: 15 * 60 * 1000,
      };
      reconciler.ask(run, draft);

      expect(() => reconciler.reject(run, 'reject the gate, or is this about the question?')).toThrow(
        SteeringRefused,
      );
      // Neither the gate nor the question moved.
      expect(reconciler.load(run).state.pending_gate?.resolution).toBe('pending');
      expect(reconciler.load(run).state.state).toBe('blocked');
      expect(writes).toStrictEqual([]);
      const rejected = readEventLog(runPaths(run, reconciler.orchHome).eventLog).filter(
        (event) => event.type === WRITE_GATE_REJECTED_EVENT_TYPE,
      );
      expect(rejected).toStrictEqual([]);
    },
  );

  it(
    'refuses a later approve when a rejection landed but the hand-off transition did not — a crash ' +
      'window (matrix row 11)',
    async () => {
      const { reconciler, run, writes, feature } = buildGatedRun({
        label: 'gate-row-11',
        gatedClasses: ['irreversible'],
      });
      for (let index = 0; index < 7; index += 1) await reconciler.pass();
      expect(reconciler.load(run).state.state).toBe('blocked');

      // Simulate the crash the story's own review round traced by hand: `write.gate_rejected` lands
      // durably, but the `command.applied` line carrying the `handed_off` transition does not.
      const paths = runPaths(run, reconciler.orchHome);
      const before = readEventLog(paths.eventLog);
      const maxSeq = before.reduce((max, event) => Math.max(max, event.seq), 0);
      const priorLine = {
        ts: '2026-09-24T10:00:00.000Z',
        seq: maxSeq + 1,
        feature,
        run,
        step: null,
        emitter: 'engine.reconciler',
        type: WRITE_GATE_REJECTED_EVENT_TYPE,
        payload: {
          [WRITE_GATE_REJECTED_PAYLOAD_KEYS.IntentId]: 'commit.git_push',
          [WRITE_GATE_REJECTED_PAYLOAD_KEYS.Reason]: 'a prior, interrupted pass already rejected this',
        },
      };
      appendFileSync(paths.eventLog, `${JSON.stringify(priorLine)}\n`, 'utf8');

      const loaded = reconciler.load(run).state;
      expect(loaded.state).toBe('blocked'); // the transition never landed
      expect(loaded.pending_gate?.resolution).toBe('rejected'); // but the decision is on record

      expect(() => reconciler.approve(run)).toThrow(SteeringRefused);
      expect(reconciler.load(run).state.state).toBe('blocked'); // never silently resumed
      expect(writes).toStrictEqual([]);
    },
  );

  it(
    'runs the remaining intents without a second approval once one of an approved batch already ' +
      'settled — a crash window (matrix row 12)',
    async () => {
      const { reconciler, run, writes, feature } = buildGatedRun({
        label: 'gate-row-12',
        gatedClasses: ['irreversible'],
      });
      for (let index = 0; index < 7; index += 1) await reconciler.pass();
      reconciler.approve(run);
      expect(reconciler.load(run).state.pending_gate?.resolution).toBe('approved');

      // Simulate the crash: the first intent of the approved batch settled durably; the reconciler died
      // before the write executor was ever asked for the second.
      const paths = runPaths(run, reconciler.orchHome);
      const before = readEventLog(paths.eventLog);
      const maxSeq = before.reduce((max, event) => Math.max(max, event.seq), 0);
      const priorLine = {
        ts: '2026-09-24T10:00:00.000Z',
        seq: maxSeq + 1,
        feature,
        run,
        step: null,
        emitter: 'engine.reconciler',
        type: 'write.executed',
        payload: {
          intent_id: 'commit.git_push',
          kind: 'git_push',
          target: `feature/${feature}`,
          already_present: false,
          detail: 'pre-settled by a prior, interrupted pass',
        },
      };
      appendFileSync(paths.eventLog, `${JSON.stringify(priorLine)}\n`, 'utf8');

      await reconciler.pass(); // the re-entered settlement pass

      // git_push is never handed to the executor a second time; only pull_request is.
      expect(writes.map((write) => write.kind)).toStrictEqual(['pull_request']);
      expect(reconciler.load(run).state.state).toBe('awaiting_merge');
      const opened = readEventLog(paths.eventLog).filter(
        (event) => event.type === WRITE_GATE_OPENED_EVENT_TYPE,
      );
      expect(opened).toHaveLength(1); // never a second gate for the same batch
    },
  );

  it(
    'self-heals a crash between write.gate_opened landing and the following blocked transition ' +
      'landing, without opening a second gate',
    async () => {
      const { reconciler, run, writes, feature } = buildGatedRun({
        label: 'gate-row-crash-open',
        gatedClasses: ['irreversible'],
      });
      for (let index = 0; index < 6; index += 1) await reconciler.pass(); // analyse .. commit only

      // Fabricate exactly the durable half of the gate-opening pass, without the `blocked` transition
      // that pass would otherwise also emit — the window `settlePreMergeWrites`'s own docblock names.
      const paths = runPaths(run, reconciler.orchHome);
      const before = readEventLog(paths.eventLog);
      const maxSeq = before.reduce((max, event) => Math.max(max, event.seq), 0);
      const priorLine = {
        ts: '2026-09-24T10:00:00.000Z',
        seq: maxSeq + 1,
        feature,
        run,
        step: null,
        emitter: 'engine.reconciler',
        type: WRITE_GATE_OPENED_EVENT_TYPE,
        payload: {
          [WRITE_GATE_OPENED_PAYLOAD_KEYS.IntentId]: 'commit.git_push',
          [WRITE_GATE_OPENED_PAYLOAD_KEYS.Kind]: 'git_push',
          [WRITE_GATE_OPENED_PAYLOAD_KEYS.Target]: `feature/${feature}`,
          [WRITE_GATE_OPENED_PAYLOAD_KEYS.Reversibility]: 'irreversible',
          [WRITE_GATE_OPENED_PAYLOAD_KEYS.Step]: 'commit',
          [WRITE_GATE_OPENED_PAYLOAD_KEYS.Batch]: [
            { intent_id: 'commit.git_push', kind: 'git_push', target: `feature/${feature}` },
            { intent_id: 'commit.pull_request', kind: 'pull_request', target: `feature/${feature}` },
          ],
        },
      };
      appendFileSync(paths.eventLog, `${JSON.stringify(priorLine)}\n`, 'utf8');
      expect(reconciler.load(run).state.state).not.toBe('blocked'); // the transition truly never landed

      await reconciler.pass(); // the re-entered pass completes the transition, opening nothing new

      expect(reconciler.load(run).state.state).toBe('blocked');
      expect(writes).toStrictEqual([]);
      const opened = readEventLog(paths.eventLog).filter(
        (event) => event.type === WRITE_GATE_OPENED_EVENT_TYPE,
      );
      expect(opened).toHaveLength(1); // the fabricated line stands; no second one was ever emitted
    },
  );

  it('refuses the run with MixedReversibilityBatch rather than under-gating, when a composed commit’s intents disagree', async () => {
    const { reconciler, run, writes } = buildGatedRun({
      label: 'gate-row-mixed',
      gatedClasses: ['irreversible'],
    });
    for (let index = 0; index < 6; index += 1) await reconciler.pass(); // analyse .. commit

    const paths = runPaths(run, reconciler.orchHome);
    const artifactPath = join(paths.runDir, COMPOSED_COMMIT_RELATIVE_PATH);
    const composed = JSON.parse(readFileSync(artifactPath, 'utf8')) as {
      intents: { kind: string; reversibility: string }[];
    };
    const pullRequestIntent = composed.intents.find((intent) => intent.kind === 'pull_request');
    expect(pullRequestIntent).toBeDefined();
    if (pullRequestIntent !== undefined) pullRequestIntent.reversibility = 'reversible';
    writeFileSync(artifactPath, `${JSON.stringify(composed, null, 2)}\n`, 'utf8');

    // A per-run refusal (`tests/engine.reconciler.test.ts`'s own "one unreadable run does not stop
    // every other feature" discipline), not a rejected promise — `MixedReversibilityBatch` is deliberately
    // left uncaught by `settlePreMergeWrites`'s one call site and caught here, at `pass()`'s own boundary.
    const result = await reconciler.pass();
    expect(result.refusals).toHaveLength(1);
    expect(result.refusals[0]?.run).toBe(run);
    expect(result.refusals[0]?.code).toBe('internal.invariant_violated');
    expect(result.refusals[0]?.reason).toContain('MixedReversibilityBatch');
    expect(writes).toStrictEqual([]);
  });

  it('refuses the run with UnreadableGateConfiguration for a genuinely corrupt permissions.toml, never treating it as no gate or the default', async () => {
    const label = 'gate-row-unreadable';
    const orchHome = makeHome(label);
    toRemove.push(orchHome);
    const repository = makeWorkspace(`${label}-repo`);
    toRemove.push(repository);
    writeProfile(
      repository,
      fixtureProfile({
        mechanics: {
          package_manager: 'npm',
          commands: { test: '', typecheck: '', lint: '', build: '', run: '' },
          source_layout: ['src', 'tests'],
          resources: 'none',
        },
      }),
    );
    // A corrupt `permissions.toml`, present but not this build's TOML subset — never merely absent.
    mkdirSync(join(repository, '.orch'), { recursive: true });
    writeFileSync(join(repository, '.orch', 'permissions.toml'), '][not toml', 'utf8');

    const plan = makePlan({ feature: label, steps: STANDARD_PLAN_STEPS });
    const writes: RecordedWrite[] = [];
    const reconciler = Reconciler.open({
      orchHome,
      plans: planProvider(plan),
      baseline: { currentRef: () => 'a'.repeat(40), resetTo: () => undefined },
      executor: createScriptedExecutor(committingCapableScript()),
      writeExecutor: recordingWriteExecutor(writes),
    });
    toClose.push(reconciler);
    const accepted = reconciler.acceptFeature(plan);
    takeConfigSnapshot({ repository, runId: accepted.run, orchHome });
    reconciler.confirm(accepted.run);

    for (let index = 0; index < 6; index += 1) await reconciler.pass(); // analyse .. commit
    // A per-run refusal, not a rejected promise — the same "one unreadable run does not stop every
    // other feature" boundary the mixed-batch test above documents.
    const result = await reconciler.pass();
    expect(result.refusals).toHaveLength(1);
    expect(result.refusals[0]?.run).toBe(accepted.run);
    expect(result.refusals[0]?.code).toBe('config.invalid');
    expect(result.refusals[0]?.reason).toContain('UnreadableGateConfiguration');
    expect(writes).toStrictEqual([]);
  });
});

// -------------------------------------------------------------------------------------------------
// Story 3-2 (AD-27) — a shadow run never enters `awaiting_merge` (matrix row 10).
// -------------------------------------------------------------------------------------------------

/**
 * A write executor that emits the shadow shape — `write.attempted` then `write.suppressed`, never
 * `write.executed` — for every intent it is handed. The suppression logic itself
 * (`performWriteIntent`/`performGitNoteShadow` under `mode: 'shadow'`) is `src/engine/write-executor.ts`'s
 * own subject, proven in `tests/engine.write-executor.test.ts`; what this file's own test needs is only
 * that the reconciler routes a run whose intents settle this way straight to `committed`.
 */
const recordingShadowWriteExecutor = (writes: RecordedWrite[]): WriteExecutorPort => {
  const port: WriteExecutorPort = (intent, context) => {
    writes.push({ kind: intent.kind, mergeCommit: context.mergeCommit });
    context.emit('write.attempted', {
      intent_id: intent.intent_id,
      kind: intent.kind,
      target: intent.target,
    });
    context.emit('write.suppressed', {
      intent_id: intent.intent_id,
      kind: intent.kind,
      target: intent.target,
      destructive: false,
      detail: 'suppressed by the test double',
    });
    return Promise.resolve({
      status: 'suppressed' as const,
      destructive: false,
      detail: 'suppressed by the test double',
    });
  };
  return port;
};

describe('AD-27, story 3-2 — a shadow run never enters awaiting_merge (matrix row 10)', () => {
  it('reaches committed directly once push, pull-request and note all settle as write.suppressed', async () => {
    const orchHome = makeHome('shadow-committed');
    toRemove.push(orchHome);
    const plan = makePlan({ feature: 'shadow-committed', mode: 'shadow', steps: STANDARD_PLAN_STEPS });
    const writes: RecordedWrite[] = [];
    const reconciler = Reconciler.open({
      orchHome,
      plans: planProvider(plan),
      baseline: { currentRef: () => 'a'.repeat(40), resetTo: () => undefined },
      executor: createScriptedExecutor(committingCapableScript()),
      writeExecutor: recordingShadowWriteExecutor(writes),
      // Deliberately no `mergeChecker`: a shadow run must never need one, since it never enters
      // `awaiting_merge` to begin with — wiring one here would leave a bug that reached for it unnoticed.
    });
    toClose.push(reconciler);
    const accepted = reconciler.acceptFeature(plan);
    ungatedConfigSnapshot(accepted.run, orchHome);
    reconciler.confirm(accepted.run);

    const seenStates: string[] = [];
    for (let index = 0; index < 10 && reconciler.load(accepted.run).state.state !== 'committed'; index += 1) {
      await reconciler.pass();
      seenStates.push(reconciler.load(accepted.run).state.state);
    }

    expect(reconciler.load(accepted.run).state.state).toBe('committed');
    expect(seenStates).not.toContain('awaiting_merge');
    // All three composed intents settle in this one pass, unlike a live run's push/pull-request-then-note
    // split — there is no merge to wait on, so nothing is held back.
    expect(writes.map((write) => write.kind)).toStrictEqual(['git_push', 'pull_request', 'git_note']);
    expect(writes.every((write) => write.mergeCommit === null)).toBe(true);

    const events = readEventLog(runPaths(accepted.run, reconciler.orchHome).eventLog);
    expect(events.some((event) => event.type === 'write.executed')).toBe(false);
    expect(
      events.filter((event) => event.type === 'write.suppressed').map((event) => event.payload['kind']),
    ).toStrictEqual(['git_push', 'pull_request', 'git_note']);
  });
});

/**
 * The reconciler's `mode: plan.mode` wiring, exercised against the *real* `performWriteIntent` — every
 * other shadow test above drives a hand-rolled stub that never reads `context.mode` at all, so none of
 * them can prove the reconciler actually threads it through correctly. This wraps the real function with
 * fake `git`/`gh` calls, the same pattern `tests/engine.write-executor.test.ts` drives it with directly,
 * so the only thing injected is the process boundary — the mode-branching logic under test is 3-2's own.
 */
describe('AD-27, story 3-2 — the real performWriteIntent, through a Reconciler, under mode: shadow', () => {
  it('never issues a real mutating git/gh call for a shadow run', async () => {
    const orchHome = makeHome('shadow-real-executor');
    toRemove.push(orchHome);
    const plan = makePlan({ feature: 'shadow-real-executor', mode: 'shadow', steps: STANDARD_PLAN_STEPS });

    const calls: string[] = [];
    const git: GitCall = (args) => {
      calls.push(`git ${args.join(' ')}`);
      if (args[0] === 'rev-parse') return { status: 0, stdout: `${'a'.repeat(40)}\n`, stderr: '' };
      if (args[0] === 'ls-remote') return { status: 0, stdout: '', stderr: '' }; // nothing found yet
      if (args[0] === 'fetch') return { status: 0, stdout: '', stderr: '' };
      if (args[0] === 'notes' && args[2] === 'show') {
        return { status: 1, stdout: '', stderr: 'error: no note found for object.' };
      }
      throw new Error(`a shadow run must never reach this real git call: ${args.join(' ')}`);
    };
    const gh: GhCall = (args) => {
      calls.push(`gh ${args.join(' ')}`);
      if (args[0] === 'pr' && args[1] === 'list') return Promise.resolve({ status: 0, stdout: '[]', stderr: '' });
      throw new Error(`a shadow run must never reach this real gh call: ${args.join(' ')}`);
    };
    // The real performer, with only its process boundary faked — exactly `tests/engine.write-executor.test.ts`'s
    // own pattern (`contextFor({ git, gh, mode: 'shadow' })`), reached this time through a real `Reconciler`.
    const writeExecutor: WriteExecutorPort = (intent, context) =>
      performWriteIntent(intent, { ...context, git, gh });

    const reconciler = Reconciler.open({
      orchHome,
      plans: planProvider(plan),
      baseline: { currentRef: () => 'a'.repeat(40), resetTo: () => undefined },
      executor: createScriptedExecutor(committingCapableScript()),
      writeExecutor,
    });
    toClose.push(reconciler);
    const accepted = reconciler.acceptFeature(plan);
    ungatedConfigSnapshot(accepted.run, orchHome);
    reconciler.confirm(accepted.run);

    for (let index = 0; index < 10 && reconciler.load(accepted.run).state.state !== 'committed'; index += 1) {
      await reconciler.pass();
    }

    expect(reconciler.load(accepted.run).state.state).toBe('committed');
    // The real performer did run real probes (this is not vacuous)...
    expect(calls.length).toBeGreaterThan(0);
    // ...but never once the mutating half of any of the three kinds.
    expect(calls.some((call) => call.startsWith('git push'))).toBe(false);
    expect(calls.some((call) => call.includes('notes') && call.includes(' add'))).toBe(false);
    expect(calls.some((call) => call.startsWith('gh pr create'))).toBe(false);

    const events = readEventLog(runPaths(accepted.run, reconciler.orchHome).eventLog);
    expect(events.some((event) => event.type === 'write.executed')).toBe(false);
    expect(events.filter((event) => event.type === 'write.suppressed')).toHaveLength(3);
  });
});

/**
 * AD-24 — `awaiting_merge` joins `PERSON_WAITING_STATES` (matrix row 8), demonstrated the same way the
 * wall clock is proven for `drafting`/`blocked` elsewhere: `measureConsumption` folds a synthetic log and
 * the reading excludes the waiting window rather than counting it.
 */
describe('AD-24 — awaiting_merge is excluded from the wall-clock ceiling (matrix row 8)', () => {
  it('subtracts the time spent waiting for a merge from the measured wall clock', () => {
    const run = '01JBQ8Z1X2Y3W4V5U6T7S8R9Q0';
    const feature = 'awaiting-merge-ceiling';
    const plan = makePlan({ feature });

    const envelope = (
      seq: number,
      ts: string,
      type: string,
      payload: Record<string, unknown> = {},
    ): EventEnvelope => ({ ts, seq, feature, run, step: null, emitter: ENGINE_EMITTER, type, payload });

    const events: EventEnvelope[] = [
      envelope(1, '2026-09-24T00:00:00.000Z', ENGINE_EVENT_TYPES.RunCreated, { mode: 'live' }),
      envelope(2, '2026-09-24T00:05:00.000Z', ENGINE_EVENT_TYPES.FeatureStateChanged, {
        from: 'confirmed',
        to: 'running',
        reason: 'the reconciler claims the first step',
      }),
      // Five minutes of *working* time elapses (00:05 to 00:10) before the run waits for a merge. The
      // five minutes before that is `drafting`, itself a `PERSON_WAITING_STATES` member, so it is
      // excluded on its own account — the assertion below isolates the one window that is neither.
      envelope(3, '2026-09-24T00:10:00.000Z', ENGINE_EVENT_TYPES.FeatureStateChanged, {
        from: 'running',
        to: 'awaiting_merge',
        reason: 'the push and pull-request intents have landed',
      }),
    ];
    const state = rebuildFromLog(events, { run, plan });
    expect(state.state).toBe('awaiting_merge');

    // A person sits on the merge for a further 24 hours the ceiling must never see.
    const now = new Date('2026-09-25T00:10:00.000Z');
    const consumption = measureConsumption({ state, events, now });

    // Elapsed since creation is 24h10m; `drafting` (00:00–00:05) and `awaiting_merge` (00:10 onward) are
    // both excluded, leaving only the five `running` minutes in between — never the 24 hours of waiting.
    expect(consumption.wallClockMs).toBe(5 * 60 * 1000);
  });
});
