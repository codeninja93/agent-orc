/**
 * AD-24 — run ceilings: story 2-9's matrix rows 1–7 and 12–16.
 *
 * **Every assertion is on the state and the log, never on the absence of an error.** A degradation test that
 * passes because nothing threw would pass just as well against a reconciler that never asked the ceilings
 * anything. So each row asserts the feature state the checkpoint folds to *and* the line the log carries,
 * and each behaviour that is supposed to change has a positive control on the same wiring showing what the
 * undegraded run does — a downshifted rung means nothing without the rung the same step starts on when the
 * run is not degraded.
 *
 * **The boundaries are tested at the boundary.** Rows 15 and 16 are claims about exactly eighty and exactly
 * one hundred percent, so the wall-clock ceiling is ten minutes and the clock is set to the millisecond:
 * 479 999 ms does not degrade, 480 000 ms does, 599 999 ms degrades, 600 000 ms hibernates.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  BUDGET_DEGRADED_EVENT_TYPE,
  BUDGET_EXHAUSTED_EVENT_TYPE,
  CeilingsSchema,
  GATE_PASSED_EVENT_TYPE,
  REVIEW_SKIPPED_EVENT_TYPE,
  StepInputSchema,
  findStepRecord,
  makeError,
} from '../src/contracts/index.js';
import type { EventEnvelope, RunState, StepUsage } from '../src/contracts/index.js';
import {
  DEGRADATION_THRESHOLD_PERCENT,
  ENGINE_EVENT_TYPES,
  HIGHEST_MODEL_RUNG,
  LOWEST_MODEL_RUNG,
  ModelRungUnrecognised,
  ceilingVerdict,
  decideAction,
  decideCeilingAction,
  downshiftFor,
  measureConsumption,
  readCeilings,
  runCeilingsFrom,
  skipsModelReview,
  stepInputPath,
  terminated,
} from '../src/engine/index.js';
import type { PassAction, PlanStep, ReconcileAction, StepStartRequest } from '../src/engine/index.js';
import { PROFILE_FILE_NAME } from '../src/contracts/index.js';
import { runPaths } from '../src/runtime/index.js';

import {
  LOOSE_CEILINGS,
  TEN_MINUTES_MS,
  ceilingWorld,
  failingGate,
} from './helpers/ceiling-fixture.js';
import type { CeilingWorld } from './helpers/ceiling-fixture.js';

const worlds: CeilingWorld[] = [];

afterEach(() => {
  for (const world of worlds.splice(0)) world.close();
});

const open = (options: Parameters<typeof ceilingWorld>[0]): CeilingWorld => {
  const world = ceilingWorld(options);
  worlds.push(world);
  return world;
};

const completes = (request: StepStartRequest) => terminated(request.step, 'completed');

/** One pass, and the action it took for this run. */
const passOnce = async (world: CeilingWorld, run: string): Promise<PassAction | null> => {
  const result = await world.reconciler.pass();
  return result.actions.find((action) => action.run === run) ?? null;
};

const stateOf = (world: CeilingWorld, run: string): RunState => world.reconciler.load(run).state;

/** Every state a `feature.state_changed` line entered, in log order. */
const statesEntered = (world: CeilingWorld, run: string): readonly string[] =>
  world
    .ofType(run, ENGINE_EVENT_TYPES.FeatureStateChanged)
    .map((event) => String(event.payload['to']));

const implementationSteps = (count: number): readonly PlanStep[] =>
  Array.from({ length: count }, (_, index) => ({
    step: `step-${String(index + 1)}`,
    contract_id: 'step.output',
    phase: 'implementation' as const,
  }));

const WALL_CLOCK_TEN_MINUTES = { ...LOOSE_CEILINGS, wall_clock_minutes: 10 };

const usage = (overrides: Partial<StepUsage>): StepUsage => ({
  cost_usd: null,
  input_tokens: null,
  output_tokens: null,
  cache_creation_input_tokens: null,
  cache_read_input_tokens: null,
  ...overrides,
});

describe('any one ceiling crossing eighty percent degrades the run (matrix rows 1–3)', () => {
  it('degrades on the step ceiling once four of five step attempts are spent, and not at three', async () => {
    const world = open({
      label: 'steps',
      ceilings: { ...LOOSE_CEILINGS, steps: 5 },
      steps: implementationSteps(6),
      onStart: completes,
    });
    const run = world.start();

    const kinds: string[] = [];
    for (let index = 0; index < 4; index += 1) kinds.push((await passOnce(world, run))?.kind ?? 'none');
    // Positive control: three attempts is sixty percent, and four ordinary steps ran without a word.
    expect(kinds).toStrictEqual(['run-step', 'run-step', 'run-step', 'run-step']);
    expect(world.ofType(run, BUDGET_DEGRADED_EVENT_TYPE)).toStrictEqual([]);
    expect(stateOf(world, run).state).toBe('running');

    const degraded = await passOnce(world, run);
    expect(degraded?.kind).toBe('degrade');
    expect(degraded?.to).toBe('degraded');
    expect(stateOf(world, run).state).toBe('degraded');
    expect(stateOf(world, run).degradation?.dimension).toBe('steps');
    const [line] = world.ofType(run, BUDGET_DEGRADED_EVENT_TYPE);
    expect(line?.payload).toMatchObject({ dimension: 'steps', consumed: 4, ceiling: 5, fraction: 0.8 });
  });

  it('degrades on the wall-clock ceiling, measured on the run’s own clock', async () => {
    const world = open({ label: 'wall', ceilings: WALL_CLOCK_TEN_MINUTES, onStart: completes });
    const run = world.start();
    world.at(500_000);

    const action = await passOnce(world, run);

    expect(action?.kind).toBe('degrade');
    expect(stateOf(world, run).state).toBe('degraded');
    const [line] = world.ofType(run, BUDGET_DEGRADED_EVENT_TYPE);
    expect(line?.payload).toMatchObject({
      dimension: 'wall_clock',
      consumed: 500_000,
      ceiling: TEN_MINUTES_MS,
      // The key the TUI folds an estimate from, carrying the real remainder rather than a constant.
      wall_clock_ms_remaining: 100_000,
    });
  });

  it('degrades on the rate-limit budget once recorded token counts reach eighty percent of it', async () => {
    // Half of the window this profile declares is the run's whole rate-limit allowance: 100 000 tokens.
    // Against the placeholder window the same usage would be under one percent, so tripping here is
    // what shows the size is read from the profile and not from a constant.
    const allowance = 100_000;
    const world = open({
      label: 'rate',
      ceilings: { ...LOOSE_CEILINGS, rate_limit_budget_percent: 50, rate_limit_window_tokens: 200_000 },
      onStart: (request) =>
        terminated(request.step, 'completed', {
          usage: usage({ input_tokens: allowance * 0.5, output_tokens: allowance * 0.3 }),
        }),
    });
    const run = world.start();

    expect((await passOnce(world, run))?.kind).toBe('run-step');
    expect(world.ofType(run, BUDGET_DEGRADED_EVENT_TYPE)).toStrictEqual([]);

    expect((await passOnce(world, run))?.kind).toBe('degrade');
    expect(stateOf(world, run).state).toBe('degraded');
    const [line] = world.ofType(run, BUDGET_DEGRADED_EVENT_TYPE);
    expect(line?.payload).toMatchObject({
      dimension: 'rate_limit_budget',
      consumed: allowance * 0.8,
      ceiling: allowance,
      rate_limit_budget_consumed: 0.8,
    });
  });
});

describe('degradation is a standing condition: once, and for good (matrix row 4)', () => {
  it('emits no second budget.degraded when a second ceiling crosses eighty percent', async () => {
    const world = open({
      label: 'second-ceiling',
      ceilings: { ...LOOSE_CEILINGS, steps: 10, wall_clock_minutes: 10 },
      steps: implementationSteps(9),
      onStart: completes,
    });
    const run = world.start();
    for (let index = 0; index < 8; index += 1) await passOnce(world, run);
    expect((await passOnce(world, run))?.kind).toBe('degrade');
    expect(world.ofType(run, BUDGET_DEGRADED_EVENT_TYPE)).toHaveLength(1);

    // Now the wall clock crosses eighty percent as well, while the step ceiling still stands at eighty.
    world.at(500_000);
    const next = await passOnce(world, run);

    expect(next?.kind).toBe('run-step');
    expect(world.ofType(run, BUDGET_DEGRADED_EVENT_TYPE)).toHaveLength(1);
    expect(stateOf(world, run).state).toBe('degraded');
    // The first line stands: the dimension recorded is the one that crossed first.
    expect(stateOf(world, run).degradation?.dimension).toBe('steps');
  });

  it('answers an already-degraded run’s eighty-percent verdict with the action it had chosen', () => {
    const action: ReconcileAction = {
      kind: 'run-step',
      step: { step: 'verify', contract_id: 'step.output', phase: 'verification' },
      transitionTo: 'degraded',
      reason: 'the next step',
    };
    const readings = readCeilings(
      { steps: 9, wallClockMs: 0, rateLimitTokens: null },
      runCeilingsFrom({ ...LOOSE_CEILINGS, steps: 10 }),
    );
    const verdict = ceilingVerdict(readings);
    expect(verdict.kind).toBe('degrade');
    const base = { degradation: null } as const;

    // Positive control: the same verdict on a run that has not degraded yet is a `degrade`.
    expect(decideCeilingAction(action, { ...stateFixture(), ...base }, verdict, null).kind).toBe('degrade');
    const degradedState: RunState = {
      ...stateFixture(),
      state: 'degraded',
      degradation: { dimension: 'wall_clock', recorded_at: '2026-09-23T09:05:00.000Z' },
    };
    expect(decideCeilingAction(action, degradedState, verdict, null)).toBe(action);
    // And a run with more room than when it degraded is not un-degraded either: the action is its own, and
    // `decideAction` already gave it `degraded` as its working state.
    const roomier = ceilingVerdict(
      readCeilings({ steps: 1, wallClockMs: 0, rateLimitTokens: null }, runCeilingsFrom({ ...LOOSE_CEILINGS, steps: 10 })),
    );
    expect(roomier.kind).toBe('within');
    expect(decideCeilingAction(action, degradedState, roomier, null)).toBe(action);
  });

  it('never takes a degraded run back to running, through a gate and an interruption', async () => {
    const world = open({
      label: 'no-flap',
      ceilings: WALL_CLOCK_TEN_MINUTES,
      onStart: (request, attempt) => {
        if (request.step !== 'implement') return completes(request);
        if (attempt === 1) {
          return terminated(request.step, 'blocked', {
            error: makeError('permission.denied', 'the step needs a person to approve a write'),
          });
        }
        if (attempt === 2) return terminated(request.step, 'interrupted');
        return completes(request);
      },
    });
    const run = world.start();
    world.at(500_000);
    expect((await passOnce(world, run))?.kind).toBe('degrade');

    // The clock holds at eighty-three percent from here, so every later pass meets the same `degrade` verdict
    // on a run that has already degraded — which is exactly what must not re-emit or reset anything.
    expect((await passOnce(world, run))?.kind).toBe('run-step');
    expect((await passOnce(world, run))?.kind).toBe('escalate-to-human');
    expect(stateOf(world, run).state).toBe('blocked');

    const approved = world.reconciler.approve(run);
    expect(approved.state).toBe('degraded');

    await world.reconciler.runUntilSettled();
    expect(stateOf(world, run).state).toBe('committed');

    const entered = statesEntered(world, run);
    const afterDegrading = entered.slice(entered.indexOf('degraded'));
    // The run passed through blocked and interrupted — the fixture is verifiably not a straight line …
    expect(afterDegrading).toContain('blocked');
    expect(afterDegrading).toContain('interrupted');
    // … and never once returned to an undegraded working state.
    expect(afterDegrading.filter((state) => state === 'running' || state === 'verifying')).toStrictEqual([]);
    const appliedTo = world
      .ofType(run, 'command.applied')
      .map((event) => event.payload['to_state'])
      .filter((to) => to !== undefined);
    expect(appliedTo).not.toContain('running');
    expect(world.ofType(run, BUDGET_DEGRADED_EVENT_TYPE)).toHaveLength(1);
  });
});

describe('a degraded run downshifts toward the floor (matrix row 5)', () => {
  it('starts the same step one rung lower each attempt, bottoming out at the floor', async () => {
    const onStart = (request: StepStartRequest, attempt: number) =>
      request.step === 'implement' && attempt < 3
        ? terminated(request.step, 'failed', { error: makeError('step.timed_out', 'slow') })
        : completes(request);

    // Positive control: undegraded, the step starts on the rung its agent declares.
    const control = open({
      label: 'downshift-control',
      ceilings: WALL_CLOCK_TEN_MINUTES,
      startTiers: { implementation: 'claude-opus-5' },
      onStart,
    });
    const controlRun = control.start();
    await control.reconciler.runUntilSettled();
    expect(control.executor.started.filter((r) => r.step === 'implement').map((r) => r.modelTier)).toStrictEqual([
      'claude-opus-5',
      'claude-opus-5',
      'claude-opus-5',
    ]);
    expect(control.ofType(controlRun, ENGINE_EVENT_TYPES.StepTierDownshifted)).toStrictEqual([]);

    const world = open({
      label: 'downshift',
      ceilings: WALL_CLOCK_TEN_MINUTES,
      startTiers: { implementation: 'claude-opus-5' },
      onStart,
    });
    const run = world.start();
    world.at(500_000);
    await world.reconciler.runUntilSettled();

    expect(world.executor.started.filter((r) => r.step === 'implement').map((r) => r.modelTier)).toStrictEqual([
      'claude-sonnet-5',
      'claude-haiku-4-5',
      'claude-haiku-4-5',
    ]);
    const downshifts = world.ofType(run, ENGINE_EVENT_TYPES.StepTierDownshifted);
    expect(downshifts.map((event) => [event.payload['from'], event.payload['to']])).toStrictEqual([
      ['claude-opus-5', 'claude-sonnet-5'],
      ['claude-sonnet-5', 'claude-haiku-4-5'],
    ]);
    // Distinguishable from a promotion: its own type, naming budget pressure as its trigger.
    expect(downshifts.every((event) => event.payload['trigger'] === BUDGET_DEGRADED_EVENT_TYPE)).toBe(true);
    expect(world.ofType(run, ENGINE_EVENT_TYPES.StepTierPromoted)).toStrictEqual([]);
  });

  it('moves one rung down, and stops at the floor rather than going past it', () => {
    expect(downshiftFor(HIGHEST_MODEL_RUNG)).toMatchObject({ from: 'claude-opus-5', to: 'claude-sonnet-5', moved: true });
    expect(downshiftFor('claude-sonnet-5')).toMatchObject({ to: 'claude-haiku-4-5', moved: true });
    expect(downshiftFor(LOWEST_MODEL_RUNG)).toMatchObject({ from: LOWEST_MODEL_RUNG, to: LOWEST_MODEL_RUNG, moved: false });
  });

  it('refuses a rung it cannot place rather than treating it as the floor', () => {
    expect(() => downshiftFor('claude-mythical-9')).toThrowError(ModelRungUnrecognised);
  });
});

describe('a degraded run narrows scope to the deterministic gates (matrix row 6)', () => {
  it('runs every gate and spawns no review, where the undegraded run spawns one', async () => {
    const control = open({ label: 'narrow-control', ceilings: WALL_CLOCK_TEN_MINUTES, onStart: completes });
    const controlRun = control.start();
    await control.reconciler.runUntilSettled();
    // Positive control: undegraded, the verification step's review is spawned after the gates pass.
    expect(control.executor.started.map((request) => request.step)).toStrictEqual(['implement', 'verify']);
    expect(control.ofType(controlRun, REVIEW_SKIPPED_EVENT_TYPE)).toStrictEqual([]);

    const world = open({ label: 'narrow', ceilings: WALL_CLOCK_TEN_MINUTES, onStart: completes });
    const run = world.start();
    world.at(500_000);
    await world.reconciler.runUntilSettled();

    // The deterministic gates all ran, for the verification step, and each said so in the log.
    expect(world.gateCalls.filter((call) => call.step === 'verify').map((call) => call.command)).toStrictEqual([
      'typecheck',
      'lint',
      'test',
    ]);
    expect(world.ofType(run, GATE_PASSED_EVENT_TYPE).filter((event) => event.step === 'verify')).toHaveLength(3);
    // The review, and only the review, was cut: every planned step still ran, and the executor was
    // handed the implementation step with every acceptance criterion the plan declared.
    expect(world.executor.started.map((request) => request.step)).toStrictEqual(['implement']);
    expect(world.executor.started[0]?.input.acceptance_criteria).toStrictEqual([...world.plan.acceptance_criteria]);
    const [skipped] = world.ofType(run, REVIEW_SKIPPED_EVENT_TYPE);
    expect(skipped?.payload).toMatchObject({ narrowed_by: BUDGET_DEGRADED_EVENT_TYPE, failed_gates: [] });
    expect(findStepRecord(stateOf(world, run), 'verify')?.disposition).toBe('completed');
    expect(stateOf(world, run).state).toBe('committed');
  });

  it('narrows a degraded verification only when a gate passed and none failed', () => {
    const skippedGates = [{ outcome: 'skipped' as const }, { outcome: 'skipped' as const }];
    // Skipped-only, or no gates at all, verify nothing — the review is kept rather than leaving the step
    // verified by nothing, which this story's Boundaries forbid.
    expect(skipsModelReview({ degraded: true, phase: 'verification', gates: skippedGates })).toBe(false);
    expect(skipsModelReview({ degraded: true, phase: 'verification', gates: [] })).toBe(false);
    expect(skipsModelReview({ degraded: true, phase: 'verification', gates: [{ outcome: 'passed' }] })).toBe(true);
    // A failing gate is never narrowed past: it is disposed as any failing gate is (row 7).
    expect(
      skipsModelReview({ degraded: true, phase: 'verification', gates: [{ outcome: 'passed' }, { outcome: 'failed' }] }),
    ).toBe(false);
    // Only verification is narrowed, and only a degraded run's.
    expect(skipsModelReview({ degraded: true, phase: 'implementation', gates: [{ outcome: 'passed' }] })).toBe(false);
    expect(skipsModelReview({ degraded: false, phase: 'verification', gates: [{ outcome: 'passed' }] })).toBe(false);
  });
});

describe('degradation does not weaken a gate (matrix row 7)', () => {
  /** Drive a run until its verification step has failed once, and return that state. */
  const untilVerifyFails = async (world: CeilingWorld, run: string): Promise<RunState> => {
    for (let index = 0; index < 10; index += 1) {
      if (findStepRecord(stateOf(world, run), 'verify')?.disposition === 'failed') break;
      await passOnce(world, run);
    }
    return stateOf(world, run);
  };

  it('disposes a degraded run’s failing gate exactly as an undegraded run’s', async () => {
    const control = open({
      label: 'gate-fails-control',
      ceilings: WALL_CLOCK_TEN_MINUTES,
      onStart: completes,
      gate: (command) => (command === 'test' ? failingGate(command) : { ...failingGate(command), outcome: 'passed', exitStatus: 0 }),
    });
    const controlRun = control.start();
    const undegraded = await untilVerifyFails(control, controlRun);

    const world = open({
      label: 'gate-fails',
      ceilings: WALL_CLOCK_TEN_MINUTES,
      onStart: completes,
      gate: (command) => (command === 'test' ? failingGate(command) : { ...failingGate(command), outcome: 'passed', exitStatus: 0 }),
    });
    const run = world.start();
    world.at(500_000);
    const degraded = await untilVerifyFails(world, run);
    expect(degraded.degradation).not.toBeNull();
    expect(undegraded.degradation).toBeNull();

    // The same failure, recorded the same way …
    const failure = (state: RunState) => findStepRecord(state, 'verify')?.error?.code;
    expect(failure(degraded)).toBe('step.verification_failed');
    expect(failure(degraded)).toBe(failure(undegraded));
    const failedGates = (w: CeilingWorld, r: string) =>
      w.ofType(r, REVIEW_SKIPPED_EVENT_TYPE).map((event) => event.payload['failed_gates']);
    expect(failedGates(world, run)).toStrictEqual([['test']]);
    expect(failedGates(world, run)).toStrictEqual(failedGates(control, controlRun));

    // … and routed the same way: the AD-35 table's answer, the same step, the same promotion granted.
    const next = decideAction(degraded, world.plan);
    const controlNext = decideAction(undegraded, control.plan);
    expect(next).toMatchObject({ kind: 'reset-and-rerun', step: 'verify', promoteTo: 'claude-sonnet-5' });
    expect(controlNext).toMatchObject({ kind: 'reset-and-rerun', step: 'verify', promoteTo: 'claude-sonnet-5' });
    // The one difference is the state the run works in while it re-runs the step.
    expect(next).toMatchObject({ transitionTo: 'degraded' });
    expect(controlNext).toMatchObject({ transitionTo: 'verifying' });
    // No review was spent on a failing gate in either run.
    expect(world.executor.started.map((request) => request.step)).not.toContain('verify');
    expect(control.executor.started.map((request) => request.step)).not.toContain('verify');
  });

  it('declines the promotion a failing gate earned, and says so, rather than climbing a degraded run', async () => {
    const world = open({
      label: 'declined-promotion',
      ceilings: WALL_CLOCK_TEN_MINUTES,
      onStart: completes,
      gate: (command) => (command === 'test' ? failingGate(command) : { ...failingGate(command), outcome: 'passed', exitStatus: 0 }),
    });
    const run = world.start();
    world.at(500_000);
    await untilVerifyFails(world, run);
    await passOnce(world, run);

    expect(world.ofType(run, ENGINE_EVENT_TYPES.StepTierPromoted)).toStrictEqual([]);
    const [downshift] = world.ofType(run, ENGINE_EVENT_TYPES.StepTierDownshifted);
    expect(downshift?.payload).toMatchObject({
      declined_promotion: 'claude-sonnet-5',
      to: 'claude-haiku-4-5',
      trigger: BUDGET_DEGRADED_EVENT_TYPE,
    });
    expect(findStepRecord(stateOf(world, run), 'verify')?.promotions).toBe(0);
  });
});

describe('consumed rate-limit budget is read from recorded usage, never currency (matrix row 12)', () => {
  it('ignores the one usage figure that is not a token count, however large', async () => {
    const world = open({
      label: 'no-currency',
      ceilings: { ...LOOSE_CEILINGS, rate_limit_budget_percent: 50, rate_limit_window_tokens: 200_000 },
      onStart: (request) =>
        terminated(request.step, 'completed', { usage: usage({ cost_usd: 1_000_000_000, input_tokens: 10 }) }),
    });
    const run = world.start();
    await world.reconciler.runUntilSettled();

    // Positive control is the rate-limit row above, on the same ceiling: tokens do trip it.
    expect(world.ofType(run, BUDGET_DEGRADED_EVENT_TYPE)).toStrictEqual([]);
    expect(stateOf(world, run).state).toBe('committed');
  });

  it('carries no currency key in a budget line’s payload', async () => {
    const world = open({ label: 'payload-keys', ceilings: WALL_CLOCK_TEN_MINUTES, onStart: completes });
    const run = world.start();
    world.at(500_000);
    await passOnce(world, run);
    const [line] = world.ofType(run, BUDGET_DEGRADED_EVENT_TYPE);
    expect(line).toBeDefined();
    expect(Object.keys(line?.payload ?? {}).filter((key) => /usd|cost|currency|dollar/i.test(key))).toStrictEqual([]);
    // The plan's count and the step-attempt ceiling are two figures, named as two, each with its unit.
    expect(line?.payload).toMatchObject({ unit: 'ms', plan_steps_remaining: 2, measurable: true });
    expect(line?.payload).not.toHaveProperty('steps_remaining');
  });

  it('names no currency figure anywhere in the ceiling module’s code', () => {
    const source = readFileSync(new URL('../src/engine/ceilings.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/cost_usd|\busd\b|dollar|\$\d/i);
  });
});

describe('the step input carries a budget measured for real (task 1, matrix rows 13 and 14)', () => {
  it('measures wall clock from the run’s start, not from when the latest step began', async () => {
    const world = open({ label: 'run-clock', ceilings: WALL_CLOCK_TEN_MINUTES, onStart: completes });
    const run = world.start();
    // The first step starts late, so a step-based clock would read far less than the run's.
    world.at(400_000);
    expect((await passOnce(world, run))?.kind).toBe('run-step');
    world.at(500_000);

    const action = await passOnce(world, run);

    // Eighty-three percent of the run's clock; a clock started with the step would read seventeen.
    expect(action?.kind).toBe('degrade');
    expect(world.ofType(run, BUDGET_DEGRADED_EVENT_TYPE)[0]?.payload['consumed']).toBe(500_000);
  });

  it('hands a step the real remainder, the real consumed share, and the plan-derived steps remaining', async () => {
    const allowance = 100_000;
    const world = open({
      label: 'budget-input',
      ceilings: { ...WALL_CLOCK_TEN_MINUTES, rate_limit_budget_percent: 10, rate_limit_window_tokens: 1_000_000 },
      steps: implementationSteps(2),
      onStart: (request) =>
        terminated(request.step, 'completed', { usage: usage({ output_tokens: allowance / 4 }) }),
    });
    const run = world.start();
    world.at(400_000);
    await passOnce(world, run);
    world.at(450_000);
    await passOnce(world, run);

    const input = StepInputSchema.parse(
      JSON.parse(readFileSync(stepInputPath(runPaths(run, world.home), 'step-2'), 'utf8')),
    );
    expect(input.budget).toStrictEqual({
      // Two declared steps, one completed: unchanged from how it was always computed (row 14).
      steps_remaining: 1,
      // Ten minutes less the 450 000 ms since the run began — not less the 50 000 since step-1 did, and
      // not the one-hour constant this field carried before story 2-9.
      wall_clock_ms_remaining: 150_000,
      rate_limit_budget_consumed: 0.25,
    });
  });
});

describe('the boundaries are exact (matrix rows 15 and 16)', () => {
  it('does not degrade one millisecond under eighty percent', async () => {
    const world = open({ label: 'under-80', ceilings: WALL_CLOCK_TEN_MINUTES, onStart: completes });
    const run = world.start();
    world.at(479_999);
    expect((await passOnce(world, run))?.kind).toBe('run-step');
    expect(world.ofType(run, BUDGET_DEGRADED_EVENT_TYPE)).toStrictEqual([]);
    expect(stateOf(world, run).degradation).toBeNull();
  });

  it('degrades sitting exactly on eighty percent', async () => {
    const world = open({ label: 'at-80', ceilings: WALL_CLOCK_TEN_MINUTES, onStart: completes });
    const run = world.start();
    world.at(480_000);
    expect((await passOnce(world, run))?.kind).toBe('degrade');
    expect(stateOf(world, run).state).toBe('degraded');
    expect(world.ofType(run, BUDGET_DEGRADED_EVENT_TYPE)[0]?.payload['fraction']).toBe(0.8);
  });

  it('degrades, and does not hibernate, one millisecond under the ceiling', async () => {
    const world = open({ label: 'under-100', ceilings: WALL_CLOCK_TEN_MINUTES, onStart: completes });
    const run = world.start();
    world.at(599_999);
    expect((await passOnce(world, run))?.kind).toBe('degrade');
    expect(world.ofType(run, BUDGET_EXHAUSTED_EVENT_TYPE)).toStrictEqual([]);
  });

  it('hibernates, and does not merely degrade again, exactly at the ceiling', async () => {
    const world = open({ label: 'at-100', ceilings: WALL_CLOCK_TEN_MINUTES, onStart: completes });
    const run = world.start();
    world.at(600_000);
    const action = await passOnce(world, run);
    expect(action?.kind).toBe('hibernate');
    expect(stateOf(world, run).state).toBe('hibernated');
    expect(world.ofType(run, BUDGET_EXHAUSTED_EVENT_TYPE)).toHaveLength(1);
    expect(world.ofType(run, BUDGET_DEGRADED_EVENT_TYPE)).toStrictEqual([]);
    expect(world.executor.started).toStrictEqual([]);
  });

  it('decides the boundary in whole numbers, where a quotient would round', () => {
    const verdictAt = (tokens: number, window: number) =>
      ceilingVerdict(
        readCeilings(
          { steps: 0, wallClockMs: 0, rateLimitTokens: tokens },
          runCeilingsFrom({ ...LOOSE_CEILINGS, rate_limit_budget_percent: 50, rate_limit_window_tokens: window }),
        ),
      ).kind;
    expect(DEGRADATION_THRESHOLD_PERCENT).toBe(80);
    // A window that divides evenly: an allowance of 5 000 000 tokens, eighty percent of it 4 000 000.
    expect(verdictAt(3_999_999, 10_000_000)).toBe('within');
    expect(verdictAt(4_000_000, 10_000_000)).toBe('degrade');
    expect(verdictAt(4_999_999, 10_000_000)).toBe('degrade');
    expect(verdictAt(5_000_000, 10_000_000)).toBe('hibernate');
    // A declared window that does not: an allowance of 500 000.5 tokens, eighty percent of it 400 000.4.
    expect(verdictAt(400_000, 1_000_001)).toBe('within');
    expect(verdictAt(400_001, 1_000_001)).toBe('degrade');
    expect(verdictAt(500_000, 1_000_001)).toBe('degrade');
    expect(verdictAt(500_001, 1_000_001)).toBe('hibernate');
  });

  it('treats a ceiling it cannot divide by as reached, and says so with a finite figure', () => {
    const verdict = ceilingVerdict(
      readCeilings({ steps: 0, wallClockMs: 0, rateLimitTokens: null }, runCeilingsFrom({ ...LOOSE_CEILINGS, steps: 0 })),
    );
    // Exactly 1 and flagged, never NaN or Infinity — either would serialise as `null` and hide the overshoot.
    expect(verdict).toMatchObject({ kind: 'hibernate', reading: { dimension: 'steps', fraction: 1, measurable: false } });
    const unparseable = ceilingVerdict(
      readCeilings({ steps: 0, wallClockMs: Number.NaN, rateLimitTokens: null }, runCeilingsFrom(LOOSE_CEILINGS)),
    );
    expect(unparseable).toMatchObject({ kind: 'hibernate', reading: { dimension: 'wall_clock', fraction: 1, measurable: false } });
  });

  it('breaks a tie between two ceilings at the same fraction by the declared order', () => {
    // Steps and wall clock both sit exactly on eighty percent: one verdict, naming steps, declared first.
    const verdict = ceilingVerdict(
      readCeilings(
        { steps: 8, wallClockMs: 480_000, rateLimitTokens: null },
        runCeilingsFrom({ ...LOOSE_CEILINGS, steps: 10, wall_clock_minutes: 10 }),
      ),
    );
    expect(verdict).toMatchObject({ kind: 'degrade', reading: { dimension: 'steps' } });
    // Positive control: the fuller one wins when they differ, whichever comes first.
    const fuller = ceilingVerdict(
      readCeilings(
        { steps: 8, wallClockMs: 540_000, rateLimitTokens: null },
        runCeilingsFrom({ ...LOOSE_CEILINGS, steps: 10, wall_clock_minutes: 10 }),
      ),
    );
    expect(fuller).toMatchObject({ kind: 'degrade', reading: { dimension: 'wall_clock' } });
  });

  it('degrades once when two ceilings cross eighty percent on the same pass', async () => {
    const world = open({
      label: 'simultaneous',
      ceilings: { ...LOOSE_CEILINGS, steps: 5, wall_clock_minutes: 10 },
      steps: implementationSteps(6),
      onStart: completes,
    });
    const run = world.start();
    for (let index = 0; index < 4; index += 1) await passOnce(world, run);
    world.at(480_000);
    expect((await passOnce(world, run))?.kind).toBe('degrade');
    const lines = world.ofType(run, BUDGET_DEGRADED_EVENT_TYPE);
    expect(lines).toHaveLength(1);
    expect(lines[0]?.payload['dimension']).toBe('steps');
  });

  it('reports an overshoot unclamped in the budget.exhausted line, for both figures', async () => {
    const world = open({ label: 'overshoot', ceilings: WALL_CLOCK_TEN_MINUTES, onStart: completes });
    const run = world.start();
    world.at(700_000);
    await passOnce(world, run);
    const [line] = world.ofType(run, BUDGET_EXHAUSTED_EVENT_TYPE);
    expect(line?.payload['fraction']).toBeCloseTo(700_000 / 600_000);
    expect(line?.payload['wall_clock_ms_remaining']).toBe(-100_000);
  });
});

/** A minimal checkpoint for the pure-function rows. */
const stateFixture = (): RunState => ({
  schema_version: 1,
  run: '01K5NQ9ZJ7V3M2P9XQWRTC4BDE',
  feature: 'ceilings',
  mode: 'live',
  state: 'running',
  territory: ['src/engine'],
  steps: [],
  last_event_seq: 4,
  created_at: '2026-09-23T09:00:00.000Z',
  updated_at: '2026-09-23T09:00:00.000Z',
  handoff: null,
  degradation: null,
  pending_gate: null,
});

describe('the ceilings a run is held to come from its snapshot, or the fallback, never silently from neither', () => {
  it('blocks, and starts nothing, when the snapshot’s profile exists and cannot be read', async () => {
    const world = open({ label: 'unreadable', ceilings: WALL_CLOCK_TEN_MINUTES, onStart: completes });
    const run = world.start();
    writeFileSync(join(runPaths(run, world.home).configDir, PROFILE_FILE_NAME), 'ceilings = [not toml\n', 'utf8');

    const action = await passOnce(world, run);

    expect(action?.kind).toBe('escalate-to-human');
    expect(stateOf(world, run).state).toBe('blocked');
    expect(world.executor.started).toStrictEqual([]);
    expect(world.ofType(run, ENGINE_EVENT_TYPES.StepStarted)).toStrictEqual([]);
  });

  it('holds a run with no snapshot to the declared fallback, so it still degrades', async () => {
    const world = open({ label: 'fallback', ceilings: WALL_CLOCK_TEN_MINUTES, onStart: completes });
    const run = world.startWithoutSnapshot();
    // Forty-eight of the fallback's sixty minutes: past the snapshot's ten, which is not what is read here.
    world.at(47 * 60_000);
    expect((await passOnce(world, run))?.kind).toBe('run-step');
    world.at(48 * 60_000);
    expect((await passOnce(world, run))?.kind).toBe('degrade');
  });

  it('refuses a hand-edited ceiling outside the bounds the interview enforces', () => {
    const valid = { steps: 10, wall_clock_minutes: 10, rate_limit_budget_percent: 50 };
    expect(CeilingsSchema.safeParse(valid).success).toBe(true);
    expect(CeilingsSchema.safeParse({ ...valid, steps: 0 }).success).toBe(false);
    expect(CeilingsSchema.safeParse({ ...valid, wall_clock_minutes: 10_081 }).success).toBe(false);
    expect(CeilingsSchema.safeParse({ ...valid, rate_limit_budget_percent: 101 }).success).toBe(false);
    expect(CeilingsSchema.safeParse({ ...valid, rate_limit_window_tokens: 10_000_000_001 }).success).toBe(false);
  });
});

describe('a degraded run that goes on to reach a ceiling hibernates (the common route: degrade, then exhaust)', () => {
  it('hibernates from degraded, once, rather than spending past its ceiling', async () => {
    const world = open({ label: 'degrade-then-exhaust', ceilings: WALL_CLOCK_TEN_MINUTES, onStart: completes });
    const run = world.start();
    world.at(500_000);
    expect((await passOnce(world, run))?.kind).toBe('degrade');
    expect((await passOnce(world, run))?.kind).toBe('run-step');
    expect(stateOf(world, run).state).toBe('degraded');

    world.at(600_000);
    expect((await passOnce(world, run))?.kind).toBe('hibernate');

    expect(stateOf(world, run).state).toBe('hibernated');
    expect(world.ofType(run, BUDGET_EXHAUSTED_EVENT_TYPE)).toHaveLength(1);
    const last = world.ofType(run, ENGINE_EVENT_TYPES.FeatureStateChanged).at(-1);
    expect(last?.payload).toMatchObject({ from: 'degraded', to: 'hibernated' });
    // The verify step never spent: hibernation replaced it.
    expect(world.executor.started.map((request) => request.step)).toStrictEqual(['implement']);
  });
});

describe('the wall clock stops while a run waits on a person (AD-24 bounds work, not waiting)', () => {
  it('does not count two hours spent blocked at a gate', async () => {
    const world = open({
      label: 'blocked-time',
      ceilings: WALL_CLOCK_TEN_MINUTES,
      onStart: (request, attempt) =>
        request.step === 'implement' && attempt === 1
          ? terminated(request.step, 'blocked', { error: makeError('permission.denied', 'needs a person') })
          : completes(request),
    });
    const run = world.start();
    await passOnce(world, run);
    expect((await passOnce(world, run))?.kind).toBe('escalate-to-human');

    world.at(2 * 60 * 60_000);
    world.reconciler.approve(run);
    world.at(2 * 60 * 60_000 + 60_000);
    await world.reconciler.runUntilSettled();

    expect(world.ofType(run, BUDGET_DEGRADED_EVENT_TYPE)).toStrictEqual([]);
    expect(world.ofType(run, BUDGET_EXHAUSTED_EVENT_TYPE)).toStrictEqual([]);
    expect(stateOf(world, run).state).toBe('committed');
  });

  it('does not count time spent in drafting before the criteria were confirmed', async () => {
    const world = open({ label: 'drafting-time', ceilings: WALL_CLOCK_TEN_MINUTES, onStart: completes });
    const run = world.start(2 * 60 * 60_000);
    world.at(2 * 60 * 60_000 + 60_000);
    expect((await passOnce(world, run))?.kind).toBe('run-step');
    expect(world.ofType(run, BUDGET_EXHAUSTED_EVENT_TYPE)).toStrictEqual([]);
  });

  it('still counts working time — the positive control for both', async () => {
    const world = open({ label: 'working-time', ceilings: WALL_CLOCK_TEN_MINUTES, onStart: completes });
    const run = world.start();
    world.at(2 * 60 * 60_000 + 60_000);
    expect((await passOnce(world, run))?.kind).toBe('hibernate');
  });
});

describe('what counts against the rate-limit budget (review items I and J)', () => {
  it('does not count cache reads, however many, against the budget', async () => {
    const world = open({
      label: 'cache-reads',
      ceilings: { ...LOOSE_CEILINGS, rate_limit_budget_percent: 50, rate_limit_window_tokens: 200_000 },
      onStart: (request) =>
        terminated(request.step, 'completed', {
          usage: usage({ cache_read_input_tokens: 5_000_000, input_tokens: 10 }),
        }),
    });
    const run = world.start();
    await world.reconciler.runUntilSettled();
    // Positive control is the rate-limit row: the same ceiling, tripped by counted tokens.
    expect(world.ofType(run, BUDGET_DEGRADED_EVENT_TYPE)).toStrictEqual([]);
    expect(stateOf(world, run).state).toBe('committed');
  });

  it('sums each attempt’s reported usage once, and a killed attempt that reported none adds nothing', () => {
    const line = (seq: number, disposition: string, usageFigure: StepUsage | null): EventEnvelope => ({
      ts: '2026-09-23T09:00:00.000Z',
      seq,
      feature: 'ceilings',
      run: '01K5NQ9ZJ7V3M2P9XQWRTC4BDE',
      step: 'implement',
      emitter: 'engine.reconciler',
      type: ENGINE_EVENT_TYPES.StepTerminated,
      payload: { disposition, ...(usageFigure === null ? {} : { usage: usageFigure }) },
    });
    const consumption = measureConsumption({
      state: stateFixture(),
      events: [
        line(1, 'killed', null),
        line(2, 'interrupted', null),
        line(3, 'completed', usage({ input_tokens: 300, output_tokens: 20 })),
      ],
      now: new Date('2026-09-23T09:00:00.000Z'),
    });
    expect(consumption.rateLimitTokens).toBe(320);
    // Nothing recorded at all is absence, not zero.
    expect(measureConsumption({ state: stateFixture(), events: [line(1, 'killed', null)], now: new Date() }).rateLimitTokens).toBeNull();
  });
});

describe('degradation reaches a resumed attempt too (review item B)', () => {
  const interruptedOnce = (request: StepStartRequest) =>
    terminated(request.step, 'interrupted', { sessionId: `sess-${request.step}` });

  it('downshifts a resumed attempt, where the undegraded run resumes on its recorded rung', async () => {
    const build = (label: string) =>
      open({
        label,
        ceilings: WALL_CLOCK_TEN_MINUTES,
        startTiers: { implementation: 'claude-opus-5' },
        sessionIdFor: (request) => `sess-${request.step}`,
        onStart: (request) => (request.step === 'implement' ? interruptedOnce(request) : completes(request)),
        onResume: (request) => terminated(request.step, 'completed', { sessionId: request.sessionId }),
      });

    const control = build('resume-control');
    const controlRun = control.start();
    await control.reconciler.runUntilSettled();
    expect(control.executor.resumed.map((request) => request.modelTier)).toStrictEqual(['claude-opus-5']);
    expect(control.ofType(controlRun, ENGINE_EVENT_TYPES.StepTierDownshifted)).toStrictEqual([]);

    const world = build('resume-degraded');
    const run = world.start();
    await passOnce(world, run);
    world.at(500_000);
    expect((await passOnce(world, run))?.kind).toBe('degrade');
    await world.reconciler.runUntilSettled();

    expect(world.executor.resumed.map((request) => request.modelTier)).toStrictEqual(['claude-sonnet-5']);
    const [downshift] = world.ofType(run, ENGINE_EVENT_TYPES.StepTierDownshifted);
    expect(downshift?.payload).toMatchObject({ from: 'claude-opus-5', to: 'claude-sonnet-5', resumed: true });
  });

  it('does not resume an interrupted review on a degraded run, where the undegraded run resumes it', async () => {
    const build = (label: string) =>
      open({
        label,
        ceilings: WALL_CLOCK_TEN_MINUTES,
        sessionIdFor: (request) => `sess-${request.step}`,
        onStart: (request) => (request.step === 'verify' ? interruptedOnce(request) : completes(request)),
        onResume: (request) => terminated(request.step, 'completed', { sessionId: request.sessionId }),
      });

    const control = build('resume-review-control');
    const controlRun = control.start();
    await control.reconciler.runUntilSettled();
    expect(control.executor.resumed.map((request) => request.step)).toStrictEqual(['verify']);
    expect(control.ofType(controlRun, REVIEW_SKIPPED_EVENT_TYPE)).toStrictEqual([]);

    const world = build('resume-review');
    const run = world.start();
    await passOnce(world, run);
    await passOnce(world, run);
    expect(findStepRecord(stateOf(world, run), 'verify')?.disposition).toBe('interrupted');
    world.at(500_000);
    expect((await passOnce(world, run))?.kind).toBe('degrade');
    await world.reconciler.runUntilSettled();

    expect(world.executor.resumed).toStrictEqual([]);
    const [skipped] = world.ofType(run, REVIEW_SKIPPED_EVENT_TYPE);
    expect(skipped?.payload).toMatchObject({ narrowed_by: BUDGET_DEGRADED_EVENT_TYPE, resumed: true });
    expect(findStepRecord(stateOf(world, run), 'verify')?.disposition).toBe('completed');
  });
});

describe('a crash between budget.degraded and the state change is finished without a second line', () => {
  it('enters degraded on the next pass, with one budget.degraded', async () => {
    const world = open({ label: 'degrade-crash', ceilings: WALL_CLOCK_TEN_MINUTES, onStart: completes });
    const run = world.start();
    world.at(500_000);
    world.restart((label) => {
      if (label === `event-appended:${BUDGET_DEGRADED_EVENT_TYPE}`) throw new Error('killed after budget.degraded');
    });
    const crashed = await world.reconciler.pass();
    expect(crashed.refusals.map((refusal) => refusal.run)).toContain(run);
    // The fact is durable; the state change is not.
    expect(stateOf(world, run).degradation).not.toBeNull();
    expect(stateOf(world, run).state).not.toBe('degraded');

    world.restart();
    expect((await passOnce(world, run))?.kind).toBe('run-step');

    expect(stateOf(world, run).state).toBe('degraded');
    expect(world.ofType(run, BUDGET_DEGRADED_EVENT_TYPE)).toHaveLength(1);
    expect(statesEntered(world, run).filter((state) => state === 'degraded')).toHaveLength(1);
  });
});
