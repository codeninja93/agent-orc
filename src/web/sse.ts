/**
 * The poll-and-diff SSE loop: an interval calling `loadShellView`, pushing a frame only on change.
 *
 * "Poll-and-diff, not file-tailing" is the story's own boundary: the TUI's Ink render loop already
 * redraws by polling at an interval, so this is the same model running in a `setInterval` instead of a
 * terminal frame, rather than a second, bespoke file-watching mechanism. A client's own reconnect
 * (`EventSource`'s built-in retry) is the recovery path for a dropped connection; nothing here resumes
 * from a byte offset.
 *
 * The interval is injectable so a suite can drive a poll deterministically rather than waiting on real
 * wall-clock timing (matrix rows 2, 3, 8): pass fakes that capture the callback instead of scheduling
 * it, and call the captured callback to simulate a tick.
 *
 * Two connections to the same run are two independent calls to this function, each closing over its
 * own `lastSent` and its own interval — nothing here is shared state between them, so nothing about one
 * client's connection can affect another's (matrix row 8). Both read the same durable log through the
 * same `runView`.
 */
import type { ServerResponse } from 'node:http';

import { runPaths } from '../runtime/index.js';
import { runView } from './views.js';

/** How often the loop polls when a caller declares no interval of its own. */
export const DEFAULT_SSE_POLL_INTERVAL_MS = 1_000;

export interface SseStreamOptions {
  readonly runId: string;
  readonly orchHome: string;
  readonly intervalMs?: number;
  /** Injectable scheduler, so a suite need not depend on real timers. */
  readonly setIntervalFn?: (callback: () => void, ms: number) => NodeJS.Timeout;
  readonly clearIntervalFn?: (timer: NodeJS.Timeout) => void;
}

/** Stop the poll loop and, if the connection is still open, end it. Idempotent. */
export type StopSseStream = () => void;

/**
 * Write one SSE `message` event carrying the current view as JSON.
 *
 * `runPaths` is resolved once, up front, so a malformed run id throws *before* any header is written —
 * the caller can still answer with a clean refusal rather than a stream that opened and then had
 * nothing more to say. A run whose log cannot be read once the stream is open is not a failure of the
 * stream: `runView`/`loadShellView` already answers that as a view carrying `problem`, which is pushed
 * like any other change rather than closing the connection.
 */
export const startSseStream = (res: ServerResponse, options: SseStreamOptions): StopSseStream => {
  // Validated eagerly: an unsafe run id must refuse the request, not open a stream with nothing to say.
  runPaths(options.runId, options.orchHome);

  const intervalMs = options.intervalMs ?? DEFAULT_SSE_POLL_INTERVAL_MS;
  const setIntervalFn = options.setIntervalFn ?? setInterval;
  const clearIntervalFn = options.clearIntervalFn ?? clearInterval;

  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
  });

  let lastSent: string | null = null;
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;

  // A hoisted function declaration, deliberately not a `const` arrow function: `push`'s catch branch
  // (below) calls `stop` on its very first, synchronous invocation, before a `const stop = …` in this
  // same scope would yet be initialised — calling it then would be a `ReferenceError`, in exactly the
  // failure path this exists to guard.
  function stop(): void {
    if (stopped) return;
    stopped = true;
    if (timer !== null) clearIntervalFn(timer);
    try {
      if (!res.writableEnded) res.end();
    } catch {
      // The socket already dropped (the `'error'` path below); nothing more to end.
    }
  }

  const push = (): void => {
    if (stopped) return;
    // A read/fold failure here must end only *this* connection, never the process — the same isolation
    // matrix row 8 requires between two connections applies to a connection and the server itself.
    let serialized: string;
    try {
      serialized = JSON.stringify(runView(options.runId, options.orchHome));
    } catch {
      stop();
      return;
    }
    if (serialized === lastSent) return;
    lastSent = serialized;
    res.write(`event: message\ndata: ${serialized}\n\n`);
  };

  // The current view arrives immediately on connect (matrix row 3), before the first interval fires.
  push();
  timer = setIntervalFn(push, intervalMs);

  // Both a clean close and an abrupt socket error must stop this connection's own loop; neither may
  // reach the process (an unhandled `'error'` on a response would otherwise crash it).
  res.on('close', stop);
  res.on('error', stop);
  return stop;
};
