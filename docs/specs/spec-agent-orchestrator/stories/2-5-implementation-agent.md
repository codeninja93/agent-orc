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
- summary: 'Review pass 1 ran all four layers; 34 patches applied and two bad_spec causes amended.'
  evidence: '48 findings — high 7, medium 25, low 14, false 2 — routed 34 patch, 4 bad_spec, 6 defer, 4
    reject. Both bad_spec causes were in this spec rather than in the implementation. Amended and patched
    forward rather than reverted, which was the user''s decision and a deliberate deviation from the
    protocol''s cascade.'
  severity: low
- summary: 'The intent''s "promoted only on a failed verification gate" remains unimplemented, by decision.'
  evidence: 'A schema-invalid output still spends the run''s single promotion, because `error.ts` maps
    `step.schema_invalid_output` to `escalate-model-tier`. Narrowing it means removing that row from the
    AD-35 table, which changes behaviour for every agent rather than this one. Recorded in
    `promotion.ts`, in the matrix-16 test and here. **Still open for a spine decision.**'
  location: src/contracts/error.ts
  severity: medium
- summary: 'Until story 2-6 lands, no step can execute anything.'
  evidence: 'ADR-004 removed `Bash` and its replacement — the command-runner MCP server — belongs to 2-6.
    `testing` and `verification` keep purpose strings promising to run tests and gates, and keep
    `promotion_policy: on-gate-failure` for gates that cannot fail because they cannot run. A
    verification step that cannot run a gate fails, spending the run''s one promotion every time. Both
    artefacts are left as they are deliberately, and ADR-004 now names this consequence.'
  severity: medium
- summary: 'A `~user` path is accepted as an ordinary directory name.'
  evidence: '`~root/x` and `~backup/a.ts` parse, while `~/x` and `~` are refused. The reasoning, recorded
    in the predicate''s docblock: nothing in this system hands these paths to a shell, the escape being
    closed is a path join, and `~backup` is as plausible a directory as `~notes.md` is a file. Reversible
    in one line plus two test rows if the stricter reading is wanted.'
  location: src/contracts/territory.ts
  severity: low
- summary: '`STANDARD_PLAN_STEPS` and `Reconciler.open` still have no production caller.'
  evidence: 'The whole engine layer remains library-level: nothing under `src/` or `bin/` assembles a run.
    The plan-step/contract pairings are asserted as constants and, since this pass, driven through a real
    reconciler pass by a test-supplied executor — which is the strongest available until something
    assembles a run for real.'
  severity: medium
- summary: 'Territory paths are still compared case-sensitively.'
  evidence: 'Carried from story 2-4. Two declared paths differing only in case read as disjoint, so on
    macOS — the stated primary development platform — two features whose territories genuinely overlap
    can be admitted together. The duplicate-change-path check added in this pass has the same
    sensitivity, deliberately, so that one decision is made in one place rather than half of it here.'
  location: src/contracts/territory.ts
  severity: medium
- summary: '`changes[].provenance.source` accepts a path outside the worktree.'
  evidence: 'Deliberate: ADR-001 accepts that a host-side agent can read outside the worktree, so refusing
    an outside source would refuse an honest report of something that happened, and nothing resolves that
    field as a filesystem location. The inertness is now stated on the field itself and in its
    `.describe()`, rather than only in the classification test.'
  location: src/contracts/implementation.ts
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
| 19 | The `implementation` declaration | Names the cheapest rung, and the engine **reads** a declaration's `start_tier` rather than leaving the field inert |
| 20 | A declaration naming a rung the build cannot place | Refused at the declaration surface, not only at the plan surface |
| 21 | A completed implement step declaring a territory | Recorded as `feature.territory_declared`, the way an analysis step's is |
| 22 | A second contract that declares a territory | Recognised without naming it: the discriminator is not one contract's schema |
| 23 | An implement step spawned from the standard plan | The request the executor receives carries `step.implementation`, observed through a real pass |
| 24 | A `blocked` or `failed` output carrying changes | Refused unless it declares a territory: changes without one make every containment check vacuous |
| 25 | A change or evidence path spelled `.` | Refused: a change names one file, never the whole repository |
| 26 | A `territory` carrying duplicate or unnormalised entries | Normalised and de-duplicated, as `changes[].path` already is |
| 27 | A repository file whose name begins with `~` (`~notes.md`, `~$doc.docx`) | Accepted: it is a real file in the tree |
| 28 | A home path spelled to dodge the check (`./~/.ssh/id_rsa`) | Refused: the **normalised** value is what is judged, never the raw spelling |
| 29 | `isRepositoryRelativePath` | Pinned in a suite named for it, both directions, since four contracts depend on it |
| 30 | A path field the contract cannot refuse (`provenance.source`) | Either refused, or its inertness stated where a reader meets the field rather than only in a test |
| 31 | An unplaceable rung met by the reconciler | Routed as `config.invalid` to a person, never escaping the pass as an uncaught throw |
| 32 | An unplaceable rung folded from the event log | Refused the same way `promotion.ts` refuses it, not silently replaced by the starting tier |
| 33 | A `promoteTo` granted to an attempt | Checked like every other rung input, since it has the highest precedence |
| 34 | ADR-003, ADR-004, the spine and the memlog | Agree with each other: no cell carries a rationale its own amendment refutes, and every accepted ADR has a memlog decision line |

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
| `src/engine/rebuild.ts` | modify | An unplaceable logged rung must be refused, not replaced by the starting tier — two modules must not disagree. |
| `src/engine/agents.ts` | modify | Its `READ_ONLY_TOOLS` rationale quotes ADR-003's retracted sentence as a live example. |
| `docs/.../ADR-003-built-in-agent-tool-grants.md` | modify | The justification cells still carry the rationale ADR-004 refutes. |
| `docs/.../ADR-004-command-execution-as-a-capability.md` | modify | It asserts an amendment to ADR-003 that was never made, and omits ADR-001 from `amends:`. |
| `docs/specs/spec-agent-orchestrator/.memlog.md` | modify | ADR-004 has no decision line; the memlog is canonical and SPEC.md is derived from it. |
| `tests/helpers/agent-grant.ts` | modify | It presents an abolished grant under the built-in agent's own name. |
| `tests/contracts.territory.test.ts` | new | The shared predicate pinned in a suite named for it, both directions. |

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

### 2026-09-22 — amended by review pass 1 (two `bad_spec` root causes, both in this spec)

**Triggering findings.** EC16 / IA-3a — `implementation` declares `start_tier: 'claude-sonnet-5'`, the middle
rung, against an intent reading "starts on the cheapest viable model rung"; and nothing in `src/engine/`
reads a declaration's `start_tier` at all, so the field is written to `.orch/agents/*.toml` and never
consumed. EC17 / IA-3b — a schema-invalid output spends the run's single promotion, against the intent's
"promoted only on a failed verification gate".

**What was amended.** Matrix rows 19–34. Row 12's criterion — "a first attempt runs on the lowest rung" —
was satisfiable at the *plan* surface while the agent's own declaration said otherwise, so rows 19 and 20
bind it at the declaration surface instead. The remaining rows cover the territory discriminator, the
spawned contract observed through a real pass, the vacuity and `.`-path holes, the `~` predicate in both
directions, the uncoded rung throws, and the requirement that the four architecture documents agree.

**The known-bad state avoided.** An acceptance criterion that passes at a surface the intent did not name.
Row 12 was green throughout, because `startingRung(null)` returns the floor for an *absence* — while the
declaration this story is about names the middle rung and is read by nothing. The criterion measured a
default, not the agent.

**The promotion divergence is accepted, not fixed.** The intent's "only" is not made true: narrowing it means
removing `step.schema_invalid_output` from `escalate-model-tier` in the AD-35 table, which changes behaviour
for every agent rather than this one. It is recorded as a deliberate deviation in `promotion.ts`, in the
matrix-16 test and in the deferred entries, and it remains open for a spine decision.

**KEEP instructions — what worked and must survive.** (1) The schema-walking test that classifies every
string leaf as a closed vocabulary, a refused path field, or an inert field named with its reader — including
the three assertions that keep it honest, and the nullable-leaf handling its own test caught. (2)
`promotion.ts` refusing an unrecognised rung rather than clamping it to the lowest, and the reason recorded
there. (3) The pinned `DECLARED` table with `GRANTED` derived from it. (4) No built-in granted `Bash` while
`GRANTABLE_TOOLS` keeps it. (5) The recorded `claude -p` fixture; do not replace it with synthesised JSON.
(6) `STANDARD_PLAN_STEPS` naming the real contracts.


## Review Triage Log

### 2026-09-22 — Review pass
- verdicts: 48 findings — high 7, medium 25, low 14, false 2, maybe-false 0
- findings:
  - `[medium]` `[patch]` BH1 — a `blocked`/`failed` output with changes and an empty `territory` parses, so every per-change containment refusal passes vacuously. The seed `territoryWellFormed = territory.length > 0` treats an empty territory as well-formed enough to skip the check rather than as a fault. This is the empty-collection vacuity pattern landing inside the `completed`-only rule 2-4's review asked for.
  - `[medium]` `[patch]` BH2 — `territory` entries are neither normalised nor de-duplicated, while `changes[].path` is: `['src','src','./src']` parses. The reconciler serialises on the declared territory, so the same one-thing-two-spellings argument the code makes for change paths applies here.
  - `[medium]` `[patch]` BH3 — `rungForAttempt` can throw `ModelRungUnrecognised` out of `driveStep` and neither call site catches it, though the baseline-reset path just below in the same method is wrapped. A checkpoint holding an unplaceable rung crashes the reconcile pass instead of producing the `config.invalid` routing every other malformed-configuration path produces.
  - `[low]` `[patch]` BH4 — dead reassignment: `rungForAttempt` already gives `promoteTo` top precedence, yet the block still ends `tier = options.promoteTo`. A second authority on the rule the refactor exists to centralise, and it is what forces `let` where `const` would do.
  - `[medium]` `[patch]` BH5 — ADR-003 is half-amended. Verified: the three tools cells say "(`Bash` removed by ADR-004)" while their justification cells still read "`Bash` is how a gate runs, inside the container per ADR-001" — the sentence ADR-004 was written to refute. Line 24 still calls a `Bash` grant "contained, but real", and "changes in one row" is now four.
  - `[medium]` `[patch]` BH6 — ADR-001 is contradicted but neither amended nor listed. Verified: ADR-004's `amends:` names only ADR-003, while ADR-001 still states "a roster entry granting `Bash` grants the ability to run commands, contained but real" — the claim ADR-004 disproves — and its Stage-2 open question is now settled with nothing recording that.
  - `[medium]` `[patch]` BH7 — no memlog entry for ADR-004. Verified: `.memlog.md` carries a `(decision)` line for ADR-002 and ADR-003 and none for ADR-004. The memlog is canonical under `bmad-spec` and SPEC.md is derived from it, so the largest architectural change in this diff is absent from the record everything else is generated from.
  - `[medium]` `[patch]` BH8 — the interim "nothing can run a command" state is recorded nowhere that a reader of the code would meet it. `testing` and `verification` keep purpose strings promising to "run" tests and gates they now cannot run, and keep `promotion_policy: 'on-gate-failure'` for gates that cannot fail because they cannot execute. ADR-004's "Consequences accepted" omits the plainest consequence.
  - `[low]` `[patch]` BH9 — `src/engine/agents.ts` argues `READ_ONLY_TOOLS` by quoting ADR-003's retracted "`Bash` is how a gate runs" as a live example, which now teaches the reader the opposite of the rule.
  - `[medium]` `[patch]` BH10 — `tests/helpers/agent-grant.ts` still presents an abolished grant as the built-in one: `agentId: 'implementation'`, `tools` ending in `Bash`, and spawner assertions pinning `Read,Write,Edit,Grep,Glob,Bash` under that name. The story claims the helper "now models a user-defined agent"; nothing in the helper says so.
  - `[medium]` `[patch]` BH11 — the new `~` refusal has no test where the predicate lives, and the two sibling contracts leaning on the same predicate were not extended: the analysis and planning suites still pin `['/etc/passwd']` with no `~` case.
  - `[low]` `[patch]` BH12 — `tests/contracts.agent-grants.test.ts`'s top-level describe still reads "exactly what ADR-003 decided" although three of its rows are now ADR-004's, so a failure names the superseded decision.
  - `[low]` `[patch]` BH13 — `HIGHEST_MODEL_RUNG`'s `?? LOWEST_MODEL_RUNG` exists only to satisfy `noUncheckedIndexedAccess` and fails in the wrong direction: on an empty ladder highest becomes lowest, turning `ladder-exhausted` into a refusal of every promotion — the mirror of the run-backwards bug the module prevents. `PROMOTION_REFUSALS`'s declared order also differs from the evaluation order its JSDoc justifies.
  - `[low]` `[patch]` BH14 — the recorded fixture's flat `provenance` entries are bare paths while the project's convention is `"<step>: <source>"`. As the AD-31 recorded output it is the example a model copies.
  - `[low]` `[patch]` BH15 — a 186-character JSDoc line in `src/installer/interview.ts` against the file's ~110-column wrapping; prettier does not reflow comments and no `max-len` rule catches it.
  - `[medium]` `[patch]` EC1 — reported changes escape containment when the territory is empty on a non-`completed` output; same root cause as BH1.
  - `[medium]` `[patch]` EC2 — `changes[].path` of `"."` is accepted, so the repository root parses as a changed file. I verified it: with `territory: ['.']` the output parses.
  - `[medium]` `[patch]` EC3 — `artifacts[].path` of `"."` is accepted, so an evidence pointer can resolve to the run directory itself.
  - `[low]` `[defer]` EC4 — two changes differing only in case pass as two records for one file on a case-insensitive filesystem. Same root cause as the territory case-sensitivity already deferred from story 2-4; fixing it here would fix half of one problem.
  - `[high]` `[patch]` EC5 — the new `~` guard is bypassed by a `./` prefix. Verified: `./~/.ssh/id_rsa` is **accepted** and normalises to `~/.ssh/id_rsa`, because the guard tests the raw spelling and the normalised value still begins with `~`.
  - `[high]` `[patch]` EC6 — the same guard refuses legitimate files. Verified: `~notes.md`, `~tmp.ts` and `~$doc.docx` at the repository root are refused, across `step.analysis`, `step.planning`, `step.implementation` and declared territory. Together with EC5 the guard refuses real files while missing the case it was added for.
  - `[low]` `[patch]` EC7 — a `promotions` count that is `NaN`, negative or non-integer defeats the ceiling, because `NaN >= 1` is false.
  - `[medium]` `[patch]` EC8 — `promoteTo` has the highest precedence in `rungForAttempt` and is the only input not checked with `isModelRung`, so an unplaceable rung granted as a promotion reaches the spawn.
  - `[medium]` `[patch]` EC9 — the uncaught `ModelRungUnrecognised` escaping `driveStep`; same root cause as BH3.
  - `[medium]` `[patch]` EC10 — `src/engine/rebuild.ts` silently replaces a logged rung it cannot place with the starting tier, which is the exact case `promotion.ts` was written to refuse. Two modules now disagree about an unplaceable rung.
  - `[medium]` `[patch]` EC11 — a reused `steps/<id>/input.json` written before this change names `step.output`, so the input tells the agent one contract while `--json-schema` demands another.
  - `[medium]` `[defer]` EC12 — `verification` can run no gate, so `step.verification_failed` spends the run's single promotion every time. The interim gap is known and stated in the spec; the promotion-burn consequence is new and is recorded here rather than being discovered in 2-6.
  - `[false]` `[reject]` EC13 — claim that existing installs keep `Bash` and `step.output` with no migration. Refuted: `writeInstall` re-renders every built-in agent file from `BUILT_IN_AGENTS` and `writeFileIfChanged` overwrites, exercised by `tests/installer.idempotence.test.ts`. AD-12 makes an upgrade a re-run, so the roster is rewritten. A repository never re-run keeps the old roster, which is true of every setting and is not this change's defect.
  - `[low]` `[reject]` EC14 — the ceiling refusal's reason no longer names the error code. The structured field carries it and the hand-off text names the ceiling; a purely cosmetic loss whose fix is string-plumbing.
  - `[medium]` `[defer]` EC15 — `STANDARD_PLAN_STEPS` is exported and read by no module under `src/` or `bin/`. True, and it is the same library-level staging as `Reconciler.open`, which also has no production caller. The pairing is asserted as a constant, which is the strongest thing available until something assembles a run.
  - `[medium]` `[patch]` EC18 — `changes[].provenance.source` accepts an outside path. Verified: `/etc/shadow` parses. The implementer classified it inert deliberately, since ADR-001 accepts that a host-side agent may read outside the worktree — but the story's own claim is "no field through which a path outside the run worktree can be returned", and this field returns one.
  - `[false]` `[reject]` EC19 — claim that the ceiling is per step rather than per run. Refuted: `src/contracts/state.ts` specifies "one promotion per step per run", and per-step is what that means. My acceptance criterion's wording ("a second promotion in the same run is refused") was the loose part, not the code.
  - `[high]` `[bad_spec]` EC16 — `implementation` declares `start_tier: 'claude-sonnet-5'`, the middle rung, against an intent that says "starts on the cheapest viable model rung". Verified, and worse: nothing in `src/engine/` reads a declaration's `model.start_tier` at all, so the field is written to `.orch/agents/*.toml` and never consumed. My matrix row 12 let the criterion pass at the plan-level surface instead.
  - `[high]` `[bad_spec]` EC17 — a schema-invalid output spends the run's one promotion, against the intent's "only on a failed verification gate". Recorded in three places by design, but the spec chose the shipped rule where the intent chose otherwise.
  - `[high]` `[patch]` VG1 — the implement step's declared territory is never recorded. Verified against the real recorded fixture: `recordDeclaredTerritory` discriminates with `AnalysisOutputSchema.safeParse`, which pins `contract_id` to `step.analysis`, so it returns early for every implement step. 2-4's review moved that recording off the phase and onto the contract precisely to avoid a second place deciding what declares a territory — and keying on one contract's schema has the same defect for the second one.
  - `[medium]` `[patch]` VG2 — nothing observes that the implement step is spawned with `step.implementation`. Every reconciler test drives a custom plan spelling `step.output`, and the two `STANDARD_PLAN_STEPS` runs use a scripted executor that ignores `contractId`. The one link whose failure the change's own comment names as the defect it fixes is the link nothing measures.
  - `[medium]` `[patch]` VG3 — `territory: ['.']` with changes at any path parses, so the containment refinement compares the output only to its own declaration while the docblock claims the change is "inside the conflict domain the reconciler admitted this feature for". The only containment case holds the territory fixed and moves the path; none widens the territory.
  - `[medium]` `[patch]` VG4 — `ModelRungUnrecognised.code` is read by nothing; its only throw sites escape `driveStep` uncaught, and the test asserting it "reaches a person" constructs the error directly and asserts a property of the AD-35 table rather than of how the throw is handled. Same root cause as BH3.
  - `[low]` `[patch]` VG5 — the `~` case in the change-path table would pass with the guard removed, because containment refuses it anyway; the guard is pinned only by the sibling `territory[]` and `artifacts[].path` cases.
  - `[low]` `[defer]` VG6 — `PROMOTION_TRIGGER_CODES` and `HIGHEST_MODEL_RUNG` have no consumer in `src/`; exported and asserted only by their own suite. Staging, like EC15.
  - `[low]` `[patch]` VG7 — the dead `tier = options.promoteTo` reassignment; same root cause as BH4.
  - `[low]` `[reject]` VG8 — that `npm test` fails on the machine's default Node 22.14.0 against the 22.22 floor. Environment, not the diff, and the floor check is working as designed.
  - `[high]` `[bad_spec]` IA-3a — the "cheapest viable rung" clause is unaddressed at the surface the intent names; same root cause as EC16.
  - `[high]` `[bad_spec]` IA-3b — the "only on a failed verification gate" clause is contradicted with the contradiction written down; same root cause as EC17.
  - `[medium]` `[patch]` IA-3c — write confinement is enforced at the report surface rather than the write surface, and territory containment is self-referential. Same root cause as VG3. The division of labour is defensible; the docblock's claim is not.
  - `[medium]` `[defer]` IA-3d — the only tool through which the agent could cause an arbitrary side effect was removed and its sanctioned replacement deferred, so the intent's "promoted on a failed verification gate" presupposes a gate that nothing can currently run. Same interim gap as EC12.
  - `[low]` `[defer]` IA-3e — scope beyond the story's named subject: `testing` and `verification` had their grants changed here, and the promotion extraction is engine-wide. Both are justified by ADR-004 being one coherent decision, and the reconciler precedence was verified behaviour-preserving.
  - `[medium]` `[patch]` IA-3f — the ADR-003 table's justification cells still carry the pre-amendment rationale; same root cause as BH5.

- actions taken, per root cause (every `patch` and `bad_spec` row resolves to one of these):
  - **A — `start_tier`** (EC16, IA-3a; `bad_spec`, amended into matrix 19–20). `AgentGrant` gains `startTier`, read from the declaration through `startingRung` so the ladder stays the one authority; the reconciler resolves it from the run's AD-9 snapshot with `plan.starting_model_tier` standing behind it; `implementation` now declares `claude-haiku-4-5`. Verified end to end: declaration → snapshot → grant → attempt rung. The test deliberately declares `claude-opus-5` rather than the floor, because a floor value is indistinguishable from `startingRung(null)` — which is precisely what made the inertness invisible.
  - **B — the territory discriminator** (VG1). `declaredTerritoryIn` replaces `AnalysisOutputSchema.safeParse`: it matches the *field*, not a contract, so a second declaring contract is recognised without being named. Verified against all three recorded fixtures, with `null` for an output carrying no territory.
  - **C — the `~` guard** (EC5, EC6, BH11, VG5). Judged on segments, with `..` deliberately not collapsed first. The implementer's own new suite found a **third** hole neither the reviewers nor I had: `~/../etc/passwd` normalises to `etc/passwd`, so the climb erases the segment a collapse-then-check guard is looking for. 18 refused spellings and 12 accepted, each refusal carrying the reason it is outside.
  - **D — vacuity and whole-repository holes** (BH1, BH2, EC1, EC2, EC3, VG3, IA-3c). A territory is required whenever `changes.length > 0` regardless of status, with a positive control proving containment runs once one is present. `.` refused as a change or evidence path, still legal as a territory. Unnormalised and duplicate territory entries **refused rather than rewritten**, because this schema also re-parses an artifact the recorder wrote and a parse that rewrote its input would make the stored and parsed documents differ. The over-claiming docblock was changed rather than faked: a contract sees one artifact and cannot see the run.
  - **E — rung handling** (BH3, BH4, BH13, EC7, EC8, EC9, EC10, VG4, VG7). `promoteTo` checked like every other input; the throw caught in `driveStep` and routed `config.invalid`; `rebuild.ts` refuses a logged rung it cannot place while keeping the fallback for one that names none; a `NaN`, negative or fractional promotion count treated as spent; `HIGHEST_MODEL_RUNG` found by climbing rather than by index-with-fallback; the refusal list reordered to evaluation order; the dead reassignment deleted.
  - **F — the implement step observed in a real pass** (VG2). `STANDARD_PLAN_STEPS` driven three passes deep with an executor recording `contractId` per step, asserting `implement` carries `step.implementation` — and that `analyse` still carries `step.analysis`, so the assertion is about that step rather than about all of them.
  - **G — documentation** (BH5, BH6, BH7, BH8, BH9, BH12, IA-3f). ADR-004's `amends:` gains ADR-001; the false "now carries the warning above" replaced with what was actually amended, including a note on how a document came to describe an amendment nobody applied; a consequence added that until the server exists nothing can execute anything. ADR-003's three justification cells rewritten, line 24's "contained, but real" corrected in place, and the user-defined-agent bullet given the warning it was said to carry. `.memlog.md` gains an ADR-004 decision line in the same register as ADR-002's and ADR-003's.
  - **H — hygiene** (BH10, BH14, BH15, EC11). `fixtureGrant` renamed `my-own-implementer` with a docblock saying it models a user-defined agent; `stepInput` rewrites a reused input file whose contract id differs from the plan step's; the fixture re-recorded with a real `claude -p` call rather than edited by hand; the over-long JSDoc rewrapped.

## Design Notes

## Verification

Run by me after the patch round, exit status captured to a variable and output kept in a file:
`npm run typecheck && npm run lint && npm run build && npm test` — **exit 0, 2213 tests across 75 files, zero
failures, zero skips.** Baseline `c09e899` was 2053/72; the implementation reached 2136/74 and the review's
patches took it to 2213/75.

**Verified by me directly, each with a positive control.** All three `~` holes are closed —
`~/.ssh/id_rsa`, `./~/.ssh/id_rsa`, `~/../etc/passwd`, `.//~/x`, `~` and `~/` refused — while `~notes.md`,
`~$doc.docx`, `~tmp.ts`, `src/~backup.ts`, `~root/x` and `~backup/a.ts` are accepted. `declaredTerritoryIn`
returns the declared paths for all three declaring fixtures and `null` for an output carrying none.
`implementation` declares `claude-haiku-4-5`, and the engine reads it through `agents.ts` into
`reconciler.ts`'s `declaredStartingRung`. `ModelRungUnrecognised` is caught in `driveStep`.

Seven mutations in the first round, each reverted; the patch round added its own non-vacuity checks.

## Auto Run Result

**Status: done, reviewed.** The implementing agent has its own contract and the cheapest declared rung, the
engine reads that declaration, its territory reaches the log, and ADR-004's grant change is applied and
documented consistently.

**Review findings: 48 across four layers** — high 7, medium 25, low 14, false 2. Routed 34 patch, 4
bad_spec, 6 defer, 4 reject. All 34 patches applied.

**Both `bad_spec` causes were in this spec, not in the implementation.** Matrix row 12 asserted "a first
attempt runs on the lowest rung" and was satisfiable at the *plan* surface, where `startingRung(null)`
returns the floor for an absence — while the declaration this story is about named the middle rung and was
read by nothing in the engine. The criterion was green throughout and measured a default rather than the
agent. That is the same failure this project keeps finding in tests, committed in a spec instead.

**Three documents I wrote were wrong, and the review caught all three.** ADR-004 asserted that ADR-003's
user-defined-agent bullet "now carries the warning above" when that bullet was unchanged — a claim about an
amendment nobody applied, in an accepted architecture record. ADR-004 omitted ADR-001 from `amends:` while
disproving one of its sentences and settling its open question. And ADR-004 had no `.memlog.md` decision
line, though the memlog is canonical and SPEC.md is derived from it. All three are corrected, and ADR-004
now records how the false claim came to be there.

**I mis-verified the `~` guard and reported it clean.** I had tested `~`, `~/`, `~/.ssh/id_rsa` and
`~root/x` as refusals and three non-leading-`~` paths as acceptances — never a root-level file beginning with
`~`, and never a `./` prefix. Both were broken. The patch round then found a third hole neither the reviewers
nor I had: `~/../etc/passwd` normalises to `etc/passwd`, so the `..` climb erases the very segment a
collapse-then-check guard looks for. The guard is now judged on segments, with `..` deliberately not
collapsed first, and pinned in a suite named for the predicate.

**The territory discriminator is the finding worth remembering.** 2-4's review moved that recording off the
*phase* and onto the *contract*, reasoning that a phase test would be "a second place deciding what an
analysis agent is". Keying on one contract's schema rebuilt that defect one level down, and it surfaced one
story later, when a second contract declared a territory. It now matches the *field*.

**Rejected findings, with reasons.** Four. That existing installs keep `Bash` with no migration — refuted:
`writeInstall` re-renders every built-in agent file and AD-12 makes an upgrade a re-run. That the ceiling is
per step rather than per run — refuted: `state.ts` specifies "one promotion per step per run", and my
acceptance criterion's wording was the loose part. That a refusal reason no longer names its error code —
cosmetic, with the structured field carrying it. And that `npm test` fails on the machine's default Node —
environment, and the floor check working as designed.

**Follow-up review recommended: true.** A `high` was patched. The specific unverified risk: nothing under
`src/` or `bin/` assembles a run, so `STANDARD_PLAN_STEPS` and `Reconciler.open` are still exercised only by
test-supplied executors.

**Residual risks.** Seven deferred entries. The one still wanting a decision is the promotion trigger: the
intent's "only" is not true, and making it true means removing a row from the AD-35 table that governs every
agent. And until 2-6 lands, no step can execute anything.
