---
name: 'Tier-2 execution: what a confined step can actually do'
type: architecture-decision-record
status: accepted
created: '2026-09-20'
decides:
  - AD-1
  - AD-20
raised-by:
  - 'story 1-4 review (the --restricted / CAP-13 conflict)'
  - 'story 1-5 (no credential inside the container)'
  - 'story 1-6 (no network to the leased service; no git in the worktree)'
supersedes-nothing: true
---

# ADR-001 — Tier-2 execution: what a confined step can actually do

**Status: accepted 2026-09-20 by Deep.** All four proposals were accepted as recommended, and AD-1, AD-20 and
AD-20's egress line have been amended in `ARCHITECTURE-SPINE.md` accordingly. Stories 1-4, 1-5 and 1-6 each carry a deferred entry pointing at it.

## The problem, stated once

Stage 1 built the containment AD-20 specifies, and it works. But four separate stories each discovered,
independently, that a step confined exactly as AD-1 and AD-20 require cannot do its job. Each component is
correct against its own contract; the contracts are jointly unsatisfiable.

| A tier-2 step cannot… | Because | Verified |
|---|---|---|
| run tests, lint or typecheck | `--restricted` removes Bash and every code-running tool "unless `--tools` names them", and AD-1 mandates `--restricted` on every spawn while nothing passes `--tools` | CLI 2.1.278 help text; `grep` for `--tools` in `src/engine/` returns nothing |
| authenticate to Claude | AD-20 forbids mounting `HOME`, and the subscription credential is **not a file** | no `~/.claude/.credentials.json` exists; the credential is in the macOS keychain |
| reach the database it leased | execution runs `--network none` (AD-20) while a leased service publishes on loopback | story 1-6, `src/container/service.ts` |
| run git in its own worktree | `git worktree add` writes `.git` as a *file* pointing at `<repo>/.git/worktrees/<name>`, and a commit writes objects into `<repo>/.git/objects` — both outside the one directory AD-20's allow-list admits | measured directly: the `.git` file's `gitdir:` line, and objects landing in the repo's store |

The root cause is single: **AD-20 specifies what a step may not reach and never states what it must still be
able to do.** CAP-13 requires deterministic gates to run; AD-1 requires subscription auth; CAP-11 promises a
usable database. Nothing reconciles those with the flag list.

## The finding that changes the shape of the question

The credential is the one that is not a matter of widening an allow-list. On this machine there is no
credential file to mount — `~/.claude/` holds history and caches, and the subscription credential is in the
macOS keychain. A container cannot mount a keychain.

So the choice is not "which paths do we admit." It is:

> **AD-20's container and AD-1's subscription-only authentication are incompatible on macOS, which
> `SPEC.md` names as the primary development platform.**

Every resolution that keeps `claude -p` *inside* the container has a real cost: export the long-lived
credential to a mounted file (weakening the thing AD-21 exists to protect), or make tier 2 Linux-only
(contradicting the stated platform), or abandon subscription auth (forbidden by AD-1, which refuses API-key
mode positively).

## Decision

**Move the containment boundary from the agent process to the commands the agent runs.**

The container stops being "the thing the step agent runs inside" and becomes "the thing the step agent's
Bash tool runs inside". Concretely:

1. **`claude -p` runs on the host**, confined at the configuration level: `--restricted` (which ignores user,
   project and local settings files, confines the file tools to the working directories, refuses
   `bypassPermissions`, and requires approval for writes to settings, git and tool-configuration files),
   plus `--strict-mcp-config`, plus `--add-dir` scoped to the run worktree, plus `--tools` naming exactly
   what that agent is granted.
2. **The step's command execution happens in the container.** Arbitrary code — `npm install`, a test suite,
   a build script — is what actually needs a read-only root, dropped capabilities, seccomp, pid and memory
   limits and no egress. That code, not the agent, is the untrusted party.
3. **`--tools` is driven from AD-17's existing per-agent tool grant.** AD-17 already requires each
   `.orch/agents/<id>.toml` to declare "its granted tools and MCP domains", and `permissions.toml` already
   declares "granted tools". Nothing new is introduced: an existing declared field is wired to an existing
   CLI flag. Analysis and planning agents get read tools; implementation gets the edit tools; testing and the
   committer get Bash.
4. **A run-scoped container network replaces `--network none` for the commands that need it.** The leased
   service joins it and the command container joins it. There is still no route to the internet, so AD-20's
   egress intent is preserved — it was about reaching the network, not about reaching one's own database.
5. **Steps do not run git; the engine does, on the host.** This is already what AD-15 requires — "agents
   never write; the engine executes an enumerated write surface" — and what stories 1-3 and 1-6 already do.
   Making it explicit is cheaper and safer than widening the mount to `<repo>/.git`, which is the whole
   repository.

### Why this is the right shape rather than a workaround

The threat model's containment layer exists because a step agent runs code nobody reviewed. It does not exist
because Claude Code might edit a file outside the worktree — `--restricted` plus `--add-dir` already bounds
that, and the engine re-parses every output against a schema before accepting it. Putting the container
around the agent confines the wrong party at the wrong layer, which is why four separate stories each hit a
wall. Putting it around command execution confines the party that is actually untrusted, and every one of the
four blockers dissolves rather than being negotiated.

## What this changes in the spine

- **AD-1** gains `--tools`, sourced from the agent's AD-17 declaration, and gains a statement that the spawn
  happens on the host with `--add-dir` scoped to the run worktree.
- **AD-20** changes subject: the wrapper still owns every container invocation and every flag, and the flag
  set is unchanged, but the thing placed inside the boundary is a command, not the agent process. The
  credential deny-list stays exactly as it is — and now costs nothing, because nothing inside the container
  needs to authenticate to Claude.
- **The stage-1 gate is unaffected in substance**: "the executor container is verified to hold no push
  credential" remains the property, and story 1-5's AD-31 assertion suite still proves it. What it confines
  is narrower and more honest.

## Consequences accepted

- A step agent can read the repository from the host, so a compromised or confused agent can read files
  outside the worktree even though it cannot write them. This is a real reduction in confinement versus the
  original design, and it is the price of the credential being un-mountable.
- `--tools` is now load-bearing security configuration. A roster entry that grants Bash grants the ability to
  run commands — inside the container, but still. AD-17's per-agent grant becomes something to review.
- A step cannot inspect its own diff with git. If that turns out to matter, the engine can supply the diff as
  an evidence pointer rather than the step computing it.
- Two containers per run in the common case (a command container, plus any leased service), where the
  original design had one.

## Decided at sign-off

- **Container lifetime: per command.** No lifecycle state to track, nothing to reclaim between commands, and
  1-6's AD-32 sweep stays as built. The cost accepted is container-start latency on every command.
- **One configuration on every platform, including Linux.** One code path rather than stronger confinement
  where the credential happens to be a file. The trade is explicit: the configuration you develop against is
  the same one that ships.
- **A step does not run git.** AD-15 already requires it. If a test suite invokes git — husky, version
  stamping — that is a per-repo profile concern, and the failure is visible rather than silent.

## Open question this ADR still does NOT decide

**Which exact tool names each built-in agent is granted.** The grant lives in AD-17's TOML, and this ADR does
not fill the table in — that belongs with the roster stories, 2-3 through 2-7, where each agent's job is
actually defined. It is now load-bearing security configuration rather than a convenience field: a roster
entry granting `Bash` grants the ability to run commands, contained but real.

## Effect on existing stories

- **1-4** — the `--tools` gap closes; its `deferred[0]` resolves. Its `SpawnWrapper` seam becomes the seam
  for a *command* wrapper rather than the agent, which is a change to what 1-5 supplies, not to 1-4's shape.
- **1-5** — the flag set, the image, the mount allow-list, the `--rm` rule and the AD-31 suite are all
  unchanged and all still correct. What changes is the argv placed inside: a command, not `claude -p`. Its
  "no credential inside the container" deferred entry resolves, because nothing inside needs one.
- **1-6** — the leased service becomes reachable, resolving that deferred entry. The worktree uid-writability
  work stays exactly as built, because commands still run as the container's non-root user against the
  mounted worktree.
- **Stage 2** — this must be settled before 2-5 and 2-6, which are the first stories whose agents actually
  need to run anything.
