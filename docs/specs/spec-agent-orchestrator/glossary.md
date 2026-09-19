# Glossary

Terms used across SPEC.md and its companions with a specific, non-obvious meaning.

**Interviewer** — the single agent the user converses with. Owns question compression, spec echo, and the brief. The only component required to be a live model conversation.

**Engine** — the deterministic workflow executor. Ordinary code. Decides sequencing, retries and gating; never a model.

**Step agent** — a pure function over typed files performing one pipeline step. Stateless, replayable, independently testable.

**Tool server** — the sole owner of one external domain (e.g. Jira). Holds that domain's credential; answers most requests deterministically without model tokens.

**Control plane** — the thin, schema'd channel carrying decisions between steps. The only data that enters model context.

**Evidence plane** — the fat, on-disk record of everything that happened. Written by the runtime, read on demand, never loaded wholesale.

**Spec echo** — restating a request back as acceptance criteria for confirmation before work starts. Borrowed from air-traffic-control readback; the echo is the contract.

**Question compression** — merging and deflecting subagent questions so at most one reaches the user. The Interviewer's primary measured job.

**Deflection rate** — proportion of subagent questions resolved from repository, history or ledger without reaching the user.

**Default-on-timeout** — the property that every user-facing question declares what happens if ignored, making non-response a valid input.

**Decision ledger** — the durable store of answers the user has given, checked before any agent asks a question.

**Capability token** — enforcement of domain ownership by credential placement rather than instruction. An agent cannot misuse what it cannot reach.

**Reversibility class** — the blast-radius category of an action (reversible, recoverable, irreversible) that determines its approval gate.

**Isolation tier** — the strength of sandboxing applied to a feature (in place, branch, worktree plus container), selected by risk.

**Model ladder** — starting each step on the cheapest viable model and promoting only on verification failure.

**Consolidation** — the between-run pass compacting episodic logs into durable structured facts. Named for sleep consolidation; structurally identical to write-ahead-log compaction.

**Episodic log** — the append-only per-feature record of what happened. Free to write, the substrate all later memory derives from.

**Anchor** — the reference a memory entry points at. Ranked by durability: test names, then public API symbols, then module names, then file paths. Line numbers are never valid anchors.

**Shadow mode** — running the system against an already-built feature and comparing its output to the real commit, without writing to the repository.

**Morning brief** — the glanceable summary of all in-flight features and what each needs from the user.

**Flight recorder** — the durable per-feature record of transcripts, diffs, decisions and costs. Outlives the worktree.

**Conflict domain** — the set of files a feature declares it will touch. Features with disjoint domains may run in parallel.

**Stop-building tripwire** — a defined signal that work on the orchestrator should halt in favour of building products with it. Listed in `build-sequencing.md`.
