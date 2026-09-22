/**
 * `step.analysis` — what the analysis agent returns. AD-2 puts every schema in code; this is the one
 * handed to `claude -p --json-schema` for the `analysis` phase and re-parsed against on the way back.
 *
 * Three decisions in here are load-bearing, and each is the thing the shipped `step.output` gets wrong
 * for this agent:
 *
 * **Provenance binds to a claim, because a list beside a list binds nothing.**
 * `StepOutput.provenance` is `z.array(z.string())` under the comment "Every claim carries the step that
 * produced it" — but there are no claims in that shape, so nothing stops a three-claim output carrying
 * one provenance entry, and an assertion over the array's length would pass on an output whose claims
 * are unattributed. Here every claim carries its own {@link ClaimProvenanceSchema}, and the refinement
 * is applied *per claim* rather than to a count.
 *
 * **A claim's paths lie inside the territory the same output declares.** `--add-dir` scoped to the run
 * worktree is what ADR-001 bounds the agent's file tools by, and the declared territory is what the
 * Consistency Conventions serialise two features on. A claim about a path outside either is a claim
 * about a file this step was not admitted to, so it is refused at parse — which is where AD-1
 * re-validates every output. The comparison is `src/contracts/territory.ts`'s, the same one the
 * reconciler admits with; a second implementation of path containment is the defect that reports an
 * overlap as disjoint.
 *
 * **The bounds are refinements, not JSON Schema keywords.** AD-2's structured-outputs subset admits no
 * `minLength` and no `minItems` above one, and a refinement emits nothing into the draft-7 export while
 * still holding at parse time. What a model *can* see is `.describe()`, so every rule a refinement
 * enforces is also stated in prose on the field it binds: a rule invisible to the producer would make
 * `step.schema_invalid_output` the normal outcome rather than the exceptional one.
 *
 * This contract carries no `schema_version`: like `StepOutputSchema`, it is the model-facing contract
 * and not an on-disk artifact (AD-28 binds the artifacts, and `src/contracts/schema-version.ts` says
 * why a model must never be asked for a version it cannot see).
 */
import { z } from 'zod';

import { StepOutputSchema } from './step.js';
import { isRepositoryRelativePath, territoryContains } from './territory.js';

/** The registry id this contract is registered under (AD-17), spelled once. */
export const ANALYSIS_CONTRACT_ID = 'step.analysis';

/**
 * Where one claim came from.
 *
 * `step` is the *producer*, which architecture.md's Coordination section requires of every claim: "Every
 * claim in an output carries the step that produced it." It is a step id and not a phase, because a run
 * has stable declared step names and two steps of one run can share a phase.
 *
 * `source` is what was read to support the claim — a repository path or an AD-23 evidence pointer. It is
 * separate from `step` because the two answer different questions: who says this, and on what. An
 * attribution naming only the step is a claim with no grounding, and one naming only a file is a claim
 * with no author.
 */
export const ClaimProvenanceSchema = z.object({
  step: z
    .string()
    .describe('The id of the step that produced this claim. Required on every claim; never blank.'),
  source: z
    .string()
    .describe(
      'The repository path or evidence pointer this claim was read from. Required; never blank.',
    ),
});

export type ClaimProvenance = z.infer<typeof ClaimProvenanceSchema>;

/**
 * One thing the analysis agent states, and its attribution.
 *
 * `paths` is the files the claim is *about*, which is what makes matrix row 18 checkable: a claim is
 * refused when it names a path the declared territory does not contain. A claim about no particular file
 * — a statement about the request itself — carries an empty list and is accepted, because an empty list
 * makes no assertion about a path rather than asserting a wrong one.
 */
export const AnalysisClaimSchema = z.object({
  claim: z.string().describe('One statement about the work, standing on its own.'),
  paths: z
    .array(z.string())
    .describe(
      'Repository-relative paths this claim is about, each inside the declared territory. Empty when ' +
        'the claim is about the request rather than about a file.',
    ),
  provenance: ClaimProvenanceSchema.describe(
    'The step that produced this claim and the source it was read from.',
  ),
});

export type AnalysisClaim = z.infer<typeof AnalysisClaimSchema>;

/** True when a provenance entry actually attributes: both halves present, neither blank. */
export const attributesClaim = (provenance: ClaimProvenance): boolean =>
  provenance.step.trim() !== '' && provenance.source.trim() !== '';

const AnalysisOutputShape = StepOutputSchema.extend({
  /**
   * Pinned to the registered id rather than left an open string.
   *
   * The spawner compares `contract_id` to the contract it validated against, and that check lives in
   * one call path. A literal here makes the same disagreement a refusal for *every* reader of the
   * artifact — matrix row 19 — and costs the export nothing but a `const`.
   */
  contract_id: z.literal(ANALYSIS_CONTRACT_ID),
  claims: z
    .array(AnalysisClaimSchema)
    .describe('Every claim this analysis makes. Each one carries its own provenance.'),
  /**
   * The territory analysis found, which is the correction to the one declared at run creation.
   *
   * `acceptFeature` emits `feature.territory_declared` from the caller's plan before any step has read
   * the repository; analysis is the first unit that actually knows which files a feature touches. The
   * engine records the re-declaration (`src/engine/territory.ts`); the agent never writes it, because
   * AD-15 leaves every write to the engine.
   */
  territory: z
    .array(z.string())
    .describe(
      'Repository-relative paths this feature touches. Declare at least one; "." means the whole ' +
        'repository and serialises this feature against every other one.',
    ),
  files_read: z
    .array(z.string())
    .describe('Repository-relative paths that were read to reach these claims.'),
});

/**
 * `step.analysis`'s output.
 *
 * Every refinement below is applied per element and names the element it refused, so a refusal says
 * which claim was unattributed rather than that "provenance was invalid".
 */
export const AnalysisOutputSchema = AnalysisOutputShape.superRefine((output, ctx) => {
  output.claims.forEach((claim, index) => {
    if (!attributesClaim(claim.provenance)) {
      ctx.addIssue({
        code: 'custom',
        path: ['claims', index, 'provenance'],
        message:
          'every claim carries the step that produced it and the source it was read from ' +
          '(architecture.md, Coordination); a claim with either half blank is unattributed',
      });
    }
    claim.paths.forEach((path, pathIndex) => {
      if (!isRepositoryRelativePath(path)) {
        ctx.addIssue({
          code: 'custom',
          path: ['claims', index, 'paths', pathIndex],
          message:
            `"${path}" is not inside the run worktree; a claim's path is repository-relative, because ` +
            'ADR-001 bounds this agent by --add-dir scoped to that worktree',
        });
        return;
      }
      if (!territoryContains(output.territory, path)) {
        ctx.addIssue({
          code: 'custom',
          path: ['claims', index, 'paths', pathIndex],
          message:
            `"${path}" is outside the territory this output declares (${output.territory.join(', ')}); ` +
            'a claim about a file the feature does not claim is a claim about another feature’s work',
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
    ctx.addIssue({
      code: 'custom',
      path: ['territory'],
      /**
       * An empty territory is the one value that fails *open*: it collides with nothing, so the
       * reconciler would admit this feature beside every other one. `WHOLE_REPOSITORY_TERRITORY` is
       * what an unreadable declaration becomes for exactly that reason, and a declaration of nothing is
       * not a statement that the feature touches nothing — it is a missing answer.
       */
      message:
        'declare at least one path; an empty territory overlaps nothing and would be admitted beside ' +
        'every other feature, which is the one failure direction the serialisation must not have',
    });
  }
  output.files_read.forEach((path, index) => {
    if (!isRepositoryRelativePath(path)) {
      ctx.addIssue({
        code: 'custom',
        path: ['files_read', index],
        message: `"${path}" is not inside the run worktree, so this step cannot have read it`,
      });
    }
  });
});

export type AnalysisOutput = z.infer<typeof AnalysisOutputSchema>;
