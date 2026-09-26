/**
 * Story 5-4 — CAP-19/AD-34's fixed home for cross-project memory: `ORCH_HOME/memory/patterns.jsonl`, the
 * one shared store every project reads and writes, because a pattern learned building one product ("how
 * we do auth") has nowhere useful to go anchored to that one repository alone.
 *
 * **Mirrors story 5-2's `retrieveFacts`/`consolidation.ts`'s own durable-append idiom exactly**, reading
 * and writing the one shared, cross-project store rather than a per-project one. {@link recordPattern}
 * validates and durably appends an already-composed `CrossRepoPattern` — `mkdirSync` the directory, open
 * with `'a'`, `writeSync` the whole line in a loop until it lands, `fsyncSync` — the same idiom
 * `consolidation.ts` and `src/runtime/recorder.ts` use. {@link retrievePatterns} is a topic-filtered,
 * budget-capped, most-recent-first read: a plain count, no tokenizer, no fuzzy ranking, exactly
 * `retrieveFacts`'s own shape.
 *
 * **A pure, mechanical write, never a judgement.** `recordPattern` does not decide *whether* something is
 * pattern-worthy or compose the abstraction itself — that judgement has no mechanical test and is out of
 * this story's scope. What makes "no code snippets and no per-repo specifics" hold is
 * `CrossRepoPatternSchema`'s own shape (`src/contracts/pattern.ts`): no anchor, no path, no symbol field
 * for either to live in.
 *
 * **Complete and unwired**, matching every memory module this stage has built so far
 * (`trustRecord`/`foldFleet`/`consolidation.ts`/story 5-2's sweep-and-retrieval/story 5-3's index): nothing
 * under `src/` imports this module. `CrossRepoPatternSchema` requires a `decayPolicy` (and, for
 * `n-features`, a `decayFeatures`) on every record, exactly as `KnowledgeEntrySchema` does — but no hit-count
 * tracking, no promotion, and no pruning sweep act on it yet; that is story 5-2's re-validation sweep's
 * shape, not this module's.
 */
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

import { CrossRepoPatternSchema } from '../contracts/index.js';
import type { CrossRepoPattern } from '../contracts/index.js';
import { patternsPath } from '../runtime/index.js';

/** Options every pattern-memory function shares. */
export interface PatternMemoryOptions {
  /** `ORCH_HOME`. Defaults to the one the runtime resolves, exactly as every other reader does. */
  readonly orchHome?: string;
}

/**
 * `options.orchHome`, treating a blank string the same as `undefined`.
 *
 * `consolidation.ts`'s own `orchHomeOf` guard, built again rather than imported: default-parameter
 * substitution only fires for `undefined`, and an explicit `orchHome: ''` would otherwise resolve to a
 * relative path instead of the intended default. A helper this trivial is not worth a cross-module
 * dependency for, matching `decision-index.ts`'s own precedent for the same guard.
 */
const orchHomeOf = (options: PatternMemoryOptions): string | undefined =>
  options.orchHome === undefined || options.orchHome.trim() === '' ? undefined : options.orchHome;

/**
 * The store's existing entries, or none for a store that does not exist yet.
 *
 * `consolidation.ts`'s own `readConsolidatedStore` template: the read is attempted directly rather than
 * gated by a separate existence check, so a deletion racing this read never surfaces as an uncaught
 * `ENOENT` — only that code is swallowed, any other read failure still propagates. One malformed or
 * hand-corrupted line costs only itself, never the rest of the store.
 */
const readPatternsStore = (storePath: string): readonly CrossRepoPattern[] => {
  let text: string;
  try {
    text = readFileSync(storePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  if (text === '') return [];
  const entries: CrossRepoPattern[] = [];
  for (const line of text.split('\n')) {
    if (line === '') continue;
    try {
      entries.push(CrossRepoPatternSchema.parse(JSON.parse(line) as unknown));
    } catch {
      continue;
    }
  }
  return entries;
};

/** Append one whole line, in one write — the recorder's own durable-append idiom. */
const appendLine = (fd: number, line: string): void => {
  const buffer = Buffer.from(`${line}\n`, 'utf8');
  let written = 0;
  while (written < buffer.length) {
    written += writeSync(fd, buffer, written, buffer.length - written);
  }
};

/**
 * Validate an already-composed `CrossRepoPattern` and durably append it to `ORCH_HOME/memory/patterns.jsonl`
 * — the one shared, cross-project store AD-34 fixes — and nowhere else, regardless of which project
 * recorded it.
 *
 * A pure, mechanical write: this function does not decide whether `pattern` is pattern-worthy, nor compose
 * the abstraction itself. `CrossRepoPatternSchema.parse` throws on a blank `topic` or `pattern`, refusing
 * construction at the schema rather than silently dropping it.
 *
 * Durable by `consolidation.ts`'s own idiom: `mkdirSync` the directory, open with `'a'`, `writeSync` the
 * whole line in a loop until it lands, `fsyncSync`.
 *
 * Returns the validated pattern, so a caller can confirm exactly what was recorded.
 */
export const recordPattern = (
  pattern: CrossRepoPattern,
  options: PatternMemoryOptions = {},
): CrossRepoPattern => {
  const validated = CrossRepoPatternSchema.parse(pattern);
  const storePath = patternsPath(orchHomeOf(options));

  mkdirSync(dirname(storePath), { recursive: true });
  const fd = openSync(storePath, 'a');
  try {
    appendLine(fd, JSON.stringify(validated));
    try {
      fsyncSync(fd);
    } catch {
      // A filesystem that refuses fsync does not make the written line less whole.
    }
  } finally {
    closeSync(fd);
  }

  return validated;
};

/** Descending by `recordedAt` — most recent first. RFC3339-with-milliseconds-UTC sorts lexicographically. */
const byRecordedAtDescending = (a: CrossRepoPattern, b: CrossRepoPattern): number => {
  if (a.recordedAt === b.recordedAt) return 0;
  return a.recordedAt > b.recordedAt ? -1 : 1;
};

/**
 * The most recent `budget` cross-repo patterns recorded under `topic`, from every project — read from the
 * one shared store AD-34 fixes, never a per-project partition.
 *
 * Filtering is by exact `topic` match — story 5-2's `retrieveFacts` own shape: a plain count, no
 * tokenizer, no fuzzy ranking beyond recency. A store that does not exist yet, a budget larger than the
 * matching set, or no entry recorded under the requested topic all answer with a list rather than an
 * error: a budget is a limit, not a failure, and an empty result is not a refusal.
 *
 * A negative `budget` is clamped to zero (`[]`, never a refusal), matching `retrieveFacts`'s own rule.
 */
export const retrievePatterns = (
  topic: string,
  budget: number,
  options: PatternMemoryOptions = {},
): readonly CrossRepoPattern[] => {
  const storePath = patternsPath(orchHomeOf(options));
  const entries = readPatternsStore(storePath);
  const matching = entries.filter((entry) => entry.topic === topic);
  const mostRecentFirst = [...matching].sort(byRecordedAtDescending);
  return mostRecentFirst.slice(0, Math.max(0, budget));
};
