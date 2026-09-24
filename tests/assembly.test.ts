/**
 * Story 2-11 — the composition root's own testable half.
 *
 * `runFeatureToCompletion` spawns real `claude -p` processes, takes a real AD-9 config snapshot from a
 * `.orch/`-installed repository, and (with this story's real write executor wired) pushes a real branch
 * and opens a real pull request — none of which an automated suite may do against a real service. What
 * this file drives instead is everything in `src/assembly/index.ts` that does not require one: the spec
 * parser `bin/orch-run.ts` hands its input to, and the branch-protection probe's parsing and its honest
 * fallback to "unverified" — proven against a real, disposable *local* git repository, never against
 * this repository's own `origin` and never against a real GitHub API.
 */
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  ShadowStartRefUnresolvable,
  ghDefaultBranchProtectionProbe,
  parseConfirmedFeatureSpec,
  resolveShadowStartRef,
  seededUlidMinter,
} from '../src/assembly/index.js';
import { Reconciler, createScriptedExecutor, mintRunId, terminated } from '../src/engine/index.js';
import { createWorktree, runReclamationPass } from '../src/pool/index.js';
import { runPaths } from '../src/runtime/index.js';
import { fixtureGit, makePlan, planProvider } from './helpers/engine-fixture.js';

describe('parseConfirmedFeatureSpec — what bin/orch-run.ts hands a real run', () => {
  const valid = {
    feature: 'write-surface-demo',
    request: 'demonstrate the write executor end to end',
    acceptance_criteria: ['a real pull request is opened', 'the note lands on the merge commit'],
  };

  it('accepts a well-formed spec, territory included', () => {
    const spec = parseConfirmedFeatureSpec(
      JSON.stringify({ ...valid, territory: ['docs/specs'] }),
    );
    expect(spec).toStrictEqual({ ...valid, territory: ['docs/specs'] });
  });

  it('accepts a spec with no declared territory', () => {
    const spec = parseConfirmedFeatureSpec(JSON.stringify(valid));
    expect(spec).toStrictEqual(valid);
  });

  it('refuses a document that is not a JSON object', () => {
    expect(() => parseConfirmedFeatureSpec('[]')).toThrow(/JSON object/);
    expect(() => parseConfirmedFeatureSpec('"a string"')).toThrow(/JSON object/);
  });

  it('refuses text that is not valid JSON at all, with this function’s own message rather than a raw SyntaxError', () => {
    let thrown: unknown = null;
    try {
      parseConfirmedFeatureSpec('{ this is not json');
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain('not valid JSON');
    expect((thrown as Error).name).not.toBe('SyntaxError');
  });

  it('reads and accepts a declared starting_model_tier', () => {
    const spec = parseConfirmedFeatureSpec(
      JSON.stringify({ ...valid, starting_model_tier: 'claude-opus-5' }),
    );
    expect(spec.starting_model_tier).toBe('claude-opus-5');
  });

  it.each([
    [{ ...valid, feature: '' }, /feature/],
    [{ ...valid, feature: undefined }, /feature/],
    [{ ...valid, request: '   ' }, /request/],
    [{ ...valid, acceptance_criteria: [] }, /acceptance_criteria/],
    [{ ...valid, acceptance_criteria: ['fine', 4] }, /acceptance_criteria/],
    [{ ...valid, territory: 'not-an-array' }, /territory/],
    [{ ...valid, starting_model_tier: 'claude-nonexistent' }, /starting_model_tier/],
    [{ ...valid, starting_model_tier: 4 }, /starting_model_tier/],
  ])('refuses an incomplete spec (%#)', (candidate, message) => {
    expect(() => parseConfirmedFeatureSpec(JSON.stringify(candidate))).toThrow(message);
  });
});

describe('ghDefaultBranchProtectionProbe — real git, no real GitHub call ever reached', () => {
  const homes: string[] = [];
  afterEach(() => {
    for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
  });

  const scratchRepo = (): string => {
    const dir = mkdtempSync(join(tmpdir(), 'orch-branch-protection-probe-'));
    homes.push(dir);
    fixtureGit(dir, ['init', '--initial-branch', 'main']);
    fixtureGit(dir, ['commit', '--allow-empty', '-m', 'initial']);
    return dir;
  };

  it('answers null (unverified) for a repository with no remote at all', () => {
    const repo = scratchRepo();
    expect(ghDefaultBranchProtectionProbe(repo, 'main')).toBeNull();
  });

  it('answers null (unverified) for a remote that is not GitHub', () => {
    const repo = scratchRepo();
    fixtureGit(repo, ['remote', 'add', 'origin', 'https://example.invalid/o/r.git']);
    expect(ghDefaultBranchProtectionProbe(repo, 'main')).toBeNull();
  });

  /**
   * The one call this test lets reach a real binary: `gh api`, against a GitHub-shaped remote that does
   * not exist. Whether `gh` is installed, unauthenticated, or answers 404 for a repository nobody owns,
   * every one of those is a failure this probe folds to `null` — never a thrown error, and never a call
   * this suite has to distinguish from network access it is not allowed to make.
   */
  it('answers null (unverified) rather than throwing when gh cannot answer for real', () => {
    const repo = scratchRepo();
    fixtureGit(repo, [
      'remote',
      'add',
      'origin',
      'https://github.com/agent-orcastrator-test-fixture/does-not-exist.git',
    ]);
    expect(() => ghDefaultBranchProtectionProbe(repo, 'main')).not.toThrow();
    expect(ghDefaultBranchProtectionProbe(repo, 'main')).toBeNull();
  });
});

/**
 * The critical fix: `Reconciler.acceptFeature` mints its own run id internally (AD-29), and the worktree
 * has to be created — and named in the plan handed to `acceptFeature` — *before* that id exists. Without
 * `seededUlidMinter`, the two diverge: the worktree lives under one id and the run's durable state lives
 * under another, and `src/pool/reclaim.ts`'s AD-32 pass, which looks up a worktree's run by exactly that
 * id, finds no state for it and reclaims (deletes) a worktree the run is still using. Both tests below
 * use a real scratch git repository and a real `createWorktree`/`runReclamationPass` — never a fake — so
 * the correlation proven is the one AD-32 actually performs, not a description of it.
 */
describe('the worktree id and the accepted run id are the same value', () => {
  const repos: string[] = [];
  const homes: string[] = [];
  afterEach(() => {
    for (const repo of repos.splice(0)) rmSync(repo, { recursive: true, force: true });
    for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
  });

  const scratchRepo = (): string => {
    const dir = mkdtempSync(join(tmpdir(), 'orch-worktree-id-repo-'));
    repos.push(dir);
    fixtureGit(dir, ['init', '--initial-branch', 'main']);
    fixtureGit(dir, ['commit', '--allow-empty', '-m', 'initial']);
    return dir;
  };

  const scratchOrchHome = (): string => {
    const dir = mkdtempSync(join(tmpdir(), 'orch-worktree-id-home-'));
    homes.push(dir);
    return dir;
  };

  const alwaysCompletes = createScriptedExecutor({
    onStart: (request) => terminated(request.step, 'completed', {}),
  });

  it('mints one id, shared by the worktree and the accepted run, via seededUlidMinter', () => {
    const repository = scratchRepo();
    const orchHome = scratchOrchHome();
    const worktreeId = mintRunId();
    const worktree = createWorktree({ run: worktreeId, repository, orchHome });
    expect(worktree.run).toBe(worktreeId);

    const plan = makePlan({ feature: 'worktree-id-fix', worktree: worktree.path });
    const reconciler = Reconciler.open({
      orchHome,
      plans: planProvider(plan),
      executor: alwaysCompletes,
      minter: seededUlidMinter(worktreeId),
    });
    try {
      const accepted = reconciler.acceptFeature(plan);

      // This is the fix: the reconciler's own minted run id is exactly the id already used to name the
      // worktree, not a second, independently-minted one.
      expect(accepted.run).toBe(worktreeId);
      expect(existsSync(runPaths(accepted.run, orchHome).runDir)).toBe(true);
    } finally {
      reconciler.close();
    }
  });

  it('is not reclaimed by an AD-32 pass while the run it belongs to is still live', () => {
    const repository = scratchRepo();
    const orchHome = scratchOrchHome();
    const worktreeId = mintRunId();
    const worktree = createWorktree({ run: worktreeId, repository, orchHome });

    const plan = makePlan({ feature: 'worktree-id-reclaim', worktree: worktree.path });
    const reconciler = Reconciler.open({
      orchHome,
      plans: planProvider(plan),
      executor: alwaysCompletes,
      minter: seededUlidMinter(worktreeId),
    });
    let run: string;
    try {
      run = reconciler.acceptFeature(plan).run;
    } finally {
      reconciler.close();
    }
    expect(run).toBe(worktreeId);
    expect(existsSync(worktree.path)).toBe(true);

    /**
     * AD-32: nothing is reclaimed while its run holds a non-terminal disposition, and `acceptFeature`
     * alone leaves the run `drafting` — very much non-terminal. Before this fix, the worktree lived under
     * an id `fileRunStateReader` could find no state.json for at all, which reads as "no run", and this
     * exact pass would have deleted it out from under a run that was still using it.
     */
    const summary = runReclamationPass({ orchHome });
    expect(
      summary.reclaimed.some((resource) => resource.kind === 'worktree' && resource.id === worktreeId),
    ).toBe(false);
    expect(
      summary.retained.some((resource) => resource.kind === 'worktree' && resource.id === worktreeId),
    ).toBe(true);
    expect(existsSync(worktree.path)).toBe(true);
  });
});

/**
 * Story 3-2 (AD-27), matrix row 9 — a shadow run's worktree starts at the named merge commit's *parent*,
 * never current `HEAD` and never the merge commit itself. `resolveShadowStartRef` is the one new thing a
 * shadow run needs at the worktree layer; `createWorktree`'s existing `ref` option does the rest, proven
 * here against a real scratch repository and a real worktree, never a fake.
 */
describe('resolveShadowStartRef — a shadow run’s worktree starts at the real merge commit’s parent', () => {
  const repos: string[] = [];
  const homes: string[] = [];
  afterEach(() => {
    for (const repo of repos.splice(0)) rmSync(repo, { recursive: true, force: true });
    for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
  });

  const scratchRepo = (): string => {
    const dir = mkdtempSync(join(tmpdir(), 'orch-shadow-ref-repo-'));
    repos.push(dir);
    fixtureGit(dir, ['init', '--initial-branch', 'main']);
    return dir;
  };

  const scratchOrchHome = (): string => {
    const dir = mkdtempSync(join(tmpdir(), 'orch-shadow-ref-home-'));
    homes.push(dir);
    return dir;
  };

  const commit = (repo: string, fileName: string, content: string, message: string): string => {
    writeFileSync(join(repo, fileName), content, 'utf8');
    fixtureGit(repo, ['add', '-A']);
    fixtureGit(repo, ['commit', '-m', message]);
    return fixtureGit(repo, ['rev-parse', 'HEAD']);
  };

  it('resolves to the named merge commit’s parent, not the merge commit and not HEAD', () => {
    const repo = scratchRepo();
    const parent = commit(repo, 'base.txt', 'base\n', 'the commit before the feature');
    const mergeCommit = commit(repo, 'feature.txt', 'the feature\n', 'the real feature, merged');
    // A commit after the merge, so "resolves to HEAD" and "resolves to the parent" are distinguishable.
    commit(repo, 'after.txt', 'later work\n', 'work that landed after the feature');

    expect(resolveShadowStartRef(repo, mergeCommit)).toBe(parent);
  });

  it('creates the worktree at that resolved parent, via createWorktree’s existing ref option', () => {
    const repo = scratchRepo();
    const orchHome = scratchOrchHome();
    const parent = commit(repo, 'base.txt', 'base\n', 'the commit before the feature');
    const mergeCommit = commit(repo, 'feature.txt', 'the feature\n', 'the real feature, merged');
    commit(repo, 'after.txt', 'later work\n', 'work that landed after the feature');

    const ref = resolveShadowStartRef(repo, mergeCommit);
    const worktree = createWorktree({ run: mintRunId(), repository: repo, orchHome, ref });

    expect(fixtureGit(worktree.path, ['rev-parse', 'HEAD'])).toBe(parent);
    expect(existsSync(join(worktree.path, 'after.txt'))).toBe(false);
    expect(existsSync(join(worktree.path, 'feature.txt'))).toBe(false);
    expect(existsSync(join(worktree.path, 'base.txt'))).toBe(true);
  });

  it('throws ShadowStartRefUnresolvable for a merge commit that does not exist', () => {
    const repo = scratchRepo();
    commit(repo, 'base.txt', 'base\n', 'initial');

    expect(() =>
      resolveShadowStartRef(repo, '0000000000000000000000000000000000000000'),
    ).toThrow(ShadowStartRefUnresolvable);
  });

  /**
   * `<sha>^` (first-parent) is well-defined for a commit with any number of parents, but is only actually
   * exercised elsewhere in this file against single-parent history — a true two-parent merge commit
   * (`git merge --no-ff`) is the shape a real, already-merged pull request produces, and the one this
   * story's own primary use case shadows.
   */
  it('resolves to the first parent — the branch merged into — for a true two-parent merge commit', () => {
    const repo = scratchRepo();
    const mainBeforeMerge = commit(repo, 'base.txt', 'base\n', 'main, before the feature merges');

    fixtureGit(repo, ['checkout', '-b', 'feature/two-parent']);
    const featureTip = commit(repo, 'feature.txt', 'the feature\n', 'the feature branch’s own commit');

    fixtureGit(repo, ['checkout', 'main']);
    fixtureGit(repo, ['merge', '--no-ff', '-m', 'merge the feature', 'feature/two-parent']);
    const mergeCommit = fixtureGit(repo, ['rev-parse', 'HEAD']);

    const parents = fixtureGit(repo, ['log', '-1', '--pretty=%P', mergeCommit]).split(/\s+/);
    expect(parents).toHaveLength(2);
    expect(parents[0]).toBe(mainBeforeMerge);
    expect(parents[1]).toBe(featureTip);

    // The first parent — the branch merged *into* — never the branch merged *from*.
    expect(resolveShadowStartRef(repo, mergeCommit)).toBe(mainBeforeMerge);
  });
});
