/**
 * The web control surface: a loopback-only HTTP server, a fixed route table, and nothing else.
 *
 * AD-3: "the web server binds loopback only and serves a single local user." There is no `host` option
 * anywhere in this module's public surface — {@link WEB_BIND_ADDRESS} is the one literal `listen` is
 * ever called with — so binding anywhere else is not a configuration a caller can reach, mirroring
 * `src/container/service.ts`'s `SERVICE_PUBLISH_ADDRESS` precedent named in the story. A bind failure
 * (the port already in use, or any other startup error) rejects the promise this module returns rather
 * than retrying on another port or another interface (matrix row 9).
 *
 * AD-19: every route that changes anything calls `postCommand`, which calls `invokeControlByKey` —
 * nothing here constructs a `CommandIntent` or writes a file itself. Every read route calls
 * `runView`/`fleetView`, which are `loadShellView`/`foldFleet` unmodified. This file is the dispatch
 * table over both; it holds no projection logic and no command logic of its own.
 *
 * No HTTP framework: `node:http` and a handful of regular expressions are the whole of the routing,
 * per the story's "no new HTTP framework dependency" boundary.
 */
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveOrchHome } from '../runtime/index.js';
import { UnsafePathSegmentError } from '../runtime/index.js';

import { postCommand } from './commands.js';
import { DEFAULT_SSE_POLL_INTERVAL_MS, startSseStream } from './sse.js';
import { fleetView, runView } from './views.js';

/** The one interface this server ever binds. Never `0.0.0.0`, never configurable (AD-3). */
export const WEB_BIND_ADDRESS = '127.0.0.1';

/**
 * The package root, resolved from this module rather than from `process.cwd()` — the same idiom
 * `src/container/image.ts`'s `packageRoot` uses, for the same reason: `src/web/server.ts` and
 * `dist/web/server.js` are each two levels down, so both layouts land on the same root, and the
 * static page is read from the checkout (present under AD-12's `npx github:<owner>/<repo>` delivery)
 * rather than needing a bundler step to copy it into `dist/`.
 */
const packageRoot = (): string => resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

const staticIndexPath = (): string => join(packageRoot(), 'src', 'web', 'static', 'index.html');

export interface WebServerOptions {
  readonly orchHome?: string;
  /** `0` (the default) asks the OS for an ephemeral loopback port. */
  readonly port?: number;
  readonly ssePollIntervalMs?: number;
}

export interface WebServerHandle {
  readonly server: Server;
  readonly orchHome: string;
  readonly port: number;
  readonly close: () => Promise<void>;
}

const sendJson = (res: ServerResponse, status: number, body: unknown): void => {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(text);
};

const sendMethodNotAllowed = (res: ServerResponse, allowed: readonly string[]): void => {
  const text = JSON.stringify({ error: `method not allowed; this path accepts ${allowed.join(', ')}` });
  res.writeHead(405, { 'content-type': 'application/json; charset=utf-8', allow: allowed.join(', ') });
  res.end(text);
};

/**
 * Any refusal that is the *client's* own mistake: a malformed body, a field of the wrong shape, a body
 * over the size cap, a run id that is not validly percent-encoded. Mapped to 400 in the one place below
 * that catches every route's errors, so a client mistake is never reported as an opaque 500.
 */
class ClientRequestError extends Error {}

/** How large a posted body may be before the rest of it is dropped rather than buffered. */
const MAX_REQUEST_BODY_BYTES = 64 * 1024;

const readRequestBody = (req: IncomingMessage): Promise<string> =>
  new Promise((resolveBody, rejectBody) => {
    const chunks: Buffer[] = [];
    let receivedBytes = 0;
    let settled = false;
    req.on('data', (chunk: Buffer) => {
      // Once rejected, every further chunk is dropped rather than pushed: a caller posting far more
      // than a control's free-text argument ever needs must not be able to make this process hold it
      // all in memory. The socket itself is left alone — `req.destroy()` here would tear down the
      // *response* too, since a request and its response share one connection under HTTP/1.1 — so the
      // route above is still free to answer with a clean refusal over the same connection.
      if (settled) return;
      receivedBytes += chunk.length;
      if (receivedBytes > MAX_REQUEST_BODY_BYTES) {
        settled = true;
        rejectBody(
          new ClientRequestError(`the request body exceeds ${String(MAX_REQUEST_BODY_BYTES)} bytes`),
        );
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      resolveBody(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', (error) => {
      if (settled) return;
      settled = true;
      rejectBody(error);
    });
  });

interface PostedCommandBody {
  readonly key: string;
  readonly argument: string | null;
}

/** Body-shape validation only — never a second check of the `Command` enum `invokeControlByKey` owns. */
const parsePostedCommandBody = (raw: string): PostedCommandBody => {
  let parsed: unknown;
  try {
    parsed = raw.trim() === '' ? {} : JSON.parse(raw);
  } catch {
    throw new ClientRequestError('the request body is not valid JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new ClientRequestError('the request body must be a JSON object');
  }
  const record = parsed as Record<string, unknown>;
  const key = record['key'];
  if (typeof key !== 'string' || key === '') {
    throw new ClientRequestError('the request body must carry a non-empty string "key"');
  }
  const argument = record['argument'];
  if (argument !== undefined && argument !== null && typeof argument !== 'string') {
    throw new ClientRequestError('"argument", when given, must be a string or null');
  }
  return { key, argument: argument === undefined ? null : argument };
};

/** A run id straight off the URL, decoded — or a clean client refusal for one that is not valid percent-encoding. */
const decodeRunId = (raw: string): string => {
  try {
    return decodeURIComponent(raw);
  } catch {
    throw new ClientRequestError(`"${raw}" is not a validly percent-encoded run id`);
  }
};

/** The server's own origin: what a browser page this server served would send as `Origin`. */
const isAllowedOrigin = (origin: string, port: number): boolean =>
  origin === `http://${WEB_BIND_ADDRESS}:${String(port)}`;

const RUN_ROUTE = /^\/api\/runs\/([^/]+)$/;
const RUN_EVENTS_ROUTE = /^\/api\/runs\/([^/]+)\/events$/;
const RUN_COMMANDS_ROUTE = /^\/api\/runs\/([^/]+)\/commands$/;

const handleRequest = async (
  req: IncomingMessage,
  res: ServerResponse,
  orchHome: string,
  ssePollIntervalMs: number,
  port: number,
): Promise<void> => {
  const url = new URL(req.url ?? '/', `http://${WEB_BIND_ADDRESS}`);
  const { pathname } = url;
  const method = req.method ?? 'GET';

  try {
    // Request-origin validation, not authentication (AD-3 keeps loopback binding as the whole auth
    // boundary): a page from anywhere else on this machine can still reach this port, but a browser
    // page this server did not itself serve is refused before it can change anything.
    const origin = req.headers.origin;
    if (method === 'POST' && origin !== undefined && !isAllowedOrigin(origin, port)) {
      sendJson(res, 403, { error: `origin "${origin}" is not this server's own loopback origin` });
      return;
    }

    if (pathname === '/' || pathname === '/index.html') {
      if (method !== 'GET') return sendMethodNotAllowed(res, ['GET']);
      const html = await readFile(staticIndexPath(), 'utf8');
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(html);
      return;
    }

    if (pathname === '/api/fleet') {
      if (method !== 'GET') return sendMethodNotAllowed(res, ['GET']);
      // Row 2 — unmodified, from `foldFleet` directly.
      sendJson(res, 200, fleetView(orchHome));
      return;
    }

    const runMatch = RUN_ROUTE.exec(pathname);
    if (runMatch !== null) {
      if (method !== 'GET') return sendMethodNotAllowed(res, ['GET']);
      const runId = decodeRunId(runMatch[1] ?? '');
      // Row 1 — unmodified, from `loadShellView` directly.
      sendJson(res, 200, runView(runId, orchHome));
      return;
    }

    const eventsMatch = RUN_EVENTS_ROUTE.exec(pathname);
    if (eventsMatch !== null) {
      if (method !== 'GET') return sendMethodNotAllowed(res, ['GET']);
      const runId = decodeRunId(eventsMatch[1] ?? '');
      // Row 3, 8 — poll-and-diff SSE, one independent loop per connection.
      startSseStream(res, { runId, orchHome, intervalMs: ssePollIntervalMs });
      return;
    }

    const commandsMatch = RUN_COMMANDS_ROUTE.exec(pathname);
    if (commandsMatch !== null) {
      if (method !== 'POST') return sendMethodNotAllowed(res, ['POST']);
      const runId = decodeRunId(commandsMatch[1] ?? '');
      const body = parsePostedCommandBody(await readRequestBody(req));
      // Rows 5, 6, 7 — every effect goes through `postCommand`, which is `invokeControlByKey`.
      const result = postCommand({ runId, orchHome, key: body.key, argument: body.argument });
      if (result.ok) {
        sendJson(res, 200, { command: result.outcome.command, intentId: result.outcome.intentId });
      } else {
        sendJson(res, result.status, { error: result.reason });
      }
      return;
    }

    sendJson(res, 404, { error: `no route for ${method} ${pathname}` });
  } catch (error) {
    // Matrix row 7: never a raw exception surfacing as an opaque 500 — the reason is always stated,
    // and a malformed run id or request body (`UnsafePathSegmentError`, `ClientRequestError`) is the
    // caller's mistake, not the server's.
    const status = error instanceof UnsafePathSegmentError || error instanceof ClientRequestError ? 400 : 500;
    sendJson(res, status, { error: error instanceof Error ? error.message : 'an unexpected error occurred' });
  }
};

/**
 * Start the web control surface. The returned promise resolves once the server is actually listening
 * on loopback, and rejects — refusing to start — on any bind error, including the port already being
 * in use (matrix row 9). Nothing here retries on a different port or interface.
 */
export const startWebServer = (options: WebServerOptions = {}): Promise<WebServerHandle> => {
  const orchHome = options.orchHome ?? resolveOrchHome();
  const ssePollIntervalMs = options.ssePollIntervalMs ?? DEFAULT_SSE_POLL_INTERVAL_MS;

  // Reassigned once `listen` resolves an ephemeral (`0`) port; read per-request by `handleRequest`'s
  // origin check. No request can arrive before `listen`'s callback runs, so this is never read stale.
  let boundPort = options.port ?? 0;

  const server = createServer((req, res) => {
    void handleRequest(req, res, orchHome, ssePollIntervalMs, boundPort);
  });

  return new Promise((resolveHandle, rejectHandle) => {
    const onStartupError = (error: Error): void => {
      rejectHandle(error);
    };
    server.once('error', onStartupError);
    server.listen(options.port ?? 0, WEB_BIND_ADDRESS, () => {
      server.removeListener('error', onStartupError);
      const address = server.address();
      boundPort = typeof address === 'object' && address !== null ? address.port : (options.port ?? 0);
      // A persistent handler for once the server is up: without one, a later server-level error (an
      // `EMFILE` under fd exhaustion, say) has no listener at all, and Node's default behaviour for an
      // unhandled `'error'` event is to throw — crashing this whole process over a fault that has
      // nothing to do with any single connection. Reported, not silently dropped.
      server.on('error', (error: Error) => {
        process.stderr.write(`orch-web: server error: ${error.message}\n`);
      });
      resolveHandle({
        server,
        orchHome,
        port: boundPort,
        close: () =>
          new Promise<void>((resolveClose) => {
            server.close(() => {
              resolveClose();
            });
          }),
      });
    });
  });
};
