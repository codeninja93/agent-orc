/**
 * The spec echo card: the acceptance criteria, numbered, confirmable in one keystroke, editable by line.
 *
 * CAP-2's requirement has three parts and each one shapes something here.
 *
 * **Numbered, because a criterion has to be addressable.** "Editable line by line" is impossible unless a
 * person and the system agree on what "that line" means, so the numbers are part of the card rather than
 * decoration, and {@link editCriterionArgument} is the one place a line number becomes the text an
 * `edit_criterion` intent carries. Both halves of that agreement live here, so an amendment cannot name a
 * line the card numbered differently.
 *
 * **Confirmable in one keystroke**, and the keystroke is read from the control table rather than written
 * here. A card that spelled `c` itself would go on saying `c` the day the table moved it.
 *
 * **Free text, no format imposed** (Q6). The card states what an amendment looks like as a hint, and the
 * engine parses what arrives; it never refuses a person's wording.
 *
 * At stage 1 nothing records the criteria — the Interviewer is story 2-8 — so the card is built complete
 * and says plainly that nothing has recorded them yet. It does not print an empty numbered list and then
 * offer to confirm it: confirming nothing would be a durable decision about an empty set (CAP-18).
 */
import { Command } from '../../contracts/index.js';
import { CONTROLS } from '../controls.js';
import { UNRECORDED_PRESENTATION } from '../projection.js';
import type { ShellView } from '../projection.js';

import type { CardBody } from './index.js';

/** One criterion, and the number a person uses to name it. Numbered from 1, as a person counts. */
export interface SpecEchoCriterion {
  readonly line: number;
  readonly text: string;
}

export interface SpecEchoCard extends CardBody {
  readonly kind: 'spec-echo';
  readonly criteria: readonly SpecEchoCriterion[];
  /** The one keystroke that confirms every criterion as written. */
  readonly confirmKey: string;
  /** The keystroke that amends one line. */
  readonly editKey: string;
  /** True when nothing has recorded the criteria, so there is nothing to confirm yet. */
  readonly unrecorded: boolean;
}

export interface SpecEchoCardInput {
  readonly view: ShellView;
  readonly criteria?: readonly string[];
}

/**
 * The text an `edit_criterion` intent carries, naming the line it amends.
 *
 * The line number leads, because the intent's argument is free text that a later story parses and the one
 * thing it must be able to recover is *which* criterion was amended. Q6 still holds: the amendment itself
 * is whatever the person wrote, unaltered and untrimmed of meaning.
 */
export const editCriterionArgument = (line: number, amendment: string): string =>
  `criterion ${String(line)}: ${amendment}`;

/** The criteria, numbered as a person counts them. */
export const numberCriteria = (criteria: readonly string[]): readonly SpecEchoCriterion[] =>
  criteria.map((text, index) => ({ line: index + 1, text }));

/**
 * Build the spec echo card.
 *
 * Pure. The criteria arrive as data because no event records them yet: the log carries the run, the steps
 * and the questions, and the criteria live in the plan the reconciler was handed. Passing them in keeps
 * this card honest about its input rather than inventing a fold over events that do not exist.
 */
export const buildSpecEchoCard = (input: SpecEchoCardInput): SpecEchoCard => {
  const criteria = numberCriteria(input.criteria ?? []);
  const confirmKey = CONTROLS[Command.ConfirmSpec].key;
  const editKey = CONTROLS[Command.EditCriterion].key;
  const feature = input.view.feature ?? 'this feature';

  const lines =
    criteria.length === 0
      ? [
          `acceptance criteria: ${UNRECORDED_PRESENTATION}`,
          'nothing has recorded the criteria for this run, so there is nothing to confirm yet — ' +
            'confirming an empty set would record a decision about nothing',
        ]
      : [
          `these are the criteria ${feature} will be built against, and judged against:`,
          ...criteria.map((criterion) => `  ${String(criterion.line)}. ${criterion.text}`),
          `press "${confirmKey}" to confirm all ${String(criteria.length)} as written`,
          `press "${editKey}" to amend one: give its number and your wording, in your own words`,
        ];

  return {
    kind: 'spec-echo',
    title: `spec echo — ${String(criteria.length)} acceptance criteria, editable line by line`,
    criteria,
    confirmKey,
    editKey,
    unrecorded: criteria.length === 0,
    lines,
  };
};
