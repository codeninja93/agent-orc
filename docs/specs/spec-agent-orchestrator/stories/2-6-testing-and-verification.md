---
title: 'Step agents — testing and verification with two-tier gate economics'
type: 'feature'
created: '2026-09-22'
status: 'done'
review_loop_iteration: 0
followup_review_recommended: true
baseline_revision: '5f2bf0c'
context:
  - '{project-root}/docs/planning-artifacts/architecture/architecture-agent-orcastrator-2026-09-19/ARCHITECTURE-SPINE.md'
  - '{project-root}/docs/planning-artifacts/architecture/architecture-agent-orcastrator-2026-09-19/ADR-001-tier-2-execution.md'
  - '{project-root}/docs/planning-artifacts/architecture/architecture-agent-orcastrator-2026-09-19/ADR-004-command-execution-as-a-capability.md'
  - '{project-root}/docs/specs/spec-agent-orchestrator/stories/2-5-implementation-agent.md'
deferred:
- summary: 'Review pass 1 ran all four layers; 42 patches applied and two bad_spec causes amended.'
  evidence: '53 findings — high 17, medium 28, low 8 — routed 42 patch, 9 bad_spec, 1 defer, 1 reject.
    Both bad_spec causes were in this spec: a granted tool nothing could serve, and gate outcomes the
    engine computed and did not pass to the step that must report them. The implementing agent stalled
    before filing a report, so the patch round was verified entirely by me — gate, targeted probes and
    my own mutation of the moved guard.'
  severity: low
- summary: 'Nothing under `src/` or `bin/` constructs a Reconciler with a real spawner, runner and recorder.'
  evidence: 'Deliberately out of scope for this story, and the single largest structural gap in the
    project. Story 2-6 makes the assembly possible for the first time — `recorderFor` exists because
    AD-29''s exclusive claim means the loop and the spawner cannot each open a recorder — but no story in
    `stories.yaml` owns the composition root. Every acceptance criterion about a *run* in stages 1 and 2
    is therefore asserted one level down, at ports, options and argv strings.'
  severity: high
- summary: 'The MCP stdio transport has never been spoken to by a real `claude -p`.'
  evidence: 'The server now has an entry point (`bin/runner.ts`, declared in `package.json`) and the
    spawner writes and passes the per-run config, so the grant is no longer inert. What remains untested
    against reality is the transport itself: the handler is driven by writing JSON-RPC lines into a
    stream. The runner *was* driven end to end against a real container (Docker 29.8.0) — a passing gate,
    a gate preserving exit 7, and an empty command skipping without starting one.'
  severity: medium
- summary: 'Whether the AD-31 marker should grow a check covering the command runner.'
  evidence: 'A second daemon-dependent suite was deliberately not added: a silently-skipping container
    suite is the guard-that-cannot-fail pattern, and AD-31''s marker discipline exists precisely so a
    skipped containment suite cannot read as a pass. Extending the marker rather than adding a parallel
    suite is the shape that preserves that discipline, and it is a decision rather than an omission.'
  severity: medium
- summary: 'The promotion trigger still does not match the intent, by decision.'
  evidence: 'Carried from story 2-5 and reaffirmed here now that gates actually run: a schema-invalid
    output still spends the run''s one promotion, because `error.ts` maps `step.schema_invalid_output` to
    `escalate-model-tier`. Narrowing it means removing a row from the AD-35 table that governs every
    agent. Recorded in `promotion.ts`, in its test, and here.'
  location: src/contracts/error.ts
  severity: medium
- summary: 'The Dockerfile''s closing comment is stale and was deliberately left alone.'
  evidence: 'It still describes the wrapper composing the image''s own CLI, which ADR-004 made false.
    Editing it changes the content hash, invalidating the AD-31 marker and forcing a rebuild of roughly
    twenty minutes. `IMAGE_CLI_PATH` is kept and the image still ships the CLI because the AD-31 suite
    executes it from inside and must pass unchanged.'
  location: docker/Dockerfile
  severity: low
---

# Story 2-6 — Testing and verification, with two-tier gate economics

## Intent

**Problem:** ADR-004 removed `Bash` from every built-in agent and named an MCP command-runner as its
replacement. Nothing built it, so **no step can execute anything** — `verification` holds
`promotion_policy: 'on-gate-failure'` for a gate it cannot run, and its purpose string still promises to run
one. `testing` is a declared agent with no phase, so nothing can spawn it. And CAP-13 requires deterministic
gates to run before any model-based review, which nothing sequences.

**Approach:** build the command-runner, repoint the container wrapper at commands as ADR-001 prescribes, give
testing and verification their phases and contracts, and make the gate economics observable: a run that fails
its deterministic gates spends nothing on model-based review.

## Boundaries & Constraints

**The command-runner is the only thing in the system that may start a container, and that must be
structural.** ADR-004: an agent that decides to run a command outside the container fails for lack of a tool.
So the runner is reached only as an MCP tool, served under `--mcp-config` with `--strict-mcp-config` so no
other server can load, and the commands it will run are the profile's `mechanics.commands` — not arbitrary
text. A runner that accepted a command string from the agent would be `Bash` with extra steps.

**`--restricted` means nobody can answer a permission prompt, so the tool must be pre-approved.** The CLI's
own help says `--restricted` "lets only a person or the configured permission tool" approve a tool use. A
`claude -p` run has no person. So the MCP tool is named in `--allowedTools`, and a run that omits it does not
hang — it must fail visibly, because a step waiting for an answer nobody can give is the worst outcome
available.

**CAP-13 names a gate the profile cannot express.** Its success criterion is "deterministic gates
(typecheck, lint, tests) run before any model-based review". `MECHANICS_COMMAND_NAMES` is
`['test','lint','build','run']` — there is no `typecheck`. This story adds it: a profile field, an interview
question, and the AD-28 consequence that a profile written by an older installer lacks it. An empty string is
a legitimate answer, as it already is for `lint` — a repository with no typecheck step records that it has
none, and a gate with no command is skipped rather than failed.

**"No review spend on a failing run" is a claim about cost, and cost is the thing this project refuses to
measure in currency (R10).** So the assertion is about *turns*, not money: a run whose deterministic gates
fail must spawn no model-based review at all. The observable is that no `agent.spawned` event exists for the
review, not that some counter reads zero — a counter can read zero because nothing incremented it.

**The two tiers live inside verification, because there is no review agent.** "Model-based review" appears
exactly once in the spec, in CAP-13's success line, and the roster has no reviewer. So `verification` runs
the declared gates first — deterministic, no model judgement — and only if they pass does it spend model
turns judging the change against the acceptance criteria. A single step with two tiers, not two steps.

**"Judged against criteria fixed before it was written" is a property of provenance, not of good
intentions.** `StepInput.acceptance_criteria` is already carried to every step. What this story must show is
that the criteria the verification step judges against are the ones the run was accepted with — the same
bytes, not a re-derivation — and that a step cannot introduce a criterion of its own to pass against.

**The container wrapper is repointed, not rebuilt.** ADR-001 is explicit: the image, the flag set, the mount
allow-list, the `--rm` rule and story 1-5's AD-31 assertion suite are "all unchanged and all still correct".
What changes is the argv placed inside — a command, not `claude -p`. A rewrite that re-derives the flag set
would throw away the one part of containment that has been verified since stage 1.

**Nothing here lets verification edit what it judges.** ADR-003's reasoning survives ADR-004: `verification`
has no `Write` or `Edit`, and gaining a command runner must not become a way around that. The runner executes
declared commands; it does not write files on the agent's behalf.

## I/O & Edge-Case Matrix

| # | Input / situation | Expected |
|---|---|---|
| 1 | The command-runner MCP server | Runs a named command from the profile's `mechanics.commands`, never a string the agent supplies |
| 2 | An agent asking for a command the profile does not declare | Refused naming the declared commands, never executed |
| 3 | A command that exits non-zero | Reported as a failed gate with its exit status, not as a tool error |
| 4 | A command's output | Returned as an evidence pointer (AD-23), never inlined into the control plane |
| 5 | The runner invoked | Starts exactly one container per command, per ADR-001's per-command lifetime |
| 6 | Anything other than the runner trying to start a container | Impossible: no other unit imports the container package |
| 7 | A spawn whose `--allowedTools` omits the runner | Fails visibly rather than hanging on a permission prompt nobody can answer |
| 8 | A spawn for a phase granted the runner | Carries `--mcp-config`, `--strict-mcp-config` and the tool in `--allowedTools` |
| 9 | `mechanics.commands` | Carries `typecheck` alongside test, lint, build and run |
| 10 | A profile written before `typecheck` existed | Refused with `config.schema_version_unrecognised`, never silently defaulted |
| 11 | A declared command that is the empty string | The gate is skipped and said to be skipped, not failed |
| 12 | `STEP_PHASES` | Carries `testing` alongside the existing four |
| 13 | The standard plan | Runs analysis → planning → implementation → testing → verification |
| 14 | A registered `step.testing` and `step.verification` | Both resolve, export to draft-7, and are distinct shapes |
| 15 | The roster | `testing` declares `step.testing`, `verification` declares `step.verification` |
| 16 | A verification step whose deterministic gates fail | **No model-based review is spawned at all** — asserted by the absence of the event, not by a counter |
| 17 | A verification step whose gates pass | Model-based review runs and judges against the acceptance criteria |
| 18 | The criteria a verification step judges against | Byte-identical to the ones the run was accepted with |
| 19 | A verification output introducing a criterion of its own | Refused: a step cannot invent what it is judged against |
| 20 | A gate that fails | The run's disposition routes per AD-35, and the failure names which gate and its exit status |
| 21 | The container wrapper | Places a command inside, not `claude -p`, with the flag set and mount allow-list unchanged |
| 22 | Story 1-5's AD-31 assertion suite | Still passes unchanged: no push credential inside the container |
| 23 | `verification`'s grant | Still no `Write` or `Edit`; the runner is not a way to write |
| 24 | `testing`'s purpose and `verification`'s purpose | Describe what they can now actually do |
| 25 | The command-runner MCP server | Has an executable entry point declared in `package.json`, so the config's `entryPoint` names something that exists |
| 26 | A run whose step is granted the runner | Its MCP config is written under the run directory and passed as `--mcp-config`, so the spawn does not refuse for want of one |
| 27 | A default `testing` or `verification` spawn | Succeeds through the ordinary path: the grant is served, not inert |
| 28 | A verification step's input | Carries the gate outcomes the engine already computed — the declared line, exit status and evidence pointer — so the model reports them rather than re-running every gate |
| 29 | The `evidence` field of a step input | No longer empty for a verification step; the comment claiming nothing produces one is removed |
| 30 | A verification output's gate report | Checked against the engine's own `gate.*` record, not only for internal consistency |
| 31 | A completed verification output | Reports every gate `DETERMINISTIC_GATE_NAMES` declares, and one verdict per accepted criterion |
| 32 | A `resume-step` action for a verification step | Passes the same gate check the start path does, or states why resuming does not re-gate |
| 33 | A snapshot whose profile cannot be read | Blocks the run; it is distinguished from a snapshot that is absent |
| 34 | An installer re-run over a v1 install | Proceeds: the previous profile is readable for the purpose of re-interviewing, since the re-run is the migration |
| 35 | A repository declaring a `typecheck` script | It is detected, offered as the default and written to the profile — asserted, so the detection table cannot silently empty |
| 36 | A gate whose command times out or is signalled | Reports what happened; the contract accepts it rather than refusing a null exit status |
| 37 | Evidence the redaction pass could not sweep | The drop is reported on the result and in the log, not silent |

## Code Map

| File | Change | Why |
|---|---|---|
| `src/contracts/testing.ts` | new | `step.testing`'s output: the tests written and their provenance. AD-2. |
| `src/contracts/verification.ts` | new | `step.verification`'s output: gate results, then the model judgement. Distinct from testing. |
| `src/contracts/installer.ts` | modify | `mechanics.commands` gains `typecheck`; `schema_version` consequence per AD-28. |
| `src/contracts/registry.ts` | modify | Register both ids. |
| `src/contracts/state.ts` | modify | `STEP_PHASES` gains `testing`. |
| `src/runner/index.ts` | new | The command-runner MCP server: the only unit that may start a container. |
| `src/runner/commands.ts` | new | The declared-command vocabulary and the refusal for anything outside it. |
| `src/container/wrapper.ts` | modify | Repointed at a command per ADR-001; image, flags, mounts and the AD-31 suite unchanged. |
| `src/engine/spawner.ts` | modify | `--mcp-config`, `--strict-mcp-config` and the runner in `--allowedTools` for a phase granted it. |
| `src/engine/reconciler.ts` | modify | The standard plan gains the testing step; the two tiers are sequenced. |
| `src/installer/interview.ts` | modify | The typecheck question; both declarations name their contracts; purposes corrected. |
| `tests/runner.command.test.ts` | new | Matrix 1–6, 11. |
| `tests/contracts.verification.test.ts` | new | Matrix 14, 17–19. |
| `tests/contracts.testing.test.ts` | new | Matrix 14, 15. |
| `tests/engine.gate-economics.test.ts` | new | Matrix 16, 20 — the absence of the review spawn. |
| `tests/container.wrapper.test.ts` | modify | Matrix 21, 22. |
| `bin/runner.ts` | new | The command-runner's executable entry point, so `commandRunnerMcpConfig`'s `entryPoint` names something that exists. |
| `package.json` | modify | Declares that bin. |
| `src/engine/spawner.ts` | modify | Writes the per-run MCP config and passes it, so a granted tool is served rather than inert. |
| `src/contracts/step.ts` | modify | The step input carries the engine's gate outcomes. |
| `src/installer/detect.ts` | modify | Typecheck detection, asserted rather than assumed. |
| `tests/helpers/installer-fixture.ts` | modify | A repository that declares a typecheck script, so detection has something to detect. |

## Tasks & Acceptance

1. **Build the command-runner as a capability.**
   - **Given** a profile declaring its commands, **when** the runner is asked for one by name, **then** it
     runs that command in a container and returns its exit status with output as an evidence pointer.
   - **Given** a request for a command the profile does not declare, **when** the runner receives it,
     **then** it is refused naming the declared commands and nothing is executed.
   - **Given** the engine's source, **when** it is inspected, **then** no unit other than the runner starts a
     container.
2. **Wire the runner into a spawn.**
   - **Given** a phase granted the runner, **when** its argv is built, **then** it carries `--mcp-config`,
     `--strict-mcp-config` and the tool named in `--allowedTools`.
   - **Given** a spawn whose `--allowedTools` omits the runner, **when** it is built, **then** it fails
     visibly rather than producing a step that waits for an answer nobody can give.
3. **Give the profile the gate CAP-13 names.**
   - **Given** `mechanics.commands`, **when** it is read, **then** it carries `typecheck`.
   - **Given** a profile written before `typecheck` existed, **when** it is read, **then** it is refused with
     `config.schema_version_unrecognised`.
   - **Given** a declared command that is empty, **when** the gate runs, **then** it is skipped and said to
     be skipped.
4. **Give testing and verification their phases and contracts.**
   - **Given** `STEP_PHASES`, **when** it is read, **then** it carries `testing`, and the standard plan runs
     the five steps in order.
   - **Given** the roster, **when** each declaration is read, **then** `testing` names `step.testing` and
     `verification` names `step.verification`.
5. **Make the gate economics observable.**
   - **Given** a verification step whose deterministic gates fail, **when** the pass completes, **then** no
     model-based review was spawned, asserted by the absence of the spawn event.
   - **Given** gates that pass, **when** verification continues, **then** the model judgement runs against
     the acceptance criteria.
6. **Fix the criteria to what the run was accepted with.**
   - **Given** a verification step, **when** it judges, **then** the criteria are byte-identical to the ones
     the run was accepted with.
   - **Given** an output introducing a criterion of its own, **when** it is parsed, **then** it is refused.
7. **Repoint the container wrapper without rebuilding it.**
   - **Given** the wrapper, **when** it wraps a step's work, **then** a command is placed inside rather than
     `claude -p`, and the flag set, image and mount allow-list are unchanged.
   - **Given** story 1-5's AD-31 suite, **when** it runs, **then** it passes unchanged.

## Spec Change Log

### 2026-09-22 — amended by review pass 1 (two `bad_spec` root causes, nine rows, both in this spec)

**Triggering findings.** BH8 / EC11 / EC21 / VG5 / IA-3.1 / IA-3.2 — nothing serves the MCP tool the roster
now grants: `commandRunnerMcpConfig` and `serveCommandRunnerOverStdio` have no caller, `package.json` declares
one bin, and `mcpConfigs` is supplied nowhere in `src/`, so the first real assembly throws
`McpToolNotPreApproved` on every testing or verification spawn. BH4 / EC8 / IA-3.5 — the engine computes each
gate's declared line, exit status and evidence pointer, emits them as events, and then hands the step
`evidence: []`, while `step.verification` *requires* the model to report exactly those facts.

**What was amended.** Matrix rows 25–37. Rows 25–27 make the served tool real rather than inert. Rows 28–31
carry the engine's gate outcomes into the step input and check the report against them, so the model states
what ran rather than re-running it — which would have doubled the container time CAP-13's economics exist to
save. Rows 32–37 cover the resume path, the unreadable snapshot, the installer's own upgrade route, typecheck
detection, a timed-out gate, and an unsweepable evidence file. The Code Map gained `bin/runner.ts`,
`package.json`, `src/contracts/step.ts`, `src/installer/detect.ts` and the installer fixture.

**The known-bad state avoided.** A story that grants a capability nothing can serve. The roster now declares
`RunDeclaredCommand` for two agents, and the spawner refuses any argv granting a tool with no config — so the
shipped behaviour of "gates run" was "the run blocks", and every acceptance criterion about the argv held only
for a caller supplying the config by hand. The second: a contract requiring the model to report facts the
engine already has and does not pass in, which is an invitation to invent them.

**Not amended, deliberately.** The wider gap — that nothing under `src/` or `bin/` constructs a `Reconciler`
with a real spawner, runner and recorder — stays a `high` deferred entry. It has been open since stage 1, it
is not this story's to close, and no story in `stories.yaml` owns it. And the promotion trigger stays as the
AD-35 table defines it: the intent's "only on a failed verification gate" remains an accepted deviation,
because narrowing it changes behaviour for every agent.

**KEEP instructions — what worked and must survive.** (1) The runner taking a declared command *name* over a
`z.strictObject`, so an arbitrary command is structurally inexpressible. (2) The absence assertion for the
review spawn, with its positive control in the same suite. (3) Per-artifact `schema_version` — now ADR-005,
accepted — and the verified premise behind it. (4) Story 1-5's AD-31 suite and `docker/Dockerfile` untouched:
the wrapper is repointed, not rebuilt. (5) `container.start_failed` distinguished from a failing gate, and the
step attempt folded into the container name. (6) The fail-closed direction throughout: declared gates with no
runner blocks the run rather than reviewing unverified work.


## Review Triage Log

### 2026-09-22 — Review pass
- verdicts: 53 findings — high 17, medium 28, low 8, false 0, maybe-false 0
- findings:
  - `[high]` `[patch]` BH1 — re-running the installer on a v1 install is a hard refusal whose message says to re-run the installer. Verified: `readExistingInstall` calls `assertReadableVersion`, which throws for `schema_version: 1`, and the refusal ends "Re-run the installer to migrate". Every existing install has no route forward.
  - `[high]` `[patch]` BH2 — an unreadable profile snapshot silently disables the gates. Verified: `declaredCommands` swallows every throw into `null` and `runGatesBeforeReview` returns `true` on `null`, so the review is spawned with no gate events at all. A v1 snapshot — exactly what this story's version bump creates — raises `SchemaVersionRefusal` there and lands in that branch. The docblock defends it as "no snapshot", conflating absent with unreadable.
  - `[medium]` `[patch]` BH3 — the evidence file name omits the step attempt, so a re-run overwrites the failing gate's log and the first termination's pointer resolves to the wrong bytes. `containerFor` already folds the attempt in; the pointer does not.
  - `[high]` `[bad_spec]` BH4 — the gate outcomes the engine computed are never handed to the verification step, while `step.verification` requires the model to report every gate with its declared line, exit status and evidence path. The model must re-run every gate — doubling the container time CAP-13's economics exist to save — or invent the facts.
  - `[medium]` `[patch]` BH5 — `step.verification` describes `gates` as "every deterministic gate CAP-13 names, each reported once" and enforces only uniqueness, so a completed output reporting one gate or none parses.
  - `[medium]` `[patch]` BH6 — `criteriaNotAccepted` is one-directional: nothing requires the accepted criteria to have been judged, so a verification judging one of five criteria completes cleanly against a describe saying "one verdict per acceptance criterion".
  - `[medium]` `[patch]` BH7 — the spawner derives both sides of the pairing check from `allowedToolsFor(grant)`, so the guard documented as unable-to-fail-if-derived is derived. Only `missingPreApprovals` over the executed argv retains teeth.
  - `[high]` `[bad_spec]` BH8 — nothing serves the MCP tool the roster now grants. `commandRunnerMcpConfig` and `serveCommandRunnerOverStdio` have no caller in `src/` or `bin/`, `package.json` declares one bin, and `mcpConfigs` is supplied nowhere — so the first real assembly throws `McpToolNotPreApproved` on every testing or verification spawn.
  - `[medium]` `[patch]` BH9 — the tool name is spelled twice, as `MCP_TOOL_CLI_NAMES.RunDeclaredCommand` and `RUNNER_TOOL_NAME`, despite a comment claiming the runner imports rather than respells it. Only a test keeps them in step.
  - `[medium]` `[patch]` BH10 — `handleMcpRequest` flattens every failure into `-32602 invalid params`, so a step cannot tell an undeclared command (`config.invalid`, escalate-to-human) from a daemon that was restarting (`container.start_failed`, retry-with-backoff) — the distinction the runner spends a whole class establishing.
  - `[medium]` `[patch]` BH11 — raw container stderr reaches the control plane unredacted: `CommandRunFailed` interpolates `result.stderr` and the reconciler records `renderCause(thrown)` into `events.jsonl`, while the same bytes going to the evidence file are swept. AD-21's own argument applies at least as strongly to the log.
  - `[high]` `[patch]` BH12 — ADR-005 documents a change to `INSTALLER_VERSION_BY_SCHEMA_VERSION` the diff does not make. Verified: the map is `{1: '0.1.0'}` and `installerVersionFor(2)` is `null`, while the ADR's Consequences say it "now maps two profile versions to one installer version". Mine, and the second ADR in a row asserting an intended consequence as an accomplished fact.
  - `[medium]` `[patch]` BH13 — `parseVersionedArtifact` recovers its refusal by string surgery on the message and lost the success-path `assertRecognisedSchemaVersion` the previous comment kept deliberately, so a hand-rolled versioned schema now gets no AD-28 check at all.
  - `[low]` `[patch]` BH14 — `MECHANICS_COMMAND_NAMES`' comment claims the order of `build-sequencing.md` question 3. Verified false: that line reads "test, lint, build and run"; the constant is `['typecheck','lint','test','build','run']`, and the interview literal and `SCRIPT_CANDIDATES` use a third order.
  - `[medium]` `[patch]` BH15 — `DECLARED_COMMAND_NAMES` re-exports all five mechanics, so a step may ask for `run` and sit until the 15-minute timeout kills it, recorded as a failed gate; and none of `gate.passed|failed|skipped` or `verification.review_skipped` is rendered by the TUI, so the skip a person most needs to see is invisible.
  - `[medium]` `[patch]` EC1 — the evidence pointer omits the step attempt; same root cause as BH3.
  - `[medium]` `[patch]` EC2 — `planFor` consumes the attempt counter, so the argv asserted through it is not the argv `run` executes; names and evidence diverge between the two.
  - `[medium]` `[patch]` EC3 — a `null` exit status from a timeout or signal yields `outcome: 'failed'` with `exit_status: null`, which `step.verification` then refuses, so the step cannot state what actually happened.
  - `[medium]` `[patch]` EC4 — `build` and `run` are callable as gates; same root cause as BH15.
  - `[medium]` `[patch]` EC5 — command output over the 16 MB serialisation cap is dropped entirely rather than truncated, making the failure reason unrecoverable.
  - `[medium]` `[patch]` EC6 — the stdio transport never answers a final unterminated line and ignores stream errors, so a step waits for a reply that never comes.
  - `[medium]` `[patch]` EC7 — a throw from the `gates` factory itself escapes the reconcile pass uncaught, unlike a throw from `runner.run`.
  - `[high]` `[bad_spec]` EC8 — the engine's gate results are not placed in the verification step input; same root cause as BH4.
  - `[medium]` `[patch]` EC9 — a completed output reporting an empty or partial `gates` array parses; same root cause as BH5.
  - `[high]` `[patch]` EC10 — the bare `catch` turns a profile schema refusal into "nothing is declared"; same root cause as BH2.
  - `[high]` `[bad_spec]` EC11 — every default testing or verification spawn throws because nothing supplies an mcp-config; same root cause as BH8.
  - `[medium]` `[patch]` EC12 — `GateRunRequest.commands` is `Record<string,string>` while `CommandRunnerOptions` wants `MechanicsCommands`, so a real assembly cannot pass one to the other without a cast.
  - `[medium]` `[patch]` EC13 — `missingPreApprovals` reads the token after the first `--allowedTools`, so a duplicated flag, a trailing flag or one appearing as another flag's value defeats the check that exists to stop a hang.
  - `[medium]` `[patch]` EC14 — a grant naming only MCP tools filters down to `--tools ""`, which disables all tools and is indistinguishable from a declaration granting nothing.
  - `[medium]` `[patch]` EC15 — the success-path AD-28 assertion was deleted; same root cause as BH13.
  - `[low]` `[patch]` EC16 — `GateSummary` is a newly-dead exported type. Verified: declared at `reconciler.ts:896`, referenced nowhere.
  - `[medium]` `[patch]` EC17 — `StepSpawnerOptions.wrap` is orphaned. Verified: the option survives while the container wrapper is deliberately no longer assignable to it, asserted with `@ts-expect-error`. The seam ADR-001 designated has no implementation that can fill it.
  - `[low]` `[patch]` EC18 — the order claim; same root cause as BH14.
  - `[low]` `[patch]` EC19 — the interview's refusal text still says "the four commands beside it are free text" when there are now five.
  - `[medium]` `[patch]` EC20 — the `allowedTools` doc claims it is not defaulted from `mcpTools` so the guard can fail; the only production call site passes the same value to both. Same root cause as BH7.
  - `[high]` `[bad_spec]` EC21 — matrix row 8's criterion holds only for a caller that supplies the config by hand; same root cause as BH8.
  - `[high]` `[patch]` VG1 — `typecheck` script detection is exercised by no test. Verified: the installer fixture declares no `typecheck` script and nothing asserts `mechanics.typecheck` is suggested, so deleting the detection table leaves every install writing `typecheck = ""` — recorded as skipped — with a green suite. CAP-13's gate would be silently absent on every repository that has one.
  - `[high]` `[patch]` VG2 — the spawner's "a step cannot invent a criterion" refusal has no test; only the pure helper is covered, and no transcript fixture carries `judgements`, so the non-empty branch is unreachable in any suite. Matrix row 19 is unenforced in the only place holding both halves.
  - `[medium]` `[patch]` VG3 — the AD-21 fail-closed branch in the runner's evidence writer is unasserted: the one redaction test drives a small stdout, so only the success arm runs, and writing `body` unconditionally still passes.
  - `[medium]` `[patch]` VG4 — `Reconciler.close()` no longer closing a caller-supplied recorder is unasserted; `Recorder.close()` is idempotent, so removing the guard leaves the suite green while a real caller loses AD-29's claim out from under it.
  - `[high]` `[bad_spec]` VG5 — nothing serves the MCP tool, and `commandRunnerMcpConfig`'s output shape is asserted by no test; same root cause as BH8.
  - `[medium]` `[patch]` VG6 — the runner's AD-21 failure has no way to be reported: `CommandRunResult` carries no field saying the evidence was dropped, so a dropped gate log is indistinguishable from one that was written, while every other unit throws `RedactionFailedError` and appends `redaction.failed`.
  - `[medium]` `[patch]` VG7 — a container that would not start is reported over MCP as a bad call; same root cause as BH10.
  - `[low]` `[patch]` VG8 — `runPaths().evidenceDir` is dead: the runner composes the same path itself, so there are two spellings with nothing holding them together.
  - `[low]` `[patch]` VG9 — `NEXT_UP_BY_PHASE.testing` is unpinned; only the wording is at risk, since the record's totality is compiler-enforced.
  - `[high]` `[bad_spec]` IA-3.1 — the gate tier is an injected option nothing injects, so the shipped behaviour of "gates run" is that the run blocks. Same root cause as BH8.
  - `[high]` `[bad_spec]` IA-3.2 — the MCP surface the runner is reached through has no production caller, so matrix row 8's assertions are about argv built from options no production path supplies.
  - `[high]` `[patch]` IA-3.3 — the loop-side economics and the contract-side refusals are asserted in disjoint worlds: the gate-economics suite declares its verify step `step.output`, so `criteriaNotAccepted` returns `[]` vacuously and no test drives a verification step both gated by the loop and parsed by its own contract.
  - `[high]` `[patch]` IA-3.4 — "fixed before it was written" is enforced against this pass's plan input rather than the run's recorded acceptance. Verified: all three uses read `plan.acceptance_criteria`, re-invoked every pass, and `spec.recorded` is written but never read back as the authority.
  - `[high]` `[bad_spec]` IA-3.5 — the engine runs the gates and hands the step `evidence: []` under a comment this story falsified; same root cause as BH4.
  - `[medium]` `[patch]` IA-3.6 — the gate check sits on the start path only: `resume-step` calls `executor.resume` with no gate call. Verified.
  - `[low]` `[defer]` IA-3.7 — scope beyond the two sentences: per-artifact `schema_version` with its proposed ADR, the container wrapper repoint, and the `GRANTABLE_TOOLS` split. Each is a downstream consequence of ADR-004 or of adding one profile field, and each is recorded.
  - `[low]` `[reject]` IA-3.8 — that "spends nothing" is rendered as the absence of one event rather than read from a usage ledger. Deliberate: R10 refuses currency, the story's own prose says turns, and the absence assertion carries a positive control.

## Design Notes

## Verification

Run by me after the patch round, exit status captured to a variable and output kept in a file:
`npm run typecheck && npm run lint && npm run build && npm test` — **exit 0, 2366 tests across 79 files, zero
failures, zero skips.** Baseline `5f2bf0c` was 2213/75; the implementation reached 2338/79 and the review's
patches took it to 2366/79.

**The implementing agent stalled before filing a report**, so unlike previous rounds nothing here is taken on
its account. Everything below I checked myself.

- `installerVersionFor(2)` now answers `0.1.0`, so the map matches ADR-005's corrected Consequences rather
  than the ADR describing a change the code had not made.
- `.memlog.md` carries the ADR-005 decision line.
- `mechanics.typecheck` is asserted as a suggestion, and the installer fixture declares a `typecheck` script
  with the reasoning recorded beside it — so emptying the detection table can no longer leave every install
  writing `typecheck = ""` with a green suite.
- A real `verification-invented-criterion.jsonl` transcript is driven through the spawner in four tests, so
  the "a step cannot invent a criterion" refusal is reachable where both halves are held.
- The AD-21 fail-closed branch asserts both the placeholder *and* that the result says the output was
  dropped — which also closes the separate finding that a dropped gate log was indistinguishable from one
  that was written.
- **The moved guard bites.** D5 removed `allowedTools` from `StepArgvOptions` and moved the translation
  inside `buildStepArgv`, leaving one source rather than two a call site could quietly make agree. Moving a
  check is only an improvement if it can still fail in its new home, so I mutated it: dropping the
  `--allowedTools` emission fails **4 tests**. Tree restored, no residue.

## Auto Run Result

**Status: done, reviewed.** The command-runner is served rather than inert, the engine's gate outcomes reach
the step that must report them, both silent-failure paths now block, and a run failing its deterministic
gates spawns no model-based review.

**Review findings: 53 across four layers** — high 17, medium 28, low 8, the heaviest pass in the project so
far. Routed 42 patch, 9 bad_spec, 1 defer, 1 reject. All 42 patches applied.

**Both `bad_spec` causes were in this spec.** The first: the roster granted `RunDeclaredCommand` to two
agents while nothing served it — no entry point, no config writer, no caller — and `buildStepArgv` refuses
any argv granting a tool with no config. So the shipped behaviour of "gates run" was "the run blocks", and
every acceptance criterion about the argv held only for a caller supplying the config by hand. The second:
the engine computed each gate's declared line, exit status and evidence pointer, emitted them, and then
handed the step `evidence: []` under a comment saying nothing produced one yet — which this story falsified —
while the contract *required* the model to report exactly those facts. A contract demanding facts the engine
has and withholds is an invitation to invent them.

**Two silent-failure paths were the most dangerous findings.** An unreadable profile snapshot disabled the
gates entirely: `declaredCommands` swallowed every throw into `null` and the gate runner read `null` as
"nothing declared", spawning the review with no gate events at all — and a v1 snapshot, exactly what this
story's own version bump creates, raised a `SchemaVersionRefusal` into that branch. The docblock defended it
as "no snapshot", conflating absent with unreadable, which is the same distinction story 2-3's review drew
for the roster directory. Separately, re-running the installer on a v1 install was a hard refusal whose
message told you to re-run the installer.

**The sharpest finding for what it says about the suite:** `typecheck` detection was exercised by no test.
The installer fixture declared no such script, so emptying the detection table would have left every
repository with `typecheck = ""` — recorded as *skipped* — and the whole suite green. CAP-13's gate would
have been silently absent on every install that had one, which is precisely the "a repository with no tests
reads as verified" outcome this story's own prose argues against.

**Rejected, with reason.** One: that "spends nothing" is rendered as the absence of an event rather than read
from a usage ledger. Deliberate — R10 refuses currency, the story's prose says turns, and the absence
assertion carries a positive control in the same suite.

**Follow-up review recommended: true.** The specific unverified risk is the MCP stdio transport: the server
now has an entry point and the spawner writes its config, but the handler is still driven by writing JSON-RPC
lines into a stream rather than by a real `claude -p`.

**Residual risks.** Six deferred entries, one `high` — and it is the largest structural gap in the project:
nothing under `src/` or `bin/` constructs a `Reconciler` with a real spawner, runner and recorder. Stage 2
makes that assembly possible for the first time and no story in `stories.yaml` owns it, so every acceptance
criterion about a *run* across both stages is asserted one level down.
