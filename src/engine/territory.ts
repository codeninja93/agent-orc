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
 *
 * Oldest-first admission bounds starvation *among contending features* — a newer arrival can never
 * overtake an older one — but it says nothing about a holder that never finishes. That is the caller's
 * half of the contract: only a feature with real work to do may be offered as a candidate. A run parked
 * awaiting confirmation or awaiting a person performs no worktree I/O, so it must not be presented here,
 * or it would hold its territory for as long as it waits and every overlapping feature would be deferred
 * behind it indefinitely. `Reconciler.pass` filters those out before calling in.
 */
import { posix, sep } from 'node:path';

import {
  DECLARATION_PAYLOAD_KEYS,
  FEATURE_TERRITORY_DECLARED_EVENT_TYPE,
  FeatureTerritoryDeclaredPayloadSchema,
} from '../contracts/index.js';
import type { EventEnvelope } from '../contracts/index.js';
import { REDACTION_MARKER } from '../runtime/index.js';

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
  /**
   * The worktree the feature's steps run in, when it has one.
   *
   * Two features sharing one worktree collide however disjoint their declared *file* territories are: a
   * re-run resets that worktree with `reset --hard` plus `clean -fd`, which discards the other feature's
   * work wholesale. The declared territory describes which files a feature intends to change; the
   * worktree describes what it can destroy, and only the second bounds the conflict domain of a reset.
   */
  readonly worktree?: string;
}

/** Why a candidate was not admitted to a pass. */
export interface TerritoryDeferral {
  readonly run: string;
  readonly feature: string;
  /** The run that holds the territory this pass. */
  readonly blockedBy: string;
  /** The paths the two features both declare, or the shared worktree, whichever collided. */
  readonly overlap: readonly string[];
  readonly reason: string;
}

/** Two candidates share a worktree when both name one and the two are the same directory. */
export const sharesWorktree = (a: TerritoryCandidate, b: TerritoryCandidate): boolean =>
  a.worktree !== undefined &&
  b.worktree !== undefined &&
  normaliseTerritoryPath(a.worktree) === normaliseTerritoryPath(b.worktree);

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
    const holder = admitted.find(
      (held) =>
        sharesWorktree(held, candidate) || territoriesOverlap(held.territory, candidate.territory),
    );
    if (holder === undefined) {
      admitted.push(candidate);
      continue;
    }
    const contested = candidate.worktree;
    const sharedWorktree = sharesWorktree(holder, candidate) && contested !== undefined;
    const overlap = sharedWorktree
      ? [normaliseTerritoryPath(contested)]
      : overlappingPaths(candidate.territory, holder.territory);
    deferred.push({
      run: candidate.run,
      feature: candidate.feature,
      blockedBy: holder.run,
      overlap,
      reason:
        `Feature "${candidate.feature}" ${sharedWorktree ? 'runs in worktree' : 'declares'} ` +
        `${overlap.join(', ')}, which run ${holder.run} ("${holder.feature}") holds this pass. ` +
        `${sharedWorktree ? 'One worktree admits one feature at a time, because a baseline reset there discards every other feature\u2019s work' : 'Overlapping territories are serialised, so only one holds the territory at a time'}.`,
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

// -------------------------------------------------------------------------------------------------
// The territory as the log records it, so an overlap is recomputable by replay (AD-4)
// -------------------------------------------------------------------------------------------------

/**
 * The event type a declared territory is recorded as, and the key it carries its paths under.
 *
 * Spelled here rather than at the emitter, so the writer and the replay cannot disagree about either. The
 * type itself is declared in `src/contracts/event.ts`, which is where a reader that is not the engine —
 * there is none today, and story 3-1's web surface will be one — looks it up.
 */
export const TERRITORY_DECLARED_EVENT_TYPE = FEATURE_TERRITORY_DECLARED_EVENT_TYPE;

export const TERRITORY_PATHS_PAYLOAD_KEY = DECLARATION_PAYLOAD_KEYS.TerritoryPaths;

/** The payload of a `feature.territory_declared` line: normalised, de-duplicated, stably ordered. */
export const territoryDeclaredPayload = (
  declared: readonly string[],
): Record<string, unknown> =>
  FeatureTerritoryDeclaredPayloadSchema.parse({
    [TERRITORY_PATHS_PAYLOAD_KEY]: [...normaliseTerritory(declared)],
  });

/**
 * The whole repository, which {@link pathsCollide} reads as containing everything.
 *
 * It is the territory a replay substitutes when it cannot read what was declared, and the substitution is
 * the fail-safe direction: a feature serialised when it need not have been costs a pass, and one admitted
 * when it should have waited costs another feature's work in a shared worktree.
 */
export const WHOLE_REPOSITORY_TERRITORY: readonly string[] = Object.freeze(['.']);

/** One feature's territory, as replayed out of its own event log. */
export interface ReplayedTerritory {
  /** From the envelope, never from a payload: AD-21 would rewrite a bare ULID in a payload. */
  readonly run: string;
  readonly feature: string;
  /** The declared paths the log carries, normalised. Excludes any the AD-21 pass replaced. */
  readonly territory: readonly string[];
  /**
   * How many declared entries came back as the redaction marker rather than as a path.
   *
   * Counted rather than named, because the marker carries nothing about what it replaced: a path long
   * enough to reach AD-21's 24-character unbroken threshold at 3.5 bits per character is gone, and no
   * reader can recover it. Reported so `complete` is a fact rather than an assumption.
   */
  readonly unreadable: number;
  /** True when every declared entry survived the log. `false` means treat the territory as unknown. */
  readonly complete: boolean;
}

/**
 * The territory a run's log declares, or `null` when it declares none.
 *
 * The *last* `feature.territory_declared` wins, for the same reason the last `spec.recorded` does: a
 * re-declaration is a correction, and a fold that concatenated would report a territory the feature never
 * had. An unknown event type and a payload this build cannot read both change nothing (AD-5).
 */
export const territoryFromEvents = (
  events: readonly EventEnvelope[],
): ReplayedTerritory | null => {
  let found: ReplayedTerritory | null = null;
  for (const event of [...events].sort((a, b) => a.seq - b.seq)) {
    if (event.type !== TERRITORY_DECLARED_EVENT_TYPE) continue;
    const parsed = FeatureTerritoryDeclaredPayloadSchema.safeParse(event.payload);
    if (!parsed.success) continue;
    const declared = parsed.data[TERRITORY_PATHS_PAYLOAD_KEY];
    /**
     * The marker is matched **anywhere in the entry**, not only as the whole of it.
     *
     * `redactString` substitutes the marker *inside* a longer string — AD-21 replaces the run it found and
     * leaves the rest of the value alone — so `docs/[redacted]/records` is a path the log does not carry,
     * and testing for equality admitted it as one and reported `complete: true` for a territory nobody can
     * reconstruct. That fails *open*, and the whole of this design is argued from failing safe: a feature
     * serialised unnecessarily costs a pass, one admitted wrongly costs another feature's work.
     *
     * This is the same defect story 1-9's round fixed in `isRedacted` in `src/tui/projection.ts`; the fix
     * landed in the renderer and not here, where the consequence is a wrong admission rather than a wrong
     * word on a screen.
     */
    const readable = declared.filter((path) => !path.includes(REDACTION_MARKER));
    found = {
      run: event.run,
      feature: event.feature,
      territory: normaliseTerritory(readable),
      unreadable: declared.length - readable.length,
      complete: declared.length === readable.length,
    };
  }
  return found;
};

/**
 * The territory to admit a replayed feature on.
 *
 * An incomplete territory becomes the whole repository, which collides with every other feature. That is
 * the substitution {@link WHOLE_REPOSITORY_TERRITORY} exists for, and it is why a redacted path does not
 * silently shrink a conflict domain.
 */
export const admissionTerritoryOf = (replayed: ReplayedTerritory): readonly string[] =>
  replayed.complete ? replayed.territory : WHOLE_REPOSITORY_TERRITORY;

/** Each log's replayed territory, in the order the logs were given, skipping those that declare none. */
export const territoriesFromLogs = (
  logs: readonly (readonly EventEnvelope[])[],
): readonly ReplayedTerritory[] =>
  logs.flatMap((log) => {
    const replayed = territoryFromEvents(log);
    return replayed === null ? [] : [replayed];
  });

/**
 * Which features several logs say may act together, and which are serialised behind one that may.
 *
 * The same decision {@link admitByTerritory} makes for a live pass, taken from the logs alone — which is
 * what makes the serialisation AD-4 requires *reconstructable* rather than merely repeatable. It is not a
 * second authority for the decision: a live pass still reads the plans, and this reads what those plans
 * were recorded as.
 *
 * **What this replay does not reproduce, stated rather than left to be discovered.** A live pass passes
 * `worktree` on every candidate, and {@link sharesWorktree} serialises two features sharing one worktree
 * however disjoint their declared file territories are — because a baseline reset there discards the other
 * feature's work wholesale. The log carries no worktree, so a replay of exactly that pair **admits them
 * together** where the live pass serialised them. The replay is therefore a faithful reconstruction of the
 * *declared-territory* half of the decision and of nothing else.
 *
 * It is stated rather than fixed because neither remedy is available here. The worktree is
 * `plan.worktree` — declared configuration, not a function of the run id, which is the whole point: two
 * features are configured to share one. So it cannot be derived the way the handoff branch is. And carrying
 * it on `feature.territory_declared` would put an absolute path containing a bare 26-character ULID inside
 * a payload, which AD-21's entropy sweep replaces — leaving the replay reading `[redacted]` where it needed
 * a directory, and the only escape a wider allow-list, which AD-21 admits no remedy for. Closing this needs
 * a spec decision about how a worktree is named, not a patch here.
 *
 * `tests/engine.territory-replay.test.ts` pins the divergence directly, so it stays a known limitation
 * rather than becoming a surprise the day something calls this.
 */
export const admitReplayedTerritories = (
  logs: readonly (readonly EventEnvelope[])[],
): TerritoryAdmission =>
  admitByTerritory(
    territoriesFromLogs(logs).map((replayed) => ({
      run: replayed.run,
      feature: replayed.feature,
      territory: admissionTerritoryOf(replayed),
    })),
  );

/** Every path two replayed territories both claim, for a message that names the actual conflict. */
export const replayedOverlap = (
  left: ReplayedTerritory,
  right: ReplayedTerritory,
): readonly string[] => overlappingPaths(admissionTerritoryOf(left), admissionTerritoryOf(right));
