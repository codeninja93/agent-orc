/**
 * The control table: every member of the `Command` enum, and the durable file each one writes.
 *
 * Two architecture decisions meet here, and between them they leave this module almost no freedom.
 *
 * AD-3: "every steering control is a member of a single `Command` enum defined once in `contracts/`,
 * and both renderers are built against that enum, so a control present in one and absent from the
 * other is a compile error." {@link CONTROLS} is typed `CommandMap<ControlDefinition>`, which is a
 * total record over the enum — so a command added to `contracts/` and not to this table does not
 * render as a gap a user discovers, it fails `npm run typecheck`.
 *
 * AD-19: "every steering command is a durable intent file written under `runs/<run-id>/commands/` and
 * is the only thing the reconciler consumes." {@link invokeControl} writes that file and does nothing
 * else. There is no second path, nothing here mutates run state, nothing here writes to the event log
 * — the recorder is its sole writer (AD-29) — and nothing here calls a method on the engine, which is
 * why `src/tui/` can satisfy the spine's rule that no renderer imports `src/engine/`.
 *
 * The mechanics of the file itself live in `src/runtime/commands.ts`, which is where story 1-9 moved
 * them from the engine for exactly this reason.
 */
import { COMMANDS, Command } from '../contracts/index.js';
import type { CommandMap, CommandSource, Principal } from '../contracts/index.js';
import { mintRandomIntentId, newCommandIntent, writeCommandIntent } from '../runtime/index.js';
import type { RunPaths } from '../runtime/index.js';

import { displayWidth, wrapToWidth } from './width.js';

/** Whether a control carries free text, and whether it is meaningless without it. */
export const CONTROL_ARGUMENTS = ['none', 'optional', 'required'] as const;

export type ControlArgument = (typeof CONTROL_ARGUMENTS)[number];

/** Whether the intent targets the step in flight or the run as a whole. */
export const CONTROL_TARGETS = ['run', 'current-step'] as const;

export type ControlTarget = (typeof CONTROL_TARGETS)[number];

/** One control: the keystroke, what it is called, what it does, and what it needs. */
export interface ControlDefinition {
  readonly command: Command;
  /** One keystroke. Rejection is one keystroke plus a reason (interface-contract, Mode and control). */
  readonly key: string;
  readonly label: string;
  /** What happens if it is pressed, in a person's words. */
  readonly hint: string;
  readonly argument: ControlArgument;
  readonly target: ControlTarget;
}

/**
 * Every control, as a total map over the enum.
 *
 * The keystrokes are all distinct, which {@link CONTROL_KEYS} and the suite both check: two controls
 * on one key would make one of them unreachable, which is the same defect as a missing control wearing
 * a different coat.
 */
export const CONTROLS: CommandMap<ControlDefinition> = Object.freeze({
  [Command.Answer]: {
    command: Command.Answer,
    key: 'a',
    label: 'answer',
    hint: 'answer the question in the slot below, in your own words',
    argument: 'required',
    target: 'run',
  },
  [Command.ConfirmSpec]: {
    command: Command.ConfirmSpec,
    key: 'c',
    label: 'confirm',
    hint: 'confirm the acceptance criteria as written',
    argument: 'none',
    target: 'run',
  },
  [Command.EditCriterion]: {
    command: Command.EditCriterion,
    key: 'e',
    label: 'edit criterion',
    hint: 'amend one acceptance-criterion line',
    argument: 'required',
    target: 'run',
  },
  [Command.Approve]: {
    command: Command.Approve,
    key: 'y',
    label: 'approve',
    hint: 'approve the irreversible action waiting at the gate',
    argument: 'optional',
    target: 'current-step',
  },
  [Command.Reject]: {
    command: Command.Reject,
    key: 'n',
    label: 'reject',
    hint: 'reject it, with a reason that becomes a ledger entry',
    argument: 'required',
    target: 'current-step',
  },
  [Command.Continue]: {
    command: Command.Continue,
    key: 'g',
    label: 'continue',
    hint: 'carry on unchanged',
    argument: 'optional',
    target: 'run',
  },
  [Command.Narrow]: {
    command: Command.Narrow,
    key: 'w',
    label: 'narrow',
    hint: 'narrow the scope rather than stopping',
    // Required, because the contract requires it: a narrowing that names no narrower scope is an intent
    // its owner can only accept and do nothing about. The suite asserts this table against
    // ARGUMENT_REQUIRED_COMMANDS, so the two cannot drift.
    argument: 'required',
    target: 'run',
  },
  [Command.Pause]: {
    command: Command.Pause,
    key: 'p',
    label: 'pause',
    hint: 'pause, leaving clean resumable state',
    argument: 'optional',
    target: 'run',
  },
  [Command.InjectNote]: {
    command: Command.InjectNote,
    key: 'i',
    label: 'note',
    hint: "add a note to the running agent's next input",
    argument: 'required',
    target: 'current-step',
  },
  [Command.Kill]: {
    command: Command.Kill,
    key: 'k',
    label: 'kill step',
    hint: 'terminate the current step; it is never resumed',
    argument: 'optional',
    target: 'current-step',
  },
  [Command.Fork]: {
    command: Command.Fork,
    key: 'f',
    label: 'fork',
    hint: 'fork the run from where it stands',
    argument: 'optional',
    target: 'run',
  },
  [Command.TakeOver]: {
    command: Command.TakeOver,
    key: 't',
    label: 'take over',
    hint: 'take manual control; the partial work stays on its branch',
    argument: 'optional',
    target: 'run',
  },
  [Command.Disengage]: {
    command: Command.Disengage,
    key: 'x',
    label: 'stop',
    hint: 'stop everything now',
    argument: 'optional',
    target: 'run',
  },
  [Command.JustDoIt]: {
    command: Command.JustDoIt,
    key: 'j',
    label: 'just do it',
    hint: 'stop asking, use judgement, review at the end',
    argument: 'optional',
    target: 'run',
  },
});

/**
 * The one gesture that always means stop.
 *
 * "Disengagement is instant, obvious, and always available via a single gesture that always means
 * stop." Named here so no frame can offer it conditionally and no other control can take its key.
 */
export const ALWAYS_AVAILABLE_CONTROL: Command = Command.Disengage;

/** The narrowest terminal the hints are packed for. Below it, one cell per row is the best available. */
const MIN_HINT_COLUMNS = 20;

/**
 * What ctrl-c does, said out loud, because it is not what a person would assume.
 *
 * **The decision, deliberately taken: ctrl-c stays "quit the viewer" and is not bound to `disengage`.**
 * Both readings of the interface contract were available — "disengagement is instant, obvious, and
 * always available via a single gesture that always means stop" could be read as a claim on the
 * terminal's conventional interrupt — and this is the one that holds:
 *
 * - AD-4 makes the renderer a projection and AD-19 makes an intent file the only way it reaches the
 *   engine. Closing a projection is not an act on the run, and a viewer that killed the work when a
 *   person closed the window would make *watching* dangerous — the opposite of "abandoning early is
 *   easy" (R11), since a person would have to think before quitting.
 * - The contract's gesture is already present and unconditional: `x stop` leads the hint line in every
 *   frame, in every state, and `ALWAYS_AVAILABLE_CONTROL` names it so nothing can offer it
 *   conditionally. Hijacking ctrl-c would add a second stop gesture rather than make the first more
 *   available, and the run would then have no way to close the terminal without stopping.
 * - A run keeps advancing with the viewer closed by design — the reconciler is a loop over on-disk
 *   state (AD-7), not a child of this process.
 *
 * What was actually wrong was silence: the frame said nothing about which of the two ctrl-c does, so a
 * person could quit believing they had stopped the run. That is mode confusion — the belief that the
 * system is doing nothing while it advances — so the frame now states it in the one place a person
 * looks for keys.
 */
export const QUIT_IS_NOT_DISENGAGE_HINT =
  'ctrl-c closes this view and leaves the run advancing — x stops the run itself';

/** Every control in the enum's declaration order, which is the order a frame lists them in. */
export const CONTROL_ORDER: readonly ControlDefinition[] = Object.freeze(
  COMMANDS.map((command) => CONTROLS[command]),
);

/** Two controls declared on one keystroke: one of them would be unreachable, so neither is accepted. */
export class DuplicateControlKey extends Error {
  readonly key: string;

  constructor(key: string, first: Command, second: Command) {
    super(
      `The "${key}" keystroke is declared by both "${first}" and "${second}". A key resolves to one ` +
        'control, so the second would be permanently unreachable — the same defect as a control missing ' +
        'from the table, wearing a different coat (AD-3).',
    );
    this.name = 'DuplicateControlKey';
    this.key = key;
  }
}

/**
 * The keystroke index, built once and **checked while it is built**.
 *
 * This is the uniqueness check the comment on {@link CONTROLS} has always claimed. What stood here was a
 * list of keys that checked nothing and a lookup by linear search, so two controls sharing a key made the
 * later one unreachable in every frame while the table still typechecked and every suite still passed —
 * a control a person has and cannot use, which is the failure AD-3's totality exists to prevent from the
 * other direction. A duplicate now fails at module load, which is as close to a compile error as a value
 * can get.
 */
const indexControlsByKey = (
  controls: readonly ControlDefinition[],
): ReadonlyMap<string, ControlDefinition> => {
  const index = new Map<string, ControlDefinition>();
  for (const control of controls) {
    const key = control.key.toLowerCase();
    const clash = index.get(key);
    if (clash !== undefined) throw new DuplicateControlKey(key, clash.command, control.command);
    index.set(key, control);
  }
  return index;
};

/** Exposed so a suite can drive the check itself rather than asserting a comment about it. */
export { indexControlsByKey };

export const CONTROL_BY_KEY: ReadonlyMap<string, ControlDefinition> =
  indexControlsByKey(CONTROL_ORDER);

/** Every keystroke, in the same order. */
export const CONTROL_KEYS: readonly string[] = Object.freeze(
  CONTROL_ORDER.map((control) => control.key),
);

/** The control a keystroke invokes, or `null` for a key that is not a control. */
export const controlForKey = (key: string): ControlDefinition | null =>
  CONTROL_BY_KEY.get(key.toLowerCase()) ?? null;

/** Where a control writes to, and who is accountable for it. */
export interface ControlContext {
  /** The AD-9 paths of the run being steered. The only place a run id is needed, and never displayed. */
  readonly paths: RunPaths;
  readonly feature: string;
  /** The step in flight, for a control that targets one. `null` when no step is running. */
  readonly currentStep?: string | null;
  /** AD-19 — every command records its principal, so an approval is attributable. */
  readonly principal: Principal;
  /** Which renderer wrote it. The TUI by default; story 3-1's server writes the same files as `web`. */
  readonly source?: CommandSource;
  readonly issuedAt?: Date;
  /** Injectable so a suite can pin the id; the default mints one without the engine's ULID minter. */
  readonly mintIntentId?: () => string;
}

/** What invoking a control did: the file it wrote, and the key the log will report it under. */
export interface ControlOutcome {
  readonly command: Command;
  readonly intentId: string;
  /** The durable intent file. The single effect of invoking a control (AD-19). */
  readonly intentPath: string;
}

/**
 * A control invoked without the free text it cannot mean anything without.
 *
 * Refused here rather than written and refused by the loop, because the decision is durable: an empty
 * rejection loses the reason that becomes the ledger entry, and an empty answer would win the AD-25
 * compare-and-set and record that a person said nothing.
 */
export class ControlArgumentRequired extends Error {
  /**
   * No AD-35 code, deliberately.
   *
   * The spine gives the `code`/`message`/`retryable`/`cause` shape to "every failure crossing a unit
   * boundary", and this one crosses none: it is thrown and caught inside the renderer, one keystroke
   * after the person pressed a key, and becomes a line in the frame asking them to type something. It
   * carried `config.invalid` — a code whose declared disposition is `escalate-to-human` and whose
   * neighbours are an unreadable `orch.toml` and an unrecognised schema version — which filed a
   * correctable keystroke as a broken installation. None of the four dispositions is the right answer to
   * "that control carries your words and there are none yet", so the honest thing is to claim none.
   */
  readonly command: Command;

  constructor(command: Command) {
    super(
      `The "${command}" control carries free text, and none was given. Answers and reasons are ` +
        'recorded as decisions, so an empty one would record that you said nothing rather than ' +
        'asking again.',
    );
    this.name = 'ControlArgumentRequired';
    this.command = command;
  }
}

/**
 * Invoke a control: write one durable intent file, and change nothing else.
 *
 * This is the whole of a renderer's write surface. It does not touch `state.json`, does not append to
 * `events.jsonl`, does not signal a process and does not call the engine — the reconciler picks the
 * file up on its next pass, which is what makes every control available with no server running.
 */
export const invokeControl = (
  command: Command,
  context: ControlContext,
  argument: string | null = null,
): ControlOutcome => {
  const control = CONTROLS[command];
  const given = argument === null || argument.trim() === '' ? null : argument;
  if (control.argument === 'required' && given === null) throw new ControlArgumentRequired(command);

  const intent = newCommandIntent({
    intentId: (context.mintIntentId ?? mintRandomIntentId)(),
    command,
    run: context.paths.runId,
    feature: context.feature,
    step: control.target === 'current-step' ? (context.currentStep ?? null) : null,
    principal: context.principal,
    source: context.source ?? 'tui',
    argument: given,
    ...(context.issuedAt === undefined ? {} : { issuedAt: context.issuedAt }),
  });

  return {
    command,
    intentId: intent.intent_id,
    intentPath: writeCommandIntent(context.paths, intent),
  };
};

/**
 * The control hints, packed into lines no wider than the terminal.
 *
 * Wrapped rather than truncated: a 40-column terminal is one of the declared states, and a control a
 * person cannot see the key for is a control they do not have. The stop gesture leads, because it is
 * the one that must be obvious.
 */
export const formatControlHints = (columns: number): readonly string[] => {
  const width = Math.max(columns, MIN_HINT_COLUMNS);
  const stop = CONTROLS[ALWAYS_AVAILABLE_CONTROL];
  const rest = CONTROL_ORDER.filter((control) => control.command !== ALWAYS_AVAILABLE_CONTROL);
  const cells = [stop, ...rest].map((control) => `${control.key} ${control.label}`);

  const lines: string[] = [];
  let line = '';
  for (const cell of cells) {
    const candidate = line === '' ? cell : `${line}  ${cell}`;
    // Measured in terminal cells, not UTF-16 units: a label carrying a wide or combining character
    // would otherwise pack a row past the width a person actually has (see `width.ts`).
    if (displayWidth(candidate) > width && line !== '') {
      lines.push(line);
      line = cell;
    } else {
      line = candidate;
    }
  }
  if (line !== '') lines.push(line);
  // Wrapped like every other line of the frame: the hints are drawn as a section of their own and are
  // not wrapped again by the composer, so a row longer than the terminal would be a row cut in half.
  lines.push(...wrapToWidth(QUIT_IS_NOT_DISENGAGE_HINT, width));
  return lines;
};

/**
 * Invoke the control a keystroke names, or answer `null` when the key is not a control.
 *
 * `null` rather than a throw: a person pressing a key that does nothing has not made an error, and a
 * shell that fell over on an unrecognised keystroke would be a shell that fell over.
 */
export const invokeControlByKey = (
  key: string,
  context: ControlContext,
  argument: string | null = null,
): ControlOutcome | null => {
  const control = controlForKey(key);
  return control === null ? null : invokeControl(control.command, context, argument);
};
