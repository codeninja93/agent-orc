/**
 * AD-17 / ADR-004, generalised — the domain-agnostic shape a tool server and its grant share.
 *
 * Story 2-6 built the command-runner as a single, hardcoded MCP server — `MCP_SERVER_NAME = 'orch'` in
 * `src/contracts/installer.ts`, one server, one grant, nothing that named a second. CAP-7 ("each
 * external domain reachable by exactly one agent, enforced by where its credential lives") needs more
 * than one server to mean anything, so this file names the shape every tool server shares: the domain
 * it is the sole owner of, the `--mcp-config` key and `--allowedTools` prefix it is spawned under, and
 * the grantable tool names it serves. `src/contracts/installer.ts` holds a small registry built from
 * this shape instead of the singular constants it used to; `src/engine/spawner.ts` composes
 * `--mcp-config` from every server a step's grant implicates, rather than from one server it assumes.
 *
 * **Nothing here is domain-specific.** Jira's own tool names, request schemas, credential handling and
 * the server process itself live under `src/tool-servers/jira/`. This file is the generalisation point
 * a later domain (Stage 5's "tool domains beyond Jira") reads first, and it must stay that way: adding a
 * domain should cost a new `ToolServerDefinition` and a new `src/tool-servers/<domain>/`, never a change
 * to this file's own shape.
 */

/**
 * One MCP server's shape: the domain it is the sole owner of, the `--mcp-config` key / `--allowedTools`
 * prefix it is spawned under, and the grantable tool names it serves — each mapped to the name the
 * server itself publishes over the wire (`tools/list`'s `name`, and the `name` a `tools/call` names).
 *
 * The two names differ for the command-runner (`RunDeclaredCommand` is what a roster grants;
 * `run_declared_command` is what the server publishes) and coincide for Jira (`get_issue` is both). A
 * server is free to choose either convention; this shape carries both so a caller never has to guess
 * which one a given name is.
 */
export interface ToolServerDefinition<Tool extends string = string> {
  /** The domain this server is the one owner of (CAP-7): `'command-runner'`, `'jira'`, … */
  readonly domain: string;
  /** The `--mcp-config` key and the CLI's `mcp__<name>__` prefix. */
  readonly serverName: string;
  /** Grantable tool name, as a roster declares it, mapped to the name the server itself publishes. */
  readonly tools: Readonly<Record<Tool, string>>;
}

/** How each MCP grant is spelled in `--allowedTools`: the CLI's `mcp__<server>__<tool>` form. */
export const mcpToolCliName = (serverName: string, wireToolName: string): string =>
  `mcp__${serverName}__${wireToolName}`;

/**
 * The CLI spelling of every tool a server serves, keyed by the grantable name a roster declares.
 *
 * `src/contracts/installer.ts` spreads the result of this for each registered server into one lookup
 * (`MCP_TOOL_CLI_NAMES`), so a roster's grant translates to `--allowedTools` the same way regardless of
 * which server happens to serve it.
 */
export const mcpToolCliNamesFor = <Tool extends string>(
  server: ToolServerDefinition<Tool>,
): Readonly<Record<Tool, string>> => {
  const grantNames = Object.keys(server.tools) as Tool[];
  return Object.fromEntries(
    grantNames.map((grantName) => [grantName, mcpToolCliName(server.serverName, server.tools[grantName])]),
  ) as Record<Tool, string>;
};

/**
 * Which of a registry's servers a grant's tool names implicate, in the registry's own order.
 *
 * A step's grant may name tools from more than one server at once (matrix row 8: the command-runner
 * and Jira granted together), and each implicated server gets its own `--mcp-config` entry — never a
 * server the grant does not mention (row 3: an agent with no Jira grant gets no Jira server), and never
 * one server's tools attributed to another.
 */
export const serversForTools = <Tool extends string>(
  servers: readonly ToolServerDefinition<Tool>[],
  grantedToolNames: readonly string[],
): readonly ToolServerDefinition<Tool>[] =>
  servers.filter((server) =>
    (Object.keys(server.tools) as Tool[]).some((tool) => grantedToolNames.includes(tool)),
  );

/**
 * Merge any number of single-server `--mcp-config` objects — each shaped `{ mcpServers: { <name>: {…} } }`
 * — into the one file `--strict-mcp-config` reads.
 *
 * `--strict-mcp-config` admits exactly the servers named in the file the engine writes, so a step
 * granted both the command-runner and Jira needs one file naming both (matrix row 8) — never two
 * competing files, and never a later server's entry silently overwriting an earlier one under the same
 * name (which cannot happen here: each `ToolServerDefinition.serverName` is distinct by construction).
 */
export const mergeMcpServerConfigs = (
  configs: readonly Readonly<Record<string, unknown>>[],
): Readonly<Record<string, unknown>> => {
  const mcpServers: Record<string, unknown> = {};
  for (const config of configs) {
    const servers = config['mcpServers'];
    if (servers === null || typeof servers !== 'object') continue;
    Object.assign(mcpServers, servers);
  }
  return { mcpServers };
};
