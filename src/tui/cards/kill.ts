/**
 * The kill card: usage and elapsed against estimate, with continue / narrow / kill / take over.
 *
 * R11's reason for existing is one sentence — "Elapsed-versus-estimate is always visible, so abandoning
 * early is easy" — and this card is the moment that sentence is cashed in. So the four controls are all
 * offered together, and each one says what pressing it will actually do.
 *
 * **A control the system cannot honour says so, in the words of the table that knows.** `narrow` is
 * `{ kind: 'awaiting', owner: 'story 2-9…' }` in the steering table: the intent file is written and
 * deliberately left unconsumed. The card reads that from {@link commandAvailability} rather than from a
 * string of its own, so a control's availability cannot drift from the table that decides it — change the
 * table and this card changes with it. Hiding the control would be worse than saying so: AD-19 makes the
 * intent durable precisely so it is not lost, and a person who presses a key deserves to know that the
 * file is written and who will act on it.
 *
 * **Nothing here enforces a ceiling.** AD-24's ceilings and their degradation are story 2-9's. This card
 * displays consumed budget and elapsed against estimate and offers the four gestures; what it never does
 * is act on them, because a renderer that stopped a run by itself would be a second command path (AD-19).
 *
 * **Usage is tokens, never money, and the omission is the contract's.** R10 says cost is subscription usage
 * and never currency, and AD-24 gives a run three ceilings "and no currency dimension" — so this card, which
 * is the one a person decides *against a ceiling* on, states the consumed token counts story 1-11 put in the
 * log and states no currency figure at all. No surface renders one: the CLI's `total_cost_usd` is recorded
 * in the log for AD-24's ceilings to read, and rendering it would make cost currency, which R10 forbids.
 */
import { Command } from '../../contracts/index.js';
import { commandAvailability } from '../../runtime/index.js';
import type { CommandAvailability } from '../../runtime/index.js';
import { CONTROLS } from '../controls.js';
import type { ShellView } from '../projection.js';
import { elapsedMsAt, formatBudgetShare, formatElapsed, formatTokenUsage } from '../status.js';

import type { CardBody } from './index.js';

/**
 * The four controls `interface-contract.md` names for this card, in its order.
 *
 * Its order rather than the enum's: continue is first because carrying on is the commonest answer, and the
 * two irreversible-feeling ones are last so a person does not reach them by reflex.
 */
export const KILL_CARD_COMMANDS: readonly Command[] = Object.freeze([
  Command.Continue,
  Command.Narrow,
  Command.Kill,
  Command.TakeOver,
]);

/** One control on the card: its key, what it does, and whether anything will act on it. */
export interface KillCardControl {
  readonly command: Command;
  readonly key: string;
  readonly label: string;
  readonly hint: string;
  /** True when this build acts on the intent once it consumes it. */
  readonly honoured: boolean;
  /** The unit that will act on it, for a control nothing acts on yet (never hidden). */
  readonly owner: string | null;
  /** What pressing it does, in a sentence, including the awaiting case. */
  readonly availability: string;
}

export interface KillCard extends CardBody {
  readonly kind: 'kill';
  /** Consumed rate-limit budget, as a share of its own ceiling. Never a currency amount (AD-24). */
  readonly usage: string;
  /** The tokens the log records this run consuming, or `(not recorded)`. Never money (R10). */
  readonly tokens: string;
  /** Elapsed against estimate, as one phrase (R11). */
  readonly elapsed: string;
  /** True when the run has passed the estimate the log recorded. */
  readonly overEstimate: boolean;
  readonly controls: readonly KillCardControl[];
}

export interface KillCardInput {
  readonly view: ShellView;
  readonly now?: Date;
}

/**
 * True when the run has passed the estimate the log recorded.
 *
 * `false` when there is no estimate, and that is a deliberate asymmetry: an unrecorded estimate is not an
 * exceeded one, and a card that appeared because nothing had been estimated would appear on every run.
 */
export const isOverEstimate = (view: ShellView, now: Date): boolean => {
  const estimate = view.usage.estimateMs;
  if (estimate === null) return false;
  const elapsed = elapsedMsAt(view, now);
  return elapsed !== null && elapsed > estimate;
};

/** What pressing one control does, in the words of the table that decides it. */
const availabilityPhrase = (availability: CommandAvailability): string => {
  switch (availability.kind) {
    case 'effect':
      return 'takes effect when the loop picks the file up';
    case 'question':
      return 'resolves the question in the slot above';
    case 'acknowledge':
      return availability.note ?? 'recorded, and nothing else changes';
    case 'awaiting':
      /**
       * Neutral about *what* is awaited, because this phrase is not only `narrow`'s.
       *
       * It said "nothing narrows yet" for every awaiting command, so rendering `pause`, `inject_note` or
       * `fork` produced a sentence about narrowing — a control described by the behaviour of a different
       * one. The parked fact is the same in all four cases and it is the one worth saying: the file is
       * written, it is kept, and a named unit will act on it (AD-19).
       */
      return (
        'the intent file is written and kept, unconsumed, awaiting ' +
        `${availability.owner ?? 'the unit that owns it'} — nothing acts on it yet`
      );
  }
};

/** One control, composed from the control table's keystroke and the steering table's disposition. */
export const killCardControl = (command: Command): KillCardControl => {
  const control = CONTROLS[command];
  const availability = commandAvailability(command);
  return {
    command,
    key: control.key,
    label: control.label,
    hint: control.hint,
    honoured: availability.honoured,
    owner: availability.owner,
    availability: availabilityPhrase(availability),
  };
};

/**
 * Build the kill card.
 *
 * Pure, and `now` is passed in for the reason every other clock in this directory is: elapsed has to keep
 * moving while the log does not, and a function that read the clock would not be reproducible.
 */
export const buildKillCard = (input: KillCardInput): KillCard => {
  const view = input.view;
  const now = input.now ?? new Date();
  const usage = formatBudgetShare(view.usage.rateLimitBudgetConsumed);
  const tokens = formatTokenUsage(view.usage.total);
  const elapsed = formatElapsed(view, now);
  const overEstimate = isOverEstimate(view, now);
  const controls = KILL_CARD_COMMANDS.map(killCardControl);

  const lines = [
    `rate-limit budget: ${usage} consumed`,
    `tokens consumed: ${tokens}`,
    `elapsed: ${elapsed}`,
    overEstimate
      ? 'this run has passed the estimate it was given, which is the reason this card is in front of you'
      : 'it is still within the estimate it was given',
    `next gate: ${view.progress.nextGate}`,
    'your four choices:',
    ...controls.map(
      (control) => `  [${control.key}] ${control.label} — ${control.hint} (${control.availability})`,
    ),
  ];

  return {
    kind: 'kill',
    title: `${view.feature ?? 'this run'} — carry on, narrow it, stop it, or take it over`,
    usage,
    tokens,
    elapsed,
    overEstimate,
    controls,
    lines,
  };
};
