---
title: 'Committer — branch naming, pull request, git note on the merge commit'
type: 'feature'
created: '2026-09-23'
status: 'done'
review_loop_iteration: 0
followup_review_recommended: true
baseline_revision: '2b5bb7b'
context:
  - '{project-root}/docs/planning-artifacts/architecture/architecture-agent-orcastrator-2026-09-19/ARCHITECTURE-SPINE.md'
  - '{project-root}/docs/planning-artifacts/architecture/architecture-agent-orcastrator-2026-09-19/ADR-005-per-artifact-schema-versions.md'
  - '{project-root}/docs/specs/spec-agent-orchestrator/stories/2-6-testing-and-verification.md'
deferred:
- summary: No review layer ran against this story.
  evidence: 'The gate, eight implementer mutations and my own independent verification are the only
    scrutiny. I re-ran the gate myself (exit 0, 2470/83, zero skips), reproduced the AD-22 placeholder
    mismatch directly, confirmed `.strict()` refuses a `force` field on `WriteIntentSchema` with a
    corrected positive control, and confirmed the note advances independently of `state.json` by issue
    content rather than by success/failure alone. Read `status: done` as implemented and gated, not
    reviewed.'
  severity: high
- summary: "AD-22's own canonical wording and the codebase's existing default disagreed on the slug placeholder."
  evidence: |-
    AD-22 in `ARCHITECTURE-SPINE.md` says the branch pattern defaults "to `feature/<feature-slug>`".
    The installer's `DEFAULT_BRANCH_PATTERN` was `feature/<slug>`, and its validation checked for the
    substring `<slug>` — which `'feature/<feature-slug>'.includes('<slug>')` answers `false` for,
    verified directly. So AD-22's own stated default would have been refused by the installer that is
    supposed to write it, and two existing test fixtures (`tests/helpers/config-fixture.ts`,
    `tests/contracts.toml.test.ts`) already wrote profiles the interview would never have produced.
    Resolved by declaring both spellings valid in one place (`BRANCH_SLUG_PLACEHOLDERS`) rather than
    picking one and migrating the other, which is the non-breaking option. A reviewer may prefer one
    canonical spelling instead; that is now a spec-level choice, not an implementation one.
  location: src/contracts/installer.ts
  severity: medium
- summary: 'An `unknown` branch-protection result does not refuse the run, by decision.'
  evidence: 'The story requires unknown to be reported as unknown, never as satisfied, but does not say
    whether it blocks. Verified: only `unprotected` refuses; `unknown` is recorded and the run continues,
    on the stated ground that refusing every repository the engine cannot reach would stop an offline
    machine running at all. This is a real policy call recorded in the module docblock, not a gap.'
  location: src/engine/protection.ts
  severity: medium
- summary: 'No host probe exists yet, so every shipped run currently records `unknown`.'
  evidence: '`branchProtection` is an injected `ReconcilerOptions` field defaulting to `null`. A real
    probe needs a host credential, which AD-13 puts behind the fetch record and AD-15 behind the write
    surface, and no unit yet assembles one. The assertion, the three outcomes and the refusal are all
    live and tested; what is absent is the caller that supplies a probe.'
  location: src/engine/protection.ts
  severity: medium
- summary: "The `step.committing` fixture was authored, not recorded from a real `claude -p` call."
  evidence: "`tests/contracts.round-trip.test.ts`'s own docblock describes these fixtures as captured
    once from a real invocation. This one satisfies the Zod parse, the draft-7 validation and the
    round-trip losslessly, but carries no evidence a model produced it, so the AD-31 claim is not yet
    honest for this contract. Needs a real recording."
  location: tests/fixtures/structured-output/step.committing.json
  severity: low
- summary: '`git_tag` remains in `WRITE_INTENT_KINDS` with nothing composing one.'
  evidence: 'Pre-existing and unchanged by this story; noted so it stays a known gap rather than being
    rediscovered as a surprise.'
  severity: low
- summary: 'There is still no production assembly point for a run.'
  evidence: 'Carried forward from story 2-6. Nothing under `src/` or `bin/` constructs a `Reconciler`
    with a real spawner, runner, recorder and now committer. This story adds a third unit whose
    acceptance criteria are asserted one level down from an actual run, and still no story in
    `stories.yaml` owns the composition root.'
  severity: high
---

# Story 2-7 — Committer: branch naming, pull request, git note

## Intent

**Problem:** stage 1's gate was amended to move its git half here, on the grounds that AD-22 makes the
committer the git note's only writer and stage 1 had nothing that merges. That half is still unbuilt:
`grep` for `refs/notes` across `src/` returns nothing. `branch_pattern` is interviewed and written into the
profile and read by no unit. `committing` is a declared agent with no phase, so nothing can spawn it. And
`WRITE_INTENT_KINDS` already names `git_push`, `pull_request`, `git_note` and `git_tag` with nothing
composing one.

**Approach:** give the committer its phase and contract, make the note a versioned artifact per AD-22, read
the branch pattern from the profile as its sole authority, and compose the write intents the engine will
execute. **The executor itself is story 2-11's** — this story produces intents, it does not perform them.

## Boundaries & Constraints

**This story composes write intents; it does not execute them.** AD-15 is explicit that agents never write
and the engine executes an enumerated surface, and story 2-11 owns that executor along with the durability
rule that a `write.attempted` record carrying the idempotency key is durable *before* the call is made. So
nothing here pushes, opens a pull request or writes a note. The observable is the intents produced and the
note *shape* — which means every acceptance criterion in this story is about a value, not an effect, and that
limit should be stated rather than discovered.

**The note's content comes from the run's record, never from the model.** AD-22 requires the note to carry
the run id, the ordered step list with dispositions, the acceptance criteria, usage totals and the decisions
taken. Every one of those is a fact the engine already holds in `events.jsonl` and `state.json`. Story 2-6
learned this the hard way: a contract that required the model to report gate facts the engine had and
withheld was an invitation to invent them. The committing agent composes prose — a pull-request body — and
the engine supplies the record.

**The note is a versioned artifact, and after ADR-005 it carries its own version.** AD-22 says "the note
shape is a versioned contract". It advances independently of the profile and of `state.json`, because a note
written last month must stay readable when the profile gains a field.

**Force-push must be structurally impossible, not merely forbidden.** The invoke note says force-push is
never permitted. A `git_push` intent with a `force: true` field that the executor is trusted to refuse is the
weaker design; a shape with no way to express a force is the stronger one. This is the same choice story
2-6 made for the command runner, where an arbitrary command is inexpressible rather than refused.

**The committer is the only unit that names a branch, and one unit already respects that deliberately.**
`src/runtime/branches.ts`'s `takeoverBranchFor` is keyed on the run id, and its docblock says it "cannot
collide with, or pre-empt, the `feature/<slug>` branch the committer will" create. That separation exists
and must survive: the guard this story adds is that **no unit other than the committer derives a branch name
from a feature slug**, and it must not fire on the takeover branch, which derives from a run id instead.

**Branch protection is asserted at run start, and must degrade honestly.** The invoke note requires it. A
repository with no remote, or a host the engine cannot query, cannot be asserted against — and the honest
answer is to say the assertion could not be made, not to report it as satisfied. An unverifiable protection
reported as verified is worse than one reported as unknown.

**`committing` has no command tool and no edit tools.** ADR-003 removed `Bash` from it before ADR-004
removed `Bash` from everything, on the grounds that AD-15 makes pull-request creation an engine-executed
write intent that no agent may perform. It is not granted the command runner either: it runs no gate.

## I/O & Edge-Case Matrix

| # | Input / situation | Expected |
|---|---|---|
| 1 | `STEP_PHASES` | Carries `committing`, and the standard plan ends with it |
| 2 | A registered `step.committing` | Resolves, exports to draft-7, and is distinct from every other step contract |
| 3 | The roster | `committing` declares `step.committing` |
| 4 | `committing`'s grant | No `Bash`, no `Write`/`Edit`, and not the command runner |
| 5 | The git note contract | Versioned independently, and carries run id, ordered steps with dispositions, acceptance criteria, usage totals and decisions |
| 6 | A note read at a version this build does not know | Refused with `config.schema_version_unrecognised` |
| 7 | The note's step list | Comes from the run's record, not from the model's output |
| 8 | A committing output attempting to state a step disposition | Refused: the model composes prose, the engine supplies the record |
| 9 | The branch name | Derived from the profile's `branch_pattern`, defaulting to `feature/<feature-slug>` |
| 10 | A `branch_pattern` naming no slug placeholder | Refused: a pattern that cannot vary produces one branch for every feature |
| 11 | Any unit other than the committer | Derives no branch name from a feature slug, checked by a guard that recurses |
| 12 | `takeoverBranchFor` | Unaffected: it derives from a run id, and the guard must not fire on it |
| 13 | A composed `git_push` intent | Has no way to express a force; the shape cannot carry one |
| 14 | A composed `pull_request` intent | Names the branch the committer named, never one inferred elsewhere |
| 15 | A composed `git_note` intent | Names the single AD-22 ref, and the committer is its only composer |
| 16 | Branch protection on the default branch, at run start | Asserted, and a repository where it cannot be checked reports *unknown* rather than satisfied |
| 17 | A run whose default branch is unprotected | Refused at run start, naming the branch and what to change |
| 18 | The intents a committing step produces | Carry an `intent_id` that, with the run id, is AD-15's idempotency key |
| 19 | The same committing step run twice | Produces the same `intent_id`s, so 2-11's executor can recognise the repeat |
| 20 | The engine's source | Performs no push, no pull-request creation and no note write — those are 2-11's |

## Code Map

| File | Change | Why |
|---|---|---|
| `src/contracts/committing.ts` | new | `step.committing`'s output: the pull-request prose and the composed intents. AD-2. |
| `src/contracts/note.ts` | new | The AD-22 git note as a versioned artifact, with its own version per ADR-005. |
| `src/contracts/registry.ts` | modify | Register both. |
| `src/contracts/state.ts` | modify | `STEP_PHASES` gains `committing`. |
| `src/contracts/step.ts` | modify | The `git_push` intent shape carries no force. |
| `src/engine/committer.ts` | new | Branch naming from the profile, and the composition of the three intents from the run's record. |
| `src/engine/protection.ts` | new | The run-start branch-protection assertion, with an honest unknown. |
| `src/engine/reconciler.ts` | modify | The standard plan gains the committing step; protection asserted at run start. |
| `src/installer/interview.ts` | modify | `committing` declares its contract. |
| `tests/contracts.committing.test.ts` | new | Matrix 2, 7, 8, 13–15, 18, 19. |
| `tests/contracts.note.test.ts` | new | Matrix 5, 6. |
| `tests/engine.committer.test.ts` | new | Matrix 9–12, and the recursive branch-naming guard. |
| `tests/engine.protection.test.ts` | new | Matrix 16, 17, 20. |

## Tasks & Acceptance

1. **Give the committer its phase and contract.**
   - **Given** `STEP_PHASES`, **when** it is read, **then** it carries `committing` and the standard plan
     ends with that step.
   - **Given** the roster, **when** `committing` is read, **then** it declares `step.committing` and is
     granted no command tool and no edit tools.
2. **Make the note a versioned record of what the run did.**
   - **Given** the note contract, **when** it is read, **then** it carries the run id, the ordered steps with
     dispositions, the acceptance criteria, usage totals and the decisions taken, at its own version.
   - **Given** a note at a version this build does not know, **when** it is read, **then** it is refused with
     `config.schema_version_unrecognised`.
   - **Given** a committing output stating a step disposition, **when** it is parsed, **then** it is refused:
     the engine supplies the record and the model composes prose.
3. **Name the branch from the profile, and nowhere else.**
   - **Given** a profile's `branch_pattern`, **when** the committer names a branch, **then** it uses that
     pattern, defaulting to `feature/<feature-slug>`.
   - **Given** a pattern with no slug placeholder, **when** it is read, **then** it is refused.
   - **Given** the source of every unit other than the committer, **when** it is inspected recursively,
     **then** none derives a branch name from a feature slug, and the run-id-keyed takeover branch does not
     trip the guard.
4. **Compose intents that cannot force-push.**
   - **Given** the `git_push` intent shape, **when** it is inspected, **then** there is no field through
     which a force can be expressed.
   - **Given** a committing step, **when** it produces intents, **then** each carries an `intent_id` that with
     the run id forms AD-15's idempotency key, and a re-run produces the same ids.
   - **Given** the engine's source, **when** it is inspected, **then** it performs no push, pull-request
     creation or note write — those belong to story 2-11.
5. **Assert branch protection at run start, honestly.**
   - **Given** a repository whose default branch is unprotected, **when** a run starts, **then** it is
     refused naming the branch and what to change.
   - **Given** a repository where protection cannot be checked, **when** a run starts, **then** the result is
     *unknown* and is reported as unknown, never as satisfied.

## Spec Change Log

## Review Triage Log

## Design Notes

## Verification

Run by me, exit status captured to a variable and output kept in a file:
`npm run typecheck && npm run lint && npm run build && npm test` — **exit 0, 2470 tests across 83 files, zero
failures, zero skips.** Baseline `ea21995` was 2366/79. Node pinned to v24.21.0.

Eight mutations, each applied, run and reverted, tree confirmed clean afterwards:

| Mutation | Caught by |
|---|---|
| A committing output states a step disposition | 4 tests |
| `WriteIntentSchema` gains a `force` field | 3 direct + 5 collateral in the composition suite |
| A branch name derived from a feature slug planted in `src/tui/cards/caption.ts` | the recursive guard, naming the file and the evidence |
| `intentIdFor` incremented a module counter | the re-run test — the **second** composition failed, not the first |
| `unknown()` protection returns `'protected'` | 7 tests across both files |
| The no-placeholder refusal in `branchFor` bypassed | 4 tests, twice (weak and strong variants) |
| `NOTE_SCHEMA_VERSION` advanced to 2 | the note test, while `state.json` at its own version still read |
| A `git push` planted outside the committer, in `src/engine/labels.ts` | the write-surface guard |

**Verified by me directly, not taken on report.** `'feature/<feature-slug>'.includes('<slug>')` is `false` —
AD-22's own canonical default would have been refused by the installer's original validation. `.strict()` on
`WriteIntentSchema` refuses a `force` field with a corrected fixture (my first probe used the wrong field
names and proved nothing). `GitNoteSchema` refuses v2 specifically on version — the issue names version,
not shape — while `RunStateSchema` at its own version fails purely on missing fields, confirming the two
artifacts' versions are independent per ADR-005. The branch-naming guard has a positive control proving it is
not blind to the committer's own derivation, so its absence-of-findings elsewhere is evidence rather than a
guard that cannot see anything.

## Auto Run Result

**Status: done.** The committer has its phase and contract, the note is a versioned record of what the run
did rather than what the model claims, the branch name comes from one place, and force-push has no field to
carry it in.

**A defect in the shipped baseline was found and fixed, not introduced.** `WriteIntentSchema` had no `force`
field, but an intent *carrying* one silently lost it: plain `z.object` strips unknown keys while the same
schema's draft-7 export already declared `additionalProperties: false` — two halves of one contract
disagreeing about the exact field the shape exists not to have. `.strict()` closes both sides at once.

**AD-22's own stated default did not survive contact with the installer that must write it.** The
architecture record says the branch pattern defaults to `feature/<feature-slug>`; the installer's existing
default and validation used `<slug>`, and the substring check the two disagree on is not a stylistic
nit — it is whether the architecture's own example passes its own validation. Verified directly rather than
argued. Resolved non-breakingly by accepting both spellings; recorded as a spec-level choice if a narrower
resolution is wanted.

**One policy call is the implementer's, stated plainly rather than hidden in behaviour.** The story requires
`unknown` branch protection to be *reported* as unknown; it does not say whether it *blocks*. The
implementation continues on unknown and refuses only `unprotected`, on the grounds that refusing every
repository the engine cannot reach would stop an offline machine running at all. That is a real judgement,
recorded in the module's own docblock rather than discovered later — and it is a deferred entry here so it
gets a second look rather than shipping silently.

**Follow-up review recommended: true.** No review layer has run. The specific unverified risk is compounding:
no host probe for branch protection exists, so every shipped run today records `unknown`, and the
`step.committing` fixture was hand-authored rather than recorded from a real `claude -p` call — the AD-31
claim is not yet honest for this one contract.

**Residual risks.** Six deferred entries, two `high`: no review layer has run, and the production assembly
gap now spans a third unit. The committer composes correctly and executes nothing, which is exactly this
story's boundary — but it means stage 2 now has an analysis agent, a planning agent, an implementation agent,
a testing/verification pair and a committer, none of which has ever been assembled into one running loop.
