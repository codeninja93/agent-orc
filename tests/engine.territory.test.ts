/**
 * Consistency Conventions — "reconciliation is concurrent across features but serializes any features
 * whose declared file territories overlap".
 *
 * The two matrix rows are the headline: overlapping territories are serialised so exactly one feature
 * advances, and disjoint ones both advance in the same pass. The rest of this suite covers the
 * comparison itself, because the failure that corrupts a worktree is an overlap reported as disjoint —
 * two spellings of one path, or a directory not recognised as containing a file inside it.
 */
import { describe, expect, it } from 'vitest';

import {
  TerritoryLedger,
  admitByTerritory,
  normaliseTerritory,
  normaliseTerritoryPath,
  overlappingPaths,
  pathsCollide,
  territoriesOverlap,
} from '../src/engine/index.js';

/** Two run ids in ULID order, so "the older run" is unambiguous. */
const OLDER = '01K5NQ8ZJ7V3M2P9XQWRTC4BDE';
const NEWER = '01K5NQ9ZJ7V3M2P9XQWRTC4BDE';

describe('a declared territory is normalised before it is compared', () => {
  it.each([
    ['src/engine/', 'src/engine'],
    ['./src/engine', 'src/engine'],
    ['src//engine', 'src/engine'],
    ['src/engine/../engine', 'src/engine'],
    ['  src/engine  ', 'src/engine'],
    ['', '.'],
    ['.', '.'],
    // A territory is declared relative to the repository, so a leading slash is not a second root: it
    // normalises to the whole tree, which is the safe reading — it collides with everything.
    ['/', '.'],
  ])('normalises %o to %o', (declared, expected) => {
    expect(normaliseTerritoryPath(declared)).toBe(expected);
  });

  it('de-duplicates and sorts, so two spellings of one path are one entry', () => {
    expect(normaliseTerritory(['src/b', 'src/a/', './src/a', 'src/b'])).toStrictEqual([
      'src/a',
      'src/b',
    ]);
  });

  it('treats two spellings of one path as an overlap, not as disjoint', () => {
    // Reported as disjoint, this pair is two features editing one file in the same pass.
    expect(territoriesOverlap(['src/engine/'], ['./src/engine'])).toBe(true);
  });
});

describe('collision is by path segment, not by string prefix', () => {
  it('reads a directory as containing everything under it', () => {
    expect(pathsCollide('src/engine', 'src/engine/lock.ts')).toBe(true);
    expect(pathsCollide('src/engine/lock.ts', 'src/engine')).toBe(true);
  });

  it('does not read a shared prefix as containment', () => {
    // `startsWith` would claim these collide, and serialising unrelated features is a silent loss of
    // the concurrency the convention grants.
    expect(pathsCollide('src/engine', 'src/engine-notes.ts')).toBe(false);
    expect(pathsCollide('src/eng', 'src/engine')).toBe(false);
  });

  it('reads the repository root as colliding with everything', () => {
    expect(pathsCollide('.', 'src/engine/lock.ts')).toBe(true);
    expect(territoriesOverlap(['.'], ['docs/README.md'])).toBe(true);
  });

  it('names the actual colliding paths, not merely that a collision happened', () => {
    expect(
      overlappingPaths(['src/engine', 'docs/a.md'], ['src/engine/lock.ts', 'tests/b.ts']),
    ).toStrictEqual(['src/engine']);
  });
});

describe('overlapping territories are serialised', () => {
  const overlapping = [
    { run: NEWER, feature: 'b', territory: ['src/engine/lock.ts', 'tests/engine.lock.test.ts'] },
    { run: OLDER, feature: 'a', territory: ['src/engine', 'src/contracts/state.ts'] },
  ];

  it('admits exactly one of two features whose territories overlap', () => {
    const { admitted, deferred } = admitByTerritory(overlapping);
    expect(admitted).toHaveLength(1);
    expect(deferred).toHaveLength(1);
  });

  it('admits the older run, so the winner is the same on every pass and after a restart', () => {
    // Deliberately passed newest-first: admission must not depend on the order it is handed, which in
    // production is a directory listing.
    expect(admitByTerritory(overlapping).admitted[0]?.run).toBe(OLDER);
    expect(admitByTerritory([...overlapping].reverse()).admitted[0]?.run).toBe(OLDER);
  });

  it('names what blocked the deferred feature and which paths collided', () => {
    const deferral = admitByTerritory(overlapping).deferred[0];
    expect(deferral?.run).toBe(NEWER);
    expect(deferral?.blockedBy).toBe(OLDER);
    expect(deferral?.overlap).toStrictEqual(['src/engine/lock.ts']);
    expect(deferral?.reason).toContain('serialised');
  });

  it('serialises a chain transitively: a third feature overlapping the deferred one also waits', () => {
    const third = { run: '01K5NQAZJ7V3M2P9XQWRTC4BDE', feature: 'c', territory: ['src/engine'] };
    const { admitted, deferred } = admitByTerritory([...overlapping, third]);
    expect(admitted.map((entry) => entry.feature)).toStrictEqual(['a']);
    expect(deferred.map((entry) => entry.feature).sort()).toStrictEqual(['b', 'c']);
  });
});

describe('disjoint territories advance together', () => {
  it('admits both features in the same pass', () => {
    const { admitted, deferred } = admitByTerritory([
      { run: OLDER, feature: 'a', territory: ['src/engine'] },
      { run: NEWER, feature: 'b', territory: ['docs/specs'] },
    ]);
    expect(admitted.map((entry) => entry.feature)).toStrictEqual(['a', 'b']);
    expect(deferred).toStrictEqual([]);
  });

  it('admits every feature when no two territories touch, without a worker-count bound', () => {
    // Parallelism is bounded by conflict domain, not by a number: twelve disjoint features all advance.
    const candidates = Array.from({ length: 12 }, (_unused, index) => ({
      run: `01K5NQ8ZJ7V3M2P9XQWRTC4B${String.fromCharCode(65 + index)}E`,
      feature: `f${String(index)}`,
      territory: [`src/f${String(index)}`],
    }));
    expect(admitByTerritory(candidates).admitted).toHaveLength(12);
  });

  it('admits a feature with an empty declared territory alongside anything', () => {
    const { admitted } = admitByTerritory([
      { run: OLDER, feature: 'a', territory: [] },
      { run: NEWER, feature: 'b', territory: ['src/engine'] },
    ]);
    expect(admitted).toHaveLength(2);
  });

  it('admits nothing from an empty candidate list', () => {
    expect(admitByTerritory([])).toStrictEqual({ admitted: [], deferred: [] });
  });
});

describe('the ledger answers who holds a path', () => {
  it('refuses a claim that overlaps a held one, naming nothing it does not hold', () => {
    const ledger = new TerritoryLedger();
    expect(ledger.claim(OLDER, ['src/engine'])).toBe(true);
    expect(ledger.claim(NEWER, ['src/engine/lock.ts'])).toBe(false);
    expect(ledger.claim(NEWER, ['docs/specs'])).toBe(true);
    expect(ledger.runs).toStrictEqual([OLDER, NEWER]);
  });

  it('lets a run re-claim its own territory, so a second pass is not blocked by the first', () => {
    const ledger = new TerritoryLedger();
    expect(ledger.claim(OLDER, ['src/engine'])).toBe(true);
    expect(ledger.claim(OLDER, ['src/engine'])).toBe(true);
  });

  it('frees a territory on release, so the serialised feature advances next', () => {
    const ledger = new TerritoryLedger();
    ledger.claim(OLDER, ['src/engine']);
    expect(ledger.holderOf('src/engine/lock.ts')).toBe(OLDER);
    ledger.release(OLDER);
    expect(ledger.holderOf('src/engine/lock.ts')).toBeNull();
    expect(ledger.claim(NEWER, ['src/engine/lock.ts'])).toBe(true);
  });
});
