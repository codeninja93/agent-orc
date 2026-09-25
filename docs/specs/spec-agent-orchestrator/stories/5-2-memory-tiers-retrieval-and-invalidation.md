---
title: 'Memory tiers, retrieval budget, anchors and invalidation'
type: 'feature'
created: '2026-09-25'
status: 'done'
baseline_revision: 'c44a325606af37b8cece9cca78a9c6a77812d7ac'
review_loop_iteration: 0
followup_review_recommended: true
context: []
warnings: ['oversized']
deferred:
  - summary: >-
      sweepProfileKnowledge reads profile.toml then later writes it; a concurrent edit to the file by
      another process in between is silently discarded by the sweep's write.
    evidence: |-
      Confirmed by reading sweepProfileKnowledge directly: loadProfile happens well before
      writeFileIfChanged, with no re-check of the file's bytes immediately before the write. Real, but
      unreachable today because nothing calls this function yet (this story's own explicit boundary) —
      there is no live or concurrent path to demonstrate the race against. A real guard (re-read-and-abort,
      or a lock) belongs with whichever future story gives this a live caller, matching story 5-1's own
      identical deferral for consolidation.ts's write path.
    location: >-
      src/engine/knowledge-sweep.ts (sweepProfileKnowledge)
    severity: medium
  - summary: >-
      Neither the sweep nor retrieveFacts has a live caller or a declaration surface for a feature to
      state its own read budget — "declared per-feature read budget" (SPEC.md's CAP-17 success
      criterion) is only mechanically honored, never actually declared anywhere.
    evidence: |-
      grep for "read budget"/"per-feature" across the codebase turns up only this story's own comments
      and the SPEC.md sentence it answers. Real, but an explicit, stated boundary of this story
      (Boundaries: "Neither the sweep nor retrieval is wired into... any... step's input construction") —
      the declaration surface is part of wiring a real caller, which this story deliberately does not
      build, matching trustRecord/foldFleet/story 5-1's own consolidation.ts precedent of complete,
      tested, currently-unwired modules.
    location: >-
      src/engine/knowledge-retrieval.ts (retrieveFacts), src/engine/knowledge-sweep.ts
    severity: medium
---

<intent-contract>

## Intent

**Problem:** Two pieces of CAP-17/`memory-design.md` are named but unbuilt. First, "story 5-2's sweep"
is cited three times already in this codebase (`src/contracts/knowledge.ts`, `src/engine/profile.ts`) as
the mechanism that retires a stale `KnowledgeEntry` from `profile.toml`'s knowledge section (AD-16) — but
`resolveKnowledge` only *detects* one kind of staleness (the repository's own instructions now contradict
the entry) and nothing *acts* on the result, and nothing checks the other kind memory-design.md names
("a periodic sweep... checks anchors still resolve"). Second, story 5-1's `consolidated.jsonl` (L3) has no
reader at all — "retrieval for a later feature respects a declared per-feature read budget" (CAP-17) is
still just a sentence.

**Approach:** Two independent additions, both pure/mechanical, neither wired into a live run (matching
story 5-1's own precedent — `trustRecord`/`foldFleet`/`consolidation.ts` are all complete, tested, and
currently uncalled). **The sweep** (`src/engine/knowledge-sweep.ts`): combine `resolveKnowledge`'s existing
AD-16-contradiction detection with a new, conservative anchor-resolution check (module-name/file-path
anchors only — a directory or file that plainly no longer exists), then retire the union from `profile.toml`
by rewriting it with `serialiseToml`/`writeFileIfChanged`; run the same anchor-resolution check against
`consolidated.jsonl` (L3) but only *report* stale entries there, since that store is append-only by design
and this story does not overturn that. **Retrieval** (`src/engine/knowledge-retrieval.ts`):
`retrieveFacts(projectId, areas, budget)` reads `consolidated.jsonl`, filters to the given areas, and
returns at most `budget` entries, most-recent-first.

## Boundaries & Constraints

**Always:**
- The sweep's anchor-resolution check covers only `anchor_kind: 'module-name'` and `'file-path'` —
  checkable by a filesystem existence test alone. `'api-symbol'` and `'test-name'` anchors are reported as
  `'unchecked'`, never as resolving or dead: resolving either needs source/test parsing this story does not
  build, and a wrong "dead" verdict is worse than an honest "cannot tell."
- **The safe direction differs by staleness kind, and both directions are followed.** AD-16-contradiction
  detection (`resolveKnowledge`, unchanged) already documents its own safe-erring direction as *toward*
  flagging — a false "the repository contradicts this" costs nothing, since the entry is retired but the
  underlying knowledge, if still true, is exactly the kind of thing "convert, do not retrieve" already
  wants turned into something checkable instead. Anchor-resolution is the opposite: a wrong existence check
  cannot be re-derived from anything, so it errs *toward not flagging* — `resolves === false` only for a
  path checked and genuinely absent, never inferred from an unusual anchor shape.
- Retiring a `profile.toml` entry means removing it from `profile.knowledge.entries` and rewriting the
  whole file via `serialiseToml`/`writeFileIfChanged` (`src/contracts/toml.ts`/`src/installer/write.ts`) —
  the exact idiom the installer already writes `profile.toml` with. A retired entry is matched by full
  structural equality against the loaded `KnowledgeEntry` (no entry carries an id field to key on).
- `consolidated.jsonl` (L3) is never rewritten or pruned by this story: it stays append-only, matching
  `events.jsonl`'s own discipline and story 5-1's own writer. The L3 sweep's output is a report
  (`readonly KnowledgeEntry[]` of stale entries), for a person or a later mechanism to act on — never a
  file edit.
- `retrieveFacts`'s budget is a plain count of entries, most-recent-first (`recorded_at` descending), not a
  token count — this story adds no tokenizer dependency, and a count is sufficient to be a real, testable
  budget. Filtering is by `anchor` membership in the caller-supplied `areas` list (the same area vocabulary
  `areaOf`/story 5-1 already established) — no fuzzy matching, no ranking beyond recency.
- Neither the sweep nor retrieval is wired into the reconciler, a step's input construction, or any
  scheduler/CLI — matching `trustRecord`/`foldFleet`/story 5-1's `consolidation.ts` precedent of complete,
  tested, currently-unwired modules. Both take an explicit `ConfigurationSource`/`projectId`/repository path
  from the caller, never deriving one from run internals (story 5-1's own established rule).

**Never:**
- No retrieval hit-count tracking, no promotion toward L1 on repeated retrieval, and no `decay_policy`-driven
  expiry (`until-refactor` detection, `n-features` countdown, `session` scoping). `memory-design.md` names
  all of these, but each needs infrastructure this story does not build (a durable hit-count store, a
  refactor-detection signal, a feature-count clock) and each is a separable mechanism a later story can add
  without revisiting the sweep or retrieval built here. Recorded as an explicit scope boundary, not a gap
  discovered later.
- No change to `resolveKnowledge`, `KnowledgeEntrySchema`, or any existing contract. The sweep composes
  `resolveKnowledge`'s existing output; it does not alter how AD-16 contradiction is detected.
- No `api-symbol`/`test-name` anchor resolution (see Always) — not attempted, not approximated.
- No change to `consolidation.ts`'s writer, `projectMemoryPath`, or the provenance/dedup scheme story 5-1
  built. This story only reads `consolidated.jsonl`.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| AD-16-contradicted entry | `resolveKnowledge` reports one entry `stale` | That entry is retired from `profile.toml`; file rewritten | No error expected |
| Module-name anchor, directory gone | `anchor: 'payments'`, `anchor_kind: 'module-name'`, no `src/payments` in the repo | Entry retired (profile.toml) or reported (consolidated.jsonl) | No error expected |
| Module-name anchor, directory present | `anchor: 'engine'`, `src/engine` exists | Entry kept; not retired, not reported | No error expected |
| api-symbol / test-name anchor | Any such entry | Never retired or reported as dead by this story; treated as `'unchecked'` | No error expected |
| No stale entries at all | Every entry applies and resolves | `profile.toml` unchanged (`writeFileIfChanged` reports `'unchanged'`); no consolidated.jsonl report entries | No error expected |
| Retrieval within budget | 3 matching-area entries, `budget: 5` | All 3 returned, most-recent-first | No error expected |
| Retrieval over budget | 5 matching-area entries, `budget: 2` | The 2 most recent returned; the rest silently excluded (not an error — a budget is a limit, not a failure) | No error expected |
| Retrieval, no matching area | Entries exist, none anchored to the requested areas | `[]` returned | No error expected |
| Retrieval, empty/missing store | `consolidated.jsonl` does not exist yet for this project | `[]` returned, matching `readConsolidatedStore`'s own existing behavior | No error expected |

</intent-contract>

## Code Map

- `src/engine/profile.ts` -- `resolveKnowledge`, `StaleKnowledgeEntry`, `ResolvedKnowledge`, `ConfigurationSource`; reused unchanged as the AD-16-contradiction half of the sweep's input.
- `src/engine/conventions.ts` -- `RepositoryConventions`, `readConventions`, `conventionsSpeakingTo`; read-only reference, already exercised via `resolveKnowledge`.
- `src/contracts/knowledge.ts` -- `KnowledgeEntry`, `ANCHOR_KINDS`; read-only reference. The three existing comments naming "story 5-2's sweep" are what this story closes.
- `src/contracts/toml.ts` -- `serialiseToml`; reused to rewrite `profile.toml` after retiring entries.
- `src/installer/write.ts` -- `writeFileIfChanged`; reused for the same atomic-write idiom the installer already uses for `profile.toml`.
- `src/engine/consolidation.ts` -- read-only reference for `readConsolidatedStore`'s shape (private today; this story adds its own read of the same file, matching its per-line-isolation idiom rather than exporting and reusing the private function verbatim, since the two callers want different error handling — retrieval wants a fully validated list, the L3 sweep wants every line regardless of project scoping already applied by the caller).
- `src/runtime/paths.ts` -- `projectMemoryPath`; reused to locate `consolidated.jsonl`.
- `src/engine/knowledge-sweep.ts` (new) -- `anchorResolution`, `sweepProfileKnowledge`, `sweepConsolidatedKnowledge`.
- `src/engine/knowledge-retrieval.ts` (new) -- `retrieveFacts`.

## Tasks & Acceptance

**Execution:**
- `src/engine/knowledge-sweep.ts` -- add `anchorResolution(anchor, anchorKind, repositoryPath): 'resolves' | 'dead' | 'unchecked'` -- the shared, conservative filesystem check for `module-name`/`file-path` anchors.
- `src/engine/knowledge-sweep.ts` -- add `sweepProfileKnowledge(source, repositoryPath): { readonly retired: readonly KnowledgeEntry[] }` -- combines `resolveKnowledge`'s `stale` with anchor-resolution `'dead'` entries among `applied`, retires the union from `profile.toml`.
- `src/engine/knowledge-sweep.ts` -- add `sweepConsolidatedKnowledge(projectId, repositoryPath, options): { readonly stale: readonly KnowledgeEntry[] }` -- report-only, per the Boundaries.
- `src/engine/knowledge-retrieval.ts` -- add `retrieveFacts(projectId, areas, budget, options): readonly KnowledgeEntry[]`.
- `tests/engine.knowledge-sweep.test.ts` (new) -- every sweep-related I/O Matrix row.
- `tests/engine.knowledge-retrieval.test.ts` (new) -- every retrieval-related I/O Matrix row.

**Acceptance Criteria:**
- Given a profile with one AD-16-contradicted entry and one healthy entry, when swept, then only the
  contradicted one is removed from `profile.toml` and the file is rewritten.
- Given a profile entry anchored `module-name` to a directory that does not exist under the given repository
  path, when swept, then that entry is retired even though `resolveKnowledge` alone would have called it
  `applied`.
- Given every entry in a profile both applies and resolves, when swept, then `profile.toml` is byte-for-byte
  unchanged (`writeFileIfChanged` reports `'unchanged'`).
- Given an `api-symbol` or `test-name` anchor, when swept, then it is never retired or reported as dead by
  this story, regardless of whether the symbol still exists.
- Given more matching-area entries than the requested budget, when `retrieveFacts` runs, then exactly
  `budget` entries are returned, the most recent first, and no error is raised for the excluded remainder.

## Verification

**Commands:**
- `npm run typecheck` -- expected: no errors
- `npm run lint` -- expected: no errors
- `npm run build` -- expected: succeeds
- `npm test` -- expected: full suite passes, including the two new test files

## Spec Change Log

### 2026-09-25 — Problem statement overclaimed which "story 5-2's sweep" citations this closes
intent-alignment found that the Problem statement's framing ("cited three times... this story closes")
reads as though all three in-code citations of "story 5-2's sweep" are addressed, but two of the three
(`src/contracts/knowledge.ts:49` and `:172`) are specifically about `decay_policy`-driven (`n-features`)
expiry, which this story's own Boundaries section already, correctly, excludes as needing infrastructure
this story does not build. Only the third citation (`src/engine/profile.ts:220`, AD-16-contradiction
retirement) plus the new anchor-resolution check are actually closed. Amended the Intent's Problem
statement to say so precisely; no code or scope change, no Boundaries change — the exclusion was already
correct, only the framing was overclaiming it.

## Review Triage Log

### 2026-09-25 — Review pass
- verdicts: 23 findings — high 2, medium 7, low 11, false 3, maybe-false 0
- findings:
  - `[high]` `patch` blind-hunter: `sweepProfileKnowledge` unconditionally rewrites `profile.toml`
    whenever a knowledge section exists, even when nothing is stale — `loadProfile` → filter → `serialiseToml`
    → `writeFileIfChanged` always re-serializes, and `parseToml`/`serialiseToml` (`src/contracts/toml.ts`)
    never round-trip comments. A hand-edited `profile.toml` (this file's own stated audience, per AD-16) with
    zero stale entries would have its comments silently stripped on every sweep, directly contradicting the
    story's own "byte-for-byte unchanged when clean" acceptance criterion. The existing tests could not catch
    this because their fixture is written by `serialiseToml` itself, so re-serializing produces identical
    bytes by construction. Action: skip the round-trip and write entirely when nothing was retired.
  - `[high]` `patch` verification-gap (same root cause, independently reproduced empirically — merged):
    built a fixture with one prepended comment line, zero stale entries, ran `sweepProfileKnowledge` against
    it, and confirmed the comment was stripped and the file rewritten. Same action as the row above; noted
    that the underlying TOML-codec comment-loss is pre-existing and out of this story's scope to fix — only
    the *unnecessary* write (when nothing changed) is this story's to avoid.
  - `[medium]` `patch` blind-hunter: `anchorResolution` joins `repositoryPath` with a caller/profile-supplied
    `anchor` with no containment check — a `module-name`/`file-path` anchor containing `../` segments (legal
    under `KnowledgeAnchorSchema`, which refuses only blank/padded/line-number anchors) could resolve outside
    the intended repository. Action: verify the resolved path stays under `repositoryPath` before
    `existsSync`; treat an anchor that would escape it as `'dead'` rather than checking outside the repo.
  - `[medium]` `patch` edge-case-hunter (same root cause, merged): independently found via exhaustive path
    tracing.
  - `[medium]` `patch` edge-case-hunter (related, merged into the same fix): `repositoryPath` itself is never
    validated as absolute; a relative or empty value resolves anchors against `process.cwd()` instead of the
    intended repository. The containment check above (computed against a resolved/absolute form of
    `repositoryPath`) closes this as a side effect; no separate guard needed.
  - `[medium]` `patch` blind-hunter: `sweepProfileKnowledge(source, repositoryPath)` takes a generic
    `ConfigurationSource` with no guard against `source.scope` being a run's own frozen configuration
    snapshot — AD-9 requires that snapshot to stay immutable for the run's duration, and nothing here stops
    a future caller from pointing this at one and mutating it mid-run. Action: refuse (throw a clear error)
    when `source.scope !== 'project'`.
  - `[medium]` `defer` edge-case-hunter: `sweepProfileKnowledge` reads `profile.toml` via `loadProfile`,
    then later writes it via `writeFileIfChanged` — if another process edits the file in between (e.g. a
    person adding a knowledge entry), the sweep's write silently discards that edit. Real, but the same
    reasoning story 5-1's own concurrent-write finding used: this function is not wired into any live or
    concurrent path yet, so there is nothing to demonstrate the race against. A real guard (re-read-and-abort,
    or a lock) belongs with whichever future story gives this a live caller.
  - `[medium]` `defer` intent-alignment: "declared per-feature read budget" (`SPEC.md`'s own success
    criterion for CAP-17) has no surface anywhere for a feature to actually declare its own budget —
    `retrieveFacts` only honors whatever number it's handed. Real, and already an explicit, stated boundary
    of this story (Boundaries: "Neither the sweep nor retrieval is wired into... any... step's input
    construction") — the declaration surface is part of wiring a caller, which this story deliberately does
    not build, matching `trustRecord`/`foldFleet`/story 5-1's own precedent.
  - `[medium]` `defer` intent-alignment (same root cause as the row above, merged): the broader observation
    that nothing in this diff runs as a periodic or triggered process — restates the same already-declared
    unwired boundary from a liveness angle rather than a declaration-surface angle.
  - `[low]` `patch` blind-hunter: `readConsolidatedEntries` in the two new files is byte-for-byte identical
    to itself across both files and to `consolidation.ts`'s existing private `readConsolidatedStore` —
    verified by direct diff. The story's own Code Map claim that the two new callers "want different error
    handling" justifying non-reuse is not true of the code as written. Action: export one shared reader
    (from `consolidation.ts`, the original) and have both new files import it instead of duplicating it.
  - `[low]` `patch` verification-gap (same root cause, merged): independently found the same duplication.
  - `[low]` `patch` blind-hunter: the `orchHomeOf` helper (treat a blank `orchHome` as `undefined`) is
    duplicated verbatim in `consolidation.ts`, `knowledge-retrieval.ts`, and `knowledge-sweep.ts`. Action:
    export it once (from `consolidation.ts`) and reuse it in the two new files.
  - `[low]` `patch` blind-hunter: no test exercises `sweepProfileKnowledge`'s actual union code path (an
    AD-16-contradicted entry and an anchor-dead entry present simultaneously alongside a kept entry) — every
    existing test exercises exactly one staleness kind at a time. Action: added a test with both kinds
    present plus one healthy entry, asserting only the two stale ones are retired.
  - `[low]` `patch` blind-hunter: `sweepProfileKnowledge` computes but discards `writeFileIfChanged`'s
    `WriteDisposition`, so a caller cannot learn whether `profile.toml` was actually rewritten without
    independently re-reading and diffing it — unlike the installer's own `FileOutcome`/`WriteOutcome`, which
    thread the same disposition through. Action: add `disposition: WriteDisposition` to `ProfileKnowledgeSweep`
    (`'unchanged'` when nothing was retired, matching the fix for the high-severity row above).
  - `[low]` `patch` blind-hunter: `knowledge-sweep.ts` imports `projectMemoryPath` from the runtime barrel
    (`../runtime/index.js`) but `writeFileIfChanged` directly from `../runtime/commands.js`, though the
    barrel already re-exports both. Action: import both from the barrel.
  - `[low]` `patch` blind-hunter: `retrieveFacts`'s `budget` silently clamps a negative value to zero
    (`Math.max(0, budget)`) and silently truncates a non-integer via `Array.prototype.slice`, with neither
    behavior documented or tested. Action: document both in the JSDoc and add a test for a negative budget.
  - `[low]` `patch` blind-hunter: `tests/engine.knowledge-sweep.test.ts` imports from `'../src/engine/index.js'`
    in two separate `import` statements rather than one. Action: combined.
  - `[low]` `patch` edge-case-hunter: `sweepConsolidatedKnowledge`'s `existsSync` then `readFileSync` on
    `consolidated.jsonl` is a check-then-act race — a deletion in between throws `ENOENT` uncaught instead of
    the `[]` its own "no store yet" case expects. Action: read directly and catch `ENOENT` (or any read
    failure) as "no store", removing the separate `existsSync` guard — the same fix closes the identical
    pattern in `retrieveFacts` (next row).
  - `[low]` `patch` edge-case-hunter (same root cause, merged): identical pattern in
    `src/engine/knowledge-retrieval.ts`.
  - `[low]` `patch` intent-alignment: the Problem statement's framing overclaims which "story 5-2's sweep"
    citations this story closes (see Spec Change Log above for the correction and reasoning).
  - `[false]` `reject` intent-alignment: "anchors ranked by durability" is read as requiring an active
    ranking mechanism (comparing/weighting anchors by their `ANCHOR_KINDS` order). Refutation: the existing,
    pre-existing codebase (predating this story) already treats that order as a fixed taxonomy/documentation
    ordinal, never as runtime comparison logic — `resolveKnowledge` does not use it either. This story's
    `anchorResolution` checking only the two most-durable, checkable kinds is consistent with that existing
    precedent, not a new narrowing invented for this story.
  - `[false]` `reject` intent-alignment: "the sweep that flags anchors no longer resolving" is read as a
    single verb ("flags") that should apply uniformly, but `sweepProfileKnowledge` actively retires while
    `sweepConsolidatedKnowledge` only reports. Refutation: this asymmetry is deliberate and already reasoned
    in the spec's own Boundaries — `profile.toml` is rewritable configuration this codebase already rewrites
    atomically, while `consolidated.jsonl` is append-only by the same discipline as `events.jsonl`; the
    stronger action for the rewritable store is not a contradiction of the softer one for the append-only
    store.
  - `[false]` `reject` intent-alignment: "wherever a remembered thing is checkable it becomes a lint rule or
    regression test instead of a retrieval" is not implemented as an active lint-rule/test-generation
    mechanism anywhere in this diff. Refutation: this sentence is `memory-design.md`'s system-wide design
    philosophy for where to invest across all of stage 5, not a mandate that every individual memory story
    build a code-generation mechanism — no lint-rule-generation exists anywhere in this codebase at any stage,
    and inventing one here would be substantial, unscoped, unrequested new machinery well beyond "a sweep and
    a retrieval budget."

## Auto Run Result

Status: done
Blocking condition: none

**Summary:** Closed the AD-16-retirement half of "story 5-2's sweep" (three pre-existing in-code
citations) with `sweepProfileKnowledge` — unions `resolveKnowledge`'s existing contradiction detection
with a new, conservative anchor-resolution check, and retires the union from `profile.toml` by rewriting
it, skipping the rewrite entirely when nothing is stale so a hand-edited file's comments survive a clean
sweep. `sweepConsolidatedKnowledge` runs the same anchor check against L3's append-only
`consolidated.jsonl` but only reports, never rewrites. `retrieveFacts` gives L3 the reader it never had:
a plain per-feature entry-count budget, most-recent-first, filtered by declared area. Decay-policy-driven
expiry, hit-count tracking/promotion, and `api-symbol`/`test-name` anchor resolution are explicit,
documented scope boundaries — not gaps discovered later.

**Files changed:**
- `src/engine/knowledge-sweep.ts` (new) — `anchorResolution`, `sweepProfileKnowledge`,
  `sweepConsolidatedKnowledge`, `ProfileSweepScopeRefused`.
- `src/engine/knowledge-retrieval.ts` (new) — `retrieveFacts`.
- `src/engine/consolidation.ts` — `orchHomeOf` and `readConsolidatedStore` exported (deduplicating three
  byte-for-byte-identical private copies across the three files) and made `ENOENT`-safe.
- `src/runtime/commands.ts`/`src/installer/write.ts`/`src/runtime/index.ts` — `writeFileIfChanged`/
  `WriteDisposition` relocated to `src/runtime/commands.ts` (the spine forbids `src/engine/` importing
  `src/installer/`), re-exported from `src/installer/write.ts` so no existing caller changed.
- `src/engine/index.ts` — re-exports both new modules.
- `tests/engine.knowledge-sweep.test.ts`, `tests/engine.knowledge-retrieval.test.ts` (new, 20 + 10 tests)
  — every I/O Matrix row, every patched fix, and the acceptance criteria.

**Review findings breakdown** (23 findings across four layers):
- **Patched (17):** `sweepProfileKnowledge` silently stripping a hand-edited profile's comments on every
  sweep even when nothing was stale (high, found independently by two layers, one of which empirically
  reproduced it); an anchor-resolution path-traversal risk via unsanitized `../` segments (medium, found
  independently by two layers, plus a related unvalidated-`repositoryPath` finding folded into the same
  fix); no guard against sweeping a run's frozen configuration snapshot (medium); triplicated read/helper
  logic across three files despite the spec's own (incorrect) claim that the duplication was necessary
  (low, found independently by two layers); a TOCTOU race between `existsSync` and `readFileSync` on the
  consolidated store (low, found independently twice); the union-retirement path never tested end-to-end
  (low); `WriteDisposition` computed but discarded (low); plus four more low-severity fixes (import
  consistency, budget-clamping documentation, a test-import style nit, and the spec's own Problem
  statement overclaiming which citations it closes).
- **Deferred (2, frontmatter `deferred`):** a read-then-write race on `profile.toml` with no live caller
  yet to demonstrate it against; no live declaration surface for a feature's own read budget, an explicit
  boundary of this story's deliberately-unwired scope.
- **Rejected (3, false):** "anchors ranked by durability" read as requiring active ranking logic (the
  pre-existing codebase already treats the order as a taxonomy, not runtime comparison); the "flags" vs.
  "retires" verb asymmetry between the two sweep functions (deliberate, already reasoned in Boundaries);
  the "convert to a lint rule" principle read as a per-story mandate (it is `memory-design.md`'s
  system-wide philosophy, not a requirement this specific story build code-generation machinery).

**Follow-up review recommendation:** `true`. A `high`-severity finding was patched this pass (the
comment-stripping bug), which this workflow's own rule makes sufficient regardless of confidence in the
fix. Named unverified risk: the fix was verified by me — typecheck/lint/build/full suite all green, and I
independently confirmed the early-return happens before any `serialiseToml` call, plus spot-checked the
new comment-preservation test and the path-traversal test directly — but not by a fresh independent
review pass the way the original implementation was.

**Verification performed:** `npm run typecheck`, `npm run lint`, `npm run build`, and `npm test` all pass
after the patch (107 files, 3097 tests, up from 3091 pre-patch). Directly read `sweepProfileKnowledge`'s
early-return and confirmed no `serialiseToml`/`writeFileIfChanged` call occurs on that path. Directly read
`anchorResolution`'s containment check and confirmed both paths are resolved to absolute form before
comparison. Directly read `consolidation.ts`'s `readConsolidatedStore` and confirmed the `existsSync`
check was removed in favor of a try/catch on `ENOENT` specifically.

**Residual risks:** the two deferred findings (no cross-invocation locking on `profile.toml`; no live
declaration surface for a per-feature read budget) remain open, tracked in frontmatter `deferred` for
whichever future story wires a live caller to this sweep/retrieval pair. No other residual risk
identified.
