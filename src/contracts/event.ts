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
 * The ledger line a resolved question writes (AD-25, amended by ADR-002).
 *
 * Declared here, as a named constant, for the reason ADR-002 gives: AD-25 *requires* a decision ledger
 * and says only a resolved question writes to it, so the type carrying that record has to be declarable.
 * AD-5's open vocabulary makes an undeclared type legal to *read*, which is not a reason for this
 * project's own writer to emit one — and `isDeclaredEventType('decision.recorded')` answered `false`
 * while `isDeclaredEventType('question.resolved')` answered `true`.
 *
 * `src/engine/decision.ts` points its `DECISION_EVENT_TYPE` at this constant rather than spelling the
 * string a second time, so there is one spelling of the type in the codebase.
 */
export const DECISION_RECORDED_EVENT_TYPE = 'decision.recorded';

/**
 * The three types story 1-11 added, and the payload keys they and the enriched `question.asked` carry.
 *
 * **Spelled here and nowhere else**, which the story claimed and did not have: each name was written out
 * again in `src/engine/` and a third time in `TUI_PAYLOAD_KEYS`, so a rename would have left a writer and a
 * reader disagreeing about a string with nothing to catch it — and a fold that silently stops reading a key
 * is exactly the drift `TUI_PAYLOAD_KEYS`' own comment warns about. `src/tui/` may not import `src/engine/`,
 * but it may import this, so the one shared home for a name on disk is the contracts layer.
 */
export const SPEC_RECORDED_EVENT_TYPE = 'spec.recorded';
export const SPEC_CRITERION_EDITED_EVENT_TYPE = 'spec.criterion_edited';
export const FEATURE_TERRITORY_DECLARED_EVENT_TYPE = 'feature.territory_declared';

/** The payload keys of the three declaration types, and of the keys 1-11 added to `question.asked`. */
export const DECLARATION_PAYLOAD_KEYS = {
  /** `spec.recorded` — the user's own words. */
  Request: 'request',
  /** `spec.recorded` — the criteria, in their declared order. */
  AcceptanceCriteria: 'acceptance_criteria',
  /** `spec.criterion_edited` — which line, 1-based, or `null` for an amendment that named none (Q6). */
  CriterionLine: 'line',
  /** `spec.criterion_edited` — the amended wording, as the person wrote it. */
  CriterionText: 'text',
  /** `feature.territory_declared` — the normalised declared paths. */
  TerritoryPaths: 'paths',
  /** `question.asked` — each option's id, label, consequence and escape flag (Q1). */
  OfferedOptions: 'offered_options',
  /** `question.asked` — the self-contained mini-brief (Q3). */
  Brief: 'brief',
  /** `question.asked` — the instant a countdown is measured from (Q2). */
  AskedAt: 'asked_at',
} as const;

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
  /**
   * The decision a resolved question left (AD-25, ADR-002 decision 4).
   *
   * Separate from `question.resolved` on purpose: the first says a transition happened, this says a
   * decision was recorded — which is what makes "only a resolved question writes to the decision ledger"
   * observable rather than inferred, because a deflection emits the first kind of line and never this one.
   */
  DECISION_RECORDED_EVENT_TYPE,
  /**
   * The request and the ordered acceptance criteria this run is built against (CAP-2).
   *
   * Story 1-10 found that the criteria reached disk only in a step input file and `state.json`, both of
   * which AD-4 ranks below the log — so the spec echo was the one required surface that could not be
   * reconstructed from `events.jsonl` alone. This type is that gap closed. The later line wins: a second
   * `spec.recorded` for one feature replaces the set rather than adding to it.
   */
  SPEC_RECORDED_EVENT_TYPE,
  /** One criterion amended through `edit_criterion`, so the current text is in the log (CAP-2). */
  SPEC_CRITERION_EDITED_EVENT_TYPE,
  /**
   * The declared file territory, so an overlap is recomputable by replay.
   *
   * The Consistency Conventions serialise features whose declared territories overlap, and until now the
   * territory lived only in the in-memory plan and the AD-9 config snapshot — so a replay could not tell
   * why two features were serialised. See {@link FeatureTerritoryDeclaredPayloadSchema} for the one thing
   * AD-21 does to this payload that a reader has to expect.
   */
  FEATURE_TERRITORY_DECLARED_EVENT_TYPE,
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

/**
 * The key a *repair* carries, so a replay can tell a back-filled declaration from the original one.
 *
 * `recordDeclarations` in `src/engine/reconciler.ts` appends the declarations a crash left the log owing,
 * on a later pass and from the plan as it reads *then*. Nothing else distinguishes that from the line
 * `acceptFeature` writes at the moment the run is accepted — so a run whose plan changed in between would
 * gain a declaration claiming to be what it was accepted against, and a reader reconstructing the run from
 * the log alone would have no way to doubt it. The key is optional and additive, which AD-5 makes
 * non-breaking: an older reader ignores it and a newer one knows not to read a repair as a declaration.
 *
 * Spelled once, here, beside the three schemas that admit it, so the emitter and every reader use the same
 * string.
 */
export const REPAIRED_PAYLOAD_KEY = 'repaired';

/** The optional `repaired` marker the three declaration payloads share. */
const repairedKey = { [REPAIRED_PAYLOAD_KEY]: z.boolean().optional() };

/**
 * The payload of a `spec.recorded` line: the user's words, and the criteria in the order they were stated.
 *
 * Loose rather than closed, for the same reason the envelope is: AD-5 makes adding a key non-breaking, so
 * a key a later build adds must survive this build's parse rather than being stripped by it.
 *
 * **What AD-21 does to this payload, stated because it is the one surprise here.** The criteria are prose
 * and prose survives the entropy sweep — a run of punctuated words never reaches the 24-character unbroken
 * threshold. An *identifier quoted inside* a criterion does not: a genuine ULID carries roughly 4.6 bits
 * per character and a full commit SHA roughly 4.0, both above the sweep's 3.5, so each is replaced by the
 * redaction marker while the sentence around it survives. That is AD-21 working as specified and there is
 * no remedy for it that is not a wider allow-list, which AD-21 forbids: a surface therefore presents such
 * a criterion through `presentValue`, which says `(redacted in the log)` rather than showing a marker as
 * content. `tests/runtime.redaction-survival.test.ts` pins both halves against a real ULID.
 */
export const SpecRecordedPayloadSchema = z.looseObject({
  /** The user's original words, verbatim. */
  [DECLARATION_PAYLOAD_KEYS.Request]: z.string(),
  /** The criteria, in the declared order. Replaced wholesale by a later `spec.recorded`. */
  [DECLARATION_PAYLOAD_KEYS.AcceptanceCriteria]: z.array(z.string()),
  ...repairedKey,
});

export type SpecRecordedPayload = z.infer<typeof SpecRecordedPayloadSchema>;

/**
 * The payload of a `spec.criterion_edited` line.
 *
 * `line` is 1-based, as the spec echo card numbers them, and nullable because Q6 forbids imposing a format
 * on a person: an amendment whose wording names no line is still recorded, with the text it carried, and a
 * reader states it as an edit it could not place rather than discarding it.
 */
export const SpecCriterionEditedPayloadSchema = z.looseObject({
  [DECLARATION_PAYLOAD_KEYS.CriterionLine]: z.int().nullable(),
  /** The amended criterion as the person wrote it, unaltered. */
  [DECLARATION_PAYLOAD_KEYS.CriterionText]: z.string(),
  ...repairedKey,
});

export type SpecCriterionEditedPayload = z.infer<typeof SpecCriterionEditedPayloadSchema>;

/**
 * The payload of a `feature.territory_declared` line.
 *
 * **A long path does not survive AD-21, and the replay must expect that.** A repository path is usually
 * broken by a dot or a hyphen and so splits into runs far below the sweep's 24-character threshold —
 * `src/engine`, `src/runtime/recorder.ts`. A long path with no dot and no hyphen does not: measured,
 * `docs/planning/architecture/spine/decisions/records` is a single 50-character run at 3.78 bits per
 * character and is replaced whole. The replay in `src/engine/territory.ts` therefore reports how many
 * entries it could not read and treats an incomplete territory as colliding with everything, which is the
 * fail-safe direction — a feature serialised unnecessarily costs a pass, and one admitted wrongly costs
 * another feature's work.
 */
export const FeatureTerritoryDeclaredPayloadSchema = z.looseObject({
  /** The normalised declared paths. */
  [DECLARATION_PAYLOAD_KEYS.TerritoryPaths]: z.array(z.string()),
  ...repairedKey,
});

export type FeatureTerritoryDeclaredPayload = z.infer<typeof FeatureTerritoryDeclaredPayloadSchema>;
