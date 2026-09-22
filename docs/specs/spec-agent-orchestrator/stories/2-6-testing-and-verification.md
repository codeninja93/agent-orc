---
title: 'Step agents — testing and verification with two-tier gate economics'
type: 'feature'
created: '2026-09-22'
status: 'drafted'
review_loop_iteration: 0
followup_review_recommended: false
baseline_revision: '5f2bf0c'
context:
  - '{project-root}/docs/planning-artifacts/architecture/architecture-agent-orcastrator-2026-09-19/ARCHITECTURE-SPINE.md'
  - '{project-root}/docs/planning-artifacts/architecture/architecture-agent-orcastrator-2026-09-19/ADR-001-tier-2-execution.md'
  - '{project-root}/docs/planning-artifacts/architecture/architecture-agent-orcastrator-2026-09-19/ADR-004-command-execution-as-a-capability.md'
  - '{project-root}/docs/specs/spec-agent-orchestrator/stories/2-5-implementation-agent.md'
deferred: []
---

# Story 2-6 — Testing and verification, with two-tier gate economics

## Intent

**Problem:** ADR-004 removed `Bash` from every built-in agent and named an MCP command-runner as its
replacement. Nothing built it, so **no step can execute anything** — `verification` holds
`promotion_policy: 'on-gate-failure'` for a gate it cannot run, and its purpose string still promises to run
one. `testing` is a declared agent with no phase, so nothing can spawn it. And CAP-13 requires deterministic
gates to run before any model-based review, which nothing sequences.

**Approach:** build the command-runner, repoint the container wrapper at commands as ADR-001 prescribes, give
testing and verification their phases and contracts, and make the gate economics observable: a run that fails
its deterministic gates spends nothing on model-based review.

## Boundaries & Constraints

**The command-runner is the only thing in the system that may start a container, and that must be
structural.** ADR-004: an agent that decides to run a command outside the container fails for lack of a tool.
So the runner is reached only as an MCP tool, served under `--mcp-config` with `--strict-mcp-config` so no
other server can load, and the commands it will run are the profile's `mechanics.commands` — not arbitrary
text. A runner that accepted a command string from the agent would be `Bash` with extra steps.

**`--restricted` means nobody can answer a permission prompt, so the tool must be pre-approved.** The CLI's
own help says `--restricted` "lets only a person or the configured permission tool" approve a tool use. A
`claude -p` run has no person. So the MCP tool is named in `--allowedTools`, and a run that omits it does not
hang — it must fail visibly, because a step waiting for an answer nobody can give is the worst outcome
available.

**CAP-13 names a gate the profile cannot express.** Its success criterion is "deterministic gates
(typecheck, lint, tests) run before any model-based review". `MECHANICS_COMMAND_NAMES` is
`['test','lint','build','run']` — there is no `typecheck`. This story adds it: a profile field, an interview
question, and the AD-28 consequence that a profile written by an older installer lacks it. An empty string is
a legitimate answer, as it already is for `lint` — a repository with no typecheck step records that it has
none, and a gate with no command is skipped rather than failed.

**"No review spend on a failing run" is a claim about cost, and cost is the thing this project refuses to
measure in currency (R10).** So the assertion is about *turns*, not money: a run whose deterministic gates
fail must spawn no model-based review at all. The observable is that no `agent.spawned` event exists for the
review, not that some counter reads zero — a counter can read zero because nothing incremented it.

**The two tiers live inside verification, because there is no review agent.** "Model-based review" appears
exactly once in the spec, in CAP-13's success line, and the roster has no reviewer. So `verification` runs
the declared gates first — deterministic, no model judgement — and only if they pass does it spend model
turns judging the change against the acceptance criteria. A single step with two tiers, not two steps.

**"Judged against criteria fixed before it was written" is a property of provenance, not of good
intentions.** `StepInput.acceptance_criteria` is already carried to every step. What this story must show is
that the criteria the verification step judges against are the ones the run was accepted with — the same
bytes, not a re-derivation — and that a step cannot introduce a criterion of its own to pass against.

**The container wrapper is repointed, not rebuilt.** ADR-001 is explicit: the image, the flag set, the mount
allow-list, the `--rm` rule and story 1-5's AD-31 assertion suite are "all unchanged and all still correct".
What changes is the argv placed inside — a command, not `claude -p`. A rewrite that re-derives the flag set
would throw away the one part of containment that has been verified since stage 1.

**Nothing here lets verification edit what it judges.** ADR-003's reasoning survives ADR-004: `verification`
has no `Write` or `Edit`, and gaining a command runner must not become a way around that. The runner executes
declared commands; it does not write files on the agent's behalf.

## I/O & Edge-Case Matrix

| # | Input / situation | Expected |
|---|---|---|
| 1 | The command-runner MCP server | Runs a named command from the profile's `mechanics.commands`, never a string the agent supplies |
| 2 | An agent asking for a command the profile does not declare | Refused naming the declared commands, never executed |
| 3 | A command that exits non-zero | Reported as a failed gate with its exit status, not as a tool error |
| 4 | A command's output | Returned as an evidence pointer (AD-23), never inlined into the control plane |
| 5 | The runner invoked | Starts exactly one container per command, per ADR-001's per-command lifetime |
| 6 | Anything other than the runner trying to start a container | Impossible: no other unit imports the container package |
| 7 | A spawn whose `--allowedTools` omits the runner | Fails visibly rather than hanging on a permission prompt nobody can answer |
| 8 | A spawn for a phase granted the runner | Carries `--mcp-config`, `--strict-mcp-config` and the tool in `--allowedTools` |
| 9 | `mechanics.commands` | Carries `typecheck` alongside test, lint, build and run |
| 10 | A profile written before `typecheck` existed | Refused with `config.schema_version_unrecognised`, never silently defaulted |
| 11 | A declared command that is the empty string | The gate is skipped and said to be skipped, not failed |
| 12 | `STEP_PHASES` | Carries `testing` alongside the existing four |
| 13 | The standard plan | Runs analysis → planning → implementation → testing → verification |
| 14 | A registered `step.testing` and `step.verification` | Both resolve, export to draft-7, and are distinct shapes |
| 15 | The roster | `testing` declares `step.testing`, `verification` declares `step.verification` |
| 16 | A verification step whose deterministic gates fail | **No model-based review is spawned at all** — asserted by the absence of the event, not by a counter |
| 17 | A verification step whose gates pass | Model-based review runs and judges against the acceptance criteria |
| 18 | The criteria a verification step judges against | Byte-identical to the ones the run was accepted with |
| 19 | A verification output introducing a criterion of its own | Refused: a step cannot invent what it is judged against |
| 20 | A gate that fails | The run's disposition routes per AD-35, and the failure names which gate and its exit status |
| 21 | The container wrapper | Places a command inside, not `claude -p`, with the flag set and mount allow-list unchanged |
| 22 | Story 1-5's AD-31 assertion suite | Still passes unchanged: no push credential inside the container |
| 23 | `verification`'s grant | Still no `Write` or `Edit`; the runner is not a way to write |
| 24 | `testing`'s purpose and `verification`'s purpose | Describe what they can now actually do |

## Code Map

| File | Change | Why |
|---|---|---|
| `src/contracts/testing.ts` | new | `step.testing`'s output: the tests written and their provenance. AD-2. |
| `src/contracts/verification.ts` | new | `step.verification`'s output: gate results, then the model judgement. Distinct from testing. |
| `src/contracts/installer.ts` | modify | `mechanics.commands` gains `typecheck`; `schema_version` consequence per AD-28. |
| `src/contracts/registry.ts` | modify | Register both ids. |
| `src/contracts/state.ts` | modify | `STEP_PHASES` gains `testing`. |
| `src/runner/index.ts` | new | The command-runner MCP server: the only unit that may start a container. |
| `src/runner/commands.ts` | new | The declared-command vocabulary and the refusal for anything outside it. |
| `src/container/wrapper.ts` | modify | Repointed at a command per ADR-001; image, flags, mounts and the AD-31 suite unchanged. |
| `src/engine/spawner.ts` | modify | `--mcp-config`, `--strict-mcp-config` and the runner in `--allowedTools` for a phase granted it. |
| `src/engine/reconciler.ts` | modify | The standard plan gains the testing step; the two tiers are sequenced. |
| `src/installer/interview.ts` | modify | The typecheck question; both declarations name their contracts; purposes corrected. |
| `tests/runner.command.test.ts` | new | Matrix 1–6, 11. |
| `tests/contracts.verification.test.ts` | new | Matrix 14, 17–19. |
| `tests/contracts.testing.test.ts` | new | Matrix 14, 15. |
| `tests/engine.gate-economics.test.ts` | new | Matrix 16, 20 — the absence of the review spawn. |
| `tests/container.wrapper.test.ts` | modify | Matrix 21, 22. |

## Tasks & Acceptance

1. **Build the command-runner as a capability.**
   - **Given** a profile declaring its commands, **when** the runner is asked for one by name, **then** it
     runs that command in a container and returns its exit status with output as an evidence pointer.
   - **Given** a request for a command the profile does not declare, **when** the runner receives it,
     **then** it is refused naming the declared commands and nothing is executed.
   - **Given** the engine's source, **when** it is inspected, **then** no unit other than the runner starts a
     container.
2. **Wire the runner into a spawn.**
   - **Given** a phase granted the runner, **when** its argv is built, **then** it carries `--mcp-config`,
     `--strict-mcp-config` and the tool named in `--allowedTools`.
   - **Given** a spawn whose `--allowedTools` omits the runner, **when** it is built, **then** it fails
     visibly rather than producing a step that waits for an answer nobody can give.
3. **Give the profile the gate CAP-13 names.**
   - **Given** `mechanics.commands`, **when** it is read, **then** it carries `typecheck`.
   - **Given** a profile written before `typecheck` existed, **when** it is read, **then** it is refused with
     `config.schema_version_unrecognised`.
   - **Given** a declared command that is empty, **when** the gate runs, **then** it is skipped and said to
     be skipped.
4. **Give testing and verification their phases and contracts.**
   - **Given** `STEP_PHASES`, **when** it is read, **then** it carries `testing`, and the standard plan runs
     the five steps in order.
   - **Given** the roster, **when** each declaration is read, **then** `testing` names `step.testing` and
     `verification` names `step.verification`.
5. **Make the gate economics observable.**
   - **Given** a verification step whose deterministic gates fail, **when** the pass completes, **then** no
     model-based review was spawned, asserted by the absence of the spawn event.
   - **Given** gates that pass, **when** verification continues, **then** the model judgement runs against
     the acceptance criteria.
6. **Fix the criteria to what the run was accepted with.**
   - **Given** a verification step, **when** it judges, **then** the criteria are byte-identical to the ones
     the run was accepted with.
   - **Given** an output introducing a criterion of its own, **when** it is parsed, **then** it is refused.
7. **Repoint the container wrapper without rebuilding it.**
   - **Given** the wrapper, **when** it wraps a step's work, **then** a command is placed inside rather than
     `claude -p`, and the flag set, image and mount allow-list are unchanged.
   - **Given** story 1-5's AD-31 suite, **when** it runs, **then** it passes unchanged.

## Spec Change Log

## Review Triage Log

## Design Notes

## Verification

## Auto Run Result
