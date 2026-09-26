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
 * chosen by looking at one view. `cardForView` answers the narrower question of which card *this run* is
 * asking for.
 *
 * What does not follow from that — and was for a while treated as if it did — is that the brief has no way
 * onto a screen. It is a **separate invocation**: `mountBrief` in `src/tui/app.tsx`, beside `mountShell`.
 * One is "watch this feature" and the other is "what is everything doing", and the contract lists both.
 */
import { STOPPED_FEATURE_STATES } from '../mode.js';
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
/**
 * Story 4-4's attention card. Re-exported alongside the six required surfaces above without joining
 * `CARD_KINDS`, the `Card` union, or `cardForView` (Boundaries) — not because it is fleet-wide (`BriefCard`
 * is a fleet-wide card and *is* a member of `CARD_KINDS`/`Card`; it is only excluded from `cardForView`'s
 * switch), but because `src/tui/cards.tsx`'s `CardView` switch is documented as total over `Card['kind']`
 * ("a seventh surface is a compile error here rather than a card that silently draws nothing"). Joining
 * `CARD_KINDS`/`Card` would force an `AttentionCardView` Ink component into existence purely to satisfy
 * that exhaustiveness check, for a card nothing mounts yet — out of scope for this story.
 */
export * from './attention.js';

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

/**
 * One card as lines: the headline first, then the body. What the component draws, and what a suite reads.
 *
 * Typed over `Pick<CardBody, 'title' | 'lines'>` rather than `CardBody` itself, so a card-shaped structure
 * that is deliberately not a `Card` — the attention card (Boundaries) — can still be joined with the same
 * helper a `Card` suite uses, instead of a caller hand-rolling `[card.title, ...card.lines].join('\n')`.
 * Backward compatible: every existing caller already satisfies the narrower type.
 */
export const cardLines = (card: Pick<CardBody, 'title' | 'lines'>): readonly string[] => [
  card.title,
  ...card.lines,
];

/** One card as text, for a suite and for anything that is not a terminal. */
export const cardText = (card: Pick<CardBody, 'title' | 'lines'>): string => cardLines(card).join('\n');

/** The facts a card accepts beyond the view, each optional and each `(not recorded)` when absent. */
export interface CardInputs {
  /** The question as `questions/<id>/state.json` holds it, when the reader has it in reach. */
  readonly question?: QuestionDetail | null;
  /**
   * Acceptance criteria a caller holds that the log does not carry (CAP-2).
   *
   * A fallback since story 1-11: `spec.recorded` puts them in the log, so the fold is the source and this is
   * only for a log written before that type existed, or a plan not yet accepted.
   */
  readonly criteria?: readonly string[];
  /** What a later story records about a completion: the merge, the file count, the test result. */
  readonly completion?: CompletionFacts;
  /** Where a handed-off run's work and note are, as their owners named them. */
  readonly handoff?: HandoffLocation;
  /**
   * The run id, from an event envelope, so the handoff card can derive the branch and the document.
   *
   * It is an input rather than a field of `ShellView` because R6 keeps the run id out of the view entirely:
   * no render may require a person to know one. A caller that folded a log has the envelope, and passing the
   * id in is what lets the derivation happen without the view carrying it.
   */
  readonly run?: string | null;
  /** `ORCH_HOME`, so the handoff document's path is resolved by the module that owns the AD-9 layout. */
  readonly orchHome?: string;
  /** Free text typed and not yet submitted, echoed by the question card rather than submitted. */
  readonly draft?: string | null;
  readonly now?: Date;
}

/**
 * Which card this run is asking for, decided in one place.
 *
 * The order is the order of urgency, and each branch is a claim about what the person is for. The list is
 * the implemented order, including the step between the switch and the last call that the previous version
 * of this comment left out:
 *
 * 1. a pending question outranks everything — it is the only state where the run cannot proceed without
 *    them (R14);
 * 2. `drafting` is the spec echo: the run is waiting on the criteria being confirmed (CAP-2);
 * 3. the two terminal states that have something to explain get the card that explains it — `committed`
 *    the completion notice, `handed_off` the colleague's note;
 * 4. `degraded` gets the kill card: a ceiling was reached and the choice is now a person's;
 * 5. a question that has *settled* keeps its card, so the outcome somebody was waiting for does not
 *    vanish the instant it arrives;
 * 6. a run over its estimate gets the kill card, because that is the moment R11 exists for: abandoning
 *    early has to be easy — and only a run that is still going can be abandoned, which is why a stopped
 *    run never reaches it;
 * 7. otherwise no card. The shell's own question slot already states that nothing needs them, and a card
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
        ...(inputs.run === undefined ? {} : { run: inputs.run }),
        ...(inputs.orchHome === undefined ? {} : { orchHome: inputs.orchHome }),
      });
    case 'degraded':
      return buildKillCard({ view, now });
    /**
     * The two terminal states that have no card of their own, named rather than left to the default.
     *
     * Without this they fell through to {@link isOverEstimate} and could be handed the **kill card** —
     * "continue / narrow / kill / take over" offered for a run that is already dead. Every one of those
     * four gestures is a claim that something is still going, and a person pressing `k` on a killed run
     * would write a durable intent (AD-19) against a run the reconciler will refuse, having been told by
     * the surface that it was theirs to stop. `hibernated` is the same shape: AD-24 has a run reach a
     * ceiling and stop, so `narrow` and `continue` are equally untrue of it.
     *
     * No card, rather than a card that says nothing: the frame's mode line already reads
     * `mode stopped · killed` in every frame, which is the whole of what a person needs, and R1 makes
     * silence the default.
     */
    case 'killed':
    case 'hibernated':
      return null;
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

  /**
   * Only a run that is still going can be abandoned early, so only one reaches the kill card here.
   *
   * The switch names the four terminal states above, so this guard is today a second lock on a door that
   * is already shut — and it is the one that stays shut when a terminal state is added to the contract and
   * not to the switch, which is precisely how `killed` reached this line in the first place.
   */
  const stopped = view.featureState !== null && STOPPED_FEATURE_STATES.includes(view.featureState);
  return !stopped && isOverEstimate(view, now) ? buildKillCard({ view, now }) : null;
};
