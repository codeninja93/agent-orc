/**
 * `step.adversarial` — CAP-13's other half: something that actively tries to break what `verify` just
 * judged met, rather than judging it a second time.
 *
 * **Why this is a new contract and not a third tier bolted onto `step.verification`.** That contract's
 * own docblock gives one reason its two tiers live together: "the roster has no reviewer to give it
 * to". Story 4-2 adds one. Once a reviewer exists, folding its output into `step.verification` would
 * repeat the exact mistake `testing`/`verification` were split to avoid — an agent that can edit or
 * re-judge the thing it is supposed to be independent of. So this is its own agent, its own step, and
 * its own contract, spawned only once `verify`'s own judgements are all `met` (`src/engine/reconciler.ts`,
 * the spawn-gating check beside `runGatesBeforeReview`).
 *
 * **One attack attempt per element: what was tried, what happened, and a verdict.** `held` means the
 * attempt did not find a break; `broken` means it did. Each is attributed
 * ({@link ClaimProvenanceSchema}, reused verbatim from `step.analysis`) and never blank — the same
 * discipline `CriterionJudgementSchema` already enforces for a verification judgement, because an
 * unattributed claim about a break is exactly as unusable as an unattributed claim about a criterion.
 *
 * **The overall verdict is asserted and then held to the attempts, never derived in code.** AD-2's
 * structured-outputs subset admits no way to compute one field from another inside the schema the model
 * is handed, so the model states `verdict` itself and the refinement below refuses an output whose
 * `verdict` disagrees with what its own `attempts` report: `broken` if any attempt is `broken`, `held`
 * otherwise. A report cannot claim overall success while also reporting a break, the same
 * internal-consistency discipline `VerificationOutputSchema` already applies to its own gates and
 * judgements.
 *
 * **`gates` is copied, never re-derived.** Nothing changes the worktree between `verify` and
 * `adversarial` — neither step writes to it — so the deterministic gate outcomes `verify`'s own input
 * already carried are still true, and this step's input carries the very same report
 * (`src/engine/reconciler.ts` reads them back from the log rather than running them a second time).
 * `GateReportSchema` is imported from `step.verification`'s own module and used verbatim: this is one
 * shape, stated once, not two schemas that happen to agree today.
 *
 * **The cross-artifact gate check is not here.** Whether this output's claimed gate outcomes agree with
 * the engine's own authoritative `gate.*` events is a question this file cannot answer — a contract sees
 * one artifact and cannot see the run, the same limit `step.verification`'s own docblock states. That
 * comparison is `gatesDisagreeingWith`, already wired generically (by field shape, not by contract id)
 * into the spawner's re-parse of every step's output, so `step.adversarial`'s report is held to it for
 * free by reusing the same field name and shape rather than by any code this story adds.
 *
 * It carries no `schema_version`: it is the model-facing contract, not an on-disk artifact.
 */
import { z } from 'zod';

import { ClaimProvenanceSchema, attributesClaim } from './analysis.js';
import { GateReportSchema } from './verification.js';
import { StepOutputSchema } from './step.js';

/** The registry id this contract is registered under (AD-17), spelled once. */
export const ADVERSARIAL_CONTRACT_ID = 'step.adversarial';

/**
 * Whether one attempt to break the implementation found a way in.
 *
 * Two values, not a pass/fail pair borrowed from the gates: `held` is a positive claim that the attempt
 * was made and did not succeed, never the absence of an attempt — an output that made no attempt is
 * refused elsewhere (at least one attempt is required of a completed output, matching `judgements`'s
 * own "a completed verification judges at least one" rule).
 */
export const ATTACK_VERDICTS = ['held', 'broken'] as const;

export type AttackVerdict = (typeof ATTACK_VERDICTS)[number];

/**
 * One attempt to break the implementation, and what it found.
 *
 * `attempted` and `observed` are the same shape `CriterionJudgementSchema` gives `criterion` and
 * `grounds`: one names what the claim is about, the other is why the verdict follows from it, and
 * both stand on their own rather than referring back to a transcript nobody else can read.
 */
export const AttackAttemptSchema = z.object({
  attempted: z
    .string()
    .describe(
      'What was tried to break the implementation, in one line that stands alone. Never blank.',
    ),
  observed: z
    .string()
    .describe(
      'What happened when it was tried — the grounds for the verdict below, citing what was read or ' +
        'run. Never blank.',
    ),
  verdict: z
    .enum(ATTACK_VERDICTS)
    .describe(
      '"held" when the attempt did not find a break, "broken" when it did. Report "broken" rather ' +
        'than a softened "held" for anything that actually broke.',
    ),
  provenance: ClaimProvenanceSchema.describe(
    'The step that made this attempt and the source it read or ran to observe the result.',
  ),
});

export type AttackAttempt = z.infer<typeof AttackAttemptSchema>;

const AdversarialOutputShape = StepOutputSchema.extend({
  /**
   * Pinned to the registered id, so an output claiming `step.output` is refused by every reader of the
   * artifact and not only by the spawner's own comparison.
   */
  contract_id: z.literal(ADVERSARIAL_CONTRACT_ID),
  /**
   * The same deterministic-gate report `step.verification`'s own input already carried, copied
   * verbatim — never re-run. `GateReportSchema` is imported from that module rather than redeclared,
   * so the two contracts share one definition of what a gate report is.
   */
  gates: z
    .array(GateReportSchema)
    .describe(
      'Every deterministic gate CAP-13 names, copied verbatim from the `gates` field of the step ' +
        'input — the same report `verify` already produced. Nothing here re-runs a gate.',
    ),
  attempts: z
    .array(AttackAttemptSchema)
    .describe(
      'One entry per attempt to break the implementation. A completed report makes at least one; ' +
        'report "blocked" rather than completing with none.',
    ),
  verdict: z
    .enum(ATTACK_VERDICTS)
    .describe(
      'The overall result: "broken" if any attempt above is "broken", "held" otherwise. Asserted here ' +
        'and held to the attempts by the contract’s own refusal — it may not disagree with them.',
    ),
});

/**
 * `step.adversarial`'s output.
 *
 * Each refinement is applied per element and names the element it refused, matching
 * `VerificationOutputSchema`'s own style, so a refusal says which attempt was wrong rather than that
 * "attempts was invalid".
 */
export const AdversarialOutputSchema = AdversarialOutputShape.superRefine((output, ctx) => {
  if (output.status === 'completed' && output.attempts.length === 0) {
    ctx.addIssue({
      code: 'custom',
      path: ['attempts'],
      message:
        'a completed adversarial report makes at least one attempt; an empty list is a report that ' +
        'tried nothing, and it makes every per-attempt rule pass vacuously. Report "blocked" instead ' +
        'if no attempt could be made.',
    });
  }

  /**
   * The overall verdict, held to the attempts rather than asserted independently.
   *
   * CAP-13's adversarial half only means something if a report cannot claim success while also
   * reporting a break — the same discipline `VerificationOutputSchema` applies between a completed
   * status and a failing gate. Checked whenever there are attempts to check against, not only when
   * `status` is `completed`: a `blocked` or `failed` report that still asserts a verdict is held to
   * the same consistency, because nothing about this rule depends on the status.
   */
  const anyBroken = output.attempts.some((attempt) => attempt.verdict === 'broken');
  const derived: AttackVerdict = anyBroken ? 'broken' : 'held';
  if (output.attempts.length > 0 && output.verdict !== derived) {
    ctx.addIssue({
      code: 'custom',
      path: ['verdict'],
      message:
        `this output reports ${anyBroken ? 'a' : 'no'} broken attempt among its attempts, but claims ` +
        `the overall verdict "${output.verdict}". The overall verdict is "broken" if any attempt is ` +
        '"broken" and "held" otherwise; it may not disagree with what the attempts themselves report.',
    });
  }

  output.attempts.forEach((attempt, index) => {
    if (attempt.attempted.trim() === '') {
      ctx.addIssue({
        code: 'custom',
        path: ['attempts', index, 'attempted'],
        message: 'an attempt names what was tried; a blank line is a verdict on nothing that was done',
      });
    }
    if (attempt.observed.trim() === '') {
      ctx.addIssue({
        code: 'custom',
        path: ['attempts', index, 'observed'],
        message: 'an attempt states what was observed; a blank line is a verdict with nothing behind it',
      });
    }
    if (!attributesClaim(attempt.provenance)) {
      ctx.addIssue({
        code: 'custom',
        path: ['attempts', index, 'provenance'],
        message:
          'every attempt carries the step that made it and the source it was read from ' +
          '(architecture.md, Coordination); an attempt with either half blank is unattributed',
      });
    }
  });
});

export type AdversarialOutput = z.infer<typeof AdversarialOutputSchema>;

/** The shape of "an output that reports attack attempts", for the discriminator idiom below. */
const AttemptReportingOutputSchema = z.object({
  attempts: z.array(z.object({ verdict: z.enum(ATTACK_VERDICTS) })),
});

/**
 * True when a step's output is an adversarial report claiming at least one broken attempt.
 *
 * **Keyed on the field, not the contract id or the phase.** The same reason `declaredTerritoryIn`
 * and `composedProseIn` ask their own questions this way: a phase test would be a second place
 * deciding what the adversarial agent is, and this only needs to know whether *this* output reports a
 * break at all. The spawner-side hand-off routing (`src/engine/reconciler.ts`) reuses this rather than
 * re-deriving it, so the one place that knows what a "broken" report looks like is this file.
 */
export const brokenAttemptIn = (output: unknown): boolean => {
  const parsed = AttemptReportingOutputSchema.safeParse(output);
  return parsed.success && parsed.data.attempts.some((attempt) => attempt.verdict === 'broken');
};
