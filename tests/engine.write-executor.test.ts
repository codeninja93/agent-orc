/**
 * Story 2-11, matrix rows 1–3, 6, 9 — the write executor, driven in isolation.
 *
 * `src/engine/write-executor.ts` is the one unit AD-15 lets perform a `git push`, a pull-request creation
 * or a git note: `write.attempted` durable before the call, and a reconciliation check before ever
 * repeating one. Every test here drives the real performers (`performWriteIntent`, `checkPullRequestMerged`)
 * against a fake `git`/`gh` — never a real repository or a real GitHub — so the claim under test is the
 * *shape* of the calls and the *order* of the durable lines, not that a particular host answers a
 * particular way.
 */
import { describe, expect, it } from 'vitest';

import { WriteIntentSchema } from '../src/contracts/index.js';
import type { EventEnvelope, WriteIntent } from '../src/contracts/index.js';
import {
  NoteMergeCommitUnknown,
  WriteKindNotImplemented,
  checkPullRequestMerged,
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
});
