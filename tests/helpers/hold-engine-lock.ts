/**
 * A child process that takes the AD-30 engine lock and then waits to be killed.
 *
 * Cross-process contention cannot be tested in one process: the in-process holder map would refuse the
 * second acquire before the lock file was ever consulted, so the test would pass without exercising the
 * mechanism AD-30 actually relies on. A real second process is the only honest way to reach the
 * `EEXIST` branch and the pid-liveness check.
 *
 * Spawned as:
 *   node --import jiti/register tests/helpers/hold-engine-lock.ts <orch-home> [--crash]
 *
 * It prints one line of JSON on stdout — `{"pid":…,"since":…}` — once the lock is held, so the parent
 * can wait for the claim rather than sleeping. With `--crash` it `SIGKILL`s itself immediately after,
 * leaving exactly the stale lock a reclaim has to recognise.
 *
 * `jiti` is used because the sources spell imports with TypeScript's `.js` convention, which Node's own
 * type stripping does not remap to `.ts`. This is a test helper, not a `*.test.ts` file, so the Vitest
 * `include` does not pick it up.
 */
import { writeSync } from 'node:fs';

import { acquireEngineLock } from '../../src/engine/index.js';

/**
 * Announce on fd 1 with a *synchronous* write.
 *
 * `process.stdout.write` to a pipe is asynchronous: the bytes are queued on the stream and flushed on a
 * later tick. `SIGKILL` on the next statement destroys the process before that tick, so the parent would
 * wait forever for a claim that was written and never sent. `writeSync` is a blocking `write(2)`, so the
 * bytes are in the pipe before the signal can arrive.
 */
const announce = (line: string): void => {
  writeSync(1, line);
};

const [orchHome, ...flags] = process.argv.slice(2);

if (orchHome === undefined) {
  process.stderr.write('usage: hold-engine-lock.ts <orch-home> [--crash]\n');
  process.exit(2);
}

const lock = acquireEngineLock({ orchHome, reclaimStale: false });

// stdout is this helper's protocol with its parent, not a diagnostic: the Consistency Conventions' ban
// on stdout diagnostics is about units of the system, and this file is a test fixture.
announce(`${JSON.stringify({ pid: lock.claim.pid, since: lock.claim.since })}\n`);

if (flags.includes('--crash')) {
  // Leave the lock file behind naming a pid that is about to be gone: the stale-lock case, produced
  // rather than simulated by hand-writing a lock file with a made-up pid.
  process.kill(process.pid, 'SIGKILL');
}

// Hold the lock until the parent kills this process.
setInterval(() => {
  /* keep the event loop alive */
}, 1_000);
