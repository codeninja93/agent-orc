/**
 * Story 3-3 — the stage-3 gate's interruption count: a plain tally, not a rate.
 *
 * **Counted from `step.terminated` lines whose `disposition` is `'interrupted'`** (`STEP_DISPOSITIONS`,
 * AD-8) — never a new event type, and never a maintained counter: every number here is re-derivable from
 * `events.jsonl` alone, per AD-4.
 *
 * **Folded the same way `rebuild.ts` folds a step record — keyed by `(event.run, event.step)`, never by
 * step name alone, the current attempt's slot overwritten by a later line for the same attempt** — so an
 * at-least-once-delivered duplicate line changes nothing (matrix row 6). A slot starts `null` and is
 * cleared again by the next `step.started` (a fresh attempt); `step.resume_attempted` deliberately leaves
 * it alone, exactly as `rebuild.ts`'s own `StepResumeAttempted` case leaves `disposition` at
 * `'interrupted'` rather than resetting it, because a resume continues the same attempt rather than
 * starting a new one.
 *
 * **Keying by step name alone would conflate two different runs.** A step name (`implement`, `verify`,
 * ...) is identical across every run of every feature, so a fold keyed by name alone would read a second
 * run's genuine first interruption as a redelivered duplicate of a first run's — a false non-interruption
 * the moment two separate runs of the same feature are folded together (matrix row 18). Keying by run
 * first, then by step name within that run, makes the two runs' slots distinct by construction.
 *
 * A new interruption is tallied only on the **transition** into `'interrupted'` — the slot was something
 * else (usually `null`, an attempt not yet terminated) and a `step.terminated` line now says
 * `'interrupted'`. A second `'interrupted'` line for a slot that already reads `'interrupted'` is read as
 * the redelivery the AD-19 at-least-once guarantee predicts, not as a second interruption — the same
 * "later line for the same attempt changes nothing" reading `rebuild.ts` itself relies on.
 */
import { compareEventOrder } from '../contracts/index.js';
import type { EventEnvelope } from '../contracts/index.js';

import { ENGINE_EVENT_TYPES } from './rebuild.js';

const dispositionOf = (event: EventEnvelope): string | null => {
  const value = event.payload['disposition'];
  return typeof value === 'string' ? value : null;
};

/**
 * How many times a feature's steps were interrupted (AD-8), folded from the log.
 *
 * A real zero when no step was ever interrupted (matrix row 8) — absence of an `interrupted` disposition
 * is a countable fact here, unlike `deflectionRate`'s raised-questions denominator, which has no
 * measurement at all when nothing was asked.
 */
export const interruptionCount = (events: readonly EventEnvelope[], feature: string): number => {
  // Keyed by run, then by step name within that run — never a single map keyed by step name alone, which
  // would make two different runs' `implement` steps share one slot.
  const slotsByRun = new Map<string, Map<string, string | null>>();
  let interruptions = 0;

  for (const event of [...events].sort(compareEventOrder)) {
    if (event.feature !== feature) continue;
    const step = event.step;
    if (step === null) continue;
    const slot = slotsByRun.get(event.run) ?? new Map<string, string | null>();
    slotsByRun.set(event.run, slot);

    if (event.type === ENGINE_EVENT_TYPES.StepStarted) {
      slot.set(step, null);
      continue;
    }
    if (event.type !== ENGINE_EVENT_TYPES.StepTerminated) continue;

    const declared = dispositionOf(event);
    const previous = slot.get(step) ?? null;
    if (declared === 'interrupted' && previous !== 'interrupted') interruptions += 1;
    slot.set(step, declared);
  }

  return interruptions;
};
