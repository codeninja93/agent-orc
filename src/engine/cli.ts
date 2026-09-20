/**
 * AD-1 — the `claude` CLI preflight: where it is, what version it is, and how it authenticates.
 *
 * Three refusals live here, and the order they are taken in is part of the contract:
 *
 *   1. **API-key mode is refused first, and needs no process at all.** AD-1 forbids bare mode
 *      *positively*: the engine asserts subscription authentication rather than merely omitting an
 *      API-key flag. Because the assertion reads the environment, it holds before anything is
 *      spawned — including the version probe — so a machine configured for an API key creates no
 *      process whatsoever. That is the property the I/O matrix asks for, and it is only true if this
 *      check comes first.
 *   2. **An absent binary is refused next**, because a version probe of a binary that is not there
 *      reports a version problem for what is an installation problem.
 *   3. **The version floor is asserted last**, by probing the binary that was found, and the refusal
 *      names the required version rather than saying "too old".
 *
 * The CLI version floor is declared here and nowhere else in code. It is the Stack table's
 * `claude` CLI row — `>=2.1.259`, the maximum of the four features the system depends on — and the
 * reasons are recorded beside it so a bump is an argument rather than a guess.
 */
import { execFileSync } from 'node:child_process';
import { closeSync, openSync, readSync, statSync } from 'node:fs';
import { delimiter, isAbsolute, join, resolve } from 'node:path';

import { compareVersions, parseVersion } from '../contracts/index.js';

/**
 * The pinned `claude` CLI floor (Stack table).
 *
 * It is the maximum of: `--permission-prompts` at 2.1.259, cross-project `--resume` at 2.1.223,
 * `--mcp-config` connect-before-first-turn at 2.1.221 and nested-subagent stream events at 2.1.219.
 * Every one of those is load-bearing for this story or the ones it feeds, so the floor is the max
 * rather than the version of whichever feature was noticed last.
 */
export const CLAUDE_CLI_VERSION_FLOOR = '2.1.259';

/** The executable name looked up on `PATH` when no explicit path is given. */
export const CLAUDE_CLI_BINARY_NAME = 'claude';

/**
 * Environment variables whose presence means the CLI would authenticate as something other than the
 * user's own Claude Code subscription login.
 *
 * The Consistency Conventions state it plainly: "Auth is the user's own Claude Code subscription
 * login via non-bare `claude -p`, asserted at startup; no `ANTHROPIC_API_KEY` path and no bundled
 * credential." A third-party provider gateway is the same refusal for the same reason — it is not the
 * subscription, so the permission and quota surfaces AD-1 fixes are not the ones in force.
 */
export const CLAUDE_API_KEY_MODE_ENV_VARS = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
] as const;

/**
 * The `apiKeySource` a subscription-authenticated CLI reports on its `system`/`init` stream line.
 *
 * Recorded, not assumed: `tests/fixtures/stream-json/completed.jsonl` is a real transcript and
 * carries `"apiKeySource":"none"`. Any other value names where a key came from, which is the thing
 * AD-1 refuses.
 */
export const SUBSCRIPTION_API_KEY_SOURCE = 'none';

export const isSubscriptionApiKeySource = (source: unknown): boolean =>
  source === SUBSCRIPTION_API_KEY_SOURCE;

/** How the resolved entry is executed: under the resolved Node, or as a native executable. */
export type ClaudeCliInterpreter = 'node' | 'direct';

/** The proven CLI: where it is, what version it is, and that it authenticates by subscription. */
export interface ClaudeCli {
  /** Absolute path to the entry point. */
  readonly path: string;
  /** The version it reported, e.g. `2.1.278`. */
  readonly version: string;
  /**
   * Always `subscription`. The field exists so a caller reads a proven fact rather than re-deriving
   * it, and so a second auth mode cannot be added without every consumer seeing a type change.
   */
  readonly auth: 'subscription';
  /**
   * `node` when the entry is a JavaScript (or TypeScript) script, so AD-28's absolute interpreter is
   * the command and the entry is its first argument; `direct` when the entry is a compiled binary,
   * where there is no interpreter to substitute and the resolved Node is published to the child
   * through its environment instead.
   */
  readonly interpreter: ClaudeCliInterpreter;
}

/**
 * The CLI is not where it should be, or could not be run at all.
 *
 * The code is `step.spawn_failed`, and the spawner re-raises this as `StepSpawnFailed` once it knows
 * which step was being started: an absent CLI is an impossible spawn, never a step that ran and failed.
 */
export class ClaudeCliUnavailableError extends Error {
  readonly code = 'step.spawn_failed';
  readonly searched: readonly string[];

  constructor(detail: string, searched: readonly string[] = []) {
    super(
      `The \`${CLAUDE_CLI_BINARY_NAME}\` CLI could not be used: ${detail}.` +
        (searched.length === 0 ? '' : ` Searched: ${searched.join(', ')}.`),
    );
    this.name = 'ClaudeCliUnavailableError';
    this.searched = searched;
  }
}

/** The CLI is older than the pinned floor. The refusal names the required version, per AD-1. */
export class ClaudeCliVersionError extends Error {
  readonly code = 'config.invalid';
  readonly required: string;
  readonly found: string;

  constructor(found: string, required: string = CLAUDE_CLI_VERSION_FLOOR) {
    super(
      `The \`${CLAUDE_CLI_BINARY_NAME}\` CLI must be version ${required} or newer; this machine has ${found}. ` +
        'The floor is the maximum of the four CLI features the system depends on — --permission-prompts, ' +
        'cross-project --resume, --mcp-config connect-before-first-turn and nested-subagent stream ' +
        `events — so an older CLI cannot serve the spawn contract. Upgrade to ${required} or newer and retry.`,
    );
    this.name = 'ClaudeCliVersionError';
    this.required = required;
    this.found = found;
  }
}

/**
 * The CLI would authenticate with an API key rather than the user's subscription login.
 *
 * The code is `model.api_key_mode_refused`, whose AD-35 disposition is `escalate-to-human`: no retry
 * clears it and no model rung is higher up the ladder, a person has to change the environment.
 */
export class ApiKeyModeRefusedError extends Error {
  readonly code = 'model.api_key_mode_refused';
  /** The environment variable, or the reported `apiKeySource`, that proved it. */
  readonly evidence: string;

  constructor(evidence: string, detail: string) {
    super(
      `Refusing to spawn \`${CLAUDE_CLI_BINARY_NAME} -p\`: ${detail}. ` +
        'AD-1 requires the user\'s own Claude Code subscription login and forbids bare, API-key mode ' +
        'positively rather than by omitting a flag — there is no ANTHROPIC_API_KEY path and no bundled ' +
        `credential. Unset ${evidence} (or log in with \`${CLAUDE_CLI_BINARY_NAME}\`) and retry.`,
    );
    this.name = 'ApiKeyModeRefusedError';
    this.evidence = evidence;
  }
}

/**
 * Assert subscription authentication from the environment alone.
 *
 * No process is created, which is what lets the refusal precede every spawn including the version
 * probe. A variable set to the empty string is not a configured credential and is not refused.
 */
export const assertSubscriptionAuth = (env: NodeJS.ProcessEnv = process.env): void => {
  for (const variable of CLAUDE_API_KEY_MODE_ENV_VARS) {
    const value = env[variable];
    if (value === undefined || value.trim() === '') continue;
    throw new ApiKeyModeRefusedError(
      variable,
      `${variable} is set in this environment, so the CLI would resolve to API-key mode`,
    );
  }
};

/** Read the version from `claude --version` output, e.g. `2.1.278 (Claude Code)`. */
export const parseClaudeVersion = (output: string): string | null => {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(output.trim());
  if (match === null) return null;
  return `${match[1] ?? '0'}.${match[2] ?? '0'}.${match[3] ?? '0'}`;
};

const isFile = (path: string): boolean => {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
};

/** Find an executable by name on the given `PATH`, as an absolute path, or null. */
export const findOnPath = (name: string, env: NodeJS.ProcessEnv = process.env): string | null => {
  if (name.includes('/')) {
    const direct = isAbsolute(name) ? name : resolve(name);
    return isFile(direct) ? direct : null;
  }
  for (const entry of (env['PATH'] ?? '').split(delimiter)) {
    if (entry === '') continue;
    const candidate = isAbsolute(entry) ? join(entry, name) : resolve(entry, name);
    if (isFile(candidate)) return candidate;
  }
  return null;
};

/** The `PATH` entries a lookup would have searched, for a refusal that shows its work. */
const searchedPathEntries = (env: NodeJS.ProcessEnv): readonly string[] =>
  (env['PATH'] ?? '').split(delimiter).filter((entry) => entry !== '');

/**
 * Whether an entry is a script the resolved Node must interpret, or a binary to execute directly.
 *
 * Decided from the extension first and the shebang second, because both are cheap and either alone is
 * wrong: a real `claude` install on this machine is a Mach-O executable with no extension, while the
 * fake CLI the suite drives is a `.ts` script. A file that cannot be read is treated as `direct`,
 * which fails at spawn with the real reason rather than with a wrong interpreter.
 */
export const classifyCliEntry = (path: string): ClaudeCliInterpreter => {
  if (/\.(?:[cm]?js|ts)$/.test(path)) return 'node';
  const buffer = Buffer.alloc(256);
  let read = 0;
  let fd: number | null = null;
  try {
    fd = openSync(path, 'r');
    read = readSync(fd, buffer, 0, buffer.length, 0);
  } catch {
    return 'direct';
  } finally {
    if (fd !== null) closeSync(fd);
  }
  // A Mach-O or ELF header is not text, so the shebang test simply fails on it and `direct` stands.
  const firstLine = buffer.subarray(0, read).toString('latin1').split('\n')[0] ?? '';
  return firstLine.startsWith('#!') && /\bnode\b/.test(firstLine) ? 'node' : 'direct';
};

export interface ResolveClaudeCliOptions {
  readonly env?: NodeJS.ProcessEnv;
  /** An explicit path, bypassing the `PATH` lookup. Still version-probed and auth-asserted. */
  readonly path?: string;
  /** The pinned floor, overridable so a suite can assert the comparison rather than the constant. */
  readonly floor?: string;
  /** Injected version probe, so a suite can describe a CLI it does not have installed. */
  readonly probeVersion?: (path: string) => string | null;
  /** Injected classification, for the same reason. */
  readonly classify?: (path: string) => ClaudeCliInterpreter;
}

/** Probe `claude --version`. Returns null when the binary cannot be run or says nothing usable. */
export const probeClaudeVersion = (path: string): string | null => {
  try {
    return parseClaudeVersion(
      execFileSync(path, ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }),
    );
  } catch {
    return null;
  }
};

/**
 * Resolve and prove the CLI, or refuse by name. See the module comment for why the three checks are
 * taken in this order.
 */
export const resolveClaudeCli = (options: ResolveClaudeCliOptions = {}): ClaudeCli => {
  const env = options.env ?? process.env;

  assertSubscriptionAuth(env);

  const located =
    options.path === undefined
      ? findOnPath(CLAUDE_CLI_BINARY_NAME, env)
      : isAbsolute(options.path)
        ? options.path
        : resolve(options.path);
  if (located === null) {
    throw new ClaudeCliUnavailableError(
      `no \`${CLAUDE_CLI_BINARY_NAME}\` executable was found on PATH`,
      searchedPathEntries(env),
    );
  }
  if (options.path !== undefined && !isFile(located)) {
    throw new ClaudeCliUnavailableError(`${located} is not a file`);
  }

  const version = (options.probeVersion ?? probeClaudeVersion)(located);
  if (version === null) {
    throw new ClaudeCliUnavailableError(
      `${located} could not be run to report its version, so the pinned floor of ` +
        `${CLAUDE_CLI_VERSION_FLOOR} cannot be asserted`,
    );
  }

  const floor = options.floor ?? CLAUDE_CLI_VERSION_FLOOR;
  if (compareVersions(parseVersion(version), parseVersion(floor)) < 0) {
    throw new ClaudeCliVersionError(version, floor);
  }

  return {
    path: located,
    version,
    auth: 'subscription',
    interpreter: (options.classify ?? classifyCliEntry)(located),
  };
};

/** The memoised resolution: one process resolves one CLI. */
let memoised: ClaudeCli | null = null;

export const resolveClaudeCliOnce = (options: ResolveClaudeCliOptions = {}): ClaudeCli => {
  memoised ??= resolveClaudeCli(options);
  return memoised;
};

/** Drop the memoised resolution. For suites that resolve against more than one environment. */
export const forgetClaudeCli = (): void => {
  memoised = null;
};
