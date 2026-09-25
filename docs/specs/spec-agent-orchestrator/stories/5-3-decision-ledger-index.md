---
title: 'Decision ledger'
type: 'feature'
created: '2026-09-25'
status: 'done'
baseline_revision: 'f5513fad4dbb36caed6c30b5a84ea93d5c819828'
review_loop_iteration: 0
followup_review_recommended: true
context: []
warnings: []
deferred:
  - summary: >-
      buildDecisionIndex's read-existing-then-append sequence has no lock; two concurrent calls over an
      overlapping run set could each see a question id as not-yet-indexed and both append it.
    evidence: |-
      Confirmed by reading the read-then-append shape directly, found independently by two review
      layers. Real, but unreachable today: nothing calls buildDecisionIndex yet (this story's own
      explicit boundary), so there is no live or concurrent path to demonstrate the race against. A real
      guard (an exclusive-create compare-and-set, as questions.ts uses for outcome.json, or a lock)
      belongs with whichever future story gives this a live, possibly-concurrent caller — matching
      stories 5-1's and 5-2's own identical deferrals for consolidation.ts and profile.toml respectively.
    location: >-
      src/engine/decision-index.ts (buildDecisionIndex)
    severity: medium
---

<intent-contract>

## Intent

**Problem:** AD-25's decision ledger already exists and is already live: every resolved question emits a
`decision.recorded` line (`src/engine/decision.ts`), and `matchDecisionLedger`
(`src/engine/deflection.ts`) already consults it *before* a question is asked, exactly matching this
story's own description ("an answer the user gives once becomes a durable rule that later agents check
before asking again"). What both modules explicitly say is missing — `decision.ts`: "story 5-3 builds the
queryable index over these lines"; `deflection.ts`: "no table, no index, no retrieval — story 5-3 builds
the queryable index" — is that today's lookup is a linear fold: every deflection attempt re-reads and
re-parses every ledger run's *entire* `events.jsonl`, from scratch, every time. It is correct, and it does
not scale past however many runs a project accumulates.

**Approach:** One new module, `src/engine/decision-index.ts`, structured exactly like story 5-1's
`consolidation.ts`: replay `decision.recorded` lines (`decisionsInLog`, unchanged) out of new ledger runs,
append them idempotently (keyed by question id, the same field `decidedQuestionIds` already uses) to a
new durable per-project store, `ORCH_HOME/projects/<project-id>/memory/decisions.jsonl`. A second function,
`queryDecisionIndex`, reproduces `matchDecisionLedger`'s own matching semantics (newest by `resolved_at`
wins; a redacted or blank answer, or a `timeout_default` resolver, is never used) against the *indexed*
records instead of against raw event logs — the same answer, computed from a dataset that does not grow by
re-reading whole logs every time. `deflection.ts`'s live `matchDecisionLedger` is read from, not rewritten
by, this story — see Boundaries.

## Boundaries & Constraints

**Always:**
- Reuse `decisionsInLog`, `decidedQuestionIds`, `DECISION_EVENT_TYPE` (`src/engine/decision.ts`) verbatim
  to build index entries — no second definition of what a decision line is or how it is parsed.
- The index is a **derived projection reconstructable by replay** (AD-4, the same rule story 5-1's
  `consolidated.jsonl` satisfies): if `decisions.jsonl` is deleted, rebuilding it from the same ledger runs
  produces the same content. Idempotent by construction: a question id already represented in the index is
  never appended again, matching `decidedQuestionIds`' own existing idempotence key.
- `queryDecisionIndex(entries, anchor)` reproduces `matchDecisionLedger`'s exact semantics, verified by a
  direct equivalence test: given the same ledger runs, `matchDecisionLedger`'s linear fold and
  `buildDecisionIndex` + `queryDecisionIndex` in sequence agree on every case in `deflection.ts`'s own test
  suite's fixtures (newest-wins, redacted-answer exclusion, blank-answer exclusion, `timeout_default`
  exclusion, unusable-anchor refusal).
- `namesAnchor` (`src/engine/deflection.ts`) is exported (a pure addition — the function's behavior does
  not change) and reused by `queryDecisionIndex`, rather than a second whole-token matcher being written.
  Same for `QuestionAnchor`, `formatAnchor`, `isUsableAnchor` — already exported, reused unchanged.
- Storage path: `projectMemoryPath`-adjacent — add `decisionIndexPath(projectId, orchHome)` to
  `src/runtime/paths.ts`, resolving to `<projectDir>/memory/decisions.jsonl`, following
  `projectMemoryPath`'s own established pattern (AD-9) exactly. Append durably with the same
  `openSync('a')`/`writeSync`-loop/`fsyncSync` idiom `consolidation.ts` and `src/runtime/recorder.ts` use.
  Read with the same `ENOENT`-safe per-line-isolated reader story 5-2's review established
  (`consolidation.ts`'s exported `readConsolidatedStore` is the template to follow for a new, separate
  reader over this new file — this story's own store, not a shared function, since the two files hold
  different record shapes).

**Never:**
- `src/engine/deflection.ts`'s `matchDecisionLedger` is **not modified or rewired** to query the new index
  in this story. It is a live, already-tested path in the real question-asking flow (Q4/CAP-3), and
  swapping its data source is a deliberate, separate decision once the index has been proven correct in
  isolation — matching this story's own stated framing ("the one to pull forward alone if interruption
  counts become painful"), which describes a capability to reach for later, not a mandate to cut over
  immediately. `matchDecisionLedger`'s only change in this diff is exporting `namesAnchor` for reuse.
- No change to `DecisionRecord`, `decisionPayload`, `DECISION_EVENT_TYPE`, or any other part of
  `decision.ts`'s existing write path.
- No wiring of `buildDecisionIndex`/`queryDecisionIndex` into any scheduler, CLI command, or the
  reconciler's own lifecycle — matching `trustRecord`/`foldFleet`/story 5-1's `consolidation.ts`/story
  5-2's sweep-and-retrieval precedent of complete, tested, currently-unwired modules.
- No cross-repo scope (`ORCH_HOME/memory/`, story 5-4's location) — this index is per-project, like story
  5-1's `consolidated.jsonl`.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| One resolved question, one ledger run | A run with one `decision.recorded` line | Index gains one entry keyed by that question id | No error expected |
| Re-indexing the same run twice | Same run passed to `buildDecisionIndex` again | No duplicate entry (question id already present) | No error expected |
| Two decisions naming the same anchor, different runs | Both resolved, different `resolved_at` | `queryDecisionIndex` returns the newer one, matching `matchDecisionLedger`'s own newest-wins rule | No error expected |
| Newest decision's answer was AD-21-redacted | `REDACTED_FIELDS_PAYLOAD_KEY` lists `answer` | `queryDecisionIndex` finds no usable match — never falls back to an older, superseded decision | No error expected |
| Newest decision resolved by `timeout_default` | `resolver: 'timeout_default'` | Not counted as a decision; older real decisions (if any) still considered | No error expected |
| No decision anywhere names the anchor | Index has entries, none matching | `queryDecisionIndex` returns no match | No error expected |
| Equivalence against the live linear fold | Same ledger runs given to both `matchDecisionLedger` and the index path | Both report the same match (or no match) | No error expected |
| One ledger run's log is unreadable | `readEventLog` throws for one run among several | That run contributes nothing to the index; the others still index | Caught and skipped, matching `consolidation.ts`'s per-run isolation |

</intent-contract>

## Code Map

- `src/engine/decision.ts` -- `decisionsInLog`, `decidedQuestionIds`, `DECISION_EVENT_TYPE`; reused verbatim, no changes.
- `src/engine/deflection.ts` -- `QuestionAnchor`, `formatAnchor`, `isUsableAnchor` (already exported, reused); `namesAnchor` (private today — export it, no behavior change) reused by the new query function; `matchDecisionLedger` read as the equivalence template, not modified.
- `src/engine/consolidation.ts` -- `readConsolidatedStore`/`orchHomeOf` read as the exact structural template for this story's own reader/writer (not imported — this story's store holds a different record shape, so it gets its own small reader/writer pair built the same way, not a shared one).
- `src/runtime/paths.ts` -- add `decisionIndexPath(projectId, orchHome)`, beside `projectMemoryPath`.
- `src/runtime/recorder.ts` -- durable-append idiom, reused.
- `src/engine/decision-index.ts` (new) -- `DecisionIndexEntry`, `buildDecisionIndex`, `queryDecisionIndex`.

## Tasks & Acceptance

**Execution:**
- `src/engine/deflection.ts` -- export `namesAnchor` -- the one reuse this story needs from the live module, a pure addition.
- `src/runtime/paths.ts` -- add `decisionIndexPath` -- the new store's location, per AD-9.
- `src/engine/decision-index.ts` -- add `DecisionIndexEntry`, `buildDecisionIndex(runIds, projectId, options)` -- replays and idempotently appends.
- `src/engine/decision-index.ts` -- add `queryDecisionIndex(entries, anchor)` -- the pure, in-memory query reproducing `matchDecisionLedger`'s semantics.
- `tests/engine.decision-index.test.ts` (new) -- every I/O Matrix row, including a direct equivalence test against `matchDecisionLedger` over shared fixtures.

**Acceptance Criteria:**
- Given a project with several ledger runs, when `buildDecisionIndex` runs twice over an overlapping
  run-id set, then the index contains exactly one entry per resolved question, never duplicated.
- Given two decisions naming the same anchor with different `resolved_at` instants, when
  `queryDecisionIndex` runs, then it returns the one with the later instant, exactly as
  `matchDecisionLedger` would.
- Given a redacted-answer or `timeout_default`-resolved newest decision naming an anchor, when
  `queryDecisionIndex` runs, then it reports no usable match, never falling back to an older one.
- Given the same set of ledger runs, when both `matchDecisionLedger` (existing) and
  `buildDecisionIndex`+`queryDecisionIndex` (new) are run against every fixture in
  `tests/engine.deflection.test.ts` that exercises the `decision_ledger` source, then both report the same
  verdict.
- Given `src/engine/deflection.ts`'s `matchDecisionLedger` function body, when this story's diff is
  applied, then it is unchanged except for `namesAnchor` gaining an `export` keyword.

## Verification

**Commands:**
- `npm run typecheck` -- expected: no errors
- `npm run lint` -- expected: no errors
- `npm run build` -- expected: succeeds
- `npm test` -- expected: full suite passes, including the new `tests/engine.decision-index.test.ts`

## Spec Change Log

## Review Triage Log

### 2026-09-25 — Review pass
- verdicts: 14 findings — high 0, medium 7, low 6, false 1, maybe-false 0
- findings:
  - `[medium]` `defer` edge-case-hunter (filed as a claim, high confidence): `buildDecisionIndex`'s
    read-existing-then-append sequence has no lock, so two concurrent calls over an overlapping run set
    could each see a question id as "not yet indexed" and both append it, breaking the idempotence
    guarantee. Verified the read-then-append shape directly. Real, but the same reasoning stories 5-1 and
    5-2's own concurrent-write findings used: this module is not wired into any live or concurrent path
    yet, so there is nothing to demonstrate the race against. A real guard (an exclusive-create
    compare-and-set, as `questions.ts` uses for `outcome.json`, or a lock) belongs with whichever future
    story gives this a live, possibly-concurrent caller.
  - `[medium]` `defer` blind-hunter (same root cause, merged): independently found via direct reading of
    the read-then-append shape, and noted story 5-2's own `profile.toml` race as the identical precedent.
  - `[medium]` `patch` blind-hunter: `queryDecisionIndex`'s tie-break (for two decisions sharing one
    `resolved_at`) orders by the entries array's own position, which for the live `matchDecisionLedger`
    fold is always "this call's `ledgerRuns` order" but for the persisted index is fixed forever by
    whichever `buildDecisionIndex` call first appended each entry — potentially a different order than a
    caller's `ledgerRuns`/`runIds` list. Untested, and the story's own acceptance criteria assert "the same
    verdict" without qualifying it. Verified: `matchDecisionLedger`'s own tie-break is *also*
    caller-order-dependent (not an inherent property of the decisions themselves) — this divergence is
    therefore inherited from a pre-existing characteristic of the live path, not a new flaw the index
    introduces, so "fixing" it to be more stable than what it mirrors would be scope creep, not parity.
    Action: documented this as a known, extremely-low-probability limitation (two distinct decisions
    resolving at the identical millisecond) in both functions' doc comments, and added a test proving
    equivalence holds when the index is built and queried in the same run order the live fold uses — the
    condition every other equivalence test in this suite already satisfies.
  - `[medium]` `patch` edge-case-hunter (same root cause, merged, filed as a claim at medium confidence):
    independently found via comparing the two sort implementations directly.
  - `[medium]` `patch` blind-hunter: `buildDecisionIndex`'s per-run catch swallows *any* error, whereas
    `matchDecisionLedger` only treats `EventLogCorruptError`/`UnsafePathSegmentError`/an fs-errno error as
    "unreadable" and rethrows anything else, so a real defect in a future `decisionsInLog`/`readEventLog`
    shape change isn't hidden. Initially weighed against verification-gap's own conclusion that this was a
    documented, precedented (matches `consolidation.ts`'s own bare-catch style), unreachable-today design
    choice not worth reporting — but with two further layers converging on it independently, and the fix
    being small and strictly strengthening the equivalence claim this whole module exists to make, the
    smaller fix wins. Action: exported `isUnreadableLog` from `deflection.ts` (a pure addition, same
    pattern as `namesAnchor`'s export) and used it in `buildDecisionIndex`'s per-run catch instead of a
    bare one, matching `matchDecisionLedger` exactly.
  - `[medium]` `reject` verification-gap: examined the same asymmetry and concluded it did not meet the
    bar for a reportable gap, given the module's precedent and lack of a live caller. Superseded by the
    row above once two further layers converged on it and the fix proved cheap — recorded here rather than
    silently dropped, per "never drop, merge, or silently skip" a finding.
  - `[medium]` `patch` edge-case-hunter (same root cause as the two rows above, merged, filed as a claim):
    independently found via direct comparison of the two catch blocks.
  - `[low]` `patch` blind-hunter: no exported way to read the persisted index back without calling
    `buildDecisionIndex` (which also indexes) — unlike `consolidation.ts`'s exported `readConsolidatedStore`.
    Action: exported the module's private reader too, for a caller that only wants to query, not extend,
    the index.
  - `[low]` `patch` blind-hunter: `DecisionIndexMatch` carries no `source` field, unlike `DeflectionMatch`,
    leaving no signal for whoever eventually wires this in about which deflection source it represents.
    Action: added `source: 'decision_ledger'` to the returned shape.
  - `[low]` `patch` blind-hunter: `isDecisionIndexEntry`'s payload guard accepts an array as a valid
    payload, since `typeof [] === 'object'`. Action: added an explicit `!Array.isArray(...)` check.
  - `[low]` `patch` edge-case-hunter (same root cause, merged): independently found the identical gap.
  - `[low]` `patch` blind-hunter: no test exercises `buildDecisionIndex` called with a repeated run id
    within one `runIds` array (dedup is tested only across separate calls). Action: added one.
  - `[low]` `patch` edge-case-hunter (filed as a claim, medium confidence): the story's own acceptance
    criteria say the equivalence suite runs "against every fixture in `tests/engine.deflection.test.ts`
    that exercises the `decision_ledger` source," but the new suite hand-authors its own, smaller, parallel
    fixture set instead — a real gap between what was asked for and what was delivered, since a subtly
    different hand-built fixture could pass while missing a case the original suite actually exercises
    (e.g. prefix or aspect discrimination). Action: added targeted equivalence tests for those two named
    risk cases directly (a symbol that is a prefix of another, and two aspects of one symbol), rather than
    restructuring `tests/engine.deflection.test.ts` to export shared fixture builders — a narrower,
    proportionate fix that closes the specific named risk without an invasive change to a live test file.
  - `[false]` `reject` intent-alignment: noted `docs/implementation-artifacts/sprint-status.yaml` has its
    own, unrelated "5-3" entry (an installer/half-install story) that doesn't match this story's numbering.
    Refutation: that file's other entries also don't reflect actual completed work (stories 4-4/5-1/5-2 are
    all done per git history and absent from it) — confirmed stale, orphaned, and not part of the actual
    `stories.yaml`-based process this session follows; not caused by this story and not something it
    should reconcile.

## Auto Run Result

Status: done
Blocking condition: none

**Summary:** AD-25's decision ledger was already live (`decision.ts` writes `decision.recorded` lines;
`deflection.ts`'s `matchDecisionLedger` already consults it before a question is asked) — both modules
explicitly named this story as the one that "builds the queryable index" over those lines, since the live
path re-reads and re-parses every ledger run's whole event log on every attempt. `src/engine/decision-index.ts`
adds that index: `buildDecisionIndex` replays and idempotently appends decision records (keyed by question
id) to a new per-project store; `queryDecisionIndex` reproduces `matchDecisionLedger`'s exact matching
semantics against the indexed records instead of raw logs, proven equivalent by a dedicated test suite that
runs both paths side by side over shared fixtures. `matchDecisionLedger` itself is untouched except for two
pure exports (`namesAnchor`, `isUnreadableLog`) added for reuse — swapping its data source for the index is
a deliberate, separate decision left for later, matching the unwired precedent stories 5-1/5-2 already set.

**Files changed:**
- `src/engine/decision-index.ts` (new) — `DecisionIndexEntry`, `DecisionIndexMatch`, `buildDecisionIndex`,
  `queryDecisionIndex`, `readDecisionIndex`.
- `src/engine/deflection.ts` — `namesAnchor` and `isUnreadableLog` exported (pure additions);
  `matchDecisionLedger`'s own body is unchanged except for a comment noting the shared tie-break
  limitation.
- `src/runtime/paths.ts` — `decisionIndexPath` and its file-name constant.
- `src/engine/index.ts` — re-exports the new module.
- `tests/engine.decision-index.test.ts` (new, 33 tests) — every I/O Matrix row, a 15-case equivalence
  suite against the live linear fold, and every patched fix.

**Review findings breakdown** (14 findings across four layers):
- **Patched (10):** `buildDecisionIndex`'s error handling swallowing any error instead of classifying it
  the way the live path does (medium, initially weighed against a `reject` from one layer, then patched
  once two further layers converged on it independently and the fix proved cheap); the tie-break's
  caller-order-dependence being unacknowledged and untested (medium, found independently by two layers —
  documented as a shared, pre-existing limitation of the live path rather than "fixed" into a
  more-stable-than-the-original behavior); no exported read-only accessor; no `source` field on the match
  result; an array accepted as a valid stored payload (found independently by two layers); a missing
  duplicate-run-id test; and the equivalence suite using its own fixtures rather than the exact ones the
  acceptance criteria named (closed with two targeted tests for the specific named risk — prefix and aspect
  discrimination — rather than restructuring a live test file).
- **Deferred (1, frontmatter `deferred`):** no lock on `buildDecisionIndex`'s read-then-append sequence —
  real, but unreachable with no live caller yet, matching stories 5-1's and 5-2's identical deferrals for
  their own stores.
- **Rejected (1, false):** an unrelated, stale `sprint-status.yaml` artifact using its own "5-3" numbering
  for a different story — confirmed pre-existing and orphaned, not caused by this story.

**Follow-up review recommendation:** `true`. Multiple `medium` entries were patched this pass (the
error-classification fix and the tie-break documentation/test, at minimum), well past the two-or-more
threshold this workflow's own rule sets. Named unverified risk: the patches were verified by me —
typecheck/lint/build/full suite all green, and I independently confirmed `isUnreadableLog`'s reuse, the
`source` field, the array-payload guard, and `readDecisionIndex`'s export by reading the code directly —
but not by a fresh independent review pass the way the original implementation was.

**Verification performed:** `npm run typecheck`, `npm run lint`, `npm run build`, and `npm test` all pass
after the patch (108 files, 3133 tests, up from 3126 pre-patch). Directly confirmed `matchDecisionLedger`'s
own function body is unchanged (only `namesAnchor`/`isUnreadableLog` gained `export`, and one comment was
added). Directly confirmed nothing under `src/` calls `buildDecisionIndex`/`queryDecisionIndex` outside
their own module, test, and doc-comment mentions.

**Residual risks:** the one deferred finding (no cross-invocation locking on the index's own store) remains
open, tracked in frontmatter `deferred` for whichever future story wires a live, possibly-concurrent
caller to this index. No other residual risk identified.
