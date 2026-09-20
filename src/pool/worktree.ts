/**
 * A run's worktree: created writable by the executor uid, destroyed only at a terminal disposition.
 *
 * Story 1-3's reconciler resets a worktree it assumes exists and story 1-5 confines a worktree it is
 * handed. This is the unit that makes one. Two of its rules are the whole reason it is a unit rather
 * than three lines inside the engine:
 *
 * **Ownership is this story's obligation, and story 1-5's own suite cannot catch a failure.** Story 1-5
 * bind-mounts the worktree into a container running as uid 10001 and chmods its probe directories so
 * that its assertions test the *mount* rather than the host's uid map. So a worktree created writable
 * only by the host user passes every test story 1-5 has and fails on the first real tier-2 run, with a
 * step that cannot write its first file. The mode is therefore asserted here, against a real directory,
 * and a worktree that is not writable by that uid is refused at creation rather than handed on.
 *
 * Two ways exist to satisfy it, and which one applies is a property of the host rather than a choice:
 * as root the directory is chowned to the executor uid, and as an ordinary user — the normal case on a
 * developer machine — the mode is widened so that uid can write. The alternative, passing the host's own
 * uid to the container instead, is refused: it would make the flag set depend on who ran the engine, and
 * story 1-5's suite could then no longer assert a fixed non-root user.
 *
 * **Removal is gated on a terminal disposition and never forces.** `git worktree remove` refuses a
 * worktree holding uncommitted changes, and `--force` would discard a step's work. AD-26 makes a step's
 * effects recoverable by resetting to a recorded baseline, not by deletion, so a removal that forced
 * past uncommitted changes would destroy evidence a re-run would otherwise reproduce. Removal happens
 * only once the run is terminal, where the work is either committed or deliberately abandoned — so the
 * refusal is a signal to surface, and forcing is an explicit, separately-named request no reclamation
 * pass ever makes.
 *
 * The run's evidence under `runs/<run-id>/` is never touched by anything here. The worktree is
 * disposable; the evidence plane (AD-23) is not.
 */
import { execFileSync } from 'node:child_process';
import { chmodSync, chownSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { isTerminalFeatureState, makeError } from '../contracts/index.js';
import type { FeatureState, OrchError } from '../contracts/index.js';
import { EXECUTOR_GID, EXECUTOR_UID } from '../container/index.js';
import { assertSafePathSegment, resolveOrchHome, worktreeDir, worktreesDir } from '../runtime/index.js';

/** How long a single `git` invocation here may take, matching `src/engine/baseline.ts` in spirit. */
export const GIT_TIMEOUT_MS = 60_000;

/** What one `git` invocation reported. A non-zero status is data, not an exception. */
export interface GitResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * How `git` is run. A port, so every decision below is assertable without a repository — and so the one
 * suite that *does* want a real repository gets the real thing rather than a mock of git's behaviour.
 */
export type GitRunner = (args: readonly string[], cwd?: string) => GitResult;

export const realGitRunner: GitRunner = (args: readonly string[], cwd?: string): GitResult => {
  try {
    const stdout = execFileSync('git', [...args], {
      encoding: 'utf8',
      timeout: GIT_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'pipe'],
      ...(cwd === undefined ? {} : { cwd }),
    });
    return { status: 0, stdout, stderr: '' };
  } catch (thrown: unknown) {
    const error = thrown as { status?: number | null; stdout?: string; stderr?: string; message?: string };
    return {
      status: error.status ?? null,
      stdout: error.stdout ?? '',
      stderr: error.stderr ?? error.message ?? '',
    };
  }
};

/**
 * The branch a run's worktree stands on, derived from the run id and never from a feature slug.
 *
 * AD-22 gives the committer sole ownership of branch *naming*: "no other unit may infer a branch name
 * from a feature slug". A worktree has to be on some ref, so this one is named after the run id — a
 * ULID the engine minted, carrying no product meaning — which is why it cannot collide with, or
 * pre-empt, the `feature/<slug>` branch the committer will create.
 */
export const RUN_BRANCH_PREFIX = 'orch/run/';

export const runBranchFor = (run: string): string =>
  `${RUN_BRANCH_PREFIX}${assertSafePathSegment(run, 'a run id')}`;

/** Which route made the worktree writable by the executor uid. Recorded, never assumed. */
export type OwnershipStrategy = 'chown' | 'widened-mode';

export interface WorktreeOwnership {
  readonly strategy: OwnershipStrategy;
  readonly uid: number;
  readonly gid: number;
  /** One sentence naming what was done, for the refusal or the event log. */
  readonly detail: string;
}

/** A created worktree, as every later unit refers to it. */
export interface Worktree {
  readonly run: string;
  /** `ORCH_HOME/worktrees/<run-id>/` — the AD-9 path, built by the runtime's helper. */
  readonly path: string;
  readonly branch: string;
  /** The commit the worktree stands at, which the run's first step records as its baseline (AD-26). */
  readonly head: string;
  readonly ownership: WorktreeOwnership;
  /** True when the worktree already existed and was adopted rather than created. */
  readonly adopted: boolean;
}

/** A worktree could not be created, or could not be made writable by the executor uid. */
export class WorktreeCreateError extends Error {
  readonly code = 'git.worktree_unavailable';
  readonly run: string;
  readonly orchError: OrchError;

  constructor(run: string, detail: string) {
    const message = `Could not provide a worktree for run ${run}: ${detail}`;
    super(message);
    this.name = 'WorktreeCreateError';
    this.run = run;
    this.orchError = makeError(this.code, message, detail);
  }
}

/** A worktree removal was attempted while its run still holds a non-terminal disposition. */
export class LiveWorktreeRemovalError extends Error {
  readonly code = 'internal.invariant_violated';
  readonly run: string;
  readonly state: FeatureState;
  readonly orchError: OrchError;

  constructor(run: string, state: FeatureState) {
    const message =
      `Refusing to remove the worktree of run ${run}: the run is in state "${state}", which is not ` +
      'terminal. AD-32 reclaims a resource only once its run has reached a terminal disposition, and ' +
      "the run's steps are still working in this checkout.";
    super(message);
    this.name = 'LiveWorktreeRemovalError';
    this.run = run;
    this.state = state;
    this.orchError = makeError(this.code, message, `state ${state} is not terminal`);
  }
}

/**
 * Whether a path's mode permits a write by the given uid.
 *
 * Three ways it can: the uid owns it and the owner bit is set, the gid matches and the group bit is
 * set, or the other bit is set. Asked of a real directory rather than inferred from what was just
 * chmodded, because the thing that matters is what the kernel will say when the container asks.
 */
export const writableByUid = (
  path: string,
  uid: number = EXECUTOR_UID,
  gid: number = EXECUTOR_GID,
): boolean => {
  const stat = statSync(path);
  const mode = stat.mode & 0o777;
  if (stat.uid === uid && (mode & 0o200) !== 0) return true;
  if (stat.gid === gid && (mode & 0o020) !== 0) return true;
  return (mode & 0o002) !== 0;
};

/** Every path inside a directory, the directory itself first. Depth-first, symlinks not followed. */
const walk = (root: string): readonly string[] => {
  const found: string[] = [root];
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      found.push(path);
      if (entry.isDirectory() && !entry.isSymbolicLink()) visit(path);
    }
  };
  visit(root);
  return found;
};

/**
 * Make a tree writable by the executor uid, by whichever route the host allows.
 *
 * As root: chown, which is the clean answer and the one a CI Linux host takes. As an ordinary user:
 * widen the mode, because there is no other way for a *fixed* foreign uid to write a path this process
 * owns. The widening is deliberately confined to `ORCH_HOME/worktrees/`, holds a disposable checkout,
 * and is the cost of story 1-5's decision that the container's user is a constant the assertion suite
 * can name.
 */
export const makeWritableByExecutorUid = (
  root: string,
  options: { readonly uid?: number; readonly gid?: number; readonly asRoot?: boolean } = {},
): WorktreeOwnership => {
  const uid = options.uid ?? EXECUTOR_UID;
  const gid = options.gid ?? EXECUTOR_GID;
  const asRoot = options.asRoot ?? process.getuid?.() === 0;
  const paths = walk(root);

  if (asRoot) {
    for (const path of paths) {
      chownSync(path, uid, gid);
      const mode = statSync(path).mode & 0o777;
      chmodSync(path, mode | (statSync(path).isDirectory() ? 0o700 : 0o600));
    }
    return {
      strategy: 'chown',
      uid,
      gid,
      detail: `the tree is owned by ${String(uid)}:${String(gid)}, which is the container's executor uid`,
    };
  }

  for (const path of paths) {
    const stat = statSync(path);
    const mode = stat.mode & 0o777;
    // Execute on a directory as well as write: a uid that may write a file it cannot traverse to is a
    // uid that cannot write anything.
    chmodSync(path, mode | (stat.isDirectory() ? 0o007 : 0o006));
  }
  return {
    strategy: 'widened-mode',
    uid,
    gid,
    detail:
      `this process is not root, so the tree's mode was widened to let uid ${String(uid)} write; ` +
      'passing the host uid to the container instead would make the flag set depend on who ran the engine',
  };
};

/** Every path in the tree that the executor uid could not write. Empty is the only acceptable answer. */
export const unwritablePaths = (
  root: string,
  uid: number = EXECUTOR_UID,
  gid: number = EXECUTOR_GID,
): readonly string[] => walk(root).filter((path) => !writableByUid(path, uid, gid));

export interface WorktreeCreateRequest {
  readonly run: string;
  /** The repository the worktree is linked from. Its own checkout is never touched. */
  readonly repository: string;
  readonly orchHome?: string;
  /** The ref the new branch starts at. `HEAD` of the repository when omitted. */
  readonly ref?: string;
  /** Overridable for a caller that already owns a branch; defaults to {@link runBranchFor}. */
  readonly branch?: string;
  readonly git?: GitRunner;
  readonly uid?: number;
  readonly gid?: number;
  /** Force the root path; only a test that cannot be root drives this. */
  readonly asRoot?: boolean;
}

/**
 * Create a run's worktree, or adopt the one a previous attempt left.
 *
 * Idempotent on purpose. A crash between `worktree add` and the ownership pass leaves a directory the
 * next pass meets, and AD-7 requires the restart to reach the same place as an uninterrupted run — so a
 * directory that is already a linked worktree of this repository is adopted, re-checked for
 * writability, and returned, rather than being refused or silently re-created.
 */
export const createWorktree = (request: WorktreeCreateRequest): Worktree => {
  const orchHome = request.orchHome ?? resolveOrchHome();
  const git = request.git ?? realGitRunner;
  const path = worktreeDir(request.run, orchHome);
  const branch = request.branch ?? runBranchFor(request.run);

  const repoCheck = git(['-C', request.repository, 'rev-parse', '--git-dir']);
  if (repoCheck.status !== 0) {
    throw new WorktreeCreateError(
      request.run,
      `${request.repository} is not a git repository: ${repoCheck.stderr.trim()}`,
    );
  }

  const adopted = existsSync(path) && git(['-C', path, 'rev-parse', '--git-dir']).status === 0;
  if (!adopted) {
    if (existsSync(path)) {
      throw new WorktreeCreateError(
        request.run,
        `${path} already exists and is not a git worktree, so creating one there would either fail or ` +
          'silently absorb whatever is in it',
      );
    }
    mkdirSync(worktreesDir(orchHome), { recursive: true });
    const branchExists =
      git(['-C', request.repository, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]).status === 0;
    const args = branchExists
      ? ['-C', request.repository, 'worktree', 'add', path, branch]
      : [
          '-C',
          request.repository,
          'worktree',
          'add',
          '-b',
          branch,
          path,
          ...(request.ref === undefined ? [] : [request.ref]),
        ];
    const added = git(args);
    if (added.status !== 0) {
      throw new WorktreeCreateError(
        request.run,
        `git worktree add failed: ${(added.stderr.trim() === '' ? added.stdout : added.stderr).trim()}`,
      );
    }
  }

  const ownership = makeWritableByExecutorUid(path, {
    ...(request.uid === undefined ? {} : { uid: request.uid }),
    ...(request.gid === undefined ? {} : { gid: request.gid }),
    ...(request.asRoot === undefined ? {} : { asRoot: request.asRoot }),
  });
  const unwritable = unwritablePaths(path, ownership.uid, ownership.gid);
  if (unwritable.length > 0) {
    throw new WorktreeCreateError(
      request.run,
      `${String(unwritable.length)} path(s) under ${path} are not writable by the container's executor ` +
        `uid ${String(ownership.uid)}, starting with ${unwritable[0] ?? path}. Story 1-5 mounts this ` +
        'directory into a container running as that uid, and its own probe chmods its temp directories ' +
        'so it cannot catch this',
    );
  }

  const head = git(['-C', path, 'rev-parse', 'HEAD']);
  if (head.status !== 0) {
    throw new WorktreeCreateError(request.run, `the worktree has no HEAD: ${head.stderr.trim()}`);
  }

  return { run: request.run, path, branch, head: head.stdout.trim(), ownership, adopted };
};

/** `true` when a worktree exists at the AD-9 path for this run. Path only; no state is consulted. */
export const worktreeExists = (run: string, orchHome: string = resolveOrchHome()): boolean =>
  existsSync(worktreeDir(run, orchHome));

/** Every run id that has a directory under `ORCH_HOME/worktrees/`, in sorted order. */
export const listWorktreeRuns = (orchHome: string = resolveOrchHome()): readonly string[] => {
  try {
    return readdirSync(worktreesDir(orchHome), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
};

/**
 * The repository a linked worktree belongs to, so its registration can be pruned.
 *
 * Asked of git rather than derived from a path convention: the common dir is the authoritative answer
 * and it keeps working for a worktree of a repository that has since moved, which AD-33's lesson says
 * not to treat as abandonment.
 */
export const repositoryOf = (worktree: string, git: GitRunner = realGitRunner): string | null => {
  const common = git(['-C', worktree, 'rev-parse', '--path-format=absolute', '--git-common-dir']);
  if (common.status !== 0) return null;
  const gitDir = common.stdout.trim();
  if (gitDir === '') return null;
  // `<repo>/.git` for an ordinary clone; a bare repository answers with itself.
  const suffix = `${'/'}.git`;
  return gitDir.endsWith(suffix) ? gitDir.slice(0, -suffix.length) : gitDir;
};

/** What a removal request decided, and why. A refusal git raised is data here, not an exception. */
export interface WorktreeRemoval {
  readonly run: string;
  readonly path: string;
  readonly removed: boolean;
  /** True when the registration was pruned, which is a second step git does not always reach. */
  readonly pruned: boolean;
  readonly reason: string;
}

export interface WorktreeRemoveRequest {
  readonly run: string;
  /**
   * The run's state, or `null` when the run's state no longer exists.
   *
   * `null` is the AD-32 orphan signal and is reclaimable; a non-terminal state is refused. It is the
   * caller's job to establish which, because reading run state is `reclaim.ts`'s decision and not a
   * side effect of asking to remove a directory.
   */
  readonly state: FeatureState | null;
  readonly orchHome?: string;
  readonly git?: GitRunner;
  /**
   * Discard uncommitted work to get the removal through.
   *
   * Named rather than defaulted, and never passed by the reclamation pass. `git worktree remove` refuses
   * a dirty worktree, and AD-26 makes a step's effects recoverable by resetting to a baseline rather
   * than by deleting them — so forcing past uncommitted changes destroys evidence a re-run would have
   * reproduced. A caller that truly means it has to say so.
   */
  readonly discardUncommitted?: boolean;
}

/**
 * Remove a run's worktree and prune its registration, only once the run is terminal.
 *
 * The run's evidence directory is not named anywhere in here, which is the point: `runs/<run-id>/` and
 * its event log outlive the worktree indefinitely (AD-23).
 */
export const removeWorktree = (request: WorktreeRemoveRequest): WorktreeRemoval => {
  const orchHome = request.orchHome ?? resolveOrchHome();
  const git = request.git ?? realGitRunner;
  const path = worktreeDir(request.run, orchHome);

  if (request.state !== null && !isTerminalFeatureState(request.state)) {
    throw new LiveWorktreeRemovalError(request.run, request.state);
  }

  const repository = existsSync(path) ? repositoryOf(path, git) : null;

  if (!existsSync(path)) {
    // Absence of the directory is not, on its own, a signal about the run (AD-33) — but the request was
    // to have no worktree there, and there is none. The registration is still pruned: a `worktrees/`
    // entry whose directory is gone is exactly what `prune` is for.
    const pruned = repository === null ? false : git(['-C', repository, 'worktree', 'prune']).status === 0;
    return {
      run: request.run,
      path,
      removed: true,
      pruned,
      reason: 'the worktree was already gone; its registration was pruned where a repository answered',
    };
  }

  if (repository === null) {
    return {
      run: request.run,
      path,
      removed: false,
      pruned: false,
      reason:
        `${path} exists but no repository claims it, so removing it would delete a directory this ` +
        'unit cannot prove is a worktree. A path that cannot be resolved is reported, never destroyed ' +
        '(AD-33)',
    };
  }

  const args = [
    '-C',
    repository,
    'worktree',
    'remove',
    ...(request.discardUncommitted === true ? ['--force'] : []),
    path,
  ];
  const removed = git(args);
  if (removed.status !== 0) {
    const detail = (removed.stderr.trim() === '' ? removed.stdout : removed.stderr).trim();
    return {
      run: request.run,
      path,
      removed: false,
      pruned: false,
      reason:
        `git refused to remove the worktree: ${detail}. AD-26 recovers a step's effects by resetting ` +
        'to its baseline, not by deleting them, so this removal does not force past uncommitted work',
    };
  }

  const pruned = git(['-C', repository, 'worktree', 'prune']).status === 0;
  return {
    run: request.run,
    path,
    removed: true,
    pruned,
    reason:
      request.state === null
        ? 'the run state no longer exists, so no live run holds this worktree (AD-32)'
        : `the run reached the terminal state "${request.state}"`,
  };
};
