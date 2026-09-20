/**
 * `src/container/` — AD-20's one containment boundary.
 *
 * The surface the engine wires in is small on purpose: a wrapper to pass as story 1-4's `wrap` option,
 * a reachability check to call before a tier-2 run, a tier classification, and the AD-31 gate. The
 * engine learns no flag, no mount and no image tag; it states a tier and hands over a plan.
 *
 * The dependency direction is fixed and asserted in `tests/container.wrapper.test.ts`: this package
 * imports only from `src/contracts/`, `src/runtime/` and `node:` builtins. It does not import
 * `src/engine/` — not even for the `SpawnWrapper` type, which is satisfied structurally instead — and
 * `src/engine/` cannot import it, since no engine file may so much as name the container runtime.
 */
export * from './runtime.js';
export * from './flags.js';
export * from './image.js';
export * from './tiers.js';
export * from './service.js';
export * from './lifecycle.js';
export * from './wrapper.js';
