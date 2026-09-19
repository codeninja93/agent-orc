---
title: Input reconciliation review — ARCHITECTURE-SPINE.md
target: ../ARCHITECTURE-SPINE.md
reviewer: input-reconciliation
date: '2026-09-19'
inputs:
  - ../../../../specs/spec-agent-orchestrator/SPEC.md
  - ../../../../specs/spec-agent-orchestrator/architecture.md
  - ../../../../specs/spec-agent-orchestrator/interface-contract.md
  - ../../../../specs/spec-agent-orchestrator/memory-design.md
  - ../../../../specs/spec-agent-orchestrator/build-sequencing.md
  - ../../../../brainstorming/brainstorm-agent-orchestration-system-2026-09-19/threat-model.md
---

# Input reconciliation — what the spine dropped

## Verdict

The spine is strong on the invariants it chose to fix — process boundary, event envelope, state ownership, resume, on-disk layout, project identity, roster declaration, profile precedence. It is weak on exactly the axis a spec-to-AD transform is structurally bad at: it kept the **mechanism** decisions and dropped the **policy, safety and human-factors** decisions that the SPEC and the threat model treat as contract.

Concretely: **the entire containment and blast-radius layer of `threat-model.md` §3.1/§3.3 and of v0 guardrails 1–7 has no AD**, `CAP-8`'s success criterion and the SPEC's own success signal are contradicted by AD-4 + AD-9, the control/evidence plane separation (the central idea of `architecture.md`) never appears, and the redaction boundary that SPEC constraint 4 requires is absent while AD-13 actively mandates writing every external request and response into an immutable log.

Findings below are ordered by severity. Nothing that landed is reported.

---

## 1. Contradictions

### F-01 — CRITICAL. "Reconstructable from git alone" is contradicted by AD-4 + AD-9

**Input claim.** `SPEC` CAP-8 intent: *"The complete record of what agents did to a feature is recoverable from the repository itself, without a separate datastore."* Success: *"A feature's full agent timeline is reconstructable from `git log` and notes alone, **with no other datastore present**."* The SPEC success signal repeats it: *"with the run's cost, timeline and verification evidence reconstructable **from git alone**."* `threat-model.md` §4: *"Git as the message bus (comms, audit, replay, flight recorder, stigmergy — one decision solves five problems)."* `architecture.md`: *"Handoffs are commits… `git log` is the timeline; git notes carry cost and reasoning."*

**What the spine did.** AD-4 makes `events.jsonl` the durable truth. AD-9 puts it under `ORCH_HOME` and states *"No run state, event log or worktree is ever written inside the target repository."* The Capability → Architecture Map assigns CAP-8 to AD-4, AD-5, AD-9 — the three ADs that guarantee the record is **not** in git.

**What should have carried it and doesn't.** There is no AD that says what the committer must write into git notes, nor any rule that the git-notes projection is sufficient to reconstruct the timeline and cost on its own. AD-4 says *"any index or database is a derived projection that must be reconstructable by replaying the files"* — the direction of derivation is exactly backwards from CAP-8, which needs git to be sufficient. AD-9 then says *"worktrees at `worktrees/<run-id>/`… destroyed on merge; evidence under `runs/` persists"* — so after merge the only durable record lives outside the repository, on one machine, ungoverned by any backup or retention rule.

This is the single most damaging finding because CAP-8 is not decoration: it is half of the SPEC success signal and the thing that makes the user *"trust enough to skim rather than audit."* Either CAP-8 must be restated, or an AD must fix the git-notes contract (what the committer writes, and the guarantee that a run replays from notes with `ORCH_HOME` deleted).

### F-02 — HIGH. AD-1's "never in bare mode" silently re-opens the CAP-7 capability boundary

**Input claim.** `SPEC` CAP-7: *"Each external domain is reachable by exactly one agent, enforced by where its credential lives rather than by instruction. Success: a non-owning agent attempting that domain's API fails for absence of credential; verified by test."* `threat-model.md` §3.2: *"Each agent's identity is its set of mounted credentials and granted tools, not a sentence in its system prompt."*

**What the spine did.** AD-1 requires `claude -p` *"never in bare mode."* AD-13 says *"each domain runs as exactly one MCP server passed with `--mcp-config`."*

**The contradiction.** Non-bare `claude -p` loads the target repository's own `.mcp.json` and `.claude/settings.json` hooks in addition to whatever `--mcp-config` grants. So the set of MCP servers and tools a step agent can reach is **not** the set the roster granted it — it is that set union whatever the target repo declares. AD-17's promise that an agent's *"granted tools and MCP domains"* are declared in one TOML is therefore not enforceable under AD-1. The spine notices this and files it under **Deferred**, with a safety argument that does not hold:

> *"Safe: … AD-11 already confines tier-2 execution to the locally built image and AD-13 already confines credentials to one MCP server per domain."*

AD-11 confines **tier 2 only**. Tiers 0 and 1 (`architecture.md` isolation table: in-place and branch-only) run with no container at all, and the Interviewer in the spine's own flow diagram runs `claude -p` directly on the host against the user's terminal. For those paths nothing confines anything. A deferral whose safety argument is false is worse than an open item.

### F-03 — HIGH. The model ladder is inverted into a fixed per-agent assignment

**Input claim.** `SPEC` constraint: *"Model assignment is a ladder with promotion on verification failure, **not a fixed per-agent assignment**."* `architecture.md`: *"A ladder, not a fixed map. Every step starts on the cheapest viable model and is promoted only on verification failure."*

**What the spine did.** AD-17 declares that each agent's TOML specifies *"its model tier"* — a fixed per-agent assignment, the precise shape the constraint forbids. The Deferred entry then argues:

> *"AD-17 makes the model tier a field of an agent's TOML declaration, AD-1 makes it a per-step spawn argument and **AD-5 makes promotion an event type**."*

AD-5 does no such thing. AD-5 fixes the envelope; the event-name convention enumerates `step.started`, `agent.tool_used`, `fetch.recorded`, `write.executed`, `permission.denied` — no promotion event. The ladder survives only as an unenforced arrow in the state diagram (`verifying --> running: gate failed, model promoted on the ladder`). Nothing in the AD set stops a unit reading `model_tier` from TOML and pinning it.

**Also dropped alongside it.** `threat-model.md` §3.5 determinism pinning and v0 guardrail 13: *"Pinned model versions (never a floating alias) and temperature zero outside explicitly creative steps."* CAP-6's success criterion is *"a recorded run replays to an identical step sequence."* AD-1 fixes the invocation mechanism and AD-13/AD-14 fix external-input determinism, but **no AD or convention fixes model-version pinning or temperature**, which is where nondeterminism actually enters. The Stack table pins the `claude` CLI version and pins nothing about the models it invokes.

### F-04 — MEDIUM. Reversibility class is attached to the agent, not to the action type

**Input claim.** `SPEC` CAP-12: *"**Every action type** carries a declared reversibility class; reversible actions proceed unattended and irreversible ones block."* Intent: *"based on blast radius, **not on a global trust setting**."* `architecture.md` reversibility table classes actions (edit-in-worktree, commit-to-branch, push-to-shared-branch, write Jira, spend past ceiling) — not agents.

**What the spine did.** AD-17: each agent TOML declares *"its reversibility class."* A per-agent class **is** a trust setting per agent — a strictly coarser thing than the capability asks for, and it cannot express that one agent performs both reversible and irreversible actions (the committer commits locally *and* pushes). The Capability map sends CAP-12 to AD-1, AD-15 and AD-8; AD-15 governs only external-domain writes, AD-8 governs resume, AD-1 governs spawning. No AD defines the class set, the gate behaviour, or who evaluates it.

### F-05 — MEDIUM. Terminal-complete degraded into renderer symmetry; web optionality never stated

**Input claim.** `SPEC` constraint 1: *"Terminal-complete: every action is answerable from the terminal. **The web app is strictly optional and never required to proceed.**"* Non-goal: *"No web dashboard as the primary or required interface."* `architecture.md`: *"TUI (primary) and web app (optional)."* `interface-contract.md` Q5: *"Questions are answered in the terminal. Never require a browser to reply."* `build-sequencing.md` puts the TUI in stage 1 and the web renderer in stage 3.

**Judgement on AD-3.** AD-3 — *"every steering action — pause, inject, kill, fork — is exposed by both the TUI and the web app… neither renderer may own a control the other lacks"* — is a **compatible refinement, not a contradiction**, of the non-goal. Symmetry is sufficient to keep the web app from becoming the primary interface *for those four controls*.

**But it is not sufficient for the constraint, and the spine dropped the rest.** Three gaps:

1. AD-3 covers only the four steering controls. It says nothing about the other user-facing actions — spec-echo confirmation, answering the one-question card, `just-do-it`, rejection-plus-reason, the kill card, the escape hatch. Q5's *"never require a browser to reply"* is nowhere in the spine.
2. Nothing in the spine states that the web renderer may be **absent**. AD-3 asserts symmetry but no AD asserts optionality — that the engine, the reconciler and every gate must function with no web process running and no port bound. "Neither renderer may own a control the other lacks" is satisfied equally well by a design in which both are required.
3. The stage ordering is lost. AD-3 reads as though both renderers are coeval; `build-sequencing.md` puts two stages between them, which matters because stage 1's gate must be judgeable with the TUI alone.

### F-06 — MEDIUM. The web control surface has no single-user / loopback binding, against the no-shared-instance non-goal

**Input claim.** `SPEC` non-goal: *"No multi-tenant or shared-instance operation. Additional people run independent instances; there is **no shared server**, shared state or cross-user memory."* Assumption: *"Single user per instance, local-first."*

**What the spine did.** AD-3 promotes the web app from a read-only projection to a surface that can **kill and fork running agents**, and then Deferred defers *"Web renderer framework, bundler and port convention"* as *"Safe."* A listening socket that accepts destructive control actions, with no AD fixing loopback-only binding, no authentication story and no statement that the process is single-user, is not a framework detail — it is the one place the spine creates a network-reachable control plane. The threat model has no row for it because the threat model predates the decision; the spine that made the decision owns the consequence.

### F-07 — LOW. The one-writer convention is contradicted by AD-15 and by the error convention

**Input claim.** `SPEC` constraint: *"Agents never author their own telemetry; the runtime records what they did."* This one **landed** in AD-4 and in the conventions table (*"only the runtime recorder appends to its `events.jsonl`"*).

**The internal contradiction.** AD-15 says *"the engine executes each [write intent]… **records the outcome to the event log**"*, and the conventions table says *"the engine emits it [the error shape] to the event log unchanged."* Two writers, stated in the same document as the one-writer rule. Either the engine emits through the recorder (say so) or the rule is wrong.

### F-08 — LOW. AD-9 internal inconsistency on `.gitignore`

AD-9 says the installer *"appends the runtime paths to `.gitignore`"* and, in the same rule, that *"No run state, event log or worktree is ever written inside the target repository."* If the second is true the first is unnecessary; if runtime paths need ignoring, something writes them. The structural seed repeats it (`.gitignore  # installer appends the runtime paths`). Resolve which is true.

---

## 2. Constraints that vanished

Walked in SPEC order. Only constraints with **no** AD or convention enforcing them are listed.

### F-09 — CRITICAL. Executor credential and push control: SPEC constraint 3 has no AD at all

**Input claim.** `SPEC`: *"Executor sandboxes hold no push and no production credentials. Only a gated committer may push. Force-push is never permitted. Protected branches are enforced independently of agent behaviour."* `threat-model.md` §3.3 gives the mechanism (deploy key simply not mounted; a git wrapper rejecting `--force`/`--force-with-lease`/`push :branch`; a pre-push hook; server-side protection on `main`). v0 guardrails 5, 6. CAP-10's own success criterion: *"the container tier's executor **has no push credential, verified by test**."*

**What the spine has.** Nothing. CAP-10/11 map to AD-9 and AD-11; AD-9 is a filesystem-layout decision and AD-11 is an image-provenance decision. The word "credential" appears in AD-12 (installer bundles none) and AD-13 (one domain credential per MCP server) — never about the executor's git credential. The committer exists only as a noun in a table cell and an arrow in the state diagram.

This is the highest-severity *omission*: it is a SPEC constraint, three v0 guardrails, the success criterion of a bound capability, and the defence against the two Critical threats (#9 destructive actions, and the repository as the most painful loss). An independently-built committer unit and an independently-built worktree-lifecycle unit have no shared rule here and will choose incompatibly.

### F-10 — CRITICAL. Container hardening: the actual containment boundary is unallocated

**Input claim.** `threat-model.md` §3.1 and v0 guardrails 1–2: one hardened wrapper used by every executor — `--read-only` rootfs, `tmpfs` for `/tmp`, **only the worktree bind-mounted** (never `$HOME`, `.ssh`, `.aws`, never the repo root), non-root `--user`, `--cap-drop=ALL`, `--security-opt=no-new-privileges`, seccomp profile, memory/pid limits, a startup assertion that the docker socket is absent, *"in one `docker run` wrapper script so no agent ever composes its own flags"*; plus the two-phase sandbox (network on to provision, `--network=none` or allowlist-only to execute) and the egress allowlist proxy with **every call logged**. `architecture.md` restates the tier-2 container spec nearly verbatim. `build-sequencing.md` stage 1: *"containment is required from the start."*

**What the spine has.** AD-11, which fixes only *where the image comes from* (local Dockerfile, content-hash tag, no registry pull). The run-time flag surface — which is the containment boundary, not the image — is fixed nowhere. `docker/Dockerfile` appears in the structural seed; the wrapper script that AD-11's own threat-model source says must exist so *"no agent ever composes its own flags"* does not appear in the seed at all, and no AD forbids an agent composing them.

Worse, AD-11's one network sentence conflates two different things: *"the build is the only step permitted network access outside the egress allowlist."* The two-phase sandbox is a **per-run provisioning phase** (dependency install), not the image build. As written, AD-11 leaves per-run dependency installation either impossible or unconstrained.

The egress allowlist itself appears once, as a comment in the structural seed (`permissions.toml  # granted tools, reversibility gates, egress allowlist`). No AD makes the proxy the single chokepoint, and no AD carries *"every call logged"* — which the threat model designates as the audit trail for §3.2.

### F-11 — CRITICAL. Redaction: SPEC constraint 4's second half is missing, and AD-13 creates the leak path

**Input claim.** `SPEC`: *"Secrets never enter model context: injected as environment into the owning tool-server container only, **with output redaction before any logging or posting**."* `threat-model.md` §3.2: *"A redaction pass on the boundary between agent output and any durable sink (event log, git notes, dashboard, PR body)… **Fail closed**: if the scanner errors, drop the artifact rather than write it."* v0 guardrail 4. Threat #8 is the only threat rated Critical whose damage is called *"permanent, and possibly public."*

**What the spine has.** The first half only. AD-13 places the credential in one MCP server. The redaction boundary is absent from every AD and from the conventions table.

**And the spine makes it worse.** AD-13 mandates *"the runtime records **every request and response** to the event log and to the run shared fetch record."* AD-4 mandates that event lines *"are never mutated."* Composed, those two rules say: write every external API response verbatim, forever, immutably, with no scanner in between. The structural seed has `src/runtime/  # recorder: claude -p stream-json -> events.jsonl, fetch record` — the natural home for the redaction stage, and it is not there. There is no AD naming the sinks (`events.jsonl`, `fetch-record.json`, `state.json`, git notes, PR body, both renderers) or the fail-closed rule.

### F-12 — HIGH. The control/evidence plane split — and CAP-9's token ceiling — never appear

**Input claim.** `architecture.md` "The two planes": *"Control plane — thin, schema'd, typed. Carries decisions between steps and is **the only thing that enters model context**. Subject to a declared token ceiling. Evidence plane — fat, unbounded, on disk… read only on demand."* `SPEC` CAP-9 success: *"Orchestrator context for a feature stays within a **declared token ceiling** regardless of evidence volume; any evidence artifact is retrievable on demand."* `glossary.md` defines both terms. Threat #5 (orchestrator bottleneck) depends on it.

**What the spine has.** The strings "control plane" and "evidence plane" do not occur in the spine. CAP-8/CAP-9 map to AD-4, AD-5, AD-9. AD-4 governs the durability of the log; AD-5 governs its envelope; AD-9 governs its location. **None of them constrains what enters model context.** Nothing stops a step contract from inlining a full transcript or a whole diff, nothing declares the ceiling, and nothing states the pointer-not-payload rule that makes the ceiling achievable.

This is the load-bearing idea of `architecture.md` and it is the one that most needs to be an invariant, because it is violated *unit by unit*: one step schema that inlines evidence defeats it for the whole system. It is precisely what a spine exists to fix.

### F-13 — HIGH. Memory write discipline and content rules dropped

**Input claims.** `SPEC` constraints: *"Memory stores questions, their durable answers, and pointers to stable anchors. **Never code snippets. Line numbers are never valid anchors.**"* / *"Cross-repo memory stores abstract patterns only."* / *"**Only verified and merged outcomes write to long-term memory**; failed experiments write to episodic memory only."* `memory-design.md` "Write discipline": *"This is the primary defence against memory poisoning"*, plus *"Long-term memory is never written during a run"*, *"the committer records what was learned"*, *"Memory must be rebuildable: if the index is lost, at least ninety percent regenerates from git history plus the event log"*, and the anchor durability ranking. CAP-19 success: *"with no code snippets stored."*

**What the spine has.** The CAP-17/18/19 row maps to AD-4, AD-6, AD-9, AD-10 — a durability rule, a deferral, a location and a key. Those fix *where memory lives* and *what it is keyed by*. **Not one of them constrains what may be written, by whom, or when.** AD-16 carries provenance, decay policy and the re-validation sweep — but explicitly and only for `profile.toml`, which is per-repo committed configuration, not the consolidated store under `projects/<project-id>/`.

So: no rule that a run may not write long-term memory; no rule that only the committer writes it and only on merge; no rule against code snippets; no anchor-durability rule; no rebuildability guarantee. Given that AD-6 defers the index and AD-9 puts memory in a single central directory, memory poisoning and memory loss are both currently unguarded.

### F-14 — HIGH. Cost governance is named but governed by nothing

**Input claims.** `SPEC` constraint: *"Cost is governed as subscription usage, not currency. There is no per-token billing to optimize and **no dollar ceiling**; ceilings are expressed in **steps, wall-clock time and consumed rate-limit budget**."* CAP-16 success: *"A feature exceeding its step, wall-clock or rate-limit-budget ceiling **halts and notifies** instead of continuing; consumption is visible without issuing a command."* `threat-model.md` §3.4: the metabolic cap with **hibernation reflex** (snapshot state, write handoff note, ping — *"rather than dying mid-write or continuing"*), **graceful degradation at 80%**, wall-clock cap reporting *partial progress*, step cap per agent (*"the single cheapest guard here — do not skip it because it looks trivial"*), usage anomaly detection against a baseline, dry-run estimate. v0 guardrails 8–9. `interface-contract.md` R10: *"Cost is subscription usage, never currency."*

**What the spine has.** One table row: *"CAP-16 — cost governance | `src/engine` ceiling enforcement, `src/runtime` usage events | AD-4, AD-5, event-name convention."* This is the clearest case of nominal coverage in the document. AD-4 and AD-5 say an event is a durable line with a fixed envelope — true of every event and constraining nothing about ceilings. The event-name convention's enumerated types include no usage or ceiling event.

Consequences for independently built units: the three ceiling dimensions are not fixed (a unit may implement a fourth, or a currency one, which the SPEC forbids); the 80% degradation threshold and the hibernation-versus-terminate behaviour at the ceiling are unspecified; the `blocked` state in the lifecycle diagram mentions *"declared ceiling reached"* without saying who enforces it, who snapshots, or who notifies. The state diagram has no hibernation state at all.

### F-15 — HIGH. "Silence means success" and exceptions-only notification have no component and no rule

**Input claims.** `SPEC` constraint: *"Silence means success: notify only on exception, decision point, or completion."* `interface-contract.md` R1, and R13: *"Quiet hours are honoured; delivery is async by default."* Q8: *"Questions batch to natural boundaries. A do-not-disturb window queues rather than fires."* Q9: *"Never interrupt for anything unresolvable in ten seconds."* `threat-model.md` threat #13 (alert fatigue) and §3.7: *"The dashboard shows exceptions only… If a notification isn't actionable, it should not exist."* v0 guardrail 16.

**What the spine has.** Nothing. There is no notifier in the structural seed, no AD, no convention row. The nearest thing is the (good, and landed) convention *"No unit writes diagnostics to stdout; everything observable goes to the event log"* — but that governs the **diagnostic** channel, not the **interrupt** channel, and the two are different: the whole point of "silence means success" is that most of what goes to the event log must *not* reach the user.

Because both renderers, the ambient status line and any async delivery all project the same log, the decision of *which events are allowed to interrupt* is a cross-unit contract. Right now each surface will decide independently — which is the definition of alert fatigue.

### F-16 — MEDIUM. Git identity: no bot identity, PR by default

**Input claim.** `SPEC` constraint: *"Commits and pull requests are authored under the user's own git identity. **There is no bot identity.** The committer opens a pull request by default rather than pushing to a shared branch."* `build-sequencing.md` stage-2 gate depends on it: *"a real feature completes end to end, with the user reviewing and merging a pull request **authored under their own identity**."*

**What the spine has.** The state diagram arrow *"committed: gates passed, committer opens a pull request."* AD-12 addresses *model* authentication (*"every user authenticating with their own Claude Code login"*), which is a different credential. Nothing fixes git author/committer identity, nothing forbids a bot identity, and nothing makes PR-by-default a rule. The conventions table's "auth" cell covers only the Claude subscription login.

### F-17 — MEDIUM. The minimum guardrail set is not a gate anywhere

**Input claim.** `SPEC` constraint: *"No feature runs unattended without the minimum guardrail set defined in `threat-model.md`."* `threat-model.md` §5: *"Nothing runs unattended until **all** of these exist and each has been exercised once on purpose"*, plus the chaos drill before the first unattended night. `build-sequencing.md` stage-4 gate: *"the minimum guardrail set in `threat-model.md` is complete and tested."*

**What the spine has.** No AD, no convention, no lifecycle state. The lifecycle diagram moves `confirmed --> running` with no guardrail precondition. The only mention of the threat model in the whole spine is a Deferred item that *amends* it. A structural anchor would be cheap: a precondition on entering unattended execution, asserted by the engine and recorded as an event.

### F-18 — MEDIUM. The two-tier verification ordering (CAP-13) is unenforced

**Input claim.** `SPEC` CAP-13 success: *"Deterministic gates (typecheck, lint, tests) run **before** any model-based review, and **no review spend occurs on a run that fails them**."* `threat-model.md` §3.5: *"Gate 1: typecheck, lint, tests — free and deterministic. Gate 2: LLM review. **Never run gate 2 if gate 1 fails.**"* v0 guardrail 12.

**What the spine has.** CAP-12/13 map to AD-1, AD-15 and AD-8 — spawn mechanism, external writes, resume. `src/engine` *"gates"* is named in the seed. The ordering invariant itself — which is a scheduling rule the reconciler must honour, i.e. exactly a cross-unit invariant — is stated by no AD. AD-7 says the loop takes *"at most one next action"* without constraining which.

### F-19 — MEDIUM. Re-grounding against the verbatim original request is absent from the step contract

**Input claim.** `architecture.md` Coordination: *"**Re-grounding.** Every agent reads the original, verbatim feature request — never a summary of a summary."* `threat-model.md` §3.5: *"Hard rule: every agent re-reads the original feature request verbatim… The original request is a file in the worktree, and reading it is **step zero** of every agent prompt."* v0 guardrail 11. Threat #1 (context poisoning) is rated High and is the first row of the table.

**What the spine has.** Nothing. AD-8 refers to *"its typed input file"* and the seed's `contracts/` lists *"step inputs/outputs, event envelope, error shape, agent decl."* Whether every step input schema must carry the verbatim original request — a schema-shape invariant, the single most AD-appropriate form this rule could take — is unstated. Related: `architecture.md`'s *"Provenance. Every claim in an output carries the step that produced it"* is carried only by the event envelope's `emitter`/`step` fields, not by any requirement on output artifacts.

### F-20 — MEDIUM. The governing exchange rate was dropped entirely

**Input claim.** `interface-contract.md` opens with it under the heading *"The governing exchange rate"*: *"An interruption costs roughly fifteen minutes of the user's focus. Model usage is prepaid by subscription and costs nothing at the margin. **The system should spend compute freely to avoid a question.** Every rule below follows from that ratio, and any future trade-off between cost and clarity resolves against it. This supersedes the original premise that subagents should minimize output to save tokens."* Restated as a SPEC constraint, and as a non-goal: *"Minimal subagent token output is explicitly not a goal in itself, having been identified as a false economy."* `SPEC` "Why": *"his attention is the scarcest resource in the system."*

**What the spine has.** Not a word. This is the input's own stated tie-breaker for every future cost-versus-clarity decision, and a spine is exactly the artifact that later decisions get resolved against. Its absence means the next person choosing between spending steps on question compression and just asking has no recorded rule — and the default instinct (terseness, fewer calls) is the one the inputs explicitly overturned.

### F-21 — MEDIUM. "No bespoke framework" / maintenance burden has no architectural anchor

**Input claims.** `SPEC` constraint: *"Built on existing Claude Code primitives — **subagents, hooks, MCP, worktrees** — as configuration plus small scripts. **No bespoke agent framework.** Maintenance burden is the identified likeliest cause of project failure."* `threat-model.md` §4 names it *"The predator most likely to actually kill the project"* and prescribes *"architectural restraint, decided up front."* `build-sequencing.md` lists five stop-building tripwires, including *"Any component requiring a bespoke abstraction that Claude Code primitives cannot express as configuration plus scripts."*

**What the spine has.** AD-1 (no in-process SDK), AD-17 (roster as config) and AD-18 (no BMad) each pull in the right direction, but none of them is the constraint. There is no AD stating that a new component must first be shown not to be expressible as an existing primitive, and the Deferred section — the natural home for restraint — contains no tripwire.

Two concrete symptoms: **hooks**, one of the four named primitives, appear nowhere in the spine except as a threat surface in a Deferred item, despite being the obvious enforcement point for the force-push rejection and the pre-push gate of F-09. And the spine as it stands specifies a bespoke reconciler, a bespoke recorder, a bespoke event log, a bespoke MCP fleet and a bespoke web control surface, with no recorded test that each was cheaper than the primitive it replaces.

### F-22 — MEDIUM. Ephemeral-resource discipline (CAP-11) is nominal

**Input claim.** `SPEC` CAP-11 success: *"A feature requiring postgres receives a ready instance within a declared time bound; on completion the instance is **returned and verified empty**."* `threat-model.md` §3.1: *"wiped on return. No agent ever receives a connection string to anything that is not disposable. Enforce by construction: **the only DB credential injected is the leased one**."*

**What the spine has.** `pool/  # leased ephemeral resources` in the layout, and AD-9/AD-11 as governors. Neither mentions leasing, wiping, verification, the time bound, or the injected-credential rule. Given F-11's missing redaction and F-09's missing credential rules, the lease credential path is entirely ungoverned.

---

## 3. Quiet requirements from `interface-contract.md`

Checked all 10 question rules and 14 reporting rules. Two genuinely architectural ones **did** land and are not reported here: both renderers exposing the same controls (AD-3), and the event log as the only diagnostic channel (conventions: *"No unit writes diagnostics to stdout"*). Tone and register (colleague, no anthropomorphic filler) are correctly out of scope for a spine.

The following are architectural and were lost:

### F-23 — HIGH. The question mechanism has no schema, no events and no owner

**Input claims.** Q1 (recommended default, ≤3 concrete options plus an escape, never open-ended) — also a SPEC constraint. Q2 (states what happens if ignored, and the window) = CAP-4. Q3 (self-contained mini-brief, answerable without reloading the feature into the user's head). Q4 (attempted against repository, git history and ledger first; **deflection rate is reported**) = CAP-3, whose success is a *measured* median. Q6 (answers are free text; the system parses). Q7 (answered once becomes a ledger rule, never asked again) = CAP-18. CAP-4 success: *"ignoring it causes that default to be taken **and logged as a decision**."*

**What the spine has.** One table cell: *"CAP-1…CAP-4 | `src/engine` Interviewer session | AD-1, AD-13, `interface-contract.md` question rules."* A pointer to a prose document is not governance, and this is the row where it hurts most, because the question is a **cross-unit object**: the Interviewer produces it, both renderers render it, something must hold the timeout timer, the engine must take the default and record it, and the ledger must be consulted before it is asked and updated after it is answered.

None of that is fixed. `contracts/` lists *"step inputs/outputs, event envelope, error shape, agent decl"* — **no question envelope, no decision record**. The event-name convention enumerates five types, none of which is a question, a default-taken, a decision or a deflection. So: no unit owns the timer, no schema carries "default + ≤3 options + escape + window", and CAP-3's and CAP-4's measurable success criteria have no event to be measured from.

### F-24 — MEDIUM. Surfaces that live outside both renderer processes have no home

**Input claims.** `interface-contract.md` Required surfaces: *"**Ambient status line** — a single always-visible shell or multiplexer segment. Never demanding."* R10: *"Consumed rate-limit budget and step count are **always visible without issuing a command**."* R11: elapsed-versus-estimate always visible. R14: *"The active question occupies a persistent slot that does not scroll away."* Mode and control: *"The current mode is displayed **permanently in the prompt line**"* — and CAP-5's success is literally *"Current mode is present in the prompt line at all times."*

**What the spine has.** CAP-14/15/22 map to `src/tui` and `src/web`. But a shell prompt segment and a tmux status segment are **not** the Ink TUI: they must render when no TUI is running, from a process the user's shell invokes on every prompt. That is a third surface with its own read path into `ORCH_HOME`, and it does not exist in the structural seed, in any AD, or in the capability map. As specified, CAP-5's and CAP-22's success criteria cannot be met by the components the spine declares.

### F-25 — MEDIUM. Feature-name addressing versus a run-id-keyed world

**Input claim.** R6: *"Address everything by feature name. **Never require the user to know an agent name or run id.**"* R7: *"Progress is the current step name and the next gate. Never a percentage."* CAP-22: *"All in-flight features and what each needs fit one screen without scrolling."*

**What the spine has.** Everything durable is keyed by run id — `runs/<run-id>/`, `worktrees/<run-id>/` — and the envelope carries both `feature` and `run`. There is no feature→run resolution structure. Worse, two rules actively block the cheap one: AD-4 says *"no component may read an index for a fact the log holds"*, and AD-6 defers any index until *"a concrete… query cannot be served acceptably by scanning JSONL."* The morning brief is a stage-1 surface (`build-sequencing.md`) whose query is "every in-flight feature across every run" — i.e. a scan of every `runs/<ulid>/events.jsonl` on the machine, on every render of an always-visible surface. The deferral's own trigger condition is met at stage 1 and the spine does not notice.

### F-26 — LOW. Completion and handoff artifact shapes are unfixed

R8: *"Every completion states what was verified **and what was not**."* R9: *"Review requests point at the lines that need eyes and say why. Never dump a diff."* `interface-contract.md` Required surfaces: the handoff document *"Reads as a colleague's note, not a stack trace"*, and the **trust record** — *"per-area history of merged-unchanged versus corrected, used to justify autonomy tiers."* The trust record is referenced once in AD-6 (*"a concrete shadow-mode or trust-record query"*) and is otherwise undefined: no owner, no location, no schema — despite being the input to the autonomy-unlock decision that gates stage 4.

---

## 4. Threat-model guardrails with no architectural anchor

Consolidated; several are detailed above. Mapping §5 v0 guardrails to the spine:

| v0 | Guardrail | Anchored in spine? |
|---|---|---|
| 1 | Hardened container wrapper; only the worktree mounted; docker-socket assertion | **No** — AD-11 covers image provenance only (F-10) |
| 2 | Network off during execution / two-phase sandbox / egress proxy | **No** — AD-11's one clause is about the *image build* (F-10) |
| 3 | Zero secrets in any agent context; executor holds none | Partial — AD-13 places domain credentials; executor side unstated (F-11) |
| 4 | Redaction on every path to durable storage, fails closed | **No** — and AD-13 + AD-4 widen the exposure (F-11) |
| 5 | Protected `main`, server-side | **No** (F-09) |
| 6 | Executor has no push credential; one gated committer; no force-push | **No** (F-09) |
| 7 | Escape hatch, written and tested | Partial — AD-7 gives crash-equivalence and the lifecycle has `handed_off`; the "dumps in-flight work to an ordinary branch and detaches" contract is unstated |
| 8 | Per-feature ceiling with hibernation, enforced by the harness | **No** (F-14) |
| 9 | Wall-clock cap and step cap per agent | **No** (F-14) |
| 10 | Spec echo before any code | Partial — the lifecycle `drafting → confirmed` edge; no AD, no schema |
| 11 | Re-grounding enforced in every agent prompt | **No** (F-19) |
| 12 | Gate 1 before gate 2 | **No** (F-18) |
| 13 | Pinned model versions, temperature zero | **No** (F-03) |
| 14 | Append-only event log surviving a crash; run resumable | **Yes** — AD-4, AD-7, AD-8. Landed well |
| 15 | Playing dead: halt and write a handoff document | Partial — `handed_off` state; no handoff-document contract |
| 16 | Exceptions-only notifications | **No** (F-15) |
| 17 | Phase 1 autonomy only until shadow mode measures | Partial — deferred as a number, not structured as a gate (F-17) |

Additional §3 defenses with no anchor: **territorial marking** landed (conventions: *"serializes any features whose declared file territories overlap"*) — good. **Termite-mound bounded build** (*"Agents may only modify files adjacent to already-changed files. A diff that suddenly spans the repo is a signal"*) — dropped, low severity. **Circuit breaker + cached read-replica** for tool outages — AD-14's fetch record is per-run, so it does not serve the cross-run stale-read case; low. **Usage anomaly detection** and **dry-run estimate** — dropped; medium, since both are named defenses for the High-severity usage-blowout threat.

---

## 5. Two sources of truth the spine itself creates

### F-27 — MEDIUM. Granted tools are declared twice with no precedence rule

AD-17: each `agents/<agent-id>.toml` specifies *"its granted tools and MCP domains."* Structural seed: `permissions.toml  # granted tools, reversibility gates, egress allowlist`. The same fact — which tools an agent may use — lives in two committed files, and no AD says which wins when they disagree.

AD-16 exists precisely to kill this failure class for profile-versus-repo-instructions (*"the two-sources-of-truth failure where the profile and the repository's own `CLAUDE.md` or `AGENTS.md` disagree"*). The identical problem inside `.orch/` is unaddressed — and it is the capability-grant table, i.e. the one place where ambiguity becomes a security property. Compounded by F-02, where a third source (the repo's own `.mcp.json`) enters through AD-1.

---

## Summary table

| ID | Sev | Claim that did not land |
|---|---|---|
| F-01 | Critical | CAP-8 / success signal: timeline reconstructable from git alone — AD-4+AD-9 put the truth outside the repo |
| F-09 | Critical | Executor holds no push credential; gated committer; no force-push; protected `main` — no AD |
| F-10 | Critical | Hardened container run-flags, only-worktree mount, docker-socket assertion, two-phase network, egress proxy — AD-11 covers image provenance only |
| F-11 | Critical | Fail-closed redaction before any durable sink — absent, while AD-13+AD-4 mandate immutable verbatim recording |
| F-02 | High | AD-1 non-bare `claude -p` re-opens CAP-7's capability boundary via repo `.mcp.json`/hooks; the deferral's safety argument is false for tiers 0/1 and the Interviewer |
| F-03 | High | Model ladder inverted into a fixed per-agent `model tier`; no promotion event; no model pinning or temperature-zero rule |
| F-12 | High | Control/evidence plane split and CAP-9's declared token ceiling — the terms never appear |
| F-13 | High | Memory write discipline: only verified+merged to long-term; never code snippets; anchor durability; rebuildability |
| F-14 | High | Cost governance: three ceiling dimensions, hibernation, 80% degradation, never currency — governed by AD-4/AD-5/naming, i.e. nothing |
| F-15 | High | Silence means success / exceptions-only notification / quiet hours — no component, no rule |
| F-23 | High | Question mechanism: no question envelope in `contracts/`, no question/default-taken/decision/deflection event types, no timer owner |
| F-04 | Med | Reversibility class attached to the agent, not to every action type |
| F-05 | Med | Terminal-complete beyond the four steering controls; web renderer's optionality never stated; Q5 dropped |
| F-06 | Med | Web control surface has no loopback/single-user binding against the no-shared-server non-goal |
| F-16 | Med | User's own git identity, no bot identity, PR by default |
| F-17 | Med | Minimum guardrail set as a precondition on unattended execution |
| F-18 | Med | Gate 1 before gate 2; no review spend on a failing run |
| F-19 | Med | Re-grounding: verbatim original request as a required field of every step input |
| F-20 | Med | The governing exchange rate — the inputs' own stated tie-breaker |
| F-21 | Med | No bespoke framework / maintenance-burden restraint; hooks never appear; no tripwire in Deferred |
| F-22 | Med | Ephemeral resources wiped and verified empty; only the leased credential injected |
| F-24 | Med | Ambient status line and prompt-line mode display live outside both renderer processes and have no home |
| F-25 | Med | Feature-name addressing has no resolution structure; AD-4+AD-6 make the stage-1 morning brief a full scan |
| F-27 | Med | Granted tools declared in both `permissions.toml` and `agents/*.toml` with no precedence rule |
| F-07 | Low | One-writer-per-file convention contradicted by AD-15 and the error-shape convention |
| F-08 | Low | AD-9: `.gitignore` runtime paths vs "no runtime state in the repo" |
| F-26 | Low | Completion "what was not verified", review-request shape, and the trust record (input to the autonomy gate) are undefined |
