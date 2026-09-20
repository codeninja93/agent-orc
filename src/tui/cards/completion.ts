/**
 * The completion notice: what merged, the file count, the test status, the usage — and what was *not*
 * verified.
 *
 * R8 is the line this card exists for: "Every completion states what was verified **and what was not**."
 * At stage 1 nothing records a merge, a file count or a test result — the committer is story 2-7 and the
 * deterministic gates are later still — so the notice is built complete and renders
 * `UNRECORDED_PRESENTATION` for each fact nothing has recorded yet. That is the whole point of the card,
 * not a placeholder in it:
 *
 * - **An omitted field reads as nothing to report.** A person scanning a notice that simply does not
 *   mention tests concludes there was nothing to say about them.
 * - **A tick reads as a pass.** Rendering an unrecorded test result as anything affirmative is the single
 *   failure mode R8 exists to prevent, and it is the one that gets code merged on a promise nobody made.
 *
 * So every unrecorded fact appears, named, marked unrecorded, and repeated in the "not verified" list. The
 * structure is finished here and the facts arrive as later stories record them.
 *
 * What *is* folded from the log today is real: a verification step the log records as completed is named
 * as verified, and one that never completed is named as not verified. Those come from the steps the
 * projection already holds, so the honest half of R8 is live rather than pending.
 */
import { UNRECORDED_PRESENTATION } from '../projection.js';
import type { ShellView } from '../projection.js';
import { formatBudgetShare, formatElapsed, formatStepCount } from '../status.js';

import type { CardBody } from './index.js';

/** The facts a later story records about a completion. Each `null` until something records it. */
export interface CompletionFacts {
  /** What merged: the branch, the pull request, the merge commit — as the committer names it (2-7). */
  readonly merged?: string | null;
  /** How many files the work touched. */
  readonly fileCount?: number | null;
  /** The deterministic gates' verdict, in the words of whatever ran them (CAP-13). */
  readonly testStatus?: string | null;
}

export interface CompletionCard extends CardBody {
  readonly kind: 'completion';
  readonly merged: string;
  readonly fileCount: string;
  readonly testStatus: string;
  readonly usage: string;
  readonly elapsed: string;
  readonly steps: string;
  /** The verification steps the log records as completed. */
  readonly verified: readonly string[];
  /** R8 — everything this notice cannot claim was verified, each said rather than omitted. */
  readonly notVerified: readonly string[];
  /** R1 — the sentence that says the work needs nothing from the reader. */
  readonly nothingIsNeeded: string;
}

export interface CompletionCardInput {
  readonly view: ShellView;
  readonly facts?: CompletionFacts;
  readonly now?: Date;
}

/** The unrecorded-fact presentation, in one place, so no field spells its own absence differently. */
const recorded = (value: string | null | undefined): string =>
  value === null || value === undefined || value === '' ? UNRECORDED_PRESENTATION : value;

/**
 * Build the completion notice.
 *
 * Pure. Every field is present in every notice: a field that disappeared when its value was unknown would
 * make R8's "and what was not" untrue exactly where it matters most.
 */
export const buildCompletionCard = (input: CompletionCardInput): CompletionCard => {
  const view = input.view;
  const facts = input.facts ?? {};
  const now = input.now ?? new Date();

  const merged = recorded(facts.merged);
  const fileCount =
    facts.fileCount === null || facts.fileCount === undefined
      ? UNRECORDED_PRESENTATION
      : `${String(facts.fileCount)} file${facts.fileCount === 1 ? '' : 's'}`;
  const testStatus = recorded(facts.testStatus);
  const usage = formatBudgetShare(view.usage.rateLimitBudgetConsumed);
  const elapsed = formatElapsed(view, now);
  const steps = formatStepCount(view);

  const verificationSteps = view.progress.steps.filter((step) => step.phase === 'verification');
  const verified = verificationSteps
    .filter((step) => step.disposition === 'completed')
    .map((step) => step.step);

  /**
   * What this notice cannot claim, assembled from both directions.
   *
   * The unrecorded facts come first because they are the ones a reader would otherwise assume: a
   * verification step named here is a known gap, while a missing test result is an unknown one, and an
   * unknown gap is the more dangerous of the two.
   */
  const notVerified = [
    ...(testStatus === UNRECORDED_PRESENTATION
      ? ['no test result is recorded, so nothing here has been shown to pass']
      : []),
    ...(merged === UNRECORDED_PRESENTATION
      ? ['no merge is recorded, so treat the work as sitting on its branch']
      : []),
    ...(fileCount === UNRECORDED_PRESENTATION ? ['no file count is recorded'] : []),
    ...verificationSteps
      .filter((step) => step.disposition !== 'completed')
      .map(
        (step) =>
          `the verification step "${step.step}" did not complete ` +
          `(${step.disposition ?? 'it was still running'})`,
      ),
  ];

  const nothingIsNeeded =
    notVerified.length === 0
      ? 'nothing is needed from you: the work is finished and verified'
      : 'nothing is needed from you for this run to finish — it already has. What is listed above as ' +
        'unverified is unverified, and no later pass will verify it';

  const lines = [
    `merged: ${merged}`,
    `files changed: ${fileCount}`,
    `tests: ${testStatus}`,
    `steps: ${steps}`,
    `rate-limit budget: ${usage} consumed`,
    `elapsed: ${elapsed}`,
    verified.length === 0
      ? 'verified: nothing — no verification step is recorded as completed'
      : `verified: ${verified.join(', ')}`,
    'not verified:',
    ...(notVerified.length === 0
      ? ['  nothing outstanding']
      : notVerified.map((line) => `  - ${line}`)),
    nothingIsNeeded,
  ];

  return {
    kind: 'completion',
    title: `${view.feature ?? 'this run'} — finished; nothing is needed from you`,
    merged,
    fileCount,
    testStatus,
    usage,
    elapsed,
    steps,
    verified,
    notVerified,
    nothingIsNeeded,
    lines,
  };
};
