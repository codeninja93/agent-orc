/**
 * AD-25's single-winner property, driven from **separate processes**.
 *
 * This is the one suite in the story that cannot be written any other way. Two promises racing in one
 * event loop share an interpreter, a filesystem cache and a deterministic ordering of their own `open`
 * calls: they can show that the second call sees the first one's file, which was never in doubt. What is in
 * doubt — and what AD-25 rests on — is that two `open(O_EXCL)` calls issued by *different processes*
 * against one path resolve to exactly one winner. An in-process test of that guarantee would be the
 * equivalent of the vacuous `'a'.repeat(40)` commit-SHA fixture story 1-3's review caught: green, and
 * about nothing.
 *
 * Story 1-3's lock suite is the model, including the bug it paid for: the child's `exit` listener is
 * attached the instant the child exists, because `once(child, 'exit')` called later waits forever for an
 * event that already fired.
 *
 * The barrier is the other half of making the race real. Each child compiles the engine through `jiti`,
 * which takes most of a second, so children spawned together would reach their `open` hundreds of
 * milliseconds apart and the first would win every time without the primitive ever being tested. So each
 * child does all its work up front, announces readiness, and spins on a file the parent creates — putting
 * every one of them inside a tight loop at the moment the race starts.
 */
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { QuestionDraft } from '../src/contracts/index.js';
import { readEventLog, runPaths } from '../src/runtime/index.js';
import {
  DECISION_EVENT_TYPE,
  QUESTION_EVENT_TYPES,
  Reconciler,
  createRecordingResetter,
  createScriptedExecutor,
  decisionsInLog,
  mintQuestionId,
  mintRunId,
  settleQuestion,
  terminated,
} from '../src/engine/index.js';

import { makeHome, makePlan, planProvider } from './helpers/engine-fixture.js';

const HELPER = fileURLToPath(new URL('helpers/resolve-question.ts', import.meta.url));
const JITI = fileURLToPath(new URL('../node_modules/jiti/lib/jiti-register.mjs', import.meta.url));

/**
 * Every child compiles the whole engine tree through `jiti`, which comfortably exceeds Vitest's default
 * while other suites run in parallel. The bound is generous on purpose: it exists so a genuine hang fails
 * rather than runs forever, not to measure startup.
 */
const RACE_TIMEOUT_MS = 180_000;
const BASELINE = 'ddd9bed4d286ac1f8a0f4f7bfef9530046605787';

let home: string;
const children: ChildProcess[] = [];
const toRemove: string[] = [];
const toClose: Reconciler[] = [];

beforeEach(() => {
  home = makeHome('engine-question-race');
  toRemove.push(home);
});

afterEach(() => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
  for (const reconciler of toClose.splice(0)) reconciler.close();
  for (const dir of toRemove.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const aDraft = (overrides: Partial<QuestionDraft> = {}): QuestionDraft => ({
  prompt: 'Should the failing test be fixed or the assertion relaxed?',
  brief:
    'The verification step reports one failing assertion about an error message’s wording. Fixing the ' +
    'behaviour is the larger change; relaxing the assertion keeps the suite green and loses the guarantee.',
  options: [
    { id: 'fix', label: 'Fix the behaviour', consequence: 'The step re-runs and takes longer.' },
    { id: 'relax', label: 'Relax the assertion', consequence: 'The guarantee is weakened.' },
  ],
  escape: {
    id: 'hand-back',
    label: 'Hand it back to me',
    consequence: 'The run hands off with the failure described.',
  },
  recommended_option_id: 'fix',
  default_action: 'The behaviour is fixed and the step re-runs.',
  // Long enough that no window expires by accident while children are compiling: the timeout resolver in
  // the three-way race takes the default explicitly, so expiry must never be what decides this test.
  default_window_ms: 60 * 60 * 1000,
  ...overrides,
});

/** A real run with a real question, asked through the engine so the race contends for the real artifact. */
const askOneQuestion = (): { readonly run: string; readonly questionId: string } => {
  const reconciler = Reconciler.open({
    orchHome: home,
    executor: createScriptedExecutor({
      onStart: (request) => terminated(request.step, 'completed', { sessionId: `sess-${request.step}` }),
    }),
    plans: planProvider(makePlan()),
    baseline: createRecordingResetter(BASELINE),
  });
  try {
    const run = reconciler.acceptFeature(makePlan()).run;
    const asked = reconciler.ask(run, aDraft(), { questionId: mintQuestionId(mintRunId()) });
    return { run, questionId: asked.question.id };
  } finally {
    // Released before the children run: they never take the AD-30 lock, and a parent holding it while the
    // suite later reopens an engine over the same home would refuse the restart for the wrong reason.
    reconciler.close();
  }
};

interface ChildReport {
  readonly pid: number;
  readonly resolver: string;
  readonly accepted: boolean;
  readonly created: boolean;
  readonly contended: boolean;
  readonly refusal: string | null;
  readonly standing: string | null;
  readonly standingPrincipal: string | null;
  readonly status: string;
}

interface ChildHandle {
  readonly child: ChildProcess;
  readonly exited: Promise<unknown>;
  readonly readyFile: string;
  readonly out: () => { readonly stdout: string; readonly stderr: string };
}

const spawnResolver = (
  run: string,
  questionId: string,
  resolver: string,
  index: number,
  goFile: string,
  optionId?: string,
): ChildHandle => {
  const readyFile = join(home, `ready-${String(index)}`);
  const child = spawn(
    process.execPath,
    [
      '--import',
      JITI,
      HELPER,
      home,
      run,
      questionId,
      resolver,
      readyFile,
      goFile,
      ...(optionId === undefined ? [] : [optionId]),
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  children.push(child);
  /**
   * Attached now, before the child can exit.
   *
   * `once(child, 'exit')` called after the child has already exited waits forever for an event that has
   * been and gone — the bug story 1-3's lock suite introduced and then fixed. Every child here finishes
   * quickly once the barrier lifts, so the window is real.
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
  return { child, exited, readyFile, out: () => ({ stdout, stderr }) };
};

/** Wait until every child is spinning on the barrier, failing loudly if one dies before it gets there. */
const awaitReady = async (handles: readonly ChildHandle[]): Promise<void> => {
  const deadline = Date.now() + 120_000;
  while (!handles.every((handle) => existsSync(handle.readyFile))) {
    for (const [index, handle] of handles.entries()) {
      if (handle.child.exitCode !== null || handle.child.signalCode !== null) {
        throw new Error(
          `resolver ${String(index)} exited (code ${String(handle.child.exitCode)}, ` +
            `signal ${String(handle.child.signalCode)}) before reaching the barrier; ` +
            `stdout: ${JSON.stringify(handle.out().stdout)}; stderr: ${handle.out().stderr}`,
        );
      }
    }
    if (Date.now() > deadline) {
      throw new Error('not every resolver reached the barrier within 120s');
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

/** Run one race and return what each process was told. */
const race = async (
  contenders: readonly { readonly resolver: string; readonly optionId?: string }[],
): Promise<{
  readonly run: string;
  readonly questionId: string;
  readonly reports: readonly ChildReport[];
}> => {
  const { run, questionId } = askOneQuestion();
  const goFile = join(home, 'go');

  const handles = contenders.map((contender, index) =>
    spawnResolver(run, questionId, contender.resolver, index, goFile, contender.optionId),
  );
  await awaitReady(handles);

  // Every child is inside its spin loop. This is the starting gun.
  writeFileSync(goFile, 'go\n', 'utf8');

  await Promise.all(handles.map((handle) => handle.exited));

  const reports = handles.map((handle, index): ChildReport => {
    const line = handle.out().stdout.trim();
    if (line === '') {
      throw new Error(
        `resolver ${String(index)} reported nothing (code ${String(handle.child.exitCode)}, ` +
          `signal ${String(handle.child.signalCode)}): ${handle.out().stderr}`,
      );
    }
    return JSON.parse(line) as ChildReport;
  });
  return { run, questionId, reports };
};

const questionFiles = (run: string, questionId: string): readonly string[] =>
  readdirSync(join(runPaths(run, home).questionsDir, questionId)).sort();

describe('exactly one transition is accepted, proven across processes', () => {
  it(
    'gives one winner to a TUI answer, a web answer and an expiring window racing in three processes',
    async () => {
      const { run, questionId, reports } = await race([
        { resolver: 'tui', optionId: 'fix' },
        { resolver: 'web', optionId: 'relax' },
        { resolver: 'timeout_default' },
      ]);

      expect(reports).toHaveLength(3);

      /**
       * Three *different* processes, none of them this one.
       *
       * Asserted rather than assumed, because it is the entire premise: a suite that had quietly ended up
       * resolving in-process would satisfy every other assertion below and prove nothing about two `link`
       * calls from different address spaces.
       */
      const pids = new Set(reports.map((report) => report.pid));
      expect(pids.size).toBe(3);
      expect(pids.has(process.pid)).toBe(false);

      // Exactly one exclusive create landed, and exactly one resolver was told it won.
      const creators = reports.filter((report) => report.created);
      const winners = reports.filter((report) => report.accepted);
      expect(creators).toHaveLength(1);
      expect(winners).toHaveLength(1);
      expect(winners[0]?.resolver).toBe(creators[0]?.resolver);

      const winner = creators[0]?.resolver;
      expect(winner).toBeDefined();

      // The two losers were each handed an already-resolved result naming the outcome that stands.
      for (const report of reports.filter((entry) => !entry.created)) {
        expect(report.accepted, report.resolver).toBe(false);
        expect(report.refusal, report.resolver).not.toBeNull();
        expect(report.refusal ?? '', report.resolver).toMatch(/already|timed out/i);
        expect(report.standing, report.resolver).toBe(winner);
        /**
         * And every one of them lost *at the exclusive create*, not at a check in front of it.
         *
         * This is the assertion that makes the suite about the primitive rather than about the outcome. A
         * resolver that never reached the create would still report having lost — correctly — and a
         * read-then-write implementation would pass every other assertion here while being exactly the
         * design AD-25 forbids. `contended` is false only for an answer the state machine refused on its own
         * terms, which no contender here does.
         */
        expect(report.contended, report.resolver).toBe(true);
      }

      // One transition on disk, and it is the winner's: the losers' answers never reached it.
      const settled = settleQuestion(runPaths(run, home), questionId);
      expect(settled.state.status).toBe('resolved');
      expect(settled.state.resolution?.resolver).toBe(winner);
      // AD-25 — the winning transition records its resolver *and* its principal.
      expect(settled.state.resolution?.principal.kind).toBe(
        winner === 'timeout_default' ? 'timeout' : 'user',
      );
      expect(settled.state.resolution?.principal.id).toBe(
        winner === 'timeout_default' ? 'question.window' : winner,
      );

      // Two files, and no debris: nothing wrote a second outcome or left a half-written temporary.
      expect(questionFiles(run, questionId)).toStrictEqual(['outcome.json', 'state.json']);
      const outcome = JSON.parse(
        readFileSync(join(runPaths(run, home).questionsDir, questionId, 'outcome.json'), 'utf8'),
      ) as { resolution: { resolver: string } | null; deflection: unknown };
      expect(outcome.resolution?.resolver).toBe(winner);
      expect(outcome.deflection).toBeNull();
    },
    RACE_TIMEOUT_MS,
  );

  it(
    'gives one winner to six processes answering the same question at once',
    async () => {
      /**
       * Six rather than two, because a two-way race can be won by luck of scheduling often enough to hide a
       * broken primitive. Every contender here is a TUI answer selecting a *different* option, so the
       * outcome on disk names which process won and a second write would be visible as a changed option
       * rather than merely as an extra file.
       */
      const { run, questionId, reports } = await race([
        { resolver: 'tui', optionId: 'fix' },
        { resolver: 'tui', optionId: 'relax' },
        { resolver: 'tui', optionId: 'hand-back' },
        { resolver: 'web', optionId: 'fix' },
        { resolver: 'web', optionId: 'relax' },
        { resolver: 'web', optionId: 'hand-back' },
      ]);

      expect(reports.filter((report) => report.created)).toHaveLength(1);
      expect(reports.filter((report) => report.accepted)).toHaveLength(1);
      // All six issued their create; five of them lost it. None of them decided by reading first.
      expect(reports.filter((report) => report.contended)).toHaveLength(6);

      const settled = settleQuestion(runPaths(run, home), questionId);
      const selected = settled.state.resolution?.option_id;
      // One of the six answers, whole: never a mix of two, and never overwritten by a later one.
      expect(['fix', 'relax', 'hand-back']).toContain(selected);
      expect(settled.state.resolution?.answer).toBe(selected);

      // Every loser saw the same outcome, so no process is walking around believing a different decision.
      const standing = new Set(reports.map((report) => report.standing));
      expect(standing.size).toBe(1);
      for (const report of reports) expect(report.status).toBe('resolved');
      expect(questionFiles(run, questionId)).toStrictEqual(['outcome.json', 'state.json']);
    },
    RACE_TIMEOUT_MS,
  );

  it(
    'records the race’s one winner in the log exactly once, when the engine next runs',
    async () => {
      /**
       * The other half of the guarantee. The children make the decision durable and append nothing — which
       * is precisely the crash window the durable-write-first ordering creates — so the engine that starts
       * afterwards has to report that decision once and only once, whichever process made it.
       */
      const { run, questionId, reports } = await race([
        { resolver: 'tui', optionId: 'fix' },
        { resolver: 'web', optionId: 'relax' },
      ]);
      const winner = reports.find((report) => report.created)?.resolver;

      // Nothing was logged by the children: the resolution exists only as the claim on disk.
      const before = readEventLog(runPaths(run, home).eventLog).map((event) => event.type);
      expect(before).toContain(QUESTION_EVENT_TYPES.Asked);
      expect(before).not.toContain(QUESTION_EVENT_TYPES.Resolved);

      const reconciler = Reconciler.open({
        orchHome: home,
        executor: createScriptedExecutor({
          onStart: (request) => terminated(request.step, 'completed', { sessionId: 'sess' }),
        }),
        plans: planProvider(makePlan()),
        baseline: createRecordingResetter(BASELINE),
      });
      toClose.push(reconciler);

      await reconciler.pass();
      await reconciler.pass();

      const types = readEventLog(runPaths(run, home).eventLog).map((event) => event.type);
      expect(types.filter((type) => type === QUESTION_EVENT_TYPES.Resolved)).toHaveLength(1);
      expect(types.filter((type) => type === DECISION_EVENT_TYPE)).toHaveLength(1);

      const decisions = decisionsInLog(readEventLog(runPaths(run, home).eventLog));
      expect(decisions[0]?.['resolver']).toBe(winner);
      expect(decisions[0]?.['question_id']).toBe(questionId);
      expect(settleQuestion(runPaths(run, home), questionId).state.resolution?.resolver).toBe(winner);
    },
    RACE_TIMEOUT_MS,
  );
});
