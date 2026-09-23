/**
 * Fixtures for the installer suites: a throwaway git repository, a scripted terminal, and a
 * recursive read of a written tree.
 *
 * The scripted terminal answers by **prompt id**, never by prompt text. `build-sequencing.md` says
 * the interview's wording is free to change and fixes only what it produces, so a fixture that
 * matched on a sentence would make every one of these suites a test of the sentence.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import type { Dirent } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { InterviewIo, Prompt } from '../../src/installer/index.js';

/** A terminal that answers from a script and records what it was asked and told. */
export interface ScriptedIo extends InterviewIo {
  /** Prompt ids, in the order they were put. */
  readonly asked: readonly string[];
  /** Everything said back to the person: refusals, and what was recovered. */
  readonly said: readonly string[];
  readonly suggestions: ReadonlyMap<string, string | null>;
}

/**
 * Every answer is a queue: a script gives a prompt id one answer per time it is asked, and an id
 * with nothing left answers with the empty string, which takes the offered default. That is what
 * lets one script drive both "accept everything detected" and "override exactly this one".
 */
export const scriptedIo = (
  script: Readonly<Record<string, string | readonly string[]>> = {},
): ScriptedIo => {
  const queues = new Map<string, string[]>(
    Object.entries(script).map(([id, value]) => [id, typeof value === 'string' ? [value] : [...value]]),
  );
  const asked: string[] = [];
  const said: string[] = [];
  const suggestions = new Map<string, string | null>();
  return {
    asked,
    said,
    suggestions,
    ask: (prompt: Prompt): Promise<string> => {
      asked.push(prompt.id);
      if (!suggestions.has(prompt.id)) suggestions.set(prompt.id, prompt.suggestion);
      return Promise.resolve(queues.get(prompt.id)?.shift() ?? '');
    },
    say: (line: string): void => {
      said.push(line);
    },
  };
};

const GIT_IDENTITY = ['-c', 'user.email=fixture@example.invalid', '-c', 'user.name=Fixture'];

export const git = (repository: string, args: readonly string[]): string =>
  execFileSync('git', [...GIT_IDENTITY, ...args], {
    cwd: repository,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();

export interface RepositoryOptions {
  /** A repository with no commits is matrix row 8; AD-10 has no project id for it. */
  readonly commit?: boolean;
  /** Written verbatim before the first commit, keyed by repository-relative path. */
  readonly files?: Readonly<Record<string, string>>;
  /** With a `package.json`, a lockfile and a `src/`, the interview has defaults to offer. */
  readonly node?: boolean;
}

const NODE_PACKAGE = JSON.stringify(
  {
    name: 'fixture',
    version: '1.0.0',
    /**
     * A `typecheck` script, because CAP-13 names that gate and nothing detected it.
     *
     * Without one here, `detectCommands` had nothing to find, every fixture install wrote
     * `typecheck = ""` — recorded as *skipped* — and emptying the detection table left the suite
     * green while the gate was silently absent on every repository that has one.
     */
    scripts: {
      test: 'vitest run',
      typecheck: 'tsc --noEmit',
      lint: 'eslint .',
      build: 'tsc',
      start: 'node .',
    },
  },
  null,
  2,
);

/** A throwaway repository. The caller removes it; these suites keep them for the whole file. */
export const makeRepository = (options: RepositoryOptions = {}): string => {
  const repository = realpathSync(mkdtempSync(join(tmpdir(), 'orch-installer-')));
  git(repository, ['init', '--initial-branch=main']);
  if (options.node !== false) {
    writeFileSync(join(repository, 'package.json'), `${NODE_PACKAGE}\n`, 'utf8');
    writeFileSync(join(repository, 'package-lock.json'), '{}\n', 'utf8');
    mkdirSync(join(repository, 'src'), { recursive: true });
    writeFileSync(join(repository, 'src', 'index.ts'), 'export const fixture = true;\n', 'utf8');
  }
  for (const [path, contents] of Object.entries(options.files ?? {})) {
    const absolute = join(repository, ...path.split('/'));
    mkdirSync(join(absolute, '..'), { recursive: true });
    writeFileSync(absolute, contents, 'utf8');
  }
  if (options.commit !== false) {
    git(repository, ['add', '-A']);
    git(repository, ['commit', '--allow-empty', '-m', 'first']);
  }
  return repository;
};

/** Every file under a directory, recursively, as repository-relative path to contents. */
export const readTree = (root: string, prefix = ''): ReadonlyMap<string, string> => {
  const found = new Map<string, string>();
  // The encoding is pinned so `readdirSync` resolves to the string-named overload; without it TS
  // picks the Buffer one and `entry.name` comes back as bytes.
  let listing: Dirent<string>[];
  try {
    listing = readdirSync(root, { withFileTypes: true, encoding: 'utf8' });
  } catch {
    return found;
  }
  for (const entry of listing) {
    const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      for (const [path, contents] of readTree(join(root, entry.name), relative)) {
        found.set(path, contents);
      }
      continue;
    }
    found.set(relative, readFileSync(join(root, entry.name), 'utf8'));
  }
  return found;
};
