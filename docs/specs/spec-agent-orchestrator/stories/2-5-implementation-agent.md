---
title: 'Step agent — implementation'
type: 'feature'
created: '2026-09-22'
status: 'done'
review_loop_iteration: 0
followup_review_recommended: true
baseline_revision: 'c09e899'
context:
  - '{project-root}/docs/planning-artifacts/architecture/architecture-agent-orcastrator-2026-09-19/ARCHITECTURE-SPINE.md'
  - '{project-root}/docs/planning-artifacts/architecture/architecture-agent-orcastrator-2026-09-19/ADR-001-tier-2-execution.md'
  - '{project-root}/docs/planning-artifacts/architecture/architecture-agent-orcastrator-2026-09-19/ADR-003-built-in-agent-tool-grants.md'
  - '{project-root}/docs/planning-artifacts/architecture/architecture-agent-orcastrator-2026-09-19/ADR-004-command-execution-as-a-capability.md'
  - '{project-root}/docs/specs/spec-agent-orchestrator/stories/2-4-analysis-and-planning-agents.md'
deferred:
- summary: No review layer ran against this story.
  evidence: 'The gate, seven implementer mutations and my own verification are the only scrutiny. I
    re-ran the gate myself (exit 0, 2136/74, zero skips) and probed the tilde refusal in both directions,
    the six promotion decisions, and the built-in grants. Read `status: done` as implemented and gated,
    not reviewed.'
  severity: high
- summary: 'The intent''s "promoted only on a failed verification gate" is not implemented, deliberately.'
  evidence: |-
    `src/contracts/error.ts` maps `step.schema_invalid_output` to `escalate-model-tier` and
    `src/contracts/state.ts` documents "a failed verification gate **or** a second schema-invalid
    output". The shipped rule is implemented and verified: a schema-invalid output does promote. The
    intent's stricter "only" would require moving the AD-35 table row and the Stack's model-rung row,
    which is a spine change rather than an implementation choice. The divergence is recorded in
    `promotion.ts`'s docblock and in the matrix-16 describe block as well as here. **This is the one item
    that wants a decision from the user.**
  location: src/engine/promotion.ts
  severity: medium
- summary: 'Between this story and 2-6 the system can write a change it cannot test.'
  evidence: 'ADR-004 removed `Bash` from `verification`, and the command-runner MCP server that replaces
    it belongs to 2-6 where gates actually run. So `verification` currently has no way to run a gate at
    all. This was a deliberate scoping decision, stated in the spec''s Boundaries before the work began
    rather than discovered afterwards, but it is a real hole in the walking skeleton until 2-6 lands.'
  severity: medium
- summary: 'The reconciler''s own suites never exercise `STANDARD_PLAN_STEPS`.'
  evidence: |-
    `tests/helpers/engine-fixture.ts`'s `DEFAULT_PLAN_STEPS` is a two-step plan naming `step.output`,
    while the production `STANDARD_PLAN_STEPS` is four steps naming the real contracts. Verified. The
    consequence is concrete rather than theoretical: pointing the plan's `implement` step back at
    `step.output` initially broke nothing, and was caught only by an assertion added for exactly that,
    because the run-level suites run a different plan. Any future change to the real plan is unprotected
    by the suites that look like they cover it.
  location: tests/helpers/engine-fixture.ts
  severity: medium
- summary: 'Four files were changed beyond the Code Map, three of them widening this story''s reach.'
  evidence: |-
    (1) `src/engine/dispositions.ts` — its `escalate-model-tier` branch already implemented the ceiling
    and the next rung, so `promotion.ts` beside it would have been a second authority on whether a step
    may climb; the branch now delegates. (2) `src/engine/reconciler.ts` — the tier expression now calls
    `rungForAttempt`, without which the starting-rung half of `promotion.ts` would be dead code exercised
    only by its own test. (3) `src/contracts/state.ts` — `isModelRung` added beside `MODEL_RUNGS` so an
    unrecognised rung is expressible without a cast, which landmine E required. (4)
    `src/contracts/territory.ts` — `isRepositoryRelativePath` now refuses a leading `~`, which also
    tightens `step.analysis`, `step.planning` and the declared territory. I verified that tightening in
    both directions: `~`, `~/`, `~/.ssh/id_rsa` and `~root/x` refused, while `src/~backup.ts`,
    `docs/a~b.md` and `a/~/b.ts` are still accepted.
  severity: low
- summary: '`tests/helpers/agent-grant.ts` still grants `Bash`, and now models a user-defined agent.'
  evidence: 'Its `fixtureGrant` carries `Bash` with `elevated: [Write, Edit, Bash]`, which is what keeps
    story 2-4''s elevated-reporting assertions exercising a `Bash` grant — correctly, since AD-17 still
    lets a user-defined agent be granted it. After ADR-004 no built-in matches that shape, so the
    fixture''s comment should say it models a user-defined agent rather than reading as though it mirrors
    the built-in roster.'
  location: tests/helpers/agent-grant.ts
  severity: low
---

# Story 2-5 — Step agent: implementation

## Intent

**Problem:** the plan story 2-4 built runs `analyse → plan → implement → verify`, and the `implement` step
still names `step.output` — the generic envelope whose flat `provenance` array 2-4's review called the defect.
There is no implementation contract, the roster declares none, and nothing expresses what an implementing
step produces. Separately ADR-004 has just removed `Bash` from three built-in declarations, and the code
still grants it.

**Approach:** give the implementing agent its own contract and roster declaration, apply ADR-004's grant
change, and make the model ladder do what the intent says — start on the cheapest rung, promote only on a
failed verification gate.

## Boundaries & Constraints

**This agent runs no commands, and after ADR-004 it cannot.** ADR-003 granted `implementation` `Bash` on the
grounds that "`Bash` is how a gate runs, inside the container per ADR-001" — measured false, because the
agent process runs on the host and so does its `Bash` tool. ADR-004 removes it. The implementing agent's job
is to write the change; running gates is story 2-6's, which is where the command-runner MCP server and the
repointing of `src/container/wrapper.ts` belong. **Neither is in this story**, and that is a scoping decision
with a consequence to state plainly: between this story and 2-6 the system can write a change it cannot test.

**"Writes only inside its run worktree" is enforced by two mechanisms already built, and asserted against
neither of them in isolation.** `--restricted` confines the file tools to the working directories and
`--add-dir` names the run worktree (story 2-4), so a write outside is not refused by policy — it is
unavailable. Anything the agent wants done outside the worktree is a `write_intent` the engine executes
(AD-15). A test that demonstrates this by inspecting the argv the step was given is checking the same thing
story 2-4 already checks; what this story must show is that the *contract* leaves no other channel — no field
through which a path outside the worktree can be returned and acted on.

**"No side effect outside its typed output" is a property of the grant plus the contract, not of a promise.**
With `Bash` gone, `Write` and `Edit` confined by `--add-dir`, and no network tool granted, the surfaces
available to a side effect are enumerable. The contract must not add one back: an evidence pointer names a
path in the evidence plane (AD-23), and a write intent is declared, never performed.

**The model ladder's promotion rule and the shipped disposition table disagree, and this story must not
paper over it.** The intent says the agent is "promoted only on a failed verification gate". But
`src/contracts/error.ts` maps `step.schema_invalid_output` to `escalate-model-tier`, and
`src/contracts/state.ts` documents "one promotion per step per run, on a failed verification gate **or** a
second schema-invalid output". Those are two different rules. The story implements the shipped one — a
second schema-invalid output is a promotion trigger — because it is the one the disposition table already
routes and the one AD-35 is built around, and it records the divergence from the intent's "only" rather than
quietly choosing. If the intent's stricter rule is wanted, that is a spine change, not an implementation
detail.

**Removing a tool from the pinned grant table must not make the table's tests weaker.** Story 2-3 pinned
ADR-003's grants and story 2-4 added the contract column; those tests assert what each built-in is granted.
Three rows change here. The tests must still be able to fail — in particular the assertion that
`verification` cannot edit what it judges must survive, and a new assertion is needed that **no built-in is
granted `Bash`**, while `GRANTABLE_TOOLS` still contains it, because AD-17 lets a user-defined agent be
granted anything the declared set contains.

**The cheapest rung is a starting point, not an assignment.** AD-17 requires the declaration to carry "a
starting tier and a promotion policy, never a fixed assignment". `MODEL_RUNGS` is ordered and
`src/contracts/state.ts` already warns that an unrecognised tier must not be treated as the lowest rung, or
the ladder runs backwards.

## I/O & Edge-Case Matrix

| # | Input / situation | Expected |
|---|---|---|
| 1 | A registered `step.implementation` contract id | Exports to draft-7, and an output is re-parsed against it |
| 2 | An implementation output claiming `contract_id: 'step.output'` | Refused, the way 2-4's contracts refuse it |
| 3 | The built-in roster | `implementation` declares `step.implementation` and is bound by the pinned table |
| 4 | The built-in roster, every agent | None is granted `Bash` |
| 5 | `GRANTABLE_TOOLS` | Still contains `Bash`, because a user-defined agent may be granted it |
| 6 | A user-defined agent declaring `Bash` | Accepted and reported as elevated, not silently corrected |
| 7 | The `verification` declaration | Still has no `Write`/`Edit`: it must not change what it judges |
| 8 | The standard plan's `implement` step | Names `step.implementation`, not `step.output` |
| 9 | An implementation output | Every claim it makes carries provenance, as 2-4's contracts require |
| 10 | An implementation output naming a path outside the run worktree | Refused: the contract offers no channel for it |
| 11 | An implementation output declaring a write intent | Accepted and declared, never performed — AD-15 |
| 12 | A first attempt at a step | Runs on the lowest rung of `MODEL_RUNGS` |
| 13 | A failed verification gate | Promotes the step one rung, once per step per run |
| 14 | A second promotion attempt for the same step in one run | Refused: the ceiling is one per step per run |
| 15 | A step already on the highest rung that fails again | No promotion; the failure is reported as itself |
| 16 | A second schema-invalid output | Promotes, per the shipped disposition table, and the divergence from the intent's "only" is recorded |
| 17 | An unrecognised model rung in a declaration | Refused, never treated as the lowest rung |
| 18 | An implementation step spawned | Its argv carries the declaration's grant, with no `Bash` in it |

## Code Map

| File | Change | Why |
|---|---|---|
| `src/contracts/implementation.ts` | new | `step.implementation`'s output: the change described, per-claim provenance, declared write intents. AD-2. |
| `src/contracts/registry.ts` | modify | Register the id so `--json-schema` can carry it and the spawner re-parse against it. |
| `src/installer/interview.ts` | modify | `implementation` declares its contract; `implementation`, `testing` and `verification` lose `Bash` per ADR-004. |
| `src/engine/reconciler.ts` | modify | The plan's `implement` step names the new contract. |
| `src/engine/promotion.ts` | new | The ladder: the starting rung, the one-per-step-per-run ceiling, and what triggers a promotion. |
| `tests/contracts.implementation.test.ts` | new | Matrix 1, 2, 9, 10, 11. |
| `tests/contracts.agent-grants.test.ts` | modify | Matrix 3–7: the amended table, and that no built-in has `Bash` while `GRANTABLE_TOOLS` does. |
| `tests/engine.promotion.test.ts` | new | Matrix 12–17. |
| `tests/engine.spawner.tools.test.ts` | modify | Matrix 18. |

## Tasks & Acceptance

1. **Give the implementing agent its own contract.**
   - **Given** the contract registry, **when** `step.implementation` is looked up, **then** it resolves and
     exports to draft-7.
   - **Given** an implementation output claiming `step.output`, **when** it is parsed, **then** it is refused.
   - **Given** an output naming a path outside the run worktree, **when** it is parsed, **then** it is
     refused, and a declared write intent is accepted instead.
2. **Apply ADR-004's grant change without weakening the pinned table.**
   - **Given** the built-in roster, **when** each declaration is read, **then** none grants `Bash`, and
     `verification` still has no `Write` or `Edit`.
   - **Given** `GRANTABLE_TOOLS`, **when** it is read, **then** it still contains `Bash`, and a user-defined
     agent granting it is accepted and reported as elevated.
   - **Given** an implementation step spawned, **when** its argv is built, **then** `--tools` carries the
     declaration's grant and no `Bash`.
3. **Point the plan at the new contract.**
   - **Given** the standard plan, **when** its `implement` step is read, **then** it names
     `step.implementation`.
4. **Make the ladder behave as AD-17 and the Stack describe.**
   - **Given** a first attempt, **when** it is spawned, **then** it runs on the lowest rung.
   - **Given** a failed verification gate, **when** the step is retried, **then** it is promoted one rung,
     and a second promotion in the same run is refused.
   - **Given** a step on the highest rung that fails again, **when** it is retried, **then** no promotion is
     attempted and the failure is reported as itself.
   - **Given** an unrecognised rung in a declaration, **when** it is read, **then** it is refused rather than
     treated as the lowest.

## Spec Change Log

## Review Triage Log

## Design Notes

## Verification

Run by me, with the suite's exit status captured to a variable and the output kept in a file:
`npm run typecheck && npm run lint && npm run build && npm test` — **exit 0, 2136 tests across 74 files, zero
failures, zero skips.** Baseline `602fece` was 2053/72. Node pinned to v24.21.0.

Seven mutations by the implementer, each run against the full suite and reverted:

| Mutation | Caught by |
|---|---|
| `Bash` back into the `implementation` declaration | 4 tests across `contracts.agent-grants` and `engine.spawner.tools` |
| `Bash` removed from `GRANTABLE_TOOLS` | 2 tests, including story 2-4's elevated-reporting case |
| `Write`/`Edit` removed from `testing` | 2 tests |
| `Write`/`Edit` added to `verification` | 2 tests |
| The plan's `implement` step back to `step.output` | 2 tests — **after** a gap was found and closed; see below |
| A second promotion allowed in one run | 5 tests, including the reconciler's own |
| An unrecognised rung treated as the lowest | 2 tests |
| (extra) `Bash` re-added to the pinned table row only | 2 tests, so the table cannot be edited until it passes |

**The implementer reported a near-miss honestly and fixed it.** Mutation 5 initially caught nothing real: the
only failure was `installer.delivery`, because an unused import broke the packed build — not because any
assertion noticed. Matrix row 8 had no test, since the Code Map assigned it no file. A dedicated assertion
was added and the mutation then fails properly. That is the same accidental-compiler-pin shape I found in
story 2-4's TUI fix, caught here by the implementer rather than by review.

**Verified by me directly, each with a positive control.** The tilde tightening holds in both directions —
`~`, `~/`, `~/.ssh/id_rsa`, `~root/x`, `/etc/passwd`, `../x`, a drive letter and a UNC path all refused, while
`src/~backup.ts`, `docs/a~b.md`, `a/~/b.ts`, `.`, `./` and `src` are accepted. No built-in is granted `Bash`
and `GRANTABLE_TOOLS` still contains it. `implementation` declares `step.implementation`. All six promotion
decisions behave: promote from the lowest rung, `ladder-exhausted` at the highest, `ceiling-reached` at one
promotion, promote on a schema-invalid output per the shipped rule, `not-a-trigger` for a non-promoting code,
and `rung-unrecognised` rather than clamping to the cheapest.

## Auto Run Result

**Status: done.** The implementing agent has its own contract, the plan points at it, ADR-004's grant change
is applied, and the model ladder starts at the cheapest rung with a one-per-step-per-run ceiling.

**This story began as an architecture decision.** ADR-001 had recorded that its open question "must be
settled before 2-5 and 2-6", and the investigation found ADR-003's justification for granting `Bash` —
"inside the container per ADR-001" — was false against CLI 2.1.278: the agent runs on the host, so its shell
does too, and the CLI offers approve-or-deny but no relocation. ADR-004 resolves it by making command
execution a capability rather than a built-in tool.

**Landmine C was answered structurally rather than by assertion.** Rather than re-checking `--add-dir`, which
is story 2-4's property, the suite walks the exported draft-7 schema, collects every string-valued leaf, and
requires each to be one of three things: a closed vocabulary that cannot hold a path, a refused path field
tested against seven spellings of "outside", or an inert field named with the reader that makes it inert.
Three assertions hold it together — the classification must cover every discovered leaf, the inert list may
not name a field the export lacks, and the walk must find the fields it claims to be about. A first version
of the walker missed nullable leaves, which Zod exports as `type: ["string","null"]`, and its own test caught
that.

**One classification is a judgement worth seeing.** `changes[].provenance.source` is inert *deliberately*:
ADR-001 accepts that a host-side agent can read outside the worktree, so refusing an outside source would
refuse an honest report of something that happened.

**Follow-up review recommended: true.** No review layer ran. The specific unverified risk is the coverage gap
found during mutation: `tests/helpers/engine-fixture.ts` runs a two-step plan naming `step.output`, so the
reconciler's own suites never exercise `STANDARD_PLAN_STEPS`, and a change to the real plan is unprotected by
the suites that appear to cover it.

**Residual risks.** Six deferred entries, one `high`. The one wanting a decision: the intent's "promoted only
on a failed verification gate" is not implemented, because `error.ts` already routes
`step.schema_invalid_output` to `escalate-model-tier`; the shipped rule was implemented and the divergence
recorded rather than either rule being changed silently. And until 2-6 lands, `verification` has no way to run
a gate at all.
