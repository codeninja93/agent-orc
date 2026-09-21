/**
 * AD-10, AD-33 — registering a project centrally, resolving it back to a repository, and pruning it.
 *
 * Three operations over `ORCH_HOME/projects/<project-id>/registration.json`, and one rule they all
 * obey: **the id is identity and the path is a guess.** AD-10 exists because one unit keying a project
 * by path while another keys it by remote URL splits one project into several after a move, so every
 * function here takes a *project-id*, and a filesystem path is only ever an input to be verified or an
 * output to be corrected.
 *
 * **Resolution verifies; it does not trust.** A recorded path is stale in two different ways — the
 * directory may be gone, or it may now hold a *different* repository — and following the second is
 * worse than failing on the first, because it reads one project's central record against another
 * project's code. So {@link resolveProject} reads the first-commit SHA at the pointed path and compares
 * it to the id; equality is the only thing that makes a pointer live. The `unlocated` result carries no
 * path at all, which is a structural guarantee rather than a discipline: there is no field for it to
 * hand a caller the other project's checkout in.
 *
 * **Unlocated means unlocated and nothing more (AD-33).** An unresolvable path marks the record and
 * stops. No cleanup, no reclamation, no deletion, and no message implying any of those — what is at
 * stake is a project's accumulated memory, and a repository that was merely moved must reattach to its
 * own history when it is registered again.
 *
 * **Prune is the only deleter, it names an id, and it refuses a living project.** AD-9 requires a prune
 * command for state *orphaned* by a deleted project directory. A project that still resolves is
 * precisely not orphaned, so {@link pruneProject} refuses it by default and says where it found it.
 *
 * **A clone shares its first commit, so one project can have two checkouts.** AD-10 makes them one
 * project and the record holds one pointer, so the last registration wins and two concurrent checkouts
 * move the pointer back and forth. That is named rather than fixed: holding two paths would mean two
 * answers to "where is this project", which is the thing AD-10 forbids.
 *
 * **This module writes no memory.** `projects/<project-id>/` gains a registration record here; what
 * memory is kept in it is story 5-1's. Nor does it read a profile: per AD-9 the profile lives in
 * `<target-repo>/.orch/` and is never stored centrally, so resolution answers with a *repository path*
 * and not with configuration.
 */
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import type { Dirent } from 'node:fs';
import { join } from 'node:path';

import {
  CURRENT_SCHEMA_VERSION,
  ProjectRegistrationSchema,
  formatTimestamp,
  parseVersionedArtifact,
} from '../contracts/index.js';
import type { ProjectRegistration } from '../contracts/index.js';

import { fsyncDirectory } from './commands.js';
import { createFileExclusively } from './exclusive-create.js';
import {
  PROJECT_REGISTRATION_FILE_NAME,
  assertSafePathSegment,
  projectDir,
  projectRegistrationPath,
  projectsDir,
  resolveOrchHome,
} from './paths.js';
import { firstCommitSha, gitRoot } from './repository.js';

/** Where the record lives, for every function here to ask rather than join a segment of its own. */
interface RecordLocation {
  readonly orchHome: string;
  readonly projectId: string;
  readonly dir: string;
  readonly file: string;
}

const locate = (projectId: string, orchHome: string): RecordLocation => {
  // A project id reaches this module as data — read out of a profile, typed at a prune, or parsed from
  // a record — so it is validated as a path segment rather than trusted. This is also what refuses a
  // *path* passed where an id was wanted: `/Users/me/project` is not a path segment, and a person
  // standing in the wrong directory gets a named refusal instead of an operation on a neighbour.
  const safe = assertSafePathSegment(projectId, 'a project id');
  return {
    orchHome,
    projectId: safe,
    dir: projectDir(safe, orchHome),
    file: projectRegistrationPath(safe, orchHome),
  };
};

/** Options every operation here shares. */
export interface ProjectStoreOptions {
  /** Defaults to the AD-9 `ORCH_HOME`; injected so a test is not written against a real home. */
  readonly orchHome?: string;
}

/** Options for the operations that stamp a record, so a test does not race a clock. */
export interface TimedProjectStoreOptions extends ProjectStoreOptions {
  readonly now?: Date;
}

/**
 * A repository that cannot be registered because it has no AD-10 identity yet.
 *
 * The AD-35 code is `config.invalid`, whose declared disposition is `escalate-to-human`: no retry
 * turns a directory without a first commit into a project. Both messages name what is *needed* rather
 * than only what is wrong, because the person reading one is about to go and provide it.
 */
export class ProjectIdentityUnavailable extends Error {
  readonly code = 'config.invalid';
  readonly path: string;
  readonly reason: 'not-a-repository' | 'no-commits';

  constructor(path: string, reason: 'not-a-repository' | 'no-commits') {
    super(
      reason === 'not-a-repository'
        ? `${path} is not a git repository, so it has no project id. A project is identified by the ` +
            'SHA of its first commit (AD-10). Nothing has been registered.'
        : `${path} is a git repository with no commits, so it has no project id yet. A project is ` +
            'identified by the SHA of its first commit (AD-10), and a repository with no commits ' +
            'cannot be registered until it has one. Nothing has been registered.',
    );
    this.name = 'ProjectIdentityUnavailable';
    this.path = path;
    this.reason = reason;
  }
}

const serialise = (registration: ProjectRegistration): string =>
  `${JSON.stringify(ProjectRegistrationSchema.parse(registration), null, 2)}\n`;

/**
 * The record for a project id, or `null` when nothing is registered under it.
 *
 * Read through {@link parseVersionedArtifact} rather than through a bare `.parse()`, which is what
 * makes an unrecognised `schema_version` a named refusal carrying `config.schema_version_unrecognised`
 * and the artifact's own name (AD-28). Story 1-12's review found the one reader that skipped it, and
 * the symptom was a future installer's file reported as "malformed" instead of as a version this build
 * does not read, without the "re-run the installer" advice a person can act on.
 *
 * A record whose `project_id` is not the directory it was found in is refused for the reason
 * `src/runtime/fetch-record.ts` refuses a foreign fetch record: it belongs to another project, and
 * reading it here would answer one project's question with another's record.
 */
export const readProjectRegistration = (
  projectId: string,
  options: ProjectStoreOptions = {},
): ProjectRegistration | null => {
  const at = locate(projectId, options.orchHome ?? resolveOrchHome());
  if (!existsSync(at.file)) return null;
  const parsed = parseVersionedArtifact(
    ProjectRegistrationSchema,
    JSON.parse(readFileSync(at.file, 'utf8')) as unknown,
    `${PROJECT_REGISTRATION_FILE_NAME} for project ${at.projectId}`,
  );
  if (parsed.project_id !== at.projectId) {
    throw new ForeignProjectRegistration(at.file, at.projectId, parsed.project_id);
  }
  return parsed;
};

/** A record found under one project's directory that says it belongs to another. */
export class ForeignProjectRegistration extends Error {
  readonly code = 'config.invalid';
  readonly expectedProjectId: string;
  readonly foundProjectId: string;

  constructor(path: string, expectedProjectId: string, foundProjectId: string) {
    super(
      `Refusing ${path}: it records project "${foundProjectId}" but lies under "${expectedProjectId}". ` +
        'AD-10 keys a project by the SHA of its first commit; a record copied from another project ' +
        'is not this project\'s registration and is never read as if it were.',
    );
    this.name = 'ForeignProjectRegistration';
    this.expectedProjectId = expectedProjectId;
    this.foundProjectId = foundProjectId;
  }
}

/** Distinguishes one write's temporary from a concurrent process's, and one call's from the next. */
let tempCounter = 0;

/**
 * Publish a *replacement* record: temporary file in the same directory, fsync, rename, fsync the
 * directory.
 *
 * Not {@link createFileExclusively}, and the difference is the whole reason both exist. That publishes
 * by `link(2)`, which is an atomic test-and-set on the name — so it *decides* who creates a record and
 * cannot replace one. This is the update path, where the record already exists and the name must be
 * taken over; `rename` is the only publish that replaces atomically. A reader therefore sees the record
 * before or after this write and never during it, which matters because a resolver arrives unannounced.
 *
 * `fsyncDirectory` is imported rather than re-implemented, from the module that already owns the call:
 * the file's own `fsync` makes its *contents* survive a power loss, and only the directory's makes the
 * *name* survive one.
 */
const publishRecord = (at: RecordLocation, registration: ProjectRegistration): void => {
  mkdirSync(at.dir, { recursive: true });
  tempCounter += 1;
  const temp = `${at.file}.${String(process.pid)}.${String(tempCounter)}.tmp`;
  writeFileSync(temp, serialise(registration), 'utf8');
  const fd = openSync(temp, 'r');
  try {
    fsyncSync(fd);
  } catch {
    // Unsynced contents are a durability weakness, not a torn file: the rename is still atomic.
  }
  closeSync(fd);
  renameSync(temp, at.file);
  fsyncDirectory(at.dir);
};

/** What registering did to the record, which is all three things a caller can report. */
export const PROJECT_REGISTRATION_DISPOSITIONS = ['created', 'pointer_updated', 'refreshed'] as const;

export type ProjectRegistrationDisposition = (typeof PROJECT_REGISTRATION_DISPOSITIONS)[number];

export interface RegisteredProject {
  readonly projectId: string;
  /** The repository root the pointer now names, which is where resolution will look. */
  readonly path: string;
  readonly disposition: ProjectRegistrationDisposition;
  readonly registration: ProjectRegistration;
  /** The pointer this registration replaced, or `null` when the record is new. */
  readonly previousPath: string | null;
  /** R3 — one line that stands alone, for a caller reporting to a person. */
  readonly summary: string;
}

/**
 * How many times a creation may lose the race before this gives up.
 *
 * A loser re-reads the winner's record and continues as an update, so one extra attempt covers the
 * ordinary race. More than one is needed only for the absurd interleaving where the winner's record is
 * pruned between the failed create and the re-read, and a bound is needed at all because a caller
 * registering into an `ORCH_HOME` something else is concurrently deleting must fail rather than spin.
 */
const CLAIM_ATTEMPTS = 3;

/** The record as it stands after this process either created it or found the winner's. */
interface ClaimedRecord {
  readonly registration: ProjectRegistration;
  readonly created: boolean;
}

const claimRecord = (at: RecordLocation, fresh: ProjectRegistration): ClaimedRecord => {
  mkdirSync(at.dir, { recursive: true });
  for (let attempt = 0; attempt < CLAIM_ATTEMPTS; attempt += 1) {
    // The exclusive create publishes a fully written inode, so the record exists whole or not at all —
    // two registrations racing for one id leave exactly one record and never half of one.
    if (createFileExclusively(at.file, serialise(fresh))) {
      return { registration: fresh, created: true };
    }
    const found = readProjectRegistration(at.projectId, { orchHome: at.orchHome });
    if (found !== null) return { registration: found, created: false };
  }
  throw new Error(
    `Could not register project ${at.projectId}: ${at.file} was created by another process and ` +
      `removed again ${String(CLAIM_ATTEMPTS)} times while this registration was running. Something ` +
      'else is pruning this ORCH_HOME concurrently; nothing has been registered.',
  );
};

/**
 * Register the repository at `repositoryPath`, keyed by the SHA of its first commit.
 *
 * The id is *computed here*, never accepted from a caller: AD-10 makes it identity, and a caller's
 * idea of a project's id is exactly the thing that splits one project into two records. What a caller
 * may pass is `expectedProjectId`, which is checked against the repository and refused on disagreement
 * — the installer uses it so that `.orch/profile.toml` and the central record cannot say different
 * things about the same repository.
 *
 * Registering an already-registered id updates the pointer and touches nothing else, which is the same
 * property story 2-1 established for the installer and for the same reason: an upgrade is a re-run, and
 * a project that moved is the project that moved.
 */
export const registerProject = (
  repositoryPath: string,
  options: TimedProjectStoreOptions & { readonly expectedProjectId?: string } = {},
): RegisteredProject => {
  const orchHome = options.orchHome ?? resolveOrchHome();
  const stamp = formatTimestamp(options.now ?? new Date());

  let given = repositoryPath;
  try {
    given = realpathSync(repositoryPath);
  } catch {
    // An unresolvable path is reported by the refusal below, which names what it needed.
  }
  const root = gitRoot(given);
  if (root === null) throw new ProjectIdentityUnavailable(given, 'not-a-repository');
  /**
   * The repository *root* is the pointer, not the path the caller handed in.
   *
   * AD-9 puts `.orch/` at the repository root, so the root is the only path from which a resolved
   * project is usable; recording a subdirectory would make resolution answer with a directory that
   * carries no configuration. git's own answer is used rather than a guess about parent directories.
   */
  const projectId = firstCommitSha(root);
  if (projectId === null) throw new ProjectIdentityUnavailable(root, 'no-commits');
  if (options.expectedProjectId !== undefined && options.expectedProjectId !== projectId) {
    throw new ProjectIdentityMismatch(root, options.expectedProjectId, projectId);
  }

  const at = locate(projectId, orchHome);
  const existing = readProjectRegistration(projectId, { orchHome });

  if (existing === null) {
    const fresh: ProjectRegistration = {
      schema_version: CURRENT_SCHEMA_VERSION,
      project_id: projectId,
      path: root,
      location: 'located',
      unlocated_since: null,
      first_registered_at: stamp,
      last_registered_at: stamp,
    };
    const claimed = claimRecord(at, fresh);
    if (claimed.created) {
      return {
        projectId,
        path: root,
        disposition: 'created',
        registration: claimed.registration,
        previousPath: null,
        summary: `Registered project ${projectId} at ${root}.`,
      };
    }
    return updatePointer(at, claimed.registration, root, stamp);
  }

  return updatePointer(at, existing, root, stamp);
};

/**
 * Move the pointer, and change nothing else.
 *
 * `...existing` is load-bearing rather than tidy. AD-10 calls the path a mutable pointer and the id
 * identity, and a project that moved is the same project — so `first_registered_at`, and every field a
 * later story adds to this record, survives a move. Rebuilding the record from scratch here would
 * silently reset a project's history to the moment it was moved, which is the accumulated-memory loss
 * AD-33 is about, arriving through registration instead of through prune.
 */
const updatePointer = (
  at: RecordLocation,
  existing: ProjectRegistration,
  root: string,
  stamp: string,
): RegisteredProject => {
  const moved = existing.path !== root;
  const registration: ProjectRegistration = {
    ...existing,
    path: root,
    // A registration is a verified sighting: the caller's repository was just read at this path, so a
    // record marked `unlocated` by an earlier resolution is located again (AD-33 — a moved repository
    // reattaches to its existing history rather than becoming a second project).
    location: 'located',
    unlocated_since: null,
    last_registered_at: stamp,
  };
  publishRecord(at, registration);
  return {
    projectId: existing.project_id,
    path: root,
    disposition: moved ? 'pointer_updated' : 'refreshed',
    registration,
    previousPath: existing.path,
    summary: moved
      ? `Project ${existing.project_id} moved: the pointer now names ${root} ` +
        `(it named ${existing.path}). Its central record is unchanged.`
      : `Project ${existing.project_id} is already registered at ${root}; only its timestamp changed.`,
  };
};

/** A repository whose first commit is not the id the caller said it would be. */
export class ProjectIdentityMismatch extends Error {
  readonly code = 'config.invalid';
  readonly path: string;
  readonly expectedProjectId: string;
  readonly foundProjectId: string;

  constructor(path: string, expectedProjectId: string, foundProjectId: string) {
    super(
      `${path} has first commit ${foundProjectId}, not ${expectedProjectId}. AD-10 identifies a ` +
        'project by the SHA of its first commit, so registering it under another id would key its ' +
        'central record to a project this is not. Nothing has been registered.',
    );
    this.name = 'ProjectIdentityMismatch';
    this.path = path;
    this.expectedProjectId = expectedProjectId;
    this.foundProjectId = foundProjectId;
  }
}

/**
 * Why a recorded pointer is not live. Each is a distinct thing to tell a person, and the last is the
 * dangerous one: the path resolves perfectly well, to somebody else's repository.
 */
export const UNLOCATED_REASONS = [
  'path_absent',
  'not_a_repository',
  'no_first_commit',
  'different_repository',
] as const;

export type UnlocatedReason = (typeof UNLOCATED_REASONS)[number];

/** A located project: a verified repository root, and the record that pointed at it. */
export interface LocatedProject {
  readonly kind: 'located';
  readonly projectId: string;
  readonly path: string;
  readonly registration: ProjectRegistration;
}

/**
 * A registered project whose pointer is not live.
 *
 * **There is deliberately no path in this shape, and no record either.** The pointer is the one field a
 * caller must not be handed here: when the reason is `different_repository` it names another project's
 * checkout, and a caller that reached for it would run this project's central record against that
 * project's code — the failure resolution exists to prevent. The foreign repository is named by its
 * *id* instead, which says as much to a person and cannot be passed to `git -C`. A caller that wants
 * the record itself asks {@link readProjectRegistration} for it, having decided to.
 */
export interface UnlocatedProject {
  readonly kind: 'unlocated';
  readonly projectId: string;
  readonly reason: UnlocatedReason;
  /** The id of the repository now at the recorded path, when there is one. */
  readonly foundProjectId: string | null;
  readonly firstRegisteredAt: string;
  readonly unlocatedSince: string;
  readonly summary: string;
}

/** A project id nothing is registered under. Resolution creates nothing to say so. */
export interface UnregisteredProject {
  readonly kind: 'unregistered';
  readonly projectId: string;
  readonly summary: string;
}

export type ProjectResolution = LocatedProject | UnlocatedProject | UnregisteredProject;

/** What reading the recorded path found there. */
type VerifiedPointer =
  | { readonly ok: true; readonly path: string }
  | { readonly ok: false; readonly reason: UnlocatedReason; readonly foundProjectId: string | null };

/**
 * Verify a pointer by reading the identity at it, which is the only thing that makes it live.
 *
 * Existence is not verification. A directory that exists may hold a different repository — after a
 * move and a fresh clone into the old path, or after a `git init` in a directory that was reused — and
 * following that pointer is worse than failing to follow any, because the failure is silent: one
 * project's memory read against another project's code. So the first-commit SHA is read and compared,
 * and only equality resolves.
 */
const verifyPointer = (recordedPath: string, projectId: string): VerifiedPointer => {
  if (!existsSync(recordedPath)) return { ok: false, reason: 'path_absent', foundProjectId: null };
  const root = gitRoot(recordedPath);
  if (root === null) return { ok: false, reason: 'not_a_repository', foundProjectId: null };
  const found = firstCommitSha(root);
  if (found === null) return { ok: false, reason: 'no_first_commit', foundProjectId: null };
  if (found !== projectId) return { ok: false, reason: 'different_repository', foundProjectId: found };
  // The root rather than the recorded path: a pointer that now names a subdirectory of its own
  // repository still identifies this project, and the root is where `.orch/` is (AD-9).
  return { ok: true, path: root };
};

const unlocatedSummary = (
  projectId: string,
  reason: UnlocatedReason,
  foundProjectId: string | null,
): string => {
  const cause =
    reason === 'path_absent'
      ? 'the path it was last registered from no longer exists'
      : reason === 'not_a_repository'
        ? 'the path it was last registered from is no longer a git repository'
        : reason === 'no_first_commit'
          ? 'the repository at the path it was last registered from has no commits'
          : `the path it was last registered from now holds a different repository (project ${
              foundProjectId ?? 'unknown'
            })`;
  return (
    `Project ${projectId} is unlocated: ${cause}. Its central record is untouched — nothing has been ` +
    'deleted or reclaimed (AD-33). Register it again from wherever it now is and it reattaches to ' +
    'this same record; `orch prune` removes central state only when you name the project id.'
  );
};

/**
 * Resolve a project id to a repository, by verifying the recorded pointer.
 *
 * The one write this makes is the AD-33 mark, and only when the verdict *changes*: a pointer found dead
 * is recorded `unlocated` so a person listing projects can see it, and a pointer found live again
 * clears the mark, because the field records what the pointer is rather than a judgement to be
 * preserved. Nothing else happens on either transition — no cleanup, no reclamation, no deletion.
 */
export const resolveProject = (
  projectId: string,
  options: TimedProjectStoreOptions = {},
): ProjectResolution => {
  const orchHome = options.orchHome ?? resolveOrchHome();
  const at = locate(projectId, orchHome);
  const existing = readProjectRegistration(at.projectId, { orchHome });
  if (existing === null) {
    return {
      kind: 'unregistered',
      projectId: at.projectId,
      summary:
        `No project is registered under ${at.projectId}. Nothing has been created: an id is ` +
        'registered by installing into a repository, and a project id is the SHA of that ' +
        "repository's first commit (AD-10).",
    };
  }

  const verified = verifyPointer(existing.path, at.projectId);

  if (verified.ok) {
    const registration =
      existing.location === 'located'
        ? existing
        : mark(at, existing, { location: 'located', unlocated_since: null });
    return { kind: 'located', projectId: at.projectId, path: verified.path, registration };
  }

  const stamp = formatTimestamp(options.now ?? new Date());
  const marked =
    existing.location === 'unlocated' && existing.unlocated_since !== null
      ? existing
      : mark(at, existing, { location: 'unlocated', unlocated_since: stamp });
  return {
    kind: 'unlocated',
    projectId: at.projectId,
    reason: verified.reason,
    foundProjectId: verified.foundProjectId,
    firstRegisteredAt: marked.first_registered_at,
    // Non-null by construction: the mark above sets it whenever it was null.
    unlocatedSince: marked.unlocated_since ?? stamp,
    summary: unlocatedSummary(at.projectId, verified.reason, verified.foundProjectId),
  };
};

/**
 * Record the verdict of a verification, and nothing else.
 *
 * Two fields, spread over the record that was read: this is a *mark*, and the shape of the code says
 * so. AD-33 is the whole of it — the absence of a path is not abandonment, so what happens to a record
 * whose repository cannot be found is that two fields change.
 */
const mark = (
  at: RecordLocation,
  existing: ProjectRegistration,
  verdict: Pick<ProjectRegistration, 'location' | 'unlocated_since'>,
): ProjectRegistration => {
  const registration: ProjectRegistration = { ...existing, ...verdict };
  publishRecord(at, registration);
  return registration;
};

/** Every file under a directory, as paths relative to it, sorted — what a prune reports removing. */
const filesUnder = (root: string, prefix = ''): readonly string[] => {
  const found: string[] = [];
  // The encoding is pinned so `readdirSync` resolves to the string-named overload; without it TS picks
  // the Buffer one and `entry.name` comes back as bytes.
  let listing: Dirent<string>[];
  try {
    listing = readdirSync(root, { withFileTypes: true, encoding: 'utf8' });
  } catch {
    return found;
  }
  for (const entry of listing) {
    const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      found.push(...filesUnder(join(root, entry.name), relative));
      continue;
    }
    found.push(relative);
  }
  return found.sort((left, right) => left.localeCompare(right));
};

export interface PrunedProject {
  readonly kind: 'pruned';
  readonly projectId: string;
  /** Every file that was under `projects/<project-id>/`, so what was lost is reported and not guessed. */
  readonly removed: readonly string[];
  readonly summary: string;
}

/** Prune refused: the named project still resolves, so it is not orphaned state (AD-9). */
export interface PruneRefused {
  readonly kind: 'refused';
  readonly projectId: string;
  readonly locatedPath: string;
  readonly summary: string;
}

export interface PruneFoundNothing {
  readonly kind: 'unregistered';
  readonly projectId: string;
  readonly summary: string;
}

export type PruneOutcome = PrunedProject | PruneRefused | PruneFoundNothing;

export interface PruneOptions extends TimedProjectStoreOptions {
  /**
   * Delete the central state of a project that still resolves.
   *
   * Default `false`, and the default is the answer to the question AD-9 asked: prune exists for state
   * *orphaned* by a deleted project directory, and a project whose repository is sitting right there is
   * precisely not orphaned. Deleting a located project's accumulated memory is unrecoverable, so it is
   * never the outcome of a command a person could have meant differently — they say so explicitly.
   */
  readonly force?: boolean;
}

/**
 * Remove one project's central state, naming it by id.
 *
 * An id and never a path, so a person standing in the wrong directory cannot delete the wrong project:
 * there is no argument here that a working directory could supply. A path passed as an id is refused by
 * {@link assertSafePathSegment} before anything is read, because a path is not a path segment.
 */
export const pruneProject = (projectId: string, options: PruneOptions = {}): PruneOutcome => {
  const orchHome = options.orchHome ?? resolveOrchHome();
  const at = locate(projectId, orchHome);
  const resolution = resolveProject(at.projectId, options);

  if (resolution.kind === 'unregistered') {
    return {
      kind: 'unregistered',
      projectId: at.projectId,
      summary:
        `No project is registered under ${at.projectId}, so nothing was removed. ` +
        'Prune names the project id, which is the SHA of the repository\'s first commit (AD-10).',
    };
  }

  if (resolution.kind === 'located' && options.force !== true) {
    return {
      kind: 'refused',
      projectId: at.projectId,
      locatedPath: resolution.path,
      summary:
        `Refusing to prune project ${at.projectId}: it still resolves to ${resolution.path}. ` +
        'Prune removes central state orphaned by a deleted project directory (AD-9), and a project ' +
        'whose repository is right there is not orphaned — its accumulated memory would be lost and ' +
        'could not be rebuilt. Pass --force if you mean to delete it anyway. Nothing was removed.',
    };
  }

  const removed = filesUnder(at.dir);
  rmSync(at.dir, { recursive: true, force: true });
  // Only the directory's own fsync makes the *removal* of the name durable, exactly as it makes a
  // rename durable — a prune that came back after a power loss would be a deletion a person believed.
  fsyncDirectory(projectsDir(orchHome));
  return {
    kind: 'pruned',
    projectId: at.projectId,
    removed,
    summary:
      `Pruned project ${at.projectId}: removed ${String(removed.length)} ` +
      `${removed.length === 1 ? 'file' : 'files'} under ${at.dir}.`,
  };
};
