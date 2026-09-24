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
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import {
  COMMIT_COMPOSED_EVENT_TYPE,
  CommittingOutputSchema,
  DEFAULT_BRANCH_PATTERN,
  NOTE_REF,
  StepOutputSchema,
  branchPatternProblem,
} from '../src/contracts/index.js';
import type { EventEnvelope } from '../src/contracts/index.js';
import {
  BranchPatternRefused,
  COMPOSED_COMMIT_RELATIVE_PATH,
  NoteUncomposable,
  Reconciler,
  STANDARD_PLAN_STEPS,
  branchFor,
  branchPatternOf,
  createScriptedExecutor,
  noteFor,
  terminated,
} from '../src/engine/index.js';
import {
  TAKEOVER_BRANCH_PREFIX,
  readEventLog,
  runPaths,
  takeoverBranchFor,
} from '../src/runtime/index.js';

import { makePlan, planProvider } from './helpers/engine-fixture.js';
import { sourceFilesUnder, stripComments } from './helpers/source-sweep.js';

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


describe('a pattern that could not name a git branch is refused (matrix 10)', () => {
  /**
   * The second question the placeholder check does not ask.
   *
   * A pattern is a template for an argument `git` receives, and every one of these has a placeholder —
   * so `branchPatternVaries` passes all of them, and only a ref-format check stops them reaching argv.
   * `feature/../<slug>` is the sharp one: it varies, it is a valid template, and it climbs a path.
   */
  it.each([
    ['feature/../<slug>', '".."'],
    ['-feature/<slug>', '"-"'],
    ['feature /<slug>', 'whitespace'],
    ['feature/~<slug>', 'control character'],
    ['feature//<slug>', 'empty path component'],
    ['feature/<slug>.lock', '".lock"'],
    ['feature/<slug>/', 'ends with "/"'],
    ['feature/.<slug>', 'starts with "."'],
  ])('refuses %s', (pattern, expected) => {
    let refusal: BranchPatternRefused | null = null;
    try {
      branchFor(pattern, 'committer');
    } catch (error) {
      refusal = error instanceof BranchPatternRefused ? error : null;
    }
    expect(refusal, pattern).not.toBeNull();
    expect(refusal?.code).toBe('config.invalid');
    expect(refusal?.message, pattern).toContain(expected);
  });

  it('is the same question the profile asks when it is parsed', () => {
    // `.orch/profile.toml` is human-edited, so the interview is the first gate and not the only one.
    expect(branchPatternProblem('feature/<slug>')).toBeNull();
    expect(branchPatternProblem('feature/../<slug>')).not.toBeNull();
  });

  /**
   * An unsafe feature slug leaves this unit with a code, not as a bare path error.
   *
   * AD-35 binds every failure crossing a unit boundary, and `UnsafePathSegmentError` carries none — so
   * a caller routing it reached the unknown-code fallback and abandoned the run for a reason the table
   * never named.
   */
  it('refuses an unsafe feature slug with a declared disposition code', () => {
    let refusal: BranchPatternRefused | null = null;
    try {
      branchFor('feature/<slug>', '../../etc');
    } catch (error) {
      refusal = error instanceof BranchPatternRefused ? error : null;
    }
    expect(refusal).not.toBeNull();
    expect(refusal?.code).toBe('config.invalid');
    expect(refusal?.message).toContain('../../etc');
  });

  /**
   * A record that cannot make a note is a named refusal too, for the same reason.
   *
   * A raw `ZodError` out of `composeCommit` carries no code and no run id, and the reconciler catches
   * this on the path where a step has just completed — the worst moment to lose both.
   */
  it('refuses a record that cannot make a note, naming the run and carrying a code', () => {
    let refusal: NoteUncomposable | null = null;
    try {
      noteFor(
        {
          run: '01JBQ8Z1X2Y3W4V5U6T7S8R9Q0',
          feature: 'committer',
          // No steps: a note is written on a merge commit, so a run that took none never reaches one.
          steps: [],
          acceptance_criteria: ['one'],
          usage: null,
          decisions: [],
        },
        'feature/committer',
      );
    } catch (error) {
      refusal = error instanceof NoteUncomposable ? error : null;
    }
    expect(refusal).not.toBeNull();
    expect(refusal?.code).toBe('config.invalid');
    expect(refusal?.run).toBe('01JBQ8Z1X2Y3W4V5U6T7S8R9Q0');
    expect(refusal?.message).toContain('steps');
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
  const files = sourceFilesUnder(sourceRoot);

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

// -------------------------------------------------------------------------------------------------
// Matrix 20 — the executor is story 2-11's, and nothing here performs a write
// -------------------------------------------------------------------------------------------------

/** Git subcommands that write somewhere this process does not own. */
const WRITING_SUBCOMMANDS = ['push', 'notes', 'tag'];

/** Ways of creating a pull request, none of which is a git subcommand. */
const PULL_REQUEST_CALLS = [/\bgh\b[^\n]{0,40}\bpr\b/i, /api\.github\.com/i, /\/pulls\b/];

/** The two AD-15 lines story 2-11 introduces; nothing may emit either yet. */
const EXECUTOR_EVENT_TYPES = ['write.attempted', 'write.executed'];

/** Where a child process is started. A write this story forbids has to go through one of these. */
const PROCESS_INVOCATION = /\b(?:execFileSync|execFile|execSync|exec|spawnSync|spawn)\s*\(/g;

/** How far past an invocation its argument list can reasonably run. */
const ARGV_WINDOW = 300;

interface PerformedWrite {
  readonly signal: string;
  readonly evidence: string;
}

/**
 * Where a source *performs* one of the three writes this story only composes.
 *
 * The signals are invocations and emissions, not names: a subcommand handed to a child process, a
 * pull-request API reached over the network, and the two event types whose whole purpose is to record a
 * write being attempted. The last is the sharpest of the three — AD-15 fixes the durability order, so
 * the executor cannot exist without emitting `write.attempted`, and a build in which nothing emits it is
 * a build in which nothing executes an intent.
 *
 * **The subcommand signal is scoped to a process invocation, not to the whole file.** A bare `'tag'` or
 * `'push'` literal anywhere under `src/` is a guard that will one day fire on a renderer's label or a
 * vocabulary entry, and a guard whose first real encounter is a false positive gets weakened rather than
 * obeyed. What it must catch is a subcommand reaching `git`, so it looks in the argument list of a call
 * that starts a process — which is the only place one can.
 *
 * `src/contracts/event.ts` declares the vocabulary and is exempt from the event signal alone: declaring
 * a type is not emitting one, and the vocabulary has carried both names since story 1-1.
 */
export const performedWritesIn = (file: string, source: string): readonly PerformedWrite[] => {
  const stripped = stripComments(source);
  const found: PerformedWrite[] = [];
  for (const call of stripped.matchAll(PROCESS_INVOCATION)) {
    const argv = stripped.slice(call.index, call.index + ARGV_WINDOW);
    for (const subcommand of WRITING_SUBCOMMANDS) {
      if (new RegExp(`(['"\`])${subcommand}\\1`).test(argv)) {
        found.push({ signal: 'git-subcommand', evidence: subcommand });
      }
    }
  }
  for (const call of PULL_REQUEST_CALLS) {
    const match = call.exec(stripped);
    if (match !== null) found.push({ signal: 'pull-request-call', evidence: match[0] });
  }
  if (file !== 'contracts/event.ts') {
    for (const type of EXECUTOR_EVENT_TYPES) {
      if (stripped.includes(`'${type}'`) || stripped.includes(`"${type}"`)) {
        found.push({ signal: 'executor-event', evidence: type });
      }
    }
  }
  return found;
};

describe('the engine performs no push, pull request or note write (matrix 20)', () => {
  const sourceRoot = new URL('../src/', import.meta.url);
  const files = sourceFilesUnder(sourceRoot);

  it('sweeps the whole of src/ recursively, not only src/engine/', () => {
    // AD-15 binds every unit, not the engine alone, and the write that matters would be as damaging
    // from `src/runner/` or `src/pool/` — both of which already run git.
    expect(files.length).toBeGreaterThan(50);
    expect(files.some((file) => file.split('/').length >= 3)).toBe(true);
    expect(files).toContain('pool/worktree.ts');
    expect(files).toContain('engine/committer.ts');
  });

  /**
   * The one file this story's own docblock named in advance: "the executor is story 2-11's".
   *
   * `engine/write-executor.ts` is that executor, landed by story 2-11 — it is the enumerated AD-15 write
   * surface's one performer, and its whole job is exactly what every other file under `src/` is held to
   * never doing. Named by exact path rather than by a pattern, so a second file quietly growing the same
   * capability is still caught.
   */
  const EXECUTOR_FILE = 'engine/write-executor.ts';

  it('finds none anywhere under src/ but the one file that is the executor', () => {
    const offenders = new Map<string, readonly PerformedWrite[]>();
    for (const file of files) {
      if (file === EXECUTOR_FILE) continue;
      const performed = performedWritesIn(file, readFileSync(new URL(file, sourceRoot), 'utf8'));
      if (performed.length > 0) offenders.set(file, performed);
    }
    expect(
      [...offenders.entries()].map(([file, writes]) => `${file}: ${JSON.stringify(writes)}`),
    ).toStrictEqual([]);
  });

  it('confirms the one exemption is real and not just declared', () => {
    // If write-executor.ts stopped performing any of the three writes, this guard's exemption would be
    // dead weight — worth knowing, since a dead exemption is a door left open for the next file.
    const performed = performedWritesIn(
      EXECUTOR_FILE,
      readFileSync(new URL(EXECUTOR_FILE, sourceRoot), 'utf8'),
    );
    expect(performed.length).toBeGreaterThan(0);
  });

  /**
   * The positive control. Without it, "no violations" is satisfied by a detector that matches nothing —
   * which is how an absence assertion passes against a renamed constant or a typo in a regex.
   */
  it.each([
    ['engine/executor.ts', "execFileSync('git', ['push', '--set-upstream', remote, branch]);"],
    ['engine/committer.ts', "await run('gh', ['pr', 'create', '--title', title]);"],
    ['runner/pulls.ts', "await fetch('https://api.github.com/repos/o/r/pulls', { method: 'POST' });"],
    ['engine/labels.ts', "execFileSync('git', ['notes', '--ref', NOTE_REF, 'add', '-m', body]);"],
    ['engine/intents.ts', "recorder.append({ type: 'write.attempted', payload: { key } });"],
  ])('catches the write planted in %s', (file, source) => {
    expect(performedWritesIn(file, source).length).toBeGreaterThan(0);
  });

  it('does not read a declaration of the vocabulary as an emission of it', () => {
    // `src/contracts/event.ts` has carried both names since story 1-1, and it is the file that must.
    expect(performedWritesIn('contracts/event.ts', "const t = ['write.attempted'];")).toStrictEqual(
      [],
    );
    expect(
      performedWritesIn('engine/intents.ts', "const t = ['write.attempted'];").length,
    ).toBeGreaterThan(0);
  });

  /**
   * The narrowing, asserted so it is a decision rather than a hole.
   *
   * A subcommand word is only a write when it reaches a process. A renderer's label that happens to say
   * `'tag'`, or a vocabulary entry spelling `'push'`, is neither — and a guard that fired on those would
   * be switched off the first time it did.
   */
  it('reads a subcommand word only where it could reach a process', () => {
    expect(performedWritesIn('tui/cards/label.ts', "const LABELS = ['push', 'tag'];")).toStrictEqual(
      [],
    );
    expect(
      performedWritesIn('pool/worktree.ts', "execFileSync('git', ['worktree', 'add', path]);"),
    ).toStrictEqual([]);
  });
});

// -------------------------------------------------------------------------------------------------
// Matrix 26, 27 — the reconciler calls the composer, and keeps what it produced
// -------------------------------------------------------------------------------------------------

/**
 * The join the story is named for, asserted at the level it happens.
 *
 * `composeCommit` existed and nothing called it: the standard plan spawned a committing step, its
 * output was parsed against `step.committing` and then dropped. That is the same shape as story 2-4's
 * original `recordDeclaredTerritory` gap, and it is invisible to a unit test — every assertion about
 * the composer passed while the composer was not in the system. So these drive a real reconciler and
 * read the run's own log and directory back.
 */
describe('a completed committing step composes the commit, and the run keeps it', () => {
  const homes: string[] = [];
  const home = (): string => {
    const made = mkdtempSync(join(tmpdir(), 'orch-commit-'));
    homes.push(made);
    return made;
  };

  afterAll(() => {
    for (const made of homes) rmSync(made, { recursive: true, force: true });
  });

  const committingOutput = (step: string): Record<string, unknown> => ({
    contract_id: 'step.committing',
    step,
    status: 'completed',
    summary: 'Composed the pull-request prose.',
    provenance: ['commit: src/engine/committer.ts'],
    decisions: [],
    artifacts: [],
    questions: [],
    write_intents: [],
    error: null,
    pull_request_title: '  Committer: branch naming and the AD-22 note  ',
    pull_request_body: 'The committer names the branch and the engine records the note.',
  });

  const driveToCommit = async (
    orchHome: string,
  ): Promise<{ readonly run: string; readonly events: readonly EventEnvelope[] }> => {
    const plan = makePlan({ feature: 'committer-wiring', steps: STANDARD_PLAN_STEPS });
    const reconciler = Reconciler.open({
      orchHome,
      plans: planProvider(plan),
      baseline: { currentRef: () => 'a'.repeat(40), resetTo: () => undefined },
      executor: createScriptedExecutor({
        onStart: (request) => {
          if (request.phase !== 'committing') return terminated(request.step, 'completed', {});
          const raw = committingOutput(request.step);
          return terminated(request.step, 'completed', {
            output: StepOutputSchema.parse(raw),
            contractOutput: CommittingOutputSchema.parse(raw),
          });
        },
      }),
    });
    try {
      const accepted = reconciler.acceptFeature(plan);
      reconciler.confirm(accepted.run);
      await reconciler.runUntilSettled();
      return { run: accepted.run, events: readEventLog(runPaths(accepted.run, orchHome).eventLog) };
    } finally {
      reconciler.close();
    }
  };

  it('records a commit.composed line naming the branch, the intents and the note ref', async () => {
    const orchHome = home();
    const { events } = await driveToCommit(orchHome);
    const composed = events.find((event) => event.type === COMMIT_COMPOSED_EVENT_TYPE);
    expect(composed, 'nothing composed a commit for a completed committing step').toBeDefined();
    expect(composed?.payload['composed_branch']).toBe('feature/committer-wiring');
    expect(composed?.payload['intent_ids']).toStrictEqual([
      'commit.git_push',
      'commit.pull_request',
      'commit.git_note',
    ]);
    expect(composed?.payload['note_ref']).toBe(NOTE_REF);
  });

  /**
   * Matrix 27 — the composition is kept where story 2-11 can read it, not dropped after the call.
   *
   * On disk rather than in the payload because the note carries the run id, and AD-21's entropy sweep
   * rewrites an unbroken ULID wherever it appears in a payload — so a note passed through the event
   * would reach the executor with its run id replaced by a marker.
   */
  it('writes the composed commit into the run, with the note and the three intents', async () => {
    const orchHome = home();
    const { run, events } = await driveToCommit(orchHome);
    const composed = events.find((event) => event.type === COMMIT_COMPOSED_EVENT_TYPE);
    const relative = String(composed?.payload['artifact']);
    expect(relative).toBe(COMPOSED_COMMIT_RELATIVE_PATH);

    const artifact: unknown = JSON.parse(
      readFileSync(join(runPaths(run, orchHome).runDir, relative), 'utf8'),
    );
    const held = artifact as {
      readonly branch: string;
      readonly pull_request: { readonly title: string; readonly head: string };
      readonly note: { readonly run: string; readonly steps: readonly { readonly step: string }[] };
      readonly intents: readonly { readonly kind: string; readonly target: string }[];
    };

    expect(held.branch).toBe('feature/committer-wiring');
    expect(held.pull_request.head).toBe(held.branch);
    // The trimmed title reaches the plan, which is the half that becomes the pull request.
    expect(held.pull_request.title).toBe('Committer: branch naming and the AD-22 note');
    expect(held.intents.map((intent) => intent.kind)).toStrictEqual([
      'git_push',
      'pull_request',
      'git_note',
    ]);

    // The note's step list is the *run's*, folded from the log — including the committing step that
    // had only just terminated, which the pre-termination checkpoint still showed as in flight.
    expect(held.note.run).toBe(run);
    expect(held.note.steps.map((step) => step.step)).toStrictEqual([
      'analyse',
      'plan',
      'implement',
      'test',
      'verify',
      'commit',
    ]);
  });

  it('composes nothing for a step that returned no prose, and says nothing about it', async () => {
    // The negative control: the composer is keyed on the output's prose, not on the phase, so a plan
    // with no committing output must produce no line rather than an empty composition.
    const orchHome = home();
    const plan = makePlan({ feature: 'no-committing-step' });
    const reconciler = Reconciler.open({
      orchHome,
      plans: planProvider(plan),
      baseline: { currentRef: () => 'a'.repeat(40), resetTo: () => undefined },
      executor: createScriptedExecutor({
        onStart: (request) => terminated(request.step, 'completed', {}),
      }),
    });
    try {
      const accepted = reconciler.acceptFeature(plan);
      reconciler.confirm(accepted.run);
      await reconciler.runUntilSettled();
      const events = readEventLog(runPaths(accepted.run, orchHome).eventLog);
      expect(events.some((event) => event.type === COMMIT_COMPOSED_EVENT_TYPE)).toBe(false);
    } finally {
      reconciler.close();
    }
  });
});
