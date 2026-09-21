---title: Event-log completeness — the facts the required surfaces are specified to show
type: feature
created: '2026-09-20'
status: done
review_loop_iteration: 1
followup_review_recommended: true
baseline_revision: db11e4b
context:
- '{project-root}/docs/planning-artifacts/architecture/architecture-agent-orcastrator-2026-09-19/ARCHITECTURE-SPINE.md'
- '{project-root}/docs/specs/spec-agent-orchestrator/interface-contract.md'
- '{project-root}/docs/specs/spec-agent-orchestrator/build-sequencing.md'
- '{project-root}/docs/specs/spec-agent-orchestrator/stories/1-10-tui-cards.md'
warnings:
- oversized
deferred:
- summary: 'RESOLVED 2026-09-21: the four-layer review ran. See the Review Triage Log.'
  evidence: 58 claims filed, 17 triage rows, 12 patched including three high. Suite 1522 -> 1542 tests
    across 51 files, zero skips. Four mutations caught, and the decisive one — discarding every parsed
    usage record, which passed 1522/1522 before — now fails.
  severity: high
- summary: A territory path that is long, dotless and hyphenless is redacted, and the reader then substitutes
    `['.']`, which collides with every other feature.
  evidence: 'Measured directly: `docs/planning/architecture/spine/decisions/records` is 50 characters
    in one

    unbroken run at 3.78 bits/char and is replaced, while `src/engine/reconciler.ts` survives because
    its

    dots and slashes break the run. The substitution is deliberately fail-safe — a feature serialised

    unnecessarily costs one pass, a feature admitted wrongly costs another feature''s work — but it is
    a

    real loss of parallelism for a repository with deep dotless directories. The durable fix is the same

    punctuated-identifier idiom stories 1-7 and 1-8 used, applied to declared paths.'
  location: src/engine/territory.ts
  severity: medium
- summary: The enriched `question.asked` keys have no payload schema, unlike the three new event types.
  evidence: '`questionAskedPayload` is their single writer and the fold reads them defensively, so nothing
    is

    unsafe today. Adding one would have meant either modifying `src/contracts/question.ts`, which this

    story''s Code Map did not cover, or duplicating `QuestionOptionSchema` into `event.ts`. The asymmetry

    is the thing to close: three of four new payloads are schema''d and one is not.'
  location: src/contracts/event.ts
  severity: medium
- summary: '`question.asked` now carries both `options` and `offered_options`, describing the same set
    two ways.'
  evidence: 'Required by AD-5: `options` keeps its old meaning — the joined id string — because changing
    an

    existing key''s meaning is breaking, and the labels and consequences arrive on a new key. The escape

    option is inside `offered_options` with `escape: true`, so both keys describe the same set in the
    same

    order. Nothing enforces that they agree, so a future writer can drift them.'
  location: src/engine/questions.ts
  severity: low
- summary: 'SPEC DECISION: replay cannot reproduce the shared-worktree half of territory serialisation.'
  evidence: 'Two features configured to share one worktree are serialised live and admitted together on
    replay. Neither remedy exists: the worktree is declared configuration, not a function of the run id,
    so it cannot be derived as the handoff branch is; and carrying it would put an absolute path holding
    a bare ULID in a payload, which AD-21 replaces. Now documented and demonstrated by a test. Latent,
    because four of the five territory readers have no callers.'
  location: src/engine/territory.ts
  severity: medium
- summary: 'SPEC DECISION: whether a terminal run should ever be back-filled.'
  evidence: This round decided no — a finished run never acts again, so the repair buys nothing while
    costing a declaration built from today's plan appended to a finished record. If the gate is read as
    "every run's log must be complete, including finished ones", that reverses. Worth an explicit ruling
    because the gate is load-bearing.
  location: src/engine/reconciler.ts
  severity: medium
---

# Story 1-11 — Event-log completeness

## Intent

Story 1-10 built the six required surfaces and, in building them, proved what the log does not carry. Five
facts that `interface-contract.md` requires a person to see are absent from `events.jsonl`, so five surfaces
are honest about being unable to show them rather than able to. This story puts those facts in the log.

It carries the stage-1 `done_checkpoint`. After the gate amendment of 2026-09-20 the gate reads: *a run is
fully reconstructable from the event log alone, and the executor container is verified to hold no push
credential.* The containment half is met and independently verified. This story is the whole of the
remaining half.

## Boundaries & Constraints

**Two of the five gaps close by deriving, not by adding a field.** 1-10's deferred entry proposed adding
`branch` and `document` to `handoff.recorded`. Investigation says do neither. `run` is already in
`EVENT_ENVELOPE_VERBATIM_FIELDS`, so the run id survives AD-21's redaction verbatim on every envelope;
`takeoverBranchFor(run)` is pure; and `paths.handoffDocument` is a pure function of the run id and
`ORCH_HOME`. Both facts are therefore already reconstructable — what is missing is only that the renderer
cannot reach the two functions. Relocating them costs nothing and adds no payload. Adding the fields
instead would have put a bare 26-character ULID inside a branch string in a payload, which AD-21's entropy
sweep redacts, and the only escape would have been widening the redaction allow-list — the one invariant
with no remedy, already widened once in 1-3 and flagged there as unreviewed.

**Every field that genuinely is new passes redaction before it reaches the log, and must be proven to
survive with a real value.** The acceptance criteria, the option labels and consequences, and the territory
paths are all prose or path-shaped and are the ones at risk. This project has recorded the same false pass
three times: a test that uses `'a'.repeat(n)` or a ULID of repeated zeros proves nothing, because both are
near-zero entropy. Proof uses a genuine ULID at roughly 4.1 bits per character.

**Adding an event type is not a breaking change, and that is the mechanism to prefer.** AD-5 requires
readers to ignore unknown event types and `EventEnvelopeSchema` is a `z.looseObject`, so a new type is
invisible to an older reader and a new payload key survives an older parse. Where a fact belongs to a
moment, it gets an event; where it belongs to a moment that already has one, it gets a key on that
payload. No existing payload key changes meaning and none is removed.

**Cost accounting is read from the CLI, not estimated.** `grep -rniE "total_cost_usd|input_tokens|
output_tokens|modelUsage" src/` returns nothing today: the fields are not discarded, they are never read.
They arrive on the claude CLI's terminal result message. They are numbers, so redaction does not threaten
them, and they are what story 2-9's ceilings will read.

**Not in this story.** No ceiling enforcement, degradation or hibernation (2-9 owns all three; this story
only records the numbers they will read). No git note (2-7, per the amended gate). No question compression
(2-8). No new surface — the six cards exist and this story fills them in. No change to what redaction does,
and in particular no new entry in the allow-list.

## I/O & Edge-Case Matrix

| # | Input | Expected |
|---|---|---|
| 1 | A feature whose acceptance criteria are known | A `spec.recorded` event carries the request and the ordered criteria; the spec echo card renders them from the log alone |
| 2 | Criteria that are prose, and criteria quoting a bare ULID or commit SHA | Prose round-trips byte for byte; an unbroken high-entropy token is redacted and presents as `(redacted in the log)`, never as content. **Amended — see the Spec Change Log** |
| 3 | A criterion edited through `edit_criterion` | The log carries the edit; the card renders the current text and the fact that it was edited |
| 4 | `spec.recorded` seen twice for one feature | The later one wins; the fold does not concatenate or duplicate criteria |
| 5 | A question asked with three options | `question.asked` carries each option's id, label and consequence, the self-contained brief, and `asked_at` |
| 6 | The same question, reconstructed from the log alone | The card shows every consequence and counts down from `asked_at` plus the window — matrix row 2 of story 1-10, now without the state file |
| 7 | A handed-off run, log only | The card names the takeover branch and the document path, both derived from the envelope's `run`, with no new payload field |
| 8 | A feature that declared a territory | A `feature.territory_declared` event carries the declared paths; a replay rebuilds the territory |
| 9 | Two features with overlapping territories, rebuilt from the log | The overlap is detectable from the log alone, so serialization is reconstructable |
| 10 | A step that ran to completion | Its cost in USD and its input, output and cache token counts are recorded |
| 11 | A run of several steps | The run's totals are the sum of its steps; the morning brief shows what the feature cost and the completion notice shows usage |
| 12 | A CLI result carrying no usage block | The step records no usage rather than a zero; the surfaces read `(not recorded)`, never `$0.00` |
| 13 | A log written by an older build, without any of the new types or keys | It still folds: the new facts read as unrecorded and nothing throws (AD-5) |
| 14 | **A completed run's event log, and nothing else on disk** | All six cards reconstruct, including the spec echo — closing the one gap story 1-10 pinned |

## Code Map

| File | Change | Why |
|---|---|---|
| `src/contracts/event.ts` | modify | Three new types — `spec.recorded`, `spec.criterion_edited`, `feature.territory_declared` — and the payload schemas for the new keys. No existing key changes. |
| `src/contracts/usage.ts` | new | The cost and token shape, as a contract rather than an engine detail, because 2-9's ceilings and 3-3's measurement both read it. |
| `src/runtime/branches.ts` | new | `takeoverBranchFor`, relocated so the renderer can derive a takeover branch without importing the engine. |
| `src/engine/handoff.ts` | modify | Re-export `takeoverBranchFor`; no caller changes. |
| `src/engine/stream.ts` | modify | Read `total_cost_usd` and the token counts off the CLI's terminal result instead of dropping them. |
| `src/engine/spawner.ts` | modify | Carry the parsed usage out of the spawn so the reconciler can record it. |
| `src/engine/reconciler.ts` | modify | Emit `spec.recorded`, `spec.criterion_edited`, `feature.territory_declared`, and the per-step usage. |
| `src/engine/questions.ts` | modify | `question.asked` gains the options with labels and consequences, the brief, and `asked_at`. |
| `src/engine/territory.ts` | modify | Rebuild a territory from the log rather than only from live state. |
| `src/tui/projection.ts` | modify | Fold the new types and keys into `ShellView`: criteria, question options, usage totals. |
| `src/tui/cards/spec-echo.ts` | modify | Render criteria from the fold instead of from an injected input. |
| `src/tui/cards/question.ts` | modify | Render consequences and count down from `asked_at`. |
| `src/tui/cards/handoff.ts` | modify | Derive the branch and the document path from the run id. |
| `src/tui/cards/{brief,kill,completion}.ts` | modify | Show real cost and usage where they read `(not recorded)`. |
| `tests/contracts.usage.test.ts` | new | Matrix 10, 12. |
| `tests/runtime.redaction-survival.test.ts` | new | Matrix 2 — every new field, against a genuine ULID. |
| `tests/engine.spec-record.test.ts` | new | Matrix 1, 3, 4. |
| `tests/engine.territory-replay.test.ts` | new | Matrix 8, 9. |
| `tests/engine.usage.test.ts` | new | Matrix 10, 11, 12. |
| `tests/tui.reconstruction.test.ts` | modify | Matrix 6, 7, 14 — the gate's evidence, now covering all six cards. |
| `tests/contracts.forward-compat.test.ts` | new | Matrix 13 — an old log still folds. |

## Tasks & Acceptance

1. **Record the acceptance criteria.** Add `spec.recorded` and `spec.criterion_edited`; emit them from the
   reconciler; fold them in `projection.ts`; render from the fold in `spec-echo.ts`.
   - **Given** a log carrying `spec.recorded`, **when** the spec echo card is built from that log alone,
     **then** it renders every criterion in order and offers the one-keystroke confirm.
   - **Given** two `spec.recorded` events for one feature, **when** the log is folded, **then** the later
     set replaces the earlier and no criterion appears twice.
   - **Given** prose criteria, **when** they are appended, **then** they round-trip byte for byte, verified
     against a genuine high-entropy value rather than a low-entropy stand-in.
   - **Given** a criterion quoting a bare ULID or commit SHA, **when** it is appended, **then** the token is
     redacted and the surface presents it as `(redacted in the log)` rather than as content, and AD-21's
     allow-list is not widened to prevent it.

2. **Enrich `question.asked`** with each option's label and consequence, the brief, and `asked_at`.
   - **Given** a question reconstructed from the log alone, **when** its card is built, **then** every
     option carries its consequence and the window counts down from `asked_at`.
   - **Given** an older log whose `question.asked` has none of the new keys, **when** it is folded, **then**
     nothing throws and the missing facts read as unrecorded.

3. **Derive the handoff's branch and document** rather than adding payload fields. Relocate
   `takeoverBranchFor` to `src/runtime/branches.ts`; re-export from the engine.
   - **Given** a handed-off run's log and nothing else, **when** the handoff card is built, **then** it
     names the takeover branch and the document path, both derived from the envelope's `run`.
   - **Given** the relocation, **when** `grep -rn "from '../engine" src/tui/` runs, **then** it returns no
     match, and no engine test file changed.
   - **Given** AD-21's allow-list, **when** this story is complete, **then** it has the same entries it had
     at `db11e4b`.

4. **Record the declared territory** as `feature.territory_declared`, and rebuild it by replay.
   - **Given** a feature that declared a territory, **when** its log is replayed, **then** the rebuilt
     territory equals the declared one.
   - **Given** two features with overlapping territories, **when** both logs are replayed, **then** the
     overlap is detectable from the logs alone.

5. **Record cost and tokens.** Read `total_cost_usd` and the input, output and cache token counts off the
   CLI's terminal result in `stream.ts`; carry them out of `spawner.ts`; record per step; total per run.
   - **Given** a completed step whose result carries usage, **when** it terminates, **then** the log records
     its cost and its token counts.
   - **Given** a run of several steps, **when** the morning brief and the completion notice are built,
     **then** each shows the run's total cost and usage rather than `(not recorded)`.
   - **Given** a result carrying no usage block, **when** the step terminates, **then** no usage is recorded
     and the surfaces read `(not recorded)` rather than a zero.

6. **Prove the gate.** Extend `tests/tui.reconstruction.test.ts` so all six cards reconstruct from
   `events.jsonl` alone.
   - **Given** a completed run's event log and no other file in the run directory, **when** each of the six
     cards is built, **then** all six render with no fact reported as missing that the log now carries.

7. **Assess the stage-1 `done_checkpoint`** against the amended gate, reporting the evidence for each half
   and anything still unmet.

## Spec Change Log

### Implementation, 2026-09-20 — one acceptance criterion was wrong, and one requirement was being violated

1. **Matrix row 2 and task 1's third acceptance criterion were unsatisfiable as written, and are amended.**
   I wrote "criteria containing a genuine ULID and a commit SHA … both reach the log intact". That
   contradicts AD-21 by design. Measured directly against the built redactor:

   | value | unbroken run | bits/char | verdict |
   |---|---|---|---|
   | bare genuine ULID | 26 | 4.62 | redacted |
   | bare 64-hex commit SHA | 64 | 3.67 | redacted |
   | prose criterion, no identifier | 64 | 3.97 | survives |
   | prose with a ULID quoted inside it | 59 | 5.06 | redacted |
   | punctuated id, the project idiom | 31 | 4.57 | survives |

   The sweep works on unbroken runs, not on whole strings — which is why prose at 3.97 bits/char survives
   while a SHA at 3.67 does not. The only way to make the original AC true was to widen AD-21's allow-list,
   which the story forbade and the implementer correctly refused. The AC now states the real behaviour: prose
   round-trips byte for byte, and a bare high-entropy token reads as `(redacted in the log)` rather than as
   content. `git diff db11e4b -- src/runtime/redaction.ts` is empty and the verbatim-field lists in
   `src/contracts/event.ts` are unchanged.

2. **A requirement violation found and fixed after the implementation reported done.** The implementation
   rendered `0.0396 usd as the CLI reported it` on the morning brief and the completion notice, reasoning
   that omitting a currency glyph satisfied R10. It does not. R10 is unconditional — *"Cost is subscription
   usage, never currency"* — and a line reading `0.0396 usd` is a currency amount. The CLI's
   `total_cost_usd` is still recorded in the log, because AD-24's ceilings and stage 3's measurement read the
   log and recording is not showing; it is now rendered nowhere. `formatReportedCost` and the `cost` field on
   `StatusFields` and `CompletionCard` are gone.

3. **The guard that should have caught it was extended.** `tests/tui.status.test.ts` has asserted since
   story 1-9 that no currency amount reaches a frame, and it kept passing throughout — because it checks
   `shellFrameText`, and a card is not the shell frame. The guard went around rather than through. It is now
   restated over all six cards in `tests/tui.cards.test.ts`, including an assertion against any bare
   four-decimal figure, and proved by mutation.

4. **Three deviations from the Code Map, each forced.** `src/engine/executor.ts` gained `usage` on
   `StepTermination`, because the spawner parses it and the reconciler writes `step.terminated`, so it must
   cross the port; `terminated()` defaults it to `null` so no existing double changed.
   `src/tui/status.ts` holds the token formatter, beside `formatBudgetShare`, which already owns "no
   currency" as its documented rule. `src/engine/rebuild.ts` had a comment arguing that putting a territory
   in a payload "would mean reading `[redacted]` back out of the durable truth" — true before this story and
   false after, so it was corrected rather than left contradicting the code.

5. **Usage is a key on `step.terminated`, not a fourth event type**, per this story's own Boundaries: a fact
   belonging to a moment that already has an event gets a key on that payload.

6. **Declarations are emitted at `acceptFeature` and repaired by any later pass.** Not in the story, and
   forced by the existing crash-injection suite, which failed at two boundaries: a kill between
   `run.created` and the declarations left a run whose criteria never reached the log, so the gate would have
   held only for runs that were never interrupted. `recordDeclarations` is guarded by what the log already
   carries (AD-7, AD-32). This is the most valuable thing the existing suite caught.

7. **Three existing tests changed, all reported.** `tests/engine.reconciler.test.ts` asserted
   `acceptFeature` emits exactly `[run.created]` and now asserts three events — strictly stronger, and
   unavoidable given tasks 1 and 4. `tests/engine.spawner.test.ts` gained `usage: null` on one hand-built
   record, which is type completion. `tests/tui.reconstruction.test.ts` had a test asserting the criteria are
   *absent* from the log; it is inverted, because that was story 1-10's pinned gap and closing it is this
   story's purpose. No test was deleted or skipped.

## Review Triage Log

### 2026-09-21 — Review pass (follow-up, on a `done` spec)

- claims filed: 58 across four layers — blind-hunter 14, edge-case-hunter 20, verification-gap 4 gap + 3
  other, intent-alignment 6 divergences plus an ambiguity in the premise. The edge-case layer filed an
  enumerated list so its count is exact; the other three wrote prose, so those are my enumeration.
- grouped into the 17 rows below. 12 patch entries applied, 3 deferred, the rest rejected. No filed claim is
  without a row.
- **Two rows record failures in my own work on this story** — the currency guard I added to catch a shipped
  R10 violation was pointed at a state where the violation cannot occur, and one of my patch-brief claims
  did not reproduce and was correctly reverted rather than patched. A third row corrects my description of
  the poison loop: the failure was real, my account of how it presented was not.

- `[high]` `[patch]` The spawner discarded every usage record it parsed and the suite stayed green. `spawner.ts:1031` is the only place parsed usage crosses onto `StepTermination`, and I verified at HEAD that replacing it with `usage: null` left all 1522 tests passing — so this story's whole cost-and-token half could be a no-op in the one path a real run takes, with 2-9's ceilings left nothing to read. It passed because every test either fed the parser directly or handed a scripted executor a pre-built termination. One assertion against the transcript's own figures now closes it; I re-ran the mutation myself after the fix and it fails.
- `[high]` `[patch]` THE CURRENCY GUARD I ADDED WAS A NO-OP FOR THE VIOLATION IT WAS WRITTEN AGAINST. After this story shipped `0.0396 usd` onto two surfaces I removed the rendering and added a six-card guard — whose fixture built from `stepTerminated`, which writes no usage key, so every card rendered `(not recorded)` and the assertions ran against strings containing no number. Proved by prepending a `$` figure to `formatTokenUsage`: the guard stayed silent. Now built from `stepTerminatedWithUsage`, the helper this story added and no test imported; the mutation now fails four tests.
- `[high]` `[patch]` `recordDeclarations` could freeze a run forever: its emit loop was unguarded and its call site sits in `pass()`'s per-run enumeration, so an AD-21 fail-closed `UnrecordedAction` excluded the run from `entries` on that pass and every pass after. Same poison shape story 1-7 fixed in `applyIntent`, in a path that runs for every run. Now the failure is a per-run refusal and the run stays in the enumeration. **One correction to my claim:** the catch was not silent — it already pushed a refusal. The freeze was real; my description of it was not.
- `[medium]` `[patch]` The back-fill could discard a person's amendments: it checked `carried` for `spec.recorded` and the territory type but not `spec.criterion_edited`, so a run with edits and no declaration got the declaration appended *after* them and the fold's later-wins rule reset the criteria — amendments in the log and gone from the view. Now every carried edit is re-appended after the declaration in `seq` order, bounded so nothing replays twice.
- `[medium]` `[patch]` A terminal run is no longer back-filled at all, and repairs are marked. The back-fill built its declaration from *today's* plan, so a run whose plan had changed gained a record claiming to be what it was accepted against. Terminal runs are now skipped — a finished run never acts again, so the repair buys nothing and costs a false record — and every back-filled line carries `repaired: true` so a replay can tell a repair from a declaration.
- `[medium]` `[patch]` The territory completeness check failed **open** under partial redaction: it filtered with exact equality, so `docs/[redacted]/records` survived and `complete: true` was returned for a territory the log does not carry. This is the same defect story 1-9's round fixed in the renderer's `isRedacted`; the fix had landed in the renderer and not the engine, because nobody was looking at both.
- `[medium]` `[patch]` Two unsafe-integer paths that threw on ordinary input: `criterionEditedPayload` on a long digit run, and the token counts in `stream.ts` — the latter including the summed total, where each term is safe but the sum need not be. Q6 promises free text is never refused, and `parseStreamLine` is supposed to degrade to a malformed record rather than throw.
- `[medium]` `[patch]` THE CHECKOUT SENTENCE, FIXED AT ITS PRECONDITION RATHER THAN ITS INPUT. `present(given.branch) ?? present(derived.branch)` cannot distinguish "nobody spoke" from "somebody said there is none", so every absent value fell through to the derivation — which is exactly why story 1-7 patched the escape-hatch-failure case, 1-10 patched the empty string, and `null` arrived as a third. The rule is now that a *stated* location wins whatever it states, absence included, testing key presence rather than usability. The existing empty-string test had passed only because it supplied no `run`, so the derivation was null anyway.
- `[medium]` `[patch]` `cardForView` could drop `run` and `orchHome` with nothing failing, so the handoff derivation was pinned only through a constructor the shell never calls. Now asserted through the dispatch.
- `[medium]` `[patch]` A redacted criterion rendered as the raw marker, and the card still offered "confirm all N as written" — asking for a durable CAP-18 decision over wording the run cannot show. Pinned through a real `acceptFeature` so the sweep replaces a genuine ULID, and the card now states how many criteria are not in the log as written *before* offering the confirmation.
- `[medium]` `[patch]` `readQuestion`'s `??` let a detail holding `options: []` beat the richer folded list, so the card showed no options at all — against its own stated intent of "the most the two sources together know".
- `[low]` `[patch]` Seven smaller items: `criteriaList` renumbered every later criterion around a non-string entry, so an `edit_criterion` line number then addressed the wrong one; the brief's per-entry height grew 50% with no capacity test, now pinned at 7 of 12 features in 24 rows with the arithmetic stated; the three new event types and their payload keys were spelled in three places despite the "spelled once" claim, now built from single declarations in contracts; `UNRECORDED_USAGE` was exported, documented with three false claims and imported by nothing, now deleted; `STEP_USAGE_FIELDS`'s documented purpose matched no surface; a garbled duplicated clause in `formatTokenUsage`'s doc; and `emit`'s JSDoc had been orphaned onto `recordDeclarations`.
- `[medium]` `[defer]` SPEC DECISION NEEDED: replay cannot reproduce the shared-worktree half of serialisation. Two features configured to share one worktree are serialised live and admitted together on replay. Neither remedy is available — the worktree is declared configuration, not a function of the run id, so it cannot be derived the way the handoff branch is; and carrying it would put an absolute path holding a bare ULID in a payload, which AD-21 replaces. The divergence is now documented and demonstrated by a test rather than left to be discovered. Latent today, because four of the five territory readers have no callers and the live path reads folded state.
- `[medium]` `[defer]` SPEC DECISION NEEDED: whether a terminal run should ever be back-filled. This round decided no and documented why at length. If the stage-1 gate is read as "every run's log must be complete, including finished ones", that reverses — but the only way to satisfy it is to append today's plan to a finished run's record, which is the worse failure. Worth an explicit ruling, since the gate is load-bearing.
- `[false]` `[reject]` MY CLAIM THAT AN EMPTY `spec.criterion_edited` TEXT REACHES THE LOG DOES NOT REPRODUCE. `edit_criterion` is in `ARGUMENT_REQUIRED_COMMANDS` and `CommandIntentSchema` refuses a whitespace-only argument on both entry points — the method path and the durable-file path. The round wrote the guard, could not construct a scenario for it, and reverted it; the emit condition is byte-identical to HEAD. Residual, left deliberately: `criterionEditedPayload('   ')` in isolation does return an empty text, so its "never empty" comment is true because of an upstream contract rather than that expression.
- `[low]` `[reject]` Six hardening suggestions on inputs no caller can supply, and cosmetic notes corrected elsewhere in this round. (6 findings)
- `[maybe-false]` `[defer]` Three claims that only a launched TUI could settle. Story 2-1 owns the entry point. (3 findings)

## Design Notes

**Two of the five gaps closed by deriving, and that was the right call for a reason worth keeping.** 1-10's
deferred entry proposed adding `branch` and `document` to `handoff.recorded`. A takeover branch is
`orch/takeover/<ulid>` — 40 characters in one unbroken run at 5.07 bits/char, which the sweep eats. The only
escape would have been the allow-list. Instead: `run` is already verbatim on every envelope,
`takeoverBranchFor` is pure, and the document path is a pure function of the run id and `ORCH_HOME`. One
relocation, no payload, no allow-list entry. **When a fact is derivable from something already in the log,
deriving it is strictly safer than carrying it, because a carried identifier has to survive redaction and a
derived one never meets it.**

**The handoff card takes `run` as an input rather than reading it off the view.**
`tests/tui.projection.test.ts` asserts that `JSON.stringify(view)` never contains the run id, because R6
says the feature name is the only identifier a person needs. Putting `run` on `ShellView` to make the card
convenient would have broken that. The card takes it explicitly and says `(not recorded)` without it.

**A recorded zero and an unrecorded absence must not read alike.** A CLI result reporting
`total_cost_usd: 0` with a zeroed usage block is a *measurement*; a result with no usage block at all is an
*absence*. The first renders as `0 out` tokens, the second as `(not recorded)`. R8 is the requirement and the
`$0.00` that would collapse them is the failure mode the suite asserts against directly.

**Both redaction knobs must move before prose is touched.** The implementer's third mutation attempt is
worth recording: lowering the length threshold alone changed nothing, because the candidate pattern is
`{8,}`; lowering the bits threshold alone changed nothing, because the length gate still rejected every
candidate. That is *why* prose is safe, and it is what anyone tempted to tune that policy should know first.

## Verification

Node v24.21.0.

| Check | Result |
|---|---|
| `npm run typecheck` / `lint` / `build` | exit 0 |
| `npm test` | **1206 passed across 48 files**, zero skips, zero failures (baseline 1127 / 42) |
| `git diff db11e4b -- src/runtime/redaction.ts` | **empty** — the allow-list was not widened |
| `src/contracts/event.ts` verbatim-field lists | unchanged; the file is 78 insertions, 0 deletions |
| `grep -rn "from '../engine" src/tui/` | no match |
| `grep -rn "node:fs" src/tui/` | no match (1-9's guard) |
| Currency across all six cards | no `$ € £ ¥ usd eur gbp dollar price`, and no bare four-decimal figure |

**I measured the redaction behaviour myself rather than accepting the reported table**, against the built
redactor, and reproduced every row. That measurement is what showed my own acceptance criterion to be wrong.

**Mutations — four from the implementer, two of mine.**

| Mutation | Caught by |
|---|---|
| `step.terminated` emits a zero usage record instead of omitting the key | 4 tests, incl. "folds to no total, never to zero" |
| The `spec.recorded` fold concatenates instead of replacing | 2 tests in `engine.spec-record` |
| A naive survival test using `'a'.repeat(26)` | **Passes — which is the point.** The recorded false pass, reproduced deliberately and then deleted |
| Swap the genuine ULID for `'a'.repeat(26)` in the real suite | 3 tests fail, the entropy measurement first |
| **Mine:** restore `cost: 0.0396 usd` on the completion notice | 2 tests, both new: "renders no currency amount on the completion card" and "renders no bare decimal figure that could only be money" |
| **Mine:** the pre-existing `shellFrameText` currency guard, against the same regression | **Passes — which is why the violation shipped.** A card is not the shell frame; that is the gap now closed |

## Auto Run Result

**Status: done, reviewed.** The four-layer review ran on 2026-09-21. 58 claims filed, 17 triage rows, 12
patched, 3 deferred. Suite 1522 -> 1542 tests across 51 files, zero skips.

**This story's cost-and-token half could have been a no-op in production.** `spawner.ts:1031` is the only
place parsed usage crosses onto a termination, and replacing it with `usage: null` left all 1522 tests
passing — verified at HEAD before the round, and it now fails a test. Every test that observed a usage
number either fed the parser directly or handed a scripted executor a pre-built termination; the line
joining them was tested by nothing, so story 2-9's ceilings would have had nothing to read.

**The guard I added to catch a shipped violation was pointed where the violation cannot occur.** After this
story rendered `0.0396 usd` onto the brief and completion notice, I removed the rendering and added a
six-card currency guard — whose fixture built from a helper that writes no usage key, so every card
rendered `(not recorded)` and the assertions ran against strings with no number in them. Prepending a `$`
figure to the formatter left the guard silent. It now builds from the usage-carrying helper this story
added and no test had imported, and the same mutation fails four tests.

**A sentence fixed three times is now fixed once.** The handoff card's "check out this branch" line was
patched in story 1-7 for the escape-hatch failure and in 1-10 for the empty string, and `null` arrived as a
third variant — because `present(given) ?? present(derived)` cannot distinguish "nobody spoke" from
"somebody said there is none". The rule is now that a stated location wins whatever it states, absence
included. The pre-existing empty-string test had passed only because it supplied no run id, so the
derivation was null regardless.

**Also closed:** the back-fill could freeze a run forever on an AD-21 fail-closed append, and could discard
a person's criterion amendments by appending the declaration after them; the territory completeness check
failed open under partial redaction, the same defect 1-9's round fixed in the renderer and not the engine;
and two unsafe-integer paths threw where the contract promises free text is never refused.

**One of my own claims did not reproduce and was reverted rather than patched** — an empty
`spec.criterion_edited` text cannot reach the log, because the argument-required refinement gates both
entry points. The round wrote the guard, failed to construct a scenario, and reverted it.

**Residual risk, and why `followup_review_recommended` is true.** Three high entries were patched. The
specific unverified risk: the back-fill now re-appends carried criterion edits after a repaired
declaration, which is new write behaviour in the path that runs for every run on every pass. It is bounded
— the next pass owes nothing and nothing replays twice, and that is asserted — but it is the first time
this loop rewrites history rather than appending to it.
