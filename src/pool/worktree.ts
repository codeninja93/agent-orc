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
import {
  chmodSync,
  existsSync,
  lchownSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  realpathSync,
} from 'node:fs';
import type { Dirent, Stats } from 'node:fs';
import { basename, dirname, join } from 'node:path';

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

/**
 * The `git` environment variables that override `-C <repo>` targeting, and are therefore dropped.
 *
 * `GIT_DIR`, `GIT_WORK_TREE` and `GIT_INDEX_FILE` each win over the directory `-C` selected, so a value
 * inherited from whatever launched the engine would silently re-point a `worktree add` or a
 * `worktree remove` at another repository. AD-9 makes this process the owner of `ORCH_HOME`; it does not
 * make it the owner of a stray environment, so the environment is sanitised rather than trusted.
 */
export const GIT_ENV_OVERRIDES = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_COMMON_DIR',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_NAMESPACE',
  'GIT_CEILING_DIRECTORIES',
  'GIT_DISCOVERY_ACROSS_FILESYSTEM',
] as const;

/** `env` with every variable in {@link GIT_ENV_OVERRIDES} removed. */
export const sanitisedGitEnv = (env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv =>
  Object.fromEntries(
    Object.entries(env).filter(([name]) => !(GIT_ENV_OVERRIDES as readonly string[]).includes(name)),
  );

export const realGitRunner: GitRunner = (args: readonly string[], cwd?: string): GitResult => {
  try {
    const stdout = execFileSync('git', [...args], {
      encoding: 'utf8',
      timeout: GIT_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: sanitisedGitEnv(),
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

/** Which of the three mode routes granted a uid its write. */
export type WritableRoute = 'owner' | 'group' | 'other';

/**
 * What the kernel will say when the executor uid asks to write this path, and *why*.
 *
 * The route is the point. A bare "writable" answer cannot tell a tree chowned to uid 10001 from a tree
 * made writable by *every* uid on the box: both make the executor's write succeed, and only the first is
 * the containment the chown branch claims. So the answer names the route that granted the write and the
 * path's own uid, and {@link ownershipViolations} checks the route the ownership pass said it took.
 */
export interface UidWritability {
  readonly path: string;
  readonly writable: boolean;
  /** Which route granted the write, or `null` when none did. */
  readonly route: WritableRoute | null;
  /** The path's own uid, so a chown is asserted rather than inferred from a write succeeding. */
  readonly ownerUid: number;
  readonly ownerGid: number;
  /** The permission bits, so a refusal can quote them. */
  readonly mode: number;
}

/**
 * Whether a path's mode permits a write by the given uid, and by which route.
 *
 * Three ways it can: the uid owns it and the owner bit is set, the gid matches and the group bit is
 * set, or the other bit is set. Asked of a real directory rather than inferred from what was just
 * chmodded, because the thing that matters is what the kernel will say when the container asks.
 *
 * `lstatSync` rather than `statSync`: the question is about *this* path, and following a symlink would
 * answer it about a file somewhere else entirely.
 */
export const writabilityForUid = (
  path: string,
  uid: number = EXECUTOR_UID,
  gid: number = EXECUTOR_GID,
): UidWritability => {
  const stat = lstatSync(path);
  const mode = stat.mode & 0o777;
  const route: WritableRoute | null =
    stat.uid === uid && (mode & 0o200) !== 0
      ? 'owner'
      : stat.gid === gid && (mode & 0o020) !== 0
        ? 'group'
        : (mode & 0o002) !== 0
          ? 'other'
          : null;
  return { path, writable: route !== null, route, ownerUid: stat.uid, ownerGid: stat.gid, mode };
};

/** Whether a path's mode permits a write by the given uid, by any of the three routes. */
export const writableByUid = (
  path: string,
  uid: number = EXECUTOR_UID,
  gid: number = EXECUTOR_GID,
): boolean => writabilityForUid(path, uid, gid).writable;

/**
 * Every path inside a directory, the directory itself first. Depth-first, symlinks skipped entirely.
 *
 * A symlinked entry is *skipped*, not merely not descended into. `chmodSync` and `chownSync` both follow
 * symlinks, so a collected symlink would have its target widened or chowned — and a step agent authors
 * the repository content this tree holds, so a committed symlink pointing out of the worktree is the
 * lever that turns the ownership pass into a write grant on an arbitrary host file. The entry is tested
 * with `lstatSync` on the path rather than by the Dirent's `isDirectory()`, because that only ever gated
 * descent. AD-20's containment boundary is the whole reason this pass exists.
 *
 * A path that disappeared between the `readdir` and the `lstat`, or a directory that cannot be read, is
 * skipped rather than thrown: the tree is live, and a vanished path has nothing left to widen.
 */
const walk = (root: string): readonly string[] => {
  const found: string[] = [root];
  const visit = (dir: string): void => {
    let entries: readonly Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      let stat: Stats;
      try {
        stat = lstatSync(path);
      } catch {
        continue;
      }
      if (stat.isSymbolicLink()) continue;
      found.push(path);
      if (stat.isDirectory()) visit(path);
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

  /**
   * A path that vanished mid-pass has nothing left to widen, so its `ENOENT` is not a failure.
   *
   * Anything else is raised: a tree that silently stayed unwritable is a tier-2 run whose first write
   * fails inside the container, which is the failure this whole unit exists to prevent.
   */
  const tolerateVanished = (action: () => void): void => {
    try {
      action();
    } catch (thrown: unknown) {
      const code = (thrown as { code?: string } | null)?.code;
      if (code === 'ENOENT' || code === 'ENOTDIR') return;
      throw thrown;
    }
  };

  if (asRoot) {
    for (const path of paths) {
      tolerateVanished(() => {
        // `lchownSync`, not `chownSync`: `walk` already excluded symlinks, and a symlink that appeared in
        // the window between the two would otherwise be followed — chowning a host file to the executor
        // uid, which is a write grant outside the sandbox rather than inside it.
        lchownSync(path, uid, gid);
        const stat = lstatSync(path);
        if (stat.isSymbolicLink()) return;
        chmodSync(path, (stat.mode & 0o777) | (stat.isDirectory() ? 0o700 : 0o600));
      });
    }
    return {
      strategy: 'chown',
      uid,
      gid,
      detail: `the tree is owned by ${String(uid)}:${String(gid)}, which is the container's executor uid`,
    };
  }

  for (const path of paths) {
    tolerateVanished(() => {
      const stat = lstatSync(path);
      // Re-checked after the walk: `chmodSync` follows symlinks and there is no portable `lchmod`, so a
      // symlink that appeared in the window is skipped rather than chmodded through.
      if (stat.isSymbolicLink()) return;
      const mode = stat.mode & 0o777;
      // Execute on a directory as well as write: a uid that may write a file it cannot traverse to is a
      // uid that cannot write anything.
      chmodSync(path, mode | (stat.isDirectory() ? 0o007 : 0o006));
    });
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

/**
 * Every path under `root` the recorded ownership strategy does not in fact hold for.
 *
 * Strictly stronger than {@link unwritablePaths}, for one reason: an empty `unwritablePaths` is satisfied
 * identically by a tree chowned to the executor uid and by a tree made writable by *every* uid on the
 * box, so on its own it cannot tell the containment `deferred[3]` argues for from the one it would be a
 * bug to ship. Each strategy is therefore checked against what it claims — `chown` that the path is owned
 * by that uid, `widened-mode` that the other-write bit is what grants the write — and a path satisfied by
 * the wrong route is a violation even though a write to it would succeed.
 */
export const ownershipViolations = (
  root: string,
  ownership: WorktreeOwnership,
): readonly string[] =>
  walk(root).flatMap((path): readonly string[] => {
    let check: UidWritability;
    try {
      check = writabilityForUid(path, ownership.uid, ownership.gid);
    } catch {
      // The path went away between the walk and the check; there is nothing left to be writable.
      return [];
    }
    if (!check.writable) {
      return [
        `${path} is not writable by uid ${String(ownership.uid)}: its mode is ` +
          `0${check.mode.toString(8)} and it is owned by ${String(check.ownerUid)}:${String(check.ownerGid)}`,
      ];
    }
    if (ownership.strategy === 'chown' && check.ownerUid !== ownership.uid) {
      return [
        `${path} is owned by uid ${String(check.ownerUid)} rather than by ${String(ownership.uid)}, so ` +
          `the recorded "chown" strategy did not take: the write is granted by its ${check.route ?? 'no'} ` +
          'bits instead, which is a different and weaker claim',
      ];
    }
    if (ownership.strategy === 'widened-mode' && (check.mode & 0o002) === 0) {
      return [
        `${path} has mode 0${check.mode.toString(8)}, whose other-write bit is clear, so the recorded ` +
          '"widened-mode" strategy did not take',
      ];
    }
    return [];
  });

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

/** A path with its symlinks resolved, or the path itself when it cannot be resolved. */
const resolveRealPath = (path: string): string => {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
};

/** The absolute common git directory a repository or a worktree answers with, or `null`. */
const gitCommonDirOf = (path: string, git: GitRunner): string | null => {
  const answer = git(['-C', path, 'rev-parse', '--path-format=absolute', '--git-common-dir']);
  if (answer.status !== 0) return null;
  const value = answer.stdout.trim();
  return value === '' ? null : resolveRealPath(value);
};

/** The branch a checkout is actually standing on, or `null` when its HEAD is detached. */
const checkedOutBranch = (path: string, git: GitRunner): string | null => {
  const answer = git(['-C', path, 'symbolic-ref', '--quiet', '--short', 'HEAD']);
  if (answer.status !== 0) return null;
  const value = answer.stdout.trim();
  return value === '' ? null : value;
};

/**
 * Create a run's worktree, or adopt the one a previous attempt left.
 *
 * Idempotent on purpose. A crash between `worktree add` and the ownership pass leaves a directory the
 * next pass meets, and AD-7 requires the restart to reach the same place as an uninterrupted run — so a
 * directory that is already a linked worktree of this repository is adopted, re-checked for
 * writability, and returned, rather than being refused or silently re-created.
 *
 * "A linked worktree of *this* repository" is checked rather than assumed. "The directory exists and some
 * git repository answers there" is true of an unrelated clone, of a nested repository and of the
 * repository's own main checkout — and the branch this function reports is what story 1-3 resets to
 * `baseline_ref`, so adopting one of those would point a reset at a checkout nobody chose. The common git
 * directory has to match the requested repository's, the checkout has to be a *linked* worktree rather
 * than the main one, and the branch reported is the one HEAD actually names.
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

  const repositoryCommonDir = gitCommonDirOf(request.repository, git);
  if (repositoryCommonDir === null) {
    throw new WorktreeCreateError(
      request.run,
      `${request.repository} answers with no git common directory, so this unit cannot establish which ` +
        'repository a worktree there would belong to',
    );
  }

  // The empty-repository row the I/O matrix does not have. `worktree add` fails on an unborn HEAD with a
  // message about a reference, and `rev-parse HEAD` fails afterwards for the same reason — neither names
  // the actual condition. AD-26 records a step's baseline as a commit, so a repository with none has
  // nothing for a run to reset to and the refusal says exactly that.
  if (
    request.ref === undefined &&
    git(['-C', request.repository, 'rev-parse', '--verify', '--quiet', 'HEAD']).status !== 0
  ) {
    throw new WorktreeCreateError(
      request.run,
      `${request.repository} has no commits, so there is no ref for a worktree to stand on and no ` +
        "baseline for AD-26 to record. The repository needs an initial commit before a run can work in it",
    );
  }

  let adopted = false;
  if (existsSync(path)) {
    const adoptedCommonDir = gitCommonDirOf(path, git);
    const gitDir = git(['-C', path, 'rev-parse', '--path-format=absolute', '--git-dir']);
    // A linked worktree's own git directory is `<common>/worktrees/<name>`; the main worktree's *is* the
    // common directory. Equality therefore means "this is the repository itself", which must never be
    // adopted as a run's disposable checkout.
    const linked =
      gitDir.status === 0 &&
      adoptedCommonDir !== null &&
      resolveRealPath(gitDir.stdout.trim()) !== adoptedCommonDir;
    if (!linked || adoptedCommonDir !== repositoryCommonDir) {
      throw new WorktreeCreateError(
        request.run,
        `${path} already exists and is not a linked worktree of ${request.repository}: it answers with ` +
          `${adoptedCommonDir ?? 'no repository'} rather than ${repositoryCommonDir}. Creating one there ` +
          'would either fail or silently absorb whatever is in it, and adopting it would point story ' +
          "1-3's baseline reset at a checkout this run never chose",
      );
    }
    adopted = true;
  }
  if (!adopted) {
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
  // `ownershipViolations` rather than `unwritablePaths`: the second cannot tell a chown from a
  // world-writable tree, and only one of those is the claim the recorded strategy makes.
  const violations = ownershipViolations(path, ownership);
  if (violations.length > 0) {
    throw new WorktreeCreateError(
      request.run,
      `${String(violations.length)} path(s) under ${path} do not satisfy the recorded "${ownership.strategy}" ` +
        `ownership for the container's executor uid ${String(ownership.uid)}, starting with: ` +
        `${violations[0] ?? path}. Story 1-5 mounts this directory into a container running as that uid, ` +
        'and its own probe chmods its temp directories so it cannot catch this',
    );
  }

  // The branch HEAD actually names, not the one that was requested. Story 1-3 resets to `baseline_ref`
  // using this, so reporting the intention instead of the fact is how a reset reaches the wrong ref.
  const actualBranch = checkedOutBranch(path, git);
  if (actualBranch === null) {
    throw new WorktreeCreateError(
      request.run,
      `${path} stands on no branch: its HEAD is detached. Story 1-3 resets a run's worktree to its ` +
        'recorded baseline on the branch reported here, and a detached HEAD gives it nothing to reset',
    );
  }
  if (!adopted && actualBranch !== branch) {
    throw new WorktreeCreateError(
      request.run,
      `${path} was created for branch ${branch} but stands on ${actualBranch}`,
    );
  }

  const head = git(['-C', path, 'rev-parse', 'HEAD']);
  if (head.status !== 0) {
    throw new WorktreeCreateError(request.run, `the worktree has no HEAD: ${head.stderr.trim()}`);
  }

  return { run: request.run, path, branch: actualBranch, head: head.stdout.trim(), ownership, adopted };
};

/** `true` when a worktree exists at the AD-9 path for this run. Path only; no state is consulted. */
export const worktreeExists = (run: string, orchHome: string = resolveOrchHome()): boolean =>
  existsSync(worktreeDir(run, orchHome));

/**
 * Whether a directory name under `worktrees/` can be used as a run id at all.
 *
 * `worktreeDir` refuses any segment that is not ULID-shaped, and it refuses by throwing — so a single
 * stray directory (a `.staging/`, a `.DS_Store`-adjacent folder, anything a human left) would abort the
 * enumeration before any resource was looked at, and the reclamation pass would then reclaim *nothing*,
 * on every pass, for ever. That is precisely the invisible-leak state AD-32 exists to prevent, so the
 * unusable entry is separated out and reported per resource rather than being allowed to stop the pass.
 */
const isUsableRunDirectory = (name: string, orchHome: string): boolean => {
  try {
    worktreeDir(name, orchHome);
    return true;
  } catch {
    return false;
  }
};

const worktreeDirectoryNames = (orchHome: string): readonly string[] => {
  try {
    return readdirSync(worktreesDir(orchHome), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
};

/** Every run id that has a usable directory under `ORCH_HOME/worktrees/`, in sorted order. */
export const listWorktreeRuns = (orchHome: string = resolveOrchHome()): readonly string[] =>
  worktreeDirectoryNames(orchHome).filter((name) => isUsableRunDirectory(name, orchHome));

/**
 * Every directory under `ORCH_HOME/worktrees/` whose name is not a usable run id.
 *
 * Reported rather than dropped: a directory nothing can name is also a directory no pass can reclaim, and
 * saying so once per pass is the difference between a known stray and a silent leak.
 */
export const listUnusableWorktreeEntries = (
  orchHome: string = resolveOrchHome(),
): readonly string[] =>
  worktreeDirectoryNames(orchHome).filter((name) => !isUsableRunDirectory(name, orchHome));

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
  // `<repo>/.git` for an ordinary clone, answered with `dirname` rather than by stripping a literal
  // suffix. The suffix form was also wrong for every layout where the admin directory is not `.git`
  // beside the work tree — `--separate-git-dir`, or a `GIT_DIR` elsewhere — and those, like a bare
  // repository, are answered by asking git for the main worktree instead of by guessing from the string.
  if (basename(gitDir) === '.git') return dirname(gitDir);
  const listed = git(['-C', worktree, 'worktree', 'list', '--porcelain']);
  if (listed.status === 0) {
    // The first `worktree` line of the porcelain listing is the main worktree, whatever the layout.
    const main = /^worktree (.+)$/m.exec(listed.stdout);
    const mainPath = main?.[1]?.trim();
    if (mainPath !== undefined && mainPath !== '') return mainPath;
  }
  // A bare repository answers with itself.
  return gitDir;
};

/** What a removal request decided, and why. A refusal git raised is data here, not an exception. */
export interface WorktreeRemoval {
  readonly run: string;
  readonly path: string;
  readonly removed: boolean;
  /** True when the registration was pruned, which is a second step git does not always reach. */
  readonly pruned: boolean;
  /**
   * True when the run's own `orch/run/<run-id>` branch was deleted along with the worktree.
   *
   * A ref left behind is permanent state a disposable checkout should not leave: it accumulates one entry
   * per run for ever, and `createWorktree` would silently *check out* a stale one if a run id ever
   * recurred. Only a branch inside the `orch/run/` namespace is ever deleted — AD-22 gives branch naming
   * to the committer, and a `feature/<slug>` branch holding a step's work has to outlive its worktree.
   */
  readonly branchDeleted: boolean;
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
  // Read before the removal, because afterwards the directory is gone and nothing can be asked of it.
  const standingOn = existsSync(path) ? checkedOutBranch(path, git) : runBranchFor(request.run);

  /** Delete the run's own branch, and only ever that: see {@link WorktreeRemoval.branchDeleted}. */
  const deleteRunBranch = (repo: string, branch: string | null): boolean =>
    branch?.startsWith(RUN_BRANCH_PREFIX) === true
      ? git(['-C', repo, 'branch', '-D', branch]).status === 0
      : false;

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
      // A crash between `worktree remove` and the branch delete lands here on the next pass, which is
      // why the branch is still attempted when the directory is already gone.
      branchDeleted: repository === null ? false : deleteRunBranch(repository, standingOn),
      reason: 'the worktree was already gone; its registration was pruned where a repository answered',
    };
  }

  if (repository === null) {
    return {
      run: request.run,
      path,
      removed: false,
      pruned: false,
      branchDeleted: false,
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
      branchDeleted: false,
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
    branchDeleted: deleteRunBranch(repository, standingOn),
    reason:
      request.state === null
        ? 'the run state no longer exists, so no live run holds this worktree (AD-32)'
        : `the run reached the terminal state "${request.state}"`,
  };
};
