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

/** Ordering is by `seq`; timestamps carry no ordering authority across processes (AD-29). */
export const compareEventOrder = (a: EventEnvelope, b: EventEnvelope): number => a.seq - b.seq;
