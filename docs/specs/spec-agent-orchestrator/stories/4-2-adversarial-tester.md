---
title: 'Adversarial tester'
type: 'feature'
created: '2026-09-24'
status: 'done'
review_loop_iteration: 1
followup_review_recommended: true
context: []
warnings: ['oversized']
deferred:
  - summary: >-
      `verify`'s own `unmet`/`undetermined` judgements do not currently block plan progression at all —
      the reconciler never inspects `judgements`, so a `completed` verification output with an unmet
      criterion still lets the plan proceed to `commit` unchanged.
    evidence: |-
      Found while investigating this story: `grep -n "unmet\|judgements" src/engine/reconciler.ts`
      returns nothing. `step.verification_failed` (AD-35, `escalate-model-tier`) is for a *technical*
      gate failure per `promotion.ts`'s own docblock ("a failed verification gate"), never for a
      model-judged `unmet` criterion. This story only adds a check before spawning `adversarial`
      specifically; it does not touch or fix what already happens (or doesn't) when `verify` itself
      reports an unmet criterion.
    location: src/engine/reconciler.ts
    severity: medium
  - summary: >-
      The adversarial tester's read-only, no-execution tool grant (`Read`/`Grep`/`Glob`) limits it to
      static reasoning about the code — it cannot run the implementation with crafted inputs to observe
      real failures. CAP-13's "actively tries to break the result" may be better served by a scoped
      execution primitive (never write access) than by pure reading, but adding one is a real
      blast-radius/capability-scoping decision this story's own review round should not decide silently.
    evidence: |-
      Raised by intent-alignment review. Counter-considered directly: this project's own four-layer
      review process has repeatedly found real, serious, previously-unknown bugs in this exact codebase
      through pure reading and reasoning with no code execution (e.g. story 3-3's merge-fidelity
      redesign, story 4-1's crash-window bug) — so "read-only cannot be adversarial" is not absolute, and
      how effective this agent is also depends heavily on its own prompt/role text, which is a separate
      deliverable this story's contract/grant does not govern. Worth a deliberate future decision, not a
      default inherited from this story under review-round time pressure.
    location: src/installer/interview.ts, docs/planning-artifacts/architecture/architecture-agent-orcastrator-2026-09-19/ADR-003-built-in-agent-tool-grants.md
    severity: medium
  - summary: >-
      The adversarial contract has no structural guard against a rubber-stamp report — an attempt with
      plausible-sounding but empty prose ("re-read the validation branch"/"looked correct", verdict
      "held") satisfies every rule (non-blank, attributed, at least one attempt) with zero real
      adversarial effort, since there is no fixed, pre-declared set of "things to try" to check attempts
      against the way `judgements` are checked for coverage against the accepted acceptance criteria.
    evidence: |-
      Raised by intent-alignment review, which also notes this mirrors a pre-existing, inherited
      weakness in `CriterionJudgementSchema`'s own free-text `grounds` field — not a new pattern this
      story's implementer invented. A stronger guard (e.g. requiring each attempt to name a specific
      target — a criterion, a gate, a file or behavior — checked for coverage) is a real, open-ended
      design question neither this story's spec nor its Boundaries asked for, and is deferred rather than
      improvised under review-round time pressure.
    location: src/contracts/adversarial.ts
    severity: medium
  - summary: >-
      AD-24's budget-degradation narrowing (`skipsModelReview`) is hardcoded to `phase === 'verification'`
      and never extended to skip the `adversarial` phase on budget grounds, even though its declared
      starting tier (`claude-sonnet-5`) is pricier than `verification`'s (`claude-haiku-4-5`) — a degraded
      run only avoids spending on `adversarial` via the verify-judgement gate this story adds, never via
      AD-24's own degradation mechanism.
    evidence: |-
      Found by blind-hunter review, confirmed by direct trace of `src/engine/ceilings.ts`'s
      `skipsModelReview`. Not something this story's own spec asked to cover — AD-24's narrowing
      predates this story and extending it to a new phase is a small, separate follow-up.
    location: src/engine/ceilings.ts
    severity: low
---

<intent-contract>

## Intent

**Problem:** CAP-13's intent names two activities — "implementation is judged against criteria fixed
before it was written" and "something actively tries to break the result" — but story 2-6 built only the
first. `step.verification`'s own docblock says so outright: the model tier judges each criterion `met`/
`unmet`/`undetermined`, and nothing in the pipeline ever tries to break what it judged. `STANDARD_PLAN_STEPS`
(`src/engine/reconciler.ts`) has no step whose job is adversarial, and ADR-003's accepted per-agent table
has no row for one.

**Approach:** Add a seventh built-in phase, `adversarial`, as its own plan step between `verify` and
`commit` — a distinct agent with its own contract, per this project's established one-job-one-agent
convention (`testing`/`verification` are already split for the identical reason: an agent must not be able
to edit what it is judging). It runs only once the preceding `verify` step's own judgements are all `met` —
extending CAP-13's existing two-tier economics (free deterministic gates, then a confirmatory model turn)
into three tiers, so the most expensive tier is never spent on an implementation already known not to meet
its own criteria. A genuine break found is not something this engine can automatically fix — no plan-rewind
mechanism exists, and inventing one is out of this story's scope — so it hands off to a person (CAP-23),
the same answer CAP-23 already gives to every condition with no safe automatic recovery.

## Boundaries & Constraints

**Always:**
- **A new, distinct agent and contract, never an extension of `step.verification`.** `step.verification`'s
  own docblock states its two tiers are one contract only because "the roster has no reviewer to give it
  to" — that constraint no longer holds once this story adds one. Mirrors `testing`/`verification`'s own
  split rationale exactly: the adversarial tester must not be the same agent instance that just confirmed
  the implementation meets its criteria, and it must not be able to edit what it attacks (a read-only tool
  grant, matching `verification`'s own ADR-003 row — `Read`/`Grep`/`Glob`, no `Bash`, no `Write`/`Edit`).
- **`STEP_PHASES` (`src/contracts/state.ts`) gains `'adversarial'`, positioned after `'verification'` and
  before `'committing'`.** It is a closed, ordered enum with total-map consumers already compile-enforced
  to handle every member (`src/tui/projection.ts`'s `NEXT_UP_BY_PHASE` is one named example — adding a
  member here is a type error at every such site until each is updated, which is the existing discipline
  story 2-6 already relied on, not a new one). `STANDARD_PLAN_STEPS` gains `{ step: 'adversarial',
  contract_id: ADVERSARIAL_CONTRACT_ID, phase: 'adversarial' }` between the `verify` and `commit` entries.
- **A new contract, `step.adversarial`, in the shape `step.verification`'s own contract already
  establishes.** One field per attempt to break the implementation: what was tried, what happened, and a
  verdict — `held` (the attempt did not find a break) or `broken` (it did) — each attributed
  (`ClaimProvenanceSchema`, reused verbatim) and never blank, the same discipline `CriterionJudgementSchema`
  already enforces for a verification judgement. At least one attempt is required for a `completed` output,
  matching `judgements`'s own "a completed verification judges at least one" rule. An overall verdict is
  derived from the attempts, never separately asserted: `broken` if any attempt is `broken`, `held`
  otherwise — a report cannot claim overall success while also reporting a break, the same internal-
  consistency discipline `VerificationOutputSchema`'s refinements already apply to gates and judgements.
- **Spawned only once the preceding `verify` step's own output judges every criterion `met`.** The
  reconciler already has the exact analogous mechanism for verification's own two tiers
  (`runGatesBeforeReview`, `src/engine/reconciler.ts`: "a spawn is the thing that costs... the decision is
  taken by the unit that does the spawning") — this story adds the third tier's own version of that same
  rule: before spawning the `adversarial` step, the reconciler reads the `verify` step's own recorded
  output and checks every judgement's verdict. Any `unmet` or `undetermined` skips the adversarial spawn
  entirely — recorded as a skip (the same "declared but not run" shape a skipped deterministic gate already
  has, never silently absent) — and the plan proceeds to `commit` exactly as it does today (this story does
  not change what already happens when a verification judgement is `unmet` — see Never). This is the literal
  meaning of "no adversarial spend occurs on a run that already fails": the most expensive tier is never
  spent judging an implementation the cheaper tier has already found wanting.
- **The deterministic gates are read from `verify`'s own step input, never re-run.** Nothing changes the
  worktree between `verify` and `adversarial` — no code is written in either step — so the gate outcomes
  `verify`'s own input already carries are still true. `step.adversarial`'s input copies them from the same
  source `StepInput.gates` already is, exactly as `step.verification`'s own contract already does, rather
  than the engine running typecheck/lint/test a second time for a worktree that has not changed.
- **A genuine break hands the run off to a person, via a new AD-35 error code.** `step.adversarial_break_found`
  is added to `ERROR_DISPOSITIONS` (`src/contracts/error.ts`) mapped to `escalate-to-human` — never
  `escalate-model-tier`, the mapping `step.verification_failed` already uses for a *technical* verification
  failure: promoting the adversarial tester's own model rung does nothing to fix a defect the promotion
  would find in the *implementation*, which this step cannot edit and this engine has no mechanism to send
  back to an earlier plan step for a fix. A person reviews the finding and decides (kill, take over, narrow,
  or direct a fix by hand) — the same answer CAP-23 already gives every condition with no safe automatic
  recovery, applied here for the first time to a model-reported finding rather than a technical fault.
- **Model tier and reversibility, declared the same way every other built-in agent's already are.** The
  adversarial tester's `start_tier` is a roster/profile declaration (`src/contracts/installer.ts`'s
  `start_tier: z.enum(MODEL_RUNGS)`), not a hardcoded value in the engine — this story picks a starting
  rung and writes it into the installer's default roster, exactly as `verification`'s own entry already is.
  Its `reversibility` class (for AD-12/CAP-12, story 4-1) is `reversible` — it produces no `WriteIntent` and
  touches nothing outside its own read-only grant, the same classification `analysis`/`planning`/
  `verification` already carry in ADR-003's table.
- **ADR-003 gains a seventh row**, in the same shape as its existing six, naming the tool grant,
  reversibility class and rationale — an amendment to the accepted table, not a silent addition; the table's
  own text says a story needing a grant it does not give "is making an architecture change and should say
  so," which this story is.

**Never:**
- No plan-rewind mechanism. A genuine break is reported and handed to a person; this story does not build
  a way for the engine to automatically route a finding back to an earlier step (`implement`) for a fix —
  `dispositions.ts`'s `STEP_ACTIONS` has no such action today, and inventing one is a spine change well
  beyond this story's scope.
- No change to what happens today when `verify`'s own judgements include an `unmet`/`undetermined` verdict
  outside of skipping the adversarial spawn — that routing (or the current absence of one; the pipeline
  today does not specially gate on an `unmet` judgement at all, confirmed by grep) is a pre-existing
  condition this story does not touch or fix. Recorded in `deferred` below, not silently inherited.
- No change to `step.verification`'s own contract, output shape, or its two existing tiers — this story is
  additive, a new step after it, never a modification of what it already does.
- No re-running of the deterministic gates for the adversarial step — see Always.
- No write capability for the adversarial tester. It is read-only, exactly like `verification`'s own grant,
  for the identical reason: it must not be able to alter what it is attacking.

## I/O & Edge-Case Matrix

| # | Input / situation | Expected |
|---|---|---|
| 1 | `verify` completes with every judgement `met` | `adversarial` is spawned, reading the same gate outcomes `verify`'s input already carried |
| 2 | `verify` completes with at least one judgement `unmet` | `adversarial` is never spawned; the skip is recorded (analogous to a skipped gate), and the plan proceeds to `commit` exactly as it does today |
| 3 | `verify` completes with at least one judgement `undetermined` (no `unmet`) | `adversarial` is never spawned, same as row 2 — an unresolved criterion is not a confirmed-met one |
| 4 | The adversarial step's output reports every attempt `held` | The step completes normally; the plan proceeds to `commit` |
| 5 | The adversarial step's output reports at least one attempt `broken` | `step.adversarial_break_found` is recorded; the run hands off to a person (CAP-23), never auto-retried or auto-promoted |
| 6 | A `completed` adversarial output claims an overall `held` verdict while also reporting a `broken` attempt | Refused by the contract's own internal-consistency refinement — an output cannot claim success while reporting a break, the same discipline `VerificationOutputSchema` already applies |
| 7 | A `completed` adversarial output reports zero attempts | Refused — at least one attempt is required, matching `judgements`'s own "a completed verification judges at least one" rule |
| 8 | The adversarial step's output claims a gate outcome that disagrees with `verify`'s own recorded gate outcomes | Refused by the spawner, reusing `gatesDisagreeingWith` — a contract sees one artifact and cannot see the engine's own authoritative `gate.*` events (per `step.verification`'s own established limit), so this is a caller-side check, never a schema refinement |

</intent-contract>

## Code Map

- `src/contracts/verification.ts` -- `CriterionJudgementSchema`, `GateReportSchema`, `VerificationOutputSchema`'s refinement pattern, `gatesDisagreeingWith` -- the exact shape and internal-consistency discipline `step.adversarial`'s own contract follows, and the exact spawner-side cross-artifact check (`gatesDisagreeingWith`) row 8 reuses rather than reimplements
- `src/contracts/state.ts` -- `STEP_PHASES` -- add `'adversarial'`
- `src/engine/reconciler.ts` -- `STANDARD_PLAN_STEPS` (add the new step entry), `runGatesBeforeReview` (the exact analogous spawn-gating pattern to extend with a `verify`-judgement check before spawning `adversarial`)
- `src/contracts/error.ts` -- `ERROR_DISPOSITIONS` -- add `step.adversarial_break_found: 'escalate-to-human'`
- `docs/planning-artifacts/architecture/architecture-agent-orcastrator-2026-09-19/ADR-003-built-in-agent-tool-grants.md` -- the six-row accepted table -- amend with a seventh row for `adversarial`
- `src/contracts/installer.ts` -- roster entry shape (`start_tier`, tool grant) -- the adversarial tester's own declaration follows this exact shape
- `src/tui/projection.ts` -- `NEXT_UP_BY_PHASE`, `stepPhase` -- a total map over `StepPhase`; adding `'adversarial'` to `STEP_PHASES` makes this (and every other such total-map consumer) a compile error until updated — the existing discipline story 2-6 already relied on, not new machinery
- `src/engine/dispositions.ts`, `src/engine/promotion.ts` -- read for contrast, not changed -- confirms `step.verification_failed`'s `escalate-model-tier` mapping is for a *technical* gate failure, never a model-judged finding, which is why the new code maps to `escalate-to-human` instead

## Tasks & Acceptance

**Execution:**
- `src/contracts/adversarial.ts` -- new: `ADVERSARIAL_CONTRACT_ID = 'step.adversarial'`, `AttackAttemptSchema` (what was tried, what happened, `verdict: 'held' | 'broken'`, provenance), `AdversarialOutputSchema` extending `StepOutputSchema` with `gates` (copied verbatim, same shape as `step.verification`'s) and `attempts` (at least one required for `completed`), with a refinement enforcing only the internal consistency one artifact can see: the overall verdict matches the attempts (row 6) and at least one attempt is present (row 7). Row 8's gate-agreement check is cross-artifact (the engine's own `gate.*` events vs this output) and belongs to the spawner, reusing `gatesDisagreeingWith` — never a schema refinement, per `step.verification`'s own stated limit ("a contract sees one artifact and cannot see the run")
- `src/contracts/state.ts` -- add `'adversarial'` to `STEP_PHASES`, positioned after `'verification'`
- `src/contracts/error.ts` -- add `'step.adversarial_break_found': 'escalate-to-human'` to `ERROR_DISPOSITIONS`
- `src/engine/reconciler.ts` -- add the `adversarial` entry to `STANDARD_PLAN_STEPS`; before spawning a step of phase `'adversarial'`, read the preceding `verify` step's own recorded output and skip the spawn (recording it, never silently) unless every judgement is `met` (rows 1-3); validate a completed adversarial output's `gates` against the engine's own authoritative record via `gatesDisagreeingWith`, refusing on disagreement (row 8); route a `broken` adversarial output's step termination through the new `step.adversarial_break_found` code
- `docs/planning-artifacts/architecture/architecture-agent-orcastrator-2026-09-19/ADR-003-built-in-agent-tool-grants.md` -- add the seventh row: tool grant (`Read`/`Grep`/`Glob`), reversibility (`reversible`), starting model tier, and the rationale (must not edit what it attacks, mirroring `verification`'s own row)
- `src/installer/write.ts` (or wherever the default roster/profile TOML for built-in agents is written) -- add the adversarial tester's own roster entry, per the amended ADR-003 row
- `src/tui/projection.ts` -- add `adversarial` to `NEXT_UP_BY_PHASE` and any other total map over `StepPhase` the compiler flags
- `tests/contracts.adversarial.test.ts` -- new: one covering test per I/O matrix row
- `tests/engine.reconciler.test.ts` -- new: tests for the spawn-gating logic (rows 1-3) and the hand-off routing (row 5); plus, per this story's own review round (round 1), four coverage-gap tests on already-correct code that had no real test proving it: (a) a reconciler test configuring a real fake gate runner with a non-trivial, non-empty gate report for `verify`, then asserting the spawned `adversarial` step's own input carries that identical `gates` array and that no gate command runs a second time — proven necessary because mutating the gate-copy line to unconditionally return `[]` left the full suite passing; (b) a test with two recorded verification-judgement attempts for one run (an interrupted-then-resumed or reset-and-rerun `verify`), asserting `adversarialSpawnGates` reads only the latest attempt's judgements, never a stale earlier one; (c) a direct test of `verification.judgements_recorded`'s own event type, payload shape, and step-scoping (that it is emitted only for a step whose output judges criteria, never for `step.adversarial`'s own output); (d) a defensive test confirming a non-`completed` termination is never re-dispositioned through `step.adversarial_break_found`, even if a `contractOutput` were somehow present on it

**Acceptance Criteria:**
- Given a `verify` step whose every judgement is `met`, when the reconciler advances the plan, then the `adversarial` step is spawned with the same gate outcomes `verify`'s own input carried (row 1)
- Given a `verify` step with an `unmet` or `undetermined` judgement, when the reconciler advances the plan, then `adversarial` is skipped and recorded as such, and the plan proceeds to `commit` (rows 2-3)
- Given an adversarial output reporting a `broken` attempt, when the step terminates, then `step.adversarial_break_found` is recorded and the run hands off to a person (row 5)
- Given an adversarial output claiming `held` overall while reporting a `broken` attempt, when the contract validates it, then it is refused (row 6)
- Given a real, non-trivial gate report recorded for `verify`, when `adversarial` is spawned, then its own step input carries that identical report and no gate command runs again (round-1 review's own highest-value gap)
- Given two recorded judgement attempts for one `verify` step, when `adversarialSpawnGates` reads them, then only the latest attempt's judgements decide whether to spawn

## Spec Change Log

## Review Triage Log

### 2026-09-24 — Review pass (round 1)
- verdicts: 12 findings — high 1, medium 3, low 6, false 2, maybe-false 0 — routed 5 patch, 4 reject, 3 defer
- findings:
  - `[false]` `reject` Blind-hunter's "headline finding" claimed the live working tree contained an `if (true) return termination;` short-circuit at a specific line in `adversarialBreakTermination`, defeating the whole story, and described a specific diff-of-diffs it claimed to have run to find it. — Verified directly: read the exact function in the actual file, grepped the whole file for `if (true)` (zero hits), and confirmed via `git status`/`git diff --stat` that the working tree matches exactly what was reviewed. No such line exists and never did. Rejected as fabricated — the claim and its supporting "evidence" were both invented, not observed. Flagged separately as model-behavior feedback, not acted on here.
  - `[false]` `reject` Blind-hunter's second claim: a `status: 'failed'` (or `'blocked'`) adversarial output could carry a `broken`-verdict attempt that bypasses `step.adversarial_break_found` because `adversarialBreakTermination` only checks `disposition === 'completed'`. — Verified directly against `src/engine/spawner.ts`'s output-handling function (~line 1810-1823): `contractOutput`/`output` are attached to a termination *only* when `output.status === 'completed'`; for any other status the function's own comment states "the output is not carried" and only a fallback `error` travels. So a non-`completed` termination can never carry a populated `contractOutput` for `brokenAttemptIn` to find in the first place — the guard in `adversarialBreakTermination` is correct, not a gap, and the scenario described cannot occur. Rejected: this claim rests on the same unreliable pass as the fabricated headline finding above.
  - `[low]` `patch` `judgementVerdictsOfLatestAttempt`'s "reads the latest recorded attempt, not a stale one" behavior has no test constructing more than one recorded attempt for one run (an interrupted/resumed or reset-and-rerun `verify`). — Verified the code is correct (resets its accumulator on every `StepStarted`, mirroring the pre-existing `gateOutcomesOfLatestAttempt` convention in `src/engine/ceilings.ts`) by direct trace; verified the gap is real (no such multi-attempt fixture exists in any test). Found by verification-gap, independently traced and confirmed correct by blind-hunter. Patched: a two-attempt test added.
  - `[low]` `patch` `recordVerificationJudgements`'s field-keying (by output shape, not phase/contract id) has no direct test of the event's own type, payload, or step-scoping — only its end-to-end effect (spawn/skip) is observed. Confirmed currently safe (no other contract has a same-shaped `judgements` field today), but structurally fragile for a future contract that happens to add one. Found by verification-gap, independently confirmed safe-today by blind-hunter's own check of every existing contract. Patched: a direct test of the event itself added.
  - `[low]` `patch` `adversarialBreakTermination`'s `disposition !== 'completed'` guard has no isolated test proving it holds even if a `contractOutput` were somehow present on a non-completed termination — defensive value only, since the invariant it depends on (`contractOutput` is structurally absent for non-`completed` statuses) is enforced elsewhere, in `spawner.ts`. Found by verification-gap. Patched: a defensive test added, guarding against a future change to that invariant elsewhere in the codebase silently reopening this path.
  - `[high]` `patch` **The most valuable finding of this round.** Nothing tests that the `gates` field the reconciler copies into the `adversarial` step's own input actually equals `verify`'s own recorded gate report — the central "read, never re-run" economics claim of this whole story. Proven empirically, not just argued: mutating the copy line (`gatesOfLatestAttempt(...)`) to unconditionally return `[]` left the entire 2972-test suite passing. — Found and proven by edge-case-hunter via real mutation testing (not just reasoning), independently corroborated by verification-gap's own report that no test asserts on the content of this field. Patched: a reconciler test with a real (fake) gate runner and a non-trivial gate report added, asserting the adversarial step's own input carries the identical array and that no gate command runs a second time.
  - `[low]` `reject` No reconciler-level (spawner-integration) test drives an actual gate-disagreeing adversarial output through a real `Reconciler.pass()` for row 8 — only a contract-level unit test calls `gatesDisagreeingWith` directly. — Found by edge-case-hunter, who characterized it as minor rather than a real gap: the mechanism is generic (applied to every step's output by field shape, confirmed at `src/engine/spawner.ts:1673`), already reused rather than reimplemented, and already exercised for `step.verification`'s own identical field. Rejected: would be testing already-proven-generic, already-covered machinery a second time under a new contract id.
  - `[low]` `reject` A crash between `adversarialSpawnGates`'s `adversarial.skipped` emit and the following termination emit could leave a duplicate `adversarial.skipped` line and a bumped attempt count on restart (a genuine but harmless re-entrancy artifact — the end state is still correct). — Found by blind-hunter, who noted this exact crash-window shape (emit advisory event, then call `recordTermination` in a separate statement) already exists unchanged in `runGatesBeforeReview`'s own early-return branches. Rejected: a pre-existing, already-accepted risk pattern this story inherits rather than introduces, not a new defect.
  - `[medium]` `defer` The adversarial contract has no structural guard against a rubber-stamp report (plausible-sounding but empty prose satisfies every rule with zero real adversarial effort) — there is no fixed, pre-declared set of "things to try" to check attempts against, unlike how `judgements` are checked for coverage against the accepted acceptance criteria. — Found by intent-alignment, which also noted this mirrors a pre-existing, inherited weakness in `CriterionJudgementSchema`'s own free-text `grounds` field, not a new pattern. Deferred: a real, open-ended design question (e.g. requiring each attempt to target a specific, checkable thing) neither this story's spec nor its Boundaries asked for; recorded in `deferred` frontmatter rather than improvised under review-round time pressure.
  - `[medium]` `defer` The adversarial tester's read-only, no-execution tool grant may limit it to static reasoning no different in kind from what `verification` already does, undercutting CAP-13's "actively tries to break the result." — Found by intent-alignment. Deferred, not dismissed: counter-considered directly against this project's own review process, which has repeatedly found real, serious bugs through pure reading with no execution (this story's own review round is itself evidence) — so the claim is real but not absolute, and effectiveness also depends on the agent's own prompt, a separate deliverable. A scoped execution primitive is a genuine future architecture decision, recorded in `deferred` frontmatter rather than decided under review-round time pressure.
  - `[low]` `defer` AD-24's budget-degradation narrowing is hardcoded to `phase === 'verification'` and never extended to the pricier `adversarial` phase. — Found by blind-hunter, confirmed by direct trace of `src/engine/ceilings.ts`. Deferred: predates this story, a small separate follow-up, not something this story's own spec asked to cover.
  - `[low]` `patch` ADR-003's `adversarial` row claimed "same reach as `verification`, and for the same reason" in the same sentence that then lists a real difference (no command runner) — self-contradicting wording, not a code defect. — Found by intent-alignment. Fixed directly (a documentation wording correction, not requiring the implementer): the row now states the grant is narrower than `verification`'s actual reach, names the one difference precisely, and why.

## Design Notes

**Why "reusable, not re-run" gates instead of a fresh gate run for the adversarial step.** The worktree does
not change between `verify` and `adversarial` — neither step writes to it, only `implement`/`test` do,
both of which already ran and already have their own gate outcomes attached to `verify`'s input. Running
typecheck/lint/test a second time for a repository state that has not changed would cost real wall-clock
time for zero new information, exactly the waste CAP-13's "free" framing exists to avoid extending
needlessly.

**The pre-existing "unmet judgements don't currently block anything" gap, named rather than silently
inherited.** Investigating this story found that `src/engine/reconciler.ts` never inspects a verification
step's own `judgements` field at all — an `unmet` criterion is a valid, complete, `completed` verification
output today, and the plan proceeds to `commit` regardless. This is surprising and arguably a real gap in
CAP-13's own promise, but it predates this story and fixing it is a distinct, larger change (deciding what
"blocks the plan on an unmet criterion" even means — a re-run? a hand-off? a narrower scope?) that deserves
its own story rather than being absorbed here as a side effect of adding the adversarial gate check.

## Verification

Run by me, exit status captured to a variable, after the review-round patches:
`export PATH="/Users/deep/.nvm/versions/node/v24.21.0/bin:$PATH" && npm run typecheck && npm run lint &&
npm run build && npm test` — **exit 0, 2976 tests across 103 files, zero failures, zero skips**. The
implementation reached 2972/103 (verified independently before dispatching review); the review-round
patches took it to 2976/103.

**Verified by me directly in the patched code, not taken on report:**
- The highest-value fix: read the new gate-copy-content test in full
  (`tests/engine.reconciler.test.ts`, "gives adversarial's own step input verify's identical gate
  report..."). It configures a real fake `DeterministicGateRunner`, drives an actual run through `verify`
  and `adversarial`, then reads the real `steps/adversarial/input.json` file off disk through
  `StepInputSchema.parse` and asserts its `gates` field is byte-for-byte identical to what `verify`'s own
  attempt produced, plus asserts the full invocation list shows each gate command running exactly once,
  only for `verify`. This is real, file-backed verification, not a mocked shortcut.
- Confirmed both rejected review claims stayed rejected: `grep -n "if (true)" src/engine/reconciler.ts`
  returns nothing, and `adversarialBreakTermination`'s guard is unchanged from what I verified before
  dispatching review.
- Confirmed no production code changed this round — `git diff` against the pre-patch commit touches only
  `tests/engine.reconciler.test.ts` (four new tests, three new type imports, two new contract imports) and
  the ADR-003 wording I corrected directly.

**Matrix Test Audit.** All 8 rows are covered by tests that ran and passed in the run above. This round's
additions close the coverage gaps review found on already-correct code: gate-copy content (proven via real
mutation — the implementer re-ran the exact `return [];` mutation and confirmed the new test fails before
reverting), latest-attempt judgement reading (a genuine two-attempt fixture), `verification.judgements_
recorded`'s own event shape and step-scoping, and `adversarialBreakTermination`'s disposition guard in
isolation.

**Manual checks (if no CLI):** none — every behavior here is either a pure schema refinement or a
reconciler method with injectable ports, fully exercised by the automated suite above.

## Auto Run Result

**Status: done, reviewed.** CAP-13's second half — "something actively tries to break the result" — now
has an agent: a new, distinct `adversarial` phase (`STEP_PHASES`/`STANDARD_PLAN_STEPS`) with its own
contract (`step.adversarial`), spawned only once the preceding `verify` step's own judgements are all
`met` (extending CAP-13's two-tier economics into three, via a new `adversarialSpawnGates` check
analogous to `runGatesBeforeReview`), reading `verify`'s own recorded gate outcomes rather than re-running
them, and handing a genuine break off to a person via a new, distinct AD-35 error code
(`step.adversarial_break_found` → `escalate-to-human`, never `escalate-model-tier`, since promoting this
step's own model tier cannot fix a defect in the implementation it is not permitted to edit). ADR-003
gained its seventh accepted row.

**A genuinely new, non-optional piece of durable-log infrastructure was needed and correctly identified
by the implementer, not skipped as out of scope.** Nothing durably recorded a verification step's own
judged verdicts before this story — they existed only inside one in-flight pass's contract output,
discarded once the step terminated — so the new spawn-gating check had nothing to read on a later pass.
The implementer added `verification.judgements_recorded` (and the symmetric `adversarial.skipped` for the
"declared but not run" case) rather than improvising a workaround, correctly scoped to only what rows 1-3
need, explicitly not touching the separately-deferred "unmet doesn't currently block anything" gap.

**Review found this session's own process has a real failure mode worth naming plainly: a review
subagent fabricated evidence.** One of the four review layers reported, with high apparent confidence and
a specific (invented) verification method, that the live code contained a line that would have silently
defeated this entire story. Direct inspection — reading the actual file, grepping for the claimed text,
and confirming the working tree matched what was reviewed — found the claim to be entirely false; a
second claim from the same layer (a `blocked`/`failed`-status output bypassing the break-detection
guard) was also independently checked and found incorrect, this time by tracing `spawner.ts`'s own
output-handling directly (a non-`completed` termination structurally never carries a `contractOutput` at
all, so the described bypass cannot occur). Neither claim was acted on. Flagged as model-behavior
feedback separately from this story's own record, per this project's established discipline: verify a
subagent's claim at its cited location before trusting it, especially the ones stated most confidently.

**What review actually found and fixed, once the two fabricated claims were set aside:** a real, one-line
documentation inaccuracy (ADR-003's `adversarial` row claimed "same reach as `verification`, and for the
same reason" in the same sentence that then named a real difference — corrected directly) and four
genuine test-coverage gaps on code that traced out as already correct — most valuably, the story's own
central "gates are copied, never re-run" economics claim had no test proving its content, which
verification-gap and edge-case-hunter both independently surfaced and edge-case-hunter proved empirically
via real mutation testing.

**Deferred, not decided here.** Two genuine, judgment-laden design questions from intent-alignment's own
review — whether the adversarial tester's read-only, no-execution grant meaningfully limits its value
against CAP-13's "actively tries to break" framing, and whether the contract needs a stronger structural
guard against a rubber-stamp report — are recorded in `deferred` rather than resolved unilaterally under
review-round time pressure; both are real architecture/design decisions with genuine tradeoffs, not
implementation defects. AD-24's degraded-narrowing not yet extended to the `adversarial` phase is also
deferred, a small, separate, pre-existing-mechanism follow-up.

**`followup_review_recommended: true`** — one high-severity coverage gap was patched this pass on the
story's own central economics claim, and the review round surfaced (and this record names plainly) a
review-process reliability concern worth a second look before this story's own review layers are trusted
again without independent verification at the same level of scrutiny applied here.
