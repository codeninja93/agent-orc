/**
 * `step.verification` — the two tiers of CAP-13 in one artifact: what the deterministic gates did,
 * and then what the model judged against the criteria the run was accepted with.
 *
 * **Why the two tiers are one step and one contract.** "Model-based review" appears exactly once in
 * `SPEC.md`, in CAP-13's success line, and the roster has no reviewer to give it to. So verification
 * runs the declared gates first — deterministic, no model judgement — and spends model turns only if
 * they pass. The sequencing is the engine's (`src/engine/reconciler.ts`), because a spawn is the
 * thing that costs, and a step cannot decline to be spawned. What this contract does is make the
 * result of both tiers *sayable*, and refuse the outputs that could not have come from that order.
 *
 * **A `completed` output reporting a failed gate is refused.** It describes a run that cannot have
 * happened: the model tier is not reached on a failing gate, so an output that judged the change
 * while a gate was failing either judged it before the gate ran or made the gate up. Either way the
 * economics CAP-13 states — "no review spend occurs on a run that fails them" — would be false while
 * the artifact claimed it held.
 *
 * **A skipped gate is not a passed gate, and the schema will not let the two be spelled alike.** A
 * declared command that is the empty string is a repository saying it has no such step, which
 * `lint` has always been allowed to say. The gate is then `skipped` with no exit status, and
 * `passed` requires an exit status of zero — so "a repository with no tests" cannot be reported as
 * "a repository whose tests pass", which is how an unverified change reads as a verified one.
 *
 * **The criteria are matched byte for byte, and that check is not in this file.** A contract sees one
 * artifact and cannot see the run, so it cannot know what the run was accepted with — the same limit
 * `step.implementation` states about territory. {@link criteriaNotAccepted} is the comparison, and
 * the caller that has both halves is the spawner, which already re-parses every output against its
 * contract before the loop may accept it. What the refinements here can enforce is internal
 * consistency: a judgement is attributed, is not blank, and is not made twice.
 *
 * **Bounds are refinements plus prose.** AD-2's structured-outputs subset admits no `minItems` above
 * one, no `minLength` and no `minimum`, and a refinement emits nothing into the draft-7 export — so
 * every rule a refinement enforces is also stated in the `.describe()` of the field it binds.
 *
 * It carries no `schema_version`: it is the model-facing contract, not an on-disk artifact.
 */
import { z } from 'zod';

import { ClaimProvenanceSchema, attributesClaim } from './analysis.js';
import { DETERMINISTIC_GATE_NAMES } from './installer.js';
import { StepOutputSchema } from './step.js';
import { isRepositoryRelativePath, normaliseTerritoryPath } from './territory.js';

/** The registry id this contract is registered under (AD-17), spelled once. */
export const VERIFICATION_CONTRACT_ID = 'step.verification';

/**
 * What one gate did.
 *
 * Three values and not two, because "there is no such command" is a third answer and folding it into
 * either of the others loses the one fact a person needs: a repository with no typecheck step is not
 * a repository whose typecheck passed, and it is not a repository whose typecheck failed either.
 */
export const GATE_OUTCOMES = ['passed', 'failed', 'skipped'] as const;

export type GateOutcome = (typeof GATE_OUTCOMES)[number];

/**
 * One deterministic gate, as the step reports it.
 *
 * `declared` is the command the profile declares for this gate, carried verbatim so the report says
 * *what ran* and not only that something did. It is also what makes the skip rule checkable from the
 * artifact alone: an empty declaration is the only thing that may be reported as skipped.
 *
 * The engine's own `gate.*` events are authoritative (AD-4); this is the step's report of them, and
 * a report that contradicts itself is refused here rather than believed.
 */
export const GateReportSchema = z.object({
  command: z
    .enum(DETERMINISTIC_GATE_NAMES)
    .describe(
      'Which deterministic gate this is. CAP-13 names exactly typecheck, lint and test; build and ' +
        'run are mechanics the profile records for other purposes and are not gates.',
    ),
  declared: z
    .string()
    .describe(
      'The command the profile declares for this gate, verbatim. The empty string means the ' +
        'repository declares none, and is the only declaration that may be reported as skipped.',
    ),
  outcome: z
    .enum(GATE_OUTCOMES)
    .describe(
      'What the gate did: "passed" for an exit status of zero, "failed" for any other status, ' +
        '"skipped" when no command is declared. A skipped gate is never reported as passed.',
    ),
  exit_status: z
    .number()
    .nullable()
    .describe(
      'The whole-number exit status the command reported: 0 for a pass, non-zero for a failure, ' +
        'and null only for a skipped gate, which ran nothing to have a status.',
    ),
  evidence: z
    .string()
    .describe(
      'The evidence-plane pointer at which this gate’s output was written (AD-23), ' +
        'repository-relative to the run directory. Never the output itself, which does not enter ' +
        'the control plane. Empty for a skipped gate, which produced none.',
    ),
});

export type GateReport = z.infer<typeof GateReportSchema>;

/** What the model judged about one acceptance criterion. */
export const CRITERION_VERDICTS = ['met', 'unmet', 'undetermined'] as const;

export type CriterionVerdict = (typeof CRITERION_VERDICTS)[number];

/**
 * One acceptance criterion and the verdict reached on it.
 *
 * `criterion` is the criterion **verbatim**, because CAP-13's intent is that implementation is
 * "judged against criteria fixed before it was written" and a re-wording is a different criterion
 * wearing the same meaning — which is exactly how a step comes to pass against a standard it set for
 * itself. {@link criteriaNotAccepted} is what holds it to the bytes; this field is where they go.
 *
 * `undetermined` is a real verdict and not a failure to answer: a criterion nothing in the change or
 * the evidence speaks to is more honestly reported than guessed at, and reporting it as met is the
 * one direction that cannot be recovered from.
 */
export const CriterionJudgementSchema = z.object({
  criterion: z
    .string()
    .describe(
      'One acceptance criterion, copied verbatim from the step input — the same characters, not a ' +
        'paraphrase and not a tidied version. A criterion the run was not accepted with is refused. ' +
        'Never blank, and each criterion is judged at most once.',
    ),
  verdict: z
    .enum(CRITERION_VERDICTS)
    .describe(
      'Whether the change meets this criterion: "met", "unmet", or "undetermined" when nothing ' +
        'read settles it. Report "undetermined" rather than guessing.',
    ),
  grounds: z
    .string()
    .describe('Why this verdict, in one line that stands alone and cites what was read. Never blank.'),
  provenance: ClaimProvenanceSchema.describe(
    'The step that reached this verdict and the source it was read from — a changed file, a gate’s ' +
      'evidence pointer, or a test. The source is attribution only; nothing opens it.',
  ),
});

export type CriterionJudgement = z.infer<typeof CriterionJudgementSchema>;

const VerificationOutputShape = StepOutputSchema.extend({
  /**
   * Pinned to the registered id, so an output claiming `step.output` is refused by every reader of
   * the artifact and not only by the spawner's own comparison.
   */
  contract_id: z.literal(VERIFICATION_CONTRACT_ID),
  gates: z
    .array(GateReportSchema)
    .describe(
      'Every deterministic gate CAP-13 names, each reported once: what was declared for it, what it ' +
        'did, and where its output was written. A gate with no declared command is reported as ' +
        'skipped, never as passed.',
    ),
  judgements: z
    .array(CriterionJudgementSchema)
    .describe(
      'One verdict per acceptance criterion the run was accepted with, each carrying its own ' +
        'provenance. A completed verification judges at least one; report "blocked" rather than ' +
        'completing with none. Judging a criterion the run was not accepted with is refused.',
    ),
});

/**
 * `step.verification`'s output.
 *
 * Each refinement is applied per element and names the element it refused, so a refusal says which
 * gate or which judgement was wrong rather than that "gates was invalid".
 */
export const VerificationOutputSchema = VerificationOutputShape.superRefine((output, ctx) => {
  const reported = new Set<string>();
  output.gates.forEach((gate, index) => {
    if (reported.has(gate.command)) {
      ctx.addIssue({
        code: 'custom',
        path: ['gates', index, 'command'],
        message:
          `the ${gate.command} gate is reported twice; one gate has one outcome in one step, and two ` +
          'records for it are two answers to whether it passed',
      });
    }
    reported.add(gate.command);

    const declared = gate.declared.trim() !== '';
    if (!declared && gate.outcome !== 'skipped') {
      ctx.addIssue({
        code: 'custom',
        path: ['gates', index, 'outcome'],
        message:
          `the ${gate.command} gate declares no command, so it ran nothing and is "skipped". A gate ` +
          'with no command reported as passed is how a repository with no tests reads as fully ' +
          'verified.',
      });
    }
    if (declared && gate.outcome === 'skipped') {
      ctx.addIssue({
        code: 'custom',
        path: ['gates', index, 'outcome'],
        message:
          `the ${gate.command} gate declares "${gate.declared}", so it is skipped only by not being ` +
          'run — which is a gate that did not happen, not a gate with nothing to do. Report what the ' +
          'command did.',
      });
    }
    if (gate.outcome === 'skipped') {
      if (gate.exit_status !== null) {
        ctx.addIssue({
          code: 'custom',
          path: ['gates', index, 'exit_status'],
          message: 'a skipped gate ran no command, so it has no exit status; report null',
        });
      }
      if (gate.evidence.trim() !== '') {
        ctx.addIssue({
          code: 'custom',
          path: ['gates', index, 'evidence'],
          message: 'a skipped gate produced no output, so it points at no evidence; report ""',
        });
      }
      return;
    }
    if (gate.exit_status === null || !Number.isInteger(gate.exit_status)) {
      ctx.addIssue({
        code: 'custom',
        path: ['gates', index, 'exit_status'],
        message:
          'a gate that ran reports the whole-number exit status its command returned; null is ' +
          'reserved for a gate that ran nothing',
      });
      return;
    }
    const passed = gate.exit_status === 0;
    if (passed !== (gate.outcome === 'passed')) {
      ctx.addIssue({
        code: 'custom',
        path: ['gates', index, 'outcome'],
        message:
          `the ${gate.command} gate exited ${String(gate.exit_status)} and is reported "${gate.outcome}"; ` +
          'a gate passes exactly when its command exits 0, and the exit status is the fact',
      });
    }
    if (!isRepositoryRelativePath(gate.evidence) || normaliseTerritoryPath(gate.evidence) === '.') {
      ctx.addIssue({
        code: 'custom',
        path: ['gates', index, 'evidence'],
        message:
          `"${gate.evidence}" is not a pointer into the run's evidence plane; AD-23 keeps a command's ` +
          'output out of the control plane and references it by a path inside the run directory',
      });
    }
  });

  /**
   * The economics, as a refusal on the artifact.
   *
   * CAP-13: "no review spend occurs on a run that fails them". The engine is what enforces that, by
   * not spawning — see `src/engine/reconciler.ts` and `tests/engine.gate-economics.test.ts`, where
   * it is asserted by the *absence* of the spawn event. This is the other side of the same claim: an
   * output that completed while reporting a failing gate is describing a review that the run's own
   * sequencing says never happened, so accepting it would let the artifact contradict the log.
   */
  if (output.status === 'completed') {
    const failed = output.gates.filter((gate) => gate.outcome === 'failed');
    if (failed.length > 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['status'],
        message:
          `this output completed while reporting the ${failed
            .map((gate) => gate.command)
            .join(', ')} gate as failed. CAP-13 runs the deterministic gates before any model-based ` +
          'review and spends no review on a run that fails them, so a completed verification over a ' +
          'failing gate is a review that cannot have happened. Report "failed".',
      });
    }
    if (output.judgements.length === 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['judgements'],
        message:
          'a completed verification judges at least one acceptance criterion; an empty list is a ' +
          'verification that verified nothing, and it makes every per-judgement rule pass vacuously. ' +
          'Report "blocked" instead if the criteria could not be judged.',
      });
    }
  }

  const judged = new Set<string>();
  output.judgements.forEach((judgement, index) => {
    if (judgement.criterion.trim() === '') {
      ctx.addIssue({
        code: 'custom',
        path: ['judgements', index, 'criterion'],
        message:
          'a judgement names the criterion it is about; a blank one is a verdict on nothing that ' +
          'still counts as a criterion judged',
      });
    }
    if (judgement.grounds.trim() === '') {
      ctx.addIssue({
        code: 'custom',
        path: ['judgements', index, 'grounds'],
        message: 'a verdict states its grounds; a blank line is an assertion with nothing behind it',
      });
    }
    if (!attributesClaim(judgement.provenance)) {
      ctx.addIssue({
        code: 'custom',
        path: ['judgements', index, 'provenance'],
        message:
          'every judgement carries the step that reached it and the source it was read from ' +
          '(architecture.md, Coordination); a verdict with either half blank is unattributed',
      });
    }
    if (judged.has(judgement.criterion)) {
      ctx.addIssue({
        code: 'custom',
        path: ['judgements', index, 'criterion'],
        message:
          `"${judgement.criterion}" is judged twice; two verdicts on one criterion are two answers to ` +
          'whether the change meets it',
      });
    }
    judged.add(judgement.criterion);
  });

  output.artifacts.forEach((pointer, index) => {
    if (!isRepositoryRelativePath(pointer.path)) {
      ctx.addIssue({
        code: 'custom',
        path: ['artifacts', index, 'path'],
        message:
          `"${pointer.path}" is not a path inside the run's evidence plane; AD-23 has an artifact ` +
          'referenced by a pointer into that plane, never by an absolute path, a home-directory path ' +
          'or one climbing out of the run directory',
      });
      return;
    }
    if (normaliseTerritoryPath(pointer.path) === '.') {
      ctx.addIssue({
        code: 'custom',
        path: ['artifacts', index, 'path'],
        message:
          `"${pointer.path}" resolves to the run directory itself, not to an artifact in it; an ` +
          'evidence pointer names the one thing it points at (AD-23)',
      });
    }
  });
});

export type VerificationOutput = z.infer<typeof VerificationOutputSchema>;

/**
 * The shape of "an output that judges acceptance criteria": one field, of the right type.
 *
 * Loose on purpose, and for the reason `declaredTerritoryIn` gives about territory: it is a
 * *discriminator*, not a contract. Every judging output is validated against its own registered
 * contract first, and asking `VerificationOutputSchema.safeParse` here would pin `contract_id` to
 * `step.verification` — so a later contract that also judges criteria would have its judgements
 * silently unchecked, which is the defect story 2-5 found in the territory recorder wearing the
 * fix's clothes.
 */
const JudgingOutputSchema = z.object({
  judgements: z.array(z.object({ criterion: z.string() })),
});

/**
 * The criteria an output judged that the run was **not** accepted with, or an empty list.
 *
 * **Byte-identical, deliberately: no trim, no case fold, no normalisation.** CAP-13's intent is that
 * implementation is "judged against criteria fixed before it was written", and the only way to show
 * that the criteria judged are the ones the run was accepted with is that they are the same bytes.
 * A comparison that trimmed would accept a criterion the step had re-typed, and a step that can
 * re-type a criterion can soften one — which is the whole of what this function exists to prevent. A
 * step that wants a different standard has to say so as a question or a decision, not as a string it
 * judged itself against.
 *
 * An output that judges nothing answers with an empty list rather than with every accepted
 * criterion: "introduced nothing" is the question asked here, and "answered nothing" is a different
 * fault that the contract's own `completed` rule reports.
 */
export const criteriaNotAccepted = (
  accepted: readonly string[],
  output: unknown,
): readonly string[] => {
  const parsed = JudgingOutputSchema.safeParse(output);
  if (!parsed.success) return [];
  return parsed.data.judgements
    .map((judgement) => judgement.criterion)
    .filter((criterion) => !accepted.includes(criterion));
};
