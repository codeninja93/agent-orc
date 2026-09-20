/**
 * Consistency Conventions — "reconciliation is concurrent across features but serializes any features
 * whose declared file territories overlap".
 *
 * Parallelism is bounded by conflict domain, not by a worker count. Two features touching disjoint
 * parts of a repository advance in the same pass; two that could edit the same file are serialised,
 * and only one of them holds the territory at a time. Nothing here is a lock on disk: the decision is
 * recomputed from the declared territories on every pass, so it survives a restart by being derived
 * rather than by being remembered — which is what AD-7 requires of everything the loop knows.
 *
 * Determinism is therefore load-bearing. Admission walks the candidates in run-id order, and a run id
 * is a ULID whose lexicographic order is chronological, so the *older* run wins a contested territory
 * on every pass and on every restart. A pass that admitted whichever feature the directory listing
 * happened to yield first would make the crash-injection suite's "converges on the same state" claim
 * depend on filesystem ordering.
 */
import { posix, sep } from 'node:path';

import { compareUlid } from './ulid.js';

/**
 * Normalise a declared territory entry to a comparable path.
 *
 * Territories are declared by a person or by a profile, so they arrive spelled loosely: a backslash
 * separator on one machine, a trailing slash on a directory, a leading `./`. Two spellings of one path
 * that compared unequal would report an overlap as disjoint, which is the failure direction that
 * actually corrupts a worktree.
 */
export const normaliseTerritoryPath = (declared: string): string => {
  const slashed = declared.split(sep).join('/').split('\\').join('/');
  const normalised = posix.normalize(slashed.trim());
  const withoutLeadingDot = normalised.startsWith('./') ? normalised.slice(2) : normalised;
  const trimmed = withoutLeadingDot.replace(/\/+$/, '');
  return trimmed === '' || trimmed === '.' ? '.' : trimmed;
};

/** A declared territory: normalised, de-duplicated, and in a stable order. */
export const normaliseTerritory = (declared: readonly string[]): readonly string[] =>
  [...new Set(declared.map(normaliseTerritoryPath))].sort();

/**
 * True when one path contains or equals the other.
 *
 * Compared segment by segment, not by string prefix: `src/engine` must not be read as containing
 * `src/engine-notes.ts`, which a `startsWith` would claim. A territory of `.` is the whole repository
 * and therefore contains everything.
 */
export const pathsCollide = (a: string, b: string): boolean => {
  if (a === b) return true;
  if (a === '.' || b === '.') return true;
  const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
  return longer.startsWith(`${shorter}/`);
};

/** True when two declared territories share any file, so the two features must be serialised. */
export const territoriesOverlap = (a: readonly string[], b: readonly string[]): boolean => {
  const left = normaliseTerritory(a);
  const right = normaliseTerritory(b);
  return left.some((path) => right.some((other) => pathsCollide(path, other)));
};

/** Every colliding pair between two territories, for a message that names the actual conflict. */
export const overlappingPaths = (
  a: readonly string[],
  b: readonly string[],
): readonly string[] => {
  const right = normaliseTerritory(b);
  return normaliseTerritory(a).filter((path) => right.some((other) => pathsCollide(path, other)));
};

/** A feature contending for a territory in one pass. */
export interface TerritoryCandidate {
  /** The run id. A ULID, so its order is chronological and its comparison deterministic. */
  readonly run: string;
  readonly feature: string;
  readonly territory: readonly string[];
}

/** Why a candidate was not admitted to a pass. */
export interface TerritoryDeferral {
  readonly run: string;
  readonly feature: string;
  /** The run that holds the territory this pass. */
  readonly blockedBy: string;
  /** The paths the two features both declare. */
  readonly overlap: readonly string[];
  readonly reason: string;
}

/** Which features may act this pass, and which are serialised behind one that may. */
export interface TerritoryAdmission {
  readonly admitted: readonly TerritoryCandidate[];
  readonly deferred: readonly TerritoryDeferral[];
}

/**
 * Decide which features advance in one pass.
 *
 * Greedy in run-id order: the oldest run takes its territory, and any later run whose territory
 * collides with one already taken waits. Greedy is correct here rather than merely convenient —
 * serialisation only has to be *a* total order on each conflict domain, and taking them oldest-first
 * also means a contested feature cannot be starved indefinitely by newer arrivals.
 */
export const admitByTerritory = (
  candidates: readonly TerritoryCandidate[],
): TerritoryAdmission => {
  const ordered = [...candidates].sort((a, b) => compareUlid(a.run, b.run));
  const admitted: TerritoryCandidate[] = [];
  const deferred: TerritoryDeferral[] = [];

  for (const candidate of ordered) {
    const holder = admitted.find((held) => territoriesOverlap(held.territory, candidate.territory));
    if (holder === undefined) {
      admitted.push(candidate);
      continue;
    }
    const overlap = overlappingPaths(candidate.territory, holder.territory);
    deferred.push({
      run: candidate.run,
      feature: candidate.feature,
      blockedBy: holder.run,
      overlap,
      reason:
        `Feature "${candidate.feature}" declares ${overlap.join(', ')}, which run ${holder.run} ` +
        `("${holder.feature}") holds this pass. Overlapping territories are serialised, so only one ` +
        'holds the territory at a time.',
    });
  }

  return { admitted, deferred };
};

/**
 * A ledger of who holds what, for a caller that wants to ask rather than be told.
 *
 * Deliberately in-memory and pass-scoped: a durable territory ledger would be a second authority for a
 * fact the declared territories already determine, and AD-4 forbids exactly that. It exists so a
 * renderer or a test can interrogate one pass's decision.
 */
export class TerritoryLedger {
  private readonly held = new Map<string, readonly string[]>();

  /** Claim a territory for a run, or refuse naming the run that holds it. */
  claim(run: string, territory: readonly string[]): boolean {
    for (const [holder, paths] of this.held) {
      if (holder !== run && territoriesOverlap(paths, territory)) return false;
    }
    this.held.set(run, normaliseTerritory(territory));
    return true;
  }

  release(run: string): void {
    this.held.delete(run);
  }

  /** The run holding a path, or `null`. */
  holderOf(path: string): string | null {
    const wanted = normaliseTerritoryPath(path);
    for (const [run, paths] of this.held) {
      if (paths.some((held) => pathsCollide(held, wanted))) return run;
    }
    return null;
  }

  get runs(): readonly string[] {
    return [...this.held.keys()].sort(compareUlid);
  }
}
