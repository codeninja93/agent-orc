/**
 * Story 2-11, matrix rows 1–3, 6, 9 — the write executor, driven in isolation.
 * Story 3-2 (AD-27), matrix rows 1–6 — the same performers under `mode: 'shadow'`.
 *
 * `src/engine/write-executor.ts` is the one unit AD-15 lets perform a `git push`, a pull-request creation
 * or a git note: `write.attempted` durable before the call, and a reconciliation check before ever
 * repeating one. Every test here drives the real performers (`performWriteIntent`, `checkPullRequestMerged`)
 * against a fake `git`/`gh` — never a real repository or a real GitHub — so the claim under test is the
 * *shape* of the calls and the *order* of the durable lines, not that a particular host answers a
 * particular way. Under `mode: 'shadow'` the claim is the same probe, never the mutating call: every test
 * in that section asserts the mutating `git push`/`gh pr create`/`git notes add` is never even attempted.
 */
import { describe, expect, it } from 'vitest';

import { WriteIntentSchema } from '../src/contracts/index.js';
import type { EventEnvelope, WriteIntent } from '../src/contracts/index.js';
import {
  NoteMergeCommitUnknown,
  WriteKindNotImplemented,
  checkPullRequestMerged,
  mergeFidelityOf,
  performWriteIntent,
  writeIntentSettled,
} from '../src/engine/index.js';
import type {
  GhCall,
  GitCall,
  WriteCallResult,
  WriteExecutionContext,
} from '../src/engine/index.js';

/** A `git`/`gh` double that records every call and answers from a queue of canned results. */
const recordingGit = (
  handler: (args: readonly string[], cwd: string, input?: string) => WriteCallResult,
): { readonly git: GitCall; readonly calls: (readonly string[])[] } => {
  const calls: (readonly string[])[] = [];
  const git: GitCall = (args, cwd, input) => {
    calls.push(args);
    return handler(args, cwd, input);
  };
  return { git, calls };
};

const recordingGh = (
  handler: (args: readonly string[], cwd: string) => WriteCallResult,
): { readonly gh: GhCall; readonly calls: (readonly string[])[] } => {
  const calls: (readonly string[])[] = [];
  const gh: GhCall = (args, cwd) => {
    calls.push(args);
    return Promise.resolve(handler(args, cwd));
  };
  return { gh, calls };
};

const ok = (stdout = ''): WriteCallResult => ({ status: 0, stdout, stderr: '' });
const failed = (stderr = 'boom'): WriteCallResult => ({ status: 1, stdout: '', stderr });

const intent = (kind: WriteIntent['kind'], target: string, id = `commit.${kind}`): WriteIntent =>
  WriteIntentSchema.parse({
    intent_id: id,
    kind,
    target,
    summary: `${kind} for the test`,
    reversibility: 'irreversible',
  });

/** A minimal AD-22 note; write-executor.ts only ever JSON-serialises it, never validates it. */
const NOTE = {
  schema_version: 1,
  run: '01JBQ8Z1X2Y3W4V5U6T7S8R9Q0',
  feature: 'write-surface',
  branch: 'feature/write-surface',
  steps: [],
  acceptance_criteria: ['a criterion'],
  usage: null,
  decisions: [],
} as const;

const events: { emitted: { readonly type: string; readonly payload: Record<string, unknown> }[] } = {
  emitted: [],
};

const contextFor = (
  overrides: Partial<WriteExecutionContext> & { readonly git?: GitCall; readonly gh?: GhCall },
): WriteExecutionContext => {
  events.emitted = [];
  return {
    run: '01JBQ8Z1X2Y3W4V5U6T7S8R9Q0',
    repository: '/tmp/no-such-worktree',
    pullRequest: { title: 'A title', body: 'A body', head: 'feature/write-surface' },
    note: NOTE as unknown as WriteExecutionContext['note'],
    mergeCommit: null,
    emit: (type: string, payload: Record<string, unknown>): void => {
      events.emitted.push({ type, payload });
    },
    ...overrides,
  };
};

describe('git_push — matrix row 1 (first execution)', () => {
  it('records write.attempted before the call, pushes once, and records write.executed', async () => {
    const { git, calls } = recordingGit((args) => {
      if (args[0] === 'rev-parse') return ok('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n');
      if (args[0] === 'ls-remote') return ok(''); // nothing at that ref yet
      if (args[0] === 'push') return ok();
      throw new Error(`unexpected git call: ${args.join(' ')}`);
    });
    const context = contextFor({ git });

    const result = await performWriteIntent(intent('git_push', 'feature/write-surface'), context);

    expect(result.status).toBe('executed');
    expect(events.emitted.map((event) => event.type)).toStrictEqual(['write.attempted', 'write.executed']);
    expect(events.emitted[0]?.payload['intent_id']).toBe('commit.git_push');
    const pushCalls = calls.filter((args) => args[0] === 'push');
    expect(pushCalls).toHaveLength(1);
    expect(pushCalls[0]?.some((arg) => arg.includes('feature/write-surface'))).toBe(true);
    // Never a force: the shape has no field to ask for one, and this asserts the call never carries it.
    expect(pushCalls[0]?.some((arg) => arg.includes('force'))).toBe(false);
  });
});

describe('git_push — matrix row 2 (crash after write.attempted, before write.executed)', () => {
  it('probes the remote and skips a second push when the tip already matches', async () => {
    const sha = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    const { git, calls } = recordingGit((args) => {
      if (args[0] === 'rev-parse') return ok(`${sha}\n`);
      if (args[0] === 'ls-remote') return ok(`${sha}\trefs/heads/feature/write-surface\n`);
      if (args[0] === 'push') throw new Error('a second push must never be attempted');
      throw new Error(`unexpected git call: ${args.join(' ')}`);
    });
    const context = contextFor({ git });

    const result = await performWriteIntent(intent('git_push', 'feature/write-surface'), context);

    expect(result.status).toBe('executed');
    expect(result.status === 'executed' && result.alreadyPresent).toBe(true);
    expect(result.status === 'executed' && result.detail).toContain('already carries');
    expect(calls.some((args) => args[0] === 'push')).toBe(false);
    // Durability held even though nothing was pushed: the reconciliation check still records the pair.
    expect(events.emitted.map((event) => event.type)).toStrictEqual(['write.attempted', 'write.executed']);
    expect(events.emitted[1]?.payload['already_present']).toBe(true);
  });
});

describe('pull_request — matrix row 1 (first execution)', () => {
  it('opens exactly one pull request when none exists yet', async () => {
    const { gh, calls } = recordingGh((args) => {
      if (args[0] === 'pr' && args[1] === 'list') return ok('[]');
      if (args[0] === 'pr' && args[1] === 'create') {
        return ok('https://github.com/o/r/pull/7\n');
      }
      throw new Error(`unexpected gh call: ${args.join(' ')}`);
    });
    const context = contextFor({ gh });

    const result = await performWriteIntent(intent('pull_request', 'feature/write-surface'), context);

    expect(result.status).toBe('executed');
    expect(events.emitted.map((event) => event.type)).toStrictEqual(['write.attempted', 'write.executed']);
    const createCalls = calls.filter((args) => args[0] === 'pr' && args[1] === 'create');
    expect(createCalls).toHaveLength(1);
  });
});

describe('pull_request — matrix row 3 (crash after write.attempted, before write.executed)', () => {
  it('finds the existing pull request and never opens a second one', async () => {
    const { gh, calls } = recordingGh((args) => {
      if (args[0] === 'pr' && args[1] === 'list') {
        return ok(JSON.stringify([{ number: 7, url: 'https://github.com/o/r/pull/7' }]));
      }
      if (args[0] === 'pr' && args[1] === 'create') {
        throw new Error('a second pull request must never be opened');
      }
      throw new Error(`unexpected gh call: ${args.join(' ')}`);
    });
    const context = contextFor({ gh });

    const result = await performWriteIntent(intent('pull_request', 'feature/write-surface'), context);

    expect(result.status).toBe('executed');
    expect(result.status === 'executed' && result.alreadyPresent).toBe(true);
    expect(result.status === 'executed' && result.detail).toContain('already exists');
    expect(calls.some((args) => args[0] === 'pr' && args[1] === 'create')).toBe(false);
  });
});

describe('git_note — matrix rows 1, 5 (written on the real merge commit) and 6 (crash recovery)', () => {
  const mergeCommit = 'cccccccccccccccccccccccccccccccccccccccc';

  it('refuses to run at all with no merge commit known (NoteMergeCommitUnknown)', async () => {
    const context = contextFor({ mergeCommit: null });
    await expect(
      performWriteIntent(intent('git_note', 'refs/notes/orch'), context),
    ).rejects.toBeInstanceOf(NoteMergeCommitUnknown);
    // Refused before any attempt: nothing durable is written for a call that should never have been made.
    expect(events.emitted).toStrictEqual([]);
  });

  it('adds and pushes the note once, on the real merge commit, when none exists yet', async () => {
    const { git, calls } = recordingGit((args) => {
      if (args[0] === 'fetch') return ok();
      if (args[0] === 'notes' && args[2] === 'show') return failed('no note found');
      if (args[0] === 'notes' && args[2] === 'add') return ok();
      if (args[0] === 'push') return ok();
      throw new Error(`unexpected git call: ${args.join(' ')}`);
    });
    const context = contextFor({ git, mergeCommit });

    const result = await performWriteIntent(intent('git_note', 'refs/notes/orch'), context);

    expect(result.status).toBe('executed');
    expect(result.status === 'executed' && result.alreadyPresent).toBe(false);
    expect(result.status === 'executed' && result.detail).toContain(mergeCommit.slice(0, 12));
    expect(events.emitted.map((event) => event.type)).toStrictEqual(['write.attempted', 'write.executed']);
    const addCalls = calls.filter((args) => args[0] === 'notes' && args[2] === 'add');
    expect(addCalls).toHaveLength(1);
    // The note lands on the merge commit passed in, never on `HEAD` or any other commit.
    expect(addCalls[0]).toContain(mergeCommit);
  });

  it('probes before writing again once the note has actually reached origin (matrix row 6)', async () => {
    const sha = 'dddddddddddddddddddddddddddddddddddddddd';
    const { git, calls } = recordingGit((args) => {
      if (args[0] === 'fetch') return ok();
      if (args[0] === 'notes' && args[2] === 'show') return ok('already there');
      if (args[0] === 'rev-parse') return ok(`${sha}\n`);
      if (args[0] === 'ls-remote') return ok(`${sha}\trefs/notes/orch\n`);
      if (args[0] === 'notes' && args[2] === 'add') throw new Error('a second note must never be added');
      if (args[0] === 'push') throw new Error('a second push of the notes ref must never happen');
      throw new Error(`unexpected git call: ${args.join(' ')}`);
    });
    const context = contextFor({ git, mergeCommit });

    const result = await performWriteIntent(intent('git_note', 'refs/notes/orch'), context);

    expect(result.status).toBe('executed');
    expect(result.status === 'executed' && result.alreadyPresent).toBe(true);
    expect(result.status === 'executed' && result.detail).toContain('already carries a note');
    expect(calls.some((args) => args[0] === 'notes' && args[2] === 'add')).toBe(false);
    expect(calls.some((args) => args[0] === 'push')).toBe(false);
  });

  /**
   * The critical fix: a crash between the local `git notes add` (which succeeded) and the `git push` of
   * the notes ref (which never ran) must not be read as "already there" from the local `show` alone — the
   * effect (AD-15) is landing on `origin`, and a note only this worktree can see has not landed. This
   * reproduces exactly that: the local note exists, but `ls-remote` shows the remote ref is still empty
   * (or behind), so the push still has to happen — and must happen without adding a second note.
   */
  it('pushes a note that a previous, interrupted attempt only added locally, never adding a second one', async () => {
    const { git, calls } = recordingGit((args) => {
      if (args[0] === 'fetch') return ok();
      if (args[0] === 'notes' && args[2] === 'show') return ok('already there, locally');
      if (args[0] === 'rev-parse') return ok('eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee\n');
      // The remote carries no such ref yet: exactly the state a crash before the first-ever push leaves.
      if (args[0] === 'ls-remote') return ok('');
      if (args[0] === 'notes' && args[2] === 'add') throw new Error('a second note must never be added');
      if (args[0] === 'push') return ok();
      throw new Error(`unexpected git call: ${args.join(' ')}`);
    });
    const context = contextFor({ git, mergeCommit });

    const result = await performWriteIntent(intent('git_note', 'refs/notes/orch'), context);

    expect(result.status).toBe('executed');
    expect(result.status === 'executed' && result.alreadyPresent).toBe(false);
    expect(calls.some((args) => args[0] === 'notes' && args[2] === 'add')).toBe(false);
    const pushCalls = calls.filter((args) => args[0] === 'push');
    expect(pushCalls).toHaveLength(1);
    expect(pushCalls[0]).toContain('refs/notes/orch');
  });
});

describe('git_tag and domain_mutation — matrix row 9', () => {
  it.each(['git_tag', 'domain_mutation'] as const)(
    'refuses "%s" cleanly, by name, before any call is attempted',
    async (kind) => {
      const context = contextFor({});
      await expect(performWriteIntent(intent(kind, 'irrelevant'), context)).rejects.toBeInstanceOf(
        WriteKindNotImplemented,
      );
      expect(events.emitted).toStrictEqual([]);
    },
  );
});

describe('failure branches — a non-zero git/gh exit is recorded, never swallowed', () => {
  it('git_push: records write.failed when the push itself fails', async () => {
    const { git } = recordingGit((args) => {
      if (args[0] === 'rev-parse') return ok('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n');
      if (args[0] === 'ls-remote') return ok('');
      if (args[0] === 'push') return failed('remote rejected non-fast-forward');
      throw new Error(`unexpected git call: ${args.join(' ')}`);
    });
    const context = contextFor({ git });

    const result = await performWriteIntent(intent('git_push', 'feature/write-surface'), context);

    expect(result.status).toBe('failed');
    expect(result.status === 'failed' && result.error.code).toBe('write.push_failed');
    expect(events.emitted.map((event) => event.type)).toStrictEqual(['write.attempted', 'write.failed']);
  });

  it('git_push: records write.failed when HEAD itself cannot be read', async () => {
    const { git } = recordingGit((args) => {
      if (args[0] === 'rev-parse') return failed('not a git repository');
      throw new Error(`unexpected git call: ${args.join(' ')}`);
    });
    const context = contextFor({ git });

    const result = await performWriteIntent(intent('git_push', 'feature/write-surface'), context);

    expect(result.status).toBe('failed');
    expect(result.status === 'failed' && result.error.code).toBe('write.push_failed');
  });

  it('pull_request: refuses rather than guessing when gh pr list itself fails to read', async () => {
    const { gh, calls } = recordingGh((args) => {
      if (args[0] === 'pr' && args[1] === 'list') return failed('gh: authentication required');
      if (args[0] === 'pr' && args[1] === 'create') throw new Error('must never guess and create blind');
      throw new Error(`unexpected gh call: ${args.join(' ')}`);
    });
    const context = contextFor({ gh });

    const result = await performWriteIntent(intent('pull_request', 'feature/write-surface'), context);

    expect(result.status).toBe('failed');
    expect(result.status === 'failed' && result.error.code).toBe('write.pull_request_failed');
    expect(calls.some((args) => args[0] === 'pr' && args[1] === 'create')).toBe(false);
  });

  it('pull_request: records write.failed when gh pr create fails', async () => {
    const { gh } = recordingGh((args) => {
      if (args[0] === 'pr' && args[1] === 'list') return ok('[]');
      if (args[0] === 'pr' && args[1] === 'create') return failed('gh: validation failed');
      throw new Error(`unexpected gh call: ${args.join(' ')}`);
    });
    const context = contextFor({ gh });

    const result = await performWriteIntent(intent('pull_request', 'feature/write-surface'), context);

    expect(result.status).toBe('failed');
    expect(result.status === 'failed' && result.error.code).toBe('write.pull_request_failed');
  });

  it('git_note: records write.failed when git notes add fails', async () => {
    const mergeCommit = 'cccccccccccccccccccccccccccccccccccccccc';
    const { git } = recordingGit((args) => {
      if (args[0] === 'fetch') return ok();
      if (args[0] === 'notes' && args[2] === 'show') return failed('no note found');
      if (args[0] === 'notes' && args[2] === 'add') return failed('unable to write note object');
      throw new Error(`unexpected git call: ${args.join(' ')}`);
    });
    const context = contextFor({ git, mergeCommit });

    const result = await performWriteIntent(intent('git_note', 'refs/notes/orch'), context);

    expect(result.status).toBe('failed');
    expect(result.status === 'failed' && result.error.code).toBe('git.note_write_failed');
  });

  it('git_note: records write.failed when the push of the notes ref fails', async () => {
    const mergeCommit = 'cccccccccccccccccccccccccccccccccccccccc';
    const { git } = recordingGit((args) => {
      if (args[0] === 'fetch') return ok();
      if (args[0] === 'notes' && args[2] === 'show') return failed('no note found');
      if (args[0] === 'notes' && args[2] === 'add') return ok();
      if (args[0] === 'push') return failed('remote unavailable');
      throw new Error(`unexpected git call: ${args.join(' ')}`);
    });
    const context = contextFor({ git, mergeCommit });

    const result = await performWriteIntent(intent('git_note', 'refs/notes/orch'), context);

    expect(result.status).toBe('failed');
    expect(result.status === 'failed' && result.error.code).toBe('git.note_write_failed');
  });

  it('git_note: records write.failed when recovering a local-only note fails to push', async () => {
    const mergeCommit = 'cccccccccccccccccccccccccccccccccccccccc';
    const { git } = recordingGit((args) => {
      if (args[0] === 'fetch') return ok();
      if (args[0] === 'notes' && args[2] === 'show') return ok('already there, locally');
      if (args[0] === 'rev-parse') return ok('eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee\n');
      if (args[0] === 'ls-remote') return ok('');
      if (args[0] === 'push') return failed('remote unavailable');
      throw new Error(`unexpected git call: ${args.join(' ')}`);
    });
    const context = contextFor({ git, mergeCommit });

    const result = await performWriteIntent(intent('git_note', 'refs/notes/orch'), context);

    expect(result.status).toBe('failed');
    expect(result.status === 'failed' && result.error.code).toBe('git.note_write_failed');
  });
});

describe('checkPullRequestMerged — the bounded, cheap per-pass read', () => {
  const request = { repository: '/tmp/no-such-worktree', branch: 'feature/write-surface' };

  it('reports MERGED with the real commit oid', async () => {
    const gh: GhCall = () =>
      Promise.resolve(ok(JSON.stringify({ state: 'MERGED', mergeCommit: { oid: 'deadbeef' } })));
    expect(await checkPullRequestMerged({ ...request, gh })).toStrictEqual({
      state: 'MERGED',
      mergeCommit: 'deadbeef',
    });
  });

  it('reports OPEN while the pull request is still open', async () => {
    const gh: GhCall = () => Promise.resolve(ok(JSON.stringify({ state: 'OPEN' })));
    expect(await checkPullRequestMerged({ ...request, gh })).toStrictEqual({
      state: 'OPEN',
      mergeCommit: null,
    });
  });

  it('reports CLOSED with no commit when closed without merging', async () => {
    const gh: GhCall = () => Promise.resolve(ok(JSON.stringify({ state: 'CLOSED' })));
    expect(await checkPullRequestMerged({ ...request, gh })).toStrictEqual({
      state: 'CLOSED',
      mergeCommit: null,
    });
  });

  it('reports OPEN rather than throwing when the call itself fails', async () => {
    const gh: GhCall = () => Promise.resolve(failed('network unreachable'));
    expect(await checkPullRequestMerged({ ...request, gh })).toStrictEqual({
      state: 'OPEN',
      mergeCommit: null,
    });
  });

  it('reports OPEN rather than throwing on unparseable output', async () => {
    const gh: GhCall = () => Promise.resolve(ok('not json'));
    expect(await checkPullRequestMerged({ ...request, gh })).toStrictEqual({
      state: 'OPEN',
      mergeCommit: null,
    });
  });
});

describe('mergeFidelityOf — story 3-3, matrix rows 11-13, 19', () => {
  const proposedHead = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
  const mergeCommit = 'f9e8d7c6b5a4938271605f4e3d2c1b0a99887766';
  const mergeBase = '00112233445566778899aabbccddeeff0011223';

  /**
   * A fake `git` covering every call `mergeFidelityOf` makes, in order: `rev-parse HEAD`, `rev-parse
   * --verify <mergeCommit>^2` (the two-parent check), `merge-base <mergeCommit>^1 <proposedHead>`,
   * `diff --name-only <mergeBase> <proposedHead>` (this run's own touched paths), and the final
   * path-scoped `diff --name-only <proposedHead> <mergeCommit> -- <touchedPaths...>`.
   */
  const fakeGit = (overrides: {
    readonly head?: WriteCallResult;
    readonly secondParent?: WriteCallResult;
    readonly mergeBaseResult?: WriteCallResult;
    readonly touchedPaths?: WriteCallResult;
    readonly comparison?: WriteCallResult;
  }): { readonly git: GitCall; readonly calls: (readonly string[])[] } =>
    recordingGit((args) => {
      if (args[0] === 'rev-parse' && args[1] === 'HEAD') return overrides.head ?? ok(`${proposedHead}\n`);
      if (args[0] === 'rev-parse' && args[1] === '--verify') {
        return overrides.secondParent ?? ok(`${mergeCommit}\n`);
      }
      if (args[0] === 'merge-base') return overrides.mergeBaseResult ?? ok(`${mergeBase}\n`);
      if (args[0] === 'diff' && args[2] === mergeBase) return overrides.touchedPaths ?? ok('src/a.ts\n');
      if (args[0] === 'diff' && args[2] === proposedHead) return overrides.comparison ?? ok('');
      throw new Error(`unexpected git call: ${args.join(' ')}`);
    });

  it('reports unchanged when the touched-paths comparison is empty (row 11)', () => {
    const { git } = fakeGit({});
    expect(mergeFidelityOf(git, '/tmp/no-such-worktree', mergeCommit)).toStrictEqual({
      outcome: 'unchanged',
      code: null,
      detail: `${mergeCommit.slice(0, 12)} carries this run's own touched paths unchanged from ${proposedHead.slice(0, 12)}`,
      proposedHead,
    });
  });

  it('reports unchanged, with no diff call at all, when this run touched no paths', () => {
    const { calls, git } = fakeGit({ touchedPaths: ok('') });
    const result = mergeFidelityOf(git, '/tmp/no-such-worktree', mergeCommit);
    expect(result.outcome).toBe('unchanged');
    expect(result.code).toBeNull();
    // The final comparison is never even attempted for an empty touched-paths list.
    expect(calls.filter((args) => args[0] === 'diff')).toHaveLength(1);
  });

  it('reports corrected when the merge commit differs on a path this run touched (row 12)', () => {
    const { git } = fakeGit({ comparison: ok('src/a.ts\n') });
    const result = mergeFidelityOf(git, '/tmp/no-such-worktree', mergeCommit);
    expect(result.outcome).toBe('corrected');
    expect(result.code).toBeNull();
    expect(result.proposedHead).toBe(proposedHead);
  });

  it('never reports a false correction from unrelated main drift outside the run’s own touched paths (row 19)', () => {
    // main advanced with a change to `src/unrelated.ts`, which this run never touched — the final
    // comparison is restricted to `src/a.ts` alone (the run's own touched path) and reports it unchanged,
    // regardless of what else differs between proposedHead and mergeCommit on unrelated paths.
    const { calls, git } = fakeGit({ touchedPaths: ok('src/a.ts\n'), comparison: ok('') });
    const result = mergeFidelityOf(git, '/tmp/no-such-worktree', mergeCommit);
    expect(result.outcome).toBe('unchanged');
    const finalDiff = calls.find((args) => args[0] === 'diff' && args[2] === proposedHead);
    expect(finalDiff).toStrictEqual(['diff', '--name-only', proposedHead, mergeCommit, '--', 'src/a.ts']);
  });

  it('records a code, never a guessed outcome, when this run’s own worktree HEAD cannot be read (row 13)', () => {
    const { git } = fakeGit({ head: failed() });
    const result = mergeFidelityOf(git, '/tmp/no-such-worktree', mergeCommit);
    expect(result.outcome).toBeNull();
    expect(result.code).toBe('pull_request.merge_fidelity_head_unreadable');
    expect(result.proposedHead).toBeNull();
  });

  it('records a code, never a guessed outcome, when mergeCommit has fewer than two parents (row 13)', () => {
    const { git } = fakeGit({ secondParent: failed() });
    const result = mergeFidelityOf(git, '/tmp/no-such-worktree', mergeCommit);
    expect(result.outcome).toBeNull();
    expect(result.code).toBe('pull_request.merge_fidelity_not_a_merge_commit');
    // The worktree HEAD was already read before this check, so it is still reported.
    expect(result.proposedHead).toBe(proposedHead);
  });

  it('records a code, never a guessed outcome, when the fork point cannot be found (row 13)', () => {
    const { git } = fakeGit({ mergeBaseResult: failed() });
    const result = mergeFidelityOf(git, '/tmp/no-such-worktree', mergeCommit);
    expect(result.outcome).toBeNull();
    expect(result.code).toBe('pull_request.merge_fidelity_merge_base_unreadable');
  });

  it('records a code, never a guessed outcome, when this run’s own touched paths cannot be read (row 13)', () => {
    const { git } = fakeGit({ touchedPaths: failed() });
    const result = mergeFidelityOf(git, '/tmp/no-such-worktree', mergeCommit);
    expect(result.outcome).toBeNull();
    expect(result.code).toBe('pull_request.merge_fidelity_touched_paths_unreadable');
  });

  it('records a code, never a guessed outcome, when the final path-scoped comparison fails (row 13)', () => {
    const { git } = fakeGit({ comparison: failed() });
    const result = mergeFidelityOf(git, '/tmp/no-such-worktree', mergeCommit);
    expect(result.outcome).toBeNull();
    expect(result.code).toBe('pull_request.merge_fidelity_comparison_unreadable');
  });
});

// -------------------------------------------------------------------------------------------------
// Story 3-2 (AD-27) — `mode: 'shadow'` suppresses the mutating call, never the probe (matrix rows 1–6).
// Row 4 ("the same intents under mode: 'live'") is every test above this section, run unmodified — the
// whole point of `context.mode` defaulting to `'live'` is that none of them needed to change.
// -------------------------------------------------------------------------------------------------

describe('git_push under mode: "shadow" — matrix rows 1, 5, 6', () => {
  it('suppresses the push and records not-destructive when the target does not yet exist (row 5)', async () => {
    const { git, calls } = recordingGit((args) => {
      if (args[0] === 'rev-parse') return ok('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n');
      if (args[0] === 'ls-remote') return ok(''); // nothing at that ref yet
      throw new Error(`unexpected git call: ${args.join(' ')}`);
    });
    const context = contextFor({ git, mode: 'shadow' });

    const result = await performWriteIntent(intent('git_push', 'feature/write-surface'), context);

    expect(result.status).toBe('suppressed');
    expect(result.status === 'suppressed' && result.destructive).toBe(false);
    expect(events.emitted.map((event) => event.type)).toStrictEqual(['write.attempted', 'write.suppressed']);
    expect(events.emitted[1]?.payload['destructive']).toBe(false);
    // Never a real push, under any probe finding, while shadowing.
    expect(calls.some((args) => args[0] === 'push')).toBe(false);
  });

  it('suppresses the push and records not-destructive when the remote already matches', async () => {
    const sha = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const { git, calls } = recordingGit((args) => {
      if (args[0] === 'rev-parse') return ok(`${sha}\n`);
      if (args[0] === 'ls-remote') return ok(`${sha}\trefs/heads/feature/write-surface\n`);
      throw new Error(`unexpected git call: ${args.join(' ')}`);
    });
    const context = contextFor({ git, mode: 'shadow' });

    const result = await performWriteIntent(intent('git_push', 'feature/write-surface'), context);

    expect(result.status).toBe('suppressed');
    expect(result.status === 'suppressed' && result.destructive).toBe(false);
    expect(calls.some((args) => args[0] === 'push')).toBe(false);
  });

  it('suppresses the push and records destructive when the remote already carries something different (row 6)', async () => {
    const { git, calls } = recordingGit((args) => {
      if (args[0] === 'rev-parse') return ok('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n');
      if (args[0] === 'ls-remote') return ok('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\trefs/heads/feature/write-surface\n');
      throw new Error(`unexpected git call: ${args.join(' ')}`);
    });
    const context = contextFor({ git, mode: 'shadow' });

    const result = await performWriteIntent(intent('git_push', 'feature/write-surface'), context);

    expect(result.status).toBe('suppressed');
    expect(result.status === 'suppressed' && result.destructive).toBe(true);
    expect(events.emitted[1]?.payload['destructive']).toBe(true);
    expect(calls.some((args) => args[0] === 'push')).toBe(false);
  });

  /**
   * A live run's real push call would still succeed or fail on the ground truth regardless of what
   * `ls-remote` found; a shadow run never makes that call, so a failed read here has nothing to fall back
   * on and must not be guessed at as "clean".
   */
  it('records write.failed, never a clean suppression, when the remote probe itself cannot be read', async () => {
    const { git, calls } = recordingGit((args) => {
      if (args[0] === 'rev-parse') return ok('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n');
      if (args[0] === 'ls-remote') return failed('unable to access remote: network unreachable');
      throw new Error(`unexpected git call: ${args.join(' ')}`);
    });
    const context = contextFor({ git, mode: 'shadow' });

    const result = await performWriteIntent(intent('git_push', 'feature/write-surface'), context);

    expect(result.status).toBe('failed');
    expect(result.status === 'failed' && result.error.code).toBe('write.push_failed');
    expect(calls.some((args) => args[0] === 'push')).toBe(false);
  });
});

describe('pull_request under mode: "shadow" — matrix rows 2, 5, 6', () => {
  it('suppresses and records not-destructive when no pull request exists yet (row 5)', async () => {
    const { gh, calls } = recordingGh((args) => {
      if (args[0] === 'pr' && args[1] === 'list') return ok('[]');
      throw new Error(`unexpected gh call: ${args.join(' ')}`);
    });
    const context = contextFor({ gh, mode: 'shadow' });

    const result = await performWriteIntent(intent('pull_request', 'feature/write-surface'), context);

    expect(result.status).toBe('suppressed');
    expect(result.status === 'suppressed' && result.destructive).toBe(false);
    expect(events.emitted.map((event) => event.type)).toStrictEqual(['write.attempted', 'write.suppressed']);
    expect(calls.some((args) => args[0] === 'pr' && args[1] === 'create')).toBe(false);
  });

  it('suppresses and records destructive when an existing pull request has no known expected merge commit to compare against (row 6)', async () => {
    const { gh, calls } = recordingGh((args) => {
      if (args[0] === 'pr' && args[1] === 'list') {
        return ok(JSON.stringify([{ number: 7, url: 'https://example.invalid/pr/7' }]));
      }
      throw new Error(`unexpected gh call: ${args.join(' ')}`);
    });
    const context = contextFor({ gh, mode: 'shadow' });

    const result = await performWriteIntent(intent('pull_request', 'feature/write-surface'), context);

    expect(result.status).toBe('suppressed');
    expect(result.status === 'suppressed' && result.destructive).toBe(true);
    expect(result.status === 'suppressed' && result.detail).toContain('#7');
    expect(calls.some((args) => args[0] === 'pr' && args[1] === 'create')).toBe(false);
  });

  /**
   * **The critical fix.** `branchFor` (`src/engine/committer.ts`) derives the branch name from the feature
   * slug alone, never the run id, so shadowing an already-merged feature finds that exact feature's own
   * real, already-merged pull request on *every single run*. Treating any found pull request as
   * destructive, unconditionally, would misclassify this story's own primary use case every time — the
   * fix compares the found pull request's own merge commit against `context.shadowRealMergeCommit`.
   */
  it('is NOT destructive when the found pull request is the expected historical one this run is shadowing', async () => {
    const shadowedMergeCommit = 'f6e2ec3c8481d2755c2798855e9bb0473983c499';
    const { gh } = recordingGh((args) => {
      if (args[0] === 'pr' && args[1] === 'list') {
        return ok(
          JSON.stringify([
            { number: 1, url: 'https://example.invalid/pr/1', mergeCommit: { oid: shadowedMergeCommit } },
          ]),
        );
      }
      throw new Error(`unexpected gh call: ${args.join(' ')}`);
    });
    const context = contextFor({ gh, mode: 'shadow', shadowRealMergeCommit: shadowedMergeCommit });

    const result = await performWriteIntent(intent('pull_request', 'feature/write-surface'), context);

    expect(result.status).toBe('suppressed');
    expect(result.status === 'suppressed' && result.destructive).toBe(false);
    expect(result.status === 'suppressed' && result.detail).toContain('matches the real merge commit');
  });

  it('is destructive when the found pull request does not match the real merge commit being shadowed', async () => {
    const { gh } = recordingGh((args) => {
      if (args[0] === 'pr' && args[1] === 'list') {
        return ok(
          JSON.stringify([
            { number: 2, url: 'https://example.invalid/pr/2', mergeCommit: { oid: 'a'.repeat(40) } },
          ]),
        );
      }
      throw new Error(`unexpected gh call: ${args.join(' ')}`);
    });
    const context = contextFor({ gh, mode: 'shadow', shadowRealMergeCommit: 'b'.repeat(40) });

    const result = await performWriteIntent(intent('pull_request', 'feature/write-surface'), context);

    expect(result.status).toBe('suppressed');
    expect(result.status === 'suppressed' && result.destructive).toBe(true);
    expect(result.status === 'suppressed' && result.detail).toContain('does not match');
  });

  it('still refuses rather than guessing when the probe read itself fails, even while shadowing', async () => {
    const { gh, calls } = recordingGh((args) => {
      if (args[0] === 'pr' && args[1] === 'list') return failed('gh: authentication required');
      throw new Error(`unexpected gh call: ${args.join(' ')}`);
    });
    const context = contextFor({ gh, mode: 'shadow' });

    const result = await performWriteIntent(intent('pull_request', 'feature/write-surface'), context);

    expect(result.status).toBe('failed');
    expect(calls.some((args) => args[0] === 'pr' && args[1] === 'create')).toBe(false);
  });
});

describe('git_note under mode: "shadow" — matrix rows 3, 5, 6', () => {
  it('never throws NoteMergeCommitUnknown, and probes the worktree’s own HEAD when no merge commit is known', async () => {
    const { git, calls } = recordingGit((args) => {
      if (args[0] === 'rev-parse') return ok('cccccccccccccccccccccccccccccccccccccccc\n');
      if (args[0] === 'fetch') return ok();
      if (args[0] === 'notes' && args[2] === 'show') return failed('no note found');
      throw new Error(`unexpected git call: ${args.join(' ')}`);
    });
    const context = contextFor({ git, mode: 'shadow', mergeCommit: null });

    const result = await performWriteIntent(intent('git_note', 'refs/notes/orch'), context);

    expect(result.status).toBe('suppressed');
    expect(result.status === 'suppressed' && result.destructive).toBe(false);
    expect(events.emitted.map((event) => event.type)).toStrictEqual(['write.attempted', 'write.suppressed']);
    expect(calls.some((args) => args[0] === 'notes' && args[2] === 'add')).toBe(false);
    expect(calls.some((args) => args[0] === 'push')).toBe(false);
    // The probe ran against HEAD, the shadow run's own stand-in for a commit that will never merge.
    expect(calls.some((args) => args[0] === 'notes' && args.includes('cccccccccccccccccccccccccccccccccccccccc'))).toBe(true);
  });

  it('records not-destructive when the target already carries exactly the note this run would add', async () => {
    const mergeCommit = 'dddddddddddddddddddddddddddddddddddddddd';
    const expectedBody = `${JSON.stringify(NOTE, null, 2)}\n`;
    const { git, calls } = recordingGit((args) => {
      if (args[0] === 'fetch') return ok();
      if (args[0] === 'notes' && args[2] === 'show') return ok(expectedBody);
      throw new Error(`unexpected git call: ${args.join(' ')}`);
    });
    const context = contextFor({ git, mode: 'shadow', mergeCommit });

    const result = await performWriteIntent(intent('git_note', 'refs/notes/orch'), context);

    expect(result.status).toBe('suppressed');
    expect(result.status === 'suppressed' && result.destructive).toBe(false);
    expect(calls.some((args) => args[0] === 'notes' && args[2] === 'add')).toBe(false);
  });

  it('records destructive when the target already carries a different note (row 6)', async () => {
    const mergeCommit = 'dddddddddddddddddddddddddddddddddddddddd';
    const { git, calls } = recordingGit((args) => {
      if (args[0] === 'fetch') return ok();
      if (args[0] === 'notes' && args[2] === 'show') return ok('a wholly different note body\n');
      throw new Error(`unexpected git call: ${args.join(' ')}`);
    });
    const context = contextFor({ git, mode: 'shadow', mergeCommit });

    const result = await performWriteIntent(intent('git_note', 'refs/notes/orch'), context);

    expect(result.status).toBe('suppressed');
    expect(result.status === 'suppressed' && result.destructive).toBe(true);
    expect(calls.some((args) => args[0] === 'notes' && args[2] === 'add')).toBe(false);
    expect(calls.some((args) => args[0] === 'push')).toBe(false);
  });

  /**
   * A live run's real `git notes add` would still land or fail on its own regardless of what this read
   * found; a shadow run never makes that call, so a `git notes show` failure that is not positively "no
   * note here" (a repository fault, here) carries no evidence either way and must not be guessed at as
   * "clean".
   */
  it('records write.failed, never a clean suppression, when the note probe fails for a reason other than "no note"', async () => {
    const mergeCommit = 'dddddddddddddddddddddddddddddddddddddddd';
    const { git, calls } = recordingGit((args) => {
      if (args[0] === 'fetch') return ok();
      if (args[0] === 'notes' && args[2] === 'show') return failed('fatal: not a git repository');
      throw new Error(`unexpected git call: ${args.join(' ')}`);
    });
    const context = contextFor({ git, mode: 'shadow', mergeCommit });

    const result = await performWriteIntent(intent('git_note', 'refs/notes/orch'), context);

    expect(result.status).toBe('failed');
    expect(result.status === 'failed' && result.error.code).toBe('git.note_write_failed');
    expect(calls.some((args) => args[0] === 'notes' && args[2] === 'add')).toBe(false);
  });

  it('gives the HEAD-unreadable case its own distinct code, never git.note_write_failed', async () => {
    const { git } = recordingGit((args) => {
      if (args[0] === 'rev-parse') return failed('fatal: not a git repository');
      throw new Error(`unexpected git call: ${args.join(' ')}`);
    });
    const context = contextFor({ git, mode: 'shadow', mergeCommit: null });

    const result = await performWriteIntent(intent('git_note', 'refs/notes/orch'), context);

    expect(result.status).toBe('failed');
    expect(result.status === 'failed' && result.error.code).toBe('shadow.head_unreadable');
  });
});

describe('writeIntentSettled — the log-side half of the reconciliation check', () => {
  const eventOf = (type: string, intentId: string): EventEnvelope => ({
    ts: '2026-09-24T00:00:00.000Z',
    seq: 1,
    feature: 'write-surface',
    run: '01JBQ8Z1X2Y3W4V5U6T7S8R9Q0',
    step: null,
    emitter: 'engine.reconciler',
    type,
    payload: { intent_id: intentId },
  });

  it('is true once a write.executed line for that intent id exists', () => {
    const log = [eventOf('write.attempted', 'commit.git_push'), eventOf('write.executed', 'commit.git_push')];
    expect(writeIntentSettled(log, 'commit.git_push')).toBe(true);
  });

  it('is false for an intent with only an attempted line, or none at all', () => {
    const log = [eventOf('write.attempted', 'commit.git_push')];
    expect(writeIntentSettled(log, 'commit.git_push')).toBe(false);
    expect(writeIntentSettled(log, 'commit.pull_request')).toBe(false);
  });

  it('is true once a write.suppressed line for that intent id exists (AD-27, story 3-2)', () => {
    const log = [eventOf('write.attempted', 'commit.git_push'), eventOf('write.suppressed', 'commit.git_push')];
    expect(writeIntentSettled(log, 'commit.git_push')).toBe(true);
  });
});
