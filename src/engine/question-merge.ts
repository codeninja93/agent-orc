/**
 * CAP-3 — question compression: questions that are the same question become one before any is asked.
 *
 * Two subagents working one feature routinely hit the same undecided point from two sides, and asking
 * a person twice is the cost the Interviewer exists to remove (glossary: "at most one reaches the
 * user"). This module decides which raised questions are the same question and composes the one card
 * that stands for them.
 *
 * **"The same question" is the same anchor, compared for equality.** Two drafts declaring
 * `resolveProject` are about one symbol; two drafts whose prose reads alike but which declare
 * `resolveProject` and `resolveProjectPath` are about two, and are asked as two. Prose similarity is
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
 * gate: a same-anchor group whose union would exceed three options, or whose askers recommend different
 * defaults, is not combined mechanically at all. It is handed back as awaiting a judgement, because
 * dropping an option or picking one asker's default over another's *is* a judgement.
 *
 * **The reason a question was merged is recorded where the log will keep it.** A merged card's brief
 * states that it stands for several questions and why. The brief travels in the `question.asked` payload
 * (story 1-11), so the merge is reconstructable from `events.jsonl` alone (AD-4) without a new event type.
 */
import type { QuestionDraft, QuestionOption } from '../contracts/index.js';

import { isUsableAnchor } from './deflection.js';
import { assertAskableDraft } from './questions.js';

/**
 * A question as a subagent raised it: its draft, and the anchor it is about.
 *
 * The anchor is carried beside the draft rather than inside it because `QuestionDraftSchema` has no
 * anchor field and a step's `questions` array is typed by that schema; the Interviewer supplies it when a
 * step did not.
 */
export interface RaisedQuestion {
  readonly draft: QuestionDraft;
  /** A durable anchor — a test name, API symbol or module name. Never a line number. */
  readonly anchor: string;
  /** The step that raised it, or `null` for a run-level question. */
  readonly step: string | null;
}

/** Why a card stands for the questions it stands for. */
export type MergeBasis = 'single' | 'anchor' | 'judgment';

/** One card to ask: a draft `assertAskableDraft` has accepted, and the questions it answers. */
export interface MergedQuestion {
  readonly draft: QuestionDraft;
  /** Every distinct anchor the card answers, in first-raised order. */
  readonly anchors: readonly string[];
  /** The raised questions this card stands for, in raised order. */
  readonly raised: readonly RaisedQuestion[];
  readonly basis: MergeBasis;
  /** R3 — why these questions are this card; for a judgement, the judgement's own words. */
  readonly reason: string;
}

/** A same-anchor group mechanics could not combine without deciding something, awaiting the live turn. */
export interface AwaitingJudgment {
  readonly anchor: string;
  readonly raised: readonly RaisedQuestion[];
  /** What a mechanical merge would have had to decide. */
  readonly reason: string;
}

export interface MergeOutcome {
  /** Cards ready to ask, in the order their first question was raised. */
  readonly questions: readonly MergedQuestion[];
  readonly awaitingJudgment: readonly AwaitingJudgment[];
}

/** Q1's ceiling on concrete options, which a merged card is held to as firmly as a raised one. */
const MAX_CONCRETE_OPTIONS = 3;

const sameOption = (a: QuestionOption, b: QuestionOption): boolean =>
  a.label === b.label && a.consequence === b.consequence;

const distinct = (values: readonly string[]): readonly string[] => [...new Set(values)];

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
  return (
    `${briefs.join('\n\n')}${also}\n\n` +
    `This one question stands for ${String(standsFor)} raised questions: ${reason}`
  );
};

/**
 * Combine a same-anchor group, or say what combining it would have had to decide.
 *
 * Combined only when nothing is lost: every asker recommends the same option, no option id means two
 * different things, and the union fits Q1's three. The window is the *shortest* any asker declared,
 * because CAP-4's default must not arrive later than any subagent was promised it would — lengthening a
 * window by merging would be a question that outlived the deadline one of its askers set.
 */
const combine = (anchor: string, raised: readonly RaisedQuestion[]): MergedQuestion | AwaitingJudgment => {
  const [first] = raised;
  if (first === undefined) throw new Error('A merge group always holds at least one raised question.');
  const base = first.draft;
  const awaiting = (reason: string): AwaitingJudgment => ({ anchor, raised, reason });

  const recommended = distinct(raised.map((question) => question.draft.recommended_option_id));
  if (recommended.length > 1) {
    return awaiting(
      `the questions about "${anchor}" recommend different defaults (${recommended.join(', ')}), and ` +
        'choosing one is a judgement CAP-4 would otherwise make silently when the window expires',
    );
  }

  const options = new Map<string, QuestionOption>();
  for (const question of raised) {
    for (const option of question.draft.options) {
      const known = options.get(option.id);
      if (known !== undefined && !sameOption(known, option)) {
        return awaiting(
          `option "${option.id}" means different things in two of the questions about "${anchor}"`,
        );
      }
      options.set(option.id, option);
    }
  }
  if (options.size > MAX_CONCRETE_OPTIONS) {
    return awaiting(
      `the questions about "${anchor}" offer ${String(options.size)} distinct options between them, and ` +
        `Q1 allows ${String(MAX_CONCRETE_OPTIONS)}; choosing which to drop is a judgement`,
    );
  }
  if (options.has(base.escape.id)) {
    return awaiting(
      `the escape "${base.escape.id}" is a concrete option in another question about "${anchor}"`,
    );
  }

  const reason = `they share the anchor "${anchor}"`;
  const draft = assertAskableDraft({
    ...base,
    options: [...options.values()],
    brief: mergedBrief(
      raised.map((question) => question.draft),
      raised.length,
      base.prompt,
      reason,
    ),
    default_window_ms: Math.min(...raised.map((question) => question.draft.default_window_ms)),
  });
  return { draft, anchors: [anchor], raised, basis: 'anchor', reason };
};

const isAwaiting = (value: MergedQuestion | AwaitingJudgment): value is AwaitingJudgment =>
  !('draft' in value);

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
    const existing = byAnchor.get(question.anchor);
    if (existing !== undefined) {
      existing.push(question);
      continue;
    }
    const group = [question];
    byAnchor.set(question.anchor, group);
    groups.push(group);
  }

  const questions: MergedQuestion[] = [];
  const awaitingJudgment: AwaitingJudgment[] = [];
  for (const group of groups) {
    const [only, second] = group;
    if (only === undefined) continue;
    if (second === undefined) {
      questions.push({
        draft: assertAskableDraft(only.draft),
        anchors: isUsableAnchor(only.anchor) ? [only.anchor] : [],
        raised: group,
        basis: 'single',
        reason: 'no other raised question shares its anchor',
      });
      continue;
    }
    const combined = combine(only.anchor, group);
    if (isAwaiting(combined)) awaitingJudgment.push(combined);
    else questions.push(combined);
  }
  return { questions, awaitingJudgment };
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
 * whether it may be asked: a judgement can merge questions, it cannot waive Q1.
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
  const draft = assertAskableDraft({
    ...judgment.draft,
    // The turn's own card leads, and the raised briefs follow it, so nothing an asker said is lost.
    brief: mergedBrief(
      [judgment.draft, ...raised.map((question) => question.draft)],
      raised.length,
      judgment.draft.prompt,
      `the Interviewer judged them the same question — ${reason}`,
    ),
  });
  return {
    draft,
    anchors: distinct(raised.map((question) => question.anchor).filter(isUsableAnchor)),
    raised,
    basis: 'judgment',
    reason,
  };
};
