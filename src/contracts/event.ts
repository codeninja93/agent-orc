/**
 * AD-5 — one event envelope shared by every emitter.
 *
 * Every line of an `events.jsonl` is one JSON object carrying the eight declared fields. Readers
 * must ignore unknown `type` values rather than erroring, so adding an event type is never a
 * breaking change; the envelope is therefore open on `type` and open to unknown keys, while a
 * missing declared field is a parse failure.
 *
 * This module defines the envelope's shape only. `seq` assignment and the writing of
 * `events.jsonl` belong to the runtime recorder (AD-29), which is story 1-2.
 */
import { z } from 'zod';

/**
 * RFC3339 with milliseconds in UTC — the one timestamp format in the system.
 *
 * Carried as a plain `z.string()`, never `z.date()`: AD-2 places date types outside the
 * structured-outputs subset, and `z.toJSONSchema` cannot represent them at all. The format is
 * enforced by a refinement, which leaves the exported JSON Schema as a bare string and so keeps
 * the export free of `pattern` and `format` keywords.
 */
export const RFC3339_MILLIS_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export const isRfc3339Millis = (value: string): boolean =>
  RFC3339_MILLIS_UTC.test(value) && !Number.isNaN(Date.parse(value));

export const TimestampSchema = z.string().refine(isRfc3339Millis, {
  message: 'must be RFC3339 with milliseconds in UTC, e.g. 2026-09-19T12:34:56.789Z',
});

/** Format a moment in the one accepted timestamp format. */
export const formatTimestamp = (at: Date = new Date()): string => at.toISOString();

/**
 * The declared event vocabulary. Dot-namespaced and past-tense. The vocabulary is open by
 * design: a reader meeting a type absent from this list accepts the envelope and ignores the
 * event, so later stories add types without a breaking change.
 */
export const EVENT_TYPES = [
  'step.started',
  'agent.tool_used',
  'fetch.recorded',
  'write.attempted',
  'write.executed',
  'permission.denied',
  'redaction.failed',
  'budget.degraded',
  'budget.exhausted',
  'question.asked',
  'question.resolved',
  'question.default_taken',
  'question.deflected',
] as const;

export type DeclaredEventType = (typeof EVENT_TYPES)[number];

export const isDeclaredEventType = (type: string): type is DeclaredEventType =>
  (EVENT_TYPES as readonly string[]).includes(type);

/**
 * The AD-5 envelope.
 *
 * - `type` is an open string, not an enum: an unknown type parses (AD-5).
 * - `step` is required but nullable, because run-level events carry no step.
 * - `parent_tool_use_id` and `session_id` are the stream-origin passthrough fields, preserved
 *   verbatim when the event came from a `claude -p` stream.
 * - `baseline_ref` is the AD-26 commit the emitting step's worktree stood at. It is an envelope
 *   field rather than a payload entry because the AD-21 pass redacts an unbroken commit SHA inside
 *   a payload, and a ref the reconciler cannot read back is a ref the log cannot reconstruct a run
 *   from (AD-4). {@link EVENT_ENVELOPE_VERBATIM_FIELDS} names it as one of the identifier fields a
 *   recorder restores verbatim after the pass, each still proven free of every credential class.
 * - The object is loose so unknown keys survive a parse instead of being dropped, which is the
 *   read-side half of "adding a field is never breaking".
 */
export const EventEnvelopeSchema = z.looseObject({
  ts: TimestampSchema,
  seq: z.int(),
  feature: z.string(),
  run: z.string(),
  step: z.string().nullable(),
  emitter: z.string(),
  type: z.string(),
  payload: z.record(z.string(), z.unknown()),
  parent_tool_use_id: z.string().nullable().optional(),
  session_id: z.string().nullable().optional(),
  baseline_ref: z.string().nullable().optional(),
});

export type EventEnvelope = z.infer<typeof EventEnvelopeSchema>;

/** The eight fields AD-5 requires on every line, in their declared order. */
export const EVENT_ENVELOPE_REQUIRED_FIELDS = [
  'ts',
  'seq',
  'feature',
  'run',
  'step',
  'emitter',
  'type',
  'payload',
] as const;

/**
 * The fields a recorder restores verbatim after the AD-21 pass, by field path.
 *
 * The list is as short as it can be, and the reason is the shape of the risk. The pass's entropy
 * heuristic replaces any unbroken high-entropy run, so exactly two of the envelope's identifiers need
 * rescuing from it — a run id and a baseline ref, both of which are high-entropy *by construction* and
 * would otherwise leave the durable truth unable to name its own run or the commit a step began at,
 * against AD-4. Two more, the AD-5 stream-origin fields, must survive verbatim because AD-5 says so.
 *
 * `feature` and `step` are deliberately **not** here. Their legitimate values are punctuated and
 * low-entropy — a kebab-case slug, a dotted declared name — so the pass leaves them untouched and there
 * is nothing to restore. Putting them on the list would have bought nothing and cost everything: their
 * shapes admit any alphanumeric run, so a high-entropy token with no known prefix would satisfy the
 * shape and be written verbatim while the same value in a payload was replaced. A field is on this list
 * only when its *legitimate* values are indistinguishable from secret material and its shape is narrow
 * enough that no secret satisfies it.
 *
 * The allow-list is by *field path*, never by value shape alone: story 1-2 established that a shape
 * exemption is what let a real credential through, so a listed field is restored only when the original
 * is proven free of every credential class the pass recognises *and* is the identifier the field claims
 * to hold. The two stream fields are dropped when the first proof fails, because AD-5 requires them
 * verbatim or not at all; the two identity fields keep the redacted value instead, so a line is still
 * written.
 */
export const EVENT_ENVELOPE_VERBATIM_FIELDS = [
  'run',
  'baseline_ref',
  'parent_tool_use_id',
  'session_id',
] as const;

export type EventEnvelopeVerbatimField = (typeof EVENT_ENVELOPE_VERBATIM_FIELDS)[number];

/**
 * The two AD-5 stream-origin fields, which are verbatim-or-dropped: the pass may not rewrite them,
 * so the only safe alternative to keeping the value is dropping the whole artifact.
 */
export const EVENT_ENVELOPE_STREAM_FIELDS = ['parent_tool_use_id', 'session_id'] as const;

/**
 * The two identity fields, and the shape each must have to be restored verbatim.
 *
 * Being proven free of every credential *class* is not sufficient on its own, and this is the gap the
 * shapes close. The proof deliberately runs with the entropy heuristic switched off — it has to, because
 * that heuristic is what condemns a ULID and a commit SHA in the first place — so without a shape check
 * a high-entropy secret carrying no known prefix would be restored verbatim here while the same value in
 * a payload was replaced.
 *
 * So the gate does not ask "does this look safe?" but "is this the identifier the field claims to hold?".
 * Both shapes are a fixed length over a restricted alphabet, which no credential format satisfies. A
 * value failing its shape keeps whatever the pass produced.
 */
export const EVENT_ENVELOPE_IDENTITY_SHAPES: Readonly<Record<string, RegExp>> = Object.freeze({
  /** A ULID: 26 characters of Crockford base32, the leading one at most `7` (AD-29). */
  run: /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/,
  /** A full commit SHA, which is what an AD-26 baseline ref always is. */
  baseline_ref: /^[0-9a-f]{40}$/,
});

/**
 * Whether a value is the identifier its field claims to hold.
 *
 * A field with no declared shape answers `false`: the allow-list grows by declaring a narrow shape, never
 * by a field appearing in it without one.
 */
export const hasEventIdentityShape = (field: string, value: string): boolean => {
  // Own-property membership only, so a prototype key such as `constructor` cannot resolve to an
  // `Object` member masquerading as a declared shape.
  if (!Object.prototype.hasOwnProperty.call(EVENT_ENVELOPE_IDENTITY_SHAPES, field)) return false;
  return EVENT_ENVELOPE_IDENTITY_SHAPES[field]?.test(value) ?? false;
};

/** Ordering is by `seq`; timestamps carry no ordering authority across processes (AD-29). */
export const compareEventOrder = (a: EventEnvelope, b: EventEnvelope): number => a.seq - b.seq;
