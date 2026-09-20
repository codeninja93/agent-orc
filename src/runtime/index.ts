/**
 * `src/runtime/` — the recorder, the run shared fetch record and the AD-9 paths.
 *
 * This is the surface story 1-3's engine consumes. The dependency direction is fixed: the engine
 * depends on the runtime, never the reverse, and the runtime imports only from `src/contracts/` and
 * `node:` builtins — asserted in `tests/runtime.recorder.test.ts` rather than left to discipline.
 *
 * Nothing here mints a run id, writes a `state.json`, reconciles, spawns `claude -p` or renders:
 * those belong to later stories. The runtime's whole job is that the log is written exactly once,
 * in order, redacted — and, since story 1-9, that a steering intent file is written whole or not at
 * all. `commands.ts` holds the intent file's format, its atomic write and its id minting, which moved
 * here from the engine so a renderer can write a command without importing the engine the spine
 * forbids it from importing; `src/engine/commands.ts` re-exports every one of those names, so the
 * engine's callers saw no change.
 *
 * Story 1-10 made the same move three more times, and for the same rule. `question-view.ts` holds what a
 * *reader* needs to know about a question — the recommendation, the window remaining, the sentence a
 * person gets when the clock beat them; `steering-view.ts` holds the per-command disposition table, so a
 * card can say which unit will act on a control rather than asserting it from a literal of its own; and
 * `runs.ts` enumerates the run directories the morning brief folds. Each is re-exported by the engine
 * module it came from, so again no engine caller changed. Nothing that *decides* moved: the timeout
 * resolver, the compare-and-set and every intent effect are still the engine's.
 */
export * from './paths.js';
export * from './redaction.js';
export * from './recorder.js';
export * from './fetch-record.js';
export * from './commands.js';
export * from './runs.js';
export * from './question-view.js';
export * from './steering-view.js';
