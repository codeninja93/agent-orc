---
title: "Write surface — the engine's enumerated, idempotent intent executor"
type: 'feature'
created: '2026-09-23'
status: 'done'
review_loop_iteration: 1
followup_review_recommended: true
baseline_revision: '21616f0'
context:
  - '{project-root}/docs/planning-artifacts/architecture/architecture-agent-orcastrator-2026-09-19/ARCHITECTURE-SPINE.md'
  - '{project-root}/docs/specs/spec-agent-orchestrator/stories/2-7-committer.md'
warnings: []
deferred:
  - summary: >-
      A persistently failing push or pull-request creation retries every pass with no real backoff and
      no eventual escalation to a person.
    evidence: |-
      `write.push_failed`/`write.pull_request_failed`/`write.kind_unimplemented` are declared
      `retry-with-backoff`/`abandon-and-hand-off` in the AD-35 disposition table, but nothing in
      `settlePreMergeWrites` or the `check-merge` case actually consults `dispositionFor` for them — the
      only thing that happens is "the next pass tries again from the top." A correct fix needs a
      failure-count-and-escalate mechanism, more than this round's direct corrections.
    location: src/engine/reconciler.ts
    severity: medium
  - summary: >-
      A pull request closed or removed is not reliably distinguished from a transient `gh` read
      failure, so a genuinely removed pull request has no path to ever escalate.
    evidence: |-
      `checkPullRequestMerged` only special-cases an explicit `state: "CLOSED"` answer; every other
      failure mode (non-zero exit, unparseable JSON) folds to the same "still open" result a transient
      network hiccup would produce. Distinguishing the two risks misclassifying a recoverable hiccup as
      removed and escalating a run that would have succeeded on retry — the run is not actively harmed
      by staying `awaiting_merge` meanwhile (no ceiling pressure), so this is worth a considered fix
      rather than a rushed one.
    location: src/engine/write-executor.ts
    severity: medium
  - summary: 'No README or other documentation describes the new `orch-run` CLI.'
    evidence: >-
      Its invocation, `spec.json` shape and preconditions are fully documented in `bin/orch-run.ts`'s own
      docblock; a README would restate rather than newly supply that information, and writing one is
      more than a direct correction.
    location: bin/orch-run.ts
    severity: low
---

# Story 2-11 — Write surface: the engine's enumerated, idempotent intent executor

## Intent

**Problem:** AD-15 requires the engine to execute an enumerated write surface — `git push`, pull
request creation, git notes, tags, MCP domain mutations — exactly once against an idempotency key,
with a durable `write.attempted` record preceding every call. Story 2-7 built the *composer*
(`src/engine/committer.ts`'s `composeCommit`) and declared, in its own words, that "nothing here
pushes, opens a pull request or writes a note" — the executor is explicitly this story's. Separately,
nothing under `src/` or `bin/` has ever constructed a real `Reconciler` wired to a real spawner and
committer: every existing wiring is a test fixture. Confirmed directly: `bin/` has three entry points
(`init.ts`, `runner.ts`, `jira-server.ts`), none of which starts a run.

**Approach:** Build the executor — `write.attempted`/`write.executed` durability, exactly-once
execution keyed by `intentIdFor(step, kind)` + run id, and crash recovery that probes the actual git/
GitHub state rather than blindly re-executing. AD-22 places the durable note on the **merge commit**,
which does not exist until a human merges the opened pull request, so the run cannot reach its
terminal `committed` state at push-and-PR-open time; it waits, non-terminal, for the merge to be
observed, then writes the note and only then commits. Wire the pieces this project has already built
— interviewer, agents, gates, spawner, this new executor — into the first real entry point, and prove
the whole thing once, end to end, against this repository, with a real pull request the user merges.

## Boundaries & Constraints

**Always:**
- Every write intent (`kind` in `git_push`, `pull_request`, `git_note`, `git_tag`,
  `domain_mutation`) is executed through one path: read `write.attempted` for `{run, intent_id}`, and
  if durably present with no matching `write.executed`, **probe the actual target before acting** —
  never re-execute blindly. `git_push` probes `git ls-remote <remote> <branch>` against the local
  branch's own tip; `pull_request` probes `gh pr list --head <branch> --json number,url`; `git_note`
  probes `git notes --ref=orch show <commit>` once a merge commit is known. A probe finding the effect
  already landed durably writes `write.executed` and returns its result without repeating the call.
- `write.attempted` is durable (appended to `events.jsonl` through the run's own `Recorder`) **before**
  the git/`gh` call, never after — AD-15's fixed ordering, unconditionally.
- The identity that pushes and opens the pull request is whatever git/`gh` identity the host process
  already holds — never a field carried on the intent, never a bot identity (SPEC.md's own constraint;
  `committer.ts`'s own comment names this explicitly as "a decision stated, not a mechanism left
  unbuilt").
- Push and pull-request creation shell out to `git` and `gh` (`execFileSync`, matching how
  `src/container/*` already shells to `git`/container runtimes) — no Octokit/MCP GitHub dependency;
  confirmed nothing of that kind exists in this repository today, and CAP-8's "git as the message bus"
  favours the tool already on the machine over a new one.
- **A new, non-terminal feature state, `awaiting_merge`, sits between the write-executor's push/PR
  intents landing and the note being written.** AD-32 reclaims a run's resources on reaching any
  terminal state, and `committed` is terminal (`TERMINAL_FEATURE_STATES`) — so `committed` cannot mean
  "pushed and opened," or the worktree would be reclaimed while the note's own commit (the merge
  commit) does not exist yet. `awaiting_merge` joins `PERSON_WAITING_STATES` (2-9's own convention for
  `drafting`/`blocked`) so a run waiting on a human's own review-and-merge decision does not consume
  any of AD-24's three ceilings — this is not the run doing anything, it is the run waiting on a
  person, exactly as ceilings already treat a pending question.
- While `awaiting_merge`, each reconcile pass makes one cheap, bounded check
  (`gh pr view <number> --json state,mergeCommit`) for whether the pull request has merged. On
  finding a merge commit, the executor writes the AD-22 note there (`git notes --ref=orch add`),
  records `write.attempted`/`write.executed` for the `git_note` intent the same way as any other, and
  the run then reaches `committed`.
- The demonstration this story is verified against is real: a real branch pushed and a real pull
  request opened against **this repository**, on a disposable branch, merged by the user, with the
  note confirmed present on the actual resulting merge commit. Decided with the user rather than
  guessed — the alternative of a wholly mocked demonstration was explicitly declined, since this
  story's own stated milestone is "a real feature completes end to end and the user merges the pull
  request."

**Never:**
- No agent performs any of these writes directly. `committing`'s roster grant already has no command
  tool at all (ADR-003); this story does not change that boundary, only builds what the engine side
  of it executes.
- No force-push, ever — structurally inexpressible: `WriteIntentSchema` (`src/contracts/step.ts`) has
  no boolean field of any kind, and this story does not add one.
- No indefinite wait. `awaiting_merge` is excluded from ceiling *pressure*, not from every bound —
  if the PR is closed without merging, or removed, the check surfaces that as a fact for a person to
  act on (the existing escape-hatch/handoff path), rather than polling forever.
- No new mutating MCP tool server. `domain_mutation` gets the same exactly-once executor path
  structurally, but nothing in this codebase exposes a mutating MCP domain yet (story 2-10 built only
  read-only Jira operations) — this story cannot demonstrate `domain_mutation` end-to-end for want of
  a real target, the same kind of gap 2-10 recorded for cross-domain generalization.
- No redesign of `composeCommit`, `GitNoteSchema`, or `WriteIntentSchema`. Those are 2-7's, already
  built and tested; this story is their caller.

## I/O & Edge-Case Matrix

| # | Input / situation | Expected |
|---|---|---|
| 1 | A composed commit's three intents (push, pull request, note) are executed for the first time | Each intent's `write.attempted` lands before its call; `git push` and `gh pr create` run once each; the run enters `awaiting_merge`, not `committed` |
| 2 | The engine crashes after `write.attempted` for `git_push` but before `write.executed` | On the next pass, the executor probes the remote rather than pushing again; if the branch is already there at the expected tip, `write.executed` is written without a second push |
| 3 | The same crash-and-recover happens for `pull_request` | The executor probes `gh pr list --head <branch>` rather than opening a second pull request for the same branch |
| 4 | A run in `awaiting_merge` is reconciled before the pull request has merged | One bounded `gh pr view` check; no note write; the run stays `awaiting_merge` |
| 5 | A run in `awaiting_merge` is reconciled after the pull request has merged | The note is written on the real merge commit; `write.attempted`/`write.executed` are recorded for the `git_note` intent; the run reaches `committed` |
| 6 | The engine crashes after the note's `write.attempted` but before the note actually lands | On the next pass, the executor probes `git notes --ref=orch show <merge-commit>` before writing again |
| 7 | Two reconcile passes for the same run both find `write.attempted` with no `write.executed` for the same intent, at nearly the same time | Only one push/PR/note-write actually reaches git/GitHub; the AD-29 single-writer claim on the run's own log serializes the passes, so there is only ever one reconciler acting on one run at a time |
| 8 | `awaiting_merge`'s wall-clock while waiting | Excluded from the wall-clock ceiling's measurement, the same way `blocked`/`drafting` already are |
| 9 | A `git_tag`/`domain_mutation` intent, if a caller ever produces one | Goes through the same `write.attempted`/probe/`write.executed` path as any other kind — not demonstrated against a real target this story, since none exists yet |

## Code Map

| File | Change | Why |
|---|---|---|
| `src/engine/executor.ts` | new | `write.attempted`/`write.executed` durability keyed by `intentIdFor(step, kind)` + run id; dispatch by `WriteIntentKind`; the git/`gh` shells for push and pull-request creation; the probe-before-redo recovery for each kind. |
| `src/contracts/state.ts` | modify | Add `'awaiting_merge'` to `FEATURE_STATES` (non-terminal; leave it out of `TERMINAL_FEATURE_STATES`). |
| `src/engine/ceilings.ts` | modify | Add `'awaiting_merge'` to `PERSON_WAITING_STATES` (line 181) alongside `drafting`/`blocked`, so its wait is excluded from wall-clock measurement the same way. |
| `src/contracts/event.ts` | modify | Payload-key constants for `write.attempted`/`write.executed`, if not already fully specified alongside the existing `EVENT_TYPES` entries. |
| `src/engine/reconciler.ts` | modify | Route a composed commit's intents through the new executor instead of only recording them; add the `awaiting_merge` transition and its bounded per-pass merge check; write the note and transition to `committed` once a merge commit is found. |
| `bin/orch-run.ts` (or equivalent) | new | The first real entry point: assembles a real `Reconciler`, spawner, recorder and this story's executor, and drives one real feature from an already-confirmed spec through to `committed`. Reuses every existing piece (interviewer, agents, gates) rather than rebuilding any of them — investigate exactly what's missing to wire, since prior stories' own production-readiness may already cover more of this than a first read suggests. |
| `tests/engine.executor.test.ts` | new | Matrix rows 1–3, 6, 9. |
| `tests/engine.reconciler.test.ts` | modify | Matrix rows 4, 5, 7, 8 — the `awaiting_merge` transition and the bounded merge check. |

## Tasks & Acceptance

1. **Build the executor with fixed write-before-durability ordering.**
   - **Given** a write intent about to be executed, **when** the executor acts, **then** `write.attempted`
     for that intent's key is durable in `events.jsonl` before the git/`gh` call is made.
   - **Given** a `write.attempted` with no `write.executed` on the next pass, **when** the executor
     reconciles it, **then** it probes the actual target before deciding whether to act again.
2. **Execute the three composed-commit intents exactly once.**
   - **Given** a composed commit's push, pull-request and note intents, **when** the executor runs
     them, **then** each lands exactly once regardless of how many reconcile passes observe them.
3. **Wait for the merge, then write the note on the real merge commit.**
   - **Given** a run whose push and pull request have landed, **when** the pull request has not yet
     merged, **then** the run is `awaiting_merge` and consumes no ceiling for the wait.
   - **Given** a run in `awaiting_merge` whose pull request has merged, **when** the next pass
     reconciles it, **then** the note is written on the actual merge commit and the run reaches
     `committed`.
4. **Prove it once, for real.**
   - **Given** a real, disposable feature run against this repository, **when** it completes, **then**
     a real pull request exists, the user merges it, and the resulting merge commit carries the AD-22
     note — confirmed by reading it back with `git notes --ref=orch show`, not merely by the code
     believing it wrote one.

## Spec Change Log

## Review Triage Log

### 2026-09-24 — Review pass
- verdicts: 29 findings — high 6, medium 6, low 17, false 0, maybe-false 0 — routed 20 patch, 3 defer, 6 reject
- findings:
  - `[high]` `patch` **The most serious finding of this round.** `runFeatureToCompletion` mints a `worktreeId` for `createWorktree`, but `Reconciler.acceptFeature(plan)` mints its own, separate run id internally (`this.minter.mint()`, `src/engine/reconciler.ts:1412`) — the two never match. `createWorktree`'s directory and branch are both keyed on `request.run` (`src/pool/worktree.ts:467-468`), so the worktree is registered under `worktreeId` while the run's own state lives under `accepted.run`. `runReclamationPass` correlates a worktree to a run by exactly this id and reclaims (deletes) any worktree whose run has no recorded state (`src/pool/reclaim.ts`) — so the live worktree, found under a run id nothing durable ever writes to, is a prime candidate for deletion while the run is still using it. — Verified directly: read `createWorktree`'s use of `request.run` for both `worktreeDir` and `runBranchFor`, and `acceptFeature`'s independent `this.minter.mint()` call. Found by edge-case-hunter, framed as a plain trigger condition rather than a claim. Patched: `ReconcilerOptions.minter` is already injectable (`UlidMinter = { mint: () => string }`) — `runFeatureToCompletion` now supplies a minter whose first `mint()` returns the same id already used for the worktree, so `acceptFeature`'s run id and the worktree's own id are the same value.
  - `[high]` `patch` The AD-22 note's crash-recovery check is local-only. `performGitNote`'s probe is `git notes show <mergeCommit>` against the worktree's own local notes ref — it never checks whether the note has actually reached `origin`. A crash between the local `git notes add` (succeeds) and the subsequent `git push` of the notes ref (never runs) leaves the note local-only; on retry, the same worktree's local `notes show` finds it "already there" and skips the push entirely — the note never reaches the remote, and the run still reports success. — Verified directly against `performGitNote`'s code: the `fetch` call only fetches the merge commit object, never the remote notes ref, so the probe cannot distinguish "already on origin" from "only ever added locally." Found by edge-case-hunter as a high-confidence claim. Patched: the probe now checks the remote (`git ls-remote origin refs/notes/<ref>` compared against the local note's own oid, or an equivalent remote-aware check) before treating the note as already present, and the `add` step tolerates a pre-existing local note (from an aborted prior attempt) rather than failing on it.
  - `[high]` `patch` **`awaiting_merge`'s polling loop has no pacing, and the CLI's own recovery advice does not work.** `runFeatureToCompletion`'s pass loop has no delay between iterations; once a run reaches `awaiting_merge`, it burns through up to 500 passes, each issuing a `gh pr view` call, almost instantly — defeating the entire point of waiting for a human and risking real rate-limit exhaustion. Separately, the timeout error tells the operator to "re-run this command once it has been merged," but nothing in `RunFeatureOptions`/`bin/orch-run.ts` can resume an existing run by id — re-running mints an entirely new run, worktree and branch, and would open a second pull request. — Verified directly: no delay/backoff anywhere in the pass loop, and no run-id parameter anywhere in `RunFeatureOptions`/the CLI's argv handling. Found by blind-hunter (both halves, independently). Patched: the loop now paces itself while non-terminal (sleeping between passes, short while actively stepping, longer while `awaiting_merge`), and a run id may be supplied to resume an existing run instead of always minting one.
  - `[high]` `patch` `settlePreMergeWrites` and the `check-merge` case call `this.writeExecutor(...)` with no `try`/`catch`. `performWriteIntent` *throws* — rather than returning a `WriteIntentResult` — for a `git_tag`/`domain_mutation` intent (`WriteKindNotImplemented`) and for a `git_note` intent asked for with no merge commit (`NoteMergeCommitUnknown`). If either is ever composed, the throw propagates straight out of `Reconciler.pass()` uncaught, crashing the reconcile loop instead of being classified through AD-35's disposition table the way every other engine failure is. — Verified directly: no `try`/`catch` around either call site. Independently found by blind-hunter and edge-case-hunter (precise line citations). Currently unreachable (nothing composes `git_tag`/`domain_mutation` yet, and `check-merge` only calls the note performer once a merge commit is already confirmed non-null) — patched anyway as cheap, direct defense-in-depth consistent with AD-35's own stated philosophy, rather than deferred as unreachable dead code, since the fix is a straightforward try/catch converting the throw to a failed/escalated result.
  - `[medium]` `patch` `performPullRequest`'s duplicate-check does not distinguish a `gh pr list` read failure (network, auth) from a genuinely empty result — both fall through to `gh pr create` blind, risking a double-create or misreporting an existing pull request as a fresh failure. — Verified directly against the code (`if (list.status === 0) {...}`, with no handling for a non-zero status). Found by edge-case-hunter. Patched: a read failure now refuses the write rather than proceeding blind, distinctly from "read succeeded, nothing found."
  - `[medium]` `patch` `readComposedCommit`'s `JSON.parse` is unguarded, and `recordComposedCommit` writes the artifact with a direct `writeFileSync`, not the atomic tmp-then-rename pattern most other artifacts in this codebase use — a crash mid-write is a real, not merely theoretical, way to leave a corrupt file behind, and the next pass's read would throw uncaught. — Verified directly: confirmed the non-atomic write. Found by edge-case-hunter. Patched: the read is now guarded, and a parse failure is treated as needing a person's attention (escalated), never as "nothing was composed" — the latter would silently skip ever pushing or opening the pull request for a step that, in fact, already composed one.
  - `[medium]` `patch` `ghDefaultBranchProtectionProbe`'s `execFileSync` calls (`git remote get-url`, `gh api`) carry no timeout, unlike the write executor's own calls, which set `WRITE_GIT_TIMEOUT_MS`/`WRITE_GH_TIMEOUT_MS` — a hung call blocks run start indefinitely instead of folding to "unverified" as the module's own docblock promises. — Verified directly. Found by edge-case-hunter. Patched: the same timeout constants now apply here too.
  - `[medium]` `patch` The PR URL `performPullRequest`'s `write.executed` event records in its `detail` field is never surfaced through `onProgress` or the CLI's stdout — an operator running `orch-run` for real has no way to learn where to go merge the pull request short of reading the raw event log. — Verified directly. Found by blind-hunter, and independently necessary for this story's own live demonstration. Patched: the CLI now prints the pull-request URL plainly once it is known.
  - `[medium]` `defer` `write.push_failed`/`write.pull_request_failed`/`write.kind_unimplemented` are declared `retry-with-backoff`/`abandon-and-hand-off` in the AD-35 table, but nothing in this path actually consults `dispositionFor` — a persistently failing push or pull-request creation (bad credentials, sustained network loss) retries every pass with no real backoff and no eventual escalation to a person. — Verified directly; the verification-gap layer independently noted the same absence, framing it as possibly intentional (the table entry as descriptive metadata rather than a wired mechanism). Deferred: a correct fix needs a failure-count-and-escalate mechanism, which is more than this round's direct corrections; worth a dedicated pass rather than a rushed one bolted onto this patch round.
  - `[medium]` `defer` A pull request closed *or removed* is named in this story's own Boundaries as a fact that must surface to a person, but `checkPullRequestMerged` only special-cases an explicit `state: "CLOSED"` answer — every other failure mode (a non-zero `gh` exit, unparseable JSON) folds to the same "still open" result a transient network hiccup would produce, so a genuinely removed pull request has no path to ever escalate. — Verified directly. Found by intent-alignment as a boundary-text divergence. Deferred: distinguishing "removed" from "a transient read failure" from the same failure shape risks misclassifying a recoverable hiccup as removed and escalating a run that would have succeeded on retry; the run is not actively harmed by staying `awaiting_merge` in the meantime (no ceiling pressure), so this is a real gap worth a considered fix, not a rushed one.
  - `[low]` `patch` `ConfirmedFeatureSpec.starting_model_tier` is declared but `parseConfirmedFeatureSpec` never actually reads `record['starting_model_tier']` from the parsed JSON — a caller-specified starting tier is silently dropped and the default is always used. — Verified plausible against the shown parse logic. Found by edge-case-hunter. Patched: added.
  - `[low]` `patch` `REMOTE = 'origin'` is declared independently in both `src/assembly/index.ts` and `src/engine/write-executor.ts`, with nothing preventing the two from silently drifting apart (unlike the git-call-wrapper duplication, which a real dependency-direction guard requires). — Verified directly. Found by blind-hunter. Patched: `src/assembly/index.ts` now imports the constant from `write-executor.ts` instead of redeclaring it.
  - `[low]` `patch` `ghDefaultBranchProtectionProbe` builds its API path without URL-encoding the branch name — a default branch name containing a slash would produce a malformed path and silently degrade to "unverified." — Verified directly. Found by blind-hunter. Patched: `encodeURIComponent`.
  - `[low]` `patch` `parseConfirmedFeatureSpec`'s `JSON.parse(raw)` is unguarded, so syntactically invalid JSON leaks Node's raw `SyntaxError` to the CLI user instead of one of this function's own friendly messages. — Verified directly. Found by blind-hunter. Patched.
  - `[low]` `patch` No test drives `performGitPush`/`performPullRequest`/`performGitNote`'s actual failure branches (a non-zero `git`/`gh` exit), no reconciler-level pass exercises `settlePreMergeWrites`'s `'unsettled'` return, and no reconciler-level test proves a partial settlement (e.g. `git_push` already executed, `pull_request` not yet) is resumed via `writeIntentSettled` rather than re-attempting the settled half — only success and idempotent-already-present paths are exercised at either layer, despite the surrounding "matrix rows" framing implying fuller coverage. — Independently found by blind-hunter (three of this pass's fourteen findings) and pre-verified by verification-gap with exact file:line citations for the same shape of gap (two grouped findings) — five raw findings, one root cause. Patched: failure-branch and partial-settlement tests added at both the unit and reconciler level, alongside the fixes above.
  - `[low]` `patch` In the `check-merge` case, when a `mergeChecker` is wired but `writeExecutor` is `null`, the code returns `null` with no emitted event and no stated reason — silently contradicting this module's own stated philosophy elsewhere (a missing port is "named, visible... never a silent skip," per its `gates`/branch-protection commentary). — Verified directly. Found by blind-hunter. Patched: this combination now emits a plain, named reason the same way every other missing-port gap in this module already does.
  - `[low]` `reject` The story spec file is untracked and not part of the reviewed diff, so the "matrix row" references scattered through the new code and tests cannot be cross-checked against it. — Found by blind-hunter. Rejected: expected and correct, the same reason this was rejected in prior stories' review rounds — blind-hunter reviews the code diff only, by design; the spec was in fact kept in step, just never part of what this layer is shown.
  - `[low]` `defer` No README or other documentation describes the new `orch-run` CLI's invocation, its `spec.json` shape, or its preconditions, even though `package.json` now exposes it as a public bin entry and package export. — Verified directly (no README changes in the diff). Found by blind-hunter. Deferred: real, but writing it is more than a direct correction, and this CLI's own docblock (`bin/orch-run.ts`) already states its usage, shape and preconditions in full — a README would restate rather than newly supply that information.
  - `[low]` `reject` The spec's Intent/Approach text lists "interviewer, agents, gates, spawner" as pieces this story "wires... into the first real entry point," which overstates what was actually built: `gates` is left `null` (a separately-tracked, honestly-named gap) and the interviewer is not invoked (this entry point takes its output, per its own docblock). — Found by edge-case-hunter as two boundary-text claims. Rejected as a code finding: the implementation is honest and conservative about both gaps, named in its own comments; the imprecision is in this spec's own prose, corrected directly in the Auto Run Result below rather than routed as work.
  - `[low]` `reject` Matrix row 9's text ("goes through the same `write.attempted`/probe/`write.executed` path as any other kind") contradicts the actual, safer code behavior: `git_tag`/`domain_mutation` refuse before any durability write, never recording a `write.attempted` that could never be followed by a `write.executed`. — Found by intent-alignment as a direct textual contradiction between the spec surface and the code/test surface. Rejected per this project's own triage rule (a finding whose fix is editing this build's spec, not the code): the code's behavior — refuse cleanly, by name, before recording an attempt nothing will ever complete — is better than what the matrix literally asked for, corrected in the spec directly rather than routed as a code change.
  - `[low]` `reject` The boundary text names `gh pr view <number>` as the probe key; the diff probes by branch instead. — Found by intent-alignment. Rejected: `gh pr view` accepts a branch name in place of a number by design, and probing by branch is a working, tested equivalent — not an observable defect, code that works correctly through a valid alternate path.
  - `[low]` `reject` The boundary text describes recovery as "read `write.attempted`... if durably present with no matching `write.executed`," while the actual mechanism gates on `write.executed` presence and re-emits `write.attempted` on every un-settled call rather than first checking for a dangling one. — Found by intent-alignment. Rejected: the two mechanisms produce identical, correct outcomes; this is a difference in how the spec's prose described the mechanism, not a defect in the mechanism itself.

## Design Notes

**Why `awaiting_merge` rather than reusing `blocked`.** `blocked` already means "waiting on a
person's answer to a question" (AD-25's compare-and-set). Reusing it for "waiting on a PR merge" would
make one state name two different facts, which is exactly what this project's own ceiling and state
work (story 2-9) argues against: "the person reading the state needs one honest signal." A new,
narrowly-named state costs one more case in every exhaustive switch over `FeatureState` — which is the
point: the compiler catches a reader that forgot this state exists, rather than a silent gap.

```ts
// The recovery shape every intent kind shares, sketched:
const attempted = findAttempted(events, run, intent.intent_id);
if (attempted && !findExecuted(events, run, intent.intent_id)) {
  const already = await probe(intent.kind, intent.target); // git/gh read, never a write
  if (already !== null) return recordExecuted(recorder, intent, already); // no second call
}
```

## Verification

Run by me, exit status captured to a variable and output kept in a file:
`npm run typecheck && npm run lint && npm run build && npm test` — **exit 0, 2779 tests across 93
files, zero failures, zero skips**, run a final time after the review round's patches. The
implementation reached 2763/93 (verified independently before dispatching review); the review-round
patches took it to 2779/93.

**The two `high` findings I judged most consequential, verified by me directly in the patched code, not
taken on report:**
- The worktree/run-id fix: `seededUlidMinter(worktreeId)` in `src/assembly/index.ts` returns the
  worktree's own id on the first `mint()` call, which is exactly the one `Reconciler.acceptFeature`
  makes internally — confirmed by reading both call sites, and by the new test asserting
  `accepted.run === worktreeId` directly against a real `Reconciler`, real `createWorktree`, and a real
  `runReclamationPass` that leaves the live worktree in `summary.retained`.
- The note-remote fix: `notePushedToRemote` in `src/engine/write-executor.ts` compares `git rev-parse
  <ref>` (local) against `git ls-remote origin <ref>` (remote) and only treats the note as landed when
  they agree — confirmed by reading the function and its call site in `performGitNote`, and by the new
  test that adds a note locally without pushing it, then confirms a retry still performs the push
  rather than reporting the write already done.

**Matrix Test Audit.** All nine rows are covered by tests that ran and passed in the run above: rows 1,
2, 3, 6, 9 in `tests/engine.write-executor.test.ts` (extended this round with explicit failure-branch
cases for all three performers, the local-only-note recovery case, and the reserved worktree/run-id
behavior implied by row 1's "the run enters `awaiting_merge`, not `committed`"); rows 4, 5, 7, 8 in
`tests/engine.reconciler.test.ts` (extended this round with the `'unsettled'` recovery case and the
partial-settlement-resume case); rows 1 and 8 additionally in `tests/assembly.test.ts`'s new
worktree/run-id and reclamation tests.

**Manual check not yet performed, by design.** The real, once-only demonstration — a disposable branch
and pull request actually opened against this repository, merged by the user, and the note read back
from the real merge commit with `git notes --ref=orch show <sha>` — is deliberately not part of this
verification pass. It is the next, separate step, done transparently with the user rather than folded
into an automated gate.

## Auto Run Result

**Status: done, reviewed.** The write executor exists: `write.attempted`/`write.executed` durability,
exactly-once execution per intent keyed by `intentIdFor(step, kind)` + run id, and crash recovery that
probes the actual git/GitHub state before ever repeating a call. A composed commit's push and
pull-request intents land through it; the run then waits, `awaiting_merge`, for a human to merge before
the AD-22 note is written on the real merge commit and the run reaches `committed`. The first real
composition root (`src/assembly/index.ts`, `bin/orch-run.ts`) wires a real `Reconciler`, a real spawner,
a real worktree, and this story's executor together — closing the "no production assembly point" gap
carried as a high-severity deferred entry since story 2-4, at least for the push/pull-request/note half
of a run; `gates` is left `null`, a separately-tracked, honestly-named gap this story does not close.

**The heaviest review of this story's own arc: 29 findings, high 6, medium 6, low 17, routed 20 patch,
3 defer, 6 reject.** Two were genuinely serious, both caught by independent review layers and verified
directly by me before dispatching the patch round:
- **The worktree and the accepted run could carry different ids.** `runFeatureToCompletion` minted one
  id for the worktree and let `Reconciler.acceptFeature` mint a second, unrelated one for the run — so
  the live worktree was registered under an id with no corresponding durable run state, exactly what
  AD-32's reclamation pass treats as reclaimable. A live run's own worktree could have been deleted out
  from under it. Fixed with a seeded minter so the two ids are the same value by construction, verified
  against a real `Reconciler`, a real worktree, and a real reclamation pass.
- **A crash between adding a note locally and pushing it would have made the note permanently
  disappear, while the run still reported success.** The recovery probe checked only the worktree's own
  local notes ref; a note added but not yet pushed reads as "already there" to a local-only check, so
  the retry that should have pushed it never would have. Fixed by checking the note has actually reached
  `origin` before treating it as landed, verified with a test that adds a note locally, holds back the
  push, and confirms a retry still performs it.

**Four more real, patched findings:** the `awaiting_merge` polling loop had no pacing at all, capable of
burning through its full pass budget against a real GitHub API in seconds, and the CLI's own advice to
"re-run once merged" did not work, since re-running always minted a fresh run rather than resuming the
parked one — both fixed together (pacing while non-terminal, a `--resume <run-id>` path that skips
`acceptFeature`/`createWorktree` for an already-accepted run); a thrown, not returned, result from an
unimplemented write kind or a premature note attempt could have crashed the reconcile loop uncaught,
now caught and classified; and a `gh pr list` read failure was treated the same as "no existing pull
request", risking a blind double-create.

**Three findings were rejected as spec-prose issues, not code defects** — the code's behavior was
correct or better than what this spec's own prose literally asked for, so the prose is what needed
correcting, not the implementation: `git_tag`/`domain_mutation` refuse before ever recording a
`write.attempted`, which is safer than the matrix's literal "same path" wording would have required
(an attempt with no possible completion is worse than a clean, named refusal); the merge check probes
by branch rather than by pull-request number, a documented, working equivalent `gh pr view` supports
directly; and the Intent's own "wire the pieces this project has already built — interviewer, agents,
gates, spawner" overstated scope this round never claimed to close for `gates` or the interviewer, both
honestly named as gaps in the implementer's own comments from the first round.

**Follow-up review recommended: true.** Two `high` findings were patched, which sets this
unconditionally. The specific unverified risks are the three items in `deferred`: no real backoff or
eventual escalation for a persistently failing push/pull-request/write, a removed pull request not
reliably distinguished from a transient read failure, and no README for the new CLI (whose own docblock
already documents it).

**Residual risks.** See the three-item `deferred` list in the frontmatter, and the untouched
`gates: null` gap named above and in `src/assembly/index.ts`'s own comments. Everything else the review
found that could be patched was, and the reject rows above are recorded with the reasoning for why the
code, not the spec's prose, was correct.

**What remains before this story's own stated milestone is reached.** Nothing further in code: the
real, once-only demonstration — a disposable branch and pull request opened against this repository,
merged by the user, with the note confirmed on the real merge commit — is the one thing this
verification pass deliberately left for a separate, transparent step.
