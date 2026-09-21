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

/** Every control in the enum's declaration order, which is the order a frame lists them in. */
export const CONTROL_ORDER: readonly ControlDefinition[] = Object.freeze(
  COMMANDS.map((command) => CONTROLS[command]),
);

/** Every keystroke, in the same order. */
export const CONTROL_KEYS: readonly string[] = Object.freeze(
  CONTROL_ORDER.map((control) => control.key),
);

/** The control a keystroke invokes, or `null` for a key that is not a control. */
export const controlForKey = (key: string): ControlDefinition | null =>
  CONTROL_ORDER.find((control) => control.key === key.toLowerCase()) ?? null;

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
  readonly code = 'config.invalid';
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
  const width = Math.max(columns, 20);
  const stop = CONTROLS[ALWAYS_AVAILABLE_CONTROL];
  const rest = CONTROL_ORDER.filter((control) => control.command !== ALWAYS_AVAILABLE_CONTROL);
  const cells = [stop, ...rest].map((control) => `${control.key} ${control.label}`);

  const lines: string[] = [];
  let line = '';
  for (const cell of cells) {
    const candidate = line === '' ? cell : `${line}  ${cell}`;
    if (candidate.length > width && line !== '') {
      lines.push(line);
      line = cell;
    } else {
      line = candidate;
    }
  }
  if (line !== '') lines.push(line);
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
