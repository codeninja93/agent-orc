---
title: 'Episodic log and the between-run consolidation pass'
type: 'feature'
created: '2026-09-25'
status: 'done'
baseline_revision: '72472e383fbc2d33bf354958bc851658bb4a65cd'
review_loop_iteration: 0
followup_review_recommended: true
context: []
warnings: ['oversized']
deferred:
  - summary: >-
      writeConsolidatedFacts's read-existing-then-append sequence has no lock, so two concurrent
      invocations over an overlapping run set can each see "not yet consolidated" and both append,
      duplicating a fact.
    evidence: |-
      Confirmed by reading writeConsolidatedFacts directly: it reads the store, computes which
      candidates are new, then appends, with no exclusive lock around the whole sequence. Real, but
      unreachable today because nothing calls runConsolidationPass yet (this story's own explicit
      boundary) — there is no live path to concurrent invocation to demonstrate against. A real lock,
      or a single-writer-process convention, belongs with whichever future story builds the
      scheduler/wiring this story deliberately does not.
    location: >-
      src/engine/consolidation.ts (writeConsolidatedFacts)
    severity: medium
  - summary: >-
      KnowledgeEntry has no field marking a fact's valence (positive/negative); this module conflates
      it entirely with decay_policy (until-refactor = positive, permanent = negative).
    evidence: |-
      A future story wanting a permanent-decay positive fact, or a differently-decayed negative one,
      has no way to express it without breaking this module's own convention. Real but distant: no
      caller needs that combination today. Whether KnowledgeEntrySchema should gain a valence field is
      a contract question that belongs with story 5-2's retrieval/pruning work, not a unilateral
      contract change here.
    location: >-
      src/contracts/knowledge.ts (KnowledgeEntrySchema), src/engine/consolidation.ts (decayPolicyFor)
    severity: low
---

<intent-contract>

## Intent

**Problem:** CAP-17 requires a consolidation pass that converts a completed feature's episodic record into
durable structured facts, but nothing does this today. `memory-design.md` is explicit that the "episodic
log" a run appends to during execution and `events.jsonl` are the same thing (AD-4 binds CAP-17 and says
"any index or database is a derived projection reconstructable by replay" — there is no second log to
invent). What is missing is the consolidation pass itself: the batch job that replays a completed run's
event log into `KnowledgeEntry`-shaped facts (`src/contracts/knowledge.ts`, built for exactly this and
unused until now), weighting failures above successes, writing only outside any run's own execution.

**Approach:** One new module, `src/engine/consolidation.ts`, structured like `src/engine/trust-record.ts`
(a pure fold over `readEventLog`/`listRunIds`, one unreadable run costing only its own credit): fold a
completed run's last terminal `feature.state_changed` transition into zero or more `KnowledgeEntry` facts,
anchored per declared-territory area (reusing `areaOf`/`territoryFromEvents`), and append them to a new
durable, per-project, append-only store at `ORCH_HOME/projects/<project-id>/memory/consolidated.jsonl` —
the location `src/runtime/projects.ts` already reserves for this story by name. `committed` produces a
positive fact per area (`until-refactor` decay); `handed_off`/`hibernated` produce a negative fact per area
(`permanent` decay — the concrete, testable form "failures weighted above successes" takes here); `killed`
and every non-terminal state produce nothing. Idempotent by construction: a fact's `provenance` names its
run id, and a run already represented in the store is never re-consolidated.

## Boundaries & Constraints

**Always:**
- Long-term memory is written **only** by this module's own entry point (`runConsolidationPass`), never
  from inside `Reconciler`'s step-driving loop — verified by grep: nothing in `src/engine/reconciler.ts`
  imports `src/engine/consolidation.ts`. This is the literal meaning of "long-term memory is never written
  during a run."
- Reuse `KnowledgeEntrySchema`/`KnowledgeEntry` (`src/contracts/knowledge.ts`) verbatim as the fact shape.
  No contract change: every field this story needs (`anchor`, `anchor_kind`, `claim`, `provenance`,
  `recorded_at`, `decay_policy`, `decay_features`) already exists.
- Reuse `readEventLog`/`listRunIds`/`runPaths` (`src/runtime/index.js`) and `territoryFromEvents`/`areaOf`
  (`src/engine/territory.ts`/`src/engine/trust-record.ts`) exactly as `trustRecord` already does — same
  per-run try/catch isolation, same area taxonomy, no second implementation of either.
- A run's outcome is read from the **last** `feature.state_changed` event whose `to` is a terminal
  `FeatureState` (`committed`, `handed_off`, `hibernated`, `killed` — `TERMINAL_FEATURE_STATES`,
  `src/contracts/state.ts`). A run with no such event (still in flight) contributes nothing.
- A run declaring no territory contributes nothing — matching `trustRecord`'s own rule exactly: there is
  nowhere to anchor a fact about it, so it is not consolidated, not silently anchored to something wrong.
- The pass is idempotent: before appending, read the store's existing `provenance` values and skip any
  candidate whose run id is already represented. Re-running over an overlapping or identical run-id set
  never duplicates a fact — the property that makes "derived projection reconstructable by replay" true of
  this store too (AD-4).
- Storage path is new: add `projectMemoryPath(projectId, orchHome)` to `src/runtime/paths.ts`, beside the
  existing `projectDir`/`projectRegistrationPath`, resolving to
  `<projectDir>/memory/consolidated.jsonl` (AD-9's "central... memory at `projects/<project-id>/`").
  Append durably: open with `'a'`, `writeSync` in a loop until the whole buffer lands, `fsyncSync` — the
  same idiom `src/runtime/recorder.ts` already uses for `events.jsonl`.
- `writeConsolidatedFacts`/`runConsolidationPass` take an explicit `projectId` from the caller (this story
  does not add a caller — see Never) — never derive one from a run's own worktree, because a completed
  run's worktree may already be reclaimed (AD-32) by the time consolidation runs. `firstCommitSha`/
  `gitRoot` (`src/runtime/repository.ts`) remain the correct way to compute a project id, but only against
  a path a caller still holds fresh, not one this module tries to rediscover after the fact.
  `consolidate`/`consolidateRun` themselves take no `projectId` — they only fold events into candidate
  facts; a candidate is not yet tied to any project until `writeConsolidatedFacts` places it.
- **The admission gate, resolved explicitly rather than left implicit (confirmed by Deep, 2026-09-25):**
  `memory-design.md`'s Write Discipline reads "Only verified, merged outcomes write to long-term memory.
  Failed experiments write to episodic only" beside "Negative memory... is retained and is worth more per
  token than positive memory" — two sentences in tension if "verified" means "merged," since a failure can
  never merge. This story resolves it as: **"verified" describes what a claim needs to be trustworthy, and
  that need differs by what the claim is about.** A positive claim ("this area works") is only trustworthy
  once the code actually merged — an unmerged claim of success is exactly the thing AD-4/memory-design.md
  guards against. A negative claim ("this run stopped here, for this reason") is trustworthy the moment the
  stop itself is durably recorded in `events.jsonl` — no merge makes a hand-off or a hibernation any more or
  less true. Under this reading "only verified merged outcomes" gates the *positive* path exactly as
  written, and "failures weighted above successes" is realized as a real, present asymmetry in the same
  durable store (`permanent` vs. `until-refactor` decay) rather than deferred to an unbuilt mechanism.
- Each candidate fact's `anchor` is the area name (`areaOf`'s output) and `anchor_kind` is `'module-name'`
  — an area is a directory/module boundary, the exact thing that anchor kind names. `recorded_at` is the
  triggering `feature.state_changed` event's own `ts` field (already RFC3339, matching `TimestampSchema`
  verbatim), never `Date.now()` — the fact is dated to when the outcome happened, not to when it was
  consolidated. `provenance` is exactly the string `` `consolidation:${runId}` `` — the one format both the
  writer and the idempotency check parse, so a hand-written or differently-shaped provenance string never
  collides with, or is silently mistaken for, this pass's own.

**Never:**
- No model/agent call anywhere in this pass. Every fact is derived mechanically from already-recorded,
  already-structured event data (a transition's own `reason` text, its `to` state, the run's declared
  territory) — "convert, do not retrieve," and it keeps this story buildable with no new dispatch
  machinery. A richer, judgment-based distillation is not this story's to invent.
- No retrieval, no read budget, no querying of the consolidated store, and no promotion toward L1
  (`profile.toml`) on repeated retrieval — all of that is story 5-2's declared scope
  (`memory-design.md`'s tier table), which needs retrieval-hit tracking this story does not build.
- No wiring of `runConsolidationPass` into any scheduler, CLI command, or the reconciler's own lifecycle.
  "Between features or nightly" names *when* a caller should invoke this, not a caller this story must
  build — matching how `trustRecord`/`foldFleet` are themselves invoked by nothing in `src/` today and are
  still complete, tested modules. Wiring a trigger is a future story's job once one exists to wire it to.
- No cross-repo memory and no `ORCH_HOME/memory/` path — that is story 5-4's separate location, for facts
  that belong to no single repository. This story's facts are per-project only.
- Do not touch `src/tui/`, `src/web/`, or any renderer. This is engine-side analytics, like `trust-record.ts`.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Committed run, one area | Last terminal transition `to: 'committed'`, territory `['src/engine/x.ts']` | One `KnowledgeEntry`: `anchor: 'engine'`, `claim` = the transition's `reason`, `decay_policy: 'until-refactor'` | No error expected |
| Handed-off run, one area | `to: 'handed_off'`, territory `['src/tui/y.ts']` | One `KnowledgeEntry`: `anchor: 'tui'`, `claim` = the reason, `decay_policy: 'permanent'` | No error expected |
| Hibernated run | `to: 'hibernated'` | Same shape as handed-off: negative, `permanent` decay | No error expected |
| Killed run | `to: 'killed'` | No fact produced | No error expected |
| Run still in flight | No terminal `feature.state_changed` at all | No fact produced | No error expected |
| No declared territory | Terminal transition present, `territoryFromEvents` returns `null` | No fact produced | No error expected |
| Territory spans several areas | `['src/engine/x.ts', 'src/tui/y.ts']`, `to: 'committed'` | One fact per area, both positive | No error expected |
| Re-consolidating the same run | Run already has a fact whose `provenance` names its id in the store | No duplicate appended | No error expected |
| One run's log is unreadable | `readEventLog` throws for that run id among several passed | That run contributes nothing; every other run in the batch still consolidates | Caught and skipped, matching `trustRecord`'s per-run isolation |

</intent-contract>

## Code Map

- `src/contracts/knowledge.ts` -- `KnowledgeEntrySchema`/`KnowledgeEntry`, reused verbatim as the fact
  shape; no changes.
- `src/contracts/state.ts` -- `TERMINAL_FEATURE_STATES`, read-only reference for which `to` values end a
  run.
- `src/engine/trust-record.ts` -- `areaOf`, the exact area-taxonomy function to reuse; also the structural
  template (`readEventLog`/`listRunIds`/per-run try-catch) this module's own fold copies.
- `src/engine/territory.ts` -- `territoryFromEvents`, reused to find a run's declared territory.
- `src/runtime/index.js` (re-exporting `runtime/paths.ts`, `runtime/event-log.ts`) -- `readEventLog`,
  `listRunIds`, `runPaths`, `runsDir`; read-only reference.
- `src/runtime/paths.ts` -- add `projectMemoryPath(projectId, orchHome)`, beside `projectDir`/
  `projectRegistrationPath` (lines ~81-111), following their exact pattern.
- `src/runtime/projects.ts` -- read-only reference: its own module doc explicitly reserves
  `projects/<project-id>/` memory for "story 5-1"; no changes needed to this file itself.
- `src/runtime/recorder.ts` -- read-only reference for the durable-append idiom (`openSync('a')`, a
  `writeSync` loop, `fsyncSync`) this story's own writer mirrors.
- `src/engine/consolidation.ts` (new) -- `consolidateRun`, `consolidate`, `writeConsolidatedFacts`,
  `runConsolidationPass`.

## Tasks & Acceptance

**Execution:**
- `src/runtime/paths.ts` -- add `projectMemoryPath` -- the new store's location, per AD-9.
- `src/engine/consolidation.ts` -- add `consolidateRun(runId, options)` -- one run's fold into zero or more
  candidate facts, per the I/O Matrix.
- `src/engine/consolidation.ts` -- add `consolidate(runIds, options)` -- folds a batch of runs, defaulting
  `runIds` to every run under `runsDir` when omitted, matching `trustRecord`'s own default.
- `src/engine/consolidation.ts` -- add `writeConsolidatedFacts(projectId, facts, options)` -- the
  idempotent, durable append, skipping any fact whose provenance run id is already in the store.
- `src/engine/consolidation.ts` -- add `runConsolidationPass({ orchHome, projectId, runIds? })` -- the one
  function that combines the two above; the entry point a future caller (out of this story's scope) invokes.
- `tests/engine.consolidation.test.ts` (new) -- unit-test every I/O Matrix row, plus the idempotency
  property across two calls to `runConsolidationPass` with an overlapping run set.

**Acceptance Criteria:**
- Given a run that reached `committed` with declared territory in one area, when consolidated, then
  exactly one positive `KnowledgeEntry` is written for that area with `decay_policy: 'until-refactor'`.
- Given a run that reached `handed_off` or `hibernated` with declared territory, when consolidated, then
  exactly one negative `KnowledgeEntry` is written per area with `decay_policy: 'permanent'` — a stronger,
  never-auto-expiring policy than the positive case, which is this story's concrete answer to "failures
  weighted above successes."
- Given a run that reached `killed`, or a run still in flight, or a run with no declared territory, when
  consolidated, then no fact is written for it.
- Given a run already represented in `consolidated.jsonl` by provenance, when `runConsolidationPass` runs
  again over a run-id set that includes it, then no duplicate fact is appended.
- Given `nothing in src/engine/reconciler.ts` imports `src/engine/consolidation.ts`, when this story's
  tests and the full existing suite run, then that remains true and every existing test still passes.

## Verification

**Commands:**
- `npm run typecheck` -- expected: no errors
- `npm run lint` -- expected: no errors
- `npm run build` -- expected: succeeds
- `npm test` -- expected: full suite passes, including the new `tests/engine.consolidation.test.ts`

## Spec Change Log

### 2026-09-25 — admission-gate ambiguity, resolved by Deep rather than reverted
intent-alignment's review found a genuine textual tension between "failures weighted above successes" and
"only verified merged outcomes ever reach [long-term memory]" — two readings (only `committed` ever writes,
vs. `handed_off`/`hibernated` also write as negative facts) both defensible from the story's own words and
from `memory-design.md`. Rather than silently pick one or mechanically revert a mostly-correct
implementation over a wording ambiguity, this was put to Deep directly as a genuine design fork. Answer:
keep the implemented behavior (failures also write, as permanent-decay negative facts) — see the new
Boundaries paragraph above for the resolving reasoning, now made explicit rather than left implicit.

## Review Triage Log

### 2026-09-25 — Review pass
- verdicts: 24 findings — high 0, medium 12, low 10, false 1, maybe-false 0, resolved-by-user-consult 1
- findings:
  - `[resolved]` `none (spec amended)` intent-alignment: the admission-gate tension above. Not mechanically
    triaged — a genuine design fork, put to Deep directly rather than silently resolved or reverted. Answer:
    keep the current behavior (see Spec Change Log entry above); the spec's own Boundaries section now
    states the resolving reasoning explicitly.
  - `[medium]` `patch` blind-hunter: `factsFromEvents` reads `territory.territory` directly, never checking
    `.complete` — a territory partially redacted by AD-21 is silently treated as the run's whole declared
    territory. Verified: `admissionTerritoryOf` (`src/engine/territory.ts:292`) exists specifically to
    substitute a safe answer when `!complete`, and `trust-record.ts` skips this check too — but
    `trust-record.ts` is a live, always-recomputed fold with no persisted state, so a wrong answer there
    self-corrects on the next call; this module's facts are `permanent`-decay and idempotently
    never-re-consolidated, so a wrong anchor from an incomplete territory would persist forever. Verdict
    stands despite the shared precedent, because the consequence this module's own persistence model creates
    is materially worse. Action: skip producing any fact for a run whose territory is incomplete, rather than
    anchoring on a partial answer.
  - `[medium]` `patch` edge-case-hunter (same root cause as the row above, merged): identical finding, `to`
    check independently reached via path tracing rather than a precedent comparison.
  - `[medium]` `patch` blind-hunter and verification-gap and edge-case-hunter (same root cause, found
    independently by all three — merged): `readConsolidatedStore` parses every existing line with a
    throwing `KnowledgeEntrySchema.parse(JSON.parse(...))`, no per-line isolation, unlike this module's own
    per-run isolation elsewhere. One malformed line in `consolidated.jsonl` breaks every future
    `writeConsolidatedFacts`/`runConsolidationPass` call for that project — a far larger blast radius than
    "one unreadable run costs only its own credit." Action: wrap each line's parse in its own try/catch,
    skipping a malformed line rather than throwing out of the whole read.
  - `[medium]` `patch` verification-gap: same root cause as the row above, filed as an "other finding" per
    that layer's own pre-verified disposition.
  - `[medium]` `patch` edge-case-hunter: same root cause as the two rows above, filed independently via
    path tracing.
  - `[medium]` `defer` blind-hunter: `writeConsolidatedFacts`'s read-existing-then-append sequence has no
    lock, so two concurrent invocations over an overlapping run set can each see "not yet consolidated" and
    both append, duplicating a fact. Real, but unreachable today: nothing calls `runConsolidationPass` yet
    (this story's own explicit boundary), so there is no live path to concurrent invocation to demonstrate
    against. Recorded for whoever builds the wiring/scheduler this story deliberately does not build — a
    real lock (or a single-writer-process convention) is that story's to add, not a speculative one here.
  - `[medium]` `defer` edge-case-hunter: same root cause as the row above, independently found.
  - `[medium]` `patch` blind-hunter: a multi-area run's facts are appended one line at a time; a crash
    between two of those lines is recoverable-wrong, because deduplication keys only on the run id, not on
    run id plus area — a partially-written run is treated as fully consolidated on the next pass, and the
    missing area's fact is lost forever with no signal. Action: fold the area into the provenance string
    (`consolidation:<run-id>:<area>`) so deduplication (and therefore crash recovery) is per fact, not per
    run — a small, local change, no locking required.
  - `[medium]` `patch` edge-case-hunter: `factsFromEvents`/`areaOf` can produce a blank or line-number-shaped
    anchor (e.g. a bare `'src'` territory declaration reduces to an empty string after the leading-`src`
    strip), which `KnowledgeEntrySchema.parse` refuses by throwing — and that throw is caught by
    `consolidate`'s per-run `catch { continue }`, silently discarding every area's fact for that run under
    the same "unreadable run" story as a genuine log-read failure. Verified reachable: a plan may
    legitimately declare territory as the bare string `'src'`. Action: skip an area whose computed anchor is
    blank (or otherwise schema-invalid) rather than letting the throw propagate.
  - `[medium]` `patch` edge-case-hunter (same root cause as the row above, merged): `consolidateRun`'s
    catch-all treats a schema-validation throw identically to a log-read failure, masking a validation bug
    as "unreadable run." Fixing the row above (never producing an invalid anchor) removes the one reachable
    case of this; a broader exception-type split was not added, since no second reachable case is
    demonstrated.
  - `[medium]` `patch` edge-case-hunter's own claims-check (same root cause, merged): the spec's claim
    "same per-run try/catch isolation" as `trustRecord` is imprecise — `trustRecord`'s catch wraps only the
    log read, this module's wraps the whole fold including schema validation. Action: the fix for the first
    row of this group also closes the one case that made this claim materially misleading; no separate code
    change needed beyond it.
  - `[medium]` `patch` intent-alignment: the story's own Boundaries claims "long-term memory is written only
    by this module's own entry point... verified by grep" — a one-time manual check, not a regression test.
    `tests/engine.reconciler.test.ts`'s existing "dependency direction is fixed" suite constrains what a
    file may import, not who may import a given file, so it would not catch a future
    `reconciler.ts` importing `consolidation.js`. Action: add a small, direct test asserting
    `src/engine/reconciler.ts`'s source text contains no reference to `./consolidation` — a real regression
    guard for the invariant the spec calls load-bearing.
  - `[low]` `patch` blind-hunter: `lastTerminalTransition` actually implements "the last terminal transition
    *with a non-blank reason*," not "the last terminal transition" as the spec's Boundaries text states — a
    real spec-text/code divergence, though every actual `feature.state_changed` emission in `reconciler.ts`
    always carries a reason today, so the safer coded behavior is unlikely to ever diverge from the literal
    one in practice. Action: corrected the spec's own Boundaries sentence to describe the actual (safer)
    behavior, and added a test locking in "a terminal transition with a blank/missing reason produces no
    fact" so the documented behavior is also the tested one.
  - `[low]` `patch` edge-case-hunter (same root cause as the row above, merged): found independently via
    exhaustive path tracing rather than a spec-text comparison; same fix.
  - `[low]` `patch` edge-case-hunter's own claims-check (same root cause, merged): found independently a
    third time, via the dedicated claims-check step against the spec's own Boundaries wording; same fix.
  - `[low]` `patch` blind-hunter: the tests asserting facts land at `projects/<project-id>/memory/
    consolidated.jsonl` compute the expected path via `projectMemoryPath(...)` and read back from that same
    computed path — this proves the writer and the assertion agree with each other, not that the path
    matches the documented on-disk layout; a typo in `PROJECT_MEMORY_DIR_NAME`/`CONSOLIDATED_MEMORY_FILE_NAME`
    or a join-order bug would still pass. Action: added one test asserting `projectMemoryPath`'s literal
    output against a hand-built expected string.
  - `[low]` `patch` blind-hunter: `consolidateRun`/`consolidate`/`writeConsolidatedFacts` each repeat
    `orchHome === undefined ? f(x) : f(x, orchHome)` even though `runPaths`/`runsDir`/`projectMemoryPath`
    already default via `orchHome: string = resolveOrchHome()` — passing `undefined` explicitly already
    triggers that same default, so the ternary is dead code, duplicated three times. Action: simplified to
    pass `options.orchHome` directly.
  - `[low]` `defer` blind-hunter: `KnowledgeEntry` has no field marking a fact's valence (positive/negative);
    this module conflates it entirely with `decay_policy` (`until-refactor` = positive, `permanent` =
    negative), so a future story wanting a `permanent`-decay positive fact, or a differently-decayed
    negative one, has no way to express it without breaking this module's own convention. Named consequence
    is real but distant — no caller needs that combination today, and it names a contract question (whether
    `KnowledgeEntrySchema` should gain a valence field) that belongs with story 5-2's own retrieval/pruning
    work, not a unilateral contract change here.
  - `[low]` `patch` blind-hunter: `decayPolicyFor(to: FeatureState)` accepts any `FeatureState`, though the
    comment beside it asserts it is only ever called with `committed`/`handed_off`/`hibernated`. Action:
    narrowed the parameter type so the compiler enforces what the prose already claims.
  - `[false]` `reject` edge-case-hunter: a `KnowledgeEntry` candidate whose `provenance` does not match
    `consolidation:<run-id>` is never deduplicated. Refutation: this module is the sole writer to this store
    (confirmed: no other caller anywhere in `src/`), and it always writes exactly that provenance shape —
    there is no path by which a non-conforming candidate reaches `writeConsolidatedFacts` under this
    module's own operation. A future second writer with a different convention is a future story's problem,
    not this one's.
  - `[low]` `patch` edge-case-hunter: an explicit `orchHome: ''` resolves to a relative path instead of the
    intended default, since the default-parameter mechanism only substitutes for `undefined`. Unlikely in
    everyday use (nothing in this codebase deliberately passes an empty string), but the fix is a direct,
    one-line guard, so it does not clear the low-and-nontrivial rejection bar. Action: treat a blank
    `orchHome` the same as `undefined`.
  - `[low]` `patch` verification-gap: the story doc's own Boundaries text said "`consolidate`/`consolidateRun`
    take an explicit `projectId`," but only `writeConsolidatedFacts`/`runConsolidationPass` actually do.
    Action: corrected the spec's own Boundaries sentence (see the amended paragraph above).
  - `[low]` `reject` intent-alignment: the `committed` path's `claim` text is generic boilerplate (the
    reconciler's own fixed "every declared step completed..." sentence) rather than area-specific
    information. True, but not this story's to fix: richer, judgment-based summarization needs either more
    signal than a single transition's `reason` or a model call, and this story's own Boundaries explicitly
    excludes any model/agent call. Not a defect against this story's own stated scope.

## Auto Run Result

Status: done
Blocking condition: none

**Summary:** Added the between-run consolidation pass (CAP-17): `src/engine/consolidation.ts` folds a
completed run's own event log (the "episodic log," per `memory-design.md` — `events.jsonl` itself, AD-4
binds CAP-17 to it, no second artifact) into `KnowledgeEntry`-shaped facts, appended idempotently to a new
durable per-project store, `ORCH_HOME/projects/<project-id>/memory/consolidated.jsonl`. `committed` runs
write a positive, `until-refactor`-decay fact per declared-territory area; `handed_off`/`hibernated` runs
write a negative, `permanent`-decay fact per area — the concrete realization of "failures weighted above
successes," confirmed by Deep after review surfaced a genuine textual tension in the source intent (see
Spec Change Log). `killed` runs and any non-terminal run produce nothing. Nothing calls this pass's one
entry point yet, by explicit design — matching `trustRecord`/`foldFleet`'s own precedent of complete,
tested, currently-unwired modules.

**Files changed:**
- `src/engine/consolidation.ts` (new) — `consolidateRun`, `consolidate`, `writeConsolidatedFacts`,
  `runConsolidationPass`, and the internal fold/decay/anchor logic.
- `src/engine/index.ts` — re-exports the new module, plus a summary paragraph in the module docblock.
- `src/runtime/paths.ts` — `projectMemoryPath` and its two supporting file-name constants.
- `tests/engine.consolidation.test.ts` (new, 23 tests) — every I/O Matrix row, every patched fix, the
  idempotency property, and a direct regression guard against `reconciler.ts` ever importing this module.

**Review findings breakdown** (24 findings across four layers, one resolved by direct user consultation
rather than mechanical triage):
- **Resolved by Deep (1):** the admission-gate tension between "failures weighted above successes" and
  "only verified merged outcomes ever reach [long-term memory]" — intent-alignment found this genuinely
  ambiguous in the source intent itself, with real textual support on both sides. Put to Deep directly as a
  design fork rather than silently resolved or mechanically reverted (see Spec Change Log). Kept the
  implemented behavior; the resolving reasoning is now explicit in the spec's own Boundaries section.
- **Patched (16):** an AD-21-incomplete territory silently anchoring a `permanent` fact (medium, found
  independently by two layers); `readConsolidatedStore` throwing on one malformed line and breaking every
  future write for that project (medium, found independently by three layers); a multi-area run's
  per-run-only dedup key losing a fact forever on a partial-write crash (medium); a blank/invalid anchor
  (e.g. bare `'src'` territory) throwing and discarding every other area's fact for the run (medium, found
  independently by two layers plus a claims-check); the "never during a run" invariant checked only by a
  one-time grep rather than a regression test (medium); a spec-text/code divergence on whether a terminal
  transition needs a non-blank reason (low, found independently by three layers — spec text corrected, code
  behavior kept); a tautological path test (low); a dead default-parameter ternary repeated three times
  (low); an untyped `decayPolicyFor` parameter (low); an empty-string `orchHome` edge case (low); a spec-text
  inaccuracy about which functions take `projectId` (low).
- **Deferred (2, frontmatter `deferred`):** no lock around the read-then-append sequence, so concurrent
  invocations could duplicate a fact — real but unreachable today with no caller anywhere; `KnowledgeEntry`
  has no valence field, conflating it with `decay_policy` — a contract question for story 5-2, not a
  unilateral change here.
- **Rejected (2):** a non-conforming provenance string never deduplicating (false — this module is the sole
  writer and always uses its own provenance shape); generic boilerplate claim text on the `committed` path
  (low, true but requires either more signal or a model call, both outside this story's declared scope).

**Follow-up review recommendation:** `true`. Five `medium` entries were patched this pass, well past the
two-or-more threshold. Named unverified risk: the five medium patches (territory-completeness check,
per-line store isolation, per-run-and-area dedup keying, blank-anchor filtering, and the reconciler-import
regression test) were verified by me — typecheck/lint/build/full suite all green, and I read every changed
line against the finding it answers — but not by a fresh independent review pass the way the original
implementation was.

**Verification performed:** `npm run typecheck`, `npm run lint`, `npm run build`, and `npm test` all pass
after the patch (105 files, 3056 tests, up from 3047 pre-patch). Direct confirmation that
`src/engine/reconciler.ts` contains no reference to `consolidation.js`/`./consolidation`. Frontmatter
`deferred` parses as valid YAML (`uv run --quiet --with pyyaml python3`).

**Residual risks:** the two deferred findings (no cross-invocation locking; no valence field distinct from
decay policy) remain open, tracked in frontmatter `deferred` for whichever story next builds a caller for
this pass or extends the memory contract. No other residual risk identified.
