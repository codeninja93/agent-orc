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
import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  RUN_STATE_FILE_NAME,
  StepInputSchema,
  dispositionFor,
  makeError,
} from '../src/contracts/index.js';
import type { OrchError, StepDisposition } from '../src/contracts/index.js';
import { readEventLog, runPaths } from '../src/runtime/index.js';
import {
  ENGINE_EMITTER,
  ENGINE_EVENT_TYPES,
  Reconciler,
  ResumeRefused,
  createRecordingResetter,
  createScriptedExecutor,
  createUlidMinter,
  gitBaselineResetter,
  isUlid,
  routeRefusedResume,
  routeTermination,
  terminated,
} from '../src/engine/index.js';
import type {
  BaselineResetter,
  FeaturePlan,
  ScriptedExecutorOptions,
} from '../src/engine/index.js';

import { makeGitWorktree, makeHome, makePlan, planProvider } from './helpers/engine-fixture.js';

const BASELINE = 'a'.repeat(40);

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

describe('a new feature is accepted with a minted run id', () => {
  it('mints a 26-character Crockford base32 ULID and records the checkpoint at drafting', () => {
    const { reconciler } = openReconciler({ script: alwaysCompletes });
    const accepted = reconciler.acceptFeature(makePlan());

    expect(isUlid(accepted.run)).toBe(true);
    expect(accepted.run).toHaveLength(26);
    expect(accepted.state.state).toBe('drafting');
    expect(accepted.state.steps).toStrictEqual([]);
    expect(existsSync(join(runPaths(accepted.run, home).runDir, RUN_STATE_FILE_NAME))).toBe(true);
    expect(eventTypes(accepted.run)).toStrictEqual([ENGINE_EVENT_TYPES.RunCreated]);
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
    expect(executor.started[1]?.attempt).toBe(2);
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
    // Reaching the state without a real crash: the log holds a `step.started` with no termination,
    // which is exactly what a SIGKILL inside the executor leaves behind.
    const { reconciler } = openReconciler({
      script: {
        onStart: (request) => {
          throw new OrphanSignal(request.step);
        },
      },
    });
    const accepted = reconciler.acceptFeature(makePlan());
    reconciler.confirm(accepted.run);
    await expect(reconciler.pass()).rejects.toBeInstanceOf(OrphanSignal);

    const orphaned = reconciler.load(accepted.run);
    expect(orphaned.state.steps[0]?.disposition).toBeNull();

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
  it('records killed and takes no further action across many passes', async () => {
    const resetter = createRecordingResetter(BASELINE);
    const { reconciler, executor } = openReconciler({
      baseline: resetter,
      script: {
        sessionIdFor: (request) => `sess-${request.step}`,
        onStart: (request) =>
          terminated(request.step, 'interrupted', { sessionId: `sess-${request.step}` }),
      },
    });
    const accepted = reconciler.acceptFeature(makePlan());
    reconciler.confirm(accepted.run);
    await reconciler.pass();

    const killed = reconciler.kill(accepted.run);
    expect(killed.state).toBe('killed');
    expect(killed.steps[0]?.disposition).toBe('killed');

    const startsBefore = executor.started.length;
    for (let index = 0; index < 5; index += 1) await reconciler.pass();

    expect(executor.resumed).toStrictEqual([]);
    expect(executor.started).toHaveLength(startsBefore);
    expect(resetter.resets).toStrictEqual([]);
    expect(reconciler.load(accepted.run).state.steps[0]?.disposition).toBe('killed');
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
    const overlappingA = makePlan({ feature: 'alpha', territory: ['src/engine'] });
    const overlappingB = makePlan({ feature: 'beta', territory: ['src/engine/lock.ts'] });
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
    const overlappingA = makePlan({ feature: 'alpha', territory: ['src/engine'] });
    const overlappingB = makePlan({ feature: 'beta', territory: ['src/engine/lock.ts'] });
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

  it('advances two features with disjoint territories in the same pass', async () => {
    const left = makePlan({ feature: 'alpha', territory: ['src/engine'] });
    const right = makePlan({ feature: 'beta', territory: ['docs/specs'] });
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

/** A thrown signal used to leave a step in flight without a real SIGKILL. */
class OrphanSignal extends Error {
  constructor(step: string) {
    super(`the executor vanished inside step "${step}"`);
    this.name = 'OrphanSignal';
  }
}
