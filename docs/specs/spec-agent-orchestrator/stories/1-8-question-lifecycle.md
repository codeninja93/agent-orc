---
title: 'Question lifecycle — compare-and-set with three resolvers'
type: 'feature'
created: '2026-09-20'
status: 'done'
review_loop_iteration: 0
followup_review_recommended: true
context:
  - '{project-root}/docs/planning-artifacts/architecture/architecture-agent-orcastrator-2026-09-19/ARCHITECTURE-SPINE.md'
  - '{project-root}/docs/specs/spec-agent-orchestrator/interface-contract.md'
  - '{project-root}/docs/specs/spec-agent-orchestrator/stories/1-7-command-transport.md'
  - '{project-root}/docs/specs/spec-agent-orchestrator/stories/1-3-engine-reconciler.md'
warnings: ['oversized'] # 10 files and 15 I/O scenarios; the cross-process compare-and-set is the whole subject
deferred:
  - summary: >-
      Review was SKIPPED for this story; no review layers ran.
    evidence: |-
      The gate plus the parent's own probes and mutations are the only scrutiny. Stories 1-3 and 1-4
      each produced 56 and 60 findings at this stage. Read status: done as implemented and gated, not
      reviewed.
    severity: high
  - summary: >-
      CROSS-STORY: the recorder's writer claim and the engine lock share the torn-read window this
      story found, with a milder consequence — and it compounds a defect story 1-3's review already
      deferred.
    evidence: |-
      Story 1-8 discovered that open(path,'wx') is an atomic test-and-set on the NAME only: it
      publishes a zero-length file, so a reader in the window before the winner's write sees a torn
      record. src/runtime/recorder.ts and src/engine/lock.ts both use 'wx'-then-write. The parent
      checked the consequence and it differs: a lock's content is diagnostic (pid/host for staleness)
      while the create is what decides the winner, and readClaim catches a parse failure and returns
      null, which degrades to REFUSING the lock — the fail-safe direction. So mutual exclusion is
      intact. What it compounds is story 1-3's deferred EC15: an empty lock file, whether from this
      race window or from a claim write that failed, reads as null, is therefore never reclaimable,
      and leaves ORCH_HOME permanently unstartable. The same temp-fsync-link(2) technique this story
      adopted would close both.
    location: >-
      src/runtime/recorder.ts, src/engine/lock.ts
    severity: medium
  - summary: >-
      An answer intent is not addressable to a specific question.
    evidence: |-
      CommandIntent has no question-id field and src/contracts/command.ts sits outside this story's
      Code Map, so an answer resolves the run's earliest still-asked question and falls back to the
      most recently settled one so a late answer is told which decision stood. Correct today because
      R14 gives one active question at a time; a later story needing to answer one of several
      concurrent questions needs an addressable field.
    location: >-
      src/engine/steering.ts
    severity: medium
  - summary: >-
      A reject records its reason as the decision's answer and does not auto-select the escape option.
    evidence: |-
      Guessing which option a rejection meant, and then attributing that guess to a person, is the one
      thing AD-25's attribution rule exists to prevent. The consequence is that option_id is usually
      null on a rejection.
    location: >-
      src/engine/steering.ts
    severity: low
  - summary: >-
      A due default is not taken on a terminal run; the question keeps its asked state.
    evidence: |-
      The honest record: nobody answered and the run ended. It does mean a terminal run can hold a
      question that never resolved, which a renderer in story 1-10 will have to present as something
      other than pending.
    location: >-
      src/engine/question-window.ts
    severity: low
  - summary: >-
      The crash-injection suite's boundary count is unchanged at 23, because its fixture plan asks no
      question.
    evidence: |-
      So this story's new durable writes add no boundaries there, and question crash-convergence is
      covered directly instead: a claim created with nothing logged — exactly what a kill between the
      link and the append leaves — is finished by a later pass, appending each of the three lines
      exactly once. That is adequate but it is a different test from the dynamic sweep, and a future
      story that makes the crash fixture ask a question would cover it more strongly.
    location: >-
      tests/engine.crash-injection.test.ts
    severity: low
baseline_revision: 'fbd2365484928862defd46b168298e683198b095'
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

Status: done
Blocking condition: none

**REVIEW WAS SKIPPED** for this story; no review layers ran. The gate, the parent's probes and four
mutations are the only scrutiny it received.

**Implemented change.** `src/engine/questions.ts`, `question-window.ts` and `decision.ts`: the durable
question, the compare-and-set, CAP-4's window as a competing resolver, and the decision a resolved question
leaves. `src/runtime/paths.ts` gains the `questions/` layout. Story 1-1's `resolveQuestion`/`deflectQuestion`
are reused for every decision — nothing reimplements the state machine. Three of story 1-7's seven parked
commands (`answer`, `reject`, `edit_criterion`) are now honoured.

**The bug only a cross-process test could find.** `open(path, 'wx')` is an atomic test-and-set on the *name*
only: it publishes a zero-length file, so a loser reading the outcome in the microseconds before the winner's
`write` saw a torn record and threw. The fix writes the record to a temporary file, fsyncs, then `link(2)`s it
into place — the same `EEXIST` test-and-set, but the published inode already holds the whole record. `rename`
was rejected because it overwrites and therefore decides nothing. In one event loop the loser's read is
ordered after the winner's write by construction, so an in-process test could not have surfaced this.

**Parent verification.** `typecheck`, `lint`, `build` exit 0; `npm test` → 33 files, **919 passed, 8
skipped**. The cross-process race suite ran clean three times. `linkSync` is the CAS and `renameSync` is used
only for the derived state file, which is the right split.

**Mutation testing, including one of the parent's own that proved nothing.** The parent first added a
`existsSync` fast path *in front of* the atomic link and the race suite still passed — correctly, because the
mutation was benign: the link remained, so exactly one winner was still guaranteed. Replacing the link with a
genuine check-then-write failed the race suite on all three runs, with the failure count varying between one
and three across runs — and that variance is itself evidence the suite exercises a real race rather than a
deterministic check.

**Follow-up review recommended: true** — no review ran, and the cross-story lock finding recorded above
deserves a decision.
