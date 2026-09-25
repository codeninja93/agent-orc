/**
 * `step.bootstrap` — CAP-20's bootstrap agent: what a person would have typed for the three profile
 * fields detection cannot answer, stated by a model that has actually read the repository.
 *
 * `detectDefaults` (the installer's own filesystem checks — lockfile, `package.json` scripts, a fixed
 * directory list) already covers most of AD-16's mechanics fields. What is left needs judgement over
 * the repository's actual content: does a run need postgres or redis (`mechanics.resources`), which
 * paths are genuinely high blast radius or must not be worked on concurrently (`risk.*`), and what is
 * worth recording as project knowledge for a future run (`knowledge`). This contract is what a model
 * returns for those three, and nothing else — it states no mechanics a filesystem check already answers,
 * and it writes nothing (`src/engine/bootstrap.ts`'s `mergeBootstrapAnalysis` is a pure function over an
 * already-completed instance of this shape).
 *
 * **Extends `StepOutputSchema` exactly as `AnalysisOutputSchema` does, and for the same reasons.** A
 * `contract_id` literal, so a disagreement between what an agent's TOML declares and what it actually
 * returns is a refusal every reader shares (AD-1). A `claims` array carrying per-claim
 * {@link ClaimProvenanceSchema}, reused verbatim from `src/contracts/analysis.ts` rather than
 * reimplemented, because the discipline it encodes — "every claim carries the step that produced it and
 * the source it was read from" (architecture.md, Coordination) — is not particular to what an analysis
 * step's claims are about. `claims` is this contract's attribution trail for the two decisions below that
 * are not self-provenanced; `knowledge` needs no such trail because {@link KnowledgeEntrySchema} already
 * carries its own `provenance` field.
 *
 * **Every path-bearing field is validated with `isRepositoryRelativePath`, the same function
 * `AnalysisOutputSchema` validates its own `territory`/`files_read`/claim-paths with.** A bootstrap
 * analysis declares no scoped territory of its own — it is read over the whole repository, not one
 * feature's declared slice of it — so there is no containment check to make beyond "is this actually a
 * path inside the repository", which is exactly what {@link isRepositoryRelativePath} answers. A second
 * implementation of that question is the defect this reuse exists to prevent.
 *
 * **`knowledge` reuses `KnowledgeEntrySchema` (story 5-1) verbatim.** A bootstrap-authored entry is
 * indistinguishable, once written, from one a person typed or one story 5-1's consolidation pass folded
 * from a run — same anchor, same claim, same provenance, same decay policy — so it needs no shape of its
 * own.
 *
 * This contract carries no `schema_version`: like `StepOutputSchema`, it is the model-facing contract and
 * not an on-disk artifact (AD-28).
 */
import { z } from 'zod';

import { AnalysisClaimSchema, attributesClaim } from './analysis.js';
import { RESOURCE_NEEDS } from './installer.js';
import { KnowledgeEntrySchema } from './knowledge.js';
import { StepOutputSchema } from './step.js';
import { isRepositoryRelativePath } from './territory.js';

/** The registry id this contract is registered under (AD-17), spelled once. */
export const BOOTSTRAP_CONTRACT_ID = 'step.bootstrap';

const BootstrapAnalysisShape = StepOutputSchema.extend({
  /** Pinned to the registered id, for the reason `AnalysisOutputSchema.contract_id` is (AD-1, AD-17). */
  contract_id: z.literal(BOOTSTRAP_CONTRACT_ID),
  /**
   * The attribution trail for `resources`, `high_blast_radius_paths` and `conflict_domains` below: what
   * was read, and what it was read to support. `AnalysisClaimSchema` reused verbatim, per this module's
   * own docblock.
   */
  claims: z
    .array(AnalysisClaimSchema)
    .describe(
      'Every claim this bootstrap analysis makes about the repository, each carrying its own ' +
        'provenance. A completed analysis makes at least one; report "blocked" rather than completing ' +
        'with none.',
    ),
  /**
   * What a run of this repository needs — the same vocabulary question 5 of the installer interview
   * collects and `mechanics.resources` records (`src/contracts/installer.ts`).
   */
  resources: z
    .enum(RESOURCE_NEEDS)
    .describe(
      `What a run of this repository needs to work: one of ${RESOURCE_NEEDS.join(', ')}. This is ` +
        'mechanics.resources’s own vocabulary; report "none" rather than guessing when nothing read ' +
        'says otherwise.',
    ),
  high_blast_radius_paths: z
    .array(z.string())
    .describe(
      'Repository-relative paths that should force a higher isolation tier for any run that touches ' +
        'them. Never absolute, never climbing out of the repository. Empty when nothing read warrants one.',
    ),
  conflict_domains: z
    .array(z.string())
    .describe(
      'Repository-relative directories that must not be worked on concurrently by two runs. Never ' +
        'absolute, never climbing out of the repository. Empty when nothing read warrants one.',
    ),
  /** Reused verbatim from story 5-1; see this module's own docblock. */
  knowledge: z
    .array(KnowledgeEntrySchema)
    .describe(
      'Project knowledge worth recording for future runs, each entry carrying its own anchor, claim, ' +
        'provenance and decay policy (AD-16). Empty when nothing read is worth recording.',
    ),
});

/**
 * `step.bootstrap`'s output.
 *
 * Refinements mirror `AnalysisOutputSchema`'s own, applied to this contract's own fields: a completed
 * analysis makes at least one claim, every claim is attributed, and every path-bearing field is refused a
 * path outside the repository. Each rule is also stated in the `.describe()` of the field it binds, for
 * the reason `AnalysisOutputSchema`'s own refinements are (AD-2's structured-outputs subset admits no
 * `minItems` above one, so a refinement holds at parse time while emitting nothing a producer could see
 * unless it is also prose).
 */
export const BootstrapAnalysisSchema = BootstrapAnalysisShape.superRefine((output, ctx) => {
  if (output.status === 'completed' && output.claims.length === 0) {
    ctx.addIssue({
      code: 'custom',
      path: ['claims'],
      message:
        'a completed bootstrap analysis makes at least one claim; an empty list asserts nothing. ' +
        'Report "blocked" instead if there is nothing to state.',
    });
  }

  output.claims.forEach((claim, index) => {
    if (claim.claim.trim() === '') {
      ctx.addIssue({
        code: 'custom',
        path: ['claims', index, 'claim'],
        message: 'a claim states something; a blank one is attributed to a step that said nothing',
      });
    }
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
          message: `"${path}" is not inside the repository this analysis was run against`,
        });
      }
    });
  });

  output.high_blast_radius_paths.forEach((path, index) => {
    if (!isRepositoryRelativePath(path)) {
      ctx.addIssue({
        code: 'custom',
        path: ['high_blast_radius_paths', index],
        message:
          `"${path}" is not a repository-relative path, so no run worktree contains it. A ` +
          'high-blast-radius path names somewhere inside this repository.',
      });
    }
  });

  output.conflict_domains.forEach((path, index) => {
    if (!isRepositoryRelativePath(path)) {
      ctx.addIssue({
        code: 'custom',
        path: ['conflict_domains', index],
        message:
          `"${path}" is not a repository-relative path, so no run worktree contains it. A ` +
          'conflict domain names somewhere inside this repository.',
      });
    }
  });
});

export type BootstrapAnalysis = z.infer<typeof BootstrapAnalysisSchema>;
