---
title: 'TUI cards — question, spec echo, brief, kill, completion, handoff'
type: 'feature'
created: '2026-09-20'
status: 'done'
review_loop_iteration: 0
followup_review_recommended: true
baseline_revision: 'dc6b57c'
context:
  - '{project-root}/docs/planning-artifacts/architecture/architecture-agent-orcastrator-2026-09-19/ARCHITECTURE-SPINE.md'
  - '{project-root}/docs/specs/spec-agent-orchestrator/interface-contract.md'
  - '{project-root}/docs/specs/spec-agent-orchestrator/stories/1-7-command-transport.md'
  - '{project-root}/docs/specs/spec-agent-orchestrator/stories/1-8-question-lifecycle.md'
  - '{project-root}/docs/specs/spec-agent-orchestrator/stories/1-9-tui-shell.md'
warnings: ['oversized'] # six surfaces, a fleet-level fold, the first keystroke loop, and the stage-1 gate
deferred:
  - summary: >-
      No review layer ran against this story; the gate, the implementer's probes and my own two
      independent mutations are the only scrutiny it received.
    evidence: |-
      typecheck, lint, build and 1127 tests across 42 files all pass with zero skips. Read status: done
      as implemented, gated and mutation-tested, not reviewed.
    severity: high
  - summary: >-
      GATE GAP: the acceptance criteria are absent from the event log, so the spec echo is the one
      required surface that cannot be reconstructed from the log alone.
    evidence: |-
      `run.created` carries `{ mode, step_count }` only; the criteria reach disk in the step input file
      and `state.json`, both excluded by the gate. The card states them as `(not recorded)` and refuses
      to offer a confirmation of an empty set, and `tests/tui.reconstruction.test.ts` asserts the
      criteria strings are genuinely absent from the log — the gap is pinned, not hidden. Closing it
      needs a later story to record them in an event (a `spec.confirmed` line, or a field on
      `run.created`).
    location: 'src/tui/cards/spec-echo.ts'
    severity: high
  - summary: >-
      STAGE-1 GATE: the gate reads "from git and the event log", and no in-repo durable record exists
      yet. `build-sequencing.md` contradicts itself on whose job that is.
    evidence: |-
      Line 13 puts "Git-as-bus with notes" in stage 1's scope; AD-22 makes the committer the note's only
      writer; line 16 puts "committing" in stage 2, where the breakdown accordingly placed story 2-7.
      `grep -rn "refs/notes" src/` returns nothing. No stage-1 story may write the note without
      violating AD-22, so this is a sequencing decision for Deep, not a defect: either the gate's git
      half is assessed at stage 2's gate, or a note writer is pulled forward. AD-22 puts the note on the
      *merge* commit and stage 1 has nothing that merges, which favours the amendment.
    severity: high
  - summary: >-
      `question.asked` carries option ids only, with no labels, consequences, brief or `asked_at`, so
      from the log alone the question card cannot show consequences or count down.
    evidence: |-
      With the question state file in reach — the live case, and the one a person actually sees — the
      card shows all three. Only the reconstructed-from-log case is reduced. A countdown needs one more
      projected field (`askedAt`), and `projection.ts` was not in this story's Code Map.
    location: 'src/tui/cards/question.ts'
    severity: medium
  - summary: >-
      `handoff.recorded` carries `{ code, reason }` only — no takeover branch and no document path.
    evidence: |-
      The card is passed the branch rather than inferring it, because AD-22 gives branch naming to the
      committer and `takeoverBranchFor` owns the name; a renderer inferring a branch pattern is exactly
      what AD-22 forbids. Recommend adding `branch` and `document` to that payload when 2-7 lands.
    location: 'src/engine/handoff.ts'
    severity: medium
  - summary: >-
      `src/tui/app.tsx` now holds two pieces of ephemeral state, contradicting 1-9's "the shell holds no
      state".
    evidence: |-
      The keyboard's draft text and a one-line acknowledgement of the last keystroke. Neither is run
      state, neither is written anywhere, both die with the process, and every other field is still
      re-folded from the log each frame. A draft cannot live in the log — it is what has not been
      submitted yet.
    location: 'src/tui/app.tsx'
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
| 5 | A spec echo with five criteria | Criteria numbered and individually addressable; one keystroke confirms all; editing one writes an `edit_criterion` intent naming that line |
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

**Status: done.** Six surfaces built as pure view-models with thin Ink components, the keyboard loop closed
through `invokeControl` and nothing else, and three helpers relocated to `src/runtime/` so the renderer
imports no engine module. 1127 tests across 42 files, zero skips. Four mutations tried, all caught.

**Stage-1 `done_checkpoint` — half met, half deferred by the spec's own sequencing.**

- *Containment half — met, independently verified.* `tests/container.assertion.test.ts` 8/8, and
  `~/.orch/gates/container-assertion.json` reads `state: "verified"` with all six required checks against
  Docker 29.8.0, image `orch-executor:991044ecce0e0ac8`. The reader in `src/container/lifecycle.ts`
  re-validates the check *list* rather than trusting the marker's word, so the claim cannot drift — a
  forged marker naming three of six checks was the defect that fix came from.
- *Event-log half — met, with one named gap.* Five of the six surfaces reconstruct from `events.jsonl`
  alone. The spec echo does not, because the acceptance criteria are not in the log; the gap is asserted
  rather than hidden.
- *Git half — not met, and not stage 1's to meet.* AD-22 assigns the in-repo durable record to the
  committer, story 2-7. Recorded as a deferred entry with the decision it needs.

`followup_review_recommended: true` — the story is oversized, no review layer ran, and two of its deferred
entries name payload changes another story will have to make.
