/**
 * The Interviewer's two decisions, as the logic a live turn calls into (CAP-1, CAP-2, CAP-3).
 *
 * architecture.md splits the original orchestrator into **Interviewer (conversation) + Engine
 * (scheduler)**, and names the Interviewer as the only component required to be a live model
 * conversation. That split is why this module exists in the shape it does. The conversation — a
 * multi-turn exchange a person answers in a terminal (Q5) — is the live turn's; the decisions it
 * reaches are made here, in code, where they are reproducible and testable:
 *
 * - **spec echo** — a raw request becomes a numbered list of candidate acceptance criteria carried
 *   beside the request verbatim, and a person's confirmation or amendment becomes the exact array a
 *   `FeaturePlan` is built with. "The echo is the contract" (glossary), so what a person confirmed and
 *   what the plan says are the same list by construction.
 * - **question compression** — each raised question is attempted against the repository, its history and
 *   the decision ledger (Q4); what deflects becomes a constructed deflection, and what does not is merged
 *   by anchor into as few cards as Q1 allows.
 *
 * **What this module is not: the terminal loop.** It spawns no `claude -p`, reads no keystroke and
 * holds no conversation. Driving a live interactive session is a different invocation shape from every
 * one-shot step agent in the system and is not something an automated suite can exercise honestly.
 *
 * **It does not accept the plan either.** `acceptFeature` records `spec.recorded` from a plan's
 * `acceptance_criteria`, and a later `spec.recorded` replaces the criteria wholesale; both are built and
 * this module leaves them alone. Its output is the argument, not the acceptance.
 */
import { DECLARATION_PAYLOAD_KEYS, SpecCriterionEditedPayloadSchema } from '../contracts/index.js';
import type { QuestionDeflection, SpecCriterionEditedPayload } from '../contracts/index.js';

import { attemptDeflection, constructDeflection } from './deflection.js';
import type { DeflectionAttempt, DeflectionContext } from './deflection.js';
import { mergeByAnchor } from './question-merge.js';
import type { AwaitingJudgment, MergedQuestion, RaisedQuestion, RefusedQuestion } from './question-merge.js';
import type { FeaturePlan } from './rebuild.js';
import { criterionEditedPayload } from './reconciler.js';

// -------------------------------------------------------------------------------------------------
// CAP-2 — spec echo
// -------------------------------------------------------------------------------------------------

/** What the Interviewer reads back: the request as the person wrote it, and the criteria it heard. */
export interface SpecEcho {
  /** The user's original words, verbatim — never trimmed, since `spec.recorded` carries them as written. */
  readonly request: string;
  /** Candidate criteria, in the order they will be numbered; 1-based as the spec-echo card numbers them. */
  readonly criteria: readonly string[];
}

/**
 * A list marker opening a line — `-`, `*`, `•`, or a one- or two-digit `1.` / `1)` — which is layout.
 *
 * At most two digits, because a line that opens with a year (`2026. The flag ships`) is prose, and
 * stripping its "marker" would delete the year from what the person wrote.
 */
const LIST_MARKER = /^\s*(?:[-*•]|\d{1,2}[.)])\s+/;

/**
 * The criteria a request states in its own words.
 *
 * The fallback when the live turn has drafted none, and deliberately literal: it follows the structure a
 * person already gave and never splits a sentence, because deciding where one requirement ends and the
 * next begins inside prose is interpretation, and an echo that invented criteria would be a contract the
 * person did not write. Two shapes are read:
 *
 * - **A request with a list** states its criteria as the list items. A line that wraps under an item
 *   continues it rather than starting another, and prose before the list — a title, a lead-in — is not a
 *   criterion; it stays in the request, which the echo always shows verbatim beside the criteria.
 * - **A request without a list** states one criterion per paragraph, its wrapped lines joined, so a
 *   sentence broken across two lines is still one sentence.
 */
const criteriaStatedIn = (request: string): readonly string[] => {
  const lines = request.split(/\r?\n/);
  const hasList = lines.some((line) => LIST_MARKER.test(line));
  const criteria: string[] = [];
  let current: string[] | null = null;
  const close = (): void => {
    if (current !== null && current.length > 0) criteria.push(current.join(' '));
    current = null;
  };
  for (const line of lines) {
    const text = line.trim();
    if (text === '') {
      close();
      continue;
    }
    if (hasList && LIST_MARKER.test(line)) {
      close();
      current = [line.replace(LIST_MARKER, '').trim()];
      continue;
    }
    // Under a list, a non-item line only continues an item already open; with no list, it opens one.
    if (current === null && hasList) continue;
    current ??= [];
    current.push(text);
  }
  close();
  return criteria;
};

/**
 * Compose the spec echo (matrix 1).
 *
 * `drafted` is the live turn's candidate list, when it wrote one — restating a request as testable
 * criteria is the part that needs a model, and the Interviewer is one. Each candidate is trimmed and a
 * blank one dropped, because a blank line is not a criterion anybody can confirm. A drafted list with
 * nothing in it — `[]`, or only blanks — is no draft at all, and the request's own criteria are used,
 * rather than an empty turn silently discarding what the person stated. The request is carried through
 * untouched either way, so the echo always shows a person their own words beside what was heard.
 */
export const composeSpecEcho = (request: string, drafted?: readonly string[]): SpecEcho => {
  const fromTurn = (drafted ?? []).map((criterion) => criterion.trim()).filter((criterion) => criterion !== '');
  return { request, criteria: fromTurn.length > 0 ? fromTurn : criteriaStatedIn(request) };
};

/**
 * How a person answered the echo: confirmed it as it stands, or changed it.
 *
 * A change can reword a line, remove one, or add one (matrix 26) — rewording alone left an echo with a
 * wrong line nobody could drop, and an empty echo with no way ever to gain a criterion. Every line number
 * refers to the echo *as shown*, so a person does not have to renumber in their head; additions follow
 * the surviving lines in the order given.
 */
export type SpecEchoResponse =
  | { readonly kind: 'confirm' }
  | {
      readonly kind: 'amend';
      /** Free-text rewordings (Q6), each read by the engine's own `edit_criterion` parser. */
      readonly amendments?: readonly string[];
      /** 1-based lines of the echo as shown, to drop. */
      readonly removals?: readonly number[];
      /** New criteria in the person's words, appended after the surviving lines. */
      readonly additions?: readonly string[];
    };

/** An echo a person confirmed: the request, the criteria, and every change that produced them. */
export interface ConfirmedSpec {
  readonly accepted: true;
  readonly request: string;
  readonly acceptance_criteria: readonly string[];
  /** Each rewording in `spec.criterion_edited`'s own shape, so every changed line is attributable. */
  readonly edits: readonly SpecCriterionEditedPayload[];
  /** The echo's lines, 1-based as shown, that the person removed. */
  readonly removed: readonly number[];
  /** The criteria the person added, as they wrote them, trimmed. */
  readonly added: readonly string[];
}

/** An answer that could not become a confirmed spec, and the sentence saying why. */
export interface RefusedSpec {
  readonly accepted: false;
  readonly refusal: string;
}

export type SpecConfirmation = ConfirmedSpec | RefusedSpec;

const refuse = (refusal: string): RefusedSpec => ({ accepted: false, refusal });

/** The lines an amendment may name, stated in the words a refusal uses. */
const lineRange = (count: number): string =>
  count === 0 ? 'the echo has no criteria to change; state a new one as an addition' : `give a number from 1 to ${String(count)}`;

/**
 * Turn a person's answer to the echo into the criteria a plan is built with (matrix 2–4, 24–26).
 *
 * **A rewording is parsed by `criterionEditedPayload`, the reconciler's own reader of an
 * `edit_criterion` intent** — the same function, not a second grammar — so "3: reword" means line 3 here
 * exactly as it does when the same words arrive through the TUI card. Only the named line changes.
 *
 * Every refusal is returned, never thrown, and each names what is missing rather than guessing:
 *
 * - a line outside `1..n` — zero, negative, or past the end — or none at all cannot be placed, and
 *   attaching the words to a line of this module's choosing would put them in a criterion nobody pointed
 *   at (the parser reads `0:` and `-1:` as naming no line, so all three reach the same refusal);
 * - a line named with no wording (`"3:"`) is not a rewording, and recording `3:` as the criterion would
 *   make the addressing into the contract;
 * - one line reworded twice, or reworded and removed, is two instructions that cannot both stand, and
 *   silently keeping the later one would drop what the person said first;
 * - a blank addition is not a criterion;
 * - and a result with no criteria is refused because nobody confirmed a spec — they confirmed the absence
 *   of one, and a run accepted against no criteria has nothing its verification can be held to.
 */
export const confirmSpecEcho = (echo: SpecEcho, response: SpecEchoResponse): SpecConfirmation => {
  const shown = echo.criteria.length;
  const criteria: (string | null)[] = [...echo.criteria];
  const edits: SpecCriterionEditedPayload[] = [];
  const removed: number[] = [];
  const added: string[] = [];
  if (response.kind === 'amend') {
    const touched = new Set<number>();
    for (const amendment of response.amendments ?? []) {
      let parsed: ReturnType<typeof SpecCriterionEditedPayloadSchema.safeParse>;
      try {
        parsed = SpecCriterionEditedPayloadSchema.safeParse(criterionEditedPayload(amendment));
      } catch {
        return refuse(`The amendment "${amendment}" could not be read as a change to a criterion.`);
      }
      if (!parsed.success) return refuse(`The amendment "${amendment}" could not be read as a change to a criterion.`);
      const edit = parsed.data;
      const line = edit[DECLARATION_PAYLOAD_KEYS.CriterionLine];
      const text = edit[DECLARATION_PAYLOAD_KEYS.CriterionText];
      if (line === null || line > shown) {
        return refuse(
          `The amendment "${amendment}" does not name a criterion the echo has; ${lineRange(shown)}, as in "2: …".`,
        );
      }
      // The parser falls back to the whole argument as the wording when nothing follows the number, so
      // wording equal to the whole amendment on a placed line means the person gave none.
      if (text === amendment.trim()) {
        return refuse(`The amendment names criterion ${String(line)} but gives no wording for it.`);
      }
      if (touched.has(line)) {
        return refuse(`Criterion ${String(line)} is changed twice; say which wording stands.`);
      }
      touched.add(line);
      criteria[line - 1] = text;
      edits.push(edit);
    }
    for (const line of response.removals ?? []) {
      if (!Number.isSafeInteger(line) || line < 1 || line > shown) {
        return refuse(`Removal of criterion ${String(line)} does not name a criterion the echo has; ${lineRange(shown)}.`);
      }
      if (touched.has(line)) {
        return refuse(`Criterion ${String(line)} is changed twice; say which wording stands, or remove it alone.`);
      }
      touched.add(line);
      criteria[line - 1] = null;
      removed.push(line);
    }
    for (const addition of response.additions ?? []) {
      const text = addition.trim();
      if (text === '') return refuse('An added criterion has no wording; a blank line is not a criterion.');
      added.push(text);
    }
  }
  const accepted = [...criteria.filter((criterion): criterion is string => criterion !== null), ...added];
  if (accepted.length === 0) {
    return refuse(
      'There are no acceptance criteria to confirm. An empty list is not a spec anyone confirmed, so ' +
        'the feature is not accepted until at least one criterion is stated.',
    );
  }
  return { accepted: true, request: echo.request, acceptance_criteria: accepted, edits, removed, added };
};

/** The declared half of a plan that the spec echo does not decide. */
export type PlanWithoutSpec = Omit<FeaturePlan, 'request' | 'acceptance_criteria'>;

/**
 * The `FeaturePlan` a confirmed echo becomes — the argument `acceptFeature` takes, and nothing more.
 *
 * The confirmed list is copied rather than aliased, so the plan cannot change under a caller that goes
 * on holding the confirmation.
 */
export const planFromSpec = (plan: PlanWithoutSpec, spec: ConfirmedSpec): FeaturePlan => ({
  ...plan,
  request: spec.request,
  acceptance_criteria: [...spec.acceptance_criteria],
});

// -------------------------------------------------------------------------------------------------
// CAP-3 — question compression
// -------------------------------------------------------------------------------------------------

/** A raised question the sources answered, with the deflection to hand to the compare-and-set. */
export interface DeflectedQuestion {
  readonly raised: RaisedQuestion;
  readonly attempt: DeflectionAttempt;
  /** Built by `constructDeflection`; applied only through `applyDeflection`. */
  readonly deflection: QuestionDeflection;
}

/** What compression decided for one batch of raised questions. */
export interface CompressedQuestions {
  /** Answered without a person. Each is still asked durably first, then deflected — AD-25's order. */
  readonly deflected: readonly DeflectedQuestion[];
  /** Every attempt that found nothing, so a question passed through always says what was searched. */
  readonly unanswered: readonly DeflectionAttempt[];
  /** The cards to put to a person, each already accepted by `assertAskableDraft`. */
  readonly toAsk: readonly MergedQuestion[];
  /** Drafts or merged cards the Q1 gate refused, each reported alone; nothing else in the batch is lost. */
  readonly refused: readonly RefusedQuestion[];
  /** Same-anchor groups the live turn must merge on judgement before they can be asked. */
  readonly awaitingJudgment: readonly AwaitingJudgment[];
}

export interface CompressionOptions {
  /** The clock a deflection is stamped with, which is the instant it races the other resolvers at. */
  readonly now?: () => Date;
}

/**
 * The entry point a live turn calls with the questions its subagents raised.
 *
 * Deflection is attempted on every question before anything is merged, because deflection is per
 * question and merging is per card: two same-anchor questions that both deflect never become a card at
 * all. Only what no source answered goes on to `mergeByAnchor`.
 *
 * Nothing here writes. A deflected question is made durable by `askQuestion` and then handed to
 * `applyDeflection` — the lifecycle's own order, `asked` then `deflected`, which is also what puts it in
 * the deflection rate's denominator. The cards in `toAsk` are asked, each with `raisedQuestionCount` set to
 * its `raised.length` so the `question.asked` line states how many questions it replaced; nothing else
 * reaches a person.
 *
 * **`toAsk` is not capped here, and does not need to be.** Several cards may come out of one batch, and
 * each is asked as its own durable question — but a person still sees one at a time: R14 gives the active
 * question one persistent slot, and `activeQuestion` in `questions.ts` with the TUI projection serialise
 * pending questions through it oldest first. "At most one reaches the user" is that slot's guarantee;
 * compression's job is to make the queue behind it as short as the anchors allow.
 */
export const compressQuestions = (
  raised: readonly RaisedQuestion[],
  context: DeflectionContext,
  options: CompressionOptions = {},
): CompressedQuestions => {
  const now = options.now ?? ((): Date => new Date());
  const deflected: DeflectedQuestion[] = [];
  const unanswered: DeflectionAttempt[] = [];
  const passedThrough: RaisedQuestion[] = [];
  for (const question of raised) {
    const attempt = attemptDeflection(question.anchor, context);
    if (attempt.match === null) {
      unanswered.push(attempt);
      passedThrough.push(question);
      continue;
    }
    deflected.push({ raised: question, attempt, deflection: constructDeflection(attempt.match, now()) });
  }
  const merged = mergeByAnchor(passedThrough);
  return {
    deflected,
    unanswered,
    toAsk: merged.questions,
    awaitingJudgment: merged.awaitingJudgment,
    refused: merged.refused,
  };
};
