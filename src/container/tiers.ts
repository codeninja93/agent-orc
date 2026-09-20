/**
 * CAP-10's three isolation tiers, and the classification that picks one.
 *
 * | Tier | Used for | Mechanism |
 * | 0 | typo, comment, formatting | direct edit, no branch |
 * | 1 | small, low-blast-radius change | branch, no container |
 * | 2 | real features | worktree, least-privilege container, leased resources |
 *
 * The architecture is explicit that all three exist from the first stage and that "spinning a container
 * for a README fix is rejected as pure tax". That sentence is the reason this file is a *refusal* and
 * not just a lookup: the easy implementation containerises everything, passes every containment test,
 * and makes the system too slow to use for the changes it will be asked for most often. So a tier-2
 * request for a tier-0 shape is an error naming the shape, exactly as a tier-0 request for a real
 * feature is.
 *
 * Asymmetry is deliberate in the other direction too. A caller may *harden* a tier-1 change into tier 2
 * — a small change in a risky place is a judgement a planner is allowed to make — but may never soften
 * a classification downward. Softening is the move that quietly removes containment, and it is refused
 * by name.
 *
 * Nothing here creates a worktree or a branch: story 1-6 owns worktrees, the committer owns branches.
 * This file answers one question — which tier — and `wrapper.ts` acts on the answer.
 */
import { basename, extname } from 'node:path';

import { makeError } from '../contracts/index.js';
import type { OrchError } from '../contracts/index.js';

/** The three tiers. */
export const ISOLATION_TIERS = [0, 1, 2] as const;

export type IsolationTier = (typeof ISOLATION_TIERS)[number];

/** What each tier actually does, so a caller reads the mechanism rather than inferring it. */
export const TIER_MECHANISMS: Readonly<
  Record<IsolationTier, { readonly branch: boolean; readonly worktree: boolean; readonly container: boolean; readonly summary: string }>
> = {
  0: { branch: false, worktree: false, container: false, summary: 'edit in place, no branch' },
  1: { branch: true, worktree: false, container: false, summary: 'branch, no container' },
  2: { branch: true, worktree: true, container: true, summary: 'worktree plus least-privilege container' },
};

/** The shapes a planner can name directly. Anything else is judged from the paths and the size. */
export const CHANGE_KINDS = [
  'typo',
  'comment',
  'formatting',
  'docs',
  'small-fix',
  'refactor',
  'feature',
  'dependency',
  'infrastructure',
] as const;

export type ChangeKind = (typeof CHANGE_KINDS)[number];

/** Kinds that are tier 0 whatever else is true of them: they cannot change behaviour. */
export const TIER_0_KINDS: readonly ChangeKind[] = ['typo', 'comment', 'formatting'];

/** Kinds that are tier 2 whatever else is true of them: blast radius, not size, decides. */
export const TIER_2_KINDS: readonly ChangeKind[] = ['feature', 'dependency', 'infrastructure'];

/** File extensions that carry prose rather than behaviour. */
export const DOCUMENTATION_EXTENSIONS: readonly string[] = ['.md', '.mdx', '.txt', '.rst', '.adoc'];

/** Basenames that are prose whatever their extension. */
export const DOCUMENTATION_BASENAMES: readonly string[] = ['README', 'LICENSE', 'CHANGELOG', 'AUTHORS', 'NOTICE'];

/**
 * Paths whose blast radius is the whole repository or the machine.
 *
 * A one-line change to a lockfile, a workflow or a Dockerfile reaches further than a hundred lines
 * inside one module, so these force tier 2 regardless of size. This is the "blast radius, never a
 * global trust level" rule from the reversibility table, applied to paths.
 */
export const HIGH_BLAST_RADIUS_PATTERNS: readonly RegExp[] = [
  /(^|\/)package(-lock)?\.json$/,
  /(^|\/)(pnpm|yarn)\.lock$/,
  /(^|\/)requirements[^/]*\.txt$/,
  /(^|\/)(Cargo|Gemfile|go)\.(toml|lock|mod|sum)$/,
  /(^|\/)\.github\//,
  /(^|\/)\.gitlab-ci\.yml$/,
  /(^|\/)docker\//,
  /(^|\/)Dockerfile[^/]*$/,
  /(^|\/)(terraform|infra|deploy|charts|k8s)\//,
  /(^|\/)migrations?\//,
  /(^|\/)\.env/,
  /(^|\/)\.orch\//,
];

/** Above this many touched files, a change is no longer "small, low blast radius". */
export const TIER_1_MAX_FILES = 5;

/** Above this many changed lines, likewise. */
export const TIER_1_MAX_LINES = 60;

/** Up to this many changed lines, a documentation-only change is a tier-0 edit in place. */
export const TIER_0_MAX_LINES = 20;

/** What is known about a change before it runs. Everything is optional except the paths it touches. */
export interface ChangeShape {
  /** Repository-relative paths the change is expected to touch. */
  readonly paths: readonly string[];
  /** Total changed lines, when an estimate exists. */
  readonly changedLines?: number;
  /** The planner's own label, when it has one. */
  readonly kind?: ChangeKind;
  /** A tier the caller asks for. Never allowed to soften the classification. */
  readonly requestedTier?: IsolationTier;
}

/** The classification, with the evidence it rests on. */
export interface TierDecision {
  readonly tier: IsolationTier;
  /** One sentence naming why, for the event log and for a refusal message. */
  readonly reason: string;
  /** The paths that drove the decision upward, when any did. */
  readonly evidence: readonly string[];
}

/** A caller asked for less isolation than the change's shape allows. */
export class TierSoftenedError extends Error {
  readonly code = 'container.isolation_assertion_failed';
  readonly requested: IsolationTier;
  readonly classified: IsolationTier;
  readonly orchError: OrchError;

  constructor(requested: IsolationTier, decision: TierDecision) {
    const message =
      `Refusing tier ${String(requested)} for a change classified tier ${String(decision.tier)}: ` +
      `${decision.reason}. A tier may be raised but never lowered — lowering it is how containment ` +
      'is removed without anything about the run looking different.';
    super(message);
    this.name = 'TierSoftenedError';
    this.requested = requested;
    this.classified = decision.tier;
    this.orchError = makeError(this.code, message, decision.reason);
  }
}

/** A caller asked for a container for a change that does not need one. */
export class ContainerTaxError extends Error {
  readonly code = 'config.invalid';
  readonly orchError: OrchError;

  constructor(decision: TierDecision) {
    const message =
      `Refusing to spin a tier-2 container for a tier-0 change: ${decision.reason}. ` +
      'The architecture rejects a container for a README fix as pure tax; a tier-0 change is ' +
      'edited in place.';
    super(message);
    this.name = 'ContainerTaxError';
    this.orchError = makeError(this.code, message, decision.reason);
  }
}

/** True when a path carries prose rather than behaviour. */
export const isDocumentationPath = (path: string): boolean => {
  const name = basename(path);
  const extension = extname(name).toLowerCase();
  if (DOCUMENTATION_EXTENSIONS.includes(extension)) return true;
  const stem = extension === '' ? name : name.slice(0, -extension.length);
  return DOCUMENTATION_BASENAMES.includes(stem.toUpperCase());
};

/** The paths that force tier 2 by themselves. */
export const highBlastRadiusPaths = (paths: readonly string[]): readonly string[] =>
  paths.filter((path) => HIGH_BLAST_RADIUS_PATTERNS.some((pattern) => pattern.test(path)));

/**
 * Classify a change into a tier.
 *
 * Read the order: the things that force tier 2 are checked first, so no combination of "small" and
 * "documentation" can talk a lockfile change out of a container. Only then is tier 0 considered, and
 * only for a change that is prose-or-cosmetic *and* small. Everything left is tier 1 — which is the
 * honest default, since a change that is neither trivially safe nor identifiably risky is exactly what
 * a branch without a container is for.
 */
export const classifyTier = (shape: ChangeShape): TierDecision => {
  const risky = highBlastRadiusPaths(shape.paths);
  const lines = shape.changedLines ?? 0;

  if (shape.kind !== undefined && TIER_2_KINDS.includes(shape.kind)) {
    return { tier: 2, reason: `the change is a ${shape.kind}`, evidence: risky };
  }
  if (risky.length > 0) {
    return {
      tier: 2,
      reason: `it touches ${risky.length === 1 ? 'a path' : 'paths'} whose blast radius is the whole repository (${risky.join(', ')})`,
      evidence: risky,
    };
  }
  if (shape.paths.length > TIER_1_MAX_FILES) {
    return {
      tier: 2,
      reason: `it touches ${String(shape.paths.length)} files, above the tier-1 ceiling of ${String(TIER_1_MAX_FILES)}`,
      evidence: [],
    };
  }
  if (lines > TIER_1_MAX_LINES) {
    return {
      tier: 2,
      reason: `it changes ${String(lines)} lines, above the tier-1 ceiling of ${String(TIER_1_MAX_LINES)}`,
      evidence: [],
    };
  }

  const cosmetic = shape.kind !== undefined && TIER_0_KINDS.includes(shape.kind);
  const proseOnly = shape.paths.length > 0 && shape.paths.every(isDocumentationPath);
  if ((cosmetic || proseOnly) && lines <= TIER_0_MAX_LINES) {
    return {
      tier: 0,
      reason: cosmetic
        ? `it is a ${shape.kind ?? 'cosmetic'} change of ${String(lines)} lines`
        : `it touches documentation only (${shape.paths.join(', ')})`,
      evidence: [],
    };
  }

  return {
    tier: 1,
    reason: `it is a small change to ${String(shape.paths.length)} file${shape.paths.length === 1 ? '' : 's'} with no high-blast-radius path`,
    evidence: [],
  };
};

/**
 * The tier a request will actually run at: the classification, raised by the caller if they asked for
 * more isolation, and refused if they asked for less — or for a container a tier-0 change does not need.
 */
export const selectTier = (shape: ChangeShape): TierDecision => {
  const decision = classifyTier(shape);
  const requested = shape.requestedTier;
  if (requested === undefined) return decision;
  if (requested < decision.tier) throw new TierSoftenedError(requested, decision);
  if (requested === 2 && decision.tier === 0) throw new ContainerTaxError(decision);
  if (requested > decision.tier) {
    return {
      tier: requested,
      reason: `the caller raised tier ${String(decision.tier)} to ${String(requested)} (${decision.reason})`,
      evidence: decision.evidence,
    };
  }
  return decision;
};

/** Whether a tier runs inside a container. The one question `wrapper.ts` asks. */
export const tierUsesContainer = (tier: IsolationTier): boolean => TIER_MECHANISMS[tier].container;
