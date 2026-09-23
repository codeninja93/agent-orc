/**
 * CAP-23 — the escape hatch and the hand-off document.
 *
 * Two claims are tested here, and they need very different evidence.
 *
 * "The partial work is on an ordinary branch" is a claim about **git**, so the escape-hatch tests drive a
 * real repository: a fake could not tell a branch that holds the work from one that does not, which is
 * the only thing worth knowing.
 *
 * "The document reads as a colleague's note rather than a stack trace" is a claim about **register**, and
 * a register is not assertable by matching one string. What is assertable is the shape of the thing: the
 * four questions a person having a bad day needs answered, in prose, with the feature named rather than a
 * run id, with what was verified *and what was not*, and with none of the tells of a dumped exception.
 */
import { existsSync, readFileSync, rmSync } from 'node:fs';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { makeError } from '../src/contracts/index.js';
import type { StepRecord } from '../src/contracts/index.js';
import { REDACTION_MARKER, runPaths } from '../src/runtime/index.js';
import {
  DECLARED_STEP_ATTEMPT_LIMIT,
  Reconciler,
  TAKEOVER_BRANCH_PREFIX,
  createRecordingResetter,
  createScriptedExecutor,
  escapeHatch,
  renderHandoffDocument,
  takeoverBranchFor,
  terminated,
} from '../src/engine/index.js';
import type { HandoffBrief, ScriptedExecutorOptions, WorktreeGit } from '../src/engine/index.js';

import { fixtureGit, makeGitWorktree, makeHome, makePlan, planProvider } from './helpers/engine-fixture.js';
import type { GitWorktree } from './helpers/engine-fixture.js';

const BASELINE = 'ddd9bed4d286ac1f8a0f4f7bfef9530046605787';
const RUN = '01K5NQ9ZJ7V3M2P9XQWRTC4BDE';

let home: string;
const toRemove: string[] = [];
const toClose: Reconciler[] = [];

beforeEach(() => {
  home = makeHome('engine-handoff');
  toRemove.push(home);
});

afterEach(() => {
  for (const reconciler of toClose.splice(0)) reconciler.close();
  for (const dir of toRemove.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const freshWorktree = (label: string): GitWorktree => {
  const worktree = makeGitWorktree(label);
  toRemove.push(worktree.dir);
  return worktree;
};

/** The environment-pinned git the fixture uses, so a developer's own config cannot change the result. */
const fixtureWorktreeGit: WorktreeGit = (worktree, args) => {
  try {
    return { status: 0, stdout: fixtureGit(worktree, args), stderr: '' };
  } catch (thrown: unknown) {
    const error = thrown as { status?: number; stderr?: Buffer | string } | null;
    const stderr = error?.stderr;
    return {
      status: typeof error?.status === 'number' ? error.status : 1,
      stdout: '',
      stderr: typeof stderr === 'string' ? stderr : (stderr?.toString('utf8') ?? 'git failed'),
    };
  }
};

describe('the escape hatch leaves partial work on an ordinary branch', () => {
  it('commits uncommitted work onto a branch named from the run id', () => {
    const worktree = freshWorktree('escape');
    worktree.write('src/half-done.ts', 'export const halfDone = true;\n');

    const outcome = escapeHatch({
      run: RUN,
      feature: 'engine-reconciler',
      worktree: worktree.dir,
      git: fixtureWorktreeGit,
    });

    expect(outcome.failure).toBeNull();
    expect(outcome.preserved).toBe(true);
    expect(outcome.branch).toBe(`${TAKEOVER_BRANCH_PREFIX}${RUN}`);
    expect(outcome.commit).toMatch(/^[0-9a-f]{40}$/);

    // The claim is that the work is *on the branch*, so it is read off the branch rather than off disk.
    expect(fixtureGit(worktree.dir, ['show', `${outcome.branch}:src/half-done.ts`])).toContain('halfDone');
    expect(fixtureGit(worktree.dir, ['status', '--porcelain'])).toBe('');
    /**
     * And the worktree is put back where it was, once the work is safe.
     *
     * Story 1-6 gives a run's worktree its own `orch/run/<run-id>` branch and reclaims it by that name, so
     * a worktree abandoned on `orch/takeover/<run-id>` is a worktree its own pool no longer recognises.
     * The branch is read back out of git rather than spelled here, which is why this reads `main`.
     */
    expect(outcome.restoredBranch).toBe('main');
    expect(fixtureGit(worktree.dir, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('main');
  });

  it('derives the branch from the run id and never from the feature slug (AD-22)', () => {
    const worktree = freshWorktree('branch-name');
    worktree.write('src/half-done.ts', 'export const halfDone = true;\n');

    const outcome = escapeHatch({
      run: RUN,
      feature: 'payments-refund-flow',
      worktree: worktree.dir,
      git: fixtureWorktreeGit,
    });

    expect(outcome.branch).toContain(RUN);
    // AD-22 gives the committer sole ownership of feature-branch naming: no other unit may infer one.
    expect(outcome.branch).not.toContain('payments-refund-flow');
    expect(outcome.branch.startsWith('feature/')).toBe(false);
    expect(fixtureGit(worktree.dir, ['branch', '--list'])).not.toContain('payments');
  });

  it('adopts an existing branch rather than refusing, so a repeated hand-off is safe', () => {
    const worktree = freshWorktree('idempotent');
    worktree.write('src/half-done.ts', 'export const halfDone = true;\n');

    const first = escapeHatch({ run: RUN, feature: 'f', worktree: worktree.dir, git: fixtureWorktreeGit });
    const second = escapeHatch({ run: RUN, feature: 'f', worktree: worktree.dir, git: fixtureWorktreeGit });

    expect(first.failure).toBeNull();
    expect(second.failure).toBeNull();
    expect(second.branch).toBe(first.branch);
    // Nothing was left to commit the second time, and nothing was duplicated. Counted on the *branch*
    // rather than on HEAD, because the worktree is returned to the branch it came from once the work is
    // safe — so HEAD is no longer the take-over branch by the time this runs.
    expect(second.preserved).toBe(false);
    expect(Number(fixtureGit(worktree.dir, ['rev-list', '--count', second.branch]))).toBe(2);
  });

  it('still produces the branch when there was nothing uncommitted to save', () => {
    const worktree = freshWorktree('clean');
    const outcome = escapeHatch({ run: RUN, feature: 'f', worktree: worktree.dir, git: fixtureWorktreeGit });

    expect(outcome.failure).toBeNull();
    expect(outcome.preserved).toBe(false);
    expect(outcome.commit).toBe(worktree.head);
    expect(outcome.detail).toContain('no uncommitted work');
  });

  it('never discards the work when git will not cooperate, and never loops on it', () => {
    // A directory that is not a repository at all: every git call fails.
    const notARepo = makeHome('not-a-repo');
    toRemove.push(notARepo);

    const outcome = escapeHatch({ run: RUN, feature: 'f', worktree: notARepo, git: fixtureWorktreeGit });
    expect(outcome.failure).not.toBeNull();
    expect(outcome.preserved).toBe(false);
    // The document has to be able to say where the work is, even when it is only "still in the worktree".
    expect(outcome.detail).toContain(notARepo);
  });

  it('refuses a run id that could escape the branch namespace', () => {
    expect(() => takeoverBranchFor('../evil')).toThrowError();
  });

  /**
   * A git that fails at **one** subcommand, which is the failure the suite had no way to reach.
   *
   * The one failing-git test above points at a directory that is not a repository, so the very first
   * `git status` fails and `escapeHatch` returns before any other branch is entered. Two branches were
   * therefore unreachable — the `checkout` failure and the `commit` failure — and the second is the one
   * that matters: a failed commit used to fall through to the *success* return, reporting
   * `preserved: true`, `failure: null` and a detail saying the work was committed on the branch. Combined
   * with the document's ungated `git checkout` line, a take-over whose commit failed told a person their
   * work was on a branch that holds nothing.
   */
  const gitFailingAt = (
    subcommand: string,
    message: string,
  ): { readonly git: WorktreeGit; readonly calls: readonly (readonly string[])[] } => {
    const calls: (readonly string[])[] = [];
    const git: WorktreeGit = (worktree, args) => {
      calls.push(args);
      // `-c user.name=…` precedes the subcommand, so the match is on membership rather than on args[0].
      if (args.includes(subcommand)) return { status: 1, stdout: '', stderr: message };
      return fixtureWorktreeGit(worktree, args);
    };
    return { git, calls };
  };

  it('reports a failed checkout as a failure, with the work still in the worktree', () => {
    const worktree = freshWorktree('checkout-fails');
    worktree.write('src/half-done.ts', 'export const halfDone = true;\n');
    const { git } = gitFailingAt('checkout', 'fatal: a branch named that already exists elsewhere');

    const outcome = escapeHatch({ run: RUN, feature: 'f', worktree: worktree.dir, git });

    expect(outcome.failure).toContain('already exists elsewhere');
    expect(outcome.preserved).toBe(false);
    expect(outcome.commit).toBeNull();
    expect(outcome.detail).toContain(worktree.dir);
    expect(outcome.detail).toContain('uncommitted and untouched');
    // Nothing was committed and nothing was lost: the file is still there, still uncommitted.
    expect(worktree.read('src/half-done.ts')).toContain('halfDone');
    expect(fixtureGit(worktree.dir, ['status', '--porcelain'])).not.toBe('');
  });

  it('reports a failed commit as a failure, and never as preserved work on a branch', () => {
    const worktree = freshWorktree('commit-fails');
    worktree.write('src/half-done.ts', 'export const halfDone = true;\n');
    const { git } = gitFailingAt('commit', 'error: cannot run .git/hooks/pre-commit: permission denied');

    const outcome = escapeHatch({ run: RUN, feature: 'f', worktree: worktree.dir, git });

    // The three fields every reader branches on, all of them honest.
    expect(outcome.failure).toContain('pre-commit');
    expect(outcome.preserved).toBe(false);
    expect(outcome.commit).toBeNull();
    // And the sentence the document quotes says where the work *is*, not where it would have been.
    expect(outcome.detail).toContain(worktree.dir);
    expect(outcome.detail).toContain('could not be committed');
    expect(outcome.detail).not.toContain('is committed on the branch');
    // Nothing was discarded: the changes are still in the worktree.
    expect(worktree.read('src/half-done.ts')).toContain('halfDone');
  });

  it('never tells a person to check out a branch the escape hatch could not create', () => {
    const worktree = freshWorktree('doc-after-failure');
    worktree.write('src/half-done.ts', 'export const halfDone = true;\n');
    const { git } = gitFailingAt('commit', 'error: pre-commit hook refused');

    const escape = escapeHatch({ run: RUN, feature: 'f', worktree: worktree.dir, git });
    const document = renderHandoffDocument(aBrief({ escape }));

    // CAP-23 is the work surviving, so a document that misdirects is the worst failure it has.
    expect(document).not.toContain(`git checkout ${escape.branch}`);
    expect(document).toContain(worktree.dir);
    expect(document).toContain('Nothing was reverted');
  });

  it('commits with no hooks and with an identity of its own, so a repository without one still saves', () => {
    const worktree = freshWorktree('defences');
    worktree.write('src/half-done.ts', 'export const halfDone = true;\n');
    const calls: (readonly string[])[] = [];
    const git: WorktreeGit = (dir, args) => {
      calls.push(args);
      return fixtureWorktreeGit(dir, args);
    };

    expect(escapeHatch({ run: RUN, feature: 'f', worktree: worktree.dir, git }).failure).toBeNull();

    const commit = calls.find((args) => args.includes('commit'));
    // A `pre-commit` hook protects the *project's* history; this is a throwaway snapshot made so a person
    // does not lose their work, and a hook that vetoes it destroys exactly what CAP-23 exists to keep.
    expect(commit).toContain('--no-verify');
    // An unconfigured `user.email` fails `git commit` outright, in the one commit that must not fail.
    expect(commit?.some((arg) => arg.startsWith('user.name='))).toBe(true);
    expect(commit?.some((arg) => arg.startsWith('user.email='))).toBe(true);
  });
});

// -------------------------------------------------------------------------------------------------
// The document
// -------------------------------------------------------------------------------------------------

const aStep = (overrides: Partial<StepRecord> = {}): StepRecord => ({
  step: 'implement',
  phase: 'implementation',
  contract_id: 'step.output',
  disposition: 'failed',
  session_id: 'sess-implement',
  baseline_ref: BASELINE,
  model_tier: 'claude-haiku-4-5',
  promotions: 0,
  attempts: 3,
  credited_attempts: 0,
  resets: 2,
  started_at: '2026-09-20T10:00:00.000Z',
  terminated_at: '2026-09-20T10:05:00.000Z',
  error: makeError('step.timed_out', 'the test command never returned', 'no output for 20 minutes'),
  ...overrides,
});

const aBrief = (overrides: Partial<HandoffBrief> = {}): HandoffBrief => ({
  run: RUN,
  feature: 'refund-flow',
  state: 'handed_off',
  request: 'let a support agent refund a payment from the order page',
  acceptanceCriteria: [
    'a refund appears on the order within one second',
    'a partial refund is possible',
  ],
  code: 'step.timed_out',
  reason: 'The verification step timed out three times, so I stopped rather than keep trying.',
  steps: [aStep(), aStep({ step: 'verify', phase: 'verification', disposition: null, attempts: 1 })],
  worktree: '/tmp/worktree-refund-flow',
  runDirectory: `/home/deep/.orch/runs/${RUN}`,
  checkpoint: `/home/deep/.orch/runs/${RUN}/state.json`,
  escape: null,
  writtenAt: '2026-09-20T10:06:00.000Z',
  ...overrides,
});

describe('the hand-off document reads as a colleague’s note', () => {
  it('opens with the feature name, not a run id or an error class (R6, R3)', () => {
    const document = renderHandoffDocument(aBrief());
    const firstLine = document.split('\n')[0] ?? '';
    expect(firstLine).toContain('refund-flow');
    expect(firstLine).not.toContain(RUN);
    // The headline stands alone: a person reading only it knows what happened.
    expect(document.split('\n')[2]).toContain('stopped');
  });

  it('answers the four questions a person having a bad day needs answered', () => {
    const document = renderHandoffDocument(aBrief());
    expect(document).toContain('## What I was asked to do');
    expect(document).toContain('## How far it got');
    expect(document).toContain('## Why it stopped');
    expect(document).toContain('## Where the work is');
    expect(document).toContain('## What you might do next');
    // In their own words, not the system's.
    expect(document).toContain('let a support agent refund a payment from the order page');
    expect(document).toContain('a partial refund is possible');
  });

  it('states what was verified and what was not (R8)', () => {
    const document = renderHandoffDocument(aBrief());
    expect(document).toContain('**Nothing was verified.**');
    expect(document).toContain('**Not verified:** verify');

    const withVerification = renderHandoffDocument(
      aBrief({
        steps: [
          aStep({ disposition: 'completed' }),
          aStep({ step: 'verify', phase: 'verification', disposition: 'completed' }),
        ],
      }),
    );
    expect(withVerification).toContain('**Verified:** verify');
  });

  it('describes each step in prose rather than by its enum member', () => {
    const document = renderHandoffDocument(aBrief());
    expect(document).toContain('**implement** — failed on all 3 attempts.');
    expect(document).toContain('**verify** — was still running when everything stopped.');
  });

  it('is not a stack trace', () => {
    const document = renderHandoffDocument(aBrief());
    // The three tells of a dumped exception: frames, a class name, and a bare thrown value.
    expect(document).not.toMatch(/\n\s+at\s+\S+\s*\(/);
    expect(document).not.toContain('Error:');
    expect(document).not.toContain('node_modules');
    expect(document).not.toContain('undefined');
    // What it has instead: the failure explained in the words the step reported.
    expect(document).toContain('the test command never returned');
  });

  it('says where the work is, in terms a person can act on', () => {
    const withoutBranch = renderHandoffDocument(aBrief());
    expect(withoutBranch).toContain('/tmp/worktree-refund-flow');
    expect(withoutBranch).toContain('Nothing was reverted');

    const withBranch = renderHandoffDocument(
      aBrief({
        escape: {
          trigger: 'take-over',
          branch: `${TAKEOVER_BRANCH_PREFIX}${RUN}`,
          commit: BASELINE,
          preserved: true,
          detail: `The partial work is committed on the branch ${TAKEOVER_BRANCH_PREFIX}${RUN}.`,
          failure: null,
          // The worktree was put back where it was once the work was safe on the take-over branch.
          restoredBranch: null,
        },
      }),
    );
    expect(withBranch).toContain(`git checkout ${TAKEOVER_BRANCH_PREFIX}${RUN}`);
    expect(withBranch).toContain(BASELINE);
  });

  it('points at the evidence without making a person read it', () => {
    const document = renderHandoffDocument(aBrief());
    expect(document).toContain('## If you want the detail');
    expect(document).toContain(`/home/deep/.orch/runs/${RUN}`);
    expect(document).toContain('who issued it');
  });

  it('redacts a credential in the free text while keeping the identifiers a person needs', () => {
    const secret = 'sk-ant-api03-ZzQq7t2VhK4mNb9Lp1Rs6Wx3Dg8Eu5Yc';
    const document = renderHandoffDocument(
      aBrief({
        reason: `The deploy step failed because the token ${secret} was rejected.`,
        escape: {
          trigger: 'take-over',
          branch: `${TAKEOVER_BRANCH_PREFIX}${RUN}`,
          commit: BASELINE,
          preserved: true,
          detail: `The partial work is committed on the branch ${TAKEOVER_BRANCH_PREFIX}${RUN}.`,
          failure: null,
          // The worktree was put back where it was once the work was safe on the take-over branch.
          restoredBranch: null,
        },
        steps: [aStep({ error: makeError('step.timed_out', `the token ${secret} was rejected`) })],
      }),
      { secrets: [secret] },
    );

    expect(document).not.toContain(secret);
    expect(document).toContain(REDACTION_MARKER);
    // The pass is applied field by field, so the run id, the branch and the commit survive — the three
    // lines that tell a person where their work is.
    expect(document).toContain(`${TAKEOVER_BRANCH_PREFIX}${RUN}`);
    expect(document).toContain(BASELINE);
  });
});

// -------------------------------------------------------------------------------------------------
// Through a real run
// -------------------------------------------------------------------------------------------------

const openReconciler = (options: {
  readonly script: ScriptedExecutorOptions;
  readonly worktree: string;
  readonly worktreeGit?: WorktreeGit;
}): Reconciler => {
  const reconciler = Reconciler.open({
    orchHome: home,
    executor: createScriptedExecutor(options.script),
    plans: planProvider(makePlan({ feature: 'refund-flow', worktree: options.worktree })),
    baseline: createRecordingResetter(BASELINE),
    worktreeGit: options.worktreeGit ?? fixtureWorktreeGit,
  });
  toClose.push(reconciler);
  return reconciler;
};

/** A run that did some work and then completed its step, which is the state a take-over arrives in. */
const workDoneScript = (worktree: GitWorktree): ScriptedExecutorOptions => ({
  sessionIdFor: (request) => `sess-${request.step}`,
  onStart: (request) => {
    worktree.write('src/partial.ts', `export const ${request.step} = 'half done';\n`);
    return terminated(request.step, 'completed', { sessionId: `sess-${request.step}` });
  },
});

describe('a take-over hands the work to a person', () => {
  it('puts the partial work on the branch, halts the run, and writes the document', async () => {
    const worktree = freshWorktree('take-over');
    const reconciler = openReconciler({
      worktree: worktree.dir,
      script: {
        sessionIdFor: (request) => `sess-${request.step}`,
        onStart: (request) => {
          // A step that did real work and then completed, as one does before a person takes over.
          worktree.write('src/partial.ts', `export const ${request.step} = 'half done';\n`);
          return terminated(request.step, 'completed', { sessionId: `sess-${request.step}` });
        },
      },
    });

    const accepted = reconciler.acceptFeature(
      makePlan({ feature: 'refund-flow', worktree: worktree.dir }),
    );
    reconciler.confirm(accepted.run);
    await reconciler.pass();
    expect(worktree.read('src/partial.ts')).not.toBeNull();

    const state = reconciler.takeOver(accepted.run, { principal: { kind: 'user', id: 'deep' } });

    expect(state.state).toBe('handed_off');
    const branch = takeoverBranchFor(accepted.run);
    // The work is on the branch, which is the whole of "the work is never discarded".
    expect(fixtureGit(worktree.dir, ['show', `${branch}:src/partial.ts`])).toContain('half done');
    // And the worktree is back on its own branch, so story 1-6's pool still recognises it.
    expect(fixtureGit(worktree.dir, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('main');

    const document = readFileSync(runPaths(accepted.run, home).handoffDocument, 'utf8');
    expect(document).toContain(branch);
    expect(document).toContain('refund-flow');
    expect(state.handoff?.code).toBe('user.take_over');

    // Halted: no later pass picks it up.
    const after = await reconciler.pass();
    expect(after.actions).toStrictEqual([]);
  });

  it('never records the work as on a branch when the commit that would put it there failed', async () => {
    /**
     * The recorded reason, not only the document.
     *
     * `handoff.reason` is composed before the escape hatch runs, and it used to assert the work was on a
     * branch. When git failed, only `HANDOFF.md` was corrected: the `command.applied` payload and the
     * checkpoint folded from it kept the claim — in the record AD-4 makes the *only* authority, which is
     * exactly why a false sentence there is worse than one in a file a person can compare against disk.
     */
    const worktree = freshWorktree('take-over-commit-fails');
    const reconciler = openReconciler({
      worktree: worktree.dir,
      script: workDoneScript(worktree),
      worktreeGit: (dir, args) =>
        args.includes('commit')
          ? { status: 1, stdout: '', stderr: 'error: pre-commit hook refused' }
          : fixtureWorktreeGit(dir, args),
    });

    const accepted = reconciler.acceptFeature(
      makePlan({ feature: 'refund-flow', worktree: worktree.dir }),
    );
    reconciler.confirm(accepted.run);
    await reconciler.pass();

    const state = reconciler.takeOver(accepted.run, { principal: { kind: 'user', id: 'deep' } });

    // The run still halts and still hands off: a git failure never loops and never discards.
    expect(state.state).toBe('handed_off');
    expect(state.handoff?.code).toBe('user.take_over');

    const reason = state.handoff?.reason ?? '';
    expect(reason).toContain('could not be committed');
    expect(reason).not.toContain('is committed on the branch');

    // And the document does not send a person to a branch that holds nothing.
    const document = readFileSync(runPaths(accepted.run, home).handoffDocument, 'utf8');
    expect(document).not.toContain(`git checkout ${takeoverBranchFor(accepted.run)}`);
    expect(document).toContain(worktree.dir);

    // The work is still on disk, which is the whole of "the work is never discarded".
    expect(worktree.read('src/partial.ts')).toContain('half done');
  });

  it('quarantines an intent whose effect throws, rather than retrying it on every pass', async () => {
    /**
     * A throwing effect used to escape `consumeIntents` and take the whole run's pass with it — and the
     * file stayed pending, so the next pass threw again, and the next, and every 25ms mid-step poll in
     * between. Nothing was recorded, so the failure was invisible as well as permanent.
     *
     * A `git` port that *throws* rather than returning a non-zero status is the shortest honest way to
     * reach it: `escapeHatch` treats a non-zero status as data and a throw as a fault.
     */
    const worktree = freshWorktree('effect-throws');
    const reconciler = openReconciler({
      worktree: worktree.dir,
      script: workDoneScript(worktree),
      worktreeGit: () => {
        throw new Error('git is not installed on this machine');
      },
    });

    const accepted = reconciler.acceptFeature(
      makePlan({ feature: 'refund-flow', worktree: worktree.dir }),
    );
    reconciler.confirm(accepted.run);
    await reconciler.pass();

    // The caller is told, rather than the pass dying silently.
    expect(() => reconciler.takeOver(accepted.run)).toThrowError(/effect|git is not installed/);

    // Nothing was applied, and the run is where it was.
    expect(reconciler.load(accepted.run).state.state).toBe('running');
    // And the file is gone from `commands/`, so no later pass meets it again.
    const next = await reconciler.pass();
    expect(next.refusals).toStrictEqual([]);
    const again = await reconciler.pass();
    expect(again.steering.flatMap((entry) => entry.refused)).toStrictEqual([]);
  });
});

describe('a run that has failed the declared number of times stops and explains itself', () => {
  it('writes the document, reaches handed_off, and never retries again', async () => {
    const worktree = freshWorktree('repeated-failure');
    const reconciler = openReconciler({
      worktree: worktree.dir,
      script: {
        sessionIdFor: () => null,
        onStart: (request) =>
          terminated(request.step, 'failed', {
            error: makeError('step.timed_out', 'the test command never returned'),
          }),
      },
    });

    const accepted = reconciler.acceptFeature(
      makePlan({ feature: 'refund-flow', worktree: worktree.dir }),
    );
    reconciler.confirm(accepted.run);
    await reconciler.runUntilSettled();

    const state = reconciler.load(accepted.run).state;
    expect(state.state).toBe('handed_off');
    expect(state.steps[0]?.attempts).toBe(DECLARED_STEP_ATTEMPT_LIMIT);

    const path = runPaths(accepted.run, home).handoffDocument;
    expect(existsSync(path)).toBe(true);
    const document = readFileSync(path, 'utf8');
    expect(document).toContain('refund-flow');
    expect(document).toContain(`failed on all ${String(DECLARED_STEP_ATTEMPT_LIMIT)} attempts`);
    expect(document).not.toMatch(/\n\s+at\s+\S+\s*\(/);

    // Never a retry loop: the run is terminal and no later pass acts.
    const after = await reconciler.pass();
    expect(after.actions).toStrictEqual([]);
  });
});
