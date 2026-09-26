/**
 * Story 3-3 — the shadow rolling-window gate story 3-2 explicitly deferred here.
 *
 * **The same cross-run scan `trust-record.ts` is**, over a different pair of event types: `foldFleet`'s
 * own style (`listRunIds` + `readEventLog`, not `loadShellView`), reading `shadow.compared` and
 * `write.suppressed` across the fleet's shadow runs. No new event type, no maintained counter — every
 * field here is re-derivable from `events.jsonl` alone, per AD-4.
 *
 * **A run is "graded" when its log carries a `shadow.compared` line at all**, whether that line settled on
 * an outcome or carries only a `code` (a comparison that could not be made — `src/engine/shadow.ts`'s own
 * "emitted once, whether the comparison succeeded or failed"). The **window** is the most recent
 * {@link SHADOW_GATE_WINDOW_SIZE} graded runs, oldest dropped first: run ids are ULIDs, so
 * `listRunIds`'s own chronological order (`foldFleet`'s "ids sort chronologically" fact) is all the
 * ordering this needs.
 *
 * **`destructive` is scanned from each windowed run's own log**, not filtered down to only the runs whose
 * comparison itself succeeded — a destructive `write.suppressed` line is a fact about that run
 * independent of whether `shadow.compared` on it later carried a clean outcome, a `material_change`, or
 * even a `code` failure. It is *not* widened to runs outside the window: fewer than
 * {@link SHADOW_GATE_WINDOW_SIZE} graded runs never inflates `runsInWindow`, and a destructive write in a
 * run that fell out of the window (older than the most recent {@link SHADOW_GATE_WINDOW_SIZE}) is no
 * longer live evidence, exactly as an accepted or material-change outcome from that same run no longer
 * counts toward `accepted`/`materialChange`.
 *
 * **Fewer than {@link SHADOW_GATE_WINDOW_SIZE} graded runs is `met: false`, reported plainly** — never
 * padded to look like a full window, and never `inapplicable`: this gate's whole job is to say "not yet
 * enough evidence" rather than to have no opinion (matrix row 15).
 *
 * **Zero-tolerance on `destructive` overrides the accept rate entirely** (matrix row 17): `met` requires
 * `runsInWindow >= 20`, `accepted / runsInWindow >= 0.8`, *and* `destructive === 0`, all three. A run with
 * zero `write.suppressed` lines at all is not "automatically clean toward the 80% bar" — it simply
 * contributes nothing to `destructive`, which is different from having been positively checked.
 */
import {
  SHADOW_COMPARED_EVENT_TYPE,
  SHADOW_COMPARED_PAYLOAD_KEYS,
  WRITE_SUPPRESSED_EVENT_TYPE,
  WRITE_SUPPRESSED_PAYLOAD_KEYS,
  compareEventOrder,
} from '../contracts/index.js';
import type { EventEnvelope } from '../contracts/index.js';
import { listRunIds, readEventLog, runPaths, runsDir } from '../runtime/index.js';

/** How many of the most recent graded shadow runs the rolling window covers. */
export const SHADOW_GATE_WINDOW_SIZE = 20;

/** The minimum accept rate the window must clear, among the runs it actually settled on an outcome. */
export const SHADOW_GATE_MIN_ACCEPT_RATE = 0.8;

/** The rolling shadow-window verdict the stage-3 autonomy gate reads. */
export interface ShadowGateVerdict {
  /** How many graded shadow runs are in the window — the true count, even when it is below the bound. */
  readonly runsInWindow: number;
  /** Windowed runs whose `shadow.compared` outcome was `'accepted'`. */
  readonly accepted: number;
  /** Windowed runs whose `shadow.compared` outcome was `'material_change'`. */
  readonly materialChange: number;
  /** `write.suppressed` lines with `destructive: true`, summed across every windowed run's own log. */
  readonly destructive: number;
  /** True only when the window is full, the accept rate clears the bound, and no destructive write exists. */
  readonly met: boolean;
}

export interface ShadowGateOptions {
  /** `ORCH_HOME`. Defaults to the one the runtime resolves, exactly as every other reader does. */
  readonly orchHome?: string;
  /** The runs to fold, for a caller that already knows them. Defaults to every directory under `runs/`. */
  readonly runIds?: readonly string[];
  /** The rolling window size. Defaults to {@link SHADOW_GATE_WINDOW_SIZE}; settable only for a test. */
  readonly windowSize?: number;
}

type ShadowComparedOutcome = 'accepted' | 'material_change';

/** One graded shadow run: its id, in the chronological position `listRunIds` gave it, and its outcome. */
interface GradedShadowRun {
  readonly runId: string;
  /** `null` for a graded run whose comparison carried a `code` rather than settling on an outcome. */
  readonly outcome: ShadowComparedOutcome | null;
}

/**
 * Whether a run's log is graded at all, and what its last `shadow.compared` line settled on.
 *
 * The last such line wins, matching every other "a later line is a correction" fold in this codebase —
 * though in practice a run's own comparison is emitted at most once.
 */
const gradedShadowRunOf = (runId: string, events: readonly EventEnvelope[]): GradedShadowRun | null => {
  let graded = false;
  let outcome: ShadowComparedOutcome | null = null;
  for (const event of [...events].sort(compareEventOrder)) {
    if (event.type !== SHADOW_COMPARED_EVENT_TYPE) continue;
    graded = true;
    const declared = event.payload[SHADOW_COMPARED_PAYLOAD_KEYS.Outcome];
    outcome = declared === 'accepted' || declared === 'material_change' ? declared : null;
  }
  return graded ? { runId, outcome } : null;
};

/** `write.suppressed` lines with `destructive: true` in one run's log. */
const destructiveWriteCount = (events: readonly EventEnvelope[]): number =>
  events.filter(
    (event) =>
      event.type === WRITE_SUPPRESSED_EVENT_TYPE &&
      event.payload[WRITE_SUPPRESSED_PAYLOAD_KEYS.Destructive] === true,
  ).length;

/**
 * Fold every run under `runsDir` into the shadow rolling-window verdict.
 */
export const shadowGateVerdict = (options: ShadowGateOptions = {}): ShadowGateVerdict => {
  const orchHome = options.orchHome;
  const windowSize = options.windowSize ?? SHADOW_GATE_WINDOW_SIZE;
  // `listRunIds` already sorts in ULID (chronological) order, which is the order every run here is
  // walked in — so the graded list below is built in that same order and needs no re-sort of its own.
  const runIds = options.runIds ?? listRunIds(orchHome === undefined ? runsDir() : runsDir(orchHome));

  const graded: GradedShadowRun[] = [];
  const destructiveByRun = new Map<string, number>();

  for (const runId of runIds) {
    const paths = orchHome === undefined ? runPaths(runId) : runPaths(runId, orchHome);
    let events: readonly EventEnvelope[];
    try {
      events = readEventLog(paths.eventLog);
    } catch {
      // One unreadable run costs that run's own evidence, never the whole fold — `foldFleet`'s own rule.
      continue;
    }
    const run = gradedShadowRunOf(runId, events);
    if (run !== null) graded.push(run);
    destructiveByRun.set(runId, destructiveWriteCount(events));
  }

  const windowed = graded.length > windowSize ? graded.slice(graded.length - windowSize) : graded;
  const runsInWindow = windowed.length;
  const accepted = windowed.filter((run) => run.outcome === 'accepted').length;
  const materialChange = windowed.filter((run) => run.outcome === 'material_change').length;
  const destructive = windowed.reduce((total, run) => total + (destructiveByRun.get(run.runId) ?? 0), 0);

  const met =
    runsInWindow >= windowSize &&
    accepted / runsInWindow >= SHADOW_GATE_MIN_ACCEPT_RATE &&
    destructive === 0;

  return { runsInWindow, accepted, materialChange, destructive, met };
};
