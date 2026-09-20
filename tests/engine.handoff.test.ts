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
  DECLARED_FAILURE_ATTEMPT_LIMIT,
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
    expect(fixtureGit(worktree.dir, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe(outcome.branch);
    expect(fixtureGit(worktree.dir, ['show', `${outcome.branch}:src/half-done.ts`])).toContain('halfDone');
    expect(fixtureGit(worktree.dir, ['status', '--porcelain'])).toBe('');
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
    // Nothing was left to commit the second time, and nothing was duplicated.
    expect(second.preserved).toBe(false);
    expect(Number(fixtureGit(worktree.dir, ['rev-list', '--count', 'HEAD']))).toBe(2);
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
          branch: `${TAKEOVER_BRANCH_PREFIX}${RUN}`,
          commit: BASELINE,
          preserved: true,
          detail: `The partial work is committed on the branch ${TAKEOVER_BRANCH_PREFIX}${RUN}.`,
          failure: null,
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
          branch: `${TAKEOVER_BRANCH_PREFIX}${RUN}`,
          commit: BASELINE,
          preserved: true,
          detail: `The partial work is committed on the branch ${TAKEOVER_BRANCH_PREFIX}${RUN}.`,
          failure: null,
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
}): Reconciler => {
  const reconciler = Reconciler.open({
    orchHome: home,
    executor: createScriptedExecutor(options.script),
    plans: planProvider(makePlan({ feature: 'refund-flow', worktree: options.worktree })),
    baseline: createRecordingResetter(BASELINE),
    worktreeGit: fixtureWorktreeGit,
  });
  toClose.push(reconciler);
  return reconciler;
};

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
    expect(fixtureGit(worktree.dir, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe(branch);
    // The work is on the branch, which is the whole of "the work is never discarded".
    expect(fixtureGit(worktree.dir, ['show', `${branch}:src/partial.ts`])).toContain('half done');

    const document = readFileSync(runPaths(accepted.run, home).handoffDocument, 'utf8');
    expect(document).toContain(branch);
    expect(document).toContain('refund-flow');
    expect(state.handoff?.code).toBe('user.take_over');

    // Halted: no later pass picks it up.
    const after = await reconciler.pass();
    expect(after.actions).toStrictEqual([]);
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
    expect(state.steps[0]?.attempts).toBe(DECLARED_FAILURE_ATTEMPT_LIMIT);

    const path = runPaths(accepted.run, home).handoffDocument;
    expect(existsSync(path)).toBe(true);
    const document = readFileSync(path, 'utf8');
    expect(document).toContain('refund-flow');
    expect(document).toContain(`failed on all ${String(DECLARED_FAILURE_ATTEMPT_LIMIT)} attempts`);
    expect(document).not.toMatch(/\n\s+at\s+\S+\s*\(/);

    // Never a retry loop: the run is terminal and no later pass acts.
    const after = await reconciler.pass();
    expect(after.actions).toStrictEqual([]);
  });
});
