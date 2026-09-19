# Memory Design

Design of the memory layer (CAP-17, CAP-18, CAP-19). Deferred to stage 5 per `build-sequencing.md`; specified here so earlier stages do not foreclose it.

## Memory is not one thing

Ten distinct jobs with different shapes, lifetimes and retrieval patterns. Building one store for all of them is the identified failure mode.

| # | Job | Shape |
|---|---|---|
| 1 | Do not re-explain conventions | Executable rules, not retrieval |
| 2 | Do not rewrite existing code | Prior-art retrieval, keyed on the plan |
| 3 | Do not repeat a costly mistake | Regression tests |
| 4 | Make an agent productive in an unfamiliar region | Per-directory notes |
| 5 | Let product B benefit from product A | Abstract cross-repo patterns |
| 6 | Explain why the code is like this | Human-readable rationale |
| 7 | Estimate cost before committing budget | Historical cost table |
| 8 | Know what is fragile | Risk signal, used for routing |
| 9 | Resume a paused feature | Episodic log |
| 10 | Survive a model change | Structured facts, never prompt text |

## The primary rule: convert, do not retrieve

Memory that enforces itself costs nothing at read time. Wherever a remembered thing is checkable, it becomes an artifact rather than a retrieval:

- A convention becomes a lint rule or a test.
- A past failure becomes a regression test.
- An incident becomes a guardrail in `threat-model.md`.

Retrieval is the fallback for the irreducibly fuzzy, not the default mechanism.

## Consolidation

Long-term memory is never written during a run. The run appends to a fast, lossy episodic log. A consolidation pass runs between features or nightly, compacting that log into durable structured facts — when outcomes are known and tokens are cheap.

This is sleep consolidation (hippocampus to neocortex) and write-ahead-log plus compaction: the same design reached independently from biology and from databases. It is the only genuinely new subsystem memory requires; everything else is querying git and the event log.

Consolidation weights failures above successes.

## Tiers

| Tier | Contents | Loaded |
|---|---|---|
| L1 | Per-repo profile: stack, commands, conventions | Always |
| L2 | Per-directory notes | On touching that region |
| L3 | Retrieval index over consolidated facts | On query, under budget |
| Disk | Git history and the event log | On demand |

Entries promote toward L1 on repeated retrieval and are pruned when never retrieved. Retrieval hit-counts are tracked from the first day, because pruning is impossible without them.

## What is never stored

Git already answers a large share of memory questions. **Nothing is stored that `git log` or `git blame` can answer.** Beyond that:

- No code snippets.
- No file paths as anchors where a symbol will do; never line numbers.
- Nothing from an abandoned branch ranked equal to something merged and shipped.
- No concrete specifics in cross-repo memory — "how we do auth", never the auth code.

## Anchors and invalidation

Anchors ranked by durability: test names, then public API symbols, then module names, then file paths. Line numbers are never valid.

The dominant cost flips with scale: below roughly a hundred features the problem is writing and retrieving memory; beyond roughly a thousand it is **invalidating** it. Therefore, from the first entry written:

- Every entry carries a decay policy chosen at write time: permanent, until-refactor, N-features, or session-only.
- The committer detects renames and rewrites anchors as part of the commit, so memory cannot drift behind the code.
- A periodic sweep samples entries, checks anchors still resolve, and flags the dead.

## Write discipline

- Only verified, merged outcomes write to long-term memory. Failed experiments write to episodic only. This is the primary defence against memory poisoning.
- Learning is a pipeline step with an owner: the committer records what was learned.
- Negative memory — "this was tried and did not work" — is retained and is worth more per token than positive memory.
- Memory must be rebuildable: if the index is lost, at least ninety percent regenerates from git history plus the event log.

## Measurement

Retrieval token cost versus measured reduction in rework. If that number is not positive, the memory layer is removed.
