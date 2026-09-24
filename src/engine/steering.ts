/**
 * What a consumed intent *does* — and why applying the same one twice cannot do it twice.
 *
 * `commands.ts` owns the file; this module owns the effect. The division matters because the two
 * failure modes are different, and because the property this story turns on lives here:
 *
 * **The effect is idempotent on `intent_id`, so delivery may be at-least-once.** Losing a disengage
 * the user already pressed is strictly worse than delivering one twice, which is the same trade AD-15
 * makes for the write surface — so nothing in the transport tries to guarantee exactly-once *delivery*.
 * Instead the effect carries the `intent_id` into the log, and an id already there is recognised and
 * skipped. The ledger is the log because AD-4 allows no second authority for a fact that decides
 * whether a person's approval is applied twice.
 *
 * **One intent is one append.** A ledger entry written before the effect could lose the effect to a
 * crash in between; one written after could double it, and story 1-3's review showed what a doubled
 * approval costs — `approve` folds to `interrupted`, so a completed step would be re-run. So the effect
 * *is* the ledger entry: a single `command.applied` line carrying both the id and every state change
 * the intent makes. A crash cannot land between them because there is no between.
 *
 * **Every intent routes through story 1-3's guards, not around them.** Those guards exist because a
 * reviewer found `kill` relabelling a *completed* step and `approve` resurrecting a *killed* one. A
 * terminal run refuses every command; a kill targets only a step actually in flight; an approval
 * targets the step the disposition table says blocked the run, never "the last one".
 */
import { findStepRecord, inFlightStep, isTerminalFeatureState } from '../contracts/index.js';
import type {
  Command,
  CommandIntent,
  FeatureState,
  QuestionResolver,
  RunState,
  StepDisposition,
  StepRecord,
} from '../contracts/index.js';

import { COMMAND_HANDLING } from '../runtime/index.js';

import type { IntentRefusalReason } from './commands.js';
import { routeTermination } from './dispositions.js';
import { resolverForSource } from './questions.js';

/**
 * The per-command disposition table now lives in `src/runtime/steering-view.ts`, and is re-exported here.
 *
 * Story 1-10's kill card renders `continue / narrow / kill / take over` and has to state that `narrow` is
 * written and awaiting story 2-9 — read from this table rather than from a literal of its own, so a
 * control's availability cannot drift from the table that decides it. The spine forbids a renderer
 * importing the engine, so the table moved to the runtime and the engine reads it from there. What the
 * commands *do* is still decided below, in {@link decideSteering}, and nothing of that moved.
 */
export {
  COMMAND_HANDLING,
  HONOURED_COMMANDS,
  QUESTION_COMMANDS,
  commandAvailabilities,
  commandAvailability,
} from '../runtime/index.js';
export type { CommandAvailability, CommandHandling } from '../runtime/index.js';

/**
 * The state changes one `command.applied` line makes.
 *
 * Every field is folded from that one line, which is what makes the effect atomic. `null` means "this
 * line changes nothing about that", not "reset it".
 */
export interface IntentEffect {
  /** A short label naming the effect, carried in the payload for a reader. */
  readonly summary: string;
  /** The lifecycle state the run enters, or `null` to leave it where it is. */
  readonly toState: FeatureState | null;
  /** The step the effect touches, or `null` for a run-level effect. */
  readonly step: string | null;
  /** The disposition that step records, or `null` to leave its record alone. */
  readonly stepDisposition: StepDisposition | null;
  /** True when the step's recorded error and session id are spent by this effect. */
  readonly clearsStepError: boolean;
  /** CAP-23 — the partial work is put on an ordinary branch before the run halts. */
  readonly escapeHatch: boolean;
  /** CAP-23 — the hand-off this effect records, and the document it writes. */
  readonly handoff: { readonly code: string; readonly reason: string } | null;
  /**
   * Story 4-1 — the AD-12 write gate this effect resolves, or `null` when it resolves none.
   *
   * A field of its own rather than folded into `toState`/`stepDisposition`: those two already mean
   * something for the ordinary step-failure `approve` (a step disposition and a lifecycle state), and a
   * gate resolution changes neither — `applyIntent` reads this field to know a `write.gate_approved` or
   * `write.gate_rejected` line belongs beside the `command.applied` line it is about to write, the same
   * way it already reads `handoff` to know a hand-off document belongs beside one.
   */
  readonly gateResolution: { readonly intentId: string; readonly outcome: 'approved' | 'rejected' } | null;
}

/**
 * What one question command asks the compare-and-set to do.
 *
 * Deliberately *not* a `QuestionResolution`: building one needs the question's offered options, which live
 * on disk, and `decideSteering` is pure. So this carries everything the intent itself determines — which
 * gesture it was, what the person typed, and which of AD-25's three resolvers the intent's source counts
 * as — and the reconciler completes it against the question it finds.
 */
export interface QuestionSteering {
  readonly command: Command;
  /** Free text (Q6). For a rejection this is the reason, and it becomes the decision unchanged. */
  readonly answer: string;
  readonly resolver: QuestionResolver;
}

export type SteeringDecision =
  /** Apply the effect, then retire the file. */
  | { readonly kind: 'apply'; readonly effect: IntentEffect; readonly reason: string }
  /**
   * AD-25 — resolve the run's active question through the compare-and-set, then retire the file.
   *
   * A kind of its own rather than an `apply` carrying an effect, because the state it changes is not in
   * the checkpoint: an `IntentEffect` names a lifecycle state and a step disposition, and a question
   * resolution names neither. Folding it into `apply` would have required inventing a `toState` for a
   * transition that changes no lifecycle state at all.
   */
  | {
      readonly kind: 'resolve-question';
      readonly question: QuestionSteering;
      readonly reason: string;
    }
  /** The id is already in the log: recognise it, retire the file, change nothing. */
  | { readonly kind: 'already-applied'; readonly reason: string }
  /**
   * The world is already the way this command asks for: recognise it, retire the file, change nothing.
   *
   * Distinct from a refusal, and the distinction is load-bearing. At-least-once delivery means one
   * gesture can leave two files — a crash between writing an intent and recording its effect is exactly
   * that — and the second must be a no-op rather than an error, because the user pressed the key once
   * and it worked. Refusing it would report a failure for a command that succeeded.
   */
  | { readonly kind: 'already-satisfied'; readonly reason: string }
  /** Record the intent and retire it; no run state changes. */
  | { readonly kind: 'acknowledge'; readonly reason: string }
  /** Leave the file for the unit that owns this command. */
  | { readonly kind: 'awaiting'; readonly owner: string; readonly reason: string }
  /** Refuse it, naming why, and quarantine the file. */
  | { readonly kind: 'refuse'; readonly reason: IntentRefusalReason; readonly detail: string };

/**
 * The hand-off code a take-over records.
 *
 * Deliberately not an AD-35 error code: nothing failed. A person decided to finish the work
 * themselves, and the AD-35 table exists to say what to do about a *failure*. `handoff.code` is
 * informational in the checkpoint and nothing routes on it, so a non-error marker here is the honest
 * value — inventing a failure code would put a fault in the record where there was none.
 */
export const TAKE_OVER_HANDOFF_CODE = 'user.take_over';

/**
 * The hand-off code a rejected AD-12 gate records.
 *
 * Deliberately not an AD-35 error code, for the same reason {@link TAKE_OVER_HANDOFF_CODE} is not: a
 * person declining a specific proposed irreversible write is a decision, not a failure, and the AD-35
 * table exists to route a failure. `handoff.code` is informational and nothing routes on it, so a
 * non-error marker is the honest value here too.
 */
export const GATE_REJECTED_HANDOFF_CODE = 'user.gate_rejected';

/**
 * The step whose failure blocked the run, found by asking the table which record escalates to a human.
 *
 * Not "the last step": a completed step sitting last would be rewritten into an `interrupted` one and
 * re-run, and a `killed` step would be resurrected — the AD-8 invariant story 1-3 states twice. Neither
 * `completed` nor `killed` routes to `escalate-to-human`, so neither can be picked.
 *
 * Shared with the reconciler rather than duplicated, because two spellings of this rule would be two
 * answers to "which step did a person just approve".
 */
export const blockedStepOf = (state: RunState): StepRecord | null =>
  [...state.steps]
    .reverse()
    .find(
      (record) =>
        record.disposition !== null &&
        record.disposition !== 'completed' &&
        record.disposition !== 'killed' &&
        routeTermination({
          step: record.step,
          disposition: record.disposition,
          sessionId: record.session_id,
          error: record.error,
          modelTier: record.model_tier,
          promotions: record.promotions,
        }).action === 'escalate-to-human',
    ) ?? null;

const effect = (summary: string, parts: Partial<Omit<IntentEffect, 'summary'>>): IntentEffect => ({
  summary,
  toState: parts.toState ?? null,
  step: parts.step ?? null,
  stepDisposition: parts.stepDisposition ?? null,
  clearsStepError: parts.clearsStepError ?? false,
  escapeHatch: parts.escapeHatch ?? false,
  handoff: parts.handoff ?? null,
  gateResolution: parts.gateResolution ?? null,
});

/**
 * A stop gesture's effect: the in-flight step, if any, and the run's halt.
 *
 * Both `kill` and `disengage` land here, and they land on the same effect on purpose. The Always list
 * is explicit — "a step stopped by a steering command records `killed` and is never resumed or re-run"
 * — and AD-8 says the same. They differ in the gesture, not in the consequence: `disengage` is the
 * single always-available keystroke the interface contract requires, and `kill` is the kill card's
 * explicit choice. Both are recorded with the command that caused them, so the record distinguishes
 * them even though the state does not.
 *
 * Only a step actually *in flight* is touched. A stop normally arrives when the last record is a step
 * that has already finished, and rewriting that record would put a permanent line in the log saying
 * work that was done never happened — which nothing would ever put back, because a killed step is
 * never re-run.
 */
const stopEffect = (state: RunState, summary: string): IntentEffect => {
  const target = inFlightStep(state);
  return effect(summary, {
    toState: 'killed',
    step: target?.step ?? null,
    stepDisposition: target === null ? null : 'killed',
  });
};

/**
 * Decide what one intent does.
 *
 * A pure function of the intent, the run state the log folds to, and the ids already applied — so the
 * same three inputs reach the same decision on every pass and after every restart, which is what makes
 * a redelivered intent safe rather than merely unlikely.
 */
export const decideSteering = (
  intent: CommandIntent,
  state: RunState,
  context: {
    readonly applied: ReadonlyMap<string, Command | null>;
    /**
     * Story 4-1, row 10 — the run's open question id, when one exists, so a `reject` addressed to a
     * pending gate can refuse rather than guess which of the two it means. `undefined`/`null` both mean
     * "no open question", so every call site that predates this field keeps its original meaning without
     * being told to pass one.
     */
    readonly activeQuestionId?: string | null;
  },
): SteeringDecision => {
  if (context.applied.has(intent.intent_id)) {
    /**
     * The id is spent. Whether that is a *redelivery* or a *reuse* is decided by the command beside it.
     *
     * A reuse is refused rather than recognised. The ledger keys on the id, so a second intent carrying
     * an id the log already holds against a different command would be dropped as "already applied": no
     * effect, no refusal, nothing recorded — a command that vanished. A writer that reuses an id has
     * made a mistake, and being told is strictly better than being ignored.
     */
    const appliedFor = context.applied.get(intent.intent_id) ?? null;
    if (appliedFor !== null && appliedFor !== intent.command) {
      return {
        kind: 'refuse',
        reason: 'intent-id-reused',
        detail:
          `Intent id ${intent.intent_id} is already in the log against "${appliedFor}", so this ` +
          `"${intent.command}" is not a redelivery of it but a different command reusing its id. The ` +
          'id is the exactly-once key (AD-19), so it cannot mean two commands: this one is refused ' +
          'rather than silently dropped as already applied.',
      };
    }
    return {
      kind: 'already-applied',
      reason:
        `Intent ${intent.intent_id} is already in the log, so its effect stands and is not applied ` +
        'again. Delivery is at-least-once; the effect is exactly-once (AD-19, AD-15).',
    };
  }

  /**
   * A terminal run has reached `[*]`: confirming, approving or stopping it would walk a finished run
   * backwards, and AD-8 is explicit that a killed step is never resumed and never re-run. Checked
   * before the command is even read, so no command can find a way round it.
   *
   * **Before the `awaiting` branch, and that ordering is the fix to a real gap.** With the branch first,
   * seven of the fourteen commands could never be refused at all: an `answer`, `pause`, `fork`,
   * `reject`, `narrow`, `inject_note` or `edit_criterion` addressed to a terminal run was neither
   * refused nor quarantined, so its file was re-read and re-parsed by every pass and every 25ms
   * mid-step poll for ever — the poison file AD-19 forbids, and a direct contradiction of this story's
   * own claim that an intent for a run in a terminal state is refused naming the reason. A terminal run
   * has no owner left to wait for: story 2-9 will not resume a committed feature either.
   */
  if (isTerminalFeatureState(state.state)) {
    return {
      kind: 'refuse',
      reason: 'terminal-run',
      detail:
        `Run ${state.run} is ${state.state}, which is terminal, so "${intent.command}" is refused ` +
        'and the terminal state stands.',
    };
  }

  /**
   * Story 4-1 — a rejection at a pending AD-12 gate is a real effect, decided here before `reject`'s
   * ordinary handling as a question command ever runs.
   *
   * `COMMAND_HANDLING.reject` is `'question'`: CAP-18's rejection of an *answer*, and until this story
   * that was the only meaning "reject" had. Reaching a gate under that handling fell through to
   * `resolveQuestionFromIntent`, found no open question under `questions/`, and refused with
   * `no-open-question` — naming the gate but declaring no transition for it (see that method's own
   * docblock). `state.pending_gate` is exactly that gate, and it is a fact this pure function can already
   * read off the run state, so a rejection reaching a gated run is decided here instead of falling
   * through to machinery built to answer a different question. A rejection reaching any other run — no
   * gate pending — still falls through unchanged, to `reject`'s existing question handling below.
   *
   * **Round-1 review's `resolution` fix, applied here.** `pendingGate.resolution` — not merely
   * `pendingGate !== null` — decides what a reject does: `'pending'` is the only resolution this branch
   * may actually resolve; `'approved'` refuses loudly (a gate already answered the other way cannot also
   * be rejected — silently letting it through would be the same reversal risk the `resolution` field
   * exists to close, from the opposite direction); `'rejected'` is a redelivered reject whose resolving
   * line already landed, so only the still-missing state transition is re-emitted, never a second
   * `write.gate_rejected`.
   */
  if (intent.command === 'reject' && state.pending_gate !== null) {
    const gate = state.pending_gate;

    /**
     * Round-1 review, row 10 — `reject` has two independent meanings today, and nothing about the
     * intent itself says which a person meant. Checked only against `'pending'`: once a gate is
     * decided, an active question can no longer be confused with it (the two branches below are about
     * the gate alone, its own answer already given or being caught up).
     */
    if (gate.resolution === 'pending' && context.activeQuestionId != null) {
      return {
        kind: 'refuse',
        reason: 'ambiguous-target',
        detail:
          `Run ${state.run} has both a pending write gate ("${gate.intent_id}") and an open question ` +
          `(${context.activeQuestionId}) open at once — "reject" could mean either, and this build never ` +
          'guesses which. Resolve the question first (with "answer" or its own "reject") if the reason ' +
          'was meant for it, or send "reject" again once the question is settled if the gated write is ' +
          'what should be declined.',
      };
    }

    if (gate.resolution === 'approved') {
      return {
        kind: 'refuse',
        reason: 'wrong-target-state',
        detail:
          `The gated write "${gate.intent_id}" was already approved, so it cannot also be rejected — a ` +
          'gate is resolved for good, in the one direction a person first answered it (CAP-12).',
      };
    }

    const reason = (intent.argument ?? '').trim();
    if (reason === '') {
      // Unreachable through a validated `CommandIntent` — `ARGUMENT_REQUIRED_COMMANDS` already refuses a
      // blank `reject` at the door (`src/contracts/command.ts`) — kept so this function refuses the same
      // way `handling.kind === 'question'` refuses one below, rather than recording a decision with
      // nothing in it if that guarantee is ever weakened.
      return {
        kind: 'refuse',
        reason: 'missing-answer',
        detail:
          '"reject" carries no reason, so there is nothing to record as the decision. A rejection is one ' +
          'keystroke plus a reason (CAP-18), and an empty one would record that a gated write was ' +
          'rejected for no stated reason.',
      };
    }

    const handoff = {
      code: GATE_REJECTED_HANDOFF_CODE,
      reason:
        `${intent.principal.kind} "${intent.principal.id}" rejected the gated write ` +
        `"${gate.intent_id}" (${gate.kind}, ${gate.reversibility}): ${reason} The run hands off ` +
        'rather than retrying the same write automatically (CAP-23).',
    };

    if (gate.resolution === 'rejected') {
      // A redelivered reject (AD-19's at-least-once): `write.gate_rejected` already landed for this
      // gate, so only the still-missing `handed_off` transition is re-emitted.
      return {
        kind: 'apply',
        effect: effect('gate-rejected', { toState: 'handed_off', handoff }),
        reason:
          `catching up the hand-off for the gated write "${gate.intent_id}", already rejected (CAP-23)`,
      };
    }

    // gate.resolution === 'pending', and no question conflicts: the ordinary gate-rejection effect.
    return {
      kind: 'apply',
      effect: effect('gate-rejected', {
        toState: 'handed_off',
        gateResolution: { intentId: gate.intent_id, outcome: 'rejected' },
        handoff,
      }),
      reason: `a person rejected the gated write "${gate.intent_id}" (CAP-23): ${reason}`,
    };
  }

  const handling = COMMAND_HANDLING[intent.command];
  if (handling.kind === 'awaiting') {
    return {
      kind: 'awaiting',
      owner: handling.owner,
      reason:
        `"${intent.command}" is a declared control whose effect belongs to ${handling.owner}. The ` +
        'file is left where it is, unconsumed and unrecorded, so the unit that owns it still sees it.',
    };
  }

  if (handling.kind === 'acknowledge') {
    return {
      kind: 'acknowledge',
      reason: `"${intent.command}" is recorded with its principal: ${handling.note}.`,
    };
  }

  if (handling.kind === 'question') {
    /**
     * A question command with nothing to say is refused rather than recorded as a blank answer.
     *
     * The strictest case is `reject`: the interface contract says rejection is one keystroke *plus a
     * reason*, and the reason becomes the ledger entry — so a rejection with no reason would produce a
     * durable decision whose content is the empty string, which is exactly the discarded reason the rule
     * exists to prevent. An `answer` with nothing in it is the same failure wearing a different name: it
     * would win the compare-and-set and record that the user said nothing.
     */
    const answer = intent.argument ?? '';
    if (answer.trim() === '') {
      return {
        kind: 'refuse',
        reason: 'missing-answer',
        detail:
          `"${intent.command}" carries no argument, so there is nothing to record as the decision. ` +
          'Answers are free text and no format is imposed (Q6), but an empty one would resolve the ' +
          'question with a blank answer and a rejection would lose the reason that is its whole point.',
      };
    }
    return {
      kind: 'resolve-question',
      question: {
        command: intent.command,
        answer,
        resolver: resolverForSource(intent.source),
      },
      reason: `"${intent.command}" resolves the active question: ${handling.note}`,
    };
  }

  switch (intent.command) {
    case 'confirm_spec': {
      /**
       * Only a run still `drafting` has criteria to confirm.
       *
       * This is a target guard, not a nicety. Delivery is at-least-once, so a crash between writing an
       * intent and recording its effect can leave *two* confirmations on disk for one gesture; without
       * this, the second would drag a running feature back to `confirmed` and the run would re-enter
       * execution from a state it had already left.
       */
      if (state.state !== 'drafting') {
        return {
          kind: 'already-satisfied',
          reason:
            `Run ${state.run} is ${state.state}, which is past drafting, so the criteria this intent ` +
            'confirms are already confirmed. The gesture stands; it is simply not applied twice.',
        };
      }
      return {
        kind: 'apply',
        effect: effect('confirmed', { toState: 'confirmed' }),
        reason: 'the user confirmed the acceptance criteria (CAP-2)',
      };
    }

    case 'approve': {
      /**
       * Story 4-1 — a pending AD-12 gate is checked before the step-failure branch below, and the two are
       * mutually exclusive. `blockedStepOf` finds "the blocked step" by asking whether a step's own
       * recorded termination disposition escalates to a human; a gate blocks the run *after* the
       * committing step already completed, so no step failed and `blockedStepOf` would find none. Reading
       * `state.pendingGate` first means an approval on a gated run is decided on the fact that actually
       * describes it, rather than falling through to a search built to answer "which step failed".
       */
      if (state.pending_gate !== null) {
        const gate = state.pending_gate;
        // The same degradation-preserving rule the step-failure branch below already has (AD-24).
        const toState = state.degradation === null ? 'running' : 'degraded';

        /**
         * Round-1 review's `resolution` fix. `'rejected'` refuses loudly rather than silently resuming —
         * this is what closes the crash-window reversal the fix exists for: without it, a redelivered or
         * late-arriving approve on a gate a person already rejected would fall through to the step-failure
         * branch below, find no blocked step, and answer `toState: 'running'` unconditionally.
         */
        if (gate.resolution === 'rejected') {
          return {
            kind: 'refuse',
            reason: 'wrong-target-state',
            detail:
              `The gated write "${gate.intent_id}" was already rejected, so approving it now would ` +
              'silently reverse that decision — a gate is resolved for good, in the one direction a ' +
              'person first answered it (CAP-12).',
          };
        }

        if (gate.resolution === 'approved') {
          // A redelivered approve (AD-19's at-least-once): `write.gate_approved` already landed for this
          // gate, so only the still-missing state transition is re-emitted, never a second one.
          return {
            kind: 'apply',
            effect: effect('gate-approved', { toState }),
            reason:
              `catching up the run's return from the gated write "${gate.intent_id}", already approved ` +
              '(CAP-12)',
          };
        }

        // gate.resolution === 'pending': the ordinary gate-approval effect.
        return {
          kind: 'apply',
          effect: effect('gate-approved', {
            toState,
            gateResolution: { intentId: gate.intent_id, outcome: 'approved' },
          }),
          reason:
            `a person approved the gated write "${gate.intent_id}" (${gate.kind}, ${gate.reversibility}) ` +
            '(CAP-12)',
        };
      }

      /**
       * CAP-2 — an approval is only ever an answer to a gate, and only a `blocked` run has one.
       *
       * Without this, `approve` returned `toState: 'running'` for **any** non-terminal state, so an
       * approve on a `drafting` run put a feature whose acceptance criteria were never confirmed straight
       * into execution. CAP-2 is "no feature enters execution without user-confirmed acceptance criteria"
       * and `confirm_spec` is its only gate; `decideAction` says the same thing from the other side —
       * `drafting` answers `await-confirmation`, and `blocked` is the one state that answers
       * `await-approval`, "waits for a person, not for another pass (CAP-12)".
       *
       * The guard is here rather than at a renderer for the reason AD-19 exists: the intent file is
       * durable and this function is its sole consumer, so a check anywhere else is a check something can
       * be written around — which is exactly what "there is no second command path" means.
       *
       * Refused rather than `already-satisfied`, because nothing about an approve on a `drafting` run is
       * satisfied: no gate was approved and none is waiting. `confirm_spec`'s redelivery case is the
       * different one — there the world really is the way the command asked for.
       */
      if (state.state !== 'blocked') {
        return {
          kind: 'refuse',
          reason: 'wrong-target-state',
          detail:
            `Run ${state.run} is ${state.state}, and only a "blocked" run has a gate to approve. ` +
            'CAP-2 lets nothing into execution without user-confirmed acceptance criteria, and ' +
            '"confirm_spec" is the only command that confirms them — so an approval here would be a ' +
            'second, unguarded way into execution rather than the answer to a gate (CAP-12).',
        };
      }
      const blocked = blockedStepOf(state);
      return {
        kind: 'apply',
        effect: effect('approved', {
          /**
           * A degraded run returns to `degraded`, not `running` (AD-24, story 2-9).
           *
           * Degradation is a standing condition: a run that crossed eighty percent of a ceiling and then
           * blocked at a gate has not got its budget back by being approved. Answering `running` here was
           * the one arrow in the engine that took a degraded run back to an undegraded state, and it would
           * have shown a person the state flapping on the one surface that is meant to be an honest signal.
           */
          toState: state.degradation === null ? 'running' : 'degraded',
          step: blocked?.step ?? null,
          // The approval settles the condition the step blocked on, so its error is spent and the step
          // becomes resumable-or-re-runnable. Leaving the error standing would make the next pass
          // escalate the very thing a person has just answered.
          stepDisposition: blocked === null ? null : 'interrupted',
          clearsStepError: blocked !== null,
        }),
        reason:
          blocked === null
            ? 'a person approved, and no step was blocked, so only the run state changes (CAP-12)'
            : `a person approved the gate step "${blocked.step}" blocked at (CAP-12)`,
      };
    }

    /**
     * `kill`, `disengage` and `take_over` carry **no** target-state guard, and that is a decision rather
     * than the gap `approve` had.
     *
     * Every non-terminal state is a legitimate target for a stop. The interface contract says
     * disengagement is "instant, obvious and **always available**", and a state-dependent stop is not
     * always available: a run parked in `drafting` or waiting at a gate is exactly the run a person is
     * most likely to want to abandon. The only state a stop is refused for is a terminal one, which the
     * guard above already answers, and the *step* side is guarded by `stopEffect`, which touches only a
     * step actually in flight. `take_over` is the same gesture with the escape hatch attached, so it
     * follows the same rule.
     */
    case 'kill':
      return {
        kind: 'apply',
        effect: stopEffect(state, 'killed'),
        reason: 'a steering command terminated the run (CAP-15, AD-8)',
      };

    case 'disengage':
      return {
        kind: 'apply',
        effect: stopEffect(state, 'disengaged'),
        reason:
          'the user disengaged — the single gesture that always means stop (CAP-5). The step records ' +
          '"killed" and is never resumed; the checkpoint, the log and the worktree stay on disk',
      };

    case 'take_over': {
      const target = inFlightStep(state);
      return {
        kind: 'apply',
        effect: effect('handed-off-to-user', {
          toState: 'handed_off',
          step: target?.step ?? null,
          stepDisposition: target === null ? null : 'killed',
          escapeHatch: true,
          handoff: {
            code: TAKE_OVER_HANDOFF_CODE,
            /**
             * Says the run halts, and says **nothing** about where the work ended up.
             *
             * This sentence is composed here, before the escape hatch has run, so it cannot know whether
             * a branch was created — and it used to assert one was. When git failed, only `HANDOFF.md` was
             * corrected: the `command.applied` payload and the checkpoint folded from it went on claiming
             * the work was on a branch that does not exist, in the record AD-4 makes the only authority.
             * The reconciler appends the hatch's own outcome to this sentence once it knows it.
             */
            reason:
              `${intent.principal.kind} "${intent.principal.id}" took the work over, so the run ` +
              'halts (CAP-23).',
          },
        }),
        reason: 'a person took the work over, so the run hands off rather than continuing (CAP-23)',
      };
    }

    // Every remaining member is `question`, `acknowledge` or `awaiting` and returned above. Enumerated
    // rather than defaulted so adding a command with an effect is a compile error here.
    case 'answer':
    case 'edit_criterion':
    case 'reject':
    case 'continue':
    case 'narrow':
    case 'pause':
    case 'inject_note':
    case 'fork':
    case 'just_do_it':
      return {
        kind: 'refuse',
        reason: 'not-yet-honoured',
        detail:
          `"${intent.command}" reached the effect table without a declared effect, which is a bug in ` +
          'this build rather than a fault in the intent.',
      };
  }
};

/**
 * The payload of a `command.applied` line.
 *
 * Every value is short, punctuated and low-entropy — an enum member, a dotted code, a prose sentence —
 * because AD-21's pass replaces an unbroken high-entropy run wherever it appears, and this payload
 * carries the one field the exactly-once guarantee depends on. `intent_id` is shape-guarded at the door
 * by `isLoggableIntentId` for exactly that reason.
 */
export const commandAppliedPayload = (
  intent: CommandIntent,
  decision: { readonly effect: IntentEffect | null; readonly reason: string },
): Record<string, unknown> => ({
  intent_id: intent.intent_id,
  command: intent.command,
  principal_kind: intent.principal.kind,
  principal_id: intent.principal.id,
  source: intent.source,
  issued_at: intent.issued_at,
  effect: decision.effect?.summary ?? 'acknowledged',
  reason: decision.reason,
  ...(decision.effect?.toState === undefined || decision.effect.toState === null
    ? {}
    : { to_state: decision.effect.toState }),
  ...(decision.effect?.stepDisposition === undefined || decision.effect.stepDisposition === null
    ? {}
    : { step_disposition: decision.effect.stepDisposition }),
  ...(decision.effect?.clearsStepError === true ? { clears_step_error: true } : {}),
  ...(decision.effect?.handoff === undefined || decision.effect.handoff === null
    ? {}
    : { handoff_code: decision.effect.handoff.code, handoff_reason: decision.effect.handoff.reason }),
});

/** The payload of a `command.refused` line: what was refused and why, never the file's contents. */
export const commandRefusedPayload = (
  reason: IntentRefusalReason,
  detail: string,
  intent: { readonly intentId: string | null; readonly command: string | null },
): Record<string, unknown> => ({
  reason,
  detail,
  intent_id: intent.intentId,
  command: intent.command,
});

/**
 * The step record an effect names, when the effect names one that exists.
 *
 * `null` means two different things and the caller has to tell them apart: a run-level effect names no
 * step, and a step-level effect can name one the run has no record of. The second is an invariant
 * violation, not a case to smooth over — a `command.applied` carrying an unknown step folds its
 * `to_state` and silently drops its `step_disposition`, so a kill would halt the run while leaving the
 * step it named unrecorded. `applyIntent` therefore asks this before it emits, and refuses the intent
 * rather than emitting a line that applies half of itself.
 *
 * Every effect in this module names a step taken from `state.steps` — {@link blockedStepOf} and
 * `inFlightStep` both read it — so the check is a guard against a future effect built some other way,
 * which is the only kind of guard that is worth anything.
 */
export const effectTarget = (state: RunState, effectToApply: IntentEffect): StepRecord | null =>
  effectToApply.step === null ? null : findStepRecord(state, effectToApply.step);
