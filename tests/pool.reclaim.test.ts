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
import { runPaths, worktreeDir } from '../src/runtime/index.js';
import { Reconciler } from '../src/engine/index.js';
import type { StepExecutor } from '../src/engine/index.js';
import {
  createWorktree,
  decideReclamation,
  enumerateLiveResources,
  fileRunStateReader,
  leasesDir,
  listWorktreeRuns,
  performReclamation,
  reconcilerReclamation,
  runReclamationPass,
} from '../src/pool/index.js';
import type { LeaseRecord, LiveResource, ReclaimDecision, RunStateView } from '../src/pool/index.js';

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
