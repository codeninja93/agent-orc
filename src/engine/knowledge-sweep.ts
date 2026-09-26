/**
 * Story 5-2 — the sweep `src/contracts/knowledge.ts` and `src/engine/profile.ts` both name three times
 * over and neither builds: retiring a `KnowledgeEntry` AD-16-contradiction has already flagged, and
 * checking the other kind of staleness `memory-design.md` names — "a periodic sweep... checks anchors
 * still resolve" — for both memory tiers the profile's knowledge section (L1/L2) and the consolidated
 * per-project store (L3, `src/engine/consolidation.ts`) can hold.
 *
 * **Two staleness kinds, and the safe direction is opposite for each, and both directions are followed.**
 * AD-16-contradiction (`resolveKnowledge`, unchanged by this story) already errs *toward* flagging: a
 * false "the repository contradicts this" costs nothing, because the entry is retired but the knowledge,
 * if still true, is exactly the kind of thing a person or a later mechanism can re-derive and re-record.
 * Anchor-resolution is the opposite: a wrong existence check cannot be re-derived from anything, so
 * {@link anchorResolution} errs *toward not flagging* — `'dead'` only for a path this module actually
 * checked and found genuinely absent, `'unchecked'` for the two anchor kinds ({@link ANCHOR_KINDS}'s
 * `api-symbol` and `test-name`) that would need source or test parsing this story does not build. A wrong
 * "dead" verdict is worse than an honest "cannot tell".
 *
 * **The two stores are treated differently because one can be rewritten and the other must not be.**
 * `profile.toml` is human-edited configuration this codebase already rewrites atomically
 * (`src/installer/write.ts`'s own idiom, now shared via `src/runtime/commands.ts`'s
 * {@link writeFileIfChanged}), so {@link sweepProfileKnowledge} retires the union of both staleness kinds
 * by rewriting the whole file. `consolidated.jsonl` is append-only by design — story 5-1's own writer
 * never rewrites or prunes it, matching `events.jsonl`'s discipline — so {@link sweepConsolidatedKnowledge}
 * only *reports* what anchor-resolution finds dead there, for a person or a later mechanism to act on.
 *
 * **Nothing here is wired into a live run.** Neither function is called from the reconciler, a step's
 * input construction, or any scheduler/CLI — matching `trustRecord`/`foldFleet`/story 5-1's own
 * `consolidation.ts` precedent of complete, tested, currently-unwired modules. Both take an explicit
 * `ConfigurationSource`/`projectId`/repository path from the caller, never deriving one from run internals.
 */
import { existsSync } from 'node:fs';
import { resolve, sep } from 'node:path';

import { serialiseToml } from '../contracts/index.js';
import type { AnchorKind, KnowledgeEntry, Profile } from '../contracts/index.js';
import { projectMemoryPath, writeFileIfChanged } from '../runtime/index.js';
import type { WriteDisposition } from '../runtime/index.js';

import { orchHomeOf, readConsolidatedStore } from './consolidation.js';
import { readConventions } from './conventions.js';
import type { ConfigurationSource } from './profile.js';
import { loadProfile, resolveKnowledge } from './profile.js';

/**
 * Whether a `module-name`/`file-path` anchor still resolves against a repository, or cannot be checked.
 *
 * Deliberately narrow: `'module-name'` is checked as `<repositoryPath>/src/<anchor>`, matching
 * `src/engine/trust-record.ts`'s `areaOf` — the same taxonomy `src/engine/consolidation.ts` anchors every
 * L3 fact on — where an area is a directory directly under `src/`. `'file-path'` is checked as
 * `<repositoryPath>/<anchor>` verbatim, since a file-path anchor already names a path relative to the
 * repository root (`memory-design.md`'s weakest, but still legal, anchor kind). `'api-symbol'` and
 * `'test-name'` are never checked: resolving either needs source or test parsing this story does not
 * build, and this module's whole safe-erring direction (see the module doc) forbids guessing at either.
 *
 * Both `repositoryPath` and the joined target are resolved to absolute paths before the check, and a
 * target that resolves outside `repositoryPath` comes back `'dead'` rather than reaching `existsSync` at
 * all. `KnowledgeAnchorSchema` only refuses a blank, padded, or line-number-shaped anchor — it does not
 * refuse one containing `../` segments — so an unchecked `join` could otherwise walk a `module-name` or
 * `file-path` anchor out of the repository the caller named. `repositoryPath` itself is never validated
 * as absolute by any caller, so resolving it here (rather than trusting it) is what keeps a relative or
 * empty value from being checked against `process.cwd()` instead of the intended repository.
 */
export const anchorResolution = (
  anchor: string,
  anchorKind: AnchorKind,
  repositoryPath: string,
): 'resolves' | 'dead' | 'unchecked' => {
  if (anchorKind !== 'module-name' && anchorKind !== 'file-path') return 'unchecked';

  const root = resolve(repositoryPath);
  const target = anchorKind === 'module-name' ? resolve(root, 'src', anchor) : resolve(root, anchor);
  const withinRepository = target === root || target.startsWith(root + sep);
  if (!withinRepository) return 'dead';

  return existsSync(target) ? 'resolves' : 'dead';
};

/**
 * Two `KnowledgeEntry` values are the same entry when every field matches.
 *
 * No entry carries an id to key on (AD-16's shape is a flat, scalar `[[knowledge.entries]]` table row —
 * see `src/contracts/knowledge.ts`), so retiring one is a question of structural equality against the
 * entry `loadProfile` handed back, not of object identity a caller happens to have preserved.
 */
const sameEntry = (a: KnowledgeEntry, b: KnowledgeEntry): boolean =>
  a.anchor === b.anchor &&
  a.anchor_kind === b.anchor_kind &&
  a.claim === b.claim &&
  a.provenance === b.provenance &&
  a.recorded_at === b.recorded_at &&
  a.decay_policy === b.decay_policy &&
  a.decay_features === b.decay_features;

/** What {@link sweepProfileKnowledge} did. */
export interface ProfileKnowledgeSweep {
  /** Every entry retired from `profile.toml`, in the order it appeared in the file. */
  readonly retired: readonly KnowledgeEntry[];
  /**
   * What the rewrite did, threaded through from `writeFileIfChanged` (the installer's own
   * `FileOutcome`/`WriteOutcome` carry the same field for the same reason). `'unchanged'` whenever
   * nothing was retired — the file is never even re-serialised in that case, so this is not merely what
   * the write reported but a guarantee that no write was attempted.
   */
  readonly disposition: WriteDisposition;
}

/**
 * AD-9 makes a run's configuration snapshot immutable for the run's duration; only project scope
 * (`<target-repo>/.orch/`) is ever a legitimate target for a rewrite.
 *
 * `sweepProfileKnowledge` takes a generic `ConfigurationSource` because `loadProfile`/`resolveKnowledge`
 * do too, but unlike them this function writes — and a caller that pointed it at a run's own
 * `runs/<run-id>/config/profile.toml` snapshot would rewrite the one artifact AD-9 requires to stay fixed
 * for as long as the run reads it. Refused here rather than left to `writeFileIfChanged` to silently
 * mutate.
 */
export class ProfileSweepScopeRefused extends Error {
  readonly code = 'internal.invariant_violated';
  readonly scope: ConfigurationSource['scope'];

  constructor(source: ConfigurationSource) {
    super(
      `Refusing to sweep profile knowledge at ${source.label} (${source.scope} scope): ` +
        'sweepProfileKnowledge rewrites profile.toml, and AD-9 makes a run\'s configuration snapshot ' +
        "immutable for the run's duration. Only a project-scope source (<target-repo>/.orch/) may ever " +
        'be swept.',
    );
    this.name = 'ProfileSweepScopeRefused';
    this.scope = source.scope;
  }
}

/**
 * Retire every stale entry from a profile's knowledge section: AD-16-contradicted entries
 * (`resolveKnowledge`'s own `stale`) union anchor-resolution `'dead'` entries among what it called
 * `applied`.
 *
 * Retiring means removing the union from `profile.knowledge.entries` and rewriting the whole file with
 * `serialiseToml`/`writeFileIfChanged` — the exact idiom the installer already writes `profile.toml`
 * with. When there is nothing to retire (every entry both applies and resolves, or the profile has no
 * knowledge section at all), the file is never re-serialised or written at all: `parseToml`/
 * `serialiseToml` do not round-trip comments, so re-serialising a hand-edited `profile.toml` with zero
 * stale entries would silently strip its comments even though `writeFileIfChanged` would then skip the
 * write as `'unchanged'`. Skipping the round-trip itself, not just the write, is what keeps a swept file
 * with nothing stale byte-for-byte identical to the one on disk.
 */
export const sweepProfileKnowledge = (
  source: ConfigurationSource,
  repositoryPath: string,
): ProfileKnowledgeSweep => {
  if (source.scope !== 'project') throw new ProfileSweepScopeRefused(source);

  const profile = loadProfile(source);
  const conventions = readConventions(source.conventionsDir);
  const { applied, stale } = resolveKnowledge(profile, conventions);

  const deadApplied = applied.filter(
    (entry) => anchorResolution(entry.anchor, entry.anchor_kind, repositoryPath) === 'dead',
  );
  const toRetire: readonly KnowledgeEntry[] = [...stale.map((flagged) => flagged.entry), ...deadApplied];

  if (toRetire.length === 0) return { retired: [], disposition: 'unchanged' };

  const originalEntries = profile.knowledge?.entries ?? [];
  const retired = originalEntries.filter((entry) =>
    toRetire.some((candidate) => sameEntry(entry, candidate)),
  );
  const kept = originalEntries.filter(
    (entry) => !toRetire.some((candidate) => sameEntry(entry, candidate)),
  );
  const updatedProfile: Profile = { ...profile, knowledge: { entries: kept } };
  const disposition = writeFileIfChanged(source.profile, serialiseToml(updatedProfile));

  return { retired, disposition };
};

/** Options {@link sweepConsolidatedKnowledge} shares with story 5-1's own consolidation-store readers. */
export interface ConsolidatedKnowledgeSweepOptions {
  /** `ORCH_HOME`. Defaults to the one the runtime resolves, exactly as every other reader does. */
  readonly orchHome?: string;
}

/** What {@link sweepConsolidatedKnowledge} found — a report, never a file edit (see the module doc). */
export interface ConsolidatedKnowledgeSweep {
  /** Every L3 entry whose anchor plainly no longer resolves, in the store's own line order. */
  readonly stale: readonly KnowledgeEntry[];
}

/**
 * Report — never rewrite — the L3 entries whose anchor no longer resolves.
 *
 * `consolidated.jsonl` is append-only by design (see the module doc), so this is a pure report: the
 * caller, a person today, decides what if anything to do with a stale L3 fact. Every entry
 * `consolidateRun` (`src/engine/consolidation.ts`) has ever written carries `anchor_kind: 'module-name'`,
 * so in practice this checks that kind alone, but the check is written against every kind
 * {@link anchorResolution} understands, in case a future writer of this same store anchors differently.
 *
 * Reads the store with `consolidation.ts`'s own exported {@link readConsolidatedStore}: that reader and
 * `retrieveFacts`'s read of the same file turned out to be byte-for-byte identical, so both callers share
 * the one canonical implementation (including its `ENOENT`-safe read) instead of each carrying a copy.
 */
export const sweepConsolidatedKnowledge = (
  projectId: string,
  repositoryPath: string,
  options: ConsolidatedKnowledgeSweepOptions = {},
): ConsolidatedKnowledgeSweep => {
  const storePath = projectMemoryPath(projectId, orchHomeOf(options));
  const entries = readConsolidatedStore(storePath);
  const stale = entries.filter(
    (entry) => anchorResolution(entry.anchor, entry.anchor_kind, repositoryPath) === 'dead',
  );
  return { stale };
};
