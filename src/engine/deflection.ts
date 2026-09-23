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
 * anchor it declares — a test name, an API symbol, a module name — appearing as a whole token in the
 * source, which is `mentionsSymbol` from story 2-3 and the same grounds that story gave: code cannot
 * decide that two sentences mean the same thing, and a classifier bolted on beside it would be a second
 * model family with its own credential and egress path, which AD-1's subscription-only boundary does
 * not admit (the TypeSafe decision closed with this story). So there is no similarity score, no
 * threshold and no override here. A question the anchors miss is not deflected; it goes on to be merged
 * and asked, which is the safe direction of this error — a person is asked once more than necessary,
 * rather than answered with a paragraph about a different symbol.
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
import { readEventLog, runPaths, searchCommitHistory } from '../runtime/index.js';
import type { RunPaths } from '../runtime/index.js';

import {
  ConventionsUnreadable,
  conventionsSpeakingTo,
  mentionsSymbol,
  readConventions,
} from './conventions.js';
import { decisionsInLog } from './decision.js';
import {
  QUESTION_ID_PAYLOAD_KEY,
  REDACTED_FIELDS_PAYLOAD_KEY,
  attemptQuestionDeflection,
} from './questions.js';
import type { RepositoryConventions } from './conventions.js';
import type { QuestionClaim } from './questions.js';

/**
 * True when an anchor can be compared at all.
 *
 * The three refusals `KnowledgeAnchorSchema` makes of a knowledge entry's anchor, for the same reasons,
 * but answered as a boolean rather than thrown: a blank anchor matches nothing, a padded one is matched
 * verbatim and so matches nothing either, and a line number names a position that moves under every edit
 * above it (`memory-design.md`). A question carrying one of these is not refused — Q4 only asks that it be
 * *attempted* — it is simply not deflectable and not mergeable by anchor, and passes through to be asked.
 */
export const isUsableAnchor = (anchor: string): boolean =>
  anchor.trim() !== '' && anchor === anchor.trim() && !isLineNumberAnchor(anchor);

/** What one attempt found in one source. The answer is the source's own text, never a paraphrase. */
export interface DeflectionMatch {
  readonly source: DeflectionSource;
  readonly anchor: string;
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
  /** Inputs this source could not read — instruction files, prior runs — each counted as no match. */
  readonly unreadable: readonly string[];
}

/** One question's whole attempt: the match if any, and what each source said. */
export interface DeflectionAttempt {
  readonly anchor: string;
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
   * The runs whose `decision.recorded` lines are this project's ledger, oldest first.
   *
   * Named by the caller rather than discovered, because nothing in a run's log yet records which project
   * it belongs to: enumerating every run under `ORCH_HOME` would deflect one repository's question with
   * another repository's decision. The current run belongs here too, so a question answered earlier in
   * the same run is not asked again (Q7).
   */
  readonly ledgerRuns: readonly string[];
}

/**
 * The passage of `text` that mentions the anchor: its paragraph, or the whole text when it has none.
 *
 * A paragraph rather than a line because an instruction is usually a sentence or two that wraps, and a
 * line cut out of the middle of one answers nothing. Selected by the same whole-token rule as the match,
 * so the answer shown is the passage that caused the deflection and not merely the first paragraph.
 */
const passageMentioning = (text: string, anchor: string): string => {
  for (const paragraph of text.split(/\n[ \t]*\n/)) {
    if (mentionsSymbol(paragraph, anchor)) return paragraph.trim();
  }
  return text.trim();
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

/**
 * `repository` — the instruction files AD-16 makes authoritative for conventions.
 *
 * `conventionsSpeakingTo` is story 2-3's question asked verbatim; it is reused rather than restated so
 * "the repository speaks to this anchor" means one thing whether a knowledge entry or a question asked
 * it. An unreadable instruction file escalates at run start (`ConventionsUnreadable`), and rightly — but
 * here it is a place this attempt could not look, not a reason to stop a question reaching a person.
 */
const matchRepository = (repository: string | null, anchor: string): SourceResult => {
  const source: DeflectionSource = 'repository';
  if (repository === null) {
    return {
      verdict: verdict(source, 'no_match', 'No repository was named, so no instructions were read.'),
      match: null,
    };
  }
  let conventions: RepositoryConventions;
  try {
    conventions = readConventions(repository);
  } catch (error) {
    if (!(error instanceof ConventionsUnreadable)) throw error;
    return {
      verdict: verdict(
        source,
        'no_match',
        `${error.path} could not be read, so the repository's instructions were counted as saying ` +
          `nothing about "${anchor}".`,
        [error.path],
      ),
      match: null,
    };
  }
  const [file] = conventionsSpeakingTo(conventions, anchor);
  if (file === undefined) {
    return {
      verdict: verdict(source, 'no_match', `No instruction file in ${repository} names "${anchor}".`),
      match: null,
    };
  }
  return {
    verdict: verdict(source, 'matched', `${file.name} names "${anchor}".`),
    match: {
      source,
      anchor,
      answer: `${file.name}: ${passageMentioning(file.text, anchor)}`,
      evidence: file.name,
      run: null,
    },
  };
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
 * `git_history` — commit messages, and the committer's AD-22 note on the merge commit.
 *
 * The note is searched because it is the in-repository record of a run's decisions: a question another
 * feature already had answered left its answer there, which is what "PR-adjacent" history is in a system
 * whose pull request is described by that note. Git's search narrows by substring and this confirms by
 * whole token, so `resolveProjectPath` in a message is not an answer about `resolveProject`.
 */
const matchGitHistory = (repository: string | null, anchor: string): SourceResult => {
  const source: DeflectionSource = 'git_history';
  if (repository === null) {
    return {
      verdict: verdict(source, 'no_match', 'No repository was named, so no history was read.'),
      match: null,
    };
  }
  for (const commit of searchCommitHistory(repository, anchor, { notesRef: NOTE_REF })) {
    const text = mentionsSymbol(commit.message, anchor)
      ? commit.message
      : mentionsSymbol(commit.note, anchor)
        ? commit.note
        : null;
    if (text === null) continue;
    const shortSha = commit.sha.slice(0, SHORT_SHA_LENGTH);
    return {
      verdict: verdict(source, 'matched', `Commit ${shortSha} names "${anchor}".`),
      match: {
        source,
        anchor,
        answer: `commit ${shortSha}: ${passageMentioning(text, anchor)}`,
        evidence: shortSha,
        run: null,
      },
    };
  }
  return {
    verdict: verdict(source, 'no_match', `No commit message or note in ${repository} names "${anchor}".`),
    match: null,
  };
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
 * hand a subagent `[redacted]` as a decision. Such a line is skipped; the verbatim answer survives only in
 * that run's `questions/`, which a later story may read, and this one does not guess at.
 */
const answerWasRewritten = (payload: Record<string, unknown>): boolean =>
  payloadText(payload, REDACTED_FIELDS_PAYLOAD_KEY)
    .split(',')
    .map((field) => field.trim())
    .includes('answer');

/**
 * `decision_ledger` — a linear fold over `decision.recorded` lines, newest decision winning.
 *
 * The lines are read with the recorder's own reader and `decisionsInLog`, so this is a *reader* of the
 * ledger `decision.ts` writes and not a second definition of it. Newest wins because a later decision
 * about the same anchor supersedes an earlier one — the same order a person would consult them in.
 *
 * A run whose log is absent contributes nothing, and one that cannot be read — torn, corrupt, a directory
 * where the file should be, an id that is not a safe path segment — is listed as unreadable and
 * contributes nothing either. Neither stops the fold, and neither reaches the caller as a throw.
 */
const matchDecisionLedger = (orchHome: string, runs: readonly string[], anchor: string): SourceResult => {
  const source: DeflectionSource = 'decision_ledger';
  const unreadable: string[] = [];
  let match: DeflectionMatch | null = null;
  for (const run of runs) {
    let decisions: readonly Record<string, unknown>[];
    try {
      const paths = runPaths(run, orchHome);
      decisions = decisionsInLog(readEventLog(paths.eventLog));
    } catch {
      unreadable.push(run);
      continue;
    }
    for (const decision of decisions) {
      const question = payloadText(decision, 'question');
      const answer = payloadText(decision, 'answer');
      if (!mentionsSymbol(question, anchor) && !mentionsSymbol(answer, anchor)) continue;
      if (answerWasRewritten(decision) || answer.trim() === '') continue;
      const questionId = payloadText(decision, QUESTION_ID_PAYLOAD_KEY);
      match = {
        source,
        anchor,
        // The question id is named beside the run because it is punctuated to survive AD-21, and a run
        // id — a bare ULID — does not: the log keeps the pointer that can be followed, and `outcome.json`
        // keeps both.
        answer: `decided in run ${run}${questionId === '' ? '' : ` (question ${questionId})`}: ${answer}`,
        evidence: run,
        run,
      };
    }
  }
  const skipped =
    unreadable.length === 0
      ? ''
      : ` ${String(unreadable.length)} run log(s) could not be read and were counted as no match.`;
  return {
    verdict:
      match === null
        ? verdict(source, 'no_match', `No recorded decision names "${anchor}".${skipped}`, unreadable)
        : verdict(
            source,
            'matched',
            `Run ${match.evidence} recorded a decision naming "${anchor}".${skipped}`,
            unreadable,
          ),
    match,
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
export const attemptDeflection = (anchor: string, context: DeflectionContext): DeflectionAttempt => {
  if (!isUsableAnchor(anchor)) {
    return {
      anchor,
      match: null,
      consulted: DEFLECTION_SOURCES.map((source) =>
        verdict(
          source,
          'not_consulted',
          `"${anchor}" is not an anchor anything can be compared against — blank, padded, or a line ` +
            'number.',
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
        verdict(source, 'not_consulted', `Not consulted: ${match.source} already answered "${anchor}".`),
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
    anchor: match.anchor,
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
