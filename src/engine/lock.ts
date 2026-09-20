/**
 * AD-30 — one engine instance per `ORCH_HOME`.
 *
 * Two concurrently running engines on one `ORCH_HOME` would silently interleave writes, which is
 * what the one-writer guarantees of AD-4 and AD-29 exist to prevent. The claim is an exclusively
 * created lock file recording pid, host and start time; a held lock is refused *naming the holder*,
 * and a stale lock is reclaimed only after verifying the recorded pid is gone.
 *
 * "Verifiably gone" is deliberately narrow. A pid is only meaningful on the host that assigned it,
 * so a lock recording another host is never reclaimed — the recorded process may be very much alive
 * over there, and a reclaim would produce exactly the two-engine interleave AD-30 forbids.
 */
import { execFileSync } from 'node:child_process';
import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';

import { formatTimestamp } from '../contracts/index.js';
import { resolveOrchHome } from '../runtime/index.js';

/** The lock file AD-9 places at the root of `ORCH_HOME`. */
export const ENGINE_LOCK_FILE_NAME = 'engine.lock';

export const engineLockPath = (orchHome: string = resolveOrchHome()): string =>
  join(orchHome, ENGINE_LOCK_FILE_NAME);

/** The holder, as recorded in the lock file. AD-30 requires the pid and the start time. */
export interface EngineLockClaim {
  readonly pid: number;
  readonly host: string;
  /** RFC3339 with milliseconds — when this engine took the lock. */
  readonly since: string;
  /**
   * The holder *process's* start time, as the operating system reports it.
   *
   * This is the field that makes a pid meaningful. A pid is a small recycled number: once the holder is
   * gone the kernel is free to hand it to something unrelated, and a liveness probe alone then reports
   * the lock as held by a live process forever — an `ORCH_HOME` that can never be started again, for no
   * reason anyone can see. Comparing the recorded start time against the start time of whatever holds the
   * pid *now* distinguishes "the engine is still running" from "a stranger inherited its number".
   *
   * `null` when the platform would not answer. An unknown start time is never treated as a mismatch, so
   * the fallback is the conservative one: refuse, exactly as before this field existed.
   */
  readonly started_at?: string | null;
}

const isEngineLockClaim = (value: unknown): value is EngineLockClaim => {
  if (typeof value !== 'object' || value === null) return false;
  const claim = value as Record<string, unknown>;
  return (
    typeof claim['pid'] === 'number' &&
    Number.isInteger(claim['pid']) &&
    claim['pid'] > 0 &&
    typeof claim['host'] === 'string' &&
    typeof claim['since'] === 'string'
  );
};

/**
 * The start time of a running process, as `ps` reports it, or `null` when it cannot be read.
 *
 * `ps -o lstart=` is the portable way to ask: Node exposes its *own* start time (via `process.uptime`)
 * but nothing about another process, and reading the recorded holder's start time is the whole point.
 * Both the recording and the checking go through this one function, so the two values are always from the
 * same source and in the same format — comparing a `ps` string against a computed one would compare
 * formatting, not identity.
 *
 * Every failure answers `null`: no `ps`, a pid that has gone, a platform that spells the flag
 * differently. `null` never proves a mismatch, so an unreadable start time leaves the lock held.
 */
export const processStartedAt = (pid: number): string | null => {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    const reported = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5_000,
    }).trim();
    return reported === '' ? null : reported;
  } catch {
    return null;
  }
};

/**
 * Whether the pid a claim records now belongs to a *different* process than the one that took the lock.
 *
 * Both start times must be readable for this to answer `true`. A claim written before this field existed,
 * or a platform that will not answer, leaves the question undecided — and undecided means the lock stands.
 */
export const pidWasRecycled = (claim: EngineLockClaim): boolean => {
  const recorded = claim.started_at;
  if (typeof recorded !== 'string' || recorded === '') return false;
  const current = processStartedAt(claim.pid);
  return current !== null && current !== recorded;
};

/**
 * Refusal to start a second engine. The code is `engine.lock_held`, whose declared AD-35 disposition
 * is `escalate-to-human`: no amount of retrying resolves it, and a person deciding which engine
 * should live is the only correct outcome.
 */
export class EngineLockHeldError extends Error {
  readonly code = 'engine.lock_held';
  readonly lockPath: string;
  readonly holder: EngineLockClaim | null;

  constructor(lockPath: string, holder: EngineLockClaim | null, detail: string) {
    super(
      `Refusing to start: ${lockPath} ${detail}. ` +
        'AD-30 allows exactly one engine per ORCH_HOME, because two would interleave writes to one ' +
        'event log and one state checkpoint. The lock was not stolen.',
    );
    this.name = 'EngineLockHeldError';
    this.lockPath = lockPath;
    this.holder = holder;
  }
}

/**
 * True when a pid is running on this host.
 *
 * `EPERM` means the process exists but belongs to another user, which is still alive. A pid that is
 * not a positive integer is reported alive rather than probed: `process.kill(0, 0)` signals the
 * caller's own process group, so a hand-corrupted lock recording `0` would otherwise read as
 * reclaimable and let a second engine in.
 */
export const pidIsAlive = (pid: number): boolean => {
  if (!Number.isInteger(pid) || pid <= 0) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (thrown: unknown) {
    return (thrown as { code?: string } | null)?.code === 'EPERM';
  }
};

/** Read the recorded claim, or `null` when the file is absent, unreadable or not a claim. */
export const readEngineLockClaim = (lockPath: string): EngineLockClaim | null => {
  try {
    const parsed: unknown = JSON.parse(readFileSync(lockPath, 'utf8'));
    return isEngineLockClaim(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

/** The holder named as AD-30 requires it: by pid and start time. */
export const describeEngineLockHolder = (holder: EngineLockClaim | null): string =>
  holder === null
    ? 'is held by an unreadable lock file, so no holder can be named'
    : `is held by pid ${String(holder.pid)} on ${holder.host}, started at ${holder.since}` +
      (typeof holder.started_at === 'string' && holder.started_at !== ''
        ? ` (that process started ${holder.started_at})`
        : '');

export interface EngineLockOptions {
  /** `ORCH_HOME`; defaults to the AD-9 resolution. */
  readonly orchHome?: string;
  /**
   * Reclaim a lock whose recorded pid is verifiably gone on this host. On by default, because a hard
   * kill is the normal way an engine stops (AD-32 makes reclamation a reconcile action, never a
   * shutdown handler) and a run would otherwise be permanently unstartable.
   */
  readonly reclaimStale?: boolean;
}

/** The in-process holders, keyed by lock path, so a second engine here is named rather than probed. */
const IN_PROCESS_HOLDERS = new Map<string, EngineLockClaim>();

/** An acquired lock. Held for the engine's lifetime and released on `close`. */
export class EngineLock {
  readonly path: string;
  readonly claim: EngineLockClaim;
  readonly orchHome: string;
  /** True when this lock was taken over a stale one whose recorded pid was gone. */
  readonly reclaimed: boolean;

  private released = false;

  private constructor(
    path: string,
    claim: EngineLockClaim,
    orchHome: string,
    reclaimed: boolean,
  ) {
    this.path = path;
    this.claim = claim;
    this.orchHome = orchHome;
    this.reclaimed = reclaimed;
  }

  /**
   * Claim the `ORCH_HOME` lock, or refuse naming the holder's pid and start time.
   *
   * The sequence is exclusive-create, then write the claim: a second engine racing on the same
   * instant loses at the `wx` open rather than at a read-then-write window it could slip through.
   */
  static acquire(options: EngineLockOptions = {}): EngineLock {
    const orchHome = options.orchHome ?? resolveOrchHome();
    const path = engineLockPath(orchHome);
    mkdirSync(orchHome, { recursive: true });

    const held = IN_PROCESS_HOLDERS.get(path);
    if (held !== undefined) {
      throw new EngineLockHeldError(
        path,
        held,
        `${describeEngineLockHolder(held)} — this same process already holds it`,
      );
    }

    const claim: EngineLockClaim = {
      pid: process.pid,
      host: hostname(),
      since: formatTimestamp(),
      started_at: processStartedAt(process.pid),
    };

    let reclaimed = false;
    let fd: number;
    try {
      fd = openSync(path, 'wx');
    } catch (thrown: unknown) {
      // Only "the lock exists" is a held lock. EACCES, ENOSPC, EROFS and ENOTDIR say nothing about a
      // holder, and reporting them as a held lock would hide the real fault behind the wrong advice.
      if ((thrown as { code?: string } | null)?.code !== 'EEXIST') throw thrown;
      const existing = readEngineLockClaim(path);
      /**
       * Two ways a claim is stale, and the second is why the start time is recorded at all: the pid is
       * gone, or the pid is alive but belongs to a process that started at a different time — a recycled
       * number, which a liveness probe alone reads as a live holder for ever.
       */
      const stale =
        (options.reclaimStale ?? true) &&
        existing !== null &&
        existing.host === claim.host &&
        existing.pid !== process.pid &&
        (!pidIsAlive(existing.pid) || pidWasRecycled(existing));
      if (!stale) {
        throw new EngineLockHeldError(path, existing, describeEngineLockHolder(existing));
      }
      unlinkSync(path);
      reclaimed = true;
      try {
        fd = openSync(path, 'wx');
      } catch (raced: unknown) {
        if ((raced as { code?: string } | null)?.code !== 'EEXIST') throw raced;
        // Another engine reclaimed the same stale lock first. That engine is the holder now, so this
        // one is refused by name rather than leaking the raw errno of the losing open.
        throw new EngineLockHeldError(
          path,
          readEngineLockClaim(path),
          `${describeEngineLockHolder(readEngineLockClaim(path))} — it was claimed while this ` +
            'engine was reclaiming the same stale lock',
        );
      }
    }

    try {
      writeSync(fd, `${JSON.stringify(claim)}\n`);
    } catch (thrown: unknown) {
      // A claim that cannot be written would leave an empty lock naming nobody, which no later engine
      // could reclaim. Better to give the lock back and report the real fault.
      closeSync(fd);
      try {
        unlinkSync(path);
      } catch {
        // Nothing further to do: the next engine's liveness check reclaims it.
      }
      throw thrown;
    }
    closeSync(fd);

    IN_PROCESS_HOLDERS.set(path, claim);
    return new EngineLock(path, claim, orchHome, reclaimed);
  }

  get isHeld(): boolean {
    return !this.released;
  }

  /**
   * Release the claim.
   *
   * Only this engine's own claim is removed. Once another engine has reclaimed a stale lock the file
   * describes *that* holder, and unlinking it would strip a live engine's claim — which is the
   * two-engine state AD-30 exists to prevent, arrived at from the opposite direction.
   */
  release(): void {
    if (this.released) return;
    this.released = true;
    IN_PROCESS_HOLDERS.delete(this.path);
    const held = readEngineLockClaim(this.path);
    if (held?.pid !== this.claim.pid || held.host !== this.claim.host) return;
    try {
      unlinkSync(this.path);
    } catch {
      // A lock that cannot be removed is reclaimed by the pid-liveness check on the next start.
    }
  }
}

/** Convenience for the common case: claim the lock or refuse naming the holder. */
export const acquireEngineLock = (options: EngineLockOptions = {}): EngineLock =>
  EngineLock.acquire(options);
