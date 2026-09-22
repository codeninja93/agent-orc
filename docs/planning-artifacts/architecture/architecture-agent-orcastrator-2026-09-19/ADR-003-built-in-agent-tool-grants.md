---
name: 'The tool grant of each built-in agent'
type: architecture-decision-record
status: accepted
created: '2026-09-22'
decides:
  - AD-17
closes-open-question-in:
  - ADR-001
raised-by:
  - 'story 2-1 (the installer shipped a built-in roster, answering the question de facto)'
  - 'ADR-001 — "which exact tool names each built-in agent is granted"'
supersedes-nothing: true
---

# ADR-003 — The tool grant of each built-in agent

**Status: accepted 2026-09-22.** Closes the open question ADR-001 deferred to the roster stories, with one
correction to the table story 2-1 shipped and one new constraint on how a grant is declared.

## Why this needed deciding now

ADR-001 moved the containment boundary from the agent process to the commands the agent runs, and in doing so
made `--tools` load-bearing: a roster entry granting `Bash` grants the ability to run commands. This
paragraph said "contained, but real", and **ADR-004 measured that false** — the agent process runs on the
host, so its `Bash` runs on the host, and no flag relocates a tool use into a container. Read it as "real,
and *not* contained": the ADR-004 amendment below follows from exactly that correction. It deferred the
table to stories 2-3 through 2-7, "where each agent's job is actually defined".

Story 2-1 arrived first and shipped a built-in roster with grants already in it, because the installer has to
write *something* into `.orch/agents/`. So the question was answered de facto, by an implementation, without
the decision ever being taken. This ADR takes it.

## The decision

| agent | granted tools | reversibility | why this grant |
|---|---|---|---|
| `analysis` | `Read`, `Grep`, `Glob` | reversible | It states what the work is. It needs to read the repository and nothing else. |
| `planning` | `Read`, `Grep`, `Glob` | reversible | It orders steps and declares territories. Same reach as analysis; it produces a plan, not a change. |
| `implementation` | `Read`, `Write`, `Edit`, `Grep`, `Glob` (**`Bash` removed by ADR-004**) | recoverable | It writes the change in the run worktree. It does not run the gates: ADR-004 makes command execution an MCP tool whose server runs the command inside the container. |
| `testing` | `Read`, `Write`, `Edit`, `Grep`, `Glob` (**`Bash` removed by ADR-004**) | recoverable | **`Write`/`Edit` is deliberate and is broader than ADR-001's sketch.** That sketch said "testing and the committer get `Bash`", which is incomplete: this agent's job is to *write* the tests as well as run them, and a testing agent that cannot author a test is not one. Running them is ADR-004's command tool, not this grant. |
| `verification` | `Read`, `Grep`, `Glob` (**`Bash` removed by ADR-004**) | reversible | It reports on the declared gates, which it runs through ADR-004's command tool rather than through a shell of its own. It must not be able to edit what it is judging — that is the whole reason it is a separate agent from `testing`. |
| `committing` | `Read`, `Grep`, `Glob` | irreversible | **Changed from what story 2-1 shipped.** See below. |

**No built-in agent is granted `Task`**, so no step can spawn an unbounded tree of its own. **None is granted
`WebFetch` or `WebSearch`**, because AD-13/AD-14 make every external read go through the engine's fetch
record; a step reaching the network directly would leave that record incomplete.

**Amended by ADR-004 (2026-09-22).** The three rows granting `Bash` no longer do. This table justified
`Bash` as "how a gate runs, inside the container per ADR-001" — and that was measured to be false: the agent
process runs on the host, its `Bash` tool runs on the host, and CLI 2.1.278 offers approve-or-deny through a
permission tool but no way to relocate a tool use into a container. Command execution is now an MCP tool
whose server runs the command inside the container. `GRANTABLE_TOOLS` keeps `Bash` because AD-17 lets a
user-defined agent be granted anything the declared set contains — but granting it yields an uncontained
host shell, which is why story 2-4's `elevated` reporting names it.

## The one correction: `committing` loses `Bash`

Story 2-1 granted `committing` `Read` and `Bash`, with the purpose "Open the pull request under the user's
identity and write the AD-22 merge note". **AD-15 forbids exactly that**, and names the committer while doing
it: *"`git push`, pull request creation, git notes, tags, and every MCP domain mutation are engine-executed
write intents, and none may be performed by an agent."*

So the agent does not open the pull request. It reads the diff and the run's record and *composes the write
intent*; the engine executes it, exactly once, against an idempotency key. `Bash` is not merely unnecessary
for that — it is the one tool that would let the only `irreversible` agent in the roster perform the write
itself, which is the precise failure AD-15 exists to prevent.

`committing`'s purpose text must change with its grant. An agent whose stated job contradicts its permitted
tools is how the contradiction got in.

## The new constraint: a granted tool name must be a declared name

`AgentDeclarationSchema.tools` is `z.array(z.string())`. A typo therefore changes a security grant silently —
`Bsah` grants nothing and reads like it grants something, and the reverse mistake is worse. Since ADR-001
made this field security configuration, it gets the treatment every other load-bearing vocabulary in this
codebase gets: a declared set in `src/contracts/`, with an unknown name refused at parse.

The declared set is the tools above plus any a later roster story adds deliberately. Adding a name is a
decision; discovering one in a TOML is not.

## Consequences accepted

- **`testing` can edit source, not only tests.** Nothing in a tool grant distinguishes a test file from the
  code under test; that boundary is the step contract's and the territory's, not the grant's. Named here so
  it is a known limit rather than an assumption.
- **`implementation` and `testing` hold the same grant.** They are separated by their contracts and their
  prompts, not by their reach. If that separation ever needs to be enforced rather than intended, the grant
  is not where it will happen.
- **A user-defined agent can be granted anything the declared set contains**, including `Bash`. AD-17 makes
  the roster declarative and question 11 of the installer's interview asks for the grant directly. This ADR
  fixes the built-ins; it does not constrain what a person may declare for their own agent, and the review of
  a roster entry is the control there. **Amended by ADR-004:** what such a grant yields is an *uncontained
  host shell*, not the contained command runner this table assumed — the agent process runs on the host and
  so does its `Bash`. The grant stays legal and the warning is the control: story 2-4's `elevated` reporting
  names it on the spawn event, so a person reviewing a roster entry sees what they gave away.

## What this changes

- **AD-17** gains this table as the built-in roster's grant, and the rule that a granted tool name must be a
  declared name.
- **Story 2-1's `BUILTIN_AGENTS`** changes in one row here: `committing` drops `Bash` and its purpose is
  reworded. **With ADR-004 it is four rows**, since `implementation`, `testing` and `verification` drop
  `Bash` too — which leaves no built-in granted it at all.
- **ADR-001's open question is closed.** What remains open there is nothing.
- **Stories 2-3 through 2-7** inherit this table rather than each inventing a row of it. A story that needs a
  grant this table does not give is making an architecture change and should say so.
