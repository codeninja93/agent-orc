/**
 * The worktree lifecycle, against a real temporary repository.
 *
 * Every claim here is about what git and the filesystem actually do, so nothing is faked: the fixture
 * from story 1-3 builds a real single-commit repository, and `realGitRunner` is the runner under test.
 * A mock of git's behaviour would let two of these assertions pass while the real thing failed — the
 * refusal to remove a dirty worktree, and the mode a bind-mounted directory presents to a foreign uid,
 * are precisely the two properties nobody can assert from prose.
 *
 * No container runtime is involved in any of it, which is the point of the last case: worktree behaviour
 * is fully exercised on a machine where the pool's own operations cannot run.
 */
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { realpathSync } from 'node:fs';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { RUN_STATE_FILE_NAME } from '../src/contracts/index.js';
import { EXECUTOR_GID, EXECUTOR_UID } from '../src/container/index.js';
import { runPaths, worktreeDir, worktreesDir } from '../src/runtime/index.js';
import {
  GIT_ENV_OVERRIDES,
  LiveWorktreeRemovalError,
  RUN_BRANCH_PREFIX,
  WorktreeCreateError,
  createWorktree,
  listUnusableWorktreeEntries,
  listWorktreeRuns,
  makeWritableByExecutorUid,
  ownershipViolations,
  realGitRunner,
  removeWorktree,
  repositoryOf,
  runBranchFor,
  sanitisedGitEnv,
  unwritablePaths,
  worktreeExists,
  writabilityForUid,
  writableByUid,
} from '../src/pool/index.js';

import { fixtureGit, makeGitWorktree, makeHome } from './helpers/engine-fixture.js';
import type { GitWorktree } from './helpers/engine-fixture.js';

const RUN = '01ARZ3NDEKTSV4RRFFQ69G5FAV';

const disposables: string[] = [];

afterAll(() => {
  for (const dir of disposables.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/**
 * A repository and an `ORCH_HOME`, both real and both temporary.
 *
 * `realpathSync` on the home because macOS puts a temporary directory behind a symlink, and git answers
 * questions about a worktree with the resolved path. Comparing an unresolved path against git's answer
 * would fail for a reason that has nothing to do with the behaviour under test.
 */
const world = (label: string): { readonly home: string; readonly repo: GitWorktree } => {
  const home = realpathSync(makeHome(`pool-${label}`));
  const repo = makeGitWorktree(`pool-${label}`);
  disposables.push(home, repo.dir);
  return { home, repo };
};

/** The run's evidence directory, as the engine would have left it. Never touched by a removal. */
const writeEvidence = (home: string, run: string): { readonly log: string; readonly state: string } => {
  const paths = runPaths(run, home);
  mkdirSync(paths.runDir, { recursive: true });
  const log = paths.eventLog;
  const state = join(paths.runDir, RUN_STATE_FILE_NAME);
  writeFileSync(log, '{"seq":1,"type":"run.created"}\n', 'utf8');
  writeFileSync(state, JSON.stringify({ schema_version: 1, run, state: 'committed' }), 'utf8');
  return { log, state };
};

describe('creating a run worktree', () => {
  it('puts it at the AD-9 path, on its own branch, at the repository HEAD', () => {
    const { home, repo } = world('create');
    const worktree = createWorktree({ run: RUN, repository: repo.dir, orchHome: home });

    expect(worktree.path).toBe(worktreeDir(RUN, home));
    expect(worktree.path.startsWith(worktreesDir(home))).toBe(true);
    expect(existsSync(worktree.path)).toBe(true);
    expect(worktreeExists(RUN, home)).toBe(true);
    expect(listWorktreeRuns(home)).toStrictEqual([RUN]);
    // A stray directory beside it is separated out rather than allowed to abort the listing, which is what
    // `worktreeDir`'s refusal of a non-ULID segment used to do to the whole reclamation pass.
    mkdirSync(join(worktreesDir(home), '.staging'), { recursive: true });
    expect(listWorktreeRuns(home)).toStrictEqual([RUN]);
    expect(listUnusableWorktreeEntries(home)).toStrictEqual(['.staging']);

    expect(worktree.branch).toBe(runBranchFor(RUN));
    expect(worktree.branch.startsWith(RUN_BRANCH_PREFIX)).toBe(true);
    expect(fixtureGit(worktree.path, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe(worktree.branch);
    expect(worktree.head).toBe(repo.head);
    expect(worktree.adopted).toBe(false);

    // The checkout is real: the repository's one committed file is there to be edited.
    expect(readFileSync(join(worktree.path, 'src', 'existing.ts'), 'utf8')).toContain('existing');
  });

  it('names its branch after the run id, never after a feature slug (AD-22)', () => {
    // AD-22 gives the committer sole ownership of branch naming, and forbids any other unit inferring
    // one from a feature slug. A run-id branch cannot collide with, or pre-empt, `feature/<slug>`.
    expect(runBranchFor(RUN)).toBe(`orch/run/${RUN}`);
    expect(runBranchFor(RUN)).not.toContain('feature/');
  });

  it('is writable by the container’s executor uid, at every path inside it', () => {
    // Story 1-5's own probe chmods its temp directories, so it tests the mount rather than the host's
    // uid map — which means a worktree writable only by the host user passes every test it has and
    // fails on the first real tier-2 run. This is the assertion that catches it.
    const { home, repo } = world('uid');
    const worktree = createWorktree({ run: RUN, repository: repo.dir, orchHome: home });

    expect(unwritablePaths(worktree.path, EXECUTOR_UID, EXECUTOR_GID)).toStrictEqual([]);
    expect(writableByUid(worktree.path, EXECUTOR_UID, EXECUTOR_GID)).toBe(true);
    expect(writableByUid(join(worktree.path, 'src', 'existing.ts'), EXECUTOR_UID, EXECUTOR_GID)).toBe(
      true,
    );
    // A directory also has to be traversable by that uid, or a writable file inside it is unreachable.
    expect(statSync(join(worktree.path, 'src')).mode & 0o001).not.toBe(0);
    expect(worktree.ownership.uid).toBe(EXECUTOR_UID);
    expect(['chown', 'widened-mode']).toContain(worktree.ownership.strategy);
  });

  it('shows the same directory as unwritable by that uid before the ownership pass runs', () => {
    // The guard above is only evidence if the default state fails it. A directory created by this
    // process with an ordinary mode is exactly what `git worktree add` leaves.
    const { home } = world('unwritable');
    const plain = join(home, 'plain');
    mkdirSync(plain, { recursive: true });
    writeFileSync(join(plain, 'file.ts'), 'x\n', { mode: 0o644 });
    if (process.getuid?.() === 0) return; // as root the uid map is the other case entirely
    expect(unwritablePaths(plain, EXECUTOR_UID, EXECUTOR_GID).length).toBeGreaterThan(0);
  });

  it('never follows a symlink out of the worktree, whose target it would otherwise widen', () => {
    // A step agent authors the content of this tree, so a committed symlink is a lever it controls. The
    // ownership pass collected every entry unconditionally and then `chmod`ped and `chown`ed each one, and
    // both follow symlinks — so this exact file's mode went from -rw------- to -rw----rw-, and as root its
    // owner would have become the executor uid. That is a write grant *outside* the sandbox, handed to the
    // confined party, which is the opposite of what AD-20 is for.
    const { home, repo } = world('symlink-escape');
    const outside = join(home, 'host-secret.txt');
    writeFileSync(outside, 'a host file the run has no business writing\n', { mode: 0o600 });
    const before = statSync(outside);

    const worktree = createWorktree({ run: RUN, repository: repo.dir, orchHome: home });
    symlinkSync(outside, join(worktree.path, 'escape.txt'));
    // Run the pass again with the symlink in place; this is what a second attempt, or an adoption, does.
    makeWritableByExecutorUid(worktree.path);

    const after = statSync(outside);
    expect(after.mode & 0o777).toBe(before.mode & 0o777);
    expect(after.mode & 0o002).toBe(0);
    expect(after.uid).toBe(before.uid);
    expect(after.gid).toBe(before.gid);
    // The symlink's own target is still what it was: nothing replaced or rewrote it either.
    expect(readFileSync(join(worktree.path, 'escape.txt'), 'utf8')).toContain('a host file');
  });

  it('survives a broken symlink and a path that vanishes, without a raw ENOENT', () => {
    const { home, repo } = world('broken-symlink');
    const worktree = createWorktree({ run: RUN, repository: repo.dir, orchHome: home });
    symlinkSync(join(home, 'nothing-is-here.txt'), join(worktree.path, 'dangling.txt'));
    expect(() => makeWritableByExecutorUid(worktree.path)).not.toThrow();
    expect(() => unwritablePaths(worktree.path, EXECUTOR_UID, EXECUTOR_GID)).not.toThrow();
    expect(unwritablePaths(worktree.path, EXECUTOR_UID, EXECUTOR_GID)).toStrictEqual([]);
  });

  it('says which of the two ownership strategies it verified, not merely that a write would succeed', () => {
    // An empty `unwritablePaths` is satisfied identically by "chowned to uid 10001" and by "writable by
    // every uid on the box", and only the first is the containment the chown branch claims. So the check
    // names the route, and a tree satisfied by the wrong one is a violation even though a write succeeds.
    const { home, repo } = world('strategy');
    const worktree = createWorktree({ run: RUN, repository: repo.dir, orchHome: home });
    const ownership = worktree.ownership;

    expect(ownershipViolations(worktree.path, ownership)).toStrictEqual([]);

    const check = writabilityForUid(worktree.path, EXECUTOR_UID, EXECUTOR_GID);
    expect(check.writable).toBe(true);
    if (ownership.strategy === 'chown') {
      // As root: the specific uid, asserted rather than inferred.
      expect(check.route).toBe('owner');
      expect(check.ownerUid).toBe(EXECUTOR_UID);
      expect(check.mode & 0o002).toBe(0);
    } else {
      expect(check.route).toBe('other');
      expect(check.ownerUid).not.toBe(EXECUTOR_UID);
      expect(check.mode & 0o002).not.toBe(0);
    }

    // And the two are told apart: claiming the strategy this host did *not* take is a violation on every
    // path, which is the assertion an `unwritablePaths(...) === []` check could never make.
    const theOtherClaim = {
      ...ownership,
      strategy: ownership.strategy === 'chown' ? ('widened-mode' as const) : ('chown' as const),
    };
    const violations = ownershipViolations(worktree.path, theOtherClaim);
    expect(violations.length).toBeGreaterThan(0);
    expect(violations[0]).toContain('did not take');
  });

  it('adopts a worktree a previous attempt left, rather than refusing or re-creating it', () => {
    const { home, repo } = world('adopt');
    const first = createWorktree({ run: RUN, repository: repo.dir, orchHome: home });
    const second = createWorktree({ run: RUN, repository: repo.dir, orchHome: home });
    expect(second.adopted).toBe(true);
    expect(second.path).toBe(first.path);
    expect(second.branch).toBe(first.branch);
    expect(second.head).toBe(first.head);
  });

  it('refuses a directory that is in the way and is not a worktree', () => {
    const { home, repo } = world('occupied');
    mkdirSync(worktreeDir(RUN, home), { recursive: true });
    writeFileSync(join(worktreeDir(RUN, home), 'stranger.txt'), 'not mine\n', 'utf8');
    expect(() => createWorktree({ run: RUN, repository: repo.dir, orchHome: home })).toThrow(
      WorktreeCreateError,
    );
  });

  it('refuses to adopt a directory that is a different repository, or that repository itself', () => {
    // `existsSync(path) && rev-parse --git-dir succeeds` is true of an unrelated clone, of a nested
    // repository and of a main checkout — and the branch this function reports is what story 1-3 resets to
    // `baseline_ref`, so adopting one of those is a path to resetting the wrong checkout.
    const { home, repo } = world('adopt-stranger');
    const stranger = makeGitWorktree('pool-adopt-stranger');
    disposables.push(stranger.dir);

    // A whole other repository sitting where this run's worktree goes.
    mkdirSync(worktreesDir(home), { recursive: true });
    cpSync(stranger.dir, worktreeDir(RUN, home), { recursive: true });
    try {
      createWorktree({ run: RUN, repository: repo.dir, orchHome: home });
      expect.unreachable('a foreign repository must not be adopted as this run’s worktree');
    } catch (thrown: unknown) {
      expect(thrown).toBeInstanceOf(WorktreeCreateError);
      expect((thrown as WorktreeCreateError).message).toContain('not a linked worktree');
    }
  });

  it('refuses to adopt the requested repository’s own main checkout', () => {
    const { home, repo } = world('adopt-main');
    mkdirSync(worktreesDir(home), { recursive: true });
    // A copy of the repository itself: same common dir, but it is the main worktree rather than a linked one.
    cpSync(repo.dir, worktreeDir(RUN, home), { recursive: true });
    expect(() => createWorktree({ run: RUN, repository: repo.dir, orchHome: home })).toThrow(
      WorktreeCreateError,
    );
  });

  it('reports the branch HEAD actually names, not the one that was requested', () => {
    const { home, repo } = world('actual-branch');
    const worktree = createWorktree({ run: RUN, repository: repo.dir, orchHome: home });
    expect(worktree.branch).toBe(fixtureGit(worktree.path, ['rev-parse', '--abbrev-ref', 'HEAD']));

    // Move the adopted worktree onto a different branch, then adopt it: the answer follows the checkout.
    fixtureGit(worktree.path, ['checkout', '-b', 'orch/run/elsewhere']);
    const adopted = createWorktree({ run: RUN, repository: repo.dir, orchHome: home });
    expect(adopted.adopted).toBe(true);
    expect(adopted.branch).toBe('orch/run/elsewhere');
    expect(adopted.branch).not.toBe(runBranchFor(RUN));
  });

  it('refuses a repository with no commits, naming that rather than a reference error', () => {
    const { home } = world('empty-repo');
    const empty = join(home, 'empty-repo');
    mkdirSync(empty, { recursive: true });
    fixtureGit(empty, ['init', '--initial-branch=main']);
    try {
      createWorktree({ run: RUN, repository: empty, orchHome: home });
      expect.unreachable('a repository with no commits has no ref for a worktree to stand on');
    } catch (thrown: unknown) {
      expect(thrown).toBeInstanceOf(WorktreeCreateError);
      expect((thrown as WorktreeCreateError).message).toContain('no commits');
      expect((thrown as WorktreeCreateError).code).toBe('git.worktree_unavailable');
    }
  });

  it('runs git with no inherited GIT_DIR, GIT_WORK_TREE or GIT_INDEX_FILE', () => {
    // Each of those wins over the directory `-C` selected, so an inherited value would re-point a
    // `worktree add` or a `worktree remove` at another repository entirely.
    const sanitised = sanitisedGitEnv({
      PATH: '/usr/bin',
      GIT_DIR: '/somewhere/else/.git',
      GIT_WORK_TREE: '/somewhere/else',
      GIT_INDEX_FILE: '/tmp/index',
      HOME: '/home/someone',
    });
    for (const name of GIT_ENV_OVERRIDES) expect(Object.keys(sanitised), name).not.toContain(name);
    expect(sanitised['PATH']).toBe('/usr/bin');
    expect(sanitised['HOME']).toBe('/home/someone');

    // And the real runner is the thing that uses it: a poisoned GIT_DIR does not move the target.
    const { home, repo } = world('git-env');
    process.env['GIT_DIR'] = join(home, 'not-a-repo.git');
    try {
      const worktree = createWorktree({ run: RUN, repository: repo.dir, orchHome: home });
      expect(worktree.head).toBe(repo.head);
      expect(repositoryOf(worktree.path, realGitRunner)).toBe(realpathSync(repo.dir));
    } finally {
      delete process.env['GIT_DIR'];
    }
  });

  it('refuses a repository that is not one, carrying a dispositioned code', () => {
    const { home } = world('norepo');
    const notARepo = join(home, 'not-a-repo');
    mkdirSync(notARepo, { recursive: true });
    try {
      createWorktree({ run: RUN, repository: notARepo, orchHome: home });
      expect.unreachable('a non-repository must be refused');
    } catch (thrown: unknown) {
      expect(thrown).toBeInstanceOf(WorktreeCreateError);
      expect((thrown as WorktreeCreateError).code).toBe('git.worktree_unavailable');
      expect((thrown as WorktreeCreateError).orchError.retryable).toBe(true);
    }
  });
});

describe('removing a run worktree', () => {
  it('refuses while the run holds a non-terminal disposition, naming the run and its state', () => {
    const { home, repo } = world('live');
    const worktree = createWorktree({ run: RUN, repository: repo.dir, orchHome: home });

    try {
      removeWorktree({ run: RUN, state: 'running', orchHome: home });
      expect.unreachable('a live run must keep its worktree');
    } catch (thrown: unknown) {
      expect(thrown).toBeInstanceOf(LiveWorktreeRemovalError);
      const refusal = thrown as LiveWorktreeRemovalError;
      expect(refusal.message).toContain(RUN);
      expect(refusal.message).toContain('running');
      expect(refusal.state).toBe('running');
    }
    expect(existsSync(worktree.path)).toBe(true);

    // Every non-terminal state, not only the one that reads most obviously live.
    for (const state of ['drafting', 'confirmed', 'blocked', 'degraded', 'interrupted', 'verifying'] as const) {
      expect(() => removeWorktree({ run: RUN, state, orchHome: home })).toThrow(LiveWorktreeRemovalError);
    }
    expect(existsSync(worktree.path)).toBe(true);
  });

  it('removes it and prunes its registration once the run is terminal', () => {
    const { home, repo } = world('terminal');
    const worktree = createWorktree({ run: RUN, repository: repo.dir, orchHome: home });
    expect(fixtureGit(repo.dir, ['worktree', 'list'])).toContain(worktree.path);

    const removal = removeWorktree({ run: RUN, state: 'committed', orchHome: home });
    expect(removal.removed).toBe(true);
    expect(removal.pruned).toBe(true);
    expect(removal.reason).toContain('committed');
    expect(existsSync(worktree.path)).toBe(false);
    expect(fixtureGit(repo.dir, ['worktree', 'list'])).not.toContain(worktree.path);
    expect(listWorktreeRuns(home)).toStrictEqual([]);
  });

  it('deletes the run’s own branch with the worktree, and leaves every other ref alone', () => {
    // Nothing deleted `orch/run/<run-id>`, so every run left a permanent ref behind — and `branchExists`
    // would then silently *check out* a stale one if a run id ever recurred. Branch naming is 2-7's; ref
    // cleanup after a disposable checkout is not.
    const { home, repo } = world('branch-cleanup');
    const worktree = createWorktree({ run: RUN, repository: repo.dir, orchHome: home });
    const branch = worktree.branch;
    expect(fixtureGit(repo.dir, ['branch', '--list', branch])).toContain(branch);

    const removal = removeWorktree({ run: RUN, state: 'committed', orchHome: home });
    expect(removal.removed).toBe(true);
    expect(removal.branchDeleted).toBe(true);
    expect(fixtureGit(repo.dir, ['branch', '--list', branch])).toBe('');
    // `main` is untouched: only the `orch/run/` namespace is ever deleted (AD-22 owns the rest).
    expect(fixtureGit(repo.dir, ['branch', '--list', 'main'])).toContain('main');
  });

  it('never deletes a branch outside the orch/run/ namespace, even when the worktree is on one', () => {
    const { home, repo } = world('branch-foreign');
    createWorktree({
      run: RUN,
      repository: repo.dir,
      orchHome: home,
      branch: 'feature/somebody-elses-work',
    });
    const removal = removeWorktree({ run: RUN, state: 'committed', orchHome: home });
    expect(removal.removed).toBe(true);
    expect(removal.branchDeleted).toBe(false);
    expect(fixtureGit(repo.dir, ['branch', '--list', 'feature/somebody-elses-work'])).toContain(
      'feature/somebody-elses-work',
    );
  });

  it('removes it for every terminal state the lifecycle has', () => {
    for (const state of ['committed', 'hibernated', 'killed', 'handed_off'] as const) {
      const { home, repo } = world(`terminal-${state}`);
      const worktree = createWorktree({ run: RUN, repository: repo.dir, orchHome: home });
      expect(removeWorktree({ run: RUN, state, orchHome: home }).removed, state).toBe(true);
      expect(existsSync(worktree.path), state).toBe(false);
    }
  });

  it('leaves the run’s evidence directory and event log untouched', () => {
    const { home, repo } = world('evidence');
    const evidence = writeEvidence(home, RUN);
    const logBefore = readFileSync(evidence.log, 'utf8');
    const stateBefore = readFileSync(evidence.state, 'utf8');
    createWorktree({ run: RUN, repository: repo.dir, orchHome: home });

    removeWorktree({ run: RUN, state: 'committed', orchHome: home });

    expect(existsSync(runPaths(RUN, home).runDir)).toBe(true);
    expect(readFileSync(evidence.log, 'utf8')).toBe(logBefore);
    expect(readFileSync(evidence.state, 'utf8')).toBe(stateBefore);
  });

  it('removes an orphan whose run state no longer exists', () => {
    const { home, repo } = world('orphan');
    const worktree = createWorktree({ run: RUN, repository: repo.dir, orchHome: home });
    const removal = removeWorktree({ run: RUN, state: null, orchHome: home });
    expect(removal.removed).toBe(true);
    expect(removal.reason).toContain('the run state no longer exists');
    expect(existsSync(worktree.path)).toBe(false);
  });

  it('refuses to discard uncommitted work, and says why, rather than forcing past it', () => {
    // AD-26 recovers a step's effects by resetting to its baseline, not by deleting them. A removal
    // that forced would destroy evidence a re-run would otherwise reproduce.
    const { home, repo } = world('dirty');
    const worktree = createWorktree({ run: RUN, repository: repo.dir, orchHome: home });
    writeFileSync(join(worktree.path, 'src', 'existing.ts'), 'export const existing = 2;\n', 'utf8');

    const refused = removeWorktree({ run: RUN, state: 'killed', orchHome: home });
    expect(refused.removed).toBe(false);
    expect(refused.reason).toContain('AD-26');
    expect(existsSync(worktree.path)).toBe(true);
    expect(readFileSync(join(worktree.path, 'src', 'existing.ts'), 'utf8')).toContain('= 2');

    // The discard is available, but only to a caller that names it. No reclamation pass ever does.
    const forced = removeWorktree({
      run: RUN,
      state: 'killed',
      orchHome: home,
      discardUncommitted: true,
    });
    expect(forced.removed).toBe(true);
    expect(existsSync(worktree.path)).toBe(false);
  });

  it('reports an absent worktree as already gone rather than as a failure', () => {
    const { home } = world('absent');
    const removal = removeWorktree({ run: RUN, state: 'committed', orchHome: home });
    expect(removal.removed).toBe(true);
    expect(removal.reason).toContain('already gone');
  });

  it('reports, never deletes, a directory no repository claims (AD-33)', () => {
    const { home } = world('unclaimed');
    const stranger = worktreeDir(RUN, home);
    mkdirSync(stranger, { recursive: true });
    writeFileSync(join(stranger, 'file.txt'), 'not a worktree\n', 'utf8');

    const removal = removeWorktree({ run: RUN, state: 'committed', orchHome: home });
    expect(removal.removed).toBe(false);
    expect(removal.reason).toContain('AD-33');
    expect(existsSync(stranger)).toBe(true);
  });

  it('finds the repository a worktree belongs to, and answers null for one that is not', () => {
    const { home, repo } = world('repo-of');
    const worktree = createWorktree({ run: RUN, repository: repo.dir, orchHome: home });
    expect(repositoryOf(worktree.path, realGitRunner)).toBe(realpathSync(repo.dir));
    expect(repositoryOf(home, realGitRunner)).toBe(null);
  });

  it('leaves the source repository’s own checkout alone', () => {
    const { home, repo } = world('source');
    const before = repo.listing();
    const worktree = createWorktree({ run: RUN, repository: repo.dir, orchHome: home });
    writeFileSync(join(worktree.path, 'src', 'added.ts'), 'export const added = 1;\n', 'utf8');
    removeWorktree({ run: RUN, state: 'committed', orchHome: home, discardUncommitted: true });
    expect(repo.listing()).toStrictEqual(before);
    expect(fixtureGit(repo.dir, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('main');
  });
});
