---title: Command transport — durable intent files, disengage, escape hatch
type: feature
created: '2026-09-20'
status: done
review_loop_iteration: 1
followup_review_recommended: true
context:
- '{project-root}/docs/planning-artifacts/architecture/architecture-agent-orcastrator-2026-09-19/ARCHITECTURE-SPINE.md'
- '{project-root}/docs/specs/spec-agent-orchestrator/interface-contract.md'
- '{project-root}/docs/specs/spec-agent-orchestrator/stories/1-3-engine-reconciler.md'
- '{project-root}/docs/specs/spec-agent-orchestrator/stories/1-4-step-spawner.md'
warnings:
- oversized
deferred:
- summary: 'RESOLVED 2026-09-21: the four-layer review ran. See the Review Triage Log.'
  evidence: 63 claims filed, 31 triage rows, 23 patched including five high. Suite 1346 -> 1391 tests
    across 51 files, zero skips. Four mutations that had left the suite green are now each caught by a
    test.
  severity: high
- summary: Seven declared commands are carried but not honoured, and their files stay in `commands/` until
    the story that owns them lands.
  evidence: 'COMMAND_HANDLING marks answer, edit_criterion, reject, narrow, pause, inject_note and fork
    as

    `awaiting`: the file is left in place, unconsumed and unrecorded, and reported in

    PassResult.steering. Acknowledging them instead would swallow a user''s answer or edit before story

    1-8''s compare-and-set could see it. The cost is that such a file is re-read (and re-parsed) on

    every pass until its owner consumes it. `pause` is the one that will read as a gap to a user: the

    lifecycle has no non-terminal halted state, so a pause that can be resumed needs story 2-9''s

    hibernation.'
  location: src/engine/steering.ts
  severity: medium
- summary: '`disengage` and `kill` produce the same effect, which is a judgement call a reviewer could
    reasonably have made the other way.'
  evidence: 'The Always list says "a step stopped by a steering command records `killed` and is never
    resumed or

    re-run", and AD-8 says the same, so both gestures stop the step as `killed` and halt the run at the

    terminal `killed` state. "Halting leaves resumable state on disk" is therefore satisfied by what

    survives — the checkpoint, the full log, the step''s session id and baseline_ref, the typed input
    and

    the worktree — not by the run being resumable by a later pass. A reviewer expecting disengage to

    leave a *resumable run* will find no such state in the lifecycle diagram.'
  location: src/engine/steering.ts
  severity: medium
- summary: 'RESOLVED: the bound is split and the kill grace is named authoritative.'
  evidence: The story declared 2s while EXECUTOR_KILL_GRACE_MS is 5s, so the promise was unmeetable by
    construction. Now an observation bound of 2s (the loop's own share, so no latency assertion weakened)
    and an end-to-end bound of 8s. The resume path, which had no watcher at all, now starts the same one.
  location: tests/engine.disengage.test.ts
  severity: medium
- summary: Applying an intent does not contend for a territory, so a take-over's git effect touches the
    run's worktree without holding it.
  evidence: 'A steering intent is applied before any action is decided and outside admitByTerritory, deliberately

    — deferring a disengage behind an unrelated feature''s territory would make "always available"

    conditional on unrelated work. The escape hatch is the one intent effect that writes to a worktree,

    so a take-over on run A and a step of run B sharing one worktree could interleave. Two runs sharing
    a

    worktree is already what territory exists to serialise.'
  location: src/engine/reconciler.ts
  severity: medium
- summary: The declared failure limit counts only the `failed` disposition, so story 1-3's unbounded resume
    loop is still unbounded.
  evidence: 'DECLARED_FAILURE_ATTEMPT_LIMIT hands off after three `failed` attempts, which closes the
    matrix''s

    repeated-failure row and the retry half of 1-3''s EC12. `interrupted` is deliberately excluded: an

    interruption is the engine''s own, and capping it would make a run that is restarted often enough

    hand itself off for surviving — it would also break the crash-injection suite, whose iterations

    legitimately reach three attempts. 1-3''s EC13 (the same session id resumed every pass) therefore

    stands until AD-24''s ceilings arrive in story 2-9.'
  location: src/engine/reconciler.ts, src/engine/handoff.ts
  severity: medium
- summary: A take-over whose git fails halts the run with the work uncommitted in the worktree and no
    branch.
  evidence: 'escapeHatch returns a `failure` rather than throwing, the hand-off document says the work
    is still in

    the worktree and names the path, and the run still reaches `handed_off`. Nothing is discarded and

    nothing loops, but the promised branch does not exist in that case, and no test drives a git that

    fails *midway* — only one that fails at every call.'
  location: src/engine/handoff.ts
  severity: low
- summary: '`step.approved` is emitted by nothing, and was deliberately not removed.'
  evidence: The Spec Change Log records keeping the constant and its fold case as a decision, and two
    tests assert nothing re-emits it. Removing it would edit a recorded decision, so it is carried rather
    than reversed — an event vocabulary member nothing writes.
  location: src/engine/rebuild.ts
  severity: medium
- summary: A refusal raised mid-step can reach `PassResult.steering` but only the applied case is asserted.
  evidence: Constructing a mid-step refusal needs a stop intent that is simultaneously refusable, which
    the terminal guard makes contradictory. The structure is right; the case is unreachable to a test.
  location: src/engine/reconciler.ts
  severity: low
- summary: Four claims about two engine processes consuming concurrently cannot be settled without violating
    AD-30, which forbids a second engine per ORCH_HOME.
  evidence: Triaged maybe-false. What would settle them is a second engine process, which AD-30 says must
    not exist. Exactly-once survives concurrent consumption today because the fold dedupes on intent id,
    not because the transport excludes it.
  severity: medium (unverified)
baseline_revision: 82c53b2deb3be15e3634a4e2906be27200d9826c
---

<intent-contract>

## Intent

**Problem:** Story 1-3 exposed `confirm`, `approve` and `kill` as engine methods and recorded two deferrals about it: they are not the AD-19 durable intent files the reconciler is supposed to be the sole consumer of, and a kill can only land between passes because a pass drives a step synchronously to termination. So nothing outside the engine process can steer a run, and CAP-5's "instant disengage" and CAP-23's escape hatch — the two properties AD-7 says the loop exists to host — are unimplemented.

**Approach:** Add the durable command transport: an intent file under `runs/<run-id>/commands/` is the only thing the reconciler consumes, each recording its principal. The effect of an intent is idempotent on its intent id, so delivery can be at-least-once while the effect is exactly-once. A disengage or kill is observed while a step is in flight, not only between passes, and the escape hatch leaves partial work on an ordinary branch while a handoff document explains a system that gave up.

## Boundaries & Constraints

**Always:**
- Every steering command is a durable file under `runs/<run-id>/commands/`, and that file is the only thing the reconciler consumes. There is no second command path.
- Every intent records its principal, so an approval is attributable to a person, a timeout or an agent.
- An intent's effect is idempotent on its `intent_id`: applying the same intent twice produces one effect. Delivery may therefore be at-least-once, because losing a disengage is worse than delivering one twice.
- A disengage or kill is observed while a step is in flight and takes effect within a declared bound, not only between passes. Halting leaves resumable state on disk.
- A step stopped by a steering command records `killed` and is never resumed or re-run.
- The escape hatch leaves partial work on an ordinary branch and halts the run. The branch name is derived from the run id, never from a feature slug, because AD-22 gives the committer sole ownership of feature branch naming.
- A handoff document is written when the system gives up, and reads as a colleague's note rather than a stack trace.
- A malformed, truncated or unrecognised intent is refused and recorded, and never becomes a poison file that is retried forever.
- Steering refuses a terminal run and refuses to retarget a completed or killed step, exactly as story 1-3's guards already do.
- `src/engine/` continues to import only from `src/contracts/`, `src/runtime/` and `node:` builtins, and still names no container runtime.

**Never:**
- No loopback HTTP server, no SSE, and no second transport — story 3-1 adds a server that writes these same files and is never an alternative path.
- No question lifecycle and no answer handling — story 1-8 owns the AD-25 compare-and-set and the timeout default.
- No renderer, no key bindings and no prompt line: the one-gesture surface is stories 1-9 and 1-10. This story provides the mechanism they invoke.
- No ceilings or hibernation (2-9), no committer or feature-branch naming (2-7), no installer.
- Never consume an intent by deleting it before its effect is durable, and never apply an effect whose intent id has already been applied.
- Never reclaim, halt or clean up in a signal handler, an exit hook or a `finally` — AD-32's rule holds here too, and a crash skips all three.
- No change to story 1-3's existing reconciler behaviour beyond consuming intents and observing them during a step; the crash-injection suite must still converge.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Intent applied | A valid intent file for a live run | Consumed, its effect recorded once, and the principal recorded with it | No error expected |
| Intent redelivered | The same `intent_id` presented twice | Exactly one effect; the second is recognised as already applied | No error expected |
| Crash between consume and apply | The process killed after reading an intent, before its effect was durable | The intent is still applied on a later pass, and applied only once | Nothing is lost and nothing doubles |
| Torn intent file | A file holding a partial JSON write | Refused, no effect, and the file is not treated as consumed | Never a partial application |
| Unrecognised command | A file naming a command outside the enum | Refused and recorded, and not retried forever | Quarantined rather than poison |
| Missing principal | An intent with no principal | Refused, naming the field | An unattributable approval is never applied |
| Unknown run | An intent for a run id with no state | Refused, naming the run | No effect |
| Terminal run | An intent for a committed, killed or handed-off run | Refused, naming the run and its state | The terminal state stands |
| Two intents, one run | Two valid intents present in one pass | Applied in a deterministic order | No error expected |
| Disengage mid-step | A disengage while a step is running | The live child is stopped within the declared bound and resumable state is on disk | No error expected |
| Kill mid-step | A kill while a step is running | The step records `killed` and is never resumed or re-run | No error expected |
| Kill with nothing in flight | A kill between passes | The run halts; no completed step's record is rewritten | A finished step is never relabelled |
| Escape hatch | A take-over intent for a run with uncommitted work | Partial work lands on an ordinary branch named from the run id, and the run halts | The work is never discarded |
| Repeated failure | A run that has failed the declared number of times | A handoff document is written and the run stops | Never a retry loop |
| No server present | Only the file path in use | Every control works through files alone | No error expected |

</intent-contract>

## Code Map

Stories 1-1 through 1-6 shipped the contracts, the recorder, the reconciler, the spawner, the container wrapper and the pool. The AD-19 contract already exists and is registered; the path helper does not.

- `src/runtime/paths.ts` -- modify, additively; add the `commands/` directory to `RunPaths`, which today carries `eventLog`, `eventLogLock`, `fetchRecord` and `configDir` but no commands path
- `src/engine/commands.ts` -- create; write, enumerate and consume intent files: parse against `CommandIntentSchema`, refuse a torn or unrecognised file, quarantine rather than retry forever, and order a pass's intents deterministically
- `src/engine/steering.ts` -- create; map a consumed intent to an action and make the effect idempotent on `intent_id`, backing story 1-3's `confirm`, `approve` and `kill` with the transport rather than leaving them as bare methods
- `src/engine/handoff.ts` -- create; the escape hatch (partial work onto an ordinary branch named from the run id, then halt) and the CAP-23 handoff document in the register `interface-contract.md` requires
- `src/engine/reconciler.ts` -- modify, additively; consume intents in a pass, and observe a disengage or kill while a step is in flight so it lands within the declared bound
- `src/engine/index.ts` -- modify; export the transport so stories 1-9 and 1-10 can write an intent without learning the layout
- `tests/engine.commands.test.ts` -- create; parse refusals, the torn file, the quarantine, deterministic ordering, and at-least-once delivery with an exactly-once effect
- `tests/engine.steering.test.ts` -- create; each command's effect, idempotence on `intent_id`, the terminal refusal, and that a kill never relabels a completed step
- `tests/engine.handoff.test.ts` -- create; the escape hatch's branch and preserved work, and the handoff document's content and register
- `tests/engine.disengage.test.ts` -- create; a disengage and a kill landing while a step is in flight, within the bound, leaving resumable state

Read-only evidence, authoritative and not to be edited by this story:

- `ARCHITECTURE-SPINE.md` -- AD-19 (durable intent files, the only path, the principal), AD-7 (the loop hosts disengage and the escape hatch), AD-8 (`killed` is never resumed), AD-22 (the committer alone names a feature branch), AD-25 (questions are story 1-8's), AD-32 (never an exit path)
- `interface-contract.md` -- the mode-and-control rules, "disengagement is instant, obvious and always available", `just-do-it` as a first-class command, and the handoff document's required register
- `src/contracts/command.ts` -- `Command`, `CommandIntentSchema`, `PrincipalSchema`, `COMMAND_SOURCES`, already registered as `command.intent`
- `src/engine/spawner.ts` -- `kill(step, run?)` and `killAll()`, the handles mid-step steering needs
- `src/engine/reconciler.ts` -- the existing `confirm`, `approve` and `kill` methods and their terminal guards

Carried forward from stories 1-3 through 1-6:

- **Story 1-3 recorded both halves of this story as its own deferrals:** that `confirm`/`approve`/`kill` are methods rather than intent files, and that "a kill can only land between passes, since an action drives a step synchronously to termination — real mid-step steering is 1-7's."
- Story 1-3's steering guards were added during its review after a reviewer showed `kill()` rewriting a *completed* step as `killed` and `approve()` resurrecting a killed one. Route every intent through those guards; do not reimplement them.
- Story 1-6 set the precedent for branch naming under AD-22: its worktree branch is `orch/run/<run-id>`, derived from the run id so feature-branch naming stays with the committer. The escape hatch's branch should follow the same discipline.
- Story 1-6 established that every durable write precedes the effect it describes, and that the AD-32 prohibition is asserted three ways rather than assumed. Both apply here.
- Story 1-3's crash-injection suite discovers its boundaries dynamically, so a new durable write inside a pass adds boundaries automatically. That is expected; it must still converge.

## Tasks & Acceptance

**Execution:**
- `src/runtime/paths.ts` -- add the `commands/` path to `RunPaths` -- one module owns the AD-9 layout, so a second spelling of this directory would be a second layout
- `src/engine/commands.ts` -- parse an intent against the existing contract, refuse a torn or unrecognised file, and quarantine rather than retry -- a file the loop cannot understand must not become a file the loop retries forever
- `src/engine/commands.ts` -- order the intents of one pass deterministically -- two intents arriving together must not race, because a restart has to reach the same state
- `src/engine/steering.ts` -- make each effect idempotent on `intent_id` so delivery can be at-least-once -- losing a disengage is worse than delivering one twice, which is the same trade AD-15 makes for the write surface
- `src/engine/steering.ts` -- route every intent through story 1-3's existing terminal and target guards -- those guards exist because a reviewer found `kill` relabelling a completed step and `approve` resurrecting a killed one
- `src/engine/reconciler.ts` -- consume intents in a pass, and observe a disengage or kill while a step is in flight so it lands within the declared bound -- "instant disengage" is the property AD-7 says the loop exists for, and a pass that only checks between steps cannot provide it
- `src/engine/handoff.ts` -- implement the escape hatch: partial work onto an ordinary branch named from the run id, then halt -- CAP-23 requires the work to survive, and AD-22 requires the name not to be a feature slug
- `src/engine/handoff.ts` -- write the handoff document in the register the interface contract requires -- a stack trace is precisely what it says this document must not be
- `src/engine/index.ts` -- export the transport -- stories 1-9 and 1-10 write an intent, and neither should learn the directory layout
- `tests/engine.{commands,steering}.test.ts` -- cover the parse refusals, the quarantine, deterministic ordering, idempotence on `intent_id`, and the terminal and target refusals -- the idempotence is what makes at-least-once delivery safe, so it is the property to pin
- `tests/engine.{disengage,handoff}.test.ts` -- cover a disengage and a kill landing mid-step within the bound, and the escape hatch's branch, preserved work and document -- these are CAP-5 and CAP-23, and neither has ever been exercised

**Acceptance Criteria:**
- Given a clean checkout on Node `>=22.22`, when `npm run typecheck && npm run lint && npm test && npm run build` is run, then all four succeed and the new suites appear in the test output.
- Given a valid intent file for a live run, when a pass runs, then its effect is recorded once with its principal, and the reconciler consumed nothing but that file.
- Given the same `intent_id` presented twice, when passes run, then exactly one effect exists in the log; and given the process is killed after an intent is read but before its effect is durable, then a later pass still applies it, exactly once.
- Given a truncated intent file, when a pass runs, then it is refused with no effect and is not treated as consumed; and given a file naming a command outside the enum, then it is refused, recorded, and not retried on every subsequent pass.
- Given an intent with no principal, or for a run with no state, or for a run in a terminal state, when a pass runs, then it is refused naming the reason and no effect occurs.
- Given a step in flight and a disengage intent, when it is written, then the live child is stopped within the declared bound and the run's state on disk is resumable.
- Given a step in flight and a kill intent, when it is applied, then the step records `killed` and no later pass resumes or re-runs it; and given a kill with nothing in flight, then no completed step's record is relabelled.
- Given a run with uncommitted work and a take-over intent, when it is applied, then the work is present on an ordinary branch whose name derives from the run id and not from a feature slug, and the run has halted.
- Given a run that has failed the declared number of times, when a pass runs, then a handoff document exists, the run has stopped, and the document reads as prose rather than a stack trace.
- Given `src/engine/`, when its text is inspected, then nothing halts or cleans up in a signal handler, an exit hook or a `finally`, and no container runtime is named.
- Given story 1-3's crash-injection suite, when it runs after this story's changes, then it still converges on every boundary it discovers.

## Spec Change Log

### Implementation, 2026-09-20 — one deviation that matters, and four small ones

1. **`src/engine/rebuild.ts` modified, beyond the six files the Code Map names.** This is the deviation
   that matters, and it is the mechanism the Design Notes asked for rather than a workaround.

   The note says: *"Carry `intent_id` into the event the effect appends, and have the fold ignore an id it
   has already seen."* The fold lives in `rebuild.ts`, so that sentence cannot be honoured without touching
   it. What was added is one case for `command.applied` and a `Set` of ids the fold has seen.

   The stronger consequence is the shape that case forced. **One intent is one append.** A ledger entry
   written *before* the effect can lose the effect to a crash in between; one written *after* can double
   it, and 1-3's review showed what a doubled approval costs. So `command.applied` is the ledger entry
   **and** the effect: it carries `intent_id`, `to_state`, `step_disposition`, `clears_step_error` and the
   hand-off fields, and the fold applies all of them from that one line. A crash cannot land between the
   record and the effect because there is no between, and the file is retired only afterwards — which is
   what makes delivery at-least-once and the effect exactly-once without a two-phase commit.

   The cost: `step.approved` is no longer emitted by any path. Its constant and its fold case are kept,
   because AD-5 makes an unused event type harmless and a later story may want it, but the vocabulary now
   has a member nothing writes.

2. **`src/runtime/paths.ts` gained four paths, not one.** `commands/` is what the Code Map asks for;
   `commands/applied/`, `commands/refused/` and `HANDOFF.md` are there for the same stated reason — one
   module owns the AD-9 layout, and a second spelling of any of them would be a second layout. Nothing is
   ever *read* from the two subdirectories: an intent is moved into `applied/` once its effect is durable
   and into `refused/` when it is quarantined, so neither is a second command path.

3. **`confirm`, `approve` and `kill` changed signature**, from `(run, reason?)` to `(run, options?)`, and
   `disengage`, `takeOver` and the general `steer` were added beside them. The reason is AD-19: a command
   records its principal and its source, and a bare `reason` string carries neither. Every one of these
   methods now writes an intent file and consumes it, so they are not a second command path — they *are*
   the file path, with the write and the consume in one call. `transition` and `assertSteerable` were
   deleted as dead: every command travels through `decideSteering`, so the terminal guard is applied once
   to the whole enum rather than once per method, which is the shape of the two defects 1-3's review found.

4. **`LoadedState` gained `events` and `PassResult` gained `steering`.** The exactly-once ledger is read
   from the log, and a pass already folds it; carrying the array avoids folding twice. `steering` is how a
   refusal, an unconsumed `awaiting` intent and a torn file become visible to a caller rather than silent.

5. **`blockedStepOf` moved from `reconciler.ts` to `steering.ts`**, unchanged. It answers "which step did a
   person just approve", and two spellings of that rule would be two answers.

Three decisions inside the intent contract, recorded because a reviewer could reasonably expect the other:

- **An intent id is shape-guarded at the door.** The exactly-once key travels in a payload, and AD-21's
  entropy sweep replaces any unbroken run of 24+ high-entropy characters — which a ULID is. So
  `mintIntentId` punctuates a ULID into eight-character groups, and an id that would not survive the log is
  refused rather than accepted and silently stripped of the thing that makes redelivery safe. The test for
  this drives a *real* minted id through a *real* recorder, because a low-entropy stand-in is exactly the
  mistake stories 1-2 and 1-3 each made once.
- **A torn file is given a grace period, then treated as abandoned.** The matrix asks both that a torn file
  is "not treated as consumed" and that nothing becomes "a poison file that is retried forever". A writer
  mid-write and a writer that died mid-write are indistinguishable except by time, so time is the
  discriminator: inside `TORN_INTENT_GRACE_MS` the file is left alone, outside it it is quarantined.
- **A redundant command is "already satisfied", not refused.** At-least-once delivery means one keystroke
  can leave two files — a crash between writing an intent and recording its effect is exactly that — so a
  second `confirm_spec` on a run past `drafting` is recognised, retired and not recorded. This was found by
  the crash-injection suite: with it refused instead, killing at `intent-written:confirm_spec` made the
  restart throw.

## Review Triage Log

### 2026-09-21 — Review pass (follow-up, on a `done` spec)

- claims filed: 63 across four layers — blind-hunter 22 (16 numbered plus 6 in its closing paragraph),
  edge-case-hunter 26, verification-gap 5 gap + 2 other, intent-alignment 8 divergences. The edge-case layer
  filed an enumerated list so its count is exact; the other three wrote prose, so those are my enumeration of
  the distinct claims each made.
- grouped into the 31 rows below. 23 patch entries applied, 4 deferred, the rest rejected on their refutation
  or as cosmetic. No filed claim is without a row.
- every `high` was verified by me against HEAD before the patch round and again after it. Three were verified
  empirically by driving the compiled build: the `approve` bypass (`drafting` returned `apply` with
  `toState: 'running'`, and now refuses), `mintIntentId('')` (returned `"cmd-"`, now refuses its seed), and
  the two reconciled bounds. The `resume-step` and commit-failure findings arrive pre-verified from the
  verification-gap layer, which reconstructed the post-story tree with `git archive` plus `git apply` and
  proved each by mutation against a green suite.

- `[high]` `[patch]` CAP-2 bypass: `approve` had no target-state guard, so `decideSteering` returned `toState: 'running'` for any non-terminal state. I drove it directly — `drafting`, `confirmed` and `blocked` all returned `apply` — so a run whose acceptance criteria were never confirmed entered execution, and the decision's own reason text cited CAP-12 while never noticing the run was unconfirmed. `confirm_spec` was CAP-2's only gate. Now refused unless the run is `blocked`, the one state `decideAction` answers with `await-approval`. Verified after the fix: `drafting` and `confirmed` refuse, `blocked` applies.
- `[high]` `[patch]` The handoff document told a person to `git checkout` a branch that does not exist. Both the "where the work is" and "next steps" blocks pushed the branch unconditionally inside `if (brief.escape !== null)`, with no check on `escape.failure`. Now gated on `failure === null` at both sites (lines 370 and 397); on failure the document repeats the hatch's own detail, which says where the uncommitted changes actually are. This is CAP-23's entire purpose, so a document that misdirects is the worst available failure.
- `[high]` `[patch]` A failed `git commit` reported the work as preserved. Neutralising the commit-failure branch left the whole suite green: the failure fell through to the success return with `preserved: true`, `failure: null` and a detail claiming the work was committed. Both previously unreachable branches — checkout failure and commit failure — are now covered by a per-subcommand failing `WorktreeGit` double. Composed with the row above, a take-over whose commit failed told a person their work was on a branch that did not exist while the run reached `handed_off`.
- `[high]` `[patch]` CAP-5 failed on the resume path: `watchForStopIntents` was called from exactly one place, so `resume-step` had no watcher and no post-termination consumption. A probe showed a `disengage` during a resume was not observed at all — the child was live 2.2s later, past the bound, the step recorded `completed` on its own, and the run was left `interrupted`. A step resumed after a crash is the long-running case where instant disengage matters most, and no deferral recorded it. Both paths now start the same watcher.
- `[high]` `[patch]` Seven of fourteen commands could never be refused: the `awaiting` branch returned before the terminal-state guard, so an `answer`/`pause`/`fork` intent on a terminal run was neither refused nor quarantined and its file was re-read on every pass and every 25ms poll, forever — contradicting this story's own Always claim. The guard moved above the branch; a new test asserts `terminal-run` for all fourteen commands.
- `[medium]` `[patch]` The declared disengage bound was smaller than the real kill grace: 2s in `reconciler.ts` against `EXECUTOR_KILL_GRACE_MS = 5_000` in `spawner.ts`, so the promise was unmeetable by construction. Split into an observation bound (2s, the loop's own share — so no existing latency assertion was weakened) and an end-to-end bound of 8s, with the grace named authoritative because it is a decision about a child process owned by the unit that signals it.
- `[medium]` `[patch]` Nothing wires the stopper, so CAP-5's mid-step property is inert as assembled. Not wired — that belongs to whoever assembles the engine — but made loud: a `steering.stopper_unwired` line is recorded once per run per process, so the missing capability is visible in the log instead of silent.
- `[medium]` `[patch]` `mintIntentId('')` returned the literal `"cmd-"` and passed the loggable check, so two such intents shared the exactly-once key the whole at-least-once argument rests on and the second was dropped as `already-applied`. Now refuses its seed and asserts its own output. Verified: `''` and `'short'` refuse, a real ULID mints.
- `[medium]` `[patch]` An intent id reused for a different command was silently swallowed as `already-applied`, because the ledger stored ids without commands. The ledger now carries the command and a mismatch is refused as `intent-id-reused`; an absent logged command still reads as `already-applied`, because a mismatch cannot be called on evidence the log lacks.
- `[medium]` `[patch]` `applyIntent` throwing left the intent neither retired nor quarantined, so the same failing intent was retried every pass forever. Now quarantined as `effect-failed` and the pass continues — safe because `command.applied` is the ledger entry and the effect in one append, so a throw means nothing landed.
- `[medium]` `[patch]` `steer()` returned success for a command nothing applied when the decision was `awaiting`, handing the caller the old state and no error. Now throws, carrying the owner's reason, while deliberately leaving the file in place for that owner.
- `[medium]` `[patch]` Durability gaps in `commands/`: the intent's rename was never followed by a directory `fsync`, so a crash could lose exactly the disengage that at-least-once delivery exists to never lose; `retireIntent` and `quarantineIntent` had the same gap; nothing swept `.tmp` debris; nothing pruned `applied/` or `refused/`. All four closed, with the sweep given a 60s grace because renderers also write here and a sweep-on-sight would race a live writer between its write and its rename.
- `[medium]` `[patch]` `readIntentFiles` could create the poison file it claimed to exclude: a read failure other than ENOENT was silently skipped, so the file was in neither `pending`, `refused` nor `incomplete` and was met and skipped by every pass forever. Now classified and refused as `unreadable-file`. A future mtime from clock skew had the same effect and is now reported as skew rather than youth.
- `[medium]` `[patch]` An intent id containing `.` could hide its own file: the id pattern admitted `.`, the file name embedded it, and the reader filtered anything ending `.refusal.json`. The pattern no longer admits `.`, and the sidecar filter — dead in both directions and the mechanism by which such a file vanished — was removed.
- `[medium]` `[patch]` `orderIntents` gave stop commands no precedence, so an earlier `confirm_spec` was applied before a later `disengage` — including when the user pressed disengage precisely to override it, on a writer-supplied and skewable `issued_at`. Stop commands now sort first.
- `[medium]` `[patch]` A stop intent naming a different step stopped whatever was running: the watcher matched on command alone. Now matches the step too, with a test that a `kill` naming `verify` leaves `implement` alone.
- `[medium]` `[patch]` The escape hatch had no defences for the environment it runs in — no `--no-verify` and no committer-identity fallback, so a repo with a pre-commit hook or an unconfigured identity failed the one commit that exists to save a user's work. Now `-c user.name`/`-c user.email` per invocation with `--no-verify`, and the worktree is restored to whatever branch it was on, read back rather than derived.
- `[medium]` `[patch]` `HANDOFF.md` was the one durable write here that was not atomic — a plain `writeFileSync`, deliberately performed *before* the recorded facts, so a crash mid-write left the human-facing note truncated. Now temp + fsync + rename + directory fsync.
- `[medium]` `[patch]` A take-over's recorded reason could be false: it was composed before `escapeHatch` ran and asserted the work was on a branch, and when git failed only `HANDOFF.md` was corrected while the `command.applied` payload and the folded checkpoint kept the claim. The reason no longer asserts a branch, and the corrected detail reaches all three.
- `[medium]` `[patch]` The mid-step gesture's outcome was discarded, so an intent applied mid-step never reached `PassResult.steering` and a refusal raised there was invisible — contradicting the Spec Change Log's own claim about `steering`. The outcome is now parked and drained into the pass result, and the four computed-but-unused `StopObservation` fields are recorded as a `steering.stop_delivered` line.
- `[medium]` `[patch]` `advance(run)` consumed no intents, so a caller driving it per run honoured a durable intent only if the mid-step watcher happened to catch it — against AD-19 making the file the only command path. `advance` without a preloaded snapshot now consumes first; with one, it does not, because the only such caller is `pass`, which has already consumed.
- `[medium]` `[patch]` Three mutations that left the suite green, each now covered by a test rather than a code change: replacing the mid-step `STOP_COMMANDS` filter with `read.pending[0]`, which would have let a user's unanswered `answer` kill every subsequent step because `awaiting` files sit in `commands/` by design; retiring an `awaiting` intent, which swallows a user's answer, unasserted because nothing checked `awaiting` at the pass level; and skipping the `command.applied` record for an `acknowledge` decision, which breaks AD-19's attributability for `continue` and `just_do_it`.
- `[low]` `[patch]` Nine smaller real defects: `effectTarget` was exported dead code whose doc described a guard that did not exist, and an effect naming an unknown step silently applied its `to_state`; `moveAside` named first collisions `.2`, was an unbounded `existsSync`/`rename` TOCTOU on a directory two processes write to, and let a second quarantined file overwrite the first's refusal sidecar; `quarantineOrphanIntents` destroyed *valid* pending intents with no grace, unlike the torn-file case, so an intent written before the first log append was lost; a `command.applied` with no usable `intent_id` was folded on every replay; `isLoggableIntentId`'s bound was a literal rather than the active policy's; `namedFields` printed "the declared shape rejects " with nothing after it.
- `[medium]` `[defer]` `step.approved` is emitted by nothing — the constant, its `FOLDED_EVENT_TYPES` entry and its fold case are all dead. Deliberately not removed: the Spec Change Log records keeping it as a decision, and two existing tests assert nothing re-emits it, so deleting it would edit a recorded decision. Carried rather than reversed.
- `[high]` `[defer]` No production caller constructs a `Reconciler` anywhere in `src/`, so none of this transport is on an execution path. Third story in a row with this shape (1-5's containment, 1-6's pool). Owned by stage 2; patch 7 makes the stopper half of it audible in the log.
- `[low]` `[defer]` `ageMs` returning `null` from a `statSync` failure is handled and commented but untested — there is no portable way to make `stat` fail on a file `readdir` just listed. The analogous read-failure class is now tested through a new injectable seam.
- `[low]` `[defer]` A refusal raised *mid-step* reaching `PassResult.steering` is now structurally possible but only the applied case is asserted; constructing a mid-step refusal needs a stop intent that is simultaneously refusable, which the terminal guard makes contradictory.
- `[false]` `[reject]` The `wrong-target-state` refusal is declared but never produced. It **is** produced, at `reconciler.ts:1670`, for a lost question compare-and-set. The real gap behind the claim — that no *target-state* refusal existed for the state-machine commands — was true and is the first row above.
- `[false]` `[reject]` Five claims about guards being tautological with respect to external input, or about constants being unused, that did not hold at the cited lines once followed to their callers. (5 findings)
- `[low]` `[reject]` Eleven hardening suggestions on inputs no caller can supply, where each fix adds a branch guarding state never shown reachable. (11 findings)
- `[maybe-false]` `[defer]` Four claims about behaviour under concurrent consumption by two engine processes, which AD-30 forbids and no test can construct without violating it. Recorded with what would settle them: a second engine, which AD-30 says must not exist. (4 findings)

## Design Notes

**At-least-once delivery with an exactly-once effect is the crux.** The tempting design is to delete an intent file once read, which makes delivery at-most-once: a crash in the wrong millisecond silently loses a disengage the user already pressed. The opposite — apply first, mark later — can double-apply an approval, and story 1-3's review showed what a doubled approval costs, since `approve` folds to `interrupted` and a re-run follows. The resolution is the one AD-15 already uses for the write surface: make the effect idempotent on a key. Carry `intent_id` into the event the effect appends, and have the fold ignore an id it has already seen. Then losing sleep over delivery stops being necessary.

**"Instant" is a measurable claim, so give it a bound.** `interface-contract.md` says disengagement is instant, obvious and always available. A pass that drives a step synchronously to termination cannot notice an intent that arrives mid-step, which is why story 1-3 deferred this. Whatever the mechanism — polling the directory while awaiting the step, a watcher, an abort signal threaded into the executor — the requirement is a declared bound and a test that a disengage written while a step runs takes effect within it. A test that writes the intent between passes proves nothing about the property.

**The handoff document is read by a person having a bad day.** `interface-contract.md` asks for a colleague's note, not a stack trace: what was attempted, what is known, where the work is, and what a person might do next. It is the one artifact in the system whose audience is exclusively human and whose failure mode is being unreadable rather than incorrect.

## Verification

**Toolchain:** the PATH default `node` on this machine is v22.14.0, below the declared floor. Use the nvm-installed Node 24.x LTS by absolute path:

```
export PATH="/Users/deep/.nvm/versions/node/v24.21.0/bin:$PATH"   # node v24.21.0, npm 11.19.0
```

**Commands:**
- `npm run typecheck` -- expected: exit 0
- `npm run lint` -- expected: exit 0
- `npm test` -- expected: exit 0; the commands, steering, handoff and disengage suites present and passing
- `npm run build` -- expected: exit 0
- `npx vitest run tests/engine.crash-injection.test.ts` -- expected: still converges on every discovered boundary
- `grep -rnE "process\.on|beforeExit|finally \{" src/engine/` -- expected: no halting or cleanup on an exit path
- `grep -rniE "docker|podman|containerd" src/engine/` -- expected: no match

## Auto Run Result

**Status: done, reviewed.** The four-layer review ran on 2026-09-21 as a follow-up pass on a `done` spec. 63
claims filed, 31 triage rows, 23 patched, 4 deferred. Suite 1346 -> 1391 tests across 51 files, zero skips,
zero failures; the crash-injection suite still converges on every discovered boundary.

**Five high findings. Three of them compose into one user-facing failure.** A failed `git commit` reported the
work as `preserved: true`; the handoff document then pushed `git checkout <branch>` unconditionally; and the
only test of a mid-step take-over ran against `/tmp/no-worktree-needed`, which does not exist, so it drove
exactly that failure path while asserting nothing about the branch. Together: a take-over whose commit failed
told a person their work was committed on a branch that was never created, and the run still reached
`handed_off` — the one outcome CAP-23 exists to prevent. Each third of that was found by a different layer.

The fourth was a CAP-2 bypass: `approve` had no target-state guard, so an unconfirmed `drafting` run entered
execution. I verified it by driving `decideSteering` directly, and verified the fix the same way. The fifth was
CAP-5 failing on the resume path, where `watchForStopIntents` was never called — a `disengage` during a resume
was not observed at all, the child was live past the bound, and the step recorded `completed` on its own.

**A constant that was wrong by construction.** The story declared a 2s disengage bound while
`EXECUTOR_KILL_GRACE_MS` is 5s, so the production stopper could never meet it. Split into a 2s observation
bound — the loop's own share, keeping every existing latency assertion at the same number — and an 8s
end-to-end bound, with the grace named authoritative because it is a decision about a child process owned by
the unit that signals it.

**Four mutations that had left the whole suite green are now each caught.** The mid-step `STOP_COMMANDS`
filter, whose loss would have let a user's unanswered `answer` kill every subsequent step; retiring an
`awaiting` intent, which swallows an answer; skipping the `command.applied` record for an `acknowledge`, which
breaks AD-19 attributability for `continue` and `just_do_it`; and the commit-failure branch.

**Residual risk, and why `followup_review_recommended` is true.** Five high entries were patched. The specific
unverified risk is that `advance()` now consumes intents where it previously did not, and the stop-precedence
change reorders when gestures apply — both behavioural changes to a loop no production caller constructs, so
neither is exercised by anything but tests. That closes when stage 2 assembles the engine.
