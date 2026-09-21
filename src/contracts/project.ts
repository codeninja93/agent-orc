/**
 * AD-10, AD-33 — the central registration record for one project, at
 * `ORCH_HOME/projects/<project-id>/registration.json`.
 *
 * It is a contract rather than a shape inside `src/runtime/` for the reason AD-2 gives: this is an
 * on-disk artifact, three units will read what one writes — the installer registers, the engine
 * resolves, a renderer reports — and AD-28 makes every on-disk artifact carry a `schema_version`,
 * which {@link versioned} attaches along with the refusal that an unrecognised version is never read
 * as if it were current.
 *
 * **The id is identity and the path is a guess.** AD-10 exists because one unit keying a project by
 * path while another keys it by remote URL splits one project into several after a move. So
 * `project_id` is the SHA of the first commit and never changes, and `path` is explicitly a *pointer*
 * that registration corrects on mismatch. The two fields are not symmetric and the shape says so:
 * the id is constrained to the only thing a commit SHA can look like, and the path is free text
 * because a person may move a repository anywhere.
 *
 * **`location` is the record of the last verification, not a judgement.** AD-33: an unresolvable path
 * marks the registration `unlocated` and nothing more — no cleanup, no reclamation, no deletion.
 * The mark exists so a person listing projects can see which pointers are stale; it is cleared again
 * by a verification that succeeds, because the field records what the pointer *is*. Nothing in the
 * system may read `unlocated` as permission to remove anything: only an explicit prune naming an id
 * deletes central state.
 */
import { z } from 'zod';

import { versioned } from './schema-version.js';

/** The contract id this artifact is registered under (AD-17). */
export const PROJECT_REGISTRATION_CONTRACT_ID = 'project.registration';

/**
 * What a `project-id` can look like: a git object name, and nothing else.
 *
 * Forty hex characters for SHA-1 and sixty-four for a repository using the SHA-256 object format.
 * The shape is in the schema rather than only at the boundary because it is the one check that
 * refuses a *path* handed in where an id was wanted — the mistake AD-10 is about, and the one a
 * person standing in the wrong directory makes. `src/runtime/paths.ts`'s `assertSafePathSegment`
 * refuses the same thing for a different reason; both are cheap and neither is the other's backstop.
 */
export const PROJECT_ID_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/** Whether a candidate is shaped like a `project-id` at all, for a caller that wants no throw. */
export const isProjectId = (candidate: string): boolean => PROJECT_ID_PATTERN.test(candidate);

/**
 * The two states a pointer can be in, as the last verification found it.
 *
 * There is deliberately no third state for "abandoned": AD-33 forbids inferring abandonment from a
 * missing path, so a record whose repository has been deleted for a year is `unlocated` and nothing
 * stronger, until a person prunes it by id.
 */
export const PROJECT_LOCATIONS = ['located', 'unlocated'] as const;

export type ProjectLocation = (typeof PROJECT_LOCATIONS)[number];

/**
 * `projects/<project-id>/registration.json`.
 *
 * `project_id` is duplicated inside a record that is already keyed by it, on purpose: the directory
 * name is a path segment and the record is the artifact, and a record read out of the wrong directory
 * — copied, restored from a backup, or written by a caller that joined a segment of its own — is
 * detectable only if it says which project it is. `src/runtime/fetch-record.ts` refuses a foreign
 * record on exactly this field for exactly this reason.
 */
export const ProjectRegistrationSchema = versioned({
  project_id: z.string().regex(PROJECT_ID_PATTERN),
  /** The mutable pointer of AD-10: the repository root this project was last registered from. */
  path: z.string(),
  location: z.enum(PROJECT_LOCATIONS),
  /**
   * When the pointer was first found unresolvable, or `null` while it resolves.
   *
   * The *first* time rather than the most recent, so a person can tell a repository that moved an
   * hour ago from one that has been gone since March. It is not an expiry: nothing reads this field
   * to decide that anything may be removed (AD-33).
   */
  unlocated_since: z.string().nullable(),
  /** RFC3339 with milliseconds in UTC, per the Consistency Conventions. Never rewritten. */
  first_registered_at: z.string(),
  /** The only field an otherwise unchanged re-registration touches. */
  last_registered_at: z.string(),
});

export type ProjectRegistration = z.infer<typeof ProjectRegistrationSchema>;
