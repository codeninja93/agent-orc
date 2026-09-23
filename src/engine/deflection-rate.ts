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
 * **"No questions" is not "none deflected".** A feature that raised nothing has no rate: 0/0 is not 0%,
 * and reporting it as 0% would put the best possible outcome for the Interviewer — nobody needed asking
 * anything — on a dashboard as its worst. So the result is a tagged union, and the inapplicable arm
 * carries no `rate` field at all for a reader to mistake for a measurement.
 */
import { compareEventOrder } from '../contracts/index.js';
import type { EventEnvelope } from '../contracts/index.js';

import { QUESTION_EVENT_TYPES, QUESTION_ID_PAYLOAD_KEY } from './questions.js';

/** A rate that was measured: at least one question was raised. */
export interface MeasuredDeflectionRate {
  readonly kind: 'measured';
  readonly feature: string;
  /** Distinct questions raised, deflected or not. Never zero on this arm. */
  readonly raised: number;
  /** Distinct questions answered from repository, history or ledger (Q4). */
  readonly deflected: number;
  /** Distinct questions that reached a person — raised and not deflected. */
  readonly reachedUser: number;
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

const questionIdOf = (event: EventEnvelope): string | null => {
  const id = event.payload[QUESTION_ID_PAYLOAD_KEY];
  return typeof id === 'string' && id !== '' ? id : null;
};

/**
 * The deflection rate of one feature, folded from its events.
 *
 * The feature is read from the envelope rather than a payload, which is AD-5's field for it, so the
 * events of several runs — or of several features in one fold — can be handed in together and each
 * feature is measured over its own lines only.
 */
export const deflectionRate = (events: readonly EventEnvelope[], feature: string): DeflectionRate => {
  const raised = new Set<string>();
  const deflected = new Set<string>();
  for (const event of [...events].sort(compareEventOrder)) {
    if (event.feature !== feature) continue;
    const id = questionIdOf(event);
    if (id === null) continue;
    if (event.type === QUESTION_EVENT_TYPES.Asked) raised.add(id);
    if (event.type === QUESTION_EVENT_TYPES.Deflected) {
      raised.add(id);
      deflected.add(id);
    }
  }

  if (raised.size === 0) {
    return {
      kind: 'inapplicable',
      feature,
      raised: 0,
      summary:
        `${feature} raised no questions, so it has no deflection rate — none were deflected because ` +
        'none were asked.',
    };
  }
  const reachedUser = raised.size - deflected.size;
  return {
    kind: 'measured',
    feature,
    raised: raised.size,
    deflected: deflected.size,
    reachedUser,
    rate: deflected.size / raised.size,
    summary:
      `${feature} deflected ${String(deflected.size)} of ${String(raised.size)} raised questions; ` +
      `${String(reachedUser)} reached a person.`,
  };
};
