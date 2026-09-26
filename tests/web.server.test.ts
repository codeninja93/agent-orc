/**
 * The route table, exercised as an HTTP client would — matrix rows 1, 2, 5, 6, 7, 9.
 *
 * Node's own `http` client (`fetch`, built in since Node 18) against a server bound to an ephemeral
 * loopback port: no supertest, no new dependency. `writeCommandIntent`'s own file, and `loadShellView`'s
 * own fold, are already tested elsewhere; this suite asserts that the *routes* reach them unmodified and
 * refuse cleanly when they should, not that the fold or the write is correct in the first place.
 */
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { get, request } from 'node:http';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Principal } from '../src/contracts/index.js';
import { runPaths } from '../src/runtime/index.js';
import { foldFleet, invokeControlByKey, loadShellView } from '../src/tui/index.js';
import type { WebServerHandle } from '../src/web/index.js';
import { startWebServer } from '../src/web/index.js';

import { makeHome } from './helpers/engine-fixture.js';
import {
  FIXTURE_FEATURE,
  FIXTURE_RUN,
  buildLog,
  featureStateChanged,
  logText,
  runCreated,
  stepStarted,
} from './helpers/tui-log.js';

interface CommandResponseBody {
  readonly command?: string;
  readonly intentId?: string;
  readonly error?: string;
}

interface WrittenIntent {
  readonly command: string;
  readonly source: string;
  readonly principal: Principal;
}

interface FleetRunSummary {
  readonly runId: string;
  readonly view: { readonly feature: string | null };
}

interface FleetResponseBody {
  readonly runs: readonly FleetRunSummary[];
  readonly notRead: number;
}

interface RunResponseBody {
  readonly featureState: string | null;
  readonly problem: string | null;
}

let home: string;
const toRemove: string[] = [];
const toClose: WebServerHandle[] = [];

beforeEach(() => {
  home = makeHome('web-server');
  toRemove.push(home);
});

afterEach(async () => {
  for (const handle of toClose.splice(0)) await handle.close();
  for (const dir of toRemove.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const start = async (): Promise<WebServerHandle> => {
  const handle = await startWebServer({ orchHome: home, port: 0 });
  toClose.push(handle);
  return handle;
};

/** A run in progress, with one running step, written directly to the fixture's `events.jsonl`. */
const writeRun = (runId: string = FIXTURE_RUN): void => {
  const paths = runPaths(runId, home);
  mkdirSync(paths.runDir, { recursive: true });
  writeFileSync(
    paths.eventLog,
    logText(
      buildLog(
        [
          runCreated(),
          featureStateChanged('confirmed'),
          featureStateChanged('running', 'confirmed'),
          stepStarted('implement'),
        ],
        { run: runId },
      ),
    ),
    'utf8',
  );
};

const baseUrl = (handle: WebServerHandle): string => `http://127.0.0.1:${String(handle.port)}`;

const postCommandBody = (
  handle: WebServerHandle,
  runId: string,
  body: unknown,
): Promise<Response> =>
  fetch(`${baseUrl(handle)}/api/runs/${runId}/commands`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

describe('binds loopback only (matrix row 9, AD-3)', () => {
  it('listens on 127.0.0.1 and reports the bound port', async () => {
    const handle = await start();
    expect(handle.port).toBeGreaterThan(0);
    const address = handle.server.address();
    expect(typeof address === 'object' && address !== null ? address.address : null).toBe('127.0.0.1');
  });

  it('refuses to start rather than silently falling back when the port is already in use', async () => {
    const first = await start();
    await expect(startWebServer({ orchHome: home, port: first.port })).rejects.toThrow();
  });
});

describe('row 1 — a run’s view is exactly loadShellView, unmodified', () => {
  it('returns the same JSON the fold itself produces', async () => {
    writeRun();
    const handle = await start();
    const response = await fetch(`${baseUrl(handle)}/api/runs/${FIXTURE_RUN}`);
    expect(response.status).toBe(200);
    const body: unknown = await response.json();
    const expected: unknown = JSON.parse(
      JSON.stringify(loadShellView(runPaths(FIXTURE_RUN, home).eventLog)),
    );
    expect(body).toStrictEqual(expected);
  });

  it('folds an absent run as an idle view rather than a failure', async () => {
    const handle = await start();
    const response = await fetch(`${baseUrl(handle)}/api/runs/no-such-run`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as RunResponseBody;
    expect(body.featureState).toBeNull();
    expect(body.problem).toBeNull();
  });
});

describe('row 2 — the fleet route is exactly foldFleet, unmodified', () => {
  it('returns the same JSON the fold itself produces', async () => {
    writeRun();
    const handle = await start();
    const response = await fetch(`${baseUrl(handle)}/api/fleet`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as FleetResponseBody;
    const expected: unknown = JSON.parse(JSON.stringify(foldFleet({ orchHome: home })));
    expect(body).toStrictEqual(expected);
    expect(body.runs).toHaveLength(1);
    expect(body.runs[0]?.view.feature).toBe(FIXTURE_FEATURE);
  });
});

describe('row 5 — a posted command runs through invokeControlByKey and writes a durable intent', () => {
  it('applies "approve" (key "y") with source web and the fixed local principal', async () => {
    writeRun();
    const handle = await start();
    const response = await postCommandBody(handle, FIXTURE_RUN, { key: 'y' });
    expect(response.status).toBe(200);
    const body = (await response.json()) as CommandResponseBody;
    expect(body.command).toBe('approve');
    expect(typeof body.intentId).toBe('string');

    const paths = runPaths(FIXTURE_RUN, home);
    const files = readdirSync(paths.commandsDir).filter((name) => name.endsWith('.json'));
    expect(files).toHaveLength(1);
    const intentFile = files[0];
    if (intentFile === undefined) throw new Error('expected one written intent file');
    const intent = JSON.parse(readFileSync(`${paths.commandsDir}/${intentFile}`, 'utf8')) as WrittenIntent;
    expect(intent.command).toBe('approve');
    expect(intent.source).toBe('web');
    expect(intent.principal).toStrictEqual({ kind: 'user', id: 'local' });
  });

  it('refuses a control that requires text and was given none, without writing a file', async () => {
    writeRun();
    const handle = await start();
    // "reject" (key "n") requires an argument.
    const response = await postCommandBody(handle, FIXTURE_RUN, { key: 'n' });
    expect(response.status).toBe(400);
    const body = (await response.json()) as CommandResponseBody;
    expect(typeof body.error).toBe('string');

    const paths = runPaths(FIXTURE_RUN, home);
    let files: string[] = [];
    try {
      files = readdirSync(paths.commandsDir);
    } catch {
      files = [];
    }
    expect(files.filter((name) => name.endsWith('.json'))).toHaveLength(0);
  });
});

describe('row 6 — a key outside the Command enum is a clear refusal, not a dispatch attempt', () => {
  it('reports the null invokeControlByKey returns as a 400 with a reason', async () => {
    writeRun();
    const handle = await start();
    const response = await postCommandBody(handle, FIXTURE_RUN, { key: 'not-a-real-key' });
    expect(response.status).toBe(400);
    const body = (await response.json()) as CommandResponseBody;
    expect(body.error).toContain('not-a-real-key');
  });
});

describe('row 7 — a run id that does not exist is refused, never an opaque 500', () => {
  it('answers 404 with a clear reason for a run with no directory', async () => {
    const handle = await start();
    const response = await postCommandBody(handle, 'never-created', { key: 'y' });
    expect(response.status).toBe(404);
    const body = (await response.json()) as CommandResponseBody;
    expect(body.error).toContain('never-created');
  });

  it('answers 400 rather than crashing for a run id that cannot be a path segment', async () => {
    const handle = await start();
    const response = await postCommandBody(handle, encodeURIComponent('../etc'), { key: 'y' });
    expect(response.status).toBe(400);
    const body = (await response.json()) as CommandResponseBody;
    expect(typeof body.error).toBe('string');
  });

  it('refuses a command for a run directory that exists but has recorded no feature yet', async () => {
    const runId = 'not-yet-created';
    mkdirSync(runPaths(runId, home).runDir, { recursive: true });
    const handle = await start();
    const response = await postCommandBody(handle, runId, { key: 'y' });
    expect(response.status).toBe(400);
    const body = (await response.json()) as CommandResponseBody;
    expect(body.error).toContain('feature');
  });
});

describe('every steering control still works with no web server running (matrix row 4)', () => {
  it('writes a durable command intent via invokeControlByKey directly — nothing from src/web/ is called', () => {
    writeRun();
    const paths = runPaths(FIXTURE_RUN, home);
    // No `startWebServer`, and nothing else from `src/web/`, anywhere in this test: the TUI's own
    // dispatch is the file-based path, and it must not depend on the web surface existing at all.
    const outcome = invokeControlByKey('y', {
      paths,
      feature: FIXTURE_FEATURE,
      currentStep: null,
      principal: { kind: 'user', id: 'deep' },
      source: 'tui',
    });
    expect(outcome?.command).toBe('approve');
    const files = readdirSync(paths.commandsDir).filter((name) => name.endsWith('.json'));
    expect(files).toHaveLength(1);
    const written = JSON.parse(readFileSync(`${paths.commandsDir}/${String(files[0])}`, 'utf8')) as {
      readonly source: string;
    };
    expect(written.source).toBe('tui');
  });
});

describe('request-origin validation on a POST (not authentication — AD-3’s loopback bind is that)', () => {
  it('refuses a POST whose Origin header does not match this server’s own loopback origin', async () => {
    writeRun();
    const handle = await start();
    const response = await fetch(`${baseUrl(handle)}/api/runs/${FIXTURE_RUN}/commands`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'http://evil.example' },
      body: JSON.stringify({ key: 'y' }),
    });
    expect(response.status).toBe(403);
  });

  it('allows a POST whose Origin matches the server’s own loopback origin', async () => {
    writeRun();
    const handle = await start();
    const response = await fetch(`${baseUrl(handle)}/api/runs/${FIXTURE_RUN}/commands`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: baseUrl(handle) },
      body: JSON.stringify({ key: 'y' }),
    });
    expect(response.status).toBe(200);
  });

  it('allows a POST carrying no Origin header at all (a non-browser caller)', async () => {
    writeRun();
    const handle = await start();
    const response = await postCommandBody(handle, FIXTURE_RUN, { key: 'y' });
    expect(response.status).toBe(200);
  });
});

describe('a request body over the size cap is refused, not fully buffered', () => {
  it('answers 400 for a body far larger than a control argument ever needs', async () => {
    writeRun();
    const handle = await start();
    const response = await postCommandBody(handle, FIXTURE_RUN, {
      key: 'i',
      argument: 'x'.repeat(200 * 1024),
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as CommandResponseBody;
    expect(typeof body.error).toBe('string');
  });
});

describe('a malformed percent-encoded run id is a clean 400, not an uncaught URIError', () => {
  it('answers 400 for a bare "%" in the run id segment', async () => {
    const handle = await start();
    const status = await new Promise<number>((resolvePromise, rejectPromise) => {
      const req = request(
        { host: '127.0.0.1', port: handle.port, method: 'GET', path: '/api/runs/%/events' },
        (res) => {
          res.resume();
          resolvePromise(res.statusCode ?? 0);
        },
      );
      req.on('error', rejectPromise);
      req.end();
    });
    expect(status).toBe(400);
  });
});

describe('a valid path with the wrong method is a 405, not a generic 404', () => {
  it('names the accepted method for a GET-only route posted to', async () => {
    writeRun();
    const handle = await start();
    const response = await fetch(`${baseUrl(handle)}/api/runs/${FIXTURE_RUN}`, { method: 'POST' });
    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toBe('GET');
  });

  it('names the accepted method for the POST-only commands route fetched with GET', async () => {
    writeRun();
    const handle = await start();
    const response = await fetch(`${baseUrl(handle)}/api/runs/${FIXTURE_RUN}/commands`);
    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toBe('POST');
  });
});

describe('the real SSE route streams a real frame end to end (not just startSseStream directly)', () => {
  it('connects to /api/runs/:id/events on the running server and receives one frame', async () => {
    writeRun();
    const handle = await start();
    const { contentType, frame } = await new Promise<{ contentType: string | undefined; frame: string }>(
      (resolvePromise, rejectPromise) => {
        const req = get(`${baseUrl(handle)}/api/runs/${FIXTURE_RUN}/events`, (res) => {
          let buffer = '';
          res.on('data', (chunk: Buffer) => {
            buffer += chunk.toString('utf8');
            if (buffer.includes('\n\n')) {
              req.destroy();
              resolvePromise({ contentType: res.headers['content-type'], frame: buffer });
            }
          });
          res.on('error', rejectPromise);
        });
        req.on('error', rejectPromise);
      },
    );
    expect(contentType).toContain('text/event-stream');
    expect(frame).toContain('event: message');
    expect(frame).toContain('data: {');
    expect(frame).toContain(FIXTURE_FEATURE);
  });
});

describe('serves the static page at the root', () => {
  it('returns HTML that references the SSE endpoint and the commands route', async () => {
    const handle = await start();
    const response = await fetch(`${baseUrl(handle)}/`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');
    const html = await response.text();
    expect(html).toContain('EventSource');
    expect(html).toContain('/commands');
  });
});
