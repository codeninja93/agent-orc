/**
 * `step.bootstrap` — the I/O matrix rows of docs/specs/spec-agent-orchestrator/stories/5-5-bootstrap-agent.md
 * that need no real fixture (schema validation), plus this story's own AD-31 round-trip test applied to
 * the new contract.
 *
 * **The fixture-dependent leg is intentionally pending, not fabricated.** AD-31 requires a recorded real
 * `claude -p --json-schema` transcript for every model-produced contract, and this is a brand-new one:
 * that transcript needs subscription auth this build environment cannot provide. The story's own
 * Boundary is explicit that hand-writing or approximating one would be worse than an honestly incomplete
 * test, so the three fixture-dependent assertions `tests/contracts.round-trip.test.ts` runs for every
 * *other* step contract are written here in the same shape, over a `readFixture` that is expected to
 * exist once Deep's promised `claude -p` session lands (confirmed directly, 2026-09-25) — and are marked
 * `it.todo` until then, so the gap is visible in every test run rather than silently absent from this
 * file. `PENDING_AD31_FIXTURE_CONTRACT_IDS` in `src/contracts/registry.ts` is the second, always-run
 * record of the same gap, read by the *shared* round-trip suite.
 */
import { existsSync, readFileSync } from 'node:fs';

import { Ajv } from 'ajv';
import { describe, expect, it } from 'vitest';

import {
  BOOTSTRAP_CONTRACT_ID,
  BootstrapAnalysisSchema,
  PENDING_AD31_FIXTURE_CONTRACT_IDS,
  attributesClaim,
  exportContract,
  getContract,
  isContractId,
} from '../src/contracts/index.js';
import type { AnalysisClaim, BootstrapAnalysis } from '../src/contracts/index.js';

const claim = (overrides: Partial<AnalysisClaim> = {}): AnalysisClaim => ({
  claim: 'The repository declares a postgres service in its compose file.',
  paths: ['docker-compose.yml'],
  provenance: { step: 'bootstrap-analysis', source: 'docker-compose.yml' },
  ...overrides,
});

/** A valid bootstrap output, built here rather than read from a fixture so cases can mutate it. */
const bootstrapOutput = (overrides: Partial<BootstrapAnalysis> = {}): unknown => ({
  contract_id: BOOTSTRAP_CONTRACT_ID,
  step: 'bootstrap-analysis',
  status: 'completed',
  summary: 'This repository needs postgres, has one high-blast-radius path, and one fact worth keeping.',
  provenance: ['bootstrap-analysis: docker-compose.yml'],
  decisions: [],
  artifacts: [],
  questions: [],
  write_intents: [],
  error: null,
  claims: [claim()],
  resources: 'postgres',
  high_blast_radius_paths: ['src/engine/reconciler.ts'],
  conflict_domains: ['src/engine'],
  knowledge: [
    {
      anchor: 'Reconciler',
      anchor_kind: 'api-symbol',
      claim: 'The reconciler takes at most one action per pass.',
      provenance: 'bootstrap: src/engine/reconciler.ts',
      recorded_at: '2026-09-25T00:00:00.000Z',
      decay_policy: 'permanent',
      decay_features: 0,
    },
  ],
  ...overrides,
});

describe('the contract is registered and exports for --json-schema (matrix row 1)', () => {
  it('resolves by id and exports draft-7, so a spawn can carry it', () => {
    expect(isContractId(BOOTSTRAP_CONTRACT_ID)).toBe(true);
    const entry = getContract(BOOTSTRAP_CONTRACT_ID);
    expect(entry.kind).toBe('step');
    // AD-31: a model produces this one, so a fixture is owed — see PENDING_AD31_FIXTURE_CONTRACT_IDS.
    expect(entry.model_produced).toBe(true);
    expect(PENDING_AD31_FIXTURE_CONTRACT_IDS).toContain(BOOTSTRAP_CONTRACT_ID);
    const exported = exportContract(BOOTSTRAP_CONTRACT_ID);
    expect(exported['$schema']).toBe('http://json-schema.org/draft-07/schema#');
    const properties = Object.keys(exported['properties'] as Record<string, unknown>);
    expect(properties).toEqual(
      expect.arrayContaining(['claims', 'resources', 'high_blast_radius_paths', 'conflict_domains', 'knowledge']),
    );
  });

  it('has exactly the StepOutputSchema fields plus this contract\'s own five, and no territory field', () => {
    // An arrayContaining check above would not catch a stray extra field — e.g. a `territory` this
    // contract's own docblock claims does not exist ("a bootstrap analysis declares no scoped territory
    // of its own"). Compared against the full sorted key list instead, the same style
    // tests/contracts.committing.test.ts uses for its own exact-shape assertion.
    const exported = exportContract(BOOTSTRAP_CONTRACT_ID);
    const properties = Object.keys(exported['properties'] as Record<string, unknown>);
    expect(properties.sort()).toStrictEqual(
      [
        // StepOutputSchema's own fields (src/contracts/step.ts)
        'artifacts',
        'contract_id',
        'decisions',
        'error',
        'provenance',
        'questions',
        'status',
        'step',
        'summary',
        'write_intents',
        // step.bootstrap's own five (src/contracts/bootstrap.ts)
        'claims',
        'conflict_domains',
        'high_blast_radius_paths',
        'knowledge',
        'resources',
      ].sort(),
    );
    expect(properties).not.toContain('territory');
  });

  it('compiles as a draft-7 schema under ajv, independent of any fixture', () => {
    const ajv = new Ajv({ strict: false, allErrors: true });
    expect(() => ajv.compile(exportContract(BOOTSTRAP_CONTRACT_ID))).not.toThrow();
  });
});

describe('a valid bootstrap output parses (matrix row 1)', () => {
  it('accepts a well-formed resources answer, path lists and knowledge entries', () => {
    const result = BootstrapAnalysisSchema.safeParse(bootstrapOutput());
    expect(result.success, JSON.stringify(result.error?.issues ?? [], null, 2)).toBe(true);
  });

  it.each(['none', 'postgres', 'redis', 'both'] as const)(
    'accepts every resource need, including %s',
    (resources) => {
      const result = BootstrapAnalysisSchema.safeParse(bootstrapOutput({ resources }));
      expect(result.success).toBe(true);
    },
  );

  it('accepts an empty risk section when nothing read warrants one', () => {
    const result = BootstrapAnalysisSchema.safeParse(
      bootstrapOutput({ high_blast_radius_paths: [], conflict_domains: [] }),
    );
    expect(result.success).toBe(true);
  });

  it('accepts no knowledge entries when nothing read is worth recording', () => {
    const result = BootstrapAnalysisSchema.safeParse(bootstrapOutput({ knowledge: [] }));
    expect(result.success).toBe(true);
  });
});

describe('a high-blast-radius path outside the repository is refused (matrix row 2)', () => {
  it('refuses "../etc/passwd", matching AnalysisOutputSchema\'s own territory-containment refusal', () => {
    const result = BootstrapAnalysisSchema.safeParse(
      bootstrapOutput({ high_blast_radius_paths: ['../etc/passwd'] }),
    );
    expect(result.success).toBe(false);
    const path = result.success ? [] : result.error.issues[0]?.path;
    expect(path).toStrictEqual(['high_blast_radius_paths', 0]);
  });

  it('refuses the same shape of path in conflict_domains', () => {
    const result = BootstrapAnalysisSchema.safeParse(
      bootstrapOutput({ conflict_domains: ['../etc/passwd'] }),
    );
    expect(result.success).toBe(false);
  });

  it('refuses an absolute path', () => {
    const result = BootstrapAnalysisSchema.safeParse(
      bootstrapOutput({ high_blast_radius_paths: ['/etc/passwd'] }),
    );
    expect(result.success).toBe(false);
  });

  it('refuses a claim path outside the repository, the same rule applied to claims', () => {
    const result = BootstrapAnalysisSchema.safeParse(
      bootstrapOutput({ claims: [claim({ paths: ['../etc/passwd'] })] }),
    );
    expect(result.success).toBe(false);
  });

  it('accepts "." as the whole-repository spelling, the one deliberate exception', () => {
    const result = BootstrapAnalysisSchema.safeParse(
      bootstrapOutput({ high_blast_radius_paths: ['.'] }),
    );
    expect(result.success).toBe(true);
  });
});

describe('the claim/provenance discipline matches AnalysisOutputSchema\'s own', () => {
  it('refuses a completed analysis with no claims', () => {
    const result = BootstrapAnalysisSchema.safeParse(bootstrapOutput({ claims: [] }));
    expect(result.success).toBe(false);
  });

  it('refuses a claim with a blank claim statement', () => {
    const result = BootstrapAnalysisSchema.safeParse(
      bootstrapOutput({ claims: [claim({ claim: '   ' })] }),
    );
    expect(result.success).toBe(false);
  });

  it('refuses a claim whose provenance is missing either half', () => {
    const result = BootstrapAnalysisSchema.safeParse(
      bootstrapOutput({ claims: [claim({ provenance: { step: '', source: 'docker-compose.yml' } })] }),
    );
    expect(result.success).toBe(false);
    expect(attributesClaim({ step: '', source: 'docker-compose.yml' })).toBe(false);
  });

  it('allows a blocked analysis to report no claims', () => {
    const result = BootstrapAnalysisSchema.safeParse(
      bootstrapOutput({
        status: 'blocked',
        claims: [],
        summary: 'The repository could not be read.',
        error: {
          code: 'permission.denied',
          message: 'permission denied',
          retryable: false,
          cause: null,
        },
      }),
    );
    expect(result.success, JSON.stringify(result.success ? null : result.error.issues, null, 2)).toBe(
      true,
    );
  });
});

describe('AD-31 — the recorded real structured_output leg (pending)', () => {
  const FIXTURE_URL = new URL(`fixtures/structured-output/${BOOTSTRAP_CONTRACT_ID}.json`, import.meta.url);
  const fixtureExists = existsSync(FIXTURE_URL);

  /**
   * This is deliberately NOT `it.todo` with no body: the assertion runs on every pass of this suite, and
   * it fails loudly if anyone ever removes `BOOTSTRAP_CONTRACT_ID` from `PENDING_AD31_FIXTURE_CONTRACT_IDS`
   * without also committing the fixture this test needs to actually exercise the other three legs. Until
   * the fixture exists, the three legs themselves are `it.todo`, so their absence shows up in every test
   * run as a named pending case.
   *
   * **The gap itself is read from `PENDING_AD31_FIXTURE_CONTRACT_IDS` directly, not re-derived.** This
   * used to also run its own `existsSync` check on `FIXTURE_URL` as a second, independent proof that no
   * fixture is recorded — the same fact `tests/contracts.round-trip.test.ts`'s own
   * `it.each(PENDING_AD31_FIXTURE_CONTRACT_IDS)` case already proves, by reading the shared fixture
   * directory listing. Two separate implementations of "does this contract have a recorded fixture" can
   * drift; asserting only the registry membership here, and leaving the on-disk proof to the round-trip
   * suite, means they cannot.
   */
  it('has no real recorded fixture yet — a named, deferred AD-31 gap (see registry.ts)', () => {
    expect(PENDING_AD31_FIXTURE_CONTRACT_IDS).toContain(BOOTSTRAP_CONTRACT_ID);
  });

  it.todo(
    'the fixture parses against the Zod schema — blocked on a real `claude -p --json-schema` transcript ' +
      `against exportContract('${BOOTSTRAP_CONTRACT_ID}'); Deep has agreed to run that session ` +
      '(confirmed directly, 2026-09-25). Once tests/fixtures/structured-output/step.bootstrap.json is ' +
      "committed, replace this and the two todos below with tests/contracts.round-trip.test.ts's own " +
      'three assertions (schema parse, draft-7 validate, lossless round-trip) and remove ' +
      "BOOTSTRAP_CONTRACT_ID from PENDING_AD31_FIXTURE_CONTRACT_IDS in src/contracts/registry.ts.",
  );

  it.todo('the fixture validates against the draft-7 export — same gap as above');

  it.todo('the parse is lossless, so the legs agree in both directions — same gap as above');

  it('reads the recorded fixture once it exists, so this file self-updates rather than staying stale', () => {
    // A light guard against this describe block silently going stale: if a fixture does land, the
    // JSON at least has to be parseable, even though the schema/export/round-trip assertions above stay
    // `it.todo` until a human replaces them per the instructions there.
    if (!fixtureExists) return;
    expect(() => {
      JSON.parse(readFileSync(FIXTURE_URL, 'utf8'));
    }).not.toThrow();
  });
});
