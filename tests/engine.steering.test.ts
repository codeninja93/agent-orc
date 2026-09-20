/**
 * What a consumed intent does, and the guards it cannot get round.
 *
 * `decideSteering` is a pure function of the intent, the folded run state and the ids already applied,
 * so most of this suite drives it directly — a decision is worth asserting without a run, because the
 * decision is where story 1-3's review found the two real defects: `kill` relabelling a *completed* step
 * and `approve` resurrecting a *killed* one. Both are asserted here at the decision surface and again
 * through a real pass, because a guard that holds in the function and is bypassed by the loop is not a
 * guard.
 */
import { rmSync } from 'node:fs';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { COMMANDS, makeError } from '../src/contracts/index.js';
import type { CommandIntent, RunState, StepRecord } from '../src/contracts/index.js';
import { readEventLog, runPaths } from '../src/runtime/index.js';
import {
  COMMAND_EVENT_TYPES,
  COMMAND_HANDLING,
  HONOURED_COMMANDS,
  Reconciler,
  SteeringRefused,
  TAKE_OVER_HANDOFF_CODE,
  blockedStepOf,
  createRecordingResetter,
  createScriptedExecutor,
  decideSteering,
  mintIntentId,
  mintRunId,
  newCommandIntent,
  readIntentFiles,
  terminated,
  writeCommandIntent,
} from '../src/engine/index.js';
import type { ScriptedExecutorOptions } from '../src/engine/index.js';

import { makeHome, makePlan, planProvider } from './helpers/engine-fixture.js';

const BASELINE = 'ddd9bed4d286ac1f8a0f4f7bfef9530046605787';

let home: string;
const toRemove: string[] = [];
const toClose: Reconciler[] = [];

beforeEach(() => {
  home = makeHome('engine-steering');
  toRemove.push(home);
});

afterEach(() => {
  for (const reconciler of toClose.splice(0)) reconciler.close();
  for (const dir of toRemove.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const alwaysCompletes: ScriptedExecutorOptions = {
  onStart: (request) => terminated(request.step, 'completed', { sessionId: `sess-${request.step}` }),
  sessionIdFor: (request) => `sess-${request.step}`,
};

const openReconciler = (
  script: ScriptedExecutorOptions = alwaysCompletes,
): { readonly reconciler: Reconciler; readonly executor: ReturnType<typeof createScriptedExecutor> } => {
  const executor = createScriptedExecutor(script);
  const reconciler = Reconciler.open({
    orchHome: home,
    executor,
    plans: planProvider(makePlan()),
    baseline: createRecordingResetter(BASELINE),
  });
  toClose.push(reconciler);
  return { reconciler, executor };
};

// -------------------------------------------------------------------------------------------------
// The decision, driven directly
// -------------------------------------------------------------------------------------------------

const aStep = (overrides: Partial<StepRecord> = {}): StepRecord => ({
  step: 'implement',
  phase: 'implementation',
  contract_id: 'step.output',
  disposition: null,
  session_id: null,
  baseline_ref: BASELINE,
  model_tier: 'claude-haiku-4-5',
  promotions: 0,
  attempts: 1,
  resets: 0,
  started_at: '2026-09-20T10:00:00.000Z',
  terminated_at: null,
  error: null,
  ...overrides,
});

const aState = (overrides: Partial<RunState> = {}): RunState => ({
  schema_version: 1,
  run: '01K5NQ9ZJ7V3M2P9XQWRTC4BDE',
  feature: 'engine-reconciler',
  mode: 'live',
  state: 'running',
  territory: ['src/engine'],
  steps: [],
  last_event_seq: 4,
  created_at: '2026-09-20T10:00:00.000Z',
  updated_at: '2026-09-20T10:00:00.000Z',
  handoff: null,
  ...overrides,
});

const anIntent = (
  command: CommandIntent['command'],
  step: string | null = null,
  argument: string | null = null,
): CommandIntent =>
  newCommandIntent({
    intentId: mintIntentId(mintRunId()),
    command,
    run: '01K5NQ9ZJ7V3M2P9XQWRTC4BDE',
    feature: 'engine-reconciler',
    step,
    principal: { kind: 'user', id: 'deep' },
    source: 'tui',
    argument,
  });

const noneApplied = { applied: new Set<string>() };

describe('every member of the Command enum has a declared handling', () => {
  it('names an effect, an acknowledgement or the story that owns it, for all of them', () => {
    for (const command of COMMANDS) {
      const handling = COMMAND_HANDLING[command];
      expect(handling, command).toBeDefined();
      if (handling.kind === 'awaiting') expect(handling.owner, command).toMatch(/story/);
    }
    // The eight this build honours: story 1-3's five, plus the three question commands story 1-8
    // un-parked once the AD-25 compare-and-set existed to receive them. A ninth appearing here without
    // a test is what the list is for.
    expect([...HONOURED_COMMANDS].sort()).toStrictEqual([
      'answer',
      'approve',
      'confirm_spec',
      'disengage',
      'edit_criterion',
      'kill',
      'reject',
      'take_over',
    ]);
  });

  it('leaves a command another story owns on disk rather than swallowing it', () => {
    const decision = decideSteering(anIntent('narrow'), aState(), noneApplied);
    expect(decision.kind).toBe('awaiting');
    if (decision.kind !== 'awaiting') return;
    // Story 2-9 owns scope narrowing, and has to be able to see the intent that asked for it.
    expect(decision.owner).toContain('2-9');
  });

  it('routes the three question commands through the AD-25 transition rather than parking them', () => {
    // Story 1-7 parked these three here rather than acknowledge them, because acknowledging would have
    // swallowed a user's answer before the compare-and-set existed. They are honoured now, and they are
    // honoured as *question* commands: the state they change is in questions/, not in the checkpoint.
    for (const command of ['answer', 'reject', 'edit_criterion'] as const) {
      expect(COMMAND_HANDLING[command].kind, command).toBe('question');
      const decision = decideSteering(anIntent(command, null, 'use the first option'), aState(), noneApplied);
      expect(decision.kind, command).toBe('resolve-question');
      if (decision.kind !== 'resolve-question') continue;
      expect(decision.question.answer).toBe('use the first option');
      // The intent's source decides which of AD-25's three resolvers it counts as.
      expect(decision.question.resolver).toBe('tui');
    }
  });

  it('refuses a question command carrying no free text rather than recording a blank decision', () => {
    // A rejection is one keystroke *plus a reason*, and the reason becomes the ledger entry. An empty one
    // would win the compare-and-set and record that the user said nothing.
    for (const command of ['answer', 'reject', 'edit_criterion'] as const) {
      const decision = decideSteering(anIntent(command, null, '   '), aState(), noneApplied);
      expect(decision.kind, command).toBe('refuse');
      if (decision.kind !== 'refuse') continue;
      expect(decision.reason).toBe('missing-answer');
    }
  });

  it('counts a web-sourced answer as the web resolver, so story 3-1 needs no second path', () => {
    const intent = newCommandIntent({
      intentId: mintIntentId(mintRunId()),
      command: 'answer',
      run: '01K5NQ9ZJ7V3M2P9XQWRTC4BDE',
      feature: 'engine-reconciler',
      step: null,
      principal: { kind: 'user', id: 'deep' },
      source: 'web',
      argument: 'the second option',
    });
    const decision = decideSteering(intent, aState(), noneApplied);
    expect(decision.kind).toBe('resolve-question');
    if (decision.kind !== 'resolve-question') return;
    expect(decision.question.resolver).toBe('web');
  });
});

describe('the effect is idempotent on intent_id', () => {
  it('recognises an id already in the log and changes nothing', () => {
    const intent = anIntent('kill');
    const decision = decideSteering(intent, aState(), { applied: new Set([intent.intent_id]) });
    expect(decision.kind).toBe('already-applied');
  });

  it('applies the same command under a different id, because that is a second gesture', () => {
    const first = anIntent('kill');
    const second = anIntent('kill');
    const decision = decideSteering(second, aState(), { applied: new Set([first.intent_id]) });
    expect(decision.kind).toBe('apply');
  });
});

describe('a terminal run refuses every command', () => {
  it.each(['committed', 'killed', 'handed_off', 'hibernated'] as const)(
    'refuses a kill on a %s run, naming the state',
    (state) => {
      const decision = decideSteering(anIntent('kill'), aState({ state }), noneApplied);
      expect(decision.kind).toBe('refuse');
      if (decision.kind !== 'refuse') return;
      expect(decision.reason).toBe('terminal-run');
      expect(decision.detail).toContain(state);
    },
  );

  it('refuses before the command is even read, so no command has its own way round it', () => {
    for (const command of COMMANDS) {
      const decision = decideSteering(anIntent(command), aState({ state: 'committed' }), noneApplied);
      // `answer` is left for its owner before the state is consulted; everything else is refused.
      expect(['refuse', 'awaiting']).toContain(decision.kind);
    }
  });
});

describe('confirming the acceptance criteria', () => {
  it('moves a drafting run to confirmed', () => {
    const decision = decideSteering(anIntent('confirm_spec'), aState({ state: 'drafting' }), noneApplied);
    expect(decision.kind).toBe('apply');
    if (decision.kind !== 'apply') return;
    expect(decision.effect.toState).toBe('confirmed');
  });

  it('treats a second confirmation as already satisfied rather than as a failure', () => {
    // At-least-once delivery means one keystroke can leave two files. The second must be a no-op.
    const decision = decideSteering(anIntent('confirm_spec'), aState({ state: 'running' }), noneApplied);
    expect(decision.kind).toBe('already-satisfied');
  });
});

describe('approving the gate a step blocked at', () => {
  const blocked = aStep({
    disposition: 'blocked',
    terminated_at: '2026-09-20T10:01:00.000Z',
    session_id: 'sess-implement',
    error: makeError('permission.denied', 'an irreversible action needs a person'),
  });

  it('targets the step the disposition table says blocked the run', () => {
    const state = aState({ state: 'blocked', steps: [blocked] });
    expect(blockedStepOf(state)?.step).toBe('implement');

    const decision = decideSteering(anIntent('approve'), state, noneApplied);
    expect(decision.kind).toBe('apply');
    if (decision.kind !== 'apply') return;
    expect(decision.effect.toState).toBe('running');
    expect(decision.effect.step).toBe('implement');
    expect(decision.effect.stepDisposition).toBe('interrupted');
    // The approval spends the condition, so the next pass cannot re-escalate what a person answered.
    expect(decision.effect.clearsStepError).toBe(true);
  });

  it('never targets a completed step, however recently it finished', () => {
    const state = aState({
      steps: [blocked, aStep({ step: 'verify', phase: 'verification', disposition: 'completed' })],
    });
    expect(blockedStepOf(state)?.step).toBe('implement');
  });

  it('never resurrects a killed step', () => {
    const state = aState({
      state: 'running',
      steps: [aStep({ disposition: 'killed', terminated_at: '2026-09-20T10:01:00.000Z' })],
    });
    expect(blockedStepOf(state)).toBeNull();

    const decision = decideSteering(anIntent('approve'), state, noneApplied);
    expect(decision.kind).toBe('apply');
    if (decision.kind !== 'apply') return;
    // Nothing is rewritten: only the run state moves.
    expect(decision.effect.step).toBeNull();
    expect(decision.effect.stepDisposition).toBeNull();
  });
});

describe('stopping the work', () => {
  it('records killed on the step in flight and halts the run, for a kill', () => {
    const state = aState({ steps: [aStep({ session_id: 'sess-implement' })] });
    const decision = decideSteering(anIntent('kill'), state, noneApplied);
    expect(decision.kind).toBe('apply');
    if (decision.kind !== 'apply') return;
    expect(decision.effect.toState).toBe('killed');
    expect(decision.effect.step).toBe('implement');
    expect(decision.effect.stepDisposition).toBe('killed');
  });

  it('reaches the same effect for a disengage, because the Always list says a stop records killed', () => {
    const state = aState({ steps: [aStep()] });
    const kill = decideSteering(anIntent('kill'), state, noneApplied);
    const disengage = decideSteering(anIntent('disengage'), state, noneApplied);
    expect(kill.kind).toBe('apply');
    expect(disengage.kind).toBe('apply');
    if (kill.kind !== 'apply' || disengage.kind !== 'apply') return;
    expect(disengage.effect.toState).toBe(kill.effect.toState);
    expect(disengage.effect.stepDisposition).toBe(kill.effect.stepDisposition);
    // What differs is the record, not the consequence.
    expect(disengage.effect.summary).not.toBe(kill.effect.summary);
  });

  it('never relabels a finished step when nothing is in flight', () => {
    const state = aState({
      steps: [aStep({ disposition: 'completed', terminated_at: '2026-09-20T10:01:00.000Z' })],
    });
    const decision = decideSteering(anIntent('kill'), state, noneApplied);
    expect(decision.kind).toBe('apply');
    if (decision.kind !== 'apply') return;
    expect(decision.effect.toState).toBe('killed');
    // The run stops; the truthful record of work that was done stands.
    expect(decision.effect.step).toBeNull();
    expect(decision.effect.stepDisposition).toBeNull();
  });
});

describe('taking the work over', () => {
  it('asks for the escape hatch, the hand-off and the halt, in one effect', () => {
    const decision = decideSteering(
      anIntent('take_over'),
      aState({ steps: [aStep({ session_id: 'sess-implement' })] }),
      noneApplied,
    );
    expect(decision.kind).toBe('apply');
    if (decision.kind !== 'apply') return;
    expect(decision.effect.escapeHatch).toBe(true);
    expect(decision.effect.toState).toBe('handed_off');
    expect(decision.effect.handoff?.code).toBe(TAKE_OVER_HANDOFF_CODE);
    expect(decision.effect.stepDisposition).toBe('killed');
  });
});

// -------------------------------------------------------------------------------------------------
// The same guards, through a real pass
// -------------------------------------------------------------------------------------------------

describe('the loop applies what the decision decided', () => {
  it('confirms, runs and commits, with the confirmation arriving as an intent file', async () => {
    const { reconciler } = openReconciler();
    const accepted = reconciler.acceptFeature(makePlan());
    expect(reconciler.confirm(accepted.run).state).toBe('confirmed');
    await reconciler.runUntilSettled();
    expect(reconciler.load(accepted.run).state.state).toBe('committed');
  });

  it('approves a blocked gate and lets the run finish', async () => {
    let failVerify = true;
    const { reconciler } = openReconciler({
      sessionIdFor: (request) => `sess-${request.step}`,
      onStart: (request) =>
        request.step === 'verify' && failVerify
          ? terminated(request.step, 'blocked', {
              error: makeError('permission.denied', 'an irreversible gate'),
            })
          : terminated(request.step, 'completed'),
    });
    const accepted = reconciler.acceptFeature(makePlan());
    reconciler.confirm(accepted.run);
    await reconciler.runUntilSettled();
    expect(reconciler.load(accepted.run).state.state).toBe('blocked');

    failVerify = false;
    reconciler.approve(accepted.run, { principal: { kind: 'user', id: 'deep' } });
    await reconciler.runUntilSettled();
    expect(reconciler.load(accepted.run).state.state).toBe('committed');
  });

  it('refuses a steering command on a terminal run, and the terminal state stands', async () => {
    const { reconciler } = openReconciler();
    const accepted = reconciler.acceptFeature(makePlan());
    reconciler.confirm(accepted.run);
    await reconciler.runUntilSettled();
    expect(reconciler.load(accepted.run).state.state).toBe('committed');

    expect(() => reconciler.kill(accepted.run)).toThrowError(SteeringRefused);
    expect(() => reconciler.approve(accepted.run)).toThrowError(SteeringRefused);
    expect(() => reconciler.disengage(accepted.run)).toThrowError(SteeringRefused);
    expect(reconciler.load(accepted.run).state.state).toBe('committed');

    // The refusals are recorded and the files quarantined, not left to be met again.
    const refused = readEventLog(runPaths(accepted.run, home).eventLog).filter(
      (event) => event.type === COMMAND_EVENT_TYPES.Refused,
    );
    expect(refused).toHaveLength(3);
    expect(readIntentFiles(runPaths(accepted.run, home)).pending).toStrictEqual([]);
  });

  it('never rewrites a completed step when a kill arrives between passes', async () => {
    const { reconciler } = openReconciler();
    const accepted = reconciler.acceptFeature(makePlan());
    reconciler.confirm(accepted.run);
    await reconciler.pass();
    expect(reconciler.load(accepted.run).state.steps[0]?.disposition).toBe('completed');

    const killed = reconciler.kill(accepted.run);
    expect(killed.state).toBe('killed');
    expect(killed.steps[0]?.disposition).toBe('completed');
    expect(killed.steps).toHaveLength(1);
  });

  it('applies two intents present in one pass in a deterministic order', async () => {
    const { reconciler } = openReconciler();
    const accepted = reconciler.acceptFeature(makePlan());
    const paths = runPaths(accepted.run, home);

    // A confirmation and a kill, issued in that order, both sitting in the directory at once.
    writeCommandIntent(
      paths,
      newCommandIntent({
        intentId: 'cmd-first',
        command: 'confirm_spec',
        run: accepted.run,
        feature: 'engine-reconciler',
        principal: { kind: 'user', id: 'deep' },
        source: 'tui',
        issuedAt: new Date('2026-09-20T10:00:00.000Z'),
      }),
    );
    writeCommandIntent(
      paths,
      newCommandIntent({
        intentId: 'cmd-second',
        command: 'kill',
        run: accepted.run,
        feature: 'engine-reconciler',
        principal: { kind: 'user', id: 'deep' },
        source: 'tui',
        issuedAt: new Date('2026-09-20T10:00:01.000Z'),
      }),
    );

    const result = await reconciler.pass();
    const applied = result.steering[0]?.applied ?? [];
    expect(applied.map((entry) => entry.intentId)).toStrictEqual(['cmd-first', 'cmd-second']);
    // Both landed, in order, and the second one's effect is the one that stands.
    expect(reconciler.load(accepted.run).state.state).toBe('killed');
  });

  it('takes no other action in a pass that applied an intent', async () => {
    const { reconciler, executor } = openReconciler();
    const accepted = reconciler.acceptFeature(makePlan());
    const paths = runPaths(accepted.run, home);
    writeCommandIntent(
      paths,
      newCommandIntent({
        intentId: mintIntentId(mintRunId()),
        command: 'confirm_spec',
        run: accepted.run,
        feature: 'engine-reconciler',
        principal: { kind: 'user', id: 'deep' },
        source: 'tui',
      }),
    );

    const result = await reconciler.pass();
    expect(result.actions.map((action) => action.kind)).toStrictEqual(['apply-intents']);
    // At most one action per pass: the step the confirmation unblocked starts in the *next* pass.
    expect(executor.started).toStrictEqual([]);

    await reconciler.pass();
    expect(executor.started.map((request) => request.step)).toStrictEqual(['implement']);
  });

  it('refuses a steering command for a run that has no state at all', () => {
    const { reconciler } = openReconciler();
    expect(() => reconciler.confirm('01K5NQ9ZJ7V3M2P9XQWRTC4BDE')).toThrowError();
  });
});
