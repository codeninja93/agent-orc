---
title: 'Measurement — rework, deflection, interruptions, usage, trust record'
type: 'feature'
created: '2026-09-24'
status: 'done'
review_loop_iteration: 1
followup_review_recommended: true
context: []
warnings: ['oversized']
deferred:
  - summary: >-
      `SHADOW_COMPARED_PAYLOAD_KEYS.RealMergeCommit` (story 3-2) is a payload-level commit SHA with no
      redaction rescue, identical in kind to the gap this story's own `head_ref_oid`/`merge_commit`
      fields needed fixing for — but it is a pre-existing 3-2 field, out of this story's scope to touch.
    evidence: |-
      Found by blind-hunter review while auditing this story's own two new payload fields. A real SHA
      scores above the AD-21 entropy pass's default threshold and `EVENT_ENVELOPE_VERBATIM_FIELDS` only
      restores top-level envelope fields, never a payload key — so `real_merge_commit` is silently
      replaced with `[redacted]` in a real run today. This story's `EVENT_PAYLOAD_VERBATIM_FIELDS`
      addition (`src/runtime/recorder.ts`) could cover it too with one more entry, once someone confirms
      that's desired for 3-2's own field.
    location: src/contracts/event.ts (SHADOW_COMPARED_PAYLOAD_KEYS)
    severity: medium
  - summary: >-
      The shadow rolling-window gate's destructive tally only ever scans graded shadow runs (ones that
      emitted `shadow.compared`); a shadow run that suppressed a destructive write but crashed or was
      abandoned before ever comparing is invisible to the zero-tolerance rule forever.
    evidence: |-
      Raised independently by edge-case-hunter and intent-alignment review, both at medium-to-low
      confidence — a narrow scenario (a permanently-abandoned shadow run), not the common path. Widening
      the window to also sweep ungraded shadow runs (detected some other way, e.g. presence of any
      `write.suppressed` line) is plausible future hardening of AD-27/CAP-21's zero-tolerance rule, not
      this story's scope.
    location: src/engine/shadow-gate.ts
    severity: low
---

<intent-contract>

## Intent

**Problem:** The stage 3 gate is judged on five signals — rework rate, deflection rate, interruption
count, usage, and a per-area trust record of merged-unchanged-vs-corrected — plus the rolling-window
shadow-gate verdict story 3-2 explicitly deferred here. Deflection rate (`src/engine/deflection-rate.ts`)
and the usage primitives (`src/contracts/usage.ts`) already exist; nothing folds a rework rate, an
interruption count, a trust record, or the shadow rolling window.

**Approach:** Each metric is a pure fold over `readonly EventEnvelope[]`, in `deflectionRate`'s own idiom
— order by `seq`, walk once, derive, never a maintained counter, and keyed by `(event.run, event.step)`
wherever step identity matters (never by step name alone — a step name is reused, identically, by every
run of a feature, so a fold keyed by name alone silently conflates two different runs' attempts the
moment more than one run's events for one feature are folded together, which is exactly the "several
runs... handed in together" case these folds document as safe). Rework and interruptions are already
durably distinguishable in the existing step-attempt vocabulary (`step.started` / `step.baseline_reset` /
`step.tier_promoted` / `step.terminated`) — no new event type. The trust record needs exactly one new
durable fact — whether the files *this run's own feature branch actually touched* landed in the merge
commit exactly as this run's worktree last held them — captured once at merge-detection time, scoped to
the run's own worktree (`plan.worktree`'s local `HEAD`, never a freshly re-queried `gh pr view` field,
which by merge-detection time may already reflect someone else's later correction to the branch) and
restricted to the paths this run's own commits touched (never a whole-tree comparison, which would also
flag unrelated `main` drift as a false correction). The shadow gate is a cross-run scan in `foldFleet`'s
own style, reading `shadow.compared` and `write.suppressed` across the fleet's shadow runs.

## Boundaries & Constraints

**Always:**
- Every fold takes `events: readonly EventEnvelope[]` plus a `feature: string` (or, for the two cross-run
  folds, a fleet of run ids) and returns a plain derived value — no maintained counter, no new durable
  state beyond the one new event this story adds. Replaying a log reproduces every number exactly.
- **Rework** is counted from the existing step-attempt vocabulary, never a new concept: a step is
  *reworked* when its final `attempts` count (one per `step.started` line folded for that `(run, step)`
  pair, exactly as `rebuild.ts`'s `StepStarted` case already counts *within one run's own `RunState`*) is
  greater than one. **The fold's internal map is keyed by `(event.run, event.step)`, never by step name
  alone** — a step name (`implement`, `verify`, ...) is identical across every run of every feature, so a
  fold keyed by name alone would report a false rework the moment two separate runs of the same feature
  (a live run and a later run that re-attempts or shadows it) are folded together, each having started
  `implement` once with no rework in either. A fresh `step.started` only follows a genuine redo —
  `step.baseline_reset` (AD-26 reset-and-rerun) or `step.tier_promoted` (model-ladder promotion) — never a
  resume, which is `step.resume_attempted` and emits no new `step.started`. `reworkRate = reworkedSteps /
  totalSteps` over the distinct `(run, step)` pairs that emitted at least one `step.started` for the
  feature; `totalSteps === 0` is `inapplicable`, matching `DeflectionRate`'s tagged union — a feature that
  never started a step has no rate, not a 0% one.
- **Interruption count** is a plain tally, not a rate: the number of `step.terminated` lines folded for the
  feature whose `disposition` payload field is `'interrupted'` (`STEP_DISPOSITIONS`, AD-8). Folded the same
  way `rebuild.ts` folds a step record — **keyed by `(event.run, event.step)`, never by step name alone**,
  for the identical reason `reworkRate` is: two different runs' `implement` steps are two different slots,
  never one shared slot that a second run's genuine first interruption could be mistaken for a redelivered
  duplicate of the first run's. Within one such slot, the current attempt's entry is overwritten by a later
  line for the same attempt, so an at-least-once-delivered duplicate line changes nothing.
- **Usage per feature** reuses `usageFromPayload` and `totalUsage` from `src/contracts/usage.ts` verbatim
  (that file's own docblock names this story as the reader). The glue is: for every `step.terminated` event
  belonging to the feature, read `event.payload[USAGE_PAYLOAD_KEY]` through `usageFromPayload`, and fold the
  results with `totalUsage`. A feature with no recorded usage anywhere gets `null` (R8 — absence is absence,
  never a zero), exactly as `totalUsage([])` already answers.
- **The trust record's "area"** is each path's first *meaningful* segment in the feature's declared
  territory (`feature.territory_declared`'s `DECLARATION_PAYLOAD_KEYS.TerritoryPaths`, already durable per
  AD-4/1-11): a leading `src` segment is stripped first (nearly every declared path starts there, so taking
  literally the first segment would put the whole repository in one area), then `firstPathSegment`
  (`src/contracts/territory.ts`'s existing, currently private, logic — exported for this reuse, not
  reimplemented) is applied to what remains, falling back to `firstPathSegment`'s own answer unchanged for a
  path that never had a leading `src` (`tests/...`, `docs/...`). `src/engine/x.ts` and `src/contracts/y.ts`
  are two different areas, `engine` and `contracts` — this project's own module boundary, which is the
  taxonomy a person actually judges trust by. A territory spanning several such areas attributes its trust
  signal to every one of them — the same any-overlap reasoning `pathsCollide` already applies to territory
  comparison, not a new single-owner taxonomy.
- **The trust record's "merged-unchanged vs corrected" signal — redesigned in this spec's own review pass
  (see Spec Change Log), replacing an unmerged approach that compared the wrong two trees.** A whole-tree
  comparison of any two commits on an active `main` is not a correction signal: `main` moves while a PR is
  open (this system runs a *fleet* of concurrent features), and a real merge commit's tree reflects
  whatever else landed on `main` between this branch's fork point and its merge, with zero relationship to
  whether a human corrected *this* PR. `src/engine/shadow.ts`'s own comparison avoids exactly this by
  pinning both sides to the same base commit; the merge-fidelity check must do the equivalent by
  **restricting the comparison to only the paths this run's own branch actually touched.**
  `checkPullRequestMerged` keeps its original `--json state,mergeCommit` shape — no `headRefOid` field,
  and `MergeCheck` gains no new field. Instead, once `check.state === 'MERGED'`, using `plan.worktree`'s
  own `git` port:
  1. `proposedHead = git rev-parse HEAD` in `plan.worktree` — **not** a freshly re-queried `gh pr view`
     field. This worktree is exclusively this run's own, untouched by anything else between this run's own
     push and merge-detection, so its `HEAD` is exactly the commit this run itself produced and pushed —
     unlike a live `gh pr view` read, which by merge-detection time may already reflect a *later* commit
     someone else pushed directly to the same branch (in which case the correction already happened
     upstream of this check and comparing against it would report a clean `unchanged` for a PR that *was*
     corrected — the opposite of the intended signal).
  2. `mergeBase = git merge-base <mergeCommit>^1 <proposedHead>` — the commit where this branch forked
     from `main`, found via the merge commit's first parent (`main`'s tip immediately before this merge),
     never via `merge-base(mergeCommit, proposedHead)` directly (which would trivially answer
     `proposedHead` itself, since `proposedHead` is already an ancestor of `mergeCommit`, telling us
     nothing about the fork point).
  3. `touchedPaths = git diff --name-only <mergeBase> <proposedHead>` — exactly the files this run's own
     commits changed, never the feature's *declared* territory (a claim, not a fact) and never the whole
     tree.
  4. `git diff --name-only <proposedHead> <mergeCommit> -- <touchedPaths...>` (an empty `touchedPaths`
     list is a no-op diff, trivially `unchanged`): a non-zero exit status is a read failure (`code`, never
     guessed); empty stdout is `unchanged`; non-empty stdout is `corrected`. Never `git diff --quiet`,
     whose exit status `1` (a real difference, not a failure) is easy to mistake for the failure case this
     rule must never guess past.
  This assumes `mergeCommit` is a real two-parent merge commit (this project's own merges are — see
  `docs/specs/spec-agent-orchestrator/stories/3-2-shadow-mode.md`'s note on 2-11/3-1's own merges); a
  merge commit with fewer than two parents (a fast-forward or squash landed by hand outside this system)
  is a read failure (`code`), never guessed at. `mergeFidelityOf`'s signature drops `headRefOid` and takes
  the worktree path directly; it fetches nothing itself — `performGitNote`'s own prior `git fetch REMOTE
  mergeCommit` (in the same call sequence, immediately before this) already brings `mergeCommit` and its
  ancestry (including its first parent) into the local object database, and `proposedHead` is always
  already local by construction. This runs exactly once per merge, at the same reconciler call site that
  already transitions a settled run from `awaiting_merge` to `committed` — **guarded by checking the run's
  own log for an existing `pull_request.merge_fidelity` line first** (this call site is re-entered every
  pass until the run leaves `awaiting_merge`, and a crash between this emit and the following
  `committed`-transition emit would otherwise re-run and re-emit a second line for the same merge; mirror
  `write-executor.ts`'s own `notePushedToRemote`-style "check before acting" idempotency discipline, not a
  new pattern).
- `tests/engine.reconciler.test.ts`'s dependency-direction guard allows same-directory (`./`) imports
  freely — only a `../` import is restricted to `../contracts/`/`../runtime/` — so none of this needs new
  cross-module wiring; it is added to `write-executor.ts` itself, not a reuse of `src/engine/shadow.ts`'s
  `compareShadowRun` (that function's job is a worktree-ref-vs-merge-commit comparison for a shadow run
  specifically, and carries its own `diff` field this story does not want).
- **The two new commit-SHA payload fields must survive the AD-21 redaction pass, and today nothing makes
  that true.** A real 40-character hex commit SHA scores above the entropy pass's default threshold (empirically
  ~3.58 bits/char at length 40, against a 3.5-bit/24-length floor — `src/runtime/redaction.ts`), so it is
  redacted like any other unbroken high-entropy string unless rescued. `EVENT_ENVELOPE_VERBATIM_FIELDS`
  (`src/contracts/event.ts`) only restores four *envelope*-level fields by name (`run`, `baseline_ref`,
  `parent_tool_use_id`, `session_id`) — it has no mechanism for a *payload* field, so a commit SHA nested
  under a payload key is not covered by it today, regardless of the field's name. (`shadow.compared`'s own
  `RealMergeCommit` payload field, story 3-2, has this identical unrescued exposure already — a pre-existing
  gap this story does not introduce and is not in scope to fix there, but it means that field is not the safe
  precedent it was cited as.) This story adds a second, payload-scoped allow-list beside
  `EVENT_ENVELOPE_VERBATIM_FIELDS` — e.g. `EVENT_PAYLOAD_VERBATIM_FIELDS = ['head_ref_oid',
  'merge_commit']` (payload key names; both are unique to this event type today, so no per-event-type
  scoping is needed) — and a payload-identity-shape check reusing `baseline_ref`'s own
  `/^[0-9a-f]{40}$/` regex verbatim, since a commit SHA is a commit SHA regardless of which field carries
  it. `src/runtime/recorder.ts`'s `preservePassthrough` restores only top-level envelope keys
  (`candidate[field]` / `restored[field] = original`) today; it needs a second pass, after the existing
  one, that walks this new list against `candidate.payload`/`redacted.payload` with the identical
  proven-pattern-free-and-identity-shaped discipline (never verbatim-or-dropped — a payload field always
  keeps what the pass produced on failure, the same "identity field" branch the four envelope fields
  already use) and writes the result into `restored.payload`. Never a shape-alone exemption applied to
  every payload field of every event — by field path, naming exactly these two, per this file's own
  stated discipline that shape alone let a real credential through once already (story 1-2).
- The merge-fidelity outcome is recorded as a new durable event, `pull_request.merge_fidelity`, carrying
  `outcome: 'unchanged' | 'corrected'`, `head_ref_oid`, and `merge_commit` — dedicated structured fields,
  not a `Detail` free-text line, matching `shadow.compared`'s `RealMergeCommit` precedent for why a raw
  commit SHA in a *named* field is fine even though `WRITE_EXECUTED_PAYLOAD_KEYS.Detail`'s own comment
  forbids one in free text. A tree-read failure (`git rev-parse` on either ref fails) records `code`
  instead of `outcome`, exactly like `SHADOW_COMPARED_PAYLOAD_KEYS.Code`'s own absent-on-success shape —
  never guessed as `unchanged`.
- The trust record itself (`src/engine/trust-record.ts`) is a cross-run fold: for every run under
  `runsDir` (via `listRunIds` + `readEventLog`, `foldFleet`'s own primitives, not `loadShellView` — this
  needs raw events, not a projected `ShellView`), join that run's `pull_request.merge_fidelity` event (if
  any) with its own `feature.territory_declared` event to attribute the outcome to every area the
  territory touches. Per area: counts of `unchanged` and `corrected`.
- **The shadow rolling-window gate** (`src/engine/shadow-gate.ts`) is the same cross-run scan. A run counts
  as a graded shadow run when its log contains a `shadow.compared` event, whether or not that line itself
  settled on an outcome (a comparison that failed and recorded only a `code` is still graded — see
  `shadow.ts`'s own "emitted once, whether the comparison succeeded or failed"). The window is the most
  recent 20 such **graded** runs (ULID order, oldest dropped first — `foldFleet`'s own "ids sort
  chronologically" fact); a shadow run that never emitted `shadow.compared` at all (crashed or was
  abandoned before comparing) has no ordinal position in this window and is never counted, even if it
  carries a `write.suppressed` line — the window is defined over graded runs, full stop, and this is the
  one respect in which the rolling window does not chase every raw shadow attempt on disk (a wider net that
  also swept in ungraded runs is plausible future hardening, not this story's scope; note it in `deferred`
  if raised in review, rather than expanding it here). Verdict fields: `runsInWindow`, `accepted`,
  `materialChange`, `destructive` (count of `write.suppressed` events with `destructive: true`, summed
  across every one of the windowed **graded** runs' own logs — "not only the ones that graded clean" is
  what this means: a run graded `material_change`, or graded with only a `code` failure, still contributes
  its own destructive count; a run outside the window, or never graded at all, contributes nothing), and
  `met: boolean` — true only when `runsInWindow >= 20`, `accepted / runsInWindow >= 0.8`, and
  `destructive === 0`. Fewer than 20 graded runs is reported as `met: false` with `runsInWindow` stating
  exactly how many exist — never padded, never `inapplicable` (this gate's whole job is to say "not yet
  enough evidence" plainly).

**Never:**
- No new maintained counter or database table for any of the five metrics or the gate — every one is
  re-derivable from `events.jsonl` alone, per AD-4.
- No change to `STEP_DISPOSITIONS`, `StepDisposition`, or `dispositions.ts`'s routing table. Rework and
  interruption both read what that vocabulary already records; neither adds a member to it.
- No semantic diffing for the trust record's tree comparison — byte-identical trees only, exactly
  `compareShadowRun`'s own restriction, for the same reason: judging whether a correction was trivial is a
  person's call, never this story's.
- No TUI surface, no web endpoint, no CLI report command for any of these five outputs. This story ships
  the fold functions and the one new event; a rendering surface is a later story's, same as
  `deflectionRate` shipped with none.
- No change to `WriteIntentSchema`, `GitNoteSchema`, `MergeCheck`'s existing fields, or the write executor's
  existing dispatch for `git_push`/`pull_request`/`git_note` intents — `checkPullRequestMerged`'s
  `--json` fields and return shape are unchanged from before this story; the new comparison is a separate
  function taking the worktree path and the confirmed `mergeCommit` directly, called only after a `MERGED`
  result.
- The shadow gate never widens to count a `write.failed` as accepted, and never treats a run with zero
  `write.suppressed` lines (nothing to have been destructive about) as automatically clean toward the
  80% bar — it is counted only via its own `shadow.compared` outcome.

## I/O & Edge-Case Matrix

| # | Input / situation | Expected |
|---|---|---|
| 1 | A feature whose every step ran once and terminated | `reworkRate`: 0 reworked / N total |
| 2 | A step reset via AD-26 (`step.baseline_reset`) then re-run to completion | Counted as reworked: two `step.started` lines for that step name |
| 3 | A step promoted via `step.tier_promoted` then re-run to completion | Counted as reworked, same mechanism as #2 |
| 4 | A step interrupted and resumed (AD-8) to completion, no reset or promotion | Not reworked — one `step.started`, a `step.resume_attempted`, one `step.terminated` |
| 5 | A feature that never started a step | `reworkRate`: `inapplicable`, not 0% |
| 6 | Two `step.terminated` lines for the same attempt (at-least-once redelivery) | Interruption count and rework both unaffected — the later line overwrites the same slot |
| 7 | A step terminated with `disposition: 'interrupted'` | `interruptionCount` includes it |
| 8 | No step ever interrupted | `interruptionCount`: 0 (a real zero, not inapplicable — absence of an event is a countable fact here, unlike deflection's raised-questions denominator) |
| 9 | A feature with `step.terminated` usage on some steps, none on others | `usagePerFeature`: sum of the recorded ones only, via `totalUsage`'s existing null-skipping |
| 10 | A feature with no usage recorded anywhere | `usagePerFeature`: `null`, never `0` |
| 11 | A merged PR whose worktree `HEAD` (`proposedHead`) matches the merge commit on every path `proposedHead` itself changed relative to its fork point | `pull_request.merge_fidelity` records `outcome: 'unchanged'` |
| 12 | A merged PR whose branch received extra commits before merging (a review fix touching a path this run's own commits also touched) | `outcome: 'corrected'` |
| 13 | `git rev-parse`/`git merge-base`/`git diff` fails at any step of the comparison, or `mergeCommit` has fewer than two parents | `code` recorded, `outcome` absent — never guessed |
| 14 | A feature whose territory is `['src/engine/x.ts', 'src/tui/y.ts']`, merged-unchanged | Trust record credits both areas, `engine` and `tui` — the leading `src` is stripped before grouping, so this is not one `src` area |
| 15 | Fewer than 20 graded shadow runs exist | Gate: `met: false`, `runsInWindow` states the real count |
| 16 | 25 graded shadow runs, 21 accepted, 0 destructive across the window | `met: true` (21/25 = 84% ≥ 80%) |
| 17 | 25 graded shadow runs, 24 accepted, 1 destructive `write.suppressed` anywhere in the window | `met: false` — zero-tolerance overrides the 96% accept rate |
| 18 | Two separate runs of the same feature slug (e.g. a live run and a later run of the same feature), each starting step `implement` exactly once with no reset/promotion/interruption in either | `reworkRate`/`interruptionCount` folded over both runs' events together report 0 reworked and 0 interrupted — never a false rework or a false interruption from the two runs' identically-named steps colliding |
| 19 | `main` advances with unrelated commits (touching files this run's branch never touched) between this run's branch fork point and the merge, while this run's own PR is merged with no correction to the files it touched | `outcome: 'unchanged'` — unrelated `main` drift outside the run's own touched paths never reports as a correction |
| 20 | The reconciler's `check-merge` pass crashes (or is otherwise re-entered) after emitting `pull_request.merge_fidelity` but before the following `committed` transition lands | The next pass finds the existing `pull_request.merge_fidelity` line for this run already recorded and does not emit a second one |
| 21 | A payload carrying a real 40-character-hex `head_ref_oid`/`merge_commit` is written to the log | Both fields survive the AD-21 redaction pass verbatim (identity-shaped, proven pattern-free), exactly like `baseline_ref` already does at the envelope level |

</intent-contract>

## Code Map

- `src/engine/deflection-rate.ts` -- the exact fold idiom every new metric here follows
- `src/contracts/usage.ts` -- `usageFromPayload`, `totalUsage`; this story supplies only the per-feature glue
- `src/contracts/step.ts` -- `STEP_DISPOSITIONS`, `RESUMABLE_STEP_DISPOSITIONS` -- read, not changed
- `src/engine/rebuild.ts` -- `ENGINE_EVENT_TYPES.StepStarted/StepTerminated/StepBaselineReset/StepTierPromoted` -- the vocabulary rework/interruption fold over; its `StepStarted` case's `attempts` counter (kept per run, inside one `RunState`) is the model to mirror, not import (this story's fold is standalone, like `deflectionRate`, not a consumer of `RunState` — but must key its own map by `(event.run, event.step)`, exactly matching that `attempts` counter never crossing a run boundary)
- `src/contracts/territory.ts` -- `normaliseTerritoryPath`, private `firstPathSegment` (export it), `DECLARATION_PAYLOAD_KEYS.TerritoryPaths`
- `src/engine/write-executor.ts` -- `checkPullRequestMerged`, `MergeCheck`/`MergeCheckPort` -- **unchanged** shape; new `mergeFidelityOf(git, worktree, mergeCommit)` beside the existing `git` port, computing `proposedHead`/`mergeBase`/`touchedPaths` per Boundaries, no `headRefOid` parameter
- `src/engine/shadow.ts` -- `compareShadowRun`'s pinned-base comparison technique, for reference only -- not imported; it pins to the parent of a *named* historical merge commit for a from-scratch shadow re-run, a different setup than reading `HEAD` out of this run's own already-built worktree, but the same underlying lesson this story's redesign applies: never compare two trees rooted at different bases
- `src/contracts/event.ts` -- add `PULL_REQUEST_MERGE_FIDELITY_EVENT_TYPE`/`PULL_REQUEST_MERGE_FIDELITY_PAYLOAD_KEYS`, beside `SHADOW_COMPARED_EVENT_TYPE`'s own shape; add `EVENT_PAYLOAD_VERBATIM_FIELDS` beside `EVENT_ENVELOPE_VERBATIM_FIELDS`
- `src/runtime/redaction.ts` -- `isHighEntropySecret`, the entropy thresholds a real commit SHA clears -- read, not changed; this is *why* the new payload fields need rescuing, not where the rescue is added
- `src/runtime/recorder.ts` -- `preservePassthrough` (restores `EVENT_ENVELOPE_VERBATIM_FIELDS` today, top-level keys only) -- extend with a second restore pass over `EVENT_PAYLOAD_VERBATIM_FIELDS` against `candidate.payload`/`redacted.payload`, same identity-shape discipline, reusing `EVENT_ENVELOPE_IDENTITY_SHAPES.baseline_ref`'s regex; also `readEventLog(logPath): EventEnvelope[]`
- `src/engine/reconciler.ts` -- the call site that already reads `checkPullRequestMerged` and transitions `awaiting_merge` → `committed`; call `mergeFidelityOf` with `plan.worktree` and `check.mergeCommit`, guard the emit against a `pull_request.merge_fidelity` line already present for this run in the events already read this pass
- `src/tui/fleet.ts` -- `foldFleet`'s primitives (`listRunIds`, `runPaths`, `runsDir`) -- reused directly by the two new cross-run folds, which read `readEventLog` instead of `loadShellView`

## Tasks & Acceptance

**Execution:**
- `src/engine/rework-rate.ts` -- new: `reworkRate(events, feature)` returning a `MeasuredReworkRate | InapplicableReworkRate` tagged union, `deflectionRate`'s own shape, keyed internally by `(event.run, event.step)` -- gives the stage-3 gate its "how often does the pipeline need a do-over" number without a new event type, safe to fold across more than one run of the same feature (row 18)
- `src/engine/interruption-count.ts` -- new: `interruptionCount(events, feature): number` -- plain tally per matrix rows 7-8, keyed internally by `(event.run, event.step)` for the same cross-run safety (row 18)
- `src/engine/feature-usage.ts` -- new: `usagePerFeature(events, feature): StepUsage | null` -- glues `usageFromPayload` + `totalUsage` per matrix rows 9-10
- `src/contracts/territory.ts` -- export `firstPathSegment` (rename export-safe if needed) -- the area-grouping primitive both the trust record and its own tests need
- `src/contracts/event.ts` -- add `PULL_REQUEST_MERGE_FIDELITY_EVENT_TYPE = 'pull_request.merge_fidelity'` and its payload keys (`Outcome`, `HeadRefOid`, `MergeCommit`, `Code`, `Detail`) to the declared vocabulary and `EVENT_TYPES`; add `EVENT_PAYLOAD_VERBATIM_FIELDS = ['head_ref_oid', 'merge_commit']`
- `src/runtime/recorder.ts` -- extend `preservePassthrough` with a second pass restoring `EVENT_PAYLOAD_VERBATIM_FIELDS` inside `payload`, reusing `EVENT_ENVELOPE_IDENTITY_SHAPES.baseline_ref`'s shape (row 21)
- `src/engine/write-executor.ts` -- `checkPullRequestMerged` unchanged; add `mergeFidelityOf(git, worktree, mergeCommit)` computing `proposedHead` (worktree `HEAD`), `mergeBase` (`mergeCommit^1` vs `proposedHead`), `touchedPaths` (`git diff --name-only mergeBase proposedHead`), and the final path-scoped `git diff --name-only proposedHead mergeCommit -- touchedPaths` comparison, per Boundaries (rows 11-13, 19)
- `src/engine/reconciler.ts` -- at the existing `awaiting_merge` → `committed` transition, call `mergeFidelityOf(git, plan.worktree, check.mergeCommit)`, guarded so a re-entered pass never emits `pull_request.merge_fidelity` twice for the same run (row 20)
- `src/engine/trust-record.ts` -- new: `trustRecord(options): TrustRecordByArea` -- cross-run fold per Boundaries
- `src/engine/shadow-gate.ts` -- new: `shadowGateVerdict(options): ShadowGateVerdict` -- cross-run fold per Boundaries
- `tests/engine.rework-rate.test.ts`, `tests/engine.interruption-count.test.ts`, `tests/engine.feature-usage.test.ts`, `tests/engine.trust-record.test.ts`, `tests/engine.shadow-gate.test.ts` -- new: one covering test per I/O matrix row, including rows 18-21; at least one test in each of `rework-rate`/`interruption-count` must use more than one distinct `run` value to actually exercise row 18
- `tests/engine.write-executor.test.ts`, `tests/engine.reconciler.test.ts` -- updated: `mergeFidelityOf`'s new signature and the main-drift/idempotency scenarios (rows 12-13, 19-20) with realistic (non-repeated-character) fixture SHAs so the redaction fix (row 21) is exercised, not accidentally bypassed by zero-entropy fixtures
- `tests/runtime.redaction.test.ts` or `tests/runtime.recorder.test.ts` (whichever already covers `EVENT_ENVELOPE_VERBATIM_FIELDS`) -- new: a real (non-repeated-character) 40-hex payload value under `head_ref_oid`/`merge_commit` survives redaction verbatim (row 21)

**Acceptance Criteria:**
- Given a feature whose steps never reset or promoted, when `reworkRate` folds its events, then every step counts as not-reworked (row 1)
- Given a step folded through `step.baseline_reset` or `step.tier_promoted` before its final `step.terminated`, when `reworkRate` folds, then that step counts as reworked (rows 2-3)
- Given a step resumed via AD-8 with no reset or promotion, when `reworkRate` folds, then it is not reworked (row 4)
- Given two separate runs of the same feature each starting `implement` once with no rework or interruption in either, when `reworkRate`/`interruptionCount` fold both runs' events together, then neither reports a false positive (row 18)
- Given a merged pull request whose worktree `HEAD` differs from the merge commit on a path the branch itself touched, when the reconciler settles the merge, then `pull_request.merge_fidelity` records `outcome: 'corrected'` (row 12)
- Given `main` advanced with unrelated changes between this run's fork point and the merge, and this run's own touched paths are unchanged in the merge, when the reconciler settles the merge, then `pull_request.merge_fidelity` records `outcome: 'unchanged'` (row 19)
- Given the reconciler's `check-merge` pass is re-entered after already recording `pull_request.merge_fidelity` for a run, when it runs again, then no second line is emitted (row 20)
- Given a real, non-repeated-character 40-character-hex value under `head_ref_oid` or `merge_commit`, when the recorder appends the line, then the value survives verbatim (row 21)
- Given fewer than 20 graded shadow runs exist on the fleet, when `shadowGateVerdict` runs, then `met` is `false` and `runsInWindow` states the true count (row 15)
- Given one destructive `write.suppressed` event anywhere in a 25-run shadow window with 24 accepted comparisons, when `shadowGateVerdict` runs, then `met` is `false` (row 17)

## Spec Change Log

**Round 1 review (four-layer, before any implementation change accepted as final):** the trust record's
merge-fidelity design was rewritten. The original spec compared a freshly `gh pr view`-queried
`headRefOid`'s whole tree against the merge commit's whole tree. Intent-alignment review found this
compares two trees rooted at different base states whenever `main` moves during a PR's lifetime (the
normal case for a fleet of concurrent features) — a clean, uncorrected merge would routinely report
`'corrected'` purely from unrelated `main` drift, and (found independently while triaging) a `gh
pr view`-read `headRefOid`, taken *after* merge is confirmed, already reflects any correction that
happened, making a genuine correction invisible as `'unchanged'` instead. Both defects shared one root
cause: comparing against a live, remotely-reported reference instead of this run's own already-local,
already-fixed worktree state, scoped to only the paths this run's own commits touched. Rewritten per the
Boundaries section above (`proposedHead` = worktree `HEAD`, `mergeBase` via `mergeCommit^1`, comparison
restricted to `touchedPaths`). `checkPullRequestMerged`'s `headRefOid` addition is reverted — no longer
needed. Blind-hunter's review, same round, found three further defects folded into this same amendment:
(1) the two new payload fields are silently destroyed by the AD-21 entropy pass with no rescue mechanism,
(2) the merge-fidelity emit is not idempotent against a crash between it and the following `committed`
transition, and (3) `reworkRate`/`interruptionCount` keyed their internal folds by step name alone,
conflating two different runs of the same feature — all three fixed per the Boundaries text above (rows
18-21). **Kept unchanged, confirmed correct by review:** the shadow gate's window/destructive arithmetic,
`usagePerFeature`, the trust record's area taxonomy and multi-area crediting, and the
interruption-count/rework-rate distinction between a genuine redo and an AD-8 resume — none of these
needed amendment; only their docblocks and matrix rows gained the run-scoping and windowing wording
already reflected above.

## Review Triage Log

### 2026-09-24 — Review pass (round 1)
- verdicts: 18 findings — high 4, medium 4, low 10, false 0, maybe-false 0 — routed 12 patch, 4 reject, 2 defer
- findings:
  - `[high]` `patch` `reworkRate`/`interruptionCount` key their internal per-step fold state by step name alone, never `(run, step)` — a step name (`implement`, `verify`, ...) is identical across every run of every feature, so folding two separate runs' events together for one feature reports a false rework (two runs each starting `implement` once, with no rework in either, reads as `attempts.get('implement') === 2`) or a false non-interruption (a second run's genuine first interruption reads as a redelivered duplicate of the first run's). Both folds' own docblocks explicitly invite multi-run combination, in `deflectionRate`'s own words — but `deflectionRate` is safe doing this because it keys by a globally-unique `questionId`, not a name reused identically across runs. — Verified directly: `event.run` exists on `EventEnvelope` (`src/contracts/event.ts:509`), and both `src/engine/rework-rate.ts` and `src/engine/interruption-count.ts` key their `Map`s by `event.step` only. Found independently by edge-case-hunter and blind-hunter. Patched: both folds now key by `(event.run, event.step)`; spec's Boundaries/Code Map/Tasks amended (row 18).
  - `[high]` `patch` `bad_spec` The merge-fidelity comparison compared the wrong two trees. Comparing `headRefOid`'s whole tree against `mergeCommit`'s whole tree measures whether `main` moved between this branch's fork point and its merge — near-guaranteed for a fleet of concurrent features — not whether a human corrected this PR: a clean, uncorrected merge routinely reports `'corrected'` from unrelated `main` drift alone. Additionally (found independently while triaging this finding), reading `headRefOid` fresh from `gh pr view` *after* the merge is already confirmed means it can already reflect a correction that happened before this check ever ran, making a genuine correction invisible as `'unchanged'` — the opposite of the intended signal. — Verified directly via git semantics: a merge commit's tree is a three-way merge of both parents against their common ancestor, so any unrelated change on `main`'s side shows up in the diff regardless of this branch's own content; and `gh pr view`'s `headRefOid` is a live, remotely-reported value with no guarantee it still names what *this run* proposed. Found by intent-alignment (the main-drift half); the stale-read half found independently during my own triage of the same finding. This is the spec's own design defect, not an implementer error — the implementer followed the letter faithfully. Fixed via a `bad_spec` loopback: the spec's Boundaries/Approach/Code Map/Tasks/Matrix rewritten to compare `plan.worktree`'s own local `HEAD` (never a re-queried remote field) restricted to only the paths this run's own commits touched (never the whole tree) — see Spec Change Log.
  - `[high]` `patch` The two new payload fields (`head_ref_oid`, `merge_commit`) are silently destroyed by the AD-21 redaction pass, with no rescue mechanism, contradicting the spec's own stated reason for using dedicated structured fields ("a replay needs the two oids to reconstruct what was compared"). A real 40-character hex commit SHA scores ~3.58 bits/char, above the pass's default 3.5-bit/24-length threshold, so it is redacted like any other unbroken high-entropy string; `EVENT_ENVELOPE_VERBATIM_FIELDS` only restores four *envelope*-level fields by name and has no mechanism reaching into `payload`. Every test exercising this used a repeated-character fixture SHA (`'a'.repeat(40)`), Shannon entropy 0, which never trips the heuristic — masking the gap. — Verified empirically (`node -e` computing real SHA-1 entropy: 3.58 bits/char, above threshold) and by reading `src/contracts/event.ts`'s `EVENT_ENVELOPE_VERBATIM_FIELDS`/`src/runtime/recorder.ts`'s `preservePassthrough`, confirming both operate on top-level envelope keys only. Found by blind-hunter. Patched: a new `EVENT_PAYLOAD_VERBATIM_FIELDS` allow-list and a second `preservePassthrough` restore pass over `payload`, reusing `baseline_ref`'s own `/^[0-9a-f]{40}$/` identity shape (row 21). Noted in `deferred`: `shadow.compared`'s own `RealMergeCommit` field (story 3-2) has the identical pre-existing exposure, out of this story's scope to fix.
  - `[high]` `patch` `pull_request.merge_fidelity` can be durably emitted twice for one run. The `check-merge` reconcile action is re-entered every pass until the run leaves `awaiting_merge`; nothing gates the merge-fidelity computation-and-emit on "has this run already recorded this line," unlike the `git_note` write immediately above it in the same call site, which explicitly checks before re-adding. A crash between the merge-fidelity emit and the following `committed`-transition emit — the established crash-injection seam this file already uses throughout — leaves a line on disk, and the next pass re-emits a second one for the same merge. — Verified directly: re-read the `check-merge` case in `src/engine/reconciler.ts`, confirmed no existing-line check precedes the emit. Found by blind-hunter. Patched: the emit is now guarded against an already-recorded `pull_request.merge_fidelity` line for the run (row 20).
  - `[medium]` `patch` `mergeFidelityOf` read `headRefOid`'s tree without ever fetching it, unlike `mergeCommit` (fetched by the preceding `git_note` write). Ordinarily harmless (the head is this same worktree's own pushed tip, already local) but silently degrades to a `code` line, losing the signal, in exactly the case the trust record exists to catch — an out-of-band push to the branch after this run's own. — Verified: only two `fetch` call sites exist in the engine, neither covering `headRefOid`. Found by blind-hunter. Resolved as a side effect of the merge-fidelity redesign above: `proposedHead` is now this run's own worktree `HEAD`, always already local by construction, so there is nothing to fetch and no separate patch was needed beyond the redesign already applied.
  - `[medium]` `patch` No reconciler-level test exercises the `fidelity.outcome === null` branch of the payload-building ternary (`... ? {Code: ...} : {Outcome: ...}`) — the only reconciler test for this line always supplies a differing-trees (`corrected`) fixture, so a mutation that mishandles the null case (e.g. `fidelity.outcome ?? 'unchanged'`, exactly the "guessed as unchanged" failure the story's own docblock forbids) would ship undetected at the integration level. — Verified by reading the only existing reconciler-level merge-fidelity test and confirming it never drives a tree-read failure or a matching-trees case. Found by verification-gap. Patched: the reconciler-level test suite (rewritten anyway for the redesign above) now covers `unchanged`, `corrected`, and a `code` failure at the integration level (rows 11-13, 19).
  - `[low]` `patch` No test proves the shadow gate's `destructive` tally actually stops counting once a run falls out of the rolling window — the only destructive-write fixture places it inside the retained 20-run window, never in one of the dropped oldest runs. — Verified: read every case in `tests/engine.shadow-gate.test.ts`; confirmed no fixture exercises this. Found by verification-gap. Patched: a test with a destructive write in a dropped run, asserting it does not count.
  - `[low]` `patch` No test proves `trustRecord` credits an area once, not twice, when a territory declares two paths that land in the same area (e.g. two `src/engine/...` paths) — every existing fixture uses paths that fall into *distinct* areas. — Verified: read every case in `tests/engine.trust-record.test.ts`. Found by verification-gap and edge-case-hunter independently. Patched: a same-area two-path fixture added.
  - `[low]` `patch` No test proves the trust record's final alphabetical sort actually sorts — the one multi-area fixture happens to insert areas in already-alphabetical order, so a missing or inverted sort would still pass. — Verified: read `trustRecord`'s only multi-area test. Found by verification-gap. Patched: a fixture crediting areas out of alphabetical insertion order added.
  - `[low]` `patch` No test covers a step that is both reset (`step.baseline_reset`) and promoted (`step.tier_promoted`) before its final termination — the code is correct (three `step.started` lines still count as one reworked step, since the threshold is `> 1` not an exact count), but this specific double-signal scenario named in the Boundaries text is untested. — Verified the code is correct by reading it; verified the gap is real. Found by edge-case-hunter. Patched: a covering test added.
  - `[low]` `patch` No test covers a step interrupted, resumed (`step.resume_attempted`), then interrupted again with no genuine new attempt in between — the docblock's specific claim that this counts once, not twice, is asserted only in prose. — Verified the gap is real. Found by edge-case-hunter. Patched: a covering test added.
  - `[low]` `patch` Matrix row 6 ("a duplicate `step.terminated` line leaves rework unaffected") has no direct covering test for `reworkRate` — true by construction, since `reworkRate` never reads `step.terminated` at all, but nothing proves it. — Verified. Found by edge-case-hunter. Patched: a trivial covering test added for audit completeness.
  - `[low]` `reject` The `mergeFidelityOf` `'corrected'` branch's `detail` text is asserted for `outcome`/`code` but never for its exact wording, unlike the `'unchanged'` case. — Found by verification-gap. Rejected: `detail` is a free-text, non-machine-read line (per this story's own AD-23 discipline); pinning its exact wording in a test would be brittle prose-testing for no behavioral value.
  - `[medium]` `reject` The shadow gate's "destructive... across every shadow run in the window, not only the graded ones" wording is ambiguous between "graded runs regardless of their own outcome" (what is implemented) and "any shadow run at all, graded or not" (a broader, unimplemented reading). — Found independently by edge-case-hunter and intent-alignment, both at reduced confidence. Rejected as a code finding: the implementation already matches the coherent reading — a "window" can only be defined over runs that have an ordinal position in it, which only graded runs do. The ambiguity was in this spec's own prose, corrected directly (see Boundaries, "not only the ones that graded clean").
  - `[low]` `reject` `shadowGateVerdict({ windowSize: 0 })` degenerates to `accepted / 0 = NaN`, `met: false` — never throws, but the result is a slightly odd `NaN`-derived value baked into a boolean rather than an explicit guard. — Found by edge-case-hunter. Rejected: `windowSize` is documented as "settable only for a test," never a real caller's input; the degenerate case is harmless (never throws, never reports `met: true`) and guarding it would be defensive code against a value only this suite's own fixtures ever supply.
  - `[low]` `reject` `areaOf('src')` (a bare-directory territory path, no further segment) resolves to `''`, an unlabeled empty-string area. — Found by edge-case-hunter. Rejected: every declared territory in this codebase is a file path, never a bare top-level directory name (confirmed against every existing territory-declaring call site); this is a theoretical input this system never actually produces.
  - `[medium]` `defer` `shadow.compared`'s own `RealMergeCommit` payload field (story 3-2) has the identical AD-21 redaction exposure this story's fields needed fixing — a real merge-commit SHA there is silently redacted today too. — Found by blind-hunter while auditing this story's own new fields. Deferred: a pre-existing 3-2 gap, out of this story's scope; recorded in this story's own `deferred` frontmatter with a pointer to the fix this story already built (`EVENT_PAYLOAD_VERBATIM_FIELDS`), for whoever picks it up.
  - `[low]` `defer` The shadow gate's destructive tally never widens to a shadow run that suppressed a destructive write but crashed before ever emitting `shadow.compared` (so it never enters the graded window at all). — Found independently by edge-case-hunter and intent-alignment, both at reduced confidence — a narrow, permanently-abandoned-run scenario. Deferred: plausible future hardening of the zero-tolerance rule, not this story's scope; recorded in `deferred` frontmatter.

## Verification

Run by me, exit status captured to a variable, after the review-round patches:
`export PATH="/Users/deep/.nvm/versions/node/v24.21.0/bin:$PATH" && npm run typecheck && npm run lint &&
npm run build && npm test` — **exit 0, 2916 tests across 102 files, zero failures, zero skips**. The
implementation reached 2898/102 (verified independently before dispatching review); the review-round
patches took it to 2916/102.

**Verified by me directly in the patched code, not taken on report:**
- The critical fix: `mergeFidelityOf` (`src/engine/write-executor.ts`) now compares `plan.worktree`'s own
  local `HEAD` (`proposedHead`) against `mergeCommit`, restricted to exactly the paths
  `git diff --name-only <mergeBase> <proposedHead>` says this run's own branch touched — confirmed by
  reading the full function body: `proposedHead` is read first, `mergeCommit^2` is explicitly verified to
  exist before `mergeCommit^1` is trusted as a fork-point anchor, `touchedPaths` is computed relative to
  that anchor, and the final comparison's pathspec is exactly `touchedPaths` — never the whole tree, never
  a re-queried `gh` field. `checkPullRequestMerged`/`MergeCheck` confirmed reverted to their pre-review
  `--json state,mergeCommit` shape (`grep -rn headRefOid src/` returns nothing).
- The redaction fix: `src/runtime/recorder.ts`'s `preservePassthroughPayload` reuses
  `EVENT_ENVELOPE_IDENTITY_SHAPES.baseline_ref`'s regex and `provesPatternFree`, restoring only a
  payload value that is both proven pattern-free and shaped exactly like a commit SHA — confirmed this is
  never a shape-alone exemption by reading the dedicated test that shows a registered credential shaped
  like a SHA still gets redacted (`tests/runtime.recorder.test.ts`, "does not restore a registered
  credential that happens to satisfy the commit-SHA shape").
- The idempotency fix: the reconciler's `check-merge` case now calls `readEventLog(paths.eventLog)` and
  checks for an existing `pull_request.merge_fidelity` line before computing or emitting another —
  confirmed by reading the exact call site in `src/engine/reconciler.ts`, and independently confirmed by
  the covering test's mechanism (a `mergeFidelityGit` stub that throws if ever called, with a
  `pull_request.merge_fidelity` line already pre-seeded on disk).
- The run-scoping fix: both `src/engine/rework-rate.ts` and `src/engine/interruption-count.ts` now key
  their internal fold state by a nested `Map<run, Map<step, ...>>` rather than a single map keyed by step
  name alone — confirmed by reading both functions in full.

**Matrix Test Audit.** All 21 rows are covered by tests that ran and passed in the run above, including
this round's additions: rows 18 (two runs of one feature, both `reworkRate` and `interruptionCount`),
19 (unrelated `main` drift never reported as a correction, at both the unit level in
`tests/engine.write-executor.test.ts` and the integration level in `tests/engine.reconciler.test.ts`
driving a real `Reconciler.open()` pass), 20 (idempotent emit), and 21 (a real, non-repeated-character SHA
survives redaction). The coverage-gap patches (a destructive write in a dropped shadow-gate window run, a
same-area trust-record dedup, an out-of-order trust-record sort, a double reset-and-promote rework signal,
and an interrupt-resume-interrupt-again sequence) are all present and passing.

**Manual checks (if no CLI):** none — every behavior here is a pure fold or a git-shelling function with an
injectable port, fully exercised by the automated suite above.

## Auto Run Result

**Status: done, reviewed, one design defect caught and fixed before merge.** The stage 3 gate's five
signals are all folded, per `deflectionRate`'s own established idiom: `reworkRate`/`interruptionCount`
(`src/engine/rework-rate.ts`/`interruption-count.ts`) read the existing step-attempt vocabulary with no new
event type, keyed by `(run, step)` so folding several runs of one feature together — which their own
docblocks always intended to support — cannot conflate two runs' identically-named steps; `usagePerFeature`
(`src/engine/feature-usage.ts`) is thin glue over the usage primitives `src/contracts/usage.ts` already
built naming this story as the reader. The trust record (`src/engine/trust-record.ts`) attributes a
merged-unchanged-vs-corrected signal to the module-boundary "area" a person actually judges trust by
(`engine`, `contracts`, `tui`, ...), fed by one new durable fact — `pull_request.merge_fidelity` — captured
once at merge-detection time. The shadow rolling-window gate (`src/engine/shadow-gate.ts`) computes the
`≥20 runs / ≥80% accepted / zero destructive` verdict story 3-2 deferred here, exactly as specified from
the first pass with no code change needed in review.

**The one genuine defect this round's review caught, before any of it shipped: the original merge-fidelity
design compared the wrong two trees.** Reading a pull request's head branch fresh via `gh pr view` at
merge-detection time and comparing its whole tree against the merge commit's whole tree measures how much
unrelated activity landed on `main` during the PR's lifetime, not whether a human corrected the PR itself
— and, independently, a freshly-read head ref can already reflect a correction that happened before the
check ever runs, making a genuine correction invisible. Both defects trace to the same root cause:
comparing against a live, remotely-reported reference instead of this run's own already-fixed, already-local
worktree state, scoped to the paths that run's own commits actually touched. Caught by this round's
intent-alignment review (the main-drift half) and by my own follow-on reasoning while triaging it (the
stale-read half) — this was a defensible-looking design that quietly would have made the trust record's
headline signal mostly noise in a repository with any real merge cadence, exactly the kind of finding this
project's four-layer process exists to catch before it reaches production. Fixed via a `bad_spec` loopback:
the comparison now anchors on `plan.worktree`'s own `HEAD`, never a re-queried remote field, and is
restricted to only the paths this run's own branch touched (see Spec Change Log). Two further high-severity
defects, found by blind-hunter in the same round, were folded into the same fix: the two new payload fields
were silently destroyed by the AD-21 redaction pass (masked by every test's use of a zero-entropy repeated-
character fixture SHA), and the new event could be durably emitted twice for one run across a crash between
it and the following state transition. A third, independently found by both edge-case-hunter and
blind-hunter, was that `reworkRate`/`interruptionCount` keyed their internal state by step name alone,
silently conflating two separate runs of the same feature the moment their events were folded together —
exactly the multi-run use their own docblocks, in `deflectionRate`'s own words, claimed to support safely.

**Spec-prose corrections, not code findings.** The shadow gate's Boundaries text ("destructive... across
every shadow run in the window, not only the graded ones") was ambiguous enough that two reviewers
(edge-case-hunter, intent-alignment) independently flagged it as possibly under-implemented; the code was
already correct under the only coherent reading (a "window" is necessarily defined over runs with an
ordinal position in it, which only graded runs have), and the wording is corrected above rather than the
code changed.

**Deferred, not fixed here.** `shadow.compared`'s own `RealMergeCommit` field (story 3-2) has the identical
unrescued AD-21 exposure this story's own fields needed fixing — a pre-existing gap, out of scope to touch
in this story, recorded with a pointer to the fix this story already built. The shadow gate's destructive
tally never widens to a shadow run that suppressed a destructive write but crashed before ever grading —
a narrow, low-confidence scenario both remaining reviewers flagged, plausible future hardening rather than
a defect.

**`followup_review_recommended: true`** — four high-severity findings were patched this pass, per this
project's own standing rule that any high-severity patch round earns a look before the next story leans on
this one's output (2916/102 tests green, all patches independently re-verified by me at the code level
above).
