---
name: 'The question compare-and-set contends on an outcome file, not on the state file'
type: architecture-decision-record
status: accepted
created: '2026-09-21'
decides:
  - AD-25
raised-by:
  - 'story 1-8 review (the intent-alignment layer, 2026-09-21)'
supersedes-nothing: true
---

# ADR-002 — The question compare-and-set contends on an outcome file, not on the state file

**Status: accepted 2026-09-21 by Deep.** AD-25 is amended in `ARCHITECTURE-SPINE.md` with `Amended by ADR-002`
markers, `QuestionOutcomeSchema` moves into `src/contracts/`, and `decision.recorded` joins the declared
event vocabulary.

## The problem, stated once

AD-25's rule says the transition is "decided by a compare-and-set **on the question state file**". Story
1-8 does not do that. It contends on a second file — `questions/<id>/outcome.json`, published with
`link(2)` — and *derives* `state.json` from whichever outcome won.

The implementation is right and the rule is wrong, for a reason story 1-8 discovered while building it: a
compare-and-set on the state file has to create that file exclusively, and the `'wx'`-then-write shape
publishes a **zero-length file** between the create and the write. A concurrent reader then sees a state
file that exists and says nothing. Story 1-8 hit that trap, and stories 1-2, 1-3 and 1-12 each recorded the
same shape elsewhere — 1-12 finally extracted the fix as `src/runtime/exclusive-create.ts`. So the state
file cannot be both the arbiter and the thing readers parse, without reintroducing the torn read that AD-25
exists to prevent.

## Why this was worth an ADR rather than a comment

Because the next implementer is in a different process, which is the whole point of AD-25.

Story 3-1 is a local web renderer — the "web answer" resolver AD-25 names. An implementer reading AD-25
literally would contend on `state.json`, the file this implementation treats as derived output. Two
resolvers would then arbitrate on different objects and **both would win**, which is precisely the race the
decision was written to make impossible. Nothing at the contracts surface recorded the real arrangement:
`QuestionOutcomeSchema` was declared inside `src/engine/questions.ts`, so the only statement of the
contended artifact's shape lived in the engine, behind a doc comment.

Verified at the time of writing: `isDeclaredEventType('decision.recorded')` returned `false` while
`isDeclaredEventType('question.resolved')` returned `true` — the decision ledger AD-25 requires was being
written with a type no contract declared.

## Decision

1. **The contended artifact is `questions/<id>/outcome.json`.** It is created exclusively — temp file,
   `fsync`, then `link(2)`, where `EEXIST` means another resolver won and any other errno is rethrown. It
   carries the resolver, the principal, the resolution or deflection, and the intent id that claimed it.
2. **`state.json` is derived, not contended.** It is a projection of the winning outcome, in the same
   relationship to it that AD-4 gives `state.json` and the event log: where the two disagree, the outcome
   wins and the state file is rewritten. A reader that needs to know who won reads the outcome.
3. **`QuestionOutcomeSchema` moves to `src/contracts/`.** AD-25 already says a question is a contract type
   in `contracts/`; the outcome file is now the load-bearing half of that type, so it belongs there. The
   engine re-exports the names so no existing caller changes.
4. **`decision.recorded` joins the declared event vocabulary** in `src/contracts/event.ts`. AD-25 requires a
   decision ledger and says only a resolved question writes to it; an event type carrying that record must
   be declarable. AD-5's open vocabulary makes an undeclared type legal to *read*, which is not a reason for
   the project's own writer to emit one.
5. **AD-25's "losing resolvers write nothing" is corrected to what is true.** A loser writes no decision —
   that part is real and is what the invariant is for. A loser may write `state.json`, but only by
   converging it to the winner's derived content, and it skips even that when the winner got there first.
   The sentence now says what it means: **no losing resolver's decision is ever accepted.**

## Consequences accepted

- Two files per question rather than one. The directory listing is `['outcome.json', 'state.json']`, and
  tests assert exactly that.
- A reader must know that `state.json` is derived. That is the same discipline AD-4 already imposes for
  `state.json` against the event log, so it is one rule applied twice rather than a new one.
- The single-winner property is proved at the engine-function surface, not at the shipped resolver surface.
  All three resolvers currently serialise through the one process holding the AD-30 lock, so in production
  the winner is decided by pass ordering and `link(2)` arbitrates only when a second process resolves
  directly. That is defence in depth rather than dead code — story 3-1 is the second process — but the
  property that matters for 3-1 is untested until 3-1 exists.

## What this changes in the spine

- **AD-25** gains `Amended by ADR-002` naming the outcome file as the contended artifact, `state.json` as
  derived, `decision.recorded` as a declared type, and the corrected losing-resolver sentence.
- **The `ORCH_HOME` layout line** for `questions/` names both files rather than "question state files".
- **The question state diagram's** closing line, "Losing resolvers receive an already-resolved result and
  write nothing", is corrected to the decision-level claim.

## Open question this ADR does not decide

**Whether an answer must name its question.** `CommandIntent` carries no question id, so
`resolveQuestionFromIntent` targets the run's active question positionally. R14 gives one question at a
time, which makes that sound today, and story 1-8 recorded the gap as deferred. A second concurrent
question would silently steal an answer. That is a command-contract change and belongs with whoever needs
two questions open at once.
