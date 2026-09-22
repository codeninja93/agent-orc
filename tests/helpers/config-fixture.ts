/**
 * Fixtures for the story 2-3 suites: a throwaway repository holding an `.orch/`, written through the
 * same schemas and the same serialiser the installer uses.
 *
 * **Written through `ProfileSchema` and `AgentDeclarationSchema`, not by hand.** A fixture that emitted
 * its own TOML would be a second author of the artifact, and the first thing to drift would be the thing
 * these suites are about — what the loader reads. {@link writeRawProfile} exists for the cases where the
 * *point* is an artifact no schema would produce: an unrecognised `schema_version`, a knowledge entry
 * with no anchor, an anchor naming a line.
 *
 * The suites never run `git` here: story 2-1's own suites cover what the installer does with a
 * repository, and `tests/engine.profile.test.ts` runs the real installer once so the loader is proven
 * against installer output rather than only against these fixtures.
 */
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  AGENTS_DIR_NAME,
  AgentDeclarationSchema,
  CURRENT_SCHEMA_VERSION,
  PROFILE_SCHEMA_VERSION,
  KnowledgeEntrySchema,
  ORCH_DIR_NAME,
  PERMISSIONS_FILE_NAME,
  PROFILE_FILE_NAME,
  PermissionsSchema,
  ProfileSchema,
  serialiseToml,
} from '../../src/contracts/index.js';
import type {
  AgentDeclaration,
  KnowledgeEntry,
  KnowledgeSection,
  Permissions,
  Profile,
  TomlTable,
} from '../../src/contracts/index.js';

/** A first-commit SHA shaped like one, so nothing reads as a placeholder (AD-10). */
export const FIXTURE_PROJECT_ID = '9f1c0c6a4c0f4f1e9b7d2a3c5e6f708192a3b4c5';

export const makeWorkspace = (label: string): string =>
  realpathSync(mkdtempSync(join(tmpdir(), `orch-${label}-`)));

/** The profile a fixture starts from: every AD-16 mechanic present, and no knowledge section. */
export const fixtureProfile = (overrides: Partial<Profile> = {}): Profile =>
  ProfileSchema.parse({
    // The profile's own version, which story 2-6 advanced past every other artifact's when
    // `mechanics.commands` gained `typecheck` (AD-28). A fixture spelling `CURRENT_SCHEMA_VERSION`
    // here would be refused by the schema it is built through, which is the point of the bump.
    schema_version: PROFILE_SCHEMA_VERSION,
    project: { id: FIXTURE_PROJECT_ID, path: '/nowhere', remote: '' },
    mechanics: {
      package_manager: 'npm',
      commands: {
        test: 'npm test',
        typecheck: 'npm run typecheck',
        lint: 'npm run lint',
        build: 'npm run build',
        run: 'npm start',
      },
      source_layout: ['src', 'tests'],
      resources: 'none',
    },
    risk: { high_blast_radius_paths: ['src/runtime'], conflict_domains: ['schema'] },
    roster: { builtin_agents: ['analysis'] },
    branch_pattern: 'feature/<feature-slug>',
    autonomy_start: 'live',
    ceilings: { steps: 20, wall_clock_minutes: 90, rate_limit_budget_percent: 50 },
    ...overrides,
  });

/**
 * One knowledge entry, through `KnowledgeEntrySchema` so a fixture cannot record an entry the schema
 * would refuse and then assert the loader applied it.
 */
export const knowledgeEntry = (overrides: Partial<KnowledgeEntry> = {}): KnowledgeEntry =>
  KnowledgeEntrySchema.parse({
    anchor: 'resolveProject',
    anchor_kind: 'api-symbol',
    claim: 'resolveProject verifies the pointer by reading the first-commit SHA at it.',
    provenance: 'bootstrap agent, from ORCH-run 01JQ',
    recorded_at: '2026-09-22T09:00:00.000Z',
    decay_policy: 'until-refactor',
    decay_features: 0,
    ...overrides,
  });

/** A knowledge section carrying the given entries. */
export const knowledgeSection = (entries: readonly KnowledgeEntry[]): KnowledgeSection => ({
  entries: [...entries],
});

const orchDir = (repository: string): string => join(repository, ORCH_DIR_NAME);

/** Write `.orch/profile.toml` for a profile the schema accepts. */
export const writeProfile = (repository: string, profile: Profile): string => {
  const dir = orchDir(repository);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, PROFILE_FILE_NAME);
  writeFileSync(path, serialiseToml(ProfileSchema.parse(profile)), 'utf8');
  return path;
};

/**
 * Write `.orch/profile.toml` from a raw table, bypassing the schema.
 *
 * For the artifacts whose whole point is that no schema would write them: matrix rows 3, 9 and 10 are
 * each a file a person or a future installer produced, and a fixture that could not express one would be
 * asserting the schema against itself.
 */
export const writeRawProfile = (repository: string, table: TomlTable): string => {
  const dir = orchDir(repository);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, PROFILE_FILE_NAME);
  writeFileSync(path, serialiseToml(table), 'utf8');
  return path;
};

/**
 * The permissions artifact, which AD-9's Rule names beside the profile and the roster.
 *
 * A fixture `.orch/` that held only two of the three could not see a snapshot that copied only two of the
 * three — which is exactly how the missing `permissions.toml` survived the first round.
 */
export const fixturePermissions = (overrides: Partial<Permissions> = {}): Permissions =>
  PermissionsSchema.parse({
    schema_version: CURRENT_SCHEMA_VERSION,
    granted_tools: ['Glob', 'Grep', 'Read'],
    gated_reversibility_classes: ['irreversible'],
    egress_allowlist: [],
    ...overrides,
  });

/** Write `.orch/permissions.toml`. */
export const writePermissions = (repository: string, permissions: Permissions): string => {
  const dir = orchDir(repository);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, PERMISSIONS_FILE_NAME);
  writeFileSync(path, serialiseToml(PermissionsSchema.parse(permissions)), 'utf8');
  return path;
};

/** The agent declaration a fixture starts from, with ADR-003's `analysis` grant. */
export const fixtureAgent = (overrides: Partial<AgentDeclaration> = {}): AgentDeclaration =>
  AgentDeclarationSchema.parse({
    schema_version: CURRENT_SCHEMA_VERSION,
    id: 'analysis',
    purpose: 'Read the repository and the request, and state what the work actually is.',
    contract: 'step.output',
    tools: ['Read', 'Grep', 'Glob'],
    mcp_domains: [],
    reversibility: 'reversible',
    model: { start_tier: 'claude-haiku-4-5', promotion_policy: 'on-gate-failure' },
    ...overrides,
  });

/** Write one `.orch/agents/<name>.toml`. The file name is a parameter, so row 14 is expressible. */
export const writeAgentFile = (
  repository: string,
  fileName: string,
  declaration: TomlTable,
): string => {
  const dir = join(orchDir(repository), AGENTS_DIR_NAME);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, fileName);
  writeFileSync(path, serialiseToml(declaration), 'utf8');
  return path;
};

/** Create `.orch/agents/` and leave it empty — matrix row 15's first half. */
export const makeEmptyAgentsDir = (repository: string): string => {
  const dir = join(orchDir(repository), AGENTS_DIR_NAME);
  mkdirSync(dir, { recursive: true });
  return dir;
};

/** Write a `CLAUDE.md` or an `AGENTS.md` at the repository root, verbatim. */
export const writeInstructionFile = (
  repository: string,
  name: string,
  text: string,
): string => {
  const path = join(repository, name);
  mkdirSync(repository, { recursive: true });
  writeFileSync(path, text, 'utf8');
  return path;
};
