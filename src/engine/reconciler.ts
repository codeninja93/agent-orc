/**
 * AD-7 — the engine is a reconciler over on-disk state, not an in-memory supervisor.
 *
 * The loop reads the checkpoint, takes at most one next action, writes the checkpoint, and holds no
 * authoritative run state in memory. Killing it at any instant and restarting must produce identical
 * behaviour to never having stopped — which is a property of the *shape* of the loop, not of a set of
 * shutdown handlers that each have to be correct.
 *
 * Four decisions make that property hold, and each is worth stating because each is load-bearing:
 *
 * **The checkpoint is written from the log, never from memory.** After every action the loop re-reads
 * `events.jsonl`, folds it, and writes the result. So a checkpoint can never carry a fact the durable
 * truth does not, and "where they disagree the log wins" (AD-4) is structural rather than a branch
 * somebody has to remember to take.
 *
 * **An action is a step driven to termination.** Splitting "start" and "observe the outcome" across two
 * passes would mean holding an in-flight process in memory between them, which is exactly the
 * in-memory owner AD-7 forbids. So the loop starts a step, waits for the port to report a termination,
 * records it, and writes the checkpoint — one action, and the whole of it is durable before the pass
 * returns.
 *
 * **A step found in flight after a restart is adopted as `interrupted`.** That is the only honest
 * reading of the state: the engine was killed inside the step, the subprocess is gone with it, and AD-8
 * says an interruption is resumed by session id and otherwise re-run from the baseline. The adoption is
 * itself a recorded action, so it is visible in the log rather than inferred by each reader.
 *
 * **Every identifier travels in an envelope field.** Story 1-2's redaction pass replaces an unbroken
 * ULID or commit SHA wherever it appears in a payload, so the run id, the baseline ref and the session
 * id are envelope fields on the verbatim allow-list. Payloads carry only short, punctuated,
 * low-entropy values. Getting this wrong is silent: the run works and the log becomes unreadable.
 */
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  CURRENT_SCHEMA_VERSION,
  MODEL_RUNGS,
  StepInputSchema,
  featureStateFingerprint,
  findStepRecord,
  formatTimestamp,
  inFlightStep,
  isTerminalFeatureState,
  makeError,
  renderCause,
} from '../contracts/index.js';
import type {
  FeatureState,
  ModelRung,
  RunState,
  StepInput,
  StepRecord,
} from '../contracts/index.js';
import {
  REDACTION_MARKER,
  Recorder,
  readEventLog,
  resolveOrchHome,
  runPaths,
  runsDir,
} from '../runtime/index.js';
import type { RedactionPolicy, RunPaths } from '../runtime/index.js';

import { BaselineResetError, gitBaselineResetter, resetToBaseline } from './baseline.js';
import type { BaselineResetter } from './baseline.js';
import { listRunIds, readCheckpoint, sweepCheckpointTemporaries, writeCheckpoint } from './checkpoint.js';
import { routeRefusedResume, routeTermination } from './dispositions.js';
import { ResumeRefused, terminated } from './executor.js';
import type { StepExecutor, StepStartRequest, StepTermination } from './executor.js';
import {
  ENGINE_EMITTER,
  ENGINE_EVENT_TYPES,
  rebuildFromLog,
  reconcileCheckpointAgainstLog,
} from './rebuild.js';
import type { CheckpointDisagreement, FeaturePlan, PlanStep } from './rebuild.js';
import { admitByTerritory } from './territory.js';
import type { TerritoryCandidate, TerritoryDeferral } from './territory.js';
import { EngineLock } from './lock.js';
import { defaultUlidMinter } from './ulid.js';
import type { UlidMinter } from './ulid.js';

/** `runs/<run-id>/steps/` — where a step's typed input file lives. */
export const STEPS_DIR_NAME = 'steps';
export const STEP_INPUT_FILE_NAME = 'input.json';

/** A step id safe as a directory name. Step ids are stable declared names, never free text. */
const SAFE_STEP_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/**
 * A declared wall-clock allowance carried on the step input so the contract is satisfied.
 *
 * AD-24's ceilings — step count, wall clock and rate-limit budget — are story 2-9's to *enforce*, and
 * this story's Never list excludes them. The value is therefore declared and passed through, and
 * nothing here degrades, hibernates or refuses on it. Naming it rather than inlining a number is what
 * keeps that honest: when 2-9 arrives it replaces this constant, it does not discover a magic literal.
 */
export const DECLARED_WALL_CLOCK_MS = 60 * 60 * 1000;

/**
 * A run directory holding neither an event log nor a checkpoint.
 *
 * `acceptFeature` creates the directory and then appends `run.created`, so a crash in between leaves one
 * of these. It carries no run state at all — not even the feature it belongs to — so there is nothing to
 * reconcile and nothing to act on. It is named as its own condition rather than reported as a fault,
 * because a pass must step over it: letting it throw would stop every *other* feature from advancing for
 * as long as the directory exists, which is permanent.
 */
export class IncompleteRunDirectory extends Error {
  readonly code = 'config.invalid';
  readonly run: string;

  constructor(run: string) {
    super(
      `Run ${run} has a directory but neither an event log nor a checkpoint, so it carries no state ` +
        'and no feature. A crash between creating the directory and recording run.created leaves this; ' +
        'the run is skipped, never repaired.',
    );
    this.name = 'IncompleteRunDirectory';
    this.run = run;
  }
}

/**
 * A steering command refused because the run is past taking it.
 *
 * A terminal run has reached `[*]` in the lifecycle: confirming, approving or killing it would walk a
 * finished run backwards into `running`, and AD-8 is explicit that a `killed` step is never resumed and
 * never re-run. The refusal is raised rather than silently ignored so story 1-7 can render *why* a
 * control did nothing.
 */
export class SteeringRefused extends Error {
  readonly code = 'internal.invariant_violated';
  readonly run: string;
  readonly state: FeatureState;

  constructor(run: string, state: FeatureState, detail: string) {
    super(`Refusing to steer run ${run}: it is ${state}. ${detail}`);
    this.name = 'SteeringRefused';
    this.run = run;
    this.state = state;
  }
}

/**
 * An action whose event the redaction pass dropped.
 *
 * AD-21 fails closed, so a `step.started` or `step.terminated` carrying something unredactable is
 * replaced by a `redaction.failed` line — and the fold then cannot see the action at all. Proceeding
 * would leave the loop re-deciding the same action forever against a log that never records it, so the
 * action is abandoned loudly instead. The code's declared disposition is `abandon-and-hand-off`.
 */
export class UnrecordedAction extends Error {
  readonly code = 'redaction.failed';
  readonly eventType: string;

  constructor(eventType: string) {
    super(
      `The ${eventType} event was dropped by the redaction pass, so this action is not in the log. ` +
        'AD-21 fails closed and AD-4 makes the log the only truth, so an action the log cannot record ' +
        'is abandoned rather than performed unrecorded.',
    );
    this.name = 'UnrecordedAction';
    this.eventType = eventType;
  }
}

/** What the loop decided to do about one feature in one pass. */
export type ReconcileAction =
  /** Nothing to do: the feature is terminal, or a step was stopped by a steering command. */
  | { readonly kind: 'idle'; readonly reason: string }
  /** CAP-2 — no feature enters execution without user-confirmed criteria. */
  | { readonly kind: 'await-confirmation'; readonly reason: string }
  /** CAP-12 — an irreversible gate is waiting on a person. */
  | { readonly kind: 'await-approval'; readonly reason: string }
  /** A step was in flight when the engine died; record the interruption it actually suffered. */
  | { readonly kind: 'adopt-orphan'; readonly step: string; readonly reason: string }
  /** Start a step, from its typed input file, and record how it terminated. */
  | {
      readonly kind: 'run-step';
      readonly step: PlanStep;
      readonly transitionTo: FeatureState;
      readonly reason: string;
    }
  /** AD-8 — resume by the recorded session id. */
  | {
      readonly kind: 'resume-step';
      readonly step: string;
      readonly sessionId: string;
      readonly transitionTo: FeatureState;
      readonly reason: string;
    }
  /** AD-26 — reset the worktree to the step's `baseline_ref`, then re-run from the typed input. */
  | {
      readonly kind: 'reset-and-rerun';
      readonly step: string;
      readonly promoteTo: ModelRung | null;
      readonly transitionTo: FeatureState;
      readonly reason: string;
    }
  /** A lifecycle transition with no step attached, e.g. every step done so the run is committed. */
  | { readonly kind: 'advance-state'; readonly to: FeatureState; readonly reason: string }
  /** AD-35 — a condition no retrying resolves but a person can. */
  | { readonly kind: 'escalate-to-human'; readonly step: string | null; readonly reason: string }
  /** CAP-23 — stop and explain rather than thrash. */
  | {
      readonly kind: 'hand-off';
      readonly step: string | null;
      readonly code: string;
      readonly reason: string;
    };

export type ReconcileActionKind = ReconcileAction['kind'];

/** The action kinds that append nothing to the log, and so advance nothing. */
export const INERT_ACTION_KINDS: readonly ReconcileActionKind[] = [
  'idle',
  'await-confirmation',
  'await-approval',
];

export const isInertAction = (kind: ReconcileActionKind): boolean =>
  INERT_ACTION_KINDS.includes(kind);

/** What one feature's single action did, as the pass reports it. */
export interface PassAction {
  readonly run: string;
  readonly feature: string;
  readonly kind: ReconcileActionKind;
  readonly step: string | null;
  readonly from: FeatureState;
  readonly to: FeatureState;
  readonly reason: string;
  /** True when a checkpoint on disk disagreed with the log and was discarded in its favour. */
  readonly checkpointRebuilt: boolean;
  readonly disagreements: readonly CheckpointDisagreement[];
}

/**
 * A run this pass could not read or could not advance, reported rather than thrown.
 *
 * AD-28's refusal and AD-4's corrupt-log refusal are both *per artifact*: the rule is "never continue a
 * run whose log the reader refuses", not "never continue". One unreadable run must not stop every
 * unrelated feature, so a refusal is collected against its own run id and the pass carries on.
 */
export interface RunRefusal {
  readonly run: string;
  readonly code: string;
  readonly reason: string;
}

export interface PassResult {
  /** One entry per feature the pass touched, each having taken at most one action. */
  readonly actions: readonly PassAction[];
  /** Features held back this pass because another holds an overlapping territory. */
  readonly deferred: readonly TerritoryDeferral[];
  /** Runs this pass refused to read or could not advance. Every other run still advanced. */
  readonly refusals: readonly RunRefusal[];
}

/** What one `load` established: the paths, the declared plan, and the state the log folds to. */
export interface LoadedState {
  readonly paths: RunPaths;
  readonly plan: FeaturePlan;
  readonly state: RunState;
  readonly disagreements: readonly CheckpointDisagreement[];
  readonly checkpointRebuilt: boolean;
}

/** One run and the state a pass loaded for it, threaded rather than folded twice. */
interface LoadedRun {
  readonly run: string;
  readonly loaded: LoadedState;
}

/** Render a thrown value as a per-run refusal, taking its declared code when it has one. */
const refusalFor = (run: string, thrown: unknown): RunRefusal => {
  const code = (thrown as { code?: unknown } | null)?.code;
  return {
    run,
    code: typeof code === 'string' ? code : 'internal.invariant_violated',
    reason: renderCause(thrown) ?? 'the run could not be read or advanced, and said nothing about why',
  };
};

/**
 * A port rejection, rendered as the termination it stands in for.
 *
 * A thrown value carrying a declared `code` is dispositioned by that code — `step.spawn_failed` retries.
 * Anything else gets `internal.invariant_violated`, whose declared disposition is abandon-and-hand-off:
 * a failure the port never declared is not one to retry into.
 */
const terminationFromThrown = (step: string, thrown: unknown): StepTermination => {
  const code = (thrown as { code?: unknown } | null)?.code;
  const rendered = renderCause(thrown) ?? 'the executor rejected without a reason';
  return terminated(step, 'failed', {
    error: makeError(
      typeof code === 'string' ? code : 'internal.invariant_violated',
      `the executor rejected step "${step}": ${rendered}`,
      rendered,
    ),
  });
};

/**
 * The step whose failure blocked the run, found by the table that blocked it.
 *
 * Not "the last step": a completed step sitting last would be rewritten into an `interrupted` one and
 * re-run, and a `killed` step would be resurrected — breaking the AD-8 invariant this story states twice.
 * Asking the disposition table which record routes to `escalate-to-human` cannot pick either, because
 * neither disposition routes there.
 */
const blockedStep = (state: RunState): StepRecord | null =>
  [...state.steps]
    .reverse()
    .find(
      (record) =>
        record.disposition !== null &&
        record.disposition !== 'completed' &&
        record.disposition !== 'killed' &&
        routeTermination({
          step: record.step,
          disposition: record.disposition,
          sessionId: record.session_id,
          error: record.error,
          modelTier: record.model_tier,
          promotions: record.promotions,
        }).action === 'escalate-to-human',
    ) ?? null;

/** Supplies a feature's declared configuration. Re-supplied after a restart, never folded from the log. */
export type FeaturePlanProvider = (feature: string) => FeaturePlan;

/**
 * A durable boundary the loop just crossed: either a line landed in the log, or a checkpoint landed on
 * disk. Every one of them is a point a crash-injection suite must be able to kill at.
 *
 * Declared surface, not a test hook bolted on: AD-31 requires killing the loop at *every* state
 * transition, and a suite cannot do that unless the loop says where its transitions are. The labels are
 * `event-appended:<type>` and `checkpoint-written:<state>`.
 */
export type DurableBoundaryObserver = (label: string) => void;

export interface ReconcilerOptions {
  /** `ORCH_HOME`; defaults to the AD-9 resolution. */
  readonly orchHome?: string;
  /** The port story 1-4 implements. This story drives a double. */
  readonly executor: StepExecutor;
  /** A feature's declared plan, territory and mode. */
  readonly plans: FeaturePlanProvider;
  /** AD-26 — how a worktree is read and reset. Defaults to real `git`. */
  readonly baseline?: BaselineResetter;
  /** Injectable clock. */
  readonly now?: () => Date;
  /** AD-29 — the run-id minter. Defaults to a fresh monotonic one per reconciler. */
  readonly minter?: UlidMinter;
  /** AD-31 — where the loop's durable boundaries are, so a suite can kill at each in turn. */
  readonly onDurableBoundary?: DurableBoundaryObserver;
  /**
   * AD-21 — the redaction policy the run's recorder applies, including the literal values of the
   * credentials injected into this run's tool servers.
   *
   * The engine is the unit that knows which credentials a run was given, so it is the unit that can
   * register them. Passed through to the recorder rather than reimplemented: one pass, one policy.
   */
  readonly redaction?: RedactionPolicy;
  /** Skip the AD-30 lock. Only for a caller that already holds it; never in production. */
  readonly lock?: EngineLock | null;
}

/** What accepting a feature produced. */
export interface AcceptedFeature {
  /** The minted run id: a 26-character Crockford base32 ULID (AD-29). */
  readonly run: string;
  readonly state: RunState;
}

/**
 * The reconciler.
 *
 * One per `ORCH_HOME`, holding the AD-30 lock for its lifetime. Every method that changes anything goes
 * through the same three motions — fold the log, act once, write the checkpoint from the log again —
 * so there is no path that advances a run without leaving the durable truth able to reproduce it.
 */
export class Reconciler {
  readonly orchHome: string;

  private readonly executor: StepExecutor;
  private readonly plans: FeaturePlanProvider;
  private readonly baseline: BaselineResetter;
  private readonly now: () => Date;
  private readonly minter: UlidMinter;
  private readonly boundaryObserver: DurableBoundaryObserver | null;
  private readonly redaction: RedactionPolicy;
  private readonly engineLock: EngineLock | null;
  private readonly ownsLock: boolean;
  /** Open recorders, keyed by run id. An I/O handle, not run state: nothing is read back from it. */
  private readonly recorders = new Map<string, Recorder>();
  private closed = false;

  private constructor(options: ReconcilerOptions, lock: EngineLock | null, ownsLock: boolean) {
    this.orchHome = options.orchHome ?? resolveOrchHome();
    this.executor = options.executor;
    this.plans = options.plans;
    this.baseline = options.baseline ?? gitBaselineResetter;
    this.now = options.now ?? ((): Date => new Date());
    // AD-29 makes monotonicity a property *per process*, so the process-wide minter is the default:
    // a fresh minter per reconciler could mint two ids in one millisecond that do not order against
    // each other, and the territory tie-break reads that order as "which run is older".
    this.minter = options.minter ?? defaultUlidMinter;
    this.boundaryObserver = options.onDurableBoundary ?? null;
    this.redaction = options.redaction ?? {};
    this.engineLock = lock;
    this.ownsLock = ownsLock;
  }

  /**
   * Start an engine: claim the `ORCH_HOME` lock, or refuse naming the holder.
   *
   * The lock is taken before anything is read, so a second engine never gets as far as opening a log
   * the first one is appending to.
   */
  static open(options: ReconcilerOptions): Reconciler {
    if (options.lock !== undefined && options.lock !== null) {
      return new Reconciler(options, options.lock, false);
    }
    const lock = EngineLock.acquire(
      options.orchHome === undefined ? {} : { orchHome: options.orchHome },
    );
    return new Reconciler(options, lock, true);
  }

  get lock(): EngineLock | null {
    return this.engineLock;
  }

  /** Release the lock and every recorder claim. The log itself is never rewritten. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const recorder of this.recorders.values()) recorder.close();
    this.recorders.clear();
    if (this.ownsLock) this.engineLock?.release();
  }

  // ---------------------------------------------------------------------------------------------
  // Accepting and steering a feature
  // ---------------------------------------------------------------------------------------------

  /**
   * Accept a feature request: mint a run id and record the run at `drafting`.
   *
   * The id is minted here and nowhere else (AD-29). No step runs until the criteria are confirmed
   * (CAP-2), which is why the initial state is `drafting` rather than `running`.
   */
  acceptFeature(plan: FeaturePlan): AcceptedFeature {
    this.assertOpen();
    const run = this.minter.mint();
    const paths = runPaths(run, this.orchHome);
    mkdirSync(paths.runDir, { recursive: true });

    const recorder = this.recorderFor(run, plan.feature);
    this.emit(recorder, {
      step: null,
      type: ENGINE_EVENT_TYPES.RunCreated,
      payload: { mode: plan.mode, step_count: plan.steps.length },
    });

    return { run, state: this.checkpointFromLog(paths, plan) };
  }

  /**
   * CAP-2 — the user confirmed the acceptance criteria, so the feature may enter execution.
   *
   * Story 1-7 supplies this from a durable command intent file under `runs/<run-id>/commands/`; until
   * then it is a method, because the loop needs *some* declared way out of `drafting` and inventing the
   * intent-file format here would pre-empt that story.
   */
  confirm(run: string): RunState {
    return this.transition(run, 'confirmed', 'the user confirmed the acceptance criteria (CAP-2)');
  }

  /**
   * CAP-12 — a person approved the gate the feature blocked at, so it may continue.
   *
   * Two facts are recorded, and the second is what makes this a continuation rather than a loop back
   * into the same escalation: the feature returns to `running`, *and* the blocked step's error is
   * spent. Without the second, the next pass would read the same `permission.denied` off the same
   * termination and block again on the thing a person has just answered.
   */
  approve(run: string, reason = 'a person approved the gate the feature blocked at'): RunState {
    this.assertOpen();
    const { paths, plan, state } = this.load(run);
    this.assertSteerable(state, 'There is no gate left to approve.');

    const recorder = this.recorderFor(run, state.feature);
    const blocked = blockedStep(state);

    if (blocked !== null) {
      this.emit(recorder, {
        step: blocked.step,
        type: ENGINE_EVENT_TYPES.StepApproved,
        payload: { reason, approved_code: blocked.error?.code ?? null },
        baselineRef: blocked.baseline_ref,
      });
    }
    this.emit(recorder, {
      step: blocked?.step ?? null,
      type: ENGINE_EVENT_TYPES.FeatureStateChanged,
      payload: { from: state.state, to: 'running', reason },
    });
    return this.checkpointFromLog(paths, plan);
  }

  /**
   * AD-8 — a steering command terminated the step, which records `killed`.
   *
   * A killed step is never resumed and never re-run. Both halves of that are enforced: the termination
   * records `killed`, which `routeTermination` answers with `stop`, and the feature enters the terminal
   * `killed` state, which every later pass answers with `idle`. Either alone would be enough; a
   * recovery loop silently undoing the kill control is the failure AD-8 exists to prevent, so it is
   * closed twice.
   */
  kill(run: string, reason = 'a steering command terminated the run (CAP-5, CAP-15)'): RunState {
    this.assertOpen();
    const { paths, plan, state } = this.load(run);
    this.assertSteerable(state, 'There is nothing left running to kill.');

    const recorder = this.recorderFor(run, state.feature);

    /**
     * Only a step actually in flight is terminated.
     *
     * A kill normally arrives in the gap *between* passes, when no step is running — and the last record
     * is then a step that has already finished. Rewriting that record as `killed` would put a permanent
     * line in the log saying work that was done never happened, and because a killed step is never
     * re-run, nothing would ever put it back. The feature still stops; no finished step is falsified.
     */
    const target = inFlightStep(state);

    if (target !== null) {
      this.emit(recorder, {
        step: target.step,
        type: ENGINE_EVENT_TYPES.StepTerminated,
        payload: { disposition: 'killed', reason },
        sessionId: target.session_id,
        baselineRef: target.baseline_ref,
      });
    }
    this.emit(recorder, {
      step: target?.step ?? null,
      type: ENGINE_EVENT_TYPES.FeatureStateChanged,
      payload: { from: state.state, to: 'killed', reason },
    });
    return this.checkpointFromLog(paths, plan);
  }

  // ---------------------------------------------------------------------------------------------
  // Reading state
  // ---------------------------------------------------------------------------------------------

  /**
   * Read a run's state: fold the log, compare the checkpoint against it, and let the log win.
   *
   * The comparison's *result* never decides anything — the folded state is returned either way. It is
   * reported so a disagreement is visible, not so a caller can choose.
   */
  load(run: string): LoadedState {
    const paths = runPaths(run, this.orchHome);
    sweepCheckpointTemporaries(paths);
    const events = readEventLog(paths.eventLog);
    // An unrecognised `schema_version` throws out of here, per AD-28: this build does not operate on a
    // state file it cannot read, and rebuilding over it would destroy the evidence of who wrote it.
    // Read once and passed on, because a fold is already the expensive part of a pass.
    const onDisk = readCheckpoint(paths);
    const plan = this.planFor(paths, events, onDisk.state);
    const rebuilt = rebuildFromLog(events, { run, plan, now: this.now });
    const reconciled = reconcileCheckpointAgainstLog(onDisk.state, rebuilt);
    return {
      paths,
      plan,
      state: reconciled.state,
      disagreements: reconciled.disagreements,
      checkpointRebuilt: onDisk.state === null || reconciled.checkpointDiscarded,
    };
  }

  /** The lifecycle-significant identity of a run, which is what AD-7's claim is about. */
  fingerprint(run: string): string {
    return featureStateFingerprint(this.load(run).state);
  }

  /** Every run id under `ORCH_HOME/runs/`, in ULID order. */
  runIds(): readonly string[] {
    return listRunIds(runsDir(this.orchHome));
  }

  // ---------------------------------------------------------------------------------------------
  // The loop
  // ---------------------------------------------------------------------------------------------

  /**
   * One pass over every run.
   *
   * Concurrent across features, serialised across any two whose declared territories overlap. Each
   * admitted feature takes at most one action, and its checkpoint is written before the pass returns.
   *
   * A pass also leaves *no* run's checkpoint disagreeing with its log, including the runs it does not
   * act on. That second job is not tidiness. A terminal run is never advanced again, so if a crash left
   * its checkpoint naming a state the log has since left behind — killed between the final
   * `feature.state_changed` and the checkpoint write — nothing else would ever reconcile it, and
   * `state.json` would answer `verifying` for a committed run for good. AD-4 lets the log win, but a
   * derived file that stays wrong forever is the two-authorities divergence AD-4 exists to prevent,
   * surviving precisely because the run was finished.
   */
  async pass(): Promise<PassResult> {
    this.assertOpen();

    const entries: LoadedRun[] = [];
    const refusals: RunRefusal[] = [];

    for (const run of this.runIds()) {
      try {
        entries.push({ run, loaded: this.load(run) });
      } catch (thrown: unknown) {
        // A directory with neither log nor checkpoint carries no state to reconcile and no feature to
        // name, so it is stepped over silently rather than reported as a fault every pass forever.
        if (thrown instanceof IncompleteRunDirectory) continue;
        refusals.push(refusalFor(run, thrown));
      }
    }

    /**
     * Only a feature with real work to do contends for a territory.
     *
     * An inert action — awaiting confirmation, awaiting a person, or a terminal run — performs no worktree
     * I/O, so it cannot conflict with anything. Letting it contend would mean a feature parked in
     * `drafting` held its whole territory for as long as the user took to confirm, and every overlapping
     * feature was deferred behind it indefinitely. Inert runs are still *reported*, so a reader can see
     * what each is waiting for; they simply hold nothing while they wait.
     */
    const decided = entries
      .filter((entry) => !isTerminalFeatureState(entry.loaded.state.state))
      .map((entry) => ({ ...entry, action: decideAction(entry.loaded.state, entry.loaded.plan) }));
    const inert = decided.filter((entry) => isInertAction(entry.action.kind));
    const contending = decided.filter((entry) => !isInertAction(entry.action.kind));

    const { admitted, deferred } = admitByTerritory(
      contending.map(
        (entry): TerritoryCandidate => ({
          run: entry.run,
          feature: entry.loaded.state.feature,
          territory: entry.loaded.state.territory,
          worktree: entry.loaded.plan.worktree,
        }),
      ),
    );
    const admittedRuns = new Set(admitted.map((candidate) => candidate.run));

    const acting = [...inert, ...contending.filter((entry) => admittedRuns.has(entry.run))];
    const actingRuns = new Set(acting.map((entry) => entry.run));

    // The runs this pass will not act on: terminal ones, and ones serialised behind an overlapping
    // territory. An acting run's checkpoint is written by `advance`, so writing it here too would double
    // the work and hide the rebuild from the action it is reported on.
    for (const entry of entries) {
      if (!actingRuns.has(entry.run) && entry.loaded.checkpointRebuilt) {
        this.writeCheckpoint(entry.loaded.paths, entry.loaded.state);
      }
    }

    /**
     * `allSettled`, for the same reason the load loop catches per run: one feature whose action fails must
     * not discard the actions of every feature that succeeded in the same pass. A rejection is reported
     * against its own run and the rest of the pass stands.
     */
    const settled = await Promise.allSettled(
      // The entry is threaded through rather than re-loaded: `advance` would otherwise fold the log a
      // second time, and a fold is the expensive part of a pass.
      acting.map((entry) => this.advance(entry.run, entry.loaded)),
    );

    const actions: PassAction[] = [];
    for (const [index, outcome] of settled.entries()) {
      const run = acting[index]?.run ?? '(unknown)';
      if (outcome.status === 'fulfilled') actions.push(outcome.value);
      else refusals.push(refusalFor(run, outcome.reason));
    }

    return { actions, deferred, refusals };
  }

  /**
   * Advance one feature by at most one action.
   *
   * The whole of the action is durable before this returns: the events it appended are in the log, and
   * the checkpoint has been rebuilt from that log. A crash at any point inside leaves a state the next
   * call converges from.
   */
  async advance(run: string, preloaded?: LoadedState): Promise<PassAction> {
    this.assertOpen();
    const loaded = preloaded ?? this.load(run);
    const { paths, plan } = loaded;
    let state = loaded.state;

    // A checkpoint that disagreed with the log is discarded and rebuilt *before* anything is decided,
    // so no action is ever chosen from a state the durable truth does not support.
    if (loaded.checkpointRebuilt) state = this.writeCheckpoint(paths, state);

    const action = decideAction(state, plan);
    const from = state.state;

    if (isInertAction(action.kind)) {
      // Nothing is appended, so nothing is rebuilt. The checkpoint is still written, so a reader always
      // finds one after a pass even for a run that had no work.
      const settled = this.writeCheckpoint(paths, state);
      return this.report(run, settled, action, from, null, loaded);
    }

    const step = await this.perform(paths, plan, state, action);
    const settled = this.checkpointFromLog(paths, plan);
    return this.report(run, settled, action, from, step, loaded);
  }

  /**
   * Drive the loop until nothing is left to do.
   *
   * This is what an uninterrupted run is, and the crash-injection suite needs one to compare against:
   * "converges on the same state as an uninterrupted run" is not assertable without knowing what that
   * run produces. `maxPasses` is a test-harness bound, not an AD-24 ceiling — it exists so a bug that
   * makes the loop fail to converge shows up as a bounded failure rather than as a hang.
   */
  async runUntilSettled(maxPasses = 200): Promise<readonly PassAction[]> {
    const taken: PassAction[] = [];
    for (let index = 0; index < maxPasses; index += 1) {
      const result = await this.pass();
      const effective = result.actions.filter((action) => !isInertAction(action.kind));
      taken.push(...result.actions);
      if (effective.length === 0) return taken;
    }
    throw new Error(
      `The loop took ${String(maxPasses)} passes without settling, which means an action is not ` +
        'advancing the state it claims to advance.',
    );
  }

  // ---------------------------------------------------------------------------------------------
  // Performing one action
  // ---------------------------------------------------------------------------------------------

  private async perform(
    paths: RunPaths,
    plan: FeaturePlan,
    state: RunState,
    action: ReconcileAction,
  ): Promise<string | null> {
    const recorder = this.recorderFor(state.run, state.feature);

    switch (action.kind) {
      case 'adopt-orphan': {
        const record = findStepRecord(state, action.step);
        // The engine was killed inside this step, so the subprocess is gone with it. Recording the
        // interruption it actually suffered is what lets the next pass reach AD-8's resume rule.
        this.emit(recorder, {
          step: action.step,
          type: ENGINE_EVENT_TYPES.StepTerminated,
          payload: { disposition: 'interrupted', reason: action.reason },
          sessionId: record?.session_id ?? null,
          baselineRef: record?.baseline_ref ?? null,
        });
        this.emit(recorder, {
          step: action.step,
          type: ENGINE_EVENT_TYPES.FeatureStateChanged,
          payload: { from: state.state, to: 'interrupted', reason: 'the engine was killed mid-step' },
        });
        return action.step;
      }

      case 'run-step': {
        await this.driveStep(paths, plan, state, {
          step: action.step,
          transitionTo: action.transitionTo,
          promoteTo: null,
          reset: false,
        });
        return action.step.step;
      }

      case 'reset-and-rerun': {
        const planStep = this.planStepFor(plan, action.step);
        await this.driveStep(paths, plan, state, {
          step: planStep,
          transitionTo: action.transitionTo,
          promoteTo: action.promoteTo,
          reset: true,
        });
        return action.step;
      }

      case 'resume-step': {
        const record = this.requireStepRecord(state, action.step);
        const planStep = this.planStepFor(plan, action.step);
        const request = this.startRequest(paths, plan, state, planStep, record, record.model_tier);

        this.emit(recorder, {
          step: action.step,
          type: ENGINE_EVENT_TYPES.StepResumeAttempted,
          payload: { attempt: record.attempts },
          sessionId: action.sessionId,
          baselineRef: record.baseline_ref,
        });

        let termination: StepTermination;
        try {
          termination = await this.executor.resume({ ...request, sessionId: action.sessionId });
        } catch (thrown: unknown) {
          if (!(thrown instanceof ResumeRefused)) throw thrown;
          // AD-8 — the recorded id is spent. Recording that fact is the whole action: the next pass
          // sees an `interrupted` step with no session id and reaches the reset-and-re-run on its own,
          // so the fallback lives in one place rather than being duplicated here.
          this.emit(recorder, {
            step: action.step,
            type: ENGINE_EVENT_TYPES.StepResumeRefused,
            payload: {
              code: thrown.code,
              reason: routeRefusedResume(action.step).reason,
            },
            baselineRef: record.baseline_ref,
          });
          return action.step;
        }

        this.recordTermination(state, planStep, record.baseline_ref, termination, {
          transitionTo: action.transitionTo,
        });
        return action.step;
      }

      case 'advance-state': {
        this.emit(recorder, {
          step: null,
          type: ENGINE_EVENT_TYPES.FeatureStateChanged,
          payload: { from: state.state, to: action.to, reason: action.reason },
        });
        return null;
      }

      case 'escalate-to-human': {
        this.emit(recorder, {
          step: action.step,
          type: ENGINE_EVENT_TYPES.FeatureStateChanged,
          payload: { from: state.state, to: 'blocked', reason: action.reason },
        });
        return action.step;
      }

      case 'hand-off': {
        this.handOff(state, action.step, action.code, action.reason);
        return action.step;
      }

      case 'idle':
      case 'await-confirmation':
      case 'await-approval':
        return null;
    }
  }

  /**
   * Start or re-run a step and record how it terminated.
   *
   * The order is fixed and every part of it matters:
   *
   * 1. the lifecycle transition, if the feature is entering a new state;
   * 2. the promotion, if one is being spent, so the rung the attempt ran on is in the log *before* the
   *    attempt;
   * 3. the baseline reset, for a re-run, because a re-run that ran first and reset after would have
   *    doubled the previous attempt's effects — which is the whole thing AD-26 prevents;
   * 4. `step.started`, carrying the baseline ref on the envelope;
   * 5. the port call, with the session id recorded the moment it is reported;
   * 6. `step.terminated`, carrying the disposition.
   */
  private async driveStep(
    paths: RunPaths,
    plan: FeaturePlan,
    state: RunState,
    options: {
      readonly step: PlanStep;
      readonly transitionTo: FeatureState;
      readonly promoteTo: ModelRung | null;
      readonly reset: boolean;
    },
  ): Promise<void> {
    const recorder = this.recorderFor(state.run, state.feature);
    const existing = findStepRecord(state, options.step.step);

    if (state.state !== options.transitionTo) {
      this.emit(recorder, {
        step: options.step.step,
        type: ENGINE_EVENT_TYPES.FeatureStateChanged,
        payload: {
          from: state.state,
          to: options.transitionTo,
          reason: `step "${options.step.step}" is the ${options.step.phase} step to run next`,
        },
      });
    }

    let tier: ModelRung = options.promoteTo ?? existing?.model_tier ?? plan.starting_model_tier;
    if (options.promoteTo !== null) {
      this.emit(recorder, {
        step: options.step.step,
        type: ENGINE_EVENT_TYPES.StepTierPromoted,
        payload: {
          from: existing?.model_tier ?? plan.starting_model_tier,
          to: options.promoteTo,
          ladder: MODEL_RUNGS.join('>'),
        },
      });
      tier = options.promoteTo;
    }

    /**
     * AD-26 — the ref a re-run resets to is the one the *first* attempt recorded, so it is read from
     * the existing record and never re-read from the worktree. Re-reading it would make each re-run
     * record whatever the previous attempt left behind, and the identical-effect guarantee would decay
     * one attempt at a time.
     */
    const baselineRef =
      existing !== null && existing.baseline_ref !== ''
        ? existing.baseline_ref
        : this.baseline.currentRef(plan.worktree);

    if (options.reset) {
      try {
        resetToBaseline(plan.worktree, baselineRef, this.baseline);
      } catch (thrown: unknown) {
        if (!(thrown instanceof BaselineResetError)) throw thrown;
        /**
         * AD-26 makes the reset the *precondition* of a re-run, and `git.baseline_reset_failed` is
         * declared `abandon-and-hand-off` for exactly this reason: a worktree that cannot be returned to
         * a known commit is the half-mutated state a re-run must never start from. So the failure routes
         * through the table like any other rather than escaping the pass — which would abandon the run
         * with no recorded reason and take every other feature's pass down with it.
         */
        this.handOff(state, options.step.step, thrown.orchError.code, thrown.orchError.message);
        return;
      }
      this.emit(recorder, {
        step: options.step.step,
        type: ENGINE_EVENT_TYPES.StepBaselineReset,
        payload: { reason: 'a re-run resets the worktree to the step baseline first (AD-26)' },
        baselineRef,
      });
    }

    const input = this.stepInput(paths, plan, state, options.step, baselineRef);
    const attempt = (existing?.attempts ?? 0) + 1;

    this.emit(recorder, {
      step: options.step.step,
      type: ENGINE_EVENT_TYPES.StepStarted,
      payload: {
        attempt,
        phase: options.step.phase,
        contract_id: options.step.contract_id,
        model_tier: tier,
        mode: plan.mode,
        input: input.relativePath,
      },
      baselineRef,
    });

    const request = this.startRequest(
      paths,
      plan,
      state,
      options.step,
      { baseline_ref: baselineRef, attempts: attempt },
      tier,
      input.value,
    );

    /**
     * A rejection from the port is a termination, not an escape.
     *
     * `step.started` is already in the log at this point. If the rejection propagated, the pass would die
     * with the step recorded as in flight, and the next pass would adopt it as `interrupted`, re-run it
     * and fail identically — a non-terminating loop built out of a code the AD-35 table has a perfectly
     * good answer for. Recording the termination lets the table answer it: `step.spawn_failed` retries,
     * an undeclared code hands off.
     */
    let termination: StepTermination;
    try {
      termination = await this.executor.start(request);
    } catch (thrown: unknown) {
      termination = terminationFromThrown(options.step.step, thrown);
    }
    this.recordTermination(state, options.step, baselineRef, termination, {
      transitionTo: options.transitionTo,
    });
  }

  /** CAP-23 — stop and explain, as its own two recorded facts, so every caller hands off identically. */
  private handOff(state: RunState, step: string | null, code: string, reason: string): void {
    const recorder = this.recorderFor(state.run, state.feature);
    this.emit(recorder, {
      step,
      type: ENGINE_EVENT_TYPES.HandoffRecorded,
      payload: { code, reason },
    });
    this.emit(recorder, {
      step,
      type: ENGINE_EVENT_TYPES.FeatureStateChanged,
      payload: { from: state.state, to: 'handed_off', reason },
    });
  }

  /**
   * Append the termination, and the lifecycle transition the termination itself implies.
   *
   * Only `interrupted` implies one here, and the diagram says why: `running → interrupted` is the arrow
   * an engine kill, a crash or a closed laptop takes, and the run is *in* that state the moment the step
   * reports it — not later, when a pass gets round to routing it. `failed` and `blocked` imply nothing
   * yet: what they mean is the AD-35 table's answer, which the next pass reads.
   */
  private recordTermination(
    state: RunState,
    step: PlanStep,
    baselineRef: string,
    termination: StepTermination,
    context: { readonly transitionTo: FeatureState },
  ): void {
    const recorder = this.recorderFor(state.run, state.feature);
    this.emit(recorder, {
      step: step.step,
      type: ENGINE_EVENT_TYPES.StepTerminated,
      payload: {
        disposition: termination.disposition,
        ...(termination.error === null ? {} : { error: termination.error }),
      },
      sessionId: termination.sessionId,
      baselineRef,
    });

    if (termination.disposition === 'interrupted' && context.transitionTo !== 'interrupted') {
      this.emit(recorder, {
        step: step.step,
        type: ENGINE_EVENT_TYPES.FeatureStateChanged,
        payload: {
          from: context.transitionTo,
          to: 'interrupted',
          reason: `step "${step.step}" reported an interruption, which is the one resumable disposition`,
        },
      });
    }
  }

  /** Build the port's request. Nothing here spawns: that is story 1-4's whole subject. */
  private startRequest(
    paths: RunPaths,
    plan: FeaturePlan,
    state: RunState,
    step: PlanStep,
    record: Pick<StepRecord, 'baseline_ref' | 'attempts'>,
    tier: ModelRung,
    prepared?: StepInput,
  ): StepStartRequest {
    const input = prepared ?? this.stepInput(paths, plan, state, step, record.baseline_ref).value;
    const recorder = this.recorderFor(state.run, state.feature);
    return {
      run: state.run,
      feature: state.feature,
      step: step.step,
      phase: step.phase,
      contractId: step.contract_id,
      input,
      inputPath: stepInputPath(paths, step.step),
      baselineRef: record.baseline_ref,
      worktree: plan.worktree,
      modelTier: tier,
      attempt: record.attempts,
      mode: plan.mode,
      /**
       * AD-8 — the session id is recorded the moment the subprocess reports it, not when the step
       * ends. A crash between the spawn and the termination is exactly the case a resume exists for,
       * and a session id that only landed at the end would be missing in precisely that case.
       */
      onSessionId: (sessionId: string): void => {
        this.emit(recorder, {
          step: step.step,
          type: ENGINE_EVENT_TYPES.StepSessionRecorded,
          payload: { attempt: record.attempts },
          sessionId,
          baselineRef: record.baseline_ref,
        });
      },
    };
  }

  // ---------------------------------------------------------------------------------------------
  // The typed input file
  // ---------------------------------------------------------------------------------------------

  /**
   * The step's typed input file, written once and reused by every re-run.
   *
   * "Re-run the step from its typed input file" (AD-8, CAP-6) is only true if the file does not change
   * between attempts, so an existing one is read back rather than regenerated. The one thing that is
   * checked is the baseline ref: an input file naming a different commit than the record would make the
   * reset and the re-run disagree about what the step started from.
   */
  private stepInput(
    paths: RunPaths,
    plan: FeaturePlan,
    state: RunState,
    step: PlanStep,
    baselineRef: string,
  ): { readonly value: StepInput; readonly relativePath: string } {
    const path = stepInputPath(paths, step.step);
    const relativePath = `${STEPS_DIR_NAME}/${step.step}/${STEP_INPUT_FILE_NAME}`;

    if (existsSync(path)) {
      const parsed = StepInputSchema.safeParse(JSON.parse(readFileSync(path, 'utf8')));
      if (parsed.success && parsed.data.baseline_ref === baselineRef) {
        return { value: parsed.data, relativePath };
      }
      // An input that does not parse, or names another baseline, is not this step's input. It is
      // rewritten rather than trusted: a re-run from the wrong input is worse than a re-run from a
      // regenerated one.
    }

    const completed = state.steps.filter((record) => record.disposition === 'completed').length;
    const value: StepInput = {
      schema_version: CURRENT_SCHEMA_VERSION,
      contract_id: step.contract_id,
      run: state.run,
      feature: state.feature,
      step: step.step,
      mode: plan.mode,
      baseline_ref: baselineRef,
      request: plan.request,
      acceptance_criteria: [...plan.acceptance_criteria],
      // Story 1-8 supplies the ledger answers; an empty list is the honest value until it does.
      decisions: [],
      // AD-23 — evidence is referenced by pointer. Nothing this story runs produces one yet.
      evidence: [],
      budget: {
        steps_remaining: Math.max(plan.steps.length - completed, 0),
        wall_clock_ms_remaining: DECLARED_WALL_CLOCK_MS,
        rate_limit_budget_consumed: 0,
      },
      created_at: formatTimestamp(this.now()),
    };

    const validated = StepInputSchema.parse(value);
    mkdirSync(join(paths.runDir, STEPS_DIR_NAME, step.step), { recursive: true });
    writeFileSync(path, `${JSON.stringify(validated, null, 2)}\n`, 'utf8');
    return { value: validated, relativePath };
  }

  // ---------------------------------------------------------------------------------------------
  // Plumbing
  // ---------------------------------------------------------------------------------------------

  /** A terminal run takes no steering command: it has reached `[*]` and nothing walks it back. */
  private assertSteerable(state: RunState, detail: string): void {
    if (isTerminalFeatureState(state.state)) {
      throw new SteeringRefused(state.run, state.state, detail);
    }
  }

  private transition(run: string, to: FeatureState, reason: string): RunState {
    this.assertOpen();
    const { paths, plan, state } = this.load(run);
    this.assertSteerable(state, `It cannot be moved to ${to}.`);
    const recorder = this.recorderFor(run, state.feature);
    this.emit(recorder, {
      step: null,
      type: ENGINE_EVENT_TYPES.FeatureStateChanged,
      payload: { from: state.state, to, reason },
    });
    return this.checkpointFromLog(paths, plan);
  }

  /**
   * Emit one event through the recorder.
   *
   * The engine never opens `events.jsonl` (AD-29). Identifiers go in envelope fields — `run`, `step`,
   * `session_id`, `baseline_ref` — never in the payload, where the AD-21 pass would replace them.
   */
  private emit(
    recorder: Recorder,
    event: {
      readonly step: string | null;
      readonly type: string;
      readonly payload: Record<string, unknown>;
      readonly sessionId?: string | null;
      readonly baselineRef?: string | null;
    },
  ): void {
    const recorded = recorder.recordResult({
      feature: recorder.feature,
      run: recorder.paths.runId,
      step: event.step,
      emitter: ENGINE_EMITTER,
      type: event.type,
      payload: event.payload,
      ...(event.sessionId === undefined ? {} : { session_id: event.sessionId }),
      ...(event.baselineRef === undefined ? {} : { baseline_ref: event.baselineRef }),
    });
    // A line did land — the `redaction.failed` substitute — so the boundary is real either way.
    this.boundary(`event-appended:${event.type}`);
    if (recorded.dropped) {
      // The log does not record this action, and AD-4 makes the log the only truth. Proceeding would
      // leave the fold re-deciding the same action against a log that never remembers it.
      throw new UnrecordedAction(event.type);
    }
  }

  /** Fold the log and write the checkpoint from it. The only way a checkpoint is produced. */
  private checkpointFromLog(paths: RunPaths, plan: FeaturePlan): RunState {
    const events = readEventLog(paths.eventLog);
    const rebuilt = rebuildFromLog(events, { run: paths.runId, plan, now: this.now });
    return this.writeCheckpoint(paths, rebuilt);
  }

  private writeCheckpoint(paths: RunPaths, state: RunState): RunState {
    const written = writeCheckpoint(paths, {
      ...state,
      updated_at: formatTimestamp(this.now()),
    });
    this.boundary(`checkpoint-written:${written.state}`);
    return written;
  }

  private boundary(label: string): void {
    this.boundaryObserver?.(label);
  }

  private recorderFor(run: string, feature: string): Recorder {
    const existing = this.recorders.get(run);
    if (existing !== undefined) return existing;
    const recorder = Recorder.open({
      runId: run,
      feature,
      orchHome: this.orchHome,
      now: this.now,
      redaction: this.redaction,
    });
    this.recorders.set(run, recorder);
    return recorder;
  }

  /**
   * A run's declared plan, found by the feature slug the run names.
   *
   * The log is asked first, in keeping with AD-4, and the checkpoint is the fallback — not only for a run
   * with no lines yet, but for the case where the log's own `feature` is unusable. A slug is punctuated
   * and low-entropy so the redaction pass leaves it alone, but it is not *guaranteed* to: one that folded
   * to the redaction marker would make the plan lookup fail, and since `load` is called for every run on
   * every pass, that would wedge the whole loop permanently on one run's unlucky slug. Falling back costs
   * nothing and removes a class of unrecoverable state.
   */
  private planFor(
    paths: RunPaths,
    events: readonly { readonly feature: string }[],
    checkpoint: RunState | null,
  ): FeaturePlan {
    const candidates = [events[0]?.feature, checkpoint?.feature].filter(
      (feature): feature is string =>
        typeof feature === 'string' && feature !== '' && feature !== REDACTION_MARKER,
    );
    if (candidates.length === 0) throw new IncompleteRunDirectory(paths.runId);

    let lastFailure: unknown = null;
    for (const feature of candidates) {
      try {
        return this.plans(feature);
      } catch (thrown: unknown) {
        lastFailure = thrown;
      }
    }
    throw lastFailure;
  }

  private planStepFor(plan: FeaturePlan, step: string): PlanStep {
    const found = plan.steps.find((entry) => entry.step === step);
    if (found === undefined) {
      throw new Error(
        `Step "${step}" is recorded in the run but absent from the feature's declared plan, so the ` +
          'loop has no contract to re-run it against. A plan may grow, never lose a started step.',
      );
    }
    return found;
  }

  private requireStepRecord(state: RunState, step: string): StepRecord {
    const record = findStepRecord(state, step);
    if (record === null) {
      throw new Error(`Step "${step}" has no record in run ${state.run}.`);
    }
    return record;
  }

  private report(
    run: string,
    state: RunState,
    action: ReconcileAction,
    from: FeatureState,
    step: string | null,
    loaded: { readonly disagreements: readonly CheckpointDisagreement[]; readonly checkpointRebuilt: boolean },
  ): PassAction {
    return {
      run,
      feature: state.feature,
      kind: action.kind,
      step,
      from,
      to: state.state,
      reason: action.reason,
      checkpointRebuilt: loaded.checkpointRebuilt,
      disagreements: loaded.disagreements,
    };
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new Error('This reconciler has released its ORCH_HOME lock and cannot act (AD-30).');
    }
  }
}

/** `runs/<run-id>/steps/<step>/input.json`. */
export const stepInputPath = (paths: RunPaths, step: string): string => {
  if (!SAFE_STEP_ID.test(step)) {
    throw new Error(
      `Refusing to build a path from step id "${step}": a step id is a stable declared name matching ` +
        `${String(SAFE_STEP_ID)}, so it cannot escape the run directory.`,
    );
  }
  return join(paths.runDir, STEPS_DIR_NAME, step, STEP_INPUT_FILE_NAME);
};

/**
 * Choose the one action a pass takes for a feature.
 *
 * A pure function of the checkpoint and the plan, which is the point: the decision is reproducible
 * from durable state alone, so a restart at any instant reaches the same one. The order of the tests
 * below is the specification.
 */
export const decideAction = (state: RunState, plan: FeaturePlan): ReconcileAction => {
  if (isTerminalFeatureState(state.state)) {
    return {
      kind: 'idle',
      reason: `The feature is ${state.state}, which is terminal: no further pass acts on it.`,
    };
  }

  if (state.state === 'drafting') {
    return {
      kind: 'await-confirmation',
      reason: 'No feature enters execution without user-confirmed acceptance criteria (CAP-2).',
    };
  }

  if (state.state === 'blocked') {
    return {
      kind: 'await-approval',
      reason: 'The feature blocked at a gate and waits for a person, not for another pass (CAP-12).',
    };
  }

  // A step carrying no disposition is one the engine was killed inside. It is adopted before anything
  // else is considered: every other decision would be made from a state that is not the run's.
  const orphan = inFlightStep(state);
  if (orphan !== null) {
    return {
      kind: 'adopt-orphan',
      step: orphan.step,
      reason:
        `Step "${orphan.step}" is recorded as started with no termination, so the engine was killed ` +
        'inside it. AD-8 records that as "interrupted", which is the one resumable disposition.',
    };
  }

  /**
   * The *earliest* step carrying a termination that is not `completed`, not the last record.
   *
   * Taking the last one leaves an earlier failure unrouted: the fall-through below then picks that same
   * step as "the next step with no completed record" and starts it again — a re-run with no baseline
   * reset, forever, because nothing ever consults the table about it.
   */
  const pending =
    state.steps.find(
      (record) => record.disposition !== null && record.disposition !== 'completed',
    ) ?? null;

  if (pending !== null && pending.disposition !== null) {
    const routing = routeTermination({
      step: pending.step,
      disposition: pending.disposition,
      sessionId: pending.session_id,
      error: pending.error,
      modelTier: pending.model_tier,
      promotions: pending.promotions,
    });

    const target = targetStateFor(plan, pending.step);
    const sessionId = pending.session_id;
    switch (routing.action) {
      case 'resume':
        // `routeTermination` returns `resume` only for a step carrying a session id, so the null branch
        // is unreachable. It falls to the reset-and-re-run rather than asserting, because that is the
        // behaviour AD-8 prescribes for an interrupted step with no id — so an unreachable state stays
        // correct instead of merely loud.
        return sessionId === null
          ? {
              kind: 'reset-and-rerun',
              step: pending.step,
              promoteTo: null,
              transitionTo: target,
              reason: routing.reason,
            }
          : {
              kind: 'resume-step',
              step: pending.step,
              sessionId,
              transitionTo: target,
              reason: routing.reason,
            };
      case 'reset-and-rerun':
        return {
          kind: 'reset-and-rerun',
          step: pending.step,
          promoteTo: null,
          transitionTo: target,
          reason: routing.reason,
        };
      case 'promote-model-tier':
        // A promotion is not an action of its own: promoting and then not re-running would leave the
        // step's `failed` disposition standing, and the next pass would route it as an exhausted ladder.
        return {
          kind: 'reset-and-rerun',
          step: pending.step,
          promoteTo: routing.promoteTo,
          transitionTo: target,
          reason: routing.reason,
        };
      case 'escalate-to-human':
        return { kind: 'escalate-to-human', step: pending.step, reason: routing.reason };
      case 'hand-off':
        return {
          kind: 'hand-off',
          step: pending.step,
          code: routing.code ?? 'internal.invariant_violated',
          reason: routing.reason,
        };
      case 'stop':
        return {
          kind: 'idle',
          reason: routing.reason,
        };
      case 'advance':
        break;
    }
  }

  const completed = new Set(
    state.steps.filter((record) => record.disposition === 'completed').map((record) => record.step),
  );
  const next = plan.steps.find((entry) => !completed.has(entry.step));

  if (next === undefined) {
    return {
      kind: 'advance-state',
      to: 'committed',
      reason:
        'Every declared step completed, so the gates have passed and the run reaches its terminal ' +
        'state. Opening the pull request is the committer’s work in story 2-7.',
    };
  }

  return {
    kind: 'run-step',
    step: next,
    transitionTo: next.phase === 'verification' ? 'verifying' : 'running',
    reason:
      `Step "${next.step}" is the next declared ${next.phase} step with no completed record, so the ` +
      'reconciler claims it.',
  };
};

/** The feature state a step's phase puts the run in while that step runs. */
const targetStateFor = (plan: FeaturePlan, step: string): FeatureState => {
  const entry = plan.steps.find((candidate) => candidate.step === step);
  return entry?.phase === 'verification' ? 'verifying' : 'running';
};
