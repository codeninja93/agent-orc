/**
 * Story 3-3 — the per-area trust record: merged-unchanged versus corrected, by the module boundary a
 * person actually judges trust by.
 *
 * **A cross-run fold, in `foldFleet`'s own style** (`src/tui/fleet.ts`): every run under `runsDir`, read
 * with `listRunIds` and `readEventLog` rather than `loadShellView` — this needs the raw `pull_request.
 * merge_fidelity` and `feature.territory_declared` lines a projected `ShellView` does not carry, not a
 * rendered summary. One unreadable run costs that run's own credit, never the whole fold, matching
 * `foldFleet`'s own per-run isolation.
 *
 * **The one durable fact this joins two of.** `src/engine/write-executor.ts`'s `mergeFidelityOf`,
 * emitted once per confirmed merge by the reconciler, says whether that run's merge landed unchanged or
 * corrected; `feature.territory_declared` (already durable per AD-4/1-11) says which paths the run's
 * feature touched. Joining them by run is what attributes an outcome to an area without a second write
 * path or a maintained table — replaying the log reproduces the whole record.
 *
 * **"Area" is the module boundary, not the raw first path segment.** Nearly every declared path starts
 * with `src`, so taking the literal first segment would put the whole repository in one area; a leading
 * `src` is stripped first, and `firstPathSegment` (`src/contracts/territory.ts`, exported for exactly this
 * reuse) is applied to what remains. A path that never had a leading `src` — `tests/...`, `docs/...` —
 * falls back to `firstPathSegment`'s own answer unchanged. `src/engine/x.ts` and `src/contracts/y.ts` are
 * therefore two different areas, `engine` and `contracts`, which is the taxonomy a person actually judges
 * trust by.
 *
 * **A territory spanning several areas credits every one of them**, the same any-overlap reasoning
 * `pathsCollide` already applies to territory comparison — not a new single-owner taxonomy. A feature
 * declared as `['src/engine/x.ts', 'src/tui/y.ts']` that merges unchanged credits both `engine` and `tui`
 * once each (matrix row 14).
 */
import {
  PULL_REQUEST_MERGE_FIDELITY_EVENT_TYPE,
  PULL_REQUEST_MERGE_FIDELITY_PAYLOAD_KEYS,
  compareEventOrder,
  firstPathSegment,
} from '../contracts/index.js';
import type { EventEnvelope } from '../contracts/index.js';
import { listRunIds, readEventLog, runPaths, runsDir } from '../runtime/index.js';

import { territoryFromEvents } from './territory.js';

/** One area's tally: how many confirmed merges into it landed unchanged versus corrected. */
export interface AreaTrust {
  readonly area: string;
  readonly unchanged: number;
  readonly corrected: number;
}

/** The trust record: one entry per area ever credited, in a stable (alphabetical) order. */
export type TrustRecordByArea = readonly AreaTrust[];

export interface TrustRecordOptions {
  /** `ORCH_HOME`. Defaults to the one the runtime resolves, exactly as every other reader does. */
  readonly orchHome?: string;
  /** The runs to fold, for a caller that already knows them. Defaults to every directory under `runs/`. */
  readonly runIds?: readonly string[];
}

/**
 * A declared territory path, with one leading `src` segment stripped, then `firstPathSegment` applied to
 * what remains — or to the path unchanged, when it never had one.
 *
 * The input is expected already normalised (posix separators, no leading `./`, no trailing slash), which
 * every path `territoryFromEvents` returns already is — so this needs no separator handling of its own.
 */
export const areaOf = (normalisedTerritoryPath: string): string => {
  const segments = normalisedTerritoryPath.split('/');
  const withoutLeadingSrc = segments[0] === 'src' ? segments.slice(1).join('/') : normalisedTerritoryPath;
  return firstPathSegment(withoutLeadingSrc);
};

type MergeFidelityOutcome = 'unchanged' | 'corrected';

/**
 * The outcome a run's `pull_request.merge_fidelity` line settled on, or `null` when the run never merged
 * or the comparison itself could not be made (a `code` line, per `mergeFidelityOf`'s own shape).
 *
 * The last such line wins, matching every other "a later line is a correction" fold in this codebase —
 * though in practice a run emits this line at most once, per its own reconciler call site.
 */
const mergeFidelityOutcomeOf = (events: readonly EventEnvelope[]): MergeFidelityOutcome | null => {
  let outcome: MergeFidelityOutcome | null = null;
  for (const event of [...events].sort(compareEventOrder)) {
    if (event.type !== PULL_REQUEST_MERGE_FIDELITY_EVENT_TYPE) continue;
    const declared = event.payload[PULL_REQUEST_MERGE_FIDELITY_PAYLOAD_KEYS.Outcome];
    outcome = declared === 'unchanged' || declared === 'corrected' ? declared : null;
  }
  return outcome;
};

/**
 * Fold every run under `runsDir` into the per-area trust record.
 *
 * A run that never merged, or whose merge-fidelity comparison could not be made, or that declared no
 * territory, contributes nothing — there is no outcome to attribute, or nowhere to attribute it to.
 */
export const trustRecord = (options: TrustRecordOptions = {}): TrustRecordByArea => {
  const orchHome = options.orchHome;
  const runIds = options.runIds ?? listRunIds(orchHome === undefined ? runsDir() : runsDir(orchHome));

  const tally = new Map<string, { unchanged: number; corrected: number }>();
  const credit = (area: string, outcome: MergeFidelityOutcome): void => {
    const entry = tally.get(area) ?? { unchanged: 0, corrected: 0 };
    if (outcome === 'unchanged') entry.unchanged += 1;
    else entry.corrected += 1;
    tally.set(area, entry);
  };

  for (const runId of runIds) {
    const paths = orchHome === undefined ? runPaths(runId) : runPaths(runId, orchHome);
    let events: readonly EventEnvelope[];
    try {
      events = readEventLog(paths.eventLog);
    } catch {
      // One unreadable run costs that run's own credit, never the whole fold — `foldFleet`'s own rule.
      continue;
    }

    const outcome = mergeFidelityOutcomeOf(events);
    if (outcome === null) continue;

    const territory = territoryFromEvents(events);
    if (territory === null) continue;

    const areas = new Set(territory.territory.map(areaOf));
    for (const area of areas) credit(area, outcome);
  }

  return [...tally.entries()]
    .map(([area, counts]) => ({ area, unchanged: counts.unchanged, corrected: counts.corrected }))
    .sort((a, b) => (a.area < b.area ? -1 : a.area > b.area ? 1 : 0));
};
