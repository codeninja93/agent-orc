/**
 * AD-25 — the question lifecycle is one compare-and-set transition.
 *
 * Three resolvers compete for every question — the TUI answer (story 1-8), the web answer
 * (story 3-1) and the timeout default (story 1-10). Exactly one transition from `asked` is
 * accepted; the losers receive an already-resolved result and write nothing. The transition is a
 * pure function here so all three resolvers share one state machine; the compare-and-set against
 * the question state file belongs to the engine.
 *
 * The question's shape also carries the interface contract's question rules: a recommended
 * default and at most three concrete options plus an escape (Q1), what happens if ignored and the
 * window before it does (Q2), and a self-contained mini-brief (Q3).
 */
import { z } from 'zod';

import { PrincipalSchema } from './command.js';
import { TimestampSchema } from './event.js';
import { versioned } from './schema-version.js';

export const QuestionOptionSchema = z.object({
  id: z.string(),
  label: z.string(),
  /** Q1 — the consequence of taking this option, stated on the card. */
  consequence: z.string(),
});

export type QuestionOption = z.infer<typeof QuestionOptionSchema>;

/** Every id a resolver may select: the concrete options plus the escape (Q1). */
export const offeredOptionIds = (card: {
  readonly options: readonly QuestionOption[];
  readonly escape: QuestionOption;
}): readonly string[] => [...card.options.map((option) => option.id), card.escape.id];

/**
 * What a step agent raises, before the engine mints an id and timestamps it. `maxItems` is the
 * only array bound used: AD-2 forbids `minItems` above one, never a maximum.
 */
export const QuestionDraftSchema = z
  .object({
    prompt: z.string(),
    /** Q3 — answerable without reloading the feature into the user's head. */
    brief: z.string(),
    /** Q1 — at most three concrete options. */
    options: z.array(QuestionOptionSchema).max(3),
    /** Q1 — plus an escape. */
    escape: QuestionOptionSchema,
    /** Q1 — the recommended default, by option id. */
    recommended_option_id: z.string(),
    /** Q2 — what happens if the question is ignored. */
    default_action: z.string(),
    /** Q2 — the window before that happens, in milliseconds. */
    default_window_ms: z.number(),
  })
  // Q1 — a card with no concrete option is open-ended, which the interface contract forbids.
  // Refinements, not `minItems`, because AD-2 keeps array lower bounds out of the export.
  .refine((question) => question.options.length > 0, {
    message: 'a question must offer at least one concrete option',
    path: ['options'],
  })
  .refine(
    (question) => new Set(question.options.map((option) => option.id)).size === question.options.length,
    { message: 'option ids must be unique within a question', path: ['options'] },
  )
  .refine((question) => offeredOptionIds(question).includes(question.recommended_option_id), {
    message: 'recommended_option_id must name one of the offered options or the escape',
    path: ['recommended_option_id'],
  });

export type QuestionDraft = z.infer<typeof QuestionDraftSchema>;

export const QuestionSchema = QuestionDraftSchema.extend({
  id: z.string(),
  feature: z.string(),
  run: z.string(),
  step: z.string().nullable(),
  asked_at: TimestampSchema,
});

export type Question = z.infer<typeof QuestionSchema>;

/** The single state machine. `asked` is the only state a transition may leave. */
export const QUESTION_STATES = ['asked', 'resolved', 'deflected'] as const;

export type QuestionStatus = (typeof QUESTION_STATES)[number];

/** The three competing resolvers of AD-25. */
export const QUESTION_RESOLVERS = ['tui', 'web', 'timeout_default'] as const;

export type QuestionResolver = (typeof QUESTION_RESOLVERS)[number];

/** Q4 — a question is first attempted against these sources before it may reach the user. */
export const DEFLECTION_SOURCES = ['repository', 'git_history', 'decision_ledger'] as const;

export type DeflectionSource = (typeof DEFLECTION_SOURCES)[number];

export const QuestionResolutionSchema = z.object({
  /** The winning resolver, recorded by the accepted transition. */
  resolver: z.enum(QUESTION_RESOLVERS),
  /** The principal the answer is attributable to (AD-19, AD-25). */
  principal: PrincipalSchema,
  /** Free text; the system parses (Q6). */
  answer: z.string(),
  /** The option the answer selected, when it selected one. */
  option_id: z.string().nullable(),
  resolved_at: TimestampSchema,
});

export type QuestionResolution = z.infer<typeof QuestionResolutionSchema>;

export const QuestionDeflectionSchema = z.object({
  source: z.enum(DEFLECTION_SOURCES),
  answer: z.string(),
  /** A durable anchor — a test name, API symbol or module name. Never a line number. */
  anchor: z.string(),
  deflected_at: TimestampSchema,
});

export type QuestionDeflection = z.infer<typeof QuestionDeflectionSchema>;

/** The on-disk question state file under `runs/<run-id>/questions/`. */
export const QuestionStateSchema = versioned({
  question: QuestionSchema,
  status: z.enum(QUESTION_STATES),
  resolution: QuestionResolutionSchema.nullable(),
  deflection: QuestionDeflectionSchema.nullable(),
})
  // The status and its payload are one fact, so they may not disagree: otherwise a `resolved`
  // question can carry no resolution and still be reported as writing to the decision ledger.
  .refine((state) => (state.status === 'resolved') === (state.resolution !== null), {
    message: 'status "resolved" and a non-null resolution must accompany each other',
    path: ['resolution'],
  })
  .refine((state) => (state.status === 'deflected') === (state.deflection !== null), {
    message: 'status "deflected" and a non-null deflection must accompany each other',
    path: ['deflection'],
  });

export type QuestionState = z.infer<typeof QuestionStateSchema>;

/** The outcome of an attempted transition. A losing resolver is told, not thrown at. */
export interface QuestionTransition {
  /** True only for the one transition that won the compare-and-set. */
  readonly accepted: boolean;
  /** The resulting state — unchanged when the transition lost. */
  readonly state: QuestionState;
  /** Why a transition was refused, for the losing resolver to render. */
  readonly refusal: string | null;
}

const refuse = (state: QuestionState, refusal: string): QuestionTransition => ({
  accepted: false,
  state,
  refusal,
});

/** Attempt the one accepted `asked` → `resolved` transition. */
export const resolveQuestion = (
  state: QuestionState,
  resolution: QuestionResolution,
): QuestionTransition => {
  if (state.status !== 'asked') {
    return refuse(
      state,
      `Question ${state.question.id} is already ${state.status}; this resolver wrote nothing.`,
    );
  }
  const offered = offeredOptionIds(state.question);
  if (resolution.option_id !== null && !offered.includes(resolution.option_id)) {
    return refuse(
      state,
      `Question ${state.question.id}: option "${resolution.option_id}" was never offered ` +
        `(offered: ${offered.join(', ')}); this resolver wrote nothing.`,
    );
  }
  return {
    accepted: true,
    state: { ...state, status: 'resolved', resolution, deflection: null },
    refusal: null,
  };
};

/** Attempt the `asked` → `deflected` transition (Q4): answered without reaching the user. */
export const deflectQuestion = (
  state: QuestionState,
  deflection: QuestionDeflection,
): QuestionTransition => {
  if (state.status !== 'asked') {
    return refuse(
      state,
      `Question ${state.question.id} is already ${state.status}; this deflection wrote nothing.`,
    );
  }
  return {
    accepted: true,
    state: { ...state, status: 'deflected', resolution: null, deflection },
    refusal: null,
  };
};

/** AD-25 — only a resolved question writes to the decision ledger. */
export const writesToDecisionLedger = (state: QuestionState): boolean => state.status === 'resolved';

/**
 * The event a resolution emits. A timeout default is reported as `question.default_taken`, every
 * other resolver as `question.resolved`, so the mapping lives in one place.
 */
export const eventTypeForResolution = (
  resolution: QuestionResolution,
): 'question.default_taken' | 'question.resolved' =>
  resolution.resolver === 'timeout_default' ? 'question.default_taken' : 'question.resolved';
