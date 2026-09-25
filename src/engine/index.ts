/**
 * `src/engine/` — the reconciler and everything it decides with.
 *
 * This is the surface stories 1-4 (the `claude -p` executor) and 1-7 (command intent files) consume.
 * The dependency direction is fixed and asserted in `tests/engine.reconciler.test.ts` rather than left
 * to discipline: the engine imports only from `src/contracts/`, `src/runtime/` and `node:` builtins,
 * and it never opens `events.jsonl` itself — every event goes through the runtime recorder, which AD-29
 * makes the sole appender and the sole assigner of `seq`.
 *
 * What lives here and why it is separable:
 *
 * - `ulid` — AD-29's run-id minting, monotonic within a process;
 * - `lock` — AD-30's one engine per `ORCH_HOME`;
 * - `checkpoint` — the atomic read and write of `state.json`, whose sole writer is the reconciler;
 * - `rebuild` — AD-4's fold of the log into a checkpoint, and the comparison the log wins;
 * - `dispositions` — AD-8 and AD-35 as one routing function;
 * - `territory` — the conflict-domain bound on concurrency;
 * - `baseline` — AD-26's recorded ref and the reset a re-run begins with;
 * - `executor` — the port story 1-4 implements, so the loop owns decisions and nothing else;
 * - `cli` — AD-1's preflight: where `claude` is, that it meets the pinned floor, and that it
 *   authenticates by subscription rather than by API key;
 * - `node-path` — AD-28's absolute child Node, resolved once and handed to every child;
 * - `stream` — the `--output-format stream-json` parser, which is the system's whole view of what a
 *   step agent did, since AD-1 forbids linking the Agent SDK as a library;
 * - `spawner` — the real `StepExecutor`: one `claude -p` per attempt, re-parsed output, mapped
 *   disposition;
 * - `reconciler` — the loop: read the checkpoint, take at most one action, write the checkpoint;
 * - `commands` — AD-19's durable intent files: the only path a steering command reaches the loop by;
 * - `steering` — what a consumed intent does, and why applying one twice does it once;
 * - `handoff` — CAP-23's escape hatch and the document written when the system gives up;
 * - `ceilings` — AD-24's three run ceilings as a pure decision: eighty percent degrades, a ceiling reached
 *   hibernates, and degradation's two effects — a downshift toward the floor, and a verification step that
 *   stops after its deterministic gates. The reconciler acts on the answer; hibernation goes through
 *   `handoff`'s escape hatch rather than a second branch-and-document path;
 * - `questions` — AD-25's compare-and-set: one accepted transition from `asked`, decided by an
 *   exclusively created file so the first creator wins by construction rather than by careful ordering;
 * - `question-window` — CAP-4's window, and the timeout default taken as a resolver competing in that
 *   same compare-and-set rather than as a special case;
 * - `decision` — the record a resolved question leaves, emitted as events because AD-4 admits no second
 *   durable authority; story 5-3 builds the queryable index over those lines;
 * - `conventions` — the repository's own `CLAUDE.md`/`AGENTS.md`, read as text and passed through
 *   unparsed, plus the one question AD-16's precedence needs of them: do they speak to this anchor;
 * - `profile` — AD-16's profile loader: mechanics from the profile, conventions from the repository, and
 *   a knowledge entry the repository speaks to flagged stale rather than applied;
 * - `agents` — AD-17's grant, resolved from the run's snapshot: the one place that answers "what is this
 *   phase granted", so no caller invents a default and no `phase → tools` table exists to hold;
 * - `roster` — AD-17's discovery by directory read. The engine holds no compiled-in roster, and nothing
 *   under `src/engine/` may import the installer's `BUILT_IN_AGENTS`, which a recursive import guard in
 *   `tests/engine.roster.test.ts` asserts;
 * - `config-snapshot` — AD-9's run-start snapshot and the step-side reader, which are the only two
 *   callers of a profile there are: a step reads `runs/<run-id>/config/` and never `.orch/`;
 * - `committer` — AD-22's branch naming, git note and the three write intents a committing step declares.
 *   It composes them and performs none: AD-15 makes the engine the executor, and that executor is story
 *   2-11's along with the durability rule that a `write.attempted` record is durable before the call;
 * - `deflection` — Q4's three mechanical matchers, by anchor occurrence and never by meaning, and the
 *   `QuestionDeflection` they construct for AD-25's existing compare-and-set; the ledger match is a fold
 *   over `decision.recorded` lines, because story 5-3 owns the index;
 * - `question-merge` — CAP-3's merge of same-anchor questions into one card that still passes Q1, and
 *   the seam where the live Interviewer turn merges on a stated judgement;
 * - `deflection-rate` — Q4's reported rate, folded from `question.asked`/`question.deflected` lines;
 * - `interviewer` — spec echo and question compression as the logic a live turn calls into. The live
 *   conversation itself is not here; it is the one component architecture.md requires to be a model;
 * - `shadow` — story 3-2 (AD-27): `compareShadowRun`, the tree diff and `accepted`/`material_change`
 *   classification a completed shadow run's resulting tree is graded by, against the real merge commit it
 *   was shadowing. No rolling window and no gate verdict here — that is story 3-3's, computed from this
 *   module's one raw, per-run result;
 * - `rework-rate`, `interruption-count`, `feature-usage` — story 3-3's per-feature stage-3 gate signals,
 *   each a pure fold over `events: readonly EventEnvelope[]` in `deflection-rate`'s own idiom;
 * - `trust-record`, `shadow-gate` — story 3-3's two cross-run folds, in `src/tui/fleet.ts`'s `foldFleet`
 *   style: every run under `runsDir`, read with `listRunIds`/`readEventLog` rather than the projected
 *   `ShellView` a renderer wants, because both need the raw lines a projection does not carry;
 * - `consolidation` — story 5-1's batch pass: a completed run's last terminal `feature.state_changed`
 *   folded, with `trust-record`'s own `areaOf`/`territoryFromEvents`, into `KnowledgeEntry`-shaped facts,
 *   appended idempotently to `ORCH_HOME/projects/<project-id>/memory/consolidated.jsonl` (AD-9). Nothing
 *   calls its one entry point, `runConsolidationPass`, yet — wiring a trigger is a future story's;
 * - `knowledge-sweep` — story 5-2: `sweepProfileKnowledge` retires an AD-16-contradicted or
 *   anchor-`'dead'` entry from `profile.toml` by rewriting it (`serialiseToml`/`writeFileIfChanged`, now in
 *   `src/runtime/commands.ts`); `sweepConsolidatedKnowledge` only *reports* the same check against L3's
 *   append-only `consolidated.jsonl`, never rewriting it. `anchorResolution` is the one filesystem check
 *   both share, and it is conservative by construction: `'dead'` only for a `module-name`/`file-path`
 *   anchor actually checked and absent, `'unchecked'` for `api-symbol`/`test-name`, never a guess;
 * - `knowledge-retrieval` — story 5-2's other half: `retrieveFacts` reads L3 back, filtered to a caller's
 *   declared areas and capped at a plain per-feature entry-count budget, most-recent-first;
 * - `decision-index` — story 5-3's queryable index over `decision.recorded` lines: `buildDecisionIndex`
 *   replays `decisionsInLog` out of a batch of ledger runs and appends idempotently, by question id, to
 *   `ORCH_HOME/projects/<project-id>/memory/decisions.jsonl`; `queryDecisionIndex` reproduces
 *   `deflection.ts`'s `matchDecisionLedger` semantics against the indexed entries instead of raw event
 *   logs. `matchDecisionLedger` itself is untouched but for exporting `namesAnchor` and `isUnreadableLog`
 *   for this reuse, and nothing calls either new function yet — the same complete-and-unwired precedent
 *   `consolidation.ts` and `knowledge-sweep.ts`/`knowledge-retrieval.ts` already set;
 * - `pattern-memory` — story 5-4, CAP-19/AD-34's fixed, shared, cross-project home: `recordPattern`
 *   validates and durably appends an already-composed `CrossRepoPattern` to `ORCH_HOME/memory/
 *   patterns.jsonl`; `retrievePatterns` is a topic-filtered, budget-capped, most-recent-first read of
 *   that one store, `retrieveFacts`'s own shape. Complete and unwired, the same precedent as every
 *   module above;
 * The run-start branch-protection assertion is deliberately **not** here. `src/container/lifecycle.ts`
 * already owned it, and a second implementation in this package disagreed with it about the one thing
 * that matters — whether "we could not check" and "it is not protected" have the same consequence. The
 * reconciler takes the assertion as an injected port, so the engine records the outcome and refuses the
 * run without importing the container package it may not see.
 *
 * The steering and command modules are what stories 1-9 and 1-10 write against. A renderer needs
 * `writeCommandIntent`, `newCommandIntent` and `mintIntentId` and nothing else: it never learns the
 * directory layout, never opens the event log, and never calls a method on the engine — which is the whole
 * of AD-19's "renderers reach it only by writing command intent files".
 *
 * The question surface is the same shape, and for the same reason. Story 1-10's one-question card and story
 * 3-1's web resolver both resolve a question by writing an `answer` intent, and both reach the *one*
 * transition through it; `attemptQuestionResolution` is exported for the unit that has already decided
 * which question it is resolving, and it is the only way the transition is ever made.
 *
 * Nothing here wraps a container, leases a resource, manages a question or renders anything. Each of
 * those is a later story, and each plugs into a boundary declared above rather than into the loop's
 * middle — the container in particular reaches the spawner as the `SpawnWrapper` seam of AD-20, never as
 * a flag composed here.
 */
export * from './ulid.js';
export * from './lock.js';
export * from './checkpoint.js';
export * from './rebuild.js';
export * from './promotion.js';
export * from './ceilings.js';
export * from './dispositions.js';
export * from './territory.js';
export * from './baseline.js';
export * from './executor.js';
export * from './cli.js';
export * from './node-path.js';
export * from './stream.js';
export * from './spawner.js';
export * from './commands.js';
export * from './questions.js';
export * from './question-window.js';
export * from './decision.js';
export * from './steering.js';
export * from './handoff.js';
export * from './conventions.js';
export * from './profile.js';
export * from './roster.js';
export * from './agents.js';
export * from './config-snapshot.js';
export * from './committer.js';
export * from './write-executor.js';
export * from './shadow.js';
export * from './deflection.js';
export * from './question-merge.js';
export * from './deflection-rate.js';
export * from './interviewer.js';
export * from './rework-rate.js';
export * from './interruption-count.js';
export * from './feature-usage.js';
export * from './trust-record.js';
export * from './shadow-gate.js';
export * from './consolidation.js';
export * from './knowledge-sweep.js';
export * from './knowledge-retrieval.js';
export * from './decision-index.js';
export * from './pattern-memory.js';
export * from './reconciler.js';
