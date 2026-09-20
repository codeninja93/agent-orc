---
title: 'Container wrapper, executor image, and the three isolation tiers'
type: 'feature'
created: '2026-09-20'
status: 'done'
review_loop_iteration: 0
followup_review_recommended: true
context:
  - '{project-root}/docs/planning-artifacts/architecture/architecture-agent-orcastrator-2026-09-19/ARCHITECTURE-SPINE.md'
  - '{project-root}/docs/specs/spec-agent-orchestrator/SPEC.md'
  - '{project-root}/docs/brainstorming/brainstorm-agent-orchestration-system-2026-09-19/threat-model.md'
  - '{project-root}/docs/specs/spec-agent-orchestrator/stories/1-4-step-spawner.md'
warnings: ['oversized'] # 13 files and 15 I/O scenarios; the AD-20 flag set is dense and the AD-31 assertion suite is half the stage-1 gate
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
      THE STAGE-1 CONTAINMENT GATE IS NOT MET: no container runtime daemon is reachable on this
      machine, so the AD-31 assertion suite has never run.
    evidence: |-
      VERIFIED by the parent: the Docker CLI is 29.7.2 (meeting the Stack's >=29.7) but `docker info`
      fails, so the marker at ORCH_HOME/gates/container-assertion.json reads state: skipped. Seven
      assertion tests skip. The parent confirmed the gate is genuinely undeclarable in that state and
      that it becomes declarable once a daemon answers with a full marker, so this is a machine
      condition rather than a design fault. Start a daemon (Colima or Docker Desktop) and re-run to
      close half the stage-1 gate.
    location: >-
      tests/container.assertion.test.ts
    severity: high
  - summary: >-
      Review was SKIPPED for this story; no four-layer review ran.
    evidence: |-
      Stories 1-3 and 1-4 were each reviewed at the user's request and produced 56 and 60 findings, 22
      and 12 of them high. This story had the gate plus the parent's own probes only. Read status:
      done as implemented and gated, not reviewed — which matters more here than elsewhere, because
      the subject is a security boundary.
    severity: high
  - summary: >-
      The seccomp profile is `builtin` rather than a profile file, and no daemon has accepted it.
    evidence: |-
      Chosen by the implementer so that no ~900-line profile was fabricated. If a daemon rejects the
      value the assertion suite fails loudly rather than passing falsely, but tier-2 runs would not
      start. Verify on the first daemon-reachable run, or point seccompProfile at a real profile.
    location: >-
      src/container/flags.ts
    severity: medium
  - summary: >-
      The image's base tag and the pinned claude CLI version inside it are unverifiable without
      network.
    evidence: |-
      node:24.21.0-bookworm-slim and @anthropic-ai/claude-code@2.1.278 are both pins nothing has
      resolved. A wrong pin surfaces as ImageBuildError on the first build rather than silently.
    location: >-
      docker/Dockerfile
    severity: medium
  - summary: >-
      A bind-mounted worktree owned by the host user is not writable by the container's uid 10001 on
      Linux.
    evidence: |-
      Documented beside EXECUTOR_UID as story 1-6's obligation: the worktree must be created writable
      by that uid. The assertion probe chmods its own temp dirs so it tests the mount rather than the
      host uid map, which means this gap is invisible to the suite.
    location: >-
      src/container/flags.ts
    severity: medium
  - summary: >-
      A tier-2 step has no claude credential inside the container, so an end-to-end tier-2 run cannot
      yet authenticate.
    evidence: |-
      HOME is never mounted and CLAUDE_CONFIG_DIR points at the run's session directory. This
      intersects the unresolved --restricted contract conflict: both are about what a confined step
      can actually do. Per the spec the implementer did not act on it. This is the next real blocker
      for a working tier-2 run.
    location: >-
      src/container/flags.ts
    severity: high
  - summary: >-
      The threat model's startup assertion that the runtime socket is absent is proved by the AD-31
      suite rather than by an in-image entrypoint.
    evidence: |-
      An entrypoint would be a second place the invocation is defined, which AD-20 forbids, so the
      check lives in the suite. The consequence is that the property is verified in CI rather than
      refused at container start.
    location: >-
      docker/Dockerfile
    severity: low
baseline_revision: '499b606c66086bbae7fe2c2bcf03e724473ec9ed'
---

<intent-contract>

## Intent

**Problem:** Story 1-4 spawns a step as an ordinary child process on the host, with a `SpawnWrapper` seam left deliberately empty. Nothing confines a step agent: it can reach `HOME`, ssh keys, cloud credentials and the docker socket, and nothing stops it pushing. Half the stage-1 gate — "the executor container is verified to hold no push credential" — is therefore unmet, and CAP-10's three isolation tiers do not exist.

**Approach:** Add `src/container/`: one wrapper that owns every container invocation and composes the AD-20 flag set, a locally-built executor image tagged by its Dockerfile's content hash, and tier 0/1/2 selection by risk classification. The wrapper is supplied to story 1-4's spawner as its `SpawnWrapper`, so no other unit ever names a container flag. Includes the third and last AD-31 suite.

## Boundaries & Constraints

**Always:**
- One wrapper owns every container invocation. No other unit composes a container flag, and the wrapper is the only file in the repository that names the container runtime.
- The tier-2 container carries the full AD-20 flag set: read-only root filesystem, tmpfs for temporary space, only the run worktree and its session directory mounted, a non-root user, all capabilities dropped, no-new-privileges, a seccomp profile, and memory and pid limits.
- `HOME`, ssh paths, cloud credential paths and the container runtime's own socket are never mounted, and the executor holds no push credential and no production credential.
- `--rm` is never used while a run is live, because it would destroy the session transcript AD-8's resume depends on. Removal happens only once the run reaches a terminal disposition.
- The image is built locally from a Dockerfile in this repository, tagged with that Dockerfile's content hash, rebuilt when and only when the hash changes, and never pulled from a registry.
- A provisioning phase with network access precedes execution and ends before it. Execution itself has no general network access.
- Three tiers exist and are selected by risk classification: tier 0 edits in place with no branch, tier 1 uses a branch and no container, tier 2 uses a worktree plus the container. A container for a README fix is rejected as pure tax.
- Branch protection on the default branch is asserted at run start.
- The container assertion suite proves, against a real runtime, that no push credential and no runtime socket is reachable from inside a tier-2 container. When no runtime is reachable it must skip visibly and leave the stage-1 gate undeclarable — never pass silently.
- `src/container/` imports only from `src/contracts/`, `src/runtime/` and `node:` builtins.

**Never:**
- No changes to `src/engine/spawner.ts` or to the `SpawnWrapper` type. This story supplies a wrapper; it does not reshape the seam. If the seam is wrong, stop and say so.
- No resource pool, no leased postgres or redis, and no worktree creation — story 1-6 owns those. This story takes a worktree path and confines it.
- No egress-allowlist proxy implementation. Execution gets no general network; a proxy for the one domain that needs it arrives with the tool servers in story 2-10.
- No reconciler changes, no renderer, no installer, and no roster configuration.
- Never mount a path the caller did not ask for, and never widen the flag set to make a test pass.
- Never skip the assertion suite in a way that lets `npm test` report success while the gate's containment claim is unverified.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Tier 2 flag set | A tier-2 request for a worktree | The composed argv carries read-only root, tmpfs temp, non-root user, all capabilities dropped, no-new-privileges, seccomp, and memory and pid limits | A missing flag fails the suite |
| Mount discipline | A tier-2 request | Only the worktree and its session directory are mounted | `HOME`, ssh, cloud credential paths and the runtime socket appear in no mount |
| No push credential | A running tier-2 container | No push credential is reachable from inside | Asserted against a real runtime |
| No runtime socket | A running tier-2 container | The container runtime's socket is not reachable from inside | Asserted against a real runtime |
| Live run removal | A tier-2 container whose run is still live | `--rm` is absent and the container is not removed | The session transcript survives for resume |
| Terminal removal | A run that reached a terminal disposition | The container is removed | No error expected |
| Image tag | A Dockerfile at a given content | The tag carries that content's hash | No error expected |
| Dockerfile changed | A Dockerfile whose content changed | The image is rebuilt exactly once for the new hash | No error expected |
| Dockerfile unchanged | A second request at the same hash | No rebuild occurs | No error expected |
| Registry refusal | Any image resolution | Nothing is pulled from a registry | A pull attempt is a defect |
| Provisioning then execution | A tier-2 request needing dependencies | Provisioning has network, execution does not, and provisioning ends first | Execution never runs with general network |
| Tier selection | A typo-shaped change, a small low-risk change, a real feature | Tier 0, tier 1, tier 2 respectively | A tier-2 container is never spun for a tier-0 change |
| Tier 0 and 1 wrapping | A tier-0 or tier-1 request | The spawn plan is returned unchanged; no container is involved | No error expected |
| Runtime absent | No reachable container runtime | The assertion suite skips visibly and the stage-1 gate cannot be declared met | Never a silent pass |
| Unprotected default branch | A run starting against a repository whose default branch is unprotected | Refused, naming the branch | The run does not start |

</intent-contract>

## Code Map

Stories 1-1 through 1-4 shipped `src/contracts/`, `src/runtime/` and `src/engine/`. Story 1-4 left `SpawnWrapper` (`src/engine/spawner.ts`) deliberately unfilled and asserts that no engine file names a container runtime; this story fills that seam from outside `src/engine/`.

- `docker/Dockerfile` -- create; the tier-2 executor image: a pinned base, a non-root user, and the step toolchain. No credential, no secret, nothing fetched at run time
- `src/container/runtime.ts` -- create; the only file that names the container runtime: locating it, checking reachability, and running one invocation. Every other module composes intent, not flags
- `src/container/flags.ts` -- create; the AD-20 flag set as declared data with the mount allow-list, so a test can assert the composed argv rather than trusting prose
- `src/container/image.ts` -- create; the Dockerfile content hash, the derived tag, and build-only-when-the-hash-changes
- `src/container/tiers.ts` -- create; the three tiers and selection by risk classification
- `src/container/wrapper.ts` -- create; the `SpawnWrapper` story 1-4 consumes: wraps a tier-2 plan into a container invocation and returns tiers 0 and 1 untouched
- `src/container/lifecycle.ts` -- create; removal only at a terminal disposition, and the provisioning-then-execution ordering
- `src/container/index.ts` -- create; the surface the engine wires in
- `tests/container.assertion.test.ts` -- create; the third AD-31 suite, against a real runtime: no push credential, no runtime socket, read-only root, non-root user, dropped capabilities
- `tests/container.gate.test.ts` -- create; always runs, and fails if the containment claim is asserted while the assertion suite was skipped
- `tests/container.{flags,image,tiers,wrapper}.test.ts` -- create; argv composition, mount allow-list, hash-derived tags and rebuild behaviour, tier selection, and pass-through for tiers 0 and 1

Read-only evidence, authoritative and not to be edited by this story:

- `ARCHITECTURE-SPINE.md` -- AD-20 (one containment boundary, the full flag list, the `--rm` rule, the credential rules), AD-11 (locally built, content-hash tag, no registry, build is the only networked step), AD-31 (the container assertion suite), AD-9 (`ORCH_HOME` layout); the Stack table's Docker Engine `>=29.7`
- `threat-model.md` -- the containment layer and the minimum guardrail set no unattended run may skip
- `src/engine/spawner.ts` -- `SpawnPlan` and `SpawnWrapper`, and the guard asserting no engine file names a container runtime
- `docs/specs/spec-agent-orchestrator/architecture.md` -- the isolation tier table

Carried forward from stories 1-1 through 1-4:

- **A container runtime is installed here but its daemon is not reachable** (Docker CLI 29.7.2, `docker info` fails). The assertion suite therefore cannot run as things stand, which is exactly why this story must make a skip visible rather than silent.
- Story 1-4's spawner asserts that no file under `src/engine/` names a container runtime, comments included. Keep the name out of `src/engine/` entirely.
- Story 1-4 records a `wrapped` flag and now validates the AD-1 flag set against the **executed** vector, so a wrapper that drops `--restricted` or `--strict-mcp-config` is caught. Do not drop them.
- Story 1-4's `signalFromExitCode` treats exit 128+n as a signal precisely because a container wrapper does not forward its child's signal. A wrapper that swallows or rewrites the exit code breaks AD-8's resume.
- An unresolved contract conflict sits next to this story: `--restricted` strips every code-running tool unless `--tools` names them, so a step agent cannot run tests as specified. One candidate resolution is to rely on this container for containment instead of that flag. **Do not act on that here** — build the container to its own contract; the decision is the user's.

## Tasks & Acceptance

**Execution:**
- `docker/Dockerfile` -- define the tier-2 image with a pinned base, a non-root user and the step toolchain, carrying no credential -- AD-11 forbids a registry image, so the Dockerfile is the whole definition
- `src/container/runtime.ts` -- locate the runtime, report reachability, and own the single invocation path -- AD-20 gives one wrapper sole ownership so the boundary cannot be defined differently in two places
- `src/container/flags.ts` -- express the AD-20 flag set and mount allow-list as data -- a flag list in prose cannot be asserted, and CAP-10's success criterion is a test
- `src/container/image.ts` -- derive the tag from the Dockerfile's content hash and rebuild only on change -- AD-11 makes the hash the identity, so a stale image cannot masquerade as current
- `src/container/tiers.ts` -- classify a request into tier 0, 1 or 2 -- spinning a container for a README fix is rejected as pure tax
- `src/container/wrapper.ts` -- implement `SpawnWrapper`: wrap tier 2, pass tiers 0 and 1 through unchanged -- this is the seam story 1-4 left, and filling it from outside `src/engine/` is what keeps the runtime name out of the engine
- `src/container/lifecycle.ts` -- remove a container only at a terminal disposition, and order provisioning before execution -- `--rm` during a live run would destroy the transcript AD-8 resumes from
- `src/container/index.ts` -- expose the wrapper and the reachability check -- the engine wires this in without learning a flag
- `tests/container.assertion.test.ts` -- prove against a real runtime that no push credential and no runtime socket is reachable from inside -- this is the third of AD-31's three required suites and half the stage-1 gate
- `tests/container.gate.test.ts` -- fail if the containment claim is treated as verified while the assertion suite skipped -- a silently skipped security test is the false green this project has already found five times
- `tests/container.{flags,image,tiers,wrapper}.test.ts` -- assert the composed argv, the mount allow-list, hash-derived rebuild behaviour and tier pass-through -- the flag set is the containment, so it is the thing to test

**Acceptance Criteria:**
- Given a clean checkout on Node `>=22.22`, when `npm run typecheck && npm run lint && npm test && npm run build` is run, then all four succeed and the container suites appear in the test output.
- Given a tier-2 request, when the wrapper composes its invocation, then the argv carries a read-only root filesystem, a tmpfs temporary mount, a non-root user, all capabilities dropped, no-new-privileges, a seccomp profile, and memory and pid limits.
- Given a tier-2 request, when the mounts are inspected, then only the run worktree and its session directory are mounted, and no mount names `HOME`, an ssh path, a cloud credential path, or the container runtime's socket.
- Given a reachable container runtime, when the assertion suite runs a tier-2 container, then no push credential and no runtime socket is reachable from inside it, the root filesystem is read-only, and the process is not root.
- Given no reachable container runtime, when the suite runs, then the assertion tests skip with a visible marker and the gate test fails any claim that containment is verified.
- Given a Dockerfile at some content, when an image is resolved twice with no change between, then it is built once and the tag carries that content's hash; and given the Dockerfile's content changes, then exactly one rebuild occurs.
- Given a container whose run has not reached a terminal disposition, when the wrapper composes its invocation and the run is observed, then `--rm` is absent and the container still exists; and given the run reaches a terminal disposition, then it is removed.
- Given a tier-0 or tier-1 request, when it passes through the wrapper, then the returned spawn plan is identical to the input and no container is created.
- Given a repository whose default branch is unprotected, when a run starts, then it is refused naming that branch.
- Given `src/container/`, when its imports are inspected, then it imports only from `src/contracts/`, `src/runtime/` and `node:` builtins; and given `src/engine/`, then no file there names the container runtime.

## Spec Change Log

## Review Triage Log

## Design Notes

**A skipped security test must not read as a pass.** The daemon is unreachable on this machine today, so the assertion suite cannot run, and AD-31 names it as one of three suites required before any unattended run. The shape that stays honest: the assertion tests skip when no runtime answers, but they record that they skipped, and a separate always-running test fails if anything claims containment is verified while that marker is present. `npm test` may be green for development; the stage-1 gate may not be declared met. Five times in this project a green suite has hidden a deleted guard — this is the one place that failure mode is a security property rather than a correctness one.

**The flag set is the containment, so it has to be data.** AD-20 lists the flags in prose. Prose cannot be asserted, and CAP-10's success criterion is a passing test. Express the set and the mount allow-list as values, compose the argv from them, and assert the composed argv. A test that re-states the flag list it was built from proves nothing; assert the argv the runtime would actually receive, the way story 1-4 learned to assert its executed vector rather than its constant.

**Do not let the wrapper rewrite the exit code.** Story 1-4's `signalFromExitCode` exists because a container wrapper reports a signalled inner process as exit 128+n rather than forwarding the signal. If this wrapper swallows or remaps the exit code, `interrupted` stops being reachable and AD-8's resume becomes dead code — the same failure 1-4's review found at this exact seam, from the other side.

## Verification

**Toolchain:** the PATH default `node` on this machine is v22.14.0, below the declared floor. Use the nvm-installed Node 24.x LTS by absolute path:

```
export PATH="/Users/deep/.nvm/versions/node/v24.21.0/bin:$PATH"   # node v24.21.0, npm 11.19.0
```

A container runtime is installed (Docker CLI 29.7.2, meeting the Stack's `>=29.7`) but its daemon is not currently reachable; `docker info` fails. Report which of the two states the suite ran in.

**Commands:**
- `npm run typecheck` -- expected: exit 0
- `npm run lint` -- expected: exit 0
- `npm test` -- expected: exit 0; the container suites present, with the assertion suite either passing against a real runtime or visibly skipped
- `npm run build` -- expected: exit 0
- `grep -rniE "docker|podman|containerd" src/engine/ src/runtime/ src/contracts/` -- expected: no match outside a comment that names story 1-5
- `grep -rn "from '\.\./" src/container/` -- expected: only `../contracts/...` and `../runtime/...`

## Auto Run Result

Status: done
Blocking condition: none — but the stage-1 containment gate is NOT met on this machine (see `deferred[0]`)

**REVIEW WAS SKIPPED** for this story; no review layers ran. The gate and the parent's own probes are the
only scrutiny it received, which matters more here than elsewhere because the subject is a security
boundary.

**Implemented change.** `src/container/` plus `docker/Dockerfile`: one module that is the only place the
container runtime is named, the AD-20 flag set expressed as data with a positive mount allow-list, an image
tagged by its Dockerfile's content hash and built only when that hash changes, tier 0/1/2 selection by risk,
the `SpawnWrapper` story 1-4 left unfilled, and lifecycle rules for removal-only-at-terminal and
provisioning-before-execution. `src/engine/spawner.ts` and the `SpawnWrapper` type are untouched — the seam
was correct as designed.

**The honest-skip design works, and the parent verified it rather than trusting it.** Probing the gate
directly with forged markers:

| Marker state | Runtime | Result |
|---|---|---|
| `verified`, all checks, correct hash | healthy (injected) | accepted — so the gate is declarable once a daemon exists |
| `verified` | real, dead | refused: "no container runtime answers now" |
| `verified`, wrong Dockerfile hash | healthy | refused: "the proof is about a different image" |
| `failed` | healthy | refused |
| absent | healthy | refused |

**One real defect the parent found and fixed.** A `verified` marker naming only 3 of the 6 required checks
was **accepted**. The writer emits `verified` only when all six pass, but the reader never validated the
list, so it enforced three of its four properties — and the canonical list of check names lived in the test
file rather than in `src/`, which is the drift risk itself. Fixed: `REQUIRED_CONTAINMENT_CHECKS` is now
declared in `src/container/lifecycle.ts`, the assertion suite imports it instead of re-listing it, the
reader refuses any marker missing one, and a regression test covers it. The existing "all three conditions"
test had to be corrected too — its own fixture listed only 4 of the 6 checks, so it had been asserting the
gap. Mutation-verified: disabling the new guard fails the new test.

**Parent verification.** `typecheck`, `lint`, `build` exit 0; `npm test` → 22 files, **674 passed, 7
skipped**. The 7 skips are the AD-31 assertion tests, and the marker records why. Both spec greps pass: no
file under `src/engine/`, `src/runtime/` or `src/contracts/` names a container runtime, and `src/container/`
imports only `../contracts/` and `../runtime/`. Runtime state: the second one — CLI present, daemon
unreachable. No daemon was started and no model call was spent.

**Follow-up review recommended: true** — no review ran, the containment gate is unverified against a real
runtime, and two blockers for a working tier-2 run are recorded above: the container holds no `claude`
credential, and the `--restricted` contract conflict escalated in story 1-4 remains open.
