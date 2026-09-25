/**
 * Story 5-1 — the between-run consolidation pass: folding a completed run's own event log into durable
 * `KnowledgeEntry`-shaped facts (`src/contracts/knowledge.ts`, built for exactly this and unused until
 * now), and appending them to `ORCH_HOME/projects/<project-id>/memory/consolidated.jsonl`.
 *
 * **A cross-run fold, in `trustRecord`'s own style** (`src/engine/trust-record.ts`): every run replayed
 * from its own `events.jsonl` via `readEventLog`/`listRunIds`/`runPaths`, never a second read path, and
 * one unreadable run costs only its own credit. `areaOf` and `territoryFromEvents` are reused verbatim,
 * so a fact is anchored on the same module-boundary taxonomy a person already judges trust by.
 *
 * **"Convert, do not retrieve."** Every fact is derived mechanically from a run's own last terminal
 * `feature.state_changed` line — its `to` state and its `reason` text — and the run's declared territory.
 * No model call, no judgement, nothing this module invents: `committed` earns a positive fact that decays
 * `until-refactor`; `handed_off`/`hibernated` earn a negative fact that decays `permanent`, never
 * auto-expiring — the concrete, testable form "failures weighted above successes" takes here. `killed`
 * and every non-terminal state earn nothing.
 *
 * **Idempotent by construction.** A fact's `provenance` is exactly `consolidation:<run-id>:<area>`, and
 * {@link writeConsolidatedFacts} reads the store's existing provenance values before appending, skipping
 * any candidate whose run-id-and-area pair is already represented — the property that makes "derived
 * projection reconstructable by replay" (AD-4) true of this store too. Keying on the pair rather than the
 * run id alone means a multi-area run interrupted between two of its lines' writes still gets the missing
 * area's fact on a later pass, instead of being treated as fully consolidated because its id is present.
 *
 * **Long-term memory is written only from {@link runConsolidationPass}.** Nothing in
 * `src/engine/reconciler.ts` imports this module, and nothing here is wired into a scheduler, CLI command
 * or the reconciler's own lifecycle — matching how `trustRecord`/`foldFleet` are themselves invoked by
 * nothing in `src/` today and are still complete, tested modules. Wiring a trigger is a future story's.
 */
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeSync,
} from 'node:fs';
import { dirname } from 'node:path';

import {
  KnowledgeAnchorSchema,
  KnowledgeEntrySchema,
  TERMINAL_FEATURE_STATES,
  compareEventOrder,
} from '../contracts/index.js';
import type { DecayPolicy, EventEnvelope, FeatureState, KnowledgeEntry } from '../contracts/index.js';
import { listRunIds, projectMemoryPath, readEventLog, runPaths, runsDir } from '../runtime/index.js';

import { ENGINE_EVENT_TYPES } from './rebuild.js';
import { territoryFromEvents } from './territory.js';
import { areaOf } from './trust-record.js';

/** Options every consolidation function shares. */
export interface ConsolidationOptions {
  /** `ORCH_HOME`. Defaults to the one the runtime resolves, exactly as every other reader does. */
  readonly orchHome?: string;
}

/** What {@link consolidate} folds, beyond where `ORCH_HOME` is. */
export interface ConsolidateOptions extends ConsolidationOptions {
  /** The runs to fold, for a caller that already knows them. Defaults to every run under `runs/`. */
  readonly runIds?: readonly string[];
}

/** What {@link runConsolidationPass} is asked to do. */
export interface RunConsolidationPassOptions extends ConsolidateOptions {
  readonly projectId: string;
}

/**
 * `options.orchHome`, treating a blank string the same as `undefined`.
 *
 * `runPaths`/`runsDir`/`projectMemoryPath` each default their own `orchHome` parameter to
 * `resolveOrchHome()`, but that default-parameter substitution only fires for `undefined` — an explicit
 * `orchHome: ''` would otherwise resolve to a relative path instead of the intended default.
 */
const orchHomeOf = (options: ConsolidationOptions): string | undefined =>
  options.orchHome === undefined || options.orchHome.trim() === '' ? undefined : options.orchHome;

const payloadString = (event: EventEnvelope, key: string): string | null => {
  const value = event.payload[key];
  return typeof value === 'string' ? value : null;
};

/** True for a `to` value that is one of the four states a run's lifecycle ends at. */
const isTerminalStateValue = (value: string | null): value is FeatureState =>
  value !== null && (TERMINAL_FEATURE_STATES as readonly string[]).includes(value);

/** The one fact this fold needs from a `feature.state_changed` line: where the run ended, and why. */
interface TerminalTransition {
  readonly to: FeatureState;
  readonly reason: string;
  readonly recordedAt: string;
}

/**
 * The run's outcome: the *last* `feature.state_changed` line whose `to` is terminal and whose `reason` is
 * a usable claim. `null` for a run still in flight, or whose only terminal line carries no readable
 * reason — the same "a malformed or absent field changes nothing" rule AD-5 gives every other fold here.
 */
const lastTerminalTransition = (events: readonly EventEnvelope[]): TerminalTransition | null => {
  let found: TerminalTransition | null = null;
  for (const event of [...events].sort(compareEventOrder)) {
    if (event.type !== ENGINE_EVENT_TYPES.FeatureStateChanged) continue;
    const to = payloadString(event, 'to');
    if (!isTerminalStateValue(to)) continue;
    const reason = payloadString(event, 'reason');
    if (reason === null || reason.trim() === '') continue;
    found = { to, reason, recordedAt: event.ts };
  }
  return found;
};

/**
 * The decay policy a terminal outcome earns. `committed` is the one positive case; every other terminal
 * state this is ever called with (`handed_off`, `hibernated`) is a failure, weighted `permanent` so
 * nothing auto-expires it. `killed` is never passed here — {@link factsFromEvents} returns before asking.
 */
const decayPolicyFor = (to: Exclude<FeatureState, 'killed'>): DecayPolicy =>
  to === 'committed' ? 'until-refactor' : 'permanent';

/**
 * One run's fold, as a pure function of its own events — no path, no I/O — so the I/O matrix can be
 * driven directly against hand-built logs as well as against {@link consolidateRun}'s real read.
 */
const factsFromEvents = (runId: string, events: readonly EventEnvelope[]): readonly KnowledgeEntry[] => {
  const transition = lastTerminalTransition(events);
  if (transition === null) return [];
  const { to, reason, recordedAt } = transition;
  // `killed` produces nothing: not a fact about anything, and not a fact worth weighting against.
  if (to === 'killed') return [];

  const territory = territoryFromEvents(events);
  // An AD-21-redacted (incomplete) territory is not this run's whole declared territory — anchoring a
  // `permanent`-decay fact on it, unlike `trustRecord`'s live self-correcting fold, would persist a wrong
  // anchor forever. Treated the same as "no declared territory at all": no fact for this run.
  if (!territory?.complete) return [];

  // A territory spanning several areas credits every one of them once — `trustRecord`'s own rule. An area
  // whose anchor would be blank or otherwise invalid (`KnowledgeAnchorSchema`'s rules) is skipped rather
  // than let `KnowledgeEntrySchema.parse` throw and discard every other area's fact with it.
  const areas = [...new Set(territory.territory.map(areaOf))].filter(
    (area) => KnowledgeAnchorSchema.safeParse(area).success,
  );
  if (areas.length === 0) return [];

  const decayPolicy = decayPolicyFor(to);
  return areas.map((area) =>
    KnowledgeEntrySchema.parse({
      anchor: area,
      anchor_kind: 'module-name',
      claim: reason,
      provenance: `consolidation:${runId}:${area}`,
      recorded_at: recordedAt,
      decay_policy: decayPolicy,
      decay_features: 0,
    } satisfies KnowledgeEntry),
  );
};

/**
 * One run's fold into zero or more candidate facts, per the I/O matrix.
 *
 * Reads the run's own log with {@link readEventLog}/{@link runPaths}, exactly as `trustRecord` does. A run
 * whose log cannot be read throws out of here — which is what lets {@link consolidate} give it, and only
 * it, no credit, matching `trustRecord`'s own per-run isolation.
 */
export const consolidateRun = (
  runId: string,
  options: ConsolidationOptions = {},
): readonly KnowledgeEntry[] => {
  const paths = runPaths(runId, orchHomeOf(options));
  const events = readEventLog(paths.eventLog);
  return factsFromEvents(runId, events);
};

/**
 * Fold a batch of runs into candidate facts, defaulting to every run under `runsDir` when the caller
 * names none — `trustRecord`'s own default: a caller with no opinion about which runs to consolidate
 * means "everything recorded so far".
 *
 * One unreadable run costs that run's own credit, never the whole batch.
 */
export const consolidate = (
  runIds?: readonly string[],
  options: ConsolidationOptions = {},
): readonly KnowledgeEntry[] => {
  const ids = runIds ?? listRunIds(runsDir(orchHomeOf(options)));

  const facts: KnowledgeEntry[] = [];
  for (const runId of ids) {
    try {
      facts.push(...consolidateRun(runId, options));
    } catch {
      continue;
    }
  }
  return facts;
};

const CONSOLIDATION_PROVENANCE_PREFIX = 'consolidation:';

/**
 * The `<run-id>:<area>` pair a `consolidation:<run-id>:<area>` provenance string names, or `null` for any
 * other shape.
 *
 * The whole `<run-id>:<area>` tail is the dedup key, not the run id alone: a multi-area run writes one
 * line per area, and keying on the run id alone would treat the run as fully consolidated the moment any
 * one of its lines landed, silently losing the rest if the process was interrupted between writes.
 */
const consolidationKeyOfProvenance = (provenance: string): string | null =>
  provenance.startsWith(CONSOLIDATION_PROVENANCE_PREFIX)
    ? provenance.slice(CONSOLIDATION_PROVENANCE_PREFIX.length)
    : null;

/**
 * The store's existing lines, or none for a store that does not exist yet.
 *
 * Each line is parsed in its own try/catch, matching this module's own per-run isolation elsewhere
 * (`consolidate`'s try/catch around `consolidateRun`): one malformed line costs only itself, never every
 * future read of the store.
 */
const readConsolidatedStore = (storePath: string): readonly KnowledgeEntry[] => {
  if (!existsSync(storePath)) return [];
  const text = readFileSync(storePath, 'utf8');
  if (text === '') return [];
  const entries: KnowledgeEntry[] = [];
  for (const line of text.split('\n')) {
    if (line === '') continue;
    try {
      entries.push(KnowledgeEntrySchema.parse(JSON.parse(line) as unknown));
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
 * Append candidate facts to `projects/<project-id>/memory/consolidated.jsonl`, idempotently: a candidate
 * whose `provenance` names a run-id-and-area pair already represented in the store is skipped, never
 * duplicated.
 *
 * Durable by the same idiom `src/runtime/recorder.ts` uses for `events.jsonl`: open with `'a'`,
 * `writeSync` in a loop until the whole buffer lands, `fsyncSync`.
 *
 * Returns the facts actually appended, so a caller can report what changed.
 */
export const writeConsolidatedFacts = (
  projectId: string,
  facts: readonly KnowledgeEntry[],
  options: ConsolidationOptions = {},
): readonly KnowledgeEntry[] => {
  const storePath = projectMemoryPath(projectId, orchHomeOf(options));

  const alreadyConsolidated = new Set(
    readConsolidatedStore(storePath)
      .map((entry) => consolidationKeyOfProvenance(entry.provenance))
      .filter((key): key is string => key !== null),
  );

  const toAppend = facts.filter((fact) => {
    const key = consolidationKeyOfProvenance(fact.provenance);
    return key === null || !alreadyConsolidated.has(key);
  });

  if (toAppend.length === 0) return [];

  mkdirSync(dirname(storePath), { recursive: true });
  const fd = openSync(storePath, 'a');
  try {
    for (const fact of toAppend) appendLine(fd, JSON.stringify(fact));
    try {
      fsyncSync(fd);
    } catch {
      // A filesystem that refuses fsync does not make the written lines less whole.
    }
  } finally {
    closeSync(fd);
  }

  return toAppend;
};

/**
 * The one entry point a future caller invokes: fold a batch of runs, then append the idempotent result.
 *
 * "Between features or nightly" names *when* a caller should invoke this, not a caller this story builds
 * — see the story's own Boundaries. Nothing in this codebase calls this function yet.
 */
export const runConsolidationPass = (options: RunConsolidationPassOptions): readonly KnowledgeEntry[] => {
  const passthrough: ConsolidationOptions =
    options.orchHome === undefined ? {} : { orchHome: options.orchHome };
  const facts = consolidate(options.runIds, passthrough);
  return writeConsolidatedFacts(options.projectId, facts, passthrough);
};
