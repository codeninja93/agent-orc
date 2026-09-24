/**
 * AD-15's enumerated write surface, executed. This is the unit "agents never write; the engine
 * executes an enumerated write surface" is about: one performer per {@link WriteIntentKind}, each
 * obeying the fixed durability order — a `write.attempted` line is durable before the underlying call —
 * and each checking the target before acting, so a resumed or re-run attempt never repeats an effect
 * that already landed.
 *
 * **Why reconciliation has no existing analog to reuse.** Story 2-10's fetch record is
 * "lookup-or-perform-then-record" — safe because a crash mid-read just means "not yet recorded," and
 * re-reading is harmless. A write cannot use that shape: the remote effect (a pushed branch, an opened
 * pull request, a note landed under the AD-22 ref) can succeed while this process crashes before
 * recording it, so "not yet recorded" and "already happened" are both live possibilities every performer
 * below tells apart *before* acting, never after. The rule inside each performer is fixed and identical:
 * record `write.attempted`, check the target, act only if the check said no, then record
 * `write.executed` — which is also what makes a crash between the record and the call, and a crash
 * between the call and the outcome, converge on the same next action: check again.
 *
 * **`git_push` and `git_note` shell out to `git`, the established pattern** already used by
 * `src/runtime/repository.ts`, `src/engine/baseline.ts` and `src/pool/worktree.ts` — no new dependency,
 * no bespoke client, a thin `execFileSync` wrapper that reports a non-zero exit as data rather than
 * throwing. This module cannot import any of those three: the dependency guard in
 * `tests/engine.reconciler.test.ts` confines every file under `src/engine/` to `../contracts/`,
 * `../runtime/` and `node:` builtins, so the ~15-line wrapper is repeated here rather than shared —
 * the same duplication the three existing copies already accept.
 *
 * **`pull_request` shells out to `gh`**, GitHub's own official CLI, for the same "no bespoke agent
 * framework" reason, behind the one injectable port this story's own text asks for: an automated suite
 * cannot create a real GitHub pull request, so what {@link performPullRequest} is tested against is that
 * it builds the right call, never that a particular GitHub instance answers a particular way.
 *
 * **No force-push, ever, and there is nowhere to ask for one.** `WriteIntentSchema` carries no field
 * through which a force could be expressed (`src/contracts/step.ts`), and {@link performGitPush} never
 * passes `--force` to `git push`.
 *
 * **The pull request is opened under whatever git identity this process holds.** `PullRequestPlan`
 * carries no identity field, by `src/engine/committer.ts`'s own design: AD-1 already asserts subscription
 * authentication at startup, and a field here could only disagree with the identity `gh`/`git` actually
 * use.
 *
 * **`git_tag` and `domain_mutation` refuse cleanly, by name.** Nothing in this codebase composes either
 * kind yet — `composeCommit` produces only `git_push`, `pull_request` and `git_note` — so a real
 * performer for them would be untested, speculative machinery ahead of need. The dispatch below is
 * still exhaustive over all five {@link WriteIntentKind} members: a sixth kind added later without a
 * case here is a compile-time error, not a silent gap.
 *
 * **Where the note lands, and when.** `src/contracts/note.ts` states plainly that "on the merge commit"
 * is this unit's binding to make, because no merge commit exists at the moment the committer composes
 * the note — the branch is not yet pushed and the pull request does not yet exist. It does not exist at
 * `git_push`/`pull_request` time either: merging is the human step the stage-2 gate names ("the user
 * reviewing and merging a pull request"), and this story's whole reason for the engine's `awaiting_merge`
 * feature state (`src/engine/reconciler.ts`) is that the run *waits* rather than guessing. So
 * {@link performGitNote} takes the merge commit as an explicit argument and refuses to run without one
 * ({@link NoteMergeCommitUnknown}) — there is no fallback to "the branch tip", because a note attached to
 * a pre-merge commit is a note on the wrong object, silently. {@link checkPullRequestMerged} is the
 * bounded, cheap per-pass read (`gh pr view <branch>`) that tells the reconciler when a real merge commit
 * exists to attach to; only then is `git_note` performed.
 */
import { execFileSync } from 'node:child_process';

import {
  WRITE_ATTEMPTED_EVENT_TYPE,
  WRITE_ATTEMPTED_PAYLOAD_KEYS,
  WRITE_EXECUTED_EVENT_TYPE,
  WRITE_EXECUTED_PAYLOAD_KEYS,
  WRITE_FAILED_EVENT_TYPE,
  WRITE_FAILED_PAYLOAD_KEYS,
  makeError,
} from '../contracts/index.js';
import type { EventEnvelope, GitNote, OrchError, WriteIntent, WriteIntentKind } from '../contracts/index.js';

import type { PullRequestPlan } from './committer.js';

/**
 * The remote every performer below acts against. Never configurable per intent: AD-22 and the profile
 * already fix one repository per run, and a second remote name would be a second place to get it wrong.
 *
 * Exported so `src/assembly/index.ts` (which needs the same name for its own `git remote get-url` read)
 * imports it rather than redeclaring it — one spelling of the default remote, not two that could drift.
 */
export const REMOTE = 'origin';

/** What one `git` or `gh` invocation reported. A non-zero status is data, not an exception. */
export interface WriteCallResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** How `git` is run for a write. A port, injectable for a suite that must not touch a real repository. */
export type GitCall = (args: readonly string[], cwd: string, input?: string) => WriteCallResult;

/** How `gh` is run for a write. Async, and a port for the reason this file's docblock states. */
export type GhCall = (args: readonly string[], cwd: string) => Promise<WriteCallResult>;

/** How long a single `git` invocation may take, matching `src/engine/baseline.ts` in spirit. */
export const WRITE_GIT_TIMEOUT_MS = 120_000;

/** How long a single `gh` invocation may take: `gh pr create` reaches a real network service. */
export const WRITE_GH_TIMEOUT_MS = 60_000;

/** Generous, because the output is read for a URL or an existing PR list, not accumulated at scale. */
const WRITE_MAX_BUFFER_BYTES = 64 * 1024 * 1024;

const resultOfThrown = (thrown: unknown): WriteCallResult => {
  const error = thrown as { status?: number | null; stdout?: string; stderr?: string; message?: string };
  return {
    status: error.status ?? null,
    stdout: error.stdout ?? '',
    stderr: error.stderr ?? error.message ?? '',
  };
};

/** The real `git`: no new dependency, a thin wrapper that never throws for an ordinary failed exit. */
export const realGitCall: GitCall = (args, cwd, input) => {
  try {
    const stdout = execFileSync('git', [...args], {
      cwd,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: WRITE_GIT_TIMEOUT_MS,
      maxBuffer: WRITE_MAX_BUFFER_BYTES,
      ...(input === undefined ? {} : { input }),
    });
    return { status: 0, stdout, stderr: '' };
  } catch (thrown: unknown) {
    return resultOfThrown(thrown);
  }
};

/** The real `gh`, GitHub's own official CLI — the one call this story keeps behind an injectable port. */
export const realGhCall: GhCall = (args, cwd) =>
  new Promise((resolve) => {
    try {
      const stdout = execFileSync('gh', [...args], {
        cwd,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: WRITE_GH_TIMEOUT_MS,
        maxBuffer: WRITE_MAX_BUFFER_BYTES,
      });
      resolve({ status: 0, stdout, stderr: '' });
    } catch (thrown: unknown) {
      resolve(resultOfThrown(thrown));
    }
  });

/** Everything one intent is performed against: the repository, the composer's plan, and the durable sink. */
export interface WriteExecutionContext {
  readonly run: string;
  /**
   * The git working tree the intents act in — the run's own worktree (AD-26). A worktree shares its
   * repository's remotes rather than owning a separate clone, so a push, a note or a `gh` call made here
   * reaches the same `origin` the committer named the branch and the pull request against.
   */
  readonly repository: string;
  /** The branch and pull-request prose `src/engine/committer.ts` composed. */
  readonly pullRequest: PullRequestPlan;
  /** The AD-22 note the committer composed. Read only by {@link performGitNote}. */
  readonly note: GitNote;
  /**
   * The real merge commit `git_note` attaches to, or `null` before one is known.
   *
   * `git_push` and `pull_request` ignore this field entirely. `git_note` refuses to run while it is
   * `null` ({@link NoteMergeCommitUnknown}) rather than falling back to the branch tip — see this file's
   * own docblock for why a fallback here would be a silent wrong-commit bug, not a convenience.
   */
  readonly mergeCommit: string | null;
  /**
   * Durably record one `write.attempted`/`write.executed`/`write.failed` line. Synchronous and never
   * swallowed: a caller whose durable log refuses this line (AD-4) must see that as a thrown failure,
   * not as a line quietly not written, because AD-15's whole ordering depends on the record actually
   * having landed before the call it is about.
   */
  readonly emit: (type: string, payload: Record<string, unknown>) => void;
  /** Injectable `git`. Defaults to {@link realGitCall}. */
  readonly git?: GitCall;
  /** Injectable `gh`. Defaults to {@link realGhCall}. */
  readonly gh?: GhCall;
}

/** What performing one intent produced. */
export type WriteIntentResult =
  | { readonly status: 'executed'; readonly alreadyPresent: boolean; readonly detail: string }
  | { readonly status: 'failed'; readonly error: OrchError };

/** The dispatcher's own type, so a caller assembling a `Reconciler` names it once. */
export type WriteExecutorPort = (
  intent: WriteIntent,
  context: WriteExecutionContext,
) => Promise<WriteIntentResult>;

/**
 * Whether the log already carries a `write.executed` line for this intent id.
 *
 * A pass that calls the performer again anyway is still safe — every performer below checks the target
 * before acting — but reading the log first is what keeps a settled intent from shelling out to `git`/
 * `gh` on every subsequent pass for no reason: once `write.executed` is durable, the effect is done and
 * re-probing buys nothing but noise in the log and an avoidable network call.
 */
export const writeIntentSettled = (events: readonly EventEnvelope[], intentId: string): boolean =>
  events.some(
    (event) =>
      event.type === WRITE_EXECUTED_EVENT_TYPE &&
      event.payload[WRITE_EXECUTED_PAYLOAD_KEYS.IntentId] === intentId,
  );

/** The three states `gh pr view --json state` reports, narrowed from whatever string comes back. */
export const PULL_REQUEST_STATES = ['OPEN', 'MERGED', 'CLOSED'] as const;

export type PullRequestState = (typeof PULL_REQUEST_STATES)[number];

/** What the bounded per-pass merge check found. `mergeCommit` is non-null exactly when `state` is `MERGED`. */
export interface MergeCheck {
  readonly state: PullRequestState;
  readonly mergeCommit: string | null;
}

export interface MergeCheckContext {
  readonly repository: string;
  /** The head branch the committer named — `gh pr view` accepts a branch name in place of a number. */
  readonly branch: string;
  /** Injectable `gh`. Defaults to {@link realGhCall}. */
  readonly gh?: GhCall;
}

/** The port a `Reconciler` is assembled with for the AD-15 `awaiting_merge` check (`ReconcilerOptions.mergeChecker`). */
export type MergeCheckPort = (context: MergeCheckContext) => Promise<MergeCheck>;

/**
 * One cheap, bounded `gh pr view` call — never a write, never a poll loop of its own. A failure to read
 * (network, auth, a `gh` not installed) is reported as `OPEN` rather than thrown: an unreadable check is
 * not evidence the pull request closed, and misreading it as closed would escalate a run for a reason
 * that has nothing to do with the pull request itself. The one fact this *can* assert is a real `MERGED`
 * with a real commit oid, which only a successful, parseable answer produces.
 */
export const checkPullRequestMerged: MergeCheckPort = async (context) => {
  const gh = context.gh ?? realGhCall;
  const result = await gh(
    ['pr', 'view', context.branch, '--json', 'state,mergeCommit'],
    context.repository,
  );
  const open: MergeCheck = { state: 'OPEN', mergeCommit: null };
  if (result.status !== 0) return open;

  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    return open;
  }
  if (typeof parsed !== 'object' || parsed === null) return open;
  const record = parsed as Record<string, unknown>;
  const state = record['state'];
  if (state === 'CLOSED') return { state: 'CLOSED', mergeCommit: null };
  if (state !== 'MERGED') return open;

  const mergeCommitField = record['mergeCommit'];
  const oid =
    typeof mergeCommitField === 'object' && mergeCommitField !== null
      ? (mergeCommitField as Record<string, unknown>)['oid']
      : null;
  // `gh` reports `state: "MERGED"` with no `mergeCommit` only for a state this build cannot fully read;
  // treated as not-yet-actionable rather than as a merge with nothing to attach a note to.
  return typeof oid === 'string' && oid !== '' ? { state: 'MERGED', mergeCommit: oid } : open;
};

/**
 * Refused cleanly, by name — matrix row 9. `git_tag` and `domain_mutation` reach the enumerated
 * dispatch below like every other kind; neither has a real performer, so this is thrown instead of an
 * unbuilt or silently no-op one.
 */
export class WriteKindNotImplemented extends Error {
  readonly code = 'write.kind_unimplemented';
  readonly kind: WriteIntentKind;
  readonly orchError: OrchError;

  constructor(intent: WriteIntent) {
    const message =
      `Refusing to perform the "${intent.kind}" write intent (${intent.intent_id}): nothing in this ` +
      `codebase composes a ${intent.kind} intent yet, so this is a named gap rather than an unbuilt or ` +
      'silently no-op performer. Only git_push, pull_request and git_note have a real performer today.';
    super(message);
    this.name = 'WriteKindNotImplemented';
    this.kind = intent.kind;
    this.orchError = makeError(this.code, message);
  }
}

const detailOf = (result: WriteCallResult): string =>
  result.stderr.trim() !== ''
    ? result.stderr.trim()
    : result.stdout.trim() !== ''
      ? result.stdout.trim()
      : `exited with status ${String(result.status)}`;

const recordAttempted = (intent: WriteIntent, context: WriteExecutionContext): void => {
  context.emit(WRITE_ATTEMPTED_EVENT_TYPE, {
    [WRITE_ATTEMPTED_PAYLOAD_KEYS.IntentId]: intent.intent_id,
    [WRITE_ATTEMPTED_PAYLOAD_KEYS.Kind]: intent.kind,
    [WRITE_ATTEMPTED_PAYLOAD_KEYS.Target]: intent.target,
  });
};

const recordExecuted = (
  intent: WriteIntent,
  context: WriteExecutionContext,
  alreadyPresent: boolean,
  detail: string,
): WriteIntentResult => {
  context.emit(WRITE_EXECUTED_EVENT_TYPE, {
    [WRITE_EXECUTED_PAYLOAD_KEYS.IntentId]: intent.intent_id,
    [WRITE_EXECUTED_PAYLOAD_KEYS.Kind]: intent.kind,
    [WRITE_EXECUTED_PAYLOAD_KEYS.Target]: intent.target,
    [WRITE_EXECUTED_PAYLOAD_KEYS.AlreadyPresent]: alreadyPresent,
    [WRITE_EXECUTED_PAYLOAD_KEYS.Detail]: detail,
  });
  return { status: 'executed', alreadyPresent, detail };
};

const recordFailed = (
  intent: WriteIntent,
  context: WriteExecutionContext,
  code: string,
  reason: string,
): WriteIntentResult => {
  context.emit(WRITE_FAILED_EVENT_TYPE, {
    [WRITE_FAILED_PAYLOAD_KEYS.IntentId]: intent.intent_id,
    [WRITE_FAILED_PAYLOAD_KEYS.Kind]: intent.kind,
    [WRITE_FAILED_PAYLOAD_KEYS.Target]: intent.target,
    [WRITE_FAILED_PAYLOAD_KEYS.Code]: code,
    [WRITE_FAILED_PAYLOAD_KEYS.Reason]: reason,
  });
  return { status: 'failed', error: makeError(code, reason) };
};

/**
 * `git_push` — matrix rows 1, 2, 7.
 *
 * Durable-before-call, then reconcile: read the worktree's own `HEAD`, ask the remote what
 * `refs/heads/<target>` already carries, and only push when the two disagree. A crash between the
 * `write.attempted` line and the outcome — whether the push had already landed or not — is resolved
 * identically by the next attempt asking the same question again.
 */
const performGitPush = (intent: WriteIntent, context: WriteExecutionContext): WriteIntentResult => {
  const git = context.git ?? realGitCall;
  recordAttempted(intent, context);

  const head = git(['rev-parse', 'HEAD'], context.repository);
  if (head.status !== 0) {
    return recordFailed(
      intent,
      context,
      'write.push_failed',
      `could not read the worktree's HEAD to push: ${detailOf(head)}`,
    );
  }
  const expected = head.stdout.trim();

  const remote = git(['ls-remote', REMOTE, `refs/heads/${intent.target}`], context.repository);
  if (remote.status === 0) {
    const [sha] = remote.stdout.trim().split(/\s+/);
    if (sha !== undefined && sha === expected) {
      return recordExecuted(
        intent,
        context,
        true,
        `${REMOTE}/${intent.target} already carries the expected commit`,
      );
    }
  }

  // Never `--force`: `WriteIntentSchema` carries no field through which one could be asked for, and
  // this is the other half of that decision — the call this shape can never be made to issue.
  const push = git(['push', REMOTE, `HEAD:refs/heads/${intent.target}`], context.repository);
  if (push.status !== 0) {
    return recordFailed(
      intent,
      context,
      'write.push_failed',
      `git push to ${REMOTE}/${intent.target} failed: ${detailOf(push)}`,
    );
  }
  return recordExecuted(intent, context, false, `pushed to ${REMOTE}/${intent.target}`);
};

/** The shape of one entry `gh pr list --json number,url` returns. Read defensively; `gh`'s own concern. */
interface ExistingPullRequest {
  readonly number?: unknown;
  readonly url?: unknown;
}

const firstExisting = (stdout: string): ExistingPullRequest | null => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || parsed.length === 0) return null;
  const values: unknown[] = parsed as unknown[];
  const first: unknown = values[0];
  return typeof first === 'object' && first !== null ? first : null;
};

/**
 * `pull_request` — matrix rows 1, 3, 7.
 *
 * Durable-before-call, then reconcile: `gh pr list --head <branch>` before `gh pr create`, so a PR
 * opened by an earlier attempt that crashed before recording its outcome is found, not duplicated.
 */
const performPullRequest = async (
  intent: WriteIntent,
  context: WriteExecutionContext,
): Promise<WriteIntentResult> => {
  const gh = context.gh ?? realGhCall;
  recordAttempted(intent, context);

  const list = await gh(
    ['pr', 'list', '--head', context.pullRequest.head, '--state', 'all', '--json', 'number,url'],
    context.repository,
  );
  if (list.status !== 0) {
    // A failed read is not "nothing found": proceeding to `gh pr create` here would risk opening a
    // second pull request for a branch that already has one, exactly the duplicate matrix row 3 exists
    // to prevent. Refuse instead of guessing.
    return recordFailed(
      intent,
      context,
      'write.pull_request_failed',
      `gh pr list --head ${context.pullRequest.head} failed, so whether a pull request already exists ` +
        `could not be checked: ${detailOf(list)}`,
    );
  }
  const existing = firstExisting(list.stdout);
  if (existing !== null) {
    const number = typeof existing.number === 'number' ? existing.number : null;
    const url = typeof existing.url === 'string' ? existing.url : '';
    return recordExecuted(
      intent,
      context,
      true,
      `a pull request from ${context.pullRequest.head} already exists` +
        (number === null ? '' : ` (#${String(number)})`) +
        (url === '' ? '' : `: ${url}`),
    );
  }

  const create = await gh(
    ['pr', 'create', '--head', context.pullRequest.head, '--title', context.pullRequest.title, '--body', context.pullRequest.body],
    context.repository,
  );
  if (create.status !== 0) {
    return recordFailed(
      intent,
      context,
      'write.pull_request_failed',
      `gh pr create from ${context.pullRequest.head} failed: ${detailOf(create)}`,
    );
  }
  const url = create.stdout.trim();
  return recordExecuted(
    intent,
    context,
    false,
    `opened a pull request from ${context.pullRequest.head}${url === '' ? '' : `: ${url}`}`,
  );
};

/**
 * `git_note` was asked for before a merge commit was known.
 *
 * A programming error in the caller, never a runtime condition a re-run recovers from: the reconciler is
 * the only caller, and it holds this intent back until `checkPullRequestMerged` has reported a real
 * `MERGED` with a commit oid (`src/engine/reconciler.ts`'s `awaiting_merge` handling). Thrown rather than
 * returned as a `WriteIntentResult` for the same reason {@link WriteKindNotImplemented} is: it is not an
 * outcome of trying, it is a call that should not have been made.
 */
export class NoteMergeCommitUnknown extends Error {
  readonly code = 'internal.invariant_violated';
  readonly orchError: OrchError;

  constructor(intent: WriteIntent) {
    const message =
      `Refusing to perform the "git_note" intent (${intent.intent_id}) with no merge commit: a note is ` +
      'attached to a specific commit, and attaching it to anything before a real merge commit is known ' +
      'would silently bind AD-22’s record to the wrong object. The caller must hold this intent back ' +
      'until a merge is confirmed.';
    super(message);
    this.name = 'NoteMergeCommitUnknown';
    this.orchError = makeError(this.code, message);
  }
}

/**
 * Whether the local notes ref's own tip is exactly what `origin` already carries.
 *
 * This is the fix for the gap a local-only `git notes show` cannot see: `git notes add` landing locally
 * and the process crashing *before* `git push` leaves a worktree that can `show` its own note forever,
 * with the note never having reached the remote at all. AD-15's "the effect landed" means landed on
 * `origin` — the durable, shared copy — never merely written to this one worktree's refs. Comparing the
 * local ref's tip to what `git ls-remote` reports is what tells the two apart: they agree only once a
 * push has actually succeeded.
 */
const notePushedToRemote = (git: GitCall, repository: string, ref: string): boolean => {
  const local = git(['rev-parse', ref], repository);
  if (local.status !== 0) return false;
  const remote = git(['ls-remote', REMOTE, ref], repository);
  if (remote.status !== 0) return false;
  const [remoteSha] = remote.stdout.trim().split(/\s+/);
  return remoteSha !== undefined && remoteSha !== '' && remoteSha === local.stdout.trim();
};

/**
 * `git_note` — matrix rows 1, 5, 6, 7.
 *
 * Durable-before-call, then reconcile: fetch the merge commit itself from `origin` first (a worktree
 * checked out on the feature branch does not necessarily hold the base branch's history the merge commit
 * lands on), then ask whether that commit already carries a note *and that note has actually reached
 * `origin`* ({@link notePushedToRemote}) before adding and pushing one. Always called with
 * `context.mergeCommit` already proven non-null by {@link performWriteIntent}'s dispatch.
 */
const performGitNote = (
  intent: WriteIntent,
  context: WriteExecutionContext,
  mergeCommit: string,
): WriteIntentResult => {
  const git = context.git ?? realGitCall;
  recordAttempted(intent, context);

  // Best-effort: a repository where the object is already present (the common case, once `git_push` has
  // run in this same worktree) has nothing to fetch, and a fetch failure here is not itself a write
  // failure — the `show` and `add` calls below are what actually decide whether this attempt succeeds.
  git(['fetch', REMOTE, mergeCommit], context.repository);

  const localShow = git(['notes', `--ref=${intent.target}`, 'show', mergeCommit], context.repository);
  if (localShow.status === 0) {
    if (notePushedToRemote(git, context.repository, intent.target)) {
      return recordExecuted(
        intent,
        context,
        true,
        `${mergeCommit.slice(0, 12)} already carries a note under ${intent.target}, already on ${REMOTE}`,
      );
    }
    // A prior attempt added the note locally and crashed before pushing the ref — recorded here as
    // matrix row 6's own crash point, one step later than the "no local note at all" case below. The
    // effect has not landed (AD-15), so the push still has to happen; nothing is added a second time.
    const recoveryPush = git(['push', REMOTE, intent.target], context.repository);
    if (recoveryPush.status !== 0) {
      return recordFailed(
        intent,
        context,
        'git.note_write_failed',
        `${mergeCommit.slice(0, 12)} carries a note only in this worktree; pushing ${intent.target} to ` +
          `${REMOTE} to make it durable failed: ${detailOf(recoveryPush)}`,
      );
    }
    return recordExecuted(
      intent,
      context,
      false,
      `pushed the note under ${intent.target} to ${REMOTE} that a previous, interrupted attempt had ` +
        `only added locally on ${mergeCommit.slice(0, 12)}`,
    );
  }

  const body = `${JSON.stringify(context.note, null, 2)}\n`;
  // `-f`: tolerate a note an aborted prior attempt already added locally that this `show` still failed
  // to find (a narrower race than the one above — a stale local ref view rather than a genuine crash
  // point). The content is deterministic, composed once and read from disk on every attempt
  // (`src/engine/reconciler.ts`'s `commit/composed.json`), so forcing an identical overwrite loses
  // nothing; it is never a real conflict between two different notes.
  const add = git(
    ['notes', `--ref=${intent.target}`, 'add', '-f', '-F', '-', mergeCommit],
    context.repository,
    body,
  );
  if (add.status !== 0) {
    return recordFailed(
      intent,
      context,
      'git.note_write_failed',
      `git notes add under ${intent.target} failed: ${detailOf(add)}`,
    );
  }

  const push = git(['push', REMOTE, intent.target], context.repository);
  if (push.status !== 0) {
    return recordFailed(
      intent,
      context,
      'git.note_write_failed',
      `git push of ${intent.target} to ${REMOTE} failed: ${detailOf(push)}`,
    );
  }
  return recordExecuted(
    intent,
    context,
    false,
    `attached a note under ${intent.target} to ${mergeCommit.slice(0, 12)}`,
  );
};

/** A `never`-typed guard, so a `WriteIntentKind` added later without a case above fails to compile. */
const assertNeverWriteIntentKind = (kind: never): never => {
  throw new Error(`Unhandled write intent kind: ${String(kind)}`);
};

/**
 * Perform one AD-15 write intent, enumerated and exhaustive over every {@link WriteIntentKind}.
 *
 * The switch is the whole of the dispatch: three real performers, and two named refusals. A sixth kind
 * added to {@link WriteIntentKind} later without a case here is a compile-time error at
 * `assertNeverWriteIntentKind`'s call, never a silently-ignored write.
 */
export const performWriteIntent: WriteExecutorPort = async (
  intent: WriteIntent,
  context: WriteExecutionContext,
): Promise<WriteIntentResult> => {
  switch (intent.kind) {
    case 'git_push':
      return performGitPush(intent, context);
    case 'pull_request':
      return performPullRequest(intent, context);
    case 'git_note':
      if (context.mergeCommit === null) throw new NoteMergeCommitUnknown(intent);
      return performGitNote(intent, context, context.mergeCommit);
    case 'git_tag':
    case 'domain_mutation':
      throw new WriteKindNotImplemented(intent);
    default:
      return assertNeverWriteIntentKind(intent.kind);
  }
};
