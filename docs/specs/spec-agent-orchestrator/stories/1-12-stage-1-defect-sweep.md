---title: Stage-1 defect sweep — bound the retry loop, close the bypasses
type: feature
created: '2026-09-20'
status: done
review_loop_iteration: 1
followup_review_recommended: true
baseline_revision: de025aa
context:
- '{project-root}/docs/planning-artifacts/architecture/architecture-agent-orcastrator-2026-09-19/ARCHITECTURE-SPINE.md'
- '{project-root}/docs/specs/spec-agent-orchestrator/stories/1-3-engine-reconciler.md'
- '{project-root}/docs/specs/spec-agent-orchestrator/stories/1-7-command-transport.md'
- '{project-root}/docs/specs/spec-agent-orchestrator/stories/1-8-question-lifecycle.md'
warnings:
- oversized
deferred:
- summary: 'RESOLVED 2026-09-21: the four-layer review ran. See the Review Triage Log.'
  evidence: 52 claims filed, 16 triage rows, 11 patched including four high. Suite 1542 -> 1597 tests
    across 52 files, zero skips. Four mutations caught, including one that had passed the entire suite
    before this round.
  severity: high
- summary: The attempt bound counts a step's own failure and the engine's crash as the same kind of engagement,
    and 8 is the compromise that forces.
  evidence: 'One counting rule was this story''s instruction, and it is what closes the unbounded resume
    path story

    1-7 left open. But an interruption is the engine''s fault, not the step''s — a crash or a closed laptop
    —

    and charging it to the same allowance is why the number had to rise from 1-7''s declared 3 to 8. I

    verified the constraint rather than accepting it: with the bound at 3, `engine.crash-injection` reports

    "1 of 25 boundaries did not converge", i.e. a run handed off for having survived two crashes. The

    consequence accepted is that a persistently failing step now spends 8 attempts before handing off.
    The

    clean shape is two counters, or a budget-based bound, and story 2-9 owns the ceilings where that

    belongs.'
  location: src/engine/dispositions.ts
  severity: medium
- summary: 'Story 1-3''s EC15 is only half closed: the engine can no longer create an unreadable lock,
    but a pre-existing empty or unreadable one is still reclaimable by nothing.'
  evidence: 'The atomic create removes the window in which a zero-length claim is published, so no new
    one can

    arise. An existing one — however it arose — still has no reclamation path. Making an unreadable lock

    reclaimable risks stealing a live one, which is a decision rather than a fix, and was correctly left

    alone.'
  location: src/engine/lock.ts
  severity: medium
- summary: '`StepResumeRequest.attempt` carries the pre-resume count, so a resume and the start before
    it share an attempt number, while `src/container/lifecycle.ts` documents that value as unique per
    attempt.'
  evidence: 'Pre-existing and unchanged by this story, but newly visible now that a resume is a counted
    engagement.

    It touches container naming and story 1-4''s fixtures, which is why it was not changed here.'
  location: src/engine/reconciler.ts, src/container/lifecycle.ts
  severity: medium
- summary: 'A new unswept file class: a SIGKILL between the temp write and the `link` leaves a `<name>.<pid>.<n>.tmp`
    beside the claim, and nothing sweeps it.'
  evidence: 'Harmless — nothing reads an unlinked name — and the identical shape already exists from story
    1-8''s

    question outcome. It is debris rather than a defect, and it is the cost of the idiom that closed the

    torn-read window.'
  location: src/runtime/exclusive-create.ts
  severity: low
- summary: 'SPEC DECISION: matrix row 9 and task 4 describe behaviour this review replaced.'
  evidence: They say a contradictory `retryable` is "refused". It is now repaired on ingest — the schema
    derives the flag from the code, as `orchError()` already did. The invariant is strictly stronger,
    but the wording is wrong, and I wrote it.
  severity: medium
- summary: '`StepRecord` gained `credited_attempts` without a `schema_version` bump.'
  evidence: A pre-upgrade checkpoint is discarded and rebuilt from the log, which is AD-4's declared answer
    and the safe direction. But `run.state` is a wider artifact than this story left, and that is worth
    acknowledging rather than discovering.
  location: src/contracts/state.ts
  severity: medium
- summary: Three counts in this story's own protected sections are wrong.
  evidence: '"Nine mutations" over a ten-row table; "Ten mutations tried" over eleven; "Five existing
    test files changed" when six were. Story 1-7''s deferred entry also still describes a three-attempt
    failure allowance that is now eight across every disposition — only the stale symbol name was corrected.'
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

### 2026-09-21 — Review pass (follow-up, on a `done` spec)

- claims filed: 52 across four layers — blind-hunter 13, edge-case-hunter 20, verification-gap 4 gap + 4
  other, intent-alignment 7 divergences plus 4 enumerated readings. The edge-case layer filed an enumerated
  list so its count is exact; the other three wrote prose, so those are my enumeration.
- grouped into the 16 rows below. 11 patch entries applied, 3 deferred, the rest rejected. No filed claim is
  without a row.
- **This story was itself a defect sweep, and four of its eight fixes had made something worse.** Three of
  those four were regressions from items I specified: the npm bound, the `retryable` refinement, and the
  AD-19 attribution guard. A fifth row records a premise of mine that did not reproduce.
- The worst of them was repaired by changing the shape of the fix rather than guarding on top of it: a
  schema that derives `retryable` from the code cannot be contradicted, and does not ask a model to satisfy
  a rule that provably is not in the schema it is given.

- `[high]` `[patch]` Importing the project crashed under pnpm, yarn Berry and bun. All three set `npm_config_user_agent` to a string containing the literal `npm/?`; the regex captured `"?"`, `parseVersion` threw a plain `Error`, and `assertNodeFloorOrExit` re-threw it raw — so every module, which all import contracts, died at import instead of exiting 1 with advice. Verified before and after: all three now import cleanly. **The test covering that case passed for the wrong reason** — it asserted `null` for `'yarn/4.1.0 npmless …'`, which contains no `npm/` at all, so the regex never matched. Replaced with the three real agent shapes.
- `[high]` `[patch]` A model's wrong boolean destroyed the whole step output and promoted the model tier. `OrchErrorSchema`'s new refinement is invisible to the model: it is embedded in `StepOutputSchema`, exported through `z.toJSONSchema`, and a Zod refinement emits nothing into draft-7 — confirmed on the real export, `retryable` is `{"type":"boolean"}`. So an agent reporting `budget.exhausted` with the flag wrong had its artifact rejected, the re-parse turned it into `step.schema_invalid_output`, whose disposition is escalate-model-tier, and the loop promoted to a costlier rung to re-run a step that said the budget was gone — consuming this same story's eight-engagement bound on the way. **Repaired rather than rejected:** the schema now derives the flag from the code, as `orchError()` already did. Verified: `budget.exhausted` with `retryable: true` keeps its code and has the flag corrected.
- `[high]` `[patch]` The AD-19 attribution guard permitted the dangerous direction. It refused a clock's default attributed to a person and **accepted** a person's decision attributed to the clock — the direction that launders a human choice into "the system did it", which CAP-18's ledger keeps for ever. Now an equivalence; verified both directions refuse and the normal case is untouched.
- `[high]` `[patch]` The same guard reported the wrong fault. `readIntentFiles` classifies by issue path and `onlyThePrincipal` matches anything starting with `principal`, so a person saw *"the field principal is absent or not a declared principal"* for an intent whose principal was present and valid. The cross-field rules now carry a marker in their issue params and raise `misattributed-principal` and `missing-argument`, neither of which existed — an argument-required command with a blank argument was reported as `malformed`.
- `[medium]` `[patch]` The npm bound's wiring was unpinned: severing it — so the environment is never consulted in production — left the whole suite green, because every npm test supplied the version as an argument and the one test calling the default returned early. Now pinned end to end by real child processes importing contracts with a real `npm_config_user_agent`.
- `[medium]` `[patch]` Existing in-flight runs would have handed off on first load, because pre-upgrade logs already hold `step.resume_attempted` lines the new bound counts retroactively. A build-boundary marker now separates them; an unmarked line folds exactly as it always did, so a pre-upgrade run gets a fresh allowance rather than an immediate hand-off.
- `[medium]` `[patch]` An approval at the bound handed off instead of proceeding — approval sets the disposition to `interrupted`, which the new bound counts, so a person authorising a blocked step got a hand-off rather than the run they had just approved. Now credited rather than reset, because `attempts` is a total the hand-off document quotes to a person and a counter that silently restarts is a number that lies.
- `[medium]` `[patch]` The hand-off named a retryable code for a run that must not retry: `decideAction` carried the step's own `retry-with-backoff` code while the story's prose claimed `internal.invariant_violated`. The label is now what the prose always said, with the step's real code carried as the cause. `stepPhrase` also mentioned attempts only in the `failed` branch, so a step interrupted through all eight engagements read as "interrupted part-way through" — the case the bound was widened to catch.
- `[medium]` `[patch]` `createFileExclusively` was not the idiom its docblock claimed to copy: it fsynced the temp file but never the directory, so the `link(2)` that publishes a claim was not durable across power loss, while story 1-8's version calls `fsyncDirectory` for exactly that reason. Also fsynced by reopening read-only, hand-rolled `basename` beside an import of `node:path`, and let a `linkSync` EPERM on a filesystem without hard links escape as a raw errno. The module had **no unit test at all** — nine now.
- `[medium]` `[patch]` The "declared in exactly one place" test read one file while its own comment stated the criterion as a grep over `src/`, and asserted a constant against its own spelling. Now walks the tree, with a guard that an empty sweep cannot pass for a clean one — verified it bites by planting a stray literal.
- `[low]` `[patch]` Eight smaller items: `readIntentFiles` was the only versioned-artifact reader bypassing `parseVersionedArtifact`, so an intent from a future installer read as `malformed` rather than carrying the schema-version code and its "re-run the installer" advice; `FOLDED_EVENT_TYPES` had no reader, so adding a type to it was inert — now enforced against the fold's own switch; `step.resume_attempted`'s `attempt` was pre-increment while the fold and `step.started` were post-increment; `newCommandIntent` threw a raw `ZodError` out of `steer` for blank text, making the engine's own refusal unreachable; CI had no timeout and no concurrency group while this story added the suite's most expensive tests, and pinned a Node major the evidence never covered; and `.npmrc` now makes the workflow's "`npm ci` enforces engines" claim true rather than correcting it, verified both ways.
- `[false]` `[reject]` ONE PREMISE OF MINE DID NOT REPRODUCE. I claimed `createFileExclusively`'s `mkdirSync` newly created a typo'd `ORCH_HOME` that the old `'wx'` open would have refused. `EngineLock.acquire` has called `mkdirSync(orchHome, { recursive: true })` itself since story 1-3, so a typo'd home was already being created and still is — the module's own `mkdirSync` was redundant, not the cause. Removed anyway, with a test, because a module whose subject is "who got there first" should not bring a parent into existence. Making a typo'd home refuse is a separate decision about the lock, and was correctly not taken.
- `[medium]` `[defer]` SPEC DECISION: matrix row 9 and task 4 now describe the old behaviour. They say a contradictory `retryable` is "refused"; it is now repaired on ingest. The invariant is strictly stronger — no parsed `OrchError` can contradict its code — but the story's wording is wrong and I am the one who wrote it.
- `[medium]` `[defer]` SPEC DECISION: `StepRecord` gained `credited_attempts`, so `run.state` is a wider artifact than this story left, and `schema_version` was not bumped. A pre-upgrade checkpoint is discarded and rebuilt from the log, which is AD-4's declared answer and the safe direction, but it is a contract widening that should be acknowledged rather than discovered.
- `[low]` `[defer]` Three counts in this story's own protected sections are wrong and could not be corrected here: "Nine mutations" over a ten-row table, "Ten mutations tried" over eleven, and "Five existing test files changed" when six were. Story 1-7's deferred entry also still describes a three-attempt failure allowance that is now eight across every disposition; only the stale symbol name was corrected, as instructed.
- `[low]` `[reject]` Five hardening suggestions on inputs no caller can supply, and cosmetic notes corrected elsewhere in this round. (5 findings)

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

**Status: done, reviewed.** The four-layer review ran on 2026-09-21 — the last of stage 1's eight. 52 claims
filed, 16 triage rows, 11 patched, 3 deferred. Suite 1542 -> 1597 tests across 52 files, zero skips.

**This story was itself a defect sweep, and four of its eight fixes had made something worse.** Three of the
four were regressions from items I specified.

*The npm bound crashed the system it was meant to protect.* pnpm, yarn Berry and bun all set
`npm_config_user_agent` to a string containing `npm/?`; the parse threw a plain `Error` that
`assertNodeFloorOrExit` re-threw raw, so every module — all of which import contracts — died at import. And
severing the bound's wiring entirely left the whole suite green, because every test supplied the version as
an argument. Verified after: all three package managers import cleanly, and the mutation now fails.

*The `retryable` refinement destroyed step outputs.* It is invisible to the model that has to satisfy it — a
Zod refinement emits nothing into the draft-7 schema handed to `claude -p`, confirmed on the real export. So
an agent reporting `budget.exhausted` with the derived boolean wrong had its whole artifact rejected, the
re-parse relabelled it `step.schema_invalid_output`, and the loop promoted to a costlier model tier to re-run
a step that had said the budget was gone — spending this story's own eight-engagement bound on the way.
Repaired rather than rejected: the schema now derives the flag from the code, which is what `orchError()`
always did. A contradictory flag keeps its code and has the flag corrected.

*The AD-19 attribution guard pointed the wrong way and named the wrong fault.* It refused a clock's default
attributed to a person while **accepting** a person's decision attributed to the clock — the direction that
launders a human choice into "the system did it automatically", which CAP-18's ledger keeps for ever. And
the refusal a person actually saw said the principal field was absent, for an intent whose principal was
present and valid.

**Also closed:** existing in-flight runs would have handed off on first load, because pre-upgrade logs hold
resume lines the new bound counts retroactively; an approval at the bound handed off instead of running the
attempt it authorised; the hand-off named a retryable code for a run that must not retry; and
`createFileExclusively` omitted the directory fsync of the idiom it claimed to copy, with no unit test at
all.

**One premise of mine did not reproduce** and was reported rather than patched around: the module's
`mkdirSync` was redundant, not the cause of a typo'd `ORCH_HOME` being created — `EngineLock.acquire` has
done that since story 1-3.

**Residual risk, and why `followup_review_recommended` is true.** Four high entries were patched. The
specific unverified risk: `retryable` is now silently corrected rather than refused, so a step agent that is
consistently wrong about it will never learn — the log records the corrected flag and nothing counts the
correction. That is the right trade against destroying the artifact, but it trades a loud failure for a
quiet one, and nothing yet measures how often it fires.
