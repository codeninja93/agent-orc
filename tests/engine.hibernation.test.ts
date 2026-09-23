/**
 * AD-24 — hibernation on reaching a ceiling: story 2-9's matrix rows 8–11.
 *
 * **The worktree is real and its "before" is verifiably not its "after".** A hibernation test whose fixture
 * already had the take-over branch, or had nothing uncommitted, would pass whether or not the ceiling ever
 * triggered anything. So the step here leaves an uncommitted file behind, each test first asserts the branch
 * does *not* exist and the note has not been written, and only then lets the clock reach the ceiling.
 *
 * **One write path, asserted twice.** Hibernation goes through `escapeHatch` and nothing else, which is
 * checked by behaviour — the take-over commit carries the ceiling trigger only `escapeHatch` writes — and by
 * a source guard in the same idiom story 2-8 used for "no second write path to question state".
 */
import { existsSync, readFileSync, rmSync } from 'node:fs';

import { afterEach, describe, expect, it } from 'vitest';

import { BUDGET_EXHAUSTED_EVENT_TYPE, isTerminalFeatureState } from '../src/contracts/index.js';
import type { RunState } from '../src/contracts/index.js';
import { ENGINE_EVENT_TYPES, decideAction, takeoverBranchFor, terminated } from '../src/engine/index.js';
import type { WorktreeGit } from '../src/engine/index.js';
import { decideReclamation, fileRunStateReader } from '../src/pool/index.js';
import { runPaths } from '../src/runtime/index.js';

import { LOOSE_CEILINGS, ceilingWorld } from './helpers/ceiling-fixture.js';
import type { CeilingWorld } from './helpers/ceiling-fixture.js';
import { fixtureGit, makeGitWorktree } from './helpers/engine-fixture.js';
import type { GitWorktree } from './helpers/engine-fixture.js';
import { stripComments } from './helpers/source-sweep.js';

const worlds: CeilingWorld[] = [];
const cleanups: (() => void)[] = [];

afterEach(() => {
  for (const world of worlds.splice(0)) world.close();
  for (const cleanup of cleanups.splice(0)) cleanup();
});

/** The environment-pinned git, so a developer's own hooks or signing config cannot change the result. */
const fixtureWorktreeGit: WorktreeGit = (worktree, args) => {
  try {
    return { status: 0, stdout: fixtureGit(worktree, args), stderr: '' };
  } catch (thrown: unknown) {
    const error = thrown as { status?: number; stderr?: Buffer | string } | null;
    const stderr = error?.stderr;
    return {
      status: typeof error?.status === 'number' ? error.status : 1,
      stdout: '',
      stderr: typeof stderr === 'string' ? stderr : (stderr?.toString('utf8') ?? 'git failed'),
    };
  }
};

const PARTIAL_FILE = 'src/partial.ts';
const PARTIAL_CONTENT = 'export const partial = "half of the feature";\n';

/**
 * A run whose first step leaves uncommitted work behind, under a ten-minute wall-clock ceiling.
 *
 * Only the wall clock is tight, so the ceiling that trips is the one the test moves.
 */
const hibernatingWorld = (label: string): { readonly world: CeilingWorld; readonly worktree: GitWorktree } => {
  const worktree = makeGitWorktree(`hibernation-${label}`);
  cleanups.push(() => rmSync(worktree.dir, { recursive: true, force: true }));
  const world = ceilingWorld({
    label: `hibernation-${label}`,
    ceilings: { ...LOOSE_CEILINGS, wall_clock_minutes: 10 },
    worktree: worktree.dir,
    worktreeGit: fixtureWorktreeGit,
    onStart: (request) => {
      if (request.step === 'implement') worktree.write(PARTIAL_FILE, PARTIAL_CONTENT);
      return terminated(request.step, 'completed');
    },
  });
  worlds.push(world);
  return { world, worktree };
};

const branchExists = (worktree: GitWorktree, branch: string): boolean => {
  try {
    fixtureGit(worktree.dir, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]);
    return true;
  } catch {
    return false;
  }
};

const stateOf = (world: CeilingWorld, run: string): RunState => world.reconciler.load(run).state;

/** Run the implementation step, which leaves the partial work, and prove nothing is preserved yet. */
const leavePartialWork = async (
  world: CeilingWorld,
  worktree: GitWorktree,
): Promise<{ readonly run: string; readonly branch: string }> => {
  const run = world.start();
  await world.reconciler.pass();
  const branch = takeoverBranchFor(run);
  // The "before", asserted: uncommitted work, no take-over branch, no note, and a live run.
  expect(worktree.read(PARTIAL_FILE)).toBe(PARTIAL_CONTENT);
  expect(fixtureGit(worktree.dir, ['status', '--porcelain'])).toContain('partial.ts');
  expect(branchExists(worktree, branch)).toBe(false);
  expect(existsSync(runPaths(run, world.home).handoffDocument)).toBe(false);
  expect(isTerminalFeatureState(stateOf(world, run).state)).toBe(false);
  return { run, branch };
};

describe('a run reaching a ceiling hibernates through the escape hatch (matrix row 8)', () => {
  it('emits budget.exhausted, enters hibernated and writes the hand-off note', async () => {
    const { world, worktree } = hibernatingWorld('reach');
    const { run } = await leavePartialWork(world, worktree);

    world.at(600_000);
    const result = await world.reconciler.pass();

    expect(result.actions.find((action) => action.run === run)?.kind).toBe('hibernate');
    const state = stateOf(world, run);
    expect(state.state).toBe('hibernated');
    expect(state.handoff?.code).toBe('budget.exhausted');
    const exhausted = world.ofType(run, BUDGET_EXHAUSTED_EVENT_TYPE);
    expect(exhausted).toHaveLength(1);
    expect(exhausted[0]?.payload).toMatchObject({ dimension: 'wall_clock', consumed: 600_000, fraction: 1 });
    // Not the generic escape, and not a hand-off: the ceiling case, in the ceiling's vocabulary.
    expect(world.ofType(run, ENGINE_EVENT_TYPES.FeatureStateChanged).map((event) => event.payload['to'])).not.toContain(
      'handed_off',
    );

    const note = readFileSync(runPaths(run, world.home).handoffDocument, 'utf8');
    expect(note).toContain('hibernated at a run ceiling');
    expect(note).toContain('`budget.exhausted`');
    expect(note).toContain('`hibernated`');
    // The verify step was never started: hibernation replaced the spend, it did not follow it.
    expect(world.executor.started.map((request) => request.step)).toStrictEqual(['implement']);
  });
});

describe('a hibernated run’s work is preserved on a take-over branch (matrix row 9)', () => {
  it('commits the uncommitted work onto the branch, marked as a ceiling, and restores the worktree', async () => {
    const { world, worktree } = hibernatingWorld('preserve');
    const { run, branch } = await leavePartialWork(world, worktree);

    world.at(600_000);
    await world.reconciler.pass();

    expect(branchExists(worktree, branch)).toBe(true);
    expect(fixtureGit(worktree.dir, ['show', `${branch}:${PARTIAL_FILE}`])).toBe(PARTIAL_CONTENT.trim());
    // Only `escapeHatch` writes this subject, and only when told the trigger was a ceiling.
    expect(fixtureGit(worktree.dir, ['log', '-1', '--format=%s', branch])).toContain('hibernated at a run ceiling');
    expect(fixtureGit(worktree.dir, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('main');
    const note = readFileSync(runPaths(run, world.home).handoffDocument, 'utf8');
    expect(note).toContain(`git checkout ${branch}`);
  });
});

describe('a hibernated run is terminal (matrix row 10)', () => {
  it('takes no further action, and AD-32’s reclaim pass releases its worktree', async () => {
    const { world, worktree } = hibernatingWorld('terminal');
    const { run } = await leavePartialWork(world, worktree);
    const worktreeResource = [{ kind: 'worktree' as const, id: run, run, handle: worktree.dir }];

    // Positive control: while the run is live, nothing of it may be reclaimed.
    expect(decideReclamation(worktreeResource, fileRunStateReader(world.home))[0]?.reclaim).toBe(false);

    world.at(600_000);
    await world.reconciler.pass();
    const lines = world.events(run).length;

    const state = stateOf(world, run);
    expect(isTerminalFeatureState(state.state)).toBe(true);
    expect(decideAction(state, world.plan).kind).toBe('idle');
    const again = await world.reconciler.pass();
    expect(again.actions.find((action) => action.run === run)).toBeUndefined();
    expect(world.events(run)).toHaveLength(lines);

    const [decision] = decideReclamation(worktreeResource, fileRunStateReader(world.home));
    expect(decision?.reclaim).toBe(true);
    expect(decision?.reason).toContain('hibernated');
  });
});

describe('a crash mid-hibernation is finished by the next pass, writing nothing twice (matrix row 11)', () => {
  const BOUNDARIES = [
    'escape-hatch:committed',
    'handoff-document-written',
    'event-appended:handoff.recorded',
    'event-appended:budget.exhausted',
  ] as const;

  for (const boundary of BOUNDARIES) {
    it(`completes the hibernation after a kill at ${boundary}`, async () => {
      const { world, worktree } = hibernatingWorld(`crash-${boundary.replace(/[^a-z]/g, '-')}`);
      const { run, branch } = await leavePartialWork(world, worktree);

      world.at(600_000);
      let killed = false;
      world.restart((label) => {
        if (!killed && label === boundary) {
          killed = true;
          throw new Error(`killed at ${label}`);
        }
      });
      const crashed = await world.reconciler.pass();
      expect(killed).toBe(true);
      expect(crashed.refusals.map((refusal) => refusal.run)).toContain(run);
      // The crash left the run short of terminal: this is the state the next pass must finish.
      expect(stateOf(world, run).state).not.toBe('hibernated');

      world.restart();
      const finished = await world.reconciler.pass();

      expect(finished.actions.find((action) => action.run === run)?.kind).toBe('hibernate');
      expect(stateOf(world, run).state).toBe('hibernated');
      const count = (type: string, code?: string): number =>
        world.ofType(run, type).filter((event) => code === undefined || event.payload['code'] === code).length;
      expect(count(BUDGET_EXHAUSTED_EVENT_TYPE)).toBe(1);
      expect(count(ENGINE_EVENT_TYPES.HandoffRecorded, 'budget.exhausted')).toBe(1);
      expect(
        world.ofType(run, ENGINE_EVENT_TYPES.FeatureStateChanged).filter((event) => event.payload['to'] === 'hibernated'),
      ).toHaveLength(1);
      // The work is on the branch once — one commit above main — and nothing was lost.
      expect(fixtureGit(worktree.dir, ['rev-list', '--count', `main..${branch}`])).toBe('1');
      expect(fixtureGit(worktree.dir, ['show', `${branch}:${PARTIAL_FILE}`])).toBe(PARTIAL_CONTENT.trim());
      expect(existsSync(runPaths(run, world.home).handoffDocument)).toBe(true);
    });
  }

  it('finishes a hibernation the log has begun even when the ceiling no longer reads as reached', async () => {
    const { world, worktree } = hibernatingWorld('crash-clock-back');
    const { run } = await leavePartialWork(world, worktree);
    world.at(600_000);
    world.restart((label) => {
      if (label === 'event-appended:budget.exhausted') throw new Error('killed after budget.exhausted');
    });
    await world.reconciler.pass();
    expect(world.ofType(run, BUDGET_EXHAUSTED_EVENT_TYPE)).toHaveLength(1);

    // The clock is back at the start, so a fresh reading would say the run has all its time left.
    world.at(0);
    world.restart();
    await world.reconciler.pass();

    // The log is the truth (AD-4): a run it records as exhausted hibernates rather than spending on.
    expect(stateOf(world, run).state).toBe('hibernated');
    expect(world.executor.started.map((request) => request.step)).toStrictEqual(['implement']);
  });
});

describe('hibernation has no second branch-and-document path (landmine D)', () => {
  const source = (path: string): string =>
    stripComments(readFileSync(new URL(`../src/${path}`, import.meta.url), 'utf8'));

  it('reaches git only through escapeHatch, and the document only through writeHandoff', () => {
    const reconciler = source('engine/reconciler.ts');
    const start = reconciler.indexOf('private hibernate(');
    const end = reconciler.indexOf('private handOff(');
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const hibernate = reconciler.slice(start, end);

    // The hibernation calls the escape hatch, tells it the trigger, and writes the note the one way.
    expect(hibernate).toMatch(/\bescapeHatch\(\{/);
    expect(hibernate).toContain("trigger: 'ceiling'");
    expect(hibernate).toMatch(/this\.writeHandoff\(/);
    // … and does nothing to the worktree or the document by any other route.
    expect(hibernate).not.toMatch(/worktreeGit\(|execFile|'checkout'|writeHandoffDocument\(|writeFileSync/);

    // Across the engine, one module drives git for a take-over, and two call sites reach it.
    expect(reconciler.match(/\bescapeHatch\(\{/g) ?? []).toHaveLength(2);
    expect(reconciler.match(/\bwriteHandoffDocument\(/g) ?? []).toHaveLength(1);
    for (const module of ['engine/ceilings.ts', 'engine/reconciler.ts', 'engine/steering.ts']) {
      expect({ module, checkout: source(module).includes("'checkout'") }).toStrictEqual({ module, checkout: false });
    }
    expect(source('engine/ceilings.ts')).not.toMatch(/from 'node:/);
  });
});
