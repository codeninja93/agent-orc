/**
 * Story 5-2 — the sweep's I/O matrix: AD-16-contradiction retirement, the conservative
 * `module-name`/`file-path` anchor-resolution check, the `api-symbol`/`test-name` non-check, and the two
 * stores' different endings — `profile.toml` rewritten, `consolidated.jsonl` only ever reported on.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import {
  ProfileSweepScopeRefused,
  anchorResolution,
  loadProfile,
  projectConfiguration,
  snapshotConfiguration,
  sweepConsolidatedKnowledge,
  sweepProfileKnowledge,
} from '../src/engine/index.js';
import type { KnowledgeEntry } from '../src/contracts/index.js';
import { projectMemoryPath } from '../src/runtime/index.js';

import {
  fixtureProfile,
  knowledgeEntry,
  knowledgeSection,
  makeWorkspace,
  writeInstructionFile,
  writeProfile,
} from './helpers/config-fixture.js';

const workspaces: string[] = [];

const workspace = (label = 'knowledge-sweep'): string => {
  const created = makeWorkspace(label);
  workspaces.push(created);
  return created;
};

const home = (): string => {
  const created = mkdtempSync(join(tmpdir(), 'orch-knowledge-sweep-home-'));
  workspaces.push(created);
  return created;
};

afterAll(() => {
  for (const path of workspaces) rmSync(path, { recursive: true, force: true });
});

const CONTRADICTED_ANCHOR = 'resolveProject';
const CLAUDE_MD_NAMING_CONTRADICTED = `Renderers must not call \`${CONTRADICTED_ANCHOR}\` directly.\n`;

describe('anchorResolution — the conservative filesystem check (Always: module-name/file-path only)', () => {
  it('resolves a module-name anchor whose src/<anchor> directory exists', () => {
    const repository = workspace();
    mkdirSync(join(repository, 'src', 'engine'), { recursive: true });

    expect(anchorResolution('engine', 'module-name', repository)).toBe('resolves');
  });

  it('is dead for a module-name anchor whose src/<anchor> directory does not exist', () => {
    const repository = workspace();

    expect(anchorResolution('payments', 'module-name', repository)).toBe('dead');
  });

  it('resolves a file-path anchor that exists relative to the repository root', () => {
    const repository = workspace();
    mkdirSync(join(repository, 'src'), { recursive: true });
    writeFileSync(join(repository, 'src', 'foo.ts'), 'export const foo = 1;\n', 'utf8');

    expect(anchorResolution('src/foo.ts', 'file-path', repository)).toBe('resolves');
  });

  it('is dead for a file-path anchor that does not exist', () => {
    const repository = workspace();

    expect(anchorResolution('src/gone.ts', 'file-path', repository)).toBe('dead');
  });

  it.each(['api-symbol', 'test-name'] as const)(
    'is always unchecked for a(n) %s anchor, never resolving and never dead',
    (anchorKind) => {
      const repository = workspace();
      // Even a name that could never exist on disk must not read as "dead": resolving either kind
      // needs source or test parsing this story does not build.
      expect(anchorResolution('this plainly is not a path or a directory!!', anchorKind, repository)).toBe(
        'unchecked',
      );
    },
  );

  it('is dead, never resolves, for a file-path anchor that escapes the repository with ../ segments', () => {
    const repository = workspace();
    // /etc plainly exists on the host running this suite, so a naive join+existsSync would report
    // "resolves" for a path that is nowhere near the repository the caller named.
    expect(anchorResolution('../../../etc', 'file-path', repository)).toBe('dead');
  });

  it('is dead, never resolves, for a module-name anchor that escapes the repository with ../ segments', () => {
    const repository = workspace();
    expect(anchorResolution('../../../etc', 'module-name', repository)).toBe('dead');
  });
});

describe('sweepProfileKnowledge — AD-16-contradiction retirement (matrix row 1, acceptance 1)', () => {
  it('retires only the contradicted entry, keeping the healthy one, and rewrites the file', () => {
    const repository = workspace();
    writeInstructionFile(repository, 'CLAUDE.md', CLAUDE_MD_NAMING_CONTRADICTED);
    const contradicted = knowledgeEntry({ anchor: CONTRADICTED_ANCHOR });
    const healthy = knowledgeEntry({
      anchor: 'leaseWorktree',
      claim: 'leaseWorktree takes the pool lease before the checkout exists.',
    });
    writeProfile(repository, fixtureProfile({ knowledge: knowledgeSection([contradicted, healthy]) }));

    const result = sweepProfileKnowledge(projectConfiguration(repository), repository);

    expect(result.retired).toStrictEqual([contradicted]);
    expect(result.disposition).toBe('updated');
    const after = loadProfile(projectConfiguration(repository));
    expect(after.knowledge?.entries).toStrictEqual([healthy]);
  });
});

describe('sweepProfileKnowledge — anchor-resolution retirement (matrix rows 2–3, acceptance 2)', () => {
  it('retires a module-name entry whose directory is gone, even though resolveKnowledge alone calls it applied', () => {
    const repository = workspace();
    const entry = knowledgeEntry({ anchor: 'payments', anchor_kind: 'module-name' });
    writeProfile(repository, fixtureProfile({ knowledge: knowledgeSection([entry]) }));

    const result = sweepProfileKnowledge(projectConfiguration(repository), repository);

    expect(result.retired).toStrictEqual([entry]);
    expect(result.disposition).toBe('updated');
    expect(loadProfile(projectConfiguration(repository)).knowledge?.entries).toStrictEqual([]);
  });

  it('keeps a module-name entry whose directory exists: not retired, not reported', () => {
    const repository = workspace();
    mkdirSync(join(repository, 'src', 'engine'), { recursive: true });
    const entry = knowledgeEntry({ anchor: 'engine', anchor_kind: 'module-name' });
    writeProfile(repository, fixtureProfile({ knowledge: knowledgeSection([entry]) }));

    const result = sweepProfileKnowledge(projectConfiguration(repository), repository);

    expect(result.retired).toStrictEqual([]);
    expect(result.disposition).toBe('unchanged');
    expect(loadProfile(projectConfiguration(repository)).knowledge?.entries).toStrictEqual([entry]);
  });
});

describe('sweepProfileKnowledge — api-symbol/test-name are never retired or reported dead (matrix row 4)', () => {
  it.each(['api-symbol', 'test-name'] as const)(
    'never retires a(n) %s anchor regardless of whether it could ever resolve on disk',
    (anchorKind) => {
      const repository = workspace();
      const entry = knowledgeEntry({ anchor: 'resolveProject', anchor_kind: anchorKind });
      writeProfile(repository, fixtureProfile({ knowledge: knowledgeSection([entry]) }));

      const result = sweepProfileKnowledge(projectConfiguration(repository), repository);

      expect(result.retired).toStrictEqual([]);
      expect(result.disposition).toBe('unchanged');
      expect(loadProfile(projectConfiguration(repository)).knowledge?.entries).toStrictEqual([entry]);
    },
  );
});

describe('sweepProfileKnowledge — no stale entries at all (matrix row 5, acceptance 3)', () => {
  it('leaves profile.toml byte-for-byte unchanged when every entry applies and resolves', () => {
    const repository = workspace();
    mkdirSync(join(repository, 'src', 'engine'), { recursive: true });
    const entry = knowledgeEntry({ anchor: 'engine', anchor_kind: 'module-name' });
    const path = writeProfile(repository, fixtureProfile({ knowledge: knowledgeSection([entry]) }));
    const before = readFileSync(path, 'utf8');

    const result = sweepProfileKnowledge(projectConfiguration(repository), repository);

    expect(result.retired).toStrictEqual([]);
    expect(result.disposition).toBe('unchanged');
    expect(readFileSync(path, 'utf8')).toBe(before);
  });

  it('leaves a profile with no knowledge section at all untouched', () => {
    const repository = workspace();
    const path = writeProfile(repository, fixtureProfile());
    const before = readFileSync(path, 'utf8');

    const result = sweepProfileKnowledge(projectConfiguration(repository), repository);

    expect(result.retired).toStrictEqual([]);
    expect(result.disposition).toBe('unchanged');
    expect(readFileSync(path, 'utf8')).toBe(before);
    expect(loadProfile(projectConfiguration(repository)).knowledge).toBeUndefined();
  });

  it('never re-serialises the file at all when nothing is stale, so a hand-written comment survives', () => {
    // The regression this guards: `parseToml`/`serialiseToml` do not round-trip comments, so a version
    // that re-serialised whenever `profile.knowledge !== undefined` — even with zero stale entries —
    // would silently strip a hand-written comment before `writeFileIfChanged` ever compared bytes.
    const repository = workspace();
    mkdirSync(join(repository, 'src', 'engine'), { recursive: true });
    const entry = knowledgeEntry({ anchor: 'engine', anchor_kind: 'module-name' });
    const path = writeProfile(repository, fixtureProfile({ knowledge: knowledgeSection([entry]) }));
    const canonical = readFileSync(path, 'utf8');
    const withComment = `# hand-written note that serialiseToml would never reproduce\n${canonical}`;
    writeFileSync(path, withComment, 'utf8');

    const result = sweepProfileKnowledge(projectConfiguration(repository), repository);

    expect(result.retired).toStrictEqual([]);
    expect(result.disposition).toBe('unchanged');
    expect(readFileSync(path, 'utf8')).toBe(withComment);
  });
});

describe('sweepProfileKnowledge — the union of both staleness kinds together (acceptance 1 and 2 at once)', () => {
  it('retires the AD-16-contradicted entry and the anchor-dead entry, keeping the healthy one', () => {
    const repository = workspace();
    writeInstructionFile(repository, 'CLAUDE.md', CLAUDE_MD_NAMING_CONTRADICTED);
    mkdirSync(join(repository, 'src', 'engine'), { recursive: true });

    const contradicted = knowledgeEntry({ anchor: CONTRADICTED_ANCHOR });
    const anchorDead = knowledgeEntry({
      anchor: 'payments',
      anchor_kind: 'module-name',
      claim: 'payments has its own retry policy.',
    });
    const healthy = knowledgeEntry({
      anchor: 'engine',
      anchor_kind: 'module-name',
      claim: 'engine owns the reconciler loop.',
    });
    writeProfile(
      repository,
      fixtureProfile({ knowledge: knowledgeSection([contradicted, anchorDead, healthy]) }),
    );

    const result = sweepProfileKnowledge(projectConfiguration(repository), repository);

    expect(result.retired).toStrictEqual([contradicted, anchorDead]);
    expect(result.disposition).toBe('updated');
    expect(loadProfile(projectConfiguration(repository)).knowledge?.entries).toStrictEqual([healthy]);
  });
});

describe('sweepProfileKnowledge — refuses a non-project-scope source (AD-9)', () => {
  it('throws ProfileSweepScopeRefused rather than rewriting a run-scope configuration snapshot', () => {
    const orchHome = home();
    const runScope = snapshotConfiguration('01JQRUNIDRUNIDRUNIDRUNIDRU', { orchHome });

    expect(() => sweepProfileKnowledge(runScope, '/nowhere')).toThrow(ProfileSweepScopeRefused);
  });
});

// -----------------------------------------------------------------------------------------------------
// sweepConsolidatedKnowledge — report-only against the append-only L3 store
// -----------------------------------------------------------------------------------------------------

const PROJECT_ID = 'project-under-test';

const writeConsolidatedStore = (orchHome: string, projectId: string, entries: readonly KnowledgeEntry[]): string => {
  const path = projectMemoryPath(projectId, orchHome);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, entries.map((entry) => JSON.stringify(entry)).join('\n') + (entries.length > 0 ? '\n' : ''), 'utf8');
  return path;
};

describe('sweepConsolidatedKnowledge — module-name anchor gone (matrix row 2, "reported")', () => {
  it('reports the dead entry without touching the store', () => {
    const orchHome = home();
    const repository = workspace();
    const entry = knowledgeEntry({
      anchor: 'payments',
      anchor_kind: 'module-name',
      provenance: 'consolidation:run-x:payments',
    });
    const path = writeConsolidatedStore(orchHome, PROJECT_ID, [entry]);
    const before = readFileSync(path, 'utf8');

    const result = sweepConsolidatedKnowledge(PROJECT_ID, repository, { orchHome });

    expect(result.stale).toStrictEqual([entry]);
    expect(readFileSync(path, 'utf8')).toBe(before);
  });
});

describe('sweepConsolidatedKnowledge — module-name anchor present (matrix row 3)', () => {
  it('reports nothing when the directory still exists', () => {
    const orchHome = home();
    const repository = workspace();
    mkdirSync(join(repository, 'src', 'engine'), { recursive: true });
    const entry = knowledgeEntry({
      anchor: 'engine',
      anchor_kind: 'module-name',
      provenance: 'consolidation:run-x:engine',
    });
    writeConsolidatedStore(orchHome, PROJECT_ID, [entry]);

    const result = sweepConsolidatedKnowledge(PROJECT_ID, repository, { orchHome });

    expect(result.stale).toStrictEqual([]);
  });
});

describe('sweepConsolidatedKnowledge — api-symbol/test-name never reported (matrix row 4)', () => {
  it.each(['api-symbol', 'test-name'] as const)('never reports a(n) %s anchor as dead', (anchorKind) => {
    const orchHome = home();
    const repository = workspace();
    const entry = knowledgeEntry({
      anchor: 'resolveProject',
      anchor_kind: anchorKind,
      provenance: 'consolidation:run-x:resolveProject',
    });
    writeConsolidatedStore(orchHome, PROJECT_ID, [entry]);

    const result = sweepConsolidatedKnowledge(PROJECT_ID, repository, { orchHome });

    expect(result.stale).toStrictEqual([]);
  });
});

describe('sweepConsolidatedKnowledge — empty/missing store (matrix row 8)', () => {
  it('reports nothing for a project with no consolidated.jsonl yet', () => {
    const orchHome = home();
    const repository = workspace();

    expect(sweepConsolidatedKnowledge(PROJECT_ID, repository, { orchHome }).stale).toStrictEqual([]);
  });
});

describe('sweepConsolidatedKnowledge — never rewrites the append-only store (Boundaries)', () => {
  it('leaves the store byte-for-byte unchanged even when it reports a stale entry', () => {
    const orchHome = home();
    const repository = workspace();
    const entry = knowledgeEntry({
      anchor: 'payments',
      anchor_kind: 'module-name',
      provenance: 'consolidation:run-x:payments',
    });
    const path = writeConsolidatedStore(orchHome, PROJECT_ID, [entry]);
    const before = readFileSync(path, 'utf8');

    sweepConsolidatedKnowledge(PROJECT_ID, repository, { orchHome });

    expect(readFileSync(path, 'utf8')).toBe(before);
  });

  it('one malformed line in the store costs only itself', () => {
    const orchHome = home();
    const repository = workspace();
    const entry = knowledgeEntry({
      anchor: 'payments',
      anchor_kind: 'module-name',
      provenance: 'consolidation:run-x:payments',
    });
    const path = writeConsolidatedStore(orchHome, PROJECT_ID, [entry]);
    writeFileSync(path, `${readFileSync(path, 'utf8')}not json at all\n`, 'utf8');

    const result = sweepConsolidatedKnowledge(PROJECT_ID, repository, { orchHome });

    expect(result.stale).toStrictEqual([entry]);
  });
});
