---
title: 'Stage-1 defect sweep — bound the retry loop, close the bypasses'
type: 'feature'
created: '2026-09-20'
status: 'drafted'
review_loop_iteration: 0
followup_review_recommended: false
baseline_revision: 'db11e4b'
context:
  - '{project-root}/docs/planning-artifacts/architecture/architecture-agent-orcastrator-2026-09-19/ARCHITECTURE-SPINE.md'
  - '{project-root}/docs/specs/spec-agent-orchestrator/stories/1-3-engine-reconciler.md'
  - '{project-root}/docs/specs/spec-agent-orchestrator/stories/1-7-command-transport.md'
  - '{project-root}/docs/specs/spec-agent-orchestrator/stories/1-8-question-lifecycle.md'
warnings: ['oversized'] # eight independent defects across contracts, runtime, engine and the build
deferred: []
---

# Story 1-12 — Stage-1 defect sweep

## Intent

Eight defects that stage 1 recorded and deferred. None is a missing feature; each is a way the built code
can do something its own contract forbids. They are grouped into one story because they are all small, all
verified present, and all cheaper to fix before stage 2's roster and ceilings are built on top of them.

Each was confirmed against the code at `db11e4b` rather than taken from the deferred entry's word.

## Boundaries & Constraints

**The retry bound is a bound, not a ceiling.** Story 2-9 owns budget degradation, hibernation and the
eighty-percent threshold. This story owns only a hard attempt count per step, because the current behaviour
is a step whose disposition is `retry-with-backoff` re-running forever, and an unbounded loop spends the
subscription budget until a person notices. 1-7 recorded the related half: the declared failure limit counts
only the `failed` disposition, so the resume path is still unbounded. One bound must cover every disposition
that returns to the same step, not one of them.

**A tightened schema is a breaking change to fixtures, and that is expected.** Requiring a non-empty
`argument` for the commands that are meaningless without text, and refusing `source: 'timeout'` paired with
`principal.kind: 'user'`, will invalidate existing test fixtures that were legal before. Updating a fixture
to satisfy a stricter contract is correct. Deleting or skipping a test to avoid the failure is not, and the
difference must be visible: every fixture changed is reported, with the reason.

**The atomic-create idiom already exists in this codebase; use it rather than inventing one.** The
`'wx'`-then-write window is that a file is created empty and populated afterwards, so a concurrent reader can
observe a claim that is present but blank. Story 1-8 solved exactly this for the question outcome: write a
temp file in the same directory, `fsync`, then `link()` it into place, treating `EEXIST` as having lost the
race. Both the recorder's writer claim and the engine lock get that shape. This is a fail-safe defect being
made correct, not a live corruption — say so honestly and do not oversell the fix.

**A validation that can be bypassed by calling `.parse()` is not a validation.** Two of the eight are this
shape: `schema_version` is recognised by a helper the caller may skip, and `retryable` is a free `z.boolean()`
on the wire while `orchError()` derives it correctly from the AD-35 table. In both cases the check belongs
inside the schema, so there is no path that reaches a parsed value without it.

**Not in this story.** No ceilings, degradation or hibernation (2-9). No change to what AD-21 redaction
does. No new event types. No new surface. No change to the disposition table's contents — only to how many
times a disposition that returns to a step may do so.

## I/O & Edge-Case Matrix

| # | Input | Expected |
|---|---|---|
| 1 | A step that keeps returning `retry-with-backoff` | It stops at the attempt bound and the feature reaches a terminal state rather than looping |
| 2 | A step that keeps being `interrupted` and resumed | The same bound applies; the resume path is not a way around it |
| 3 | A step that succeeds on its last permitted attempt | It succeeds; the bound is not off by one |
| 4 | Attempt counts, after a crash and rebuild | The count is reconstructed from the log, so a restart is not a way to reset it |
| 5 | Two processes racing to claim the event-log writer | Exactly one wins; the loser sees a fully-written claim, never a present-but-empty one |
| 6 | Two processes racing for the engine lock | Same, and the winner's identity is readable by the loser |
| 7 | A versioned artifact with an unrecognised `schema_version`, parsed with a bare `.parse()` | Refused, with `config.schema_version_unrecognised` |
| 8 | The same artifact, parsed through every other entry point | Refused identically; there is one behaviour, not two |
| 9 | An error whose `retryable` contradicts the AD-35 table for its code | Refused; the table is authoritative and the field cannot disagree |
| 10 | An `answer`, `reject`, `edit_criterion`, `narrow` or `inject_note` intent with `argument: null` | Refused as unanswerable rather than accepted and silently doing nothing |
| 11 | A `pause` or `disengage` intent with `argument: null` | Accepted — those commands are meaningful without text |
| 12 | An intent pairing `source: 'timeout'` with `principal.kind: 'user'` | Refused; a clock's default is never attributed to a person |
| 13 | An intent pairing `source: 'timeout'` with `principal.kind: 'timeout'` | Accepted |
| 14 | npm 12 installed | The install or startup refuses, naming the `engines.npm` bound rather than failing later and obscurely |
| 15 | A push, and a pull request | CI runs typecheck, lint, build and the full suite on the pinned Node, and fails the job on any one of them |

## Code Map

| File | Change | Why |
|---|---|---|
| `src/engine/dispositions.ts` | modify | A hard attempt bound covering every disposition that returns to the same step, not only `failed`. |
| `src/engine/reconciler.ts` | modify | Count attempts per step from the log and enforce the bound; reach a terminal state at it. |
| `src/engine/rebuild.ts` | modify | Reconstruct the attempt count, so a restart cannot reset it. |
| `src/runtime/recorder.ts` | modify | Replace the `'wx'`-then-write writer claim with the temp-file-`fsync`-`link` idiom story 1-8 established. |
| `src/engine/lock.ts` | modify | Same change, same reason. |
| `src/contracts/schema-version.ts` | modify | Move the recognition check inside `schemaVersionField`, so no `.parse()` path skips it. |
| `src/contracts/error.ts` | modify | Refine so `retryable` must equal what the AD-35 table says for its code. |
| `src/contracts/command.ts` | modify | Refine: a non-empty `argument` for the commands that require text; refuse `source: 'timeout'` with a `user` principal. |
| `src/contracts/node-floor.ts` | modify | Assert the `engines.npm` bound alongside the Node floor, from `package.json` rather than a second literal. |
| `.github/workflows/ci.yml` | new | The four-command gate, on the pinned Node, on push and pull request. |
| `tests/engine.retry-bound.test.ts` | new | Matrix 1, 2, 3, 4. |
| `tests/runtime.writer-claim.test.ts` | new | Matrix 5, 6 — cross-process, because the guarantee is cross-process. |
| `tests/contracts.schema-version.test.ts` | modify | Matrix 7, 8. |
| `tests/contracts.error.test.ts` | modify | Matrix 9. |
| `tests/contracts.command.test.ts` | modify | Matrix 10, 11, 12, 13. |
| `tests/contracts.node-floor.test.ts` | modify | Matrix 14. |

## Tasks & Acceptance

1. **Bound the retry loop.** One attempt bound covering every disposition that returns to the same step.
   - **Given** a step that always returns `retry-with-backoff`, **when** the reconciler runs to quiescence,
     **then** the step stops at the bound and the feature holds a terminal state.
   - **Given** a step that is always `interrupted` and resumed, **when** the reconciler runs to quiescence,
     **then** the same bound stops it, so the resume path is not a way around it.
   - **Given** a step that succeeds on its last permitted attempt, **when** it runs, **then** it succeeds.
   - **Given** a crash after several attempts, **when** the state is rebuilt from the log, **then** the
     attempt count is preserved and a restart does not reset it.

2. **Close the torn-read window** in the recorder's writer claim and the engine lock, using story 1-8's
   temp-file-`fsync`-`link` idiom.
   - **Given** two OS processes racing to claim, **when** both attempt it, **then** exactly one wins and the
     loser reads a fully-written claim, never a present-but-empty file.
   - **Given** the winner holds the claim, **when** the loser reads it, **then** the winner's identity is
     readable, so the refusal can name who holds it.

3. **Make the `schema_version` gate unbypassable.**
   - **Given** an artifact whose `schema_version` this build does not recognise, **when** it is parsed with a
     bare `.parse()`, **then** the parse fails and the failure carries
     `config.schema_version_unrecognised`.
   - **Given** the same artifact, **when** it is parsed through any other entry point, **then** the
     behaviour is identical.

4. **Make `retryable` unable to contradict the AD-35 table.**
   - **Given** an error payload whose `retryable` disagrees with the table for its code, **when** it is
     parsed, **then** it is refused rather than accepted.
   - **Given** an error built by `orchError()`, **when** it is parsed, **then** it is accepted unchanged.

5. **Refine the command intent** on both the argument and the principal.
   - **Given** an `answer`, `reject`, `edit_criterion`, `narrow` or `inject_note` intent with a null or empty
     `argument`, **when** it is parsed, **then** it is refused.
   - **Given** a `pause` or `disengage` intent with a null `argument`, **when** it is parsed, **then** it is
     accepted.
   - **Given** an intent pairing `source: 'timeout'` with `principal.kind: 'user'`, **when** it is parsed,
     **then** it is refused; paired with `principal.kind: 'timeout'` it is accepted.

6. **Assert the npm bound** from `package.json`, not from a second literal.
   - **Given** an npm version outside `engines.npm`, **when** the floor is asserted, **then** it refuses and
     names the bound.
   - **Given** the bound is declared in exactly one place, **when** `grep -rn "'<12'" src/` runs, **then** it
     returns no match.

7. **Add CI.** `.github/workflows/ci.yml` running typecheck, lint, build and the full suite on the pinned
   Node, on push and pull request.
   - **Given** any one of the four commands fails, **when** the workflow runs, **then** the job fails.
   - **Given** the workflow's Node version, **when** it is compared to the spine's Stack table, **then**
     they agree.

## Spec Change Log

## Review Triage Log

## Design Notes

## Verification

## Auto Run Result
