/**
 * The poll-and-diff SSE loop — matrix rows 2 (task 2), 3, 8.
 *
 * `startSseStream` is exercised directly against a minimal double of `http.ServerResponse`, with an
 * injected scheduler that captures the poll callback instead of scheduling it against a real timer —
 * so a tick is simulated by calling the captured callback, and nothing here depends on wall-clock
 * timing at all.
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import type { ServerResponse } from 'node:http';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runPaths } from '../src/runtime/index.js';
import { startSseStream } from '../src/web/index.js';
import type { ShellView } from '../src/tui/index.js';

import { makeHome } from './helpers/engine-fixture.js';
import { FIXTURE_RUN, buildLog, featureStateChanged, logText, runCreated } from './helpers/tui-log.js';

interface FakeResponse {
  readonly chunks: string[];
  readonly headers: { status: number; headers: Record<string, string> } | null;
  ended: boolean;
  readonly writableEnded: boolean;
  writeHead: (status: number, headers: Record<string, string>) => void;
  write: (chunk: string) => boolean;
  on: (event: string, callback: () => void) => void;
  end: () => void;
  triggerClose: () => void;
}

const makeFakeResponse = (): FakeResponse => {
  const chunks: string[] = [];
  const closeHandlers: (() => void)[] = [];
  const fake: FakeResponse = {
    chunks,
    headers: null,
    ended: false,
    get writableEnded() {
      return fake.ended;
    },
    writeHead(_status, _headers) {
      // Not asserted here: the content-type and cache-control headers matter to a real client, not to
      // this suite's own claim about *when* an event is written.
    },
    write(chunk) {
      chunks.push(chunk);
      return true;
    },
    on(event, callback) {
      if (event === 'close') closeHandlers.push(callback);
    },
    end() {
      fake.ended = true;
    },
    triggerClose() {
      for (const handler of closeHandlers.splice(0)) handler();
    },
  };
  return fake;
};

/** A scheduler double: `tick()` runs whatever `startSseStream` last handed to `setIntervalFn`. */
const fakeScheduler = (): {
  readonly setIntervalFn: (callback: () => void, ms: number) => NodeJS.Timeout;
  readonly clearIntervalFn: (timer: NodeJS.Timeout) => void;
  readonly tick: () => void;
} => {
  let captured: (() => void) | null = null;
  return {
    setIntervalFn: (callback) => {
      captured = callback;
      return 0 as unknown as NodeJS.Timeout;
    },
    clearIntervalFn: () => {
      captured = null;
    },
    tick: () => {
      captured?.();
    },
  };
};

/** The `data: {...}` payloads written so far, parsed. */
const parsedEvents = (fake: FakeResponse): ShellView[] =>
  fake.chunks.map((chunk) => {
    const match = /^event: message\ndata: (.+)\n\n$/.exec(chunk);
    if (match?.[1] === undefined) throw new Error(`not an SSE frame: ${chunk}`);
    return JSON.parse(match[1]) as ShellView;
  });

let home: string;
const toRemove: string[] = [];

beforeEach(() => {
  home = makeHome('web-sse');
  toRemove.push(home);
});

afterEach(() => {
  for (const dir of toRemove.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const writeInitialRun = (): void => {
  const paths = runPaths(FIXTURE_RUN, home);
  mkdirSync(paths.runDir, { recursive: true });
  writeFileSync(paths.eventLog, logText(buildLog([runCreated()])), 'utf8');
};

describe('row 3 — the current view arrives immediately, then only on change', () => {
  it('sends exactly one frame on connect and none for an unchanged poll', () => {
    writeInitialRun();
    const fake = makeFakeResponse();
    const scheduler = fakeScheduler();
    startSseStream(fake as unknown as ServerResponse, {
      runId: FIXTURE_RUN,
      orchHome: home,
      setIntervalFn: scheduler.setIntervalFn,
      clearIntervalFn: scheduler.clearIntervalFn,
    });

    expect(fake.chunks).toHaveLength(1);
    expect(parsedEvents(fake)[0]?.featureState).toBe('drafting');

    // The log has not changed, so a poll tick must push nothing new.
    scheduler.tick();
    scheduler.tick();
    expect(fake.chunks).toHaveLength(1);
  });

  it('pushes a new frame once the folded view actually changes', () => {
    writeInitialRun();
    const fake = makeFakeResponse();
    const scheduler = fakeScheduler();
    startSseStream(fake as unknown as ServerResponse, {
      runId: FIXTURE_RUN,
      orchHome: home,
      setIntervalFn: scheduler.setIntervalFn,
      clearIntervalFn: scheduler.clearIntervalFn,
    });
    expect(fake.chunks).toHaveLength(1);

    const paths = runPaths(FIXTURE_RUN, home);
    writeFileSync(
      paths.eventLog,
      logText(buildLog([runCreated(), featureStateChanged('confirmed')])),
      'utf8',
    );
    scheduler.tick();
    expect(fake.chunks).toHaveLength(2);
    expect(parsedEvents(fake)[1]?.featureState).toBe('confirmed');

    // Ticking again with no further change pushes nothing new.
    scheduler.tick();
    expect(fake.chunks).toHaveLength(2);
  });

  it('stops polling and ends the response once the connection closes', () => {
    writeInitialRun();
    const fake = makeFakeResponse();
    const scheduler = fakeScheduler();
    startSseStream(fake as unknown as ServerResponse, {
      runId: FIXTURE_RUN,
      orchHome: home,
      setIntervalFn: scheduler.setIntervalFn,
      clearIntervalFn: scheduler.clearIntervalFn,
    });

    fake.triggerClose();
    expect(fake.ended).toBe(true);

    const paths = runPaths(FIXTURE_RUN, home);
    writeFileSync(
      paths.eventLog,
      logText(buildLog([runCreated(), featureStateChanged('confirmed')])),
      'utf8',
    );
    scheduler.tick();
    // No new frame after close, even though the underlying log changed.
    expect(fake.chunks).toHaveLength(1);
  });
});

describe('row 8 — two connections to the same run are independent, over the same durable log', () => {
  it('both receive the same events, and one connection’s poll never affects the other', () => {
    writeInitialRun();
    const first = makeFakeResponse();
    const firstScheduler = fakeScheduler();
    startSseStream(first as unknown as ServerResponse, {
      runId: FIXTURE_RUN,
      orchHome: home,
      setIntervalFn: firstScheduler.setIntervalFn,
      clearIntervalFn: firstScheduler.clearIntervalFn,
    });

    const second = makeFakeResponse();
    const secondScheduler = fakeScheduler();
    startSseStream(second as unknown as ServerResponse, {
      runId: FIXTURE_RUN,
      orchHome: home,
      setIntervalFn: secondScheduler.setIntervalFn,
      clearIntervalFn: secondScheduler.clearIntervalFn,
    });

    expect(first.chunks).toHaveLength(1);
    expect(second.chunks).toHaveLength(1);
    expect(parsedEvents(first)).toStrictEqual(parsedEvents(second));

    // Ticking only the first connection's scheduler must not push anything to the second.
    firstScheduler.tick();
    expect(first.chunks).toHaveLength(1);
    expect(second.chunks).toHaveLength(1);

    const paths = runPaths(FIXTURE_RUN, home);
    writeFileSync(
      paths.eventLog,
      logText(buildLog([runCreated(), featureStateChanged('confirmed')])),
      'utf8',
    );

    // Only the second connection polls after the change; the first has not, and must not have caught
    // up on its own.
    secondScheduler.tick();
    expect(second.chunks).toHaveLength(2);
    expect(first.chunks).toHaveLength(1);

    firstScheduler.tick();
    expect(first.chunks).toHaveLength(2);
    expect(parsedEvents(first)[1]).toStrictEqual(parsedEvents(second)[1]);
  });
});
