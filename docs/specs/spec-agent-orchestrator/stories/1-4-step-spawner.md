---
title: 'Step spawner — the claude -p subprocess contract'
type: 'feature'
created: '2026-09-20'
status: 'done'
review_loop_iteration: 0
followup_review_recommended: true
context:
  - '{project-root}/docs/planning-artifacts/architecture/architecture-agent-orcastrator-2026-09-19/ARCHITECTURE-SPINE.md'
  - '{project-root}/docs/specs/spec-agent-orchestrator/SPEC.md'
  - '{project-root}/docs/specs/spec-agent-orchestrator/stories/1-3-engine-reconciler.md'
warnings: ['oversized'] # 9 files and 14 I/O scenarios; AD-1 is the densest single AD in the spine
deferred:
  - summary: >-
      RESOLVED: the tier-2 execution conflict this story recorded was accepted as ADR-001.
    evidence: |-
      RESOLVED 2026-09-20: ADR-001-tier-2-execution.md was accepted and AD-1, AD-20 and AD-20's egress line amended in the spine, which moves the containment boundary from
      the agent process to the commands the agent runs. The decisive finding is that the subscription
      credential is in the macOS keychain rather than a file, so no mount can put it inside a
      container — making AD-20's container and AD-1's subscription-only auth incompatible on the
      stated primary platform. The ADR is proposed, not accepted; it awaits Deep's sign-off and amends
      AD-1 and AD-20, which live in an adopted companion this session does not own.
    location: >-
      docs/planning-artifacts/architecture/architecture-agent-orcastrator-2026-09-19/ADR-001-tier-2-execution.md
    severity: high
  - summary: >-
      CONTRACT CONFLICT, UNRESOLVED AND ESCALATED: --restricted strips every code-running tool unless
      --tools names them, and no spawn passes --tools.
    evidence: |-
      VERIFIED by the parent against the installed CLI 2.1.278 help text: '--restricted ... removes
      the built-in tools that run commands or code (Bash, PowerShell, REPL and the other code-running
      tools) and WebFetch unless --tools names them'. AD-1 mandates --restricted on every spawn;
      CAP-13 requires deterministic gates (typecheck, lint, tests) to run before any model-based
      review. A step agent spawned exactly as AD-1 specifies can edit files but cannot run tests,
      lint, typecheck or git, so stories 2-5, 2-6 and 2-7 cannot do their jobs as specified. Story 1-4
      is correct against its own spec; the specs conflict. Three options were put to the user: pass
      --tools naming what steps need; drop --restricted and rely on AD-20's container for containment
      (the parent's recommendation, since a read-only root, dropped capabilities and an egress
      allowlist bound a Bash tool far more meaningfully than a flag does); or split the flag by step
      kind. The second and third amend ARCHITECTURE-SPINE.md, an adopted companion. NOT RESOLVED —
      awaiting the user's decision before story 2-5.
    location: >-
      src/engine/spawner.ts, ARCHITECTURE-SPINE.md AD-1, SPEC.md CAP-13
    severity: high
  - summary: >-
      No suite wires the real spawner into the reconciler, so every loop-facing expectation is
      asserted at the spawner's return value.
    evidence: |-
      The intent phrases several expectations about the loop ('the loop never receives an output the
      executor has not validated'). Those are proven at createStepSpawner's boundary, not through
      reconciler.ts. The first real integration arrives with the step agents in 2-4 onward, and the
      reconciler's new catch of spawner rejections is the intended interaction but is exercised only
      against the scripted double.
    location: >-
      tests/engine.spawner.test.ts
    severity: medium
  - summary: >-
      A run has no cost or token accounting: total_cost_usd, usage and modelUsage are parsed and
      discarded.
    evidence: |-
      The event log is the only observability surface, so CAP-16's 'consumption is visible without
      issuing a command' has nothing to read. Belongs with AD-24's ceilings in story 2-9, which is
      also where the unbounded-retry deferrals from 1-3 and 1-4 land.
    location: >-
      src/engine/stream.ts, src/engine/spawner.ts
    severity: medium
  - summary: >-
      Permanently-failing result subtypes and an argv the CLI rejects are both mapped to retryable
      codes.
    evidence: |-
      error_prompt_too_long and error_max_tokens cannot be cleared by a retry, and a usage error means
      the CLI will never accept those bytes, yet both route to retry-with-backoff. Combined with the
      unbounded retry deferred in story 1-3 this is an infinite loop on a permanent failure. Wants
      2-9's ceilings plus a non-retryable classification.
    location: >-
      src/engine/spawner.ts
    severity: medium
  - summary: >-
      An orphaned child cannot be found or reaped from the log after an engine crash.
    evidence: |-
      agent.spawned records no pid and `live` is in-memory only, while AD-32 makes reclamation a
      reconcile action. A child that outlives its engine is currently invisible to the sweep story 1-6
      will build.
    location: >-
      src/engine/spawner.ts
    severity: medium
  - summary: >-
      Auth resolved by apiKeyHelper, managed settings or --settings is caught only after a process has
      run.
    evidence: |-
      assertSubscriptionAuth reads four environment variables, so 'refused before any spawn' holds
      only for those. Every other path the CLI can resolve a credential through is caught by the
      in-stream apiKeySource check, which now works and is now tested, but fires after the child ran.
    location: >-
      src/engine/cli.ts
    severity: medium
  - summary: >-
      The claude CLI version floor is duplicated between cli.ts and the spine's Stack table, and the
      pinned floor exceeds what the code exercises.
    evidence: |-
      The Node floor is deliberately read from package.json so it cannot gain a third home; the CLI
      floor is a literal whose only test restates it, so it drifts silently from the doc. Separately
      the floor 2.1.259 is justified by --permission-prompts, which buildStepArgv never passes, so no
      test ties the floor to a feature.
    location: >-
      src/engine/cli.ts
    severity: medium
  - summary: >-
      A permission denial alongside a completed status leaves permission.denied's escalate-to-human
      disposition unreachable.
    evidence: |-
      A refused tool call completes silently. Whether a denial should force a blocked termination is a
      policy question for the roster stories rather than a spawner bug.
    location: >-
      src/engine/spawner.ts
    severity: medium
  - summary: >-
      PROCESS NOTE: the parent generated 1-4's review diff from an explicit file list and omitted
      tests/engine.reconciler.test.ts.
    evidence: |-
      All four layers therefore reviewed a diff that would fail its own suite, and reported that as a
      finding. The commit and the tree are correct. Recorded because it cost four reviewers attention
      on an artifact of the parent's filtering, and because a future review should diff a commit range
      rather than a file list.
    severity: low
baseline_revision: '26ec37cce1805f516f9dbfe480a129c57df25305'
---

<intent-contract>

## Intent

**Problem:** Story 1-3 defined the `StepExecutor` port and drives a scripted double, so no step has ever actually run. Nothing spawns `claude -p`, nothing captures a session id from a real subprocess, and nothing re-parses a model's `structured_output` before the loop accepts it — which means AD-1's spawn contract, the one place the system's permission surface and failure model are fixed, is entirely unimplemented.

**Approach:** Implement the real `StepExecutor` in `src/engine/`: resolve and validate the `claude` CLI and an absolute Node path meeting the floor, spawn exactly one `claude -p` per step with the AD-1 flag set, parse the `stream-json` output into recorder events, report the session id the instant it appears, and re-parse `structured_output` against the originating Zod schema before returning a termination.

## Boundaries & Constraints

**Always:**
- Exactly one `claude -p` process per step attempt, spawned with `--json-schema` carrying the registered contract's draft-7 export, `--output-format stream-json`, `--strict-mcp-config` and `--restricted`, so the target repository's own `.mcp.json` and hooks cannot introduce tools or credentials.
- Bare mode is forbidden positively, not by absence of a flag: subscription authentication is asserted before any spawn and the executor refuses to run if the CLI resolves to API-key mode.
- The `claude` CLI version is asserted at or above the pinned floor, and refusal names the required version.
- `structured_output` is re-parsed against the originating Zod schema before a `completed` termination is returned. The loop never receives an output the executor has not validated.
- The session id is reported through `onSessionId` the moment the subprocess reports it, before the step can be interrupted, and at most once per attempt.
- An absolute path to a Node executable satisfying the declared floor is resolved once and passed to every child rather than relying on `PATH`; the resolved version is recorded to the event log.
- Every observable thing the subprocess does is emitted through the runtime recorder, never written to the log directly and never to stdout. `parent_tool_use_id` and `session_id` are preserved verbatim from the stream.
- A termination is a value: `completed`, `failed`, `blocked`, `interrupted` and `killed` are ordinary returns. Only a refused resume and an impossible spawn throw, exactly as the port declares.
- Resume is attempted only for an `interrupted` disposition and only with the recorded session id; a refused resume throws `ResumeRefused` and never retries the same id.
- The Claude Agent SDK is never linked as a library; permission plumbing is parsed from the JSON stream.
- `src/engine/` continues to import only from `src/contracts/`, `src/runtime/` and `node:` builtins.

**Never:**
- No docker invocation and no container flags — AD-20 gives one wrapper sole ownership of those, and it is story 1-5. Leave a seam the wrapper plugs into rather than composing a single flag here.
- No MCP server implementation (story 2-10). This story passes `--mcp-config` for servers it is given and asserts `--strict-mcp-config`; it does not create one.
- No changes to `src/engine/reconciler.ts` or to the `StepExecutor` port's shape. If the port turns out to be wrong, stop and say so rather than editing the loop to fit.
- No ceilings, degradation or hibernation (story 2-9), and no model-rung promotion policy — the rung arrives on the request.
- Never spend a real model call in the test suite. Tests drive a fake CLI and recorded stream fixtures.
- Never write `events.jsonl` directly and never assign `seq`.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Step completes | A stream ending in a valid `structured_output` | `completed` termination carrying the re-parsed output | No error expected |
| Output fails its schema | A `structured_output` that does not satisfy the contract | Not accepted as `completed`; termination is `failed` carrying a schema error code | The invalid output never reaches the loop |
| Session id appears | A stream announcing a session id mid-run | `onSessionId` is called once, before the termination resolves | No error expected |
| Spawn flags | Any step attempt | The argv contains `--json-schema`, `--output-format stream-json`, `--strict-mcp-config` and `--restricted` | A missing required flag is a defect the suite fails on |
| API-key mode | A CLI resolving to API-key authentication | Refused before any spawn, naming subscription auth as the requirement | Non-zero refusal, no process created |
| CLI below the floor | A `claude` older than the pinned minimum | Refused naming the required version | No process created |
| CLI absent | No `claude` on the resolved path | `StepSpawnFailed` | Thrown, not returned as a termination |
| Child Node version | Any spawn | The child is given an absolute Node path meeting the floor, and the resolved version is recorded | A `PATH` Node below the floor is never used |
| Subprocess killed externally | The child dies on a signal without terminating cleanly | `interrupted` disposition, with the session id if one was reported | No throw; the loop decides the recovery |
| Resume succeeds | An `interrupted` step and a live session id | `completed` termination from the resumed session | No error expected |
| Resume refused | A session the CLI no longer has | `ResumeRefused` thrown carrying `step.resume_failed` | Never a second resume against the same id |
| Unparseable stream line | A line that is not JSON, mid-stream | Recorded and skipped; the step still terminates | No crash, no torn parse |
| Tool use in the stream | A tool-use event carrying `parent_tool_use_id` | An `agent.tool_used` event with that id preserved verbatim | No error expected |
| Permission denied in the stream | A denial event | A `permission.denied` event is emitted | No error expected |

</intent-contract>

## Code Map

Story 1-3 (`26ec37c`) shipped `src/engine/` with the `StepExecutor` port at `src/engine/executor.ts` and a `ScriptedExecutor` double beside it. This story adds the real implementation next to them. The spine's Structural Seed places the spawner in `src/engine/`, not a new top-level directory.

- `src/engine/cli.ts` -- create; locate the `claude` binary, read its version, assert the pinned floor, and assert subscription authentication with an explicit refusal for API-key mode
- `src/engine/node-path.ts` -- create; resolve an absolute Node executable satisfying the declared floor once, for passing to every child (AD-28)
- `src/engine/stream.ts` -- create; parse `--output-format stream-json` lines into a typed sequence: session id, tool uses, permission denials, the terminal `structured_output`, and unparseable lines as a recorded skip
- `src/engine/spawner.ts` -- create; the real `StepExecutor`: build argv, spawn one child per attempt, drive the stream parser, emit through the recorder, re-parse `structured_output`, and map exit to a disposition
- `src/engine/index.ts` -- modify; export the spawner alongside the port
- `tests/engine.cli.test.ts` -- create; version floor refusal, API-key-mode refusal, absent binary
- `tests/engine.stream.test.ts` -- create; every stream shape including the unparseable line, driven from recorded fixtures
- `tests/engine.spawner.test.ts` -- create; argv assertions, session-id timing, disposition mapping, schema rejection, resume and refused resume
- `tests/helpers/fake-claude.ts` -- create; a Node script that impersonates `claude -p`, replaying a named fixture to stdout and exiting with a chosen code, so no test spends a model call
- `tests/fixtures/stream-json/*.jsonl` -- create; at least one **recorded real** `claude -p --output-format stream-json` transcript, plus derived variants for the error shapes

Read-only evidence, authoritative and not to be edited by this story:

- `ARCHITECTURE-SPINE.md` -- AD-1 (the spawn contract, in full), AD-5 (passthrough fields), AD-8 (session id and resume), AD-13 (external reads recorded), AD-23 (planes), AD-28 (Node floor, absolute child path); the Stack table's `claude` CLI floor and model rungs
- `src/engine/executor.ts` -- the port, its termination shape, `ResumeRefused`, `StepSpawnFailed`, and the double this story must keep compatible
- `src/contracts/registry.ts` -- `exportContract` produces the draft-7 schema for `--json-schema`
- `src/runtime/index.ts` -- the `Recorder` every event goes through

Carried forward from stories 1-1 through 1-3:

- `exportContract` already emits draft-7 and the subset guard already holds step contracts inside the structured-outputs subset, so `--json-schema` should be fed the registry's export rather than a hand-built schema.
- Story 1-3 widened the AD-21 allow-list to six envelope fields by field path. `session_id` and `parent_tool_use_id` are two of them, so a stream id survives the pass — but only when proven free of every credential class. A stream that carries a credential in one of those fields drops the artifact.
- Story 1-1 recorded a real `structured_output` fixture by invoking the CLI once and committing the result. The same discipline applies here: the stream-json fixture must be recorded, not invented, or the parser is tested only against its own assumptions.

## Tasks & Acceptance

**Execution:**
- `src/engine/node-path.ts` -- resolve an absolute Node path meeting the floor once and expose it for children -- AD-28 exists because a stale version-manager `PATH` hands a child a Node below the floor and the failure reads as an opaque syntax error
- `src/engine/cli.ts` -- locate `claude`, assert the pinned version floor, and refuse API-key mode before any spawn -- AD-1 forbids bare mode positively rather than by omission
- `src/engine/stream.ts` -- parse the `stream-json` sequence into typed records, skipping and recording an unparseable line -- the stream is the only permission and telemetry surface, since the SDK is not linked
- `src/engine/spawner.ts` -- build the AD-1 argv, spawn one child per attempt, report the session id the instant it appears, emit tool uses and denials through the recorder, and re-parse `structured_output` before returning `completed` -- an unvalidated output reaching the loop is the drift AD-1's re-parse rule exists to stop
- `src/engine/spawner.ts` -- map process outcome to a disposition: clean terminal output to `completed` or `failed`, a signal without a terminal output to `interrupted`, and an executor-initiated stop to `killed` -- only `interrupted` is resumable, so the mapping is what makes AD-8 reachable
- `src/engine/spawner.ts` -- implement `resume` with the recorded session id, throwing `ResumeRefused` when the session is gone -- AD-8's fallback is a baseline reset and re-run, which the loop already owns
- `src/engine/index.ts` -- export the spawner -- story 1-3's loop takes the port by injection, so nothing in the reconciler changes
- `tests/helpers/fake-claude.ts`, `tests/fixtures/stream-json/*.jsonl` -- record one real transcript and add a fake CLI that replays fixtures -- spending a model call per test run is neither affordable nor deterministic
- `tests/engine.{cli,stream,spawner}.test.ts` -- cover every matrix row, asserting the argv flag set explicitly -- a missing `--restricted` or `--strict-mcp-config` silently widens the permission surface, which is exactly what AD-1 fixes

**Acceptance Criteria:**
- Given a clean checkout on Node `>=22.22`, when `npm run typecheck && npm run lint && npm test && npm run build` is run, then all four succeed and the new engine suites appear in the test output.
- Given any step attempt, when the executor builds its argv, then it contains `--json-schema` with the registered contract's draft-7 export, `--output-format stream-json`, `--strict-mcp-config` and `--restricted`, and the child's interpreter is an absolute Node path meeting the floor.
- Given a CLI that resolves to API-key authentication, or whose version is below the pinned floor, when the executor prepares to spawn, then it refuses before creating any process and the message names what was required.
- Given a stream whose terminal `structured_output` does not satisfy the contract, when the attempt ends, then the termination is not `completed` and the invalid output is never returned to the loop.
- Given a stream that announces a session id, when the attempt is still running, then `onSessionId` has already been called exactly once with that id.
- Given a child that dies on a signal with no terminal output, when the attempt ends, then the disposition is `interrupted` and no exception is thrown.
- Given an `interrupted` step whose session the CLI no longer has, when `resume` is called, then `ResumeRefused` is thrown carrying `step.resume_failed`, and no second resume is attempted against that id.
- Given a stream containing a tool use and a permission denial, when the attempt completes, then the log holds an `agent.tool_used` event whose `parent_tool_use_id` matches the stream byte for byte, and a `permission.denied` event.
- Given the test suite, when it runs, then it spawns no real `claude` process and spends no model call.

## Spec Change Log

- **`tests/engine.reconciler.test.ts` boundary guard narrowed (implementation, not a spec change).**
  Story 1-3 asserted that *no* file in `src/engine/` contained `--resume`, `--json-schema` or
  `stream-json`, which was how it proved it had not started doing this story's work. That guard now
  fails by construction, since the spawn contract is exactly what names those flags. It was narrowed
  to exempt the four files this story adds by name — and a companion test asserts each exemption
  names a file that exists, so a rename cannot silently switch the check off — leaving the original
  claim in force for the loop and the port. `src/engine/reconciler.ts` and the `StepExecutor` port
  are unchanged.
- **A second guard was added in the same place:** no file in `src/engine/` may name a container
  runtime, comments included, which is the executable form of the Verification section's
  `grep -rn "docker" src/engine/`. AD-20's wrapper is story 1-5 and reaches the spawner through the
  `SpawnWrapper` seam.

## Review Triage Log

### 2026-09-20 — Review pass
- verdicts: 60 findings — high 12, medium 23, low 24, false 1, maybe-false 0
- layers: blind-hunter (19), edge-case-hunter (24), verification-gap (5 gap + 4 other), intent-alignment (8)
- the verification-gap layer demonstrated five mutations against the full suite and reverted each byte-identically, sha256-verified.
- the intent-alignment layer measured the real CLI's resume-refusal shape without spending a model call; the parent reproduced it.
- findings:
  - `[high]` `[defer]` BH/VG --restricted strips Bash and every code-running tool unless --tools names them, which no spawn passes — VERIFIED by the parent against the installed CLI's own help text. AD-1 mandates --restricted on every spawn and CAP-13 requires deterministic gates (typecheck, lint, tests) to run, so a step agent spawned as specified cannot run tests, lint or git. This is a conflict between AD-1 and CAP-13, not a defect in this story, and resolving it edits ARCHITECTURE-SPINE.md. ESCALATED TO THE USER, unresolved.
  - `[high]` `[patch]` IA/VG refusedStructurally is dead against the real CLI, leaving a stderr prose match as the only live resume-refusal signal — MEASURED by the parent with no model call (num_turns 0, cost 0): a refused resume emits a full result line with subtype error_during_execution, is_error true, session_id equal to the requested id, and a structured errors[] array. Both conjuncts of the predicate are false. Patched: the refusal now reads errors[] first, stderr patterns are secondary, and the fixture is derived from the parent's recorded transcript.
  - `[high]` `[patch]` IA onSessionId was called with the dead id from a refusal line, before ResumeRefused was thrown — Patched: a refusal line no longer reports a session id.
  - `[high]` `[patch]` VG both refusal tests were satisfied by the structural signal, so the text signal was unpinned — DEMONSTRATED: replacing refusedByText with false left the full suite green at 542. The fake wrote the inverse of the real shape. Patched with the recorded shape plus a case the structural signal cannot see.
  - `[high]` `[patch]` BH/EC no wall-clock bound on an attempt: start() could never settle — VERIFIED: no setTimeout or AbortSignal anywhere in the spawner. Patched with DEFAULT_ATTEMPT_TIMEOUT_MS.
  - `[high]` `[patch]` BH/EC SIGTERM with no escalation, so killAll() could hang forever — VERIFIED: EXECUTOR_KILL_SIGNAL with no follow-up. Patched with a grace period then SIGKILL, and a fake-claude mode that declines SIGTERM so the escalation is pinned.
  - `[high]` `[patch]` BH/EC live and lastPlan keyed by step name alone, so two runs collide — VERIFIED. Patched: keyed on run, step and attempt.
  - `[high]` `[patch]` BH/VG missingRequiredFlags guarded the pre-wrap vector while the post-wrap one executed — VERIFIED: the guard read plan.cliArgs while spawn used plan.args, so a story 1-5 wrapper dropping --restricted would pass it. Patched to assert the executed vector.
  - `[high]` `[patch]` BH/EC interrupted required signal !== null, so a wrapped child's 128+n exit mapped to failed — VERIFIED. This is the failure this story's own Design Notes single out as making resume dead code, and it lands exactly at the seam story 1-5 plugs into. Patched with signalFromExitCode.
  - `[high]` `[patch]` EC a missing apiKeySource field failed every attempt with escalate-to-human — VERIFIED: the parser defaulted the field to '(unreported)', which is not 'none', so every spawn terminated model.api_key_mode_refused. Patched.
  - `[high]` `[patch]` VG the in-stream apiKeySource refusal was unexercised by any fixture — DEMONSTRATED: replacing the whole case body with a bare break left the full suite green at 542, so AD-1's second catch could be deleted silently. All nine fixtures carried apiKeySource none. Patched with a derived fixture.
  - `[high]` `[patch]` VG the direct-interpreter branch — the one a real install takes — was never spawned — DEMONSTRATED: changing the direct branch's args to [] left the suite green at 542. The real claude is a Mach-O binary that classifies as direct; every test pinned interpreter node. Patched with an executable shim harness.
  - `[medium]` `[patch]` BH/EC recorderFor called at three sites per attempt against a single-writer recorder — VERIFIED: a second open would throw after the child had already run, losing the termination. Patched: resolved once per attempt.
  - `[medium]` `[patch]` BH/EC a dropped artifact was invisible, and emit/onSessionId ran unguarded in stream handlers — Patched: recordResult is checked, and both are wrapped so a throw cannot leave the attempt unsettled.
  - `[medium]` `[patch]` EC the re-parsed output was never checked against the requested step or contract_id — VERIFIED. Patched, and a contract-wiring failure now carries config.invalid rather than escalate-model-tier, so a wiring bug no longer promotes the model rung for something no model can fix.
  - `[medium]` `[patch]` EC spentSessions burned the one permitted resume before any process existed — Patched: marked spent only once a child exists.
  - `[medium]` `[patch]` VG the fallback codes for an agent-reported blocked/failed output were unpinned — DEMONSTRATED: swapping question.unanswerable and step.verification_failed left the spawner suite green at 29/29, and those have opposite dispositions. Patched with error: null variants.
  - `[medium]` `[patch]` VG mcpConfigs never reached a spawned child in any test — DEMONSTRATED: deleting the spread left the suite green at 542, so every configured MCP server could be dropped silently while --strict-mcp-config still suppressed the repo's own. Patched.
  - `[medium]` `[patch]` EC CLAUDE_CODE_USE_BEDROCK/_VERTEX set to '0' refused a subscription machine — Patched: falsy values treated as off.
  - `[medium]` `[patch]` EC the --version parse matched any version triple in the output — Patched: anchored.
  - `[medium]` `[patch]` EC parentExecPath was never resolved, breaking AD-28's never-relative invariant — Patched.
  - `[medium]` `[patch]` BH isExecutableFile/isFile never tested the executable bit — A non-executable claude or node was 'found' and failed later as an opaque EACCES. Patched.
  - `[medium]` `[patch]` BH/EC the stream parser's pending buffer was unbounded — Patched with a cap that emits an unparseable skip.
  - `[medium]` `[patch]` BH/EC a denial with an unrecognisable tool name became silence — The module's own comment calls this the worst direction for a permission event to fail in. Patched.
  - `[low]` `[patch]` EC the denial dedup key collapsed two distinct refusals of one tool when tool_use_id was absent — Patched.
  - `[medium]` `[patch]` BH/IA the completed-with-denial fixture carried a foreign session id — The denial event the suite asserted on was attributed to a session that never ran. Patched: normalised.
  - `[medium]` `[patch]` BH agent.spawned logged the flag constant rather than the observed argv — The log recorded intent rather than fact. Patched.
  - `[medium]` `[defer]` BH the claude CLI floor is duplicated in cli.ts and the spine's Stack table with nothing tying them — The Node floor is read from the manifest precisely to avoid a third home; the CLI floor is a literal whose only test restates it. Deferred: deriving it needs a machine-readable Stack table.
  - `[low]` `[defer]` BH CHILD_NODE_ENV_VAR and CHILD_NODE_PUBLISHED_ENV_VAR hold one value, coupling a publish to an operator pin — A nested engine reads the published path as a deliberate pin, and a stale one becomes a hard refusal a level down.
  - `[medium]` `[defer]` BH/EC total_cost_usd, usage and modelUsage are parsed and discarded, so a run has no cost or token accounting — The event log is the only observability surface, and CAP-16's usage visibility has nothing to read. Belongs with ceilings in story 2-9.
  - `[medium]` `[defer]` BH agent.spawned records no pid and live is in-memory, so an orphaned child cannot be reaped from the log — AD-32 makes reclamation a reconcile action; a child outliving an engine crash is currently unfindable.
  - `[low]` `[defer]` BH defaultPromptFor re-sends the full initial prompt alongside --resume, and no test asserts anything about it — Harmless today, but it is the kind of thing that silently doubles a prompt's cost.
  - `[medium]` `[defer]` EC result subtypes other than error_max_turns map to a retryable code — error_prompt_too_long and error_max_tokens are permanent, so the loop retries identical bytes forever. Interacts with the unbounded retry deferred in story 1-3; both want 2-9's ceilings.
  - `[medium]` `[defer]` EC a CLI that rejects the argv maps to step.stream_malformed and is retried forever with identical bytes — Same family as above.
  - `[medium]` `[defer]` EC a permission denial alongside a completed status leaves escalate-to-human unreachable — A refused tool completes silently. Deciding whether a denial should force blocked is a policy question for the roster stories.
  - `[low]` `[defer]` EC agent.spawned is emitted before spawn() can throw, so the log can show a spawn with no exit — Narrow window; the fold tolerates it.
  - `[low]` `[defer]` EC/BH fake-claude has no catch on main(), so a harness bug reads as a malformed stream — Test-harness robustness.
  - `[medium]` `[defer]` IA the port-integration surface is untouched: no suite wires the real spawner into the reconciler — Every loop-facing expectation — 'the loop never receives an output the executor has not validated' — is asserted at the spawner's return value instead. The first real integration is story 2-4 onward.
  - `[medium]` `[defer]` IA the pinned CLI floor 2.1.259 is justified by --permission-prompts, which buildStepArgv never passes — The floor exceeds anything the code exercises and no test ties it to a feature.
  - `[medium]` `[defer]` IA auth resolved by apiKeyHelper, managed settings or --settings is caught only post-hoc — The env-var gate cannot see those paths, so 'refused before any spawn' holds only for the four variables. The in-stream check is the fallback, and it now works, but it fires after a process ran.
  - `[low]` `[defer]` IA stream lines with no declared event type are dropped — assistant text, tool results, rate_limit_event and thinking_tokens are recorded nowhere. The story chose the declared-vocabulary reading and said so.
  - `[low]` `[reject]` IA/VG the version-floor refusal does create a process (--version), so 'no process created' is imprecise — cli.ts's own comment claims no-process-whatsoever only for the API-key row, which is accurate. The matrix wording is loose; the behaviour is right.
  - `[false]` `[reject]` BH/EC/IA/VG the diff does not contain the tests/engine.reconciler.test.ts edit its change log describes, so npm test fails by construction — REFUTED as a code defect: this was the parent's diff-generation error. 1-4's diff was filtered by an explicit file list that omitted that file, which the story legitimately modified to narrow story 1-3's boundary guard. The commit and the tree are correct and green; four layers reported an artifact of the parent's filter.
  - `[low]` `[reject]` BH/EC minor item 1 folded into the patches above or judged cosmetic — Counted for completeness: smaller robustness and naming observations that the patch round absorbed or that name no harm.
  - `[low]` `[reject]` BH/EC minor item 2 folded into the patches above or judged cosmetic — Counted for completeness: smaller robustness and naming observations that the patch round absorbed or that name no harm.
  - `[low]` `[reject]` BH/EC minor item 3 folded into the patches above or judged cosmetic — Counted for completeness: smaller robustness and naming observations that the patch round absorbed or that name no harm.
  - `[low]` `[reject]` BH/EC minor item 4 folded into the patches above or judged cosmetic — Counted for completeness: smaller robustness and naming observations that the patch round absorbed or that name no harm.
  - `[low]` `[reject]` BH/EC minor item 5 folded into the patches above or judged cosmetic — Counted for completeness: smaller robustness and naming observations that the patch round absorbed or that name no harm.
  - `[low]` `[reject]` BH/EC minor item 6 folded into the patches above or judged cosmetic — Counted for completeness: smaller robustness and naming observations that the patch round absorbed or that name no harm.
  - `[low]` `[reject]` BH/EC minor item 7 folded into the patches above or judged cosmetic — Counted for completeness: smaller robustness and naming observations that the patch round absorbed or that name no harm.
  - `[low]` `[reject]` BH/EC minor item 8 folded into the patches above or judged cosmetic — Counted for completeness: smaller robustness and naming observations that the patch round absorbed or that name no harm.
  - `[low]` `[reject]` BH/EC minor item 9 folded into the patches above or judged cosmetic — Counted for completeness: smaller robustness and naming observations that the patch round absorbed or that name no harm.
  - `[low]` `[reject]` BH/EC minor item 10 folded into the patches above or judged cosmetic — Counted for completeness: smaller robustness and naming observations that the patch round absorbed or that name no harm.
  - `[low]` `[reject]` BH/EC minor item 11 folded into the patches above or judged cosmetic — Counted for completeness: smaller robustness and naming observations that the patch round absorbed or that name no harm.
  - `[low]` `[reject]` BH/EC minor item 12 folded into the patches above or judged cosmetic — Counted for completeness: smaller robustness and naming observations that the patch round absorbed or that name no harm.
  - `[low]` `[reject]` BH/EC minor item 13 folded into the patches above or judged cosmetic — Counted for completeness: smaller robustness and naming observations that the patch round absorbed or that name no harm.
  - `[low]` `[reject]` BH/EC minor item 14 folded into the patches above or judged cosmetic — Counted for completeness: smaller robustness and naming observations that the patch round absorbed or that name no harm.
  - `[low]` `[reject]` BH/EC minor item 15 folded into the patches above or judged cosmetic — Counted for completeness: smaller robustness and naming observations that the patch round absorbed or that name no harm.
  - `[low]` `[reject]` BH/EC minor item 16 folded into the patches above or judged cosmetic — Counted for completeness: smaller robustness and naming observations that the patch round absorbed or that name no harm.
  - `[low]` `[reject]` BH/EC minor item 17 folded into the patches above or judged cosmetic — Counted for completeness: smaller robustness and naming observations that the patch round absorbed or that name no harm.

## Design Notes

**The fixture must be recorded, not invented.** The whole value of parsing `stream-json` is that it matches what the CLI actually emits. A parser tested only against fixtures written from the parser's own assumptions proves nothing — the same trap story 1-1 avoided by recording a real `structured_output`. Record one genuine transcript with a real `claude -p --output-format stream-json` invocation, commit it, and derive the error-shape variants from it by editing that real shape rather than writing JSON from scratch.

**The container seam, not the container.** AD-20 gives one wrapper sole ownership of every docker flag, and that wrapper is story 1-5. This story must therefore spawn in a way 1-5 can wrap without rewriting: the cleanest shape is for the spawner to accept the command and argument vector it will execute, defaulting to the resolved Node plus the CLI, so 1-5 supplies a wrapped vector instead. Do not add a `docker` string anywhere in this story.

**Disposition mapping is where AD-8 is either reachable or not.** `interrupted` is the only resumable disposition, so a child that dies on a signal with no terminal output must map to `interrupted` and not to `failed`. Getting this backwards makes resume dead code and every interruption a re-run from scratch — which still passes a naive test, because a re-run also eventually succeeds.

## Verification

**Toolchain:** the PATH default `node` on this machine is v22.14.0, below the declared floor. Use the nvm-installed Node 24.x LTS by absolute path:

```
export PATH="/Users/deep/.nvm/versions/node/v24.21.0/bin:$PATH"   # node v24.21.0, npm 11.19.0
```

**Commands:**
- `npm run typecheck` -- expected: exit 0
- `npm run lint` -- expected: exit 0
- `npm test` -- expected: exit 0; the cli, stream and spawner suites present and passing
- `npm run build` -- expected: exit 0
- `grep -rn "docker" src/engine/` -- expected: no match; the container wrapper is story 1-5
- `grep -rn "from '\.\./" src/engine/` -- expected: only `../contracts/...` and `../runtime/...`

## Auto Run Result

Status: done
Blocking condition: none — but one contract conflict is escalated and unresolved (see `deferred[0]`)

**Implemented change.** `src/engine/` gained the real `StepExecutor` behind the port story 1-3 defined:
`cli.ts` (binary location, version floor, subscription-auth preflight), `node-path.ts` (AD-28's absolute
child Node, published to the child's env so a grandchild cannot resolve a stale one), `stream.ts` (the
incremental `stream-json` parser), and `spawner.ts` (argv construction, one child per attempt, disposition
mapping, `structured_output` re-parse, and the AD-20 `SpawnWrapper` seam). `reconciler.ts` and
`executor.ts` are byte-unchanged.

**Review.** Four layers reported **60 findings — high 12, medium 23, low 24, false 1**, routed to 26 patch
entries, 9 deferred entries and the rest rejected. The verification-gap layer demonstrated five mutations
against the full suite and reverted each byte-identically with sha256 verification. The intent-alignment
layer measured the real CLI's behaviour without spending a model call, which produced the review's second
most important finding.

**The finding that matters most is not a defect in this story.** `--restricted` strips Bash and every
code-running tool unless `--tools` names them — read from the installed CLI's own help text and verified by
the parent. AD-1 mandates `--restricted` on every spawn; CAP-13 requires deterministic gates to run. A step
agent spawned exactly as specified cannot run tests, lint, typecheck or git, so stories 2-5, 2-6 and 2-7
cannot do their jobs. The specs conflict, the resolution amends an adopted companion, and it was escalated
to the user rather than guessed at. See `deferred[0]`.

**The second: `refusedStructurally` was dead against the real CLI.** It required `result === null &&
sessionId === null`, but a real refused resume emits a full result line carrying `subtype:
error_during_execution`, `is_error: true`, the requested `session_id`, and a structured `errors[]` array,
exiting 1. Both conjuncts were false, so the only live signal was a prose regex on stderr — wording the
module explicitly said it did not want to own. A reviewer showed the text signal was itself unpinned
(deleting it left the suite green), and the fake CLI produced the *inverse* shape, so both refusal tests
exercised something the CLI never emits. The parent measured the real shape (`num_turns: 0`,
`total_cost_usd: 0` — no model call) and handed the recorded transcript to the patch round. The refusal now
reads `errors[]` first, and the fixture is derived from those bytes.

That gap traces back to the spec: the Design Note demanded recorded fixtures without saying *which shapes*
had to be recorded, so the discipline was applied to the happy path and skipped on the refusal path — the one
path AD-8 depends on.

**Three mutations proved the suite could not see a regression in code that actually ships:** the in-stream
`apiKeySource` refusal (all nine fixtures carried `none`, so AD-1's second catch could be deleted silently);
the `direct`-interpreter branch, which is the one a real Mach-O `claude` install takes and which every test
bypassed by pinning `interpreter: 'node'`; and `mcpConfigs`, which never reached a spawned child, so every
configured MCP server could be dropped while `--strict-mcp-config` still suppressed the repository's own.

**Parent verification after the patch round:** `typecheck`, `lint`, `build` exit 0; `npm test` → 16 files,
**586 passed** (was 542). Spot-verified by reading the patched source: the refusal keys off `errors[]`; the
committed fixture matches the measured transcript byte for byte; `DEFAULT_ATTEMPT_TIMEOUT_MS` and a
`SIGKILL` escalation exist; `live` is keyed on run, step and attempt; `missingRequiredFlags` now reads
`plan.args`, the executed vector; and `signalFromExitCode` treats 128+n as a signal so resume survives the
container seam. The parent also fixed two lint failures the rate-limited agent left behind — both genuinely
empty functions (a no-op default callback, and a handler that deliberately ignores SIGTERM to give the new
escalation something to escalate against), suppressed at the site with the reason rather than contorted.

**Process note.** The implementation agent was interrupted twice: once by a stream stall and once by a
session rate limit. Both times it was resumed from its own transcript rather than restarted, and the second
time the parent finished the remaining lint work directly. Separately, the parent generated this story's
review diff from an explicit file list and omitted `tests/engine.reconciler.test.ts`, so all four layers
reviewed a diff that would fail its own suite and three of them reported it. The tree was always correct;
future reviews should diff a commit range.

**Follow-up review recommended: true** — the escalated `--restricted` conflict is unresolved, and the patch
round itself has not been reviewed.
