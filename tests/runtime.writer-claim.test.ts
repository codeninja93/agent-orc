/**
 * The two claims that decide who may write, raced from **separate OS processes**.
 *
 * `open(path, 'wx')` is an atomic test-and-set on the *name* and says nothing about the *contents*: it
 * publishes a zero-length file and the claim is written into it afterwards. Both claims were taken that
 * way, so a second process arriving in the window between the create and the write could see a claim that
 * exists and says nothing. Story 1-8 found this on the question outcome, where it was visible; here the
 * consequence was milder and is worth stating precisely rather than dramatically:
 *
 * - **Mutual exclusion was never at risk.** The create is what decides the winner, and it is atomic.
 * - **What was at risk was the refusal.** A claim that reads back as nothing cannot name who holds it, so
 *   the loser is told an `ORCH_HOME` is held by an unreadable lock file instead of by pid 41235.
 * - **And reclamation.** A claim reading as nothing is one no later process will reclaim — the liveness
 *   check has no pid to probe — so an `ORCH_HOME` can be left held by nobody, permanently unstartable.
 *
 * None of that can be tested in one process. Two `Recorder.open` calls in one event loop are ordered by
 * construction, and so is the losing read against the winning write: an in-process test of a
 * cross-process claim asserts the ordering it should be doubting. So these are real children, racing on a
 * barrier, and what they report is what each *loser* could read of the winner's claim at the instant it
 * lost.
 */
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { readEngineLockClaim, engineLockPath } from '../src/engine/index.js';
import { runPaths } from '../src/runtime/index.js';

import { makeHome } from './helpers/engine-fixture.js';

const HELPER = fileURLToPath(new URL('helpers/claim-race.ts', import.meta.url));
const JITI = fileURLToPath(new URL('../node_modules/jiti/lib/jiti-register.mjs', import.meta.url));

/**
 * Every child compiles the runtime and engine trees through `jiti`, which comfortably exceeds Vitest's
 * default while other suites run in parallel. The bound exists so a genuine hang fails rather than runs
 * for ever, not to measure startup.
 */
const RACE_TIMEOUT_MS = 180_000;

/**
 * Six contenders and one watcher, over thirty rounds.
 *
 * Two processes and one round would be won by luck of scheduling often enough to hide the defect
 * entirely. The contenders answer "does exactly one win" — a hundred and fifty claims, a hundred and
 * twenty of them lost — and the watcher answers "was the claim ever present but empty", which is the
 * sharper question: a loser reads from behind its own failed create and can miss a window one `write(2)`
 * wide, while the watcher is already inside a `stat` loop when the file appears.
 */
const CONTENDERS = 6;
const ROUNDS = 30;

interface Observation {
  readonly round: number;
  readonly pid: number;
  readonly won: boolean;
  readonly holderPid: number | null;
  readonly bytesAtLoss: number;
  /** The watcher's only field: the claim's size the first time the file existed. */
  readonly firstSizeSeen?: number;
}

let home: string;
const children: ChildProcess[] = [];
const toRemove: string[] = [];

beforeEach(() => {
  home = makeHome('runtime-writer-claim');
  toRemove.push(home);
});

afterEach(() => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
  for (const dir of toRemove.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface ChildHandle {
  readonly child: ChildProcess;
  readonly exited: Promise<unknown>;
  readonly out: () => { readonly stdout: string; readonly stderr: string };
}

const spawnContender = (
  kind: 'recorder' | 'lock',
  barrier: string,
  role: 'claim' | 'watch' = 'claim',
): ChildHandle => {
  const child = spawn(
    process.execPath,
    ['--import', JITI, HELPER, kind, home, barrier, String(ROUNDS), role],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  children.push(child);
  /**
   * Attached now, before the child can exit.
   *
   * `once(child, 'exit')` called after the child has already exited waits for ever for an event that has
   * been and gone — the bug story 1-3's lock suite introduced and then fixed, and which every spawn helper
   * in this directory has carried the fix for since.
   */
  const exited = once(child, 'exit');
  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', (chunk: Buffer) => {
    stdout += chunk.toString('utf8');
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf8');
  });
  return { child, exited, out: () => ({ stdout, stderr }) };
};

/** Wait until every child has announced readiness for this round, failing loudly if one died first. */
const awaitReady = async (
  handles: readonly ChildHandle[],
  barrier: string,
  round: number,
): Promise<void> => {
  const prefix = `${barrierName(barrier)}.ready.${String(round)}.`;
  const deadline = Date.now() + 120_000;
  for (;;) {
    const ready = readdirSync(home).filter((name) => name.startsWith(prefix)).length;
    if (ready >= handles.length) return;
    for (const [index, handle] of handles.entries()) {
      if (handle.child.exitCode !== null || handle.child.signalCode !== null) {
        throw new Error(
          `contender ${String(index)} exited (code ${String(handle.child.exitCode)}, ` +
            `signal ${String(handle.child.signalCode)}) before round ${String(round)}; ` +
            `stdout: ${JSON.stringify(handle.out().stdout)}; stderr: ${handle.out().stderr}`,
        );
      }
    }
    if (Date.now() > deadline) {
      throw new Error(`not every contender reached the barrier for round ${String(round)} within 120s`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

const barrierName = (barrier: string): string => barrier.slice(barrier.lastIndexOf('/') + 1);

/** Wait until every child has reported all its rounds, failing loudly if one died with less to say. */
const countedLines = async (handles: readonly ChildHandle[]): Promise<void> => {
  const reported = (handle: ChildHandle): number =>
    handle.out().stdout.trim().split('\n').filter((line) => line !== '').length;
  const deadline = Date.now() + 120_000;
  while (!handles.every((handle) => reported(handle) >= ROUNDS)) {
    for (const [index, handle] of handles.entries()) {
      if (handle.child.exitCode !== null || handle.child.signalCode !== null) {
        throw new Error(
          `contender ${String(index)} exited (code ${String(handle.child.exitCode)}) having ` +
            `reported ${String(reported(handle))} of ${String(ROUNDS)} rounds: ${handle.out().stderr}`,
        );
      }
    }
    if (Date.now() > deadline) throw new Error('not every contender reported every round within 120s');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

/** Run one race: spawn the contenders and the watcher, release each round, collect every observation. */
const race = async (
  kind: 'recorder' | 'lock',
): Promise<{ readonly claims: readonly Observation[]; readonly watched: readonly Observation[] }> => {
  const barrier = join(home, 'barrier');
  const handles = Array.from({ length: CONTENDERS }, () => spawnContender(kind, barrier));
  // The watcher waits on the same barrier and takes no claim, so it adds a contender's worth of readiness
  // to wait for and nothing to the race itself.
  const watcher = spawnContender(kind, barrier, 'watch');
  const everyone = [...handles, watcher];

  for (let round = 0; round < ROUNDS; round += 1) {
    await awaitReady(everyone, barrier, round);
    // Every child is inside its spin loop. This is the starting gun for this round.
    writeFileSync(`${barrier}.go.${String(round)}`, 'go\n', 'utf8');
  }

  /**
   * Every child reports before any child exits.
   *
   * A process that left as soon as it had finished the last round would leave its claims held by a pid
   * that is gone — which is a *stale* claim, and AD-30's rule is that a stale claim may be reclaimed. A
   * slower contender in the same round would then win it too, and the race would look like it had two
   * winners when the primitive had done exactly its job. So the children are released only once all of
   * them have spoken.
   */
  await countedLines(everyone);
  writeFileSync(`${barrier}.done`, 'done\n', 'utf8');

  await Promise.all(everyone.map((handle) => handle.exited));

  const reportsOf = (handle: ChildHandle, index: number): readonly Observation[] => {
    const lines = handle.out().stdout.trim().split('\n').filter((line) => line !== '');
    if (lines.length !== ROUNDS) {
      throw new Error(
        `contender ${String(index)} reported ${String(lines.length)} of ${String(ROUNDS)} rounds ` +
          `(code ${String(handle.child.exitCode)}): ${handle.out().stderr}`,
      );
    }
    return lines.map((line) => JSON.parse(line) as Observation);
  };

  return {
    claims: handles.flatMap((handle, index) => reportsOf(handle, index)),
    watched: reportsOf(watcher, CONTENDERS),
  };
};

const byRound = (observations: readonly Observation[]): Map<number, Observation[]> => {
  const rounds = new Map<number, Observation[]>();
  for (const observation of observations) {
    rounds.set(observation.round, [...(rounds.get(observation.round) ?? []), observation]);
  }
  return rounds;
};

/** The assertions both races share: one winner, and every loser read the winner's whole claim. */
const assertOneWinnerAndNoTornRead = (
  observations: readonly Observation[],
  watched: readonly Observation[],
): void => {
  expect(observations).toHaveLength(CONTENDERS * ROUNDS);

  /**
   * The claim was never present-but-empty, at the instant it was published.
   *
   * The watcher saw every round's file appear — asserted first, because a watcher that missed the file
   * entirely would make the rest of this vacuous — and every first sighting held the whole claim. A
   * zero-length sighting is the defect, and it is what an exclusive create followed by a write produces.
   */
  expect(watched).toHaveLength(ROUNDS);
  for (const sighting of watched) {
    expect(sighting.firstSizeSeen, `round ${String(sighting.round)} was never seen at all`).not.toBe(-1);
    expect(sighting.firstSizeSeen, `round ${String(sighting.round)} saw an empty claim`).toBeGreaterThan(0);
  }

  /**
   * Real processes, none of them this one.
   *
   * Asserted rather than assumed, because it is the entire premise: a suite that had quietly ended up
   * claiming in-process would satisfy everything below and prove nothing about two `link` calls issued
   * from different address spaces.
   */
  const pids = new Set(observations.map((observation) => observation.pid));
  expect(pids.size).toBe(CONTENDERS);
  expect(pids.has(process.pid)).toBe(false);

  for (const [round, entries] of byRound(observations)) {
    expect(entries, `round ${String(round)}`).toHaveLength(CONTENDERS);
    const winners = entries.filter((entry) => entry.won);
    // Exactly one winner: the create is the decision, and it is atomic across processes.
    expect(winners, `round ${String(round)}`).toHaveLength(1);
    const winner = winners[0]?.pid;

    for (const loser of entries.filter((entry) => !entry.won)) {
      /**
       * The claim the loser read names the winner. This is the assertion the defect fails.
       *
       * `holderPid` is `null` exactly when the claim file could not be read back as a claim — which is
       * what a zero-length file published by an exclusive create looks like. With the claim linked into
       * place whole, there is no instant at which the file exists and holds anything else.
       */
      expect(loser.holderPid, `round ${String(round)}, pid ${String(loser.pid)}`).toBe(winner);
      // And directly: never a present-but-empty file. -1 would mean the file had gone, which would be a
      // different defect and is not one either claim has.
      expect(loser.bytesAtLoss, `round ${String(round)}, pid ${String(loser.pid)}`).toBeGreaterThan(0);
    }
  }
};

describe('two processes racing to claim the event-log writer', () => {
  it(
    'gives the log exactly one writer, and the losers a claim that names the holder',
    async () => {
      const { claims, watched } = await race('recorder');
      assertOneWinnerAndNoTornRead(claims, watched);

      // The claim left on disk is one whole line of JSON per round, naming the round's winner.
      for (const [round, entries] of byRound(claims)) {
        const path = runPaths(`race-run-${String(round)}`, home).eventLogLock;
        expect(existsSync(path), path).toBe(true);
        const claim = JSON.parse(readFileSync(path, 'utf8')) as { pid: number; run: string };
        expect(claim.pid).toBe(entries.find((entry) => entry.won)?.pid);
        expect(claim.run).toBe(`race-run-${String(round)}`);
      }
    },
    RACE_TIMEOUT_MS,
  );

  it(
    'leaves no temporary behind, so the race writes nothing a later reader has to ignore',
    async () => {
      const { claims } = await race('recorder');
      expect(claims.filter((entry) => entry.won)).toHaveLength(ROUNDS);

      for (let round = 0; round < ROUNDS; round += 1) {
        const runDir = runPaths(`race-run-${String(round)}`, home).runDir;
        // The claim, the log, and nothing else: a lost `link` removes its own temporary, so sixty losses
        // leave sixty fewer files than a temp-then-rename implementation would.
        expect(readdirSync(runDir).sort()).toStrictEqual(['events.jsonl', 'events.jsonl.lock']);
      }
    },
    RACE_TIMEOUT_MS,
  );
});

describe('two processes racing for the engine lock', () => {
  it(
    'gives the ORCH_HOME exactly one engine, and the losers a holder they can name',
    async () => {
      // One `ORCH_HOME` per round, created up front: the lock is a property of the home, so a fresh home
      // is what makes each round a fresh race rather than a re-run against a held lock.
      for (let round = 0; round < ROUNDS; round += 1) {
        mkdirSync(join(home, `round-${String(round)}`), { recursive: true });
      }

      const { claims, watched } = await race('lock');
      assertOneWinnerAndNoTornRead(claims, watched);

      for (const [round, entries] of byRound(claims)) {
        const claim = readEngineLockClaim(engineLockPath(join(home, `round-${String(round)}`)));
        // AD-30 requires the pid and the start time, and the loser's refusal quoted both because the file
        // held both at the instant it was read.
        expect(claim?.pid).toBe(entries.find((entry) => entry.won)?.pid);
        expect(claim?.since).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      }
    },
    RACE_TIMEOUT_MS,
  );
});
