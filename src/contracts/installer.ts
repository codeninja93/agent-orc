/**
 * AD-9, AD-12, AD-17, AD-28 — the four artifacts the installer writes into `<target-repo>/.orch/`.
 *
 * They are contracts rather than shapes inside `src/installer/` because three units read what one
 * unit writes: the installer authors them, the engine's profile loader and roster discovery read
 * them, and both renderers report from them. AD-2 puts every schema in code exactly once, and AD-28
 * makes every one of them carry a `schema_version` — which is what {@link versioned} attaches, along
 * with the refusal that a version this build does not recognise is never read as if it were current.
 *
 * **The interview's wording is free; these shapes are not.** `build-sequencing.md` fixes thirteen
 * questions and says outright that their wording may change while AD-9, AD-12, AD-17 and AD-28 fix
 * what they must produce. So this file is where the story's contract actually lives, and the tests
 * that matter assert against these schemas and the bytes they serialise to, never against a prompt.
 *
 * **Nothing here admits a credential value.** AD-12: the installer bundles no credential. Question 9
 * collects the *names* of environment variables holding one, and {@link EnvVarNameSchema} is the shape
 * that admits a name and rejects the thing itself. The heuristic half of that refusal — "this looks
 * like a secret rather than like a name" — lives in `src/installer/interview.ts`, because the single
 * authority on what looks like a credential is the AD-21 redaction pass in `src/runtime/`, and
 * `src/contracts/` is the root of the dependency graph and may import from no other `src/` directory.
 */
import { z } from 'zod';

import { versioned } from './schema-version.js';
import { MODEL_RUNGS } from './state.js';
import { REVERSIBILITY_CLASSES, RUN_MODES } from './step.js';

/** The one directory the installer writes inside a target repository, per AD-9. */
export const ORCH_DIR_NAME = '.orch';

/** The agent roster's directory, read by the engine and by nothing else (AD-17). */
export const AGENTS_DIR_NAME = 'agents';

export const PROFILE_FILE_NAME = 'profile.toml';
export const PERMISSIONS_FILE_NAME = 'permissions.toml';
export const MANIFEST_FILE_NAME = 'manifest.toml';

/**
 * The shape of an environment variable name, and the length past which a candidate stops looking
 * like one.
 *
 * POSIX allows a leading underscore and lower case; this does not. The narrower shape is the point:
 * the field exists to hold the *name* of a variable holding a credential, and every convention for
 * such a name is upper snake case. A candidate outside this shape is far more likely to be the
 * credential itself, which is the one thing AD-12 forbids reaching `.orch/`.
 */
export const ENV_VAR_NAME_PATTERN = /^[A-Z][A-Z0-9_]*$/;

/** Longer than any environment variable name in use, and shorter than most tokens. */
export const MAX_ENV_VAR_NAME_LENGTH = 64;

export const EnvVarNameSchema = z
  .string()
  .max(MAX_ENV_VAR_NAME_LENGTH)
  .regex(ENV_VAR_NAME_PATTERN);

/**
 * The package managers the installer detects and the profile declares (AD-16 mechanics).
 *
 * `other` is a real answer, not a placeholder: the four commands beside it are free text, so a
 * repository whose builds run through `make`, `cargo` or `uv` records what it actually runs instead
 * of being refused for not being a Node project.
 */
export const PACKAGE_MANAGERS = ['npm', 'pnpm', 'yarn', 'bun', 'other'] as const;

export type PackageManager = (typeof PACKAGE_MANAGERS)[number];

/** Question 5's four answers. The pool leases what this declares (AD-9). */
export const RESOURCE_NEEDS = ['none', 'postgres', 'redis', 'both'] as const;

export type ResourceNeed = (typeof RESOURCE_NEEDS)[number];

/**
 * The four commands AD-16 makes the profile authoritative for.
 *
 * A total record rather than an optional bag: a repository with no lint command records the empty
 * string for it, so a reader distinguishes "there is none" from "nobody was asked".
 */
export const MechanicsCommandsSchema = z.object({
  test: z.string(),
  lint: z.string(),
  build: z.string(),
  run: z.string(),
});

export type MechanicsCommands = z.infer<typeof MechanicsCommandsSchema>;

/** The four command names, in the order `build-sequencing.md` question 3 states them. */
export const MECHANICS_COMMAND_NAMES = ['test', 'lint', 'build', 'run'] as const;

export type MechanicsCommandName = (typeof MECHANICS_COMMAND_NAMES)[number];

/**
 * AD-24 — three ceilings and no currency dimension, which R10 restates as "cost is subscription
 * usage, never currency". So the third ceiling is a share of the rate-limit window in percent, and
 * there is deliberately no dollar field for a user to put a number in.
 */
export const CeilingsSchema = z.object({
  steps: z.int(),
  wall_clock_minutes: z.int(),
  rate_limit_budget_percent: z.int(),
});

export type Ceilings = z.infer<typeof CeilingsSchema>;

/**
 * One external domain and the *names* of the variables holding its credentials (AD-13, AD-12).
 *
 * `credential_env` is a list of names and can be empty: a domain reachable without a credential is a
 * real answer, and an empty list says so rather than leaving the field out.
 */
export const ExternalDomainSchema = z.object({
  domain: z.string(),
  credential_env: z.array(EnvVarNameSchema),
});

export type ExternalDomain = z.infer<typeof ExternalDomainSchema>;

/**
 * AD-17 — a `model` field declaring a starting tier and a promotion policy, never a fixed assignment.
 */
export const AgentModelSchema = z.object({
  start_tier: z.enum(MODEL_RUNGS),
  promotion_policy: z.enum(['on-gate-failure', 'never']),
});

export type AgentModel = z.infer<typeof AgentModelSchema>;

/**
 * One `<target-repo>/.orch/agents/<agent-id>.toml`, per AD-17.
 *
 * `contract` is a plain string here and a *registered* contract id at the boundary that writes it:
 * `src/installer/write.ts` resolves it through `getContract`, whose refusal names every registered
 * id. Checking it in the schema would make `src/contracts/registry.ts` and this file import each
 * other, and the registry is what registers this shape — so the check goes where the cycle does not.
 */
/**
 * The tool names a roster entry may grant (ADR-003).
 *
 * ADR-001 made `--tools` load-bearing security configuration rather than a convenience field, and this was
 * `z.array(z.string())` — so `Bsah` granted nothing while reading as though it granted something, and the
 * reverse mistake was worse. A declared vocabulary makes an unknown name a refusal at parse, which is the
 * treatment every other load-bearing vocabulary in this codebase gets.
 *
 * `Task` is absent deliberately: a step that could spawn its own subagents is an unbounded tree. `WebFetch`
 * and `WebSearch` are absent because AD-13/AD-14 route every external read through the engine's fetch
 * record, and a step reaching the network directly would leave that record incomplete. Adding a name here is
 * a decision; finding one in a TOML is not.
 */
export const GRANTABLE_TOOLS = ['Read', 'Write', 'Edit', 'Grep', 'Glob', 'Bash'] as const;

export type GrantableTool = (typeof GRANTABLE_TOOLS)[number];

export const GrantableToolSchema = z.enum(GRANTABLE_TOOLS);

export const AgentDeclarationSchema = versioned({
  id: z.string(),
  purpose: z.string(),
  contract: z.string(),
  tools: z.array(GrantableToolSchema),
  mcp_domains: z.array(z.string()),
  reversibility: z.enum(REVERSIBILITY_CLASSES),
  model: AgentModelSchema,
});

export type AgentDeclaration = z.infer<typeof AgentDeclarationSchema>;

/**
 * `<target-repo>/.orch/profile.toml` — the mechanics AD-16 makes the profile authoritative for.
 *
 * `project.id` is the first-commit SHA per AD-10; `project.path` is the mutable pointer that AD-10
 * calls updatable on mismatch, and it is recorded rather than trusted as identity.
 */
export const ProfileSchema = versioned({
  project: z.object({
    id: z.string(),
    path: z.string(),
    /**
     * Empty means "this repository has no remote", which is a real answer.
     *
     * Not `null`: TOML has no null, and the Consistency Conventions make human-edited configuration
     * TOML. A key left out instead would be indistinguishable from an answer nobody has given yet,
     * which is exactly the distinction a re-run depends on.
     */
    remote: z.string(),
  }),
  mechanics: z.object({
    package_manager: z.enum(PACKAGE_MANAGERS),
    commands: MechanicsCommandsSchema,
    source_layout: z.array(z.string()),
    resources: z.enum(RESOURCE_NEEDS),
  }),
  risk: z.object({
    high_blast_radius_paths: z.array(z.string()),
    conflict_domains: z.array(z.string()),
  }),
  /**
   * Which built-in agents question 10 enabled.
   *
   * Recorded here as well as written out as one TOML each, because the two facts are not the same
   * one: `.orch/agents/` is the roster the engine discovers (AD-17), and this is the *answer* a
   * re-run must not ask for again. Without it, a built-in's file deleted between two writes would
   * read back as "that agent was never enabled" — a half-install silently reinterpreted as an
   * answer, which is precisely what AD-12's manifest exists to prevent.
   *
   * A *custom* agent's declaration is not duplicated here: it lives only in its own file, which is
   * the one AD-17 makes authoritative, and it is not regenerable from anything else.
   */
  roster: z.object({ builtin_agents: z.array(z.string()) }),
  branch_pattern: z.string(),
  /**
   * AD-27 — shadow is an ordinary run carrying a mode flag, so the autonomy a project starts at is
   * that flag's default and nothing else. The finer autonomy ladder a person steers through at
   * runtime is folded from the event log by `src/tui/mode.ts`; it is not a per-repo setting, and
   * declaring it twice would be the two-sources-of-truth failure AD-34 forbids.
   */
  autonomy_start: z.enum(RUN_MODES),
  ceilings: CeilingsSchema,
});

export type Profile = z.infer<typeof ProfileSchema>;

/**
 * `<target-repo>/.orch/permissions.toml` — granted tools, the reversibility gate table and the
 * egress allowlist.
 *
 * The egress allowlist is where question 9's answer lands, so this is the file the credential test
 * reads: the *names* are here and no value of any of them ever is.
 */
export const PermissionsSchema = versioned({
  granted_tools: z.array(z.string()),
  /** Which reversibility classes stop for a person. AD-12's gate table, per class. */
  gated_reversibility_classes: z.array(z.enum(REVERSIBILITY_CLASSES)),
  egress_allowlist: z.array(ExternalDomainSchema),
});

export type Permissions = z.infer<typeof PermissionsSchema>;

/**
 * One file the installer created, with the digest it had when it was written.
 *
 * The digest is what makes AD-12's "a half-install is detectable" true of a file that exists but is
 * truncated, not only of one that is absent. A re-run compares both.
 */
export const ManifestEntrySchema = z.object({
  /** Relative to the target repository root, with `/` separators on every platform. */
  path: z.string(),
  sha256: z.string(),
  bytes: z.int(),
});

export type ManifestEntry = z.infer<typeof ManifestEntrySchema>;

/**
 * `<target-repo>/.orch/manifest.toml` — AD-12's manifest of every file the installer created.
 *
 * It carries the installer version as well as the `schema_version`, because AD-28's refusal has to
 * name *which installer* wrote what it is refusing, and a version known only to this build's own
 * table cannot name an installer that predates the table.
 */
export const ManifestSchema = versioned({
  installer_version: z.string(),
  /** RFC3339 with milliseconds in UTC, carried as a string per the Consistency Conventions. */
  written_at: z.string(),
  project_id: z.string(),
  files: z.array(ManifestEntrySchema),
});

export type Manifest = z.infer<typeof ManifestSchema>;

/**
 * Every artifact schema this story puts on disk, named once.
 *
 * `tests/installer.artifacts.test.ts` folds over it so an artifact added later without a
 * `schema_version` fails a test rather than shipping. The registry in `src/contracts/registry.ts`
 * registers the same four; this list exists so the installer's own tests do not have to know the
 * registry's ids to enumerate them.
 */
export const INSTALLER_ARTIFACT_SCHEMAS = Object.freeze({
  [PROFILE_FILE_NAME]: ProfileSchema,
  [PERMISSIONS_FILE_NAME]: PermissionsSchema,
  [MANIFEST_FILE_NAME]: ManifestSchema,
  'agents/<agent-id>.toml': AgentDeclarationSchema,
});
