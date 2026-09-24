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
import type { ReversibilityClass } from './step.js';
import { mcpToolCliNamesFor } from './tool-server.js';
import type { ToolServerDefinition } from './tool-server.js';

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
 * The placeholders a `branch_pattern` puts the feature slug at, declared here because two units read
 * them and neither may import the other.
 *
 * AD-22 has the committer own branch naming and the *profile* declare the pattern once. The installer
 * interviews for it and writes it; `src/engine/committer.ts` reads it and names the branch. The engine
 * imports only `src/contracts/`, `src/runtime/` and `node:` builtins, so a vocabulary spelled in
 * `src/installer/interview.ts` — where it started — is one the unit that acts on it cannot see, and the
 * two would have been free to disagree about what a valid pattern is.
 *
 * **Two spellings, one placeholder, and this is the reason.** The installer's own default is
 * `feature/<slug>`; AD-22 and every profile fixture written against it spell the same thing
 * `feature/<feature-slug>`. Refusing the spelling the architecture document itself uses would refuse a
 * profile written to the architecture, so both are accepted — declared once, here, rather than each
 * reader deciding. The longer spelling is listed first because substitution replaces in this order and
 * `<slug>` does not occur inside `<feature-slug>`, so the longest match has to be tried first for the
 * shorter one not to miss it.
 */
export const BRANCH_SLUG_PLACEHOLDERS = ['<feature-slug>', '<slug>'] as const;

export type BranchSlugPlaceholder = (typeof BRANCH_SLUG_PLACEHOLDERS)[number];

/** AD-22 — "defaulting to `feature/<feature-slug>`", in the installer's own spelling of the placeholder. */
export const DEFAULT_BRANCH_PATTERN = 'feature/<slug>';

/**
 * True when a pattern can name more than one branch.
 *
 * A pattern with no placeholder is a defect and not a preference: every feature would land on the same
 * branch, so the second feature's work would be pushed onto the first's and AD-22's "the committer is
 * the only unit that creates or names a branch" would be satisfied by a committer that names one branch
 * for ever. The refusals are the interview's (at the moment a person types it) and the committer's (at
 * the moment it is read), and both ask this one question.
 */
export const branchPatternVaries = (pattern: string): boolean =>
  BRANCH_SLUG_PLACEHOLDERS.some((placeholder) => pattern.includes(placeholder));

/** The characters git refuses in a ref name, plus the ASCII control range and DEL. */
const REF_FORBIDDEN_CHARACTERS = /[~^:?*[\\\x00-\x1f\x7f]/;

/**
 * Why this pattern could not name a git branch, or `null` when it could.
 *
 * **A pattern is a template for an argument `git` receives**, and the placeholder check answers a
 * different question: "can this name two branches", not "is this a branch name". So `feature/../<slug>`,
 * a leading `-`, a space, a `~^:?*`, a doubled slash and a `.lock` tail all reached argv unchallenged —
 * some of them refused by `git` at the far end with a message about a ref, and `..` not refused at all.
 *
 * The rules are `git check-ref-format --branch`'s, restricted to the ones a *pattern* can break. `<` and
 * `>` are deliberately not forbidden: git permits them in a ref name, and the placeholder is spelled
 * with them. The slug substituted in is separately held to being a safe path segment, so this is about
 * the fixed text around it.
 *
 * Applied at the three places the pattern is read — the interview, where a person can retype it;
 * `ProfileSchema`, so a hand-edited `.orch/profile.toml` is refused when it is parsed; and
 * `src/engine/committer.ts`, which is where a branch is actually named.
 */
export const branchPatternProblem = (pattern: string): string | null => {
  if (pattern.trim() === '') return 'it is blank';
  if (pattern !== pattern.trim()) return 'it is wrapped in whitespace';
  if (/\s/.test(pattern)) return 'it contains whitespace, which no git ref name may';
  if (REF_FORBIDDEN_CHARACTERS.test(pattern)) {
    return 'it contains one of ~ ^ : ? * [ \\ or a control character, which git forbids in a ref name';
  }
  if (pattern.includes('..')) return 'it contains "..", which git forbids and which climbs a path';
  if (pattern.includes('@{')) return 'it contains "@{", which git reads as a reflog selector';
  if (pattern === '@') return 'it is "@", which git reserves';
  if (pattern.startsWith('-')) return 'it starts with "-", so git would read the branch name as a flag';
  if (pattern.startsWith('/') || pattern.endsWith('/')) return 'it starts or ends with "/"';
  if (pattern.includes('//')) return 'it contains an empty path component ("//")';
  if (pattern.endsWith('.')) return 'it ends with ".", which git forbids';
  for (const component of pattern.split('/')) {
    if (component.startsWith('.')) return `its component "${component}" starts with "."`;
    if (component.endsWith('.lock')) return `its component "${component}" ends with ".lock"`;
  }
  return null;
};

/**
 * The rate-limit window size a profile gets when nobody has stated one. **A placeholder.**
 *
 * Nothing in the spec, the CLI's result line or any published figure sizes a subscription's rate-limit
 * window in tokens, and story 2-9 needs one to turn `rate_limit_budget_percent` into an allowance its
 * recorded token counts can be measured against. The user decided to make the size a declared profile
 * field rather than guess it in engine code (story 2-9). This number is what a profile carries until
 * real usage data says what a window actually holds — it is not a measurement and must not be read as
 * one. A multiple of a hundred, so the default allowance is a whole number of tokens.
 */
export const PLACEHOLDER_RATE_LIMIT_WINDOW_TOKENS = 10_000_000;

/**
 * The largest window size a profile may declare.
 *
 * A bound so a typo cannot declare a window no run could fill, and so the ceiling arithmetic stays exact:
 * story 2-9 compares `tokens × 100 × 100` against `window × percent × threshold` in whole numbers, and at
 * ten billion tokens that product still sits well inside `Number.MAX_SAFE_INTEGER`.
 */
export const MAX_RATE_LIMIT_WINDOW_TOKENS = 10_000_000_000;

/** AD-24's third ceiling is a share of the rate-limit window, so its maximum is a hundred percent. */
export const MAX_RATE_LIMIT_BUDGET_PERCENT = 100;

/** Bounds that exist so a typo cannot declare a ceiling no run could reach. */
export const MAX_CEILING_STEPS = 10_000;
export const MAX_CEILING_WALL_CLOCK_MINUTES = 10_080;

/**
 * A whole number from one to `max`, as a refinement so the draft-7 export carries no bound keywords.
 *
 * Applied to every ceiling, not only the window: story 2-9's boundary arithmetic multiplies a consumption by
 * ten thousand and a ceiling by a percent, so an unbounded hand-edited value could push either product past
 * `Number.MAX_SAFE_INTEGER` and decide the eighty-percent boundary on a rounded number. The interview already
 * refused values outside these bounds; a person editing `profile.toml` by hand is now refused the same way.
 */
const ceilingBound = (name: string, max: number) =>
  z.int().refine((value) => value >= 1 && value <= max, {
    message: `${name} must be between 1 and ${String(max)}`,
  });

/**
 * AD-24 — three ceilings and no currency dimension, which R10 restates as "cost is subscription
 * usage, never currency". So the third ceiling is a share of the rate-limit window in percent, and
 * there is deliberately no dollar field for a user to put a number in.
 *
 * **`rate_limit_window_tokens` is how big that window is, and it is additive.** Story 2-9 added it with a
 * default rather than advancing {@link PROFILE_SCHEMA_VERSION}, and the difference from story 2-6's
 * `typecheck` is the reason. A defaulted `typecheck` would have *asserted a fact about the repository* —
 * "declares no typecheck step" — that nobody stated, so a pre-2-6 profile had to be refused. A defaulted
 * window asserts nothing about the project: it is the same placeholder the engine would otherwise have to
 * hold itself, and every existing profile's three ceilings keep exactly the meaning they had. Refusing
 * every v2 profile to ask a question whose honest answer is still "not known yet" would be a migration
 * with nothing to migrate.
 */
export const CeilingsSchema = z.object({
  steps: ceilingBound('steps', MAX_CEILING_STEPS).describe(
    'The most step attempts a run may make — every start, re-run and resume — a whole number from 1 to 10,000.',
  ),
  wall_clock_minutes: ceilingBound('wall_clock_minutes', MAX_CEILING_WALL_CLOCK_MINUTES).describe(
    'The most minutes a run may work, excluding time waiting on a person, a whole number from 1 to 10,080.',
  ),
  rate_limit_budget_percent: ceilingBound('rate_limit_budget_percent', MAX_RATE_LIMIT_BUDGET_PERCENT).describe(
    'The share of the rate-limit window a run may consume, in whole percent from 1 to 100.',
  ),
  rate_limit_window_tokens: ceilingBound('rate_limit_window_tokens', MAX_RATE_LIMIT_WINDOW_TOKENS)
    .default(PLACEHOLDER_RATE_LIMIT_WINDOW_TOKENS)
    .describe(
      'How many tokens one rate-limit window holds, a whole number from 1 to 10,000,000,000. ' +
        'rate_limit_budget_percent is a share of this. Defaults to a placeholder, not a measurement.',
    ),
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
 *
 * **Story 2-10 generalises this from a single server's tool to the union of every registered
 * server's tools.** `RunDeclaredCommand` was the whole of this list because the command-runner was
 * the only tool server this codebase built; Jira's two read-only operations
 * ({@link JIRA_TOOL_NAMES}) are the second, and {@link TOOL_SERVERS} is the registry both are read
 * from — a third domain adds a row there, not a second list here.
 */
export const RUN_DECLARED_COMMAND_TOOL = 'RunDeclaredCommand';

/**
 * Jira's read-only vocabulary (story 2-10, CAP-7's "reads only" scope for this first tool server).
 *
 * A closed enum of two names, mirroring `DECLARED_COMMAND_NAMES`'s own reasoning: an arbitrary Jira
 * call is not merely refused, it is unsayable, because the roster can grant nothing outside this list
 * and the server's own request schema (`src/tool-servers/jira/operations.ts`) admits nothing else
 * either.
 */
export const JIRA_TOOL_NAMES = ['get_issue', 'search_issues'] as const;

export type JiraToolName = (typeof JIRA_TOOL_NAMES)[number];

export const MCP_GRANTABLE_TOOLS = [RUN_DECLARED_COMMAND_TOOL, ...JIRA_TOOL_NAMES] as const;

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

/** Jira's own MCP server name: its own `--mcp-config` key and its own `--allowedTools` prefix. */
export const JIRA_SERVER_NAME = 'jira';

/**
 * The command-runner, as the first entry of the per-server registry ADR-004's singular wiring
 * generalises into. Its shape and behaviour are exactly what they were before this story: one server,
 * one served tool, `RunDeclaredCommand` on the roster and `run_declared_command` on the wire.
 */
export const COMMAND_RUNNER_SERVER: ToolServerDefinition<typeof RUN_DECLARED_COMMAND_TOOL> = {
  domain: 'command-runner',
  serverName: MCP_SERVER_NAME,
  tools: { [RUN_DECLARED_COMMAND_TOOL]: 'run_declared_command' },
};

/**
 * Jira, the second tool server and this story's proof that the pattern generalises: its two grantable
 * names are also the names it publishes over the wire, so no translation table is needed beyond the
 * one every server gets from {@link mcpToolCliNamesFor}.
 */
export const JIRA_SERVER: ToolServerDefinition<JiraToolName> = {
  domain: 'jira',
  serverName: JIRA_SERVER_NAME,
  tools: { get_issue: 'get_issue', search_issues: 'search_issues' },
};

/**
 * The per-server registry `MCP_SERVER_NAME`/`MCP_TOOL_CLI_NAMES`/`commandRunnerMcpConfig` used to be
 * singular in place of. A step's `--mcp-config` is composed in `src/engine/spawner.ts` from exactly the
 * servers a grant's tools implicate ({@link serversForTools} in `tool-server.ts`), never from a server
 * named by hand — so a domain added here, with its own `src/tool-servers/<domain>/` server module, is
 * reachable without touching that composition again (this story's own scope: prove the pattern once,
 * "generalized enough to add a second domain later without touching `RunFetchRecord`,
 * `src/contracts/fetch.ts`, or `src/runtime/redaction.ts` again").
 */
export const TOOL_SERVERS: readonly ToolServerDefinition[] = [COMMAND_RUNNER_SERVER, JIRA_SERVER];

export const MCP_TOOL_CLI_NAMES: Readonly<Record<McpGrantableTool, string>> = {
  ...mcpToolCliNamesFor(COMMAND_RUNNER_SERVER),
  ...mcpToolCliNamesFor(JIRA_SERVER),
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

/**
 * Environment keys a `credential_env` must never name: the fixed keys {@link jiraMcpConfig} itself
 * sets, plus the host/interpreter keys whose value the Jira child's own process trusts structurally.
 *
 * **Amended after review pass 1.** A profile's `credential_env` naming one of the `ORCH_*` keys would
 * have its own object-spread entry land last in `jiraMcpConfig`'s `env` object literal below, silently
 * overwriting whichever fixed key it collided with.
 *
 * **Amended a second time, same review.** `ORCH_*` was not the whole risk: `credential_env` naming
 * `PATH`, `HOME`, `NODE_OPTIONS`, `NODE_PATH`, `LD_PRELOAD`, `LD_LIBRARY_PATH`,
 * `DYLD_INSERT_LIBRARIES` or `DYLD_LIBRARY_PATH` would still overwrite *that* key in the spawned Jira
 * child's environment with the credential value — not colliding with anything `jiraMcpConfig` sets, but
 * corrupting how the child process itself resolves commands and loads code (`NODE_OPTIONS`/`NODE_PATH`
 * are read by Node's own startup; `LD_PRELOAD`/`LD_LIBRARY_PATH`/`DYLD_INSERT_LIBRARIES`/
 * `DYLD_LIBRARY_PATH` are the loader-hijacking family on Linux and macOS). Declared once here,
 * immediately beside the function whose keys these are, so the two can never drift apart;
 * {@link JiraToolServerSchema} refuses a colliding name before it can reach this object literal at all.
 */
export const JIRA_RESERVED_ENV_KEYS = [
  'ORCH_HOME',
  'ORCH_RUN',
  'ORCH_STEP',
  'ORCH_FEATURE',
  'ORCH_STEP_ATTEMPT',
  'ORCH_JIRA_BASE_URL',
  'ORCH_JIRA_CREDENTIAL_ENV',
  'PATH',
  'HOME',
  'NODE_OPTIONS',
  'NODE_PATH',
  'LD_PRELOAD',
  'LD_LIBRARY_PATH',
  'DYLD_INSERT_LIBRARIES',
  'DYLD_LIBRARY_PATH',
] as const;

/**
 * The `--mcp-config` entry that launches the Jira tool server for one run and step (story 2-10).
 *
 * Structurally the command-runner's twin above, with the two things Jira's server needs that the
 * command-runner never did:
 *
 * - `credentialEnvVar` — the *name* the profile records for the Jira credential, never the value
 *   (this story's own Boundary), so the spawned server knows which of its own environment entries to
 *   read;
 * - `credentialValue` — the actual value, which the caller (`src/engine/spawner.ts`) reads from the
 *   engine's own process environment at spawn time and hands here to be injected into this one
 *   child's environment and nowhere else. The AD-20 step-executor container's env allow-list keeps
 *   refusing anything credential-shaped, because the Jira server does not run inside that boundary —
 *   it exists to guarantee the opposite.
 *
 * A blank `credentialEnvVar` (Jira not configured in this profile) is passed through rather than
 * refused here: the server itself refuses to start on an unset or blank credential (matrix row 7), so
 * there is exactly one place — the server's own startup — that refusal is decided.
 */
export const jiraMcpConfig = (server: {
  readonly nodePath: string;
  readonly entryPoint: string;
  readonly run: string;
  readonly step: string;
  readonly feature: string;
  readonly orchHome: string;
  readonly attempt?: number;
  readonly credentialEnvVar: string;
  readonly credentialValue: string;
  readonly baseUrl: string;
}): Readonly<Record<string, unknown>> => ({
  mcpServers: {
    [JIRA_SERVER_NAME]: {
      command: server.nodePath,
      args: [server.entryPoint],
      env: {
        ORCH_HOME: server.orchHome,
        ORCH_RUN: server.run,
        ORCH_STEP: server.step,
        ORCH_FEATURE: server.feature,
        ...(server.attempt === undefined ? {} : { ORCH_STEP_ATTEMPT: String(server.attempt) }),
        ORCH_JIRA_BASE_URL: server.baseUrl,
        // The name the server reads its own credential entry by, since that name is a per-profile
        // choice and the server cannot otherwise know which of its environment entries is the one.
        ORCH_JIRA_CREDENTIAL_ENV: server.credentialEnvVar,
        ...(server.credentialEnvVar === ''
          ? {}
          : { [server.credentialEnvVar]: server.credentialValue }),
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
 * Blank, for a tool-server profile field: exact emptiness after trimming whitespace.
 *
 * **Amended after review pass 1.** The interview's own blank-check for question 14's `base_url` and
 * {@link JiraToolServerSchema}'s cross-field refine used two different definitions of blank — exact
 * `=== ''` in the interview, trimmed in the schema — so a whitespace-only base URL passed the
 * interview's own guard and only failed later, as an unhandled Zod error instead of the friendly
 * re-prompt every other refusal in that question gets. Both now call this one function, so the two
 * can never disagree again.
 */
export const isBlankToolServerField = (value: string): boolean => value.trim() === '';

/**
 * Whether a string parses as an absolute `http(s)` URL.
 *
 * A probe with `URL`, not a field type of its own: {@link JiraToolServerSchema}'s `base_url` stays a
 * plain string on the wire (TOML has no URL type), and this is what decides whether a non-blank value
 * is refused at interview/write time rather than failing later, deep inside `callJiraApi`, as an
 * opaque runtime error.
 */
export const isHttpUrl = (value: string): boolean => {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
};

/**
 * The Jira tool server's own section of the profile (story 2-10): the *name* of the env var holding
 * its credential, never the value (AD-12, this story's own Boundary), and the base URL its read-only
 * operations are issued against.
 *
 * Both fields are blank together, which is how "Jira is not enabled" is recorded — the same convention
 * `mechanics.commands`'s empty string and `project.remote`'s empty string already use for "this
 * repository has none" rather than "nobody was asked". A blank pair reaches the spawned server exactly
 * as an unset credential does, so it refuses to start (matrix row 7) without this schema needing an
 * `enabled` flag of its own to keep in step with the other two.
 */
export const JiraToolServerSchema = z
  .object({
    /** Blank means Jira is not configured; otherwise the shape {@link EnvVarNameSchema} admits. */
    credential_env: z.union([z.literal(''), EnvVarNameSchema]),
    /** Blank means Jira is not configured; otherwise a URL {@link isHttpUrl} accepts. */
    base_url: z.string(),
  })
  .refine(
    (jira) => isBlankToolServerField(jira.credential_env) === isBlankToolServerField(jira.base_url),
    {
      message:
        'tool_servers.jira.credential_env and tool_servers.jira.base_url must either both be set or ' +
        'both be blank — a domain that is half-configured is not a domain a server could start against',
      path: ['base_url'],
    },
  )
  .refine(
    (jira) =>
      isBlankToolServerField(jira.credential_env) ||
      !(JIRA_RESERVED_ENV_KEYS as readonly string[]).includes(jira.credential_env),
    {
      // Amended after review pass 1: a colliding name must never reach jiraMcpConfig's own object
      // literal, where its object-spread entry would silently overwrite one of the fixed keys.
      message:
        `tool_servers.jira.credential_env must not be one of ${JIRA_RESERVED_ENV_KEYS.join(', ')} — ` +
        'those are environment keys jiraMcpConfig itself sets on the Jira server’s child ' +
        'environment, and a credential_env naming one of them would silently overwrite it',
      path: ['credential_env'],
    },
  )
  .refine((jira) => isBlankToolServerField(jira.base_url) || isHttpUrl(jira.base_url), {
    // Amended after review pass 1: a malformed base_url is refused here, at interview/write time,
    // rather than failing later inside callJiraApi as an opaque runtime error.
    message: 'tool_servers.jira.base_url must be a valid http(s) URL, e.g. https://your-domain.atlassian.net',
    path: ['base_url'],
  });

export type JiraToolServer = z.infer<typeof JiraToolServerSchema>;

/** The state every profile had before this story: no tool-server domain configured at all. */
export const DISABLED_JIRA_TOOL_SERVER: JiraToolServer = { credential_env: '', base_url: '' };

/**
 * The tool-server domains a profile can enable — one key today, and the point at which a later domain
 * (Stage 5's "tool domains beyond Jira") adds its own key beside `jira` rather than a sibling section.
 *
 * Defaulted, like {@link CeilingsSchema}'s `rate_limit_window_tokens`, rather than added at a new
 * `PROFILE_SCHEMA_VERSION`: a profile written before this story asserts nothing about Jira one way or
 * the other, and "no tool-server domain is configured" is the honest, additive reading of that silence
 * — not a fact an upgrade would have to ask a person to restate.
 */
export const ToolServersSchema = z.object({
  jira: JiraToolServerSchema.default(DISABLED_JIRA_TOOL_SERVER),
});

export type ToolServers = z.infer<typeof ToolServersSchema>;

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
    /**
     * The branch-name template AD-22 declares once, here and nowhere else.
     *
     * Refused at parse when it could not name a git branch, for the reason every other rule in this
     * schema is: `.orch/profile.toml` is human-edited, so the interview's own validation is the first
     * gate and not the only one. The refusal is the same sentence the committer would give, because
     * {@link branchPatternProblem} is the same function.
     */
    branch_pattern: z.string().refine((pattern) => branchPatternProblem(pattern) === null, {
      error: (issue): string =>
        `branch_pattern ${JSON.stringify(issue.input)} could not name a git branch: ` +
        `${branchPatternProblem(typeof issue.input === 'string' ? issue.input : '') ?? 'it is invalid'}`,
    }),
    /**
     * AD-27 — shadow is an ordinary run carrying a mode flag, so the autonomy a project starts at is
     * that flag's default and nothing else. The finer autonomy ladder a person steers through at
     * runtime is folded from the event log by `src/tui/mode.ts`; it is not a per-repo setting, and
     * declaring it twice would be the two-sources-of-truth failure AD-34 forbids.
     */
    autonomy_start: z.enum(RUN_MODES),
    ceilings: CeilingsSchema,
    /**
     * Story 2-10 — the tool-server domains this profile enables. Defaulted for the reason
     * {@link ToolServersSchema} gives: a profile written before this story configured no domain, and
     * that silence is read as "none enabled" rather than refused.
     */
    tool_servers: ToolServersSchema.default({ jira: DISABLED_JIRA_TOOL_SERVER }),
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
 * The reversibility classes that stop for a person, absent a person's own answer to question 9's
 * permissions section. CAP-12: an irreversible action is gated.
 *
 * **Declared here, in `src/contracts/`, rather than in `src/installer/` where it originated.** Story
 * 4-1 gave the engine a second reader of this exact default: an absent `permissions.toml` (a project
 * onboarded before this file existed, or one that lost it) falls back to it rather than reading as "no
 * policy, no gate" — and `src/engine/` may import only `src/contracts/`, `src/runtime/` and `node:`
 * builtins (never `src/installer/`), so the one constant both units read has to live where both may
 * reach it. `src/installer/write.ts` re-exports it rather than declaring its own, so the installer's
 * own default and the engine's fallback can never drift into two different answers to "what does an
 * unconfigured project gate".
 */
export const GATED_REVERSIBILITY_CLASSES: readonly ReversibilityClass[] = ['irreversible'];

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
