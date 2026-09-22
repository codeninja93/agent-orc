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
import {
  DECLARATION_PAYLOAD_KEYS,
  FEATURE_TERRITORY_DECLARED_EVENT_TYPE,
  FeatureTerritoryDeclaredPayloadSchema,
  isRepositoryRelativePath,
  normaliseTerritory,
  normaliseTerritoryPath,
  pathContains,
  pathsCollide,
} from '../contracts/index.js';
import type { EventEnvelope } from '../contracts/index.js';
import { REDACTION_MARKER } from '../runtime/index.js';
import type { Recorder } from '../runtime/index.js';

import { ENGINE_EMITTER } from './rebuild.js';
import { compareUlid } from './ulid.js';

/**
 * The path vocabulary, re-exported from where it now lives.
 *
 * It moved to `src/contracts/territory.ts` in story 2-4 because `step.analysis` declares a territory and
 * refuses a claim outside it, which is a parse-time property of one artifact — and a contract cannot
 * import the engine. Re-exported rather than wrapped so every existing caller keeps one name for one
 * implementation; a second normaliser is the defect that reports an overlap as disjoint.
 */
export {
  normaliseTerritory,
  normaliseTerritoryPath,
  pathContains,
  pathsCollide,
} from '../contracts/index.js';

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

// -------------------------------------------------------------------------------------------------
// Re-declaring a territory, which analysis is the first unit in a position to do
// -------------------------------------------------------------------------------------------------

/**
 * How a re-declaration differs from the territory it replaces.
 *
 * `acceptFeature` emits the first `feature.territory_declared` from the caller's plan, before any step has
 * read the repository. Analysis is what actually knows which files a feature touches, so its output
 * corrects that declaration — and `territoryFromEvents` already takes the last line as the correction,
 * which is the designed behaviour and not a special case.
 *
 * **Widening is the hazard, and it is recorded rather than prevented.** A re-declaration that claims ground
 * the previous one did not can newly overlap a feature that is already admitted and already writing.
 * Admission is recomputed from the declared territories on every pass, so the *next* pass serialises them;
 * the work already done concurrently is not undone, and the architecture has no mechanism that could undo
 * it — there is no territory lock to revoke and no transaction to roll back. Inventing one here would be a
 * second authority for a fact the declarations determine, which AD-4 forbids. So what this produces is the
 * evidence: what was held, what is claimed, what was added, and a flag a reader can act on.
 */
export interface TerritoryRedeclaration {
  /** The territory this declaration replaces, normalised. Empty when nothing was declared before. */
  readonly previous: readonly string[];
  /** The territory now declared, normalised. */
  readonly declared: readonly string[];
  /**
   * Paths the new declaration claims that no entry of the previous one contained.
   *
   * Containment rather than set difference: a previous territory of `src` already covers a new
   * `src/engine/lock.ts`, so narrowing a claim to a file inside it adds nothing and must not be reported as
   * widening. That is the direction that matters — a spurious widening flag would have a reader looking for
   * an overlap that cannot exist.
   */
  readonly added: readonly string[];
  /**
   * Entries of the previous declaration that no entry of the new one contains.
   *
   * Containment in the mirror direction, and **entry-level, not file-level** — which makes it a coarse
   * diff and is worth saying plainly. Narrowing `src/engine` to `src/engine/lock.ts` reports
   * `removed: ['src/engine']` even though that one file is still claimed, because the *entry*
   * `src/engine` — the directory as a whole — is not. Read it as "this claim no longer stands", never as
   * "nothing under here is claimed any more"; {@link declared} is the only statement of what is claimed.
   */
  readonly removed: readonly string[];
  /** True when anything was added: the case a concurrent feature may already have been writing in. */
  readonly widened: boolean;
  /** True when anything was dropped. Both can be true at once: a territory can move. */
  readonly narrowed: boolean;
  readonly summary: string;
}

/** Compare a new declaration against the one it replaces. Pure; the recording is separate. */
export const territoryRedeclaration = (
  previous: readonly string[],
  declared: readonly string[],
): TerritoryRedeclaration => {
  const held = normaliseTerritory(previous);
  const now = normaliseTerritory(declared);
  const added = now.filter((path) => !held.some((entry) => pathContains(entry, path)));
  const removed = held.filter((path) => !now.some((entry) => pathContains(entry, path)));
  const widened = added.length > 0;
  const narrowed = removed.length > 0;
  const parts = [
    `Territory re-declared as ${now.join(', ')}`,
    held.length === 0 ? 'where nothing was declared before' : `replacing ${held.join(', ')}`,
  ];
  if (widened) {
    parts.push(
      `It widens the territory by ${added.join(', ')}, which may already overlap a feature that is ` +
        'admitted and writing: the next admission pass serialises them, and work already done ' +
        'concurrently is not undone',
    );
  }
  if (narrowed) parts.push(`It no longer claims ${removed.join(', ')}`);
  return { previous: held, declared: now, added, removed, widened, narrowed, summary: `${parts.join('. ')}.` };
};

/**
 * The payload of a re-declaration line.
 *
 * `paths` carries the whole of the new declaration, exactly as a first declaration's does, so
 * {@link territoryFromEvents} needs no knowledge of this at all: the correction is read the same way
 * whether or not the extra keys are present. Everything else is the visibility, and is additive per AD-5.
 */
export const territoryRedeclaredPayload = (
  redeclaration: TerritoryRedeclaration,
): Record<string, unknown> =>
  FeatureTerritoryDeclaredPayloadSchema.parse({
    [TERRITORY_PATHS_PAYLOAD_KEY]: [...redeclaration.declared],
    [DECLARATION_PAYLOAD_KEYS.TerritoryPreviousPaths]: [...redeclaration.previous],
    [DECLARATION_PAYLOAD_KEYS.TerritoryAddedPaths]: [...redeclaration.added],
    [DECLARATION_PAYLOAD_KEYS.TerritoryRemovedPaths]: [...redeclaration.removed],
    [DECLARATION_PAYLOAD_KEYS.TerritoryWidened]: redeclaration.widened,
  });

/**
 * A re-declaration that declares nothing.
 *
 * `AnalysisOutputSchema` already refuses an empty territory on a completed output, and this is the same
 * refusal at the other end of the path, because this function is reachable from a caller that did not come
 * through that schema. An empty territory collides with nothing, so recording one would admit the feature
 * beside every other one — the genuine fail-open direction, and the reason `WHOLE_REPOSITORY_TERRITORY`
 * exists for the case where the territory is *unknown*. `config.invalid` → `escalate-to-human`.
 */
export class TerritoryDeclaresNothing extends Error {
  readonly code = 'config.invalid';

  constructor(step: string, detail: string) {
    super(
      `Refusing to record the territory step "${step}" declared: ${detail}. An empty territory overlaps ` +
        'nothing, so the feature would be admitted beside every other one; a feature whose territory is ' +
        '*unknown* is recorded as the whole repository instead, which collides with everything. The two ' +
        'are opposite directions and only the second is safe.',
    );
    this.name = 'TerritoryDeclaresNothing';
  }
}

/** What {@link recordTerritoryRedeclaration} is asked to record. */
export interface RecordTerritoryOptions {
  /** The run's recorder. The caller owns the AD-29 single-writer claim; this never opens a log. */
  readonly recorder: Recorder;
  /** The step whose output declared this territory, so the line says which one corrected it. */
  readonly step: string;
  /**
   * The run's log as it stands, which is where the territory being replaced is read from.
   *
   * **Not a caller-supplied `previous`.** That is what this took first, and a caller holding a stale value
   * — a plan read before an earlier correction, or a checkpoint behind the log — would have a real widening
   * recorded as `widened: false` with `added: []`, which is worse than not recording it at all: the log
   * would positively assert that nothing was added. AD-4 makes the log the only truth about what this run
   * has declared, so the comparison is against the log's own last declaration and against nothing else.
   */
  readonly events: readonly EventEnvelope[];
  /** The territory the step's output declares. */
  readonly declared: readonly string[];
}

/** A re-declaration, and whether the line about it reached the log. */
export interface RecordedTerritoryRedeclaration extends TerritoryRedeclaration {
  /**
   * False when the AD-21 pass dropped the artifact and `redaction.failed` was appended in its place.
   *
   * Reported rather than swallowed because AD-4 makes the log the only truth: a caller that treated a
   * dropped line as a recorded one would be acting on a correction the fold will never see, and would
   * re-decide it on the next pass against a log that does not remember. The reconciler's own rule for that
   * is `UnrecordedAction`; this module is below the loop and states the fact rather than choosing for it.
   */
  readonly recorded: boolean;
}

/**
 * Record a re-declared territory as an event, and report what changed.
 *
 * **The engine writes this line, never the agent.** AD-15 enumerates the write surface and leaves every
 * write to the engine; a step agent that could append to the log would also be a second writer of it,
 * which AD-29 forbids outright. The agent's output *declares*; this records.
 *
 * The emitter is `ENGINE_EMITTER`, the same name `acceptFeature`'s run-creation declaration carries, and
 * it is accurate rather than convenient: the sole caller is `Reconciler.recordDeclaredTerritory`, so this
 * line does originate in the reconciler. A replay reading the two declarations of one run sees one
 * emitter and two steps — `null` for the run-creation line, the analysis step for the correction — which
 * is the distinction that matters and the one the envelope already carries.
 *
 * It returns the comparison so the caller can act on a widening in the same breath it recorded one — and
 * so a caller that ignores the return value has still left the evidence on disk, which is the direction
 * that loses nothing.
 */
export const recordTerritoryRedeclaration = (
  options: RecordTerritoryOptions,
): RecordedTerritoryRedeclaration => {
  if (options.declared.length === 0) {
    throw new TerritoryDeclaresNothing(options.step, 'it names no path at all');
  }
  /**
   * A malformed entry is refused here too, and not left to normalise into `.`.
   *
   * `''`, `'   '`, `'/'` and `'src/..'` all normalise to the whole repository, so a declaration made
   * entirely of them would record a territory that collides with everything — which looks fail-safe and
   * is not what the step said. It is the same refusal `isRepositoryRelativePath` applies inside
   * `step.analysis`, applied again at the other end of the path, because this function is reachable from
   * a caller that did not come through that schema.
   */
  const malformed = options.declared.filter((path) => !isRepositoryRelativePath(path));
  if (malformed.length > 0) {
    throw new TerritoryDeclaresNothing(
      options.step,
      `${malformed.map((path) => JSON.stringify(path)).join(', ')} ${malformed.length === 1 ? 'is not a' : 'are not'} repository-relative ${malformed.length === 1 ? 'path' : 'paths'}`,
    );
  }
  const previous = territoryFromEvents(options.events);
  const redeclaration = territoryRedeclaration(previous?.territory ?? [], options.declared);
  const recorded = options.recorder.recordResult({
    feature: options.recorder.feature,
    run: options.recorder.paths.runId,
    step: options.step,
    emitter: ENGINE_EMITTER,
    type: TERRITORY_DECLARED_EVENT_TYPE,
    payload: territoryRedeclaredPayload(redeclaration),
  });
  return { ...redeclaration, recorded: !recorded.dropped };
};
