/**
 * AD-25 — the question lifecycle, made durable and provably single-winner across processes.
 *
 * Story 1-1 shipped the state machine as pure functions, and this module keeps them: `resolveQuestion`
 * and `deflectQuestion` still decide what a transition *means*. What they cannot decide is who is
 * allowed to make it. `resolveQuestion` refuses a state that is not `asked`, but a caller that reads a
 * state file, calls it, and writes the result has performed a read-then-write — and two processes can
 * both read `asked`, both pass the check, and both write. That is the race AD-25 exists to prevent, and
 * no ordering of those three steps closes it.
 *
 * **The compare-and-set is an exclusively created file.** `open(O_EXCL)` fails for the second creator on
 * every filesystem this runs on, which is a genuine atomic test-and-set; the repository already relies on
 * it twice, in the recorder's writer claim and in the AD-30 engine lock. So the *resolution* is the
 * exclusively created file — `questions/<id>/outcome.json` — and the question's `state.json` is
 * **derived** from it rather than being the thing contended for. The first creator wins by construction:
 * there is no window between a check and a write, because there is no check.
 *
 * Three consequences follow, and each is load-bearing:
 *
 * - **A losing resolver writes nothing.** Its `open` fails, it reads the outcome that stands, and it is
 *   handed story 1-1's already-resolved refusal to render. Refusing *after* writing would not be a
 *   compare-and-set, however carefully the write were ordered.
 * - **The durable write precedes the effect, and the effect is idempotent on the question id.** The
 *   outcome file lands before any event does, so a crash in between leaves the decision made and the
 *   log silent — which a later pass finishes, because the state file and the events are both derived
 *   from the outcome. The alternative order would lose the decision a person had already given.
 * - **A redelivered intent is the same gesture, not a second resolver.** The outcome records the
 *   `intent_id` that claimed it, so an intent delivered twice — which AD-19 allows — is recognised as
 *   the winner rather than reported to the user as having lost to itself.
 *
 * A question id travels in an event payload, and story 1-7 paid for that lesson already: AD-21's pass
 * replaces an unbroken high-entropy run wherever it appears, so a bare ULID is redacted out of the one
 * field the idempotence rests on. {@link mintQuestionId} punctuates for exactly that reason.
 */
import {
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

import {
  CURRENT_SCHEMA_VERSION,
  QUESTION_RESOLVERS,
  QuestionDeflectionSchema,
  QuestionDraftSchema,
  QuestionResolutionSchema,
  QuestionSchema,
  QuestionStateSchema,
  deflectQuestion,
  eventTypeForResolution,
  formatTimestamp,
  offeredOptionIds,
  parseVersionedArtifact,
  resolveQuestion,
  versioned,
} from '../contracts/index.js';
import type {
  CommandSource,
  EventEnvelope,
  Principal,
  Question,
  QuestionDeflection,
  QuestionDraft,
  QuestionOption,
  QuestionResolution,
  QuestionResolver,
  QuestionState,
} from '../contracts/index.js';
import { QUESTION_OUTCOME_FILE_NAME, questionPaths } from '../runtime/index.js';
import type { QuestionPaths, RunPaths } from '../runtime/index.js';

/**
 * The four event types AD-25 names, already declared in the shared vocabulary.
 *
 * Spelled as a table here so nothing in the engine writes one as a literal: `question.resolved` and
 * `question.default_taken` are the two halves of one transition, and the mapping between a resolution
 * and its type lives in story 1-1's `eventTypeForResolution` rather than being decided twice.
 */
export const QUESTION_EVENT_TYPES = {
  /** A question became durable and reached a person (AD-25). */
  Asked: 'question.asked',
  /** A resolver other than the clock won the compare-and-set. */
  Resolved: 'question.resolved',
  /** The window expired and the recommended default won the compare-and-set (CAP-4). */
  DefaultTaken: 'question.default_taken',
  /** The question was answered from repository, history or ledger, so nobody was asked (Q4). */
  Deflected: 'question.deflected',
} as const;

export type QuestionEventType = (typeof QUESTION_EVENT_TYPES)[keyof typeof QUESTION_EVENT_TYPES];

/** The three types a question's *outcome* is reported as; `question.asked` is not one of them. */
export const QUESTION_OUTCOME_EVENT_TYPES: readonly string[] = Object.freeze([
  QUESTION_EVENT_TYPES.Resolved,
  QUESTION_EVENT_TYPES.DefaultTaken,
  QUESTION_EVENT_TYPES.Deflected,
]);

/** The payload key every question event carries its id under, so a reader keys on one spelling. */
export const QUESTION_ID_PAYLOAD_KEY = 'question_id';

/**
 * The longest unbroken alphanumeric run a question id may contain.
 *
 * The same bound, for the same reason, as story 1-7's intent id: AD-21's high-entropy rule considers
 * runs of `[A-Za-z0-9+/=]` at least 24 characters long, so an id whose runs all stay under that cannot be
 * reached by the rule whatever its entropy. The guard is on *shape*, which is checkable here, rather
 * than on entropy, which depends on a policy this module does not own.
 */
export const MAX_QUESTION_ID_TOKEN_RUN = 23;

/** The shape a question id must take: a safe path segment whose runs survive the log. */
export const QUESTION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

const LONGEST_TOKEN_RUN = /[A-Za-z0-9+/=]+/g;

/**
 * True when this question id can be written to a payload and read back unchanged.
 *
 * It has to be, and the reason is the whole of the crash story: the effect of a transition is made
 * idempotent by recognising the question id already in the log, so an id the log replaces with the
 * redaction marker is an id whose event would be emitted again on every later pass.
 */
export const isLoggableQuestionId = (id: string): boolean => {
  if (!QUESTION_ID_PATTERN.test(id)) return false;
  for (const run of id.match(LONGEST_TOKEN_RUN) ?? []) {
    if (run.length > MAX_QUESTION_ID_TOKEN_RUN) return false;
  }
  return true;
};

/** The prefix every minted question id carries, so a directory under `questions/` reads at a glance. */
export const QUESTION_ID_PREFIX = 'q';

/**
 * Mint a question id from a ULID, punctuated into groups.
 *
 * Story 1-7's `mintIntentId` in one sentence: the same 26 characters unbroken carry 4.1 bits each and are
 * exactly what AD-21's sweep exists to catch, so the id that keys the idempotence would be redacted out
 * of the payload that carries it. Uniqueness and ordering come from the ULID underneath; the hyphens are
 * the only thing this adds, and they are what makes the id readable back.
 */
export const mintQuestionId = (ulid: string): string => {
  const groups = (ulid.match(/.{1,8}/g) ?? [ulid]).join('-');
  return `${QUESTION_ID_PREFIX}-${groups}`;
};

/** A question id this build cannot carry into the log, refused rather than written. */
export class UnloggableQuestionId extends Error {
  readonly code = 'config.invalid';
  readonly questionId: string;

  constructor(questionId: string) {
    super(
      `Refusing to ask a question whose id is "${questionId}": a question id must match ` +
        `${String(QUESTION_ID_PATTERN)} and contain no unbroken run of more than ` +
        `${String(MAX_QUESTION_ID_TOKEN_RUN)} alphanumeric characters, so it survives the AD-21 ` +
        'redaction pass in the event payloads that carry it. Those payloads are the only record of ' +
        'which questions have been resolved, so an id that cannot be logged cannot be made idempotent.',
    );
    this.name = 'UnloggableQuestionId';
    this.questionId = questionId;
  }
}

/**
 * The fields of a draft the interface contract requires, named so a refusal points at one of them.
 *
 * Every entry is a rule from `interface-contract.md` rather than a preference: a question with no stated
 * consequence for silence (Q2) cannot be left unanswered safely, and one that is not answerable without
 * reloading the feature into the user's head (Q3) costs the fifteen minutes the exchange rate exists to
 * protect. A draft missing one is refused rather than asked.
 */
export const QUESTION_DRAFT_FIELDS = [
  'prompt',
  'brief',
  'options',
  'escape',
  'recommended_option_id',
  'default_action',
  'default_window_ms',
] as const;

export type QuestionDraftField = (typeof QUESTION_DRAFT_FIELDS)[number];

/** A draft the interface contract forbids asking, refused naming the field at fault. */
export class QuestionDraftRefused extends Error {
  readonly code = 'question.unanswerable';
  /** The field a person has to fix. Never a dump of the whole draft. */
  readonly field: string;

  constructor(field: string, detail: string) {
    super(`Refusing to ask the question: ${detail} (field "${field}").`);
    this.name = 'QuestionDraftRefused';
    this.field = field;
  }
}

/** The field a Zod issue names, or `'(draft)'` for an issue about the object as a whole. */
const issueField = (path: readonly PropertyKey[]): string =>
  path.length === 0 ? '(draft)' : path.map(String).join('.');

/**
 * Check a draft against Q1, Q2 and Q3, naming the first field at fault.
 *
 * The declared schema covers the structural half — at most three options, a recommended id that names
 * one of them — and the checks added here cover the half a schema cannot express without forbidding a
 * legitimate value elsewhere: a blank brief is a valid string, and a zero window is a valid number, but
 * neither is a question anybody can answer. Q2's window in particular must be positive: a window of zero
 * takes the default in the same instant the question is asked, which is not a question.
 */
export const assertAskableDraft = (draft: unknown): QuestionDraft => {
  const parsed = QuestionDraftSchema.safeParse(draft);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new QuestionDraftRefused(
      issueField(issue?.path ?? []),
      issue?.message ?? 'the draft does not carry the declared question shape',
    );
  }
  const question = parsed.data;

  if (question.prompt.trim() === '') {
    throw new QuestionDraftRefused('prompt', 'a question with no prompt asks nothing');
  }
  if (question.brief.trim() === '') {
    throw new QuestionDraftRefused(
      'brief',
      'Q3 requires a self-contained mini-brief, so the question is answerable without reloading the ' +
        'feature into the user’s head',
    );
  }
  if (question.escape.label.trim() === '') {
    throw new QuestionDraftRefused('escape', 'Q1 requires an escape alongside the concrete options');
  }
  if (question.recommended_option_id.trim() === '') {
    throw new QuestionDraftRefused(
      'recommended_option_id',
      'Q1 requires a recommended default, and CAP-4 has nothing to take when the window expires without one',
    );
  }
  if (question.default_action.trim() === '') {
    throw new QuestionDraftRefused(
      'default_action',
      'Q2 requires the question to state what happens if it is ignored',
    );
  }
  if (!Number.isFinite(question.default_window_ms) || question.default_window_ms <= 0) {
    throw new QuestionDraftRefused(
      'default_window_ms',
      'Q2 requires the window before the default is taken, and a window of zero or less takes the ' +
        'default in the same instant the question is asked',
    );
  }
  return question;
};

/** Which of the three AD-25 resolvers a command source counts as. */
export const resolverForSource = (source: CommandSource): QuestionResolver =>
  source === 'web' ? 'web' : source === 'timeout' ? 'timeout_default' : 'tui';

/**
 * The exclusively created claim: the record whose *creation* decided which resolver won.
 *
 * It carries the transition's whole payload — which resolver, which principal, what they answered — so
 * the state file and the events are both derivable from it and neither is a second authority. `intent_id`
 * is here for the redelivery case AD-19 makes ordinary: the same gesture arriving twice must be told it
 * won, not told it lost to itself.
 */
export const QuestionOutcomeSchema = versioned({
  question_id: QuestionSchema.shape.id,
  resolution: QuestionResolutionSchema.nullable(),
  deflection: QuestionDeflectionSchema.nullable(),
  /** The steering intent that claimed this outcome, or `null` for the timeout resolver. */
  intent_id: QuestionSchema.shape.id.nullable(),
  claimed_at: QuestionSchema.shape.asked_at,
}).refine((outcome) => (outcome.resolution === null) !== (outcome.deflection === null), {
  message: 'an outcome records exactly one of a resolution and a deflection',
  path: ['resolution'],
});

export type QuestionOutcome = ReturnType<typeof QuestionOutcomeSchema.parse>;

/** A question state file that is not whole. Refused rather than read partially (AD-4's rule for state). */
export class TornQuestionState extends Error {
  readonly code = 'internal.invariant_violated';
  readonly questionId: string;

  constructor(questionId: string, detail: string) {
    super(
      `Refusing question ${questionId}: its state file ${detail}. A partial read would decide a ` +
        'transition from a question nobody wrote, so no transition is attempted at all.',
    );
    this.name = 'TornQuestionState';
    this.questionId = questionId;
  }
}

/** A question asked against a run that has no such question. Never invented on the spot. */
export class UnknownQuestion extends Error {
  readonly code = 'internal.invariant_violated';
  readonly questionId: string;

  constructor(runId: string, questionId: string) {
    super(
      `Run ${runId} has no question "${questionId}" under questions/, so there is nothing to resolve. ` +
        'A question is durable before it is asked, so a resolver that cannot find one is resolving a ' +
        'question that was never asked rather than one that has gone.',
    );
    this.name = 'UnknownQuestion';
    this.questionId = questionId;
  }
}

const TEMP_SUFFIX = '.tmp';

let tempCounter = 0;

/**
 * Write a question state file atomically: temporary file in the same directory, fsync, rename.
 *
 * Atomic because a reader arrives unannounced — two other resolvers are looking at this directory — and
 * because the matrix requires a torn file to be *refused*: a writer that could leave one would make that
 * refusal a permanent state rather than a transient one.
 */
export const writeQuestionState = (paths: QuestionPaths, state: QuestionState): QuestionState => {
  const validated = QuestionStateSchema.parse(state);
  mkdirSync(paths.dir, { recursive: true });
  tempCounter += 1;
  const temp = join(
    paths.dir,
    `${paths.questionId}.${String(process.pid)}.${String(tempCounter)}${TEMP_SUFFIX}`,
  );
  writeFileSync(temp, `${JSON.stringify(validated, null, 2)}\n`, 'utf8');
  const fd = openSync(temp, 'r');
  try {
    fsyncSync(fd);
  } catch {
    // Unsynced contents are a durability weakness, not a torn file: the rename is still atomic.
  }
  closeSync(fd);
  renameSync(temp, paths.state);
  return validated;
};

const questionArtifact = (paths: QuestionPaths): string =>
  `runs/${paths.runId}/questions/${paths.questionId}/state.json`;

/** Read a question's state, refusing a file that is not whole rather than reading part of it. */
export const readQuestionState = (paths: QuestionPaths): QuestionState => {
  let raw: string;
  try {
    raw = readFileSync(paths.state, 'utf8');
  } catch {
    throw new UnknownQuestion(paths.runId, paths.questionId);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new TornQuestionState(paths.questionId, 'is not whole JSON');
  }
  try {
    return parseVersionedArtifact(QuestionStateSchema, parsed, questionArtifact(paths));
  } catch (thrown: unknown) {
    if (thrown instanceof TornQuestionState) throw thrown;
    throw new TornQuestionState(
      paths.questionId,
      `does not carry the declared question.state shape: ${
        thrown instanceof Error ? thrown.message : String(thrown)
      }`,
    );
  }
};

/** The outcome that stands, or `null` when no resolver has claimed this question yet. */
export const readQuestionOutcome = (paths: QuestionPaths): QuestionOutcome | null => {
  let raw: string;
  try {
    raw = readFileSync(paths.outcome, 'utf8');
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new TornQuestionState(paths.questionId, 'has an outcome file that is not whole JSON');
  }
  return parseVersionedArtifact(
    QuestionOutcomeSchema,
    parsed,
    `runs/${paths.runId}/questions/${paths.questionId}/outcome.json`,
  );
};

/** What asking a question produced. */
export interface AskedQuestion {
  readonly paths: QuestionPaths;
  readonly state: QuestionState;
  /**
   * False when a question with this id was already durable, so nothing was written.
   *
   * The idempotence the Always list asks for: asking the same question id twice — which is what a crash
   * between the durable write and the `question.asked` line leaves a later pass to finish — produces one
   * question rather than two.
   */
  readonly created: boolean;
}

export interface AskQuestionRequest {
  readonly paths: RunPaths;
  readonly questionId: string;
  readonly feature: string;
  /** The step that raised it, or `null` for a run-level question. */
  readonly step?: string | null;
  readonly draft: unknown;
  readonly askedAt?: Date;
}

/**
 * Make a question durable, refusing a draft the interface contract forbids asking.
 *
 * The file lands before the `question.asked` line does, and that order is not negotiable: the window
 * CAP-4 measures starts at `asked_at`, so a question whose event existed before its state file would
 * have a window nothing could evaluate and a default nothing could take.
 */
export const askQuestion = (request: AskQuestionRequest): AskedQuestion => {
  if (!isLoggableQuestionId(request.questionId)) throw new UnloggableQuestionId(request.questionId);
  const draft = assertAskableDraft(request.draft);
  const paths = questionPaths(request.paths, request.questionId);

  if (existsSync(paths.state)) {
    return { paths, state: readQuestionState(paths), created: false };
  }

  const question: Question = QuestionSchema.parse({
    ...draft,
    id: request.questionId,
    feature: request.feature,
    run: request.paths.runId,
    step: request.step ?? null,
    asked_at: formatTimestamp(request.askedAt ?? new Date()),
  });

  const state = writeQuestionState(paths, {
    schema_version: CURRENT_SCHEMA_VERSION,
    question,
    status: 'asked',
    resolution: null,
    deflection: null,
  });
  return { paths, state, created: true };
};

/** The outcome of one resolver's attempt at the compare-and-set. */
export interface QuestionClaim {
  readonly paths: QuestionPaths;
  /**
   * True only for the gesture that owns the outcome on disk.
   *
   * Which is not the same as "this call created the file": an intent AD-19 delivered twice is one
   * gesture, and the second delivery is told it won. {@link created} is the narrower fact.
   */
  readonly accepted: boolean;
  /** True only when this call's exclusive create is the one that landed. */
  readonly created: boolean;
  /**
   * True when this call reached the exclusive create at all — that is, when it either won it or lost it.
   *
   * False only for a resolution the state machine refused on its own terms: an option nobody offered, or a
   * question whose state file already records a transition. Both are honest answers that cost no contention.
   * Reported so a test can tell "lost the race" from "never entered it", which is the difference between
   * exercising the primitive and merely passing.
   */
  readonly contended: boolean;
  /** The state the question now has, derived from the outcome that stands. */
  readonly state: QuestionState;
  /**
   * The outcome that stands — this resolver's, or the one that beat it.
   *
   * `null` only when *no* outcome stands, which is the malformed-answer case: a resolution naming an option
   * nobody offered is refused before anything is contended for, so the question is still open for the
   * resolver that gets it right. A lost race always carries the outcome that won it.
   */
  readonly outcome: QuestionOutcome | null;
  /** Why this resolver lost, in the words story 1-1's state machine uses. `null` when it won. */
  readonly refusal: string | null;
}

/**
 * Create the outcome file, or fail because somebody else already did.
 *
 * **Written whole, then linked into place.** The obvious shape — `open(path, 'wx')` and then write into the
 * descriptor — is an atomic test-and-set on the *name* and nothing at all on the *contents*: the exclusive
 * create publishes a zero-length file, and a losing resolver reading it in the microseconds before the
 * winner's `write` lands sees an empty file and reports the question as torn. The cross-process race suite
 * caught exactly that, which an in-process test could not have: in one event loop the loser's read is
 * ordered after the winner's write by construction.
 *
 * So the content is written to a temporary file first, fsynced, and then `link(2)`ed to the real name.
 * `link` is the same atomic test-and-set — it fails with `EEXIST` for the second linker, on every
 * filesystem this runs on — but the inode it publishes already holds the whole record. A reader therefore
 * sees the outcome complete or sees no outcome, which is the same guarantee the checkpoint's temp-then-
 * rename gives, arrived at by the one primitive that also refuses to overwrite. `rename` would not do:
 * it replaces the target, so it decides nothing.
 *
 * `EEXIST` is the only failure that means "another resolver won". `EACCES`, `ENOSPC` and `EROFS` say
 * nothing about a winner, and reporting one of them as a lost race would tell the user a disk fault was
 * somebody else's answer.
 */
const createOutcomeExclusively = (paths: QuestionPaths, outcome: QuestionOutcome): boolean => {
  mkdirSync(paths.dir, { recursive: true });
  tempCounter += 1;
  const temp = join(
    paths.dir,
    `${QUESTION_OUTCOME_FILE_NAME}.${String(process.pid)}.${String(tempCounter)}${TEMP_SUFFIX}`,
  );
  writeFileSync(temp, `${JSON.stringify(outcome, null, 2)}\n`, 'utf8');
  const fd = openSync(temp, 'r');
  try {
    fsyncSync(fd);
  } catch {
    // Unsynced contents are a durability weakness, not a partial read: the link is still atomic.
  }
  closeSync(fd);

  try {
    linkSync(temp, paths.outcome);
  } catch (thrown: unknown) {
    const code = (thrown as { code?: string } | null)?.code;
    // The temporary is debris either way: unlinked here so a lost race leaves the directory as it found it.
    try {
      unlinkSync(temp);
    } catch {
      // A temporary that cannot be removed is inert — nothing reads it — and never a second outcome.
    }
    if (code === 'EEXIST') return false;
    throw thrown;
  }
  try {
    unlinkSync(temp);
  } catch {
    // The link is what decided the race; the temporary's removal is tidiness and never affects the result.
  }
  return true;
};

/** Derive the state file from the outcome that stands. Idempotent, and safe for a loser to do. */
const deriveState = (
  paths: QuestionPaths,
  asked: QuestionState,
  outcome: QuestionOutcome,
): QuestionState => {
  const transition =
    outcome.resolution !== null
      ? resolveQuestion({ ...asked, status: 'asked', resolution: null, deflection: null }, outcome.resolution)
      : deflectQuestion(
          { ...asked, status: 'asked', resolution: null, deflection: null },
          // The schema's refinement guarantees exactly one of the two is non-null.
          outcome.deflection ?? { source: 'repository', answer: '', anchor: '', deflected_at: outcome.claimed_at },
        );
  // The pure transition cannot refuse here: the state it is handed is `asked` by construction, and the
  // option was checked before the claim was created. Writing the unchanged state would be worse than
  // writing nothing, so a refusal leaves the file alone.
  if (!transition.accepted) return readQuestionState(paths);
  const current = existsSync(paths.state) ? readQuestionState(paths) : null;
  if (current !== null && current.status === transition.state.status) return current;
  return writeQuestionState(paths, transition.state);
};

/** The claim a resolver that lost is handed: the outcome that stands, and why it stands. */
const settledClaim = (
  paths: QuestionPaths,
  asked: QuestionState,
  outcome: QuestionOutcome,
  intentId: string | null,
  refusalFor: (state: QuestionState) => string | null,
  contended: boolean,
): QuestionClaim => {
  const state = deriveState(paths, asked, outcome);
  /**
   * The same gesture arriving twice is the winner, not a loser.
   *
   * AD-19 makes delivery at-least-once, so one keystroke can leave two intent files and a crash between the
   * claim and its `command.applied` line guarantees a redelivery. Without this, the second delivery of the
   * answer that *won* would be reported to the person as having lost the race to itself.
   */
  const sameGesture = intentId !== null && outcome.intent_id === intentId;
  return {
    paths,
    accepted: sameGesture,
    created: false,
    contended,
    state,
    outcome,
    refusal: sameGesture ? null : refusalFor(state),
  };
};

const outcomeRecord = (
  questionId: string,
  parts: {
    readonly resolution?: QuestionResolution | null;
    readonly deflection?: QuestionDeflection | null;
    readonly intentId?: string | null;
    readonly claimedAt: string;
  },
): QuestionOutcome =>
  QuestionOutcomeSchema.parse({
    schema_version: CURRENT_SCHEMA_VERSION,
    question_id: questionId,
    resolution: parts.resolution ?? null,
    deflection: parts.deflection ?? null,
    intent_id: parts.intentId ?? null,
    claimed_at: parts.claimedAt,
  });

export interface QuestionTransitionOptions {
  /** The steering intent this transition came from, so a redelivery is recognised as the same gesture. */
  readonly intentId?: string | null;
}

/**
 * Attempt the one accepted `asked` → `resolved` transition, as a real compare-and-set.
 *
 * The sequence, and every step of it is deliberate:
 *
 * 1. the question is read, which establishes what was offered — a resolver selecting an option nobody
 *    offered is refused here, before anything is contended for, because that is a malformed answer and
 *    not a lost race;
 * 2. an outcome already on disk short-circuits: this resolver lost, or is the winner arriving twice;
 * 3. story 1-1's pure transition validates the resolution against the `asked` state;
 * 4. the outcome file is created with `O_EXCL` — the compare-and-set, and the only thing that decides;
 * 5. the state file is derived from whichever outcome stands.
 *
 * Nothing between 3 and 4 can make two callers both win, because 4 does not consult 3.
 */
export const attemptQuestionResolution = (
  paths: RunPaths,
  questionId: string,
  resolution: QuestionResolution,
  options: QuestionTransitionOptions = {},
): QuestionClaim => {
  const validated = QuestionResolutionSchema.parse(resolution);
  const question = questionPaths(paths, questionId);
  const asked = readQuestionState(question);
  const intentId = options.intentId ?? null;
  const refusalFor = (state: QuestionState): string | null =>
    resolveQuestion(state, validated).refusal ??
    `Question ${questionId} is already resolved; this resolver wrote nothing.`;

  const proposed = resolveQuestion(asked, validated);
  if (!proposed.accepted) {
    /**
     * The state machine refused on its own terms, so nothing is contended for.
     *
     * Two ways that happens, and they are told apart by whether an outcome exists: the answer selected an
     * option nobody offered, which leaves the question open for the resolver that gets it right; or the state
     * file already records a transition, which means an outcome stands and this resolver is simply late.
     */
    const standing = readQuestionOutcome(question);
    if (standing === null) {
      return {
        paths: question,
        accepted: false,
        created: false,
        contended: false,
        state: asked,
        outcome: null,
        refusal: proposed.refusal,
      };
    }
    return settledClaim(question, asked, standing, intentId, refusalFor, false);
  }

  const claim = outcomeRecord(questionId, {
    resolution: validated,
    intentId,
    claimedAt: validated.resolved_at,
  });
  /**
   * The compare-and-set, and the only thing that decides.
   *
   * Deliberately *not* preceded by a read of the outcome file. A read-then-create would be a check before a
   * write — the very shape AD-25 exists to rule out — and although the create would still be the arbiter, the
   * short-circuit would mean a losing resolver sometimes never reached the primitive at all. Every loss
   * arriving through one branch is what makes the cross-process suite able to prove the branch works.
   */
  if (!createOutcomeExclusively(question, claim)) {
    // Somebody else's link landed first. The loser reads what stands and writes nothing of its own.
    const won = readQuestionOutcome(question);
    if (won === null) {
      throw new TornQuestionState(
        questionId,
        'has an outcome file that exists but could not be read back, so no winner can be named',
      );
    }
    return settledClaim(question, asked, won, intentId, refusalFor, true);
  }

  return {
    paths: question,
    accepted: true,
    created: true,
    contended: true,
    state: deriveState(question, asked, claim),
    outcome: claim,
    refusal: null,
  };
};

/**
 * Attempt the `asked` → `deflected` transition (Q4): answered without reaching the user.
 *
 * The same compare-and-set, because a deflection races the same three resolvers: a question the
 * Interviewer deflects from the ledger while the user is typing an answer must produce one outcome, and
 * whichever landed first is the one that stands.
 */
export const attemptQuestionDeflection = (
  paths: RunPaths,
  questionId: string,
  deflection: QuestionDeflection,
  options: QuestionTransitionOptions = {},
): QuestionClaim => {
  const validated = QuestionDeflectionSchema.parse(deflection);
  const question = questionPaths(paths, questionId);
  const asked = readQuestionState(question);
  const intentId = options.intentId ?? null;
  const refusalFor = (state: QuestionState): string | null =>
    deflectQuestion(state, validated).refusal ??
    `Question ${questionId} is already ${state.status}; this deflection wrote nothing.`;

  const proposed = deflectQuestion(asked, validated);
  if (!proposed.accepted) {
    const standing = readQuestionOutcome(question);
    if (standing === null) {
      return {
        paths: question,
        accepted: false,
        created: false,
        contended: false,
        state: asked,
        outcome: null,
        refusal: proposed.refusal,
      };
    }
    return settledClaim(question, asked, standing, intentId, refusalFor, false);
  }

  const claim = outcomeRecord(questionId, {
    deflection: validated,
    intentId,
    claimedAt: validated.deflected_at,
  });
  if (!createOutcomeExclusively(question, claim)) {
    const won = readQuestionOutcome(question);
    if (won === null) {
      throw new TornQuestionState(
        questionId,
        'has an outcome file that exists but could not be read back, so no winner can be named',
      );
    }
    return settledClaim(question, asked, won, intentId, refusalFor, true);
  }

  return {
    paths: question,
    accepted: true,
    created: true,
    contended: true,
    state: deriveState(question, asked, claim),
    outcome: claim,
    refusal: null,
  };
};

/**
 * Bring a question's state file into line with the outcome that stands, and say what is owed.
 *
 * This is the crash-recovery half. The outcome file is created before any event is appended and before
 * the state file is rewritten, so a process killed in between leaves a decision that is made but not yet
 * visible. A later pass calls this, finds the outcome, derives the state, and is told which event has
 * still to be emitted — so the crash produces exactly one outcome rather than none.
 */
export interface SettledQuestion {
  readonly paths: QuestionPaths;
  readonly state: QuestionState;
  /** The outcome that stands, or `null` for a question still genuinely `asked`. */
  readonly outcome: QuestionOutcome | null;
  /** The event this question's current state calls for, or `null` when it is still `asked`. */
  readonly eventType: string | null;
}

export const settleQuestion = (paths: RunPaths, questionId: string): SettledQuestion => {
  const question = questionPaths(paths, questionId);
  const asked = readQuestionState(question);
  const standing = readQuestionOutcome(question);
  if (standing === null) {
    return { paths: question, state: asked, outcome: null, eventType: null };
  }
  const state = deriveState(question, asked, standing);
  return {
    paths: question,
    state,
    outcome: standing,
    eventType:
      standing.resolution !== null
        ? eventTypeForResolution(standing.resolution)
        : QUESTION_EVENT_TYPES.Deflected,
  };
};

/**
 * Every question id with a directory under `runs/<run-id>/questions/`, in minted order.
 *
 * Minted order because a question id carries a ULID, so sorting the directory names sorts the questions
 * chronologically — which is what makes "the active question" a deterministic choice rather than
 * whatever `readdir` happened to return first.
 */
export const listQuestionIds = (paths: RunPaths): readonly string[] => {
  let entries: string[];
  try {
    entries = readdirSync(paths.questionsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    // No questions directory is the ordinary case: a run nothing has asked about.
    return [];
  }
  return entries.filter(isLoggableQuestionId).sort();
};

/** One question a pass looked at, and what it found. */
export interface QuestionOnDisk {
  readonly questionId: string;
  readonly settled: SettledQuestion;
}

/** Every question of one run, each already reconciled against the outcome that stands. */
export const readQuestions = (paths: RunPaths): readonly QuestionOnDisk[] =>
  listQuestionIds(paths).map((questionId) => ({
    questionId,
    settled: settleQuestion(paths, questionId),
  }));

/**
 * The question a run-level answer applies to: the earliest one still `asked`.
 *
 * Earliest rather than latest, and deterministic rather than "whichever the renderer had on screen",
 * because the answer arrives as a durable file that may be consumed a pass or a restart later. Story
 * 1-10's one-question card shows one question at a time (R14), so in practice there is one; when there is
 * not, the oldest is the one that has been waiting and the one whose window expires first.
 */
export const activeQuestion = (paths: RunPaths): QuestionOnDisk | null =>
  readQuestions(paths).find((entry) => entry.settled.state.status === 'asked') ?? null;

/** The most recently settled question, so an answer arriving too late is told *which* question stood. */
export const lastSettledQuestion = (paths: RunPaths): QuestionOnDisk | null =>
  [...readQuestions(paths)].reverse().find((entry) => entry.settled.outcome !== null) ?? null;

/**
 * The question ids the log already carries an `question.asked` line for.
 *
 * Read back out of the payload, which is what forces the id to be punctuated: the alternative is
 * emitting the same line on every pass for ever, because nothing else on disk records that it was
 * emitted.
 */
export const askedQuestionIds = (events: readonly EventEnvelope[]): ReadonlySet<string> =>
  questionIdsOfTypes(events, [QUESTION_EVENT_TYPES.Asked]);

/** The question ids the log already reports an outcome for: resolved, defaulted or deflected. */
export const settledQuestionIds = (events: readonly EventEnvelope[]): ReadonlySet<string> =>
  questionIdsOfTypes(events, QUESTION_OUTCOME_EVENT_TYPES);

const questionIdsOfTypes = (
  events: readonly EventEnvelope[],
  types: readonly string[],
): ReadonlySet<string> => {
  const ids = new Set<string>();
  for (const event of events) {
    if (!types.includes(event.type)) continue;
    const id = event.payload[QUESTION_ID_PAYLOAD_KEY];
    if (typeof id === 'string' && id !== '') ids.add(id);
  }
  return ids;
};

/** The payload key the enriched option list is carried under (story 1-11). */
export const OFFERED_OPTIONS_PAYLOAD_KEY = 'offered_options';

/**
 * The payload of a `question.asked` line.
 *
 * Every value is short, punctuated prose or an enum member, because the AD-21 pass rewrites an unbroken
 * high-entropy run wherever it appears in a payload — and `question_id` is the field the idempotence of
 * every later transition depends on. Labels, consequences and the brief are prose, so the sweep leaves
 * them: a run of words is broken by its spaces long before the 24-character threshold, measured.
 *
 * **What story 1-11 added, and what it deliberately did not touch.** Q1 requires a person to be shown the
 * *consequence* of each option and Q2 the window before the default is taken, and with only this line in
 * reach the one-question card could show neither: the payload carried option *ids* and the declared window
 * length, so a reconstructed card could not count down and could not say what any option would do. It now
 * also carries `offered_options` with each option's label and consequence, the Q3 brief, and `asked_at`,
 * which is the instant a countdown is measured from.
 *
 * `options` keeps its original meaning — the joined ids, in offer order — and that is not an oversight.
 * AD-5 makes adding a key non-breaking and changing one's meaning breaking, so a reader written against
 * this build goes on reading the same string it always did while a newer one reads the richer list.
 *
 * The brief was previously withheld on the grounds that the question state file already held it. The gate
 * overrules that: `questions/` is not the log, and a run is required to be reconstructable from the log
 * alone. It is one prose field duplicated into the durable truth, which is the cheaper of the two costs.
 */
export const questionAskedPayload = (state: QuestionState): Record<string, unknown> => ({
  [QUESTION_ID_PAYLOAD_KEY]: state.question.id,
  prompt: state.question.prompt,
  options: offeredOptionIds(state.question).join(', '),
  [OFFERED_OPTIONS_PAYLOAD_KEY]: offeredOptionsPayload(state.question),
  brief: state.question.brief,
  recommended_option_id: state.question.recommended_option_id,
  default_action: state.question.default_action,
  default_window_ms: state.question.default_window_ms,
  asked_at: state.question.asked_at,
});

/**
 * Every offered option as a person is shown it: its id, its label, its consequence, and whether it is the
 * escape.
 *
 * The escape is in the same list rather than beside it, and flagged, so `offered_options` and the older
 * `options` string describe exactly the same set in the same order — two lists that could disagree about
 * what was offered is the drift AD-25's attribution rule cannot afford. The flag is what lets the card
 * honour Q1's "at most three concrete options plus an escape" without the escape being one of the three it
 * drops.
 */
const offeredOptionsPayload = (question: {
  readonly options: readonly QuestionOption[];
  readonly escape: QuestionOption;
}): readonly Record<string, unknown>[] => [
  ...question.options.map((option) => ({
    id: option.id,
    label: option.label,
    consequence: option.consequence,
    escape: false,
  })),
  {
    id: question.escape.id,
    label: question.escape.label,
    consequence: question.escape.consequence,
    escape: true,
  },
];

/**
 * The payload of a `question.resolved` or `question.default_taken` line.
 *
 * It names the resolver and the principal because AD-25 requires the winning transition to record both:
 * a decision nobody is attributable for is the one thing a durable decision must not be (AD-19).
 */
export const questionResolvedPayload = (state: QuestionState): Record<string, unknown> => {
  const resolution = state.resolution;
  if (resolution === null) {
    throw new Error(
      `Question ${state.question.id} is ${state.status}, so it has no resolution to report. Only a ` +
        'resolved question emits question.resolved or question.default_taken (AD-25).',
    );
  }
  return {
    [QUESTION_ID_PAYLOAD_KEY]: state.question.id,
    resolver: resolution.resolver,
    principal_kind: resolution.principal.kind,
    principal_id: resolution.principal.id,
    option_id: resolution.option_id,
    answer: resolution.answer,
    resolved_at: resolution.resolved_at,
  };
};

/** The payload of a `question.deflected` line: where the answer came from, and never a resolver. */
export const questionDeflectedPayload = (state: QuestionState): Record<string, unknown> => {
  const deflection = state.deflection;
  if (deflection === null) {
    throw new Error(
      `Question ${state.question.id} is ${state.status}, so it has no deflection to report.`,
    );
  }
  return {
    [QUESTION_ID_PAYLOAD_KEY]: state.question.id,
    source: deflection.source,
    anchor: deflection.anchor,
    answer: deflection.answer,
    deflected_at: deflection.deflected_at,
  };
};

/** The payload the event type calls for, so no caller pairs a type with the wrong payload. */
export const questionEventPayload = (state: QuestionState): Record<string, unknown> =>
  state.status === 'deflected' ? questionDeflectedPayload(state) : questionResolvedPayload(state);

/** Build a resolution, filling in the fields every resolver supplies the same way. */
export const questionResolution = (declared: {
  readonly resolver: QuestionResolver;
  readonly principal: Principal;
  readonly answer: string;
  readonly optionId?: string | null;
  readonly resolvedAt?: Date;
}): QuestionResolution =>
  QuestionResolutionSchema.parse({
    resolver: declared.resolver,
    principal: declared.principal,
    answer: declared.answer,
    option_id: declared.optionId ?? null,
    resolved_at: formatTimestamp(declared.resolvedAt ?? new Date()),
  });

/** Every resolver AD-25 declares, re-exported so a caller does not reach past this module for it. */
export const QUESTION_RESOLVER_NAMES: readonly QuestionResolver[] = QUESTION_RESOLVERS;

/**
 * Which offered option, if any, a free-text answer selected.
 *
 * Q6 is explicit: "answers are free text; the system parses. Never impose a format on the human." So this
 * is the parsing, and it is deliberately generous in one direction and strict in the other — an answer
 * that plainly names an option by its id or its label selects it, and anything else selects nothing and is
 * recorded as the prose it is. Guessing at a partial match would be worse than recording no option: the
 * decision is durable, and a wrong option silently attributed to a person is the one outcome AD-25's
 * attribution rule exists to prevent.
 */
export const parseOptionSelection = (question: Question, answer: string): string | null => {
  const spoken = answer.trim().toLowerCase();
  if (spoken === '') return null;
  const candidates = [...question.options, question.escape];
  const byId = candidates.find((option) => option.id.toLowerCase() === spoken);
  if (byId !== undefined) return byId.id;
  const byLabel = candidates.find((option) => option.label.trim().toLowerCase() === spoken);
  return byLabel?.id ?? null;
};
