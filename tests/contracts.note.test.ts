/**
 * Matrix 5 and 6 — AD-22's git note as a versioned artifact.
 *
 * Two claims are under test and they pull in opposite directions. The note must *carry* what AD-22 says
 * it carries, item by item, because a field left out is a run whose record cannot be reconstructed from
 * the repository once the worktree and the central state are gone. And it must carry its own version
 * under ADR-005, because a note written last month has to stay readable when the profile gains a field —
 * which is the failure that decision was taken over, measured rather than argued.
 *
 * The third claim is about where the note's content comes from, and it is asserted in
 * `tests/contracts.committing.test.ts` rather than here: this file holds the shape, that one holds the
 * refusal that keeps a model out of it.
 */
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  CURRENT_SCHEMA_VERSION,
  GitNoteSchema,
  NOTE_CONTRACT_ID,
  NOTE_REF,
  NOTE_SCHEMA_VERSION,
  RunStateSchema,
  SCHEMA_VERSION_UNRECOGNISED_CODE,
  SchemaVersionRefusal,
  getContract,
  parseVersionedArtifact,
} from '../src/contracts/index.js';
import type { GitNote } from '../src/contracts/index.js';

import { sourceFilesUnder, stripComments } from './helpers/source-sweep.js';

const NOTE_ARTIFACT_NAME = 'the AD-22 git note';

const note = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  schema_version: NOTE_SCHEMA_VERSION,
  run: '01JBQ8Z1X2Y3W4V5U6T7S8R9Q0',
  feature: 'committer-branch-naming',
  branch: 'feature/committer-branch-naming',
  steps: [
    { step: 'analyse', phase: 'analysis', disposition: 'completed' },
    { step: 'plan', phase: 'planning', disposition: 'completed' },
    { step: 'implement', phase: 'implementation', disposition: 'completed' },
    { step: 'test', phase: 'testing', disposition: 'completed' },
    { step: 'verify', phase: 'verification', disposition: 'completed' },
    { step: 'commit', phase: 'committing', disposition: 'completed' },
  ],
  acceptance_criteria: ['The branch name comes from the profile', 'The note carries the run record'],
  usage: {
    cost_usd: 0.42,
    input_tokens: 1200,
    output_tokens: 300,
    cache_creation_input_tokens: null,
    cache_read_input_tokens: 800,
  },
  decisions: [
    {
      question: 'Which placeholder does the branch pattern use?',
      answer: 'Both spellings, declared once',
      rationale: 'AD-22 and the installer spell one placeholder two ways',
    },
  ],
  ...overrides,
});

const parsed = (overrides: Record<string, unknown> = {}): GitNote =>
  GitNoteSchema.parse(note(overrides));

describe('the note carries what AD-22 says a run leaves behind (matrix 5)', () => {
  it('records the run id, the ordered steps with dispositions, the criteria, the usage and the decisions', () => {
    const record = parsed();
    expect(record.run).toBe('01JBQ8Z1X2Y3W4V5U6T7S8R9Q0');
    expect(record.steps.map((step) => [step.step, step.disposition])).toStrictEqual([
      ['analyse', 'completed'],
      ['plan', 'completed'],
      ['implement', 'completed'],
      ['test', 'completed'],
      ['verify', 'completed'],
      ['commit', 'completed'],
    ]);
    expect(record.acceptance_criteria).toStrictEqual([
      'The branch name comes from the profile',
      'The note carries the run record',
    ]);
    expect(record.usage?.input_tokens).toBe(1200);
    expect(record.decisions).toHaveLength(1);
  });

  /**
   * Order, not membership. AD-22 says "the ordered step list", and a note that held the same six steps
   * in a different order would be a record of a run that happened differently — which is a lie a reader
   * has no second source to catch, since `events.jsonl` is exactly what the note outlives.
   */
  it('keeps the steps in the order the run met them, rather than sorting or grouping them', () => {
    const reversed = parsed({
      steps: [...(note()['steps'] as readonly unknown[])].reverse(),
    });
    expect(reversed.steps[0]?.step).toBe('commit');
    expect(reversed.steps[5]?.step).toBe('analyse');
  });

  /**
   * Absence stays absence. `src/contracts/usage.ts` is explicit that a zeroed record is a claim the run
   * was free, and the note is the one place that claim would survive every other record being gone.
   */
  it('records no usage at all rather than a zeroed total when no step reported any', () => {
    expect(parsed({ usage: null }).usage).toBeNull();
  });

  it('refuses a note recording a step that has not terminated, which no merge commit has', () => {
    // `StepRecord.disposition` is nullable because a step in flight has none. A note is written on the
    // merge commit, by which point every step has ended, so `null` here would be a durable record of a
    // run that had not finished.
    const result = GitNoteSchema.safeParse(
      note({ steps: [{ step: 'commit', phase: 'committing', disposition: null }] }),
    );
    expect(result.success).toBe(false);
  });

  it('refuses a note with no steps, which is a record of a run that did nothing', () => {
    const result = GitNoteSchema.safeParse(note({ steps: [] }));
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.path.join('.'))).toContain('steps');
  });

  it('refuses one step recorded twice, which is two answers to how it ended', () => {
    const result = GitNoteSchema.safeParse(
      note({
        steps: [
          { step: 'commit', phase: 'committing', disposition: 'completed' },
          { step: 'commit', phase: 'committing', disposition: 'failed' },
        ],
      }),
    );
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.path.join('.'))).toContain('steps.1.step');
  });


  /**
   * The two fields the schema guarded in prose and not in code.
   *
   * `acceptance_criteria` gets the rule `steps` already had — an empty list is a record of a run judged
   * against nothing, and it makes the per-entry rule below it pass vacuously. `usage` gets the rule its
   * own `.describe()` already promised: absence is spelled by omitting the record, and a record of five
   * nulls is the same claim said a second way, which a surface checking only for the record's presence
   * reads differently.
   */
  it('refuses a note with no acceptance criteria, which is a run judged against nothing', () => {
    const result = GitNoteSchema.safeParse(note({ acceptance_criteria: [] }));
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.path.join('.'))).toContain(
      'acceptance_criteria',
    );
  });

  it('refuses a blank criterion, which states no standard and reads as one', () => {
    const result = GitNoteSchema.safeParse(note({ acceptance_criteria: ['a real one', '  '] }));
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.path.join('.'))).toContain(
      'acceptance_criteria.1',
    );
  });

  it('refuses a usage record of nothing but nulls, which is absence spelled twice', () => {
    const result = GitNoteSchema.safeParse(
      note({
        usage: {
          cost_usd: null,
          input_tokens: null,
          output_tokens: null,
          cache_creation_input_tokens: null,
          cache_read_input_tokens: null,
        },
      }),
    );
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.path.join('.'))).toContain('usage');
    // And the one spelling of absence this artifact does accept still parses.
    expect(GitNoteSchema.safeParse(note({ usage: null })).success).toBe(true);
  });

  it.each(['run', 'feature', 'branch'])(
    'refuses a note whose %s is blank, because a record nothing can be found by is no record',
    (field) => {
      const result = GitNoteSchema.safeParse(note({ [field]: '   ' }));
      expect(result.success).toBe(false);
      expect(result.error?.issues.map((issue) => issue.path.join('.'))).toContain(field);
    },
  );
});

describe('the note is a versioned artifact carrying its own version (matrix 6, ADR-005)', () => {
  it('is registered as an artifact, so the registry-wide version sweeps cover it', () => {
    expect(getContract(NOTE_CONTRACT_ID).kind).toBe('artifact');
    expect(getContract(NOTE_CONTRACT_ID).model_produced).toBe(false);
  });

  it.each([NOTE_SCHEMA_VERSION + 1, NOTE_SCHEMA_VERSION - 1])(
    'refuses a note at schema_version %s with config.schema_version_unrecognised',
    (version) => {
      let refusal: SchemaVersionRefusal | null = null;
      try {
        parseVersionedArtifact(
          GitNoteSchema,
          note({ schema_version: version }),
          NOTE_ARTIFACT_NAME,
        );
      } catch (error) {
        refusal = error instanceof SchemaVersionRefusal ? error : null;
      }
      expect(refusal).not.toBeNull();
      expect(refusal?.code).toBe(SCHEMA_VERSION_UNRECOGNISED_CODE);
      expect(refusal?.artifact).toBe(NOTE_ARTIFACT_NAME);
      expect(refusal?.schemaVersion).toBe(version);
    },
  );

  it('refuses it at a bare .parse() too, so no reader can walk past the gate', () => {
    const result = GitNoteSchema.safeParse(note({ schema_version: NOTE_SCHEMA_VERSION + 1 }));
    expect(result.success).toBe(false);
    const issue = result.error?.issues.find((entry) => entry.path.join('.') === 'schema_version');
    expect(issue?.message).toContain(SCHEMA_VERSION_UNRECOGNISED_CODE);
  });

  /**
   * ADR-005's whole point, in the direction this story could have broken it.
   *
   * The version is spelled `1` rather than read from {@link NOTE_SCHEMA_VERSION}, deliberately: this
   * assertion is what says a note written by *today's* build stays readable, so it has to fail when the
   * note's version advances without a migration. The `state.json` beside it is the other half — a note
   * advancing must not refuse a run in flight, which is the coupling ADR-005 was taken to break.
   */
  it('reads a note written at version 1 today, while state.json reads at its own version', () => {
    expect(parseVersionedArtifact(GitNoteSchema, note({ schema_version: 1 }), NOTE_ARTIFACT_NAME).run)
      .toBe('01JBQ8Z1X2Y3W4V5U6T7S8R9Q0');
    const state = RunStateSchema.safeParse({
      schema_version: CURRENT_SCHEMA_VERSION,
      run: '01JBQ8Z1X2Y3W4V5U6T7S8R9Q0',
      feature: 'committer-branch-naming',
      mode: 'live',
      state: 'running',
      territory: ['src/engine'],
      steps: [],
      last_event_seq: 0,
      created_at: '2026-09-23T09:00:00.000Z',
      updated_at: '2026-09-23T09:00:00.000Z',
      handoff: null,
    });
    expect(state.success).toBe(true);
  });
});

describe('the note has one ref, spelled once (AD-22)', () => {
  it('names a single ref under refs/notes', () => {
    expect(NOTE_REF).toBe('refs/notes/orch');
  });

  /**
   * "Under a single named ref" fails quietly when it fails: a note written to one spelling and read
   * from another is a durable record nothing can find, and nobody discovers it until they go looking
   * for a run that has already ended. So the constant is held to being the only spelling in `src/`,
   * recursively, the way `tests/contracts.round-trip.test.ts` holds the one `toJSONSchema` call.
   */
  it('is the only refs/notes spelling anywhere under src/, checked recursively', () => {
    const sourceRoot = new URL('../src/', import.meta.url);
    const files = sourceFilesUnder(sourceRoot);
    expect(files.length).toBeGreaterThan(0);
    // Nested files are in the list, so a violation under `src/tui/cards/` is inside the sweep rather
    // than one directory past it.
    expect(files.some((file) => file.includes('/'))).toBe(true);

    const spellings = new Map<string, readonly string[]>();
    for (const file of files) {
      const source = stripComments(readFileSync(new URL(file, sourceRoot), 'utf8'));
      const found = [...source.matchAll(/refs\/notes\/[A-Za-z0-9._\-/]*/g)].map((match) => match[0]);
      if (found.length > 0) spellings.set(file, found);
    }
    expect([...spellings.keys()]).toStrictEqual(['contracts/note.ts']);
    expect([...new Set([...spellings.values()].flat())]).toStrictEqual([NOTE_REF]);
  });
});
