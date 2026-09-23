/**
 * `bin/jira-server.ts`'s own process lifecycle, driven against the real entry point as a real child
 * process — not the exported functions it is a thin wrapper around.
 *
 * **Why a real subprocess, not an in-process call.** The one thing this file is built to prove —
 * "a signal still ends the process" — is not observable by importing `main()` and calling it: Node's
 * default terminate-on-signal behaviour is a property of the *process*, and registering a `SIGTERM`
 * listener in-process would affect the test runner's own process, not a fact about this script. So the
 * file is spawned for real, over `node bin/jira-server.ts`, exactly as `--mcp-config` starts it.
 *
 * **Review-fix, story 2-10.** A signal handler that only released the standalone fetch record's lock
 * and returned would leave the process alive — registering a listener replaces Node's own
 * terminate-on-signal default, it does not supplement it. Both cases below assert the *lock is gone*
 * and the *process actually exited*, because either one alone would have passed the bug this guards.
 */
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

const BIN_PATH = fileURLToPath(new URL('../bin/jira-server.ts', import.meta.url));

const RUN_ID = '01JBQZ8Q0000000000BINJIRA1';
const STEP = 'analyse';

const homes: string[] = [];
const children: ChildProcess[] = [];

afterEach(() => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

const lockPathFor = (home: string): string => join(home, 'runs', RUN_ID, 'fetch-record.json.lock');

const spawnServer = (home: string): ChildProcess => {
  const child = spawn(process.execPath, [BIN_PATH], {
    env: {
      ...process.env,
      ORCH_HOME: home,
      ORCH_RUN: RUN_ID,
      ORCH_STEP: STEP,
      ORCH_JIRA_CREDENTIAL_ENV: 'JIRA_API_TOKEN',
      ORCH_JIRA_BASE_URL: 'https://example.atlassian.net',
      JIRA_API_TOKEN: 'a-real-secret-value',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  children.push(child);
  return child;
};

const exitOf = (
  child: ChildProcess,
): Promise<{ readonly code: number | null; readonly signal: NodeJS.Signals | null }> =>
  new Promise((resolve) => {
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });

/**
 * Wait for the server to answer a real JSON-RPC call, rather than only for the lock file to exist.
 *
 * The lock is acquired *before* the signal handlers are registered (`createJiraServerFromEnvironment`
 * runs first in `main()`), so polling for the lock file alone leaves a real, if narrow, race under a
 * loaded machine: the child can be pre-empted between acquiring the lock and reaching the `for` loop
 * that registers them, and a signal sent into that window is handled by Node's own default rather than
 * this script's. An answered call proves every synchronous line before `serveJiraServerOverStdio` —
 * handler registration included — has already run.
 */
const untilReady = (child: ChildProcess): Promise<void> =>
  new Promise((resolve, reject) => {
    const onData = (chunk: Buffer): void => {
      if (chunk.toString('utf8').includes('"protocolVersion"')) {
        child.stdout?.off('data', onData);
        resolve();
      }
    };
    child.stdout?.on('data', onData);
    child.once('error', reject);
    child.stdin?.write(`${JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'initialize' })}\n`);
  });

describe('bin/jira-server.ts releases its standalone lock and actually exits', () => {
  it('closing stdin releases the lock and exits with code 0', async () => {
    const home = mkdtempSync(join(tmpdir(), 'orch-jira-bin-'));
    homes.push(home);
    const child = spawnServer(home);

    await untilReady(child);
    expect(existsSync(lockPathFor(home))).toBe(true);

    const exited = exitOf(child);
    child.stdin?.end();

    const { code, signal } = await exited;
    expect(code).toBe(0);
    expect(signal).toBeNull();
    expect(existsSync(lockPathFor(home))).toBe(false);
  }, 10_000);

  it('a SIGTERM releases the lock and still ends the process, rather than being swallowed', async () => {
    const home = mkdtempSync(join(tmpdir(), 'orch-jira-bin-'));
    homes.push(home);
    const child = spawnServer(home);

    await untilReady(child);
    expect(existsSync(lockPathFor(home))).toBe(true);

    const exited = exitOf(child);
    child.kill('SIGTERM');

    const { code, signal } = await exited;
    // The handler calls `process.exit(143)` itself. Node's own default for an unhandled SIGTERM would
    // report `signal: 'SIGTERM'` and `code: null` instead — the distinction that proves the listener
    // does not merely release the lock and leave the process running.
    expect(code).toBe(143);
    expect(signal).toBeNull();
    expect(existsSync(lockPathFor(home))).toBe(false);
  }, 10_000);

  it('a SIGINT releases the lock and still ends the process', async () => {
    const home = mkdtempSync(join(tmpdir(), 'orch-jira-bin-'));
    homes.push(home);
    const child = spawnServer(home);

    await untilReady(child);
    expect(existsSync(lockPathFor(home))).toBe(true);

    const exited = exitOf(child);
    child.kill('SIGINT');

    const { code, signal } = await exited;
    expect(code).toBe(130);
    expect(signal).toBeNull();
    expect(existsSync(lockPathFor(home))).toBe(false);
  }, 10_000);
});
