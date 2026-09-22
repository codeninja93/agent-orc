---
title: 'Profile loader, precedence rules, and agent roster discovery'
type: 'feature'
created: '2026-09-22'
status: 'drafted'
review_loop_iteration: 0
followup_review_recommended: false
baseline_revision: 'd913599'
context:
  - '{project-root}/docs/planning-artifacts/architecture/architecture-agent-orcastrator-2026-09-19/ARCHITECTURE-SPINE.md'
  - '{project-root}/docs/planning-artifacts/architecture/architecture-agent-orcastrator-2026-09-19/ADR-003-built-in-agent-tool-grants.md'
  - '{project-root}/docs/specs/spec-agent-orchestrator/memory-design.md'
  - '{project-root}/docs/specs/spec-agent-orchestrator/stories/2-1-installer.md'
deferred: []
---

# Story 2-3 — Profile loader, precedence rules, and agent roster discovery

## Intent

**Problem:** story 2-1 writes `.orch/profile.toml` and `.orch/agents/*.toml`, and nothing reads them. The
engine has no way to learn a repository's test command, and no way to learn which agents exist — so every
later roster story would have to invent its own reader, which is the two-sources-of-truth failure AD-16 and
AD-17 exist to prevent. AD-9 also requires a per-run configuration snapshot that nothing takes.

**Approach:** add the profile loader with AD-16's fixed precedence, the roster discovery AD-17 requires, and
AD-9's run-start config snapshot. The engine learns mechanics from the profile, defers to the repository on
conventions, and discovers agents by reading a directory — holding no list of its own.

## Boundaries & Constraints

**Mechanics and conventions are different questions, and only one of them can conflict.** The profile is
authoritative for mechanics — the four commands, the package manager, the layout, resource needs, risk tiers,
conflict domains — and nothing in a `CLAUDE.md` competes with it, because prose does not declare a test
command in a form anything can read. Conventions are the reverse: the repository's own instructions win, and
the loader's job there is to pass the text through, not to parse it. **A loader that tried to extract rules
from prose would be inventing the conflict it exists to resolve.**

**"Both speak to the same point" has to be mechanical, so it is decided by anchors.** AD-16 requires a
contradicted profile entry to be *flagged stale rather than silently applied* — and a loader cannot judge
semantic contradiction. What makes it decidable is the structure AD-16 already requires of a knowledge entry:
provenance, a decay policy, and an anchor that a sweep can check. So an entry declares the anchor it speaks
to, and it is flagged stale when the repository's instructions speak to that same anchor. Anchors are symbols
rather than paths and never line numbers, per `memory-design.md`.

**Nothing writes a knowledge entry yet, and the mechanism is still this story's.** The profile story 2-1
writes carries `project`, `mechanics` and `risk` and no knowledge section; entries arrive with the bootstrap
agent in stage 5. Building the precedence machinery here anyway is deliberate: the loader is the only place it
can live, and a later story adding entries should not also have to invent what happens when one contradicts
the repository. Said plainly so a reader knows this path is exercised by tests and not yet by a run.

**The engine holds no roster.** AD-17: "the engine discovers agents only by reading that directory and holds
no compiled-in list." Story 2-1 has a `BUILT_IN_AGENTS` array — the installer's template for what to *write* —
and ADR-003 just pinned it with tests, which makes it more tempting to reuse, not less. The engine must not
import it. That is a guard test over imports, in the shape stage 1 used for `src/tui/`, and it must recurse:
a non-recursive version of that guard silently stopped covering 44% of its directory when a subdirectory
appeared.

**A config snapshot is taken once, and a live run never sees an edit.** AD-9: the snapshot in
`runs/<run-id>/config/` is the only configuration any step of that run reads, and mid-run edits to `.orch/`
never affect it. So the loader has two distinct callers — run start, which snapshots, and a step, which reads
the snapshot — and a step reading `.orch/` directly is the defect this arrangement exists to prevent.

**A roster entry's contract id and tool grant are already constrained.** AD-17 requires a reference to a
*registered* contract id, never an inline schema; ADR-003 requires every granted tool name to be a declared
name. Both are already enforced at parse by the schemas story 2-1 shipped, so discovery validates by parsing
rather than by re-checking — and an entry naming an unregistered contract is refused with the registry's own
list, as the installer already does.

**Not in this story.** No agent behaviour — 2-4 through 2-7 implement the agents this discovers. No bootstrap
authoring (5-5). No memory content or decay sweep (5-1, 5-2): entries carry a decay policy here because AD-16
requires the field, and acting on it is not this story's. No profile editing: the installer writes it and a
person edits it by hand.

## I/O & Edge-Case Matrix

| # | Input | Expected |
|---|---|---|
| 1 | A `.orch/` written by the installer | The profile loads, mechanics are available, and the roster is the agents on disk |
| 2 | No `.orch/` at all | Refused naming what to run to create it, never a silent default profile |
| 3 | A profile carrying an unrecognised `schema_version` | Refused with `config.schema_version_unrecognised`, as every versioned artifact is |
| 4 | A repository with a `CLAUDE.md` | Its text is available as authoritative for conventions, unparsed |
| 5 | A repository with `AGENTS.md` and no `CLAUDE.md` | Same, from whichever exists; both present is not an error |
| 6 | A repository with neither | Conventions are absent, and the profile's mechanics still load |
| 7 | A knowledge entry whose anchor the repository's instructions also speak to | Flagged stale, not applied, and the flag names the anchor and the instruction file |
| 8 | A knowledge entry whose anchor nothing else speaks to | Applied, carrying its provenance and decay policy |
| 9 | A knowledge entry with no anchor | Refused at parse: an entry nothing can check is an entry nothing can flag |
| 10 | A knowledge entry anchored on a line number | Refused: `memory-design.md` forbids line numbers as anchors |
| 11 | `.orch/agents/` holding three TOMLs | Exactly those three agents, in a deterministic order |
| 12 | An agent TOML naming an unregistered contract id | Refused naming the registered ids, and the other agents still load |
| 13 | An agent TOML granting a tool ADR-003 does not declare | Refused at parse |
| 14 | An agent TOML whose id disagrees with its file name | Refused: one entry cannot have two names |
| 15 | `.orch/agents/` empty or absent | An empty roster, said plainly — not a built-in default |
| 16 | The engine's own source | Nothing under it imports the installer's `BUILT_IN_AGENTS`, checked recursively |
| 17 | Run start | A snapshot is written under `runs/<run-id>/config/`, carrying the profile, the roster and the conventions text |
| 18 | `.orch/` edited after a snapshot exists | The snapshot is unchanged and a step reads the snapshot's values, not the new ones |

## Code Map

| File | Change | Why |
|---|---|---|
| `src/contracts/knowledge.ts` | new | The knowledge entry: anchor, provenance, decay policy — AD-16's required fields, in `memory-design.md`'s vocabulary. AD-2 puts every schema in code. |
| `src/contracts/installer.ts` | modify | `ProfileSchema` gains the optional knowledge section. Optional because every profile written so far has none. |
| `src/engine/profile.ts` | new | Load, apply AD-16's precedence, produce the resolved configuration. |
| `src/engine/conventions.ts` | new | Read `CLAUDE.md`/`AGENTS.md` as text and answer which anchors they speak to — the one question precedence needs. |
| `src/engine/roster.ts` | new | Discovery by directory read; the spine's layout names "roster discovery" in the engine. |
| `src/engine/config-snapshot.ts` | new | AD-9's run-start snapshot, and the step-side reader. |
| `src/runtime/paths.ts` | modify | The snapshot's path beside the other `ORCH_HOME` names. |
| `tests/engine.profile.test.ts` | new | Matrix 1–3, 7–10. |
| `tests/engine.conventions.test.ts` | new | Matrix 4–6. |
| `tests/engine.roster.test.ts` | new | Matrix 11–16, including the recursive import guard. |
| `tests/engine.config-snapshot.test.ts` | new | Matrix 17, 18. |

## Tasks & Acceptance

1. **Load the profile, versioned and refused rather than defaulted.**
   - **Given** a `.orch/` the installer wrote, **when** the profile is loaded, **then** the four commands, the
     package manager, the layout, resource needs and the risk tiers are available.
   - **Given** no `.orch/`, **when** a load is attempted, **then** it is refused naming what creates one, and
     no default profile is invented.
   - **Given** an unrecognised `schema_version`, **when** it is read, **then** it is refused carrying
     `config.schema_version_unrecognised`.

2. **Pass conventions through, unparsed.**
   - **Given** a repository with a `CLAUDE.md`, **when** conventions are read, **then** its text is available
     verbatim and nothing has tried to extract rules from it.
   - **Given** a repository with neither instruction file, **when** conventions are read, **then** they are
     absent and mechanics still load.

3. **Decide precedence by anchor.**
   - **Given** a knowledge entry whose anchor the repository's instructions also speak to, **when** the
     profile is resolved, **then** the entry is flagged stale, is not applied, and the flag names both the
     anchor and the file that overrode it.
   - **Given** an entry whose anchor nothing else speaks to, **when** the profile is resolved, **then** it is
     applied carrying its provenance and decay policy.
   - **Given** an entry with no anchor, or one anchored on a line number, **when** it is parsed, **then** it
     is refused.

4. **Discover the roster by reading the directory, and hold no list.**
   - **Given** three agent TOMLs, **when** the roster is discovered, **then** exactly those three load, in a
     deterministic order.
   - **Given** an entry naming an unregistered contract id, **when** it is read, **then** it is refused naming
     the registered ids, and the other entries still load.
   - **Given** an empty or absent `.orch/agents/`, **when** the roster is discovered, **then** it is empty and
     says so — never a built-in default.
   - **Given** the engine's source, **when** its imports are walked **recursively**, **then** nothing under it
     imports the installer's built-in roster.

5. **Snapshot the configuration once at run start.**
   - **Given** a run starting, **when** the snapshot is taken, **then** `runs/<run-id>/config/` carries the
     profile, the roster and the conventions text.
   - **Given** `.orch/` edited after the snapshot, **when** a step reads its configuration, **then** it reads
     the snapshot's values and the snapshot is unchanged.

## Spec Change Log

## Review Triage Log

## Design Notes

## Verification

## Auto Run Result
