# agent-orcastrator

An agent orchestration system: point it at a repository and a feature request, and it drives that
work through a pipeline of real `claude -p` agents — analysis, planning, implementation, testing,
verification, adversarial review, commit — to a real pull request, with a live control surface for
watching and steering the run.

[![CI](https://github.com/codeninja93/agent-orc/actions/workflows/ci.yml/badge.svg)](https://github.com/codeninja93/agent-orc/actions/workflows/ci.yml)
![Node](https://img.shields.io/badge/node-%3E%3D22.22-brightgreen)
![TypeScript](https://img.shields.io/badge/TypeScript-5.9-blue)
![License](https://img.shields.io/badge/license-UNLICENSED-lightgrey)

## What it does

A confirmed feature request against a target repository is turned into a `FeaturePlan` and driven,
step by step, through a reconciler/spawner core:

```
analysis → planning → implementation → testing → verification → adversarial review → commit
```

Each step is a real, subprocess-spawned `claude -p` agent, scoped by an explicit tool grant (AD-17),
running inside a disposable worktree. Around that core:

- **Reversibility and gates** — every write is classified reversible/recoverable/irreversible and
  gated accordingly; deterministic gates (typecheck/lint/test) run before any model-based review, and
  a failing gate spends no review turn at all.
- **Steerability** — pause, inject, kill, and fork a run while it's in flight, over a durable command
  transport (no in-memory-only control).
- **Control surfaces** — a TUI (Ink) and a loopback HTTP + SSE web surface, both projections of the
  same append-only event log.
- **Shadow mode** — dry-run a spec against a merge commit that already happened: every write intent is
  probed and recorded, never performed.
- **Measurement** — rework, deflection, interruptions, usage, and a trust record, all derived from the
  event log.
- **Memory** — an episodic log with a between-run consolidation pass, tiered retrieval with budgets and
  anchors, a queryable decision ledger, and cross-repo pattern memory.
- **Bootstrap agent** — a read-only agent that can look at a repository it has never seen and answer
  the profile questions detection alone can't: what a run needs, which paths are high blast radius,
  and what's worth remembering. (Built and tested; not yet wired into `orch init` — see
  [Project status](#project-status).)

## Project status

All 35 stories across 5 epics in the spec are `status: done`. Nothing in the planned backlog remains
open.

| Epic | Scope |
| --- | --- |
| 1 | Contracts, runtime recorder, reconciler, spawner, container isolation, worktree pool, command transport, questions, TUI shell/cards |
| 2 | Installer (`orch init`), project identity, profile/roster, step agents (analysis, planning, implementation, testing, verification), committer, interviewer, run ceilings, tool servers, write executor |
| 3 | Web control surface, shadow mode, measurement |
| 4 | Reversibility classes, adversarial tester, steerable observability, exceptions-only notifications |
| 5 | Episodic log + consolidation, memory tiers, decision ledger, cross-repo pattern memory, bootstrap agent |

The one disclosed, not-yet-built item: a CLI command that runs a bootstrap analysis against an unseen
repository and offers to write the merged profile (with a human reviewing before it saves, per AD-16).
That's new, unplanned scope — nothing in the spec calls for it yet.

## Using it against another repository

Prerequisites on the target machine:
- The target is a git repository with at least one commit (its project id is the first-commit SHA)
- `git` and `gh` on `PATH`, with `gh` authenticated
- `claude` authenticated via subscription (API-key mode is refused by design)
- Access to this repository — it's private and unpublished, so `npx`'s `github:` spec is the only
  distribution path

**1. Onboard the repository:**
```sh
npx --package=github:codeninja93/agent-orc orch init
```
Run from inside the target repository. This runs an interactive interview and writes
`.orch/profile.toml`, `.orch/agents/*.toml`, `.orch/permissions.toml`, and a manifest into that
repository, then registers the project centrally under `~/.orch/projects/<first-commit-sha>/`
(override with `ORCH_HOME`). Re-running `init` later preserves existing answers and asks only what's
missing.

**2. Run a feature:**
```sh
npx --package=github:codeninja93/agent-orc orch-run <repository> spec.json
```
where `spec.json` is:
```json
{ "feature": "kebab-slug", "request": "...", "acceptance_criteria": ["..."] }
```
Flags: `--shadow <merge-commit>` dry-runs against something already merged; `--resume <run-id>` picks
an already-accepted run back up.

**3. Watch or steer it:**
```sh
npx --package=github:codeninja93/agent-orc orch-web
```

If you'll be iterating a lot, cloning this repo once and running `npm install && npm run build` (then
`npm link`, or invoking `dist/bin/*.js` directly) is faster than round-tripping through `npx` each
time.

## Repository layout

| Path | Owns |
| --- | --- |
| `src/contracts/` | The dependency root: Zod schemas, the event envelope, error dispositions. Every other unit depends on it; it depends on nothing under `src/`. |
| `src/runtime/` | The recorder, the run's shared fetch record, and AD-9 path resolution. |
| `src/engine/` | The reconciler and everything it decides with — the step spawner, agent grants, promotion, the committer, the write executor. |
| `src/pool/` | Worktree lifecycle, the leased resource pool, and reclamation. |
| `src/container/` | AD-20's one containment boundary — the wrapper, reachability checks, isolation tiers. |
| `src/runner/` | The command runner (`Bash`'s replacement) — the only unit that places a step's command inside a container. |
| `src/installer/` | `orch init` — the interview, `.orch/` scaffolding, project registration. |
| `src/tool-servers/` | MCP tool servers (e.g. Jira) an agent can be granted. |
| `src/tui/` | The Ink renderer, a projection of the event log. |
| `src/web/` | The loopback HTTP + SSE control surface — a second renderer over the same projections. |
| `src/assembly/` | The composition root wiring a real reconciler, spawner, recorder, and committer together (`orch-run`). |
| `bin/` | Thin CLI entry points (`orch`, `orch-run`, `orch-web`, `orch-runner`, `orch-jira-server`) — argv in, exit code out; everything else lives under `src/`. |
| `docs/specs/spec-agent-orchestrator/` | The spec, architecture doc, interface contract, and every story's own record (spec change log, review triage log, auto-run result). |

## Developing this repository

```sh
npm install
npm run typecheck   # tsc -p tsconfig.json
npm run lint         # eslint .
npm run build        # tsc -p tsconfig.build.json && tsc -p tsconfig.bin.json
npm test             # vitest run
```

Node `>=22.22` (pinned in `.nvmrc`), npm `<12`. CI (`.github/workflows/ci.yml`) runs the same four
commands on both the pinned Node and the current one, on every push.

## Documentation

- [`docs/specs/spec-agent-orchestrator/SPEC.md`](docs/specs/spec-agent-orchestrator/SPEC.md) — the spec kernel
- [`docs/specs/spec-agent-orchestrator/architecture.md`](docs/specs/spec-agent-orchestrator/architecture.md) — the architecture
- [`docs/specs/spec-agent-orchestrator/interface-contract.md`](docs/specs/spec-agent-orchestrator/interface-contract.md) — the required surfaces
- [`docs/specs/spec-agent-orchestrator/stories/`](docs/specs/spec-agent-orchestrator/stories/) — every story's own spec, change log, and review record

## License

`UNLICENSED` — private, not published, all rights reserved.
