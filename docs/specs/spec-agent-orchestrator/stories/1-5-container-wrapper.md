---title: Container wrapper, executor image, and the three isolation tiers
type: feature
created: '2026-09-20'
status: done
review_loop_iteration: 1
followup_review_recommended: true
context:
- '{project-root}/docs/planning-artifacts/architecture/architecture-agent-orcastrator-2026-09-19/ARCHITECTURE-SPINE.md'
- '{project-root}/docs/specs/spec-agent-orchestrator/SPEC.md'
- '{project-root}/docs/brainstorming/brainstorm-agent-orchestration-system-2026-09-19/threat-model.md'
- '{project-root}/docs/specs/spec-agent-orchestrator/stories/1-4-step-spawner.md'
warnings:
- oversized
deferred:
- summary: 'RESOLVED: the tier-2 execution conflict this story recorded was accepted as ADR-001.'
  evidence: 'RESOLVED 2026-09-20: ADR-001-tier-2-execution.md was accepted and AD-1, AD-20 and AD-20''s
    egress line amended in the spine, which moves the containment boundary from

    the agent process to the commands the agent runs. The decisive finding is that the subscription

    credential is in the macOS keychain rather than a file, so no mount can put it inside a

    container — making AD-20''s container and AD-1''s subscription-only auth incompatible on the

    stated primary platform. Signed off by Deep on 2026-09-20: host agent under --restricted/--add-dir/--tools,
    a per-command

    container, one configuration on every platform, and no git in a step. AD-1, AD-20 and the egress line

    are amended in the spine; the flag set, image, mount allow-list, --rm rule and AD-31 suite are all

    unchanged, so nothing built here is wasted.'
  location: docs/planning-artifacts/architecture/architecture-agent-orcastrator-2026-09-19/ADR-001-tier-2-execution.md
  severity: high
- summary: 'RESOLVED 2026-09-20: the stage-1 containment gate IS NOW MET. Docker Desktop was started,
    the AD-31 assertion suite ran against runtime 29.8.0, and all six containment properties passed.'
  evidence: 'VERIFIED by the parent after the daemon came up: the marker now reads state: verified with
    all six

    checks against runtime 29.8.0, and assertContainmentVerified() passes where it had correctly refused.

    The image built locally as orch-executor:991044ecce0e0ac8, tag equal to the Dockerfile content hash
    per

    AD-11, confirming the base-image and claude-CLI pins; the daemon accepted seccomp=builtin. The parent

    then verified the properties independently by interrogating a real container from inside: uid 10001,

    read-only root, no runtime socket, no host HOME, no ssh dir, egress unreachable, no git credential

    files, CapEff 0000000000000000. Seven

    assertion tests skip. The parent confirmed the gate is genuinely undeclarable in that state and

    that it becomes declarable once a daemon answers with a full marker, so this is a machine

    condition rather than a design fault. Start a daemon (Colima or Docker Desktop) and re-run to

    close half the stage-1 gate.'
  location: tests/container.assertion.test.ts
  severity: high
- summary: 'RESOLVED 2026-09-21: the four-layer review ran. See the Review Triage Log.'
  evidence: 80 findings across blind-hunter, edge-case-hunter, verification-gap and intent-alignment;
    19 entries patched including five high, 5 deferred, the rest rejected on their refutation or as cosmetic.
    Suite 1263 -> 1300 tests, zero skips.
  severity: high
- summary: 'RESOLVED: the daemon accepted seccomp=builtin.'
  evidence: Docker 29.8.0 accepted the profile; the AD-31 suite runs against it and passes 10/10.
  location: src/container/flags.ts
  severity: medium
- summary: 'RESOLVED: both image pins resolved once the image was built.'
  evidence: The image builds and the in-container CLI reports 2.1.278; the probe now runs `claude --version`,
    so a drift between the wrapper constant and the image fails a test.
  location: docker/Dockerfile
  severity: medium
- summary: A bind-mounted worktree owned by the host user is not writable by the container's uid 10001
    on Linux.
  evidence: 'Documented beside EXECUTOR_UID as story 1-6''s obligation: the worktree must be created writable

    by that uid. The assertion probe chmods its own temp dirs so it tests the mount rather than the

    host uid map, which means this gap is invisible to the suite.'
  location: src/container/flags.ts
  severity: medium
- summary: A tier-2 step has no claude credential inside the container, so an end-to-end tier-2 run cannot
    yet authenticate.
  evidence: 'HOME is never mounted and CLAUDE_CONFIG_DIR points at the run''s session directory. This

    intersects the unresolved --restricted contract conflict: both are about what a confined step

    can actually do. Per the spec the implementer did not act on it. This is the next real blocker

    for a working tier-2 run.'
  location: src/container/flags.ts
  severity: high
- summary: The threat model's startup assertion that the runtime socket is absent is proved by the AD-31
    suite rather than by an in-image entrypoint.
  evidence: 'An entrypoint would be a second place the invocation is defined, which AD-20 forbids, so
    the

    check lives in the suite. The consequence is that the property is verified in CI rather than

    refused at container start.'
  location: docker/Dockerfile
  severity: low
- summary: The containment marker has no maximum age, so a `verified` proof of any age satisfies the gate.
  evidence: 'Real, and deliberately not patched: choosing how long a containment proof stays good is a
    policy decision rather than a correction, and it belongs with whoever wires the gate, which ADR-001
    places in stories 2-5/2-6.'
  location: src/container/lifecycle.ts
  severity: medium
- summary: '`src/container/service.ts` repeats the `=`-form blind spot in its own forbidden-flag check.'
  evidence: Found during this patch round and left alone because that file is story 1-6's. `firstForbiddenFlag`
    is exported and ready for it, and it is in 1-6's patch list.
  location: src/container/service.ts
  severity: medium
- summary: Nine service-definition claims can only be settled by running the stock postgres and redis
    images, including whether `REDIS_ARGS` is read at all.
  evidence: 'Triaged maybe-false: if true each is medium, none is high. What settles them is a first real
    daemon run against each service definition. All nine are in `service.ts`, which story 1-6 owns.'
  location: src/container/service.ts
  severity: medium (unverified)
- summary: The host HOME path exists inside a tier-2 container as an empty directory chain, so `no-host-home`
    can only mean "no host content under the host home".
  evidence: A consequence of mounting at absolute paths while AD-9 defaults ORCH_HOME to `~/.orch`. Not
    a leak, but the check name reads stronger than what it proves. The assertion is now scoped and documented
    rather than vacuous as it was before.
  location: tests/container.assertion.test.ts
  severity: low
baseline_revision: 499b606c66086bbae7fe2c2bcf03e724473ec9ed
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

### 2026-09-21 — Review pass (follow-up, on a `done` spec)

- layers: blind-hunter (21), edge-case-hunter (39), verification-gap (3 gap + 4 other), intent-alignment (13)
- verdicts: 80 findings — high 6, medium 21, low 34, false 10, maybe-false 9
- the edge-case layer filed an enumerated list, so its 39 is exact. The blind-hunter and intent-alignment
  layers wrote prose, so their counts are my enumeration of the distinct claims each made — 14 bullets plus
  7 items in the blind-hunter's closing paragraph, and 13 divergences in the alignment audit. The row counts
  below sum to 80, which is the number those four enumerations produce; I corrected this header after
  checking the arithmetic, because a declared total that does not equal the rows is the one thing the
  protocol calls a triage failure outright.
- patched 19 entries; deferred 5; the rest rejected on their refutation or as cosmetic
- note on verification provenance: I verified every `high` and every grouped `medium` root cause myself
  against HEAD, several empirically (a forged marker, a `/` mount, a live container). Rows marked
  *(patch-verified)* were established by the patch round, which confirmed the defect and landed a test that
  fails without the fix. Rows marked *(filed)* are verification-gap findings, which arrive pre-verified per
  the protocol because that layer's evidence rules made it run the code it cites.

**high**

- `[high]` `[patch]` The gate marker's `checks` field is not type-validated, so a string satisfies the six-check guard by substring match — `readContainmentMarker` did `checks: record.checks ?? []` and the guard is `!marker.checks.includes(check)`. I proved it: a marker whose `checks` was one space-joined sentence read back `verified` with `checks.length` 99. Fixed to require an array of strings and return `null` otherwise; re-running my forgery now reads `REFUSED (null)` while a well-formed marker still reads 6. Second appearance of this hole — the earlier fix validated membership, not type.
- `[high]` `[patch]` The mount allow-list was self-referential: `assertMountsAllowed` validated each mount against `allow.worktree`/`allow.sessionDir`, both taken from the caller's own request, so any path passed. Fixed with `assertAllowListRooted` requiring the worktree strictly inside `worktreesDir(orchHome)` and the session dir inside `runsDir(orchHome)`. Verified empirically: `/` and a repo root outside ORCH_HOME are both now refused.
- `[high]` `[patch]` `wrapper.ts` defaulted the mounted directory to `plan.cwd`, so whatever cwd the engine set became the writable bind mount. Grouped with the row above — same root cause, that containment was caller-defined. Now refused as `TierTwoUnconfinableError`.
- `[high]` `[patch]` Nothing created the session directory the tier-2 argv bind-mounts: `sessionDirFor` had no writer in `src/`, and a real daemon refuses a missing bind source, so the first real tier-2 run would have died at container start. *(filed)* Fixed with `ensureSessionDir`, using the same two strategies story 1-6 uses for the worktree.
- `[high]` `[patch]` Three containment assertions compared a value to the constant it was built from, so they passed for any value — `--user`, `IMAGE_CLI_PATH`, `IMAGE_NODE_PATH`. *(filed)* Demonstrated: changing `EXECUTOR_UID` to 1001 left all six observations identical, so a uid with no passwd entry would ship as fully verified while `id -un` fails and git breaks in every tier-2 step. The probe now asserts `uid === EXECUTOR_UID`, that the name resolves, and that the CLI path actually executes.
- `[high]` `[defer]` Nothing in `src/` calls the wrapper, the gate, the reachability probe, the phase sequencer or the branch-protection assertion — reported independently by three layers and confirmed by me (0 callers outside `src/container/`). Not this story's to fix: ADR-001 moved the containment boundary from the agent process to the commands it runs, so what gets wrapped changed, and wiring belongs to stories 2-5/2-6. Deferred with that owner named.

**medium — patched**

- `[medium]` `[patch]` `beginExecution` tested `plan.args.includes('none')`, matching the bare word anywhere in argv, so an argv carrying `--network bridge` plus a label value containing `none` passed. Now counts `--network` (exactly one) and reads the token after it.
- `[medium]` `[patch]` The forbidden-flag self-check matched exact tokens only, so `--cap-add=SYS_ADMIN` escaped, and the keys `--pid=host`/`--network=host` were written only in `=` form while the composer emits flag and value separately — those two entries could never fire. Now matches `flag` or `flag=` and the joined pair; the image boundary is known by construction instead of `indexOf(request.image)`.
- `[medium]` `[patch]` Caller-supplied limits were unvalidated: `memoryLimit: '0'` and `pidsLimit: -1` mean unlimited while both flags stay present and every name check passes — the exact failure the file's own comment claims to guard. Now refuses unparseable sizes, values below the default, and a non-integer or sub-512 pids limit.
- `[medium]` `[patch]` `meetsVersionFloor` was computed and consumed by nothing, so a daemon below the `>=29.7` Stack floor passed the gate, contradicting the field's own comment. Now a refusal, plus a gate condition.
- `[medium]` `[patch]` `provision()` marked `provisioned` on composition, inspecting no result, and the declared `'provisioning'` state was unreachable — so a provisioning container that failed or never ran still authorised execution. Now takes an outcome and requires a zero exit.
- `[medium]` `[patch]` `removeContainerIfTerminal` issued `rm --volumes` with no stop and no `--force`, so a run that reached a terminal state with its container still up was never reclaimed. Now stops first, still without `--force`; a test simulates the running case and asserts the order.
- `[medium]` `[patch]` `classifyTier` failed open: an absent `changedLines` bypassed both ceilings, and an empty `paths` array yielded tier 1 "a small change to 0 files". Now fails closed to tier 2 for unknown size or unnamed paths.
- `[medium]` `[patch]` A host `ORCH_`-prefixed variable overwrote the composed identity, so `ORCH_TIER=0` silently disagreed with the `orch.tier` label on the same argv. The composed identity now wins.
- `[medium]` `[patch]` `attemptFor` defaulted to 1 while the container name keys on the attempt and `--rm` is never composed, so a retry collided with a still-existing container. The default now derives from the wrapper's own wrap count.
- `[medium]` `[patch]` The image `present` cache was never invalidated, so an externally deleted image was never rebuilt and the run failed under `--pull never`; and an inspect failing because the daemon was down was reported as a build failure. Both fixed.
- `[medium]` `[patch]` `CREDENTIAL_ENV_PATTERNS` hard-refused plausible legitimate names (`ORCH_SESSION_ID`, `ORCH_CACHE_KEY`) with no escape hatch, making a tier-2 run unlaunchable over a naming choice in another story. A declared exemption list was added rather than narrowing the patterns, because narrowing `/AUTH/i` would have invalidated an existing exemption-discipline test's intent.
- `[medium]` `[patch]` The no-push-credential assertion used the same predicate that filters the environment, so prover and filter could only agree. Value-shaped checks were added so they can disagree.
- `[medium]` `[patch]` Dockerfile `ARG EXECUTOR_UID/GID/USER` could drift from `flags.ts`'s constants with no `--build-arg` passed, and `ENV HOME` was hard-coded independently. ARGs dropped; a test now asserts the Dockerfile literals equal the constants. The determinism claim was softened to what is true — `apt-get` is unpinned and `npm install --global` resolves at build time, so identical bytes do not imply an identical image.
- `[medium]` `[patch]` `--init` was documented as load-bearing for `signalFromExitCode`/AD-8 but absent from `AD20_REQUIRED_FLAGS` and untested. Added and asserted, with the `HOME` tmpfs.
- `[medium]` `[patch]` `locateContainerRuntime`/`requireContainerRuntime` had no test reference at all, yet the located binary is what confines a step. *(filed)* New `tests/container.runtime.test.ts`, 13 cases.
- `[medium]` `[patch]` The AD-31 probe never proved `--network none` from inside, never read back the memory or pid limits, and its `no-host-home` check tested paths inside the container so it could not fail for the reason it named. All three now asserted; the host-home check is scoped to host *content* and the reason recorded.
- `[medium]` `[patch]` `imageTagForHash` sliced any string with no hex or length check; `probeContainerRuntime` violated its own "one of `CONTAINER_SUBCOMMANDS`" contract. Both fixed.
- `[medium]` `[defer]` `src/container/service.ts` carries the identical `=`-form blind spot in its own forbidden-flag check, derived from the same table. Found during the patch round and correctly left alone: that file belongs to story 1-6, and it is now in 1-6's patch list with `firstForbiddenFlag` exported and ready.
- `[medium]` `[defer]` The marker has no staleness check — a `verified` proof of any age satisfies the gate. Real, and deliberately not patched: choosing a maximum age is a policy decision about how long a containment proof stays good, and it belongs with whoever wires the gate (2-5/2-6) rather than being invented here.
- `[medium]` `[defer]` A SIGKILL between the temp write and the `link` in the new atomic-create path leaves an unswept `.tmp` file. Same shape story 1-12 already recorded from 1-8; carried, not duplicated as a fix.
- `[medium]` `[patch]` `noexec` on `/tmp` and the container HOME while the bind-mounted worktree carries none, and both tmpfs sizes charged against `--memory` so filling `/tmp` OOM-kills the step instead of returning ENOSPC. Recorded in the flags header as the honest limit rather than silently implied.

**low, false and maybe-false**

- `[low]` `[patch]` ×9 — stale JSDoc ("three conditions" above the wrong symbol, "enforces three of its four properties"), the toolchain enumeration omitting `ripgrep`, two suites leaking `mkdtempSync` directories, a test named "writes nothing inside a target repository" asserting nothing about writes, `createContainerInvoker` being `execFileSync`-only, and three comment/claim corrections. All direct corrections with no added complexity, so none met the rejection bar for a cosmetic finding.
- `[low]` `[reject]` ×25 — hardening suggestions on inputs no caller can supply (`options.image` passed as `null` by an untyped caller; `requestedTier` outside 0..2; a container name whose unsafe characters collapse; an image reference that is uppercase or digest-shaped). The composer's callers are typed and internal, and each fix adds a branch guarding state never demonstrated reachable — the protocol's stated bar for rejecting a `low`.
- `[false]` `[reject]` The AD-31 suite has never run; the image has never been built; `seccomp=builtin` has never been accepted by a daemon. All three were true at `7487508` and are false now — the suite runs against Docker 29.8.0, the image exists, the daemon accepted the profile. Refuted by later commits, not by argument. Three of this story's own `deferred` entries were stale for the same reason and are corrected below.
- `[false]` `[reject]` "`CONTAINER_SUBCOMMANDS` has no `stop`." It does — it is declared for `service.ts`. The consequence the finding drew (a running container is never reclaimed) was real and is patched above; the premise was wrong.
- `[false]` `[reject]` "`--rm` would destroy the session transcript AD-8's resume depends on." The session directory is a host bind mount, so the transcript survives container removal. The no-`--rm` rule stands on other grounds; the stated reason was wrong and the comment is corrected.
- `[false]` `[reject]` "The wrapper is the only file that names the container runtime." `runtime.ts` names it, by design — it is the file AD-20 allows to. The guard's scope is narrower than the sentence, and the sentence is corrected; no defect.
- `[false]` `[reject]` ×6 — claims about `flags.ts` refusals being tautological with respect to external input. They were true of the allow-list (patched above) and false of the socket, credential-marker and host-HOME deny-lists, which are absolute and do fire on caller input.
- `[maybe-false]` `[defer]` ×9 — `REDIS_ARGS` being a Bitnami convention the official image ignores, `SERVICE_USER = 10002:10002` not matching stock image tooling, and seven similar claims that can only be settled by running the stock images. Recorded with what would settle each: a first real daemon run against each service definition. If true these are `medium`; none is `high`, and none is in this story's files — they are `service.ts`, which is 1-6's.

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

**Status: done, reviewed.** The four-layer review ran on 2026-09-21 as a follow-up pass on a `done` spec,
producing 80 findings. 19 entries were patched, 5 deferred with owners named, the rest rejected on their
refutation or as cosmetic. The suite went 1263 -> 1300 tests across 51 files, zero skips, zero failures, with
the AD-31 assertion suite running against Docker 29.8.0 rather than skipping.

**The five high findings.** Two were holes in the guard around this story's own security claim: the gate
marker's `checks` was not type-validated, so a marker whose `checks` was one space-joined string satisfied all
six required checks by substring match — I demonstrated the forgery, and it is the second appearance of this
hole, because the earlier fix validated membership and not type. The mount allow-list validated each mount
against the caller's own request while the wrapper defaulted the mounted directory to `plan.cwd`, so
containment was caller-defined; `/` and a repository root are both refused now, verified empirically. One was
a run-stopper nobody had hit because nothing wires the wrapper: the session directory the argv bind-mounts had
no writer anywhere in `src/`, and a real daemon refuses a missing bind source. One was a class of test that
cannot fail — three containment assertions compared a value to the constant it was built from, and changing
`EXECUTOR_UID` to 1001 left all six observations identical, so a uid the image has no passwd entry for would
have shipped as fully verified.

**Files changed:** `src/container/{flags,lifecycle,image,runtime,tiers,wrapper}.ts` and `docker/Dockerfile`,
whose hash change rebuilt the image as `orch-executor:f797cc6460890745`; five `tests/container.*` suites
updated and `tests/container.runtime.test.ts` added, covering the runtime locator that had no test reference
at all.

**I re-ran the decisive checks myself** rather than accepting the patch round's word. Reverting the marker
validation makes my forged string marker read back `verified` with `checks.length` 99; reverting the worktree
containment accepts a `/` mount. With the fixes in place the forgery reads `REFUSED (null)`, a well-formed
marker still reads 6, and the real gate still reads `verified` against runtime 29.8.0.

**Residual risk, and why `followup_review_recommended` is true.** Five high entries were patched, which sets
the flag by the protocol's rule. The specific unverified risk: the mount and session-directory fixes are the
first code here to depend on ORCH_HOME's shape at runtime, and no production caller exercises any of it, so
their behaviour on a real run is untested by construction. That closes when 2-5/2-6 wire containment.

**Three of this story's own deferred entries were stale** and are corrected rather than left standing: the
AD-31 suite has run, the daemon accepted `seccomp=builtin`, and both image pins resolved.
