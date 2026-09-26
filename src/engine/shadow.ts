/**
 * Story 3-2 (AD-27) — the shadow run's own comparison report.
 *
 * A shadow run is an ordinary run carrying `mode: 'shadow'`, driven through the real pipeline against a
 * worktree that started at the parent of a named, already-merged feature's real merge commit
 * (`src/assembly/index.ts`'s `shadowing` option). Once that run settles, the one thing left to compute is
 * how its resulting tree compares to what the real feature actually produced — this module's whole job,
 * and no more: no rolling window, no 80% threshold, no gate verdict (story 3-3's).
 *
 * **Byte-identical trees only.** `accepted` means the shadow run's resulting tree and the real merge
 * commit's tree are the same git tree object; anything else is `material_change`, carrying the raw diff.
 * No semantic or fuzzy grading — judging whether a material change is actually fine is a person's call (or
 * a later story's), never this module's.
 *
 * **Why this file shells to `git` directly, duplicating the wrapper in `src/engine/write-executor.ts`,
 * `src/engine/baseline.ts` and `src/pool/worktree.ts`.** The dependency-direction guard in
 * `tests/engine.reconciler.test.ts` confines every file under `src/engine/` to `../contracts/`,
 * `../runtime/` and `node:` builtins, so this module cannot import any of those three — the same
 * duplication the three existing copies already accept.
 */
import { execFileSync } from 'node:child_process';

/** What one `git` invocation reported. A non-zero status is data, not an exception. */
export interface ShadowGitCallResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** How `git` is run for a comparison. A port, injectable for a suite that must not touch a real repository. */
export type ShadowGitCall = (args: readonly string[], cwd: string) => ShadowGitCallResult;

/** How long a single `git` invocation may take, matching `src/engine/write-executor.ts` in spirit. */
export const SHADOW_GIT_TIMEOUT_MS = 120_000;

const SHADOW_GIT_MAX_BUFFER_BYTES = 64 * 1024 * 1024;

const resultOfThrown = (thrown: unknown): ShadowGitCallResult => {
  const error = thrown as { status?: number | null; stdout?: string; stderr?: string; message?: string };
  return {
    status: error.status ?? null,
    stdout: error.stdout ?? '',
    stderr: error.stderr ?? error.message ?? '',
  };
};

/** The real `git`: no new dependency, a thin wrapper that never throws for an ordinary failed exit. */
export const realShadowGitCall: ShadowGitCall = (args, cwd) => {
  try {
    const stdout = execFileSync('git', [...args], {
      cwd,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: SHADOW_GIT_TIMEOUT_MS,
      maxBuffer: SHADOW_GIT_MAX_BUFFER_BYTES,
    });
    return { status: 0, stdout, stderr: '' };
  } catch (thrown: unknown) {
    return resultOfThrown(thrown);
  }
};

/** The two outcomes a comparison may reach — never a third, ungraded one. */
export const SHADOW_COMPARISON_OUTCOMES = ['accepted', 'material_change'] as const;

export type ShadowComparisonOutcome = (typeof SHADOW_COMPARISON_OUTCOMES)[number];

/**
 * What comparing a shadow run's resulting tree against the real merge commit's tree found.
 *
 * `diff` is empty for `accepted` — there is nothing to show — and the raw `git diff` output for
 * `material_change`. No finer grading (whitespace-only, semantically equivalent) is computed here; see
 * this module's own docblock for why.
 */
export interface ShadowComparisonReport {
  readonly outcome: ShadowComparisonOutcome;
  /** The ref this shadow run's resulting tree was read from. */
  readonly shadowTreeRef: string;
  /** The real, already-merged feature's merge commit this run was shadowing. */
  readonly realMergeCommit: string;
  readonly diff: string;
}

/**
 * A tree could not be read for one of the two refs, or the diff itself could not be produced.
 *
 * Thrown rather than folded into `material_change`: a `git rev-parse`/`git diff` failure (an unreadable
 * ref, a corrupt object) is a fact about the repository, not evidence that the two trees differ, and
 * reporting it as `material_change` would misclassify an unreadable comparison as a real one.
 *
 * `kind` distinguishes the two distinct failure shapes: `'tree'` is a `git rev-parse <ref>^{tree}` failure
 * for one specific `ref` (named on the error); `'diff'` is a `git diff` failure *after* both trees were
 * already read and found to differ — a different fact (the comparison itself already stands; only
 * producing its raw diff failed), so it carries its own distinct message rather than reusing the
 * tree-read one.
 */
export class ShadowComparisonFailed extends Error {
  readonly kind: 'tree' | 'diff';
  readonly ref: string;
  readonly detail: string;

  constructor(kind: 'tree' | 'diff', ref: string, detail: string) {
    const message =
      kind === 'tree'
        ? `Could not read the tree for "${ref}" to compare this shadow run against: ${detail}`
        : `The trees for this shadow run and "${ref}" already differ, but git diff itself failed to ` +
          `produce that difference: ${detail}`;
    super(message);
    this.name = 'ShadowComparisonFailed';
    this.kind = kind;
    this.ref = ref;
    this.detail = detail;
  }
}

const detailOf = (result: ShadowGitCallResult): string =>
  result.stderr.trim() !== ''
    ? result.stderr.trim()
    : result.stdout.trim() !== ''
      ? result.stdout.trim()
      : `exited with status ${String(result.status)}`;

const treeOf = (git: ShadowGitCall, repository: string, ref: string): string => {
  const result = git(['rev-parse', `${ref}^{tree}`], repository);
  if (result.status !== 0) throw new ShadowComparisonFailed('tree', ref, detailOf(result));
  const tree = result.stdout.trim();
  if (tree === '') throw new ShadowComparisonFailed('tree', ref, 'git rev-parse produced no tree object');
  return tree;
};

/**
 * Compare a shadow run's resulting tree against the real merge commit it was shadowing — matrix rows 7, 8.
 *
 * Both refs are read relative to the same `repository` (in practice, the shadow run's own worktree, which
 * shares its object store with the checkout it started from, so the real merge commit's history is already
 * reachable there). Identical trees are `accepted`; anything else is `material_change`, carrying the raw
 * `git diff` between the two commits.
 */
export const compareShadowRun = (
  shadowTreeRef: string,
  realMergeCommit: string,
  repository: string,
  git: ShadowGitCall = realShadowGitCall,
): ShadowComparisonReport => {
  const shadowTree = treeOf(git, repository, shadowTreeRef);
  const realTree = treeOf(git, repository, realMergeCommit);

  if (shadowTree === realTree) {
    return { outcome: 'accepted', shadowTreeRef, realMergeCommit, diff: '' };
  }

  // Plain `git diff` (no `--exit-code`) exits 0 whether or not it found a difference; a non-zero status
  // here is a real failure to produce the diff — a repository fault or a bad ref — never the difference
  // itself, which the tree comparison above has already established.
  const diff = git(['diff', shadowTreeRef, realMergeCommit], repository);
  if (diff.status !== 0) {
    throw new ShadowComparisonFailed('diff', realMergeCommit, detailOf(diff));
  }
  return { outcome: 'material_change', shadowTreeRef, realMergeCommit, diff: diff.stdout };
};
