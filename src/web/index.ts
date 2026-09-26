/**
 * `src/web/` — the loopback HTTP + SSE control surface, built against the `Command` enum.
 *
 * A second renderer, not a second implementation: every read here is `src/tui/projection.ts`'s
 * `loadShellView`/`src/tui/fleet.ts`'s `foldFleet`, unmodified, and every write is
 * `src/tui/controls.ts`'s `invokeControlByKey`, unmodified — with `source: 'web'`. AD-3's parity is
 * therefore structural: this directory imports the same dispatch table the TUI does rather than
 * declaring a second one.
 *
 * The dependency rule is the one `src/tui/`'s own header states for a renderer, extended to the one
 * renderer this story adds: `src/web/` imports only `src/contracts/`, `src/runtime/`, `src/tui/` (for
 * the shared projection and dispatch this story is built to reuse) and `node:` builtins. It never
 * imports `src/engine/`. `tests/web.dependency-guard.test.ts` asserts this over the directory, mirroring
 * `tests/tui.projection.test.ts`'s own pattern.
 *
 * What lives here:
 *
 * - `views` — thin wrappers resolving a run's AD-9 paths and calling the existing fold;
 * - `commands` — the command route's handler: dispatch through `invokeControlByKey`, and the two
 *   refusals that are this module's own (a run id naming no run, an argument a control requires but
 *   was not given);
 * - `sse` — the poll-and-diff loop, one independent interval per connection;
 * - `server` — the route table and the loopback bind;
 * - `static/index.html` — the dependency-free page the server serves at `/`.
 *
 * What is deliberately absent: authentication, a session, a second command path, and any interface
 * other than loopback (AD-3's "serves a single local user" is what binding to `127.0.0.1` already
 * enforces). Nothing about a step, a gate or a commit ever waits on this server being reachable —
 * every route it adds is additive to the AD-19 file-based path.
 */
export * from './views.js';
export * from './commands.js';
export * from './sse.js';
export * from './server.js';
