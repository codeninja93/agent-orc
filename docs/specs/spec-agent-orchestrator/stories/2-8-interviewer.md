---
title: 'Interviewer — single entry point, spec echo, question compression'
type: 'feature'
created: '2026-09-23'
status: 'done'
review_loop_iteration: 0
followup_review_recommended: true
baseline_revision: '10393f1'
context:
  - '{project-root}/docs/planning-artifacts/architecture/architecture-agent-orcastrator-2026-09-19/ARCHITECTURE-SPINE.md'
  - '{project-root}/docs/specs/spec-agent-orchestrator/interface-contract.md'
  - '{project-root}/docs/specs/spec-agent-orchestrator/glossary.md'
  - '{project-root}/docs/specs/spec-agent-orchestrator/architecture.md'
  - '{project-root}/docs/specs/spec-agent-orchestrator/stories/2-7-committer.md'
deferred:
- summary: 'Review pass 1 ran all four layers; 23 patches applied and one bad_spec cause decided with the user.'
  evidence: '28 findings — high 5, medium 11, low 12 — routed 23 patch, 1 bad_spec, 2 defer, 2 reject. The
    bad_spec cause was a false-positive risk in the anchor-only matching design this story closed at its
    start: two different questions sharing one symbol were indistinguishable. Decided with the user: the
    anchor became two parts, a symbol and the aspect being asked about, staying entirely mechanical.'
  severity: low
- summary: 'One fix I sent back rather than accepted: a count read by parsing prose, now a structured field.'
  evidence: 'The first patch round measured a merged card''s question count by parsing a fixed sentence
    out of the card''s brief text, falling back to 1 (undercounting) whenever the sentence was not found
    — reintroducing the counting defect this fix existed to close, one layer indirect. Sent back; the
    count is now an optional, additive field on the durable QuestionSchema record (`raised_question_count`),
    read first, with the brief parse kept only as a fallback for a question.asked line an older build
    wrote. Verified directly: the payload key exists, `raisedCountOf` prefers the field and validates it
    is a safe integer >= 1 before trusting it, and the non-vacuous test is present.'
  severity: low
- summary: No review layer ran a second pass on the patch round itself.
  evidence: 'The 23 patches and the two follow-up fixes were verified by me directly — the full gate
    (exit 0, 2601/86, zero skips) and targeted probes of the anchor split, the timeout-default exclusion,
    the newest-wins-by-resolved_at logic, and the structured raised-count field — but no second four-layer
    review ran against this round''s diff. Read `status: done` as gated and independently spot-checked,
    not re-reviewed end to end.'
  severity: medium
- summary: 'Nothing calls the compression/echo pipeline in production yet.'
  evidence: 'Carried forward, confirmed still true after this round: `compressQuestions`, `composeSpecEcho`
    and `confirmSpecEcho` have no caller outside their own tests. Same shape as the "no production
    assembly point" gap carried since story 2-4 — now touching a sixth engine surface.'
  severity: high
- summary: 'Subagent questions still carry no anchor field, and no run is linked to a project.'
  evidence: 'Unchanged by this round; the two-part anchor narrows how RaisedQuestion compares anchors, it
    does not create a path for a real subagent output to supply one. Whoever wires a real caller (the
    same story that closes the assembly gap above) will need to decide where a two-part anchor comes
    from for a genuine step-raised question.'
  severity: medium
- summary: 'The git-history search caps at 5,000 candidate commits, and says so rather than silently truncating.'
  evidence: 'A true match beyond that depth is reported as not found rather than found incorrectly, per
    the verdict text the search returns. Going further would need a redesign (paging strategy, or an
    index) rather than a parameter change.'
  location: src/runtime/repository.ts
  severity: low
- summary: 'The interactive terminal loop is not built or tested.'
  evidence: 'Unchanged: nothing spawns a live `claude -p` conversation. The same honest boundary story
    2-6 recorded for its MCP stdio transport.'
  location: src/engine/interviewer.ts
  severity: medium
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
| 17 | An anchor | Is two parts — a symbol and the aspect being asked about — never a bare symbol alone |
| 18 | Two raised questions sharing a symbol but different aspects | Not deflected against each other; the aspect is what distinguishes them |
| 19 | A ledger decision whose resolver was `timeout_default` | Never used to deflect; a timeout is not something a person decided |
| 20 | A ledger decision whose answer was redacted | Skipped, and no older superseded decision silently stands in for it |
| 21 | A merge or a single draft that fails `assertAskableDraft` | Reported per question or per group; the rest of the batch still compresses |
| 22 | Two same-anchor askers with different escapes or different default actions | Sent to `awaitingJudgment`, the same as differing recommended defaults |
| 23 | A judged merge's window | The shortest window among every raised draft it replaces, never the judged card's own value taken as given |
| 24 | A confirmation amending a line outside `1..criteria.length` | Refused, returned as a result, never thrown |
| 25 | An amendment with no wording | Refused, naming what is missing |
| 26 | An empty echo a person wants to add to | Has a path to state a new criterion, not only to reword an existing one |
| 27 | The deflection rate's `reachedUser` field | Means what it says: settled by a person, not merely "not deflected" — a timeout or cancellation is its own category |
| 28 | A merged card standing for several raised questions | Counted as the number of questions it replaces in the rate's denominator, not as one |

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

### 2026-09-23 — amended by review pass 1 (one `bad_spec` cause, decided with the user)

**Triggering finding.** BH1 — anchor matching can deflect a question with the wrong answer: two questions
sharing one anchor but asking about different things are indistinguishable to a bare-symbol comparison, and
a wrongly-deflected question reaches nobody, so the mistake has no correction point.

**Decided with the user.** The anchor is narrowed to two parts — a symbol and the aspect being asked about —
rather than adding a semantic layer. Since no shipped step contract currently supplies an anchor at all (the
anchor is an engine-internal representation until a real caller wires one in, a gap already deferred), this
changes only how `RaisedQuestion` and the three matchers represent and compare an anchor, not any contract
story 2-4 through 2-7 shipped.

**What was amended.** Matrix rows 17–28: the two-part anchor: the timeout-default exclusion from ledger
matching; the redacted-decision superseded-fallback fix; per-group failure isolation in merging; the
escape/default-action divergence check widened to every asker, not only the base one; the judged-merge
window rule; the spec-echo amendment bounds, blank-wording refusal and add-a-criterion path; and the
deflection rate's `reachedUser`/merged-card-counting fixes.

**KEEP instructions — what worked and must survive.** (1) Matching stays purely mechanical — string/token
comparison, no similarity score, no model call — the two-part anchor is a sharper mechanical signal, not a
step toward semantic classification. (2) `attemptQuestionDeflection` remains the only write path to question
state; every deflection this story constructs still goes through it unchanged. (3) The `git_history` and
`decision_ledger` matchers' fail-safe defaults: an unreadable source counts as no match, never an error that
blocks a question. (4) The story's own honest boundary that the interactive terminal loop is not built or
tested here.


## Review Triage Log

### 2026-09-23 — Review pass
- verdicts: 28 findings — high 5, medium 11, low 12, false 0, maybe-false 0
- findings:
  - `[high]` `[bad_spec]` BH1 — anchor matching can produce a false-positive deflection. Verified: `matchRepository` calls `conventionsSpeakingTo(conventions, anchor)`, which only checks whether the anchor string appears in an instruction file — it never compares the raised question's own content to what the file actually says. A question about "resolveProject's null return" and an unrelated question about "should resolveProject be exported?" share one anchor, so the second would be silently answered with the first's context. Unlike 2-3's staleness check, where a false result is soft (a flag a human reviews), a false-positive deflection here reaches nobody — the subagent gets a wrong answer and the mistake has no correction point. **User decision required.**
  - `[high]` `[patch]` BH2 — a ledger deflection's answer carries no context. Verified: `matchDecisionLedger` builds `decided in run <id> (question <qid>): <answer>` with no statement of what the prior question actually was, failing R3's "stands alone" rule — and the run id is embedded bare, unpunctuated, so AD-21's sweep removes the one thing that could have let a person trace it. Same location as my own pre-review finding on the run-id redaction; this finding adds the missing-context half.
  - `[high]` `[patch]` BH3 / EC-batch — `compressQuestions`/`mergeByAnchor` can throw and abort the whole batch. Verified: `assertAskableDraft` is called inline with no try/catch inside the merge path, and a test already locks in that a zero-window or oversized draft throws. One bad question currently discards every other card and every computed deflection in the same batch — the opposite of "an attempt never throws," which the module's own doc claims.
  - `[medium]` `[patch]` BH4 / EC-escape — `combine` silently drops what non-first askers declared. Verified in two independent reports: only the first asker's `escape` and `default_action` survive a merge; a second asker's differing escape or default action disappears with no record, contradicting the module's own "combining only happens when nothing is lost" rule.
  - `[medium]` `[patch]` BH5 — `mergeOnJudgment` skips the shortest-window rule `combine` enforces, so a judged merge can outlive an asker's own deadline — the exact hazard `combine`'s comment names and rules out for the mechanical path.
  - `[medium]` `[patch]` BH6 / EC-echo — `confirmSpecEcho`'s bounds check is incomplete (`0:`, negative or out-of-range lines are not refused), a refusal is thrown rather than returned (breaking "refusals are told, not thrown at"), a blank-wording amendment is accepted, two amendments to one line are both silently recorded, and there is no way to delete or add a criterion — only reword existing ones.
  - `[low]` `[patch]` BH7 / EC-splitter — the fallback splitter breaks its own stated rule: it never splits sentences but does split on every newline, so a wrapped sentence becomes two criteria, a title line becomes a criterion, and a line starting with a year has the year stripped as a false list marker.
  - `[low]` `[defer]` BH8 / IA — nothing in production calls the new pipeline yet; the ledger source is run-scoped because no run records its project id. Same shape as the "no production assembly point" gap carried since story 2-4 — not new, not blocking.
  - `[high]` `[patch]` BH9 — the deflection rate's counts do not mean what their names say. Verified: `reachedUser = raised.size - deflected.size`, which actually means "not deflected" and silently includes questions settled by a timeout default or a cancellation as if they "reached a person." Compounding: `raised` counts asked cards, and a merged card standing for several distinct subagent questions counts as one, so the metric cannot show what compression actually achieved.
  - `[low]` `[patch]` BH10 — error handling is inconsistent across the three sources: `matchRepository` re-throws unexpected errors, `matchDecisionLedger` uses a bare `catch {}` that also swallows programming errors, and `matchGitHistory` inherits a null-for-every-failure rule so a crashed `git log` is reported identically to "no commit names this," breaking "not deflected always says why."
  - `[low]` `[patch]` BH11 — several branches have no test: the redacted-ledger-answer skip, the blank-answer skip, `searchCommitHistory`'s `notesRef`/`limit` options, an anchor containing regex-special characters, and two instruction files where only the second names the anchor.
  - `[low]` `[patch]` BH12 — the "no second write path" guard is an allowlist of specific names (`node:fs`, `writeFileSync`, `questionPaths`), so a different runtime writer reached through a re-export would pass unnoticed; the guard proves less than its name claims.
  - `[low]` `[patch]` BH13 — a probable typo in the new memlog entry ("Choice/Noul/Score primitives") and its `(decision by user)`/`(event by user)` tags don't match the plain `(decision)` style the ADR entries just above use.
  - `[medium]` `[patch]` VG1 — nothing tests that a ledger decision whose answer was redacted is skipped; pre-verified, deleting the one guarding condition leaves every existing test green because none of them produces a redacted line.
  - `[medium]` `[patch]` VG2 — nothing tests that a `question.deflected` line with no matching `question.asked` line still counts as raised in the rate fold; pre-verified, the exact crash-repair case the module's own doc names is untested.
  - `[medium]` `[patch]` VG3 — nothing tests the escape-id collision refusal in `combine`; pre-verified, and the underlying gap is a pre-existing one — `QuestionDraftSchema` never checks option ids against the escape id at all, so the safety net a subagent's own draft would rely on isn't there either.
  - `[high]` `[patch]` VG4/4th-report-#1 — the ledger can deflect from a `timeout_default` resolver line, citing an expired default as though a person decided it. Verified directly: `matchDecisionLedger` has no check on the decision's `resolver` field at all. This contradicts Q7's own premise — a timeout default is definitionally not "answered."
  - `[medium]` `[patch]` 4th-#2 — the newest-wins rule breaks when the newest matching decision is the one that got redacted: the loop's `continue` on a redacted line leaves whatever older match it already found standing, so a superseded answer deflects while the code's own comment claims the newest one always supersedes it.
  - `[low]` `[patch]` 4th-#3 — a partially-written final line in the current run's own event log (append in progress) could mark the current run's log unreadable and miss its own recent decisions, re-triggering Q7 questions that were already answered this run.
  - `[low]` `[patch]` 4th-#4 — ledger matches are not ordered by the decision's own `resolved_at`; an older decision can win over a newer one purely by array position if the caller doesn't supply `ledgerRuns` oldest-first.
  - `[low]` `[patch]` 4th-#5 — CRLF-only instruction files never split into paragraphs, so the whole file becomes the deflection answer.
  - `[medium]` `[patch]` 4th-#6,7,8,9 — `searchCommitHistory` has no pagination past its result cap (a true match beyond the newest N commits is never found), inherits `execFileSync`'s default 1MB buffer with no distinction from "no commits," accepts a non-positive or non-integer `limit` silently, and an anchor containing a newline widens the git prefilter unexpectedly.
  - `[medium]` `[patch]` 4th-#10,11,12,13 — `drafted: []` (as opposed to `undefined`) silently discards the request's own stated criteria; an empty echo has no way to ever add a criterion through the amendment path; a blank-wording amendment is accepted (corroborates BH6); a numbered request line like "2026. …" has its year wrongly stripped as a list marker (corroborates BH7).
  - `[medium]` `[patch]` 4th-#14,15,16,17,18,19 — corroborates and sharpens BH4/BH5: every raised draft's escape id (not only the base's) must be checked against the option set; differing default actions should route to `awaitingJudgment` the same as differing defaults; `mergeOnJudgment`'s window should be the minimum across every raised draft, not the judged card's own value as given; one bad draft or merged group should be caught per-group rather than aborting the whole batch; an all-blank-brief merge can produce a brief that opens with blank lines.
  - `[low]` `[reject]` 4th-#20 — that "raised" undercounts real subagent questions when several merge into one card. Same root cause as BH9; not a separate finding.
  - `[low]` `[reject]` 4th-claim-conf-low — that the matrix-9 acceptance criterion ("same anchor merges") is contradicted by the differing-defaults/differing-options escape hatches. These are the documented exceptions the story itself anticipated ("a merge only happens when nothing is lost"), not a violation of the criterion.
  - `[medium]` `[patch]` 4th-claim-conf-high — same root cause as VG4/BH-timeout finding: readers would reasonably trust a ledger deflection as a human decision when some are expired defaults.
  - `[low]` `[defer]` IA-toAsk-cap — "at most one reaches the user" is not hard-capped in `compressQuestions`. Verified the concern is real but the mechanism already exists elsewhere: `src/engine/questions.ts:1140` and `src/tui/projection.ts:675` already serialise multiple pending questions through R14's single active-question slot, oldest first. Not a defect; the spec should state this explicitly rather than leave the interaction implicit.

- actions taken, per root cause (every `patch` and `bad_spec` row resolves to one of these):
  - **A — two-part anchor** (BH1; `bad_spec`, decided with the user). `RaisedQuestion.anchor` is now `{ symbol, aspect }`, both required; matching needs both parts as whole words in the same source; merging groups only on equality of both. `QuestionDeflection.anchor` stays a string for the record (`symbol:aspect`) and is never parsed back — no shipped contract changed. Verified independently: `anchorKey` uses a JSON pair rather than the display form specifically because `a:b`/`c` and `a`/`b:c` would otherwise collide.
  - **B — timeout exclusion** (VG4/4th-#1). Ledger lines whose resolver is `timeout_default` are never used; the verdict states how many were skipped. Verified: `TIMEOUT_RESOLVER` constant, checked before a line counts as a match.
  - **C — newest-wins by timestamp** (4th-#2). The newest matching decision is now picked by its own `resolved_at`, not by array position; a redacted or blank newest match reports no match rather than silently falling back to an older one.
  - **D — per-group failure isolation** (BH3, EC-batch). A draft or merged group that fails `assertAskableDraft` is now reported in a `refused` list; the rest of the batch still compresses. Each part of a group is checked individually before merging.
  - **E — nothing lost in a merge** (BH4, EC-escape). Every asker's escape and default action are checked, not only the base draft's; a divergence sends the group to `awaitingJudgment`.
  - **F — judged-merge window** (BH5). `mergeOnJudgment` now takes the shortest window across the judged card and every draft it replaces, shared with the mechanical path's own rule.
  - **G — spec-echo amendment handling** (BH6, 4th-#10-13). Every refusal is returned, never thrown; bounds, blank-wording, double-edits and blank additions are all refused with a stated reason; `removals` and `additions` let an empty echo gain a criterion.
  - **H — fallback splitter** (BH7, 4th-#12-13). List-aware splitting, wrapped-line joining, two-digit-only list markers so a year is read as prose, and an all-blank drafted list falls back to the request's own text.
  - **I — deflection-rate integrity** (BH9, 4th-#20; follow-up fix after the first round). `reachedUser`, `defaultTaken` and `unsettled` are now distinct fields. The merged-card count is a structured, optional field on the durable `QuestionSchema` record (`raised_question_count`), read first and validated as a safe integer ≥ 1; a brief-text parse remains only as the fallback for a `question.asked` line an older build wrote. I sent the first version of this fix back — it read the count by parsing a fixed sentence in the brief, undercounting silently whenever that sentence wasn't found, which reintroduced the defect this fix exists to close one layer indirect. Verified independently after the follow-up: the payload key, the preference order, and the non-vacuous test are all present.
  - **J — error-handling consistency** (BH10). The ledger's catch now covers only known read/parse errors; a git-history failure is distinguished from a genuine no-match and named in the verdict.
  - **K — `searchCommitHistory` correctness** (4th-#6-9). Returns `{ commits, failure }` so a real failure is distinguishable from "no commit names this"; `limit`/`skip` validated; a newline in the needle refused; the buffer raised and paging added up to 5,000 candidate commits, with the cap stated in the verdict rather than silently truncating.
  - **L — test and hygiene gaps** (BH11-13, VG1-3, 4th-#3-5). New tests for the redacted/blank ledger skips, `notesRef`/`limit`/`skip`, special-character anchors, two-instruction-file precedence, CRLF files, and multi-page history. The write-path guard now checks every import against a reviewed allowlist of readers rather than a list of forbidden writers. The memlog typo and tag mismatch corrected.

## Design Notes

## Verification

Run by me after both patch rounds, exit status captured to a variable and output kept in a file:
`npm run typecheck && npm run lint && npm run build && npm test` — **exit 0, 2601 tests across 86 files, zero
failures, zero skips.** Baseline `10393f1` was 2486/82; the implementation reached 2552/86, the first patch
round reached 2597/86, and the follow-up fix took it to 2601/86.

Thirteen mutations in the patch round, each applied, run and reverted, tree confirmed clean afterwards: the
aspect being ignored, merging on the symbol alone, timeouts counted as decisions, a redacted-newest silently
falling back, the per-group gate throwing again, the escape check, the default-action check, the judged
window, `reachedUser` reverting to "not deflected," cards counted instead of questions, blank wording
accepted, a duplicate-line edit unflagged, and paging removed from the git search. One follow-up mutation on
the count fix: the fold ignoring the structured field, caught by the test asserting the field wins over a
brief with no merge sentence.

**Verified by me directly, not taken on report.** The gate, twice. The two-part anchor's grouping key: a JSON
pair rather than the punctuated display form, specifically because `a:b`/`c` and `a`/`b:c` would otherwise
collide under a naive split. The `timeout_default` exclusion, both the constant and its use in the filter.
The structured `raised_question_count` field: the payload key exists, `raisedCountOf` prefers it and
validates it is a safe integer at least 1 before trusting it, and only falls back to parsing the brief when
the field is absent.

## Auto Run Result

**Status: done, reviewed.** Question compression is anchor-only throughout, now on a two-part anchor that
distinguishes two questions sharing one symbol; deflection excludes decisions nobody actually made; a bad
draft can no longer take down a whole batch; and the deflection rate's counts mean what their names say,
backed by a durable field rather than a text parse.

**Review findings: 28 across four layers** — high 5, medium 11, low 12. Routed 23 patch, 1 bad_spec, 2 defer,
2 reject. All 23 patches applied, plus one follow-up I asked for after independently reviewing the first
round's own fix.

**The one `bad_spec` cause was the design this story's own opening decision produced.** Anchor-only matching,
closed with the user at this story's start to avoid a third-party AI vendor, turned out to have a real
false-positive mode: two different questions sharing one symbol were indistinguishable to a bare-anchor
comparison, and a wrongly-deflected question reaches nobody — there is no correction point, unlike 2-3's
staleness check where a false result is a soft flag a human reviews. Decided with the user again: narrow the
anchor to two parts rather than add a semantic layer or accept the risk. Still entirely mechanical.

**One of the implementation's own fixes needed a second look, and I gave it one rather than accepting it on
report.** The first attempt at the deflection-rate fix measured a merged card's question count by parsing a
fixed sentence back out of the card's free-text brief, falling back to undercounting whenever that exact
sentence wasn't present — reintroducing, one layer indirect, the exact defect the fix existed to close. Sent
back for a structured field instead, which is this project's established answer to exactly this shape of
fragility. The implementer's own report flagged this same discomfort before I did ("worth your review"),
which is the right instinct — I just didn't let it stand as a documented trade-off when a cheap, precedented
fix was available.

**Follow-up review recommended: true**, per this project's own rule — a `high` was patched, three of
them: the per-group failure isolation, the deflection-rate integrity fix, and the timeout-default exclusion.
Every one was independently verified after the fix, including the one I sent back for a second attempt, so
this is not an unresolved risk in the ordinary sense — it is the rule applied as stated rather than waived
because the findings happened to be fixed well.

**Residual risks.** Seven deferred entries, one `high`: nothing calls the compression or spec-echo pipeline in
production. That gap now spans a sixth engine surface (analysis, planning, implementation, testing/
verification, committing, and now the Interviewer) with no story in `stories.yaml` owning the assembly. The
interactive terminal loop itself remains untested by design, the same honest boundary story 2-6 recorded for
its MCP stdio transport.
