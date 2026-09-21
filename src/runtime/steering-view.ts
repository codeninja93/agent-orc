/**
 * How this build treats each member of the `Command` enum, as data any surface may read.
 *
 * The table itself is story 1-3's and its wording is unchanged; what story 1-10 changed is where it
 * lives. The kill card is specified to offer `continue / narrow / kill / take over`, and `narrow` is
 * `{ kind: 'awaiting', owner: 'story 2-9…' }` — the intent file is written and deliberately left
 * unconsumed. A card that said so from a string of its own would drift the day the table changed, and a
 * card that hid the control would be worse: AD-19 makes the intent durable precisely so it is not lost,
 * and a person who presses a key deserves to know the file is written and who will act on it.
 *
 * So the table moved to `src/runtime/`, where the spine's dependency graph lets a renderer read it —
 * `tui -> contracts, runtime`, with no edge to the engine — and `src/engine/steering.ts` re-exports every
 * name, so nothing that decides an effect changed. This is story 1-9's resolution of the same
 * contradiction, applied a second time rather than re-argued.
 *
 * Nothing here decides an effect. The engine still owns what a command *does*; this owns only the claim
 * a surface is allowed to make about whether pressing the key will be acted on, and by whom.
 */
import type { Command, CommandMap } from '../contracts/index.js';

/**
 * How one command is treated. Four kinds, and the last is the one worth reading twice:
 *
 * - `effect` — the engine owns what the command does, and applies it.
 * - `question` — the command resolves the run's active question, so its effect is the AD-25
 *   compare-and-set rather than a run-state change. It is honoured, and it is a kind of its own because
 *   the state it changes does not live in the checkpoint at all: it lives in `questions/`, where exactly
 *   one transition is ever accepted and a losing resolver is told rather than thrown at.
 * - `acknowledge` — the command changes no run state in this build, so it is recorded with its
 *   principal, exactly once, and retired. Nothing else is ever going to act on it.
 * - `awaiting` — the command's effect belongs to a named later story. The file is **left in place**,
 *   unconsumed and unrecorded, and reported so it is visible rather than invisible. Acknowledging it
 *   instead would swallow a user's answer or a user's edit, which is why the three question commands were
 *   parked here until the compare-and-set existed to receive them.
 */
export type CommandHandling =
  | { readonly kind: 'effect' }
  | { readonly kind: 'question'; readonly note: string }
  | { readonly kind: 'acknowledge'; readonly note: string }
  | { readonly kind: 'awaiting'; readonly owner: string };

/** A total map, so adding a command to the enum is a compile error here rather than a silent gap. */
export const COMMAND_HANDLING: CommandMap<CommandHandling> = {
  answer: {
    kind: 'question',
    note: 'the answer resolves the run’s active question through the AD-25 compare-and-set (Q6)',
  },
  confirm_spec: { kind: 'effect' },
  edit_criterion: {
    kind: 'question',
    note: 'the amended criterion resolves the question that asked for it, one line at a time (CAP-2)',
  },
  approve: { kind: 'effect' },
  reject: {
    kind: 'question',
    note: 'the rejection resolves the question and its reason becomes the decision (CAP-18)',
  },
  continue: {
    kind: 'acknowledge',
    note: 'the run continues unchanged; the command is recorded so the decision is attributable',
  },
  narrow: { kind: 'awaiting', owner: 'story 2-9, which owns scope narrowing and the ceilings' },
  pause: {
    kind: 'awaiting',
    owner: 'story 2-9, which owns hibernation — the lifecycle has no non-terminal halted state yet',
  },
  inject_note: { kind: 'awaiting', owner: 'story 2-10, which owns a running agent’s next input' },
  kill: { kind: 'effect' },
  fork: { kind: 'awaiting', owner: 'story 4-3, which owns forking a run from its current point' },
  take_over: { kind: 'effect' },
  disengage: { kind: 'effect' },
  just_do_it: {
    kind: 'acknowledge',
    note: 'recorded now so the decision is attributable; what it suppresses is story 1-8’s questions',
  },
};

/**
 * The commands that stop work already in flight.
 *
 * A stop gesture must not wait for the current step to finish — that is the whole of CAP-5 — and it must
 * not wait behind another command either, so two units read this list: the mid-step watcher looks for
 * these while a step is running, and the pass's ordering applies them before anything else it found.
 * `take_over` is one of them because the escape hatch takes the work away from the run: leaving the step
 * running would have the system and a person editing one worktree at the same time.
 *
 * It lives here, beside {@link COMMAND_HANDLING}, because the engine's reader and the engine's orderer are
 * two modules with an import edge in one direction only — the orderer is in `commands.ts` and the watcher
 * is in `reconciler.ts`, which imports it — so a list declared in the watcher could not be read by the
 * orderer without a cycle. One list, read by both, is the point: a stop command that sorted last would
 * make "always available" mean "after whatever else arrived first".
 */
export const STOP_COMMANDS: readonly Command[] = Object.freeze(['kill', 'disengage', 'take_over']);

/** True when this command stops work already in flight, and so outranks everything that does not. */
export const isStopCommand = (command: Command): boolean => STOP_COMMANDS.includes(command);

/**
 * The commands whose effect this build applies.
 *
 * Both `effect` and `question` count, because both do something durable when consumed. Only `awaiting`
 * and `acknowledge` are excluded, and for opposite reasons: the first is not implemented yet, and the
 * second changes nothing by design.
 */
export const HONOURED_COMMANDS: readonly Command[] = Object.freeze(
  (Object.keys(COMMAND_HANDLING) as Command[]).filter((command) => {
    const kind = COMMAND_HANDLING[command].kind;
    return kind === 'effect' || kind === 'question';
  }),
);

/** The commands that resolve a question rather than changing the run's own state. */
export const QUESTION_COMMANDS: readonly Command[] = Object.freeze(
  (Object.keys(COMMAND_HANDLING) as Command[]).filter(
    (command) => COMMAND_HANDLING[command].kind === 'question',
  ),
);

/**
 * What a surface may honestly say about one control, before anybody presses it.
 *
 * Three fields rather than one boolean, because "unavailable" is not what an `awaiting` command is: the
 * keystroke works, the file is written and kept, and a named unit will act on it. Flattening that to
 * `available: false` is what would make a renderer either hide the control or lie about it.
 */
export interface CommandAvailability {
  readonly command: Command;
  readonly kind: CommandHandling['kind'];
  /** True when *this* build acts on the command when it consumes the file. */
  readonly honoured: boolean;
  /** The unit that will act on it, for a command nothing acts on yet. `null` when something does. */
  readonly owner: string | null;
  /** One sentence a surface may render beside the control, or `null` when there is nothing to add. */
  readonly note: string | null;
}

/**
 * The disposition of one command, as a renderer reads it.
 *
 * The single accessor exists so no surface indexes `COMMAND_HANDLING` and re-derives these three facts
 * from its `kind`: two derivations of "is this honoured" would eventually disagree, and the disagreement
 * would show up as a control a person believed in.
 */
export const commandAvailability = (command: Command): CommandAvailability => {
  const handling = COMMAND_HANDLING[command];
  switch (handling.kind) {
    case 'effect':
      return { command, kind: 'effect', honoured: true, owner: null, note: null };
    case 'question':
      return { command, kind: 'question', honoured: true, owner: null, note: handling.note };
    case 'acknowledge':
      return { command, kind: 'acknowledge', honoured: false, owner: null, note: handling.note };
    case 'awaiting':
      return {
        command,
        kind: 'awaiting',
        honoured: false,
        owner: handling.owner,
        note: null,
      };
  }
};

/** Every command's disposition, in the enum's declaration order. */
export const commandAvailabilities = (): readonly CommandAvailability[] =>
  (Object.keys(COMMAND_HANDLING) as Command[]).map(commandAvailability);
