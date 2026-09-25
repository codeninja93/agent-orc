---
title: 'Cross-repo pattern memory'
type: 'feature'
created: '2026-09-25'
status: 'done'
baseline_revision: '2b4d1eae9db1c4e5896b50533808c4cc17da9d98'
review_loop_iteration: 0
followup_review_recommended: true
context: []
warnings: []
deferred:
  - summary: >-
      recordPattern's durable-append idiom assumes single-writer-per-file, but patterns.jsonl is by
      design the one file every project's process appends to — a genuinely, permanently multi-writer
      file, not an incidentally-concurrent per-project one.
    evidence: |-
      Confirmed by reading recordPattern directly: it borrows consolidation.ts's/decision-index.ts's
      idiom verbatim, but those two are per-project stores that only race if one project's own pipeline
      runs concurrently with itself. patterns.jsonl's whole premise is that multiple different projects
      write to it. Real, but unreachable today: nothing calls recordPattern yet (this story's own
      explicit boundary). A real guard (a lock, or an exclusive-create-based append scheme) belongs with
      whichever future story gives this a live, genuinely multi-writer caller.
    location: >-
      src/engine/pattern-memory.ts (recordPattern)
    severity: medium
  - summary: >-
      patterns.jsonl has no size bound, and retrievePatterns does a full linear read of the whole file
      on every call; unlike a per-project store, this shared file grows across every project
      indefinitely with pruning explicitly deferred.
    evidence: |-
      memory-design.md's own stated threshold: "beyond roughly a thousand [entries] it is invalidating."
      Not reachable as an actual problem until real usage accumulates, and pruning/indexing is explicitly
      out of this story's scope. Recorded as a known future concern for whichever story adds retrieval
      hit-count tracking, promotion, or pruning for this tier.
    location: >-
      src/engine/pattern-memory.ts (retrievePatterns)
    severity: low
---

<intent-contract>

## Intent

**Problem:** CAP-19/AD-34 declare a fixed home for cross-project memory — `ORCH_HOME/memory/`, "because it
spans projects and can belong to no repository" — but nothing writes there today. Every memory store this
stage has built so far (`consolidated.jsonl`, `decisions.jsonl`) is deliberately per-project, under
`projects/<project-id>/`, anchored to that one repository's own files. A pattern learned building product A
("how we do auth") has nowhere to go that product B could ever read.

**Approach:** A new contract, `CrossRepoPattern` — a topic, an abstract prose description, and provenance
— structurally incapable of carrying a code snippet or a per-repo specific, because it has no anchor, no
file-path, and no symbol field at all (unlike `KnowledgeEntry`, whose whole shape assumes one repository's
own files). `src/engine/pattern-memory.ts` provides `recordPattern` (validate and durably append to
`ORCH_HOME/memory/patterns.jsonl`) and `retrievePatterns` (topic-filtered, budget-capped read), mirroring
story 5-2's `retrieveFacts` exactly, but reading the one shared, cross-project store rather than a
per-project one.

## Boundaries & Constraints

**Always:**
- `CrossRepoPattern` (new, `src/contracts/pattern.ts`) has exactly four fields: `topic` (a short label, the
  retrieval key), `pattern` (free prose — the abstraction itself), `sourceProjectId` (AD-10's project id,
  never a repository path, so provenance survives a repository moving or being renamed), and `recordedAt`
  (RFC3339, `TimestampSchema`). No anchor, no file path, no code field of any kind — "stores no code
  snippets and no per-repo specifics" is enforced by the schema having nowhere to put either, not by a
  content heuristic trying to detect one after the fact (a heuristic strong enough to catch real code
  reliably would also catch legitimate prose that quotes a symbol name, and one weak enough not to would
  catch nothing that mattered).
- `topic` and `pattern` are both non-blank (the same blank-refusal reasoning `KnowledgeAnchorSchema` already
  applies to an anchor: a field nothing can be retrieved by, or nothing was actually recorded, is worse than
  the field being absent).
- Storage is the fixed, shared location `ORCH_HOME/memory/patterns.jsonl` — add `memoryDir`/`patternsPath`
  to `src/runtime/paths.ts`, as AD-34's own fifth top-level `ORCH_HOME` directory (the existing comment
  there says "four"; it becomes five). Append durably with the established `openSync('a')`/`writeSync`-loop/
  `fsyncSync` idiom (`consolidation.ts`, `decision-index.ts`, `src/runtime/recorder.ts`); read with the same
  `ENOENT`-safe, per-line-isolated reader those two modules established.
- `recordPattern` is a pure, mechanical write: given an already-composed `CrossRepoPattern`, validate and
  append it. It does not decide *whether* something is pattern-worthy or compose the abstraction itself —
  that judgement has no mechanical test (unlike story 5-1's consolidation, which derives its facts entirely
  from already-structured event data) and is out of this story's scope; see Never.
- `retrievePatterns(topic, budget)` filters by exact `topic` match and returns at most `budget` entries,
  most-recent-first — the same shape story 5-2's `retrieveFacts` already established, for the same reason
  (a plain count, no tokenizer, no fuzzy ranking).

**Never:**
- No mechanism decides which prose is "abstract enough" or free of repository specifics — no model call,
  no keyword/regex content scanner. The schema's own shape (no anchor, no path, no symbol) is the whole of
  this story's enforcement; whether the *prose itself* obeys "no code snippets" is a human or a later
  story's judgement, exactly as AD-16 makes a person the reviewer of `profile.toml`'s own knowledge section.
- No wiring of `recordPattern`/`retrievePatterns` into the committer, the reconciler, a scheduler, or any
  CLI command — matching every memory module this stage has built so far
  (`trustRecord`/`foldFleet`/`consolidation.ts`/story 5-2's sweep-and-retrieval/story 5-3's index): complete,
  tested, currently uncalled by anything in `src/`.
- No decay policy, no hit-count tracking, no promotion or pruning — `memory-design.md` names these for
  every tier, but nothing in this codebase implements them for any tier yet (stories 5-1/5-2 explicitly
  deferred the same for their own stores), and inventing them here first, for the newest and
  least-populated tier, would be solving the problem in the wrong order.
- No per-project scoping of any kind on the store itself — `ORCH_HOME/memory/patterns.jsonl` is the one
  shared file every project reads and writes, which is the entire point of AD-34's fixed cross-project
  home; `sourceProjectId` is provenance on a record, never a partition of the store.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Record one pattern | Valid topic, prose, project id | Appended to `patterns.jsonl`; `recordPattern` returns it | No error expected |
| Blank topic or blank pattern | `topic: ''` or `pattern: '   '` | Refused at the schema (`CrossRepoPatternSchema.parse` throws) | Schema refusal, not a silent drop |
| Retrieval within budget | 3 patterns under one topic, `budget: 5` | All 3 returned, most-recent-first | No error expected |
| Retrieval over budget | 5 patterns under one topic, `budget: 2` | The 2 most recent returned | No error expected |
| Retrieval, no matching topic | Patterns exist under other topics | `[]` returned | No error expected |
| Retrieval, store does not exist yet | No project has ever recorded a pattern | `[]` returned | No error expected |
| One malformed line in the store | A hand-edited or corrupted line among valid ones | That line is skipped; every valid line still returns | No error expected |
| Two projects contribute to the same topic | Different `sourceProjectId`s, same `topic` | `retrievePatterns` returns both, ordered by `recordedAt`, provenance preserved per entry | No error expected |

</intent-contract>

## Code Map

- `src/contracts/knowledge.ts` -- read-only precedent for the blank-refusal reasoning `CrossRepoPatternSchema` reuses (not imported — a genuinely different shape, no anchor).
- `src/engine/consolidation.ts`, `src/engine/decision-index.ts` -- read-only structural templates for the durable-append idiom and the `ENOENT`-safe, per-line-isolated reader.
- `src/runtime/paths.ts` -- add `memoryDir(orchHome)` (AD-34's fifth top-level directory) and `patternsPath(orchHome)`; update the "four top-level directories" comment to five.
- `src/contracts/event.ts` -- `TimestampSchema`, reused for `recordedAt`.
- `src/contracts/pattern.ts` (new) -- `CrossRepoPatternSchema`, `CrossRepoPattern`.
- `src/engine/pattern-memory.ts` (new) -- `recordPattern`, `retrievePatterns`.

## Tasks & Acceptance

**Execution:**
- `src/contracts/pattern.ts` -- add `CrossRepoPatternSchema` -- four fields, two non-blank refinements, no anchor/path/symbol field of any kind.
- `src/runtime/paths.ts` -- add `memoryDir`/`patternsPath` -- AD-34's fixed, shared, cross-project location.
- `src/engine/pattern-memory.ts` -- add `recordPattern(pattern, options)` -- validates and durably appends.
- `src/engine/pattern-memory.ts` -- add `retrievePatterns(topic, budget, options)` -- topic-filtered, budget-capped, most-recent-first.
- `tests/engine.pattern-memory.test.ts` (new) -- every I/O Matrix row.

**Acceptance Criteria:**
- Given a valid `CrossRepoPattern`, when `recordPattern` runs, then it is durably appended to
  `ORCH_HOME/memory/patterns.jsonl` and nowhere else, regardless of which project recorded it.
- Given a pattern with a blank `topic` or `pattern` field, when construction is attempted, then
  `CrossRepoPatternSchema.parse` refuses it.
- Given patterns recorded by two different `sourceProjectId`s under the same `topic`, when
  `retrievePatterns` runs for that topic, then both are returned, most-recent-first, each still carrying
  its own provenance.
- Given `CrossRepoPatternSchema`'s own field list, when inspected, then it contains no field capable of
  naming a file, a line, a module, or a symbol — the schema itself is evidence the "no per-repo specifics"
  boundary holds structurally.
- Given `src/engine/reconciler.ts` and every CLI/scheduler entry point in this codebase, when this story's
  diff is applied, then none of them import `pattern-memory.ts`.

## Verification

**Commands:**
- `npm run typecheck` -- expected: no errors
- `npm run lint` -- expected: no errors
- `npm run build` -- expected: succeeds
- `npm test` -- expected: full suite passes, including the new `tests/engine.pattern-memory.test.ts`

## Spec Change Log

### 2026-09-25 — decay policy: the omission's own justification was factually wrong
intent-alignment found that this story's Boundaries claimed no decay policy was needed because "nothing in
this codebase implements them for any tier yet... this store gets none of those, the same as every other
tier this codebase has built so far." Checked directly: `KnowledgeEntrySchema` (story 5-1) requires
`decay_policy`/`decay_features` as mandatory fields, and `consolidation.ts` assigns one to every fact it
writes — the precedent is real, just narrower than claimed (`DecisionIndexEntry`, story 5-3, genuinely has
none, since it wraps an existing event payload with its own separate invalidation path). Amended:
`CrossRepoPatternSchema` gains `decayPolicy`/`decayFeatures`, mirroring `KnowledgeEntrySchema`'s own shape
and cross-field refinement exactly, matching the stronger and more applicable precedent rather than the
weaker one. Hit-count tracking and promotion/pruning remain deferred — that part of the original claim
checked out.

## Review Triage Log

### 2026-09-25 — Review pass
- verdicts: 14 findings — high 0, medium 4, low 8, false 2, maybe-false 0
- findings:
  - `[low]` `patch` blind-hunter: `sourceProjectId` has no non-blank refinement, unlike `topic`/`pattern` —
    a blank or whitespace-only value passes validation silently, undermining the story's own claim that
    provenance survives a repository moving or being renamed. Action: added the same non-blank refinement
    `topic`/`pattern` already carry.
  - `[low]` `patch` edge-case-hunter (same root cause, merged): independently found the identical gap.
  - `[medium]` `patch` blind-hunter: the blank-refusal on `topic`/`pattern` only checks `value.trim() ===
    ''`, not also `value === value.trim()` the way `KnowledgeAnchorSchema` does for its own anchor field —
    since `retrievePatterns` filters by exact string equality, a topic recorded as `' auth'` silently never
    matches a lookup for `'auth'`, a real retrieval miss with no error anywhere to surface it. Action:
    added the same trim-equality refusal `KnowledgeAnchorSchema` already uses — refusing a padded value at
    construction, never silently trimming it (this codebase's own established reason: "a schema that
    silently rewrote the value would store something other than what the file says").
  - `[medium]` `patch` edge-case-hunter (same root cause, merged, proposed a `.transform()` that trims
    instead): the underlying gap is the same as the row above; the fix taken is refusal, matching
    `KnowledgeAnchorSchema`'s own precedent, not silent normalization.
  - `[low]` `patch` blind-hunter: no documented convention establishes that `topic` matching is exact and
    case-sensitive, so two projects recording "the same" topic under different casing (`'Auth'` vs
    `'auth'`) never join on retrieval, with nothing in Boundaries warning a caller. Action: added a
    Boundaries sentence stating the convention explicitly (exact, case-sensitive match; callers choosing
    topic strings are responsible for consistency) rather than adding case-folding logic, which would be a
    real design decision (what casing wins, whether Unicode folding applies) this story does not need to
    make to close the gap — the gap is the missing documentation, not the missing normalization.
  - `[medium]` `defer` blind-hunter: `recordPattern`'s durable-append idiom assumes single-writer-per-file,
    borrowed from `consolidation.ts`/`decision-index.ts` — but unlike those two (per-project stores, racing
    only if one project's own pipeline runs concurrently with itself), `patterns.jsonl` is *by design* the
    one file every project's process appends to, which is the story's entire premise. A genuinely
    multi-writer file inheriting a single-writer idiom is a sharper version of the concurrent-write finding
    stories 5-1/5-2/5-3 each deferred for their own (per-project, only-incidentally-concurrent) stores.
    Real, but unreachable today with no live caller anywhere. Recorded distinctly from the other stories'
    versions of this finding, since "multiple projects will genuinely write here" is this store's own
    stated design, not an edge case of it.
  - `[low]` `patch` blind-hunter and verification-gap (same root cause, found independently — merged):
    `retrievePatterns`'s own doc comment documents that a negative budget clamps to `[]`, but neither a
    budget of `0` nor a negative budget is exercised by any test, unlike `retrieveFacts` (story 5-2), which
    has both. Action: added the same two tests, adapted to `retrievePatterns`.
  - `[low]` `patch` verification-gap (same root cause, merged): independently found and demonstrated the
    identical gap, including how a future refactor dropping the clamp would silently ship.
  - `[low]` `defer` blind-hunter: `patterns.jsonl` has no size bound and `retrievePatterns` does a full
    linear read of the whole file on every call; unlike a per-project store (bounded by one project's own
    activity), this file grows across every project indefinitely with pruning explicitly deferred, so
    retrieval cost for every project degrades as any single project accumulates patterns. Matches
    `memory-design.md`'s own stated threshold ("beyond roughly a thousand [entries] it is invalidating");
    not reachable as an actual problem until real usage accumulates, and pruning is explicitly out of this
    story's scope (see Never). Recorded as a known, named future concern rather than fixed now.
  - `[low]` `reject` blind-hunter: `sourceProjectId` has no format validation against AD-10's actual
    project-id convention (a first-commit SHA). Rejected: unlike `projectId` elsewhere in this codebase,
    this field is never used to construct a path (the store is not partitioned by project — the entire
    point of AD-34's shared home) — it is descriptive provenance only, and validating its shape here would
    be enforcing a convention this module has no actual use for.
  - `[low]` `reject` blind-hunter: the four-field schema has no version marker or reserved extension point
    for when a later story adds a field. Rejected: no other per-line JSONL memory record in this codebase
    carries one either (`KnowledgeEntry` lines in `consolidated.jsonl`, `DecisionIndexEntry` lines in
    `decisions.jsonl`) — AD-28's schema-version mechanism is applied at the artifact level, not the
    per-line level, for every existing store of this shape; inventing a new convention here, ahead of any
    concrete need, would be solving a problem this codebase has not chosen to solve for its siblings either.
  - `[medium]` `patch` intent-alignment: the Boundaries section's justification for omitting a decay policy
    was factually wrong (see Spec Change Log above for the correction and the fix).
  - `[false]` `reject` intent-alignment: "recorded while building one product, retrievable when building
    another" is read as requiring an actual operational path (something really writing during product A's
    work, something really reading during product B's). Refutation: this story's own Boundaries explicitly
    and self-consciously disclaim exactly this ("No wiring of `recordPattern`/`retrievePatterns` into the
    committer, the reconciler, a scheduler, or any CLI command") — matching the identical, already-accepted
    precedent of `trustRecord`/`foldFleet`/`consolidation.ts`/story 5-2's sweep-and-retrieval/story 5-3's
    index, none of which have a live caller either.
  - `[false]` `reject` intent-alignment: "stores no code snippets and no per-repo specifics" is read as
    requiring content-level enforcement (a mechanism judging whether recorded prose is genuinely
    abstract). Refutation: this story's own Boundaries explicitly reasons through and rejects a content
    heuristic ("a heuristic strong enough to catch real code reliably would also catch legitimate prose
    that quotes a symbol name, and one weak enough not to would catch nothing that mattered") in favor of
    structural enforcement (no anchor/path/symbol field exists to put either in) — a deliberate, reasoned
    choice already on the record, not an omission.

## Auto Run Result

Status: done
Blocking condition: none

**Summary:** CAP-19/AD-34's fixed home for cross-project memory — `ORCH_HOME/memory/`, "because it spans
projects and can belong to no repository" — had nothing writing to it. `CrossRepoPatternSchema`
(`src/contracts/pattern.ts`) defines the shape: six fields, structurally incapable of carrying a code
snippet or a per-repo specific (no anchor, no file path, no symbol field of any kind), reusing
`KnowledgeEntrySchema`'s own decay-policy vocabulary once review corrected a factually wrong claim that no
tier had one. `src/engine/pattern-memory.ts`'s `recordPattern`/`retrievePatterns` mirror story 5-2's
`retrieveFacts` exactly, reading and writing the one shared store every project uses rather than a
per-project one. Complete and unwired, matching every memory module this stage has built.

**Files changed:**
- `src/contracts/pattern.ts` (new) — `CrossRepoPatternSchema`, `CrossRepoPattern`.
- `src/contracts/index.ts` — re-exports the new contract.
- `src/engine/pattern-memory.ts` (new) — `recordPattern`, `retrievePatterns`.
- `src/engine/index.ts` — re-exports the new module.
- `src/runtime/paths.ts` — `memoryDir` (AD-34's fifth top-level `ORCH_HOME` directory) and `patternsPath`.
- `tests/engine.pattern-memory.test.ts` (new, 19 tests) — every I/O Matrix row, the decay-policy
  cross-field refinement, and every patched fix.

**Review findings breakdown** (14 findings across four layers):
- **Patched (10):** a factually wrong justification for omitting a decay policy (medium — `KnowledgeEntrySchema`
  genuinely requires one; corrected by adding `decayPolicy`/`decayFeatures` mirroring it exactly); a
  missing trim-equality refusal on `topic`/`pattern` that would silently orphan a padded value from every
  future retrieval (medium, found independently by two layers); a missing non-blank refinement on
  `sourceProjectId` (low, found independently by two layers); an undocumented exact-case-sensitive topic
  matching convention (low, documentation-only); and a documented-but-untested budget-of-zero/negative-budget
  clamp (low, found independently by two layers, mirroring story 5-2's own sibling tests).
- **Deferred (2, frontmatter `deferred`):** `recordPattern`'s single-writer-per-file idiom applied to a
  file that is *by design* genuinely, permanently multi-writer (every project's process appends here) — a
  sharper version of the concurrent-write finding every prior memory story in this stage deferred for its
  own, only-incidentally-concurrent store; unbounded store growth with no pruning, matching
  `memory-design.md`'s own stated scaling threshold.
- **Rejected (2 low, 2 false):** `sourceProjectId` format validation against AD-10's convention (never
  used for path construction here, unlike elsewhere); a version marker for future schema extension (no
  other per-line JSONL memory record in this codebase carries one either); and two intent-alignment
  readings requiring live wiring or content-level enforcement, both already explicit, reasoned Boundaries
  in the original spec.

**Follow-up review recommendation:** `true`. Two `medium` entries were patched this pass (the decay-policy
correction and the trim-equality refusal), meeting this workflow's own two-or-more threshold. Named
unverified risk: the patches were verified by me — typecheck/lint/build/full suite all green, and I
independently read `CrossRepoPatternSchema`'s final shape to confirm the decay cross-field refinements and
every trim/blank refusal — but not by a fresh independent review pass the way the original implementation
was.

**Verification performed:** `npm run typecheck`, `npm run lint`, `npm run build`, and `npm test` all pass
after the patch (109 files, 3156 tests, up from 3149 pre-patch). Directly confirmed nothing under `src/`
imports `pattern-memory.ts` outside its own module and re-export.

**Residual risks:** the two deferred findings (genuinely multi-writer concurrency with no lock; unbounded
store growth with no pruning) remain open, tracked in frontmatter `deferred` for whichever future story
wires a live caller or adds retrieval hit-count tracking for this tier. No other residual risk identified.
