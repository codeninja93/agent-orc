/**
 * AD-17, matrix rows 11–16 — the roster is discovered by reading a directory, and the engine holds no
 * list of its own.
 *
 * The last row is a guard over imports, in the shape stage 1 used for `src/tui/`, and it is **recursive
 * from the start**. That guard's first version used a flat `readdirSync` and stopped covering seven of
 * sixteen files the moment a subdirectory appeared — while still reading, in the test output, as
 * coverage. `src/engine/` has no subdirectory today, so recursion cannot be demonstrated against the real
 * tree; it is demonstrated against a fixture tree that has one, with the flat listing shown failing to
 * see the same violation. A guard that shrinks as the tree grows is worse than none.
 */
import { chmodSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { CONTRACT_IDS, CURRENT_SCHEMA_VERSION } from '../src/contracts/index.js';
import { discoverRoster, projectConfiguration, rosterAgent } from '../src/engine/index.js';
import { BUILT_IN_AGENTS, BUILT_IN_AGENT_IDS } from '../src/installer/interview.js';

import {
  fixtureAgent,
  fixtureProfile,
  makeEmptyAgentsDir,
  makeWorkspace,
  writeAgentFile,
  writeProfile,
} from './helpers/config-fixture.js';

const workspaces: string[] = [];

const workspace = (label = 'roster'): string => {
  const created = makeWorkspace(label);
  workspaces.push(created);
  return created;
};

afterAll(() => {
  for (const path of workspaces) rmSync(path, { recursive: true, force: true });
});

/** A repository with `.orch/profile.toml` and whichever agent files a case needs. */
const installed = (): string => {
  const repository = workspace();
  writeProfile(repository, fixtureProfile());
  return repository;
};

describe('exactly the agents on disk, in a deterministic order (matrix 11)', () => {
  it('discovers the three declared agents and nothing else', () => {
    const repository = installed();
    for (const id of ['verification', 'analysis', 'planning']) {
      writeAgentFile(repository, `${id}.toml`, fixtureAgent({ id }));
    }

    const roster = discoverRoster(projectConfiguration(repository));

    expect(roster.agents.map((entry) => entry.id)).toStrictEqual([
      'analysis',
      'planning',
      'verification',
    ]);
    expect(roster.refused).toStrictEqual([]);
    expect(roster.summary).toContain('3 agents declared');
  });

  it('orders by id whatever order the files were written in, so two machines agree', () => {
    const first = installed();
    const second = installed();
    for (const id of ['zeta', 'alpha', 'mid']) writeAgentFile(first, `${id}.toml`, fixtureAgent({ id }));
    for (const id of ['mid', 'zeta', 'alpha']) writeAgentFile(second, `${id}.toml`, fixtureAgent({ id }));

    expect(discoverRoster(projectConfiguration(first)).agents.map((entry) => entry.id)).toStrictEqual(
      discoverRoster(projectConfiguration(second)).agents.map((entry) => entry.id),
    );
    expect(discoverRoster(projectConfiguration(first)).agents.map((entry) => entry.id)).toStrictEqual([
      'alpha',
      'mid',
      'zeta',
    ]);
  });

  it('carries each declaration whole, with the grant ADR-003 fixed and the file it came from', () => {
    const repository = installed();
    const path = writeAgentFile(repository, 'analysis.toml', fixtureAgent());

    const entry = rosterAgent(discoverRoster(projectConfiguration(repository)), 'analysis');

    expect(entry?.path).toBe(path);
    expect(entry?.declaration.tools).toStrictEqual(['Read', 'Grep', 'Glob']);
    expect(entry?.declaration.contract).toBe('step.output');
    expect(entry?.declaration.reversibility).toBe('reversible');
    expect(entry?.declaration.model.start_tier).toBe('claude-haiku-4-5');
  });

  it('ignores a file that is not a TOML, rather than refusing it', () => {
    const repository = installed();
    writeAgentFile(repository, 'analysis.toml', fixtureAgent());
    writeFileSync(join(repository, '.orch', 'agents', 'README.md'), 'notes\n', 'utf8');

    const roster = discoverRoster(projectConfiguration(repository));

    expect(roster.agents.map((entry) => entry.id)).toStrictEqual(['analysis']);
    expect(roster.refused).toStrictEqual([]);
  });

  it('answers null for an id nothing declares, rather than a default', () => {
    const repository = installed();
    writeAgentFile(repository, 'analysis.toml', fixtureAgent());

    expect(rosterAgent(discoverRoster(projectConfiguration(repository)), 'committing')).toBeNull();
  });
});

describe('a bad entry is refused and the others still load (matrix 12, 13, 14)', () => {
  it('refuses an unregistered contract id, naming the registered ones', () => {
    const repository = installed();
    writeAgentFile(repository, 'analysis.toml', fixtureAgent());
    writeAgentFile(repository, 'inventive.toml', fixtureAgent({ id: 'inventive', contract: 'step.invented' }));

    const roster = discoverRoster(projectConfiguration(repository));

    expect(roster.agents.map((entry) => entry.id)).toStrictEqual(['analysis']);
    expect(roster.refused).toHaveLength(1);
    expect(roster.refused[0]?.reason).toContain('step.invented');
    for (const id of CONTRACT_IDS) expect(roster.refused[0]?.reason).toContain(id);
    expect(roster.refused[0]?.code).toBe('config.invalid');
    expect(roster.summary).toContain('1 file refused');
  });

  it('refuses a tool ADR-003 does not declare, at parse', () => {
    const repository = installed();
    writeAgentFile(repository, 'analysis.toml', fixtureAgent());
    // `Bsah` is ADR-003's own example: a typo that grants nothing while reading as though it grants
    // something. It is written as a raw table because no schema would produce it.
    writeAgentFile(repository, 'typo.toml', {
      schema_version: CURRENT_SCHEMA_VERSION,
      id: 'typo',
      purpose: 'a roster entry with a mistyped grant',
      contract: 'step.output',
      tools: ['Read', 'Bsah'],
      mcp_domains: [],
      reversibility: 'reversible',
      model: { start_tier: 'claude-haiku-4-5', promotion_policy: 'never' },
    });

    const roster = discoverRoster(projectConfiguration(repository));

    expect(roster.agents.map((entry) => entry.id)).toStrictEqual(['analysis']);
    expect(roster.refused.map((entry) => entry.path)).toHaveLength(1);
    expect(roster.refused[0]?.path).toContain('typo.toml');
  });

  it('refuses a Task, WebFetch or WebSearch grant, which no roster entry may hold', () => {
    const repository = installed();
    for (const tool of ['Task', 'WebFetch', 'WebSearch']) {
      writeAgentFile(repository, `${tool.toLowerCase()}.toml`, {
        schema_version: CURRENT_SCHEMA_VERSION,
        id: tool.toLowerCase(),
        purpose: 'a roster entry reaching past the declared vocabulary',
        contract: 'step.output',
        tools: ['Read', tool],
        mcp_domains: [],
        reversibility: 'reversible',
        model: { start_tier: 'claude-haiku-4-5', promotion_policy: 'never' },
      });
    }

    const roster = discoverRoster(projectConfiguration(repository));

    expect(roster.agents).toStrictEqual([]);
    expect(roster.refused).toHaveLength(3);
  });

  it('refuses an entry whose id disagrees with its file name: one entry cannot have two names', () => {
    const repository = installed();
    writeAgentFile(repository, 'reviewer.toml', fixtureAgent({ id: 'review' }));

    const roster = discoverRoster(projectConfiguration(repository));

    expect(roster.agents).toStrictEqual([]);
    expect(roster.refused[0]?.reason).toContain('"review"');
    expect(roster.refused[0]?.reason).toContain('"reviewer"');
    expect(roster.refused[0]?.reason).toContain('AD-17');
  });

  it('refuses an entry whose schema_version this build does not read, carrying the AD-28 code', () => {
    const repository = installed();
    writeAgentFile(repository, 'analysis.toml', {
      ...fixtureAgent(),
      schema_version: CURRENT_SCHEMA_VERSION + 98,
    });

    const roster = discoverRoster(projectConfiguration(repository));

    expect(roster.agents).toStrictEqual([]);
    expect(roster.refused[0]?.code).toBe('config.schema_version_unrecognised');
    expect(roster.refused[0]?.reason).toContain('Re-run the installer');
  });

  it('refuses a hand edit that does not parse, naming the line, and keeps the rest', () => {
    const repository = installed();
    writeAgentFile(repository, 'analysis.toml', fixtureAgent());
    writeFileSync(join(repository, '.orch', 'agents', 'broken.toml'), 'id = \n', 'utf8');

    const roster = discoverRoster(projectConfiguration(repository));

    expect(roster.agents.map((entry) => entry.id)).toStrictEqual(['analysis']);
    expect(roster.refused[0]?.reason).toMatch(/line \d+/);
  });
});

describe('an empty or absent agents directory is an empty roster (matrix 15)', () => {
  it('says plainly that the roster is empty when the directory is there and empty', () => {
    const repository = installed();
    makeEmptyAgentsDir(repository);

    const roster = discoverRoster(projectConfiguration(repository));

    expect(roster.agents).toStrictEqual([]);
    expect(roster.refused).toStrictEqual([]);
    expect(roster.summary).toContain('No agents are declared');
    expect(roster.summary).toContain('holds no built-in list');
  });

  it('is equally empty when there is no agents directory at all', () => {
    const repository = installed();

    expect(discoverRoster(projectConfiguration(repository)).agents).toStrictEqual([]);
  });

  it('falls back to no part of the installer\'s built-in roster', () => {
    const repository = installed();
    makeEmptyAgentsDir(repository);

    const roster = discoverRoster(projectConfiguration(repository));

    // The guard that matters: AD-17 says the engine discovers agents *only* by reading the directory. A
    // fallback would make this list appear where the person declared nothing, and would make a
    // user-defined roster invisible to half the system.
    expect(BUILT_IN_AGENT_IDS.length).toBeGreaterThan(0);
    for (const id of BUILT_IN_AGENT_IDS) {
      expect(rosterAgent(roster, id), `${id} was invented`).toBeNull();
    }
    expect(roster.agents).toHaveLength(0);
  });

  it('reports an unreadable agents directory as a refusal, never as an empty roster (row 22)', () => {
    const repository = installed();
    writeAgentFile(repository, 'analysis.toml', fixtureAgent());
    const agentsDir = join(repository, '.orch', 'agents');
    chmodSync(agentsDir, 0o000);

    try {
      const roster = discoverRoster(projectConfiguration(repository));
      // Root can list a 000 directory, so the refusal cannot be asserted there; assert *that* rather than
      // letting the test pass for a reason it does not name.
      if (roster.refused.length === 0) {
        expect(process.getuid?.()).toBe(0);
        return;
      }
      // Absent and unreadable are different answers. The old behaviour said "No agents are declared … the
      // engine holds no built-in list to fall back to" — an AD-17 sentence describing a permission bit.
      expect(roster.agents).toStrictEqual([]);
      expect(roster.refused).toHaveLength(1);
      expect(roster.refused[0]?.path).toBe(agentsDir);
      expect(roster.refused[0]?.code).toBe('config.invalid');
      expect(roster.refused[0]?.reason).toContain('Cannot list the agent roster');
      expect(roster.summary).not.toContain('No agents are declared');
      expect(roster.summary).toContain('not the same as there being no agents');
    } finally {
      chmodSync(agentsDir, 0o755);
    }
  });

  it('discovers a user-defined agent the installer has never heard of', () => {
    const repository = installed();
    writeAgentFile(repository, 'migration-review.toml', fixtureAgent({ id: 'migration-review' }));

    const roster = discoverRoster(projectConfiguration(repository));

    expect(BUILT_IN_AGENT_IDS).not.toContain('migration-review');
    expect(roster.agents.map((entry) => entry.id)).toStrictEqual(['migration-review']);
  });
});

/**
 * Matrix 16 — nothing under `src/engine/` imports the installer's built-in roster, checked recursively.
 *
 * The walker and the checker are separated from the directory they run over on purpose: that is what lets
 * the same rule be applied to the real tree and to a fixture tree whose violation is in a subdirectory,
 * and lets the flat listing be shown missing it.
 */
describe('the engine holds no compiled-in roster (matrix 16)', () => {
  const engineDir = new URL('../src/engine/', import.meta.url);

  /** Every `.ts` under a directory, **including subdirectories**, as paths relative to it. */
  const listSources = (dir: URL, prefix = ''): string[] =>
    readdirSync(dir, { withFileTypes: true, encoding: 'utf8' }).flatMap((entry) =>
      entry.isDirectory()
        ? listSources(new URL(`${entry.name}/`, dir), `${prefix}${entry.name}/`)
        : entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')
          ? [`${prefix}${entry.name}`]
          : [],
    );

  /** The same listing, non-recursively — kept only to demonstrate what it misses. */
  const listSourcesFlat = (dir: URL): string[] =>
    readdirSync(dir, { withFileTypes: true, encoding: 'utf8' })
      .filter((entry) => !entry.isDirectory() && entry.name.endsWith('.ts'))
      .map((entry) => entry.name);

  /** Statement forms only, so a quoted word after "from" in prose is not read as an import. */
  const IMPORT_PATTERNS = [
    /^\s*(?:import|export)\b[^'";]*\bfrom\s*['"]([^'"]+)['"]/gm,
    /^\s*import\s*['"]([^'"]+)['"]/gm,
    /\bimport\s*\(\s*['"]([^'"]+)['"]/g,
    /\brequire\s*\(\s*['"]([^'"]+)['"]/g,
  ];

  const importsOf = (source: string): string[] =>
    IMPORT_PATTERNS.flatMap((pattern) =>
      [...source.matchAll(pattern)].map((match) => match[1] ?? ''),
    );

  /**
   * Comments are stripped before the name check.
   *
   * `src/engine/roster.ts` explains *why* it never reaches for `BUILT_IN_AGENTS`, and a naive grep would
   * match that explanation. The claim is about code, so the check is about code.
   */
  const codeOf = (source: string): string =>
    source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

  /** The names that are the installer's roster. Both, because either would compile in. */
  const INSTALLER_ROSTER_NAMES = ['BUILT_IN_AGENTS', 'BUILT_IN_AGENT_IDS'];

  const violationsIn = (dir: URL, files: readonly string[]): string[] => {
    const found: string[] = [];
    for (const file of files) {
      const source = readFileSync(new URL(file, dir), 'utf8');
      const code = codeOf(source);
      for (const specifier of importsOf(code)) {
        if (specifier.includes('/installer/') || specifier.startsWith('../installer')) {
          found.push(`${file} imports "${specifier}"`);
        }
      }
      for (const name of INSTALLER_ROSTER_NAMES) {
        if (code.includes(name)) found.push(`${file} names ${name}`);
      }
    }
    return found;
  };

  const files = listSources(engineDir);

  it('has source files to inspect, and reads the imports it claims to', () => {
    expect(files.length).toBeGreaterThan(0);
    expect(files).toContain('roster.ts');
    expect(files).toContain('profile.ts');
    expect(files).toContain('config-snapshot.ts');
    const source = readFileSync(new URL('roster.ts', engineDir), 'utf8');
    expect(importsOf(source)).toContain('../contracts/index.js');
    expect(codeOf(source)).not.toContain('AD-17 — the agent roster');
  });

  it('guards a name the installer still exports, so the rule is not about a symbol that is gone', () => {
    // A guard against an absent name passes for ever and means nothing. ADR-003 pinned this array with
    // tests, which is exactly what makes reusing it tempting.
    expect(BUILT_IN_AGENTS.length).toBeGreaterThan(0);
    expect(INSTALLER_ROSTER_NAMES).toContain('BUILT_IN_AGENTS');
  });

  it('finds no file under src/engine/ importing the installer or naming its built-in roster', () => {
    expect(violationsIn(engineDir, files)).toStrictEqual([]);
  });

  it('catches a violation in a subdirectory, which a flat listing silently walks past', () => {
    const fixture = workspace('engine-guard');
    const nested = join(fixture, 'nested');
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(fixture, 'clean.ts'), "import { runPaths } from '../runtime/index.js';\n", 'utf8');
    writeFileSync(
      join(nested, 'sneaky.ts'),
      "import { BUILT_IN_AGENTS } from '../../installer/interview.js';\n" +
        'export const roster = BUILT_IN_AGENTS;\n',
      'utf8',
    );
    const fixtureDir = new URL(`file://${fixture}/`);

    const recursive = violationsIn(fixtureDir, listSources(fixtureDir));
    const flat = violationsIn(fixtureDir, listSourcesFlat(fixtureDir));

    // The recursive walk sees the nested file and names it twice — the import and the symbol.
    expect(recursive.filter((entry) => entry.startsWith('nested/sneaky.ts'))).toHaveLength(2);
    expect(listSources(fixtureDir)).toContain('nested/sneaky.ts');
    // The flat walk sees the same directory, reports the same *shape* of result, and finds nothing: that
    // is the failure mode this test exists to make visible rather than to trust a comment about.
    expect(listSourcesFlat(fixtureDir)).toStrictEqual(['clean.ts']);
    expect(flat).toStrictEqual([]);
  });

  it('catches the import and the bare name independently, so neither alone is the whole guard', () => {
    const fixture = workspace('engine-guard-forms');
    writeFileSync(
      join(fixture, 'by-import.ts'),
      "export { BUILT_IN_AGENT_IDS } from '../installer/index.js';\n",
      'utf8',
    );
    writeFileSync(
      join(fixture, 'by-name.ts'),
      'import { things } from "./elsewhere.js";\nexport const roster = things.BUILT_IN_AGENTS;\n',
      'utf8',
    );
    writeFileSync(
      join(fixture, 'by-comment.ts'),
      '// The engine must not import BUILT_IN_AGENTS (AD-17).\nexport const clean = true;\n',
      'utf8',
    );
    const fixtureDir = new URL(`file://${fixture}/`);

    const violations = violationsIn(fixtureDir, listSources(fixtureDir));

    expect(violations.some((entry) => entry.startsWith('by-import.ts'))).toBe(true);
    expect(violations.some((entry) => entry.startsWith('by-name.ts'))).toBe(true);
    // A docblock explaining the rule is not a breach of it, which is why comments are stripped first.
    expect(violations.some((entry) => entry.startsWith('by-comment.ts'))).toBe(false);
  });
});
