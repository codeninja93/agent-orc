---
title: 'Interviewer — single entry point, spec echo, question compression'
type: 'feature'
created: '2026-09-23'
status: 'drafted'
review_loop_iteration: 0
followup_review_recommended: false
baseline_revision: '10393f1'
context:
  - '{project-root}/docs/planning-artifacts/architecture/architecture-agent-orcastrator-2026-09-19/ARCHITECTURE-SPINE.md'
  - '{project-root}/docs/specs/spec-agent-orchestrator/interface-contract.md'
  - '{project-root}/docs/specs/spec-agent-orchestrator/glossary.md'
  - '{project-root}/docs/specs/spec-agent-orchestrator/architecture.md'
  - '{project-root}/docs/specs/spec-agent-orchestrator/stories/2-7-committer.md'
deferred: []
---

# Story 2-8 — Interviewer: single entry point, spec echo, question compression

## Intent

**Problem:** the plumbing for both of the Interviewer's jobs exists and nothing decides anything with it.
`assertAskableDraft`, `attemptQuestionDeflection` and the whole compare-and-set race are built, but
`attemptQuestionDeflection` takes an already-decided `QuestionDeflection` as an argument — nothing constructs
one. `spec.recorded` and `spec.criterion_edited` are registered event types that `acceptFeature` already
emits from a `FeaturePlan`'s `acceptance_criteria` — but nothing produces that array from a person's raw
request. And `AD-25`'s decision ledger is, by design, the event log itself: story 5-3 builds a queryable
index *over* it; nothing before 5-3 reads it at all.

**Approach:** build the two decisions the Interviewer is the only place either can be made: turning a raw
request into confirmable acceptance criteria (spec echo), and turning a subagent's question into either a
constructed deflection or a merged, single question that reaches the user (question compression). Both stay
inside the model-family-is-Claude boundary the TypeSafe decision just closed: deflection matching is
mechanical, over anchors, never a semantic classifier; merging that genuinely needs judgment uses the
Interviewer's own live turn, because it already is one.

## Boundaries & Constraints

**The Interviewer is architecture.md's one exception, and this story does not try to make it another one-shot
step agent.** Every agent built so far — analysis through committing — is `claude -p --print` once, a typed
file in, a typed file out. The Interviewer is "the only component required to be a live model conversation"
(architecture.md), which is a different invocation shape entirely: multi-turn, interactive, answerable in a
terminal (Q5). Driving a real interactive session with a human typing is not a thing an automated test can
exercise, the same honest gap story 2-6 recorded for the MCP stdio transport. What this story builds and
tests is the **logic** a live turn calls into — composing the echo, parsing a confirmation or an edit,
constructing a deflection, merging drafts — not the terminal loop itself.

**Deflection matching is mechanical, per the TypeSafe decision closed alongside this story.** TypeSafe was
investigated and not adopted: it is a hosted third-party vendor requiring its own credential and egress path,
which contradicts SPEC's model-family-is-Claude assumption rather than extending it. Matching a new
question against the repository, git history or a past decision is therefore an anchor comparison in code —
the same mechanism story 2-3 built for knowledge staleness, on the same grounds: a loader cannot judge
semantics, and neither can a classifier bolted on beside it. **Merging two questions that are the same thing
asked twice, where anchors alone cannot tell, is not forced into the same mechanism** — the Interviewer is
already a live Claude turn, so a judgment call that genuinely needs one is made there, inside the existing
subscription-auth boundary, never by a second model family.

**The decision ledger this story reads is the raw log, not an index.** AD-25's own module says so
explicitly: "there is no table, no index and no retrieval here — deliberately... Story 5-3 builds the
queryable index *over* these lines." So `decision_ledger` deflection is a linear fold over
`decision.recorded` lines the current run's log (and, if available, prior runs' logs for the same project)
already carries — not a store this story invents. A later story indexing the same lines does not change what
they mean; it only makes finding one cheaper.

**Spec echo produces a `FeaturePlan`'s `acceptance_criteria`; `acceptFeature` already knows what to do with
it.** The event vocabulary (`spec.recorded`, `spec.criterion_edited`) and the fold that lets a later
`spec.recorded` replace the criteria wholesale are built. This story's boundary is everything **before**
that: turning "the user's original words, verbatim" into a first candidate list, and turning a person's edit
into the amended array `acceptFeature` will record. It does not change `acceptFeature`, `SpecRecordedPayloadSchema`
or the fold.

**Question compression must not weaken CAP-4's timeout or Q1's shape.** `question-window.ts` and
`assertAskableDraft` already guarantee every question a subagent raises carries a default, a window and at
most three options plus an escape. A merged question presented to the user must still satisfy
`assertAskableDraft` — merging is not a way to smuggle an open-ended question past Q1.

**Deflection rate is a computed fact over what the log already carries, not a new counter to maintain.**
`question.asked` and `question.deflected` are both durable event types. The rate is a fold, in the same idiom
`rebuild.ts` already uses for every other derived fact — reporting it must not require a second write path
beside the ones `attemptQuestionDeflection` and `resolveQuestion` already use.

## I/O & Edge-Case Matrix

| # | Input / situation | Expected |
|---|---|---|
| 1 | A user's raw feature request | Composed into a candidate acceptance-criteria list, the request carried verbatim alongside it |
| 2 | A person confirming the echoed criteria unedited | The plan's `acceptance_criteria` is exactly the candidate list, in order |
| 3 | A person editing one line | Only that line changes; the rest of the list is untouched, and the edit is attributable per `spec.criterion_edited`'s shape |
| 4 | A confirmation with no criteria at all | Refused: an empty accepted list is not a spec anyone confirmed |
| 5 | A subagent question whose anchor appears in the repository's own instructions | Deflected, source `repository`, with the anchor and the matching text as the answer |
| 6 | A subagent question whose anchor appears in a past commit message or PR-adjacent git history | Deflected, source `git_history` |
| 7 | A subagent question whose anchor matches a prior `decision.recorded` line for this project | Deflected, source `decision_ledger`, naming the run the decision came from |
| 8 | A subagent question matching nothing | Not deflected; passed through to merging, then to `assertAskableDraft` unchanged |
| 9 | Two subagent questions sharing one anchor | Merged into one question before either is asked |
| 10 | Two subagent questions on different anchors that happen to look similar in prose | Not merged: anchor mismatch is the mechanical signal, and prose similarity alone is not one |
| 11 | A merged question | Still satisfies `assertAskableDraft`: at most three options, a default, a window, an escape |
| 12 | A deflection this story constructs | Passed to the existing `attemptQuestionDeflection`, never a second write path to the question state |
| 13 | A feature with 6 questions raised, 5 deflected, 1 asked | Deflection rate reports 5/6, computed from `question.asked` and `question.deflected` lines already in the log |
| 14 | A feature raising no questions at all | Deflection rate is reported as undefined-for-this-feature, never as 0/0 read as "zero deflected" |
| 15 | `decision_ledger` matching against a run whose log is unreadable or absent | Treated as no match, never as a thrown error that blocks the question |
| 16 | A question a live Interviewer turn judges as a duplicate the anchors missed | Merged on that judgment, and the judgment itself is recorded as the reason, not left implicit |

## Code Map

| File | Change | Why |
|---|---|---|
| `src/engine/interviewer.ts` | new | Spec-echo composition, confirmation/edit parsing into a criteria array, and the entry point a live turn calls into. |
| `src/engine/deflection.ts` | new | The three mechanical matchers (repository, git history, decision-ledger fold) and `constructDeflection`, which builds the `QuestionDeflection` `attemptQuestionDeflection` already accepts. |
| `src/engine/question-merge.ts` | new | Anchor-based merge of same-anchor drafts; the seam a live judgment call fills in when anchors do not resolve it. |
| `src/engine/deflection-rate.ts` | new | The fold over `question.asked`/`question.deflected` lines into a per-feature rate. |
| `src/runtime/repository.ts` | modify | A git-log search helper reusing `gitEnvironment()`, for `git_history` matching. |
| `tests/engine.interviewer.test.ts` | new | Matrix 1–4. |
| `tests/engine.deflection.test.ts` | new | Matrix 5–8, 12, 15. |
| `tests/engine.question-merge.test.ts` | new | Matrix 9–11, 16. |
| `tests/engine.deflection-rate.test.ts` | new | Matrix 13–14. |

## Tasks & Acceptance

1. **Compose and confirm the spec echo.**
   - **Given** a raw feature request, **when** the Interviewer composes its echo, **then** it produces a
     candidate criteria list and carries the request verbatim alongside it.
   - **Given** a person confirming the echo unedited, **when** the plan is constructed, **then** its
     `acceptance_criteria` matches the candidate list exactly.
   - **Given** a person editing one line, **when** the plan is constructed, **then** only that line changed.
   - **Given** a confirmation with an empty criteria list, **when** it is parsed, **then** it is refused.
2. **Construct a deflection mechanically.**
   - **Given** a question whose anchor appears in the repository's instructions, **when** deflection is
     attempted, **then** it is deflected with source `repository`.
   - **Given** a question whose anchor appears in git history, **when** deflection is attempted, **then**
     it is deflected with source `git_history`.
   - **Given** a question whose anchor matches a past `decision.recorded` line, **when** deflection is
     attempted, **then** it is deflected with source `decision_ledger`, naming the originating run.
   - **Given** a question matching nothing, **when** deflection is attempted, **then** it is not deflected.
   - **Given** a constructed deflection, **when** it is applied, **then** it is passed to
     `attemptQuestionDeflection` unchanged, never written by a second path.
3. **Merge before asking, without weakening the shape a question must satisfy.**
   - **Given** two drafts sharing an anchor, **when** merging runs, **then** they become one question.
   - **Given** two drafts on different anchors, **when** merging runs, **then** they are not merged, even
     if their prose looks similar.
   - **Given** a merged question, **when** it is checked, **then** `assertAskableDraft` still accepts it.
   - **Given** a live judgment call merging what anchors missed, **when** it is recorded, **then** the
     judgment itself is the stated reason.
4. **Report the deflection rate as a fold, not a counter.**
   - **Given** a feature with some questions deflected and one asked, **when** the rate is computed, **then**
     it is the deflected count over the total, read from `question.asked`/`question.deflected` lines alone.
   - **Given** a feature that raised no questions, **when** the rate is computed, **then** it is reported as
     inapplicable, never as zero.

## Spec Change Log

## Review Triage Log

## Design Notes

## Verification

## Auto Run Result
