/**
 * CAP-2 — the spec echo: a request read back as criteria, and a person's answer turned into the plan's.
 *
 * Matrix rows 1–4 and 24–26, and the one entry point question compression is reached by. What is tested is the
 * logic a live Interviewer turn calls into. The live turn itself — a multi-turn `claude -p` conversation
 * a person answers in a terminal — is not exercised here or anywhere in this suite, and nothing below
 * scripts one: a fixture that fed canned lines to these functions and called itself an interview would
 * be claiming coverage of a boundary it never crossed.
 *
 * Amendments are written in the words the TUI card produces (`editCriterionArgument`) and in the bare
 * `N: …` a person actually types, because both reach the reconciler's one parser and this module reuses
 * it rather than keeping a grammar of its own.
 */
import { rmSync } from 'node:fs';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { QuestionDraft } from '../src/contracts/index.js';
import { specRecordedPayload, compressQuestions, composeSpecEcho, confirmSpecEcho, planFromSpec } from '../src/engine/index.js';
import type { ConfirmedSpec, SpecConfirmation } from '../src/engine/index.js';
import { editCriterionArgument } from '../src/tui/cards/spec-echo.js';

import { makeGitWorktree, makeHome, makePlan } from './helpers/engine-fixture.js';

const REQUEST =
  'Add a --dry-run flag to orch init:\n- it accepts --dry-run\n- it prints every file it would write\n- it writes nothing';

const confirmed = (result: SpecConfirmation): ConfirmedSpec => {
  if (!result.accepted) throw new Error(`expected a confirmed spec, was refused: ${result.refusal}`);
  return result;
};

describe('a raw request is composed into candidate criteria, the request carried verbatim (matrix 1)', () => {
  it('carries the request byte for byte beside the criteria', () => {
    const echo = composeSpecEcho(REQUEST);
    expect(echo.request).toBe(REQUEST);
  });

  it('takes a list’s items as the criteria, leaving the lead-in in the request rather than the list', () => {
    const echo = composeSpecEcho(REQUEST);
    expect(echo.criteria).toStrictEqual([
      'it accepts --dry-run',
      'it prints every file it would write',
      'it writes nothing',
    ]);
    // One sentence with a full stop inside is one criterion: splitting it would be interpretation.
    expect(composeSpecEcho('Cache the lookup. Invalidate it on write.').criteria).toStrictEqual([
      'Cache the lookup. Invalidate it on write.',
    ]);
  });

  it('never splits a sentence that wraps across lines, in a list item or in plain paragraphs', () => {
    expect(composeSpecEcho('- it prints every file\n  it would write\n- it writes nothing').criteria).toStrictEqual([
      'it prints every file it would write',
      'it writes nothing',
    ]);
    expect(composeSpecEcho('Cache the lookup and\ninvalidate it on write.\n\nLog every miss.').criteria).toStrictEqual([
      'Cache the lookup and invalidate it on write.',
      'Log every miss.',
    ]);
  });

  it('does not read a year opening a line as a list marker', () => {
    expect(composeSpecEcho('2026. The flag ships in the autumn release.').criteria).toStrictEqual([
      '2026. The flag ships in the autumn release.',
    ]);
  });

  it('falls back to the request’s own criteria when the turn drafted none, or only blanks', () => {
    const own = composeSpecEcho(REQUEST).criteria;
    expect(composeSpecEcho(REQUEST, []).criteria).toStrictEqual(own);
    expect(composeSpecEcho(REQUEST, ['', '  ']).criteria).toStrictEqual(own);
  });

  it('uses the live turn’s drafted criteria when it wrote some, trimming and dropping blank lines', () => {
    const echo = composeSpecEcho(REQUEST, ['  orch init --dry-run lists every file  ', '', 'no file is written']);
    expect(echo.request).toBe(REQUEST);
    expect(echo.criteria).toStrictEqual(['orch init --dry-run lists every file', 'no file is written']);
  });
});

describe('an unedited confirmation is the candidate list exactly (matrix 2)', () => {
  it('makes the plan’s acceptance_criteria the candidate list, in order', () => {
    const echo = composeSpecEcho(REQUEST);
    const spec = confirmed(confirmSpecEcho(echo, { kind: 'confirm' }));
    expect(spec.acceptance_criteria).toStrictEqual(echo.criteria);
    expect(spec.edits).toStrictEqual([]);

    const plan = planFromSpec(makePlan(), spec);
    expect(plan.acceptance_criteria).toStrictEqual(echo.criteria);
    expect(plan.request).toBe(REQUEST);
  });

  it('builds a plan whose spec.recorded payload is the confirmed request and criteria, untouched', () => {
    const spec = confirmed(confirmSpecEcho(composeSpecEcho(REQUEST), { kind: 'confirm' }));
    expect(specRecordedPayload(planFromSpec(makePlan(), spec))).toStrictEqual({
      request: REQUEST,
      acceptance_criteria: [
        'it accepts --dry-run',
        'it prints every file it would write',
        'it writes nothing',
      ],
    });
  });
});

describe('editing one line changes that line alone, attributably (matrix 3)', () => {
  it('replaces only the named criterion, in the card’s own amendment wording', () => {
    const echo = composeSpecEcho(REQUEST);
    const spec = confirmed(
      confirmSpecEcho(echo, { kind: 'amend', amendments: [editCriterionArgument(2, 'it prints each path and its size')] }),
    );
    expect(spec.acceptance_criteria).toStrictEqual([
      'it accepts --dry-run',
      'it prints each path and its size',
      'it writes nothing',
    ]);
    // Attributable in `spec.criterion_edited`'s own shape: which line, and the words given.
    expect(spec.edits).toStrictEqual([{ line: 2, text: 'it prints each path and its size' }]);
  });

  it('reads the bare "N: wording" a person types, through the same parser the reconciler uses', () => {
    const spec = confirmed(
      confirmSpecEcho(composeSpecEcho(REQUEST), { kind: 'amend', amendments: ['3: it writes nothing, not even a lock'] }),
    );
    expect(spec.acceptance_criteria[2]).toBe('it writes nothing, not even a lock');
    expect(spec.acceptance_criteria.slice(0, 2)).toStrictEqual(composeSpecEcho(REQUEST).criteria.slice(0, 2));
  });

  it('refuses an amendment that names no line, rather than choosing one for it', () => {
    const result = confirmSpecEcho(composeSpecEcho(REQUEST), { kind: 'amend', amendments: ['make it faster'] });
    expect(result.accepted).toBe(false);
    if (!result.accepted) expect(result.refusal).toContain('give a number from 1 to 3');
  });
});

/** The refusal an answer produced, failing the test if it was accepted instead. */
const refusalOf = (result: SpecConfirmation): string => {
  if (result.accepted) throw new Error('expected a refusal, was accepted');
  return result.refusal;
};

describe('an amendment outside 1..n is refused as a result, never thrown (matrix 24)', () => {
  it.each(['0: reword', '-1: reword', '4: reword', '99999999999999999999: reword'])(
    'refuses "%s" for a three-criterion echo',
    (amendment) => {
      const answer = (): SpecConfirmation => confirmSpecEcho(composeSpecEcho(REQUEST), { kind: 'amend', amendments: [amendment] });
      expect(answer).not.toThrow();
      expect(refusalOf(answer())).toContain('does not name a criterion the echo has; give a number from 1 to 3');
    },
  );

  it('refuses the same line reworded twice, rather than silently keeping the later wording', () => {
    const result = confirmSpecEcho(composeSpecEcho(REQUEST), { kind: 'amend', amendments: ['2: first', '2: second'] });
    expect(refusalOf(result)).toBe('Criterion 2 is changed twice; say which wording stands.');
  });
});

describe('an amendment with no wording is refused, naming what is missing (matrix 25)', () => {
  it.each(['3:', '3: ', 'criterion 3:'])('refuses "%s"', (amendment) => {
    expect(refusalOf(confirmSpecEcho(composeSpecEcho(REQUEST), { kind: 'amend', amendments: [amendment] }))).toBe(
      'The amendment names criterion 3 but gives no wording for it.',
    );
  });

  it('refuses a blank added criterion', () => {
    expect(refusalOf(confirmSpecEcho(composeSpecEcho(REQUEST), { kind: 'amend', additions: ['  '] }))).toContain(
      'An added criterion has no wording',
    );
  });
});

describe('an echo can gain or lose a criterion, not only reword one (matrix 26)', () => {
  it('gives an empty echo a path to a confirmed spec by adding a criterion', () => {
    const empty = composeSpecEcho('');
    expect(empty.criteria).toStrictEqual([]);
    const spec = confirmed(confirmSpecEcho(empty, { kind: 'amend', additions: ['orch init --dry-run writes nothing'] }));
    expect(spec.acceptance_criteria).toStrictEqual(['orch init --dry-run writes nothing']);
    expect(spec.added).toStrictEqual(['orch init --dry-run writes nothing']);
  });

  it('tells a person amending an empty echo to add rather than reword', () => {
    expect(refusalOf(confirmSpecEcho(composeSpecEcho(''), { kind: 'amend', amendments: ['1: something'] }))).toContain(
      'the echo has no criteria to change; state a new one as an addition',
    );
  });

  it('removes a line by its number as shown, and appends additions after the surviving lines', () => {
    const spec = confirmed(
      confirmSpecEcho(composeSpecEcho(REQUEST), {
        kind: 'amend',
        amendments: ['3: it writes nothing, not even a lock'],
        removals: [1],
        additions: ['it exits 0'],
      }),
    );
    expect(spec.acceptance_criteria).toStrictEqual([
      'it prints every file it would write',
      'it writes nothing, not even a lock',
      'it exits 0',
    ]);
    expect(spec.removed).toStrictEqual([1]);
    expect(spec.edits).toStrictEqual([{ line: 3, text: 'it writes nothing, not even a lock' }]);
  });

  it('refuses a removal outside the echo, and a line both reworded and removed', () => {
    expect(refusalOf(confirmSpecEcho(composeSpecEcho(REQUEST), { kind: 'amend', removals: [0] }))).toContain(
      'Removal of criterion 0',
    );
    expect(
      refusalOf(confirmSpecEcho(composeSpecEcho(REQUEST), { kind: 'amend', amendments: ['2: x'], removals: [2] })),
    ).toContain('Criterion 2 is changed twice');
  });

  it('refuses removing every criterion, which leaves nothing anyone confirmed', () => {
    expect(
      refusalOf(confirmSpecEcho(composeSpecEcho(REQUEST), { kind: 'amend', removals: [1, 2, 3] })),
    ).toContain('no acceptance criteria to confirm');
  });
});

describe('a confirmation with no criteria is refused (matrix 4)', () => {
  it('refuses to confirm an empty list, because nobody confirmed a spec', () => {
    const result = confirmSpecEcho(composeSpecEcho('   \n\n'), { kind: 'confirm' });
    expect(result.accepted).toBe(false);
    if (!result.accepted) expect(result.refusal).toContain('no acceptance criteria to confirm');
  });

  it('refuses when neither the turn nor the request states a criterion', () => {
    expect(confirmSpecEcho(composeSpecEcho('  \n', ['', '  ']), { kind: 'confirm' }).accepted).toBe(false);
  });
});

describe('question compression deflects what the sources answer and merges the rest before asking', () => {
  let home: string;
  const toRemove: string[] = [];
  beforeEach(() => {
    home = makeHome('engine-interviewer');
    toRemove.push(home);
  });
  afterEach(() => {
    for (const dir of toRemove.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  const aDraft = (prompt: string): QuestionDraft => ({
    prompt,
    brief: 'Two subagents reached the same undecided point.',
    options: [
      { id: 'yes', label: 'Yes', consequence: 'It is done.' },
      { id: 'no', label: 'No', consequence: 'It is not.' },
    ],
    escape: { id: 'later', label: 'Ask me later', consequence: 'The step waits.' },
    recommended_option_id: 'no',
    default_action: 'It is not done.',
    default_window_ms: 60_000,
  });

  const UNREGISTERED = { symbol: 'resolveProject', aspect: 'unregistered' };
  const CACHE_SCOPE = { symbol: 'widgetCache', aspect: 'process' };
  const ROTATION = { symbol: 'sessionKey', aspect: 'rotation' };

  it('deflects the answered question, merges the two sharing an anchor, and leaves one card to ask', () => {
    const repo = makeGitWorktree('interviewer');
    toRemove.push(repo.dir);
    repo.write('CLAUDE.md', 'resolveProject returns null for an unregistered path.\n');
    const at = new Date('2026-09-23T12:00:00.000Z');

    const compressed = compressQuestions(
      [
        { draft: aDraft('Should resolveProject throw?'), anchor: UNREGISTERED, step: 'implement' },
        { draft: aDraft('Should widgetCache be per process?'), anchor: CACHE_SCOPE, step: 'implement' },
        { draft: aDraft('Is widgetCache shared across runs?'), anchor: CACHE_SCOPE, step: 'verify' },
        { draft: { ...aDraft('Is sessionKey rotated?'), default_window_ms: 0 }, anchor: ROTATION, step: 'verify' },
      ],
      { repository: repo.dir, orchHome: home, ledgerRuns: [] },
      { now: () => at },
    );

    expect(compressed.deflected).toHaveLength(1);
    expect(compressed.deflected[0]?.deflection).toStrictEqual({
      source: 'repository',
      anchor: 'resolveProject:unregistered',
      answer: 'CLAUDE.md: resolveProject returns null for an unregistered path.',
      deflected_at: '2026-09-23T12:00:00.000Z',
    });
    expect(compressed.toAsk).toHaveLength(1);
    expect(compressed.toAsk[0]?.anchors).toStrictEqual([CACHE_SCOPE]);
    expect(compressed.toAsk[0]?.raised).toHaveLength(2);
    expect(compressed.awaitingJudgment).toStrictEqual([]);
    // The zero-window draft is refused on its own; it cost the batch nothing (matrix 21).
    expect(compressed.refused.map((refusal) => refusal.field)).toStrictEqual(['default_window_ms']);
  });
});
