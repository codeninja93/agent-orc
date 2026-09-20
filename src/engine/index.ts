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
 * - `reconciler` — the loop: read the checkpoint, take at most one action, write the checkpoint.
 *
 * Nothing here spawns a process, wraps a container, leases a resource, reads a command intent file,
 * manages a question or renders anything. Each of those is a later story, and each plugs into a
 * boundary declared above rather than into the loop's middle.
 */
export * from './ulid.js';
export * from './lock.js';
export * from './checkpoint.js';
export * from './rebuild.js';
export * from './dispositions.js';
export * from './territory.js';
export * from './baseline.js';
export * from './executor.js';
export * from './reconciler.js';
