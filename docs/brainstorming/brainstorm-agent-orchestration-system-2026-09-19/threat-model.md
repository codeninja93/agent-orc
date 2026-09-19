# Threat Model & Guardrails — Agent Orchestration System

## How to use this

Work against this as a pre-flight checklist: before any run goes unattended, every item in §5 must exist and have been tested at least once. Everything else is the build backlog — tick rows off §2 as the defenses in §3 land.

---

## 1. What is being protected

An orchestrator plus subagents that analyze, plan, execute, test, verify and commit code changes largely unattended, on Deep's own machine, against real repositories — using git worktrees, Docker sandboxes, ephemeral postgres/redis, external tool integrations (Jira), and a local observability app.

Three things can be lost, in descending order of pain:

1. **The repository** (destructive git actions, bad merges, force-pushes, plausible-but-wrong code merged).
2. **Credentials and data** (secret leakage into transcripts/logs/PRs, sandbox escape onto the host).
3. **Deep's time and subscription capacity** (usage blowout, trust collapse, and above all maintenance burden).

---

## 2. Threat table

Every predator identified in the session, with the shape it takes in practice.

| # | Threat | What it actually looks like | Severity | Defense in |
|---|---|---|---|---|
| 1 | **Context poisoning** | The analyst mildly misreads the ticket; the planner summarizes the misreading; the executor builds from a summary-of-a-summary. Eight hours later there's a clean, tested, well-committed implementation of the wrong feature. | High | **v0** |
| 2 | **Usage blowout** | An executor loops on a failing test overnight. Nobody watches. Morning brings an exhausted rate-limit window, a blocked day's work, and a 2-line diff. | High | **v0** |
| 3 | **Plausible-but-wrong code** | Diff reads beautifully, tests pass, reviewer LLM approves. The tests were written from the same misunderstanding as the code, or only cover the happy path. Fails in production. | High | **v0** (basic), later (full) |
| 4 | **Merge hell** | Three features run in parallel; two touch `auth/`. Both merge clean individually; combined, the session logic is incoherent. Hours lost untangling. | High | **v0** (territory declaration), later (predictor) |
| 5 | **Orchestrator bottleneck** | Every subagent message passes through one context window. Five features in flight, the orchestrator is at 90% context, coordination costs more tokens than the work. | Medium | later |
| 6 | **Trust collapse** | One bad autonomous merge and Deep reviews every diff by hand forever. The system still runs but delivers zero leverage — the worst outcome that isn't a disaster. | High | **v0** |
| 7 | **Nondeterminism** | The same feature run twice gives two different plans. A bug reported from a run cannot be reproduced. Debugging becomes archaeology. | Medium | **v0** (pinning), later (full replay) |
| 8 | **Secret leakage** | A Jira token lands in an agent transcript, which lands in the flight recorder, which lands in a PR description or a dashboard screenshot. Permanent, and possibly public. | Critical | **v0** |
| 9 | **Destructive actions** | `git reset --hard` on the wrong worktree, `rm -rf` in a mounted volume, a force-push that erases a colleague's branch, a `DROP TABLE` against a non-ephemeral database. | Critical | **v0** |
| 10 | **Spec drift** | What shipped is not what was asked. No single step went wrong; each step drifted 5%. Discovered only at review. | High | **v0** |
| 11 | **Model deprecation** | The model the whole prompt suite was tuned against is retired. Every agent's behavior shifts at once, silently, and quality degrades before anyone notices. | Medium | later |
| 12 | **Maintenance burden** | The orchestrator becomes the project. Deep spends Saturdays fixing the thing built to save Saturdays. **See §4.** | Critical | **v0** |
| 13 | **Alert fatigue** | The dashboard shows everything, so it shows nothing. Notifications get muted. The one real failure scrolls past unseen. | Medium | **v0** |
| 14 | **Tool outages** | Jira is down. The entire pipeline blocks on a ticket lookup that could have been served stale from cache. | Low | later |
| 15 | **Sandbox escape** | A container with the docker socket mounted, or running as root with the home directory bind-mounted, reaches the host. Blast radius jumps from one worktree to the whole machine. | Critical | **v0** |

---

## 3. Defenses in depth

### 3.1 Containment

The sandbox is what makes everything else recoverable. Build it first and never soften it.

| Defense | What it stops | How to implement |
|---|---|---|
| **Least-privilege container** | Sandbox escape, destructive actions reaching the host | One hardened base image used by every executor: `--read-only` root filesystem, a `tmpfs` for `/tmp`, **only the worktree bind-mounted** (never `$HOME`, never the repo root, never `.ssh`, never `.aws`), `--user` a non-root uid, `--cap-drop=ALL`, `--security-opt=no-new-privileges`, a seccomp profile, and memory/pid limits. Put it in one `docker run` wrapper script so no agent ever composes its own flags. |
| **No docker socket, ever** | The single highest-value escape path — socket access is root on the host | Never mount `/var/run/docker.sock` into an agent container. If an agent needs a database, it is leased one from the pool by the host-side harness, not spawned by the agent. Add a startup assertion that fails the run if the socket is present. |
| **Two-phase sandbox** | Exfiltration and dependency-confusion during execution, while keeping installs possible | Phase 1 (provisioning): network on, install dependencies, snapshot the image layer. Phase 2 (execution): `--network=none` or allowlist-only. Safety and capability separated in *time*, not traded off. |
| **Egress allowlist proxy** | Data exfiltration, unlogged outbound calls, surprise third-party API charges | All container traffic through a single proxy (`HTTP(S)_PROXY` env + `--network` pointing at a proxy-only bridge). Allowlist: the Anthropic API, the package registry for the stack, the git remote, the Jira host. Everything else 403s. **Every call logged** — the log is also the audit trail for §3.2. |
| **Ephemeral resources are truly ephemeral** | `DROP TABLE` against something that mattered | Postgres/redis are pool-leased, per-worktree, wiped on return. No agent ever receives a connection string to anything that is not disposable. Enforce by construction: the only DB credential injected is the leased one. |

### 3.2 Capability & credential control

The key idea from the session: **capability tokens convert ownership rules from policy into physics — an agent cannot disobey what it cannot reach.**

| Defense | What it stops | How to implement |
|---|---|---|
| **Secrets never enter context** | Secret leakage (the critical one) | No credential is ever a string an LLM sees. Credentials are injected as env vars into the *owning tool-server container only*. The Jira token lives in the Jira tool-server and nowhere else; the executor container has no Jira token to leak, because it has none at all. |
| **Capability tokens as enforcement** | Domain-ownership violations, privilege creep | Each agent's identity is its set of mounted credentials and granted tools, not a sentence in its system prompt. "Only the Jira agent may write Jira" is true because it is the only process holding the token. Review capability grants as a small table in config — it should be short enough to read in one screen. |
| **Output scanners / redaction** | Secrets reaching logs, the flight recorder, PRs, the dashboard | A redaction pass on the boundary *between* agent output and any durable sink (event log, git notes, dashboard, PR body). Pattern set: known token prefixes, high-entropy strings, `.env` contents, private-key headers, the literal values of the injected env vars. Fail closed: if the scanner errors, drop the artifact rather than write it. |
| **Deterministic shim in front of the credential** | Model usage and blast radius on external tools | The Jira agent is mostly a typed API cache; ~80% of calls answer from local reads with zero LLM involvement and no fresh credential use. Fewer credentialed calls = fewer leak surfaces. |

### 3.3 Blast-radius control

The session's sharpest reframe: **the real variable is reversibility, not trust.** Autonomy is safe where actions are undoable; gate only what isn't.

| Defense | What it stops | How to implement |
|---|---|---|
| **No claws in the sandbox** | Destructive git actions, prod damage | The executor container has **no push rights and no prod credentials**. It can commit locally in its worktree and nothing more. Implement via a deploy key / credential helper that simply isn't mounted there. |
| **Separate gated committer** | Unreviewed pushes | Exactly one agent may push, it runs outside the executor sandbox, it passes a gate before pushing, and it **never force-pushes**. Enforce with a git wrapper that rejects `--force`/`--force-with-lease`/`push :branch`, and a pre-push hook. |
| **Protected branches** | Everything, when every agent-level guard has failed | Server-side branch protection on `main`: no force-push, no deletion, PR required. This is the last line that holds regardless of what the agents believe. Set it up before the first unattended run — it costs five minutes and it is the one control that does not depend on the system behaving. |
| **Reversibility-tiered autonomy** | Trust collapse; over-gating that kills leverage | Classify actions by blast radius: read-only → auto; writes-code-in-worktree → auto; writes-shared-branch → gate; writes-prod / consumes an external paid quota → gate. Risk tier also selects isolation: in-place edit for a typo, branch-only for small changes, full worktree + container for real features. |
| **Undo-first design** | Any irreversible mistake becoming permanent | Engineer every step to have an undo — worktree (delete it), branch (delete it), canary (auto-revert), commit (revert). Where an undo exists, autonomy is free. Where none exists, that's the gate point. Design the undo *before* the action. |
| **Territorial marking** | Merge hell | Features declare their file territory up front. The orchestrator refuses concurrent features with overlapping territory, or forces rebase-early. Parallelism is bounded by conflict domain, not by a fixed worker count. |
| **Termite-mound bounded build** | Diff sprawl, "while I was in there" refactors | Agents may only modify files adjacent to already-changed files. A diff that suddenly spans the repo is a signal, not a feature. |

### 3.4 Usage and capacity

> **Economic model.** Model usage is prepaid through a Claude Code subscription, not billed per token. There is no currency ceiling to enforce and no per-token bill to optimize. The scarce resources are the **rate-limit window** (exhausting it blocks the next piece of work), **wall-clock time**, and **Deep's attention**. Every control below is denominated in those, never in dollars.

| Defense | What it stops | How to implement |
|---|---|---|
| **Metabolic cap with hibernation reflex** | Overnight usage blowout | A hard per-feature ceiling in steps, wall-clock time and consumed rate-limit budget. On hit, the system **hibernates** — snapshots state, writes a handoff note, pings Deep — rather than dying mid-write or continuing. The cap is enforced by the harness, not by the agent's self-restraint. |
| **Graceful degradation at 80%** | Dying at the cap with nothing to show | At 80% of the ceiling: downshift every agent to the cheapest model, narrow scope, prefer finishing over exploring. Degrade, then stop — do not fall off a cliff. |
| **Wall-clock cap per feature** | Silent runaway that isn't expensive yet | A hard clock. On expiry agents must report *partial progress*, not just terminate. A run with no output is a debugging problem; a run with a partial report is a resumable one. |
| **Step cap per agent** | Infinite loops — the cheapest guard that exists | N turns per agent, then die. Combine with "death as a feature": the dead agent's partial work stays as a marker for whoever picks it up. Implement as a counter in the harness loop; it is ten lines and it catches the majority of runaway cases. |
| **Usage anomaly detection** | Blowouts that stay under the cap but are clearly wrong | Keep a historical baseline of steps-per-feature and tokens-per-feature by feature class. Alert on deviation from baseline, not just on absolute usage — a 6× steps-per-feature figure on a small change is a bug signal long before the ceiling. |
| **Dry-run + usage estimate** | Burning a rate-limit window on a bad plan | Full pipeline against a mock executor: shows the plan and an estimated step and token count before any real capacity is consumed. |

### 3.5 Correctness & context integrity

| Defense | What it stops | How to implement |
|---|---|---|
| **Re-grounding against the original request** | Context poisoning, generation loss | Hard rule: **every agent re-reads the original feature request verbatim**, never a summary of a summary. The original request is a file in the worktree, and reading it is step zero of every agent prompt. |
| **Immune checkpoint** | Poisoned artifacts propagating downstream | A cheap sanity agent validates each artifact against the original request *before* it is allowed to flow to the next stage. Cheap model, narrow question: "is this still an answer to that?" |
| **Spec echo** | Spec drift — and the cheapest possible defense against it | Before a line of code is written, the orchestrator restates the feature as acceptance criteria and Deep confirms in **one keystroke**. Costs seconds, saves whole runs. Non-negotiable in v0. |
| **Quorum sensing** | Ambiguous requests executed on one shaky reading | Do not begin executing until 2 of 3 analysts independently converge on the same interpretation. Divergence is the signal to ask Deep rather than guess. |
| **Provenance tags** | Untraceable wrong output | Every claim/artifact carries the agent and step that produced it. When something is wrong, you get the exact step to fix rather than a search. Git notes on the handoff commits is enough infrastructure. |
| **Adversarial tester agent** | Plausible-but-wrong code | A tester whose explicit job is to **break** the implementation, rewarded for finding failures, not for confirming success. Run it with no access to the executor's rationale — only the request and the diff. |
| **Property-based tests** | Happy-path-only tests written from the same misunderstanding as the code | Prefer invariants over examples. Plausible-but-wrong code survives example tests and dies against properties. |
| **Test-first inversion** | Verify ambiguity | The tester writes failing tests from the feature description *before* the executor runs. Definition-of-done becomes mechanical. |
| **Two-tier verification economics** | Spending model capacity reviewing code that doesn't compile | Gate 1: typecheck, lint, tests — free and deterministic. Gate 2: LLM review. Never run gate 2 if gate 1 fails. |
| **Determinism pinning** | Nondeterminism, unreproducible bugs | Temperature zero wherever the step isn't explicitly creative; **pinned model versions** (never a floating alias); full inputs recorded so any run is replayable. Nondeterminism is quarantined to named creative steps, not ambient. |
| **Prompt/model abstraction + golden-task suite** | Model deprecation shifting behavior silently | Prompts and model IDs behind one config layer, plus a small golden-task regression suite. Swapping models becomes a tested migration instead of a leap of faith. Run the suite on every model version bump. |

### 3.6 Operational resilience

| Defense | What it stops | How to implement |
|---|---|---|
| **Circuit breaker + cached read-replica** | Tool outages halting the pipeline | Any agent may read a cached snapshot of an owned domain; only the owning agent writes. When Jira fails N times, the breaker opens and reads degrade to stale-with-a-warning instead of blocking. |
| **Rate-limit token buckets** | One runaway agent exhausting an external quota for everything else | The owning agent holds a token bucket for its external tool; the rest of the system cannot deplete it. Rate-limit-aware scheduling rather than retry storms. |
| **Playing dead** | Expensive thrashing on a problem the system can't solve | On repeated failure: **halt**, write a complete handoff document (what was tried, what failed, current state, suggested next step), and get out of the way. Stopping well is a feature. |
| **Escape hatch command** | Being trapped inside the system when it misbehaves | One command that dumps all in-flight work to an ordinary git branch and detaches the system entirely. Manual takeover is always one keystroke away. Test it before trusting the system, not after. |
| **Chaos drill** | Discovering fragility during a real run | Architecture test: kill a random agent mid-run and observe whether the system degrades or halts. Run it deliberately, on a schedule. A pipeline that halts is acceptable if it halts *cleanly*; one that corrupts state is not. |
| **Boring, inspectable state** | 2am debugging of clever machinery | Files, git, SQLite. Event-sourced, append-only, crash-safe, greppable. State is a fold over the event log, so a crashed run is resumable and an inspection is `cat`. |

### 3.7 Human factors

| Defense | What it stops | How to implement |
|---|---|---|
| **Trust earned in phases** | Trust collapse from one bad autonomous merge | Phase 1: system analyzes and proposes only; Deep merges by hand. Phase 2: autonomy unlocked **per risk tier** as measured accuracy accrues. Use shadow mode — run against a feature Deep already built, diff against the real commit — so trust is empirical, not vibes. |
| **Exceptions by default** | Alert fatigue | The dashboard shows **exceptions only**; the full timeline is available on demand. Silence must mean success. If a notification isn't actionable, it should not exist. |
| **Design for tired-2am-you** | The real predator: Deep's own future self at 2am | Favor boring inspectable state over clever distributed machinery. Everything should be diagnosable with `git log`, `cat`, and `sqlite3` while half-awake. Anything that requires reasoning about distributed consensus to debug is a defect. |
| **Surface the binding constraint** | Attacking the wrong bottleneck | The dashboard names the currently binding constraint — rate limit, context, wall-clock, or conflicts — so effort goes where it pays. |

---

## 4. The predator most likely to actually kill the project

**Maintenance burden. The orchestrator becomes a product that is maintained instead of used.**

None of the other fourteen predators kill this project. Sandbox escape is survivable, usage blowout is capped, a bad merge is revertible. What kills it is the slow version: the orchestrator accumulates a scheduler, a message bus, a custom observability stack, a plugin system — and Deep spends his Saturdays maintaining the thing he built to buy back Saturdays. The system consumes exactly the resource it was built to create. It never fails loudly; it just stops being worth it.

**The defense is architectural restraint, decided up front:**

- **Build on Claude Code's existing primitives — subagents, hooks, MCP, worktrees — as *config plus small scripts*, never a bespoke platform.** Every component that already exists and is maintained by someone else is a component that cannot rot on you.
- **Reuse over build for the supporting cast.** Git as the message bus (comms, audit, replay, flight recorder, stigmergy — one decision solves five problems). Git notes for agent metadata. SQLite for the event log. A TUI over the event stream before any web app; the web app is a second renderer of the same stream, if ever.
- **Three agents, not eight.** A deterministic workflow engine with LLM intelligence only at the leaves — the pipeline is code, not a model deciding what comes next. Fewer moving parts, lower token cost, higher reliability, and far less to maintain.

**Stop-building tripwires.** These exist to tell you when to *stop*, which is the whole point:

| Tripwire | Meaning |
|---|---|
| **Shadow mode says it's good enough** | It reproduces a feature Deep already built, to comparable quality. Ship it. Stop adding agents. |
| **Dry run shows the usage is acceptable** | The estimated step and token count fits the ceiling. There is no per-token bill to optimize — usage is prepaid — so measure **interruptions and rework per merged feature**, not token counts; terseness barely moves either and causes rework. |
| **A week of work on the orchestrator with zero features shipped through it** | You are maintaining, not using. Stop and ship a feature with what exists. |
| **A new component is being built that an existing primitive nearly covers** | Take the 80% primitive. The missing 20% is rarely worth a maintained subsystem. |
| **The system's own backlog is growing faster than the products it builds** | Hard stop. Freeze features on the orchestrator until that inverts. |

---

## 5. v0 minimum guardrail set

Nothing runs unattended until **all** of these exist and each has been exercised once on purpose.

**Containment**
1. **One hardened container wrapper** used by every executor: read-only rootfs, non-root user, `--cap-drop=ALL`, `no-new-privileges`, seccomp profile, **only the worktree mounted**, and a startup assertion that the docker socket is absent.
2. **Network off during execution** — two-phase sandbox, or an egress allowlist proxy if installs must happen inline. No open egress from an execution-phase container.

**Credentials**
3. **Zero secrets in any agent context.** Credentials only as env vars in the owning tool-server container. The executor holds none.
4. **Redaction pass on every path to durable storage** — event log, git notes, dashboard, PR bodies. Fails closed.

**Blast radius**
5. **Protected `main`** with force-push and deletion disabled, server-side. Set this up first; it is the only control that survives total agent failure.
6. **Executor has no push credential.** A single gated committer pushes, and a git wrapper rejects every force-push variant.
7. **Escape hatch command**, written and *tested*: dumps in-flight work to an ordinary branch and detaches.

**Usage and capacity**
8. **Hard per-feature ceiling in steps, wall-clock and rate-limit budget, with hibernation** on hit, enforced by the harness.
9. **Wall-clock cap per feature** and **step cap per agent**. The step cap is the single cheapest guard here — do not skip it because it looks trivial.

**Correctness**
10. **Spec echo before any code** — acceptance criteria restated, one-keystroke confirm.
11. **Re-grounding rule enforced in every agent prompt**: read the original request verbatim, never a summary.
12. **Gate 1 verification (typecheck + lint + tests) must pass before anything is proposed for commit.** LLM review is gate 2 and optional in v0.
13. **Pinned model versions and temperature zero** outside explicitly creative steps.

**Operations & trust**
14. **Append-only event log (SQLite or files) that survives a crash**, and a run is resumable from it.
15. **Playing dead on repeated failure**: halt and write a handoff document rather than retry-thrash.
16. **Exceptions-only notifications.** Silence means success.
17. **Phase 1 autonomy only**: the system proposes, Deep merges. Autonomy is unlocked per risk tier only after shadow mode shows measured accuracy.

**Before the first unattended night, run the chaos drill once** — kill an agent mid-run and confirm the system halts cleanly, the event log is intact, and the escape hatch works.
