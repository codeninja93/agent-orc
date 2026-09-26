/**
 * Story 5-3 — the queryable index over `decision.recorded` lines (AD-25).
 *
 * `decision.ts` already writes the ledger and `deflection.ts`'s `matchDecisionLedger` already reads it
 * back, both correctly — but every attempt re-reads and re-parses every ledger run's whole `events.jsonl`,
 * from scratch, every time. This module builds the projection that avoids that: {@link buildDecisionIndex}
 * replays `decision.recorded` lines out of a batch of ledger runs and appends the ones not indexed yet,
 * idempotently, to `projects/<project-id>/memory/decisions.jsonl`; {@link queryDecisionIndex} answers the
 * same question `matchDecisionLedger` does, against the indexed entries instead of raw event logs.
 *
 * **A derived projection, reconstructable by replay (AD-4)**, in `consolidation.ts`'s own style: nothing
 * here is a second definition of what a decision line is — `decisionsInLog` (`decision.ts`) does every
 * line's parsing, unchanged — and deleting `decisions.jsonl` and calling {@link buildDecisionIndex} again
 * over the same runs produces the same content. The idempotence key is the question id, the same field
 * `decidedQuestionIds` already uses, because a question is resolved exactly once and so writes exactly one
 * `decision.recorded` line for that id in the ordinary course; a repeat is a re-index of the same run, not
 * a second decision to keep.
 *
 * **`queryDecisionIndex` is `matchDecisionLedger` read again, not rewritten.** Newest by `resolved_at`
 * wins; a `timeout_default` line is never a decision; and a newest decision whose answer cannot be shown
 * (AD-21-redacted, or blank) reports no match at all rather than falling back to an older, superseded one.
 * The anchor comparison itself is `namesAnchor`, and an unreadable per-run log is classified by
 * `isUnreadableLog`, both exported from `deflection.ts` for exactly this reuse, so this index never carries
 * a second, drifting definition of either.
 *
 * **Complete and unwired**, matching `trustRecord`/`foldFleet`/story 5-1's `consolidation.ts`/story 5-2's
 * sweep-and-retrieval precedent: nothing under `src/` calls either function here. `deflection.ts`'s live
 * `matchDecisionLedger` is still the path a real question is deflected through; swapping its data source
 * for this index is a deliberate, separate decision for later, once this module is proven correct against
 * it in isolation.
 */
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

import type { DeflectionSource } from '../contracts/index.js';
import { decisionIndexPath, readEventLog, runPaths } from '../runtime/index.js';

import { decisionsInLog } from './decision.js';
import { isUnreadableLog, isUsableAnchor, namesAnchor } from './deflection.js';
import type { QuestionAnchor } from './deflection.js';
import { QUESTION_ID_PAYLOAD_KEY, REDACTED_FIELDS_PAYLOAD_KEY } from './questions.js';

/** Options {@link buildDecisionIndex} accepts, beyond the runs and project it indexes. */
export interface BuildDecisionIndexOptions {
  /** `ORCH_HOME`. Defaults to the one the runtime resolves, exactly as every other reader does. */
  readonly orchHome?: string;
}

/**
 * `options.orchHome`, treating a blank string the same as `undefined`.
 *
 * `consolidation.ts`'s own `orchHomeOf` guard, built again rather than imported: this store holds a
 * different record shape and gets its own small reader/writer pair, per this story's own Boundaries, and
 * a helper this trivial is not worth a cross-module dependency for.
 */
const orchHomeOf = (options: BuildDecisionIndexOptions): string | undefined =>
  options.orchHome === undefined || options.orchHome.trim() === '' ? undefined : options.orchHome;

/**
 * One decision, as the index keeps it: the run it was recorded in, and the `decision.recorded` payload
 * verbatim — the same shape `decisionsInLog` already hands back, so indexing never invents a second
 * parsing of what a decision line is.
 *
 * `questionId` travels alongside the payload rather than being re-derived from it on every read, because
 * it is the idempotence key: the same field `decidedQuestionIds` (`decision.ts`) already uses to tell a
 * decision already recorded from one that is not.
 */
export interface DecisionIndexEntry {
  readonly questionId: string;
  readonly run: string;
  readonly payload: Record<string, unknown>;
}

const isDecisionIndexEntry = (value: unknown): value is DecisionIndexEntry => {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate['questionId'] === 'string' &&
    typeof candidate['run'] === 'string' &&
    typeof candidate['payload'] === 'object' &&
    candidate['payload'] !== null &&
    !Array.isArray(candidate['payload'])
  );
};

/**
 * The store's existing entries, or none for a store that does not exist yet.
 *
 * `consolidation.ts`'s own `readConsolidatedStore` template: the read is attempted directly rather than
 * gated by a separate existence check, so a deletion racing this read never surfaces as an uncaught
 * `ENOENT` — only that code is swallowed, any other read failure still propagates. One malformed line
 * costs only itself, never the rest of the store, matching this module's own per-run isolation below.
 *
 * Exported (story 5-3), matching `consolidation.ts`'s own exported `readConsolidatedStore`, so a caller
 * that only wants to query the existing index — never extend it with new runs — is not left calling
 * {@link buildDecisionIndex} with an empty `runIds` as a workaround.
 */
export const readDecisionIndex = (storePath: string): readonly DecisionIndexEntry[] => {
  let text: string;
  try {
    text = readFileSync(storePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  if (text === '') return [];
  const entries: DecisionIndexEntry[] = [];
  for (const line of text.split('\n')) {
    if (line === '') continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (isDecisionIndexEntry(parsed)) entries.push(parsed);
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
 * Replay `decision.recorded` lines out of `runIds`' own ledgers, and append the ones the index does not
 * carry yet — idempotently, keyed by question id — to `projects/<project-id>/memory/decisions.jsonl`
 * (AD-9), durably: `mkdirSync` the directory, open with `'a'`, `writeSync` each line in a loop until it
 * lands whole, `fsyncSync` — the same idiom `consolidation.ts` and `src/runtime/recorder.ts` use.
 *
 * A derived projection, reconstructable by replay (AD-4): deleting the store and calling this again over
 * the same runs produces the same content. One run whose log cannot be read — absent, corrupt, a
 * directory, an unsafe id — costs only that run's own credit, exactly as `matchDecisionLedger`
 * (`deflection.ts`) treats the same failure: `isUnreadableLog` decides whether the error means "this run's
 * log is not there to read" or is a defect, and only the former is swallowed — anything else propagates,
 * so a future shape change in `decisionsInLog`/`readEventLog` throwing a `TypeError` is not hidden as a
 * skipped run.
 *
 * Returns every entry the index now holds — the store's prior content plus whatever this call added — so
 * {@link queryDecisionIndex} can be called on the result directly, without a caller reading the store back
 * itself.
 */
export const buildDecisionIndex = (
  runIds: readonly string[],
  projectId: string,
  options: BuildDecisionIndexOptions = {},
): readonly DecisionIndexEntry[] => {
  const orchHome = orchHomeOf(options);
  const storePath = decisionIndexPath(projectId, orchHome);
  const existing = readDecisionIndex(storePath);
  const known = new Set(existing.map((entry) => entry.questionId));

  const toAppend: DecisionIndexEntry[] = [];
  for (const runId of runIds) {
    let decisions: readonly Record<string, unknown>[];
    try {
      const paths = runPaths(runId, orchHome);
      decisions = decisionsInLog(readEventLog(paths.eventLog));
    } catch (error) {
      if (!isUnreadableLog(error)) throw error;
      continue;
    }
    for (const payload of decisions) {
      const questionId = payload[QUESTION_ID_PAYLOAD_KEY];
      if (typeof questionId !== 'string' || questionId === '' || known.has(questionId)) continue;
      known.add(questionId);
      toAppend.push({ questionId, run: runId, payload });
    }
  }

  if (toAppend.length > 0) {
    mkdirSync(dirname(storePath), { recursive: true });
    const fd = openSync(storePath, 'a');
    try {
      for (const entry of toAppend) appendLine(fd, JSON.stringify(entry));
      try {
        fsyncSync(fd);
      } catch {
        // A filesystem that refuses fsync does not make the written lines less whole.
      }
    } finally {
      closeSync(fd);
    }
  }

  return [...existing, ...toAppend];
};

/**
 * One decision-ledger match, as {@link queryDecisionIndex} reports it.
 *
 * `source` is the literal `'decision_ledger'` — `DeflectionSource`'s own type, not a new one — so whoever
 * eventually wires this index in place of `matchDecisionLedger`'s live fold can tell which deflection
 * source a match came from without inventing the field then, matching `DeflectionMatch`'s own shape
 * (`deflection.ts`).
 */
export interface DecisionIndexMatch {
  readonly source: DeflectionSource;
  readonly run: string;
  readonly questionId: string;
  readonly answer: string;
}

const payloadText = (payload: Record<string, unknown>, key: string): string => {
  const value = payload[key];
  return typeof value === 'string' ? value : '';
};

/** The resolver whose decisions are not decisions — `matchDecisionLedger`'s own rule (matrix 19). */
const TIMEOUT_RESOLVER = 'timeout_default';

/** True when the AD-21 pass rewrote this decision's answer on the way into the log. */
const answerWasRewritten = (payload: Record<string, unknown>): boolean =>
  payloadText(payload, REDACTED_FIELDS_PAYLOAD_KEY)
    .split(',')
    .map((field) => field.trim())
    .includes('answer');

/** One entry that names the anchor, with what orders it against the others. */
interface Candidate {
  readonly entry: DecisionIndexEntry;
  readonly resolvedAt: string;
  readonly order: number;
}

/**
 * `matchDecisionLedger`'s own semantics (`deflection.ts`), reproduced as a pure, in-memory query over
 * already-indexed entries instead of a linear fold over raw event logs.
 *
 * Newest is by each decision's own `resolved_at`, an RFC3339 instant that orders as text, with the fold's
 * own reading order breaking a tie. That tie-break inherits `matchDecisionLedger`'s own limitation
 * (`deflection.ts`): when two distinct decisions share one `resolved_at` to the millisecond — extremely
 * rare — the answer is whichever this call's `entries` happens to carry later, which for a persisted index
 * is fixed by build order rather than by any caller's run order. This is not a new flaw the index
 * introduces; it is the live fold's own pre-existing behaviour, reproduced rather than "fixed", so the two
 * paths keep agreeing rather than the index becoming more stable than what it mirrors. Newest means newest
 * even when it cannot be used (matrix 20): a newest decision whose answer was
 * rewritten by AD-21 or recorded blank reports no match at all, never falling back to an older decision
 * it had already superseded. An unusable anchor (`isUsableAnchor`) is refused before anything is
 * compared, matching the refusal `attemptDeflection` makes before any source — including the ledger — is
 * ever consulted.
 */
export const queryDecisionIndex = (
  entries: readonly DecisionIndexEntry[],
  anchor: QuestionAnchor,
): DecisionIndexMatch | null => {
  if (!isUsableAnchor(anchor)) return null;

  const candidates: Candidate[] = [];
  for (const entry of entries) {
    const text = `${payloadText(entry.payload, 'question')}\n${payloadText(entry.payload, 'answer')}`;
    if (!namesAnchor(text, anchor)) continue;
    if (payloadText(entry.payload, 'resolver') === TIMEOUT_RESOLVER) continue;
    candidates.push({ entry, resolvedAt: payloadText(entry.payload, 'resolved_at'), order: candidates.length });
  }

  const newest = [...candidates]
    .sort((a, b) => (a.resolvedAt < b.resolvedAt ? -1 : a.resolvedAt > b.resolvedAt ? 1 : a.order - b.order))
    .at(-1);
  if (newest === undefined) return null;

  const answer = payloadText(newest.entry.payload, 'answer');
  if (answerWasRewritten(newest.entry.payload) || answer.trim() === '') return null;

  return { source: 'decision_ledger', run: newest.entry.run, questionId: newest.entry.questionId, answer };
};
