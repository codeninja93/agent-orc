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
 * - **No losing resolver's *decision* is ever accepted.** Its `link` fails, it reads the outcome that
 *   stands, and it is handed story 1-1's already-resolved refusal to render. Refusing *after* writing a
 *   decision would not be a compare-and-set, however carefully the write were ordered. Stated at the
 *   decision level because that is what is true and what the invariant is for (AD-25 as amended by
 *   ADR-002): a loser may still write the *derived* `state.json`, but only by converging it to the
 *   winner's content, and it skips even that when the winner got there first.
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
 *
 * **What the outcome file *is* now lives in `src/contracts/question.ts`** (ADR-002 decision 3): the
 * contended artifact is the load-bearing half of the question type, and story 3-1 is a second process
 * that has to read its shape without reading this module. The names are re-exported below, so no caller
 * of this module changed.
 */
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

import {
  CURRENT_SCHEMA_VERSION,
  QUESTION_RESOLVERS,
  QuestionDeflectionSchema,
  QuestionDraftSchema,
  QuestionOutcomeSchema,
  QuestionResolutionSchema,
  QuestionSchema,
  QuestionStateSchema,
  deflectQuestion,
  eventTypeForResolution,
  formatTimestamp,
  offeredOptionIds,
  parseVersionedArtifact,
  resolveQuestion,
} from '../contracts/index.js';
import type {
  CommandSource,
  EventEnvelope,
  Principal,
  Question,
  QuestionDeflection,
  QuestionDraft,
  QuestionOption,
  QuestionOutcome,
  QuestionResolution,
  QuestionResolver,
  QuestionState,
} from '../contracts/index.js';
import {
  ABANDONED_TEMPORARY_GRACE_MS,
  CLOCK_SKEW_TOLERANCE_MS,
  DEFAULT_HIGH_ENTROPY_MIN_LENGTH,
  QUESTION_OUTCOME_FILE_NAME,
  QUESTION_STATE_FILE_NAME,
  createFileExclusively,
  fsyncDirectory,
  questionPaths,
  redactValue,
} from '../runtime/index.js';
import type { QuestionPaths, RedactionPolicy, RunPaths } from '../runtime/index.js';

/**
 * The contended artifact's schema, re-exported from `contracts/` where ADR-002 put it.
 *
 * Re-exported rather than moved out of reach: every existing caller — the reconciler, the race helper,
 * the suites — asks this module for it, and ADR-002's decision was about where the shape is *declared*,
 * not about who may ask for it.
 */
export { QuestionOutcomeSchema };
export type { QuestionOutcome };

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
 * The longest unbroken alphanumeric run a question id may contain under the default policy.
 *
 * The same bound, for the same reason, as story 1-7's intent id: AD-21's high-entropy rule considers
 * runs of `[A-Za-z0-9+/=]` at least {@link DEFAULT_HIGH_ENTROPY_MIN_LENGTH} characters long, so an id
 * whose runs all stay under that cannot be reached by the rule whatever its entropy. The guard is on
 * *shape*, which is checkable here, rather than on entropy, which depends on a policy this module does
 * not own.
 *
 * Derived from the redaction module's own threshold rather than written out as `23` — the parity story
 * 1-7 made real after the same claim was made here in prose. The two numbers have to move together: an id
 * declared loggable against a stale threshold is an id whose idempotence key is silently replaced by the
 * marker in the only payloads that carry it.
 */
export const MAX_QUESTION_ID_TOKEN_RUN = DEFAULT_HIGH_ENTROPY_MIN_LENGTH - 1;

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
export const isLoggableQuestionId = (id: string, policy: RedactionPolicy = {}): boolean => {
  if (!QUESTION_ID_PATTERN.test(id)) return false;
  /**
   * The threshold is read from the *active* policy when one is given, exactly as `isLoggableIntentId`
   * does. A build that lowered `highEntropyMinLength` would otherwise keep calling ids loggable here
   * while the recorder replaced them, and the ledger every question append is keyed on would quietly
   * hold the redaction marker instead of a key.
   */
  const longestAllowed = (policy.highEntropyMinLength ?? DEFAULT_HIGH_ENTROPY_MIN_LENGTH) - 1;
  for (const run of id.match(LONGEST_TOKEN_RUN) ?? []) {
    if (run.length > longestAllowed) return false;
  }
  return true;
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

/** The prefix every minted question id carries, so a directory under `questions/` reads at a glance. */
export const QUESTION_ID_PREFIX = 'q';

/**
 * The shape a seed must have before a question id is built from it.
 *
 * The same rule as story 1-7's `INTENT_SEED_PATTERN`, and the parity is the point: this module claimed
 * "the same bound, for the same reason, as story 1-7's intent id" while `mintQuestionId('')` still
 * returned the literal `"q-"`, which passes {@link isLoggableQuestionId}. Two questions minted from a
 * degenerate seed would then share one directory and one idempotence key, so the second would be read as
 * the first: its window never taken, its `question.asked` line never appended, and an answer attributed to
 * a question nobody was shown. A caller's degenerate seed is refused at the mint, where the cause is
 * visible, rather than at the ledger, where the symptom is a question that vanished.
 *
 * Upper-case alphanumerics of at least 26 characters: the 26 Crockford base32 characters of an AD-29 ULID,
 * or the 32 hex characters a renderer's `randomUUID` yields. The length floor is the *uniqueness* floor.
 */
export const QUESTION_SEED_PATTERN = /^[0-9A-Z]{26,64}$/;

/** A seed with too little in it to key a question. Refused rather than punctuated. */
export class UnusableQuestionSeed extends Error {
  readonly code = 'internal.invariant_violated';
  readonly seed: string;

  constructor(seed: string) {
    super(
      `Refusing to mint a question id from "${seed}": a seed must match ` +
        `${String(QUESTION_SEED_PATTERN)} — the 26 Crockford base32 characters of a ULID, or the 32 hex ` +
        'characters of a UUID. The minted id names the question directory and keys every append the ' +
        'transition makes, so a seed carrying no uniqueness produces two questions that share one key ' +
        'and the second is read as the first (AD-25).',
    );
    this.name = 'UnusableQuestionSeed';
    this.seed = seed;
  }
}

/**
 * Mint a question id from a ULID, punctuated into groups.
 *
 * Story 1-7's `mintIntentId` in one sentence: the same 26 characters unbroken carry 4.1 bits each and are
 * exactly what AD-21's sweep exists to catch, so the id that keys the idempotence would be redacted out
 * of the payload that carries it. Uniqueness and ordering come from the ULID underneath; the hyphens are
 * the only thing this adds, and they are what makes the id readable back.
 *
 * Both ends are checked, which is what makes the claimed parity with story 1-7 real. The seed has to be
 * able to carry uniqueness ({@link QUESTION_SEED_PATTERN}), and the id this produces has to survive the
 * log ({@link isLoggableQuestionId}) — asserted rather than assumed, because the punctuation that makes it
 * survive is computed right here, and a change to the grouping would otherwise fail silently in the one
 * payload nothing else can reconstruct.
 */
export const mintQuestionId = (ulid: string, policy: RedactionPolicy = {}): string => {
  if (!QUESTION_SEED_PATTERN.test(ulid)) throw new UnusableQuestionSeed(ulid);
  const groups = (ulid.match(/.{1,8}/g) ?? [ulid]).join('-');
  const id = `${QUESTION_ID_PREFIX}-${groups}`;
  if (!isLoggableQuestionId(id, policy)) throw new UnloggableQuestionId(id);
  return id;
};

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
 * The longest window a question may declare.
 *
 * A *representability* bound, not a product policy. `questionDefaultDueAt` formats `asked_at + window`,
 * and `Date` refuses an instant beyond ±8.64e15 ms — so a window large enough turned CAP-4's "when does
 * this default" into a `RangeError` thrown out of a renderer's countdown. The bound is the whole span the
 * RFC3339 timestamp contract can express, which leaves the due instant of *any* askable question
 * formattable whatever `asked_at` is, and is still orders of magnitude above any window a person waits
 * out.
 */
export const MAX_QUESTION_WINDOW_MS = 253_402_300_799_999;

/** One field's rule: whether a parsed draft satisfies it, and the sentence a refusal carries. */
interface QuestionDraftRule {
  readonly satisfied: (draft: QuestionDraft) => boolean;
  readonly detail: string;
}

/**
 * The checks {@link assertAskableDraft} applies, one per required field.
 *
 * A total record over {@link QUESTION_DRAFT_FIELDS} rather than a run of `if` statements, because that
 * list is the table this function should be driven from: a field added to it without a rule here is a
 * compile error, where before it was a field nothing checked. The order the fields are checked in is the
 * list's own order, so the field a refusal names is stable.
 */
const QUESTION_DRAFT_RULES: Readonly<Record<QuestionDraftField, QuestionDraftRule>> = {
  prompt: {
    satisfied: (draft) => draft.prompt.trim() !== '',
    detail: 'a question with no prompt asks nothing',
  },
  brief: {
    satisfied: (draft) => draft.brief.trim() !== '',
    detail:
      'Q3 requires a self-contained mini-brief, so the question is answerable without reloading the ' +
      'feature into the user’s head',
  },
  options: {
    satisfied: (draft) => draft.options.length > 0,
    detail: 'Q1 requires at least one concrete option, because an open-ended question is not a card',
  },
  escape: {
    satisfied: (draft) => draft.escape.label.trim() !== '',
    detail: 'Q1 requires an escape alongside the concrete options',
  },
  recommended_option_id: {
    satisfied: (draft) => draft.recommended_option_id.trim() !== '',
    detail:
      'Q1 requires a recommended default, and CAP-4 has nothing to take when the window expires without one',
  },
  default_action: {
    satisfied: (draft) => draft.default_action.trim() !== '',
    detail: 'Q2 requires the question to state what happens if it is ignored',
  },
  default_window_ms: {
    /**
     * A positive, whole count of milliseconds, no longer than the timestamp contract can express.
     *
     * Three failures rather than one, and each was reachable: zero or less takes the default in the same
     * instant the question is asked; a fraction such as `0.5` is not a count of milliseconds at all and
     * makes the due instant depend on floating-point rounding; and a window past
     * {@link MAX_QUESTION_WINDOW_MS} makes the due instant unformattable, so CAP-4's own "when" throws.
     */
    satisfied: (draft) =>
      Number.isSafeInteger(draft.default_window_ms) &&
      draft.default_window_ms > 0 &&
      draft.default_window_ms <= MAX_QUESTION_WINDOW_MS,
    detail:
      'Q2 requires the window before the default is taken, as a whole number of milliseconds greater ' +
      `than zero and no greater than ${String(MAX_QUESTION_WINDOW_MS)} — a window of zero or less takes ` +
      'the default in the same instant the question is asked, a fractional one is not a count of ' +
      'milliseconds, and a larger one has a due instant no timestamp can express',
  },
};

/**
 * Check a draft against Q1, Q2 and Q3, naming the first field at fault.
 *
 * The declared schema covers the structural half — at most three options, a recommended id that names
 * one of them — and the rules above cover the half a schema cannot express without forbidding a
 * legitimate value elsewhere: a blank brief is a valid string, and a zero window is a valid number, but
 * neither is a question anybody can answer.
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
  for (const field of QUESTION_DRAFT_FIELDS) {
    const rule = QUESTION_DRAFT_RULES[field];
    if (!rule.satisfied(question)) throw new QuestionDraftRefused(field, rule.detail);
  }
  return question;
};

/**
 * Which of the three AD-25 resolvers a command source counts as.
 *
 * Exhaustive over `COMMAND_SOURCES` rather than defaulting, which is the rule `steering.ts` states for
 * itself two functions away: "enumerated rather than defaulted so adding a command with an effect is a
 * compile error here". The ternary chain this replaces sent `cli` — a declared source — into the `tui`
 * bucket, so a CLI-issued answer recorded a durable decision naming a resolver that did not make it, and
 * a fifth source would have joined the same bucket in silence. A `cli` answer is a person at a terminal,
 * so it is the `tui` resolver *by decision* rather than by falling through.
 */
const RESOLVER_BY_COMMAND_SOURCE: Readonly<Record<CommandSource, QuestionResolver>> = {
  tui: 'tui',
  cli: 'tui',
  web: 'web',
  timeout: 'timeout_default',
};

export const resolverForSource = (source: CommandSource): QuestionResolver =>
  RESOLVER_BY_COMMAND_SOURCE[source];

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

/**
 * A question file that exists but could not be read. Never reported as absence.
 *
 * `EACCES`, `EIO` and `EISDIR` say nothing about whether a question was asked or claimed, and the old
 * `catch`-everything read said the opposite of what it knew: a claimed question read as *unclaimed*, so a
 * pass could take a second default over a decision a person had already made, and an asked question read
 * as never asked. Only `ENOENT` means absence. Everything else is refused, which carries the
 * `abandon-and-hand-off` disposition of `internal.invariant_violated` — the fail-safe direction, and the
 * same one a torn file takes.
 */
export class QuestionFileUnreadable extends Error {
  readonly code = 'internal.invariant_violated';
  readonly questionId: string;
  readonly file: string;

  constructor(questionId: string, file: string, cause: string) {
    super(
      `Refusing question ${questionId}: its ${file} exists but could not be read (${cause}). A read ` +
        'fault is not absence — reporting it as one would let a pass take a second default over a ' +
        'decision that is already durable, so the question is refused instead (AD-25).',
    );
    this.name = 'QuestionFileUnreadable';
    this.questionId = questionId;
    this.file = file;
  }
}

/** The errno a failed `fs` call reports, or `null` when it reported none. */
const errnoOf = (thrown: unknown): string | null => {
  const code = (thrown as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : null;
};

/** True only for "there is no such file", which is the one failure that means absence. */
const isAbsence = (thrown: unknown): boolean => {
  const code = errnoOf(thrown);
  return code === 'ENOENT' || code === 'ENOTDIR';
};

const TEMP_SUFFIX = '.tmp';

let tempCounter = 0;

/**
 * Write a question state file atomically: temporary file in the same directory, fsync, rename, then
 * fsync the directory.
 *
 * Atomic because a reader arrives unannounced — two other resolvers are looking at this directory — and
 * because the matrix requires a torn file to be *refused*: a writer that could leave one would make that
 * refusal a permanent state rather than a transient one.
 *
 * The file's own `fsync` makes its contents survive a crash; only the *directory's* makes the new name
 * survive one, which is why `fsyncDirectory` is called here as well and is the same call story 1-9 made
 * for the intent file. Without it a power loss after the rename can leave the question with the state it
 * had before, while the outcome file that decided the transition is already on disk.
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
  fsyncDirectory(paths.dir);
  return validated;
};

const questionArtifact = (paths: QuestionPaths): string =>
  `runs/${paths.runId}/questions/${paths.questionId}/${QUESTION_STATE_FILE_NAME}`;

/** Read a question's state, refusing a file that is not whole rather than reading part of it. */
export const readQuestionState = (paths: QuestionPaths): QuestionState => {
  let raw: string;
  try {
    raw = readFileSync(paths.state, 'utf8');
  } catch (thrown: unknown) {
    if (!isAbsence(thrown)) {
      throw new QuestionFileUnreadable(
        paths.questionId,
        QUESTION_STATE_FILE_NAME,
        errnoOf(thrown) ?? 'the read failed and said nothing about why',
      );
    }
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

/**
 * The outcome that stands, or `null` when no resolver has claimed this question yet.
 *
 * `null` means *there is no outcome file*, and nothing else. A read that failed for any other reason is
 * refused: reporting `EACCES` as "unclaimed" is what would let a pass take a second default over a
 * decision already on disk, which is the one thing this compare-and-set exists to make impossible.
 */
export const readQuestionOutcome = (paths: QuestionPaths): QuestionOutcome | null => {
  let raw: string;
  try {
    raw = readFileSync(paths.outcome, 'utf8');
  } catch (thrown: unknown) {
    if (!isAbsence(thrown)) {
      throw new QuestionFileUnreadable(
        paths.questionId,
        QUESTION_OUTCOME_FILE_NAME,
        errnoOf(thrown) ?? 'the read failed and said nothing about why',
      );
    }
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
    `runs/${paths.runId}/questions/${paths.questionId}/${QUESTION_OUTCOME_FILE_NAME}`,
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
 *
 * **The idiom itself is `src/runtime/exclusive-create.ts`'s**, and this no longer keeps its own copy of
 * it. Story 1-12 extracted it from here after three other stories recorded the same `'wx'` trap, and the
 * extracted version is identical in shape down to the errno handling — so two copies were two places a
 * fix would have to land, in the one primitive AD-25 rests on. What stays here is the record's
 * serialisation and the directory `fsync`, which the outcome needs and the shared helper leaves to the
 * caller only because the recorder's claim and the engine lock reach it by other paths.
 */
const createOutcomeExclusively = (paths: QuestionPaths, outcome: QuestionOutcome): boolean => {
  const created = createFileExclusively(paths.outcome, `${JSON.stringify(outcome, null, 2)}\n`);
  // Only the winner's name is new, so only the winner has a directory entry to make durable. The loser's
  // `link` published nothing.
  if (created) fsyncDirectory(paths.dir);
  return created;
};

/**
 * Derive the state file from the outcome that stands (ADR-002 decision 2).
 *
 * Idempotent, and safe for a *loser* to do: converging `state.json` to the winner's content is the one
 * write a losing resolver may make, and it skips even that when the winner got there first. What it never
 * does is write a decision — that is the invariant, and it belongs to the `link` above.
 */
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
  /**
   * The pure transition cannot refuse here — and if it ever does, that is refused rather than papered over.
   *
   * The state it is handed is `asked` by construction and the option was checked before the claim was
   * created, so a refusal means the outcome on disk disagrees with the question on disk: an option the
   * question does not offer, most plausibly from a build whose options changed. Returning the *unchanged*
   * state, which is what stood here, handed the caller an `asked` state while `settleQuestion` went on
   * reporting the event type the outcome called for — so a pass would try to emit `question.resolved` for a
   * question carrying no resolution, and the payload builder would throw from deep inside the append.
   * Refusing names the disagreement at the one place that can see both halves of it.
   */
  if (!transition.accepted) {
    throw new TornQuestionState(
      paths.questionId,
      'disagrees with the outcome that claimed it, so no state can be derived from it: ' +
        (transition.refusal ?? 'the transition was refused and said nothing about why'),
    );
  }
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
   * short-circuit would mean a losing resolver *never* reached the primitive.
   *
   * A loss can still arrive by two paths, and the cross-process suite has to tolerate both: through this
   * `link` failing, which is the interesting one and the reason `contended` is reported; or through step 3
   * above, when this resolver was descheduled long enough that the winner's derived `state.json` was already
   * on disk by the time it read the question. The second is not a weaker guarantee — the outcome file still
   * decided, and nothing was written — it is the same loss observed one step earlier.
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

/** What a run's `questions/` directory holds: the questions a pass can act on, and the names it cannot. */
export interface QuestionDirectoryListing {
  /** Every usable question id, in minted order. */
  readonly ids: readonly string[];
  /**
   * Directory names that are not loggable question ids, so no transition can be made against them.
   *
   * Reported rather than dropped. A name this build cannot carry into a payload — an id from an older
   * build, or one a story 3-1 web resolver minted differently — used to be filtered away by
   * {@link listQuestionIds}, which made the question invisible to every pass: no window taken, no event,
   * no refusal, and nobody told. A torn state file is reported; an unusable *name* is the same class of
   * fault and is now reported the same way.
   */
  readonly unloggable: readonly string[];
}

/**
 * Every question directory under `runs/<run-id>/questions/`, split into what can be acted on and what
 * cannot.
 *
 * Minted order because a question id carries a ULID, so sorting the directory names sorts the questions
 * chronologically — which is what makes "the active question" a deterministic choice rather than
 * whatever `readdir` happened to return first.
 */
export const readQuestionDirectory = (paths: RunPaths): QuestionDirectoryListing => {
  let entries: string[];
  try {
    entries = readdirSync(paths.questionsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    // No questions directory is the ordinary case: a run nothing has asked about.
    return { ids: [], unloggable: [] };
  }
  const ids: string[] = [];
  const unloggable: string[] = [];
  for (const name of entries) (isLoggableQuestionId(name) ? ids : unloggable).push(name);
  return { ids: ids.sort(), unloggable: unloggable.sort() };
};

/**
 * Every question id a transition can be made against, in minted order.
 *
 * The narrower half of {@link readQuestionDirectory}, kept because every resolver wants exactly this: a
 * name it cannot log is a name it cannot make idempotent, so there is nothing for a resolver to do with
 * one. The *pass* asks for the whole listing, so the name it skips is refused rather than hidden.
 */
export const listQuestionIds = (paths: RunPaths): readonly string[] =>
  readQuestionDirectory(paths).ids;

/**
 * Remove temporaries a writer died between writing and publishing.
 *
 * A `link` or a `rename` either happened or did not, so a surviving `<name>.<pid>.<n>.tmp` is always
 * debris: nothing reads a name that was never published, and the outcome that decided the race is the
 * published one. They are not poison files, they are an unbounded leak in a directory three resolvers
 * write to — and the race suite asserts the directory holds exactly `['outcome.json', 'state.json']`, so
 * any crash in there would have made an unrelated suite fail for a reason it has nothing to do with.
 *
 * Only a temporary older than {@link ABANDONED_TEMPORARY_GRACE_MS} is touched, for the reason story 1-9's
 * sweep gives: the engine is not the only writer here — AD-25's other two resolvers may be other
 * processes — so a sweep that deleted on sight would race a live writer between its `write` and its
 * `link` and destroy the very outcome it was publishing.
 */
export const sweepQuestionTemporaries = (
  paths: RunPaths,
  options: { readonly now?: () => Date; readonly graceMs?: number } = {},
): number => {
  const now = (options.now ?? ((): Date => new Date()))().getTime();
  const grace = options.graceMs ?? ABANDONED_TEMPORARY_GRACE_MS;
  const listing = readQuestionDirectory(paths);
  let removed = 0;
  for (const questionId of [...listing.ids, ...listing.unloggable]) {
    const dir = join(paths.questionsDir, questionId);
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.endsWith(TEMP_SUFFIX)) continue;
      const path = join(dir, name);
      let age: number;
      try {
        age = now - statSync(path).mtimeMs;
      } catch {
        continue;
      }
      // Sub-millisecond jitter is a brand-new file, not an old one: the filesystem records mtime below
      // the millisecond while `Date.now()` truncates. A mtime a second or more ahead is a clock that
      // disagrees, which no amount of waiting resolves, so it counts as age.
      const settled = age < 0 && age > -CLOCK_SKEW_TOLERANCE_MS ? 0 : age;
      if (settled >= 0 && settled < grace) continue;
      try {
        unlinkSync(path);
        removed += 1;
      } catch {
        // Another writer's live temporary, or a permission fault. Neither is this sweep's business.
      }
    }
  }
  return removed;
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
 * The payload key naming the free-text fields the AD-21 pass will rewrite in this very line.
 *
 * **Why a line has to say this about itself.** Q6 imposes no format on a human, so an answer may contain
 * any text at all — and an answer carrying a SHA, a token or a long path is an unbroken high-entropy run,
 * which AD-21 replaces with the marker on the way into the log. That is AD-21 working exactly as
 * specified, and there is no remedy for it that is not a wider allow-list, which AD-21 forbids: the pass
 * is a write-path invariant with no after-the-fact remedy. What there *was* no remedy for was the
 * silence: `questions/<id>/state.json` kept the answer verbatim while the log kept `[redacted]`, so the
 * two durable records disagreed with nothing saying so, and `decision.ts`'s claim that a rejection's
 * reason "is never discarded" quietly stopped being true of the ledger.
 *
 * So the emitter names the fields, using the same policy the recorder is about to apply. A reader of the
 * log then knows the marker is a rewritten value rather than what the person typed, and knows which
 * durable record still holds it. AD-5 makes adding a key non-breaking, and the key is present only when
 * something was in fact rewritten.
 */
export const REDACTED_FIELDS_PAYLOAD_KEY = 'redacted_fields';

/**
 * True when this value reaches the log unchanged under the given policy.
 *
 * Runs the *real* pass rather than a re-implementation of its heuristic: a second copy of "what counts as
 * high entropy" would drift from `redactValue`, and a flag that said a field survived when it did not
 * would be worse than no flag. A pass that *fails* — a value no JSON can carry — is reported as not
 * surviving, because the whole artifact is dropped in that case.
 */
export const survivesRedaction = (value: string, policy: RedactionPolicy = {}): boolean => {
  const pass = redactValue(value, policy);
  return pass.ok && pass.value === value;
};

/**
 * Add {@link REDACTED_FIELDS_PAYLOAD_KEY} when any of the named free-text fields will be rewritten.
 *
 * Exported because `decision.ts` builds the fourth payload of the same transition and must say the same
 * thing about it in the same words: the decision record carries the question *and* the answer, so it is the
 * line where a rewritten value is most consequential and the one place a second spelling would show up as
 * two records disagreeing about which fields are trustworthy.
 */
export const notingRedactedFields = (
  payload: Record<string, unknown>,
  freeText: readonly (readonly [string, string])[],
  policy: RedactionPolicy,
): Record<string, unknown> => {
  const rewritten = freeText
    .filter(([, value]) => !survivesRedaction(value, policy))
    .map(([field]) => field);
  return rewritten.length === 0
    ? payload
    : { ...payload, [REDACTED_FIELDS_PAYLOAD_KEY]: rewritten.join(', ') };
};

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
export const questionAskedPayload = (
  state: QuestionState,
  policy: RedactionPolicy = {},
): Record<string, unknown> =>
  notingRedactedFields(
    {
      [QUESTION_ID_PAYLOAD_KEY]: state.question.id,
      prompt: state.question.prompt,
      options: offeredOptionIds(state.question).join(', '),
      [OFFERED_OPTIONS_PAYLOAD_KEY]: offeredOptionsPayload(state.question),
      brief: state.question.brief,
      recommended_option_id: state.question.recommended_option_id,
      default_action: state.question.default_action,
      default_window_ms: state.question.default_window_ms,
      asked_at: state.question.asked_at,
    },
    [
      ['prompt', state.question.prompt],
      ['brief', state.question.brief],
    ],
    policy,
  );

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
export const questionResolvedPayload = (
  state: QuestionState,
  policy: RedactionPolicy = {},
): Record<string, unknown> => {
  const resolution = state.resolution;
  if (resolution === null) {
    throw new Error(
      `Question ${state.question.id} is ${state.status}, so it has no resolution to report. Only a ` +
        'resolved question emits question.resolved or question.default_taken (AD-25).',
    );
  }
  return notingRedactedFields(
    {
      [QUESTION_ID_PAYLOAD_KEY]: state.question.id,
      resolver: resolution.resolver,
      principal_kind: resolution.principal.kind,
      principal_id: resolution.principal.id,
      option_id: resolution.option_id,
      answer: resolution.answer,
      resolved_at: resolution.resolved_at,
    },
    [['answer', resolution.answer]],
    policy,
  );
};

/** The payload of a `question.deflected` line: where the answer came from, and never a resolver. */
export const questionDeflectedPayload = (
  state: QuestionState,
  policy: RedactionPolicy = {},
): Record<string, unknown> => {
  const deflection = state.deflection;
  if (deflection === null) {
    throw new Error(
      `Question ${state.question.id} is ${state.status}, so it has no deflection to report.`,
    );
  }
  return notingRedactedFields(
    {
      [QUESTION_ID_PAYLOAD_KEY]: state.question.id,
      source: deflection.source,
      anchor: deflection.anchor,
      answer: deflection.answer,
      deflected_at: deflection.deflected_at,
    },
    [
      ['answer', deflection.answer],
      // The anchor is a test name, an API symbol or a module name — prose-shaped, and the one field a
      // later reader follows back to the evidence. An anchor the pass rewrote is an anchor nobody can
      // follow, so it is named too rather than left to read as if it were the real one.
      ['anchor', deflection.anchor],
    ],
    policy,
  );
};

/** The payload the event type calls for, so no caller pairs a type with the wrong payload. */
export const questionEventPayload = (
  state: QuestionState,
  policy: RedactionPolicy = {},
): Record<string, unknown> =>
  state.status === 'deflected'
    ? questionDeflectedPayload(state, policy)
    : questionResolvedPayload(state, policy);

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
