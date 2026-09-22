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

import {
  AgentDeclarationSchema,
  GRANTABLE_TOOLS,
  getContract,
  isContractId,
} from '../src/contracts/index.js';
import { BUILT_IN_AGENTS } from '../src/installer/interview.js';

/**
 * The table ADR-003 fixes, and the contract each agent answers against. A row changing here is an
 * architecture change and should arrive as one.
 *
 * **The contract column is beside the grant because the two failed together.** Story 2-4 registered
 * `step.analysis` and `step.planning`, whose shapes pin `contract_id` to their own id — and the shipped
 * declarations still said `step.output`. The pairing could never both hold, so for a default install every
 * per-claim provenance, territory-containment and `files_read` refusal the new contracts added was dead
 * code, and nothing in the suite could notice: the grants were pinned and the contract ids were not. A
 * declaration references a registered contract id (AD-17), and which one is as much a decision as the
 * grant is.
 */
const DECLARED: Readonly<Record<string, { readonly tools: readonly string[]; readonly contract: string }>> = {
  analysis: { tools: ['Read', 'Grep', 'Glob'], contract: 'step.analysis' },
  planning: { tools: ['Read', 'Grep', 'Glob'], contract: 'step.planning' },
  implementation: {
    tools: ['Read', 'Write', 'Edit', 'Grep', 'Glob', 'Bash'],
    contract: 'step.output',
  },
  testing: { tools: ['Read', 'Write', 'Edit', 'Grep', 'Glob', 'Bash'], contract: 'step.output' },
  verification: { tools: ['Read', 'Grep', 'Glob', 'Bash'], contract: 'step.output' },
  committing: { tools: ['Read', 'Grep', 'Glob'], contract: 'step.output' },
};

const GRANTED: Readonly<Record<string, readonly string[]>> = Object.fromEntries(
  Object.entries(DECLARED).map(([id, row]) => [id, row.tools]),
);

describe('the built-in roster grants exactly what ADR-003 decided', () => {
  it('declares the six built-ins the table names, and no others', () => {
    expect(BUILT_IN_AGENTS.map((agent) => agent.id).sort()).toStrictEqual(Object.keys(GRANTED).sort());
  });

  it.each(Object.keys(GRANTED))('grants %s exactly its decided tools', (id) => {
    const agent = BUILT_IN_AGENTS.find((candidate) => candidate.id === id);
    expect(agent?.tools).toStrictEqual(GRANTED[id]);
  });

  it.each(Object.keys(DECLARED))('points %s at the contract its output is validated against', (id) => {
    const agent = BUILT_IN_AGENTS.find((candidate) => candidate.id === id);
    expect(agent?.contract).toBe(DECLARED[id]?.contract);
  });

  it('points every built-in at a registered contract, which is what AD-17 requires of a reference', () => {
    for (const agent of BUILT_IN_AGENTS) {
      expect(isContractId(agent.contract), `${agent.id} references ${agent.contract}`).toBe(true);
      expect(getContract(agent.contract).kind, agent.id).toBe('step');
    }
  });

  /**
   * The pairing that could never hold, asserted as a pairing rather than as two facts side by side.
   *
   * `step.analysis` and `step.planning` pin `contract_id` to their own id, so an output produced under a
   * declaration naming `step.output` fails its own contract at AD-1's re-parse — every time, for every
   * default install. A test that checked only "the id is registered" would pass on exactly that.
   */
  it.each(['analysis', 'planning'])(
    'gives %s a contract whose own pinned id is the one it declares',
    (id) => {
      const agent = BUILT_IN_AGENTS.find((candidate) => candidate.id === id);
      const declared = agent?.contract ?? '';
      const exported = getContract(declared).schema;
      const probe = exported.safeParse({
        contract_id: 'step.output',
        step: id,
        status: 'blocked',
        summary: 's',
        provenance: [],
        decisions: [],
        artifacts: [],
        questions: [],
        write_intents: [],
        error: null,
        claims: [],
        plan: [],
        territory: [],
        files_read: [],
      });
      expect(probe.success, `${id} accepted an output claiming step.output`).toBe(false);
    },
  );

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
