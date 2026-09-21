/**
 * AD-35 — every failure code carries a declared disposition.
 *
 * The error shape and the disposition table live side by side so no two units can treat the same
 * failure differently, one retrying what another abandons. A code absent from the table resolves
 * to `abandon-and-hand-off` and is never retried, which makes an unrecognised failure safe by
 * construction rather than by each caller remembering to be careful.
 */
import { z } from 'zod';

/** The four dispositions. Every code maps to exactly one. */
export const DISPOSITIONS = [
  'retry-with-backoff',
  'escalate-model-tier',
  'escalate-to-human',
  'abandon-and-hand-off',
] as const;

export type Disposition = (typeof DISPOSITIONS)[number];

export const DispositionSchema = z.enum(DISPOSITIONS);

/** The disposition taken for a code this build does not know. Never retried. */
export const UNKNOWN_CODE_DISPOSITION: Disposition = 'abandon-and-hand-off';

/**
 * The disposition table. Codes are dot-namespaced by the unit that raises them.
 *
 * `retry-with-backoff` is reserved for transient conditions that a later identical attempt can
 * clear. `escalate-model-tier` is the model ladder's promotion trigger. `escalate-to-human` is a
 * condition no amount of retrying resolves but a person can. `abandon-and-hand-off` is for
 * failures with no safe continuation, where AD-21, AD-23 and AD-24 require stopping.
 */
export const ERROR_DISPOSITIONS = {
  // Step execution (AD-1, AD-8)
  'step.spawn_failed': 'retry-with-backoff',
  'step.timed_out': 'retry-with-backoff',
  'step.stream_malformed': 'retry-with-backoff',
  'step.schema_invalid_output': 'escalate-model-tier',
  'step.verification_failed': 'escalate-model-tier',
  'step.resume_failed': 'retry-with-backoff',

  // Model access (AD-1, Stack model rungs)
  'model.rate_limited': 'retry-with-backoff',
  'model.overloaded': 'retry-with-backoff',
  'model.api_key_mode_refused': 'escalate-to-human',
  'model.tier_ceiling_reached': 'escalate-to-human',

  // Permission and redaction (AD-1, AD-21)
  'permission.denied': 'escalate-to-human',
  'redaction.failed': 'abandon-and-hand-off',

  // Ceilings and planes (AD-23, AD-24)
  'budget.exhausted': 'abandon-and-hand-off',
  'control_plane.token_ceiling_exceeded': 'abandon-and-hand-off',

  // Containment and resources (AD-11, AD-20, AD-32)
  'container.image_build_failed': 'retry-with-backoff',
  'container.start_failed': 'retry-with-backoff',
  'container.isolation_assertion_failed': 'abandon-and-hand-off',
  'resource.lease_timed_out': 'retry-with-backoff',
  'resource.return_dirty': 'escalate-to-human',

  // External domains (AD-13, AD-14)
  'domain.unavailable': 'retry-with-backoff',
  'domain.credential_missing': 'escalate-to-human',
  'domain.response_unparseable': 'escalate-to-human',

  // The write surface (AD-15, AD-22)
  'write.branch_protection_violation': 'escalate-to-human',
  'write.conflict': 'escalate-to-human',
  'write.outcome_unknown': 'escalate-to-human',

  // Git and the step baseline (AD-22, AD-26)
  'git.worktree_unavailable': 'retry-with-backoff',
  'git.baseline_reset_failed': 'abandon-and-hand-off',
  'git.note_write_failed': 'escalate-to-human',

  // Engine and configuration (AD-9, AD-28, AD-30, AD-34)
  'engine.lock_held': 'escalate-to-human',
  'engine.node_floor_unmet': 'escalate-to-human',
  'config.schema_version_unrecognised': 'escalate-to-human',
  'config.invalid': 'escalate-to-human',
  'config.profile_stale': 'escalate-to-human',

  // Questions and the ledger (AD-25)
  'question.unanswerable': 'escalate-to-human',

  // Installation (AD-12)
  'install.incomplete': 'escalate-to-human',

  // Anything the system proved wrong about itself
  'internal.invariant_violated': 'abandon-and-hand-off',
} as const satisfies Readonly<Record<string, Disposition>>;

export type ErrorCode = keyof typeof ERROR_DISPOSITIONS;

export const ERROR_CODES: readonly ErrorCode[] = Object.freeze(
  Object.keys(ERROR_DISPOSITIONS) as ErrorCode[],
);

/**
 * Own-property membership only. `in` walks the prototype chain, which would make `constructor`,
 * `toString` and `__proto__` "registered codes" resolving to `Object` members instead of one of the
 * four dispositions — exactly the AD-35 guarantee this table exists to provide.
 */
export const isErrorCode = (code: string): code is ErrorCode =>
  Object.prototype.hasOwnProperty.call(ERROR_DISPOSITIONS, code);

/** The single authority on what to do about a code. Unknown codes are handed off, never retried. */
export const dispositionFor = (code: string): Disposition =>
  isErrorCode(code) ? ERROR_DISPOSITIONS[code] : UNKNOWN_CODE_DISPOSITION;

/** Retryability is derived from the table, never asserted independently. */
export const isRetryable = (code: string): boolean =>
  dispositionFor(code) === 'retry-with-backoff';

/**
 * The error shape crossing every unit boundary.
 *
 * `code` is an open string, not an enum: an unknown code must parse so it can be dispositioned
 * (to `abandon-and-hand-off`) rather than throwing a second failure while handling the first.
 * `cause` is a rendered string rather than a nested error, because AD-2 forbids recursive schemas
 * and this shape appears inside step contracts.
 *
 * **`retryable` may not disagree with the table.** The field is on the wire — a step agent's
 * structured output carries it, and a model will write whatever it believes — while AD-35 makes the
 * table the one authority on what a code means. A payload claiming `budget.exhausted` is retryable
 * parses into a value whose own flag argues for the retry the table forbids, and the next reader has
 * two answers to one question. So the agreement is checked inside the schema: `makeError` derives the
 * flag from the table and therefore always passes, and there is no parsed `OrchError` anywhere in the
 * system whose flag contradicts its code.
 */
export const OrchErrorSchema = z
  .object({
    code: z.string(),
    message: z.string(),
    retryable: z.boolean(),
    cause: z.string().nullable(),
  })
  .refine((error) => error.retryable === isRetryable(error.code), {
    message:
      'retryable must equal what the AD-35 disposition table says for this code — the table is the ' +
      'authority and the field may not disagree with it (an unknown code is never retryable)',
    path: ['retryable'],
  });

export type OrchError = z.infer<typeof OrchErrorSchema>;

export const dispositionForError = (error: OrchError): Disposition => dispositionFor(error.code);

/**
 * Build an error whose `retryable` flag cannot disagree with the table, which is the drift AD-35
 * exists to prevent.
 */
export const makeError = (code: string, message: string, cause: string | null = null): OrchError => ({
  code,
  message,
  retryable: isRetryable(code),
  cause,
});

/** Render an unknown thrown value as the `cause` string. */
export const renderCause = (thrown: unknown): string | null => {
  if (thrown === null || thrown === undefined) return null;
  if (thrown instanceof Error) return `${thrown.name}: ${thrown.message}`;
  if (typeof thrown === 'string') return thrown;
  if (typeof thrown === 'number' || typeof thrown === 'boolean') return String(thrown);
  try {
    return JSON.stringify(thrown) ?? null;
  } catch {
    return 'an unserialisable non-Error value was thrown';
  }
};
