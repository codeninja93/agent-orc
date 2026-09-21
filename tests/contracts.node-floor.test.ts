/**
 * AD-28 — the required Node version is declared once, in `.nvmrc` and the `package.json` `engines`
 * field, and asserted at startup. Both halves are tested here: that the two declarations agree,
 * and that the assertion fails fast naming the required version.
 *
 * The exit path itself is asserted here by spawning a child process, so the gate cannot silently
 * regress from "fail fast, named" to "exit zero". Running that child on a genuinely old Node — the
 * fourth command in the story's Verification section — needs a second Node installation this suite
 * cannot assume, so the child is handed a below-floor version explicitly instead.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  NODE_ENGINES_RANGE,
  NPM_CEILING_DECLARATION_SITE,
  NPM_ENGINES_RANGE,
  NodeFloorError,
  NpmCeilingError,
  assertNodeFloor,
  assertNpmCeiling,
  compareVersions,
  nodeFloor,
  nodeFloorMessage,
  npmCeiling,
  npmCeilingMessage,
  nvmrcVersion,
  parseNodeFloor,
  parseNpmCeiling,
  parseVersion,
  runningNpmVersion,
  satisfiesNodeFloor,
  satisfiesNpmCeiling,
} from '../src/contracts/index.js';

describe('the Node floor is declared once, in two agreeing places', () => {
  it('reads a simple lower bound from engines.node', () => {
    const floor = nodeFloor();
    expect(floor.range).toBe(NODE_ENGINES_RANGE);
    expect(floor.version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('declares the same floor in .nvmrc as in engines.node', () => {
    expect(compareVersions(nvmrcVersion(), nodeFloor())).toBe(0);
  });

  it('refuses an engines.node range that does not declare an unambiguous floor', () => {
    expect(() => parseNodeFloor('^22.22.0')).toThrowError(/unambiguous/);
    expect(() => parseNodeFloor('*')).toThrowError(/unambiguous/);
    expect(parseNodeFloor('>=22.22').version).toBe('22.22.0');
    expect(parseNodeFloor('>=24.1.2').version).toBe('24.1.2');
  });
});

describe('the startup assertion fails fast, naming the required version', () => {
  const floor = nodeFloor();

  it('accepts the Node this suite is running on', () => {
    expect(() => {
      assertNodeFloor();
    }).not.toThrow();
    expect(satisfiesNodeFloor(process.versions.node)).toBe(true);
  });

  it('accepts exactly the floor and anything above it', () => {
    expect(satisfiesNodeFloor(floor.version)).toBe(true);
    expect(satisfiesNodeFloor(`${String(floor.major + 2)}.0.0`)).toBe(true);
  });

  it.each(['18.20.8', '20.19.0', '22.14.0'])('rejects Node %s, below the floor', (version) => {
    expect(satisfiesNodeFloor(version)).toBe(false);
    expect(() => {
      assertNodeFloor(version);
    }).toThrowError(NodeFloorError);
  });

  it('names the required version, both declaration sites and the running version', () => {
    const message = nodeFloorMessage('22.14.0');
    expect(message).toContain(floor.version);
    expect(message).toContain(NODE_ENGINES_RANGE);
    expect(message).toContain('.nvmrc');
    expect(message).toContain('engines.node');
    expect(message).toContain('22.14.0');
  });

  it('carries the floor and the running version on the error', () => {
    try {
      assertNodeFloor('22.14.0');
      expect.unreachable('assertNodeFloor should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(NodeFloorError);
      const floorError = error as NodeFloorError;
      expect(floorError.running).toBe('22.14.0');
      expect(floorError.floor.version).toBe(floor.version);
    }
  });

  it('reads a version with or without a leading v, zero-filling a missing minor or patch', () => {
    expect(parseVersion('v24.21.0')).toStrictEqual({ major: 24, minor: 21, patch: 0 });
    expect(parseVersion('22.22.0')).toStrictEqual({ major: 22, minor: 22, patch: 0 });
    // All three are legal .nvmrc contents.
    expect(parseVersion('22.22')).toStrictEqual({ major: 22, minor: 22, patch: 0 });
    expect(parseVersion('22')).toStrictEqual({ major: 22, minor: 0, patch: 0 });
    expect(() => parseVersion('not-a-version')).toThrowError(/semantic version/);
  });

  it('names .nvmrc when its contents are an alias rather than a version', () => {
    // `lts/*` is legal for a version manager but not comparable against the engines.node floor.
    expect(() => parseVersion('lts/*')).toThrowError(/semantic version/);
  });
});

describe('the exit path names the version on stderr and exits non-zero', () => {
  /**
   * Spawned rather than called in-process, because the assertion ends in `process.exit(1)`. Node
   * strips the types from the `.ts` source directly, so no build step is needed.
   */
  const runInChild = (script: string): ReturnType<typeof spawnSync> =>
    spawnSync(process.execPath, ['-e', script], { encoding: 'utf8' });

  const moduleUrl = new URL('../src/contracts/node-floor.ts', import.meta.url).href;

  it('exits 1 and names the required version when handed a Node below the floor', () => {
    const result = runInChild(
      `import('${moduleUrl}').then((m) => { m.assertNodeFloorOrExit('20.19.0'); });`,
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(nodeFloor().version);
    expect(result.stderr).toContain('20.19.0');
    expect(result.stdout).toBe('');
  });

  it('exits 0 and writes nothing when the version meets the floor', () => {
    const result = runInChild(
      `import('${moduleUrl}').then((m) => { m.assertNodeFloorOrExit('${nodeFloor().version}'); });`,
    );
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
  });

  it('does not disguise a different fault as a version failure', () => {
    // An unreadable version is not a floor failure. It must propagate as itself rather than be
    // reported as "this Node is too old", which is what the narrowed catch guarantees.
    const result = runInChild(
      `import('${moduleUrl}').then((m) => { m.assertNodeFloorOrExit('not-a-version'); });`,
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('semantic version');
    expect(result.stderr).not.toContain('or newer is required');
  });

  it('loads the module under test from a real file', () => {
    expect(fileURLToPath(moduleUrl)).toMatch(/src\/contracts\/node-floor\.ts$/);
  });
});

/**
 * The Stack's npm bound, asserted from the manifest rather than from a literal.
 *
 * `engines.npm` was declared and never checked, so npm 12 installed silently and broke AD-12's
 * `npx github:<owner>/<repo>` path later and more obscurely — the failure AD-28 exists to convert into a
 * named one, in the other direction. The bound is an exclusive *upper* bound, which is the one thing a
 * reader of this file is likely to get backwards.
 */
describe('the npm bound is declared once, in package.json', () => {
  it('reads an exclusive upper bound from engines.npm', () => {
    const ceiling = npmCeiling();
    expect(ceiling.range).toBe(NPM_ENGINES_RANGE);
    expect(ceiling.version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('is declared in exactly one place, so nothing in src/ repeats it', () => {
    const source = readFileSync(new URL('../src/contracts/node-floor.ts', import.meta.url), 'utf8');
    /**
     * The acceptance criterion is a `grep` for the quoted literal over `src/`, and this is that grep,
     * twice: the quoted form nowhere, and the range nowhere in the code at all. Comments are excluded
     * deliberately — a docblock saying what an `engines.npm` range looks like is documentation, not a
     * second authority, and the Node floor's own comments have always named `>=22.22` the same way.
     */
    const code = source
      .split('\n')
      .filter((line) => !/^\s*(?:\*|\/\/|\/\*)/.test(line))
      .join('\n');
    expect(source).not.toContain(`'${NPM_ENGINES_RANGE}'`);
    expect(code).not.toContain(NPM_ENGINES_RANGE);
    expect(NPM_CEILING_DECLARATION_SITE).toContain('package.json');
  });

  it('refuses an engines.npm range that does not declare an unambiguous bound', () => {
    expect(() => parseNpmCeiling('>=12')).toThrowError(/unambiguous/);
    expect(() => parseNpmCeiling('*')).toThrowError(/unambiguous/);
    expect(parseNpmCeiling('<12').version).toBe('12.0.0');
    expect(parseNpmCeiling('<12.3.4').version).toBe('12.3.4');
  });

  it('accepts every npm below the bound and refuses the bound itself', () => {
    const ceiling = npmCeiling();
    expect(satisfiesNpmCeiling(`${String(ceiling.major - 1)}.9.9`)).toBe(true);
    expect(satisfiesNpmCeiling(ceiling.version)).toBe(false);
    expect(satisfiesNpmCeiling(`${String(ceiling.major + 1)}.0.0`)).toBe(false);
  });

  it('names the bound and its declaration site when the running npm is too new', () => {
    const ceiling = npmCeiling();
    expect(() => {
      assertNpmCeiling(ceiling.version);
    }).toThrowError(NpmCeilingError);
    const message = npmCeilingMessage(ceiling.version);
    expect(message).toContain(ceiling.range);
    expect(message).toContain(NPM_CEILING_DECLARATION_SITE);
    expect(message).toContain('git-dependency resolution');
  });

  it('reads the running npm from the user agent npm sets, and answers null when nothing said', () => {
    expect(runningNpmVersion('npm/10.9.0 node/v22.22.0 darwin arm64 workspaces/false')).toBe('10.9.0');
    expect(runningNpmVersion('')).toBeNull();
    // Another package manager's user agent says nothing about npm, so it decides nothing.
    expect(runningNpmVersion('yarn/4.1.0 npmless node/v22.22.0')).toBeNull();
    // Undecided is never a refusal: a process started directly, not through npm, has no npm to refuse.
    expect(() => {
      assertNpmCeiling(null);
    }).not.toThrow();
  });

  it('accepts the npm this suite is running under, when it was run through npm at all', () => {
    const running = runningNpmVersion();
    if (running === null) return;
    expect(satisfiesNpmCeiling(running)).toBe(true);
  });
});

describe('the startup assertion refuses npm 12 as well as an old Node', () => {
  const runInChild = (script: string): ReturnType<typeof spawnSync> =>
    spawnSync(process.execPath, ['-e', script], { encoding: 'utf8' });

  const moduleUrl = new URL('../src/contracts/node-floor.ts', import.meta.url).href;

  it('exits 1 and names the engines.npm bound when handed npm 12', () => {
    const ceiling = npmCeiling();
    const result = runInChild(
      `import('${moduleUrl}').then((m) => { m.assertNodeFloorOrExit('${nodeFloor().version}', '${ceiling.version}'); });`,
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(ceiling.range);
    expect(result.stderr).toContain(NPM_CEILING_DECLARATION_SITE);
    // Not the Node message: the two faults need different advice and must not be confused.
    expect(result.stderr).not.toContain('Switch to Node');
    expect(result.stdout).toBe('');
  });

  it('exits 0 when both the Node floor and the npm bound are met', () => {
    const result = runInChild(
      `import('${moduleUrl}').then((m) => { m.assertNodeFloorOrExit('${nodeFloor().version}', '11.9.9'); });`,
    );
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
  });

  it('reports the Node floor first, because it is the failure that bites first', () => {
    const ceiling = npmCeiling();
    const result = runInChild(
      `import('${moduleUrl}').then((m) => { m.assertNodeFloorOrExit('20.19.0', '${ceiling.version}'); });`,
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Switch to Node');
    expect(result.stderr).not.toContain('git-dependency resolution');
  });
});

/**
 * The CI workflow, asserted as a declaration rather than run.
 *
 * GitHub Actions cannot be run here, so what is asserted is what the file *says*: the four commands of the
 * AD-31 gate, each as a step of its own so a failure names which one failed, both triggers, and — the one
 * that would otherwise drift — the Node version taken from `.nvmrc` rather than written out again.
 */
describe('the CI workflow runs the gate on the pinned Node', () => {
  const workflow = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
  const steps = workflow
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('- run:') || line.startsWith('- uses:'));

  it('runs each of the four commands as its own step', () => {
    for (const command of ['npm run typecheck', 'npm run lint', 'npm run build', 'npm test']) {
      expect(steps, command).toContain(`- run: ${command}`);
    }
    // And installs from the lockfile first, so the gate runs against the declared dependency tree.
    expect(steps).toContain('- run: npm ci');
  });

  it('runs on a push and on a pull request', () => {
    expect(workflow).toMatch(/^on:$/m);
    expect(workflow).toMatch(/^ {2}push:$/m);
    expect(workflow).toMatch(/^ {2}pull_request:$/m);
  });

  it('takes the Node version from .nvmrc, so it cannot disagree with the declared floor', () => {
    expect(workflow).toContain('node-version-file: .nvmrc');
    // A literal version here would be a third declaration of the floor, free to drift from both others.
    expect(workflow).not.toMatch(/node-version:\s*['"]?\d/);
    expect(workflow).not.toContain(nodeFloor().version);
  });
});
