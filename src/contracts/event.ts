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
 * The identifier fields a recorder restores verbatim after the AD-21 pass, by field path.
 *
 * Every one of them is an identifier the system reads back: the run and feature the line belongs
 * to, the step that emitted it, the two stream-origin fields AD-5 requires unchanged, and the AD-26
 * baseline ref a re-run resets to. A ULID, a commit SHA and a `claude` session id are each one
 * unbroken high-entropy run, so the pass's entropy heuristic replaces them wherever they appear —
 * which would leave the durable truth unable to name its own run, its own step or the commit a step
 * began at, against AD-4.
 *
 * The allow-list is by *field path*, never by value shape: story 1-2 established that a shape
 * exemption is what let a real credential through, so a listed field is restored only when the
 * original is proven free of every credential class the pass recognises. The two stream fields are
 * dropped when that proof fails, because AD-5 requires them verbatim or not at all; the four
 * identity fields keep the redacted value instead, so a line is still written.
 */
export const EVENT_ENVELOPE_VERBATIM_FIELDS = [
  'run',
  'feature',
  'step',
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

/** Ordering is by `seq`; timestamps carry no ordering authority across processes (AD-29). */
export const compareEventOrder = (a: EventEnvelope, b: EventEnvelope): number => a.seq - b.seq;
