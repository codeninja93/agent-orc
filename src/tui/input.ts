/**
 * The keyboard loop, as a pure reducer: one keystroke in, one state and one intended effect out.
 *
 * Story 1-9 built the control table and left the keyboard unbound, recording the reason: `answer`,
 * `reject`, `edit_criterion` and `inject_note` all carry free text, and a text prompt belongs to the
 * one-question card rather than to the shell. This is that prompt, and it is a reducer rather than a
 * component for the reason every other module in this directory is pure: a keystroke sequence can then be
 * asserted with no TTY, no raw mode and no terminal at all, and what the shell does with a key is decided
 * in one place instead of inside an event handler.
 *
 * Three rules it keeps, and each one is somebody's requirement rather than a preference:
 *
 * **A control writes a durable intent file and does nothing else** (AD-19). The reducer never writes
 * anything: it *names* an effect, and `invokeControl` — the one write surface a renderer has — performs it.
 * Nothing here executes a step, signals a process or touches run state, so the keyboard cannot become a
 * second command path.
 *
 * **Answers are free text and the system parses** (Q6). What is submitted is exactly what was typed, with
 * no format imposed, no trimming of meaning and no parsing on the way out. The one thing refused is a blank
 * submission, and that refusal is the same one `ControlArgumentRequired` makes: an empty answer would win
 * the AD-25 compare-and-set and record that a person said nothing.
 *
 * **Nothing is submitted by a redraw.** A draft lives in this state until a deliberate keystroke sends it,
 * and escape discards it without writing. If the window closes while somebody is typing, the card says so
 * and the typed text is still not submitted — the decision that stands is the one the clock made.
 */
import type { Command } from '../contracts/index.js';

import { controlForKey } from './controls.js';
import type { ControlDefinition } from './controls.js';

/** The keystroke, in the shape Ink's `useInput` hands one over — and one a suite can write by hand. */
export interface InputKey {
  /** The characters typed. Empty for a key that produces none, such as escape or return. */
  readonly input: string;
  readonly return?: boolean;
  readonly escape?: boolean;
  readonly backspace?: boolean;
  readonly delete?: boolean;
  /** Ctrl was held. Used only to recognise the conventional cancel, so nothing needs a chord table. */
  readonly ctrl?: boolean;
}

/** Whether the loop is waiting for a control key or composing the free text one needs. */
export const INPUT_MODES = ['controls', 'composing'] as const;

export type InputMode = (typeof INPUT_MODES)[number];

export interface InputState {
  readonly mode: InputMode;
  /** The control the draft belongs to, or `null` when no draft is being composed. */
  readonly composingFor: Command | null;
  /** Exactly what has been typed, unaltered. */
  readonly draft: string;
}

/**
 * What the shell should do about a keystroke. Naming an effect rather than performing one is what keeps the
 * reducer pure and keeps every write on the one path AD-19 admits.
 */
export type InputEffect =
  /** Nothing to do: a key that changed only the draft, or one there was nothing to do about. */
  | { readonly kind: 'none' }
  /** A control that carries free text was pressed; the loop is now composing it. */
  | { readonly kind: 'compose'; readonly command: Command }
  /** Write one durable intent file for this command, carrying exactly this argument (AD-19). */
  | { readonly kind: 'invoke'; readonly command: Command; readonly argument: string | null }
  /** A draft was abandoned. Nothing was written, and the reducer says so rather than staying silent. */
  | { readonly kind: 'cancelled'; readonly command: Command }
  /**
   * A submission with nothing in it, refused rather than written.
   *
   * The same refusal `ControlArgumentRequired` makes, made one step earlier so no file is created: an
   * empty answer would resolve the question with a blank decision, and an empty rejection would lose the
   * reason that is its whole point.
   */
  | { readonly kind: 'empty'; readonly command: Command }
  /** A key that is not a control. Not an error: a person pressing an unbound key has made no mistake. */
  | { readonly kind: 'ignored'; readonly key: string };

export interface InputStep {
  readonly state: InputState;
  readonly effect: InputEffect;
}

/** The state before anything has been typed. */
export const initialInputState: InputState = Object.freeze({
  mode: 'controls',
  composingFor: null,
  draft: '',
});

const step = (state: InputState, effect: InputEffect): InputStep => ({ state, effect });

/**
 * A control pressed while no draft is open.
 *
 * A control whose argument is `required` opens a draft; one that is `optional` or `none` is invoked at once
 * with no argument. The asymmetry is the control table's own: `optional` means the control means something
 * without text, so making a person press return to send nothing would add a keystroke and no information.
 */
const pressControl = (control: ControlDefinition): InputStep =>
  control.argument === 'required'
    ? step(
        { mode: 'composing', composingFor: control.command, draft: '' },
        { kind: 'compose', command: control.command },
      )
    : step(initialInputState, { kind: 'invoke', command: control.command, argument: null });

/**
 * Fold one keystroke into the loop's state.
 *
 * Pure: the same state and the same key give the same step, and nothing here reads a clock, a file or an
 * environment. Every write the loop causes is the `invoke` effect, performed by the caller through
 * `invokeControl`.
 */
export const reduceKey = (state: InputState, key: InputKey): InputStep => {
  if (state.mode === 'composing') {
    const command = state.composingFor;
    // A draft with no control to belong to is a state this reducer never builds. It resets rather than
    // guessing a command: inventing one would write an intent nobody asked for, which is the one thing a
    // keyboard loop must never do.
    if (command === null) return step(initialInputState, { kind: 'none' });

    // Escape, and the conventional ctrl-c, both abandon the draft. Neither writes anything: a person who
    // changed their mind has not made a decision, and AD-25 would make one durable.
    if (key.escape === true || (key.ctrl === true && key.input === 'c')) {
      return step(initialInputState, { kind: 'cancelled', command });
    }

    if (key.return === true) {
      if (state.draft.trim() === '') return step(state, { kind: 'empty', command });
      // Exactly what was typed, with no format imposed on it (Q6). The draft is cleared only because it
      // has been handed over; the intent carries it verbatim.
      return step(initialInputState, { kind: 'invoke', command, argument: state.draft });
    }

    if (key.backspace === true || key.delete === true) {
      return step({ ...state, draft: state.draft.slice(0, -1) }, { kind: 'none' });
    }

    // Anything else typed is text, including a character that is also a control key: while a draft is open
    // there are no control keys, because a person typing a sentence must not have "k" mean "kill".
    return key.input === ''
      ? step(state, { kind: 'none' })
      : step({ ...state, draft: `${state.draft}${key.input}` }, { kind: 'none' });
  }

  // Outside a draft, escape and return do nothing. Return in particular: there is nothing to submit, and a
  // reducer that treated it as one would let a stray newline invoke whatever was last pressed.
  if (key.escape === true || key.return === true) return step(state, { kind: 'none' });
  if (key.input === '') return step(state, { kind: 'none' });

  /*
   * A ctrl chord is never a control key.
   *
   * Without this, `controlForKey` sees the bare letter and ctrl-c writes a durable `confirm_spec`
   * intent — CAP-2's only gate into execution — because `c` is what confirms a spec. Ctrl-k reaches
   * `kill` the same way. The composing branch above already refuses ctrl-c for the same reason, so the
   * omission here was the asymmetry, not the rule.
   *
   * It is also what makes the frame's own hint true: story 1-9 decided ctrl-c means "close this view and
   * leave the run advancing" and says so on the frame, which holds only if the reducer declines the chord
   * and lets the terminal's own interrupt through. A hint that promises safety over a keystroke that
   * confirms acceptance criteria is worse than no hint.
   */
  if (key.ctrl === true) return step(state, { kind: 'ignored', key: key.input });

  const control = controlForKey(key.input);
  return control === null
    ? step(state, { kind: 'ignored', key: key.input })
    : pressControl(control);
};

/**
 * Fold a whole sequence, for a suite and for anything replaying keystrokes.
 *
 * Every effect is kept, in order, rather than only the last: a sequence that typed a sentence and sent it
 * must be assertable as *one* submission carrying the whole sentence, and a fold that kept only the final
 * effect could not tell that from three submissions of one character each.
 */
export const reduceKeys = (
  keys: readonly InputKey[],
  state: InputState = initialInputState,
): { readonly state: InputState; readonly effects: readonly InputEffect[] } => {
  let current = state;
  const effects: InputEffect[] = [];
  for (const key of keys) {
    const next = reduceKey(current, key);
    current = next.state;
    effects.push(next.effect);
  }
  return { state: current, effects };
};

/** The typed characters of a string, as the keystrokes that would produce them. */
export const typedKeys = (text: string): readonly InputKey[] =>
  [...text].map((character) => ({ input: character }));
