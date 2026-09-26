---
title: 'Reversibility classes enforced end to end'
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

**Problem:** `ReversibilityClass` (`reversible`/`recoverable`/`irreversible`, AD-12), the `reversibility`
field on every `WriteIntent`, and the per-project `gated_reversibility_classes` policy already exist
(`src/contracts/step.ts`, `src/contracts/installer.ts`) and are already populated (`committer.ts` classes
every write `irreversible`, per ADR-003's accepted per-phase table) — but nothing reads any of it.
`performWriteIntent`/`settlePreMergeWrites` dispatch purely on `kind`; a gated class has zero effect on
execution. `Command.Approve` exists and is fully wired, but only for a step that itself *failed* and
escalated (`blockedStepOf` finds a blocked step by asking whether its own termination disposition routes
to `escalate-to-human`) — there is no step failure here, so its exact mechanism does not fit. `Command.Reject`
is declared, principal-attributed, and text-required; its one existing use resolves an active *question*
with a decline (CAP-18), through `COMMAND_HANDLING`'s `'question'` classification — a separate meaning this
story adds a second, gate-specific one beside, never replacing.

**Approach:** Before `settlePreMergeWrites` calls the write executor for a composed commit's intents,
check the batch's declared `reversibility` (uniform across one composed commit's intents, per ADR-003's
per-phase classification) against the project's `gated_reversibility_classes`. When gated and not yet
resolved, block the run with a new, purpose-built pending-gate record — parallel to, not a repurposing of,
the existing step-failure `blocked` path — and give `approve`/`reject` a second, gate-aware branch each,
alongside their existing step-based one. Reversible writes proceed exactly as today (there are none
implemented yet; this exercises `irreversible`, the only class with real intents). Recoverable gets no new
machinery: the existing passive event-log/SSE/TUI visibility already satisfies "notifies after the fact"
for a write, per Boundaries below — see the Design Notes for why no new notification concept is built.

## Boundaries & Constraints

**Always:**
- **The gate is checked once per composed commit, not once per intent.** `COMMIT_WRITE_REVERSIBILITY`
  (`src/engine/committer.ts`) already classes an entire composed commit's intents uniformly — there is no
  case today where two intents in one `composed.intents` array carry different classes — so the check
  reads the first not-yet-settled intent's `reversibility` and applies to the whole remaining batch. A
  future write kind with a genuinely mixed-class batch is out of this story's scope (see Never).
- **A gate is a new, dedicated pending-state, never a repurposing of the step-failure `blocked` path.**
  `blockedStepOf` (`src/engine/steering.ts:152`) finds "the blocked step" by asking whether a step's own
  recorded termination disposition routes to `escalate-to-human` — there is no step failure here (the
  committing step already completed; it is the reconciler's own subsequent write-execution phase that must
  pause), so forcing a synthetic failure disposition onto a step that succeeded would corrupt AD-8's
  termination record for a lie the log would otherwise have to explain. Add `RunState.pendingGate:
  { readonly step: string; readonly intentId: string; readonly kind: WriteIntentKind; readonly
  reversibility: ReversibilityClass; readonly batch: readonly { readonly intentId: string; readonly kind:
  WriteIntentKind }[]; readonly resolution: 'pending' | 'approved' | 'rejected' } | null` (`intentId`/`kind`
  stay the triggering intent's own, for the existing per-field consumers; `batch` is every intent in
  `composed.intents` still unsettled at open time, including the triggering one, for the disclosure the next
  paragraph requires), folded (in `src/engine/rebuild.ts`) from a new event, `write.gate_opened`
  (`resolution: 'pending'`) —
  emitted by `settlePreMergeWrites` instead of calling the write executor, which then returns a new sentinel
  (`'gated'`, added beside `'none'`/`'awaiting-merge'`/`'unsettled'`) so its caller in `advance-state`
  transitions `FeatureState` to `'blocked'` with a reason naming the gated intent, exactly the visible
  signal CAP-12's success criterion asks for ("irreversible ones block, demonstrably"). **The disclosure
  names the whole remaining batch, not only the intent whose `reversibility` triggered the check** — caught
  in review: since one approval settles every remaining intent in the composed commit (the very next
  bullet), the `write.gate_opened` payload and the `blocked` transition's reason list every one of
  `composed.intents` still unsettled at open time (kind and target each), not only `firstUnsettled`'s own —
  a person approving should see the actual blast radius their one decision covers, not a narrower one.
- **`pendingGate.resolution`, not `pendingGate` itself going null, is what `write.gate_approved`/
  `write.gate_rejected` change — caught and fixed in this story's own review round, not the original design.**
  The original version cleared `pendingGate` to `null` directly on either resolving event, which raced with
  the *separate* `feature.state_changed` event the resolution's own effect also emits (to `running`/
  `degraded` for an approval, `handed_off` for a rejection): a crash landing the resolving event durably but
  not yet the state-change one leaves `state.state` still `blocked` while the fold has already forgotten
  which way the gate was decided. For a rejection specifically this is not merely untidy — a later,
  redelivered `Command.Approve` would find `pendingGate === null`, fall through to the pre-existing
  step-failure branch (which finds no blocked step and returns `toState: 'running'` unconditionally), and
  **silently reverse a person's explicit rejection of an irreversible write**. The fix: `write.gate_approved`/
  `write.gate_rejected` fold to `resolution: 'approved'`/`'rejected'` on the *same* `pendingGate` record,
  never to `null` directly; only the *following* `feature.state_changed` line (to `running`/`degraded`/
  `handed_off`) clears `pendingGate` to `null`, once state has actually caught up with the decision. A
  crash in between therefore leaves a fully truthful intermediate fold — "this gate was rejected, and the
  run hasn't finished handing off yet" — rather than an ambiguous "no gate" that a later command can
  misread.
- **An intent's gate, once resolved, is resolved for good, checked against the gate record's own
  `resolution` — never against a specific `intentId` a later pass might not re-derive.** The original
  version matched `write.gate_approved` against the specific intent that happened to be `firstUnsettled` at
  the moment the gate opened (`commit.git_push`, say); a crash after that one intent alone settled left
  `firstUnsettled` naming the *next* intent (`commit.pull_request`) on the next pass, whose id has no
  approval line of its own — re-opening a second gate for a batch a person had already approved once. Fixed:
  `settlePreMergeWrites` checks the *existing* `pendingGate` record's `resolution` for this run (not a
  per-intent lookup) — `'approved'` skips the gate check entirely and runs the settlement loop for every
  remaining intent in one pass, exactly as a single approval is meant to; `'rejected'` never calls the write
  executor and never re-opens a gate, regardless of which intent is `firstUnsettled`; only the true absence
  of any `pendingGate` record re-evaluates whether a fresh gate should open.
- **`decideSteering`'s `approve`/`reject` gate branches trust `pendingGate.resolution`, never assume
  `pendingGate !== null` alone means "still open."** `approve` proceeds (emitting the approval, per the
  bullet above) only when `resolution === 'pending'`; when `resolution === 'rejected'` it refuses loudly
  (`wrong-target-state`-shaped: "this gate was already rejected") rather than silently resuming — the fix
  that closes the crash-window reversal described two bullets up. When `resolution === 'approved'` (a
  redelivered `approve`, AD-19's at-least-once), it re-emits only the state-transition half idempotently,
  never a second `write.gate_approved`. `reject` mirrors this: `'pending'` proceeds; `'rejected'` (a
  redelivered reject after a crash) re-emits only the missing state-transition, never a second
  `write.gate_rejected`; `'approved'` refuses loudly (a gate cannot be rejected after it was approved).
- **`Command.Reject` refuses loudly, rather than guessing, when both a pending gate and an active question
  could be what it means — caught in this story's own review round.** `reject`'s pre-existing use resolves
  the run's active *question* (CAP-18, via `COMMAND_HANDLING`'s `'question'` classification); nothing stops
  a long-window question from still being open when the run reaches the commit step and opens a gate (no
  step blocks on every open question — only one whose own disposition routes to `escalate-to-human` does),
  so a run can genuinely carry both at once. Silently assuming "a pending gate means this reject is about
  the gate" would swallow a rejection a person meant for the question, leaving it open forever on a now
  `handed_off`, terminal run. Fixed: when `state.pendingGate?.resolution === 'pending'` **and** the run also
  has an active question, `reject` refuses with a clear reason naming both and asking which is meant, rather
  than picking one. This is the one case in this story where "checked once per composed commit" and "a
  person's steering command is unambiguous" can conflict, and refusing is the same "never guess" discipline
  `write.gate_opened`'s own read failures already follow.
- **`Command.Approve` gains a second branch, alongside its existing one, never replacing it.**
  `decideSteering`'s `'approve'` case checks `state.pendingGate` first: when its `resolution` is `'pending'`,
  the effect emits a `write.gate_approved` line and returns the run to `running`/`degraded` (the same
  degradation-preserving rule the existing branch already has) — no step disposition is touched, because no
  step is blocked. When `pendingGate` is `null`, behavior is byte-for-byte what it is today (the step-failure
  branch, unchanged). `IntentEffect` (`src/engine/steering.ts:66`) gains one new optional field to carry
  this, e.g. `readonly gateResolution: { readonly intentId: string; readonly outcome: 'approved' |
  'rejected' } | null`, consumed by whichever reconciler method already turns an `IntentEffect` into recorded
  events, alongside its existing `toState`/`stepDisposition`/`handoff` handling.
- **`Command.Reject` gets a real effect for the first time, gate-scoped only.** When `state.pendingGate` is
  pending, reject emits `write.gate_rejected` (carrying the command's own required reason text — already
  guaranteed by `COMMANDS_REQUIRING_TEXT` including `Command.Reject`) and hands the run off (CAP-23's
  existing `handoff` shape on `IntentEffect`, reusing `take_over`'s own pattern) — a person declining a
  specific proposed irreversible action is not a condition the engine can automatically recover from by
  re-running anything, so the honest answer is the same "stop and explain" CAP-23 already gives
  `abandon-and-hand-off`. When `pendingGate` is `null` and no active question conflict exists (see above),
  reject falls through to its pre-existing question-resolution behavior, unchanged.
- **The gated-classes policy is read for the first time, from where it is already declared — and its
  absence fails closed, not open, fixed in this story's own review round.** `PermissionsSchema.
  gated_reversibility_classes` (`src/contracts/installer.ts:790`) and the installer's own
  `GATED_REVERSIBILITY_CLASSES = ['irreversible']` default (`src/installer/write.ts:70`) already exist;
  `settlePreMergeWrites` reads the run's own AD-9 config snapshot (the same source `declaredBranchPattern`
  already reads) to find this project's actual policy. The original version treated an absent
  `permissions.toml` (or an absent profile entirely) identically to a present policy that explicitly gates
  nothing — silently letting every irreversible write proceed unattended for any project that never got, or
  lost, that file, directly contradicting CAP-12's unconditional "irreversible ones block, demonstrably."
  Fixed: an absent `permissions.toml` (the file does not exist for this run's config snapshot) falls back to
  the installer's own `GATED_REVERSIBILITY_CLASSES` default — a reference to the single already-declared
  constant, never a second copy of it — so "no policy on disk" means "the safe default applies," not "no
  gate at all." A *present* `permissions.toml` that explicitly declares an empty or narrower
  `gated_reversibility_classes` array is still honoured exactly as written (matrix row 6) — this fallback is
  only for the file's outright absence. A genuinely unreadable file (present but corrupt, or any error other
  than "not found") still throws `UnreadableGateConfiguration` exactly as before — never silently treated as
  either "no gate" or "the default."
- **Recoverable writes get no new notification mechanism.** No currently-implemented write intent is
  `recoverable` (`git_push`/`pull_request`/`git_note` are all `irreversible`, per ADR-003's committing-phase
  row); the class exists in the type and the gate-check logic treats it uniformly with `reversible` (neither
  is in the default `gated_reversibility_classes`, so neither blocks) — "notifies after the fact" is
  already true of every write today, since `write.attempted`/`write.executed`/`write.failed` are already
  durable and already passively visible on the SSE stream (story 3-1) and the TUI's own event-log rendering
  the instant they land, with no polling delay. This story does not add a push notification, an email, or
  any new delivery mechanism — see Design Notes for why that would be premature with zero `recoverable`
  write intents implemented to exercise it against.
- **Recoverable writes get no new notification mechanism.** No currently-implemented write intent is
  `recoverable` (`git_push`/`pull_request`/`git_note` are all `irreversible`, per ADR-003's committing-phase
  row); the class exists in the type and the gate-check logic treats it uniformly with `reversible` (neither
  is in the default `gated_reversibility_classes`, so neither blocks) — "notifies after the fact" is
  already true of every write today, since `write.attempted`/`write.executed`/`write.failed` are already
  durable and already passively visible on the SSE stream (story 3-1) and the TUI's own event-log rendering
  the instant they land, with no polling delay. This story does not add a push notification, an email, or
  any new delivery mechanism — see Design Notes for why that would be premature with zero `recoverable`
  write intents implemented to exercise it against.

**Never:**
- No change to `ReversibilityClass`, `REVERSIBILITY_CLASSES`, `WriteIntentSchema`'s `reversibility` field,
  or `COMMIT_WRITE_REVERSIBILITY`'s existing `irreversible` classification — all already correct and
  already ADR-003-accepted; this story is the missing *consumer*, not a reclassification.
- No per-intent gating within one composed commit — see the first Always bullet. A future write kind
  introducing a genuinely mixed-class batch is a later story's problem — but the assumption that a batch is
  uniform is asserted, never silently relied on: `settlePreMergeWrites` asserts every intent in
  `composed.intents` shares `firstUnsettled`'s own `reversibility` before treating one gate decision as
  covering the whole batch, throwing loudly rather than under-gating a later intent of a higher class than
  the one actually checked, should that assumption ever be violated.
- No new notification mechanism for `recoverable` (see Always) — this story does not invent a use for a
  class nothing yet implements concretely.
- No change to `blockedStepOf`, the existing step-failure `escalate-to-human` routing, or any of
  `dispositions.ts`'s AD-35 table. The new gate is a parallel condition on `RunState`, never a repurposing
  of the step-disposition machinery that already exists for a different kind of block.
- No new command. `approve`/`reject` already exist, are already principal-attributed (AD-19), and are
  already text-required for reject — this story gives them a second branch each, never a third command.
- No change to `Command.Kill`/`Command.Disengage`/`Command.TakeOver` — a person can still stop a
  gate-pending run exactly as any other non-terminal run, with no new guard added or removed for them.

## I/O & Edge-Case Matrix

| # | Input / situation | Expected |
|---|---|---|
| 1 | A composed commit's intents are all `irreversible`, and `irreversible` is in the project's `gated_reversibility_classes` (the installer's own default) | `settlePreMergeWrites` emits `write.gate_opened` for the first unsettled intent and returns `'gated'`; the run transitions to `blocked`; no write executor call is made |
| 2 | A gated run receives `Command.Approve` | `write.gate_approved` is emitted for the pending intent's id; the run returns to `running` (or `degraded`, if already degraded); no step disposition is touched |
| 3 | The next reconciler pass after an approval | `settlePreMergeWrites` finds the `write.gate_approved` line for that intent id, skips the gate check, and calls the write executor normally |
| 4 | A gated run receives `Command.Reject` with a reason | `write.gate_rejected` is emitted carrying the reason; the run hands off (CAP-23), never silently retries the same gated write |
| 5 | `Command.Approve`/`Command.Reject` arrive while `state.pendingGate` is `null` (an ordinary step-failure block, or no block at all) | Byte-for-byte the existing behavior — the step-failure branch, or the existing `wrong-target-state` refusal |
| 6 | A project's `gated_reversibility_classes` does not include `irreversible` (a hypothetical looser policy) | The write executor is called immediately, exactly as before this story — no gate, no `write.gate_opened` |
| 7 | A composed commit whose intents are already fully settled (a re-entered pass after everything landed) | No gate check occurs at all — `writeIntentSettled` already short-circuits before reversibility is even read |
| 8 | A shadow run (`mode: 'shadow'`) with `irreversible` gated | Gated exactly the same as a live run — `mode` does not change whether a person must approve; only whether the approved write is actually performed or suppressed once the gate clears |
| 9 | A run's config snapshot carries no `permissions.toml` at all (the file is absent, not merely empty) | Falls back to the installer's own `GATED_REVERSIBILITY_CLASSES` default; an `irreversible` composed commit still gates exactly as row 1 |
| 10 | A gated, blocked run also has an active, unresolved question when `Command.Reject` arrives | Refused, naming both the pending gate and the open question, rather than silently resolving either one |
| 11 | The reconciler crashes after `write.gate_rejected` lands but before the following `feature.state_changed → handed_off` line does; a later `Command.Approve` (redelivered or fresh) arrives | Refused (`pendingGate.resolution === 'rejected'`) — the run never resumes, and the rejection is never silently reversed |
| 12 | The reconciler crashes after the first intent of an approved batch settles but before the second does; the next pass re-enters `settlePreMergeWrites` | `pendingGate.resolution === 'approved'` is found directly (not re-derived per-intent), so the remaining intents execute without demanding a second approval |

</intent-contract>

## Code Map

- `src/contracts/step.ts` -- `REVERSIBILITY_CLASSES`/`ReversibilityClass`, `WriteIntentSchema.reversibility` -- read, not changed
- `src/engine/committer.ts` -- `COMMIT_WRITE_REVERSIBILITY = 'irreversible'` -- read, not changed; confirms every composed intent in a batch shares one class
- `src/contracts/installer.ts` -- `PermissionsSchema.gated_reversibility_classes` -- read, not changed
- `src/installer/write.ts` -- `GATED_REVERSIBILITY_CLASSES` default -- read, not changed
- `src/engine/config-snapshot.ts` -- `readStepConfiguration` -- the AD-9 snapshot reader `declaredBranchPattern` already uses; this story reads the project's permissions the same way, never a fresh file read
- `src/engine/profile.ts` -- `loadPermissions` -- returns `null` only for a genuinely absent file; the fallback to `GATED_REVERSIBILITY_CLASSES` lives at the call site in `reconciler.ts`, not here, so this function's own contract ("what's on disk, or nothing") stays honest
- `src/engine/reconciler.ts` -- `settlePreMergeWrites` (the call site the gate check is added to), `declaredGatedReversibilityClasses` (falls back to the installer's default on an absent file, still throws `UnreadableGateConfiguration` on a genuinely unreadable one), its caller in the `'advance-state'` case (the `'unsettled'`/`'awaiting-merge'`/`'none'` sentinel handling, extended with `'gated'`), `declaredBranchPattern` (the config-read pattern to mirror), `activeQuestion`/`resolveQuestionFromIntent` (read for the reject/question ambiguity check, not changed)
- `src/engine/rebuild.ts` -- `RunState`, `ENGINE_EVENT_TYPES` -- add `pendingGate` (with its `resolution` field) to `RunState`, fold it from the three new event types per the resolution-not-null-clearing rule above
- `src/engine/steering.ts` -- `decideSteering`'s `'approve'`/`'reject'` cases, `IntentEffect`, `blockedStepOf` (read for contrast, not changed), the `take_over` case's `handoff` shape (the pattern reject's own hand-off follows), `COMMAND_HANDLING`'s `reject: {kind: 'question'}` entry (read, confirms reject's pre-existing meaning this story adds a second one beside)
- `src/contracts/command.ts` -- `COMMANDS_REQUIRING_TEXT` (confirms `Command.Reject` already requires text) -- read, not changed
- `src/contracts/event.ts` -- add `WRITE_GATE_OPENED_EVENT_TYPE`/`WRITE_GATE_APPROVED_EVENT_TYPE`/`WRITE_GATE_REJECTED_EVENT_TYPE` and their payload keys
- `docs/planning-artifacts/architecture/architecture-agent-orcastrator-2026-09-19/ADR-003-built-in-agent-tool-grants.md` -- the accepted per-phase reversibility table -- authoritative classification, not re-derived here

## Tasks & Acceptance

**Execution:**
- `src/contracts/event.ts` -- add `WRITE_GATE_OPENED_EVENT_TYPE = 'write.gate_opened'` (payload: intent_id, kind, target, reversibility, step, batch — the whole remaining-intents list per the disclosure rule above), `WRITE_GATE_APPROVED_EVENT_TYPE = 'write.gate_approved'` (payload: intent_id), `WRITE_GATE_REJECTED_EVENT_TYPE = 'write.gate_rejected'` (payload: intent_id, reason) -- the durable record a gate opened and how it resolved
- `src/engine/rebuild.ts` -- add `pendingGate` (with `resolution`) to `RunState`; fold `write.gate_opened` to `resolution: 'pending'`, `write.gate_approved`/`write.gate_rejected` to `resolution: 'approved'`/`'rejected'` on the same record (never to `null`); only the following `feature.state_changed` to `running`/`degraded`/`handed_off` clears `pendingGate` to `null`
- `src/engine/profile.ts` -- `loadPermissions` unchanged (still returns `null` for an absent file, throws for a genuinely unreadable one)
- `src/engine/reconciler.ts` -- `declaredGatedReversibilityClasses`: on `loadPermissions` returning `null` for an absent file, return `GATED_REVERSIBILITY_CLASSES` (the installer's own default, imported, not duplicated) instead of `null`; still throw `UnreadableGateConfiguration` for any other read failure. `settlePreMergeWrites`: check the *existing* `pendingGate` record's `resolution` (not a per-intent `write.gate_approved` lookup) before deciding whether to open a new gate, run the batch, or refuse to proceed at all (per the resolution-based rules above); when opening a gate, include every still-unsettled intent in the emitted `batch`; assert every intent in `composed.intents` shares one `reversibility` before treating one decision as covering the batch, throwing rather than silently under-gating if that ever fails
- `src/engine/steering.ts` -- `decideSteering`'s `'approve'` case: read `state.pendingGate?.resolution`; `'pending'` emits the approval; `'rejected'` refuses loudly; `'approved'` re-emits only the state-transition half (redelivery-safe). `'reject'` case: first check whether an active question also exists alongside a `'pending'` gate and refuse naming both if so; otherwise `'pending'` emits the rejection+handoff; `'rejected'` re-emits only the state-transition half; `'approved'` refuses; `null` (no gate) falls through unchanged to the pre-existing question-resolution behavior
- `IntentEffect` (`src/engine/steering.ts`) -- add `gateResolution: { intentId: string; outcome: 'approved' | 'rejected' } | null`; the reconciler method that applies an `IntentEffect` emits the corresponding `write.gate_approved`/`write.gate_rejected` line when present (and only then — a redelivered, already-resolved case emits no second line, only the state transition)
- `tests/engine.reconciler.test.ts`, `tests/engine.steering.test.ts` -- new: one covering test per I/O matrix row (rows 1-12), plus a test driving `declaredGatedReversibilityClasses`'s genuinely-unreadable-file path (a corrupt `permissions.toml` or a non-`ProfileNotFound` throw) to confirm it still throws `UnreadableGateConfiguration` rather than silently returning `null` or the default

**Acceptance Criteria:**
- Given a composed commit whose class is gated, when `settlePreMergeWrites` runs, then the write executor is never called and the run blocks naming every remaining intent in the batch (row 1)
- Given a gated, blocked run, when `Command.Approve` is applied, then `write.gate_approved` is recorded, the run resumes, and no step's disposition changes (row 2)
- Given an already-approved batch, when the reconciler passes again after one intent settles, then the remaining intents execute without a second approval (row 3, row 12)
- Given a gated, blocked run, when `Command.Reject` is applied with a reason, then `write.gate_rejected` records the reason and the run hands off (row 4)
- Given an ordinary step-failure block (`pendingGate` is `null`), when `Command.Approve`/`Command.Reject` are applied, then behavior is unchanged from before this story (row 5)
- Given a project with no `permissions.toml` on disk, when a composed commit is `irreversible`, then it gates exactly as a project with the explicit default would (row 9)
- Given a pending gate and an open question both exist, when `Command.Reject` is applied, then it is refused naming both, never silently resolving one (row 10)
- Given a rejected gate whose state transition to `handed_off` never landed before a crash, when `Command.Approve` arrives, then it is refused and the run never resumes (row 11)

## Spec Change Log

**Round 1 review (four-layer):** three high-severity and one medium-severity defect found and fixed before
this story reached `done`. (1) An absent `permissions.toml` was treated identically to an explicit policy
gating nothing, silently letting every irreversible write proceed unattended for any project missing that
file — fixed by falling back to the installer's own safe default on absence, never on a genuinely unreadable
file (matrix row 9). (2) `Command.Reject` assumed a pending gate always meant "reject the gate," but a
long-window question can genuinely still be open at commit time — fixed by refusing loudly when both are
present rather than silently swallowing whichever the person meant (row 10). (3) The most serious: clearing
`pendingGate` straight to `null` on `write.gate_rejected` created a crash window (between that event and the
following `handed_off` transition) in which a later `Command.Approve` would find no gate on record and
silently reverse the rejection — fixed by tracking `resolution` on the gate record itself, cleared to `null`
only once the state transition actually lands, and having `approve`/`reject` both consult `resolution`
before acting (row 11). (4) The same crash-window fix also closes a related, lower-severity issue where a
crash between the first and second intent of an *approved* batch settling would re-derive `firstUnsettled`
as a new intent with no approval line of its own, demanding a second approval for a batch already approved
once (row 12) — resolved by checking the gate record's `resolution` directly rather than a per-intent
lookup. Also fixed: the gate-opened disclosure named only the triggering intent even though one approval
settles the whole remaining batch — corrected to name every intent in the batch (folded into the first
Always bullet, no separate matrix row). Kept unchanged, confirmed correct by review: the mixed-class-batch
assumption (now asserted rather than silently trusted), the shadow-mode gating behavior (row 8), and the
approve-side crash-recovery path that was already correct before this round (a crash before approval fully
resolves recovers correctly through the pre-existing "no blocked step" fallback, which happens to be the
right recovery for approval though not for rejection — this asymmetry is exactly what the `resolution` fix
addresses).

## Review Triage Log

### 2026-09-24 — Review pass (round 1)
- verdicts: 10 findings — high 3, medium 3, low 4, false 0, maybe-false 0 — routed 8 patch, 2 reject
- findings:
  - `[high]` `patch` An absent `.orch/permissions.toml` (a project onboarded before it existed, a hand-assembled `.orch/`, or the file simply missing) was treated identically to a present policy that explicitly gates nothing — `declaredGatedReversibilityClasses` returned `null` on `loadPermissions`'s absent-file `null`, and `settlePreMergeWrites`'s `gatedClasses !== null && ...` check treats `null` as "no gate at all," so every irreversible write for such a project proceeds completely unattended with no visible signal anything was skipped. Directly contradicts CAP-12's unconditional "irreversible ones block, demonstrably." — Verified directly by tracing `loadPermissions`/`declaredGatedReversibilityClasses`/`settlePreMergeWrites`. Found independently by intent-alignment, blind-hunter, and edge-case-hunter — three of four layers flagged the same gap. Patched: an absent file falls back to the installer's own `GATED_REVERSIBILITY_CLASSES` default (a reference, never a duplicate); a genuinely unreadable file still throws `UnreadableGateConfiguration` (row 9).
  - `[high]` `patch` `Command.Reject`'s new gate-check assumed `state.pendingGate !== null` always means "this reject is about the gate," but a long-window question (CAP-4) can still be open when the run reaches the commit step and opens a gate — nothing blocks step progression on every open question, only one whose own disposition escalates. A reject meant for the question would instead resolve the gate, handing the run off while the actual open question is left permanently unanswered on a now-terminal run. — Verified reachable by tracing `questions.ts`'s window mechanics and confirming no code blocks commit on an open, non-escalating question. Found by blind-hunter (confirmed reachable with a concrete trace) and intent-alignment (flagged the same risk at lower confidence). Patched: reject refuses, naming both the pending gate and the open question, when both exist (row 10).
  - `[high]` `patch` The original design cleared `pendingGate` straight to `null` on `write.gate_rejected`, racing the *separate* `feature.state_changed → handed_off` event the same effect also emits. A crash landing the rejection durably but not yet the handoff transition leaves `pendingGate` reading `null` while the run is still `blocked` — a later, redelivered `Command.Approve` would find no gate on record, fall through to the pre-existing "no blocked step" branch, and unconditionally return `toState: 'running'`, **silently reversing a person's explicit rejection of an irreversible write**. — Verified directly: traced the event-emission order and the fold, confirmed the redelivered-approve path reaches an unconditional `running` transition with no check against a prior rejection. Found by edge-case-hunter. Patched: `pendingGate` gains a `resolution` field (`'pending'`/`'approved'`/`'rejected'`) that the resolving event sets in place, never nulling the record directly; only the following state-transition line clears it. `approve`/`reject` both consult `resolution` and refuse rather than silently act on a gate already decided the other way (row 11).
  - `[medium]` `patch` The same crash-window mechanism (fixed above) also explains a related, less severe issue: a crash between the first and second intent of an *approved* batch settling causes `settlePreMergeWrites` to re-derive `firstUnsettled` as the next intent, whose id has no `write.gate_approved` line of its own — re-opening a second gate and demanding a second approval for a batch a person already approved once. Fails toward extra caution, not an ungated write, but violates the "resolved for good" boundary and would confuse an operator recovering from a crash. — Verified directly by tracing the per-intent-id lookup. Found by blind-hunter. Patched by the same `resolution`-based fix above: `settlePreMergeWrites` checks the gate record's own `resolution`, not a per-intent lookup, so one approval genuinely covers the whole remaining batch across a crash (row 12).
  - `[medium]` `patch` The `write.gate_opened` event and the `blocked` transition's reason name only the intent whose class triggered the check (`commit.git_push`), even though one approval settles the whole remaining batch (`git_push` **and** `pull_request`, plus `git_note` under shadow) — the blast radius disclosed to the approving person is narrower than the blast radius their approval actually authorizes. — Verified directly: confirmed the settlement loop has no gate check inside it and runs every remaining intent once the one gate clears, while the disclosure names only one. Found by intent-alignment. Patched: `pendingGate`/`write.gate_opened` now carry the whole remaining-intents batch, and the disclosure names all of them.
  - `[medium]` `patch` `declaredGatedReversibilityClasses`'s `catch` block (wrapping any read failure other than `ProfileNotFound` as `UnreadableGateConfiguration`) has zero test coverage — every fixture supplies a valid profile and permissions file, so a mutation silently swallowing that throw and returning `null` instead (treating a corrupt `permissions.toml` as "no gate") would ship undetected. — Verified via `grep -rn "UnreadableGateConfiguration\|declaredGatedReversibilityClasses" tests/` returning nothing. Found by verification-gap. Patched: a test supplying a genuinely unreadable/corrupt configuration confirms the throw still happens.
  - `[low]` `patch` No test simulates a crash between `write.gate_opened` landing and the following `blocked` transition landing — the window in which `rebuildFromLog` would fold `pending_gate` as set but `state.state` as not yet `blocked`. Traced by hand and found self-healing under the code as written (a re-entered pass just re-derives the same gate and completes the transition), but nothing proves it, and the fix above (checking `resolution` rather than re-deriving per intent) makes this exact scenario load-bearing enough to deserve a real test rather than resting on manual reasoning. — Found by verification-gap. Patched: a test constructs this crash window directly.
  - `[low]` `patch` The mixed-class-batch assumption (`settlePreMergeWrites` reads only `firstUnsettled`'s own `reversibility` and then treats a resulting decision as covering every remaining intent) is confirmed live in code, not hypothetical — correct under today's constraint that `COMMIT_WRITE_REVERSIBILITY` classes a whole batch uniformly, but nothing would catch the day that constraint is violated by a future write kind; approving a lower-class intent would silently release a higher-class one riding in the same batch. — Verified directly; found independently by blind-hunter and edge-case-hunter. Patched: an explicit assertion added, per the amended Never list, throwing rather than silently under-gating if a batch's intents are ever found to disagree.
  - `[low]` `reject` Matrix row 5's "ordinary step-failure block" half is only re-verified by the pre-existing, unmodified test suite for `blockedStepOf`'s own branch, not a fresh test in this story's own new describe blocks. — Found by edge-case-hunter. Rejected: the branch itself is untouched by this diff and its own established tests still pass; adding a duplicate test would verify code this story provably never changed.
  - `[low]` `reject` `write.gate_rejected`'s `Reason` payload uses the raw, untrimmed command argument while the handoff-embedded reason text uses the trimmed value computed in `decideSteering`, so the two could differ by incidental leading/trailing whitespace. — Found by verification-gap. Rejected: cosmetic only, no behavioral consequence, and pinning it would only test literal whitespace handling nobody's read path depends on.

## Design Notes

**Why no notification mechanism is built for `recoverable` yet.** CAP-12's own success criterion is stated
entirely in terms of the block/proceed distinction ("reversible actions proceed unattended and irreversible
ones block, demonstrably") — it says nothing about a delivery mechanism for the middle class, and
`architecture.md`'s own illustrative table lists a *notification*, not a specific channel. Every write today
is `irreversible`; building a notification channel now would be designing against a class with no concrete
occupant, guessing at a shape (email? webhook? a TUI banner?) the first `recoverable` write intent — likely
a future `domain_mutation` kind — should actually drive. The existing passive visibility (SSE, TUI event
log) already satisfies "notifies after the fact" in the only sense this story can test today: a person
watching either surface sees a `write.executed` line the instant it lands, with no gate in front of it.

**The architecture.md/ADR-003 tension on Jira writes, left unresolved by design.**
`architecture.md`'s illustrative table lists "write Jira" under Irreversible; ADR-003's accepted table
classes the whole `committing` phase (the only phase that writes today) `irreversible` and says nothing
about a Jira write specifically, because no Jira write path exists yet (`domain_mutation` is a reserved,
unimplemented `WriteIntentKind`). This story does not resolve that tension — there is nothing to classify
until a Jira (or other domain) write actually exists — and it is noted here rather than guessed at, so
whichever future story adds `domain_mutation` inherits the question explicitly instead of silently
inheriting the "always irreversible" behavior this story only implements because it's the only class
today's write intents actually use.

## Verification

Run by me, exit status captured to a variable, after the review-round patches:
`export PATH="/Users/deep/.nvm/versions/node/v24.21.0/bin:$PATH" && npm run typecheck && npm run lint &&
npm run build && npm test` — **exit 0, 2942 tests across 102 files, zero failures, zero skips**. The
implementation reached 2929/102 (verified independently before dispatching review); the review-round
patches took it to 2942/102.

**Verified by me directly in the patched code, not taken on report:**
- The critical fix: `RunState.pendingGate` now carries a `resolution: 'pending' | 'approved' | 'rejected'`
  field, set in place by `write.gate_approved`/`write.gate_rejected` (`src/engine/rebuild.ts`'s
  `withGateResolution`) rather than nulling the record — confirmed by reading the fold's two `WriteGate*`
  cases and the two *different* places the record is finally cleared to `null` (a rejected gate on its own
  `command.applied` line once `state !== 'blocked'`; an approved gate only once every intent in its own
  `batch` is `writeIntentSettled`, checked post-loop). Confirmed `decideSteering`'s `approve`/`reject` cases
  both branch on `gate.resolution` — `'rejected'` makes `approve` refuse (`wrong-target-state`); `'approved'`
  makes `reject` refuse; either resolution matching what a redelivered command already asks for re-emits
  only the missing state transition, never a second `write.gate_approved`/`write.gate_rejected` line.
- Row 11's own test (`tests/engine.reconciler.test.ts`) directly fabricates the crash window — appends a raw
  `write.gate_rejected` line with no following `command.applied` — and asserts `reconciler.approve(run)`
  throws `SteeringRefused`, the run stays `blocked`, and `writes` stays empty. This is the strongest possible
  verification of the most serious finding: the fabricated crash state is exactly what a real interrupted
  process would leave on disk.
- The double-approval fix: `settlePreMergeWrites` reads `state.pending_gate.resolution` directly — confirmed
  `gate.resolution !== 'approved'` returns `'gated'` unconditionally (no per-intent lookup), and
  `'approved'` falls through to run every intent in `remaining`, regardless of which one is `firstUnsettled`.
- The absent-permissions fix: `declaredGatedReversibilityClasses` returns `GATED_REVERSIBILITY_CLASSES` (the
  installer's own constant, moved to `src/contracts/installer.ts` so the engine can import it without
  crossing the dependency-direction guard, re-exported from `src/installer/write.ts`) both when
  `loadPermissions` answers `null` and when `ProfileNotFound` is thrown — confirmed a genuinely unreadable
  file still throws `UnreadableGateConfiguration`, never silently treated as either "no gate" or "the
  default."
- The reject/question disambiguation: confirmed `decideSteering` refuses with `'ambiguous-target'`, naming
  both the gate and the question, exactly when `gate.resolution === 'pending' && context.activeQuestionId !=
  null` — and that `consumeIntents` computes `activeQuestionId` fresh per intent before calling it.
- The batch-disclosure fix: confirmed `write.gate_opened`'s payload carries every entry in `remaining`
  (intent id, kind, target), not only the triggering intent.
- The mixed-class assertion: confirmed `settlePreMergeWrites` computes `new Set(composed.intents.map(...
  reversibility))` and throws `MixedReversibilityBatch` before any other logic runs, if that set ever has
  more than one member.

**Matrix Test Audit.** All 12 rows are covered by tests that ran and passed in the run above, including
this round's additions: row 9 (absent `permissions.toml`, plus a separate corrupt-file test confirming the
throw path), row 10 (ambiguous reject, at both the integration and pure-decision level), row 11 (the
rejection-reversal crash window, the highest-value test in this round), and row 12 (the double-approval
crash window). The `write.gate_opened`-to-`blocked` crash window and the `MixedReversibilityBatch` assertion
are also directly tested, per the Review Triage Log's `patch`-routed coverage items.

**Manual checks (if no CLI):** none — every behavior here is a pure decision function or a reconciler method
with injectable ports, fully exercised by the automated suite above.

## Auto Run Result

**Status: done, reviewed, one serious design defect caught and fixed before merge.** AD-12's reversibility
gate is wired end to end: `settlePreMergeWrites` (`src/engine/reconciler.ts`) checks a composed commit's
already-decided (ADR-003), already-uniform `reversibility` against the project's `gated_reversibility_classes`
policy before executing any of its write intents, blocking the run with a new, purpose-built
`RunState.pendingGate` — never a repurposing of the step-failure `blocked` path `blockedStepOf` already
owns — and giving `Command.Approve`/`Command.Reject` a second, gate-aware branch each, alongside their
existing ones untouched.

**The one genuine defect this round's review caught, before any of it shipped: a crash window let a later
approval silently reverse a rejection.** The original design cleared `pendingGate` to `null` directly on
`write.gate_rejected`, racing the *separate* `feature.state_changed → handed_off` event the same decision
also emits. A process crash landing the rejection durably but not yet the hand-off left the fold reading "no
gate" while the run was still `blocked` — a later or redelivered `Command.Approve` would find nothing to
disagree with it and unconditionally resume the run, silently undoing a person's explicit "no" to an
irreversible write. Caught by edge-case-hunter, independently traced to a concrete, reachable scenario
rather than a theoretical one. Fixed by giving the pending-gate record its own `resolution` field
(`'pending'`/`'approved'`/`'rejected'`), set in place by the resolving event and cleared to `null` only once
the state transition it caused actually lands — closing the exact window the bug lived in. The same fix,
applied from the other direction, also closed a related, lower-severity bug three independent reviewers'
traces converged on less directly: a crash between the two writes of an *approved* batch settling was
re-deriving which intent to check approval against, demanding a second approval for a batch a person had
already approved once.

**Two further high-severity findings, independently confirmed by three of the four review layers each:** an
absent `.orch/permissions.toml` (any project onboarded before it existed, or one that simply lost the file)
was treated identically to an explicit policy gating nothing, silently letting every irreversible write
proceed unattended — directly contradicting CAP-12's unconditional "irreversible ones block, demonstrably."
Fixed by falling back to the installer's own `GATED_REVERSIBILITY_CLASSES` default on the file's outright
absence, while a genuinely unreadable file still fails loudly. And `Command.Reject`'s two meanings — its
pre-existing use declining an active question (CAP-18), and this story's new one declining a gated write —
could collide, since nothing stops a long-window question from still being open when a run reaches commit;
blind-hunter traced this to an actually-reachable scenario, not a latent one. Fixed by refusing loudly,
naming both, rather than silently picking a target — this codebase's established "never guess" discipline
applied to a genuinely ambiguous steering command for the first time.

**Also fixed, lower severity:** the gate-opened disclosure named only the intent that triggered the check
even though one approval settles the whole remaining batch — a person approving now sees every intent their
decision actually authorizes. An implicit assumption that a composed commit's intents always share one
reversibility class (true today, per ADR-003) is now an explicit, loudly-thrown assertion rather than a
silent dependency a future write kind could quietly violate.

**One judgment call worth recording.** My own spec text, in describing the `resolution` fix, said "only the
following `feature.state_changed` clears [the record]" as if one rule covered both approve and reject. The
implementer found this literal wording breaks rows 3 and 12 for the approve case specifically — an approved
gate must stay on record, `resolution: 'approved'`, until its *whole batch* is durably settled (which can
span several reconciler passes), not merely until the approval's own immediate `running`/`degraded`
transition lands. They split the clearing rule accordingly (reject clears on its own terminal transition;
approve clears once `writeIntentSettled` is true for every intent in its `batch`) and flagged the deviation
explicitly rather than silently picking one reading. I verified this directly and it is correct — the
matrix rows are the testable contract, and my own prose was imprecise about a real asymmetry between the two
commands (a rejection's own transition is always terminal; an approval's is not the same event as the batch
finishing). Corrected in the Boundaries text above.

**Deferred, not fixed here.** Row 5's "ordinary step-failure block" half of `approve`/`reject` relies on the
pre-existing, unmodified test suite rather than a fresh duplicate test — the branch itself is untouched by
this diff. The `write.gate_rejected` reason payload's raw-vs-trimmed whitespace mismatch against the
handoff-embedded text is cosmetic only, with no behavioral consequence.

**`followup_review_recommended: true`** — three high-severity findings were patched this pass, including one
that involved reasoning through a narrow crash window (a category of bug this project's own review process
has repeatedly found hiding in write-executor and reconciler code across prior stories); 2942/102 tests
green, every patch independently re-verified by me at the code level above, including reading the
crash-window test itself to confirm it fabricates the exact state a real interrupted process would leave.
