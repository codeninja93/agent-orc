/**
 * AD-17 / ADR-001 — the one place that answers "what is this phase's agent granted".
 *
 * ADR-001 decision 3: "`--tools` is driven from AD-17's existing per-agent tool grant. Nothing new is
 * introduced: an existing declared field is wired to an existing CLI flag." This module is that wire, and
 * everything about its shape is an answer to a way of getting it wrong:
 *
 * **There is no map from a phase to a tool list in this file, or anywhere under `src/engine/`.** AD-17:
 * "The engine discovers agents only by reading that directory and holds no compiled-in list." A
 * `phase → tools` table here would be that list, and it would pass story 2-3's recursive import guard,
 * which matches import specifiers and the two names `BUILT_IN_AGENTS`/`BUILT_IN_AGENT_IDS` — not the idea
 * of a hardcoded roster. `tests/engine.agents.test.ts` therefore guards the *shape*: it fails on any
 * structure under `src/engine/` that associates an agent id with a granted tool name, and it proves it
 * catches one by planting the violation in a fixture tree.
 *
 * **A phase with no roster entry is a refusal, never a default.** A default grant is the same defect as a
 * compiled-in roster wearing a fallback's clothes: it makes a repository that declares nothing behave as
 * though it declared something, which is exactly what AD-17 exists to prevent — and because the grant is
 * load-bearing security configuration, the default would be *the* security decision, taken by the unit
 * least able to make it. So {@link grantFromRoster} throws, naming the phase, the directory it read and
 * the ids it did find.
 *
 * **The roster is authoritative even where it disagrees with ADR-003.** A declaration granting `Write` to
 * the analysis agent produces an argv carrying `Write`. Silently correcting it to ADR-003's table would
 * make the declarative roster a lie — a person reading `.orch/agents/analysis.toml` would see a grant the
 * run did not use — and would hide a misconfiguration that is worth seeing. What this module does instead
 * is *report*: {@link AgentGrant.elevated} names every granted tool that can change something, and the
 * grant is recorded verbatim on the spawn event. The engine cannot compare the grant to ADR-003's table
 * because holding that table is the thing AD-17 forbids; what it can do is say, from the tool names alone,
 * that this agent was handed the means to write or to run commands. `tests/contracts.agent-grants.test.ts`
 * is where ADR-003's table is pinned, and the built-in roster is where it is applied.
 *
 * **The grant is read from the run's AD-9 snapshot, so a mid-run edit to `.orch/` reaches nothing.**
 * `readStepConfiguration` has no parameter a repository path could arrive in, which is what makes that
 * structural rather than advisory.
 */
import { MCP_TOOL_CLI_NAMES, isMcpGrantableTool } from '../contracts/index.js';
import type { GrantableTool, McpGrantableTool, ModelRung } from '../contracts/index.js';

import { readStepConfiguration } from './config-snapshot.js';
import type { ConfigSnapshotOptions } from './config-snapshot.js';
import { startingRung } from './promotion.js';
import { rosterAgent } from './roster.js';
import type { DiscoveredRoster } from './roster.js';

/**
 * The tools that only read, classified by what the tool *is* rather than by who holds it.
 *
 * This is not a roster and cannot become one: it is keyed by tool name, it names no agent and no phase,
 * and it answers one question about the declared vocabulary — can this tool change anything. ADR-003
 * argues every grant in its table from that property ("It needs to read the repository and nothing else";
 * "It must not be able to edit what it is judging"), and the Boundaries of story 2-4 rest on it: analysis
 * and planning are pure functions *because* there is no tool in their grant with which to cause a side
 * effect.
 *
 * The example this sentence used to give was ADR-003's "`Bash` is how a gate runs, inside the container
 * per ADR-001" — a justification **ADR-004 retracted as measured false**, because the agent runs on the
 * host and so does its shell. Quoting a retracted line as live reasoning is how a refuted claim goes on
 * being believed, so it is replaced by one the amended table still makes.
 *
 * "Elevated" is the *complement* of this list rather than a list of its own, so a name added to
 * {@link GRANTABLE_TOOLS} counts as elevated until somebody decides otherwise. That is the fail-safe
 * direction: a new tool wrongly called read-only would make an elevated grant look ordinary, while one
 * wrongly called elevated only over-reports.
 */
export const READ_ONLY_TOOLS: readonly GrantableTool[] = Object.freeze(['Read', 'Grep', 'Glob']);

/** True when a granted tool can change something: write a file, or run a command. */
export const isElevatedTool = (tool: GrantableTool): boolean => !READ_ONLY_TOOLS.includes(tool);

/** The tools a phase's agent is granted, and where that was declared. */
export interface AgentGrant {
  /**
   * The phase the spawn asked about, which is also the agent id it was resolved by.
   *
   * The six phase names and the six built-in agent ids are the same six words, and AD-17 keys a
   * declaration by its file name. Using the phase as the lookup key is therefore reading a fact rather
   * than holding a mapping: a repository that renames an agent renames the file, and the phase that finds
   * no entry is refused by name.
   */
  readonly phase: string;
  readonly agentId: string;
  /** The declaration file the grant was read from, so a refusal or a divergence names a file. */
  readonly declaredAt: string;
  /** The roster directory read — run scope, per AD-9. */
  readonly rosterDir: string;
  /** Exactly what the declaration grants, in the order it declares it. Never corrected, never sorted. */
  readonly tools: readonly GrantableTool[];
  /** The granted tools that can change something. Empty for a genuinely read-only agent. */
  readonly elevated: readonly GrantableTool[];
  /** The reversibility class the same declaration claims, for a caller comparing the two. */
  readonly reversibility: string;
  /**
   * The rung this agent's declaration says its steps start on (AD-17: "a starting tier and a promotion
   * policy, never a fixed assignment").
   *
   * Carried here because until story 2-5 nothing in `src/engine/` read it: the installer wrote
   * `model.start_tier` into every `.orch/agents/*.toml`, the reconciler used the feature plan's
   * `starting_model_tier`, and the declared field was configuration a person could edit with no effect.
   * A declared value nobody reads is worse than an absent one — it reads as a setting and behaves as a
   * comment. It is passed through {@link startingRung}, so the ladder is the one authority on what a rung
   * is and an unplaceable one is refused by name rather than becoming the cheapest.
   */
  readonly startTier: ModelRung;
  readonly summary: string;
}

/**
 * No declaration for this phase, so there is no grant and the spawn cannot be built.
 *
 * `config.invalid` → `escalate-to-human` in the AD-35 table, the same code every other
 * malformed-or-absent-configuration refusal in `src/engine/roster.ts` carries. Nothing retries its way out
 * of a roster that does not declare the agent a run needs.
 */
export class AgentGrantUnresolved extends Error {
  readonly code = 'config.invalid';
  readonly phase: string;
  readonly rosterDir: string;

  constructor(phase: string, roster: DiscoveredRoster) {
    super(
      `No agent is declared for phase "${phase}" in ${roster.agentsDir}, so there is no tool grant to ` +
        `pass to --tools. Declared there: ${roster.agents.length === 0 ? '(nothing)' : roster.agents.map((entry) => entry.id).join(', ')}. ` +
        `${roster.refused.length === 0 ? '' : `Refused there: ${roster.refused.map((entry) => `${entry.path} (${entry.code})`).join(', ')}. `}` +
        'AD-17 discovers agents only by reading that directory and the engine holds no compiled-in list, ' +
        'so this is a refusal and never a default grant: ADR-001 made --tools load-bearing security ' +
        'configuration, and a grant nobody declared is a decision nobody took.',
    );
    this.name = 'AgentGrantUnresolved';
    this.phase = phase;
    this.rosterDir = roster.agentsDir;
  }
}

/**
 * Resolve one phase's grant from a discovered roster.
 *
 * Pure over the roster, so the refusal and the divergence report are both testable without a snapshot on
 * disk, and so {@link resolveAgentGrant} is the only thing that touches the filesystem.
 */
export const grantFromRoster = (roster: DiscoveredRoster, phase: string): AgentGrant => {
  const entry = rosterAgent(roster, phase);
  if (entry === null) throw new AgentGrantUnresolved(phase, roster);
  const tools = [...entry.declaration.tools];
  const elevated = tools.filter(isElevatedTool);
  return {
    phase,
    agentId: entry.id,
    declaredAt: entry.path,
    rosterDir: roster.agentsDir,
    tools,
    elevated,
    reversibility: entry.declaration.reversibility,
    startTier: startingRung(entry.declaration.model.start_tier),
    summary:
      `Phase "${phase}" runs agent "${entry.id}" declared in ${entry.path}, granted ` +
      `${tools.length === 0 ? 'no tools at all' : tools.join(', ')}` +
      `${elevated.length === 0 ? ' — every one of them read-only' : `, of which ${elevated.join(', ')} can change something`}` +
      ` (declared ${entry.declaration.reversibility}).`,
  };
};

/**
 * The `--tools` argument for a grant: the declared **built-in** names, comma-separated.
 *
 * The CLI's own form — `--tools "Edit,Read"` — and the declared order is preserved, because the
 * roster is what is authoritative and a re-ordering is a difference between the file and the argv that
 * nobody asked for.
 *
 * **An MCP grant is filtered out here, and that is not the engine overruling a declaration.** ADR-004
 * decision 3: "`--tools` continues to name **built-in** tools only — the CLI's help is explicit that
 * its list comes 'from the built-in set' — so the MCP tool is granted by being served, and
 * pre-approved through `--allowedTools`." A served tool's name passed to `--tools` is not an error the
 * CLI reports; it is a name from outside the built-in set, silently granting nothing, so the step
 * would run believing it had a gate it could not reach. The same grant still travels — see
 * {@link allowedToolsFor} — on the flag that carries it.
 *
 * An empty grant is passed as the CLI's explicit empty value rather than refused. `--tools ""` is
 * documented as "disable all tools", so a declaration granting nothing is expressible, and refusing it
 * here would be the engine overruling a declaration AD-17 makes authoritative. The grant is still
 * reported: `summary` says "no tools at all", which is what a reviewer needs to see.
 */
export const toolsArgumentFor = (grant: AgentGrant): string =>
  grant.tools.filter((tool) => !isMcpGrantableTool(tool)).join(',');

/**
 * The MCP grants in a declaration, as the names `--allowedTools` must pre-approve.
 *
 * Two things this is, and one it is not. It is the *translation* of a declared capability into the
 * CLI's `mcp__<server>__<tool>` spelling, taken from the one table in `src/contracts/` that holds
 * both halves. It is keyed by tool name and names no agent and no phase, so it is not the compiled-in
 * roster AD-17 forbids — the same argument `READ_ONLY_TOOLS` above rests on.
 *
 * Why it exists at all: under `--restricted` "only a person or the configured permission tool" can
 * approve a tool use, and a `claude -p` run has neither. A served tool that is not pre-approved is
 * therefore not a tool that gets refused — it is a step that stops and waits for an answer nobody
 * can give. `src/engine/spawner.ts` refuses to build such an argv at all.
 */
export const mcpGrantsOf = (grant: AgentGrant): readonly McpGrantableTool[] =>
  grant.tools.filter((tool): tool is McpGrantableTool => isMcpGrantableTool(tool));

/** The `--allowedTools` value for a grant: every served tool, in the CLI's own spelling. */
export const allowedToolsFor = (grant: AgentGrant): readonly string[] =>
  mcpGrantsOf(grant).map((tool) => MCP_TOOL_CLI_NAMES[tool]);

export interface ResolveAgentGrantOptions extends ConfigSnapshotOptions {
  readonly run: string;
  readonly phase: string;
}

/**
 * The grant for a phase of a run, read from that run's configuration snapshot.
 *
 * A step reads run scope and never `.orch/` (AD-9), and `readStepConfiguration` is the only reader of it.
 */
export const resolveAgentGrant = (options: ResolveAgentGrantOptions): AgentGrant => {
  const configuration = readStepConfiguration(
    options.run,
    options.orchHome === undefined ? {} : { orchHome: options.orchHome },
  );
  return grantFromRoster(configuration.roster, options.phase);
};
