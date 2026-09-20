/**
 * The one-question card: the surface the whole exchange rate is built around.
 *
 * `interface-contract.md` prices an interruption at roughly fifteen minutes of a person's focus, and Q1
 * through Q3 are what that price buys: a recommended default and at most three concrete options plus an
 * escape, what happens if the question is ignored and the window before it does, and a self-contained
 * mini-brief so the question is answerable without reloading the feature into the reader's head. This card
 * states all of it or says plainly which part nothing recorded.
 *
 * Four decisions are worth reading before changing anything here:
 *
 * **Three options plus the escape, bounded here as well as in the schema.** `QuestionDraftSchema` already
 * refuses a draft with more than three, so a bounded card looks redundant — until a log written by a newer
 * engine, or a question read from somewhere the schema did not gate, carries four. Q1 is a rule about what
 * a *person* is shown, so it is enforced where the showing happens, and the count that did not fit is
 * stated rather than swallowed. The escape is never one of the ones dropped: it is the option that exists
 * for the case the system did not anticipate, so dropping it would remove the only answer a person has
 * when none of the three is right.
 *
 * **The window is the remaining time, not the declared window, whenever that can be known.** Q2 asks for
 * "the window before that happens", and a person deciding whether to answer now needs what is left rather
 * than what it started as. That needs the instant the question was asked, which the log line does not
 * carry and the question state file does — so with the state file in reach the card counts down, and
 * without it the card states the declared window and says what it is.
 *
 * **A settled question keeps its card.** The outcome does not vanish the moment it arrives: a person who
 * was mid-sentence when the window closed is owed the sentence `describeDefaultTaken` composes, which is
 * the engine's own words to a losing resolver rather than a paraphrase this card invented.
 *
 * **A draft is echoed, never submitted.** Re-rendering is not consent. The card shows what has been typed
 * and says which keystroke sends it; the only thing that writes anything is a control invoked from
 * `src/tui/input.ts`, which writes one intent file and nothing else (AD-19).
 */
import type { QuestionOption, QuestionState } from '../../contracts/index.js';
import { describeDefaultTaken, questionWindowRemainingMs, recommendedOption } from '../../runtime/index.js';
import { UNRECORDED_PRESENTATION, presentValue } from '../projection.js';
import type { QuestionSlotState, ShellView } from '../projection.js';
import { formatDuration } from '../status.js';

import type { CardBody } from './index.js';

/** Q1 — at most three concrete options reach a person, however many were offered. */
export const MAX_QUESTION_CARD_OPTIONS = 3;

/**
 * A question as a *reader* finds it, which is not quite as the schema defines it.
 *
 * Spelled in the on-disk field names rather than in the view-model's camel case, so the question state
 * file's own `Question` can be handed over unchanged and the runtime's recommendation and window helpers
 * can read it directly. Every field is optional because a reader may have only the log line, and
 * `options` is unbounded because bounding it is this card's job rather than its input's.
 */
export interface QuestionDetail {
  readonly id?: string;
  readonly prompt?: string;
  /** Q3 — the mini-brief. It lives in the state file and is deliberately not duplicated into the log. */
  readonly brief?: string;
  readonly options?: readonly QuestionOption[];
  readonly escape?: QuestionOption;
  readonly recommended_option_id?: string;
  readonly default_action?: string;
  readonly default_window_ms?: number;
  readonly asked_at?: string;
  /** The settled state, when the reader has it: what the card renders `describeDefaultTaken` from. */
  readonly settled?: QuestionState;
}

/** One option as the card presents it: what it is, what it costs, and whether it is the recommendation. */
export interface QuestionCardOption {
  readonly id: string;
  readonly label: string;
  /** Q1 — the consequence of taking this option, stated on the card rather than left to be guessed. */
  readonly consequence: string;
  readonly recommended: boolean;
  /** True for the one option that exists because the three concrete ones may all be wrong. */
  readonly escape: boolean;
}

export interface QuestionCard extends CardBody {
  readonly kind: 'question';
  readonly state: QuestionSlotState;
  readonly prompt: string;
  /** Q3 — the mini-brief, or `(not recorded)` when only the log line was in reach. */
  readonly brief: string;
  /** At most {@link MAX_QUESTION_CARD_OPTIONS} concrete options, then the escape. */
  readonly options: readonly QuestionCardOption[];
  /** How many concrete options were offered and not shown. Stated, never silently dropped. */
  readonly optionsNotShown: number;
  /** Q2 — what happens if this is ignored. */
  readonly defaultAction: string;
  /** Q2 — the window before that happens, counted down when the card can know the instant it started. */
  readonly window: string;
  /** The outcome in a sentence, for a question that is no longer pending. */
  readonly outcome: string | null;
  /** What has been typed and not submitted. Echoed so a re-render cannot look like a submission. */
  readonly draft: string | null;
}

export interface QuestionCardInput {
  readonly view: ShellView;
  /** The question as the state file holds it, when the reader has it. The log line alone is enough. */
  readonly question?: QuestionDetail | null;
  readonly now?: Date;
  readonly draft?: string | null;
}

/** The three options that reach a person, then the escape, with the recommendation marked (Q1). */
export const boundedOptions = (detail: QuestionDetail | null): readonly QuestionCardOption[] => {
  if (detail === null) return [];
  const recommendedId = detail.recommended_option_id ?? null;
  const concrete = (detail.options ?? []).slice(0, MAX_QUESTION_CARD_OPTIONS).map((option) => ({
    id: option.id,
    label: option.label,
    consequence: option.consequence,
    recommended: option.id === recommendedId,
    escape: false,
  }));
  const escape = detail.escape;
  return escape === undefined
    ? concrete
    : [
        ...concrete,
        {
          id: escape.id,
          label: escape.label,
          consequence: escape.consequence,
          recommended: escape.id === recommendedId,
          escape: true,
        },
      ];
};

/**
 * How the window reads.
 *
 * Three cases rather than one, because the honest answer differs: counting down when the asking instant is
 * known, stating the declared window when only its length is, and saying nothing was recorded when neither
 * is. A card that guessed the start instant from the log's last line would count down from the wrong
 * moment, which is worse than saying what it knows.
 */
const windowPhrase = (
  detail: QuestionDetail | null,
  view: ShellView,
  now: Date,
): string => {
  const askedAt = detail?.asked_at ?? null;
  const windowMs = detail?.default_window_ms ?? view.question.defaultWindowMs;
  if (askedAt !== null && windowMs !== null) {
    const remaining = questionWindowRemainingMs({ asked_at: askedAt, default_window_ms: windowMs }, now);
    return remaining === 0
      ? 'the window has passed; the default is due'
      : `${formatDuration(remaining)} left before the default is taken`;
  }
  if (windowMs === null) return UNRECORDED_PRESENTATION;
  return `${formatDuration(windowMs)} from when it was asked`;
};

/**
 * The recommendation, when the reader has enough of the question to name it (Q1).
 *
 * `null` rather than a guess when the reader has only the log line: the log carries the recommended
 * option's *id* and not its consequence, and a card that printed the id where a consequence belongs would
 * be answering a different question than the one Q1 asks.
 */
const recommendationFor = (
  detail: QuestionDetail | null,
): { label: string; consequence: string } | null => {
  const options = detail?.options;
  const escape = detail?.escape;
  const recommendedId = detail?.recommended_option_id;
  const defaultAction = detail?.default_action;
  if (
    options === undefined ||
    escape === undefined ||
    recommendedId === undefined ||
    defaultAction === undefined
  ) {
    return null;
  }
  return recommendedOption({
    options,
    escape,
    recommended_option_id: recommendedId,
    default_action: defaultAction,
  });
};

/**
 * Build the one-question card.
 *
 * Pure, and a fold of what the log and — when it is in reach — the question state file hold. Nothing here
 * reads a clock, a file or an environment: `now` is passed in, so the same inputs give the same card and a
 * countdown is reproducible in a test.
 */
export const buildQuestionCard = (input: QuestionCardInput): QuestionCard => {
  const view = input.view;
  const slot = view.question;
  const detail = input.question ?? null;
  const now = input.now ?? new Date();
  const draft = input.draft === undefined || input.draft === null || input.draft === '' ? null : input.draft;

  const prompt = presentValue(detail?.prompt ?? slot.prompt);
  const brief = presentValue(detail?.brief ?? null);
  const options = boundedOptions(detail);
  const offered = detail?.options?.length ?? 0;
  const optionsNotShown = Math.max(offered - MAX_QUESTION_CARD_OPTIONS, 0);
  const defaultAction = presentValue(detail?.default_action ?? slot.defaultAction);
  const window = windowPhrase(detail, view, now);
  const recommended = recommendationFor(detail);

  if (slot.state === 'pending') {
    const lines = [
      prompt,
      `brief: ${brief}`,
      'options:',
      ...options.map(
        (option, index) =>
          `  [${option.escape ? 'esc' : String(index + 1)}] ${option.label} — ${option.consequence}` +
          (option.recommended ? '  (recommended)' : ''),
      ),
      ...(options.length === 0 ? [`  ${UNRECORDED_PRESENTATION}`] : []),
      ...(optionsNotShown === 0
        ? []
        : [
            `  ${String(optionsNotShown)} further option${optionsNotShown === 1 ? '' : 's'} ` +
              'were offered and are not shown; at most three reach you, plus the escape (Q1)',
          ]),
      `if ignored: ${defaultAction}`,
      `window: ${window}`,
      ...(recommended === null ? [] : [`recommended: ${recommended.label} — ${recommended.consequence}`]),
      ...(draft === null
        ? []
        : [
            `typed and not yet sent: "${draft}"`,
            'nothing is submitted until you send it; a redraw is not an answer',
          ]),
    ];
    return {
      kind: 'question',
      title: 'question — your answer is what this run is waiting for',
      state: slot.state,
      prompt,
      brief,
      options,
      optionsNotShown,
      defaultAction,
      window,
      outcome: null,
      draft,
      lines,
    };
  }

  // A settled question, including the case the window settled while somebody was typing. The engine's own
  // sentence to a losing resolver is preferred over the fold's shorter one whenever the reader has the
  // settled state, so the terminal and the refusal say the same thing about the same decision.
  const settled = detail?.settled ?? null;
  const outcome =
    slot.state === 'empty'
      ? null
      : settled !== null
        ? describeDefaultTaken(settled)
        : (slot.outcome ?? 'no outcome recorded');

  const lines =
    slot.state === 'empty'
      ? ['no question is pending, and nothing needs you']
      : [
          prompt,
          `${slot.state}: ${outcome ?? 'no outcome recorded'}`,
          `recorded answer: ${presentValue(slot.answer)}`,
          ...(draft === null
            ? []
            : [
                `what you had typed was not submitted: "${draft}"`,
                'the decision above stands; nothing you typed was written',
              ]),
        ];

  return {
    kind: 'question',
    title:
      slot.state === 'empty'
        ? 'question — none pending'
        : `question — ${slot.state}, and nothing more is needed from you`,
    state: slot.state,
    prompt,
    brief,
    options,
    optionsNotShown,
    defaultAction,
    window,
    outcome,
    draft,
    lines,
  };
};
