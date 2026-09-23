/**
 * Q4 — "Deflection rate is reported": the proportion of raised questions nobody had to be asked.
 *
 * **A fold over lines the log already carries, never a counter.** `question.asked` and
 * `question.deflected` are both durable AD-25 event types, emitted by the reconciler as it settles each
 * question. A counter maintained beside them would be a second authority for a fact AD-4 says the log
 * is the truth about, and it would need a write path of its own; this needs none. The idiom is
 * `rebuild.ts`'s — order by `seq`, walk once, derive — so replaying the log reproduces the rate exactly.
 *
 * **Counted by question id, not by line.** AD-19's at-least-once delivery and a crash-then-repair can
 * both put a question's line in the log twice, and a question counted twice is a rate that drifts every
 * time the engine is restarted. A question that reached the log only as `question.deflected` — a crash
 * after the outcome and before its asked line, repaired out of order — was still raised, so the raised
 * set is the union of both.
 *
 * **Counted in raised questions, not in cards** (matrix 28). A merged card is one `question.asked` line
 * standing for several raised questions, and the line's `raised_question_count` says how many; the
 * denominator reads that number, so compression shows up in the rate instead of shrinking the number it is
 * measured against. Only a line written before the field existed falls back to the sentence the merge
 * writes at the end of the brief — and such a line predates merging in practice, so the fallback reads 1.
 *
 * **"Reached a person" means a person settled it** (matrix 27). A question can leave `asked` three ways
 * besides deflection's: a person answered (`question.resolved`), the window took the default
 * (`question.default_taken`), or nothing has settled it yet — still open, or left open by a run that
 * stopped. Only the first is a person; the other two are reported as themselves, never folded into it.
 *
 * **"No questions" is not "none deflected".** A feature that raised nothing has no rate: 0/0 is not 0%,
 * and reporting it as 0% would put the best possible outcome for the Interviewer — nobody needed asking
 * anything — on a dashboard as its worst. So the result is a tagged union, and the inapplicable arm
 * carries no `rate` field at all for a reader to mistake for a measurement.
 */
import { DECLARATION_PAYLOAD_KEYS, compareEventOrder } from '../contracts/index.js';
import type { EventEnvelope } from '../contracts/index.js';

import { raisedQuestionsStatedIn } from './question-merge.js';
import { QUESTION_EVENT_TYPES, QUESTION_ID_PAYLOAD_KEY } from './questions.js';

/** A rate that was measured: at least one question was raised. Every count is in raised questions. */
export interface MeasuredDeflectionRate {
  readonly kind: 'measured';
  readonly feature: string;
  /** Raised questions, deflected or not — a merged card counts as the questions it stands for. */
  readonly raised: number;
  /** Raised questions answered from repository, history or ledger (Q4). */
  readonly deflected: number;
  /** Raised questions a person settled: a TUI or web answer won the compare-and-set. */
  readonly reachedUser: number;
  /** Raised questions settled by CAP-4's timeout default — asked, and decided by nobody. */
  readonly defaultTaken: number;
  /** Raised questions with no outcome yet: still open, or left open by a run that stopped. */
  readonly unsettled: number;
  /** `deflected / raised`, between 0 and 1. */
  readonly rate: number;
  /** R3 — one line that stands alone. */
  readonly summary: string;
}

/** A feature that raised no questions, for which a rate does not exist. */
export interface InapplicableDeflectionRate {
  readonly kind: 'inapplicable';
  readonly feature: string;
  readonly raised: 0;
  /** R3 — one line that stands alone, and says why there is no number. */
  readonly summary: string;
}

export type DeflectionRate = MeasuredDeflectionRate | InapplicableDeflectionRate;

type Outcome = 'deflected' | 'answered' | 'default_taken' | 'unsettled';

const OUTCOME_OF_TYPE: Readonly<Record<string, Outcome>> = {
  [QUESTION_EVENT_TYPES.Deflected]: 'deflected',
  [QUESTION_EVENT_TYPES.Resolved]: 'answered',
  [QUESTION_EVENT_TYPES.DefaultTaken]: 'default_taken',
};

/**
 * How many raised questions one `question.asked` line stands for.
 *
 * The structured field wins whenever it is a usable count. The brief is read only when the field is
 * absent — a line from an older build, which AD-5 allows — and a present but unusable value is treated as
 * absent rather than trusted, because a count of zero would make a question vanish from the denominator.
 */
const raisedCountOf = (event: EventEnvelope): number => {
  const declared = event.payload[DECLARATION_PAYLOAD_KEYS.RaisedQuestionCount];
  if (typeof declared === 'number' && Number.isSafeInteger(declared) && declared >= 1) return declared;
  const brief = event.payload[DECLARATION_PAYLOAD_KEYS.Brief];
  return typeof brief === 'string' ? raisedQuestionsStatedIn(brief) : 1;
};

const questionIdOf = (event: EventEnvelope): string | null => {
  const id = event.payload[QUESTION_ID_PAYLOAD_KEY];
  return typeof id === 'string' && id !== '' ? id : null;
};

/**
 * The deflection rate of one feature, folded from its events.
 *
 * The feature is read from the envelope rather than a payload, which is AD-5's field for it, so the
 * events of several runs — or of several features in one fold — can be handed in together and each
 * feature is measured over its own lines only. A question's first outcome line is its outcome, because
 * AD-25 admits exactly one transition out of `asked` and a repeated line is a repair, not a second one.
 */
export const deflectionRate = (events: readonly EventEnvelope[], feature: string): DeflectionRate => {
  const standsFor = new Map<string, number>();
  const outcome = new Map<string, Outcome>();
  for (const event of [...events].sort(compareEventOrder)) {
    if (event.feature !== feature) continue;
    const id = questionIdOf(event);
    if (id === null) continue;
    if (event.type === QUESTION_EVENT_TYPES.Asked) {
      if (!standsFor.has(id)) standsFor.set(id, raisedCountOf(event));
      if (!outcome.has(id)) outcome.set(id, 'unsettled');
      continue;
    }
    const settled = OUTCOME_OF_TYPE[event.type];
    if (settled === undefined) continue;
    // A deflected question that reached the log without its asked line was still raised, once.
    if (!standsFor.has(id)) standsFor.set(id, 1);
    if (outcome.get(id) === undefined || outcome.get(id) === 'unsettled') outcome.set(id, settled);
  }

  const total: Record<Outcome, number> = { deflected: 0, answered: 0, default_taken: 0, unsettled: 0 };
  for (const [id, count] of standsFor) total[outcome.get(id) ?? 'unsettled'] += count;
  const raised = total.deflected + total.answered + total.default_taken + total.unsettled;

  if (raised === 0) {
    return {
      kind: 'inapplicable',
      feature,
      raised: 0,
      summary:
        `${feature} raised no questions, so it has no deflection rate — none were deflected because ` +
        'none were asked.',
    };
  }
  return {
    kind: 'measured',
    feature,
    raised,
    deflected: total.deflected,
    reachedUser: total.answered,
    defaultTaken: total.default_taken,
    unsettled: total.unsettled,
    rate: total.deflected / raised,
    summary:
      `${feature} deflected ${String(total.deflected)} of ${String(raised)} raised questions; ` +
      `${String(total.answered)} answered by a person, ${String(total.default_taken)} by the timeout ` +
      `default, ${String(total.unsettled)} unsettled.`,
  };
};
