/**
 * AD-8 and AD-35 — every step termination records a disposition, and every failure code carries a
 * declared one.
 *
 * This module is the single place that turns "the step ended like this" into "so the loop does that".
 * One table keeps two units from treating one failure differently, one retrying what the other
 * abandons; putting the decision in a pure function keeps it testable without a run and keeps the
 * reconciler free of branches it would have to keep in step with the table by hand.
 *
 * Three rules do most of the work:
 *
 * - **Only `interrupted` is resumable.** The resumability question is answered by `isResumable` from
 *   the contracts, never by a second list here.
 * - **`killed` is never resumed and never re-run.** A user's kill outranks every other signal,
 *   including an error code that would otherwise say retry, so it is decided before anything else is
 *   consulted. A recovery loop that silently undoes the kill control is the failure AD-8 names.
 * - **An unrecognised code is abandon-and-hand-off and never retried.** That comes free from
 *   `dispositionFor`, which is why no code here maintains its own fallback.
 */
import {
  ERROR_CODES,
  dispositionFor,
  isResumable,
} from '../contracts/index.js';
import { promotionFor } from './promotion.js';

import type {
  Disposition,
  ModelRung,
  OrchError,
  StepDisposition,
  StepRecord,
} from '../contracts/index.js';

/**
 * What the loop does next about a step. One member per outcome the story names, plus the two that
 * are the absence of an action.
 */
export const STEP_ACTIONS = [
  /** The step succeeded; advance the feature. */
  'advance',
  /** Resume by the recorded session id (AD-8). */
  'resume',
  /** Reset the worktree to `baseline_ref` and re-run from the typed input (AD-26). */
  'reset-and-rerun',
  /** Spend one model-ladder promotion, then re-run at the higher rung. */
  'promote-model-tier',
  /** A condition no retrying resolves but a person can; the feature blocks. */
  'escalate-to-human',
  /** Stop and explain, rather than thrash (CAP-23). */
  'hand-off',
  /** Terminal by a user's steering command: never resumed, never re-run. */
  'stop',
] as const;

export type StepAction = (typeof STEP_ACTIONS)[number];

/** A step termination, as the loop sees it. */
export interface StepTerminationFacts {
  readonly step: string;
  readonly disposition: StepDisposition;
  /** The `claude` session id, when the subprocess reported one. */
  readonly sessionId: string | null;
  /** The error the step reported, when it reported one. */
  readonly error: OrchError | null;
  /** The rung this attempt ran on. */
  readonly modelTier: ModelRung;
  /** Promotions already spent on this step in this run. */
  readonly promotions: number;
}

/** The decision, with the reasoning that produced it, so a log line can state *why*. */
export interface DispositionRouting {
  readonly action: StepAction;
  /** The AD-35 disposition consulted, or `null` when the step disposition decided alone. */
  readonly errorDisposition: Disposition | null;
  /** The code consulted, or `null` when no error was reported. */
  readonly code: string | null;
  /** True when the code was absent from the AD-35 table and so was handed off unretried. */
  readonly codeWasUnknown: boolean;
  /** The rung to run on next, when the action is a promotion. */
  readonly promoteTo: ModelRung | null;
  /** One line stating the decision and its grounds. */
  readonly reason: string;
}

const routing = (
  action: StepAction,
  reason: string,
  extra: Partial<Omit<DispositionRouting, 'action' | 'reason'>> = {},
): DispositionRouting => ({
  action,
  errorDisposition: extra.errorDisposition ?? null,
  code: extra.code ?? null,
  codeWasUnknown: extra.codeWasUnknown ?? false,
  promoteTo: extra.promoteTo ?? null,
  reason,
});

/**
 * Whether a code appears in the AD-35 table at all.
 *
 * Membership, not the resolved disposition: several declared codes map to `abandon-and-hand-off`
 * legitimately, so inferring "unknown" from that disposition would report a declared, deliberate
 * hand-off as an unrecognised failure. The set is built from the contracts' own exported list, so the
 * two cannot drift.
 */
const DECLARED_CODES: ReadonlySet<string> = new Set<string>(ERROR_CODES);

export const isDeclaredCode = (code: string): boolean => DECLARED_CODES.has(code);

/**
 * Route a termination to its next action.
 *
 * The order of the branches is the specification, not an implementation detail: `killed` is decided
 * before any error code is read, and `interrupted` is decided before the AD-35 table is consulted,
 * because a step that was interrupted has no failure to disposition — the interruption is the engine's
 * own, not the step's.
 */
export const routeTermination = (facts: StepTerminationFacts): DispositionRouting => {
  // A user's kill is final. Nothing below may reach a retry for it (AD-8).
  if (facts.disposition === 'killed') {
    return routing(
      'stop',
      `Step "${facts.step}" was terminated by a steering command, so it records "killed" and is ` +
        'never resumed and never re-run (AD-8).',
    );
  }

  if (facts.disposition === 'completed') {
    return routing('advance', `Step "${facts.step}" completed, so the feature advances.`);
  }

  if (isResumable(facts.disposition)) {
    // AD-8 — only `interrupted` is resumable, and only by a recorded session id. With no id there is
    // nothing to resume against, so the recovery is the baseline reset and re-run straight away.
    return facts.sessionId === null
      ? routing(
          'reset-and-rerun',
          `Step "${facts.step}" was interrupted with no recorded session id, so the recovery is a ` +
            'reset to its baseline_ref and a re-run from its typed input (AD-8, AD-26).',
        )
      : routing(
          'resume',
          `Step "${facts.step}" was interrupted and carries a session id, so a resume is attempted ` +
            'by that id (AD-8).',
        );
  }

  // `failed` and `blocked` are the step's own report, and the AD-35 table decides what they mean.
  const code = facts.error?.code ?? null;
  if (code === null) {
    return routing(
      'hand-off',
      `Step "${facts.step}" terminated "${facts.disposition}" with no error code, so it is treated ` +
        'as an unrecognised failure: abandon-and-hand-off, never a retry (AD-35).',
      { codeWasUnknown: true },
    );
  }

  const disposition = dispositionFor(code);
  const unknown = !isDeclaredCode(code);

  switch (disposition) {
    case 'retry-with-backoff':
      return routing(
        'reset-and-rerun',
        `"${code}" is declared retry-with-backoff, so the worktree is reset to the step's ` +
          'baseline_ref and the step is re-run from its typed input (AD-26, AD-35).',
        { errorDisposition: disposition, code },
      );

    case 'escalate-model-tier': {
      /**
       * The ladder decides, not this table. `src/engine/promotion.ts` owns the ceiling, the ordered
       * rungs and the refusal for a rung this build cannot place; deciding any of it a second time
       * here is how two units come to disagree about whether a step may climb.
       */
      const climb = promotionFor({
        step: facts.step,
        rung: facts.modelTier,
        promotions: facts.promotions,
        code,
      });
      if (!climb.promote || climb.to === null) {
        // The ceiling, the top of the ladder, or a rung nobody can place. A further promotion would
        // be the retry loop AD-35 forbids, dressed as a model decision, so a person decides.
        return routing('escalate-to-human', climb.reason, { errorDisposition: disposition, code });
      }
      return routing('promote-model-tier', climb.reason, {
        errorDisposition: disposition,
        code,
        promoteTo: climb.to,
      });
    }

    case 'escalate-to-human':
      return routing(
        'escalate-to-human',
        `"${code}" is declared escalate-to-human, so the feature blocks until a person answers.`,
        { errorDisposition: disposition, code },
      );

    case 'abandon-and-hand-off':
      return routing(
        'hand-off',
        unknown
          ? `"${code}" is absent from the AD-35 disposition table, so it is treated as ` +
            'abandon-and-hand-off and no retry is attempted.'
          : `"${code}" is declared abandon-and-hand-off, so the run stops and hands off.`,
        { errorDisposition: disposition, code, codeWasUnknown: unknown },
      );
  }
};

/**
 * What the loop does when the executor rejects a resume.
 *
 * The matrix calls this "the recovery, not an error", and AD-8 states it directly: on a failed resume
 * the step is re-run from its typed input after the AD-26 baseline reset. The recorded session id is
 * spent, so the next routing of the same `interrupted` disposition reaches `reset-and-rerun` on its
 * own — which is why this returns the same action rather than a special one.
 */
export const routeRefusedResume = (step: string): DispositionRouting =>
  routing(
    'reset-and-rerun',
    `The executor rejected the resume of step "${step}", so the recorded session id is spent and ` +
      'the recovery is a reset to its baseline_ref and a re-run from its typed input (AD-8, AD-26).',
    { code: 'step.resume_failed', errorDisposition: dispositionFor('step.resume_failed') },
  );

/** True when an action leaves the feature in a terminal state and no further pass acts on it. */
export const isTerminalAction = (action: StepAction): boolean =>
  action === 'stop' || action === 'hand-off';

/**
 * True when an action hands the *same* step to the executor again.
 *
 * This is the set the attempt bound has to cover, and naming it here rather than listing dispositions
 * at the call site is the point. The question is not "which disposition failed" but "does the loop come
 * back to this step" — a resume, a re-run after a baseline reset and a re-run at a promoted rung all do,
 * and all three spend a subscription-funded model call to do it. Enumerated exhaustively so the compiler
 * makes a later story answer the question for any action it adds.
 */
export const returnsToSameStep = (action: StepAction): boolean => {
  switch (action) {
    case 'resume':
    case 'reset-and-rerun':
    case 'promote-model-tier':
      return true;
    case 'advance':
    case 'escalate-to-human':
    case 'hand-off':
    case 'stop':
      return false;
  }
};

/**
 * How many times one step may be handed to the executor in a run, whatever sent it back.
 *
 * **One bound, one counting rule.** The count is every engagement of the step — a first start, a
 * re-run after an AD-26 baseline reset, a re-run at a promoted rung, and a resume by session id — and
 * the bound applies to all of them because all of them return to the same step. The previous bound
 * counted only the `failed` disposition, which left AD-8's resume path unbounded: a step interrupted
 * and resumed for ever never records a second failure, so it never reached the limit, and an unbounded
 * loop spends the subscription budget until a person notices.
 *
 * **Why eight and not three.** Three is what the AD-35 retry path needs: `retry-with-backoff` is
 * reserved for transient conditions, and a condition that has not cleared in three identical attempts
 * is not transient. But an *interruption* is the engine's own — a crash, a closed laptop — and each one
 * legitimately costs two further engagements: a resume against the recorded session id, and, when the
 * CLI rejects that session, the re-run behind it. Capping the sum at three would hand a run off for
 * having survived two crashes, which is the failure story 1-7 warned about when it excluded
 * `interrupted` in the first place. Eight leaves room for the three declared attempts plus two such
 * recoveries, and still stops the loop.
 *
 * **This is not one of AD-24's ceilings.** Step count, wall clock and rate-limit budget, with their
 * degradation and hibernation, are story 2-9's. This is a hard bound on one step's attempts, and the
 * alternative to it is the retry loop AD-35 forbids.
 */
export const DECLARED_STEP_ATTEMPT_LIMIT = 8;

/**
 * Whether this step has reached the bound: the next engagement would be one too many.
 *
 * `attempts` is folded from the event log — every `step.started` and every `step.resume_attempted` — so
 * the count is reconstructed from the durable truth rather than carried in memory or trusted from the
 * checkpoint. A restart is therefore not a way to reset it (AD-4).
 */
export const attemptBoundReached = (attempts: number): boolean =>
  attempts >= DECLARED_STEP_ATTEMPT_LIMIT;

/**
 * The engagements the bound counts: every one the step has had, less the ones a person has authorised.
 *
 * CAP-12 — approving the gate a step blocked at turns it into an `interrupted` step, which is one of
 * the three actions that return to the same step, so an approval of a step standing at the bound was
 * answered with an immediate hand-off: the run a person had just authorised, refused by the guard that
 * exists to protect them from an unattended loop. `credited_attempts` takes the value of `attempts` at
 * each approval, so the difference is the engagements spent since the last human gesture.
 *
 * Clamped at zero because the two numbers are folded from different lines and a truncated or reordered
 * log must not produce a negative allowance, which would read as "never reaches the bound".
 */
export const attemptsAgainstBound = (
  record: Pick<StepRecord, 'attempts' | 'credited_attempts'>,
): number => Math.max(0, record.attempts - record.credited_attempts);
