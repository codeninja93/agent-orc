/**
 * `step.analysis` — matrix rows 1, 3, 4 and 18.
 *
 * The rows this suite exists for are 3 and 4, and the way they are asserted is the point. `StepOutput`
 * carries `provenance: z.array(z.string())` under the comment "Every claim carries the step that produced
 * it", and a test asserting `provenance.length > 0` would pass on an output whose three claims share one
 * entry — attribution proven for nothing in particular. So every assertion here is **per claim**, and one
 * case demonstrates the weaker assertion passing on an output this schema refuses, so the difference is
 * visible rather than argued.
 */
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  ANALYSIS_CONTRACT_ID,
  AnalysisOutputSchema,
  PLANNING_CONTRACT_ID,
  attributesClaim,
  exportContract,
  getContract,
  isContractId,
} from '../src/contracts/index.js';
import type { AnalysisClaim, AnalysisOutput } from '../src/contracts/index.js';

const claim = (overrides: Partial<AnalysisClaim> = {}): AnalysisClaim => ({
  claim: 'The spawner builds its argv in one place.',
  paths: ['src/engine/spawner.ts'],
  provenance: { step: 'analyse-spawn', source: 'src/engine/spawner.ts' },
  ...overrides,
});

/** A valid analysis output, built here rather than read from the recorded fixture so cases can mutate. */
const analysisOutput = (overrides: Partial<AnalysisOutput> = {}): unknown => ({
  contract_id: ANALYSIS_CONTRACT_ID,
  step: 'analyse-spawn',
  status: 'completed',
  summary: 'The argv is built in one place and the grant reaches it from the roster.',
  provenance: ['analyse-spawn: src/engine/spawner.ts'],
  decisions: [],
  artifacts: [],
  questions: [],
  write_intents: [],
  error: null,
  claims: [claim()],
  territory: ['src/engine'],
  files_read: ['src/engine/spawner.ts'],
  ...overrides,
});

describe('the contract is registered and exports for --json-schema (matrix 1)', () => {
  it('resolves by id and exports draft-7, so a spawn can carry it', () => {
    expect(isContractId(ANALYSIS_CONTRACT_ID)).toBe(true);
    const entry = getContract(ANALYSIS_CONTRACT_ID);
    expect(entry.kind).toBe('step');
    // AD-31: a model produces this one, so the round-trip suite demands a recorded real fixture for it.
    expect(entry.model_produced).toBe(true);
    const exported = exportContract(ANALYSIS_CONTRACT_ID);
    expect(exported['$schema']).toBe('http://json-schema.org/draft-07/schema#');
    expect(Object.keys(exported['properties'] as Record<string, unknown>)).toContain('claims');
  });

  it('re-parses an analysis output, and refuses a planning-shaped one against the same id', () => {
    expect(AnalysisOutputSchema.safeParse(analysisOutput()).success).toBe(true);
    const planningShaped = {
      ...(analysisOutput() as Record<string, unknown>),
      contract_id: PLANNING_CONTRACT_ID,
      claims: undefined,
      plan: [],
    };
    expect(AnalysisOutputSchema.safeParse(planningShaped).success).toBe(false);
  });
});

describe('provenance binds to the claim, not to a parallel list (matrix 3, 4)', () => {
  it('names, for each claim, the step that produced it and the source it was read from', () => {
    const parsed = AnalysisOutputSchema.parse(
      analysisOutput({
        claims: [
          claim({ claim: 'first', provenance: { step: 'analyse-spawn', source: 'src/engine/spawner.ts' } }),
          claim({ claim: 'second', provenance: { step: 'analyse-spawn', source: 'src/engine/roster.ts' } }),
          claim({ claim: 'third', provenance: { step: 'analyse-spawn', source: 'src/engine/agents.ts' } }),
        ],
      }),
    );

    // Per claim, and about the claim's own attribution — not about the length of an array beside it.
    expect(parsed.claims).toHaveLength(3);
    for (const parsedClaim of parsed.claims) {
      expect(parsedClaim.provenance.step, parsedClaim.claim).toBe('analyse-spawn');
      expect(parsedClaim.provenance.source, parsedClaim.claim).not.toBe('');
      expect(attributesClaim(parsedClaim.provenance), parsedClaim.claim).toBe(true);
    }
    expect(parsed.claims.map((entry) => entry.provenance.source)).toStrictEqual([
      'src/engine/spawner.ts',
      'src/engine/roster.ts',
      'src/engine/agents.ts',
    ]);
  });

  it('refuses three claims when one of them carries no provenance, naming that claim', () => {
    const output = analysisOutput({
      claims: [
        claim({ claim: 'first' }),
        claim({ claim: 'second', provenance: { step: '', source: '' } }),
        claim({ claim: 'third' }),
      ],
    });

    const result = AnalysisOutputSchema.safeParse(output);
    expect(result.success).toBe(false);
    const paths = (result.error?.issues ?? []).map((issue) => issue.path.join('.'));
    expect(paths).toContain('claims.1.provenance');
    // Only the unattributed one is refused; the other two are not collateral.
    expect(paths).not.toContain('claims.0.provenance');
    expect(paths).not.toContain('claims.2.provenance');
  });

  it('refuses a claim attributed to a step but to no source, and the reverse', () => {
    for (const provenance of [
      { step: 'analyse-spawn', source: '   ' },
      { step: '  ', source: 'src/engine/spawner.ts' },
    ]) {
      const result = AnalysisOutputSchema.safeParse(analysisOutput({ claims: [claim({ provenance })] }));
      expect(result.success, JSON.stringify(provenance)).toBe(false);
    }
  });

  /**
   * The assertion this suite refuses to make, shown failing to notice the thing it is supposed to catch.
   *
   * `provenance.length > 0` and "the array is non-empty" are both true of an output whose second claim is
   * unattributed, because the flat array is not the attribution. This is the verifies-something-adjacent
   * pattern, pinned so a later edit cannot quietly fall back to it.
   */
  it('is not the same question as whether the flat provenance array is non-empty', () => {
    const output = analysisOutput({
      claims: [claim({ claim: 'first' }), claim({ claim: 'second', provenance: { step: '', source: '' } })],
      provenance: ['analyse-spawn: src/engine/spawner.ts'],
    }) as { provenance: string[]; claims: AnalysisClaim[] };

    expect(output.provenance.length).toBeGreaterThan(0);
    expect(output.claims.some((entry) => !attributesClaim(entry.provenance))).toBe(true);
    expect(AnalysisOutputSchema.safeParse(output).success).toBe(false);
  });
});

describe('a claim stays inside the territory the same output declares (matrix 18)', () => {
  it('accepts a claim about a file inside the declared territory', () => {
    const result = AnalysisOutputSchema.safeParse(
      analysisOutput({ territory: ['src/engine'], claims: [claim({ paths: ['src/engine/lock.ts'] })] }),
    );
    expect(result.success).toBe(true);
  });

  it('refuses a claim about a file outside it, naming the path and the territory', () => {
    const result = AnalysisOutputSchema.safeParse(
      analysisOutput({ territory: ['src/engine'], claims: [claim({ paths: ['src/tui/app.tsx'] })] }),
    );
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toContain('src/tui/app.tsx');
    expect(result.error?.issues[0]?.message).toContain('src/engine');
  });

  it.each([
    ['/etc/passwd', 'an absolute path'],
    ['../other-repo/src/engine/lock.ts', 'a path climbing out of the worktree'],
    ['src/engine/../../escaped.ts', 'a path that only escapes once it is normalised'],
  ])('refuses %s, which is %s', (path) => {
    const result = AnalysisOutputSchema.safeParse(
      analysisOutput({ territory: ['src/engine'], claims: [claim({ paths: [path] })] }),
    );
    expect(result.success).toBe(false);
  });

  it('reads containment in one direction, so a claim wider than the territory is refused', () => {
    // `src/engine` and `src/engine/lock.ts` *collide*, which is what serialises two features. Containment
    // is the other question, and a claim about the whole directory is not inside a territory of one file.
    const result = AnalysisOutputSchema.safeParse(
      analysisOutput({ territory: ['src/engine/lock.ts'], claims: [claim({ paths: ['src/engine'] })] }),
    );
    expect(result.success).toBe(false);
  });

  it('normalises a loosely spelled path rather than refusing it', () => {
    const result = AnalysisOutputSchema.safeParse(
      analysisOutput({ territory: ['./src/engine/'], claims: [claim({ paths: ['src/engine/lock.ts'] })] }),
    );
    expect(result.success).toBe(true);
  });

  it('accepts a claim about no file at all, which asserts nothing about a path', () => {
    expect(
      AnalysisOutputSchema.safeParse(analysisOutput({ claims: [claim({ paths: [] })] })).success,
    ).toBe(true);
  });

  it('refuses an output declaring no territory, because it would overlap nothing', () => {
    const result = AnalysisOutputSchema.safeParse(
      analysisOutput({ territory: [], claims: [claim({ paths: [] })] }),
    );
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.path.join('.'))).toContain('territory');
  });

  it('refuses a file_read outside the worktree, which no step could have read', () => {
    expect(
      AnalysisOutputSchema.safeParse(analysisOutput({ files_read: ['/etc/shadow'] })).success,
    ).toBe(false);
  });
});

/**
 * Matrix row 17 — the same input through either agent gives the same output shape, and nothing else.
 *
 * Asserted against the *recorded real* fixture, because that is the only artifact here a model actually
 * produced: parsing it is total, repeatable and returns a value equal to what went in, so re-running the
 * re-parse of one output cannot produce a second different one. The other half of "no write outside it" is
 * the grant — ADR-003 gives this agent `Read`, `Grep` and `Glob`, so there is no tool with which to write —
 * and `tests/engine.agents.test.ts` is where that is asserted against a roster.
 */
describe('re-parsing one output twice gives the same output (matrix 17)', () => {
  const recorded: unknown = JSON.parse(
    readFileSync(new URL('./fixtures/structured-output/step.analysis.json', import.meta.url), 'utf8'),
  );

  it('is lossless and repeatable over a recorded real structured_output', () => {
    const first = AnalysisOutputSchema.parse(recorded);
    const second = AnalysisOutputSchema.parse(recorded);
    expect(second).toStrictEqual(first);
    expect(first).toStrictEqual(recorded);
  });

  it('carries attribution on every claim of that recorded output, not just on some', () => {
    const parsed = AnalysisOutputSchema.parse(recorded);
    expect(parsed.claims.length).toBeGreaterThan(1);
    for (const parsedClaim of parsed.claims) {
      expect(attributesClaim(parsedClaim.provenance), parsedClaim.claim).toBe(true);
      expect(parsedClaim.provenance.step, parsedClaim.claim).toBe(parsed.step);
    }
  });
});
