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
 * reason. A rejection's reason travels here as prose, which the pass leaves alone in the ordinary case,
 * and it is never discarded: "rejection is one keystroke plus a reason, and the reason becomes a ledger
 * entry" is a line of the interface contract, so the reason *is* the decision when a rejection is what
 * resolved the question.
 *
 * **Where that claim needed qualifying.** Q6 imposes no format on a human, so a reason may contain an
 * unbroken high-entropy run — a SHA, a token, a long path — and AD-21 rewrites one wherever it appears in
 * a payload. The verbatim reason survives in `questions/<id>/state.json`, which is why the decision is not
 * lost; what used to be lost was any *record* that the two disagreed. The payload now names the fields the
 * pass rewrote, so the ledger says so rather than presenting a marker as the words a person wrote. The
 * remedy is never a wider allow-list: AD-21 is a write-path invariant with no after-the-fact remedy.
 */
import { DECISION_RECORDED_EVENT_TYPE } from '../contracts/index.js';
import type { EventEnvelope, QuestionState } from '../contracts/index.js';
import type { RedactionPolicy } from '../runtime/index.js';

import { QUESTION_ID_PAYLOAD_KEY, notingRedactedFields } from './questions.js';

/**
 * The event type a decision is recorded as.
 *
 * Not one of the four AD-25 names, and separate from them on purpose: `question.resolved` says a
 * transition happened, and this says a decision was recorded. Keeping them apart is what makes "only a
 * resolved question writes to the decision ledger" observable — a deflection emits the first kind of line
 * and never the second, which a reader can check rather than infer.
 *
 * **Declared in `src/contracts/event.ts`, and pointed at here** (ADR-002 decision 4). AD-5's open
 * vocabulary makes an undeclared type legal to *read*, which is not a reason for this project's own writer
 * to emit one — and `isDeclaredEventType('decision.recorded')` answered `false` while the type was spelled
 * only in this module. One spelling, in the contract, so the ledger AD-25 requires is declarable.
 */
export const DECISION_EVENT_TYPE = DECISION_RECORDED_EVENT_TYPE;

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

/**
 * The payload of a `decision.recorded` line.
 *
 * Eight fields, and story 5-3 indexes every one of them, which is why none is decorative: `option_id` is
 * what a later run reads back to avoid asking the same question twice (Q7), `resolved_at` is what orders
 * two decisions about one area, and the question text is what makes the entry legible without reopening a
 * question file that a consolidation pass may have swept.
 *
 * `policy` is the active AD-21 policy, so the line can name the free-text fields the pass is about to
 * rewrite in it. See {@link REDACTED_FIELDS_PAYLOAD_KEY}: without it, a rejection whose reason contained a
 * SHA reached the log as `[redacted]` while the question's state file kept the reason verbatim, and this
 * module's claim that the reason is never discarded was true of `questions/` and quietly false of the
 * ledger.
 */
export const decisionPayload = (
  record: DecisionRecord,
  policy: RedactionPolicy = {},
): Record<string, unknown> =>
  notingRedactedFields(
    {
      [QUESTION_ID_PAYLOAD_KEY]: record.questionId,
      question: record.question,
      answer: record.answer,
      option_id: record.optionId,
      resolver: record.resolver,
      principal_kind: record.principalKind,
      principal_id: record.principalId,
      resolved_at: record.resolvedAt,
    },
    [
      ['answer', record.answer],
      ['question', record.question],
    ],
    policy,
  );

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
