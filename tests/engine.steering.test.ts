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
import { readFileSync, readdirSync, rmSync } from 'node:fs';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  COMMANDS,
  CURRENT_SCHEMA_VERSION,
  CommandIntentSchema,
  commandRequiresArgument,
  makeError,
} from '../src/contracts/index.js';
import type { Command, CommandIntent, PendingGate, RunState, StepRecord } from '../src/contracts/index.js';
import { readEventLog, runPaths } from '../src/runtime/index.js';
import {
  COMMAND_EVENT_TYPES,
  COMMAND_HANDLING,
  GATE_REJECTED_HANDOFF_CODE,
  HONOURED_COMMANDS,
  commandAvailabilities,
  QUESTION_COMMANDS,
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
  credited_attempts: 0,
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
  degradation: null,
  pending_gate: null,
  pending_note: null,
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
    /**
     * Text for the commands that are meaningless without it, and nothing for the rest.
     *
     * The contract refuses `answer`, `reject`, `edit_criterion`, `narrow` and `inject_note` with no
     * argument, so a fixture that handed every command a `null` one could not build those five at all.
     * Asked of the contract rather than listed here, so this fixture cannot drift from the rule it is
     * satisfying.
     */
    argument: argument ?? (commandRequiresArgument(command) ? `text for ${command}` : null),
  });

/**
 * An intent built without the contract's own check, for the engine-side guards that stand behind it.
 *
 * `decideSteering` takes a `CommandIntent` value, and its blank-argument refusal is defence in depth:
 * the contract refuses such an intent at every boundary it can be read through, and the engine refuses
 * it again if one ever arrives another way. Asserting the second guard means handing it a value the
 * first would have stopped, which is what this builder is for — and the suite asserts the first guard
 * on the same value, so neither layer can quietly stop holding.
 */
const anUnvalidatedIntent = (
  command: CommandIntent['command'],
  argument: string | null,
): CommandIntent => ({
  schema_version: CURRENT_SCHEMA_VERSION,
  intent_id: mintIntentId(mintRunId()),
  command,
  run: '01K5NQ9ZJ7V3M2P9XQWRTC4BDE',
  feature: 'engine-reconciler',
  step: null,
  principal: { kind: 'user', id: 'deep' },
  source: 'tui',
  issued_at: '2026-09-20T10:00:00.000Z',
  argument,
});

/**
 * Nothing applied yet.
 *
 * A `Map` rather than a `Set` since the ledger began carrying the command beside the id: the id alone
 * cannot tell a redelivery from a second command reusing an id, and the second used to be dropped as
 * "already applied" with no effect and no refusal.
 */
const noneApplied = { applied: new Map<string, Command>() };

describe('every member of the Command enum has a declared handling', () => {
  it('names an effect, an acknowledgement or the story that owns it, for all of them', () => {
    for (const command of COMMANDS) {
      const handling = COMMAND_HANDLING[command];
      expect(handling, command).toBeDefined();
      if (handling.kind === 'awaiting') expect(handling.owner, command).toMatch(/story/);
    }
    // Story 4-3 un-parks the last four `awaiting` commands (`narrow`, `pause`, `inject_note`, `fork`),
    // so the list grows from eight to twelve. A thirteenth appearing here without a test is what the
    // list is for.
    expect([...HONOURED_COMMANDS].sort()).toStrictEqual([
      'answer',
      'approve',
      'confirm_spec',
      'disengage',
      'edit_criterion',
      'fork',
      'inject_note',
      'kill',
      'narrow',
      'pause',
      'reject',
      'take_over',
    ]);
  });

  /**
   * Story 4-3 closes the last four commands this build ever parked: `narrow`, `pause`, `inject_note` and
   * `fork` were the whole of `COMMAND_HANDLING`'s `awaiting` bucket, and none of them is any longer.
   *
   * There is therefore no real `Command` enum member left to drive `decideSteering`'s `awaiting` branch
   * with — the exact question this story's own instructions asked to be checked, and this is the answer.
   * The branch itself is untouched (a later story may park a new command the same way), so this asserts
   * the fact about *today's* table rather than exercising code nothing currently reaches.
   */
  it('parks no command on a later story any longer', () => {
    for (const command of COMMANDS) {
      expect(COMMAND_HANDLING[command].kind, command).not.toBe('awaiting');
    }
  });

  it('lists every disposition in the enum’s declaration order, as it says it does', () => {
    // `Object.keys(COMMAND_HANDLING)` is the object literal's key order, which is the same order today
    // and a claim about the wrong thing: AD-3 makes the enum the single declaration both renderers are
    // built against, so reordering the table must not reorder a surface's controls.
    expect(commandAvailabilities().map((availability) => availability.command)).toStrictEqual([
      ...COMMANDS,
    ]);
    expect(HONOURED_COMMANDS.every((command) => COMMANDS.includes(command))).toBe(true);
  });

  /**
   * The durable form of the same rule: **no parked command may name a story that is already finished.**
   *
   * This caught the *drift* a reverted `awaiting` entry would not — a command still waiting on a story
   * that has since shipped, which is what "story 1-9" became the day 1-9 was marked done, and what
   * `narrow`/`pause`/`inject_note`/`fork` would have become the day story 4-3 shipped without this test
   * ever failing. Story 4-3 is this story, and the "parks no command" test above already asserts the
   * loop below now finds nothing at all — kept anyway, so a *future* story that parks a new command the
   * same way still gets this guard for free rather than needing it reinvented.
   */
  it('never parks a command on a story that is already done', () => {
    const storiesDir = new URL('../docs/specs/spec-agent-orchestrator/stories/', import.meta.url);
    const files = readdirSync(storiesDir).filter((name) => name.endsWith('.md'));
    expect(files.length).toBeGreaterThan(0);

    /** The status in a story file's frontmatter, quoted or not, or `null` when the story has no file. */
    const statusOf = (story: string): string | null => {
      const file = files.find((name) => name.startsWith(`${story}-`));
      if (file === undefined) return null;
      const source = readFileSync(new URL(file, storiesDir), 'utf8');
      return /^status:\s*'?"?([a-z-]+)'?"?\s*$/mu.exec(source)?.[1] ?? null;
    };

    // At least one owner names a story that exists, so a regex that stopped matching would be noticed.
    let checked = 0;
    for (const command of COMMANDS) {
      const handling = COMMAND_HANDLING[command];
      if (handling.kind !== 'awaiting') continue;
      const story = /\bstory (\d+-\d+)/u.exec(handling.owner)?.[1];
      expect(story, `${command}: "${handling.owner}" names no story`).toBeDefined();
      if (story === undefined) continue;
      const status = statusOf(story);
      if (status !== null) checked += 1;
      expect(status, `${command} waits on story ${story}, which is ${String(status)}`).not.toBe('done');
    }
    // No command is awaiting any longer (the test above), so the loop above finds nothing to check —
    // this asserts only that `statusOf` itself still works, using a story that does have a file.
    expect(statusOf('1-9')).toBe('done');
    expect(checked).toBe(0);
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
      const blank = anUnvalidatedIntent(command, '   ');
      // The contract refuses it first: an intent file carrying this never reaches a consumer at all.
      expect(CommandIntentSchema.safeParse(blank).success, command).toBe(false);
      // And the engine refuses it too, so the guard does not rest on the parse alone.
      const decision = decideSteering(blank, aState(), noneApplied);
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
    const decision = decideSteering(intent, aState(), { applied: new Map([[intent.intent_id, 'kill']]) });
    expect(decision.kind).toBe('already-applied');
  });

  it('applies the same command under a different id, because that is a second gesture', () => {
    const first = anIntent('kill');
    const second = anIntent('kill');
    const decision = decideSteering(second, aState(), { applied: new Map([[first.intent_id, 'kill']]) });
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

  it('refuses every one of the fourteen, including the ones a later story owns', () => {
    /**
     * The terminal guard used to sit *after* the `awaiting` branch, so seven of the fourteen commands could
     * never be refused at all: an `answer`, `pause`, `fork`, `reject`, `narrow`, `inject_note` or
     * `edit_criterion` addressed to a terminal run was neither refused nor quarantined, and its file was
     * re-read and re-parsed by every pass and every 25ms mid-step poll for ever. A terminal run has no
     * owner left to wait for — story 2-9 will not resume a committed feature either — and this story's own
     * Always list says an intent for a run in a terminal state is refused naming the reason.
     */
    for (const command of COMMANDS) {
      const decision = decideSteering(anIntent(command), aState({ state: 'committed' }), noneApplied);
      expect(decision.kind).toBe('refuse');
      if (decision.kind !== 'refuse') continue;
      expect(decision.reason).toBe('terminal-run');
      expect(decision.detail).toContain('committed');
    }
  });

  it('refuses each of the three question commands on a terminal run, with real text in hand', () => {
    /**
     * The three question commands, named one at a time with a non-empty argument, because that is the only
     * shape in which the guard can fail. Moving the `handling.kind === 'question'` block above the terminal
     * check returns `resolve-question` here — a durable decision written about stopped work — and a fixture
     * whose `argument` was `null` would not notice: `missing-answer` is a refusal too, so an assertion on
     * `kind` alone stays green. The refusal *reason* is therefore what is asserted.
     */
    // Driven from the exported list rather than from a literal of its own, so the table that decides
    // which commands are question commands is the table this guard is asserted over.
    expect([...QUESTION_COMMANDS].sort()).toStrictEqual(['answer', 'edit_criterion', 'reject']);
    for (const command of QUESTION_COMMANDS) {
      expect(COMMAND_HANDLING[command].kind, command).toBe('question');
      const intent = anIntent(command, null, 'the second option, and log it either way');
      expect(intent.argument).not.toBeNull();
      for (const state of ['committed', 'killed', 'handed_off', 'hibernated'] as const) {
        const decision = decideSteering(intent, aState({ state }), noneApplied);
        expect(decision.kind, `${command} on ${state}`).toBe('refuse');
        if (decision.kind !== 'refuse') continue;
        // `terminal-run`, not `missing-answer`: the guard held for the reason it exists.
        expect(decision.reason, `${command} on ${state}`).toBe('terminal-run');
        expect(decision.detail, `${command} on ${state}`).toContain(state);
      }
    }
  });

  it('quarantines an awaiting command’s file on a terminal run, so no later pass meets it', async () => {
    const { reconciler } = openReconciler();
    const accepted = reconciler.acceptFeature(makePlan());
    reconciler.confirm(accepted.run);
    await reconciler.runUntilSettled();
    expect(reconciler.load(accepted.run).state.state).toBe('committed');

    const paths = runPaths(accepted.run, home);
    writeCommandIntent(
      paths,
      newCommandIntent({
        intentId: mintIntentId(mintRunId()),
        command: 'pause',
        run: accepted.run,
        feature: 'engine-reconciler',
        principal: { kind: 'user', id: 'deep' },
        source: 'tui',
      }),
    );

    const result = await reconciler.pass();
    const refused = result.steering.flatMap((entry) => entry.refused);
    expect(refused.map((entry) => entry.reason)).toStrictEqual(['terminal-run']);
    expect(readIntentFiles(paths).pending).toStrictEqual([]);
  });
});

describe('an intent id is a key for one command, not for any command', () => {
  it('refuses a different command reusing an id the log already holds', () => {
    /**
     * The ledger keys on the id, so without the command beside it a second intent reusing an id was
     * recognised as "already applied" and dropped: no effect, no refusal, nothing anywhere saying it did
     * nothing. A reused id is a writer's fault, and being told beats being ignored.
     */
    const reused = anIntent('kill');
    const decision = decideSteering(reused, aState(), {
      applied: new Map([[reused.intent_id, 'confirm_spec']]),
    });
    expect(decision.kind).toBe('refuse');
    if (decision.kind !== 'refuse') return;
    expect(decision.reason).toBe('intent-id-reused');
    expect(decision.detail).toContain('confirm_spec');
  });

  it('still recognises a redelivery of the same command under the same id', () => {
    const redelivered = anIntent('kill');
    const decision = decideSteering(redelivered, aState(), {
      applied: new Map([[redelivered.intent_id, 'kill']]),
    });
    expect(decision.kind).toBe('already-applied');
  });

  it('recognises a redelivery when the log does not say which command it was', () => {
    // A `command.applied` whose `command` field is missing or unrecognised: the id was applied, but for
    // what is unknown, so a later intent carrying it cannot be called a mismatch on evidence nobody has.
    const redelivered = anIntent('kill');
    const decision = decideSteering(redelivered, aState(), {
      applied: new Map([[redelivered.intent_id, null]]),
    });
    expect(decision.kind).toBe('already-applied');
  });
});

describe('approving needs a gate to approve (CAP-2)', () => {
  it.each(['drafting', 'confirmed', 'running', 'verifying', 'interrupted', 'degraded'] as const)(
    'refuses an approve on a %s run, because confirm_spec is the only way into execution',
    (state) => {
      /**
       * `approve` returned `toState: 'running'` for **any** non-terminal state, so an approve on a
       * `drafting` run put a feature whose acceptance criteria were never confirmed straight into
       * execution. CAP-2 is "no feature enters execution without user-confirmed acceptance criteria" and
       * `confirm_spec` is its only gate; `blocked` is the one state `decideAction` answers with
       * `await-approval`.
       */
      const decision = decideSteering(anIntent('approve'), aState({ state }), noneApplied);
      expect(decision.kind).toBe('refuse');
      if (decision.kind !== 'refuse') return;
      expect(decision.reason).toBe('wrong-target-state');
      expect(decision.detail).toContain(state);
    },
  );

  it('is not refused for the one state that has a gate', () => {
    const decision = decideSteering(anIntent('approve'), aState({ state: 'blocked' }), noneApplied);
    expect(decision.kind).toBe('apply');
  });
});

describe('a stop gesture carries no target-state guard, deliberately', () => {
  it.each(['kill', 'disengage', 'take_over'] as const)(
    'applies %s from every non-terminal state, because disengagement is always available',
    (command) => {
      // The interface contract says disengagement is "instant, obvious and always available", and a run
      // parked in `drafting` or waiting at a gate is exactly the run a person most wants to abandon.
      for (const state of ['drafting', 'confirmed', 'running', 'blocked', 'verifying', 'interrupted'] as const) {
        expect(decideSteering(anIntent(command), aState({ state }), noneApplied).kind).toBe('apply');
      }
    },
  );
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
    // `blocked`, because that is now the only state an approval has a gate to answer: CAP-2 keeps
    // `confirm_spec` as the sole way into execution, so an approve on any other state is refused. What is
    // under test here is unchanged — a killed step is never the step an approval targets.
    const state = aState({
      state: 'blocked',
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

/** A pending AD-12 gate, as `RunState.pending_gate` carries one. */
const aGate = (overrides: Partial<PendingGate> = {}): PendingGate => ({
  step: 'commit',
  intent_id: 'commit.git_push',
  kind: 'git_push',
  reversibility: 'irreversible',
  batch: [
    { intent_id: 'commit.git_push', kind: 'git_push' },
    { intent_id: 'commit.pull_request', kind: 'pull_request' },
  ],
  resolution: 'pending',
  ...overrides,
});

describe('story 4-1 — a pending AD-12 gate is resolved, never mistaken for a step failure', () => {
  it('approving a gated run emits a gateResolution and touches no step (matrix row 2)', () => {
    const state = aState({ state: 'blocked', pending_gate: aGate() });
    const decision = decideSteering(anIntent('approve'), state, noneApplied);
    expect(decision.kind).toBe('apply');
    if (decision.kind !== 'apply') return;
    expect(decision.effect.toState).toBe('running');
    expect(decision.effect.step).toBeNull();
    expect(decision.effect.stepDisposition).toBeNull();
    expect(decision.effect.clearsStepError).toBe(false);
    expect(decision.effect.gateResolution).toStrictEqual({
      intentId: 'commit.git_push',
      outcome: 'approved',
    });
  });

  it('returns a degraded run to degraded, not running, once its gate is approved (AD-24)', () => {
    const state = aState({
      state: 'blocked',
      pending_gate: aGate(),
      degradation: { dimension: 'steps', recorded_at: '2026-09-20T10:00:00.000Z' },
    });
    const decision = decideSteering(anIntent('approve'), state, noneApplied);
    expect(decision.kind).toBe('apply');
    if (decision.kind !== 'apply') return;
    expect(decision.effect.toState).toBe('degraded');
  });

  it('rejecting a gated run emits a gateResolution and hands the run off with the reason (matrix row 4)', () => {
    const state = aState({ state: 'blocked', pending_gate: aGate() });
    const decision = decideSteering(
      anIntent('reject', null, 'this push touches a path nobody reviewed'),
      state,
      noneApplied,
    );
    expect(decision.kind).toBe('apply');
    if (decision.kind !== 'apply') return;
    expect(decision.effect.toState).toBe('handed_off');
    expect(decision.effect.step).toBeNull();
    expect(decision.effect.stepDisposition).toBeNull();
    expect(decision.effect.gateResolution).toStrictEqual({
      intentId: 'commit.git_push',
      outcome: 'rejected',
    });
    expect(decision.effect.handoff?.code).toBe(GATE_REJECTED_HANDOFF_CODE);
    expect(decision.effect.handoff?.reason).toContain('this push touches a path nobody reviewed');
  });

  it('refuses a blank reject at a gate rather than recording an empty decision', () => {
    const state = aState({ state: 'blocked', pending_gate: aGate() });
    const blank = anUnvalidatedIntent('reject', '   ');
    const decision = decideSteering(blank, state, noneApplied);
    expect(decision.kind).toBe('refuse');
    if (decision.kind !== 'refuse') return;
    expect(decision.reason).toBe('missing-answer');
  });

  it('leaves approve/reject byte-for-byte unchanged when no gate is pending (matrix row 5)', () => {
    // No gate, an ordinary running state: approve still refuses `wrong-target-state`, exactly as before
    // this story, because `pending_gate` is `null` here.
    const approveDecision = decideSteering(anIntent('approve'), aState({ state: 'running' }), noneApplied);
    expect(approveDecision.kind).toBe('refuse');
    if (approveDecision.kind === 'refuse') expect(approveDecision.reason).toBe('wrong-target-state');

    // No gate, no open question: reject still falls through to its pre-existing question handling.
    const rejectDecision = decideSteering(
      anIntent('reject', null, 'use the first option'),
      aState(),
      noneApplied,
    );
    expect(rejectDecision.kind).toBe('resolve-question');
  });

  describe('round-1 review — resolution decides everything, never pending_gate !== null alone', () => {
    it('refuses a later approve once the gate was already rejected, rather than silently resuming (matrix row 11)', () => {
      const state = aState({ state: 'blocked', pending_gate: aGate({ resolution: 'rejected' }) });
      const decision = decideSteering(anIntent('approve'), state, noneApplied);
      expect(decision.kind).toBe('refuse');
      if (decision.kind !== 'refuse') return;
      expect(decision.reason).toBe('wrong-target-state');
      expect(decision.detail).toContain('already rejected');
    });

    it('re-emits only the state transition for a redelivered approve, never a second gateResolution (matrix row 12)', () => {
      const state = aState({ state: 'blocked', pending_gate: aGate({ resolution: 'approved' }) });
      const decision = decideSteering(anIntent('approve'), state, noneApplied);
      expect(decision.kind).toBe('apply');
      if (decision.kind !== 'apply') return;
      expect(decision.effect.toState).toBe('running');
      expect(decision.effect.gateResolution).toBeNull();
    });

    it('refuses to reject a gate that was already approved', () => {
      const state = aState({ state: 'blocked', pending_gate: aGate({ resolution: 'approved' }) });
      const decision = decideSteering(anIntent('reject', null, 'too late now'), state, noneApplied);
      expect(decision.kind).toBe('refuse');
      if (decision.kind !== 'refuse') return;
      expect(decision.reason).toBe('wrong-target-state');
      expect(decision.detail).toContain('already approved');
    });

    it('re-emits only the hand-off transition for a redelivered reject, never a second gateResolution', () => {
      const state = aState({ state: 'blocked', pending_gate: aGate({ resolution: 'rejected' }) });
      const decision = decideSteering(
        anIntent('reject', null, 'this push touches a path nobody reviewed'),
        state,
        noneApplied,
      );
      expect(decision.kind).toBe('apply');
      if (decision.kind !== 'apply') return;
      expect(decision.effect.toState).toBe('handed_off');
      expect(decision.effect.gateResolution).toBeNull();
      expect(decision.effect.handoff?.code).toBe(GATE_REJECTED_HANDOFF_CODE);
    });

    it('refuses a reject naming both a pending gate and an open question, resolving neither (matrix row 10)', () => {
      const state = aState({ state: 'blocked', pending_gate: aGate() });
      const decision = decideSteering(anIntent('reject', null, 'which one is this about?'), state, {
        applied: new Map(),
        activeQuestionId: 'q-01',
      });
      expect(decision.kind).toBe('refuse');
      if (decision.kind !== 'refuse') return;
      expect(decision.reason).toBe('ambiguous-target');
      expect(decision.detail).toContain('commit.git_push');
      expect(decision.detail).toContain('q-01');
    });

    it('does not treat an approved or rejected gate as ambiguous, even with an open question', () => {
      // The ambiguity only exists while the gate itself is undecided (`resolution: 'pending'`): once it
      // has an answer, a further reject can only be a redelivery or a (refused) attempt to reverse it.
      const approved = aState({ state: 'blocked', pending_gate: aGate({ resolution: 'approved' }) });
      const decision = decideSteering(anIntent('reject', null, 'too late'), approved, {
        applied: new Map(),
        activeQuestionId: 'q-01',
      });
      expect(decision.kind).toBe('refuse');
      if (decision.kind !== 'refuse') return;
      expect(decision.reason).toBe('wrong-target-state');
    });
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

describe('pausing (story 4-3, I/O matrix row 1)', () => {
  it('mirrors a kill’s own effect exactly, except for the disposition it targets', () => {
    const state = aState({ steps: [aStep({ session_id: 'sess-implement' })] });
    const kill = decideSteering(anIntent('kill'), state, noneApplied);
    const pause = decideSteering(anIntent('pause'), state, noneApplied);
    expect(kill.kind).toBe('apply');
    expect(pause.kind).toBe('apply');
    if (kill.kind !== 'apply' || pause.kind !== 'apply') return;
    // Same step targeted, same shape — only the state each side records differs.
    expect(pause.effect.step).toBe(kill.effect.step);
    expect(pause.effect.toState).toBe('interrupted');
    expect(pause.effect.stepDisposition).toBe('interrupted');
    expect(kill.effect.toState).toBe('killed');
    expect(kill.effect.stepDisposition).toBe('killed');
  });

  it('never relabels a finished step, exactly as kill never does', () => {
    const state = aState({
      steps: [aStep({ disposition: 'completed', terminated_at: '2026-09-20T10:01:00.000Z' })],
    });
    const decision = decideSteering(anIntent('pause'), state, noneApplied);
    expect(decision.kind).toBe('apply');
    if (decision.kind !== 'apply') return;
    expect(decision.effect.toState).toBe('interrupted');
    expect(decision.effect.step).toBeNull();
    expect(decision.effect.stepDisposition).toBeNull();
  });

  it('carries no target-state guard, exactly as the other stop gestures do not (I/O matrix row 10 is the terminal one)', () => {
    for (const state of ['drafting', 'confirmed', 'running', 'blocked', 'verifying', 'interrupted'] as const) {
      expect(decideSteering(anIntent('pause'), aState({ state }), noneApplied).kind).toBe('apply');
    }
  });
});

describe('injecting a note and person-initiated narrow (story 4-3, I/O matrix rows 3, 5, 6)', () => {
  it('carries the note text and kind: "note" for inject_note (row 3)', () => {
    const decision = decideSteering(anIntent('inject_note', null, 'watch the refund path'), aState(), noneApplied);
    expect(decision.kind).toBe('apply');
    if (decision.kind !== 'apply') return;
    expect(decision.effect.injectedNote).toStrictEqual({ text: 'watch the refund path', kind: 'note' });
    // A note changes nothing about the run's own lifecycle or its steps.
    expect(decision.effect.toState).toBeNull();
    expect(decision.effect.step).toBeNull();
    expect(decision.effect.stepDisposition).toBeNull();
  });

  it('carries the note text and kind: "narrow" for a person-initiated narrow (row 6)', () => {
    const decision = decideSteering(anIntent('narrow', null, 'just the refund path'), aState(), noneApplied);
    expect(decision.kind).toBe('apply');
    if (decision.kind !== 'apply') return;
    expect(decision.effect.injectedNote).toStrictEqual({ text: 'just the refund path', kind: 'narrow' });
    expect(decision.effect.toState).toBeNull();
  });

  it('never touches acceptance_criteria — narrow’s free text is not a new criterion', () => {
    // The effect shape has no field that could carry one: `injectedNote` is the only thing `narrow`
    // produces, and it is delivered as `StepInput.steering_note`, never as an amended criterion.
    const decision = decideSteering(anIntent('narrow', null, 'just the refund path'), aState(), noneApplied);
    expect(decision.kind).toBe('apply');
    if (decision.kind !== 'apply') return;
    expect(Object.keys(decision.effect)).not.toContain('acceptanceCriteria');
  });

  it.each(['inject_note', 'narrow'] as const)(
    'refuses %s carrying no text, the same defence reject’s own guard already is',
    (command) => {
      const blank = anUnvalidatedIntent(command, '   ');
      expect(CommandIntentSchema.safeParse(blank).success, command).toBe(false);
      const decision = decideSteering(blank, aState(), noneApplied);
      expect(decision.kind, command).toBe('refuse');
      if (decision.kind !== 'refuse') return;
      expect(decision.reason).toBe('missing-answer');
    },
  );

  it('replaces rather than queues: a second inject_note decision carries only the second text (row 5)', () => {
    // `decideSteering` itself is pure and per-intent; the "replace, never queue" property is the fold's
    // own (`RunState.pending_note` is a plain assignment in `rebuild.ts`) — asserted at the decision level
    // here only as far as it goes: each `inject_note` intent decides its *own* text independently, so two
    // in a row produce two independent effects rather than one that remembers the first.
    const first = decideSteering(anIntent('inject_note', null, 'first note'), aState(), noneApplied);
    const second = decideSteering(anIntent('inject_note', null, 'second note'), aState(), noneApplied);
    expect(first.kind).toBe('apply');
    expect(second.kind).toBe('apply');
    if (first.kind !== 'apply' || second.kind !== 'apply') return;
    expect(first.effect.injectedNote?.text).toBe('first note');
    expect(second.effect.injectedNote?.text).toBe('second note');
  });
});

describe('forking (story 4-3, I/O matrix rows 7-11)', () => {
  /**
   * `fork` is decided here only to the extent every other command's exactly-once and terminal-run guards
   * already are: the actual new run is created by `Reconciler.forkFeature`, called from `consumeIntents`
   * beside — never inside — this switch (see `case 'fork'`'s own docblock in `src/engine/steering.ts`).
   * So the effect this decides is a deliberate, same-run no-op; the reconciler-level mechanism is exercised
   * through a real pass in `tests/engine.reconciler.test.ts`.
   */
  it('decides a same-run no-op effect, never describing the new run it causes', () => {
    const decision = decideSteering(anIntent('fork'), aState(), noneApplied);
    expect(decision.kind).toBe('apply');
    if (decision.kind !== 'apply') return;
    expect(decision.effect.toState).toBeNull();
    expect(decision.effect.step).toBeNull();
    expect(decision.effect.stepDisposition).toBeNull();
    expect(decision.effect.escapeHatch).toBe(false);
    expect(decision.effect.handoff).toBeNull();
  });

  it('is refused on a terminal run, the same terminal-run refusal every other command gets (row 10)', () => {
    for (const state of ['committed', 'killed', 'handed_off', 'hibernated'] as const) {
      const decision = decideSteering(anIntent('fork'), aState({ state }), noneApplied);
      expect(decision.kind, state).toBe('refuse');
      if (decision.kind !== 'refuse') continue;
      expect(decision.reason, state).toBe('terminal-run');
    }
  });

  it('recognises a redelivered fork by id rather than deciding a fresh one (row 11)', () => {
    const intent = anIntent('fork');
    const decision = decideSteering(intent, aState(), { applied: new Map([[intent.intent_id, 'fork']]) });
    expect(decision.kind).toBe('already-applied');
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

  /**
   * The three methods that carry free text, called with none of it.
   *
   * `answer`, `reject` and `editCriterion` all reach `steer`, which builds the intent through
   * `CommandIntentSchema.parse`. Story 1-12 moved the "this command means nothing without text" rule
   * into that schema, so these began throwing a bare `ZodError` out of a method whose documented refusal
   * is a {@link SteeringRefused} carrying a sentence a person can read — and no test called any of the
   * three with blank text, so nothing noticed. The engine-side `missing-answer` guard stays where it is:
   * it is the *file* path's, which is the path AD-19 actually admits.
   */
  it.each([
    ['answer', (reconciler: Reconciler, run: string, text: string) => reconciler.answer(run, text)],
    ['reject', (reconciler: Reconciler, run: string, text: string) => reconciler.reject(run, text)],
    [
      'editCriterion',
      (reconciler: Reconciler, run: string, text: string) => reconciler.editCriterion(run, text),
    ],
  ] as const)('refuses %s with blank text as a refusal, not as a crash', (name, call) => {
    const { reconciler } = openReconciler();
    const accepted = reconciler.acceptFeature(makePlan());

    for (const blank of ['', '   ']) {
      let thrown: unknown = null;
      try {
        call(reconciler, accepted.run, blank);
      } catch (error: unknown) {
        thrown = error;
      }
      expect(thrown, `${name} with ${JSON.stringify(blank)}`).toBeInstanceOf(SteeringRefused);
      expect((thrown as Error).name).toBe('SteeringRefused');
      // The sentence names the field, so a person knows what was missing.
      expect((thrown as Error).message).toContain('argument');
    }

    // And nothing durable was written: an intent the contract rejects is not a file anyone must sweep.
    expect(readIntentFiles(runPaths(accepted.run, home)).pending).toStrictEqual([]);
    expect(
      readEventLog(runPaths(accepted.run, home).eventLog).filter(
        (event) =>
          event.type === COMMAND_EVENT_TYPES.Applied ||
          event.type === COMMAND_EVENT_TYPES.Refused,
      ),
    ).toStrictEqual([]);
  });

  it('still accepts the same three methods once they carry text', async () => {
    const { reconciler } = openReconciler();
    const accepted = reconciler.acceptFeature(makePlan());
    // `reject` needs no open question to be *built*; what it needs text for is the ledger entry.
    expect(() => reconciler.reject(accepted.run, 'not what I asked for')).toThrowError(
      SteeringRefused,
    );
    // ...and the refusal is the engine's, about the run, rather than the contract's about the field.
    try {
      reconciler.reject(accepted.run, 'not what I asked for');
    } catch (error: unknown) {
      expect((error as Error).message).not.toContain('the declared contract accepts');
    }
    await Promise.resolve();
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
    const outcome = result.steering[0];
    /**
     * The kill goes first, although it was issued second.
     *
     * A stop command outranks everything else in the pass: a person who pressed kill while a confirmation
     * was still sitting in `commands/` pressed it to override that confirmation, and applying the earlier
     * one first walked the feature into execution and *then* stopped it. So the kill lands, the run becomes
     * terminal, and the confirmation it overrode is refused by name rather than applied to a dead run.
     */
    expect(outcome?.applied.map((entry) => entry.intentId)).toStrictEqual(['cmd-second']);
    expect(outcome?.refused.map((entry) => entry.intentId)).toStrictEqual(['cmd-first']);
    expect(outcome?.refused[0]?.reason).toBe('terminal-run');
    expect(reconciler.load(accepted.run).state.state).toBe('killed');
  });

  it('applies two intents of equal precedence in issue order, and the later effect stands', async () => {
    /**
     * The matrix's "two intents, one run" row, with neither of them a stop command — so the key under test
     * is the issue time and the precedence rule above cannot perturb it. `continue` is recorded and
     * changes nothing; `confirm_spec` moves the run. Both land, in order.
     */
    const { reconciler } = openReconciler();
    const accepted = reconciler.acceptFeature(makePlan());
    const paths = runPaths(accepted.run, home);

    writeCommandIntent(
      paths,
      newCommandIntent({
        intentId: 'cmd-earlier',
        command: 'continue',
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
        intentId: 'cmd-later',
        command: 'confirm_spec',
        run: accepted.run,
        feature: 'engine-reconciler',
        principal: { kind: 'user', id: 'deep' },
        source: 'tui',
        issuedAt: new Date('2026-09-20T10:00:01.000Z'),
      }),
    );

    const result = await reconciler.pass();
    const applied = result.steering[0]?.applied ?? [];
    expect(applied.map((entry) => entry.intentId)).toStrictEqual(['cmd-earlier', 'cmd-later']);
    expect(reconciler.load(accepted.run).state.state).toBe('confirmed');
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

  const writeOne = (run: string, command: Command, argument: string | null = null): string => {
    const intentId = mintIntentId(mintRunId());
    writeCommandIntent(
      runPaths(run, home),
      newCommandIntent({
        intentId,
        command,
        run,
        feature: 'engine-reconciler',
        principal: { kind: 'user', id: 'deep' },
        source: 'tui',
        argument,
      }),
    );
    return intentId;
  };

  const appliedEvents = (run: string): readonly { payload: Record<string, unknown> }[] =>
    readEventLog(runPaths(run, home).eventLog).filter(
      (event) => event.type === COMMAND_EVENT_TYPES.Applied,
    );

  /**
   * Story 4-3 closed the last four `awaiting` commands (`narrow`, `pause`, `inject_note`, `fork` — see
   * "parks no command on a later story any longer", above), so there is no real `Command` enum member
   * left to drive `consumeIntents`'s own `awaiting` branch with. `narrow` was this test's own concrete
   * example before this story; nothing in this build's committed `Command` enum reaches that branch any
   * longer, and this codebase has no established pattern for mocking `COMMAND_HANDLING` to synthesise
   * one (no other suite in this repository does that). The branch itself is untouched — a future story
   * parking a new command the same way would need a test here again, at that command's name.
   */

  it('records an acknowledged command once, with its principal, and changes no run state', async () => {
    /**
     * Skipping the `command.applied` record for an `acknowledge` decision left the suite green — and that
     * record is the whole of AD-19's "every command records its principal, so an approval is
     * attributable". `continue` and `just_do_it` are the two commands whose *only* effect is that line.
     */
    const { reconciler } = openReconciler();
    const accepted = reconciler.acceptFeature(makePlan());
    const before = reconciler.load(accepted.run).state.state;
    const intentId = writeOne(accepted.run, 'continue');

    const result = await reconciler.pass();
    const outcome = result.steering.find((entry) => entry.run === accepted.run);
    expect(outcome?.applied.map((entry) => entry.kind)).toStrictEqual(['acknowledged']);

    const mine = appliedEvents(accepted.run).filter((event) => event.payload['intent_id'] === intentId);
    expect(mine).toHaveLength(1);
    expect(mine[0]?.payload['effect']).toBe('acknowledged');
    expect(mine[0]?.payload['command']).toBe('continue');
    expect(mine[0]?.payload['principal_kind']).toBe('user');
    expect(mine[0]?.payload['principal_id']).toBe('deep');
    // Nothing about the run moved, and nothing claims it did.
    expect(mine[0]?.payload['to_state']).toBeUndefined();
    expect(reconciler.load(accepted.run).state.state).toBe(before);
    // And the file is retired, because there is nothing left for anybody to do with it.
    expect(readIntentFiles(runPaths(accepted.run, home)).pending).toStrictEqual([]);
  });

  /**
   * `steer` used to return the *old* state and no error for an `awaiting` decision, so
   * `reconciler.steer(run, 'pause')` read exactly like a pause that had happened — before story 4-3 gave
   * `pause` a real effect. There is no real `Command` member left that reaches `steer`'s `awaiting`
   * branch any longer (see the block comment above), so what is left to assert is the positive fact this
   * story adds instead: `pause` now actually applies, changing the run state `steer` hands back.
   */
  it('applies a pause through steer rather than leaving it parked', () => {
    const { reconciler } = openReconciler();
    const accepted = reconciler.acceptFeature(makePlan());

    const paused = reconciler.steer(accepted.run, 'pause');
    expect(paused.state).toBe('interrupted');
    expect(readIntentFiles(runPaths(accepted.run, home)).pending).toStrictEqual([]);
  });

  it('applies a pending intent when a caller drives advance directly', async () => {
    /**
     * Only `pass` and `steer` consumed intents, so a caller driving `advance` per run honoured a disengage
     * only if the mid-step watcher happened to catch it, and an intent written *between* `advance` calls
     * was never applied at all. AD-19 makes the intent file the only path a command reaches the loop by, so
     * an entry point that starts a step without reading it can do the thing it was told not to.
     */
    const { reconciler, executor } = openReconciler();
    const accepted = reconciler.acceptFeature(makePlan());
    writeOne(accepted.run, 'confirm_spec');

    const action = await reconciler.advance(accepted.run);
    // The confirmation was consumed *before* the action was decided, so the action is the one the confirmed
    // state calls for rather than the `await-confirmation` the drafting state would have answered with.
    expect(action.kind).toBe('run-step');
    expect(action.from).toBe('confirmed');
    expect(executor.started.map((request) => request.step)).toStrictEqual(['implement']);
  });

  it('does not consume a run’s intents twice when a pass drives advance for it', async () => {
    const { reconciler } = openReconciler();
    const accepted = reconciler.acceptFeature(makePlan());
    const intentId = writeOne(accepted.run, 'confirm_spec');

    await reconciler.pass();
    // Exactly one `command.applied` for the gesture: the pass consumed it, and the `advance` it called with
    // a preloaded snapshot did not read `commands/` again.
    expect(appliedEvents(accepted.run).filter((event) => event.payload['intent_id'] === intentId)).toHaveLength(
      1,
    );
  });
});
