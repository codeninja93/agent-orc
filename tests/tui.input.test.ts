/**
 * The keyboard loop: a keystroke reaches one durable intent file, and nothing else happens.
 *
 * Two halves, deliberately separated.
 *
 * **The reducer, with no terminal at all.** What a key means is a pure function, so the whole of it —
 * typing, sending, discarding, a control that needs no words, a key that is not a control — is asserted by
 * calling a function. A loop that could only be tested through a TTY would be a loop nobody tested.
 *
 * **The loop, end to end, through a real run.** The second half writes an answer with the same call the
 * shell makes, hands the file to a real reconciler, and asserts the question resolved through story 1-8's
 * compare-and-set with exactly what was typed. That is AD-19's claim in full — "renderers reach the engine
 * only by writing command intent files" — with no method call into the engine anywhere in the path, and it
 * is also the only way to catch a loop that wrote a *well-shaped* intent the loop would refuse.
 */
import { existsSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Command } from '../src/contracts/index.js';
import type { QuestionDraft } from '../src/contracts/index.js';
import {
  Reconciler,
  createRecordingResetter,
  createScriptedExecutor,
  settleQuestion,
  terminated,
} from '../src/engine/index.js';
import { readEventLog, runPaths } from '../src/runtime/index.js';
import {
  editCriterionArgument,
  initialInputState,
  invokeControl,
  mountShell,
  reduceKey,
  reduceKeys,
  typedKeys,
} from '../src/tui/index.js';
import type { InputEffect } from '../src/tui/index.js';

import { makeHome, makePlan, planProvider } from './helpers/engine-fixture.js';

const BASELINE = 'ddd9bed4d286ac1f8a0f4f7bfef9530046605787';
const PRINCIPAL = { kind: 'user' as const, id: 'deep' };

const DRAFT: QuestionDraft = {
  prompt: 'Should the shell poll the log, or watch it?',
  brief: 'Polling cannot miss a line; watching is cheaper and can drop a notification on some volumes.',
  options: [
    { id: 'poll', label: 'poll', consequence: 'one read per second, and nothing is missed' },
    { id: 'watch', label: 'watch', consequence: 'redraws instantly, and may miss a line' },
  ],
  escape: { id: 'ask-me', label: 'ask me again with more detail', consequence: 'nothing changes yet' },
  recommended_option_id: 'poll',
  default_action: 'the shell polls every second',
  default_window_ms: 600_000,
};

let home: string;
const toRemove: string[] = [];
const toClose: Reconciler[] = [];

beforeEach(() => {
  home = makeHome('tui-input');
  toRemove.push(home);
});

afterEach(() => {
  for (const reconciler of toClose.splice(0)) reconciler.close();
  for (const dir of toRemove.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Every file under a directory, with its size and modification time: the run's observable state. */
const inventory = (dir: string): Record<string, string> => {
  const out: Record<string, string> = {};
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        walk(path);
        continue;
      }
      const stat = statSync(path);
      out[relative(dir, path)] = `${String(stat.size)}:${String(stat.mtimeMs)}`;
    }
  };
  if (existsSync(dir)) walk(dir);
  return out;
};

const openReconciler = (): Reconciler => {
  const reconciler = Reconciler.open({
    orchHome: home,
    executor: createScriptedExecutor({
      onStart: (request) => terminated(request.step, 'completed', { sessionId: `sess-${request.step}` }),
      sessionIdFor: (request) => `sess-${request.step}`,
    }),
    plans: planProvider(makePlan({ feature: 'tui-input' })),
    baseline: createRecordingResetter(BASELINE),
  });
  toClose.push(reconciler);
  return reconciler;
};

const invokes = (effects: readonly InputEffect[]): readonly InputEffect[] =>
  effects.filter((effect) => effect.kind === 'invoke');

describe('free text and enter produce exactly one submission carrying exactly what was typed', () => {
  const answer = 'poll — missing a line is worse than a redraw, and 1s is fine';

  it('emits one submit with the typed text unaltered, imposing no format on it (Q6)', () => {
    const opened = reduceKey(initialInputState, { input: 'a' });
    expect(opened.effect).toStrictEqual({ kind: 'compose', command: Command.Answer });
    expect(opened.state.mode).toBe('composing');

    const { state, effects } = reduceKeys([...typedKeys(answer), { input: '', return: true }], opened.state);

    // One submission, not one per keystroke: a fold that kept only the last effect could not tell the
    // difference, which is why every effect is kept and counted.
    expect(invokes(effects)).toStrictEqual([
      { kind: 'invoke', command: Command.Answer, argument: answer },
    ]);
    expect(state).toStrictEqual(initialInputState);
  });

  it('keeps the draft exactly as typed, including a character that is also a control key', () => {
    // "k" is the kill key. While a draft is open there are no control keys, or a sentence could stop a run.
    const { state, effects } = reduceKeys(typedKeys('kill the watcher'), {
      mode: 'composing',
      composingFor: Command.Answer,
      draft: '',
    });
    expect(state.draft).toBe('kill the watcher');
    expect(invokes(effects)).toStrictEqual([]);
  });

  it('erases a character on backspace rather than sending or cancelling', () => {
    const { state } = reduceKeys([...typedKeys('poll!'), { input: '', backspace: true }], {
      mode: 'composing',
      composingFor: Command.Answer,
      draft: '',
    });
    expect(state.draft).toBe('poll');
  });

  it('refuses a blank submission rather than recording that a person said nothing', () => {
    const { state, effects } = reduceKeys([...typedKeys('   '), { input: '', return: true }], {
      mode: 'composing',
      composingFor: Command.Reject,
      draft: '',
    });
    expect(invokes(effects)).toStrictEqual([]);
    expect(effects.at(-1)).toStrictEqual({ kind: 'empty', command: Command.Reject });
    // The draft survives: a person who typed spaces has not lost what they were about to write.
    expect(state.mode).toBe('composing');
  });

  it('discards a draft on escape, and writes nothing', () => {
    const { state, effects } = reduceKeys([...typedKeys('never mind'), { input: '', escape: true }], {
      mode: 'composing',
      composingFor: Command.Answer,
      draft: '',
    });
    expect(effects.at(-1)).toStrictEqual({ kind: 'cancelled', command: Command.Answer });
    expect(state).toStrictEqual(initialInputState);
  });

  it('invokes a control that needs no words at once, with no argument', () => {
    const step = reduceKey(initialInputState, { input: 'x' });
    expect(step.effect).toStrictEqual({
      kind: 'invoke',
      command: Command.Disengage,
      argument: null,
    });
    expect(step.state).toStrictEqual(initialInputState);
  });

  it('ignores a key that is not a control, because pressing one is not a mistake', () => {
    const step = reduceKey(initialInputState, { input: '?' });
    expect(step.effect).toStrictEqual({ kind: 'ignored', key: '?' });
    expect(step.state).toStrictEqual(initialInputState);
  });

  it('does nothing on a bare return outside a draft', () => {
    expect(reduceKey(initialInputState, { input: '', return: true }).effect).toStrictEqual({
      kind: 'none',
    });
  });
});

describe('a submitted answer is one durable intent file, and the question resolves through it', () => {
  it('writes exactly one file and resolves the question with the typed words', async () => {
    const answer = 'watch it, and keep a slow poll as a backstop';
    const reconciler = openReconciler();
    const accepted = reconciler.acceptFeature(makePlan({ feature: 'tui-input' }));
    const paths = runPaths(accepted.run, home);
    const asked = reconciler.ask(accepted.run, DRAFT);

    const before = inventory(paths.runDir);

    // The reducer decides; `invokeControl` performs the one write a renderer may (AD-19).
    const { effects } = reduceKeys([
      { input: 'a' },
      ...typedKeys(answer),
      { input: '', return: true },
    ]);
    const submitted = invokes(effects);
    expect(submitted).toHaveLength(1);
    const effect = submitted[0];
    if (effect?.kind !== 'invoke') throw new Error('the reducer did not submit the answer');

    const outcome = invokeControl(effect.command, { paths, feature: 'tui-input', principal: PRINCIPAL }, effect.argument);

    const afterWrite = inventory(paths.runDir);
    const added = Object.keys(afterWrite).filter((path) => !(path in before));
    expect(added).toHaveLength(1);
    expect(added[0]?.startsWith('commands/')).toBe(true);
    for (const [path, fingerprint] of Object.entries(before)) {
      expect(afterWrite[path], `${path} was modified by a renderer`).toBe(fingerprint);
    }

    await reconciler.pass();

    const settled = settleQuestion(paths, asked.question.id).state;
    expect(settled.status).toBe('resolved');
    expect(settled.resolution?.resolver).toBe('tui');
    // Exactly what was typed reached the decision: no format was imposed on the way through (Q6).
    expect(settled.resolution?.answer).toBe(answer);
    // No option was selected, and that is correct: a sentence is not an option id, and the engine records
    // the words rather than guessing which of the three the person meant (Q6).
    expect(settled.resolution?.option_id).toBeNull();
    expect(settled.resolution?.principal).toStrictEqual(PRINCIPAL);

    const types = readEventLog(paths.eventLog).map((event) => event.type);
    expect(types).toContain('question.resolved');
    expect(types).toContain('command.applied');
    expect(
      readEventLog(paths.eventLog).some(
        (event) => event.type === 'command.applied' && event.payload['intent_id'] === outcome.intentId,
      ),
      'the applied line does not carry the intent id the renderer minted',
    ).toBe(true);
  });

  it('recognises an option a person named outright, without imposing that they name one', async () => {
    const reconciler = openReconciler();
    const accepted = reconciler.acceptFeature(makePlan({ feature: 'tui-input' }));
    const paths = runPaths(accepted.run, home);
    const asked = reconciler.ask(accepted.run, DRAFT);

    const { effects } = reduceKeys([{ input: 'a' }, ...typedKeys('watch'), { input: '', return: true }]);
    const effect = invokes(effects)[0];
    if (effect?.kind !== 'invoke') throw new Error('the reducer did not submit the answer');
    invokeControl(effect.command, { paths, feature: 'tui-input', principal: PRINCIPAL }, effect.argument);
    await reconciler.pass();

    const settled = settleQuestion(paths, asked.question.id).state;
    expect(settled.resolution?.option_id).toBe('watch');
    expect(settled.resolution?.answer).toBe('watch');
  });

  it('names the criterion an amendment changes, in the intent the loop writes', () => {
    const reconciler = openReconciler();
    const accepted = reconciler.acceptFeature(makePlan({ feature: 'tui-input' }));
    const paths = runPaths(accepted.run, home);

    const amendment = editCriterionArgument(2, 'a restart converges on the same state, every time');
    const { effects } = reduceKeys([{ input: 'e' }, ...typedKeys(amendment), { input: '', return: true }]);
    const effect = invokes(effects)[0];
    if (effect?.kind !== 'invoke') throw new Error('the reducer did not submit the amendment');
    expect(effect.command).toBe(Command.EditCriterion);

    const outcome = invokeControl(
      effect.command,
      { paths, feature: 'tui-input', principal: PRINCIPAL },
      effect.argument,
    );
    const intent = JSON.parse(readFileSync(outcome.intentPath, 'utf8')) as { readonly argument: string };
    expect(intent.argument).toContain('criterion 2');
    expect(intent.argument).toContain('every time');
  });
});

describe('the mounted shell turns a keystroke into that same one file', () => {
  it('writes one intent when a key is pressed, and nothing else in the run changes', () => {
    const reconciler = openReconciler();
    const accepted = reconciler.acceptFeature(makePlan({ feature: 'tui-input' }));
    const paths = runPaths(accepted.run, home);
    reconciler.ask(accepted.run, DRAFT);

    const before = inventory(paths.runDir);
    const handle = mountShell({
      eventLog: paths.eventLog,
      feature: 'tui-input',
      control: { paths, feature: 'tui-input', principal: PRINCIPAL },
      stdout: fakeStdout(),
      debug: true,
    });

    try {
      handle.refresh();
      // A question is pending, so the slot holds the one-question card: the seam story 1-9 reserved.
      expect(handle.lastCard()?.kind).toBe('question');

      handle.press({ input: 'a' });
      expect(handle.inputState().mode).toBe('composing');
      for (const key of typedKeys('poll')) handle.press(key);
      expect(handle.inputState().draft).toBe('poll');
      // Still nothing written: a draft is not a decision.
      expect(Object.keys(inventory(paths.runDir))).toStrictEqual(Object.keys(before));

      handle.press({ input: '', return: true });
      const outcome = handle.lastControl();
      expect(outcome?.command).toBe(Command.Answer);
      expect(existsSync(outcome?.intentPath ?? '')).toBe(true);

      const added = Object.keys(inventory(paths.runDir)).filter((path) => !(path in before));
      expect(added).toHaveLength(1);
      expect(added[0]?.startsWith('commands/')).toBe(true);
    } finally {
      handle.unmount();
    }
  });

  it('says so rather than throwing when a keystroke has no run to steer', () => {
    const handle = mountShell({
      eventLog: join(home, 'runs', 'nothing', 'events.jsonl'),
      feature: 'tui-input',
      stdout: fakeStdout(),
      debug: true,
    });
    try {
      const effect = handle.press({ input: 'x' });
      expect(effect).toStrictEqual({ kind: 'invoke', command: Command.Disengage, argument: null });
      expect(handle.lastControl()).toBeNull();
      expect(existsSync(join(home, 'runs', 'nothing', 'commands'))).toBe(false);
    } finally {
      handle.unmount();
    }
  });
});

/** A terminal that accepts writes and remembers nothing, for a mount whose frame is not the subject. */
const fakeStdout = (): NodeJS.WriteStream => {
  const writes: string[] = [];
  const stream = {
    columns: 80,
    rows: 24,
    write: (chunk: string): boolean => {
      writes.push(chunk);
      return true;
    },
    on: (): unknown => stream,
    off: (): unknown => stream,
    removeListener: (): unknown => stream,
  };
  return stream as unknown as NodeJS.WriteStream;
};
