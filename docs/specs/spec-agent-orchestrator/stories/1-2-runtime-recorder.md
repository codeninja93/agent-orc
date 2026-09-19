---
title: 'Runtime recorder — redaction, seq assignment, events.jsonl'
type: 'feature'
created: '2026-09-19'
status: 'done'
review_loop_iteration: 0
followup_review_recommended: true
context:
  - '{project-root}/docs/planning-artifacts/architecture/architecture-agent-orcastrator-2026-09-19/ARCHITECTURE-SPINE.md'
  - '{project-root}/docs/specs/spec-agent-orchestrator/SPEC.md'
  - '{project-root}/docs/specs/spec-agent-orchestrator/stories/1-1-contracts-package.md'
warnings: ['oversized'] # 9 new files and 13 I/O scenarios; trimming further would cut Code Map paths, the carried-forward continuity from 1-1, or matrix rows
deferred:
  - summary: >-
      Commit SHAs and unbroken ULIDs inside event payloads are now redacted, so an identifier a later
      story puts in a payload is unrecoverable from the log.
    evidence: |-
      VERIFIED after the patch round: payload.baseline_ref of ddd9bed4d286ac1f8a0f4f7bfef9530046605787
      reads [redacted]. This is a direct consequence of broadening the entropy class, which the parent
      directed and accepted as the fail-safe direction. The envelope's own run, feature and step
      survive, and AD-26 baseline refs live in the step input file and state.json rather than the log,
      so the stage-1 gate is not broken today. But stories 1-3 onward must not rely on a SHA or ULID
      inside an event payload, and if reconstruction ever needs one the fix is a proven-pattern-free
      allow-list by field path, not a shape exemption.
    location: >-
      src/runtime/redaction.ts
    severity: medium
  - summary: >-
      The fetch key digest was shortened to 64 bits because a full SHA-256 hex digest now reads as
      high-entropy secret material.
    evidence: |-
      The implementer reduced the key to `sha256:` plus 16 hex characters so the key can travel in the
      event log without being redacted, preserving the AD-23 log-to-record pointer. Collision risk is
      negligible at this scale, but it is a security-adjacent reduction driven by a redaction change
      rather than by a keying requirement, and it should be revisited if the record ever spans many
      runs.
    location: >-
      src/contracts/fetch.ts
    severity: medium
  - summary: >-
      A recorded ok:false external read is served from the record for the rest of the run, so a
      transient domain failure is sticky.
    evidence: |-
      Flagged by the implementer as a literal reading of AD-14's one-value-per-run. Retry belongs to
      the engine's step-level disposition (AD-35), which does not exist until story 1-3; recorded so
      that story decides deliberately rather than inheriting stickiness by accident.
    location: >-
      src/runtime/fetch-record.ts
    severity: medium
  - summary: >-
      The intent named two OS processes contending for one log, but no submission transport exists, so
      an out-of-process producer can only be refused.
    evidence: |-
      The intent's own Never list excludes the MCP server implementation, the only out-of-process
      producer it names, so the transport is out of scope by the intent's terms. Recorded because
      stories 1-4 and 2-10 must supply it, because the Always clause 'every other producer emits
      through it' overstated what this story could deliver, and because the 'several producers' test
      locates producers at the emitter string field rather than at the process boundary.
    location: >-
      src/runtime/recorder.ts
    severity: medium
  - summary: >-
      Whole-line atomicity rests on one write syscall per line, and the resume loop's tearing case is
      unreachable by the current test.
    evidence: |-
      The append loop retries a short write, so interruption points exist between iterations; the
      SIGKILL test uses ~4 KiB lines, which do not split in practice. A genuine tearing test needs a
      line large enough to split, or a pipe. Related: writeSync returning zero could spin, and EAGAIN
      could tear mid-line.
    location: >-
      src/runtime/recorder.ts, tests/runtime.recorder.test.ts
    severity: medium
  - summary: >-
      readEventLog rejects the whole file for one bad line and reads the entire log on every open.
    evidence: |-
      Refusing is the spec's own stated rule, so the fatality is intended. The deferred halves are
      forward compatibility (a future declared field makes an older reader refuse a whole run,
      including the story 1-9 renderer) and cost: Recorder.open is O(file size), and a log beyond
      Node's maximum string length would make a long-lived run unresumable with no tail-scan path.
    location: >-
      src/runtime/recorder.ts
    severity: medium
  - summary: >-
      The fetch key has no plain-JSON precondition, so NaN, Infinity and undefined collapse to one key
      and a cyclic parameter tree recurses forever.
    evidence: |-
      canonicalJson normalises rather than refuses: four distinct requests can share one key and
      therefore one recorded value, a bigint throws a raw TypeError, and symbols and functions key as
      null. The fix is to refuse a non-plain-JSON parameter tree, which adds surface and belongs with
      the component that builds requests.
    location: >-
      src/contracts/fetch.ts
    severity: medium
  - summary: >-
      Two overlapping serve() calls for one key can contact the domain twice, against AD-14's
      single-contact guarantee.
    evidence: |-
      No async concurrency exists until the engine drives steps in story 1-3; an in-flight promise map
      is the fix when it does.
    location: >-
      src/runtime/fetch-record.ts
    severity: medium
  - summary: >-
      Across-invocation replay is structurally supported but exercised nowhere.
    evidence: |-
      RunFetchRecord.open loads an existing fetch-record.json through parseVersionedArtifact, but
      every serve-from-record test runs against a record populated earlier in the same test body by
      the same live recorder. A second-invocation test arrives with the engine in story 1-3.
    location: >-
      tests/runtime.fetch-record.test.ts
    severity: medium
  - summary: >-
      Three lock-file states are implemented but untested, and two are outside the matrix entirely.
    evidence: |-
      Reclaim-if-dead and refuse-if-alive were verified by parent probes. Untested: an unreadable lock
      file is permanently unreclaimable, a lock recording pid 0 or a negative pid reads as held
      (process.kill(0,0) signals the caller's group), a throwing claim write leaves an empty
      never-reclaimable lock, and two processes reclaiming one stale lock concurrently leak a raw
      ENOENT instead of the named refusal.
    location: >-
      src/runtime/recorder.ts
    severity: low
  - summary: >-
      paths.ts owns the whole AD-9 layout plus a path-segment refusal the matrix has no row for.
    evidence: |-
      worktreesDir, poolDir, projectDir and RUN_CONFIG_DIR_NAME belong to stories this one's Never
      list defers, and UnsafePathSegmentError is a behaviour the intent never described in a module
      its own docblock calls layout-only. Harmless and tested, but unlicensed surface. Also: a
      whitespace-padded absolute ORCH_HOME resolves under cwd.
    location: >-
      src/runtime/paths.ts
    severity: low
  - summary: >-
      An oversized artifact is fully walked and serialised before the size gate rejects it.
    evidence: |-
      The gate still fails closed, so this is resource shape rather than correctness; a budget
      decremented during the walk would reject earlier.
    location: >-
      src/runtime/redaction.ts
    severity: low
  - summary: >-
      The unserialisable-value fail-closed reason may be unreachable.
    evidence: |-
      The plain-record walk rejects exotic prototypes before JSON.stringify is reached, so no input
      was found that produces this reason. Either a reaching input exists and should be tested, or the
      reason should be removed rather than left as dead vocabulary.
    location: >-
      src/runtime/redaction.ts
    severity: low
  - summary: >-
      Two test helpers fail unsafely: a waitUntil timeout leaves the append-until-killed child
      running, and a failed spawn yields pidIsAlive(-1).
    evidence: |-
      Both are in the kill-test helper path and only bite when the test itself is failing, but
      pidIsAlive(-1) signals the whole process group.
    location: >-
      tests/runtime.recorder.test.ts, tests/helpers/append-until-killed.ts
    severity: low
baseline_revision: 'c21a51119c465b4a78479bec6c80dbdb096bd79e'
---

<intent-contract>

## Intent

**Problem:** Story 1-1 defined the event envelope but deliberately left `seq` assignment and the writing of `events.jsonl` unowned. Nothing yet writes the log that AD-4 makes the system's sole durable truth, so no run is reconstructable and the stage-1 gate cannot be met. Without a single writer, an MCP server running as a child of `claude -p` and a step subprocess would both append to one file and interleave, which AD-29 exists to prevent.

**Approach:** Add `src/runtime/` holding the recorder: the only process that appends to a run's `events.jsonl` and the only assigner of `seq`, with a fail-closed redaction pass on the boundary between producer and log, and the run shared fetch record that makes an external read replayable. Every other producer emits through it rather than opening the file.

## Boundaries & Constraints

**Always:**
- Exactly one writer per `events.jsonl`. The recorder is the sole appender and the sole assigner of `seq`; every other producer, including MCP servers and step subprocesses, emits through it.
- `seq` is monotonic per file and is the only ordering authority. Timestamps carry no ordering authority across processes.
- Every event is one JSON object on one line and is never mutated after append.
- Redaction runs on the producer/log boundary before any append, and fails closed: on failure the artifact is dropped and a `redaction.failed` event is recorded instead. There is no after-the-fact remedy.
- Redaction covers known token prefixes, high-entropy strings, env-file contents, private-key headers, and the literal values of injected credentials.
- A reader ignores an unknown event `type` rather than erroring; a missing declared envelope field is a rejection.
- Every external read is recorded, through redaction, to both the event log and the run shared fetch record. Within one run an external record has exactly one value, and a re-run is served from the record rather than re-requesting.
- On-disk artifacts carry `schema_version`; `fetch-record.json` is such an artifact and is registered as a contract.
- Runtime paths follow AD-9: `ORCH_HOME` defaults to `~/.orch`, with `runs/<run-id>/events.jsonl` and `runs/<run-id>/fetch-record.json`.
- `src/runtime/` imports only from `src/contracts/` and `node:` builtins. Diagnostics never go to stdout.

**Never:**
- No reconciler, no `state.json` writing, and no run-id minting — run ids are ULIDs minted by the engine in story 1-3, and the recorder receives one.
- No `claude -p` spawning (story 1-4), no docker wrapper (1-5), no renderer (1-9), no MCP server implementation (2-10).
- Never mutate or rewrite an existing event line, and never offer a delete or compact operation.
- Never let a second writer hold the same `events.jsonl`, and never fall back to unsynchronised appends when the single-writer claim cannot be established.
- Never write an artifact that failed redaction, in whole or in part, and never log the value that triggered the failure.
- No retrieval index, no SQLite projection, and no consolidation — those are deferred per the spine.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| First append for a run | A fresh `runs/<run-id>/` and one valid event | `events.jsonl` created; the line carries `seq` 1 | No error expected |
| Subsequent appends | Recorder already appended `seq` 1..n | Next line carries `seq` n+1, strictly increasing with no gaps | No error expected |
| Many emitters, one run | Events submitted from several producers for one run | Every line has a unique `seq`, order matches submission order | No error expected |
| Ordering authority | Two events whose `ts` disagrees with their `seq` order | Readers order by `seq`; `ts` never reorders | No error expected |
| Credential in a payload | Event whose payload contains an injected credential's literal value | Appended with that value replaced by a redaction marker | No error expected |
| Redaction pass fails | Redaction throws or cannot complete on an artifact | The artifact is dropped and a `redaction.failed` event is appended in its place | Nothing unredacted is written; the triggering value never appears |
| Unknown event type | Event whose `type` is outside the declared vocabulary | Appended unchanged and readable | No error — adding a type is never breaking |
| Malformed envelope | Event missing a declared field, or a `ts` that is not RFC3339 with milliseconds | Rejected before any write | Error naming the offending field; the file is unchanged |
| Interrupted append | Process killed during a write | The file contains only whole lines; no torn or partial JSON | A partial trailing line is never produced |
| External read recorded | A domain request and its response | Recorded, redacted, to both `events.jsonl` as `fetch.recorded` and `fetch-record.json` | No error expected |
| Re-run of a recorded read | A request already present in the fetch record | Served from the record; the domain is not contacted | No error expected |
| Second writer | Another recorder attempts to append to the same run | Refused, naming the holder | The file is not opened for append twice |
| Unrecognised fetch-record version | `fetch-record.json` with a future `schema_version` | Refused, stating which installer version wrote it | Explicit refusal, never a silent upgrade |

</intent-contract>

## Code Map

Story 1-1 shipped `src/contracts/` (commit `c21a511`) and this story is its first consumer. Nothing under `src/runtime/` exists yet.

- `src/runtime/paths.ts` -- create; `ORCH_HOME` resolution defaulting to `~/.orch`, and the `runs/<run-id>/` layout of AD-9. Path construction only; no policy
- `src/runtime/redaction.ts` -- create; the fail-closed pass of AD-21. Pattern set plus registered literal secrets, returning either a redacted value or a failure that forces the drop
- `src/runtime/recorder.ts` -- create; the single appender: single-writer claim, `seq` assignment, envelope validation via `EventEnvelopeSchema`, whole-line append
- `src/runtime/fetch-record.ts` -- create; the run shared fetch record of AD-13/AD-14: record a request/response, serve an already-recorded one, one value per record per run
- `src/runtime/index.ts` -- create; barrel and the public surface the engine will consume in 1-3
- `src/contracts/fetch.ts` -- create; the `fetch-record.json` artifact schema, `versioned()` per AD-28, plus the request-key shape
- `src/contracts/registry.ts` -- modify; register `fetch.record` as an `artifact`-kind contract. This is the registry's first growth since 1-1, and the pattern AD-17 intends
- `tests/runtime.recorder.test.ts` -- create; `seq` monotonicity, envelope rejection, unknown-type passthrough, single-writer refusal, whole-line-only appends
- `tests/runtime.redaction.test.ts` -- create; each covered secret class, and the fail-closed path asserting the trigger value never reaches disk
- `tests/runtime.fetch-record.test.ts` -- create; record, serve-from-record, one-value-per-run, and the version refusal

Read-only evidence, authoritative and not to be edited by this story:

- `ARCHITECTURE-SPINE.md` -- AD-4 (log is truth), AD-5 (envelope), AD-9 (layout), AD-13/AD-14 (fetch record), AD-21 (redaction), AD-23 (planes), AD-28 (schema_version), AD-29 (one writer, one seq assigner); plus Consistency Conventions
- `src/contracts/event.ts` -- `EventEnvelopeSchema`, `TimestampSchema`, `formatTimestamp`, `EVENT_TYPES`, `compareEventOrder`
- `src/contracts/schema-version.ts` -- `versioned`, `parseVersionedArtifact`, `SchemaVersionRefusal`
- `src/contracts/error.ts` -- `redaction.failed` and `permission.denied` are already declared with dispositions
- `docs/specs/spec-agent-orchestrator/stories/1-1-contracts-package.md` -- its Code Map, Spec Change Log and deferred list

Carried forward from story 1-1, which recorded these as this story's business:

- `compareEventOrder` is undefined for equal or negative `seq` and does not separate runs. This story owns per-run monotonicity, so the tie case must become unreachable rather than merely untested.
- Three event types (`permission.denied`, `redaction.failed`, `budget.exhausted`) are also error codes. The recorder is the first component to emit both, so it must not conflate them.
- Zod 4 lessons that bind any schema added here: `z.int()` exports safe-integer bounds and so falls outside the structured-outputs subset, `z.date()` cannot be exported at all, and refinements emit no JSON Schema keywords.

## Tasks & Acceptance

**Execution:**
- `src/runtime/paths.ts` -- resolve `ORCH_HOME` (default `~/.orch`) and build the `runs/<run-id>/` paths of AD-9 -- one place owns the layout, so later stories cannot disagree about where a run lives
- `src/contracts/fetch.ts`, `src/contracts/registry.ts` -- define the `fetch-record.json` artifact with `versioned()` and register it as `fetch.record` -- AD-28 requires the version field and AD-17 requires the registry entry rather than an inline schema
- `src/runtime/redaction.ts` -- implement the pass over known token prefixes, high-entropy strings, env-file contents, private-key headers and registered literal secrets, returning a redacted value or an explicit failure -- AD-21 makes this a write-path invariant with no later remedy
- `src/runtime/recorder.ts` -- claim sole writership for a run, assign `seq`, validate against `EventEnvelopeSchema`, redact, then append one whole line -- AD-29 gives the file one writer and one `seq` assigner, and AD-4 makes the result immutable
- `src/runtime/recorder.ts` -- on a redaction failure, drop the artifact and append `redaction.failed` in its place, carrying no part of the triggering value -- failing closed is what keeps an unredacted secret from becoming permanent
- `src/runtime/fetch-record.ts` -- record a request and response through redaction, serve an already-recorded request without contacting the domain, and hold one value per record per run -- AD-14 makes a re-run deterministic
- `src/runtime/index.ts` -- expose the recorder, the fetch record and the paths as the surface story 1-3 consumes -- the engine depends on runtime, never the reverse
- `tests/runtime.redaction.test.ts` -- cover each secret class and assert the fail-closed path never writes the trigger value -- a redaction hole is invisible until a secret is already permanent
- `tests/runtime.recorder.test.ts` -- cover `seq` monotonicity across many appends and producers, envelope rejection, unknown-type passthrough, the single-writer refusal, and that an interrupted append leaves only whole lines -- these are the properties the stage-1 gate rests on
- `tests/runtime.fetch-record.test.ts` -- cover record, serve-from-record without a domain call, one-value-per-run, and the `schema_version` refusal -- AD-13's replay guarantee is otherwise unenforced

**Acceptance Criteria:**
- Given a clean checkout on Node `>=22.22`, when `npm run typecheck && npm run lint && npm test && npm run build` is run, then all four succeed and the runtime suites appear in the test output.
- Given a fresh run directory, when n events are appended through the recorder from several producers, then the file holds n lines whose `seq` values are exactly 1..n in submission order, and no line is ever modified afterwards.
- Given an event whose payload contains a registered credential's literal value, when it is appended, then the written line contains a redaction marker and does not contain that value anywhere.
- Given a redaction pass that fails on an artifact, when the recorder handles it, then the artifact is not written, a `redaction.failed` event is appended in its place, and the triggering value appears nowhere in the file.
- Given an event whose `type` is outside the declared vocabulary, when it is appended and read back, then it round-trips unchanged; and given an event missing a declared field, then it is rejected and the file is unchanged.
- Given a recorder already holding a run's log, when a second recorder attempts to append to the same run, then the attempt is refused naming the holder, and the file has exactly one writer.
- Given a request already present in the run's fetch record, when a later step asks for it, then the value is served from the record and no domain request is made.
- Given `src/runtime/`, when its imports are inspected, then it imports only from `src/contracts/` and `node:` builtins.

## Spec Change Log

### Implementation, 2026-09-19 — six deviations from the Code Map, none to the intent contract

1. **`src/contracts/index.ts` modified, beyond the two contracts files the Code Map names.** The new
   `fetch.ts` has to reach the runtime through the package surface, and importing the barrel is also
   what asserts the AD-28 Node floor. One line added: `export * from './fetch.js'`.

2. **`tests/helpers/append-until-killed.ts` added.** The Design Notes require a test that kills or
   interrupts a real write, which needs a child entry point: an in-process assertion cannot stand for
   a killed process. It is spawned as
   `node --import jiti/register tests/helpers/append-until-killed.ts <orch-home> <run-id>`, because
   the sources use TypeScript's `.js` specifier convention, which Node's own type stripping does not
   remap to `.ts`; `jiti` is already a devDependency (ESLint loads `eslint.config.ts` through it).
   The helper is not a `*.test.ts` file, so the Vitest `include` does not pick it up.

3. **AD-5's stream-origin fields are exempted from redaction, verbatim.** Found while implementing,
   not assumed: a `parent_tool_use_id` such as `toolu_01A09q90qw90lq917835lq9` is long, mixed-case
   and carries digits, so the high-entropy rule redacted it — and AD-5 requires it preserved
   verbatim. `parent_tool_use_id` and `session_id` are now restored from the submission after the
   pass, and a registered credential appearing in either fails closed under a new
   `passthrough-carries-secret` reason rather than being written. `toolu_`/`msg_`/`req_` identifier
   shapes are likewise exempt from the entropy rule, alongside ULIDs, UUIDs and commit SHAs, whose
   redaction would make the log unreadable. Known credential prefixes are matched *before* this rule,
   so the exemptions cannot let a known token through.

4. **The single-writer claim is a lock file, reclaimed only against a dead pid.**
   `runs/<run-id>/events.jsonl.lock` is created exclusively (`wx`) and records pid, host and start
   time; a refusal names the holder. A stale lock is reclaimed only once the recorded pid is
   verifiably gone on the same host — AD-30's rule applied to the log's claim — so a crashed run is
   resumable while a live holder is never displaced. An in-process registry refuses a second recorder
   in the same process, where a pid check would report the holder alive and say nothing useful.
   `WriterConflictError.code` is `engine.lock_held`, the AD-35 table's only lock-held code; no
   recorder-specific code is declared, and adding one is a contracts change this Code Map excludes.

5. **A corrupt or seq-repeating log is refused, never repaired.** AD-4 forbids mutating or rewriting
   an appended line, so `EventLogCorruptError` reports an unterminated trailing line or a repeated
   `seq` and refuses the run rather than truncating. This is also how the tie case that story 1-1
   left undefined in `compareEventOrder` becomes unreachable: duplicate `seq` values cannot be
   produced by the one assigner, and a file that holds one cannot be appended to.

6. **The fetch record takes a `Recorder`, not a path.** `RunFetchRecord.open({ recorder })` makes the
   AD-29 single-writer claim cover `fetch-record.json` as well as the log, and shares one redaction
   policy between the two. Writes are atomic — temporary file in the same directory, then rename —
   per the Consistency Conventions. `fetchRequestKey` lives in `src/contracts/fetch.ts` as a SHA-256
   over a canonical rendering, so the runtime and any later MCP server derive the same key and no
   request parameter is stored in the clear as a map key.

Two verification findings from mutation testing, both acted on rather than noted:

- **The last-resort serialisation gate masked a missing redaction pass.** Appending the *unredacted*
  candidate left 214/214 green: the pre-append gate that scans a serialised line for registered
  literals replaced the line wholesale, so the secret still never reached disk and every assertion
  about its absence held. The suite could not tell defence-in-depth from the pass itself. Fixed by
  asserting the *positive* outcome — the event is appended with its type and surrounding text intact
  and the value replaced in place — and by adding a class the gate cannot know about (an `sk-ant-`
  token, matched by pattern rather than by registered literal). The mutation now fails two tests.
- **The interrupted-append test was flaky in its event-count bound.** A 128 KiB size threshold
  guarantees only ~30 lines of a little over 4 KiB each, while the assertion demanded more than 50.
  The threshold is now 512 KiB, so the bound follows from it; the test passed three consecutive runs.

Zod 4 constraints carried forward from 1-1 and respected here: `src/contracts/fetch.ts` uses no
`z.int()` and no `z.date()`; the request-key format and the unique-key rule are refinements, which
emit no JSON Schema keywords. `fetch.record` is an `artifact`-kind contract, so the structured-outputs
subset guard does not bind it, while the registry's artifact sweep does — a `fetch-record.json`
missing `schema_version` now fails `tests/contracts.behaviour.test.ts` automatically.

`redaction.failed` is both an event type and an error code, and the recorder is the first unit to
emit both. They are kept apart deliberately: `REDACTION_FAILED_EVENT_TYPE` names the line, and the
`disposition` on that line is read from the AD-35 table via `dispositionFor` rather than restated, so
the two cannot drift.

## Review Triage Log

### 2026-09-19 — Review pass 1 (18 findings, all patched)

Redaction (AD-21):
- `[high]` `[patch]` A pattern-class secret in `parent_tool_use_id`/`session_id` reached disk verbatim: the guard was `provesFree`, which knows registered literals only. Patched with `provesPatternFree` — every class but the entropy heuristic — and a drop when the value would have changed.
- `[high]` `[patch]` `feature`, `run` and `step` were written raw onto the `redaction.failed` line, which is built rather than submitted and so never saw the pass. Patched: identity fields go through `provesPatternFree` and fall back to a fixed marker; a producer `step` that is a token becomes null.
- `[high]` `[patch]` The high-entropy class missed whole families of real keys — hex HMAC secrets, hex digests, single-case tokens — because it demanded lower *and* upper *and* digit and exempted hex. Patched: length plus entropy alone, and the shape exemptions (ULID, UUID, hex, `toolu_`) deleted. Identifiers now survive on punctuation instead: the candidate run excludes separators, so `feature/runtime-recorder`, a UUID's groups and `toolu_01A09q…` split below the threshold while an unbroken digest does not. An unbroken ULID or commit SHA *inside a payload* is now redacted, which is the fail-safe direction; the two AD-5 fields are protected by name.
- `[medium]` `[patch]` A credential in a URL's userinfo was covered by no class. Patched with a `url-credential` class replacing the password of `scheme://user:password@host`.
- `[medium]` `[patch]` `provesFree` compared the raw literal only, so a secret carrying a quote, backslash or control character was unprovable in serialised form. Patched: both the raw and JSON-escaped forms.

The recorder (AD-4, AD-5, AD-29):
- `[medium]` `[patch]` `recordResult` reported `dropped: false` when the last gate had replaced the line, and returned an unchecked `JSON.parse` cast. Patched: `append` reports what it wrote, the substitute is validated against `EventEnvelopeSchema`, and nothing is written if even the substitute carries the literal.
- `[medium]` `[patch]` A producer could name a foreign `run` or `feature` and have it appended into this run's log. Patched: a mismatch is rejected naming the field; absence stays the envelope's own rejection.
- `[medium]` `[patch]` `scanForNextSeq` continued past a gap (`1,3` reopened at 4). Patched: line *i* must carry seq *i*, so a gap, a repeat and a sub-floor seq are all refused.
- `[medium]` `[patch]` `close()` unlinked the lock without checking ownership, so a previous holder could strip a live holder's claim after a reclaim. Patched: pid and host are compared first.
- `[medium]` `[patch]` The `openSync(…, 'wx')` catch treated `EACCES`, `ENOSPC`, `EROFS` and `ENOTDIR` as writer conflicts. Patched: only `EEXIST` is a conflict, everything else rethrows.

The fetch record (AD-13, AD-14, AD-28):
- `[medium]` `[patch]` Two live instances clobbered each other — 2 `fetch.recorded` events, 1 entry on disk. Patched: the record is re-read immediately before each write, and the first value for a key still wins.
- `[medium]` `[patch]` The key was derived from the raw request while the redacted request was stored, so no reader could re-derive it. Patched: the key is taken over the request that is stored. The digest is carried at 64 bits because the key travels in the log, where an unbroken 64-character digest now reads as high-entropy secret material.
- `[medium]` `[patch]` `await perform()` sat outside any try/catch, so a failed external read left no event and no entry. Patched: an `ok: false` value is recorded and emitted, then the failure is rethrown unchanged.
- `[medium]` `[patch]` `open()` never checked `record.run`, so a record copied from another run was served as this run's. Patched with `ForeignFetchRecordError`.
- `[low]` `[patch]` `write()` had no fsync and left `fetch-record.json.<pid>.tmp` behind after a crash. Patched: the temporary file and the directory are fsynced, and stale temporaries are swept on open.

Verification gaps (each confirmed by the reviewer's own deletion, each now failing under it):
- `[medium]` `[patch]` The last-resort serialisation gate was unpinned — replacing it with `const safe = serialised` left 215/215 green. Patched with a case driven through `Recorder.record` where the literal spans JSON syntax and reaches the gate only via the AD-5 passthrough restore.
- `[medium]` `[patch]` Corrupt-log refusal was pinned only for a repeated seq; tolerating a torn trailing line, or accepting a valid-JSON non-envelope line, both left the suite green. Patched: three corruption shapes, asserted against both `readEventLog` and `Recorder.open`, naming the line number.
- `[low]` `[patch]` `resolveOrchHome`'s relative-path resolution and the `size-exceeded` fail-closed reason had no expectation. Patched with one each.

Suites after the pass: 61 recorder, 57 redaction, 17 fetch-record; `typecheck`, `lint` and the contracts suites green.

### 2026-09-19 — Review pass
- verdicts: 68 findings — high 9, medium 32, low 24, false 2, maybe-false 1
- layers: blind-hunter (15), edge-case-hunter (34), verification-gap (4 gap + 4 other), intent-alignment (11)
- note: the verification-gap layer disclosed that its sandbox denied source edits, so the parent executed its four demonstrations itself; each is recorded as EXECUTED below.
- findings:
  - `[high]` `[patch]` BH1 preservePassthrough reopens the hole it closes — only registered literals are backstopped — VERIFIED by parent probe: sk-ant-api03 token in parent_tool_use_id written verbatim while the same token in payload is redacted. Patched: original routed through the pattern classes, failing closed.
  - `[medium]` `[patch]` BH2 the last-resort gate reports success while substituting a redaction.failed line — Confirmed by reading append()/recordResult(): provesFree false -> minimalFailureLine substituted, envelope validation skipped, dropped:false returned. Patched.
  - `[medium]` `[patch]` BH3 the recorder never checks a submission belongs to its run — VERIFIED: a submission with run 'SOME-OTHER-RUN' was appended into this run's log. Patched: run and feature reconciled against the recorder's own.
  - `[medium]` `[patch]` BH4 seq gaps are neither prevented nor detected — VERIFIED: a log holding 1,3 reopens and continues at 4, against the AC's 'exactly 1..n with no gaps'. Patched: scan refuses a gap and a seq below FIRST_SEQ.
  - `[medium]` `[patch]` BH5 close() can delete another holder's lock — close() unlinks unconditionally without comparing the recorded claim, so a previous holder erases a live one after a reclaim. Patched: read and compare before unlinking.
  - `[low]` `[patch]` BH6 every lock-open failure is reported as a writer conflict — EACCES/ENOSPC/EROFS surface as 'an unreadable lock file'. Fix is a direct correction (branch on EEXIST), so not rejected. Patched.
  - `[medium]` `[patch]` BH7 RunFetchRecord holds an unsynchronised snapshot, so two live instances lose entries — Reviewer reproduced 2 fetch.recorded events with 1 entry on disk, the first lost. Patched: re-read before each write.
  - `[medium]` `[patch]` BH8 a thrown perform() leaves no record and no event — Against 'every external read is recorded'. Patched: catch, record ok:false, emit, rethrow.
  - `[medium]` `[patch]` BH9 RunFetchRecord.open does not validate record.run — A record copied from another run is served as this run's. Patched with an identity check.
  - `[low]` `[patch]` BH10 fetch-record writes are not durable and leave .tmp debris — No fsync of temp or directory while the event log defaults to fsync. Patched.
  - `[medium]` `[defer]` BH11 readEventLog makes one bad line fatal for the whole run, and is O(file) per open — Refusing is the spec's own stated rule ('refused, never repaired'), so the fatality is intended; the forward-compatibility and large-log halves are real and deferred.
  - `[high]` `[patch]` BH12 high-entropy coverage has a wide untested false-negative band — VERIFIED unredacted: 40-char hex, 64-char hex, upper+digit-only 32, lower+digit-only 32. Only mixed-case+digit is caught. Patched: class broadened, identifiers preserved by name instead of by shape.
  - `[low]` `[patch]` BH13 no guard on the registered-secret list; size-exceeded untested — The size-exceeded test is patched (parent confirmed its deletion left the suite green). The minimum-length guard on secrets is rejected: it adds policy the spec does not set.
  - `[medium]` `[defer]` BH14 canonicalJson silently collides on values JSON cannot round-trip — NaN, Infinity and undefined all render as null so distinct requests share one fetch key. Refusing a non-plain-JSON parameter tree adds surface and belongs with the component that builds requests.
  - `[low]` `[reject]` BH15 story-document loose ends (empty triage heading, Code Map lists 9 files vs 12 shipped, Verification records no observed outcome) — Fix is to edit this build's spec. The Verification-evidence point is addressed at finalize by recording observed counts under Auto Run Result.
  - `[medium]` `[defer]` EC1 canonicalJson recurses forever on cyclic request parameters — Same root cause as BH14: the fetch key needs a plain-JSON precondition, which belongs with the request builder.
  - `[low]` `[defer]` EC2 bigint throws raw, symbol and function key as null — Same family as BH14.
  - `[medium]` `[defer]` EC3 NaN, Infinity, null and undefined collapse to one key — Same family as BH14; the collision is real and recorded.
  - `[medium]` `[patch]` EC4 the key is derived from the raw request while the stored request is redacted — Reviewer measured two different digests, so no reader can re-derive a key from the record. Patched: key derived from the stored form.
  - `[medium]` `[patch]` EC5 two live RunFetchRecord instances clobber each other — Same entry as BH7; reproduced by the reviewer. Patched.
  - `[low]` `[reject]` EC6 emitRecorded throwing after write leaves a record entry the log never names — No trigger was demonstrated and the fix only reorders two statements; the divergence window is narrower than the crash windows already accepted elsewhere.
  - `[medium]` `[patch]` EC7 perform() rejecting leaves no event and no record — Same entry as BH8. Patched.
  - `[medium]` `[defer]` EC8 two overlapping serve() calls contact the domain twice — Real against AD-14, but no async concurrency exists until the engine drives steps in 1-3; recorded for that story.
  - `[medium]` `[patch]` EC9 a fetch-record carrying a foreign run id is served as this run's — Same entry as BH9. Patched.
  - `[low]` `[patch]` EC10 no fsync of the temp file or directory before rename — Same entry as BH10. Patched.
  - `[medium]` `[patch]` EC11 caller told dropped:false while its artifact was replaced — Same entry as BH2; reviewer verified end-to-end. Patched.
  - `[high]` `[patch]` EC12 a non-registered secret class in a passthrough field is restored verbatim — Same entry as BH1; VERIFIED by parent probe. Patched.
  - `[low]` `[defer]` EC13 two processes reclaiming one stale lock concurrently leak a raw ENOENT — Needs two processes racing on reclaim of the same dead pid; the outcome is a less helpful error, not a lost invariant.
  - `[low]` `[reject]` EC14 close() cannot unlink while its own pid is alive, contradicting its comment — The real risk in close() is deleting someone else's claim, which BH5 patches; this residue is a comment-accuracy point with no demonstrated harm.
  - `[low]` `[defer]` EC15 a throwing writeSync of the claim leaves an empty, never-reclaimable lock — Would make a run permanently unopenable, but requires the write of a ~100-byte claim to fail after a successful exclusive create.
  - `[low]` `[defer]` EC16 a lock recording pid 0 or a negative pid reads as permanently held — process.kill(0,0) signalling the caller's group is real; reaching it requires a hand-corrupted lock file.
  - `[medium]` `[patch]` EC17 an existing log with a seq gap, or a seq of zero or negative, is accepted — Same entry as BH4; VERIFIED. Patched.
  - `[maybe-false]` `[reject]` EC18 a submitted seq equal to the assigned one is silently accepted — Could not establish this: the recorder refuses any submitted seq (recorder test 'refuses a submitted seq — assignment is the recorder`s alone'), so equality appears unreachable. If true it would be low. What would settle it: a probe submitting seq exactly equal to nextSeq.
  - `[low]` `[defer]` EC19 writeSync returning zero could spin, or EAGAIN could tear a line — The resume loop's pathological cases are real but unreached on a regular file; recorded alongside IA5.
  - `[medium]` `[defer]` EC20 an events.jsonl beyond Node's max string length makes the run unresumable — Same root cause as BH11's large-log half. Deferred with it.
  - `[low]` `[reject]` EC21 an injected clock returning an Invalid Date lets a RangeError escape — The clock is injected only by tests; no production path supplies one, so this is code that loudly fails on a state never shown reachable.
  - `[high]` `[patch]` EC22 hex-only and single-case secrets are exempted from the entropy rule — Same entry as BH12; VERIFIED by parent probe. Patched.
  - `[high]` `[patch]` EC23 a password inside a connection URL is not redacted by any class — VERIFIED: DATABASE_URL=postgres://appuser:pa55word-secret@db.internal:5432/main keeps its password. Patched with a URL-userinfo pattern.
  - `[low]` `[defer]` EC24 an oversized artifact is fully walked and serialised before the size gate rejects it — A resource-shape concern, not a correctness one; the gate still fails closed.
  - `[low]` `[patch]` EC25 provesFree is a no-op for a secret containing a quote or backslash — The last gate cannot prove such a literal absent in serialised form. Patched: compare the JSON-escaped form too.
  - `[low]` `[defer]` EC26 a whitespace-padded absolute ORCH_HOME resolves under cwd — Real but requires a padded environment value; recorded with IA9's path-scope entry.
  - `[false]` `[reject]` EC27 a caller-supplied relative orchHome bypasses the in-process single-writer guard — REFUTED by parent probe: opening the same directory spelled absolute and then relative was refused with WriterConflictError, so the holders map is not bypassed.
  - `[low]` `[defer]` EC28 a waitUntil timeout leaves the append-until-killed child running — Test-hygiene issue in a helper that is killed in the normal path.
  - `[low]` `[defer]` EC29 a failed spawn yields an undefined pid and pidIsAlive(-1) — Same test-helper family as EC28.
  - `[medium]` `[patch]` EC30 (claim) a key re-derived from a record entry does not match the stored key — Same entry as EC4; reviewer verified with two digests. Patched.
  - `[medium]` `[patch]` EC31 (claim) two live instances produced two events and one entry — Same entry as BH7/EC5. Patched.
  - `[medium]` `[patch]` EC32 (claim) dropped:false while redaction.failed was written — Same entry as BH2. Patched.
  - `[high]` `[patch]` EC33 (claim) 40-char hex, upper+digit and lower+digit secrets pass through — Same entry as BH12; independently VERIFIED by parent probe. Patched.
  - `[false]` `[reject]` EC34 (claim) two callers spelling one directory differently get different paths and locks — REFUTED for the load-bearing half, as EC27: the second open was refused. The padded-ORCH_HOME half is deferred as EC26.
  - `[medium]` `[patch]` VG1 corrupt-log refusal is verified only for a repeated seq — Parent EXECUTED both demonstrations the layer could not: tolerating a torn trailing line leaves 215/215 green, and accepting a non-envelope line leaves 215/215 green. Patched with both cases.
  - `[medium]` `[patch]` VG2 the last-resort serialisation gate is never exercised through the recorder — Parent EXECUTED it: replacing the gate with `const safe = serialised;` leaves 215/215 green. Patched with a literal reachable only in serialised form.
  - `[low]` `[patch]` VG3 ORCH_HOME relative-value resolution has no test — Parent EXECUTED it: returning the declared value unresolved fails nothing. Patched with one expectation.
  - `[low]` `[patch]` VG4 size-exceeded and unserialisable-value reasons have no test — Parent EXECUTED the size-exceeded deletion: 215/215 green. Patched for size-exceeded; unserialisable-value deferred, as the plain-record walk appears to make it unreachable.
  - `[high]` `[patch]` VGO1 recorder-originated redaction.failed lines bypass the pass entirely — VERIFIED by parent probe: a step of ghp_Aa0Bb1... satisfies SAFE_STEP_NAME and lands verbatim on the failure line, and minimalFailureLine reproduces the same fields. Patched.
  - `[high]` `[patch]` VGO2 the AD-5 passthrough restore backstops only registered literals — Same entry as BH1/EC12. Patched.
  - `[medium]` `[patch]` VGO3 nothing reconciles a submission's run/feature with the recorder's own — Same entry as BH3; VERIFIED. Patched.
  - `[medium]` `[patch]` VGO4 recorded_by_step is written to fetch-record.json outside the pass — Folded into the VGO1 fix: recorder- and record-owned fields go through the pass or a safe placeholder.
  - `[medium]` `[defer]` IA1 (R1) the intent names two OS processes; the diff ships an in-process module with no submission transport — The intent's own Never list excludes the MCP server implementation, the only out-of-process producer it names, so the transport is out of scope by the intent's terms. Recorded because stories 1-4 and 2-10 must supply it, and because the Always clause overstated what this story could deliver.
  - `[medium]` `[defer]` IA2 (3.1) 'several producers' is tested as a string in the emitter field, in one loop — Accurate: the multi-process emit path cannot be tested until a transport exists. Deferred with IA1.
  - `[high]` `[patch]` IA3 (3.2) the high-entropy class is tested at the surface of the implementation's own predicate — One mixed-case positive sample matches exactly the lower+upper+digit rule, so the false-negative band is invisible. Same entry as BH12; tests grow with the broadened class.
  - `[medium]` `[patch]` IA4 (3.3) the fail-closed contract has a third, silent outcome — Same entry as BH2. Patched so the outcome is observable.
  - `[medium]` `[defer]` IA5 (3.4) the append resume loop has interruption points the 4 KiB kill test cannot reach — Whole-line atomicity rests on one write syscall per line; a genuine tearing test needs a line large enough to split. Recorded with EC19.
  - `[low]` `[reject]` IA6 (3.5) the no-delete guarantee is checked by method-name spelling — The behavioural neighbour is properly tested: the file's existing bytes are asserted byte-identical after further appends.
  - `[medium]` `[defer]` IA7 (3.6) the second-writer row has three outcomes; two are outside the matrix and untested — Reclaim-if-dead and refuse-if-alive were both verified by parent probes; the unreadable-lock and foreign-host states are EC13/EC15's family and deferred with them.
  - `[low]` `[reject]` IA8 (3.7) the declared-field rejection sweep excludes ts and seq — R4-b is the only coherent reading: AD-29 makes seq the recorder's alone and the matrix itself says the recorder stamps ts when a producer keeps no clock, so those two were never producer-supplied fields.
  - `[low]` `[defer]` IA9 (3.8) paths.ts owns the whole AD-9 layout plus a refusal the matrix has no row for — Harmless and tested, but beyond the two files the intent named; recorded so the unlicensed surface is visible rather than discovered later.
  - `[medium]` `[defer]` IA10 (3.9) across-invocation replay is structurally supported but exercised nowhere — Every serve-from-record test runs against a record populated in the same test body. A second-invocation test arrives with the engine in 1-3.
  - `[low]` `[reject]` IA11 two reading choices (R1 and R4) are asserted in a docblock and a test comment rather than logged — Fix is to edit this build's spec change log.

## Design Notes

Two properties are easy to claim and hard to hold, so both are specified as observable outcomes rather than as mechanisms.

**Whole lines only.** AD-4 makes every line immutable, which means a torn trailing line is permanent corruption of the durable truth. The requirement is that a reader never sees a partial line; how that is achieved (a single append of one buffer ending in a newline, versus write-then-fsync) is the implementer's call, but a test must kill or interrupt a write and then assert every line in the file parses.

**Fail closed means the value never lands.** It is not enough to skip the artifact: the `redaction.failed` event that replaces it must carry no fragment of the triggering value — not in a message, not in a field name, not in a length or hash that reproduces it. The test for this asserts absence of the secret from the whole file, not merely from the dropped artifact.

On `seq`: story 1-1 left `compareEventOrder` undefined for ties. Because this story is the only assigner, a tie is a recorder bug rather than a comparison edge case, so the fix is to make duplicate `seq` values impossible per file and to assert that property, rather than to define a tie-break.

## Verification

**Toolchain:** the PATH default `node` on this machine is v22.14.0, below the declared floor, and will fail at import time. Use the nvm-installed Node 24.x LTS by absolute path, as story 1-1 did:

```
export PATH="/Users/deep/.nvm/versions/node/v24.21.0/bin:$PATH"   # node v24.21.0, npm 11.19.0
```

**Commands:**
- `npm run typecheck` -- expected: exit 0
- `npm run lint` -- expected: exit 0
- `npm test` -- expected: exit 0; the three runtime suites present and passing alongside the four contracts suites
- `npm run build` -- expected: exit 0
- `grep -rn "from '\.\./" src/runtime/` -- expected: only imports of `../contracts/...`; no other `src/` layer referenced

## Auto Run Result

Status: done
Blocking condition: none

**Implemented change.** `src/runtime/` — the runtime recorder: the sole appender of a run's `events.jsonl`
and the sole assigner of `seq`, with a fail-closed redaction pass on the producer/log boundary and the run
shared fetch record that makes an external read replayable. `src/contracts/` grew its first new contract
since story 1-1 (`fetch.record`), which is the AD-17 pattern.

**Files changed** (13 files, 3815 insertions, no deletions, from baseline `c21a51119c465b4a78479bec6c80dbdb096bd79e`):

- `src/runtime/paths.ts` — AD-9 layout: `ORCH_HOME` resolution and the `runs/<run-id>/` paths
- `src/runtime/redaction.ts` — the AD-21 pass: registered literals, token prefixes, private-key blocks,
  env-file contents, URL credentials and a length-plus-entropy class, failing closed as a value not an exception
- `src/runtime/recorder.ts` — the single-writer claim, `seq` assignment, envelope validation, whole-line append
- `src/runtime/fetch-record.ts` — AD-13/AD-14 record: serve-from-record, one value per key per run
- `src/runtime/index.ts` — the surface story 1-3 consumes
- `src/contracts/fetch.ts`, `src/contracts/registry.ts`, `src/contracts/index.ts` — the `fetch.record` artifact
- `tests/runtime.{recorder,redaction,fetch-record}.test.ts`, `tests/helpers/append-until-killed.ts`

**Review findings.** Four layers reported 68 findings: high 9, medium 32, low 24, false 2, maybe-false 1.
Routed to 18 patch entries (4 high, 10 medium, 4 low), 14 deferred entries covering 22 deferred findings, and
rejections recorded row by row in the Review Triage Log above. Nothing routed to `bad_spec` or `intent_gap`.

The nine `high` verdicts were four distinct defects, all in the redaction subsystem, and each would have put a
credential on disk permanently — the one thing AD-21 says has no remedy. All four were verified by parent probe
before patching and re-verified after:

1. The AD-5 passthrough restore backstopped only registered literals, so `sk-ant-api03-…` in
   `parent_tool_use_id` was written verbatim. Now guarded by a pattern-class proof and dropped: verified
   `dropped: true` and the token absent from the file.
2. Recorder-originated `redaction.failed` lines never passed through the pass at all — a `ghp_…` step
   satisfied `SAFE_STEP_NAME` and landed raw on the line reporting the failure. Now absent.
3. The entropy class exempted hex-only and single-case runs and required lower+upper+digit, so 40-char hex,
   64-char hex, upper+digit and lower+digit secrets all passed through. Now redacted (re-verified with
   cryptographically random hex; the first 64-char sample the parent used was itself low-entropy and its
   apparent survival was a test artifact, not a defect).
4. A password inside `postgres://user:password@host` was covered by no class. Now replaced, user and host kept.

Identifier survival was re-verified alongside: `toolu_` ids, UUIDs and slugs still pass through unchanged, and
the envelope's own `run`, `feature` and `step` are intact.

Patched entry counts by verdict: high 4, medium 10, low 4.

**Follow-up review recommended: true.** First pass with four `high` entries patched. The specific unverified
risk: *broadening the entropy class redacts commit SHAs and unbroken ULIDs inside event payloads.* Verified
after patching — a `baseline_ref` in a payload reads `[redacted]`. Nothing breaks today, because the envelope's
own identifier fields survive and AD-26 baseline refs live in the step input file and `state.json` rather than
in the log. But this was a trade the parent directed without weighing it against AD-4's "a run is fully
reconstructable from the event log", and story 1-3 must not put a SHA or ULID in a payload it expects to read
back. The correct fix, if reconstruction ever needs one, is a proven-pattern-free allow-list by field path —
not a return to shape exemptions, which is exactly what opened defect 1.

**Verification performed** (Node v24.21.0 by absolute path; the machine's PATH default is v22.14.0, below the floor):

- `npm run typecheck`, `npm run lint`, `npm run build` → exit 0; `npm test` → 7 files, **246 passed** (215
  before the patch round, 104 runtime tests before review), none skipped
- Import direction: `src/runtime/` reaches only `../contracts/index.js`
- Matrix audit: all 13 I/O rows map to named tests that ran and passed
- Parent probes of the single-writer claim: two live processes refused; a lock naming a live foreign pid
  refused; a crash leaving a lock on a dead pid reclaimed with `seq` resuming correctly; a malformed
  submission rejected with the file unchanged
- Parent mutation testing, before the patch round: five guards could be deleted with 215/215 still green (the
  last-resort `provesFree` gate, torn-trailing-line refusal, non-envelope refusal, relative `ORCH_HOME`
  resolution, the `size-exceeded` check). After the patch round, each mutation fails: torn line 1 failure,
  non-envelope 1 failure, passthrough guarded by literals only 2 failures. Every mutation reverted
  byte-identically and the suite returned to 246.

**Residual risks.** The fourteen deferred entries above, of which the ones story 1-3 should read first are: the
SHA/ULID payload redaction named as the follow-up risk; the absence of any out-of-process submission transport,
which means "every producer emits through it" is not yet true for a producer in another process; the sticky
`ok: false` fetch entry, since retry belongs to the engine's disposition table; and `Recorder.open` being
O(file size) with no tail-scan path.
