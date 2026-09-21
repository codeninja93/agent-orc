/**
 * The lease: the declared time bound, wipe-then-verify-empty, the dirty refusal, and isolation.
 *
 * All four are *decisions*, and a decision is assertable with no daemon — which is the only way they
 * could be covered on this machine. The double below is a real in-memory service: it holds keys, a wipe
 * clears them, and the emptiness probe reports what is left. So "wiped, then verified empty" is observed
 * rather than asserted about a mock's call list, and a wipe that silently does nothing fails the suite
 * the way it would fail a run.
 *
 * The one case that genuinely needs a runtime — a real instance, really started — is the last describe,
 * and it skips visibly through story 1-5's own reachability probe and skip marker. It records no gate
 * marker: `ORCH_HOME/gates/container-assertion.json` is the AD-31 containment suite's, and a second
 * writer would be a second thing to keep honest.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { dispositionFor } from '../src/contracts/index.js';
import {
  CONTAINER_SUBCOMMANDS,
  CONTAINMENT_SKIP_MARKER,
  ServiceOperationError,
  composeServiceExecArgs,
  createContainerInvoker,
  createServiceOperator,
  instanceFor,
  probeContainerRuntime,
  serviceDefinition,
} from '../src/container/index.js';
import type { ServiceInstance, ServiceOperator, ServiceStartRequest } from '../src/container/index.js';
import { poolDir } from '../src/runtime/index.js';
import {
  LEASE_TIME_BOUND_MS,
  LeaseNotHeldError,
  LeaseReturnDirtyError,
  LeaseTimedOutError,
  MAX_WARM_PER_KIND,
  POOL_PORT_BASE,
  POOL_PORT_COUNT,
  PoolPortsExhaustedError,
  WARM_IDLE_TTL_MS,
  createLeasePool,
  decideWarmExpiry,
  instanceNameFor,
  leasesDir,
  listIdleInstances,
  listLeaseRecords,
  listQuarantinedRecords,
  listWarmRecords,
  quarantineDir,
  warmDir,
} from '../src/pool/index.js';
import type { RecordSkip } from '../src/pool/index.js';

import { makeHome } from './helpers/engine-fixture.js';

const RUN_A = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const RUN_B = '01BX5ZZKBKACTAV9WEVGEMMVRZ';

const disposables: string[] = [];

afterAll(() => {
  for (const dir of disposables.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const home = (label: string): string => {
  const dir = makeHome(`lease-${label}`);
  disposables.push(dir);
  return dir;
};

/**
 * A real in-memory service behind the operator port.
 *
 * It holds data per instance, so isolation between two runs is a property of the data rather than of two
 * different mock objects, and a wipe that fails leaves the keys where a residue probe finds them.
 */
interface FakeService {
  readonly operator: ServiceOperator;
  readonly data: Map<string, Set<string>>;
  readonly started: string[];
  readonly destroyed: string[];
  readonly wipes: string[];
  readonly probes: string[];
  put: (instance: ServiceInstance, key: string) => void;
  keys: (instance: ServiceInstance) => readonly string[];
  /** The container disappears while its record survives: the state a reboot leaves behind. */
  vanish: (instance: ServiceInstance) => void;
}

interface FakeOptions {
  /** How many readiness probes an instance answers `false` to before it is ready. */
  readonly readyAfter?: number;
  /** Never ready: the case the declared bound exists for. */
  readonly neverReady?: boolean;
  /** Full control of the readiness answer, for a case that depends on which instance is asked. */
  readonly readyWhen?: (
    instance: ServiceInstance,
    calls: number,
  ) => { readonly ok: boolean; readonly detail: string };
  /** Called with the request at the moment `start` is invoked, before it answers. */
  readonly onStarting?: (request: ServiceStartRequest) => void;
  /** The start invocation fails, so nothing will ever become ready. */
  readonly startFails?: boolean;
  /** The wipe does nothing, which is exactly how residue survives one. */
  readonly wipeDoesNothing?: boolean;
  /** Destroy refuses, so the record must survive for the next pass. */
  readonly destroyFails?: boolean;
  /** Called with the instance name at the moment `start` is invoked. */
  readonly onStart?: (request: ServiceStartRequest) => void;
}

const fakeService = (options: FakeOptions = {}): FakeService => {
  const data = new Map<string, Set<string>>();
  const started: string[] = [];
  const destroyed: string[] = [];
  const wipes: string[] = [];
  const probes: string[] = [];
  const readinessCalls = new Map<string, number>();

  const operator: ServiceOperator = {
    start: (request: ServiceStartRequest) => {
      options.onStarting?.(request);
      options.onStart?.(request);
      started.push(request.containerName);
      data.set(request.containerName, new Set<string>());
      return {
        ok: options.startFails !== true,
        detail: options.startFails === true ? 'the instance refused to start in this fixture' : 'started',
        instance: instanceFor(request),
        argv: [],
      };
    },
    exists: (instance: ServiceInstance) => {
      // The fixture's `data` map is the container's existence: `start` creates the entry, `destroy` and
      // `vanish` remove it. So "the record survived a reboot and the container did not" is expressible.
      const alive = data.has(instance.containerName);
      return { ok: alive, detail: alive ? 'running' : 'no such container in this fixture' };
    },
    ready: (instance: ServiceInstance) => {
      const seen = (readinessCalls.get(instance.containerName) ?? 0) + 1;
      readinessCalls.set(instance.containerName, seen);
      if (options.readyWhen !== undefined) return options.readyWhen(instance, seen);
      if (options.neverReady === true) return { ok: false, detail: 'still starting in this fixture' };
      return { ok: seen > (options.readyAfter ?? 0), detail: `probe ${String(seen)}` };
    },
    sweep: () => ({
      ok: true,
      instances: [...data.keys()].map((containerName) => ({ containerName, kind: null, image: '' })),
      detail: `${String(data.size)} pooled container(s) in this fixture`,
    }),
    wipe: (instance: ServiceInstance) => {
      wipes.push(instance.containerName);
      if (options.wipeDoesNothing === true) return { ok: false, detail: 'the wipe did nothing' };
      data.set(instance.containerName, new Set<string>());
      return { ok: true, detail: 'wiped' };
    },
    residue: (instance: ServiceInstance) => {
      probes.push(instance.containerName);
      const keys = [...(data.get(instance.containerName) ?? new Set<string>())];
      return {
        ok: keys.length === 0,
        residue: keys.map((key) => `the key ${key} survived the wipe`),
        detail: `${String(keys.length)} key(s)`,
      };
    },
    destroy: (instance: ServiceInstance) => {
      if (options.destroyFails === true) return { ok: false, detail: 'the instance would not stop' };
      destroyed.push(instance.containerName);
      data.delete(instance.containerName);
      return { ok: true, detail: 'destroyed' };
    },
  };

  return {
    operator,
    data,
    started,
    destroyed,
    wipes,
    probes,
    put: (instance: ServiceInstance, key: string): void => {
      const keys = data.get(instance.containerName) ?? new Set<string>();
      keys.add(key);
      data.set(instance.containerName, keys);
    },
    keys: (instance: ServiceInstance): readonly string[] => [
      ...(data.get(instance.containerName) ?? new Set<string>()),
    ],
    vanish: (instance: ServiceInstance): void => {
      data.delete(instance.containerName);
    },
  };
};

/**
 * A clock the injected sleep advances, so the bound is exercised without waiting for it.
 *
 * `monotonicNow` reads the same counter as `now`, which is what lets a test see time spent *outside* the
 * sleep: `advance` is the hook a fixture uses to burn time inside `start`, where the bound used not to
 * reach. The pool takes the two separately because only the deadline may be monotonic — a durable record's
 * timestamp has to name a real instant.
 */
const fakeClock = (): {
  readonly now: () => Date;
  readonly monotonicNow: () => number;
  readonly advance: (ms: number) => void;
  readonly sleep: (ms: number) => Promise<void>;
  readonly elapsed: () => number;
} => {
  let millis = 1_770_000_000_000;
  const start = millis;
  return {
    now: (): Date => new Date(millis),
    monotonicNow: (): number => millis,
    advance: (ms: number): void => {
      millis += ms;
    },
    sleep: (ms: number): Promise<void> => {
      millis += ms;
      return Promise.resolve();
    },
    elapsed: (): number => millis - start,
  };
};

describe('acquiring a lease', () => {
  it('hands back a ready instance, recorded durably, reachable on loopback', async () => {
    const orchHome = home('acquire');
    const service = fakeService({ readyAfter: 2 });
    const clock = fakeClock();
    const pool = createLeasePool({
      orchHome,
      operator: service.operator,
      now: clock.now,
      monotonicNow: clock.monotonicNow,
      sleep: clock.sleep,
      mintLeaseId: () => 'lease-one',
    });

    const lease = await pool.acquire({ run: RUN_A, kind: 'postgres' });

    expect(lease.kind).toBe('postgres');
    expect(lease.run).toBe(RUN_A);
    expect(lease.instance.containerName).toBe(instanceNameFor('postgres', 'lease-one'));
    expect(lease.endpoint).toBe(`127.0.0.1:${String(POOL_PORT_BASE)}`);
    expect(lease.reused).toBe(false);
    expect(service.started).toStrictEqual([lease.instance.containerName]);

    // Durable, under ORCH_HOME/pool/, so a pass that did not acquire it can still act on it.
    const records = listLeaseRecords(orchHome);
    expect(records).toHaveLength(1);
    expect(records[0]?.run).toBe(RUN_A);
    expect(records[0]?.container_name).toBe(lease.instance.containerName);
    expect(records[0]?.schema_version).toBe(1);
    expect(existsSync(join(leasesDir(orchHome), 'lease-one.json'))).toBe(true);
    expect(leasesDir(orchHome).startsWith(poolDir(orchHome))).toBe(true);
  });

  it('records the lease before the instance exists, so a crash cannot hide a container', async () => {
    // The other order is the AD-32 leak: a running container nothing on disk mentions.
    const orchHome = home('durable-first');
    let recordsAtStart = 0;
    const service = fakeService({
      onStart: () => {
        recordsAtStart = listLeaseRecords(orchHome).length;
      },
    });
    const clock = fakeClock();
    const pool = createLeasePool({
      orchHome,
      operator: service.operator,
      now: clock.now,
      monotonicNow: clock.monotonicNow,
      sleep: clock.sleep,
    });

    await pool.acquire({ run: RUN_A, kind: 'redis' });
    expect(recordsAtStart).toBe(1);
  });

  it('fails with resource.lease_timed_out at the declared bound rather than waiting', async () => {
    const orchHome = home('timeout');
    const service = fakeService({ neverReady: true });
    const clock = fakeClock();
    const pool = createLeasePool({
      orchHome,
      operator: service.operator,
      now: clock.now,
      monotonicNow: clock.monotonicNow,
      sleep: clock.sleep,
    });

    await expect(pool.acquire({ run: RUN_A, kind: 'redis' })).rejects.toBeInstanceOf(LeaseTimedOutError);

    // The bound is the declared one, and the wait stopped at it rather than continuing.
    expect(clock.elapsed()).toBeGreaterThanOrEqual(LEASE_TIME_BOUND_MS.redis);
    expect(clock.elapsed()).toBeLessThan(LEASE_TIME_BOUND_MS.redis * 2);
  });

  it('carries the declared code, whose disposition is retry-with-backoff', async () => {
    const orchHome = home('timeout-code');
    const service = fakeService({ neverReady: true });
    const clock = fakeClock();
    const pool = createLeasePool({
      orchHome,
      operator: service.operator,
      now: clock.now,
      monotonicNow: clock.monotonicNow,
      sleep: clock.sleep,
    });

    try {
      await pool.acquire({ run: RUN_A, kind: 'redis', timeoutMs: 1_000 });
      expect.unreachable('a pool that produces nothing must fail, never hang');
    } catch (thrown: unknown) {
      const failure = thrown as LeaseTimedOutError;
      expect(failure.code).toBe('resource.lease_timed_out');
      expect(failure.orchError.retryable).toBe(true);
      expect(dispositionFor(failure.code)).toBe('retry-with-backoff');
      expect(failure.boundMs).toBe(1_000);
      expect(failure.message).toContain('1000ms');
    }
    // Nothing is left leased: the instance was destroyed and its record forgotten.
    expect(listLeaseRecords(orchHome)).toStrictEqual([]);
    expect(service.destroyed).toHaveLength(1);
  });

  it('reports a start that failed as container.start_failed, never as the bound expiring', async () => {
    // FIXTURE CHANGED: this case asserted `LeaseTimedOutError`. A bad image pin, a name collision and a
    // busy port are permanent for this request, and `resource.lease_timed_out` is retry-with-backoff — so
    // the old code sent a caller into a retry loop over something no wait fixes. The intent survives
    // intact: the case is still "a start that failed does not wait the bound out", now asserted as
    // `clock.elapsed() === 0` plus the code that actually describes what happened.
    const orchHome = home('start-fails');
    const service = fakeService({ startFails: true });
    const clock = fakeClock();
    const pool = createLeasePool({
      orchHome,
      operator: service.operator,
      now: clock.now,
      monotonicNow: clock.monotonicNow,
      sleep: clock.sleep,
    });
    try {
      await pool.acquire({ run: RUN_A, kind: 'redis' });
      expect.unreachable('a start that failed must be reported, not waited out');
    } catch (thrown: unknown) {
      expect(thrown).toBeInstanceOf(ServiceOperationError);
      expect(thrown).not.toBeInstanceOf(LeaseTimedOutError);
      const failure = thrown as ServiceOperationError;
      expect(failure.code).toBe('container.start_failed');
      expect(dispositionFor(failure.code)).toBe('retry-with-backoff');
      expect(failure.orchError.code).toBe('container.start_failed');
    }
    expect(clock.elapsed()).toBe(0);
  });

  it('counts the time spent inside start against the declared bound', async () => {
    // The bound is declared on "a feature receives a ready instance". A clock that started after
    // `operator.start` returned left the start's own time outside it entirely, so a 30s redis bound could
    // legitimately take 60s — which is the hang CAP-11 forbids, arrived at one layer down.
    const orchHome = home('bound-covers-start');
    const clock = fakeClock();
    const service = fakeService({
      // The start itself burns more than the whole bound, without any sleep being involved.
      onStarting: () => clock.advance(LEASE_TIME_BOUND_MS.redis + 1_000),
    });
    const pool = createLeasePool({
      orchHome,
      operator: service.operator,
      now: clock.now,
      monotonicNow: clock.monotonicNow,
      sleep: clock.sleep,
    });

    await expect(pool.acquire({ run: RUN_A, kind: 'redis' })).rejects.toBeInstanceOf(LeaseTimedOutError);
    // No sleeping happened at all: every millisecond of the bound was spent in `start`.
    expect(clock.elapsed()).toBe(LEASE_TIME_BOUND_MS.redis + 1_000);
  });

  it('hands the start invocation what is left of the bound, so a cold pull cannot outrun it', async () => {
    const orchHome = home('start-timeout');
    const clock = fakeClock();
    let declared: number | undefined;
    const service = fakeService({
      onStarting: (request) => {
        declared = request.timeoutMs;
      },
    });
    const pool = createLeasePool({
      orchHome,
      operator: service.operator,
      now: clock.now,
      monotonicNow: clock.monotonicNow,
      sleep: clock.sleep,
    });
    await pool.acquire({ run: RUN_A, kind: 'redis', timeoutMs: 7_500 });
    expect(declared).toBe(7_500);
  });

  it('refuses a lease when every port in the declared range is held, with a dispositioned code', async () => {
    const orchHome = home('ports');
    const service = fakeService();
    const clock = fakeClock();
    const pool = createLeasePool({
      orchHome,
      operator: service.operator,
      now: clock.now,
      monotonicNow: clock.monotonicNow,
      sleep: clock.sleep,
      allocatePort: () => {
        throw new PoolPortsExhaustedError(POOL_PORT_COUNT);
      },
    });
    try {
      await pool.acquire({ run: RUN_A, kind: 'redis' });
      expect.unreachable('a pool with no free port must refuse');
    } catch (thrown: unknown) {
      expect(thrown).toBeInstanceOf(PoolPortsExhaustedError);
      const failure = thrown as PoolPortsExhaustedError;
      // A bare `Error` stood here, carrying no AD-35 code at all — so it would have been handed off
      // rather than retried, though a port frees the moment another lease is released.
      expect(failure.code).toBe('resource.lease_timed_out');
      expect(dispositionFor(failure.code)).toBe('retry-with-backoff');
    }
  });

  it('keeps the record when the instance could not be destroyed, so the next pass reclaims it', async () => {
    const orchHome = home('destroy-fails');
    const service = fakeService({ neverReady: true, destroyFails: true });
    const clock = fakeClock();
    const pool = createLeasePool({
      orchHome,
      operator: service.operator,
      now: clock.now,
      monotonicNow: clock.monotonicNow,
      sleep: clock.sleep,
    });
    await expect(
      pool.acquire({ run: RUN_A, kind: 'redis', timeoutMs: 500 }),
    ).rejects.toBeInstanceOf(LeaseTimedOutError);
    expect(listLeaseRecords(orchHome)).toHaveLength(1);
  });
});

describe('returning a lease', () => {
  it('wipes it, then verifies it empty, then makes it available again', async () => {
    const orchHome = home('return');
    const service = fakeService();
    const clock = fakeClock();
    const pool = createLeasePool({
      orchHome,
      operator: service.operator,
      now: clock.now,
      monotonicNow: clock.monotonicNow,
      sleep: clock.sleep,
      mintLeaseId: () => 'lease-clean',
    });

    const lease = await pool.acquire({ run: RUN_A, kind: 'redis' });
    service.put(lease.instance, 'feature:data');
    expect(service.keys(lease.instance)).toHaveLength(1);

    const returned = pool.release(lease);

    expect(returned.wiped).toBe(true);
    expect(returned.verifiedEmpty).toBe(true);
    expect(returned.available).toBe(true);
    // Wiped *then* checked: both happened, and in that order.
    expect(service.wipes).toStrictEqual([lease.instance.containerName]);
    expect(service.probes).toStrictEqual([lease.instance.containerName]);
    expect(service.keys(lease.instance)).toStrictEqual([]);

    // The lease is gone and the instance is warm inventory, recorded where a restart can find it.
    expect(listLeaseRecords(orchHome)).toStrictEqual([]);
    expect(listWarmRecords(orchHome)).toHaveLength(1);
    expect(existsSync(join(warmDir(orchHome), `${lease.instance.containerName}.json`))).toBe(true);
  });

  it('leases the warm instance back out rather than starting a second one', async () => {
    const orchHome = home('warm');
    const service = fakeService();
    const clock = fakeClock();
    let minted = 0;
    const pool = createLeasePool({
      orchHome,
      operator: service.operator,
      now: clock.now,
      monotonicNow: clock.monotonicNow,
      sleep: clock.sleep,
      mintLeaseId: () => {
        minted += 1;
        return `lease-${String(minted)}`;
      },
    });

    const first = await pool.acquire({ run: RUN_A, kind: 'redis' });
    pool.release(first);
    const second = await pool.acquire({ run: RUN_B, kind: 'redis' });

    expect(second.reused).toBe(true);
    expect(second.instance.containerName).toBe(first.instance.containerName);
    expect(second.lease).not.toBe(first.lease);
    expect(service.started).toHaveLength(1);
    // Claimed out of the inventory, so two runs cannot hold the same instance.
    expect(listWarmRecords(orchHome)).toStrictEqual([]);
    expect(listLeaseRecords(orchHome)).toHaveLength(1);
  });

  it('never lets two concurrent claims of one warm record both win', async () => {
    // The old claim was `rmSync(..., { force: true })`, and `force` swallows ENOENT — so two acquires both
    // listed the record, both "succeeded", and both wrote a lease naming one container. That is this
    // story's own "two runs, one kind → neither sees the other's data" criterion failing outright.
    const orchHome = home('claim-race');
    const service = fakeService();
    const clock = fakeClock();
    let minted = 0;
    const pool = createLeasePool({
      orchHome,
      operator: service.operator,
      now: clock.now,
      monotonicNow: clock.monotonicNow,
      sleep: clock.sleep,
      mintLeaseId: () => {
        minted += 1;
        return `lease-${String(minted)}`;
      },
    });

    const first = await pool.acquire({ run: RUN_A, kind: 'redis' });
    pool.release(first);
    expect(listWarmRecords(orchHome)).toHaveLength(1);

    const [left, right] = await Promise.all([
      pool.acquire({ run: RUN_A, kind: 'redis' }),
      pool.acquire({ run: RUN_B, kind: 'redis' }),
    ]);

    // Exactly one of the two reused the warm instance; the other started its own.
    expect([left.reused, right.reused].filter((reused) => reused)).toHaveLength(1);
    expect(left.instance.containerName).not.toBe(right.instance.containerName);
    const records = listLeaseRecords(orchHome);
    expect(records).toHaveLength(2);
    expect(new Set(records.map((record) => record.container_name)).size).toBe(2);
    expect(listWarmRecords(orchHome)).toStrictEqual([]);
    // And nothing was left mid-claim: the hand-over completed for both.
    expect(listIdleInstances(orchHome)).toStrictEqual([]);
  });

  it('records the warm instance somewhere durable at every instant of the hand-over', async () => {
    // `release()` deliberately writes the warm record before dropping the lease record, so no window exists
    // in which the instance is recorded nowhere. `claimWarm` used to do the exact opposite — delete the warm
    // record, *then* write the lease record — so a crash between them left a running container mentioned by
    // neither directory, which nothing enumerates and no pass can ever see.
    const orchHome = home('warm-ordering');
    const service = fakeService();
    const clock = fakeClock();
    let minted = 0;
    const pool = createLeasePool({
      orchHome,
      operator: service.operator,
      now: clock.now,
      monotonicNow: clock.monotonicNow,
      sleep: clock.sleep,
      mintLeaseId: () => {
        minted += 1;
        return `lease-${String(minted)}`;
      },
    });

    const first = await pool.acquire({ run: RUN_A, kind: 'redis' });
    pool.release(first);
    const container = first.instance.containerName;

    // Every observation the fixture can make during the second acquire: the container is named by a warm
    // record, by a claim record or by a lease record — never by none of them.
    const sightings: string[] = [];
    const observe = (): void => {
      const named =
        listWarmRecords(orchHome).some((record) => record.container_name === container) ||
        listIdleInstances(orchHome).some((entry) => entry.record.container_name === container) ||
        listLeaseRecords(orchHome).some((record) => record.container_name === container);
      sightings.push(named ? 'recorded' : 'invisible');
    };
    const watched = fakeService({ readyWhen: () => (observe(), { ok: true, detail: 'ready' }) });
    const secondPool = createLeasePool({
      orchHome,
      operator: {
        ...watched.operator,
        exists: () => (observe(), { ok: true, detail: 'running' }),
      },
      now: clock.now,
      monotonicNow: clock.monotonicNow,
      sleep: clock.sleep,
      mintLeaseId: () => 'lease-second',
    });

    const second = await secondPool.acquire({ run: RUN_B, kind: 'redis' });
    expect(second.instance.containerName).toBe(container);
    expect(sightings.length).toBeGreaterThan(0);
    expect(sightings).not.toContain('invisible');
  });

  it('starts fresh rather than burning the bound on a warm record whose container is gone', async () => {
    // Records are durable and containers are not, so this is the state every reboot leaves. Polling a
    // container that no longer exists for the whole declared bound and then failing is a lease that should
    // simply have started a new instance.
    const orchHome = home('stale-warm');
    const service = fakeService();
    const clock = fakeClock();
    let minted = 0;
    const pool = createLeasePool({
      orchHome,
      operator: service.operator,
      now: clock.now,
      monotonicNow: clock.monotonicNow,
      sleep: clock.sleep,
      mintLeaseId: () => {
        minted += 1;
        return `lease-${String(minted)}`;
      },
    });

    const first = await pool.acquire({ run: RUN_A, kind: 'redis' });
    pool.release(first);
    service.vanish(first.instance); // the reboot: the record survives, the container does not

    const second = await pool.acquire({ run: RUN_B, kind: 'redis' });
    expect(second.reused).toBe(false);
    expect(second.instance.containerName).not.toBe(first.instance.containerName);
    expect(clock.elapsed()).toBe(0);
    // The dead record is gone, not left to be claimed again on the next acquire.
    expect(listWarmRecords(orchHome)).toStrictEqual([]);
    expect(listIdleInstances(orchHome)).toStrictEqual([]);
  });

  it('holds a reused instance to the same readiness bound, and hands back no endpoint when it fails', async () => {
    // Removing the readiness wait for a reused instance kept every other test green: the warm case's double
    // reports ready on its first call. So the wait was asserted by nothing at all.
    const orchHome = home('warm-not-ready');
    const clock = fakeClock();
    let serving = true;
    const service = fakeService({
      readyWhen: () => ({ ok: serving, detail: serving ? 'ready' : 'not serving in this fixture' }),
    });
    let minted = 0;
    const pool = createLeasePool({
      orchHome,
      operator: service.operator,
      now: clock.now,
      monotonicNow: clock.monotonicNow,
      sleep: clock.sleep,
      mintLeaseId: () => {
        minted += 1;
        return `lease-${String(minted)}`;
      },
    });

    const first = await pool.acquire({ run: RUN_A, kind: 'redis' });
    pool.release(first);
    serving = false; // the container is still there; it has stopped answering

    let endpoint: string | null = null;
    try {
      const second = await pool.acquire({ run: RUN_B, kind: 'redis', timeoutMs: 2_000 });
      endpoint = second.endpoint;
      expect.unreachable('a reused instance that does not serve must not be handed to a run');
    } catch (thrown: unknown) {
      expect(thrown).toBeInstanceOf(LeaseTimedOutError);
      expect((thrown as LeaseTimedOutError).boundMs).toBe(2_000);
    }
    expect(endpoint).toBe(null);
    expect(clock.elapsed()).toBeGreaterThanOrEqual(2_000);
    // Nothing is left leased and nothing rejoined the inventory: the instance was destroyed.
    expect(listLeaseRecords(orchHome)).toStrictEqual([]);
    expect(listWarmRecords(orchHome)).toStrictEqual([]);
  });

  it('refuses to release a lease this pool no longer records as held', async () => {
    // A stale `Lease` released twice, or released after a pass reclaimed it, would wipe whatever
    // `lease.instance` names — and by then that container can belong to another run which acquired it out
    // of the warm inventory. The durable record is the only authority on who holds an instance.
    const orchHome = home('stale-release');
    const service = fakeService();
    const clock = fakeClock();
    const pool = createLeasePool({
      orchHome,
      operator: service.operator,
      now: clock.now,
      monotonicNow: clock.monotonicNow,
      sleep: clock.sleep,
      mintLeaseId: () => 'lease-once',
    });

    const lease = await pool.acquire({ run: RUN_A, kind: 'redis' });
    pool.release(lease);
    const wipesAfterFirst = service.wipes.length;

    // The second release names a lease record that no longer exists.
    try {
      pool.release(lease);
      expect.unreachable('a lease released twice must be refused');
    } catch (thrown: unknown) {
      expect(thrown).toBeInstanceOf(LeaseNotHeldError);
      const refusal = thrown as LeaseNotHeldError;
      expect(refusal.code).toBe('internal.invariant_violated');
      expect(refusal.message).toContain('lease-once');
    }
    // Nothing was wiped the second time round, so a warm instance another run now holds is untouched.
    expect(service.wipes).toHaveLength(wipesAfterFirst);
  });

  it('refuses to release a lease whose record names a different container', async () => {
    const orchHome = home('mismatched-release');
    const service = fakeService();
    const clock = fakeClock();
    const pool = createLeasePool({
      orchHome,
      operator: service.operator,
      now: clock.now,
      monotonicNow: clock.monotonicNow,
      sleep: clock.sleep,
      mintLeaseId: () => 'lease-mismatch',
    });
    const lease = await pool.acquire({ run: RUN_A, kind: 'redis' });
    const impostor = {
      ...lease,
      instance: { ...lease.instance, containerName: 'orch-pool-redis-somebody-else' },
    };
    expect(() => pool.release(impostor)).toThrow(LeaseNotHeldError);
    expect(service.wipes).toStrictEqual([]);
  });

  it('quarantines an instance whose wipe failed, even when the probe happened to read clean', async () => {
    // `wiped` was recorded and acted on by nothing, so an instance whose wipe errored rejoined the pool on
    // the strength of one probe — and a probe only verifies what it knows how to look at. CAP-11 claims
    // "wiped, then verified empty"; half of that failing is not a clean return.
    const orchHome = home('wipe-failed');
    const service = fakeService({ wipeDoesNothing: true });
    const clock = fakeClock();
    const pool = createLeasePool({
      orchHome,
      operator: service.operator,
      now: clock.now,
      monotonicNow: clock.monotonicNow,
      sleep: clock.sleep,
      mintLeaseId: () => 'lease-wipe-failed',
    });

    // Nothing is put in it, so the emptiness probe reads clean: the wipe's own failure is the only signal.
    const lease = await pool.acquire({ run: RUN_A, kind: 'redis' });
    expect(service.keys(lease.instance)).toStrictEqual([]);

    try {
      pool.release(lease);
      expect.unreachable('a failed wipe must not return an instance to the pool');
    } catch (thrown: unknown) {
      expect(thrown).toBeInstanceOf(LeaseReturnDirtyError);
      expect((thrown as LeaseReturnDirtyError).residue.join(' ')).toContain('the wipe itself failed');
    }
    expect(listWarmRecords(orchHome)).toStrictEqual([]);
    expect(listQuarantinedRecords(orchHome)).toHaveLength(1);
  });

  it('destroys a returned instance rather than keeping it past the warm ceiling', async () => {
    const orchHome = home('warm-ceiling');
    const service = fakeService();
    const clock = fakeClock();
    let minted = 0;
    const pool = createLeasePool({
      orchHome,
      operator: service.operator,
      now: clock.now,
      monotonicNow: clock.monotonicNow,
      sleep: clock.sleep,
      mintLeaseId: () => {
        minted += 1;
        return `lease-${String(minted)}`;
      },
    });

    // One more than the ceiling, all held at once, then all returned.
    const leases = [];
    for (let index = 0; index <= MAX_WARM_PER_KIND; index += 1) {
      leases.push(await pool.acquire({ run: RUN_A, kind: 'redis' }));
    }
    const returns = leases.map((lease) => pool.release(lease));

    expect(returns.filter((returned) => returned.available)).toHaveLength(MAX_WARM_PER_KIND);
    const destroyed = returns.filter((returned) => !returned.available);
    expect(destroyed).toHaveLength(1);
    expect(destroyed[0]?.verifiedEmpty).toBe(true);
    expect(destroyed[0]?.reason).toContain('ceiling');
    expect(listWarmRecords(orchHome)).toHaveLength(MAX_WARM_PER_KIND);
  });

  it('refuses a dirty resource with resource.return_dirty and never reissues it', async () => {
    const orchHome = home('dirty');
    const service = fakeService({ wipeDoesNothing: true });
    const clock = fakeClock();
    let minted = 0;
    const pool = createLeasePool({
      orchHome,
      operator: service.operator,
      now: clock.now,
      monotonicNow: clock.monotonicNow,
      sleep: clock.sleep,
      mintLeaseId: () => {
        minted += 1;
        return `lease-${String(minted)}`;
      },
    });

    const lease = await pool.acquire({ run: RUN_A, kind: 'postgres' });
    service.put(lease.instance, 'orders');

    try {
      pool.release(lease);
      expect.unreachable('a resource with residue must not be handed on');
    } catch (thrown: unknown) {
      expect(thrown).toBeInstanceOf(LeaseReturnDirtyError);
      const refusal = thrown as LeaseReturnDirtyError;
      expect(refusal.code).toBe('resource.return_dirty');
      expect(dispositionFor(refusal.code)).toBe('escalate-to-human');
      expect(refusal.orchError.retryable).toBe(false);
      expect(refusal.residue.join(' ')).toContain('orders');
    }

    // Quarantined, with the residue recorded: a person can see what was in it.
    expect(listLeaseRecords(orchHome)).toStrictEqual([]);
    const quarantined = listQuarantinedRecords(orchHome);
    expect(quarantined).toHaveLength(1);
    expect(quarantined[0]?.residue?.join(' ')).toContain('orders');
    expect(existsSync(join(quarantineDir(orchHome), 'lease-1.json'))).toBe(true);

    // Never reissued: the next acquire starts a different instance.
    expect(listWarmRecords(orchHome)).toStrictEqual([]);
    const next = await pool.acquire({ run: RUN_B, kind: 'postgres' });
    expect(next.instance.containerName).not.toBe(lease.instance.containerName);
    expect(next.reused).toBe(false);
  });

  it('checks emptiness even when the wipe reported success, because the fact is about the instance', async () => {
    const orchHome = home('probe-always');
    const service = fakeService();
    const clock = fakeClock();
    const pool = createLeasePool({
      orchHome,
      operator: service.operator,
      now: clock.now,
      monotonicNow: clock.monotonicNow,
      sleep: clock.sleep,
    });
    const lease = await pool.acquire({ run: RUN_A, kind: 'redis' });
    pool.release(lease);
    expect(service.probes).toHaveLength(1);
  });
});

describe('two runs, one kind', () => {
  it('gives each its own instance, and neither can read the other’s data', async () => {
    const orchHome = home('isolation');
    const service = fakeService();
    const clock = fakeClock();
    let minted = 0;
    const pool = createLeasePool({
      orchHome,
      operator: service.operator,
      now: clock.now,
      monotonicNow: clock.monotonicNow,
      sleep: clock.sleep,
      mintLeaseId: () => {
        minted += 1;
        return `lease-${String(minted)}`;
      },
    });

    const first = await pool.acquire({ run: RUN_A, kind: 'redis' });
    const second = await pool.acquire({ run: RUN_B, kind: 'redis' });

    expect(second.instance.containerName).not.toBe(first.instance.containerName);
    expect(second.instance.hostPort).not.toBe(first.instance.hostPort);

    service.put(first.instance, 'a-secret');
    service.put(second.instance, 'b-secret');
    expect(service.keys(first.instance)).toStrictEqual(['a-secret']);
    expect(service.keys(second.instance)).toStrictEqual(['b-secret']);

    // Two records, one per run, each naming its own instance.
    const records = [...listLeaseRecords(orchHome)].sort((left, right) => left.run.localeCompare(right.run));
    expect(records.map((record) => record.run)).toStrictEqual([RUN_A, RUN_B].sort());
    expect(new Set(records.map((record) => record.container_name)).size).toBe(2);
    expect(new Set(records.map((record) => record.host_port)).size).toBe(2);
  });
});

describe('the pool’s durable records', () => {
  it('refuses a record written by a schema version this build does not read (AD-28)', () => {
    const orchHome = home('schema');
    mkdirSync(leasesDir(orchHome), { recursive: true });
    writeFileSync(
      join(leasesDir(orchHome), 'lease-future.json'),
      JSON.stringify({
        schema_version: 99,
        lease: 'lease-future',
        run: RUN_A,
        kind: 'redis',
        container_name: 'orch-pool-redis-lease-future',
        host_port: 55_400,
        image: 'redis:7.4-alpine',
        acquired_at: '2026-09-20T00:00:00.000Z',
      }),
      'utf8',
    );
    // Loud, not skipped: acting on a resource whose shape changed is how a sweep destroys the wrong thing.
    expect(() => listLeaseRecords(orchHome)).toThrow(/schema_version 99/);
  });

  it('skips a corrupt record rather than letting it stop the pass, and says which one', () => {
    // FIXTURE EXTENDED: this case asserted only the silent skip. Skipping is still right — one half-written
    // file must not stop the pass reclaiming every other resource — but a *silent* skip makes the resource
    // that record named invisible, which is the same failure shape AD-32 exists to prevent. The intent
    // survives: the skip is still asserted, and now so is the report that goes with it.
    const orchHome = home('corrupt');
    mkdirSync(leasesDir(orchHome), { recursive: true });
    writeFileSync(join(leasesDir(orchHome), 'half-written.json'), '{"schema_version": 1, "lea', 'utf8');

    const skips: RecordSkip[] = [];
    expect(listLeaseRecords(orchHome, (skip) => skips.push(skip))).toStrictEqual([]);
    expect(skips).toHaveLength(1);
    expect(skips[0]?.file).toBe('half-written.json');
    expect(skips[0]?.path).toBe(join(leasesDir(orchHome), 'half-written.json'));
    expect(skips[0]?.reason.length).toBeGreaterThan(10);
  });

  it('reports a record of a shape this build does not recognise, rather than dropping it', () => {
    const orchHome = home('wrong-shape');
    mkdirSync(leasesDir(orchHome), { recursive: true });
    // Valid JSON, valid schema_version, and no `container_name`: nothing can act on the resource it names.
    writeFileSync(
      join(leasesDir(orchHome), 'shapeless.json'),
      JSON.stringify({ schema_version: 1, lease: 'shapeless', run: RUN_A, kind: 'redis' }),
      'utf8',
    );
    const skips: RecordSkip[] = [];
    expect(listLeaseRecords(orchHome, (skip) => skips.push(skip))).toStrictEqual([]);
    expect(skips.map((skip) => skip.file)).toStrictEqual(['shapeless.json']);
  });

  it('gives a warm instance an idle TTL, because no run holds one for a pass to compare against', async () => {
    const orchHome = home('warm-ttl');
    const service = fakeService();
    const clock = fakeClock();
    const pool = createLeasePool({
      orchHome,
      operator: service.operator,
      now: clock.now,
      monotonicNow: clock.monotonicNow,
      sleep: clock.sleep,
      mintLeaseId: () => 'lease-ttl',
    });

    const lease = await pool.acquire({ run: RUN_A, kind: 'redis' });
    pool.release(lease);
    const idle = listIdleInstances(orchHome);
    expect(idle).toHaveLength(1);
    expect(idle[0]?.origin).toBe('warm');

    // Inside the TTL it is retained; past it, it is expired. The comparison is pure: it writes nothing.
    const fresh = decideWarmExpiry(idle, new Date(clock.now().getTime() + WARM_IDLE_TTL_MS - 1));
    expect(fresh[0]?.expired).toBe(false);
    const stale = decideWarmExpiry(idle, new Date(clock.now().getTime() + WARM_IDLE_TTL_MS));
    expect(stale[0]?.expired).toBe(true);
    expect(stale[0]?.reason).toContain('past the declared TTL');
    expect(listIdleInstances(orchHome)).toHaveLength(1);

    // Acting on it destroys the container and forgets exactly the file the enumeration read.
    const released = pool.reclaimIdle(idle[0]!);
    expect(released.reclaimed).toBe(true);
    expect(service.destroyed).toStrictEqual([lease.instance.containerName]);
    expect(listIdleInstances(orchHome)).toStrictEqual([]);
  });

  it('names a pooled container no record accounts for, so a lost record is not a silent leak', async () => {
    // `SERVICE_LABEL_KEYS` was documented as the sweep's discovery mechanism and nothing swept by it, so a
    // container whose durable record was lost was reclaimable by no pass and mentioned by nothing at all.
    const orchHome = home('unrecorded');
    const service = fakeService();
    const clock = fakeClock();
    const pool = createLeasePool({
      orchHome,
      operator: service.operator,
      now: clock.now,
      monotonicNow: clock.monotonicNow,
      sleep: clock.sleep,
      mintLeaseId: () => 'lease-recorded',
    });

    const lease = await pool.acquire({ run: RUN_A, kind: 'redis' });
    // While the record is there, the container is accounted for.
    expect(pool.unrecorded()).toStrictEqual({
      ok: true,
      containerNames: [],
      detail: '0 of 1 pooled container(s) are named by no record of this pool',
    });

    // The record is lost — a truncated write, a deleted file — and the container stays up.
    rmSync(join(leasesDir(orchHome), 'lease-recorded.json'), { force: true });
    const swept = pool.unrecorded();
    expect(swept.ok).toBe(true);
    expect(swept.containerNames).toStrictEqual([lease.instance.containerName]);
    // Reported, never destroyed: the label set carries no ORCH_HOME, so it cannot tell this home's
    // containers from another home's on the same machine.
    expect(service.destroyed).toStrictEqual([]);
  });

  it('never reads a sweep that could not run as “every container is accounted for”', async () => {
    const orchHome = home('unrecorded-fails');
    const service = fakeService();
    const clock = fakeClock();
    const pool = createLeasePool({
      orchHome,
      operator: {
        ...service.operator,
        sweep: () => ({ ok: false, instances: [], detail: 'the runtime did not answer' }),
      },
      now: clock.now,
      monotonicNow: clock.monotonicNow,
      sleep: clock.sleep,
    });
    await pool.acquire({ run: RUN_A, kind: 'redis' });
    const swept = pool.unrecorded();
    expect(swept.ok).toBe(false);
    expect(swept.detail).toContain('could not run');
  });

  it('never expires an idle record whose returned_at this build cannot read', () => {
    const orchHome = home('warm-unreadable');
    const entry = {
      record: {
        schema_version: 1,
        kind: 'redis' as const,
        container_name: 'orch-pool-redis-unreadable',
        host_port: 55_499,
        image: 'redis:7.4-alpine',
        returned_at: 'not a timestamp',
      },
      path: join(warmDir(orchHome), 'orch-pool-redis-unreadable.json'),
      origin: 'warm' as const,
    };
    const [decision] = decideWarmExpiry([entry], new Date());
    expect(decision?.expired).toBe(false);
    expect(decision?.reason).toContain('unreadable returned_at');
  });

  it('reclaims a recorded lease by destroying its instance and forgetting the record', async () => {
    const orchHome = home('reclaim');
    const service = fakeService();
    const clock = fakeClock();
    const pool = createLeasePool({
      orchHome,
      operator: service.operator,
      now: clock.now,
      monotonicNow: clock.monotonicNow,
      sleep: clock.sleep,
      mintLeaseId: () => 'lease-reclaim',
    });
    const lease = await pool.acquire({ run: RUN_A, kind: 'redis' });
    const record = listLeaseRecords(orchHome)[0];
    expect(record).toBeDefined();

    const outcome = pool.reclaim(record!);
    expect(outcome.reclaimed).toBe(true);
    expect(service.destroyed).toStrictEqual([lease.instance.containerName]);
    expect(listLeaseRecords(orchHome)).toStrictEqual([]);
  });

  it('reports a reclamation that could not destroy the instance, leaving the record standing', async () => {
    const orchHome = home('reclaim-fails');
    const service = fakeService({ destroyFails: true });
    const clock = fakeClock();
    const pool = createLeasePool({
      orchHome,
      operator: service.operator,
      now: clock.now,
      monotonicNow: clock.monotonicNow,
      sleep: clock.sleep,
    });
    await pool.acquire({ run: RUN_A, kind: 'redis' });
    const record = listLeaseRecords(orchHome)[0];
    const outcome = pool.reclaim(record!);
    expect(outcome.reclaimed).toBe(false);
    expect(listLeaseRecords(orchHome)).toHaveLength(1);
  });
});

/** Probed once, at import time, exactly as story 1-5's assertion suite does. */
const runtime = probeContainerRuntime();

const liveSuiteName = runtime.reachable
  ? 'CAP-11 — a real leased instance, against a real container runtime'
  : `CAP-11 — a real leased instance, against a real container runtime [${CONTAINMENT_SKIP_MARKER}: ${runtime.detail}]`;

describe.skipIf(!runtime.reachable)(liveSuiteName, () => {
  it(
    'starts, becomes ready, wipes clean and is destroyed',
    async () => {
      const orchHome = home('live');
      const invoke = createContainerInvoker();
      const operator = createServiceOperator(invoke);
      const pool = createLeasePool({ orchHome, operator });

      const lease = await pool.acquire({ run: RUN_A, kind: 'redis' });
      try {
        expect(lease.endpoint.startsWith('127.0.0.1:')).toBe(true);
        expect(operator.ready(lease.instance).ok).toBe(true);
        expect(operator.exists(lease.instance).ok).toBe(true);

        // FIXTURE FIXED: this case asserted `definition.wipe.length > 0` under a comment claiming data had
        // been put in the instance. Nothing ever wrote any, so CAP-11's central claim would have passed
        // against an instance that was empty the whole time. Real keys, in two different databases, because
        // `flushall` clears all sixteen and the old `dbsize` probe read only the selected one.
        const definition = serviceDefinition('redis');
        expect(definition.wipe.length).toBeGreaterThan(0);
        for (const [database, key] of [
          ['0', 'orch:probe:zero'],
          ['3', 'orch:probe:three'],
        ]) {
          const written = invoke({
            subcommand: CONTAINER_SUBCOMMANDS.exec,
            args: composeServiceExecArgs(lease.instance, [
              'redis-cli',
              '-n',
              database ?? '0',
              'set',
              key ?? '',
              'a feature wrote this',
            ]),
          });
          expect(written.status, written.stderr).toBe(0);
        }

        // The instance really is dirty now, and the probe really sees it: without this the next assertion
        // would be a claim about nothing.
        const dirty = operator.residue(lease.instance);
        expect(dirty.ok).toBe(false);
        expect(dirty.residue.join(' ')).toContain('survived the wipe');

        const returned = pool.release(lease);
        expect(returned.wiped).toBe(true);
        expect(returned.verifiedEmpty).toBe(true);
        // And asked again, directly: the wipe emptied every database, not only the selected one.
        expect(operator.residue(lease.instance).residue).toStrictEqual([]);
      } finally {
        // Test hygiene, not the system's reclamation path: the pass in reclaim.ts is what a run relies
        // on, and this line exists so a skipped daemon does not leave a container on a dev machine.
        operator.destroy(lease.instance);
      }
    },
    5 * 60 * 1000,
  );
});

/** The skip has to be visible in the output, not a blank line. Asserted by reading this file back. */
describe('the live suite’s own visibility', () => {
  it('names its skip in the suite title, through story 1-5’s marker', () => {
    const source = readFileSync(new URL('pool.lease.test.ts', import.meta.url), 'utf8');
    expect(source).toContain('describe.skipIf(!runtime.reachable)');
    expect(source).toContain('CONTAINMENT_SKIP_MARKER');
  });

  it('writes no AD-31 gate marker of its own', () => {
    // The containment gate has one writer, in `tests/container.assertion.test.ts`. A second would be a
    // second thing to keep honest, which is exactly what story 1-6 was told not to build.
    const source = readFileSync(new URL('pool.lease.test.ts', import.meta.url), 'utf8');
    // A regex for the *call*, since naming the function in this assertion is itself a mention.
    expect(source).not.toMatch(/recordContainmentMarker\(/);
  });
});
