/**
 * Story 5-2 — `retrieveFacts`'s I/O matrix: a per-feature area filter and a plain entry-count budget over
 * L3's `consolidated.jsonl`, most-recent-first.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { retrieveFacts } from '../src/engine/index.js';
import type { KnowledgeEntry } from '../src/contracts/index.js';
import { projectMemoryPath } from '../src/runtime/index.js';

import { knowledgeEntry } from './helpers/config-fixture.js';

const homes: string[] = [];

const home = (): string => {
  const created = mkdtempSync(join(tmpdir(), 'orch-knowledge-retrieval-home-'));
  homes.push(created);
  return created;
};

afterAll(() => {
  for (const path of homes) rmSync(path, { recursive: true, force: true });
});

const PROJECT_ID = 'project-under-test';

const writeConsolidatedStore = (orchHome: string, projectId: string, entries: readonly KnowledgeEntry[]): string => {
  const path = projectMemoryPath(projectId, orchHome);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, entries.map((entry) => JSON.stringify(entry)).join('\n') + (entries.length > 0 ? '\n' : ''), 'utf8');
  return path;
};

/** A fact anchored to `area`, recorded at a distinct instant so recency order is observable. */
const factAt = (area: string, recordedAt: string): KnowledgeEntry =>
  knowledgeEntry({
    anchor: area,
    anchor_kind: 'module-name',
    provenance: `consolidation:run-${area}-${recordedAt}:${area}`,
    recorded_at: recordedAt,
  });

describe('retrieveFacts — within budget (matrix row 6)', () => {
  it('returns all matching entries, most-recent-first, when the budget is not exceeded', () => {
    const orchHome = home();
    const oldest = factAt('engine', '2026-09-01T00:00:00.000Z');
    const middle = factAt('engine', '2026-09-02T00:00:00.000Z');
    const newest = factAt('engine', '2026-09-03T00:00:00.000Z');
    writeConsolidatedStore(orchHome, PROJECT_ID, [oldest, middle, newest]);

    const result = retrieveFacts(PROJECT_ID, ['engine'], 5, { orchHome });

    expect(result).toStrictEqual([newest, middle, oldest]);
  });
});

describe('retrieveFacts — over budget (matrix row 7, acceptance)', () => {
  it('returns exactly `budget` entries, the most recent first, with no error for the rest', () => {
    const orchHome = home();
    const entries = ['2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04', '2026-09-05'].map((day) =>
      factAt('engine', `${day}T00:00:00.000Z`),
    );
    writeConsolidatedStore(orchHome, PROJECT_ID, entries);

    const result = retrieveFacts(PROJECT_ID, ['engine'], 2, { orchHome });

    expect(result).toHaveLength(2);
    expect(result).toStrictEqual([entries[4], entries[3]]);
  });
});

describe('retrieveFacts — no matching area (matrix row 8)', () => {
  it('returns [] when no entry is anchored to any requested area', () => {
    const orchHome = home();
    writeConsolidatedStore(orchHome, PROJECT_ID, [factAt('engine', '2026-09-01T00:00:00.000Z')]);

    expect(retrieveFacts(PROJECT_ID, ['tui'], 5, { orchHome })).toStrictEqual([]);
  });
});

describe('retrieveFacts — empty/missing store (matrix row 9)', () => {
  it('returns [] for a project with no consolidated.jsonl yet, matching readConsolidatedStore', () => {
    const orchHome = home();

    expect(retrieveFacts(PROJECT_ID, ['engine'], 5, { orchHome })).toStrictEqual([]);
  });
});

describe('retrieveFacts — filtering by area, not by any other field', () => {
  it('filters to entries whose anchor is in the requested areas, ignoring everything else present', () => {
    const orchHome = home();
    const engineFact = factAt('engine', '2026-09-01T00:00:00.000Z');
    const tuiFact = factAt('tui', '2026-09-02T00:00:00.000Z');
    const contractsFact = factAt('contracts', '2026-09-03T00:00:00.000Z');
    writeConsolidatedStore(orchHome, PROJECT_ID, [engineFact, tuiFact, contractsFact]);

    const result = retrieveFacts(PROJECT_ID, ['engine', 'tui'], 5, { orchHome });

    expect(result).toStrictEqual([tuiFact, engineFact]);
  });

  it('several areas spanning the budget still cap at the total count, most-recent-first across all of them', () => {
    const orchHome = home();
    const engineOld = factAt('engine', '2026-09-01T00:00:00.000Z');
    const tuiMiddle = factAt('tui', '2026-09-02T00:00:00.000Z');
    const engineNew = factAt('engine', '2026-09-03T00:00:00.000Z');
    writeConsolidatedStore(orchHome, PROJECT_ID, [engineOld, tuiMiddle, engineNew]);

    const result = retrieveFacts(PROJECT_ID, ['engine', 'tui'], 2, { orchHome });

    expect(result).toStrictEqual([engineNew, tuiMiddle]);
  });
});

describe('retrieveFacts — never rewrites the store it reads', () => {
  it('leaves consolidated.jsonl byte-for-byte unchanged', () => {
    const orchHome = home();
    const path = writeConsolidatedStore(orchHome, PROJECT_ID, [factAt('engine', '2026-09-01T00:00:00.000Z')]);
    const before = readFileSync(path, 'utf8');

    retrieveFacts(PROJECT_ID, ['engine'], 5, { orchHome });

    expect(readFileSync(path, 'utf8')).toBe(before);
  });

  it('one malformed line in the store costs only itself', () => {
    const orchHome = home();
    const good = factAt('engine', '2026-09-01T00:00:00.000Z');
    const path = writeConsolidatedStore(orchHome, PROJECT_ID, [good]);
    writeFileSync(path, `${readFileSync(path, 'utf8')}not json at all\n`, 'utf8');

    expect(retrieveFacts(PROJECT_ID, ['engine'], 5, { orchHome })).toStrictEqual([good]);
  });
});

describe('retrieveFacts — a budget of zero returns nothing, never an error', () => {
  it('returns [] for budget 0 even when matching entries exist', () => {
    const orchHome = home();
    writeConsolidatedStore(orchHome, PROJECT_ID, [factAt('engine', '2026-09-01T00:00:00.000Z')]);

    expect(retrieveFacts(PROJECT_ID, ['engine'], 0, { orchHome })).toStrictEqual([]);
  });
});

describe('retrieveFacts — a negative budget is clamped to zero, never an error', () => {
  it('returns [] for a negative budget even when matching entries exist', () => {
    const orchHome = home();
    writeConsolidatedStore(orchHome, PROJECT_ID, [factAt('engine', '2026-09-01T00:00:00.000Z')]);

    expect(retrieveFacts(PROJECT_ID, ['engine'], -5, { orchHome })).toStrictEqual([]);
  });
});
