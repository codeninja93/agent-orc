---title: Question lifecycle — compare-and-set with three resolvers
type: feature
created: '2026-09-20'
status: done
review_loop_iteration: 1
followup_review_recommended: true
context:
- '{project-root}/docs/planning-artifacts/architecture/architecture-agent-orcastrator-2026-09-19/ARCHITECTURE-SPINE.md'
- '{project-root}/docs/specs/spec-agent-orchestrator/interface-contract.md'
- '{project-root}/docs/specs/spec-agent-orchestrator/stories/1-7-command-transport.md'
- '{project-root}/docs/specs/spec-agent-orchestrator/stories/1-3-engine-reconciler.md'
warnings:
- oversized
deferred:
- summary: 'RESOLVED 2026-09-21: the four-layer review ran. See the Review Triage Log.'
  evidence: 54 claims filed, 22 triage rows, 14 patched including two high plus ADR-002's code half. Suite
    1391 -> 1420 tests across 51 files, zero skips. Nine mutations that had left the suite green are now
    each caught.
  severity: high
- summary: 'CROSS-STORY: the recorder''s writer claim and the engine lock share the torn-read window this
    story found, with a milder consequence — and it compounds a defect story 1-3''s review already deferred.'
  evidence: 'Story 1-8 discovered that open(path,''wx'') is an atomic test-and-set on the NAME only: it

    publishes a zero-length file, so a reader in the window before the winner''s write sees a torn

    record. src/runtime/recorder.ts and src/engine/lock.ts both use ''wx''-then-write. The parent

    checked the consequence and it differs: a lock''s content is diagnostic (pid/host for staleness)

    while the create is what decides the winner, and readClaim catches a parse failure and returns

    null, which degrades to REFUSING the lock — the fail-safe direction. So mutual exclusion is

    intact. What it compounds is story 1-3''s deferred EC15: an empty lock file, whether from this

    race window or from a claim write that failed, reads as null, is therefore never reclaimable,

    and leaves ORCH_HOME permanently unstartable. The same temp-fsync-link(2) technique this story

    adopted would close both.'
  location: src/runtime/recorder.ts, src/engine/lock.ts
  severity: medium
- summary: An answer intent is not addressable to a specific question.
  evidence: 'CommandIntent has no question-id field and src/contracts/command.ts sits outside this story''s

    Code Map, so an answer resolves the run''s earliest still-asked question and falls back to the

    most recently settled one so a late answer is told which decision stood. Correct today because

    R14 gives one active question at a time; a later story needing to answer one of several

    concurrent questions needs an addressable field.'
  location: src/engine/steering.ts
  severity: medium
- summary: A reject records its reason as the decision's answer and does not auto-select the escape option.
  evidence: 'Guessing which option a rejection meant, and then attributing that guess to a person, is
    the one

    thing AD-25''s attribution rule exists to prevent. The consequence is that option_id is usually

    null on a rejection.'
  location: src/engine/steering.ts
  severity: low
- summary: A due default is not taken on a terminal run; the question keeps its asked state.
  evidence: 'The honest record: nobody answered and the run ended. It does mean a terminal run can hold
    a

    question that never resolved, which a renderer in story 1-10 will have to present as something

    other than pending.'
  location: src/engine/question-window.ts
  severity: low
- summary: 'SPEC DECISION NEEDED: `reject` cannot serve the CAP-18 case its own note cites — rejection
    at an approval gate.'
  evidence: '`approve` is `{ kind: ''effect'' }` and acts on a `blocked` run; `reject` is `{ kind: ''question''
    }`, so

    it only works when a question happens to be open and is otherwise refused `no-open-question` and

    quarantined. Giving it a non-question path means declaring what a rejected gate does to the run, and

    no such transition exists: `approve` answers `blocked -> running`, and nothing in the lifecycle or

    the spine says whether a rejection at a gate kills the run, hands it off, or narrows it. Guessing

    would invent a lifecycle transition, so this round patched only the honesty of the refusal — a

    blocked run is now named as a blocked run, the refusal states that the gate still stands and was not

    rejected, and it no longer describes machinery under `questions/` that the person never saw

    (`tests/engine.questions.test.ts`, "a rejection at an approval gate is refused without describing
    a

    question nobody saw"). `edit_criterion` has the same shape, and story 1-11 added

    `spec.criterion_edited` as a separate declared event, which is evidence that surface was never this

    story''s.'
  location: src/engine/reconciler.ts, src/runtime/steering-view.ts
  severity: medium
- summary: That only `EEXIST` means a lost race is correct but untested, and faking the filesystem is
    the wrong way to test it.
  evidence: 'Replacing the errno check in the exclusive create with an unconditional `return false` leaves
    the

    suite green, so an I/O fault would be reported to a user as "somebody else answered first" and then

    surface as `internal.invariant_violated` when the outcome read back as absent. The check as written

    is right, and the realistic trigger set for a `linkSync`-specific non-`EEXIST` errno is small — a

    read-only filesystem, a full disk, a permission fault — none of which a test can produce without

    mocking `node:fs`, which would pin the mock rather than the behaviour. Recorded rather than faked.

    The shared `src/runtime/exclusive-create.ts` now holds the one copy of the idiom, so a future test

    of it covers both call sites at once.'
  location: src/runtime/exclusive-create.ts
  severity: low
- summary: '`listQuestionIds`''s `.sort()` cannot be mutation-killed on macOS, because APFS `readdir`
    already returns these names in order.'
  evidence: 'Measured: `readdirSync` over four directories created in descending name order returns them

    ascending on APFS, so removing `.sort()` leaves both the ordering test and the targeting test green

    locally. The consequential half is covered — flipping `activeQuestion` from earliest to latest fails

    two tests in `tests/engine.questions.test.ts` — and the ordering contract is asserted

    (`listQuestionIds` equals the minted order for a directory built in reverse), which would catch the

    mutation on a filesystem whose `readdir` is unordered, as ext4''s hash order is. A Linux run of that

    one suite would close it.'
  location: src/engine/questions.ts, tests/engine.questions.test.ts
  severity: low
- summary: The crash-injection suite's boundary count is unchanged at 23, because its fixture plan asks
    no question.
  evidence: 'So this story''s new durable writes add no boundaries there, and question crash-convergence
    is

    covered directly instead: a claim created with nothing logged — exactly what a kill between the

    link and the append leaves — is finished by a later pass, appending each of the three lines

    exactly once. That is adequate but it is a different test from the dynamic sweep, and a future

    story that makes the crash fixture ask a question would cover it more strongly.'
  location: tests/engine.crash-injection.test.ts
  severity: low
baseline_revision: fbd2365484928862defd46b168298e683198b095
---

<intent-contract>

## Intent

**Problem:** Story 1-1 shipped the question state machine as pure functions — `resolveQuestion` refuses a state that is not `asked` — but purity is not a compare-and-set. Two processes can both read `asked` and both write, which is exactly the race AD-25 exists to prevent, and nothing durable exists at all: no question file, no window, no timeout. Story 1-7 consequently had to park `answer`, `reject` and `edit_criterion` unconsumed rather than swallow a user's answer before its owner existed. So no question can be asked, answered, or allowed to time out.

**Approach:** Make the transition durable and provably single-winner across processes, give a question the window CAP-4 requires and a timeout resolver that competes in the same compare-and-set, record the decision a resolved question leaves behind, and un-park the three steering commands story 1-7 reserved for this story.

## Boundaries & Constraints

**Always:**
- A question is durable at `runs/<run-id>/questions/`, and exactly one transition from `asked` is ever accepted — proven across processes, not merely within one.
- The three resolvers are the TUI answer, the web answer and the timeout default. Whichever wins records its resolver and its principal; every later resolver receives an already-resolved result and writes nothing.
- Every question carries a recommended default, at most three concrete options plus an escape, a self-contained brief, and the window after which the default is taken. A question missing any of them is refused rather than asked.
- When the window expires the default is taken, emitted as `question.default_taken`, and recorded as a decision — non-response is a valid input, not a stall.
- Only a resolved question leaves a decision record. A deflected question emits `question.deflected` and records nothing, because nobody was asked.
- The vocabulary is `question.asked`, `question.resolved`, `question.default_taken` and `question.deflected`, all already declared in the contracts.
- Every durable write precedes the effect it describes, and the effect is idempotent on the question id, so a crash mid-transition produces one outcome rather than none or two.
- An answer is free text; the system parses it. No format is imposed on the human.
- `src/engine/` continues to import only from `src/contracts/`, `src/runtime/` and `node:` builtins, and still names no container runtime.

**Never:**
- Never accept a second transition, and never let a losing resolver's write reach disk — refusing after the fact is not a compare-and-set.
- Never prove single-winner behaviour with an in-process test alone. Two functions racing in one event loop demonstrate nothing about two processes racing on a filesystem.
- No TUI, no key bindings, no rendering of a question card — story 1-10 owns the one-question card, and 1-9 the shell.
- No loopback server and no web resolver implementation — story 3-1 adds one and it writes through this same transition.
- No question compression, no deflection *decision*, and no Interviewer — story 2-8 decides whether a question should be asked at all; this story only records that a deflection happened.
- No queryable decision ledger and no retrieval — story 5-3 builds that. This story emits the events that constitute the record.
- No batching, no do-not-disturb window, and no ten-second interruption rule — those are the Interviewer's in 2-8.
- Never put an unbroken high-entropy question id in an event payload and expect to read it back: story 1-7 established that the AD-21 pass replaces such runs, and a key that lives only in a payload is a key that can be redacted away.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Question asked | A valid draft with default, window, brief, options and escape | Durable at `questions/`, `question.asked` emitted | No error expected |
| Missing default or window | A draft with no recommended default, or no window | Refused, naming the field; never asked | CAP-4 is unsatisfiable without both |
| Missing brief | A draft with no self-contained brief | Refused, naming the field | Q3 requires answerability without reloading context |
| Too many options | A draft with four options | Refused | Q1 allows at most three plus an escape |
| First resolver wins | An `asked` question and one answer | Resolved, with resolver and principal recorded | No error expected |
| Second resolver loses | An answer arriving after the question resolved | An already-resolved result; nothing written | The first outcome stands |
| Three-way race | A TUI answer, a web answer and an expiring window, concurrently, in separate processes | Exactly one transition exists on disk; two resolvers are told they lost | No interleaved or partial state |
| Window expires | An `asked` question whose window has passed with no answer | The default is taken, `question.default_taken` emitted, a decision recorded | Never a stall |
| Answer beats the window | An answer arriving before expiry | The answer wins and the default is never taken | No double resolution |
| Window beats the answer | An answer arriving after the default was taken | Already-resolved; the default stands | The human is told it timed out |
| Deflected | A question answered from repository, history or ledger | `question.deflected` emitted, no decision recorded, no resolver | Nobody was asked, so nothing is attributed |
| Answer to a resolved question | An `answer` intent for a resolved question | Refused as already-resolved and retired | Not a poison file |
| Torn question file | A partially written question state file | Refused, no transition | Never a partial read |
| Crash mid-transition | The process killed between the durable write and its effect | Exactly one outcome after restart | Neither lost nor doubled |
| Rejection with a reason | A `reject` intent carrying a reason | The reason is recorded as the decision | The reason is never discarded |

</intent-contract>

## Code Map

Story 1-1 shipped the pure state machine and story 1-7 shipped the intent transport that feeds this one. What is missing is everything durable.

- `src/runtime/paths.ts` -- modify, additively; add the `questions/` directory and the per-question paths, exactly as story 1-7 added `commands/`
- `src/engine/questions.ts` -- create; ask a question durably, and perform the transition as a real compare-and-set whose single winner is provable across processes. Reuse story 1-1's `resolveQuestion`/`deflectQuestion` for the decision and add the durability around them rather than reimplementing the state machine
- `src/engine/question-window.ts` -- create; the CAP-4 window: when a question's default becomes due, and taking it as a resolver competing in the same compare-and-set
- `src/engine/decision.ts` -- create; the record a resolved question leaves — emitted as events, since AD-4 makes the log the durable truth and story 5-3 builds the queryable index over it
- `src/engine/steering.ts` -- modify; move `answer`, `reject` and `edit_criterion` from `awaiting` to honoured, routing each through the transition
- `src/engine/reconciler.ts` -- modify, additively; take a due default during a pass, and consume the three un-parked intents
- `src/engine/index.ts` -- modify; export what stories 1-10 and 3-1 need to ask and answer without learning the layout
- `tests/engine.questions.test.ts` -- create; the draft refusals, asking, the happy resolution, deflection, and that only a resolved question records a decision
- `tests/engine.question-race.test.ts` -- create; the single-winner property driven from **separate processes**, the way story 1-3's lock suite drives real children
- `tests/engine.question-window.test.ts` -- create; the default taken on expiry, an answer beating the window, the window beating an answer, and the decision recorded either way

Read-only evidence, authoritative and not to be edited by this story:

- `ARCHITECTURE-SPINE.md` -- AD-25 (one accepted transition, three resolvers, the resolver and principal recorded, only a resolved question writes the ledger, the four event types), AD-4, AD-19, AD-9
- `interface-contract.md` -- Q1 through Q7 and the one-question card's required content: recommended default, at most three options plus an escape, what happens if ignored and the window, a self-contained mini-brief, free-text answers, and a question answered once becoming a rule
- `src/contracts/question.ts` -- `QuestionDraftSchema` and its Q1 refinements, `QuestionStateSchema`, `resolveQuestion`, `deflectQuestion`, `QUESTION_RESOLVERS`, `writesToDecisionLedger`, `eventTypeForResolution`, `offeredOptionIds`
- `src/engine/commands.ts`, `src/engine/steering.ts` -- the intent transport and the `awaiting` table naming this story as the owner of three commands
- `tests/engine.lock.test.ts` -- how a cross-process race is driven honestly here: a real child, a real signal, an exit listener attached before the child can exit

Carried forward from stories 1-1 through 1-7:

- **Story 1-1's transition is pure and therefore not yet a compare-and-set.** `resolveQuestion` refuses a state that is not `asked`, but two processes that both read `asked` will both pass that check. The durability is this story's whole subject.
- **Story 1-7's intent-id lesson applies directly.** The exactly-once key lived in an event payload, which is where the AD-21 pass replaces unbroken high-entropy runs; a bare ULID was redacted and `mintIntentId` punctuates it. A question id used the same way needs the same treatment.
- **Story 1-3's lock suite is the model for the race test.** It spawns real children, uses a real `SIGKILL`, and attaches the exit listener before the child can exit — a bug the parent introduced and then fixed. An in-process race test would be the equivalent of the vacuous `'a'.repeat(40)` fixture that story 1-3's review caught.
- Story 1-7 parks a command by leaving its file in place, unconsumed and reported. Un-parking three of them means those files stop accumulating; check that the `awaiting` table and its test stay honest about what is left.
- Story 1-3's crash-injection suite discovers boundaries dynamically, so new durable writes inside a pass will add boundaries. It must still converge.

## Tasks & Acceptance

**Execution:**
- `src/runtime/paths.ts` -- add the `questions/` paths -- one module owns the AD-9 layout, and a second spelling would be a second layout
- `src/engine/questions.ts` -- ask durably, refusing a draft that lacks a default, a window, a brief, or that offers more than three options -- a question that cannot be answered without reloading context, or that has no stated consequence for silence, is one the interface contract forbids asking
- `src/engine/questions.ts` -- make the transition a real compare-and-set with a provable single winner, built on an atomic filesystem primitive rather than a read-then-write -- AD-25 exists because three resolvers race, and a check that precedes a write is not a guard
- `src/engine/question-window.ts` -- compute when a default is due and take it as a competing resolver -- CAP-4 makes non-response a valid input, so the timeout is a resolver and not a special case
- `src/engine/decision.ts` -- record the decision a resolved question leaves, and record nothing for a deflected one -- AD-25 says only a resolved question writes the ledger, because nobody was asked when it was deflected
- `src/engine/steering.ts` -- honour `answer`, `reject` and `edit_criterion`, routing each through the transition, and carry a rejection's reason into the decision -- story 1-7 parked them here rather than swallow an answer before this story existed
- `src/engine/reconciler.ts` -- take a due default during a pass and consume the three un-parked intents -- a default that only fires when something else happens to run is not a window
- `src/engine/index.ts` -- export the ask-and-answer surface -- stories 1-10 and 3-1 resolve a question without learning where it lives
- `tests/engine.questions.test.ts` -- cover the draft refusals, the happy path, deflection, and the decision record -- the refusals are where the interface contract becomes machine-checked rather than aspirational
- `tests/engine.question-race.test.ts` -- drive the single-winner property from separate processes -- an in-process test of a cross-process guarantee proves nothing, which is the lesson story 1-3's lock suite paid for
- `tests/engine.question-window.test.ts` -- cover expiry, an answer beating the window, and the window beating an answer -- the last is the case a user experiences as "it timed out while I was typing", so it must be unambiguous

**Acceptance Criteria:**
- Given a clean checkout on Node `>=22.22`, when `npm run typecheck && npm run lint && npm test && npm run build` is run, then all four succeed and the question suites appear in the test output.
- Given a draft with no recommended default, no window, no brief, or four options, when it is asked, then it is refused naming the missing or offending field and no question exists on disk.
- Given an `asked` question and two answers from **separate processes**, when both attempt the transition, then exactly one transition exists on disk, the winner's resolver and principal are recorded, and the loser receives an already-resolved result having written nothing.
- Given an `asked` question whose window has passed, when a pass runs, then the default is taken, `question.default_taken` is emitted, and a decision is recorded.
- Given an `asked` question whose window has not yet passed, when an answer arrives, then the answer wins and no default is ever taken; and given a question whose default has already been taken, when an answer arrives, then it is told the question is already resolved and the default stands.
- Given a question answered from the repository, history or the ledger, when it is deflected, then `question.deflected` is emitted and no decision is recorded.
- Given a `reject` intent carrying a reason, when it is applied, then that reason is present in the recorded decision.
- Given the process killed between a transition's durable write and its effect, when a later pass runs, then exactly one outcome exists.
- Given an `answer` intent for an already-resolved question, when a pass runs, then it is refused as already-resolved and retired rather than re-read on every later pass.
- Given `src/engine/`, when its imports are inspected, then it imports only from `src/contracts/`, `src/runtime/` and `node:` builtins.
- Given story 1-3's crash-injection suite, when it runs after this story's changes, then it still converges on every boundary it discovers.

## Spec Change Log

## Review Triage Log

### 2026-09-21 — Review pass (follow-up, on a `done` spec)

- claims filed: 54 across four layers — blind-hunter 14, edge-case-hunter 22, verification-gap 5 gap + 4
  other, intent-alignment 9 divergences. The edge-case layer filed an enumerated list so its count is exact;
  the other three wrote prose, so those are my enumeration of the distinct claims each made.
- grouped into the 22 rows below. 14 patch entries applied, 5 deferred, the rest rejected. No filed claim is
  without a row.
- this pass also carried the code half of **ADR-002**, accepted the same day, which is why a `high` row below
  is an architecture amendment rather than a defect.
- **Three rows record errors in my own patch brief.** I passed three layer claims into it without verifying
  them first, and the patch round disproved all three by running the mutations rather than accepting my
  word. That is the correct outcome and it is recorded rather than quietly dropped, because the brief is
  part of this review's work product.

- `[high]` `[patch]` LIVE DEFECT, not a test gap: a due default was taken against a run the same pass had just killed. `pass()` consumes intents and then settles questions, and `settleQuestions` re-read the *ledger* from the log — with a comment explaining exactly why it had to — while taking the *feature state* from the stale loaded value two lines later. A run with an overdue question and a `kill` intent came out of one pass with `question.default_taken` and `decision.recorded` written against a run that pass had killed; probed at `decisionRecorded: true`. Fixed by applying the comment's own reasoning to the state.
- `[high]` `[patch]` Every losing resolver was told the window timed out, whatever it actually lost to. Neutralising `describeDefaultTaken`'s non-timeout branch left the suite green, because its one test asserts `/already|stands/i` and the timeout sentence also contains "stands", while the deflection case asserted only the error class. A user who lost to a colleague's answer was told the clock beat them — the precise divergence the module's own comment says the message exists to prevent. Now three honest branches, and the two non-timeout ones end "No window expired and no default was taken."
- `[high]` `[patch]` ADR-002's code half: `QuestionOutcomeSchema` moved from `src/engine/questions.ts` into `src/contracts/question.ts`, and `decision.recorded` was declared in `src/contracts/event.ts`. Before: `isDeclaredEventType('decision.recorded')` returned `false` while `question.resolved` returned `true`, so AD-25's required decision ledger was written with a type no contract declared, and the contended artifact's shape was only stated inside the engine — where story 3-1's web renderer, the second resolver AD-25 exists to arbitrate, may not read it. Verified after: the declaration returns `true`, the schema is in contracts, and the engine still re-exports it so no caller changed.
- `[medium]` `[patch]` Which question an answer resolves was entirely unverified: no test anywhere had two questions open on one run, and neither `activeQuestion` nor `lastSettledQuestion` was referenced by any test. Flipping `activeQuestion` from earliest to latest left the suite green, so a person's answer, principal and decision record could attach to a question they were never shown. Three new tests with two and four concurrent questions.
- `[medium]` `[patch]` The four durable payloads were unasserted beyond `question_id`. Deleting `option_id`, `resolved_at`, `resolver`, `principal_kind`, `principal_id`, `source` or `anchor` each left the suite green, because the tests asserting those read the *derived* `state.json` rather than the log line — while AD-4 makes the log the only authority and story 5-3 indexes exactly these lines. Now asserted as the log holds them.
- `[medium]` `[patch]` Free-text answers were not guarded against AD-21 redaction the way question ids are, so an answer containing a SHA or token landed `[redacted]` in the log while `state.json` kept it verbatim, and `decision.ts`'s claim that a rejection's reason "is never discarded" stopped being true of the ledger. Closed without touching the allow-list: a new `redacted_fields` key names which of the line's own fields the pass rewrote, computed with the real redactor under the run's active policy. The test uses a real ULID and asserts the fixture is non-vacuous first.
- `[medium]` `[patch]` `cli` answers were attributed to the `tui` resolver — the non-exhaustive default `steering.ts` explicitly forbids in its own comment, and a fifth source would have joined the same bucket silently. Now a total record; adding a source is a compile error (verified: TS2741). The runtime answer for `cli` is unchanged and now deliberate rather than accidental.
- `[medium]` `[patch]` `mintQuestionId('')` returned the literal `"q-"`, the same degenerate-seed defect story 1-7's `mintIntentId` had — while `questions.ts` claimed "the same bound, for the same reason, as story 1-7's intent id". The parity is now real: seed validated, output asserted, and `isLoggableQuestionId` reads the active `RedactionPolicy` instead of a literal 23.
- `[medium]` `[patch]` `listQuestionIds` silently hid any question directory whose name failed `isLoggableQuestionId`, so a question from an older build or from story 3-1's resolver was invisible to every pass — no window, no event, no refusal — unlike a torn state file, which is reported. Now reported as a refusal by name.
- `[medium]` `[patch]` `readQuestionState`/`readQuestionOutcome` treated every read failure as absence, so EACCES or EISDIR made a claimed question read as unclaimed — letting a pass take a second default over it — and an asked question read as never asked. Now distinguished, with tests using a directory where the file belongs so the errno is deterministic without mocking `node:fs`.
- `[medium]` `[patch]` A terminal run's abandoned question was reported as "open, none due" while the `open` field's docblock said "whose window has not yet passed". A new `abandoned` bucket separates "still waiting" from "abandoned unanswered", which is what story 1-10's renderer needs to tell them apart.
- `[medium]` `[patch]` `QuestionOutcomeSchema.intent_id` reused `QuestionSchema.shape.id`, coupling intent-id validity to question-id rules. Now validated with the command contract's own rules and covered by a real minted intent id, where the existing redelivery test used a hand-made `'cmd-1'`.
- `[medium]` `[patch]` The cross-process race suite's central assertion was timing-dependent and could fail for the very scheduling reason it exists to rule out: a loser descheduled past the barrier reads `resolved` and reports `contended: false`. Losses arrive through two branches, contrary to the code comment claiming one. Both are now admitted without weakening the proof — every non-winner must be refused, must name the winner, and if it did not contend must have read a resolved question.
- `[medium]` `[patch]` Seven smaller real defects: nothing swept `questions/*/*.tmp` debris, so the race suite's directory assertion would fail after any unrelated crash; the directory was never fsynced, so the published name could be lost though the contents were synced; `deriveState` returned the unchanged state when the pure transition refused, which let a settled question report an `eventType` for an `asked` state; `assertAskableDraft` accepted a fractional window and one large enough to make `formatTimestamp` throw; the suites spelled `state.json`/`outcome.json` as literals that `paths.ts` exists to keep single; and `QUESTION_DRAFT_FIELDS` read as the table the refusals should be driven from while `assertAskableDraft` hard-coded field names — it now drives them, so a new field without a rule is a compile error.
- `[medium]` `[defer]` SPEC DECISION NEEDED: you can `approve` a blocked gate but you cannot `reject` one. `approve` is an effect that acts on a blocked run; `reject` is a question resolver, so it works only when a question happens to be open and is otherwise refused and quarantined — while its own note cites CAP-18, rejection at an approval gate, which is exactly the case it cannot serve. Giving `reject` a non-question path means declaring what a rejected gate does to the run, and no such transition exists in the lifecycle or the spine. Not guessed. What was patched is the refusal's honesty: it now says the gate still stands, that nothing changed, that `approve` is what approves a gate, and that what a rejection should do is not a transition this build declares — instead of describing machinery under `questions/` the person never saw. `edit_criterion` has the same shape, and story 1-11's `spec.criterion_edited` is evidence that surface was never this story's.
- `[medium]` `[defer]` The cross-process guarantee is proved one surface below where it ships. All three resolvers serialise through the single process holding the AD-30 lock, so in production the winner is decided by pass ordering and `link(2)` arbitrates only when a second process resolves directly — and the race suite's children deliberately never take that lock. Defence in depth rather than dead code, since story 3-1 is the second process, but the property that matters for 3-1 is untested until 3-1 exists. Recorded rather than patched: it needs 3-1.
- `[low]` `[defer]` Only `EEXIST` means a lost race, and replacing the check with an unconditional `return false` leaves the suite green — so an I/O fault would be reported to a user as "somebody else answered first". The check as written is correct and the realistic non-`EEXIST` trigger set for `linkSync` cannot be produced without mocking `node:fs`, which would pin the mock rather than the behaviour. Deferred deliberately, not faked.
- `[low]` `[defer]` Removing `.sort()` from `listQuestionIds` cannot be killed on this machine: APFS `readdirSync` returns these names ascending regardless of creation order, so the filesystem supplies the ordering the code also supplies. Measured, not assumed. The consequential half — `activeQuestion` picking earliest — is killed by the new tests.
- `[false]` `[reject]` MY BRIEF WAS WRONG, three times, and the patch round caught all three. (1) The terminal guard was said to be unverified for the question commands; running the mutation showed the existing all-`COMMANDS` test already fails, because its fixture supplies a non-null argument for those three by construction. (2) A stale comment was reported at `tests/engine.steering.test.ts:233`; line 233 is `});` and no such comment exists anywhere in the test tree. (3) The `intent_id` coupling was said to make `outcomeRecord` throw; `QuestionSchema.shape.id` is a bare `z.string()`, so nothing throws today — the coupling was real, the live throw was not. All three came from layer reports I passed into the brief without verifying first, which is the thing triage exists to prevent. (3 findings)
- `[false]` `[reject]` "Losing resolvers write to disk" as a Never violation. Verified in `deriveState`: a loser writes no decision, converges `state.json` only to the winner's content, and skips even that when the winner got there first. The mechanism is sound; the invariant's wording was wrong, and ADR-002 corrected the sentence rather than the code.
- `[low]` `[reject]` Nine hardening suggestions on inputs no caller can supply, and cosmetic notes already true or corrected elsewhere in this round. (9 findings)
- `[maybe-false]` `[defer]` Three claims about behaviour under two concurrent engine processes, which AD-30 forbids. Recorded with what would settle them. (3 findings)

## Design Notes

**A compare-and-set needs an atomic primitive, not a careful order.** Story 1-1's `resolveQuestion` checks the status and then returns a new state; a caller that writes that state has performed read-then-write, and two callers can both read `asked`. The repository already contains the right primitive used twice: an exclusively created file. The recorder's writer claim and the engine lock both rely on `O_EXCL` failing for the second creator, which is a genuine atomic test-and-set on every filesystem this runs on. The shape that follows: the *resolution* is an exclusively created file, the first creator wins by construction, and the question's state file is derived from it rather than being the thing contended for. Any design where the winner is decided by comparing timestamps, or by reading before writing, will pass a single-process test and fail in production.

**The race test has to be cross-process or it is theatre.** Two promises racing in one event loop share a filesystem cache and an interpreter; they cannot demonstrate that two `open(O_EXCL)` calls from different processes resolve to one winner. Story 1-3's lock suite established the honest pattern here, including the bug the parent introduced and fixed: attach the child's exit listener before the child can exit. Spawn real children, have them contend, and assert that exactly one reports success.

**"It timed out while I was typing" is the case worth being unambiguous about.** Two of the three resolvers are a person and a clock, and they will collide. Whichever wins, the other must be told plainly what happened — not silently discarded — because a user who believes their answer landed and a system that took the default have diverged about a decision, and AD-25 makes that decision durable. The losing path's message is part of the contract, not an afterthought.

## Verification

**Toolchain:** the PATH default `node` on this machine is v22.14.0, below the declared floor. Use the nvm-installed Node 24.x LTS by absolute path:

```
export PATH="/Users/deep/.nvm/versions/node/v24.21.0/bin:$PATH"   # node v24.21.0, npm 11.19.0
```

**Commands:**
- `npm run typecheck` -- expected: exit 0
- `npm run lint` -- expected: exit 0
- `npm test` -- expected: exit 0; the questions, race and window suites present and passing
- `npm run build` -- expected: exit 0
- `npx vitest run tests/engine.crash-injection.test.ts` -- expected: still converges on every discovered boundary
- `grep -rn "from '\.\./" src/engine/` -- expected: only `../contracts/...` and `../runtime/...`

## Auto Run Result

**Status: done, reviewed.** The four-layer review ran on 2026-09-21 as a follow-up pass on a `done` spec. 54
claims filed, 22 triage rows, 14 patched, 5 deferred. Suite 1391 -> 1420 tests across 51 files, zero skips.
This pass also carried the code half of ADR-002, accepted the same day.

**One live defect, and the fix was already written in a comment above the bug.** A due default was taken
against a run the same pass had just killed: `settleQuestions` re-read the *ledger* from the log — with a
comment explaining exactly why it had to — and then took the *feature state* from the stale loaded value two
lines later. The fix applies that same reasoning to the state.

**One user-facing lie.** Every losing resolver was told the window timed out, whatever it had actually lost
to, because the one test covering the other branch asserts `/already|stands/i` and the timeout sentence also
contains "stands". A person who lost to a colleague's answer was told the clock beat them — the exact
divergence the module's own comment says that message exists to prevent.

**ADR-002's code half.** `QuestionOutcomeSchema` moved into `src/contracts/question.ts` and
`decision.recorded` is now declared, so `isDeclaredEventType('decision.recorded')` returns `true` where it
returned `false`. The engine re-exports the schema, so no caller changed.

**One thing that needs your decision rather than a patch.** You can `approve` a blocked gate but you cannot
`reject` one: `approve` is an effect, `reject` is a question resolver, so it only works when a question
happens to be open — while its own note cites CAP-18, rejection *at a gate*, which is the case it cannot
serve. Giving it a non-question path means declaring what a rejected gate does to the run, and no such
transition exists. Not guessed; the refusal's wording was made honest instead, and the decision is recorded.

**Three rows in the triage log record errors in my own patch brief**, which the patch round disproved by
running the mutations. I had passed three layer claims through without verifying them first. Recorded rather
than dropped.

**Residual risk, and why `followup_review_recommended` is true.** Two high entries were patched. The specific
unverified risk: `redacted_fields` is a new payload key computed with the live redactor at append time, and
the redaction pass is the one invariant with no remedy — `git diff` on `redaction.ts` is empty, so nothing
about the pass itself changed, but a new key that *describes* the pass is a new way for the description to
drift from what the pass did.
