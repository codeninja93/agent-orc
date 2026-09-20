/**
 * AD-20's flag set, as data.
 *
 * The spine states the containment in prose: "read-only root filesystem, tmpfs for temp, only the run
 * worktree and its session directory mounted — never `HOME`, ssh or cloud credential paths — non-root
 * user, all capabilities dropped, no-new-privileges, seccomp profile, memory and pid limits". Prose
 * cannot be asserted, and CAP-10's success criterion is a passing test, so every one of those clauses
 * is a value here and the argument vector is *composed* from those values.
 *
 * The test that matters asserts the composed argv, not this table. A test that re-states the list it
 * was built from proves only that the list exists — story 1-4 learned the same lesson at its own seam
 * and now asserts the vector its child actually received.
 *
 * Three rules in here are refusals rather than defaults, because a default can be overridden by a
 * caller in a hurry and a refusal cannot:
 *
 * - **The mount allow-list is positive.** A mount is legal only if its source is the run worktree or
 *   the run's session directory (or a path under one of them). Everything else is refused by name.
 *   A deny-list alone would be a list of the escapes someone thought of; the allow-list is the
 *   containment, and the deny-list is the second signal that names *why* a particular path is refused.
 * - **The container's environment is built, never inherited.** The executor holds no push credential
 *   (AD-20) and no secret reaches an agent context (threat model §3.2). Inheriting the engine's
 *   environment and subtracting the names we remembered is the wrong direction; the container gets an
 *   allow-listed set, and a credential-shaped name is refused even when it carries the `ORCH_` prefix.
 * - **`--rm` cannot be composed at all.** AD-20 forbids it while a run is live because it destroys the
 *   session transcript AD-8 resumes from. Removal is `lifecycle.ts`, gated on a terminal disposition.
 *
 * The one flag here that is not in AD-20's list is `--init`. It is not a permission and widens nothing:
 * it gives the container a real init process so a signalled step exits `128 + n` instead of being
 * reported as a plain failure, which is exactly the fidelity `signalFromExitCode` in story 1-4 depends
 * on. Without it `interrupted` — the only resumable disposition — becomes unreachable through the
 * wrapper.
 *
 * Nothing here names the container runtime. The socket paths the deny-list needs come from
 * `runtime.ts`, which is the only file allowed to spell them.
 */
import { isAbsolute, join, relative, sep } from 'node:path';

import { makeError } from '../contracts/index.js';
import type { OrchError } from '../contracts/index.js';

import { RUNTIME_PATH_MARKERS, RUNTIME_SOCKET_PATHS, runtimeUserPaths } from './runtime.js';

/**
 * The flags the composed argv must carry for a tier-2 container, asserted by the suite.
 *
 * Names only, as story 1-4's `AD1_REQUIRED_FLAGS` does: presence is one assertion, and the *values*
 * (`ALL` for the dropped capabilities, a profile that is not `unconfined` for seccomp) are asserted
 * separately, because a flag present with a permissive value is the failure a name check misses.
 */
export const AD20_REQUIRED_FLAGS = [
  '--read-only',
  '--tmpfs',
  '--user',
  '--cap-drop',
  '--security-opt',
  '--memory',
  '--pids-limit',
  '--network',
] as const;

export type Ad20Flag = (typeof AD20_REQUIRED_FLAGS)[number];

/**
 * Flags this composer refuses to emit, each with the reason a refusal names.
 *
 * `--rm` is AD-20's own prohibition. `--detach` is here for a different reason: a detached invocation
 * returns the container id and exit code 0 immediately, so story 1-4 would record every step as a
 * clean success the instant it started. The rest would undo the containment.
 */
export const FORBIDDEN_RUN_FLAG_REASONS: Readonly<Record<string, string>> = {
  '--rm':
    'AD-20 forbids it while a run is live: it would destroy the session transcript AD-8 resumes ' +
    'from. Removal is a terminal-disposition action in lifecycle.ts',
  '-d': 'a detached invocation reports success the moment the container starts, so every step would record as completed',
  '--detach':
    'a detached invocation reports success the moment the container starts, so every step would record as completed',
  '--privileged': 'it hands the container every capability the host has, which is the whole boundary',
  '--pid=host': 'it puts the container in the host pid namespace, where it can signal host processes',
  '--network=host': 'it puts the container on the host network, which is the egress the two-phase sandbox removes',
  '--cap-add': 'AD-20 drops all capabilities; adding one back is a widening the flag set does not permit',
};

/** The flags {@link composeRunArgs} refuses to emit. */
export const FORBIDDEN_RUN_FLAGS: readonly string[] = Object.keys(FORBIDDEN_RUN_FLAG_REASONS);

/**
 * The uid:gid the image's non-root user is created with. Asserted against `id -u` by the AD-31 suite.
 *
 * It matches the user `docker/Dockerfile` creates, so the container has a passwd entry and a home. One
 * consequence belongs to whoever creates worktrees (story 1-6): a bind-mounted worktree owned by the
 * host user is not writable by uid 10001 on Linux, so the worktree must be created writable by this uid.
 * Solving it here by passing the host's uid instead would make the flag set depend on who ran the
 * engine, and the suite could then no longer assert a fixed non-root user.
 */
export const EXECUTOR_UID = 10_001;
export const EXECUTOR_GID = 10_001;
export const EXECUTOR_USER = `${String(EXECUTOR_UID)}:${String(EXECUTOR_GID)}`;

/** The in-container `HOME`. On tmpfs, so it exists and is writable while holding nothing of the host's. */
export const CONTAINER_HOME = '/home/orch';

/**
 * The tmpfs mounts AD-20 requires for temporary space.
 *
 * `size=` so a runaway step cannot exhaust host memory through a filesystem, `noexec,nosuid,nodev` so
 * the one writable place outside the worktree is not a place to stage a binary, and `mode=1777` because
 * the container runs as uid 10001 and a tmpfs mounted root-owned would leave it with no writable home
 * at all — a read-only root plus an unwritable `HOME` is a step that fails on its first log line.
 */
export const TMPFS_MOUNTS: readonly string[] = [
  '/tmp:rw,noexec,nosuid,nodev,mode=1777,size=512m',
  `${CONTAINER_HOME}:rw,noexec,nosuid,nodev,mode=1777,size=64m`,
];

/**
 * The seccomp profile.
 *
 * `builtin` selects the runtime's own default profile — the one that blocks the ~40 syscalls behind
 * the known container escapes. A path to a profile in this repository is the other legal value. The
 * one value that is refused is `unconfined`, which is how "a seccomp profile is configured" becomes
 * true while no profile is in force.
 */
export const DEFAULT_SECCOMP_PROFILE = 'builtin';

/** The seccomp value that is a hole rather than a profile. */
export const REFUSED_SECCOMP_PROFILE = 'unconfined';

/** AD-20's memory and pid limits. Defaults, overridable upward by the caller's resource request. */
export const DEFAULT_MEMORY_LIMIT = '2g';
export const DEFAULT_PIDS_LIMIT = 512;

/** The two network modes the two phases run in. Execution has no general network (AD-20, §3.1). */
export const NETWORK_NONE = 'none';
export const NETWORK_PROVISIONING = 'bridge';

/** Label keys, so the AD-32 reclamation sweep can find a container without parsing its name. */
export const LABEL_KEYS = {
  run: 'orch.run',
  step: 'orch.step',
  attempt: 'orch.attempt',
  tier: 'orch.tier',
  phase: 'orch.phase',
} as const;

/** One bind mount. `readonly` is the default everywhere except the worktree a step must edit. */
export interface MountSpec {
  readonly source: string;
  readonly target: string;
  readonly readOnly: boolean;
}

/** Which of the two phases a composed invocation belongs to. */
export type ContainerPhase = 'provisioning' | 'execution';

/** The environment names a container is allowed to receive, beyond the ones composed here. */
export const ENV_ALLOW_PREFIXES: readonly string[] = ['ORCH_'];

/** Names that are always allowed: locale and terminal shape carry nothing. */
export const ENV_ALLOW_NAMES: readonly string[] = ['LANG', 'LC_ALL', 'TZ', 'TERM', 'CI'];

/**
 * Names that are refused however they arrive.
 *
 * The patterns are shapes rather than a list of products, because the next credential this system
 * meets will have a name nobody here has seen. The explicit names are the ones whose shape does not
 * announce itself — `SSH_AUTH_SOCK` is an agent socket, `GIT_ASKPASS` is a push credential with a
 * harmless-looking name.
 */
export const CREDENTIAL_ENV_PATTERNS: readonly RegExp[] = [
  /TOKEN/i,
  /SECRET/i,
  /PASSW/i,
  /CREDENTIAL/i,
  /API[-_]?KEY/i,
  /(^|_)KEY$/i,
  /AUTH/i,
  /COOKIE/i,
  /PRIVATE/i,
  /SESSION_?ID/i,
];

/** Credential-bearing names whose shape the patterns above would not catch. */
export const CREDENTIAL_ENV_NAMES: readonly string[] = [
  'SSH_AUTH_SOCK',
  'GIT_ASKPASS',
  'GIT_SSH_COMMAND',
  'GIT_CONFIG_GLOBAL',
  'AWS_PROFILE',
  'AWS_WEB_IDENTITY_TOKEN_FILE',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'DOCKER_HOST',
  'NPM_CONFIG_USERCONFIG',
  'NETRC',
];

/** True when a name is credential-shaped and must never reach a container. */
export const isCredentialEnvName = (name: string): boolean =>
  CREDENTIAL_ENV_NAMES.includes(name.toUpperCase()) ||
  CREDENTIAL_ENV_PATTERNS.some((pattern) => pattern.test(name));

/**
 * Path fragments that mark a mount as forbidden regardless of the allow-list.
 *
 * The allow-list already refuses every one of these. They are named anyway so a refusal says *what*
 * was nearly mounted — "the host's ssh directory" reads differently from "a path outside the
 * worktree", and the first is the one worth an incident.
 */
export const FORBIDDEN_MOUNT_MARKERS: readonly string[] = [
  '/.ssh',
  '/.aws',
  '/.azure',
  '/.kube',
  '/.gnupg',
  '/.netrc',
  '/.git-credentials',
  '/.gitconfig',
  '/.npmrc',
  '/.claude',
  '/.config/gcloud',
  '/.config/gh',
  ...RUNTIME_PATH_MARKERS,
];

/** A mount that was asked for and refused. `abandon-and-hand-off` — there is no safe retry of this. */
export class MountDisciplineError extends Error {
  readonly code = 'container.isolation_assertion_failed';
  readonly mount: MountSpec;
  readonly orchError: OrchError;

  constructor(mount: MountSpec, reason: string) {
    const message =
      `Refusing to mount ${mount.source} into a tier-2 container: ${reason}. ` +
      'AD-20 allows exactly the run worktree and its session directory, and never HOME, an ssh ' +
      'path, a cloud credential path or the container runtime\'s own socket.';
    super(message);
    this.name = 'MountDisciplineError';
    this.mount = mount;
    this.orchError = makeError(this.code, message, reason);
  }
}

/** A credential-shaped value was about to be handed to a container. */
export class CredentialLeakError extends Error {
  readonly code = 'container.isolation_assertion_failed';
  readonly variable: string;
  readonly orchError: OrchError;

  constructor(variable: string) {
    const message =
      `Refusing to pass ${variable} into a tier-2 container: its name is credential-shaped, and ` +
      'AD-20 gives the executor no push credential and no production credential. Only the gated ' +
      'committer holds a credential that can write outside the worktree.';
    super(message);
    this.name = 'CredentialLeakError';
    this.variable = variable;
    this.orchError = makeError(this.code, message, `${variable} is credential-shaped`);
  }
}

/** A flag AD-20 forbids was about to be composed. */
export class ForbiddenFlagError extends Error {
  readonly code = 'container.isolation_assertion_failed';
  readonly flag: string;
  readonly orchError: OrchError;

  constructor(flag: string, reason: string) {
    const message = `Refusing to compose ${flag} for a tier-2 container: ${reason}`;
    super(message);
    this.name = 'ForbiddenFlagError';
    this.flag = flag;
    this.orchError = makeError(this.code, message, reason);
  }
}

/** `true` when `child` is `parent` or lies under it. Path comparison only; nothing is resolved. */
export const isWithin = (parent: string, child: string): boolean => {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
};

/** The two directories a tier-2 container may see, and nothing else. */
export interface MountAllowList {
  /** `ORCH_HOME/worktrees/<run-id>` — the checkout the step edits. */
  readonly worktree: string;
  /** The run's session directory: the transcript AD-8's resume reads back. */
  readonly sessionDir: string;
}

/**
 * Refuse every mount that is not inside the allow-list, naming the reason.
 *
 * Called by the composer before an argv exists, so a forbidden mount never becomes a flag that a later
 * assertion has to notice.
 */
export const assertMountsAllowed = (
  mounts: readonly MountSpec[],
  allow: MountAllowList,
  home: string = process.env['HOME'] ?? '',
): void => {
  const forbiddenExact = [...RUNTIME_SOCKET_PATHS, ...runtimeUserPaths(home === '' ? undefined : home)];
  for (const mount of mounts) {
    if (home !== '' && (mount.source === home || mount.source === join(home, ''))) {
      throw new MountDisciplineError(mount, 'it is the host HOME directory');
    }
    for (const marker of FORBIDDEN_MOUNT_MARKERS) {
      if (mount.source.includes(marker) || mount.target.includes(marker)) {
        throw new MountDisciplineError(mount, `it names ${marker}, a credential or runtime path`);
      }
    }
    for (const exact of forbiddenExact) {
      if (isWithin(exact, mount.source)) {
        throw new MountDisciplineError(mount, `it is inside ${exact}, which belongs to the runtime`);
      }
    }
    if (!isWithin(allow.worktree, mount.source) && !isWithin(allow.sessionDir, mount.source)) {
      throw new MountDisciplineError(
        mount,
        `it is neither the run worktree (${allow.worktree}) nor the run's session directory ` +
          `(${allow.sessionDir})`,
      );
    }
  }
};

/** The mounts AD-20 permits, in the order the argv carries them. */
export const composeMounts = (allow: MountAllowList): readonly MountSpec[] => [
  // The worktree is the one writable mount: a step's whole output is edits inside it (AD-23).
  { source: allow.worktree, target: allow.worktree, readOnly: false },
  // The session transcript must be writable or `--resume` has nothing to read back (AD-8).
  { source: allow.sessionDir, target: allow.sessionDir, readOnly: false },
];

/**
 * Build the container's environment from an allow-list.
 *
 * The worktree and the session directory are mounted at their *host* paths, so every path already in
 * the CLI argv — the typed input file, the session directory, an MCP config inside the worktree —
 * resolves inside the container without translation. That is why no path rewriting happens anywhere in
 * this package: the one thing that would need it is the interpreter, and the wrapper substitutes the
 * image's own CLI for the host's rather than rewriting its arguments.
 */
export const composeContainerEnv = (
  request: ContainerRunRequest,
): Readonly<Record<string, string>> => {
  const composed: Record<string, string> = {
    HOME: CONTAINER_HOME,
    // The CLI writes its session transcript here, which is the directory AD-8's resume reads.
    CLAUDE_CONFIG_DIR: request.sessionDir,
    ORCH_RUN: request.run,
    ORCH_STEP: request.step,
    ORCH_TIER: '2',
    ORCH_CONTAINED: '1',
  };
  for (const [name, value] of Object.entries(request.env ?? {})) {
    if (value === undefined) continue;
    // The order matters. A host environment always holds credential-shaped names — the engine's own
    // process has them — and refusing the whole spawn because `GITHUB_TOKEN` exists on the machine
    // would make the wrapper unusable. Those names are simply never passed. A credential-shaped name
    // that the allow-list *would* have let through is the real event, and it is refused loudly: an
    // `ORCH_GITHUB_TOKEN` is somebody deliberately handing the executor a push credential.
    const allowed =
      ENV_ALLOW_NAMES.includes(name) || ENV_ALLOW_PREFIXES.some((prefix) => name.startsWith(prefix));
    if (!allowed) continue;
    if (isCredentialEnvName(name)) throw new CredentialLeakError(name);
    composed[name] = value;
  }
  // The composed set is checked too, so a future entry added above cannot introduce a credential name.
  for (const name of Object.keys(composed)) {
    if (isCredentialEnvName(name)) throw new CredentialLeakError(name);
  }
  return composed;
};

/** Everything the composer needs. A caller states intent; every flag is derived here. */
export interface ContainerRunRequest {
  /** The content-hash tag from `image.ts`. Never a registry reference. */
  readonly image: string;
  readonly run: string;
  readonly step: string;
  readonly attempt: number;
  /** The container's name, so removal at a terminal disposition can find it (AD-32). */
  readonly containerName: string;
  readonly worktree: string;
  readonly sessionDir: string;
  /** The command inside the container. The wrapper passes the image's own CLI, never a host path. */
  readonly command: string;
  readonly commandArgs: readonly string[];
  /** Candidate environment entries. Filtered by {@link composeContainerEnv}. */
  readonly env?: NodeJS.ProcessEnv;
  /** `execution` has no network; `provisioning` is the one phase that does (AD-20, AD-11). */
  readonly phase?: ContainerPhase;
  readonly memoryLimit?: string;
  readonly pidsLimit?: number;
  readonly seccompProfile?: string;
  /** The host `HOME`, so the deny-list can refuse it by value. Defaults to the process environment. */
  readonly home?: string;
}

/**
 * Compose the arguments that follow the `run` subcommand.
 *
 * Order is stable so a suite can assert positions as well as membership: identity and labels, then the
 * hardening, then the mounts, then the environment, then the image and the command. The image is
 * always the last element before the command, which is what makes "no flag was appended after the
 * image, where the runtime would pass it to the container instead" checkable.
 */
export const composeRunArgs = (request: ContainerRunRequest): readonly string[] => {
  const phase: ContainerPhase = request.phase ?? 'execution';
  const seccomp = request.seccompProfile ?? DEFAULT_SECCOMP_PROFILE;
  if (seccomp === REFUSED_SECCOMP_PROFILE) {
    throw new ForbiddenFlagError(
      `--security-opt seccomp=${REFUSED_SECCOMP_PROFILE}`,
      'AD-20 requires a seccomp profile, and "unconfined" is the absence of one',
    );
  }
  if (request.image.includes('/')) {
    throw new ForbiddenFlagError(
      request.image,
      'AD-11 forbids a registry reference; the image is built locally and tagged by the ' +
        "Dockerfile's content hash",
    );
  }

  const mounts = composeMounts({ worktree: request.worktree, sessionDir: request.sessionDir });
  assertMountsAllowed(mounts, { worktree: request.worktree, sessionDir: request.sessionDir }, request.home);
  const env = composeContainerEnv(request);

  const args: string[] = [
    '--name',
    request.containerName,
    '--label',
    `${LABEL_KEYS.run}=${request.run}`,
    '--label',
    `${LABEL_KEYS.step}=${request.step}`,
    '--label',
    `${LABEL_KEYS.attempt}=${String(request.attempt)}`,
    '--label',
    `${LABEL_KEYS.tier}=2`,
    '--label',
    `${LABEL_KEYS.phase}=${phase}`,
    // AD-11: the image exists locally or the invocation fails. Nothing is ever pulled.
    '--pull',
    'never',
    // Exit-code fidelity for story 1-4's `signalFromExitCode`; see this file's header.
    '--init',
    '--read-only',
    ...TMPFS_MOUNTS.flatMap((mount) => ['--tmpfs', mount]),
    '--user',
    EXECUTOR_USER,
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    '--security-opt',
    `seccomp=${seccomp}`,
    '--memory',
    request.memoryLimit ?? DEFAULT_MEMORY_LIMIT,
    // Equal to the memory limit, so the limit cannot be escaped into swap.
    '--memory-swap',
    request.memoryLimit ?? DEFAULT_MEMORY_LIMIT,
    '--pids-limit',
    String(request.pidsLimit ?? DEFAULT_PIDS_LIMIT),
    '--network',
    phase === 'provisioning' ? NETWORK_PROVISIONING : NETWORK_NONE,
    ...mounts.flatMap((mount) => [
      '--mount',
      `type=bind,source=${mount.source},target=${mount.target}${mount.readOnly ? ',readonly' : ''}`,
    ]),
    ...Object.entries(env).flatMap(([name, value]) => ['--env', `${name}=${value}`]),
    '--workdir',
    request.worktree,
    request.image,
    request.command,
    ...request.commandArgs,
  ];

  // A self-check on the vector this function just built, rather than a comment claiming it is clean.
  // The image is the boundary: anything after it is the container's own command line, where a string
  // that happens to look like a flag is an argument to the step, not a flag to the runtime.
  const runtimeFlags = args.slice(0, args.indexOf(request.image));
  for (const flag of FORBIDDEN_RUN_FLAGS) {
    if (runtimeFlags.includes(flag)) {
      throw new ForbiddenFlagError(flag, FORBIDDEN_RUN_FLAG_REASONS[flag] ?? 'it is not permitted');
    }
  }
  return args;
};

/** Which of {@link AD20_REQUIRED_FLAGS} an argv is missing. Empty means the flag set holds. */
export const missingAd20Flags = (argv: readonly string[]): readonly Ad20Flag[] =>
  AD20_REQUIRED_FLAGS.filter((flag) => !argv.includes(flag));

/** The mount arguments of a composed argv, parsed back out for assertion. */
export const mountsOf = (argv: readonly string[]): readonly string[] =>
  argv.flatMap((value, index) => (argv[index - 1] === '--mount' || argv[index - 1] === '-v' ? [value] : []));

/** The `--env` arguments of a composed argv, parsed back out for assertion. */
export const envEntriesOf = (argv: readonly string[]): readonly string[] =>
  argv.flatMap((value, index) => (argv[index - 1] === '--env' || argv[index - 1] === '-e' ? [value] : []));
