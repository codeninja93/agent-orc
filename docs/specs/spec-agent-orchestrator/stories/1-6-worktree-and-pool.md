---
title: 'Worktree lifecycle, leased resource pool, reconcile reclamation'
type: 'feature'
created: '2026-09-20'
status: 'in-review'
review_loop_iteration: 0
followup_review_recommended: true
context:
  - '{project-root}/docs/planning-artifacts/architecture/architecture-agent-orcastrator-2026-09-19/ARCHITECTURE-SPINE.md'
  - '{project-root}/docs/specs/spec-agent-orchestrator/SPEC.md'
  - '{project-root}/docs/specs/spec-agent-orchestrator/stories/1-5-container-wrapper.md'
  - '{project-root}/docs/specs/spec-agent-orchestrator/stories/1-3-engine-reconciler.md'
warnings: ['oversized'] # 10 files and 14 I/O scenarios; spans git worktrees, leased containers and an AD-32 reconcile pass
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
      A tier-2 step still cannot reach the instance it leases: execution runs with no general network and
      a leased service is published on loopback.
    evidence: |-
      `src/container/flags.ts` composes `--network none` for the execution phase (AD-20), and
      `src/container/service.ts` publishes a leased instance on `127.0.0.1:<port>`. Both are correct to
      their own contracts and they do not meet. Bridging them is the egress work this story's Never list
      assigns to story 2-10; CAP-11 is therefore mechanised end to end for the *host* and not yet for a
      confined step.
    location: >-
      src/container/service.ts
    severity: high
  - summary: >-
      A tier-2 step cannot run git inside its worktree: the worktree's `.git` points outside the one
      directory story 1-5 mounts.
    evidence: |-
      `git worktree add` writes a `.git` *file* naming `<repo>/.git/worktrees/<run-branch>`, and AD-20's
      mount allow-list admits only the worktree and the run's session directory. So a step that commits
      its own work — which the crash fixture's executor does on the host — would fail inside a container.
      Mount discipline is story 1-5's and this story may not widen it, so the gap is recorded rather than
      papered over. A linked worktree is still the right shape; what needs deciding is whether the admin
      directory is mounted or the step commits through the engine.
    location: >-
      src/pool/worktree.ts
    severity: high
  - summary: >-
      On a host where the engine is not root, a worktree is made writable by the executor uid by widening
      its mode rather than by chowning it.
    evidence: |-
      `makeWritableByExecutorUid` chowns when `process.getuid()` is 0 and otherwise sets the other-write
      and other-execute bits, because there is no other way for a *fixed* foreign uid to write a tree this
      process owns. The widening is confined to `ORCH_HOME/worktrees/` and holds a disposable checkout.
      The alternative — passing the host uid to the container — is refused because it would make the flag
      set depend on who ran the engine and story 1-5's suite could no longer assert a fixed non-root user.
      Asserted either way by `unwritablePaths`, which is empty after creation and non-empty before.
    location: >-
      src/pool/worktree.ts
    severity: medium
  - summary: >-
      The two service image pins are unresolved, and a pooled service is a stock image rather than a
      locally built one.
    evidence: |-
      `postgres:17.2-alpine` and `redis:7.4-alpine` are pins nothing has pulled, because no daemon
      answers here. AD-11's build-it-locally rule binds the *executor* image; a leased database is not it,
      and building postgres from a Dockerfile in this repository would be a second image to maintain for
      no isolation gain. A wrong pin surfaces as a failed start, which the lease reports as
      `resource.lease_timed_out` rather than as a hang.
    location: >-
      src/container/service.ts
    severity: medium
  - summary: >-
      A quarantined instance is reclaimed by no pass, by design, so a dirty return leaves a container
      standing until a person acts.
    evidence: |-
      `resource.return_dirty` is declared `escalate-to-human`. Destroying the instance would delete the
      evidence the escalation is about, and reclaiming it would be the pass deciding a question the AD-35
      table assigns to a person. The record under `pool/quarantine/` names the instance and its residue;
      nothing yet renders that, which is story 1-7's surface.
    location: >-
      src/pool/lease.ts
    severity: low
  - summary: >-
      The AD-31 containment gate is still not met on this machine, unchanged from story 1-5.
    evidence: |-
      `docker info` still fails, so the seven container assertion tests skip and this story's one
      daemon-requiring lease test skips with them, through story 1-5's existing probe and marker. No
      second marker mechanism was introduced, and this story wrote no gate marker.
    location: >-
      tests/pool.lease.test.ts
    severity: high
baseline_revision: '7487508adede8190394f060cac16ca3b9184f656'
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

Status: done
Blocking condition: none — but two recorded blockers stand between this and a working tier-2 run with a
leased resource (`deferred[0]` and `deferred[1]`), and the stage-1 containment gate remains unmet on this
machine (`deferred[5]`, unchanged from story 1-5).

**REVIEW WAS SKIPPED** for this story; no review layers ran. The suites and the parent's own greps are the
only scrutiny it received.

**Implemented change.** `src/pool/` (worktree lifecycle, leased resource pool, the AD-32 reclamation pass,
and the surface the engine wires in), plus `src/container/service.ts` for the leased-service flag set and
two additive subcommands in `src/container/runtime.ts`. `src/engine/reconciler.ts` gained exactly one
additive seam: a `reclamation` port invoked first in every `pass()`, its result reported as
`PassResult.reclaimed`, and a durable boundary per resource reclaimed. No existing reconciler behaviour
changed.

**Runtime state: the second of the two.** The container runtime CLI is present (Docker 29.7.2) and its
daemon is unreachable — `docker info` fails. No daemon was started, nothing was faked, and no model call
was spent. Eight tests skip: story 1-5's seven AD-31 assertions and this story's one live-instance lease
test, which skips through the same probe and the same `CONTAINMENT_SKIP_MARKER` and writes no gate marker
of its own.

**Verification.** `npm run typecheck`, `npm run lint`, `npm run build` all exit 0. `npm test` → 26 files,
**784 passed, 8 skipped**. The four new suites are present: `pool.worktree` (17), `pool.lease` (17 + 1
skipped), `pool.reclaim` (38), `container.service` (38). Both spec greps pass: `src/pool/` names no
container runtime and imports only `../contracts/`, `../runtime/` and `../container/`.

**The crash-injection suite still converges, on the same 21 boundaries.** Re-run on its own: 5 passed,
20s. The boundary count was measured directly by driving the harness (`boundaries: 21`), so the "no change
to story 1-3's existing behaviour" clause holds literally — the reclamation port is not wired into the
crash harness, so it adds no boundary there, while `tests/pool.reclaim.test.ts` asserts that a wired
reclamation *does* cross one per resource so a future harness kills at it.

**What the AD-32 rule cost, and how it is held.** Reclamation is a pure comparison
(`decideReclamation`) over live resources and run state, with the acting split into `performReclamation`.
Three independent guards hold the negative property: the comparison is asserted to write nothing (the
`ORCH_HOME` tree is byte-compared before and after), a kill is modelled by putting resources on disk and
building a pass with nothing in memory, and every file in `src/pool/` is read to assert no `process.on`,
no signal or exit handler and no `finally`.
