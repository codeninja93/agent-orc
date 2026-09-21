---title: Project identity — first-commit SHA registration and prune
type: feature
created: '2026-09-21'
status: done
review_loop_iteration: 0
followup_review_recommended: true
baseline_revision: eea19a9
context:
- '{project-root}/docs/planning-artifacts/architecture/architecture-agent-orcastrator-2026-09-19/ARCHITECTURE-SPINE.md'
- '{project-root}/docs/specs/spec-agent-orchestrator/stories/2-1-installer.md'
deferred:
- summary: No review layer ran against this story.
  evidence: 'The gate, five implementer mutations and my own verification of the deletion boundary, the
    credential gate and the colliding-SHA premise are the only scrutiny. Read `status: done` as implemented
    and gated, not reviewed.'
  severity: high
- summary: '`prune` is not exercised through the delivered binary, only through its parts.'
  evidence: '`tests/installer.delivery.test.ts` runs a real `orch init` and `--help`/`--version` through
    an npm-installed package, but `prune` is covered at `parseInitArguments` + `pruneProject` level only
    — so roughly twenty lines of glue in `bin/init.ts` (stream choice, exit code, the catch) are untested
    by execution. Story 2-1 proved this distinction matters: dropping `"dist"` from `files` left 50 installer
    tests green and was caught only by the tests that execute the delivered binary.'
  location: bin/init.ts
  severity: medium
- summary: Seven decisions were taken beyond the spec's letter and want confirming.
  evidence: (1) The `unlocated` result names a foreign repository by id and never by path, asserted by
    stringifying the whole result — structure rather than discipline. (2) `location` records the last
    verdict rather than accumulating, so a repository found again is located again. (3) `--force` exists
    and defaults to false. (4) Pruning an unregistered id exits 0, on the grounds that the state asked
    for is the state that holds — reversible if you want 1. (5) Four unlocated reasons rather than three,
    separating a re-`git init`-ed directory from a foreign one. (6) The pointer records the repository
    root, so registering `<repo>/src` registers `<repo>`. (7) A confirmed id that is not this repository's
    first commit is refused before anything is written, because question 2 only checks the shape.
  severity: medium
- summary: 'PRE-EXISTING, not this story: some suite creates empty `~/.orch/runs/` and `~/.orch/worktrees/`
    in the real home.'
  evidence: Found while isolating this story's `ORCH_HOME`. No `projects/` appears there, so 2-2 writes
    nothing outside its scratch homes, and the five installer suites were given scratch homes as part
    of this work. The leak predates stage 2 and belongs to whichever suite creates them.
  severity: low
---

# Story 2-2 — Project identity: first-commit SHA registration and prune

## Intent

**Problem:** story 2-1 detects a repository's first-commit SHA, confirms it with a person, and writes it into
`.orch/profile.toml` — and then nothing happens with it. Nothing registers the project centrally, so
`ORCH_HOME/projects/<project-id>/` has no writer, nothing resolves a repository to its central record, and
AD-9's required prune command does not exist. A project that is moved or renamed silently becomes a second
project the first time anything keys it by path.

**Approach:** add the registration record under `projects/<project-id>/` and the three operations AD-10
implies — register, resolve, prune. The id is the first-commit SHA and never changes; the filesystem path is
a *pointer* the record updates on mismatch; a path that cannot be resolved marks the registration
`unlocated` and does nothing else. Central state is deleted only by an explicit prune naming a project-id.

## Boundaries & Constraints

**The id is the SHA and the path is a guess.** AD-10 exists because one unit keying by path while another
keys by remote URL splits one project into several after a move. So every operation here takes a
*project-id*, and a path is only ever an input to be verified or an output to be corrected. No function in
this story may accept a path as the identity of a project.

**Resolution must verify, not trust.** A recorded path is a pointer, and a pointer can be stale in two
different ways: the directory may be gone, or it may now hold a *different* repository. Following the second
is worse than failing on the first, because it reads one project's central record against another
project's code. Resolution therefore reads the first-commit SHA at the pointed path and compares it to the
id; equality is the only thing that makes a pointer live.

**Unlocated means unlocated, and nothing more.** This is AD-33's discipline — the absence of a path is not
abandonment — which stage 1 established for worktrees and leased resources and which applies with more force
here, because what is at stake is a project's accumulated memory. An unresolvable path marks the record and
stops. It triggers no cleanup, no reclamation, no deletion, and no warning that implies any of those.

**Prune is the only deleter, it names an id, and it refuses a living project.** AD-9 requires a prune
command for state orphaned by a deleted project directory. Two things follow. It takes a project-id, never a
path, so a person cannot delete the wrong project by standing in the wrong directory. And when the named id
still resolves to a real repository, prune refuses rather than proceeding, because deleting a located
project's memory is unrecoverable and "orphaned" is precisely what that project is not. A person who means it
can say so explicitly; the default answers the question AD-9 asked.

**Registration is idempotent, and a move is not a new project.** Registering an already-registered id
updates the pointer and touches nothing else. This is the same property story 2-1 established for the
installer, for the same reason: an upgrade is a re-run, and a project that moved is the project that moved.

**A clone shares its first commit, so one project can have two checkouts.** That is not a defect — AD-10
makes them one project — but the record holds one pointer, so the last registration wins. Two concurrent
checkouts will move the pointer back and forth. Name it; do not attempt to hold two.

**Not in this story.** No memory content — `projects/<project-id>/` gains a registration record here, and
what memory is stored in it is story 5-1's. No profile lookup: the profile lives in `<target-repo>/.orch/`
per AD-9 and is never stored centrally, so resolution returns a located repository path, not configuration.
No engine wiring — nothing yet runs a feature, and the story that assembles the loop owns calling this.

## I/O & Edge-Case Matrix

| # | Input | Expected |
|---|---|---|
| 1 | A repository with a first commit, not yet registered | A record at `projects/<sha>/` carrying the id, the path and a `schema_version` |
| 2 | The same repository, registered again from the same path | The record is unchanged but for its own timestamp; nothing else is written |
| 3 | The same repository, registered from a new path | The pointer is updated; the id, and everything else in the record, survives |
| 4 | A repository with no commits | Refused: an id cannot exist yet (AD-10) |
| 5 | Resolving an id whose pointed path is gone | `unlocated`; the record survives; nothing is deleted or reclaimed |
| 6 | Resolving an id whose pointed path now holds a **different** repository | `unlocated` and the stale pointer is not followed — never the other project's path |
| 7 | Resolving an id that was never registered | Says so; creates nothing |
| 8 | A repository whose root commit was rewritten | A different id, so a different project; the old record is untouched and becomes unlocated |
| 9 | Two checkouts of one repository, registered in turn | One record; the pointer names the most recent; both resolve to it |
| 10 | `prune` naming an id that is unlocated | The record and its central state are removed, and what was removed is reported |
| 11 | `prune` naming an id that still resolves | Refused, naming the located path — a living project is not orphaned |
| 12 | `prune` naming an id that was never registered | Says so; removes nothing |
| 13 | `prune` naming one id when several are registered | Only that one is removed; every other record survives byte-identically |
| 14 | A record carrying an unrecognised `schema_version` | Refused rather than read as current (AD-28) |
| 15 | Two registrations racing for one id | Exactly one record results, and it is whole — never half-written |
| 16 | The installer completing an install | Registers the project it just configured, so `.orch/` and the central record agree |

## Code Map

| File | Change | Why |
|---|---|---|
| `src/contracts/project.ts` | new | The registration record's schema with its `schema_version` — AD-2 puts every schema in code, AD-28 versions every artifact. |
| `src/runtime/projects.ts` | new | `registerProject`, `resolveProject`, `pruneProject`, and the record reader. Runtime, because `projectsDir`/`projectDir` and every other `ORCH_HOME` write already live there. |
| `src/runtime/paths.ts` | modify | The record's file name beside the other `ORCH_HOME` names, so the layout is spelled once. |
| `src/installer/index.ts` | modify | Register on a completed install (matrix 16), so the id 2-1 confirms is the id that exists centrally. |
| `bin/init.ts` | modify | The `prune` subcommand AD-9 requires, taking a project-id. |
| `src/contracts/registry.ts` | modify | Register the record contract, as the installer's four artifacts are. |
| `tests/contracts.project.test.ts` | new | Matrix 14 and the schema's shape. |
| `tests/runtime.projects.test.ts` | new | Matrix 1–9, 15 — against real git repositories, because a first-commit SHA is not a fixture. |
| `tests/runtime.projects-prune.test.ts` | new | Matrix 10–13. |
| `tests/installer.registration.test.ts` | new | Matrix 16, through the installer's own path. |

## Tasks & Acceptance

1. **Record a registration, keyed by the SHA.**
   - **Given** a repository with a first commit, **when** it is registered, **then** a record exists at
     `projects/<sha>/` carrying the id, the path and a `schema_version`.
   - **Given** a repository with no commits, **when** registration is attempted, **then** it is refused
     naming why, and nothing is written.
   - **Given** two registrations racing for one id, **when** both run, **then** exactly one whole record
     results.

2. **Treat the path as a mutable pointer.**
   - **Given** a registered project moved to a new path, **when** it is registered from there, **then** the
     pointer is updated and the id and the rest of the record survive.
   - **Given** a registration from the same path, **when** it runs again, **then** nothing but its own
     timestamp changes.

3. **Resolve by verifying, and mark unlocated otherwise.**
   - **Given** an id whose pointed path is gone, **when** it is resolved, **then** the result is `unlocated`,
     the record survives, and nothing is deleted or reclaimed.
   - **Given** an id whose pointed path now holds a different repository, **when** it is resolved, **then**
     the result is `unlocated` and the returned value never names that other path.
   - **Given** an id that was never registered, **when** it is resolved, **then** it says so and creates
     nothing.

4. **Prune explicitly, by id, and refuse a living project.**
   - **Given** an unlocated id, **when** prune names it, **then** its central state is removed and what was
     removed is reported.
   - **Given** an id that still resolves, **when** prune names it, **then** it is refused naming the located
     path, and nothing is removed.
   - **Given** several registered ids, **when** prune names one, **then** every other record survives
     byte-identically.

5. **Wire it to the installer.**
   - **Given** an install that completes, **when** it finishes, **then** the project is registered and the id
     in `.orch/profile.toml` is the id of the central record.
   - **Given** a re-run of the installer, **when** it finishes, **then** registration is idempotent along
     with everything else 2-1 guarantees.

6. **Refuse an unrecognised `schema_version`** rather than reading it as current.
   - **Given** a record carrying a version this build does not recognise, **when** it is read, **then** it is
     refused carrying `config.schema_version_unrecognised`, as every other versioned artifact is.

## Spec Change Log

## Review Triage Log

## Design Notes

## Verification

## Auto Run Result

**Status: done.** Registration, resolution and prune exist; `ORCH_HOME/projects/<project-id>/` has a writer
for the first time, and the id story 2-1 confirms is now the id that exists centrally. Suite 1668 -> 1724
tests across 61 files, zero skips.

**The most valuable thing in this round is a premise the implementer checked rather than assumed.** Story
2-1's test fixture builds repositories deterministically — same tree, same author, same message, same
timestamp — and git's commit hash is content-addressed over exactly those, so two fixture repositories had
**byte-identical first-commit SHAs**. I verified it independently: two repositories built the same way both
hash to `83098de1…`. Without a planted UUID, matrix rows 6, 8 and 9 — different repository, rewritten root,
clone — would every one have passed while comparing a value to itself. The suite now opens with a test named
"builds two repositories with different first commits, so a comparison compares something". That is the
twentieth instance of this project's recurring pattern and the first caught before it shipped.

**The deletion boundary holds, and was checked rather than trusted.** A background security review flagged a
`rmSync` inside `resolveProject` mid-round; it was the implementer's own labelled mutation 2, reverted before
the round ended. My gate at commit: `rmSync` appears exactly once in `src/runtime/projects.ts`, at line 662,
inside `pruneProject`. `resolveProject` contains no deletion at all. Prune refuses a located project by
default, naming the path and saying how to mean it anyway, and fsyncs the directory after removal — because a
prune that reappeared after a power loss would be a deletion a person believed.

**Two guards from earlier stories were kept rather than re-litigated.** `parseVersionedArtifact` is the only
read path, so an unrecognised `schema_version` carries `config.schema_version_unrecognised` and its
"re-run the installer" advice — story 1-12 found `readIntentFiles` was the lone exception to that, and this
story did not become the second. And relocating the git probes into `src/runtime/repository.ts` moved
`gitEnvironment()`'s minimal, credential-free environment with them rather than copying it, so
`grep "process.env" src/installer/` now returns nothing at all.

**Residual risk, and why `followup_review_recommended` is true.** No review layer ran. The specific
unverified risk is that `prune` — the one operation here that destroys a person's accumulated memory — is
exercised at its parts and not through the delivered binary, and story 2-1 demonstrated that the distinction
is not academic: dropping `"dist"` from `files` left fifty installer tests green and was caught only by the
tests that execute what npm installed.
