/**
 * An {@link AgentGrant} for the suites whose subject is not the roster.
 *
 * `tests/engine.agents.test.ts` resolves a grant the way a run does — from a real `.orch/agents/*.toml`
 * through the AD-9 snapshot — because that path is what it is testing. The spawner and container suites are
 * about an argv and a container invocation, and building a snapshot for each of them would put the roster
 * in the way of what they assert.
 *
 * Every consumer of this helper asserts the argv against a **literal** string rather than against the
 * grant it passed in, so nothing here can make a test compare a value to itself.
 *
 * **It models a *user-defined* agent, and that is why it still grants `Bash`.** ADR-004 removed `Bash`
 * from every built-in, so no built-in has this shape any more — but `GRANTABLE_TOOLS` keeps the name
 * because AD-17 lets a person grant it to an agent of their own, and these suites exist partly to prove
 * that such a grant reaches `--tools` verbatim and is reported as elevated rather than silently
 * corrected. Keeping the shape under a built-in's id would have read as though the built-in roster still
 * granted a host shell, so the agent is named for what it is.
 */
import type { AgentGrant } from '../../src/engine/index.js';

export const fixtureGrant = (overrides: Partial<AgentGrant> = {}): AgentGrant => ({
  phase: 'implementation',
  agentId: 'my-own-implementer',
  declaredAt: '/nowhere/.orch/agents/my-own-implementer.toml',
  rosterDir: '/nowhere/.orch/agents',
  tools: ['Read', 'Write', 'Edit', 'Grep', 'Glob', 'Bash'],
  elevated: ['Write', 'Edit', 'Bash'],
  reversibility: 'recoverable',
  startTier: 'claude-haiku-4-5',
  summary: 'a user-defined agent’s grant, declared nowhere a run would read',
  ...overrides,
});
