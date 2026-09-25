/**
 * Q4 — a question is first attempted against the repository, git history and the decision ledger.
 *
 * The Interviewer's measured job is that at most one question reaches a person (CAP-3), and deflection
 * is most of how it gets there: a subagent asking "should `resolveProject` throw or return null?" in a
 * repository whose `CLAUDE.md` already says, or whose history already decided, has asked something
 * nobody needs to be interrupted for. This module decides whether that is so, and builds the
 * {@link QuestionDeflection} story 1-8's `attemptQuestionDeflection` already accepts. Nothing else.
 *
 * **Matching is occurrence of an anchor, never a judgement about meaning.** A question is matched by the
 * two-part anchor it declares — the symbol it is about (a test name, an API symbol, a module name) *and*
 * the aspect of that symbol it asks about — both appearing as whole tokens in one passage of the source.
 * That is `mentionsSymbol` from story 2-3, applied twice, on the same grounds that story gave: code cannot
 * decide that two sentences mean the same thing, and a classifier bolted on beside it would be a second
 * model family with its own credential and egress path, which AD-1's subscription-only boundary does
 * not admit (the TypeSafe decision closed with this story). So there is no similarity score, no
 * threshold and no override here. A question the anchors miss is not deflected; it goes on to be merged
 * and asked, which is the safe direction of this error — a person is asked once more than necessary,
 * rather than answered with a paragraph about a different symbol.
 *
 * **Why the aspect is required (the 2026-09-23 amendment, decided with the user).** A bare symbol could not
 * tell "should `resolveProject` throw?" from "should `resolveProject` cache?", and the two errors this
 * module can make are not symmetric the way story 2-3's are: a knowledge entry flagged stale in error is a
 * soft flag a person reviews, while a question deflected in error reaches nobody at all — there is no
 * correction point. The aspect is a second mechanical signal, not a step toward judging meaning: it is
 * compared by the same whole-token rule, and a passage must name both.
 *
 * **The decision ledger is the raw log (AD-25, AD-4).** `decision.ts` says it in so many words: no table,
 * no index, no retrieval — story 5-3 builds the queryable index *over* the `decision.recorded` lines.
 * The ledger match here is therefore a linear fold over those lines as they are on disk, read fresh on
 * every attempt and kept nowhere. A cache would be a derived projection AD-4 would have to be able to
 * rebuild, and an index is precisely what 5-3 is reserved to build.
 *
 * **An attempt never throws on a source it cannot read.** Deflection is an optimisation over asking: a
 * prior run whose log is corrupt, an instruction file whose permissions changed, a path that is not a
 * repository — each means "no match found there", recorded in the attempt so it is not silent, and the
 * question carries on to a person. A deflection attempt that escalated would turn a missing cache of
 * answers into a question nobody can ask.
 *
 * **There is one write path, and it is not in this module.** {@link applyDeflection} hands the
 * constructed deflection to `attemptQuestionDeflection`, which is AD-25's compare-and-set — a deflection
 * races the user's answer and the timeout default for the same outcome file (ADR-002), and a second path
 * to a question's state would be a resolver that never entered the race.
 */
import {
  DEFLECTION_SOURCES,
  NOTE_REF,
  QuestionDeflectionSchema,
  formatTimestamp,
  isLineNumberAnchor,
} from '../contracts/index.js';
import type { DeflectionSource, QuestionDeflection } from '../contracts/index.js';
import {
  DEFAULT_COMMIT_SEARCH_LIMIT,
  EventLogCorruptError,
  UnsafePathSegmentError,
  readEventLog,
  runPaths,
  searchCommitHistory,
} from '../runtime/index.js';
import type { RunPaths } from '../runtime/index.js';

import {
  ConventionsUnreadable,
  conventionsSpeakingTo,
  mentionsSymbol,
  readConventions,
} from './conventions.js';
import type { RepositoryConventions } from './conventions.js';
import { decisionsInLog } from './decision.js';
import {
  QUESTION_ID_PAYLOAD_KEY,
  REDACTED_FIELDS_PAYLOAD_KEY,
  attemptQuestionDeflection,
} from './questions.js';
import type { QuestionClaim } from './questions.js';

/**
 * What a question is about: a symbol, and the aspect of it being asked (matrix 17).
 *
 * Both parts are required, and neither is a fallback for the other. `symbol` is the durable name a
 * source must mention — `memory-design.md`'s test name, API symbol or module name; `aspect` is the term
 * naming what about it is undecided — `null-on-miss`, `caching`, `retry` — which the same passage must
 * also mention. Two questions about one symbol and two aspects are two questions (matrix 18).
 */
export interface QuestionAnchor {
  readonly symbol: string;
  readonly aspect: string;
}

/** A part that can be compared verbatim: not blank, not padded, and on one line. */
const isComparablePart = (part: string): boolean =>
  part.trim() !== '' && part === part.trim() && !/[\r\n]/.test(part);

/**
 * True when an anchor can be compared at all.
 *
 * The refusals `KnowledgeAnchorSchema` makes of a knowledge entry's anchor, for the same reasons, but
 * answered as a boolean rather than thrown: a blank part matches nothing, a padded one is matched verbatim
 * and so matches nothing either, a line break would turn git's fixed-string search into several patterns,
 * and a line-number symbol names a position that moves under every edit above it (`memory-design.md`). A
 * question carrying one of these is not refused — Q4 only asks that it be *attempted* — it is simply not
 * deflectable and not mergeable by anchor, and passes through to be asked.
 */
export const isUsableAnchor = (anchor: QuestionAnchor): boolean =>
  isComparablePart(anchor.symbol) && isComparablePart(anchor.aspect) && !isLineNumberAnchor(anchor.symbol);

/**
 * The anchor as the one string `QuestionDeflection.anchor` carries: `symbol:aspect`.
 *
 * The contract's field is a string and this story changes no shipped contract, so the two parts are
 * joined with a colon rather than the field being widened. It is a rendering for the record, never parsed
 * back: every comparison in this story is made on the two parts.
 */
export const formatAnchor = (anchor: QuestionAnchor): string => `${anchor.symbol}:${anchor.aspect}`;

/**
 * True when a text names both parts of the anchor as whole tokens.
 *
 * Exported (story 5-3) so `decision-index.ts`'s `queryDecisionIndex` compares an indexed decision
 * against an anchor exactly as `matchDecisionLedger` below does, rather than a second whole-token
 * matcher being written. A pure addition: this function's behaviour is unchanged.
 */
export const namesAnchor = (text: string, anchor: QuestionAnchor): boolean =>
  mentionsSymbol(text, anchor.symbol) && mentionsSymbol(text, anchor.aspect);

/** What one attempt found in one source. The answer is the source's own text, never a paraphrase. */
export interface DeflectionMatch {
  readonly source: DeflectionSource;
  readonly anchor: QuestionAnchor;
  /** The text that answers the question, as the source states it, prefixed with where it was found. */
  readonly answer: string;
  /** Where the answer came from: an instruction file's name, a short commit SHA, or a run id. */
  readonly evidence: string;
  /** The run a `decision_ledger` answer was decided in; `null` for the other two sources. */
  readonly run: string | null;
}

/** What one source contributed to an attempt, so "not deflected" always says why. */
export interface SourceVerdict {
  readonly source: DeflectionSource;
  readonly outcome: 'matched' | 'no_match' | 'not_consulted';
  /** R3 — one sentence that stands alone. */
  readonly detail: string;
  /** Inputs this source could not read — instruction files, prior runs, a history — each counted as no match. */
  readonly unreadable: readonly string[];
}

/** One question's whole attempt: the match if any, and what each source said. */
export interface DeflectionAttempt {
  readonly anchor: QuestionAnchor;
  readonly match: DeflectionMatch | null;
  /** In {@link DEFLECTION_SOURCES} order, one per source, including the ones never reached. */
  readonly consulted: readonly SourceVerdict[];
}

/** Where an attempt looks. Every field names a place; none of them is a store this module keeps. */
export interface DeflectionContext {
  /** The repository root — its instruction files and its history — or `null` when there is none. */
  readonly repository: string | null;
  /** The `ORCH_HOME` the ledger runs live under. */
  readonly orchHome: string;
  /**
   * The runs whose `decision.recorded` lines are this project's ledger.
   *
   * Named by the caller rather than discovered, because nothing in a run's log yet records which project
   * it belongs to: enumerating every run under `ORCH_HOME` would deflect one repository's question with
   * another repository's decision. The current run belongs here too, so a question answered earlier in
   * the same run is not asked again (Q7). Their order does not decide which decision is newest; each
   * decision's own `resolved_at` does.
   */
  readonly ledgerRuns: readonly string[];
}

/** Paragraphs, split on a blank line whichever line ending the file was written with. */
const PARAGRAPH_BREAK = /\r?\n[ \t]*\r?\n/;

/**
 * The paragraph of `text` that names the whole anchor, or `null` when no single paragraph does.
 *
 * Both parts must be in the *same* paragraph: a file that names `resolveProject` in one section and
 * `caching` in an unrelated one has not said anything about caching `resolveProject`. A paragraph rather
 * than a line because an instruction is usually a sentence or two that wraps, and a line cut out of the
 * middle of one answers nothing.
 */
const passageNaming = (text: string, anchor: QuestionAnchor): string | null => {
  for (const paragraph of text.split(PARAGRAPH_BREAK)) {
    if (namesAnchor(paragraph, anchor)) return paragraph.trim();
  }
  return null;
};

const verdict = (
  source: DeflectionSource,
  outcome: SourceVerdict['outcome'],
  detail: string,
  unreadable: readonly string[] = [],
): SourceVerdict => ({ source, outcome, detail, unreadable });

interface SourceResult {
  readonly verdict: SourceVerdict;
  readonly match: DeflectionMatch | null;
}

const noMatch = (source: DeflectionSource, detail: string, unreadable: readonly string[] = []): SourceResult => ({
  verdict: verdict(source, 'no_match', detail, unreadable),
  match: null,
});

/**
 * `repository` — the instruction files AD-16 makes authoritative for conventions.
 *
 * `conventionsSpeakingTo` is story 2-3's question asked verbatim of the symbol, so "the repository speaks
 * to this symbol" means one thing whether a knowledge entry or a question asked it; the aspect is then
 * required in the same paragraph. An unreadable instruction file escalates at run start
 * (`ConventionsUnreadable`), and rightly — but here it is a place this attempt could not look, not a
 * reason to stop a question reaching a person. Any other error is a defect and is not dressed up as one.
 */
const matchRepository = (repository: string | null, anchor: QuestionAnchor): SourceResult => {
  const source: DeflectionSource = 'repository';
  const named = formatAnchor(anchor);
  if (repository === null) return noMatch(source, 'No repository was named, so no instructions were read.');
  let conventions: RepositoryConventions;
  try {
    conventions = readConventions(repository);
  } catch (error) {
    if (!(error instanceof ConventionsUnreadable)) throw error;
    return noMatch(
      source,
      `${error.path} could not be read, so the repository's instructions were counted as saying ` +
        `nothing about "${named}".`,
      [error.path],
    );
  }
  for (const file of conventionsSpeakingTo(conventions, anchor.symbol)) {
    const passage = passageNaming(file.text, anchor);
    if (passage === null) continue;
    return {
      verdict: verdict(source, 'matched', `${file.name} names "${named}" in one paragraph.`),
      match: { source, anchor, answer: `${file.name}: ${passage}`, evidence: file.name, run: null },
    };
  }
  return noMatch(source, `No paragraph of an instruction file in ${repository} names "${named}".`);
};

/**
 * The length a commit SHA is shortened to in an answer.
 *
 * Twelve, not forty, because the answer travels in a `question.deflected` payload and AD-21's sweep
 * rewrites an unbroken high-entropy run of 24 or more wherever it appears: a full SHA would reach the log
 * as the redaction marker, and the one pointer back to the evidence would be the part nobody could read.
 */
const SHORT_SHA_LENGTH = 12;

/**
 * How many candidate commits one attempt pages through before it stops looking.
 *
 * A bound, because a question waits on this: a symbol the prefilter finds in every commit of a very long
 * history would otherwise keep a person's question in the attempt indefinitely. Reaching it is reported,
 * so "not deflected" says the older history was not searched rather than that it said nothing.
 */
const MAX_COMMITS_SCANNED = 5_000;

/**
 * `git_history` — commit messages, and the committer's AD-22 note on the merge commit.
 *
 * The note is searched because it is the in-repository record of a run's decisions: a question another
 * feature already had answered left its answer there, which is what "PR-adjacent" history is in a system
 * whose pull request is described by that note. Git's search narrows by substring on the symbol and this
 * confirms both parts by whole token, so `resolveProjectPath` in a message is not an answer about
 * `resolveProject`. The search pages past one call's cap, so a match older than the newest page is found.
 *
 * A git that could not answer — not a repository, no commits, an overflowing history — is no match, and
 * says so in the verdict and lists the repository as unreadable, so it never reads as "no commit names it".
 */
const matchGitHistory = (repository: string | null, anchor: QuestionAnchor): SourceResult => {
  const source: DeflectionSource = 'git_history';
  const named = formatAnchor(anchor);
  if (repository === null) return noMatch(source, 'No repository was named, so no history was read.');
  for (let skip = 0; skip < MAX_COMMITS_SCANNED; skip += DEFAULT_COMMIT_SEARCH_LIMIT) {
    const page = searchCommitHistory(repository, anchor.symbol, {
      notesRef: NOTE_REF,
      limit: DEFAULT_COMMIT_SEARCH_LIMIT,
      skip,
    });
    if (page.failure !== null) {
      return noMatch(source, `History was not searched for "${named}": ${page.failure}.`, [repository]);
    }
    for (const commit of page.commits) {
      const passage = passageNaming(commit.message, anchor) ?? passageNaming(commit.note, anchor);
      if (passage === null) continue;
      const shortSha = commit.sha.slice(0, SHORT_SHA_LENGTH);
      return {
        verdict: verdict(source, 'matched', `Commit ${shortSha} names "${named}".`),
        match: { source, anchor, answer: `commit ${shortSha}: ${passage}`, evidence: shortSha, run: null },
      };
    }
    if (page.commits.length < DEFAULT_COMMIT_SEARCH_LIMIT) {
      return noMatch(source, `No commit message or note in ${repository} names "${named}".`);
    }
  }
  return noMatch(
    source,
    `No commit among the newest ${String(MAX_COMMITS_SCANNED)} candidates in ${repository} names ` +
      `"${named}"; older history was not searched.`,
  );
};

const payloadText = (payload: Record<string, unknown>, key: string): string => {
  const value = payload[key];
  return typeof value === 'string' ? value : '';
};

/**
 * True when the AD-21 pass rewrote this decision's answer on the way into the log.
 *
 * `decision.ts` names the rewritten fields in the line itself for exactly this reader: an answer the log
 * holds as the redaction marker is not what the person said, and deflecting a new question with it would
 * hand a subagent `[redacted]` as a decision.
 */
const answerWasRewritten = (payload: Record<string, unknown>): boolean =>
  payloadText(payload, REDACTED_FIELDS_PAYLOAD_KEY)
    .split(',')
    .map((field) => field.trim())
    .includes('answer');

/**
 * The resolver whose decisions are not decisions (matrix 19).
 *
 * A `timeout_default` line records that a window expired and CAP-4 took the recommended default — which
 * is the right thing for *that* question, and is nobody's answer to this one. Q7's "answered once becomes
 * a ledger rule" is about a question a person answered; deflecting from a timeout would make a default
 * nobody chose into precedent nobody can see was never chosen.
 */
const TIMEOUT_RESOLVER = 'timeout_default';

/**
 * A read failure that means "this run's log is not there to read", as opposed to a defect.
 *
 * Narrowed on purpose. The corrupt-log and unsafe-id errors are the runtime's own, and a Node `fs` error
 * carries an errno code (`ENOENT`, `EACCES`, `EISDIR`); anything else — a `TypeError` from a changed
 * payload shape, say — is a bug in this build, and filing it under "unreadable" would hide it for ever.
 *
 * Exported (story 5-3) so `decision-index.ts`'s `buildDecisionIndex` classifies a per-run read failure on
 * exactly these grounds instead of a second, looser definition of "unreadable" being written beside it. A
 * pure addition: this function's behaviour is unchanged.
 */
export const isUnreadableLog = (error: unknown): boolean =>
  error instanceof EventLogCorruptError ||
  error instanceof UnsafePathSegmentError ||
  (error instanceof Error && 'code' in error && typeof error.code === 'string' && /^E[A-Z]+$/.test(error.code));

/** One decision that names the anchor, with what orders it against the others. */
interface LedgerCandidate {
  readonly run: string;
  readonly payload: Record<string, unknown>;
  readonly resolvedAt: string;
  readonly order: number;
}

/**
 * `decision_ledger` — a linear fold over `decision.recorded` lines, newest decision winning.
 *
 * The lines are read with the recorder's own reader and `decisionsInLog`, so this is a *reader* of the
 * ledger `decision.ts` writes and not a second definition of it. A decision names the anchor when its
 * question and answer together name both parts.
 *
 * **Newest is by the decision's own `resolved_at`**, an RFC3339 instant that orders as text, with the
 * fold's reading order breaking ties — so the answer does not depend on the order a caller listed runs in.
 * That tie-break is still the *reading* order of this fold's own `runs` argument when two decisions share
 * one `resolved_at` to the millisecond — an extremely rare case, and caller-order-dependent in exactly the
 * way the primary sort is not; `decision-index.ts`'s `queryDecisionIndex` inherits this same limitation
 * over its own `entries` argument rather than resolving it, since resolving it there would make the index
 * disagree with the live fold it exists to mirror. And **newest means newest, even when it cannot be
 * used** (matrix 20): when the newest decision naming
 * the anchor had its answer rewritten by AD-21, or recorded none, there is no match. Falling back to the
 * decision before it would deflect with an answer that decision had already superseded.
 *
 * A run whose log is absent contributes nothing, and one that cannot be read is listed as unreadable and
 * contributes nothing either. Neither stops the fold, and neither reaches the caller as a throw.
 */
const matchDecisionLedger = (
  orchHome: string,
  runs: readonly string[],
  anchor: QuestionAnchor,
): SourceResult => {
  const source: DeflectionSource = 'decision_ledger';
  const named = formatAnchor(anchor);
  const unreadable: string[] = [];
  const candidates: LedgerCandidate[] = [];
  let timeouts = 0;
  for (const run of runs) {
    let decisions: readonly Record<string, unknown>[];
    try {
      const paths = runPaths(run, orchHome);
      decisions = decisionsInLog(readEventLog(paths.eventLog));
    } catch (error) {
      if (!isUnreadableLog(error)) throw error;
      unreadable.push(run);
      continue;
    }
    for (const payload of decisions) {
      const text = `${payloadText(payload, 'question')}\n${payloadText(payload, 'answer')}`;
      if (!namesAnchor(text, anchor)) continue;
      if (payloadText(payload, 'resolver') === TIMEOUT_RESOLVER) {
        timeouts += 1;
        continue;
      }
      candidates.push({ run, payload, resolvedAt: payloadText(payload, 'resolved_at'), order: candidates.length });
    }
  }

  const notes =
    (unreadable.length === 0
      ? ''
      : ` ${String(unreadable.length)} run log(s) could not be read and were counted as no match.`) +
    (timeouts === 0 ? '' : ` ${String(timeouts)} timeout default(s) were not counted as decisions.`);
  const newest = [...candidates]
    .sort((a, b) => (a.resolvedAt < b.resolvedAt ? -1 : a.resolvedAt > b.resolvedAt ? 1 : a.order - b.order))
    .at(-1);
  if (newest === undefined) {
    return noMatch(source, `No recorded decision names "${named}".${notes}`, unreadable);
  }
  const answer = payloadText(newest.payload, 'answer');
  if (answerWasRewritten(newest.payload) || answer.trim() === '') {
    return noMatch(
      source,
      `The newest decision naming "${named}", in run ${newest.run}, has no answer the log can show ` +
        `(redacted or blank), and the older decisions it superseded are not used in its place.${notes}`,
      unreadable,
    );
  }
  const questionId = payloadText(newest.payload, QUESTION_ID_PAYLOAD_KEY);
  return {
    verdict: verdict(source, 'matched', `Run ${newest.run} recorded a decision naming "${named}".${notes}`, unreadable),
    match: {
      source,
      anchor,
      // The question id is named beside the run because it is punctuated to survive AD-21, and a run
      // id — a bare ULID — does not: the log keeps the pointer that can be followed, and `outcome.json`
      // keeps both.
      answer: `decided in run ${newest.run}${questionId === '' ? '' : ` (question ${questionId})`}: ${answer}`,
      evidence: newest.run,
      run: newest.run,
    },
  };
};

/**
 * Attempt one anchor against every source, in Q4's order, stopping at the first match.
 *
 * The order is {@link DEFLECTION_SOURCES}' own, which is Q4's: the repository is authoritative for
 * conventions (AD-16), history is what the repository did, and the ledger is what a person decided. A
 * source after the match is recorded as not consulted rather than omitted, so an attempt always reports
 * three verdicts and a reader never has to infer why one is missing.
 */
export const attemptDeflection = (anchor: QuestionAnchor, context: DeflectionContext): DeflectionAttempt => {
  const named = formatAnchor(anchor);
  if (!isUsableAnchor(anchor)) {
    return {
      anchor,
      match: null,
      consulted: DEFLECTION_SOURCES.map((source) =>
        verdict(
          source,
          'not_consulted',
          `"${named}" is not an anchor anything can be compared against — a part is blank, padded, on ` +
            'more than one line, or the symbol is a line number.',
        ),
      ),
    };
  }
  const matchers: Readonly<Record<DeflectionSource, () => SourceResult>> = {
    repository: () => matchRepository(context.repository, anchor),
    git_history: () => matchGitHistory(context.repository, anchor),
    decision_ledger: () => matchDecisionLedger(context.orchHome, context.ledgerRuns, anchor),
  };
  const consulted: SourceVerdict[] = [];
  let match: DeflectionMatch | null = null;
  for (const source of DEFLECTION_SOURCES) {
    if (match !== null) {
      consulted.push(
        verdict(source, 'not_consulted', `Not consulted: ${match.source} already answered "${named}".`),
      );
      continue;
    }
    const result = matchers[source]();
    consulted.push(result.verdict);
    match = result.match;
  }
  return { anchor, match, consulted };
};

/**
 * The {@link QuestionDeflection} a match becomes — the argument `attemptQuestionDeflection` accepts.
 *
 * Parsed through the contract's own schema, so a deflection this module builds is one the compare-and-set
 * would accept byte for byte; the timestamp is the caller's clock, because the instant a deflection is
 * claimed is the instant it races the other resolvers at.
 */
export const constructDeflection = (match: DeflectionMatch, at: Date = new Date()): QuestionDeflection =>
  QuestionDeflectionSchema.parse({
    source: match.source,
    answer: match.answer,
    anchor: formatAnchor(match.anchor),
    deflected_at: formatTimestamp(at),
  });

/**
 * Apply a constructed deflection through AD-25's compare-and-set, and through nothing else.
 *
 * A pass-through by design: the deflection is handed to `attemptQuestionDeflection` unchanged, so it
 * contends for `outcome.json` exactly as a TUI answer or the timeout default does (ADR-002) and can lose
 * to either. The `question.deflected` line follows from the outcome that stands, emitted by the
 * reconciler's pass when it settles the question — this module appends nothing and writes no file.
 */
export const applyDeflection = (
  paths: RunPaths,
  questionId: string,
  deflection: QuestionDeflection,
): QuestionClaim => attemptQuestionDeflection(paths, questionId, deflection);
