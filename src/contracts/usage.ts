/**
 * The cost and token counts a `claude -p` terminal result reports.
 *
 * It is a contract rather than an engine detail because three units read it and only one writes it:
 * the spawner parses it off the stream, story 2-9's ceilings decide against it, and story 3-3's
 * measurement reports it. A shape declared inside `src/engine/` would have made the renderer and the
 * ceiling logic each re-derive what a token count is called.
 *
 * **Absence is recorded as absence, never as a zero.** Every field is nullable and the whole record is
 * optional: a result that carried no `usage` block records *no usage at all*, and a surface then reads
 * `(not recorded)`. This is R8 applied to a number — `$0.00` is a claim that the step was free, and a
 * claim nobody made is the one thing a completion notice must not print. {@link addUsage} keeps the
 * distinction through a summation: unrecorded plus unrecorded is unrecorded, not zero.
 *
 * **Nothing here is a ceiling dimension.** AD-24 gives a run three ceilings — step count, wall clock and
 * consumed rate-limit budget — "and no currency dimension", and R10 says cost is subscription usage and
 * never currency. So `cost_usd` is recorded because the CLI reports it and 2-9 will read it, and the
 * surfaces render the *token* counts; see `src/tui/status.ts` for the rendering rule.
 *
 * Numbers are what makes this safe to put in a payload at all: AD-21's entropy sweep rewrites unbroken
 * high-entropy *strings*, and a number is never a candidate. That is why the usage lands on the
 * `step.terminated` payload while an identifier has to travel in an envelope field.
 */
import { z } from 'zod';

/**
 * One step attempt's usage, as the CLI reported it.
 *
 * Every key is present and nullable rather than optional, so a reader never has to distinguish "the
 * field was absent" from "the CLI did not report that one" — both are `null`. The *record* being absent
 * is the only way "nothing was recorded" is spelled.
 */
export const StepUsageSchema = z.object({
  /** `total_cost_usd` from the result line. The CLI's own figure, never estimated here. */
  cost_usd: z.number().nullable(),
  input_tokens: z.int().nullable(),
  output_tokens: z.int().nullable(),
  cache_creation_input_tokens: z.int().nullable(),
  cache_read_input_tokens: z.int().nullable(),
});

export type StepUsage = z.infer<typeof StepUsageSchema>;

/** The payload key a `step.terminated` line carries its usage under, spelled once. */
export const USAGE_PAYLOAD_KEY = 'usage';

/**
 * Every field of the record, once, in the order {@link StepUsageSchema} declares them.
 *
 * It is the list a reader iterates so it cannot miss one — {@link hasRecordedUsage} and
 * {@link usageFromPayload} are both folds over it, and `tests/contracts.usage.test.ts` compares it against
 * the schema's own keys so a field added to one and not the other fails a test rather than being silently
 * unread. It is **not** a display order: `formatTokenUsage` in `src/tui/status.ts` states the token counts
 * in the order a person reads them and states no cost at all, because R10 makes cost subscription usage
 * and never currency. Calling this "the order a surface states them" described a surface that does not
 * exist.
 */
export const STEP_USAGE_FIELDS = [
  'cost_usd',
  'input_tokens',
  'output_tokens',
  'cache_creation_input_tokens',
  'cache_read_input_tokens',
] as const;

export type StepUsageField = (typeof STEP_USAGE_FIELDS)[number];

/**
 * There is deliberately no exported "empty usage record" constant.
 *
 * One was exported and documented as "the identity {@link addUsage} folds from", and all three parts of
 * that were false: {@link totalUsage} folds from `null`, nothing imported the constant, and a record of
 * five nulls is not what absence is spelled as here — the *record being absent* is. Keeping it invited
 * exactly the mistake this file exists to prevent, a caller reaching for a zeroed record where R8 wants no
 * record at all.
 */

/** True when at least one field carries a number, so there is something to state. */
export const hasRecordedUsage = (usage: StepUsage | null): boolean =>
  usage !== null && STEP_USAGE_FIELDS.some((field) => usage[field] !== null);

/**
 * Add one field of two usage records.
 *
 * `null` is the absence of a measurement, not a zero, so it is *skipped* rather than added: two
 * unrecorded fields stay unrecorded, and one recorded field plus one unrecorded field is the recorded
 * one unchanged. Adding them as zeros would turn "two steps, neither reported its cost" into "this
 * feature cost nothing", which is the false claim R8 exists to prevent.
 */
const addField = (left: number | null, right: number | null): number | null => {
  if (left === null) return right;
  if (right === null) return left;
  return left + right;
};

/** Sum two usage records, keeping absence absent. */
export const addUsage = (left: StepUsage | null, right: StepUsage | null): StepUsage | null => {
  if (left === null) return right;
  if (right === null) return left;
  return {
    cost_usd: addField(left.cost_usd, right.cost_usd),
    input_tokens: addField(left.input_tokens, right.input_tokens),
    output_tokens: addField(left.output_tokens, right.output_tokens),
    cache_creation_input_tokens: addField(
      left.cache_creation_input_tokens,
      right.cache_creation_input_tokens,
    ),
    cache_read_input_tokens: addField(left.cache_read_input_tokens, right.cache_read_input_tokens),
  };
};

/** A run's total: the sum of its steps', or `null` when no step recorded any. */
export const totalUsage = (records: readonly (StepUsage | null)[]): StepUsage | null =>
  records.reduce<StepUsage | null>((carried, next) => addUsage(carried, next), null);

/**
 * Read a usage record out of an event payload's `usage` entry, or `null`.
 *
 * Defensive rather than strict, because AD-5 makes an older or newer writer's payload something this
 * reader must survive: a key that is absent, of the wrong type, or carrying a field this build does not
 * know is read for what it does hold and never throws.
 */
export const usageFromPayload = (value: unknown): StepUsage | null => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const read = (key: StepUsageField): number | null => {
    const found = record[key];
    return typeof found === 'number' && Number.isFinite(found) ? found : null;
  };
  const usage: StepUsage = {
    cost_usd: read('cost_usd'),
    input_tokens: read('input_tokens'),
    output_tokens: read('output_tokens'),
    cache_creation_input_tokens: read('cache_creation_input_tokens'),
    cache_read_input_tokens: read('cache_read_input_tokens'),
  };
  // A record whose every field is unreadable is no record: returning one would turn an unusable
  // payload into a usage the surfaces then state as recorded.
  return hasRecordedUsage(usage) ? usage : null;
};
