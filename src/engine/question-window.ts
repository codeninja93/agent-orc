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
 * `describeDefaultTaken` is the sentence a person gets when the clock beat them, and it is part of
 * the contract rather than an afterthought — a user who believes their answer landed and a system that
 * took the default have diverged about a decision AD-25 has already made durable.
 *
 * **Four of the names this module used to define now live in `src/runtime/question-view.ts`.** Story
 * 1-10's one-question card states the recommendation, the window remaining and — when the clock won — the
 * sentence above, and the spine forbids a renderer importing the engine. The reading half therefore moved
 * to the runtime and is re-exported here unchanged, so every existing caller and its tests are untouched.
 * What stayed is what *acts*: the timeout principal, the resolution the clock submits, and the
 * compare-and-set it competes in.
 */
import type { Principal, Question, QuestionResolution } from '../contracts/index.js';
import { recommendedOption } from '../runtime/index.js';
import type { RunPaths } from '../runtime/index.js';

import { attemptQuestionResolution, questionResolution } from './questions.js';
import type { QuestionClaim } from './questions.js';

export {
  describeDefaultTaken,
  isQuestionDefaultDue,
  questionDefaultDueAt,
  questionDefaultDueAtMs,
  questionWindowRemainingMs,
  recommendedOption,
} from '../runtime/index.js';
export type { RecommendableQuestion, WindowedQuestion } from '../runtime/index.js';

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
