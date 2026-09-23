/**
 * Branch protection on the default branch, asserted at run start — and degrading honestly when it cannot
 * be asserted at all.
 *
 * ADR-001 states the requirement in one clause: "the executor holds no push and no production credential,
 * only the committer may push, force-push is never permitted, and branch protection on the default branch
 * is asserted at run start". The force-push half is structural and lives in `WriteIntentSchema`, which has
 * no field a force could be asked for through. This is the other half.
 *
 * **Three outcomes, not two.** A repository with no remote has no host to ask; a repository whose remote
 * exists but whose host the engine cannot reach has a host that did not answer; a repository that never
 * recorded which branch the remote treats as default has no branch to ask about. None of those is
 * "protected" and none of them is "unprotected" — they are *unknown*, and saying so is the whole of this
 * module's contribution. An unverifiable protection reported as satisfied is the failure mode: it reads
 * identically to a verified one on every surface, and the run proceeds under a guarantee nobody checked.
 * A test asserting only that no error was thrown would pass on exactly that bug, which is why
 * `tests/engine.protection.test.ts` asserts the three outcomes distinctly.
 *
 * **Only `unprotected` refuses the run.** Unknown is a fact the run records and continues from: refusing
 * every repository the engine cannot reach would make an offline machine unable to start a run, and the
 * honest report is what the requirement is for. The direction of that default is stated here rather than
 * discovered, because it is the one judgement in this file.
 *
 * Nothing here performs a write. The probe is a *read* of the host, supplied by the caller, and this
 * module holds no credential and opens no connection of its own.
 */
import { BRANCH_PROTECTION_ASSERTED_EVENT_TYPE } from '../contracts/index.js';
import { defaultBranch as recordedDefaultBranch } from '../runtime/repository.js';

/**
 * What the assertion concluded. `unknown` is a first-class answer and not an error case.
 */
export const BRANCH_PROTECTION_OUTCOMES = ['protected', 'unprotected', 'unknown'] as const;

export type BranchProtectionOutcome = (typeof BRANCH_PROTECTION_OUTCOMES)[number];

/** The AD-35 code an unprotected default branch crosses a unit boundary as; `escalate-to-human`. */
export const BRANCH_PROTECTION_CODE = 'write.branch_protection_violation';

/**
 * The event type a run records its assertion under, so the answer is in the log (AD-4).
 *
 * Re-exported from the shared vocabulary rather than spelled again: a type the engine writes under one
 * name and a renderer ignores under another is the drift AD-5's ignore-unknown rule makes silent.
 */
export { BRANCH_PROTECTION_ASSERTED_EVENT_TYPE };

/**
 * The payload keys of that line, spelled once so a reader and the writer cannot drift.
 *
 * `default_branch` and not `branch`, for two reasons that happen to agree. It names a different thing:
 * the branch a pull request would merge *into*, not the branch a feature's work is on. And `branch` is a
 * payload key story 1-11 forbade outright — `tests/tui.reconstruction.test.ts` asserts no payload carries
 * one — because the take-over branch embeds a ULID and AD-21's entropy sweep would rewrite it, leaving a
 * card quoting a redacted name. A default branch is `main` or `master`: low entropy, product-meaningful
 * and safe in a payload. Taking the forbidden key anyway and narrowing that guard would have weakened
 * another story's rule to make room for this one.
 */
export const BRANCH_PROTECTION_PAYLOAD_KEYS = {
  Outcome: 'outcome',
  Branch: 'default_branch',
  Reason: 'reason',
} as const;

export interface BranchProtectionReport {
  readonly outcome: BranchProtectionOutcome;
  /** The branch the assertion was about, or `null` when no branch could be identified. */
  readonly branch: string | null;
  /** Why this outcome, in one line that stands alone. Never blank, including for `protected`. */
  readonly reason: string;
}

/** What a probe is asked. It is given no credential and returns no data about the repository. */
export interface BranchProtectionQuery {
  readonly repositoryPath: string;
  readonly remote: string;
  readonly branch: string;
}

/**
 * A read of the host: `true` protected, `false` unprotected, `null` "the host did not say".
 *
 * `null` rather than a throw is the ordinary way to answer "could not be checked", and a throw is handled
 * as the same answer — a probe that raised is a host that did not answer, and treating an exception as a
 * negative would refuse a run for an unreachable network.
 */
export type BranchProtectionProbe = (query: BranchProtectionQuery) => boolean | null;

export interface BranchProtectionRequest {
  readonly repositoryPath: string;
  /** The profile's `project.remote`. Empty means the repository has no remote, which is a real answer. */
  readonly remote: string;
  /** The default branch, when the caller already knows it; otherwise it is read from the repository. */
  readonly branch?: string | null;
  /** The host read. Absent means nothing can ask, which is `unknown` and never `protected`. */
  readonly probe?: BranchProtectionProbe | null;
}

/**
 * The report for an engine that was handed no assertion at all.
 *
 * Named rather than synthesised at the call site, because the alternative a caller reaches for is a
 * request with an empty remote — which answers `unknown` for the right outcome and the wrong reason, and
 * tells a person their repository has no remote when in fact nothing asked.
 */
export const BRANCH_PROTECTION_NOT_CONFIGURED: BranchProtectionReport = {
  outcome: 'unknown',
  branch: null,
  reason:
    'no branch-protection assertion is configured for this engine, so the default branch could not be ' +
    'checked; this is reported as unknown and never as satisfied',
};

const unknown = (branch: string | null, reason: string): BranchProtectionReport => ({
  outcome: 'unknown',
  branch,
  reason,
});

/**
 * Assert branch protection, answering one of three outcomes and never throwing.
 *
 * The order of the checks is the order in which a fact makes the next question unaskable: with no remote
 * there is no host, with no default branch there is nothing to ask about, and with no probe there is
 * nobody to ask.
 */
export const checkBranchProtection = (
  request: BranchProtectionRequest,
): BranchProtectionReport => {
  if (request.remote.trim() === '') {
    return unknown(
      null,
      'the repository declares no remote, so there is no host to ask whether a branch is protected',
    );
  }
  const branch =
    request.branch === undefined || request.branch === null || request.branch.trim() === ''
      ? recordedDefaultBranch(request.repositoryPath)
      : request.branch.trim();
  if (branch === null || branch === '') {
    return unknown(
      null,
      'this repository records no default branch for its remote, so there is no branch to assert ' +
        'protection on; the checked-out branch is not an answer to which branch a pull request merges into',
    );
  }
  if (request.probe === undefined || request.probe === null) {
    return unknown(
      branch,
      `no host probe is configured, so "${branch}" could not be checked. This is reported as unknown ` +
        'and never as satisfied: an unverified protection that reads as verified is the failure this ' +
        'assertion exists to prevent.',
    );
  }
  let answer: boolean | null;
  try {
    answer = request.probe({
      repositoryPath: request.repositoryPath,
      remote: request.remote,
      branch,
    });
  } catch (thrown: unknown) {
    // A probe that raised is a host that did not answer. Reading a failure as "unprotected" would refuse
    // a run for an unreachable network, and reading it as "protected" would be the lie above.
    const detail = thrown instanceof Error ? thrown.message : String(thrown);
    return unknown(branch, `the host could not be reached to check "${branch}": ${detail}`);
  }
  if (answer === null) {
    return unknown(branch, `the host did not say whether "${branch}" is protected`);
  }
  return answer
    ? {
        outcome: 'protected',
        branch,
        reason: `"${branch}" is protected on ${request.remote}`,
      }
    : {
        outcome: 'unprotected',
        branch,
        reason: `"${branch}" is not protected on ${request.remote}`,
      };
};

/** Refusal to start a run against a repository whose default branch is unprotected. */
export class BranchProtectionRefused extends Error {
  readonly code = BRANCH_PROTECTION_CODE;
  readonly branch: string;
  readonly report: BranchProtectionReport;

  constructor(message: string, branch: string, report: BranchProtectionReport) {
    super(message);
    this.name = 'BranchProtectionRefused';
    this.branch = branch;
    this.report = report;
  }
}

/**
 * The refusal an unprotected default branch produces, naming the branch and what to change.
 *
 * A refusal that said only "branch protection failed" would leave a person to work out which branch and
 * which setting; AD-35 routes this code to `escalate-to-human`, and a human escalation that does not say
 * what the human is for is the escalation that gets ignored.
 */
const refusalFor = (report: BranchProtectionReport, remote: string): string =>
  `Refusing to start the run: ${report.reason}. Only the committer may push and force-push is never ` +
  `permitted (ADR-001), and both of those rest on "${report.branch ?? ''}" being protected on ${remote}. ` +
  `Enable branch protection on "${report.branch ?? ''}" — at minimum requiring a pull request before ` +
  'merging and forbidding force-pushes — and start the run again.';

/**
 * Assert protection at run start: answer the report, or refuse when the branch is demonstrably
 * unprotected.
 *
 * `unknown` returns rather than throws, which is the judgement this module's docblock states: the run
 * records that the assertion could not be made and continues, because refusing every repository the
 * engine cannot reach would stop an offline machine running at all.
 */
export const assertBranchProtection = (
  request: BranchProtectionRequest,
): BranchProtectionReport => {
  const report = checkBranchProtection(request);
  if (report.outcome === 'unprotected') {
    throw new BranchProtectionRefused(
      refusalFor(report, request.remote),
      report.branch ?? '',
      report,
    );
  }
  return report;
};
