/**
 * Story 5-4 — `recordPattern`/`retrievePatterns`' I/O matrix: the one shared, cross-project store at
 * `ORCH_HOME/memory/patterns.jsonl`, exercised the way `tests/engine.knowledge-retrieval.test.ts` exercises
 * `retrieveFacts` — a real temp `ORCH_HOME`, real files, no project-id partition on the store itself.
 */
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { recordPattern, retrievePatterns } from '../src/engine/index.js';
import type { CrossRepoPattern } from '../src/contracts/index.js';
import { CrossRepoPatternSchema } from '../src/contracts/index.js';
import { memoryDir, patternsPath } from '../src/runtime/index.js';

const homes: string[] = [];

const home = (): string => {
  const created = mkdtempSync(join(tmpdir(), 'orch-pattern-memory-home-'));
  homes.push(created);
  return created;
};

afterAll(() => {
  for (const path of homes) rmSync(path, { recursive: true, force: true });
});

/** A valid `CrossRepoPattern`, overridable per test. */
const aPattern = (overrides: Partial<CrossRepoPattern> = {}): CrossRepoPattern => ({
  topic: 'auth',
  pattern: 'Prefer short-lived tokens validated at the edge over long-lived session cookies.',
  sourceProjectId: 'a'.repeat(40),
  recordedAt: '2026-09-20T10:00:00.000Z',
  decayPolicy: 'permanent',
  decayFeatures: 0,
  ...overrides,
});

describe('recordPattern — record one pattern (matrix row 1)', () => {
  it('is appended to patterns.jsonl and returned, and nowhere else', () => {
    const orchHome = home();
    const pattern = aPattern();

    const result = recordPattern(pattern, { orchHome });

    expect(result).toStrictEqual(pattern);
    const lines = readFileSync(patternsPath(orchHome), 'utf8').trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toStrictEqual(pattern);
  });

  it('lands under ORCH_HOME/memory/, the fixed cross-project home, never under projects/<id>/', () => {
    const orchHome = home();
    recordPattern(aPattern({ sourceProjectId: 'b'.repeat(40) }), { orchHome });

    expect(patternsPath(orchHome)).toBe(join(memoryDir(orchHome), 'patterns.jsonl'));
    expect(patternsPath(orchHome).startsWith(join(orchHome, 'projects'))).toBe(false);
  });
});

describe('CrossRepoPatternSchema — blank topic or blank pattern (matrix row 2)', () => {
  it('refuses a blank topic', () => {
    expect(() => CrossRepoPatternSchema.parse(aPattern({ topic: '' }))).toThrow();
  });

  it('refuses a whitespace-only pattern', () => {
    expect(() => CrossRepoPatternSchema.parse(aPattern({ pattern: '   ' }))).toThrow();
  });

  it('recordPattern refuses the same way, before ever touching the store', () => {
    const orchHome = home();
    expect(() => recordPattern(aPattern({ topic: '' }), { orchHome })).toThrow();
  });

  it('has no field capable of naming a file, a line, a module, or a symbol', () => {
    expect(Object.keys(CrossRepoPatternSchema.shape).sort()).toStrictEqual(
      ['decayFeatures', 'decayPolicy', 'pattern', 'recordedAt', 'sourceProjectId', 'topic'].sort(),
    );
  });

  it('refuses a blank sourceProjectId', () => {
    expect(() => CrossRepoPatternSchema.parse(aPattern({ sourceProjectId: '' }))).toThrow();
  });

  it('refuses a whitespace-only sourceProjectId', () => {
    expect(() => CrossRepoPatternSchema.parse(aPattern({ sourceProjectId: '   ' }))).toThrow();
  });

  it('refuses a topic or pattern with leading or trailing whitespace, rather than trimming it', () => {
    expect(() => CrossRepoPatternSchema.parse(aPattern({ topic: ' auth' }))).toThrow();
    expect(() => CrossRepoPatternSchema.parse(aPattern({ pattern: 'auth pattern ' }))).toThrow();
  });
});

describe('CrossRepoPatternSchema — decay policy (mirrors KnowledgeEntrySchema)', () => {
  it('refuses an n-features pattern with no N, and a count on a policy that never reads one', () => {
    expect(
      CrossRepoPatternSchema.safeParse(aPattern({ decayPolicy: 'n-features', decayFeatures: 0 })).success,
    ).toBe(false);
    expect(
      CrossRepoPatternSchema.safeParse(aPattern({ decayPolicy: 'permanent', decayFeatures: 4 })).success,
    ).toBe(false);
  });

  it('accepts an n-features pattern with a positive N', () => {
    expect(
      CrossRepoPatternSchema.safeParse(aPattern({ decayPolicy: 'n-features', decayFeatures: 3 })).success,
    ).toBe(true);
  });
});

describe('retrievePatterns — within budget (matrix row 3)', () => {
  it('returns all matching entries, most-recent-first, when the budget is not exceeded', () => {
    const orchHome = home();
    const oldest = aPattern({ recordedAt: '2026-09-01T00:00:00.000Z' });
    const middle = aPattern({ recordedAt: '2026-09-02T00:00:00.000Z' });
    const newest = aPattern({ recordedAt: '2026-09-03T00:00:00.000Z' });
    recordPattern(oldest, { orchHome });
    recordPattern(middle, { orchHome });
    recordPattern(newest, { orchHome });

    expect(retrievePatterns('auth', 5, { orchHome })).toStrictEqual([newest, middle, oldest]);
  });
});

describe('retrievePatterns — over budget (matrix row 4)', () => {
  it('returns only the two most recent of five', () => {
    const orchHome = home();
    const patterns = [0, 1, 2, 3, 4].map((day) =>
      aPattern({ recordedAt: `2026-09-0${String(day + 1)}T00:00:00.000Z` }),
    );
    for (const pattern of patterns) recordPattern(pattern, { orchHome });

    const result = retrievePatterns('auth', 2, { orchHome });

    expect(result).toStrictEqual([patterns[4], patterns[3]]);
  });
});

describe('retrievePatterns — a budget of zero returns nothing, never an error', () => {
  it('returns [] for budget 0 even when matching entries exist', () => {
    const orchHome = home();
    recordPattern(aPattern(), { orchHome });

    expect(retrievePatterns('auth', 0, { orchHome })).toStrictEqual([]);
  });
});

describe('retrievePatterns — a negative budget is clamped to zero, never an error', () => {
  it('returns [] for a negative budget even when matching entries exist', () => {
    const orchHome = home();
    recordPattern(aPattern(), { orchHome });

    expect(retrievePatterns('auth', -5, { orchHome })).toStrictEqual([]);
  });
});

describe('retrievePatterns — no matching topic (matrix row 5)', () => {
  it('returns an empty list when patterns exist only under other topics', () => {
    const orchHome = home();
    recordPattern(aPattern({ topic: 'deployment' }), { orchHome });

    expect(retrievePatterns('auth', 5, { orchHome })).toStrictEqual([]);
  });
});

describe('retrievePatterns — store does not exist yet (matrix row 6)', () => {
  it('returns an empty list when no project has ever recorded a pattern', () => {
    const orchHome = home();

    expect(retrievePatterns('auth', 5, { orchHome })).toStrictEqual([]);
  });
});

describe('retrievePatterns — one malformed line among valid ones (matrix row 7)', () => {
  it('skips the malformed line and still returns every valid one', () => {
    const orchHome = home();
    const valid = aPattern();
    recordPattern(valid, { orchHome });
    mkdirSync(memoryDir(orchHome), { recursive: true });
    appendFileSync(patternsPath(orchHome), 'not json at all\n', 'utf8');
    appendFileSync(patternsPath(orchHome), `${JSON.stringify({ topic: 'auth' })}\n`, 'utf8');
    const secondValid = aPattern({ recordedAt: '2026-09-21T00:00:00.000Z' });
    recordPattern(secondValid, { orchHome });

    expect(retrievePatterns('auth', 10, { orchHome })).toStrictEqual([secondValid, valid]);
  });
});

describe('retrievePatterns — two projects contribute to the same topic (matrix row 8)', () => {
  it('returns both, ordered by recordedAt, each still carrying its own provenance', () => {
    const orchHome = home();
    const fromFirstProject = aPattern({
      sourceProjectId: 'a'.repeat(40),
      recordedAt: '2026-09-10T00:00:00.000Z',
    });
    const fromSecondProject = aPattern({
      sourceProjectId: 'b'.repeat(40),
      recordedAt: '2026-09-11T00:00:00.000Z',
    });
    recordPattern(fromFirstProject, { orchHome });
    recordPattern(fromSecondProject, { orchHome });

    const result = retrievePatterns('auth', 5, { orchHome });

    expect(result).toStrictEqual([fromSecondProject, fromFirstProject]);
    expect(result[0]?.sourceProjectId).toBe('b'.repeat(40));
    expect(result[1]?.sourceProjectId).toBe('a'.repeat(40));
  });
});
