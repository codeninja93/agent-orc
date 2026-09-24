/**
 * Story 3-2 (AD-27), matrix rows 7, 8 — the shadow run's own comparison report.
 *
 * `compareShadowRun` is driven here against real local scratch repositories, never a fake `git`: the
 * claim under test is that two real git trees compare equal or not, and that the raw diff for a real
 * difference is the one `git diff` itself produces.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { ShadowComparisonFailed, compareShadowRun } from '../src/engine/index.js';
import type { ShadowGitCall } from '../src/engine/index.js';
import { fixtureGit } from './helpers/engine-fixture.js';

const repos: string[] = [];

afterEach(() => {
  while (repos.length > 0) {
    const repo = repos.pop();
    if (repo !== undefined) rmSync(repo, { recursive: true, force: true });
  }
});

const scratchRepo = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'orch-shadow-repo-'));
  repos.push(dir);
  fixtureGit(dir, ['init', '--initial-branch', 'main']);
  return dir;
};

const commit = (repo: string, fileName: string, content: string, message: string): string => {
  writeFileSync(join(repo, fileName), content, 'utf8');
  fixtureGit(repo, ['add', '-A']);
  fixtureGit(repo, ['commit', '-m', message]);
  return fixtureGit(repo, ['rev-parse', 'HEAD']);
};

describe('compareShadowRun — matrix row 7 (identical trees)', () => {
  it('reports accepted with an empty diff when the shadow run reproduced the real tree exactly', () => {
    const repo = scratchRepo();
    commit(repo, 'base.txt', 'base\n', 'initial');

    // The "real" feature: one commit adding a file.
    const realMergeCommit = commit(repo, 'feature.txt', 'the real feature\n', 'the real feature');

    // The "shadow" run: a separate branch, starting from the same parent, that produces the byte-identical
    // tree via a differently-shaped history (a different commit message, a different author moment) —
    // exactly the case a tree comparison must treat as `accepted` where a commit-oid comparison would not.
    fixtureGit(repo, ['checkout', `${realMergeCommit}^`]);
    fixtureGit(repo, ['checkout', '-b', 'shadow/reproduces-the-feature']);
    const shadowHead = commit(repo, 'feature.txt', 'the real feature\n', 'a shadow run composed the same tree');

    const report = compareShadowRun(shadowHead, realMergeCommit, repo);

    expect(report).toStrictEqual({
      outcome: 'accepted',
      shadowTreeRef: shadowHead,
      realMergeCommit,
      diff: '',
    });
  });
});

describe('compareShadowRun — matrix row 8 (material change)', () => {
  it('reports material_change carrying the raw diff when the shadow run diverged', () => {
    const repo = scratchRepo();
    commit(repo, 'base.txt', 'base\n', 'initial');
    const realMergeCommit = commit(repo, 'feature.txt', 'the real feature\n', 'the real feature');

    fixtureGit(repo, ['checkout', `${realMergeCommit}^`]);
    fixtureGit(repo, ['checkout', '-b', 'shadow/diverges']);
    const shadowHead = commit(repo, 'feature.txt', 'a different outcome entirely\n', 'a shadow run diverged');

    const report = compareShadowRun(shadowHead, realMergeCommit, repo);

    expect(report.outcome).toBe('material_change');
    expect(report.shadowTreeRef).toBe(shadowHead);
    expect(report.realMergeCommit).toBe(realMergeCommit);
    expect(report.diff).toContain('feature.txt');
    expect(report.diff).toContain('a different outcome entirely');
    expect(report.diff).toContain('the real feature');
  });

  it('never grades finer than accepted/material_change — no third outcome exists to check', () => {
    // Structural: `ShadowComparisonOutcome` has exactly two members (`src/engine/shadow.ts`), so a test
    // asserting a third would fail to compile rather than fail at runtime — this test documents the
    // invariant rather than needing to probe for it.
    const repo = scratchRepo();
    commit(repo, 'base.txt', 'base\n', 'initial');
    const realMergeCommit = commit(repo, 'feature.txt', 'a\n', 'a');
    fixtureGit(repo, ['checkout', `${realMergeCommit}^`]);
    fixtureGit(repo, ['checkout', '-b', 'shadow/whitespace-only']);
    const shadowHead = commit(repo, 'feature.txt', 'a \n', 'whitespace-only difference');

    // Even a whitespace-only difference is `material_change`: no semantic or fuzzy grading (this story's
    // own Never list).
    const report = compareShadowRun(shadowHead, realMergeCommit, repo);
    expect(report.outcome).toBe('material_change');
  });
});

describe('compareShadowRun — an unreadable ref is a real failure, never a silent material_change', () => {
  it('throws ShadowComparisonFailed with kind "tree" when the shadow ref does not resolve', () => {
    const repo = scratchRepo();
    const realMergeCommit = commit(repo, 'feature.txt', 'a\n', 'a');

    expect(() => compareShadowRun('refs/heads/no-such-branch', realMergeCommit, repo)).toThrow(
      ShadowComparisonFailed,
    );
    try {
      compareShadowRun('refs/heads/no-such-branch', realMergeCommit, repo);
      expect.unreachable();
    } catch (thrown) {
      expect(thrown).toBeInstanceOf(ShadowComparisonFailed);
      expect((thrown as ShadowComparisonFailed).kind).toBe('tree');
      expect((thrown as Error).message).toContain('Could not read the tree');
    }
  });

  it('throws ShadowComparisonFailed when the real merge commit does not resolve', () => {
    const repo = scratchRepo();
    const shadowHead = commit(repo, 'feature.txt', 'a\n', 'a');

    expect(() =>
      compareShadowRun(shadowHead, '0000000000000000000000000000000000000000', repo),
    ).toThrow(ShadowComparisonFailed);
  });

  /**
   * A tree-read failure and a `git diff` failure are distinct facts about the repository — the first means
   * the comparison could not even be attempted, the second means the two trees are already known to
   * differ but the raw diff could not be produced — and must not share one message.
   */
  it('gives a tree-read failure and a diff failure distinct messages', () => {
    const repo = scratchRepo();
    const realMergeCommit = commit(repo, 'feature.txt', 'a\n', 'a');

    let treeFailureMessage = '';
    try {
      compareShadowRun('refs/heads/no-such-branch', realMergeCommit, repo);
    } catch (thrown) {
      treeFailureMessage = thrown instanceof Error ? thrown.message : '';
    }
    expect(treeFailureMessage).not.toBe('');

    // Two distinct fake trees so the comparison proceeds past the "identical" check to the `diff` call,
    // which is then made to fail.
    const fakeGit: ShadowGitCall = (args) => {
      if (args[0] === 'rev-parse') {
        const isRealMergeCommit = args[1] === `${realMergeCommit}^{tree}`;
        return { status: 0, stdout: `${(isRealMergeCommit ? 'b' : 'a').repeat(40)}\n`, stderr: '' };
      }
      if (args[0] === 'diff') return { status: 128, stdout: '', stderr: 'fatal: diff failed' };
      throw new Error(`unexpected git call: ${args.join(' ')}`);
    };

    let diffFailureMessage = '';
    let diffFailureKind: string | null = null;
    try {
      compareShadowRun('shadow-ref', realMergeCommit, repo, fakeGit);
    } catch (thrown) {
      diffFailureMessage = thrown instanceof Error ? thrown.message : '';
      diffFailureKind = thrown instanceof ShadowComparisonFailed ? thrown.kind : null;
    }
    expect(diffFailureKind).toBe('diff');
    expect(diffFailureMessage).not.toBe('');
    expect(diffFailureMessage).not.toBe(treeFailureMessage);
    expect(diffFailureMessage).toContain('git diff itself failed');
  });
});
