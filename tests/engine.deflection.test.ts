/**
 * Q4 — a question is attempted against the repository, git history and the decision ledger first.
 *
 * Matrix rows 5–8, 12 and 15. Every source is real: instruction files on disk, commits and notes in a
 * real repository, and `decision.recorded` lines appended by the real reconciler answering a real
 * question — because a ledger line hand-written in this file would prove the matcher agrees with this
 * file, not with `decision.ts`.
 *
 * **Each matching row has a boundary case beside it, and the boundary is the point.** Deflection by
 * anchor is only worth anything if a *different* anchor does not deflect: `resolveProject` must not be
 * answered by a paragraph about `resolveProjectPath`, however alike the two read. A suite that only
 * showed the same-anchor case would pass against a substring matcher, which is the similarity measure
 * this story exists not to build.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DEFLECTION_SOURCES, NOTE_REF } from '../src/contracts/index.js';
import type { QuestionDraft } from '../src/contracts/index.js';
import {
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
  isUsableAnchor,
  mintQuestionId,
  mintRunId,
  questionResolution,
  readQuestionOutcome,
  readQuestionState,
  terminated,
} from '../src/engine/index.js';
import type { DeflectionContext, DeflectionMatch } from '../src/engine/index.js';

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
  for (const dir of toRemove.splice(0)) {
    // A test that removed read permission restores it, so the cleanup can descend.
    try {
      chmodSync(dir, 0o755);
    } catch {
      // Already gone.
    }
    rmSync(dir, { recursive: true, force: true });
  }
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

const aDraft = (overrides: Partial<QuestionDraft> = {}): QuestionDraft => ({
  prompt: 'Should resolveProject throw or return null when the path is not registered?',
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

/** A repository with an instruction file, so the repository source has something to read. */
const repositoryWith = (claudeMd: string): string => {
  const repo = makeGitWorktree('deflection');
  toRemove.push(repo.dir);
  repo.write('CLAUDE.md', claudeMd);
  fixtureCommit(repo.dir, 'add instructions');
  return repo.dir;
};

const CLAUDE_MD = [
  '# Conventions',
  '',
  'Use named exports only.',
  '',
  'resolveProject returns null for an unregistered path, and the installer offers to register it.',
  'Never throw from it: the interview depends on the null.',
  '',
  'Tests are named as sentences about behaviour.',
  '',
].join('\n');

describe('a question whose anchor the repository’s instructions name is deflected (matrix 5)', () => {
  it('deflects with source repository, carrying the anchor and the paragraph that names it', () => {
    const repo = repositoryWith(CLAUDE_MD);
    const attempt = attemptDeflection('resolveProject', context({ repository: repo }));

    expect(attempt.match?.source).toBe('repository');
    expect(attempt.match?.anchor).toBe('resolveProject');
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

  it('reads AGENTS.md as the repository speaking too', () => {
    const repo = makeGitWorktree('deflection-agents');
    toRemove.push(repo.dir);
    repo.write('AGENTS.md', 'The session store is keyed by sessionKey, never by user id.\n');
    const attempt = attemptDeflection('sessionKey', context({ repository: repo.dir }));
    expect(attempt.match?.source).toBe('repository');
    expect(attempt.match?.evidence).toBe('AGENTS.md');
  });

  it('does not deflect a different anchor that merely shares a prefix with a named one', () => {
    const repo = repositoryWith(
      'resolveProjectPath normalises a path before lookup, and it throws on a relative one.\n',
    );
    // Reads alike, names a different symbol: the whole-token rule is what keeps them apart.
    const attempt = attemptDeflection('resolveProject', context({ repository: repo }));
    expect(attempt.match).toBeNull();
    expect(attempt.consulted[0]?.outcome).toBe('no_match');
  });

  it('counts an unreadable instruction file as no match rather than throwing', () => {
    const repo = repositoryWith(CLAUDE_MD);
    chmodSync(join(repo, 'CLAUDE.md'), 0o000);
    try {
      const attempt = attemptDeflection('resolveProject', context({ repository: repo }));
      expect(attempt.consulted[0]?.outcome).toBe('no_match');
      expect(attempt.consulted[0]?.unreadable).toStrictEqual([join(repo, 'CLAUDE.md')]);
    } finally {
      chmodSync(join(repo, 'CLAUDE.md'), 0o644);
    }
  });
});

describe('a question whose anchor git history names is deflected (matrix 6)', () => {
  it('deflects with source git_history from a commit message, naming a short SHA the log can keep', () => {
    const repo = makeGitWorktree('deflection-history');
    toRemove.push(repo.dir);
    repo.write('src/session.ts', 'export const resolveSession = () => null;\n');
    const sha = fixtureCommit(repo.dir, 'resolveSession returns null on a miss\n\nCallers treat null as logged out.');

    const attempt = attemptDeflection('resolveSession', context({ repository: repo.dir }));

    expect(attempt.match?.source).toBe('git_history');
    expect(attempt.match?.evidence).toBe(sha.slice(0, 12));
    expect(attempt.match?.answer).toBe(`commit ${sha.slice(0, 12)}: resolveSession returns null on a miss`);
    expect(attempt.consulted.map((entry) => entry.outcome)).toStrictEqual(['no_match', 'matched', 'not_consulted']);
  });

  it('deflects from the committer’s note on a merge commit, which is where a run records its decisions', () => {
    const repo = makeGitWorktree('deflection-note');
    toRemove.push(repo.dir);
    fixtureGit(repo.dir, ['notes', `--ref=${NOTE_REF}`, 'add', '-m', 'Decided: widgetCache is per process.', 'HEAD']);

    const attempt = attemptDeflection('widgetCache', context({ repository: repo.dir }));
    expect(attempt.match?.source).toBe('git_history');
    expect(attempt.match?.answer).toContain('Decided: widgetCache is per process.');
  });

  it('does not deflect from a commit that names only a longer symbol, though git’s own search finds it', () => {
    const repo = makeGitWorktree('deflection-history-boundary');
    toRemove.push(repo.dir);
    repo.write('src/cache.ts', 'export const resolveSessionCache = new Map();\n');
    fixtureCommit(repo.dir, 'resolveSessionCache is cleared on logout');

    // The prefilter is a substring search and does find it — so the refusal below is the anchor
    // comparison's, not git's, which is the half of the design this test exists to pin.
    expect(searchCommitHistory(repo.dir, 'resolveSession')).toHaveLength(1);
    const attempt = attemptDeflection('resolveSession', context({ repository: repo.dir }));
    expect(attempt.match).toBeNull();
  });

  it('answers with no commits for a path that is not a repository, instead of failing', () => {
    const plain = join(home, 'not-a-repository');
    mkdirSync(plain);
    expect(searchCommitHistory(plain, 'resolveSession')).toStrictEqual([]);
    expect(attemptDeflection('resolveSession', context({ repository: plain })).match).toBeNull();
  });
});

/** A prior run whose ledger carries one decision, appended by the real reconciler answering a question. */
const runWithDecision = (reconciler: Reconciler, prompt: string, answer: string): string => {
  const run = reconciler.acceptFeature(makePlan()).run;
  reconciler.ask(run, aDraft({ prompt }));
  reconciler.answer(run, answer);
  return run;
};

describe('a question whose anchor a recorded decision names is deflected from the ledger (matrix 7)', () => {
  it('deflects with source decision_ledger, naming the run the decision came from', () => {
    const reconciler = openReconciler();
    const prior = runWithDecision(reconciler, 'Should StepOutputSchema reject unknown fields?', 'reject them');

    const attempt = attemptDeflection('StepOutputSchema', context({ ledgerRuns: [prior] }));

    expect(attempt.match?.source).toBe('decision_ledger');
    expect(attempt.match?.run).toBe(prior);
    expect(attempt.match?.evidence).toBe(prior);
    expect(attempt.match?.answer).toMatch(new RegExp(`^decided in run ${prior} \\(question q-[^)]+\\): reject them$`));
  });

  it('takes the newest decision when two runs decided about the same anchor', () => {
    const reconciler = openReconciler();
    const older = runWithDecision(reconciler, 'Does StepOutputSchema allow extras?', 'no');
    const newer = runWithDecision(reconciler, 'Does StepOutputSchema allow extras now?', 'yes, loosely');
    const attempt = attemptDeflection('StepOutputSchema', context({ ledgerRuns: [older, newer] }));
    expect(attempt.match?.run).toBe(newer);
    expect(attempt.match?.answer).toContain('yes, loosely');
  });

  it('does not deflect from a decision about a longer symbol with the same prefix', () => {
    const reconciler = openReconciler();
    const prior = runWithDecision(reconciler, 'Should StepOutputSchemaV2 reject extras?', 'reject them');
    expect(attemptDeflection('StepOutputSchema', context({ ledgerRuns: [prior] })).match).toBeNull();
  });

  it('reads only the runs it is given, so another project’s decision never answers this one', () => {
    const reconciler = openReconciler();
    runWithDecision(reconciler, 'Should StepOutputSchema reject unknown fields?', 'reject them');
    expect(attemptDeflection('StepOutputSchema', context({ ledgerRuns: [] })).match).toBeNull();
  });
});

describe('a question matching nothing is not deflected and passes through unchanged (matrix 8)', () => {
  it('reports no match from every source, and never throws', () => {
    const repo = repositoryWith(CLAUDE_MD);
    const attempt = attemptDeflection('unheardOfSymbol', context({ repository: repo }));
    expect(attempt.match).toBeNull();
    expect(attempt.consulted.map((entry) => entry.source)).toStrictEqual([...DEFLECTION_SOURCES]);
    expect(attempt.consulted.every((entry) => entry.outcome === 'no_match')).toBe(true);
  });

  it('passes the draft on to be asked exactly as it was raised', () => {
    const draft = aDraft({ prompt: 'Should unheardOfSymbol be public?' });
    const compressed = compressQuestions(
      [{ draft, anchor: 'unheardOfSymbol', step: 'implement' }],
      context({ repository: repositoryWith(CLAUDE_MD) }),
    );
    expect(compressed.deflected).toStrictEqual([]);
    expect(compressed.unanswered).toHaveLength(1);
    expect(compressed.toAsk).toHaveLength(1);
    expect(compressed.toAsk[0]?.draft).toStrictEqual(draft);
  });

  it('does not consult any source for an anchor that is blank, padded or a line number', () => {
    for (const anchor of ['', '  resolveProject ', 'src/project.ts:42']) {
      expect(isUsableAnchor(anchor)).toBe(false);
      const attempt = attemptDeflection(anchor, context({ repository: repositoryWith(CLAUDE_MD) }));
      expect(attempt.match).toBeNull();
      expect(attempt.consulted.every((entry) => entry.outcome === 'not_consulted')).toBe(true);
    }
  });
});

describe('a constructed deflection goes through the existing compare-and-set and nothing else (matrix 12)', () => {
  const askOne = (): { run: string; questionId: string } => {
    const run = mintRunId();
    const questionId = mintQuestionId(mintRunId());
    askQuestion({ paths: runPaths(run, home), questionId, feature: 'engine-reconciler', draft: aDraft() });
    return { run, questionId };
  };

  const aMatch: DeflectionMatch = {
    source: 'repository',
    anchor: 'resolveProject',
    answer: 'CLAUDE.md: resolveProject returns null for an unregistered path.',
    evidence: 'CLAUDE.md',
    run: null,
  };

  it('lands as the outcome file AD-25 contends on, holding exactly the constructed deflection', () => {
    const { run, questionId } = askOne();
    const deflection = constructDeflection(aMatch, new Date('2026-09-23T10:00:00.000Z'));
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

  it('has no second write path: the new modules touch no file and reach the question only through attemptQuestionDeflection', () => {
    const modules = ['deflection.ts', 'interviewer.ts', 'question-merge.ts', 'deflection-rate.ts'];
    const forbidden = [
      /from 'node:fs'/,
      /\bwriteFileSync\b/,
      /\brenameSync\b/,
      /\bwriteQuestionState\b/,
      /\bcreateFileExclusively\b/,
      /\bquestionPaths\b/,
      /\bQUESTION_STATE_FILE_NAME\b/,
      /\bQUESTION_OUTCOME_FILE_NAME\b/,
      /\battemptQuestionResolution\b/,
      /\btakeQuestionDefault\b/,
    ];
    let transitions = 0;
    for (const module of modules) {
      const source = stripComments(readFileSync(new URL(`../src/engine/${module}`, import.meta.url), 'utf8'));
      for (const pattern of forbidden) {
        expect({ module, pattern: String(pattern), found: pattern.test(source) }).toStrictEqual({
          module,
          pattern: String(pattern),
          found: false,
        });
      }
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

    const attempt = attemptDeflection(
      'StepOutputSchema',
      context({ ledgerRuns: [absent, corrupt, directory, '../escape', good] }),
    );

    expect(attempt.match?.run).toBe(good);
    const ledger = attempt.consulted.find((entry) => entry.source === 'decision_ledger');
    expect(ledger?.unreadable).toStrictEqual([corrupt, directory, '../escape']);
  });

  it('lets the question through to be asked when every ledger run is unreadable', () => {
    const corrupt = mintRunId();
    mkdirSync(runPaths(corrupt, home).runDir, { recursive: true });
    writeFileSync(runPaths(corrupt, home).eventLog, '{"torn":', 'utf8');

    const compressed = compressQuestions(
      [{ draft: aDraft(), anchor: 'StepOutputSchema', step: null }],
      context({ ledgerRuns: [corrupt] }),
    );
    expect(compressed.deflected).toStrictEqual([]);
    expect(compressed.toAsk).toHaveLength(1);
    expect(compressed.unanswered[0]?.consulted[2]?.outcome).toBe('no_match');
    expect(compressed.unanswered[0]?.consulted[2]?.unreadable).toStrictEqual([corrupt]);
  });
});
