/**
 * Story 3-3 — usage per feature, the stage-3 gate's fifth signal.
 *
 * **This is glue, not a new primitive.** `src/contracts/usage.ts` already supplies `usageFromPayload` and
 * `totalUsage`, and its own docblock names this story as the reader; the only thing added here is folding
 * every `step.terminated` line's usage, for one feature, into one total.
 *
 * **Absence stays absence.** A feature with no recorded usage anywhere gets `null` (R8), never `0` —
 * exactly what `totalUsage([])` already answers, and exactly what `totalUsage` keeps true of a list built
 * entirely from steps that reported nothing (matrix row 10). A feature with usage recorded on some steps
 * and not others sums the recorded ones only, via `totalUsage`'s own null-skipping (matrix row 9).
 */
import { USAGE_PAYLOAD_KEY, compareEventOrder, totalUsage, usageFromPayload } from '../contracts/index.js';
import type { EventEnvelope, StepUsage } from '../contracts/index.js';

import { ENGINE_EVENT_TYPES } from './rebuild.js';

/**
 * One feature's total usage, folded from every `step.terminated` line's `usage` payload entry.
 *
 * The feature is read from the envelope, as every fold in this file's own idiom reads it, so events from
 * several runs or several features can be handed in together and each feature is measured over its own
 * lines only.
 */
export const usagePerFeature = (events: readonly EventEnvelope[], feature: string): StepUsage | null => {
  const records: (StepUsage | null)[] = [];
  for (const event of [...events].sort(compareEventOrder)) {
    if (event.feature !== feature) continue;
    if (event.type !== ENGINE_EVENT_TYPES.StepTerminated) continue;
    records.push(usageFromPayload(event.payload[USAGE_PAYLOAD_KEY]));
  }
  return totalUsage(records);
};
