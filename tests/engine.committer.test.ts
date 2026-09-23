/**
 * Matrix 9–12 — the committer names the branch, from the profile, and no other unit names one at all.
 *
 * AD-22 states both halves: "the pattern is declared once in the project profile, defaulting to
 * `feature/<feature-slug>`, the committer is the only unit that creates or names a branch, and no other
 * unit may infer a branch name from a feature slug". The first half is ordinary behaviour and is tested
 * as such. The second is a rule about *source*, so it is a guard over `src/`, and two things this
 * project has already learned apply to it:
 *
 * - **It must recurse.** Story 1-10's `src/tui/` guard used a flat `readdirSync` and saw nine files of
 *   sixteen: the seven under `src/tui/cards/` — 44% of the directory, and the newest code in it — were
 *   checked by nothing. The sweep here is recursive and asserts it reached files two directories deep,
 *   so "it recursed" is a measurement rather than a flag passed.
 * - **It must match on what the code does, not on what it is called.** Story 2-4's guard matched names,
 *   and walked past a hardcoded table under a different one. So the signals below are derivations — a
 *   template, a concatenation, a substitution into a pattern, a concrete branch literal — and each is
 *   proved against a planted violation under an innocuous name in a subdirectory.
 *
 * And it must *not* fire on `takeoverBranchFor` or `runBranchFor`. Those are keyed on the run id
 * precisely so they cannot collide with, or pre-empt, the branch the committer names; a guard that made
 * the system's two legitimate branch namers illegal would be replaced rather than obeyed.
 */
import { readFileSync, readdirSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { DEFAULT_BRANCH_PATTERN } from '../src/contracts/index.js';
import { BranchPatternRefused, branchFor, branchPatternOf } from '../src/engine/index.js';
import { TAKEOVER_BRANCH_PREFIX, takeoverBranchFor } from '../src/runtime/index.js';

describe('the branch name comes from the profile’s pattern (matrix 9)', () => {
  it('substitutes the feature slug into the declared pattern', () => {
    expect(branchFor('release/<slug>', 'committer-branch-naming')).toBe(
      'release/committer-branch-naming',
    );
  });

  it('accepts AD-22’s own spelling of the placeholder as well as the installer’s', () => {
    // One placeholder, two spellings: the installer's default writes `<slug>` and AD-22 and every
    // profile fixture written against it spell the same thing `<feature-slug>`. Refusing the
    // architecture document's spelling would refuse a profile written to the architecture.
    expect(branchFor('feature/<feature-slug>', 'committer')).toBe('feature/committer');
    expect(branchFor('feature/<slug>', 'committer')).toBe('feature/committer');
  });

  it('defaults to feature/<slug> when the profile declares no pattern', () => {
    expect(branchPatternOf(null)).toBe(DEFAULT_BRANCH_PATTERN);
    expect(branchPatternOf('   ')).toBe(DEFAULT_BRANCH_PATTERN);
    expect(branchFor(null, 'committer-branch-naming')).toBe('feature/committer-branch-naming');
  });

  it('refuses a slug that is not a safe path segment, since a branch reaches git as an argument', () => {
    expect(() => branchFor(null, '../../etc')).toThrow();
    expect(() => branchFor(null, '')).toThrow();
  });
});

describe('a pattern that cannot vary is refused where it is read (matrix 10)', () => {
  it.each(['every-feature-on-one-branch', 'feature/main', 'feature/{slug}'])(
    'refuses "%s", naming the pattern and what to put in it',
    (pattern) => {
      let refusal: BranchPatternRefused | null = null;
      try {
        branchFor(pattern, 'committer-branch-naming');
      } catch (error) {
        refusal = error instanceof BranchPatternRefused ? error : null;
      }
      expect(refusal).not.toBeNull();
      expect(refusal?.code).toBe('config.invalid');
      expect(refusal?.pattern).toBe(pattern);
      // The refusal says what to change, not only that something is wrong: AD-35 routes this code to
      // `escalate-to-human`, and an escalation that does not say what the human is for gets ignored.
      expect(refusal?.message).toContain(pattern);
      expect(refusal?.message).toContain('<slug>');
      expect(refusal?.message).toContain('one branch for every feature');
    },
  );

  it('refuses it rather than quietly appending the slug, which would hide the defect', () => {
    // The tempting repair — treat a pattern with no placeholder as a prefix — produces a *working*
    // branch name and leaves the profile saying something nobody meant. A refusal is what makes a
    // person fix the file.
    expect(() => branchFor('release', 'one')).toThrow(BranchPatternRefused);
  });
});

// -------------------------------------------------------------------------------------------------
// Matrix 11, 12 — the recursive guard
// -------------------------------------------------------------------------------------------------

/**
 * The one file AD-22 permits to derive a branch name from a feature slug.
 *
 * An exemption list rather than a name pattern, and one entry long. A guard that exempted "files whose
 * name contains `committer`" would exempt every future file somebody called that, which is the
 * name-matching weakness story 2-4 found one layer over.
 */
const COMMITTER_SOURCE = 'engine/committer.ts';

const stripComments = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

/** A literal that is already most of a branch name: `feature/`, `branch/`, `refs/heads/`. */
const BRANCHISH_LITERAL = /(?:^|[^A-Za-z])(?:feature|feat|branch|branches|heads)\//i;

/** An expression carrying a feature slug, however it is spelled. */
const SLUGGISH =
  /(?:\bslug\b|\bslugs\b|slug[A-Z_]|[a-z_]slug\b|<(?:feature-)?slug>|\bfeature(?:_?name|Slug|_slug)\b)/i;

/** An expression naming a branch — a prefix constant, a helper, a field. */
const BRANCHY = /branch/i;

/** The branch pattern, or the placeholder a slug is substituted into it at. */
const PATTERNISH = /(?:branch_pattern|branchPattern|BRANCH_SLUG|<(?:feature-)?slug>|placeholder)/i;

/** The operations that *produce* a string from a template, as opposed to inspecting one. */
const SUBSTITUTION = /\.(?:replace|replaceAll|split)\s*\(/;

const INTERPOLATION = /\$\{([^{}]*(?:\{[^{}]*\}[^{}]*)*)\}/g;

interface BranchNamingViolation {
  readonly signal: string;
  readonly evidence: string;
}

/**
 * Where a source derives a branch name from a feature slug, one entry per derivation.
 *
 * Four signals, each a way of *producing* a name rather than of holding a pattern. The distinction is
 * what keeps the declaration site legal: `src/contracts/installer.ts` holds the placeholders and asks
 * `pattern.includes(placeholder)`, which produces no string and names no branch, while
 * `pattern.split(placeholder).join(slug)` does both.
 *
 * In the template signal the branch evidence and the slug evidence must come from *different* places.
 * Without that, one interpolation of `BRANCH_SLUG_PLACEHOLDERS` satisfies both halves on its own, and
 * the interview's refusal message — prose about a pattern, naming no branch — was reported as a
 * violation. A rule that fires on the sentence explaining the rule is one that gets switched off.
 */
export const branchNamingViolationsIn = (source: string): readonly BranchNamingViolation[] => {
  const stripped = stripComments(source);
  const found: BranchNamingViolation[] = [];

  for (const template of stripped.match(/`(?:[^`\\]|\\.)*`/gs) ?? []) {
    const parts = [...template.matchAll(INTERPOLATION)].map((match) => match[1] ?? '');
    const statics = template.replace(INTERPOLATION, '');
    const sluggish = parts.filter((part) => SLUGGISH.test(part));
    const branchy =
      BRANCHISH_LITERAL.test(statics) ||
      parts.some((part) => BRANCHY.test(part) && !SLUGGISH.test(part));
    if (branchy && sluggish.length > 0) {
      found.push({ signal: 'template', evidence: template.trim() });
    }
  }

  for (const match of stripped.matchAll(/(['"])((?:[^'"\\]|\\.)*)\1\s*\+\s*([A-Za-z_$][\w$.]*)/g)) {
    if (BRANCHISH_LITERAL.test(match[2] ?? '') && SLUGGISH.test(match[3] ?? '')) {
      found.push({ signal: 'concatenation', evidence: match[0].trim() });
    }
  }

  for (const line of stripped.split('\n')) {
    if (SUBSTITUTION.test(line) && PATTERNISH.test(line)) {
      found.push({ signal: 'substitution', evidence: line.trim() });
    }
  }

  // A concrete branch name spelled in code — the hardcoded table story 2-4's guard walked past. A
  // literal whose tail is a placeholder is excluded: that is a template, and a template is not a name.
  for (const match of stripped.matchAll(/(['"])((?:feature|feat|branch)\/(?:[^'"\\<]|\\.)+)\1/gi)) {
    found.push({ signal: 'literal', evidence: match[0] });
  }

  return found;
};

describe('no unit but the committer derives a branch name from a feature slug (matrix 11)', () => {
  const sourceRoot = new URL('../src/', import.meta.url);
  const files = readdirSync(sourceRoot, { recursive: true })
    .filter((name): name is string => typeof name === 'string' && name.endsWith('.ts'))
    .sort();

  it('sweeps src/ recursively, reaching files two directories deep', () => {
    expect(files.length).toBeGreaterThan(50);
    // The measurement story 1-10's guard did not make. `src/tui/cards/` is the deepest directory in the
    // tree and the newest code in it; a flat read would list none of these.
    const deep = files.filter((file) => file.split('/').length >= 3);
    expect(deep.length).toBeGreaterThan(0);
    expect(deep.some((file) => file.startsWith('tui/cards/'))).toBe(true);
    // And the two legitimate branch namers are inside the sweep, so the assertion below that they do
    // not trip it is about files that were actually read.
    expect(files).toContain('runtime/branches.ts');
    expect(files).toContain('pool/worktree.ts');
    expect(files).toContain(COMMITTER_SOURCE);
  });

  it('finds no derivation outside the committer', () => {
    const offenders = new Map<string, readonly BranchNamingViolation[]>();
    for (const file of files) {
      if (file === COMMITTER_SOURCE) continue;
      const violations = branchNamingViolationsIn(readFileSync(new URL(file, sourceRoot), 'utf8'));
      if (violations.length > 0) offenders.set(file, violations);
    }
    expect(
      [...offenders.entries()].map(([file, violations]) => `${file}: ${JSON.stringify(violations)}`),
    ).toStrictEqual([]);
  });

  /**
   * The positive control, without which the assertion above is satisfied by a guard that finds nothing
   * anywhere. The committer really does derive a branch name, and the guard really does see it — so
   * "no violations elsewhere" is a fact about the rest of `src/` rather than about the detector.
   */
  it('does see the committer’s own derivation, so the sweep is not vacuous', () => {
    const violations = branchNamingViolationsIn(
      readFileSync(new URL(COMMITTER_SOURCE, sourceRoot), 'utf8'),
    );
    expect(violations.length).toBeGreaterThan(0);
    expect(violations.map((violation) => violation.signal)).toContain('substitution');
  });
});

describe('the guard catches a planted violation, under an innocuous name (matrix 11)', () => {
  it.each([
    [
      'tui/cards/label.ts',
      'export const label = (featureSlug: string): string => `feature/${featureSlug}`;',
    ],
    [
      'pool/naming.ts',
      "export const target = (slug: string): string => 'feature/' + slug;",
    ],
    [
      'runtime/formatting.ts',
      "export const at = (profile: Profile, feature: string): string =>\n" +
        "  profile.branch_pattern.replace('<slug>', feature);",
    ],
    [
      'tui/cards/preset.ts',
      "const KNOWN_WORK = { login: 'feature/login', signup: 'feature/signup' };",
    ],
    [
      'engine/labels.ts',
      'export const ref = (featureSlug: string): string => `${BRANCH_PREFIX}${featureSlug}`;',
    ],
  ])('catches the derivation planted in %s', (_file, source) => {
    expect(branchNamingViolationsIn(source).length).toBeGreaterThan(0);
  });

  it('is not fooled by a comment, which is where a violation would hide from a naive sweep', () => {
    // The stripping cuts both ways, and this is the direction that matters: prose *about* the rule is
    // not a violation of it, which is why every docblock in `src/runtime/branches.ts` may say
    // `feature/<slug>` out loud.
    expect(
      branchNamingViolationsIn('// const branch = `feature/${slug}`;\nexport const x = 1;\n'),
    ).toStrictEqual([]);
    expect(
      branchNamingViolationsIn('/** pre-empt the `feature/<slug>` branch */\nexport const y = 2;\n'),
    ).toStrictEqual([]);
  });
});

describe('the run-id-keyed branches do not trip the guard (matrix 12)', () => {
  it('leaves takeoverBranchFor alone, which is why it can stay where it is', () => {
    // Its docblock says it "cannot collide with, or pre-empt, the `feature/<slug>` branch the committer
    // will create" — because it derives from a ULID the engine minted, which carries no product
    // meaning. A guard that made this illegal would be a guard nobody could satisfy.
    const source = readFileSync(new URL('../src/runtime/branches.ts', import.meta.url), 'utf8');
    expect(branchNamingViolationsIn(source)).toStrictEqual([]);
    expect(takeoverBranchFor('01JBQ8Z1X2Y3W4V5U6T7S8R9Q0')).toBe(
      `${TAKEOVER_BRANCH_PREFIX}01JBQ8Z1X2Y3W4V5U6T7S8R9Q0`,
    );
  });

  it('leaves the worktree’s orch/run/<run-id> branch alone for the same reason', () => {
    const source = readFileSync(new URL('../src/pool/worktree.ts', import.meta.url), 'utf8');
    expect(branchNamingViolationsIn(source)).toStrictEqual([]);
  });

  it('sees the difference between a run id and a slug, rather than between two file names', () => {
    // The same shape twice: one interpolated with a run id, one with a feature slug. If the guard were
    // keyed on where the code lives, both of these would pass.
    expect(
      branchNamingViolationsIn(
        'export const a = (run: string): string =>\n' +
          '  `${TAKEOVER_BRANCH_PREFIX}${assertSafePathSegment(run, \'a run id\')}`;',
      ),
    ).toStrictEqual([]);
    expect(
      branchNamingViolationsIn(
        'export const b = (slug: string): string =>\n' +
          '  `${TAKEOVER_BRANCH_PREFIX}${assertSafePathSegment(slug, \'a feature slug\')}`;',
      ).length,
    ).toBeGreaterThan(0);
  });
});
