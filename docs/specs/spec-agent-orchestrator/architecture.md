# Architecture

Structural decisions for SPEC-agent-orchestrator. The kernel states *what*; this file states *how*, and downstream implementation must conform to it.

## Components

| Component | Responsibility | Is it a model? |
|---|---|---|
| **Interviewer** | The only live conversation with the user. Question compression, spec echo, brief rendering. | Yes — the only component that must be |
| **Engine** | Deterministic workflow execution: sequencing, retries, gating, scheduling. | No — ordinary code |
| **Step agents** | Analysis, planning, implementation, testing, verification, committing. The full roster is present from the start. Pure functions. | Yes, at the leaves |
| **Tool servers** | One per external domain (Jira first). Deterministic API shim with a small model in front for fuzzy intent only. | Mostly no |
| **Runtime recorder** | Writes the event log and telemetry by observing agents. Agents never write it. | No |
| **Resource pool** | Warm containers (postgres, redis) leased to features, wiped on return. | No |
| **Renderers** | TUI (primary) and web app (optional), both projections of the event log. | No |

The orchestrator of the original concept is deliberately split: **Interviewer (conversation) + Engine (scheduler)**. Fusing them was identified as the central design error — it forces a model to make routing decisions that code makes more cheaply and more reliably.

## The two planes

- **Control plane** — thin, schema'd, typed. Carries decisions between steps and is the only thing that enters model context. Subject to a declared token ceiling.
- **Evidence plane** — fat, unbounded, on disk. Transcripts, diffs, telemetry, artifacts. Written by the runtime, read only on demand.

Building the evidence plane once yields two-channel output, pointer-holding orchestration, and free telemetry as consequences rather than separate features.

## Agent contract

Every step agent is a pure function:

- Input: one typed file (JSON against a declared schema).
- Output: one typed file (JSON against a declared schema).
- No hidden state, no network beyond its granted capability, no knowledge of what ran before or runs next.
- Re-running an agent on the same input file is valid and must be side-effect-free outside its output.

This is what makes runs resumable, steps independently testable, and failures recoverable without replaying the whole pipeline.

## Coordination

- **Handoffs are commits.** Each step commits its output into the feature worktree. `git log` is the timeline; git notes carry cost and reasoning.
- **No agent-to-agent messaging.** An agent reads prior outputs from the worktree; it never asks another agent anything.
- **Re-grounding.** Every agent reads the original, verbatim feature request — never a summary of a summary.
- **Provenance.** Every claim in an output carries the step that produced it.

## Capability tokens

Domain ownership is enforced by credential placement, not by instruction. The Jira credential exists in the Jira tool server's container and nowhere else. An agent that "decides" to call Jira fails for lack of a credential. Any ownership rule expressible as a capability must be implemented as one.

## Isolation tiers

| Tier | Used for | Mechanism |
|---|---|---|
| 0 — in place | Typo, comment, formatting | Direct edit, no branch |
| 1 — branch | Small, low-blast-radius change | Branch, no container |
| 2 — worktree + container | Real features | Worktree, least-privilege container, leased resources |

Tier is selected by risk classification. Spinning a container for a README fix is rejected as pure tax. All three tiers exist from the first stage; containment is not deferred.

Tier 2 container: read-only root filesystem, worktree mounted, no docker socket, non-root user, dropped capabilities, seccomp profile, egress allowlist proxy. Provisioning (dependency install) happens in a network-enabled phase that ends before execution begins.

## Reversibility classes

Autonomy is gated by blast radius, never by a global trust level.

| Class | Examples | Gate |
|---|---|---|
| Reversible | Edit in worktree, run tests, read Jira | None |
| Recoverable | Commit to feature branch, write memory | Post-hoc notification |
| Irreversible | Push to shared branch, merge, write Jira, spend past ceiling | Explicit approval |

Engineering more actions into lower classes is the primary way to increase autonomy safely.

## Model assignment

A ladder, not a fixed map. Every step starts on the cheapest viable model and is promoted only on verification failure. Promotion events are recorded and used to tune defaults. When a cheap model fails repeatedly on a task shape, the preferred response is decomposing the task, not escalating the model.

## State and concurrency

- System state is a fold over the append-only event log; renderers are projections.
- Features declare their file territory before execution; the engine serializes only features with overlapping territory. Parallelism is bounded by conflict domain, not by a fixed worker count.
- Resources are pooled and leased. Worktrees are destroyed on merge; the evidence plane for that feature persists indefinitely.
