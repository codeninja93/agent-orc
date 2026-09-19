# Build Sequencing

The kernel specifies the full target architecture. This file specifies the order it is built in and the gates between stages. Order is part of the contract: the source sessions identified maintenance burden — the orchestrator becoming a product that consumes the time it was built to free — as the likeliest cause of failure, and sequencing is the defense.

User decisions have deliberately widened the early stages: the full agent roster, container isolation and the web renderer are all in scope from the start rather than deferred. The memory layer remains the principal deferral, and the stop-building tripwires below are now the main surviving restraint mechanism.

## Why the interface comes first

Shadow mode has no autonomy. It analyzes, proposes, and compares; it writes nothing. Everything it produces is a report to a human. **Shadow mode is therefore almost entirely an interface product** — which makes the morning brief, the one-question card and the mode display part of the first stage, not later polish.

## Stages

**Stage 1 — Substrate, interface, containment**
Append-only event log. Git-as-bus with notes. Runtime recorder. TUI renderer. Morning brief, one-question card with default-on-timeout, permanent mode display, escape hatch. Worktree plus least-privilege container and the leased resource pool, since containment is required from the start.
*Gate:* a run is fully reconstructable from git and the event log alone, and the executor container is verified to hold no push credential.

**Stage 2 — Engine, full roster, ceilings**
Deterministic engine with typed step contracts. The complete agent roster — analysis, planning, implementation, testing, verification, committing — plus tool servers beginning with Jira. Spec echo. Per-repo profile, hand-written at this stage. Ceilings in steps, wall-clock and rate-limit budget.
*Gate:* a real feature completes end to end, with the user reviewing and merging a pull request authored under their own identity.

**Stage 3 — Web renderer, shadow mode, measurement**
Local web app as a second renderer of the same event stream. Shadow mode against already-built features. Metrics: rework rate, deflection rate, interruption count, usage per feature.
*Gate:* over a rolling window of at least twenty shadow runs in one project, at least **80% produce a diff accepted without material change**, and **zero produce a write intent that would have been destructive**. The destructive count is a hard gate, not a percentage — one is too many. This threshold is provisional and should be revisited after the first twenty real shadow runs, when the distribution can be read rather than guessed.

**Stage 4 — Autonomy**
Reversibility classes enforced end to end. Gated committer. Adversarial tester. Steerable observability — pause, inject, kill, fork.
*Gate:* the minimum guardrail set in `threat-model.md` is complete and tested.

**Stage 5 — Compounding**
Memory layer per `memory-design.md`. Decision ledger. Cross-repo pattern memory. Bootstrap agent that authors per-repo profiles automatically. Tool domains beyond Jira.

## The installer interview

`npx github:<owner>/<repo> init` asks these, in order, and writes the answers to `<target-repo>/.orch/`. Wording is free to change; what it must *produce* is fixed by AD-9, AD-12, AD-17 and AD-28.

1. Target repository path.
2. Confirmation of the detected project-id (first-commit SHA) and git remote.
3. Package manager, and the test, lint, build and run commands — detected defaults offered.
4. Source layout: where code lives.
5. Resource needs: none, postgres, redis, or both.
6. High-blast-radius paths — migrations, infrastructure, anything that should force a higher isolation tier.
7. Conflict-domain hints: directories that must not be worked on concurrently.
8. Branch-name pattern, defaulting to `feature/<slug>`.
9. External domains to enable, and the **environment variable names** holding their credentials — never the values.
10. Which built-in agents to enable.
11. Per additional custom agent: id, purpose, which registered contract it uses, tools and MCP domains granted, starting model rung, reversibility class.
12. Autonomy start level, defaulting to shadow-only.
13. The three ceiling defaults: steps, wall-clock, rate-limit budget.

Re-running the installer preserves existing answers and asks only what is missing.

## Remaining deferrals

| Deferred | Until | Reason |
|---|---|---|
| Memory layer | Stage 5 | Worthless below roughly 20 features; two independent analyses concluded it is pure overhead early |
| Cross-repo pattern memory | Stage 5 | Requires more than one product already running through the system |
| Bootstrap agent | Stage 5 | A hand-written profile is sufficient until several repos exist |
| Tool domains beyond Jira | Stage 5 | Not on the path to proving the core loop works |

The decision ledger sits in stage 5 with the memory layer, but it is the cheapest and highest-hit-rate element of it. If interruption counts are painful before then, pull the ledger forward alone.

## Stop-building tripwires

Each of these is a signal to stop extending the system and return to building products with it:

- Two consecutive weeks of work on the orchestrator with no feature shipped through it.
- A stage gate slipping twice.
- Shadow-mode accuracy flat or falling across a stage.
- Any component requiring a bespoke abstraction that Claude Code primitives cannot express as configuration plus scripts.
- Time spent on the orchestrator exceeding time spent on actual products across a calendar month.

The success signal in the kernel is measured partly as shipping velocity on real products. If that number falls, the system is failing regardless of how well it works.
