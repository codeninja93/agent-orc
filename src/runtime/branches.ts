/**
 * The branch names the orchestrator generates itself, in the one module every layer may read.
 *
 * **Why this is in `src/runtime/` and not in `src/engine/`.** AD-22 gives the committer sole ownership of
 * *feature*-branch naming and forbids any other unit inferring a branch name from a feature slug. The
 * take-over branch is not a feature branch: it is named from the run id, carries no product meaning, and
 * belongs to CAP-23's escape hatch. AD-22 is satisfied by there being exactly one function that names it —
 * not by that function living in a particular directory.
 *
 * Story 1-10 hit the consequence of it living in `src/engine/handoff.ts`. The handoff card has to tell a
 * person which branch their work is on, the spine's dependency graph gives `tui -> contracts, runtime` with
 * no edge to the engine, and the alternatives were both worse than a relocation: a card spelling the
 * pattern itself is exactly what AD-22 forbids, and adding `branch` to the `handoff.recorded` payload would
 * put a bare 26-character ULID inside a payload string, which AD-21's entropy sweep replaces — measured at
 * 5.07 bits per character for `orch/takeover/<ulid>`, well above the sweep's 3.5 threshold. The only escape
 * from that would have been widening the redaction allow-list, which AD-21 admits no remedy for.
 *
 * So the *name* moved here and the engine re-exports it, which is the move stories 1-9 and 1-10 already
 * made four times for the same rule. Nothing that decides anything moved: `escapeHatch` still owns whether
 * a branch is created and what lands on it.
 */
import { assertSafePathSegment } from './paths.js';

/**
 * The branch prefix the escape hatch uses.
 *
 * `orch/takeover/<run-id>`: an ordinary branch, in the run's own namespace, named from a ULID that carries
 * no product meaning. It cannot collide with, or pre-empt, the `feature/<slug>` branch the committer will
 * one day create (AD-22), and it cannot be mistaken for the worktree's own `orch/run/<run-id>` branch from
 * story 1-6.
 */
export const TAKEOVER_BRANCH_PREFIX = 'orch/takeover/';

/**
 * The take-over branch for a run.
 *
 * The run id is validated as a path segment rather than trusted, because a branch name reaches `git` as an
 * argument and reaches a person as something to type — and because this function is now called from a
 * renderer, which reads the run id out of an event envelope rather than minting it.
 */
export const takeoverBranchFor = (run: string): string =>
  `${TAKEOVER_BRANCH_PREFIX}${assertSafePathSegment(run, 'a run id')}`;

/**
 * The take-over branch, or `null` for a run id no path segment could be built from.
 *
 * A renderer needs this form: a card is a pure function of what it was handed and must not throw at a
 * malformed value read out of a log. A caller that minted the id itself uses {@link takeoverBranchFor} and
 * wants the refusal.
 */
export const takeoverBranchOrNull = (run: string | null): string | null => {
  if (run === null || run === '') return null;
  try {
    return takeoverBranchFor(run);
  } catch {
    return null;
  }
};
