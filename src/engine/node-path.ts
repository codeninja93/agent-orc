/**
 * AD-28 — the absolute Node path every child process is given, resolved once.
 *
 * The failure this module exists to convert into a named one is specific and was observed: a version
 * manager leaves a stale `PATH`, a child resolves `node` from it, gets a Node below the floor, and the
 * observed failure is an opaque TypeScript syntax error thrown from deep inside someone else's stack.
 * So the engine never lets a child resolve its own interpreter. It resolves one absolute path here,
 * proves the version behind it meets the floor, and hands that path down.
 *
 * The floor itself is not declared here. It lives in `.nvmrc` and `package.json` `engines.node` and
 * is read through `src/contracts/node-floor.ts`, so this module cannot become a third home for it.
 *
 * Resolution order, and why:
 *
 *   1. `ORCH_NODE`, when set — an operator who has pinned an interpreter has pinned it deliberately,
 *      and a pin that silently loses to a better candidate is worse than a pin that is refused;
 *   2. `process.execPath` — the engine is already running on a Node that passed its own startup
 *      assertion, so the common case needs no probe at all and cannot disagree with the parent;
 *   3. each `node` on `PATH`, probed in order — the fallback for an engine launched by something that
 *      is itself below the floor.
 *
 * A candidate is never trusted on its filename: every candidate but `process.execPath` is probed by
 * running `--version`, because the whole point is that the name `node` says nothing about the version.
 */
import { execFileSync } from 'node:child_process';
import { statSync } from 'node:fs';
import { delimiter, isAbsolute, join, resolve } from 'node:path';

import { compareVersions, nodeFloor, parseVersion } from '../contracts/index.js';
import type { NodeFloor } from '../contracts/index.js';

/** The environment variable an operator pins a child interpreter with. */
export const CHILD_NODE_ENV_VAR = 'ORCH_NODE';

/**
 * The variable the resolved path is published to children through, alongside the argv position.
 *
 * A child of the child — an MCP server, a hook the CLI runs — resolves its own interpreter from its
 * environment, and AD-28's failure mode is exactly that resolution going wrong one level down. The
 * path is therefore both the interpreter of the immediate child and an environment entry its own
 * children can read, rather than only the former.
 */
export const CHILD_NODE_PUBLISHED_ENV_VAR = 'ORCH_NODE';

/** The Node a child is spawned with: an absolute path and the version proven behind it. */
export interface ChildNode {
  /** Absolute path to the executable. Never a bare name and never `PATH`-relative. */
  readonly path: string;
  /** The version the executable reported, e.g. `24.21.0`. */
  readonly version: string;
  /** How the path was found, for the event log: `env`, `parent` or `path`. */
  readonly source: 'env' | 'parent' | 'path';
}

/** One candidate that was tried and what it reported, for a refusal that names its evidence. */
export interface ChildNodeCandidate {
  readonly path: string;
  readonly source: ChildNode['source'];
  /** The version it reported, or `null` when it could not be probed at all. */
  readonly version: string | null;
}

/**
 * No Node satisfying the floor could be resolved for a child.
 *
 * The code is `engine.node_floor_unmet`, the AD-35 table's one Node-floor code, whose disposition is
 * `escalate-to-human` — correctly, since no amount of retrying installs a Node.
 */
export class ChildNodeUnavailableError extends Error {
  readonly code = 'engine.node_floor_unmet';
  readonly floor: NodeFloor;
  readonly candidates: readonly ChildNodeCandidate[];

  constructor(floor: NodeFloor, candidates: readonly ChildNodeCandidate[], detail: string) {
    const tried =
      candidates.length === 0
        ? 'no candidate was found'
        : candidates
            .map(
              (candidate) =>
                `${candidate.path} (${candidate.source}) reported ${candidate.version ?? 'nothing'}`,
            )
            .join('; ');
    super(
      `No Node executable satisfying the floor of ${floor.version} could be resolved for a child ` +
        `process: ${detail}. Tried: ${tried}. ` +
        'AD-28 requires the engine to pass an absolute Node path to every child rather than let it ' +
        `resolve \`node\` from PATH; pin one with ${CHILD_NODE_ENV_VAR} or install Node ${floor.version} or newer.`,
    );
    this.name = 'ChildNodeUnavailableError';
    this.floor = floor;
    this.candidates = candidates;
  }
}

/** Read a version from `node --version` output, e.g. `v24.21.0\n`. */
export const parseNodeVersionOutput = (output: string): string | null => {
  const match = /v?(\d+)\.(\d+)\.(\d+)/.exec(output.trim());
  if (match === null) return null;
  return `${match[1] ?? '0'}.${match[2] ?? '0'}.${match[3] ?? '0'}`;
};

/** Probe an executable by running `--version`. Returns null when it cannot be run or read. */
export const probeNodeVersion = (path: string): string | null => {
  try {
    return parseNodeVersionOutput(
      execFileSync(path, ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }),
    );
  } catch {
    // A candidate that cannot be executed is not a candidate. It is reported, never thrown from.
    return null;
  }
};

const isExecutableFile = (path: string): boolean => {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
};

/**
 * Every `node` on the given `PATH`, in order, as absolute paths.
 *
 * `PATH` is read from the passed environment rather than resolved with `which`: shelling out to find
 * the thing whose resolution is not trusted would be circular, and a `which` on the wrong `PATH`
 * returns the wrong answer just as confidently.
 */
export const nodeCandidatesOnPath = (
  env: NodeJS.ProcessEnv = process.env,
  name = 'node',
): readonly string[] => {
  const raw = env['PATH'] ?? '';
  const found: string[] = [];
  for (const entry of raw.split(delimiter)) {
    if (entry === '') continue;
    const candidate = isAbsolute(entry) ? join(entry, name) : resolve(entry, name);
    if (isExecutableFile(candidate) && !found.includes(candidate)) found.push(candidate);
  }
  return found;
};

export interface ResolveChildNodeOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly floor?: NodeFloor;
  /** The parent's own interpreter. Injectable so a test can deny it without changing `process`. */
  readonly parentExecPath?: string | null;
  /** The parent's own version, which needs no probe. */
  readonly parentVersion?: string | null;
  /** Injected probe, so a suite can describe a machine it is not running on. */
  readonly probe?: (path: string) => string | null;
}

const meetsFloor = (version: string, floor: NodeFloor): boolean => {
  try {
    return compareVersions(parseVersion(version), floor) >= 0;
  } catch {
    return false;
  }
};

/**
 * Resolve an absolute Node path meeting the declared floor, or refuse naming every candidate tried.
 *
 * Pure with respect to this module: nothing is cached here, so a suite can resolve twice against two
 * different environments. {@link resolveChildNodeOnce} is the memoised entry the spawner uses.
 */
export const resolveChildNode = (options: ResolveChildNodeOptions = {}): ChildNode => {
  const env = options.env ?? process.env;
  const floor = options.floor ?? nodeFloor();
  const probe = options.probe ?? probeNodeVersion;
  const candidates: ChildNodeCandidate[] = [];

  const pinned = env[CHILD_NODE_ENV_VAR];
  if (pinned !== undefined && pinned.trim() !== '') {
    const path = isAbsolute(pinned.trim()) ? pinned.trim() : resolve(pinned.trim());
    const version = probe(path);
    candidates.push({ path, source: 'env', version });
    if (version !== null && meetsFloor(version, floor)) {
      return { path, version, source: 'env' };
    }
    // A deliberate pin that fails is the end of the search, not the start of a fallback: silently
    // preferring some other Node over the one an operator named is how an unreproducible run happens.
    throw new ChildNodeUnavailableError(
      floor,
      candidates,
      `${CHILD_NODE_ENV_VAR} pins ${path}, which ${
        version === null ? 'could not be probed' : `reports ${version}`
      }`,
    );
  }

  const parentPath = options.parentExecPath === undefined ? process.execPath : options.parentExecPath;
  const parentVersion =
    options.parentVersion === undefined ? process.versions.node : options.parentVersion;
  if (parentPath !== null && parentPath !== '' && parentVersion !== null) {
    candidates.push({ path: parentPath, source: 'parent', version: parentVersion });
    if (meetsFloor(parentVersion, floor)) {
      return { path: parentPath, version: parentVersion, source: 'parent' };
    }
  }

  for (const path of nodeCandidatesOnPath(env)) {
    if (candidates.some((candidate) => candidate.path === path)) continue;
    const version = probe(path);
    candidates.push({ path, source: 'path', version });
    if (version !== null && meetsFloor(version, floor)) {
      return { path, version, source: 'path' };
    }
  }

  throw new ChildNodeUnavailableError(
    floor,
    candidates,
    'neither the running interpreter nor any `node` on PATH met the floor',
  );
};

/** The memoised resolution. One process resolves one child Node, per AD-28's "resolved once". */
let memoised: ChildNode | null = null;

export const resolveChildNodeOnce = (options: ResolveChildNodeOptions = {}): ChildNode => {
  memoised ??= resolveChildNode(options);
  return memoised;
};

/** Drop the memoised resolution. For suites that resolve against more than one environment. */
export const forgetChildNode = (): void => {
  memoised = null;
};

/**
 * The environment a child is given: the caller's, plus the resolved interpreter published by name and
 * its directory placed first on `PATH`.
 *
 * Prepending the directory is not a substitute for the argv position — the child is still *executed*
 * by the absolute path — it is what stops a grandchild resolving a stale `node` one level down.
 */
export const childEnvWithNode = (
  node: ChildNode,
  env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv => {
  const dir = join(node.path, '..');
  const existing = env['PATH'] ?? '';
  return {
    ...env,
    [CHILD_NODE_PUBLISHED_ENV_VAR]: node.path,
    PATH: existing === '' ? dir : `${dir}${delimiter}${existing}`,
  };
};
