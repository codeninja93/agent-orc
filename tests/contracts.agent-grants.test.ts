/**
 * ADR-003, as amended by ADR-004 — the built-in roster's tool grants, pinned.
 *
 * ADR-001 made `--tools` load-bearing security configuration: a roster entry granting `Bash` grants the
 * ability to run commands, contained but real. Story 2-1 then shipped a roster with grants already in it,
 * so the question ADR-001 deferred was being answered by an implementation rather than decided — and the
 * answer it gave contradicted AD-15, granting `Bash` to the only irreversible agent in the table.
 *
 * Nothing asserted those grants. Changing `committing` from `['Read', 'Bash']` to `['Read', 'Grep', 'Glob']`
 * broke no test, which is how a security grant drifts without anyone reading a diff. These assertions are
 * the decision, written down where a change to it fails.
 *
 * **ADR-004 removed three rows' `Bash`, and a table edited until its tests pass is worth nothing.** The
 * pinned table below is a literal, so editing it moves the goalposts by definition. So the rules that
 * matter are asserted *against the rule* rather than against the table: no built-in is granted `Bash`
 * (asserted of `BUILT_IN_AGENTS` **and** of the table itself, so neither can be edited to re-admit it),
 * `verification` still has no `Write` or `Edit`, and `GRANTABLE_TOOLS` still contains `Bash` because
 * AD-17 lets a user-defined agent be granted anything the declared set contains. Those four hold
 * whatever the literal says.
 */
import { describe, expect, it } from 'vitest';

import {
  AgentDeclarationSchema,
  GRANTABLE_TOOLS,
  getContract,
  isContractId,
} from '../src/contracts/index.js';
import { READ_ONLY_TOOLS, isElevatedTool } from '../src/engine/index.js';
import { BUILT_IN_AGENTS } from '../src/installer/interview.js';
import { DeclaredCommandRequestSchema } from '../src/runner/index.js';

/**
 * The table ADR-003 fixes and ADR-004 amends, and the contract each agent answers against. A row changing
 * here is an architecture change and should arrive as one.
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
    tools: ['Read', 'Write', 'Edit', 'Grep', 'Glob'],
    contract: 'step.implementation',
  },
  /**
   * The two rows story 2-6 changed, and the change is ADR-004 finally being satisfiable.
   *
   * ADR-004 removed `Bash` from these two and named its replacement — "an MCP tool whose server runs
   * the command inside the container" — while saying plainly that until story 2-6 built it, "neither
   * has a tool that runs anything". `RunDeclaredCommand` is that tool, and it is a grant rather than
   * an implicit capability for the same reason every other grant is: AD-17 makes the roster the one
   * place that says what an agent may do, and a served tool nobody declared is one nobody reviewed.
   */
  testing: {
    tools: ['Read', 'Write', 'Edit', 'Grep', 'Glob', 'RunDeclaredCommand'],
    contract: 'step.testing',
  },
  verification: {
    tools: ['Read', 'Grep', 'Glob', 'RunDeclaredCommand'],
    contract: 'step.verification',
  },
  committing: { tools: ['Read', 'Grep', 'Glob'], contract: 'step.output' },
};

const GRANTED: Readonly<Record<string, readonly string[]>> = Object.fromEntries(
  Object.entries(DECLARED).map(([id, row]) => [id, row.tools]),
);

describe('the built-in roster grants exactly what ADR-003 decided, as ADR-004 amended it', () => {
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
  it.each(['analysis', 'planning', 'implementation', 'testing', 'verification'])(
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
        changes: [],
        territory: [],
        files_read: [],
        tests: [],
        gates: [],
        judgements: [],
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

  /**
   * The row that survives ADR-004 unchanged in substance, and the one this suite must not have got
   * weaker at. `verification` lost `Bash` with the other two; what it never had, and must never have,
   * is a way to change the thing it is judging — which is ADR-003's whole reason for separating it
   * from `testing`.
   */
  it('gives verification no way to edit what it judges', () => {
    const verification = BUILT_IN_AGENTS.find((agent) => agent.id === 'verification');
    expect(verification, 'verification is declared').toBeDefined();
    expect(verification?.tools).not.toContain('Write');
    expect(verification?.tools).not.toContain('Edit');
    // And the tool story 2-6 added is not a way round it (matrix 23): the command runner takes the
    // *name* of a command the profile declares and has no parameter a path could be named in, so a
    // gate this agent can run is not a file it can write.
    expect(DeclaredCommandRequestSchema.safeParse({ command: 'test', path: 'x' }).success).toBe(false);
    expect(Object.keys(DeclaredCommandRequestSchema.shape)).toStrictEqual(['command']);
    // `testing` is the comparison that makes the assertion mean something: the two differ on exactly
    // these two names, so a suite that had stopped distinguishing them would fail here.
    const testing = BUILT_IN_AGENTS.find((agent) => agent.id === 'testing');
    expect(testing?.tools).toContain('Write');
    expect(testing?.tools).toContain('Edit');
  });

  /**
   * ADR-004, matrix row 4 — measured against every declaration, not against the table above.
   *
   * A grant of `Bash` is a *host* shell: the agent process runs on the host per ADR-001, and CLI
   * 2.1.278 offers approve-or-deny through a permission tool with no way to relocate a tool use into a
   * container. So the containment AD-20 describes never applies to it, and no built-in may hold it.
   */
  it('grants no built-in Bash, because a granted Bash is an uncontained host shell (ADR-004)', () => {
    for (const agent of BUILT_IN_AGENTS) {
      expect(agent.tools, `${agent.id} is granted Bash`).not.toContain('Bash');
    }
  });

  /**
   * And the same rule applied to the pinned table itself, so the table cannot be edited until the
   * tests pass again.
   *
   * Without this, re-admitting `Bash` to a built-in is two edits — the declaration and the row — and
   * the suite reports the roster as decided. The rule is the authority; the literal is only its record.
   */
  it('holds the pinned table to the same rule, so re-admitting Bash to a row fails here too', () => {
    for (const [id, row] of Object.entries(DECLARED)) {
      expect(row.tools, `the pinned row for ${id} grants Bash`).not.toContain('Bash');
    }
  });

  /**
   * Matrix 24 — the two purposes describe what these agents can now actually do.
   *
   * ADR-004 left both promising to "run" with no tool that ran anything, and said so in as many
   * words: "both purpose strings promise to run … the replacement arrives with story 2-6". A purpose
   * that describes a capability the declaration does not grant is the roster lying about itself, and
   * it is the first thing a person reads about an agent.
   */
  it('describes what testing and verification can now actually do', () => {
    const testing = BUILT_IN_AGENTS.find((agent) => agent.id === 'testing');
    const verification = BUILT_IN_AGENTS.find((agent) => agent.id === 'verification');
    // Testing writes tests and runs them, and now holds the tool that runs one.
    expect(testing?.purpose.toLowerCase()).toContain('run');
    expect(testing?.tools).toContain('RunDeclaredCommand');
    // Verification's job is the judgement CAP-13 puts *after* the gates, and its purpose says so
    // rather than describing the gates as the whole of it.
    expect(verification?.purpose.toLowerCase()).toContain('acceptance criteria');
    expect(verification?.purpose.toLowerCase()).toContain('gates');
    expect(verification?.tools).toContain('RunDeclaredCommand');
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

  /**
   * Matrix rows 5 and 6 — the two lists do different jobs, and ADR-004 changed only one of them.
   *
   * `GRANTABLE_TOOLS` is the declared *vocabulary*: what a roster entry may name at all. The built-in
   * table is a *decision* about six particular agents. AD-17 makes the roster declarative and question
   * 11 of the interview asks a person for their own agent's grant directly, so removing `Bash` from the
   * vocabulary would refuse a declaration ADR-004 explicitly keeps legal — and would do it at parse,
   * where a person reads "not a declared name" rather than "this gives you a host shell".
   *
   * What makes that safe is the reporting rather than the refusal: `isElevatedTool` classifies from the
   * tool name alone, so the grant is named as elevated on the spawn event. `tests/engine.agents.test.ts`
   * carries the argv end of it — a user-defined agent granting `Bash` reaches `--tools` with `Bash` in
   * it and `AgentGrant.elevated` says so, never silently corrected.
   */
  it('keeps Bash in the vocabulary, and reports a user-defined agent granting it as elevated', () => {
    expect(GRANTABLE_TOOLS).toContain('Bash');

    const userDefined = {
      schema_version: 1,
      id: 'my-own-agent',
      purpose: 'a roster entry a person declared for themselves',
      contract: 'step.output',
      tools: ['Read', 'Bash'],
      mcp_domains: [],
      reversibility: 'recoverable',
      model: { start_tier: 'claude-sonnet-5', promotion_policy: 'on-gate-failure' },
    };
    const parsed = AgentDeclarationSchema.safeParse(userDefined);
    expect(parsed.success, 'AD-17 lets a person grant their own agent anything the set declares').toBe(
      true,
    );
    // Accepted, and not accepted quietly: the name classifies as one that can change something.
    expect(isElevatedTool('Bash')).toBe(true);
    expect(READ_ONLY_TOOLS).not.toContain('Bash');
  });
});
