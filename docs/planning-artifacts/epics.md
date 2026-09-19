---
stepsCompleted: ["step-01-validate-prerequisites", "step-02-design-epics", "step-03-create-stories", "step-04-final-validation"]
inputDocuments:
  - docs/specs/spec-agent-orchestrator/SPEC.md
  - docs/specs/spec-agent-orchestrator/architecture.md
  - docs/specs/spec-agent-orchestrator/interface-contract.md
  - docs/specs/spec-agent-orchestrator/memory-design.md
  - docs/specs/spec-agent-orchestrator/build-sequencing.md
  - docs/specs/spec-agent-orchestrator/glossary.md
  - docs/planning-artifacts/architecture/architecture-agent-orcastrator-2026-09-19/ARCHITECTURE-SPINE.md
  - docs/brainstorming/brainstorm-agent-orchestration-system-2026-09-19/threat-model.md
consultedNotSourced:
  - docs/planning-artifacts/architecture/architecture-agent-orcastrator-2026-09-19/reviews/review-adversarial.md
  - docs/planning-artifacts/architecture/architecture-agent-orcastrator-2026-09-19/reviews/review-tech-verification.md
  - docs/planning-artifacts/architecture/architecture-agent-orcastrator-2026-09-19/reviews/review-reconcile-spec.md
  - docs/planning-artifacts/architecture/architecture-agent-orcastrator-2026-09-19/reviews/review-rubric.md
scope: All five build-sequencing stages (CAP-1 through CAP-23)
---

# agent-orcastrator - Epic Breakdown

## Overview

This document provides the complete epic and story breakdown for agent-orcastrator, decomposing the requirements from the SPEC (used in place of a PRD), the Interface Contract (used as the UX design contract), and the Architecture Spine into implementable stories.

**Note on inputs.** This project has no PRD. Its requirement contract is `SPEC.md` plus its companions, declared canonical in the SPEC's own frontmatter. Capability ids `CAP-1`…`CAP-23` are the functional requirement source; SPEC *Constraints* are the non-functional requirement source; `ARCHITECTURE-SPINE.md` decisions `AD-1`…`AD-35` and `threat-model.md` §5 are the additional requirements; `interface-contract.md` is the UX design contract. Every requirement below carries its source id for traceability.

## Requirements Inventory

### Functional Requirements

**Conversation and intake (CAP-1, CAP-2)**

FR1: The Interviewer is the only component the user converses with; no other component exposes a conversational surface. (CAP-1)
FR2: A feature request typed in a single terminal session drives the run through to a merged branch with zero user interaction with any component other than the Interviewer. (CAP-1)
FR3: Before any execution begins, the system restates the request as an explicit acceptance-criteria list and presents it for confirmation. (CAP-2)
FR4: The acceptance-criteria list is editable line by line; amending any criterion updates the contract without re-prompting the request from scratch. (CAP-2)
FR5: Confirmation of the criteria list is a single keystroke. (CAP-2, v0-10)
FR6: No feature enters execution without a user-confirmed criteria list. (CAP-2)

**Question compression and resolution (CAP-3, CAP-4, CAP-18)**

FR7: Every candidate question is attempted against the repository, git history and the decision ledger before it may reach the user. (CAP-3, Q4)
FR8: Unresolved questions arising close together are merged into a single user-facing question before surfacing. (CAP-3, Q8)
FR9: Deflection rate is computed and reported per feature. (CAP-3, Q4)
FR10: Median user-facing questions per feature is at most one, measured across a 20-feature sample. (CAP-3)
FR11: Every user-facing question declares a recommended default and the window before that default is taken. (CAP-4, Q1, Q2)
FR12: When a question's window expires, the declared default is applied automatically and recorded as a decision. (CAP-4)
FR13: A question is a typed contract object with one state machine; exactly one transition from `asked` to `resolved` is accepted, decided by compare-and-set. (AD-25, CAP-4)
FR14: Losing resolvers (TUI, web, timeout) receive an already-resolved result and write nothing. (AD-25)
FR15: Only a resolved question writes an entry to the decision ledger. (CAP-18, AD-25)
FR16: The same question arising on a second feature resolves from the ledger without reaching the user. (CAP-18, Q7)

**Mode, control and disengage (CAP-5, CAP-15, CAP-23)**

FR17: The current autonomy mode is present in the prompt line at all times. (CAP-5)
FR18: A single interrupt gesture halts all agents and leaves resumable state on disk. (CAP-5)
FR19: Pause, inject-note, kill and fork controls each demonstrably affect a live run. (CAP-15)
FR20: Every steering command is a durable intent file under `runs/<run-id>/commands/` recording its principal. (AD-19, CAP-15)
FR21: Every steering control remains available through the file path with the web server down. (AD-19, CAP-14)
FR22: One command dumps all in-flight work to an ordinary git branch and detaches the system entirely. (CAP-23, v0-7)
FR23: Repeated failure produces a handoff document and a stop, rather than retry-thrash. (CAP-23, v0-15)
FR24: A step terminated by a user steering command records the disposition `killed` and is never resumed or re-run by the reconciler. (AD-8, CAP-15)

**Orchestration engine (CAP-6)**

FR25: A run executes as a sequence of discrete steps identified by stable declared names, never positional indexes. (CAP-6)
FR26: A recorded run replays to an identical step sequence from its inputs. (CAP-6)
FR27: Any single step is re-runnable in isolation from its typed input file. (CAP-6)
FR28: Every step records a `baseline_ref` — the exact worktree commit at the instant the step began — and a re-run first resets the worktree to it. (AD-26, CAP-6)
FR29: The engine spawns exactly one `claude -p` subprocess per step and re-parses its `structured_output` against the originating Zod schema before accepting the output. (AD-1, CAP-6)
FR30: Every step termination records a disposition; only `interrupted` is resumable, attempted first by `claude -p --resume` with the recorded session id and falling back to a baseline-reset re-run. (AD-8)
FR31: Killing the engine at any instant and restarting it produces behaviour identical to never having stopped. (AD-7, CAP-6)
FR32: Features declare their file territory before execution; the engine serializes only features whose territories overlap. (Threat 4, arch.md)
FR33: Every step input carries the original feature request verbatim; no step reads a summary of a summary. (v0-11, arch.md re-grounding, Threat 1)
FR34: A cheap sanity check validates each artifact against the original request before it flows to the next step. (Threat 1, §3.5 immune checkpoint)

**Capability-scoped tool access (CAP-7)**

FR35: Each external domain runs as exactly one MCP server holding that domain's credential and no other. (CAP-7, AD-13)
FR36: A non-owning agent attempting that domain's API fails for absence of credential, verified by an automated test. (CAP-7)
FR37: The engine passes `--strict-mcp-config` and `--restricted` on every spawn, so the target repository's own `.mcp.json` and hooks cannot introduce tools or credentials. (AD-1, CAP-7)
FR38: Agents may explore a domain freely by reading; the runtime records every request and response, post-redaction, to the event log and the run shared fetch record. (AD-13)
FR39: A fetch recorded by any step is served from the record to every later step of the same run; within one run an external record has exactly one value. (AD-14)
FR40: On re-run, the fetch record is served first and the domain is contacted only for a request not already recorded. (AD-13)

**Git as the message bus (CAP-8)**

FR41: Each step commits its output into the feature worktree; `git log` is the timeline. (CAP-8, arch.md)
FR42: The committer writes a git note on the merge commit under a single named ref, carrying the run id, the ordered step list with dispositions, the acceptance criteria, usage totals and the decisions taken. (AD-22, CAP-8)
FR43: A feature's full agent timeline is reconstructable from `git log` and notes alone, with no other datastore present. (CAP-8)
FR44: The committer is the only unit that creates or names a branch; the pattern is declared once in the project profile, defaulting to `feature/<feature-slug>`. (AD-22)
FR45: The git-note shape is a versioned contract and the committer is its only writer. (AD-22)

**Plane separation (CAP-9)**

FR46: The control plane is the typed step input and output plus the state checkpoint, and it alone may enter model context. (CAP-9, AD-23)
FR47: The evidence plane — transcripts, diffs, fetch records, telemetry — is written to disk by the runtime and referenced by pointer. (CAP-9, AD-23)
FR48: A declared token ceiling bounds the control plane per run; exceeding it is a hard failure, never a degradation. (CAP-9, AD-23)
FR49: Any evidence artifact is retrievable on demand from its pointer. (CAP-9)

**Isolation and resources (CAP-10, CAP-11)**

FR50: Three isolation tiers are selectable and exercised — tier 0 in place, tier 1 branch, tier 2 worktree plus container — chosen by risk classification. (CAP-10)
FR51: One wrapper script owns every `docker` invocation; no other unit composes docker flags. (AD-20, v0-1)
FR52: The tier-2 executor has no push credential, verified by test. (CAP-10, v0-6)
FR53: A provisioning phase with network precedes execution; execution runs behind the egress allowlist proxy. (AD-20, v0-2)
FR54: A feature requiring postgres or redis receives a ready leased instance within a declared time bound. (CAP-11)
FR55: On completion the instance is returned to the pool, wiped, and verified empty. (CAP-11)
FR56: The only database credential injected is the leased, disposable one. (Threat §3.1)
FR57: Every resource, container and worktree is reclaimed by a reconcile pass, never by a process exit path. (AD-32, CAP-11)

**Autonomy and verification (CAP-12, CAP-13)**

FR58: Every action type carries a declared reversibility class — reversible, recoverable or irreversible. (CAP-12)
FR59: Reversible actions proceed unattended, recoverable actions notify post-hoc, irreversible actions block for explicit approval. (CAP-12, arch.md)
FR60: The write surface is enumerated — `git push`, pull request creation, git notes, tags, every MCP domain mutation — and is engine-executed; no agent performs any of them. (AD-15)
FR61: The engine executes each write intent exactly once against an idempotency key derived from run id plus intent id, with a durable `write.attempted` record written before the call. (AD-15)
FR62: The tester writes failing tests from the feature description before the implementation step runs. (CAP-13, Threat §3.5)
FR63: Deterministic gates — typecheck, lint, tests — run before any model-based review. (CAP-13, v0-12)
FR64: No model-based review spend occurs on a run that fails the deterministic gates. (CAP-13)
FR65: An adversarial tester runs against only the request and the diff, with no access to the executor's rationale. (Threat §3.5)

**Renderers (CAP-14, CAP-22)**

FR66: Both renderers render the same historical run identically from the event log; neither is authoritative. (CAP-14)
FR67: Closing either surface loses no data. (CAP-14)
FR68: Every steering control is a member of a single `Command` enum defined once in `contracts/`, so a control present in one renderer and absent from the other is a compile error. (AD-3, CAP-14)
FR69: The system is fully operable with the web renderer absent; the TUI alone is sufficient and no reply ever requires a browser. (AD-3, Constraint 1)
FR70: The web server binds loopback only and serves a single local user. (AD-3)
FR71: The morning brief shows all in-flight features, what each needs and what each cost, on one screen without scrolling. (CAP-22)
FR72: An ambient status segment renders current mode, consumed budget and step count in the shell or multiplexer when no TUI process is running. (CAP-22, CAP-5, R10)

**Cost governance (CAP-16)**

FR73: Every run carries three ceilings — step count, wall-clock and consumed rate-limit budget — and no currency dimension. (CAP-16, AD-24)
FR74: At eighty percent of any ceiling the run degrades by downshifting model tier and narrowing scope, emitting `budget.degraded`. (AD-24)
FR75: On reaching a ceiling the run hibernates, writing a handoff note and a terminal-pending disposition and emitting `budget.exhausted`, rather than dying mid-write or continuing. (AD-24, CAP-16)
FR76: Consumption is visible without issuing a command. (CAP-16, R10)
FR77: A step cap per agent terminates a looping agent, leaving its partial work as a marker. (Threat §3.4, v0-9)
FR78: Usage deviating materially from the historical baseline for its feature class raises an anomaly signal before any ceiling is reached. (Threat §3.4)
FR79: A dry run against a mock executor produces a plan plus estimated step and token counts before real capacity is consumed. (Threat §3.4)

**Memory (CAP-17, CAP-18, CAP-19)**

FR80: A run appends to a fast episodic log; long-term memory is never written during a run. (CAP-17, memory-design.md)
FR81: A consolidation pass between features or nightly compacts a completed feature's episodic log into durable structured facts, weighting failures above successes. (CAP-17)
FR82: Retrieval for a later feature respects a declared per-feature read budget. (CAP-17)
FR83: Memory is tiered — L1 per-repo profile always loaded, L2 per-directory notes on touching a region, L3 retrieval index on query under budget, disk on demand. (memory-design.md)
FR84: Every memory entry carries a decay policy chosen at write time — permanent, until-refactor, N-features, or session. (memory-design.md)
FR85: Retrieval hit-counts are tracked from the first entry written; entries promote toward L1 on repeated retrieval and are pruned when never retrieved. (memory-design.md)
FR86: The committer detects renames and rewrites memory anchors as part of the commit. (memory-design.md)
FR87: A periodic sweep samples entries, checks their anchors still resolve, and flags the dead. (memory-design.md, AD-16)
FR88: Wherever a remembered thing is checkable it becomes an artifact rather than a retrieval — a convention becomes a lint rule, a past failure becomes a regression test. (memory-design.md)
FR89: A pattern recorded in project A is retrievable and applied in project B. (CAP-19)
FR90: If the memory index is lost, at least ninety percent regenerates from git history plus the event log. (memory-design.md)
FR91: Retrieval token cost versus measured reduction in rework is reported; a non-positive number is grounds for removing the memory layer. (memory-design.md)

**Onboarding and profile (CAP-20)**

FR92: `npx github:<owner>/<repo> init` is the only supported way to onboard a project; it is interactive and writes only into `<target-repo>/.orch/` and `.gitignore`. (AD-12, CAP-20)
FR93: The installer asks the fixed thirteen-question interview and writes its answers to `<target-repo>/.orch/`. (build-sequencing.md)
FR94: The installer writes a `schema_version` and a manifest of every file it created, so a half-install is detectable and recoverable. (AD-12, AD-28)
FR95: Re-running the installer preserves answers already on disk and asks only what is missing. (AD-12)
FR96: The profile is authoritative for mechanics; the repository's own instructions are authoritative for code conventions; where both speak to the same point the repository wins and the profile entry is flagged stale. (AD-16)
FR97: Every agent, built-in or user-defined, is declared by one TOML file in `<target-repo>/.orch/agents/` referencing a registered contract id; the engine holds no compiled-in roster. (AD-17, CAP-20)
FR98: A feature completes in a newly onboarded, previously unseen repository with no engine code modification. (CAP-20)
FR99: A bootstrap agent produces a per-repo profile for an unseen repository automatically. (CAP-20, stage 5)
FR100: A project is identified by the SHA of its first commit; the filesystem path is a mutable pointer updated on mismatch. (AD-10)
FR101: An unresolvable project path marks the registration `unlocated`; central state is deleted only by an explicit prune naming a `project-id`. (AD-33)
FR102: Re-registering a moved repository reattaches its existing history by first-commit SHA rather than creating a second project. (AD-33)

**Shadow mode and trust (CAP-21)**

FR103: A shadow run is an ordinary run carrying `mode: shadow`; only the intent executor and the committer honour it, recording every write intent and executing none. (AD-27, CAP-21)
FR104: A comparison report is produced for an already-built historical feature with no write to the repository. (CAP-21)
FR105: A trust record holds per-area history of merged-unchanged versus corrected outcomes and is the input to the autonomy-unlock decision. (interface-contract.md, stage-4 gate)
FR106: Autonomy is unlocked per risk tier only after shadow mode shows measured accuracy against the stage-3 gate. (build-sequencing.md, v0-17)

### NonFunctional Requirements

NFR1: **Terminal-complete.** Every action is answerable from the terminal. The web app is strictly optional and never required to proceed. (Constraint)
NFR2: **No bespoke framework.** Built on existing Claude Code primitives — subagents, hooks, MCP, worktrees — as configuration plus small scripts. Maintenance burden is the identified likeliest cause of project failure. (Constraint, Threat §4)
NFR3: **Credential separation.** Executor sandboxes hold no push and no production credentials. Only a gated committer may push. Force-push is never permitted. Protected branches are enforced independently of agent behaviour. (Constraint, v0-5, v0-6)
NFR4: **Secrets never enter model context.** Credentials are injected as environment into the owning tool-server container only, with output redaction before any logging or posting. Redaction fails closed. (Constraint, AD-21, v0-3, v0-4)
NFR5: **Subscription cost model.** Cost is governed as subscription usage, not currency. No per-token billing to optimize and no dollar ceiling; ceilings are steps, wall-clock time and consumed rate-limit budget. (Constraint)
NFR6: **The governing exchange rate.** An interruption costs roughly fifteen minutes of user focus while model usage is prepaid. Spending model calls to avoid an interruption carries no marginal currency cost, and this asymmetry resolves every cost-versus-clarity trade-off. Minimal subagent token output is explicitly not a goal. (Constraint, interface-contract.md, Non-goal)
NFR7: **User git identity.** Commits and pull requests are authored under the user's own git identity. There is no bot identity. The committer opens a pull request by default rather than pushing to a shared branch. (Constraint)
NFR8: **Memory content rules.** Memory stores questions, their durable answers, and pointers to stable anchors. Never code snippets. Anchors rank test names, then public API symbols, then module names, then file paths; line numbers are never valid anchors. Nothing is stored that `git log` or `git blame` can answer. (Constraint, memory-design.md)
NFR9: **Cross-repo memory stores abstract patterns only.** No concrete specifics. (Constraint)
NFR10: **Guardrail precondition.** No feature runs unattended without the complete minimum guardrail set of `threat-model.md` §5, each item exercised at least once on purpose, plus one chaos drill. (Constraint)
NFR11: **Question shape.** Every user-facing question carries a recommended default and at most three concrete options plus an escape. Never open-ended. (Constraint, Q1)
NFR12: **Silence means success.** Notify only on exception, decision point, or completion. (Constraint, R1)
NFR13: **Memory write discipline.** Only verified and merged outcomes write to long-term memory; failed experiments write to episodic memory only. This is the primary defence against memory poisoning. (Constraint)
NFR14: **Telemetry ownership.** Agents never author their own telemetry; the runtime records what they did. (Constraint)
NFR15: **Model ladder.** Model assignment is a ladder with promotion on verification failure, never a fixed per-agent assignment. Rungs are `claude-haiku-4-5` → `claude-sonnet-5` → `claude-opus-5`, one promotion per step per run. (Constraint, Stack)
NFR16: **Build order.** Build order follows `build-sequencing.md`. Shadow mode must demonstrate measured accuracy before any autonomy tier is unlocked. Stage gates are binding. (Constraint)
NFR17: **Single user, local-first.** One user per instance. No multi-tenant or shared-instance operation, no shared server, no shared state, no cross-user memory. macOS is the primary platform. (Assumptions, Non-goals)
NFR18: **Determinism.** Model version ids are pinned, never a floating alias; temperature is zero outside explicitly creative steps; full inputs are recorded so any run is replayable. (Threat §3.5, v0-13)
NFR19: **Stack pins.** Node `>=22.22` (24.x LTS recommended); TypeScript 5.9.3; React and react-dom 19.3.0; Vite 8.3.0; Vitest 5.0.1; typescript-eslint 8.70.0; Zod 4.6.5; Ink 7.1.1; `claude` CLI `>=2.1.259`; Docker Engine `>=29.7`; npm `<12`. (Stack)
NFR20: **Success signal.** At least 60% of features complete with zero mid-flight interruptions, and shipping velocity on actual products rises rather than the orchestrator absorbing the time it was built to free. (Success signal)
NFR21: **Stop-building tripwires.** Two consecutive weeks on the orchestrator with no feature shipped through it; a stage gate slipping twice; shadow accuracy flat or falling; any component requiring a bespoke abstraction Claude Code primitives cannot express; orchestrator time exceeding product time across a calendar month — each is a signal to stop extending. (build-sequencing.md)
NFR22: **Boring, inspectable state.** Files and git, event-sourced and append-only. Everything diagnosable with `git log` and `cat`. Anything requiring reasoning about distributed consensus to debug is a defect. (Threat §3.6, §3.7)
NFR23: **One language, one package.** Engine, TUI, web control surface and installer live in one TypeScript package on Node. No second implementation language is introduced for any unit. No unit links the Claude Agent SDK as a library. (AD-2, AD-1)
NFR24: **Verification floor.** The three AD-31 suites — contract round-trip, reconciler crash-injection, container assertion — are required before any unattended run. (AD-31)
NFR25: **Register.** Colleague, not butler and not robot. Warmth expressed through competence. Information density over friendliness. No anthropomorphic filler. (interface-contract.md)

### Additional Requirements

#### 🚨 Starter template / greenfield scaffold

**There is no external starter template.** The Architecture Spine's *Structural Seed* fixes the greenfield scaffold exactly, and Epic 1 Story 1 must create it verbatim:

```text
agent-orcastrator/
  bin/init.ts
  src/{installer,contracts,engine,runtime,container,tui,web,tools}/
  templates/
  tests/
  docker/Dockerfile
```

One TypeScript package on Node, with `.nvmrc` and a `package.json` `engines` field declaring the Node floor in one place. Directory-to-layer mapping is one-to-one and the dependency direction is a DAG: `contracts` depends on nothing; `engine → contracts, runtime, steps`; `steps → contracts, tools`; renderers and installer depend on `contracts` only. No renderer, step subprocess, tool server or installer may import the engine.

#### Architecture decisions binding implementation

AR-1: Step agents are `claude -p` subprocesses, never the in-process Agent SDK; spawn passes `--json-schema`, `--output-format stream-json`, `--strict-mcp-config` and `--restricted`. Bare mode is forbidden positively — the engine asserts subscription auth at startup and refuses to run in API-key mode. (AD-1)
AR-2: Every step contract is a Zod v4 schema in code, exported as `z.toJSONSchema(schema, { target: "draft-7" })`. The `target` argument is part of the rule. Step contracts stay in the structured-outputs subset: no `z.date()`, no recursive schemas, no `minLength`, no `minItems > 1`, no `minimum`. (AD-2)
AR-3: `events.jsonl` is the sole durable truth; `state.json` is a rebuildable checkpoint derived from it. Where they disagree the log wins and the checkpoint is discarded and rebuilt. Any index or database is a derived projection reconstructable by replay. (AD-4)
AR-4: Every event line carries `ts`, `seq`, `feature`, `run`, `step`, `emitter`, `type`, `payload`; `ts` is RFC3339 with milliseconds and `seq` is monotonic per file; `parent_tool_use_id` and `session_id` are preserved verbatim from the `claude -p` stream; readers ignore unknown types rather than error. (AD-5)
AR-5: The engine is a reconciler over on-disk state holding no authoritative run state in memory — read checkpoint, take at most one action, write checkpoint. (AD-7)
AR-6: Config lives in-repo at `<target-repo>/.orch/`; all runtime state lives centrally under `ORCH_HOME` (default `~/.orch`). A config snapshot is taken once at run start into `runs/<run-id>/config/` and is the only configuration any step of that run reads. A prune command removes central state orphaned by a deleted project. (AD-9)
AR-7: The executor container image is built locally from `docker/Dockerfile`, tagged with that Dockerfile's content hash, rebuilt only when the hash changes, never pulled from a registry. The image build is the only step permitted network access outside the egress allowlist. (AD-11)
AR-8: Container hardening, owned by one wrapper: read-only root filesystem, tmpfs for temp, only the run worktree and its session directory mounted (never `HOME`, `.ssh` or cloud credential paths), non-root user, `--cap-drop=ALL`, `no-new-privileges`, seccomp profile, memory and pid limits. `--rm` is not used while a run is live, because it would destroy the session transcript AD-8 resume depends on. Branch protection on the default branch is asserted at run start. (AD-20, v0-1)
AR-9: Redaction runs on the producer→log boundary covering known token prefixes, high-entropy strings, env-file contents, private-key headers and the literal values of injected credentials. It fails closed, dropping the artifact and emitting `redaction.failed`. There is no after-the-fact remedy. (AD-21, v0-4)
AR-10: No BMad dependency: nothing under `<target-repo>/.orch/` and no runtime code path may require `_bmad`, a BMad skill or a BMad command. (AD-18)
AR-11: Every on-disk configuration and state artifact carries a `schema_version`; the engine refuses a version it does not recognise and states which installer version wrote it. Configuration and state get no ignore-unknown latitude. (AD-28)
AR-12: The Node floor is asserted at startup by both installer and engine, which fail fast naming the required version. The engine resolves the absolute path of a satisfying Node executable, passes that absolute path to every child process rather than relying on `PATH`, and records the resolved version in the run event log. (AD-28)
AR-13: Run ids are ULIDs minted solely by the engine. The runtime recorder is the single process that appends to a run's `events.jsonl` and the sole assigner of `seq`; every other producer, including MCP servers and step subprocesses, emits through it. Ordering is by `seq`; timestamps carry no cross-process ordering authority. (AD-29)
AR-14: The engine acquires an exclusive lock file under `ORCH_HOME` at startup, recording pid and start time, and exits with a clear message if it is held. A stale lock is reclaimed only after verifying the pid is gone. (AD-30)
AR-15: Configuration scopes are fixed and disjoint with no merging and no overriding: machine `ORCH_HOME/config.toml`; project `<target-repo>/.orch/`; run `runs/<run-id>/config/`; cross-project memory `ORCH_HOME/memory/`. A value is declared in exactly one scope. (AD-34)
AR-16: The error shape is `code`, `message`, `retryable`, `cause`, accompanied in `contracts/` by a disposition table mapping every code to exactly one of retry-with-backoff, escalate-model-tier, escalate-to-human, or abandon-and-hand-off. An unknown code is abandon-and-hand-off and is never retried. (AD-35)
AR-17: Event type names are dot-namespaced and past-tense. The vocabulary includes `step.started`, `agent.tool_used`, `fetch.recorded`, `write.attempted`, `write.executed`, `permission.denied`, `redaction.failed`, `budget.degraded`, `budget.exhausted`, `question.asked`, `question.resolved`, `question.default_taken`, `question.deflected`, `model.promoted`. Feature slugs are kebab-case. (Conventions)
AR-18: One writer per file. Only the reconciler writes a `state.json`, only the runtime recorder appends to an `events.jsonl`, only the committer writes the git note. State writes are atomic: temp file in the same directory, then rename. No unit writes diagnostics to stdout; everything observable goes to the event log. Human-edited config is TOML; machine-owned state and events are JSON. (Conventions)
AR-19: Distribution revisit condition: before npm 12 becomes the bundled npm of a supported Node line, the `npx`-from-git path must be re-verified empirically. Pre-decided fallback is `git clone` plus `npm run init --target`. (AD-12, Deferred)
AR-20: Deferred with stated triggers, not to be built early: a SQLite query index (build when a shadow-mode or trust-record query exceeds two seconds scanning JSONL, or one project passes ~200 runs); TypeScript 7 adoption (adopt when typescript-eslint publishes a peer range including 7.x). (Deferred)

#### v0 minimum guardrail set — the unattended-run gate

Nothing runs unattended until all seventeen exist and each has been exercised once on purpose, plus one chaos drill (kill an agent mid-run; confirm clean halt, intact event log, working escape hatch):

AR-21: (1) hardened container wrapper with docker-socket-absent startup assertion; (2) network off during execution or egress-allowlist-only; (3) zero secrets in any agent context; (4) redaction on every path to durable storage, failing closed; (5) protected `main` server-side; (6) executor has no push credential plus a git wrapper rejecting every force-push variant; (7) escape hatch written and tested; (8) per-feature ceiling with hibernation, enforced by the harness; (9) wall-clock cap per feature and step cap per agent; (10) spec echo before any code; (11) re-grounding enforced in every agent prompt; (12) gate 1 before gate 2; (13) pinned model versions and temperature zero; (14) append-only crash-surviving event log with resumable runs; (15) playing dead — halt and write a handoff document; (16) exceptions-only notifications; (17) phase-1 autonomy only until shadow mode measures. (threat-model.md §5)

#### Stage gates from build-sequencing.md

AR-22: **Stage 1 gate** — a run is fully reconstructable from git and the event log alone, and the executor container is verified to hold no push credential.
AR-23: **Stage 2 gate** — a real feature completes end to end, with the user reviewing and merging a pull request authored under their own identity.
AR-24: **Stage 3 gate** — over a rolling window of at least twenty shadow runs in one project, at least 80% produce a diff accepted without material change, and zero produce a write intent that would have been destructive. The destructive count is a hard gate, not a percentage.
AR-25: **Stage 4 gate** — the minimum guardrail set in `threat-model.md` is complete and tested.
AR-26: **Stage 5** — memory layer, decision ledger, cross-repo pattern memory, bootstrap agent, tool domains beyond Jira. The decision ledger may be pulled forward alone if interruption counts become painful.

#### Residual gaps carried from the architecture reviews

These review findings remain unanchored in the final spine and must be resolved during implementation rather than assumed:

AR-27: **Temperature is not pinned anywhere in the spine.** Model version ids are pinned via the Stack's three rungs, but `temperature: 0` outside explicitly creative steps (v0-13, Threat §3.5) has no home. Fix in the spawn contract. (review-reconcile-spec F-03)
AR-28: **Granted tools are declared twice** — in `permissions.toml` and in `agents/<id>.toml` — with no precedence rule. Pick one owner or declare precedence before the installer writes either. (review-reconcile-spec F-27)
AR-29: **Reversibility class is attached to the agent in AD-17, while CAP-12 requires it per action type.** The committer commits locally *and* pushes; one class per agent cannot express that. Resolve toward per-action classes with the agent TOML declaring a ceiling. (review-reconcile-spec F-04)
AR-30: **Feature→run resolution has no structure.** Everything durable is keyed by run id, while R6 forbids requiring the user to know a run id and CAP-22's morning brief queries "every in-flight feature across every machine-wide run" on every render. Decide the resolution path before the brief is built. (review-reconcile-spec F-25)
AR-31: **The gate-1-before-gate-2 ordering is a scheduling invariant no AD states.** AD-7 says the loop takes "at most one next action" without constraining which. (review-reconcile-spec F-18)
AR-32: **Empirical checks to run before locking the relevant contracts:** whether Claude Code strips or rejects unsupported schema keywords rather than failing at call time (decides whether Zod refinements are usable at all in step contracts); whether `npx github:<spec>` works under a real npm 12; whether a future `claude` release provides `--no-bare`. (review-tech-verification)

### UX Design Requirements

Source: `interface-contract.md`, which is this project's UX design contract. Surfaces are terminal-first; the web control surface mirrors them through the shared `Command` enum.

**Required surfaces**

UX-DR1: **Morning brief** — every in-flight feature on one screen without scrolling, each with what it needs and what it cost. Addressed by feature name. Renders as a fold over the event log. (CAP-22)
UX-DR2: **One-question card** — the question, its recommended answer, the consequence of each option, and the timeout default, in one self-contained card. At most three concrete options plus an escape. (Q1, Q2, Q3)
UX-DR3: **Spec echo card** — the acceptance criteria, editable line by line, confirmable in one keystroke. (CAP-2, v0-10)
UX-DR4: **Kill card** — usage and elapsed against estimate, with four actions: continue, narrow, kill, take over. (CAP-16, CAP-23)
UX-DR5: **Completion notice** — what merged, file count, test status, usage, and an explicit statement that nothing is needed. (R8)
UX-DR6: **Handoff document** — written when the system gives up; reads as a colleague's note, not a stack trace: what was tried, what failed, current state, suggested next step. (CAP-23, v0-15)
UX-DR7: **Ambient status line** — a single always-visible shell or multiplexer segment, never demanding. Must render when no TUI process is running, from its own read path into `ORCH_HOME`. (CAP-5, CAP-22, R10, R11)
UX-DR8: **Trust record** — per-area history of merged-unchanged versus corrected, used to justify autonomy tiers. Needs an owner, a location and a schema. (stage-4 gate)

**Question composition and delivery**

UX-DR9: Every question carries a recommended default and at most three concrete options plus an escape. Never open-ended. (Q1)
UX-DR10: Every question states what happens if it is ignored, and the window before that happens. (Q2)
UX-DR11: Every question carries a self-contained mini-brief, answerable without reloading the feature into the user's head. (Q3)
UX-DR12: Questions are answerable in the terminal; a browser is never required to reply. (Q5)
UX-DR13: Answers are free text and the system parses them; no format is imposed on the human. (Q6)
UX-DR14: Questions batch to natural boundaries; a do-not-disturb window queues rather than fires. (Q8)
UX-DR15: Never interrupt for anything unresolvable in ten seconds. (Q9)
UX-DR16: Never ask approval for a reversible action. (Q10)
UX-DR17: The active question occupies a persistent slot that does not scroll away. (R14)

**Reporting and notification**

UX-DR18: Silence means success — notify only on exception, decision point or completion; quiet hours are honoured and delivery is async by default. This is a notification channel distinct from the diagnostic event log. (R1, R13)
UX-DR19: One line by default, detail on request; never dump reasoning unprompted. (R2)
UX-DR20: Inverted pyramid — every message opens with a headline that stands alone; answer first, reasoning only if asked. (R3, R4)
UX-DR21: A stable, learnable grammar of message types, so the user pattern-matches rather than reads. (R5)
UX-DR22: Address everything by feature name; never require the user to know an agent name or a run id. (R6)
UX-DR23: Progress is the current step name and the next gate, never a percentage. (R7)
UX-DR24: Every completion states what was verified **and what was not**. (R8)
UX-DR25: Review requests point at the lines that need eyes and say why; never dump a diff. (R9)
UX-DR26: Consumed rate-limit budget and step count are always visible without issuing a command; cost is subscription usage, never currency. (R10)
UX-DR27: Elapsed-versus-estimate is always visible, so abandoning early is easy. (R11)
UX-DR28: Uncertainty is surfaced as uncertainty, never as a confident wrong answer. (R12)

**Mode, control and register**

UX-DR29: The current mode is displayed permanently in the prompt line. Mode confusion is the primary interface hazard of a system with autonomy tiers. (CAP-5)
UX-DR30: Standard callouts are emitted at every phase transition. (interface-contract.md)
UX-DR31: Disengagement is instant, obvious and always available via a single gesture that always means stop; the system is interruptible at every step, leaving clean resumable state. (CAP-5, CAP-23)
UX-DR32: `just-do-it` is a first-class command — stop asking, use judgment, review at the end. (interface-contract.md)
UX-DR33: Rejection is one keystroke plus a reason, and the reason becomes a ledger entry. (interface-contract.md, CAP-18)
UX-DR34: Register is colleague — not butler, not robot. Warmth through competence, information density over friendliness, no anthropomorphic filler. (interface-contract.md)
UX-DR35: Renderer parity is enforced mechanically: every steering control is a member of the single `Command` enum, so a control present in one renderer and absent from the other is a compile error. (AD-3)

### FR Coverage Map

Every FR maps to exactly one owning epic. All 106 FRs are covered with no gaps and no duplicates.

**Epic 4 — The Feature Pipeline - From Request to Pull Request**

FR1: Epic 4 - The Interviewer is the only component the user converses with; no other component...
FR2: Epic 4 - A feature request typed in a single terminal session drives the run through to a...
FR3: Epic 4 - Before any execution begins, the system restates the request as an explicit...
FR4: Epic 4 - The acceptance-criteria list is editable line by line; amending any criterion...
FR5: Epic 4 - Confirmation of the criteria list is a single keystroke
FR6: Epic 4 - No feature enters execution without a user-confirmed criteria list
FR7: Epic 4 - Every candidate question is attempted against the repository, git history and the...
FR8: Epic 4 - Unresolved questions arising close together are merged into a single user-facing...
FR9: Epic 4 - Deflection rate is computed and reported per feature
FR10: Epic 4 - Median user-facing questions per feature is at most one, measured across a...

**Epic 1 — Observable Runs in the Terminal**

FR11: Epic 1 - Every user-facing question declares a recommended default and the window before that...
FR12: Epic 1 - When a question's window expires, the declared default is applied automatically and...
FR13: Epic 1 - A question is a typed contract object with one state machine; exactly one transition...
FR14: Epic 1 - Losing resolvers (TUI, web, timeout) receive an already-resolved result and write...

**Epic 8 — Compounding - Memory, Ledger and Cross-Repo Patterns**

FR15: Epic 8 - Only a resolved question writes an entry to the decision ledger
FR16: Epic 8 - The same question arising on a second feature resolves from the ledger without...

**Epic 1 — Observable Runs in the Terminal**

FR17: Epic 1 - The current autonomy mode is present in the prompt line at all times
FR18: Epic 1 - A single interrupt gesture halts all agents and leaves resumable state on disk

**Epic 7 — Unattended Autonomy**

FR19: Epic 7 - Pause, inject-note, kill and fork controls each demonstrably affect a live run

**Epic 1 — Observable Runs in the Terminal**

FR20: Epic 1 - Every steering command is a durable intent file under runs/<run-id>/commands/...
FR21: Epic 1 - Every steering control remains available through the file path with the web server down
FR22: Epic 1 - One command dumps all in-flight work to an ordinary git branch and detaches the...
FR23: Epic 1 - Repeated failure produces a handoff document and a stop, rather than retry-thrash

**Epic 3 — The Engine - Deterministic, Resumable Step Execution**

FR24: Epic 3 - A step terminated by a user steering command records the disposition killed and is...
FR25: Epic 3 - A run executes as a sequence of discrete steps identified by stable declared names,...
FR26: Epic 3 - A recorded run replays to an identical step sequence from its inputs
FR27: Epic 3 - Any single step is re-runnable in isolation from its typed input file
FR28: Epic 3 - Every step records a baseline_ref — the exact worktree commit at the instant the...
FR29: Epic 3 - The engine spawns exactly one claude -p subprocess per step and re-parses its...
FR30: Epic 3 - Every step termination records a disposition; only interrupted is resumable,...
FR31: Epic 3 - Killing the engine at any instant and restarting it produces behaviour identical to...
FR32: Epic 3 - Features declare their file territory before execution; the engine serializes only...
FR33: Epic 3 - Every step input carries the original feature request verbatim; no step reads a...
FR34: Epic 3 - A cheap sanity check validates each artifact against the original request before it...

**Epic 4 — The Feature Pipeline - From Request to Pull Request**

FR35: Epic 4 - Each external domain runs as exactly one MCP server holding that domain's credential...
FR36: Epic 4 - A non-owning agent attempting that domain's API fails for absence of credential,...
FR37: Epic 4 - The engine passes --strict-mcp-config and --restricted on every spawn, so the target...
FR38: Epic 4 - Agents may explore a domain freely by reading; the runtime records every request and...
FR39: Epic 4 - A fetch recorded by any step is served from the record to every later step of the...
FR40: Epic 4 - On re-run, the fetch record is served first and the domain is contacted only for a...
FR41: Epic 4 - Each step commits its output into the feature worktree; git log is the timeline
FR42: Epic 4 - The committer writes a git note on the merge commit under a single named ref,...
FR43: Epic 4 - A feature's full agent timeline is reconstructable from git log and notes alone,...
FR44: Epic 4 - The committer is the only unit that creates or names a branch; the pattern is...
FR45: Epic 4 - The git-note shape is a versioned contract and the committer is its only writer

**Epic 3 — The Engine - Deterministic, Resumable Step Execution**

FR46: Epic 3 - The control plane is the typed step input and output plus the state checkpoint, and...
FR47: Epic 3 - The evidence plane — transcripts, diffs, fetch records, telemetry — is written to...
FR48: Epic 3 - A declared token ceiling bounds the control plane per run; exceeding it is a hard...
FR49: Epic 3 - Any evidence artifact is retrievable on demand from its pointer

**Epic 2 — Containment - Isolation Tiers and Leased Resources**

FR50: Epic 2 - Three isolation tiers are selectable and exercised — tier 0 in place, tier 1 branch,...
FR51: Epic 2 - One wrapper script owns every docker invocation; no other unit composes docker flags
FR52: Epic 2 - The tier-2 executor has no push credential, verified by test
FR53: Epic 2 - A provisioning phase with network precedes execution; execution runs behind the...
FR54: Epic 2 - A feature requiring postgres or redis receives a ready leased instance within a...
FR55: Epic 2 - On completion the instance is returned to the pool, wiped, and verified empty
FR56: Epic 2 - The only database credential injected is the leased, disposable one
FR57: Epic 2 - Every resource, container and worktree is reclaimed by a reconcile pass, never by a...

**Epic 4 — The Feature Pipeline - From Request to Pull Request**

FR58: Epic 4 - Every action type carries a declared reversibility class — reversible, recoverable...
FR59: Epic 4 - Reversible actions proceed unattended, recoverable actions notify post-hoc,...
FR60: Epic 4 - The write surface is enumerated — git push, pull request creation, git notes, tags,...
FR61: Epic 4 - The engine executes each write intent exactly once against an idempotency key...
FR62: Epic 4 - The tester writes failing tests from the feature description before the...
FR63: Epic 4 - Deterministic gates — typecheck, lint, tests — run before any model-based review
FR64: Epic 4 - No model-based review spend occurs on a run that fails the deterministic gates
FR65: Epic 4 - An adversarial tester runs against only the request and the diff, with no access to...

**Epic 6 — Web Control Surface, Shadow Mode and Measurement**

FR66: Epic 6 - Both renderers render the same historical run identically from the event log;...
FR67: Epic 6 - Closing either surface loses no data

**Epic 1 — Observable Runs in the Terminal**

FR68: Epic 1 - Every steering control is a member of a single Command enum defined once in...
FR69: Epic 1 - The system is fully operable with the web renderer absent; the TUI alone is...

**Epic 6 — Web Control Surface, Shadow Mode and Measurement**

FR70: Epic 6 - The web server binds loopback only and serves a single local user

**Epic 1 — Observable Runs in the Terminal**

FR71: Epic 1 - The morning brief shows all in-flight features, what each needs and what each cost,...
FR72: Epic 1 - An ambient status segment renders current mode, consumed budget and step count in...

**Epic 3 — The Engine - Deterministic, Resumable Step Execution**

FR73: Epic 3 - Every run carries three ceilings — step count, wall-clock and consumed rate-limit...
FR74: Epic 3 - At eighty percent of any ceiling the run degrades by downshifting model tier and...
FR75: Epic 3 - On reaching a ceiling the run hibernates, writing a handoff note and a...

**Epic 1 — Observable Runs in the Terminal**

FR76: Epic 1 - Consumption is visible without issuing a command

**Epic 3 — The Engine - Deterministic, Resumable Step Execution**

FR77: Epic 3 - A step cap per agent terminates a looping agent, leaving its partial work as a marker
FR78: Epic 3 - Usage deviating materially from the historical baseline for its feature class raises...
FR79: Epic 3 - A dry run against a mock executor produces a plan plus estimated step and token...

**Epic 8 — Compounding - Memory, Ledger and Cross-Repo Patterns**

FR80: Epic 8 - A run appends to a fast episodic log; long-term memory is never written during a run
FR81: Epic 8 - A consolidation pass between features or nightly compacts a completed feature's...
FR82: Epic 8 - Retrieval for a later feature respects a declared per-feature read budget
FR83: Epic 8 - Memory is tiered — L1 per-repo profile always loaded, L2 per-directory notes on...
FR84: Epic 8 - Every memory entry carries a decay policy chosen at write time — permanent,...
FR85: Epic 8 - Retrieval hit-counts are tracked from the first entry written; entries promote...
FR86: Epic 8 - The committer detects renames and rewrites memory anchors as part of the commit
FR87: Epic 8 - A periodic sweep samples entries, checks their anchors still resolve, and flags the dead
FR88: Epic 8 - Wherever a remembered thing is checkable it becomes an artifact rather than a...
FR89: Epic 8 - A pattern recorded in project A is retrievable and applied in project B
FR90: Epic 8 - If the memory index is lost, at least ninety percent regenerates from git history...
FR91: Epic 8 - Retrieval token cost versus measured reduction in rework is reported; a non-positive...

**Epic 5 — Onboarding Any Repository**

FR92: Epic 5 - npx github:<owner>/<repo> init is the only supported way to onboard a project; it is...
FR93: Epic 5 - The installer asks the fixed thirteen-question interview and writes its answers to...
FR94: Epic 5 - The installer writes a schema_version and a manifest of every file it created, so a...
FR95: Epic 5 - Re-running the installer preserves answers already on disk and asks only what is missing
FR96: Epic 5 - The profile is authoritative for mechanics; the repository's own instructions are...
FR97: Epic 5 - Every agent, built-in or user-defined, is declared by one TOML file in...
FR98: Epic 5 - A feature completes in a newly onboarded, previously unseen repository with no...

**Epic 8 — Compounding - Memory, Ledger and Cross-Repo Patterns**

FR99: Epic 8 - A bootstrap agent produces a per-repo profile for an unseen repository automatically

**Epic 5 — Onboarding Any Repository**

FR100: Epic 5 - A project is identified by the SHA of its first commit; the filesystem path is a...
FR101: Epic 5 - An unresolvable project path marks the registration unlocated; central state is...
FR102: Epic 5 - Re-registering a moved repository reattaches its existing history by first-commit...

**Epic 6 — Web Control Surface, Shadow Mode and Measurement**

FR103: Epic 6 - A shadow run is an ordinary run carrying mode: shadow; only the intent executor and...
FR104: Epic 6 - A comparison report is produced for an already-built historical feature with no...
FR105: Epic 6 - A trust record holds per-area history of merged-unchanged versus corrected outcomes...

**Epic 7 — Unattended Autonomy**

FR106: Epic 7 - Autonomy is unlocked per risk tier only after shadow mode shows measured accuracy...

## Epic List

Eight epics, aligned to the five binding stages of `build-sequencing.md`. Epic boundaries sit on the stage gates, because each gate is a genuine risk boundary where the outcome can change the direction of what follows.

### Epic 1: Observable Runs in the Terminal

*Stage 1a. Build-sequencing puts the interface first, because shadow mode has no autonomy and is therefore almost entirely an interface product.*

Deep can start a run, watch it unfold in the terminal, answer a question or ignore it and have the declared default taken, always see which autonomy mode the system is in, and stop everything with one gesture — and the whole run is reconstructable afterward from an immutable, redacted, crash-surviving log.

Carries the Structural Seed scaffold, the `contracts/` package (event envelope, error shape and disposition table, `Command` enum, question type, `schema_version`), the runtime recorder with fail-closed redaction and sole `seq` ownership, the question compare-and-set lifecycle with its timeout resolver, durable command intent files, the Ink TUI with the morning brief / one-question card / kill card / mode display, the escape hatch and handoff document, the exceptions-only notification channel, and the ambient status segment that renders with no TUI process running.

**FRs covered:** FR11, FR12, FR13, FR14, FR17, FR18, FR20, FR21, FR22, FR23, FR68, FR69, FR71, FR72, FR76
**Additional:** Structural Seed scaffold, AR-1–AR-6, AR-9, AR-11–AR-18, AR-20, NFR23, NFR24
**UX:** UX-DR1–UX-DR7, UX-DR9–UX-DR34
**Standalone:** renders recorded and synthetic runs; the reconciler does not arrive until Epic 3.

### Epic 2: Containment — Isolation Tiers and Leased Resources

*Stage 1b. "Containment is required from the start" — the sandbox is what makes everything else recoverable.*

Deep can run untrusted work inside a hardened sandbox and get a ready postgres or redis on request, with nothing reaching the host and nothing left behind. All three isolation tiers are selectable, and the tier-2 executor demonstrably holds no push credential.

Carries the single `docker` wrapper that owns every flag, the locally built content-hash-tagged image, the worktree lifecycle, the leased resource pool with wipe-and-verify-empty on return, the two-phase sandbox with the egress allowlist proxy, reclamation as a reconcile pass rather than a shutdown handler, and the container assertion test.

**FRs covered:** FR50, FR51, FR52, FR53, FR54, FR55, FR56, FR57
**Additional:** AR-7, AR-8, AR-21 items 1–2, NFR3
**Gate (Stage 1):** a run is fully reconstructable from git and the event log alone, and the executor container is verified to hold no push credential.

### Epic 3: The Engine — Deterministic, Resumable Step Execution

*Stage 2a.*

Deep can run a multi-step pipeline that survives being killed at any instant, resumes where it left off, re-runs any single step in isolation with identical effect, and halts cleanly at a declared ceiling instead of overrunning silently.

Carries the reconciler over on-disk state, the `claude -p` spawn baseline with its full flag set, `baseline_ref` step reset, dispositions and resume-by-session-id, the control/evidence plane split with its hard token ceiling, re-grounding against the verbatim request, the immune checkpoint, territory-based serialization, the three run ceilings with degradation and hibernation, the step cap, usage anomaly detection and the dry-run estimate.

**FRs covered:** FR24, FR25, FR26, FR27, FR28, FR29, FR30, FR31, FR32, FR33, FR34, FR46, FR47, FR48, FR49, FR73, FR74, FR75, FR77, FR78, FR79
**Additional:** AR-5, AR-16, AR-27, AR-31, NFR15, NFR18
**UX:** UX-DR23, UX-DR26, UX-DR27

### Epic 4: The Feature Pipeline — From Request to Pull Request

*Stage 2b.*

Deep describes a feature to the Interviewer, confirms the restated acceptance criteria in one keystroke, and gets a pull request authored under his own git identity with the full timeline recoverable from a git note.

Carries the Interviewer, spec echo, question compression against repository and git history, the complete agent roster (analysis, planning, implementation, testing, verification, committing), the Jira tool server with the run shared fetch record and capability-scoped credentials, the enumerated engine-executed write surface with idempotency keys, the gated committer with branch naming and the git-note contract, and test-first plus adversarial verification behind the two-tier gate.

**FRs covered:** FR1, FR2, FR3, FR4, FR5, FR6, FR7, FR8, FR9, FR10, FR35, FR36, FR37, FR38, FR39, FR40, FR41, FR42, FR43, FR44, FR45, FR58, FR59, FR60, FR61, FR62, FR63, FR64, FR65
**Additional:** AR-21 items 3, 10–12, AR-29, AR-31, AR-32, NFR7, NFR13
**UX:** UX-DR3, UX-DR5, UX-DR8, UX-DR24, UX-DR25
**Gate (Stage 2):** a real feature completes end to end, with the user reviewing and merging a pull request authored under their own identity.

### Epic 5: Onboarding Any Repository

*Stage 2c — CAP-20.*

Deep points `npx github:<owner>/<repo> init` at a repository the system has never seen, answers the interview, and ships a feature there with zero engine code changes. Moving or renaming that repository does not lose its history.

Carries `bin/init.ts` and the installer, the fixed thirteen-question interview, the `.orch/` scaffolding (`profile.toml`, `agents/*.toml`, `permissions.toml`, `manifest.toml`), project identity by first-commit SHA with registration and prune, declarative roster discovery, profile precedence against the repository's own instructions, and idempotent re-run that preserves existing answers.

**FRs covered:** FR92, FR93, FR94, FR95, FR96, FR97, FR98, FR100, FR101, FR102
**Additional:** AR-10, AR-11, AR-12, AR-19, AR-28, NFR2

### Epic 6: Web Control Surface, Shadow Mode and Measurement

*Stage 3.*

Deep can watch and steer a run from a browser without the terminal becoming secondary, and — more importantly — run the system against features he already built, to find out empirically whether it has earned trust.

Carries the loopback HTTP plus SSE control surface in React and Vite built against the shared `Command` enum, shadow mode as an ordinary run carrying `mode: shadow`, the comparison report, the trust record, and the measurement set: rework rate, deflection rate, interruption count and usage per feature.

**FRs covered:** FR66, FR67, FR70, FR103, FR104, FR105
**Additional:** AR-30, NFR1, NFR20
**UX:** UX-DR8, UX-DR35
**Gate (Stage 3):** over a rolling window of at least twenty shadow runs in one project, at least 80% produce a diff accepted without material change, and **zero** produce a write intent that would have been destructive.

### Epic 7: Unattended Autonomy

*Stage 4.*

Deep leaves and comes back to merged work. Reversibility classes are enforced end to end per action type, all four steering controls demonstrably affect a live run, and the system refuses to run unattended until every one of the seventeen v0 guardrails exists and has been exercised on purpose.

Carries per-action reversibility enforcement, the gated committer's approval path with attributable principals, pause / inject / kill / fork on a live run, the guardrail-completeness precondition asserted by the engine and recorded as an event, and the chaos drill.

**FRs covered:** FR19, FR106
**Additional:** AR-21 (all seventeen, as a gate), AR-25, AR-29, NFR10, NFR21
**UX:** UX-DR29, UX-DR30, UX-DR31, UX-DR32, UX-DR33
**Gate (Stage 4):** the minimum guardrail set in `threat-model.md` is complete and tested, and the chaos drill has been run once.
**Note:** a gate epic more than a build epic — light on FRs, heavy on verification.

### Epic 8: Compounding — Memory, Ledger and Cross-Repo Patterns

*Stage 5.*

A question Deep answers once never reaches him again. Knowledge from completed features makes later features cheaper without inflating any run's context, and a pattern learned building one product is available when building the next.

Carries the episodic log and the consolidation pass, the L1–L3 memory tiers with decay policies and anchor durability ranking, rename-rewriting in the committer and the anchor re-validation sweep, retrieval hit-counts with promotion and pruning, convert-don't-retrieve (conventions become lint rules, failures become regression tests), the decision ledger, cross-repo abstract pattern memory, the bootstrap profile agent, and the retrieval-cost-versus-rework measurement that justifies the layer's existence.

**FRs covered:** FR15, FR16, FR80, FR81, FR82, FR83, FR84, FR85, FR86, FR87, FR88, FR89, FR90, FR91, FR99
**Additional:** AR-26, NFR8, NFR9, NFR13
**Pull-forward option:** `build-sequencing.md` notes the decision ledger (FR15, FR16) is the cheapest and highest-hit-rate element of this epic. If interruption counts become painful during Epic 4, pull FR15 and FR16 forward alone without the rest of the memory layer.

## Epic Dependency Flow

Strictly forward; no epic requires a later one to function.

```text
Epic 1 ──┬──► Epic 3 ──► Epic 4 ──┬──► Epic 6 ──► Epic 7
Epic 2 ──┘                        ├──► Epic 5
                                  └──► Epic 8
```

---

## Epic 1: Observable Runs in the Terminal

Deep can start a run, watch it unfold in the terminal, answer a question or ignore it and have the declared default taken, always see which autonomy mode the system is in, and stop everything with one gesture — and the whole run is reconstructable afterward from an immutable, redacted, crash-surviving log. The interface comes first because shadow mode has no autonomy and is therefore almost entirely an interface product.

### Story 1.1: Initialize the repository and fix its identity

As Deep,
I want this project to be a git repository with a first commit and a stable recorded identity,
So that the system I am building — which keys every project by its first commit and treats git as the record — can eventually be run against its own repository.

**Acceptance Criteria:**

**Given** an uninitialized working directory
**When** initialization completes
**Then** it is a git repository with at least one commit, and the default branch name is recorded
**And** the planning artifacts under `docs/` are committed, so the contract the build follows is versioned alongside the code it produces

**Given** the first commit
**When** the project id is computed
**Then** it is the SHA of that commit, and it remains correct after the directory is renamed or moved
**And** a repository with no commits cannot be registered, which this story is what resolves

**Given** the `.gitignore`
**When** I inspect it
**Then** it excludes build output, `node_modules` and local runtime state
**And** it does not exclude `docs/`, so the planning record travels with the repository

**Given** a remote is configured
**When** I inspect the default branch
**Then** force-push and deletion are disabled server-side
**And** if no remote exists yet, that is recorded as a known state to resolve before the first push rather than left undiscovered

**Given** the repository after this story
**When** I look for orchestrator runtime state inside it
**Then** none exists — no event log, no run state, no worktree — because runtime state belongs outside the target repository

### Story 1.2: Scaffold the package and assert the runtime floor

As Deep,
I want a single TypeScript package whose layout matches the architecture's Structural Seed and which refuses to run on an unsupported Node,
So that every later story has one obvious home and the opaque syntax-error failure mode of a stale Node never happens to me.

**Acceptance Criteria:**

**Given** an empty repository
**When** the scaffold story is complete
**Then** `bin/init.ts` exists and `src/` contains exactly `installer/`, `contracts/`, `engine/`, `runtime/`, `container/`, `tui/`, `web/` and `tools/`, alongside `templates/`, `tests/` and `docker/`
**And** the package is one TypeScript package on Node with no second implementation language and no dependency on the Claude Agent SDK as a library

**Given** the declared Node floor
**When** I inspect where it is written
**Then** it appears in exactly two places — `.nvmrc` and the `package.json` `engines` field — and nowhere else
**And** running any entry point on a Node below that floor exits with a message naming the required version, not a TypeScript syntax error

**Given** the pinned stack
**When** dependencies are installed
**Then** TypeScript 5.9.3, Zod 4.6.5, Vitest 5.0.1 and typescript-eslint 8.70.0 are present at those versions and npm resolves below 12

**Given** the dependency-direction rule
**When** a file in `src/tui/`, `src/web/`, `src/installer/` or `src/tools/` imports from `src/engine/`
**Then** lint fails naming the forbidden edge
**And** a file in `src/contracts/` importing from any other `src/` directory also fails lint

### Story 1.3: Define the shared contracts and prove they round-trip

As Deep,
I want the event envelope, the error shape with its disposition table, and the schema-version convention defined once as Zod schemas with tests proving the draft-7 export matches what Claude Code actually emits,
So that the contract between separately built units cannot drift silently and a schema bug surfaces in CI rather than mid-run.

**Acceptance Criteria:**

**Given** the event envelope schema
**When** I inspect its fields
**Then** it requires `ts`, `seq`, `feature`, `run`, `step`, `emitter`, `type` and `payload`, with `ts` an RFC3339 string carrying milliseconds and `seq` an integer
**And** `parent_tool_use_id` and `session_id` are preserved verbatim when present
**And** a reader given an unrecognised `type` returns the event rather than throwing

**Given** the error shape
**When** I inspect it
**Then** it carries `code`, `message`, `retryable` and `cause`
**And** a disposition table sits beside it in `contracts/` mapping every declared code to exactly one of retry-with-backoff, escalate-model-tier, escalate-to-human or abandon-and-hand-off
**And** looking up an undeclared code returns abandon-and-hand-off rather than throwing or defaulting to retry

**Given** any schema in `contracts/`
**When** it is exported for a step contract
**Then** the export call is `z.toJSONSchema(schema, { target: "draft-7" })` and a test fails if the `target` argument is absent
**And** a lint or test rejects any step contract using `z.date()`, a recursive reference, `minLength`, `minItems` greater than one, or `minimum`

**Given** the AD-31 contract round-trip suite
**When** it runs
**Then** for every contract it asserts the Zod schema, its draft-7 export and a recorded real `structured_output` payload all agree
**And** the suite fails if a contract exists with no recorded sample

**Given** any on-disk artifact this epic writes
**When** it is read back
**Then** it carries a `schema_version`, and a reader meeting an unrecognised version refuses and states which writer version produced it

### Story 1.4: Record events to an append-only log

As Deep,
I want one recorder process that is the only thing appending to a run's event log, assigning sequence numbers and minting run ids,
So that the log is the single durable truth and two producers can never interleave writes into it.

**Acceptance Criteria:**

**Given** a new run
**When** the run is created
**Then** its id is a ULID minted by the engine and by nothing else
**And** its directory is created under `ORCH_HOME/runs/<run-id>/`

**Given** several producers emitting events concurrently
**When** they emit
**Then** every event reaches `events.jsonl` through the recorder, and no other process opens that file for writing
**And** each line is one JSON object, never mutated after append
**And** `seq` is assigned solely by the recorder and is monotonic within the file

**Given** events whose timestamps are out of order across processes
**When** the log is read back
**Then** ordering is by `seq` and timestamps carry no ordering authority

**Given** a run whose engine was killed mid-append
**When** the log is read back
**Then** every complete line parses and at most the final partial line is discarded
**And** a checkpoint written from that log reproduces the same run state as before the kill

**Given** a `state.json` checkpoint that disagrees with the log
**When** the disagreement is detected
**Then** the log wins, the checkpoint is discarded and rebuilt, and no reader treats the checkpoint as authoritative for anything the log records

**Given** any state write
**When** it happens
**Then** it is written to a temporary file in the same directory and renamed, never written in place

### Story 1.5: Redact secrets before they reach the log

As Deep,
I want every event to pass a redaction stage that fails closed before it is appended,
So that the combination of recording everything and never mutating the log cannot manufacture a permanent, unremovable secret leak.

**Acceptance Criteria:**

**Given** an event whose payload contains a known token prefix, a high-entropy string, env-file contents, a private-key header, or the literal value of an injected credential
**When** it is emitted
**Then** the matched value is replaced before the line is appended, and the unredacted form appears nowhere on disk

**Given** the redaction pass errors while processing an artifact
**When** that happens
**Then** the artifact is dropped, a `redaction.failed` event is appended in its place, and no partially redacted content is written

**Given** redaction is positioned in the pipeline
**When** I trace the write path
**Then** redaction sits on the producer-to-log boundary, before append, with no code path that appends without passing through it

**Given** an already-appended line
**When** I look for a way to redact it after the fact
**Then** none exists, and this is asserted by the tests as intended behaviour rather than a gap

### Story 1.6: Establish the state layout, config scopes and the single-engine lock

As Deep,
I want runtime state to live centrally with fixed, disjoint configuration scopes, and exactly one engine per state root,
So that no unit looks in the wrong place for a value and two engines can never interleave writes into one run.

**Acceptance Criteria:**

**Given** `ORCH_HOME` unset
**When** the system starts
**Then** it defaults to `~/.orch` and creates `runs/`, `worktrees/`, `pool/`, `projects/` and `memory/` beneath it

**Given** the four configuration scopes
**When** I look up any single value
**Then** it is declared in exactly one of machine (`ORCH_HOME/config.toml`), project (`<target-repo>/.orch/`), run (`runs/<run-id>/config/`) or cross-project memory (`ORCH_HOME/memory/`)
**And** no value is merged or overridden between scopes, and a duplicate declaration is an error naming both locations

**Given** an engine already running against a state root
**When** a second engine starts against the same root
**Then** it exits with a message naming the holder's pid and start time, without writing anything

**Given** a lock file whose recorded pid no longer exists
**When** an engine starts
**Then** it verifies the pid is gone before reclaiming the lock, and refuses to reclaim while the pid is alive

**Given** no target repository is involved
**When** I inspect any repository the system has touched
**Then** no run state, event log or worktree has been written inside it

### Story 1.7: Make every steering control a durable intent file

As Deep,
I want every control I can issue to be one member of a shared enum, written as a durable file the engine consumes,
So that the terminal and the browser cannot drift apart and no control depends on a server being up.

**Acceptance Criteria:**

**Given** the set of steering controls
**When** they are defined
**Then** all of them are members of a single `Command` enum declared once in `contracts/`
**And** a renderer that handles a control the enum lacks, or omits one the enum declares, fails to compile rather than failing review

**Given** I issue any steering command
**When** it is recorded
**Then** a durable file appears under `runs/<run-id>/commands/` carrying the command, its target and the principal that issued it
**And** the engine consumes only those files, with no second command path into it

**Given** no HTTP server is running
**When** I issue any steering command
**Then** it works through the file path with no loss of capability

**Given** a command file that has already been consumed
**When** the engine passes over it again
**Then** it is not re-applied

### Story 1.8: Define the question contract and resolve it exactly once

As Deep,
I want a question to be a typed object with one state machine, where exactly one of the possible resolvers wins,
So that an answer I type and a timeout that fires cannot both be recorded and poison the record with conflicting decisions.

**Acceptance Criteria:**

**Given** any question the system raises
**When** it is constructed
**Then** it carries a recommended default, at most three concrete options plus an escape, a timeout window, and a self-contained mini-brief answerable without reloading the feature into my head
**And** a question with no default, with no window, or with more than three options plus an escape fails validation rather than being rendered

**Given** a question in state `asked`
**When** two resolvers attempt to resolve it concurrently
**Then** exactly one transition to `resolved` is accepted, decided by a compare-and-set on the question state file
**And** the losing resolver receives an already-resolved result and writes nothing

**Given** a resolved question
**When** I inspect its record
**Then** it names which resolver won and which principal it acted for
**And** `question.asked` and `question.resolved` appear in the event log

**Given** a question answered from the repository or git history before reaching me
**When** that happens
**Then** it is recorded as `question.deflected` and never rendered
**And** the deflection is counted toward the reported deflection rate

**Given** I answer in free text that does not match any option verbatim
**When** the system parses it
**Then** it resolves to an option or asks one clarifying follow-up, and never rejects my answer for its format

### Story 1.9: Take the declared default when a question is ignored

As Deep,
I want ignoring a question to be a valid input that produces the outcome the question told me it would,
So that non-response is a decision I can make deliberately rather than a way to stall the system.

**Acceptance Criteria:**

**Given** a question rendered with a stated default and window
**When** the window expires with no answer
**Then** the default is applied automatically, a `question.default_taken` event is appended, and the outcome is recorded as a decision with the timeout named as its resolver

**Given** the window expires at the same moment I answer
**When** both resolvers race
**Then** the compare-and-set of Story 1.8 admits exactly one, and the log shows which

**Given** the engine was not running when a window expired
**When** it restarts
**Then** it observes the elapsed window and takes the default, rather than leaving the question open indefinitely or treating the gap as an answer

**Given** a question whose default has been taken
**When** I look at it afterward
**Then** it shows the default that was applied and when, not merely that it expired

### Story 1.10: Render the run in the terminal with a permanent mode display

As Deep,
I want an Ink renderer that projects the event log and keeps the current autonomy mode permanently in view,
So that I can watch a run without a browser and can never be wrong about which mode the system is in.

**Acceptance Criteria:**

**Given** a recorded run
**When** I open the TUI against it
**Then** the timeline renders as a projection of the event log with no state of its own
**And** an event type the renderer does not recognise is skipped rather than crashing the render

**Given** the TUI is open
**When** I look at the prompt line
**Then** the current mode is present, and it is present at every moment the TUI is open rather than only at transitions
**And** a phase transition emits a standard callout

**Given** the web renderer is absent entirely
**When** I work through a run
**Then** every action is available and no reply requires a browser

**Given** progress is being reported
**When** I read it
**Then** it names the current step and the next gate, never a percentage
**And** features are addressed by name, never by run id or agent name

**Given** the system has something to tell me
**When** it renders
**Then** the message opens with a headline that stands alone, defaults to one line with detail on request, and follows a stable message grammar
**And** uncertainty is shown as uncertainty rather than as a confident answer

**Given** diagnostics are produced
**When** I look for them
**Then** they are in the event log, and no unit has written them to stdout — the TUI's own rendering being the only thing on stdout

### Story 1.11: Present the active question in a slot that does not scroll away

As Deep,
I want the question I currently owe an answer to pinned where I cannot lose it, with its consequences spelled out,
So that answering costs me seconds rather than reconstructing context, and a question never scrolls past unseen.

**Acceptance Criteria:**

**Given** a question is awaiting my answer
**When** other output arrives
**Then** the question remains in a persistent slot that does not scroll away

**Given** I read the question card
**When** I look at it
**Then** it shows the question, the recommended answer, the consequence of each option, and the default that will be taken with its remaining window
**And** it is self-contained — I can answer without opening the feature, the diff or another surface

**Given** two or more questions arise close together
**When** they are surfaced
**Then** they are batched to a natural boundary rather than fired individually

**Given** a do-not-disturb window is active
**When** a question is raised
**Then** it queues rather than fires, and the queue is visible when the window ends

**Given** a question whose resolution would take me more than about ten seconds to reason about, or which concerns a reversible action
**When** the system considers raising it
**Then** it does not interrupt me for it

**Given** I reject a proposal
**When** I do so
**Then** it takes one keystroke plus a reason, and the reason is captured as a durable decision

### Story 1.12: Show every in-flight feature on one screen

As Deep,
I want one surface that tells me the state of everything in flight and what each thing needs from me,
So that I can orient in seconds without issuing a command or reading prose.

**Acceptance Criteria:**

**Given** several features in flight
**When** I open the morning brief
**Then** all of them fit one screen with no scrolling, each showing what it needs and what it has cost
**And** each is addressed by feature name

**Given** a feature that needs nothing from me
**When** I read the brief
**Then** it is visibly quiet rather than absent, so silence is legible as success rather than as missing data

**Given** nothing is in flight
**When** I open the brief
**Then** it says so plainly rather than rendering an empty frame

**Given** the brief is rendered
**When** I trace where its numbers come from
**Then** they are a fold over the event log, with no separate datastore consulted

### Story 1.13: Stop everything with one gesture

As Deep,
I want a single gesture that always means stop, leaving state I can pick back up,
So that I am never trapped inside the system and disengaging costs me nothing.

**Acceptance Criteria:**

**Given** work is in progress
**When** I issue the disengage gesture
**Then** all agents halt, and the state left on disk is sufficient to resume
**And** the gesture is the same in every context and always means stop

**Given** a step halted by my gesture
**When** the engine next passes over it
**Then** it records the disposition `killed` and is neither resumed nor re-run

**Given** I am considering stopping
**When** I look at the kill card
**Then** it shows consumed usage and elapsed time against estimate, and offers continue, narrow, kill and take over
**And** elapsed-versus-estimate is visible without my asking, so abandoning early is easy

**Given** I halt mid-write
**When** I inspect the log afterward
**Then** it is intact and parseable, with no torn state

### Story 1.14: Hand the work back as an ordinary branch

As Deep,
I want one command that gives me my work as a normal git branch and detaches the system, and a written note when the system gives up,
So that manual takeover is always one keystroke away and a stuck system explains itself instead of thrashing.

**Acceptance Criteria:**

**Given** work in progress under any isolation tier
**When** I invoke the escape hatch
**Then** the partial work lands on an ordinary git branch I can check out with no orchestrator tooling
**And** all agents halt and the system detaches

**Given** repeated failure on the same work
**When** the failure threshold is reached
**Then** the system halts and writes a handoff document, rather than retrying
**And** the document states what was tried, what failed, the current state and a suggested next step, and reads as a colleague's note rather than a stack trace

**Given** the escape hatch
**When** the epic is complete
**Then** it has been exercised at least once deliberately, and that exercise is recorded — not left as untested code

### Story 1.15: Keep mode and usage visible with no TUI running

As Deep,
I want a shell or multiplexer segment showing mode, consumed budget and step count when no orchestrator surface is open,
So that "the mode is always visible" is true of my actual terminal rather than only of a screen I have chosen to open.

**Acceptance Criteria:**

**Given** no TUI and no web process is running
**When** my shell renders its prompt
**Then** the segment shows the current mode, consumed rate-limit budget and step count, read from the state root by a process my shell invokes

**Given** the segment renders
**When** I use my terminal normally
**Then** it never demands attention, blocks the prompt, or writes output of its own

**Given** nothing is in flight
**When** the prompt renders
**Then** the segment is quiet rather than showing stale figures from a finished run

**Given** the state root is unreadable or absent
**When** the prompt renders
**Then** the segment degrades to nothing and my shell is unaffected

### Story 1.16: Notify only on exception, decision point or completion

As Deep,
I want a notification channel that stays silent while things are going well and honours quiet hours,
So that silence carries information and I never learn to ignore the one notification that mattered.

**Acceptance Criteria:**

**Given** a run proceeding normally
**When** it progresses
**Then** no notification is delivered — silence means success

**Given** an exception, a decision point, or a completion
**When** it occurs
**Then** exactly one notification is delivered, and it is actionable

**Given** the notification channel and the event log
**When** I compare them
**Then** they are distinct: most of what reaches the log deliberately does not reach me

**Given** quiet hours are configured
**When** a non-exception event occurs inside them
**Then** delivery is deferred rather than suppressed, and arrives when the window ends

**Given** a completion notification
**When** I read it
**Then** it states what merged, the file count, test status and usage, what was verified **and what was not**, and explicitly that nothing is needed from me

---

## Epic 2: Containment — Isolation Tiers and Leased Resources

Deep can run untrusted work inside a hardened sandbox and get a ready postgres or redis on request, with nothing reaching the host and nothing left behind. All three isolation tiers are selectable, and the tier-2 executor demonstrably holds no push credential. The sandbox is what makes everything else recoverable, so it is built before anything runs unattended rather than after.

### Story 2.1: Select the weakest isolation tier the work allows

As Deep,
I want the system to pick between editing in place, working on a branch, and a worktree inside a container, based on what the change actually risks,
So that a typo fix does not pay container tax and a real feature is never run in the open.

**Acceptance Criteria:**

**Given** a change classified as a typo, comment or formatting edit
**When** the tier is selected
**Then** tier 0 is chosen and no branch and no container are created

**Given** a small, low-blast-radius change
**When** the tier is selected
**Then** tier 1 is chosen: a branch, no container

**Given** a real feature, or any change touching a path the profile declares high-blast-radius
**When** the tier is selected
**Then** tier 2 is chosen: a worktree, a least-privilege container, and leased resources if the profile declares any

**Given** all three tiers
**When** the epic is complete
**Then** each has been exercised at least once, and the selected tier is recorded in the run's event log with the classification that produced it

### Story 2.2: Put every docker flag behind one wrapper

As Deep,
I want exactly one script that composes every `docker` invocation,
So that the containment boundary is defined in one readable place and no component can weaken it by composing its own flags.

**Acceptance Criteria:**

**Given** any container the system starts
**When** I trace how it was started
**Then** it went through the single wrapper, and no other file in the repository invokes `docker` directly
**And** a new call site added outside the wrapper fails lint or test

**Given** the wrapper starts an executor
**When** I inspect the resulting container
**Then** the root filesystem is read-only, `/tmp` is a tmpfs, the user is non-root, all capabilities are dropped, `no-new-privileges` is set, a seccomp profile is applied, and memory and pid limits are in force

**Given** the wrapper's mount set
**When** I inspect it
**Then** only the run worktree and its session directory are mounted
**And** `HOME`, `.ssh`, any cloud credential path, the docker socket and the target repository root are all absent

**Given** a live run
**When** its container exits
**Then** `--rm` was not used, so the session transcript survives for resume
**And** the container is removed only once the run reaches a terminal disposition

### Story 2.3: Build the executor image locally and tag it by content

As Deep,
I want the executor image built from a Dockerfile in this repository and tagged by that file's content hash,
So that the sandbox I audit is the sandbox that runs, and it rebuilds exactly when it changes and never otherwise.

**Acceptance Criteria:**

**Given** the Dockerfile
**When** the image is built
**Then** the tag is the content hash of that Dockerfile
**And** no image is pulled from any registry

**Given** an unchanged Dockerfile
**When** a run starts
**Then** the existing image is reused with no rebuild

**Given** a changed Dockerfile
**When** a run starts
**Then** the image is rebuilt automatically before the run proceeds

**Given** the image build
**When** it runs
**Then** it is the only step permitted network access outside the egress allowlist, and that exception is recorded

### Story 2.4: Prove the executor cannot push or reach the daemon

As Deep,
I want an automated test that tries to push and tries to reach the docker daemon from inside the executor and fails at both,
So that "the executor holds no claws" is a verified fact rather than a design intention.

**Acceptance Criteria:**

**Given** a running tier-2 executor container
**When** the assertion test attempts `git push` from inside it
**Then** the attempt fails for absence of credential, not because a policy declined it

**Given** the same container
**When** the test looks for `/var/run/docker.sock`
**Then** it is absent, and a startup assertion fails the run if it is ever present

**Given** the same container
**When** the test looks for production credentials, ssh keys or cloud credentials
**Then** none are reachable

**Given** this test
**When** I look at where it lives
**Then** it is one of the three required AD-31 suites, and the suite is a precondition for any unattended run rather than an optional check

### Story 2.5: Separate provisioning from execution in time

As Deep,
I want dependency installation to happen in a network-enabled phase that ends before execution begins, with execution behind an egress allowlist,
So that installs remain possible without leaving an open outbound path during the phase that runs model-authored code.

**Acceptance Criteria:**

**Given** a tier-2 run
**When** it starts
**Then** a provisioning phase with network access installs dependencies, and that phase completes before any execution step begins

**Given** the execution phase
**When** a process inside it makes an outbound request
**Then** it traverses the allowlist proxy, and a host not on the allowlist receives a refusal

**Given** the allowlist
**When** I inspect it
**Then** it names the Anthropic API, the package registry for the stack, the git remote and any enabled external domain host, and nothing else

**Given** any outbound call from a container
**When** it is made
**Then** it is recorded, so the proxy log is usable as an audit trail

### Story 2.6: Lease an ephemeral database and get it back empty

As Deep,
I want a feature that needs postgres or redis to receive a disposable instance quickly and return it wiped,
So that no agent ever holds a connection string to anything that matters and nothing accumulates between runs.

**Acceptance Criteria:**

**Given** a profile declaring a postgres need
**When** the run starts
**Then** a ready instance is leased within the declared time bound, and the bound is recorded alongside the actual time taken

**Given** a leased instance
**When** the run completes
**Then** the instance is returned to the pool, wiped, and verified empty before it can be leased again
**And** a wipe that cannot be verified takes the instance out of the pool rather than returning it

**Given** any credential reaching an agent for a datastore
**When** I inspect it
**Then** it is the leased, disposable credential and nothing else — no non-ephemeral connection string is ever injected

**Given** a run that declares no resource need
**When** it runs
**Then** no instance is leased

### Story 2.7: Reclaim resources by reconciling, never by exiting

As Deep,
I want worktrees, containers and leases reclaimed by a pass that compares what is live against what is running,
So that a hard kill or a crash cannot strand resources, and a restart cannot destroy work that is still in flight.

**Acceptance Criteria:**

**Given** a resource whose run has reached a terminal disposition
**When** the reclamation pass next runs
**Then** the resource is reclaimed

**Given** a resource whose run state no longer exists
**When** the pass runs
**Then** the resource is reclaimed

**Given** a resource whose run holds a non-terminal disposition
**When** the pass runs
**Then** nothing is reclaimed, so a crashed engine restarting does not destroy in-flight work

**Given** the engine is killed with `SIGKILL` mid-run
**When** it restarts
**Then** every container, worktree and lease is accounted for by the pass, with no reliance on any exit path having run

### Story 2.8: Assert branch protection before a run begins

As Deep,
I want the system to confirm the default branch is protected server-side before it starts work,
So that the one control that survives total agent failure is known to be in place rather than assumed.

**Acceptance Criteria:**

**Given** a target repository with a remote
**When** a run starts
**Then** the system asserts that force-push and deletion are disabled on the default branch server-side, and records the result

**Given** protection is absent
**When** the assertion runs
**Then** the run refuses to start unattended and states exactly what is missing

**Given** any git operation the system performs
**When** it is a force-push in any form — `--force`, `--force-with-lease`, or a colon-prefixed delete refspec
**Then** it is rejected by a wrapper before reaching git, and the rejection is recorded

---

## Epic 3: The Engine — Deterministic, Resumable Step Execution

Deep can run a multi-step pipeline that survives being killed at any instant, resumes where it left off, re-runs any single step in isolation with identical effect, and halts cleanly at a declared ceiling instead of overrunning silently. Intelligence lives at the leaves; the pipeline itself is ordinary code.

### Story 3.1: Reconcile from disk, holding no run state in memory

As Deep,
I want a loop that reads the checkpoint, takes at most one action, writes the checkpoint, and keeps nothing authoritative in memory,
So that killing the engine is indistinguishable from never having stopped it, and crash recovery is the same code path as ordinary operation.

**Acceptance Criteria:**

**Given** the reconciler is running
**When** I inspect one pass
**Then** it reads the checkpoint, takes at most one next action, and writes the checkpoint before the pass ends

**Given** the reconciler holds state
**When** I look for authoritative run state in memory
**Then** none exists — every fact it acts on is read from disk in that pass

**Given** a crash-injection test that kills the process at each state transition in turn
**When** the engine restarts
**Then** the resulting run is identical in step sequence and disposition to a run never interrupted
**And** this suite is one of the three required AD-31 suites

**Given** the checkpoint disagrees with the event log
**When** the reconciler reads it
**Then** the checkpoint is discarded and rebuilt from the log

**Given** several features are in flight
**When** the reconciler schedules them
**Then** it reconciles them concurrently, and the scheduling decision is expressed as a policy the loop consults rather than hardcoded, so a serialization constraint can later be added without changing the loop

### Story 3.2: Spawn a step as a subprocess under a fixed argument baseline

As Deep,
I want every step to be one `claude -p` subprocess launched with the same hardened argument set,
So that the permission surface is identical for every step and no repository can widen it by declaring its own tooling.

**Acceptance Criteria:**

**Given** a step to run
**When** the engine spawns it
**Then** it spawns exactly one `claude -p` process, passing the step contract via `--json-schema` and consuming `--output-format stream-json`

**Given** any spawn
**When** I inspect its arguments
**Then** `--strict-mcp-config` and `--restricted` are present, so only engine-supplied MCP servers load and the target repository's own `.mcp.json` and hooks introduce nothing

**Given** the CLI resolves to API-key mode rather than subscription authentication
**When** the engine starts
**Then** it refuses to run and says so — bare mode is forbidden positively, not merely left unflagged

**Given** a step returns `structured_output`
**When** the engine receives it
**Then** it re-parses the output against the originating Zod schema before accepting it, and a schema-invalid output is rejected rather than passed downstream

**Given** a step that is not explicitly a creative step
**When** it is spawned
**Then** temperature is zero and the model is a pinned version id rather than a floating alias
**And** the resolved model id and the absolute path of the Node executable are recorded in the run's event log

### Story 3.3: Record a step baseline and reset to it on re-run

As Deep,
I want every step to record the exact worktree commit it started from, and a re-run to reset there first,
So that re-running a step any number of times has the same effect as running it once, even though steps mutate files.

**Acceptance Criteria:**

**Given** a step is about to begin
**When** it starts
**Then** the exact commit of the run worktree at that instant is recorded as the step's `baseline_ref`

**Given** a step that wrote three files and was then killed before committing
**When** it is re-run
**Then** the worktree is reset to `baseline_ref` before the step begins, so the step does not find half its own prior output on disk

**Given** the same step re-run three times from the same input
**When** I compare the resulting worktree state
**Then** it is the same each time, with no accumulation of duplicated edits

**Given** a step is re-run in isolation, outside a full run
**When** it executes
**Then** it runs from its typed input file alone, with no requirement to replay the steps before it

### Story 3.4: Record a disposition on every termination and resume only where it is safe

As Deep,
I want every step termination classified, with resume attempted only for an interruption,
So that recovery never silently undoes a kill I asked for and never re-runs something that already finished.

**Acceptance Criteria:**

**Given** any step that terminates
**When** it ends
**Then** it records a disposition, and no step may end without one

**Given** a step with disposition `interrupted`
**When** the reconciler next passes
**Then** it attempts `claude -p --resume` with the recorded session id, and on failure re-runs the step from its typed input after the baseline reset of Story 3.3

**Given** a step with disposition `killed`
**When** the reconciler passes over it
**Then** it is neither resumed nor re-run, so my kill stands

**Given** a step subprocess reports its session id
**When** it does
**Then** the checkpoint records it immediately rather than at step completion, so an interruption between those two points is still resumable

### Story 3.5: Replay a recorded run to an identical step sequence

As Deep,
I want a recorded run to replay from its inputs to the same ordered list of steps,
So that a bug reported from a run is reproducible rather than archaeology.

**Acceptance Criteria:**

**Given** a completed run and its recorded inputs
**When** it is replayed
**Then** the resulting step sequence is identical to the original

**Given** step identity
**When** I inspect a step id
**Then** it is a stable declared name, never a positional index, so inserting a step does not renumber the others

**Given** a replayed run
**When** it reaches a step that reads an external domain
**Then** the recorded fetch is served rather than the domain contacted, so replay does not depend on an external system's current state

**Given** a step whose behaviour is explicitly creative
**When** I look at the run record
**Then** it is named as such, so nondeterminism is quarantined to declared steps rather than ambient across the pipeline

### Story 3.6: Keep evidence out of model context

As Deep,
I want transcripts, diffs and telemetry written to disk and passed by pointer, with only typed decisions entering model context,
So that orchestration cost does not grow with the volume of evidence a run produces.

**Acceptance Criteria:**

**Given** a step's input
**When** I inspect what it contains
**Then** it holds the typed step input and nothing from the evidence plane inline — evidence appears as pointers

**Given** a step produces a transcript, a diff or telemetry
**When** it is recorded
**Then** the runtime writes it to disk in the evidence plane and the control plane references it by pointer

**Given** an evidence pointer
**When** I follow it
**Then** the artifact is retrievable on demand

**Given** a run that produces a very large volume of evidence
**When** I compare its control-plane size against a run producing little
**Then** they are comparable, because evidence volume does not enter the control plane

### Story 3.7: Fail hard when the control-plane ceiling is exceeded

As Deep,
I want exceeding the declared control-plane token ceiling to stop the run rather than quietly degrade it,
So that the plane separation is a guarantee I can rely on instead of a tendency.

**Acceptance Criteria:**

**Given** a run
**When** it starts
**Then** a control-plane token ceiling is declared and recorded

**Given** the control plane for a run reaches that ceiling
**When** it does
**Then** the run fails with a named error, rather than downshifting, truncating or summarising to fit

**Given** that failure
**When** I read the error
**Then** it names the ceiling, the measured value, and the step that exceeded it

**Given** a step contract that would inline a full transcript or whole diff
**When** it is validated
**Then** it is rejected, so the ceiling cannot be breached by contract design rather than by run size

### Story 3.8: Re-ground every step on the verbatim request

As Deep,
I want every step to read the original feature request word for word,
So that a small misreading in an early step cannot compound into a clean, tested implementation of the wrong feature.

**Acceptance Criteria:**

**Given** any step's input schema
**When** I inspect it
**Then** it carries the original feature request verbatim as a required field

**Given** a step's input
**When** I compare the request text against what the user originally typed
**Then** it is identical — never a summary, and never a summary of a summary

**Given** a step contract that omits the verbatim request
**When** it is registered
**Then** registration fails, so the rule is enforced by the schema rather than by prompt discipline

**Given** a step is spawned
**When** its prompt is assembled
**Then** reading the verbatim request is the first instruction, before any prior step's output

### Story 3.9: Check each artifact against the request before it flows on

As Deep,
I want a cheap check between steps asking only whether the artifact is still an answer to what I asked for,
So that a poisoned artifact is caught at the boundary rather than after eight hours of work built on it.

**Acceptance Criteria:**

**Given** a step has produced an artifact
**When** it is about to flow to the next step
**Then** a narrow validation runs, comparing the artifact against the original request

**Given** that check
**When** I inspect its cost
**Then** it runs on the cheapest model rung and asks a single narrow question, rather than reviewing the artifact's quality

**Given** the check finds the artifact is no longer an answer to the request
**When** that happens
**Then** the artifact does not flow onward, the divergence is recorded, and the run escalates rather than continuing

**Given** the check passes
**When** the next step runs
**Then** the pass is recorded so the run's provenance shows where drift was checked

### Story 3.10: Serialize only features whose territory overlaps

As Deep,
I want features to declare which files they will touch and the engine to serialize only those that collide,
So that parallelism is bounded by real conflict rather than by an arbitrary worker count.

**Acceptance Criteria:**

**Given** a feature entering execution
**When** it starts
**Then** it has declared its file territory, and the declaration is recorded

**Given** two features whose territories do not overlap
**When** they are scheduled
**Then** they run concurrently

**Given** two features whose territories overlap
**When** they are scheduled
**Then** they are serialized, and the second is told why it is waiting

**Given** a feature that modifies a file outside its declared territory
**When** that happens
**Then** it is flagged as a signal, not silently permitted

### Story 3.11: Enforce three ceilings and degrade at eighty percent

As Deep,
I want every run bounded in steps, wall-clock and consumed rate-limit budget, degrading before it stops,
So that a runaway costs me a bounded amount of a resource that is genuinely scarce, and does not fall off a cliff with nothing to show.

**Acceptance Criteria:**

**Given** a run
**When** it starts
**Then** it carries a step-count ceiling, a wall-clock ceiling and a rate-limit-budget ceiling, and no currency dimension exists anywhere in the model

**Given** a run reaching eighty percent of any one of the three
**When** it crosses that point
**Then** it downshifts model tier and narrows scope, and emits `budget.degraded` naming which ceiling triggered it

**Given** a degraded run
**When** it continues
**Then** it prefers finishing over exploring, and the narrowing is recorded so I can see what was dropped

**Given** any of the three ceilings
**When** I look for where it is enforced
**Then** it is enforced by the engine, never by an agent's self-restraint

### Story 3.12: Hibernate at a ceiling rather than dying or continuing

As Deep,
I want a run that hits a ceiling to snapshot itself, write a handoff note and stop,
So that I come back to a resumable position and an explanation rather than a half-written state or an exhausted rate-limit window.

**Acceptance Criteria:**

**Given** a run reaching any ceiling
**When** it does
**Then** it hibernates: state is snapshotted, a handoff note is written, a terminal-pending disposition is recorded, and `budget.exhausted` is emitted

**Given** the ceiling is reached mid-write
**When** hibernation occurs
**Then** the write completes or is cleanly abandoned — the run never stops with torn state

**Given** a hibernated run
**When** I read its handoff note
**Then** it states what was completed, what remains, and what it would do next

**Given** a hibernated run
**When** I choose to continue it
**Then** it resumes from the snapshot rather than restarting

### Story 3.13: Cap steps per agent and flag anomalous usage

As Deep,
I want a hard turn limit per agent and an alert when usage deviates from the baseline for that kind of work,
So that an infinite loop dies cheaply and a six-times-normal run on a small change reaches me long before any ceiling does.

**Acceptance Criteria:**

**Given** an agent running its steps
**When** it exceeds its declared turn cap
**Then** it terminates, and its partial work remains on disk as a marker for whoever picks it up

**Given** a history of completed features
**When** a run's steps-per-feature or usage-per-feature deviates materially from the baseline for its feature class
**Then** an anomaly signal is raised, independent of whether any ceiling has been approached

**Given** no baseline yet exists for a feature class
**When** a run of that class completes
**Then** it contributes to the baseline, and the absence of a baseline is not treated as an anomaly

**Given** the step cap
**When** I inspect its implementation
**Then** it is a counter in the engine loop, not a limit an agent is asked to respect

### Story 3.14: Estimate a run before spending capacity on it

As Deep,
I want a dry run against a mock executor that shows me the plan and an estimated cost,
So that I can reject a bad plan before it consumes a rate-limit window.

**Acceptance Criteria:**

**Given** a confirmed feature
**When** I request a dry run
**Then** the full pipeline executes against a mock executor and produces the plan plus estimated step and token counts

**Given** a dry run
**When** it completes
**Then** no real model capacity was consumed for execution and no write intent was executed

**Given** an estimate
**When** compared against the run's ceilings
**Then** the comparison is shown, so an estimate exceeding a ceiling is visible before I approve

**Given** completed real runs
**When** estimates are produced afterward
**Then** they draw on the recorded history of those runs rather than on a fixed heuristic

---

## Epic 4: The Feature Pipeline — From Request to Pull Request

Deep describes a feature to the Interviewer, confirms the restated acceptance criteria in one keystroke, and gets a pull request authored under his own git identity with the full timeline recoverable from a git note. This epic delivers the Stage 2 gate.

**Staging note:** the agent roster and the per-repo profile are hand-written in this epic, as `build-sequencing.md` specifies for Stage 2. Epic 5 replaces both with generated, declarative configuration. No story here depends on the installer existing.

### Story 4.1: Talk to one agent and nothing else

As Deep,
I want a single conversational surface that is the only thing I ever address,
So that I never learn a component's name, a run id or an agent's interface in order to get work done.

**Acceptance Criteria:**

**Given** a feature I want built
**When** I describe it
**Then** I address only the Interviewer, and no other component exposes a conversational surface I could address

**Given** a feature request typed in one terminal session
**When** it completes
**Then** it reached a merged branch with zero interaction on my part with any component other than the Interviewer

**Given** the Interviewer
**When** I inspect what it is
**Then** it is a `claude -p` process like any other step, holding the conversation and nothing else — it does not route, schedule or decide what runs next

**Given** I refer to work in progress
**When** I name it
**Then** a feature name is sufficient, and the system never requires me to supply a run id or an agent name

### Story 4.2: Echo the request back as acceptance criteria

As Deep,
I want the system to restate what I asked for as explicit criteria before writing any code,
So that the cheapest possible defence against drift happens before drift can accumulate.

**Acceptance Criteria:**

**Given** a feature request
**When** the Interviewer processes it
**Then** it produces an explicit acceptance-criteria list restating the request, and presents it before any execution step runs

**Given** an unconfirmed criteria list
**When** the engine looks for work to do
**Then** the feature does not enter execution — confirmation is a precondition, not a courtesy

**Given** the criteria list
**When** I read it
**Then** each criterion is concrete enough to be verified, rather than restating my words back to me

**Given** the confirmed criteria
**When** the run completes
**Then** the same criteria appear in the run's durable record, so what was verified can be compared against what was agreed

### Story 4.3: Edit any criterion and confirm in one keystroke

As Deep,
I want to amend a single line of the criteria and accept the rest with one key,
So that correcting the system's reading costs me seconds instead of restating the whole request.

**Acceptance Criteria:**

**Given** a criteria list I mostly agree with
**When** I edit one criterion
**Then** the contract is amended in place, and I am not re-prompted for the request from scratch

**Given** an amended criteria list
**When** the amendment is recorded
**Then** the original and the amendment are both visible, so the change of understanding is traceable

**Given** a criteria list I fully agree with
**When** I confirm it
**Then** it takes one keystroke

**Given** I add a criterion the system did not propose
**When** I do so
**Then** it is accepted into the contract and treated identically to the system's own criteria for verification purposes

### Story 4.4: Answer a question from the repository before asking me

As Deep,
I want every candidate question attempted against the repository and git history first,
So that my attention is spent only on things the system genuinely could not determine.

**Acceptance Criteria:**

**Given** a candidate question
**When** it is raised
**Then** the system attempts to answer it from the repository and from git history before it may be rendered to me

**Given** a question answered from either source
**When** that happens
**Then** it is recorded as `question.deflected` with the source that resolved it, and never rendered

**Given** a completed feature
**When** I look at its record
**Then** the deflection rate for that feature is reported

**Given** the system cannot resolve a question from either source
**When** it surfaces the question
**Then** it says what it already checked, so I am not asked something I can see it should have known

### Story 4.5: Merge related questions and hold the median to one

As Deep,
I want unresolved questions arising close together combined into a single ask,
So that a feature costs me one interruption rather than five, which is the whole point of the system.

**Acceptance Criteria:**

**Given** two or more unresolved questions arising within a feature
**When** they concern related decisions
**Then** they are merged into one user-facing question before surfacing

**Given** a merged question
**When** I answer it
**Then** every constituent question is resolved by that answer, and each is recorded as resolved with the merged question named as its resolver

**Given** a sample of twenty features
**When** user-facing questions per feature are measured
**Then** the median is at most one

**Given** questions could be merged but doing so would exceed three options plus an escape
**When** that happens
**Then** they are asked separately rather than merged into an unanswerable question

### Story 4.6: Give each external domain one server and one credential

As Deep,
I want each external domain reachable through exactly one MCP server holding only that domain's credential,
So that domain ownership is a physical fact about where a secret lives rather than an instruction an agent could disregard.

**Acceptance Criteria:**

**Given** an enabled external domain
**When** I inspect how it is reached
**Then** exactly one MCP server serves it, holding that domain's credential and no other

**Given** an agent not granted that domain
**When** it attempts that domain's API
**Then** the attempt fails for absence of credential, and an automated test proves this

**Given** any MCP server the system runs
**When** I inspect its tool surface
**Then** it exposes no mutating tool — reads only

**Given** a credential
**When** I trace where it exists
**Then** it is an environment variable inside its owning server's container, and its value appears in no model context, no prompt and no log

### Story 4.7: Record every external read and serve it from the record

As Deep,
I want every external request and response recorded, shared across a run's steps, and replayed on re-run,
So that a step that reads the outside world is still deterministic and two steps never see different versions of one record.

**Acceptance Criteria:**

**Given** any external request
**When** it is made
**Then** the request and its response are recorded, after redaction, to the event log and to the run's shared fetch record

**Given** a record fetched by one step
**When** a later step in the same run needs it
**Then** it is served from the fetch record rather than re-requested

**Given** one external record within one run
**When** two steps read it
**Then** they see the same value

**Given** a step being re-run
**When** it issues a request already in the fetch record
**Then** the record is served and the domain is not contacted
**And** a request not already recorded does reach the domain

### Story 4.8: Interpret the request against the repository

As Deep,
I want an analysis step that reads the request and the codebase and outputs a typed interpretation,
So that what the rest of the pipeline builds from is an explicit, inspectable reading rather than an implicit one.

**Acceptance Criteria:**

**Given** a confirmed feature
**When** the analysis step runs
**Then** it reads the verbatim request and the repository and outputs one typed artifact against a registered contract

**Given** the analysis output
**When** I inspect it
**Then** every claim in it names the step that produced it

**Given** the request is ambiguous
**When** analysis encounters the ambiguity
**Then** it records the ambiguity rather than resolving it silently, and the ambiguity becomes a candidate question

**Given** the analysis step
**When** it runs twice on the same input
**Then** it produces the same interpretation, being a pure function over its typed input

### Story 4.9: Produce a plan that declares its territory

As Deep,
I want a planning step that outputs an ordered plan naming the files it will touch,
So that the engine can schedule the feature safely and I can see the shape of the change before it happens.

**Acceptance Criteria:**

**Given** an analysis artifact
**When** the planning step runs
**Then** it outputs an ordered plan against a registered contract, declaring the file territory the work will occupy

**Given** the plan
**When** I read it
**Then** it names what will change and in what order, and is short enough to skim

**Given** the declared territory
**When** the engine schedules the feature
**Then** it uses that declaration for the overlap rule, with no inference from the feature slug

**Given** a plan whose territory includes a path the profile marks high-blast-radius
**When** it is produced
**Then** the isolation tier is escalated accordingly

### Story 4.10: Write the code in the worktree

As Deep,
I want an implementation step that edits files inside the run worktree and commits its output,
So that the work is visible in git as it happens and reviewable as ordinary commits.

**Acceptance Criteria:**

**Given** a plan
**When** the implementation step runs
**Then** it edits files inside the run worktree only, and commits its output into the feature branch

**Given** the implementation step
**When** I inspect what it can reach
**Then** it holds no push credential and no production credential, and its container mounts only the worktree

**Given** a diff that begins to span files far outside the declared territory
**When** that happens
**Then** it is flagged as a signal rather than accepted as scope

**Given** the step is killed mid-edit
**When** it is re-run
**Then** the worktree is reset to its baseline first, so no edit is applied twice

### Story 4.11: Write the failing tests before the implementation runs

As Deep,
I want tests derived from the acceptance criteria written before any implementation exists,
So that definition-of-done is mechanical and the tests cannot be written from the same misunderstanding as the code.

**Acceptance Criteria:**

**Given** confirmed acceptance criteria
**When** the testing step runs
**Then** it writes tests from those criteria, and it runs before the implementation step

**Given** those tests
**When** they are first run
**Then** they fail, and a test that passes before any implementation exists is reported as suspect

**Given** the criteria describe an invariant
**When** tests are written
**Then** a property-based test is preferred over an example test

**Given** the testing step
**When** I inspect its inputs
**Then** it received the criteria and the request, not the implementation plan's rationale

### Story 4.12: Run the deterministic gate before spending on review

As Deep,
I want typecheck, lint and tests to run before any model-based review, and review skipped entirely when they fail,
So that I never spend model capacity reviewing code that does not compile.

**Acceptance Criteria:**

**Given** an implementation ready for verification
**When** verification begins
**Then** typecheck, lint and tests run first, using the commands named in the per-repo profile

**Given** the deterministic gate fails
**When** that happens
**Then** no model-based review runs at all, and the run records that review was skipped and why

**Given** the deterministic gate passes
**When** verification continues
**Then** the model-based review runs

**Given** the reconciler choosing its next action
**When** both a deterministic gate and a review are eligible
**Then** the ordering invariant is enforced by the engine rather than left to which action the loop happens to pick

### Story 4.13: Try to break the implementation

As Deep,
I want a tester whose job is to find failures, given only the request and the diff,
So that plausible-but-wrong code meets something actively looking for the gap rather than a reviewer inclined to agree.

**Acceptance Criteria:**

**Given** a diff that passed the deterministic gate
**When** the adversarial tester runs
**Then** it receives the original request and the diff, and nothing of the implementer's rationale

**Given** the adversarial tester
**When** it reports
**Then** it reports found failures, and finding none is recorded as a result rather than as an endorsement

**Given** the tester finds a failure
**When** that happens
**Then** the run does not proceed to commit, and the failure becomes a test

**Given** a failure the tester found once
**When** a later feature runs
**Then** the regression test it produced still runs

### Story 4.14: Classify every action by reversibility and gate on it

As Deep,
I want each action type classified by blast radius, with gating following the class rather than a trust level,
So that autonomy is safe exactly where it is undoable and I am asked only where it is not.

**Acceptance Criteria:**

**Given** the set of action types the system performs
**When** I inspect their classification
**Then** each carries exactly one declared reversibility class — reversible, recoverable or irreversible
**And** the class is attached to the action type, so one agent performing both a reversible and an irreversible action is expressible

**Given** a reversible action
**When** it is performed
**Then** it proceeds unattended with no approval

**Given** a recoverable action
**When** it is performed
**Then** it proceeds and notifies me afterward

**Given** an irreversible action
**When** it is reached
**Then** it blocks for explicit approval, and the block is visible in the mode display

**Given** an action with no declared class
**When** it is reached
**Then** it is treated as irreversible rather than permitted

### Story 4.15: Execute the enumerated write surface exactly once

As Deep,
I want every write to the outside world performed by the engine against an idempotency key, never by an agent,
So that a re-run cannot double-apply a side effect and no component is unsure whether a write already happened.

**Acceptance Criteria:**

**Given** the write surface
**When** I enumerate it
**Then** it is exactly: `git push`, pull request creation, git notes, tags, and every MCP domain mutation
**And** no agent performs any of them — agents declare intent in their typed output

**Given** a declared write intent
**When** the engine executes it
**Then** it does so once against an idempotency key derived from run id plus intent id

**Given** a write about to be attempted
**When** the attempt begins
**Then** a `write.attempted` record carrying that key is durable *before* the call is made

**Given** recovery finds an `attempted` record with no recorded outcome
**When** it reconciles
**Then** it checks the target's actual state rather than blindly re-executing

### Story 4.16: Commit to a branch only the committer names

As Deep,
I want one component that owns branch creation and naming, following a pattern declared once,
So that no other unit invents a branch name from a feature slug and the branch I look for is the branch that exists.

**Acceptance Criteria:**

**Given** a feature entering execution
**When** its branch is created
**Then** the committer creates it, and no other unit creates or names a branch

**Given** the branch name
**When** I inspect where the pattern is declared
**Then** it is declared once in the project profile, defaulting to `feature/<feature-slug>`

**Given** each step's output
**When** it is handed on
**Then** it was committed into the feature worktree, so `git log` is the timeline of the run

**Given** a feature slug
**When** another unit needs the branch name
**Then** it reads it from the committer's record rather than deriving it

### Story 4.17: Write the run's record as a git note on the merge commit

As Deep,
I want the committer to attach the run's timeline, cost and decisions to the merge commit as a git note,
So that the record survives after the worktree and central state are gone, on any machine that has the repository.

**Acceptance Criteria:**

**Given** a merged feature
**When** the merge commit is created
**Then** the committer writes a git note on it under a single named ref

**Given** that note
**When** I read it
**Then** it carries the run id, the ordered step list with each step's disposition, the acceptance criteria, usage totals and the decisions taken

**Given** the note's shape
**When** it is written
**Then** it is a versioned contract, and the committer is its only writer

**Given** a note written by an older version
**When** a newer reader reads it
**Then** it states which version wrote it rather than misinterpreting the content

### Story 4.18: Reconstruct a feature's timeline from git alone

As Deep,
I want to recover what happened to a feature from `git log` and notes with nothing else present,
So that the record outlives the machine it ran on.

**Acceptance Criteria:**

**Given** a merged feature, and central state deleted entirely
**When** I read `git log` and the notes ref
**Then** I can reconstruct the full agent timeline for that feature

**Given** the two records
**When** I compare them
**Then** the git note is the durable in-repository record and the event log is the full-fidelity record, with the relationship between them stated rather than implied

**Given** a clone of the repository on a machine that never ran the orchestrator
**When** I read the notes ref
**Then** the timeline is legible without orchestrator tooling installed

### Story 4.19: Open a pull request under my own identity

As Deep,
I want commits and pull requests authored as me, with a PR opened by default rather than a push to a shared branch,
So that the history is mine and review is the default path rather than an opt-in.

**Acceptance Criteria:**

**Given** any commit the system creates
**When** I inspect its author and committer
**Then** both are my own git identity, and no bot identity exists anywhere in the system

**Given** a verified feature
**When** the committer finishes
**Then** it opens a pull request by default rather than pushing to a shared branch

**Given** the pull request body
**When** I read it
**Then** it points at the lines that need my eyes and says why, rather than dumping the diff
**And** it states what was verified and what was not

**Given** the pull request
**When** it is created
**Then** creation went through the engine's write surface with an idempotency key, so a re-run does not open a second one

---

## Epic 5: Onboarding Any Repository

Deep points `npx github:<owner>/<repo> init` at a repository the system has never seen, answers the interview, and ships a feature there with zero engine code changes. Moving or renaming that repository does not lose its history.

### Story 5.1: Onboard a repository with one command

As Deep,
I want a single interactive command that sets a repository up, writing only into a directory I can review,
So that every project is onboarded the same way and I never hand-scaffold one.

**Acceptance Criteria:**

**Given** a target repository
**When** I run `npx github:<owner>/<repo> init`
**Then** it runs interactively and writes only into `<target-repo>/.orch/` and appends runtime paths to `.gitignore`

**Given** the installer has run
**When** I inspect the target repository
**Then** `.orch/` contains `profile.toml`, `permissions.toml`, `manifest.toml` and `agents/`, and `.orch/` itself is committed
**And** nothing else in the repository was modified

**Given** the installer
**When** I inspect what it bundles
**Then** it bundles no credential, and I authenticate with my own Claude Code login

**Given** any other onboarding route
**When** I look for one
**Then** none is supported — not clone-and-run, and not a published npm package

### Story 5.2: Ask the interview that produces a working profile

As Deep,
I want the installer to ask exactly what it needs to produce a usable profile, offering detected defaults,
So that onboarding is minutes of confirming rather than an hour of authoring configuration.

**Acceptance Criteria:**

**Given** the installer runs
**When** it interviews me
**Then** it asks, in order: target path; confirmation of the detected project id and remote; package manager and the test, lint, build and run commands with detected defaults offered; source layout; resource needs; high-blast-radius paths; conflict-domain hints; branch-name pattern defaulting to `feature/<slug>`; external domains and the environment variable *names* holding their credentials; which built-in agents to enable; per custom agent its id, purpose, contract, granted tools and domains, starting model rung and reversibility class; autonomy start level defaulting to shadow-only; and the three ceiling defaults

**Given** the question about credentials
**When** I answer it
**Then** I supply environment variable names and never values, and the installer refuses a value that looks like a secret

**Given** detected defaults
**When** they are offered
**Then** accepting them is the fast path and I can override any of them

**Given** the interview completes
**When** I review the profile before first use
**Then** it is presented for review, and the system records that I reviewed it

### Story 5.3: Make a half-install detectable and recoverable

As Deep,
I want the installer to record a schema version and a manifest of everything it created,
So that an interrupted install is a known state I can recover from rather than undefined behaviour.

**Acceptance Criteria:**

**Given** a completed install
**When** I inspect `manifest.toml`
**Then** it lists every file the installer created, and carries a `schema_version`

**Given** an install interrupted partway
**When** the installer or engine next runs
**Then** the incomplete state is detected by comparing the manifest against what exists on disk, and is reported as recoverable

**Given** an `.orch/` written by an older installer
**When** a newer engine reads it
**Then** it refuses to operate on an unrecognised version and states which installer version wrote it

**Given** any on-disk artifact under `.orch/`
**When** I inspect it
**Then** it carries a `schema_version`

### Story 5.4: Re-run the installer without losing my answers

As Deep,
I want upgrading to be a re-run of the installer that keeps what I already told it,
So that upgrading costs me nothing and never silently resets a decision.

**Acceptance Criteria:**

**Given** an existing `.orch/` with my answers
**When** I re-run the installer
**Then** existing answers are preserved and only missing answers are asked

**Given** a re-run with no missing answers
**When** it completes
**Then** the resulting files are unchanged, so the installer is idempotent

**Given** a new question introduced by a later version
**When** I re-run
**Then** only that question is asked

**Given** a re-run
**When** it writes
**Then** the manifest is updated to reflect the new state, and files it no longer creates are reported rather than silently orphaned

### Story 5.5: Identify a project by its first commit

As Deep,
I want a project keyed by the SHA of its first commit rather than by its path,
So that moving or renaming a directory does not split one project into two in the system's memory.

**Acceptance Criteria:**

**Given** a repository being registered
**When** registration happens
**Then** the project id is the SHA of its first commit, recorded once

**Given** a registered project whose directory has moved
**When** the system resolves it
**Then** the recorded path is updated to the new location, the path being an explicitly mutable pointer

**Given** a repository with no commits
**When** I try to register it
**Then** registration is refused until it has one, with a message saying why

**Given** two repositories sharing a first commit
**When** both are registered
**Then** the collision is reported rather than silently merging them

### Story 5.6: Never infer abandonment from a missing path

As Deep,
I want an unresolvable project path to be marked rather than cleaned up,
So that a repository I merely moved does not have its accumulated history destroyed by a reclamation sweep.

**Acceptance Criteria:**

**Given** a registered project whose recorded path no longer resolves
**When** the system notices
**Then** the registration is marked `unlocated` and nothing is deleted

**Given** an `unlocated` project
**When** the reclamation sweep runs
**Then** its central state is untouched

**Given** I want a project's state removed
**When** I ask for it
**Then** deletion requires an explicit prune naming the project id, and confirms what will be removed before doing it

**Given** a moved repository
**When** it is re-registered from its new location
**Then** it reattaches to its existing history by first-commit SHA rather than creating a second project

### Story 5.7: Load the profile with fixed precedence against the repository's own instructions

As Deep,
I want the profile authoritative for mechanics and the repository authoritative for conventions, with a key-level rule rather than a judgement call,
So that two steps can never follow different guidance because they weighted two documents differently.

**Acceptance Criteria:**

**Given** the profile
**When** I inspect which keys it owns
**Then** it owns exactly: test, lint, build and run commands, package manager, source layout, resource needs, risk tiers and conflict-domain hints — and the list is closed

**Given** anything outside that list
**When** the repository's own instructions speak to it
**Then** the repository is authoritative and the profile entry is flagged stale rather than silently applied

**Given** a profile knowledge entry
**When** I inspect it
**Then** it carries provenance and a decay policy of permanent, until-refactor, N-features or session

**Given** a profile entry whose anchor no longer resolves
**When** the re-validation sweep runs
**Then** the entry is flagged

### Story 5.8: Discover the agent roster from configuration alone

As Deep,
I want the engine to learn its agents by reading a directory, holding no built-in list,
So that an agent I define is visible to the whole system rather than to half of it.

**Acceptance Criteria:**

**Given** the engine starting
**When** it assembles its roster
**Then** it reads `<target-repo>/.orch/agents/` and holds no compiled-in agent list

**Given** an agent TOML
**When** I inspect it
**Then** it declares an id, a reference to a registered contract id, its granted tools and MCP domains, its reversibility ceiling, and a `model` field naming a starting rung and a promotion policy
**And** it contains no inline schema, contracts being Zod schemas in code

**Given** granted tools
**When** I look for where they are declared
**Then** exactly one file owns the declaration, or a stated precedence rule resolves `permissions.toml` against `agents/<id>.toml` — and a value declared in both is an error naming both files

**Given** a new agent reusing an existing contract
**When** I add its TOML
**Then** it works with no engine change
**And** an agent needing a genuinely new contract shape requires a code change, and the system says so rather than failing obscurely

### Story 5.9: Complete a feature in a repository the system has never seen

As Deep,
I want to onboard an unfamiliar repository and ship a feature in it without touching engine code,
So that the engine is genuinely universal rather than tuned to one project.

**Acceptance Criteria:**

**Given** a repository the system has never seen, in a stack it was not built against
**When** I onboard it and request a feature
**Then** the feature completes end to end with no modification to engine code

**Given** that run
**When** I inspect what it read for mechanics
**Then** it used the profile's declared commands rather than guessing or hardcoding

**Given** the run's configuration
**When** a step reads it
**Then** it reads the immutable per-run snapshot taken at run start, so a mid-run edit to `.orch/` cannot affect it
**And** a feature branch that edits `.orch/` does not change the configuration of the run editing it

### Story 5.10: Ship nothing that depends on the design-time toolchain

As Deep,
I want the delivered system to have no dependency on BMad,
So that the tooling I planned with does not leak into the product I run.

**Acceptance Criteria:**

**Given** `<target-repo>/.orch/` after an install
**When** I inspect every file
**Then** none references `_bmad`, a BMad skill or a BMad command

**Given** the runtime code paths
**When** I search them
**Then** no path requires BMad to be present

**Given** the templates the installer writes from
**When** I inspect them
**Then** no BMad file is among them

**Given** a machine with no BMad installed
**When** I install and run the orchestrator
**Then** everything works

---

## Epic 6: Web Control Surface, Shadow Mode and Measurement

Deep can watch and steer a run from a browser without the terminal becoming secondary, and — more importantly — run the system against features he already built, to find out empirically whether it has earned trust. This epic delivers the Stage 3 gate.

### Story 6.1: Serve the run on loopback as a second renderer

As Deep,
I want a local web surface that reads the same event stream and writes the same command files,
So that I get a richer view when I want one without the terminal becoming a degraded second-class path.

**Acceptance Criteria:**

**Given** the web server running
**When** I inspect what it binds to
**Then** it binds loopback only and serves a single local user

**Given** a live run
**When** I watch it in the browser
**Then** it streams the event log over SSE

**Given** I issue a steering control in the browser
**When** it is recorded
**Then** it writes the same durable intent file the terminal writes, with its principal recorded — the server is an accelerator, never a second command path

**Given** the web server is stopped
**When** I work through a run
**Then** every control remains available through the file path with no loss of capability

### Story 6.2: Render the same historical run identically in both surfaces

As Deep,
I want both surfaces to be projections of one log, with neither authoritative,
So that closing one loses nothing and I never have to reason about which view is right.

**Acceptance Criteria:**

**Given** a completed run
**When** I open it in the TUI and in the browser
**Then** both render the same history, and any difference is presentation only

**Given** either surface
**When** I close it mid-run
**Then** no data is lost, because neither holds state the log does not

**Given** the set of steering controls
**When** I compare the two surfaces
**Then** both implement every member of the shared `Command` enum, and a control present in one and absent from the other fails compilation

**Given** an event type one surface does not recognise
**When** it renders
**Then** it skips the event rather than failing the render

### Story 6.3: Run a feature in shadow mode, writing nothing

As Deep,
I want a shadow run to be an ordinary run with its writes recorded and not executed,
So that what I measure is the real pipeline rather than a parallel implementation of it.

**Acceptance Criteria:**

**Given** a shadow run
**When** I inspect its state
**Then** it carries `mode: shadow`, and it is otherwise an ordinary run

**Given** a shadow run
**When** a write intent is reached
**Then** the intent executor and the committer record it and execute none of it

**Given** a shadow run
**When** I compare every other component's behaviour against a live run
**Then** they behave identically

**Given** a completed shadow run
**When** I inspect the repository and every external domain
**Then** nothing was written anywhere

### Story 6.4: Compare a shadow run against what was actually committed

As Deep,
I want a report diffing what the system would have done against what I really did,
So that trust is empirical rather than a feeling.

**Acceptance Criteria:**

**Given** an already-built historical feature
**When** I run shadow mode against it
**Then** a comparison report is produced diffing the system's output against the real commit

**Given** that report
**When** I read it
**Then** it states whether the diff would have been accepted without material change, and lists every write intent that was recorded but not executed

**Given** a recorded write intent that would have been destructive
**When** the report is produced
**Then** it is called out separately from ordinary intents, because one is too many

**Given** the report
**When** it is generated
**Then** no write to the repository occurred in producing it

### Story 6.5: Keep a trust record per area

As Deep,
I want a per-area history of what merged unchanged versus what I had to correct,
So that unlocking autonomy is justified by evidence about that part of the codebase rather than by a global impression.

**Acceptance Criteria:**

**Given** a merged feature
**When** it is recorded
**Then** the trust record gains an entry for the area it touched, noting whether it merged unchanged or was corrected

**Given** the trust record
**When** I inspect it
**Then** it has a declared owner, a declared location and a versioned schema

**Given** an area with no history
**When** autonomy is considered for it
**Then** the absence of history is treated as untrusted rather than as neutral

**Given** the trust record
**When** it is queried
**Then** it is derivable from the event log and git, so losing it is recoverable

### Story 6.6: Measure rework, deflection, interruptions and usage

As Deep,
I want the four numbers that tell me whether this is working,
So that the stage gate is a measurement rather than a judgement, and I can see the success signal moving.

**Acceptance Criteria:**

**Given** a set of completed features
**When** I ask for metrics
**Then** rework rate, deflection rate, interruption count and usage per feature are reported

**Given** a rolling window of at least twenty shadow runs in one project
**When** the gate is evaluated
**Then** it reports the percentage producing a diff accepted without material change, and the count producing a destructive write intent
**And** the gate passes only at eighty percent or above *and* a destructive count of exactly zero

**Given** the interruption metric
**When** it is computed
**Then** it reports the proportion of features completing with zero mid-flight interruptions, against the sixty percent target

**Given** these metrics
**When** I inspect where they come from
**Then** they are a fold over the event log, with no separate datastore

### Story 6.7: Resolve a feature name to its runs

As Deep,
I want to name a feature and have the system find its runs,
So that surfaces addressed by feature name do not require scanning every run on the machine on every render.

**Acceptance Criteria:**

**Given** a feature name
**When** I use it in any surface
**Then** the system resolves it to the relevant runs without my supplying a run id

**Given** the morning brief rendering
**When** it needs every in-flight feature
**Then** the resolution path does not require scanning every `events.jsonl` under the state root on each render

**Given** whatever structure serves this resolution
**When** I inspect it
**Then** it is a derived projection reconstructable by replaying the logs, so losing it costs nothing but time

**Given** two features with the same name in different projects
**When** I name one
**Then** the ambiguity is surfaced and resolved by project, not silently picked

---

## Epic 7: Unattended Autonomy

Deep leaves and comes back to merged work. Reversibility classes are enforced end to end, all four steering controls demonstrably affect a live run, and the system refuses to run unattended until every one of the seventeen v0 guardrails exists and has been exercised on purpose. This epic delivers the Stage 4 gate.

### Story 7.1: Enforce reversibility classes end to end

As Deep,
I want the classification from Epic 4 enforced at every point an action is taken, with approvals attributable,
So that autonomy is bounded by blast radius in practice and not only in the declaration.

**Acceptance Criteria:**

**Given** every action type in the system
**When** I audit them
**Then** each is classified, the classification is attached to the action rather than to the agent, and the full table fits one screen

**Given** an agent whose actions span two classes — committing locally and pushing
**When** it runs
**Then** the reversible action proceeds and the irreversible one blocks independently, rather than the whole agent taking the coarser treatment

**Given** an irreversible action blocking for approval
**When** I approve it
**Then** the approval is recorded with the principal that gave it, and the record is durable before the action proceeds

**Given** an action type added later
**When** it is reached with no declared class
**Then** it is treated as irreversible, and the missing declaration is reported

**Given** an undo exists for an action
**When** I inspect the design record
**Then** the undo was designed before the action, so wherever an undo exists autonomy is free

### Story 7.2: Steer a live run four ways

As Deep,
I want to pause, inject a note into, kill, and fork a running agent from the timeline,
So that observing a run and intervening in it are the same activity rather than two.

**Acceptance Criteria:**

**Given** a live run
**When** I pause it from the timeline
**Then** it stops taking new actions and leaves resumable state, and resuming continues rather than restarting

**Given** a live run
**When** I inject a note
**Then** the note reaches the running work, is recorded as an event, and influences the step without my having to restate the feature

**Given** a live run
**When** I kill a step
**Then** it records the disposition `killed` and the reconciler neither resumes nor re-runs it

**Given** a live run
**When** I fork it
**Then** a second run begins from the current state, and the original is unaffected

**Given** each of the four controls
**When** the epic is complete
**Then** each has been demonstrated to affect a live run, and each is a member of the shared `Command` enum available from both surfaces and from the file path

### Story 7.3: Refuse to run unattended until every guardrail exists

As Deep,
I want the engine to check the complete guardrail set before it will run unattended, and refuse if anything is missing or untested,
So that the precondition is mechanical rather than something I have to remember.

**Acceptance Criteria:**

**Given** a request to run unattended
**When** the engine evaluates the precondition
**Then** it checks all seventeen v0 guardrails and refuses unless each exists *and* has been exercised at least once on purpose

**Given** a refusal
**When** I read it
**Then** it names exactly which guardrails are missing or unexercised

**Given** each guardrail's exercise
**When** it happens
**Then** it is recorded durably, so "exercised once" is evidence rather than an assertion

**Given** the precondition passes
**When** the run proceeds
**Then** the passing evaluation is recorded as an event against that run, so a run can be attributed to the guardrail state that permitted it

**Given** a guardrail that regresses after having passed
**When** the precondition is next evaluated
**Then** it fails again rather than trusting the earlier record

### Story 7.4: Kill an agent mid-run on purpose and confirm the system halts cleanly

As Deep,
I want to run the chaos drill deliberately before trusting the system overnight,
So that I discover fragility on my own schedule rather than during a real run.

**Acceptance Criteria:**

**Given** a live run
**When** I kill a random agent mid-run as a drill
**Then** the system halts or degrades cleanly, and does not corrupt state

**Given** the drill
**When** it completes
**Then** the event log is intact and parseable, and the run is resumable from it

**Given** the drill
**When** I invoke the escape hatch afterward
**Then** it works, producing an ordinary branch and detaching

**Given** the drill
**When** it has been run
**Then** the result is recorded, and it is a precondition of the first unattended night rather than an exercise done afterward

### Story 7.5: Unlock autonomy per risk tier from measured accuracy

As Deep,
I want autonomy granted per risk tier on the evidence in the trust record, not as a global switch,
So that one good stretch does not unlock everything and one bad merge does not cost me the whole system.

**Acceptance Criteria:**

**Given** the system's starting state
**When** I inspect its autonomy level
**Then** it is shadow-only — the system proposes and I merge

**Given** a risk tier whose trust record meets the stage-3 threshold
**When** autonomy is evaluated for it
**Then** that tier alone is unlocked, and other tiers are unaffected

**Given** an unlock
**When** it happens
**Then** the measurement that justified it is recorded alongside it

**Given** shadow-mode accuracy that is flat or falling across a stage
**When** the tripwire is evaluated
**Then** it fires as a signal to stop extending the system rather than to unlock further

**Given** a merge that I then had to correct
**When** it is recorded
**Then** the trust record for that area reflects it and the affected tier's autonomy is reconsidered

### Story 7.6: Tell the system to stop asking

As Deep,
I want a first-class instruction that means use your judgement and show me the result,
So that when I already trust a piece of work I can spend zero attention on it without changing a global setting.

**Acceptance Criteria:**

**Given** a feature in progress
**When** I issue `just-do-it`
**Then** the system stops raising questions it would otherwise ask, uses its judgement, and reports at the end

**Given** `just-do-it` is active
**When** an irreversible action is reached
**Then** it still blocks for approval — the instruction narrows questions, never the reversibility gate

**Given** `just-do-it` is active
**When** I look at the mode display
**Then** it reflects that, so I am never wrong about which mode I am in

**Given** decisions taken under `just-do-it`
**When** the feature completes
**Then** they are listed in the completion notice, so judgement calls are visible after the fact

---

## Epic 8: Compounding — Memory, Ledger and Cross-Repo Patterns

A question Deep answers once never reaches him again. Knowledge from completed features makes later features cheaper without inflating any run's context, and a pattern learned building one product is available when building the next. Deferred to Stage 5 deliberately: below roughly twenty features this layer is pure overhead.

### Story 8.1: Append to an episodic log during a run

As Deep,
I want a run to write to a fast, lossy episodic log and never to long-term memory,
So that a failed experiment cannot poison what the system believes.

**Acceptance Criteria:**

**Given** a run in progress
**When** it learns something
**Then** it appends to the episodic log for that feature, and writes nothing to long-term memory

**Given** a run that failed or was abandoned
**When** it ends
**Then** its learnings remain in episodic memory only

**Given** the episodic log
**When** I inspect its cost
**Then** writing to it is cheap and lossy by design, with no structuring work done during the run

**Given** any long-term memory write
**When** I trace its origin
**Then** it came from a verified, merged outcome — never from a run in progress

### Story 8.2: Consolidate a finished feature into structured facts

As Deep,
I want a pass that runs between features or nightly and compacts episodic logs into durable facts,
So that structuring happens when the outcome is known and my attention is elsewhere.

**Acceptance Criteria:**

**Given** a completed, merged feature
**When** the consolidation pass runs
**Then** its episodic log is compacted into structured facts

**Given** the pass
**When** I inspect when it runs
**Then** it runs between features or nightly, never during a run

**Given** a feature containing both successes and failures
**When** it is consolidated
**Then** failures are weighted above successes

**Given** consolidated facts
**When** I inspect their form
**Then** they are structured data, never prompt text, so a model change does not invalidate them

**Given** the committer
**When** a feature merges
**Then** it records what was learned, learning being a pipeline step with a named owner

### Story 8.3: Load memory in tiers under a read budget

As Deep,
I want memory loaded in tiers with a declared per-feature read budget,
So that accumulated knowledge never becomes the thing that inflates a run's context.

**Acceptance Criteria:**

**Given** any run
**When** memory is loaded
**Then** L1 (the per-repo profile) is always loaded, L2 (per-directory notes) loads on touching that region, L3 (the retrieval index) loads on query, and git plus the event log are read on demand only

**Given** a feature
**When** retrieval happens
**Then** it respects a declared per-feature read budget, and the budget is recorded alongside what was actually read

**Given** the budget is reached
**When** more retrieval is attempted
**Then** it stops rather than exceeding the budget, and the truncation is recorded

**Given** a region of the codebase never touched by a feature
**When** the feature runs
**Then** that region's notes are not loaded

### Story 8.4: Give every entry a decay policy and a durable anchor

As Deep,
I want every memory entry to declare when it stops being true and to point at something that does not move,
So that invalidation — the problem that dominates past a thousand features — is handled from the first entry rather than retrofitted.

**Acceptance Criteria:**

**Given** any memory entry being written
**When** it is written
**Then** it carries a decay policy chosen at write time: permanent, until-refactor, N-features or session

**Given** an entry's anchor
**When** I inspect it
**Then** it is a test name, a public API symbol, a module name or a file path, in that order of preference
**And** a line number is never accepted as an anchor

**Given** an entry's content
**When** I inspect it
**Then** it holds a question and its durable answer, or a pointer — never a code snippet

**Given** something `git log` or `git blame` can answer
**When** memory is written
**Then** it is not stored

### Story 8.5: Rewrite anchors on rename and sweep for dead ones

As Deep,
I want the committer to fix anchors when it renames things, and a periodic sweep to flag anchors that no longer resolve,
So that memory cannot quietly drift behind the code it describes.

**Acceptance Criteria:**

**Given** a commit that renames a symbol, test or module
**When** the committer processes it
**Then** memory anchors referencing the old name are rewritten as part of that commit

**Given** the periodic sweep
**When** it runs
**Then** it samples entries, checks whether their anchors still resolve, and flags the dead ones

**Given** a flagged entry
**When** I inspect it
**Then** it is marked rather than deleted, so a false positive costs nothing

**Given** an entry whose anchor was rewritten
**When** I look at its history
**Then** the rewrite is traceable

### Story 8.6: Count retrievals, then promote and prune

As Deep,
I want hit-counts tracked from the very first entry, with promotion toward L1 and pruning of what is never read,
So that the store stays small enough to be worth querying.

**Acceptance Criteria:**

**Given** any retrieval
**When** it happens
**Then** the retrieved entry's hit count increments

**Given** an entry retrieved repeatedly
**When** promotion is evaluated
**Then** it promotes toward L1

**Given** an entry never retrieved
**When** pruning is evaluated
**Then** it is pruned

**Given** the first entry ever written
**When** I inspect it
**Then** hit-counting was already active, because pruning is impossible without it

### Story 8.7: Convert a checkable memory into a lint rule or a test

As Deep,
I want anything checkable turned into an artifact that enforces itself rather than a fact to retrieve,
So that the cheapest memory costs nothing at read time.

**Acceptance Criteria:**

**Given** a convention the system has learned
**When** it is checkable
**Then** it becomes a lint rule rather than a retrievable entry

**Given** a past failure
**When** it is recorded
**Then** it becomes a regression test that runs thereafter

**Given** an incident with security implications
**When** it is recorded
**Then** it becomes a guardrail rather than a note

**Given** something irreducibly fuzzy
**When** it is recorded
**Then** retrieval is used — as the fallback, not the default

**Given** the repository
**When** conventions become lint rules
**Then** the repository can lint itself, which is why the compiler pin is what it is

### Story 8.8: Answer a question once and never be asked again

As Deep,
I want an answer I give to become a rule later agents check before asking,
So that the same decision never costs me attention twice.

**Acceptance Criteria:**

**Given** a question I resolve
**When** it is recorded
**Then** it writes an entry to the decision ledger
**And** a question resolved by timeout default also writes one, logged as a decision

**Given** an unresolved or deflected question
**When** the ledger is written
**Then** nothing is written for it — only resolved questions become rules

**Given** the same question arising on a later feature
**When** it is raised
**Then** it resolves from the ledger without reaching me, and is recorded as deflected

**Given** a rejection I gave with a reason
**When** it is recorded
**Then** the reason becomes a ledger entry

**Given** the ledger
**When** I inspect where it lives
**Then** it is per-project under the project's central state, keyed by project id

### Story 8.9: Carry an abstract pattern between projects

As Deep,
I want a pattern learned building one product available when I build another, without any code travelling with it,
So that the leverage compounds across products rather than within one.

**Acceptance Criteria:**

**Given** a pattern recorded while working in project A
**When** I start work in project B
**Then** the pattern is retrievable there

**Given** any cross-project entry
**When** I inspect its content
**Then** it holds an abstract pattern only — no code snippets and no concrete specifics of project A

**Given** cross-project memory
**When** I inspect where it lives
**Then** it is under the machine-level memory directory, because it spans projects and can belong to no repository

**Given** a retrieved cross-project pattern
**When** it is applied
**Then** the application is recorded, so the value of cross-repo memory is measurable

### Story 8.10: Rebuild memory from git and the event log

As Deep,
I want to be able to lose the memory index and get almost all of it back,
So that the store is a convenience rather than a thing I have to protect.

**Acceptance Criteria:**

**Given** the memory index deleted entirely
**When** it is rebuilt from git history plus the event log
**Then** at least ninety percent of entries regenerate

**Given** the rebuild
**When** it runs
**Then** it needs no datastore other than git and the event log

**Given** entries that cannot regenerate
**When** the rebuild completes
**Then** they are reported, so the irrecoverable ten percent is known rather than assumed

**Given** a rebuilt index
**When** I compare it against the original
**Then** hit-counts and decay policies are restored or explicitly reset, never silently defaulted

### Story 8.11: Report retrieval cost against rework reduction

As Deep,
I want the number that says whether this layer is worth its cost,
So that I can delete it if it is not, which is the only honest reason to build it.

**Acceptance Criteria:**

**Given** a period of operation with memory active
**When** I ask for the measurement
**Then** it reports retrieval token cost against measured reduction in rework

**Given** that number is not positive
**When** I read the report
**Then** it says so plainly, with removal of the memory layer named as the indicated response

**Given** the measurement
**When** I inspect its inputs
**Then** the rework figure comes from the same source as the Epic 6 rework metric, so the two cannot disagree

**Given** insufficient data to compute it
**When** I ask
**Then** it says so rather than reporting a number it cannot support

### Story 8.12: Generate a per-repo profile automatically

As Deep,
I want a bootstrap agent that writes a profile for an unfamiliar repository,
So that onboarding the tenth project costs what onboarding the second did.

**Acceptance Criteria:**

**Given** a repository with no profile
**When** the bootstrap agent runs
**Then** it produces a profile naming the stack, the test, lint, build and run commands, the source layout and the resource needs

**Given** a generated profile
**When** it is written
**Then** it is presented for my review before first use, and the system records that I reviewed it

**Given** a generated profile
**When** I compare its keys against the closed list of profile-owned mechanics
**Then** it writes only those keys and adds nothing the repository's own instructions own

**Given** a generated profile entry
**When** I inspect it
**Then** it carries provenance and a decay policy like any other knowledge entry

**Given** a feature run against a bootstrapped profile
**When** it completes
**Then** it did so with no engine modification

---

## Traceability

All 106 FRs and all 35 UX-DRs are covered by at least one story. Verified programmatically.

### FR → Story Traceability

| FR | Story | FR | Story | FR | Story |
|---|---|---|---|---|---|
| FR1 | 4.1 | FR2 | 4.1 | FR3 | 4.2 |
| FR4 | 4.3 | FR5 | 4.3 | FR6 | 4.2 |
| FR7 | 4.4 | FR8 | 4.5 | FR9 | 4.4 |
| FR10 | 4.5 | FR11 | 1.8 | FR12 | 1.9 |
| FR13 | 1.8 | FR14 | 1.8 | FR15 | 8.8 |
| FR16 | 8.8 | FR17 | 1.10, 1.15 | FR18 | 1.13 |
| FR19 | 7.2 | FR20 | 1.7 | FR21 | 1.7 |
| FR22 | 1.14 | FR23 | 1.14 | FR24 | 3.4 |
| FR25 | 3.5 | FR26 | 3.5 | FR27 | 3.3 |
| FR28 | 3.3 | FR29 | 3.2 | FR30 | 3.4 |
| FR31 | 3.1 | FR32 | 3.10 | FR33 | 3.8 |
| FR34 | 3.9 | FR35 | 4.6 | FR36 | 4.6 |
| FR37 | 4.6, 3.2 | FR38 | 4.7 | FR39 | 4.7 |
| FR40 | 4.7 | FR41 | 4.16 | FR42 | 4.17 |
| FR43 | 4.18 | FR44 | 4.16 | FR45 | 4.17 |
| FR46 | 3.6 | FR47 | 3.6 | FR48 | 3.7 |
| FR49 | 3.6 | FR50 | 2.1 | FR51 | 2.2 |
| FR52 | 2.4 | FR53 | 2.5 | FR54 | 2.6 |
| FR55 | 2.6 | FR56 | 2.6 | FR57 | 2.7 |
| FR58 | 4.14 | FR59 | 4.14 | FR60 | 4.15 |
| FR61 | 4.15 | FR62 | 4.11 | FR63 | 4.12 |
| FR64 | 4.12 | FR65 | 4.13 | FR66 | 6.2 |
| FR67 | 6.2 | FR68 | 1.7 | FR69 | 1.10 |
| FR70 | 6.1 | FR71 | 1.12 | FR72 | 1.15 |
| FR73 | 3.11 | FR74 | 3.11 | FR75 | 3.12 |
| FR76 | 1.15 | FR77 | 3.13 | FR78 | 3.13 |
| FR79 | 3.14 | FR80 | 8.1 | FR81 | 8.2 |
| FR82 | 8.3 | FR83 | 8.3 | FR84 | 8.4 |
| FR85 | 8.6 | FR86 | 8.5 | FR87 | 8.5 |
| FR88 | 8.7 | FR89 | 8.9 | FR90 | 8.10 |
| FR91 | 8.11 | FR92 | 5.1 | FR93 | 5.2 |
| FR94 | 5.3 | FR95 | 5.4 | FR96 | 5.7 |
| FR97 | 5.8 | FR98 | 5.9 | FR99 | 8.12 |
| FR100 | 5.5 | FR101 | 5.6 | FR102 | 5.6 |
| FR103 | 6.3 | FR104 | 6.4 | FR105 | 6.5 |
| FR106 | 7.5 |  |  |  |  |

### UX-DR → Story Traceability

| UX-DR | Story | UX-DR | Story | UX-DR | Story |
|---|---|---|---|---|---|
| UX-DR1 | 1.12 | UX-DR2 | 1.11 | UX-DR3 | 4.2, 4.3 |
| UX-DR4 | 1.13 | UX-DR5 | 1.16 | UX-DR6 | 1.14 |
| UX-DR7 | 1.15 | UX-DR8 | 6.5 | UX-DR9 | 1.8 |
| UX-DR10 | 1.8 | UX-DR11 | 1.8, 1.11 | UX-DR12 | 1.10 |
| UX-DR13 | 1.8 | UX-DR14 | 1.11 | UX-DR15 | 1.11 |
| UX-DR16 | 1.11 | UX-DR17 | 1.11 | UX-DR18 | 1.16 |
| UX-DR19 | 1.10 | UX-DR20 | 1.10 | UX-DR21 | 1.10 |
| UX-DR22 | 4.1 | UX-DR23 | 1.10 | UX-DR24 | 1.16, 4.19 |
| UX-DR25 | 4.19 | UX-DR26 | 1.15 | UX-DR27 | 1.13 |
| UX-DR28 | 1.10 | UX-DR29 | 1.10, 1.15 | UX-DR30 | 1.10 |
| UX-DR31 | 1.13 | UX-DR32 | 7.6 | UX-DR33 | 1.11 |
| UX-DR34 | 1.10 | UX-DR35 | 1.7, 6.2 |  |  |

### Stories carrying Additional Requirements only

These stories implement architecture decisions, guardrails or stage gates rather than a numbered FR. They are not gaps.

- Story 1.1
- Story 1.2
- Story 1.3
- Story 1.4
- Story 1.5
- Story 1.6
- Story 2.3
- Story 2.8
- Story 4.8
- Story 4.9
- Story 4.10
- Story 5.10
- Story 6.6
- Story 6.7
- Story 7.1
- Story 7.3
- Story 7.4
