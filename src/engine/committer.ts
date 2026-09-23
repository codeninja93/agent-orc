/**
 * AD-22's committer: the one unit that names a feature branch, and the only composer of the git note.
 *
 * **This story composes intents and performs none of them.** AD-15 enumerates the write surface —
 * `git push`, pull request creation, git notes, tags, MCP domain mutations — and makes the *engine* its
 * executor, exactly once against an idempotency key of run id plus intent id. The executor is story
 * 2-11's, along with the durability rule that a `write.attempted` record carrying that key is durable
 * before the call is made. So nothing here pushes, opens a pull request or writes a note; what it produces
 * is values, and `tests/engine.protection.test.ts` holds the whole of `src/` to performing none of those.
 *
 * **The note's content comes from the run's record, never from the model.** AD-22 names what the note
 * carries and every item is a fact the engine already holds in `events.jsonl` and `state.json`. The
 * committing agent composes the pull-request prose and is handed none of it; see
 * `src/contracts/committing.ts` for the refusal that keeps it that way.
 *
 * **The branch name comes from the profile, and from nowhere else.** AD-22: "the pattern is declared once
 * in the project profile, defaulting to `feature/<feature-slug>`, the committer is the only unit that
 * creates or names a branch, and no other unit may infer a branch name from a feature slug". The two
 * other branches the system names — `orch/run/<run-id>` in `src/pool/worktree.ts` and
 * `orch/takeover/<run-id>` in `src/runtime/branches.ts` — are keyed on the run id precisely so they cannot
 * pre-empt this one, and `tests/engine.committer.test.ts` recursively holds every other unit to deriving
 * no branch name from a slug while leaving those two alone.
 */
import {
  DEFAULT_BRANCH_PATTERN,
  BRANCH_SLUG_PLACEHOLDERS,
  GitNoteSchema,
  NOTE_REF,
  NOTE_SCHEMA_VERSION,
  WriteIntentSchema,
  branchPatternProblem,
  branchPatternVaries,
  makeError,
} from '../contracts/index.js';
import type {
  DecisionRecord,
  GitNote,
  OrchError,
  StepDisposition,
  StepPhase,
  StepUsage,
  WriteIntent,
  WriteIntentKind,
} from '../contracts/index.js';
import { UnsafePathSegmentError, assertSafePathSegment } from '../runtime/paths.js';

/** The AD-35 code a profile the engine cannot act on crosses a unit boundary as. */
export const BRANCH_PATTERN_REFUSED_CODE = 'config.invalid';

/**
 * Refusal to name a branch from a pattern that cannot name more than one.
 *
 * Typed rather than a bare `Error` because it is a *configuration* fault with a declared disposition —
 * `config.invalid` is `escalate-to-human`, and nothing retries its way out of a profile — and because the
 * caller reporting it to a person needs the pattern back to quote it.
 */
export class BranchPatternRefused extends Error {
  readonly code = BRANCH_PATTERN_REFUSED_CODE;
  readonly pattern: string;

  constructor(message: string, pattern: string) {
    super(message);
    this.name = 'BranchPatternRefused';
    this.pattern = pattern;
  }
}

/**
 * The run's record could not make a valid AD-22 note.
 *
 * `config.invalid` rather than a code of its own: what failed is the *record* the engine assembled, and
 * AD-35 has no code for "the engine built a bad artifact" that a caller would route differently. The
 * run id travels on the error because a caller reporting this has nothing else to name.
 */
export class NoteUncomposable extends Error {
  readonly code = BRANCH_PATTERN_REFUSED_CODE;
  readonly run: string;
  readonly orchError: OrchError;

  constructor(run: string, problems: readonly string[]) {
    const detail = problems.join('; ');
    const message =
      `Refusing to compose the AD-22 note for run ${run}: the run's record does not make a valid ` +
      `note (${detail}). The note carries what the engine observed, so this is a fault in the record ` +
      'and never in anything a model returned.';
    super(message);
    this.name = 'NoteUncomposable';
    this.run = run;
    this.orchError = makeError(this.code, message, detail);
  }
}

/**
 * The profile's branch pattern, or the default when the profile declares none.
 *
 * An empty string is treated as "nobody answered" rather than as an answer, which is the one place this
 * differs from `project.remote`: an empty remote is a repository saying it has no remote, and there is no
 * corresponding statement a person could mean by an empty branch pattern.
 */
export const branchPatternOf = (pattern: string | null | undefined): string =>
  pattern === null || pattern === undefined || pattern.trim() === ''
    ? DEFAULT_BRANCH_PATTERN
    : pattern.trim();

/**
 * The branch this feature's work lands on, from the profile's pattern.
 *
 * **A pattern with no slug placeholder is refused here, where it is read.** It is also refused at the
 * interview, where a person can fix it by typing something else — but a profile is a file, and a file can
 * be edited after the interview. A pattern that cannot vary yields one branch for every feature, so the
 * second feature would push onto the first feature's branch; refusing at read is what makes that a named
 * configuration fault instead of two features quietly sharing a ref.
 *
 * The slug is validated as a path segment rather than trusted, for the reason `takeoverBranchFor` gives:
 * a branch name reaches `git` as an argument and reaches a person as something to type.
 */
export const branchFor = (pattern: string | null | undefined, featureSlug: string): string => {
  const declared = branchPatternOf(pattern);
  if (!branchPatternVaries(declared)) {
    throw new BranchPatternRefused(
      `Refusing the branch pattern "${declared}": it carries no ` +
        `${BRANCH_SLUG_PLACEHOLDERS.join(' and no ')}, so it names one branch for every feature and the ` +
        'second feature would push onto the first one’s. AD-22 makes the pattern a template ' +
        'declared once in the profile; put the placeholder where the feature slug belongs, as in ' +
        `"${DEFAULT_BRANCH_PATTERN}".`,
      declared,
    );
  }
  /**
   * The pattern is checked for git-ref safety as well as for a placeholder.
   *
   * A pattern is a template for an argument `git` receives, and `feature/../<slug>`, a leading `-`, a
   * space, a `~^:?*`, a `//` or a `.lock` tail all reach argv unchallenged otherwise — the placeholder
   * check answers "can this name two branches", not "is this a branch name".
   */
  const problem = branchPatternProblem(declared);
  if (problem !== null) {
    throw new BranchPatternRefused(
      `Refusing the branch pattern "${declared}": ${problem}. AD-22 makes the pattern a template for a ` +
        'git branch name, and the name it produces reaches `git` as an argument and reaches a person ' +
        'as something to type.',
      declared,
    );
  }
  /**
   * A slug that is not a safe path segment is refused with a code, not with a bare throw.
   *
   * `UnsafePathSegmentError` crosses a unit boundary here, and AD-35 requires every failure that does to
   * carry a declared disposition. Without the wrap a caller routing this got the unknown-code fallback,
   * which is `abandon-and-hand-off` — the right severity by accident and for no stated reason.
   */
  let slug: string;
  try {
    slug = assertSafePathSegment(featureSlug, 'a feature slug');
  } catch (thrown: unknown) {
    if (!(thrown instanceof UnsafePathSegmentError)) throw thrown;
    throw new BranchPatternRefused(
      `Refusing to name a branch for feature "${featureSlug}": ${thrown.message}`,
      declared,
    );
  }
  // Longest placeholder first, because `<slug>` does not occur inside `<feature-slug>`: replacing the
  // short one first would leave `feature/<feature-slug>` untouched and yield a branch with the
  // placeholder still in its name.
  return BRANCH_SLUG_PLACEHOLDERS.reduce(
    (name, placeholder) => name.split(placeholder).join(slug),
    declared,
  );
};

/** One step of the run, as the record hands it to the committer. */
export interface CommittedStep {
  readonly step: string;
  readonly phase: StepPhase;
  readonly disposition: StepDisposition;
}

/**
 * Everything the note carries, as the *engine* holds it.
 *
 * Every field is a fact from `events.jsonl` or `state.json`. There is deliberately no field a model fills:
 * the committing agent's whole output is the prose below, and this is the other half of the split story
 * 2-6's review asked for.
 */
export interface CommitRunRecord {
  readonly run: string;
  readonly feature: string;
  /** In the order the run met them (AD-22: "the ordered step list"). */
  readonly steps: readonly CommittedStep[];
  readonly acceptance_criteria: readonly string[];
  /** The run's totals, or `null` when no step reported any. Never a zeroed record. */
  readonly usage: StepUsage | null;
  readonly decisions: readonly DecisionRecord[];
}

/** The prose the committing agent composed, and the only thing it contributes. */
export interface PullRequestProse {
  readonly title: string;
  readonly body: string;
}

/**
 * The pull request the engine will open, prose and head branch together.
 *
 * **There is deliberately no identity field.** The invoke note says the pull request is opened "under the
 * user's own git identity", and that is a fact about the process rather than a value to carry: AD-1
 * asserts subscription authentication at startup and refuses to run in API-key mode, and story 2-11's
 * executor pushes with whatever git identity the host process already holds. A field here would be a
 * second place an identity could be stated, and the only thing it could do is disagree with the one that
 * will actually be used — which is how a pull request comes to be attributed to somebody who did not
 * open it. This is a decision stated, not a mechanism left unbuilt.
 */
export interface PullRequestPlan {
  readonly title: string;
  readonly body: string;
  /** The branch the committer named. Never one inferred elsewhere (AD-22). */
  readonly head: string;
}

/** What a committing step produces: the values story 2-11's executor acts on, and none of the effects. */
export interface ComposedCommit {
  readonly branch: string;
  readonly pull_request: PullRequestPlan;
  readonly note: GitNote;
  /** In a fixed order: push, then pull request, then note. */
  readonly intents: readonly WriteIntent[];
}

export interface ComposeCommitRequest {
  readonly record: CommitRunRecord;
  /** The profile's `branch_pattern`; `null` uses AD-22's default. */
  readonly branchPattern?: string | null;
  readonly prose: PullRequestProse;
  /** The step id the intents are attributed to, which is what makes their ids stable. */
  readonly step: string;
}

/**
 * The intent id for one write of one step.
 *
 * **Derived, never minted.** With the run id this is AD-15's idempotency key, and 2-11's executor
 * recognises a repeat by it — so an id taken from a clock, a counter or `crypto.randomUUID` would make
 * every re-run of the same step a *new* write, and AD-8's re-run safety would push twice and open two
 * pull requests. The step id and the kind are what identify the write, they are the same on every attempt,
 * and there is exactly one write of each kind per committing step, so the pair is unique within a run.
 *
 * It deliberately does not include the branch or the prose. Those are what the write *says*; the key is
 * what the write *is*, and a key that changed when a model reworded a title would defeat the recognition
 * it exists for.
 */
export const intentIdFor = (step: string, kind: WriteIntentKind): string => `${step}.${kind}`;

/**
 * The AD-22 note, composed from the run's record.
 *
 * Parsed on the way out rather than merely constructed, so a record that could not make a valid note is a
 * refusal here rather than an invalid artifact handed to 2-11's executor.
 */
export const noteFor = (record: CommitRunRecord, branch: string): GitNote => {
  const candidate = {
    schema_version: NOTE_SCHEMA_VERSION,
    run: record.run,
    feature: record.feature,
    branch,
    steps: record.steps.map((step) => ({
      step: step.step,
      phase: step.phase,
      disposition: step.disposition,
    })),
    acceptance_criteria: [...record.acceptance_criteria],
    usage: record.usage,
    decisions: record.decisions.map((decision) => ({ ...decision })),
  };
  const parsed = GitNoteSchema.safeParse(candidate);
  if (parsed.success) return parsed.data;
  /**
   * A record that could not make a valid note is a *named* refusal, not a raw `ZodError`.
   *
   * A `ZodError` escaping here carries no AD-35 code and no run id, so a caller could neither route it
   * through the disposition table nor say which run failed — and the reconciler catches this on the
   * path where a step has just completed, which is the worst moment to lose both.
   */
  throw new NoteUncomposable(record.run, parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`));
};

/**
 * The reversibility every one of the three writes carries.
 *
 * ADR-003 classes the `committing` agent `irreversible`, and these are its writes: a pushed branch, an
 * opened pull request and a note on a merge commit are all visible outside this machine the instant they
 * land. Classing the push `recoverable` because a branch can be deleted would be reasoning about the
 * repository rather than about the blast radius AD-12 gates on — the notification has already gone out.
 */
const COMMIT_WRITE_REVERSIBILITY = 'irreversible';

/**
 * Compose the three write intents a committing step declares, and the payloads they write.
 *
 * Nothing here performs a write. The `target` of each intent names what is written — the branch for the
 * push and the pull request, AD-22's single named ref for the note — and the payloads travel beside the
 * intents because {@link WriteIntentSchema} carries no body: a shape with a free-form payload field would
 * be a channel through which the enumerated surface stopped being enumerated.
 */
export const composeCommit = (request: ComposeCommitRequest): ComposedCommit => {
  const branch = branchFor(request.branchPattern, request.record.feature);
  const note = noteFor(request.record, branch);
  /**
   * Trimmed once, here, and used everywhere below.
   *
   * The untrimmed value used to reach the pull-request plan while the trimmed one reached the intent's
   * summary, so a title with a leading newline produced a plan and an intent that disagreed about what
   * the pull request is called — and the plan is the half that becomes the pull request.
   */
  const title = request.prose.title.trim();
  const body = request.prose.body.trim();

  const intent = (kind: WriteIntentKind, target: string, summary: string): WriteIntent =>
    WriteIntentSchema.parse({
      intent_id: intentIdFor(request.step, kind),
      kind,
      target,
      summary,
      reversibility: COMMIT_WRITE_REVERSIBILITY,
    });

  return {
    branch,
    pull_request: { title, body, head: branch },
    note,
    intents: [
      intent(
        'git_push',
        branch,
        `Push the work of run ${request.record.run} to "${branch}". Never a force: the intent shape ` +
          'has no field through which one could be asked for.',
      ),
      intent(
        'pull_request',
        branch,
        `Open a pull request from "${branch}"${title === '' ? '' : `: ${title}`}`,
      ),
      intent(
        'git_note',
        NOTE_REF,
        `Record run ${request.record.run} on the merge commit under ${NOTE_REF}, at note schema ` +
          `version ${String(NOTE_SCHEMA_VERSION)} (AD-22).`,
      ),
    ],
  };
};

/**
 * Where a composed commit is written, relative to the run directory.
 *
 * On disk and not in the event payload, because the note carries the run id — an unbroken ULID — and
 * AD-21's entropy sweep rewrites one wherever it appears in a payload. So this is the evidence plane and
 * `commit.composed` is the control-plane pointer to it (AD-23), which is the split every other large
 * value in this system already takes. It is not a second authority: the log line is the record that the
 * composition happened, and this file is the artifact it points at.
 */
export const COMPOSED_COMMIT_RELATIVE_PATH = 'commit/composed.json';

/**
 * Build the note's record from what the engine already holds.
 *
 * Every field comes from the checkpoint or the log and none from a model. `steps` is the checkpoint's own
 * step list, which is folded from `step.terminated` lines, so the dispositions are the engine's; the
 * criteria are the plan's; the usage is summed from the same lines the checkpoint was folded from; and
 * the decisions are the ledger's. A step still in flight is left out rather than defaulted, because
 * {@link NotedStepSchema} has no way to spell one and inventing a disposition for it is exactly the
 * invention this whole split exists to prevent.
 */
export const commitRunRecordFrom = (request: {
  readonly run: string;
  readonly feature: string;
  readonly steps: readonly { readonly step: string; readonly phase: StepPhase; readonly disposition: StepDisposition | null }[];
  readonly acceptanceCriteria: readonly string[];
  readonly usage: StepUsage | null;
  readonly decisions: readonly DecisionRecord[];
}): CommitRunRecord => ({
  run: request.run,
  feature: request.feature,
  steps: request.steps.flatMap((record) =>
    record.disposition === null
      ? []
      : [{ step: record.step, phase: record.phase, disposition: record.disposition }],
  ),
  acceptance_criteria: [...request.acceptanceCriteria],
  usage: request.usage,
  decisions: request.decisions.map((decision) => ({ ...decision })),
});
