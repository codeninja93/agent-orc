/**
 * Q4 — a question is attempted against the repository, git history and the decision ledger first.
 *
 * Matrix rows 5–8, 12, 15 and 17–20. Instruction files, commits and notes are real, in real repositories.
 * Ledger lines come two ways: appended by the real reconciler answering a real question wherever the
 * behaviour under test is "a decision a person made", and written directly as AD-5 envelopes only for the
 * shapes a reconciler in a test cannot be made to produce on demand — a timeout default, a rewritten
 * answer, a blank one, a chosen `resolved_at`.
 *
 * **Each matching row has a boundary case beside it, and the boundary is the point.** Deflection by
 * anchor is only worth anything if a *different* anchor does not deflect: `resolveProject` must not be
 * answered by a paragraph about `resolveProjectPath`, and "should `resolveProject` cache?" must not be
 * answered by a paragraph about what it does on a miss. A suite that only showed the matching case would
 * pass against a substring matcher, which is the similarity measure this story exists not to build.
 */
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DEFLECTION_SOURCES, NOTE_REF } from '../src/contracts/index.js';
import type { QuestionDraft } from '../src/contracts/index.js';
import {
  DEFAULT_COMMIT_SEARCH_LIMIT,
  QUESTION_OUTCOME_FILE_NAME,
  questionPaths,
  runPaths,
  searchCommitHistory,
} from '../src/runtime/index.js';
import {
  Reconciler,
  applyDeflection,
  askQuestion,
  attemptDeflection,
  attemptQuestionResolution,
  compressQuestions,
  constructDeflection,
  createRecordingResetter,
  createScriptedExecutor,
  formatAnchor,
  isUsableAnchor,
  mintQuestionId,
  mintRunId,
  questionResolution,
  readQuestionOutcome,
  readQuestionState,
  terminated,
} from '../src/engine/index.js';
import type { DeflectionContext, DeflectionMatch, QuestionAnchor } from '../src/engine/index.js';

import { fixtureCommit, fixtureGit, makeGitWorktree, makeHome, makePlan, planProvider } from './helpers/engine-fixture.js';
import { stripComments } from './helpers/source-sweep.js';

const BASELINE = 'ddd9bed4d286ac1f8a0f4f7bfef9530046605787';

let home: string;
const toRemove: string[] = [];
const toClose: Reconciler[] = [];

beforeEach(() => {
  home = makeHome('engine-deflection');
  toRemove.push(home);
});

afterEach(() => {
  for (const reconciler of toClose.splice(0)) reconciler.close();
  for (const dir of toRemove.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const openReconciler = (): Reconciler => {
  const reconciler = Reconciler.open({
    orchHome: home,
    executor: createScriptedExecutor({
      onStart: (request) => terminated(request.step, 'completed', { sessionId: `sess-${request.step}` }),
    }),
    plans: planProvider(makePlan()),
    baseline: createRecordingResetter(BASELINE),
  });
  toClose.push(reconciler);
  return reconciler;
};

const anchor = (symbol: string, aspect: string): QuestionAnchor => ({ symbol, aspect });

const aDraft = (overrides: Partial<QuestionDraft> = {}): QuestionDraft => ({
  prompt: 'Should resolveProject throw or return null when the path is unregistered?',
  brief:
    'The project store resolves a repository path to its registration. Throwing makes a missing ' +
    'registration loud; returning null lets the installer offer to register it.',
  options: [
    { id: 'throw', label: 'Throw', consequence: 'A caller that forgot to register fails loudly.' },
    { id: 'null', label: 'Return null', consequence: 'The installer can offer to register the path.' },
  ],
  escape: { id: 'ask-later', label: 'Ask me at the review', consequence: 'The step waits for an answer.' },
  recommended_option_id: 'null',
  default_action: 'resolveProject returns null for an unregistered path.',
  default_window_ms: 15 * 60 * 1000,
  ...overrides,
});

const context = (overrides: Partial<DeflectionContext> = {}): DeflectionContext => ({
  repository: null,
  orchHome: home,
  ledgerRuns: [],
  ...overrides,
});

/** A repository holding the given instruction files, committed. */
const repositoryWithFiles = (files: Readonly<Record<string, string>>): string => {
  const repo = makeGitWorktree('deflection');
  toRemove.push(repo.dir);
  for (const [name, text] of Object.entries(files)) repo.write(name, text);
  fixtureCommit(repo.dir, 'add instructions');
  return repo.dir;
};

const repositoryWith = (claudeMd: string): string => repositoryWithFiles({ 'CLAUDE.md': claudeMd });

const CLAUDE_MD = [
  '# Conventions',
  '',
  'Use named exports only. Every lookup result is cached per process.',
  '',
  'resolveProject returns null for an unregistered path, and the installer offers to register it.',
  'Never throw from it: the interview depends on the null.',
  '',
  'Tests are named as sentences about behaviour.',
  '',
].join('\n');

const UNREGISTERED = anchor('resolveProject', 'unregistered');

describe('a question whose anchor the repository’s instructions name is deflected (matrix 5)', () => {
  it('deflects with source repository, carrying the anchor and the paragraph that names it', () => {
    const repo = repositoryWith(CLAUDE_MD);
    const attempt = attemptDeflection(UNREGISTERED, context({ repository: repo }));

    expect(attempt.match?.source).toBe('repository');
    expect(attempt.match?.anchor).toStrictEqual(UNREGISTERED);
    expect(attempt.match?.evidence).toBe('CLAUDE.md');
    // The paragraph that caused the match, verbatim — not the first paragraph, not the whole file.
    expect(attempt.match?.answer).toBe(
      'CLAUDE.md: resolveProject returns null for an unregistered path, and the installer offers to ' +
        'register it.\nNever throw from it: the interview depends on the null.',
    );
    expect(attempt.consulted.map((entry) => entry.outcome)).toStrictEqual([
      'matched',
      'not_consulted',
      'not_consulted',
    ]);
  });

  it('reads AGENTS.md when CLAUDE.md does not name the anchor', () => {
    const repo = repositoryWithFiles({
      'CLAUDE.md': 'Use named exports only.\n',
      'AGENTS.md': 'The session store is keyed by sessionKey, never by user id.\n',
    });
    const attempt = attemptDeflection(anchor('sessionKey', 'user id'), context({ repository: repo }));
    expect(attempt.match?.evidence).toBe('AGENTS.md');
  });

  it('passes over a file that names the symbol without the aspect, and takes the one that names both', () => {
    const repo = repositoryWithFiles({
      'CLAUDE.md': 'sessionKey is exported from src/session.ts.\n',
      'AGENTS.md': 'sessionKey rotates on every login.\n',
    });
    const attempt = attemptDeflection(anchor('sessionKey', 'login'), context({ repository: repo }));
    expect(attempt.match?.evidence).toBe('AGENTS.md');
    expect(attempt.match?.answer).toBe('AGENTS.md: sessionKey rotates on every login.');
  });

  it('does not deflect a different symbol that merely shares a prefix with a named one', () => {
    const repo = repositoryWith(
      'resolveProjectPath normalises an unregistered path before lookup, and it throws on a relative one.\n',
    );
    expect(attemptDeflection(UNREGISTERED, context({ repository: repo })).match).toBeNull();
  });

  it('matches a symbol carrying pattern characters literally, and not its longer namesake', () => {
    const repo = repositoryWith('$store.get returns undefined on a miss.\n\n$store.getAll throws on a timeout.\n');
    expect(attemptDeflection(anchor('$store.get', 'miss'), context({ repository: repo })).match?.answer).toBe(
      'CLAUDE.md: $store.get returns undefined on a miss.',
    );
    expect(attemptDeflection(anchor('$store.get', 'timeout'), context({ repository: repo })).match).toBeNull();
  });

  it('splits a CRLF file into paragraphs, so the answer is the paragraph and not the file', () => {
    const repo = repositoryWith(CLAUDE_MD.replace(/\n/g, '\r\n'));
    expect(attemptDeflection(UNREGISTERED, context({ repository: repo })).match?.answer).toBe(
      'CLAUDE.md: resolveProject returns null for an unregistered path, and the installer offers to ' +
        'register it.\r\nNever throw from it: the interview depends on the null.',
    );
  });

  it('counts an unreadable instruction file as no match rather than throwing', () => {
    const repo = repositoryWith(CLAUDE_MD);
    chmodSync(join(repo, 'CLAUDE.md'), 0o000);
    try {
      const attempt = attemptDeflection(UNREGISTERED, context({ repository: repo }));
      expect(attempt.consulted[0]?.outcome).toBe('no_match');
      expect(attempt.consulted[0]?.unreadable).toStrictEqual([join(repo, 'CLAUDE.md')]);
    } finally {
      chmodSync(join(repo, 'CLAUDE.md'), 0o644);
    }
  });
});

describe('an anchor is two parts, and both must match (matrix 17, 18)', () => {
  it('does not deflect a question about the same symbol and a different aspect', () => {
    const repo = repositoryWith(CLAUDE_MD);
    // CLAUDE.md speaks to resolveProject on an unregistered path; this asks whether it caches.
    expect(attemptDeflection(anchor('resolveProject', 'cached'), context({ repository: repo })).match).toBeNull();
    expect(attemptDeflection(UNREGISTERED, context({ repository: repo })).match).not.toBeNull();
  });

  it('requires both parts in one paragraph, not scattered across the file', () => {
    // "cached" is in the first paragraph and resolveProject in the second: nothing says it is cached.
    const repo = repositoryWith(CLAUDE_MD);
    expect(attemptDeflection(anchor('resolveProject', 'cached'), context({ repository: repo })).consulted[0]?.outcome).toBe(
      'no_match',
    );
  });

  it('refuses to consult anything for an anchor with a blank, padded, multi-line or line-number part', () => {
    const repo = repositoryWith(CLAUDE_MD);
    for (const unusable of [
      anchor('resolveProject', ''),
      anchor('', 'unregistered'),
      anchor('resolveProject', ' unregistered'),
      anchor('resolveProject', 'unregistered\npath'),
      anchor('src/project.ts:42', 'unregistered'),
    ]) {
      expect(isUsableAnchor(unusable)).toBe(false);
      const attempt = attemptDeflection(unusable, context({ repository: repo }));
      expect(attempt.match).toBeNull();
      expect(attempt.consulted.every((entry) => entry.outcome === 'not_consulted')).toBe(true);
    }
  });

  it('records the two parts in the deflection’s one anchor string', () => {
    expect(formatAnchor(UNREGISTERED)).toBe('resolveProject:unregistered');
  });
});

/** A repository whose commits are written by `git fast-import`, so a long history costs one process. */
const repositoryWithCommits = (messages: readonly string[]): string => {
  const dir = mkdtempSync(join(tmpdir(), 'orch-history-'));
  toRemove.push(dir);
  fixtureGit(dir, ['init', '--initial-branch', 'main']);
  const stream = messages
    .map((message, index) => {
      const body = Buffer.from(message, 'utf8');
      return [
        'commit refs/heads/main',
        `mark :${String(index + 1)}`,
        `committer Fixture <fixture@example.invalid> ${String(1_700_000_000 + index)} +0000`,
        `data ${String(body.length)}`,
        message,
        index === 0 ? '' : `from :${String(index)}`,
        '',
      ].join('\n');
    })
    .join('');
  execFileSync('git', ['-C', dir, 'fast-import', '--quiet'], { input: stream, stdio: ['pipe', 'ignore', 'pipe'] });
  return dir;
};

describe('a question whose anchor git history names is deflected (matrix 6)', () => {
  it('deflects with source git_history from a commit message, naming a short SHA the log can keep', () => {
    const repo = makeGitWorktree('deflection-history');
    toRemove.push(repo.dir);
    repo.write('src/session.ts', 'export const resolveSession = () => null;\n');
    const sha = fixtureCommit(repo.dir, 'resolveSession returns null on a miss\n\nCallers treat null as logged out.');

    const attempt = attemptDeflection(anchor('resolveSession', 'miss'), context({ repository: repo.dir }));

    expect(attempt.match?.source).toBe('git_history');
    expect(attempt.match?.evidence).toBe(sha.slice(0, 12));
    expect(attempt.match?.answer).toBe(`commit ${sha.slice(0, 12)}: resolveSession returns null on a miss`);
    expect(attempt.consulted.map((entry) => entry.outcome)).toStrictEqual(['no_match', 'matched', 'not_consulted']);
  });

  it('deflects from the committer’s note on a merge commit, which is where a run records its decisions', () => {
    const repo = makeGitWorktree('deflection-note');
    toRemove.push(repo.dir);
    fixtureGit(repo.dir, ['notes', `--ref=${NOTE_REF}`, 'add', '-m', 'Decided: widgetCache is per process.', 'HEAD']);

    const attempt = attemptDeflection(anchor('widgetCache', 'process'), context({ repository: repo.dir }));
    expect(attempt.match?.source).toBe('git_history');
    expect(attempt.match?.answer).toContain('Decided: widgetCache is per process.');
  });

  it('does not deflect from a commit naming the symbol about a different aspect', () => {
    const repo = repositoryWithCommits(['resolveSession returns null on a miss']);
    expect(attemptDeflection(anchor('resolveSession', 'retry'), context({ repository: repo })).match).toBeNull();
  });

  it('does not deflect from a commit that names only a longer symbol, though git’s own search finds it', () => {
    const repo = repositoryWithCommits(['resolveSessionCache is cleared on a miss']);
    // The prefilter is a substring search and does find it — so the refusal below is the anchor
    // comparison's, not git's, which is the half of the design this test exists to pin.
    expect(searchCommitHistory(repo, 'resolveSession').commits).toHaveLength(1);
    expect(attemptDeflection(anchor('resolveSession', 'miss'), context({ repository: repo })).match).toBeNull();
  });

  it('pages past one search’s cap, so a match older than the newest page is still found', () => {
    // The oldest commit is the answer; every newer one mentions only a longer symbol the prefilter
    // also returns, filling the whole first page with candidates the anchor comparison rejects.
    const messages = [
      'resolveSession returns null on a miss',
      ...Array.from({ length: DEFAULT_COMMIT_SEARCH_LIMIT + 5 }, (_, n) => `resolveSessionCache tweak ${String(n)}`),
    ];
    const repo = repositoryWithCommits(messages);
    const attempt = attemptDeflection(anchor('resolveSession', 'miss'), context({ repository: repo }));
    expect(attempt.match?.answer).toMatch(/: resolveSession returns null on a miss$/);
  });

  it('says git could not answer for a path that is not a repository, rather than "no commit names it"', () => {
    const plain = join(home, 'not-a-repository');
    mkdirSync(plain);
    const search = searchCommitHistory(plain, 'resolveSession');
    expect(search.commits).toStrictEqual([]);
    expect(search.failure).toMatch(/git log could not search/);

    const attempt = attemptDeflection(anchor('resolveSession', 'miss'), context({ repository: plain }));
    expect(attempt.match).toBeNull();
    expect(attempt.consulted[1]?.outcome).toBe('no_match');
    expect(attempt.consulted[1]?.detail).toMatch(/^History was not searched/);
    expect(attempt.consulted[1]?.unreadable).toStrictEqual([plain]);
  });
});

describe('searchCommitHistory’s options do what they say', () => {
  it('pages with limit and skip, newest first', () => {
    const repo = repositoryWithCommits(['widgetCache one', 'widgetCache two', 'widgetCache three']);
    expect(searchCommitHistory(repo, 'widgetCache', { limit: 2 }).commits.map((c) => c.message)).toStrictEqual([
      'widgetCache three',
      'widgetCache two',
    ]);
    expect(searchCommitHistory(repo, 'widgetCache', { limit: 2, skip: 2 }).commits.map((c) => c.message)).toStrictEqual([
      'widgetCache one',
    ]);
  });

  it('searches a note only when its ref is named', () => {
    const repo = repositoryWithCommits(['an unrelated subject']);
    fixtureGit(repo, ['notes', `--ref=${NOTE_REF}`, 'add', '-m', 'widgetCache is per process', 'HEAD']);
    expect(searchCommitHistory(repo, 'widgetCache').commits).toStrictEqual([]);
    const withNotes = searchCommitHistory(repo, 'widgetCache', { notesRef: NOTE_REF }).commits;
    expect(withNotes.map((commit) => commit.note)).toStrictEqual(['widgetCache is per process']);
  });

  it('refuses a limit or skip that is not a whole count, instead of searching something else', () => {
    const repo = repositoryWithCommits(['widgetCache one']);
    expect(() => searchCommitHistory(repo, 'widgetCache', { limit: 0 })).toThrow(RangeError);
    expect(() => searchCommitHistory(repo, 'widgetCache', { limit: 1.5 })).toThrow(RangeError);
    expect(() => searchCommitHistory(repo, 'widgetCache', { skip: -1 })).toThrow(RangeError);
  });

  it('refuses a needle with a line break, which git would split into several patterns', () => {
    const repo = repositoryWithCommits(['widgetCache one']);
    const search = searchCommitHistory(repo, 'widgetCache\none');
    expect(search.commits).toStrictEqual([]);
    expect(search.failure).toMatch(/line break/);
  });
});

/** A prior run whose ledger carries one decision, appended by the real reconciler answering a question. */
const runWithDecision = (reconciler: Reconciler, prompt: string, answer: string): string => {
  const run = reconciler.acceptFeature(makePlan()).run;
  reconciler.ask(run, aDraft({ prompt }));
  reconciler.answer(run, answer);
  return run;
};

const SCHEMA_EXTRAS = anchor('StepOutputSchema', 'unknown fields');

/** One `decision.recorded` payload in `decision.ts`'s shape, for the shapes a test reconciler cannot make. */
const aDecision = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  question_id: 'q-01J9ZX00-00000000-00000000-00',
  question: 'Should StepOutputSchema reject unknown fields?',
  answer: 'reject them',
  option_id: null,
  resolver: 'tui',
  principal_kind: 'user',
  principal_id: 'deep',
  resolved_at: '2026-09-20T10:00:00.000Z',
  ...overrides,
});

/** A run whose log is exactly these decision lines, each a whole AD-5 envelope. */
const runWithLedger = (decisions: readonly Record<string, unknown>[]): string => {
  const run = mintRunId();
  const paths = runPaths(run, home);
  mkdirSync(paths.runDir, { recursive: true });
  const lines = decisions.map((payload, index) =>
    JSON.stringify({
      ts: '2026-09-23T10:00:00.000Z',
      seq: index + 1,
      feature: 'engine-reconciler',
      run,
      step: null,
      emitter: 'engine',
      type: 'decision.recorded',
      payload,
    }),
  );
  writeFileSync(paths.eventLog, `${lines.join('\n')}\n`, 'utf8');
  return run;
};

describe('a question whose anchor a recorded decision names is deflected from the ledger (matrix 7)', () => {
  it('deflects with source decision_ledger, naming the run the decision came from', () => {
    const reconciler = openReconciler();
    const prior = runWithDecision(reconciler, 'Should StepOutputSchema reject unknown fields?', 'reject them');

    const attempt = attemptDeflection(SCHEMA_EXTRAS, context({ ledgerRuns: [prior] }));

    expect(attempt.match?.source).toBe('decision_ledger');
    expect(attempt.match?.run).toBe(prior);
    expect(attempt.match?.evidence).toBe(prior);
    expect(attempt.match?.answer).toMatch(new RegExp(`^decided in run ${prior} \\(question q-[^)]+\\): reject them$`));
  });

  it('takes the newest decision when two runs decided about the same anchor', () => {
    const reconciler = openReconciler();
    const older = runWithDecision(reconciler, 'Does StepOutputSchema allow unknown fields?', 'no');
    const newer = runWithDecision(reconciler, 'Does StepOutputSchema allow unknown fields now?', 'yes, loosely');
    const attempt = attemptDeflection(SCHEMA_EXTRAS, context({ ledgerRuns: [older, newer] }));
    expect(attempt.match?.run).toBe(newer);
    expect(attempt.match?.answer).toContain('yes, loosely');
  });

  it('orders by each decision’s own resolved_at, not by the order the runs were listed in', () => {
    const newer = runWithLedger([aDecision({ answer: 'allow them', resolved_at: '2026-09-22T10:00:00.000Z' })]);
    const older = runWithLedger([aDecision({ answer: 'reject them', resolved_at: '2026-09-20T10:00:00.000Z' })]);
    const attempt = attemptDeflection(SCHEMA_EXTRAS, context({ ledgerRuns: [newer, older] }));
    expect(attempt.match?.run).toBe(newer);
    expect(attempt.match?.answer).toContain('allow them');
  });

  it('does not deflect from a decision about a longer symbol with the same prefix', () => {
    const reconciler = openReconciler();
    const prior = runWithDecision(reconciler, 'Should StepOutputSchemaV2 reject unknown fields?', 'reject them');
    expect(attemptDeflection(SCHEMA_EXTRAS, context({ ledgerRuns: [prior] })).match).toBeNull();
  });

  it('does not deflect from a decision about the same symbol and a different aspect', () => {
    const prior = runWithLedger([aDecision({ question: 'Should StepOutputSchema be versioned?', answer: 'yes' })]);
    expect(attemptDeflection(SCHEMA_EXTRAS, context({ ledgerRuns: [prior] })).match).toBeNull();
  });

  it('reads only the runs it is given, so another project’s decision never answers this one', () => {
    const reconciler = openReconciler();
    runWithDecision(reconciler, 'Should StepOutputSchema reject unknown fields?', 'reject them');
    expect(attemptDeflection(SCHEMA_EXTRAS, context({ ledgerRuns: [] })).match).toBeNull();
  });
});

describe('a timeout default is not a decision anybody made (matrix 19)', () => {
  it('never deflects from a timeout_default line', () => {
    const prior = runWithLedger([aDecision({ resolver: 'timeout_default', principal_kind: 'timeout' })]);
    const attempt = attemptDeflection(SCHEMA_EXTRAS, context({ ledgerRuns: [prior] }));
    expect(attempt.match).toBeNull();
    expect(attempt.consulted[2]?.detail).toContain('1 timeout default(s) were not counted as decisions');
  });

  it('lets an older decision a person made stand when only a newer timeout followed it', () => {
    const prior = runWithLedger([
      aDecision({ answer: 'reject them', resolved_at: '2026-09-20T10:00:00.000Z' }),
      aDecision({ answer: 'allow them', resolver: 'timeout_default', resolved_at: '2026-09-22T10:00:00.000Z' }),
    ]);
    expect(attemptDeflection(SCHEMA_EXTRAS, context({ ledgerRuns: [prior] })).match?.answer).toContain('reject them');
  });
});

describe('a newest decision that cannot be shown is not replaced by an older one (matrix 20)', () => {
  it('reports no match when the newest decision’s answer was rewritten by redaction', () => {
    const prior = runWithLedger([
      aDecision({ answer: 'reject them', resolved_at: '2026-09-20T10:00:00.000Z' }),
      aDecision({ answer: '[redacted]', redacted_fields: 'answer', resolved_at: '2026-09-22T10:00:00.000Z' }),
    ]);
    const attempt = attemptDeflection(SCHEMA_EXTRAS, context({ ledgerRuns: [prior] }));
    expect(attempt.match).toBeNull();
    expect(attempt.consulted[2]?.detail).toContain('superseded are not used in its place');
  });

  it('reports no match when the newest decision recorded a blank answer', () => {
    const prior = runWithLedger([
      aDecision({ answer: 'reject them', resolved_at: '2026-09-20T10:00:00.000Z' }),
      aDecision({ answer: '   ', resolved_at: '2026-09-22T10:00:00.000Z' }),
    ]);
    expect(attemptDeflection(SCHEMA_EXTRAS, context({ ledgerRuns: [prior] })).match).toBeNull();
  });

  it('still deflects from a newest decision when only an older one was redacted', () => {
    const prior = runWithLedger([
      aDecision({ answer: '[redacted]', redacted_fields: 'answer', resolved_at: '2026-09-20T10:00:00.000Z' }),
      aDecision({ answer: 'reject them', resolved_at: '2026-09-22T10:00:00.000Z' }),
    ]);
    expect(attemptDeflection(SCHEMA_EXTRAS, context({ ledgerRuns: [prior] })).match?.answer).toContain('reject them');
  });
});

describe('a question matching nothing is not deflected and passes through unchanged (matrix 8)', () => {
  it('reports no match from every source, and never throws', () => {
    const repo = repositoryWith(CLAUDE_MD);
    const attempt = attemptDeflection(anchor('unheardOfSymbol', 'visibility'), context({ repository: repo }));
    expect(attempt.match).toBeNull();
    expect(attempt.consulted.map((entry) => entry.source)).toStrictEqual([...DEFLECTION_SOURCES]);
    expect(attempt.consulted.every((entry) => entry.outcome === 'no_match')).toBe(true);
  });

  it('passes the draft on to be asked exactly as it was raised', () => {
    const draft = aDraft({ prompt: 'Should unheardOfSymbol be public?' });
    const compressed = compressQuestions(
      [{ draft, anchor: anchor('unheardOfSymbol', 'visibility'), step: 'implement' }],
      context({ repository: repositoryWith(CLAUDE_MD) }),
    );
    expect(compressed.deflected).toStrictEqual([]);
    expect(compressed.unanswered).toHaveLength(1);
    expect(compressed.toAsk).toHaveLength(1);
    expect(compressed.toAsk[0]?.draft).toStrictEqual(draft);
  });
});

/** Every name each new module imports, as `name <- source`, read from the code with comments stripped. */
const importedNames = (source: string): readonly string[] => {
  const names: string[] = [];
  for (const match of source.matchAll(/import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+'([^']+)'/g)) {
    for (const name of (match[1] ?? '').split(',').map((part) => part.trim()).filter((part) => part !== '')) {
      names.push(`${name} <- ${match[2] ?? ''}`);
    }
  }
  return names;
};

describe('a constructed deflection goes through the existing compare-and-set and nothing else (matrix 12)', () => {
  const askOne = (): { run: string; questionId: string } => {
    const run = mintRunId();
    const questionId = mintQuestionId(mintRunId());
    askQuestion({ paths: runPaths(run, home), questionId, feature: 'engine-reconciler', draft: aDraft() });
    return { run, questionId };
  };

  const aMatch: DeflectionMatch = {
    source: 'repository',
    anchor: UNREGISTERED,
    answer: 'CLAUDE.md: resolveProject returns null for an unregistered path.',
    evidence: 'CLAUDE.md',
    run: null,
  };

  it('lands as the outcome file AD-25 contends on, holding exactly the constructed deflection', () => {
    const { run, questionId } = askOne();
    const deflection = constructDeflection(aMatch, new Date('2026-09-23T10:00:00.000Z'));
    expect(deflection.anchor).toBe('resolveProject:unregistered');
    const claim = applyDeflection(runPaths(run, home), questionId, deflection);

    expect(claim.accepted).toBe(true);
    expect(claim.created).toBe(true);
    const paths = questionPaths(runPaths(run, home), questionId);
    // The outcome file exists and carries the deflection unchanged: only the compare-and-set writes it.
    expect(existsSync(join(paths.dir, QUESTION_OUTCOME_FILE_NAME))).toBe(true);
    expect(readQuestionOutcome(paths)?.deflection).toStrictEqual(deflection);
    expect(readQuestionOutcome(paths)?.resolution).toBeNull();
    expect(readQuestionState(paths).status).toBe('deflected');
    expect(readQuestionState(paths).deflection).toStrictEqual(deflection);
  });

  it('loses to an answer that got there first, writing nothing of its own', () => {
    const { run, questionId } = askOne();
    const paths = runPaths(run, home);
    attemptQuestionResolution(
      paths,
      questionId,
      questionResolution({ resolver: 'tui', principal: { kind: 'user', id: 'deep' }, answer: 'throw', optionId: 'throw' }),
    );
    const before = readFileSync(questionPaths(paths, questionId).outcome, 'utf8');

    const claim = applyDeflection(paths, questionId, constructDeflection(aMatch));

    expect(claim.accepted).toBe(false);
    expect(claim.state.status).toBe('resolved');
    expect(readFileSync(questionPaths(paths, questionId).outcome, 'utf8')).toBe(before);
  });

  it('has no second write path: every name the new modules import is on a reviewed list of readers', () => {
    /**
     * A positive list rather than a list of forbidden writers. A forbidden-names list passes any writer it
     * did not think to name — a new runtime helper, a re-export under another name — while this fails on
     * *any* name nobody reviewed. `../contracts/` is exempt because it holds schemas and pure functions
     * only; everything reached from the engine and the runtime is named, and the only question-state
     * transition among them is `attemptQuestionDeflection`.
     */
    const REVIEWED = new Set([
      'DEFAULT_COMMIT_SEARCH_LIMIT <- ../runtime/index.js',
      'EventLogCorruptError <- ../runtime/index.js',
      'UnsafePathSegmentError <- ../runtime/index.js',
      'readEventLog <- ../runtime/index.js',
      'runPaths <- ../runtime/index.js',
      'searchCommitHistory <- ../runtime/index.js',
      'RunPaths <- ../runtime/index.js',
      'ConventionsUnreadable <- ./conventions.js',
      'conventionsSpeakingTo <- ./conventions.js',
      'mentionsSymbol <- ./conventions.js',
      'readConventions <- ./conventions.js',
      'RepositoryConventions <- ./conventions.js',
      'decisionsInLog <- ./decision.js',
      'QUESTION_ID_PAYLOAD_KEY <- ./questions.js',
      'REDACTED_FIELDS_PAYLOAD_KEY <- ./questions.js',
      'QUESTION_EVENT_TYPES <- ./questions.js',
      'QuestionClaim <- ./questions.js',
      'QuestionDraftRefused <- ./questions.js',
      'assertAskableDraft <- ./questions.js',
      'attemptQuestionDeflection <- ./questions.js',
      'criterionEditedPayload <- ./reconciler.js',
      'FeaturePlan <- ./rebuild.js',
    ]);
    const OWN = ['./deflection.js', './question-merge.js', './deflection-rate.js', './interviewer.js'];
    const modules = ['deflection.ts', 'interviewer.ts', 'question-merge.ts', 'deflection-rate.ts'];
    let transitions = 0;
    for (const module of modules) {
      const source = stripComments(readFileSync(new URL(`../src/engine/${module}`, import.meta.url), 'utf8'));
      expect({ module, fs: source.includes("from 'node:") }).toStrictEqual({ module, fs: false });
      const unreviewed = importedNames(source).filter(
        (entry) =>
          !REVIEWED.has(entry) &&
          !entry.endsWith('<- ../contracts/index.js') &&
          !OWN.some((own) => entry.endsWith(`<- ${own}`)),
      );
      expect({ module, unreviewed }).toStrictEqual({ module, unreviewed: [] });
      transitions += (source.match(/\battemptQuestionDeflection\(/g) ?? []).length;
    }
    // Exactly one call site, in `applyDeflection`.
    expect(transitions).toBe(1);
  });
});

describe('a prior run whose log is unreadable or absent is no match, never a thrown error (matrix 15)', () => {
  it('skips an absent run, a corrupt log, a log that is a directory and an unsafe run id, and still finds the good one', () => {
    const reconciler = openReconciler();
    const good = runWithDecision(reconciler, 'Should StepOutputSchema reject unknown fields?', 'reject them');

    const absent = mintRunId();
    const corrupt = mintRunId();
    mkdirSync(runPaths(corrupt, home).runDir, { recursive: true });
    writeFileSync(runPaths(corrupt, home).eventLog, 'this is not json\n', 'utf8');
    const directory = mintRunId();
    mkdirSync(runPaths(directory, home).eventLog, { recursive: true });

    const attempt = attemptDeflection(SCHEMA_EXTRAS, context({ ledgerRuns: [absent, corrupt, directory, '../escape', good] }));

    expect(attempt.match?.run).toBe(good);
    const ledger = attempt.consulted.find((entry) => entry.source === 'decision_ledger');
    expect(ledger?.unreadable).toStrictEqual([corrupt, directory, '../escape']);
  });

  it('lets the question through to be asked when every ledger run is unreadable', () => {
    const corrupt = mintRunId();
    mkdirSync(runPaths(corrupt, home).runDir, { recursive: true });
    writeFileSync(runPaths(corrupt, home).eventLog, '{"torn":', 'utf8');

    const compressed = compressQuestions(
      [{ draft: aDraft(), anchor: SCHEMA_EXTRAS, step: null }],
      context({ ledgerRuns: [corrupt] }),
    );
    expect(compressed.deflected).toStrictEqual([]);
    expect(compressed.toAsk).toHaveLength(1);
    expect(compressed.unanswered[0]?.consulted[2]?.outcome).toBe('no_match');
    expect(compressed.unanswered[0]?.consulted[2]?.unreadable).toStrictEqual([corrupt]);
  });
});
