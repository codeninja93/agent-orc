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
 *   persistent question slot story 1-10 filled;
 * - `cards/` — the six surfaces `interface-contract.md` requires, each a pure function from a view to a
 *   plain structure: the one-question card, the spec echo, the morning brief, the kill card, the
 *   completion notice and the handoff note; plus story 4-4's attention card, a fleet-wide, exceptions-only
 *   read that is card-shaped but deliberately not one of the six (Boundaries — see `cards/attention.ts`);
 * - `cards.tsx` — one Ink component per card, each laying out its view-model and nothing more;
 * - `fleet` — every run under `runsDir`, folded, so CAP-22's brief is a fold of one log per feature and one
 *   unreadable log costs only its own line;
 * - `input` — the keyboard loop as a pure reducer: a keystroke names an effect, and `invokeControl`
 *   performs the only one a renderer may (AD-19);
 * - `width` — how wide a string is on a terminal, in cells rather than in UTF-16 units, which is what
 *   every 40-column guarantee in this directory is actually a guarantee about.
 *
 * What is deliberately absent: the loopback server and the web renderer are story 3-1's; ceilings
 * enforcement is 2-9's, so the kill card displays usage against estimate and acts on nothing; the
 * Interviewer, question compression and quiet hours are 2-8's; the merge a completion notice reports is
 * 2-7's, which is why the notice states it as unrecorded rather than as a pass (R8).
 */
export * from './width.js';
export * from './projection.js';
export * from './mode.js';
export * from './status.js';
export * from './controls.js';
export * from './app.js';
export * from './cards/index.js';
export * from './cards.js';
export * from './fleet.js';
export * from './input.js';
