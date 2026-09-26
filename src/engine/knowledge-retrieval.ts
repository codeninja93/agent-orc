/**
 * Story 5-2 — the reader story 5-1's `consolidated.jsonl` (L3) never got: CAP-17's "retrieval for a later
 * feature respects a declared per-feature read budget" has been a sentence in `memory-design.md` since L3
 * was built, and nothing until now turned it into code.
 *
 * **A count, not a token budget.** `budget` is a plain number of entries, most-recent-first
 * (`recorded_at` descending) — this story adds no tokenizer dependency, and a count is a real, testable
 * budget without one. Filtering is by `anchor` membership in the caller-supplied `areas`, the same area
 * vocabulary `src/engine/trust-record.ts`'s `areaOf` and story 5-1's own consolidation already established
 * (every L3 entry's `anchor` *is* an area, per `consolidateRun`'s own construction) — no fuzzy matching, no
 * ranking beyond recency.
 *
 * **Read-only, and unwired**, matching this codebase's own precedent for a complete, tested module with no
 * caller yet: `trustRecord`, `foldFleet`, and story 5-1's `consolidation.ts` are all exactly this. Nothing
 * here is called from the reconciler or a step's input construction; a later story decides when a feature's
 * step input asks for a read budget's worth of facts.
 */
import type { KnowledgeEntry } from '../contracts/index.js';
import { projectMemoryPath } from '../runtime/index.js';

import { orchHomeOf, readConsolidatedStore } from './consolidation.js';

/** Options {@link retrieveFacts} shares with story 5-1's own consolidation-store readers. */
export interface RetrieveFactsOptions {
  /** `ORCH_HOME`. Defaults to the one the runtime resolves, exactly as every other reader does. */
  readonly orchHome?: string;
}

/** Descending by `recorded_at` — most recent first. RFC3339-with-milliseconds-UTC sorts lexicographically. */
const byRecordedAtDescending = (a: KnowledgeEntry, b: KnowledgeEntry): number => {
  if (a.recorded_at === b.recorded_at) return 0;
  return a.recorded_at > b.recorded_at ? -1 : 1;
};

/**
 * The most recent `budget` L3 facts anchored to any of `areas`, for a feature about to start.
 *
 * `areas` is matched against `KnowledgeEntry.anchor` by plain set membership — every fact
 * `consolidateRun` has ever written anchors on an area computed by `areaOf`, which is the same vocabulary
 * a caller declaring a feature's territory already computes its own areas from. A project with no store
 * yet, a budget larger than the matching set, or no entry anchored to any requested area all answer with
 * a list rather than an error: a budget is a limit, not a failure, and an empty result is not a refusal.
 *
 * A negative `budget` is clamped to zero (`[]`, never a refusal), and a non-integer `budget` is silently
 * truncated by `Array.prototype.slice`'s own coercion — neither is validated or reported as an error, so
 * a caller passing either gets a quietly smaller (or empty) list rather than an exception.
 */
export const retrieveFacts = (
  projectId: string,
  areas: readonly string[],
  budget: number,
  options: RetrieveFactsOptions = {},
): readonly KnowledgeEntry[] => {
  const storePath = projectMemoryPath(projectId, orchHomeOf(options));
  const entries = readConsolidatedStore(storePath);
  const requestedAreas = new Set(areas);
  const matching = entries.filter((entry) => requestedAreas.has(entry.anchor));
  const mostRecentFirst = [...matching].sort(byRecordedAtDescending);
  return mostRecentFirst.slice(0, Math.max(0, budget));
};
