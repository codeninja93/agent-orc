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
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

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

/**
 * Every `.ts` file under a directory, the same directory-walking shape `tests/tui.controls.test.ts`
 * uses for its own repository-wide guard.
 *
 * A guard whose criterion is "nothing under `src/`" has to read everything under `src/`. Reading one
 * file and calling it a grep is a guard that reports on the file it already trusts.
 */
const typeScriptFilesUnder = (
  root: URL,
): readonly { readonly url: URL; readonly relative: string }[] => {
  const base = fileURLToPath(root);
  const found: { url: URL; relative: string }[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        walk(path);
        continue;
      }
      if (!entry.name.endsWith('.ts')) continue;
      found.push({ url: pathToFileURL(path), relative: relative(base, path) });
    }
  };
  walk(base);
  return found;
};

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
    /**
     * The acceptance criterion is a `grep` over `src/`, and this is that grep — over every `.ts` file
     * under it, not over the one file that happens to hold the parser today. Reading `node-floor.ts`
     * alone left a later story free to hard-code the bound in `installer.ts` or a container flag and
     * keep this green, which is precisely the second authority the criterion exists to forbid.
     *
     * Comments are excluded deliberately: a docblock saying what an `engines.npm` range looks like is
     * documentation, not a second authority, and the Node floor's own comments have always named
     * `>=22.22` the same way.
     */
    const offenders: string[] = [];
    for (const file of typeScriptFilesUnder(new URL('../src/', import.meta.url))) {
      const source = readFileSync(file.url, 'utf8');
      const code = source
        .split('\n')
        .filter((line) => !/^\s*(?:\*|\/\/|\/\*)/.test(line))
        .join('\n');
      if (source.includes(`'${NPM_ENGINES_RANGE}'`) || code.includes(NPM_ENGINES_RANGE)) {
        offenders.push(file.relative);
      }
    }
    expect(offenders, 'the npm bound is declared in package.json and nowhere else').toStrictEqual([]);
    expect(NPM_CEILING_DECLARATION_SITE).toContain('package.json');
  });

  it('walks a real tree, so an empty sweep cannot pass for a clean one', () => {
    // The guard above asserts an *absence*, which a broken walk satisfies trivially. This is the walk
    // finding the file it must be able to find.
    const files = typeScriptFilesUnder(new URL('../src/', import.meta.url));
    expect(files.length).toBeGreaterThan(20);
    expect(files.map((file) => file.relative)).toContain('contracts/node-floor.ts');
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
    // Undecided is never a refusal: a process started directly, not through npm, has no npm to refuse.
    expect(() => {
      assertNpmCeiling(null);
    }).not.toThrow();
  });

  /**
   * The real user agents of the three package managers that are not npm.
   *
   * All three write an `npm/` segment into the same variable, and all three write `npm/?` into it,
   * because they have no npm version to declare. The previous assertion here used
   * `'yarn/4.1.0 npmless node/v22.22.0'`, which contains no `npm/` at all — so it passed on an input no
   * package manager emits and said nothing about the one they all do. The captured `"?"` reached
   * `parseVersion`, which threw a plain `Error` that `assertNodeFloorOrExit` re-throws raw, so importing
   * the contracts package under pnpm, yarn Berry or bun died at import with an unhandled error.
   */
  it.each([
    ['pnpm', 'pnpm/9.1.0 npm/? node/v24.21.0 darwin arm64'],
    ['yarn Berry', 'yarn/4.1.0 npm/? node/v22.22.0'],
    ['bun', 'bun/1.1.29 npm/? node/v22.22.0 darwin arm64'],
  ])('answers null for %s, which declares npm/? rather than an npm version', (_name, userAgent) => {
    expect(runningNpmVersion(userAgent)).toBeNull();
    // And the undecided answer is not a refusal, so the import completes.
    expect(() => {
      assertNpmCeiling(runningNpmVersion(userAgent));
    }).not.toThrow();
  });

  it('answers null for any npm/ segment it cannot read as a version', () => {
    for (const nonsense of ['npm/?', 'npm/unknown', 'npm/-', 'npm/v', 'foo/1 npm/ node/v22.22.0']) {
      expect(runningNpmVersion(nonsense), nonsense).toBeNull();
    }
    // A leading `v` is still a version, and still read.
    expect(runningNpmVersion('npm/v10.9.0 node/v22.22.0')).toBe('v10.9.0');
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
 * The whole chain, end to end, from the environment variable to the exit code.
 *
 * Every assertion above hands the npm version in as an *argument*, and the one test that calls the
 * default returns early when nothing said — so the parsing, the comparison and the message were pinned
 * while the wiring was not. Changing `assertNodeFloorOrExit`'s default from `runningNpmVersion()` to
 * `null`, which severs the environment from the refusal entirely, left the whole suite passing.
 *
 * These children close that: a real process, a real `npm_config_user_agent`, and a real import of
 * `src/contracts/index.ts` — the module every other module in the system imports, and the one that calls
 * the assertion on import. The children run through `jiti` because the source tree imports its siblings
 * by their emitted `.js` names, which bare Node type-stripping does not resolve back to `.ts`.
 */
describe('the environment reaches the refusal, from npm_config_user_agent to the exit code', () => {
  const jiti = fileURLToPath(new URL('../node_modules/jiti/lib/jiti-register.mjs', import.meta.url));
  const contractsUrl = new URL('../src/contracts/index.ts', import.meta.url).href;

  /**
   * `npm_config_user_agent` is *deleted* rather than left alone when a case declares none: this suite is
   * itself usually run through `npm test`, so the variable is already set in the parent and an inherited
   * one would decide the child's answer instead of the case's.
   */
  const importContracts = (userAgent: string | null): ReturnType<typeof spawnSync> => {
    const env = { ...process.env };
    if (userAgent === null) delete env['npm_config_user_agent'];
    else env['npm_config_user_agent'] = userAgent;
    return spawnSync(
      process.execPath,
      ['--import', jiti, '-e', `import('${contractsUrl}').then(() => { process.stdout.write('imported'); });`],
      { encoding: 'utf8', env },
    );
  };

  it('exits 1 and names the engines.npm bound when the environment says npm 12', () => {
    const result = importContracts('npm/12.0.0 node/v24.21.0 darwin arm64 workspaces/false');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(NPM_ENGINES_RANGE);
    expect(result.stderr).toContain(NPM_CEILING_DECLARATION_SITE);
    expect(result.stderr).toContain('git-dependency resolution');
    expect(result.stdout).toBe('');
  });

  it('imports cleanly when the environment says an npm below the bound', () => {
    const result = importContracts('npm/10.9.0 node/v24.21.0 darwin arm64 workspaces/false');
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('imported');
  });

  /**
   * pnpm, yarn Berry and bun, which are the reason this is a defect and not a hypothetical.
   *
   * All three set `npm_config_user_agent` to a string containing `npm/?`. Reading `"?"` as a version
   * threw a plain `Error` out of `parseVersion`, and `assertNodeFloorOrExit` re-throws anything that is
   * neither a `NodeFloorError` nor an `NpmCeilingError` — so importing the contracts package under any of
   * them killed the process at import with `Could not read a semantic version from "?"`. Every module in
   * the system imports contracts, so that is the whole system, dead at import, under three of the four
   * package managers people use.
   */
  it.each([
    ['pnpm', 'pnpm/9.1.0 npm/? node/v24.21.0 darwin arm64'],
    ['yarn Berry', 'yarn/4.1.0 npm/? node/v22.22.0'],
    ['bun', 'bun/1.1.29 npm/? node/v22.22.0 darwin arm64'],
  ])('imports cleanly under %s, which declares npm/?', (_name, userAgent) => {
    const result = importContracts(userAgent);
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('imported');
  });

  it('imports cleanly when nothing said, because undecided is never a refusal', () => {
    const result = importContracts(null);
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('imported');
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

  /**
   * Everything under the top-level `jobs:` key.
   *
   * Taken as a slice rather than matched across the whole file, because `on:`'s `push:` and
   * `pull_request:` are indented identically to a job name and would otherwise be counted as jobs with
   * no steps and no timeout.
   */
  const jobsSection = (): string => {
    const at = workflow.indexOf('\njobs:\n');
    expect(at, 'the workflow declares no jobs').toBeGreaterThan(-1);
    return workflow.slice(at);
  };
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

  /**
   * `engines.node` is a floor, so the build claims everything above it and CI checked one point.
   *
   * Every story's local evidence has been gathered on 24.x while the only version CI ran was the pinned
   * 22.22.0 — a range with one sample in it. The second job runs the same four commands on `current`,
   * which is an *alias*, so it cannot become a third declaration of a version number.
   */
  it('runs the gate on the newest Node as well as the pinned one', () => {
    expect(jobsSection()).toMatch(/^ {2}gate:$/m);
    expect(jobsSection()).toMatch(/^ {2}gate-current:$/m);
    expect(workflow).toContain('node-version: current');
    // Both jobs run all four commands, so "the gate" means the same thing on either Node.
    for (const command of ['npm run typecheck', 'npm run lint', 'npm run build', 'npm test']) {
      expect(
        workflow.split('\n').filter((line) => line.trim() === `- run: ${command}`),
        command,
      ).toHaveLength(2);
    }
  });

  /**
   * A hang must fail rather than burn the six-hour default.
   *
   * Story 1-12 added the most expensive tests in the suite — seven jiti-compiling children per
   * cross-process race, three races — and a child that never settles holds the job until GitHub's own
   * limit. The bound is the workflow's; the races carry their own inside Vitest.
   */
  it('bounds every job in time, and keeps only the newest run of a ref', () => {
    const jobBlocks = jobsSection().split(/^ {2}[a-z][\w-]*:$/m).slice(1);
    expect(jobBlocks.length).toBeGreaterThan(1);
    for (const block of jobBlocks) expect(block).toMatch(/^\s+timeout-minutes: \d+$/m);
    expect(workflow).toMatch(/^concurrency:$/m);
    expect(workflow).toMatch(/^\s+cancel-in-progress: true$/m);
  });

  /**
   * The workflow's comment claimed "`npm ci` then enforces `engines`", which npm does not do on its own.
   *
   * Without `engine-strict`, an `engines` mismatch is a warning and the install proceeds — so matrix row
   * 14's "the install or startup refuses" was half true: only startup refused, and npm 12 installed
   * silently and broke AD-12's delivery path later. The comment is now true because the setting exists.
   */
  it('enforces engines at install, which is the half of matrix row 14 the workflow claimed', () => {
    const npmrc = readFileSync(new URL('../.npmrc', import.meta.url), 'utf8');
    const directives = npmrc
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '' && !line.startsWith('#'));
    expect(directives).toContain('engine-strict=true');
    // And no version literal here either: `.npmrc` turns the bound on, it does not restate it.
    expect(directives.join('\n')).not.toContain(NPM_ENGINES_RANGE);
  });
});
