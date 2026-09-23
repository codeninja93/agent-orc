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

import { KnowledgeSectionSchema } from './knowledge.js';
import { versioned } from './schema-version.js';
import type { SchemaVersionPolicy } from './schema-version.js';
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
 * The commands AD-16 makes the profile authoritative for.
 *
 * A total record rather than an optional bag: a repository with no lint command records the empty
 * string for it, so a reader distinguishes "there is none" from "nobody was asked".
 *
 * **`typecheck` is here because CAP-13 names it and the profile could not express it.** CAP-13's
 * success criterion is "deterministic gates (typecheck, lint, tests) run before any model-based
 * review", and until story 2-6 this record held four commands, none of them a typecheck — so one
 * third of the gate CAP-13 requires was unrunnable for want of anywhere to declare it. The empty
 * string is as legitimate an answer for it as it already is for `lint`: a repository with no
 * typecheck step records that it has none, and a gate with no command is *skipped* rather than
 * failed, because a repository that cannot fail a gate it does not have must not be reported as
 * having passed one.
 *
 * Adding it is a change to the shape of an artifact the installer writes, so the profile's
 * `schema_version` advances with it ({@link PROFILE_SCHEMA_VERSION}) and a profile written before it
 * is refused rather than read with a defaulted field (AD-28).
 */
export const MechanicsCommandsSchema = z.object({
  test: z.string(),
  typecheck: z.string(),
  lint: z.string(),
  build: z.string(),
  run: z.string(),
});

export type MechanicsCommands = z.infer<typeof MechanicsCommandsSchema>;

/**
 * The command names, in **one** order, which is the interview's field order and the order the gates
 * run in.
 *
 * It is deliberately *not* the order `build-sequencing.md` question 3 states ("test, lint, build and
 * run"), and the comment here used to claim it was — while the interview and the detection table
 * each used a third. Three orders and a false citation is worse than one order stated plainly: what
 * the document fixes is which answers the question must produce, and it says so itself, so the
 * sequence is this system's to choose.
 *
 * The choice is cheapest-first among the gates CAP-13 names, so a run learns which symbol is wrong
 * before it spends minutes on a test suite that would have said the same thing less clearly, with
 * the two non-gate mechanics after them.
 */
export const MECHANICS_COMMAND_NAMES = ['typecheck', 'lint', 'test', 'build', 'run'] as const;

export type MechanicsCommandName = (typeof MECHANICS_COMMAND_NAMES)[number];

/**
 * The commands CAP-13 calls the deterministic gates, in the order they run.
 *
 * Cheapest and most specific first: a typecheck that fails tells a person which symbol is wrong in
 * seconds, and running the whole test suite before it spends minutes to say the same thing less
 * clearly. `build` and `run` are deliberately absent — they are mechanics AD-16 records for other
 * purposes, and CAP-13 names exactly these three.
 */
export const DETERMINISTIC_GATE_NAMES = ['typecheck', 'lint', 'test'] as const;

export type DeterministicGateName = (typeof DETERMINISTIC_GATE_NAMES)[number];

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
export const BUILT_IN_GRANTABLE_TOOLS = ['Read', 'Write', 'Edit', 'Grep', 'Glob', 'Bash'] as const;

export type BuiltInGrantableTool = (typeof BUILT_IN_GRANTABLE_TOOLS)[number];

/**
 * The grants that are **not** built-in tools, and so may never reach `--tools`.
 *
 * ADR-004 decision 3: "`--tools` continues to name **built-in** tools only — the CLI's help is
 * explicit that its list comes 'from the built-in set' — so the MCP tool is granted by being served,
 * and pre-approved through `--allowedTools`". A name in this list therefore travels a different
 * wire from a name in {@link BUILT_IN_GRANTABLE_TOOLS}, and the split is a list rather than a
 * convention because the two wires cannot be told apart by looking at a name: `RunDeclaredCommand`
 * passed to `--tools` is silently dropped by the CLI as an unknown built-in, which is a step that
 * runs with a gate it believes it has and cannot reach.
 *
 * It is declared here, beside the built-ins, because AD-17 requires a granted tool name to be "a
 * name declared in `src/contracts/`" — the declaration is what makes a typo a refusal at parse
 * rather than a grant that silently does nothing.
 */
export const MCP_GRANTABLE_TOOLS = ['RunDeclaredCommand'] as const;

export type McpGrantableTool = (typeof MCP_GRANTABLE_TOOLS)[number];

/**
 * How each MCP grant is spelled in `--allowedTools`, which is the CLI's `mcp__<server>__<tool>` form.
 *
 * Two names for one capability, and both belong here rather than one of them in the server: the
 * roster declares the capability and the argv pre-approves the tool, and a server that owned its own
 * CLI spelling would be a second place the pair could disagree — with the disagreement showing up as
 * a step that hangs on a permission prompt nobody can answer, which is the outcome ADR-004 calls the
 * worst available. `src/runner/` imports these rather than spelling them.
 */
export const MCP_SERVER_NAME = 'orch';

export const MCP_TOOL_CLI_NAMES: Readonly<Record<McpGrantableTool, string>> = {
  RunDeclaredCommand: `mcp__${MCP_SERVER_NAME}__run_declared_command`,
};

/**
 * The `--mcp-config` entry that launches the command runner for one run and step.
 *
 * **Here rather than in `src/runner/`, because two units need it and they may not import each
 * other.** The engine writes this file before a spawn whose grant names a served tool, and the
 * runner's entry point is what the file starts; `src/engine/` may not import `src/runner/` — the one
 * unit allowed to start a container stays one import away from the loop — and a second copy of the
 * shape in the engine would be two answers to "what does the config say". It sits beside
 * {@link MCP_SERVER_NAME} and {@link MCP_TOOL_CLI_NAMES} because it is the third half of the same
 * agreement: what the server is called, what its tool is called, and how it is started.
 *
 * The interpreter is the absolute Node AD-28 resolved, never `node` from `PATH`: this server is a
 * child of `claude -p`, which is a child of the engine, and a stale version manager two levels down
 * is exactly the opaque failure AD-28 exists to prevent.
 */
export const commandRunnerMcpConfig = (server: {
  readonly nodePath: string;
  readonly entryPoint: string;
  readonly run: string;
  readonly step: string;
  readonly orchHome: string;
  readonly attempt?: number;
}): Readonly<Record<string, unknown>> => ({
  mcpServers: {
    [MCP_SERVER_NAME]: {
      command: server.nodePath,
      args: [server.entryPoint],
      env: {
        ORCH_HOME: server.orchHome,
        ORCH_RUN: server.run,
        ORCH_STEP: server.step,
        // The step attempt, so the container the runner names cannot collide with the one the
        // previous attempt left behind — AD-20 never removes it while the run is live.
        ...(server.attempt === undefined ? {} : { ORCH_STEP_ATTEMPT: String(server.attempt) }),
      },
    },
  },
});

export const GRANTABLE_TOOLS = [...BUILT_IN_GRANTABLE_TOOLS, ...MCP_GRANTABLE_TOOLS] as const;

export type GrantableTool = (typeof GRANTABLE_TOOLS)[number];

/** True when a granted name is served as an MCP tool rather than passed to `--tools`. */
export const isMcpGrantableTool = (tool: string): tool is McpGrantableTool =>
  (MCP_GRANTABLE_TOOLS as readonly string[]).includes(tool);

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
/**
 * The profile's own `schema_version`, ahead of every other artifact's.
 *
 * Story 2-6 added `mechanics.commands.typecheck`, and AD-28 gives a shape change exactly one honest
 * consequence: a profile written before it is **refused** with `config.schema_version_unrecognised`,
 * naming the installer that wrote it, rather than read with the field defaulted to the empty string.
 * The difference matters because an empty command means "this repository has no typecheck step" and
 * a defaulted one would mean "nobody was asked" — and the two are indistinguishable once written, so
 * the gate CAP-13 requires would be reported as skipped on every repository upgraded rather than
 * re-interviewed.
 *
 * Only the profile advances. See {@link SchemaVersionPolicy}: a global bump would refuse every run's
 * `state.json` too, and a run in flight across an upgrade has done nothing wrong.
 */
export const PROFILE_SCHEMA_VERSION = 2;

export const PROFILE_SCHEMA_VERSION_POLICY: SchemaVersionPolicy = {
  current: PROFILE_SCHEMA_VERSION,
  // Only the current one. A v1 profile is missing a field the gates read, and there is nothing to
  // read it as: reading two versions here would be the silent default this bump exists to refuse.
  supported: [PROFILE_SCHEMA_VERSION],
};

export const ProfileSchema = versioned(
  {
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
    /**
     * AD-16's project knowledge — and the one field of this artifact that is optional.
     *
     * Optional because every profile written so far has none: story 2-1's installer writes `project`,
     * `mechanics`, `risk`, the roster answer and the ceilings, and entries arrive with the bootstrap
     * agent in stage 5. Requiring the section would make every `.orch/` the installer has ever written
     * unreadable by the loader that is supposed to read it, which is a migration invented to satisfy a
     * schema rather than a behaviour anybody asked for.
     *
     * The precedence machinery over these entries is `src/engine/profile.ts`: additive only, and flagged
     * stale rather than applied where the repository's own instructions speak to the same anchor.
     */
    knowledge: KnowledgeSectionSchema.optional(),
  },
  PROFILE_SCHEMA_VERSION_POLICY,
);

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
