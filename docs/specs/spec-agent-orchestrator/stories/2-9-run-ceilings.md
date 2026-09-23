---
title: 'Run ceilings — degradation at eighty percent, hibernation at the limit'
type: 'feature'
created: '2026-09-23'
status: 'done'
review_loop_iteration: 1
followup_review_recommended: true
baseline_revision: '09fcdea'
context:
  - '{project-root}/docs/planning-artifacts/architecture/architecture-agent-orcastrator-2026-09-19/ARCHITECTURE-SPINE.md'
  - '{project-root}/docs/specs/spec-agent-orchestrator/stories/2-5-implementation-agent.md'
  - '{project-root}/docs/specs/spec-agent-orchestrator/stories/2-6-testing-and-verification.md'
deferred:
- summary: 'There is still no production entry point that reaches this story''s ceiling machinery.'
  evidence: 'Confirmed by the intent-alignment layer and independently: no caller of `Reconciler.open`
    exists outside `src/engine/`, so no real run driving the real CLI can degrade or hibernate yet — every
    test drives a scripted executor through `tests/helpers/ceiling-fixture.ts`. The same "no production
    assembly point" gap already carried as a high-severity deferred entry across stories 2-4 through 2-8,
    now touching the reconciler''s ceiling surface too.'
  severity: high
- summary: 'Whether requiring a passed gate before skipping a degraded run''s model review is itself the last word.'
  evidence: 'I reverted the review-round''s item L (which skipped the review whenever no gate failed,
    including when none exist) back to requiring at least one gate to have passed, on the ground that this
    story''s own Boundaries text guarantees the deterministic gates "still gate correctness" — a guarantee
    that does not hold at zero gates. That leaves a repository declaring no gates never narrowed by
    degradation at all, which is the opposite trade-off the review round argued for. Worth a second look:
    whether the real fix is pushing such a repository toward declaring at least one gate, rather than
    this story quietly keeping its review indefinitely.'
  location: src/engine/ceilings.ts
  severity: medium
- summary: 'An agent reporting `budget.exhausted` directly still routes to `handed_off`, not `hibernated`.'
  evidence: 'The AD-35 disposition table''s existing route for that error code is unrelated to this
    story''s ceiling-triggered hibernation path, and the two remain distinct: a step reporting the code
    itself takes the ordinary hand-off route, while a ceiling the reconciler detects takes the new one.
    Named by the implementer as an honest observation in the first round, unchanged by the review round.'
  severity: medium
- summary: 'Step input files are reused across re-runs, so a re-run''s budget field can be stale.'
  evidence: 'Pre-existing behaviour (CAP-6''s input-file-reuse rule), not introduced by this story, and
    named by the implementer as an honest observation rather than a defect they introduced.'
  location: src/engine/reconciler.ts
  severity: low
- summary: 'Item F''s fix (reading the ceiling budget before any line of an attempt is recorded) has no test reaching it.'
  evidence: 'The implementer named this honestly: an unreadable snapshot at the step-input write can only
    happen after the ceiling check has already passed, and they had no way to construct that gap in a
    test. The fix is structural (the read moved earlier, closing the race by construction) rather than
    test-proven.'
  location: src/engine/reconciler.ts
  severity: low
- summary: 'Item K''s no-op fix for `escalate-to-human` on an already-`blocked` run has no test reaching it.'
  evidence: 'Named honestly by the implementer: the engine never actually produces `escalate-to-human` for
    a run that is already `blocked`, so the guard cannot be exercised by a test today. Left in as a
    documented safeguard rather than removed for being currently unreachable.'
  location: src/engine/reconciler.ts
  severity: low
- summary: '`cache_read_input_tokens` is excluded from the rate-limit count entirely, which undercounts rather than overcounts.'
  evidence: 'Closes the review''s finding that cache-heavy CLI sessions could dominate the rate-limit
    figure and degrade or hibernate ordinary runs on cache traffic. The implementer chose exclusion over a
    weighted or flagged count; named as a direction chosen, not the only one available, and unverified
    against a real cache-heavy session since no test drives the real CLI (see the production-entry-point
    entry above).'
  location: src/engine/ceilings.ts
  severity: low
- summary: 'Whether a resumed session reports its own usage or the whole session''s, and whether a killed attempt undercounts, remain unverified.'
  evidence: 'Documented in a comment on `measureConsumption` and pinned by one test for the ordinary case
    (each figure counted once, absent counted as nothing), but no resume transcript exists in this
    repository to verify the resume-reporting assumption against, and a killed attempt is confirmed to
    record zero usage by design rather than by observing a real kill.'
  location: src/engine/ceilings.ts
  severity: low
---

# Story 2-9 — Run ceilings: degradation at eighty percent, hibernation at the limit

## Intent

**Problem:** the vocabulary is declared and nothing enters it. `degraded` and `hibernated` are
`FeatureState` values whose own doc comment says "nothing enters them until AD-24's ceilings arrive in story
2-9"; `budget.degraded`/`budget.exhausted` are registered event types with no emitter. The three fields of
`StepInput.budget` are mostly placeholders today: `steps_remaining` is real, computed from the plan, but
`wall_clock_ms_remaining` is a constant and `rate_limit_budget_consumed` is hardcoded to `0` — nothing tracks
elapsed time or consumption against either ceiling.

**Approach:** track the three ceilings for real, trigger degradation at eighty percent of any one of them,
and hibernate on reaching one — reusing `escapeHatch`, which already writes the branch and the handoff
document CAP-23 requires, rather than building a second write-and-preserve path.

## Boundaries & Constraints

**"Downshifting model tier" is the inverse of promotion, and nothing in `promotion.ts` does that today.**
`rungForAttempt` and `promotionFor` only ever move a step *up* the ladder, triggered by a failure. AD-24's
downshift is triggered by *budget pressure*, not by a step failing, and it moves toward the floor. This is a
new function, not a call to the existing one run backwards — `promotionFor`'s ceiling (one promotion per step
per run) has no bearing on how many times a run-level budget check may downshift.

**"Narrowing scope" has one concrete, defensible meaning available today, and this story commits to it
rather than inventing new machinery.** AD-24 names the behaviour in one clause with no further elaboration
anywhere in the spec. The only existing mechanism in this codebase that is optional, cost-bearing and safe to
skip is story 2-6's two-tier gate economics: deterministic gates first, a model-based review second, only if
the gates pass. **Narrowing scope means skipping the model-based review tier** for a degraded run's remaining
verification steps — the deterministic gates still run and still gate correctness; only the model turn spent
judging the result against the acceptance criteria is cut. Any wider reading — dropping acceptance criteria,
skipping steps the plan named, reducing test coverage — is a materially bigger and riskier claim with no
supporting mechanism, and is explicitly **not** what this story builds. If a wider degradation is wanted
later, that is a new decision for whoever proposes it, not an extension silently folded in here.

**Degradation is a standing condition, not a one-time transition.** A run enters `degraded` at eighty percent
of any one ceiling and *stays* degraded — the state does not un-degrade if wall-clock happens to have more
room while steps are tight, because the person reading `budget.degraded` needs one honest signal, not a
flapping one. A second ceiling crossing eighty percent while already degraded does not re-emit the event;
AD-5's "adding a key is non-breaking" is not licence to spam the log with the same fact.

**Hibernation reuses `escapeHatch`, and hibernation is not the same failure `handoff.ts` was built for.**
`escapeHatch` already does exactly what CAP-23 and AD-24 both need — puts the work on a takeover branch,
writes the four-question handoff document — and it is already idempotent against a crash mid-write (AD-32).
This story's job is to call it from the right trigger (a ceiling reached, not a run giving up entirely) and
to record the distinct terminal state and event the ceiling case requires (`hibernated`,
`budget.exhausted`), which `escapeHatch`'s own outcome does not currently distinguish from any other reason a
person might invoke it.

**No currency dimension, anywhere.** AD-24 says so explicitly, and R10 forbids it project-wide. Consumed
rate-limit budget is a fraction of an declared ceiling, read from the CLI's own usage figures the same way
2-7's note totals are, never rendered or reasoned about as a dollar amount.

**Wall-clock is measured against the run's own start, not against any step's.** A run degrading because one
slow step ran long and a run degrading because many quick steps added up must both trip the same ceiling; the
clock that matters is the run's, and `DECLARED_WALL_CLOCK_MS`'s current status as an unchanging constant
ends here — it becomes the ceiling a real elapsed duration is compared against.

## I/O & Edge-Case Matrix

| # | Input / situation | Expected |
|---|---|---|
| 1 | A run whose consumed steps cross 80% of the step ceiling | Degrades: `budget.degraded` emitted, state becomes `degraded` |
| 2 | A run whose elapsed wall-clock crosses 80% of the wall-clock ceiling | Degrades, the same way |
| 3 | A run whose consumed rate-limit budget crosses 80% | Degrades, the same way |
| 4 | A run already `degraded`, crossing 80% of a second ceiling | No second `budget.degraded` line; the state and the first event stand |
| 5 | A degraded run's next model-tier selection | Downshifts toward the floor rather than following the ordinary starting-tier or promotion rule |
| 6 | A degraded run's next verification step | Runs its deterministic gates; the model-based review tier is skipped |
| 7 | A degraded run whose gates then fail | Disposed exactly as an undegraded run's failing gates would be — degradation narrows scope, it does not weaken a gate |
| 8 | A run reaching 100% of any one ceiling | Hibernates: `budget.exhausted` emitted, state becomes `hibernated`, a handoff document is written via `escapeHatch` |
| 9 | A hibernated run's worktree | Preserved on a takeover branch, exactly as `escapeHatch` already guarantees for any other invocation |
| 10 | A hibernated run | Is a terminal state; AD-32's reclaim pass may act on it on the next reconcile pass |
| 11 | A crash between a ceiling being reached and the handoff document landing | The next pass finds the same ceiling still reached and completes the hibernation; nothing is lost or double-written |
| 12 | Consumed rate-limit budget | Read from usage figures already recorded, never rendered or reasoned about as currency |
| 13 | Wall-clock elapsed | Measured from the run's own start, not from any one step's |
| 14 | `steps_remaining` | Unchanged: already computed correctly from the plan |
| 15 | A run at exactly 80% (not crossing, sitting on the boundary) | Degrades: eighty percent is the trigger, not the last safe point |
| 16 | A run at exactly 100% | Hibernates, not merely degrades a second time |

## Code Map

| File | Change | Why |
|---|---|---|
| `src/engine/ceilings.ts` | new | The three-ceiling check, the 80%/100% thresholds, and the downshift function. |
| `src/engine/reconciler.ts` | modify | Track real wall-clock and rate-limit consumption; call the ceiling check each pass; wire hibernation to `escapeHatch`. |
| `src/engine/handoff.ts` | modify | Distinguish a ceiling-triggered call from any other, so the outcome names `budget.exhausted` rather than a generic escape. |
| `src/contracts/state.ts` | modify | Only if a distinct disposition field is needed beyond the existing `FeatureState` enum; the enum itself is unchanged. |
| `tests/engine.ceilings.test.ts` | new | Matrix 1–7, 12–16. |
| `tests/engine.hibernation.test.ts` | new | Matrix 8–11. |

## Tasks & Acceptance

1. **Track the three ceilings for real.**
   - **Given** a run's elapsed wall-clock, **when** it is measured, **then** it is computed from the run's
     own start, not a constant.
   - **Given** a run's consumed rate-limit budget, **when** it is measured, **then** it is read from
     recorded usage figures, never a hardcoded value.
2. **Degrade at eighty percent, once.**
   - **Given** any one ceiling crossing 80%, **when** the check runs, **then** the run degrades and
     `budget.degraded` is emitted.
   - **Given** a run already degraded, **when** a second ceiling also crosses 80%, **then** no second event
     is emitted and the state is unchanged.
3. **Narrow scope and downshift the model tier, without weakening a gate.**
   - **Given** a degraded run's next model selection, **when** a tier is chosen, **then** it downshifts
     toward the floor.
   - **Given** a degraded run's next verification step, **when** it runs, **then** the deterministic gates
     still run and the model-based review tier is skipped.
   - **Given** a degraded run's gates failing, **when** the step is disposed, **then** it is disposed exactly
     as an undegraded run's failing gates would be.
4. **Hibernate at the limit, reusing the existing escape hatch.**
   - **Given** any one ceiling reaching 100%, **when** the check runs, **then** the run hibernates,
     `budget.exhausted` is emitted, and `escapeHatch` writes the takeover branch and the handoff document.
   - **Given** a crash between the ceiling being reached and the handoff landing, **when** the next pass
     runs, **then** hibernation completes without loss or duplication.
   - **Given** a hibernated run, **when** AD-32's reclaim pass runs, **then** it may act on it as a terminal
     state.

## Spec Change Log

## Review Triage Log

Four layers ran against the diff at baseline `f1b4c2b` (2,820 lines, 20 files; finding floor N = 10 for a
128.67 kB dispatch). Intent-alignment is descriptive only and routed nothing itself; its divergences were
folded into triage alongside the other three layers' findings. **28 findings — high 8, medium 12, low 8.
Routed 26 `patch`, 2 `reject`, 0 `bad_spec`** — every real finding was a bug in the already-decided design,
never a fork needing the user.

**High (8) — one per lettered patch item A–H below, the order the patch round used:**

| Item | Finding | Verdict |
|---|---|---|
| A | `pause`/`narrow` in `steering-view.ts` re-pointed at story 2-11 in this story's own prior finalization pass — mine, not the implementer's. Story 4-3 is titled "Steerable observability — pause, inject, kill, fork" and already claims `fork` in the same table. | Confirmed directly against `stories.yaml`; my own error, corrected. |
| B | A degraded run's resumed attempt ran at full model tier with the model review resumed too — `record.model_tier` reached `startRequest` with no `downshiftFor` call nearby, and the interrupted review restarted. | Confirmed directly in code before dispatch. |
| C | `governedByCeilings` read the ceilings before checking `budget.exhausted`, so an unreadable profile could block finishing a hibernation the log had already made durable. | Confirmed directly; three independent layers found the same root cause. |
| D | No test drives an already-`degraded` run to a ceiling; a reviewer mutation reordering the hibernate/degraded checks left every existing test green. | Confirmed by the reviewer's own mutation. |
| E | `decideCeilingAction` had the terminal-state guard duplicated in two places, which hid a mutation removing the first copy. | Confirmed by re-reading the function. |
| F | A snapshot that becomes unreadable between the ceiling check and the step-input write could leave an orphaned `step.started` with no matching disposition. | Accepted on the reviewer's trace; no positive reproduction attempted. |
| G | Finishing a crashed hibernation rebuilt its `reason` (and the escape hatch's `detail`) from a fresh ceiling reading rather than the `budget.exhausted` line already recorded, so a moved clock could rewrite the hand-off document with numbers that no longer match what happened. | Confirmed directly against `decideCeilingAction`. |
| H | The wall-clock ceiling measured from `run.created` with no exclusion for time spent waiting on a person — a run blocked overnight accrues the whole ceiling unchecked, then hibernates the moment someone approves it, having spent nothing itself. | Confirmed: `measureConsumption` had no waiting-state exclusion. |

**Medium (12) and low (8) — items I–O, each patched; several bundle more than one of the 26 fixes:**

| Item | Finding (medium unless noted low) | 
|---|---|
| I | `cache_read_input_tokens` counted at full weight against the rate-limit window; cache-heavy CLI sessions could degrade or hibernate ordinary runs on cache traffic rather than real usage. |
| J | *(low)* No test or comment recorded what is and isn't known about resumed-session usage reporting and double-counting. |
| K | Several boundary/crash cases had no test (crash between `budget.degraded` and the state change; unreadable snapshot at spend time; no-snapshot fallback; crash-then-kill after `budget.exhausted`); `escalate-to-human` on an already-`blocked` run wrote a redundant line. |
| L | Ceiling fields were unbounded in the schema (precision loss past `MAX_SAFE_INTEGER`); a zero-ceiling or bad-timestamp reading serialized `fraction` as `NaN`/`Infinity` → JSON `null`; and the review-skip condition was flagged as depending on gate *existence* rather than gate *failure* — see the correction below. |
| M | *(low, except the payload fixes are medium)* The TUI still spelled `'budget.degraded'`/`'budget.exhausted'` as bare literals, had no handling for `step.tier_downshifted`, mixed a plan-derived `steps_remaining` into the budget payload, clamped `wall_clock_ms_remaining` while leaving the rate-limit figure unclamped, gave a hibernated run's hand-off note no next step, and reused `verification.review_skipped` for a second cause with no documented key to tell them apart. |
| N | *(low)* The spine diagram was still missing `degraded ↔ blocked`/`interrupted`, `degraded → killed`/`handed_off`, and `verifying`/`confirmed → degraded`/`hibernated`. |
| O | *(low)* A hardcoded `PROFILE_SCHEMA_VERSION === 2` assertion would break on the next unrelated schema bump; the no-flap test depended on moving the clock backwards; no test covered two ceilings crossing on the same pass or an unclamped overshoot. |

**Reject (2).** Both from intent-alignment's divergence list, verified and found to be the reading the intent
itself supports rather than a gap: **(1)** "rather than dying mid-write" reads as an endorsement of letting an
in-flight step finish, not a mandate to interrupt one — confirmed directly that `governedByCeilings` runs only
between actions, and the intent's own wording backs that reading. **(2)** the wider senses of "narrowing
scope" (dropping acceptance criteria or plan steps) and of "hibernates" as resumable are real alternate
readings of AD-24's prose, but this story's own Boundaries section already decided against them during
spec-writing, on the record, before review — a already-decided scope choice is not a review-time defect.

**A correction made after the patch round landed, before finalizing.** Item L's review-skip change went
further than the finding warranted: it made `skipsModelReview` return `true` for a degraded verification step
with **zero** declared gates, on the reasoning that "none passed because none exist" shouldn't count against
narrowing. Re-examined directly against this story's own Boundaries text — "the deterministic gates still run
and still gate correctness" — that guarantee does not hold when no gate exists at all; a step would then be
verified by nothing. Reverted to requiring at least one gate to have **passed** (not merely "none failed")
before the review is skipped, which is the original implementation's decision 7, re-confirmed rather than
re-argued. Mutation-tested: reverting to item L's condition fails the updated test in
`tests/engine.ceilings.test.ts` (1 test).

## Design Notes

## Verification

Run by me, exit status captured to a variable and output kept in a file:
`npm run typecheck && npm run lint && npm run build && npm test` — **exit 0, 2660 tests across 88 files, zero
failures, zero skips**, run a final time after the review round's 26 patches and my own follow-up correction
to item L. Baseline `fd128ff` was 2601/86; the first implementation round reached 2637/88; the rate-limit
follow-up took it to 2640/88; the review-round patches took it to 2660/88.

Eleven mutations in the implementation round, twenty in the review-round patches (see the by-item table
above and the implementer's own mutation table), plus one I ran myself against my own item-L correction — all
applied, run and reverted, tree confirmed clean afterwards.

**Verified by me directly, not taken on report, this round:**
- The five round-2 fixes I judged highest-risk: `governedByCeilings` checks `recordedExhaustion` before
  attempting a ceiling read (item C); the resume-step path applies `downshiftFor` and decides the review skip
  from `gateOutcomesOfLatestAttempt` (item B); the hibernate branch of `decideCeilingAction` is not gated on
  `state.degradation === null`, so an already-degraded run still hibernates at its ceiling (item D); the
  terminal-state guard returns immediately for any terminal `state.state` (item E); a finished hibernation's
  `reason` and `reading` are read from the recorded `budget.exhausted` line, not a fresh measurement (item G).
- `narrow`/`pause` in `src/runtime/steering-view.ts` now read story 4-3 by name and by title quote, not the
  2-11 mis-pointer I introduced in the first finalization pass.
- My own item-L correction (above): `skipsModelReview` requires a **passed** gate, not merely the absence of
  a failed one; a gateless or all-skipped verification step keeps its review. Mutation-tested against the
  test I updated for it.

## Auto Run Result

**Status: done, reviewed.** The three ceilings are tracked for real — steps from the plan, wall-clock from
the run's own start (minus time spent waiting on a person), rate-limit consumption from recorded usage
(cache reads excluded) against a profile-declared, bounded window. A run degrades once per crossing and stays
degraded; a resumed attempt is downshifted and its review-skip decided from the gates that attempt already
recorded, not resumed at full tier. A run reaching any ceiling hibernates through the existing `escapeHatch`,
finishing a crash-interrupted hibernation from the recorded line rather than a fresh reading, never a second
write path, and never blocked by an unrelated ceiling-config read once the hibernation is already durable.

**The heaviest review of the session: 28 findings, high 8, medium 12, low 8, routed 26 patch / 2 reject, no
`bad_spec`.** Full detail is in the Review Triage Log above. The finding I most need to own: the `pause`/
`narrow` fix I made myself in the first finalization pass was wrong — I pointed both at story 2-11 on a
plausible but unverified rationale, without checking `stories.yaml`; story 4-3 is literally titled "Steerable
observability — pause, inject, kill, fork" and already claims `fork` in the same table. Three more high
findings I verified directly in code before dispatching the patch round: a degraded run's resumed attempt ran
at full tier with its review resumed too; an unreadable profile could block finishing a hibernation already
durably recorded; and a reviewer's own mutation proved no test caught an already-degraded run failing to
hibernate at its ceiling.

**A correction I made myself after the patch round, before finalizing — the one worth reading twice.** One
of my own patch instructions (item L) told the implementer to skip a degraded run's model review whenever no
gate *failed*, including when none exist, reasoning that a repository's choice to declare no gates shouldn't
buy it a mandatory review. Re-examining that against this story's own Boundaries text — "the deterministic
gates still run and still gate correctness" — the guarantee does not hold at zero gates: the step would be
verified by nothing. Reverted to requiring a gate to have **passed**, which is the original implementation's
decision 7, re-confirmed rather than overridden. Mutation-tested directly.

**One invented constant, from the first implementation round, was caught by the implementer and correctly
not presented as settled.** The rate-limit window's size in tokens had no basis anywhere in the spec; put to
the user, who chose to keep the per-run-allowance model and make the size a configurable profile field
(`rate_limit_window_tokens`) rather than a hardcoded placeholder.

**Follow-up review recommended: true.** Any patched `high` finding sets this unconditionally, and eight were.
The specific thing worth a second look: whether the item-L correction above is itself the last word, or
whether a gateless repository's degraded runs should instead be pushed toward declaring at least one gate
rather than keeping the review indefinitely.

**Residual risks.** See the `deferred` list in the frontmatter. The two pre-existing gaps the implementer
named rather than silently left stand unchanged: an agent reporting `budget.exhausted` directly still routes
to `handed_off`, not `hibernated`, through the unrelated AD-35 table; and a re-run's step input can carry a
stale budget figure, which is CAP-6's input-reuse rule predating this story. Everything else the review found
that could be patched was; item F's and K4's fixes have no test reaching them (an unreadable snapshot at the
step-input write can only occur after the ceiling check already passed; the engine never produces
`escalate-to-human` for a run already `blocked`), and are recorded as low-severity gaps rather than silently
assumed correct.
