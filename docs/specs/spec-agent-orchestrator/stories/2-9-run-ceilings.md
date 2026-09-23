---
title: 'Run ceilings — degradation at eighty percent, hibernation at the limit'
type: 'feature'
created: '2026-09-23'
status: 'drafted'
review_loop_iteration: 0
followup_review_recommended: false
baseline_revision: '09fcdea'
context:
  - '{project-root}/docs/planning-artifacts/architecture/architecture-agent-orcastrator-2026-09-19/ARCHITECTURE-SPINE.md'
  - '{project-root}/docs/specs/spec-agent-orchestrator/stories/2-5-implementation-agent.md'
  - '{project-root}/docs/specs/spec-agent-orchestrator/stories/2-6-testing-and-verification.md'
deferred: []
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

## Design Notes

## Verification

## Auto Run Result
