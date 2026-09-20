/**
 * AD-30 — one engine instance per `ORCH_HOME`.
 *
 * Three matrix rows live here: a held lock is refused naming the holder's pid and start time, a stale
 * lock whose recorded pid is gone is reclaimed, and the lock is never stolen from a live holder. The
 * cross-process cases are driven by a real second process: the in-process holder map would refuse a
 * second acquire before the lock file was consulted, so a single-process test would report success
 * without exercising the mechanism the guarantee actually rests on.
 */
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { dispositionFor } from '../src/contracts/index.js';
import {
  ENGINE_LOCK_FILE_NAME,
  EngineLockHeldError,
  acquireEngineLock,
  engineLockPath,
  pidIsAlive,
  readEngineLockClaim,
} from '../src/engine/index.js';

/**
 * Spawning a child that loads the engine through `jiti` compiles the whole tree in that process, which
 * comfortably exceeds Vitest's 5s default while other suites run in parallel. The bound is generous on
 * purpose: it exists so a genuine hang fails rather than runs forever, not to measure startup.
 */
const SPAWN_TIMEOUT_MS = 60_000;

let home: string;
const children: ChildProcess[] = [];

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'orch-engine-lock-'));
});

afterEach(() => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
  rmSync(home, { recursive: true, force: true });
});

describe('the lock file records what AD-30 requires', () => {
  it('lives at ORCH_HOME/engine.lock and records pid, host and start time', () => {
    const lock = acquireEngineLock({ orchHome: home });
    try {
      expect(lock.path).toBe(join(home, ENGINE_LOCK_FILE_NAME));
      expect(engineLockPath(home)).toBe(lock.path);
      const claim = readEngineLockClaim(lock.path);
      expect(claim?.pid).toBe(process.pid);
      expect(claim?.host).toBe(hostname());
      expect(claim?.since).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      expect(lock.reclaimed).toBe(false);
      expect(lock.isHeld).toBe(true);
    } finally {
      lock.release();
    }
  });

  it('creates ORCH_HOME when it does not exist yet', () => {
    const fresh = join(home, 'nested', 'home');
    const lock = acquireEngineLock({ orchHome: fresh });
    try {
      expect(existsSync(join(fresh, ENGINE_LOCK_FILE_NAME))).toBe(true);
    } finally {
      lock.release();
    }
  });

  it('releases the lock, so the next engine starts cleanly', () => {
    acquireEngineLock({ orchHome: home }).release();
    expect(existsSync(engineLockPath(home))).toBe(false);
    const second = acquireEngineLock({ orchHome: home });
    expect(second.isHeld).toBe(true);
    second.release();
  });

  it('is idempotent on release', () => {
    const lock = acquireEngineLock({ orchHome: home });
    lock.release();
    expect(() => lock.release()).not.toThrow();
    expect(lock.isHeld).toBe(false);
  });

  it('carries the one lock-held code the AD-35 table declares, dispositioned escalate-to-human', () => {
    const lock = acquireEngineLock({ orchHome: home });
    try {
      let raised: EngineLockHeldError | null = null;
      try {
        acquireEngineLock({ orchHome: home });
      } catch (thrown: unknown) {
        raised = thrown as EngineLockHeldError;
      }
      expect(raised?.code).toBe('engine.lock_held');
      // Read from the table rather than restated: a person deciding which engine lives is the only
      // correct outcome, and no amount of retrying reaches it.
      expect(dispositionFor(raised?.code ?? '')).toBe('escalate-to-human');
    } finally {
      lock.release();
    }
  });
});

describe('a held lock is refused, naming the holder', () => {
  it('refuses a second engine in this same process and says so', () => {
    const lock = acquireEngineLock({ orchHome: home });
    try {
      expect(() => acquireEngineLock({ orchHome: home })).toThrowError(EngineLockHeldError);
      expect(() => acquireEngineLock({ orchHome: home })).toThrowError(
        /this same process already holds it/,
      );
    } finally {
      lock.release();
    }
  });

  it('refuses a second engine in another process, naming the holder pid and start time', async () => {
    const holder = await spawnHolder();
    let raised: EngineLockHeldError | null = null;
    try {
      acquireEngineLock({ orchHome: home });
    } catch (thrown: unknown) {
      raised = thrown as EngineLockHeldError;
    }

    expect(raised).toBeInstanceOf(EngineLockHeldError);
    expect(raised?.message).toContain(String(holder.pid));
    expect(raised?.message).toContain(holder.since);
    expect(raised?.holder?.pid).toBe(holder.pid);
    // AD-30 — the lock is not stolen: the file still names the holder after the refusal.
    expect(readEngineLockClaim(engineLockPath(home))?.pid).toBe(holder.pid);
  }, SPAWN_TIMEOUT_MS);

  it('never steals a lock naming a live pid, even with reclamation enabled', async () => {
    const holder = await spawnHolder();
    expect(() => acquireEngineLock({ orchHome: home, reclaimStale: true })).toThrowError(
      EngineLockHeldError,
    );
    expect(readEngineLockClaim(engineLockPath(home))?.pid).toBe(holder.pid);
  }, SPAWN_TIMEOUT_MS);

  it('refuses rather than reclaims when reclamation is switched off, even for a dead pid', async () => {
    writeClaim({ pid: await deadPid(), host: hostname(), since: '2026-09-19T00:00:00.000Z' });
    expect(() => acquireEngineLock({ orchHome: home, reclaimStale: false })).toThrowError(
      EngineLockHeldError,
    );
  });

  it('refuses an unreadable lock file rather than reclaiming it, and says no holder can be named', () => {
    writeFileSync(engineLockPath(home), 'this is not a claim\n', 'utf8');
    expect(() => acquireEngineLock({ orchHome: home })).toThrowError(
      /is held by an unreadable lock file/,
    );
  });

  it('refuses a lock recording a foreign host, whose pid says nothing about this machine', async () => {
    writeClaim({ pid: await deadPid(), host: 'some-other-machine', since: '2026-09-19T00:00:00.000Z' });
    // The recorded process may be alive over there; reclaiming would produce the two-engine interleave.
    expect(() => acquireEngineLock({ orchHome: home })).toThrowError(EngineLockHeldError);
  });

  it.each([0, -1, -12345, 1.5])('treats the impossible pid %s as held rather than reclaimable', (pid) => {
    // `process.kill(0, 0)` signals the caller's own group, so a naive liveness probe would read pid 0
    // as *dead* and let a second engine in against a lock it could not account for.
    writeClaim({ pid, host: hostname(), since: '2026-09-19T00:00:00.000Z' });
    expect(pidIsAlive(pid)).toBe(true);
    expect(() => acquireEngineLock({ orchHome: home })).toThrowError(EngineLockHeldError);
  });
});

describe('a stale lock is reclaimed once the recorded pid is verifiably gone', () => {
  it('reclaims a lock whose pid has exited, and reports that it did', async () => {
    writeClaim({ pid: await deadPid(), host: hostname(), since: '2026-09-19T00:00:00.000Z' });
    const lock = acquireEngineLock({ orchHome: home });
    try {
      expect(lock.reclaimed).toBe(true);
      expect(readEngineLockClaim(lock.path)?.pid).toBe(process.pid);
    } finally {
      lock.release();
    }
  });

  it('reclaims the lock a crashed engine left behind, produced by a real SIGKILL', async () => {
    const crashed = await spawnHolder(['--crash']);
    // The lock file survives the kill, naming a pid that is now gone.
    expect(readEngineLockClaim(engineLockPath(home))?.pid).toBe(crashed.pid);
    expect(pidIsAlive(crashed.pid)).toBe(false);

    const lock = acquireEngineLock({ orchHome: home });
    try {
      expect(lock.reclaimed).toBe(true);
      expect(readEngineLockClaim(lock.path)?.pid).toBe(process.pid);
    } finally {
      lock.release();
    }
  }, SPAWN_TIMEOUT_MS);

  it('does not let a previous holder\u2019s release strip the claim of the engine that reclaimed it', async () => {
    // The sequence that would break AD-30 from the other direction: A stops responding, B reclaims the
    // stale lock, then A's own `release` runs and unlinks *B's* claim — leaving the lock free while B is
    // still appending. `release` therefore compares the recorded claim before removing anything.
    const departing = acquireEngineLock({ orchHome: home });
    const successor = { pid: await deadPid(), host: hostname(), since: '2026-09-19T00:00:00.000Z' };
    writeClaim(successor);

    departing.release();

    expect(existsSync(engineLockPath(home))).toBe(true);
    expect(readEngineLockClaim(engineLockPath(home))?.pid).toBe(successor.pid);
  });
});

/** Overwrite the lock file with a hand-made claim, for the states a real process cannot produce. */
const writeClaim = (claim: { pid: number; host: string; since: string }): void => {
  mkdirSync(home, { recursive: true });
  writeFileSync(engineLockPath(home), `${JSON.stringify(claim)}\n`, 'utf8');
};

/** A pid that has certainly exited, for the stale-lock reclamation rule. */
const deadPid = async (): Promise<number> => {
  const probe = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
  const pid = probe.pid ?? -1;
  await once(probe, 'exit');
  return pid;
};

/** Spawn a real second engine that takes the lock, and wait until it has. */
const spawnHolder = async (
  flags: readonly string[] = [],
): Promise<{ readonly pid: number; readonly since: string }> => {
  const child = spawn(
    process.execPath,
    [
      '--import',
      fileURLToPath(new URL('../node_modules/jiti/lib/jiti-register.mjs', import.meta.url)),
      fileURLToPath(new URL('helpers/hold-engine-lock.ts', import.meta.url)),
      home,
      ...flags,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  children.push(child);
  // Attach the exit listener now, before the child can exit. `once(child, 'exit')` called
  // later would wait forever for an event that already fired — which is what made the
  // --crash case hang: that child kills itself immediately after announcing.
  const exited = once(child, 'exit');

  /**
   * Wait for the claim event-driven rather than by polling `read()`, and treat the child exiting
   * before it announces as an immediate failure carrying its stderr.
   *
   * The `--crash` child kills itself on the statement after the announcement, so `exit` and the
   * announcement race by design: stdout is therefore drained once more on exit before deciding, and
   * only a genuinely silent child fails. Polling for 20s instead turned any child-side throw — a
   * lock file left by an earlier test, for one — into an opaque timeout whose message printed
   * stdout while claiming to print stderr.
   */
  let announced = '';
  let childErr = '';
  child.stdout?.on('data', (chunk: Buffer) => {
    announced += chunk.toString('utf8');
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    childErr += chunk.toString('utf8');
  });

  await new Promise<void>((resolve, reject) => {
    const settle = (): boolean => {
      if (!announced.includes('\n')) return false;
      resolve();
      return true;
    };
    if (settle()) return;
    const timer = setInterval(() => {
      if (settle()) clearInterval(timer);
    }, 5);
    child.once('exit', (code, signal) => {
      // Drain whatever arrived with, or just before, the exit before calling it silent.
      setImmediate(() => {
        if (settle()) {
          clearInterval(timer);
          return;
        }
        clearInterval(timer);
        reject(
          new Error(
            `the lock holder exited (code ${String(code)}, signal ${String(signal)}) without announcing its claim; ` +
              `stdout: ${JSON.stringify(announced)}; stderr: ${JSON.stringify(childErr)}`,
          ),
        );
      });
    });
    const deadline = setTimeout(() => {
      if (!settle()) {
        clearInterval(timer);
        reject(
          new Error(
            `the lock holder never announced its claim within 15s; stdout: ${JSON.stringify(announced)}; ` +
              `stderr: ${JSON.stringify(childErr)}`,
          ),
        );
      }
    }, 15_000);
    void Promise.resolve().then(() => undefined);
    // Whichever branch settles first, neither timer may outlive this wait.
    const stop = (): void => {
      clearInterval(timer);
      clearTimeout(deadline);
    };
    void exited.then(stop, stop);
  });

  const claim = JSON.parse(announced.trim()) as { pid: number; since: string };

  if (flags.includes('--crash')) {
    await exited;
    // The file is the only evidence the crashed engine leaves; the claim it announced must match it.
    expect(readFileSync(engineLockPath(home), 'utf8')).toContain(String(claim.pid));
  }
  return claim;
};
