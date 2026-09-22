/**
 * AD-17 and the Stack's model-rung row — the ladder: which rung an attempt runs on, and when a step
 * climbs.
 *
 * The rule is one sentence in the Stack table — "`claude-haiku-4-5` → `claude-sonnet-5` →
 * `claude-opus-5`; one promotion per step per run, on a failed verification gate or a second
 * schema-invalid output" — and it was spread across three places that each held part of it: the
 * ordered rungs and the ceiling in `src/contracts/state.ts`, the trigger in the AD-35 table in
 * `src/contracts/error.ts`, and the decision in `src/engine/dispositions.ts` beside every other
 * routing. This module is the ladder itself, and `dispositions.ts` asks it rather than re-deciding.
 *
 * Three things are load-bearing:
 *
 * **The ladder runs one way, and an unrecognised rung stops it rather than starting it over.**
 * `MODEL_RUNGS.indexOf` answers `-1` for a rung this build cannot place, and `MODEL_RUNGS[-1 + 1]` is
 * the *lowest* rung — so the obvious code promotes an unknown rung *down* to the cheapest model and
 * calls it an escalation. `src/contracts/state.ts` guards that in `nextModelRung`; every entry point
 * here takes a rung as a `string` rather than a `ModelRung` so an unrecognised value is expressible
 * at all, and refuses it by name. A rung this build cannot place is not one it can run on, promote
 * from, or silently replace.
 *
 * **The trigger is read from the AD-35 table, never listed here.** A second list of promoting codes
 * would be a second authority on what a code means, which is the drift AD-35 exists to prevent. The
 * consequence is deliberate and is recorded in story 2-5: the shipped table promotes on
 * `step.verification_failed` **and** on `step.schema_invalid_output`, while the story's intent says
 * "only on a failed verification gate". The shipped rule is the one implemented, because it is the
 * one the table routes; narrowing it is a spine change, not an implementation detail.
 *
 * **The ceiling is a ceiling, so reaching it is an answer and not an omission.** A step that has
 * spent its one promotion, and a step already on the highest rung, both get a refusal that says which
 * of the two happened — `escalate-to-human` at the caller, because a person decides what a better
 * model could not.
 */
import {
  ERROR_CODES,
  MAX_PROMOTIONS_PER_STEP,
  MODEL_RUNGS,
  dispositionFor,
  isModelRung,
  nextModelRung,
} from '../contracts/index.js';
import type { ErrorCode, ModelRung } from '../contracts/index.js';

/**
 * The rung an attempt runs on when nothing declares one: the cheapest.
 *
 * Not a default in the sense AD-17 forbids — the roster's `model.start_tier` is still authoritative
 * where a declaration reaches the plan, and {@link startingRung} honours it. This is the direction an
 * *absence* falls in, and it falls to the floor for two reasons: the cheapest rung is the one that
 * costs a subscription-funded run least when nobody chose, and promotion is upward-only, so starting
 * at the floor is the only starting point that leaves the whole ladder available to climb.
 */
export const LOWEST_MODEL_RUNG: ModelRung = MODEL_RUNGS[0];

/** The rung at the top of the ladder: the one a failure cannot be answered by promoting past. */
export const HIGHEST_MODEL_RUNG: ModelRung = MODEL_RUNGS[MODEL_RUNGS.length - 1] ?? LOWEST_MODEL_RUNG;

/**
 * A rung this build cannot place, met where a rung was required.
 *
 * `config.invalid` → `escalate-to-human`, the code every other malformed-configuration refusal in the
 * engine carries. Nothing retries its way out of a declaration naming a model that does not exist,
 * and the alternative — treating it as the lowest rung — is the ladder running backwards.
 */
export class ModelRungUnrecognised extends Error {
  readonly code = 'config.invalid';
  readonly rung: string;

  constructor(rung: string, where: string) {
    super(
      `"${rung}" is not a model rung this build knows (${MODEL_RUNGS.join(' → ')}), met as ${where}. ` +
        'It is refused rather than treated as the lowest rung: MODEL_RUNGS.indexOf answers -1 for an ' +
        'unrecognised rung, and the rung after index -1 is the cheapest one, so the fallback that ' +
        'looks safest would promote a step down the ladder (AD-17, Stack model rungs).',
    );
    this.name = 'ModelRungUnrecognised';
    this.rung = rung;
  }
}

/**
 * The rung a step starts on: the one declared for it, or the cheapest where nothing is declared.
 *
 * AD-17 has the declaration carry "a starting tier and a promotion policy, never a fixed assignment",
 * so a declared rung is honoured verbatim — including one above the floor, which is a starting point
 * and not an assignment because the promotion policy still governs where the step goes from there.
 */
export const startingRung = (declared: string | null): ModelRung => {
  if (declared === null) return LOWEST_MODEL_RUNG;
  if (!isModelRung(declared)) throw new ModelRungUnrecognised(declared, 'a declared starting tier');
  return declared;
};

/** The codes whose AD-35 disposition promotes the ladder. Derived from the table, never listed. */
export const PROMOTION_TRIGGER_CODES: readonly ErrorCode[] = Object.freeze(
  ERROR_CODES.filter((code) => dispositionFor(code) === 'escalate-model-tier'),
);

/** True when this code is the ladder's trigger, as the AD-35 table declares it. */
export const triggersPromotion = (code: string): boolean =>
  dispositionFor(code) === 'escalate-model-tier';

/** Why a promotion was refused, when it was. `null` when one was granted. */
export const PROMOTION_REFUSALS = [
  /** The code does not promote the ladder; the AD-35 table routes it elsewhere. */
  'not-a-trigger',
  /** This step has already spent its one promotion in this run. */
  'ceiling-reached',
  /** The step already runs on the highest rung; there is nothing above it. */
  'ladder-exhausted',
  /** The rung the step reports is one this build cannot place, so it cannot be climbed from. */
  'rung-unrecognised',
] as const;

export type PromotionRefusal = (typeof PROMOTION_REFUSALS)[number];

/** What is known about a step at the moment a promotion is considered. */
export interface PromotionRequest {
  readonly step: string;
  /**
   * The rung this attempt ran on, as a `string` so an unrecognised value is expressible — which is
   * the case the ladder must refuse rather than clamp.
   */
  readonly rung: string;
  /** Promotions already spent on this step in this run, folded from the log. */
  readonly promotions: number;
  /** The code the step failed with. */
  readonly code: string;
}

/** The ladder's answer, carrying the grounds so a log line and a refusal can state why. */
export interface PromotionDecision {
  readonly promote: boolean;
  /** The rung to run on next; `null` whenever `promote` is false. */
  readonly to: ModelRung | null;
  /** Why not, when not. `null` when the promotion was granted. */
  readonly refusal: PromotionRefusal | null;
  readonly reason: string;
}

const refused = (refusal: PromotionRefusal, reason: string): PromotionDecision => ({
  promote: false,
  to: null,
  refusal,
  reason,
});

/**
 * Whether this step climbs, and to where.
 *
 * The branches are ordered so each refusal names the thing that actually stopped it: an unplaceable
 * rung is refused before the ceiling is counted, because a count says nothing about a rung nobody can
 * find, and the ceiling is counted before the ladder's top is consulted, because a step that has
 * spent its promotion is refused for that whether or not a rung above it exists.
 */
export const promotionFor = (request: PromotionRequest): PromotionDecision => {
  if (!triggersPromotion(request.code)) {
    return refused(
      'not-a-trigger',
      `"${request.code}" is declared ${dispositionFor(request.code)} in the AD-35 table, not ` +
        'escalate-model-tier, so it does not promote the ladder.',
    );
  }

  if (!isModelRung(request.rung)) {
    return refused(
      'rung-unrecognised',
      `Step "${request.step}" reports rung "${request.rung}", which this build cannot place on ` +
        `${MODEL_RUNGS.join(' → ')}. It is refused rather than treated as the lowest rung, which ` +
        'would promote the step down the ladder.',
    );
  }

  if (request.promotions >= MAX_PROMOTIONS_PER_STEP) {
    return refused(
      'ceiling-reached',
      `Step "${request.step}" has spent ${String(request.promotions)} of ` +
        `${String(MAX_PROMOTIONS_PER_STEP)} promotions, which is the ceiling of one per step per run, ` +
        'so a second promotion would be the retry loop AD-35 forbids wearing a model decision.',
    );
  }

  const to = nextModelRung(request.rung);
  if (to === null) {
    return refused(
      'ladder-exhausted',
      `Step "${request.step}" already runs on ${request.rung}, the highest rung, so the failure is ` +
        'reported as itself rather than answered with a model nobody has.',
    );
  }

  return {
    promote: true,
    to,
    refusal: null,
    reason:
      `"${request.code}" is declared escalate-model-tier, so step "${request.step}" is promoted from ` +
      `${request.rung} to ${to} and re-run.`,
  };
};

/** Everything the engine knows about which rung the next attempt of a step should run on. */
export interface AttemptRung {
  /** The rung a promotion just granted, or `null` when this attempt is not a promoted one. */
  readonly promoteTo: ModelRung | null;
  /** The rung this step last ran on, from its checkpoint record, or `null` on a first attempt. */
  readonly recorded: string | null;
  /** The starting tier the feature's plan declares, or `null` where nothing declares one. */
  readonly declared: string | null;
}

/**
 * The rung the next attempt of a step runs on.
 *
 * The precedence is the ladder's direction written down: a promotion just granted wins, then the rung
 * the step already reached, then what was declared for it, and a first attempt with nothing declared
 * starts at the floor. Reading the declared tier *after* the recorded one is what stops the ladder
 * running backwards on a re-run — a step promoted to `claude-opus-5` and re-run must not drop to the
 * `claude-haiku-4-5` its plan declared, which is the shape of the bug that spends a promotion and
 * then discards it.
 */
export const rungForAttempt = (attempt: AttemptRung): ModelRung => {
  if (attempt.promoteTo !== null) return attempt.promoteTo;
  if (attempt.recorded !== null) {
    if (!isModelRung(attempt.recorded)) {
      throw new ModelRungUnrecognised(attempt.recorded, 'the rung a step last ran on');
    }
    return attempt.recorded;
  }
  return startingRung(attempt.declared);
};
