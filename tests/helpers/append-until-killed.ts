/**
 * A writer that never stops, for the AD-4 "whole lines only" assertion.
 *
 * `tests/runtime.recorder.test.ts` spawns this, waits until the log has grown, then SIGKILLs it. A
 * killed process cannot finish a partial write or clean up, so whatever the file then holds is what
 * a crashed run leaves behind: the parent asserts every line parses and every `seq` is present
 * exactly once.
 *
 * Run as: node --import jiti/register tests/helpers/append-until-killed.ts <orch-home> <run-id>
 * It writes nothing to stdout — diagnostics are the event log's job (Consistency Conventions).
 */
import { Recorder } from '../../src/runtime/index.js';

const [orchHome, runId] = process.argv.slice(2);
if (orchHome === undefined || runId === undefined) {
  process.stderr.write('usage: append-until-killed <orch-home> <run-id>\n');
  process.exit(2);
}

const recorder = Recorder.open({
  runId,
  feature: 'runtime-recorder',
  orchHome,
  // fsync would throttle the loop to a few appends a second, and durability is not what is under
  // test here: a SIGKILL does not discard the page cache, so the file still holds what was written.
  fsync: false,
});

/** Large enough that a naive two-part write would tear visibly, small enough to stay one syscall. */
const filler = 'x'.repeat(4096);

for (;;) {
  recorder.record({
    feature: 'runtime-recorder',
    run: runId,
    step: 'implementation',
    emitter: 'step.subprocess',
    type: 'agent.tool_used',
    payload: { filler, at: recorder.seqOfNextAppend },
  });
}
