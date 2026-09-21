/**
 * CAP-10's tier selection: tier 0 for a typo, tier 1 for a small change, tier 2 for a real feature —
 * and the two refusals that keep the table honest in both directions.
 */
import { describe, expect, it } from 'vitest';

import {
  ContainerTaxError,
  ISOLATION_TIERS,
  TIER_1_MAX_FILES,
  TIER_1_MAX_LINES,
  TIER_MECHANISMS,
  TierSoftenedError,
  classifyTier,
  isDocumentationPath,
  selectTier,
  tierForShape,
  tierUsesContainer,
} from '../src/container/index.js';

describe('the three tiers', () => {
  it('are the mechanisms the architecture\'s table names', () => {
    expect(ISOLATION_TIERS).toStrictEqual([0, 1, 2]);
    expect(TIER_MECHANISMS[0]).toMatchObject({ branch: false, worktree: false, container: false });
    expect(TIER_MECHANISMS[1]).toMatchObject({ branch: true, worktree: false, container: false });
    expect(TIER_MECHANISMS[2]).toMatchObject({ branch: true, worktree: true, container: true });
    expect(tierUsesContainer(0)).toBe(false);
    expect(tierUsesContainer(1)).toBe(false);
    expect(tierUsesContainer(2)).toBe(true);
  });
});

describe('classification', () => {
  it('puts a typo-shaped change in tier 0', () => {
    expect(classifyTier({ paths: ['README.md'], changedLines: 1, kind: 'typo' }).tier).toBe(0);
    expect(classifyTier({ paths: ['src/engine/cli.ts'], changedLines: 1, kind: 'comment' }).tier).toBe(0);
    expect(classifyTier({ paths: ['docs/guide.md'], changedLines: 6 }).tier).toBe(0);
  });

  it('puts a small low-risk code change in tier 1', () => {
    const decision = classifyTier({
      paths: ['src/engine/dispositions.ts'],
      changedLines: 12,
      kind: 'small-fix',
    });
    expect(decision.tier).toBe(1);
    expect(decision.reason).toContain('small change');
  });

  it('puts a real feature in tier 2', () => {
    expect(classifyTier({ paths: ['src/container/wrapper.ts'], changedLines: 200, kind: 'feature' }).tier).toBe(2);
  });

  it('escalates on blast radius rather than on size', () => {
    // One line in a lockfile reaches further than a hundred inside a module.
    const lockfile = classifyTier({ paths: ['package-lock.json'], changedLines: 1 });
    expect(lockfile.tier).toBe(2);
    expect(lockfile.evidence).toStrictEqual(['package-lock.json']);
    for (const path of [
      '.github/workflows/ci.yml',
      'docker/Dockerfile',
      'infra/main.tf',
      'db/migrations/003_add.sql',
      '.env.example',
      '.orch/profile.toml',
    ]) {
      expect(classifyTier({ paths: [path], changedLines: 1 }).tier, path).toBe(2);
    }
  });

  it('escalates past the tier-1 ceilings', () => {
    const manyFiles = Array.from({ length: TIER_1_MAX_FILES + 1 }, (_, index) => `src/a${String(index)}.ts`);
    expect(classifyTier({ paths: manyFiles, changedLines: 10 }).tier).toBe(2);
    expect(classifyTier({ paths: ['src/a.ts'], changedLines: TIER_1_MAX_LINES + 1 }).tier).toBe(2);
  });

  it('raises the tier when the evidence for a lower one is missing', () => {
    // `changedLines` is optional, and reading an absent one as 0 walked a change of any size past both
    // tier-1 ceilings and then called it "a small change". An empty `paths` is the same failure from the
    // other side: no path can be high-blast-radius if no path was named. For a module whose whole stance
    // is refusal, the unknown case has to be the expensive one.
    expect(classifyTier({ paths: ['src/a.ts'] }).tier).toBe(2);
    expect(classifyTier({ paths: ['src/a.ts'] }).reason).toContain('size is unknown');
    expect(classifyTier({ paths: ['README.md'], kind: 'typo' }).tier).toBe(2);
    for (const changedLines of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const decision = classifyTier({ paths: ['src/a.ts'], changedLines });
      expect(decision.tier, String(changedLines)).toBe(2);
      expect(decision.reason, String(changedLines)).toContain('not a count');
    }
    const nothing = classifyTier({ paths: [], changedLines: 3 });
    expect(nothing.tier).toBe(2);
    expect(nothing.reason).toContain('no paths were named');
    // And the refusal to soften still applies, so missing evidence cannot be asked down to tier 1.
    expect(() => selectTier({ paths: [], changedLines: 3, requestedTier: 1 })).toThrow(TierSoftenedError);
  });

  it('does not let "documentation" talk a risky path out of a container', () => {
    // A README fix is tier 0; a README fix *plus* a workflow edit is not.
    expect(classifyTier({ paths: ['README.md', '.github/workflows/ci.yml'], changedLines: 4 }).tier).toBe(2);
  });

  it('recognises prose by extension and by name', () => {
    for (const path of ['README', 'docs/a.md', 'NOTES.txt', 'CHANGELOG.md', 'x/LICENSE']) {
      expect(isDocumentationPath(path), path).toBe(true);
    }
    for (const path of ['src/a.ts', 'Makefile', 'package.json']) {
      expect(isDocumentationPath(path), path).toBe(false);
    }
  });
});

describe('what a caller may and may not ask for', () => {
  it('refuses a tier below the classification', () => {
    let thrown: unknown;
    try {
      selectTier({ paths: ['package-lock.json'], changedLines: 3, requestedTier: 1 });
    } catch (error: unknown) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(TierSoftenedError);
    expect((thrown as Error).message).toContain('raised but never lowered');
    expect((thrown as TierSoftenedError).orchError.retryable).toBe(false);
  });

  it('rejects a container for a README fix as pure tax', () => {
    let thrown: unknown;
    try {
      selectTier({ paths: ['README.md'], changedLines: 2, kind: 'typo', requestedTier: 2 });
    } catch (error: unknown) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ContainerTaxError);
    expect((thrown as Error).message).toContain('pure tax');
  });

  it('allows a tier-1 change to be hardened into tier 2', () => {
    const decision = selectTier({ paths: ['src/a.ts'], changedLines: 10, requestedTier: 2 });
    expect(decision.tier).toBe(2);
    expect(decision.reason).toContain('raised');
  });

  it('is the same answer the wrapper derives from a shape', () => {
    expect(tierForShape({ paths: ['src/a.ts'], changedLines: 400, kind: 'feature' })).toBe(2);
    expect(tierForShape({ paths: ['README.md'], changedLines: 1 })).toBe(0);
  });
});
