/**
 * A child process that contends for one of the two claims that decide who may write: the recorder's
 * single-writer claim on a run's `events.jsonl` (AD-29) and the engine lock on an `ORCH_HOME` (AD-30).
 *
 * Both are cross-process guarantees, so neither can be tested in one process. In one event loop the
 * second `open` is ordered after the first by construction, and a losing reader's read is ordered after
 * the winner's write for the same reason — which is exactly the ordering the defect this suite is about
 * depends on. Story 1-8's `resolve-question.ts` established this shape for the question outcome; this is
 * the same shape for the other two claims, kept in one helper because the two races differ only in which
 * function is called.
 *
 * Spawned as:
 *   node --import jiti/register tests/helpers/claim-race.ts \
 *        <recorder|lock> <orch-home> <barrier-prefix> <rounds>
 *
 * The barrier is what makes the race real. Each child compiles the engine tree through `jiti`, which
 * takes most of a second, so children launched together would reach their claim hundreds of milliseconds
 * apart and the first would win every time without the primitive being tested at all. Instead each child
 * announces readiness for round `r` by creating `<barrier-prefix>.ready.<r>.<pid>`, then spins — a tight
 * `existsSync` loop, deliberately not a timer — until the parent creates `<barrier-prefix>.go.<r>`.
 *
 * Several rounds per child rather than one, because one race per spawn buys a handful of samples for a
 * second of compilation, and the window this suite exists to close is microseconds wide: catching it
 * needs tens of contended claims, not four.
 *
 * It prints one line of JSON per round on stdout: whether this process won, and — when it lost — what it
 * could read of the winner's claim *at the instant it lost*. That last part is the whole point. A claim
 * published by an exclusive create and then written is a claim a loser can observe empty; a claim
 * published whole by `link(2)` cannot be.
 */
import { existsSync, readFileSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';

import { Recorder, WriterConflictError, runPaths } from '../../src/runtime/index.js';
import { EngineLockHeldError, acquireEngineLock, engineLockPath } from '../../src/engine/index.js';

const [kind, orchHome, barrierPrefix, rounds, role = 'claim'] = process.argv.slice(2);

if (
  (kind !== 'recorder' && kind !== 'lock') ||
  (role !== 'claim' && role !== 'watch') ||
  orchHome === undefined ||
  barrierPrefix === undefined ||
  rounds === undefined
) {
  process.stderr.write(
    'usage: claim-race <recorder|lock> <orch-home> <barrier-prefix> <rounds> [claim|watch]\n',
  );
  process.exit(2);
}

/** The run id and the `ORCH_HOME` this round contends over. One fresh target per round. */
const targetFor = (round: number): { readonly runId: string; readonly home: string } => ({
  runId: `race-run-${String(round)}`,
  home: kind === 'lock' ? join(orchHome, `round-${String(round)}`) : orchHome,
});

/** What this process observed of the claim it lost to, read the moment it was refused. */
interface Observation {
  readonly round: number;
  readonly pid: number;
  readonly won: boolean;
  /** The pid the refusal named, or `null` when the claim could not be read back as a claim. */
  readonly holderPid: number | null;
  /** How many bytes the claim file held when this process read it. Zero is the defect. */
  readonly bytesAtLoss: number;
  /**
   * `watch` only: the size of the claim the first time this process saw the file exist at all, or `-1`
   * when it never appeared.
   *
   * This is the most sensitive statement either race can make about the window. A contender's read happens
   * behind its own failed create, so it can miss a window a whole `write(2)` wide; a watcher is already
   * inside a `stat` loop when the file appears, so it sees the claim as it is *published*. Under an
   * exclusive create followed by a write that is a zero-length file, and under a create that links a whole
   * inode into place it can never be.
   */
  readonly firstSizeSeen?: number;
}

/** The claim file this round contends over. */
const pathFor = (round: number): string => {
  const target = targetFor(round);
  // Asked of the AD-9 layout rather than joined by hand: a helper that guessed the path could report a
  // missing file of its own making as a torn claim.
  return kind === 'recorder'
    ? runPaths(target.runId, target.home).eventLogLock
    : engineLockPath(target.home);
};

/**
 * Watch one round's claim appear, and report how big it was the first time it existed.
 *
 * A tight `stat` loop, deliberately not a poll with a delay: the window being measured is one syscall
 * wide, so a watcher that slept would be measuring its own timer.
 */
const watch = (round: number): Observation => {
  const path = pathFor(round);
  const deadline = Date.now() + 5_000;
  for (;;) {
    try {
      return {
        round,
        pid: process.pid,
        won: false,
        holderPid: null,
        bytesAtLoss: -1,
        firstSizeSeen: statSync(path).size,
      };
    } catch {
      if (Date.now() > deadline) {
        return { round, pid: process.pid, won: false, holderPid: null, bytesAtLoss: -1, firstSizeSeen: -1 };
      }
    }
  }
};

const announce = (line: string): void => {
  // A synchronous write, for the same reason story 1-2's lock helper uses one: bytes queued on a pipe are
  // lost if the process stops before the flushing tick.
  writeSync(1, line);
};

/**
 * Everything this process won, held for the lifetime of the process and never released.
 *
 * Nothing here calls `close()` or `release()`, and that is deliberate rather than untidy. A winner that
 * released its claim would delete the file the parent inspects afterwards, and — worse — would hand a
 * still-spinning contender of the *same* round a free second win, so the suite would report two winners
 * for a race that had exactly one. The claims are left on disk as the evidence they are, and the parent
 * removes the whole `ORCH_HOME` when the race is over.
 */
const held: unknown[] = [];

const claim = (round: number): Observation => {
  const target = targetFor(round);
  const path = pathFor(round);
  const bytes = (): number => {
    try {
      return readFileSync(path).byteLength;
    } catch {
      return -1;
    }
  };

  try {
    if (kind === 'recorder') {
      const recorder = Recorder.open({
        runId: target.runId,
        feature: 'runtime-recorder',
        orchHome: target.home,
        fsync: false,
      });
      held.push(recorder);
    } else {
      held.push(acquireEngineLock({ orchHome: target.home, reclaimStale: false }));
    }
    return { round, pid: process.pid, won: true, holderPid: null, bytesAtLoss: -1 };
  } catch (thrown: unknown) {
    const holder =
      thrown instanceof WriterConflictError || thrown instanceof EngineLockHeldError
        ? thrown.holder
        : null;
    if (!(thrown instanceof WriterConflictError) && !(thrown instanceof EngineLockHeldError)) {
      // Anything else is a real fault and is reported as itself, never as a lost race.
      process.stderr.write(`round ${String(round)}: ${String(thrown)}\n`);
      process.exit(4);
    }
    return {
      round,
      pid: process.pid,
      won: false,
      holderPid: holder?.pid ?? null,
      bytesAtLoss: bytes(),
    };
  }
};

for (let round = 0; round < Number(rounds); round += 1) {
  const goFile = `${barrierPrefix}.go.${String(round)}`;
  writeFileSync(
    `${barrierPrefix}.ready.${String(round)}.${String(process.pid)}`,
    `${String(process.pid)}\n`,
    'utf8',
  );

  const deadline = Date.now() + 120_000;
  while (!existsSync(goFile)) {
    if (Date.now() > deadline) {
      process.stderr.write(`the go file for round ${String(round)} never appeared\n`);
      process.exit(3);
    }
  }

  announce(`${JSON.stringify(role === 'watch' ? watch(round) : claim(round))}\n`);
}

/**
 * Stay alive until the parent says the race is over.
 *
 * Without this, the first process to finish the last round exits while the others are still inside it —
 * and a claim held by a pid that has *gone* is a stale claim, which AD-30's rule says the next process
 * may reclaim. A later contender would then win the same round legitimately, and the suite would see two
 * winners for one race and blame the primitive. So the process holds its claims until the parent has read
 * every report.
 */
const doneFile = `${barrierPrefix}.done`;
const exitDeadline = Date.now() + 120_000;
while (!existsSync(doneFile)) {
  if (Date.now() > exitDeadline) {
    process.stderr.write('the done file never appeared\n');
    process.exit(5);
  }
}

// stderr is diagnostics, never this helper's stdout protocol: it says how many claims this process was
// still holding when the parent released it, per the comment on `held`.
writeSync(2, `holding ${String(held.length)} claims at exit\n`);
