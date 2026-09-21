---
title: 'Engine reconciler — checkpoint, lock, dispositions, baseline commits'
type: 'feature'
created: '2026-09-19'
status: 'done'
review_loop_iteration: 0
followup_review_recommended: true
context:
  - '{project-root}/docs/planning-artifacts/architecture/architecture-agent-orcastrator-2026-09-19/ARCHITECTURE-SPINE.md'
  - '{project-root}/docs/specs/spec-agent-orchestrator/SPEC.md'
  - '{project-root}/docs/specs/spec-agent-orchestrator/stories/1-2-runtime-recorder.md'
warnings: ['oversized'] # 18 files and 16 I/O scenarios; the largest story in stage 1, carrying the AD-31 crash-injection suite
deferred:
  - summary: >-
      RESOLVED: the four-layer review DID run for this story, in a later pass; this entry was stale.
    evidence: |-
      Recorded when the review was deferred, and never cleared once it ran. The Review Triage Log below
      carries the pass: 56 findings — high 22, medium 27, low 7 — across blind-hunter (14),
      edge-case-hunter (27), verification-gap (2 gap + 3 other) and intent-alignment (10), committed as
      `a4fb3f4` "Story 1-3 review: 56 findings, 42 patches". Corrected 2026-09-21 while scoping the
      outstanding reviews, because a story that says it was never reviewed when it was is a false record
      that makes the real gaps harder to find.
    severity: high
  - summary: >-
      The AD-21 redaction allow-list was widened to six envelope fields — a security-adjacent change
      to the one invariant with no remedy, unreviewed.
    evidence: |-
      EVENT_ENVELOPE_VERBATIM_FIELDS (run, feature, step, baseline_ref, parent_tool_use_id,
      session_id) restores identifier fields after the pass, each only when proven free of every
      credential class; stream fields are verbatim-or-dropped, identity fields fall back to the
      redacted value. This is by field path, not by value shape, which is the remedy story 1-2 itself
      prescribed. It is nonetheless the highest-value review target in the story.
    location: >-
      src/contracts/event.ts, src/runtime/recorder.ts
    severity: high
  - summary: >-
      Retry is unbounded: a step whose code is retry-with-backoff re-runs forever.
    evidence: |-
      AD-24's ceilings are story 2-9 and this story's Never list excludes them, so no limit was added.
      DECLARED_WALL_CLOCK_MS is threaded through and enforced by nothing. Until 2-9 lands, a
      persistently failing retryable step is an infinite loop.
    location: >-
      src/engine/dispositions.ts, src/engine/reconciler.ts
    severity: high
  - summary: >-
      A feature's declared territory is not reconstructable from the event log.
    evidence: |-
      Long repository paths redact, because the entropy candidate class includes '/':
      lib/util/helpers/formatters/currency/index.ts becomes [redacted]. Territory and the step list
      are therefore carried as declared configuration in a FeaturePlan, and compareCheckpointToLog
      deliberately does not compare territory. Making territory log-reconstructable is a redaction
      change, not an engine one.
    location: >-
      src/engine/territory.ts
    severity: medium
  - summary: >-
      confirm/approve/kill are engine methods rather than the AD-19 durable command intent files.
    evidence: |-
      Story 1-7 owns the intent-file transport, but the loop needed a declared way out of drafting and
      blocked. Related: kill can only land between passes, because an action drives a step
      synchronously to termination, so real mid-step steering arrives with 1-7.
    location: >-
      src/engine/reconciler.ts
    severity: medium
  - summary: >-
      approve re-runs the blocked step rather than re-escalating, which is a judgement call that was
      never reviewed.
    evidence: |-
      approve emits step.approved, which the fold turns into an interrupted step with no session id,
      so the next pass re-runs it instead of escalating the thing a person just answered. Defensible,
      but it means a human approval costs a full step re-run.
    location: >-
      src/engine/reconciler.ts
    severity: medium
  - summary: >-
      A reconcile pass is O(log size): every action re-folds events.jsonl to write the checkpoint.
    evidence: |-
      This is what makes 'the log wins' structural rather than asserted, but it inherits story 1-2's
      deferred tail-scan entry rather than resolving it, and the crash-injection suite re-folds once
      per boundary.
    location: >-
      src/engine/reconciler.ts, src/engine/rebuild.ts
    severity: medium
  - summary: >-
      A flaky test was found and fixed by the parent, and the same mistake shape is present in two
      other spawn helpers.
    evidence: |-
      tests/engine.lock.test.ts intermittently timed out (1 run in 4, then consistently once reading
      became event-driven). Root cause: `await once(child, 'exit')` called after the --crash child had
      already exited, so it waited for an event that had already fired. Fixed by attaching the exit
      listener at spawn time. tests/helpers/reconcile-until-killed.ts and
      tests/helpers/append-until-killed.ts spawn-and-kill children the same way and were not audited
      for the same pattern.
    location: >-
      tests/engine.lock.test.ts, tests/helpers/
    severity: medium
baseline_revision: '473e55e2c4abe7fe4d17e88819967871d8e588c7'
---

<intent-contract>

## Intent

**Problem:** Stories 1-1 and 1-2 shipped the contracts and the event log, but nothing advances a feature. There is no loop, no checkpoint, no run id, and no owner for the decision of what happens next — so crash recovery, instant disengage and the escape hatch have nowhere to live. AD-7 makes those three properties consequences of a reconciler loop rather than shutdown handlers that must each be correct, and without the loop they cannot be built at all.

**Approach:** Add `src/engine/`: a controller loop that reads the durable checkpoint, takes at most one action, and writes it back, holding no authoritative run state in memory. It mints run ids, holds the exclusive `ORCH_HOME` lock, rebuilds `state.json` from the event log when the two disagree, routes every step termination through a declared disposition, and resets a worktree to a step's `baseline_ref` before any re-run. Actual step execution is a port this story defines and story 1-4 implements.

## Boundaries & Constraints

**Always:**
- The loop reads the checkpoint, takes at most one action, writes the checkpoint, and holds no authoritative run state in memory. Killing it at any instant and restarting must produce identical behaviour to never having stopped.
- `events.jsonl` is the sole durable truth and `state.json` is a checkpoint derived from it. Where they disagree the log wins and the checkpoint is discarded and rebuilt.
- Only the reconciler writes a `state.json`, and every state write is atomic: a temporary file in the same directory, then rename. A reader sees either the previous checkpoint or the new one, never a partial.
- Exactly one engine per `ORCH_HOME`, enforced by an exclusive lock file recording pid and start time. A held lock is refused naming the holder; a stale lock is reclaimed only after verifying the recorded pid is gone.
- Run ids are ULIDs minted solely by the engine, monotonic within a process, 26 characters in Crockford base32.
- Every step termination records a disposition. Only `interrupted` is resumable: the loop attempts resume by recorded session id and, on failure, re-runs the step from its typed input file after resetting to `baseline_ref`. A step terminated by a steering command records `killed` and is never resumed or re-run.
- Every step records the `baseline_ref` its worktree stood at when the step began, and a re-run resets to that ref first, so a step may be re-run any number of times with identical effect.
- Every failure routes through the declared disposition table; an unrecognised code is treated as abandon-and-hand-off and never retried.
- Reconciliation is concurrent across features but serialises any features whose declared file territories overlap.
- The engine emits every event through the runtime recorder and never opens `events.jsonl` itself.
- `src/engine/` imports only from `src/contracts/`, `src/runtime/` and `node:` builtins.

**Never:**
- No `claude -p` spawning, no process management and no `--resume` invocation — story 1-4 owns the executor. This story defines the port it plugs into and drives a test double.
- No docker or container wrapper (1-5), no worktree creation or resource leasing (1-6), no command intent files (1-7), no question lifecycle (1-8), no renderer (1-9), no ceilings or degradation (2-9).
- Never write `events.jsonl` directly, never assign `seq`, and never treat `state.json` as authoritative for anything the log records.
- Never repair a corrupt log, and never continue a run whose log the reader refuses.
- Never put a run id, a commit SHA or any other unbroken identifier inside an event **payload** and expect to read it back: story 1-2's redaction pass replaces such values. Identifiers belong in the envelope's own declared fields or in the checkpoint.
- No git worktree mutation beyond resetting to a recorded `baseline_ref`; no branch creation or naming, which belongs to the committer in 2-7.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| New feature accepted | A feature request and a clean `ORCH_HOME` | A run id is minted as a 26-character Crockford base32 ULID and the checkpoint records `drafting` | No error expected |
| Monotonic ids | Two run ids minted in the same millisecond | The second sorts strictly after the first | No error expected |
| One action per pass | A checkpoint with work available | Exactly one action is taken and the checkpoint is written before the pass returns | No error expected |
| Checkpoint missing | An intact `events.jsonl` and no `state.json` | The checkpoint is rebuilt from the log and the run continues | No error expected |
| Checkpoint disagrees with the log | A `state.json` naming a step the log never started | The checkpoint is discarded and rebuilt from the log; the log's version wins | No error expected |
| Interrupted state write | The process dies during a checkpoint write | The file on disk is either the previous checkpoint or the new one | No partial checkpoint is ever read |
| Engine lock held | A second engine starts against one `ORCH_HOME` | Refused, naming the holder's pid and start time | Exits with a clear message; the lock is not stolen |
| Stale engine lock | A lock recording a pid that is gone | Reclaimed and startup proceeds | No error expected |
| Step terminates `interrupted` | A recorded session id | Resume is attempted by that session id | No error expected |
| Resume fails | Resume rejected by the executor port | The worktree is reset to `baseline_ref` and the step is re-run from its typed input | The re-run is the recovery, not an error |
| Step terminates `killed` | A step stopped by a steering command | Never resumed and never re-run | No error expected |
| Re-run idempotence | A step re-run twice from one `baseline_ref` | Both runs leave the same worktree state; effects are not doubled | No error expected |
| Unknown failure code | An error whose code is absent from the table | Treated as abandon-and-hand-off; no retry is attempted | Hand-off, never a retry loop |
| Overlapping territory | Two features declaring an overlapping file set | Serialised; only one holds the territory at a time | No error expected |
| Disjoint territory | Two features with no shared files | Both advance in the same pass | No error expected |
| Killed at a transition | The loop killed at each state transition in turn | Restart resumes to the same state the uninterrupted run reaches | No duplicated action, no lost action |

</intent-contract>

## Code Map

Stories 1-1 (`c21a511`) and 1-2 (`f6d4efa`) shipped `src/contracts/` and `src/runtime/`. This story is the first consumer of the recorder and the first writer of a checkpoint.

- `src/contracts/state.ts` -- create; the `state.json` checkpoint schema via `versioned()` per AD-28, the feature state enum matching the spine's lifecycle diagram, and the per-step record carrying disposition, `session_id` and `baseline_ref`
- `src/contracts/registry.ts` -- modify; register `run.state` as an `artifact`-kind contract, as story 1-2 did for `fetch.record`
- `src/engine/ulid.ts` -- create; ULID minting, monotonic within a process, Crockford base32, no new dependency
- `src/engine/lock.ts` -- create; the exclusive `ORCH_HOME` lock of AD-30 with pid and start time, refusal naming the holder, and reclaim only once the pid is verifiably gone
- `src/engine/checkpoint.ts` -- create; atomic read and write of `state.json`, sole writer, temp-file-then-rename
- `src/engine/rebuild.ts` -- create; fold `events.jsonl` into a checkpoint, and the comparison that decides the log wins
- `src/engine/dispositions.ts` -- create; map a step termination to its next action using the AD-35 table, with the unknown-code hand-off and the `interrupted`-only resume rule of AD-8
- `src/engine/territory.ts` -- create; declared file territories, overlap detection, and the serialisation decision
- `src/engine/baseline.ts` -- create; record a step's `baseline_ref` and reset to it before a re-run
- `src/engine/executor.ts` -- create; the step-executor port the loop drives: start, resume-by-session-id, and the termination it reports back. No process handling
- `src/engine/reconciler.ts` -- create; the loop: read checkpoint, choose at most one action, act, write checkpoint
- `src/engine/index.ts` -- create; the surface stories 1-4 and 1-7 consume
- `tests/engine.reconciler.test.ts` -- create; one-action-per-pass, the lifecycle transitions, disposition routing, resume-then-re-run, `killed` never resumed
- `tests/engine.crash-injection.test.ts` -- create; the second of the three AD-31 suites: kill the loop at every state transition and assert restart-identical behaviour
- `tests/engine.checkpoint.test.ts` -- create; log-wins rebuild, atomic write, and refusal of an unrecognised `schema_version`
- `tests/engine.lock.test.ts` -- create; held-lock refusal naming the holder, stale reclaim, and cross-process contention
- `tests/engine.territory.test.ts` -- create; overlap serialisation and disjoint concurrency
- `tests/engine.ulid.test.ts` -- create; length, alphabet, and monotonicity within a millisecond

Read-only evidence, authoritative and not to be edited by this story:

- `ARCHITECTURE-SPINE.md` -- AD-4 (log wins), AD-7 (reconciler), AD-8 (dispositions and resume), AD-26 (baseline), AD-29 (ULIDs minted by the engine), AD-30 (one engine per `ORCH_HOME`), AD-31 (crash-injection suite), AD-32 (reclamation is a reconcile action), AD-35 (disposition table); plus the feature-state and run-flow diagrams
- `src/contracts/step.ts` -- `STEP_DISPOSITIONS`, `RESUMABLE_STEP_DISPOSITIONS`, `isResumable`, `RUN_MODES`, `baseline_ref`, `StepInput`/`StepOutput`
- `src/contracts/error.ts` -- the disposition table already declares `engine.lock_held`, `step.resume_failed`, `git.baseline_reset_failed` and `internal.invariant_violated`
- `src/runtime/index.ts` -- `Recorder`, `readEventLog`, `runPaths`, `resolveOrchHome`

Carried forward from stories 1-1 and 1-2, recorded there as this story's business:

- An unbroken ULID or commit SHA inside an event **payload** is redacted by the 1-2 pass — verified, a payload `baseline_ref` reads `[redacted]`. Run ids and baseline refs must travel in the envelope's declared fields or in the checkpoint, never in a payload this story expects to read back. This is the single most important constraint carried into 1-3.
- `Recorder.open` reads and validates the whole log to compute the next `seq`, so it is O(file size) per resume. The reconciler reopens on every restart; keep that in mind when a crash-injection test loops.
- A recorded `ok: false` fetch entry is sticky for the run. Retry belongs here, in the disposition table, not in the record.
- The recorder is the sole writer of `events.jsonl` and the sole assigner of `seq`; the engine emits through it.
- Zod rules that bind `src/contracts/state.ts`: `z.int()` exports safe-integer bounds and falls outside the structured-outputs subset, `z.date()` cannot be exported, and refinements emit no JSON Schema keywords.

## Tasks & Acceptance

**Execution:**
- `src/engine/ulid.ts` -- mint monotonic Crockford base32 ULIDs with no new dependency -- AD-29 makes the engine the sole minter, and the Stack table names no ULID library
- `src/contracts/state.ts`, `src/contracts/registry.ts` -- define and register the checkpoint artifact with `schema_version` and the lifecycle states -- the checkpoint is on-disk state, so AD-28 and AD-17 both apply
- `src/engine/lock.ts` -- claim the `ORCH_HOME` lock, refuse a live holder naming pid and start time, reclaim only a verifiably dead pid -- AD-30 exists to stop two engines interleaving writes
- `src/engine/checkpoint.ts` -- read and write `state.json` atomically as its sole writer -- a partial checkpoint would be indistinguishable from a real one
- `src/engine/rebuild.ts` -- fold the event log into a checkpoint and decide disagreements in the log's favour -- AD-4 forbids two named authorities for one fact
- `src/engine/dispositions.ts` -- route a termination to retry, model promotion, human escalation or hand-off, resuming only `interrupted` and never `killed` -- one table keeps two units from treating one failure differently
- `src/engine/baseline.ts` -- record a step's `baseline_ref` and reset to it before any re-run -- AD-26 mechanises idempotence rather than asserting it
- `src/engine/territory.ts` -- detect overlapping declared file sets and serialise only those features -- parallelism is bounded by conflict domain, not by a worker count
- `src/engine/executor.ts` -- define the port for starting and resuming a step and reporting its termination -- keeping process handling out of the loop is what lets 1-4 arrive without touching the reconciler
- `src/engine/reconciler.ts`, `src/engine/index.ts` -- the loop and the surface 1-4 and 1-7 consume -- at most one action per pass is what makes every restart equivalent to never having stopped
- `tests/engine.crash-injection.test.ts` -- kill the loop at every state transition and assert the restart reaches the same state, with no action lost or doubled -- this is the second of AD-31's three required suites and the reason AD-7 chose a reconciler
- `tests/engine.{reconciler,checkpoint,lock,territory,ulid}.test.ts` -- cover the matrix rows, including cross-process lock contention and the log-wins rebuild -- a checkpoint that silently diverges from the log is the failure AD-4 forbids

**Acceptance Criteria:**
- Given a clean checkout on Node `>=22.22`, when `npm run typecheck && npm run lint && npm test && npm run build` is run, then all four succeed and the engine suites appear in the test output.
- Given a run whose `state.json` names a step the event log never started, when the engine opens that run, then the checkpoint is discarded and rebuilt from the log, and the rebuilt state matches what replaying the log alone produces.
- Given an engine holding the `ORCH_HOME` lock, when a second engine starts against the same home, then it exits non-zero naming the holder's pid and start time, and the lock is not stolen; and given a lock whose recorded pid is gone, then startup reclaims it.
- Given a step that terminated `interrupted` with a recorded session id, when the loop next runs, then it attempts resume with that id; and when the port rejects the resume, then the worktree is reset to the step's `baseline_ref` and the step is re-run from its typed input.
- Given a step that terminated `killed`, when the loop runs any number of further passes, then that step is never resumed and never re-run.
- Given the loop is killed at each of its state transitions in turn, when it restarts, then it converges on the same state as an uninterrupted run, with no action performed twice and none skipped.
- Given two features whose declared territories overlap, when a pass runs, then exactly one of them advances; and given two whose territories are disjoint, then both advance in the same pass.
- Given a failure carrying a code absent from the disposition table, when the loop routes it, then the outcome is abandon-and-hand-off and no retry is attempted.
- Given `src/engine/`, when its imports are inspected, then it imports only from `src/contracts/`, `src/runtime/` and `node:` builtins, and never opens `events.jsonl` directly.

## Spec Change Log

### Implementation, 2026-09-20 — four deviations from the Code Map, none to the intent contract

1. **`src/contracts/event.ts` and `src/runtime/recorder.ts` modified, beyond the two contracts files the
   Code Map names.** This is the deviation that matters, and it resolves story 1-2's headline deferred
   entry rather than working around it.

   1-2 recorded that its broadened entropy class redacts an unbroken ULID or commit SHA "inside an event
   payload", and that 1-3 "must not rely on a SHA or ULID inside an event payload". Probing the recorder
   before writing any engine code showed the reach is wider than that: **the envelope's own `run` field
   is redacted too.** A real 26-character ULID run id reads `[redacted]` on disk, so this story's Design
   Note — "a test should assert that a round-trip through the log preserves the run id and the baseline
   ref the reconciler depends on" — was not satisfiable, and AD-4's "a run is fully reconstructable from
   the event log" was already broken for any run with a real id. 1-2's own tests missed it because their
   run ids were punctuated test strings, not ULIDs.

   The fix is the one 1-2 named for exactly this case: *"a proven-pattern-free allow-list by field path,
   not a shape exemption"*. `EVENT_ENVELOPE_VERBATIM_FIELDS` declares six fields — `run`, `feature`,
   `step`, `baseline_ref` and the two AD-5 stream fields — and the recorder restores each only when the
   original is proven free of every credential class the pass recognises. The two stream fields keep
   their verbatim-or-dropped rule, because AD-5 admits no rewritten value there; the four identity fields
   fall back to the redacted value instead, so a line is still written and the fail-safe direction is a
   `step` that reads `[redacted]` rather than a run with no line at all. No shape exemption was
   reintroduced, and the 250-test contracts and runtime suites pass unchanged.

   `baseline_ref` became a declared optional envelope field in the same change, because the carried-forward
   constraint says identifiers belong "in the envelope's own declared fields or in the checkpoint", and the
   fold needs the AD-26 ref back to rebuild a checkpoint from the log alone.

2. **`src/contracts/index.ts` modified**, one line, so `state.ts` reaches the engine through the package
   surface — the same deviation and the same reason as story 1-2's first.

3. **The declared file territory is not emitted to the log.** Probing showed a long repository path also
   reads as high-entropy secret material (`lib/util/helpers/formatters/currency/index.ts` → `[redacted]`),
   because the entropy rule's candidate class includes `/`. Rather than widen the allow-list to cover
   free-form paths, the territory and the step list are treated as *declared configuration* supplied by a
   `FeaturePlan`, and the fold takes only run state from the log. `compareCheckpointToLog` therefore
   deliberately does not compare `territory`: the log is not its authority, so a difference there is a
   configuration change and not a checkpoint diverging from the truth. AD-9's per-run config snapshot is
   this plan's eventual home; story 1-7 sources it from the interview.

4. **Three test helpers added**, beyond the six test files the Code Map names:
   `tests/helpers/engine-fixture.ts` (the plan and git worktree both engine suites drive, shared so the
   crash suite's comparison is between two runs of one fixture), `tests/helpers/hold-engine-lock.ts`
   (cross-process lock contention — the in-process holder map would refuse a second acquire before the
   lock file was ever consulted, so a single-process test would pass without exercising AD-30), and
   `tests/helpers/reconcile-until-killed.ts` (the AD-31 harness).

Two design decisions inside the intent contract, recorded because a later story could reasonably have
expected the other choice:

- **An action is a step driven to termination**, not a "start" pass and an "observe" pass. Splitting them
  would mean holding an in-flight process in memory between passes, which is the in-memory owner AD-7
  forbids. The consequence is that a crash inside a step leaves a `step.started` with no termination, and
  the loop **adopts that as `interrupted`** on the next pass — a recorded action, so it is visible in the
  log rather than inferred by each reader.
- **The checkpoint is written by folding the log, never from memory.** Every action re-reads
  `events.jsonl`, folds it, and writes the result, so a checkpoint cannot carry a fact the durable truth
  does not, and `reconcileCheckpointAgainstLog` returns the folded state in *both* branches — the log
  wins unconditionally rather than "when they disagree". The cost is that a pass is O(log size);
  1-2 already deferred the tail-scan path and this story inherits that entry rather than adding one.

`ENGINE_EVENT_TYPES` declares ten event types in `src/engine/rebuild.ts` rather than growing the
contracts' `EVENT_TYPES`. AD-5 makes that safe — a reader ignores a type it does not know, so adding one
is never breaking — and it keeps the engine's internal vocabulary out of the shared enum that both
renderers and every tool server compile against.

Zod constraints carried forward from 1-1 and 1-2 and respected in `src/contracts/state.ts`: no `z.int()`
and no `z.date()`; the non-negative count bound and the unique-step-id rule are refinements, which emit no
JSON Schema keywords. `run.state` is an `artifact`-kind contract, so the structured-outputs subset guard
does not bind it, while the registry's artifact sweep does — the contracts suites grew from 246 to 250
tests automatically on registration.

## Review Triage Log

### 2026-09-20 — Review pass
- verdicts: 56 findings — high 22, medium 27, low 7, false 0, maybe-false 0
- layers: blind-hunter (14), edge-case-hunter (27), verification-gap (2 gap + 3 other), intent-alignment (10)
- run after the story was first marked done: the user asked for 1-3 and 1-4 to be reviewed before story 1-5.
- findings:
  - `[high]` `[patch]` BH1 StepSpawnFailed escapes pass() unrouted, making a non-terminating re-run loop — VERIFIED: driveStep awaited executor.start bare. Patched with terminationFromThrown routing the code through AD-35.
  - `[high]` `[patch]` BH2 BaselineResetError escapes the same way; orchError built and never read — VERIFIED by code read. Patched: routes to hand-off via the declared abandon-and-hand-off disposition.
  - `[high]` `[patch]` BH3 a crash between mkdirSync and the first append wedges every later pass — load() threw for a run dir with neither artifact, and pass() calls load() for every run. Patched: IncompleteRunDirectory is skipped.
  - `[high]` `[patch]` BH4 one unreadable run poisons every other run in the pass — Patched: per-run refusals collected and reported; Promise.allSettled for admitted actions.
  - `[medium]` `[patch]` BH5 an inert drafting/blocked run holds its whole territory, starving overlapping features — Patched: inert runs excluded from territory contention; territory.ts docblock corrected.
  - `[high]` `[patch]` BH6 approve() can resurrect a killed step, breaking the AD-8 invariant — VERIFIED: no state guard, target picked as steps.at(-1). Patched: assertSteerable plus blockedStep, which asks the table which record escalates to a human.
  - `[medium]` `[patch]` BH7 the lock records acquire time, not process start time, so pid reuse is undetectable — VERIFIED: since = formatTimestamp() at acquire. Patched: real process start time via ps, compared on reclaim; a null answer never proves a mismatch.
  - `[low]` `[patch]` BH8 FOLDED_EVENT_TYPES claims every folded type but step.resume_attempted has no case — Patched: the set is enumerated explicitly and that type excluded with its rationale.
  - `[medium]` `[patch]` BH9 the AD-31 suite hand-inlines the fingerprint that contracts exports — Two copies of the comparison every convergence assertion rests on. Patched: imports featureStateFingerprint.
  - `[high]` `[patch]` BH10 the identifier round-trip test is vacuous: 'a'.repeat(40) is 0.00 bits/char — VERIFIED by parent: that value is never redacted; a real 40-hex SHA is 3.73 and is. The same mistake this story's change log cites as the reason 1-2 missed the bug. Patched with a real SHA and a real minted ULID.
  - `[medium]` `[patch]` BH11 the Reconciler makes a fresh minter per instance despite documenting a shared one — Patched: defaults to defaultUlidMinter; the ULID test reworded to match.
  - `[medium]` `[patch]` BH12 every acting run is folded three times per pass — Patched: the entry pass() already loaded is threaded into advance.
  - `[low]` `[patch]` BH13 sweepCheckpointTemporaries deletes any state.json.*.tmp despite its comment — Folded into the checkpoint work.
  - `[low]` `[reject]` BH14 createScriptedExecutor.start lacks the try/catch resume has — The double is test-only and its throw surfaces identically to a rejection in every suite that drives it; no consumer behaviour differs.
  - `[high]` `[patch]` EC1 executor.start rejection unhandled — same as BH1; patched
  - `[high]` `[patch]` EC2 BaselineResetError unhandled — same as BH2; patched
  - `[medium]` `[patch]` EC3 a truncated steps/<step>/input.json throws SyntaxError out of driveStep — Patched with a safe parse.
  - `[medium]` `[patch]` EC4 a folded baseline_ref of '' or [redacted] silently re-baselines on the previous attempt's HEAD — Patched: a non-SHA recorded baseline hands off rather than re-reading HEAD.
  - `[high]` `[patch]` EC5 approve() on a killed or terminal run — same as BH6; patched
  - `[medium]` `[patch]` EC6 confirm() on a terminal run re-enters execution — Patched by assertSteerable.
  - `[high]` `[patch]` EC7 kill() overwrites a completed step's disposition — VERIFIED by a reviewer probe: after a pass the checkpoint read implement:completed, and kill() made it implement:killed permanently. Patched: kill targets only an in-flight step.
  - `[medium]` `[patch]` EC8 one run's advance rejection loses every other run's pass result — same as BH4; patched
  - `[high]` `[patch]` EC9 a torn trailing append makes every later pass throw for all runs — same as BH4; patched per-run
  - `[medium]` `[patch]` EC10 a dropped artifact means step.started never lands and the fold loops forever — Patched: emit checks the recordResult outcome and throws UnrecordedAction.
  - `[medium]` `[patch]` EC11 a non-completed step earlier in the list is never routed — Patched: decideAction routes the earliest pending record. The first mutation slipped through because the fixture had only one non-completed step; the fixture now has two.
  - `[high]` `[defer]` EC12 a retry-with-backoff code recurs with no ceiling and no delay — Real and now broader, since step.spawn_failed routes to retry. Ceilings are AD-24 / story 2-9 and this story's Never list excludes them.
  - `[medium]` `[defer]` EC13 the same session id is resumed every pass forever — Same family as EC12: a resume ceiling belongs with the retry ceiling in 2-9.
  - `[medium]` `[patch]` EC14 clean -fd leaves an untracked nested repository behind — Patched with a test that an ignored path survives; -ff was not adopted because it would also destroy a legitimately nested checkout.
  - `[high]` `[patch]` EC15 git runs with no timeout and no maxBuffer — VERIFIED by code read. Patched: 120s timeout, 64 MiB buffer, both named constants.
  - `[medium]` `[patch]` EC16 a recycled pid makes ORCH_HOME permanently unstartable — same as BH7; patched
  - `[medium]` `[patch]` EC17 a future-version checkpoint whose shape also drifted is silently overwritten — parseVersionedArtifact parses shape before gating the version. Patched: SchemaVersionRefusal now carries config.schema_version_unrecognised so a caught refusal reaches the table.
  - `[low]` `[defer]` EC18 compareCheckpointToLog omits promotions, resets, terminated_at and handoff.reason — Divergence in those fields goes undetected on a non-admitted run. Real but narrow; the fields are advisory rather than control-flow.
  - `[medium]` `[patch]` EC19 nextModelRung treats indexOf -1 as a valid promotion target — Patched with a guard.
  - `[high]` `[patch]` EC20 two features with disjoint territories sharing one worktree destroy each other — Patched: territory is keyed on the worktree via sharesWorktree.
  - `[high]` `[patch]` EC21 a [redacted] feature slug wedges the run permanently — plans('[redacted]') threw and the run could never load again. Patched: planFor falls back to the checkpoint's feature.
  - `[medium]` `[patch]` EC22 (deletion) run/feature/step lost their previous redaction treatment — This is the allow-list widening. Patched by narrowing: step and feature are off the list entirely, run and baseline_ref carry mandatory shapes.
  - `[high]` `[patch]` EC23 (claim) a killed step is re-run after an approval — same as BH6/EC5; patched
  - `[high]` `[patch]` EC24 (claim) 'every failure routes through the table' held for one code path only — same as BH1/BH2; patched
  - `[medium]` `[patch]` EC25 (claim) only same-shaped future checkpoint versions are refused — same as EC17; patched
  - `[medium]` `[defer]` EC26 (claim) reclaim also requires a matching hostname, so a renamed host is never reclaimable — Real and outside the matrix row. Left deferred: refusing is the safe direction and a shared ORCH_HOME is excluded by the single-user assumption.
  - `[medium]` `[patch]` EC27 (claim) identical-effect decays when the recorded baseline folded to '' — same as EC4; patched
  - `[high]` `[patch]` VG1 a credential in a newly allow-listed identity field is held out by one unasserted call — DEMONSTRATED by the layer: moving verbatimOrDropped to the front of the guard left 513/513 green while writing an sk-ant token verbatim. Patched and re-verified by parent: sk-ant in baseline_ref reads [redacted], line kept, token absent.
  - `[high]` `[patch]` VG2 clean -fd omits -x and no test can observe an ignored path — DEMONSTRATED: changing to clean -fdx left 513/513 green, because the only worktree observation uses --exclude-standard. Patched with a direct read of an ignored path.
  - `[high]` `[patch]` VGO1 kill() rewrites a completed step as killed — same as EC7; reviewer-probed. Patched.
  - `[medium]` `[patch]` VGO2 no steering method guards a terminal state — same as BH6/EC6; patched
  - `[low]` `[patch]` VGO3 STEP_STARTED_PAYLOAD_FIELDS is exported claiming a test that does not exist — Patched: deleted.
  - `[medium]` `[defer]` IA-a lock refusal expected at the process surface, tested at the exception surface — No entry point exists at this commit, so nothing exits non-zero; the refused engine is always the vitest process. Deferred until an entry point exists.
  - `[medium]` `[patch]` IA-b steering kill expected at the running-step surface, exercised at record amendment — The retargeting half is patched. That a kill can only land between passes is inherent to one-action-per-pass and belongs to 1-7.
  - `[medium]` `[defer]` IA-c the interrupted checkpoint write is exercised after the write returns — The mechanism is right (temp, fsync, rename, dir fsync) but no injected kill lands inside the write window, and the torn case uses a deliberately non-atomic writer exported for the test.
  - `[medium]` `[defer]` IA-d 'killed at any instant' is exercised at the boundaries the loop declares about itself — 21 boundaries are real and strong, but windows that are not boundaries are never killed in — inside writeCheckpoint, between reset --hard and clean -fd, and between the executor's side effects and step.terminated.
  - `[medium]` `[defer]` IA-e territory and plan are re-supplied identically by fiat in every crash child — Convergence is asserted with the configuration half held constant; a restart handed a different plan is outside every test.
  - `[high]` `[patch]` IA-f the redaction change is the largest surface mismatch and had no test at its own surface — runtime.redaction and runtime.recorder suites were untouched by the story that changed them. Patched: cases added at the recorder surface.
  - `[low]` `[defer]` IA-g 'only the reconciler writes state.json' is a convention, and the barrel exports a non-atomic writer — Nothing mechanically prevents another unit from writing one.
  - `[high]` `[defer]` IA-h routing is implemented, backoff is not, and the unbounded case is untested — same as EC12: ceilings are 2-9.
  - `[medium]` `[defer]` IA-i interrupted carries two meanings, since approve() folds to it — A human approval therefore costs a full step re-run. Flagged by the story itself; left as the deliberate judgement it was.
  - `[low]` `[reject]` IA-j two Always constraints are verified lexically over comment-stripped source — It is the honest available check at this stage; a behavioural equivalent would require a module-graph tool the Stack does not pin.

## Design Notes

**The executor port is the story's main boundary decision.** AD-8 describes the reconciler attempting `claude -p --resume`, but spawning is story 1-4's subject and this story's Never list excludes it. The split: the loop owns the *decision* — which disposition is resumable, when to reset and re-run, when to hand off — and calls a port that reports a termination. Story 1-4 supplies the real `claude -p` implementation; this story drives a double. If the port's shape is wrong, 1-4 will have to change the reconciler, so the port is worth reviewing more carefully than the loop around it.

**Restart-identical is the property, not "handles SIGKILL".** The crash-injection suite must kill at *every* transition, not at a convenient one, and then assert the restart converges on the same state — which requires knowing what the uninterrupted run produces. The honest shape is to run the loop to completion once, record the resulting state, then for each transition index kill at that point, restart, and compare. A suite that only kills once, or that asserts "no crash", does not test AD-7.

**Identifiers must not travel in payloads.** Story 1-2's redaction pass replaces an unbroken ULID or commit SHA inside a payload; this was verified after that story's patch round. The reconciler handles run ids and baseline refs constantly, so every place one is emitted needs to be an envelope field or the checkpoint. A test should assert that a round-trip through the log preserves the run id and the baseline ref the reconciler depends on.

## Verification

**Toolchain:** the PATH default `node` on this machine is v22.14.0, below the declared floor. Use the nvm-installed Node 24.x LTS by absolute path, as stories 1-1 and 1-2 did:

```
export PATH="/Users/deep/.nvm/versions/node/v24.21.0/bin:$PATH"   # node v24.21.0, npm 11.19.0
```

**Commands:**
- `npm run typecheck` -- expected: exit 0
- `npm run lint` -- expected: exit 0
- `npm test` -- expected: exit 0; the engine suites present and passing alongside the contracts and runtime suites
- `npm run build` -- expected: exit 0
- `grep -rn "from '\.\./" src/engine/` -- expected: only `../contracts/...` and `../runtime/...`
- `grep -rn "events.jsonl" src/engine/` -- expected: no direct open or append; the engine emits through the recorder

## Auto Run Result

Status: done
Blocking condition: none

**REVIEW WAS INITIALLY SKIPPED, THEN RUN.** The user later directed: *"stop at 1-4 and run review for 1-3 and 1-4 first before moving to 1-5."* Four layers reviewed this story and 56 findings were triaged into 42 patch entries; see the Review Triage Log above. The paragraph that follows is the original note, kept for the record.

**Original note —** The user directed mid-run: *"No need to wait for reviews. You can complete as
many as you can. I will review code later."* No blind-hunter, edge-case, verification-gap or
intent-alignment layer ran against this story, and there is no Review Triage Log below. Stories 1-1 and
1-2 each surfaced 68-70 findings at this stage, four of them `high` in 1-2 alone, so the absence of a
review here is the dominant risk in the artifact. Read `status: done` as *implemented and gated*.

**Implemented change.** `src/engine/` — the reconciler: a loop that reads the checkpoint, takes at most
one action, and writes it back, holding no authoritative run state in memory. Ten modules: ULID minting,
the AD-30 `ORCH_HOME` lock, atomic checkpoint read/write, the log-wins rebuild, the AD-8/AD-35
disposition router, conflict-domain territory, AD-26 baseline reset, the executor port story 1-4 fills,
the loop, and the barrel. Plus `src/contracts/state.ts` registered as `run.state`.

**Verification performed** (Node v24.21.0 by absolute path):

- `npm run typecheck`, `npm run lint`, `npm run build` → exit 0; `npm test` → 13 files, **417 passed**,
  run three consecutive times to confirm stability (up from 246 at baseline `473e55e`)
- `src/engine/` imports only `../contracts/` and `../runtime/`; no direct open or append of `events.jsonl`
- AD-31's second required suite is present: 21 boundaries, discovered rather than hardcoded, each killed
  in a child and compared against a recorded uninterrupted run. The implementer mutation-tested it —
  removing orphan adoption fails 2 boundaries, removing the AD-26 baseline reset fails 4 with a
  duplicated effects ledger — so it is not passing vacuously
- Parent verified the identifier round-trip directly: a real minted ULID run id and a 40-character commit
  SHA both survive a write-and-read-back through the log

**One correction the parent owes the record.** Story 1-2's Auto Run Result stated that "the envelope's own
`run`, `feature` and `step` survive" redaction. That was wrong, and it was wrong because the parent's probe
used the ULID `01JBQZ8Q0000000000000000AA`, which is mostly zeros and carries 1.87 bits/char — below the
entropy threshold. A real minted ULID carries 4.10 bits/char and *was* being redacted, so AD-4
reconstructability was already broken when 1-2 was marked done. Story 1-2's tests missed it for the same
reason: their run ids were punctuated test strings. The implementer found this while probing before writing
engine code, and applied the field-path allow-list that 1-2's own deferred entry named as the correct
remedy. **This resolves the follow-up risk 1-2 was flagged with.**

**One real source defect the crash-injection suite found.** Killed after the final `feature.state_changed
→ committed` but before the checkpoint write, the restart left `state.json` at `verifying` permanently:
`pass()` filtered terminal runs out before writing anything, and a terminal run is never advanced again, so
nothing would ever reconcile it — a derived file permanently disagreeing with the log, which is exactly the
AD-4 divergence, surviving *because* the run finished. `pass()` now brings a lagging checkpoint up to date
for every run it does not act on.

**One flaky test the parent found and fixed.** `tests/engine.lock.test.ts` intermittently timed out (1 run
in 4). Root cause was `await once(child, 'exit')` called after the `--crash` child had already killed
itself — waiting for an event that had already fired. The exit listener is now attached at spawn time. The
parent's first diagnosis (missing stderr capture) was wrong and is corrected here; the stderr capture was
kept because it turns a silent 20-second timeout into a diagnosable failure.

**Follow-up review recommended: true** — because no review ran. The eight deferred entries above are ranked
with the three `high` ones first: the missing review itself, the widened redaction allow-list, and unbounded
retry until story 2-9 adds ceilings.

### Pass 2 — four-layer review and patch round (2026-09-20)

Status: done
Blocking condition: none

Four layers reported **56 findings — high 22, medium 27, low 7**, routed to 42 patch entries, 12 deferrals and
2 rejections. They converged on one root cause: the reconciler's only `catch` was the `ResumeRefused` one, so
`step.spawn_failed`, `git.baseline_reset_failed`, a corrupt log and a schema refusal all escaped `pass()`
instead of routing through AD-35 — and because `step.started` was already in the log with no termination, the
next pass adopted the step as `interrupted` and failed identically. A non-terminating loop built from codes
that each had a declared remedy. `BaselineResetError.orchError` was constructed and never read.

**The redaction allow-list was the story's own named review target, and it had a demonstrated hole.** A
reviewer moved one operand of the guard in `preservePassthrough` so identity fields restored without the
pattern-free proof: the suite stayed green at 513/513 while an `sk-ant-` token went verbatim into
`events.jsonl`. No test put a credential in any of the four newly allow-listed fields. Separately the parent
verified that a 5.00 bits/char token with no known prefix was redacted in a payload but written verbatim as
`step`, because `provesPatternFree` disables the entropy sweep by design.

**The implementer overruled the parent's instruction here, and was right.** The parent asked for shape gates on
all four identity fields. The implementer probed and found the proposed `step` shape
(`^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`) is satisfied by `qT7pLx2ZfNc4Wb9JmK1sVh6Ry3Dg8Eu5`, so the hole would
have stayed open. The better fix, applied instead: `step` and `feature` never needed restoring at all — their
legitimate values are punctuated and low-entropy, so the pass leaves them alone — so the allow-list is now
`run`, `baseline_ref` and the two AD-5 stream fields, with mandatory fixed-length shapes (26-char Crockford
ULID, 40 lowercase hex) that no credential format satisfies, checked in addition to `provesPatternFree`.

Parent verification after the patch round:

- `typecheck`, `lint`, `build` exit 0; `npm test` → 16 files, **542 passed** (was 513)
- Legitimate identifiers survive: a real minted ULID `run`, a real 40-hex `baseline_ref`, and ordinary
  `feature`/`step` values all round-trip unchanged
- The demonstrated hole is closed: a 5.00 bits/char token as `step` no longer lands verbatim; an `sk-ant-`
  token in `baseline_ref` reads `[redacted]` with the line kept and the token absent from the file
- The shape gate discriminates rather than blanket-redacting: a wrong-shape high-entropy `run` reads
  `[redacted]` while a real ULID is preserved
- The implementer mutation-verified each fix and reported two mutations that initially slipped through,
  strengthening the tests rather than the claims — one of them the same defence-in-depth-masking-the-pass
  mistake story 1-2 made

**The most instructive finding.** The identifier round-trip test written specifically to guard this story's
redaction fix used `'a'.repeat(40)` — 0.00 bits/char, never redacted. That is the exact mistake the parent
made in story 1-2, repeated inside the test created to prevent it, in a story whose own change log cites that
mistake by name. Two layers caught it independently.

**Deviations the implementer flagged, accepted by the parent:** `session_id` is not shape-gated to a UUID,
because story 1-2's serialisation-gate test depends on verbatim restore of a non-UUID session id and the
format is the CLI's to choose; `ReconcilerOptions.redaction` is new surface outside the Code Map, needed
because the engine had no way to register a run's injected credentials as AD-21 requires; and `lock.ts` now
shells out to `ps` for a process start time, which loses recycled-pid detection on a platform that will not
answer but never steals a lock from a live engine.

**Still deferred after this pass**, and the reason the follow-up flag stays true: unbounded retry with no
backoff, now reaching `step.spawn_failed` as well, until AD-24's ceilings arrive in story 2-9; the crash suite
killing only at boundaries the loop declares about itself; territory re-supplied identically by fiat in every
crash child; and no process entry point, so "exits non-zero" is verified nowhere.
