/**
 * ADR-001 — matrix rows 12 and 13: the required-flag list is complete against the ADR's own enumeration,
 * and an argv missing `--tools` is named.
 *
 * Row 13 is "the case that returns empty today", and row 12 is why it did. `AD1_REQUIRED_FLAGS` named four
 * flags, two of which were `--json-schema` and `--output-format` — neither of them one of the four ADR-001
 * requires — so `missingRequiredFlags` answered "nothing is missing" on an argv that carried no grant at
 * all. A required-flag list that omits a required flag is a guard that reads as coverage while covering
 * less, and the only assertion that catches it is one against the *enumeration*, not against an argv the
 * same list built.
 *
 * So this suite holds ADR-001's four flags as a literal quoted from the decision, and checks the constant
 * against them. It deliberately does not derive one from the other.
 */
import { describe, expect, it } from 'vitest';

import {
  AgentDeclarationSchema,
  CURRENT_SCHEMA_VERSION,
  IMPLEMENTATION_CONTRACT_ID,
  dispositionFor,
  exportContract,
} from '../src/contracts/index.js';
import {
  AD1_REQUIRED_FLAGS,
  ADR001_REQUIRED_FLAGS,
  AddDirNotAbsolute,
  buildStepArgv,
  defaultPromptFor,
  grantFromRoster,
  missingRequiredFlags,
  toolsArgumentFor,
} from '../src/engine/index.js';
import type { DiscoveredRoster, StepStartRequest } from '../src/engine/index.js';
import { BUILT_IN_AGENTS } from '../src/installer/interview.js';

/**
 * ADR-001's Decision, item 1, quoted: "`--restricted` …, plus `--strict-mcp-config`, plus `--add-dir`
 * scoped to the run worktree, plus `--tools` naming exactly what that agent is granted."
 *
 * Written out here rather than imported, so the comparison is against the document and not against the
 * code's own idea of what the document says.
 */
const ADR_001_DECIDED_FLAGS = ['--restricted', '--strict-mcp-config', '--add-dir', '--tools'];

const argvWithGrant = (
  overrides: { readonly tools?: string; readonly addDir?: string } = {},
): readonly string[] =>
  buildStepArgv({
    schema: exportContract('step.analysis'),
    prompt: 'p',
    model: 'claude-haiku-4-5',
    tools: overrides.tools ?? 'Read,Grep,Glob',
    addDir: overrides.addDir ?? '/tmp/orch-run-worktree',
  });

/** The two ADR-001 flags that take a value, so removing one removes the value with it. */
const FLAGS_WITH_A_VALUE = new Set(['--add-dir', '--tools']);

/** An argv with one flag taken out, value included. What a wrapper dropping a flag would leave. */
const without = (argv: readonly string[], flag: string): readonly string[] => {
  const at = argv.indexOf(flag);
  if (at === -1) return [...argv];
  return [...argv.slice(0, at), ...argv.slice(at + (FLAGS_WITH_A_VALUE.has(flag) ? 2 : 1))];
};

describe('the required-flag list is complete against ADR-001 (matrix 12)', () => {
  it('contains every one of the four flags ADR-001 requires on every spawn', () => {
    for (const flag of ADR_001_DECIDED_FLAGS) {
      expect([...AD1_REQUIRED_FLAGS], `AD1_REQUIRED_FLAGS omits ${flag}`).toContain(flag);
    }
  });

  it('declares those four as its own constant, with nothing invented and nothing dropped', () => {
    expect([...ADR001_REQUIRED_FLAGS].sort()).toStrictEqual([...ADR_001_DECIDED_FLAGS].sort());
  });

  it('adds AD-1’s own two on top, and names nothing else', () => {
    expect([...AD1_REQUIRED_FLAGS].sort()).toStrictEqual(
      [...ADR_001_DECIDED_FLAGS, '--json-schema', '--output-format'].sort(),
    );
  });

  /**
   * The list before story 2-4, shown answering "the contract holds" for an argv with no grant.
   *
   * This is the defect itself, reproduced: the same `missingRequiredFlags` logic over the old list returns
   * empty for an argv carrying neither `--tools` nor `--add-dir`. Kept as a test so the completeness
   * assertion above has something concrete to be about.
   */
  it('would have reported an ungranted argv as complete, under the list it replaced', () => {
    const asShipped = ['--json-schema', '--output-format', '--strict-mcp-config', '--restricted'];
    const ungranted = without(without(argvWithGrant(), '--tools'), '--add-dir');

    expect(ungranted).not.toContain('--tools');
    expect(ungranted).not.toContain('--add-dir');
    expect(asShipped.filter((flag) => !ungranted.includes(flag))).toStrictEqual([]);
    // The list as it stands now names both of them.
    expect(missingRequiredFlags(ungranted)).toStrictEqual(['--add-dir', '--tools']);
  });
});

describe('an argv missing a required flag is named (matrix 13)', () => {
  it('names --tools, which is the case that returned empty', () => {
    const argv = argvWithGrant();
    expect(missingRequiredFlags(argv)).toStrictEqual([]);

    const withoutTools = without(argv, '--tools');
    expect(withoutTools).not.toContain('--tools');
    expect(missingRequiredFlags(withoutTools)).toStrictEqual(['--tools']);
  });

  it.each(ADR_001_DECIDED_FLAGS)('names %s when it is the one removed', (flag) => {
    expect(missingRequiredFlags(without(argvWithGrant(), flag))).toStrictEqual([flag]);
  });

  it('names several at once rather than stopping at the first', () => {
    const argv = ['--tools', '--add-dir', '--restricted'].reduce(without, argvWithGrant());
    expect([...missingRequiredFlags(argv)].sort()).toStrictEqual(
      ['--add-dir', '--restricted', '--tools'].sort(),
    );
  });
});

describe('the argv carries the grant it was built with', () => {
  it('puts the grant after --tools and the worktree after --add-dir', () => {
    const argv = argvWithGrant({ tools: 'Read,Write,Edit,Grep,Glob,Bash', addDir: '/tmp/a-worktree' });
    expect(argv[argv.indexOf('--tools') + 1]).toBe('Read,Write,Edit,Grep,Glob,Bash');
    expect(argv[argv.indexOf('--add-dir') + 1]).toBe('/tmp/a-worktree');
  });

  it('keeps --restricted, because --tools without it widens rather than narrows', () => {
    // `--tools` names what is available; `--restricted` is what removes everything else and ignores the
    // repository's own settings. Either alone is not the ADR-001 confinement.
    const argv = argvWithGrant();
    expect(argv).toContain('--restricted');
    expect(argv).toContain('--strict-mcp-config');
  });
});

/**
 * Matrix row 20 — either agent's prompt names the verbatim request, and no summary of it.
 *
 * architecture.md's re-grounding rule binds what the *agent* reads, so it is only satisfied if the prompt
 * sends the agent to the original words. The input file carries no summary field to read instead
 * (`tests/contracts.planning.test.ts` asserts that half), and the prompt does not invite one.
 */
describe('the prompt re-grounds the agent on the request itself (matrix 20)', () => {
  const requestFor = (phase: string, step: string): StepStartRequest =>
    ({
      run: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
      feature: 'grant-wiring',
      step,
      phase,
      contractId: `step.${phase}`,
      inputPath: '/tmp/run/steps/input.json',
    }) as unknown as StepStartRequest;

  it.each([
    ['analysis', 'analyse'],
    ['planning', 'plan'],
  ])('tells the %s agent to read the verbatim request in the input file', (phase, step) => {
    const prompt = defaultPromptFor(requestFor(phase, step));

    expect(prompt).toContain('/tmp/run/steps/input.json');
    expect(prompt).toContain('verbatim');
    expect(prompt).toContain('`request`');
    expect(prompt).toContain('never a summary of them');
    expect(prompt).toContain(`step.${phase}`);
    // Two attempts at one step are byte-identical invocations, which is what makes a re-run a re-run.
    expect(defaultPromptFor(requestFor(phase, step))).toBe(prompt);
  });
});

/**
 * Matrix 25 — a flag's presence is not its value.
 *
 * This is the guard this story added failing the same way the list it replaced did, one level down. The
 * AD-20 wrapper is free to rebuild `args`; one that keeps `--tools` while emptying it hands the agent a
 * grant nobody declared, and a check that asks only whether the *word* appears answers "the contract
 * holds" for exactly that argv.
 */
describe('a flag whose value was rewritten is named, not counted as present (matrix 25)', () => {
  /** What a wrapper does: keep the flag, change what follows it. */
  const rewrite = (argv: readonly string[], flag: string, value: string): readonly string[] => {
    const at = argv.indexOf(flag);
    return argv.map((argument, index) => (index === at + 1 ? value : argument));
  };

  it('names --tools when a wrapper empties its value', () => {
    const argv = rewrite(argvWithGrant({ tools: 'Read,Grep,Glob' }), '--tools', '');

    // The word is still there, which is all the presence-only check ever asked.
    expect(argv).toContain('--tools');
    expect(missingRequiredFlags(argv)).toStrictEqual([]);
    // Against the grant that was actually declared, it is missing.
    expect(missingRequiredFlags(argv, { tools: 'Read,Grep,Glob' })).toStrictEqual(['--tools']);
  });

  it('names --tools when a wrapper widens the grant instead of emptying it', () => {
    const argv = rewrite(argvWithGrant({ tools: 'Read,Grep,Glob' }), '--tools', 'Read,Write,Bash');
    expect(missingRequiredFlags(argv, { tools: 'Read,Grep,Glob' })).toStrictEqual(['--tools']);
  });

  it('names --add-dir when a wrapper points it somewhere else', () => {
    const argv = rewrite(argvWithGrant({ addDir: '/tmp/run-worktree' }), '--add-dir', '/');
    expect(missingRequiredFlags(argv, { addDir: '/tmp/run-worktree' })).toStrictEqual(['--add-dir']);
  });

  it('accepts the empty grant an empty declaration composes, which is a value and not an absence', () => {
    // ADR-003 does not grant nothing to anyone, but AD-17 lets a roster declare it, and the CLI spells
    // it `--tools ""`. The expected value is `''`, so the argv carrying `''` holds the contract — the
    // check is equality with what the grant composed, never "is it non-empty".
    const argv = argvWithGrant({ tools: '' });
    expect(argv[argv.indexOf('--tools') + 1]).toBe('');
    expect(missingRequiredFlags(argv, { tools: '' })).toStrictEqual([]);
    expect(missingRequiredFlags(argv, { tools: 'Read' })).toStrictEqual(['--tools']);
  });

  it('names a flag left at the very end of the vector with no value at all', () => {
    const argv = [...without(argvWithGrant(), '--tools'), '--tools'];
    expect(argv).toContain('--tools');
    expect(missingRequiredFlags(argv, { tools: 'Read,Grep,Glob' })).toStrictEqual(['--tools']);
  });
});

/**
 * Matrix 26 — `--add-dir` is the absolute run worktree or it is nothing.
 *
 * `request.worktree` reaches this flag unchecked, and an empty string is what an unset one arrives as.
 * Under `--restricted` this is half of what bounds the agent's file tools, so a wrong value is a widening
 * with no other observable difference — the same failure mode the flag list itself had.
 */
describe('the --add-dir value is checked, not merely passed on (matrix 26)', () => {
  it.each([
    ['', 'an unset worktree'],
    ['   ', 'whitespace'],
    ['worktrees/run-1', 'a relative path'],
    ['./worktrees/run-1', 'a path relative to somewhere the CLI chooses'],
  ])('refuses %j, which is %s', (addDir) => {
    expect(() =>
      buildStepArgv({
        schema: {},
        prompt: 'p',
        model: 'claude-haiku-4-5',
        tools: 'Read',
        addDir,
      }),
    ).toThrowError(AddDirNotAbsolute);
  });

  it('carries config.invalid, so a misconfigured worktree reaches a person rather than a retry', () => {
    const refusal = new AddDirNotAbsolute('');
    expect(refusal.code).toBe('config.invalid');
    expect(dispositionFor(refusal.code)).toBe('escalate-to-human');
  });

  it('accepts an absolute path, which is what a run worktree is', () => {
    const argv = argvWithGrant({ addDir: '/tmp/orch/worktrees/run-1' });
    expect(argv[argv.indexOf('--add-dir') + 1]).toBe('/tmp/orch/worktrees/run-1');
  });
});


/**
 * Matrix 18 — an implementation step spawned carries the declaration's grant, and no `Bash` in it.
 *
 * The argv is built the way a run builds it: the *built-in declaration* is parsed as a roster entry,
 * the grant is resolved from that roster, and `toolsArgumentFor` composes the flag's value. Nothing
 * here spells the grant twice — the expectation is a literal quoted from ADR-003-as-amended, so the
 * test compares the argv a declaration produced against the decision, never against itself.
 *
 * This is the end of ADR-004's change that a person can see: whatever the table says, the vector the
 * process receives is what actually bounds it.
 */
describe('an implementation spawn carries its declared grant, with no Bash (matrix 18)', () => {
  /** ADR-003 as ADR-004 amended it: the row for `implementation`, quoted. */
  const DECIDED_IMPLEMENTATION_GRANT = 'Read,Write,Edit,Grep,Glob';

  /** The built-in declaration, parsed as `.orch/agents/implementation.toml` would be read. */
  const declaredRoster = (agentId: string): DiscoveredRoster => {
    const declaration = AgentDeclarationSchema.parse({
      schema_version: CURRENT_SCHEMA_VERSION,
      ...BUILT_IN_AGENTS.find((agent) => agent.id === agentId),
    });
    return {
      agentsDir: '/nowhere/.orch/agents',
      agents: [{ id: agentId, path: `/nowhere/.orch/agents/${agentId}.toml`, declaration }],
      refused: [],
      summary: `one declaration, read as ${agentId}.toml would be`,
    };
  };

  it('puts the declared grant after --tools, and it is the one ADR-004 left', () => {
    const grant = grantFromRoster(declaredRoster('implementation'), 'implementation');
    const argv = buildStepArgv({
      schema: exportContract(IMPLEMENTATION_CONTRACT_ID),
      prompt: 'p',
      model: 'claude-haiku-4-5',
      tools: toolsArgumentFor(grant),
      addDir: '/tmp/orch/worktrees/run-1',
    });

    expect(argv[argv.indexOf('--tools') + 1]).toBe(DECIDED_IMPLEMENTATION_GRANT);
    expect(missingRequiredFlags(argv, { tools: DECIDED_IMPLEMENTATION_GRANT })).toStrictEqual([]);
  });

  it('carries no Bash anywhere in the vector the process receives', () => {
    const grant = grantFromRoster(declaredRoster('implementation'), 'implementation');
    const argv = buildStepArgv({
      schema: exportContract(IMPLEMENTATION_CONTRACT_ID),
      prompt: 'p',
      model: 'claude-haiku-4-5',
      tools: toolsArgumentFor(grant),
      addDir: '/tmp/orch/worktrees/run-1',
    });

    expect(grant.tools).not.toContain('Bash');
    // Not only the flag's value: the whole vector, because `Bash` reaching the process by any other
    // argument would be the same host shell ADR-004 removed.
    for (const argument of argv) expect(argument).not.toContain('Bash');
    // And it still grants something, so "no Bash" is not passing because the grant is empty.
    expect(grant.elevated).toStrictEqual(['Write', 'Edit']);
  });

  it('is the contract the roster declares that the spawn validates against', () => {
    const grant = grantFromRoster(declaredRoster('implementation'), 'implementation');
    const argv = buildStepArgv({
      schema: exportContract(IMPLEMENTATION_CONTRACT_ID),
      prompt: 'p',
      model: 'claude-haiku-4-5',
      tools: toolsArgumentFor(grant),
      addDir: '/tmp/orch/worktrees/run-1',
    });

    expect(JSON.parse(argv[argv.indexOf('--json-schema') + 1] ?? '')).toStrictEqual(
      exportContract(IMPLEMENTATION_CONTRACT_ID),
    );
    expect(IMPLEMENTATION_CONTRACT_ID).toBe('step.implementation');
  });
});
