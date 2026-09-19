---
title: 'Contracts package — schemas, Command enum, event envelope, error dispositions'
type: 'feature'
created: '2026-09-19'
status: 'done'
review_loop_iteration: 0
followup_review_recommended: true
context:
  - '{project-root}/docs/planning-artifacts/architecture/architecture-agent-orcastrator-2026-09-19/ARCHITECTURE-SPINE.md'
  - '{project-root}/docs/specs/spec-agent-orchestrator/SPEC.md'
  - '{project-root}/docs/specs/spec-agent-orchestrator/interface-contract.md'
warnings: ['oversized'] # ~2800-3400 tokens vs the 1600 target: 16 created files and 12 I/O scenarios; trimming further would cut the Code Map or the matrix
deferred:
  - summary: >-
      The narrowed catch in assertNodeFloorOrExit is correct but unverified: removing the rethrow
      leaves the whole suite green.
    evidence: |-
      Found by the parent's own post-patch mutation testing, not by a review layer. Deleting `if
      (!(error instanceof NodeFloorError)) throw error;` leaves 16/16 node-floor tests and 107/107
      overall passing. The test cannot discriminate: with the rethrow Node prints the underlying error
      (which contains 'semantic version') to stderr and exits 1; without it the handler writes the
      same text and exits 1, so both satisfy 'stderr contains semantic version', 'stderr lacks or
      newer is required' and 'status is non-zero'. A discriminating assertion would key on the shape
      of the output — a propagated error carries a stack frame, the handled path emits exactly one
      formatted line.
    location: >-
      src/contracts/node-floor.ts, tests/contracts.node-floor.test.ts
    severity: low
  - summary: >-
      OrchError.retryable can contradict the AD-35 disposition table, since the field is
      model-supplied and unvalidated.
    evidence: |-
      Verified: {code:'budget.exhausted',retryable:true} parses cleanly while dispositionFor says
      abandon-and-hand-off and isRetryable says false. Harm needs a consumer that trusts the flag over
      the table; none exists until the engine re-parses structured_output.
    location: >-
      src/contracts/error.ts
    severity: medium
  - summary: >-
      No contract field carries a .describe(), so constraints the structured-outputs subset strips
      never reach the model.
    evidence: |-
      Verified 0 .describe() calls. Rules like 'RFC3339 with milliseconds', 'at most three options
      plus an escape' and '0 to 1, never a currency amount' exist only as TypeScript comments, while
      the model handed the export sees a bare typed field. description is explicitly benign to the
      subset guard.
    location: >-
      src/contracts/step.ts, question.ts
    severity: medium
  - summary: >-
      contract_id is an unvalidated string on both step contracts, so the engine cannot rely on it to
      select a schema.
    evidence: |-
      Verified 'totally-bogus' parses. A registry z.enum would create an import cycle (registry
      imports step), so validation has to happen where a contract is resolved.
    location: >-
      src/contracts/step.ts
    severity: medium
  - summary: >-
      engines.npm '<12' is declared but never asserted, so npm 12 installs silently and breaks the
      AD-12 delivery path.
    evidence: |-
      Verified no npm version check anywhere in src/. The spec's startup-assertion Boundary names the
      Node version only, so adding an npm gate is new behaviour rather than a correction.
    location: >-
      package.json
    severity: medium
  - summary: >-
      No CI workflow, so the four-command gate every later story inherits runs only when someone
      remembers.
    evidence: |-
      Verified no .github/workflows. Acceptance criterion 1 specifies the commands pass on a clean
      checkout but never requires automation; adding a workflow is new scope.
    severity: medium
  - summary: >-
      compareEventOrder is undefined for equal or negative seq values, and does not separate runs.
    evidence: |-
      seq assignment is explicitly excluded from this story by the intent's Never list and belongs to
      the runtime recorder, which will own tie-breaking and per-run monotonicity.
    location: >-
      src/contracts/event.ts
    severity: low
  - summary: >-
      A step output can report status failed or blocked with error null, or completed with an error
      set.
    evidence: |-
      No cross-field check exists. The reviewer placed the check engine-side, where structured_output
      is re-parsed before acceptance; that consumer does not exist yet.
    location: >-
      src/contracts/step.ts
    severity: medium
  - summary: >-
      A command intent can carry argument null for commands that are meaningless without text (answer,
      reject, narrow, inject_note, edit_criterion).
    evidence: |-
      Verified no refinement ties command to argument. The reconciler is the only consumer of intent
      files and is where an unactionable intent must be refused.
    location: >-
      src/contracts/command.ts
    severity: medium
  - summary: >-
      A command intent can pair source 'timeout' with principal kind 'user', attributing an automatic
      default to a person.
    evidence: |-
      Verified no refinement ties the two. AD-19 requires approvals to be attributable, and the check
      belongs where intents are accepted.
    location: >-
      src/contracts/command.ts
    severity: medium
  - summary: >-
      findSubsetViolations lives inside the test file, so later stories can only re-run the suite
      rather than reuse the guard.
    evidence: |-
      Consistent with the story's no-runtime-behaviour boundary, but stories 2-4 through 2-7 each add
      step contracts and would benefit from calling the checker directly. Moving it into src/ adds
      package surface the spec did not authorize.
    location: >-
      tests/contracts.subset-guard.test.ts
    severity: low
  - summary: >-
      The schema_version gate is bypassable: calling .parse() directly on a versioned artifact accepts
      an unrecognised version.
    evidence: |-
      VERIFIED: CommandIntentSchema.parse({schema_version:99}) succeeds and only
      parseVersionedArtifact refuses. versioned() adds the field but nothing forces the version check,
      so any later reader that uses .parse() silently accepts a future artifact, which is what AD-28
      forbids.
    location: >-
      src/contracts/schema-version.ts
    severity: medium
  - summary: >-
      The story committed a domain vocabulary well beyond the intent, and the expansion is the part
      with no test surface.
    evidence: |-
      RUN_MODES, STEP_DISPOSITIONS, EVIDENCE_KINDS, DecisionRecordSchema, BudgetSchema,
      REVERSIBILITY_CLASSES, WRITE_INTENT_KINDS, DEFLECTION_SOURCES and a 35-entry error table all
      landed, mostly unlogged. Later stories must accept or amend this vocabulary, so it needs review
      even though each piece looks reasonable.
    location: >-
      src/contracts/step.ts, error.ts
    severity: medium
  - summary: >-
      Event types and error codes share one dot-namespaced string space, with three names appearing in
      both.
    evidence: |-
      permission.denied, redaction.failed and budget.exhausted are simultaneously EVENT_TYPES members
      and ERROR_DISPOSITIONS keys, so a bare dot-namespaced string is ambiguous between the two
      planes. Distinguishing them is a design decision for the recorder story.
    location: >-
      src/contracts/event.ts, error.ts
    severity: low
baseline_revision: 'ddd9bed4d286ac1f8a0f4f7bfef9530046605787'
---

<intent-contract>

## Intent

**Problem:** The repository is greenfield — no package, no schemas, no shared types. The AD dependency graph gives `contracts` no dependencies and makes every other unit depend on it, so no later story can start; worse, without it each unit would invent its own event shape, error handling and command set, which is the exact drift AD-2, AD-3, AD-5 and AD-35 exist to prevent.

**Approach:** Stand up the single TypeScript package and its `src/contracts/` layer, defining every shared type once as a Zod v4 schema with a draft-7 JSON Schema export and a contract registry keyed by id. Add the AD-31 round-trip suite and the AD-28 Node floor assertion so the invariants are enforced by tests rather than by discipline.

## Boundaries & Constraints

**Always:**
- `src/contracts/` imports from no other `src/` directory; it is the root of the dependency graph.
- Every schema is a Zod v4 schema defined exactly once, exported with `z.toJSONSchema(schema, { target: "draft-7" })` — the target argument is mandatory, since Zod 4 defaults to draft-2020-12 and `claude -p --json-schema` rejects it.
- Step contracts stay inside the structured-outputs subset: no `z.date()`, no recursive or self-referential schemas, no `minLength`, no `minItems` greater than one, no `minimum`.
- Timestamps are `z.string()` carrying RFC3339 with milliseconds in UTC.
- Event type names are dot-namespaced and past-tense, and readers ignore unknown types rather than erroring.
- Every on-disk configuration and state schema carries `schema_version`.
- The required Node version is declared once, in `.nvmrc` and the `package.json` `engines` field, and asserted at startup.
- Pinned versions per the spine's Stack table: Node `>=22.22`, TypeScript 5.9.3, Zod 4.6.5, Vitest 5.0.1, typescript-eslint 8.70.0, npm `<12`.

**Never:**
- No runtime behaviour: no reconciler, recorder, spawner, docker wrapper, renderer or MCP server — those are stories 1-2 through 2-11.
- No `seq` assignment and no writing of `events.jsonl`; story 1-2 owns both. This story defines the envelope's shape only.
- Never link the Claude Agent SDK as a library, and never introduce a second implementation language.
- No React, Ink or Vite dependency — the renderers arrive in 1-9 and 3-1.
- No runtime code path may require `_bmad`, a BMad skill or a BMad command.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Valid event envelope | Object with `ts`, `seq`, `feature`, `run`, `step`, `emitter`, `type`, `payload` | Parses; `ts` accepted only as RFC3339 with milliseconds | No error expected |
| Unknown event type | Envelope whose `type` is outside the declared vocabulary | Parses and is accepted | No error — adding an event type is never breaking (AD-5) |
| Event envelope missing a required field | Object without `emitter` | Parse fails | Zod error naming the missing field |
| Stream-origin event | Envelope from a `claude -p` stream | `parent_tool_use_id` and `session_id` preserved verbatim | No error expected |
| Draft-7 export | Any registered contract id | JSON Schema whose `$schema` is draft-07 | No error expected |
| Subset violation | A step contract using `z.date()` or `minLength` | Subset guard test fails, naming contract id and field | Test failure, non-zero exit |
| Registered error code | Error `{ code, message, retryable, cause }` with a known code | Disposition resolves to exactly one of retry-with-backoff, escalate-model-tier, escalate-to-human, abandon-and-hand-off | No error expected |
| Unknown error code | Error whose `code` is absent from the table | Resolves to abandon-and-hand-off | Never retried; no throw |
| Artifact missing `schema_version` | Config or state object without it | Parse fails | Error naming the required field |
| Unrecognised `schema_version` | Artifact with a future version | Refused, stating which installer version wrote it | Explicit refusal, not a silent upgrade |
| Node below the floor | Package entry loaded on Node 20 | Fails fast naming the required version | Non-zero exit with the version in the message |
| Fixture divergence | Recorded `structured_output` disagreeing with its schema | Round-trip test fails naming the contract and field | Test failure, non-zero exit |

</intent-contract>

## Code Map

Greenfield: every path below is created by this story. Only `.gitignore` exists outside `docs/` and `.claude/`.

- `package.json` -- create; `engines.node` `>=22.22`, `engines.npm` `<12`, ESM (`"type": "module"`), scripts `build` / `test` / `lint` / `typecheck`
- `.nvmrc` -- create; the single other home of the Node floor (AD-28)
- `tsconfig.json` -- create; TypeScript 5.9.3, strict, emitting the package entry
- `vitest.config.ts`, `eslint.config.ts` -- create; Vitest 5.0.1 runner, typescript-eslint 8.70.0 so the repo can lint itself
- `src/contracts/event.ts` -- create; AD-5 envelope schema plus the declared event-type vocabulary as a const list, with unknown types accepted
- `src/contracts/command.ts` -- create; AD-3 `Command` enum, the single definition both renderers later build against
- `src/contracts/question.ts` -- create; AD-25 question contract and its `asked` / `resolved` / `deflected` states, plus resolver and principal fields
- `src/contracts/error.ts` -- create; AD-35 error shape and the disposition table beside it, with the unknown-code fallback
- `src/contracts/schema-version.ts` -- create; AD-28 `schema_version` field and the refusal helper
- `src/contracts/registry.ts` -- create; contract id → Zod schema map and the draft-7 export helper that AD-17 agent TOML references by id
- `src/contracts/step.ts` -- create; the typed step input/output envelope every step agent is a pure function over
- `src/contracts/node-floor.ts` -- create; AD-28 startup assertion, consumed later by the installer and engine
- `src/contracts/index.ts` -- create; barrel export and the package's public surface
- `tests/contracts.round-trip.test.ts` -- create; first of the three AD-31 suites
- `tests/contracts.subset-guard.test.ts` -- create; asserts the structured-outputs subset across every registered step contract
- `tests/fixtures/structured-output/<contract-id>.json` -- create; real `claude -p` outputs recorded once per step contract, committed as fixtures

Read-only evidence, authoritative and not to be edited by this story:

- `docs/planning-artifacts/architecture/architecture-agent-orcastrator-2026-09-19/ARCHITECTURE-SPINE.md` -- AD-2 (package and export), AD-3 (Command enum), AD-5 (envelope), AD-17 (registered contract ids), AD-25 (question), AD-28 (schema_version, Node floor), AD-31 (round-trip suite), AD-35 (error dispositions); plus the Consistency Conventions, Stack and Structural Seed tables
- `docs/specs/spec-agent-orchestrator/interface-contract.md` -- the steering controls the `Command` enum must cover
- `docs/specs/spec-agent-orchestrator/glossary.md` -- control plane, evidence plane, step agent definitions

## Tasks & Acceptance

**Execution:**
- `package.json`, `.nvmrc`, `tsconfig.json`, `vitest.config.ts`, `eslint.config.ts` -- create the single ESM TypeScript package at the pinned versions, declaring the Node floor in exactly two places -- every later story builds inside it
- `src/contracts/schema-version.ts` -- define the `schema_version` field and the refusal helper naming the writing installer version -- AD-28 gives config and state no forward-compatibility latitude
- `src/contracts/event.ts` -- define the eight-field envelope, the event vocabulary, and the stream-origin passthrough fields -- one shared shape is what keeps the timeline renderable and replayable
- `src/contracts/error.ts` -- define the error shape and the disposition table beside it, defaulting unknown codes to abandon-and-hand-off -- AD-35 forbids two units treating one failure differently
- `src/contracts/command.ts` -- define the `Command` enum covering every steering control named in `interface-contract.md` and CAP-5, CAP-15 and CAP-23: answer, confirm spec, edit criterion, approve, reject, continue, narrow, pause, inject note, kill, fork, take over, disengage, just-do-it -- a control in one renderer and absent from the other must be a compile error
- `src/contracts/question.ts` -- define the question contract, its single state machine, and its resolver and principal fields -- the three competing resolvers arrive in 1-8, 1-10 and 3-1
- `src/contracts/step.ts` -- define the typed step input/output envelope -- a step agent is a pure function over these two files
- `src/contracts/registry.ts` -- map contract id to Zod schema and expose the draft-7 export helper -- AD-17 agent TOML references a contract by id, never inlining a schema
- `src/contracts/node-floor.ts`, `src/contracts/index.ts` -- add the startup assertion and the public surface
- `tests/contracts.subset-guard.test.ts` -- assert every registered step contract avoids `z.date()`, recursion, `minLength`, `minItems` above one and `minimum` -- the subset is invisible until a spawn fails, so it must be a test
- `tests/fixtures/structured-output/<contract-id>.json`, `tests/contracts.round-trip.test.ts` -- record one real `claude -p` structured output per step contract and assert schema, draft-7 export and fixture agree -- this is the first of the three AD-31 suites required before any unattended run

**Acceptance Criteria:**
- Given a clean checkout on Node `>=22.22`, when `npm install && npm run typecheck && npm run lint && npm test` is run, then all four succeed with no error and the test run reports the round-trip and subset-guard suites passing.
- Given the package entry is loaded on a Node version below the declared floor, when it initialises, then it exits non-zero with a message naming the required version, and the floor it names matches both `.nvmrc` and `engines.node`.
- Given any contract id in the registry, when its draft-7 export is requested, then the returned JSON Schema declares the draft-07 dialect and no export path uses `z.toJSONSchema` with default arguments.
- Given a step contract is added that uses `z.date()` or `minLength`, when the test suite runs, then the subset guard fails and names the offending contract id and field.
- Given an error object whose `code` is absent from the disposition table, when its disposition is resolved, then the result is abandon-and-hand-off and no retry is attempted.
- Given an event envelope whose `type` is outside the declared vocabulary, when it is parsed, then it is accepted, and given an envelope missing a required field, then parsing fails naming that field.
- Given `src/contracts/`, when its imports are inspected, then it imports from no other `src/` directory.

## Spec Change Log

### Implementation, 2026-09-19 — five deviations from the Code Map, none to the intent contract

1. **`tsconfig.build.json` added beside `tsconfig.json`.** One tsconfig cannot both emit `src/` under
   `rootDir: src` and typecheck `tests/` and the two config files, which sit outside that root.
   `tsconfig.json` holds every compiler setting and is what `npm run typecheck`, ESLint and editors
   use; `tsconfig.build.json` is a six-line emit overlay that `npm run build` uses.

2. **The package entry is `dist/contracts/index.js`, not `dist/index.js`.** The Code Map places the
   barrel at `src/contracts/index.ts` and `rootDir` is `src`, so the emitted entry carries the
   `contracts/` segment; `package.json` `exports` points at it. Verification command 4 was run as
   `node -e "import('./dist/contracts/index.js')"`. Keeping `rootDir` at `src` is what lets stories
   1-2 onward add `src/engine/` and `src/runtime/` without moving every consumer's import path.

3. **Two test files added beyond the two AD-31 suites named in the Code Map.**
   `tests/contracts.behaviour.test.ts` asserts the I/O matrix rows (envelope forward compatibility,
   the unknown-error-code fallback, the `schema_version` gate, `Command` coverage, the question
   compare-and-set) and `tests/contracts.node-floor.test.ts` asserts that `.nvmrc` and
   `engines.node` declare the same floor and that the assertion names the required version. Five
   acceptance criteria are otherwise only checkable by hand.

4. **`ajv` added as a devDependency.** AD-31 requires the Zod schema, the draft-7 export *and* the
   recorded `structured_output` to agree. Validating the fixture against the export — rather than
   only against the Zod schema — needs a JSON Schema validator; without one the second leg is
   asserted by inspection. Test-only; nothing in `src/` imports it.

5. **`command.intent` registered as a contract.** The Code Map gives `command.ts` the `Command` enum
   alone, but AD-19 makes the durable intent file the only path into the reconciler and requires it
   to record a principal. Both renderers and the engine would otherwise each invent that shape.
   Independently raised as a question by the recorded `step.output` fixture, which recommended
   exactly this: fix `command`, `principal`, `source`, timestamp and `schema_version` now and keep
   the free-text argument open.

Two constraints resolved empirically against Zod 4.6.5 rather than assumed:

- `z.int()` exports `minimum` and `maximum` safe-integer bounds, which AD-2 places outside the
  structured-outputs subset. Step contracts therefore use `z.number()` with an integrality
  refinement; `z.int()` is used only in the event envelope, which is not a step contract.
- `z.date()` cannot be exported at all — `z.toJSONSchema` throws — so the subset guard treats a
  failed export as a violation, and separately flags the `format` keyword that `z.iso.datetime()`
  would produce. Timestamps are `z.string()` validated by refinement, which keeps `pattern` and
  `format` out of the export entirely.

Both fixtures under `tests/fixtures/structured-output/` were captured by real
`claude -p --json-schema --output-format json` invocations (CLI 2.1.278) against the committed
draft-7 exports, which also confirms the CLI accepts those exports. They carry different weight,
and the suite now distinguishes them: `step.output.json` is the recorded real `structured_output`
AD-31's third leg requires, because a model produces step outputs. `step.input.json` is a
schema-conformance sample only — the engine writes a step's input file, so no recorded model output
could stand as evidence about it. The registry marks which contracts are model-produced, so the
recorded-output requirement grows with the registry rather than with the subset guard.

### Verification correction, 2026-09-19 (parent, step-03 verify)

Verification command 4 named `./dist/index.js`, a path that does not exist and would have failed for
the wrong reason. Corrected to `./dist/contracts/index.js`, matching the Code Map's own barrel
location and implementation deviation 2 above. This was a defect in the spec as planned, not in the
implementation — recorded here rather than silently repointed.

## Review Triage Log

### 2026-09-19 — Review pass
- verdicts: 70 findings — high 0, medium 43, low 25, false 2, maybe-false 0
- layers: blind-hunter (20), edge-case-hunter (25), verification-gap (4 gap + 6 other), intent-alignment (15)
- findings:
  - `[medium]` `[patch]` BH1 refusal message calls an OLDER unknown schema_version 'newer' — verified at runtime: schema_version 0 yields 'written by an installer newer than 0.1.0'. Patched: direction branch added.
  - `[low]` `[reject]` BH2 NodeFloorError/SchemaVersionRefusal carry no error code — codes exist in the table but no unit consumes them yet in this story, so no bad outcome occurs here; smallest fix adds a public field. Noted as residual risk for story 1-3.
  - `[medium]` `[defer]` BH3 OrchError.retryable can contradict the disposition table — verified: {code:'budget.exhausted',retryable:true} parses while the table says abandon-and-hand-off. No consumer exists yet; enforcement belongs to the engine's structured_output re-parse.
  - `[medium]` `[patch]` BH4 importing the barrel can terminate the host process — real, but the spec's matrix requires the package entry to exit non-zero below the floor, so removing the assertion would contradict it. Patched only the over-broad catch.
  - `[medium]` `[patch]` BH5 assertNodeFloorOrExit converts unrelated faults into a version exit; top-level readFileSync — verified the catch wraps manifest reading. Patched: catch narrowed to NodeFloorError, manifest read wrapped with a named message.
  - `[low]` `[patch]` BH6 no-console override for node-floor.ts is inert — verified: zero console.* in that file, it uses process.stderr.write. Fix is a direct deletion, so not rejected. Patched.
  - `[medium]` `[defer]` BH7 no .describe() anywhere, so subset-stripped constraints never reach the model — verified 0 .describe() calls. Real improvement but the spec never required it and it adds model-facing surface across every contract.
  - `[medium]` `[patch]` BH8 numeric step-contract fields carry no validation — verified: steps_remaining -3.5 and rate_limit_budget_consumed 47 parse. Patched via refinements, which emit no JSON Schema keywords.
  - `[medium]` `[patch]` BH9 recommended_option_id never checked against the options it names — verified: a nonexistent id parses, and options:[] parses. Patched with cross-field refinements.
  - `[medium]` `[defer]` BH10 contract_id is an unvalidated string on both step contracts — verified 'totally-bogus' parses. A registry enum would cycle (registry imports step), so the check belongs to the engine that selects a schema.
  - `[low]` `[reject]` BH11 .nvmrc pinned to the floor forecloses newer dev Node — the equality is what AD-28's 'declared once' asks for and the test locks it deliberately; the fix is to change that spec decision, not the code.
  - `[medium]` `[defer]` BH12 engines.npm '<12' declared but never asserted — verified no npm check in src/. Asserting it is new startup behaviour the spec's Boundaries scope to the Node version only.
  - `[medium]` `[patch]` BH13 @types/node ^26 against a >=22.22 floor — verified from package.json. Node 24/26-only APIs would typecheck green and fail on the declared floor. Patched: pinned to ^22.
  - `[medium]` `[patch]` BH14 single-call-site guard is a non-recursive grep of one directory — cannot see a call added in src/engine/ by a later story, a split call, or double quotes. Patched: recursive scan, quote-agnostic.
  - `[medium]` `[patch]` BH15 subset guard confuses keywords with property names; $defs rule inert — verified step.output export has no $ref/$defs only because Zod 4.6.5 inlines. Patched reused:'inline'; the property-name false positive rejected as improbable and costly to fix.
  - `[medium]` `[defer]` BH16 no CI workflow; no step.completed/failed event type — verified: no .github/workflows, EVENT_TYPES has step.started only. The intent never asked for CI, and AD-5 makes adding event types non-breaking later.
  - `[low]` `[reject]` BH17 spec frontmatter says in-review while the prior-pass block says in-progress — correct, but it is spec bookkeeping I introduced when marking the planning pass superseded; fixed at finalize, not a code finding.
  - `[low]` `[reject]` BH18 Review Triage Log is an empty heading — moot: this pass populates it.
  - `[low]` `[reject]` BH19 package-lock.json committed but absent from the Code Map — fix is to edit this build's spec.
  - `[low]` `[reject]` BH20 Command enum test compares against a hand-copied literal list — tautology is real, but deriving the list from interface-contract.md prose is not mechanizable; fix adds complexity for negligible gain.
  - `[medium]` `[patch]` EC1 dispositionFor returns a prototype member for keys like 'constructor' — VERIFIED: dispositionFor('constructor') returns the Object function, isErrorCode('constructor') is true, breaking AD-35's four-disposition guarantee. Patched with hasOwnProperty.call.
  - `[low]` `[reject]` EC2 renderCause loses cross-realm Error text — improbable in a single-process local tool; fix adds a branch.
  - `[low]` `[reject]` EC3 formatTimestamp on an Invalid Date — fix adds a guard for a state never shown reachable; the format-drift risk is covered by the VG4 patch.
  - `[low]` `[defer]` EC4 compareEventOrder ties and negative seq — seq assignment is explicitly story 1-2's per the intent's Never list; ordering semantics belong with the recorder.
  - `[medium]` `[patch]` EC5 getContract returns a prototype function instead of the named refusal — VERIFIED: isContractId('toString') is true; exportContract then throws an opaque TypeError about '_idmap'. Same root cause as EC1; patched together.
  - `[low]` `[reject]` EC6 versioned() shape may redeclare schema_version — requires a developer to deliberately redeclare the field; fix adds a branch.
  - `[medium]` `[patch]` EC7 refusal wording wrong for versions below the supported range — same defect as BH1, verified at runtime. Patched.
  - `[medium]` `[patch]` EC8 duplicate/absent option ids in a question draft — verified. Patched with the QuestionDraftSchema refinement.
  - `[medium]` `[patch]` EC9 default_window_ms zero or negative fires the timeout immediately — verified unbounded. Folded into the numeric-refinement patch.
  - `[medium]` `[patch]` EC10 status resolved with resolution null passes — verified no cross-field check; writesToDecisionLedger would return true for a null resolution. Patched.
  - `[medium]` `[patch]` EC11 resolution.option_id may name an option never offered — verified. Patched: resolveQuestion refuses it.
  - `[low]` `[reject]` EC12 no eventTypeForDeflection helper — question.deflected is already in the vocabulary and reachable; a helper adds surface for no verified harm.
  - `[medium]` `[defer]` EC13 step output status and error can disagree — the finding itself places the check engine-side; no consumer exists yet.
  - `[medium]` `[patch]` EC14 budget fields accept impossible values — verified; same patch as BH8.
  - `[medium]` `[defer]` EC15 argument null for commands that require text — command.intent is consumed by the reconciler (story 1-7), which is where the requirement lives.
  - `[medium]` `[defer]` EC16 source 'timeout' paired with principal kind 'user' — attributability is enforced where intents are accepted, i.e. the reconciler; same deferral as EC15.
  - `[medium]` `[patch]` EC17 unreadable or invalid package.json throws an opaque error at import — verified the read is top-level. Patched with a named message.
  - `[low]` `[patch]` EC18 parseVersion rejects legal .nvmrc forms 22, 22.22, lts/* — VERIFIED all three throw 'Could not read a semantic version' without naming .nvmrc. Fix is a direct correction, so not rejected. Patched.
  - `[medium]` `[patch]` EC19 library import kills the host process below the floor — the exit itself is required by the spec's matrix row; patched the over-broad catch only, as with BH4.
  - `[medium]` `[patch]` EC20 non-NodeFloorError throwables exit 1 as if Node were too old — verified; patched by narrowing the catch.
  - `[low]` `[reject]` EC21 siblings evaluate before the assertion; deep imports skip it — the matrix row fixes behaviour at the package entry, which is satisfied; relocating the side effect is hardening the spec did not ask for.
  - `[medium]` `[patch]` EC22 guard misses z.record, z.unknown, .optional(), pattern, maxLength — overlaps VG2, which demonstrated an optional property surviving 78/78. Patched with required-completeness and additionalProperties checks.
  - `[false]` `[reject]` EC23 guard only walks kind 'step' — the spec scopes the subset rule to step contracts explicitly, and all step exports verified clean; walking other kinds would flag event.envelope for a rule that does not bind it.
  - `[medium]` `[patch]` EC24 'code in ERROR_DISPOSITIONS' true for inherited keys — VERIFIED independently. Same entry as EC1.
  - `[low]` `[reject]` EC25 z.date() violation reports field '(root)' not the field name — the export throws before any field is knowable, so naming it would require walking the Zod tree; disproportionate.
  - `[medium]` `[patch]` VG1 question.state losing schema_version ships past typecheck, lint and all 78 tests — pre-verified: the layer injected the regression and observed 78/78 green. Patched with it.each(contractIdsOfKind('artifact')).
  - `[medium]` `[patch]` VG2 subset guard never checks required/additionalProperties — pre-verified: making StepOutputSchema.summary optional left 78/78 green. Patched with both checks plus non-vacuous offender rows.
  - `[medium]` `[patch]` VG3 the floor failure branch (stderr + exit 1) is verified only by hand — pre-verified: replacing the branch with process.exit(0) left 78/78 green. Patched with a spawned-process assertion on exit code and stderr.
  - `[medium]` `[patch]` VG4 formatTimestamp output never checked against TimestampSchema — pre-verified: second-precision formatting left 78/78 green while emitting a string the schema rejects. Patched.
  - `[low]` `[reject]` VGO1 the two error classes do not produce their declared codes — same as BH2; rejected on the same reasoning.
  - `[medium]` `[patch]` VGO2 barrel import has two unconditional side effects — same entry as BH4/BH5; patched.
  - `[low]` `[patch]` VGO3 eslint override is inert config — same entry as BH6; patched by deletion.
  - `[low]` `[patch]` VGO4 parseVersion throws an unnamed error on a legal .nvmrc — same entry as EC18; patched.
  - `[medium]` `[patch]` VGO5 step.input cannot be the 'recorded real structured_output' the suite claims — verified: step.input is engine-written and no model produces it, yet kind 'step' demands a fixture. Patched: requirement narrowed to model-produced contracts and the provenance claim corrected.
  - `[low]` `[patch]` VGO6 isResumable, renderCause, compareEventOrder have no test and no consumer — verified 0 non-definition references each. Patched with one assertion apiece.
  - `[false]` `[reject]` IA1 subset rule scoped by an invented kind taxonomy; event.envelope emits minimum — verified event.envelope exports minimum/maximum, but the spec's Boundaries scope the subset rule to step contracts, and all four step exports are clean, so no stated rule is broken.
  - `[medium]` `[patch]` IA2 the registry-level 'names the contract and field' leg is never exercised — the assertion only ever sees an empty string; naming is proven only against literals the test supplies. Folded into the VG2 offender-row patch.
  - `[low]` `[defer]` IA3 findSubsetViolations lives in the test file, unusable by later stories — moving it into src/ adds package surface the spec did not ask for; recorded so story 2-4 can reuse rather than re-run.
  - `[low]` `[reject]` IA4 exclusiveMinimum and $defs are stricter than the intent's list — stricter is safe here and rules nothing out that the step contracts need; the $defs inertness is handled by the reused:'inline' patch.
  - `[medium]` `[patch]` IA5 the floor's expectation is at the process surface; every test is at the function surface — same as VG3; patched.
  - `[low]` `[reject]` IA6 parseNodeFloor rejects compound ranges like '>=22.22 <25' — no compound range is declared anywhere; hardening beyond the spec.
  - `[low]` `[reject]` IA7 .nvmrc declares 22.22.0 while the toolchain verified on is 24.21.0 — same as BH11: a spec-level decision, not a code defect.
  - `[medium]` `[patch]` IA8 fixture provenance is unfalsifiable from the diff and step.input's is impossible — the strongest form of this is VGO5, which is patched; the unfalsifiable half is recorded as a residual risk.
  - `[medium]` `[patch]` IA9 the refusal names the reader and asserts the writer is unknown — verified: the writer branch is unreachable because the only mapped version is the only supported one. Same entry as BH1.
  - `[medium]` `[defer]` IA10 the schema_version gate is bypassable by calling .parse() directly — VERIFIED: CommandIntentSchema.parse({schema_version:99}) succeeds; only parseVersionedArtifact refuses. The enforcement point is each consumer, which does not exist yet.
  - `[medium]` `[defer]` IA11 scope expanded well past the intent, and the expansion has no test surface — verified the untested vocabulary; partially addressed by VGO6. Recorded because later stories must accept or amend this vocabulary.
  - `[medium]` `[patch]` IA12a two acceptance criteria enforced lexically rather than structurally — same as BH14; patched with a recursive quote-agnostic scan.
  - `[low]` `[reject]` IA12b past-tense half of the event-name rule is unasserted — past tense is not mechanically checkable; the dot-namespace half is asserted.
  - `[low]` `[defer]` IA12c event types and error codes share one dot-namespaced space — permission.denied, redaction.failed and budget.exhausted appear in both; distinguishing them is a design decision for the recorder story.
  - `[medium]` `[patch]` IA12d eslint, ajv, jiti and @types/node float while the Stack pins are exact — the load-bearing half is @types/node against the floor; patched. The rest is noted, since the spec pins typescript-eslint but never eslint itself.

## Design Notes

Two things are easy to get wrong and expensive to find later, so both are pinned as tests rather than prose.

First, the draft-7 argument. Zod 4's `z.toJSONSchema` defaults to draft-2020-12, which `claude -p --json-schema` rejects at spawn time — a failure that surfaces in story 1-4 as an opaque spawn error, far from its cause. The export helper is the only place `toJSONSchema` is called, so the argument cannot be forgotten at a call site:

```ts
export const toJsonSchema = (s: z.ZodType) =>
  z.toJSONSchema(s, { target: "draft-7" });
```

Second, the AD-31 fixture leg. The suite asserts three things agree — the Zod schema, its draft-7 export, and *a recorded real* `structured_output`. The third cannot be synthesised, so each fixture is captured once by a real `claude -p` invocation against that contract's exported schema and committed. The suite fails when a registered step contract has no fixture, which keeps the guarantee honest as contracts are added in stories 2-4 through 2-7.

## Verification

**Toolchain:** the PATH default `node` on this machine is v22.14.0, which is **below** the declared floor and
will fail in the opaque way AD-28 warns about. Use the nvm-installed Node 24.x LTS by absolute path for every
command below, mirroring AD-28's own rule that the resolved absolute path is passed to children rather than
relying on `PATH`:

```
export ORCH_NODE_BIN=/Users/deep/.nvm/versions/node/v24.21.0/bin   # node v24.21.0, npm 11.19.0
export PATH="$ORCH_NODE_BIN:$PATH"
```

**Commands:**
- `npm run typecheck` -- expected: exit 0, no type errors
- `npm run lint` -- expected: exit 0; typescript-eslint resolves and lints the repository's own sources
- `npm test` -- expected: exit 0; round-trip and subset-guard suites both present and passing
- `node -e "import('./dist/contracts/index.js')"` on a Node below the floor -- expected: non-zero exit, message naming the required version. The `contracts/` segment is correct: the barrel is `src/contracts/index.ts` and `rootDir` is `src`. Verified: Node 22.14.0 exits 1 with the named floor; Node 24.21.0 exits 0.

## Auto Run Result

### Pass 1 — planning (superseded by pass 2 below)

Status: ready-for-dev
Blocking condition: none

Planning completed and the spec passed the Ready-for-Development gate: 11 tasks each naming a file path
and an action in dependency order, 7 acceptance criteria all in Given/When/Then form and anchored on the
package's outermost surfaces, no placeholders, and no unresolved intent gap. Halted after planning at the
caller's direction, honouring `spec_checkpoint: true` on this story. Implementation has not started; no
source file has been created.

Carried warning: `oversized`. The spec runs roughly 2800-3400 tokens against the template's 1600 target,
because the story creates 16 files and its I/O matrix carries 12 scenarios. A trimming pass removed
redundant task rationales; cutting further would have removed Code Map paths or matrix rows that the
implementer needs.

One planning decision worth the reviewer's attention: AD-31 requires the round-trip suite to assert that a
schema, its draft-7 export, and *a recorded real* `structured_output` agree, but the `claude -p` spawner
does not exist until story 1-4. Rather than defer that third leg, the spec has each fixture captured once
by a real `claude -p` invocation against the exported schema and committed under
`tests/fixtures/structured-output/`, with the suite failing when a registered step contract has no fixture.

That halt was resumed: the story was re-dispatched, implemented and reviewed. See pass 2.

### Pass 2 — implementation and review

Status: done
Blocking condition: none

**Implemented change.** The single TypeScript package and its `src/contracts/` layer: nine modules defining
every shared type once as a Zod v4 schema, a contract registry keyed by the id AD-17 agent TOML references,
and a single draft-7 export helper. Four test files (107 tests) enforce the invariants, including the first of
AD-31's three required suites. `src/contracts/` is the root of the dependency graph and a test asserts it
imports nothing but `zod` and `node:` builtins.

**Files changed** (24 files, 5362 insertions, no deletions, from baseline `ddd9bed4d286ac1f8a0f4f7bfef9530046605787`):

- `package.json`, `package-lock.json`, `.nvmrc`, `tsconfig.json`, `tsconfig.build.json`, `vitest.config.ts`,
  `eslint.config.ts`, `.gitignore` — the package at the spine's pinned versions, Node floor declared in exactly
  two places, `node_modules/` and `dist/` ignored
- `src/contracts/event.ts` — AD-5 eight-field envelope, open `type`, 13-type vocabulary, stream-origin passthrough
- `src/contracts/command.ts` — AD-3 `Command` enum (14 controls), total `CommandMap`, AD-19 intent shape
- `src/contracts/question.ts` — AD-25 question contract, three resolvers, pure compare-and-set transition
- `src/contracts/error.ts` — AD-35 error shape and 35-code disposition table with the unknown-code fallback
- `src/contracts/schema-version.ts` — AD-28 `schema_version`, `versioned()`, refusal with installer provenance
- `src/contracts/step.ts` — the typed step input/output envelope, subset-clean
- `src/contracts/registry.ts` — the registry and the only `z.toJSONSchema` call site
- `src/contracts/node-floor.ts` — AD-28 floor read from the manifest, assertion and exiting entry variant
- `src/contracts/index.ts` — barrel; asserts the floor on import
- `tests/contracts.{round-trip,subset-guard,behaviour,node-floor}.test.ts` and two fixtures

**Review findings.** Four layers reported 70 findings: high 0, medium 43, low 25, false 2, maybe-false 0.
Routed to 15 patch entries (13 medium, 2 low), 14 deferrals, and rejections recorded row by row in the Review
Triage Log above. Nothing routed to `bad_spec` or `intent_gap`: every real defect had a small local fix, so
re-deriving the code was not warranted.

Patches applied, all re-verified by the parent against the diff rather than the implementer's report:

- Prototype-chain leakage in `isErrorCode` and `isContractId` — `in` walks the prototype chain, so
  `dispositionFor('constructor')` returned the `Object` function and `getContract('toString')` returned a
  prototype member instead of the AD-17 refusal. Now `hasOwnProperty.call`; verified all five prototype keys
  resolve to `abandon-and-hand-off` and `exportContract('toString')` throws the named refusal.
- Refusal direction — `schema_version 0` was described as written by a *newer* installer. Now branches on
  `> CURRENT_SCHEMA_VERSION`; verified both directions.
- `assertNodeFloorOrExit` no longer disguises a malformed manifest as a stale Node; the manifest read and
  `.nvmrc` parse name the file they failed on; `parseVersion` accepts `22` and `22.22`.
- Subset guard extended to `required`-completeness and open `additionalProperties`. **Verified non-vacuous by
  parent mutation:** making `StepOutputSchema.summary` optional now fails with
  `step.output at properties.summary: required — …`, and a `z.record` sub-object fails with
  `properties.leak: additionalProperties — …`. Both mutations reverted byte-identically.
- Floor-failure branch now covered by a spawned-process assertion. **Verified non-vacuous:** replacing it with
  `process.exit(0)` and no stderr write fails the suite.
- Artifact `schema_version` coverage grows with the registry via `it.each(contractIdsOfKind('artifact'))`;
  `formatTimestamp` is now asserted against `TimestampSchema`.
- Budget and question cross-field refinements — verified that negative `steps_remaining`,
  `rate_limit_budget_consumed: 47`, a `recommended_option_id` naming no option, duplicate ids and empty
  `options` are all now rejected, while the step exports stay subset-clean.
- `@types/node` pinned to `^22` (`^22.20.4`, the latest 22.x); inert `no-console` override deleted;
  `reused: 'inline'` made explicit; single-call-site guard now scans `src/**` recursively and quote-agnostically;
  the recorded-real-output requirement narrowed to model-produced contracts, with `step.input.json` retained as
  a schema-conformance fixture under an accurate description.

Patched entry counts by verdict: medium 13, low 2, high 0.

**Follow-up review recommended: true.** First pass, 13 medium entries patched. The specific unverified risk:
*the narrowed catch in `assertNodeFloorOrExit` has no test that can detect its removal.* Deleting the rethrow
leaves 107/107 green, because a propagated error and a handled one both put "semantic version" on stderr and
exit non-zero. The behaviour is correct as written; nothing would catch a regression. Recorded as a deferred
item, and it is the one thing a follow-up pass should close first.

**Verification performed** (Node v24.21.0 by absolute path; the machine's PATH default is v22.14.0, below the
floor):

- `npm run typecheck` → exit 0; `npm run lint` → exit 0; `npm run build` → exit 0; `npm test` → 4 files,
  107 passed, none skipped
- Below-floor entry: Node 22.14.0 loading `dist/contracts/index.js` → exit 1, message naming 22.22.0, `.nvmrc`
  and `engines.node`; Node 24.21.0 → exit 0
- Matrix audit: all 12 I/O rows map to named tests that ran and passed
- Four parent-run mutations: three caught, one (the rethrow) not — recorded above

**Residual risks.**

- Fixture provenance is not observable from a diff. `step.output.json` is claimed as a real `claude -p`
  capture; a committed JSON file is indistinguishable either way, so AD-31's third leg rests on that claim
  rather than on evidence this run could check.
- `event.envelope` exports `minimum`/`maximum` (from `seq: z.int()`) and an open `payload`. Not a violation —
  the Boundaries scope the subset rule to step contracts, and all step exports are verified clean — but a
  future story that hands the envelope to a model would break the subset silently.
- The story committed a domain vocabulary well beyond what the intent named, and that expansion is the part
  with the least test coverage. Deferred for the stories that must accept or amend it.
- `engines.npm: "<12"` is declared and never asserted, so npm 12 would install silently and break the AD-12
  delivery path.
