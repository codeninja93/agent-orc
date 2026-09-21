---title: Installer — npx init, the interview, .orch/ scaffolding
type: feature
created: '2026-09-21'
status: done
review_loop_iteration: 0
followup_review_recommended: true
baseline_revision: e7409af
context:
- '{project-root}/docs/planning-artifacts/architecture/architecture-agent-orcastrator-2026-09-19/ARCHITECTURE-SPINE.md'
- '{project-root}/docs/specs/spec-agent-orchestrator/build-sequencing.md'
- '{project-root}/docs/specs/spec-agent-orchestrator/interface-contract.md'
warnings:
- oversized
deferred:
- summary: 'SPEC AMENDMENT: the Stack''s Node-floor rationale is factually wrong, verified by probe.'
  evidence: '`ARCHITECTURE-SPINE.md:306` says 22.18 is the true minimum "being where native TypeScript
    type stripping lands, which the `bin/init.ts` npx entry point requires". I measured it: a `.ts` file
    under `node_modules` throws ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING, while the identical file
    outside strips fine — and `npx` installs into `node_modules`. Node also does not resolve a `./x.js`
    specifier to `x.ts`, so this codebase could not run un-built regardless. The floor is still right
    for other reasons; its stated reason is void. The shipped bin is JavaScript: `bin/init.ts` stays where
    the spine puts it and `prepare` compiles it to `dist/bin/init.js`.'
  location: ARCHITECTURE-SPINE.md:306
  severity: medium
- summary: AD-12's revisit condition is arriving before npm 12, by policy rather than by version.
  evidence: 'npm 11.19.0 still runs `prepare` but warns: "1 package has install scripts not yet covered
    by allowScripts". AD-12 frames the condition as npm 12 disabling git-dependency resolution and install
    scripts; the install-script half is visibly landing early. When the default flips, this delivery path
    silently produces a package with no `dist/` and a `bin` pointing at nothing. The delivery test would
    catch it on the day it happens. The options — prebuild and commit `dist/`, ship a build-free bin,
    or document an allowScripts step — are a spec decision.'
  severity: high
- summary: Five interview decisions were taken from the spec's silence and want confirming.
  evidence: (1) AD-9's ".gitignore runtime paths" are enumerated nowhere and every runtime artifact lives
    under ORCH_HOME, so one line was appended — `.orch/**/*.tmp`, the debris an interrupted atomic write
    leaves — as the only thing the runtime can leave in the repository. (2) Question 12 maps to AD-27's
    RUN_MODES (shadow|live), because the finer AUTONOMY_MODES ladder is folded from the event log and
    making it a per-repo setting too would put one value in two scopes, which AD-34 forbids. (3) Ceiling
    units are steps / wall_clock_minutes / rate_limit_budget_percent, since AD-24 gives no currency dimension.
    (4) An unparseable hand-edited `.orch/` file reads as *no answers* rather than fatally, because refusing
    would make the half-install AD-12 requires to be recoverable unrecoverable. (5) A project id that
    is not this repository's first commit is dropped and re-asked rather than written, since it would
    key the wrong central record.
  severity: medium
- summary: No review layer ran against this story.
  evidence: 'The gate, ten implementer mutations and my own verification of the credential rule, the delivery
    path and the type-stripping finding are the only scrutiny. Read `status: done` as implemented and
    gated, not reviewed.'
  severity: high
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

**Status: done.** `bin/init.ts` and `src/installer/` exist, and the system is installable for the first
time. Suite 1597 -> 1668 tests across 57 files, zero skips, zero failures.

**The delivery path is exercised, not inferred.** `tests/installer.delivery.test.ts` builds a git repository
from the working tree, `npm install git+file://<repo>#<sha>` into a scratch consumer — real ref resolution,
real `prepare`, real pack honouring `files`, real `bin` link — then runs the linked binary: `--help`, a real
install of a fresh repository asserting `.orch/profile.toml` and `manifest.toml` land, a refusal asserting
exit 1, and `npm exec`, which is `npx`. Both invocations run with `engine_strict`, so `engines.npm: "<12"` is
fatal rather than warned. Honestly stated rather than engineered away: the ref is `git+file://` and not
`github:<owner>/<repo>`, because the code is uncommitted and a network fetch would fail for unrelated
reasons; everything npm does after resolving the ref is identical. The test is slow-ish and cache-dependent.

That it is real was proved by mutation: dropping `"dist"` from `files` left the other four installer suites —
50 tests — entirely green, and was caught only by the tests that *execute* the delivered binary. Renaming the
bin was caught by `ENOENT` on the linked path. A `package.json` text assertion would have caught neither.

**The credential rule has two independent guards, and both are live.** Writing a value into `credential_env`
is caught by the schema; leaking a value into `branch_pattern`, a free-text field no schema rejects, is
caught by a byte scan of the written tree; and reading a variable and discarding it — nothing reaching disk —
is caught by an environment-read proxy that recorded only ten reads in a whole install. The middle arm
matters: it is the one a field assertion would miss, and it is the one a background security scan flagged
mid-round while the mutation was in the tree. I ran my own gate before committing: `grep -rn "process\.env"
src/installer/ bin/` returns only `detect.ts`'s `PATH` and `HOME`, which build the minimal environment handed
to `git` so the installer's one child process inherits nothing.

**The AD-18 guard recurses, and that is load-bearing rather than decorative.** Making its own walk
non-recursive fails five tests, including one named for the failure it prevents — stage 1's equivalent guard
silently stopped covering 44% of its directory the moment a subdirectory appeared.

**Two findings that need a spec decision, both verified rather than reported.** The Stack's Node-floor
rationale is void: Node refuses to strip types under `node_modules`, which is exactly where `npx` installs,
so the shipped bin must be JavaScript. And AD-12's revisit condition is arriving ahead of npm 12 — npm
11.19.0 already warns that `prepare` is "not yet covered by allowScripts", and when that default flips this
path produces a package with no `dist/` and a `bin` pointing at nothing.

**Residual risk, and why `followup_review_recommended` is true.** No review layer ran. The specific
unverified risk is the TOML subset written for this story: it is a new parser and serialiser on the path
every `.orch/` artifact takes, its determinism is what makes byte-level idempotence true, and the only thing
exercising it is this story's own tests.
