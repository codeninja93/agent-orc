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
 * The warm-reuse path obeys the same rule, which it once did not: claiming a warm instance is a `rename` of
 * its record into `pool/claims/`, never a delete, so the container is named by some durable file at every
 * instant of the hand-over. Deleting first left a window in which a running container was mentioned by
 * neither `warm/` nor `leases/`, and nothing enumerates containers by record in that state — so it was
 * invisible for ever, which is precisely what `release()` already ordered the other way round to avoid.
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
import { performance } from 'node:perf_hooks';

import {
  CURRENT_SCHEMA_VERSION,
  assertRecognisedSchemaVersion,
  formatTimestamp,
  makeError,
} from '../contracts/index.js';
import type { OrchError } from '../contracts/index.js';
import { SERVICE_KINDS, SERVICE_PUBLISH_ADDRESS, ServiceOperationError } from '../container/index.js';
import type { ServiceInstance, ServiceKind, ServiceOperator } from '../container/index.js';
import { assertSafePathSegment, poolDir, resolveOrchHome } from '../runtime/index.js';

/** The four directories the pool keeps under `ORCH_HOME/pool/`, per AD-9. */
export const LEASES_DIR_NAME = 'leases';
export const WARM_DIR_NAME = 'warm';
export const QUARANTINE_DIR_NAME = 'quarantine';
/**
 * `pool/claims/` — a warm record part-way through becoming a lease.
 *
 * It exists so that claiming a warm instance can be a `rename` rather than a delete. The instance is then
 * recorded somewhere durable at every instant of the hand-over, and a claim file that outlives its process
 * is a crash in that window rather than a container nothing on disk mentions. Swept by the same idle-TTL
 * comparison that sweeps `warm/`.
 */
export const CLAIMS_DIR_NAME = 'claims';

export const leasesDir = (orchHome: string = resolveOrchHome()): string =>
  join(poolDir(orchHome), LEASES_DIR_NAME);
export const warmDir = (orchHome: string = resolveOrchHome()): string =>
  join(poolDir(orchHome), WARM_DIR_NAME);
export const quarantineDir = (orchHome: string = resolveOrchHome()): string =>
  join(poolDir(orchHome), QUARANTINE_DIR_NAME);
export const claimsDir = (orchHome: string = resolveOrchHome()): string =>
  join(poolDir(orchHome), CLAIMS_DIR_NAME);

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

/**
 * How long a returned instance may sit in the warm inventory before a pass reclaims it.
 *
 * Without a TTL a warm instance belonged to no run, and `decideReclamation` needs a run — so a returned
 * instance ran for ever across restarts, holding a port and its memory limit, and was handed to the next
 * run with no liveness or emptiness re-check. That is a resource reclaimable by nothing, which is the
 * state AD-32 exists to prevent; the TTL is what makes a warm record answerable to a pass at all.
 *
 * Comfortably longer than any single acquire's declared bound, because a `pool/claims/` record is swept by
 * the same comparison and one of those is legitimately present for the length of an acquire.
 */
export const WARM_IDLE_TTL_MS = 30 * 60 * 1000;

/**
 * How many instances of one kind the warm inventory holds before a return destroys rather than keeps.
 *
 * A ceiling on the memory and the ports the pool can hold when nothing is leasing. Without it every
 * concurrent peak became the permanent floor, since nothing shrank the inventory between peaks.
 */
export const MAX_WARM_PER_KIND = 4;

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

/**
 * A `release` was attempted for a lease this pool does not record as held.
 *
 * `internal.invariant_violated`, because it means a caller lost track of a lease rather than that anything
 * external failed. The reason it is a refusal rather than a shrug: `release` wipes whatever the handed-in
 * `Lease` names, and a stale `Lease` released twice — or released after a pass already reclaimed it — would
 * wipe an instance a *different* run has since acquired out of the warm inventory.
 */
export class LeaseNotHeldError extends Error {
  readonly code = 'internal.invariant_violated';
  readonly lease: string;
  readonly orchError: OrchError;

  constructor(lease: string, instanceName: string, recordedName: string | null) {
    const detail =
      recordedName === null
        ? 'no lease record of that id exists'
        : `the lease record names ${recordedName} rather than ${instanceName}`;
    const message =
      `Refusing to release lease ${lease}: ${detail}. The durable record is the only authority on who ` +
      'holds an instance, and wiping one this lease no longer holds would destroy another run’s data.';
    super(message);
    this.name = 'LeaseNotHeldError';
    this.lease = lease;
    this.orchError = makeError(this.code, message, detail);
  }
}

/**
 * Every port in the declared range is held by a recorded instance.
 *
 * `resource.lease_timed_out` — the declared code for "the pool could not produce an instance" — rather than
 * the bare `Error` that stood here, which carried no AD-35 disposition at all and would therefore have been
 * handed off instead of retried. A port frees up when another lease is released, so retry-with-backoff is
 * exactly right.
 */
export class PoolPortsExhaustedError extends Error {
  readonly code = 'resource.lease_timed_out';
  readonly orchError: OrchError;

  constructor(taken: number) {
    const detail =
      `all ${String(POOL_PORT_COUNT)} ports in ${String(POOL_PORT_BASE)}..` +
      `${String(POOL_PORT_BASE + POOL_PORT_COUNT - 1)} are held by recorded instances (${String(taken)} records)`;
    const message = `No port is free for a new leased instance: ${detail}.`;
    super(message);
    this.name = 'PoolPortsExhaustedError';
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

/**
 * A durable record a read could not use, and why.
 *
 * Skipping is right for pass liveness — one half-written file must not stop every other resource being
 * reclaimed — but a silent skip makes the resource that record named invisible, and invisible is the exact
 * failure AD-32 exists to prevent. So the skip is reported: the pass carries on *and* says what it could
 * not read, and a file that is unreadable on every pass is a signal rather than a hole.
 */
export interface RecordSkip {
  /** The file, as the directory listing named it. */
  readonly file: string;
  /** The absolute path, so a person can go and look at it. */
  readonly path: string;
  readonly reason: string;
}

/** A sink for {@link RecordSkip}s, so a reader's caller can surface what the reader had to drop. */
export type RecordSkipSink = (skip: RecordSkip) => void;

interface RecordFile<T> {
  readonly value: T;
  readonly path: string;
}

/** Every `*.json` in a directory, parsed, with anything unreadable reported rather than thrown. */
const readRecordFiles = <T>(
  dir: string,
  parse: (value: unknown) => T | null,
  onSkip?: RecordSkipSink,
): readonly RecordFile<T>[] => {
  let names: readonly string[];
  try {
    names = readdirSync(dir).filter((name) => name.endsWith('.json')).sort();
  } catch {
    return [];
  }
  const found: RecordFile<T>[] = [];
  for (const name of names) {
    const path = join(dir, name);
    try {
      const parsed = parse(JSON.parse(readFileSync(path, 'utf8')));
      if (parsed !== null) {
        found.push({ value: parsed, path });
        continue;
      }
      onSkip?.({
        file: name,
        path,
        reason:
          'the record parsed as JSON but not as a pool record of this shape, so the resource it names ' +
          'cannot be acted on by this pass',
      });
    } catch (thrown: unknown) {
      // AD-28 is not a per-artifact latitude: a record written by a version this build does not read is
      // refused loudly, because acting on a resource whose shape has changed is how a reclamation pass
      // destroys something it misread. A *corrupt* record is the other case — skipped, so one unreadable
      // file cannot stop the pass from reclaiming every other resource. Skipped, and reported.
      if ((thrown as { code?: unknown } | null)?.code === 'config.schema_version_unrecognised') throw thrown;
      onSkip?.({
        file: name,
        path,
        reason: `the record could not be read: ${thrown instanceof Error ? thrown.message : String(thrown)}`,
      });
      continue;
    }
  }
  return found;
};

const readRecords = <T>(
  dir: string,
  parse: (value: unknown) => T | null,
  onSkip?: RecordSkipSink,
): readonly T[] => readRecordFiles(dir, parse, onSkip).map((entry) => entry.value);

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
export const listLeaseRecords = (
  orchHome: string = resolveOrchHome(),
  onSkip?: RecordSkipSink,
): readonly LeaseRecord[] => readRecords(leasesDir(orchHome), parseLeaseRecord, onSkip);

export const listWarmRecords = (
  orchHome: string = resolveOrchHome(),
  onSkip?: RecordSkipSink,
): readonly WarmRecord[] => readRecords(warmDir(orchHome), parseWarmRecord, onSkip);

export const listQuarantinedRecords = (
  orchHome: string = resolveOrchHome(),
  onSkip?: RecordSkipSink,
): readonly LeaseRecord[] => readRecords(quarantineDir(orchHome), parseLeaseRecord, onSkip);

/** Every warm record part-way through becoming a lease. Transient; a survivor is a crash's residue. */
export const listClaimRecords = (
  orchHome: string = resolveOrchHome(),
  onSkip?: RecordSkipSink,
): readonly WarmRecord[] => readRecords(claimsDir(orchHome), parseWarmRecord, onSkip);

/**
 * One instance that belongs to no run: a warm record, or a claim a crash left behind.
 *
 * The path travels with the record because the sweep has to forget *that* file — a claim and a warm record
 * of the same container are the same instance recorded in two different places, and only one of them exists
 * at a time.
 */
export interface PooledInstanceRecord {
  readonly record: WarmRecord;
  readonly path: string;
  readonly origin: 'warm' | 'claim';
}

/** Every instance in the pool that no lease holds: the warm inventory plus any surviving claim. */
export const listIdleInstances = (
  orchHome: string = resolveOrchHome(),
  onSkip?: RecordSkipSink,
): readonly PooledInstanceRecord[] => [
  ...readRecordFiles(warmDir(orchHome), parseWarmRecord, onSkip).map(
    (entry): PooledInstanceRecord => ({ record: entry.value, path: entry.path, origin: 'warm' }),
  ),
  ...readRecordFiles(claimsDir(orchHome), parseWarmRecord, onSkip).map(
    (entry): PooledInstanceRecord => ({ record: entry.value, path: entry.path, origin: 'claim' }),
  ),
];

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
  /**
   * A monotonic millisecond source, for the declared bound only.
   *
   * `now()` is a wall clock and a wall clock can step backwards — an NTP correction, a VM resume, a user
   * changing the date — at which point `elapsed` never reaches the bound and the wait becomes the unbounded
   * hang CAP-11 declares impossible. Timestamps recorded in a durable record still come from `now()`,
   * because a record has to name a real instant; only the deadline is monotonic.
   */
  readonly monotonicNow?: () => number;
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
  /** Every instance no lease holds: the warm inventory plus any claim a crash left behind. */
  readonly idle: () => readonly PooledInstanceRecord[];
  /** Every pooled container the runtime holds that no durable record of this pool names. */
  readonly unrecorded: () => UnrecordedSweep;
  /** Destroy the instance a record names and forget the record. The AD-32 pass's acting half. */
  readonly reclaim: (record: LeaseRecord) => { readonly reclaimed: boolean; readonly reason: string };
  /** The same, for an instance that belongs to no run: an expired warm record or a stranded claim. */
  readonly reclaimIdle: (
    entry: PooledInstanceRecord,
  ) => { readonly reclaimed: boolean; readonly reason: string };
}

/**
 * What a label sweep found that no record of this pool accounts for.
 *
 * Reported, never destroyed, and the reason is not timidity. `SERVICE_LABEL_KEYS` carries no `ORCH_HOME`, so
 * a label sweep on a machine running two homes lists both their containers and cannot tell them apart —
 * destroying on that evidence would have one engine reclaiming another's live instances. AD-30's lock is per
 * home, not per machine, so it does not close that gap either.
 *
 * What the sweep *does* close is the invisibility. Before it, a container whose durable record was lost was
 * reclaimable by no pass and mentioned by nothing: exactly the state AD-32 exists to prevent, reached through
 * the pass meant to prevent it. Now it is named in every pass's `failed` list until a person or a
 * home-scoped label makes it safe to act on.
 */
export interface UnrecordedSweep {
  /** False when the sweep itself could not run, which must never read as "no containers". */
  readonly ok: boolean;
  /** The container names carrying the pool label that no lease, warm, claim or quarantine record names. */
  readonly containerNames: readonly string[];
  readonly detail: string;
}

const realSleep = (ms: number): Promise<void> =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms).unref?.();
  });

export const createLeasePool = (options: LeasePoolOptions): LeasePool => {
  const orchHome = options.orchHome ?? resolveOrchHome();
  const operator = options.operator;
  const now = options.now ?? ((): Date => new Date());
  const monotonicNow = options.monotonicNow ?? ((): number => performance.now());
  const sleep = options.sleep ?? realSleep;
  const mintLeaseId = options.mintLeaseId ?? ((): string => randomUUID());

  const leasePath = (lease: string): string =>
    join(leasesDir(orchHome), `${assertSafePathSegment(lease, 'a lease id')}.json`);
  const warmPath = (containerName: string): string =>
    join(warmDir(orchHome), `${assertSafePathSegment(containerName, 'a container name')}.json`);
  const quarantinePath = (lease: string): string =>
    join(quarantineDir(orchHome), `${assertSafePathSegment(lease, 'a lease id')}.json`);
  const claimPath = (lease: string): string =>
    join(claimsDir(orchHome), `${assertSafePathSegment(lease, 'a lease id')}.json`);

  const takenPorts = (): readonly number[] => [
    ...listLeaseRecords(orchHome).map((record) => record.host_port),
    ...listWarmRecords(orchHome).map((record) => record.host_port),
    ...listQuarantinedRecords(orchHome).map((record) => record.host_port),
    ...listClaimRecords(orchHome).map((record) => record.host_port),
  ];

  const allocatePort =
    options.allocatePort ??
    ((_kind: ServiceKind, taken: readonly number[]): number => {
      for (let port = POOL_PORT_BASE; port < POOL_PORT_BASE + POOL_PORT_COUNT; port += 1) {
        if (!taken.includes(port)) return port;
      }
      throw new PoolPortsExhaustedError(taken.length);
    });

  /**
   * Claim the warm instance of this kind that has been idle longest, atomically, or answer `null`.
   *
   * The claim is a `renameSync` of the warm record into `pool/claims/<lease-id>.json`, and `ENOENT` means
   * another acquire got there first. The `rmSync(..., { force: true })` that stood here could not decide
   * anything: `force` swallows `ENOENT`, so two concurrent acquires both listed the same record, both
   * "succeeded", and both wrote a lease naming one container — which is this story's own "two runs, one
   * kind → neither sees the other's data" criterion failing. `rename` is the same atomic test-and-set
   * `src/runtime/exclusive-create.ts` uses for the two claims that decide who may write; here the loser
   * learns it lost from the error code and moves on to the next candidate.
   *
   * The record is *moved*, not deleted, so the instance is recorded somewhere durable at every instant. The
   * old order deleted the warm record before the lease record was written, and a crash in that window left
   * a running container mentioned by neither `warm/` nor `leases/` — invisible for ever, which is the one
   * outcome AD-32 forbids and which the file header's own rule already required the other way round.
   */
  const claimWarm = (kind: ServiceKind, lease: string): WarmRecord | null => {
    const candidates = listWarmRecords(orchHome)
      .filter((record) => record.kind === kind)
      .sort((left, right) => left.returned_at.localeCompare(right.returned_at));
    for (const candidate of candidates) {
      mkdirSync(claimsDir(orchHome), { recursive: true });
      try {
        renameSync(warmPath(candidate.container_name), claimPath(lease));
      } catch (thrown: unknown) {
        if ((thrown as { code?: string } | null)?.code === 'ENOENT') continue;
        throw thrown;
      }
      // Liveness before commitment. The pool's records are durable and containers are not, so after a
      // reboot every warm record names a container that is gone — and polling a gone container for the
      // whole declared bound and then failing is a lease that should simply have started a fresh instance.
      // Readiness is a different question and is still asked, in `waitForReady`, for an instance that
      // does exist.
      const liveness = operator.exists(instanceOf(candidate));
      if (!liveness.ok) {
        operator.destroy(instanceOf(candidate));
        rmSync(claimPath(lease), { force: true });
        continue;
      }
      return candidate;
    }
    return null;
  };

  /**
   * Poll readiness until the instance serves or the declared bound is spent.
   *
   * `startedAt` is passed in rather than taken here, because CAP-11's bound is on "a feature receives a
   * ready instance" and the clock therefore has to start before anything is *started*. It is a monotonic
   * reading: a wall clock that steps backwards made `elapsed` never reach the bound, which is the hang the
   * bound exists to make impossible.
   */
  const waitForReady = async (
    instance: ServiceInstance,
    run: string,
    boundMs: number,
    startedAt: number,
  ): Promise<number> => {
    let lastDetail = 'the readiness probe was never asked';
    for (;;) {
      // The deadline is checked *before* the probe, not after it. Checking after meant an instance that
      // became ready one second past a spent bound was reported as a success inside the bound — which is
      // how the start's own time escaped the declaration in the first place.
      const elapsed = monotonicNow() - startedAt;
      if (elapsed >= boundMs) {
        throw new LeaseTimedOutError(instance.kind, run, boundMs, lastDetail);
      }
      const probe = operator.ready(instance);
      lastDetail = probe.detail;
      if (probe.ok) return monotonicNow() - startedAt;
      await sleep(Math.min(LEASE_POLL_INTERVAL_MS, boundMs - elapsed));
    }
  };

  const forget = (record: LeaseRecord): void => {
    rmSync(leasePath(record.lease), { force: true });
    rmSync(warmPath(record.container_name), { force: true });
    rmSync(claimPath(record.lease), { force: true });
  };

  return {
    orchHome,

    acquire: async (request: LeaseRequest): Promise<Lease> => {
      const boundMs = request.timeoutMs ?? LEASE_TIME_BOUND_MS[request.kind];
      // The clock starts here, before anything is claimed or started. CAP-11 declares a bound on receiving
      // a ready instance, and a clock that began after `operator.start` returned left the start's own time
      // outside the bound entirely — so a redis acquire could take 60s while the declared number said 30s.
      const startedAt = monotonicNow();
      const lease = mintLeaseId();
      const warmClaim = claimWarm(request.kind, lease);
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
      // Only now is the claim redundant: the lease record is the instance's durable home, so the
      // hand-over from `warm/` completed without an instant in which nothing recorded the container.
      rmSync(claimPath(lease), { force: true });

      let started = instance;
      if (warmClaim === null) {
        const outcome = operator.start({
          kind: request.kind,
          run: request.run,
          lease,
          containerName: instance.containerName,
          hostPort: instance.hostPort,
          // The bound covers the start too, so the invocation carries what is left of it. A cold image
          // pull that outruns the bound therefore fails as a declared failure rather than silently
          // spending twice the promised time — and `container.start_failed` is retry-with-backoff, which
          // is right, because the layers the pull did fetch are cached for the retry.
          // Floored to a whole millisecond: `performance.now()` is fractional and a child-process timeout
          // must be an unsigned integer.
          timeoutMs: Math.max(1, Math.floor(boundMs - (monotonicNow() - startedAt))),
        });
        started = outcome.instance;
        writeRecordAtomic(leasePath(lease), { ...record, image: started.image });
        if (!outcome.ok) {
          // A start that *failed* is not a timeout: a bad image pin, a name collision and a busy port are
          // permanent for this request, and reporting them as `resource.lease_timed_out` sent a caller
          // into a retry-with-backoff loop over something no amount of waiting fixes.
          // `container.start_failed` is the declared code for exactly this, and `service.ts` already
          // carried it with nothing throwing it.
          const reclaimed = operator.destroy(started);
          if (reclaimed.ok) forget(record);
          throw new ServiceOperationError('start', started.containerName, outcome.detail);
        }
      }

      let waitedMs: number;
      try {
        waitedMs = await waitForReady(started, request.run, boundMs, startedAt);
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
      // Read the record *before* touching the instance. This pool keeps nothing authoritative in memory, so
      // the durable record is the only authority on who holds an instance — and `release` wipes whatever
      // the handed-in `Lease` names. A stale `Lease` released twice, or released after a pass already
      // reclaimed it, would otherwise wipe an instance a different run has since acquired out of the warm
      // inventory, which is one feature destroying another's data by the same mechanism the dirty refusal
      // exists to prevent.
      const held = listLeaseRecords(orchHome).find((record) => record.lease === lease.lease);
      if (held?.container_name !== lease.instance.containerName) {
        throw new LeaseNotHeldError(
          lease.lease,
          lease.instance.containerName,
          held?.container_name ?? null,
        );
      }

      const wipe = operator.wipe(lease.instance);
      // The check runs even when the wipe reported failure: "verified empty" is a fact about the
      // instance, not about whether a command exited zero, and a wipe that half-worked is exactly the
      // case a caller must not be allowed to assume away.
      const residue = operator.residue(lease.instance);

      // A failed wipe quarantines even when the probe happened to read clean. `wiped` was recorded and then
      // acted on by nothing, so an instance whose wipe errored rejoined the pool on the strength of one
      // probe — and the probe only ever verified what it knows how to look at. CAP-11's claim is
      // "wiped, then verified empty"; half of that failing is not a clean return.
      const wipeResidue = wipe.ok
        ? []
        : [
            `the wipe itself failed: ${wipe.detail}. The emptiness probe read clean, which is a weaker ` +
              'statement than the wipe having worked — it covers only what the probe knows to look for',
          ];
      const residueFound = [...residue.residue, ...wipeResidue];

      if (residueFound.length > 0) {
        const record: LeaseRecord = {
          schema_version: CURRENT_SCHEMA_VERSION,
          lease: lease.lease,
          run: lease.run,
          kind: lease.kind,
          container_name: lease.instance.containerName,
          host_port: lease.instance.hostPort,
          image: lease.instance.image,
          acquired_at: lease.acquiredAt,
          residue: residueFound,
        };
        writeRecordAtomic(quarantinePath(lease.lease), record);
        rmSync(leasePath(lease.lease), { force: true });
        throw new LeaseReturnDirtyError(lease.lease, lease.kind, residueFound);
      }

      // The inventory has a ceiling: without one, every concurrent peak became the permanent number of
      // containers held for ever, since nothing shrank it between peaks.
      const warmOfKind = listWarmRecords(orchHome).filter((record) => record.kind === lease.kind);
      if (warmOfKind.length >= MAX_WARM_PER_KIND) {
        const destroyed = operator.destroy(lease.instance);
        // The record stands when the destroy failed, so the next pass meets it and tries again.
        if (destroyed.ok) rmSync(leasePath(lease.lease), { force: true });
        return {
          lease: lease.lease,
          kind: lease.kind,
          wiped: wipe.ok,
          verifiedEmpty: true,
          available: false,
          reason:
            `the instance was wiped and verified empty, and then destroyed rather than kept: the warm ` +
            `inventory already holds ${String(warmOfKind.length)} ${lease.kind} instance(s), which is the ` +
            `declared ceiling of ${String(MAX_WARM_PER_KIND)} (${destroyed.detail})`,
        };
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
    idle: (): readonly PooledInstanceRecord[] => listIdleInstances(orchHome),

    unrecorded: (): UnrecordedSweep => {
      const swept = operator.sweep();
      if (!swept.ok) {
        return { ok: false, containerNames: [], detail: `the label sweep could not run: ${swept.detail}` };
      }
      // Every directory a container can be recorded in. A lease record is written *before* its container is
      // started, so anything the sweep finds that none of these name is a record that was lost.
      const recorded = new Set<string>([
        ...listLeaseRecords(orchHome).map((record) => record.container_name),
        ...listWarmRecords(orchHome).map((record) => record.container_name),
        ...listQuarantinedRecords(orchHome).map((record) => record.container_name),
        ...listClaimRecords(orchHome).map((record) => record.container_name),
      ]);
      const containerNames = swept.instances
        .map((instance) => instance.containerName)
        .filter((name) => !recorded.has(name));
      return {
        ok: true,
        containerNames,
        detail: `${String(containerNames.length)} of ${String(swept.instances.length)} pooled container(s) are named by no record of this pool`,
      };
    },

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

    reclaimIdle: (
      entry: PooledInstanceRecord,
    ): { readonly reclaimed: boolean; readonly reason: string } => {
      const destroyed = operator.destroy(instanceOf(entry.record));
      if (!destroyed.ok) {
        return {
          reclaimed: false,
          reason: `the idle instance ${entry.record.container_name} could not be destroyed: ${destroyed.detail}`,
        };
      }
      // Exactly the file the enumeration read: a claim and a warm record of one container are the same
      // instance recorded in two places, and only one of them is there at a time.
      rmSync(entry.path, { force: true });
      return {
        reclaimed: true,
        reason: `the idle ${entry.origin} instance ${entry.record.container_name} was destroyed`,
      };
    },
  };
};

/** One idle instance and whether its idle time has run out. */
export interface WarmExpiry {
  readonly entry: PooledInstanceRecord;
  readonly expired: boolean;
  readonly idleMs: number;
  readonly reason: string;
}

/**
 * The idle-TTL comparison: pure, like {@link decideReclamation} and for the same reason.
 *
 * A warm instance belongs to no run, so the run-state comparison cannot speak about it at all — which is
 * how a returned instance came to be reclaimable by nothing. Idle time is the only signal available, and it
 * is read from the record's own `returned_at` rather than from anything held in memory, so a pass that never
 * saw the return can still decide.
 */
export const decideWarmExpiry = (
  entries: readonly PooledInstanceRecord[],
  at: Date,
  ttlMs: number = WARM_IDLE_TTL_MS,
): readonly WarmExpiry[] =>
  entries.map((entry): WarmExpiry => {
    const returnedAt = Date.parse(entry.record.returned_at);
    if (Number.isNaN(returnedAt)) {
      return {
        entry,
        expired: false,
        idleMs: 0,
        reason:
          `the ${entry.origin} record for ${entry.record.container_name} carries an unreadable ` +
          `returned_at ("${entry.record.returned_at}"), and a resource is never destroyed on the strength ` +
          'of a timestamp this build could not read',
      };
    }
    const idleMs = at.getTime() - returnedAt;
    return {
      entry,
      expired: idleMs >= ttlMs,
      idleMs,
      reason:
        idleMs >= ttlMs
          ? `the ${entry.origin} instance ${entry.record.container_name} has been idle for ` +
            `${String(idleMs)}ms, past the declared TTL of ${String(ttlMs)}ms`
          : `the ${entry.origin} instance ${entry.record.container_name} has been idle for ` +
            `${String(idleMs)}ms, inside the declared TTL of ${String(ttlMs)}ms`,
    };
  });
