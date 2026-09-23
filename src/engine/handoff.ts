/**
 * CAP-23 — the escape hatch and the hand-off document.
 *
 * Two things happen when the system gives up, and they are separable on purpose.
 *
 * **The work survives.** Partial work goes onto an ordinary git branch, so a person can `git checkout`
 * it and carry on with ordinary tools. The branch is named from the *run id* and never from a feature
 * slug: AD-22 gives the committer sole ownership of feature-branch naming and says no other unit may
 * infer a branch name from a slug, so this follows story 1-6's precedent — its worktree branch is
 * `orch/run/<run-id>` — with a prefix of its own.
 *
 * **A person is told what happened, in prose.** `interface-contract.md` asks for "a colleague's note,
 * not a stack trace", and this is the one artifact in the system whose audience is exclusively human and
 * whose failure mode is being *unreadable* rather than being incorrect. It answers four questions in
 * order — what was attempted, how far it got, where the work is, and what a person might do next — and
 * it addresses the work by feature name rather than by run id (R6).
 *
 * Neither is a shutdown handler. Both are invoked by a reconcile pass, so a crash cannot skip them the
 * way it skips a signal handler or an exit hook (AD-32). A crashed hand-off is simply written again, so
 * both operations here are idempotent: the branch is created or adopted, and the document is rewritten
 * whole.
 */
import { execFileSync } from 'node:child_process';
import { closeSync, fsyncSync, mkdirSync, openSync, renameSync, writeFileSync } from 'node:fs';

import { formatTimestamp, renderCause } from '../contracts/index.js';
import type { FeatureState, StepRecord } from '../contracts/index.js';
import { fsyncDirectory, redactValue, takeoverBranchFor } from '../runtime/index.js';
import type { RedactionPolicy, RunPaths } from '../runtime/index.js';

import { GIT_MAX_BUFFER_BYTES, GIT_TIMEOUT_MS } from './baseline.js';

/**
 * The take-over branch's name, re-exported from `src/runtime/branches.ts`.
 *
 * Story 1-11 moved the name, not the decision. The handoff card has to tell a person which branch their
 * work is on and the spine forbids `src/tui/` importing the engine, so the name lives where a renderer may
 * read it — and AD-22 still holds, because there is still exactly one function that names this branch and no
 * unit infers it from a feature slug. Re-exported here so every existing caller, and every existing engine
 * test, is unchanged. What did *not* move is everything below: whether a branch is created, what is
 * committed onto it, and what the document says are still this module's.
 */
export { TAKEOVER_BRANCH_PREFIX, takeoverBranchFor } from '../runtime/index.js';

/** What one `git` invocation did. A non-zero status is data here, never an exception. */
export interface GitResult {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * The port the escape hatch reaches git through.
 *
 * One function rather than a method per operation, because the escape hatch is a short sequence of
 * ordinary git commands and a port with six methods would be six things for a double to get subtly
 * wrong. The default runs real `git`; the suite drives a real repository, because "the work is present
 * on the branch" is a claim about git and a fake could not falsify it.
 */
export type WorktreeGit = (worktree: string, args: readonly string[]) => GitResult;

/** The real thing, bounded exactly as story 1-3's baseline git is: a timeout and a large buffer. */
export const execFileWorktreeGit: WorktreeGit = (worktree, args) => {
  try {
    const stdout = execFileSync('git', ['-C', worktree, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: GIT_MAX_BUFFER_BYTES,
    });
    return { status: 0, stdout, stderr: '' };
  } catch (thrown: unknown) {
    const error = thrown as { status?: number; stdout?: string; stderr?: string } | null;
    return {
      status: typeof error?.status === 'number' ? error.status : 1,
      stdout: error?.stdout ?? '',
      stderr: error?.stderr ?? renderCause(thrown) ?? 'git failed without a message',
    };
  }
};

/**
 * The committer identity a take-over commit falls back to.
 *
 * A repository with no `user.name` or `user.email` configured — a container, a CI checkout, a fresh
 * machine — fails `git commit` outright, and the one commit that fails is the one whose whole purpose is
 * to save a person's unfinished work. The identity is passed per-invocation with `-c`, so nothing is
 * written into the repository's config and a repository that *has* an identity keeps using its own.
 *
 * It is deliberately not a person's name: this commit was made by the orchestrator on a person's behalf,
 * and attributing it to them would put a commit in their history they did not make.
 */
export const TAKEOVER_COMMITTER_NAME = 'orch';
export const TAKEOVER_COMMITTER_EMAIL = 'orch@localhost';

/**
 * Why the escape hatch was invoked: a person taking the work over (CAP-23), or a run reaching one of
 * AD-24's ceilings.
 *
 * The git sequence is identical for both, and that is the point — story 2-9 hibernates *through* this
 * function rather than beside it, so AD-32's crash-safety is one implementation and not two that could
 * drift. What differs is what the outcome is evidence of. A take-over is a person's decision and a
 * ceiling is the budget's, and a branch, a commit message and a document that could not say which would
 * make a hibernated run indistinguishable from one somebody abandoned — which is exactly the difference a
 * person reading the branch later needs, because only one of them is worth restarting as it stands.
 */
export const ESCAPE_TRIGGERS = ['take-over', 'ceiling'] as const;

export type EscapeTrigger = (typeof ESCAPE_TRIGGERS)[number];

/** What the escape hatch did with the partial work. */
export interface EscapeHatchOutcome {
  /** What invoked it, carried back so every reader of the outcome can tell a ceiling from a take-over. */
  readonly trigger: EscapeTrigger;
  readonly branch: string;
  /** The commit the work landed on, or `null` when there was nothing uncommitted to commit. */
  readonly commit: string | null;
  /** True when uncommitted work was found and committed. */
  readonly preserved: boolean;
  /** One sentence for the hand-off document. */
  readonly detail: string;
  /**
   * Why the work could not be put on a branch, or `null` when it could.
   *
   * A failure here never discards anything and never retries for ever: the work stays in the worktree
   * exactly as the step left it, the document says so and says where, and the run still halts. Looping
   * on a git failure would turn "the work is never discarded" into "the run never stops".
   *
   * Every reader has to branch on it. `preserved`, `commit` and `detail` are all conditional on this
   * being `null`, and a document that told a person to `git checkout` a branch no `checkout -b` ever
   * created is the worst failure CAP-23 has — the whole point is the work surviving, and misdirection
   * costs more than silence.
   */
  readonly failure: string | null;
  /**
   * The branch the worktree was on before the take-over, once it has been put back on it.
   *
   * `null` when it was never left, or when it could not be restored. Story 1-6 gives the worktree its own
   * `orch/run/<run-id>` branch and reclaims it by that name, so a worktree abandoned on
   * `orch/takeover/<run-id>` is a worktree whose pool no longer recognises it. The name is read back out
   * of git rather than spelled here: AD-22 keeps branch naming in one place per namespace, and the engine
   * may not import `src/pool/` to borrow its prefix.
   */
  readonly restoredBranch: string | null;
}

/**
 * Put a run's partial work on an ordinary branch.
 *
 * Idempotent, because a crash between this and the line that records it must be safe to repeat: an
 * existing branch is adopted rather than refused, and a worktree with nothing uncommitted produces a
 * branch at the current commit and reports that there was nothing to add.
 */
export const escapeHatch = (request: {
  readonly run: string;
  readonly feature: string;
  readonly worktree: string;
  readonly git?: WorktreeGit;
  /** Defaults to a take-over, which is what every caller before story 2-9 was. */
  readonly trigger?: EscapeTrigger;
}): EscapeHatchOutcome => {
  const git = request.git ?? execFileWorktreeGit;
  const trigger = request.trigger ?? 'take-over';
  const branch = takeoverBranchFor(request.run);

  const status = git(request.worktree, ['status', '--porcelain']);
  if (status.status !== 0) {
    return {
      trigger,
      branch,
      commit: null,
      preserved: false,
      detail:
        `The work is still in the worktree at ${request.worktree}. It could not be put on a branch ` +
        'because git would not report the worktree state.',
      failure: status.stderr.trim() || 'git status did not answer',
      restoredBranch: null,
    };
  }
  const dirty = status.stdout.trim() !== '';

  /**
   * The branch the worktree is on now, read before anything switches it.
   *
   * Read rather than derived: story 1-6 names it `orch/run/<run-id>` and story 1-6's pool is what
   * reclaims it, and the engine may not import `src/pool/` to borrow that prefix. Whatever git says is
   * also more honest than whatever this module would guess.
   */
  const previous = git(request.worktree, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const previousBranch =
    previous.status === 0 && previous.stdout.trim() !== '' && previous.stdout.trim() !== 'HEAD'
      ? previous.stdout.trim()
      : null;

  const exists = git(request.worktree, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]);
  const switched =
    exists.status === 0
      ? git(request.worktree, ['checkout', branch])
      : git(request.worktree, ['checkout', '-b', branch]);
  if (switched.status !== 0) {
    return {
      trigger,
      branch,
      commit: null,
      preserved: false,
      detail:
        `The work is still in the worktree at ${request.worktree}, uncommitted and untouched. The ` +
        `branch ${branch} could not be created or checked out.`,
      failure: switched.stderr.trim() || 'git checkout did not answer',
      restoredBranch: null,
    };
  }

  /**
   * Put the worktree back where it was, once the work is safely on the take-over branch.
   *
   * Best effort, and never a failure of the escape hatch: the work is already committed by the time this
   * runs, so a worktree left on the take-over branch is untidy rather than lost. Reported either way, so
   * the untidiness is visible instead of assumed.
   */
  const restore = (): string | null => {
    if (previousBranch === null || previousBranch === branch) return null;
    return git(request.worktree, ['checkout', previousBranch]).status === 0 ? previousBranch : null;
  };

  if (!dirty) {
    const head = git(request.worktree, ['rev-parse', 'HEAD']);
    const commit = head.status === 0 ? head.stdout.trim() : null;
    return {
      trigger,
      branch,
      commit,
      preserved: false,
      detail:
        `Everything the run had done was already committed, and the branch ${branch} now points at it. ` +
        'There was no uncommitted work left to save.',
      failure: null,
      restoredBranch: restore(),
    };
  }

  const staged = git(request.worktree, ['add', '-A']);
  /**
   * `--no-verify`, and an identity if the repository has none.
   *
   * Both are defences for the environment this actually runs in rather than the one it was written in. A
   * repository with a `pre-commit` hook — a linter, a test run, a secret scanner — fails this commit for
   * reasons that have nothing to do with the commit: the hook is there to protect the *project's* history,
   * and this is not a contribution to it. It is a snapshot of unfinished work on a throwaway branch, made
   * so a person does not lose it, and a hook that vetoes it destroys exactly what CAP-23 exists to keep.
   */
  const committed =
    staged.status === 0
      ? git(request.worktree, [
          '-c',
          `user.name=${TAKEOVER_COMMITTER_NAME}`,
          '-c',
          `user.email=${TAKEOVER_COMMITTER_EMAIL}`,
          'commit',
          '--no-verify',
          '-m',
          /**
           * The commit says which trigger made it, because the commit is the one part of this that outlives
           * the run directory: `git log` on the take-over branch is where a person meets it months later,
           * and "hibernated at a run ceiling" and "taken over" call for different next moves.
           */
          trigger === 'ceiling'
            ? `orch: partial work from run ${request.run} (${request.feature}), hibernated at a run ceiling`
            : `orch: partial work from run ${request.run} (${request.feature})`,
        ])
      : staged;
  if (committed.status !== 0) {
    return {
      trigger,
      branch,
      commit: null,
      preserved: false,
      /**
       * Says where the work is, and does **not** say it is preserved.
       *
       * `preserved: false` and a non-null `failure` are what every reader branches on, and they have to
       * agree with this sentence: the changes are in the worktree, on the take-over branch, uncommitted.
       * A `git checkout` of that branch elsewhere would not find them, which is why the document must not
       * offer one.
       */
      detail:
        `The work could not be committed. It is still in the worktree at ${request.worktree}, as ` +
        `uncommitted changes, with the branch ${branch} checked out. Nothing was discarded, but nothing ` +
        'is on the branch either — the changes only exist in that directory.',
      failure: committed.stderr.trim() || 'git commit did not answer',
      restoredBranch: null,
    };
  }

  const head = git(request.worktree, ['rev-parse', 'HEAD']);
  return {
    trigger,
    branch,
    commit: head.status === 0 ? head.stdout.trim() : null,
    preserved: true,
    detail: `The partial work is committed on the branch ${branch} in ${request.worktree}.`,
    failure: null,
    restoredBranch: restore(),
  };
};

/** Everything the document needs. Composed by the reconciler, which is the unit that knows the run. */
export interface HandoffBrief {
  readonly run: string;
  readonly feature: string;
  readonly state: FeatureState;
  /** The user's original words, so the note opens with what they asked for. */
  readonly request: string;
  readonly acceptanceCriteria: readonly string[];
  /** The AD-35 code, or the hand-off marker, that routed here. */
  readonly code: string;
  /** Why the run stopped, in a sentence. */
  readonly reason: string;
  readonly steps: readonly StepRecord[];
  readonly worktree: string;
  /**
   * Where the evidence is, as two paths a person can open.
   *
   * Given as paths rather than described, because "the details are in the log" is the sentence that
   * makes a document useless. They are supplied by the caller rather than built here for a structural
   * reason as well: `src/engine/` names no event-log path of its own — the runtime owns that name, and
   * story 1-3's guard asserts the engine never spells it.
   */
  readonly runDirectory: string;
  readonly checkpoint: string;
  /** The escape hatch's outcome, when a take-over produced one. */
  readonly escape: EscapeHatchOutcome | null;
  readonly writtenAt: string;
}

/**
 * How a step's record reads in prose, in the second person's terms rather than the enum's.
 *
 * The attempt count appears wherever there was more than one, not only on the `failed` branch. The
 * bound was widened to cover every disposition that returns to the same step — a resume by session id
 * as much as a re-run — so the case it exists to catch is a step interrupted and resumed until the
 * allowance ran out, and that step rendered as "was interrupted part-way through" with no hint that it
 * had been picked up seven more times. A document that does not say how much was spent cannot explain
 * why the run stopped.
 */
const stepPhrase = (record: StepRecord): string => {
  const overAttempts = ` on all ${String(record.attempts)} attempts`;
  switch (record.disposition) {
    case 'completed':
      return 'finished';
    case 'failed':
      return record.attempts > 1 ? `failed${overAttempts}` : 'failed on its first attempt';
    case 'blocked':
      return 'stopped at a gate it was not allowed to pass on its own';
    case 'interrupted':
      return record.attempts > 1
        ? `was interrupted part-way through${overAttempts}`
        : 'was interrupted part-way through';
    case 'killed':
      return 'was stopped by a steering command, and is never re-run';
    case null:
      return 'was still running when everything stopped';
  }
};

/**
 * Redact one piece of free text.
 *
 * Applied field by field rather than to the whole document, and that is deliberate. The general pass
 * replaces any long unbroken high-entropy run — which is exactly what a run id, a branch name and a
 * commit SHA are — so running it over the finished document would blank out the three lines that tell a
 * person *where their work is*. Free text is where a credential could realistically appear, so free
 * text is what gets swept; the identifiers this unit generated itself do not.
 */
const clean = (text: string, policy: RedactionPolicy): string => {
  const result = redactValue(text, policy);
  return result.ok ? result.value : '[this sentence was withheld because it could not be redacted]';
};

const bullets = (lines: readonly string[]): string =>
  lines.length === 0 ? '- (none recorded)' : lines.map((line) => `- ${line}`).join('\n');

/**
 * Render the hand-off document.
 *
 * A pure function of the brief, so its register can be asserted without a run. The register is the
 * thing under test: prose a person can act on, no stack frames, no enum names standing in for
 * sentences, and the feature named in the first line because R6 says never to make a person know a run
 * id to understand a message.
 */
export const renderHandoffDocument = (
  brief: HandoffBrief,
  policy: RedactionPolicy = {},
): string => {
  const done = brief.steps.filter((step) => step.disposition === 'completed');
  const verified = done.filter((step) => step.phase === 'verification');
  const notVerified = brief.steps.filter(
    (step) => step.phase === 'verification' && step.disposition !== 'completed',
  );
  const lastError = [...brief.steps].reverse().find((step) => step.error !== null)?.error ?? null;

  /**
   * CAP-23's one sentence that must never be wrong: where the work is.
   *
   * Gated on `failure === null` throughout. When the escape hatch's git sequence failed, no branch was
   * created and nothing was committed to one — so telling a person to `git checkout` it sends them to a
   * ref that does not exist, and they conclude their work is gone. A document that says "it is in this
   * directory, uncommitted" is useful; a document that names a branch that was never created is worse
   * than no document at all, because it is the only thing they have to go on.
   */
  const whereTheWorkIs: string[] = [];
  if (brief.escape !== null && brief.escape.failure === null) {
    whereTheWorkIs.push(brief.escape.detail);
    if (brief.escape.commit !== null) {
      whereTheWorkIs.push(`The branch is at commit \`${brief.escape.commit}\`.`);
    }
    whereTheWorkIs.push(`Pick it up with \`git checkout ${brief.escape.branch}\`.`);
    if (brief.escape.restoredBranch !== null) {
      whereTheWorkIs.push(
        `The worktree itself is back on \`${brief.escape.restoredBranch}\`, where it was before.`,
      );
    }
  } else if (brief.escape !== null && brief.escape.failure !== null) {
    // The hatch ran and did not succeed. The `detail` already says where the changes actually are; it is
    // repeated here and nothing is added, because there is no branch to send anybody to.
    whereTheWorkIs.push(brief.escape.detail);
    whereTheWorkIs.push(
      `Git would not cooperate: ${clean(brief.escape.failure, policy)} Nothing was reverted and ` +
        'nothing was deleted — the changes are the files in that directory, exactly as the run left them.',
    );
  } else {
    whereTheWorkIs.push(
      `Whatever the run had done is in the worktree at \`${brief.worktree}\`, on whichever branch it ` +
        'was working on. Nothing was reverted and nothing was deleted.',
    );
  }

  const hibernated = brief.state === 'hibernated';
  const nextSteps: string[] = [];
  /**
   * A hibernated run stopped at an allowance, not on a failure, so its first next step is about the
   * allowance: the ceiling is declared in the profile, and a run's allowance is fixed at its start (AD-9), so
   * raising it means raising it there and starting again — picking up from the branch rather than from zero.
   */
  if (hibernated) {
    nextSteps.push(
      'This run was not failing — it reached the ceiling named at the top of this note. If the work is ' +
        'worth more than that allowance, raise that ceiling under `[ceilings]` in `.orch/profile.toml` and ' +
        'start a new run from the take-over branch named above; a running run never re-reads its profile, ' +
        'so raising it does not revive this one.',
    );
  }
  if (brief.escape !== null && brief.escape.failure === null) {
    nextSteps.push(
      `Look at the branch — \`git checkout ${brief.escape.branch}\` — and decide whether the partial ` +
        'work is worth keeping.',
    );
  } else if (brief.escape !== null) {
    // Same gate as "Where the work is", and it has to be the same: a next step that names a branch that
    // does not exist is the misdirection this document exists not to commit.
    nextSteps.push(
      `Open \`${brief.worktree}\` and look at the uncommitted changes there — that is where the partial ` +
        'work is. Commit them yourself if they are worth keeping.',
    );
  }
  if (lastError !== null) {
    nextSteps.push(
      `Read what went wrong below, fix the underlying cause, and start the feature again. Nothing ` +
        'here needs to be undone first.',
    );
  } else {
    nextSteps.push(
      'Start the feature again if you still want it; this run is finished and will not restart itself.',
    );
  }
  nextSteps.push(
    'If the request was the problem rather than the work, rewrite it and run it again — the criteria ' +
      'above are what was being built against.',
  );

  /**
   * The headline says which kind of stop this was, because a person decides differently about each.
   *
   * A run that hibernated at an AD-24 ceiling was *not* failing — it ran out of the allowance it was given —
   * so the same document opening "handed off" would read as a verdict on the work that nobody made. Keyed on
   * the state the run is entering rather than on the escape outcome, because a hibernation whose git sequence
   * failed is still a hibernation.
   */
  const lines: string[] = [
    `# ${brief.feature} — ${hibernated ? 'hibernated at a run ceiling' : 'handed off'}`,
    '',
    clean(brief.reason, policy),
    '',
    `I have stopped working on **${brief.feature}** and left everything where it is. Nothing was ` +
      'merged, and nothing was thrown away.',
    '',
    '## What I was asked to do',
    '',
    clean(brief.request, policy),
    '',
    'The acceptance criteria this was being built against:',
    '',
    bullets(brief.acceptanceCriteria.map((criterion) => clean(criterion, policy))),
    '',
    '## How far it got',
    '',
    brief.steps.length === 0
      ? 'No step ever started, so there is no partial work from a step to look at.'
      : bullets(brief.steps.map((step) => `**${step.step}** — ${stepPhrase(step)}.`)),
    '',
    verified.length === 0
      ? '**Nothing was verified.** No verification step finished, so treat anything that looks ' +
        'finished as unchecked.'
      : `**Verified:** ${verified.map((step) => step.step).join(', ')}.`,
    '',
    notVerified.length === 0
      ? '**Not verified:** nothing is outstanding on the verification side.'
      : `**Not verified:** ${notVerified.map((step) => step.step).join(', ')}.`,
    '',
    '## Why it stopped',
    '',
    lastError === null
      ? clean(brief.reason, policy)
      : `${clean(lastError.message, policy)}${
          lastError.cause === null ? '' : ` ${clean(lastError.cause, policy)}`
        }`,
    '',
    `In the system's own vocabulary this was \`${brief.code}\`, and the run is now \`${brief.state}\`. ` +
      `Neither will change on its own: no later pass picks a ${hibernated ? 'hibernated' : 'handed-off'} ` +
      'run back up.',
    '',
    '## Where the work is',
    '',
    bullets(whereTheWorkIs),
    '',
    '## What you might do next',
    '',
    nextSteps.map((step, index) => `${String(index + 1)}. ${step}`).join('\n'),
    '',
    '## If you want the detail',
    '',
    `Everything this run recorded is in \`${brief.runDirectory}\`. The append-only event log in there ` +
      `holds the full timeline, and \`${brief.checkpoint}\` is the checkpoint folded from it. Every ` +
      'steering command that touched this run, and who issued it, is in that log too — including who ' +
      'stopped it, if a person did.',
    '',
    `Written ${brief.writtenAt}.`,
    '',
  ];

  return lines.join('\n');
};

/** The suffix of a partly-written hand-off document, so nothing mistakes one for the document. */
const HANDOFF_TEMP_SUFFIX = '.tmp';

/** A monotonic per-process counter, so two writes in one millisecond cannot share a temp name. */
let handoffTempCounter = 0;

/**
 * Write the document, replacing any earlier one whole, so a repeated hand-off is safe.
 *
 * Atomically: temporary file in the same directory, `fsync`, rename, `fsync` the directory — the same
 * idiom `src/runtime/exclusive-create.ts` and the checkpoint writer use, and for a sharper reason than
 * either. This document is written *before* the facts that describe it reach the log, deliberately,
 * because a person having a bad day needs the note whether or not those lines landed. A plain
 * `writeFileSync` therefore had a window in which a crash left the one human-facing artifact in the
 * system truncated mid-sentence — and this was the only durable write in the hand-off path that was not
 * atomic, while being the one whose failure mode is a person concluding their work is gone.
 */
export const writeHandoffDocument = (
  paths: RunPaths,
  brief: HandoffBrief,
  policy: RedactionPolicy = {},
): string => {
  mkdirSync(paths.runDir, { recursive: true });
  handoffTempCounter += 1;
  const temp = `${paths.handoffDocument}.${String(process.pid)}.${String(
    handoffTempCounter,
  )}${HANDOFF_TEMP_SUFFIX}`;

  writeFileSync(temp, renderHandoffDocument(brief, policy), 'utf8');
  const fd = openSync(temp, 'r');
  try {
    fsyncSync(fd);
  } catch {
    // Unsynced contents are a durability weakness, not a truncated document: the rename is still atomic.
  }
  // Closed on both paths without a `finally`: nothing in `src/engine/` may read as cleanup on an exit
  // path, and AD-32's rule is asserted by a grep over this directory.
  closeSync(fd);
  renameSync(temp, paths.handoffDocument);
  fsyncDirectory(paths.runDir);
  return paths.handoffDocument;
};

/** The timestamp a brief is written with, in the one format the system uses. */
export const handoffTimestamp = (at: Date = new Date()): string => formatTimestamp(at);
