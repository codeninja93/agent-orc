/**
 * CAP-4 — the window after which a question's recommended default is taken.
 *
 * The clock is a *resolver*, not a special case, and that is the whole design. AD-25 names three
 * resolvers — the TUI answer, the web answer and the timeout default — and all three compete in the same
 * compare-and-set, so the timeout takes the default by creating the same exclusively created outcome file
 * a person's answer would. Treating expiry as a separate mechanism would give it a second path to the
 * decision, and two paths to one decision is what AD-25 exists to prevent.
 *
 * That is also what makes non-response a valid input rather than a stall: the interface contract requires
 * every question to state what happens if it is ignored and the window before that happens (Q2), and a
 * window nothing acts on is a promise the system does not keep. So a pass takes a due default whether or
 * not anything else is happening in that run.
 *
 * **"It timed out while I was typing" is the case worth being unambiguous about.** Two of the three
 * resolvers are a person and a clock, and they will collide. Whichever wins, the other is told plainly:
 * {@link describeDefaultTaken} is the sentence a person gets when the clock beat them, and it is part of
 * the contract rather than an afterthought — a user who believes their answer landed and a system that
 * took the default have diverged about a decision AD-25 has already made durable.
 */
import { formatTimestamp } from '../contracts/index.js';
import type { Principal, Question, QuestionResolution, QuestionState } from '../contracts/index.js';
import type { RunPaths } from '../runtime/index.js';

import { attemptQuestionResolution, questionResolution } from './questions.js';
import type { QuestionClaim } from './questions.js';

/**
 * Who a default taken by the clock is attributable to.
 *
 * AD-19 requires every decision to record a principal, and `timeout` is one of the three declared kinds
 * precisely so a default has an honest one: nobody decided this, the window did, and the record says so
 * rather than attributing it to the user who did not answer.
 */
export const QUESTION_TIMEOUT_PRINCIPAL: Principal = Object.freeze({
  kind: 'timeout',
  id: 'question.window',
});

/** The instant a question's default becomes due: when it was asked, plus its declared window (Q2). */
export const questionDefaultDueAtMs = (question: Question): number =>
  Date.parse(question.asked_at) + question.default_window_ms;

/** The same instant, formatted, so a message can name it. */
export const questionDefaultDueAt = (question: Question): string =>
  formatTimestamp(new Date(questionDefaultDueAtMs(question)));

/** How long is left before the default is taken; zero once it is due. */
export const questionWindowRemainingMs = (question: Question, now: Date): number =>
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
export const recommendedOption = (question: Question): { label: string; consequence: string } => {
  const found =
    question.options.find((option) => option.id === question.recommended_option_id) ??
    (question.escape.id === question.recommended_option_id ? question.escape : null);
  // `QuestionDraftSchema` refines that the recommended id names an offered option, so this is
  // unreachable; it answers with the declared consequence of silence rather than throwing, because a
  // default that could not be taken would turn CAP-4's promise into a stall.
  return found ?? { label: question.recommended_option_id, consequence: question.default_action };
};

/**
 * The resolution the clock submits.
 *
 * The answer text is the declared consequence of silence, not an invented sentence: Q2 already required
 * the question to say what happens if it is ignored, so the decision record repeats the user's own
 * contract back rather than a paraphrase the system made up.
 */
export const questionDefaultResolution = (question: Question, now: Date): QuestionResolution => {
  const option = recommendedOption(question);
  return questionResolution({
    resolver: 'timeout_default',
    principal: QUESTION_TIMEOUT_PRINCIPAL,
    answer:
      `The window of ${String(question.default_window_ms)}ms passed with no answer, so the ` +
      `recommended default was taken: ${option.label}. ${question.default_action}`,
    optionId: question.recommended_option_id,
    resolvedAt: now,
  });
};

/**
 * Take a due default, competing in the same compare-and-set every other resolver competes in.
 *
 * It does *not* check whether the window is due: {@link isQuestionDefaultDue} is the caller's question,
 * and folding it in here would hide the one decision a caller has to make from the caller that makes it.
 * What it does guarantee is the property AD-25 asks for — if an answer landed a millisecond earlier, this
 * call loses the `O_EXCL` create, writes nothing, and reports the answer that stands.
 */
export const takeQuestionDefault = (
  paths: RunPaths,
  questionId: string,
  question: Question,
  now: Date,
): QuestionClaim =>
  attemptQuestionResolution(paths, questionId, questionDefaultResolution(question, now));

/**
 * What a person is told when the clock beat them.
 *
 * Plain, and naming the decision that stands rather than only the failure: the losing path's message is
 * the only thing standing between "my answer landed" and a durable decision that says otherwise.
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
