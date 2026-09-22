/**
 * The declared-territory path vocabulary: how a declared path is spelled, and what contains what.
 *
 * **Why this is in `src/contracts/` and not in `src/engine/territory.ts`, where it began.** The
 * Consistency Conventions serialise "any features whose declared file territories overlap", and until
 * story 2-4 the only unit asking that question was the reconciler, so the comparison lived beside the
 * admission decision. This story adds a second asker: `step.analysis` declares a territory and every
 * claim it makes has to fall inside it (matrix row 18), which is a property of one output artifact and
 * therefore a parse-time refusal in the contract. A contract cannot import the engine —
 * `src/contracts/` is the root of the dependency graph, asserted in
 * `tests/contracts.subset-guard.test.ts` — so the alternative was a second implementation of path
 * containment, which is exactly the failure this module exists to prevent: two spellings of one path
 * that compare unequal report an overlap as disjoint, and that is the direction that corrupts a
 * worktree. `src/engine/territory.ts` re-exports these, so there is one implementation and one name.
 *
 * Nothing here decides anything about a *run*. Admission, deferral, the ledger and the replay stay in
 * the engine, which is where the AD-4 recomputation lives.
 */
import { posix, sep } from 'node:path';

/**
 * Normalise a declared territory entry to a comparable path.
 *
 * Territories are declared by a person, by a profile, or now by an analysis agent, so they arrive
 * spelled loosely: a backslash separator on one machine, a trailing slash on a directory, a leading
 * `./`. Two spellings of one path that compared unequal would report an overlap as disjoint, which is
 * the failure direction that actually corrupts a worktree.
 */
export const normaliseTerritoryPath = (declared: string): string => {
  const slashed = declared.split(sep).join('/').split('\\').join('/');
  const normalised = posix.normalize(slashed.trim());
  const withoutLeadingDot = normalised.startsWith('./') ? normalised.slice(2) : normalised;
  const trimmed = withoutLeadingDot.replace(/\/+$/, '');
  return trimmed === '' || trimmed === '.' ? '.' : trimmed;
};

/** A declared territory: normalised, de-duplicated, and in a stable order. */
export const normaliseTerritory = (declared: readonly string[]): readonly string[] =>
  [...new Set(declared.map(normaliseTerritoryPath))].sort();

/**
 * True when `container` contains or equals `candidate`.
 *
 * Compared segment by segment, not by string prefix: `src/engine` must not be read as containing
 * `src/engine-notes.ts`, which a `startsWith` would claim. A container of `.` is the whole repository
 * and therefore contains everything.
 *
 * Directional, which {@link pathsCollide} is not, and the direction is the whole point for a claim: a
 * territory of `src/engine/lock.ts` does **not** contain a claim about `src/engine`, though the two
 * collide. Reading collision as containment would admit a claim wider than the territory that was
 * declared for it.
 */
export const pathContains = (container: string, candidate: string): boolean => {
  const held = normaliseTerritoryPath(container);
  const wanted = normaliseTerritoryPath(candidate);
  return held === '.' || held === wanted || wanted.startsWith(`${held}/`);
};

/** True when one path contains or equals the other, in either direction. */
export const pathsCollide = (a: string, b: string): boolean =>
  pathContains(a, b) || pathContains(b, a);

/**
 * True when a declared path is inside the repository it is declared against.
 *
 * An absolute path, a Windows drive letter and a `..` that climbs out of the tree are each a path the
 * run worktree does not contain, and `--add-dir` scoped to that worktree is what ADR-001 bounds a step
 * by — so a claim naming one is a claim about a file the step was never admitted to. Normalisation
 * happens first, because `src/../../etc` only escapes once it is resolved.
 */
export const isRepositoryRelativePath = (declared: string): boolean => {
  const normalised = normaliseTerritoryPath(declared);
  if (normalised === '') return false;
  if (normalised.startsWith('/')) return false;
  if (/^[A-Za-z]:/.test(normalised)) return false;
  return normalised !== '..' && !normalised.startsWith('../');
};

/** True when some entry of a declared territory contains the path. Containment, not collision. */
export const territoryContains = (
  territory: readonly string[],
  path: string,
): boolean => normaliseTerritory(territory).some((entry) => pathContains(entry, path));
