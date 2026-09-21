/**
 * A child process that registers one project at the same instant as its siblings (matrix 15).
 *
 * The record is created by an exclusive `link(2)` that publishes a fully written inode, and what that
 * buys is a property no single-process test can doubt: two registrations racing for one id leave
 * exactly one record, and it is whole. In one event loop the second create is ordered after the first by
 * construction, and the loser's read of the winner's record is ordered after the winner's write for the
 * same reason — which is precisely the ordering under test. So these are real children on a barrier,
 * the shape `claim-race.ts` established for the two write claims.
 *
 * Spawned as:
 *   node --import jiti/register tests/helpers/register-race.ts \
 *        <orch-home> <repos-root> <barrier-prefix> <rounds>
 *
 * Each round registers `<repos-root>/round-<r>`, a repository the parent made before spawning anybody.
 * A child announces readiness for round `r` by creating `<barrier-prefix>.ready.<r>.<pid>` and then
 * spins — a tight `existsSync` loop, deliberately not a timer — until the parent creates
 * `<barrier-prefix>.go.<r>`. Without the barrier each child would spend most of a second compiling the
 * tree through `jiti` and they would reach the create hundreds of milliseconds apart, so the primitive
 * would never be exercised at all.
 *
 * It prints one line of JSON per round on stdout. A child that cannot register, or that reads back a
 * record it cannot parse, exits non-zero with the fault on stderr rather than reporting a round: a torn
 * or missing record is the defect this helper exists to detect, and it must not be reportable as data.
 */
import { existsSync, writeFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';

import { registerProject } from '../../src/runtime/index.js';

const [orchHome, reposRoot, barrierPrefix, rounds] = process.argv.slice(2);

if (
  orchHome === undefined ||
  reposRoot === undefined ||
  barrierPrefix === undefined ||
  rounds === undefined
) {
  process.stderr.write('usage: register-race <orch-home> <repos-root> <barrier-prefix> <rounds>\n');
  process.exit(2);
}

/** What this process did to the record for one round. */
interface Registration {
  readonly round: number;
  readonly pid: number;
  readonly disposition: string;
  readonly projectId: string;
  readonly path: string;
}

const announce = (line: string): void => {
  // A synchronous write, for the same reason `claim-race.ts` uses one: bytes queued on a pipe are lost
  // if the process stops before the flushing tick.
  writeSync(1, line);
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

  try {
    const registered = registerProject(join(reposRoot, `round-${String(round)}`), { orchHome });
    const observation: Registration = {
      round,
      pid: process.pid,
      disposition: registered.disposition,
      projectId: registered.projectId,
      path: registered.path,
    };
    announce(`${JSON.stringify(observation)}\n`);
  } catch (thrown: unknown) {
    process.stderr.write(`round ${String(round)}: ${String(thrown)}\n`);
    process.exit(4);
  }
}
