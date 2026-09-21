/**
 * The registration record's shape, and matrix 14 — an unrecognised `schema_version` is refused rather
 * than read as current.
 *
 * The shape assertions here are the ones the runtime's behaviour rests on rather than a restatement of
 * the schema: that the id is constrained to what a commit SHA can be — which is what refuses a *path*
 * handed in where an id was wanted — and that `location` admits no third state, because AD-33 forbids
 * inferring abandonment from a missing path and a state called `abandoned` would be an invitation to.
 */
import { describe, expect, it } from 'vitest';

import {
  CURRENT_SCHEMA_VERSION,
  PROJECT_ID_PATTERN,
  PROJECT_LOCATIONS,
  PROJECT_REGISTRATION_CONTRACT_ID,
  ProjectRegistrationSchema,
  SCHEMA_VERSION_UNRECOGNISED_CODE,
  SchemaVersionRefusal,
  contractIdsOfKind,
  getContract,
  isProjectId,
  parseVersionedArtifact,
} from '../src/contracts/index.js';

/** A 40-character hex string that is a plausible first-commit SHA and is not one of anything. */
const PROJECT_ID = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';

/**
 * A record, with overrides typed as loose data on purpose.
 *
 * Half of what this file asserts is what the schema *refuses*, and a helper typed as the parsed shape
 * would make every one of those cases a compile error instead of a test.
 */
const record = (overrides: Record<string, unknown> = {}): unknown => ({
  schema_version: CURRENT_SCHEMA_VERSION,
  project_id: PROJECT_ID,
  path: '/Users/someone/code/project',
  location: 'located',
  unlocated_since: null,
  first_registered_at: '2026-09-21T09:00:00.000Z',
  last_registered_at: '2026-09-21T09:00:00.000Z',
  ...overrides,
});

describe('the registration record carries the AD-10 identity and the AD-33 mark', () => {
  it('parses a record holding the id, the pointer and a schema_version', () => {
    const parsed = ProjectRegistrationSchema.parse(record());
    expect(parsed.project_id).toBe(PROJECT_ID);
    expect(parsed.path).toBe('/Users/someone/code/project');
    expect(parsed.schema_version).toBe(CURRENT_SCHEMA_VERSION);
  });

  it('admits exactly two locations, so nothing can record a project as abandoned', () => {
    expect([...PROJECT_LOCATIONS]).toStrictEqual(['located', 'unlocated']);
    expect(ProjectRegistrationSchema.safeParse(record({ location: 'abandoned' })).success).toBe(false);
  });

  it('keeps the pointer of an unlocated record, because a mark is not a deletion', () => {
    const parsed = ProjectRegistrationSchema.parse(
      record({ location: 'unlocated', unlocated_since: '2026-09-22T10:00:00.000Z' }),
    );
    expect(parsed.path).toBe('/Users/someone/code/project');
    expect(parsed.unlocated_since).toBe('2026-09-22T10:00:00.000Z');
  });

  it('refuses a project id that is not a git object name', () => {
    expect(isProjectId(PROJECT_ID)).toBe(true);
    // A SHA-256 repository's object names are sixty-four characters, and are project ids too.
    expect(isProjectId('f'.repeat(64))).toBe(true);
    expect(isProjectId('A1B2C3D4E5F60718293A4B5C6D7E8F9012345678')).toBe(false);
    expect(isProjectId('not-a-sha')).toBe(false);
    expect(isProjectId('')).toBe(false);
  });

  /**
   * The mistake AD-10 is about, in the shape a person makes it: a path where an id belongs.
   *
   * It matters that the *schema* refuses this and not only the prune command, because every reader of
   * this record holds the schema, and the record is the thing keyed by the id.
   */
  it('refuses a filesystem path handed in as a project id', () => {
    expect(isProjectId('/Users/someone/code/project')).toBe(false);
    expect(ProjectRegistrationSchema.safeParse(record({ project_id: '/Users/someone/code' })).success).toBe(
      false,
    );
    expect(PROJECT_ID_PATTERN.test('../../etc')).toBe(false);
  });

  it('requires every field, so a half-written record cannot read as a whole one', () => {
    for (const field of [
      'project_id',
      'path',
      'location',
      'unlocated_since',
      'first_registered_at',
      'last_registered_at',
    ]) {
      const { [field]: _omitted, ...without } = record() as Record<string, unknown>;
      expect(ProjectRegistrationSchema.safeParse(without).success, field).toBe(false);
    }
  });
});

describe('matrix 14 — a record carrying an unrecognised schema_version is refused', () => {
  it('refuses at a bare .parse(), carrying the AD-35 code', () => {
    const result = ProjectRegistrationSchema.safeParse(
      record({ schema_version: CURRENT_SCHEMA_VERSION + 1 }),
    );
    expect(result.success).toBe(false);
    const issue = result.error?.issues.find((entry) => entry.path.join('.') === 'schema_version');
    expect(issue?.message).toContain(SCHEMA_VERSION_UNRECOGNISED_CODE);
    expect(issue?.message).toContain('Re-run the installer');
  });

  it('refuses through parseVersionedArtifact naming the artifact and the version', () => {
    let thrown: SchemaVersionRefusal | null = null;
    try {
      parseVersionedArtifact(
        ProjectRegistrationSchema,
        record({ schema_version: 99 }),
        'registration.json for project abc',
      );
    } catch (error) {
      thrown = error instanceof SchemaVersionRefusal ? error : null;
    }
    expect(thrown).not.toBeNull();
    expect(thrown?.code).toBe(SCHEMA_VERSION_UNRECOGNISED_CODE);
    expect(thrown?.schemaVersion).toBe(99);
    expect(thrown?.artifact).toBe('registration.json for project abc');
  });
});

describe('the record is a registered contract, as the installer’s four artifacts are', () => {
  it('is registered as an artifact under its own id', () => {
    expect(contractIdsOfKind('artifact')).toContain(PROJECT_REGISTRATION_CONTRACT_ID);
    expect(getContract(PROJECT_REGISTRATION_CONTRACT_ID).schema).toBe(ProjectRegistrationSchema);
    expect(getContract(PROJECT_REGISTRATION_CONTRACT_ID).model_produced).toBe(false);
  });

  it('is described in terms of the ADs it serves, so a reader of the registry knows why it exists', () => {
    const description = getContract(PROJECT_REGISTRATION_CONTRACT_ID).description;
    expect(description).toContain('AD-10');
    expect(description).toContain('AD-33');
  });
});
