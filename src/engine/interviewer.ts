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
import type { AwaitingJudgment, MergedQuestion, RaisedQuestion } from './question-merge.js';
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

/** A list marker opening a line — `-`, `*`, `•`, `1.` or `1)` — which is layout, not wording. */
const LIST_MARKER = /^\s*(?:[-*•]|\d+[.)])\s+/;

/**
 * The criteria a request states in its own words, one per line or list item.
 *
 * The fallback when the live turn has drafted none, and deliberately literal: it splits on the structure
 * a person already gave — lines and list items — and never on sentences, because deciding where one
 * requirement ends and the next begins inside a sentence is interpretation, and an echo that invented
 * criteria would be a contract the person did not write. A one-line request is echoed as one criterion.
 */
const criteriaStatedIn = (request: string): readonly string[] =>
  request
    .split('\n')
    .map((line) => line.replace(LIST_MARKER, '').trim())
    .filter((line) => line !== '');

/**
 * Compose the spec echo (matrix 1).
 *
 * `drafted` is the live turn's candidate list, when it wrote one — restating a request as testable
 * criteria is the part that needs a model, and the Interviewer is one. Each candidate is trimmed and a
 * blank one dropped, because a blank line is not a criterion anybody can confirm. The request is carried
 * through untouched either way, so the echo always shows a person their own words beside what was heard.
 */
export const composeSpecEcho = (request: string, drafted?: readonly string[]): SpecEcho => ({
  request,
  criteria: (drafted ?? criteriaStatedIn(request))
    .map((criterion) => criterion.trim())
    .filter((criterion) => criterion !== ''),
});

/** How a person answered the echo: confirmed it as it stands, or amended one or more of its lines. */
export type SpecEchoResponse =
  | { readonly kind: 'confirm' }
  /** Each amendment is free text (Q6), read by the engine's own `edit_criterion` parser. */
  | { readonly kind: 'amend'; readonly amendments: readonly string[] };

/** An echo a person confirmed: the request, the criteria, and every edit that produced them. */
export interface ConfirmedSpec {
  readonly accepted: true;
  readonly request: string;
  readonly acceptance_criteria: readonly string[];
  /** Each amendment in `spec.criterion_edited`'s own shape, so every changed line is attributable. */
  readonly edits: readonly SpecCriterionEditedPayload[];
}

/** An answer that could not become a confirmed spec, and the sentence saying why. */
export interface RefusedSpec {
  readonly accepted: false;
  readonly refusal: string;
}

export type SpecConfirmation = ConfirmedSpec | RefusedSpec;

/**
 * Turn a person's answer to the echo into the criteria a plan is built with (matrix 2–4).
 *
 * **An amendment is parsed by `criterionEditedPayload`, the reconciler's own reader of an
 * `edit_criterion` intent** — the same function, not a second grammar — so "3: reword" means line 3 here
 * exactly as it does when the same words arrive through the TUI card. Only the named line changes.
 *
 * Two answers are refused rather than guessed at, and both are told, not thrown at. An amendment that
 * names no line, or a line the echo does not have, cannot be placed: attaching it to a line of this
 * module's choosing would put words in a criterion the person did not point at. And a confirmation of an
 * empty list is refused because nobody confirmed a spec — they confirmed the absence of one, and a run
 * accepted against no criteria has nothing its verification can be held to.
 */
export const confirmSpecEcho = (echo: SpecEcho, response: SpecEchoResponse): SpecConfirmation => {
  const criteria = [...echo.criteria];
  const edits: SpecCriterionEditedPayload[] = [];
  if (response.kind === 'amend') {
    for (const amendment of response.amendments) {
      const edit = SpecCriterionEditedPayloadSchema.parse(criterionEditedPayload(amendment));
      const line = edit[DECLARATION_PAYLOAD_KEYS.CriterionLine];
      if (line === null || line > criteria.length) {
        return {
          accepted: false,
          refusal:
            line === null
              ? `The amendment "${amendment}" does not say which criterion it changes; give the number ` +
                'first, as in "2: …".'
              : `The amendment names criterion ${String(line)}, and the echo has ${String(criteria.length)}.`,
        };
      }
      criteria[line - 1] = edit[DECLARATION_PAYLOAD_KEYS.CriterionText];
      edits.push(edit);
    }
  }
  if (criteria.length === 0) {
    return {
      accepted: false,
      refusal:
        'There are no acceptance criteria to confirm. An empty list is not a spec anyone confirmed, so ' +
        'the feature is not accepted until at least one criterion is stated.',
    };
  }
  return { accepted: true, request: echo.request, acceptance_criteria: criteria, edits };
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
 * the deflection rate's denominator. The cards in `toAsk` are asked; nothing else reaches a person.
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
  return { deflected, unanswered, toAsk: merged.questions, awaitingJudgment: merged.awaitingJudgment };
};
