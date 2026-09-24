/**
 * `step.testing` — matrix rows 14 and 15.
 *
 * Row 14 is a pair of claims about two contracts: both resolve and export to draft-7, and they are
 * *distinct shapes*. Distinctness is the half worth asserting, because the failure it guards is the
 * one story 2-4 found in the roster and story 2-5 found in the standard plan: two agents pointed at
 * one contract id cannot be told apart by anything the engine reads, and every refusal the more
 * specific one adds is then dead for whichever agent was quietly sharing.
 *
 * Row 15 is the pairing that could never both hold — a declaration naming one contract while the
 * agent's output is validated against another — asserted here as it is in
 * `tests/contracts.agent-grants.test.ts`, from the roster's side.
 */
import { describe, expect, it } from 'vitest';

import {
  TESTING_CONTRACT_ID,
  TestingOutputSchema,
  VERIFICATION_CONTRACT_ID,
  exportContract,
  getContract,
} from '../src/contracts/index.js';
import type { TestingOutput } from '../src/contracts/index.js';
import { STANDARD_PLAN_STEPS } from '../src/engine/index.js';
import { BUILT_IN_AGENTS } from '../src/installer/interview.js';

const testingOutput = (overrides: Partial<TestingOutput> = {}): unknown => ({
  contract_id: TESTING_CONTRACT_ID,
  step: 'test',
  status: 'completed',
  summary: 'Two suites cover the runner.',
  provenance: ['test: src/runner/index.ts'],
  decisions: [],
  artifacts: [],
  questions: [],
  write_intents: [],
  error: null,
  tests: [
    {
      path: 'tests/runner.command.test.ts',
      kind: 'added',
      covers: 'the runner takes a name and never a command string',
      provenance: { step: 'test', source: 'src/runner/commands.ts' },
    },
  ],
  territory: ['tests'],
  ...overrides,
});

describe('step.testing is registered, exports, and is its own shape (matrix 14)', () => {
  it('resolves by id and exports to draft-7', () => {
    expect(getContract(TESTING_CONTRACT_ID).kind).toBe('step');
    expect(getContract(TESTING_CONTRACT_ID).model_produced).toBe(true);
    expect(exportContract(TESTING_CONTRACT_ID)['$schema']).toContain('draft-07');
  });

  it('is a different shape from step.verification, not the same one under two ids', () => {
    /**
     * Asserted by each refusing the other's output rather than by comparing the two exports.
     *
     * Two ids over one shape would still export two identical schemas and read as "distinct" to a
     * comparison of names. What distinguishes them is what each will not accept: a testing output
     * has tests and no judgements, a verification output has judgements and gates and no tests, and
     * each pins `contract_id` to itself.
     */
    const testing = getContract(TESTING_CONTRACT_ID).schema;
    const verification = getContract(VERIFICATION_CONTRACT_ID).schema;
    expect(testing.safeParse(testingOutput()).success).toBe(true);
    expect(verification.safeParse(testingOutput()).success).toBe(false);

    const testingProperties = Object.keys(exportContract(TESTING_CONTRACT_ID)['properties'] ?? {});
    const verificationProperties = Object.keys(
      exportContract(VERIFICATION_CONTRACT_ID)['properties'] ?? {},
    );
    expect(testingProperties).toContain('tests');
    expect(testingProperties).not.toContain('judgements');
    expect(verificationProperties).toContain('judgements');
    expect(verificationProperties).not.toContain('tests');
  });

  it('refuses an output claiming another contract, so every reader refuses it', () => {
    for (const claimed of ['step.output', 'step.implementation', VERIFICATION_CONTRACT_ID]) {
      const result = TestingOutputSchema.safeParse(testingOutput({ contract_id: claimed } as never));
      expect(result.success, claimed).toBe(false);
    }
  });
});

describe('the roster and the plan point at it (matrix 15)', () => {
  it('has the testing agent declare step.testing', () => {
    const testing = BUILT_IN_AGENTS.find((agent) => agent.id === 'testing');
    expect(testing?.contract).toBe(TESTING_CONTRACT_ID);
  });

  it('has the verification agent declare step.verification', () => {
    const verification = BUILT_IN_AGENTS.find((agent) => agent.id === 'verification');
    expect(verification?.contract).toBe(VERIFICATION_CONTRACT_ID);
  });

  it('runs the seven steps in order, with each phase pointed at its own contract', () => {
    expect(STANDARD_PLAN_STEPS.map((step) => [step.phase, step.contract_id])).toStrictEqual([
      ['analysis', 'step.analysis'],
      ['planning', 'step.planning'],
      ['implementation', 'step.implementation'],
      ['testing', TESTING_CONTRACT_ID],
      ['verification', VERIFICATION_CONTRACT_ID],
      // Story 4-2: spawned only once every one of verify's own judgements is met.
      ['adversarial', 'step.adversarial'],
      // Story 2-7: the plan ended at the verdict, so nothing in it ever reached AD-22's note.
      ['committing', 'step.committing'],
    ]);
  });
});

describe('a test is attributed, inside the worktree, and inside the declared territory', () => {
  it('refuses a test with no provenance, which is a test nobody can trace to a requirement', () => {
    const result = TestingOutputSchema.safeParse(
      testingOutput({
        tests: [
          {
            path: 'tests/x.test.ts',
            kind: 'added',
            covers: 'something',
            provenance: { step: 'test', source: '   ' },
          },
        ],
      } as never),
    );
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.path.join('.'))).toContain(
      'tests.0.provenance',
    );
  });

  it('refuses a test file outside the run worktree, which this step cannot have written', () => {
    for (const path of ['/etc/passwd', '~/.ssh/id_rsa', '../elsewhere/x.test.ts', '.']) {
      const result = TestingOutputSchema.safeParse(
        testingOutput({
          tests: [
            {
              path,
              kind: 'added',
              covers: 'something',
              provenance: { step: 'test', source: 'src/x.ts' },
            },
          ],
          territory: ['.'],
        } as never),
      );
      expect(result.success, path).toBe(false);
    }
  });

  it('refuses a test outside the territory the same output declares', () => {
    const result = TestingOutputSchema.safeParse(
      testingOutput({
        tests: [
          {
            path: 'src/secretly-edited.ts',
            kind: 'added',
            covers: 'something',
            provenance: { step: 'test', source: 'src/x.ts' },
          },
        ],
        territory: ['tests'],
      } as never),
    );
    expect(result.success).toBe(false);
  });

  it('refuses a blank "covers", because a test nobody can describe is a tautology', () => {
    const result = TestingOutputSchema.safeParse(
      testingOutput({
        tests: [
          {
            path: 'tests/x.test.ts',
            kind: 'added',
            covers: '  ',
            provenance: { step: 'test', source: 'src/x.ts' },
          },
        ],
      } as never),
    );
    expect(result.success).toBe(false);
  });

  it('refuses a completed step that wrote no test at all', () => {
    expect(TestingOutputSchema.safeParse(testingOutput({ tests: [] })).success).toBe(false);
    // And a blocked one that wrote none is accepted: an honest refusal is not a schema violation,
    // and `step.schema_invalid_output` is `escalate-model-tier` — refusing it would promote the
    // ladder against a step that correctly said it could not proceed.
    expect(
      TestingOutputSchema.safeParse(
        testingOutput({ status: 'blocked', tests: [], territory: [] } as never),
      ).success,
    ).toBe(true);
  });

  it('requires a territory whenever a test was written, whatever status it reports', () => {
    // Bound to the tests rather than to `completed`, which is the defect story 2-5 found one
    // contract over: a blocked step that wrote files, with no territory, made every containment
    // refinement pass vacuously.
    const result = TestingOutputSchema.safeParse(
      testingOutput({ status: 'blocked', territory: [] } as never),
    );
    expect(result.success).toBe(false);
  });
});
