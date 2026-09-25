---
title: 'Bootstrap agent — profiles authored for an unseen repository'
type: 'feature'
created: '2026-09-25'
status: 'done'
baseline_revision: 'b91f4d32b1603621ccff38319548f0cc7ff9ac03'
review_loop_iteration: 0
followup_review_recommended: true
context: []
warnings: ['oversized']
deferred:
  - summary: >-
      No test proves a real (non-scripted) spawner can actually dispatch the bootstrap step against a
      genuinely unseen repository — grant resolution is by phase, so bootstrapPlan's phase: 'analysis'
      would resolve the ordinary analysis agent, not BOOTSTRAP_AGENT_DECLARATION, unless a caller
      supplies a custom grantFor bypassing the target repository's own roster.
    evidence: |-
      Confirmed directly: src/engine/agents.ts's grantFromRoster/rosterAgent match by phase against
      entry.id, and BOOTSTRAP_AGENT_DECLARATION's id 'bootstrap' is never looked up anywhere in the
      engine. Found independently by two review layers plus direct tracing. The fix path already exists
      (createStepSpawner's grantFor option is pluggable) and is now documented on bootstrapPlan/
      BOOTSTRAP_AGENT_DECLARATION, but proving it end-to-end needs a real subprocess dispatch via
      fake-claude.ts replaying the same AD-31 fixture this story already tracks as pending
      (PENDING_AD31_FIXTURE_CONTRACT_IDS) - the two gaps are tied together, not independent.
    location: >-
      src/engine/bootstrap.ts (bootstrapPlan, BOOTSTRAP_AGENT_DECLARATION)
    severity: medium
---

<intent-contract>

## Intent

**Problem:** CAP-20's success test is explicit: "a bootstrap run produces a profile for an unseen
repository, and a feature completes there with no engine modification." Today, `.orch/profile.toml` is
either hand-typed or filled from `detectDefaults` — pure filesystem checks (lockfile, `package.json`
scripts, a fixed directory list) that already cover most of AD-16's mechanics fields. What detection
cannot answer needs judgement over the repository's actual content: `mechanics.resources` (does it need
postgres/redis?), `risk.high_blast_radius_paths`/`conflict_domains`, and the knowledge section — three
fields the interview today only collects as free text typed by a person who has already read the
repository themselves.

**Approach:** A new, read-only agent — declared the same way every built-in is (AD-17), dispatched through
the *existing* reconciler/spawner pipeline as an ordinary `analysis`-phase step, so CAP-20's "no engine
modification" holds literally: nothing in `src/engine/reconciler.ts` or `spawner.ts` changes. Its structured
output (`BootstrapAnalysisSchema`, a new step contract) states the same three judgement fields a person
would have typed, each occurrence attributed to what was read, matching `AnalysisOutputSchema`'s own
claim/provenance discipline. A pure function then merges a completed analysis onto an existing `Profile` —
returning an updated `Profile` object, never writing it — so "reviewed by the user before first use"
(AD-16's own words) is satisfied by construction: nothing in this story's code path ever touches
`.orch/profile.toml` on disk. Wiring an actual CLI command that runs this and offers to write the result is
future work, matching the unwired-but-complete precedent every story since 5-1 has followed.

## Boundaries & Constraints

**Always:**
- The bootstrap step is an ordinary `phase: 'analysis'` step in a `FeaturePlan`, using the existing
  `analysis` phase (`STEP_PHASES` is unchanged) — not a new phase, and not a new agent-dispatch mechanism.
  `bootstrapPlan` builds a plan the *same* `Reconciler`/`createStepSpawner` pipeline drives, proven by a
  reconciler-integration test using a scripted executor (`createScriptedExecutor`, no real subprocess
  needed to prove this property) rather than by inspecting the plan's shape alone.
- `BootstrapAnalysisSchema` extends `StepOutputSchema` exactly as `AnalysisOutputSchema` does: a
  `contract_id` pinned to a literal, and every path-bearing field (`high_blast_radius_paths`,
  `conflict_domains`) validated with `isRepositoryRelativePath`/territory containment, the same functions
  `AnalysisOutputSchema` already uses — no second implementation of "is this a real repo-relative path."
  `knowledge` reuses `KnowledgeEntrySchema` (story 5-1) verbatim.
- `mergeBootstrapAnalysis(profile, analysis)` is pure: it takes an already-completed analysis and an
  already-loaded `Profile`, and returns a new `Profile` with `mechanics.resources` replaced,
  `risk.high_blast_radius_paths`/`conflict_domains` replaced, and `knowledge.entries` *appended to*
  (never replacing existing entries — a bootstrap run happens once, on an existing profile that may
  already carry knowledge from consolidation, per story 5-1). It writes nothing to disk.
- The bootstrap agent's declaration (`AgentDeclarationInput`-shaped, matching `BUILT_IN_AGENTS`'s own
  entries in `src/installer/interview.ts`) is a **standalone exported constant**, not added to
  `BUILT_IN_AGENTS` itself — it is not one of the ordinary feature-building roster a person toggles at
  question 10, and adding it there would offer it as a build agent for ordinary features, which it is
  not. Add the matching row to ADR-003's grant table for governance, but do not modify `interview.ts`.
- **AD-31's own rule — every contract needs a recorded real `structured_output` fixture — cannot be
  satisfied by this implementer.** A brand-new step contract's fixture has to come from an actual
  `claude -p --json-schema` call, which needs real subscription auth this environment cannot provide.
  Deep has agreed to run one such session and supply the transcript (confirmed directly, 2026-09-25). This
  story's own round-trip test (`tests/contracts.round-trip.test.ts`'s own pattern, applied to the new
  contract) is written now, with the fixture-dependent assertion clearly marked and left for that
  transcript; every other test in this story (schema validation, the reconciler-integration test via a
  scripted executor, the merge function) needs no real fixture and is complete now.

**Never:**
- No CLI command, no change to `runInit`/`write.ts`'s roster-writing, and no automatic write to
  `.orch/profile.toml`. The merge function's whole contract is "given an analysis and a profile, what would
  the updated profile be" — deciding when a person runs a bootstrap analysis, and whether to accept its
  merge, is explicitly out of this story's scope.
- No change to `STEP_PHASES`, the reconciler, or the spawner. If achieving "no engine modification" ever
  seemed to require one, that would be a sign this story's own design is wrong, not a reason to make the
  change anyway.
- No attempt to fabricate, approximate, or hand-write the AD-31 fixture. A schema this codebase cannot
  actually validate against a real model's output is worse than an honestly incomplete round-trip test.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Valid bootstrap output | `resources`, path lists, knowledge entries all well-formed | `BootstrapAnalysisSchema.parse` succeeds | No error expected |
| A high-blast-radius path outside the repository | `high_blast_radius_paths: ['../etc/passwd']` | Refused at parse, matching `AnalysisOutputSchema`'s own territory-containment refusal | Schema refusal |
| Bootstrap plan through the reconciler | `bootstrapPlan(repositoryPath)` accepted and driven by a real `Reconciler` with a scripted executor | The step runs as an ordinary `analysis`-phase step; the run reaches a state proving the pipeline needed no changes | No error expected |
| Merge onto a profile with existing knowledge | Profile already has 2 knowledge entries from consolidation; analysis adds 1 more | Merged profile has 3 knowledge entries — appended, not replaced | No error expected |
| Merge replacing resources/risk | Profile's `mechanics.resources: 'none'`; analysis says `'postgres'` | Merged profile's `mechanics.resources` is `'postgres'` | No error expected |
| Merge does not write to disk | Any valid merge call | No file is created or modified anywhere on disk | No error expected |

</intent-contract>

## Code Map

- `src/contracts/analysis.ts` -- `AnalysisOutputSchema`/`ClaimProvenanceSchema` read as the structural template for extending `StepOutputSchema` and for path/territory validation reuse.
- `src/contracts/step.ts` -- `StepOutputSchema`, base fields every step contract extends.
- `src/contracts/territory.ts` -- `isRepositoryRelativePath`, reused for path validation.
- `src/contracts/knowledge.ts` -- `KnowledgeEntrySchema`, reused verbatim for the `knowledge` field.
- `src/contracts/installer.ts` -- `ProfileSchema`, `RESOURCE_NEEDS`; read-only reference for the merge target's shape.
- `src/contracts/registry.ts` -- add the new contract's entry, following every existing `step` kind entry's exact shape.
- `src/installer/interview.ts` -- `AgentDeclarationInput`, `BUILT_IN_AGENTS`; read-only reference for the declaration shape (not modified).
- `tests/helpers/engine-fixture.ts` -- `createScriptedExecutor` (via `src/engine/index.js`), reused for the reconciler-integration test.
- `docs/planning-artifacts/architecture/architecture-agent-orcastrator-2026-09-19/ADR-003-built-in-agent-tool-grants.md` -- add the bootstrap agent's row.
- `src/contracts/bootstrap.ts` (new) -- `BOOTSTRAP_CONTRACT_ID`, `BootstrapAnalysisSchema`.
- `src/engine/bootstrap.ts` (new) -- `BOOTSTRAP_AGENT_DECLARATION`, `bootstrapPlan`, `mergeBootstrapAnalysis`.

## Tasks & Acceptance

**Execution:**
- `src/contracts/bootstrap.ts` -- add `BootstrapAnalysisSchema` -- extends `StepOutputSchema`, matching `AnalysisOutputSchema`'s territory-containment pattern for its two path fields.
- `src/contracts/registry.ts` -- register the new contract.
- `src/engine/bootstrap.ts` -- add `BOOTSTRAP_AGENT_DECLARATION` -- a standalone constant, not added to `BUILT_IN_AGENTS`.
- `src/engine/bootstrap.ts` -- add `bootstrapPlan(repositoryPath, options)` -- a single-step, analysis-phase `FeaturePlan`.
- `src/engine/bootstrap.ts` -- add `mergeBootstrapAnalysis(profile, analysis)` -- pure, resources/risk replaced, knowledge appended.
- `docs/planning-artifacts/architecture/architecture-agent-orcastrator-2026-09-19/ADR-003-built-in-agent-tool-grants.md` -- add the bootstrap row.
- `tests/contracts.bootstrap.test.ts` (new) -- schema validation rows from the I/O Matrix, plus the round-trip test with the fixture-dependent assertion clearly marked pending.
- `tests/engine.bootstrap.test.ts` (new) -- the reconciler-integration test (scripted executor) and every `mergeBootstrapAnalysis` row.

**Acceptance Criteria:**
- Given a `BootstrapAnalysisSchema` instance whose `high_blast_radius_paths` names a path outside the
  repository, when parsed, then it is refused, matching `AnalysisOutputSchema`'s own rule for the same
  shape of field.
- Given `bootstrapPlan(repositoryPath)` accepted by a real `Reconciler` wired to a scripted (not real
  subprocess) executor, when driven to completion, then the run reaches a terminal or gate-appropriate
  state with no modification to `src/engine/reconciler.ts` or `src/engine/spawner.ts` in this diff.
- Given a `Profile` with existing knowledge entries and a completed `BootstrapAnalysis`, when merged, then
  the returned profile's knowledge array contains every original entry plus every new one, and
  `mechanics.resources`/`risk.*` reflect the analysis's values — with no file written anywhere.
- Given `BOOTSTRAP_AGENT_DECLARATION`, when checked against `BUILT_IN_AGENTS`, then it is not a member of
  that array.
- Given the fixture-dependent leg of the round-trip test, when this story reaches `status: done`, then it
  is either completed with a real transcript Deep supplied, or explicitly recorded as a named, deferred gap
  — never silently skipped without a record.

## Verification

**Commands:**
- `npm run typecheck` -- expected: no errors
- `npm run lint` -- expected: no errors
- `npm run build` -- expected: succeeds
- `npm test` -- expected: full suite passes, including the two new test files (the fixture-dependent
  assertion may be a documented pending case rather than a passing one — see Boundaries)

## Spec Change Log

### 2026-09-25 — a genuine safety bug in `bootstrapPlan`'s own worktree contract
Found directly (before dispatching the four review layers), by tracing AD-26's `reset-and-rerun` path:
`bootstrapPlan(repositoryPath)` set `worktree: repositoryPath` — the person's own real repository
checkout, not a disposable scratch worktree. `src/engine/reconciler.ts`'s existing `reset-and-rerun` action
(unchanged, unmodified by this story) calls `git reset --hard`/`git clean -fd` against `plan.worktree` on
any step retry — a completely ordinary, reachable occurrence (a schema-invalid output, a gate failure), not
a rare or multi-actor scenario. Every other feature's plan already gets a disposable, engine-created
worktree from the assembly layer before a plan is ever built; this story's own plan constructor invited a
caller to skip that and point directly at their live repository, which the existing retry path would then
destructively reset. Fixed by renaming the parameter to `worktreePath` and documenting, prominently, that
it must be a disposable worktree created the same way every other feature's is — never the live repository
— citing this exact risk.

## Review Triage Log

### 2026-09-25 — Review pass
- verdicts: 21 findings — high 1, medium 9, low 4, false 7, maybe-false 0
- findings:
  - `[high]` `patch` (found directly, before dispatching review): `bootstrapPlan`'s `worktree:
    repositoryPath` points at the person's own live repository; AD-26's existing, unmodified
    `reset-and-rerun` retry path would `git reset --hard`/`git clean -fd` it on any ordinary retry. See
    Spec Change Log above for the fix.
  - `[medium]` `patch` verification-gap: a real, unmodified spawner resolves an agent grant **by phase**
    (`resolveAgentGrant(phase)` → `rosterAgent(roster, phase)`, matching on `entry.id === phase`), and
    `bootstrapPlan` deliberately reuses `phase: 'analysis'` to avoid touching `STEP_PHASES` — so a real run
    would resolve the *ordinary* `analysis` agent (contract `step.analysis`), never
    `BOOTSTRAP_AGENT_DECLARATION` (id `'bootstrap'`, contract `step.bootstrap`), a genuine contract
    mismatch AD-1's own re-validation would refuse. For a genuinely unseen repository (this story's whole
    premise) there is no roster at all yet, so `takeConfigSnapshot`/`resolveAgentGrant` refuse before that.
    Verified directly: `createStepSpawner`'s `grantFor` option is already pluggable (`StepSpawnerOptions`,
    `src/engine/spawner.ts`) — a bootstrap-dedicated spawner instance can supply a custom `grantFor`
    returning `BOOTSTRAP_AGENT_DECLARATION`'s own grant directly, bypassing the target repository's roster
    entirely, without any change to `STEP_PHASES`, the reconciler, or the spawner. Action: documented this
    as the intended dispatch mechanism directly on `bootstrapPlan`/`BOOTSTRAP_AGENT_DECLARATION`, and
    corrected the reconciler-integration test's own claim to state precisely what it proves (the reconciler
    accepts and drives this plan shape) and does not prove (that a real spawner resolves the right grant
    for it) — the full, real-spawner proof needs the same AD-31 fixture this story already tracks as a
    named, deferred gap, and is recorded there rather than silently left implied as already solved.
  - `[medium]` `patch` blind-hunter (same root cause, merged, independently found via
    `src/engine/agents.ts`'s own docblock: "the phase [is] also the agent id it was resolved by"):
    `BOOTSTRAP_AGENT_DECLARATION`'s id `'bootstrap'` is never looked up anywhere in the engine at all.
  - `[medium]` `patch` blind-hunter (same root cause, merged): named the chicken-and-egg half explicitly —
    a genuinely unseen repository has no `.orch/agents/` roster to resolve against in the first place.
  - `[medium]` `patch` blind-hunter (same root cause, merged): the ADR-003 row's "same reach as `analysis`
    and for the same reason" framing glosses over a real difference — `analysis`'s grant is installer-written
    per repository, `bootstrap`'s is a bare constant with (per the findings above) no actual resolution
    path yet. Action: the same documentation fix corrects this framing too.
  - `[medium]` `patch` intent-alignment (same root cause, merged): "no code path in this diff can be
    invoked... to actually run a bootstrap analysis against a real repository" — the same gap, from the
    surface-mismatch angle.
  - `[medium]` `patch` edge-case-hunter: `mergeBootstrapAnalysis` never checks `analysis.status ===
    'completed'` before merging — a `'blocked'` or `'failed'` analysis's incomplete or default field values
    would silently overwrite a profile's existing, good `mechanics.resources`/`risk.*`. Action: added a
    guard refusing to merge a non-`'completed'` analysis, with a clear error naming why.
  - `[medium]` `patch` edge-case-hunter (empirically verified, confirmed independently by blind-hunter as a
    missing-test observation — merged): `KnowledgeEntrySchema.decay_features`'s replacement,
    `z.number().refine(Number.isInteger)`, drops the safe-integer bounds `z.int()` enforced — confirmed by
    running both against `1e21`, which the original refused and the replacement accepts. Action: changed
    the refinement to `Number.isSafeInteger`, which enforces both "whole number" and "within the safe
    range" without reintroducing the `minimum`/`maximum` JSON-Schema keywords AD-2's subset forbids. Added
    tests for both a fractional value and an out-of-safe-range value.
  - `[medium]` `patch` blind-hunter (same root cause, merged): flagged the missing test coverage for this
    exact case independently, from the "no dedicated `tests/contracts.knowledge.test.ts`" angle.
  - `[low]` `patch` blind-hunter: `BootstrapPlanOptions.mode`/`.startingModelTier` have no test coverage at
    all. Action: added one test per option.
  - `[low]` `patch` blind-hunter: "a bootstrap run happens once" (the assumption licensing pure appending
    in `mergeBootstrapAnalysis`) is asserted only in prose, nowhere enforced or even detected. Action:
    corrected the docblock to state plainly that a repeat merge accumulates entries rather than implying
    the assumption is somehow guaranteed — deduplicating by anchor would invent an invariant no other part
    of this codebase's knowledge-entry handling currently enforces (story 5-2's sweep operates on
    individual entries, never a deduped-by-anchor set), so this story does not add one either.
  - `[low]` `patch` blind-hunter (same root cause, merged): the "happens once" framing appears a second
    time in the story's own Boundaries text; corrected there too.
  - `[low]` `patch` blind-hunter: no test asserts `BootstrapAnalysisSchema`'s exported shape actually
    excludes a `territory` field, unlike `AnalysisOutputSchema`'s — the registration test only checks the
    five expected fields are present, which would not catch a stray one. Action: added an exact-shape
    assertion.
  - `[low]` `patch` blind-hunter: `tests/contracts.bootstrap.test.ts` reimplements its own
    fixture-existence check rather than reusing the equivalent logic `tests/contracts.round-trip.test.ts`
    already has, so the two files could silently drift on "does this contract have a recorded fixture."
    Action: the bootstrap test file's pending-gap assertion now reads `PENDING_AD31_FIXTURE_CONTRACT_IDS`
    directly rather than re-deriving fixture presence itself.
  - `[false]` `reject` blind-hunter: `docs/implementation-artifacts/sprint-status.yaml`'s epic-5 backlog
    lists entirely different story slugs than what actually exists. Refutation: confirmed pre-existing and
    already flagged identically during story 5-3's own review — not caused by this story, not part of the
    `stories.yaml`-based process this session follows.
  - `[false]` `reject` intent-alignment: "replaces the hand-written profile" read as generating an entire
    `Profile` from nothing (Reading A). Refutation: `detectDefaults` already answers most of AD-16's
    mechanics fields mechanically; this story's own Approach section explicitly scopes itself to the three
    fields that genuinely need judgement, a narrower and better-justified reading than "replace everything."
  - `[false]` `reject` intent-alignment: "reviewed by the user before first use" read as requiring an
    actual review surface (a draft file, a CLI diff) to exist. Refutation: `mergeBootstrapAnalysis`
    returning a value rather than writing one is what makes review possible *at all* once a caller exists —
    matching every unwired-but-complete precedent since story 5-1, none of which built a review UI for
    their own outputs either.
  - `[false]` `reject` intent-alignment: the AD-31 fixture being unrecorded is treated as a further,
    unacknowledged divergence. Refutation: it is already a named, dated, explicitly tracked gap
    (`PENDING_AD31_FIXTURE_CONTRACT_IDS`) with a documented resolution path — not a silent omission.
  - `[false]` `reject` intent-alignment: "no engine modification" read as forbidding any new file under
    `src/engine/`. Refutation: every prior memory story this stage (5-1 through 5-4) added new files under
    `src/engine/` while satisfying the identical criterion — the established, consistent reading in this
    codebase is "no change to the reconciler's/spawner's own existing logic," which holds here (confirmed:
    `git diff --stat` shows neither file touched).
  - `[false]` `reject` intent-alignment: the `decay_features` schema change is read as an unanticipated
    divergence the intent statement didn't license. Refutation: it is a necessary, narrowly-scoped,
    already-verified consequence of reusing `KnowledgeEntrySchema` verbatim (this story's own explicit
    Boundary), not a scope change — and review found and fixed the one real gap in it (the safe-integer
    regression above).
  - `[false]` `reject` intent-alignment: "final story in the execution order" read as implying this diff
    should reach full closure of CAP-20. Refutation: the same "unwired but complete" pattern every prior
    story in this stage used; what makes this story's remaining gap concrete rather than vague is exactly
    the medium-severity dispatch-path finding above, now documented with its own intended resolution
    (`grantFor`) rather than left as an open question.

## Auto Run Result

Status: done
Blocking condition: none

**Summary:** A new, read-only agent (`BOOTSTRAP_AGENT_DECLARATION`) and step contract
(`BootstrapAnalysisSchema`, extending `StepOutputSchema` exactly as `AnalysisOutputSchema` does) state the
three profile judgement fields `detectDefaults`'s mechanical checks cannot answer — `mechanics.resources`,
`risk.high_blast_radius_paths`/`conflict_domains`, and `knowledge` — each attributed to what was read.
`bootstrapPlan` builds an ordinary, single-step `analysis`-phase `FeaturePlan` the existing
`Reconciler`/spawner drives with zero change to `STEP_PHASES`, `reconciler.ts`, or `spawner.ts`.
`mergeBootstrapAnalysis` is a pure function returning an updated `Profile` — nothing in this codebase's
path from here writes `.orch/profile.toml`, which is what makes "reviewed by the user before first use"
true by construction. AD-31's own requirement — a recorded real `claude -p` transcript for any new
model-produced contract — cannot be satisfied in this environment; Deep has agreed to supply one, and the
gap is named, dated, and tracked (`PENDING_AD31_FIXTURE_CONTRACT_IDS`) rather than faked or silently
skipped.

**Files changed:**
- `src/contracts/bootstrap.ts` (new) — `BOOTSTRAP_CONTRACT_ID`, `BootstrapAnalysisSchema`.
- `src/contracts/registry.ts` — registers the contract; adds `PENDING_AD31_FIXTURE_CONTRACT_IDS`.
- `src/contracts/knowledge.ts` — `decay_features` changed to a refinement (required for AD-2 subset
  reuse inside a step contract), fixed during review to use `Number.isSafeInteger`.
- `src/engine/bootstrap.ts` (new) — `BOOTSTRAP_AGENT_DECLARATION`, `bootstrapPlan`,
  `mergeBootstrapAnalysis`.
- `docs/planning-artifacts/architecture/architecture-agent-orcastrator-2026-09-19/ADR-003-...md` — adds
  and then corrects the `bootstrap` row.
- `tests/contracts.bootstrap.test.ts`, `tests/engine.bootstrap.test.ts` (new) — every I/O Matrix row and
  every patched fix; `tests/engine.profile.test.ts`, `tests/contracts.round-trip.test.ts` — the shared
  `decay_features` regression tests and the AD-31 pending-gap mechanism.

**Review findings breakdown** (21 findings across four layers, plus one found directly before dispatching
review):
- **Patched (13):** a genuine safety bug — `bootstrapPlan` pointed its worktree at a caller's own live
  repository, which the existing, unmodified retry path would destructively `git reset --hard`/`clean -fd`
  on an ordinary retry (high, found directly); a real spawner resolves an agent grant by phase, so
  `bootstrapPlan`'s reuse of the `analysis` phase would never actually dispatch
  `BOOTSTRAP_AGENT_DECLARATION` (medium, found independently by three sources — documented, with the
  existing `grantFor` pluggability named as the intended fix); `mergeBootstrapAnalysis` not checking
  `analysis.status` before merging (medium); a safe-integer regression in the shared `decay_features`
  refinement (medium, confirmed empirically, found independently by two layers); plus eight lower-severity
  fixes (missing option coverage, an overclaiming "happens once" docblock, a missing exact-shape test, and
  duplicated fixture-existence logic).
- **Deferred (1, frontmatter `deferred`):** the actual real-spawner dispatch proof — tied to the same
  AD-31 fixture gap, since both need the same recorded transcript to close.
- **Rejected (7, false):** six intent-alignment readings requiring a fuller profile, a built review UI,
  an unmodified `src/engine/` directory, or full CAP-20 closure — all already explicit, disclosed,
  precedented scope boundaries matching every prior story in this stage; and one pre-existing, unrelated
  stale artifact (`sprint-status.yaml`) already flagged identically during story 5-3's own review.

**Follow-up review recommendation:** `true`. A `high`-severity finding was patched this pass (the
worktree safety bug), which this workflow's own rule makes sufficient regardless of confidence in the fix,
and multiple `medium` entries were patched alongside it. Named unverified risk: the patches were verified
by me — typecheck/lint/build/full suite all green, and I independently confirmed the worktree parameter
rename, the `Number.isSafeInteger` fix (empirically, running both the old and new refinement against
`1e21`), the status guard, and the exact-shape test — but not by a fresh independent review pass the way
the original implementation was, and the dispatch-path fix is documentation only, not yet exercised
end-to-end against a real spawner.

**Verification performed:** `npm run typecheck`, `npm run lint`, `npm run build`, and `npm test` all pass
after the patch (111 files, 3201 tests + 3 honestly-tracked pending, up from 3194 + 3 pre-patch). Directly
confirmed `src/engine/reconciler.ts`/`spawner.ts`/`src/installer/interview.ts` remain untouched throughout
both the implementation and patch passes.

**Residual risks:** the deferred finding (no real-spawner dispatch proof yet) and the AD-31 fixture gap
are the same underlying wait — both close together once Deep supplies the recorded `claude -p` transcript
for `step.bootstrap`, per the exact steps the implementer's own report and `PENDING_AD31_FIXTURE_CONTRACT_IDS`'s
doc comment already lay out. No other residual risk identified.
