/**
 * AD-32 — reclamation is a reconcile pass comparing live resources against runs.
 *
 * The rule is stated as a prohibition because the tidy-looking implementation is the wrong one: releasing
 * a lease in a `finally` around a run, or removing a worktree in a shutdown handler, reads as careful and
 * is exactly what AD-32 forbids. A crash skips all three of `finally`, an exit handler and a signal
 * handler, and the stranded container is then invisible — nothing on disk says it should have gone. So
 * there is no cleanup path in this file, and `tests/pool.reclaim.test.ts` asserts that by reading the
 * source: no `process.on`, no exit hook, no `finally`.
 *
 * What replaces them is a **pure comparison**. {@link decideReclamation} takes the live resources on one
 * side and a reader of run state on the other and returns a decision per resource. It writes nothing,
 * removes nothing and asks nothing of a container runtime, which is what makes the AD-32 rule assertable
 * on a machine with no daemon: the comparison is the whole of the policy, and only the acting needs a
 * runtime. {@link performReclamation} does the acting, and the reconciler drives both.
 *
 * Two rules the comparison holds, and the reason each is a rule rather than a default:
 *
 * **Nothing is reclaimed while its run holds a non-terminal disposition.** A run at `running` is using
 * its worktree; a run at `blocked` is waiting for a person and will use it again. Only the four terminal
 * states, and the total absence of run state, release a resource.
 *
 * **Absence of run *state* is the abandonment signal, never absence of a path.** AD-33 exists because
 * prune once inferred abandonment from a path that had merely moved. Applied here: a run whose
 * `state.json` is missing but whose event log is present still has state — the durable truth is the log
 * (AD-4) and the next reconcile pass will fold it back into a checkpoint — so its resources are retained
 * until a checkpoint exists to read. Only a run with neither carries no state at all, and only then is
 * what it held reclaimable. That is deliberately the same condition the reconciler calls an incomplete
 * run directory.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { FEATURE_STATES, isTerminalFeatureState, isRecognisedSchemaVersion } from '../contracts/index.js';
import type { FeatureState } from '../contracts/index.js';
import { RUN_STATE_FILE_NAME } from '../contracts/index.js';
import { EVENT_LOG_FILE_NAME, resolveOrchHome, runPaths, worktreeDir } from '../runtime/index.js';

import { listLeaseRecords } from './lease.js';
import type { LeaseRecord, LeasePool } from './lease.js';
import { listWorktreeRuns, removeWorktree } from './worktree.js';
import type { GitRunner, WorktreeRemoval } from './worktree.js';

/** The two kinds of resource a run holds. Both are reclaimed by the same comparison. */
export const RESOURCE_KINDS = ['worktree', 'lease'] as const;

export type ResourceKind = (typeof RESOURCE_KINDS)[number];

/**
 * One live resource, as the enumeration found it.
 *
 * `id` is the run id for a worktree and the lease id for a lease, which is what makes a decision
 * reportable without the caller holding the resource itself.
 */
export interface LiveResource {
  readonly kind: ResourceKind;
  readonly id: string;
  readonly run: string;
  /** The worktree directory, or the lease record's container name: what would be acted on. */
  readonly handle: string;
  /** The lease record, for a lease. Absent for a worktree. */
  readonly lease?: LeaseRecord;
}

/**
 * What a run's state says, or that it says nothing at all.
 *
 * Three cases, and they are different on purpose: a state this build read, a run whose state exists but
 * cannot yet be read as a checkpoint, and a run with no state at all. Only the third releases anything.
 */
export interface RunStateView {
  /** False only when the run carries neither a checkpoint nor an event log. */
  readonly present: boolean;
  /** The state a checkpoint named, or `null` when one could not be read. */
  readonly state: FeatureState | null;
  /** One sentence naming what was found, so a decision can quote its evidence. */
  readonly evidence: string;
}

/** How run state is read. A port, so the comparison is testable with no filesystem at all. */
export type RunStateReader = (run: string) => RunStateView;

const isFeatureState = (value: unknown): value is FeatureState =>
  typeof value === 'string' && (FEATURE_STATES as readonly string[]).includes(value);

/**
 * The reader over `ORCH_HOME/runs/<run-id>/`.
 *
 * Reads the checkpoint directly rather than folding the log, because folding is `src/engine/`'s and this
 * package does not import it. The consequence is stated rather than hidden: a run whose checkpoint has
 * not caught up is retained this pass and reclaimed on a later one, once the reconciler — which writes a
 * checkpoint for every run it reads, acting or not — has written one. "On the next pass" is AD-32's own
 * language, and erring toward retention is the direction that cannot destroy a live run's work.
 */
export const fileRunStateReader =
  (orchHome: string = resolveOrchHome()): RunStateReader =>
  (run: string): RunStateView => {
    const paths = runPaths(run, orchHome);
    const checkpoint = join(paths.runDir, RUN_STATE_FILE_NAME);
    const hasLog = existsSync(join(paths.runDir, EVENT_LOG_FILE_NAME));

    if (existsSync(checkpoint)) {
      try {
        const parsed: unknown = JSON.parse(readFileSync(checkpoint, 'utf8'));
        const record = parsed as { schema_version?: unknown; state?: unknown };
        if (typeof record.schema_version !== 'number' || !isRecognisedSchemaVersion(record.schema_version)) {
          return {
            present: true,
            state: null,
            evidence:
              'the run checkpoint carries a schema_version this build does not read, so nothing it ' +
              'says about the run is trusted (AD-28)',
          };
        }
        if (isFeatureState(record.state)) {
          return {
            present: true,
            state: record.state,
            evidence: `the run checkpoint records the state "${record.state}"`,
          };
        }
        return {
          present: true,
          state: null,
          evidence: 'the run checkpoint names no state this build recognises',
        };
      } catch {
        return {
          present: true,
          state: null,
          evidence: 'the run checkpoint could not be parsed, so the run is treated as still holding state',
        };
      }
    }

    if (hasLog) {
      return {
        present: true,
        state: null,
        evidence:
          'the run has an event log but no checkpoint yet, so its state exists in the durable truth ' +
          'and a later pass will read it (AD-4)',
      };
    }

    return {
      present: false,
      state: null,
      evidence: 'the run carries neither a checkpoint nor an event log, so no run state exists (AD-32)',
    };
  };

/** One resource and what the comparison decided about it. */
export interface ReclaimDecision {
  readonly resource: LiveResource;
  readonly reclaim: boolean;
  readonly reason: string;
  /** The run state the decision was made against, so a report can be read without re-reading disk. */
  readonly runState: RunStateView;
}

/**
 * The comparison. Pure: no write, no removal, no runtime, no clock.
 *
 * Every branch below is one sentence of AD-32, in the order the rule states them.
 */
export const decideReclamation = (
  resources: readonly LiveResource[],
  readRunState: RunStateReader,
): readonly ReclaimDecision[] =>
  resources.map((resource): ReclaimDecision => {
    const runState = readRunState(resource.run);

    if (!runState.present) {
      return {
        resource,
        reclaim: true,
        reason: `no run state exists for ${resource.run}: ${runState.evidence}`,
        runState,
      };
    }
    if (runState.state === null) {
      return {
        resource,
        reclaim: false,
        reason:
          `run ${resource.run} holds state this pass could not read as a disposition, and a resource ` +
          `is released only by a terminal one: ${runState.evidence}`,
        runState,
      };
    }
    if (isTerminalFeatureState(runState.state)) {
      return {
        resource,
        reclaim: true,
        reason: `run ${resource.run} reached the terminal state "${runState.state}"`,
        runState,
      };
    }
    return {
      resource,
      reclaim: false,
      reason: `run ${resource.run} is "${runState.state}", which is not terminal`,
      runState,
    };
  });

export interface EnumerateOptions {
  readonly orchHome?: string;
}

/**
 * Every live resource under `ORCH_HOME`: a directory per run under `worktrees/`, a record per lease.
 *
 * Enumeration is by what is *there*, never by what a run says it has. A run that recorded a lease it
 * never got is not a resource; a lease record no run mentions is.
 */
export const enumerateLiveResources = (options: EnumerateOptions = {}): readonly LiveResource[] => {
  const orchHome = options.orchHome ?? resolveOrchHome();
  const worktrees = listWorktreeRuns(orchHome).map(
    (run): LiveResource => ({
      kind: 'worktree',
      id: run,
      run,
      handle: worktreeDir(run, orchHome),
    }),
  );
  const leases = listLeaseRecords(orchHome).map(
    (record): LiveResource => ({
      kind: 'lease',
      id: record.lease,
      run: record.run,
      handle: record.container_name,
      lease: record,
    }),
  );
  return [...worktrees, ...leases];
};

/** One resource the pass acted on, or declined to. The engine reports these verbatim. */
export interface ReclaimedResource {
  readonly kind: ResourceKind;
  readonly id: string;
  readonly run: string;
  readonly reason: string;
}

/**
 * What one pass did.
 *
 * Structurally what `src/engine/reconciler.ts` declares as its reclamation port's result, so the engine
 * can drive this without importing `src/pool/` — the same structural seam story 1-5's wrapper reaches
 * story 1-4's spawner through.
 */
export interface ReclamationSummary {
  readonly reclaimed: readonly ReclaimedResource[];
  readonly retained: readonly ReclaimedResource[];
  readonly failed: readonly ReclaimedResource[];
}

/** The acting half: how a decided resource is actually released. Both are ports. */
export interface ReclaimActions {
  readonly removeWorktree: (resource: LiveResource, decision: ReclaimDecision) => WorktreeRemoval;
  readonly releaseLease: (
    record: LeaseRecord,
  ) => { readonly reclaimed: boolean; readonly reason: string };
}

/**
 * Act on a decided set. Takes decisions, never resources: nothing here re-decides anything.
 *
 * A resource that could not be released is reported as failed and left exactly as it was, so the next
 * pass meets the same comparison and reaches the same decision. That is the whole recovery mechanism —
 * there is no retry state, no backoff timer and nothing in memory between passes.
 */
export const performReclamation = (
  decisions: readonly ReclaimDecision[],
  actions: ReclaimActions,
): ReclamationSummary => {
  const reclaimed: ReclaimedResource[] = [];
  const retained: ReclaimedResource[] = [];
  const failed: ReclaimedResource[] = [];

  for (const decision of decisions) {
    const entry = {
      kind: decision.resource.kind,
      id: decision.resource.id,
      run: decision.resource.run,
    };
    if (!decision.reclaim) {
      retained.push({ ...entry, reason: decision.reason });
      continue;
    }
    try {
      if (decision.resource.kind === 'worktree') {
        const removal = actions.removeWorktree(decision.resource, decision);
        if (removal.removed) {
          reclaimed.push({ ...entry, reason: `${decision.reason}; ${removal.reason}` });
        } else {
          failed.push({ ...entry, reason: removal.reason });
        }
        continue;
      }
      const record = decision.resource.lease;
      if (record === undefined) {
        failed.push({ ...entry, reason: 'the lease decision carried no lease record to act on' });
        continue;
      }
      const released = actions.releaseLease(record);
      if (released.reclaimed) reclaimed.push({ ...entry, reason: `${decision.reason}; ${released.reason}` });
      else failed.push({ ...entry, reason: released.reason });
    } catch (thrown: unknown) {
      // A thrown release is one resource's problem. Reported against that resource so every other one
      // in the same pass is still acted on, exactly as the reconciler treats one unreadable run.
      failed.push({
        ...entry,
        reason: thrown instanceof Error ? `${thrown.name}: ${thrown.message}` : String(thrown),
      });
    }
  }

  return { reclaimed, retained, failed };
};

export interface ReclamationPassOptions {
  readonly orchHome?: string;
  /** The lease pool, when one is configured. Without it, lease records are reported, never acted on. */
  readonly pool?: LeasePool;
  readonly readRunState?: RunStateReader;
  readonly git?: GitRunner;
}

/**
 * The AD-32 pass: enumerate, compare, act.
 *
 * Callable at any moment and as often as the loop likes. It holds nothing between calls, so killing the
 * process part-way through leaves every resource in exactly one of two states — released, or still there
 * and still reclaimable by the identical comparison next time.
 */
export const runReclamationPass = (options: ReclamationPassOptions = {}): ReclamationSummary => {
  const orchHome = options.orchHome ?? resolveOrchHome();
  const readRunState = options.readRunState ?? fileRunStateReader(orchHome);
  const resources = enumerateLiveResources({ orchHome });
  const decisions = decideReclamation(resources, readRunState);
  const pool = options.pool;

  return performReclamation(decisions, {
    removeWorktree: (resource: LiveResource, decision: ReclaimDecision): WorktreeRemoval =>
      removeWorktree({
        run: resource.run,
        // The comparison already established this: a terminal state, or no state at all. Passing the
        // state through rather than re-reading it keeps one decision in one place.
        state: decision.runState.present ? decision.runState.state : null,
        orchHome,
        ...(options.git === undefined ? {} : { git: options.git }),
      }),
    releaseLease: (
      record: LeaseRecord,
    ): { readonly reclaimed: boolean; readonly reason: string } =>
      pool === undefined
        ? {
            reclaimed: false,
            reason:
              `lease ${record.lease} is reclaimable but no lease pool is configured for this pass, so ` +
              'its instance is reported rather than destroyed',
          }
        : pool.reclaim(record),
  });
};

/**
 * The port `src/engine/reconciler.ts` takes, bound to one `ORCH_HOME`.
 *
 * This is the whole of the wiring the engine needs: one function, called once per pass, returning what
 * it did. The engine learns nothing about worktrees, leases or containers from it.
 */
export const reconcilerReclamation =
  (options: ReclamationPassOptions = {}): (() => ReclamationSummary) =>
  (): ReclamationSummary =>
    runReclamationPass(options);
