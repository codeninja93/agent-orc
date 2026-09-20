/**
 * The shared fixture the engine suites drive: an `ORCH_HOME`, a feature plan, and a real git worktree
 * for the cases where AD-26's identical-effect claim has to be observed rather than asserted.
 *
 * It lives in one place so the reconciler suite and the crash-injection suite drive *the same* plan.
 * The crash suite compares an interrupted run against an uninterrupted one, and two fixtures that
 * drifted apart would make that comparison meaningless.
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { makeError } from '../../src/contracts/index.js';
import { createScriptedExecutor, terminated } from '../../src/engine/index.js';
import type { FeaturePlan, PlanStep, StepExecutor } from '../../src/engine/index.js';

/** The two-step plan: one implementation step, then one verification gate (CAP-13). */
export const DEFAULT_PLAN_STEPS: readonly PlanStep[] = [
  { step: 'implement', contract_id: 'step.output', phase: 'implementation' },
  { step: 'verify', contract_id: 'step.output', phase: 'verification' },
];

export const makePlan = (overrides: Partial<FeaturePlan> = {}): FeaturePlan => ({
  feature: 'engine-reconciler',
  mode: 'live',
  territory: ['src/engine'],
  steps: DEFAULT_PLAN_STEPS,
  request: 'add a reconciler loop that advances a feature by one action per pass',
  acceptance_criteria: [
    'the loop takes at most one action per pass',
    'a restart converges on the same state',
  ],
  starting_model_tier: 'claude-haiku-4-5',
  worktree: '/tmp/no-worktree-needed',
  ...overrides,
});

/** A plan provider over a fixed set of plans, keyed by feature slug as the reconciler looks them up. */
export const planProvider = (...plans: readonly FeaturePlan[]): ((feature: string) => FeaturePlan) => {
  const byFeature = new Map(plans.map((plan) => [plan.feature, plan]));
  return (feature: string): FeaturePlan => {
    const found = byFeature.get(feature);
    if (found === undefined) {
      throw new Error(`No declared plan for feature "${feature}" in this fixture.`);
    }
    return found;
  };
};

export const makeHome = (label: string): string => mkdtempSync(join(tmpdir(), `orch-${label}-`));

/**
 * Run `git` in a repository with a pinned identity and no user configuration.
 *
 * `GIT_CONFIG_GLOBAL` and `GIT_CONFIG_SYSTEM` are neutralised so a developer's own `commit.gpgsign`,
 * hooks or template directory cannot make the fixture behave differently on their machine than in CI.
 */
export const fixtureGit = (repo: string, args: readonly string[]): string =>
  execFileSync('git', ['-C', repo, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Fixture',
      GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
      GIT_COMMITTER_NAME: 'Fixture',
      GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_SYSTEM: '/dev/null',
    },
  }).trim();

/** Commit whatever is in the worktree, as a step subprocess does with its own work. */
export const fixtureCommit = (repo: string, message: string): string => {
  fixtureGit(repo, ['add', '-A']);
  fixtureGit(repo, ['commit', '-m', message]);
  return fixtureGit(repo, ['rev-parse', 'HEAD']);
};

/** How many commits the branch holds. The sharpest test for an effect applied twice. */
export const fixtureCommitCount = (repo: string): number =>
  Number(fixtureGit(repo, ['rev-list', '--count', 'HEAD']));

export interface GitWorktree {
  readonly dir: string;
  /** The commit the single initial file was committed at, which a step records as its baseline. */
  readonly head: string;
  /** Write a file, as a step's edits would. */
  readonly write: (name: string, content: string) => void;
  /** Read a file, or `null` when it is absent. */
  readonly read: (name: string) => string | null;
  /** Every tracked and untracked path, sorted: the whole observable state of the worktree. */
  readonly listing: () => readonly string[];
}

/**
 * A real single-commit git repository.
 *
 * AD-26's claim is that a step re-run from one baseline leaves the same worktree state and does not
 * double its effects. That is a claim about `git reset --hard` plus `git clean -fd` on a real
 * repository, so a double would be invisible to a fake resetter — the fixture has to be real.
 */
export const makeGitWorktree = (label: string): GitWorktree => {
  const dir = mkdtempSync(join(tmpdir(), `orch-worktree-${label}-`));
  fixtureGit(dir, ['init', '--initial-branch', 'main']);
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src', 'existing.ts'), 'export const existing = 1;\n', 'utf8');
  writeFileSync(join(dir, '.gitignore'), 'ignored-cache/\n', 'utf8');
  fixtureGit(dir, ['add', '-A']);
  fixtureGit(dir, ['commit', '-m', 'initial']);

  return {
    dir,
    head: fixtureGit(dir, ['rev-parse', 'HEAD']),
    write: (name: string, content: string): void => {
      const target = join(dir, name);
      mkdirSync(join(target, '..'), { recursive: true });
      writeFileSync(target, content, 'utf8');
    },
    read: (name: string): string | null => {
      try {
        return readFileSync(join(dir, name), 'utf8');
      } catch {
        return null;
      }
    },
    listing: (): readonly string[] =>
      fixtureGit(dir, ['ls-files', '--cached', '--others', '--exclude-standard'])
        .split('\n')
        .filter((line) => line !== '')
        .sort(),
  };
};

// -------------------------------------------------------------------------------------------------
// The crash-injection fixture
// -------------------------------------------------------------------------------------------------

/**
 * The plan the crash-injection suite drives, in the child and in the restarting parent alike.
 *
 * Shared rather than duplicated because the suite's whole claim is that an interrupted run converges on
 * the same state as an uninterrupted one. Two plans that had drifted apart would make that comparison
 * compare nothing.
 */
export const crashFixturePlan = (worktree: string): FeaturePlan =>
  makePlan({
    feature: 'crash-injection',
    worktree,
    steps: [
      { step: 'implement', contract_id: 'step.output', phase: 'implementation' },
      { step: 'verify', contract_id: 'step.output', phase: 'verification' },
    ],
  });

/**
 * The ledger a step appends its name to. Appending rather than overwriting is what makes a doubled
 * effect *visible*: a re-run that skipped its baseline reset leaves the step's name in here twice.
 */
export const EFFECTS_LEDGER = 'EFFECTS.txt';

/**
 * A deterministic executor whose behaviour depends only on durable state, and whose effects are real.
 *
 * Two properties, and both are load-bearing for the crash-injection suite.
 *
 * **Deterministic across a restart.** A script that failed "the first time" by counting in memory would
 * behave differently after a restart, because the counter dies with the process — and the comparison
 * would then be between two different runs rather than between an interrupted run and an uninterrupted
 * one. `request.attempt` is folded from the log, so keying off it makes the script a function of the
 * durable truth: it says the same thing to the tenth restart as to the first.
 *
 * **Effects that depend on the step, not the attempt.** The file contents and the ledger line are the
 * same on every attempt, which is what an idempotent step means. So the worktree an interrupted run
 * leaves is byte-comparable with the worktree an uninterrupted one leaves — and a missing baseline reset
 * shows up as a duplicated ledger line or an extra commit rather than as a test that cannot tell.
 *
 * The step commits its own work, as the run-flow diagram has it: that is what gives each step a distinct
 * `baseline_ref` and stops a re-run of a later step discarding an earlier step's work.
 *
 * `implement` failing once buys coverage of the routed paths — the AD-35 retry, the AD-26 baseline reset
 * and the re-run — so the kills land on those transitions too, not only on a happy path.
 */
export const crashFixtureExecutor = (): StepExecutor =>
  createScriptedExecutor({
    sessionIdFor: (request) => `sess-${request.step}-${String(request.attempt)}`,
    onStart: (request) => {
      // The step's effects. Identical on every attempt, and committed, as a real step subprocess does.
      writeFileSync(
        join(request.worktree, 'src', `${request.step}.ts`),
        `export const ${request.step} = true;\n`,
        'utf8',
      );
      appendFileSync(join(request.worktree, EFFECTS_LEDGER), `${request.step}\n`, 'utf8');
      fixtureCommit(request.worktree, `step ${request.step}`);

      if (request.step === 'implement' && request.attempt === 1) {
        return terminated(request.step, 'failed', {
          error: makeError('step.timed_out', 'the first attempt always times out in this fixture'),
        });
      }
      return terminated(request.step, 'completed', {
        sessionId: `sess-${request.step}-${String(request.attempt)}`,
      });
    },
  });
