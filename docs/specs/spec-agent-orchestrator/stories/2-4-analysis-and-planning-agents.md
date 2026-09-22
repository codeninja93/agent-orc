---
title: 'Step agents — analysis and planning'
type: 'feature'
created: '2026-09-22'
status: 'drafted'
review_loop_iteration: 0
followup_review_recommended: false
baseline_revision: '795b4c4'
context:
  - '{project-root}/docs/planning-artifacts/architecture/architecture-agent-orcastrator-2026-09-19/ARCHITECTURE-SPINE.md'
  - '{project-root}/docs/planning-artifacts/architecture/architecture-agent-orcastrator-2026-09-19/ADR-001-tier-2-execution.md'
  - '{project-root}/docs/planning-artifacts/architecture/architecture-agent-orcastrator-2026-09-19/ADR-003-built-in-agent-tool-grants.md'
  - '{project-root}/docs/specs/spec-agent-orchestrator/architecture.md'
  - '{project-root}/docs/specs/spec-agent-orchestrator/stories/2-3-profile-loader-and-roster.md'
deferred: []
---

# Story 2-4 — Step agents: analysis and planning

## Intent

**Problem:** the engine can spawn a step and re-parse its output, but there are no agents. `STEP_PHASES` is
`['implementation', 'verification']`, so the two phases this story is about do not exist; `step.analysis` and
`step.planning` are not registered contracts, so there is nothing for `--json-schema` to carry and nothing to
re-parse an output against. A feature's file territory is declared at run creation from whatever the caller
passed, and nothing derives it from reading the repository — so the reconciler's serialisation is bounded by a
guess. And ADR-001 decided that `--tools` and `--add-dir` bound a step; neither appears anywhere in `src/`.

**Approach:** add the two agents as the pure functions `architecture.md` specifies — one typed file in, one
typed file out, no knowledge of what ran before. Register their output contracts, extend the phase vocabulary,
wire the per-agent tool grant from the roster 2-3 discovers, and have analysis produce the territory the
reconciler already knows how to serialise on.

## Boundaries & Constraints

**A step agent is a pure function, and for these two the grant is what makes that true.**
`architecture.md` requires that re-running an agent on the same input be side-effect-free outside its output.
For analysis and planning that is not a matter of discipline: ADR-003 grants them `Read`, `Grep`, `Glob` and
nothing else, so there is no tool with which to cause a side effect. This is the first story where the grant
is load-bearing rather than declarative, which is precisely why the flag that carries it must exist.

**`--tools` and `--add-dir` do not exist yet, and the guard that should have caught that passes.**
ADR-001's accepted decision requires four things on every spawn: `--restricted`, `--strict-mcp-config`,
`--add-dir` scoped to the run worktree, and `--tools` naming exactly what that agent is granted. `grep` for
`'--tools'` and `--add-dir` across `src/` returns nothing. `AD1_REQUIRED_FLAGS` lists only four flags, two of
which are neither of these, so `missingRequiredFlags` returns empty — "the contract holds" — while the grant
is unenforced. **Adding the two flags to that list is part of this story, and the list itself needs a test
against ADR-001's enumeration**, because a required-flag list that omits a required flag is the exact shape of
defect this project keeps meeting: a guard that reads as coverage while covering less.

**The grant comes from the roster, never from a map in the engine.** AD-17: the engine "holds no compiled-in
list". Story 2-3 built `discoverRoster` and a recursive guard proving no file under `src/engine/` imports the
installer's `BUILT_IN_AGENTS`. A `phase → tools` table compiled into the spawner would re-create exactly the
violation that guard exists to prevent, while passing it — the guard matches import specifiers and two
literal names, not the idea of a hardcoded roster. So `--tools` is built from the `RosterEntry` the run's
config snapshot carries, and a phase with no roster entry is a refusal, not a default.

**The agent ids and the phase names are the same six words, and that is a fact to use rather than to
re-encode.** `BUILT_IN_AGENTS` declares `analysis`, `planning`, `implementation`, `testing`, `verification`,
`committing`; ADR-003's grant table uses the same six; `STEP_PHASES` currently holds two of them. Extending
`STEP_PHASES` to the four this story needs — the two existing plus `analysis` and `planning` — is an enum
widening on an artifact the engine writes, so it is `schema_version`-relevant per AD-28: an older build
reading a newer `state.json` must refuse with `config.schema_version_unrecognised` rather than crash, which
`parseVersionedArtifact` already does.

**Territory is produced by analysis and re-declared, not declared once.** `acceptFeature` emits
`feature.territory_declared` at run creation from `plan.territory`, before any step has read the repository.
Analysis is what actually knows which files a feature touches. Re-declaration is already the designed
behaviour — `territoryFromEvents` takes the **last** declaration, on the stated grounds that "a
re-declaration is a correction" — and an incomplete territory becomes `WHOLE_REPOSITORY_TERRITORY`, so the
mechanism fails safe. What this story must not paper over is the hazard: a re-declaration that **widens** the
territory can newly overlap a feature already admitted and already writing. Admission is recomputed every
pass, so the next pass serialises them — but work already done concurrently is not undone. The story's job is
to make the widening visible in the log, not to invent a rollback the architecture does not have.

**Provenance must bind a claim to its producer, which a flat string array cannot do.** `StepOutput.provenance`
is `z.array(z.string())` under the comment "Every claim carries the step that produced it." A list of strings
beside a list of claims does not bind them: nothing stops a three-claim output carrying one provenance entry,
and a test asserting `provenance.length > 0` would pass on an output whose claims are unattributed. The two
new contracts carry provenance **on each claim**, and the assertion is per claim, not over the array.

**Re-grounding means the verbatim request, and the input already carries it.** `StepInput.request` is "the
user's original words, verbatim" and `acceptance_criteria` is a separate array. `architecture.md` requires
every agent to read the original rather than "a summary of a summary". So neither agent takes a summary as an
input field — there is no field for one — and planning reads the same `request` analysis read rather than
analysis's `summary`. Planning may read analysis's output as a prior artifact from the worktree, which is the
no-agent-to-agent-messaging rule, but its grounding is the request.

**Nothing here runs a command, and nothing here writes to the repository.** Neither agent is granted `Bash`,
so ADR-001's container does not enter this story: there is no command to contain. Both produce
`write_intents` at most, which AD-15 leaves for the engine to execute. Territory is written as an event by
the engine, not by the agent.

## I/O & Edge-Case Matrix

| # | Input / situation | Expected |
|---|---|---|
| 1 | A registered `step.analysis` contract id | Exports to draft-7 for `--json-schema`, and an output is re-parsed against it |
| 2 | A registered `step.planning` contract id | The same, and the two are distinct contracts, not one shared shape |
| 3 | An analysis output naming files it read | Each claim carries the step that produced it |
| 4 | An analysis output with three claims and one provenance entry | Refused: provenance is per claim, not a parallel list |
| 5 | An analysis output declaring a territory | The engine emits `feature.territory_declared`, and replay reads the new one as the correction |
| 6 | A re-declaration that widens the territory | Recorded, and the widening is visible in the log rather than silently applied |
| 7 | A re-declaration that narrows the territory | Recorded; admission recomputes next pass |
| 8 | A territory entry spelled loosely (`./src/`, backslashes) | Normalised by the existing `normaliseTerritory`, not by a second implementation |
| 9 | A spawn for the `analysis` phase | argv carries `--tools Read,Grep,Glob` from the roster entry and `--add-dir` scoped to the run worktree |
| 10 | A spawn for a phase with no roster entry | Refused naming the phase and the roster it looked in; never a default grant |
| 11 | A roster entry granting `Write` to `analysis` | The argv carries what the roster declares — the roster is authoritative (AD-17), and the divergence from ADR-003 is reported, not silently corrected |
| 12 | `AD1_REQUIRED_FLAGS` | Contains all four flags ADR-001 requires, asserted against that enumeration |
| 13 | An argv missing `--tools` | `missingRequiredFlags` names it — the case that returns empty today |
| 14 | `STEP_PHASES` | Carries `analysis` and `planning` alongside the existing two |
| 15 | An older build reading a `state.json` whose phase it does not know | Refused with `config.schema_version_unrecognised`, not a crash |
| 16 | A planning output grounded on analysis's `summary` instead of the request | Impossible: there is no input field for a summary |
| 17 | The same input file re-run through either agent | The same output shape, and no write outside it |
| 18 | An analysis output claiming a file outside the run worktree | Refused: a claim's path is inside the territory it declares |
| 19 | A step output whose `contract_id` disagrees with the phase spawned | Refused before the output is accepted |
| 20 | Either agent's prompt | Names the verbatim request, and no summary of it |

## Code Map

| File | Change | Why |
|---|---|---|
| `src/contracts/analysis.ts` | new | `step.analysis`'s output: claims with per-claim provenance, the declared territory, the files read. AD-2 puts every schema in code. |
| `src/contracts/planning.ts` | new | `step.planning`'s output: the ordered plan, each step carrying its provenance. Distinct from analysis, not a shared shape. |
| `src/contracts/registry.ts` | modify | Register both ids so `--json-schema` can export them and the spawner can re-parse against them. |
| `src/contracts/state.ts` | modify | `STEP_PHASES` gains `analysis` and `planning`. |
| `src/engine/spawner.ts` | modify | `--tools` from the roster entry, `--add-dir` scoped to the worktree, and both added to `AD1_REQUIRED_FLAGS`. |
| `src/engine/agents.ts` | new | The phase → roster-entry resolution, reading the run's snapshot. The one place that answers "what is this phase granted", so no caller invents a default. |
| `src/engine/territory.ts` | modify | Only if producing a declaration needs a helper the module does not already export; reuse `normaliseTerritory` and `territoryDeclaredPayload` rather than adding a second path. |
| `tests/contracts.analysis.test.ts` | new | Matrix 1, 3, 4, 18. |
| `tests/contracts.planning.test.ts` | new | Matrix 2, 16, 19. |
| `tests/engine.agents.test.ts` | new | Matrix 9–11, and the guard that no `phase → tools` table exists in the engine. |
| `tests/engine.spawner.tools.test.ts` | new | Matrix 12, 13 — including that `AD1_REQUIRED_FLAGS` is complete against ADR-001. |
| `tests/engine.territory.declaration.test.ts` | new | Matrix 5–8. |

## Tasks & Acceptance

1. **Register the two output contracts.**
   - **Given** the contract registry, **when** `step.analysis` and `step.planning` are looked up, **then**
     both resolve and export to draft-7 for `--json-schema`.
   - **Given** an analysis output, **when** it is re-parsed against `step.analysis`, **then** it is accepted,
     and a planning-shaped output against the same id is refused.
2. **Bind provenance to each claim.**
   - **Given** an output carrying three claims, **when** one claim has no provenance, **then** it is refused.
   - **Given** an output, **when** provenance is asserted, **then** each claim's provenance names the step
     that produced it rather than the array being non-empty.
3. **Produce and re-declare the territory.**
   - **Given** an analysis output declaring a territory, **when** the engine records it, **then**
     `feature.territory_declared` carries the declared paths and replay reads them as the correction.
   - **Given** a re-declaration that widens the territory, **when** it is recorded, **then** the widening is
     visible in the log and the next admission pass serialises the newly overlapping features.
4. **Wire the per-agent grant.**
   - **Given** a spawn for `analysis`, **when** the argv is built, **then** it carries `--tools` naming
     exactly the roster entry's grant and `--add-dir` scoped to the run worktree.
   - **Given** a phase with no roster entry, **when** a spawn is attempted, **then** it is refused naming the
     phase and the roster read, and no default grant is applied.
   - **Given** `AD1_REQUIRED_FLAGS`, **when** it is compared to ADR-001's four required flags, **then** it
     contains all of them, and an argv missing `--tools` is named by `missingRequiredFlags`.
5. **Extend the phase vocabulary safely.**
   - **Given** `STEP_PHASES`, **when** it is read, **then** it carries `analysis` and `planning`.
   - **Given** a `state.json` whose phase an older build does not know, **when** it is read, **then** it is
     refused with `config.schema_version_unrecognised`.
6. **Keep both agents pure and re-grounded.**
   - **Given** either agent's input, **when** its fields are inspected, **then** there is no field carrying a
     summary of the request, and `request` carries the user's words verbatim.
   - **Given** the same input file, **when** either agent is re-run, **then** the output shape is the same and
     nothing outside it is written.

## Spec Change Log

## Review Triage Log

## Design Notes

## Verification

## Auto Run Result
