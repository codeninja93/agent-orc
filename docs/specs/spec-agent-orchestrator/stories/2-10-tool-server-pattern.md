---
title: 'Tool server pattern and the Jira MCP server'
type: 'feature'
created: '2026-09-23'
status: 'done'
review_loop_iteration: 2
followup_review_recommended: true
baseline_revision: '1da685d'
context:
  - '{project-root}/docs/planning-artifacts/architecture/architecture-agent-orcastrator-2026-09-19/ADR-004-command-execution-as-a-capability.md'
  - '{project-root}/docs/planning-artifacts/architecture/architecture-agent-orcastrator-2026-09-19/ADR-003-built-in-agent-tool-grants.md'
  - '{project-root}/docs/brainstorming/brainstorm-agent-orchestration-system-2026-09-19/threat-model.md'
warnings: []
deferred:
  - summary: >-
      A TOCTOU race in the standalone lock's stale-claim reclaim path could let two concurrent
      reclaimers both believe they hold the exclusive writer claim.
    evidence: |-
      `unlinkSync` in `RunFetchRecord.openStandalone`'s reclaim branch does not re-verify the claim it
      inspected is still the one present before deleting it. The identical shape already exists in
      `Recorder.open()`'s own reclaim path, unchanged by this story, so this is a pre-existing pattern
      exercised in a new, somewhat more collision-prone context rather than a new defect. Needs a
      dedicated hardening pass fixing both `Recorder` and `RunFetchRecord` together.
    location: src/runtime/fetch-record.ts
    severity: high
  - summary: >-
      The standalone lock's pid-liveness check does not cross-verify the claim's own timestamp, so pid
      reuse after the original holder's death would permanently block reclaim.
    evidence: |-
      Same reclaim-hardening pass as the TOCTOU finding above; the identical gap exists in `Recorder`'s
      own pid-liveness check, unchanged by this story.
    location: src/runtime/fetch-record.ts
    severity: high
  - summary: >-
      A reconciler backfill pass could delete a still-finishing Jira child's own in-flight temporary
      file, failing its rename.
    evidence: |-
      `sweepStaleTemporaries` deletes any matching `.tmp` file in the run directory regardless of which
      process created it. The collision window requires a Jira server still mid-write at the moment the
      same step's disposition is processed, which the round-2 SIGTERM/exit fix substantially narrows. A
      full fix (pid-tagged temporary file names) is more than a direct correction.
    location: src/runtime/fetch-record.ts
    severity: medium
  - summary: >-
      A redaction failure in the standalone path leaves no trace anywhere in the run's own recorded
      history beyond the child process's own stderr/exit code.
    evidence: |-
      Fail-closed behavior (no partial write, an exception to the caller) is intact and is AD-21's
      actual requirement; only the `events.jsonl`/`fetch-record.json` audit trail of the failure having
      happened is unavailable from a standalone writer, honestly documented in the code's own comment.
      Persisting a redaction-failure marker into `fetch-record.json` for later backfill is a real design
      extension, not a small correction.
    location: src/runtime/fetch-record.ts
    severity: medium
  - summary: >-
      The Jira credential's value is never added to the run's `RedactionPolicy.secrets` list, so it is
      caught only by generic heuristics rather than the purpose-built registered-secret class.
    evidence: |-
      Confirmed no production code path in this repository populates `RedactionPolicy.secrets` at all
      today — a pre-existing gap shared with the command-runner's own credential handling, not a
      regression this story introduces.
    location: src/tool-servers/jira/index.ts
    severity: medium
  - summary: 'Jira auth is a bearer token, which is wrong for Jira Cloud''s most common API-token credential (HTTP Basic).'
    evidence: >-
      Already an explicit, documented simplification from the first implementation round; recorded with
      the specific detail (Bearer applies to OAuth 2.0 access tokens, not classic API tokens) so
      whoever adds Basic-auth support does not have to rediscover it.
    location: src/tool-servers/jira/operations.ts
    severity: medium
  - summary: '`search_issues` calls a Jira REST endpoint Atlassian has been deprecating.'
    evidence: >-
      Unverified against current Atlassian documentation by the reviewer who raised it; worth checking
      before this path sees real traffic.
    location: src/tool-servers/jira/operations.ts
    severity: low
  - summary: >-
      Two genuinely concurrent identical Jira reads within one run can both reach the live API before
      either's write lands, though the on-disk single-value guarantee still holds.
    evidence: |-
      `RunFetchRecord.serve()`'s "already recorded" check and its write are not atomic against a second
      concurrent caller for the same key. A proper fix needs an in-flight request map, more than a
      direct correction, for a narrow window (one MCP client issuing genuinely concurrent identical
      calls).
    severity: low
  - summary: 'The standalone fetch-record lock is scoped per run, not per step, so two Jira-granted steps of the same run running concurrently would collide.'
    evidence: >-
      Unverified for reachability: this engine's reconciler processes one action per run per pass, so
      two genuinely concurrent steps of the same run may not be reachable at all today. Recorded rather
      than dismissed outright since that absence was not proven.
    location: src/runtime/fetch-record.ts
    severity: low
---

# Story 2-10 — Tool server pattern and the Jira MCP server

## Intent

**Problem:** CAP-7 ("each external domain reachable by exactly one agent, enforced by where its
credential lives") is declared and nothing implements it. The only MCP server this codebase builds
today is story 2-6's command-runner, wired as a single hardcoded server (`MCP_SERVER_NAME = 'orch'`
in `src/contracts/installer.ts`) — nothing generalizes that wiring to a second server, and no agent
can reach an external domain at all.

**Approach:** Build a Jira MCP server as the first instance of the general tool-server pattern — a
second engine-spawned MCP process, generalizing the singular server wiring to support more than one
named server, exposing read-only Jira operations wired through the fetch record that predates this
story (`RunFetchRecord.serve()` in `src/runtime/fetch-record.ts`, already built for exactly this: "any
later MCP server must derive the same key for the same request"). Reads are recorded, redacted, and
served from the record on re-run rather than re-requested; nothing mutates Jira.

## Boundaries & Constraints

**Always:**
- The Jira credential exists only in the Jira server process's own environment, injected by the
  engine at spawn time from an env-var name the profile names (never the value — build-sequencing.md's
  own installer scope: "the environment variable names holding their credentials"). The AD-20
  step-executor container's env allow-list (`composeContainerEnv` / `isCredentialEnvName` /
  `CredentialLeakError` in `src/container/flags.ts`) keeps actively refusing any credential-shaped
  var — the Jira server does not run inside that boundary, since it exists to guarantee the opposite.
- Every Jira tool is a closed-enum, read-only operation (mirrors `src/runner/commands.ts`'s
  `z.strictObject` pattern: a name, never a free-form query surface).
- Every Jira read goes through `RunFetchRecord.serve(request, perform)`, keyed by `fetchRequestKey()`
  over `{ domain: 'jira', operation, parameters }`. A request already recorded this run — including a
  recorded failure, per AD-14's existing "exactly one value" behavior — is served from the record and
  Jira is not re-contacted. Redaction is fail-closed (existing `RedactionFailedError` behavior).
- **Amended after review pass 1.** `RunFetchRecord` gains a construction path that opens
  `fetch-record.json` under its own dedicated exclusive lock (reusing `src/runtime/exclusive-create.ts`'s
  `createFileExclusively` idiom — the same primitive `Recorder`'s own writer claim and story 1-8's
  compare-and-set already use, scoped to this one file rather than to `events.jsonl`) instead of
  requiring a live `Recorder`. This is what a genuinely separate OS process — the Jira server, spawned
  as a step's MCP child while the engine's reconciler holds `events.jsonl`'s own AD-29 claim for that
  same run — calls. The one guarantee this path does not attempt: writing `fetch.recorded` to
  `events.jsonl` itself, since that append is exactly what the exclusive claim it does not hold guards.
  Instead, the reconciler backfills any `fetch.recorded` events the run's `fetch-record.json` holds that
  `events.jsonl` does not yet mirror, at a point in its own pass where it already holds its own live
  `Recorder` (e.g. when it processes the step's own disposition) — so AD-13's "every external read is
  recorded to events.jsonl" is still true, on a short delay, rather than not true for a tool-server read.
  The durable, authoritative source of "was this served from record" is `fetch-record.json` itself,
  unconditionally and immediately; the event-log mirror is a convenience for a reader of `events.jsonl`
  alone, and only that mirror is ever delayed.
- The Jira server is spawned the same way the command-runner already is — per step invocation, as an
  engine-supplied `--mcp-config` entry the agent's grant names, through `--strict-mcp-config` and
  `--allowedTools` (ADR-004's existing trust mechanism, unchanged). **Rejected alternative:** a
  long-lived, per-run daemon process. Nothing in this codebase supervises a long-lived service today,
  `RunFetchRecord.open()` already tolerates being opened fresh by successive short-lived callers, and
  Jira reads are stateless per call — a new lifecycle would be new machinery this story does not need.
- The singular constants in `src/contracts/installer.ts` (`MCP_SERVER_NAME`, `MCP_TOOL_CLI_NAMES`,
  `MCP_GRANTABLE_TOOLS`, `commandRunnerMcpConfig`) generalize to a small per-server registry so a step
  granted both the command-runner and Jira gets both in one `--mcp-config`, without changing the
  command-runner's own existing behavior or grant.
- **Amended after review pass 1.** A profile's `credential_env` name must be rejected — at the schema
  or the config-building boundary, whichever is more direct — if it collides with one of
  `jiraMcpConfig`'s own fixed environment keys (`ORCH_HOME`, `ORCH_RUN`, `ORCH_STEP`, `ORCH_FEATURE`,
  `ORCH_STEP_ATTEMPT`, `ORCH_JIRA_BASE_URL`, `ORCH_JIRA_CREDENTIAL_ENV`). A colliding name must never be
  allowed to reach the object literal `jiraMcpConfig` builds, where a later key would silently overwrite
  an earlier one.
- **Amended after review pass 1.** `JiraToolServerSchema.base_url` is validated as a URL, not a bare
  string, so a malformed value is refused at interview/write time rather than failing later inside
  `callJiraApi` as an opaque runtime error. The interview's own blank-check and the schema's
  `.refine`'s blank-check use the same definition of blank (both trimmed, or both exact) so a
  whitespace-only value cannot pass one and fail the other.
- **Amended after review pass 1.** `defaultJiraFetch` (or whatever performs the actual Jira call) is
  bounded by a request timeout, so an unresponsive Jira instance fails the read rather than blocking the
  step indefinitely.

**Never:**
- No mutating Jira tool (create, update, transition, comment-write). CAP-7 and this story's own title
  scope it to reads; a write path is a different, later decision.
- No egress-allowlist proxy and no circuit-breaker / stale-read-on-outage fallback.
  `threat-model.md` names both, but the proxy mitigates container traffic generally (every container,
  not tool servers specifically) and the circuit breaker is the threat model's own "Low … later"
  priority for tool outages — both are named as deferred, not silently dropped.
- No domain beyond Jira. `build-sequencing.md` places "tool domains beyond Jira" at Stage 5; this
  story proves the pattern once. **Amended after review pass 1:** this round *does* touch
  `src/runtime/fetch-record.ts` (review pass 1 found the original "no touch" boundary was itself the
  bug — see the Spec Change Log), but a domain added after this one still needs no further change there:
  the standalone construction path this round adds is domain-agnostic, and a third tool server calls it
  exactly as Jira does. `src/contracts/fetch.ts` and `src/runtime/redaction.ts` remain untouched.
- No LLM shim in front of Jira. The brainstorm compendium's "tiny LLM for fuzzy intent translation" is
  a later refinement of an already-working typed cache, not a precondition for this story.

## I/O & Edge-Case Matrix

| # | Input / situation | Expected |
|---|---|---|
| 1 | An agent with the Jira grant calls `get_issue` for a key not yet read this run | Jira's API is called once; the response is redacted and recorded; the agent receives it |
| 2 | The same request (same domain, operation, parameters) is made again in the same run | Served from the fetch record; Jira is not contacted a second time |
| 3 | An agent without the Jira grant runs a step | The Jira server is absent from its `--mcp-config`; the tool is not visible to call |
| 4 | The Jira API call fails (network or auth error) | The failure is recorded as `{ ok: false, ... }` and re-thrown to the caller; a later identical request in the same run is served the same recorded failure, not retried |
| 5 | `search_issues` and `get_issue` are called with otherwise-identical parameters | Two distinct fetch-record entries — `operation` is part of the key |
| 6 | A request shaped for an operation the server does not declare | Rejected at the closed-enum schema boundary before any network call |
| 7 | The Jira server starts with its named credential env var unset or empty | Refuses to start rather than serving with no credential |
| 8 | A step is granted both the command-runner and Jira | Both appear as separate entries in one `--mcp-config`; each still governed by its own `--allowedTools` |
| 9 | Two different runs each read the same Jira issue | Each run's own `runs/<run-id>/fetch-record.json` gets its own entry; a record is never served across runs (existing `ForeignFetchRecordError` guard) |

## Code Map

| File | Change | Why |
|---|---|---|
| `src/contracts/tool-server.ts` | new | The domain-agnostic shape a tool server and its grant share: domain id, credential env-var name, the MCP tool names it exposes. Generalization point for a future second domain. |
| `src/tool-servers/jira/operations.ts` | new | Closed-enum request schemas for `get_issue` and `search_issues`, and the actual `fetch()` calls against Jira's REST API using the credential from the server's own env. |
| `src/tool-servers/jira/index.ts` | new | The MCP server: stdio JSON-RPC loop mirroring `serveCommandRunnerOverStdio`/`handleMcpRequest` in `src/runner/index.ts`; opens a `RunFetchRecord` via its new standalone path (below) and dispatches each tool call through `.serve()`; closes its handle on stdin end / process signal. |
| `src/runtime/fetch-record.ts` | modify (review pass 1) | Give `RunFetchRecord` a construction path that needs no live `Recorder` — its own exclusive lock over `fetch-record.json` alone (reusing `createFileExclusively`), and no `events.jsonl` append from this path. Do not change the existing `Recorder`-based `.open()`/`.serve()` behavior any caller already depends on. |
| `src/engine/reconciler.ts` | modify (review pass 1) | Backfill `fetch.recorded` events for any `fetch-record.json` entries not yet mirrored in `events.jsonl`, at a point in the pass where the reconciler already holds its own live `Recorder` (e.g. alongside processing a step's disposition). |
| `src/contracts/installer.ts` | modify | Generalize `MCP_SERVER_NAME`/`MCP_TOOL_CLI_NAMES`/`MCP_GRANTABLE_TOOLS`/`commandRunnerMcpConfig` (currently singular, `orch`-only) into a per-server registry; add Jira's entries; add the profile fields for enabling Jira and naming its credential env var and base URL. |
| `src/installer/interview.ts` | modify | New interview question: enable the Jira domain, and if so, the env-var name holding its credential (never the value) and its base URL. |
| `src/engine/spawner.ts` | modify | Compose `--mcp-config` from every server a step's grant names, not just the command-runner. |
| `tests/tool-servers.jira.test.ts` | new | Dispatch-level tests mirroring `tests/runner.command.test.ts`: matrix rows 1, 2, 4, 5, 6, 7. Also: the standalone fetch-record path works with no `Recorder` held elsewhere, and still refuses a second standalone writer for the same run. |
| `tests/contracts.agent-grants.test.ts` | modify | Extend the existing grant-reaches-`--allowedTools` pattern (`fixtureGrant()`) to a Jira grant; the pure `serversForTools`/`mergeMcpServerConfigs` half of matrix rows 3, 8. |
| `tests/engine.spawner.test.ts` | modify (review pass 1) | A real `createStepSpawner(...).start()` test, granted `get_issue`, with a profile's `tool_servers.jira` configured and a credential set via `options.env`: read back the written `--mcp-config` file and assert the Jira entry's `env` carries the resolved credential under the correct name, `ORCH_JIRA_BASE_URL`, and `ORCH_FEATURE`/`ORCH_RUN`/`ORCH_STEP` — the real surface matrix rows 3 and 8 describe, not only the pure functions it is built from. Also: a `credential_env` colliding with a reserved key is refused before it reaches this file. |
| `tests/installer.interview.test.ts` | modify | The new question, that only the env-var name (never a value) is written to the profile, a malformed `base_url` refused at interview time, and a whitespace-only `base_url` refused the same way an empty one is. |
| `tests/contracts.installer.test.ts` or nearest existing schema test file | modify (review pass 1) | `JiraToolServerSchema.safeParse` directly, both directions of the half-configured case, and a reserved-key `credential_env` refused. |

## Tasks & Acceptance

1. **Generalize the MCP server wiring.**
   - **Given** a step's grant names both the command-runner and Jira, **when** its `--mcp-config` is
     built, **then** both servers appear as separate entries, each with its own `--allowedTools`.
   - **Given** a step's grant names only the command-runner, **when** its `--mcp-config` is built,
     **then** its shape and behavior are unchanged from before this story.
2. **Build the Jira MCP server, read-only.**
   - **Given** a `get_issue` or `search_issues` call, **when** it reaches the server, **then** it is
     validated against a closed-enum schema before any network call.
   - **Given** the server's named credential env var is unset, **when** it starts, **then** it refuses
     to start.
3. **Route every read through the run's fetch record.**
   - **Given** a request not yet recorded this run, **when** it is served, **then** Jira is called once
     and the response is redacted and recorded.
   - **Given** the same request again in the same run, **when** it is served, **then** Jira is not
     contacted and the recorded value (success or failure) is returned.
4. **Configure the domain through the installer.**
   - **Given** the interview, **when** Jira is enabled, **then** the profile records the credential's
     env-var name and the base URL, never the credential's value.
   - **Given** a malformed base URL or a `credential_env` colliding with a reserved key, **when** the
     interview or the schema sees it, **then** it is refused before it reaches a profile or a spawned
     server's environment.
5. **(Review pass 1) The Jira server obtains its fetch record without opening a competing `Recorder`.**
   - **Given** the engine's reconciler already holds `events.jsonl`'s AD-29 claim for a run, **when**
     that run's Jira MCP server starts, **then** it opens the fetch record through its own dedicated
     lock and does not throw `WriterConflictError`.
   - **Given** a Jira read served this way, **when** the reconciler next processes that step's own
     disposition, **then** any not-yet-mirrored `fetch.recorded` entries reach `events.jsonl`.
   - **Given** two Jira server processes for the same run somehow overlap, **when** both try to write
     `fetch-record.json`, **then** the dedicated lock still serializes them — AD-14's "exactly one
     value" holds regardless of which process reached it first.

## Spec Change Log

### 2026-09-23 — amended after review pass 1 (bad_spec)

**Triggering finding:** the Jira MCP server, as this spec originally scoped it, cannot start during any
real run. `createJiraServerFromEnvironment` opening its own `Recorder` collides with AD-29's exclusive
per-run writer claim, which the engine's reconciler already holds for the run's whole lifetime while a
step (and therefore the step's own Jira MCP child) is executing. This spec's original Boundaries said
"`RunFetchRecord.open()` already tolerates being opened fresh by successive short-lived callers" —
true for successive callers *within the same process the Recorder belongs to*, false for a genuinely
separate OS process holding no claim of its own. The Never section's "without touching `RunFetchRecord`
… again" was the direct cause: it excluded the one file that needed to change.

**What was amended:** the Boundaries below now require `RunFetchRecord` to gain a construction path
that does not need a live `Recorder`'s write claim, and the Code Map now includes
`src/runtime/fetch-record.ts` and `src/engine/reconciler.ts`. Four smaller findings from the same pass
(the reserved-env-key collision, `base_url`'s missing shape validation, the interview/schema trimming
mismatch, and the missing fetch timeout) are folded into the Boundaries and Tasks below rather than
logged as separate future work, since they are all in files this round already touches.

**Known-bad state avoided:** shipping a Jira tool server that unit-tests green but throws
`WriterConflictError` on every real, engine-driven invocation — a feature that works only in isolation
from the system it is built for.

**KEEP instructions — carried forward from review pass 1's diff, not to be redesigned:**
- `src/contracts/tool-server.ts` in full: `ToolServerDefinition`, `mcpToolCliNamesFor`, `serversForTools`,
  `mergeMcpServerConfigs`. No finding touched this file; it is the generalization point and stays exactly
  as built.
- The per-server registry shape in `src/contracts/installer.ts` (`COMMAND_RUNNER_SERVER`, `JIRA_SERVER`,
  `TOOL_SERVERS`, the `MCP_TOOL_CLI_NAMES` composition) and `src/engine/spawner.ts`'s `configFor`/
  `mcpConfigsFor` dispatch shape. Only additions are needed (validation, a test), not a restructure.
- `src/tool-servers/jira/operations.ts`'s closed-enum schemas and `callJiraApi`'s `{ ok, status, body }`
  translation. Only a timeout addition is needed.
- The interview's question 14 and its blank-together convention for "not enabled."
- Every matrix-row test that already passed against real dispatch code (rows 1, 2, 4, 5, 6, 7 in
  `tests/tool-servers.jira.test.ts`): keep these tests; only the server's own construction path
  (how it obtains a `RunFetchRecord`) changes beneath them.

## Review Triage Log

### 2026-09-23 — Review pass
- verdicts: 18 findings — high 8, medium 6, low 4, false 0, maybe-false 0
- findings:
  - `[high]` `bad_spec` The Jira MCP server's `createJiraServerFromEnvironment` calls `Recorder.open()` for the run it serves, but AD-29 gives `Recorder.open()` an exclusive per-run claim, and the engine's reconciler already holds that exact claim for a run's whole lifetime while a step is executing — which is exactly when a Jira-granted step's own MCP child would try to open one too. — Verified directly: `src/engine/reconciler.ts`'s `ReconcilerOptions.recorderFor` doc comment states plainly that "a loop that opens its own and a spawner that opens its own cannot both run against one run, and the second `Recorder.open` throws," and `this.recorders` is held across passes, not opened-and-closed per append. The Jira server is spawned as a subprocess of the very step the reconciler is reconciling, so `WriterConflictError` is the expected outcome on every real run, not an edge case. Independently found by edge-case-hunter (high confidence) and self-flagged by the implementer's own report ("Real cross-process risk... will very likely raise `WriterConflictError`"); I had already verified it myself before dispatching this review. The fix requires touching `RunFetchRecord`/`Recorder`, which this spec's Boundaries and Code Map explicitly excluded — the spec, not the diff, is what was wrong. Boundaries and Code Map amended below; code reverted for re-derivation.
  - `[high]` `bad_spec` A profile's `credential_env` name is validated only for shape (`EnvVarNameSchema`), so it can legally equal one of `jiraMcpConfig`'s own fixed keys (`ORCH_HOME`, `ORCH_RUN`, `ORCH_STEP`, `ORCH_FEATURE`, `ORCH_STEP_ATTEMPT`, `ORCH_JIRA_BASE_URL`, `ORCH_JIRA_CREDENTIAL_ENV`), and the credential's own object-spread entry is written last, silently overwriting whichever one it collides with. — Verified directly: `jiraMcpConfig` in `src/contracts/installer.ts` spreads `{ [server.credentialEnvVar]: server.credentialValue }` as the final entry of the `env` object literal, and nothing upstream (`EnvVarNameSchema`, the interview's `isEnvVarName`) excludes the reserved names. Independently found by blind-hunter and edge-case-hunter. Moot for routing (grouped under this pass's `bad_spec`); the fix (reject a reserved name at the schema or config-building boundary) is folded into the amended spec below so it is not lost.
  - `[high]` `bad_spec` Nothing exercises `src/engine/spawner.ts`'s real Jira `configFor` branch — the code that reads the profile, reads the credential's value from the engine's own environment, and writes it into the step's `--mcp-config` file. Matrix rows 3 and 8 are proven only against the underlying pure registry functions (`serversForTools`, `mergeMcpServerConfigs`) with hand-built fixtures in `tests/contracts.agent-grants.test.ts`, never through `createStepSpawner(...).start()`. — Verified directly: `grep -n "Jira" tests/engine.spawner.test.ts` returns nothing, and `jiraMcpConfig` is referenced in zero test files, unlike its sibling `commandRunnerMcpConfig` (`tests/runner.command.test.ts:581,611`, `tests/engine.spawner.test.ts:1401`). Independently and convergently found by blind-hunter, edge-case-hunter (implicitly, via the same code path), verification-gap (with exact file:line citations), and intent-alignment (as its own named divergence, tracing the gap back to the spec's own Code Map assigning rows 3/8 to the registry-function tests rather than the spawner). Four independent layers on the same root cause is the strongest kind of signal this session gives weight to. Moot for routing; folded into the amended spec's Code Map (a real spawner-level test is now required).
  - `[medium]` `bad_spec` `JiraToolServerSchema.base_url` is a bare `z.string()` with no URL-shape validation; a malformed value is accepted at interview and write time and only fails later, deep inside `callJiraApi`/`fetch`, as an opaque runtime error. — Verified directly against the schema. Found by blind-hunter. Moot; folded into the amended spec.
  - `[medium]` `bad_spec` The interview's question-14 `parse` rejects only an exact empty `baseUrl === ''`, but `JiraToolServerSchema`'s cross-field `.refine` compares `base_url.trim() === ''` — a whitespace-only base URL passes the interview's own check and then fails the schema's refine when the profile is written, surfacing as an unhandled Zod error instead of the friendly re-prompt every other refusal in this question gets. — Verified directly against both call sites. Found by blind-hunter. Moot; folded into the amended spec.
  - `[medium]` `bad_spec` `defaultJiraFetch` calls plain `fetch()` with no `AbortSignal`/timeout; a hung or slow Jira instance blocks the step indefinitely with no bound at this layer (a run's own wall-clock ceiling is the only eventual backstop). — Verified directly: no timeout anywhere in the `operations.ts` → `RunFetchRecord.serve()` chain. Independently found by blind-hunter and edge-case-hunter. Moot; folded into the amended spec.
  - `[medium]` `bad_spec` `bin/jira-server.ts`/`serveJiraServerOverStdio` never call `.close()` on the assembled `Recorder`/fetch-record handle when stdin ends or the process is signaled; release of the on-disk writer-claim lock relies entirely on implicit process exit. — Verified directly: no `close`/signal handling anywhere in the file. Found by blind-hunter. Likely moot by construction once the amended design removes the Jira server's own `Recorder.open()` call entirely (see the first finding above); carried forward as a check on whatever replaces it.
  - `[medium]` `bad_spec` `JiraToolServerSchema`'s "both blank or both set" `.refine` invariant has no test constructing a value that violates it directly (only the interview's own independent guard is exercised, which prevents the state before the schema ever sees it). A hand-edited `.orch/profile.toml` — a supported path per AD-16 — could still reach a parsed `Profile` with a half-configured Jira section undetected if the refine were ever weakened. — Pre-verified by the verification-gap layer per its own evidence rules (grepped `tests/` for the schema and the refine's message text; no hits). That layer proposed `defer` on the reasoning that the interview path already prevents this in normal use; I weigh it as real enough to fold into the amended spec's test requirements rather than leave it, given AD-16 treats a hand-edited profile as a legitimate, not merely theoretical, path. Moot for routing.
  - `[low]` `reject` `get_issue`/`search_issues` pull Jira's full default field set rather than scoping to named fields, which cuts against the file's own stated design goal of a small, cacheable request but causes no functional defect. — Verified directly. Found by blind-hunter. Rejected: a user or developer is unlikely to meet this as a problem in everyday use, and the fix (field-scoping parameters) is more than a direct correction.
  - `[low]` `reject` `parseJiraRequest` throws for an undeclared operation but returns `{ ok: false }` for a badly-shaped known one — two error conventions in one function that only reconcile because the throw propagates correctly through the enclosing async call and is caught by `handleJiraMcpRequest`'s own try/catch. — Verified directly that the current behavior is correct despite the inconsistency. Found by blind-hunter. Rejected: cosmetic: the two paths already converge correctly; no observable defect.
  - `[low]` `defer` `configFor`'s fallback in `src/engine/spawner.ts` throws a plain, uncoded `Error` rather than one of this area's `AD-35`-coded refusals, but the branch is unreachable while `TOOL_SERVERS` names only the two servers both of which have their own branch. — Verified: confirmed unreachable today. Found by blind-hunter. Deferred: matters only once a third tool-server domain is registered, which this story's own Boundaries explicitly place out of scope.
  - `[low]` `defer` `createJiraServerFromEnvironment` falls back silently to `env['ORCH_FEATURE'] ?? run` instead of failing loudly like its sibling required-input checks, but `jiraMcpConfig` always sets `ORCH_FEATURE` unconditionally today, so the fallback path is unreachable via the normal spawn flow. — Verified directly. Found by blind-hunter. Deferred: defense-in-depth for a path nothing currently reaches.

### 2026-09-23 — Review pass (round 2, after the bad_spec re-derivation)
- verdicts: 22 findings — high 5, medium 11, low 6, false 0, maybe-false 0
- findings:
  - `[high]` `patch` `bin/jira-server.ts`'s `SIGTERM`/`SIGINT` handlers call `release()` but never `process.exit()` afterward; registering a listener suppresses Node's default terminate-on-signal behavior, so a signaled Jira server may not actually die. — Verified: no `process.exit` call anywhere in either handler. Independently found by blind-hunter and edge-case-hunter. Patched: each handler now exits after releasing its lock.
  - `[high]` `patch` No test spawns `bin/jira-server.ts` (or exercises `serveJiraServerOverStdio` over real streams) to confirm stdin-end/signal actually triggers the lock release the whole `openStandalone` fix depends on in a live run — the fix is proven only at the primitive level, one layer below where the original bug manifested. — Descriptive finding from intent-alignment, directly explaining why the SIGTERM bug above shipped undetected. Patched: a process-boundary test added alongside the signal-handling fix.
  - `[high]` `patch` `JIRA_RESERVED_ENV_KEYS` only excludes this server's own `ORCH_*` keys; a `credential_env` of `PATH`, `HOME`, `NODE_OPTIONS`, `LD_PRELOAD`, or similar is still accepted and would overwrite that key in the spawned Jira child's closed environment object with the secret value. — Verified: the schema's reserved-key check is scoped only to the seven `ORCH_*` names. Found by blind-hunter. Patched: the reserved set now also excludes the common process-critical names an OS-level credential-shaped override could break.
  - `[high]` `defer` A `TOCTOU` race in the stale-lock reclaim path (`unlinkSync` does not re-verify the claim it inspected is still the one present before deleting it) could let two concurrent reclaimers both believe they hold the exclusive standalone lock. — Pre-verified by edge-case-hunter (high confidence claim) with the specific falsified acceptance bullet named. Verified independently: the identical shape already exists in `Recorder.open()`'s own reclaim path, unchanged by this story — `openStandalone` faithfully copied an existing, previously-accepted pattern rather than introducing a new one. Deferred: real if triggered, but the collision requires two near-simultaneous reclaims of the same stale lock, a narrower window under this engine's sequential-per-run step execution than a first read suggests; worth a dedicated hardening pass fixing `Recorder` and `RunFetchRecord` together rather than diverging them by fixing one alone here.
  - `[high]` `defer` `fetchRecordPidIsAlive` checks only raw pid liveness with no cross-check against the claim's own `since` timestamp, so pid reuse after the original holder's death would read as "still alive" and permanently block reclaim. — Verified directly. Found by edge-case-hunter. Deferred: same reclaim-hardening pass as the finding above; the identical gap exists in `Recorder`'s own pid-liveness check, unchanged by this story.
  - `[medium]` `patch` Question 14's own `parse` never checks the reserved-key list itself; a reserved name is only caught later by `JiraToolServerSchema`'s refine at final profile-write time, producing an unhandled `ZodError` rather than the friendly per-question re-prompt the sibling `base_url` fix already established. — Pre-verified by edge-case-hunter (high confidence claim), naming the falsified acceptance bullet. Patched: the interview's own `parse` now calls the same reserved-key check and re-prompts.
  - `[medium]` `patch` No test drives a full re-run round trip for an *enabled* Jira answer — only the disabled-default case is re-run-tested, and `pick()` silently swallows a parse failure, so a broken round trip for a real answer would silently re-ask forever rather than fail a test. — Pre-verified by verification-gap with exact file:line citations. Patched: added.
  - `[medium]` `patch` `configFor`'s Jira branch silently writes an empty string when a profile names a valid `credential_env` that is not actually set in the engine's own process environment at spawn time, deferring the whole failure to the spawned child's own startup exit rather than refusing at spawn time the way a missing entry point already does. — Verified directly. Independently found by blind-hunter and edge-case-hunter. Patched: refuses to spawn instead.
  - `[medium]` `patch` `bin/jira-server.ts` has no top-level `uncaughtException`/`unhandledRejection` guard; an unexpected synchronous throw crashes the process without running `release()`, leaving a stale lock file until the next opener's pid-liveness reclaim. — Verified directly. Found by blind-hunter. Patched: added.
  - `[medium]` `patch` No test parses a `profile.toml` written before this story (no `tool_servers` table at all) through the full `ProfileSchema`/`answersFromProfile` path — only `JiraToolServerSchema`'s own defaulting is exercised directly. — Verified directly. Found by blind-hunter. Patched: added.
  - `[medium]` `defer` `sweepStaleTemporaries` deletes any matching `.tmp` file in the run directory regardless of which process created it; a reconciler backfill pass opening `RunFetchRecord.open()` could delete a still-finishing Jira child's own in-flight temporary file, failing its `renameSync`. — Verified directly against the shared sweep function. Found by edge-case-hunter. Deferred: the collision window requires a Jira server still mid-write at the moment the *same* step's disposition is processed, which the SIGTERM/exit fix above substantially narrows; a full fix (pid-tagged temporary names) is more than this round's smallest correction.
  - `[medium]` `defer` A redaction failure encountered in the standalone path is fail-closed by exception (`RedactionFailedError`, no partial write — AD-21's actual requirement), but leaves no trace anywhere in the run's own history beyond the child's stderr/exit code, since a standalone instance has no `events.jsonl` claim to record `redaction.failed` through and the failure itself is not persisted to `fetch-record.json` for the reconciler to backfill later. — Verified directly; this is honestly documented in the code's own comment, not a silent gap. Found by blind-hunter. Deferred: persisting a redaction-failure marker into `fetch-record.json` for backfill is a real design extension, not a small correction.
  - `[medium]` `defer` The Jira credential's actual value is never added to the run's `RedactionPolicy.secrets` list, so it would only be caught in a recorded response by the generic entropy/token-prefix heuristics, not the purpose-built `registered-secret` class AD-21 names for exactly this case. — Pre-verified by verification-gap, which also confirmed no production code path in this repository populates `RedactionPolicy.secrets` at all today. Deferred: pre-existing gap shared with the command-runner's own credential handling, not a regression this story introduces.
  - `[medium]` `defer` `defaultJiraFetch` sends `Authorization: Bearer <token>`, which is wrong for Jira Cloud's most common API-token credential (HTTP Basic, `email:token`) — Bearer applies only to OAuth 2.0 access tokens. — Verified directly against the one auth path this server has. Found by blind-hunter. Deferred: already an explicit, documented simplification from the first implementation round ("a repository whose Jira wants a different scheme is a later decision"); recorded with the specific detail so whoever adds Basic-auth support does not have to rediscover it.
  - `[low]` `defer` `search_issues` calls `GET /rest/api/3/search`, an endpoint Atlassian has been deprecating in favor of `/rest/api/3/search/jql`. — Found by blind-hunter, who flagged it as worth verifying rather than confirmed. Deferred: unverified against current Atlassian documentation; worth checking before this path sees real traffic.
  - `[low]` `defer` Two identical concurrent `tools/call` requests for the same key can both pass `RunFetchRecord`'s "already recorded" check and both reach the live Jira API before either write lands; AD-14's on-disk "exactly one value" still holds via `put()`'s reload-check, but "not contacted a second time" weakens under this narrow concurrency window. — Verified directly. Found by edge-case-hunter. Deferred: a proper fix needs an in-flight request map, more than this round's smallest correction, for a narrow window (one MCP client issuing genuinely concurrent identical calls).
  - `[low]` `defer` A step whose profile enables Jira and whose plan somehow runs two Jira-granted steps of the *same run* concurrently would have the second server's standalone-lock open refused by the first's still-held claim; the lock is scoped per run, not per step. — Verified the code scopes the lock per run. Found by blind-hunter. Deferred, unverified for reachability: this engine's reconciler processes one action per run per pass, so two genuinely concurrent steps of the same run may not be reachable at all today; recorded rather than dismissed outright since I have not proven that absence.
  - `[low]` `reject` `Reconciler.backfillFetchRecordEvents` re-reads the whole `fetch-record.json` and the whole `events.jsonl` on every pass that processes a step's disposition, rather than tracking a cursor of what is already mirrored. — Verified directly. Found by blind-hunter. Rejected: a scalability concern, not a correctness one, and the fix (cursor tracking) is more than a direct correction for a cost that stays small at this project's run sizes.
  - `[low]` `reject` `configFor`'s Jira branch calls `readStepConfiguration` — a fresh disk read and full snapshot parse — on every Jira-granted step spawn rather than caching it once per `createStepSpawner` call. — Verified directly. Found by blind-hunter. Rejected: consistent with how other per-spawn configuration reads already work in this file; not a defect users or developers would meet as one.
  - `[low]` `reject` The story's spec file is untracked and not part of the reviewed diff. — Found by blind-hunter. Rejected: expected and correct — blind-hunter reviews the code diff only, by design (a "context-free" reviewer); the spec was in fact updated in step with this round, just never part of what this layer is shown.

## Design Notes

**What the fetch record needed, and what it didn't.** `RunFetchRecord.serve()` already does exactly
what "served from it on re-run rather than re-requested" asks for, including the less obvious half: a
failed read is recorded too (`{ ok: false, body: { error } }`), so a Jira outage during a run does not
turn into a retry storm on every later step that asks for the same issue — it turns into the same
recorded failure, once. That part needed no new design; this story's server is a caller of that existing
primitive. **What review pass 1 found it did need:** a way for a process holding none of the run's own
claims to open it at all. `Recorder.open()` — the only door before this story — assumes its caller is
the run's single authoritative writer; a Jira MCP server spawned as a step's own child, next to an
engine that already holds that claim, is never that. `RunFetchRecord.openStandalone()` is the second
door this story adds: its own lock, scoped to `fetch-record.json` alone, with the `events.jsonl` mirror
delayed to the reconciler's next natural write rather than attempted by a caller with no claim to make it.

```ts
// src/tool-servers/jira/index.ts, sketch
const fetchRecord = RunFetchRecord.openStandalone({ runId, orchHome, step });
const served = await fetchRecord.serve(
  { domain: 'jira', operation: 'get_issue', parameters: { key } },
  () => callJiraApi('get_issue', { key }, credential),
);
return served.response;
```

## Verification

Run by me, exit status captured to a variable, three times across this story's arc — the first
implementation, the bad_spec re-derivation, and the round-2 patch round — output kept in files each time.

- First implementation (before review found it could not start in a real run): exit 0, 2683/89.
- Re-derivation after the bad_spec fix (`RunFetchRecord.openStandalone`, the reconciler backfill, and
  four smaller review-pass-1 fixes folded in): exit 0, 2711/90.
- **Final, after the round-2 patch round: `npm run typecheck && npm run lint && npm run build && npm test`
  — exit 0, 2725 tests across 91 files, zero failures, zero skips.**

All nine matrix rows verified covered by passing tests, independently confirmed by me at each round
rather than taken on report: rows 1, 2, 4, 5, 6, 7 in `tests/tool-servers.jira.test.ts`; rows 3 and 8
through the real spawner path in `tests/engine.spawner.test.ts` (added specifically because round 1's
review found the pure-registry-function tests alone didn't reach it); row 9 by the existing,
domain-agnostic `ForeignFetchRecordError` test in `tests/runtime.fetch-record.test.ts`.

**Verified by me directly, not taken on report:**
- The core bad_spec fix: `RunFetchRecord.openStandalone()` reuses `createFileExclusively` (the same
  primitive `Recorder`'s own writer claim uses) scoped to a dedicated `fetch-record.json.lock`, correctly
  skips the `events.jsonl` append (`emitRecorded` early-returns when `recorderRef === null`), and the
  reconciler's `backfillFetchRecordEvents` correctly mirrors only not-yet-seen keys from its own
  already-held `Recorder`.
- The two round-2 `high` fixes: `bin/jira-server.ts`'s SIGTERM/SIGINT/uncaughtException/
  unhandledRejection handlers all call `process.exit()` after releasing the lock; `JIRA_RESERVED_ENV_KEYS`
  now includes `PATH`, `HOME`, `NODE_OPTIONS`, `NODE_PATH`, `LD_PRELOAD`, `LD_LIBRARY_PATH`,
  `DYLD_INSERT_LIBRARIES`, `DYLD_LIBRARY_PATH` alongside the server's own `ORCH_*` keys.
- `grep -rn "JIRA" src/container/` returns nothing — the credential never touches the AD-20 allow-lists.

**Manual checks:** confirmed no Jira credential env var name appears anywhere under `src/container/`
allow-lists as a permitted pass-through — it stays refused there, only accepted by the tool-server spawn
path.

## Auto Run Result

**Status: done, reviewed twice.** A Jira MCP server exists as the first instance of the general
tool-server pattern: closed-enum, read-only operations, every read routed through the pre-existing run
fetch record, the credential living only in the Jira server's own spawned environment, and the singular
command-runner-only MCP wiring generalized to a small per-server registry.

**The most consequential finding of this story's whole arc: the first implementation could not start
during any real run.** Opening its own `Recorder` collided with AD-29's exclusive per-run claim the
engine's reconciler already holds for a run's whole lifetime — a `WriterConflictError` on every real,
engine-driven invocation, passing only in isolated unit tests that never had a second claimant. Caught
by the first review round (edge-case-hunter, high confidence; corroborated by the implementer's own
self-flagged risk and by my own reading before I dispatched that review), it routed `bad_spec`: the
spec's own "no touch `RunFetchRecord`" boundary was the bug. I amended the spec to require a standalone
construction path with its own dedicated lock and a reconciler-side backfill of the delayed event-log
mirror, reverted the code, and re-derived it. The fix was verified directly in the re-derived diff before
a second review round ran against it.

**The second review round found the fix was proven only at the primitive level, not at the process
boundary where the original bug actually manifested** — and that gap let a real bug through: the
Jira server's `SIGTERM`/`SIGINT` handlers released their lock but never called `process.exit()`,
so registering the handler silently replaced Node's default terminate-on-signal behavior and a
signaled server might not die at all. Also real: the reserved-environment-key guard covered only this
server's own `ORCH_*` keys, so a `credential_env` of `PATH` or `LD_PRELOAD` would still be accepted and
would overwrite that key in the child's environment with the secret value. Both are high-severity,
patched, and the fix now includes a test that spawns the real compiled server as a genuine child process
and confirms it actually exits — the level the first round's tests never reached.

**Five more real, patched findings:** the interview's own reserved-key check was missing (a colliding
name was only ever caught later as an unhandled `ZodError`, not the friendly re-prompt `base_url`'s
sibling fix already gets); a profile naming a valid `credential_env` not actually set in the engine's own
environment silently wrote an empty credential rather than refusing to spawn; no test exercised a full
re-run round trip for an *enabled* Jira answer; no test exercised the interview's own reserved-key
re-prompt; and no test parsed a pre-story `profile.toml` with no `tool_servers` table at all through the
whole `ProfileSchema`.

**Follow-up review recommended: true.** Two `high` findings were patched this round, which sets this
unconditionally. The specific unverified risks, all recorded in `deferred`: a TOCTOU race in the
standalone lock's stale-claim reclaim (shared, unmodified, with `Recorder`'s own identical reclaim
pattern — a dedicated hardening pass should fix both together, not just one); the same pid-liveness check
not cross-verifying a claim's timestamp; a reconciler backfill pass that could in principle delete a
still-finishing Jira child's own in-flight temporary file (substantially narrowed by this round's exit
fix, not eliminated); and Jira's bearer-token auth being wrong for Jira Cloud's most common API-token
credential type (Basic, not Bearer) — an explicit, documented simplification from the first round, not
new.

**Residual risks.** See the nine-item `deferred` list in the frontmatter: two `high` (the reclaim races,
shared with `Recorder`), five `medium` (the backfill/temp-file collision, the standalone path's silent
redaction-failure trace, the credential never being registered in `RedactionPolicy.secrets` — a
pre-existing gap shared with the command-runner, not a regression — and the Bearer/Basic auth mismatch),
and two `low` (a possibly-deprecated Jira search endpoint, and two narrow concurrency windows this
engine's sequential-per-run step execution likely does not reach today, recorded rather than dismissed
since that absence was not proven).
