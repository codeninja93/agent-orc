/**
 * Story 5-5 — CAP-20's bootstrap agent: dispatched through the *existing* reconciler/spawner pipeline as
 * an ordinary `analysis`-phase step, so "no engine modification" holds literally. Nothing here changes
 * `STEP_PHASES`, `reconciler.ts` or `spawner.ts`; this module only supplies a plan those unmodified units
 * already know how to drive, a declaration shaped the way every built-in already is, and a pure function
 * that merges a completed analysis onto an already-loaded `Profile`.
 *
 * **`BOOTSTRAP_AGENT_DECLARATION` is `AgentDeclarationInput`-shaped, not `AgentDeclarationInput`
 * itself.** `src/installer/interview.ts` declares that type and `BUILT_IN_AGENTS`, and
 * `src/engine/` may import only `src/contracts/`, `src/runtime/` and `node:` builtins — never
 * `src/installer/` (asserted structurally in `tests/engine.reconciler.test.ts`'s "the dependency
 * direction is fixed" suite). So this module declares its own local interface with the identical field
 * list, rather than importing the installer's type, and is a **standalone export, never added to
 * `BUILT_IN_AGENTS`** (this story's own Boundary): it is not one of the ordinary feature-building roster
 * a person toggles at question 10, and offering it there would offer it for ordinary features, which it
 * is not.
 *
 * **`mergeBootstrapAnalysis` writes nothing.** It takes an already-completed `BootstrapAnalysis` and an
 * already-loaded `Profile` and returns a new `Profile` value. There is no file handle anywhere in this
 * module, which is what makes "reviewed by the user before first use" (AD-16) true by construction rather
 * than by discipline: wiring an actual CLI command that runs a bootstrap and offers to write the result
 * is future work, matching the unwired-but-complete precedent every story since 5-1 has followed.
 */
import type {
  AgentModel,
  BootstrapAnalysis,
  ModelRung,
  Profile,
  ReversibilityClass,
  RunMode,
} from '../contracts/index.js';
import { BOOTSTRAP_CONTRACT_ID } from '../contracts/index.js';

import type { FeaturePlan } from './rebuild.js';

/**
 * The shape `AgentDeclarationInput` (`src/installer/interview.ts`) has, restated here because this
 * module may not import that file. A change to one without the other is exactly the drift
 * `tests/engine.bootstrap.test.ts` checks for by structural comparison against a fixture built from the
 * installer's own type.
 */
export interface BootstrapAgentDeclaration {
  readonly id: string;
  readonly purpose: string;
  readonly contract: string;
  readonly tools: readonly string[];
  readonly mcp_domains: readonly string[];
  readonly reversibility: ReversibilityClass;
  readonly model: AgentModel;
}

/**
 * The bootstrap agent's declaration.
 *
 * **Read-only, matching `analysis`'s own grant (ADR-003) and for the same reason: it states judgement
 * over the repository, it does not write.** No `Write`/`Edit`, no MCP domain — a bootstrap run reads and
 * reports; `mergeBootstrapAnalysis` below is what turns its report into a `Profile` value, and nothing in
 * this codebase writes that value to `.orch/profile.toml` (this story's own Boundary).
 *
 * **Its starting tier is `claude-sonnet-5`, not `analysis`'s own `claude-haiku-4-5` floor.** `analysis`
 * states what a *specific, already-scoped* request touches; this agent has to judge, unprompted, whether
 * a repository needs postgres, which of its paths are genuinely high blast radius, and what is worth
 * remembering — closer to the judgement `planning` and `testing` are trusted with than to restating a
 * request. AD-17 still makes this a *starting* rung, never a fixed assignment: the promotion ladder can
 * still climb from here on a schema-invalid output.
 *
 * **A real dispatch cannot resolve this grant by the ordinary phase-based path, and that is deliberate.**
 * `src/engine/agents.ts`'s `resolveAgentGrant`/`grantFromRoster` and `src/engine/roster.ts`'s
 * `rosterAgent` all match a phase against `entry.id === phase` in a roster read off a *target
 * repository's* `.orch/agents/` directory. `bootstrapPlan` below deliberately reuses `phase: 'analysis'`
 * (see its own docblock), so that lookup would resolve the target repository's ordinary `analysis` agent
 * — contract `step.analysis` — never this declaration, whose contract is `step.bootstrap`. Worse, for a
 * genuinely unseen repository there may be no roster at all yet, so there is nothing to resolve against.
 * Dispatching this plan for real therefore requires constructing `createStepSpawner`
 * (`src/engine/spawner.ts`) with a custom `StepSpawnerOptions.grantFor` that returns this declaration's
 * own grant directly — bypassing roster resolution entirely — rather than relying on the default, which
 * reads the target repository's roster and will not find this agent there. `grantFor` is already
 * pluggable for exactly this kind of caller; no change to `STEP_PHASES`, `reconciler.ts` or `spawner.ts`
 * is needed to wire it up.
 */
const bootstrapAgentDeclaration: BootstrapAgentDeclaration = {
  id: 'bootstrap',
  purpose:
    'Read an unseen repository and state the profile judgement fields detection cannot answer: what a ' +
    'run needs (mechanics.resources), which paths carry high blast radius or must not be worked on ' +
    'concurrently (risk.high_blast_radius_paths, risk.conflict_domains), and what is worth recording as ' +
    'project knowledge for future runs (knowledge).',
  contract: BOOTSTRAP_CONTRACT_ID,
  tools: ['Read', 'Grep', 'Glob'],
  mcp_domains: [],
  reversibility: 'reversible',
  model: { start_tier: 'claude-sonnet-5', promotion_policy: 'on-gate-failure' },
};

export const BOOTSTRAP_AGENT_DECLARATION: BootstrapAgentDeclaration =
  Object.freeze(bootstrapAgentDeclaration);

/** The feature slug and step name a bootstrap run's plan uses, named once so both are stable. */
export const BOOTSTRAP_FEATURE_SLUG = 'bootstrap';
export const BOOTSTRAP_STEP_NAME = 'bootstrap-analysis';

export interface BootstrapPlanOptions {
  /** Overrides {@link BOOTSTRAP_FEATURE_SLUG}. Only useful to a caller running more than one at once. */
  readonly feature?: string;
  /** AD-27 — defaults to `shadow`: a bootstrap analysis reads and reports, it performs no write intent. */
  readonly mode?: RunMode;
  /** Overrides {@link BOOTSTRAP_AGENT_DECLARATION}'s own starting rung. */
  readonly startingModelTier?: ModelRung;
}

/**
 * A single-step, `analysis`-phase `FeaturePlan` whose worktree is `worktreePath`.
 *
 * **`worktreePath` MUST be a disposable, engine-created scratch worktree — never a caller's own live
 * repository checkout.** It is assigned verbatim to the returned plan's `worktree` field, and
 * `src/engine/reconciler.ts`'s existing, unmodified `reset-and-rerun` action runs `git reset --hard` /
 * `git clean -fd` against `plan.worktree` on an ordinary step retry — a schema-invalid output or a gate
 * failure, not a rare edge case. Every other feature's plan gets its worktree from `createWorktree`
 * (`src/pool/worktree.ts`) through the assembly layer before the plan is ever built; this function takes
 * the path as a bare parameter and has no way to enforce that the caller did the same. Passing a
 * person's own real, uncommitted checkout here means an ordinary retry can destructively wipe their
 * uncommitted changes and untracked files. Build `worktreePath` the same way every other feature's
 * worktree is built, via `createWorktree`, before calling this function.
 *
 * **The whole point of this function, otherwise.** `STEP_PHASES` is unchanged, `Reconciler` and
 * `createStepSpawner` are unchanged, and this is an ordinary `FeaturePlan` built the same way any other
 * feature's is — `tests/engine.bootstrap.test.ts`'s reconciler-integration test drives one through a real
 * `Reconciler` with a scripted executor to prove that the reconciler accepts and drives this plan shape;
 * see that test's own doc comment for what it does and does not prove about grant resolution.
 *
 * `territory` is `['.']`, the whole-repository spelling `src/contracts/territory.ts` already gives
 * meaning to: a bootstrap analysis is not scoped to one feature's declared slice of the repository, it is
 * read over all of it.
 */
export const bootstrapPlan = (
  worktreePath: string,
  options: BootstrapPlanOptions = {},
): FeaturePlan => ({
  feature: options.feature ?? BOOTSTRAP_FEATURE_SLUG,
  mode: options.mode ?? 'shadow',
  territory: ['.'],
  steps: [{ step: BOOTSTRAP_STEP_NAME, contract_id: BOOTSTRAP_CONTRACT_ID, phase: 'analysis' }],
  request:
    'Read this repository and state what its .orch/profile.toml should declare for the fields ' +
    'detection cannot answer: what a run needs (mechanics.resources), which paths carry high blast ' +
    'radius or must not be worked on concurrently (risk.high_blast_radius_paths, ' +
    'risk.conflict_domains), and what is worth recording as project knowledge for future runs ' +
    '(knowledge).',
  acceptance_criteria: [
    'mechanics.resources reflects what this repository actually needs to run, not a guess',
    'every high-blast-radius path and conflict domain names a real path inside this repository',
    'every knowledge entry carries a real anchor, a claim, and provenance naming what was read',
  ],
  starting_model_tier: options.startingModelTier ?? BOOTSTRAP_AGENT_DECLARATION.model.start_tier,
  worktree: worktreePath,
});

/**
 * Merge a completed `BootstrapAnalysis` onto an already-loaded `Profile`, purely.
 *
 * **Refuses any `analysis.status` other than `"completed"`.** A `"blocked"` or `"failed"` analysis has
 * not stated a complete judgement — its `resources`/`high_blast_radius_paths`/`conflict_domains` fields
 * may be incomplete or left at their defaults — and `mechanics.resources`/`risk.*` below are a wholesale
 * *replacement*, not a diff. Merging a non-completed analysis would silently overwrite a profile's
 * existing, good values with those incomplete or default ones, so this function throws rather than doing
 * that; a caller decides what to do with a blocked or failed analysis, but it is never merged.
 *
 * `mechanics.resources` and `risk.*` are **replaced** by the analysis's own judgement — a bootstrap run
 * is read as a fresh, complete answer to those three fields, not a diff against whatever was there
 * before. `knowledge.entries` is **appended to, never replaced**: a profile may already carry knowledge
 * story 5-1's consolidation pass wrote, and discarding that would lose provenance nothing here re-derives.
 *
 * **This function does not enforce, or detect, "a bootstrap run happens once."** Nothing here checks
 * whether `analysis` was already merged, or whether one of its `knowledge` entries restates a fact this
 * profile's `knowledge.entries` already carries at the same anchor — no other part of this codebase's
 * knowledge-entry handling deduplicates by anchor either, and inventing that invariant here would be new
 * and unprecedented. A second merge of a bootstrap analysis, or a bootstrap analysis re-discovering an
 * already-recorded fact, therefore accumulates entries rather than being caught or collapsed.
 *
 * Writes nothing. The returned `Profile` is a value; nothing in this codebase's path from here writes it
 * to `.orch/profile.toml` (this story's own Boundary — that is future work, matching every unwired
 * story's own precedent since 5-1).
 */
export const mergeBootstrapAnalysis = (profile: Profile, analysis: BootstrapAnalysis): Profile => {
  if (analysis.status !== 'completed') {
    throw new Error(
      `mergeBootstrapAnalysis refuses to merge a bootstrap analysis with status "${analysis.status}": ` +
        'only a "completed" analysis has stated a complete judgement over mechanics.resources and ' +
        'risk.*, and those fields are replaced wholesale, not diffed — merging an incomplete analysis ' +
        'would silently overwrite the profile’s existing, good values with incomplete or default ones.',
    );
  }
  return {
    ...profile,
    mechanics: { ...profile.mechanics, resources: analysis.resources },
    risk: {
      high_blast_radius_paths: [...analysis.high_blast_radius_paths],
      conflict_domains: [...analysis.conflict_domains],
    },
    knowledge: { entries: [...(profile.knowledge?.entries ?? []), ...analysis.knowledge] },
  };
};
