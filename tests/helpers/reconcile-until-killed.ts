/**
 * The reconciler, driven in a real child process that `SIGKILL`s itself at a chosen durable boundary.
 *
 * AD-31 requires crash-injection tests that kill the loop "at every state transition" and assert AD-7's
 * resume-identical behaviour. An in-process assertion cannot stand for that: the thing under test is
 * what a process leaves on disk when it is not allowed to finish, clean up, flush or run a handler.
 * `SIGKILL` in a child is the only signal that guarantees none of those happen.
 *
 * Spawned as:
 *   node --import jiti/register tests/helpers/reconcile-until-killed.ts <orch-home> <worktree> <kill-after>
 *
 * `<kill-after>` is a 1-based durable-boundary index — 0 means never kill, which is the uninterrupted
 * run the interrupted ones are compared against. On a clean finish it prints one line of JSON carrying
 * the run id, the lifecycle fingerprint and every boundary label crossed, so the parent learns how many
 * boundaries exist rather than being told a number that could go stale.
 *
 * It is deliberately *idempotent on restart*: a run already present under `ORCH_HOME/runs/` is adopted
 * rather than replaced, and confirmation is only recorded if the log does not already hold it. That is
 * exactly what a restarting engine does, so the restart path the suite exercises is the real one.
 */
import { writeSync } from 'node:fs';

import { Reconciler, createUlidMinter } from '../../src/engine/index.js';

import { crashFixtureExecutor, crashFixturePlan, planProvider } from './engine-fixture.js';

const [orchHome, worktree, killAfterRaw] = process.argv.slice(2);

if (orchHome === undefined || worktree === undefined || killAfterRaw === undefined) {
  process.stderr.write('usage: reconcile-until-killed <orch-home> <worktree> <kill-after>\n');
  process.exit(2);
}

const killAfter = Number(killAfterRaw);
const plan = crashFixturePlan(worktree);

let crossed = 0;
const boundaries: string[] = [];

const reconciler = Reconciler.open({
  orchHome,
  executor: crashFixtureExecutor(),
  plans: planProvider(plan),
  // A pinned minter makes the run id the same in every iteration, so the parent can name the run before
  // the child has created it and the comparison is between two runs of one identity.
  minter: createUlidMinter({ now: () => 1_770_000_000_000, random: () => new Uint8Array(16) }),
  onDurableBoundary: (label: string): void => {
    crossed += 1;
    boundaries.push(label);
    if (killAfter > 0 && crossed === killAfter) {
      // No flush, no handler, no cleanup — the whole point. Whatever is on disk at this instant is what
      // a restart has to converge from.
      process.kill(process.pid, 'SIGKILL');
    }
  },
});

const main = async (): Promise<void> => {
  const existing = reconciler.runIds();
  const run = existing[0] ?? reconciler.acceptFeature(plan).run;

  if (reconciler.load(run).state.state === 'drafting') {
    reconciler.confirm(run);
  }

  await reconciler.runUntilSettled();

  const fingerprint = reconciler.fingerprint(run);
  reconciler.close();
  // stdout is this helper's protocol with its parent, not a diagnostic. Written synchronously for the
  // same reason `hold-engine-lock.ts` is: a queued write on a pipe is lost if the process stops early.
  writeSync(1, `${JSON.stringify({ run, fingerprint, boundaries })}\n`);
};

await main();
