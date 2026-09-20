/**
 * AD-26 — every step records a baseline commit that a re-run resets to.
 *
 * Idempotency is *mechanised*, not asserted (AD-7). A step records the exact commit its worktree stood
 * at the instant it began, and re-running it resets the worktree to that commit first — so a step may
 * be re-run any number of times with identical effect, whether the previous attempt was interrupted
 * halfway through an edit or finished and is being promoted to a higher model rung.
 *
 * Two things the reset must do, and one it must not:
 *
 * - `reset --hard <ref>` returns every tracked file to the baseline. Alone it is not enough: a step
 *   that created files left them *untracked*, so a re-run would meet its own debris.
 * - `clean -fd` removes those untracked files and directories, which is what makes "identical effect"
 *   true rather than approximately true.
 * - `clean` is **not** given `-x`. Ignored paths — `node_modules`, build caches, the `.orch` runtime
 *   paths the installer adds to `.gitignore` — are not a step's effects, and destroying them would
 *   turn every re-run into a cold rebuild.
 *
 * This is the only git mutation this story performs. Worktree *creation* belongs to story 1-6 and
 * branch naming to the committer in 2-7, so nothing here creates, names or switches a branch.
 */
import { execFileSync } from 'node:child_process';

import { makeError, renderCause } from '../contracts/index.js';
import type { OrchError } from '../contracts/index.js';

/** A full 40-character hex commit SHA, which is what a recorded `baseline_ref` always is. */
export const COMMIT_SHA_PATTERN = /^[0-9a-f]{40}$/;

export const isCommitSha = (value: string): boolean => COMMIT_SHA_PATTERN.test(value);

/**
 * A baseline operation that failed. The code is `git.baseline_reset_failed`, whose declared AD-35
 * disposition is `abandon-and-hand-off`: a worktree that could not be returned to a known commit is
 * exactly the half-mutated state a re-run must never start from, so retrying into it is forbidden.
 */
export class BaselineResetError extends Error {
  readonly code = 'git.baseline_reset_failed';
  readonly worktree: string;
  readonly ref: string;
  /** The error shape this failure crosses a unit boundary as (AD-35). */
  readonly orchError: OrchError;

  constructor(worktree: string, ref: string, detail: string) {
    const message =
      `Could not reset the worktree at ${worktree} to ${ref}: ${detail}. ` +
      'AD-26 makes the baseline reset the precondition of a re-run, so the step is not re-run ' +
      'against a worktree of unknown shape.';
    super(message);
    this.name = 'BaselineResetError';
    this.worktree = worktree;
    this.ref = ref;
    this.orchError = makeError('git.baseline_reset_failed', message, detail);
  }
}

/**
 * The port the loop resets a worktree through.
 *
 * A port rather than a direct `git` call for the same reason the executor is one: the reconciler owns
 * the *decision* to reset, and a test must be able to observe that decision without a repository. The
 * default implementation does run real `git`.
 */
export interface BaselineResetter {
  /** The commit the worktree currently stands at. Recorded as a step's `baseline_ref`. */
  currentRef: (worktree: string) => string;
  /** Return the worktree to `ref`, discarding tracked changes and untracked files alike. */
  resetTo: (worktree: string, ref: string) => void;
}

/**
 * How long a single `git` invocation may take before it is killed.
 *
 * Without a bound, a `git` that hangs — an index lock another process holds, a filesystem that stops
 * answering, a credential helper waiting on a terminal that is not there — blocks the reconcile pass
 * forever, and AD-7's "at most one action per pass" becomes "no actions, ever". A timeout converts that
 * into the declared `git.baseline_reset_failed`, which the AD-35 table hands off.
 */
export const GIT_TIMEOUT_MS = 120_000;

/**
 * How much output a single `git` invocation may produce.
 *
 * `clean -fd` names every path it removes, and a worktree with a large untracked tree exceeds Node's
 * 1 MiB default — at which point `execFileSync` throws `ENOBUFS` and a *successful* clean is reported
 * as a reset failure. The bound is generous rather than tight because the output is discarded either
 * way; it exists so success is not mistaken for failure.
 */
export const GIT_MAX_BUFFER_BYTES = 64 * 1024 * 1024;

const git = (worktree: string, args: readonly string[]): string => {
  try {
    return execFileSync('git', ['-C', worktree, ...args], {
      encoding: 'utf8',
      // Diagnostics never go to stdout (Consistency Conventions); git's own stderr is captured into
      // the thrown error's `cause` instead of being allowed to leak to the terminal.
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: GIT_MAX_BUFFER_BYTES,
    }).trim();
  } catch (thrown: unknown) {
    const stderr = (thrown as { stderr?: Buffer | string } | null)?.stderr;
    const detail =
      typeof stderr === 'string'
        ? stderr.trim()
        : stderr instanceof Buffer
          ? stderr.toString('utf8').trim()
          : (renderCause(thrown) ?? 'git failed without a message');
    throw new BaselineResetError(worktree, args.join(' '), detail);
  }
};

/** The real thing: `git rev-parse HEAD`, then `reset --hard` plus `clean -fd`. */
export const gitBaselineResetter: BaselineResetter = {
  currentRef: (worktree: string): string => {
    const ref = git(worktree, ['rev-parse', 'HEAD']);
    if (!isCommitSha(ref)) {
      throw new BaselineResetError(
        worktree,
        'HEAD',
        `rev-parse returned "${ref}", which is not a commit SHA — a worktree with no commit has no ` +
          'baseline for a step to reset to',
      );
    }
    return ref;
  },

  resetTo: (worktree: string, ref: string): void => {
    if (!isCommitSha(ref)) {
      // A ref this unit cannot recognise is refused rather than passed to git, where a branch name or
      // a relative ref such as `HEAD~1` would resolve to a *different* commit on a later attempt and
      // quietly break the identical-effect guarantee.
      throw new BaselineResetError(
        worktree,
        ref,
        'a baseline_ref must be a full 40-character commit SHA, so a reset lands on the same commit ' +
          'however many times it runs',
      );
    }
    git(worktree, ['reset', '--hard', ref]);
    // Untracked files a previous attempt created are that attempt's effects, so they go too. Ignored
    // paths stay: `-x` is deliberately absent.
    git(worktree, ['clean', '-fd']);
  },
};

/**
 * Record the baseline a step is about to begin at.
 *
 * Called at the instant the step begins and never again for that attempt: the whole guarantee is that
 * the ref names the commit the worktree stood at *before* the step touched anything.
 */
export const recordBaseline = (
  worktree: string,
  resetter: BaselineResetter = gitBaselineResetter,
): string => resetter.currentRef(worktree);

/** What a reset did, so the loop can record it and a reader can see it happened. */
export interface BaselineResetOutcome {
  readonly worktree: string;
  readonly ref: string;
  /** The commit the worktree stood at before the reset, when it could be read. */
  readonly from: string | null;
}

/**
 * Reset a worktree to a step's recorded `baseline_ref` before a re-run.
 *
 * The prior ref is read first and reported, purely so the event this produces can state what was
 * discarded. Failing to read it is not a reason to skip the reset: the reset is the thing that makes
 * the re-run safe, and a worktree whose HEAD cannot be read needs it more, not less.
 */
export const resetToBaseline = (
  worktree: string,
  ref: string,
  resetter: BaselineResetter = gitBaselineResetter,
): BaselineResetOutcome => {
  let from: string | null = null;
  try {
    from = resetter.currentRef(worktree);
  } catch {
    from = null;
  }
  resetter.resetTo(worktree, ref);
  return { worktree, ref, from };
};

/**
 * A resetter that records what it was asked to do and mutates nothing.
 *
 * Exported from the implementation rather than redefined per test file so every suite drives the same
 * double, and so the port's shape cannot drift from the thing tests assert against.
 */
export const createRecordingResetter = (
  head = '0'.repeat(40),
): BaselineResetter & { readonly resets: readonly { worktree: string; ref: string }[] } => {
  const resets: { worktree: string; ref: string }[] = [];
  let current = head;
  return {
    resets,
    currentRef: (): string => current,
    resetTo: (worktree: string, ref: string): void => {
      if (!isCommitSha(ref)) throw new BaselineResetError(worktree, ref, 'not a commit SHA');
      resets.push({ worktree, ref });
      current = ref;
    },
  };
};
