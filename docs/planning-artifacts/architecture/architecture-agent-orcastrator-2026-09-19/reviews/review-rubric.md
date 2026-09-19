---
type: architecture-spine-review
target: ../ARCHITECTURE-SPINE.md
reviewer: rubric
date: '2026-09-19'
verdict: revise — strong on agent/state/event invariants, but three load-bearing dimensions are silent or wrongly deferred
---

# Rubric Review — ARCHITECTURE-SPINE.md (Agent Orchestration System)

Method: read the spine, `SPEC.md`, `.memlog.md`, and the spec companions `architecture.md` / `interface-contract.md` for grounding. Stack claims checked against the local machine. All three mermaid blocks extracted and rendered with `@mermaid-js/mermaid-cli` 11.17.0.

**Verdict: revise.** AD-1 / AD-4 / AD-5 / AD-7 / AD-9 / AD-10 / AD-13 / AD-14 / AD-15 are genuine spine material — non-obvious, real trade-offs, enforceable. But the spine fixes the *vertical* invariants (how a step runs, where truth lives) and leaves the *lateral* ones unfixed: how a renderer reaches the engine, what lands in git vs the event log, what the spawn baseline actually is, and how anything gets tested. Four checklist items fail outright.

---

## 1. Fixes the real divergence points, misses none — **FAIL**

Hits: agent invocation (AD-1), language (AD-2), event truth (AD-4), envelope (AD-5), state ownership (AD-7), resume (AD-8), layout (AD-9), project identity (AD-10), image (AD-11), distribution (AD-12), domain access (AD-13/14/15), roster (AD-17). These are correctly chosen.

Misses, each of which passes the two-units-diverge test:

**1a. The engine's process model and the command path are never fixed.** AD-3's Rule says every steering action is "issued through the same command path into the engine" — the spine never says what that path is. Is the engine a long-lived daemon under `ORCH_HOME`, a process the TUI owns in-process, a systemd/launchd service, or a loop re-invoked per pass? Do TUI and web reach it over a unix socket, HTTP on a local port, or by dropping command files into `runs/<run-id>/`? AD-7 makes the engine a reconciler over on-disk state but says nothing about who hosts the loop or how it is signalled. `src/tui/` and `src/web/` are named as separate directories in the Structural Seed — two units, built independently, that *must* choose the same transport and cannot. This is the single largest gap.

**1b. Nothing fixes what goes into git.** `SPEC.md` CAP-8 success: *"A feature's full agent timeline is reconstructable from `git log` and notes alone, with no other datastore present."* The spine's AD-4 makes `$ORCH_HOME/runs/<run-id>/events.jsonl` the durable truth and AD-9 forbids any event log inside the target repository. The Capability Map row *"CAP-8, CAP-9 — git as message bus"* is governed by *"AD-4, AD-5, AD-9"* — none of which says anything about git. `architecture.md:39` is explicit that *"Each step commits its output into the feature worktree. `git log` is the timeline; git notes carry cost and reasoning."* The spine mentions git notes exactly twice — once inside a mermaid label (`"Feature worktree — branch, commits, git notes"`) and once as an exception in AD-9's Rule (`"besides the feature branch and git notes"`). No AD fixes the per-step commit handoff, the git-notes schema, or the relationship between the notes timeline and the JSONL timeline. Step agents, the committer and the recorder are three independently-built units that all write into this space with no rule. Either the spine needs an AD, or it needs to state that it is knowingly contradicting CAP-8's success criterion.

**1c. The spawn-argument baseline is under-specified.** AD-1 fixes three flags (`--json-schema`, `--output-format stream-json`, not `--bare`). The installed CLI (2.1.278) also exposes `--permission-mode` (7 values), `--permission-prompts host|none`, `--strict-mcp-config`, `--restricted`, `--settings`, `--max-budget-usd`. AD-17 says an agent TOML declares *"its granted tools and MCP domains, its model tier and its reversibility class"* — but nothing maps those TOML fields onto spawn flags. The reversibility gate (CAP-12) is implemented by *some* combination of `--permission-mode` and `--permission-prompts`, and the spine does not say which. Two units implementing "reversible actions proceed unattended" will pick differently.

**1d. No mutual exclusion on the engine.** AD-4 and the conventions table both assert *"exactly one writer per file"* / *"One writer per file"* — as a property, never as a mechanism. AD-7 invites restarts (*"killing the engine at any instant and restarting it"*) and AD-3 gives two renderers command authority. Nothing prevents a second reconciler from claiming the same feature and appending to the same `events.jsonl`. No lock file, no PID file, no lease. The one-writer invariant is currently a hope.

## 2. Every Rule enforceable, and prevents what it claims — **FAIL**

**2a. AD-7's Rule is partly aspirational.** *"killing the engine at any instant and restarting it must produce identical behaviour to never having stopped; every reconciler action is idempotent."* Neither clause is checkable by a reviewer reading a diff. "Identical behaviour" is untestable against a nondeterministic model, and "every reconciler action is idempotent" is a property assertion with no mechanism — compare AD-15, which does it correctly by naming *"an idempotency key derived from run id plus intent id."* AD-7 should name the mechanism (claim tokens in `state.json`, a monotonic step generation) or it is a wish.

**2b. AD-8 does not prevent what it claims.** Prevents: *"silently double-applying side effects or silently discarding completed work."* The Rule fences nothing: *"no step may depend on having run exactly once"* is an unenforceable negative — no reviewer can tell from code whether a step "depends on" having run once. AD-15 fences *external-domain* writes only. The worktree is a side effect: an implementation step writes source files and commits. If it is killed after writing three files and before committing, the re-run path in AD-8 says only "re-runs the step from its typed input file" — with no rule about whether the worktree is reset to the step's input commit first. The reconciler will assume a clean slate; the step agent will find half its own output already on disk. The memlog's justification (*"re-running is always safe because AD-1 makes every step a pure function over typed files"*) is false for any step that mutates the worktree, and the spine inherited the error.

**2c. AD-17 contradicts AD-2.** AD-17: an agent TOML specifies *"its step contract schemas"* and *"adding an agent requires no engine change."* AD-2: *"every step contract is a Zod v4 schema exported via `z.toJSONSchema()`"*, and the Structural Seed puts them in `src/contracts/`. A user-defined agent with a new input/output shape therefore requires a code change in `src/contracts/` — so AD-17's closing clause is false as written. Either the TOML *references* an existing contract id (and user agents are restricted to existing shapes), or agent TOML may carry an inline JSON Schema (and AD-2's "defined once as a Zod schema, never hand-written" is breached). The spine must pick one.

**2d. AD-6 prevents something other than a divergence.** Prevents: *"building a schema and a migration path before any query actually hurts."* That is premature-work avoidance, not two units choosing incompatibly — AD-4 already does the divergence work by making any index a derived projection. And the trigger is unenforceable: *"cannot be served **acceptably** by scanning JSONL"* has no threshold and no owner. AD-6 is a deferral wearing an AD's clothes; it is also duplicated verbatim as the first Deferred bullet. Demote it to Deferred only.

**2e. AD-16's precedence rule is not mechanically decidable.** *"where both speak to the same point the repository wins and the profile entry is flagged stale."* Detecting that a profile prose section and a paragraph of `CLAUDE.md` "speak to the same point" is a semantic judgement no loader can make. The enforceable version is key-level: name the mechanic keys the profile owns exclusively (`test`, `lint`, `build`, `run`, package manager, source layout, resource needs, risk tiers, conflict domains) and declare everything else repository-owned. The Rule already lists exactly those keys — it just doesn't make the list closed.

**2f. AD-11 references an undefined contract.** *"the build is the only step permitted network access outside the egress allowlist"* — "the egress allowlist" appears nowhere else in the spine except as a comment in `permissions.toml` in the Structural Seed. It is defined in `architecture.md:58` ("egress allowlist proxy"), but the spine is the build substrate and it binds a rule to a mechanism it never fixes. Either bind the proxy mechanism or name the companion explicitly in the Rule.

**2g. AD-18's Prevents is a policy, not a divergence.** *"the design-time toolchain leaking into the runtime product"* — real and worth stating, but it is not a case of two units choosing incompatibly. Borderline; keep it, but it is the weakest AD on the spine test.

Enforceable and well-formed, for contrast: **AD-5** (names every envelope field plus the forward-compat rule), **AD-10** (first-commit SHA, path is a mutable pointer), **AD-11**'s hash-tagged rebuild, **AD-14**, **AD-15**'s idempotency key. These are the model the weak ADs should follow.

## 3. Nothing under Deferred could let two units diverge — **FAIL**

Two of six bullets are misfiled.

**3a. *"Web renderer framework, bundler and port convention."*** A **port convention** is an interface between the web surface and whatever the engine listens on. The safety argument is circular: *"AD-3 fixes that both renderers issue the same commands through the same path into the engine, so the renderer's internals cannot make two units diverge"* — but AD-3 never fixes the path (finding 1a). Framework and bundler are safely deferred; the transport and port are not. Promote to an AD.

**3b. *"Threat-model coverage for non-bare `claude -p` loading a project's `.claude/settings.json` hooks and `.mcp.json` servers without a trust prompt."*** Not a threat-model annotation — a spawn-argument decision every unit that spawns `claude -p` must make identically, and the CLI already offers the levers (`--strict-mcp-config`, `--restricted`, `--settings`). The claimed safety is wrong on its own terms: *"AD-13 already confines credentials to one MCP server per domain."* AD-13 confines the servers **the engine passes with `--mcp-config`**. Without `--strict-mcp-config`, the target repository's own `.mcp.json` servers load *in addition*, which is precisely the exposure the memlog flagged as *"a supply-chain exposure the threat model does not currently cover."* This defeats `CAP-7`'s success criterion — *"A non-owning agent attempting that domain's API fails for absence of credential; verified by test"* — because an agent can reach a domain through a server the engine never granted. AD-13's Rule is unenforceable until this is decided. Promote to an AD.

Safely deferred: SQLite index, shadow-mode threshold, model-ladder rungs, installer question wording. Those four are correctly argued.

## 4. Named technology current and correctly characterised — **PARTIAL PASS**

Verified against the local machine: `claude` 2.1.278 ✓, Docker 29.7.2 ✓, Node 22.14.0, npm/npx 11.4.2. The flags AD-1 and AD-13 depend on all exist in 2.1.278: `--json-schema`, `--output-format text|json|stream-json`, `--permission-prompts host|none`, `--mcp-config`, `--resume`, `--bare`. Node 22 "Jod" and 24 "Krypton" are the correct codenames. Zod 4's native `z.toJSONSchema()` is correctly characterised as removing the external converter.

**4a. The declared floor is unmet by the only known machine, with a concrete consequence.** The Stack table sets `Node.js >=22.22` and notes *"dev machine currently 22.14.0"* — it states the gap and does nothing with it. This is not cosmetic: the Structural Seed declares `bin/init.ts` as the `npx github:<owner>/<repo> init` entry point, a **`.ts` file executed directly by Node**, which requires Node's unflagged type stripping (22.18+). On 22.14.0 the declared entry point does not run. Likewise `npm 12.x` against local `npx 11.4.2`. A spine that names a floor should either state the upgrade as a precondition or drop the floor.

**4b. TypeScript 7.0.2 is asserted with no characterisation.** Every other row carries a justification; TS 7 — the native-port compiler — carries none, and it is the row most likely to have feature/API gaps that affect a build. State why 7 and what the fallback is, or drop the pin to a range.

## 5. Covers the driving spec's capabilities — **PARTIAL PASS**

The Capability → Architecture Map covers CAP-1 through CAP-23 with no gaps. Good.

But coverage of the spec's **Constraints** — which are as binding as the capabilities — is thin:

- *"Executor sandboxes hold no push and no production credentials. Only a gated committer may push. Force-push is never permitted."* No AD. CAP-10's success criterion is *"the container tier's executor has no push credential, verified by test"* and the map routes CAP-10 to AD-9 and AD-11, neither of which mentions credentials. This is a divergence point: the worktree lifecycle unit, the executor image and the committer step all need one rule about where the push credential lives.
- *"Secrets never enter model context: injected as environment into the owning tool-server container only, with output redaction before any logging or posting."* No AD, and **AD-13 actively contradicts it**: *"the runtime records every request and response to the event log and to the run shared fetch record."* Every response, verbatim, unredacted, into an append-only file that AD-4 says is never mutated. See 6b.
- *"Silence means success: notify only on exception, decision point, or completion."* No notification channel is fixed. CAP-22's ambient status has nowhere to live when neither renderer is open.
- CAP-8 — see finding 1b.

## 6. Every structural dimension decided, deferred, or open — **FAIL**

| Dimension | Status |
| --- | --- |
| Operational / environmental envelope | **Partial.** Deployment (AD-12), infra (AD-11), layout (AD-9), upgrade (AD-12), prune (AD-9) are decided. **The engine's own process model, hosting and lifecycle are silent** (1a). Retention/compaction of `runs/` is silent. |
| Security & credentials | **Partial → failing.** AD-13 (one credential per domain), AD-12 (no bundled credential), conventions (subscription login, no `ANTHROPIC_API_KEY`). **Silent: redaction, push-credential ownership, the egress-allowlist mechanism, the spawn-hardening baseline** — the last wrongly filed under Deferred. |
| Data / state model | **Decided.** AD-4, AD-5, AD-7, AD-9 plus the conventions table. Gap: the control/evidence boundary that CAP-9's *"declared token ceiling"* and CAP-17's *"read budget"* depend on — whether evidence enters a step's input inline or by pointer — is a contract between the recorder and the input builder and is unfixed. |
| Concurrency | **Partial.** Cross-feature concurrency and territory serialization are in the conventions table. **Silent: single-engine-instance enforcement** (1d). |
| Error handling & failure semantics | **Partial.** The `code`/`message`/`retryable`/`cause` shape is fixed. **Silent: retry and backoff policy, and the threshold behind the state diagram's `running --> handed_off: escape hatch, or repeated failure`** — "repeated" is never quantified and is not in Deferred either. |
| Testing / verification strategy | **SILENT.** Not one AD, not one Deferred bullet, on how the orchestrator's *own* units are tested. CAP-13 is test-first verification of the *target repo*; CAP-21 shadow mode is a product capability. Nothing says how a step agent is exercised without live model calls, whether the replay runner over `events.jsonl` is the harness, or what a unit must ship to be considered verified. For a system whose stated top risk is maintenance burden, this is the most surprising omission on the page. |
| Observability | **Decided.** The event log is the substrate; *"No unit writes diagnostics to stdout"*. Two edges: an Ink TUI *is* stdout, so the rule needs wording that distinguishes rendering from diagnostics; and engine/installer failures that occur before a run exists have nowhere to go. |
| Configuration | **Partial.** AD-9, AD-16, AD-17 and the TOML/JSON split are solid. **Silent: config schema versioning and migration.** AD-12 makes upgrade re-run the installer and preserve answers, but nothing says what the engine does with an `agents/*.toml` written by an older installer. AD-5 gives events an explicit forward-compatibility rule (*"readers must ignore unknown types"*); configuration gets none, and installer and engine are exactly the two independently-built units that will diverge here.

## 7. Terse and convergent — **PASS, with trims**

The document is disciplined and mostly reads as a substrate. Rationale that belongs in the memlog:

- Design Paradigm bullets: *"not shutdown handlers that must be correct"*, *"rather than by discipline"* — persuasion, not constraint. The third bullet (*"Every surface … is a projection of one log"*) restates AD-4.
- AD-12's Prevents carries a licensing argument: *"which the Agent SDK terms forbid without prior approval."* Memlog material.
- AD-6's Prevents is pure rationale (see 2d).
- The Deferred section's *"Safe: …"* paragraphs are the right idea but run long; the `.claude/settings.json` bullet is three lines of argument for a position that is wrong (3b).
- AD-9 and AD-16 are each a single Rule carrying 6–8 independent obligations. AD-16 in particular folds authorship, review, storage location, provenance, decay policy and a re-validation sweep into one sentence chain. Split, or the Rule cannot be checked clause by clause.

## 8. Frontmatter complete and accurate; paradigm carries meaning — **PARTIAL PASS**

Frontmatter is complete: `name`, `type`, `purpose`, `altitude: initiative`, `paradigm`, `scope`, `status: draft`, dates, `binds` (CAP-1…CAP-23), `sources`, `companions`. All relative paths resolve — the six companions exist at `docs/specs/spec-agent-orchestrator/` and `docs/brainstorming/brainstorm-agent-orchestration-system-2026-09-19/`.

The paradigm carries real meaning rather than being a label: "reconciled pipeline" is discharged by AD-7 (reconciler), AD-1 (pipeline stage = subprocess) and AD-4 (append-only log), and the Structural Seed maps directories onto it. Good.

**8a. The `[ADOPTED]` marker is undefined and inconsistently applied.** It appears on AD-1, AD-3, AD-4, AD-7, AD-9, AD-12, AD-13, AD-16 and is absent from AD-2, AD-5, AD-6, AD-8, AD-10, AD-11, AD-14, AD-15, AD-17, AD-18 — yet `.memlog.md` records all of them identically as `(decision)` entries. Nothing in the frontmatter or the document defines what the tag means or what its absence implies. A builder cannot tell whether an untagged AD is binding. Either define it or remove it.

**8b. `scope` omits what the spine actually leaves out.** The scope line enumerates twelve fixed invariants but does not state the known exclusions (git-notes contract, command transport, redaction), which is how a reader would discover findings 1a/1b/6b for themselves.

## 9. Mermaid diagrams valid and structurally earning their place — **PASS**

All three blocks extracted and rendered successfully with `@mermaid-js/mermaid-cli` 11.17.0 (`flowchart TD` dependency graph, `flowchart LR` run flow, `stateDiagram-v2` lifecycle). No syntax errors; quoted labels correctly protect the em dashes, commas and the `claude -p` hyphen.

- **Diagram 1 (dependency DAG)** earns its place — an acyclic allowed-dependency graph is genuinely worse as prose, and the accompanying sentence adds the constraints a graph cannot carry (*"`contracts` depends on nothing… The installer depends on `contracts` only"*).
- **Diagram 3 (state lifecycle)** earns its place and is load-bearing.
- **Diagram 2 (run flow)** is the weakest: it largely restates AD-1, AD-4, AD-13 and AD-15 in picture form, and is the only place `git notes` appears outside a parenthetical (see 1b). Keep it, but it should not be where a contract is smuggled in.

**9a. The state vocabulary is normative by accident.** `drafting / confirmed / running / blocked / interrupted / verifying / committed / handed_off` are written into `state.json` by the reconciler and read by both renderers — three independently-built units — yet the set is fixed only by a diagram under "Structural Seed", with no AD and no forward-compatibility rule. Contrast AD-5, which explicitly makes adding an event type non-breaking. A builder cannot tell whether adding a state is a breaking change. Bind it in AD-7.

## 10. AD ids unique, sequential, complete — **PASS**

AD-1 through AD-18, no duplicates, no gaps, in order. Every AD carries **Binds**, **Prevents** and **Rule** in that order. Binds targets are concrete (named units plus CAP ids) rather than hand-waving. This is clean.

---

## Priority of fixes

1. Add an AD fixing the **engine process model and the command transport** the TUI and web both use (1a); then re-file the port convention out of Deferred (3a).
2. Add an AD fixing **what goes into git** — per-step commit handoff and the git-notes contract — and reconcile it with AD-4, or state that CAP-8's success criterion is knowingly not met (1b).
3. Promote the **`claude -p` spawn baseline** out of Deferred into an AD: `--strict-mcp-config`, settings scope, and the TOML-field → permission-flag mapping (1c, 3b).
4. Add an AD on **secret redaction before append**, and one on **push-credential ownership** (5, 6b). AD-13's "records every request and response" must be amended in the same pass.
5. Fix **AD-8 re-run semantics for worktree side effects** and give **AD-7** a mechanism instead of a property (2a, 2b).
6. Resolve the **AD-17 / AD-2 contradiction** over where a user agent's contract schema lives (2c).
7. Decide or deferrably name: **testing strategy**, **config schema versioning**, **single-engine-instance enforcement**, **retry/handoff thresholds** (6).
8. Demote AD-6 to Deferred; define or delete `[ADOPTED]`; bind the state vocabulary in AD-7.
