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
import { mkdirSync, writeFileSync } from 'node:fs';

import { formatTimestamp, renderCause } from '../contracts/index.js';
import type { FeatureState, StepRecord } from '../contracts/index.js';
import { redactValue, takeoverBranchFor } from '../runtime/index.js';
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

/** What the escape hatch did with the partial work. */
export interface EscapeHatchOutcome {
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
   */
  readonly failure: string | null;
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
}): EscapeHatchOutcome => {
  const git = request.git ?? execFileWorktreeGit;
  const branch = takeoverBranchFor(request.run);

  const status = git(request.worktree, ['status', '--porcelain']);
  if (status.status !== 0) {
    return {
      branch,
      commit: null,
      preserved: false,
      detail:
        `The work is still in the worktree at ${request.worktree}. It could not be put on a branch ` +
        'because git would not report the worktree state.',
      failure: status.stderr.trim() || 'git status did not answer',
    };
  }
  const dirty = status.stdout.trim() !== '';

  const exists = git(request.worktree, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]);
  const switched =
    exists.status === 0
      ? git(request.worktree, ['checkout', branch])
      : git(request.worktree, ['checkout', '-b', branch]);
  if (switched.status !== 0) {
    return {
      branch,
      commit: null,
      preserved: false,
      detail:
        `The work is still in the worktree at ${request.worktree}, uncommitted and untouched. The ` +
        `branch ${branch} could not be created or checked out.`,
      failure: switched.stderr.trim() || 'git checkout did not answer',
    };
  }

  if (!dirty) {
    const head = git(request.worktree, ['rev-parse', 'HEAD']);
    return {
      branch,
      commit: head.status === 0 ? head.stdout.trim() : null,
      preserved: false,
      detail:
        `Everything the run had done was already committed, and the branch ${branch} now points at it. ` +
        'There was no uncommitted work left to save.',
      failure: null,
    };
  }

  const staged = git(request.worktree, ['add', '-A']);
  const committed =
    staged.status === 0
      ? git(request.worktree, [
          'commit',
          '-m',
          `orch: partial work from run ${request.run} (${request.feature})`,
        ])
      : staged;
  if (committed.status !== 0) {
    return {
      branch,
      commit: null,
      preserved: false,
      detail:
        `The work is on the branch ${branch} in the worktree at ${request.worktree} but could not be ` +
        'committed, so it is there as uncommitted changes. Nothing was discarded.',
      failure: committed.stderr.trim() || 'git commit did not answer',
    };
  }

  const head = git(request.worktree, ['rev-parse', 'HEAD']);
  return {
    branch,
    commit: head.status === 0 ? head.stdout.trim() : null,
    preserved: true,
    detail: `The partial work is committed on the branch ${branch} in ${request.worktree}.`,
    failure: null,
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

/** How a step's record reads in prose, in the second person's terms rather than the enum's. */
const stepPhrase = (record: StepRecord): string => {
  switch (record.disposition) {
    case 'completed':
      return 'finished';
    case 'failed':
      return record.attempts > 1
        ? `failed on all ${String(record.attempts)} attempts`
        : 'failed on its first attempt';
    case 'blocked':
      return 'stopped at a gate it was not allowed to pass on its own';
    case 'interrupted':
      return 'was interrupted part-way through';
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

  const whereTheWorkIs: string[] = [];
  if (brief.escape !== null) {
    whereTheWorkIs.push(brief.escape.detail);
    if (brief.escape.commit !== null) {
      whereTheWorkIs.push(`The branch is at commit \`${brief.escape.commit}\`.`);
    }
    whereTheWorkIs.push(`Pick it up with \`git checkout ${brief.escape.branch}\`.`);
  } else {
    whereTheWorkIs.push(
      `Whatever the run had done is in the worktree at \`${brief.worktree}\`, on whichever branch it ` +
        'was working on. Nothing was reverted and nothing was deleted.',
    );
  }

  const nextSteps: string[] = [];
  if (brief.escape !== null) {
    nextSteps.push(
      `Look at the branch — \`git checkout ${brief.escape.branch}\` — and decide whether the partial ` +
        'work is worth keeping.',
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

  const lines: string[] = [
    `# ${brief.feature} — handed off`,
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
      'Neither will change on its own: no later pass picks a handed-off run back up.',
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

/** Write the document, replacing any earlier one whole, so a repeated hand-off is safe. */
export const writeHandoffDocument = (
  paths: RunPaths,
  brief: HandoffBrief,
  policy: RedactionPolicy = {},
): string => {
  mkdirSync(paths.runDir, { recursive: true });
  writeFileSync(paths.handoffDocument, renderHandoffDocument(brief, policy), 'utf8');
  return paths.handoffDocument;
};

/** The timestamp a brief is written with, in the one format the system uses. */
export const handoffTimestamp = (at: Date = new Date()): string => formatTimestamp(at);
