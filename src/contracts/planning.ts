/**
 * `step.planning` — what the planning agent returns: the ordered steps, each one attributed.
 *
 * **Distinct from `step.analysis`, not a shared shape.** The two agents hold the same tool grant
 * (ADR-003) and are separated by their contracts and their prompts, exactly as `implementation` and
 * `testing` are. One contract serving both would make "which agent produced this" unanswerable from the
 * artifact, and the registry would have one id where AD-17 needs two — a roster entry references a
 * contract *id*, so two agents sharing one id cannot be told apart by anything the engine reads.
 *
 * **Its grounding is the request, never analysis's summary.** `architecture.md` requires every agent to
 * re-ground on "the original, verbatim feature request — never a summary of a summary", and
 * `StepInputSchema` carries exactly that in `request` with the criteria in a separate array. There is no
 * input field carrying a summary, so planning reads the same `request` analysis read. It may read
 * analysis's *output* as a prior artifact from the worktree — handoffs are commits — which is the
 * no-agent-to-agent-messaging rule rather than an exception to it.
 *
 * **Each planned step carries provenance, for the reason analysis's claims do.** A plan is a set of
 * assertions about what has to happen; an unattributed step is one nobody can trace to what it was read
 * from. The refinement is per step, not over a parallel array.
 */
import { z } from 'zod';

import { ClaimProvenanceSchema, attributesClaim } from './analysis.js';
import { STEP_PHASES } from './state.js';
import { StepOutputSchema } from './step.js';
import { isRepositoryRelativePath, territoryContains } from './territory.js';

/** The registry id this contract is registered under (AD-17), spelled once. */
export const PLANNING_CONTRACT_ID = 'step.planning';

/**
 * One step of the plan.
 *
 * `step` is a stable declared name and never a positional index (Consistency Conventions); the array's
 * order is the order the steps run in, which is why no `order` field exists to disagree with it.
 *
 * `contract_id` is a plain string rather than a registry-checked id, for the reason
 * `AgentDeclarationSchema.contract` is: the check belongs where it does not make
 * `src/contracts/registry.ts` and this module import each other, and the registry is what registers this
 * shape. The engine resolves it through `getContract` when it builds the step.
 */
export const PlannedStepSchema = z.object({
  step: z.string().describe('The step id: a stable declared name, never a positional index.'),
  phase: z
    .enum(STEP_PHASES)
    .describe('Which phase of the run this step belongs to.'),
  contract_id: z
    .string()
    .describe('The registered contract id this step’s output will be validated against.'),
  intent: z.string().describe('What this step is for, in one line that stands alone.'),
  territory: z
    .array(z.string())
    .describe(
      'Repository-relative paths this step expects to touch, each inside the territory this plan ' +
        'declares.',
    ),
  provenance: ClaimProvenanceSchema.describe(
    'The step that produced this planned step and the source it was read from.',
  ),
});

export type PlannedStep = z.infer<typeof PlannedStepSchema>;

const PlanningOutputShape = StepOutputSchema.extend({
  /** Pinned to the registered id, so a contract disagreement is a refusal for every reader (row 19). */
  contract_id: z.literal(PLANNING_CONTRACT_ID),
  plan: z
    .array(PlannedStepSchema)
    .describe('The steps in the order they run. Each carries its own provenance.'),
  territory: z
    .array(z.string())
    .describe(
      'Repository-relative paths this feature touches, covering every step’s territory. Declare at ' +
        'least one; "." means the whole repository.',
    ),
});

/**
 * `step.planning`'s output.
 *
 * The refinements are per planned step and name the step they refused, so a refusal says which step was
 * unattributed or claimed a path the plan does not.
 */
export const PlanningOutputSchema = PlanningOutputShape.superRefine((output, ctx) => {
  const seen = new Set<string>();
  output.plan.forEach((step, index) => {
    if (seen.has(step.step)) {
      ctx.addIssue({
        code: 'custom',
        path: ['plan', index, 'step'],
        message:
          `step id "${step.step}" appears twice; a step id appears at most once in a run, because a ` +
          're-run updates its record rather than adding one (AD-26)',
      });
    }
    seen.add(step.step);
    if (!attributesClaim(step.provenance)) {
      ctx.addIssue({
        code: 'custom',
        path: ['plan', index, 'provenance'],
        message:
          'every planned step carries the step that produced it and the source it was read from ' +
          '(architecture.md, Coordination); a step with either half blank is unattributed',
      });
    }
    step.territory.forEach((path, pathIndex) => {
      if (!isRepositoryRelativePath(path)) {
        ctx.addIssue({
          code: 'custom',
          path: ['plan', index, 'territory', pathIndex],
          message:
            `"${path}" is not inside the run worktree; ADR-001 bounds this agent by --add-dir scoped ` +
            'to that worktree',
        });
        return;
      }
      if (!territoryContains(output.territory, path)) {
        ctx.addIssue({
          code: 'custom',
          path: ['plan', index, 'territory', pathIndex],
          message:
            `"${path}" is outside the territory this plan declares (${output.territory.join(', ')}); ` +
            'the declared territory is what the reconciler serialises two features on, so a step ' +
            'touching more than it would write outside the conflict domain it was admitted for',
        });
      }
    });
  });
  output.territory.forEach((path, index) => {
    if (!isRepositoryRelativePath(path)) {
      ctx.addIssue({
        code: 'custom',
        path: ['territory', index],
        message: `"${path}" is not a repository-relative path, so no run worktree contains it`,
      });
    }
  });
  if (output.territory.length === 0) {
    // The same fail-open case `step.analysis` refuses: a territory that overlaps nothing is admitted
    // beside every other feature.
    ctx.addIssue({
      code: 'custom',
      path: ['territory'],
      message:
        'declare at least one path; an empty territory overlaps nothing and would be admitted beside ' +
        'every other feature',
    });
  }
});

export type PlanningOutput = z.infer<typeof PlanningOutputSchema>;
