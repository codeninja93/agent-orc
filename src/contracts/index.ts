/**
 * The contracts package's public surface.
 *
 * `src/contracts/` is the root of the dependency graph: it imports from no other `src/`
 * directory, and every other unit depends on it. That is asserted in
 * `tests/contracts.subset-guard.test.ts` rather than left to discipline.
 *
 * Importing this module asserts the AD-28 Node floor, so a process handed a Node below the floor
 * fails with a named version instead of an opaque TypeScript syntax error. It asserts the Stack's
 * `engines.npm` bound in the same breath and for the same reason: npm 12 disables git-dependency
 * resolution and install scripts by default, so unasserted it breaks AD-12's delivery path later and
 * more obscurely than a named refusal at startup would.
 */
import { assertNodeFloorOrExit } from './node-floor.js';

assertNodeFloorOrExit();

export * from './command.js';
export * from './error.js';
export * from './event.js';
export * from './fetch.js';
export * from './installer.js';
export * from './node-floor.js';
export * from './question.js';
export * from './registry.js';
export * from './schema-version.js';
export * from './state.js';
export * from './step.js';
export * from './usage.js';
