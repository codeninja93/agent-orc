---
title: 'Web control surface — loopback HTTP plus SSE, Command enum parity'
type: 'feature'
created: '2026-09-24'
status: 'done'
review_loop_iteration: 1
followup_review_recommended: true
baseline_revision: '12fa507'
context:
  - '{project-root}/docs/planning-artifacts/architecture/architecture-agent-orcastrator-2026-09-19/ARCHITECTURE-SPINE.md'
warnings: []
deferred:
  - summary: '`bin/orch-web.ts` has no direct test of its own.'
    evidence: >-
      `parsePort`'s edge cases, the SIGINT/SIGTERM shutdown path, and its stdout/stderr contract are
      covered only indirectly through the library functions it calls. Confirmed to exactly mirror this
      codebase's own established, apparently deliberate convention for thin entry points — `bin/orch-run.ts`
      has no direct test either — not a deviation this story introduces alone.
    location: bin/orch-web.ts
    severity: low
  - summary: >-
      The static page's `CONTROLS` array hand-duplicates `src/tui/controls.ts`'s own table with nothing
      enforcing they stay in sync.
    evidence: >-
      Verified currently in sync. A control added, renamed, or reclassified in the TUI's table would
      leave the web page's button list silently stale, though the server's own dispatch would still
      handle it correctly regardless. The correct fix — serving the real table's shape to the page
      rather than hand-copying it — is more than a direct correction.
    location: src/web/static/index.html
    severity: low
  - summary: 'No `aria-live` region announces an SSE-pushed state change or command result to a screen reader.'
    evidence: >-
      Real, but accessibility was not named anywhere in this story's stated scope, and "no reply ever
      requires a browser" already makes this page a secondary, optional surface.
    location: src/web/static/index.html
    severity: low
  - summary: 'The fleet listing''s "N older runs not shown" overflow has no way to actually reach those runs.'
    evidence: >-
      No pagination or filter exists. Not a regression against anything this story promised
      (`foldFleet`'s own output is served unmodified); worth a follow-up if the fleet ever needs to show
      more than its own default cutoff.
    location: src/web/static/index.html
    severity: low
---

# Story 3-1 — Web control surface: loopback HTTP plus SSE, Command enum parity

## Intent

**Problem:** AD-3 requires every steering control to be a member of one `Command` enum both renderers
are built against, so a control present in the TUI and absent from the web surface is a compile error —
but there is no web surface at all yet. AD-19 already anticipates it (`src/web/` is named in the
architecture's own directory tree), but confirmed directly: no `src/web/` exists, no HTTP/SSE dependency
is installed, and nothing in this codebase serves the run state or accepts a command over HTTP.

**Approach:** Build a second renderer — a loopback-only HTTP server with one SSE endpoint per run and a
minimal page to view it — that reuses the TUI's own machinery rather than re-implementing it:
`src/tui/projection.ts`'s `loadShellView`/`idleShellView` for the view, `src/tui/fleet.ts` for the
multi-run listing, and `src/tui/controls.ts`'s `invokeControlByKey` for every command, so parity with
the TUI is structural (the same dispatch table) rather than a second implementation to keep in sync.

## Boundaries & Constraints

**Always:**
- The server binds `127.0.0.1` only, never `0.0.0.0` or any other interface — mirroring
  `src/container/service.ts`'s own `SERVICE_PUBLISH_ADDRESS` precedent, where loopback binding is
  already this project's established security boundary in place of a login or a token. No auth layer is
  added on top of it, for the same reason none exists there: AD-3's "serves a single local user" and
  SPEC.md's "single user per instance, local-first" assumption are what loopback binding already
  enforces.
- Every command the web surface issues goes through `src/tui/controls.ts`'s existing
  `invokeControlByKey(key, context, argument?)`, with `context.source` set to `'web'` (already a
  declared `CommandSource` member, already documented in `ControlContext.source`'s own comment as "story
  3-1's server writes the same files as `web`") and `context.principal` set to `{ kind: 'user', id:
  'local' }`, matching the reconciler's own default principal. This is what makes Command-enum parity
  structural: a command handled by `CONTROLS` (the total map over the `Command` enum) is reachable here
  by construction, and a command added to the enum without a `CONTROLS` entry is already a compile error
  today, before this story exists.
- The view a client reads — a single run's or the whole fleet's — is `loadShellView`/`foldFleet`'s
  output, unmodified. No second projection of `events.jsonl` is built; a divergence between what the TUI
  shows and what the web surface shows would be exactly the failure AD-4 exists to prevent.
- The SSE endpoint is poll-and-diff, not file-tailing: call `loadShellView` on an interval (the same
  poll-based redraw model the TUI's own Ink render loop already uses, at a comparable interval — this
  codebase's stated aversion to bespoke machinery covers building a new file-tailing mechanism when the
  existing poll model already works and only needs to run in a `setInterval` instead of a terminal
  frame), and push an SSE `message` event only when the folded view actually changed since the last
  push. A client's own reconnect (`EventSource`'s built-in retry) is the recovery path for a dropped
  connection, not a resumable byte offset this story builds.
- `src/web/` follows the same dependency rule `src/tui/`'s own header states for renderers: only
  `src/contracts/`, `src/runtime/`, and `node:` builtins, plus whatever this server's own HTTP/SSE
  handling needs — never `src/engine/`. A dependency-guard test mirrors
  `tests/tui.projection.test.ts`'s existing pattern (scan every file under the directory, assert no
  `/engine/` import, assert every bare-package import is in a declared allow-list), extended to
  `src/web/`.
- No new HTTP framework dependency. Node's own `http` module (and its own SSE support, which is a
  content-type and a stream, not a protocol needing a library) is sufficient for the small, fixed route
  set this story declares; this mirrors 2-11's own "no Octokit, `git`/`gh` are already on the machine"
  reasoning, one layer over.

**Never:**
- No rich frontend framework or bundler. `ARCHITECTURE-SPINE.md`'s stack table names Vite as the
  *planned* bundler for a future web surface, but nothing installs or requires it today, and AD-3's own
  "the TUI alone is sufficient" framing makes a minimal, dependency-free HTML/JS page the right scope for
  a first version — a build pipeline is a decision for whoever first needs more than one static page.
- No second command-writing path. Every route that changes anything calls `invokeControlByKey`; nothing
  in `src/web/` calls `writeCommandIntent` directly or constructs a `CommandIntent` by hand — that would
  create exactly the "one renderer using a socket while the other writes files" divergence AD-19 names
  as the thing this story must prevent.
- No dependency on the web server for any control to remain available. Every route this story adds is
  additive to the file-based path AD-19 already guarantees; nothing about a step, a gate, or a commit
  waits on this server being reachable, and no test may assert otherwise.
- No authentication, session, or user-account system. Loopback binding is the boundary, not a login this
  story is scoped to build.

## I/O & Edge-Case Matrix

| # | Input / situation | Expected |
|---|---|---|
| 1 | A `GET` request for a run's current view | Returns `loadShellView`'s own JSON, unmodified — the same facts the TUI would show for that run |
| 2 | A `GET` request for the fleet (every run) | Returns `foldFleet`'s own listing, unmodified |
| 3 | An `EventSource` connects to a run's SSE endpoint | Receives the current view immediately, then a new event only when the folded view actually changes |
| 4 | The server is not running at all | Every steering control remains available through the existing file-based command-intent path; no test in this codebase may depend on the server being up |
| 5 | A `POST` for a command this build honours (e.g. `approve`) | `invokeControlByKey` runs exactly as it would for the TUI; a durable command intent file is written with `source: 'web'` |
| 6 | A `POST` naming a command outside the `Command` enum | `invokeControlByKey` itself returns `null` for an unrecognized key — the route reports this as a clear refusal, never a dispatch attempt, with no separate pre-validation duplicating the same closed vocabulary the TUI's own key handling already enforces |
| 7 | A `POST` for a run id that does not exist | Refused with a clear reason, never a raw exception surfacing as an opaque 500 |
| 8 | Two SSE clients connected to the same run at once | Both receive the same events; the poll-and-diff loop is per-connection but reads the same durable log, so nothing about one client's connection affects another's |
| 9 | The server attempts to bind a port already in use, or bind any interface other than loopback | Refuses to start rather than silently binding somewhere unintended |

## Code Map

| File | Change | Why |
|---|---|---|
| `src/web/server.ts` | new | The HTTP server: route table, loopback bind, request dispatch to the handlers below. |
| `src/web/views.ts` | new | Thin wrappers calling `loadShellView`/`idleShellView` (from `src/tui/projection.ts`) and `foldFleet` (from `src/tui/fleet.ts`), shaping their output as the JSON responses the routes above return — no new projection logic. |
| `src/web/commands.ts` | new | The command route's handler: validates a posted command name against the `Command` enum, builds a `ControlContext` with `source: 'web'` and the fixed local `Principal`, and calls `invokeControlByKey` (from `src/tui/controls.ts`). |
| `src/web/sse.ts` | new | The poll-and-diff SSE loop: an interval calling `loadShellView`, comparing against the last-sent view, writing a new SSE frame only on change. |
| `src/web/static/index.html` | new | A minimal, dependency-free page: connects to the SSE endpoint, renders the fleet/run view as plain HTML, and posts to the command routes from a handful of buttons/forms. No bundler, no framework. |
| `bin/orch-web.ts` | new | The entry point: resolves `ORCH_HOME`, starts the server on loopback, prints the bound port. |
| `tests/web.server.test.ts` | new | Matrix rows 1, 2, 5, 6, 7, 9 — routes exercised directly (supertest-free: Node's own `http` client against a server bound to an ephemeral loopback port). |
| `tests/web.sse.test.ts` | new | Matrix rows 3, 8 — the poll-and-diff behavior, with an injectable clock/interval so the test does not depend on real wall-clock timing. |
| `tests/web.dependency-guard.test.ts` | new | Mirrors `tests/tui.projection.test.ts`'s existing pattern, scanning `src/web/` instead of `src/tui/`. |

## Tasks & Acceptance

1. **Serve a run's view and the fleet listing, unmodified from existing projections.**
   - **Given** a run with recorded events, **when** its view route is requested, **then** the response is
     exactly what `loadShellView` produces for that run.
   - **Given** the fleet route, **when** requested, **then** the response is exactly what `foldFleet`
     produces.
2. **Stream view changes over SSE, poll-and-diff, not file-tailing.**
   - **Given** an `EventSource` connection, **when** it opens, **then** the current view arrives
     immediately.
   - **Given** no change between polls, **when** the interval fires, **then** no event is sent.
3. **Issue every command through the same dispatch the TUI uses.**
   - **Given** a posted command name, **when** it is a member of the `Command` enum, **then**
     `invokeControlByKey` is called with `source: 'web'` and the fixed local principal, and a durable
     command intent file lands exactly as it would from the TUI.
   - **Given** a posted command name outside the enum, **when** the route calls `invokeControlByKey`,
     **then** the `null` it returns is reported as a clear refusal, with no separate pre-validation step
     duplicating the same check.
4. **Bind loopback only, and refuse to start otherwise.**
   - **Given** server startup, **when** it binds, **then** the bound address is `127.0.0.1` and nothing
     else; a bind failure (port in use, any other interface) is a startup refusal, not a silent fallback.
5. **Prove the file-based path never depends on this server.**
   - **Given** every existing test in this codebase that exercises a steering command, **when** this
     story lands, **then** none of them are changed to depend on `src/web/` being running.

## Spec Change Log

## Review Triage Log

### 2026-09-24 — Review pass
- verdicts: 26 findings — high 5, medium 7, low 14, false 0, maybe-false 0 — routed 17 patch, 6 defer, 3 reject
- findings:
  - `[high]` `patch` **The most serious finding of this round.** Three separate paths let an error after the server has already started crash the *entire* process, not just the one connection that triggered it — directly contradicting this story's own row-8 guarantee ("nothing about one client's connection affects another's"): the server's one-time startup `'error'` listener is removed on success, leaving nothing to catch a later server-level error (e.g. `EMFILE`); an SSE response's `'error'` event (an abrupt socket drop) is never handled, only `'close'`; and `src/web/sse.ts`'s poll-and-diff callback has no `try`/`catch` around re-reading and folding the event log. — Verified directly against all three locations. Independently found by blind-hunter (two of these three) and edge-case-hunter (all three, with precise line citations). Patched: a persistent server-level error handler that logs rather than crashes, the response's `'error'` event handled alongside `'close'`, and the poll callback's own re-fold wrapped so a transient read failure ends that one connection's stream rather than the process.
  - `[high]` `patch` A malformed `POST` body (invalid JSON, a missing or mistyped `key`/`argument`) returns an opaque `500 Internal Server Error` instead of a clean `400` — directly contradicting the module's own documented intent ("matrix row 7: never a raw exception surfacing as an opaque 500"). `parsePostedCommandBody`'s validation throws land in the same generic catch branch that maps everything but `UnsafePathSegmentError` to 500. — Independently found by edge-case-hunter and verification-gap, with exact line citations. Patched: validation failures now throw a distinguishable error the route maps to 400.
  - `[medium]` `patch` `commands.ts`'s dispatch catches *every* exception `invokeControlByKey` can throw and reports all of them as a client-caused `400`, but only `ControlArgumentRequired` is actually the caller's fault — a genuine write failure (for instance, a run directory removed between the existence check and the write) would be misreported as if the client had made a bad request, hiding a real operational failure behind a misleading 400. — Verified directly against the catch-all. Found by edge-case-hunter. Patched: only `ControlArgumentRequired` is caught as 400; anything else propagates to the route's own 500 handling.
  - `[medium]` `patch` The SSE route itself — URL matching, real socket headers, actual streaming — is never exercised end to end. Every SSE test drives `startSseStream` directly against a hand-built fake response and an injected scheduler; `tests/web.server.test.ts`, which exercises every other route through a real bound server, has no test at all requesting `/api/runs/:id/events`. — Verified directly: confirmed no such test exists. Found by intent-alignment. Patched: a test now connects to the real running server's SSE route and confirms it streams a real frame.
  - `[medium]` `patch` `parsePort` accepts a port value with trailing garbage (e.g. `"8080abc"` parses to `8080`) because `Number.parseInt` truncates rather than validates the whole string, contradicting the function's own error message ("must be an integer between 0 and 65535"). — Verified directly. Independently found by blind-hunter and edge-case-hunter. Patched: the raw value is now matched against a whole-string digit pattern before parsing.
  - `[medium]` `patch` A `POST`'s command-posting route has no request-origin check. Loopback binding stops remote network access (this story's own stated boundary), but any other page or process already running on the user's own machine can still POST a command to a guessed or discovered local port — the "drive-by localhost" surface, a different threat than the authentication this story deliberately does not build. — Found by blind-hunter. Patched: a `POST` whose `Origin` header, when present, does not match the server's own loopback origin is refused — request-origin validation, not authentication, so this does not reopen the "no auth" boundary.
  - `[medium]` `patch` `readRequestBody` buffers a `POST` body with no size cap and no request timeout — an oversized or slow-drip body ties up the handler indefinitely with no backpressure limit. — Verified directly. Independently found by blind-hunter and edge-case-hunter. Patched: a size cap now destroys an oversized request before it is fully buffered.
  - `[low]` `patch` A malformed percent-encoded run id in the URL path (e.g. a bare `%`) throws a `URIError` that escapes to the generic catch, returning an opaque 500 instead of the same clear run-id refusal every other malformed-id path already gets. — Verified directly. Found by edge-case-hunter. Patched: the decode is now guarded the same way.
  - `[low]` `patch` A request using the wrong HTTP method on an otherwise-valid route (e.g. `POST /api/runs/:id`) returns a generic 404 rather than a 405 naming that the path exists but the verb does not. — Verified directly. Found by edge-case-hunter. Patched.
  - `[low]` `patch` The static page's two `fetch()` calls have no `.catch` and no response-ok check; an error response body reaching the render functions throws an uncaught `TypeError` and silently breaks the page. — Verified directly. Found by edge-case-hunter. Patched.
  - `[low]` `patch` The test named for matrix row 4 ("every existing steering test still passes with no server running") asserts only that a fixture event-log file is readable — it never calls `invokeControlByKey` or any steering control, so it does not demonstrate the property it is named for, even though the property itself holds (this diff touches neither `src/tui/` nor `src/runtime/`). — Independently found by verification-gap and intent-alignment. Patched: the test now writes a real command intent file via `invokeControlByKey` with nothing from `src/web/` loaded, genuinely demonstrating the file-based path's independence.
  - `[low]` `defer` `bin/orch-web.ts` has no direct test of its own — `parsePort`'s edge cases (now fixed above), the `SIGINT`/`SIGTERM` shutdown path, and its stdout/stderr contract are covered only indirectly through the library functions it calls. — Independently found by blind-hunter, verification-gap, and intent-alignment; verification-gap confirmed this "exactly mirrors the existing, apparently deliberate pattern for `bin/orch-run.ts`," which has no direct test either. Deferred: consistent with this codebase's own established convention for thin entry points, not a deviation this story introduces alone.
  - `[low]` `defer` The static page's `CONTROLS` array hand-duplicates `src/tui/controls.ts`'s own table (verified currently in sync) with nothing enforcing they stay that way; a control added, renamed, or reclassified in the TUI's table would leave the web page's button list silently stale, though the server's own dispatch would still handle it correctly regardless. — Found by blind-hunter. Deferred: the correct fix (serving the real table's shape to the page rather than hand-copying it) is more than a direct correction.
  - `[low]` `defer` No `aria-live` region announces an SSE-pushed state change or a command's result to a screen-reader user. — Found by blind-hunter. Deferred: a real gap, but accessibility was not named anywhere in this story's stated scope, and "no reply ever requires a browser" already makes this page a secondary, optional surface.
  - `[low]` `defer` The fleet listing's `notRead` overflow count ("N older runs not shown") has no way to actually reach those runs — no pagination or filter. — Found by blind-hunter. Deferred: not a regression against anything this story promised (`foldFleet`'s own output is served unmodified), worth a follow-up if the fleet ever needs to show more than its own default cutoff.
  - `[low]` `reject` The fleet listing only polls `/api/fleet` every 5 seconds rather than getting its own SSE endpoint, so the "poll-and-diff, not file-tailing" real-time model is not extended to the fleet view. — Found by blind-hunter. Rejected: this story's own spec named "one SSE endpoint per run," never a fleet-level stream; extending real-time updates to the fleet dashboard is a natural future enhancement, not a promised boundary here.
  - `[low]` `reject` Matrix row 9's "binds any interface other than loopback... refuses to start" is satisfied structurally — no `host` option exists anywhere in `WebServerOptions`, making the bad case unreachable rather than a runtime-guarded and tested one. — Found by intent-alignment, framed as an untested half of the row. Rejected: unreachable-by-construction is a stronger guarantee than a guard a test exercises, the same reasoning this project has applied to other structurally-foreclosed cases in earlier stories; nothing to fix.
  - `[low]` `reject` The spec's "Always" bullet listing `src/web/`'s allowed dependencies names only `src/contracts/`, `src/runtime/`, and `node:` builtins, without explicitly naming `src/tui/` — which the Approach section's own reuse mandate (and the shipped dependency-guard test) correctly treats as allowed. — Found by intent-alignment as a text-vs-implementation divergence. Rejected as a code finding: the implementation and its own test are correct and deliberate; the imprecision is in this spec's own prose, corrected directly in the Auto Run Result below.

## Design Notes

**Why `invokeControlByKey` and not a hand-built dispatch.** The alternative — a `switch` over posted
command names inside `src/web/commands.ts` — would duplicate `CONTROLS`' own total map over the
`Command` enum, and a second total map is a second place for the two renderers to disagree about what a
command does, exactly what AD-3 exists to prevent. Reusing the same function the TUI calls makes parity
free rather than something to test for.

```ts
// src/web/commands.ts, sketch — ControlContext takes `paths: RunPaths` and a required `feature`,
// never a bare run id; both are already what the view routes read to fold a ShellView, so the command
// route reads the same state rather than re-deriving them differently.
const handlePostCommand = async (runId: string, key: string, argument: string | null) => {
  const context: ControlContext = {
    paths: runPaths(runId, orchHome),
    feature: featureOf(runId), // read from the same state the view routes already load
    source: 'web',
    principal: { kind: 'user', id: 'local' },
  };
  return invokeControlByKey(key, context, argument);
};
```

## Verification

Run by me, exit status captured to a variable and output kept in a file:
`npm run typecheck && npm run lint && npm run build && npm test` — **exit 0, 2815 tests across 96
files, zero failures, zero skips**, run a final time after the review round's patches. The
implementation reached 2807/96 (verified independently before dispatching review); the review-round
patches took it to 2815/96.

**Verified by me directly in the patched code, not taken on report:**
- The crash-isolation fix in `src/web/sse.ts`: `stop` is a hoisted function declaration, not a `const`
  arrow function, specifically because `push`'s own catch branch calls it on its first, synchronous
  invocation (before a `const` in the same scope would be initialized) — confirmed this reads correctly
  and both `res.on('close', stop)` and `res.on('error', stop)` are wired.
- The server-level persistent error handler (`server.on('error', ...)` after startup, distinct from the
  one-time startup listener that is still removed on success) and the request-body size cap's choice not
  to call `req.destroy()` (which would tear down the shared HTTP/1.1 connection before a clean refusal
  could be sent over it) — both read correctly against their own stated reasoning.

**Matrix Test Audit.** All nine rows are covered by tests that ran and passed in the run above,
including this round's additions: a real end-to-end SSE test connecting to the running server (not
`startSseStream` directly, closing the gap intent-alignment found), and the rewritten row-4 test that
calls `invokeControlByKey` directly to demonstrate the file-based path's independence rather than only
asserting a fixture file is readable.

**Manual checks (if no CLI):**
- Start `bin/orch-web.ts` locally against a real run directory, open the served page in a browser,
  confirm the view renders and updates, and confirm a command posted from the page produces the same
  durable command-intent file the TUI would write for the same keystroke.

## Auto Run Result

**Status: done, reviewed.** A second renderer exists: a loopback-only HTTP server with one SSE endpoint
per run and a minimal, dependency-free page, reusing `loadShellView`/`foldFleet` for every view and
`invokeControlByKey` for every command — Command-enum parity by construction, since a command handled by
`CONTROLS` is reachable here through the same dispatch table the TUI already uses, not a second
implementation to keep in sync.

**26 findings — high 5, medium 7, low 14 — routed 17 patch, 6 defer, 3 reject.** The most serious: three
separate paths (the server's own post-startup error handling, an SSE response's unhandled `'error'`
event, and the poll-and-diff callback's own re-fold) could let a single connection's transient failure
crash the entire process, directly contradicting this story's own guarantee that no connection affects
another. While fixing the SSE isolation, the implementer found and fixed a real bug their own first pass
introduced: `stop` was a `const` arrow function called from `push`'s own first, synchronous invocation —
a temporal-dead-zone `ReferenceError`, in exactly the failure path meant to be guarded — caught by their
own test, not shipped. Also patched: a malformed POST body returning an opaque 500 instead of a 400; a
genuine write failure being misreported as the client's fault; the SSE route itself having no end-to-end
test (only the underlying function was unit-tested against a fake response); a port-parsing bug that
truncated rather than rejected trailing garbage; no request-origin check on the command route (a
"drive-by localhost" surface distinct from the authentication this story deliberately does not build);
an unbounded request body; a malformed percent-encoded run id throwing uncaught; a wrong-method request
returning 404 instead of 405; and an unguarded frontend `fetch()` that could throw uncaught on an error
response. One test (named for matrix row 4) was rewritten because it didn't demonstrate the property it
claimed to, even though the property itself held.

**Three findings were rejected as spec-prose issues, not code defects:** the fleet listing's own 5-second
poll rather than an SSE stream is exactly what this story's own spec scoped ("one SSE endpoint per
run," never a fleet-level stream); matrix row 9's non-loopback-bind case is satisfied by there being no
`host` option at all, a stronger guarantee than a runtime-guarded and tested one; and the spec's own
"Always" bullet naming `src/web/`'s allowed dependencies omitted `src/tui/` from its literal list even
though the Approach section's reuse mandate — and the shipped, correct dependency-guard test — both
treat it as deliberately allowed. That prose imprecision is mine, corrected here rather than routed as
code work.

**Follow-up review recommended: true.** Two `high` findings were patched, which sets this
unconditionally. The specific unverified risk worth a second look, recorded in `deferred`: `bin/orch-web.ts`
itself has no direct test (matching this codebase's own existing convention for thin entry points, not a
new gap this story introduces alone).

**Residual risks.** See the four-item `deferred` list in the frontmatter: no direct test for the CLI
entry point, the static page's hand-copied control list with nothing enforcing it stays in sync with the
TUI's own table, no accessibility affordances on the optional browser page, and no pagination for the
fleet's "older runs not shown" overflow. None of these affect the file-based command path AD-19
guarantees, which this story's own tests confirm remains fully independent of whether this server runs
at all.
