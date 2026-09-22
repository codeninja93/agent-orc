/**
 * `isRepositoryRelativePath` — matrix rows 27, 28 and 29: the shared predicate, pinned in a suite
 * named for it, in both directions.
 *
 * **Why it gets a suite of its own.** Four contracts and the engine's territory ledger depend on this
 * one function — `step.analysis`, `step.planning`, `step.implementation` and
 * `recordTerritoryRedeclaration` — and until now it was asserted only through them, a case at a time,
 * inside suites about something else. A predicate tested only through its callers is tested only where
 * somebody thought to look, and this one failed in *both* directions at once while every caller's suite
 * stayed green: `./~/.ssh/id_rsa` was accepted, because the tilde test read the raw spelling and the
 * `./` prefix moved the tilde off the front; and `~notes.md` was refused, because it starts with a
 * tilde and is nonetheless an ordinary file a repository holds.
 *
 * So the two directions are equally weighted here. A refusal list with no acceptance list beside it
 * would be satisfied by a function that refuses everything.
 */
import { describe, expect, it } from 'vitest';

import {
  AnalysisOutputSchema,
  ImplementationOutputSchema,
  PlanningOutputSchema,
  isRepositoryRelativePath,
  normaliseTerritoryPath,
} from '../src/contracts/index.js';

/**
 * Paths outside the tree, each with the reason it is outside — so a row that stops being refused says
 * which escape reopened rather than only that a boolean changed.
 */
const OUTSIDE: readonly (readonly [string, string])[] = [
  ['/etc/passwd', 'an absolute POSIX path'],
  ['/', 'the filesystem root'],
  ['\\\\server\\share', 'a UNC path'],
  ['C:\\Windows', 'a Windows drive letter'],
  ['c:/windows', 'a lower-case drive letter'],
  ['..', 'the parent directory'],
  ['../secrets.env', 'a climb out of the tree'],
  ['src/../../secrets.env', 'a climb that only appears after normalising'],
  ['~', 'the home directory itself'],
  ['~/', 'the home directory with a trailing slash'],
  ['~/.ssh/id_rsa', 'a home-directory path'],
  ['./~/.ssh/id_rsa', 'a home-directory path spelled to dodge a raw-prefix check'],
  ['././~/.ssh/id_rsa', 'the same dodge, twice'],
  ['~/../etc/passwd', 'a home-directory path that then climbs'],
  ['', 'nothing at all'],
  ['   ', 'whitespace'],
  ['//', 'a doubled root that normalises to the whole repository'],
  ['src/..', 'a path that normalises to the whole repository by accident'],
];

/**
 * Paths inside the tree. The tilde rows are the point: a *file* whose name begins with `~` is real —
 * editors write `~tmp.ts`, Word writes `~$doc.docx`, people write `~notes.md` — and refusing them would
 * refuse a change to a file that exists.
 */
const INSIDE: readonly (readonly [string, string])[] = [
  ['src/engine/spawner.ts', 'an ordinary path'],
  ['src', 'a bare directory'],
  ['./src/engine', 'a path with a "./" prefix'],
  ['src/engine/', 'a path with a trailing slash'],
  ['.', 'the documented whole-repository spelling'],
  ['./', 'the other documented whole-repository spelling'],
  ['~notes.md', 'a root-level file whose name begins with a tilde'],
  ['~tmp.ts', 'an editor’s scratch file'],
  ['~$doc.docx', 'the lock file Word writes beside a document'],
  ['src/~backup.ts', 'a tilde-named file in a directory'],
  ['docs/a~b.md', 'a tilde inside a name'],
  ['a/~/b.ts', 'a tilde segment that is not the first'],
];

describe('the predicate refuses every spelling of "outside the run worktree" (matrix 28)', () => {
  it.each(OUTSIDE)('refuses %j, which is %s', (path) => {
    expect(isRepositoryRelativePath(path)).toBe(false);
  });

  /**
   * The specific regression: the tilde test is made against the **normalised** value, so a prefix that
   * changes the string without changing the path cannot move the tilde out of first position.
   */
  it('judges the normalised value, so "./" cannot smuggle a home path past the check', () => {
    expect(normaliseTerritoryPath('./~/.ssh/id_rsa')).toBe('~/.ssh/id_rsa');
    expect(isRepositoryRelativePath('~/.ssh/id_rsa')).toBe(false);
    expect(isRepositoryRelativePath('./~/.ssh/id_rsa')).toBe(false);
    // The two spellings are one path, so they must get one answer.
    expect(isRepositoryRelativePath('./~/.ssh/id_rsa')).toBe(
      isRepositoryRelativePath('~/.ssh/id_rsa'),
    );
  });
});

describe('the predicate accepts a path the repository really holds (matrix 27)', () => {
  it.each(INSIDE)('accepts %j, which is %s', (path) => {
    expect(isRepositoryRelativePath(path)).toBe(true);
  });

  it('separates a tilde segment from a name that merely begins with one', () => {
    // The whole distinction, in one pair: the first is the home directory, the second is a file.
    expect(isRepositoryRelativePath('~/notes.md')).toBe(false);
    expect(isRepositoryRelativePath('~notes.md')).toBe(true);
  });
});

/**
 * Matrix 29 — the four dependants, shown agreeing with the predicate rather than each carrying a copy
 * of the rule.
 *
 * One accepted and one refused spelling through each contract, so a contract that grew its own path
 * check would diverge visibly here instead of quietly.
 */
describe('every contract that declares paths inherits exactly this predicate', () => {
  const analysis = (path: string): unknown => ({
    contract_id: 'step.analysis',
    step: 's',
    status: 'completed',
    summary: 's',
    provenance: [],
    decisions: [],
    artifacts: [],
    questions: [],
    write_intents: [],
    error: null,
    claims: [
      {
        claim: 'c',
        paths: [],
        provenance: { step: 's', source: 'src/a.ts' },
      },
    ],
    territory: [path],
    files_read: [],
  });

  const planning = (path: string): unknown => ({
    contract_id: 'step.planning',
    step: 's',
    status: 'completed',
    summary: 's',
    provenance: [],
    decisions: [],
    artifacts: [],
    questions: [],
    write_intents: [],
    error: null,
    plan: [
      {
        step: 'one',
        phase: 'implementation',
        contract_id: 'step.implementation',
        intent: 'i',
        territory: [],
        provenance: { step: 's', source: 'src/a.ts' },
      },
    ],
    territory: [path],
  });

  const implementation = (path: string): unknown => ({
    contract_id: 'step.implementation',
    step: 's',
    status: 'blocked',
    summary: 's',
    provenance: [],
    decisions: [],
    artifacts: [],
    questions: [],
    write_intents: [],
    error: null,
    changes: [],
    territory: [path],
  });

  it.each([
    ['step.analysis', AnalysisOutputSchema, analysis],
    ['step.planning', PlanningOutputSchema, planning],
    ['step.implementation', ImplementationOutputSchema, implementation],
  ] as const)('%s refuses a home path and accepts a tilde-named file', (_id, schema, build) => {
    expect(schema.safeParse(build('~/.ssh/id_rsa')).success).toBe(false);
    expect(schema.safeParse(build('./~/.ssh/id_rsa')).success).toBe(false);
    expect(schema.safeParse(build('~notes.md')).success).toBe(true);
  });
});
