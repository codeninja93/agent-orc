/**
 * Reading what a previous run already settled, so a re-run asks only what is missing.
 *
 * **This is the one place the installer reads its own past output as authority rather than as a
 * default.** AD-12 makes an upgrade a re-run, so `.orch/` is read *before* anything is asked and an
 * answer found there is never put to a person again. Everything else the installer knows — a
 * lockfile, a git remote, a `package.json` script — is a suggestion a person can override.
 *
 * **An answer is missing per answer, not per file.** `profile.toml` carries ten of the thirteen, so
 * reading it all-or-nothing would turn "one answer was removed" into ten questions. Each answer is
 * therefore extracted through its own small schema, and one that is absent or no longer reads as
 * what it was is simply missing — matrix row 3. The *file's* own strict schema is applied when it is
 * written, which is where a shape that would not parse must be caught.
 *
 * **The `schema_version` is not one of those lenient reads (AD-28).** A version this build does not
 * recognise is refused by name, before any answer is taken from the file and therefore before
 * anything is written. Never read as if current is the whole of the rule.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { z } from 'zod';

import {
  AGENTS_DIR_NAME,
  CeilingsSchema,
  ExternalDomainSchema,
  MANIFEST_FILE_NAME,
  MODEL_RUNGS,
  MechanicsCommandsSchema,
  ManifestSchema,
  ORCH_DIR_NAME,
  PACKAGE_MANAGERS,
  PERMISSIONS_FILE_NAME,
  PROFILE_FILE_NAME,
  RESOURCE_NEEDS,
  REVERSIBILITY_CLASSES,
  RUN_MODES,
  DEFAULT_SCHEMA_VERSION_POLICY,
  PROFILE_SCHEMA_VERSION_POLICY,
  assertRecognisedSchemaVersion,
  parseVersionedArtifact,
} from '../contracts/index.js';
import type { Manifest, SchemaVersionPolicy } from '../contracts/index.js';

import { BUILT_IN_AGENT_IDS } from './interview.js';
import type { AgentDeclarationInput, PartialAnswers } from './interview.js';
import { TomlParseError, parseToml } from './toml.js';
import type { TomlTable } from './toml.js';

/** Every path the installer touches in a target repository, derived from its root exactly once. */
export interface OrchPaths {
  readonly repository: string;
  readonly orchDir: string;
  readonly profile: string;
  readonly permissions: string;
  readonly manifest: string;
  readonly agentsDir: string;
  readonly gitignore: string;
}

export const orchPaths = (repository: string): OrchPaths => {
  const orchDir = join(repository, ORCH_DIR_NAME);
  return {
    repository,
    orchDir,
    profile: join(orchDir, PROFILE_FILE_NAME),
    permissions: join(orchDir, PERMISSIONS_FILE_NAME),
    manifest: join(orchDir, MANIFEST_FILE_NAME),
    agentsDir: join(orchDir, AGENTS_DIR_NAME),
    gitignore: join(repository, '.gitignore'),
  };
};

/** The repository-relative path a manifest entry names, with `/` on every platform. */
export const relativeOrchPath = (...segments: readonly string[]): string =>
  [ORCH_DIR_NAME, ...segments].join('/');

/**
 * Read and parse a TOML file, or `null` when it is not there — or when it does not parse.
 *
 * An unparseable artifact reads as *no answers*, not as a fatal error, and that is AD-12's doing: a
 * run killed between the write and the rename of its temporary leaves exactly this, and an installer
 * that threw here would have made the half-install it is supposed to recover from unrecoverable.
 * The file is not silently accepted either — it is a digest mismatch against the manifest, so the
 * outcome reports it as recovered, and any answer that lived only in it is asked for again.
 */
const readTomlFile = (path: string): TomlTable | null => {
  if (!existsSync(path)) return null;
  try {
    return parseToml(readFileSync(path, 'utf8'));
  } catch (error) {
    if (error instanceof TomlParseError) return null;
    throw error;
  }
};

/**
 * Assert AD-28 before reading anything else out of the file, and name the file in the refusal.
 *
 * A file with no `schema_version` at all is not refused here: it is not this build's artifact, and
 * every answer read from it goes through its own schema anyway. What must never happen is reading a
 * *declared* version this build does not know as though it were current.
 *
 * **The policy is per artifact, and the caller passes the one that belongs to the file it read.**
 * Since story 2-6 the profile's version is ahead of the others, because `mechanics.commands` gained
 * `typecheck` and AD-28 makes that a version change for the artifact whose shape changed and for no
 * other. A single policy here would either refuse every v1 permissions file or accept a v1 profile
 * whose typecheck gate nobody declared — and the second is the silent one.
 */
const assertReadableVersion = (
  table: TomlTable,
  artifact: string,
  policy: SchemaVersionPolicy = DEFAULT_SCHEMA_VERSION_POLICY,
): void => {
  const declared = table['schema_version'];
  if (typeof declared === 'number') assertRecognisedSchemaVersion(declared, artifact, policy);
};

/** Take one answer, or `undefined` when the file does not carry it in a shape this build reads. */
const pick = <Schema extends z.ZodType>(schema: Schema, value: unknown): z.output<Schema> | undefined => {
  const parsed = schema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
};

const ProjectAnswerSchema = z.object({
  id: z.string().regex(/^[0-9a-f]{40}$/),
  path: z.string(),
  remote: z.string(),
});

const MechanicsAnswerSchema = z.object({
  package_manager: z.enum(PACKAGE_MANAGERS),
  commands: MechanicsCommandsSchema,
  source_layout: z.array(z.string()),
  resources: z.enum(RESOURCE_NEEDS),
});

const RiskAnswerSchema = z.object({
  high_blast_radius_paths: z.array(z.string()),
  conflict_domains: z.array(z.string()),
});

const AgentFileSchema = z.object({
  id: z.string(),
  purpose: z.string(),
  contract: z.string(),
  tools: z.array(z.string()),
  mcp_domains: z.array(z.string()),
  reversibility: z.enum(REVERSIBILITY_CLASSES),
  model: z.object({
    start_tier: z.enum(MODEL_RUNGS),
    promotion_policy: z.enum(['on-gate-failure', 'never']),
  }),
});

/** What the profile already answers. Ten of the thirteen, each taken on its own terms. */
const answersFromProfile = (table: TomlTable): PartialAnswers => {
  const project = pick(ProjectAnswerSchema, table['project']);
  const mechanics = pick(MechanicsAnswerSchema, table['mechanics']);
  const risk = pick(RiskAnswerSchema, table['risk']);
  const roster = pick(z.object({ builtin_agents: z.array(z.string()) }), table['roster']);
  const branch = pick(z.string(), table['branch_pattern']);
  const autonomy = pick(z.enum(RUN_MODES), table['autonomy_start']);
  const ceilings = pick(CeilingsSchema, table['ceilings']);

  return {
    ...(project === undefined
      ? {}
      : {
          target_path: project.path,
          project: { id: project.id, remote: project.remote },
        }),
    ...(mechanics === undefined
      ? {}
      : {
          mechanics: { package_manager: mechanics.package_manager, commands: mechanics.commands },
          source_layout: mechanics.source_layout,
          resources: mechanics.resources,
        }),
    ...(risk === undefined
      ? {}
      : {
          high_blast_radius_paths: risk.high_blast_radius_paths,
          conflict_domains: risk.conflict_domains,
        }),
    ...(roster === undefined ? {} : { builtin_agents: roster.builtin_agents }),
    ...(branch === undefined ? {} : { branch_pattern: branch }),
    ...(autonomy === undefined ? {} : { autonomy_start: autonomy }),
    ...(ceilings === undefined ? {} : { ceilings }),
  };
};

/**
 * The custom agents already on disk — question 11's answer, and only that one.
 *
 * The *directory's* existence is what answers the question, not the number of files in it: a person
 * who declared no custom agents has answered, and an empty directory is how that answer survives a
 * re-run. Question 10's answer is the profile's roster, not this listing, because a built-in's file
 * is derived from it — see the `roster` docblock in `src/contracts/installer.ts`.
 */
const answersFromAgents = (agentsDir: string): PartialAnswers => {
  if (!existsSync(agentsDir)) return {};
  const custom: AgentDeclarationInput[] = [];
  for (const name of readdirSync(agentsDir).sort()) {
    if (!name.endsWith('.toml')) continue;
    const table = readTomlFile(join(agentsDir, name));
    if (table === null) continue;
    assertReadableVersion(table, relativeOrchPath(AGENTS_DIR_NAME, name));
    const declaration = pick(AgentFileSchema, table);
    if (declaration === undefined) continue;
    // A built-in's file is derived from the profile's roster answer, so reading it back would be
    // reading the artifact rather than the answer; only a custom declaration is authority here.
    if (BUILT_IN_AGENT_IDS.includes(declaration.id)) continue;
    custom.push(declaration);
  }
  return { custom_agents: custom };
};

const answersFromPermissions = (table: TomlTable): PartialAnswers => {
  const allowlist = pick(z.array(ExternalDomainSchema), table['egress_allowlist']);
  return allowlist === undefined ? {} : { external_domains: allowlist };
};

/** What a previous install left behind: its answers and its manifest. */
export interface ExistingInstall {
  readonly answers: PartialAnswers;
  /** The manifest of the previous run, or `null` when there is none to recover from. */
  readonly manifest: Manifest | null;
}

/**
 * Read `.orch/` as authority.
 *
 * The manifest is read strictly, through {@link parseVersionedArtifact}: it is the record AD-12 makes
 * a half-install detectable from, so a manifest that does not parse is refused rather than quietly
 * treated as "nothing was installed" — which would report every existing file as newly created.
 */
export const readExistingInstall = (repository: string): ExistingInstall => {
  const paths = orchPaths(repository);
  let answers: PartialAnswers = {};

  const profile = readTomlFile(paths.profile);
  if (profile !== null) {
    assertReadableVersion(
      profile,
      relativeOrchPath(PROFILE_FILE_NAME),
      PROFILE_SCHEMA_VERSION_POLICY,
    );
    answers = { ...answers, ...answersFromProfile(profile) };
  }

  const permissions = readTomlFile(paths.permissions);
  if (permissions !== null) {
    assertReadableVersion(permissions, relativeOrchPath(PERMISSIONS_FILE_NAME));
    answers = { ...answers, ...answersFromPermissions(permissions) };
  }

  answers = { ...answers, ...answersFromAgents(paths.agentsDir) };

  const manifestTable = readTomlFile(paths.manifest);
  const manifest =
    manifestTable === null
      ? null
      : parseVersionedArtifact(ManifestSchema, manifestTable, relativeOrchPath(MANIFEST_FILE_NAME));

  return { answers, manifest };
};
