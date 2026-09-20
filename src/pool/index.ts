/**
 * `src/pool/` — the worktree lifecycle, the leased resource pool, and AD-32's reclamation pass.
 *
 * The surface the engine wires in is one function: {@link reconcilerReclamation} returns the port
 * `src/engine/reconciler.ts` calls once per pass. Everything else here is for the unit that creates a
 * run's worktree at run start and for the unit that leases a database for a feature that declares one.
 *
 * The dependency direction is fixed and asserted in `tests/pool.reclaim.test.ts`: this package imports
 * only from `src/contracts/`, `src/runtime/`, `src/container/` and `node:` builtins, and it names no
 * container runtime. Every container operation goes through story 1-5's single invoker, and every flag a
 * leased service needs is composed in `src/container/service.ts` where AD-20 puts it. The engine does not
 * import this package either — it takes the reclamation port as an option, the same structural seam story
 * 1-5's wrapper reaches story 1-4's spawner through.
 */
export * from './worktree.js';
export * from './lease.js';
export * from './reclaim.js';
