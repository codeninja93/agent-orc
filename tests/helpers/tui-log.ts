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

export const stepTerminated = (step: string, disposition = 'completed'): EventSpec => ({
  type: 'step.terminated',
  step,
  payload: { disposition, reason: `the step reported ${disposition}` },
});

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

export const budgetDegraded = (consumed: number, wallClockMsRemaining?: number): EventSpec => ({
  type: 'budget.degraded',
  payload: {
    rate_limit_budget_consumed: consumed,
    ...(wallClockMsRemaining === undefined
      ? {}
      : { wall_clock_ms_remaining: wallClockMsRemaining }),
  },
});

/** An event type this build does not declare, as a newer engine would write it (AD-5). */
export const unknownEvent = (type = 'trust.record_updated'): EventSpec => ({
  type,
  payload: { schema_version: CURRENT_SCHEMA_VERSION, area: 'src/tui', merged_unchanged: 3 },
});
