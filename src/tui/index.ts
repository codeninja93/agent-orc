/**
 * `src/tui/` — the Ink renderer, as a projection of one event log.
 *
 * This is the surface a future entry point mounts: `mountShell` over a run's `events.jsonl`, and
 * `invokeControl` for every steering command. Nothing else is needed, and nothing else is offered.
 *
 * The dependency rule is the one the spine states and story 1-9 had to settle: **`src/tui/` imports
 * only from `src/contracts/`, `src/runtime/` and `node:` builtins, plus React and Ink.** It never
 * imports `src/engine/`. The three functions a renderer needs to write a command intent — the format,
 * the atomic write, the id minting — were moved into `src/runtime/commands.ts` for exactly that
 * reason, and `src/engine/commands.ts` re-exports them so the engine's own callers were untouched.
 * `tests/tui.projection.test.ts` asserts the rule over the directory rather than leaving it to
 * discipline.
 *
 * What lives here:
 *
 * - `projection` — the fold from events to view state. Nearly all of the behaviour, and testable with
 *   no terminal at all;
 * - `mode` — the autonomy mode's derivation and its permanent display, which
 *   `interface-contract.md` makes a safety property rather than a decoration;
 * - `status` — the ambient segment: step count, consumed rate-limit budget, elapsed against estimate,
 *   all visible without a command being issued (R10, R11);
 * - `controls` — the total `CommandMap` of controls, each writing one durable intent file (AD-3,
 *   AD-19);
 * - `app` — the Ink shell, whose every line comes from a pure function, and which reserves the
 *   persistent question slot story 1-10 fills.
 *
 * What is deliberately absent: the question card, the spec echo, the morning brief, the kill card, the
 * completion notice and the handoff rendering are story 1-10's six surfaces; the loopback server and
 * the web renderer are story 3-1's; ceilings enforcement is 2-9's. This story owns the shell they live
 * in.
 */
export * from './projection.js';
export * from './mode.js';
export * from './status.js';
export * from './controls.js';
export * from './app.js';
