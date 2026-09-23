/**
 * Event logs for the TUI suites: a builder for the envelopes a fold reads.
 *
 * It exists so four suites describe one log the same way, and so the *shape* of a line is declared in
 * one place. The envelope is AD-5's, the `seq` is monotonic from 1 as the recorder assigns it, and the
 * timestamps are RFC3339 with milliseconds — because a fold that was tested against envelopes the
 * recorder would never write would be a fold tested against nothing.
 *
 * The payload keys here are deliberately the engine's own. `tests/tui.projection.test.ts` also folds a
 * log a *real* reconciler wrote, which is what catches a key renamed on the engine's side; this builder
 * is for the cases a real run cannot reach yet, such as the AD-24 budget events story 2-9 owns.
 */
import { CURRENT_SCHEMA_VERSION } from '../../src/contracts/index.js';
import type { EventEnvelope } from '../../src/contracts/index.js';

/** The instant every fixture log starts at, so an elapsed assertion has a fixed origin. */
export const FIXTURE_RUN_START_MS = Date.parse('2026-09-20T09:00:00.000Z');

/** A run id, present in the envelope and — the point of R6 — never in a rendered frame. */
export const FIXTURE_RUN = '01K5NQ9ZJ7V3M2P9XQWRTC4BDE';

export const FIXTURE_FEATURE = 'tui-shell';

/** One line of a fixture log, before `seq` and `ts` are assigned. */
export interface EventSpec {
  readonly type: string;
  readonly payload?: Record<string, unknown>;
  readonly step?: string | null;
  /** Milliseconds after the run's first line; defaults to one second per line. */
  readonly atMs?: number;
  readonly feature?: string;
  readonly emitter?: string;
}

/** Assign `seq` from 1 and a timestamp to each spec, producing envelopes a reader would accept. */
export const buildLog = (
  specs: readonly EventSpec[],
  options: { readonly feature?: string; readonly run?: string } = {},
): EventEnvelope[] =>
  specs.map((spec, index) => ({
    ts: new Date(FIXTURE_RUN_START_MS + (spec.atMs ?? index * 1_000)).toISOString(),
    seq: index + 1,
    feature: spec.feature ?? options.feature ?? FIXTURE_FEATURE,
    run: options.run ?? FIXTURE_RUN,
    step: spec.step ?? null,
    emitter: spec.emitter ?? 'engine.reconciler',
    type: spec.type,
    payload: spec.payload ?? {},
  }));

/** `events.jsonl` as the recorder writes it: one object per line, newline-terminated. */
export const logText = (events: readonly EventEnvelope[]): string =>
  `${events.map((event) => JSON.stringify(event)).join('\n')}\n`;

// -------------------------------------------------------------------------------------------------
// The specs, in the engine's own spelling
// -------------------------------------------------------------------------------------------------

export const runCreated = (
  payload: Record<string, unknown> = { mode: 'live', step_count: 2 },
): EventSpec => ({ type: 'run.created', payload });

export const featureStateChanged = (to: string, from = 'drafting'): EventSpec => ({
  type: 'feature.state_changed',
  payload: { from, to, reason: `the run entered ${to}` },
});

export const stepStarted = (step: string, phase = 'implementation'): EventSpec => ({
  type: 'step.started',
  step,
  payload: { attempt: 1, phase, contract_id: 'step.output', model_tier: 'claude-haiku-4-5' },
});

/** One deterministic gate's outcome, as the engine records it (CAP-13's first tier, story 2-6). */
export const gateRecorded = (
  gate: string,
  outcome: 'passed' | 'failed' | 'skipped',
  overrides: { readonly exit_status?: number | null; readonly evidence?: string } = {},
): EventSpec => ({
  type: `gate.${outcome}`,
  step: 'verify',
  payload: {
    gate,
    exit_status: overrides.exit_status ?? (outcome === 'skipped' ? null : outcome === 'passed' ? 0 : 1),
    evidence: overrides.evidence ?? (outcome === 'skipped' ? '' : `evidence/${gate}-1-1.log`),
    reason: `the ${gate} gate ${outcome}`,
  },
});

/** No model-based review was spawned, and why (CAP-13's economics). */
export const reviewSkipped = (reason: string): EventSpec => ({
  type: 'verification.review_skipped',
  step: 'verify',
  payload: { reason, failed_gates: ['test'] },
});

export const stepTerminated = (step: string, disposition = 'completed'): EventSpec => ({
  type: 'step.terminated',
  step,
  payload: { disposition, reason: `the step reported ${disposition}` },
});

/**
 * A termination that reports what the attempt cost, as story 1-11 has the engine record it.
 *
 * Separate from {@link stepTerminated} rather than an option on it, because "a step that recorded no usage"
 * is the case R8 is about and it has to stay the easy one to write: a builder that defaulted to zeros would
 * make every existing fixture claim its steps were free.
 */
export const stepTerminatedWithUsage = (
  step: string,
  usage: Record<string, number | null>,
  disposition = 'completed',
): EventSpec => ({
  type: 'step.terminated',
  step,
  payload: {
    disposition,
    reason: `the step reported ${disposition}`,
    usage: {
      cost_usd: null,
      input_tokens: null,
      output_tokens: null,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
      ...usage,
    },
  },
});

/** CAP-2 — the request and the ordered criteria, as `acceptFeature` records them. */
export const specRecorded = (
  criteria: readonly string[],
  request = 'add a persistent question slot that does not scroll away',
): EventSpec => ({
  type: 'spec.recorded',
  payload: { request, acceptance_criteria: [...criteria] },
});

/** One criterion amended. `line` is 1-based, and `null` for an amendment that named no line (Q6). */
export const specCriterionEdited = (line: number | null, text: string): EventSpec => ({
  type: 'spec.criterion_edited',
  payload: { line, text },
});

/** The declared territory, as `acceptFeature` records it. */
export const territoryDeclared = (paths: readonly string[]): EventSpec => ({
  type: 'feature.territory_declared',
  payload: { paths: [...paths] },
});

/**
 * `question.asked` as an **older** engine wrote it: option ids only, no brief, no `asked_at`.
 *
 * Kept exactly as story 1-10 wrote it, and that is its job now. AD-5 requires a payload key added later to
 * be non-breaking, so this builder *is* the forward-compatibility fixture: a card folded from it must state
 * the missing facts as unrecorded and must not throw. {@link questionAskedEnriched} is the shape the engine
 * writes today.
 */
export const questionAsked = (
  questionId: string,
  overrides: Record<string, unknown> = {},
): EventSpec => ({
  type: 'question.asked',
  payload: {
    question_id: questionId,
    prompt: 'Should the shell poll the log, or watch it?',
    options: 'poll, watch',
    recommended_option_id: 'poll',
    default_action: 'poll every second',
    default_window_ms: 600_000,
    ...overrides,
  },
});

/** The three options the enriched builder offers, with the escape flagged as the engine flags it (Q1). */
export const FIXTURE_OFFERED_OPTIONS: readonly Record<string, unknown>[] = [
  { id: 'poll', label: 'poll', consequence: 'one read a second, and no line can be missed', escape: false },
  { id: 'watch', label: 'watch', consequence: 'redraws instantly, and may miss a line', escape: false },
  {
    id: 'ask-me',
    label: 'ask me again with more detail',
    consequence: 'nothing changes yet and the question comes back',
    escape: true,
  },
];

/**
 * `question.asked` as the engine writes it since story 1-11: each option's label and consequence, the Q3
 * brief, and the `asked_at` a countdown is measured from.
 *
 * `options` keeps its older meaning — the joined ids — because AD-5 makes changing a key's meaning breaking.
 */
export const questionAskedEnriched = (
  questionId: string,
  overrides: Record<string, unknown> = {},
): EventSpec => ({
  ...questionAsked(questionId, {
    options: 'poll, watch, ask-me',
    offered_options: FIXTURE_OFFERED_OPTIONS,
    brief:
      'The shell re-reads the log to redraw. Polling cannot miss a line; watching is cheaper but can drop ' +
      'a notification on some volumes.',
    asked_at: new Date(FIXTURE_RUN_START_MS + 2_000).toISOString(),
    ...overrides,
  }),
});

export const questionResolved = (questionId: string, answer = 'poll, it cannot miss a line'): EventSpec => ({
  type: 'question.resolved',
  payload: {
    question_id: questionId,
    resolver: 'tui',
    principal_kind: 'user',
    principal_id: 'deep',
    option_id: 'poll',
    answer,
  },
});

export const questionDefaultTaken = (questionId: string): EventSpec => ({
  type: 'question.default_taken',
  payload: {
    question_id: questionId,
    resolver: 'timeout_default',
    principal_kind: 'timeout',
    principal_id: 'question-window',
    option_id: 'poll',
    answer: 'poll every second',
  },
});

export const commandApplied = (
  command: string,
  overrides: Record<string, unknown> = {},
): EventSpec => ({
  type: 'command.applied',
  payload: {
    intent_id: `cmd-${command}-01`,
    command,
    principal_kind: 'user',
    principal_id: 'deep',
    source: 'tui',
    issued_at: new Date(FIXTURE_RUN_START_MS).toISOString(),
    effect: `${command} was applied`,
    reason: `the user invoked ${command}`,
    ...overrides,
  },
});

/**
 * `command.refused` as `refuseIntent` records it — the notice channel for a control that did nothing.
 *
 * The payload is `commandRefusedPayload`'s: a constant reason, the detail sentence, and the intent it
 * names. A refusal with no notice is a person watching their keystroke vanish, which is why this builder
 * exists at all: the branch that renders it had no fixture and no test until story 1-9's review round.
 */
export const commandRefused = (
  command: string,
  reason = 'wrong-target-state',
  detail = `"${command}" named a run state that has no gate to approve, so nothing changed`,
): EventSpec => ({
  type: 'command.refused',
  payload: { reason, detail, intent_id: `cmd-${command}-01`, command },
});

/** `permission.denied` as the spawner records it: the tool, why, and the AD-35 disposition. */
export const permissionDenied = (
  tool = 'Bash',
  reason = 'the command is outside the allowed set',
): EventSpec => ({
  type: 'permission.denied',
  step: 'implement',
  payload: {
    tool,
    tool_use_id: 'toolu-01',
    reason,
    reason_type: 'permission_rule',
    disposition: 'escalate-to-human',
  },
});

/** `redaction.failed` as the recorder appends it in place of the artifact it dropped (AD-21). */
export const redactionFailed = (droppedType = 'step.terminated'): EventSpec => ({
  type: 'redaction.failed',
  payload: {
    reason: 'pattern-unredactable',
    cause: 'a declared credential pattern could not be replaced',
    dropped_event_type: droppedType,
    disposition: 'abandon-and-hand-off',
    detail:
      'The artifact was dropped before any append. AD-21 fails closed and records no part of the ' +
      'value that triggered the failure.',
  },
});

/** `question.deflected` (Q4): answered from the repository, with no resolver, because nobody was asked. */
export const questionDeflected = (
  questionId: string,
  answer = 'the repository already answers this: the shell polls',
): EventSpec => ({
  type: 'question.deflected',
  payload: {
    question_id: questionId,
    source: 'repository',
    anchor: 'src/tui/app.tsx',
    answer,
    deflected_at: new Date(FIXTURE_RUN_START_MS + 3_000).toISOString(),
  },
});

export const budgetDegraded = (consumed: number, wallClockMsRemaining?: number): EventSpec => ({
  type: 'budget.degraded',
  payload: {
    rate_limit_budget_consumed: consumed,
    ...(wallClockMsRemaining === undefined
      ? {}
      : { wall_clock_ms_remaining: wallClockMsRemaining }),
  },
});

/**
 * CAP-23 — the hand-off, as the reconciler records it.
 *
 * The payload is `{ code, reason }` and nothing else, which is the shape the engine writes today: neither
 * the takeover branch nor the document's path is in it, and story 1-10's handoff card is given both rather
 * than inferring a branch name it does not own (AD-22).
 */
export const handoffRecorded = (
  code = 'user.take_over',
  reason = 'you took the work over, so the partial work is on its own branch and the run halted',
): EventSpec => ({ type: 'handoff.recorded', payload: { code, reason } });

/** An event type this build does not declare, as a newer engine would write it (AD-5). */
export const unknownEvent = (type = 'trust.record_updated'): EventSpec => ({
  type,
  payload: { schema_version: CURRENT_SCHEMA_VERSION, area: 'src/tui', merged_unchanged: 3 },
});
