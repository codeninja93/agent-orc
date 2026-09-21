---title: Worktree lifecycle, leased resource pool, reconcile reclamation
type: feature
created: '2026-09-20'
status: done
review_loop_iteration: 1
followup_review_recommended: true
context:
- '{project-root}/docs/planning-artifacts/architecture/architecture-agent-orcastrator-2026-09-19/ARCHITECTURE-SPINE.md'
- '{project-root}/docs/specs/spec-agent-orchestrator/SPEC.md'
- '{project-root}/docs/specs/spec-agent-orchestrator/stories/1-5-container-wrapper.md'
- '{project-root}/docs/specs/spec-agent-orchestrator/stories/1-3-engine-reconciler.md'
warnings:
- oversized
deferred:
- summary: 'RESOLVED: the tier-2 execution conflict this story recorded was accepted as ADR-001.'
  evidence: 'RESOLVED 2026-09-20: ADR-001-tier-2-execution.md was accepted and AD-1, AD-20 and AD-20''s
    egress line amended in the spine, which moves the containment boundary from

    the agent process to the commands the agent runs. The decisive finding is that the subscription

    credential is in the macOS keychain rather than a file, so no mount can put it inside a

    container — making AD-20''s container and AD-1''s subscription-only auth incompatible on the

    stated primary platform. The ADR is proposed, not accepted; it awaits Deep''s sign-off and amends

    AD-1 and AD-20, which live in an adopted companion this session does not own.'
  location: docs/planning-artifacts/architecture/architecture-agent-orcastrator-2026-09-19/ADR-001-tier-2-execution.md
  severity: high
- summary: 'A tier-2 step still cannot reach the instance it leases: execution runs with no general network
    and a leased service is published on loopback.'
  evidence: '`src/container/flags.ts` composes `--network none` for the execution phase (AD-20), and

    `src/container/service.ts` publishes a leased instance on `127.0.0.1:<port>`. Both are correct to

    their own contracts and they do not meet. Bridging them is the egress work this story''s Never list

    assigns to story 2-10; CAP-11 is therefore mechanised end to end for the *host* and not yet for a

    confined step.'
  location: src/container/service.ts
  severity: high
- summary: 'A tier-2 step cannot run git inside its worktree: the worktree''s `.git` points outside the
    one directory story 1-5 mounts.'
  evidence: '`git worktree add` writes a `.git` *file* naming `<repo>/.git/worktrees/<run-branch>`, and
    AD-20''s

    mount allow-list admits only the worktree and the run''s session directory. So a step that commits

    its own work — which the crash fixture''s executor does on the host — would fail inside a container.

    Mount discipline is story 1-5''s and this story may not widen it, so the gap is recorded rather than

    papered over. A linked worktree is still the right shape; what needs deciding is whether the admin

    directory is mounted or the step commits through the engine.'
  location: src/pool/worktree.ts
  severity: high
- summary: On a host where the engine is not root, a worktree is made writable by the executor uid by
    widening its mode rather than by chowning it.
  evidence: '`makeWritableByExecutorUid` chowns when `process.getuid()` is 0 and otherwise sets the other-write

    and other-execute bits, because there is no other way for a *fixed* foreign uid to write a tree this

    process owns. The widening is confined to `ORCH_HOME/worktrees/` and holds a disposable checkout.

    The alternative — passing the host uid to the container — is refused because it would make the flag

    set depend on who ran the engine and story 1-5''s suite could no longer assert a fixed non-root user.

    Asserted either way by `unwritablePaths`, which is empty after creation and non-empty before.'
  location: src/pool/worktree.ts
  severity: medium
- summary: The two service image pins are unresolved, and a pooled service is a stock image rather than
    a locally built one.
  evidence: '`postgres:17.2-alpine` and `redis:7.4-alpine` are pins nothing has pulled, because no daemon

    answers here. AD-11''s build-it-locally rule binds the *executor* image; a leased database is not
    it,

    and building postgres from a Dockerfile in this repository would be a second image to maintain for

    no isolation gain. A wrong pin surfaces as a failed start, which the lease reports as

    `resource.lease_timed_out` rather than as a hang.'
  location: src/container/service.ts
  severity: medium
- summary: A quarantined instance is reclaimed by no pass, by design, so a dirty return leaves a container
    standing until a person acts.
  evidence: '`resource.return_dirty` is declared `escalate-to-human`. Destroying the instance would delete
    the evidence the escalation is about, and reclaiming it would be the pass deciding a question the
    AD-35 table assigns to a person. The record under `pool/quarantine/` names the instance and its residue;
    nothing yet renders that, which is story 1-7''s surface. CORRECTED 2026-09-21 by review: the contract
    was NOT holding. A crash between writing the quarantine record and removing the lease record left
    both, and the pass enumerated lease records only, so the next pass destroyed the very instance a human
    was asked to inspect. Enumeration now excludes quarantined lease ids and container names.'
  location: src/pool/lease.ts
  severity: low
- summary: 'RESOLVED: the containment gate is met and the live-instance suites run.'
  evidence: Docker 29.8.0 is reachable, the AD-31 suite passes, and this story's live redis suite now
    runs for real — which is what let the rewritten wipe test verify emptiness against an instance that
    actually held data.
  location: tests/pool.lease.test.ts
  severity: high
- summary: The label sweep reports unrecorded containers but does not destroy them.
  evidence: '`SERVICE_LABEL_KEYS` carries no `ORCH_HOME` and AD-30''s lock is per home, not per machine,
    so destroying on that evidence would let one engine reclaim another home''s live instances. The AD-32
    invisibility half is closed — such a container is now named in every pass. Closing the destructive
    half needs a home-scoped label key, which is new surface rather than a correction.'
  location: src/container/service.ts
  severity: medium
- summary: Postgres cluster-wide residue is reported but cannot be removed by the wipe.
  evidence: Extra databases and roles are outside what a single-database wipe can reach, so such an instance
    is quarantined for a person rather than handed on. Fail-closed and consistent with the quarantine
    design, but the wipe is narrower than the probe, which is worth closing with a multi-database loop
    before CAP-11 carries real features.
  location: src/container/service.ts
  severity: medium
- summary: '`branchExists` still adopts an existing `orch/run/<id>` branch, though branch deletion now
    makes that unreachable for a fresh run id.'
  evidence: 'Reported rather than rewritten: branch naming belongs to story 2-7, and the root cause —
    a permanent ref left by every run — is fixed. The adopt path remains as dead-but-reachable-by-collision
    code.'
  location: src/pool/worktree.ts
  severity: low
baseline_revision: 7487508adede8190394f060cac16ca3b9184f656
---

<intent-contract>

## Intent

**Problem:** Story 1-3's reconciler resets a worktree it assumes exists, story 1-5 confines a worktree it is handed, and nothing creates or destroys one. No feature can get a database or cache, and nothing reclaims anything: a crash today strands whatever a run was holding, because AD-32's rule that reclamation is a reconcile action has no implementation. CAP-11 does not exist, and the worktree half of CAP-10's tier 2 is assumed rather than built.

**Approach:** Add `src/pool/`: per-run git worktrees created writable by the executor uid and destroyed only at a terminal disposition, postgres and redis instances leased from a warm pool within a declared time bound and wiped-then-verified-empty on return, and a reclamation pass that compares live resources against runs. The reconciler calls that pass; nothing is reclaimed by a process exiting.

## Boundaries & Constraints

**Always:**
- A run's worktree lives at `worktrees/<run-id>/` under `ORCH_HOME` and is created writable by the container's executor uid, because story 1-5 mounts it into a container running as a non-root user.
- A worktree is destroyed only once its run reaches a terminal disposition. The run's evidence under `runs/<run-id>/` survives the worktree indefinitely.
- Reclamation is a reconcile pass comparing live resources against runs, never a shutdown handler and never an exit path. Killing the process at any moment must leave every resource reclaimable on the next pass.
- A resource whose run reached a terminal disposition, or whose run state no longer exists, is reclaimed on the next pass. Nothing is reclaimed while its run holds a non-terminal disposition.
- A feature that needs postgres or redis receives a ready instance within a declared time bound; exceeding it is a declared failure, never a hang.
- A returned lease is wiped and then verified empty. A resource that comes back with residue is refused rather than handed on.
- Every container invocation goes through story 1-5's single invoker, and `src/pool/` never names the container runtime or composes a container flag. Flags for a leased service belong in `src/container/`.
- Where a real container runtime is required and none is reachable, the affected tests skip visibly using the mechanism story 1-5 already established. Do not invent a second marker.
- `src/pool/` imports only from `src/contracts/`, `src/runtime/`, `src/container/` and `node:` builtins.

**Never:**
- Never compose a container flag outside `src/container/`, and never name the container runtime in `src/pool/`.
- Never remove a worktree, or reclaim a lease, while its run holds a non-terminal disposition.
- Never reclaim on process exit, in a signal handler, or in a `finally` — AD-32 exists because a crash skips all three.
- Never delete a run's evidence directory when destroying its worktree.
- No changes to story 1-3's reconciler beyond the additive call that invokes reclamation, and no change to its existing behaviour: the 21-boundary crash-injection suite must still pass unchanged.
- No project registration or prune (AD-33), no ceilings (2-9), no committer or branch naming (2-7), and no egress proxy.
- Never infer that a run is abandoned from a missing path alone; absence of run *state* is the signal, not absence of a directory.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Worktree created | A run id and a repository | A worktree at `worktrees/<run-id>/`, on its own branch, writable by the executor uid | No error expected |
| Worktree at terminal | A run that reached a terminal disposition | The worktree is removed and its git registration pruned | No error expected |
| Evidence survives | A removed worktree | `runs/<run-id>/` and its event log are untouched | Evidence is never deleted with a worktree |
| Removal while live | A run holding a non-terminal disposition | Refused, naming the run and its state | The worktree remains |
| Orphaned worktree | A worktree whose run state no longer exists | Reclaimed on the next pass | No error expected |
| Reclamation after a kill | The process killed with resources held | The next pass reclaims them; nothing relied on an exit path | No leak survives a restart |
| Lease acquired | A feature needing postgres | A ready instance within the declared bound | No error expected |
| Lease times out | A pool that cannot produce an instance in time | A declared timeout failure carrying `resource.lease_timed_out` | Never a hang |
| Lease returned clean | A lease returned after use | Wiped, then verified empty, then available again | No error expected |
| Lease returned dirty | A resource still holding data after a wipe | Refused with `resource.return_dirty`, not handed to another run | Never reissued |
| Lease at terminal | A lease whose run reached a terminal disposition | Reclaimed on the next pass | No error expected |
| Lease held by a live run | A lease whose run is non-terminal | Not reclaimed | No error expected |
| Two runs, one kind | Two features each needing redis | Each receives its own instance | Neither sees the other's data |
| No runtime reachable | No container runtime answers | Worktree operations still work; pool operations skip visibly | Never a silent pass |

</intent-contract>

## Code Map

Stories 1-1 through 1-5 shipped `src/contracts/`, `src/runtime/`, `src/engine/` and `src/container/`. The AD-9 path helpers this story needs already exist (`worktreesDir`, `worktreeDir`, `poolDir` in `src/runtime/paths.ts`), as does the single container invoker and story 1-5's skip discipline.

- `src/pool/worktree.ts` -- create; create a per-run worktree writable by the executor uid, remove it only at a terminal disposition, and prune its git registration
- `src/pool/lease.ts` -- create; acquire within a declared bound, return through wipe-then-verify-empty, and refuse a dirty resource
- `src/pool/reclaim.ts` -- create; the AD-32 pass: enumerate live worktrees and leases, compare against run state, reclaim what no live run holds
- `src/pool/index.ts` -- create; the surface the engine wires in
- `src/container/service.ts` -- create; the flag set for a leased service container, so the runtime name and every flag stay inside `src/container/` as AD-20 requires
- `src/engine/reconciler.ts` -- modify, additively only; invoke the reclamation pass from a reconcile pass. Existing behaviour and the 21 crash boundaries must be unchanged
- `tests/pool.worktree.test.ts` -- create; creation, uid writability, terminal-only removal, evidence survival, refusal while live
- `tests/pool.lease.test.ts` -- create; the time bound, wipe-and-verify-empty, the dirty refusal, and isolation between two runs
- `tests/pool.reclaim.test.ts` -- create; orphan reclamation, the non-terminal exclusion, and that a kill leaves everything reclaimable next pass
- `tests/container.service.test.ts` -- create; the composed argv for a leased service

Read-only evidence, authoritative and not to be edited by this story:

- `ARCHITECTURE-SPINE.md` -- AD-32 (reclamation is a reconcile action), AD-9 (the `worktrees/` and `pool/` layout), AD-20 (one wrapper owns every container invocation), AD-11, AD-33 (absence of a path is not abandonment)
- `src/contracts/error.ts` -- `resource.lease_timed_out` is declared `retry-with-backoff` and `resource.return_dirty` is declared `escalate-to-human`; use them rather than minting codes
- `src/container/index.ts` -- the invoker, the runtime probe, and `REQUIRED_CONTAINMENT_CHECKS`
- `src/runtime/paths.ts` -- the AD-9 path helpers
- `tests/helpers/engine-fixture.ts` -- `GitWorktree`, `makeHome`, `fixtureGit`, `fixtureCommit`: a real temporary repository this story's tests should reuse rather than rebuild

Carried forward from stories 1-3 through 1-5:

- **Story 1-5 recorded this story's obligation explicitly:** a bind-mounted worktree owned by the host user is not writable by the container's uid 10001 on Linux, so the worktree must be created writable by that uid. Story 1-5's assertion probe chmods its own temp directories, which means it cannot catch a failure here.
- **The container runtime daemon is unreachable on this machine.** Story 1-5 established the honest-skip pattern and the gate that refuses a containment claim while a skip marker stands. Reuse it; a second marker mechanism would be a second thing to keep honest.
- Story 1-3's reconciler holds no authoritative state in memory and takes at most one action per pass. Reclamation must fit that shape: a pass decides, and a kill mid-pass loses nothing.
- Story 1-3's crash-injection suite discovers its boundaries rather than hardcoding them, so adding a durable write inside a pass will add boundaries automatically. That is the intended interaction; the suite must still converge.
- `git worktree remove` refuses a dirty worktree by default, and a `--force` that silently discards a step's work would defeat AD-26. Decide deliberately and record which.

## Tasks & Acceptance

**Execution:**
- `src/pool/worktree.ts` -- create a worktree at the AD-9 path, on its own branch, writable by the executor uid -- story 1-5 mounts it into a container running as a non-root user, so host-only ownership makes tier 2 unusable
- `src/pool/worktree.ts` -- remove a worktree and prune its registration only at a terminal disposition, leaving the run's evidence untouched -- the worktree is disposable and the evidence plane is not
- `src/container/service.ts` -- compose the flag set for a leased service container -- AD-20 gives one place ownership of every flag, so a pool that composed its own would create a second boundary
- `src/pool/lease.ts` -- acquire within a declared time bound, failing with `resource.lease_timed_out` rather than waiting -- CAP-11's success criterion is a bound, and a hang is the failure it forbids
- `src/pool/lease.ts` -- return through wipe-then-verify-empty, refusing a dirty resource with `resource.return_dirty` -- a resource handed on with residue leaks one feature's data into another
- `src/pool/reclaim.ts` -- compare live worktrees and leases against run state and reclaim what no live run holds -- AD-32 makes this a pass precisely because a crash skips every exit path
- `src/pool/reclaim.ts` -- never reclaim a resource whose run holds a non-terminal disposition, and treat missing run state rather than a missing path as the abandonment signal -- AD-33's lesson applied to resources
- `src/engine/reconciler.ts` -- invoke reclamation from a pass, additively -- reclamation that is not part of the loop is reclamation a crash can skip
- `tests/pool.worktree.test.ts` -- cover creation, uid writability, terminal-only removal, evidence survival and the live refusal, against a real temporary repository -- the fixture from story 1-3 already builds one
- `tests/pool.lease.test.ts`, `tests/container.service.test.ts` -- cover the bound, the wipe-and-verify, the dirty refusal, isolation between runs, and the composed service argv -- the argv is the only assertable part without a daemon
- `tests/pool.reclaim.test.ts` -- cover orphan reclamation, the non-terminal exclusion, and that a kill leaves everything reclaimable on the next pass -- the last one is the property AD-32 exists for

**Acceptance Criteria:**
- Given a clean checkout on Node `>=22.22`, when `npm run typecheck && npm run lint && npm test && npm run build` is run, then all four succeed and the pool suites appear in the test output.
- Given a run id and a repository, when a worktree is created, then it exists at `worktrees/<run-id>/` under `ORCH_HOME`, is on its own branch, and its mode permits writes by the container's executor uid.
- Given a run holding a non-terminal disposition, when its worktree removal is attempted, then the attempt is refused naming the run and its state and the worktree still exists; and given the run reaches a terminal disposition, then the worktree is removed, its git registration is pruned, and `runs/<run-id>/` is untouched.
- Given a worktree or lease whose run state no longer exists, when a reclamation pass runs, then it is reclaimed; and given one whose run is non-terminal, then it is not.
- Given resources held and the process killed at any point, when a later pass runs, then every resource is reclaimed, and no reclamation depended on an exit path, a signal handler or a `finally`.
- Given a pool that cannot produce an instance within the declared bound, when a lease is requested, then it fails carrying `resource.lease_timed_out` rather than waiting.
- Given a lease returned after use, when it is processed, then it is wiped and then verified empty before becoming available; and given a resource still holding data after the wipe, then it is refused carrying `resource.return_dirty` and is never reissued.
- Given two features each needing redis, when both hold leases, then each has its own instance and neither can read the other's data.
- Given no reachable container runtime, when the suite runs, then worktree behaviour is still fully exercised and pool behaviour requiring a runtime skips visibly through story 1-5's existing mechanism.
- Given `src/pool/`, when its imports and text are inspected, then it imports only from `src/contracts/`, `src/runtime/`, `src/container/` and `node:` builtins, and names no container runtime.
- Given story 1-3's crash-injection suite, when it runs after this story's reconciler change, then it still converges on every boundary it discovers.

## Spec Change Log

- **`git worktree remove` is never forced, and the refusal is surfaced.** The Design Notes asked for a
  deliberate decision either way; this is it. Removal happens only at a terminal disposition, and even
  there a worktree holding uncommitted changes is reported rather than deleted: AD-26 makes a step's
  effects recoverable by resetting to a recorded baseline, not by deletion, so forcing past uncommitted
  work would destroy evidence a re-run would otherwise reproduce. The `--force` path exists as an
  explicitly named `discardUncommitted` request that no reclamation pass ever makes, and
  `tests/pool.worktree.test.ts` asserts both halves.
- **Reclamation reaches the reconciler as a port, not as an import.** Story 1-3's own guard
  (`tests/engine.reconciler.test.ts`) asserts that every file under `src/engine/` imports only from
  `src/contracts/` and `src/runtime/`, so the loop cannot import `src/pool/`. The additive change is
  therefore a `reclamation?: ReclamationPass` option satisfied structurally, wired by
  `reconcilerReclamation()` — the same seam story 1-5's wrapper reaches story 1-4's spawner through. An
  engine with no reclamation wired in reports `reclaimed: null` rather than claiming success.
- **`src/container/runtime.ts` gained the `exec` and `stop` subcommands.** A file the Code Map did not
  list. A leased instance's readiness probe, wipe and emptiness check are all commands run *inside* it, so
  CAP-11's "verified empty" is unreachable without `exec`; and AD-20 spells the runtime's vocabulary in
  exactly one file, so declaring them in `service.ts` instead would have created a second vocabulary.
- **`tests/container.wrapper.test.ts`'s exact file list gained `service.ts`.** Story 1-5's guard asserts
  the contents of `src/container/` as a closed list, so creating the file the Code Map names required
  updating it. Nothing else in story 1-5's suite changed.
- **One argued exception to the credential-shaped-name refusal.** `POSTGRES_HOST_AUTH_METHOD` matches
  story 1-5's `/AUTH/i` pattern and carries no secret — its value is `trust`, and the point of it is that
  the instance has no password for anything to leak. Rather than loosening the pattern, `service.ts`
  declares `SERVICE_ENV_SHAPE_EXCEPTIONS` with the argument attached, and the suite asserts that every
  entry in it is in fact shape-matched so the table cannot accumulate names the guard never objected to.
- **The pool's durable records carry `schema_version`, and the two failure modes are treated
  differently.** A record written by a version this build does not read is refused loudly (AD-28 has no
  per-artifact latitude for state); a *corrupt* record is skipped, so one half-written file cannot stop a
  pass from reclaiming every other resource.
- **A returned instance rejoins a durable warm inventory under `pool/warm/`.** The "warm pool" of the
  Approach has to survive a restart or it is a leak: an instance recorded only in memory becomes a
  container nothing on disk mentions the moment the process dies, which is the exact failure AD-32
  exists to prevent.

## Review Triage Log

### 2026-09-21 — Review pass (follow-up, on a `done` spec)

- claims filed: 55 across four layers — blind-hunter 15, edge-case-hunter 22, verification-gap 3 gap + 5
  other, intent-alignment 10. Several were filed by more than one layer (the symlink escape by two, the
  unwired-callers gap by three), so the filed count is larger than the number of distinct defects.
- grouped into the 33 rows below: high 5, medium 22, low 4 grouped classes, false 2, maybe-false 1.
  25 entries patched, 4 deferred, the rest rejected on their refutation or as cosmetic.
- the counts here describe the rows, not a separate tally. On story 1-5 I declared a finding total that did
  not match its rows, which the protocol names as a triage failure; I then over-counted in the other
  direction here by expanding grouped rows into claim counts. Both were my arithmetic, not the layers'. The
  auditable facts are the two above: 55 claims filed, 33 rows, 25 patched, and no filed claim without a row.
- I verified every `high` myself against HEAD, three of them empirically by running the compiled build: the
  symlink escape, the stray-directory abort, and the forged-marker analogue in 1-5. Rows resting on the patch
  round's verification are the `low` corrections; rows from the verification-gap layer arrive pre-verified per
  the protocol.

- `[high]` `[patch]` `makeWritableByExecutorUid` followed symlinks out of the worktree, so an agent-authored symlink widened an arbitrary host file. I proved it: an outside file went from `-rw-------` to `-rw----rw-`. `walk()` pushed every entry and only gated *descent* on the Dirent. The reachable form needs no root — the non-root branch ORs the other-write bit; the root branch chowns host files to uid 10001, the executor's own uid. Fixed by `lstat`ing each path and skipping symlinks, with `lchownSync` on the root branch. My probe now leaves the target at `-rw------- 501:0`.
- `[high]` `[patch]` One stray directory under `worktrees/` switched off all reclamation. I proved it: `worktrees/.staging/` made the compiled pass throw `UnsafePathSegmentError` before enumerating anything, so a valid lease in the same pass was neither decided nor acted on — and from the loop that repeats every pass, forever. Exactly the invisible-leak state AD-32 exists to prevent. Now the unusable entry is reported into `summary.failed` and the pass continues; my probe reports the stray and reclaims the rest.
- `[high]` `[patch]` A quarantined instance was destroyed by the next pass, contradicting this story's own `deferred[4]` contract whose whole purpose is preserving evidence for a human. A crash between writing the quarantine record and removing the lease record leaves both, and the pass enumerated lease records only. Enumeration now excludes lease ids *and* container names present under `pool/quarantine/`.
- `[high]` `[patch]` A warm instance could be leased twice: `claimWarm` claimed with `rmSync(..., { force: true })`, which swallows ENOENT, so two concurrent `acquire()` calls both won and both wrote a lease naming the same container — breaking this story's own criterion that two runs of one kind never see each other's data. Now an atomic `renameSync` into `pool/claims/`, where ENOENT means you lost.
- `[medium]` `[patch]` The warm-claim window lost a container permanently — the warm record was deleted before the lease record was written, so a crash in between left a running container recorded nowhere and nothing enumerates containers. `claimWarm`'s own comment asserted the opposite, and `release()` already ordered the other way for exactly this reason. The record is now moved to `pool/claims/` first, so some durable file names the container at every instant.
- `[medium]` `[patch]` `release()` never verified it still held the lease, so a stale `Lease` released twice wiped an instance another run had since acquired — data destruction in the module whose purpose is that one feature's data never reaches another. Now reads the record first and throws `LeaseNotHeldError`.
- `[medium]` `[patch]` Warm instances were reclaimable by nothing: they belong to no run, `decideReclamation` needs a run, so a returned instance ran forever across restarts holding a port and its memory limit. No idle TTL, no ceiling, and the story's `deferred` block never mentioned it. Added `WARM_IDLE_TTL_MS`, `MAX_WARM_PER_KIND` and a pure `decideWarmExpiry`.
- `[medium]` `[patch]` The readiness bound used wall-clock time, so a backwards clock step meant `elapsed` never reached `boundMs` — an unbounded hang, which is what CAP-11 declares impossible. Now monotonic.
- `[medium]` `[patch]` The declared time bound did not cover `start`: the clock began after `operator.start()` returned, and start fell back to a 30s control timeout, so a 30s redis bound could take 60s. The clock now starts before the claim and the deadline is checked before each probe.
- `[medium]` `[patch]` A failed start was reported as `resource.lease_timed_out`, whose disposition is retry-with-backoff — a retry loop over a permanent failure like a bad image pin. `ServiceOperationError`/`container.start_failed` was already declared and thrown nowhere; it is now thrown here. Port exhaustion threw a bare `Error` with no AD-35 code and now throws `PoolPortsExhaustedError`.
- `[medium]` `[patch]` A stale warm record burned the entire bound: records are durable and containers are not, so after a reboot `acquire` polled a dead container for the full bound instead of starting a fresh one. Liveness is now probed after the atomic claim.
- `[medium]` `[patch]` `release` rejoined an instance as available when the WIPE FAILED and only the probe happened to read empty — `wiped: wipe.ok` was recorded and never acted on. A failed wipe now quarantines.
- `[medium]` `[patch]` Worktree adoption accepted any directory inside any git repository (`rev-parse --git-dir` succeeding), and reported the *intended* branch regardless of the actual checkout — and story 1-3 resets to `baseline_ref` on that branch, so this was a path to resetting the wrong checkout. Now compares `--git-common-dir`, requires a linked worktree, reports the branch `symbolic-ref` names, and refuses a detached HEAD.
- `[medium]` `[patch]` `writableByUid` could not distinguish 'chowned to 10001' from 'writable by every uid on the box' — it returned true on the other-write bit alone, and the one test that could tell them apart returned early under root. Replaced by `ownershipViolations`, which checks the route the recorded strategy actually claims.
- `[medium]` `[patch]` A corrupt record was skipped silently, so the resource it named became invisible and was reclaimed by nothing — the failure shape AD-32 exists to prevent. Skipping is right for pass liveness; it now surfaces in `summary.failed`. Records that parse but do not match the shape were silent too, and are now reported.
- `[medium]` `[patch]` `src/container/service.ts` repeated the `=`-form blind spot in its own forbidden-flag check, derived from the same table, so `--cap-add=SYS_ADMIN` passed and its `--pid=host`/`--network=host` entries could never fire. Carried over from 1-5's review, where it was correctly left alone as this story's file. Now uses the `firstForbiddenFlag` that round exported. Its `destroy` also ran `rm` without `--force` after a stop, so a container ignoring stop was never destroyed.
- `[medium]` `[patch]` `refusals.push(refusalFor('(reclamation)', ...))` put a literal non-run string into a field documented as holding run ids, and any consumer building `runs/<run>/` from it hits the same `UnsafePathSegmentError` as the stray-directory finding. `RunRefusal` gained a `scope` and pass-scoped refusals use an empty run. The summary's `failed` list was surfaced by nothing and is now reported per resource.
- `[medium]` `[patch]` The live wipe test verified nothing: its comment promised data and the code asserted `definition.wipe.length > 0`, so CAP-11's central claim would have passed against an empty instance — and it sat inside a `skipIf` that had never run. It now writes real keys into two redis databases, asserts residue before the release, and re-probes after. It ran green against a real `redis:7.4-alpine`.
- `[medium]` `[patch]` Warm reuse had no readiness re-verification anywhere — removing the readiness wait for a reused instance kept every test green, because the double answered ready on its first call and no other test reused a warm instance. A reused instance could then be handed out as an endpoint while not serving.
- `[medium]` `[patch]` The emptiness probes verified less than the wipes cleared: postgres saw only schema `public` of one database while a feature can `CREATE SCHEMA`/`DATABASE`/`ROLE`, and redis's `dbsize` read one database while `flushall` clears sixteen. Both widened. Postgres readiness was also fail-open — `pg_isready -q` prints nothing and `readyWhen` was a negative match, so it returned true for the empty output `-q` guarantees. Now a positive match.
- `[medium]` `[patch]` `SERVICE_LABEL_KEYS` was documented as the sweep's discovery mechanism and nothing swept by it, so a container whose record was lost was unreclaimable by any pass. A label sweep now exists in `service.ts` and reports unrecorded containers into the summary.
- `[medium]` `[patch]` `ReclamationSummary`/`ReclaimedResource` were declared separately on both sides of the seam with nothing asserting they still matched. Compile-time assertions added, so drift fails typecheck rather than a run.
- `[medium]` `[patch]` `realGitRunner` passed no `env`, so an inherited `GIT_DIR`/`GIT_WORK_TREE`/`GIT_INDEX_FILE` overrode the `-C <repo>` targeting and could point `worktree add`/`remove` at another repository. Now sanitised, with a test that poisons `process.env.GIT_DIR`.
- `[medium]` `[patch]` Nothing deleted the `orch/run/<run-id>` branch, so every run left a permanent ref and `branchExists` then silently reused a stale branch if the run id recurred. `removeWorktree` now deletes it, scoped to the `orch/run/` prefix so no other branch can be caught.
- `[low]` `[patch]` Five smaller real defects: an empty repository surfaced as a reference error rather than a refusal naming AD-26's baseline; `repositoryOf` derived the repo by string-stripping an obfuscated `` `${'/'}.git` `` literal that breaks for `--separate-git-dir`; a broken symlink or a path removed mid-walk threw a raw ENOENT instead of a dispositioned error. All direct corrections. (5 findings)
- `[high]` `[defer]` `createWorktree` and `createLeasePool` have no production caller, and no `Reconciler` is constructed anywhere in `src/` — so in production the pass enumerates zero resources and tier 2 has no producer of worktrees. Reported independently by three layers. Same class as 1-5's wiring gap and owned by stage 2; not this story's to fix.
- `[medium]` `[defer]` The label sweep reports rather than destroys, because `SERVICE_LABEL_KEYS` carries no `ORCH_HOME` and AD-30's lock is per home, not per machine — destroying on that evidence would have one engine reclaiming another home's live instances. The invisibility half is closed; the destructive half needs a home-scoped label key, which is new surface rather than a correction.
- `[medium]` `[defer]` Postgres cluster-wide residue is now *reported* but still cannot be *removed*: extra databases and roles are outside what the wipe can reach, so such an instance is quarantined for a person rather than handed on. Fail-closed and consistent with `deferred[4]`, but the wipe is narrower than the probe.
- `[maybe-false]` `[defer]` Nine service-definition claims inherited from 1-5's triage, including whether `REDIS_ARGS` is read at all by the official image and whether `SERVICE_USER` matches its tooling. The redis path is now exercised against a real image by the rewritten wipe test, which settles part of it; the rest needs a real postgres run. If true each is medium, none high. (9 findings)
- `[false]` `[reject]` Two claims that mutual exclusion was at risk for the recorder and engine claims. The create decides and is atomic; what was broken was naming the holder, which story 1-12 already fixed. Refuted at the cited lines. (2 findings)
- `[false]` `[reject]` `CONTAINER_SUBCOMMANDS` has no `stop`, and `reconcilerReclamation` takes no pool. Both false as stated: `stop` is declared for `service.ts`, and `ReclamationPassOptions` has `pool?: LeasePool`. The substantive points behind them — a running container was unreclaimable, and no call site supplies a pool — were real and are handled above and in the wiring deferral.
- `[low]` `[reject]` Eleven hardening suggestions on inputs no caller can supply: a `requestedTier` outside 0..2, a warm `container_name` that is not a safe segment, an image reference that is uppercase or digest-shaped, and similar. The callers are typed and internal, and each fix adds a branch guarding state never demonstrated reachable. (11 findings)
- `[low]` `[reject]` Six cosmetic observations already true or already corrected elsewhere in this round — stale comment wording, a regex that is text-shaped rather than semantic, and the note that the crash-injection harness does not reach the new reclamation boundaries (true, and the reason the story's own Auto Run Result gives for the unchanged boundary count). (6 findings)

## Design Notes

**Worktree ownership is the obligation story 1-5 handed over, and its own probe cannot catch a failure.** Story 1-5 mounts the worktree into a container running as uid 10001 and chmods its own temp directories so that its assertion suite tests the mount rather than the host uid map. That means a worktree created writable only by the host user would pass every existing test and fail on the first real tier-2 run. Assert the mode here, in this story, against a real directory.

**`git worktree remove` refuses a dirty worktree, and `--force` would discard a step's work.** AD-26 makes a step's effects recoverable by resetting to a baseline, not by deleting them. A removal that forces past uncommitted changes destroys evidence that a re-run would otherwise reproduce. Removal happens only at a terminal disposition, where the work is either committed or deliberately abandoned — so the refusal is a signal worth surfacing rather than overriding. Decide, and record the decision in the Spec Change Log either way.

**Reclamation must be a decision, not an effect.** The temptation is to reclaim in a `finally` around a run, which reads as tidy and is exactly what AD-32 forbids: a crash skips it, and the stranded container is invisible. The shape that satisfies the constraint is a pure comparison — live resources on one side, run state on the other — that returns what should be reclaimed, with the acting done by a caller the reconciler drives. That also makes it testable without a daemon: the comparison is assertable, only the acting needs a runtime.

## Verification

**Toolchain:** the PATH default `node` on this machine is v22.14.0, below the declared floor. Use the nvm-installed Node 24.x LTS by absolute path:

```
export PATH="/Users/deep/.nvm/versions/node/v24.21.0/bin:$PATH"   # node v24.21.0, npm 11.19.0
```

The container runtime CLI is installed (29.7.2) but its daemon is unreachable; `docker info` fails. Report which state the suite ran in, exactly as story 1-5 does.

**Commands:**
- `npm run typecheck` -- expected: exit 0
- `npm run lint` -- expected: exit 0
- `npm test` -- expected: exit 0; the pool suites present, with anything needing a real runtime visibly skipped
- `npm run build` -- expected: exit 0
- `npx vitest run tests/engine.crash-injection.test.ts` -- expected: still converges on every discovered boundary
- `grep -rniE "docker|podman|containerd" src/pool/` -- expected: no match
- `grep -rn "from '\.\./" src/pool/` -- expected: only `../contracts/`, `../runtime/` and `../container/`

## Auto Run Result

**Status: done, reviewed.** The four-layer review ran on 2026-09-21 as a follow-up pass on a `done` spec.
55 claims were filed, grouped into 33 triage rows; 25 entries were patched, 4 deferred with owners named, the
rest rejected. The suite went 1300 -> 1346 tests across 51 files, zero skips, zero failures, with the live
redis suite running against a real `redis:7.4-alpine` rather than skipping.

**Four high findings, and the first is a sandbox escape.** `makeWritableByExecutorUid` followed symlinks out
of the worktree: `walk()` pushed every entry and gated only *descent* on the Dirent, then `chmod`/`chown` were
applied to each collected path, and both follow symlinks. I demonstrated it — a worktree holding one symlink
to an outside file took that file from `-rw-------` to `-rw----rw-`. The reachable form needs no root, because
the non-root branch ORs the other-write bit; the root branch is worse, chowning arbitrary host files to uid
10001, the executor's own uid, which hands the confined party write access outside its sandbox. A step agent
authors repository content, so a committed symlink is the lever. After the fix my probe leaves the target at
`-rw------- 501:0`.

The other three: one stray directory under `worktrees/` threw `UnsafePathSegmentError` before anything was
enumerated, switching off *all* reclamation on every pass — the invisible-leak state AD-32 exists to prevent,
caused by a directory nobody would think twice about. A quarantined instance was destroyed by the next pass,
contradicting this story's own `deferred[4]` contract whose entire purpose is preserving evidence for a human.
And a warm instance could be leased twice, because `rmSync(..., { force: true })` swallows ENOENT, so two
concurrent claims both won — breaking this story's own criterion that two runs of one kind never see each
other's data.

**Files changed:** `src/pool/{worktree,lease,reclaim}.ts`, `src/container/{service,flags,runtime}.ts`,
`src/engine/reconciler.ts`, and four test suites.

**Three mutations, all caught, and I re-ran two of them myself** rather than accepting the patch round's word:
reverting the symlink guard makes the outside file `0o606` again and fails two tests; reverting the
stray-directory filter makes the pass throw before enumerating; reverting the quarantine exclusion has the
pass destroy the quarantined container.

**A pattern worth recording, because it recurred.** Three separate checks in this story verified something
adjacent to what they claimed: `writableByUid` could not tell "chowned to uid 10001" from "writable by every
uid on the box"; worktree adoption reported the *intended* branch rather than the actual checkout, which is
what story 1-3 resets on; and the live wipe test's comment promised written data while the code asserted a
list's length. Each read as a check and proved nothing. Together with story 1-5's mount allow-list validating
against its own caller's input, that is four instances in two stories.

**Residual risk, and why `followup_review_recommended` is true.** Four high entries were patched, which sets
the flag. The specific unverified risk: the atomic warm-claim, the claims directory and the idle sweep are new
durable state in a module whose crash-safety is its reason for existing, and the crash-injection harness does
not reach reclamation boundaries — so their behaviour under a real kill is asserted by hand-built disk state
rather than by an injected kill. That is the same structural gap the alignment layer named, and it closes when
the reclamation port is wired into the harness.
