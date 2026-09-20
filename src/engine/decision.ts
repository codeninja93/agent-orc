/**
 * AD-25 — the record a resolved question leaves behind.
 *
 * **Only a resolved question writes one.** A deflected question emits `question.deflected` and records
 * nothing at all, because nobody was asked: attributing a decision to a person who never saw the question
 * would put a human's name against an answer the repository gave. That asymmetry is the rule, not an
 * optimisation, and it is why this module answers `null` for a deflection rather than recording a
 * decision with an empty principal.
 *
 * **The record is an event.** AD-4 makes the log the only durable truth, so a decision ledger kept
 * anywhere else would be a second authority for the one fact a later run reads back to avoid asking the
 * same question twice (Q7). Story 5-3 builds the queryable index *over* these lines; this story emits the
 * lines that constitute the record. So there is no table, no index and no retrieval here — deliberately,
 * because a queryable store written beside the log is the divergence AD-4 forbids.
 *
 * **Every value is short and punctuated.** The payload is subject to AD-21's pass like any other, and the
 * one field a reader keys on — the question id — is punctuated by `mintQuestionId` for exactly that
 * reason. A rejection's reason travels here as prose, which the pass leaves alone, and it is never
 * discarded: "rejection is one keystroke plus a reason, and the reason becomes a ledger entry" is a line
 * of the interface contract, so the reason *is* the decision when a rejection is what resolved the
 * question.
 */
import type { EventEnvelope, QuestionState } from '../contracts/index.js';

import { QUESTION_ID_PAYLOAD_KEY } from './questions.js';

/**
 * The event type a decision is recorded as.
 *
 * Not one of the four AD-25 names, and separate from them on purpose: `question.resolved` says a
 * transition happened, and this says a decision was recorded. Keeping them apart is what makes "only a
 * resolved question writes to the decision ledger" observable — a deflection emits the first kind of line
 * and never the second, which a reader can check rather than infer. AD-5 makes adding a type safe: a
 * reader that does not know it ignores it.
 */
export const DECISION_EVENT_TYPE = 'decision.recorded';

/** What one decision records. Flat, prose-and-enum, and readable back out of the log unchanged. */
export interface DecisionRecord {
  /** The question this decision answers, punctuated so the AD-21 pass leaves it alone. */
  readonly questionId: string;
  readonly feature: string;
  /** The step that raised the question, or `null` for a run-level one. */
  readonly step: string | null;
  /** The question as it was put, so the decision is legible without reopening the question file. */
  readonly question: string;
  /** Free text; the system parses (Q6). For a rejection this is the reason, which is never discarded. */
  readonly answer: string;
  /** The option the answer selected, when it selected one. */
  readonly optionId: string | null;
  /** Which of AD-25's three resolvers won the compare-and-set. */
  readonly resolver: string;
  /** AD-19 — who the decision is attributable to; `timeout` when the window took the default. */
  readonly principalKind: string;
  readonly principalId: string;
  readonly resolvedAt: string;
}

/**
 * The decision a question leaves, or `null` when it leaves none.
 *
 * `null` for anything but a resolved question. The check is the status rather than the presence of a
 * resolution, so it reads as the rule AD-25 states; the contract's own refinement already makes the two
 * agree, and story 1-1's `writesToDecisionLedger` answers the same question for a caller that only needs
 * the boolean.
 */
export const decisionFor = (state: QuestionState): DecisionRecord | null => {
  if (state.status !== 'resolved' || state.resolution === null) return null;
  const resolution = state.resolution;
  return {
    questionId: state.question.id,
    feature: state.question.feature,
    step: state.question.step,
    question: state.question.prompt,
    answer: resolution.answer,
    optionId: resolution.option_id,
    resolver: resolution.resolver,
    principalKind: resolution.principal.kind,
    principalId: resolution.principal.id,
    resolvedAt: resolution.resolved_at,
  };
};

/** The payload of a `decision.recorded` line. */
export const decisionPayload = (record: DecisionRecord): Record<string, unknown> => ({
  [QUESTION_ID_PAYLOAD_KEY]: record.questionId,
  question: record.question,
  answer: record.answer,
  option_id: record.optionId,
  resolver: record.resolver,
  principal_kind: record.principalKind,
  principal_id: record.principalId,
  resolved_at: record.resolvedAt,
});

/**
 * The question ids the log already carries a decision for.
 *
 * The idempotence key, and the reason the question id has to survive the payload: appending a decision is
 * the last step of a transition, so a crash before it leaves a resolved question with no decision — and
 * the only way a later pass can tell that apart from a decision already recorded is to read this back.
 */
export const decidedQuestionIds = (events: readonly EventEnvelope[]): ReadonlySet<string> => {
  const ids = new Set<string>();
  for (const event of events) {
    if (event.type !== DECISION_EVENT_TYPE) continue;
    const id = event.payload[QUESTION_ID_PAYLOAD_KEY];
    if (typeof id === 'string' && id !== '') ids.add(id);
  }
  return ids;
};

/** Every decision the log records, in the order it recorded them. What story 5-3 will index. */
export const decisionsInLog = (events: readonly EventEnvelope[]): readonly Record<string, unknown>[] =>
  events.filter((event) => event.type === DECISION_EVENT_TYPE).map((event) => event.payload);
