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
 *
 * Story 2-2 added the two modules that make a project an identity rather than a path. `projects.ts`
 * registers, resolves and prunes `ORCH_HOME/projects/<project-id>/` per AD-10 and AD-33 — here because
 * every other `ORCH_HOME` write already is, and because the installer must be able to register without
 * importing anything the spine forbids it. `repository.ts` holds the three git reads that answer what a
 * repository is, which moved down from `src/installer/detect.ts` because resolution has to verify a
 * recorded path by reading the first-commit SHA at it; `detect.ts` re-exports all three, so no installer
 * caller changed. That is the fifth time this relocation has been made, and always for the same rule.
 */
export * from './paths.js';
export * from './exclusive-create.js';
export * from './repository.js';
export * from './projects.js';
export * from './branches.js';
export * from './redaction.js';
export * from './recorder.js';
export * from './fetch-record.js';
export * from './commands.js';
export * from './runs.js';
export * from './question-view.js';
export * from './steering-view.js';
