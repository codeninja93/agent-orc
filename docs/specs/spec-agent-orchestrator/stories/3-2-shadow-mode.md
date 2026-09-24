---
title: 'Shadow mode — an ordinary run carrying mode: shadow'
type: 'feature'
created: '2026-09-24'
status: 'done'
review_loop_iteration: 1
followup_review_recommended: true
baseline_revision: 'bb3bd9e'
context:
  - '{project-root}/docs/planning-artifacts/architecture/architecture-agent-orcastrator-2026-09-19/ARCHITECTURE-SPINE.md'
  - '{project-root}/docs/specs/spec-agent-orchestrator/stories/2-11-write-surface.md'
warnings: []
deferred:
  - summary: >-
      No integration test drives `runFeatureToCompletion` itself under `mode: 'shadow'` end to end.
    evidence: |-
      Only its constituent pieces (`resolveShadowStartRef`, `compareShadowRun`, the reconciler's state
      machine) are tested in isolation. Confirmed to match `runFeatureToCompletion`'s own pre-existing,
      documented convention since story 2-11 — it has never been unit-tested directly, only proven
      against a real repository. Worth a disposable real-run demonstration (matching 2-11's own
      convention) before story 3-3 depends on this wiring.
    location: src/assembly/index.ts
    severity: low
---

# Story 3-2 — Shadow mode: an ordinary run carrying `mode: shadow`

## Intent

**Problem:** AD-27/CAP-21 need a shadow run to be live execution with writes suppressed — proving the
autonomous pipeline reproduces a real, already-shipped outcome — never a replay over past events.
Confirmed directly: `RunMode`/`RUN_MODES` already include `'shadow'` and the flag is already threaded
through `StepInput`, the container's `ORCH_RUN_MODE` env, the installer's interview, and the TUI's own
rendering (`SHADOW_MODE_NOTE`) — but `src/engine/write-executor.ts` and `src/engine/committer.ts`, the
two units AD-27 names as the only ones that must honour it, have zero mode branching today, and nothing
compares a run's output to a real historical commit.

**Approach:** Add `mode` awareness exactly where AD-27 puts it — the write executor records every
intent's `write.attempted` and still performs every read-only probe, but under `mode: 'shadow'` never
issues the mutating `git`/`gh` call, emitting `write.suppressed` in place of `write.executed`. A new
shadow-run entry point checks out the worktree at the parent of a named, already-merged feature's real
merge commit (`createWorktree`'s existing `ref` option already supports an arbitrary starting commit —
no new worktree capability needed), drives the full pipeline exactly as a live run would, and produces a
comparison report: the shadow run's resulting tree against the real merge's tree, and whether any
suppressed write intent would have been destructive. The rolling-window 80%/zero-destructive gate itself
is story 3-3's; this story produces the one raw, per-run result that gate is computed from.

## Boundaries & Constraints

**Always:**
- Every component other than the write executor and the committer behaves identically under
  `mode: 'shadow'` and `mode: 'live'` — the same agents spawn, the same gates run, the same model tiers
  apply. `plan.mode` already reaches every step's input unchanged. The one reconciler-level branch this
  story does add — routing a settled shadow run to `committed` instead of `awaiting_merge` — is not a
  second exception to this rule; it is downstream of the write executor's own suppression, the same way
  the existing `awaiting_merge` transition is already downstream of a live run's real push/PR landing.
- The write executor still performs every existing read-only probe (`git ls-remote`, `gh pr list`,
  `git notes show`) under shadow — these never mutate anything, and skipping them would make the
  destructive classification below blind rather than merely quiet. Only the mutating call itself
  (`git push`, `gh pr create`, `git notes add` + push) is skipped.
- `write.attempted` is recorded exactly as it is for a live run, unconditionally. In place of
  `write.executed`, a shadow performer records a new `write.suppressed` event carrying what the probe
  found and what would have happened — AD-15's "the engine executes exactly once" durability half still
  holds; only the "executes" half is suppressed, and the log says so explicitly rather than by absence.
- **A write intent is destructive when its own probe finds the target already exists with content
  different from what this run would produce** — reusing the exact probe mechanism 2-11 already built
  (`git ls-remote` disagreeing with the local tip for `git_push`; `gh pr list` finding an existing,
  different pull request; `git notes show` finding a different note already on the target commit) rather
  than inventing a second classification axis. A target that does not yet exist, or exists and already
  matches, is never destructive — only a real collision is. This is the zero-tolerance case the stage-3
  gate hard-fails on; this story's job is to detect and record it accurately, never to decide the gate.
- A shadow run's worktree starts at an explicit historical commit — the parent of the named real merge
  commit it is shadowing — using `createWorktree`'s existing `ref` option (`WorktreeCreateRequest.ref`,
  "the ref the new branch starts at," already defaults to `HEAD` and already accepts anything else). No
  new worktree capability is built; this story only supplies a non-default `ref`.
- The comparison report compares the shadow run's resulting worktree tree against the named real merge
  commit's tree (both relative to the same starting commit): identical trees are `accepted`; any
  difference is `material_change`, carrying the diff. Finer grading (whitespace-only, semantically
  equivalent, etc.) is explicitly out of this story's scope — see Never.
- The historical feature to shadow is named explicitly by its real merge commit (the same SHA a prior
  run's own AD-22 note would already carry) — this story does not discover or select which features to
  shadow; that bookkeeping belongs to whatever drives the rolling window (story 3-3 or later automation).
- **A shadow run never enters `awaiting_merge`.** Story 2-11's `awaiting_merge` exists because a real
  pull request needs a real human merge before the AD-22 note's real commit is known — under shadow, the
  pull request is never opened at all, so there is nothing to wait on. Once the committing step's push
  and pull-request intents are both `write.suppressed` (not `write.failed`), the run proceeds straight to
  `committed` and the comparison report is produced from what was composed, never from a merge that could
  not happen. Caught during this spec's own self-review, not left implicit: 2-11's
  `settlePreMergeWrites` returns `'awaiting-merge'` for any two settled pre-merge intents, live or shadow
  alike, and would otherwise park a shadow run forever waiting for a merge that will never come.

**Never:**
- No replay runner over `events.jsonl`. A shadow run is a real run through the real pipeline — the same
  worktree, gates, and agents a live run gets — never a re-derivation from a past run's own log.
- No semantic or fuzzy diff grading. `accepted` means byte-identical trees; anything else is
  `material_change` with the raw diff attached. Judging whether a material change is actually fine is a
  person's call (or a later story's), not this one's.
- No rolling-window computation, no 80% threshold, no gate verdict across multiple runs. This story
  produces exactly one run's comparison result; story 3-3 aggregates it.
- No change to `composeCommit`, `GitNoteSchema`, or `WriteIntentSchema`. The committer composes the same
  shape it always has; only the executor's response to what it is handed changes under shadow.
- No new worktree/checkout mechanism. `createWorktree`'s existing `ref` option is sufficient; this story
  does not add a second way to pin a starting commit.

## I/O & Edge-Case Matrix

| # | Input / situation | Expected |
|---|---|---|
| 1 | A `git_push` intent under `mode: 'shadow'` | `write.attempted` recorded; the probe runs; no real `git push`; `write.suppressed` recorded instead of `write.executed` |
| 2 | A `pull_request` intent under `mode: 'shadow'` | Same shape: probed via `gh pr list`, never `gh pr create`, `write.suppressed` recorded |
| 3 | A `git_note` intent under `mode: 'shadow'` | Probed via `git notes show`, never added or pushed, `write.suppressed` recorded |
| 4 | The same intents under `mode: 'live'` | Byte-identical behavior to before this story — every existing 2-11 test still passes unmodified |
| 5 | A shadow run's probe finds its target does not yet exist | Not destructive; the comparison report records the intent as clean |
| 6 | A shadow run's probe finds its target already exists with different content | Destructive; recorded plainly, and the run's own comparison report names it — the zero-tolerance case |
| 7 | A shadow run's resulting worktree tree matches the named real merge commit's tree exactly | Comparison report: `accepted` |
| 8 | A shadow run's resulting tree differs from the real merge commit's tree | Comparison report: `material_change`, carrying the diff |
| 9 | A shadow run's worktree is created against a named historical commit, not current `HEAD` | The worktree starts at that commit's parent, via `createWorktree`'s existing `ref` option — nothing new built at the worktree layer |
| 10 | A shadow run's committing step settles its push and pull-request intents (both `write.suppressed`) | The run transitions straight to `committed`, never `awaiting_merge` — there is no real pull request to wait on |

## Code Map

| File | Change | Why |
|---|---|---|
| `src/engine/write-executor.ts` | modify | `WriteExecutionContext` gains `mode: RunMode`; each performer keeps its probe and `write.attempted`, skips the mutating call under `'shadow'`, and records `write.suppressed` (new event) carrying the probe's own finding and a `destructive: boolean`. |
| `src/contracts/event.ts` | modify | `WRITE_SUPPRESSED_EVENT_TYPE` and its payload-key constants, registered alongside the existing `write.attempted`/`write.executed`/`write.failed` trio. |
| `src/engine/reconciler.ts` | modify | `writeExecutionContextFor` passes `plan.mode` through to the write executor. `settlePreMergeWrites`'s caller (the `advance-state` case) transitions a settled shadow run straight to `committed` rather than `awaiting_merge` — the one branch this story adds to the reconciler's own step-driving logic, since nothing else changes under shadow. |
| `src/engine/shadow.ts` | new | `compareShadowRun(shadowTreeRef, realMergeCommit, repository): ShadowComparisonReport` — the tree diff and the `accepted`/`material_change` classification. |
| `src/assembly/index.ts` | modify | `RunFeatureOptions` gains `mode` (default `'live'`, unchanged for every existing caller) and, for a shadow run, `shadowing: { realMergeCommit: string }`, which resolves the parent commit and passes it as `createWorktree`'s `ref`. |
| `tests/engine.write-executor.test.ts` | modify | Matrix rows 1–6, added alongside the existing live-mode tests without modifying them (row 4). |
| `tests/engine.shadow.test.ts` | new | Matrix rows 7, 8 — the comparison logic against real local scratch repositories. |
| `tests/assembly.test.ts` | modify | Matrix row 9 — a shadow run's worktree created at the right historical `ref`. |
| `tests/engine.reconciler.test.ts` | modify | Matrix row 10 — a shadow run reaches `committed` directly, never `awaiting_merge`, added alongside the existing live-mode `awaiting_merge` tests without modifying them. |

## Tasks & Acceptance

1. **The write executor honours `mode: 'shadow'`, and only the write executor and the committer change.**
   - **Given** any write intent under `mode: 'shadow'`, **when** the executor performs it, **then**
     `write.attempted` and the read-only probe both happen exactly as under `mode: 'live'`, and no
     mutating `git`/`gh` call is made.
   - **Given** the same intents under `mode: 'live'`, **when** run through the existing 2-11 test suite,
     **then** every test still passes unmodified.
2. **A write intent is classified destructive from its own probe result, never guessed.**
   - **Given** a probe finding no existing target, **when** the intent is recorded, **then** it is not
     destructive.
   - **Given** a probe finding an existing target with different content, **when** the intent is
     recorded, **then** it is destructive, and this is visible in `write.suppressed`'s own payload.
3. **A shadow run starts from the real historical commit it is shadowing, and produces a comparison
   report.**
   - **Given** a named real merge commit, **when** a shadow run starts, **then** its worktree is created
     at that commit's parent.
   - **Given** a completed shadow run, **when** its resulting tree is compared to the real merge commit's
     tree, **then** the report states `accepted` (identical) or `material_change` (with the diff) —
     never a third, ungraded outcome.
   - **Given** a shadow run whose push and pull-request intents both settle as `write.suppressed`,
     **when** the reconciler advances it, **then** it reaches `committed` directly, never `awaiting_merge`.

## Spec Change Log

## Review Triage Log

### 2026-09-24 — Review pass
- verdicts: 21 findings — high 6, medium 4, low 11, false 0, maybe-false 0 — routed 14 patch, 2 defer, 5 reject
- findings:
  - `[high]` `patch` **The most serious finding of this round.** `performPullRequest`'s shadow branch treats any existing pull request `gh pr list` finds as destructive, on the reasoning "a shadow run never itself opens one, so any found is foreign." That reasoning is wrong for this story's own primary use case: `branchFor` derives the branch name from the feature slug alone, never the run id, so shadowing an already-merged feature will, by construction, find that exact feature's own real, already-merged pull request on every single run and mark it destructive unconditionally — unlike the `git_push`/`git_note` performers, which correctly compare content before calling something destructive. This would make the destructive flag fire on the story's own headline scenario every time. — Verified directly against `branchFor` and the shadow branch's logic. Found independently by blind-hunter (concretely) and intent-alignment (which characterized the same code as a defensible simplification — a real bug, not a reasonable design choice, so intent-alignment's own reading is corrected here). Patched: the shadow context now carries the real merge commit being shadowed, and the found pull request is compared against it — the *expected* historical PR is not destructive; a PR that doesn't match it is.
  - `[high]` `patch` A resumed run does not reliably preserve or re-derive `mode`/`shadowing` from the run's own persisted state. `runFeatureToCompletion` already calls `reconciler.load(run)`, which carries the authoritative `plan.mode`, but the resume path's mode-dependent branches (the write-executor wiring, and whether to compute a shadow comparison) read only the caller's fresh `options`, never `loaded.plan.mode`. A caller resuming a shadow run without re-passing `mode: 'shadow'` either silently loses the shadow comparison (a correctness gap) or — the more serious framing — could route the real write executor as if the run were live, in a codebase whose entire safety property is that a shadow run never performs a real write. — Verified directly. Independently found by blind-hunter and edge-case-hunter. Patched: mode-dependent behavior on resume now reads the run's own persisted `plan.mode`, never trusting fresh caller options to re-assert what a run already durably is.
  - `[high]` `patch` The reconciler's `mode: plan.mode` wiring into the real write executor (`writeExecutionContextFor`) is never exercised by any test with the real `performWriteIntent` — every reconciler-level shadow test uses a hand-rolled stub that ignores `context.mode` entirely and reports `write.suppressed` regardless of what mode it was actually given. A regression that dropped or hardcoded `mode` at that one call site would let a shadow run perform a real push/PR/note, and no test in the suite would fail. — Pre-verified by verification-gap with exact file:line citations for both the production call site and the gap in every existing test double. Patched: a test now wires the real `performWriteIntent` (with fake `git`/`gh` calls) through a `Reconciler` under `plan.mode: 'shadow'` and asserts no mutating call is ever made.
  - `[high]` `patch` The shadow comparison report — the module's own docblock calls it "the one raw, per-run result story 3-3's rolling window is computed from" — is never durably recorded. Unlike every other write-related fact this story and 2-11 touch (`write.attempted`/`write.executed`/`write.failed`/`write.suppressed`, all emitted through the run's own log), the comparison result is only handed back as an in-memory `RunFeatureOutcome.shadowComparison` return value. A crash, a dropped return value, or any consumer that doesn't persist it immediately loses that data point for good — and story 3-3 has nothing durable to build a rolling window from. — Verified directly: confirmed no `emit` call anywhere in the comparison path. Found by blind-hunter. Patched: a new `shadow.compared` event now carries the comparison result through the run's own log.
  - `[medium]` `patch` A `git_push`/`git_note` probe that fails to read (a non-zero `git ls-remote`, or `git notes show` failing for a reason other than "note absent") is classified as clean/non-destructive under shadow, rather than as a failure — an unreadable probe carries no evidence either way, and treating it as evidence of safety is the wrong direction for a zero-tolerance destructive gate to err in. — Verified directly against both probes. Found by edge-case-hunter. Patched: an unreadable probe now records a failure under shadow, matching the discipline the live path already has for the same read failures.
  - `[medium]` `patch` `compareShadowRun`'s exception is uncaught at its call site inside `runFeatureToCompletion` — a transient `git` failure at this last step, after the run has already durably reached `committed`, rejects the whole promise and loses the entire successful `RunFeatureOutcome`. — Verified directly: no `try`/`catch` around the call. Independently found by blind-hunter and edge-case-hunter. Patched: the call is now guarded, returning the already-successful outcome with `shadowComparison: null` (and the failure durably recorded per the finding above) rather than discarding a completed run.
  - `[low]` `patch` No entry point exposes shadow mode operationally — `bin/orch-run.ts`, the only real caller of `runFeatureToCompletion`, never sets `mode`/`shadowing`, so there is no way to launch a shadow run outside calling the library function directly. — Verified directly. Found by blind-hunter. Patched: a `--shadow <merge-commit>` CLI flag added, mirroring the existing argument-parsing shape.
  - `[low]` `patch` `resolveShadowStartRef`'s `<sha>^` (first-parent) resolution has no test against a true two-parent merge commit (`git merge --no-ff`), only single-parent "squash-like" history. `<sha>^` is already well-defined git syntax for the first parent regardless of parent count, so the code is not wrong — only untested against the shape a real GitHub merge commit (like the ones this project's own stories 2-11/3-1 produced) actually has. — Verified the code is correct; verified the gap is real. Found by blind-hunter. Patched: a two-parent scratch-repo test added.
  - `[low]` `patch` `ShadowComparisonFailed`'s error message ("could not read the tree… to compare") is reused for a `git diff` failure too, even though a diff failure isn't a tree-read failure — misdescribing the actual fault when debugging. — Verified directly. Found by blind-hunter. Patched: distinct messages for the two failure shapes.
  - `[low]` `patch` `performGitNoteShadow` records a `HEAD`-read failure (needed only because a shadow run has no real merge commit to target) under the same `git.note_write_failed` code the live path uses for an actual `git notes add`/push failure, reducing the code's diagnostic value specifically for shadow runs. — Verified directly. Found by blind-hunter. Patched: a distinct code for the `HEAD`-read failure.
  - `[low]` `defer` No integration test drives `runFeatureToCompletion` itself under `mode: 'shadow'` end to end (only its constituent pieces — `resolveShadowStartRef`, `compareShadowRun`, the reconciler's state machine — are tested in isolation). — Independently found by blind-hunter and verification-gap; verification-gap confirmed this matches `runFeatureToCompletion`'s own pre-existing, documented convention (it has never been unit-tested directly since 2-11, only proven against a real repository). Deferred: consistent with this codebase's own established pattern for this function, not a new gap this story introduces alone; worth a disposable real-run demonstration (matching 2-11's own convention) before story 3-3 depends on this wiring.
  - `[low]` `reject` The story spec file is untracked and not part of the reviewed diff. — Found by blind-hunter. Rejected: expected and correct, the same reason this is rejected in every prior story's review round — blind-hunter reviews the code diff only, by design.
  - `[low]` `reject` This spec's own Problem statement and Task 1 heading name `src/engine/committer.ts` as one of the two units requiring mode-awareness, but the diff adds zero lines there — all mode branching instead lives in `src/engine/reconciler.ts`'s `settlePreMergeWrites`/`writeExecutionContextFor`. — Independently found by intent-alignment and edge-case-hunter (as a high-confidence claim). Rejected as a code finding: `composeCommit` (in `committer.ts`) is a pure value-producer with no write logic of its own, per 2-11's own design — the reconciler's orchestration of the committer's output is the correct home for this branching, and "committer" in AD-27's own text is more naturally read as the committing phase, not the specific file. The imprecision is in this spec's own prose, corrected in the Auto Run Result below.
  - `[low]` `reject` This spec's Never list and matrix row 10 describe a two-intent settlement gate (push and pull-request `write.suppressed`) before a shadow run reaches `committed`; the diff and its test implement and exercise a three-intent gate, folding `git_note` into the same pass. — Found by intent-alignment. Rejected as a code finding: a shadow run's `git_note` intent can never settle any other way, since `check-merge` (the only other path that would settle it) never fires without a real pull request — the three-intent gate is a necessary correction this spec's own two-intent wording missed, not a deviation from it. Corrected in the Auto Run Result below.
  - `[low]` `reject` `compareShadowRun` compares git tree objects (`rev-parse <ref>^{tree}`) rather than a file-level diff of a second, separately checked-out copy of the real merge commit. — Found by intent-alignment. Rejected: this works correctly because a git worktree shares its repository's object database, confirmed by the implementer's own real demonstration against story 2-11's actual merge commit; it is a sound, more efficient instantiation of what this spec's own text left intentionally unspecified, not a divergence from it.

## Design Notes

**Why destructive reuses the existing probe rather than a new check.** 2-11 already asks, for every
write, "does the target already carry something different?" before deciding whether a live run may
proceed — that is precisely the question a destructive classification needs answered. Building a second
mechanism to ask the same question a second way is exactly the kind of duplicated source of truth this
project's own stories have repeatedly found and removed; reusing the probe's own verdict makes the two
readings structurally incapable of disagreeing.

```ts
// src/engine/write-executor.ts, sketch
if (context.mode === 'shadow') {
  const destructive = probeFound !== null && probeFound.content !== expectedContent;
  return recordSuppressed(intent, context, { probeFound, destructive });
}
```

## Verification

Run by me, exit status captured to a variable and output kept in a file:
`npm run typecheck && npm run lint && npm run build && npm test` — **exit 0, 2845 tests across 97
files, zero failures, zero skips**, run a final time after the review round's patches. The
implementation reached 2837/97 (verified independently before dispatching review); the review-round
patches took it to 2845/97.

**Verified by me directly in the patched code, not taken on report:**
- The critical fix: `performPullRequest`'s shadow branch now compares the found pull request's own
  `mergeCommit.oid` (requested via `gh pr list --json number,url,mergeCommit`) against
  `context.shadowRealMergeCommit`, and is destructive only when a pull request exists and does not match
  the historical one being shadowed — confirmed by reading `existingMergeCommitOid`, the comparison
  itself, and the `gh pr list` call's updated `--json` fields.
- The resumed-run mode fix: `runFeatureToCompletion`'s resume path reads `reconciler.load(run).state.mode`
  (durable, log-folded) as authoritative, overriding a disagreeing fresh `mode`/`plan`, and throws a clear
  refusal rather than guessing when a resumed shadow run's `shadowing.realMergeCommit` is not re-supplied
  (that field is honestly not itself durably recorded, so failing loudly beats assuming).

**Matrix Test Audit.** All ten rows are covered by tests that ran and passed in the run above, including
this round's additions: a reconciler-level test wiring the *real* `performWriteIntent` (not a stub) under
`plan.mode: 'shadow'`, asserting probes ran but no mutating call ever fired; and a genuine two-parent
`git merge --no-ff` scratch-repo test for `resolveShadowStartRef`'s first-parent resolution.

**Manual checks (if no CLI):**
- Run a real shadow run against one of this repository's own already-merged stories (e.g. story 2-11's
  own real merge commit) and confirm: no branch is pushed, no PR is opened, no note is written, and the
  comparison report is produced. Safe to do without the user, since shadow mode's whole guarantee is that
  nothing is written. Performed once, informally, by the implementer during the first round (shadowing
  story 2-11's own real merge commit, confirmed via `git worktree list`/`git status` that nothing was left
  behind); not re-run after the patch round, since the patches are covered by the automated suite above.

## Auto Run Result

**Status: done, reviewed.** `mode: 'shadow'` is honoured exactly where AD-27 puts it: the write executor
records every intent's `write.attempted` and its full read-only probe, but under shadow never issues the
mutating call, recording `write.suppressed` — now durably paired with a `shadow.compared` event carrying
the comparison report, since that report is "the one raw, per-run result story 3-3's rolling window is
computed from" and needed to survive the run's own process exiting. A shadow run's worktree starts at the
parent of a named, already-merged feature's real merge commit (`createWorktree`'s existing `ref` option,
no new worktree capability), and never enters `awaiting_merge` — there is no real pull request to wait on.

**The heaviest review of this story's own arc: 21 findings, high 6, medium 4, low 11, routed 14 patch, 2
defer, 5 reject.** The most serious, and the one worth owning plainly: **`performPullRequest`'s shadow
destructive check would have fired on this story's own headline scenario, every time.** Since
`branchFor` derives a feature's branch name from its slug alone, never the run id, shadowing an
already-merged feature was guaranteed to find that exact feature's own real, already-merged pull request
— and the original logic treated any found pull request as foreign and destructive. Intent-alignment's
own audit characterized this as a defensible simplification; blind-hunter proved it was a real bug.
Fixed by threading the real merge commit being shadowed into the write executor's context and comparing
the found pull request's own merge-commit oid against it: the expected historical pull request is not
destructive, only a mismatched one is.

**Two more findings shared the same theme — the mode flag's own integrity was under-verified.** A
resumed run did not reliably re-derive `mode` from the run's own durable state, risking a shadow run
silently becoming live on resume; fixed by reading `RunState.mode` (log-folded, authoritative) rather
than trusting fresh caller-supplied options, and refusing loudly rather than guessing when a resumed
shadow run's `shadowing.realMergeCommit` isn't re-supplied (that field is honestly not itself durable).
Separately, the reconciler's `mode` wiring into the *real* write executor had zero test coverage — every
existing shadow test used a stub that ignored `context.mode` entirely, so a regression dropping the mode
flag at that one call site would have gone undetected. Both patched.

**Five more real, patched findings:** the comparison report itself was never durably recorded, only
returned in-memory, leaving story 3-3 nothing to build a rolling window from; an unreadable `git`/`gh`
probe under shadow was classified as clean rather than a failure, the wrong direction for a
zero-tolerance gate to err in; `compareShadowRun`'s own exception was uncaught, capable of losing an
already-successful run's outcome; no CLI flag exposed shadow mode operationally; and a genuine two-parent
merge commit's first-parent resolution had no test, though the code itself was already correct.

**Three findings were rejected as spec-prose issues, not code defects.** This spec's own Problem
statement named `src/engine/committer.ts` as one of the two units needing mode-awareness; the
implementation correctly put all branching in `src/engine/reconciler.ts` instead, since `composeCommit`
is a pure value-producer with no write logic of its own — the imprecision was mine. This spec's own
Never list and matrix row 10 described a two-intent settlement gate (push, pull-request); the
implementation correctly folds `git_note` into the same gate for shadow runs, since it can never settle
any other way — again my own wording, not a deviation from it. And the comparison mechanism (git tree
objects, not a second checked-out copy) is a sound, more efficient reading of what this spec left
intentionally unspecified, confirmed working by the implementer's own real demonstration.

**Follow-up review recommended: true.** Two `high` findings were patched, which sets this
unconditionally — in this case, six were. The specific unverified risk worth a second look, recorded in
`deferred`: no integration test drives `runFeatureToCompletion` itself under shadow mode end to end,
matching that function's own pre-existing convention since story 2-11 of being proven only against a
real repository, never unit-tested directly.

**Residual risks.** See the one-item `deferred` list in the frontmatter. Story 3-3's own rolling-window
gate now has a durable, per-run data source (`shadow.compared`) to build from, which did not exist
before this review round.
