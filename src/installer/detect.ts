/**
 * What the installer can find out for itself, so the interview offers an answer rather than an empty
 * prompt.
 *
 * Every function here is a pure read of a repository path: nothing is written, nothing is cached and
 * nothing is asked. That matters twice over. It is what lets the refusals of AD-10 and AD-12 be taken
 * *before* anything lands on disk — a directory that is not a repository, or a repository with no
 * commits, is refused from these reads alone. And it is what makes a detected default a *default*
 * rather than a decision: every one of them is offered to a person who can override it, per matrix
 * row 12.
 *
 * **Nothing here reads an environment variable's value.** The only environment fact the installer
 * collects is a variable's *name*, typed by a person at question 9 (AD-12). A detector that helpfully
 * looked one up would be the credential leak this story exists to prevent.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { join } from 'node:path';

import type { MechanicsCommands, PackageManager } from '../contracts/index.js';
import { MECHANICS_COMMAND_NAMES } from '../contracts/index.js';

/** What the repository answered, with `null` wherever it said nothing. */
export interface DetectedDefaults {
  /** The path as the installer resolved it, which is what the profile records as the pointer. */
  readonly repositoryPath: string;
  /** The repository root git reports, or `null` when the path is not inside a repository at all. */
  readonly gitRoot: string | null;
  /** AD-10's project id: the SHA of the first commit, or `null` when there is not one yet. */
  readonly firstCommitSha: string | null;
  readonly remote: string | null;
  readonly packageManager: PackageManager | null;
  readonly commands: MechanicsCommands;
  readonly sourceLayout: readonly string[];
}

/**
 * Run a git command in the repository, answering `null` for every failure.
 *
 * `null` means "git did not say", and every caller treats it as an undecided fact rather than as a
 * negative answer — the same shape as the npm version in `src/contracts/node-floor.ts`. The refusals
 * that depend on it are stated by the caller, which knows what it needed and can name it.
 */
/**
 * The environment git is given: the two variables it needs and nothing else.
 *
 * A child process that inherits this one's environment inherits every credential in it, and AD-12's
 * whole position is that the installer handles no credential. Naming what git gets is also what
 * makes "no value of the named variable was read" provable rather than asserted — an inherited
 * environment is read wholesale on the way into `spawn`, so a test could not tell a copy from a
 * lookup. `GIT_TERMINAL_PROMPT` is off because an installer that stopped at a git credential prompt
 * would look like a hang in the middle of an interview.
 */
const gitEnvironment = (): NodeJS.ProcessEnv => ({
  PATH: process.env['PATH'] ?? '',
  HOME: process.env['HOME'] ?? '',
  GIT_TERMINAL_PROMPT: '0',
  LC_ALL: 'C',
});

const git = (repositoryPath: string, args: readonly string[]): string | null => {
  try {
    const output = execFileSync('git', [...args], {
      cwd: repositoryPath,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      env: gitEnvironment(),
      // A repository whose hooks or config hang would hang the install; the interview is interactive
      // and a person would have no way to tell a slow probe from a dead one.
      timeout: 10_000,
    });
    const trimmed = output.trim();
    return trimmed === '' ? null : trimmed;
  } catch {
    return null;
  }
};

/** The repository root, or `null` when the path is not inside a git repository. */
export const gitRoot = (repositoryPath: string): string | null => {
  const root = git(repositoryPath, ['rev-parse', '--show-toplevel']);
  if (root === null) return null;
  try {
    return realpathSync(root);
  } catch {
    return root;
  }
};

/**
 * AD-10 — the project id is the SHA of the first commit.
 *
 * `--max-parents=0` lists every root commit, newest first, and a repository with merged histories has
 * more than one. The last line is the oldest of them, which is the first commit of the history this
 * repository grew from; picking the newest would key one project by whichever unrelated history was
 * grafted in most recently.
 */
export const firstCommitSha = (repositoryPath: string): string | null => {
  const roots = git(repositoryPath, ['rev-list', '--max-parents=0', 'HEAD']);
  if (roots === null) return null;
  const lines = roots.split('\n').map((line) => line.trim()).filter((line) => line !== '');
  return lines[lines.length - 1] ?? null;
};

/** The push remote, or `null` when there is none. A repository with no remote is a real answer. */
export const gitRemote = (repositoryPath: string): string | null =>
  git(repositoryPath, ['remote', 'get-url', 'origin']);

/** Lockfiles, in the order they are looked for. The first that exists decides. */
const LOCKFILES: readonly (readonly [string, PackageManager])[] = [
  ['package-lock.json', 'npm'],
  ['pnpm-lock.yaml', 'pnpm'],
  ['yarn.lock', 'yarn'],
  ['bun.lockb', 'bun'],
  ['bun.lock', 'bun'],
];

/**
 * The package manager the repository already uses, by its lockfile.
 *
 * The lockfile rather than a `packageManager` field or a global preference: the lockfile is the one
 * statement that is true of the repository rather than of the machine, and installing with the wrong
 * one rewrites it.
 */
export const detectPackageManager = (repositoryPath: string): PackageManager | null => {
  for (const [file, manager] of LOCKFILES) {
    if (existsSync(join(repositoryPath, file))) return manager;
  }
  return null;
};

/** The scripts a `package.json` declares, or an empty record when there is no readable one. */
const packageScripts = (repositoryPath: string): Readonly<Record<string, string>> => {
  const manifest = join(repositoryPath, 'package.json');
  if (!existsSync(manifest)) return {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(manifest, 'utf8'));
    if (typeof parsed !== 'object' || parsed === null) return {};
    const scripts = (parsed as Record<string, unknown>)['scripts'];
    if (typeof scripts !== 'object' || scripts === null) return {};
    const found: Record<string, string> = {};
    for (const [name, value] of Object.entries(scripts as Record<string, unknown>)) {
      if (typeof value === 'string') found[name] = value;
    }
    return found;
  } catch {
    // A malformed package.json says nothing about the commands; the interview asks instead.
    return {};
  }
};

/** The script names each of the four commands is looked for under, in order of preference. */
const SCRIPT_CANDIDATES: Readonly<Record<string, readonly string[]>> = {
  test: ['test'],
  lint: ['lint'],
  build: ['build'],
  run: ['start', 'dev', 'serve'],
};

/**
 * The four commands of AD-16, as the repository's own scripts already spell them.
 *
 * Empty string where there is none — the answer "this repository has no lint command" is a fact the
 * profile has to be able to carry, and a missing key would read as "nobody was asked".
 */
export const detectCommands = (
  repositoryPath: string,
  manager: PackageManager | null,
): MechanicsCommands => {
  const scripts = packageScripts(repositoryPath);
  const runner = manager === null || manager === 'other' ? 'npm' : manager;
  const commands: Record<string, string> = {};
  for (const name of MECHANICS_COMMAND_NAMES) {
    const script = (SCRIPT_CANDIDATES[name] ?? []).find((candidate) => candidate in scripts);
    commands[name] = script === undefined ? '' : `${runner} run ${script}`;
  }
  return {
    test: commands['test'] ?? '',
    lint: commands['lint'] ?? '',
    build: commands['build'] ?? '',
    run: commands['run'] ?? '',
  };
};

/** Directory names that hold code often enough to be worth offering. */
const SOURCE_DIRECTORIES: readonly string[] = ['src', 'lib', 'app', 'packages', 'cmd', 'internal'];

export const detectSourceLayout = (repositoryPath: string): readonly string[] =>
  SOURCE_DIRECTORIES.filter((name) => {
    const candidate = join(repositoryPath, name);
    try {
      return statSync(candidate).isDirectory();
    } catch {
      return false;
    }
  });

/** Everything the interview can offer without asking, read once. */
export const detectDefaults = (repositoryPath: string): DetectedDefaults => {
  let resolved = repositoryPath;
  try {
    resolved = realpathSync(repositoryPath);
  } catch {
    // An unresolvable path is reported by the caller's own refusal, which names what it needed.
  }
  const manager = detectPackageManager(resolved);
  return {
    repositoryPath: resolved,
    gitRoot: gitRoot(resolved),
    firstCommitSha: firstCommitSha(resolved),
    remote: gitRemote(resolved),
    packageManager: manager,
    commands: detectCommands(resolved, manager),
    sourceLayout: detectSourceLayout(resolved),
  };
};
