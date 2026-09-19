---
id: SPEC-agent-orchestrator
companions:
  - ../../planning-artifacts/architecture/architecture-agent-orcastrator-2026-09-19/ARCHITECTURE-SPINE.md
  - architecture.md
  - interface-contract.md
  - memory-design.md
  - build-sequencing.md
  - glossary.md
  - ../../brainstorming/brainstorm-agent-orchestration-system-2026-09-19/threat-model.md
sources:
  - ../../brainstorming/compendium.html
---

> **Canonical contract.** This SPEC and the files in `companions:` are the complete, preservation-validated contract for what to build, test, and validate. Source documents listed in frontmatter are for traceability — consult them only if you need narrative rationale or prose color this contract intentionally omits.

# Agent Orchestration System

## Why

A vision to realize. Deep builds multiple separate products and wants one system to build them with: he describes a feature in his terminal, and a fleet of agents plans, executes, verifies and commits it while he does something else. The force behind it is leverage — not automating a single repo, but owning a factory floor that generalizes across every product he starts. This is a personal tool for a single developer, which makes two things load-bearing that a team tool could treat as secondary: his attention is the scarcest resource in the system, and the system must not become a product that consumes the time it was built to free. Every trade-off below resolves against those two facts.

## Capabilities

- **CAP-1** — single conversational entry point
  - **intent:** User describes a feature to one agent (the Interviewer) and never addresses any other component to get it built.
  - **success:** A feature request typed in one terminal session reaches a merged branch with zero user interaction with any component other than the Interviewer.

- **CAP-2** — spec echo
  - **intent:** The system restates a request as acceptance criteria and gets confirmation before work begins.
  - **success:** No feature enters execution without a user-confirmed criteria list; editing any criterion line amends the contract without re-prompting from scratch.

- **CAP-3** — question compression
  - **intent:** Subagent questions are answered from the repository, history and decision ledger, or merged, before any reach the user.
  - **success:** Deflection rate is reported per feature; median user-facing questions per feature is at most one across a 20-feature sample.

- **CAP-4** — default-on-timeout
  - **intent:** Every user-facing question declares what the system will do if it is ignored, so non-response is a valid input.
  - **success:** Every question renders a stated default and window; ignoring it causes that default to be taken and logged as a decision.

- **CAP-5** — mode visibility and disengage
  - **intent:** The user can always tell which autonomy mode the system is in, and stop it with one gesture.
  - **success:** Current mode is present in the prompt line at all times; one interrupt halts all agents leaving resumable state on disk.

- **CAP-6** — deterministic orchestration engine
  - **intent:** A feature's execution is reproducible, and any single step can be re-run in isolation without replaying the run.
  - **success:** A recorded run replays to an identical step sequence from its inputs, and any single step is re-runnable in isolation from its input file.

- **CAP-7** — capability-scoped tool access
  - **intent:** Each external domain is reachable by exactly one agent, enforced by where its credential lives rather than by instruction.
  - **success:** A non-owning agent attempting that domain's API fails for absence of credential; verified by test.

- **CAP-8** — git as the message bus
  - **intent:** The complete record of what agents did to a feature is recoverable from the repository itself, without a separate datastore.
  - **success:** A feature's full agent timeline is reconstructable from `git log` and notes alone, with no other datastore present.

- **CAP-9** — control and evidence plane separation
  - **intent:** Orchestrator context stays bounded however much evidence a run produces, while all of that evidence remains retrievable.
  - **success:** Orchestrator context for a feature stays within a declared token ceiling regardless of evidence volume; any evidence artifact is retrievable on demand.

- **CAP-10** — tiered isolation
  - **intent:** Each feature runs in the weakest isolation its risk classification allows — in place, on a branch, or in a worktree with a container.
  - **success:** All three tiers are selectable and exercised; the container tier's executor has no push credential, verified by test.

- **CAP-11** — ephemeral pooled resources
  - **intent:** A feature that needs a database or cache gets one quickly and leaves no residue behind it.
  - **success:** A feature requiring postgres receives a ready instance within a declared time bound; on completion the instance is returned and verified empty.

- **CAP-12** — reversibility-tiered autonomy
  - **intent:** Actions proceed unattended or require approval based on blast radius, not on a global trust setting.
  - **success:** Every action type carries a declared reversibility class; reversible actions proceed unattended and irreversible ones block, demonstrably.

- **CAP-13** — test-first verification
  - **intent:** Implementation is judged against criteria fixed before it was written, and something actively tries to break the result.
  - **success:** Deterministic gates (typecheck, lint, tests) run before any model-based review, and no review spend occurs on a run that fails them.

- **CAP-14** — one event stream, two renderers
  - **intent:** The user can watch a run from the terminal or a local web app, with neither surface authoritative over the other.
  - **success:** Both surfaces render the same historical run identically; closing either loses no data.

- **CAP-15** — steerable observability
  - **intent:** The user can pause, inject a note into, kill, or fork a running agent from the timeline.
  - **success:** Each of the four controls demonstrably affects a live run.

- **CAP-16** — cost governance
  - **intent:** Each feature runs under declared ceilings and degrades or stops rather than overrunning silently.
  - **success:** A feature exceeding its step, wall-clock or rate-limit-budget ceiling halts and notifies instead of continuing; consumption is visible without issuing a command.

- **CAP-17** — memory consolidation
  - **intent:** Knowledge from completed features becomes available to later features without inflating any run's context.
  - **success:** A consolidation pass converts a completed feature's episodic log into structured facts; retrieval for a later feature respects a declared per-feature read budget.

- **CAP-18** — decision ledger
  - **intent:** An answer the user gives once becomes a durable rule that later agents check before asking again.
  - **success:** The same question arising on a second feature resolves from the ledger without reaching the user.

- **CAP-19** — cross-repo pattern memory
  - **intent:** A pattern learned building one product is available when building another.
  - **success:** A pattern recorded in project A is retrievable and applied in project B, with no code snippets stored.

- **CAP-20** — universal engine, per-repo profile
  - **intent:** A new repository is onboarded by generating a profile describing its stack, commands and conventions, without changing engine code.
  - **success:** A bootstrap run produces a profile for an unseen repository, and a feature completes there with no engine modification.

- **CAP-21** — shadow mode
  - **intent:** The system runs against an already-built feature and compares its output to what was actually committed.
  - **success:** A comparison report is produced for a historical feature with no write to the repository.

- **CAP-22** — morning brief and ambient status
  - **intent:** The user sees the state of every in-flight feature at a glance, without issuing a command or reading prose.
  - **success:** All in-flight features and what each needs fit one screen without scrolling.

- **CAP-23** — escape hatch and handoff
  - **intent:** The user can take manual control at any point, and a stuck system stops and explains itself rather than thrashing.
  - **success:** One command produces an ordinary branch holding partial work and halts all agents; repeated failure produces a handoff document and a stop.

## Constraints

- Terminal-complete: every action is answerable from the terminal. The web app is strictly optional and never required to proceed.
- Built on existing Claude Code primitives — subagents, hooks, MCP, worktrees — as configuration plus small scripts. No bespoke agent framework. Maintenance burden is the identified likeliest cause of project failure.
- Executor sandboxes hold no push and no production credentials. Only a gated committer may push. Force-push is never permitted. Protected branches are enforced independently of agent behaviour.
- Secrets never enter model context: injected as environment into the owning tool-server container only, with output redaction before any logging or posting.
- Cost is governed as subscription usage, not currency. There is no per-token billing to optimize and no dollar ceiling; ceilings are expressed in steps, wall-clock time and consumed rate-limit budget.
- An interruption costs roughly fifteen minutes of user focus while model usage is prepaid by subscription. Spending model calls to avoid an interruption therefore carries no marginal currency cost, and this asymmetry governs every cost-versus-clarity trade-off.
- Commits and pull requests are authored under the user's own git identity. There is no bot identity. The committer opens a pull request by default rather than pushing to a shared branch.
- Memory stores questions, their durable answers, and pointers to stable anchors. Never code snippets. Line numbers are never valid anchors.
- Cross-repo memory stores abstract patterns only.
- No feature runs unattended without the minimum guardrail set defined in `threat-model.md`.
- Every user-facing question carries a recommended default and at most three concrete options plus an escape.
- Silence means success: notify only on exception, decision point, or completion.
- Only verified and merged outcomes write to long-term memory; failed experiments write to episodic memory only.
- Agents never author their own telemetry; the runtime records what they did.
- Model assignment is a ladder with promotion on verification failure, not a fixed per-agent assignment.
- Build order follows `build-sequencing.md`. Shadow mode must demonstrate measured accuracy before any autonomy tier is unlocked.

## Non-goals

- Not a general-purpose multi-agent framework for third parties to adopt.
- No web dashboard as the primary or required interface.
- No autonomous production deployment; canary watching and auto-revert are out of this contract.
- Not a replacement for user review on irreversible or high-blast-radius changes.
- No direct agent-to-agent messaging; coordination is via the engine, the worktree and the event log.
- Minimal subagent token output is explicitly not a goal in itself, having been identified as a false economy.
- No support for repositories the user cannot grant local git and container access to.
- No multi-tenant or shared-instance operation. Additional people run independent instances; there is no shared server, shared state or cross-user memory.

## Success signal

Deep describes a feature in his terminal, leaves to do something else, and returns to a merged branch he trusts enough to skim rather than audit — with the run's cost, timeline and verification evidence reconstructable from git alone. Measured two ways: at least 60% of features complete with zero mid-flight interruptions, and his shipping velocity on actual products rises rather than the orchestrator absorbing the time it was built to free.

## Assumptions

- Single user per instance, local-first. Additional people run their own independent instance with their own credentials and their own memory.
- Claude Code is the runtime and the model family is Claude.
- Jira is the first external tool domain; further domains follow the same tool-server pattern.
- Target projects are git repositories whose test and lint commands the per-repo profile can name.
- macOS is the primary development platform.
