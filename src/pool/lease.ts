/**
 * CAP-11 — a leased ephemeral resource: ready within a declared bound, returned verified empty.
 *
 * The capability's success criterion is two sentences and both are mechanised here. "A feature requiring
 * postgres receives a ready instance within a declared time bound" is a deadline, not a hope: waiting
 * longer is a declared failure carrying `resource.lease_timed_out`, and a hang is the one outcome the
 * criterion forbids. "On completion the instance is returned and verified empty" is a wipe *followed by
 * a check*, because a wipe that silently failed and a wipe that worked look identical from the caller's
 * side — and the difference is one feature's data reaching another.
 *
 * Nothing in this file names a container runtime or composes a flag. Every operation on an instance goes
 * through the `ServiceOperator` port, whose only real implementation lives in `src/container/` where
 * AD-20 puts it. That is also what makes the three properties above assertable on a machine with no
 * daemon: the bound, the dirty refusal and the isolation between two runs are decisions, and a decision
 * is testable against a double.
 *
 * **Every durable write happens before the effect it describes, never after.** A lease record is written
 * before the instance is started, so a crash in between leaves a record naming a container that may or
 * may not exist — which the reclamation pass can resolve either way. The other order would leave a
 * running container nothing on disk mentions, and AD-32's whole point is that a crash must not be able
 * to produce a resource no pass can see. For the same reason nothing here releases anything in a
 * `finally`, in a signal handler, or on exit: a lease is reclaimed by the pass in `reclaim.ts`.
 *
 * **A dirty resource is quarantined rather than destroyed.** `resource.return_dirty` is declared
 * `escalate-to-human`, and a person asked to look at an instance that has already been deleted has
 * nothing to look at. So the record moves to `pool/quarantine/`, the instance is never handed to another
 * run, and no pass reclaims it — the escalation is the disposition, and silently cleaning up would be
 * the pass deciding a question the table says belongs to a person.
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  CURRENT_SCHEMA_VERSION,
  assertRecognisedSchemaVersion,
  formatTimestamp,
  makeError,
} from '../contracts/index.js';
import type { OrchError } from '../contracts/index.js';
import { SERVICE_KINDS, SERVICE_PUBLISH_ADDRESS } from '../container/index.js';
import type { ServiceInstance, ServiceKind, ServiceOperator } from '../container/index.js';
import { assertSafePathSegment, poolDir, resolveOrchHome } from '../runtime/index.js';

/** The three directories the pool keeps under `ORCH_HOME/pool/`, per AD-9. */
export const LEASES_DIR_NAME = 'leases';
export const WARM_DIR_NAME = 'warm';
export const QUARANTINE_DIR_NAME = 'quarantine';

export const leasesDir = (orchHome: string = resolveOrchHome()): string =>
  join(poolDir(orchHome), LEASES_DIR_NAME);
export const warmDir = (orchHome: string = resolveOrchHome()): string =>
  join(poolDir(orchHome), WARM_DIR_NAME);
export const quarantineDir = (orchHome: string = resolveOrchHome()): string =>
  join(poolDir(orchHome), QUARANTINE_DIR_NAME);

/**
 * The declared time bound per kind, in milliseconds. CAP-11's "within a declared time bound".
 *
 * Declared per kind because the bound is a property of what has to happen: postgres initialises a
 * cluster on first start and redis does not, so one number for both would either be generous enough to
 * hide a wedged redis or tight enough to fail a healthy postgres.
 */
export const LEASE_TIME_BOUND_MS: Readonly<Record<ServiceKind, number>> = {
  postgres: 90_000,
  redis: 30_000,
};

/** How often readiness is asked. Small enough that the bound is the thing that decides, not the poll. */
export const LEASE_POLL_INTERVAL_MS = 250;

/** The loopback port range leased instances are published on. */
export const POOL_PORT_BASE = 55_400;
export const POOL_PORT_COUNT = 200;

/** The container name of a leased instance. Derived from the lease so a sweep can read it back. */
export const instanceNameFor = (kind: ServiceKind, lease: string): string =>
  `orch-pool-${kind}-${lease}`;

/**
 * A lease, as `ORCH_HOME/pool/leases/<lease-id>.json` records it.
 *
 * Carries `schema_version` per AD-28, and every field a later pass needs to act on the instance without
 * having been the process that created it: the run it belongs to, the kind, and the container's name.
 */
export interface LeaseRecord {
  readonly schema_version: number;
  readonly lease: string;
  readonly run: string;
  readonly kind: ServiceKind;
  readonly container_name: string;
  readonly host_port: number;
  readonly image: string;
  readonly acquired_at: string;
  /** Set when the record is quarantined, naming what survived the wipe. */
  readonly residue?: readonly string[];
}

/** An instance in the warm inventory: started, empty, and belonging to no run. */
export interface WarmRecord {
  readonly schema_version: number;
  readonly kind: ServiceKind;
  readonly container_name: string;
  readonly host_port: number;
  readonly image: string;
  readonly returned_at: string;
}

/** A held lease, as the feature that asked for it sees it. */
export interface Lease {
  readonly lease: string;
  readonly run: string;
  readonly kind: ServiceKind;
  readonly instance: ServiceInstance;
  /** `127.0.0.1:<port>` — where this run reaches its instance, and nowhere else reaches it. */
  readonly endpoint: string;
  readonly acquiredAt: string;
  /** True when a warm instance was reused rather than a new one started. */
  readonly reused: boolean;
  /** How long readiness took, so a bound that is habitually nearly exceeded is visible. */
  readonly waitedMs: number;
}

/** No instance became ready inside the declared bound. `retry-with-backoff`, never a longer wait. */
export class LeaseTimedOutError extends Error {
  readonly code = 'resource.lease_timed_out';
  readonly kind: ServiceKind;
  readonly run: string;
  readonly boundMs: number;
  readonly orchError: OrchError;

  constructor(kind: ServiceKind, run: string, boundMs: number, detail: string) {
    const message =
      `No ${kind} instance became ready for run ${run} within the declared bound of ` +
      `${String(boundMs)}ms: ${detail}. CAP-11's success criterion is a bound, so exceeding it is a ` +
      'declared failure rather than a longer wait.';
    super(message);
    this.name = 'LeaseTimedOutError';
    this.kind = kind;
    this.run = run;
    this.boundMs = boundMs;
    this.orchError = makeError(this.code, message, detail);
  }
}

/** A returned instance still held data after its wipe. `escalate-to-human`; never reissued. */
export class LeaseReturnDirtyError extends Error {
  readonly code = 'resource.return_dirty';
  readonly lease: string;
  readonly residue: readonly string[];
  readonly orchError: OrchError;

  constructor(lease: string, kind: ServiceKind, residue: readonly string[]) {
    const detail = residue.join('; ');
    const message =
      `The ${kind} instance returned by lease ${lease} was not empty after its wipe: ${detail}. It is ` +
      'quarantined rather than handed to another run, because a resource passed on with residue leaks ' +
      "one feature's data into another.";
    super(message);
    this.name = 'LeaseReturnDirtyError';
    this.lease = lease;
    this.residue = residue;
    this.orchError = makeError(this.code, message, detail);
  }
}

const isServiceKind = (value: unknown): value is ServiceKind =>
  typeof value === 'string' && (SERVICE_KINDS as readonly string[]).includes(value);

/** Write a record so a reader sees either the old one or the new one, never a partial (AD-4's rule). */
const writeRecordAtomic = (path: string, value: unknown): void => {
  mkdirSync(join(path, '..'), { recursive: true });
  const temporary = `${path}.${String(process.pid)}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  renameSync(temporary, path);
};

/** Every `*.json` in a directory, parsed, with anything unreadable skipped rather than thrown. */
const readRecords = <T>(dir: string, parse: (value: unknown) => T | null): readonly T[] => {
  let names: readonly string[];
  try {
    names = readdirSync(dir).filter((name) => name.endsWith('.json')).sort();
  } catch {
    return [];
  }
  const found: T[] = [];
  for (const name of names) {
    try {
      const parsed = parse(JSON.parse(readFileSync(join(dir, name), 'utf8')));
      if (parsed !== null) found.push(parsed);
    } catch (thrown: unknown) {
      // AD-28 is not a per-artifact latitude: a record written by a version this build does not read is
      // refused loudly, because acting on a resource whose shape has changed is how a reclamation pass
      // destroys something it misread. A *corrupt* record is the other case — skipped, so one unreadable
      // file cannot stop the pass from reclaiming every other resource.
      if ((thrown as { code?: unknown } | null)?.code === 'config.schema_version_unrecognised') throw thrown;
      continue;
    }
  }
  return found;
};

/** Parse a lease record, refusing a `schema_version` this build does not read (AD-28). */
export const parseLeaseRecord = (value: unknown): LeaseRecord | null => {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Partial<LeaseRecord>;
  if (typeof record.schema_version !== 'number') return null;
  assertRecognisedSchemaVersion(record.schema_version, 'a pool lease record');
  if (
    typeof record.lease !== 'string' ||
    typeof record.run !== 'string' ||
    !isServiceKind(record.kind) ||
    typeof record.container_name !== 'string' ||
    typeof record.host_port !== 'number' ||
    typeof record.image !== 'string' ||
    typeof record.acquired_at !== 'string'
  ) {
    return null;
  }
  return {
    schema_version: record.schema_version,
    lease: record.lease,
    run: record.run,
    kind: record.kind,
    container_name: record.container_name,
    host_port: record.host_port,
    image: record.image,
    acquired_at: record.acquired_at,
    ...(record.residue === undefined ? {} : { residue: record.residue }),
  };
};

export const parseWarmRecord = (value: unknown): WarmRecord | null => {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Partial<WarmRecord>;
  if (typeof record.schema_version !== 'number') return null;
  assertRecognisedSchemaVersion(record.schema_version, 'a pool warm-inventory record');
  if (
    !isServiceKind(record.kind) ||
    typeof record.container_name !== 'string' ||
    typeof record.host_port !== 'number' ||
    typeof record.image !== 'string' ||
    typeof record.returned_at !== 'string'
  ) {
    return null;
  }
  return {
    schema_version: record.schema_version,
    kind: record.kind,
    container_name: record.container_name,
    host_port: record.host_port,
    image: record.image,
    returned_at: record.returned_at,
  };
};

/** The instance a record names, as the operator takes it. */
export const instanceOf = (record: LeaseRecord | WarmRecord): ServiceInstance => ({
  kind: record.kind,
  containerName: record.container_name,
  hostPort: record.host_port,
  image: record.image,
});

/** Every lease currently recorded under `ORCH_HOME/pool/leases/`. The AD-32 sweep reads this. */
export const listLeaseRecords = (orchHome: string = resolveOrchHome()): readonly LeaseRecord[] =>
  readRecords(leasesDir(orchHome), parseLeaseRecord);

export const listWarmRecords = (orchHome: string = resolveOrchHome()): readonly WarmRecord[] =>
  readRecords(warmDir(orchHome), parseWarmRecord);

export const listQuarantinedRecords = (orchHome: string = resolveOrchHome()): readonly LeaseRecord[] =>
  readRecords(quarantineDir(orchHome), parseLeaseRecord);

export interface LeaseRequest {
  readonly run: string;
  readonly kind: ServiceKind;
  /** Overrides {@link LEASE_TIME_BOUND_MS} for this request. The bound is always declared. */
  readonly timeoutMs?: number;
}

/** What a return decided. A clean return is data; a dirty one is an exception, per AD-35's table. */
export interface LeaseReturn {
  readonly lease: string;
  readonly kind: ServiceKind;
  readonly wiped: boolean;
  readonly verifiedEmpty: boolean;
  /** True when the instance rejoined the warm inventory and may be leased again. */
  readonly available: boolean;
  readonly reason: string;
}

export interface LeasePoolOptions {
  readonly orchHome?: string;
  /** The port every container operation goes through. `src/container/` owns the only real one. */
  readonly operator: ServiceOperator;
  readonly now?: () => Date;
  /** Injectable so the time bound is assertable without waiting for it. */
  readonly sleep?: (ms: number) => Promise<void>;
  /** Injectable lease ids, so a suite can name the record it is about to read. */
  readonly mintLeaseId?: () => string;
  /** Injectable port allocation; the default takes the lowest free port in the declared range. */
  readonly allocatePort?: (kind: ServiceKind, taken: readonly number[]) => number;
}

/** A lease pool over one `ORCH_HOME`. Holds no authoritative state in memory: every fact is a record. */
export interface LeasePool {
  readonly orchHome: string;
  readonly acquire: (request: LeaseRequest) => Promise<Lease>;
  readonly release: (lease: Lease) => LeaseReturn;
  readonly leases: () => readonly LeaseRecord[];
  readonly warm: () => readonly WarmRecord[];
  readonly quarantined: () => readonly LeaseRecord[];
  /** Destroy the instance a record names and forget the record. The AD-32 pass's acting half. */
  readonly reclaim: (record: LeaseRecord) => { readonly reclaimed: boolean; readonly reason: string };
}

const realSleep = (ms: number): Promise<void> =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms).unref?.();
  });

export const createLeasePool = (options: LeasePoolOptions): LeasePool => {
  const orchHome = options.orchHome ?? resolveOrchHome();
  const operator = options.operator;
  const now = options.now ?? ((): Date => new Date());
  const sleep = options.sleep ?? realSleep;
  const mintLeaseId = options.mintLeaseId ?? ((): string => randomUUID());

  const leasePath = (lease: string): string =>
    join(leasesDir(orchHome), `${assertSafePathSegment(lease, 'a lease id')}.json`);
  const warmPath = (containerName: string): string =>
    join(warmDir(orchHome), `${assertSafePathSegment(containerName, 'a container name')}.json`);
  const quarantinePath = (lease: string): string =>
    join(quarantineDir(orchHome), `${assertSafePathSegment(lease, 'a lease id')}.json`);

  const takenPorts = (): readonly number[] => [
    ...listLeaseRecords(orchHome).map((record) => record.host_port),
    ...listWarmRecords(orchHome).map((record) => record.host_port),
    ...listQuarantinedRecords(orchHome).map((record) => record.host_port),
  ];

  const allocatePort =
    options.allocatePort ??
    ((_kind: ServiceKind, taken: readonly number[]): number => {
      for (let port = POOL_PORT_BASE; port < POOL_PORT_BASE + POOL_PORT_COUNT; port += 1) {
        if (!taken.includes(port)) return port;
      }
      throw new Error(
        `Every port in the declared pool range ${String(POOL_PORT_BASE)}..` +
          `${String(POOL_PORT_BASE + POOL_PORT_COUNT - 1)} is taken by a recorded instance.`,
      );
    });

  /** The warm instance of this kind that has been idle longest, or `null`. */
  const claimWarm = (kind: ServiceKind): WarmRecord | null => {
    const candidates = listWarmRecords(orchHome)
      .filter((record) => record.kind === kind)
      .sort((left, right) => left.returned_at.localeCompare(right.returned_at));
    const claimed = candidates[0];
    if (claimed === undefined) return null;
    // Removed from the inventory before the lease record is written, so the window a crash can land in
    // leaves the instance *unclaimed by anything*, which the pass can resolve — rather than claimed by
    // two leases at once, which it cannot.
    rmSync(warmPath(claimed.container_name), { force: true });
    return claimed;
  };

  const waitForReady = async (
    instance: ServiceInstance,
    run: string,
    boundMs: number,
  ): Promise<number> => {
    const startedAt = now().getTime();
    let lastDetail = 'the readiness probe was never asked';
    for (;;) {
      const probe = operator.ready(instance);
      lastDetail = probe.detail;
      if (probe.ok) return now().getTime() - startedAt;
      const elapsed = now().getTime() - startedAt;
      if (elapsed >= boundMs) {
        throw new LeaseTimedOutError(instance.kind, run, boundMs, lastDetail);
      }
      await sleep(Math.min(LEASE_POLL_INTERVAL_MS, boundMs - elapsed));
    }
  };

  const forget = (record: LeaseRecord): void => {
    rmSync(leasePath(record.lease), { force: true });
    rmSync(warmPath(record.container_name), { force: true });
  };

  return {
    orchHome,

    acquire: async (request: LeaseRequest): Promise<Lease> => {
      const boundMs = request.timeoutMs ?? LEASE_TIME_BOUND_MS[request.kind];
      const lease = mintLeaseId();
      const warmClaim = claimWarm(request.kind);
      const instance: ServiceInstance =
        warmClaim === null
          ? {
              kind: request.kind,
              containerName: instanceNameFor(request.kind, lease),
              hostPort: allocatePort(request.kind, takenPorts()),
              image: '',
            }
          : instanceOf(warmClaim);

      const acquiredAt = formatTimestamp(now());
      const record: LeaseRecord = {
        schema_version: CURRENT_SCHEMA_VERSION,
        lease,
        run: request.run,
        kind: request.kind,
        container_name: instance.containerName,
        host_port: instance.hostPort,
        image: instance.image,
        acquired_at: acquiredAt,
      };
      // Written before the instance exists: a crash here leaves a record naming a container that may
      // not exist, which the reclamation pass resolves. The other order leaks invisibly (AD-32).
      writeRecordAtomic(leasePath(lease), record);

      let started = instance;
      if (warmClaim === null) {
        const outcome = operator.start({
          kind: request.kind,
          run: request.run,
          lease,
          containerName: instance.containerName,
          hostPort: instance.hostPort,
        });
        started = outcome.instance;
        writeRecordAtomic(leasePath(lease), { ...record, image: started.image });
        if (!outcome.ok) {
          // A start that failed is a lease that will never become ready. Reported as the bound's
          // failure rather than waiting it out, because there is nothing left to wait for.
          const reclaimed = operator.destroy(started);
          if (reclaimed.ok) forget(record);
          throw new LeaseTimedOutError(request.kind, request.run, boundMs, outcome.detail);
        }
      }

      let waitedMs: number;
      try {
        waitedMs = await waitForReady(started, request.run, boundMs);
      } catch (thrown: unknown) {
        // Not a `finally`: this is the failure path of one decision, and the *durable* outcome either
        // way is a record the pass can act on. A destroy that fails leaves the record standing, which
        // is what makes the next pass reclaim it rather than this one pretending it succeeded.
        const destroyed = operator.destroy(started);
        if (destroyed.ok) forget(record);
        throw thrown;
      }

      return {
        lease,
        run: request.run,
        kind: request.kind,
        instance: started,
        endpoint: `${SERVICE_PUBLISH_ADDRESS}:${String(started.hostPort)}`,
        acquiredAt,
        reused: warmClaim !== null,
        waitedMs,
      };
    },

    release: (lease: Lease): LeaseReturn => {
      const wipe = operator.wipe(lease.instance);
      // The check runs even when the wipe reported failure: "verified empty" is a fact about the
      // instance, not about whether a command exited zero, and a wipe that half-worked is exactly the
      // case a caller must not be allowed to assume away.
      const residue = operator.residue(lease.instance);

      if (!residue.ok) {
        const record: LeaseRecord = {
          schema_version: CURRENT_SCHEMA_VERSION,
          lease: lease.lease,
          run: lease.run,
          kind: lease.kind,
          container_name: lease.instance.containerName,
          host_port: lease.instance.hostPort,
          image: lease.instance.image,
          acquired_at: lease.acquiredAt,
          residue: residue.residue,
        };
        writeRecordAtomic(quarantinePath(lease.lease), record);
        rmSync(leasePath(lease.lease), { force: true });
        throw new LeaseReturnDirtyError(lease.lease, lease.kind, residue.residue);
      }

      const warm: WarmRecord = {
        schema_version: CURRENT_SCHEMA_VERSION,
        kind: lease.kind,
        container_name: lease.instance.containerName,
        host_port: lease.instance.hostPort,
        image: lease.instance.image,
        returned_at: formatTimestamp(now()),
      };
      // The warm record lands before the lease record is dropped, so no window exists in which the
      // instance is recorded nowhere. Two records for one instance is a state the pass can read; none
      // is a leak.
      writeRecordAtomic(warmPath(lease.instance.containerName), warm);
      rmSync(leasePath(lease.lease), { force: true });

      return {
        lease: lease.lease,
        kind: lease.kind,
        wiped: wipe.ok,
        verifiedEmpty: true,
        available: true,
        reason: `the instance was wiped and verified empty (${residue.detail})`,
      };
    },

    leases: (): readonly LeaseRecord[] => listLeaseRecords(orchHome),
    warm: (): readonly WarmRecord[] => listWarmRecords(orchHome),
    quarantined: (): readonly LeaseRecord[] => listQuarantinedRecords(orchHome),

    reclaim: (record: LeaseRecord): { readonly reclaimed: boolean; readonly reason: string } => {
      const destroyed = operator.destroy(instanceOf(record));
      if (!destroyed.ok) {
        return {
          reclaimed: false,
          reason: `the instance ${record.container_name} could not be destroyed: ${destroyed.detail}`,
        };
      }
      forget(record);
      return { reclaimed: true, reason: `the instance ${record.container_name} was destroyed` };
    },
  };
};
