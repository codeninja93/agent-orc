/**
 * AD-16 — loading `<target-repo>/.orch/profile.toml`, and applying the precedence AD-16 fixes.
 *
 * **Two questions, only one of which can conflict.** The profile is authoritative for mechanics: the
 * four commands, the package manager, the source layout, resource needs, risk tiers and conflict
 * domains all come from here and from nowhere else, because prose does not declare a test command in a
 * form anything can read. The repository's own instructions are authoritative for conventions, and
 * `src/engine/conventions.ts` passes their text through without parsing it. So the two authorities do
 * not overlap, and there is nothing to arbitrate between them.
 *
 * **Where they can meet is a knowledge entry, and that is decided by anchors.** AD-16 requires a
 * contradicted profile entry to be *flagged stale rather than silently applied*. A loader cannot judge
 * semantic contradiction, so the judgement is structural: an entry declares the anchor it speaks to
 * (`src/contracts/knowledge.ts` refuses one that does not), and it is flagged when the repository's
 * instructions speak to that same anchor. Additive only, per AD-16: a flagged entry is *reported*, and
 * nothing here rewrites the profile or the instructions.
 *
 * **Nothing is defaulted.** A repository with no `.orch/` is refused naming what creates one (matrix
 * row 2), because a default profile would be the engine guessing a test command — and a guessed
 * verification gate that passes is worse than no gate. An unrecognised `schema_version` is refused
 * through {@link parseVersionedArtifact}, which is how every versioned artifact in this codebase is
 * read (AD-28).
 *
 * **A step never reaches `.orch/`.** AD-9 gives a run an immutable snapshot at `runs/<run-id>/config/`
 * and makes it the only configuration a step reads. This module is therefore written against a
 * {@link ConfigurationSource} rather than against a repository path: `src/engine/config-snapshot.ts`
 * builds one for each scope, the loader cannot tell which it was handed, and a mid-run edit to `.orch/`
 * reaches nothing that is running.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  AGENTS_DIR_NAME,
  ORCH_DIR_NAME,
  PERMISSIONS_FILE_NAME,
  PROFILE_FILE_NAME,
  PermissionsSchema,
  ProfileSchema,
  parseToml,
  parseVersionedArtifact,
} from '../contracts/index.js';
import type { KnowledgeEntry, Permissions, Profile, TomlTable } from '../contracts/index.js';

import { conventionsSpeakingTo, readConventions } from './conventions.js';
import type { RepositoryConventions } from './conventions.js';

/**
 * The two configuration scopes AD-34 declares and this module reads: project scope is
 * `<target-repo>/.orch/`, run scope is the immutable snapshot at `runs/<run-id>/config/`.
 *
 * Machine scope (`ORCH_HOME/config.toml`) and cross-project memory are the other two AD-34 names and
 * are not configuration a profile loader reads — AD-34 forbids merging between scopes, so they are
 * absent here rather than folded in.
 */
export const CONFIGURATION_SCOPES = ['project', 'run'] as const;

export type ConfigurationScope = (typeof CONFIGURATION_SCOPES)[number];

/**
 * Where one set of configuration artifacts lives.
 *
 * Deliberately three paths and a label rather than a root directory to derive them from: the run
 * snapshot keeps the instruction files under `config/conventions/` while a repository keeps them at its
 * root, and a reader that computed `conventionsDir` from a root would have to know which scope it was
 * in — which is the knowledge AD-9 exists to keep out of a step.
 */
export interface ConfigurationSource {
  readonly scope: ConfigurationScope;
  /** How the source is named in a refusal, e.g. `<repo>/.orch` or `runs/<run-id>/config`. */
  readonly label: string;
  readonly profile: string;
  readonly agentsDir: string;
  /**
   * `permissions.toml` in this scope — the third artifact AD-9's Rule names.
   *
   * Carried on the source, with no reader in this story, because AD-9 makes the snapshot "the only
   * configuration any step of that run reads": the artifact has to have a run-scope path before anything
   * reads it, or the first reader will reach for `.orch/` because that is where the path was.
   */
  readonly permissions: string;
  /** Where `CLAUDE.md`/`AGENTS.md` are read from for this scope. */
  readonly conventionsDir: string;
}

/**
 * Project scope: `<target-repo>/.orch/`, with the instruction files at the repository root.
 *
 * The one legitimate caller is run start, which takes the AD-9 snapshot from it. A step given this
 * would be reading configuration a feature branch can edit while it runs, which is the defect the
 * snapshot exists to prevent.
 */
export const projectConfiguration = (repositoryPath: string): ConfigurationSource => {
  const orchDir = join(repositoryPath, ORCH_DIR_NAME);
  return {
    scope: 'project',
    label: orchDir,
    profile: join(orchDir, PROFILE_FILE_NAME),
    agentsDir: join(orchDir, AGENTS_DIR_NAME),
    permissions: join(orchDir, PERMISSIONS_FILE_NAME),
    conventionsDir: repositoryPath,
  };
};

/**
 * There is no profile where one was looked for.
 *
 * The AD-35 code is `config.invalid`, whose declared disposition is `escalate-to-human`: no retry turns
 * an un-onboarded repository into an onboarded one. The message names *what to run*, because the person
 * reading it is about to go and run it — and the run-scope wording names run start rather than the
 * installer, since a step meeting this has found a run that never took its snapshot, not a repository
 * that was never installed.
 */
export class ProfileNotFound extends Error {
  readonly code = 'config.invalid';
  readonly scope: ConfigurationScope;
  readonly path: string;

  constructor(source: ConfigurationSource) {
    super(
      source.scope === 'project'
        ? `No profile at ${source.profile}, so this repository has not been onboarded. Run ` +
            '`orch init` from inside it, or `orch init` with its path as the one argument, which ' +
            'writes .orch/profile.toml, .orch/agents/ and .orch/permissions.toml (AD-12 delivers that ' +
            'same installer by npx from the orchestrator\'s own git repository). Nothing is defaulted: ' +
            'the profile is authoritative for the test, lint, build and run commands (AD-16), and an ' +
            'invented one would be a verification gate nobody declared.'
        : `No profile at ${source.profile}: this run has no configuration snapshot. AD-9 takes the ` +
            'snapshot once at run start and makes it the only configuration a step reads, so a step ' +
            'that finds none is not permitted to fall back to <target-repo>/.orch/ — that directory ' +
            'can have been edited since this run began.',
    );
    this.name = 'ProfileNotFound';
    this.scope = source.scope;
    this.path = source.profile;
  }
}

/**
 * Read and parse the profile, refusing rather than defaulting.
 *
 * `parseVersionedArtifact` rather than `ProfileSchema.parse`, for the reason story 1-12's review gave
 * when it found the one reader that skipped it: an artifact a future installer wrote is refused as
 * `config.schema_version_unrecognised` naming that installer, not reported as malformed (AD-28). A TOML
 * that does not parse raises `TomlParseError`, which already carries `config.invalid` and the line — a
 * hand-edited profile is the only way that happens, and the line is what a person needs.
 */
export const loadProfile = (source: ConfigurationSource): Profile => {
  if (!existsSync(source.profile)) throw new ProfileNotFound(source);
  // The read and the parse sit between the existence check and the schema, and both can fail in ways
  // that are nobody's schema problem: a `profile.toml` that is a directory, one whose permissions changed
  // since the check, a hand edit the subset refuses. Each was reaching a caller as a raw `fs` or parse
  // error with no `code` for the AD-35 table to route on — so each is rethrown carrying one and the path.
  let table: TomlTable;
  try {
    table = parseToml(readFileSync(source.profile, 'utf8'));
  } catch (error) {
    throw new ProfileUnreadable(source.profile, error);
  }
  return parseVersionedArtifact(ProfileSchema, table, source.profile);
};

/**
 * Story 4-1 — read and parse `permissions.toml`, the first reader this artifact ever gets.
 *
 * **`null` for "no file", never a default gate table.** `PermissionsSchema` has carried
 * `gated_reversibility_classes` since AD-12 (`src/contracts/installer.ts`), and every install this
 * codebase's own installer has ever produced writes one (`renderPermissions`,
 * `src/installer/write.ts`) — but `{@link copiesFor}` in `src/engine/config-snapshot.ts` has always
 * copied it *conditionally*, `if (existsSync(projectScope.permissions))`, because AD-9's Rule only
 * started naming it a third artifact after the profile and the roster already existed without it. A
 * repository onboarded before that file existed, or a hand-assembled `.orch/` a test builds without
 * it, has a snapshot with no `permissions.toml` at all. Answering that with the installer's own
 * `GATED_REVERSIBILITY_CLASSES` default would be a hardcoded constant duplicated in the engine — the
 * one thing this story's own Boundaries forbid — so the honest answer is "this project declares no
 * gate", which is what the caller reads a `null` as.
 *
 * Present but unreadable is a different case, exactly as {@link loadProfile} draws it for the profile:
 * a directory where the file belongs, a permission bit, a hand edit the TOML subset refuses. Each
 * reaches the caller with an AD-35 code rather than as a raw `fs` or parse error.
 */
export const loadPermissions = (source: ConfigurationSource): Permissions | null => {
  if (!existsSync(source.permissions)) return null;
  let table: TomlTable;
  try {
    table = parseToml(readFileSync(source.permissions, 'utf8'));
  } catch (error) {
    throw new ProfileUnreadable(source.permissions, error);
  }
  return parseVersionedArtifact(PermissionsSchema, table, source.permissions);
};

/**
 * A profile that is there and cannot be read, or whose bytes are not this TOML subset.
 *
 * The AD-35 code is `config.invalid` → `escalate-to-human`: a directory where a file belongs, a
 * permission bit, or a hand edit the parser refuses are all things a person fixes and no retry does. The
 * `cause` is kept because `TomlParseError` carries the line number, which is the whole of what a person
 * needs to repair a hand edit.
 */
export class ProfileUnreadable extends Error {
  readonly code = 'config.invalid';
  readonly path: string;

  constructor(path: string, cause: unknown) {
    super(
      `Cannot read the profile at ${path}: ${cause instanceof Error ? cause.message : String(cause)}. ` +
        'The profile is authoritative for mechanics (AD-16), so nothing is defaulted in its place.',
      { cause },
    );
    this.name = 'ProfileUnreadable';
    this.path = path;
  }
}

/**
 * A knowledge entry the repository's instructions overrode.
 *
 * It carries the entry itself rather than only a message, because AD-16 makes the section additive: the
 * entry is not deleted, not rewritten and not applied — it is reported, and story 5-2's sweep is what
 * eventually retires it. The anchor and the file are both named, because a flag naming neither is a
 * claim a person cannot check.
 */
export interface StaleKnowledgeEntry {
  readonly entry: KnowledgeEntry;
  readonly anchor: string;
  /** The instruction files speaking to this anchor, in the fixed order `conventions.ts` reports. */
  readonly overriddenBy: readonly string[];
  readonly summary: string;
}

/** What the precedence pass decided about the profile's knowledge section. */
export interface ResolvedKnowledge {
  /** Entries no instruction file speaks to. Carried with their provenance and decay policy intact. */
  readonly applied: readonly KnowledgeEntry[];
  /** Entries the repository overrode, flagged rather than applied (AD-16). */
  readonly stale: readonly StaleKnowledgeEntry[];
}

/**
 * The configuration a run or a step actually works from.
 *
 * `mechanics` is the profile's own, copied by reference and never merged with anything: AD-16 makes the
 * profile authoritative for it, and there is no code path here by which an instruction file could
 * change a command. That is the reason this shape has one field for mechanics and two for knowledge —
 * only knowledge has a precedence question to answer.
 */
export interface ResolvedProfile {
  readonly source: ConfigurationSource;
  readonly profile: Profile;
  /** AD-16 mechanics: the four commands, the package manager, the layout and the resource need. */
  readonly mechanics: Profile['mechanics'];
  /** AD-16 risk: high-blast-radius paths and the conflict domains that bound concurrency. */
  readonly risk: Profile['risk'];
  readonly conventions: RepositoryConventions;
  readonly knowledge: ResolvedKnowledge;
  readonly summary: string;
}

const staleSummary = (entry: KnowledgeEntry, overriddenBy: readonly string[]): string =>
  `Profile knowledge anchored on "${entry.anchor}" is stale: ${overriddenBy.join(' and ')} ` +
  `speaks to that same anchor, and where both speak to one point the repository wins (AD-16). The ` +
  `entry is flagged rather than applied and is not removed; it was recorded by ${entry.provenance} ` +
  `at ${entry.recorded_at} with decay policy ${entry.decay_policy}.`;

/**
 * Apply AD-16's precedence to the profile's knowledge section.
 *
 * The verdict is per entry and per anchor, and it is the *only* thing the repository's instructions
 * decide here. Nothing reads the claim's text, nothing compares two sentences, and nothing asks whether
 * the repository actually disagrees — an instruction file that merely *mentions* the anchor is enough,
 * and deliberately so: AD-16's requirement is that a contradicted entry never be silently applied, and
 * the only safe direction for a mechanical test to err in is flagging an entry the repository was not
 * in fact contradicting.
 */
export const resolveKnowledge = (
  profile: Profile,
  conventions: RepositoryConventions,
): ResolvedKnowledge => {
  const applied: KnowledgeEntry[] = [];
  const stale: StaleKnowledgeEntry[] = [];
  for (const entry of profile.knowledge?.entries ?? []) {
    const speaking = conventionsSpeakingTo(conventions, entry.anchor);
    if (speaking.length === 0) {
      applied.push(entry);
      continue;
    }
    const overriddenBy = speaking.map((file) => file.name);
    stale.push({
      entry,
      anchor: entry.anchor,
      overriddenBy,
      summary: staleSummary(entry, overriddenBy),
    });
  }
  return { applied, stale };
};

const count = (value: number, singular: string, plural = `${singular}s`): string =>
  `${String(value)} ${value === 1 ? singular : plural}`;

/**
 * Load the profile, read the conventions, and apply AD-16's precedence — the whole of the loader's job.
 *
 * One function rather than three calls at each call site, because the precedence rule is not optional:
 * a caller that loaded the profile and forgot the conventions would apply a contradicted entry, which is
 * the one outcome AD-16 names.
 */
export const resolveProfile = (source: ConfigurationSource): ResolvedProfile => {
  const profile = loadProfile(source);
  const conventions = readConventions(source.conventionsDir);
  const knowledge = resolveKnowledge(profile, conventions);
  return {
    source,
    profile,
    mechanics: profile.mechanics,
    risk: profile.risk,
    conventions,
    knowledge,
    summary:
      `Profile for project ${profile.project.id} loaded from ${source.profile} (${source.scope} ` +
      `scope): test command "${profile.mechanics.commands.test}", ` +
      `${conventions.files.length === 0 ? 'no instruction file' : conventions.files.map((file) => file.name).join(' and ')}` +
      `, ${count(knowledge.applied.length, 'knowledge entry', 'knowledge entries')} applied and ` +
      `${String(knowledge.stale.length)} flagged stale.`,
  };
};
