/**
 * Matrix rows 7 and 8 — what the installer refuses, and that it refuses *before* writing.
 *
 * A half-written refusal is worse than a refusal: it leaves a `.orch/` that the next run reads as
 * authority. So every test here asserts two things — that the refusal names what was needed, and
 * that the target repository is exactly as it was found.
 */
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { InstallRefusal, parseInitArguments, runInit } from '../src/installer/index.js';
import { makeRepository, scriptedIo } from './helpers/installer-fixture.js';

const disposable: string[] = [];

const scratchDirectory = (): string => {
  const created = mkdtempSync(join(tmpdir(), 'orch-refusal-'));
  disposable.push(created);
  return created;
};

const repository = (options?: Parameters<typeof makeRepository>[0]): string => {
  const created = makeRepository(options);
  disposable.push(created);
  return created;
};

afterAll(() => {
  for (const path of disposable.splice(0)) rmSync(path, { recursive: true, force: true });
});

/**
 * Story 2-2 — a completed install registers the project under `ORCH_HOME` (AD-10), so this suite points
 * `ORCH_HOME` at a scratch directory of its own.
 *
 * Not a nicety: without it these tests would leave registration records in the real `~/.orch` of
 * whichever machine ran them, and a suite whose side effects escape its temporary directories is a
 * suite that changes the thing it is measuring.
 */
const realOrchHome = process.env['ORCH_HOME'];

beforeAll(() => {
  const home = mkdtempSync(join(tmpdir(), 'orch-home-'));
  disposable.push(home);
  process.env['ORCH_HOME'] = home;
});

afterAll(() => {
  if (realOrchHome === undefined) delete process.env['ORCH_HOME'];
  else process.env['ORCH_HOME'] = realOrchHome;
});

describe('a directory that is not a git repository is refused (matrix 7)', () => {
  it('names what it needed, and writes nothing', async () => {
    const directory = scratchDirectory();
    const before = readdirSync(directory);

    await expect(runInit({ repository: directory, io: scriptedIo() })).rejects.toThrow(
      InstallRefusal,
    );

    expect(existsSync(join(directory, '.orch'))).toBe(false);
    expect(existsSync(join(directory, '.gitignore'))).toBe(false);
    expect(readdirSync(directory)).toStrictEqual(before);
  });

  it('says what to do about it rather than only that it is wrong', async () => {
    const directory = scratchDirectory();
    let thrown: unknown = null;
    try {
      await runInit({ repository: directory, io: scriptedIo() });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(InstallRefusal);
    const refusal = thrown as InstallRefusal;
    expect(refusal.message).toContain('git init');
    expect(refusal.message).toContain('Nothing has been written');
    // AD-35 — the code routes to a declared disposition rather than to the unknown-code fallback.
    expect(refusal.code).toBe('config.invalid');
  });

  it('asks nothing before refusing, so the person is not interviewed for nothing', async () => {
    const io = scriptedIo();
    await expect(runInit({ repository: scratchDirectory(), io })).rejects.toThrow(InstallRefusal);
    expect(io.asked).toStrictEqual([]);
  });

  it('refuses a path inside a repository but below its root, naming the root', async () => {
    const repo = repository();
    const inside = join(repo, 'src');
    let thrown: unknown = null;
    try {
      await runInit({ repository: inside, io: scriptedIo() });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(InstallRefusal);
    expect((thrown as InstallRefusal).message).toContain(repo);
    expect(existsSync(join(inside, '.orch'))).toBe(false);
    expect(existsSync(join(repo, '.orch'))).toBe(false);
  });
});

describe('a repository with no commits is refused (matrix 8)', () => {
  it('refuses because the project id is the first-commit SHA, and writes nothing', async () => {
    const repo = repository({ commit: false });
    let thrown: unknown = null;
    try {
      await runInit({ repository: repo, io: scriptedIo() });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(InstallRefusal);
    expect((thrown as InstallRefusal).message).toContain('first commit');
    expect(existsSync(join(repo, '.orch'))).toBe(false);
  });

  it('installs into the same repository once it has one, so the refusal was about the commit', async () => {
    const repo = repository({ commit: false });
    await expect(runInit({ repository: repo, io: scriptedIo() })).rejects.toThrow(InstallRefusal);

    const { git } = await import('./helpers/installer-fixture.js');
    git(repo, ['add', '-A']);
    git(repo, ['commit', '--allow-empty', '-m', 'first']);

    const outcome = await runInit({ repository: repo, io: scriptedIo() });
    expect(outcome.projectId).toMatch(/^[0-9a-f]{40}$/);
    expect(existsSync(join(repo, '.orch', 'profile.toml'))).toBe(true);
  });
});

describe('the entry point’s arguments decide an exit code, not a guess', () => {
  it('reads `init` with and without a path', () => {
    expect(parseInitArguments(['init', '/tmp/somewhere'])).toMatchObject({
      kind: 'init',
      repository: '/tmp/somewhere',
    });
    expect(parseInitArguments(['init']).kind).toBe('init');
    // Neither flag given: `mode` is `null`, which defers to `InterviewIo.chooseInstallMode` rather
    // than picking one silently.
    expect(parseInitArguments(['init']).mode).toBeNull();
  });

  it('reads `--express` and `--custom`, in either position relative to the path', () => {
    expect(parseInitArguments(['init', '--express', '/tmp/somewhere'])).toMatchObject({
      kind: 'init',
      repository: '/tmp/somewhere',
      mode: 'express',
    });
    expect(parseInitArguments(['init', '/tmp/somewhere', '--custom'])).toMatchObject({
      kind: 'init',
      repository: '/tmp/somewhere',
      mode: 'custom',
    });
  });

  it('refuses --express and --custom given together, naming both', () => {
    const result = parseInitArguments(['init', '--express', '--custom']);
    expect(result.kind).toBe('help');
    expect(result.error).toContain('--express');
    expect(result.error).toContain('--custom');
  });

  it('answers --help and --version without running anything', () => {
    expect(parseInitArguments(['--help']).kind).toBe('help');
    expect(parseInitArguments(['--version']).kind).toBe('version');
    expect(parseInitArguments(['--help']).error).toBeNull();
  });

  it('reports an unknown command or option as a usage error rather than as a refusal', () => {
    expect(parseInitArguments([])).toMatchObject({ kind: 'help' });
    expect(parseInitArguments([]).error).not.toBeNull();
    expect(parseInitArguments(['install']).error).toContain('install');
    expect(parseInitArguments(['init', '--force']).error).toContain('--force');
    expect(parseInitArguments(['init', 'a', 'b']).error).toContain('at most one path');
  });
});
