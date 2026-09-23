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
 *
 * **The three git reads live in `src/runtime/repository.ts` and are re-exported here.** Story 2-2
 * needs `firstCommitSha` to verify a registration's recorded path (AD-10), the runtime may not import
 * the installer, and two copies of that probe would be two answers to "what is this project's id" —
 * which is the split AD-10 exists to prevent. Re-exporting keeps every caller of `detect.js` and of
 * `installer/index.js` unchanged, as stories 1-9 and 1-11 did for the same rule.
 */
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { join } from 'node:path';

import type { MechanicsCommandName, MechanicsCommands, PackageManager } from '../contracts/index.js';
import { MECHANICS_COMMAND_NAMES } from '../contracts/index.js';
import { firstCommitSha, gitRemote, gitRoot } from '../runtime/repository.js';

export { firstCommitSha, gitRemote, gitRoot } from '../runtime/repository.js';

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

/**
 * The script names each command is looked for under, in order of preference.
 *
 * `typecheck` carries three because the ecosystem has not settled on one: `typecheck` and
 * `type-check` are both common and `tsc` is what a repository that never wrote a script calls it.
 * Offering the wrong one is cheap — every detected value is a *default* a person overrides at the
 * interview (matrix row 12) — and offering none at all is what leaves CAP-13's typecheck gate
 * declared empty on a repository that has one.
 */
const SCRIPT_CANDIDATES: Readonly<Record<MechanicsCommandName, readonly string[]>> = {
  typecheck: ['typecheck', 'type-check', 'tsc'],
  lint: ['lint'],
  test: ['test'],
  build: ['build'],
  run: ['start', 'dev', 'serve'],
};

/**
 * The commands of AD-16, as the repository's own scripts already spell them.
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
    const script = SCRIPT_CANDIDATES[name].find((candidate) => candidate in scripts);
    commands[name] = script === undefined ? '' : `${runner} run ${script}`;
  }
  // Spelled out rather than cast, so a name added to the vocabulary is a type error here — which is
  // where a command nobody detected should be noticed, and not at a gate that turns out empty.
  return {
    typecheck: commands['typecheck'] ?? '',
    lint: commands['lint'] ?? '',
    test: commands['test'] ?? '',
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
