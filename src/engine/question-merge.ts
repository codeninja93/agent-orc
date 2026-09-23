/**
 * CAP-3 — question compression: questions that are the same question become one before any is asked.
 *
 * Two subagents working one feature routinely hit the same undecided point from two sides, and asking
 * a person twice is the cost the Interviewer exists to remove (glossary: "at most one reaches the
 * user"). This module decides which raised questions are the same question and composes the one card
 * that stands for them.
 *
 * **"The same question" is the same anchor, compared for equality in both parts.** Two drafts declaring
 * `resolveProject` / `null-on-miss` are one question; two whose prose reads alike but which declare
 * `resolveProject` and `resolveProjectPath`, or `resolveProject` with two different aspects, are two, and
 * are asked as two. Prose similarity is
 * never a signal here, for the reason `deflection.ts` gives for matching: code cannot judge meaning, and
 * a classifier that could would be a second model family outside AD-1's boundary. Anchors are compared
 * verbatim — no case folding, no trimming, no prefix rule — because every normalisation is a small
 * similarity measure, and the first one admitted is the one the next is argued from.
 *
 * **Where anchors cannot decide, the live turn does, and says so.** The Interviewer is already a Claude
 * turn (architecture.md: the one component that must be a live conversation), so a judgement that two
 * differently-anchored questions are one question is made there, inside the subscription-auth boundary,
 * and reaches this module as {@link mergeOnJudgment} carrying its reason. A reason is required, because a
 * merge nobody can explain is a question somebody silently stopped asking.
 *
 * **A merged question is still a question, and Q1 still binds it.** Every card this module returns has
 * passed `assertAskableDraft` — at most three concrete options plus an escape, a recommended default, a
 * window and a brief — on the merged draft itself, not on its parts. Merging is never a route past that
 * gate: a same-anchor group whose union would exceed three options, or whose askers differ on the
 * default, the default action or the escape, is not combined mechanically at all. It is handed back as
 * awaiting a judgement, because dropping one asker's declaration in favour of another's *is* a judgement.
 *
 * **One bad draft refuses itself, never the batch** (matrix 21). A draft or a merged card the gate refuses
 * is reported as a refusal for that question or group, and every other card is still composed — a
 * compression pass that threw on the first zero-window draft would discard every card and deflection it
 * had already worked out.
 *
 * **The reason a question was merged is recorded where the log will keep it.** A merged card's brief
 * states that it stands for several questions and why. The brief travels in the `question.asked` payload
 * (story 1-11), so the merge is reconstructable from `events.jsonl` alone (AD-4) without a new event type.
 */
import type { QuestionDraft, QuestionOption } from '../contracts/index.js';

import { formatAnchor, isUsableAnchor } from './deflection.js';
import type { QuestionAnchor } from './deflection.js';
import { QuestionDraftRefused, assertAskableDraft } from './questions.js';

/**
 * A question as a subagent raised it: its draft, and the anchor it is about.
 *
 * The anchor is carried beside the draft rather than inside it because `QuestionDraftSchema` has no
 * anchor field and a step's `questions` array is typed by that schema; the Interviewer supplies it when a
 * step did not.
 */
export interface RaisedQuestion {
  readonly draft: QuestionDraft;
  /** The symbol it is about and the aspect of it being asked — both required (matrix 17). */
  readonly anchor: QuestionAnchor;
  /** The step that raised it, or `null` for a run-level question. */
  readonly step: string | null;
}

/** Why a card stands for the questions it stands for. */
export type MergeBasis = 'single' | 'anchor' | 'judgment';

/** One card to ask: a draft `assertAskableDraft` has accepted, and the questions it answers. */
export interface MergedQuestion {
  readonly draft: QuestionDraft;
  /** Every distinct usable anchor the card answers, in first-raised order. */
  readonly anchors: readonly QuestionAnchor[];
  /** The raised questions this card stands for, in raised order. */
  readonly raised: readonly RaisedQuestion[];
  readonly basis: MergeBasis;
  /** R3 — why these questions are this card; for a judgement, the judgement's own words. */
  readonly reason: string;
}

/** A same-anchor group mechanics could not combine without deciding something, awaiting the live turn. */
export interface AwaitingJudgment {
  readonly anchor: QuestionAnchor;
  readonly raised: readonly RaisedQuestion[];
  /** What a mechanical merge would have had to decide. */
  readonly reason: string;
}

/** A single draft or a merged card the Q1 gate refused, reported for that question or group alone. */
export interface RefusedQuestion {
  readonly raised: readonly RaisedQuestion[];
  /** The draft field `assertAskableDraft` named. */
  readonly field: string;
  readonly reason: string;
}

export interface MergeOutcome {
  /** Cards ready to ask, in the order their first question was raised. */
  readonly questions: readonly MergedQuestion[];
  readonly awaitingJudgment: readonly AwaitingJudgment[];
  /** Questions or groups the gate refused; the rest of the batch is unaffected by them. */
  readonly refused: readonly RefusedQuestion[];
}

/** Q1's ceiling on concrete options, which a merged card is held to as firmly as a raised one. */
const MAX_CONCRETE_OPTIONS = 3;

const sameOption = (a: QuestionOption, b: QuestionOption): boolean =>
  a.label === b.label && a.consequence === b.consequence;

const sameEscape = (a: QuestionOption, b: QuestionOption): boolean => a.id === b.id && sameOption(a, b);

const distinct = (values: readonly string[]): readonly string[] => [...new Set(values)];

/** The anchors among `raised` that can be compared, each once, in first-raised order. */
const distinctAnchors = (raised: readonly RaisedQuestion[]): readonly QuestionAnchor[] => {
  const seen = new Map<string, QuestionAnchor>();
  for (const { anchor } of raised) {
    if (isUsableAnchor(anchor) && !seen.has(anchorKey(anchor))) seen.set(anchorKey(anchor), anchor);
  }
  return [...seen.values()];
};

/**
 * The grouping key: both parts, unambiguously.
 *
 * A JSON pair rather than `formatAnchor`'s `symbol:aspect`, because the display form cannot tell
 * `a:b` / `c` from `a` / `b:c`, and a key that could would merge two questions nobody showed were one.
 */
const anchorKey = (anchor: QuestionAnchor): string => JSON.stringify([anchor.symbol, anchor.aspect]);

/**
 * The shortest window among drafts — CAP-4's default must not arrive later than any asker was promised.
 *
 * Shared by both merge paths, so a judged card cannot outlive a deadline the mechanical path would have
 * kept (matrix 23).
 */
const shortestWindow = (drafts: readonly QuestionDraft[]): number =>
  Math.min(...drafts.map((draft) => draft.default_window_ms));

/** Run the Q1 gate, turning its refusal into a reported one for these questions only. */
const gate = (
  draft: unknown,
  raised: readonly RaisedQuestion[],
): { readonly draft: QuestionDraft } | { readonly refused: RefusedQuestion } => {
  try {
    return { draft: assertAskableDraft(draft) };
  } catch (error) {
    if (!(error instanceof QuestionDraftRefused)) throw error;
    return { refused: { raised, field: error.field, reason: error.message } };
  }
};

/**
 * The brief a card standing for several questions carries.
 *
 * Q3 requires a card answerable without reloading the feature into a person's head, and a card that
 * silently answers a second subagent's question fails that: the person would not know their answer
 * settles two things. So the brief keeps every distinct brief, names every distinct prompt that is not
 * the card's own, and ends with the reason for the merge — which is also what makes the reason durable.
 */
const mergedBrief = (
  drafts: readonly QuestionDraft[],
  standsFor: number,
  prompt: string,
  reason: string,
): string => {
  const briefs = distinct(drafts.map((draft) => draft.brief.trim()).filter((brief) => brief !== ''));
  const otherPrompts = distinct(drafts.map((draft) => draft.prompt)).filter((other) => other !== prompt);
  const also =
    otherPrompts.length === 0
      ? ''
      : `\n\nAlso asked as: ${otherPrompts.map((other) => `"${other}"`).join('; ')}.`;
  return `${briefs.join('\n\n')}${also}\n\n${STANDS_FOR_PREFIX}${String(standsFor)}${STANDS_FOR_SUFFIX}${reason}`;
};

/** The two fixed halves of the sentence that ends a merged card's brief, spelled once for writer and reader. */
const STANDS_FOR_PREFIX = 'This one question stands for ';
const STANDS_FOR_SUFFIX = ' raised questions: ';

/**
 * How many raised questions a card's brief says it stands for — `1` for a card that says nothing.
 *
 * The deflection rate reads the `raised_question_count` payload field first; this is its fallback for a
 * `question.asked` line written before that field existed, and the sentence itself stays in the brief as
 * the human-readable restatement of the merge. Only the brief's **final paragraph** is read, and only
 * when it opens with the sentence {@link mergedBrief} writes, so a subagent's own brief quoting the words
 * elsewhere is not mistaken for a merge. A count that is not a whole number above one is read as `1`.
 */
export const raisedQuestionsStatedIn = (brief: string): number => {
  const last = brief.split('\n\n').at(-1) ?? '';
  if (!last.startsWith(STANDS_FOR_PREFIX)) return 1;
  const count = Number.parseInt(last.slice(STANDS_FOR_PREFIX.length), 10);
  const rest = last.slice(STANDS_FOR_PREFIX.length + String(count).length);
  return Number.isSafeInteger(count) && count > 1 && rest.startsWith(STANDS_FOR_SUFFIX) ? count : 1;
};

type Combined =
  | { readonly kind: 'merged'; readonly question: MergedQuestion }
  | { readonly kind: 'awaiting'; readonly group: AwaitingJudgment }
  | { readonly kind: 'refused'; readonly refusal: RefusedQuestion };

/**
 * Combine a same-anchor group, or say what combining it would have had to decide.
 *
 * Combined only when nothing is lost, checked against **every** asker rather than the first (matrix 22):
 * every asker recommends the same option, states the same default action and offers the same escape; no
 * option id means two different things; no asker's escape is another's concrete option; and the union
 * fits Q1's three. The window is the *shortest* any asker declared, because lengthening a window by
 * merging would be a question that outlived the deadline one of its askers set.
 */
const combine = (anchor: QuestionAnchor, raised: readonly RaisedQuestion[]): Combined => {
  const [first] = raised;
  if (first === undefined) throw new Error('A merge group always holds at least one raised question.');
  const base = first.draft;
  const named = formatAnchor(anchor);
  const awaiting = (reason: string): Combined => ({ kind: 'awaiting', group: { anchor, raised, reason } });

  // Every part is gated before the whole is, because a merge can *hide* a failure: two drafts with no
  // brief combine into a card whose brief is only the merge note, which is non-blank and answers nothing.
  for (const question of raised) {
    const part = gate(question.draft, raised);
    if ('refused' in part) return { kind: 'refused', refusal: part.refused };
  }

  const recommended = distinct(raised.map((question) => question.draft.recommended_option_id));
  if (recommended.length > 1) {
    return awaiting(
      `the questions about "${named}" recommend different defaults (${recommended.join(', ')}), and ` +
        'choosing one is a judgement CAP-4 would otherwise make silently when the window expires',
    );
  }
  if (distinct(raised.map((question) => question.draft.default_action)).length > 1) {
    return awaiting(
      `the questions about "${named}" state different default actions, and choosing whose consequence of ` +
        'silence the card promises is a judgement',
    );
  }
  if (raised.some((question) => !sameEscape(question.draft.escape, base.escape))) {
    return awaiting(`the questions about "${named}" offer different escapes, and choosing one is a judgement`);
  }

  const options = new Map<string, QuestionOption>();
  for (const question of raised) {
    for (const option of question.draft.options) {
      const known = options.get(option.id);
      if (known !== undefined && !sameOption(known, option)) {
        return awaiting(
          `option "${option.id}" means different things in two of the questions about "${named}"`,
        );
      }
      options.set(option.id, option);
    }
  }
  if (options.size > MAX_CONCRETE_OPTIONS) {
    return awaiting(
      `the questions about "${named}" offer ${String(options.size)} distinct options between them, and ` +
        `Q1 allows ${String(MAX_CONCRETE_OPTIONS)}; choosing which to drop is a judgement`,
    );
  }
  // Every asker's escape, not only the first's: an escape that is a concrete option elsewhere would put
  // one id on the card twice, meaning "decide" and "do not decide" at once.
  const clash = raised.find((question) => options.has(question.draft.escape.id));
  if (clash !== undefined) {
    return awaiting(
      `the escape "${clash.draft.escape.id}" is a concrete option in another question about "${named}"`,
    );
  }

  const reason = `they share the anchor "${named}"`;
  const drafts = raised.map((question) => question.draft);
  const gated = gate(
    {
      ...base,
      options: [...options.values()],
      brief: mergedBrief(drafts, raised.length, base.prompt, reason),
      default_window_ms: shortestWindow(drafts),
    },
    raised,
  );
  if ('refused' in gated) return { kind: 'refused', refusal: gated.refused };
  return { kind: 'merged', question: { draft: gated.draft, anchors: [anchor], raised, basis: 'anchor', reason } };
};

/**
 * Group raised questions by anchor equality and compose one card per group.
 *
 * A question whose anchor is not usable — blank, padded, a line number — is never grouped: two questions
 * with no anchor have not been shown to be about the same thing, they have merely both failed to say what
 * they are about. A single question passes through with its draft unchanged, and is still put through
 * `assertAskableDraft`, so every card returned has passed the same gate whatever path it took.
 */
export const mergeByAnchor = (raised: readonly RaisedQuestion[]): MergeOutcome => {
  const groups: RaisedQuestion[][] = [];
  const byAnchor = new Map<string, RaisedQuestion[]>();
  for (const question of raised) {
    if (!isUsableAnchor(question.anchor)) {
      groups.push([question]);
      continue;
    }
    const key = anchorKey(question.anchor);
    const existing = byAnchor.get(key);
    if (existing !== undefined) {
      existing.push(question);
      continue;
    }
    const group = [question];
    byAnchor.set(key, group);
    groups.push(group);
  }

  const questions: MergedQuestion[] = [];
  const awaitingJudgment: AwaitingJudgment[] = [];
  const refused: RefusedQuestion[] = [];
  for (const group of groups) {
    const [only, second] = group;
    if (only === undefined) continue;
    if (second === undefined) {
      const gated = gate(only.draft, group);
      if ('refused' in gated) {
        refused.push(gated.refused);
        continue;
      }
      questions.push({
        draft: gated.draft,
        anchors: distinctAnchors(group),
        raised: group,
        basis: 'single',
        reason: 'no other raised question shares its anchor',
      });
      continue;
    }
    const combined = combine(only.anchor, group);
    if (combined.kind === 'merged') questions.push(combined.question);
    else if (combined.kind === 'awaiting') awaitingJudgment.push(combined.group);
    else refused.push(combined.refusal);
  }
  return { questions, awaitingJudgment, refused };
};

/** The live turn's decision that several questions are one, in its own words and with its own card. */
export interface MergeJudgment {
  /** Why these are the same question. Required: a merge nobody can explain is not recorded as one. */
  readonly reason: string;
  /** The card the turn composed to stand for them — held to Q1 exactly as any other card is. */
  readonly draft: QuestionDraft;
}

/** A judgement that cannot be recorded as the reason for a merge. */
export class MergeJudgmentRefused extends Error {
  readonly code = 'question.unanswerable';

  constructor(detail: string) {
    super(`Refusing to merge on judgement: ${detail}.`);
    this.name = 'MergeJudgmentRefused';
  }
}

/**
 * Merge questions the anchors did not, on the live turn's judgement (matrix 16).
 *
 * The judgement is the reason and is recorded as the reason — in {@link MergedQuestion.reason} and in the
 * card's brief, which the `question.asked` line carries — so a later reader of the log can see that a
 * person was asked once *because the Interviewer judged two questions the same*, not merely that one
 * question was asked. The card is the turn's own composition, and `assertAskableDraft` still decides
 * whether it may be asked: a judgement can merge questions, it cannot waive Q1. Nor can it lengthen a
 * deadline: the window is the shortest among the judged card and every draft it replaces (matrix 23).
 *
 * This one throws rather than reporting, unlike {@link mergeByAnchor}: the call is about exactly one group
 * the turn chose, so a refusal loses nothing else, and the turn is owed the reason at the call it made.
 */
export const mergeOnJudgment = (
  raised: readonly RaisedQuestion[],
  judgment: MergeJudgment,
): MergedQuestion => {
  if (raised.length < 2) {
    throw new MergeJudgmentRefused('a merge needs at least two raised questions to stand for');
  }
  const reason = judgment.reason.trim();
  if (reason === '') {
    throw new MergeJudgmentRefused('the judgement states no reason, so the merge would be left implicit');
  }
  // The turn's own card leads, and the raised briefs follow it, so nothing an asker said is lost.
  const drafts = [judgment.draft, ...raised.map((question) => question.draft)];
  const draft = assertAskableDraft({
    ...judgment.draft,
    brief: mergedBrief(drafts, raised.length, judgment.draft.prompt, `the Interviewer judged them the same question — ${reason}`),
    default_window_ms: shortestWindow(drafts),
  });
  return {
    draft,
    anchors: distinctAnchors(raised),
    raised,
    basis: 'judgment',
    reason,
  };
};
