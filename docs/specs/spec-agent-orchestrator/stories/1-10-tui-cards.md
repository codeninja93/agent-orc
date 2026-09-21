---title: TUI cards — question, spec echo, brief, kill, completion, handoff
type: feature
created: '2026-09-20'
status: done
review_loop_iteration: 1
followup_review_recommended: true
baseline_revision: dc6b57c
context:
- '{project-root}/docs/planning-artifacts/architecture/architecture-agent-orcastrator-2026-09-19/ARCHITECTURE-SPINE.md'
- '{project-root}/docs/specs/spec-agent-orchestrator/interface-contract.md'
- '{project-root}/docs/specs/spec-agent-orchestrator/stories/1-7-command-transport.md'
- '{project-root}/docs/specs/spec-agent-orchestrator/stories/1-8-question-lifecycle.md'
- '{project-root}/docs/specs/spec-agent-orchestrator/stories/1-9-tui-shell.md'
warnings:
- oversized
deferred:
- summary: 'RESOLVED 2026-09-21: the four-layer review ran. See the Review Triage Log.'
  evidence: 46 claims filed, 16 triage rows, 12 patched including two high. Suite 1468 -> 1522 tests across
    51 files, zero skips. Four mutations caught.
  severity: high
- summary: 'GATE GAP: the acceptance criteria are absent from the event log, so the spec echo is the one
    required surface that cannot be reconstructed from the log alone.'
  evidence: '`run.created` carries `{ mode, step_count }` only; the criteria reach disk in the step input
    file and `state.json`, both excluded by the gate. The card states them as `(not recorded)` and refuses
    to offer a confirmation of an empty set, and `tests/tui.reconstruction.test.ts` asserts the criteria
    strings are genuinely absent from the log — the gap is pinned, not hidden. Closing it needs a later
    story to record them in an event (a `spec.confirmed` line, or a field on `run.created`). UPDATED 2026-09-21:
    story 1-11 closed the absence. This review then found the related half — the card hinted at "give
    its number and your wording" while the reconciler required a literal `criterion N:`, so the commonest
    amendment recorded `line: null` and the echo kept showing the old words. The parser now reads a bare
    leading number, and hint and parser are tested through each other.'
  location: src/tui/cards/spec-echo.ts
  severity: high
- summary: 'STAGE-1 GATE: the gate reads "from git and the event log", and no in-repo durable record exists
    yet. `build-sequencing.md` contradicts itself on whose job that is.'
  evidence: 'Line 13 puts "Git-as-bus with notes" in stage 1''s scope; AD-22 makes the committer the note''s
    only

    writer; line 16 puts "committing" in stage 2, where the breakdown accordingly placed story 2-7.

    `grep -rn "refs/notes" src/` returns nothing. No stage-1 story may write the note without

    violating AD-22, so this is a sequencing decision for Deep, not a defect: either the gate''s git

    half is assessed at stage 2''s gate, or a note writer is pulled forward. AD-22 puts the note on the

    *merge* commit and stage 1 has nothing that merges, which favours the amendment.'
  severity: high
- summary: '`question.asked` carries option ids only, with no labels, consequences, brief or `asked_at`,
    so from the log alone the question card cannot show consequences or count down.'
  evidence: 'With the question state file in reach — the live case, and the one a person actually sees
    — the

    card shows all three. Only the reconstructed-from-log case is reduced. A countdown needs one more

    projected field (`askedAt`), and `projection.ts` was not in this story''s Code Map.'
  location: src/tui/cards/question.ts
  severity: medium
- summary: '`handoff.recorded` carries `{ code, reason }` only — no takeover branch and no document path.'
  evidence: 'The card is passed the branch rather than inferring it, because AD-22 gives branch naming
    to the

    committer and `takeoverBranchFor` owns the name; a renderer inferring a branch pattern is exactly

    what AD-22 forbids. Recommend adding `branch` and `document` to that payload when 2-7 lands.'
  location: src/engine/handoff.ts
  severity: medium
- summary: '`src/tui/app.tsx` now holds two pieces of ephemeral state, contradicting 1-9''s "the shell
    holds no state".'
  evidence: 'The keyboard''s draft text and a one-line acknowledgement of the last keystroke. Neither
    is run

    state, neither is written anywhere, both die with the process, and every other field is still

    re-folded from the log each frame. A draft cannot live in the log — it is what has not been

    submitted yet.'
  location: src/tui/app.tsx
  severity: low
- summary: The kill card's estimate cannot come from the log until story 2-9 lands.
  evidence: Nothing at stage 1 emits `budget.degraded` or `budget.exhausted`, and `run.created` carries
    no `wall_clock_ms_estimate`. R11 therefore cannot be satisfied from the log alone yet. The usage half
    is now real; the estimate half is pinned as absent rather than invented, so the assertion is the reminder.
    `DECLARED_WALL_CLOCK_MS` already exists and would be a one-line payload change, but that payload belongs
    to another story.
  location: src/tui/cards/kill.ts
  severity: medium
- summary: Where the morning brief lives is still a UX decision.
  evidence: '`mountBrief` makes CAP-22''s surface reachable as a separate invocation, with no keyboard,
    because a keystroke needs one run to write its intent against (AD-19) and choosing that run is the
    decision this round deliberately did not take. Whether the brief should also be reachable from inside
    the run shell — a toggle, a pane — is open, and `mountBrief` does not foreclose it.'
  severity: medium
- summary: '`no-non-null-assertion` is not enforced by lint; a grep is the only guard and it misses a
    bare `!`.'
  evidence: '`eslint.config.ts` uses `recommendedTypeChecked` + `stylisticTypeChecked`, and the rule lives
    in tseslint''s `strict` preset. `no-explicit-any` IS on, so `any` is enforced. The story''s grep catches
    `!.` but not a trailing `foo!`. One line of config if you want it enforced rather than grepped; not
    changed here because it is a config edit nobody asked for.'
  location: eslint.config.ts
  severity: low
---

# Story 1-10 — TUI cards: question, spec echo, brief, kill, completion, handoff

## Intent

Story 1-9 built the frame and left one seam in it: a persistent question slot that states the question's
state and draws whatever card is passed as `children`. This story supplies the cards — the six surfaces
`interface-contract.md` requires beyond the ambient status line 1-9 already delivered — and closes the
keyboard loop 1-9 deferred, so a keystroke reaches `invokeControlByKey` and free text reaches a question.

It is the last story before the stage-1 gate, and it is what makes the gate's remaining half demonstrable:
**a run is fully reconstructable from git and the event log alone.** Every card in this story is a fold of
the event log and nothing else. A test that renders all six from one run's log, with no `state.json` and no
side file in reach, is not a nice property — it is the gate's evidence.

## Boundaries & Constraints

**The cards are view-models first, components second.** Each surface is a pure function from `ShellView`
(or, for the brief, a fleet view) to a plain data structure, and the Ink component only lays that structure
out. 1-9 proved the ratio: thirty-one pure tests and one frame test, and the pure ones are the ones that
caught both mutations. A card whose logic lives in JSX can only be tested by rendering it.

**An absent fact reads as absent, never as a pass.** The completion notice is specified to state what
merged, the file count, the test status and the usage. At stage 1 nothing records a merge, a file count or
a test result — the committer is 2-7 and the deterministic gates are later still. The notice is built
complete and renders `(not recorded)` for each fact nothing has yet recorded, using 1-9's existing
`UNRECORDED_PRESENTATION`. R8 requires the notice to state what was *not* verified; a card that omitted an
unrecorded field, or rendered it as a tick, would be the one failure mode R8 exists to prevent. The
structure is finished here and the facts arrive as later stories record them.

**A control the system cannot honour says so, in the words of the table that knows.** The kill card is
specified with `continue / narrow / kill / take over`, and `narrow` is `{ kind: 'awaiting', owner: 'story
2-9…' }` in `src/engine/steering.ts` — the intent file is written and deliberately left unconsumed. The
card therefore renders `narrow` with its owner stated, read from the steering table rather than from a
string in the card, so a control's availability cannot drift from the table that decides it. Hiding the
control would be worse: AD-19 makes the intent durable precisely so it is not lost, and a person who
presses a key deserves to know that the file is written and who will act on it.

**The brief is a fleet fold, and one unreadable run does not cost the others.** `ShellView` is one run;
CAP-22 wants every in-flight feature on one screen. The brief folds each run directory under `runsDir`
through the projection 1-9 already built, and a run whose log the reader refuses becomes a line saying so —
the same choice `loadShellView` already makes for a single run, applied to the list.

**One screen means a measured screen.** CAP-22's success criterion is that all in-flight features fit one
screen without scrolling. The brief takes the terminal height as an argument and returns lines bounded by
it, with an explicit "and N more" line when the fleet exceeds the room. Untested, "fits one screen" is a
wish.

**No renderer imports the engine.** The spine's dependency graph gives `tui -> contracts, runtime`. The
cards need the question window's recommendation and the steering table's dispositions, both of which live
in `src/engine/`. 1-9 settled the precedent for exactly this: the mechanics move to `src/runtime/` and the
engine re-exports its names, so no existing caller changes.

**Not in this story.** No web renderer (3-1). No notification delivery or quiet hours (2-8). No question
compression or Interviewer (2-8). No ceiling enforcement — the kill card displays usage against estimate;
2-9 decides. No trust record (3-3 measures it). No merge (2-7). No scrolling, no panes, no mouse.

## I/O & Edge-Case Matrix

| # | Input | Expected |
|---|---|---|
| 1 | A pending question with three options | Card states prompt, a self-contained mini-brief, each option with its consequence, the recommended option marked, the default action and the window remaining (Q1–Q3) |
| 2 | Free text typed into the question card, then Enter | An `answer` intent file is written and nothing else; the question resolves through 1-8's compare-and-set |
| 3 | The window elapses while text sits half-typed in the card | Card states the default was taken and by what, from `describeDefaultTaken`; the typed text is not silently submitted |
| 4 | A question with more than three options | Card shows at most three plus an escape option; the escape is never dropped |
| 5 | A spec echo with five criteria | Criteria numbered and individually addressable; one keystroke confirms all; editing one writes an `edit_criterion` intent naming that line — the card has no line selection, so the person types the number (the card's hint shows the shape) and the engine parses it out of the free text (Q6) |
| 6 | Three in-flight features, terminal height 24 | Brief lists all three with what each needs and what it cost, within the height |
| 7 | Twelve in-flight features, terminal height 24 | Brief lists what fits and states how many more, still within the height |
| 8 | No in-flight features | Brief says so in a sentence; no empty table, no borrowed frame |
| 9 | One run's log unreadable among three | That feature's line states the log could not be read; the other two are unaffected |
| 10 | A run whose usage exceeds its estimate | Kill card states usage and elapsed against estimate and offers continue / narrow / kill / take over |
| 11 | The kill card's `narrow` control | Rendered with its owner from `steering.ts` — written, awaiting story 2-9 — not hidden and not presented as effective |
| 12 | A `committed` feature whose log records no merge, file count or test result | Completion notice renders those as `(not recorded)`, states plainly that nothing is needed, and does not read as a verified pass |
| 13 | A `handed_off` feature with a `handoff.recorded` event | Handoff card states why in a sentence, names the takeover branch and points at the document; no stack frame, no error code as the headline |
| 14 | Any card present | The mode line is still visible and the question slot is still its own section (1-9's R14 invariant survives every card) |
| 15 | Terminal 40 columns | Every card still readable: no row wider than the width, nothing truncated mid-identifier |
| 16 | **One completed run's event log, and nothing else on disk** | All six cards render from it — the stage-1 gate's reconstructability half, as an executable assertion |

## Code Map

| File | Change | Why |
|---|---|---|
| `src/runtime/question-view.ts` | new | The recommendation, the window remaining and the default's description, moved out of `src/engine/question-window.ts` so `src/tui/` can read them without importing the engine. The engine re-exports every name it moves. |
| `src/engine/question-window.ts` | modify | Re-export the moved names; no caller changes. |
| `src/runtime/steering-view.ts` | new | The per-command disposition (`effect` / `question` / `awaiting` with its owner) as data a renderer may read. Same move, same reason. |
| `src/engine/steering.ts` | modify | Re-export; no caller changes. |
| `src/tui/cards/question.ts` | new | The one-question card's view-model: options bounded to three plus escape, recommendation, window, outcome sentence. |
| `src/tui/cards/spec-echo.ts` | new | Numbered criteria, the one-keystroke confirm, the per-line edit. |
| `src/tui/cards/brief.ts` | new | The morning brief's view-model, bounded by terminal height. |
| `src/tui/cards/kill.ts` | new | Usage and elapsed against estimate; the four controls with availability from the steering view. |
| `src/tui/cards/completion.ts` | new | What merged, file count, test status, usage, what was not verified, and that nothing is needed. |
| `src/tui/cards/handoff.ts` | new | The colleague's note: why, the branch, where the document is. |
| `src/tui/cards/index.ts` | new | The barrel, and `cardForView` — which card a view calls for, in one place. |
| `src/tui/fleet.ts` | new | Enumerate `runsDir`, fold each run, survive an unreadable one. |
| `src/tui/input.ts` | new | A pure keystroke reducer: draft text, submit, cancel, control key. No TTY needed to test it. |
| `src/tui/cards.tsx` | new | The Ink components: one per card, each laying out its view-model and nothing more. |
| `src/tui/app.tsx` | modify | Mount the card in the slot 1-9 reserved; bind `useInput` to the reducer. |
| `src/tui/index.ts` | modify | Export the cards, the fleet fold and the input reducer. |
| `tests/tui.cards.test.ts` | new | Matrix 1, 3, 4, 5, 8, 10, 11, 12, 13 — pure view-models. |
| `tests/tui.fleet.test.ts` | new | Matrix 6, 7, 9 — including the height bound, measured. |
| `tests/tui.input.test.ts` | new | Matrix 2 — the reducer, then a real intent file written through `invokeControl`. |
| `tests/tui.frame.test.ts` | modify | Matrix 14, 15 — cards inside the frame, at 40 columns. |
| `tests/tui.reconstruction.test.ts` | new | Matrix 16 — the gate's evidence. |

## Tasks & Acceptance

1. **Move the two view helpers.** Create `src/runtime/question-view.ts` and `src/runtime/steering-view.ts`;
   have `src/engine/question-window.ts` and `src/engine/steering.ts` re-export every moved name.
   - **Given** `src/tui/` imports the recommendation and the steering dispositions,
     **when** `grep -rn "from '../engine" src/tui/` runs,
     **then** it returns no match.
   - **Given** the names moved, **when** the existing engine tests run, **then** no test file changed.

2. **Build the six view-models** in `src/tui/cards/`, each a pure function of a view.
   - **Given** a pending question with four options, **when** its card is built, **then** it carries at
     most three options plus the escape option, with the recommended one marked and each carrying its
     consequence.
   - **Given** a `committed` feature whose log records no test result, **when** the completion notice is
     built, **then** the test status is `(not recorded)` and the notice states what was not verified.
   - **Given** the kill card, **when** it is built, **then** `narrow`'s availability and owner come from
     the steering view rather than from a literal in the card.

3. **Build the fleet fold** in `src/tui/fleet.ts`, bounded by terminal height.
   - **Given** twelve in-flight features and a height of 24, **when** the brief is built, **then** the line
     count does not exceed the height and the brief states how many features are not shown.
   - **Given** three runs of which one has an unreadable log, **when** the brief is built, **then** that
     feature's line states the log could not be read and the other two lines are unaffected.
   - **Given** no in-flight features, **when** the brief is built, **then** it is one sentence saying so.

4. **Close the keyboard loop** with `src/tui/input.ts` and `useInput` in `app.tsx`.
   - **Given** free text and Enter, **when** the reducer processes them, **then** it emits one submit
     carrying exactly the typed text, with no format imposed on it.
   - **Given** a submitted answer, **when** it goes through `invokeControl`, **then** exactly one intent
     file exists and the question resolves through 1-8's compare-and-set.
   - **Given** the window elapses with text half-typed, **when** the card re-renders, **then** it states
     the default was taken and the typed text is not submitted.

5. **Mount the cards in 1-9's slot** and keep its invariants.
   - **Given** any card is drawn, **when** the frame renders, **then** the mode line is present and the
     question slot is still its own section.
   - **Given** a width of 40, **when** each card renders, **then** no row exceeds the width.

6. **Prove reconstructability** in `tests/tui.reconstruction.test.ts`.
   - **Given** one completed run's event log and no other file, **when** each of the six cards is built
     from it, **then** all six render and none reports a missing input.

7. **Gate the stage-1 `done_checkpoint`.** Report the containment half (already met and independently
   verified in 1-5) and the reconstructability half (task 6) with the evidence for each, and state
   anything the gate names that stage 1 does not yet satisfy.

## Spec Change Log

### Implementation, 2026-09-20 — three relocations, seven recorded deviations

1. **A third relocation the Code Map did not anticipate: `src/runtime/runs.ts`.** `fleet.ts` must enumerate
   `runsDir`, and `listRunIds` lived in `src/engine/checkpoint.ts`, which `src/tui/` may not import.
   Duplicating it in the TUI was not an option either: 1-9's guard test asserts that no file under
   `src/tui/` contains the string `node:fs`. Same shape as task 1 — moved to the runtime, re-exported from
   `checkpoint.ts`, `reconciler.ts` untouched.
2. **`tests/tui.frame.test.ts` is listed as "modify" but did not exist.** 1-9's Spec Change Log item 5
   records that its frame tests live in `tests/tui.mode.test.ts`. The file was created rather than growing
   `tui.mode.test.ts`.
3. **`tests/helpers/tui-log.ts` gained a `handoffRecorded` builder** (additive, 12 insertions, no
   deletions), so the handoff card folds the engine's real payload shape rather than a hand-rolled
   envelope.
4. **The cards take optional inputs beyond `ShellView`**, each defaulting to `(not recorded)`: the
   question's state-file detail, the spec echo's criteria, the completion facts, the handoff location, and
   the brief's line-wrapper. Forced by what the log does not carry — see the deferred entries. The wrapper
   is injected rather than imported from `app.tsx` to avoid an `app <-> brief` cycle, and it means the
   height bound is measured over the same wrapped lines the frame draws.
5. **`cardForView` returns the five single-run cards and never the brief.** The brief is a fold of every
   run, so it cannot be chosen by looking at one view.
6. **The moved helpers take narrow structural parameters** (`RecommendableQuestion`, `WindowedQuestion`)
   rather than `Question`, so a card can pass what it read without a cast. `Question` satisfies both, so
   no engine caller changed.
7. **One defect corrected in the relocated table**: `COMMAND_HANDLING.fork` named "story 1-9" as its
   awaiting owner. 1-9 is done and implemented no forking; forking is story 4-3. Nothing user-visible was
   wrong — the kill card renders only continue/narrow/kill/take over — but a card built over `fork` would
   have printed a finished story as its owner.

## Review Triage Log

### 2026-09-21 — Review pass (follow-up, on a `done` spec)

- claims filed: 46 across four layers — blind-hunter 12, edge-case-hunter 17, verification-gap 4 gap + 6
  other, intent-alignment 7 divergences. The edge-case layer filed an enumerated list so its count is exact;
  the other three wrote prose, so those are my enumeration of the distinct claims each made.
- grouped into the 16 rows below. 12 patch entries applied, 1 deferred, the rest rejected. No filed claim is
  without a row.
- **One row records that my own framing of the headline finding was wrong**, and that the patch round
  corrected it by reading the baseline rather than taking my summary. That is the second time a round has
  disproved a claim of mine, and both times it was the right outcome.

- `[high]` `[patch]` The declared `handoff.recorded` type was emitted by one of three hand-off paths, and the renderer read only that type — so a person pressing `t` got a card saying "the log records no reason". **My framing of this was wrong and the patch round corrected it:** I said the take-over path wrote no line at all. It did — `command.applied` has carried `handoff_code` and `handoff_reason` since story 1-3 (`steering.ts:499`), and `rebuildFromLog` folds them (`rebuild.ts:434`), so the engine's *state* was always reconstructable. What was broken was a hole in AD-5's vocabulary and the card's rendering. Both fixed: the take-over path now emits the event, and the fold reads the reason from either source so an older log still states why.
- `[high]` `[patch]` The gate's evidence did not observe its claim. All six cards were built from one `committed` run, where three are degenerate — the brief renders "nothing is in flight", the kill card "not yet recorded" for both facts R11 exists for, and the handoff card its fallback — and the per-card assertions were title-non-empty, more-than-one-line, and a width check that **could not fail**, because the test wrapped with `wrapLine`, which hard-slices anything longer than the width. It now drives three runs into one `ORCH_HOME`, each stripped to `events.jsonl`: a `committed` one, a `handed_off` one driven through the real keyboard path against a real git worktree, and a `running` one whose brief folds a real in-flight entry. The width assertion is replaced by `overWideWords`, which splits the card's **own** lines.
- `[medium]` `[patch]` The question card told a person who successfully answered that they lost. `describeDefaultTaken` was called for any settled question, and after story 1-8's round its non-timeout branch names a resolver and principal and says they got there first — a sentence written for a loser. Improving that wording in 1-8 made the misuse more convincing. Now gated on the outcome actually being a timeout default.
- `[medium]` `[patch]` The completion notice could print "finished and verified" with nothing verified: `nothingIsNeeded` was gated solely on `notVerified` being empty, so a run with every fact recorded and zero verification steps printed "verified: nothing" directly above "the work is finished and verified" — the exact R8 failure the card exists to prevent.
- `[medium]` `[patch]` The recommended option could be dropped while still being named: the bound sliced the first three concrete options while the recommendation was read from the unsliced detail, so a question recommending its fourth option rendered no `(recommended)` row while still printing "recommended: D" — pointing a person at an option they cannot select, precisely in the case the bound exists for. An escape appearing inside `options` was also listed twice.
- `[medium]` `[patch]` `cardForView` had no branch for `killed`, so a dead run fell through to the over-estimate check and could be handed the **kill card**, offering continue/narrow/kill/take-over. `killed` and `hibernated` now return no card, the fallback is guarded on the terminal-state list so a state added to the contract cannot reach it again, and the doc-comment's dispatch order is rewritten to the implemented one.
- `[medium]` `[patch]` The morning brief — CAP-22's surface and the first entry under Required surfaces — could not appear on screen at all: `cardForView` deliberately never returns it and `mountShell` accepted no fleet input. Resolved as the honest reading rather than by forcing it through the chooser: a separate `mountBrief` invocation, with no keyboard, because a keystroke needs one run to write its intent against (AD-19) and choosing that run is a UX decision this round was told not to take.
- `[medium]` `[patch]` The brief's height bound broke at the width its sibling test declares: the drop loop exits at zero entries without re-checking, so the 12-run fixture at heights 1, 2 and 3 all drew three rows at 40 columns, while the existing "too short for even one feature" test used height 2 at **80** columns where the title fits one row. Parameterised over {80, 40} x {1, 2, 3}; with the floor removed 3 of 6 fail while the old case still passes, confirming it never reached the failing shape.
- `[medium]` `[patch]` Three defects in the keyboard path: a draft composed for `reject` or `narrow` rendered as an unsent answer to the pending question; `currentStep` was fixed at mount time so an approve or reject was recorded against a stale or null step; and the keystroke notice — the story's "never silence" guarantee, including the caught `invokeControl` throw — could be made to never render with all 1127 tests passing. Also `press` after `unmount` is now a no-op, the notice clears on ignored keys, and a TDZ on `instance` during the first commit is fixed.
- `[medium]` `[patch]` My own `fork`-owner correction was pinned by nothing and reverted green. Now pinned per command, plus the durable form: **no awaiting owner may name a story whose file says `status: done`**, read from the story frontmatter — so when 2-9, 2-10 or 4-3 lands, that test fails and the entry must be revisited.
- `[medium]` `[patch]` `editCriterionArgument` was referenced only by tests — and underneath it a sharper defect: the card's hint said "give its number and your wording" while the reconciler's parser required a literal leading `criterion N:`, so the commonest amendment (`3: <wording>`) was recorded with `line: null` and the spec echo went on showing the original words. The parser now reads a bare leading number too, and the card's hint and the engine's parser are fed through each other in the tests so CAP-2's two halves cannot drift.
- `[low]` `[patch]` Nine smaller real items: `availabilityPhrase` hard-coded "nothing narrows yet" for every awaiting command; `whyFromNotices` selected the hand-off reason by scanning prose for "handed off" — now structural, and it also fixes a latent bug nobody named, that four notices after a hand-off used to push the reason out of the bounded list; a blank branch rendered `git checkout ` with nothing after it; `windowPhrase` rendered "(not recorded) left" on an unparseable instant; a pasted multi-line answer never submitted, because Ink hands a paste over in one call and deliberately does not split on newlines; `commandAvailabilities` iterated object keys while documenting enum order; `foldFleet` re-read every run's whole log unbounded, now capped at the spine's own two-hundred-run threshold with the count stated in the title; and the plural disagreement in the bounded-options line.
- `[false]` `[reject]` MY PREMISE FOR THE HEADLINE FINDING WAS PARTLY WRONG, and the round corrected it by reading the code at the baseline rather than accepting my summary. I claimed a take-over produced "no line in the event log"; it produced `command.applied` carrying the code and reason, which the state fold already read. The defect was real but narrower than I stated, and I had repeated the overstatement to the user twice — once claiming the gate was met when three cards were degenerate, once claiming it was falsified when only a rendering was.
- `[false]` `[reject]` One premise did not reproduce as stated: a kill card "whose estimate came from the log". Nothing at stage 1 emits `budget.degraded`/`budget.exhausted` and `run.created` carries no `wall_clock_ms_estimate` — ceilings are story 2-9's, as this story's own Boundaries say. The usage half is now real; the estimate half is **pinned as absent** rather than invented, so the day something records one, that assertion is the reminder.
- `[low]` `[reject]` Seven hardening suggestions on inputs no caller can supply, and cosmetic notes corrected elsewhere in this round. (7 findings)
- `[maybe-false]` `[defer]` Three claims that only a launched TUI could settle. Nothing launches the shell; the spine gives `bin/init.ts` to AD-12 and story 2-1 owns it. (3 findings)

## Design Notes

**The parked control is named by the table, not by the card.** `narrow` is `{ kind: 'awaiting', owner:
'story 2-9…' }`, and the kill card reads that from `src/runtime/steering-view.ts`. Hiding the control would
be the worse failure: AD-19 makes the intent durable precisely so a keystroke is not lost, and a person who
presses the key deserves to know the file is written and who will consume it. Verified by mutation — see
Verification.

**An unrecorded fact is stated, not omitted.** The completion notice's `(not recorded)` entries are also
its "what was not verified" list, so the two cannot drift apart: a fact nothing recorded is, by
construction, a fact nothing verified. This is the single line R8 exists for, and the one the notice would
be dangerous without.

**Ink 7 landmine, worth the note.** `useInput`'s guard is `options.isActive === false`, and
`useStdin().isRawModeSupported` is `stdin.isTTY`, which off a TTY is `undefined` rather than `false`. The
natural `isActive: active && isRawModeSupported` therefore reads as *active* and throws "Raw mode is not
supported on the current process.stdin" on mount — in exactly the non-TTY case the tests run in.
`app.tsx` coerces with `=== true`.

**The shell holds a draft, and that is not a regression.** 1-9's "no state" rule is about run state, which
is the log's. Text a person has typed and not submitted is the one thing that cannot live in the log,
because the log records what happened and this has not happened yet.

## Verification

Node v24.21.0 (the PATH default, v22.14.0, is below the >=22.22 floor).

| Check | Result |
|---|---|
| `npm run typecheck` | exit 0 |
| `npm run lint` | exit 0 |
| `npm run build` | exit 0 |
| `npm test` | **1127 passed across 42 files**, zero skips, zero failures (baseline 1015 / 37) |
| `grep -rn "from '../engine" src/tui/` | no match — the renderer imports no engine module |
| `grep -rnE "\bany\b\|!\." src/tui/cards/ src/tui/fleet.ts src/tui/input.ts` | no match |
| `git diff --stat -- tests/` | one file, `tests/helpers/tui-log.ts`, 12 insertions 0 deletions — no existing test edited or skipped |
| `node -e "import('./dist/tui/index.js')"` | loads, 99 exports |

**Reconstructability is proved by deletion, not by omission.** `tests/tui.reconstruction.test.ts` drives a
real feature to `committed` through a real reconciler, with a question asked and answered through the
keystroke reducer and one durable intent file, then removes every entry in the run directory except
`events.jsonl`, asserts `readdirSync(runDir)` equals exactly `['events.jsonl']`, and builds the cards from
the fold. Deleting rather than ignoring is what makes it evidence.

**Four mutations, two of them mine and run independently of the implementer's.**

| Mutation | Caught by |
|---|---|
| Blank the completion notice's "what was not verified" | 4 tests, incl. "lists every unrecorded fact as something that was not verified (R8)" |
| Remove the brief's height bound | 3 tests in `tui.fleet`, incl. the 40-column wrap case |
| **Mine:** flip `narrow` from `awaiting` to `effect` in the steering table | 2 tests, incl. "names the owner the steering table names, rather than a literal of its own" — so landmine E is genuinely enforced |
| **Mine:** raise `MAX_QUESTION_CARD_OPTIONS` from 3 to 99 | 2 tests, incl. "states how many were offered and not shown, rather than dropping them in silence" |

Both of my mutations were restored to byte-identical files and the full suite re-run green. The
implementer also reported a weaker first attempt worth recording: disabling only the *test-result* entry of
the notice was caught by exactly one test, because the reconstruction suite's `notVerified.length > 0` is
too loose alone — the named-string assertions in `tui.cards` are what carry R8.

## Auto Run Result

**Status: done, reviewed.** The four-layer review ran on 2026-09-21. 46 claims filed, 16 triage rows, 12
patched. Suite 1468 -> 1522 tests across 51 files, zero skips.

**The gate's evidence now observes what it claims.** It built all six cards from one `committed` run, where
three are degenerate — the brief reading "nothing is in flight", the kill card "not yet recorded" for both
facts R11 exists for, the handoff card its fallback — and its per-card assertions were title-non-empty,
more-than-one-line, and a width check that could not fail, because the test wrapped with the same function
whose guarantee it then measured. It now drives three runs into one `ORCH_HOME`, each stripped to
`events.jsonl`: `committed`, `handed_off` through the real keyboard path against a real git worktree, and
`running` so the brief folds a real in-flight entry.

**A correction to this story's own headline, which I got wrong twice.** I reported that a person-driven
take-over wrote no line to the log, and that this falsified the stage-1 gate. The patch round checked the
baseline and disproved it: `command.applied` has carried `handoff_code` and `handoff_reason` since story
1-3, and `rebuildFromLog` folds them, so the engine's state was always reconstructable. What was actually
broken is narrower and still worth fixing — the declared `handoff.recorded` type was emitted by one of three
hand-off paths, a hole in AD-5's vocabulary, and the renderer read only that type, so the card showed its
fallback in production. Both halves are fixed, and the fold now reads the reason from either source so an
older log still states why.

**Two user-facing lies in the cards.** A person who successfully answered a question was told another
resolver got there first — because the losing-resolver sentence was rendered for every settled question,
and story 1-8's improvement to that sentence made the misuse more convincing. And the completion notice
could print "finished and verified" directly beneath "verified: nothing", which is the exact R8 failure it
exists to prevent.

**The morning brief is reachable.** CAP-22's surface — the first entry under Required surfaces — existed
only as a function a test called. It is now a separate `mountBrief` invocation, deliberately without a
keyboard, because choosing which run a keystroke steers is a UX decision this round was told not to take.

**Residual risk, and why `followup_review_recommended` is true.** Two high entries were patched. The
specific unverified risk: the take-over path now appends `handoff.recorded` before `command.applied`, and
a crash between them redelivers the intent and appends the handoff line twice. Both folds absorb that,
being whole-record assignments rather than accumulations, and the ordering is the recoverable one — the
reverse would retire a run into `handed_off` with the reason lost. But it is a new two-append sequence in
the one path a person reaches when everything else has failed.
