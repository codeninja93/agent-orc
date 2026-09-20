---
title: 'Step spawner — the claude -p subprocess contract'
type: 'feature'
created: '2026-09-20'
status: 'in-review'
review_loop_iteration: 0
followup_review_recommended: false
context:
  - '{project-root}/docs/planning-artifacts/architecture/architecture-agent-orcastrator-2026-09-19/ARCHITECTURE-SPINE.md'
  - '{project-root}/docs/specs/spec-agent-orchestrator/SPEC.md'
  - '{project-root}/docs/specs/spec-agent-orchestrator/stories/1-3-engine-reconciler.md'
warnings: ['oversized'] # 9 files and 14 I/O scenarios; AD-1 is the densest single AD in the spine
deferred: []
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
