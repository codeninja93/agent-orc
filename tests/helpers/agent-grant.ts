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
 */
import type { AgentGrant } from '../../src/engine/index.js';

export const fixtureGrant = (overrides: Partial<AgentGrant> = {}): AgentGrant => ({
  phase: 'implementation',
  agentId: 'implementation',
  declaredAt: '/nowhere/.orch/agents/implementation.toml',
  rosterDir: '/nowhere/.orch/agents',
  tools: ['Read', 'Write', 'Edit', 'Grep', 'Glob', 'Bash'],
  elevated: ['Write', 'Edit', 'Bash'],
  reversibility: 'recoverable',
  summary: 'a fixture grant, declared nowhere a run would read',
  ...overrides,
});
