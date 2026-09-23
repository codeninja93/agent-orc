/**
 * Matrix 16, 17 and 20 — the run-start branch-protection assertion, and the writes this story does not
 * perform.
 *
 * **Three outcomes, asserted as three.** ADR-001 requires branch protection on the default branch to be
 * asserted at run start. The failure mode is not "the assertion is missing" — it is an assertion that
 * cannot be made being reported as one that was: a repository with no remote, or a host the engine
 * cannot reach, has no answer, and "unknown" reads identically to "protected" on every surface unless
 * something insists on the difference. A test asserting only that nothing was thrown would pass on
 * exactly that bug, so every case below names the outcome it expects and every unknown is asserted to be
 * unknown rather than merely non-fatal.
 *
 * **And the writes.** AD-15 makes `git push`, pull-request creation and git notes engine-executed write
 * intents; story 2-11 owns the executor, along with the rule that a `write.attempted` record carrying the
 * idempotency key is durable *before* the call is made. This story composes intents and performs none, so
 * the last suite holds the whole of `src/` to that — by the invocations it does not contain and by the
 * two event types nothing yet emits.
 */
import { readFileSync, readdirSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  BRANCH_PROTECTION_ASSERTED_EVENT_TYPE,
  BRANCH_PROTECTION_NOT_CONFIGURED,
  BRANCH_PROTECTION_OUTCOMES,
  BRANCH_PROTECTION_PAYLOAD_KEYS,
  BranchProtectionRefused,
  Reconciler,
  assertBranchProtection,
  checkBranchProtection,
  createScriptedExecutor,
  terminated,
} from '../src/engine/index.js';
import type { BranchProtectionProbe, BranchProtectionRequest } from '../src/engine/index.js';
import { readEventLog, runPaths } from '../src/runtime/index.js';

import { makeHome, makePlan, planProvider } from './helpers/engine-fixture.js';

const REPOSITORY = '/tmp/orch-protection-fixture-not-a-repository';
const REMOTE = 'git@github.com:example/repo.git';

const answering = (answer: boolean | null): BranchProtectionProbe => () => answer;

describe('branch protection has three outcomes, and unknown is one of them (matrix 16)', () => {
  it('declares exactly the three', () => {
    expect([...BRANCH_PROTECTION_OUTCOMES]).toStrictEqual(['protected', 'unprotected', 'unknown']);
  });

  it('answers protected when the host says the branch is protected', () => {
    const report = checkBranchProtection({
      repositoryPath: REPOSITORY,
      remote: REMOTE,
      branch: 'main',
      probe: answering(true),
    });
    expect(report.outcome).toBe('protected');
    expect(report.branch).toBe('main');
    expect(report.reason).toContain('main');
  });

  it('answers unprotected when the host says it is not', () => {
    const report = checkBranchProtection({
      repositoryPath: REPOSITORY,
      remote: REMOTE,
      branch: 'main',
      probe: answering(false),
    });
    expect(report.outcome).toBe('unprotected');
    expect(report.branch).toBe('main');
  });

  /**
   * The four ways an assertion cannot be made, each asserted to be *unknown* by name.
   *
   * Written as four cases and not one, because they fail at four different points and a single case
   * would leave three of them free to answer `protected` — which is the one direction that cannot be
   * recovered from, since the run then proceeds under a guarantee nobody checked.
   */
  it.each([
    [
      'a repository with no remote',
      { repositoryPath: REPOSITORY, remote: '', branch: 'main', probe: answering(true) },
      'no remote',
    ],
    [
      'a repository recording no default branch',
      // Not a git repository at all, so `refs/remotes/origin/HEAD` cannot be read. The probe answers
      // `true`, so a result of `protected` here would mean the branch was never identified and the
      // answer came back about nothing.
      { repositoryPath: REPOSITORY, remote: REMOTE, probe: answering(true) },
      'no default branch',
    ],
    [
      'a host the engine cannot reach',
      {
        repositoryPath: REPOSITORY,
        remote: REMOTE,
        branch: 'main',
        probe: (): boolean => {
          throw new Error('getaddrinfo ENOTFOUND github.com');
        },
      },
      'could not be reached',
    ],
    [
      'a host that did not say',
      { repositoryPath: REPOSITORY, remote: REMOTE, branch: 'main', probe: answering(null) },
      'did not say',
    ],
  ])('reports %s as unknown, never as satisfied', (_case, request, expected) => {
    const report = checkBranchProtection(request);
    expect(report.outcome).toBe('unknown');
    expect(report.outcome).not.toBe('protected');
    expect(report.reason).toContain(expected);
  });

  it('reports an engine with no probe configured as unknown, and says nothing asked', () => {
    const report = checkBranchProtection({
      repositoryPath: REPOSITORY,
      remote: REMOTE,
      branch: 'main',
    });
    expect(report.outcome).toBe('unknown');
    expect(report.reason).toContain('no host probe is configured');
    // And the engine-level constant says the same thing for the same reason, rather than being
    // synthesised from a request with an empty remote — which answers the right outcome for the wrong
    // reason and tells a person their repository has no remote when in fact nothing asked.
    expect(BRANCH_PROTECTION_NOT_CONFIGURED.outcome).toBe('unknown');
    expect(BRANCH_PROTECTION_NOT_CONFIGURED.reason).toContain('never as satisfied');
  });

  it('never throws, so the three outcomes are answers and not error handling', () => {
    expect(() =>
      checkBranchProtection({ repositoryPath: REPOSITORY, remote: '', probe: answering(false) }),
    ).not.toThrow();
  });
});

describe('an unprotected default branch refuses the run, naming what to change (matrix 17)', () => {
  it('refuses, and the refusal names the branch, the remote and the setting', () => {
    let refusal: BranchProtectionRefused | null = null;
    try {
      assertBranchProtection({
        repositoryPath: REPOSITORY,
        remote: REMOTE,
        branch: 'main',
        probe: answering(false),
      });
    } catch (error) {
      refusal = error instanceof BranchProtectionRefused ? error : null;
    }
    expect(refusal).not.toBeNull();
    expect(refusal?.code).toBe('write.branch_protection_violation');
    expect(refusal?.branch).toBe('main');
    expect(refusal?.message).toContain('main');
    expect(refusal?.message).toContain(REMOTE);
    expect(refusal?.message).toContain('Enable branch protection');
  });

  it.each([true, null])('does not refuse when the probe answers %s', (answer) => {
    const report = assertBranchProtection({
      repositoryPath: REPOSITORY,
      remote: REMOTE,
      branch: 'main',
      probe: answering(answer),
    });
    // The judgement stated in the module: only a demonstrated failure refuses. Refusing every
    // repository the engine cannot reach would stop an offline machine running at all.
    expect(report.outcome).toBe(answer === true ? 'protected' : 'unknown');
  });
});

describe('the assertion is taken at run start and recorded against the run (matrix 16, 17)', () => {
  const engine = (
    branchProtection: BranchProtectionRequest | null,
  ): { readonly reconciler: Reconciler; readonly home: string } => {
    const home = makeHome('protection');
    return {
      home,
      reconciler: Reconciler.open({
        orchHome: home,
        plans: planProvider(makePlan()),
        executor: createScriptedExecutor({
          onStart: (request) => terminated(request.step, 'completed', {}),
        }),
        baseline: { currentRef: () => 'a'.repeat(40), resetTo: () => undefined },
        branchProtection,
      }),
    };
  };

  const protectionLine = (
    home: string,
    run: string,
  ): Record<string, unknown> | undefined =>
    readEventLog(runPaths(run, home).eventLog).find(
      (event) => event.type === BRANCH_PROTECTION_ASSERTED_EVENT_TYPE,
    )?.payload;

  it('refuses to start a run whose default branch is unprotected', () => {
    const { reconciler } = engine({
      repositoryPath: REPOSITORY,
      remote: REMOTE,
      branch: 'main',
      probe: answering(false),
    });
    try {
      expect(() => reconciler.acceptFeature(makePlan())).toThrow(BranchProtectionRefused);
    } finally {
      reconciler.close();
    }
  });

  it('starts a run whose protection is unknown, and records it as unknown', () => {
    const { reconciler, home } = engine({
      repositoryPath: REPOSITORY,
      remote: '',
      probe: answering(true),
    });
    try {
      const accepted = reconciler.acceptFeature(makePlan());
      const payload = protectionLine(home, accepted.run);
      expect(payload?.[BRANCH_PROTECTION_PAYLOAD_KEYS.Outcome]).toBe('unknown');
      // Not merely "did not fail": the line says which branch it is about (none could be identified)
      // and why, so a person reading the log can tell an unasked question from an answered one.
      expect(payload?.[BRANCH_PROTECTION_PAYLOAD_KEYS.Branch]).toBeNull();
      expect(String(payload?.[BRANCH_PROTECTION_PAYLOAD_KEYS.Reason])).toContain('no remote');
    } finally {
      reconciler.close();
    }
  });

  it('records unknown for an engine handed no assertion at all, rather than nothing', () => {
    const { reconciler, home } = engine(null);
    try {
      const accepted = reconciler.acceptFeature(makePlan());
      expect(protectionLine(home, accepted.run)?.[BRANCH_PROTECTION_PAYLOAD_KEYS.Outcome]).toBe(
        'unknown',
      );
    } finally {
      reconciler.close();
    }
  });

  it('records protected when the host says so, so the unknown cases mean something', () => {
    const { reconciler, home } = engine({
      repositoryPath: REPOSITORY,
      remote: REMOTE,
      branch: 'main',
      probe: answering(true),
    });
    try {
      const accepted = reconciler.acceptFeature(makePlan());
      const payload = protectionLine(home, accepted.run);
      expect(payload?.[BRANCH_PROTECTION_PAYLOAD_KEYS.Outcome]).toBe('protected');
      expect(payload?.[BRANCH_PROTECTION_PAYLOAD_KEYS.Branch]).toBe('main');
    } finally {
      reconciler.close();
    }
  });
});

// -------------------------------------------------------------------------------------------------
// Matrix 20 — the executor is story 2-11's, and nothing here performs a write
// -------------------------------------------------------------------------------------------------

const stripComments = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

/** Git subcommands that write somewhere this process does not own. */
const WRITING_SUBCOMMANDS = ['push', 'notes', 'tag'];

/** Ways of creating a pull request, none of which is a git subcommand. */
const PULL_REQUEST_CALLS = [/\bgh\b[^\n]{0,40}\bpr\b/i, /api\.github\.com/i, /\/pulls\b/];

/** The two AD-15 lines story 2-11 introduces; nothing may emit either yet. */
const EXECUTOR_EVENT_TYPES = ['write.attempted', 'write.executed'];

interface PerformedWrite {
  readonly signal: string;
  readonly evidence: string;
}

/**
 * Where a source *performs* one of the three writes this story only composes.
 *
 * The signals are invocations and emissions, not names: a subcommand handed to a child process, a
 * pull-request API reached over the network, and the two event types whose whole purpose is to record a
 * write being attempted. The last is the sharpest of the three — AD-15 fixes the durability order, so
 * the executor cannot exist without emitting `write.attempted`, and a build in which nothing emits it is
 * a build in which nothing executes an intent.
 *
 * `src/contracts/event.ts` declares the vocabulary and is exempt from that last signal alone: declaring
 * a type is not emitting one, and the vocabulary has carried both names since story 1-1.
 */
export const performedWritesIn = (file: string, source: string): readonly PerformedWrite[] => {
  const stripped = stripComments(source);
  const found: PerformedWrite[] = [];
  for (const subcommand of WRITING_SUBCOMMANDS) {
    if (new RegExp(`(['"\`])${subcommand}\\1`).test(stripped)) {
      found.push({ signal: 'git-subcommand', evidence: subcommand });
    }
  }
  for (const call of PULL_REQUEST_CALLS) {
    const match = call.exec(stripped);
    if (match !== null) found.push({ signal: 'pull-request-call', evidence: match[0] });
  }
  if (file !== 'contracts/event.ts') {
    for (const type of EXECUTOR_EVENT_TYPES) {
      if (stripped.includes(`'${type}'`) || stripped.includes(`"${type}"`)) {
        found.push({ signal: 'executor-event', evidence: type });
      }
    }
  }
  return found;
};

describe('the engine performs no push, pull request or note write (matrix 20)', () => {
  const sourceRoot = new URL('../src/', import.meta.url);
  const files = readdirSync(sourceRoot, { recursive: true })
    .filter((name): name is string => typeof name === 'string' && name.endsWith('.ts'))
    .sort();

  it('sweeps the whole of src/ recursively, not only src/engine/', () => {
    // AD-15 binds every unit, not the engine alone, and the write that matters would be as damaging
    // from `src/runner/` or `src/pool/` — both of which already run git.
    expect(files.length).toBeGreaterThan(50);
    expect(files.some((file) => file.split('/').length >= 3)).toBe(true);
    expect(files).toContain('pool/worktree.ts');
    expect(files).toContain('engine/committer.ts');
  });

  it('finds none anywhere under src/', () => {
    const offenders = new Map<string, readonly PerformedWrite[]>();
    for (const file of files) {
      const performed = performedWritesIn(file, readFileSync(new URL(file, sourceRoot), 'utf8'));
      if (performed.length > 0) offenders.set(file, performed);
    }
    expect(
      [...offenders.entries()].map(([file, writes]) => `${file}: ${JSON.stringify(writes)}`),
    ).toStrictEqual([]);
  });

  /**
   * The positive control. Without it, "no violations" is satisfied by a detector that matches nothing —
   * which is how an absence assertion passes against a renamed constant or a typo in a regex.
   */
  it.each([
    ['engine/executor.ts', "execFileSync('git', ['push', '--set-upstream', remote, branch]);"],
    ['engine/committer.ts', "await run('gh', ['pr', 'create', '--title', title]);"],
    ['runner/pulls.ts', "await fetch('https://api.github.com/repos/o/r/pulls', { method: 'POST' });"],
    ['engine/labels.ts', "execFileSync('git', ['notes', '--ref', NOTE_REF, 'add', '-m', body]);"],
    ['engine/intents.ts', "recorder.append({ type: 'write.attempted', payload: { key } });"],
  ])('catches the write planted in %s', (file, source) => {
    expect(performedWritesIn(file, source).length).toBeGreaterThan(0);
  });

  it('does not read a declaration of the vocabulary as an emission of it', () => {
    // `src/contracts/event.ts` has carried both names since story 1-1, and it is the file that must.
    expect(performedWritesIn('contracts/event.ts', "const t = ['write.attempted'];")).toStrictEqual(
      [],
    );
    expect(
      performedWritesIn('engine/intents.ts', "const t = ['write.attempted'];").length,
    ).toBeGreaterThan(0);
  });
});
