/**
 * AD-32 — the reclamation pass: a comparison, driven by the loop, that a kill cannot skip.
 *
 * The hardest property to test is the negative one: that nothing is reclaimed by a process exiting. It is
 * covered three ways here, because any one of them alone could pass while the rule was broken:
 *
 * 1. **The comparison is pure.** `decideReclamation` is called with resources and a state reader and its
 *    decisions are asserted, with the filesystem compared before and after to show it wrote nothing.
 * 2. **A kill is simulated by never running the releasing process at all.** The resources are put on disk
 *    directly, as a killed engine would have left them, and a freshly built pass — new objects, nothing
 *    in memory — reclaims every one. Nothing an exit path could have done was available to it.
 * 3. **The source is read.** No `finally`, no `process.on`, no exit or signal handler anywhere in
 *    `src/pool/`. That is a crude check and it is the one that would have caught the tidy-looking
 *    implementation AD-32 exists to forbid.
 *
 * The engine half is asserted here too: the reconciler invokes the pass every pass, reports what it did,
 * and survives a sweep that throws.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, describe, expect, it } from 'vitest';

import { CURRENT_SCHEMA_VERSION, RUN_STATE_FILE_NAME } from '../src/contracts/index.js';
import { AD20_REQUIRED_FLAGS, SERVICE_REQUIRED_FLAGS } from '../src/container/index.js';
import type { FeatureState } from '../src/contracts/index.js';
import { UnsafePathSegmentError, assertSafePathSegment, runPaths, worktreeDir } from '../src/runtime/index.js';
import { Reconciler } from '../src/engine/index.js';
import type {
  ReclaimedResource as EngineReclaimedResource,
  ReclamationSummary as EngineReclamationSummary,
  StepExecutor,
} from '../src/engine/index.js';
import {
  WARM_IDLE_TTL_MS,
  createWorktree,
  decideReclamation,
  enumerateLiveResources,
  fileRunStateReader,
  leasesDir,
  listWorktreeRuns,
  performReclamation,
  quarantineDir,
  reconcilerReclamation,
  runReclamationPass,
  warmDir,
} from '../src/pool/index.js';
import type {
  LeaseRecord,
  LiveResource,
  ReclaimDecision,
  ReclaimedResource as PoolReclaimedResource,
  ReclamationSummary as PoolReclamationSummary,
  RunStateView,
} from '../src/pool/index.js';

import { makeGitWorktree, makeHome, makePlan, planProvider } from './helpers/engine-fixture.js';
import type { GitWorktree } from './helpers/engine-fixture.js';

const TERMINAL_RUN = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const LIVE_RUN = '01BX5ZZKBKACTAV9WEVGEMMVRZ';
const ORPHAN_RUN = '01CY6AALCLBDUBW0XFWHFNNWS0';

const disposables: string[] = [];

afterAll(() => {
  for (const dir of disposables.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const world = (label: string): { readonly home: string; readonly repo: GitWorktree } => {
  const home = realpathSync(makeHome(`reclaim-${label}`));
  const repo = makeGitWorktree(`reclaim-${label}`);
  disposables.push(home, repo.dir);
  return { home, repo };
};

/** A run's checkpoint on disk, as the reconciler would have written it. */
const writeRunState = (home: string, run: string, state: FeatureState): void => {
  const paths = runPaths(run, home);
  mkdirSync(paths.runDir, { recursive: true });
  writeFileSync(paths.eventLog, '{"seq":1,"type":"run.created"}\n', 'utf8');
  writeFileSync(
    join(paths.runDir, RUN_STATE_FILE_NAME),
    JSON.stringify({ schema_version: CURRENT_SCHEMA_VERSION, run, state }),
    'utf8',
  );
};

/** A lease record on disk, as a killed engine would have left one. */
const writeLeaseRecord = (home: string, lease: string, run: string): LeaseRecord => {
  const record: LeaseRecord = {
    schema_version: CURRENT_SCHEMA_VERSION,
    lease,
    run,
    kind: 'redis',
    container_name: `orch-pool-redis-${lease}`,
    host_port: 55_400,
    image: 'redis:7.4-alpine',
    acquired_at: '2026-09-20T00:00:00.000Z',
  };
  mkdirSync(leasesDir(home), { recursive: true });
  writeFileSync(join(leasesDir(home), `${lease}.json`), JSON.stringify(record), 'utf8');
  return record;
};

/** Every path under a directory, sorted: enough to tell whether a call wrote anything. */
const snapshot = (root: string): readonly string[] => {
  const found: string[] = [];
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      found.push(join(dir, entry.name));
      if (entry.isDirectory()) visit(join(dir, entry.name));
    }
  };
  visit(root);
  return found.sort();
};

const resource = (kind: 'worktree' | 'lease', run: string): LiveResource => ({
  kind,
  id: run,
  run,
  handle: `handle-for-${run}`,
});

const view = (present: boolean, state: FeatureState | null): RunStateView => ({
  present,
  state,
  evidence: 'a fixture',
});

describe('the comparison: pure, and exactly AD-32’s sentences', () => {
  it('reclaims a resource whose run reached any terminal disposition', () => {
    for (const state of ['committed', 'hibernated', 'killed', 'handed_off'] as const) {
      const [decision] = decideReclamation([resource('worktree', TERMINAL_RUN)], () => view(true, state));
      expect(decision?.reclaim, state).toBe(true);
      expect(decision?.reason, state).toContain(state);
    }
  });

  it('reclaims a resource whose run state no longer exists', () => {
    const [decision] = decideReclamation([resource('lease', ORPHAN_RUN)], () => view(false, null));
    expect(decision?.reclaim).toBe(true);
    expect(decision?.reason).toContain('no run state exists');
  });

  it('reclaims nothing while its run holds a non-terminal disposition', () => {
    for (const state of [
      'drafting',
      'confirmed',
      'running',
      'blocked',
      'degraded',
      'interrupted',
      'verifying',
    ] as const) {
      const [decision] = decideReclamation([resource('worktree', LIVE_RUN)], () => view(true, state));
      expect(decision?.reclaim, state).toBe(false);
      expect(decision?.reason, state).toContain(state);
    }
  });

  it('retains a resource whose run state exists but could not be read as a disposition', () => {
    // Erring toward retention is the only direction that cannot destroy a live run's work.
    const [decision] = decideReclamation([resource('worktree', LIVE_RUN)], () => view(true, null));
    expect(decision?.reclaim).toBe(false);
  });

  it('writes nothing, removes nothing and asks nothing of a runtime', () => {
    const { home } = world('pure');
    writeRunState(home, TERMINAL_RUN, 'committed');
    writeLeaseRecord(home, 'lease-pure', TERMINAL_RUN);
    const before = snapshot(home);

    const decisions = decideReclamation(enumerateLiveResources({ orchHome: home }), fileRunStateReader(home));

    expect(decisions.length).toBeGreaterThan(0);
    expect(decisions.every((decision) => decision.reclaim)).toBe(true);
    expect(snapshot(home)).toStrictEqual(before);
  });
});

describe('AD-33 — absence of run state, not absence of a path', () => {
  it('retains resources of a run with an event log but no checkpoint yet', () => {
    const { home } = world('no-checkpoint');
    const paths = runPaths(LIVE_RUN, home);
    mkdirSync(paths.runDir, { recursive: true });
    writeFileSync(paths.eventLog, '{"seq":1,"type":"run.created"}\n', 'utf8');
    writeLeaseRecord(home, 'lease-nc', LIVE_RUN);

    const state = fileRunStateReader(home)(LIVE_RUN);
    expect(state.present).toBe(true);
    expect(state.state).toBe(null);
    const [decision] = decideReclamation(enumerateLiveResources({ orchHome: home }), fileRunStateReader(home));
    expect(decision?.reclaim).toBe(false);
  });

  it('treats a run with neither checkpoint nor log as carrying no state at all', () => {
    const { home } = world('neither');
    mkdirSync(runPaths(ORPHAN_RUN, home).runDir, { recursive: true });
    const state = fileRunStateReader(home)(ORPHAN_RUN);
    expect(state.present).toBe(false);

    // And a run directory that never existed reads the same way: the *state* is the signal either way.
    expect(fileRunStateReader(home)('01DZ7BBMDMCEVCX1YGXIGOOXT1').present).toBe(false);
  });

  it('retains a run whose checkpoint this build cannot read (AD-28)', () => {
    const { home } = world('bad-schema');
    const paths = runPaths(LIVE_RUN, home);
    mkdirSync(paths.runDir, { recursive: true });
    writeFileSync(
      join(paths.runDir, RUN_STATE_FILE_NAME),
      JSON.stringify({ schema_version: 99, run: LIVE_RUN, state: 'committed' }),
      'utf8',
    );
    const state = fileRunStateReader(home)(LIVE_RUN);
    expect(state.present).toBe(true);
    expect(state.state).toBe(null);
    expect(state.evidence).toContain('AD-28');
  });

  it('retains a run whose checkpoint is corrupt rather than reading it as abandoned', () => {
    const { home } = world('corrupt-state');
    const paths = runPaths(LIVE_RUN, home);
    mkdirSync(paths.runDir, { recursive: true });
    writeFileSync(join(paths.runDir, RUN_STATE_FILE_NAME), '{"schema_version": 1, "sta', 'utf8');
    const state = fileRunStateReader(home)(LIVE_RUN);
    expect(state.present).toBe(true);
    expect(state.state).toBe(null);
  });
});

describe('the pass: enumerate, compare, act', () => {
  it('reclaims a terminal run’s worktree and keeps a live run’s', () => {
    const { home, repo } = world('pass');
    writeRunState(home, TERMINAL_RUN, 'committed');
    writeRunState(home, LIVE_RUN, 'running');
    const doomed = createWorktree({ run: TERMINAL_RUN, repository: repo.dir, orchHome: home });
    const kept = createWorktree({ run: LIVE_RUN, repository: repo.dir, orchHome: home });

    const summary = runReclamationPass({ orchHome: home });

    expect(summary.reclaimed.map((entry) => entry.id)).toStrictEqual([TERMINAL_RUN]);
    expect(summary.retained.map((entry) => entry.id)).toStrictEqual([LIVE_RUN]);
    expect(summary.failed).toStrictEqual([]);
    expect(existsSync(doomed.path)).toBe(false);
    expect(existsSync(kept.path)).toBe(true);
    expect(listWorktreeRuns(home)).toStrictEqual([LIVE_RUN]);
  });

  it('reclaims an orphaned worktree whose run state no longer exists', () => {
    const { home, repo } = world('orphan-pass');
    const orphan = createWorktree({ run: ORPHAN_RUN, repository: repo.dir, orchHome: home });
    expect(existsSync(orphan.path)).toBe(true);

    const summary = runReclamationPass({ orchHome: home });
    expect(summary.reclaimed.map((entry) => entry.id)).toStrictEqual([ORPHAN_RUN]);
    expect(existsSync(orphan.path)).toBe(false);
  });

  it('leaves the run’s evidence where it was', () => {
    const { home, repo } = world('evidence-pass');
    writeRunState(home, TERMINAL_RUN, 'killed');
    createWorktree({ run: TERMINAL_RUN, repository: repo.dir, orchHome: home });
    const log = readFileSync(runPaths(TERMINAL_RUN, home).eventLog, 'utf8');

    runReclamationPass({ orchHome: home });

    expect(existsSync(runPaths(TERMINAL_RUN, home).runDir)).toBe(true);
    expect(readFileSync(runPaths(TERMINAL_RUN, home).eventLog, 'utf8')).toBe(log);
  });

  it('reports a reclaimable lease it has no pool to act through, rather than pretending', () => {
    const { home } = world('no-pool');
    writeRunState(home, TERMINAL_RUN, 'committed');
    writeLeaseRecord(home, 'lease-nopool', TERMINAL_RUN);

    const summary = runReclamationPass({ orchHome: home });
    expect(summary.reclaimed).toStrictEqual([]);
    expect(summary.failed).toHaveLength(1);
    expect(summary.failed[0]?.reason).toContain('no lease pool is configured');
    // Still there, so a pass with a pool configured will reclaim it.
    expect(existsSync(join(leasesDir(home), 'lease-nopool.json'))).toBe(true);
  });

  it('reclaims a lease whose run is terminal and keeps one whose run is live', () => {
    const { home } = world('lease-pass');
    writeRunState(home, TERMINAL_RUN, 'handed_off');
    writeRunState(home, LIVE_RUN, 'verifying');
    const doomed = writeLeaseRecord(home, 'lease-doomed', TERMINAL_RUN);
    writeLeaseRecord(home, 'lease-kept', LIVE_RUN);

    const released: string[] = [];
    const decisions = decideReclamation(
      enumerateLiveResources({ orchHome: home }),
      fileRunStateReader(home),
    );
    const summary = performReclamation(decisions, {
      removeWorktree: () => {
        throw new Error('no worktree exists in this fixture');
      },
      releaseLease: (record: LeaseRecord) => {
        released.push(record.lease);
        rmSync(join(leasesDir(home), `${record.lease}.json`), { force: true });
        return { reclaimed: true, reason: 'destroyed in this fixture' };
      },
    });

    expect(released).toStrictEqual([doomed.lease]);
    expect(summary.reclaimed.map((entry) => entry.id)).toStrictEqual([doomed.lease]);
    expect(summary.retained.map((entry) => entry.id)).toStrictEqual(['lease-kept']);
    expect(existsSync(join(leasesDir(home), 'lease-kept.json'))).toBe(true);
  });

  it('keeps going past a stray directory under worktrees/, rather than aborting the whole pass', () => {
    // `worktreeDir` refuses any segment that is not ULID-shaped, and it refuses by *throwing* — so one
    // `.staging/` beside the real worktrees aborted the enumeration before a single resource was looked at,
    // the reconciler caught it, recorded one refusal and reported `reclaimed: null`. On every pass, for
    // ever. That is the invisible-leak state AD-32 exists to prevent.
    const { home, repo } = world('stray');
    writeRunState(home, TERMINAL_RUN, 'committed');
    const doomed = createWorktree({ run: TERMINAL_RUN, repository: repo.dir, orchHome: home });
    mkdirSync(join(home, 'worktrees', '.staging'), { recursive: true });

    const summary = runReclamationPass({ orchHome: home });

    // The valid resource was still decided and still reclaimed.
    expect(summary.reclaimed.map((entry) => entry.id)).toStrictEqual([TERMINAL_RUN]);
    expect(existsSync(doomed.path)).toBe(false);
    // And the stray is reported rather than dropped, or deleted (AD-33).
    expect(summary.failed.map((entry) => entry.id)).toStrictEqual(['.staging']);
    expect(summary.failed[0]?.reason).toContain('not a usable run id');
    expect(summary.failed[0]?.run).toBe('');
    expect(existsSync(join(home, 'worktrees', '.staging'))).toBe(true);
    // The enumeration itself no longer throws, which is the property the reconciler depends on.
    expect(() => enumerateLiveResources({ orchHome: home })).not.toThrow();
  });

  it('reclaims no quarantined instance, even when its lease record is still there too', () => {
    // The dirty return writes the quarantine record and *then* removes the lease record, so a crash between
    // those two lines leaves both present. A pass that enumerated `leases/` alone then destroyed the very
    // container a person was being asked to look at — contradicting `deferred[4]`, whose whole purpose is
    // preserving the evidence the `escalate-to-human` disposition is about.
    const { home } = world('quarantine');
    const record = writeLeaseRecord(home, 'lease-dirty', TERMINAL_RUN);
    mkdirSync(quarantineDir(home), { recursive: true });
    writeFileSync(
      join(quarantineDir(home), 'lease-dirty.json'),
      JSON.stringify({ ...record, residue: ['the key orders survived the wipe'] }),
      'utf8',
    );

    expect(enumerateLiveResources({ orchHome: home })).toStrictEqual([]);

    const destroyed: string[] = [];
    const summary = runReclamationPass({
      orchHome: home,
      pool: {
        orchHome: home,
        acquire: () => {
          throw new Error('the sweep never acquires');
        },
        release: () => {
          throw new Error('the sweep never releases');
        },
        leases: () => [],
        warm: () => [],
        quarantined: () => [],
        idle: () => [],
        unrecorded: () => ({ ok: true, containerNames: [], detail: 'no runtime in this fixture' }),
        reclaimIdle: () => ({ reclaimed: false, reason: 'unused' }),
        reclaim: (candidate: LeaseRecord) => {
          destroyed.push(candidate.container_name);
          return { reclaimed: true, reason: 'destroyed in this fixture' };
        },
      },
    });

    expect(destroyed).toStrictEqual([]);
    expect(summary.reclaimed).toStrictEqual([]);
    // Both records stand: the evidence a person was escalated to is intact.
    expect(existsSync(join(quarantineDir(home), 'lease-dirty.json'))).toBe(true);
    expect(existsSync(join(leasesDir(home), 'lease-dirty.json'))).toBe(true);
  });

  it('excludes a quarantined instance by container name as well as by lease id', () => {
    // A second lease of the same container is the other half of the same hazard: the ids differ, the
    // container does not, and destroying it destroys the same evidence.
    const { home } = world('quarantine-by-name');
    const record = writeLeaseRecord(home, 'lease-other-id', TERMINAL_RUN);
    mkdirSync(quarantineDir(home), { recursive: true });
    writeFileSync(
      join(quarantineDir(home), 'lease-original.json'),
      JSON.stringify({ ...record, lease: 'lease-original', residue: ['3 key(s) survived the wipe'] }),
      'utf8',
    );
    expect(enumerateLiveResources({ orchHome: home })).toStrictEqual([]);
  });

  it('reclaims a warm instance whose idle TTL has run out, and keeps one inside it', () => {
    // `pool/warm/` records belong to no run and `decideReclamation` needs a run, so before this a returned
    // instance ran for ever across restarts — holding a port and its memory limit, and handed to the next
    // run with no liveness or emptiness re-check.
    const { home } = world('warm-ttl');
    mkdirSync(warmDir(home), { recursive: true });
    const warmRecord = (name: string, returnedAt: string): void => {
      writeFileSync(
        join(warmDir(home), `${name}.json`),
        JSON.stringify({
          schema_version: CURRENT_SCHEMA_VERSION,
          kind: 'redis',
          container_name: name,
          host_port: 55_410,
          image: 'redis:7.4-alpine',
          returned_at: returnedAt,
        }),
        'utf8',
      );
    };
    const at = new Date('2026-09-21T12:00:00.000Z');
    warmRecord('orch-pool-redis-stale', new Date(at.getTime() - WARM_IDLE_TTL_MS - 1).toISOString());
    warmRecord('orch-pool-redis-fresh', new Date(at.getTime() - 1_000).toISOString());

    const destroyed: string[] = [];
    const summary = runReclamationPass({
      orchHome: home,
      now: () => at,
      pool: {
        orchHome: home,
        acquire: () => {
          throw new Error('the sweep never acquires');
        },
        release: () => {
          throw new Error('the sweep never releases');
        },
        leases: () => [],
        warm: () => [],
        quarantined: () => [],
        idle: () => [],
        unrecorded: () => ({ ok: true, containerNames: [], detail: 'no runtime in this fixture' }),
        reclaim: () => ({ reclaimed: false, reason: 'no lease record in this fixture' }),
        reclaimIdle: (entry) => {
          destroyed.push(entry.record.container_name);
          rmSync(entry.path, { force: true });
          return { reclaimed: true, reason: 'destroyed in this fixture' };
        },
      },
    });

    expect(destroyed).toStrictEqual(['orch-pool-redis-stale']);
    expect(summary.reclaimed.map((entry) => `${entry.kind}:${entry.id}`)).toStrictEqual([
      'warm:orch-pool-redis-stale',
    ]);
    expect(summary.retained.map((entry) => entry.id)).toStrictEqual(['orch-pool-redis-fresh']);
    expect(existsSync(join(warmDir(home), 'orch-pool-redis-fresh.json'))).toBe(true);
    expect(existsSync(join(warmDir(home), 'orch-pool-redis-stale.json'))).toBe(false);
  });

  it('reports an expired warm instance it has no pool to act through, rather than forgetting it', () => {
    const { home } = world('warm-no-pool');
    mkdirSync(warmDir(home), { recursive: true });
    writeFileSync(
      join(warmDir(home), 'orch-pool-redis-orphan.json'),
      JSON.stringify({
        schema_version: CURRENT_SCHEMA_VERSION,
        kind: 'redis',
        container_name: 'orch-pool-redis-orphan',
        host_port: 55_411,
        image: 'redis:7.4-alpine',
        returned_at: '2020-01-01T00:00:00.000Z',
      }),
      'utf8',
    );
    const summary = runReclamationPass({ orchHome: home });
    expect(summary.reclaimed).toStrictEqual([]);
    expect(summary.failed).toHaveLength(1);
    expect(summary.failed[0]?.kind).toBe('warm');
    expect(summary.failed[0]?.reason).toContain('no lease pool is configured');
    expect(existsSync(join(warmDir(home), 'orch-pool-redis-orphan.json'))).toBe(true);
  });

  it('names a pooled container no record accounts for, in the summary the loop surfaces', () => {
    const { home } = world('unrecorded-pass');
    const summary = runReclamationPass({
      orchHome: home,
      pool: {
        orchHome: home,
        acquire: () => {
          throw new Error('the sweep never acquires');
        },
        release: () => {
          throw new Error('the sweep never releases');
        },
        leases: () => [],
        warm: () => [],
        quarantined: () => [],
        idle: () => [],
        reclaim: () => ({ reclaimed: false, reason: 'unused' }),
        reclaimIdle: () => ({ reclaimed: false, reason: 'unused' }),
        unrecorded: () => ({
          ok: true,
          containerNames: ['orch-pool-redis-lost-record'],
          detail: '1 of 1 pooled container(s) are named by no record of this pool',
        }),
      },
    });
    expect(summary.reclaimed).toStrictEqual([]);
    expect(summary.failed).toHaveLength(1);
    expect(summary.failed[0]?.id).toBe('orch-pool-redis-lost-record');
    expect(summary.failed[0]?.reason).toContain('named by no lease, warm, claim or quarantine record');
    // Reported rather than destroyed, and the reason is in the reason.
    expect(summary.failed[0]?.reason).toContain('ORCH_HOME');
  });

  it('surfaces a record it had to skip, so the resource it named is not silently invisible', () => {
    const { home } = world('skip-surfaced');
    mkdirSync(leasesDir(home), { recursive: true });
    writeFileSync(join(leasesDir(home), 'half-written.json'), '{"schema_version": 1, "lea', 'utf8');

    const summary = runReclamationPass({ orchHome: home });
    // Skipping keeps the pass alive; reporting is what keeps the skip from being a hole.
    expect(summary.reclaimed).toStrictEqual([]);
    expect(summary.failed).toHaveLength(1);
    expect(summary.failed[0]?.id).toBe('half-written.json');
    expect(summary.failed[0]?.reason).toContain('skipped');
  });

  it('reports one resource’s failure against that resource and acts on the rest', () => {
    const decisions: readonly ReclaimDecision[] = [
      {
        resource: resource('lease', TERMINAL_RUN),
        reclaim: true,
        reason: 'terminal',
        runState: view(true, 'committed'),
      },
      {
        resource: { ...resource('lease', ORPHAN_RUN), lease: writeableRecord() },
        reclaim: true,
        reason: 'orphan',
        runState: view(false, null),
      },
    ];
    const summary = performReclamation(decisions, {
      removeWorktree: () => {
        throw new Error('unused');
      },
      releaseLease: () => ({ reclaimed: true, reason: 'destroyed' }),
    });
    // The first decision carries no record to act on, which is its own failure and not the second's.
    expect(summary.failed).toHaveLength(1);
    expect(summary.reclaimed).toHaveLength(1);
  });
});

/** A minimal record for the decision above, without touching disk. */
function writeableRecord(): LeaseRecord {
  return {
    schema_version: CURRENT_SCHEMA_VERSION,
    lease: 'lease-inline',
    run: ORPHAN_RUN,
    kind: 'redis',
    container_name: 'orch-pool-redis-lease-inline',
    host_port: 55_401,
    image: 'redis:7.4-alpine',
    acquired_at: '2026-09-20T00:00:00.000Z',
  };
}

describe('a kill leaves everything reclaimable on the next pass', () => {
  it('reclaims resources no process was left alive to release, and is idempotent after', () => {
    // The kill is modelled by never running a releasing process at all: the resources are on disk, the
    // runs are terminal or gone, and the pass below is built fresh with nothing in memory. No exit path,
    // no handler and no `finally` was available to any of it.
    const { home, repo } = world('killed');
    writeRunState(home, TERMINAL_RUN, 'committed');
    createWorktree({ run: TERMINAL_RUN, repository: repo.dir, orchHome: home });
    createWorktree({ run: ORPHAN_RUN, repository: repo.dir, orchHome: home });

    const released: string[] = [];
    const first = runReclamationPass({
      orchHome: home,
      pool: {
        orchHome: home,
        acquire: () => {
          throw new Error('the sweep never acquires');
        },
        release: () => {
          throw new Error('the sweep never releases a held lease');
        },
        leases: () => [],
        warm: () => [],
        quarantined: () => [],
        // FIXTURE EXTENDED: `LeasePool` gained `idle` and `reclaimIdle` so that a warm instance — which
        // belongs to no run, and was therefore reclaimable by nothing at all — is answerable to a pass.
        // The intent of this case is unchanged: it still models a kill by putting resources on disk and
        // building a pass with nothing in memory.
        idle: () => [],
        unrecorded: () => ({ ok: true, containerNames: [], detail: 'no runtime in this fixture' }),
        reclaimIdle: () => {
          throw new Error('this fixture holds no idle instance');
        },
        reclaim: (record: LeaseRecord) => {
          released.push(record.lease);
          rmSync(join(leasesDir(home), `${record.lease}.json`), { force: true });
          return { reclaimed: true, reason: 'destroyed in this fixture' };
        },
      },
    });

    expect(first.reclaimed.map((entry) => entry.id).sort()).toStrictEqual([ORPHAN_RUN, TERMINAL_RUN].sort());
    expect(first.failed).toStrictEqual([]);
    expect(listWorktreeRuns(home)).toStrictEqual([]);

    // The second pass has nothing left to do, and says so rather than failing.
    const second = runReclamationPass({ orchHome: home });
    expect(second.reclaimed).toStrictEqual([]);
    expect(second.retained).toStrictEqual([]);
    expect(second.failed).toStrictEqual([]);
  });

  it('reclaims a lease record a killed engine left behind, on a pass that never acquired it', () => {
    const { home } = world('killed-lease');
    const stranded = writeLeaseRecord(home, 'lease-stranded', ORPHAN_RUN);

    const destroyed: string[] = [];
    const decisions = decideReclamation(
      enumerateLiveResources({ orchHome: home }),
      fileRunStateReader(home),
    );
    expect(decisions).toHaveLength(1);
    expect(decisions[0]?.reclaim).toBe(true);

    performReclamation(decisions, {
      removeWorktree: () => {
        throw new Error('no worktree in this fixture');
      },
      releaseLease: (record: LeaseRecord) => {
        destroyed.push(record.container_name);
        rmSync(join(leasesDir(home), `${record.lease}.json`), { force: true });
        return { reclaimed: true, reason: 'destroyed' };
      },
    });
    expect(destroyed).toStrictEqual([stranded.container_name]);
  });
});

describe('nothing is reclaimed by a process exiting', () => {
  const poolDirectory = fileURLToPath(new URL('../src/pool/', import.meta.url));
  const files = readdirSync(poolDirectory).filter((name) => name.endsWith('.ts'));

  it('has the files the Code Map names', () => {
    expect(files.sort()).toStrictEqual(['index.ts', 'lease.ts', 'reclaim.ts', 'worktree.ts']);
  });

  it.each(files)('%s registers no exit, signal or cleanup path', (file) => {
    const source = readFileSync(join(poolDirectory, file), 'utf8');
    // The three things AD-32 names. A crash skips all of them, which is why the pass exists.
    expect(source, file).not.toMatch(/process\.on\s*\(/);
    expect(source, file).not.toMatch(/process\.once\s*\(/);
    expect(source, file).not.toMatch(/SIGINT|SIGTERM|SIGHUP|beforeExit|'exit'/);
    expect(source, file).not.toMatch(/\}\s*finally\s*\{/);
    expect(source, file).not.toMatch(/onExit|atexit|shutdownHandler/);
  });

  it.each(files)('%s imports only contracts, runtime, container and node builtins', (file) => {
    const source = readFileSync(join(poolDirectory, file), 'utf8');
    const specifiers = [...source.matchAll(/^(?:import|export)\b[^;]*?from '([^']+)';/gms)].map(
      (match) => match[1] ?? '',
    );
    expect(specifiers.length, `${file} has imports the guard can see`).toBeGreaterThan(0);
    for (const specifier of specifiers) {
      const legal =
        specifier.startsWith('node:') ||
        specifier.startsWith('./') ||
        specifier.startsWith('../contracts/') ||
        specifier.startsWith('../runtime/') ||
        specifier.startsWith('../container/');
      expect(legal, `${file} imports ${specifier}`).toBe(true);
    }
    expect(source, file).not.toContain('../engine/');
  });

  it.each(files)('%s names no container runtime', (file) => {
    // AD-20: one place names it, and this is not that place. Comments included — a prose mention is how
    // a flag gets composed here "just for now".
    const source = readFileSync(join(poolDirectory, file), 'utf8').toLowerCase();
    for (const forbidden of ['docker', 'podman', 'containerd']) {
      expect(source.includes(forbidden), `${file} names ${forbidden}`).toBe(false);
    }
  });

  it('composes no container flag anywhere in src/pool/', () => {
    // The flag vocabulary is imported from the package that owns it rather than re-listed here, so a
    // flag added to the containment set is a flag this guard starts checking for on its own. `git`'s own
    // flags are not container flags and are deliberately not caught: `worktree remove` takes one.
    const containerFlags = [
      ...AD20_REQUIRED_FLAGS,
      ...SERVICE_REQUIRED_FLAGS,
      '--privileged',
      '--rm',
      '--label',
      '--env',
      '--mount',
      '--network',
    ];
    for (const file of files) {
      const source = readFileSync(join(poolDirectory, file), 'utf8');
      for (const flag of containerFlags) {
        expect(source.includes(`'${flag}'`), `${file} composes ${flag}`).toBe(false);
      }
    }
  });
});

describe('the reconciler drives the pass', () => {
  const refusingExecutor: StepExecutor = {
    start: () => Promise.reject(new Error('no step runs in this fixture')),
    resume: () => Promise.reject(new Error('no step resumes in this fixture')),
  };

  it('invokes reclamation on every pass and reports what it did', async () => {
    const { home } = world('engine');
    let calls = 0;
    const reconciler = Reconciler.open({
      orchHome: home,
      executor: refusingExecutor,
      plans: planProvider(makePlan()),
      reclamation: () => {
        calls += 1;
        return {
          reclaimed: [{ kind: 'worktree', id: TERMINAL_RUN, run: TERMINAL_RUN, reason: 'terminal' }],
          retained: [],
          failed: [],
        };
      },
    });
    try {
      const first = await reconciler.pass();
      expect(calls).toBe(1);
      expect(first.reclaimed?.reclaimed).toHaveLength(1);
      expect(first.refusals).toStrictEqual([]);

      // Every pass, not only the first: a reclamation that happened once is one a crash can outlive.
      await reconciler.pass();
      expect(calls).toBe(2);
    } finally {
      reconciler.close();
    }
  });

  it('reports null when no reclamation pass is wired in, rather than claiming success', async () => {
    const { home } = world('engine-none');
    const reconciler = Reconciler.open({
      orchHome: home,
      executor: refusingExecutor,
      plans: planProvider(makePlan()),
    });
    try {
      expect((await reconciler.pass()).reclaimed).toBe(null);
    } finally {
      reconciler.close();
    }
  });

  it('crosses a durable boundary for each resource reclaimed, so a crash suite can kill there', async () => {
    const { home } = world('engine-boundary');
    const boundaries: string[] = [];
    const reconciler = Reconciler.open({
      orchHome: home,
      executor: refusingExecutor,
      plans: planProvider(makePlan()),
      onDurableBoundary: (label: string) => boundaries.push(label),
      reclamation: () => ({
        reclaimed: [
          { kind: 'worktree', id: TERMINAL_RUN, run: TERMINAL_RUN, reason: 'terminal' },
          { kind: 'lease', id: 'lease-x', run: TERMINAL_RUN, reason: 'terminal' },
        ],
        retained: [],
        failed: [],
      }),
    });
    try {
      await reconciler.pass();
      expect(boundaries).toStrictEqual(['resource-reclaimed:worktree', 'resource-reclaimed:lease']);
    } finally {
      reconciler.close();
    }
  });

  it('surfaces a resource the sweep could not release, rather than reporting it into nothing', async () => {
    // `summary.failed` was reported into `PassResult` and read by nothing, so a resource failing reclamation
    // on every pass leaked with no signal at all — through the pass that exists to prevent exactly that.
    const { home } = world('engine-failed');
    const reconciler = Reconciler.open({
      orchHome: home,
      executor: refusingExecutor,
      plans: planProvider(makePlan()),
      reclamation: () => ({
        reclaimed: [],
        retained: [],
        failed: [
          {
            kind: 'lease',
            id: 'lease-stuck',
            run: TERMINAL_RUN,
            reason: 'the instance would not stop',
            code: 'resource.lease_timed_out',
          },
        ],
      }),
    });
    try {
      const result = await reconciler.pass();
      expect(result.reclaimed?.failed).toHaveLength(1);
      expect(result.refusals).toHaveLength(1);
      expect(result.refusals[0]?.code).toBe('resource.lease_timed_out');
      expect(result.refusals[0]?.reason).toContain('lease-stuck');
      // Pass-scoped, with an empty run: the field holds run ids, and `(reclamation)` read like one.
      expect(result.refusals[0]?.scope).toBe('pass');
      expect(result.refusals[0]?.run).toBe('');
      // Every feature in the pass still advanced, which is the per-artifact rule this channel already holds.
      expect(result.actions).toStrictEqual([]);
    } finally {
      reconciler.close();
    }
  });

  it('names no run id for a pass-wide refusal, so nothing can build a path from one', async () => {
    const { home } = world('engine-refusal-run');
    const reconciler = Reconciler.open({
      orchHome: home,
      executor: refusingExecutor,
      plans: planProvider(makePlan()),
      reclamation: () => {
        throw new Error('the sweep could not read a record');
      },
    });
    try {
      const result = await reconciler.pass();
      expect(result.refusals).toHaveLength(1);
      expect(result.refusals[0]?.run).toBe('');
      expect(result.refusals[0]?.scope).toBe('pass');
      // The literal that used to stand here would have been refused by the path guard, but only after
      // reading as though it were a real id.
      expect(result.refusals[0]?.run).not.toContain('reclamation');
      expect(() => assertSafePathSegment(result.refusals[0]?.run ?? '', 'a run id')).toThrow(
        UnsafePathSegmentError,
      );
    } finally {
      reconciler.close();
    }
  });

  it('reports a sweep that threw as a refusal, and still completes the pass', async () => {
    const { home } = world('engine-throws');
    const reconciler = Reconciler.open({
      orchHome: home,
      executor: refusingExecutor,
      plans: planProvider(makePlan()),
      reclamation: () => {
        throw Object.assign(new Error('the sweep could not read a record'), {
          code: 'config.schema_version_unrecognised',
        });
      },
    });
    try {
      const result = await reconciler.pass();
      expect(result.reclaimed).toBe(null);
      expect(result.refusals).toHaveLength(1);
      expect(result.refusals[0]?.code).toBe('config.schema_version_unrecognised');
      expect(result.actions).toStrictEqual([]);
    } finally {
      reconciler.close();
    }
  });

  it('is wired through one function the engine takes as an option', () => {
    const { home } = world('engine-wiring');
    const port = reconcilerReclamation({ orchHome: home });
    const summary = port();
    expect(summary.reclaimed).toStrictEqual([]);
    expect(summary.retained).toStrictEqual([]);
    expect(summary.failed).toStrictEqual([]);
  });

  it('reclaims a terminal run’s worktree when the loop drives the real pass', async () => {
    const { home, repo } = world('engine-real');
    writeRunState(home, TERMINAL_RUN, 'committed');
    const worktree = createWorktree({ run: TERMINAL_RUN, repository: repo.dir, orchHome: home });

    const reconciler = Reconciler.open({
      orchHome: home,
      executor: refusingExecutor,
      plans: planProvider(makePlan({ feature: 'engine-reconciler' })),
      reclamation: reconcilerReclamation({ orchHome: home }),
    });
    try {
      const result = await reconciler.pass();
      expect(result.reclaimed?.reclaimed.map((entry) => entry.id)).toStrictEqual([TERMINAL_RUN]);
    } finally {
      reconciler.close();
    }
    expect(existsSync(worktree.path)).toBe(false);
    // The evidence outlives the worktree, including for the run the pass just reclaimed.
    expect(existsSync(runPaths(TERMINAL_RUN, home).runDir)).toBe(true);
  });
});

/**
 * The seam, asserted by the compiler rather than by a runtime hope.
 *
 * `ReclamationSummary` and `ReclaimedResource` are declared twice on purpose — the engine may not import
 * `src/pool/`, so the port is satisfied structurally — and nothing asserted that the two declarations still
 * described the same thing. Two hand-kept copies of a shape drift, and the first symptom would be a field
 * one side writes and the other silently drops. These four lines fail the *build* instead.
 *
 * Assignability is asserted one way only where the types differ deliberately: the engine's `kind` is an open
 * `string` because the unit that owns resources declares what kinds exist, so the pool's narrower
 * `ResourceKind` flows into it and not back.
 */
type Assignable<Narrow extends Wide, Wide> = readonly [Narrow, Wide];
type SameKeys<Left, Right> = [keyof Left] extends [keyof Right]
  ? [keyof Right] extends [keyof Left]
    ? true
    : never
  : never;

const poolSummaryFitsTheEnginePort: Assignable<PoolReclamationSummary, EngineReclamationSummary> | null =
  null;
const poolResourceFitsTheEnginePort: Assignable<PoolReclaimedResource, EngineReclaimedResource> | null =
  null;
const summaryKeysAgree: SameKeys<PoolReclamationSummary, EngineReclamationSummary> = true;
const resourceKeysAgree: SameKeys<PoolReclaimedResource, EngineReclaimedResource> = true;

describe('the engine seam and the pool agree on one shape', () => {
  it('is asserted at compile time, so drift fails the build rather than a pass', () => {
    expect(poolSummaryFitsTheEnginePort).toBe(null);
    expect(poolResourceFitsTheEnginePort).toBe(null);
    expect(summaryKeysAgree).toBe(true);
    expect(resourceKeysAgree).toBe(true);
  });

  it('carries the same fields at runtime, for the reader the compiler cannot reach', () => {
    const fromThePool: PoolReclaimedResource = {
      kind: 'lease',
      id: 'lease-x',
      run: TERMINAL_RUN,
      reason: 'terminal',
      code: 'resource.lease_timed_out',
    };
    const asTheEngineSeesIt: EngineReclaimedResource = fromThePool;
    expect(Object.keys(asTheEngineSeesIt).sort()).toStrictEqual([
      'code',
      'id',
      'kind',
      'reason',
      'run',
    ]);
  });
});

describe('no runtime reachable', () => {
  it('still exercises the whole worktree half of the pass', () => {
    // The last row of the I/O matrix: with no container runtime, worktree operations work and the pass
    // reaches its decision for every resource. Nothing above this line touched a runtime.
    const { home, repo } = world('no-runtime');
    writeRunState(home, TERMINAL_RUN, 'committed');
    createWorktree({ run: TERMINAL_RUN, repository: repo.dir, orchHome: home });
    const summary = runReclamationPass({ orchHome: home });
    expect(summary.reclaimed).toHaveLength(1);
    expect(worktreeDir(TERMINAL_RUN, home).startsWith(home)).toBe(true);
  });
});
