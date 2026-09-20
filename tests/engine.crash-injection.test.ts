/**
 * AD-31's second required suite: kill the reconciler at **every** state transition and assert AD-7's
 * resume-identical behaviour.
 *
 * The property is *restart-identical*, not "handles SIGKILL". A suite that killed at one convenient
 * point, or that asserted only "no crash", would not test AD-7 at all — which is why the shape here is:
 *
 *   1. run the loop to completion once and record what an uninterrupted run produces — the lifecycle
 *      state, the step dispositions, the worktree, the commit count, and the full list of durable
 *      boundaries the loop crossed;
 *   2. for each of those boundaries in turn, run a fresh copy of the same run in a child process that
 *      `SIGKILL`s itself at exactly that boundary;
 *   3. restart a *new* engine process over the same `ORCH_HOME` and let it settle;
 *   4. assert it converged on the recorded state, with no action performed twice and none skipped.
 *
 * Three things make step 4 mean something rather than merely pass:
 *
 * - The number of boundaries is *discovered* in step 1, not written down here, so a loop that grows a
 *   transition is killed at the new one automatically instead of silently skipping it.
 * - The comparison is the lifecycle fingerprint — the feature state and every step's disposition in
 *   order — never a byte image of the checkpoint. An interrupted run legitimately records one more
 *   attempt and one more reset, so demanding equality there would fail for the wrong reason and the
 *   assertion would end up weakened to something that proves nothing.
 * - "No action performed twice" is asserted against the *worktree*: the fixture's steps append to a
 *   ledger and commit, so a re-run that skipped its AD-26 baseline reset shows up as a duplicated
 *   ledger line or an extra commit. Counters in the checkpoint could not tell the difference.
 *
 * The kills are real: a child process, `SIGKILL`, no flush, no handler, no cleanup. The restart is a
 * separate process too, so it has to reclaim both the AD-30 engine lock and the recorder's own claim
 * from a pid that is gone — which is the AD-32 rule that reclamation is a reconcile action rather than
 * something a clean exit path was relied on for.
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { RUN_STATE_FILE_NAME, featureStateFingerprint } from '../src/contracts/index.js';
import type { RunState } from '../src/contracts/index.js';
import { readEventLog, runPaths, runsDir } from '../src/runtime/index.js';
import { ENGINE_LOCK_FILE_NAME } from '../src/engine/index.js';

import {
  EFFECTS_LEDGER,
  fixtureCommitCount,
  makeGitWorktree,
  makeHome,
} from './helpers/engine-fixture.js';
import type { GitWorktree } from './helpers/engine-fixture.js';

/**
 * Each child spawn compiles the engine tree through `jiti`. A single run is well under a second, but the
 * bound has to cover every iteration's two spawns on a loaded machine. It exists so a loop that fails to
 * converge fails the suite rather than hanging it.
 */
const SUITE_TIMEOUT_MS = 20 * 60 * 1000;
const CHILD_TIMEOUT_MS = 120_000;

interface ChildReport {
  readonly run: string;
  readonly fingerprint: string;
  readonly boundaries: readonly string[];
}

interface ChildOutcome {
  readonly report: ChildReport | null;
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stderr: string;
}

const HARNESS = fileURLToPath(new URL('helpers/reconcile-until-killed.ts', import.meta.url));
const JITI = fileURLToPath(new URL('../node_modules/jiti/lib/jiti-register.mjs', import.meta.url));

/** The harness's report, or a failure naming what the child said instead of reporting one. */
const requireReport = (outcome: ChildOutcome): ChildReport => {
  if (outcome.report === null) {
    throw new Error(
      `the harness produced no report (code ${String(outcome.code)}, ` +
        `signal ${String(outcome.signal)}): ${outcome.stderr}`,
    );
  }
  return outcome.report;
};

const disposables: string[] = [];

/** Run the harness once. `killAfter` of 0 never kills; otherwise it dies at that durable boundary. */
const runHarness = async (
  home: string,
  worktree: string,
  killAfter: number,
): Promise<ChildOutcome> => {
  const child = spawn(
    process.execPath,
    ['--import', JITI, HARNESS, home, worktree, String(killAfter)],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );

  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', (chunk: Buffer) => {
    stdout += chunk.toString('utf8');
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf8');
  });

  const settled = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error(`the harness did not finish within ${String(CHILD_TIMEOUT_MS)}ms`));
      }, CHILD_TIMEOUT_MS);
      child.once('exit', (code, signal) => {
        clearTimeout(timer);
        resolve({ code, signal });
      });
      child.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
    },
  );

  const line = stdout.trim();
  return {
    report: line === '' ? null : (JSON.parse(line) as ChildReport),
    code: settled.code,
    signal: settled.signal,
    stderr,
  };
};

/** Everything an uninterrupted run leaves behind that an interrupted one has to match. */
interface Observed {
  readonly fingerprint: string;
  readonly run: string;
  readonly ledger: string;
  readonly listing: readonly string[];
  readonly commits: number;
  readonly dispositions: readonly string[];
  readonly runDirectories: readonly string[];
}

const observe = (home: string, worktree: GitWorktree, run: string): Observed => {
  const state = JSON.parse(
    readFileSync(join(runPaths(run, home).runDir, RUN_STATE_FILE_NAME), 'utf8'),
  ) as RunState;
  return {
    // The exported function, not a copy of its output format. Every convergence assertion in this suite
    // rests on this comparison, and `Reconciler.fingerprint` uses the same function — two spellings that
    // drifted apart would leave the suite silently comparing the wrong property.
    fingerprint: featureStateFingerprint(state),
    run: state.run,
    ledger: worktree.read(EFFECTS_LEDGER) ?? '',
    listing: worktree.listing(),
    commits: fixtureCommitCount(worktree.dir),
    dispositions: state.steps.map((step) => `${step.step}:${String(step.disposition)}`),
    runDirectories: readdirSync(runsDir(home)).sort(),
  };
};

/** A fresh `ORCH_HOME` and a fresh single-commit worktree for one iteration. */
const freshWorld = (label: string): { readonly home: string; readonly worktree: GitWorktree } => {
  const home = makeHome(`crash-${label}`);
  const worktree = makeGitWorktree(`crash-${label}`);
  disposables.push(home, worktree.dir);
  return { home, worktree };
};

/** The uninterrupted run, established once and compared against by every iteration. */
let baseline: Observed;
let boundaries: readonly string[];

beforeAll(async () => {
  const world = freshWorld('baseline');
  const outcome = await runHarness(world.home, world.worktree.dir, 0);

  expect(outcome.signal, `the uninterrupted run was signalled: ${outcome.stderr}`).toBeNull();
  expect(outcome.code, outcome.stderr).toBe(0);
  expect(outcome.report).not.toBeNull();

  const report = requireReport(outcome);
  boundaries = report.boundaries;
  baseline = observe(world.home, world.worktree, report.run);

  // The recorded state is only worth comparing against if it is the finished run. Asserted here rather
  // than trusted, because every other assertion in this file is relative to it.
  expect(baseline.fingerprint).toBe('committed|implement:completed|verify:completed');
  expect(report.fingerprint).toBe(baseline.fingerprint);
}, CHILD_TIMEOUT_MS);

afterAll(() => {
  for (const dir of disposables.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('AD-31 — the uninterrupted run is the thing to converge on', () => {
  it('crosses a durable boundary at every transition the loop makes', () => {
    // Discovered, not asserted as a count: the suite kills at whatever transitions the loop has.
    expect(boundaries.length).toBeGreaterThan(10);

    // Every kind of transition the loop can make is represented, so the sweep below is not killing
    // twenty variations of one moment.
    const kinds = new Set(boundaries);
    for (const expected of [
      'event-appended:run.created',
      'event-appended:feature.state_changed',
      'event-appended:step.started',
      'event-appended:step.session_recorded',
      'event-appended:step.terminated',
      'event-appended:step.baseline_reset',
      'checkpoint-written:drafting',
      'checkpoint-written:confirmed',
      'checkpoint-written:running',
      'checkpoint-written:verifying',
      'checkpoint-written:committed',
    ]) {
      expect([...kinds], `no boundary of kind ${expected}`).toContain(expected);
    }

    // Both crash windows are covered: between a line landing in the log and the checkpoint catching up,
    // and between a checkpoint and the next action.
    expect(boundaries.filter((label) => label.startsWith('event-appended:')).length).toBeGreaterThan(0);
    expect(boundaries.filter((label) => label.startsWith('checkpoint-written:')).length).toBeGreaterThan(0);
  });

  it('leaves each step’s effects applied exactly once', () => {
    // `implement` ran twice in the uninterrupted run — attempt one fails, and the AD-26 reset precedes
    // the re-run — so one ledger line for it is already evidence the reset works on the happy path.
    expect(baseline.ledger).toBe('implement\nverify\n');
    expect(baseline.listing).toStrictEqual([
      '.gitignore',
      EFFECTS_LEDGER,
      'src/existing.ts',
      'src/implement.ts',
      'src/verify.ts',
    ]);
    expect(baseline.runDirectories).toHaveLength(1);
  });
});

describe('AD-7 — killed at each transition in turn, the restart converges on the same state', () => {
  it(
    'converges from a kill at every durable boundary, with no action doubled and none skipped',
    async () => {
      const failures: string[] = [];

      for (let index = 0; index < boundaries.length; index += 1) {
        const killAfter = index + 1;
        const label = boundaries[index] ?? '(unknown)';
        const world = freshWorld(String(killAfter));

        // 1. Kill the loop at exactly this transition. No flush, no handler, no cleanup.
        const killed = await runHarness(world.home, world.worktree.dir, killAfter);
        if (killed.signal !== 'SIGKILL') {
          failures.push(
            `boundary ${String(killAfter)} (${label}): the harness was not killed ` +
              `(signal ${String(killed.signal)}, code ${String(killed.code)})${killed.stderr}`,
          );
          continue;
        }

        // The killed engine left its claims behind, naming a pid that is now gone. A restart has to
        // reclaim them, which is AD-32's rule that reclamation is a reconcile action.
        const leftLock = existsSync(join(world.home, ENGINE_LOCK_FILE_NAME));

        // 2. Restart: a brand-new engine process over the same ORCH_HOME.
        const restarted = await runHarness(world.home, world.worktree.dir, 0);
        if (restarted.report === null) {
          failures.push(
            `boundary ${String(killAfter)} (${label}): the restart produced no report. ` +
              `code ${String(restarted.code)}, signal ${String(restarted.signal)}: ${restarted.stderr}`,
          );
          continue;
        }

        // 3. Compare against the uninterrupted run.
        const after = observe(world.home, world.worktree, restarted.report.run);
        const problems: string[] = [];

        if (!leftLock) problems.push('the killed engine left no lock to reclaim');
        if (restarted.code !== 0) problems.push(`the restart exited ${String(restarted.code)}`);

        // Converges on the same state: the feature state and every step's disposition, in order.
        if (after.fingerprint !== baseline.fingerprint) {
          problems.push(`fingerprint ${after.fingerprint} != ${baseline.fingerprint}`);
        }
        // No action skipped: every declared step reached `completed` and the run is terminal.
        if (after.dispositions.join(',') !== baseline.dispositions.join(',')) {
          problems.push(`dispositions ${after.dispositions.join(',')} != ${baseline.dispositions.join(',')}`);
        }
        // No action performed twice: the worktree an interrupted run leaves is the worktree an
        // uninterrupted one leaves, down to the ledger and the commit count.
        if (after.ledger !== baseline.ledger) {
          problems.push(`ledger ${JSON.stringify(after.ledger)} != ${JSON.stringify(baseline.ledger)}`);
        }
        if (after.listing.join(',') !== baseline.listing.join(',')) {
          problems.push(`worktree ${after.listing.join(',')} != ${baseline.listing.join(',')}`);
        }
        if (after.commits !== baseline.commits) {
          problems.push(`${String(after.commits)} commits != ${String(baseline.commits)}`);
        }
        // The restart adopted the existing run rather than minting a second one.
        if (after.run !== baseline.run) problems.push(`run ${after.run} != ${baseline.run}`);
        if (after.runDirectories.length !== 1) {
          problems.push(`${String(after.runDirectories.length)} run directories, expected 1`);
        }

        // The log is intact: one assigner, 1..n, no gaps and no repeats, even across the kill.
        const log = readEventLog(runPaths(after.run, world.home).eventLog);
        for (const [position, event] of log.entries()) {
          if (event.seq !== position + 1) {
            problems.push(`log line ${String(position + 1)} carries seq ${String(event.seq)}`);
            break;
          }
        }
        // A restart that had to recover did strictly more than the uninterrupted run, never less.
        if (log.length < boundaries.filter((entry) => entry.startsWith('event-appended:')).length) {
          problems.push(`only ${String(log.length)} log lines, fewer than an uninterrupted run`);
        }

        if (problems.length > 0) {
          failures.push(`boundary ${String(killAfter)} (${label}): ${problems.join('; ')}`);
        }
      }

      // Reported together, so one run of the suite names every boundary that does not converge rather
      // than only the first.
      expect(failures, `${String(failures.length)} of ${String(boundaries.length)} boundaries did not converge`).toStrictEqual([]);
    },
    SUITE_TIMEOUT_MS,
  );

  it(
    'converges when the loop is killed twice in one run, at two different transitions',
    async () => {
      // A single kill can be survived by luck — a window that happens to be empty. Two kills in one run,
      // at transitions on either side of the AD-26 reset, exercise a restart that has itself to recover
      // from rather than a clean run that was interrupted once.
      const world = freshWorld('double');
      const firstBoundary = boundaries.findIndex((label) => label === 'event-appended:step.started') + 1;
      const secondBoundary =
        boundaries.findIndex((label) => label === 'event-appended:step.baseline_reset') + 1;
      expect(firstBoundary).toBeGreaterThan(0);
      expect(secondBoundary).toBeGreaterThan(0);

      const first = await runHarness(world.home, world.worktree.dir, firstBoundary);
      expect(first.signal).toBe('SIGKILL');

      const second = await runHarness(world.home, world.worktree.dir, secondBoundary);
      expect(second.signal).toBe('SIGKILL');

      const third = await runHarness(world.home, world.worktree.dir, 0);
      expect(third.code, third.stderr).toBe(0);

      const after = observe(world.home, world.worktree, requireReport(third).run);
      expect(after.fingerprint).toBe(baseline.fingerprint);
      expect(after.ledger).toBe(baseline.ledger);
      expect(after.commits).toBe(baseline.commits);
      expect(after.listing).toStrictEqual(baseline.listing);
      expect(after.run).toBe(baseline.run);
    },
    SUITE_TIMEOUT_MS,
  );

  it(
    'converges from a kill even with the derived checkpoint deleted, because the log is the truth',
    async () => {
      // AD-4 from the crash direction: the checkpoint is derived, so a restart that finds none must
      // reach the same state by folding the log alone.
      const world = freshWorld('no-checkpoint');
      const killAfter = boundaries.findIndex((label) => label === 'checkpoint-written:running') + 1;
      expect(killAfter).toBeGreaterThan(0);

      const killed = await runHarness(world.home, world.worktree.dir, killAfter);
      expect(killed.signal).toBe('SIGKILL');

      const statePath = join(runPaths(baseline.run, world.home).runDir, RUN_STATE_FILE_NAME);
      expect(existsSync(statePath)).toBe(true);
      rmSync(statePath);

      const restarted = await runHarness(world.home, world.worktree.dir, 0);
      expect(restarted.code, restarted.stderr).toBe(0);

      const after = observe(world.home, world.worktree, requireReport(restarted).run);
      expect(after.fingerprint).toBe(baseline.fingerprint);
      expect(after.ledger).toBe(baseline.ledger);
      expect(after.commits).toBe(baseline.commits);
    },
    SUITE_TIMEOUT_MS,
  );
});
