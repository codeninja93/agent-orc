/**
 * ADR-003 — the built-in roster's tool grants, pinned.
 *
 * ADR-001 made `--tools` load-bearing security configuration: a roster entry granting `Bash` grants the
 * ability to run commands, contained but real. Story 2-1 then shipped a roster with grants already in it,
 * so the question ADR-001 deferred was being answered by an implementation rather than decided — and the
 * answer it gave contradicted AD-15, granting `Bash` to the only irreversible agent in the table.
 *
 * Nothing asserted those grants. Changing `committing` from `['Read', 'Bash']` to `['Read', 'Grep', 'Glob']`
 * broke no test, which is how a security grant drifts without anyone reading a diff. These assertions are
 * the decision, written down where a change to it fails.
 */
import { describe, expect, it } from 'vitest';

import { AgentDeclarationSchema, GRANTABLE_TOOLS } from '../src/contracts/index.js';
import { BUILT_IN_AGENTS } from '../src/installer/interview.js';

/** The table ADR-003 fixes. A row changing here is an architecture change and should arrive as one. */
const GRANTED: Readonly<Record<string, readonly string[]>> = {
  analysis: ['Read', 'Grep', 'Glob'],
  planning: ['Read', 'Grep', 'Glob'],
  implementation: ['Read', 'Write', 'Edit', 'Grep', 'Glob', 'Bash'],
  testing: ['Read', 'Write', 'Edit', 'Grep', 'Glob', 'Bash'],
  verification: ['Read', 'Grep', 'Glob', 'Bash'],
  committing: ['Read', 'Grep', 'Glob'],
};

describe('the built-in roster grants exactly what ADR-003 decided', () => {
  it('declares the six built-ins the table names, and no others', () => {
    expect(BUILT_IN_AGENTS.map((agent) => agent.id).sort()).toStrictEqual(Object.keys(GRANTED).sort());
  });

  it.each(Object.keys(GRANTED))('grants %s exactly its decided tools', (id) => {
    const agent = BUILT_IN_AGENTS.find((candidate) => candidate.id === id);
    expect(agent?.tools).toStrictEqual(GRANTED[id]);
  });

  /**
   * The row this test exists for. AD-15 makes pull-request creation, `git push`, notes and tags
   * engine-executed write intents that no agent may perform, and names the committer while doing it.
   */
  it('gives the committer no way to perform the write AD-15 reserves to the engine', () => {
    const committing = BUILT_IN_AGENTS.find((agent) => agent.id === 'committing');
    expect(committing?.reversibility).toBe('irreversible');
    expect(committing?.tools).not.toContain('Bash');
    expect(committing?.purpose.toLowerCase()).toContain('compose');
  });

  it('gives verification no way to edit what it judges', () => {
    const verification = BUILT_IN_AGENTS.find((agent) => agent.id === 'verification');
    expect(verification?.tools).toContain('Bash');
    expect(verification?.tools).not.toContain('Write');
    expect(verification?.tools).not.toContain('Edit');
  });

  it('grants no built-in the tools ADR-003 withholds from every one of them', () => {
    for (const agent of BUILT_IN_AGENTS) {
      for (const withheld of ['Task', 'WebFetch', 'WebSearch']) {
        expect(agent.tools, agent.id).not.toContain(withheld);
      }
    }
  });
});

describe('a granted tool name must be a declared name', () => {
  it('refuses a name the vocabulary does not declare, rather than granting nothing quietly', () => {
    const declaration = {
      schema_version: 1,
      id: 'typo',
      purpose: 'a roster entry with a mistyped grant',
      contract: 'step.output',
      tools: ['Read', 'Bsah'],
      mcp_domains: [],
      reversibility: 'reversible',
      model: { start_tier: 'claude-sonnet-5', promotion_policy: 'never' },
    };
    const parsed = AgentDeclarationSchema.safeParse(declaration);
    expect(parsed.success).toBe(false);
  });

  it('accepts every name it declares, so the vocabulary and the table cannot disagree', () => {
    for (const agent of BUILT_IN_AGENTS) {
      for (const tool of agent.tools) expect(GRANTABLE_TOOLS).toContain(tool);
    }
  });
});
