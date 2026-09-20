/**
 * AD-20 — the one file in this repository that names the container runtime.
 *
 * Every other unit composes *intent*: a tier, a worktree, a session directory, a request to remove a
 * container whose run has finished. The name of the binary, its subcommands, the path of its socket
 * and the single code path that executes it live here and nowhere else, because AD-20's guarantee is
 * not "the flags are right" but "there is exactly one place the boundary is defined". A second place
 * that knows the name is a second place that can quietly compose a flag, and story 1-4's engine guard
 * — no file under `src/engine/` may contain the runtime's name, comments included — exists for the
 * same reason from the other side.
 *
 * Three consequences of that are load-bearing:
 *
 * **The socket paths are declared here, not in `flags.ts`.** The mount deny-list has to name the
 * runtime's socket, and naming it is naming the runtime. So the deny-list imports the paths from this
 * module; `flags.ts` never spells them. The highest-value escape path in the threat model (§3.1, "No
 * docker socket, ever") is therefore refused by a list that lives beside the only code that could
 * mount it.
 *
 * **Reachability is a fact this module reports, never one it assumes.** A missing binary and an
 * unreachable daemon are different states with different consequences: the first is an install
 * problem, the second is the state this machine is in today, and AD-31's container suite must skip
 * *visibly* rather than silently pass in either. So the probe returns a value describing what it
 * found, and no caller infers reachability from an exception it happened not to catch.
 *
 * **Execution is one function.** `createContainerInvoker` is the only place a container process is
 * started by this package, and it is injectable so that image resolution, removal and the tier
 * selection above them can be asserted with no daemon at all — which is the only way those units
 * could be tested on this machine.
 *
 * This module never composes a `run` flag: that is `flags.ts`, and the split is deliberate. Flags are
 * data to be asserted; the runtime is a name to be contained.
 */
import { execFileSync } from 'node:child_process';
import { accessSync, constants as fsConstants, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, isAbsolute, join } from 'node:path';

import { makeError } from '../contracts/index.js';
import type { OrchError } from '../contracts/index.js';

/**
 * The machine-scope override for the runtime binary (AD-34 puts the endpoint in machine config).
 *
 * A name rather than a full command line: the invoker never passes a string to a shell, so an
 * override cannot smuggle arguments past the flag composer.
 */
export const CONTAINER_RUNTIME_ENV_VAR = 'ORCH_CONTAINER_RUNTIME';

/** The runtime the Stack table names: Docker Engine `>=29.7`. */
export const DEFAULT_CONTAINER_RUNTIME = 'docker';

/** The Stack table's floor, as `major.minor`. Reported by the probe; never silently ignored. */
export const CONTAINER_RUNTIME_MIN_VERSION = '29.7';

/**
 * The runtime's own control socket, in every place it is conventionally found.
 *
 * Mounting any of these into an executor is root on the host — the threat model calls it "the single
 * highest-value escape path". `flags.ts` refuses a mount whose source or target matches one of these
 * and the AD-31 suite proves none of them is reachable from inside a running container.
 */
export const RUNTIME_SOCKET_PATHS: readonly string[] = [
  '/var/run/docker.sock',
  '/run/docker.sock',
  '/var/run/containerd/containerd.sock',
  '/run/containerd/containerd.sock',
  '/var/run/podman/podman.sock',
  '/run/podman/podman.sock',
];

/**
 * Per-user runtime state and credentials belonging to the runtime itself.
 *
 * `~/.docker/config.json` holds registry credentials and, with Docker Desktop, the user socket lives
 * under the same directory — so the whole directory is denied rather than the one file.
 */
export const runtimeUserPaths = (home: string = homedir()): readonly string[] => [
  join(home, '.docker'),
  join(home, '.podman'),
  join(home, '.config', 'containers'),
];

/** The substrings that make a path "the runtime's own", for a deny-list check that survives a rename. */
export const RUNTIME_PATH_MARKERS: readonly string[] = ['docker.sock', 'containerd.sock', 'podman.sock'];

/**
 * Where the image's build definition lives, relative to the package root.
 *
 * Here rather than in `image.ts` for the same reason the socket paths are: the directory is named after
 * the runtime, and this is the one file allowed to name it. `image.ts` owns what the file *means* — its
 * hash, its tag, when it is rebuilt — and imports where it is.
 */
export const DOCKERFILE_RELATIVE_PATH = join('docker', 'Dockerfile');

/**
 * The subcommands this package uses, spelled once.
 *
 * `image inspect` rather than `images` because the question asked is always "is this exact tag here",
 * and `build` carries no `--pull`: AD-11 forbids a registry, and a `--pull` on a build is how a base
 * image silently becomes a network dependency of execution rather than of provisioning.
 */
export const CONTAINER_SUBCOMMANDS = {
  run: ['run'] as const,
  build: ['build'] as const,
  remove: ['rm'] as const,
  /**
   * `exec` and `stop` exist for a leased service (`service.ts`), never for a step.
   *
   * A step is one invocation whose exit code is its disposition (AD-8), so there is nothing to exec
   * into and nothing to stop. A leased instance is the opposite: it is started detached and its
   * readiness probe, its wipe and its emptiness check are all commands run inside it, so CAP-11's
   * "returned and verified empty" is unreachable without these two. They are spelled here rather than
   * beside the flags that use them, because this is the file AD-20 allows to name the runtime's
   * vocabulary.
   */
  exec: ['exec'] as const,
  stop: ['stop'] as const,
  inspectImage: ['image', 'inspect'] as const,
  inspectContainer: ['container', 'inspect'] as const,
  info: ['info'] as const,
  version: ['version'] as const,
} as const;

/** How long a single control-plane invocation (`info`, `image inspect`, `rm`) may take. */
export const CONTAINER_CONTROL_TIMEOUT_MS = 30_000;

/** How long an image build may take. A cold base layer plus a toolchain install is minutes, not seconds. */
export const CONTAINER_BUILD_TIMEOUT_MS = 20 * 60 * 1000;

/** Where the runtime binary was found. Recorded so a refusal can name its evidence. */
export type ContainerRuntimeSource = 'env' | 'path';

/** The located runtime: a name or an absolute path, and how it was resolved. */
export interface ContainerRuntime {
  /** The command the spawner executes. Absolute when it was found on `PATH`. */
  readonly command: string;
  /** The configured or default name, before resolution. */
  readonly name: string;
  readonly source: ContainerRuntimeSource;
}

/** One invocation of the runtime: a subcommand and its arguments, never a shell string. */
export interface ContainerInvocation {
  /** One of {@link CONTAINER_SUBCOMMANDS}. */
  readonly subcommand: readonly string[];
  readonly args: readonly string[];
  readonly timeoutMs?: number;
}

/** What an invocation reported. A non-zero `status` is data, not an exception. */
export interface ContainerResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
  /** The complete argv, runtime command included. Asserted by the suites. */
  readonly argv: readonly string[];
}

/**
 * The port every container invocation in this package goes through.
 *
 * Injectable because the daemon is not reachable everywhere the rest of this package must be tested:
 * image resolution, removal discipline and tier selection are all decisions, and a decision is
 * assertable without a daemon. The AD-31 suite is the one place the real invoker is required.
 */
export type ContainerInvoker = (invocation: ContainerInvocation) => ContainerResult;

/** The runtime binary is not installed, or is not executable. */
export class ContainerRuntimeMissingError extends Error {
  readonly code = 'container.start_failed';
  readonly runtimeName: string;
  readonly orchError: OrchError;

  constructor(runtimeName: string, detail: string) {
    const message =
      `No container runtime named "${runtimeName}" could be found on PATH: ${detail}. ` +
      `AD-20 confines every tier-2 step to a container, so a missing runtime is not a degraded ` +
      `run — it is a run that must not start. Set ${CONTAINER_RUNTIME_ENV_VAR} if the binary has ` +
      'another name here.';
    super(message);
    this.name = 'ContainerRuntimeMissingError';
    this.runtimeName = runtimeName;
    this.orchError = makeError(this.code, message, detail);
  }
}

/** The binary is present but the daemon behind it did not answer. */
export class ContainerRuntimeUnreachableError extends Error {
  readonly code = 'container.start_failed';
  readonly orchError: OrchError;
  readonly detail: string;

  constructor(detail: string) {
    const message =
      `The container runtime is installed but its daemon did not answer: ${detail}. ` +
      'A tier-2 step cannot be confined without it, and AD-31 names the container assertion suite ' +
      'as one of three suites required before any unattended run.';
    super(message);
    this.name = 'ContainerRuntimeUnreachableError';
    this.detail = detail;
    this.orchError = makeError(this.code, message, detail);
  }
}

/** Absolute, executable and a file. Mirrors the CLI resolution in `src/engine/cli.ts`. */
const isExecutableFile = (candidate: string): boolean => {
  try {
    if (!statSync(candidate).isFile()) return false;
    accessSync(candidate, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
};

/**
 * Locate the runtime binary, or return `null`.
 *
 * `null` rather than a throw because the two callers want different things from the same fact: the
 * reachability probe wants to report it, and the wrapper wants to refuse a tier-2 spawn by name.
 */
export const locateContainerRuntime = (env: NodeJS.ProcessEnv = process.env): ContainerRuntime | null => {
  const declared = env[CONTAINER_RUNTIME_ENV_VAR]?.trim();
  const name = declared === undefined || declared === '' ? DEFAULT_CONTAINER_RUNTIME : declared;
  const source: ContainerRuntimeSource = declared === undefined || declared === '' ? 'path' : 'env';

  if (isAbsolute(name)) {
    return isExecutableFile(name) ? { command: name, name, source } : null;
  }
  for (const dir of (env['PATH'] ?? '').split(delimiter)) {
    if (dir === '') continue;
    const candidate = join(dir, name);
    if (isExecutableFile(candidate)) return { command: candidate, name, source };
  }
  return null;
};

/** Locate the runtime or refuse, naming the configured binary. */
export const requireContainerRuntime = (env: NodeJS.ProcessEnv = process.env): ContainerRuntime => {
  const located = locateContainerRuntime(env);
  if (located !== null) return located;
  const declared = env[CONTAINER_RUNTIME_ENV_VAR]?.trim();
  throw new ContainerRuntimeMissingError(
    declared === undefined || declared === '' ? DEFAULT_CONTAINER_RUNTIME : declared,
    'no executable of that name is on PATH',
  );
};

export interface ContainerInvokerOptions {
  readonly runtime?: ContainerRuntime;
  readonly env?: NodeJS.ProcessEnv;
  readonly defaultTimeoutMs?: number;
}

/**
 * The real invoker: one `execFileSync` per invocation, no shell, output captured.
 *
 * A non-zero exit is returned rather than thrown because every caller here is asking a question whose
 * negative answer is meaningful — "is this image present", "did the daemon answer", "was the container
 * already gone". Turning those into exceptions is how a missing image becomes an unhandled rejection
 * in a reconcile pass.
 */
export const createContainerInvoker = (options: ContainerInvokerOptions = {}): ContainerInvoker => {
  const runtime = options.runtime ?? requireContainerRuntime(options.env ?? process.env);
  return (invocation: ContainerInvocation): ContainerResult => {
    const argv = [runtime.command, ...invocation.subcommand, ...invocation.args];
    try {
      const stdout = execFileSync(runtime.command, [...invocation.subcommand, ...invocation.args], {
        encoding: 'utf8',
        timeout: invocation.timeoutMs ?? options.defaultTimeoutMs ?? CONTAINER_CONTROL_TIMEOUT_MS,
        maxBuffer: 16 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'pipe'],
        ...(options.env === undefined ? {} : { env: options.env }),
      });
      return { status: 0, stdout, stderr: '', argv };
    } catch (thrown: unknown) {
      const error = thrown as { status?: number | null; stdout?: string; stderr?: string; message?: string };
      return {
        status: error.status ?? null,
        stdout: error.stdout ?? '',
        stderr: error.stderr ?? error.message ?? '',
        argv,
      };
    }
  };
};

/** What the reachability probe found. Every field is reported, including the version floor. */
export interface ContainerRuntimeReachability {
  /** The binary was found *and* the daemon behind it answered. */
  readonly reachable: boolean;
  /** The located runtime, or `null` when no binary was found. */
  readonly runtime: ContainerRuntime | null;
  /** The client (CLI) version, when it could be read. */
  readonly clientVersion: string | null;
  /** The daemon's version. `null` is exactly the state that makes `reachable` false. */
  readonly serverVersion: string | null;
  /** Whether the client version meets {@link CONTAINER_RUNTIME_MIN_VERSION}. */
  readonly meetsVersionFloor: boolean;
  /** One sentence naming what was found, for a skip marker or a refusal. */
  readonly detail: string;
}

/** `major.minor` comparison. A version this cannot parse is reported as not meeting the floor. */
const meetsFloor = (version: string | null, floor: string): boolean => {
  if (version === null) return false;
  const parse = (value: string): readonly number[] =>
    (/^\D*(\d+)\.(\d+)/.exec(value) ?? []).slice(1).map((part) => Number.parseInt(part, 10));
  const [major, minor] = parse(version);
  const [floorMajor, floorMinor] = parse(floor);
  if (major === undefined || minor === undefined || floorMajor === undefined || floorMinor === undefined) {
    return false;
  }
  return major > floorMajor || (major === floorMajor && minor >= floorMinor);
};

/**
 * Probe the runtime: is the binary there, does the daemon answer, and does it meet the Stack floor.
 *
 * Never throws. The AD-31 suite reads this to decide whether it can run, and a probe that threw would
 * make "no runtime" indistinguishable from "the suite is broken" — which is precisely the ambiguity a
 * visible skip exists to remove.
 */
export const probeContainerRuntime = (
  options: { readonly env?: NodeJS.ProcessEnv; readonly invoke?: ContainerInvoker } = {},
): ContainerRuntimeReachability => {
  const env = options.env ?? process.env;
  const runtime = locateContainerRuntime(env);
  if (runtime === null && options.invoke === undefined) {
    return {
      reachable: false,
      runtime: null,
      clientVersion: null,
      serverVersion: null,
      meetsVersionFloor: false,
      detail: `no container runtime binary was found on PATH (looked for ${
        env[CONTAINER_RUNTIME_ENV_VAR]?.trim() ?? DEFAULT_CONTAINER_RUNTIME
      })`,
    };
  }
  const invoke =
    options.invoke ??
    createContainerInvoker({ ...(runtime === null ? {} : { runtime }), env });

  // `version --format` is the precise answer and it exits non-zero when the daemon is down, even though
  // the *client's* version is knowable without one. `--version` is the client-only fallback, so an
  // unreachable daemon still reports "the CLI is installed, version X" rather than "nothing answered" —
  // two different problems that want two different fixes.
  const formatted = invoke({
    subcommand: CONTAINER_SUBCOMMANDS.version,
    args: ['--format', '{{.Client.Version}}'],
  });
  let clientVersion =
    formatted.status === 0 && formatted.stdout.trim() !== '' ? formatted.stdout.trim() : null;
  if (clientVersion === null) {
    const bare = invoke({ subcommand: [], args: ['--version'] });
    const reported = `${bare.stdout} ${formatted.stdout}`;
    const parsed = /(\d+\.\d+\.\d+)/.exec(reported);
    clientVersion = parsed?.[1] ?? null;
  }

  const server = invoke({
    subcommand: CONTAINER_SUBCOMMANDS.info,
    args: ['--format', '{{.ServerVersion}}'],
  });
  const serverVersion = server.status === 0 && server.stdout.trim() !== '' ? server.stdout.trim() : null;

  if (serverVersion === null) {
    const stderr = server.stderr.split('\n').find((line) => line.trim() !== '')?.trim() ?? '';
    return {
      reachable: false,
      runtime,
      clientVersion,
      serverVersion: null,
      meetsVersionFloor: meetsFloor(clientVersion, CONTAINER_RUNTIME_MIN_VERSION),
      detail:
        clientVersion === null
          ? `the runtime binary did not report a version${stderr === '' ? '' : `: ${stderr}`}`
          : `the runtime CLI ${clientVersion} is installed but its daemon did not answer${
              stderr === '' ? '' : `: ${stderr}`
            }`,
    };
  }

  return {
    reachable: true,
    runtime,
    clientVersion,
    serverVersion,
    meetsVersionFloor: meetsFloor(clientVersion ?? serverVersion, CONTAINER_RUNTIME_MIN_VERSION),
    detail: `the runtime daemon answered, server version ${serverVersion}`,
  };
};

/** The reachability check the engine wires in. Refuses by name rather than returning a flag. */
export const requireReachableContainerRuntime = (
  options: { readonly env?: NodeJS.ProcessEnv; readonly invoke?: ContainerInvoker } = {},
): ContainerRuntimeReachability => {
  const probe = probeContainerRuntime(options);
  if (probe.reachable) return probe;
  if (probe.runtime === null) {
    throw new ContainerRuntimeMissingError(
      options.env?.[CONTAINER_RUNTIME_ENV_VAR]?.trim() ?? DEFAULT_CONTAINER_RUNTIME,
      probe.detail,
    );
  }
  throw new ContainerRuntimeUnreachableError(probe.detail);
};
