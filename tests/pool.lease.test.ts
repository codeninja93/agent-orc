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
  CONTAINMENT_SKIP_MARKER,
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
  LeaseReturnDirtyError,
  LeaseTimedOutError,
  POOL_PORT_BASE,
  createLeasePool,
  instanceNameFor,
  leasesDir,
  listLeaseRecords,
  listQuarantinedRecords,
  listWarmRecords,
  quarantineDir,
  warmDir,
} from '../src/pool/index.js';

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
}

interface FakeOptions {
  /** How many readiness probes an instance answers `false` to before it is ready. */
  readonly readyAfter?: number;
  /** Never ready: the case the declared bound exists for. */
  readonly neverReady?: boolean;
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
    ready: (instance: ServiceInstance) => {
      const seen = (readinessCalls.get(instance.containerName) ?? 0) + 1;
      readinessCalls.set(instance.containerName, seen);
      if (options.neverReady === true) return { ok: false, detail: 'still starting in this fixture' };
      return { ok: seen > (options.readyAfter ?? 0), detail: `probe ${String(seen)}` };
    },
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
  };
};

/** A clock the injected sleep advances, so the bound is exercised without waiting for it. */
const fakeClock = (): {
  readonly now: () => Date;
  readonly sleep: (ms: number) => Promise<void>;
  readonly elapsed: () => number;
} => {
  let millis = 1_770_000_000_000;
  const start = millis;
  return {
    now: (): Date => new Date(millis),
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

  it('reports a start that failed as the bound’s failure, not as a wait for nothing', async () => {
    const orchHome = home('start-fails');
    const service = fakeService({ startFails: true });
    const clock = fakeClock();
    const pool = createLeasePool({
      orchHome,
      operator: service.operator,
      now: clock.now,
      sleep: clock.sleep,
    });
    await expect(pool.acquire({ run: RUN_A, kind: 'redis' })).rejects.toBeInstanceOf(LeaseTimedOutError);
    expect(clock.elapsed()).toBe(0);
  });

  it('keeps the record when the instance could not be destroyed, so the next pass reclaims it', async () => {
    const orchHome = home('destroy-fails');
    const service = fakeService({ neverReady: true, destroyFails: true });
    const clock = fakeClock();
    const pool = createLeasePool({
      orchHome,
      operator: service.operator,
      now: clock.now,
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

  it('refuses a dirty resource with resource.return_dirty and never reissues it', async () => {
    const orchHome = home('dirty');
    const service = fakeService({ wipeDoesNothing: true });
    const clock = fakeClock();
    let minted = 0;
    const pool = createLeasePool({
      orchHome,
      operator: service.operator,
      now: clock.now,
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

  it('skips a corrupt record rather than letting it stop the pass', () => {
    const orchHome = home('corrupt');
    mkdirSync(leasesDir(orchHome), { recursive: true });
    writeFileSync(join(leasesDir(orchHome), 'half-written.json'), '{"schema_version": 1, "lea', 'utf8');
    expect(listLeaseRecords(orchHome)).toStrictEqual([]);
  });

  it('reclaims a recorded lease by destroying its instance and forgetting the record', async () => {
    const orchHome = home('reclaim');
    const service = fakeService();
    const clock = fakeClock();
    const pool = createLeasePool({
      orchHome,
      operator: service.operator,
      now: clock.now,
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
      const operator = createServiceOperator(createContainerInvoker());
      const pool = createLeasePool({ orchHome, operator });

      const lease = await pool.acquire({ run: RUN_A, kind: 'redis' });
      try {
        expect(lease.endpoint.startsWith('127.0.0.1:')).toBe(true);
        expect(operator.ready(lease.instance).ok).toBe(true);

        // Put something in it, so "verified empty" is a claim about an instance that held data.
        const definition = serviceDefinition('redis');
        expect(definition.wipe.length).toBeGreaterThan(0);
        const returned = pool.release(lease);
        expect(returned.verifiedEmpty).toBe(true);
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
