/**
 * `step.adversarial` — story 4-2's own I/O matrix, all eight rows.
 *
 * Rows 1 to 3 and row 5's hand-off half are the reconciler's own concern — whether `verify`'s
 * judgements gate the spawn, and whether a `broken` attempt routes the step's termination through
 * `step.adversarial_break_found` — and are covered in `tests/engine.reconciler.test.ts`, the same split
 * `tests/contracts.verification.test.ts` and `tests/engine.spawner.test.ts` already draw for that
 * contract's own cross-artifact check. What belongs here is what the contract itself can prove from one
 * artifact alone: rows 4, 6 and 7 outright, and the artifact-side half of row 5 ({@link brokenAttemptIn}),
 * plus row 8's reused mechanism ({@link gatesDisagreeingWith}, imported from `step.verification`'s own
 * module and asserted here to answer about this contract's shape too — the same "keyed on the field, not
 * the contract id" discipline `criteriaNotAccepted` already relies on).
 */
import { describe, expect, it } from 'vitest';

import {
  ADVERSARIAL_CONTRACT_ID,
  AdversarialOutputSchema,
  brokenAttemptIn,
  exportContract,
  gatesDisagreeingWith,
  getContract,
} from '../src/contracts/index.js';
import type { AdversarialOutput } from '../src/contracts/index.js';

const gate = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  command: 'test',
  declared: 'npm test',
  outcome: 'passed',
  exit_status: 0,
  evidence: 'evidence/test-1.log',
  ...overrides,
});

/** The three gates CAP-13 names, copied the way `verify`'s own attempt would have reported them. */
const allGates = (): readonly Record<string, unknown>[] => [
  gate({ command: 'typecheck', declared: 'npm run typecheck', evidence: 'evidence/typecheck-1.log' }),
  gate({ command: 'lint', declared: 'npm run lint', evidence: 'evidence/lint-1.log' }),
  gate(),
];

const attempt = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  attempted: 'Tried to smuggle an arbitrary shell command past the declared-command enum.',
  observed: 'The malformed value never validated against the closed enum, so nothing ran.',
  verdict: 'held',
  provenance: { step: 'adversarial', source: 'src/runner/commands.ts' },
  ...overrides,
});

const adversarialOutput = (overrides: Partial<AdversarialOutput> = {}): unknown => ({
  contract_id: ADVERSARIAL_CONTRACT_ID,
  step: 'adversarial',
  status: 'completed',
  summary: 'One attempt to break the runner boundary, held.',
  provenance: ['adversarial: src/runner/commands.ts'],
  decisions: [],
  artifacts: [],
  questions: [],
  write_intents: [],
  error: null,
  gates: allGates(),
  attempts: [attempt()],
  verdict: 'held',
  ...overrides,
});

describe('step.adversarial is registered and exports', () => {
  it('resolves by id, is model-produced, and exports to draft-7', () => {
    expect(getContract(ADVERSARIAL_CONTRACT_ID).kind).toBe('step');
    expect(getContract(ADVERSARIAL_CONTRACT_ID).model_produced).toBe(true);
    expect(exportContract(ADVERSARIAL_CONTRACT_ID)['$schema']).toContain('draft-07');
  });

  it('accepts a well-formed completed output', () => {
    expect(AdversarialOutputSchema.safeParse(adversarialOutput()).success).toBe(true);
  });
});

describe('row 4 — every attempt held completes normally', () => {
  it('accepts a completed output whose every attempt is held and whose verdict agrees', () => {
    const output = adversarialOutput({
      attempts: [attempt(), attempt({ attempted: 'A second, unrelated attempt.' })],
      verdict: 'held',
    } as never);
    expect(AdversarialOutputSchema.safeParse(output).success).toBe(true);
  });
});

describe('row 5 — at least one broken attempt, the artifact-side half', () => {
  it('is what `brokenAttemptIn` reports true for, once the overall verdict agrees', () => {
    const output = adversarialOutput({
      attempts: [attempt(), attempt({ verdict: 'broken', observed: 'The call ran unrestricted.' })],
      verdict: 'broken',
    } as never);
    expect(AdversarialOutputSchema.safeParse(output).success).toBe(true);
    expect(brokenAttemptIn(output)).toBe(true);
  });

  it('reports false for an output with no broken attempt', () => {
    expect(brokenAttemptIn(adversarialOutput())).toBe(false);
  });

  it('answers about any output reporting attempts, not only this contract’s, and says nothing about one with none', () => {
    // The same discriminator idiom `criteriaNotAccepted` uses: keyed on the field, not on `contract_id`.
    expect(brokenAttemptIn({ attempts: [{ verdict: 'broken' }] })).toBe(true);
    expect(brokenAttemptIn({ attempts: [{ verdict: 'held' }] })).toBe(false);
    expect(brokenAttemptIn({ claims: [] })).toBe(false);
    expect(brokenAttemptIn(null)).toBe(false);
  });
});

describe('row 6 — the overall verdict may not disagree with the attempts', () => {
  it('refuses a completed output claiming "held" overall while reporting a broken attempt', () => {
    const output = adversarialOutput({
      attempts: [attempt({ verdict: 'broken' })],
      verdict: 'held',
    } as never);
    const result = AdversarialOutputSchema.safeParse(output);
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.path.join('.'))).toContain('verdict');
  });

  it('refuses a completed output claiming "broken" overall while every attempt held', () => {
    const output = adversarialOutput({ verdict: 'broken' } as never);
    expect(AdversarialOutputSchema.safeParse(output).success).toBe(false);
  });
});

describe('row 7 — a completed report makes at least one attempt', () => {
  it('refuses a completed output with zero attempts', () => {
    const result = AdversarialOutputSchema.safeParse(adversarialOutput({ attempts: [] }));
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.path.join('.'))).toContain('attempts');
  });

  it('leaves a blocked output free to report none, because it did not finish', () => {
    // Refusing the honest refusal would promote the ladder against a step that said it could not
    // proceed — `step.schema_invalid_output` is `escalate-model-tier`, the same reasoning
    // `step.verification`'s own "a blocked verification need not have judged" case relies on.
    expect(
      AdversarialOutputSchema.safeParse(
        adversarialOutput({ status: 'blocked', attempts: [], verdict: 'held' } as never),
      ).success,
    ).toBe(true);
  });
});

describe('row 8 — the reused cross-artifact gate check', () => {
  it('agrees when the reported gates match what the engine recorded', () => {
    const recorded = [
      {
        command: 'typecheck',
        declared: 'npm run typecheck',
        outcome: 'passed' as const,
        exit_status: 0,
        evidence: 'evidence/typecheck-1.log',
      },
      {
        command: 'lint',
        declared: 'npm run lint',
        outcome: 'passed' as const,
        exit_status: 0,
        evidence: 'evidence/lint-1.log',
      },
      {
        command: 'test',
        declared: 'npm test',
        outcome: 'passed' as const,
        exit_status: 0,
        evidence: 'evidence/test-1.log',
      },
    ];
    expect(gatesDisagreeingWith(recorded, adversarialOutput())).toStrictEqual([]);
  });

  it('names the disagreement when a reported gate outcome does not match the engine’s own record', () => {
    const recorded = [
      {
        command: 'typecheck',
        declared: 'npm run typecheck',
        outcome: 'failed' as const,
        exit_status: 1,
        evidence: 'evidence/typecheck-1.log',
      },
      {
        command: 'lint',
        declared: 'npm run lint',
        outcome: 'passed' as const,
        exit_status: 0,
        evidence: 'evidence/lint-1.log',
      },
      {
        command: 'test',
        declared: 'npm test',
        outcome: 'passed' as const,
        exit_status: 0,
        evidence: 'evidence/test-1.log',
      },
    ];
    const disagreements = gatesDisagreeingWith(recorded, adversarialOutput());
    expect(disagreements.length).toBeGreaterThan(0);
    expect(disagreements.join(' ')).toContain('typecheck');
  });

  it('is never a schema refinement: a disagreeing report still parses on its own', () => {
    // "A contract sees one artifact and cannot see the run" — `step.verification`'s own stated limit,
    // reused here rather than re-derived. The cross-artifact check is the spawner's, never this file's.
    const output = adversarialOutput({
      gates: [gate({ command: 'typecheck', outcome: 'failed', exit_status: 1 })],
    } as never);
    expect(AdversarialOutputSchema.safeParse(output).success).toBe(true);
  });
});

describe('every attempt is attributed and never blank', () => {
  it('refuses an unattributed attempt, a blank "attempted", and a blank "observed"', () => {
    for (const broken of [
      { provenance: { step: 'adversarial', source: '' } },
      { attempted: '   ' },
      { observed: '' },
    ]) {
      const result = AdversarialOutputSchema.safeParse(adversarialOutput({ attempts: [attempt(broken)] } as never));
      expect(result.success, JSON.stringify(broken)).toBe(false);
    }
  });
});
