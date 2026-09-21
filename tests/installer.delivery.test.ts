/**
 * Matrix row 15 — the delivery path, exercised rather than inferred.
 *
 * AD-12 makes `npx github:<owner>/<repo> init` the only supported way to onboard a project, and that
 * path is npm's git-dependency path: resolve a ref, clone it, install its dev dependencies, run
 * `prepare`, pack what `files` names, expose `bin`, and run it. Every one of those can break
 * independently of anything a unit test sees, and a test that read `package.json` and concluded
 * "`npx` works" would be the adjacent verification stage 1's review found nineteen times. So this
 * runs npm.
 *
 * **What is different from a real `npx github:…`, and why.** The ref is a git repository built here
 * from this working tree rather than fetched from GitHub: the code under test is not committed —
 * this suite has to pass before the commit that would publish it — and a test that reached the
 * network would fail for reasons that have nothing to do with the installer. Everything else is the
 * real path: a real `git+file://` ref that npm resolves with git, a real `prepare` that compiles
 * `dist/`, a real pack honouring `files`, a real `bin` link, and `npm exec`, which *is* `npx`.
 *
 * **This test is slow and it depends on the npm cache.** It performs two npm installs of the whole
 * dev dependency tree and one TypeScript build, which is roughly fifteen seconds warm, and
 * `--prefer-offline` will reach the network for anything the cache does not already hold. That is
 * stated rather than engineered away: the alternative is asserting over `package.json`'s text, which
 * is the one thing this row exists to forbid.
 *
 * **`engine-strict` is on for both invocations, deliberately.** Story 1-12's review made an
 * `engines` mismatch fatal at install rather than a warning, so `engines.npm: "<12"` now decides
 * whether this path resolves at all — AD-12's stated revisit condition, working. If it ever starts
 * refusing, this test says so at install time instead of a user finding out.
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { npmCeiling, runningNpmVersion, satisfiesNpmCeiling } from '../src/contracts/index.js';
import { makeRepository } from './helpers/installer-fixture.js';

const PROJECT_ROOT = fileURLToPath(new URL('../', import.meta.url));

const disposable: string[] = [];

const scratch = (prefix: string): string => {
  const created = mkdtempSync(join(tmpdir(), prefix));
  disposable.push(created);
  return created;
};

afterAll(() => {
  for (const path of disposable.splice(0)) rmSync(path, { recursive: true, force: true });
});

/** npm is given an explicit, quiet environment so the result is the install's and not a config's. */
const npm = (cwd: string, args: readonly string[]): string =>
  execFileSync('npm', [...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      // AD-12's bound, enforced rather than warned about (story 1-12's `.npmrc`).
      npm_config_engine_strict: 'true',
      npm_config_audit: 'false',
      npm_config_fund: 'false',
      npm_config_prefer_offline: 'true',
    },
    timeout: 240_000,
  });

const gitIn = (cwd: string, args: readonly string[]): string =>
  execFileSync(
    'git',
    ['-c', 'user.email=delivery@example.invalid', '-c', 'user.name=Delivery', ...args],
    { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  ).trim();

/**
 * This working tree, as a git repository npm can resolve a ref in.
 *
 * The file list is git's own — tracked files plus untracked ones that are not ignored — so the copy
 * is exactly what a commit of this tree would contain, including the files this story adds and
 * excluding `node_modules/` and `dist/`. `dist/` being excluded matters: it forces `prepare` to
 * actually build, which is the step the `bin` depends on.
 */
const publishWorkingTree = (): { readonly repository: string; readonly ref: string } => {
  const repository = scratch('orch-delivery-src-');
  const listed = execFileSync(
    'git',
    ['-C', PROJECT_ROOT, 'ls-files', '-z', '--cached', '--others', '--exclude-standard'],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  )
    .split('\0')
    .filter((path) => path !== '' && !path.startsWith('docs/'));

  for (const relative of listed) {
    const source = join(PROJECT_ROOT, relative);
    if (!existsSync(source)) continue;
    const destination = join(repository, relative);
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(source, destination);
  }

  gitIn(repository, ['init', '--initial-branch=main']);
  gitIn(repository, ['add', '-A']);
  gitIn(repository, ['commit', '-m', 'delivery fixture']);
  return { repository, ref: gitIn(repository, ['rev-parse', 'HEAD']) };
};

/**
 * The install happens once, before the assertions, because it *is* the subject: every test below
 * reads something the same install produced. The timeout is generous for a reason stated in the
 * docblock — this builds a TypeScript package inside an npm install.
 */
let spec = '';
let consumer = '';
let installed = '';
/** The linked entry point, as a consumer of the package would invoke it. */
const orch = (): string => join(consumer, 'node_modules', '.bin', 'orch');

beforeAll(() => {
  const published = publishWorkingTree();
  spec = `git+file://${published.repository}#${published.ref}`;
  // A consumer is what `npx` builds for itself: a directory with nothing else in it.
  consumer = scratch('orch-delivery-consumer-');
  writeFileSync(
    join(consumer, 'package.json'),
    `${JSON.stringify({ name: 'delivery-consumer', version: '1.0.0', private: true }, null, 2)}\n`,
    'utf8',
  );
  installed = npm(consumer, ['install', spec]);
}, 300_000);

describe('the npm bound AD-12 depends on still holds', () => {
  it('runs on an npm below the version that would disable this path', () => {
    const version =
      runningNpmVersion() ?? execFileSync('npm', ['--version'], { encoding: 'utf8' }).trim();
    expect(
      satisfiesNpmCeiling(version),
      `npm ${version} is at or above the declared bound ${npmCeiling().version}; AD-12's revisit ` +
        'condition has arrived and the delivery path must be re-verified or replaced.',
    ).toBe(true);
  });
});

describe('npm resolves this repository’s git ref into a runnable init (matrix 15)', () => {
  it('installs from the ref with engine-strict on, and links the bin', () => {
    expect(installed).toContain('added');
    expect(existsSync(orch())).toBe(true);
  });

  it('ran prepare, so the package it installed contains the built entry point', () => {
    const packageDir = join(consumer, 'node_modules', 'agent-orcastrator');
    expect(existsSync(join(packageDir, 'dist', 'bin', 'init.js'))).toBe(true);
    expect(existsSync(join(packageDir, 'dist', 'installer', 'index.js'))).toBe(true);
  });

  it('answers --help through the linked bin', () => {
    const help = execFileSync(orch(), ['--help'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    expect(help).toContain('init');
    expect(help).toContain('.orch/');
  });

  it('actually installs a repository through the delivered entry point', () => {
    const target = makeRepository();
    disposable.push(target);

    const output = execFileSync(orch(), ['init', target], {
      encoding: 'utf8',
      // Every answer is empty, which takes the offered default — the delivered binary is doing the
      // whole interview, not printing a usage message.
      input: '\n'.repeat(40),
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    expect(output).toContain('.orch/ is installed');
    expect(existsSync(join(target, '.orch', 'profile.toml'))).toBe(true);
    expect(existsSync(join(target, '.orch', 'manifest.toml'))).toBe(true);
  });

  it('refuses a directory that is not a repository, with the exit code a script reads', () => {
    const notARepository = scratch('orch-delivery-notrepo-');
    let status: number | null = null;
    try {
      execFileSync(orch(), ['init', notARepository], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      status = (error as { status?: number }).status ?? null;
    }
    expect(status).toBe(1);
    expect(existsSync(join(notARepository, '.orch'))).toBe(false);
  });

  it('runs through `npm exec`, which is the `npx` of AD-12 itself', () => {
    const version = npm(consumer, ['exec', '--yes', `--package=${spec}`, '--', 'orch', '--version']);
    expect(version.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });
});
