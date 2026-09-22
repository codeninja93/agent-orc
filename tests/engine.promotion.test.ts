/**
 * The model ladder — matrix rows 12 to 17.
 *
 * Two of these rows are the ones a ladder suite usually gets wrong, so they are written first:
 *
 * **A ceiling test that never reaches the ceiling proves nothing.** One successful promotion shows
 * the ladder can climb; it says nothing about the rule, which is that it climbs *once*. So every
 * ceiling case here is a second attempt at a step that has already climbed, or a step standing on the
 * top rung, and each is asserted as a refusal that names which of the two stopped it.
 *
 * **An unrecognised rung must not be the lowest one.** `MODEL_RUNGS.indexOf` answers `-1`, and the
 * rung after index `-1` is the cheapest — so the fallback that looks safest promotes a step *down*.
 * Every entry point takes a rung as a `string` so that case is expressible, and it is exercised with
 * a rung no build knows rather than only with valid ones.
 */
import { describe, expect, it } from 'vitest';

import {
  MAX_PROMOTIONS_PER_STEP,
  MODEL_RUNGS,
  dispositionFor,
  makeError,
} from '../src/contracts/index.js';
import {
  HIGHEST_MODEL_RUNG,
  LOWEST_MODEL_RUNG,
  ModelRungUnrecognised,
  PROMOTION_TRIGGER_CODES,
  promotionFor,
  routeTermination,
  rungForAttempt,
  startingRung,
  triggersPromotion,
} from '../src/engine/index.js';

/** A rung no build has, spelled as a plausible mistake rather than as obvious nonsense. */
const UNRECOGNISED_RUNG = 'claude-sonnet-4-5';

const promotion = (overrides: Partial<Parameters<typeof promotionFor>[0]> = {}) =>
  promotionFor({
    step: 'implement',
    rung: LOWEST_MODEL_RUNG,
    promotions: 0,
    code: 'step.verification_failed',
    ...overrides,
  });

describe('the ladder is the Stack’s, in its order (matrix 12)', () => {
  it('runs a first attempt on the lowest rung when nothing declares one', () => {
    expect(startingRung(null)).toBe(LOWEST_MODEL_RUNG);
    expect(rungForAttempt({ promoteTo: null, recorded: null, declared: null })).toBe(
      LOWEST_MODEL_RUNG,
    );
  });

  /**
   * The rungs quoted from the Stack table rather than derived from the constant, so "the lowest rung"
   * is a claim about `claude-haiku-4-5` and not a claim that `MODEL_RUNGS[0]` is `MODEL_RUNGS[0]`.
   */
  it('orders haiku below sonnet below opus, which is what makes the lowest one the cheapest', () => {
    expect([...MODEL_RUNGS]).toStrictEqual([
      'claude-haiku-4-5',
      'claude-sonnet-5',
      'claude-opus-5',
    ]);
    expect(LOWEST_MODEL_RUNG).toBe('claude-haiku-4-5');
    expect(HIGHEST_MODEL_RUNG).toBe('claude-opus-5');
  });

  /**
   * AD-17 — the declaration carries "a starting tier and a promotion policy, never a fixed
   * assignment", so a declared rung above the floor is honoured rather than corrected downwards.
   */
  it('honours a declared starting tier, because the roster is what declares it', () => {
    expect(startingRung('claude-sonnet-5')).toBe('claude-sonnet-5');
    expect(rungForAttempt({ promoteTo: null, recorded: null, declared: 'claude-sonnet-5' })).toBe(
      'claude-sonnet-5',
    );
  });

  /**
   * The ladder runs one way, so a re-run of a step that already climbed does not fall back to the
   * rung its plan declared. That is the bug that spends the run's one promotion and then discards it.
   */
  it('keeps a step on the rung it reached rather than dropping it back to the declared one', () => {
    expect(
      rungForAttempt({ promoteTo: null, recorded: 'claude-opus-5', declared: 'claude-haiku-4-5' }),
    ).toBe('claude-opus-5');
  });

  it('runs a promoted attempt on the rung the promotion granted, above all else', () => {
    expect(
      rungForAttempt({
        promoteTo: 'claude-opus-5',
        recorded: 'claude-haiku-4-5',
        declared: 'claude-haiku-4-5',
      }),
    ).toBe('claude-opus-5');
  });
});

describe('a failed verification gate promotes the step one rung (matrix 13)', () => {
  it('promotes from the lowest rung to the next one, and says why', () => {
    const climb = promotion();
    expect(climb.promote).toBe(true);
    expect(climb.to).toBe('claude-sonnet-5');
    expect(climb.refusal).toBeNull();
    expect(climb.reason).toContain('escalate-model-tier');
  });

  it('promotes one rung and not to the top, because the ladder is climbed a step at a time', () => {
    expect(promotion({ rung: 'claude-haiku-4-5' }).to).toBe('claude-sonnet-5');
    expect(promotion({ rung: 'claude-sonnet-5' }).to).toBe('claude-opus-5');
  });

  it('is the routing the disposition table takes, so the two units cannot disagree', () => {
    const routing = routeTermination({
      step: 'verify',
      disposition: 'failed',
      sessionId: null,
      error: makeError('step.verification_failed', 'the gate failed'),
      modelTier: 'claude-haiku-4-5',
      promotions: 0,
    });
    expect(routing.action).toBe('promote-model-tier');
    expect(routing.promoteTo).toBe('claude-sonnet-5');
  });

  it('does not promote on a code the AD-35 table routes elsewhere', () => {
    const climb = promotion({ code: 'step.timed_out' });
    expect(climb.promote).toBe(false);
    expect(climb.refusal).toBe('not-a-trigger');
    expect(climb.to).toBeNull();
    expect(dispositionFor('step.timed_out')).toBe('retry-with-backoff');
  });
});

describe('the ceiling is one promotion per step per run (matrix 14)', () => {
  it('refuses a second promotion for the same step, naming the ceiling', () => {
    // The first one is granted, so the refusal below is about the count and not about the rung.
    expect(promotion({ rung: 'claude-haiku-4-5', promotions: 0 }).promote).toBe(true);

    const second = promotion({ rung: 'claude-sonnet-5', promotions: 1 });
    expect(second.promote).toBe(false);
    expect(second.refusal).toBe('ceiling-reached');
    expect(second.to).toBeNull();
    expect(second.reason).toContain('one per step per run');
    // A rung above it exists, so nothing but the ceiling could have refused this.
    expect(promotion({ rung: 'claude-sonnet-5', promotions: 0 }).to).toBe('claude-opus-5');
  });

  it('refuses it at the ceiling and above it, so an over-counted step is not let through', () => {
    for (const spent of [MAX_PROMOTIONS_PER_STEP, MAX_PROMOTIONS_PER_STEP + 3]) {
      const climb = promotion({ rung: 'claude-haiku-4-5', promotions: spent });
      expect(climb.promote, `spent ${String(spent)}`).toBe(false);
      expect(climb.refusal).toBe('ceiling-reached');
    }
  });

  it('routes the refused second promotion to a person rather than to another attempt', () => {
    const routing = routeTermination({
      step: 'verify',
      disposition: 'failed',
      sessionId: null,
      error: makeError('step.verification_failed', 'the gate failed again'),
      modelTier: 'claude-sonnet-5',
      promotions: 1,
    });
    expect(routing.action).toBe('escalate-to-human');
    expect(routing.promoteTo).toBeNull();
  });
});

describe('a step on the highest rung reports the failure as itself (matrix 15)', () => {
  it('refuses the promotion because there is nothing above it, not because of the ceiling', () => {
    const climb = promotion({ rung: HIGHEST_MODEL_RUNG, promotions: 0 });
    expect(climb.promote).toBe(false);
    expect(climb.refusal).toBe('ladder-exhausted');
    expect(climb.to).toBeNull();
    expect(climb.reason).toContain('highest rung');
    // It has spent no promotion, so the ceiling cannot be what refused it.
    expect(climb.refusal).not.toBe('ceiling-reached');
  });

  it('reports the failure as itself: a person decides, and no further attempt is made', () => {
    const routing = routeTermination({
      step: 'verify',
      disposition: 'failed',
      sessionId: null,
      error: makeError('step.verification_failed', 'the gate failed on opus too'),
      modelTier: HIGHEST_MODEL_RUNG,
      promotions: 0,
    });
    expect(routing.action).toBe('escalate-to-human');
    expect(routing.code).toBe('step.verification_failed');
    expect(routing.promoteTo).toBeNull();
  });
});

/**
 * Matrix 16 — the shipped rule, and the divergence recorded rather than quietly chosen.
 *
 * Story 2-5's intent says the agent is "promoted only on a failed verification gate".
 * `src/contracts/error.ts` maps `step.schema_invalid_output` to `escalate-model-tier` and
 * `src/contracts/state.ts` documents "on a failed verification gate **or** a second schema-invalid
 * output". Those are two different rules, and this story implements the shipped one: it is the one
 * the AD-35 table routes and the one AD-35 is built around. Narrowing it to the intent's "only" is a
 * spine change — the table and the Stack row would both have to move — and not an implementation
 * choice, so it is written down here rather than silently made.
 */
describe('a schema-invalid output promotes too, per the shipped disposition table (matrix 16)', () => {
  it('promotes on step.schema_invalid_output, which is the divergence from the intent’s "only"', () => {
    expect(dispositionFor('step.schema_invalid_output')).toBe('escalate-model-tier');
    const climb = promotion({ code: 'step.schema_invalid_output' });
    expect(climb.promote).toBe(true);
    expect(climb.to).toBe('claude-sonnet-5');
  });

  /**
   * The trigger set is derived from the AD-35 table, never listed here — a second list of promoting
   * codes would be a second authority on what a code means. This asserts the derivation *and* its
   * content, so the day a code is added to the table with `escalate-model-tier`, the set grows and
   * this assertion says so rather than the ladder quietly changing.
   */
  it('derives its triggers from the AD-35 table, and today they are exactly these two', () => {
    expect([...PROMOTION_TRIGGER_CODES].sort()).toStrictEqual([
      'step.schema_invalid_output',
      'step.verification_failed',
    ]);
    for (const code of PROMOTION_TRIGGER_CODES) {
      expect(dispositionFor(code), code).toBe('escalate-model-tier');
      expect(triggersPromotion(code), code).toBe(true);
    }
    expect(triggersPromotion('permission.denied')).toBe(false);
    expect(triggersPromotion('a.code.no.build.declares')).toBe(false);
  });

  /**
   * The ceiling is one per step per run whichever trigger spends it, so the two triggers cannot be
   * used to climb twice by alternating between them.
   */
  it('spends the same single promotion whichever of the two triggers asks for it', () => {
    const spent = promotion({ code: 'step.schema_invalid_output', promotions: 1 });
    expect(spent.promote).toBe(false);
    expect(spent.refusal).toBe('ceiling-reached');
  });
});

describe('an unrecognised rung is refused, never treated as the lowest (matrix 17)', () => {
  it('refuses a declared starting tier this build cannot place, rather than starting at the floor', () => {
    expect(() => startingRung(UNRECOGNISED_RUNG)).toThrowError(ModelRungUnrecognised);
    // The failure direction this guards: the "obvious" fallback would return the cheapest rung.
    let landedOn: string | null = null;
    try {
      landedOn = startingRung(UNRECOGNISED_RUNG);
    } catch {
      landedOn = null;
    }
    expect(landedOn).not.toBe(LOWEST_MODEL_RUNG);
    expect(landedOn).toBeNull();
  });

  it('carries config.invalid, so a rung nobody can place reaches a person rather than a retry', () => {
    const refusal = new ModelRungUnrecognised(UNRECOGNISED_RUNG, 'a declared starting tier');
    expect(refusal.code).toBe('config.invalid');
    expect(dispositionFor(refusal.code)).toBe('escalate-to-human');
    expect(refusal.message).toContain(UNRECOGNISED_RUNG);
    expect(refusal.message).toContain(MODEL_RUNGS.join(' → '));
  });

  it('refuses to promote from a rung it cannot place, rather than promoting it to the cheapest', () => {
    const climb = promotion({ rung: UNRECOGNISED_RUNG });
    expect(climb.promote).toBe(false);
    expect(climb.refusal).toBe('rung-unrecognised');
    // The failure this is about: `MODEL_RUNGS[-1 + 1]` is the lowest rung, so the ladder would run
    // backwards and call it an escalation.
    expect(climb.to).not.toBe(LOWEST_MODEL_RUNG);
    expect(climb.to).toBeNull();
  });

  it('refuses to run an attempt on a recorded rung it cannot place', () => {
    expect(() =>
      rungForAttempt({ promoteTo: null, recorded: UNRECOGNISED_RUNG, declared: 'claude-haiku-4-5' }),
    ).toThrowError(ModelRungUnrecognised);
  });

  it('is refused at parse as well, so an unrecognised rung never reaches the ladder from a TOML', async () => {
    const { AgentDeclarationSchema } = await import('../src/contracts/index.js');
    const parsed = AgentDeclarationSchema.safeParse({
      schema_version: 1,
      id: 'mine',
      purpose: 'an agent declaring a rung this build does not have',
      contract: 'step.output',
      tools: ['Read'],
      mcp_domains: [],
      reversibility: 'reversible',
      model: { start_tier: UNRECOGNISED_RUNG, promotion_policy: 'on-gate-failure' },
    });
    expect(parsed.success).toBe(false);
  });

  it('still places every rung it does know, so the refusal is about the value', () => {
    for (const rung of MODEL_RUNGS) expect(startingRung(rung)).toBe(rung);
  });
});
