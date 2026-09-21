---
title: 'Installer — npx init, the interview, .orch/ scaffolding'
type: 'feature'
created: '2026-09-21'
status: 'drafted'
review_loop_iteration: 0
followup_review_recommended: false
baseline_revision: 'e7409af'
context:
  - '{project-root}/docs/planning-artifacts/architecture/architecture-agent-orcastrator-2026-09-19/ARCHITECTURE-SPINE.md'
  - '{project-root}/docs/specs/spec-agent-orchestrator/build-sequencing.md'
  - '{project-root}/docs/specs/spec-agent-orchestrator/interface-contract.md'
warnings: ['oversized'] # first stage-2 story, first executable entry point, 13 questions and four written artifacts
deferred: []
---

# Story 2-1 — Installer: npx init, the interview, `.orch/` scaffolding

## Intent

**Problem:** twelve stories and 1597 tests in, the system cannot be started. There is no `bin`, nothing reads
`process.argv`, no `Reconciler` is constructed anywhere in `src/`, and `package.json` exports only
`dist/contracts`. Stage 1's reviews recorded this three times over — the containment package, the pool and
the command transport each have zero production callers — and every time the owner named was this story.
Nothing can onboard a project, so nothing can run one.

**Approach:** add `bin/init.ts` and `src/installer/`: the `npx github:<owner>/<repo> init` entry point AD-12
names, the thirteen-question interview `build-sequencing.md` fixes, and the `.orch/` files it writes with a
`schema_version` and a manifest. This story makes the system installable. It does not make it run a feature —
the roster is 2-3 through 2-7 and the engine's own entry point is theirs.

## Boundaries & Constraints

**The interview's wording is free; what it produces is not.** `build-sequencing.md` fixes thirteen questions
in order, and says outright that their wording may change while AD-9, AD-12, AD-17 and AD-28 fix the output.
So the tests belong on the artifacts — the TOML that lands, its `schema_version`, its manifest entry — not on
prompt strings. A test asserting a question's wording pins the one thing the contract frees.

**Re-running preserves answers and asks only what is missing.** That is AD-12's upgrade path, not a
convenience: an upgrade *is* a re-run. So the installer reads `.orch/` before it asks anything, and a second
run with every answer present asks nothing and writes nothing but a refreshed manifest. Idempotence here is
observable — two runs, byte-identical `.orch/` except where an answer actually changed.

**A half-install must be detectable and recoverable from the manifest.** The manifest lists every file the
installer created, so a run interrupted between two writes leaves evidence of what it had done. Recovery is a
re-run: the manifest says what exists, the interview fills what is missing. This is the one place the
installer reads its own past output as authority rather than as a default.

**Environment variable NAMES, never values.** Question 9 collects the names of variables holding credentials
for external domains. AD-12 says the installer bundles no credential, and stage 1 spent four stories learning
that a credential in a file is a credential in a backup. A value must never reach `.orch/`, and the test for
that is an assertion over what was written, not over what was asked.

**Nothing under `.orch/` may require BMad.** AD-18. The installer is delivered from this repository, which
contains `_bmad/`, so the constraint is easy to violate by accident: a generated profile that references a
skill, a manifest path under `_bmad/`, a runtime read of a rendered workflow. A guard test over the written
tree, in the shape stage 1 used for `src/tui/`'s import rules.

**The delivery path is the part that cannot be proved from inside.** `npx github:<owner>/<repo> init` runs
npm's git-dependency path, which resolves the ref, runs `prepare`, and exposes `bin`. AD-12 states a revisit
condition: npm 12 disables git-dependency resolution and install scripts by default. Story 1-12's review
added `.npmrc` with `engine-strict=true`, so `engines.npm: "<12"` is now fatal at install time rather than a
warning — which satisfies AD-12's bound but also means **the delivery path must be exercised, not asserted**.
A test that reads `package.json` and concludes `npx` works is precisely the class of adjacent verification
stage 1's review found nineteen times.

**Not in this story.** No project registration — the first-commit SHA is *detected and confirmed* here, and
story 2-2 owns registering it and the prune command. No Interviewer agent (2-8): these thirteen questions are
asked by the installer in the terminal, not compressed by a model. No agent implementations (2-3 to 2-7) —
question 10 enables built-ins by writing their TOML, and the agents themselves arrive later. No engine entry
point: this story installs a project, it does not run one.

## I/O & Edge-Case Matrix

| # | Input | Expected |
|---|---|---|
| 1 | A git repository with no `.orch/` | All thirteen questions asked in order; `.orch/profile.toml`, `.orch/agents/*.toml`, `.orch/permissions.toml` and a manifest written, `.gitignore` appended |
| 2 | The same repository, installer re-run with every answer present | Nothing is asked, no answer changes, the manifest is refreshed, and the tree is byte-identical otherwise |
| 3 | A re-run after one answer was removed from `.orch/` | Only that question is asked; every other answer survives untouched |
| 4 | A run interrupted between two file writes | The manifest records what was created; a re-run completes the install and reports what it recovered |
| 5 | Question 9 answered with a variable name | The name reaches `.orch/`; no environment value is read, written or echoed |
| 6 | Question 9 answered with something that looks like a secret | Refused as a value rather than a name, naming the distinction |
| 7 | A directory that is not a git repository | Refused before anything is written, naming what it needed |
| 8 | A repository with no commits | Refused: the project id is the first-commit SHA, and there is not one yet |
| 9 | An existing `.gitignore` already listing the runtime paths | Appended idempotently — no duplicate lines on a re-run |
| 10 | An existing `.gitignore` with no trailing newline | The append does not join itself to the last line |
| 11 | `.orch/` written by an older `schema_version` | Detected and refused or migrated, never read as if current (AD-28) |
| 12 | Detected defaults for the package manager and the four commands | Offered as defaults, and a person can override each |
| 13 | Anything the installer writes | Carries a `schema_version`, appears in the manifest, and lives under `.orch/` or is the `.gitignore` append |
| 14 | The written tree | Nothing references `_bmad`, a BMad skill or a BMad command (AD-18) |
| 15 | **The delivery path** | `npx` against this repository's git ref produces a runnable `init` — exercised against a real ref, not inferred from `package.json` |

## Code Map

| File | Change | Why |
|---|---|---|
| `bin/init.ts` | new | The entry point AD-12 names; the spine's layout puts it exactly here. Argument parsing and exit codes only. |
| `package.json` | modify | `bin`, and whatever `files`/`prepare` the git-dependency path needs. The first change to the delivery surface. |
| `src/installer/interview.ts` | new | The thirteen questions as data — order, prompt, validator, default source — so the sequence is a value and not a script. |
| `src/installer/detect.ts` | new | Detected defaults: package manager, the four commands, source layout, git remote, first-commit SHA. Pure functions over a repository path. |
| `src/installer/answers.ts` | new | Reading existing answers out of `.orch/`, merging with new ones, deciding what is still missing. |
| `src/installer/write.ts` | new | The four artifacts and the `.gitignore` append, each atomic, each manifest-recorded. |
| `src/installer/manifest.ts` | new | The manifest: what was created, with `schema_version`; the half-install reader. |
| `src/contracts/installer.ts` | new | The schemas for `profile.toml`, an agent TOML, `permissions.toml` and the manifest — contracts, because AD-2 puts every schema in code and AD-28 versions every artifact. |
| `tests/installer.interview.test.ts` | new | Matrix 1, 3, 12 — the sequence and the merge, over data rather than prompts. |
| `tests/installer.artifacts.test.ts` | new | Matrix 5, 6, 11, 13, 14 — what lands on disk. |
| `tests/installer.idempotence.test.ts` | new | Matrix 2, 4, 9, 10 — the re-run and the half-install. |
| `tests/installer.refusals.test.ts` | new | Matrix 7, 8. |
| `tests/installer.delivery.test.ts` | new | Matrix 15 — the one test that must exercise npm rather than read a manifest. |

## Tasks & Acceptance

1. **Make the interview data.** Thirteen entries carrying order, prompt, validator and default source.
   - **Given** the interview, **when** it is enumerated, **then** it yields thirteen questions in
     `build-sequencing.md`'s order, and each names how its default is detected or that it has none.
   - **Given** an answer set missing one entry, **when** the installer runs, **then** exactly that question is
     asked and no other.

2. **Detect the defaults.** Package manager, test/lint/build/run, source layout, remote, first-commit SHA.
   - **Given** a repository using npm with a `test` script, **when** defaults are detected, **then** the
     package manager and the four commands are offered from what is there.
   - **Given** a repository with no commits, **when** the installer runs, **then** it refuses before writing,
     because the project id is the first-commit SHA.

3. **Write the four artifacts and the `.gitignore` append**, each atomically and each manifest-recorded.
   - **Given** a completed interview, **when** it writes, **then** `.orch/profile.toml`, `.orch/agents/*.toml`,
     `.orch/permissions.toml` and the manifest exist, each carrying a `schema_version`.
   - **Given** an existing `.gitignore` with no trailing newline, **when** the runtime paths are appended,
     **then** the first appended line is its own line, and a second run adds nothing.
   - **Given** anything written, **when** the tree is inspected, **then** it lies under `.orch/` or is the
     `.gitignore` append, and nothing references `_bmad` or a BMad skill.

4. **Collect credential variable names, never values.**
   - **Given** question 9 answered with a variable name, **when** the artifacts are written, **then** the name
     is present and no value of that variable was read.
   - **Given** an answer shaped like a secret rather than a name, **when** it is validated, **then** it is
     refused naming the distinction.

5. **Be idempotent, and recover a half-install.**
   - **Given** a complete `.orch/`, **when** the installer is re-run, **then** it asks nothing and the tree is
     byte-identical but for the manifest's own refresh.
   - **Given** a run interrupted after some files were written, **when** the installer is re-run, **then** the
     manifest identifies what exists, the install completes, and the outcome states what was recovered.
   - **Given** an `.orch/` carrying an unrecognised `schema_version`, **when** it is read, **then** it is
     refused or migrated, never treated as current.

6. **Prove the delivery path by running it.**
   - **Given** this repository at a git ref, **when** `npx` installs from that ref into a scratch directory,
     **then** `init` is runnable and its `--help` (or equivalent) answers.
   - **Given** that path, **when** it is exercised, **then** the test fails if `bin`, `files` or the build
     step stops producing a runnable entry point — it must not infer this from `package.json`'s text.

## Spec Change Log

## Review Triage Log

## Design Notes

## Verification

## Auto Run Result
