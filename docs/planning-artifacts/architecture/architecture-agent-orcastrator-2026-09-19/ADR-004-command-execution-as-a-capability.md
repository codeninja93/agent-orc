---
name: 'Command execution is a capability, not a built-in tool'
type: architecture-decision-record
status: accepted
created: '2026-09-22'
decides:
  - AD-20
  - 'ADR-001 item 2 (how a command reaches the container)'
amends:
  - ADR-003
  - ADR-001
raised-by:
  - 'story 2-5 (the first agent that must run a command)'
  - 'ADR-001 line 142 — "this must be settled before 2-5 and 2-6"'
---

# ADR-004 — Command execution is a capability, not a built-in tool

**Status: accepted 2026-09-22 by Deep.**

## The problem, measured

ADR-001 moved the containment boundary from the agent process to the commands the agent runs, and ADR-003
then granted `Bash` to `implementation`, `testing` and `verification` with the justification "`Bash` is how a
gate runs, **inside the container per ADR-001**". That sentence cannot be satisfied as written.

| Fact | How it was established |
|---|---|
| `claude -p` runs on the host | ADR-001 item 1, forced by the credential being un-mountable |
| There is still no mountable credential | `~/.claude/.credentials.json` does not exist on this machine; the subscription credential is in the macOS keychain |
| Claude Code's `Bash` tool executes on the host | it is a built-in of the process, and the process is on the host |
| The CLI offers no redirect | `--restricted` "lets only a person or the configured permission tool" approve a tool use — approve or deny, never *relocate* (CLI 2.1.278 help text) |
| No command-level container path exists | `grep` for a command runner across `src/` returns nothing; `src/container/wrapper.ts` still substitutes the image's own CLI, which is the pre-ADR-001 design |

So a granted `Bash` is a host shell. Every protection AD-20 lists — read-only root, dropped capabilities,
seccomp, no egress — applies to a container that the command never enters.

## Decision

**Do not grant `Bash` to a built-in step agent. Expose command execution as an MCP tool whose server runs
the command inside the container.**

1. `implementation`, `testing` and `verification` lose `Bash` from their AD-17 declarations. They keep their
   file and search tools, which `--restricted` already confines to the working directories.
2. The engine supplies a command-runner MCP server through `--mcp-config`, with `--strict-mcp-config` so no
   other server can load. The server is the only thing in the system that starts a container, and it runs
   exactly the commands the profile's `mechanics.commands` declares.
3. `--tools` continues to name **built-in** tools only — the CLI's help is explicit that its list comes "from
   the built-in set" — so the MCP tool is granted by being served, and pre-approved through `--allowedTools`
   so that a non-interactive run is not blocked waiting for a permission answer nobody can give.
4. `src/container/wrapper.ts` is repointed: the image, the flag set, the mount allow-list, the `--rm` rule
   and the AD-31 assertion suite are unchanged and still correct, as ADR-001 said. What changes is the argv
   placed inside — a command, not `claude -p`.

### Why this shape

This is the **capability-token principle `architecture.md` already states**, applied to the shell: "Domain
ownership is enforced by credential placement, not by instruction. An agent that 'decides' to call Jira fails
for lack of a credential." An agent that decides to run a command outside the container fails for lack of a
tool. Containment stops being a rule the agent is asked to respect and becomes the only path that exists.

It also makes the grant honest. ADR-003 made `--tools` load-bearing security configuration; under the present
code a roster entry granting `Bash` grants an *uncontained* host shell, which is not what its own table says
it grants. After this, the declaration and the reality agree.

## Consequences accepted

- **A new surface: the command-runner server.** It is the one component that may start a container, and it
  is worth reviewing as such. Its tool surface should stay minimal — run a declared command, return exit
  status and output as an evidence pointer.
- **An agent cannot run an arbitrary command.** It runs what the profile declares. This is a real reduction
  in what a step can do, and it is the point: CAP-13's gates are declared commands, not improvisation. A
  repository needing a command the profile does not declare must declare it.
- **A per-command container start costs latency**, which ADR-001 already accepted when it chose per-command
  lifetime.
- **Until the server exists, nothing in the system can execute anything.** This is the plainest consequence
  and the easiest to leave unsaid. `verification`'s whole job is to run the declared gates, `testing`'s is
  to run the tests it writes, and after this decision neither has a tool that runs anything — the
  replacement arrives with story 2-6. Two artefacts still read as though it had not: both purpose strings
  promise to "run", and both declarations keep `promotion_policy: 'on-gate-failure'`, a policy about the
  outcome of a gate they cannot currently reach. They are left as they are because they describe the job
  after 2-6 rather than the gap before it, and the gap is named here instead of being written into the
  roster twice. So between this ADR and story 2-6 the system can write a change it cannot test, and the
  walking skeleton has a hole in it that is deliberate, scoped and temporary.
- **`GRANTABLE_TOOLS` keeps `Bash`**, because AD-17 lets a user-defined agent be granted anything the
  declared set contains. A user who grants `Bash` to their own agent gets a host shell, and that must be
  visible — the `elevated` reporting story 2-4 built already names it.

## What this changes elsewhere

- **ADR-003** — four cells change, not three rows. The three granting `Bash` lose it; each of their
  justification cells loses the sentence this ADR refutes; the line calling a `Bash` grant "contained, but
  real" is corrected, since it is the claim measured false above; and the consequence bullet that "a
  user-defined agent can be granted anything the declared set contains, including `Bash`" gains the warning
  that what such a grant yields is an *uncontained host shell*. That last one was asserted here before it
  was made, which is how a document comes to describe an amendment nobody applied.
- **ADR-001** — this ADR amends it, which is why it is named in `amends:`. Two things there are now
  wrong or answered. Its sentence that "a roster entry granting `Bash` grants the ability to run commands,
  contained but real" is the claim disproved above: contained is exactly what such a grant is not. And its
  note that the question "must be settled before 2-5 and 2-6" is settled by this document, so nothing in
  ADR-001 is still open.
- **AD-20** — unchanged in substance. The boundary is the container; what enters it is a command.
- **Stage-1 gate** — unaffected. "The executor container is verified to hold no push credential" remains
  true and story 1-5's suite still proves it.

## Open question this ADR does NOT decide

**How the command-runner server authenticates that its caller is the step it claims to be.** It is reached
over stdio from a child the engine spawned, so the process tree is the evidence today. Whether that is
sufficient once a run leases services belongs with the story that adds the server.
