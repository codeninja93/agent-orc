/**
 * The world story 2-9's two suites drive: a run with a real AD-9 configuration snapshot declaring the
 * ceilings under test, a clock the test owns, a scripted executor, and a gate runner that records what it
 * was asked to run.
 *
 * **The ceilings come from a real snapshot, not from a parameter.** AD-9 makes the snapshot the only
 * configuration a step reads, and the ceiling logic reads it through the same `readStepConfiguration` the
 * gates do — so a fixture that handed the reconciler its ceilings any other way would be testing a path no
 * production run takes.
 *
 * **The clock is the test's.** Wall-clock is one of the three ceilings and the boundary is exact to the
 * millisecond (matrix rows 15 and 16), so the fixture never reads real time: every line the recorder writes
 * and every measurement the loop takes reads the same injected instant.
 */
import { rmSync } from 'node:fs';

import type { Ceilings, EventEnvelope, ModelRung } from '../../src/contracts/index.js';
import { Reconciler, createScriptedExecutor, takeConfigSnapshot } from '../../src/engine/index.js';
import type {
  DeterministicGateRunner,
  FeaturePlan,
  GateOutcomeRecord,
  GateRunRequest,
  PlanStep,
  ScriptedExecutor,
  ScriptedExecutorOptions,
  WorktreeGit,
} from '../../src/engine/index.js';
import { readEventLog, runPaths } from '../../src/runtime/index.js';

import { fixtureAgent, fixtureProfile, makeWorkspace, writeAgentFile, writeProfile } from './config-fixture.js';
import { makeHome, makePlan, planProvider } from './engine-fixture.js';

/** The instant every run in these suites is created at. */
export const RUN_START_MS = Date.parse('2026-09-23T09:00:00.000Z');

/** A wall-clock ceiling of ten minutes, so the boundaries are round numbers of milliseconds. */
export const TEN_MINUTES_MS = 10 * 60_000;

/**
 * Ceilings loose enough that nothing trips unless a test means it to.
 *
 * The maxima the installer admits, so that a test tightening one ceiling knows the other two are not what
 * tripped: a week of wall clock, ten thousand step attempts and the whole rate-limit window.
 */
export const LOOSE_CEILINGS: Ceilings = {
  steps: 10_000,
  wall_clock_minutes: 10_080,
  rate_limit_budget_percent: 100,
  rate_limit_window_tokens: 10_000_000_000,
};

export interface GateCall {
  readonly step: string;
  readonly command: string;
}

export interface CeilingWorld {
  readonly home: string;
  /** The live reconciler. Replaced by {@link CeilingWorld.restart}, as an engine restart replaces one. */
  readonly reconciler: Reconciler;
  /**
   * Close this engine and open a fresh one over the same `ORCH_HOME`, as a restart after a crash does.
   *
   * `onDurableBoundary` is AD-31's declared seam: the observer may throw at a named boundary, which ends
   * the action there exactly as a kill would — everything before it is durable and nothing after it ran.
   */
  readonly restart: (onDurableBoundary?: (label: string) => void) => void;
  readonly plan: FeaturePlan;
  readonly executor: ScriptedExecutor;
  /** Every gate the runner was asked to run, in order. */
  readonly gateCalls: readonly GateCall[];
  /** Set the clock to `RUN_START_MS + offsetMs`. */
  readonly at: (offsetMs: number) => void;
  /** Accept, snapshot and confirm a run at the current instant. */
  readonly start: () => string;
  readonly events: (run: string) => readonly EventEnvelope[];
  readonly ofType: (run: string, type: string) => readonly EventEnvelope[];
  readonly close: () => void;
}

export const passingGate = (command: string): GateOutcomeRecord => ({
  command,
  declared: `npm run ${command}`,
  outcome: 'passed',
  exitStatus: 0,
  evidence: `evidence/${command}.log`,
  containerName: null,
  summary: `the ${command} gate passed`,
});

export const failingGate = (command: string): GateOutcomeRecord => ({
  ...passingGate(command),
  outcome: 'failed',
  exitStatus: 1,
  summary: `the ${command} gate failed`,
});

export const ceilingWorld = (options: {
  readonly label: string;
  readonly ceilings: Ceilings;
  readonly onStart: ScriptedExecutorOptions['onStart'];
  readonly steps?: readonly PlanStep[];
  readonly worktree?: string;
  readonly worktreeGit?: WorktreeGit;
  /** The rung each phase's agent declares it starts on (AD-17). Defaults to the floor. */
  readonly startTiers?: Readonly<Record<string, ModelRung>>;
  /** What a gate returns. Defaults to every gate passing. */
  readonly gate?: (command: string) => GateOutcomeRecord;
}): CeilingWorld => {
  const home = makeHome(`ceilings-${options.label}`);
  const repository = makeWorkspace(`ceilings-${options.label}-repo`);
  writeProfile(repository, fixtureProfile({ ceilings: options.ceilings }));

  const steps: readonly PlanStep[] = options.steps ?? [
    { step: 'implement', contract_id: 'step.output', phase: 'implementation' },
    { step: 'verify', contract_id: 'step.output', phase: 'verification' },
  ];
  for (const phase of new Set(steps.map((step) => step.phase))) {
    writeAgentFile(
      repository,
      `${phase}.toml`,
      fixtureAgent({
        id: phase,
        tools: ['Read'],
        model: { start_tier: options.startTiers?.[phase] ?? 'claude-haiku-4-5', promotion_policy: 'on-gate-failure' },
      }),
    );
  }

  const plan = makePlan({
    feature: `ceilings-${options.label}`,
    steps,
    ...(options.worktree === undefined ? {} : { worktree: options.worktree }),
  });

  let clock = RUN_START_MS;
  const executor = createScriptedExecutor({ onStart: options.onStart });
  const gateCalls: GateCall[] = [];
  const gate = options.gate ?? passingGate;
  const gates = (request: GateRunRequest): DeterministicGateRunner => ({
    run: (command: string): GateOutcomeRecord => {
      gateCalls.push({ step: request.step, command });
      return gate(command);
    },
  });

  const openReconciler = (onDurableBoundary?: (label: string) => void): Reconciler =>
    Reconciler.open({
      orchHome: home,
      executor,
      plans: planProvider(plan),
      baseline: { currentRef: () => 'ddd9bed4d286ac1f8a0f4f7bfef9530046605787', resetTo: () => undefined },
      now: () => new Date(clock),
      gates,
      ...(options.worktreeGit === undefined ? {} : { worktreeGit: options.worktreeGit }),
      ...(onDurableBoundary === undefined ? {} : { onDurableBoundary }),
    });
  let reconciler = openReconciler();

  const events = (run: string): readonly EventEnvelope[] => readEventLog(runPaths(run, home).eventLog);

  return {
    home,
    get reconciler(): Reconciler {
      return reconciler;
    },
    restart: (onDurableBoundary?: (label: string) => void): void => {
      reconciler.close();
      reconciler = openReconciler(onDurableBoundary);
    },
    plan,
    executor,
    gateCalls,
    at: (offsetMs: number): void => {
      clock = RUN_START_MS + offsetMs;
    },
    start: (): string => {
      const accepted = reconciler.acceptFeature(plan);
      takeConfigSnapshot({ repository, runId: accepted.run, orchHome: home });
      reconciler.confirm(accepted.run);
      return accepted.run;
    },
    events,
    ofType: (run: string, type: string): readonly EventEnvelope[] =>
      events(run).filter((event) => event.type === type),
    close: (): void => {
      reconciler.close();
      rmSync(home, { recursive: true, force: true });
      rmSync(repository, { recursive: true, force: true });
    },
  };
};
