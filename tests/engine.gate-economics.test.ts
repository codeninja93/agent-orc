/**
 * CAP-13's economics — matrix rows 16 and 20.
 *
 * **The claim.** "Deterministic gates (typecheck, lint, tests) run before any model-based review, and
 * no review spend occurs on a run that fails them." R10 refuses to measure cost in currency, so the
 * observable is *turns*: a run whose gates fail must spawn no review at all.
 *
 * **Asserted by absence, with a positive control in the same suite.** A counter reading zero can read
 * zero because nothing incremented it, so what is asserted is that no `agent.spawned` event exists in
 * the run's log for the verification step — and, in the same suite, on the same wiring, with the same
 * reader, that the event *does* appear when the gates pass. Without the control the absence assertion
 * would pass just as happily against a typo in the event name, a log nobody wrote to, or a reconciler
 * that never reached the step.
 *
 * **The event is the real one.** `agent.spawned` is emitted by `src/engine/spawner.ts` when it creates
 * a child, so the executor here is a real {@link createStepSpawner} over the fake CLI — the same
 * harness `tests/engine.spawner.test.ts` uses, which spawns a real subprocess and spends no model
 * call. A scripted double would have made the control a test of the double.
 *
 * **No container runtime is involved.** The gate runner is reached through the loop's structural port,
 * and the real `createCommandRunner` is driven here over an injected invoker to prove the two are
 * compatible. What ran the gate is a decision, and a decision is assertable without a daemon.
 */
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { dispositionFor } from '../src/contracts/index.js';
import type { EventEnvelope } from '../src/contracts/index.js';
import type { ContainerInvocation, ContainerResult } from '../src/container/index.js';
import {
  ENGINE_EVENT_TYPES,
  Reconciler,
  SPAWNER_EVENT_TYPES,
  createStepSpawner,
  takeConfigSnapshot,
} from '../src/engine/index.js';
import type {
  ChildNode,
  ClaudeCli,
  DeterministicGateRunner,
  FeaturePlan,
  GateOutcomeRecord,
  GateRunRequest,
} from '../src/engine/index.js';
import { createCommandRunner } from '../src/runner/index.js';
import { Recorder, readEventLog, runPaths } from '../src/runtime/index.js';

import {
  fixtureAgent,
  fixtureProfile,
  makeWorkspace,
  writeAgentFile,
  writeProfile,
} from './helpers/config-fixture.js';
import { makeGitWorktree, makeHome, planProvider } from './helpers/engine-fixture.js';

const FAKE_CLI_PATH = fileURLToPath(new URL('./helpers/fake-claude.ts', import.meta.url));
const COMPLETED_FIXTURE = fileURLToPath(
  new URL('./fixtures/stream-json/completed.jsonl', import.meta.url),
);

const fakeCli: ClaudeCli = {
  path: FAKE_CLI_PATH,
  version: '2.1.278',
  auth: 'subscription',
  interpreter: 'node',
};

const childNode: ChildNode = { path: process.execPath, version: '24.21.0', source: 'path' };

let home: string;
const toRemove: string[] = [];
const toClose: { close: () => void }[] = [];

beforeEach(() => {
  home = makeHome('gate-economics');
  toRemove.push(home);
});

afterEach(() => {
  for (const closable of toClose.splice(0)) closable.close();
  for (const dir of toRemove.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** The transcript, with the step name the plan uses, so a completed step really completes. */
const transcriptFor = (step: string): string => {
  const path = join(home, `${step}-transcript.jsonl`);
  writeFileSync(
    path,
    readFileSync(COMPLETED_FIXTURE, 'utf8').split('"step":"implement"').join(`"step":"${step}"`),
    'utf8',
  );
  return path;
};

/**
 * A run assembled the way a real one would be: one recorder, shared by the loop and the spawner.
 *
 * AD-29 makes the recorder the single appender to a run's `events.jsonl` and enforces it with an
 * exclusive claim, so the two units cannot each open one. Sharing it here is what lets the loop's
 * own lines and the spawner's `agent.spawned` land in the same log — which is the log both halves of
 * this suite read.
 */
const world = (options: {
  readonly gates?: (request: GateRunRequest) => DeterministicGateRunner;
  readonly steps?: FeaturePlan['steps'];
}): {
  readonly reconciler: Reconciler;
  readonly plan: FeaturePlan;
  readonly repository: string;
  readonly spawned: string[];
} => {
  const worktree = makeGitWorktree('gate-economics');
  toRemove.push(worktree.dir);
  const repository = makeWorkspace('gate-economics-repo');
  toRemove.push(repository);
  writeProfile(repository, fixtureProfile());
  for (const id of ['implementation', 'verification']) {
    writeAgentFile(repository, `${id}.toml`, fixtureAgent({ id, tools: ['Read'] }));
  }

  const plan: FeaturePlan = {
    feature: 'gate-economics',
    mode: 'live',
    territory: ['src/engine'],
    steps: options.steps ?? [
      { step: 'implement', contract_id: 'step.output', phase: 'implementation' },
      { step: 'verify', contract_id: 'step.output', phase: 'verification' },
    ],
    request: 'make the gate economics observable',
    acceptance_criteria: ['no review spend on a failing run'],
    starting_model_tier: 'claude-haiku-4-5',
    worktree: worktree.dir,
  };

  const recorders = new Map<string, Recorder>();
  const recorderFor = (run: string, feature: string): Recorder => {
    const existing = recorders.get(run);
    if (existing !== undefined) return existing;
    const opened = Recorder.open({ runId: run, feature, orchHome: home });
    recorders.set(run, opened);
    toClose.push(opened);
    return opened;
  };

  const spawned: string[] = [];
  /**
   * One spawner per step, because the fake CLI replays a recorded transcript and a transcript names
   * the step it was recorded for.
   *
   * The spawner re-parses `structured_output` against the contract and refuses an output that
   * reports a different step from the one it asked for (AD-1) — which is a real guard, not an
   * inconvenience, so it is satisfied rather than worked around. Both share the one recorder, so
   * every line still lands in the same log.
   */
  const spawnerFor = (step: string): ReturnType<typeof createStepSpawner> =>
    createStepSpawner({
      recorderFor,
      cli: fakeCli,
      node: childNode,
      env: { ...process.env, FAKE_CLAUDE_FIXTURE: transcriptFor(step) },
      // Resolving the grant off the snapshot would need the run id, which is minted below; the grant
      // is not this suite's subject, and `tests/engine.agents.test.ts` owns that chain end to end.
      grantFor: (request) => ({
        phase: request.phase,
        agentId: request.phase,
        declaredAt: join(repository, '.orch', 'agents', `${request.phase}.toml`),
        rosterDir: join(repository, '.orch', 'agents'),
        tools: ['Read'],
        elevated: [],
        reversibility: 'reversible',
        startTier: 'claude-haiku-4-5',
        summary: `the ${request.phase} agent, granted Read`,
      }),
    });

  const spawners = new Map<string, ReturnType<typeof createStepSpawner>>();
  const spawnerOf = (step: string): ReturnType<typeof createStepSpawner> => {
    const existing = spawners.get(step);
    if (existing !== undefined) return existing;
    const made = spawnerFor(step);
    spawners.set(step, made);
    return made;
  };

  const executor = {
    start: async (request: Parameters<ReturnType<typeof createStepSpawner>['start']>[0]) => {
      spawned.push(request.step);
      return await spawnerOf(request.step).start(request);
    },
    resume: async (request: Parameters<ReturnType<typeof createStepSpawner>['resume']>[0]) =>
      await spawnerOf(request.step).resume(request),
  };

  const reconciler = Reconciler.open({
    orchHome: home,
    executor,
    recorderFor,
    plans: planProvider(plan),
    baseline: {
      currentRef: () => worktree.head,
      resetTo: () => undefined,
    },
    ...(options.gates === undefined ? {} : { gates: options.gates }),
  });
  toClose.push(reconciler);
  return { reconciler, plan, repository, spawned };
};

/** One gate outcome, as the runner reports one. */
const outcome = (overrides: Partial<GateOutcomeRecord> = {}): GateOutcomeRecord => ({
  command: 'test',
  declared: 'npm test',
  outcome: 'passed',
  exitStatus: 0,
  evidence: 'evidence/test-1.log',
  containerName: 'orch-run-verify-test-1',
  summary: 'the test gate passed',
  ...overrides,
});

/** Every event of a run, read back from the log AD-4 makes authoritative. */
const eventsOf = (run: string): readonly EventEnvelope[] => readEventLog(runPaths(run, home).eventLog);

const spawnEventsFor = (run: string, step: string): readonly EventEnvelope[] =>
  eventsOf(run).filter(
    (event) => event.type === SPAWNER_EVENT_TYPES.AgentSpawned && event.step === step,
  );

describe('a failing gate spends no model turn on review (matrix 16)', () => {
  it('spawns no review at all, asserted by the absence of the event', async () => {
    const failing = (): DeterministicGateRunner => ({
      run: (command: string): GateOutcomeRecord =>
        command === 'test'
          ? outcome({ outcome: 'failed', exitStatus: 2 })
          : outcome({ command, declared: `npm run ${command}` }),
    });
    const { reconciler, plan, repository, spawned } = world({ gates: failing });
    const accepted = reconciler.acceptFeature(plan);
    takeConfigSnapshot({ repository, runId: accepted.run, orchHome: home });
    reconciler.confirm(accepted.run);
    await reconciler.runUntilSettled();

    // The assertion the story turns on: no `agent.spawned` for the verification step, anywhere in
    // the run's whole log — across every attempt, every re-run and every promotion.
    expect(spawnEventsFor(accepted.run, 'verify')).toStrictEqual([]);
    // And the executor was never even asked, which is the same fact one layer in: the event is
    // absent because nothing spawned, not because an emitter was renamed.
    expect(spawned).not.toContain('verify');

    // The first tier did run, and said so. Without this the absence above would also be satisfied by
    // a run that never reached the verification step at all.
    const types = eventsOf(accepted.run).map((event) => event.type);
    expect(types).toContain(ENGINE_EVENT_TYPES.GateFailed);
    expect(types).toContain(ENGINE_EVENT_TYPES.ReviewSkipped);
  });

  it('spawns the review when the gates pass, on the same wiring and the same reader', async () => {
    /**
     * The positive control, and the reason the assertion above means anything.
     *
     * One thing differs from the case above: the gate's exit status. Same plan, same executor, same
     * log, same query. If the absence were an artefact of the event name, the reader, the step name
     * or a reconciler that stopped early, this would be empty too.
     */
    const passing = (): DeterministicGateRunner => ({ run: (command) => outcome({ command }) });
    const { reconciler, plan, repository, spawned } = world({ gates: passing });
    const accepted = reconciler.acceptFeature(plan);
    takeConfigSnapshot({ repository, runId: accepted.run, orchHome: home });
    reconciler.confirm(accepted.run);
    await reconciler.runUntilSettled();

    expect(spawnEventsFor(accepted.run, 'verify')).toHaveLength(1);
    expect(spawned).toContain('verify');
    const types = eventsOf(accepted.run).map((event) => event.type);
    expect(types).toContain(ENGINE_EVENT_TYPES.GatePassed);
    expect(types).not.toContain(ENGINE_EVENT_TYPES.ReviewSkipped);
  });

  it('runs the gates before the spawn, not beside it', async () => {
    // Order, not merely presence: a gate recorded after the spawn would mean the review had already
    // been paid for by the time anything was checked. `seq` is what AD-29 gives ordering authority.
    const passing = (): DeterministicGateRunner => ({ run: (command) => outcome({ command }) });
    const { reconciler, plan, repository } = world({ gates: passing });
    const accepted = reconciler.acceptFeature(plan);
    takeConfigSnapshot({ repository, runId: accepted.run, orchHome: home });
    reconciler.confirm(accepted.run);
    await reconciler.runUntilSettled();

    const events = eventsOf(accepted.run);
    const lastGate = Math.max(
      ...events
        .filter((event) => event.type === ENGINE_EVENT_TYPES.GatePassed)
        .map((event) => event.seq),
    );
    const spawn = spawnEventsFor(accepted.run, 'verify')[0]?.seq ?? -1;
    expect(spawn).toBeGreaterThan(lastGate);
  });

  it('runs no gate for a step that is not the verification one', async () => {
    // The two tiers live inside verification, because there is no review agent. An implementation
    // step is spawned without a gate in front of it — and is spawned, which is what makes the
    // absence in the verification case specific rather than global.
    const asked: string[] = [];
    const watching = (request: GateRunRequest): DeterministicGateRunner => {
      asked.push(request.step);
      return { run: (command) => outcome({ command }) };
    };
    const { reconciler, plan, repository } = world({ gates: watching });
    const accepted = reconciler.acceptFeature(plan);
    takeConfigSnapshot({ repository, runId: accepted.run, orchHome: home });
    reconciler.confirm(accepted.run);
    await reconciler.runUntilSettled();

    expect(asked).toStrictEqual(['verify']);
    expect(spawnEventsFor(accepted.run, 'implement')).toHaveLength(1);
  });
});

describe('a failing gate routes per AD-35 and names what failed (matrix 20)', () => {
  it('names the gate and its exit status in the termination', async () => {
    const failing = (): DeterministicGateRunner => ({
      run: (command: string): GateOutcomeRecord =>
        command === 'lint'
          ? outcome({ command, declared: 'npm run lint', outcome: 'failed', exitStatus: 3 })
          : outcome({ command }),
    });
    const { reconciler, plan, repository } = world({ gates: failing });
    const accepted = reconciler.acceptFeature(plan);
    takeConfigSnapshot({ repository, runId: accepted.run, orchHome: home });
    reconciler.confirm(accepted.run);
    await reconciler.runUntilSettled();

    const terminated = eventsOf(accepted.run).filter(
      (event) => event.type === ENGINE_EVENT_TYPES.StepTerminated && event.step === 'verify',
    );
    expect(terminated.length).toBeGreaterThan(0);
    const error = (terminated[0]?.payload as { error?: { code: string; message: string } }).error;
    // The code is the Stack's own promotion trigger — "one promotion per step per run, on a failed
    // verification gate" — so the failure is dispositioned by the table rather than specially.
    expect(error?.code).toBe('step.verification_failed');
    expect(dispositionFor(error?.code ?? '')).toBe('escalate-model-tier');
    // And the message says which gate and what it exited with, so a person does not have to open a
    // transcript to learn what one line could have told them.
    expect(error?.message).toContain('lint');
    expect(error?.message).toContain('3');
  });

  it('promotes the rung and re-runs, and still spawns no review while the gate fails', async () => {
    // The absence holds across the ladder, which is the version of the claim that matters: a run
    // that retried its way into a review would have spent exactly what CAP-13 says it must not.
    const failing = (): DeterministicGateRunner => ({
      run: (command: string): GateOutcomeRecord =>
        command === 'test' ? outcome({ outcome: 'failed', exitStatus: 1 }) : outcome({ command }),
    });
    const { reconciler, plan, repository } = world({ gates: failing });
    const accepted = reconciler.acceptFeature(plan);
    takeConfigSnapshot({ repository, runId: accepted.run, orchHome: home });
    reconciler.confirm(accepted.run);
    await reconciler.runUntilSettled();

    const types = eventsOf(accepted.run).map((event) => event.type);
    expect(types).toContain(ENGINE_EVENT_TYPES.StepTierPromoted);
    expect(spawnEventsFor(accepted.run, 'verify')).toStrictEqual([]);
    expect(reconciler.load(accepted.run).state.state).not.toBe('committed');
  });
});

describe('an engine that cannot run a declared gate does not review anyway', () => {
  it('blocks naming the gates, rather than judging unverified work', async () => {
    /**
     * The fail-closed direction, and the hole this story would otherwise leave.
     *
     * A profile declaring gates plus an engine with no runner wired in is the case where "the gates
     * ran" is simply false. Spawning anyway would spend a review on a change nobody checked, with
     * nothing in the log saying so — a run that *looks* verified. `config.invalid` is
     * `escalate-to-human`: no retry and no model rung wires a runner into an engine.
     */
    const { reconciler, plan, repository } = world({});
    const accepted = reconciler.acceptFeature(plan);
    takeConfigSnapshot({ repository, runId: accepted.run, orchHome: home });
    reconciler.confirm(accepted.run);
    await reconciler.runUntilSettled();

    expect(spawnEventsFor(accepted.run, 'verify')).toStrictEqual([]);
    const terminated = eventsOf(accepted.run).filter(
      (event) => event.type === ENGINE_EVENT_TYPES.StepTerminated && event.step === 'verify',
    );
    const error = (terminated[0]?.payload as { error?: { code: string; message: string } }).error;
    expect(error?.code).toBe('config.invalid');
    expect(dispositionFor(error?.code ?? '')).toBe('escalate-to-human');
    expect(error?.message).toContain('typecheck');
  });
});

describe('the loop and the real runner fit together', () => {
  it('drives the actual command runner through the port, with no container runtime present', async () => {
    /**
     * The seam, exercised rather than asserted in prose.
     *
     * `createCommandRunner` is what a real assembly passes here, and the loop's port is declared
     * structurally so `src/engine/` never imports `src/runner/`. If the two shapes drifted this
     * would not compile — which is the only way a structural seam can be checked — and the gate
     * outcomes below are the real runner's, composed from a real container plan whose execution is
     * the one thing stubbed.
     */
    const invocations: ContainerInvocation[] = [];
    const gates = (request: GateRunRequest): DeterministicGateRunner =>
      createCommandRunner({
        run: request.run,
        step: request.step,
        commands: {
          test: 'npm test',
          typecheck: 'npm run typecheck',
          lint: '',
          build: '',
          run: '',
        },
        worktree: join(home, 'worktrees', request.run),
        orchHome: home,
        image: 'orch-executor:0123456789abcdef',
        invoke: (invocation: ContainerInvocation): ContainerResult => {
          invocations.push(invocation);
          // The test gate fails; the typecheck gate passes. So the run must stop at the first
          // failure's disposition with no review spawned, having really composed both argvs.
          const failing = invocation.args.some((argument) => argument === 'npm test');
          return {
            status: failing ? 1 : 0,
            stdout: '',
            stderr: failing ? '1 failing' : '',
            argv: [...invocation.subcommand, ...invocation.args],
          };
        },
      });

    const { reconciler, plan, repository } = world({ gates });
    const accepted = reconciler.acceptFeature(plan);
    takeConfigSnapshot({ repository, runId: accepted.run, orchHome: home });
    reconciler.confirm(accepted.run);
    await reconciler.runUntilSettled();

    /**
     * One container per declared command, per ADR-001's per-command lifetime — and none at all for
     * the gate that declares nothing.
     *
     * Counted by what went *inside* rather than by how many invocations there were, because the
     * failing gate promotes the rung and the step is re-run, so the declared commands are composed
     * once per attempt. What must hold however many attempts there are is that every container ran
     * a declared line and none ran the empty one.
     */
    const ranInside = invocations.map((invocation) => invocation.args.slice(-3).join(' '));
    expect(new Set(ranInside)).toStrictEqual(
      new Set(['/bin/sh -c npm test', '/bin/sh -c npm run typecheck']),
    );
    expect(ranInside.some((line) => line.endsWith('-c '))).toBe(false);
    expect(invocations.length).toBeGreaterThanOrEqual(2);
    expect(spawnEventsFor(accepted.run, 'verify')).toStrictEqual([]);
    const types = eventsOf(accepted.run).map((event) => event.type);
    expect(types).toContain(ENGINE_EVENT_TYPES.GateSkipped);
    expect(types).toContain(ENGINE_EVENT_TYPES.GateFailed);
  });
});
