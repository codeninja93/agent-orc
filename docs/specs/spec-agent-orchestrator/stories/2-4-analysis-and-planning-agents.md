---
title: 'Step agents — analysis and planning'
type: 'feature'
created: '2026-09-22'
status: 'done'
review_loop_iteration: 0
followup_review_recommended: true
baseline_revision: '795b4c4'
context:
  - '{project-root}/docs/planning-artifacts/architecture/architecture-agent-orcastrator-2026-09-19/ARCHITECTURE-SPINE.md'
  - '{project-root}/docs/planning-artifacts/architecture/architecture-agent-orcastrator-2026-09-19/ADR-001-tier-2-execution.md'
  - '{project-root}/docs/planning-artifacts/architecture/architecture-agent-orcastrator-2026-09-19/ADR-003-built-in-agent-tool-grants.md'
  - '{project-root}/docs/specs/spec-agent-orchestrator/architecture.md'
  - '{project-root}/docs/specs/spec-agent-orchestrator/stories/2-3-profile-loader-and-roster.md'
deferred:
- summary: 'Review pass 1 ran all four layers; 43 patches applied and one bad_spec cause amended.'
  evidence: '53 findings — high 9, medium 34, low 10, false 0, maybe-false 0 — routed 43 patch, 4 bad_spec,
    3 defer, 3 reject. The bad_spec cause was filed independently by all four layers: the intent names the
    reconciler and the spec had scoped it out. Amended and implemented rather than reverted, which was the
    user''s explicit decision and is a deliberate deviation from the protocol''s revert-and-re-derive
    cascade. `followup_review_recommended` is true because a `high` was patched.'
  severity: low
- summary: '`STEP_PHASES` has four members while the roster declares six agents.'
  evidence: '`testing` and `committing` are declared in `BUILT_IN_AGENTS` with ADR-003 grants, but no phase
    names them, so `resolveAgentGrant` can never be called with either and their declarations are
    unreachable. Stories 2-5 through 2-7 add those phases; what is inaccurate now is any docblock claiming
    the phase names and the agent ids are the same six words.'
  location: src/contracts/state.ts
  severity: medium
- summary: 'Territory paths are compared case-sensitively, so two spellings collide on macOS and Windows.'
  evidence: 'Two declared paths differing only in case read as disjoint, so two features whose territories
    genuinely overlap can be admitted together and write one file. Pre-existing: the comparison came from
    `src/engine/territory.ts` at story 1-3 and this story moved it to `src/contracts/territory.ts`
    unchanged. The fix is a platform-dependent fold, which is a decision about whether the engine models
    the filesystem''s case behaviour at all.'
  location: src/contracts/territory.ts
  severity: medium
- summary: '`recordResult` throwing gives the caller an exception where a `recorded` boolean was promised.'
  evidence: 'A closed recorder, or an envelope the recorder refuses, raises rather than returning
    `recorded: false`. Now that the reconciler is the sole caller the question is answerable — a dropped
    line raises `UnrecordedAction` like every other emit — but the returned shape still advertises a
    boolean the caller cannot rely on to mean "not recorded".'
  location: src/engine/territory.ts
  severity: low
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
| 21 | The built-in roster | `analysis` declares `step.analysis` and `planning` declares `step.planning`, bound by a test to the same pinned table that holds their tool grants |
| 22 | A plan for a feature | Carries `analysis` and `planning` steps, so a spawn does carry `phase: 'analysis'` |
| 23 | An analysis step completing with a territory | The engine records the re-declaration, and the next admission pass serialises a feature the new territory newly overlaps |
| 24 | A spawner built with no `grantFor` | Resolves the grant from the run's AD-9 snapshot keyed by the request's phase and the configured `ORCH_HOME` |
| 25 | A wrapper that keeps `--tools` but empties or rewrites its value | Named by `missingRequiredFlags`: a flag's presence is not its value |
| 26 | An `--add-dir` value that is empty or relative | Refused; it is the absolute run worktree or it is nothing |
| 27 | A territory entry spelled blank, whitespace, `/` or `src/..` | Refused, rather than silently meaning the whole repository and making claim containment vacuous |
| 28 | A completed analysis with no claims, or a completed plan with no steps | Refused: an empty collection makes every per-item refinement pass vacuously |
| 29 | An analysis reporting `blocked` or `failed` with no determinable territory | Accepted: the territory requirement binds on `completed`, so a legitimate refusal can terminate cleanly |
| 30 | A re-declaration whose `previous` is not the log's last declaration | The log's own last declaration is used, so a real widening cannot record `widened: false` |
| 31 | A re-declaration declaring nothing | Refused: an empty territory collides with nothing and is admitted beside every feature |
| 32 | A step folded with phase `analysis` or `planning` | The projection reports that phase, and the next-up line does not claim the implementation steps are done |
| 33 | `agent.spawned` | Carries the grant verbatim under declared payload keys, and `elevated_tools` is the elevated subset rather than a copy of the grant |
| 34 | A grant that cannot be resolved | `AgentGrantUnresolved` reaches the caller with `config.invalid`, never relabelled retryable |

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
| `src/installer/interview.ts` | modify | The two declarations name their own contracts, and the module comment stops claiming every agent references `step.output`. |
| `src/engine/reconciler.ts` | modify | A plan carries analysis and planning steps, and a completed analysis records the territory re-declaration. This is the join the intent names. |
| `tests/contracts.agent-grants.test.ts` | modify | The pinned per-agent table gains a contract-id row beside the tool grants. |
| `tests/tui.projection.test.ts` | modify | Fold a step of each phase in `STEP_PHASES`, so the next widening is covered by construction. |

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

### 2026-09-22 — amended by review pass 1 (one `bad_spec` root cause, filed by all four layers)

**Triggering finding.** BH4 / EC19 / VG6 / IA-a — `recordTerritoryRedeclaration` has no production caller, no
`FeaturePlan` contains an analysis or planning step, and the only production emitter of
`feature.territory_declared` is still the run-creation line. The verbatim intent says the story produces "the
feature's declared file territory **that the reconciler uses to serialize overlapping work**". The spec's Code
Map excluded `src/engine/reconciler.ts` and its Boundaries said the wiring belonged to a later story. That was
the spec drawing a line the intent did not draw, which the review protocol does not allow to be deferred.

**What was amended.** Matrix rows 21–34 added: the roster naming its own contracts, a plan carrying the two
new phases, the re-declaration recorded from a completed analysis, the spawner's default grant resolution,
flag *values* as well as names, the blank-path refusal, empty-collection refusals, the `blocked`/`failed`
exemption, the stale-`previous` fix, and the projection folding every phase. The Code Map gained
`src/installer/interview.ts`, `src/engine/reconciler.ts`, `tests/contracts.agent-grants.test.ts` and
`tests/tui.projection.test.ts`.

**The known-bad state avoided.** Two of them. First, the intent's causal chain — feature accepted → analysis
runs → territory re-declared → the overlapping feature is deferred — had each half built and tested in
isolation with hand-assembled inputs, and no test crossing the seam between them. Second, `BUILT_IN_AGENTS`
still declared `contract: 'step.output'` for both agents while `AnalysisOutputSchema` pins
`contract_id: z.literal('step.analysis')`, so the shipped declaration and the new contract could never both
hold and every refusal this story added was dead for a default install — with no test able to notice.

**KEEP instructions — what worked and must survive.** (1) `tools` and `addDir` stay **required** on
`StepArgvOptions`: an argv built with no grant must remain a compile error. (2) The grant-table shape guard in
`tests/engine.agents.test.ts`, including its three planted forms and its demonstration that story 2-3's import
guard walks past them — verified independently by planting a table under `src/engine/nested/`. (3) Per-claim
provenance, including the test that pins the weak flat-array assertion as one the suite refuses to make.
(4) The identity assertion `expect(normaliseTerritory).toBe(normaliseTerritoryFromContracts)` — identity, not
equivalence. (5) The two recorded `claude -p` fixtures; do not replace them with synthesised JSON. (6) The
roster staying authoritative over ADR-003, with divergence reported rather than silently corrected.


## Review Triage Log

### 2026-09-22 — Review pass
- verdicts: 53 findings — high 9, medium 34, low 10, false 0, maybe-false 0
- findings:
  - `[medium]` `[patch]` BH1 — a blank, whitespace, `/`, `//` or `src/..` territory entry normalises to `.` and is accepted — reproduced with a positive control. The stated consequence is **wrong on direction**: `.` is the documented fail-safe (`WHOLE_REPOSITORY_TERRITORY` — "a feature serialised when it need not have been costs a pass"). The real harm is that matrix 18's claim-containment refinement goes vacuous, accepting any path at all, and a malformed blank entry is read as a meaningful declaration.
  - `[high]` `[patch]` BH2 — the two new contracts are registered but nothing references them: `BUILT_IN_AGENTS` still declares `contract: 'step.output'` for `analysis` and `planning`. Verified. Because `AnalysisOutputSchema` pins `contract_id: z.literal('step.analysis')`, the shipped declaration and the new contract can never both hold, so for a default install every per-claim provenance, territory-containment and `files_read` refusal is dead.
  - `[low]` `[patch]` BH3 — `src/installer/interview.ts`'s module comment still says "Every one references `step.output` … a roster member that needed a genuinely new contract shape would need an engine change, and none of these does." This story created exactly two such shapes; the comment now argues against the change shipped beside it.
  - `[high]` `[bad_spec]` BH4 — `recordTerritoryRedeclaration` has no production caller. Verified: every call site is in `tests/engine.territory.declaration.test.ts`, and the only production emitter of `feature.territory_declared` is still the run-creation line. The intent names the reconciler explicitly, so the spec — not the intent — drew this line.
  - `[medium]` `[defer]` BH5 — `STEP_PHASES` has four members while `BUILT_IN_AGENTS` has six, so the `testing` and `committing` declarations are unreachable by phase and `resolveAgentGrant` can never be called with them. Stories 2-5 through 2-7 add those phases; what is fair now is that the docblock claims an identity that does not yet hold.
  - `[low]` `[patch]` BH6 — `STEP_PHASES`'s docblock still describes a two-valued enum ("exactly the boundary between the two") after being widened to four, and says nothing about where analysis and planning fall relative to CAP-13's gate.
  - `[medium]` `[patch]` BH7 — `grant_declared_at` records `<orchHome>/runs/<ULID>/config/agents/<id>.toml`, and AD-21 redacts an unbroken run of ≥24 characters at ≥3.5 bits/char; a real ULID is 26 characters at 4.18. The field whose stated job is to name a file loses the segment that locates the run, and no test covers its post-redaction value.
  - `[medium]` `[patch]` BH8 — the four new `agent.spawned` fields are written as bare string literals with no payload-key constants and no schema, while the four territory keys added in the same diff were given `DECLARATION_PAYLOAD_KEYS` entries. Two conventions for new payload keys in one change, and nothing for a non-engine reader to look up.
  - `[medium]` `[patch]` BH9 — `PlanningOutputSchema` refuses an empty `territory` with a paragraph about failing safe, then accepts `plan: []` — a completed planning output that plans nothing.
  - `[medium]` `[patch]` BH10 — blank strings are refused for provenance halves but not for the fields carrying the content: `AnalysisClaim.claim`, `PlannedStep.step`, `PlannedStep.intent` and `PlannedStep.contract_id` are plain `z.string()`. The duplicate-step-id check is raw equality, so `'one'` and `'one '` are two steps.
  - `[medium]` `[patch]` BH11 — `territoryRedeclaration(['src/engine'], ['src/engine/lock.ts'])` reports `removed: ['src/engine']` although `src/engine/lock.ts` is still claimed, and the suite asserts that as expected. A reader acting on `removed_paths` is told the whole directory was released. Containment is applied to `added` but not to `removed`.
  - `[medium]` `[patch]` BH12 — an unchanged re-declaration still appends a line, with `added: []`, `removed: []`, `widened: false`, stamped `ENGINE_EMITTER` — documented as the emitter every event *the reconciler* originates carries, while this line originates in the step-output path, so emitter-based filtering can no longer tell them apart.
  - `[medium]` `[patch]` BH13 — test gaps around the new refinements: an invalid `territory` entry never exercises its `ctx.addIssue` branch; the outside-the-territory case asserts on `issues[0]` by index and breaks if another issue is raised first; the shape guard scans only `src/engine/`; its comment stripper misses trailing `//`.
  - `[medium]` `[patch]` EC1 — a blank or whitespace path normalises to `.`; same root cause as BH1.
  - `[medium]` `[patch]` EC2 — `/` and `//` normalise to `.` before the absolute-path check can run; same root cause as BH1.
  - `[low]` `[patch]` EC3 — `isRepositoryRelativePath`'s `normalised === ''` refusal is unreachable, because `normaliseTerritoryPath` never returns the empty string; same root cause as BH1.
  - `[medium]` `[defer]` EC4 — `pathsCollide` compares case-sensitively, so two spellings differing only in case read as disjoint on macOS and Windows and two features could write one file. Pre-existing: the comparison came from `src/engine/territory.ts` at story 1-3 and this story moved it unchanged.
  - `[medium]` `[patch]` EC5 — an analysis reporting `blocked` or `failed` without a determinable territory is refused as `schema_invalid_output`, so a legitimate blocked report cannot terminate cleanly. The territory refusal should bind on `completed`.
  - `[medium]` `[patch]` EC6 — `claims: []` makes every per-claim refinement pass vacuously, so an analysis asserting nothing is accepted as completed and fully attributed. This is the empty-collection sibling of the per-claim rule the story exists for.
  - `[medium]` `[patch]` EC7 — a blank `claim` string parses while blank provenance is refused; same root cause as BH10.
  - `[medium]` `[patch]` EC8 — `plan: []` accepted on a completed planning output; same root cause as BH9.
  - `[medium]` `[patch]` EC9 — a planned step may name an unregistered or blank `contract_id`, so `getContract` throws mid-run instead of the plan being refused at parse.
  - `[medium]` `[patch]` EC10 — `ProfileNotFound` and `ProfileUnreadable` are not in `KEEPS_ITS_OWN_CODE`, so a `config.invalid` refusal raised while resolving the grant is relabelled retryable and the loop re-spawns a step it cannot build.
  - `[medium]` `[patch]` EC11 — `missingRequiredFlags` checks only that a flag name is present, so a wrapper that keeps `--tools`/`--add-dir` and rewrites or empties their values passes the guard while the grant or worktree has changed. The guard added by this very story can therefore report a confinement contract that no longer holds.
  - `[medium]` `[patch]` EC12 — an empty or relative `request.worktree` becomes the `--add-dir` value unchecked, widening or breaking file-tool confinement with the guard still passing.
  - `[medium]` `[patch]` EC13 — `recordTerritoryRedeclaration` accepts `declared: []`, recording a territory of nothing, which is admitted beside every other feature. This is the genuine fail-open direction, unlike BH1.
  - `[medium]` `[patch]` EC14 — `previous` is caller-supplied and never checked against the log's last declaration, so a stale value makes a real widening record `widened: false` and `added: []`, hiding the hazard those keys exist for.
  - `[low]` `[defer]` EC15 — `recordResult` throwing gives the caller an exception where a `recorded` boolean was promised. Real, but no caller exists yet to observe it, and the fix is an interface decision the first production caller should make.
  - `[low]` `[patch]` EC16 — nothing relates `widened` to `added_paths`, so a payload can claim a widening and name no added path.
  - `[medium]` `[patch]` EC17 — `src/tui/projection.ts:573` branches on the literal `'verification'`, so an `analysis` or `planning` step takes the else branch and the card reads "verification, once the implementation steps are done" — telling a person the run is past implementation before it has started.
  - `[low]` `[patch]` EC18 — `territoryContains` is called with `output.territory` before its own entries are validated, so an invalid entry still decides claim containment and raises a second, misleading issue.
  - `[high]` `[bad_spec]` EC19 — nothing in `src/` calls `recordTerritoryRedeclaration` or `territoryRedeclaration`; same root cause as BH4.
  - `[medium]` `[patch]` EC20 — claim that two literal phase readers remain. **Partly refuted**: `src/engine/rebuild.ts:298-300` derives correctly via `isOneOf(STEP_PHASES, declaredPhase)` and its `'implementation'` is only a fallback when no phase is known anywhere, and `src/tui/cards/completion.ts:102`'s filter for verification steps is intentional. What survives is `projection.ts:573`, carried as EC17.
  - `[high]` `[patch]` EC21 — `BUILT_IN_AGENTS` still declares `step.output` for both agents; same root cause as BH2.
  - `[low]` `[reject]` EC22 — claim that purity is a property of the shipped roster rather than enforced. True but not a defect: matrix row 11 decided deliberately that the roster is authoritative and a divergence is reported, because holding ADR-003's table in the engine is what AD-17 forbids. Rejected as the decided design, recorded as a deferred entry already.
  - `[low]` `[patch]` EC23 — the duplicate-step-id rule is enforced by a refinement but not stated in `PlannedStepSchema.step`'s `.describe()`, against the file's own rule that every refinement is also stated in prose so the producer can see it.
  - `[medium]` `[patch]` VG1 — the four grant fields on `agent.spawned` are asserted by no test; pre-verified. Deleting all four, or recording `granted_tools` for both, leaves the suite green, because the only test reading that payload names `node_version`, `cli_version`, `flags` and `emitter`.
  - `[high]` `[patch]` VG2 — the spawner's default `grantFor` — the only path a real run takes — is never executed. Pre-verified: both `createStepSpawner` sites pass `grantFor`, so changing `phase: request.phase` to `request.step`, or dropping the `orchHome` spread, compiles and fails nothing. A spawn keyed by the wrong roster entry, or reading the wrong `ORCH_HOME`, ships undetected.
  - `[medium]` `[patch]` VG3 — `AgentGrantUnresolved` keeping its own AD-35 code through the spawner is untested; pre-verified. Removing it from `KEEPS_ITS_OWN_CODE` relabels the refusal retryable and the loop re-spawns an unbuildable step for ever — the outcome its own comment says it prevents — with no test failing.
  - `[medium]` `[patch]` VG4 — the TUI phase derivation is fixed but unpinned; pre-verified, and I reproduced it myself: reverting `stepPhase` to the two-literal form **and** removing the now-unused import leaves typecheck clean and all 80 TUI tests passing. Every log-builder call site passes `implementation` or `verification`, so no fold ever supplies the new phases.
  - `[high]` `[patch]` VG5 — no test binds a built-in agent id to its contract id, so the roster can stay on `step.output` indefinitely with a green suite; same root cause as BH2. `tests/contracts.agent-grants.test.ts` already holds the per-agent decision table and is where the row belongs.
  - `[high]` `[bad_spec]` VG6 — nothing converts an `AnalysisOutput.territory` into a re-declaration; same root cause as BH4.
  - `[medium]` `[patch]` VG7 — `isRepositoryRelativePath`'s empty-string refusal is unreachable and a blank path reads as the whole repository; same root cause as BH1.
  - `[medium]` `[patch]` VG8 — `projection.ts:573` still branches on a phase literal; same root cause as EC17. This finding also settles EC20 by checking `rebuild.ts` and `completion.ts` and clearing both.
  - `[high]` `[bad_spec]` IA-a — the intent's closing clause lives at the orchestration surface and nothing in the diff touches it: no `FeaturePlan` contains an analysis or planning step, so no spawn ever carries `phase: 'analysis'`. Same root cause as BH4.
  - `[medium]` `[patch]` IA-b — the seam the intent names is the one thing no test crosses: matrix row 6 calls `admitByTerritory` with literal arrays rather than with the territory folded from the log the preceding assertion just wrote, and nothing ever passes `recordTerritoryRedeclaration` an `AnalysisOutput`.
  - `[high]` `[patch]` IA-c — under the intent's sense of "roster agents", the two agents in the roster are still `step.output` agents; same root cause as BH2.
  - `[medium]` `[patch]` IA-d — both new schemas extend `StepOutputSchema`, so the unrefined flat `provenance` this story exists to replace remains **required** on every analysis and planning output, with no refinement relating it to `claims`. The suite pins the weak assertion as one it refuses to make, but leaves the weak channel in the artifact.
  - `[medium]` `[patch]` IA-e — re-grounding is three sentences in `defaultPromptFor`, which does not branch on phase, so matrix row 20's parameterisation over `['analysis','planning']` cannot fail differently for the assertion it makes; and the R5b half asserts an absence over a *field-name list* rather than over what an input file contains.
  - `[low]` `[reject]` IA-f — descriptive: the grant wiring is the best-covered reading, and purity is discharged negatively via `expect(grant.elevated).toStrictEqual([])` on a fixture the test wrote. No defect named; the substance is carried by EC22 and VG2.
  - `[low]` `[reject]` IA-g — descriptive: the source-text guard is lexical and has no counterpart in the intent. It is deliberate, comes from the story's AD-17 boundary, and I verified it catches what story 2-3's guard walks past. Its real gap — scanning only `src/engine/` — is carried by BH13.
  - `[medium]` `[patch]` IA-h — matrix row 17 ("the same input re-run gives the same output shape") is discharged by parsing one recorded JSON file twice and comparing, which is a property of Zod over a constant rather than of an agent re-run.
  - `[medium]` `[patch]` IA-i — the shipped `stepPhase` change has no test at its own surface; same root cause as VG4.

- actions taken, per root cause (every `patch` and `bad_spec` row above resolves to one of these):
  - **A — roster contract ids** (BH2, EC21, VG5, IA-c). `analysis` declares `step.analysis`, `planning` declares `step.planning`, and the false module comment is rewritten to say four of six reference `step.output` and why a declaration naming the wrong contract can never hold. The pinned table in `tests/contracts.agent-grants.test.ts` became `DECLARED`, carrying `tools` and `contract` per agent with `GRANTED` derived from it, so every existing grant assertion is unchanged. The decisive new case feeds each contract an output claiming `contract_id: 'step.output'` and requires refusal — a test that only checked "the id is registered" would have passed on the shipped defect.
  - **B — the reconciler wiring** (BH4, EC19, VG6, IA-a; `bad_spec`, amended into matrix 22–23). `STANDARD_PLAN_STEPS` gives a plan analysis → planning → implementation → verification, and `recordTermination` records the re-declaration. Keyed on **the contract** rather than the phase, so it is not a second place deciding what an analysis agent is and a repository declaring its own agent against `step.analysis` still works. This needed `StepTermination.contractOutput`, because `StepOutputSchema.safeParse` strips the fields a phase contract adds and the territory was otherwise unreachable. The seam is crossed in a test that folds the territory **back out of the log it just wrote** and passes that to `admitByTerritory`; I confirmed non-vacuity myself by disabling the call, which fails the assertion that two declarations exist.
  - **C — the default grant resolution** (VG2). A spawner built with no `grantFor`, against a real snapshot, asserting `--tools Glob,Read` on the child's own argv — a grant ADR-003 would never produce, so it can only match if the lookup used this phase and this snapshot.
  - **D — guards that could not fail** (EC11, EC12, VG1, VG3, VG4, IA-i). `missingRequiredFlags(argv, expected?)` compares values for `--tools` and `--add-dir` when expectations are given and stays presence-only otherwise, with five planted-wrapper cases and one asserting `--tools ""` remains valid *as a value*. `AddDirNotAbsolute` refuses empty, whitespace and relative. `SPAWN_GRANT_PAYLOAD_KEYS` declares the four grant keys, asserted against a fixture whose `elevated` differs from `tools`. `AgentGrantUnresolved` is asserted to reach the caller as `config.invalid`. The projection folds a step of every `STEP_PHASES` member plus an unknown one.
  - **E — the next-up phase literal** (EC17, VG8). Replaced by a total `Readonly<Record<StepPhase, string>>`, so a fifth phase is a compile error rather than a sentence nobody re-reads.
  - **F — territory path handling** (BH1, EC1, EC2, EC3, VG7, EC18). The raw spelling is checked before normalising. Verified both directions myself: `''`, `'   '`, `'/'`, `'//'`, `'src/..'`, `'../outside'` and `'/abs/path'` refused; `.`, `./`, `src`, `src/engine/`, `a.b.c/d.ts` and a path with spaces still accepted. `.`'s fail-safe role is untouched and the docblock now states the consequence was containment, not concurrency.
  - **G — empty collections** (BH9, EC5, EC6, EC8). `claims: []`, `plan: []` and an empty territory are refused on `completed` only. A `blocked`/`failed` report is accepted, because `step.schema_invalid_output` disposes to `escalate-model-tier` and refusing an honest refusal would promote the ladder against a step that did its job.
  - **H — re-declaration correctness** (BH11, BH12, EC13, EC14, EC16). `recordTerritoryRedeclaration` takes the events and derives the prior territory itself, so a caller cannot supply a stale one. `declared: []` raises `TerritoryDeclaresNothing`. The sole caller is now the reconciler, so `ENGINE_EMITTER` is accurate. `removed` keeps its name and its entry-level semantics, documented and pinned rather than renamed.
  - **I — contract hygiene** (BH10, EC7, EC9, EC23). Blank refusals on the content-carrying fields; duplicate step ids compared trimmed; `widened === added_paths.length > 0` bound on the payload schema itself; the territory validated before containment is asked of it; every refinement also stated in its field's `.describe()`. The unregistered-`contract_id` check lives in `parsePlanningOutput` in the registry, because `planning.ts` cannot ask the registry without an import cycle.
  - **J — smaller items** (BH3, BH6, BH7, BH8, BH13, IA-b, IA-d, IA-e, IA-h, EC10, EC20). `ProfileNotFound`/`ProfileUnreadable` keep their own code. `grant_declared_at` was **replaced** after measurement contradicted the original plan: the post-redaction value is `/nowhere/.[redacted].toml` because `orch/agents/implementation` is itself one unbroken high-entropy run, so the payload now records `grant_declared_file` — the file name survives, the run id is on the envelope, and the directory is fixed for every run. The shape guard now scans all of `src/` except `src/installer/`, with a test asserting it *would* fire on the installer so the exemption is doing work rather than hiding nothing.

## Design Notes

## Verification

Run by me after the patch round, with the suite's own exit status captured to a variable and the output kept
in a file: `npm run typecheck && npm run lint && npm run build && npm test` — **exit 0, 2053 tests across 72
files, zero failures, zero skips.** Baseline `795b4c4` was 1888/67; the implementation reached 1980/72 and the
review's patches took it to 2053/72. Node pinned to v24.21.0.

**Verified by me directly, not taken on report**, each with a positive control first:

- The territory refusal holds in **both** directions — the failure mode the previous story's equivalent fix
  hit. Refused: `''`, `'   '`, `'/'`, `'//'`, `'src/..'`, `'../outside'`, `'/abs/path'`. Still accepted: `.`,
  `./`, `src`, `src/engine/`, `a.b.c/d.ts`, and a path containing spaces. No over-correction.
- `missingRequiredFlags` compares values for `--tools` and `--add-dir` when expectations are supplied and
  stays presence-only when they are not.
- `BUILT_IN_AGENTS` declares `step.analysis` and `step.planning`.
- **The seam is genuinely crossed.** I disabled the reconciler's `recordDeclaredTerritory` call: the test
  fails on the assertion that the log carries two declarations — the plan's and analysis's correction.
- Earlier, before the patch round, I established the TUI defect by mutation: reverting `stepPhase` to the
  two-literal form **and** removing the now-unused import left typecheck clean and all 80 TUI tests passing.
  That is what made it a finding rather than a preference; it now fails two tests.

## Auto Run Result

**Status: done, reviewed.** The two agents exist, their contracts are registered *and referenced by the
roster*, the AD-17 grant reaches `--tools`, and a completed analysis now records the territory correction the
reconciler serialises on.

**Review findings: 53 across four layers** — high 9, medium 34, low 10, false 0, maybe-false 0. Routed 43
patch, 4 bad_spec, 3 defer, 3 reject. All 43 patches applied and verified.

**The `bad_spec` cause was filed independently by all four layers**, which is what made it hard to argue with:
`recordTerritoryRedeclaration` had no production caller, no `FeaturePlan` carried an analysis or planning
step, and the only production emitter of `feature.territory_declared` was still the run-creation line — while
the verbatim intent says the story produces the territory "that the reconciler uses to serialize overlapping
work". The spec's Code Map had excluded `reconciler.ts`. That was the spec drawing a line the intent did not,
which the protocol does not permit deferring. Amended and implemented rather than reverted, by the user's
explicit decision.

**The sharpest finding is the one about this story's own guard.** Story 2-4 existed partly to fix
`AD1_REQUIRED_FLAGS`, a required-flag list that omitted two required flags and so reported that AD-1's
contract held while the grant was unenforced. The review found that the replacement had the same weakness one
level down: `missingRequiredFlags` checked that `--tools` was *present* but not that it had a value, so a
wrapper emptying it passed. A guard written to close a guard-that-cannot-fail failed the same way.

**Rejected findings, with reasons.** Three, all descriptive rather than defects. That purity is a property of
the shipped roster rather than enforced — true, and matrix row 11 decided it deliberately, because holding
ADR-003's table in the engine is what AD-17 forbids. That the grant wiring is the best-covered reading and
purity is discharged negatively — no defect named; its substance is carried by the grant-resolution and
roster-authority rows. That the source-text guard is lexical with no counterpart in the intent — deliberate,
from the story's AD-17 boundary, and its real gap (scanning only `src/engine/`) was carried as its own row and
fixed.

**Three reviewer claims were refuted and deliberately not acted on.** `src/engine/rebuild.ts` derives from
`STEP_PHASES` via `isOneOf` and its `'implementation'` is only a fallback when no phase is known anywhere —
I had repeated this claim before checking it, and it is wrong. `src/tui/cards/completion.ts`'s filter for
verification steps is intentional. And the blank-path bug's "fail-open" framing is backwards: `.` is the
documented fail-safe, so the defect was the vacuous containment check, not the concurrency direction.

**One decision was reversed by measurement.** `grant_declared_at` recorded a path whose post-redaction value
is `/nowhere/.[redacted].toml`, because `orch/agents/implementation` is itself one unbroken high-entropy run —
the path loses the locating part and keeps the noise. The payload now records `grant_declared_file`, with the
run id on the envelope and the directory fixed for every run.

**Follow-up review recommended: true.** A `high` entry was patched, which sets it on a first pass. Patched
counts by verdict: high 4, medium 30, low 9. The specific unverified risk: `STANDARD_PLAN_STEPS` now names
four phases while the roster declares six agents, so `testing` and `committing` remain unreachable by phase,
and the plan the reconciler builds has never been executed end to end against a real `claude -p` — the two
recorded fixtures were produced by hand-invoking the CLI, not by a run.

**Residual risks.** Four deferred entries. The case-sensitivity of territory comparison is pre-existing and
unfixed, and on macOS — the stated primary development platform — two features whose territories differ only
in case can be admitted together.
