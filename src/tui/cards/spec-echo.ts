/**
 * The spec echo card: the acceptance criteria, numbered, confirmable in one keystroke, editable by line.
 *
 * CAP-2's requirement has three parts and each one shapes something here.
 *
 * **Numbered, because a criterion has to be addressable.** "Editable line by line" is impossible unless a
 * person and the system agree on what "that line" means, so the numbers are part of the card rather than
 * decoration, and {@link editCriterionArgument} is the one place a line number becomes the text an
 * `edit_criterion` intent carries. Both halves of that agreement live here, so an amendment cannot name a
 * line the card numbered differently — and `criterionEditedPayload` in `src/engine/reconciler.ts` is what
 * reads it back.
 *
 * **Confirmable in one keystroke**, and the keystroke is read from the control table rather than written
 * here. A card that spelled `c` itself would go on saying `c` the day the table moved it.
 *
 * **Free text, no format imposed** (Q6). The card states what an amendment looks like as a hint, and the
 * engine parses what arrives; it never refuses a person's wording.
 *
 * **The criteria are folded from the log, not injected.** Story 1-10 had to take them as an argument,
 * because `run.created` carried `{ mode, step_count }` and nothing else — which made this the one required
 * surface a completed run's log could not reconstruct, and the gap the stage-1 gate was pinned on. Story
 * 1-11 put them in the log as `spec.recorded`, so the fold is now the source and the injected list is only
 * a fallback for a caller holding criteria the log does not carry (an older run's log, or a plan not yet
 * accepted). A log with no `spec.recorded` still gets a card that says plainly that nothing has recorded
 * them: it does not print an empty numbered list and then offer to confirm it, because confirming nothing
 * would record a durable decision about an empty set (CAP-18).
 */
import { Command } from '../../contracts/index.js';
import { CONTROLS } from '../controls.js';
import { UNRECORDED_PRESENTATION, presentValue } from '../projection.js';
import type { ShellView, SpecCriterionView } from '../projection.js';

import type { CardBody } from './index.js';

/** One criterion, and the number a person uses to name it. Numbered from 1, as a person counts. */
export interface SpecEchoCriterion {
  readonly line: number;
  readonly text: string;
  /** True when a `spec.criterion_edited` line amended this one, so the card can say so (CAP-2). */
  readonly edited: boolean;
}

export interface SpecEchoCard extends CardBody {
  readonly kind: 'spec-echo';
  readonly criteria: readonly SpecEchoCriterion[];
  /** The user's original words, as the log recorded them, or `(not recorded)`. */
  readonly request: string;
  /** The one keystroke that confirms every criterion as written. */
  readonly confirmKey: string;
  /** The keystroke that amends one line. */
  readonly editKey: string;
  /** True when nothing has recorded the criteria, so there is nothing to confirm yet. */
  readonly unrecorded: boolean;
}

export interface SpecEchoCardInput {
  readonly view: ShellView;
  /**
   * Criteria a caller holds that the log does not carry.
   *
   * A fallback, not the source: the fold wins whenever it has any. Kept because a caller may legitimately
   * have criteria before a run exists — a plan being drafted — and because a log written before
   * `spec.recorded` existed carries none (AD-5).
   */
  readonly criteria?: readonly string[];
}

/**
 * The text an `edit_criterion` intent carries, naming the line it amends.
 *
 * The line number leads, because the intent's argument is free text that the engine parses and the one
 * thing it must be able to recover is *which* criterion was amended. Q6 still holds: the amendment itself
 * is whatever the person wrote, unaltered and untrimmed of meaning.
 *
 * **A keystroke does not go through this function, and that is the honest contract.** There is no line
 * selection in this card — no cursor, no highlighted row — so a person pressing the edit key types the
 * number themselves and `src/tui/input.ts` sends the draft verbatim (AD-19, Q6). This is the canonical
 * spelling, for a programmatic caller that already knows the line and for pinning the *other* half of the
 * agreement: `criterionEditedPayload` in the reconciler has to read back both what this writes and what
 * {@link EDIT_CRITERION_HINT} tells a person to type, and `tests/tui.cards.test.ts` asserts it does.
 */
export const editCriterionArgument = (line: number, amendment: string): string =>
  `criterion ${String(line)}: ${amendment}`;

/**
 * What the card tells a person to type, which has to be something the engine can read back.
 *
 * It said "give its number and your wording, in your own words" while the engine's parser accepted only a
 * leading literal `criterion N:` — so the amendment a person was invited to type was recorded with no line
 * number at all, and the spec echo went on showing the original wording. The parser now reads a bare
 * leading number too, and this states the shape rather than leaving it to be guessed. It is addressing, not
 * formatting: Q6 governs the *wording*, which is untouched.
 */
export const EDIT_CRITERION_HINT =
  'start with the line number — "3: <your wording>" — and then say it in your own words';

/** The criteria, numbered as a person counts them. Nothing injected has been edited, by construction. */
export const numberCriteria = (criteria: readonly string[]): readonly SpecEchoCriterion[] =>
  criteria.map((text, index) => ({ line: index + 1, text, edited: false }));

/** The fold's criteria, which already carry their line and their edit flag. */
const foldedCriteria = (folded: readonly SpecCriterionView[]): readonly SpecEchoCriterion[] =>
  folded.map((criterion) => ({
    line: criterion.line,
    text: criterion.text,
    edited: criterion.edited,
  }));

/**
 * Build the spec echo card.
 *
 * Pure, and a fold of the log first. `presentValue` is what states a criterion the AD-21 pass replaced:
 * a criterion quoting a real ULID or commit SHA reaches the log with that identifier redacted, and a card
 * showing `[redacted]` as content would be wrong in a way a person could not see.
 */
export const buildSpecEchoCard = (input: SpecEchoCardInput): SpecEchoCard => {
  const folded = input.view.spec;
  const criteria =
    folded.criteria.length > 0
      ? foldedCriteria(folded.criteria)
      : numberCriteria(input.criteria ?? []);
  const confirmKey = CONTROLS[Command.ConfirmSpec].key;
  const editKey = CONTROLS[Command.EditCriterion].key;
  const feature = input.view.feature ?? 'this feature';
  const request = presentValue(folded.request);
  const amended = criteria.filter((criterion) => criterion.edited);

  const lines =
    criteria.length === 0
      ? [
          `acceptance criteria: ${UNRECORDED_PRESENTATION}`,
          'nothing has recorded the criteria for this run, so there is nothing to confirm yet — ' +
            'confirming an empty set would record a decision about nothing',
        ]
      : [
          ...(request === UNRECORDED_PRESENTATION ? [] : [`you asked for: ${request}`]),
          `these are the criteria ${feature} will be built against, and judged against:`,
          ...criteria.map(
            (criterion) =>
              `  ${String(criterion.line)}. ${presentValue(criterion.text)}` +
              (criterion.edited ? '  (edited)' : ''),
          ),
          // Stated once as well as marked per line, because R8's instinct applies to an amendment too: a
          // person confirming a set is owed the fact that it is not the set first recorded.
          ...(amended.length === 0
            ? []
            : [
                `${String(amended.length)} of these ${
                  amended.length === 1 ? 'was' : 'were'
                } amended after they were first recorded; the wording above is the current one`,
              ]),
          `press "${confirmKey}" to confirm all ${String(criteria.length)} as written`,
          `press "${editKey}" to amend one: ${EDIT_CRITERION_HINT}`,
        ];

  return {
    kind: 'spec-echo',
    title: `spec echo — ${String(criteria.length)} acceptance criteria, editable line by line`,
    criteria,
    request,
    confirmKey,
    editKey,
    unrecorded: criteria.length === 0,
    lines,
  };
};
