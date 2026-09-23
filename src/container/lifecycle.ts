/**
 * The three time-ordered rules AD-20 attaches to a container, and the gate AD-31 attaches to the whole
 * boundary.
 *
 * **Removal happens once, at the end.** `--rm` is never composed (see `flags.ts`), because a container
 * that removes itself takes the session transcript with it and `--resume` — the only resumable
 * disposition's only mechanism (AD-8) — has nothing to read. So removal is an action, taken by the
 * AD-32 reconcile sweep when the run's state is terminal, and asking for it earlier is refused rather
 * than quietly obeyed.
 *
 * **Provisioning has network; execution does not.** The threat model's two-phase sandbox separates
 * safety and capability *in time* rather than trading them off: dependencies install with the network
 * on, that phase ends, and execution runs with `--network none`. The sequencer here makes the ordering
 * structural — an execution phase cannot be started before provisioning has finished, and an execution
 * argv that carries a network is refused — because "we run provisioning first" is a convention and a
 * convention is what gets skipped under time pressure.
 *
 * **Branch protection is asserted at run start.** It is the one control in the threat model that
 * survives total agent failure, and it is asserted rather than assumed: a repository whose default
 * branch is unprotected refuses the run, naming the branch. The probe is a port, because verifying
 * server-side protection means talking to a forge and this package talks to no network. With no probe
 * configured the answer is "unverified", and unverified refuses — fail closed, the same direction AD-21
 * takes for redaction.
 *
 * **And the gate.** AD-31 names the container assertion suite as one of three suites required before any
 * unattended run, and it needs a daemon that not every machine has. A skip that leaves no trace is
 * indistinguishable from a pass, and this project has already found five green suites hiding a deleted
 * guard. So the suite records what it did, and {@link containmentVerification} treats the claim
 * "containment is verified" as true only when every one of its conditions holds: the marker parses into
 * the shape the gate reads, it says the assertions ran and passed, its Dockerfile digest still matches,
 * a runtime answers now at or above the Stack table's floor, and it names each of the six
 * {@link REQUIRED_CONTAINMENT_CHECKS}. `npm test` may be green while the stage-1 gate is undeclarable;
 * on a machine whose daemon does not answer, that is the intended and honest state.
 */
import { execFileSync } from 'node:child_process';
import { chmodSync, chownSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { BRANCH_PROTECTION_OUTCOMES, isTerminalFeatureState, makeError } from '../contracts/index.js';
import type {
  BranchProtectionOutcome,
  BranchProtectionReport,
  FeatureState,
  OrchError,
} from '../contracts/index.js';
import { resolveOrchHome, runPaths } from '../runtime/index.js';

import {
  composeRunArgs,
  EXECUTOR_GID,
  EXECUTOR_UID,
  NETWORK_NONE,
  NETWORK_PROVISIONING,
} from './flags.js';
import type { ContainerRunRequest } from './flags.js';
import { createImageResolver, dockerfilePath, hashDockerfileContent } from './image.js';
import { CONTAINER_RUNTIME_MIN_VERSION, CONTAINER_SUBCOMMANDS, probeContainerRuntime } from './runtime.js';
import type { ContainerInvoker, ContainerRuntimeReachability } from './runtime.js';

/** The directory name of a run's session transcript, under `runs/<run-id>/` (AD-9's layout). */
export const SESSION_DIR_NAME = 'session';

/**
 * The run's session directory: the second and last thing a tier-2 container may mount.
 *
 * Under `ORCH_HOME/runs/<run-id>/`, never under the host `HOME` — which is both what AD-9 says about
 * runtime state and what makes the mount allow-list satisfiable at all, since the CLI's own default
 * configuration directory is inside `HOME` and `HOME` may never be mounted.
 */
export const sessionDirFor = (run: string, orchHome: string = resolveOrchHome()): string =>
  join(runPaths(run, orchHome).runDir, SESSION_DIR_NAME);

/**
 * Create the session directory, writable by the container's executor uid, and return it.
 *
 * A bind mount does not create its source: the runtime refuses the invocation with "bind source path
 * does not exist", so without this the first real tier-2 run fails at container start rather than
 * anywhere a test was looking. Nothing else writes this directory — `RunPaths` has no entry for it,
 * because AD-8's transcript is written by the CLI *inside* the container and by nothing on the host.
 *
 * Writability is the same problem story 1-6 solves for the worktree and it is solved the same way: as
 * root, own it as the executor uid; otherwise widen the mode, because a *fixed* foreign uid cannot
 * otherwise write a directory this process owns. A read-only root plus an unwritable
 * `CLAUDE_CONFIG_DIR` is a step that fails on its first line.
 */
export const ensureSessionDir = (sessionDir: string): string => {
  mkdirSync(sessionDir, { recursive: true });
  if (process.getuid?.() === 0) {
    chownSync(sessionDir, EXECUTOR_UID, EXECUTOR_GID);
    chmodSync(sessionDir, 0o700);
    return sessionDir;
  }
  // Execute as well as write: a uid that may write a directory it cannot traverse writes nothing.
  chmodSync(sessionDir, (statSync(sessionDir).mode & 0o777) | 0o007);
  return sessionDir;
};

/** Characters a container name may carry. Everything else in a step name becomes `-`. */
const NAME_SAFE = /[^A-Za-z0-9_.-]/g;

/** `orch-<run>-<step>-<attempt>`: unique per attempt, and greppable by run. */
export const containerNameFor = (run: string, step: string, attempt: number): string =>
  ['orch', run, step, String(attempt)].join('-').replace(NAME_SAFE, '-');

/* ------------------------------------------------------------------ removal */

/** What a removal request decided, and why. A refusal is data here, not an exception. */
export interface RemovalDecision {
  readonly removed: boolean;
  readonly containerName: string;
  readonly reason: string;
}

/** A caller asked to remove a container belonging to a run that is still live. */
export class LiveRunRemovalError extends Error {
  readonly code = 'internal.invariant_violated';
  readonly containerName: string;
  readonly state: FeatureState;
  readonly orchError: OrchError;

  constructor(containerName: string, state: FeatureState) {
    const message =
      `Refusing to remove ${containerName}: its run is in state "${state}", which is not terminal. ` +
      'AD-20 keeps the container until the run reaches a terminal disposition because removing it ' +
      "destroys the session transcript AD-8's resume depends on.";
    super(message);
    this.name = 'LiveRunRemovalError';
    this.containerName = containerName;
    this.state = state;
    this.orchError = makeError(this.code, message, `state ${state} is not terminal`);
  }
}

/**
 * Remove a container, but only if its run has reached a terminal state.
 *
 * This is the shape the AD-32 sweep wants: it walks every container it finds, asks about each, and gets
 * an answer rather than an exception for the ones that are still working. `force` is deliberately not
 * exposed — a container that refuses to stop is a fact for the sweep to record, not something to paper
 * over with a flag.
 */
export const removeContainerIfTerminal = (
  containerName: string,
  state: FeatureState,
  invoke: ContainerInvoker,
): RemovalDecision => {
  if (!isTerminalFeatureState(state)) {
    return {
      removed: false,
      containerName,
      reason: `the run is in state "${state}", which is not terminal; AD-20 keeps the container and its transcript`,
    };
  }
  // Stop first. A run can reach a terminal state — `killed`, or a hand-off — with its container still
  // up, and a removal refuses a running container, so the sweep would report `removed: false` on every
  // pass for ever and the resource AD-32 exists to reclaim would never be reclaimed. `--force` is still
  // not used: a stop the runtime declines is a fact the sweep records, where a forced removal would
  // discard the transcript the stop was waiting to flush.
  const stopped = invoke({ subcommand: CONTAINER_SUBCOMMANDS.stop, args: ['--timeout', '5', containerName] });
  const result = invoke({ subcommand: CONTAINER_SUBCOMMANDS.remove, args: ['--volumes', containerName] });
  if (result.status === 0) {
    return { removed: true, containerName, reason: `the run reached the terminal state "${state}"` };
  }
  const detail = (result.stderr.trim() === '' ? result.stdout : result.stderr).trim();
  if (/no such container/i.test(detail)) {
    return { removed: true, containerName, reason: 'the container was already gone' };
  }
  return {
    removed: false,
    containerName,
    reason: `removal failed: ${detail} (the stop before it reported ${String(stopped.status)})`,
  };
};

/** The strict form: for a caller that believes the run is terminal and wants to be wrong loudly. */
export const removeContainer = (
  containerName: string,
  state: FeatureState,
  invoke: ContainerInvoker,
): RemovalDecision => {
  if (!isTerminalFeatureState(state)) throw new LiveRunRemovalError(containerName, state);
  return removeContainerIfTerminal(containerName, state, invoke);
};

/* --------------------------------------------------- provisioning, then execution */

/** An execution phase was asked for before provisioning finished, or twice. */
export class PhaseOrderError extends Error {
  readonly code = 'internal.invariant_violated';
  readonly orchError: OrchError;

  constructor(detail: string) {
    const message =
      `Refusing to run a tier-2 phase out of order: ${detail}. AD-20's two-phase sandbox has ` +
      'provisioning (network on) end before execution (no general network) begins; running them in ' +
      'the other order, or overlapping them, is an execution phase with network access.';
    super(message);
    this.name = 'PhaseOrderError';
    this.orchError = makeError(this.code, message, detail);
  }
}

/** One composed phase: the argv and which phase it is. */
export interface PhasePlan {
  readonly phase: 'provisioning' | 'execution';
  /** The arguments after the `run` subcommand. */
  readonly args: readonly string[];
  readonly network: string;
}

/** Compose the provisioning phase: the same containment, with a network and an install command. */
export const provisioningPlan = (
  request: Omit<ContainerRunRequest, 'phase'>,
  installCommand: readonly string[],
): PhasePlan => {
  const [command, ...rest] = installCommand;
  if (command === undefined) throw new PhaseOrderError('the provisioning phase was given no command');
  return {
    phase: 'provisioning',
    args: composeRunArgs({ ...request, phase: 'provisioning', command, commandArgs: rest }),
    network: NETWORK_PROVISIONING,
  };
};

/** Compose the execution phase: no general network, and the step's own command. */
export const executionPlan = (request: Omit<ContainerRunRequest, 'phase'>): PhasePlan => ({
  phase: 'execution',
  args: composeRunArgs({ ...request, phase: 'execution' }),
  network: NETWORK_NONE,
});

/** The state a sequencer is in. `provisioned` is the only state execution may start from. */
export type PhaseState = 'fresh' | 'provisioning' | 'provisioned' | 'executing' | 'executed';

/**
 * The ordering, as a state machine rather than a comment.
 *
 * A caller with no dependencies to install calls {@link skipProvisioning}, which is an explicit
 * statement — not the same thing as forgetting to provision, and it still cannot be said after
 * execution has begun.
 */
/** What a provisioning container reported. Only its exit status decides whether provisioning happened. */
export interface PhaseOutcome {
  readonly status: number | null;
  readonly stdout?: string;
  readonly stderr?: string;
}

export interface PhaseSequencer {
  readonly state: () => PhaseState;
  readonly provision: (plan: PhasePlan, outcome: PhaseOutcome) => void;
  readonly skipProvisioning: () => void;
  readonly beginExecution: (plan: PhasePlan) => void;
  readonly endExecution: () => void;
}

export const createPhaseSequencer = (): PhaseSequencer => {
  let state: PhaseState = 'fresh';
  return {
    state: (): PhaseState => state,
    provision: (plan: PhasePlan, outcome: PhaseOutcome): void => {
      if (plan.phase !== 'provisioning') throw new PhaseOrderError('a non-provisioning plan was provisioned');
      if (state !== 'fresh') throw new PhaseOrderError(`provisioning was requested from state "${state}"`);
      // `provisioning` is entered before the outcome is judged, so a provisioning run that failed — or
      // one that was composed and never started — leaves the sequencer in a state execution refuses
      // rather than in `provisioned`. Marking `provisioned` on *composition* authorised execution on
      // the strength of an argv nobody had run.
      state = 'provisioning';
      if (outcome.status !== 0) {
        const detail = (outcome.stderr ?? '').trim() === '' ? (outcome.stdout ?? '').trim() : (outcome.stderr ?? '').trim();
        throw new PhaseOrderError(
          `the provisioning container exited ${String(outcome.status)}${detail === '' ? '' : `: ${detail}`}` +
            ', so its dependencies are not installed and execution — which has no network to install ' +
            'them with — would run against a half-provisioned worktree',
        );
      }
      state = 'provisioned';
    },
    skipProvisioning: (): void => {
      if (state !== 'fresh') throw new PhaseOrderError(`provisioning was skipped from state "${state}"`);
      state = 'provisioned';
    },
    beginExecution: (plan: PhasePlan): void => {
      if (plan.phase !== 'execution') throw new PhaseOrderError('a non-execution plan was executed');
      if (state !== 'provisioned') {
        throw new PhaseOrderError(
          `execution was requested from state "${state}"; provisioning must have ended first`,
        );
      }
      // The *token after* `--network`, and exactly one `--network` in the vector. Testing whether the
      // argv contains the bare word `none` anywhere passes for an argv carrying `--network bridge`
      // beside any label, environment value or path that happens to contain it — and a second
      // `--network` is how a later flag quietly wins over the first.
      const networkFlags = plan.args.filter((token) => token === '--network');
      if (networkFlags.length !== 1) {
        throw new PhaseOrderError(
          `the execution argv carries ${String(networkFlags.length)} --network flags; exactly one is ` +
            'the only way to know which network the runtime will use',
        );
      }
      const network = plan.args[plan.args.indexOf('--network') + 1];
      if (network !== NETWORK_NONE) {
        throw new PhaseOrderError(
          `the execution argv carries --network ${network ?? '<nothing>'} rather than ` +
            `--network ${NETWORK_NONE}; execution has no general network`,
        );
      }
      state = 'executing';
    },
    endExecution: (): void => {
      if (state !== 'executing') throw new PhaseOrderError(`execution ended from state "${state}"`);
      state = 'executed';
    },
  };
};

/* ------------------------------------------------- branch protection at run start */

/**
 * The three-outcome vocabulary, re-exported so this module is the one place a reader looks for branch
 * protection.
 *
 * It is *declared* in `src/contracts/event.ts` because the reconciler records the outcome as a log line
 * and may import only `src/contracts/`, `src/runtime/` and `node:` builtins. The decision is here; the
 * words are where both units may see them.
 */
export { BRANCH_PROTECTION_OUTCOMES };
export type { BranchProtectionOutcome, BranchProtectionReport };

/** What a probe found out about the default branch. */
export interface BranchProtection {
  readonly branch: string;
  readonly protected: boolean;
  readonly forcePushDisabled: boolean;
  readonly deletionDisabled: boolean;
  /** How it was established, for the event log: `probe`, `configured`, or a forge's name. */
  readonly source: string;
}

/**
 * The port branch protection is read through.
 *
 * `null` means "could not be established", which is not the same as "unprotected" and is treated the
 * same way: the run does not start. Implementations belong to the committer story (2-7), which is the
 * unit that holds a forge credential; this package refuses to hold one.
 */
export type BranchProtectionProbe = (repository: string, branch: string) => BranchProtection | null;

/** The default branch is unprotected, or its protection could not be established. */
export class UnprotectedDefaultBranchError extends Error {
  readonly code = 'write.branch_protection_violation';
  readonly branch: string;
  readonly orchError: OrchError;

  constructor(branch: string, detail: string) {
    const message =
      `Refusing to start a run against ${branch}: ${detail}. AD-20 asserts branch protection on the ` +
      'default branch at run start, and the threat model calls protected main the one control that ' +
      'survives total agent failure — so an unverified branch is treated exactly as an unprotected one.';
    super(message);
    this.name = 'UnprotectedDefaultBranchError';
    this.branch = branch;
    this.orchError = makeError(this.code, message, detail);
  }
}

/** The default branch could not even be named. */
export class DefaultBranchUnknownError extends Error {
  readonly code = 'write.branch_protection_violation';
  readonly orchError: OrchError;

  constructor(repository: string, detail: string) {
    const message =
      `Could not determine the default branch of ${repository}: ${detail}. Branch protection is ` +
      'asserted at run start, and an assertion about a branch nobody can name is not an assertion.';
    super(message);
    this.name = 'DefaultBranchUnknownError';
    this.orchError = makeError(this.code, message, detail);
  }
}

/** How long a `git` invocation here may take, matching `src/engine/baseline.ts`'s bound in spirit. */
export const GIT_PROBE_TIMEOUT_MS = 30_000;

/**
 * The remote a default branch is read from when a caller names none.
 *
 * `origin` is git's own convention and is what every existing caller means, so it is a default rather
 * than an assumption — but it is a *parameter*, because the profile's `project.remote` is an arbitrary
 * URL and nothing guarantees the local remote holding it is called `origin`. Reading
 * `refs/remotes/origin/HEAD` on a repository whose remote is named `upstream` answers "no default
 * branch", which under the fail-closed rule refuses a run for the wrong reason.
 */
export const DEFAULT_REMOTE_NAME = 'origin';

/**
 * Read the default branch from the repository: the remote's HEAD first, then `init.defaultBranch`.
 *
 * The remote's HEAD is the honest answer — the default branch is a property of the shared repository,
 * not of this checkout — and a local `HEAD` is deliberately *not* consulted, because inside a feature
 * worktree that is the feature branch and would make the assertion pass by asking the wrong question.
 *
 * The short name is what comes back: `symbolic-ref --short` answers `origin/main`, and the remote
 * prefix is stripped because every caller compares against a *branch*. Returning the full ref would
 * make the assertion ask the forge about a branch called `origin/main`, which does not exist.
 */
export const detectDefaultBranch = (
  repository: string,
  remote: string = DEFAULT_REMOTE_NAME,
): string => {
  const git = (args: readonly string[]): string | null => {
    try {
      return execFileSync('git', ['-C', repository, ...args], {
        encoding: 'utf8',
        timeout: GIT_PROBE_TIMEOUT_MS,
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
    } catch {
      return null;
    }
  };
  const head = `refs/remotes/${remote}/HEAD`;
  const remoteHead = git(['symbolic-ref', '--short', head]);
  if (remoteHead !== null && remoteHead !== '') {
    const prefix = `${remote}/`;
    return remoteHead.startsWith(prefix) ? remoteHead.slice(prefix.length) : remoteHead;
  }
  const configured = git(['config', '--get', 'init.defaultBranch']);
  if (configured !== null && configured !== '') return configured;
  throw new DefaultBranchUnknownError(
    repository,
    `neither ${head} nor init.defaultBranch is set`,
  );
};

export interface BranchProtectionOptions {
  readonly repository: string;
  /** The branch to assert about. Detected from the repository when omitted. */
  readonly defaultBranch?: string;
  /** Which local remote holds the shared repository. `origin` when omitted. */
  readonly remote?: string;
  /** The probe. Omitted means unverified, which refuses. */
  readonly probe?: BranchProtectionProbe;
}

/**
 * The one decision, reached once and read by both callers.
 *
 * {@link assertDefaultBranchProtected} throws from it and {@link checkDefaultBranchProtection} reports
 * it, so the throwing and the reporting path cannot come to different conclusions — which is exactly the
 * split that let a second branch-protection module exist with the opposite policy.
 */
const evaluateDefaultBranchProtection = (
  options: BranchProtectionOptions,
): BranchProtectionReport & { readonly protection: BranchProtection | null } => {
  const unverified = (
    outcome: BranchProtectionOutcome,
    branch: string,
    detail: string,
  ): BranchProtectionReport & { readonly protection: BranchProtection | null } => {
    const error = new UnprotectedDefaultBranchError(branch, detail);
    return { outcome, branch, reason: error.message, refusal: error.orchError, protection: null };
  };

  let branch: string;
  try {
    branch =
      options.defaultBranch ?? detectDefaultBranch(options.repository, options.remote);
  } catch (thrown: unknown) {
    if (!(thrown instanceof DefaultBranchUnknownError)) throw thrown;
    // No branch could be named, so there is nothing to assert about. Unknown, and unknown refuses.
    return {
      outcome: 'unknown',
      branch: null,
      reason: thrown.message,
      refusal: thrown.orchError,
      protection: null,
    };
  }
  const found = options.probe?.(options.repository, branch) ?? null;
  if (found === null) {
    return unverified(
      'unknown',
      branch,
      'its protection could not be established (no branch-protection probe is configured)',
    );
  }
  if (!found.protected) {
    return unverified('unprotected', branch, `the branch is not protected (per ${found.source})`);
  }
  if (!found.forcePushDisabled) {
    return unverified('unprotected', branch, `force-push is permitted on it (per ${found.source})`);
  }
  if (!found.deletionDisabled) {
    return unverified('unprotected', branch, `deletion is permitted on it (per ${found.source})`);
  }
  return {
    outcome: 'protected',
    branch,
    reason: `${branch} is protected, with force-push and deletion disabled (per ${found.source})`,
    refusal: null,
    protection: found,
  };
};

/**
 * Report protection on the default branch without throwing, for the caller that must record the answer
 * before acting on it.
 *
 * The reconciler emits `branch.protection_asserted` and *then* decides whether to refuse, because the one
 * outcome that stops a run was the one outcome an inline throw left unrecorded. Three outcomes come back
 * and two of them refuse; `refusal` carries the AD-35 shape so the recorder and the decider read the same
 * conclusion rather than each re-deriving it.
 */
export const checkDefaultBranchProtection = (
  options: BranchProtectionOptions,
): BranchProtectionReport => {
  const { protection: _protection, ...report } = evaluateDefaultBranchProtection(options);
  return report;
};

/**
 * Assert protection on the default branch, or refuse the run naming the branch.
 *
 * Force-push and deletion are checked as well as the protection flag itself, because "protected" with
 * force-push allowed is protection that the one action this system must never perform can walk through.
 */
export const assertDefaultBranchProtected = (options: BranchProtectionOptions): BranchProtection => {
  const evaluated = evaluateDefaultBranchProtection(options);
  if (evaluated.protection !== null) return evaluated.protection;
  if (evaluated.branch === null) {
    throw new DefaultBranchUnknownError(options.repository, evaluated.refusal?.cause ?? 'unknown');
  }
  throw new UnprotectedDefaultBranchError(
    evaluated.branch,
    evaluated.refusal?.cause ?? 'its protection could not be established',
  );
};

/* ------------------------------------------------------------ the AD-31 gate */

/** The name of the file the assertion suite records its outcome in, under `ORCH_HOME/gates/`. */
export const GATE_DIR_NAME = 'gates';
export const CONTAINMENT_MARKER_FILE_NAME = 'container-assertion.json';

/**
 * The string a skipped assertion suite carries in its own test name.
 *
 * Visible in the test output, and greppable — `tests/container.gate.test.ts` asserts that the suite
 * still records a skip, so deleting the visibility is itself a failing test.
 */
export const CONTAINMENT_SKIP_MARKER = 'AD-31 CONTAINMENT SUITE SKIPPED';

/** `ORCH_HOME/gates/container-assertion.json` — machine state, per AD-9. Never inside a repository. */
export const containmentMarkerPath = (env: NodeJS.ProcessEnv = process.env): string =>
  join(resolveOrchHome(env), GATE_DIR_NAME, CONTAINMENT_MARKER_FILE_NAME);

/** What the assertion suite records about itself. */
export interface ContainmentMarker {
  /** `verified` only when the assertions ran against a real runtime and passed. */
  readonly state: 'verified' | 'skipped' | 'failed';
  readonly at: string;
  /** Why it skipped, or what it proved. */
  readonly reason: string;
  /** The Dockerfile digest the assertions ran against. A changed Dockerfile invalidates the claim. */
  readonly dockerfileHash: string | null;
  readonly imageTag: string | null;
  readonly runtimeVersion: string | null;
  /** The named checks that passed, so the marker says what was proven rather than that something was. */
  readonly checks: readonly string[];
  readonly suite: string;
}

/** Record the assertion suite's outcome. Called on the skip path too — that is the whole point. */
export const recordContainmentMarker = (
  marker: ContainmentMarker,
  env: NodeJS.ProcessEnv = process.env,
): string => {
  const path = containmentMarkerPath(env);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(marker, null, 2)}\n`, 'utf8');
  return path;
};

/** A string, or `''` — the marker's own prose fields say nothing when they are not strings. */
const markerText = (value: unknown): string => (typeof value === 'string' ? value : '');

/** A string, or `null` — an unrecorded digest, tag or version, which every reader already handles. */
const markerNullableText = (value: unknown): string | null =>
  typeof value === 'string' ? value : null;

/**
 * Read the marker, or `null` when the suite has never recorded one on this machine — or wrote one whose
 * shape cannot bear the weight the gate puts on it.
 *
 * `checks` is validated as an array of strings rather than coerced, and this is the second time the same
 * hole has been open here: the first fix taught the gate to check *membership* and left the *type* to
 * `JSON.parse`. A marker whose `checks` is the single string "no-push-credential no-runtime-socket
 * read-only-root non-root-user capabilities-dropped no-host-home" then satisfies every required check by
 * substring — `String.prototype.includes` is the same call on a string as on an array — and reports its
 * length as 99 containment properties. A forged or drifted shape is not a weaker proof; it is no proof,
 * so it reads as an absent marker and the gate refuses.
 */
export const readContainmentMarker = (env: NodeJS.ProcessEnv = process.env): ContainmentMarker | null => {
  try {
    const parsed: unknown = JSON.parse(readFileSync(containmentMarkerPath(env), 'utf8'));
    if (typeof parsed !== 'object' || parsed === null) return null;
    const record = parsed as Record<string, unknown>;
    const state = record['state'];
    if (state !== 'verified' && state !== 'skipped' && state !== 'failed') return null;
    const rawChecks = record['checks'];
    if (!Array.isArray(rawChecks)) return null;
    const checks: string[] = [];
    for (const check of rawChecks) {
      if (typeof check !== 'string') return null;
      checks.push(check);
    }
    return {
      state,
      at: markerText(record['at']),
      reason: markerText(record['reason']),
      dockerfileHash: markerNullableText(record['dockerfileHash']),
      imageTag: markerNullableText(record['imageTag']),
      runtimeVersion: markerNullableText(record['runtimeVersion']),
      checks,
      suite: markerText(record['suite']),
    };
  } catch {
    return null;
  }
};

/** Whether the containment claim may be made, and the one sentence saying why not. */
export interface ContainmentVerification {
  readonly verified: boolean;
  readonly reason: string;
  readonly marker: ContainmentMarker | null;
  readonly runtime: ContainerRuntimeReachability;
  /** The Dockerfile digest as it stands now, which the marker's must match. */
  readonly dockerfileHash: string | null;
}

export interface ContainmentVerificationOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly invoke?: ContainerInvoker;
  /** Overridable so the gate suite can drive a stale-hash case without editing the Dockerfile. */
  readonly dockerfileHash?: string;
}

/** The current Dockerfile's digest, or `null` if it cannot be read. */
export const currentDockerfileHash = (): string | null => {
  try {
    return hashDockerfileContent(readFileSync(dockerfilePath()));
  } catch {
    return null;
  }
};

/**
 * The containment properties a marker must name before the gate may be declared met.
 *
 * This list lives here, beside the reader that enforces it, rather than in the assertion suite that
 * produces it. The suite imports it. One home means a check cannot be added to the prover without the
 * verifier learning about it, which is the drift a `verified` marker listing fewer checks would
 * otherwise hide.
 */
export const REQUIRED_CONTAINMENT_CHECKS = [
  'no-push-credential',
  'no-runtime-socket',
  'read-only-root',
  'non-root-user',
  'capabilities-dropped',
  'no-host-home',
] as const;

export type ContainmentCheck = (typeof REQUIRED_CONTAINMENT_CHECKS)[number];

/**
 * The single authority on whether AD-31's container suite has actually been satisfied here.
 *
 * Five conditions, and the reason each one is a condition:
 *
 * - the marker parses into the shape the gate reads — see {@link readContainmentMarker}; a forged or
 *   drifted shape is no proof rather than a weaker one;
 * - it says `verified` — a skip or a failure is not a pass, and an absent marker is not either;
 * - its `dockerfileHash` matches the Dockerfile now — a hardening edit makes yesterday's proof a proof
 *   about a different sandbox, which AD-11 already treats as a different image;
 * - a runtime answers now, at or above the Stack table's floor — a tier-2 step cannot be confined by a
 *   daemon that is not running, and a daemon that silently ignores a flag it is too old to know is
 *   containment that is not there;
 * - it names every one of the {@link REQUIRED_CONTAINMENT_CHECKS} — all six, so the claim is about the
 *   properties the verifier requires rather than about however many the prover happened to record.
 */
export const containmentVerification = (
  options: ContainmentVerificationOptions = {},
): ContainmentVerification => {
  const env = options.env ?? process.env;
  const marker = readContainmentMarker(env);
  const runtime = probeContainerRuntime({
    env,
    ...(options.invoke === undefined ? {} : { invoke: options.invoke }),
  });
  const hash = options.dockerfileHash ?? currentDockerfileHash();
  const base = { marker, runtime, dockerfileHash: hash };

  if (marker === null) {
    return {
      ...base,
      verified: false,
      reason:
        'the container assertion suite has never recorded an outcome on this machine, so AD-31\'s ' +
        'containment suite is unsatisfied',
    };
  }
  if (marker.state !== 'verified') {
    return {
      ...base,
      verified: false,
      reason: `the container assertion suite last recorded "${marker.state}": ${marker.reason}`,
    };
  }
  if (hash === null || marker.dockerfileHash !== hash) {
    return {
      ...base,
      verified: false,
      reason:
        `the assertions ran against Dockerfile ${marker.dockerfileHash ?? '<unrecorded>'} and the ` +
        `Dockerfile now hashes to ${hash ?? '<unreadable>'}: the proof is about a different image`,
    };
  }
  if (!runtime.reachable) {
    return {
      ...base,
      verified: false,
      reason: `no container runtime answers now (${runtime.detail}), so nothing can be confined`,
    };
  }
  if (!runtime.meetsVersionFloor) {
    return {
      ...base,
      verified: false,
      reason:
        `the runtime that answers now (${runtime.detail}) is below the Stack table's floor of ` +
        `${CONTAINER_RUNTIME_MIN_VERSION}, so a flag in the AD-20 set may be accepted and not honoured`,
    };
  }
  const missingChecks = REQUIRED_CONTAINMENT_CHECKS.filter(
    (check) => !marker.checks.includes(check),
  );
  if (missingChecks.length > 0) {
    // The writer only emits `verified` once every check has passed, but a reader that trusts the
    // word and not the list enforces three of its four properties. The risk is drift rather than
    // forgery: a marker written before a check was added or renamed would otherwise keep vouching
    // for a containment property nothing ever proved.
    return {
      ...base,
      verified: false,
      reason:
        `the marker claims verification but names only ${String(marker.checks.length)} of ` +
        `${String(REQUIRED_CONTAINMENT_CHECKS.length)} required containment checks; missing: ` +
        missingChecks.join(', '),
    };
  }
  return {
    ...base,
    verified: true,
    reason: `the assertion suite proved ${String(marker.checks.length)} containment properties against runtime ${
      marker.runtimeVersion ?? 'unknown'
    } at ${marker.at}`,
  };
};

/** The containment claim was made while the evidence for it is absent. */
export class ContainmentUnverifiedError extends Error {
  readonly code = 'container.isolation_assertion_failed';
  readonly verification: ContainmentVerification;
  readonly orchError: OrchError;

  constructor(verification: ContainmentVerification) {
    const message =
      `The stage-1 containment gate cannot be declared met: ${verification.reason}. AD-31 requires ` +
      'the container assertion suite — no push credential and no runtime socket reachable from ' +
      'inside a tier-2 container — to have passed against a real runtime before any unattended run.';
    super(message);
    this.name = 'ContainmentUnverifiedError';
    this.verification = verification;
    this.orchError = makeError(this.code, message, verification.reason);
  }
}

/**
 * The check an unattended run calls at start. Throws unless containment is actually verified.
 *
 * This is what makes the skip honest rather than documentary: with no runtime here, `npm test` is green
 * and this function still refuses, so the gate is undeclarable exactly while the marker says it should
 * be.
 */
export const assertContainmentVerified = (
  options: ContainmentVerificationOptions = {},
): ContainmentVerification => {
  const verification = containmentVerification(options);
  if (!verification.verified) throw new ContainmentUnverifiedError(verification);
  return verification;
};

/** The image resolver an engine gets when it has not built one: over this repository's Dockerfile. */
export const defaultImageResolver = (invoke: ContainerInvoker): ReturnType<typeof createImageResolver> =>
  createImageResolver({ invoke });
