/**
 * The six surfaces `interface-contract.md` requires, and which one a view calls for.
 *
 * Every card here is a **view-model first and a component second**: a pure function from a view to a
 * plain data structure, with the Ink tree in `src/tui/cards.tsx` doing nothing but laying that structure
 * out. Story 1-9 proved the ratio rather than assuming it — thirty-one pure tests and one rendered frame,
 * and the pure ones caught both injected mutations while the frame test caught neither. A card whose
 * logic lives in JSX can only be tested by rendering it.
 *
 * Two shapes are shared by all six, and nothing else is:
 *
 * - `kind`, so a renderer dispatches on data rather than on which builder it happened to call;
 * - `title` and `lines`, so the component that draws a card needs to know nothing about which card it is.
 *
 * Each card keeps its own structured fields beside those lines, and the suites assert against the fields
 * rather than the prose wherever a field exists — a test that only greps the rendered text passes just as
 * happily when the value behind it is wrong.
 *
 * **The brief is not in {@link cardForView}, and that is deliberate.** Five of the six are folds of one
 * `ShellView`; the morning brief is a fold of *every* run under `runsDir` (CAP-22), so it cannot be
 * chosen by looking at one view. The caller that has a fleet builds it; `cardForView` answers the
 * narrower question of which card *this run* is asking for.
 */
import type { ShellView } from '../projection.js';

import type { BriefCard } from './brief.js';
import { buildCompletionCard } from './completion.js';
import type { CompletionCard, CompletionFacts } from './completion.js';
import { buildHandoffCard } from './handoff.js';
import type { HandoffCard, HandoffLocation } from './handoff.js';
import { buildKillCard, isOverEstimate } from './kill.js';
import type { KillCard } from './kill.js';
import { buildQuestionCard } from './question.js';
import type { QuestionCard, QuestionDetail } from './question.js';
import { buildSpecEchoCard } from './spec-echo.js';
import type { SpecEchoCard } from './spec-echo.js';

export * from './question.js';
export * from './spec-echo.js';
export * from './brief.js';
export * from './kill.js';
export * from './completion.js';
export * from './handoff.js';

/** The six surfaces, named once so a dispatch over them can be made total. */
export const CARD_KINDS = [
  'question',
  'spec-echo',
  'brief',
  'kill',
  'completion',
  'handoff',
] as const;

export type CardKind = (typeof CARD_KINDS)[number];

/**
 * What every card carries, whatever it is about.
 *
 * `lines` are unwrapped: a card states its content and the frame decides how wide the terminal is, which
 * is what lets one card be drawn at 80 columns and measured at 40 without two spellings of its text.
 */
export interface CardBody {
  readonly kind: CardKind;
  /** The headline, which stands alone (R3). */
  readonly title: string;
  readonly lines: readonly string[];
}

export type Card =
  | QuestionCard
  | SpecEchoCard
  | KillCard
  | CompletionCard
  | HandoffCard
  | BriefCard;

/** One card as lines: the headline first, then the body. What the component draws, and what a suite reads. */
export const cardLines = (card: CardBody): readonly string[] => [card.title, ...card.lines];

/** One card as text, for a suite and for anything that is not a terminal. */
export const cardText = (card: CardBody): string => cardLines(card).join('\n');

/** The facts a card accepts beyond the view, each optional and each `(not recorded)` when absent. */
export interface CardInputs {
  /** The question as `questions/<id>/state.json` holds it, when the reader has it in reach. */
  readonly question?: QuestionDetail | null;
  /** The acceptance criteria being echoed (CAP-2). Nothing in stage 1 records them yet. */
  readonly criteria?: readonly string[];
  /** What a later story records about a completion: the merge, the file count, the test result. */
  readonly completion?: CompletionFacts;
  /** Where a handed-off run's work and note are, as their owners named them. */
  readonly handoff?: HandoffLocation;
  /** Free text typed and not yet submitted, echoed by the question card rather than submitted. */
  readonly draft?: string | null;
  readonly now?: Date;
}

/**
 * Which card this run is asking for, decided in one place.
 *
 * The order is the order of urgency, and each branch is a claim about what the person is for:
 *
 * 1. a pending question outranks everything — it is the only state where the run cannot proceed without
 *    them (R14);
 * 2. `drafting` is the spec echo: the run is waiting on the criteria being confirmed (CAP-2);
 * 3. a terminal state gets the card that explains it — the completion notice or the colleague's note;
 * 4. a run over its estimate, or degraded at a ceiling, gets the kill card, because that is the moment
 *    R11 exists for: abandoning early has to be easy;
 * 5. otherwise no card. The shell's own question slot already states that nothing needs them, and a card
 *    drawn for the sake of having one is noise a person learns to skip (R1).
 */
export const cardForView = (view: ShellView, inputs: CardInputs = {}): Card | null => {
  const now = inputs.now ?? new Date();

  if (view.question.state === 'pending') {
    return buildQuestionCard({
      view,
      now,
      ...(inputs.question === undefined ? {} : { question: inputs.question }),
      ...(inputs.draft === undefined ? {} : { draft: inputs.draft }),
    });
  }

  switch (view.featureState) {
    case 'drafting':
      return buildSpecEchoCard({
        view,
        ...(inputs.criteria === undefined ? {} : { criteria: inputs.criteria }),
      });
    case 'committed':
      return buildCompletionCard({
        view,
        now,
        ...(inputs.completion === undefined ? {} : { facts: inputs.completion }),
      });
    case 'handed_off':
      return buildHandoffCard({
        view,
        ...(inputs.handoff === undefined ? {} : { location: inputs.handoff }),
      });
    case 'degraded':
      return buildKillCard({ view, now });
    default:
      break;
  }

  // A settled question still gets its card, so the outcome a person was waiting for does not vanish the
  // instant it arrives — including the case where the window took the default while they were typing.
  if (view.question.state !== 'empty') {
    return buildQuestionCard({
      view,
      now,
      ...(inputs.question === undefined ? {} : { question: inputs.question }),
      ...(inputs.draft === undefined ? {} : { draft: inputs.draft }),
    });
  }

  return isOverEstimate(view, now) ? buildKillCard({ view, now }) : null;
};
