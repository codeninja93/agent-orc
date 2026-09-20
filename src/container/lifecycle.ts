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
 * unattended run. This machine cannot run it — the runtime binary is installed and its daemon does not
 * answer — so the suite skips. A skip that leaves no trace is indistinguishable from a pass, and this
 * project has already found five green suites hiding a deleted guard. So the suite records what it did,
 * and {@link containmentVerification} treats the claim "containment is verified" as true only when all
 * three of these hold: the marker says the assertions ran and passed, the Dockerfile has not changed
 * since, and a runtime answers now. `npm test` may be green while the stage-1 gate is undeclarable;
 * that is the intended, honest state of this machine today.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { isTerminalFeatureState, makeError } from '../contracts/index.js';
import type { FeatureState, OrchError } from '../contracts/index.js';
import { resolveOrchHome, runPaths } from '../runtime/index.js';

import { composeRunArgs, NETWORK_NONE, NETWORK_PROVISIONING } from './flags.js';
import type { ContainerRunRequest } from './flags.js';
import { createImageResolver, dockerfilePath, hashDockerfileContent } from './image.js';
import { CONTAINER_SUBCOMMANDS, probeContainerRuntime } from './runtime.js';
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
  const result = invoke({ subcommand: CONTAINER_SUBCOMMANDS.remove, args: ['--volumes', containerName] });
  if (result.status === 0) {
    return { removed: true, containerName, reason: `the run reached the terminal state "${state}"` };
  }
  const detail = (result.stderr.trim() === '' ? result.stdout : result.stderr).trim();
  if (/no such container/i.test(detail)) {
    return { removed: true, containerName, reason: 'the container was already gone' };
  }
  return { removed: false, containerName, reason: `removal failed: ${detail}` };
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
export interface PhaseSequencer {
  readonly state: () => PhaseState;
  readonly provision: (plan: PhasePlan) => void;
  readonly skipProvisioning: () => void;
  readonly beginExecution: (plan: PhasePlan) => void;
  readonly endExecution: () => void;
}

export const createPhaseSequencer = (): PhaseSequencer => {
  let state: PhaseState = 'fresh';
  return {
    state: (): PhaseState => state,
    provision: (plan: PhasePlan): void => {
      if (plan.phase !== 'provisioning') throw new PhaseOrderError('a non-provisioning plan was provisioned');
      if (state !== 'fresh') throw new PhaseOrderError(`provisioning was requested from state "${state}"`);
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
      if (!plan.args.includes(NETWORK_NONE)) {
        throw new PhaseOrderError(
          `the execution argv does not carry --network ${NETWORK_NONE}; execution has no general network`,
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
 * Read the default branch from the repository: the remote's HEAD first, then `init.defaultBranch`.
 *
 * The remote's HEAD is the honest answer — the default branch is a property of the shared repository,
 * not of this checkout — and a local `HEAD` is deliberately *not* consulted, because inside a feature
 * worktree that is the feature branch and would make the assertion pass by asking the wrong question.
 */
export const detectDefaultBranch = (repository: string): string => {
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
  const remoteHead = git(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
  if (remoteHead !== null && remoteHead !== '') {
    return remoteHead.startsWith('origin/') ? remoteHead.slice('origin/'.length) : remoteHead;
  }
  const configured = git(['config', '--get', 'init.defaultBranch']);
  if (configured !== null && configured !== '') return configured;
  throw new DefaultBranchUnknownError(
    repository,
    'neither refs/remotes/origin/HEAD nor init.defaultBranch is set',
  );
};

export interface BranchProtectionOptions {
  readonly repository: string;
  /** The branch to assert about. Detected from the repository when omitted. */
  readonly defaultBranch?: string;
  /** The probe. Omitted means unverified, which refuses. */
  readonly probe?: BranchProtectionProbe;
}

/**
 * Assert protection on the default branch, or refuse the run naming the branch.
 *
 * Force-push and deletion are checked as well as the protection flag itself, because "protected" with
 * force-push allowed is protection that the one action this system must never perform can walk through.
 */
export const assertDefaultBranchProtected = (options: BranchProtectionOptions): BranchProtection => {
  const branch = options.defaultBranch ?? detectDefaultBranch(options.repository);
  const found = options.probe?.(options.repository, branch) ?? null;
  if (found === null) {
    throw new UnprotectedDefaultBranchError(
      branch,
      'its protection could not be established (no branch-protection probe is configured)',
    );
  }
  if (!found.protected) {
    throw new UnprotectedDefaultBranchError(branch, `the branch is not protected (per ${found.source})`);
  }
  if (!found.forcePushDisabled) {
    throw new UnprotectedDefaultBranchError(branch, `force-push is permitted on it (per ${found.source})`);
  }
  if (!found.deletionDisabled) {
    throw new UnprotectedDefaultBranchError(branch, `deletion is permitted on it (per ${found.source})`);
  }
  return found;
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

/** Read the marker, or `null` when the suite has never recorded one on this machine. */
export const readContainmentMarker = (env: NodeJS.ProcessEnv = process.env): ContainmentMarker | null => {
  try {
    const parsed: unknown = JSON.parse(readFileSync(containmentMarkerPath(env), 'utf8'));
    if (typeof parsed !== 'object' || parsed === null) return null;
    const record = parsed as Partial<ContainmentMarker>;
    if (record.state !== 'verified' && record.state !== 'skipped' && record.state !== 'failed') return null;
    return {
      state: record.state,
      at: record.at ?? '',
      reason: record.reason ?? '',
      dockerfileHash: record.dockerfileHash ?? null,
      imageTag: record.imageTag ?? null,
      runtimeVersion: record.runtimeVersion ?? null,
      checks: record.checks ?? [],
      suite: record.suite ?? '',
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
 * The single authority on whether AD-31's container suite has actually been satisfied here.
 *
 * Three conditions, and the reason each one is a condition:
 *
 * - the marker says `verified` — a skip or a failure is not a pass, and an absent marker is not either;
 * - its `dockerfileHash` matches the Dockerfile now — a hardening edit makes yesterday's proof a proof
 *   about a different sandbox, which AD-11 already treats as a different image;
 * - a runtime answers now — a tier-2 step cannot be confined by a daemon that is not running, so a
 *   stale pass must not authorise an unattended run on a machine that has since lost its runtime.
 */
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
