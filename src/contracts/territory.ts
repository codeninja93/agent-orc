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

import { z } from 'zod';

/**
 * The shape of "an output that declares a territory": one field, of the right type.
 *
 * Loose on purpose — it is a *discriminator*, not a contract. Every declaring output is also validated
 * against its own registered contract before it reaches here, so this asks only the one question the
 * recorder needs answered.
 */
const TerritoryBearingOutputSchema = z.object({ territory: z.array(z.string()) });

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

/**
 * The first segment of a path, with separators unified and `.` segments dropped — and `..` left alone.
 *
 * Deliberately *not* {@link normaliseTerritoryPath}: that function collapses `..`, which is right for
 * comparing two paths and wrong for asking what a path *starts* with, since `~/../x` would answer `x`.
 * The empty string is returned for a path with no segments at all, which the caller has already refused
 * on other grounds.
 *
 * **Exported for story 3-3's reuse, not reimplemented.** The trust record's "area" is a declared path's
 * first *meaningful* segment (this function's whole job) once a leading `src` has been stripped, and
 * `src/engine/trust-record.ts` needs exactly this primitive to answer it — a second implementation is
 * the same failure this file's own docblock warns about: two spellings of "the first segment" that
 * disagree would attribute one trust signal to two different areas.
 */
export const firstPathSegment = (declared: string): string => {
  const slashed = declared.trim().split(sep).join('/').split('\\').join('/');
  return slashed.split('/').find((segment) => segment !== '' && segment !== '.') ?? '';
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
 * The spellings that *deliberately* mean the whole repository.
 *
 * `.` is the documented fail-safe the engine's `WHOLE_REPOSITORY_TERRITORY` substitutes when it cannot read
 * a declaration: it collides with everything, so the feature is serialised against every other one. That is
 * a value worth accepting. What must not be accepted is a *malformed* entry arriving at the same value by
 * accident.
 */
const WHOLE_REPOSITORY_SPELLINGS: readonly string[] = ['.', './', '.\\'];

/**
 * True when a declared path is inside the repository it is declared against.
 *
 * An absolute path, a Windows drive letter and a `..` that climbs out of the tree are each a path the run
 * worktree does not contain, and `--add-dir` scoped to that worktree is what ADR-001 bounds a step by — so a
 * claim naming one is a claim about a file the step was never admitted to.
 *
 * **A leading `~` *segment* is refused with them, and a file whose name merely begins with `~` is not.**
 * `~/.ssh/id_rsa` is the home directory wearing one character of disguise, and it is the one spelling of
 * "outside the tree" that survives the leading-`/` and the `..` checks. But `~notes.md`, `~tmp.ts` and
 * `~$doc.docx` are ordinary files a repository really holds — editors and Office write them — so the
 * question is whether the *first path segment is exactly* `~`, never whether the string starts with the
 * character. The two directions failed in opposite ways when this was a `startsWith` on the raw spelling:
 * `./~/.ssh/id_rsa` was **accepted**, because `./` made the raw string start with a dot, while `~notes.md`
 * was **refused**, because it starts with a tilde. So the tilde test is the one test here made against the
 * **normalised** value, where `./~/…` and `~/…` are the same path and a filename is still a filename.
 *
 * A `~user` spelling is not treated as expansion: nothing in this system hands these paths to a shell, the
 * escape being closed is a path *join*, and `~backup` is as plausible a directory name as `~notes.md` is a
 * file name.
 *
 * **The tilde is judged on the segments, not on `posix.normalize`'s output, because `..` erases it.**
 * `~/../etc/passwd` *normalises* to `etc/passwd` — an innocent in-tree path — while to anything that
 * expands the tilde it means `/etc/passwd`. So the segment test runs on a spelling that has had its
 * separators unified and its `.` segments dropped but its `..` **not** collapsed, and it asks whether the
 * first surviving segment is `~`. Collapsing first would let a climb cancel the very segment being looked
 * for, which is the same class of mistake as testing the raw string: both judge a spelling rather than the
 * path.
 *
 * **Every other check is made on the raw spelling, before normalisation.** `''`, `'   '`, `'/'`, `'//'` and
 * `'src/..'` all *normalise* to `.`, so a check written after normalising can only ask "is this the whole
 * repository", which every one of them answers yes to — and the `normalised === ''` refusal that used to be
 * here was unreachable for exactly that reason. The consequence is not a concurrency one, since `.` is the
 * fail-safe direction there; it is **containment**: a territory of `.` contains every path, so every
 * claim-inside-its-territory refusal becomes vacuous and any path at all passes. A blank or malformed entry
 * is therefore refused, and the two spellings that say "the whole repository" on purpose are not.
 */
export const isRepositoryRelativePath = (declared: string): boolean => {
  const raw = declared.trim();
  if (raw === '') return false;
  if (raw.startsWith('/') || raw.startsWith('\\')) return false;
  if (/^[A-Za-z]:/.test(raw)) return false;
  if (firstPathSegment(declared) === '~') return false;
  const normalised = normaliseTerritoryPath(declared);
  if (normalised === '.') return WHOLE_REPOSITORY_SPELLINGS.includes(raw);
  return normalised !== '..' && !normalised.startsWith('../');
};

/** True when some entry of a declared territory contains the path. Containment, not collision. */
export const territoryContains = (
  territory: readonly string[],
  path: string,
): boolean => normaliseTerritory(territory).some((entry) => pathContains(entry, path));

/**
 * The territory an output declares, or `null` when it declares none.
 *
 * **The discriminator is the field, never a contract's schema.** Story 2-4 moved this recording off the
 * step's *phase* and onto the contract precisely so there would not be a second place deciding what
 * declares a territory — and then the engine asked `AnalysisOutputSchema.safeParse`, which pins
 * `contract_id` to `step.analysis`. That is the same defect wearing the fix's clothes: `step.planning` and
 * `step.implementation` both carry a declared territory, and both were silently ignored, so the field was
 * dead for two of the three contracts that have it. Naming the three would keep the defect and only move
 * its edge; asking whether the output *has* a declared territory covers a contract a later story adds, and
 * a contract a repository declares for its own agent, without either being listed anywhere.
 *
 * An empty list answers `null` rather than an empty array, because "declared nothing" and "declared these"
 * are different answers and only the second is a correction worth recording — a `blocked` step that could
 * not determine its territory has not re-declared one.
 */
export const declaredTerritoryIn = (output: unknown): readonly string[] | null => {
  const parsed = TerritoryBearingOutputSchema.safeParse(output);
  if (!parsed.success || parsed.data.territory.length === 0) return null;
  return parsed.data.territory;
};
