# Agent Orchestration System — Intent

## 1. Context

Build the factory floor Deep uses to build other products: a reusable agent-orchestration system that generalizes across projects, not tooling for one repo. Terminal-first, git-native, observable. Scope of this document: the **v0 spine** as the concrete plan, and the **target architecture** as what the spine aims at.

## 2. Target architecture

- **Split the orchestrator into Interviewer + workflow engine.** The current "orchestrator" fuses a conversation and a scheduler; separate them. The Interviewer is the *only* live LLM conversation — its job is question compression (merge N subagent questions into 1 human question) and spec echo (restate the request as acceptance criteria for one-keystroke confirmation).
- **Deterministic workflow engine, LLM only at the leaves.** The pipeline is code, not a model deciding what comes next — large token savings and far higher reliability.
- **Agents as pure functions.** Stateless; typed input file in, typed output file out. Makes every step resumable, unit-testable, replayable, and crash-safe.
- **Capability tokens, not policy, enforce domain ownership.** The jira credential exists in exactly one sandbox; agents cannot disobey what they cannot reach. Ownership becomes physics instead of instructions.
- **Control plane vs evidence plane.** Thin schema'd control channel enters context; fat evidence (transcripts, diffs, telemetry) lives on disk and is written by the runtime, never by agents describing themselves. The orchestrator holds pointers + one-line summaries, reading a full artifact only when a decision requires it. Build the evidence plane once; two-channel output, pointer-holding and free telemetry all fall out of it.
- **Git as the message bus, plus git notes.** Every handoff is a commit; `git log` is the timeline. One decision solves comms, observability, replay, flight recorder and swarm stigmergy. Git notes carry reasoning/cost/decisions with the repo — zero extra infra.
- **Memory layer.** Historian agent (cheap model, large retrieval index over the flight recorder, answers "have we done this before"), cross-repo global memory (patterns from product A available in product B — the actual leverage of one-system-many-products), and a decision ledger (every answer Deep gives becomes a durable project rule, checked before anyone asks again). Absent from the original spec; this is the compounding advantage.
- **Reversibility-tiered autonomy.** Auto-approve reversible actions, gate irreversible ones; engineer for reversibility (worktree, branch, canary, auto-revert) so autonomy is safe by construction.
- **Pooled/leased resources, permanent artifacts.** Pre-warmed containers leased to worktrees and wiped on return; kill the compute on merge, keep the flight recorder forever and indexed.

## 3. v0 spine (build order)

1. **Event log + git-as-bus.** Append-only event store (SQLite file per feature) with git commits as handoffs. Everything downstream is a projection of this.
2. **Deterministic engine with 3 agents, not 8.** Code-driven pipeline; agents are pure functions over typed files. Collapse the 8-role spec to the minimum that ships a feature.
3. **TUI on the event stream.** Terminal-first, single renderer of the event log. Web dashboard is a *second* renderer of the same stream, later.
4. **Shadow mode.** Run the system against features Deep already built; diff its output against the real commit. Earn trust empirically before delegating anything.
5. **Earn autonomy.** Unlock per reversibility tier only as shadow-mode accuracy accrues.

**NOT in v0:** web dashboard; swarm/stigmergy machinery; speculative N-parallel execution and voting; hierarchy of orchestrators; OTel/Jaeger stack; canary/deploy/auto-revert pipeline; ambient backlog; time-travel replay UI; model-ladder auto-tuning; interrupt budgets and escalation auctions; region-owning stateful agents; hibernation/snapshot pooling.

**Stop-building tripwires.** The likeliest project-killer is *maintenance burden* — the orchestrator eating the time it was built to save. Therefore: build on Claude Code's existing primitives (subagents, hooks, MCP, worktrees) as config plus small scripts, never a bespoke platform. Shadow mode and dry-run exist to tell Deep when to **stop building**. Halt/reassess if: shadow-mode output isn't beating manual work, time spent on the orchestrator exceeds time it saves, or any component needs bespoke distributed machinery instead of files/git/sqlite.

## 4. Key decisions & rationale

- **Metric is tokens-per-merged-feature, not tokens-per-call.** Terseness barely moves the real number and causes rework; minimal output is a false economy. Three independent lenses converged on this.
- **Reversibility, not trust, is the autonomy axis.** Blast radius is engineerable; "how much do I trust the agent" is not.
- **Compute is cheap; context and history are scarce.** The original spec optimized the wrong resource. Recycle compute aggressively (pool, lease, kill), keep artifacts forever.
- **Swarm for exploration, pipeline for delivery.** Swarm dynamics for the messy divergent middle (analysis, planning, exploration); strict pipeline at the convergent human-facing edges (spec confirmation, commit, merge). The orchestrator is then responsible for only the two boundaries Deep cares about: what was asked, and what shipped.
- **The orchestrator's irreducible job is the human contract, not coordination.** Work assignment is nearly free given a shared queue and local rules; conversation is what actually requires a model.
- **Structured, not short.** A JSON schema per agent buys compression and machine-checkable handoffs at once.
- **Generic engine + per-project profile.** All project knowledge (stack, commands, conventions, resources) lives in one profile file, so the engine stays universal.
- **Boring inspectable state.** Files, git, sqlite over clever distributed machinery — the real predator is Deep's own future self at 2am.

## 5. Parked backlog

**v1 (next after the spine proves out)**
- Answer-from-repo-first deflection with a tracked deflection rate; async question inbox (batch-answered like email); assumption log + approval gates in place of a question queue.
- Two-tier verification (free deterministic gate 1: typecheck/lint/tests → LLM review only on pass); progressive verification (lint per write, tests per chunk, full suite once); test-first inversion.
- Dry-run mode with cost estimate; dollar cap with graceful degradation; wall-clock cap; step cap per agent.
- Model ladder with promotion on failed verification; cheap-executor-plus-strong-reviewer; decompose-instead-of-escalate.
- Bootstrap agent that authors a new repo's project profile; per-region auto-maintained AGENTS.md.
- Secrets never in context (env-injected into tool-server container, output redaction); executor container with no push rights, gated committer only; protected branches; least-privilege container (read-only root, no docker socket, non-root, dropped caps, seccomp).
- Territorial marking / merge-conflict predictor; parallelism bounded by disjoint file sets.
- Escape hatch (dump in-flight work to an ordinary branch, detach); "playing dead" — halt on repeated failure and write a handoff doc.
- Exceptions-by-default dashboard view; surface the currently binding constraint (cost / context / wall-clock / conflicts).

**Later**
- Web dashboard as second renderer; steerable dashboard (pause/inject/kill/fork); time-travel replay; cost heat-map; cost-per-feature leaderboard; cost anomaly detection.
- Swarm mechanics for the exploratory middle: stigmergy via filesystem, three local rules, claim-by-lockfile, capability-tagged queue, pheromone decay, death-as-a-feature, recruitment-instead-of-escalation.
- Speculative N-plans/N-executors then vote or evolutionary selection; quorum sensing (2 of 3 analysts converge) as drift defense; emergent decomposition.
- Hierarchy of orchestrators (per-worktree + meta) once N parallel features strain context; rolling orchestrator re-instantiated per phase.
- Worktree hibernation/snapshot into a warm pool; provision-ahead during planning; phase pipelining (verify N while planning N+1).
- Extend past merge: deploy agent, canary watcher, auto-revert, canary-as-final-verifier; ambient backlog (watch jira/CI/flaky tests and propose features).
- Cross-repo memory rollout; waggle-dance broadcast of successful approaches; provenance tags; immune-checkpoint sanity agent; re-grounding on the verbatim original request.
- Adversarial tester; property-based tests; determinism pinning (temp 0, pinned model versions, recorded inputs); prompt/model abstraction layer + golden-task regression suite; chaos drill (kill a random agent mid-run).
- Circuit breaker + cached read-replica for external tools; rate-limit token buckets; two-phase sandbox (network on for provisioning, off for execution); egress allowlist proxy.
- Fidelity sampling (full transcripts for failures, summaries for successes); three-tier isolation ladder (in-place / branch / worktree+container) by risk.

**Rejected / dissolved**
- Eight bespoke role agents — collapsed to 3 pure functions plus a deterministic engine.
- The orchestrator as a live LLM scheduler — split into Interviewer + code engine.
- Interrupt budgets and escalation auctions — superseded by question compression, the decision ledger and answer-from-repo.
- Minimal-output-as-a-goal — replaced by structured output plus the two-plane split.
- Agent-to-agent messaging / blackboard as separate infra — subsumed by git-as-bus.
- Bespoke observability platform (OTel/Jaeger build-out) — subsumed by the event log; maintenance-burden tripwire.
- Destroy-on-merge-only lifecycle — replaced by kill-compute-keep-artifacts-forever.
- Stateful codebase-region agents as v0 structure — memory belongs in the memory layer, not in agent identity.

## 6. Open questions

- Which **3 agents** exactly form the v0 set, and what are their typed input/output schemas?
- What is the concrete shape of the event log (SQLite schema) and its mapping to git commits/notes — what belongs in a commit vs a note vs the event store?
- What does a **project profile** file contain, minimally, for a new repo to be onboarded?
- What shadow-mode score threshold unlocks which reversibility tier — and how is "matches the real commit" scored at all?
- Where exactly is the swarm/pipeline seam in practice, and does v0 need any of the swarm side?
- How do capability tokens work mechanically within Claude Code's existing primitives (MCP servers, sandboxes) without becoming bespoke infra?
- Cross-repo memory: storage, indexing and retrieval mechanism, and how it stays useful without becoming context poison.
- What concretely triggers a stop-building tripwire — what is measured, and how often?
