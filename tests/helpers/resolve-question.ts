/**
 * A child process that contends for one question's AD-25 compare-and-set.
 *
 * Cross-process contention cannot be tested in one process. Two promises racing in one event loop share an
 * interpreter, a filesystem cache and a single `open` call ordering; they can demonstrate that the *second*
 * call sees the first one's file, which is not the question. The question is whether two `open(O_EXCL)`
 * calls issued from different processes against the same path resolve to one winner, and only real
 * processes can answer it. Story 1-3's lock suite established the same pattern for the AD-30 lock, for the
 * same reason.
 *
 * Spawned as:
 *   node --import jiti/register tests/helpers/resolve-question.ts \
 *        <orch-home> <run> <question-id> <resolver> <ready-file> <go-file> [option-id]
 *
 * The barrier is what makes the race real. Each child compiles the engine tree through `jiti`, which takes
 * the best part of a second, so children launched together would otherwise reach the `open` hundreds of
 * milliseconds apart and the first would always win by a mile. Instead each child announces readiness by
 * creating `<ready-file>`, then spins — a tight `existsSync` loop, deliberately not a timer — until the
 * parent creates `<go-file>`. All of them are inside the spin when it appears, so they issue their `open`
 * calls within microseconds of one another.
 *
 * It prints one line of JSON on stdout saying what this resolver was told: whether it won, whether *its*
 * `open` was the one that created the file, the refusal it was handed if it lost, and which resolver the
 * outcome on disk names. The parent asserts across all of them that exactly one won.
 */
import { existsSync, writeFileSync, writeSync } from 'node:fs';

import type { QuestionResolver } from '../../src/contracts/index.js';
import { runPaths } from '../../src/runtime/index.js';
import {
  attemptQuestionResolution,
  questionResolution,
  settleQuestion,
  takeQuestionDefault,
} from '../../src/engine/index.js';

const [orchHome, run, questionId, resolver, readyFile, goFile, optionId] = process.argv.slice(2);

if (
  orchHome === undefined ||
  run === undefined ||
  questionId === undefined ||
  resolver === undefined ||
  readyFile === undefined ||
  goFile === undefined
) {
  process.stderr.write(
    'usage: resolve-question <orch-home> <run> <question-id> <resolver> <ready-file> <go-file> [option-id]\n',
  );
  process.exit(2);
}

const paths = runPaths(run, orchHome);

/**
 * Everything that can be done *before* the barrier is done before it.
 *
 * Reading the question, parsing the resolution and resolving the paths all touch the filesystem and the
 * Zod schemas, and doing any of it after the barrier would put a different amount of work in front of each
 * child's `open` — which would decide the race by startup cost rather than by the primitive.
 */
const asked = settleQuestion(paths, questionId).state;
const answer =
  resolver === 'timeout_default'
    ? null
    : questionResolution({
        resolver: resolver as QuestionResolver,
        principal: { kind: 'user', id: resolver },
        answer: optionId ?? `answered by the ${resolver} resolver`,
        optionId: optionId ?? null,
      });

writeFileSync(readyFile, `${String(process.pid)}\n`, 'utf8');

/**
 * A tight spin, not a poll with a delay.
 *
 * A `setTimeout` poll would wake each child on its own timer and spread the `open` calls out across the
 * interval — turning the race back into a sequence. Spinning burns a few milliseconds of CPU and is the
 * point: every child is in this loop when the file appears.
 */
const deadline = Date.now() + 60_000;
while (!existsSync(goFile)) {
  if (Date.now() > deadline) {
    process.stderr.write('the go file never appeared\n');
    process.exit(3);
  }
}

const claim =
  answer === null
    ? takeQuestionDefault(paths, questionId, asked.question, new Date())
    : attemptQuestionResolution(paths, questionId, answer);

// stdout is this helper's protocol with its parent, not a diagnostic, and it is written synchronously for
// the same reason the lock helper's is: a queued write on a pipe is lost if the process stops early.
writeSync(
  1,
  `${JSON.stringify({
    pid: process.pid,
    resolver,
    accepted: claim.accepted,
    created: claim.created,
    contended: claim.contended,
    refusal: claim.refusal,
    standing: claim.state.resolution?.resolver ?? null,
    standingPrincipal: claim.state.resolution?.principal.id ?? null,
    status: claim.state.status,
  })}\n`,
);
