/**
 * What a *reader* needs to know about a question: the recommendation, the window, and the sentence a
 * person gets when the clock beat them.
 *
 * These four facts used to live in `src/engine/question-window.ts` beside the resolver that acts on
 * them, and story 1-10 moved them here for one reason: the one-question card has to state the
 * recommended option, the window remaining and — when the default was taken while somebody was typing —
 * what happened instead, and the spine's dependency graph gives `tui -> contracts, runtime` with no edge
 * to the engine. Story 1-9 settled the same contradiction the same way for the intent writer, so this
 * follows its precedent rather than inventing a second resolution: the *mechanics a reader shares* move
 * into `src/runtime/`, the engine re-exports every name, and no existing caller changes.
 *
 * What deliberately stayed in the engine is everything that *acts*: the timeout principal, the
 * resolution the clock submits and the compare-and-set it competes in. A renderer needs none of that —
 * it writes an intent file (AD-19) and the loop resolves — so none of it moved.
 *
 * Every function here takes the narrowest structural shape it can rather than a whole `Question`. A
 * renderer reads a question from a log line or from the state file and neither hands it the parsed
 * contract type, so a parameter typed `Question` would force a cast at the one boundary casts are least
 * welcome. `Question` satisfies each of these shapes, so the engine's callers are unaffected.
 */
import { formatTimestamp } from '../contracts/index.js';
import type { QuestionOption, QuestionState } from '../contracts/index.js';

/**
 * A question whose default this reads: the options offered, the escape, the recommendation and the
 * declared consequence of silence.
 *
 * Deliberately unbounded in `options` where `QuestionDraftSchema` bounds it to three (Q1). The schema is
 * the gate on what may be *asked*; this is what a reader does with what it *finds*, and a reader that
 * refused to present a fourth option would drop it silently rather than bounding it visibly.
 */
export interface RecommendableQuestion {
  readonly options: readonly QuestionOption[];
  readonly escape: QuestionOption;
  readonly recommended_option_id: string;
  readonly default_action: string;
}

/** A question whose window this measures: when it was asked, and how long silence is allowed (Q2). */
export interface WindowedQuestion {
  readonly asked_at: string;
  readonly default_window_ms: number;
}

/** The instant a question's default becomes due: when it was asked, plus its declared window (Q2). */
export const questionDefaultDueAtMs = (question: WindowedQuestion): number =>
  Date.parse(question.asked_at) + question.default_window_ms;

/** The same instant, formatted, so a message can name it. */
export const questionDefaultDueAt = (question: WindowedQuestion): string =>
  formatTimestamp(new Date(questionDefaultDueAtMs(question)));

/** How long is left before the default is taken; zero once it is due. */
export const questionWindowRemainingMs = (question: WindowedQuestion, now: Date): number =>
  Math.max(questionDefaultDueAtMs(question) - now.getTime(), 0);

/**
 * True when this question's window has passed and nothing has resolved it.
 *
 * The status is part of the question, not a separate check a caller might forget: a resolved question's
 * window is irrelevant, and asking whether it is "due" would invite a second default on a question that
 * already has an answer.
 */
export const isQuestionDefaultDue = (state: QuestionState, now: Date): boolean =>
  state.status === 'asked' && now.getTime() >= questionDefaultDueAtMs(state.question);

/** The option the default takes: the recommended one, by id (Q1). */
export const recommendedOption = (
  question: RecommendableQuestion,
): { label: string; consequence: string } => {
  const found =
    question.options.find((option) => option.id === question.recommended_option_id) ??
    (question.escape.id === question.recommended_option_id ? question.escape : null);
  // `QuestionDraftSchema` refines that the recommended id names an offered option, so this is
  // unreachable for a question that was asked; it answers with the declared consequence of silence
  // rather than throwing, because a default that could not be taken would turn CAP-4's promise into a
  // stall — and a card that threw would take the whole frame with it.
  return found ?? { label: question.recommended_option_id, consequence: question.default_action };
};

/**
 * What a person is told when the clock beat them.
 *
 * Plain, and naming the decision that stands rather than only the failure: the losing path's message is
 * the only thing standing between "my answer landed" and a durable decision that says otherwise. The
 * one-question card renders this verbatim rather than paraphrasing it, so the terminal and the engine's
 * refusal say the same thing about the same decision.
 */
export const describeDefaultTaken = (state: QuestionState): string => {
  const resolution = state.resolution;
  if (resolution?.resolver !== 'timeout_default') {
    return (
      `Question ${state.question.id} was already ${state.status} when this answer arrived, so the ` +
      'answer that got there first stands and nothing was written.'
    );
  }
  return (
    `Question ${state.question.id} timed out before this answer arrived: the window of ` +
    `${String(state.question.default_window_ms)}ms passed at ` +
    `${questionDefaultDueAt(state.question)} and the recommended default was taken ` +
    `("${recommendedOption(state.question).label}"). That decision stands and is recorded; this ` +
    'answer wrote nothing. ' +
    state.question.default_action
  );
};
