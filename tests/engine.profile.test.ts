/**
 * AD-16, AD-28, matrix rows 1–3 and 7–10 — the profile loads, refuses rather than defaults, and its
 * knowledge entries lose to the repository's own instructions by anchor.
 *
 * **One test here drives the real installer.** Every other fixture in this suite writes `.orch/` through
 * the same schemas the installer writes it through, which is honest but circular in one respect: it
 * cannot catch the loader and the installer agreeing about a shape that is not the one on disk. So row 1
 * is asserted twice — once against a fixture, and once against a `.orch/` an actual `runInit` produced.
 *
 * **The precedence fixture is built from two deliberately different anchors.** Story 2-2 found a matrix
 * where three rows compared a value to itself; the equivalent here would be a profile anchor and a
 * convention anchor that are the same string because one constant produced both, which would make the
 * "applied" half of the rule unobservable. The two constants are asserted to differ, the instruction file
 * is asserted to name one and not the other, and both verdicts are then taken from one resolution.
 */
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import {
  CURRENT_SCHEMA_VERSION,
  KnowledgeEntrySchema,
  ProfileSchema,
  parseToml,
} from '../src/contracts/index.js';
import {
  ProfileNotFound,
  loadProfile,
  projectConfiguration,
  resolveKnowledge,
  resolveProfile,
} from '../src/engine/index.js';
import { runInit } from '../src/installer/index.js';

import {
  FIXTURE_PROJECT_ID,
  fixtureProfile,
  knowledgeEntry,
  knowledgeSection,
  makeWorkspace,
  writeInstructionFile,
  writeProfile,
  writeRawProfile,
} from './helpers/config-fixture.js';
import { makeRepository, scriptedIo } from './helpers/installer-fixture.js';

const workspaces: string[] = [];

const workspace = (label = 'profile'): string => {
  const created = makeWorkspace(label);
  workspaces.push(created);
  return created;
};

afterAll(() => {
  for (const path of workspaces) rmSync(path, { recursive: true, force: true });
});

/**
 * The anchor the repository's `CLAUDE.md` speaks to, and the anchor nothing speaks to.
 *
 * Two constants, and the first assertion of the precedence suite is that they are different strings —
 * because a fixture that derived both from one value would pass the stale case and the applied case for
 * the same reason, which is no reason at all.
 */
const CONTRADICTED_ANCHOR = 'resolveProject';
const UNCONTRADICTED_ANCHOR = 'leaseWorktree';

/** A `CLAUDE.md` that names one of the two anchors. Prose, never parsed — only searched for a symbol. */
const CLAUDE_MD_NAMING_ONE_ANCHOR =
  '# Conventions\n\n' +
  `Renderers must not call \`${CONTRADICTED_ANCHOR}\`; they write a command intent instead.\n`;

describe('the profile loads with every AD-16 mechanic available (matrix 1)', () => {
  it('answers with the four commands, the package manager, the layout, resources and the risk tiers', () => {
    const repository = workspace();
    writeProfile(repository, fixtureProfile());

    const resolved = resolveProfile(projectConfiguration(repository));

    expect(resolved.mechanics.commands).toStrictEqual({
      test: 'npm test',
      lint: 'npm run lint',
      build: 'npm run build',
      run: 'npm start',
    });
    expect(resolved.mechanics.package_manager).toBe('npm');
    expect(resolved.mechanics.source_layout).toStrictEqual(['src', 'tests']);
    expect(resolved.mechanics.resources).toBe('none');
    expect(resolved.risk.high_blast_radius_paths).toStrictEqual(['src/runtime']);
    expect(resolved.risk.conflict_domains).toStrictEqual(['schema']);
    expect(resolved.profile.project.id).toBe(FIXTURE_PROJECT_ID);
  });

  it('reads the .orch/ a real installer run wrote, not only the one this suite writes', async () => {
    const repository = makeRepository();
    workspaces.push(repository);
    const orchHome = workspace('profile-home');
    // The installer is driven with an empty script, so every answer is the offered default and the
    // profile is whatever story 2-1 actually produces for a Node repository.
    await runInit({ repository, io: scriptedIo(), orchHome });

    const resolved = resolveProfile(projectConfiguration(repository));

    // Asserted against the bytes on disk rather than against a constant in this file, so the claim is
    // "the loader reads what the installer wrote" and not "two fixtures agree".
    const onDisk = ProfileSchema.parse(
      parseToml(readFileSync(join(repository, '.orch', 'profile.toml'), 'utf8')),
    );
    expect(resolved.profile).toStrictEqual(onDisk);
    expect(resolved.mechanics.commands.test).toBe(onDisk.mechanics.commands.test);
    expect(resolved.mechanics.commands.test).not.toBe('');
    // Story 2-1 writes no knowledge section, which is the reason the section is optional.
    expect(resolved.profile.knowledge).toBeUndefined();
    expect(resolved.knowledge.applied).toStrictEqual([]);
    expect(resolved.knowledge.stale).toStrictEqual([]);
  });

  it('loads the mechanics of a repository that states no conventions at all (matrix 6)', () => {
    const repository = workspace();
    writeProfile(repository, fixtureProfile());

    const resolved = resolveProfile(projectConfiguration(repository));

    expect(resolved.conventions.files).toStrictEqual([]);
    expect(resolved.mechanics.commands.build).toBe('npm run build');
  });
});

describe('a repository with no .orch/ is refused, never defaulted (matrix 2)', () => {
  it('names what creates one, and invents no profile', () => {
    const repository = workspace();

    expect(() => loadProfile(projectConfiguration(repository))).toThrowError(ProfileNotFound);
    try {
      loadProfile(projectConfiguration(repository));
      expect.unreachable('a repository with no .orch/ must be refused');
    } catch (error) {
      expect(error).toBeInstanceOf(ProfileNotFound);
      const refusal = error as ProfileNotFound;
      expect(refusal.code).toBe('config.invalid');
      expect(refusal.scope).toBe('project');
      expect(refusal.message).toContain('init');
      expect(refusal.message).toContain('.orch/profile.toml');
      expect(refusal.message).toContain('Nothing is defaulted');
    }
  });

  it('creates nothing while refusing', () => {
    const repository = workspace();

    expect(() => resolveProfile(projectConfiguration(repository))).toThrowError(ProfileNotFound);
    expect(() => readFileSync(join(repository, '.orch', 'profile.toml'), 'utf8')).toThrowError();
  });
});

describe('an unrecognised schema_version is refused as every versioned artifact is (matrix 3)', () => {
  it('carries config.schema_version_unrecognised and names the installer reading it', () => {
    const repository = workspace();
    const profile = fixtureProfile();
    writeRawProfile(repository, { ...profile, schema_version: CURRENT_SCHEMA_VERSION + 98 });

    try {
      loadProfile(projectConfiguration(repository));
      expect.unreachable('an unrecognised schema_version must be refused');
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      const refusal = error as Error & { code?: string };
      expect(refusal.code).toBe('config.schema_version_unrecognised');
      expect(refusal.message).toContain('schema_version 99');
      expect(refusal.message).toContain('Re-run the installer');
      // The artifact is named, which is what distinguishes this from the field-level refusal.
      expect(refusal.message).toContain('profile.toml');
    }
  });

  it('refuses a hand edit that does not parse, naming the line', () => {
    const repository = workspace();
    const path = writeProfile(repository, fixtureProfile());
    writeFileSync(path, `${readFileSync(path, 'utf8')}\nbranch_pattern = 3.5\n`, 'utf8');

    try {
      loadProfile(projectConfiguration(repository));
      expect.unreachable('an unparseable profile must be refused');
    } catch (error) {
      const refusal = error as Error & { code?: string };
      expect(refusal.code).toBe('config.invalid');
      expect(refusal.message).toMatch(/line \d+/);
    }
  });
});

describe('precedence is decided by anchor, not by meaning (matrix 7, 8)', () => {
  it('builds the two sources from genuinely different anchors', () => {
    // The fixture's own premise, asserted before anything depends on it: one anchor the repository speaks
    // to and one it does not. Were these the same string, both verdicts below would be the same verdict.
    expect(CONTRADICTED_ANCHOR).not.toBe(UNCONTRADICTED_ANCHOR);
    expect(CLAUDE_MD_NAMING_ONE_ANCHOR).toContain(CONTRADICTED_ANCHOR);
    expect(CLAUDE_MD_NAMING_ONE_ANCHOR).not.toContain(UNCONTRADICTED_ANCHOR);
  });

  const resolveBothEntries = (): ReturnType<typeof resolveProfile> => {
    const repository = workspace();
    writeInstructionFile(repository, 'CLAUDE.md', CLAUDE_MD_NAMING_ONE_ANCHOR);
    writeProfile(
      repository,
      fixtureProfile({
        knowledge: knowledgeSection([
          knowledgeEntry({ anchor: CONTRADICTED_ANCHOR }),
          knowledgeEntry({
            anchor: UNCONTRADICTED_ANCHOR,
            claim: 'leaseWorktree takes the pool lease before the checkout exists.',
            decay_policy: 'n-features',
            decay_features: 3,
          }),
        ]),
      }),
    );
    return resolveProfile(projectConfiguration(repository));
  };

  it('flags the entry the repository speaks to rather than applying it', () => {
    const resolved = resolveBothEntries();

    expect(resolved.knowledge.stale.map((entry) => entry.anchor)).toStrictEqual([CONTRADICTED_ANCHOR]);
    expect(resolved.knowledge.applied.map((entry) => entry.anchor)).not.toContain(CONTRADICTED_ANCHOR);
  });

  it('names both the anchor and the file that overrode it', () => {
    const stale = resolveBothEntries().knowledge.stale[0];

    expect(stale?.anchor).toBe(CONTRADICTED_ANCHOR);
    expect(stale?.overriddenBy).toStrictEqual(['CLAUDE.md']);
    expect(stale?.summary).toContain(CONTRADICTED_ANCHOR);
    expect(stale?.summary).toContain('CLAUDE.md');
    expect(stale?.summary).toContain('AD-16');
  });

  it('keeps the flagged entry rather than removing it, because the section is additive', () => {
    const resolved = resolveBothEntries();

    expect(resolved.knowledge.stale[0]?.entry.claim).toContain('resolveProject verifies the pointer');
    expect(resolved.profile.knowledge?.entries).toHaveLength(2);
  });

  it('applies the entry nothing else speaks to, with its provenance and decay policy intact', () => {
    const applied = resolveBothEntries().knowledge.applied;

    expect(applied.map((entry) => entry.anchor)).toStrictEqual([UNCONTRADICTED_ANCHOR]);
    expect(applied[0]?.provenance).toBe('bootstrap agent, from ORCH-run 01JQ');
    expect(applied[0]?.recorded_at).toBe('2026-09-22T09:00:00.000Z');
    expect(applied[0]?.decay_policy).toBe('n-features');
    expect(applied[0]?.decay_features).toBe(3);
  });

  it('applies both entries when the repository states no conventions', () => {
    const repository = workspace();
    writeProfile(
      repository,
      fixtureProfile({
        knowledge: knowledgeSection([
          knowledgeEntry({ anchor: CONTRADICTED_ANCHOR }),
          knowledgeEntry({ anchor: UNCONTRADICTED_ANCHOR }),
        ]),
      }),
    );

    const resolved = resolveProfile(projectConfiguration(repository));

    expect(resolved.knowledge.applied).toHaveLength(2);
    expect(resolved.knowledge.stale).toStrictEqual([]);
  });

  it('flags from an AGENTS.md exactly as from a CLAUDE.md', () => {
    const repository = workspace();
    writeInstructionFile(repository, 'AGENTS.md', CLAUDE_MD_NAMING_ONE_ANCHOR);
    writeProfile(
      repository,
      fixtureProfile({ knowledge: knowledgeSection([knowledgeEntry({ anchor: CONTRADICTED_ANCHOR })]) }),
    );

    expect(resolveProfile(projectConfiguration(repository)).knowledge.stale[0]?.overriddenBy).toStrictEqual(
      ['AGENTS.md'],
    );
  });

  it('reports the verdict in one line a person can act on', () => {
    const resolved = resolveBothEntries();

    expect(resolved.summary).toContain('1 knowledge entry applied');
    expect(resolved.summary).toContain('1 flagged stale');
  });

  it('decides nothing from the claim text, only from the anchor', () => {
    // The claim contradicts the instruction file in plain English while naming a different anchor. A
    // loader reading meaning would flag it; one reading anchors applies it, which is the design.
    const repository = workspace();
    writeInstructionFile(repository, 'CLAUDE.md', 'Never call `resolveProject` from a renderer.\n');
    const profile = fixtureProfile({
      knowledge: knowledgeSection([
        knowledgeEntry({
          anchor: UNCONTRADICTED_ANCHOR,
          claim: 'Renderers may call resolve project helpers freely.',
        }),
      ]),
    });
    writeProfile(repository, profile);

    const resolved = resolveProfile(projectConfiguration(repository));

    expect(resolved.knowledge.applied).toHaveLength(1);
    expect(resolved.knowledge.stale).toStrictEqual([]);
  });

  it('resolves knowledge as a function of the profile and the conventions alone', () => {
    // `resolveKnowledge` is exported so the rule can be exercised without a filesystem, which is what
    // makes it possible to assert that nothing else — no clock, no environment — enters the verdict.
    const profile = fixtureProfile({
      knowledge: knowledgeSection([knowledgeEntry({ anchor: CONTRADICTED_ANCHOR })]),
    });
    const conventions = {
      directory: '/nowhere',
      files: [{ name: 'CLAUDE.md', path: '/nowhere/CLAUDE.md', text: CLAUDE_MD_NAMING_ONE_ANCHOR }],
      summary: 'fixture',
    };

    expect(resolveKnowledge(profile, conventions).stale).toHaveLength(1);
    expect(resolveKnowledge(profile, { ...conventions, files: [] }).applied).toHaveLength(1);
  });
});

describe('an entry nothing can check is refused at parse (matrix 9, 10)', () => {
  it('refuses an entry with no anchor field at all', () => {
    const { anchor: _absent, ...withoutAnchor } = knowledgeEntry();

    const parsed = KnowledgeEntrySchema.safeParse(withoutAnchor);

    expect(parsed.success).toBe(false);
  });

  it('refuses a blank anchor, which is an anchor nobody can ever flag', () => {
    const parsed = KnowledgeEntrySchema.safeParse({ ...knowledgeEntry(), anchor: '   ' });

    expect(parsed.success).toBe(false);
    expect(JSON.stringify(parsed.error?.issues)).toContain('AD-16');
  });

  it.each([
    'src/runtime/projects.ts:42',
    'src/runtime/projects.ts:42:7',
    'projects.ts#L42',
    'projects.ts#L42-L58',
    '42',
    'L42',
    'line 42',
    'lines 42-58',
  ])('refuses "%s", because a line number is never an anchor', (anchor) => {
    const parsed = KnowledgeEntrySchema.safeParse({ ...knowledgeEntry(), anchor });

    expect(parsed.success).toBe(false);
    expect(JSON.stringify(parsed.error?.issues)).toContain('never a line number');
  });

  it.each([
    'resolveProject',
    'src/runtime/projects.ts',
    'runtime.recorder',
    'refuses a foreign fetch record',
    'RunState',
  ])('accepts "%s", which names a symbol, a module or a test', (anchor) => {
    expect(KnowledgeEntrySchema.safeParse({ ...knowledgeEntry(), anchor }).success).toBe(true);
  });

  it('refuses an entry with no provenance, which AD-16 requires', () => {
    expect(KnowledgeEntrySchema.safeParse({ ...knowledgeEntry(), provenance: ' ' }).success).toBe(false);
  });

  it('refuses an n-features entry with no N, and a count on a policy that never reads one', () => {
    expect(
      KnowledgeEntrySchema.safeParse({
        ...knowledgeEntry(),
        decay_policy: 'n-features',
        decay_features: 0,
      }).success,
    ).toBe(false);
    expect(
      KnowledgeEntrySchema.safeParse({
        ...knowledgeEntry(),
        decay_policy: 'permanent',
        decay_features: 4,
      }).success,
    ).toBe(false);
  });

  it('refuses a profile whose knowledge section holds an unanchored entry, through the profile itself', () => {
    const repository = workspace();
    const profile = fixtureProfile();
    const { anchor: _absent, ...withoutAnchor } = knowledgeEntry();
    writeRawProfile(repository, { ...profile, knowledge: { entries: [withoutAnchor] } });

    expect(() => loadProfile(projectConfiguration(repository))).toThrowError();
  });

  it('survives a profile whose knowledge section is present and empty', () => {
    const repository = workspace();
    writeProfile(repository, fixtureProfile({ knowledge: { entries: [] } }));

    const resolved = resolveProfile(projectConfiguration(repository));

    expect(resolved.profile.knowledge?.entries).toStrictEqual([]);
    expect(resolved.knowledge.applied).toStrictEqual([]);
  });

  it('round-trips a knowledge entry through the TOML the profile is written in', () => {
    // The section has to survive the serialiser as well as the schema: an entry is a `[[…]]` table, and
    // the subset refuses a nested table inside one — which is why every field of an entry is flat.
    const repository = workspace();
    const entry = knowledgeEntry({ decay_policy: 'n-features', decay_features: 2 });
    const path = writeProfile(repository, fixtureProfile({ knowledge: knowledgeSection([entry]) }));

    expect(readFileSync(path, 'utf8')).toContain('[[knowledge.entries]]');
    expect(loadProfile(projectConfiguration(repository)).knowledge?.entries[0]).toStrictEqual(entry);
  });
});
