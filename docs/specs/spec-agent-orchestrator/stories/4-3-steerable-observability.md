---
title: 'Steerable observability — pause, inject, kill, fork'
type: 'feature'
created: '2026-09-24'
status: 'done'
review_loop_iteration: 1
followup_review_recommended: true
context: []
warnings: ['oversized']
deferred: []
---

<intent-contract>

## Intent

**Problem:** CAP-15's four controls over a live run — pause, inject a note, kill, fork — are all already
members of the `Command` enum, principal-attributed, and durable-intent-file-delivered (AD-19). Only `kill`
(and its `disengage`/`take_over` siblings) is actually honoured; `pause`/`inject_note`/`fork` sit in
`src/runtime/steering-view.ts`'s `'awaiting'` bucket, their intent files left on disk, unconsumed. This is
the last story before the stage 4 gate, which requires `threat-model.md`'s v0 minimum guardrail set
complete — CAP-15's own success line ("each of the four controls demonstrably affects a live run") is the
one part of that set this story closes.

**Approach:** `kill` is the structural template — `decideSteering` decides a pure effect, and a *separate*
mechanism (`watchForStopIntents`/`StepStopper`, already built) actually signals the live subprocess.
`pause` reuses that exact signaling mechanism, differing only in which disposition gets recorded
(`interrupted`, AD-8's own resumable one, never `killed`). `inject_note` and the person-initiated half of
`narrow` (found stale and folded into this story's own scope — see Boundaries) share one new delivery
mechanism: a durable note recorded against the run, consumed once by whichever step's input is built next.
`fork` is the one genuinely new mechanism: a new run, seeded from the source run's own current worktree
state, continuing independently and never mutating the source run at all.

## Boundaries & Constraints

**Always:**
- **`kill` is read, never changed.** `stopEffect` (`src/engine/steering.ts`), `STOP_COMMANDS`
  (`src/runtime/steering-view.ts`), and `watchForStopIntents`/`StepStopper`
  (`src/engine/reconciler.ts`/`src/engine/spawner.ts`) are this story's template, not its subject.
- **`pause` adds itself to `STOP_COMMANDS` and reuses the same live-stop signal — but "the difference is
  entirely in what gets recorded, never in how the process is signaled" is only true once `spawner.ts`
  itself is taught the difference, which this story's own review round found it is not, and this spec's
  original text wrongly assumed it already was.** `decideSteering`'s `pauseEffect` (mirroring `stopEffect`,
  targeting `toState: 'interrupted'`/`stepDisposition: 'interrupted'`) is necessary but not sufficient: by
  the time it runs, the step's own termination has *already* been durably recorded by
  `src/engine/spawner.ts`'s own outcome-handling, which today calls `stop(true)` unconditionally for every
  executor-initiated stop (`live.set`'s own `stop: () => { stop(true); }`, the internal `stop(markKilled:
  boolean)` closure that sets `killedByExecutor`) — regardless of which command (`kill` or `pause`)
  triggered it — and unconditionally records `disposition: 'killed'`. Because `inFlightStep` only matches a
  step whose disposition is still `null`, `pauseEffect`'s own correction becomes a no-op the moment this
  happens: the step is left permanently `'killed'` (AD-8: never resumed) while the *run's* own
  `FeatureState` reads `'interrupted'` — an incoherent, indefinitely-stuck combination, not merely a
  cosmetic mislabel, confirmed by tracing `dispositions.ts`'s `'killed'` → `'stop'` routing through to
  `decideAction`'s `{kind: 'idle'}` forever. **Fixed in this same spec round, not deferred**: `spawner.ts`'s
  public `kill(step, run)` gains a third parameter, e.g. `kill(step, run, options?: {readonly resumable?:
  boolean})`, threaded to the `live` entry's own `stop` closure so it calls the *existing*, already-tested
  internal `stop(false)` path (the exact one the wall-clock-timeout case already uses to produce
  `'interrupted'`) when `resumable` is `true`, rather than always `stop(true)`. `stepStopperFrom`
  (`src/engine/reconciler.ts`) passes `target.command === 'pause'` through as that `resumable` flag — the
  one piece of information `StepStopper`'s own type already carried and the original adapter discarded.
  This is not new behavior invented for this story: the SIGTERM-then-`'interrupted'` path already exists
  and is already exercised, for the timeout case; this fix only exposes it through `kill()`'s own entry
  point for a second trigger.
- A paused run resumes exactly the way any `interrupted` run already does (AD-8, by session id) — no new
  resume mechanism, once the fix above makes the step's own recorded disposition actually `'interrupted'`.
- **`inject_note` and person-initiated `narrow` share one new delivery mechanism: a durable note, consumed
  once, by whichever step's input is built next — never a change to a process already running.** A
  `claude` subprocess reads its input file once at start; nothing re-polls it mid-flight. So "inject a note
  into a running agent's next input" (`Command.InjectNote`'s own docblock) can only mean the *next* input
  file this run writes, whether that is a resume of the interrupted-by-something-else current step or the
  start of the next step in the plan — never the process already running when the command arrived. `narrow`
  is folded in here, not built as a second mechanism, because its own free-text argument (e.g. "just the
  refund path", already exercised by an existing test fixture in `tests/engine.reconciler.test.ts`) is the
  same shape of thing as an injected note — a scope-narrowing instruction is a note whose *content* asks
  for less, not a structurally different delivery. Both are recorded via one new event,
  `note.injected`, carrying the free text and a `kind: 'note' | 'narrow'` discriminator so a later reader
  (a person, or a future story) can tell "steering color" apart from "a scope reduction" without a second
  event type or a second field.
- **The note is delivered on `RunState`, cleared the moment it is consumed, never left to accumulate — and
  "consumed" means both events that build a fresh step input, not only one of them, which this spec's
  original text got wrong and this story's own review round caught.** Add `RunState.pendingNote: {
  readonly text: string; readonly kind: 'note' | 'narrow' } | null`, folded from `note.injected` (set) and
  cleared by *either* the next `step.started` **or** the next `step.resume_attempted` line for this run
  (whichever actually follows — a resume is "the next input this run writes" exactly as much as a fresh
  start is; AD-8 already treats `StepResumeAttempted` as its own step-lifecycle event distinct from
  `StepStarted`, and this fold must clear on both or clear on neither). `StepInputSchema`
  (`src/contracts/step.ts`) gains one new optional field, `steering_note: string | null` (never the `kind`
  discriminator — a step reads a note as a note; the discriminator is for the durable log's own readers,
  not the agent's own input), populated from `pendingNote.text` when present at the moment a step's input
  is built.
  **The pre-existing `stepInput()` cache-reuse branch must never silently swallow a pending note.**
  `stepInput()` (`src/engine/reconciler.ts`) already has a cache-hit path — when `steps/<step>/input.json`
  exists on disk and its `baseline_ref`/`contract_id`/`gates` all match the current attempt, it returns the
  *existing file verbatim*, never reaching the `steering_note` assignment at all. An ordinary AD-8 resume
  calls `stepInput()` with the exact same `baseline_ref` and (for any non-verification phase) the exact
  same empty `gates`, so it satisfies this cache-hit condition on essentially every resume — which is
  precisely the case a pending note most needs to reach, since pausing a step and injecting a note into it
  before resuming is this story's own headline workflow. Left unfixed, a note injected while a step is
  interrupted is neither delivered (the cache branch never assigns `steering_note`) nor cleared (no
  `step.started` fires for a resume, and the fix above only clears on a resume that actually delivered the
  note) — it either sits stale forever if no further step ever starts fresh, or is misdelivered later, into
  an unrelated step, whenever one finally does. Fixed: `stepInput()`'s cache-hit condition gains a fourth
  clause, `&& state.pendingNote === null` — a pending note always forces a fresh rebuild of the input file,
  bypassing the cache, so the note is never silently dropped. This is a narrow, deliberate exception to
  CAP-6's "a re-run reads the same bytes" rule, not a violation of it: the note is new content this run is
  intentionally introducing, the same way `inject_note`'s own existence already implies "this step's next
  input may legitimately differ from its last."
- **`fork` creates a wholly new, independent run — it never mutates the source run's own state at all.**
  A new reconciler entry point (e.g. `forkFeature(sourceRun: string): AcceptedFeature`) mirrors
  `acceptFeature`'s own shape: mints a fresh ULID, emits `run.created` on the *new* run's own log, and
  starts a fresh plan from `drafting` — never a copy of the source run's own step history (`rebuild.ts`'s
  fold is always one run's own log; there is no precedent anywhere in this codebase for seeding one run's
  `RunState` from another's, and inventing one is out of this story's scope — see Never). What *is*
  inherited is the worktree's file contents: the new run's own worktree is created with `createWorktree`'s
  existing `ref` option (`src/pool/worktree.ts`, already accepts an arbitrary starting ref, no new worktree
  capability needed) pinned to the source run's own current worktree `HEAD` — whatever `implement`/`test`
  work has landed there so far, the fork's own fresh plan begins from that snapshot, not from the
  repository's own unrelated `HEAD`.
- **A forked run's feature slug is disambiguated, so its eventual branch name never collides with the
  source run's.** `branchFor` (`src/engine/committer.ts`) derives a branch name from the feature slug
  alone, never the run id (confirmed by story 3-2's own investigation into the identical hazard for
  shadow-mode branch collisions) — two runs of one feature slug reaching `commit` would compute the
  identical branch name. The forked run's own feature slug carries a short, stable suffix derived from its
  own new run id — **the ULID's trailing 6 characters specifically, never its leading ones.** A ULID's
  first ~10 characters are a millisecond timestamp, identical for any two runs minted in the same
  millisecond, which two forks issued in quick succession routinely are; the monotonic minter's own
  same-millisecond collision handling increments the trailing random digits, so the *last* character always
  differs between two same-millisecond mints. `<feature>-fork-<last 6 chars of the new run's ULID>` is
  collision-safe for exactly this reason; a leading-chars suffix would not be, and this spec's original text
  said "first 6 chars" — corrected here after this story's own review round proved the leading-chars version
  would have collided (the implementer caught and fixed this independently before review; recorded here so
  the spec's own text agrees with the correct code).
- **The fork intent is consumed on the source run's own log, without changing the source run's own state.**
  A new durable event, `run.forked`, records that a fork happened and names the new run's id — emitted on
  the *source* run's log (so a person reading the source run's own timeline sees it was forked and where
  to), while the source run's `FeatureState`/step disposition are untouched. This is a genuinely different
  shape than every other command this story or 4-1 built: not an `IntentEffect` at all (that shape is
  entirely about mutating the *same* run's own state, per `src/engine/steering.ts:66`'s own fields), so
  `fork` is handled by its own reconciler-level check beside (never inside) `decideSteering`'s per-command
  switch — the same "a separate mechanism actually acts, `decideSteering` only ever decides a same-run
  effect" split `kill`'s own SIGTERM-sending already establishes for a different reason. **The fork intent
  is still marked applied through the normal, existing `command.applied`/`appliedIntents` idempotency path
  once handled** (the same exactly-once-by-id guarantee every other command already gets, per
  `src/engine/rebuild.ts`'s `appliedIntents` set) — never left as a redeliverable file that could trigger a
  second, duplicate fork on a later pass. This is the one place a command produces a durable side effect
  external to `IntentEffect`'s own same-run shape while still going through the standard consumption
  bookkeeping every other command's intent file already does.
- **`narrow`'s `steering-view.ts` entry is fixed as part of this story, not pointed at a story that never
  claims it.** Investigation found `narrow`'s pinned owner already read "story 4-3, which owns the other
  steering controls" while also stating "`narrow` itself is not yet named in any story's accepted scope" —
  self-contradicting, and would have failed `tests/engine.steering.test.ts`'s "never parks a command on a
  done story" guard the moment this story shipped with `narrow` left unaddressed. CAP-16's own success
  criterion is already fully satisfied by story 2-9's automatic, ceiling-triggered narrowing alone, so a
  person-initiated `narrow` is not required by any capability's stated success line — but leaving it
  permanently `'awaiting'` with no honest home was the actual defect, not a case for inventing one. Folding
  it into this story (reusing the `inject_note` delivery mechanism, per the bullet above) is the cheapest,
  most honest resolution once the mechanism it needs already exists here.
- All five commands' `COMMAND_HANDLING` entries become `{ kind: 'effect' }`, matching `kill`'s own.
- **The new `forked_run`/`note.injected` payload fields must survive the AD-21 redaction pass by the
  correct, field-scoped shape — never by "any declared identity shape passes for any field," which this
  story's own review round found weakens a pre-existing story-3-3 guarantee.** `forked_run` is a ULID and
  needs `EVENT_ENVELOPE_IDENTITY_SHAPES.run`'s shape specifically; `head_ref_oid`/`merge_commit` (story
  3-3's own fields, already in `EVENT_PAYLOAD_VERBATIM_FIELDS`) need `.baseline_ref`'s commit-SHA shape
  specifically, and only that one. Generalizing `preservePassthroughPayload`
  (`src/runtime/recorder.ts`) to accept *any* field against *any* shape — the union-of-all-shapes approach —
  would let a ULID-shaped value slip through in a field that should only ever hold a commit SHA (still
  caught by `provesPatternFree` if it were a real secret, but a genuine loss of the field-specific precision
  `hasEventIdentityShape(field, value)` (`src/contracts/event.ts`) already establishes for envelope-level
  fields). Fixed: extend that field-name-to-shape mapping convention to the payload-scoped fields too — a
  small map from each `EVENT_PAYLOAD_VERBATIM_FIELDS` entry to the *one* identity shape it needs
  (`forked_run` → the ULID shape, `head_ref_oid`/`merge_commit` → the commit-SHA shape) — never a shared
  "any shape" check across all of them.
- **`fork` delivering a fresh-plan run over an inherited worktree, rather than resuming the source run's
  own in-flight step, is a deliberate, disclosed reading of "fork from its current point" — recorded here
  explicitly after this story's own review round asked whether it undersells CAP-15's own "fork a running
  agent" wording.** The alternative (the new run somehow continuing the source's own step history) is
  exactly the cross-run state-copying this spec's own Never list already rules out, for the same reason
  given there: no precedent anywhere in this codebase seeds one run's checkpoint from another's, and
  building that is a spine change. Worth a person's expectation being set correctly (forking gives you the
  files as they stand, restarting the pipeline over them — not a live hand-off of the in-flight step
  itself) — a product/UX concern for whichever surface renders the fork control, not a defect in this
  story's own mechanism.

**Never:**
- No cross-run state-copying mechanism for `fork` beyond the worktree-ref pin — a forked run's own step
  history starts empty; it does not "remember" having already completed `analyse`/`plan`/`implement`
  because nothing in this codebase's architecture supports seeding one run's checkpoint from another's, and
  building that is a spine change well beyond this story.
- No change to `kill`/`disengage`/`take_over`, `STOP_COMMANDS`'s existing three members beyond adding
  `pause` as a fourth, or the AD-8 resume mechanism `pause` reuses unchanged.
- No re-opening of a run's confirmed acceptance criteria (CAP-2). `narrow`'s free text is delivered as a
  note the agent reads and interprets — it never amends `StepInput.acceptance_criteria` itself, which stays
  exactly what the run was confirmed with.
- No new notification/delivery channel for a note beyond the existing passive event-log/SSE/TUI visibility
  — the same "notify after the fact" reasoning story 4-1 already applied to a `recoverable` write, applied
  here to a steering note: the log already makes it visible the instant it lands.
- No change to `StepOutputSchema` or any built-in agent's own contract — `steering_note` is an *input*
  field only; nothing requires a step to acknowledge or echo it back.

## I/O & Edge-Case Matrix

| # | Input / situation | Expected |
|---|---|---|
| 1 | `Command.Pause` arrives while a step is in flight | The subprocess is signaled (the same SIGTERM/grace/SIGKILL sequence `kill` already uses); the step's disposition records `interrupted`, never `killed`; the run's `FeatureState` becomes `interrupted` |
| 2 | A paused run receives no further command | It sits `interrupted` exactly as any other AD-8-interrupted run does — resumable by session id, same as today |
| 3 | `Command.InjectNote` arrives with text while a run is between steps | `note.injected` (`kind: 'note'`) is recorded; `pendingNote` is set; nothing else changes yet |
| 4 | The next step this run starts, after row 3 | That step's own `StepInput.steering_note` carries the injected text; `pendingNote` is cleared afterward |
| 5 | A second `Command.InjectNote` arrives before the first is consumed | The second note replaces the first (only one pending note at a time — never a queue that silently grows) |
| 6 | `Command.Narrow` arrives with free text (e.g. "just the refund path") | `note.injected` (`kind: 'narrow'`) is recorded; consumed exactly as row 4 — the same mechanism, tagged differently |
| 7 | `Command.Fork` arrives on an in-flight run | A new run is created (fresh ULID, `run.created` on its own log), its worktree pinned to the source run's current worktree HEAD, with a disambiguated feature slug; `run.forked` is recorded on the *source* run's log; the source run's own state is unchanged |
| 8 | Two forks of the same source run | Two independent new runs, each with its own disambiguated slug (never colliding with each other or the source) |
| 9 | The forked run eventually reaches `commit` | Its branch name (derived from its own disambiguated slug) never collides with the source run's eventual branch name |
| 10 | `Command.Pause`/`Command.InjectNote`/`Command.Narrow`/`Command.Fork` arrive on a run already in a terminal `FeatureState` | Refused, the same `terminal-run` refusal `kill`/`disengage`/`take_over` already give a terminal run |
| 11 | A `fork` intent is redelivered (AD-19's at-least-once) after already being applied | No second run is created — the existing `command.applied`/`appliedIntents` exactly-once-by-id guarantee already prevents it, the same as every other command |
| 12 | A step is paused mid-flight, through the real, production `StepStopper`/`spawner.kill` chain, not a test fixture that models the intended behavior | The step's own recorded disposition is `interrupted`, not `killed`, and the run genuinely resumes on a later pass — row 1's own claim, proven against the real adapter, not only against `decideSteering`'s pure decision |
| 13 | A note is injected while a step is `interrupted`, and the next event for this run is a resume of that same step (not a fresh step start) | The resumed step's own input carries `steering_note`, even though `stepInput()`'s pre-existing cache-reuse branch would otherwise return the old input file unchanged; `pendingNote` is cleared by the resume |
| 14 | A real, non-repeated-character 40-character-hex value under `head_ref_oid`/`merge_commit`, and a real ULID under `forked_run` | All three survive AD-21 redaction verbatim; a ULID-shaped value placed in `head_ref_oid`/`merge_commit` instead does **not** survive (it is not the shape that field requires) |

</intent-contract>

## Code Map

- `src/engine/steering.ts` -- `stopEffect`, `case 'kill'`/`'disengage'`, `IntentEffect` -- the exact template `pause`'s own effect mirrors; `inFlightStep` -- reused for pause's own step-targeting
- `src/runtime/steering-view.ts` -- `STOP_COMMANDS`, `COMMAND_HANDLING`, `isStopCommand` -- add `'pause'` to `STOP_COMMANDS`; reclassify `pause`/`inject_note`/`narrow`/`fork` to `{kind: 'effect'}`; fix `narrow`'s stale/self-contradicting owner text
- `src/engine/reconciler.ts` -- `watchForStopIntents`, `StepStopper`, `acceptFeature` (the template `forkFeature` mirrors), `startRequest`/step-input assembly (where `steering_note` is populated from `pendingNote`)
- `src/engine/rebuild.ts` -- `RunState`, `ENGINE_EVENT_TYPES` -- add `pendingNote`, fold `note.injected` (set) and the next `step.started` for this run (clear) -- mirrors `pendingGate`'s own set/clear-on-a-later-event pattern from story 4-1
- `src/contracts/state.ts` -- `RunState` -- add `pendingNote` field, defaulted `null` the same way `degradation`/`pending_gate` already are
- `src/contracts/step.ts` -- `StepInputSchema` -- add `steering_note: z.string().nullable()`, alongside the existing `decisions`/`evidence` cross-step-context fields
- `src/contracts/event.ts` -- add `NOTE_INJECTED_EVENT_TYPE`/payload keys (`text`, `kind`), `RUN_FORKED_EVENT_TYPE`/payload keys (`forkedRun`)
- `src/pool/worktree.ts` -- `WorktreeCreateRequest.ref` -- already accepts an arbitrary starting ref; `forkFeature` pins to the source run's current worktree HEAD, no new worktree capability
- `src/engine/committer.ts` -- `branchFor` -- read, not changed; the forked run's own disambiguated feature slug is what keeps its derived branch name distinct, never a change to this function
- `tests/engine.steering.test.ts` -- the "never parks a command on a done story" guard this story's own `narrow` fix must keep passing; the existing tests that use `narrow` as their concrete example of `'awaiting'` handling need a different example command once `narrow` becomes `'effect'` (`fork` is the last one moving in this same story, so pick whichever member of `COMMANDS` is still genuinely `'awaiting'` after this story ships — if none is, a synthetic/mocked example replaces the real-enum-member approach these tests currently use)

## Tasks & Acceptance

**Execution:**
- `src/contracts/event.ts` -- add `NOTE_INJECTED_EVENT_TYPE = 'note.injected'` (payload: `text`, `kind: 'note' | 'narrow'`), `RUN_FORKED_EVENT_TYPE = 'run.forked'` (payload: `forked_run`)
- `src/contracts/state.ts` -- add `pendingNote: { text: string; kind: 'note' | 'narrow' } | null` to `RunState`, defaulted `null`
- `src/contracts/step.ts` -- add `steering_note: z.string().nullable()` to `StepInputSchema`
- `src/engine/rebuild.ts` -- fold `note.injected` to set `pendingNote`; clear it on **either** the next `step.started` or the next `step.resume_attempted` for this run (row 13)
- `src/runtime/steering-view.ts` -- add `'pause'` to `STOP_COMMANDS`; reclassify `pause`/`inject_note`/`narrow`/`fork` in `COMMAND_HANDLING` to `{kind: 'effect'}`; rewrite `narrow`'s stale entry
- `src/engine/steering.ts` -- `decideSteering`: `case 'pause'` mirrors `stopEffect` targeting `interrupted`; `case 'inject_note'`/`case 'narrow'` each emit an effect carrying the note text and kind (a new optional `IntentEffect.injectedNote: {text: string; kind: 'note' | 'narrow'} | null` field); `case 'fork'` is handled separately (see below), never inside this switch's own effect shape
- `src/engine/reconciler.ts` -- the effect-applying method emits `note.injected` when `injectedNote` is present; `stepInput()`'s existing cache-hit condition gains `&& state.pendingNote === null` (row 13); a new `forkFeature(sourceRun)` method mirroring `acceptFeature`, pinning the new worktree's `ref` to the source run's current HEAD and disambiguating the feature slug (trailing 6 ULID characters, never leading); a new check (beside, not inside, the per-command decision switch) that watches for a `fork` intent, calls `forkFeature`, and emits `run.forked` on the source run's own log without touching its `FeatureState`
- `src/engine/spawner.ts` -- `kill(step, run)` gains a third, optional `{resumable?: boolean}` parameter, threaded to the `live` entry's own `stop` closure so a `resumable: true` call reaches the existing internal `stop(false)` path (the one the wall-clock timeout already uses) instead of the hardcoded `stop(true)` (row 12)
- `src/engine/reconciler.ts` -- `stepStopperFrom` passes `{resumable: target.command === 'pause'}` through to `spawner.kill` (row 12)
- `src/contracts/event.ts` -- a field-name-to-identity-shape map for the payload-scoped verbatim fields (`forked_run` → the ULID shape, `head_ref_oid`/`merge_commit` → the commit-SHA shape), replacing the "any shape passes for any field" union
- `src/runtime/recorder.ts` -- `preservePassthroughPayload` consults that per-field map, never a shared "any declared shape" check (row 14)
- `tests/engine.steering.test.ts`, `tests/engine.reconciler.test.ts`, `tests/engine.disengage.test.ts` -- new: one covering test per I/O matrix row, **including rows 12 and 13 driven through the real `stepStopperFrom(spawner)`/`stepInput()` production code paths, never only a test fixture that models the intended-but-not-yet-real behavior**; `tests/runtime.recorder.test.ts` -- new: a ULID-shaped value placed in `head_ref_oid`/`merge_commit` is confirmed rejected (row 14); update the pre-existing tests that used `narrow` as their concrete `'awaiting'`-handling example

**Acceptance Criteria:**
- Given a step in flight, when `Command.Pause` is applied through the real production stopper chain, then the subprocess is signaled and the step records `interrupted`, never `killed`, and the run actually resumes on a later pass (rows 1, 12)
- Given an injected note, when the next step's input is built — whether a fresh start or a resume of the same step — then it carries the note and the pending note is cleared (rows 3-4, 13)
- Given a second note before the first is consumed, when it's injected, then it replaces rather than queues (row 5)
- Given a fork command, when it's applied, then a new, independent run exists with a worktree pinned to the source's current state, a disambiguated feature slug, and the source run's own state is unchanged (rows 7-9)
- Given a real 40-hex value and a real ULID in their respective new payload fields, when the recorder appends the line, then each survives redaction only in the field whose shape it actually matches (row 14)

## Spec Change Log

## Review Triage Log

### 2026-09-24 — Review pass (round 1)
- verdicts: 8 findings — high 2, medium 1, low 5, false 0, maybe-false 0 — routed 3 patch, 5 reject
- findings:
  - `[high]` `bad_spec` `patch` **The most serious finding of this round, confirmed independently by all four review layers and by me directly.** A real, in-flight `pause` behaves identically to `kill` in production, and worse: `src/engine/spawner.ts`'s `kill()` unconditionally calls the internal `stop(true)` path regardless of which command triggered it, so an executor-stopped step is always recorded `disposition: 'killed'` — before `decideSteering`'s own `pauseEffect` (which correctly states `'interrupted'`) ever runs. Because `inFlightStep` only matches a step whose disposition is still `null`, `pauseEffect`'s correction becomes a no-op once the step has already terminated `'killed'`, leaving the run's `FeatureState` reading `'interrupted'` (nominally resumable) while its one step is permanently, architecturally `'killed'` (AD-8: never resumed) — traced through `dispositions.ts`'s `'killed'` → `'stop'` routing to `decideAction`'s `{kind:'idle'}` forever. This is not a mislabel; a paused, in-flight run is stuck indefinitely. Disclosed only in a test-fixture docblock ("this fixture is deliberately more capable than today's real adapter"), never in the spec's own `deferred` list or a production docblock. This was my own spec's error, not only the implementer's: I assumed the recording distinction was achievable purely at the decision-effect level and did not account for the spawner's own outcome-handling already having recorded a termination by the time that effect runs. Fixed via a `bad_spec` loopback: `spawner.ts`'s `kill()` gains a `resumable` option threaded from `stepStopperFrom`'s already-available `target.command`, reusing the exact SIGTERM-then-`stop(false)` path the wall-clock-timeout case already uses and already tests correctly (row 12).
  - `[high]` `patch` A note injected while a step is `interrupted` is silently dropped or misdelivered to a later, unrelated step. `stepInput()`'s pre-existing cache-reuse branch (added for CAP-6's "a re-run reads the same bytes," unrelated to this story) returns the on-disk input file verbatim whenever `baseline_ref`/`contract_id`/`gates` match the current attempt — which an ordinary AD-8 resume always does — never reaching the `steering_note` assignment. Compounded by the fold only clearing `pendingNote` on `step.started`, never on `step.resume_attempted` (the event a resume actually emits), so the note is neither delivered nor cleared on the exact "pause, inject, resume" sequence this story's own CAP-15 wording is about. Found by blind-hunter via a precise multi-file trace, independently confirmed by me reading the exact cited lines (`stepInput`'s cache branch returns before line 5625's `steering_note` assignment; the resume call site at line 3556 emits `StepResumeAttempted`, not `StepStarted`). Fixed: the cache-hit condition gains `&& state.pendingNote === null`; the fold clears `pendingNote` on either lifecycle event, never only one (row 13).
  - `[medium]` `patch` The AD-21 redaction fix for `forked_run` (a new payload-scoped verbatim field, this story's own addition) generalized `preservePassthroughPayload` to accept *any* declared identity shape for *any* field, rather than the field-specific shape story 3-3 established — weakening precision for the pre-existing `head_ref_oid`/`merge_commit` fields, which should only ever accept a commit-SHA shape and would now also accept a ULID-shaped value. Not a secret-leak vector (`provesPatternFree` still gates it), but a real, untested loss of field-specific precision. Found independently by verification-gap and blind-hunter, both citing the same code and both recommending the same fix. Patched: a field-name-to-shape map, extending `hasEventIdentityShape`'s own existing per-field-name convention to the payload-scoped fields rather than unioning every shape across every field (row 14).
  - `[low]` `reject` `fork` produces a fresh-plan run over an inherited worktree snapshot rather than continuing the source run's own in-flight step — a reading of "fork a running agent" narrower than pure continuity might suggest. Found by intent-alignment, which itself concluded this is a disclosed, defensible interpretation (the spec's own Never list already rules out the alternative — cross-run state-copying — as a spine change out of scope) rather than an intent violation snuck past the spec. Rejected as a code finding; the spec's own Boundaries text is expanded with an explicit product/UX note so a future renderer sets the right expectation.
  - `[low]` `reject` The row-8 (two forks) integration test drives two sequential `pass()` calls, which doesn't force an actual same-millisecond ULID mint, so it doesn't itself exercise the collision-resistant disambiguation the way row 9's own adjacent-ULID unit test directly does. Found by edge-case-hunter, which itself characterized the underlying property as "genuinely covered, just via a different test than row 8's own." Rejected: no gap in what's actually verified, only in which test verifies it.
  - `[low]` `reject` A hypothesized concurrent-pass race on the fork intent's redelivery guard (two overlapping `reconciler.pass()` calls both reaching the "no `run.forked` yet" check before either writes one). Investigated directly by blind-hunter: `consumeIntents`/`forkFeature`/`ForkWorktreePort` are entirely synchronous with no `await` in the relevant call chain, so two calls cannot interleave mid-sequence within one process, and cross-process concurrency is already excluded by the pre-existing AD-30 single-writer lock. Rejected: no live hazard found for the guard to protect against beyond the crash-recovery case it's already built and tested for.
  - `[low]` `reject` `forkedFeatureSlug`'s use of the ULID's trailing 6 characters, rather than its leading ones, for disambiguation. Verified independently correct by two reviewers tracing the monotonic minter's own same-millisecond collision handling (`incrementRandomDigits`, always changes the trailing digit) — this is the implementer's own self-caught fix (see Design Notes), not a remaining gap. Rejected as a finding: already fixed, already tested with adjacent-ULID fixtures proving it.
  - `[low]` `reject` Six further checks — terminal-run refusal tested individually per command, zero `Command` enum members left `'awaiting'`, `narrow`'s free text never reaching `acceptance_criteria`, no cross-run leakage of `steering_note`, `command.applied`/`appliedIntents` exactly-once tracking applied correctly to `fork`, and the replace-not-queue semantics for a second injected note — were all independently traced and confirmed correct by at least one reviewer reading the actual code and, where applicable, the actual test assertions. No action.

## Design Notes

**The `forkedFeatureSlug` ULID-slice choice was caught and fixed by the implementer before review, not
after.** The first pass used the ULID's leading 6 characters; a ULID's first ~10 characters are a
millisecond timestamp, identical for any two runs minted in the same millisecond — exactly what forking
twice in quick succession produces — so two forks would have received the *same* disambiguating suffix.
The implementer's own "two forks" test caught this directly (both slugs matched), and the fix (the trailing
6 characters, the monotonic minter's own randomness suffix) is confirmed collision-safe by two independent
reviewers tracing the minter's own same-millisecond increment behavior. Recorded here so the spec's own
text agrees with the correct code, per the Boundaries section above.

**Why `narrow`'s person-initiated form reuses the note-delivery mechanism rather than reusing story 2-9's
own `Degradation` machinery, even though both use the word "narrow."** `DegradationSchema`
(`src/contracts/state.ts`) is keyed by *ceiling dimension* (which budget line crossed eighty percent) and
never cleared — it is the record of an automatic, mechanical response to overrunning a limit (skip the
model-review tier). A person typing "just the refund path" is asking for something categorically different:
a semantic reduction of the *task itself*, which only the agent reading it can act on — there is no
ceiling dimension to name and no mechanical tier to skip. Treating the two as the same mechanism because
they share a name would conflate an automatic budget response with a human instruction; treating
person-initiated narrow as a specially-tagged note is the smaller, more honest addition.

## Verification

Run by me, exit status captured to a variable, after the review-round patches:
`export PATH="/Users/deep/.nvm/versions/node/v24.21.0/bin:$PATH" && npm run typecheck && npm run lint &&
npm run build && npm test` — **exit 0, 3007 tests across 103 files, zero failures, zero skips**. The
implementation reached 2996/103 (verified independently before dispatching review); the review-round
patches took it to 3007/103.

**Verified by me directly in the patched code, not taken on report:**
- The critical fix: `src/engine/spawner.ts`'s `kill(step, run, options?: StepStopOptions)` now calls
  `stop(stopOptions?.resumable !== true)` inside the `live` entry's own `stop` closure — `resumable: true`
  reaches the exact `stop(false)` path the wall-clock timeout already used and already produced
  `'interrupted'` through. Confirmed `stepStopperFrom` (`src/engine/reconciler.ts`) passes
  `{resumable: target.command === 'pause'}` — `target.command` is no longer discarded.
- Confirmed this is exercised through the *real* production chain, not only a fixture: read
  `tests/engine.disengage.test.ts`'s new describe block, which wires a genuine `createStepSpawner` (a real
  subprocess via `fake-claude.ts`) into a real `Reconciler` through `stopStep: stepStopperFrom(spawner)` —
  the actual adapter — drives a real mid-flight pause, confirms `disposition: 'interrupted'`, then drives a
  real second subprocess spawn via resume and confirms the step actually completes.
- The second fix: `stepInput()`'s cache-hit condition (`src/engine/reconciler.ts`) now requires
  `state.pending_note === null`, confirmed at its exact location with the docblock explaining why. Confirmed
  `src/engine/rebuild.ts`'s `StepResumeAttempted` case now also sets `pendingNote = null` unconditionally,
  mirroring `StepStarted`'s own clear — a resume no longer leaves an injected note stranded.
- The third fix: `EVENT_PAYLOAD_VERBATIM_FIELDS` (`src/contracts/event.ts`) is now a field-to-shape map
  (`head_ref_oid`/`merge_commit` → `'baseline_ref'`, `forked_run` → `'run'`), and
  `preservePassthroughPayload` (`src/runtime/recorder.ts`) consults it per field via the same
  `hasEventIdentityShape` function the envelope-level restore already uses — confirmed no more "any shape
  passes for any field" union.

**Matrix Test Audit.** All 14 rows are covered by tests that ran and passed in the run above, including
this round's additions: row 12 (pause through the real spawner/stopper chain, with an actual resumed
subprocess completing afterward), row 13 (a real interrupt→inject→resume sequence asserting the
executor's own received input carries the note, not just the on-disk file), and row 14 (a real minted ULID
confirmed rejected specifically under `head_ref_oid`/`merge_commit` while accepted under `forked_run`).

**Manual checks (if no CLI):** none — every behavior here is exercised by the automated suite above,
including the real-subprocess integration tests for the two highest-stakes fixes.

## Auto Run Result

**Status: done, reviewed, two serious production gaps caught and fixed before merge.** CAP-15's four
controls — pause, inject a note, kill (already built), fork — are all now honoured, closing the last gap
before the stage 4 gate. `kill`'s own live-process-signaling mechanism (`STOP_COMMANDS`, `watchForStopIntents`,
`StepStopper`) is the template `pause` reuses unchanged in how it signals a process, differing only in
recorded disposition. `inject_note` and a person-initiated `narrow` (folded into this story's own scope —
see below) share one durable, single-slot note delivered into whichever step's input is built next. `fork`
mints a genuinely new, independent run whose worktree is pinned to the source run's current state, with a
disambiguated feature slug so its eventual branch never collides with the source's.

**Two findings this round were not implementation slips — they were gaps in this spec's own design, caught
by review before either shipped.** First: the original text assumed the pause-vs-kill disposition
distinction could be made entirely at the `decideSteering` effect level, never accounting for the fact
that `spawner.ts`'s own outcome-handling durably records a step's termination *before* that effect ever
runs — meaning a real, in-flight `pause` would have been recorded `'killed'`, permanently unresumable,
identical to `kill` in every way that matters, despite `pauseEffect` itself stating the correct intended
disposition. All four review layers independently confirmed this via the same precise trace, and one
carried it further than my own: the run doesn't just get mislabeled, it gets stuck indefinitely (a
`FeatureState` of `'interrupted'` that looks resumable, paired with a step disposition of `'killed'` that
AD-8 says never is). The fix reuses machinery this codebase already had and already tested — the
wall-clock-timeout path's own `stop(false)` → `'interrupted'` route — exposed through `kill()`'s own entry
point for a second trigger, rather than inventing anything new.

Second, and found independently by only one reviewer (a genuine catch, not a repeat of the same finding):
a note injected while a step is `interrupted` would be silently dropped, or misdelivered to a later,
unrelated step, because a pre-existing caching optimization in `stepInput()` (built for an unrelated
reason — CAP-6's "a re-run reads the same bytes") returns a resumed step's on-disk input file verbatim,
never reaching the line that would have delivered the note, and the fold's own clearing logic only
recognized a fresh step start, never a resume, as "the moment consumed." This is the exact "pause, then
tell it something, then let it continue" sequence CAP-15's own wording is about, and it did not work
end-to-end before this round's fix.

**One review layer fabricated a finding in the previous story's review round; this round's four layers
were explicitly briefed on that incident and instructed to verify every claim with an actual tool call.**
All four reports this round were independently corroborated — either by another layer reaching the same
conclusion via a different trace, or by me reading the exact cited code myself before accepting a claim —
and none showed signs of the same failure mode. The two highest-stakes findings above were each confirmed
by three or four of the four layers independently, which is the level of convergence that made routing
them as immediate, same-round fixes (rather than deferring pending more certainty) the right call.

**Also fixed, medium severity:** the new `forked_run` payload field's own AD-21 redaction rescue was
generalized to accept *any* declared identity shape for *any* verbatim field, which would have let a
ULID-shaped value wrongly survive redaction in the pre-existing `head_ref_oid`/`merge_commit` fields
(story 3-3's own) that should only ever hold a commit SHA. Not a secret-leak vector, but a real,
previously-untested loss of field-specific precision — fixed with a proper field-to-shape map, extending
the exact per-field-name convention `hasEventIdentityShape` already established at the envelope level.

**Deferred, not decided here.** `fork` delivers a fresh-plan run over an inherited worktree snapshot,
never a live hand-off of the source run's own in-flight step — a disclosed, defensible reading of "fork
from its current point" (the alternative is exactly the cross-run state-copying this spec's own Never list
already rules out as a spine change), but worth a person's expectations being set correctly by whichever
surface eventually renders the fork control. Recorded as a product/UX note in the Boundaries text, not a
code defect.

**`followup_review_recommended: true`** — two high-severity findings were patched this pass, both
converging on the same underlying lesson: the two highest-stakes claims in the original spec — pause's
recorded disposition, and a note surviving into a resumed step's input — were each individually
plausible-sounding and each individually wrong once the real production code paths (rather than a
test-modeling fixture) were traced end to end. 3007/103 tests green, every patch independently
re-verified by me at the code level above, including confirming the real-subprocess integration tests
that specifically distinguish "the intended behavior" from "the actually-shipped behavior."
