---
title: 'Stage-1 defect sweep — bound the retry loop, close the bypasses'
type: 'feature'
created: '2026-09-20'
status: 'in-review'
review_loop_iteration: 0
followup_review_recommended: true
baseline_revision: 'de025aa'
context:
  - '{project-root}/docs/planning-artifacts/architecture/architecture-agent-orcastrator-2026-09-19/ARCHITECTURE-SPINE.md'
  - '{project-root}/docs/specs/spec-agent-orchestrator/stories/1-3-engine-reconciler.md'
  - '{project-root}/docs/specs/spec-agent-orchestrator/stories/1-7-command-transport.md'
  - '{project-root}/docs/specs/spec-agent-orchestrator/stories/1-8-question-lifecycle.md'
warnings: ['oversized'] # eight independent defects across contracts, runtime, engine and the build
deferred:
  - summary: >-
      No review layer ran against this story; the gate, the implementer's nine mutations and my own
      independent re-run of the decisive one are the only scrutiny it received.
    evidence: |-
      typecheck, lint, build and 1263 tests across 50 files all pass with zero skips. Read status: done as
      implemented, gated and mutation-tested, not reviewed.
    severity: high
  - summary: >-
      The attempt bound counts a step's own failure and the engine's crash as the same kind of engagement,
      and 8 is the compromise that forces.
    evidence: |-
      One counting rule was this story's instruction, and it is what closes the unbounded resume path story
      1-7 left open. But an interruption is the engine's fault, not the step's — a crash or a closed laptop —
      and charging it to the same allowance is why the number had to rise from 1-7's declared 3 to 8. I
      verified the constraint rather than accepting it: with the bound at 3, `engine.crash-injection` reports
      "1 of 25 boundaries did not converge", i.e. a run handed off for having survived two crashes. The
      consequence accepted is that a persistently failing step now spends 8 attempts before handing off. The
      clean shape is two counters, or a budget-based bound, and story 2-9 owns the ceilings where that
      belongs.
    location: 'src/engine/dispositions.ts'
    severity: medium
  - summary: >-
      Story 1-3's EC15 is only half closed: the engine can no longer create an unreadable lock, but a
      pre-existing empty or unreadable one is still reclaimable by nothing.
    evidence: |-
      The atomic create removes the window in which a zero-length claim is published, so no new one can
      arise. An existing one — however it arose — still has no reclamation path. Making an unreadable lock
      reclaimable risks stealing a live one, which is a decision rather than a fix, and was correctly left
      alone.
    location: 'src/engine/lock.ts'
    severity: medium
  - summary: >-
      `StepResumeRequest.attempt` carries the pre-resume count, so a resume and the start before it share an
      attempt number, while `src/container/lifecycle.ts` documents that value as unique per attempt.
    evidence: |-
      Pre-existing and unchanged by this story, but newly visible now that a resume is a counted engagement.
      It touches container naming and story 1-4's fixtures, which is why it was not changed here.
    location: 'src/engine/reconciler.ts, src/container/lifecycle.ts'
    severity: medium
  - summary: >-
      A new unswept file class: a SIGKILL between the temp write and the `link` leaves a
      `<name>.<pid>.<n>.tmp` beside the claim, and nothing sweeps it.
    evidence: |-
      Harmless — nothing reads an unlinked name — and the identical shape already exists from story 1-8's
      question outcome. It is debris rather than a defect, and it is the cost of the idiom that closed the
      torn-read window.
    location: 'src/runtime/exclusive-create.ts'
    severity: low
---

# Story 1-12 — Stage-1 defect sweep

## Intent

Eight defects that stage 1 recorded and deferred. None is a missing feature; each is a way the built code
can do something its own contract forbids. They are grouped into one story because they are all small, all
verified present, and all cheaper to fix before stage 2's roster and ceilings are built on top of them.

Each was confirmed against the code at `db11e4b` rather than taken from the deferred entry's word.

## Boundaries & Constraints

**The retry bound is a bound, not a ceiling.** Story 2-9 owns budget degradation, hibernation and the
eighty-percent threshold. This story owns only a hard attempt count per step, because the current behaviour
is a step whose disposition is `retry-with-backoff` re-running forever, and an unbounded loop spends the
subscription budget until a person notices. 1-7 recorded the related half: the declared failure limit counts
only the `failed` disposition, so the resume path is still unbounded. One bound must cover every disposition
that returns to the same step, not one of them.

**A tightened schema is a breaking change to fixtures, and that is expected.** Requiring a non-empty
`argument` for the commands that are meaningless without text, and refusing `source: 'timeout'` paired with
`principal.kind: 'user'`, will invalidate existing test fixtures that were legal before. Updating a fixture
to satisfy a stricter contract is correct. Deleting or skipping a test to avoid the failure is not, and the
difference must be visible: every fixture changed is reported, with the reason.

**The atomic-create idiom already exists in this codebase; use it rather than inventing one.** The
`'wx'`-then-write window is that a file is created empty and populated afterwards, so a concurrent reader can
observe a claim that is present but blank. Story 1-8 solved exactly this for the question outcome: write a
temp file in the same directory, `fsync`, then `link()` it into place, treating `EEXIST` as having lost the
race. Both the recorder's writer claim and the engine lock get that shape. This is a fail-safe defect being
made correct, not a live corruption — say so honestly and do not oversell the fix.

**A validation that can be bypassed by calling `.parse()` is not a validation.** Two of the eight are this
shape: `schema_version` is recognised by a helper the caller may skip, and `retryable` is a free `z.boolean()`
on the wire while `orchError()` derives it correctly from the AD-35 table. In both cases the check belongs
inside the schema, so there is no path that reaches a parsed value without it.

**Not in this story.** No ceilings, degradation or hibernation (2-9). No change to what AD-21 redaction
does. No new event types. No new surface. No change to the disposition table's contents — only to how many
times a disposition that returns to a step may do so.

## I/O & Edge-Case Matrix

| # | Input | Expected |
|---|---|---|
| 1 | A step that keeps returning `retry-with-backoff` | It stops at the attempt bound and the feature reaches a terminal state rather than looping |
| 2 | A step that keeps being `interrupted` and resumed | The same bound applies; the resume path is not a way around it |
| 3 | A step that succeeds on its last permitted attempt | It succeeds; the bound is not off by one |
| 4 | Attempt counts, after a crash and rebuild | The count is reconstructed from the log, so a restart is not a way to reset it |
| 5 | Two processes racing to claim the event-log writer | Exactly one wins; the loser sees a fully-written claim, never a present-but-empty one |
| 6 | Two processes racing for the engine lock | Same, and the winner's identity is readable by the loser |
| 7 | A versioned artifact with an unrecognised `schema_version`, parsed with a bare `.parse()` | Refused, with `config.schema_version_unrecognised` |
| 8 | The same artifact, parsed through every other entry point | Refused identically; there is one behaviour, not two |
| 9 | An error whose `retryable` contradicts the AD-35 table for its code | Refused; the table is authoritative and the field cannot disagree |
| 10 | An `answer`, `reject`, `edit_criterion`, `narrow` or `inject_note` intent with `argument: null` | Refused as unanswerable rather than accepted and silently doing nothing |
| 11 | A `pause` or `disengage` intent with `argument: null` | Accepted — those commands are meaningful without text |
| 12 | An intent pairing `source: 'timeout'` with `principal.kind: 'user'` | Refused; a clock's default is never attributed to a person |
| 13 | An intent pairing `source: 'timeout'` with `principal.kind: 'timeout'` | Accepted |
| 14 | npm 12 installed | The install or startup refuses, naming the `engines.npm` bound rather than failing later and obscurely |
| 15 | A push, and a pull request | CI runs typecheck, lint, build and the full suite on the pinned Node, and fails the job on any one of them |

## Code Map

| File | Change | Why |
|---|---|---|
| `src/engine/dispositions.ts` | modify | A hard attempt bound covering every disposition that returns to the same step, not only `failed`. |
| `src/engine/reconciler.ts` | modify | Count attempts per step from the log and enforce the bound; reach a terminal state at it. |
| `src/engine/rebuild.ts` | modify | Reconstruct the attempt count, so a restart cannot reset it. |
| `src/runtime/recorder.ts` | modify | Replace the `'wx'`-then-write writer claim with the temp-file-`fsync`-`link` idiom story 1-8 established. |
| `src/engine/lock.ts` | modify | Same change, same reason. |
| `src/contracts/schema-version.ts` | modify | Move the recognition check inside `schemaVersionField`, so no `.parse()` path skips it. |
| `src/contracts/error.ts` | modify | Refine so `retryable` must equal what the AD-35 table says for its code. |
| `src/contracts/command.ts` | modify | Refine: a non-empty `argument` for the commands that require text; refuse `source: 'timeout'` with a `user` principal. |
| `src/contracts/node-floor.ts` | modify | Assert the `engines.npm` bound alongside the Node floor, from `package.json` rather than a second literal. |
| `.github/workflows/ci.yml` | new | The four-command gate, on the pinned Node, on push and pull request. |
| `tests/engine.retry-bound.test.ts` | new | Matrix 1, 2, 3, 4. |
| `tests/runtime.writer-claim.test.ts` | new | Matrix 5, 6 — cross-process, because the guarantee is cross-process. |
| `tests/contracts.schema-version.test.ts` | modify | Matrix 7, 8. |
| `tests/contracts.error.test.ts` | modify | Matrix 9. |
| `tests/contracts.command.test.ts` | modify | Matrix 10, 11, 12, 13. |
| `tests/contracts.node-floor.test.ts` | modify | Matrix 14. |

## Tasks & Acceptance

1. **Bound the retry loop.** One attempt bound covering every disposition that returns to the same step.
   - **Given** a step that always returns `retry-with-backoff`, **when** the reconciler runs to quiescence,
     **then** the step stops at the bound and the feature holds a terminal state.
   - **Given** a step that is always `interrupted` and resumed, **when** the reconciler runs to quiescence,
     **then** the same bound stops it, so the resume path is not a way around it.
   - **Given** a step that succeeds on its last permitted attempt, **when** it runs, **then** it succeeds.
   - **Given** a crash after several attempts, **when** the state is rebuilt from the log, **then** the
     attempt count is preserved and a restart does not reset it.

2. **Close the torn-read window** in the recorder's writer claim and the engine lock, using story 1-8's
   temp-file-`fsync`-`link` idiom.
   - **Given** two OS processes racing to claim, **when** both attempt it, **then** exactly one wins and the
     loser reads a fully-written claim, never a present-but-empty file.
   - **Given** the winner holds the claim, **when** the loser reads it, **then** the winner's identity is
     readable, so the refusal can name who holds it.

3. **Make the `schema_version` gate unbypassable.**
   - **Given** an artifact whose `schema_version` this build does not recognise, **when** it is parsed with a
     bare `.parse()`, **then** the parse fails and the failure carries
     `config.schema_version_unrecognised`.
   - **Given** the same artifact, **when** it is parsed through any other entry point, **then** the
     behaviour is identical.

4. **Make `retryable` unable to contradict the AD-35 table.**
   - **Given** an error payload whose `retryable` disagrees with the table for its code, **when** it is
     parsed, **then** it is refused rather than accepted.
   - **Given** an error built by `orchError()`, **when** it is parsed, **then** it is accepted unchanged.

5. **Refine the command intent** on both the argument and the principal.
   - **Given** an `answer`, `reject`, `edit_criterion`, `narrow` or `inject_note` intent with a null or empty
     `argument`, **when** it is parsed, **then** it is refused.
   - **Given** a `pause` or `disengage` intent with a null `argument`, **when** it is parsed, **then** it is
     accepted.
   - **Given** an intent pairing `source: 'timeout'` with `principal.kind: 'user'`, **when** it is parsed,
     **then** it is refused; paired with `principal.kind: 'timeout'` it is accepted.

6. **Assert the npm bound** from `package.json`, not from a second literal.
   - **Given** an npm version outside `engines.npm`, **when** the floor is asserted, **then** it refuses and
     names the bound.
   - **Given** the bound is declared in exactly one place, **when** `grep -rn "'<12'" src/` runs, **then** it
     returns no match.

7. **Add CI.** `.github/workflows/ci.yml` running typecheck, lint, build and the full suite on the pinned
   Node, on push and pull request.
   - **Given** any one of the four commands fails, **when** the workflow runs, **then** the job fails.
   - **Given** the workflow's Node version, **when** it is compared to the spine's Stack table, **then**
     they agree.

## Spec Change Log

### Implementation, 2026-09-20 — one declared number changed, and one matrix row contradicted the shipped code

1. **The bound is 8, not story 1-7's 3, and that changes a number another story declared.**
   `DECLARED_FAILURE_ATTEMPT_LIMIT` (3, in `handoff.ts`) becomes `DECLARED_STEP_ATTEMPT_LIMIT` (8, in
   `dispositions.ts`). This story required one counting rule covering every disposition that returns to the
   same step, which is what closes the unbounded resume path; under one rule, 3 is too tight. The arithmetic
   is in the code: three declared attempts for AD-35's retry path, plus two interruptions costing two
   engagements each — a resume against the recorded session id, and the re-run behind a refused resume —
   is seven, and eight leaves one spare. **I verified the constraint rather than taking it on trust:** with
   the bound set to 3, `tests/engine.crash-injection.test.ts` reports *"1 of 25 boundaries did not
   converge"*. Story 1-7's warning about capping `interrupted` was empirically right.

2. **Matrix row 10 contradicted the shipped TUI.** The row requires the contract to refuse a `narrow` intent
   with no argument, and `src/tui/controls.ts` declared `narrow` as `argument: 'optional'`. Left
   disagreeing, pressing that key would have written an intent file every reader then rejects. `controls.ts`
   now says `'required'`, and a guard test asserts the TUI table and the contract agree in both directions.
   This pulled `src/tui/` into a story whose Code Map excluded it.

3. **The Code Map named three test files that do not exist.** `tests/contracts.{schema-version,error,
   command}.test.ts` were listed as "modify"; story 1-1's AD-28, AD-35 and AD-3 matrices all live in
   `tests/contracts.behaviour.test.ts`. The rows went there rather than splitting one matrix across four
   files. Matrix 15, for which the Code Map gave no test row, went into `tests/contracts.node-floor.test.ts`.

4. **`src/runtime/exclusive-create.ts` is new.** The idiom is needed by `src/runtime/recorder.ts` and
   `src/engine/lock.ts`, which sit in different layers, and the spine permits only engine→runtime — so one
   shared module in `runtime/` is the only way to avoid a third and fourth copy. Story 1-8's
   `createOutcomeExclusively` was deliberately *not* refactored onto it: that is 1-8's compare-and-set and
   out of scope. The new module documents that they are the same shape.

5. **`src/contracts/state.ts`** — `attempts`' docblock said "how many times the step has been started" and
   now counts resumes too. A field whose comment contradicts the fold is worse than no comment.

6. **Five existing test files changed, no assertion removed or relaxed.** `engine.handoff` renamed the
   constant it reads, so it still asserts the rule rather than the number. `engine.reconciler` changed one
   expected attempt number from 2 to 3 in the AD-26 reset test, because a refused resume is now itself a
   counted engagement; the test is still about the reset. `engine.steering`'s blank-argument test was
   **strengthened**: it now builds its intent outside the schema and asserts both that
   `CommandIntentSchema` rejects it and that `decideSteering` still refuses — the engine guard is now
   explicitly defence in depth behind the contract. `tui.controls` gained the agreement guard.
   `contracts.behaviour` and `contracts.node-floor` are additions only.

7. **No fixture needed changing for `retryable`.** Every inline error fixture in the suite already agreed
   with the AD-35 table, which is mild evidence the tightening matches how the code was already being used.

## Review Triage Log

## Design Notes

**Task 2 is narrower than the story made it sound, and the honest version is worth recording.** Mutual
exclusion was never at risk for either claim: the create decides, and creating a file is atomic. What was
actually broken is smaller and real — the refusal could not name who held the claim, because the file it
read might still be empty, and a zero-length claim is reclaimable by nothing. The fix removes the window in
which such a file can be published. It does not make an already-empty lock recoverable, so story 1-3's EC15
is half closed, not closed.

**Two of the eight were the same defect wearing different clothes.** `schema_version` recognition and
`retryable` both lived *outside* the schema — one in a helper a caller could skip, one derived correctly by
`orchError()` while the wire type stayed a free `z.boolean()`. A validation that a caller can decline is not
a validation, and the fix in both cases was to move the check inside the schema so no `.parse()` reaches a
value without it. `parseVersionedArtifact` keeps its post-parse assertion as well, because removing it made
the *pre-existing* named-refusal test depend on another module's refinement.

**The race needed a watcher to be deterministic.** Before one was added, the cross-process test caught the
old `'wx'`-then-write behaviour only about half the time — a seventh child spinning in `statSync` while the
claim is published is what makes the empty-file window observable every run. A cross-process test that
catches a real defect half the time is a flaky test that will eventually be deleted by someone.

## Verification

Node v24.21.0.

| Check | Result |
|---|---|
| `npm run typecheck` / `lint` / `build` | exit 0 |
| `npm test` | **1263 passed across 50 files**, zero skips, zero failures (baseline 1206 / 48) |
| `npx vitest run tests/engine.crash-injection.test.ts` | 5 passed — the suite that catches durability mistakes |
| `grep -rn "'<12'" src/` | no match — the npm bound is declared once, in `package.json` |
| `grep -rn "from '../engine" src/tui/` | no match |
| `grep -rn "node:fs" src/tui/` | no match (1-9's guard) |
| `.github/workflows/ci.yml` | parses; both triggers; the four commands; Node from `.nvmrc` (22.22.0), matching the spine's `>=22.22` with no version literal in the workflow |

CI cannot be executed locally, so it is verified by parse, by its Node source agreeing with the spine, and
by a test asserting its four steps and both triggers — not by a green run. That distinction is the honest one.

**Nine mutations from the implementer, and I re-ran the one the story's outcome depends on.**

| Mutation | Caught by |
|---|---|
| Bound 8 → 9 | 1 test, the deliberate pin; every rule test tracks the constant |
| `attempts >= LIMIT` → `>= LIMIT - 1` | 9 tests, incl. "succeeds, so the bound is not off by one" |
| Rebuilt count starts at 1 instead of folding the log | 4 tests, incl. "survives a restart, because the checkpoint is not what the bound reads" |
| Revert the claim to `'wx'`-then-write | both cross-process races fail, 3/3 runs: "round 0 saw an empty claim" |
| Remove the argument refinement only | 11 tests |
| Remove the principal refinement only | exactly 1 test |
| Stop counting the resume | 3 tests, two as "took 200 passes without settling" — the unbounded loop, visible |
| Remove the `schema_version` refinement | 7 tests |
| Remove the `retryable` refinement | 2 tests |
| Drop `assertNpmCeiling` from startup | 1 test |
| **Mine:** set the bound to 3, story 1-7's declared number | `engine.crash-injection`: "1 of 25 boundaries did not converge" — which is the evidence that raising it was forced rather than chosen |

The implementer also reported that its first attempt at the `'wx'` mutation was invalid because the mutant
did not compile, so the children died of a `ReferenceError` rather than of the race. The table reports the
valid re-run. A mutation that fails for the wrong reason is a false negative, and saying so is the
difference between a mutation table and a decoration.

## Auto Run Result

**Status: done.** All eight recorded defects were present and all eight are fixed: the retry loop is bounded
across every disposition that returns to a step, with the count folded from the log so a restart cannot reset
it; the torn-read window is closed with the atomic-create idiom, extracted to one shared module; the
`schema_version` and `retryable` checks moved inside their schemas; the command intent now refuses a missing
argument and a clock's default attributed to a person; the npm bound is asserted from its single
declaration; and CI runs the four-command gate on the pinned Node.

1263 tests across 50 files, zero skips. Ten mutations tried, all caught.

**Stage 1 is complete — 12 of 12 stories, and its gate is met** (assessed at story 1-11 against the gate as
amended on 2026-09-20: containment independently verified, and all six required surfaces reconstructable
from `events.jsonl` after every other file in the run directory is deleted).

`followup_review_recommended: true` — the story is oversized, no review layer ran, and it changed a failure
allowance another story declared. Five deferred entries, of which the bound's conflation of a step's failure
with the engine's crash is the one worth revisiting when story 2-9 builds the ceilings.
