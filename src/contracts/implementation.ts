/**
 * `step.implementation` — what the implementing agent returns: the change it wrote, described and
 * attributed.
 *
 * **Why a contract of its own rather than `step.output`.** The roster entry for `implementation`
 * named the generic envelope, whose `provenance` is a flat `z.array(z.string())` beside the claims it
 * is supposed to attribute — the defect story 2-4's review named, and the reason `step.analysis` and
 * `step.planning` exist. AD-17 has a declaration reference a contract by *id*, so two agents sharing
 * one id cannot be told apart by anything the engine reads, and nothing in `step.output` expresses
 * what an implementing step actually produces: which files changed, how, and on what grounds.
 *
 * **This contract is the last channel out of the run worktree, and it closes it.** ADR-001 bounds the
 * agent's file tools with `--restricted` plus `--add-dir` scoped to the run worktree, and ADR-004 has
 * just removed `Bash`, so the agent cannot write outside and cannot run a command that would. What
 * remains is what it can *return*: a path in a typed field that some later unit acts on. So every
 * field here that carries a path is refused unless the path stays inside the plane it belongs to —
 * the worktree for a change, the run's evidence plane for a pointer (AD-23) — and the write surface
 * stays the enumerated one AD-15 declares, none of whose members writes a file. There is deliberately
 * no field for "a path to write elsewhere": anything outside the worktree is a write intent the
 * engine executes, and an intent is declared here, never performed.
 * `tests/contracts.implementation.test.ts` enumerates every string field of the export and requires
 * each to be a closed vocabulary, a refused path field, or a named non-path, so a field added later
 * cannot quietly open a new channel.
 *
 * **The per-claim provenance idiom is `step.analysis`'s, reused rather than re-invented.** A change is
 * a claim about a file, so it carries its own {@link ClaimProvenanceSchema} and the refinement is per
 * change, never over a parallel array.
 *
 * **Bounds are refinements plus prose.** AD-2's structured-outputs subset admits no `minItems` above
 * one and no `minLength`, and a refinement emits nothing into the draft-7 export — so every rule a
 * refinement enforces is also stated in the `.describe()` of the field it binds. A rule the producer
 * cannot see makes `step.schema_invalid_output` the normal outcome, and that code is
 * `escalate-model-tier`: an invisible rule spends the run's one promotion on a step that did its job.
 *
 * It carries no `schema_version`, for the reason `step.analysis` gives: this is the model-facing
 * contract, not an on-disk artifact.
 */
import { z } from 'zod';

import { ClaimProvenanceSchema, attributesClaim } from './analysis.js';
import { StepOutputSchema } from './step.js';
import { isRepositoryRelativePath, normaliseTerritoryPath, territoryContains } from './territory.js';

/** The registry id this contract is registered under (AD-17), spelled once. */
export const IMPLEMENTATION_CONTRACT_ID = 'step.implementation';

/**
 * What happened to one file.
 *
 * A closed vocabulary rather than free text, because the reviewer reading a run's record and the
 * committer composing the pull-request body both branch on it, and "changed"/"updated"/"edited"
 * spelled three ways is three answers to one question.
 */
export const CHANGE_KINDS = ['created', 'modified', 'deleted'] as const;

export type ChangeKind = (typeof CHANGE_KINDS)[number];

/**
 * One file the step changed, and the grounds for changing it.
 *
 * `path` is the only field in this contract through which the agent names something it *did* to the
 * repository, which is why it carries both refusals: repository-relative (so it is inside the run
 * worktree `--add-dir` scoped the file tools to) and inside the territory this same output declares
 * (so it is inside the conflict domain the reconciler admitted this feature for).
 */
export const ImplementedChangeSchema = z.object({
  path: z
    .string()
    .describe(
      'The repository-relative path of the file that changed, inside the declared territory. Never ' +
        'blank, never absolute, never a home-directory path, never climbing out of the worktree, and ' +
        'each path appears at most once.',
    ),
  kind: z
    .enum(CHANGE_KINDS)
    .describe('What happened to the file: it was created, modified, or deleted.'),
  summary: z
    .string()
    .describe('What changed in this file and why, in one line that stands alone. Never blank.'),
  provenance: ClaimProvenanceSchema.describe(
    'The step that made this change and the source it was read from.',
  ),
});

export type ImplementedChange = z.infer<typeof ImplementedChangeSchema>;

const ImplementationOutputShape = StepOutputSchema.extend({
  /**
   * Pinned to the registered id, so an output claiming `step.output` is refused by every reader of
   * the artifact and not only by the spawner's own comparison (the defect the pinned grant table
   * caught in story 2-4's declarations).
   */
  contract_id: z.literal(IMPLEMENTATION_CONTRACT_ID),
  changes: z
    .array(ImplementedChangeSchema)
    .describe(
      'Every file this step changed, each carrying its own provenance. A completed implementation ' +
        'changed at least one; report "blocked" rather than completing with none.',
    ),
  territory: z
    .array(z.string())
    .describe(
      'Repository-relative paths this step was admitted to and wrote within, covering every changed ' +
        'file. A completed implementation declares at least one; "." means the whole repository. ' +
        'Never blank, never absolute, never climbing out of the worktree.',
    ),
});

/**
 * `step.implementation`'s output.
 *
 * Each refinement is applied per element and names the element it refused, so a refusal says which
 * change was unattributed or outside the territory rather than that "changes was invalid".
 */
export const ImplementationOutputSchema = ImplementationOutputShape.superRefine((output, ctx) => {
  /**
   * The territory is validated before containment is asked of it, for the reason `step.analysis`
   * gives: a malformed entry makes `territoryContains` answer about a territory that is not the
   * declared one, and every change is then blamed for the territory's fault.
   */
  let territoryWellFormed = output.territory.length > 0;
  output.territory.forEach((path, index) => {
    if (!isRepositoryRelativePath(path)) {
      territoryWellFormed = false;
      ctx.addIssue({
        code: 'custom',
        path: ['territory', index],
        message:
          `"${path}" is not a repository-relative path, so no run worktree contains it. A blank entry, ` +
          'an absolute path or a "src/.." would normalise to the whole repository and make every ' +
          'change-inside-its-territory check vacuous.',
      });
    }
  });

  /**
   * A completed implementation changed something and declares where; a blocked or failed one need
   * not.
   *
   * An empty `changes` is a step that completed having written nothing, and it also makes every
   * per-change refinement below pass vacuously. Binding the requirement to a `blocked` or `failed`
   * report would refuse the honest refusal — and because `step.schema_invalid_output` is
   * `escalate-model-tier`, refusing it would promote the ladder against a step that correctly said it
   * could not proceed.
   */
  if (output.status === 'completed') {
    if (output.territory.length === 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['territory'],
        message:
          'a completed implementation declares at least one path; an empty territory overlaps nothing ' +
          'and would be admitted beside every other feature. Report "blocked" instead if nothing could ' +
          'be written.',
      });
    }
    if (output.changes.length === 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['changes'],
        message:
          'a completed implementation changed at least one file; an empty list is a completion with ' +
          'nothing written, and it makes every per-change rule pass vacuously. Report "blocked" ' +
          'instead if the change could not be made.',
      });
    }
  }

  /**
   * A path is compared normalised, because `src/a.ts` and `./src/a.ts` are one file wearing two
   * spellings — and two records for one file is two answers to "what happened to it", which is the
   * contradiction a reviewer reads as a created-and-deleted file.
   */
  const seen = new Set<string>();
  output.changes.forEach((change, index) => {
    if (change.summary.trim() === '') {
      ctx.addIssue({
        code: 'custom',
        path: ['changes', index, 'summary'],
        message: 'a change says what it changed and why; a blank summary describes nothing',
      });
    }
    if (!attributesClaim(change.provenance)) {
      ctx.addIssue({
        code: 'custom',
        path: ['changes', index, 'provenance'],
        message:
          'every change carries the step that made it and the source it was read from ' +
          '(architecture.md, Coordination); a change with either half blank is unattributed',
      });
    }
    if (!isRepositoryRelativePath(change.path)) {
      ctx.addIssue({
        code: 'custom',
        path: ['changes', index, 'path'],
        message:
          `"${change.path}" is not inside the run worktree, so this step cannot have written it: ` +
          'ADR-001 bounds this agent by --restricted plus --add-dir scoped to that worktree, and a ' +
          'change anywhere else is a write intent the engine executes (AD-15), never a file this ' +
          'step wrote',
      });
      return;
    }
    // Only asked when the territory itself parsed: see the note at the top of this refinement.
    if (territoryWellFormed && !territoryContains(output.territory, change.path)) {
      ctx.addIssue({
        code: 'custom',
        path: ['changes', index, 'path'],
        message:
          `"${change.path}" is outside the territory this output declares (${output.territory.join(', ')}); ` +
          'the declared territory is what the reconciler serialises two features on, so a change ' +
          'outside it is a write into another feature’s conflict domain',
      });
    }
    const normalised = normaliseTerritoryPath(change.path);
    if (seen.has(normalised)) {
      ctx.addIssue({
        code: 'custom',
        path: ['changes', index, 'path'],
        message:
          `"${change.path}" is reported twice; one file has one outcome in one step, and two records ` +
          'for it are two answers to what happened to it',
      });
    }
    seen.add(normalised);
  });

  /**
   * An evidence pointer names a path **in the evidence plane** (AD-23), and that plane is rooted in
   * the run directory.
   *
   * The control plane carries the pointer and a later reader resolves it against that root, so an
   * absolute path, a home-directory spelling or a `..` reaches a file the run does not own — the same
   * escape as a change outside the worktree, one plane over. The spelling rule is identical, so it is
   * the same predicate rather than a second implementation of path containment; what differs is the
   * root it is resolved against, which is the reader's and not this contract's.
   */
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
    }
  });
});

export type ImplementationOutput = z.infer<typeof ImplementationOutputSchema>;
