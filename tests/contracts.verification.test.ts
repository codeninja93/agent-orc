/**
 * `step.verification` — matrix rows 14 and 17 to 19.
 *
 * The three that carry the story:
 *
 * - **row 17** — when the gates pass, the model judgement runs *against the acceptance criteria*, so
 *   the artifact has somewhere to put one verdict per criterion with its own provenance;
 * - **row 18** — the criteria judged are byte-identical to the ones the run was accepted with. Not
 *   "equivalent", not "trimmed": the same characters, because a step that can re-type a criterion
 *   can soften one;
 * - **row 19** — an output introducing a criterion of its own is refused. A step cannot invent what
 *   it is judged against.
 *
 * Row 18's comparison cannot live in the contract: a contract sees one artifact and cannot know what
 * the run was accepted with. So {@link criteriaNotAccepted} takes both halves and the spawner —
 * which already re-parses every output against its contract before the loop may accept it — is where
 * they meet. Both ends are asserted here, and the spawner end again in `tests/engine.spawner.*`.
 */
import { describe, expect, it } from 'vitest';

import {
  DETERMINISTIC_GATE_NAMES,
  VERIFICATION_CONTRACT_ID,
  VerificationOutputSchema,
  criteriaNotAccepted,
  exportContract,
  getContract,
} from '../src/contracts/index.js';
import type { VerificationOutput } from '../src/contracts/index.js';

const ACCEPTED = [
  'the loop takes at most one action per pass',
  'a restart converges on the same state',
];

const gate = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  command: 'test',
  declared: 'npm test',
  outcome: 'passed',
  exit_status: 0,
  evidence: 'evidence/test-1.log',
  ...overrides,
});

const judgement = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  criterion: ACCEPTED[0],
  verdict: 'met',
  grounds: 'the reconciler returns after one action, asserted in tests/engine.reconciler.test.ts',
  provenance: { step: 'verify', source: 'src/engine/reconciler.ts' },
  ...overrides,
});

const verificationOutput = (overrides: Partial<VerificationOutput> = {}): unknown => ({
  contract_id: VERIFICATION_CONTRACT_ID,
  step: 'verify',
  status: 'completed',
  summary: 'The gates passed and both criteria are met.',
  provenance: ['verify: evidence/test-1.log'],
  decisions: [],
  artifacts: [],
  questions: [],
  write_intents: [],
  error: null,
  gates: [gate()],
  judgements: [judgement()],
  ...overrides,
});

describe('step.verification is registered and exports (matrix 14)', () => {
  it('resolves by id, is model-produced, and exports to draft-7', () => {
    expect(getContract(VERIFICATION_CONTRACT_ID).kind).toBe('step');
    expect(getContract(VERIFICATION_CONTRACT_ID).model_produced).toBe(true);
    expect(exportContract(VERIFICATION_CONTRACT_ID)['$schema']).toContain('draft-07');
  });

  it('names exactly the three gates CAP-13 names, and not build or run', () => {
    expect([...DETERMINISTIC_GATE_NAMES]).toStrictEqual(['typecheck', 'lint', 'test']);
    for (const notAGate of ['build', 'run']) {
      expect(
        VerificationOutputSchema.safeParse(
          verificationOutput({ gates: [gate({ command: notAGate })] } as never),
        ).success,
        notAGate,
      ).toBe(false);
    }
  });
});

describe('the judgement runs against the acceptance criteria (matrix 17)', () => {
  it('accepts a verdict per criterion, each attributed', () => {
    const output = verificationOutput({
      judgements: [judgement(), judgement({ criterion: ACCEPTED[1], verdict: 'unmet' })],
    } as never);
    expect(VerificationOutputSchema.safeParse(output).success).toBe(true);
    expect(criteriaNotAccepted(ACCEPTED, output)).toStrictEqual([]);
  });

  it('refuses an unattributed verdict and a verdict with no grounds', () => {
    for (const broken of [
      { provenance: { step: 'verify', source: '' } },
      { grounds: '   ' },
      { criterion: '  ' },
    ]) {
      const result = VerificationOutputSchema.safeParse(
        verificationOutput({ judgements: [judgement(broken)] } as never),
      );
      expect(result.success, JSON.stringify(broken)).toBe(false);
    }
  });

  it('refuses one criterion judged twice, which is two answers to one question', () => {
    expect(
      VerificationOutputSchema.safeParse(
        verificationOutput({ judgements: [judgement(), judgement({ verdict: 'unmet' })] } as never),
      ).success,
    ).toBe(false);
  });

  it('refuses a completed verification that judged nothing', () => {
    expect(
      VerificationOutputSchema.safeParse(verificationOutput({ judgements: [] })).success,
    ).toBe(false);
    // A blocked one need not have judged: refusing the honest refusal would promote the ladder
    // against a step that said it could not proceed (`step.schema_invalid_output` is
    // `escalate-model-tier`).
    expect(
      VerificationOutputSchema.safeParse(
        verificationOutput({ status: 'blocked', judgements: [] } as never),
      ).success,
    ).toBe(true);
  });
});

describe('the criteria are the ones the run was accepted with, byte for byte (matrix 18)', () => {
  it('accepts the verbatim criterion', () => {
    expect(criteriaNotAccepted(ACCEPTED, verificationOutput())).toStrictEqual([]);
  });

  it.each([
    ['trailing whitespace', `${ACCEPTED[0] ?? ''} `],
    ['a leading space', ` ${ACCEPTED[0] ?? ''}`],
    ['different case', (ACCEPTED[0] ?? '').toUpperCase()],
    ['a tidied wording', 'the loop takes at most one action per reconcile pass'],
    ['a softened wording', 'the loop usually takes at most one action per pass'],
  ])('names a criterion that differs by %s as one the run was not accepted with', (_why, criterion) => {
    /**
     * Each of these is a criterion a well-meaning step could produce, and each would let the step
     * judge itself against a standard nobody agreed to. Trimming would accept the first two, a case
     * fold the third, and "close enough" the last two — which is why the comparison is on the bytes
     * and the rule is stated in the field's own `.describe()`.
     */
    const output = verificationOutput({ judgements: [judgement({ criterion })] } as never);
    expect(criteriaNotAccepted(ACCEPTED, output)).toStrictEqual([criterion]);
  });
});

describe('a step cannot introduce a criterion of its own (matrix 19)', () => {
  it('names every criterion the run was not accepted with, not only the first', () => {
    const output = verificationOutput({
      judgements: [
        judgement(),
        judgement({ criterion: 'the code is elegant' }),
        judgement({ criterion: 'the author is happy with it' }),
      ],
    } as never);
    expect(criteriaNotAccepted(ACCEPTED, output)).toStrictEqual([
      'the code is elegant',
      'the author is happy with it',
    ]);
  });

  it('answers about any output that judges criteria, not only this contract’s', () => {
    // Keyed on the field rather than on `contract_id`, which is the discriminator idiom
    // `declaredTerritoryIn` uses: pinning it to one contract makes it dead for the next one that
    // has the field, which is exactly how story 2-5 found the territory recorder silently ignoring
    // two of the three contracts that declared one.
    expect(
      criteriaNotAccepted(ACCEPTED, { judgements: [{ criterion: 'invented' }] }),
    ).toStrictEqual(['invented']);
  });

  it('says nothing about an output that judges no criteria at all', () => {
    // "Introduced nothing" is the question asked here; "answered nothing" is a different fault, and
    // the contract's own `completed` rule is what reports it.
    expect(criteriaNotAccepted(ACCEPTED, { claims: [] })).toStrictEqual([]);
    expect(criteriaNotAccepted(ACCEPTED, null)).toStrictEqual([]);
  });
});

describe('a gate with no command is skipped, and a skip is not a pass (matrix 11, from the artifact)', () => {
  it('accepts a skipped gate with no status and no evidence', () => {
    expect(
      VerificationOutputSchema.safeParse(
        verificationOutput({
          gates: [gate({ declared: '', outcome: 'skipped', exit_status: null, evidence: '' })],
        } as never),
      ).success,
    ).toBe(true);
  });

  it('refuses a gate with no declared command reported as passed', () => {
    // The failure this contract exists to make unsayable: a repository with no tests reading as a
    // repository whose tests pass.
    const result = VerificationOutputSchema.safeParse(
      verificationOutput({
        gates: [gate({ declared: '', outcome: 'passed', exit_status: 0, evidence: '' })],
      } as never),
    );
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.path.join('.'))).toContain('gates.0.outcome');
  });

  it('refuses a skipped gate carrying an exit status or a pointer, which would mean it ran', () => {
    for (const broken of [
      { declared: '', outcome: 'skipped', exit_status: 0, evidence: '' },
      { declared: '', outcome: 'skipped', exit_status: null, evidence: 'evidence/test-1.log' },
    ]) {
      expect(
        VerificationOutputSchema.safeParse(verificationOutput({ gates: [gate(broken)] } as never))
          .success,
        JSON.stringify(broken),
      ).toBe(false);
    }
  });

  it('refuses an outcome that disagrees with the exit status the command returned', () => {
    for (const broken of [
      { outcome: 'passed', exit_status: 1 },
      { outcome: 'failed', exit_status: 0 },
      { outcome: 'passed', exit_status: null },
    ]) {
      expect(
        VerificationOutputSchema.safeParse(verificationOutput({ gates: [gate(broken)] } as never))
          .success,
        JSON.stringify(broken),
      ).toBe(false);
    }
  });

  it('refuses one gate reported twice', () => {
    expect(
      VerificationOutputSchema.safeParse(
        verificationOutput({ gates: [gate(), gate({ outcome: 'failed', exit_status: 1 })] } as never),
      ).success,
    ).toBe(false);
  });
});

describe('the economics, stated on the artifact as well as in the loop (matrix 16)', () => {
  it('refuses a completed verification that reports a failing gate', () => {
    /**
     * A review that cannot have happened.
     *
     * CAP-13 runs the gates before any model-based review and spends no review on a run that fails
     * them, so an output that judged the change while a gate was failing either judged it before the
     * gate ran or made the gate up. The loop is what enforces the order — asserted by the absence of
     * the spawn event in `tests/engine.gate-economics.test.ts` — and this is the same claim from the
     * artifact's side, so the two cannot disagree.
     */
    const result = VerificationOutputSchema.safeParse(
      verificationOutput({
        gates: [gate({ outcome: 'failed', exit_status: 1 })],
      } as never),
    );
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.message).join(' ')).toContain('CAP-13');
  });

  it('accepts a failed verification reporting the same gate, which is the honest shape', () => {
    expect(
      VerificationOutputSchema.safeParse(
        verificationOutput({
          status: 'failed',
          judgements: [],
          gates: [gate({ outcome: 'failed', exit_status: 1 })],
        } as never),
      ).success,
    ).toBe(true);
  });
});

describe('an evidence pointer stays inside the run’s evidence plane (AD-23)', () => {
  it.each(['/var/log/x', '~/.ssh/id_rsa', '../../etc/passwd', '.'])(
    'refuses a gate pointing at %s',
    (evidence) => {
      expect(
        VerificationOutputSchema.safeParse(verificationOutput({ gates: [gate({ evidence })] } as never))
          .success,
      ).toBe(false);
    },
  );
});
