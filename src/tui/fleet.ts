/**
 * Every run on this machine, folded — the input the morning brief is built from.
 *
 * `ShellView` is one run and CAP-22 wants every in-flight feature on one screen, so something has to
 * enumerate the runs and fold each one. That is all this module does: it asks the runtime which run
 * directories exist (AD-9), folds each one through the projection story 1-9 already built, and hands back
 * the list.
 *
 * **One unreadable run does not cost the others.** `loadShellView` already answers a log the reader refuses
 * with a view whose `problem` states why, rather than a throw — so applying it per run is enough for the
 * whole fleet to survive one bad log. The alternative, a fold that threw, would make one corrupt file hide
 * every other feature a person has running, which is exactly backwards: the brief is most useful on the
 * morning something has gone wrong.
 *
 * **A run id is carried and never rendered** (R6). It is needed to find the log and to write an intent
 * against a run; it is not something a person should ever have to know, so the brief reads the feature name
 * from the fold and nothing downstream is given the id to print.
 *
 * Nothing here opens a file or names a builtin module: the directory listing is `listRunIds` in
 * `src/runtime/` and reading a log is `readEventLog` behind `loadShellView`. A renderer that reached the
 * filesystem itself would be the beginning of a second read path, and eventually of a second write path
 * (AD-19) — which is why `tests/tui.projection.test.ts` greps this directory for the builtin's name and
 * finding it anywhere, comment included, is a failure.
 */
import { listRunIds, runPaths, runsDir } from '../runtime/index.js';

import { STOPPED_FEATURE_STATES } from './mode.js';
import { loadShellView } from './projection.js';
import type { ShellView } from './projection.js';

/** One run in the fleet: the view a person reads, and the id the system needs to reach it. */
export interface FleetRun {
  /** Needed to find the log and to write an intent. Never rendered (R6). */
  readonly runId: string;
  readonly view: ShellView;
  /**
   * True while this run is still something a person might steer.
   *
   * A terminal run is finished, and a run whose log records nothing at all has not started — neither is
   * "in flight", and a brief that listed both would bury the features that are. A run whose log could not
   * be read counts as in flight on purpose: the honest answer to "is this still running" is that nobody
   * knows, and the one outcome to avoid is quietly dropping it from the list.
   */
  readonly inFlight: boolean;
}

export interface FleetView {
  readonly runs: readonly FleetRun[];
  /**
   * How many run directories existed and were not read, because the fold is bounded.
   *
   * Stated rather than dropped, and for the reason every other absence in this directory is: a brief that
   * silently stopped looking would be a brief a person trusts to be complete.
   */
  readonly notRead: number;
}

/**
 * How many runs one fold reads, at most.
 *
 * The brief re-folds on every poll (`mountBrief`, once a second by default) and a fold reads and replays
 * every line of every run's `events.jsonl` — so the work per second grew without limit with the number of
 * runs a machine had ever accumulated, on the one surface a person leaves open all morning. Two hundred is
 * the spine's own threshold: "build [a SQLite query index] when … one project passes roughly two hundred
 * runs", which is the point at which scanning JSONL stops being the right mechanism at all. Until that
 * index exists, the fold stops there and says how many it did not read.
 *
 * The **most recent** are kept, because a run id is a ULID (AD-29) and therefore sorts chronologically: the
 * runs a person might still steer are the recent ones, and a run old enough to fall outside this bound and
 * still be in flight is a stale directory rather than a feature anybody is waiting on.
 */
export const MAX_FLEET_RUNS = 200;

export interface FoldFleetOptions {
  /** `ORCH_HOME`. Defaults to the one the runtime resolves, exactly as every other reader does. */
  readonly orchHome?: string;
  /** How many runs to read, most recent first. Defaults to {@link MAX_FLEET_RUNS}. */
  readonly limit?: number;
  /**
   * The runs to fold, for a caller that already knows them.
   *
   * Defaults to every directory under `runs/`. Given explicitly it is also how a suite folds three named
   * runs without depending on the order a filesystem lists them in.
   */
  readonly runIds?: readonly string[];
}

/** Whether a folded run is still something a person might steer. */
export const isRunInFlight = (view: ShellView): boolean => {
  if (view.problem !== null) return true;
  if (view.featureState === null) return false;
  return !STOPPED_FEATURE_STATES.includes(view.featureState);
};

/**
 * Fold every run under `runsDir`, in the order the run ids sort — which is chronological, because a run id
 * is a ULID (AD-29).
 */
export const foldFleet = (options: FoldFleetOptions = {}): FleetView => {
  const orchHome = options.orchHome;
  const all = options.runIds ?? listRunIds(orchHome === undefined ? runsDir() : runsDir(orchHome));
  const limit = Math.max(options.limit ?? MAX_FLEET_RUNS, 0);
  // The tail, because the ids sort chronologically and the recent ones are the ones still in flight.
  const ids = all.length > limit ? all.slice(all.length - limit) : all;
  const runs = ids.map((runId) => {
    const paths = orchHome === undefined ? runPaths(runId) : runPaths(runId, orchHome);
    const view = loadShellView(paths.eventLog);
    return { runId, view, inFlight: isRunInFlight(view) };
  });
  return { runs, notRead: all.length - ids.length };
};

/** The in-flight runs, which is what CAP-22's one screen is a screen of. */
export const inFlightRuns = (fleet: FleetView): readonly FleetRun[] =>
  fleet.runs.filter((run) => run.inFlight);

/**
 * Story 4-4 — why a run needs a person right now, per R1 ("notify only on exception, decision point, or
 * completion") and threat-model.md item 16.
 *
 * Three reasons, not a fourth: R1 names exactly these three occasions, and a run that fits none of them
 * is ordinary unattended progress, which is the case silence is for.
 */
export const ATTENTION_REASONS = ['decision_point', 'exception', 'completion'] as const;

export type AttentionReason = (typeof ATTENTION_REASONS)[number];

/** One run that needs a person, and why. */
export interface AttentionEntry {
  readonly run: FleetRun;
  readonly reason: AttentionReason;
}

/**
 * The reason one folded view needs a person, or `null` for silence.
 *
 * Order matters and mirrors `cardForView`'s own precedence:
 *
 * 1. an unreadable log (`view.problem !== null`) is `'exception'`, checked first — an unknown state is
 *    never silence, the same reasoning `isRunInFlight` already applies to the identical case;
 * 2. a pending question is `'decision_point'` regardless of `featureState`, because a person is never
 *    missed on account of the state around the question not being one of the switch's own cases;
 * 3. otherwise the feature state decides. `blocked` and `interrupted` are a decision point; `hibernated`
 *    and `handed_off` are an exception — a ceiling reached or a run giving up is news, even though
 *    `cardForView` also draws no per-run card for either (that silence is about which of the four
 *    live-run gestures still apply, not about whether the person already knows); `committed` is a
 *    completion. `killed` gets no reason: the person issued that stop themselves. Every other state —
 *    `drafting`, `confirmed`, `running`, `verifying`, `degraded`, `awaiting_merge`, and `null` — is
 *    ordinary progress or a self-resolving or externally-notified wait, and stays silent (Boundaries).
 */
const attentionReasonFor = (view: ShellView): AttentionReason | null => {
  if (view.problem !== null) return 'exception';
  if (view.question.state === 'pending') return 'decision_point';
  switch (view.featureState) {
    case 'blocked':
    case 'interrupted':
      return 'decision_point';
    case 'hibernated':
    case 'handed_off':
      return 'exception';
    case 'committed':
      return 'completion';
    default:
      return null;
  }
};

/**
 * Every run in the fleet that needs a person, and why — the fold R1 and threat-model.md item 16 exist
 * for.
 *
 * Over `fleet.runs`, not `inFlightRuns(fleet)`: `hibernated`, `handed_off` and `committed` are terminal
 * and `inFlightRuns` excludes them, but they are exactly the states this fold exists to surface. An
 * empty result reads the same whether the fleet is empty or every run in it is quiet — R1 does not
 * require distinguishing "nothing to report" from "nothing is wrong".
 */
export const runsNeedingAttention = (fleet: FleetView): readonly AttentionEntry[] =>
  fleet.runs.flatMap((run) => {
    const reason = attentionReasonFor(run.view);
    return reason === null ? [] : [{ run, reason }];
  });
