/**
 * AD-17 / ADR-001 — matrix rows 9, 10 and 11: the grant reaches `--tools` from the roster, a phase with no
 * declaration is refused, and a roster that disagrees with ADR-003 is obeyed and reported.
 *
 * **The fixture roster grants something ADR-003's table never would.** `analysis` is declared here with
 * `Glob, Read` — two of ADR-003's three, in the wrong order — so "the argv carries what the roster says"
 * and "the argv carries what ADR-003 says" are different sentences and the assertions can tell them apart.
 * A fixture granting exactly `Read, Grep, Glob` would pass whether the value came from the declaration or
 * from a table compiled into the engine, which is the shape of test that proves nothing.
 *
 * **The last describe is a guard by shape, not by name.** Story 2-3's guard in `tests/engine.roster.test.ts`
 * matches import specifiers and the two literals `BUILT_IN_AGENTS`/`BUILT_IN_AGENT_IDS`; a fresh
 * `phase → tools` table under any other name walks straight past it. So this one looks for the *structure* —
 * an agent id sitting next to a granted tool name in code — and proves it catches one by planting the
 * violation in a fixture tree, in three of the forms it would plausibly take, and by showing the story 2-3
 * guard finding nothing in the same tree.
 */
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { CURRENT_SCHEMA_VERSION, GRANTABLE_TOOLS, exportContract } from '../src/contracts/index.js';
import {
  AgentGrantUnresolved,
  buildStepArgv,
  discoverRoster,
  grantFromRoster,
  isElevatedTool,
  missingRequiredFlags,
  projectConfiguration,
  READ_ONLY_TOOLS,
  resolveAgentGrant,
  snapshotConfiguration,
  takeConfigSnapshot,
  toolsArgumentFor,
} from '../src/engine/index.js';

import {
  fixtureAgent,
  fixtureProfile,
  makeWorkspace,
  writeAgentFile,
  writeProfile,
} from './helpers/config-fixture.js';

/**
 * ADR-003's table, as the ADR states it, for the *comparison* — never as a source for the argv.
 *
 * `tests/contracts.agent-grants.test.ts` is where this table is pinned against the installer's built-in
 * roster. It is repeated here only so row 11 can say "the declaration differs from ADR-003 and the
 * declaration wins", which needs both halves in view.
 */
const ADR_003_GRANT: Readonly<Record<string, readonly string[]>> = {
  analysis: ['Read', 'Grep', 'Glob'],
  planning: ['Read', 'Grep', 'Glob'],
};

const workspaces: string[] = [];
const homes: string[] = [];

afterAll(() => {
  for (const path of [...workspaces, ...homes]) rmSync(path, { recursive: true, force: true });
});

/** A repository with a profile and whichever agent declarations a case needs. */
const repositoryWith = (
  agents: readonly { readonly id: string; readonly tools: readonly string[] }[],
): string => {
  const repository = makeWorkspace('agents');
  workspaces.push(repository);
  writeProfile(repository, fixtureProfile());
  for (const agent of agents) {
    writeAgentFile(
      repository,
      `${agent.id}.toml`,
      fixtureAgent({
        schema_version: CURRENT_SCHEMA_VERSION,
        id: agent.id,
        tools: [...agent.tools] as never,
      }),
    );
  }
  return repository;
};

/** A run whose AD-9 snapshot holds that repository's roster, which is the only thing a step reads. */
const runWithSnapshot = (repository: string): { readonly run: string; readonly orchHome: string } => {
  const orchHome = makeWorkspace('agents-home');
  homes.push(orchHome);
  const run = '01JAGENTS0000000000000000A';
  takeConfigSnapshot({ repository, runId: run, orchHome });
  return { run, orchHome };
};

describe('the grant reaches --tools from the roster (matrix 9)', () => {
  it('carries exactly what the declaration grants, in the order it declares it', () => {
    // Visibly not ADR-003's row: two tools, reversed. If this came from a table, it would read
    // "Read,Grep,Glob" and the assertion below would fail.
    const repository = repositoryWith([{ id: 'analysis', tools: ['Glob', 'Read'] }]);
    const { run, orchHome } = runWithSnapshot(repository);

    const grant = resolveAgentGrant({ run, phase: 'analysis', orchHome });

    expect(grant.agentId).toBe('analysis');
    expect(grant.tools).toStrictEqual(['Glob', 'Read']);
    expect(toolsArgumentFor(grant)).toBe('Glob,Read');
    expect(toolsArgumentFor(grant)).not.toBe(ADR_003_GRANT['analysis']?.join(','));
    expect(grant.declaredAt).toBe(join(orchHome, 'runs', run, 'config', 'agents', 'analysis.toml'));
    // AD-9: the grant is read from the run snapshot, not from the repository it was copied from.
    expect(grant.rosterDir).toBe(snapshotConfiguration(run, { orchHome }).agentsDir);
    expect(grant.rosterDir).not.toBe(projectConfiguration(repository).agentsDir);
  });

  it('builds an argv carrying --tools Read,Grep,Glob and --add-dir scoped to the run worktree', () => {
    const repository = repositoryWith([
      { id: 'analysis', tools: ADR_003_GRANT['analysis'] ?? [] },
      { id: 'planning', tools: ADR_003_GRANT['planning'] ?? [] },
    ]);
    const { run, orchHome } = runWithSnapshot(repository);
    const worktree = join(orchHome, 'worktrees', run);

    for (const phase of ['analysis', 'planning']) {
      const grant = resolveAgentGrant({ run, phase, orchHome });
      const argv = buildStepArgv({
        schema: exportContract('step.analysis'),
        prompt: 'p',
        model: 'claude-haiku-4-5',
        tools: toolsArgumentFor(grant),
        addDir: worktree,
      });

      expect(argv[argv.indexOf('--tools') + 1], phase).toBe('Read,Grep,Glob');
      expect(argv[argv.indexOf('--add-dir') + 1], phase).toBe(worktree);
      expect(missingRequiredFlags(argv), phase).toStrictEqual([]);
      // ADR-003's reason for this row: there is no tool in the grant with which to cause a side effect,
      // which is what makes these two agents pure functions rather than well-behaved ones.
      expect(grant.elevated, phase).toStrictEqual([]);
    }
  });

  it('passes the CLI’s own empty value for a declaration that grants nothing, and says so', () => {
    const repository = repositoryWith([{ id: 'analysis', tools: [] }]);
    const { run, orchHome } = runWithSnapshot(repository);

    const grant = resolveAgentGrant({ run, phase: 'analysis', orchHome });

    expect(toolsArgumentFor(grant)).toBe('');
    expect(grant.summary).toContain('no tools at all');
    const argv = buildStepArgv({
      schema: {},
      prompt: 'p',
      model: 'claude-haiku-4-5',
      tools: toolsArgumentFor(grant),
      addDir: '/tmp/worktree',
    });
    // The flag is still there — `--tools ""` is the CLI's documented "disable all tools", and a grant of
    // nothing is a declaration to obey rather than one to correct.
    expect(missingRequiredFlags(argv)).toStrictEqual([]);
    expect(argv[argv.indexOf('--tools') + 1]).toBe('');
  });
});

describe('a phase with no roster entry is refused, never defaulted (matrix 10)', () => {
  it('names the phase, the directory read and what was declared there', () => {
    const repository = repositoryWith([{ id: 'analysis', tools: ['Read'] }]);
    const { run, orchHome } = runWithSnapshot(repository);

    let thrown: unknown;
    try {
      resolveAgentGrant({ run, phase: 'planning', orchHome });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AgentGrantUnresolved);
    const refusal = thrown as AgentGrantUnresolved;
    expect(refusal.phase).toBe('planning');
    expect(refusal.message).toContain('planning');
    expect(refusal.message).toContain(snapshotConfiguration(run, { orchHome }).agentsDir);
    expect(refusal.message).toContain('analysis');
    // AD-35: `escalate-to-human`. Nothing retries its way out of a roster that declares no such agent.
    expect(refusal.code).toBe('config.invalid');
  });

  it('refuses an empty roster rather than inventing the six built-ins', () => {
    const repository = repositoryWith([]);
    const { run, orchHome } = runWithSnapshot(repository);
    for (const phase of ['analysis', 'planning', 'implementation', 'verification']) {
      expect(() => resolveAgentGrant({ run, phase, orchHome }), phase).toThrowError(
        AgentGrantUnresolved,
      );
    }
  });

  it('refuses the phase whose declaration failed to load, rather than reaching past it', () => {
    const repository = repositoryWith([{ id: 'analysis', tools: ['Read'] }]);
    // A hand-edited file the schema refuses: the roster reports it, and the phase still has no grant.
    writeFileSync(
      join(repository, '.orch', 'agents', 'planning.toml'),
      'schema_version = 1\nid = "planning"\ntools = ["Bsah"]\n',
      'utf8',
    );
    const { run, orchHome } = runWithSnapshot(repository);
    const roster = discoverRoster(snapshotConfiguration(run, { orchHome }));
    expect(roster.refused.map((entry) => entry.path).join(',')).toContain('planning.toml');

    let thrown: unknown;
    try {
      grantFromRoster(roster, 'planning');
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(AgentGrantUnresolved);
    // The refusal points at the file, which is the difference between "no such agent" and "that agent's
    // declaration does not load".
    expect((thrown as AgentGrantUnresolved).message).toContain('planning.toml');
  });
});

describe('the roster is authoritative where it disagrees with ADR-003 (matrix 11)', () => {
  it('passes Write to analysis because the declaration grants it, and reports the divergence', () => {
    const repository = repositoryWith([{ id: 'analysis', tools: ['Read', 'Grep', 'Glob', 'Write'] }]);
    const { run, orchHome } = runWithSnapshot(repository);

    const grant = resolveAgentGrant({ run, phase: 'analysis', orchHome });
    const argv = buildStepArgv({
      schema: {},
      prompt: 'p',
      model: 'claude-haiku-4-5',
      tools: toolsArgumentFor(grant),
      addDir: '/tmp/worktree',
    });

    // Obeyed: the argv carries what the file says, so the declaration is not a lie.
    expect(argv[argv.indexOf('--tools') + 1]).toBe('Read,Grep,Glob,Write');
    expect(grant.tools).toContain('Write');
    // Not silently corrected to ADR-003's row.
    expect(grant.tools).not.toStrictEqual(ADR_003_GRANT['analysis']);
    // Reported: `elevated` names what this agent was handed the means to do, which for an agent ADR-003
    // grants read tools is the divergence itself. The engine cannot hold ADR-003's table — AD-17 forbids
    // exactly that — so what it reports is the property of the grant, not a comparison to a table.
    expect(grant.elevated).toStrictEqual(['Write']);
    expect(grant.summary).toContain('Write');
    expect(grant.summary).toContain('can change something');
  });

  it('reports a grant of Bash to a reversible agent as elevated too', () => {
    const repository = repositoryWith([{ id: 'planning', tools: ['Read', 'Bash'] }]);
    const { run, orchHome } = runWithSnapshot(repository);
    const grant = resolveAgentGrant({ run, phase: 'planning', orchHome });
    expect(grant.elevated).toStrictEqual(['Bash']);
    expect(grant.reversibility).toBe('reversible');
  });

  it('classifies every declared tool name, so a new one is elevated until somebody decides', () => {
    for (const tool of GRANTABLE_TOOLS) {
      expect(isElevatedTool(tool), tool).toBe(!READ_ONLY_TOOLS.includes(tool));
    }
    expect([...READ_ONLY_TOOLS]).toStrictEqual(['Read', 'Grep', 'Glob']);
    // Keyed by tool, never by agent: this list names no phase and no agent id, which is what keeps it
    // from being the compiled-in roster AD-17 forbids.
    expect(READ_ONLY_TOOLS.every((tool) => (GRANTABLE_TOOLS as readonly string[]).includes(tool))).toBe(
      true,
    );
  });
});

/**
 * Matrix 10's other half, as a guard: no `phase → tools` table exists anywhere under `src/engine/`.
 *
 * The check is deliberately about *proximity of two vocabularies* rather than about a name. Any structure
 * that maps an agent id to a granted tool — an object literal, a `Map`, a `switch` — puts one next to the
 * other in the source, and none of them can be written without doing so.
 */
describe('the engine holds no compiled-in grant table', () => {
  const engineDir = new URL('../src/engine/', import.meta.url);
  const srcDir = new URL('../src/', import.meta.url);

  /**
   * The one directory a grant table legitimately lives in.
   *
   * `src/installer/` *is* the built-in roster — `BUILT_IN_AGENTS` pairs each agent with its tools, which
   * is the template the installer writes into `.orch/agents/`. AD-17 permits exactly that and forbids the
   * engine reading it; story 2-3's import guard is what keeps the second half true. Everything else under
   * `src/` is scanned, because a table in `src/contracts/` or `src/runtime/` would be as much a
   * compiled-in roster as one in `src/engine/`, and scanning only the engine would have missed it.
   */
  const ALLOWED_TO_HOLD_A_GRANT_TABLE = 'installer/';

  const listSources = (dir: URL, prefix = ''): string[] =>
    readdirSync(dir, { withFileTypes: true, encoding: 'utf8' }).flatMap((entry) =>
      entry.isDirectory()
        ? listSources(new URL(`${entry.name}/`, dir), `${prefix}${entry.name}/`)
        : entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')
          ? [`${prefix}${entry.name}`]
          : [],
    );

  /**
   * Comments are stripped before the check, for the reason story 2-3's guard strips them: this very file's
   * subject is explained in prose in `src/engine/agents.ts`, and a guard that read an explanation as a
   * violation would be unusable — so the claim is about code and the check is about code.
   */
  const codeOf = (source: string): string =>
    source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      // Both forms: a comment on its own line, and one trailing code. The first version matched only the
      // first, so `const tools = [];  // analysis gets Read, Grep, Glob` stayed in the text the check
      // read — a comment counted as a violation, which is the direction that makes a guard unusable and
      // then removed.
      .replace(/^[ \t]*\/\/.*$/gm, '')
      .replace(/(^|[^:'"\`\\])\/\/.*$/gm, '$1');

  /** The six the built-in roster declares, which are also the phase names. */
  const AGENT_IDS = ['analysis', 'planning', 'implementation', 'testing', 'verification', 'committing'];

  /**
   * How far apart an agent id and a tool name may be before they are not a table entry.
   *
   * Wide enough to span a formatted row — `analysis: ['Read', 'Grep', 'Glob'],` on three lines — and
   * narrow enough that two unrelated mentions in one file are not read as one.
   */
  const WINDOW = 220;

  const grantTableViolationsIn = (dir: URL, files: readonly string[]): string[] => {
    const found: string[] = [];
    const idPattern = new RegExp(`['"\`]?\\b(${AGENT_IDS.join('|')})\\b['"\`]?`, 'g');
    const toolPattern = new RegExp(`['"\`](${GRANTABLE_TOOLS.join('|')})['"\`]`);
    for (const file of files) {
      const code = codeOf(readFileSync(new URL(file, dir), 'utf8'));
      for (const match of code.matchAll(idPattern)) {
        const at = match.index;
        const window = code.slice(Math.max(0, at - WINDOW), at + WINDOW);
        const tool = toolPattern.exec(window);
        if (tool !== null) {
          found.push(`${file}: "${match[1] ?? ''}" sits beside the granted tool "${tool[1] ?? ''}"`);
        }
      }
    }
    return found;
  };

  const files = listSources(engineDir);

  it('has source files to inspect, including the module that resolves a grant', () => {
    expect(files.length).toBeGreaterThan(0);
    expect(files).toContain('agents.ts');
    expect(files).toContain('spawner.ts');
  });

  it('finds no agent id sitting beside a granted tool name under src/engine/', () => {
    expect(grantTableViolationsIn(engineDir, files)).toStrictEqual([]);
  });

  it('finds none anywhere else under src/ either, the installer\u2019s own roster excepted', () => {
    const everywhere = listSources(srcDir).filter(
      (file) => !file.startsWith(ALLOWED_TO_HOLD_A_GRANT_TABLE),
    );
    expect(everywhere.length).toBeGreaterThan(files.length);
    expect(grantTableViolationsIn(srcDir, everywhere)).toStrictEqual([]);
  });

  it('would find the installer\u2019s own table, so the exemption is doing work and not hiding nothing', () => {
    const installerFiles = listSources(srcDir).filter((file) =>
      file.startsWith(ALLOWED_TO_HOLD_A_GRANT_TABLE),
    );
    expect(grantTableViolationsIn(srcDir, installerFiles).length).toBeGreaterThan(0);
  });

  it.each([
    [
      'an object literal',
      "export const PHASE_TOOLS = {\n  analysis: ['Read', 'Grep', 'Glob'],\n  implementation: ['Read', 'Write', 'Edit', 'Bash'],\n};\n",
    ],
    [
      'a Map',
      "export const grants = new Map([\n  ['planning', ['Read', 'Grep', 'Glob']],\n]);\n",
    ],
    [
      'a switch',
      "export const toolsFor = (phase: string): string[] => {\n  switch (phase) {\n    case 'verification':\n      return ['Read', 'Bash'];\n    default:\n      return ['Read'];\n  }\n};\n",
    ],
  ])('catches a hardcoded grant table written as %s', (_form, source) => {
    const fixture = makeWorkspace('grant-guard');
    workspaces.push(fixture);
    const nested = join(fixture, 'nested');
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(fixture, 'clean.ts'), "import { runPaths } from '../runtime/index.js';\n", 'utf8');
    writeFileSync(join(nested, 'grants.ts'), source, 'utf8');
    const fixtureDir = new URL(`file://${fixture}/`);

    const violations = grantTableViolationsIn(fixtureDir, listSources(fixtureDir));

    expect(violations.length).toBeGreaterThan(0);
    expect(violations.every((entry) => entry.startsWith('nested/grants.ts'))).toBe(true);
  });

  /**
   * Why this guard had to be written at all: the one story 2-3 shipped sees nothing here.
   *
   * It matches import specifiers and the two names the installer exports, and a fresh table under a new
   * name imports nothing and names neither — so it passes, and passing it would have proved nothing about
   * this story.
   */
  it('catches what the story 2-3 import guard walks past', () => {
    const fixture = makeWorkspace('grant-guard-vs-2-3');
    workspaces.push(fixture);
    writeFileSync(
      join(fixture, 'grants.ts'),
      "export const PHASE_TOOLS = { analysis: ['Read', 'Grep', 'Glob'] };\n",
      'utf8',
    );
    const fixtureDir = new URL(`file://${fixture}/`);
    const code = codeOf(readFileSync(new URL('grants.ts', fixtureDir), 'utf8'));

    // The story 2-3 rule, restated: an installer import, or one of the two exported names.
    const storyTwoThreeFinds =
      /from\s*['"][^'"]*installer[^'"]*['"]/.test(code) ||
      code.includes('BUILT_IN_AGENTS') ||
      code.includes('BUILT_IN_AGENT_IDS');
    expect(storyTwoThreeFinds).toBe(false);

    expect(grantTableViolationsIn(fixtureDir, listSources(fixtureDir)).length).toBeGreaterThan(0);
  });

  it('does not fire on a file that names agents without granting them anything', () => {
    const fixture = makeWorkspace('grant-guard-clean');
    workspaces.push(fixture);
    writeFileSync(
      join(fixture, 'phases.ts'),
      "export const isVerification = (phase: string): boolean => phase === 'verification';\n",
      'utf8',
    );
    const fixtureDir = new URL(`file://${fixture}/`);
    expect(grantTableViolationsIn(fixtureDir, listSources(fixtureDir))).toStrictEqual([]);
  });
});
