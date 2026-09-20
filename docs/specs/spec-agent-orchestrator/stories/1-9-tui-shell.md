---
title: 'TUI shell — event-log projection, permanent mode display, ambient status'
type: 'feature'
created: '2026-09-20'
status: 'done'
review_loop_iteration: 0
followup_review_recommended: false
context:
  - '{project-root}/docs/planning-artifacts/architecture/architecture-agent-orcastrator-2026-09-19/ARCHITECTURE-SPINE.md'
  - '{project-root}/docs/specs/spec-agent-orchestrator/interface-contract.md'
  - '{project-root}/docs/specs/spec-agent-orchestrator/stories/1-7-command-transport.md'
  - '{project-root}/docs/specs/spec-agent-orchestrator/stories/1-8-question-lifecycle.md'
warnings: ['oversized'] # 12 files and 13 I/O scenarios; first UI dependencies plus a spine contradiction to settle
deferred:
  - summary: >-
      No review layer ran against this story; the gate plus the implementer's own probes are the only
      scrutiny it received.
    evidence: |-
      typecheck, lint, 1015 tests across 37 files and build all pass, and the two verification greps
      over `src/tui/` return no match. Read status: done as implemented and gated, not reviewed.
    severity: high
  - summary: >-
      Keystrokes are not captured: the shell renders and `invokeControlByKey` exists, but no Ink
      `useInput` handler binds one to the other.
    evidence: |-
      A control's whole contract — a durable intent file and nothing else — is implemented and tested
      end to end through `invokeControl`/`invokeControlByKey`, including a real reconciler pass that a
      written `disengage` stops. What is missing is the keyboard loop that calls it, which needs a free
      text prompt for `answer`, `reject`, `edit_criterion` and `inject_note` — and a text prompt is
      part of story 1-10's one-question card rather than of this shell.
    location: 'src/tui/app.tsx'
    severity: medium
  - summary: >-
      CROSS-STORY: `src/tui/mode.ts` holds the autonomy mode, and story 3-1's web renderer may not
      import `src/tui/` any more than it may import `src/engine/`.
    evidence: |-
      The Code Map placed the mode's derivation in `src/tui/mode.ts` and this story followed it. The
      spine's dependency graph gives `web -> contracts` only, so when 3-1 needs the same mode a person
      reads in the terminal, the derivation has to move to `src/contracts/` or `src/runtime/` — the
      same shape of move this story made for the intent writer, and cheaper to make before a second
      renderer exists than after.
    location: 'src/tui/mode.ts'
    severity: medium
baseline_revision: '6ba3c7d6cc0b486abce5d94c22a0600a82a12066'
---

<intent-contract>

## Intent

**Problem:** Eight stories have built a system with no surface. Every capability so far is reachable only from a test: there is no way to watch a run, no way to see which autonomy mode the system is in, and no way to answer a question that stories 1-7 and 1-8 made answerable. `interface-contract.md` names mode confusion — believing the system is in one mode while it is in another — as the primary interface hazard of a system with autonomy tiers, and nothing displays a mode at all.

**Approach:** Add `src/tui/`: an Ink renderer that is a pure fold over `events.jsonl`, carrying the permanently displayed autonomy mode, an ambient status segment showing step count, consumed rate-limit budget and elapsed-versus-estimate, and a persistent slot for an active question. Controls are the shared `Command` enum and reach the engine only by writing intent files.

## Boundaries & Constraints

**Always:**
- The renderer is a projection: view state is a fold over the event log, and the same events produce the same render. It holds no authoritative state of its own.
- The current autonomy mode is displayed permanently, in every render state — while a step runs, while a question is pending, after a kill, and on an empty log.
- The ambient status segment always shows the step count, the consumed rate-limit budget and elapsed-versus-estimate, without the user issuing a command. Cost is subscription usage, never currency.
- Progress is the current step name and the next gate, never a percentage.
- An active question occupies a persistent slot that does not scroll away.
- Everything is addressed by feature name. A user never has to know an agent name or a run id.
- Every control is a member of the shared `Command` enum, and a control present in one renderer and absent from the other is a compile error — the enum is consumed through a total map.
- A control reaches the engine only by writing a durable intent file. There is no second path, and nothing in the renderer mutates run state.
- A reader ignores an unknown event type rather than erroring, so a newer engine's log still renders.
- `src/tui/` imports only from `src/contracts/`, `src/runtime/` and `node:` builtins. It never imports `src/engine/`.
- React and Ink are pinned exactly to the Stack table: React 19.3.0 and Ink 7.1.1.

**Never:**
- Never import `src/engine/`. The spine states that no renderer may, and that renderers reach the engine only through intent files.
- Never render a percentage for progress, never dump a diff, and never require a browser to reply.
- No question card, no spec echo card, no morning brief, no kill card, no completion notice and no handoff rendering — story 1-10 owns all six surfaces. This story owns the shell they live in, including the slot the question card occupies.
- No loopback server, no SSE and no web renderer — story 3-1.
- No notification delivery, no quiet hours and no do-not-disturb — silence means success here; the Interviewer's notification policy is 2-8's.
- No ceilings enforcement (2-9). The ambient segment displays consumed budget; it does not act on it.
- Never hold run state the log does not contain, and never write anything to the event log — the recorder is its sole writer.
- Never add a dependency beyond React and Ink without recording it as a deviation, as earlier stories did for `ajv` and `jiti`.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Empty log | No events for a run | A coherent idle render; the mode is still displayed | Never a crash or a blank screen |
| Run in progress | A log with a step started and not terminated | The current step name and the next gate are shown; no percentage appears anywhere | No error expected |
| Pure projection | The same event sequence folded twice | Identical view state both times | A projection that differs is a defect |
| Unknown event type | A log containing a type this build does not declare | Ignored; the rest of the render is unaffected | Adding a type is never breaking |
| Mode always visible | Every render state, including idle, mid-step, question pending, and after a kill | The mode is present in all of them | Absence in any state is a defect |
| Ambient status | Any run with recorded usage | Step count, consumed rate-limit budget and elapsed-versus-estimate visible with no command issued | Never a currency amount |
| Question pending | An `asked` question in the log | It occupies a persistent slot that further output does not scroll away | The slot survives new events |
| Question resolved | A question resolved or defaulted | The slot clears and the outcome is stated, including when the default was taken | A user is never left believing an answer landed when it did not |
| Addressing | Any render | Features are named; no agent name and no run id is required of the user | A run id shown as the primary identifier is a defect |
| Control invoked | A user invokes a control | A durable intent file is written and nothing else changes | The renderer never mutates run state |
| Missing control | A `Command` member absent from the control table | A compile error | Never a silently missing control |
| Corrupt log | A log the reader refuses | The renderer says so plainly and stays up | Never a stack trace and never a crash |
| Narrow or colourless terminal | 40 columns, or no colour support | Still readable, with the mode and status still present | Never illegible |


</intent-contract>

## Code Map

Eight stories shipped the contracts, recorder, reconciler, spawner, container, pool, command transport and question lifecycle. Nothing renders anything. React and Ink are deliberately absent — story 1-1 forbade them with "the renderers arrive in 1-9 and 3-1".

- `package.json` -- modify; add `react` at exactly 19.3.0 and `ink` at exactly 7.1.1, matching the Stack table. `react-dom` belongs to the web surface in story 3-1 and is not added here
- `src/runtime/commands.ts` -- create, by relocation; move the intent file's format, its atomic write and its id minting out of `src/engine/commands.ts`, re-exporting from the engine so nothing breaks. See the Design Note: the spine forbids a renderer importing the engine, and story 1-7 put exactly the three functions a renderer needs there
- `src/tui/projection.ts` -- create; the pure fold from events to view state. This is where nearly all the behaviour lives, and it is testable with no terminal at all
- `src/tui/mode.ts` -- create; the autonomy mode's derivation and its permanent presentation
- `src/tui/status.ts` -- create; the ambient segment: step count, consumed rate-limit budget, elapsed-versus-estimate
- `src/tui/controls.ts` -- create; the total `CommandMap` of controls, each writing a durable intent through `src/runtime/commands.ts`
- `src/tui/app.tsx` -- create; the Ink shell that composes the above and reserves the persistent question slot story 1-10 fills
- `src/tui/index.ts` -- create; the surface a future entry point mounts
- `tests/tui.projection.test.ts` -- create; the fold: idle, mid-step, unknown types, determinism, addressing by feature name, no percentage anywhere
- `tests/tui.mode.test.ts` -- create; the mode is present in every render state, including idle, mid-step, question-pending and post-kill
- `tests/tui.status.test.ts` -- create; the ambient segment's three values, and that no currency amount ever appears
- `tests/tui.controls.test.ts` -- create; a control writes an intent and mutates nothing; the total map makes a missing control a compile error

Read-only evidence, authoritative and not to be edited by this story:

- `ARCHITECTURE-SPINE.md` -- AD-3 (one `Command` enum, both renderers built against it, the TUI alone is sufficient), AD-4 (renderers are projections of the log), AD-5 (ignore unknown types), AD-19 (renderers reach the engine only by writing intent files), and the dependency rule that no renderer may import the engine; the Stack table's React and Ink pins
- `interface-contract.md` -- the reporting rules R1 through R14 and the mode-and-control section: mode displayed permanently, disengagement instant and always available, `just-do-it` first-class, progress as step name and next gate, usage and elapsed always visible, the active question in a persistent slot
- `src/contracts/command.ts` -- `Command`, `CommandMap`, and the fourteen controls
- `src/contracts/event.ts` -- the envelope and the declared vocabulary the fold reads
- `src/runtime/recorder.ts` -- `readEventLog`, the only way to read the log
- `src/engine/commands.ts` -- the intent writer this story relocates

Carried forward from stories 1-1 through 1-8:

- **Story 1-1 pinned React 19.3.0 and Ink 7.1.1 and then forbade installing them.** This story is where they arrive. Ink is ESM-only and the package is already `"type": "module"`, so that part should be uneventful; the pins are exact, not caret ranges, like every other Stack entry.
- **Story 1-7 exported `writeCommandIntent`, `newCommandIntent` and `mintIntentId` from the engine with a note that "a renderer needs only" those.** The spine forbids a renderer importing the engine at all. Resolving that is a task here, not a judgement call to leave open.
- **Story 1-8 established that a losing resolver must be told plainly what happened.** The shell's question slot is where "it timed out while you were typing" becomes visible to a person rather than a field in a log.
- Story 1-2's redaction pass means a log can legitimately contain `[redacted]` in a field. A renderer must present that as redacted rather than as a value or an error.
- Every earlier story that added a dependency outside the Stack table recorded it as a deviation. Anything needed to assert a rendered frame is in that category.

## Tasks & Acceptance

**Execution:**
- `package.json` -- add React 19.3.0 and Ink 7.1.1 at exact versions -- every other Stack entry is pinned exactly, and a caret here would let a renderer drift from the version the contract names
- `src/runtime/commands.ts` -- relocate the intent writer out of the engine, re-exporting from `src/engine/` so no existing caller changes -- the spine forbids a renderer importing the engine, and durable-file mechanics are what `src/runtime/` already owns
- `src/tui/projection.ts` -- fold the event log into view state, ignoring unknown types -- a renderer that is a projection cannot disagree with the log, which is the property AD-4 exists for
- `src/tui/mode.ts` -- derive and permanently present the autonomy mode -- mode confusion is named as the primary interface hazard of a system with autonomy tiers, so its display is a constraint rather than a feature
- `src/tui/status.ts` -- present step count, consumed rate-limit budget and elapsed-versus-estimate with no command issued -- R10 and R11 require both to be visible so that abandoning early is easy
- `src/tui/controls.ts` -- build the total `CommandMap` of controls, each writing a durable intent -- a total map is what makes a control missing from one renderer a compile error rather than a difference a user discovers
- `src/tui/app.tsx`, `src/tui/index.ts` -- compose the shell and reserve the persistent question slot -- story 1-10 fills the slot; this story guarantees it does not scroll away
- `tests/tui.projection.test.ts` -- cover idle, mid-step, unknown types, determinism, feature-name addressing, and the absence of any percentage -- the fold is pure, so this is where coverage is cheapest and most of the behaviour lives
- `tests/tui.mode.test.ts` -- assert the mode is present in every render state -- the hazard is a user believing the wrong mode, so a state where the mode is absent is the defect
- `tests/tui.status.test.ts`, `tests/tui.controls.test.ts` -- cover the three ambient values, the absence of currency, and that a control writes an intent and mutates nothing -- a renderer that mutates state is a second command path, which AD-19 forbids

**Acceptance Criteria:**
- Given a clean checkout on Node `>=22.22`, when `npm run typecheck && npm run lint && npm test && npm run build` is run, then all four succeed and the TUI suites appear in the test output.
- Given `package.json`, when its dependencies are inspected, then `react` is exactly 19.3.0 and `ink` is exactly 7.1.1, and no `react-dom` is present.
- Given one event sequence, when it is folded twice, then the two view states are identical; and given a log containing an event type this build does not declare, when it is folded, then the unknown event is ignored and the rest renders.
- Given each of an empty log, a run mid-step, a run with a pending question, and a run after a kill, when the shell renders, then the autonomy mode is present in all four.
- Given a run with recorded usage, when the shell renders, then the step count, the consumed rate-limit budget and elapsed-versus-estimate are all visible without any command being issued, and no currency amount appears anywhere.
- Given a run in progress, when the shell renders, then progress is the current step name and the next gate, and no percentage appears anywhere in the output.
- Given a pending question and further events arriving, when the shell renders, then the question's slot is still present and has not scrolled away.
- Given any render, when its text is inspected, then features are addressed by name and no run id or agent name is required of the user.
- Given a user invokes a control, when it is handled, then a durable intent file exists and no run state was modified by the renderer.
- Given a `Command` member with no entry in the control table, when the project is typechecked, then it fails to compile.
- Given a log the reader refuses, when the shell renders, then it states the problem plainly and remains running rather than crashing.
- Given `src/tui/`, when its imports are inspected, then it imports only from `src/contracts/`, `src/runtime/` and `node:` builtins, and never from `src/engine/`.

## Spec Change Log

### Implementation, 2026-09-20 — the engine-import contradiction, and eight recorded deviations

**1. The contradiction is settled by relocation, as the Design Note prescribed.** The spine's rule holds
unchanged and the code moved. `src/runtime/commands.ts` now owns the intent file's *mechanics* — the
format (`newCommandIntent`, `intentFileName`, `INTENT_FILE_EXTENSION`), the atomic write
(`writeCommandIntent`, and the non-atomic `writeCommandIntentTruncated` a suite tears a file with), the
id minting (`mintIntentId`) and the shape guard that keeps an id loggable (`INTENT_ID_PATTERN`,
`MAX_INTENT_ID_TOKEN_RUN`, `isLoggableIntentId`, `UnloggableIntentId`). `src/engine/commands.ts`
re-exports every one of those names, so **no existing caller changed**: `reconciler.ts` imports what it
imported, and `tests/engine.commands.test.ts` passes unmodified. What stayed in the engine is what the
engine does *with* the files — `readIntentFiles`, `orderIntents`, the refusal reasons,
`quarantineIntent`, `retireIntent`, `appliedIntentIds`, `TORN_INTENT_GRACE_MS`,
`REFUSAL_SIDECAR_EXTENSION` and the two `command.*` event types. `src/tui/` therefore imports
`src/runtime/` and never `src/engine/`, which
`tests/tui.projection.test.ts` asserts over every file in the directory rather than leaving to
discipline.

Two small consequences of the move, recorded because a reviewer would otherwise have to work out why:

- **`INTENT_TEMP_SUFFIX` became an exported constant.** The writer creates `*.tmp` and the engine's
  reader skips it; with the two in different modules, a private constant in each would have been two
  agreements about one name.
- **`mintRandomIntentId` was added.** `mintIntentId` takes a ULID, and AD-29 makes the ULID minter the
  engine's. Rather than relocate the minter — which would weaken AD-29's single-owner claim for run ids —
  a renderer mints from `node:crypto` and reuses `mintIntentId`'s grouping, so the id is still punctuated
  into runs short enough to survive AD-21's entropy sweep in the payload that carries the exactly-once
  key. Ordering is unaffected: an intent is ordered by its `issued_at` first and by its id only as a
  tiebreak. `tests/tui.controls.test.ts` drives 20 minted ids through `isLoggableIntentId` and asserts
  they are distinct.

**2. `@types/react` 19.3.0 was added as an exact devDependency.** The one dependency beyond React and
Ink, recorded here as earlier stories recorded `ajv` and `jiti`. Ink declares it as an optional peer, and
without it a `.tsx` file cannot typecheck. Deliberately *not* added: `ink-testing-library`. The rendered
frame is asserted by rendering through Ink into a fake `stdout` in `debug` mode, which needs no package.
No `react-dom`: that is story 3-1's.

**3. `tsconfig.json` and `tsconfig.build.json` were modified, beyond the Code Map's files.** `jsx:
"react-jsx"` and `src/**/*.tsx` in both `include` lists. Unavoidable for a `.tsx` file to compile at all,
and the automatic runtime keeps `app.tsx` free of an import that exists only to satisfy the compiler.

**4. `tests/helpers/tui-log.ts` was added.** One file beyond the Code Map: the envelope builder four
suites share, so a fixture log is described once. Its payload keys are the engine's own spelling, and
`tests/tui.projection.test.ts` additionally folds a log a **real reconciler wrote**, because a builder
that drifted from the engine would leave every hand-built test passing over an empty frame.

**5. The frame-composition tests live in `tests/tui.mode.test.ts`.** The story names four test files, so
the tests that need a composed frame — the question slot surviving later events, 40 columns, the absence
of any colour escape, and one real Ink render — sit beside the mode enumeration rather than in a fifth
file. The split the Design Note asks for is intact: the fold's suite is 31 pure tests, and exactly one
test in the repository renders through Ink.

**6. The compile-error criterion is checked by compiling.** "Given a `Command` member with no entry in
the control table, when the project is typechecked, then it fails to compile" cannot be observed by a
runtime assertion, so the test writes a `CommandMap` missing `disengage` into `.probe-control-table/`
with a generated `tsconfig.control-table-probe.json`, spawns the project's own `tsc`, and asserts it
fails naming that member. Both are removed in the test's teardown, and neither is inside the
`tsconfig.json` or `eslint` file sets.

**7. The autonomy mode is declared here, because nothing upstream declared one.** `interface-contract.md`
requires "the current mode" to be permanently displayed and names `just-do-it` as first-class, but no
contract enumerated a mode. `src/tui/mode.ts` declares five — `interactive`, `just-do-it`, `paused`,
`taken-over`, `stopped` — derives them from the commands the log records as *applied*, and forces
`stopped` on a terminal feature state whatever the commands said, because a mode line reading
`just-do-it` over a killed run is precisely the false belief the contract compares to an aviation
accident class. `AUTONOMY_MODE_TRANSITIONS` is a `CommandMap`, so a command with no decided effect on the
mode is a compile error. AD-27's `live`/`shadow` is carried beside it rather than folded into it, and a
shadow run says what shadow *does* rather than only its name. The cross-story consequence for story 3-1
is recorded in `deferred`.

**8. Usage and the estimate are read from the AD-24 budget events, and said to be unrecorded until they
exist.** Nothing in this build emits a usage figure — ceilings are story 2-9 — so the fold reads
`rate_limit_budget_consumed` from `budget.degraded` and `budget.exhausted`, and derives the estimate from
a `wall_clock_ms_remaining` sample plus the elapsed the log had reached, or from an explicit
`wall_clock_ms_estimate` when a later story records one. All three ambient fields are present in every
frame regardless, reading `not yet recorded` rather than disappearing — a field that vanished when its
value was unknown would make "always visible" untrue exactly when a person is deciding whether to wait.

Three smaller decisions, recorded because a reviewer could reasonably expect the other:

- **No `%` character appears anywhere in `src/tui/`, including as a remainder operator.** The story's
  verification greps the directory for it, so `formatDuration` divides and subtracts rather than taking a
  remainder. Keeping the character out is what leaves that grep meaning something.
- **`idleShellView` is defined as `foldEvents([])`.** A hand-written idle view is the kind of thing that
  stops agreeing with the fold the first time a field is added, and the suite caught exactly that
  disagreement before the definition changed.
- **The shell holds no state and reads no clock.** `mountShell` re-folds the log on every refresh, and
  `now` is passed into the frame, so a frame is reproducible and elapsed still moves while the log does
  not. Ink's `patchConsole` is off: a renderer that rewired `console` would change the behaviour of
  whatever mounted it.

**Verification.** `npm run typecheck`, `npm run lint`, `npm test` (1015 tests, 37 files) and `npm run
build` all exit 0 on Node 24.21.0. `grep -rn "from '\.\./engine" src/tui/` and `grep -rnE "%|percent"
src/tui/` both return no match. `npx vitest run tests/engine.crash-injection.test.ts` still converges —
5 tests, ~25s — which is the check that the relocation changed no engine behaviour.

## Review Triage Log

## Design Notes

**The spine and story 1-7 contradict each other, and this story has to settle it.** The dependency rule says "No renderer, step subprocess, tool server or installer may import the engine; renderers reach it only by writing command intent files per AD-19." Story 1-7 put `writeCommandIntent`, `newCommandIntent` and `mintIntentId` in `src/engine/commands.ts` and documented that a renderer needs exactly those three. Both cannot hold. The resolution that keeps the rule intact is to relocate the intent file's *mechanics* — its format, its atomic write, its id minting — into `src/runtime/`, which already owns the recorder, the paths and every other durable-file concern, and re-export from the engine so no existing caller changes. What stays in the engine is what the engine actually does: consuming, ordering, quarantining and applying. If the implementer sees a better resolution, take it and record it; what is not acceptable is a renderer importing the engine, or the constraint being quietly reinterpreted.

**Nearly all of this story is a pure function, and that is where the tests belong.** A fold from events to view state needs no terminal, no Ink and no React to test, and it is where the reporting rules become machine-checkable: no percentage, no currency, feature names rather than run ids, unknown types ignored, determinism. Asserting rendered frames is worth doing for the shell's composition, but a suite that tests mostly frames will be slow, brittle, and will still not tell you whether the projection is right.

**The mode display is a safety property, not a decoration.** `interface-contract.md` compares mode confusion to an aviation accident class: the human believes the system is in one mode while it is in another. That makes "the mode is present" an invariant to assert in every state, not a line to add to a header component. The test that matters enumerates render states and checks all of them, which is why the matrix lists four explicitly.

## Verification

**Toolchain:** the PATH default `node` on this machine is v22.14.0, below the declared floor. Use the nvm-installed Node 24.x LTS by absolute path:

```
export PATH="/Users/deep/.nvm/versions/node/v24.21.0/bin:$PATH"   # node v24.21.0, npm 11.19.0
```

**Commands:**
- `npm run typecheck` -- expected: exit 0
- `npm run lint` -- expected: exit 0
- `npm test` -- expected: exit 0; the TUI suites present and passing
- `npm run build` -- expected: exit 0
- `grep -rn "from '\.\./engine" src/tui/` -- expected: no match; a renderer never imports the engine
- `grep -rnE "%|percent" src/tui/` -- expected: no percentage rendered as progress
- `npx vitest run tests/engine.crash-injection.test.ts` -- expected: still converges, since the relocation must change no engine behaviour
