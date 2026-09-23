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
- summary: 'Review pass 1 ran all four layers; 21 patches applied and three bad_spec causes decided with the user.'
  evidence: '31 findings — high 6, medium 14, low 10, false 1 — routed 21 patch, 4 bad_spec, 2 defer, 4
    reject. Three of the four bad_spec causes required a decision only the user could make: which of two
    contradictory branch-protection implementations was correct (fail closed, deleting the one this
    story had built), whether to wire composeCommit now rather than defer it, and how to resolve two
    intent clauses this spec had left with no representation at all. All three were decided and
    implemented, not deferred.'
  severity: low
- summary: 'An engine with no branch-protection port wired continues rather than refusing.'
  evidence: 'Distinguishes "asked about a repository and could not verify it" (now refuses, per the
    user''s decision) from "nothing is asking at all" (BRANCH_PROTECTION_UNASSERTED, continues). Making
    the second case refuse too would break every one of the roughly 46 Reconciler.open call sites across
    20 test files that supply no port, which is the same "no production assembly point" gap already
    carried as a high deferred entry across stories 2-4 through 2-7. Not a new fail-open hole; the same
    known one, now named precisely at this call site.'
  location: src/engine/reconciler.ts
  severity: high
- summary: 'There is still no production assembly point for a run.'
  evidence: 'Carried forward, now spanning a fourth unit. Nothing under `src/` or `bin/` constructs a
    Reconciler with a real spawner, runner, recorder, committer and a wired branch-protection port. This
    story''s own composeCommit wiring makes the composition reachable from a real pass for the first time
    — but only once something supplies the port and the assembly this deferred entry has named since
    story 2-4.'
  severity: high
- summary: 'No host probe for branch protection exists yet, so every shipped run today records unknown or unasserted.'
  evidence: 'Carried from the first implementation pass, now against the surviving module:
    `checkDefaultBranchProtection`''s probe needs a host credential, which AD-13 puts behind the fetch
    record and AD-15 behind the write surface. The assertion, its three outcomes and its refusal are all
    live and tested; what is absent is the caller that supplies a real probe.'
  location: src/container/lifecycle.ts
  severity: medium
- summary: "The `step.committing` fixture was authored, not recorded from a real `claude -p` call."
  evidence: "Carried from the first pass, unchanged by this round. The fixture satisfies the Zod parse,
    the draft-7 validation and the round-trip losslessly, but carries no evidence a model produced it, so
    the AD-31 claim is not yet honest for this one contract."
  location: tests/fixtures/structured-output/step.committing.json
  severity: low
- summary: '`git_tag` remains in `WRITE_INTENT_KINDS` with nothing composing one.'
  evidence: 'Pre-existing and unchanged; noted so it stays a known gap rather than a surprise.'
  severity: low
- summary: '`WriteIntentSchema.strict()` could refuse a previously-accepted stored intent carrying a sixth field on resume.'
  evidence: 'Real in principle. There is no production data yet for it to affect, since nothing has
    assembled a run that writes one — the same assembly gap this story keeps meeting from a different
    angle.'
  severity: low
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
| 21 | The branch-protection port `src/container/lifecycle.ts` already declares | Is the run-start assertion; `src/engine/protection.ts` is deleted rather than living beside it |
| 22 | A branch reporting `protected: true, forcePushDisabled: false` | Refused: protection that permits force-push is not the protection ADR-001 asks for |
| 23 | A repository whose protection cannot be checked | Refused, the same as `unprotected` — reversed from this story's original text, which asked for `unknown` to continue |
| 24 | A repository whose `refs/remotes/origin/HEAD` names a real default branch | The short branch name is read and asserted against, not the full ref |
| 25 | An interview answer of `feature/<feature-slug>` | Accepted and written to the profile, asserted through the interview itself, not only through `branchFor` |
| 26 | A completed committing step | The reconciler calls `composeCommit` with the run's record and the parsed output, the way a completed analysis step's territory is recorded |
| 27 | The composed commit, once produced | Held where story 2-11's executor can find it — an event, or a field on the termination — not dropped after the call |
| 28 | The pull-request plan | Carries no identity field of its own; AD-1 already asserts subscription authentication at startup, and the executor pushes under whatever git identity the host process holds |
| 29 | The note, once composed | Its composition is stated to happen at the committing step, before any merge exists, and the note's `target` is the single AD-22 ref rather than a commit-ish; the note becomes durable only once the executor writes it to that ref on the merge commit — the binding to a specific commit is the executor's, not this story's, and this row states that rather than leaving it silent |
| 30 | `assertBranchProtection` throwing for `unprotected` | An event is emitted before the throw, so the one outcome that stops a run is the one outcome always recorded |
| 31 | A run refused at its branch-protection check | Leaves no half-created run behind: the directory is either cleaned up or marked abandoned, never left with events but no checkpoint |

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
| `src/container/lifecycle.ts` | modify | Becomes the one branch-protection implementation; gains the `unknown`-outcome vocabulary this story needs. |
| `src/engine/protection.ts` | delete | Superseded by the container port; two implementations of one concern is the defect this amendment closes. |
| `tests/container.wrapper.test.ts` | modify | Extended with the `unknown` outcome and the reconciler-level wiring, rather than pinning a policy the run-start path no longer uses. |
| `tests/engine.protection.test.ts` | delete | Superseded; its cases move to `tests/container.wrapper.test.ts` or a renamed file beside it. |

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

### 2026-09-23 — amended by review pass 1 (four `bad_spec` root causes, decided with the user)

**Triggering findings.** BH3 / VG3 — a second, contradictory branch-protection implementation already existed
in `src/container/lifecycle.ts`, explicitly commented "belongs to the committer story (2-7)", with the
opposite policy (fail closed on no probe) and a richer probe type this story's new module could not even
express. BH10 / IA2's actionable half — nothing calls `composeCommit` when a committing step completes,
the same shape as story 2-4's original `recordDeclaredTerritory` gap. IA1 — "under the user's own git
identity" and "on the merge commit" had zero representation anywhere.

**Decided with the user, not assumed.** (1) The existing fail-closed implementation is correct; the new
module is deleted and `container/lifecycle.ts` becomes the one run-start assertion, with `unknown` now
refusing the run like `unprotected` does — reversing this story's own original Boundaries line, which asked
for `unknown` to continue. (2) The reconciler wiring is added now, following the 2-4 precedent exactly,
rather than deferred alongside the wider assembly gap. (3) Both the identity and merge-commit clauses are
resolved now: identity is stated as AD-1's concern, not this story's — the PR plan carries no field for it;
the merge-commit binding is stated as the executor's, since nothing before a merge exists to bind to.

**What was amended.** Matrix rows 21–31. The Code Map drops `src/engine/protection.ts` and
`tests/engine.protection.test.ts` entirely and modifies `src/container/lifecycle.ts` and
`tests/container.wrapper.test.ts` in their place — this is a net deletion of a whole module, not an addition.

**The known-bad state avoided.** Two implementations of ADR-001's branch-protection assertion, live at once,
disagreeing about the one thing that matters — whether "we could not check" and "it is not protected" have
the same consequence — with the weaker one wired to the path that actually runs and the stronger one
reachable only from its own test. And a story whose title names an active unit while nothing calls the
functions that compose its output.

**KEEP instructions — what worked and must survive.** (1) `.strict()` on `WriteIntentSchema` and
`CommittingOutputSchema`, and the fixed silent-key-stripping defect it closes. (2) The recursive
branch-naming guard, its positive control, and its exemption for `takeoverBranchFor`. (3) The AD-22
placeholder widening (`BRANCH_SLUG_PLACEHOLDERS`), now also asserted through the interview per row 25. (4)
The note's independent `schema_version`. (5) `intent_id` derived from what the intent is, never from a
clock, counter or randomness. (6) The write-surface guard proving the engine performs no push, pull-request
creation or note write.


## Review Triage Log

### 2026-09-23 — Review pass
- verdicts: 31 findings — high 6, medium 14, low 10, false 1, maybe-false 0
- findings:
  - `[high]` `[patch]` BH1 — the one outcome that stops a run is never recorded. Verified: `assertBranchProtection` is called inline in the assignment at `reconciler.ts:1266-1268`; if it throws for `unprotected`, execution never reaches the `emit` call two lines below. `protected` and `unknown` get a log line; the refusal — the case a person most needs explained — gets none.
  - `[high]` `[patch]` BH2 — a refused run is left half-created. `checkpointFromLog` (which writes `state.json`) runs only at the method's return, after the throw point, so a refused run's directory holds events but no checkpoint and its recorder stays registered. Corroborated by VG's independent trace of the same ordering and its claim that the next reconcile pass would reload it as drafting.
  - `[high]` `[bad_spec]` BH3 — a second, contradictory branch-protection implementation already exists. Verified: `src/container/lifecycle.ts` exports `BranchProtection`, `detectDefaultBranch`, `assertDefaultBranchProtected`, commented "Implementations belong to the committer story (2-7)" — and its policy is the opposite of the new module's: no probe means unverified, and unverified fails closed ("the same direction AD-21"). The new `src/engine/protection.ts` fails open on the identical condition. Neither module mentions the other.
  - `[medium]` `[defer]` BH4 — no probe ships, so the assertion can never pass in production. Already recorded as a deferred entry by the implementer; corroborated independently. Subsumed in part by BH3's resolution, since the existing `lifecycle.ts` implementation already has a working `detectDefaultBranch` this module could have used.
  - `[medium]` `[patch]` BH5 — the `branch.protection_asserted` line reaches no rendering surface, so the `unknown` outcome the module exists to make sayable stays invisible on every surface a person actually looks at.
  - `[medium]` `[patch]` BH6 — `composeCommit` trusts the prose it is handed: `pull_request.title` is untrimmed while the trimmed value is used only in the intent's own summary, so a blank or multi-line title (both refused by the contract) can still reach `PullRequestPlan` from any caller but the spawn path.
  - `[medium]` `[patch]` BH7 — the branch pattern itself is validated only for a placeholder, not for git-ref safety: `feature/../<slug>`, a leading `-`, spaces, `~^:?*`, `//` and a `.lock` tail all pass and reach `git`'s argv. `ProjectProfile.branch_pattern` is a bare `z.string()` in the same file that now exports the validator, so the profile parse — the natural third place to catch this — doesn't either.
  - `[medium]` `[patch]` BH8 — `GitNoteSchema` guards four fields and leaves two open: `acceptance_criteria` accepts `[]` or blank strings, using the same "makes every per-item rule pass vacuously" argument the file already applies to `steps`; and `usage`'s `.describe()` promises "never a zeroed record" with no refinement enforcing it.
  - `[medium]` `[patch]` BH9 — `WriteIntentSchema`'s new `.describe()`s promise "never blank" for `target` and `summary` with no refinement enforcing either, so `target: ''` parses — an intent to push to nothing — in the same change that hardened the shape against a `force` field.
  - `[high]` `[bad_spec]` BH10 — nothing consumes the committing step. Verified independently three ways: `composeCommit`/`branchFor`/`noteFor` have zero callers outside their own file and outside tests; the standard plan now spawns a committing agent and parses its output; nothing calls the composition with that output. The unit named in the story title is reachable only from its own unit tests.
  - `[medium]` `[patch]` BH11 — `defaultBranch()` assumes the remote is named `origin` while `BranchProtectionRequest.remote` is an arbitrary string, so the reported reason can name a branch read from a different remote than the one actually asserted against, and the existing `init.defaultBranch` fallback is lost, making `unknown` more common than necessary.
  - `[low]` `[patch]` BH12 — `stripComments` is copy-pasted into three test files rather than shared, and `performedWritesIn` matches any quoted `'push'`/`'notes'`/`'tag'` literal anywhere under `src/` regardless of meaning — a guard likely to be weakened rather than obeyed, which is the failure its own docblock warns about.
  - `[low]` `[patch]` EC1 — a probe returning `undefined` rather than `null` is refused as unprotected instead of read as unknown, because only `null` is treated as the unknown case.
  - `[medium]` `[patch]` EC2 — no deadline on the protection probe: a hanging synchronous call blocks `acceptFeature` indefinitely with no diagnosis.
  - `[medium]` `[patch]` EC3 — one engine-wide `branchProtection` value serves every run regardless of which registered project it belongs to, so a feature in project B can be asserted against project A's repository.
  - `[low]` `[patch]` EC4 — `UnsafePathSegmentError` from an unsafe feature slug carries no AD-35 code, so a caller routing on `error.code` hits the unknown-code fallback instead of `config.invalid`.
  - `[medium]` `[patch]` EC5 — a malformed `GitNoteSchema` candidate raises a raw `ZodError` out of `composeCommit` with no code and no run context.
  - `[low]` `[patch]` EC6 — the committing contract's line-break refusal misses `U+2028`/`U+2029`, so a title carrying one still reaches a host that may silently truncate it.
  - `[medium]` `[patch]` EC7 — the committing phase reverts `targetStateFor` to `'running'` after verification's `'verifying'`. Verified: `targetStateFor` returns `'verifying'` only for the verification phase and `'running'` for every other, so a run's final step goes verifying → running again, and any surface keying off that transition can misread it.
  - `[low]` `[defer]` EC8 — `WriteIntentSchema.strict()` could refuse a previously-accepted stored intent carrying a sixth field on resume. Real in principle; there is no production data yet for it to affect, since nothing has assembled a run that writes one.
  - `[false]` `[reject]` EC9 — claim that repositories installed before this story keep a stale `committing.toml` naming `step.output` with no migration path. Refuted: `writeInstall` calls `writeFileIfChanged` for every built-in agent file on every init, the same re-render-on-upgrade pattern story 2-6 established and story 2-6's review already settled.
  - `[medium]` `[patch]` VG1 — same root cause as BH2, corroborated independently: the refused run's on-disk state and recorder lifecycle after the throw are untested.
  - `[low]` `[reject]` VG2 — that a synchronous probe hanging is a defect distinct from EC2. Folded into EC2 as one finding, not two.
  - `[high]` `[bad_spec]` IA1 — two of the intent's explicit clauses have zero representation on any surface. Verified directly: no code or comment anywhere in the new files mentions git author/committer identity, and `GitNoteSchema`/the `git_note` intent's `target` is the ref string alone — "on the merge commit" appears only in prose, never as a field anything binds to. My own spec's matrix and tasks never named either requirement.
  - `[low]` `[reject]` IA2 — that the diff implements composition/values rather than an effectful unit. Descriptive, and the scoping is a deliberate, stated decision in this story's own Boundaries (2-11 owns execution) — the same accepted pattern stories 2-4 through 2-6 used while their own assembly gaps were still open. Not routed as a defect; its concrete, actionable half is BH10.
  - `[low]` `[reject]` IA3 — that `.strict()` on `WriteIntentSchema` is scope beyond the intent, affecting every agent. True and deliberate: the same field, the same contract, one correctness fix rather than two. No action.
  - `[high]` `[bad_spec]` VG3 — the new run-start assertion neither adopts nor retires the existing fail-closed one, and it is structurally weaker: its probe type is `(query) => boolean | null`, which cannot express `forcePushDisabled`/`deletionDisabled` at all, while the container port's suite already refuses a branch reporting `protected: true, forcePushDisabled: false`. Same root cause as BH3; corroborates and sharpens it with a capability gap, not only a policy disagreement.
  - `[medium]` `[patch]` VG4 — `defaultBranch()`'s happy path is exercised by no test: every case in `tests/engine.protection.test.ts` either supplies an explicit branch or hits the already-covered "no default branch" case, so the prefix-strip logic that turns `refs/remotes/origin/HEAD` into a short branch name has never been asked to run against a repository that has one.
  - `[medium]` `[patch]` VG5 — the interview's newly widened placeholder acceptance is exercised by no installer test: every existing `branch_pattern` case types the `<slug>` spelling, and the refusal assertion's substring check happens to still pass under the new message, so a revert of the widening would leave every installer test green while a person typing AD-22's own stated default (`<feature-slug>`) is refused and re-asked forever.
  - `[low]` `[patch]` VG6 — `reconciler.ts`'s terminal `committed` transition still tells a person "Opening the pull request is the committer's work in story 2-7", stale now that 2-7 has landed and the pull request belongs to 2-11.
  - `[low]` `[patch]` VG7 — `CommittingOutputSchema`'s `pull_request_body` field describes the run's cost as something "this step is not told", but `StepInputSchema` hands every step `budget.rate_limit_budget_consumed` — the instruction is a shade weaker than what is actually true.

- actions taken, per root cause (every `patch` and `bad_spec` row resolves to one of these):
  - **A — one branch-protection implementation** (BH3, VG3, BH11, VG4; `bad_spec`, decided with the user). `src/engine/protection.ts` and `tests/engine.protection.test.ts` deleted. `src/container/lifecycle.ts` gained a non-throwing `checkDefaultBranchProtection` beside the existing throwing `assertDefaultBranchProtected`; the three-outcome vocabulary lives in `src/contracts/event.ts` so both `src/engine/` and `src/container/` may read it under the dependency guard. `detectDefaultBranch` takes the remote name as a parameter rather than assuming `origin`. Verified independently: both files confirmed deleted; a real-repository test covers the prefix-strip happy path. One boundary drawn by the implementer and accepted by me rather than re-litigated: an engine with **no** assertion port wired records `BRANCH_PROTECTION_UNASSERTED` and continues, distinct from a repository that was asked about and could not be verified (which now refuses) — the same "no production assembly point" gap already carried as a `high` deferred entry across three stories, not a new fail-open hole.
  - **B — `composeCommit` wired** (BH10, IA2's actionable half; `bad_spec`, amended into matrix 26–27). `recordComposedCommit` runs beside `recordDeclaredTerritory` on a completed step, discriminated by a `composedProseIn` check on the output rather than by phase — the same idiom, so a later contract that also composes prose is covered without a second special case. The composition is written to `runs/<run-id>/commit/composed.json` rather than into the payload, because the note carries the run's own ULID and AD-21's redaction sweep would rewrite it wherever it appears in an event payload. Verified non-vacuous myself: disabling the call fails 2 tests.
  - **C — both intent clauses stated** (IA1; `bad_spec`, amended into matrix 28–29). `PullRequestPlan` carries no identity field, with the reason recorded in `committer.ts`: a field here could only disagree with the git identity the executor actually uses. `note.ts` states the note is composed before any merge commit exists, so its target is the AD-22 ref rather than a commit-ish; the binding to a specific commit is the executor's. Both statements verified present in the contract prose, not only in the spec.
  - **D — ordering and the half-created run** (BH1, BH2, VG1). The `branch.protection_asserted` event is now emitted before the outcome is acted on — the whole reason the port reports rather than throws. A refusal now writes `feature.state_changed` → `killed` and a checkpoint before the throw escapes, so the run's events (the record of why it refused) survive but the next pass cannot reload it as an ordinary drafting run.
  - **E — contract completeness** (BH8, BH9, EC5/EC-adjacent, BH6, BH7, EC4). `GitNoteSchema` refuses an empty or blank `acceptance_criteria` and a usage record whose fields are all null rather than absent — verified both directions myself, including the distinction between `usage: null` (still accepted) and all-null sub-fields (now refused), which is the one this project keeps needing to get right. `WriteIntentSchema` enforces its own "never blank" promises for `target` and `summary` — verified. `composeCommit` trims once and uses the trimmed value everywhere. `branchPatternProblem` (a `git check-ref-format --branch` subset) applies at the interview, the profile schema and `branchFor`, deliberately still allowing `<`/`>` since git permits them and the placeholder is spelled with them. Unsafe-slug and malformed-note errors both now carry `config.invalid`.
  - **F — smaller items** (VG5, EC7, EC6, BH12, IA3-adjacent). The widened placeholder acceptance is now exercised through the interview itself. The committing/verifying/running state question was answered rather than patched around: there is no `committing` feature state, and `running` is correct for it — a committing step is work in progress like any other. `U+2028`/`U+2029` added to the line-break refusal. The triplicated `stripComments` helper moved to `tests/helpers/`. `performedWritesIn` narrowed to match a subcommand only inside a process-invocation argv window, with negative controls proving it no longer fires on an unrelated label array or a `git worktree add`. The stale "story 2-7" comment and the `pull_request_body` cost-claim both corrected.

## Design Notes

## Verification

Run by me after the patch round, exit status captured to a variable and output kept in a file:
`npm run typecheck && npm run lint && npm run build && npm test` — **exit 0, 2486 tests across 82 files, zero
failures, zero skips.** Baseline `ea21995` was 2366/79; the implementation reached 2470/83 and the review's
patches took it to 2486/82 — net **one fewer file**, because `src/engine/protection.ts` and its whole test
file were deleted, not merely edited.

**Verified by me directly, not taken on report, with a positive control first in every probe.** My first
`GitNoteSchema` fixture used the wrong `usage` field names entirely and failed to parse at all; corrected,
the control parses. My second attempt at the "zeroed usage" refusal used all-`0` sub-fields, which the
schema correctly *accepts* — a `0` is a real measurement, not an absent one. The refusal is specifically
about all-`null` sub-fields, and `usage: null` (whole-field absence) stays accepted throughout — the precise
distinction the field's own `.describe()` states. Once corrected: `GitNoteSchema` refuses an empty and a
blank `acceptance_criteria`, and refuses all-null usage while accepting whole-field absence.
`WriteIntentSchema` refuses a blank `target`. Both files confirmed deleted (`src/engine/protection.ts`,
`tests/engine.protection.test.ts`). `BRANCH_PROTECTION_UNASSERTED` exists at the one call site that reads it.
`PullRequestPlan`'s no-identity reasoning and the note's before-any-merge-commit reasoning are both present
in the contract prose, not only in the spec. And I mutated `recordComposedCommit`'s call site directly:
disabling it fails 2 tests, confirming the wiring is not vacuous.

## Auto Run Result

**Status: done, reviewed.** The committer composes a branch name, a note and write intents from the run's own
record; a single branch-protection assertion — the one that already existed, fail-closed — gates run start;
and the composition is reachable from a real reconciler pass for the first time.

**Review findings: 31 across four layers** — high 6, medium 14, low 10, false 1. Routed 21 patch, 4 bad_spec,
2 defer, 4 reject. All 21 patches applied; three of the four bad_spec causes were decided with the user
because they were not implementation choices.

**The largest finding was a duplicate architecture, not a code defect.** `src/container/lifecycle.ts` already
had a working branch-protection assertion, commented "belongs to the committer story (2-7)", built with the
opposite policy of what this story shipped: no probe means unverified, and unverified fails **closed**, on
grounds citing AD-21's fail-closed direction directly. The new module failed open on the identical condition
and could not even express the two dimensions (`forcePushDisabled`, `deletionDisabled`) the old one already
refused a branch for. Decided with the user: the existing implementation is correct. The new module and its
whole test file are deleted; the vocabulary that both `src/engine/` and `src/container/` need to share now
lives in `src/contracts/event.ts`, since the dependency guard forbids the engine importing the container
package directly.

**`composeCommit` was dead code, the same shape as story 2-4's original bug.** Nothing called it; the
standard plan spawned a committing agent and dropped its output. Wired in now, following the 2-4 precedent
rather than deferring it — decided with the user. The composition is written to disk rather than into an
event payload, because the note carries the run's own ULID and AD-21's redaction sweep rewrites an unbroken
ULID wherever it finds one in a payload.

**Two intent clauses had zero representation, and both are now stated rather than built.** "Under the user's
own git identity" is AD-1's concern, not this story's: the pull-request plan carries no identity field,
because a field here could only disagree with the git identity the executor actually uses when it pushes.
"On the merge commit" cannot be true of anything composed at the committing step, because no merge exists
yet — the note's target is the single AD-22 ref, and the binding to a specific commit is the executor's to
make. Both are decisions to state, and both are now stated in the contract prose a future reader will
actually meet.

**One boundary was the implementer's to draw, and I accepted it rather than re-litigating it.** An engine
handed no branch-protection port at all continues and records `BRANCH_PROTECTION_UNASSERTED`, distinct from a
repository that was checked and could not be verified (which now refuses). Refusing the unasserted case too
would break roughly 46 `Reconciler.open` call sites across 20 test files that supply no port — the same
"no production assembly point" gap this project has carried as a high-severity deferred entry since story
2-4, not a new hole this story opened.

**Follow-up review recommended: true.** A `high` was patched. The specific unverified risk: no host probe for
branch protection exists yet, so every shipped run today records either `unknown` or `unasserted` — the
assertion's three outcomes and its refusal are live and tested, but nothing has ever supplied it a real
answer.

**Residual risks.** Six deferred entries, two `high`. The production assembly gap now spans a fourth unit,
and this story's own wiring is what finally makes it visible end to end: analysis, planning, implementation,
testing/verification, and now a committer whose composition a real pass can reach — with nothing yet
assembling any of them into one running loop.
