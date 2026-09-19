---
name: 'Adversarial review — Architecture Spine, Agent Orchestration System'
type: architecture-review
mode: adversarial
target: ../ARCHITECTURE-SPINE.md
reviewed: '2026-09-19'
verdict: 'Not ready to build from. 22 concrete divergence pairs found; 7 are spine-breaking — two units can each obey every AD to the letter and build things that cannot be assembled.'
---

# Adversarial Review — Architecture Spine

**Method.** For each pair below I constructed two units one level down (components the spine itself names: reconciler, step spawner, runtime recorder, intent executor, committer, worktree manager, pool manager, roster discovery, profile loader, installer, prune, TUI, web surface, shadow runner, MCP tool server). Each unit obeys every ADOPTED and draft AD as written. Each pair is then shown to be unassemblable. Speculative holes were dropped; everything below is reproducible from the text of the spine.

**Headline.** The spine does an unusually good job on *invocation, language, event shape and on-disk location*. It does almost nothing on *ownership of mutable non-event state, versioning, and the lifecycle of anything that can be killed*. Four entities — `state.json`, the worktree, the fetch record, and `.orch/` — each have two plausible owners under the current ADs. Three ADs (AD-4/AD-7, AD-8/CAP-15, AD-2/AD-17) contradict each other directly.

---

## Critical — these will produce unassemblable units

### C-1. Two declared authorities for "what step is this feature on"

**Unit A** — the web surface's timeline and the morning brief are built as a fold over `runs/<run-id>/events.jsonl`, per AD-4: the log is "the durable truth" and "no component may read an index for a fact the log holds."
**Unit B** — the TUI's morning brief (CAP-22: every in-flight feature, one screen, no command) reads `runs/*/state.json`, per AD-7: the state file "is the sole authority on its progress."

Both obey AD-4 and AD-7 to the letter. They are incompatible because **AD-4 and AD-7 name two different files as authoritative for the same fact.** They disagree in three real windows: (a) between the recorder appending `step.completed` and the reconciler's next pass writing state; (b) after a crash, where `state.json` is by construction older than the log; (c) forever, if the reconciler ever records a decision in state that it does not also emit as an event. CAP-14 demands both surfaces render the same run identically; they cannot.

The deeper problem: AD-4's clause "no component may read an index for a fact the log holds" makes `state.json` *illegal to read* if it is derived, and makes the log *not the truth* if it is not.

> **Add AD-19 — `state.json` is a checkpoint of a fold over the event log, never a second truth.**
> Rule: every fact in `state.json` is derivable by replaying `events.jsonl` for that run; the reconciler must expose `rebuild-state <run-id>` that reproduces it from the log alone, and this is the crash-recovery path; where the two disagree the log wins and the state file is discarded and rebuilt; the reconciler appends the event *before* writing the state checkpoint, never after. AD-4's "no component may read an index" is amended to permit reading `state.json` as a checkpoint while forbidding any fact to exist only there.

### C-2. Git and GitHub are not classified, so the committer has two legal designs

**Unit A** — the committer step agent is a `claude -p` with `Bash(git *)` and `gh` granted in its `agents/committer.toml` (AD-17 grants tools per agent); it commits, pushes the feature branch and opens the PR itself. This satisfies the SPEC constraint "only a gated committer may push" and architecture.md's "handoffs are commits."
**Unit B** — the committer emits `{intents: [{id, kind: "open_pr", ...}]}` in its typed output and the engine's intent executor performs the push and the PR, per AD-15: agents never write to an external domain, the engine executes each intent exactly once against an idempotency key.

Both obey AD-15, because **the spine never defines "external domain."** AD-13 implies a domain is something with an MCP server and a credential; git-over-SSH has neither. They are incompatible because A's push is re-executed on every AD-8 re-run of the committer step — producing a duplicate PR, which is precisely the failure AD-15 exists to prevent — and because B requires an MCP server for GitHub that AD-13 says must hold that domain's credential, which contradicts "executor sandboxes hold no push credential" if the committer runs in tier 2.

> **Tighten AD-15 — enumerate the write surface.**
> Rule: an *external write* is any state change outside `runs/<run-id>/` and the run's own worktree — explicitly including `git push`, tag creation, PR/issue operations, git notes on a pushed ref, and every MCP domain. All of them are declared as intents and executed only by the engine's intent executor. In-worktree commits are *not* external writes and remain the step's own. No step agent is ever granted a tool that reaches a remote.

### C-3. AD-8 resumes a step the user deliberately killed

**Unit A** — the kill control (AD-3, CAP-15) sends SIGTERM to the step's `claude -p` and records `step.killed`.
**Unit B** — the reconciler, on its next pass, sees a step whose subprocess is gone and whose session id is recorded in `state.json`, and per AD-8 "on recovery the reconciler attempts `claude -p --resume` with that id."

Both obey AD-3 and AD-8. They are incompatible because **AD-8 has no exception for an intentional termination** and the reconciler cannot distinguish a user kill, an OOM kill, a ceiling breach and a laptop closing — all four present as "recorded session id, no process, no result." The user's single disengage gesture (CAP-5, "one interrupt halts all agents") is silently undone by the loop that AD-7 makes unkillable. This is the worst class of bug the spine could ship: the safety control is defeated by the reliability mechanism.

> **Tighten AD-8 — recovery is driven by a recorded disposition, not by process absence.**
> Rule: before any signal is sent to a step, the reconciler writes that step's *disposition* to `state.json` — one of `interrupted`, `killed`, `ceiling_exceeded`, `gate_failed`, `handed_off`. Only `interrupted` is eligible for `--resume`-or-re-run. Absence of a disposition with an absent process means `interrupted`. A step with a terminal disposition is never restarted by any path.

### C-4. Step purity is false across a re-run, and the two fixes are opposites

AD-8 asserts "no step may depend on having run exactly once" and grounds it in AD-1: a subprocess is a pure function over typed files. It is not — **the worktree is mutable input that the failed attempt already mutated.**

**Unit A** — the reconciler re-runs the step against the worktree as it stands, preserving the partial work the interrupted attempt produced (fast, and the obvious reading of "re-runs the step from its typed input file" — nothing says reset anything).
**Unit B** — the step runner hard-resets the worktree to the commit recorded at step start before re-running, per architecture.md's "handoffs are commits" and AD-6/CAP-6's reproducibility requirement.

Both obey AD-7 ("every reconciler action is idempotent") and AD-8. They are incompatible because A's re-run sees a half-edited tree — duplicated appended lines, a partially applied refactor, a dangling commit — and produces a diff neither the planner's territory declaration nor the verifier's criteria anticipate; B discards work A treats as durable, so a step that is 90% done and hits a transient rate limit loses everything. Every downstream step is written against one assumption or the other.

> **Add AD-20 — a step's input is its typed input file *plus* a recorded baseline ref.**
> Rule: the reconciler records `baseline_ref` (a git object id in the run's worktree) in `state.json` before spawning a step; any re-run or resume of that step begins with a hard reset of the worktree to `baseline_ref`; a step's output is the typed output file plus exactly one commit; partial work is never carried across a re-run. `--resume` is permitted only when the worktree still matches the head the interrupted attempt last committed.

### C-5. AD-15's idempotency key is recorded only *after* the write, so it is at-least-once

AD-15: "the engine executes each exactly once against an idempotency key derived from run id plus intent id, **records the outcome** to the event log, and treats a repeated intent with a known key as already satisfied." The only durable evidence is the outcome event, appended after the call returns.

**Unit A** — the intent executor implements AD-15 literally: no outcome for key K means K has not run; execute.
**Unit B** — the intent executor appends `write.attempted{key}` before the call and treats attempted-without-outcome as *unknown*, blocking for a human (CAP-12 irreversible class).

Both obey AD-15. They are incompatible because A silently duplicates every write whose process died in the call window — the Jira transition, the PR, the merge — while B stalls runs A would complete. The AD's word "exactly" is not backed by any mechanism the AD describes.

> **Tighten AD-15 — the key is durable before the call, and unknown is a state.**
> Rule: the intent executor appends `write.attempted` carrying the idempotency key and the fully rendered request *before* issuing it, and `write.executed` or `write.failed` after. A key found attempted with no terminal outcome is resolved by a domain read that looks up the key — every MCP server must expose one — and never by blind re-execution. An intent whose key cannot be resolved blocks the feature and surfaces as a decision.

### C-6. Two legal answers to "which `.orch/` does this run read"

`.orch/` is committed configuration inside the target repository (AD-9, AD-12, AD-16, AD-17). A run executes in a worktree at `worktrees/<run-id>/`, checked out on a feature branch.

**Unit A** — the profile loader resolves `<registered-project-path>/.orch/profile.toml` from the project registration (AD-10), i.e. the main checkout, on whatever branch the user happens to have checked out.
**Unit B** — the step spawner reads `.orch/agents/<id>.toml` relative to the `claude -p` process's cwd, which is the run's worktree, because that is the tree the agent is working in and AD-9 states the config "is identical in every worktree."

Both obey AD-9 and AD-17. They are incompatible because **AD-9's claim that the config is identical in every worktree is false**: a feature branch may edit `.orch/` (adding an agent is a feature), and the main checkout may be on an unrelated branch or mid-rebase. A and B then load different rosters, different model tiers and different granted tools for the same run.

Compounding it: AD-17 says "the engine discovers agents only by reading that directory" and AD-7 says the engine "holds no authoritative run state in memory," which together *require* re-reading the roster on every pass. A user editing `agents/impl.toml` at step 4 changes the contract of step 5 mid-run, and an AD-8 re-run of step 3 runs a different agent than the one whose output step 4 already consumed. CAP-6 ("a recorded run replays to an identical step sequence") is unachievable.

> **Add AD-21 — configuration is snapshotted per run and the run reads only the snapshot.**
> Rule: at run creation the reconciler copies `.orch/` from a pinned commit of the project's configured default branch into `runs/<run-id>/config/` and records that commit id in `state.json`; every unit in that run — profile loader, roster discovery, step spawner, gates — resolves configuration only from the snapshot; edits to the repository's `.orch/` take effect on the next run and never on a live one; the snapshot makes shadow mode and replay exact.

### C-7. Shadow mode has two incompatible definitions inside this document

**Unit A** — the capability map says CAP-21 lives in a "replay runner over `events.jsonl` and the fetch record": deterministic re-play of a recorded run, no model calls, no worktree.
**Unit B** — SPEC CAP-21 says the system "runs against an already-built feature and compares its output to what was actually committed," which requires live execution of the full roster against the historical input, with writes suppressed.

Both obey AD-4, AD-13 and AD-14. They are incompatible because A produces no new output to compare and therefore cannot measure accuracy, while B is a real run that needs a worktree, containers, leased resources and an enforced no-write mode that no AD defines. The stage-3 gate — "measured shadow-mode accuracy meets the unlock threshold" — is gated on which one gets built, and the whole autonomy ladder is gated on that gate.

> **Add AD-22 — shadow mode is an ordinary run with a recorded mode flag, not a separate execution path.**
> Rule: `state.json` carries `mode: "live" | "shadow"`, set at run creation and immutable; in shadow mode the intent executor refuses every external write (C-2's enumerated surface) and records `write.suppressed`, the committer produces a diff artifact instead of a PR, and the fetch record of the original run is mounted read-only as the shadow run's fetch source per AD-14. No unit branches on mode except the intent executor and the committer.

---

## High — will cost a rewrite of a component

### H-1. There is no version or migration story for anything on disk, and AD-12 forbids one

Nothing in the spine carries a version: not `.orch/`, not `profile.toml`, not `agents/*.toml`, not `state.json`, not `fetch-record.json`, not the event envelope. AD-5 gives forward compatibility for *unknown event types* only — not for a changed payload of a known type, and not for the envelope.

**Unit A** — installer v1 writes `agents/plan.toml` with `model_tier = "sonnet"`.
**Unit B** — engine v2 reads `model = { tier, fallback }` after the model-ladder work the spine explicitly defers.

Both obey AD-17 ("specifying ... its model tier"). They are incompatible because B has no way to detect that it is reading a v1 file, and **AD-12 explicitly forbids the repair**: "upgrade re-runs the installer, which must be idempotent and must preserve answers already present on disk rather than re-asking or overwriting them." The one unit positioned to migrate is prohibited from rewriting. `npx github:<owner>/<repo>` also always fetches HEAD, so two projects onboarded a month apart hold different layouts with no recorded provenance.

> **Add AD-23 — every orchestrator-owned file on disk carries `schema_version`, and the installer owns migration.**
> Rule: `.orch/manifest.toml` records the installer version, the `.orch` schema version and a completion marker; every state, event-envelope and config schema carries an integer major version; the engine refuses to operate against a major version it does not know and names the required upgrade; AD-12's preservation rule is narrowed to *user answers*, and the installer is required to rewrite files to migrate them, recording the prior version in the manifest.

### H-2. A half-installed project is unrecoverable by design

**Unit A** — the installer's resume logic, per AD-12, treats any answer already present on disk as final and never re-asks.
**Unit B** — the engine's onboarding check tests for the presence of `.orch/profile.toml`.

Both obey AD-12 and AD-9. They are incompatible because a Ctrl-C after `profile.toml` and before `agents/` leaves a directory that B calls onboarded and that A will never complete — every re-run preserves the partial state and skips the unasked questions. The engine then reports "no agents declared" (AD-17 forbids a compiled-in fallback roster) rather than "not installed."

> **Covered by AD-23's completion marker, plus: the installer writes into a staging directory and renames into place atomically, so `.orch/` is never observed partially written.**

### H-3. `seq` has no assigner, and the MCP server is not a child of the engine

AD-4 requires exactly one writer per event file; AD-5 requires every line to carry a `seq` "monotonic per file." Neither says who assigns it. Meanwhile AD-1 passes MCP servers to `claude -p` with `--mcp-config`, which makes **the tool server a child of the step subprocess, not of the engine** — yet the run-flow diagram shows `TOOL --> requests and responses --> REC`.

**Unit A** — the runtime recorder is a library inside the engine process; it owns the file handle and assigns `seq` on append; tool-server activity reaches it only as `tool_use`/`tool_result` frames in the step's stream-json.
**Unit B** — the Jira MCP server appends its own `fetch.recorded` lines directly to `runs/<run-id>/events.jsonl` (the path is in its environment), because AD-13 requires it to record "every request and response" and the claude stream truncates large tool results.

Both obey AD-4 as each reads it ("the runtime recorder" is a role, not a process) and AD-13. They are incompatible because B is a second writer — interleaved partial lines under concurrent `O_APPEND` beyond `PIPE_BUF`, and two independent `seq` counters producing duplicate sequence numbers. A, conversely, loses the response bodies AD-13 and AD-14 depend on.

> **Tighten AD-4/AD-5 — one recorder *process* per run; everyone else is a client.**
> Rule: exactly one recorder process owns `events.jsonl` for a run and is the only assigner of `seq`, which is gapless and zero-based. Every other emitter — engine, MCP servers, step wrappers — submits events over a unix domain socket whose path is passed in `ORCH_RECORDER_SOCK`; an emitter that cannot reach the recorder fails its operation rather than writing the file. `ts` is advisory for humans and is never used for ordering by any unit; ordering within a run is `seq`, across runs is run-ULID then `seq`.

*(RFC3339-with-ms is not sufficient on its own: the engine, each `claude -p` and each MCP server read independent clocks, and the explicit requirement that closing the laptop mid-feature works means suspend-induced clock steps are a normal event, not an edge case.)*

### H-4. Three legal ways to get a step's typed output, and they are not interchangeable

AD-1 says the result is "consumed from `--output-format stream-json`." The run's own research notes that the validated typed result is returned in `structured_output` under `--output-format json`. architecture.md says a step's output is "one typed file (JSON against a declared schema)."

**Unit A** — the step spawner uses `--output-format stream-json` per AD-1 and reconstructs the typed result from the final `result` frame.
**Unit B** — the verification runner uses `--output-format json` to get `structured_output` directly, on the grounds that AD-2's `--json-schema` guarantee is only documented for that format.
**Unit C** — the implementation agent writes `output.json` into the worktree and commits it ("handoffs are commits"), and the next step reads it from the tree.

All three claim AD-1 and AD-2. They are incompatible because B emits no stream at all, so the recorder captures nothing for that step and CAP-8/AD-4 break for it; and because C's consumer finds no file when its producer was A or B. Nothing in the spine says **who materializes the typed output file, or where it lives** — `runs/<run-id>/` has no `steps/` directory in the structural seed despite AD-8 requiring "its typed input file" to exist.

> **Add AD-24 — the engine materializes both typed files; agents never write their own envelope.**
> Rule: for every step the engine writes `runs/<run-id>/steps/<step-id>/input.json` before spawning and `output.json` after, derived from the final `result` frame of the mandated `stream-json` stream and validated against the agent's declared output schema before the step is marked complete; a step that produces no schema-valid output fails with the standard error shape; agents may write files in the worktree but never the step envelope. Add `steps/` to the runtime layout in AD-9.

### H-5. The fetch record has no schema, no request key and no declared writer

AD-13 requires "the runtime" to record every request and response "to the event log **and** to the run shared fetch record"; AD-14 requires that "within one run an external record has exactly one value." The conventions' one-writer rule names only `state.json` and `events.jsonl` — `fetch-record.json` is the one *mutable* shared file in the system with no owner, no atomicity requirement and no schema.

**Unit A** — the Jira MCP server keys entries by canonicalized `(method, path, sorted query)`.
**Unit B** — the recorder keys entries by `(mcp_server, tool_name, canonical_json(args))`.

Both obey AD-13. They are incompatible because a fetch written by A is never found by B's lookup: the same issue is fetched twice, gets two values in one run, and AD-14's guarantee — the thing AD-8's re-run safety and CAP-21's determinism rest on — silently does not hold. Worse, the fetch record is a second durable truth for external reads that AD-4 does not cover, because a plain JSON file is neither "an index" nor "a database."

> **Add AD-25 — the fetch record is a projection of `fetch.recorded` events under a single canonical key.**
> Rule: `contracts/` exports exactly one `fetchKey(domain, operation, args)` function and every unit that reads or writes the record uses it; the durable record is the `fetch.recorded` event stream and `fetch-record.json` is a rebuildable cache written only by the recorder; the recorder is the sole writer and writes atomically; a cache mismatch is repaired from the log without notice.

### H-6. The containment boundary is undefined, and `--rm` destroys what AD-8 needs

AD-11 fixes the image; AD-1 fixes that the engine spawns the `claude -p`. Neither says **which side of the container wall the claude process is on.**

**Unit A** — the step spawner runs `docker run --rm <image> claude -p ...`: the agent and its Bash tool are inside the sandbox, which is the only reading under which tier 2 contains anything.
**Unit B** — the spawner runs `claude -p` on the host with its Bash tool wrapped to `docker exec` into a long-lived container: the recorder reads the stream directly and the user's Claude Code credentials never enter the sandbox.

Both obey AD-1 and AD-11. They are incompatible in four ways at once: credential placement (A puts the subscription login inside a sandbox the threat model treats as hostile), stream plumbing, mount layout, and fatally — **A's `--rm` deletes the session transcript directory, so `claude -p --resume <session-id>` cannot work and AD-8's primary recovery path is dead for every tier-2 step.** Container reaping has the same split: A's container dies with the step, B's is reaped by the reconciler on a later pass, and after `kill -9` one design orphans a container holding a leased database while the other reaps one a resumed run still believes it holds.

> **Add AD-26 — the agent process runs inside the tier-2 container; session and run state are mounted from the host.**
> Rule: for tier 2 the `claude -p` process runs inside the image; `runs/<run-id>/` and the claude session directory are bind-mounted from the host so transcripts survive container death and `--resume` remains available; the container carries no git remote credential; the container is a named, durable resource recorded in `state.json` and its teardown is a reconcile action, never a shutdown handler; a container recorded in state with no running counterpart is recreated, and one running with no state record is destroyed.

### H-7. The question lifecycle has three resolvers and no arbitration

CAP-4 makes non-response a valid input with a stated window; AD-3 requires both renderers to be first-class; Q5 requires questions to be answerable in the terminal.

**Unit A** — the TUI submits the user's answer for question `q7` at T+9.8s.
**Unit B** — the engine's timeout fires the declared default for `q7` at T+10.0s.
**Unit C** — the web surface submits a different answer for `q7` from another window.

All three obey AD-3, AD-7 and CAP-4. They are incompatible because **no AD defines a question as a durable single-transition record.** Two decisions get recorded for one question, and per CAP-18 one of them becomes a durable ledger rule that later features apply without asking — a wrong answer that is now permanent. AD-3's "issued through the same command path" makes it worse, not better: the engine cannot tell the two submitters apart.

> **Add AD-27 — a question is a durable record with exactly one terminal transition.**
> Rule: every user-facing question is a record in `state.json` with an id, a default, a deadline and a status; it transitions exactly once, to `answered` or `defaulted`, and only the reconciler performs the transition; renderers submit answers as commands and never resolve a question themselves; a submission against an already-resolved question is rejected and surfaced to that renderer; only a terminal transition writes to the ledger.

### H-8. Nobody owns the run id, and the run diagram contradicts the one-writer rule

The conventions state "only the reconciler writes a feature `state.json`." The feature-run diagram shows **the Interviewer writing confirmed criteria into `state.json`** (`I -->|confirmed criteria| ST`). The Interviewer is a `claude -p` process (capability map), i.e. a second writer.

**Unit A** — the CLI front-end mints the run ULID and creates `runs/<run-id>/` so the Interviewer's conversation can be recorded from the first turn.
**Unit B** — the reconciler mints it when it first claims a confirmed feature, since it owns `state.json`.

Both obey AD-7 and AD-9. They are incompatible because A produces run directories holding events but no `state.json` — which B's reconciler ignores and the AD-9 prune command is entitled to delete — while B loses the entire interview from the log, breaking CAP-1/CAP-2 evidence. And the diagram's Interviewer write races the reconciler's atomic rename: last writer wins, confirmed criteria vanish.

> **Tighten AD-7 — one minter, one writer, no exceptions.**
> Rule: the reconciler alone mints run ids and creates `runs/<run-id>/`, at the moment a feature request is accepted and before the Interviewer is spawned; the Interviewer is an ordinary step whose typed output carries the confirmed criteria, which the reconciler writes to state per AD-24. Correct the run-flow diagram: no arrow from the Interviewer to `state.json`.

---

## Medium — will cost a refactor or a silent wrong behaviour

### M-1. AD-17's "no engine change" contradicts AD-2's "every step contract is a Zod schema"

**Unit A** — the installer's interactive agent creation writes `agents/my-reviewer.toml` with an inline or file-referenced JSON Schema, per AD-17 ("adding an agent requires no engine change") and the dependency rule that the installer never calls the engine.
**Unit B** — the step spawner resolves `input_schema`/`output_schema` as names in the compiled Zod registry in `contracts/`, per AD-2 ("every step contract is a Zod v4 schema exported via `z.toJSONSchema()`").

Both obey AD-2 and AD-17. They are incompatible because B rejects A's agent as an unknown schema name: a user-defined agent requires a new step contract, and AD-2 puts contracts in compiled TypeScript. AD-17's central promise is unachievable under AD-2.

> **Tighten AD-2/AD-17.** AD-2's Zod requirement binds contracts that cross *unit* boundaries in TypeScript (envelope, error shape, state, agent declaration, command set). An agent's step contracts may be JSON Schema documents referenced from its TOML; the engine validates step output against the resolved JSON Schema at runtime and passes it verbatim to `--json-schema`. AD-17 gains: a declared schema must validate against the JSON Schema meta-schema at roster load, and a roster that fails to load blocks the run rather than degrading it.

### M-2. AD-3 is an instruction with no mechanism, and it is already violated by the interface contract

AD-3 enumerates four steering actions. `interface-contract.md` requires a Kill card offering **continue / narrow / kill / take over**, plus one-keystroke rejection with a reason, plus spec-echo confirmation, plus question answering. So `narrow`, `take over`, `reject`, `confirm` and `answer` are controls AD-3 does not name.

**Unit A** — the TUI implements all nine, because the interface contract demands them.
**Unit B** — the web implements the four AD-3 names.

Both obey AD-3 literally. They are incompatible with CAP-14/CAP-15 parity, and nothing in the spine detects it.

> **Tighten AD-3 — parity is enforced by a shared enum and a conformance test, not by an instruction.**
> Rule: `contracts/` exports `SteeringCommand` as the complete, closed set of control-plane commands; both renderers build their controls by exhaustively switching over that union, so adding a variant fails to compile in the renderer that lacks it; a conformance test asserts every variant is reachable from both surfaces. AD-3's enumeration is replaced by a reference to that enum.

### M-3. The command channel has no principal, so approvals are unattributable

AD-3 routes both renderers through "the same command path into the engine." The web surface binds a local port. The engine therefore cannot distinguish the terminal user from anything else that can reach that port, yet it accepts approvals for CAP-12's irreversible class and writes them to the decision ledger as the user's durable answer.

**Unit A** — the TUI is a child of the user's shell and its authority is process ownership.
**Unit B** — the web surface is an HTTP server whose authority is "it is on localhost."

Both obey AD-3. They are incompatible because B's authority model cannot express A's, and the ledger records "the user decided X" from an unauthenticated source.

> **Tighten AD-9/AD-3.** The engine's command channel is a unix domain socket at `$ORCH_HOME/engine.sock` with mode 0600; the web surface is a client of that socket, binds loopback only, and authenticates with a per-run token written under `$ORCH_HOME`; every command event records its source surface, and an irreversible approval records the surface it came from.

### M-4. Lease release on crash: shutdown handler versus reconcile action

CAP-11 requires a leased instance to be returned and verified empty; AD-9 puts leases at `pool/`; no AD says who releases one after `kill -9`.

**Unit A** — the pool manager releases leases in a process-exit handler.
**Unit B** — the reconciler releases a lease when the feature reaches a terminal state, reading lease ownership from `state.json`.

Both obey AD-7 in letter — A is not a *reconciler* action, so AD-7's "every reconciler action is idempotent" does not reach it. They are incompatible because A leaks on `kill -9` (the exact scenario AD-7 exists for, and which AD-7 says must behave "identically to never having stopped"), while B may wipe and re-lease an instance that a resumed run still believes it holds, so the resumed step queries an emptied database and reports a false test failure.

> **Add AD-28 — a lease is a durable record with an owning run and an expiry; only the reconciler grants and revokes it.**
> Rule: `pool/<resource-id>/lease.json` records the owning run id, the grant time and a renewal deadline; the reconciler renews leases for live runs and revokes expired ones as an ordinary reconcile action; no shutdown handler releases anything; a step whose lease has been revoked fails with the standard error shape rather than operating on a wiped resource.

### M-5. Prune versus AD-10's mutable path pointer destroys live history

AD-9 requires "a prune command ... to remove central state orphaned by a deleted project directory." AD-10 says "the filesystem path is a mutable pointer updated on mismatch."

**Unit A** — prune deletes `projects/<id>/` and its runs when the recorded path does not resolve.
**Unit B** — the project registrar updates the pointer the next time the project is used from its new location.

Both obey AD-9 and AD-10. They are incompatible because **a moved repository is indistinguishable from a deleted one until B next runs**, so moving a project and then pruning irreversibly destroys its run history, decision ledger and memory — and AD-4 makes those files the only durable truth there is.

> **Tighten AD-9.** Prune never deletes: it moves candidates to `$ORCH_HOME/trash/<date>/` and reports them, and only an explicit second command with the project id removes them; before quarantining, prune re-resolves the project by its first-commit SHA across the registered search roots; a project is orphaned only when the user confirms it.

### M-6. Git notes have no ref, no shape and two plausible writers — and CAP-8 disagrees with AD-4

AD-9 permits git notes as one of two things the orchestrator writes into the target repo; nothing fixes the ref name or the payload shape, and AD-5 governs only event lines.

**Unit A** — the committer writes cost and reasoning as a block under the default `refs/notes/commits`.
**Unit B** — the recorder writes run id and event offsets under the same default ref.

Both obey AD-9. They are incompatible at the git level — a second `git notes add` on the same object fails outright, and notes on the default ref collide on push. Behind it sits a contract-level disagreement: **CAP-8 requires the timeline to be reconstructable "from `git log` and notes alone, with no other datastore present," while AD-4 puts the truth in `events.jsonl` under `ORCH_HOME`, outside the repository.** A clone cannot satisfy CAP-8 under AD-4. The stage-1 gate has already quietly rewritten CAP-8 to "git and the event log."

> **Add AD-29 — one notes ref, one schema, one writer, and notes are a pointer not a mirror.**
> Rule: the orchestrator writes only `refs/notes/orch`, never the default ref; the note payload is a Zod-defined record carrying run id, step id, model tier, usage and the event `seq` range that produced the commit; the intent executor is the sole writer (per C-2); notes are a durable *index into* the event log, and CAP-8 is restated as "reconstructable from git plus the run's event log," with an `orch export <run-id>` command that bundles the log alongside the branch for a repository-only handover.

### M-7. Per-machine configuration has nowhere legal to live

AD-9 says the installer "appends the runtime paths to `.gitignore`" while simultaneously stating that no runtime state is ever written inside the target repository — so the ignore lines cover files that by the same AD cannot exist. Meanwhile real per-machine settings have no home: `ORCH_HOME` override, the web surface's port, the path to a local credential.

**Unit A** — the web surface reads its port from `.orch/profile.toml`, which is committed, so a teammate's checkout collides.
**Unit B** — it reads `ORCH_PORT` from the environment, which is invisible to the installer and unrecorded in any run's evidence.

Both obey AD-9 and AD-16. They are incompatible because A leaks one machine's settings into everyone's repository and B leaves the run's own configuration unreconstructable from its evidence.

> **Tighten AD-9 — three layers, fixed precedence, all recorded.**
> Rule: committed `<target-repo>/.orch/` (shared, versioned); per-machine `<target-repo>/.orch/local.toml` (created and gitignored by the installer — this is what the `.gitignore` append is for); central `$ORCH_HOME` (runtime state only). Precedence is local over committed, never the reverse; the effective merged configuration is recorded once per run in the AD-21 snapshot so any run's configuration is reconstructable from its own evidence.

### M-8. Cross-repo memory has no location in AD-9's layout

AD-9 enumerates the `ORCH_HOME` layout as `runs/`, `worktrees/`, `pool/`, `projects/<project-id>/`. CAP-19 requires a pattern recorded in project A to be retrievable in project B.

**Unit A** — the consolidation pass writes patterns to `projects/<source-id>/patterns/`, staying inside AD-9's enumerated layout.
**Unit B** — it writes to a global `$ORCH_HOME/memory/patterns/`, which AD-9 does not sanction.

Both are defensible under AD-9. They are incompatible because B's retrieval never looks inside another project's directory and A's retrieval has no list of which projects to scan, so CAP-19 silently returns nothing.

> **Tighten AD-9.** Add `memory/` to the layout as the cross-project store, state that the layout is closed (a unit may not invent a top-level directory), and fix that per-project memory lives under `projects/<id>/memory/` while abstract cross-repo patterns live under `memory/patterns/` and are written only by the consolidation pass.

### M-9. Branch naming is unowned

**Unit A** — the worktree manager creates `orch/<feature-slug>`.
**Unit B** — the committer opens the PR from `orch/<run-id>`.

Both obey AD-9 and AD-10. They are incompatible on the second run of the same feature (A collides with an existing branch and must either fail or force, and force-push is forbidden) and B's branch names are unreadable in the PR list, violating R6's "address everything by feature name."

> **Fold into the AD-9 tightening.** Branch name is `orch/<feature-slug>/<run-id-suffix>`, minted by the reconciler at worktree creation and recorded in `state.json`; no other unit creates, names or deletes a branch.

### M-10. Failure taxonomy is a shape without a disposition table

The error shape `{code, message, retryable, cause}` is fixed; what the reconciler *does* with each code is not.

**Unit A** — the ceiling enforcer classifies a wall-clock breach as non-retryable and the reconciler moves the feature to `handed_off`.
**Unit B** — the same breach is raised as a decision point and the feature moves to `blocked` awaiting the Kill card's continue / narrow / kill / take over.

Both obey AD-7 and CAP-16 ("halts and notifies"). They are incompatible because one ends the run and one pauses it, and whichever unit emits first determines the outcome — so the two renderers show a terminated feature and a waiting feature for the same event.

> **Tighten the error convention into an AD.** `contracts/` exports a closed `FailureCode` union, and each code maps to exactly one reconciler disposition (`retry`, `promote_model`, `block`, `hand_off`) in a table owned by `contracts/`; no unit decides a disposition locally, and an unmapped code is a load-time error.

---

## Confirmed closed

These were attacked and the spine holds.

- **Agent invocation.** AD-1 is airtight: no unit can link the SDK, and the subprocess boundary is enforced by the OS rather than by discipline.
- **Implementation language and schema origin.** AD-2 plus the "defined once as Zod, exported with `z.toJSONSchema()`" convention closes schema duplication for everything except agent-declared step contracts (M-1).
- **Project identity.** AD-10 is the strongest AD in the document — the first-commit SHA cannot be gamed by a move, a rename or a remote change, and the "no commits, no registration" clause closes the empty-repo edge.
- **Unknown event types.** AD-5's ignore-don't-error rule genuinely makes adding an event type non-breaking. It does *not* cover payload evolution of a known type — see H-1.
- **Container image provenance.** AD-11's content-hash tag with no registry pull removes an entire class of "which image are you running" divergence.
- **Credential scoping.** AD-13's one-server-per-domain rule makes CAP-7's "fails for absence of credential" structurally true rather than instructed.
- **BMad absence.** AD-18 is testable by grep and binds the installer, which is where the leak would have happened.
- **The deferrals.** All six deferrals in the spine are correctly argued as interface-neutral. The SQLite deferral in particular is safe precisely because AD-4 already forces any index to be a projection.

---

## What to do first

The seven critical findings reduce to four missing ADs and three tightenings, and they are not independent:

1. **AD-19** (state is a checkpoint of the log) unblocks C-1 and is a prerequisite for H-8 and C-7.
2. **AD-20** (baseline ref per step) + the **AD-8 disposition table** (C-3) together make AD-8's re-run promise true rather than asserted; nothing about recovery is safe until both exist.
3. **AD-15 tightening** (enumerate the external write surface; durable key before the call) closes C-2 and C-5 with one edit and decides what the committer actually is.
4. **AD-21** (per-run config snapshot) closes C-6 and is what finally makes AD-21+AD-22 shadow mode and CAP-6 replay exact.
5. **AD-23** (versions and a manifest) should land before the installer is written, because AD-12 currently prohibits the only repair path.

Until AD-19, AD-20 and the AD-15 tightening exist, two developers handed this spine will build a reconciler and a step runner that cannot be run together.
