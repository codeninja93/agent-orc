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
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  NODE_ENGINES_RANGE,
  NodeFloorError,
  assertNodeFloor,
  compareVersions,
  nodeFloor,
  nodeFloorMessage,
  nvmrcVersion,
  parseNodeFloor,
  parseVersion,
  satisfiesNodeFloor,
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
