---
title: 'Exceptions-only notifications'
type: 'feature'
created: '2026-09-25'
status: 'done'
baseline_revision: 'b1b04cb3ac8f2b2cc7e404847b3027d4463eb6a7'
review_loop_iteration: 0
followup_review_recommended: true
context: []
warnings: []
deferred:
  - summary: >-
      runsNeedingAttention/buildAttentionCard have no production caller anywhere — no web route, no
      static-client wiring, no TUI mount point — so a person cannot yet see this surface in practice.
    evidence: |-
      Confirmed by direct grep (zero references outside the two definition files and the test) and by
      reading src/web/server.ts (serves raw fleetView unmodified, no card builder used server-side at
      all) and src/web/static/index.html (its own hand-rolled renderFleet, never imports
      src/tui/cards/). Confirmed pre-existing and codebase-wide, not introduced by this story:
      buildBriefCard and every other card in src/tui/cards/index.ts has the identical zero-caller
      status today — nothing has wired any of src/tui/cards/ into a live consumer yet
      (src/tui/index.ts's own docstring: "the surface a future entry point mounts").
    location: >-
      src/tui/fleet.ts (runsNeedingAttention), src/tui/cards/attention.ts (buildAttentionCard)
    severity: medium
---

<intent-contract>

## Intent

**Problem:** R1 ("silence means success: notify only on exception, decision point, or completion") and
threat-model.md item 16 are both unimplemented at the fleet level. `src/tui/fleet.ts`'s `inFlightRuns`
and `src/tui/projection.ts`'s `nextGateFor` show every non-terminal run — ordinary unattended progress
included — with no way to ask "which of my runs need me right now" and get true silence back when the
answer is none. `cardForView` already answers R1 correctly for the *one* run whose screen is open
(`hibernated`/`killed` deliberately draw no card), but nothing answers it across the whole fleet.

**Approach:** Add a pure fold, `runsNeedingAttention`, beside the existing `inFlightRuns` in
`src/tui/fleet.ts`, classifying every folded run into `'decision_point'` (a pending question, `blocked`,
`interrupted`), `'exception'` (an unreadable log, `hibernated`, `handed_off`), `'completion'`
(`committed`), or nothing. Add a second, separate invocation — mirroring how the morning brief is a
separate invocation from `cardForView` — that renders this fold as a card-shaped structure a person (or
a future automated poller) reads, saying nothing when the list is empty.

## Boundaries & Constraints

**Always:**
- Reuse `ShellView` fields the fold from `events.jsonl` already computes (`problem`, `question.state`,
  `featureState`) — no new event type, no new contract, no engine change. This lives entirely in
  `src/tui/`, same as `fleet.ts` and `cardForView` today.
- `runsNeedingAttention` operates over every folded run (`fleet.runs`), not only `inFlightRuns`'s subset
  — `hibernated`, `handed_off` and `committed` are terminal and `inFlightRuns` excludes them, but they
  are exactly the states this story exists to surface.
- An unreadable log (`view.problem !== null`) is `'exception'`, checked first: an unknown state is never
  silence, matching `isRunInFlight`'s own reasoning for the identical case.
- A pending question (`view.question.state === 'pending'`) is `'decision_point'` regardless of
  `featureState`, matching `cardForView`'s own precedence (question checked before the state switch).
- `killed` gets no reason (silence): the person issued that stop themselves, so nothing needs telling
  them. `hibernated` **does** get `'exception'` even though `cardForView` also draws no per-run card for
  it — that per-run silence is about which of the four live-run gestures still apply (none), not about
  whether the person already knows; a ceiling reached autonomously is news, a kill they typed is not.
- Add one line to `interface-contract.md`'s Required Surfaces list naming this as a ninth surface, since
  it is genuinely new required-surface scope and that document is what enumerates them; log the
  amendment via `_bmad/scripts/memlog.py append --workspace docs/specs/spec-agent-orchestrator`.

**Never:**
- No new external delivery channel (email, Slack, OS push). SPEC.md's non-goals already exclude a
  required web dashboard, and threat-model.md's own audit note only asks for the classification and a
  surface — not a transport. A terminal-readable structure that is empty exactly when nothing needs a
  person satisfies R1 on its own.
- `degraded` and `awaiting_merge` are **not** attention-worthy here. `degraded` self-resolves with no
  decision pending (`nextGateFor` already says "the narrowed scope to finish"); `awaiting_merge` waits on
  a GitHub pull request review, which GitHub's own notifications already cover — building a second one
  would be a redundant channel, which the boundary above already forbids.
- Do not add a seventh entry to `CARD_KINDS` / the `Card` union / `cardForView`. Those are documented as
  "the six surfaces `interface-contract.md` requires" for a *single run's* screen; this is fleet-wide,
  like the brief, and the brief's own precedent (`cards/index.ts`) is a card-shaped structure built and
  invoked separately, not folded into that dispatch.
- Do not change `inFlightRuns`, `foldFleet`, or any existing card's behavior.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Ordinary progress | A fleet of runs all `running`, `verifying`, `confirmed`, `drafting`, `degraded` or `awaiting_merge`, no pending question, no unreadable log | `runsNeedingAttention` returns `[]`; the card's title says nothing needs the person | No error expected |
| Mixed fleet | One run `blocked`, one `committed`, one `running` | Two entries returned, `'decision_point'` and `'completion'` respectively; the `running` run is absent | No error expected |
| Unreadable log | `view.problem` non-null, `featureState` whatever the partial read left | `'exception'`, independent of `featureState` | No error expected |
| Pending question mid-run | `featureState: 'running'`, `question.state: 'pending'` | `'decision_point'` — the question is not missed because the state itself is not one of the switch's cases | No error expected |
| `killed` vs `hibernated` | One run each | `killed` → no entry; `hibernated` → `'exception'` | No error expected |
| Empty fleet | `fleet.runs` is `[]` | `runsNeedingAttention` returns `[]`; the card reads the same as "runs exist, none need attention" — R1 does not require distinguishing "nothing to report" from "nothing is wrong" | No error expected |

</intent-contract>

## Code Map

- `src/tui/fleet.ts` -- add `AttentionReason`, `AttentionEntry`, `attentionReasonFor` (private), and
  `runsNeedingAttention(fleet: FleetView): readonly AttentionEntry[]`, beside the existing
  `isRunInFlight`/`inFlightRuns`. Reuses `FleetRun`/`FleetView` already defined here.
- `src/tui/projection.ts` -- read-only reference for `ShellView`, `QuestionSlotView`, `FeatureState`
  fields (`problem`, `question.state`, `featureState`); no changes.
- `src/contracts/state.ts` -- read-only reference for `FEATURE_STATES`/`TERMINAL_FEATURE_STATES`; no
  changes.
- `src/tui/cards/attention.ts` (new) -- `buildAttentionCard(fleet: FleetView): AttentionCard`, modeled on
  `src/tui/cards/brief.ts`'s `fleetEntry`/`buildBriefCard` shape (feature name via `UNNAMED_FEATURE`,
  never a run id per R6) but built from `runsNeedingAttention` instead of `inFlightRuns`, with no height
  bounding (Boundaries: this is not one of `interface-contract.md`'s bounded-to-one-screen surfaces).
- `src/tui/cards/index.ts` -- export `./attention.js`'s public members alongside the other card modules'
  `export *` lines. Do **not** add `'attention'` to `CARD_KINDS`, the `Card` union, or `cardForView`
  (Boundaries).
- `src/tui/index.ts` -- add `export * from './cards/attention.js'` is unnecessary if `cards/index.ts`
  already re-exports it and `index.ts` already does `export * from './cards/index.js'`; verify and touch
  only if the new symbols do not surface.
- `docs/specs/spec-agent-orchestrator/interface-contract.md` -- add a ninth bullet under "Required
  surfaces" naming this surface (Boundaries).

## Tasks & Acceptance

**Execution:**
- `src/tui/fleet.ts` -- add `AttentionReason`/`AttentionEntry`/`runsNeedingAttention` -- the fleet-wide
  fold this story exists to add, reusing `ShellView` fields already computed.
- `src/tui/cards/attention.ts` -- add `AttentionCard`/`buildAttentionCard` -- the renderable, testable
  structure a person or future poller reads; empty list reads as literal silence, not an empty table.
- `src/tui/cards/index.ts` -- re-export the new module.
- `docs/specs/spec-agent-orchestrator/interface-contract.md` -- add the ninth Required Surfaces bullet.
- `tests/tui.attention.test.ts` (new) -- unit-test every I/O Matrix row above directly against
  `runsNeedingAttention` and `buildAttentionCard`.

**Acceptance Criteria:**
- Given a fleet with no run in an attention-worthy state, when `runsNeedingAttention` folds it, then it
  returns `[]` and `buildAttentionCard` produces a title stating nothing needs the person, with no
  entries.
- Given a fleet with a `blocked`, a `committed`, and a `running` run, when folded, then exactly the first
  two appear, tagged `'decision_point'` and `'completion'` respectively.
- Given a run whose log is unreadable (`view.problem !== null`), when folded, then it is tagged
  `'exception'` regardless of what `featureState` a partial read left.
- Given a run in `'running'` with `question.state: 'pending'`, when folded, then it is tagged
  `'decision_point'` — a pending question is never missed because the surrounding state is not `blocked`.
- Given one `killed` run and one `hibernated` run, when folded, then the `killed` run produces no entry
  and the `hibernated` run is tagged `'exception'`.
- Given the existing `inFlightRuns`, `foldFleet`, and every card in `cards/index.ts`, when this story's
  tests and the full existing suite run, then none of their existing behavior or assertions change.

## Verification

**Commands:**
- `npm run typecheck` -- expected: no errors
- `npm run lint` -- expected: no errors
- `npm run build` -- expected: succeeds
- `npm test` -- expected: full suite passes, including the new `tests/tui.attention.test.ts`

## Spec Change Log

## Review Triage Log

### 2026-09-25 — Review pass
- verdicts: 13 findings — high 0, medium 6, low 6, false 1, maybe-false 0
- findings:
  - `[medium]` `defer` blind-hunter: `runsNeedingAttention`/`buildAttentionCard` have zero production callers (no web route, no static-client wiring, no TUI mount) — the "channel" is a shape, not something a person can see. Evidence: confirmed by direct grep and reading `src/web/server.ts` (serves raw `fleetView` unmodified, no card builder involved anywhere) and `src/web/static/index.html` (its own hand-rolled `renderFleet`, never imports `src/tui/cards/`). Verified this is pre-existing and codebase-wide: `buildBriefCard`/`buildKillCard`/every other card in `cards/index.ts` has the identical zero-caller status today — no story has wired any of `src/tui/cards/` into a live consumer yet (`src/tui/index.ts`'s own docstring: "the surface a future entry point mounts"). Not caused by this story; belongs to whichever future entry-point/wiring story mounts the whole `cards/` layer.
  - `[medium]` `defer` intent-alignment: same root cause as the row above (merged) — the story's own stories.yaml gloss ("adds a channel that surfaces only exceptions") reads as delivered-to-a-person, but nothing calls the new exports in production.
  - `[low]` `patch` blind-hunter: `docs/brainstorming/.../threat-model.md` item 16's 2026-09-25 audit note now reads stale — it says "no notification-suppression mechanism... exists anywhere," which is no longer true (classification exists, tested) though the delivered-to-a-person half (see row above) is still genuinely open. Action: amended the note to say what is now built and what remains open.
  - `[low]` `patch` blind-hunter: `src/tui/cards/index.ts` and `src/tui/cards/attention.ts` justify excluding `AttentionCard` from `CARD_KINDS`/`Card` by saying it is "fleet-wide, like the brief" — but `BriefCard` **is** a member of `CARD_KINDS` and the `Card` union (only excluded from `cardForView`'s switch). Verified directly against `src/tui/cards/index.ts:56-86`. The stated precedent was wrong, though the underlying design choice turns out to be right for a different, real reason found during patch verification: `src/tui/cards.tsx`'s `CardView` switch is documented as total over `Card['kind']` ("a seventh surface is a compile error here rather than a card that silently draws nothing"), so actually joining `CARD_KINDS`/`Card` would force an unwanted `AttentionCardView` Ink component into existence purely to satisfy exhaustiveness, for a card nothing mounts yet. Action: corrected the comments to state the true reason; did not join `CARD_KINDS`/`Card`.
  - `[low]` `patch` blind-hunter: because `AttentionCard` isn't a `CardBody`, `cardLines`/`cardText` (`cards/index.ts`) can't be called on it, so `tests/tui.attention.test.ts` hand-rolls `[title, ...lines].join('\n')` instead of reusing them — named consequence: any future generic consumer of `Card`-shaped structures needs a special case for this one. Action: loosened `cardLines`/`cardText`'s parameter type from `CardBody` to `Pick<CardBody, 'title' | 'lines'>` (backward compatible — every existing caller still satisfies it) so `AttentionCard` can use them; updated the test to use them instead of hand-rolling.
  - `[medium]` `patch` blind-hunter: `runsNeedingAttention` only folds `fleet.runs`, ignoring `fleet.notRead` (set when `foldFleet`'s `MAX_FLEET_RUNS` bound excludes older run directories) — on a machine with more than 200 run directories, an exception in an older, unread run makes `buildAttentionCard` say "nothing needs you" while something genuinely does, which is the literal claim R1 exists to make honestly. Verified `foldFleet`/`MAX_FLEET_RUNS` in `src/tui/fleet.ts`. Action: `buildAttentionCard`'s title now states the same caveat `buildBriefCard` already does when `notRead > 0` ("...among the {MAX_FLEET_RUNS} most recent runs"), for both the empty and non-empty cases.
  - `[low]` `patch` blind-hunter: `buildAttentionCard`'s lines interpolate the raw `AttentionReason` slug (`decision_point`, `exception`, `completion`) into human-facing text, which `interface-contract.md`'s Register rule (no mechanical phrasing) and every other card in this codebase avoid. Action: dropped the raw slug from the line format — `detail` is already a full sentence; `reason` remains available as a structured field on `AttentionCardEntry` for a machine reader.
  - `[low]` `patch` blind-hunter: no test exercises `featureState: null` (a real, reachable value per `src/tui/projection.ts:441`) even though `attentionReasonFor`'s own doc comment calls it out as one of the silent cases. Action: added a test case locking in the documented default-branch behavior.
  - `[low]` `patch` blind-hunter: `src/tui/index.ts`'s module doc comment still describes `cards/` as holding "the one-question card, the spec echo, the morning brief, the kill card, the completion notice and the handoff note" — six, unchanged since this story added a seventh. Action: added the attention card to the sentence.
  - `[medium]` `patch` edge-case-hunter and blind-hunter (same root cause, found independently — merged): `attentionReasonFor` (`fleet.ts`) checks `question.state === 'pending'` before the `featureState` switch, but `detailFor` (`cards/attention.ts`) checks `handed_off`/`hibernated`/`committed` before ever consulting the question, so a run reaching one of those three states while a question is still pending (confirmed reachable: `command.applied`/`BudgetExhausted` never clear `question` in `src/tui/projection.ts`) gets `reason: 'decision_point'` paired with a hand-off/hibernation/completion sentence — a genuinely contradictory card line. Action: reordered `detailFor` to check the pending question first, mirroring `attentionReasonFor`'s own precedence exactly; added a test for the overlapping case.
  - `[medium]` `patch` verification-gap (pre-verified, filed disposition weighed as filed): `detailFor`'s `handed_off`/`hibernated`/`committed` branches, including the `handoffSentence`/null-handoff-fallback distinction, are never exercised by any `buildAttentionCard` test — a swapped or broken sentence in any of the three "exception"/"completion" branches (this story's own headline cases) would still show full green. Action: added `detail`-asserting test cases for `handed_off` (with and without `view.handoff`), `hibernated`, `committed`, and the `nextGate`-derived decision-point default.
  - `[false]` `reject` intent-alignment: reported that the diff's taxonomy departs from the verbatim intent's own four named examples ("blocked on a gate, handed off, degraded, or failed") — excluding `degraded`, having no `failed` `FeatureState` at all, and adding an unnamed `completion` category. Refutation: the verbatim intent handed to this layer is a one-line gloss I (the spec author) wrote when appending the story to `stories.yaml`, not the authoritative source — `interface-contract.md`'s R1 ("notify only on exception, decision point, or completion") is, and it names `completion` explicitly and does not enumerate `degraded`/`failed`. `degraded`'s exclusion and the `failed`-step-disposition-routes-to-`blocked` mapping are both reasoned, documented choices in this spec's own Boundaries section, not gaps — one legitimate, correct reading was selected and stated, not inferred silently.

## Auto Run Result

Status: done
Blocking condition: none

**Summary:** Added a fleet-wide, pure classification (`runsNeedingAttention`, `src/tui/fleet.ts`) of every
run into `'decision_point'`, `'exception'`, `'completion'`, or silence — R1's own three categories,
literally — and a card-shaped rendering of it (`buildAttentionCard`, `src/tui/cards/attention.ts`), deliberately
kept out of `CARD_KINDS`/the `Card` union (would force an unused Ink component into existence to satisfy
`cards.tsx`'s exhaustive switch) but reusing `cardLines`/`cardText` via a loosened parameter type. Added
`interface-contract.md`'s ninth Required Surfaces bullet. Amended `threat-model.md` item 16's audit note to
say what is now built and what remains open.

**Files changed:**
- `src/tui/fleet.ts` — `AttentionReason`, `AttentionEntry`, `attentionReasonFor`, `runsNeedingAttention`.
- `src/tui/cards/attention.ts` (new) — `AttentionCardEntry`, `AttentionCard`, `buildAttentionCard`.
- `src/tui/cards/index.ts` — re-exports the new module; `cardLines`/`cardText` widened to `Pick<CardBody, 'title' | 'lines'>`.
- `src/tui/index.ts` — module doc comment now names the seventh (attention) card.
- `docs/specs/spec-agent-orchestrator/interface-contract.md` — ninth Required Surfaces bullet.
- `docs/brainstorming/brainstorm-agent-orchestration-system-2026-09-19/threat-model.md` — item 16's audit note amended with what story 4-4 built and what remains open (the unwired gap).
- `tests/tui.attention.test.ts` (new, 19 tests) — every I/O Matrix row, every patched fix, and every triage-log finding's regression case.

**Review findings breakdown** (13 findings across four layers):
- **Patched (9):** detailFor/attentionReasonFor precedence mismatch (medium, found independently by two
  layers, merged); `detailFor` branches untested (medium, verification-gap, pre-verified); `fleet.notRead`
  silently ignored (medium); threat-model.md item 16 stale (low); false "like brief" precedent claim in two
  files' comments (low); `AttentionCard` couldn't reuse `cardLines`/`cardText` (low, same root cause as the
  previous, grouped); raw `AttentionReason` slug leaking into human-facing text (low); `featureState: null`
  untested (low); `src/tui/index.ts` module doc stale (low).
- **Deferred (1, medium):** the classification has no production caller anywhere yet — recorded in
  frontmatter `deferred`, with evidence that this is pre-existing and codebase-wide (every other card in
  `src/tui/cards/` has the identical zero-caller status; nothing has wired any of `src/tui/cards/` into a
  live consumer yet), not something this story introduced or is scoped to fix.
- **Rejected (1, false):** intent-alignment's claim that the taxonomy departs from stories.yaml's one-line
  gloss (naming `degraded`/`failed`, omitting `completion`) — refuted: `interface-contract.md`'s R1 is the
  authoritative source, names `completion` explicitly, and the gloss's other two words are reasoned,
  documented boundary decisions in this spec, not gaps.

**Follow-up review recommendation:** `true`. Two or more `medium` entries were patched this pass (three:
the precedence mismatch, the `detailFor` coverage gap, and `fleet.notRead`), which this workflow's own rule
makes sufficient on a first pass regardless of confidence in the individual fixes. Named unverified risk:
none of the three medium patches were themselves put through a fresh four-layer review — they were verified
by me (typecheck/lint/build/full suite, all green, and I read every changed line against the finding it
answers) but not by an independent reviewing pass the way the original implementation was.

**Verification performed:** `npm run typecheck`, `npm run lint`, `npm run build`, and `npm test` all pass
after the patch (104 files, 3030 tests, up from 3024 — the 6 new patch-verification tests). Every I/O Matrix
row and every triage-log finding has a directly corresponding, passing test in `tests/tui.attention.test.ts`.
Frontmatter `deferred` parses as valid YAML (checked with `uv run --quiet --with pyyaml python3`).

**Residual risks:** the deferred finding (no live caller) means this story's classification is not yet
visible to a person anywhere in the running system — closing threat-model.md item 16 in full still needs a
future wiring/entry-point story. No other residual risk identified.
