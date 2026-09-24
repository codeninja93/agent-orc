/**
 * Story 2-11 — the first real composition root.
 *
 * Nothing under `src/` or `bin/` has ever constructed a real `Reconciler` wired to a real spawner, a
 * real recorder, a real committer and this story's real write executor — every existing wiring is a
 * test fixture, driving a `createScriptedExecutor` double against an in-memory plan provider. This
 * module is that assembly, built from pieces every prior story already shipped:
 *
 * - `src/engine/spawner.ts`'s `createStepSpawner` — story 1-4's real `claude -p` process handling.
 * - `src/runtime/recorder.ts`'s `Recorder` — story 1-2's durable, single-writer event log.
 * - `src/pool/worktree.ts`'s `createWorktree` — story 1-5's real git worktree, on its own branch.
 * - `src/engine/config-snapshot.ts`'s `takeConfigSnapshot` — AD-9's per-run configuration snapshot,
 *   read from the target repository's own `.orch/` (written by `npx github:<owner>/<repo> init`,
 *   AD-12 — a precondition this module asserts rather than performs).
 * - `src/container/lifecycle.ts`'s `checkDefaultBranchProtection` — ADR-001's run-start assertion.
 * - `src/engine/write-executor.ts`'s `performWriteIntent`/`checkPullRequestMerged` — this story's own.
 *
 * **What is still, honestly, not wired.** `gates` is left `null`: CAP-13's deterministic gates run
 * inside a container per ADR-001, and assembling the container wrapper's own composition root is a
 * distinct, already-carried gap (story 2-7's own deferred entries) that this story does not close. A
 * run whose profile declares a gate and meets no runner blocks naming the gate it could not run — the
 * same honest degradation `src/engine/reconciler.ts` already gives every other missing port, never a
 * silent skip.
 *
 * **What this module never does.** It never calls `git push`, `gh pr create`, or `git notes ... add`
 * itself — those are `performWriteIntent`'s, called by the `Reconciler` it assembles, only once a real
 * run reaches the point AD-15 requires them. Assembling this module and importing it performs no write
 * of its own; running {@link runFeatureToCompletion} against a real repository does, which is why the
 * only calls this project's own automated suites make into it use a fake `git`/`gh` or a disposable
 * local scratch repository, never this repository's real `origin`.
 */
import { execFileSync } from 'node:child_process';

import {
  WRITE_EXECUTED_EVENT_TYPE,
  WRITE_EXECUTED_PAYLOAD_KEYS,
  isModelRung,
  isTerminalFeatureState,
} from '../contracts/index.js';
import type { EventEnvelope, FeatureState, ModelRung } from '../contracts/index.js';
import {
  REMOTE,
  Reconciler,
  STANDARD_PLAN_STEPS,
  WRITE_GH_TIMEOUT_MS,
  WRITE_GIT_TIMEOUT_MS,
  checkPullRequestMerged,
  createStepSpawner,
  createUlidMinter,
  mintRunId,
  performWriteIntent,
  takeConfigSnapshot,
} from '../engine/index.js';
import type { FeaturePlan, PassAction, StepSpawner, UlidMinter } from '../engine/index.js';
import { checkDefaultBranchProtection } from '../container/index.js';
import type { BranchProtection, BranchProtectionProbe } from '../container/index.js';
import { createWorktree, reconcilerReclamation } from '../pool/index.js';
import type { Worktree } from '../pool/index.js';
import { Recorder, readEventLog, resolveOrchHome, runPaths } from '../runtime/index.js';

/**
 * A feature this module has not built for itself and does not need to: the request, the acceptance
 * criteria, and the feature slug the committer names a branch from. "Already-confirmed" is this
 * story's own phrase for it — CAP-1 through CAP-4's interview is what produces one; assembling that
 * interview into this entry point as well is future work this module does not take on.
 */
export interface ConfirmedFeatureSpec {
  readonly feature: string;
  readonly request: string;
  readonly acceptance_criteria: readonly string[];
  /** The declared file territory. Empty is a valid answer for a demonstration run touching no path yet. */
  readonly territory?: readonly string[];
  readonly starting_model_tier?: ModelRung;
}

/** How long a non-terminal, non-`awaiting_merge` run waits before the next pass. */
const DEFAULT_POLL_INTERVAL_MS = 2_000;

/**
 * How long an `awaiting_merge` run waits before the next `gh pr view` check.
 *
 * A pull request does not merge faster than a person can act, and `checkPullRequestMerged` is a real
 * network call — polling it every couple of seconds for however long a human review takes would burn a
 * real GitHub API rate limit for no reason. A minute is a reasonable default for a real demonstration;
 * `RunFeatureOptions.awaitingMergePollIntervalMs` overrides it.
 */
const DEFAULT_AWAITING_MERGE_POLL_INTERVAL_MS = 60_000;

export interface RunFeatureOptions {
  /** The repository this run works against — its default branch is what the pull request targets. */
  readonly repository: string;
  readonly spec: ConfirmedFeatureSpec;
  /** Defaults to the AD-9 resolution. */
  readonly orchHome?: string;
  /**
   * Resume an existing, already-accepted run by id instead of minting a new one and re-running
   * `acceptFeature`/`createWorktree` from scratch.
   *
   * The timeout error this function throws when `maxPasses` is reached — the ordinary outcome of a run
   * parked in `awaiting_merge` for longer than one call cares to wait — names exactly this option as how
   * to pick the same run back up, because re-running with no `run` given always mints a *new* run and
   * would leave the parked one behind, forgotten, waiting on a merge nothing will ever come back to check.
   * `createWorktree` adopts the existing worktree rather than creating a second one (its own docblock:
   * "idempotent on purpose"), and `takeConfigSnapshot` reports `already_taken` rather than rewriting one
   * that exists (AD-9) — both of which are what make resuming safe to call blind, without first checking
   * what state the run is in.
   */
  readonly run?: string;
  /**
   * The branch-protection probe. Defaults to {@link ghDefaultBranchProtectionProbe}; `null` asserts
   * nothing is wired (the run then reports `unknown` and refuses, per ADR-001's fail-closed direction).
   */
  readonly branchProtectionProbe?: BranchProtectionProbe | null;
  /** Called once per pass with the action it took, so a caller can render progress. Never required. */
  readonly onProgress?: (action: PassAction) => void;
  /**
   * Called exactly once, the first time the pull request's own URL becomes readable from the log.
   *
   * Without this, the one fact an operator actually needs — where to go merge the pull request this run
   * just opened — exists only in `write.executed`'s `detail` field, in the raw event log; nothing else
   * this function returns or calls carries it.
   */
  readonly onPullRequestUrl?: (url: string) => void;
  /** How long a non-terminal, non-`awaiting_merge` run waits before the next pass. */
  readonly pollIntervalMs?: number;
  /** How long an `awaiting_merge` run waits before the next bounded merge check. */
  readonly awaitingMergePollIntervalMs?: number;
  /** A bound on this call, not an AD-24 ceiling: guards against a loop that never converges. */
  readonly maxPasses?: number;
}

export interface RunFeatureOutcome {
  readonly run: string;
  readonly state: FeatureState;
  /** The real git worktree this run worked in. */
  readonly worktree: string;
}

const isStringArray = (value: unknown): value is readonly string[] =>
  Array.isArray(value) && value.every((entry) => typeof entry === 'string');

/**
 * Parse `bin/orch-run.ts`'s spec file into a {@link ConfirmedFeatureSpec}.
 *
 * Lives here rather than in the bin file, for the same reason `src/installer/` holds `bin/init.ts`'s
 * logic: an entry point is the one file a test cannot easily reach, so the less that lives there the
 * better, and every refusal below is asserted by this package's own suite.
 */
export const parseConfirmedFeatureSpec = (raw: string): ConfirmedFeatureSpec => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (thrown: unknown) {
    throw new Error(
      `the spec file is not valid JSON: ${thrown instanceof Error ? thrown.message : String(thrown)}`,
    );
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('the spec file must contain a JSON object');
  }
  const record = parsed as Record<string, unknown>;
  const feature = record['feature'];
  const request = record['request'];
  const acceptanceCriteria = record['acceptance_criteria'];
  const territory = record['territory'];
  const startingModelTier = record['starting_model_tier'];
  if (typeof feature !== 'string' || feature.trim() === '') {
    throw new Error('the spec must carry a non-blank "feature" slug');
  }
  if (typeof request !== 'string' || request.trim() === '') {
    throw new Error('the spec must carry a non-blank "request"');
  }
  if (!isStringArray(acceptanceCriteria) || acceptanceCriteria.length === 0) {
    throw new Error('the spec must carry a non-empty "acceptance_criteria" array of strings');
  }
  if (territory !== undefined && !isStringArray(territory)) {
    throw new Error('the spec’s "territory", if present, must be an array of strings');
  }
  if (startingModelTier !== undefined && (typeof startingModelTier !== 'string' || !isModelRung(startingModelTier))) {
    throw new Error(
      'the spec’s "starting_model_tier", if present, must be one of the declared model rungs',
    );
  }
  return {
    feature,
    request,
    acceptance_criteria: acceptanceCriteria,
    ...(territory === undefined ? {} : { territory }),
    ...(startingModelTier === undefined ? {} : { starting_model_tier: startingModelTier }),
  };
};

/**
 * A best-effort branch-protection probe over `gh api`, for a repository whose remote is GitHub.
 *
 * "Best-effort" is the honest word: any failure — no `gh`, no auth, a non-GitHub remote, a network
 * error — answers `null`, which `checkDefaultBranchProtection` reads as *unverified* and refuses the
 * run (ADR-001's fail-closed direction, the same one `src/container/lifecycle.ts` already takes). This
 * function never throws for a reason a run should merely proceed past, and every `execFileSync` call
 * below carries the same timeouts `src/engine/write-executor.ts` uses for its own `git`/`gh` calls, so a
 * hung process folds to "unverified" within a bounded time rather than blocking run start indefinitely.
 */
export const ghDefaultBranchProtectionProbe: BranchProtectionProbe = (repository, branch) => {
  try {
    const remoteUrl = execFileSync('git', ['-C', repository, 'remote', 'get-url', REMOTE], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: WRITE_GIT_TIMEOUT_MS,
    }).trim();
    const match = /github\.com[:/]([^/]+)\/(.+?)(?:\.git)?\/?$/.exec(remoteUrl);
    if (match === null) return null;
    const owner = match[1];
    const repo = match[2];
    const path =
      `repos/${encodeURIComponent(String(owner))}/${encodeURIComponent(String(repo))}` +
      `/branches/${encodeURIComponent(branch)}/protection`;
    const stdout = execFileSync('gh', ['api', path], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: WRITE_GH_TIMEOUT_MS,
    });
    const parsed: unknown = JSON.parse(stdout);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const record = parsed as Record<string, unknown>;
    const flag = (key: string): boolean => {
      const value = record[key];
      return (
        typeof value === 'object' &&
        value !== null &&
        (value as Record<string, unknown>)['enabled'] === true
      );
    };
    const found: BranchProtection = {
      branch,
      protected: true,
      forcePushDisabled: !flag('allow_force_pushes'),
      deletionDisabled: !flag('allow_deletions'),
      source: 'gh api repos/:owner/:repo/branches/:branch/protection',
    };
    return found;
  } catch {
    return null;
  }
};

/**
 * A minter whose first `mint()` returns `firstId`, and a real monotonic minter after that.
 *
 * **The fix for a critical id mismatch.** `Reconciler.acceptFeature` mints its own run id internally
 * (AD-29's rule that run ids are minted solely by the engine), so a caller that also needs to name a
 * *worktree* before that call — because the `FeaturePlan` handed to `acceptFeature` must already carry
 * its `worktree` path — either predicts the wrong id or, as this module now does, hands the reconciler a
 * minter that is *made* to answer with the id already used to name the worktree. Without this, the
 * worktree lives under one id and the run's own durable state lives under another, and
 * `src/pool/reclaim.ts`'s AD-32 pass — which correlates a worktree to a run by exactly this id — finds no
 * recorded state for the worktree's own id and reclaims (deletes) it while the run is still using it.
 */
export const seededUlidMinter = (firstId: string): UlidMinter => {
  let used = false;
  const fallback = createUlidMinter();
  return {
    mint: (): string => {
      if (!used) {
        used = true;
        return firstId;
      }
      return fallback.mint();
    },
  };
};

/** Everything one run needs from a single shared `Recorder` per run id (AD-29's single-writer claim). */
const sharedRecorders = (orchHome: string): { readonly recorderFor: (run: string, feature: string) => Recorder; readonly closeAll: () => void } => {
  const recorders = new Map<string, Recorder>();
  return {
    recorderFor: (run, feature): Recorder => {
      const existing = recorders.get(run);
      if (existing !== undefined) return existing;
      const recorder = Recorder.open({ runId: run, feature, orchHome });
      recorders.set(run, recorder);
      return recorder;
    },
    closeAll: (): void => {
      for (const recorder of recorders.values()) recorder.close();
    },
  };
};

const PULL_REQUEST_URL_PATTERN = /https?:\/\/\S+/;

/**
 * The pull request's own URL, once `write.executed` has recorded one, or `null` before that.
 *
 * Read from the log rather than carried through `performWriteIntent`'s return value, because nothing
 * else in this module's loop sees that return value — the write executor is called from deep inside
 * `Reconciler.pass()`, and the log is the one place its outcome is guaranteed to have landed durably
 * (AD-4) by the time this function's caller looks for it.
 */
const pullRequestUrlFrom = (events: readonly EventEnvelope[]): string | null => {
  for (const event of events) {
    if (event.type !== WRITE_EXECUTED_EVENT_TYPE) continue;
    if (event.payload[WRITE_EXECUTED_PAYLOAD_KEYS.Kind] !== 'pull_request') continue;
    const detail = event.payload[WRITE_EXECUTED_PAYLOAD_KEYS.Detail];
    if (typeof detail !== 'string') continue;
    const match = PULL_REQUEST_URL_PATTERN.exec(detail);
    if (match !== null) return match[0];
  }
  return null;
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Assemble a real `Reconciler` and drive one feature from an already-confirmed spec through to a
 * terminal state.
 *
 * **Preconditions this function asserts rather than performs, by design.** `repository` must already
 * be `.orch/`-installed (`npx github:<owner>/<repo> init`, AD-12) — this module reads that configuration
 * through {@link takeConfigSnapshot}, it does not scaffold it. A repository with none fails here, in
 * `takeConfigSnapshot`'s own refusal, naming the missing profile, rather than three steps in.
 *
 * **What "to completion" means honestly.** With this story's write executor and merge checker wired
 * (the defaults), a run whose committing step composes real prose pushes a real branch, opens a real
 * pull request, and then waits — `awaiting_merge` — for a person to merge it before this call's loop
 * ever sees `committed`. That wait is the reason this function polls, spaced out by
 * {@link RunFeatureOptions.awaitingMergePollIntervalMs} rather than in a tight loop, rather than
 * returning as soon as every declared step completes: `awaiting_merge` is this story's whole point, not
 * a state to paper over. If the wait outlasts `maxPasses`, `options.run` (or the CLI's own resume flag)
 * is how to pick the same run back up rather than minting a new one.
 */
export const runFeatureToCompletion = async (options: RunFeatureOptions): Promise<RunFeatureOutcome> => {
  const orchHome = options.orchHome ?? resolveOrchHome();
  const resuming = options.run !== undefined;
  const worktreeId = options.run ?? mintRunId();
  const worktree: Worktree = createWorktree({ run: worktreeId, repository: options.repository, orchHome });

  const plan: FeaturePlan = {
    feature: options.spec.feature,
    mode: 'live',
    territory: [...(options.spec.territory ?? [])],
    steps: STANDARD_PLAN_STEPS,
    request: options.spec.request,
    acceptance_criteria: [...options.spec.acceptance_criteria],
    starting_model_tier: options.spec.starting_model_tier ?? 'claude-haiku-4-5',
    worktree: worktree.path,
  };

  const { recorderFor, closeAll } = sharedRecorders(orchHome);
  const probe = options.branchProtectionProbe === undefined ? ghDefaultBranchProtectionProbe : options.branchProtectionProbe;
  const executor: StepSpawner = createStepSpawner({ recorderFor, orchHome });

  const reconciler = Reconciler.open({
    orchHome,
    executor,
    plans: () => plan,
    recorderFor,
    writeExecutor: performWriteIntent,
    mergeChecker: checkPullRequestMerged,
    branchProtection:
      probe === null
        ? null
        : (): ReturnType<typeof checkDefaultBranchProtection> =>
            checkDefaultBranchProtection({ repository: options.repository, probe }),
    reclamation: reconcilerReclamation({ orchHome }),
    // Resuming reads an existing run's state rather than minting one, so the seeded minter — which
    // exists only to make a *fresh* `acceptFeature` mint the id already used for the worktree — is not
    // wired at all: the reconciler's ordinary default is exactly right for whatever `steer`/`ask` do later.
    ...(resuming ? {} : { minter: seededUlidMinter(worktreeId) }),
  });

  try {
    let run: string;
    if (resuming) {
      run = worktreeId;
    } else {
      run = reconciler.acceptFeature(plan).run;
    }
    // AD-9: taken once, at run start. Idempotent on a resume — a snapshot that already exists reports
    // `already_taken` rather than rewriting one (the module's own docblock), which is what makes calling
    // this unconditionally, on both the fresh and the resumed path, safe rather than a mid-run edit.
    takeConfigSnapshot({ repository: options.repository, runId: run, orchHome });
    if (resuming) {
      // A resumed run may already be past `drafting`; confirming a run that is not still in it is not
      // this call's place to attempt (`Reconciler.confirm`'s own concern), so it is only reached for a
      // run that has not yet been confirmed.
      if (reconciler.load(run).state.state === 'drafting') reconciler.confirm(run);
    } else {
      reconciler.confirm(run);
    }

    const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    const awaitingMergePollIntervalMs =
      options.awaitingMergePollIntervalMs ?? DEFAULT_AWAITING_MERGE_POLL_INTERVAL_MS;
    const maxPasses = options.maxPasses ?? 500;
    let reportedPullRequestUrl = false;

    for (let index = 0; index < maxPasses; index += 1) {
      const result = await reconciler.pass();
      for (const action of result.actions) options.onProgress?.(action);

      if (!reportedPullRequestUrl) {
        const url = pullRequestUrlFrom(readEventLog(runPaths(run, orchHome).eventLog));
        if (url !== null) {
          reportedPullRequestUrl = true;
          options.onPullRequestUrl?.(url);
        }
      }

      const state = reconciler.load(run).state.state;
      if (isTerminalFeatureState(state)) {
        return { run, state, worktree: worktree.path };
      }
      // A step actively running has already been waited out inside `reconciler.pass()` itself — the
      // spawner does not return until the subprocess terminates — so this delay is only ever spent
      // between passes that found nothing new to do, and `awaiting_merge` is spaced out far more than
      // the ordinary case: a pull request never merges faster than a person can act, and the bounded
      // check that pass takes is a real `gh` network call this loop must not hammer.
      await sleep(state === 'awaiting_merge' ? awaitingMergePollIntervalMs : pollIntervalMs);
    }
    throw new Error(
      `Run ${run} did not reach a terminal state within ${String(maxPasses)} passes; the most likely ` +
        'cause is a run parked in `awaiting_merge` with nobody having merged the pull request yet, which ' +
        `is expected and not a defect — resume this run with { run: "${run}" } (or the CLI's own resume ` +
        'flag) rather than starting a new one, which would leave this one parked and forgotten.',
    );
  } finally {
    executor.killAll();
    reconciler.close();
    closeAll();
  }
};
