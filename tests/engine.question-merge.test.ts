/**
 * CAP-3 — questions that are one question are merged before any is asked, and Q1 still binds the card.
 *
 * Matrix rows 9–11, 16, 18 and 21–23. The rows that decide whether this suite proves anything are 10 and
 * 18: two questions whose prose is nearly identical but whose anchors differ — in the symbol, or in the
 * aspect of one symbol — must stay two questions. A merge keyed on
 * anything looser than anchor equality — a shared prefix, a similar prompt — passes every same-anchor
 * test and fails that one, which is why it is written against prompts that are the same sentence.
 */
import { describe, expect, it } from 'vitest';

import type { QuestionDraft } from '../src/contracts/index.js';
import {
  MergeJudgmentRefused,
  QuestionDraftRefused,
  assertAskableDraft,
  mergeByAnchor,
  mergeOnJudgment,
  raisedQuestionsStatedIn,
} from '../src/engine/index.js';
import type { RaisedQuestion } from '../src/engine/index.js';

const aDraft = (overrides: Partial<QuestionDraft> = {}): QuestionDraft => ({
  prompt: 'Should resolveProject throw or return null when the path is not registered?',
  brief: 'Throwing makes a missing registration loud; returning null lets the installer offer to register it.',
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

/** A raised question about `symbol`, asking about `aspect` — `unregistered` unless a test says otherwise. */
const raised = (
  symbol: string,
  overrides: Partial<QuestionDraft> = {},
  step: string | null = 'implement',
  aspect = 'unregistered',
): RaisedQuestion => ({ draft: aDraft(overrides), anchor: { symbol, aspect }, step });

describe('two questions sharing one anchor become one question (matrix 9)', () => {
  it('merges them into a single card standing for both', () => {
    const first = raised('resolveProject');
    const second = raised(
      'resolveProject',
      { prompt: 'What does resolveProject do on an unknown path?', brief: 'The test step needs to know what to assert.' },
      'verify',
    );

    const outcome = mergeByAnchor([first, second]);

    expect(outcome.awaitingJudgment).toStrictEqual([]);
    expect(outcome.questions).toHaveLength(1);
    const card = outcome.questions[0];
    expect(card?.basis).toBe('anchor');
    expect(card?.anchors).toStrictEqual([{ symbol: 'resolveProject', aspect: 'unregistered' }]);
    expect(card?.raised).toStrictEqual([first, second]);
    expect(card?.draft.prompt).toBe(first.draft.prompt);
  });

  it('keeps both askers’ briefs and the other prompt, and records why in the brief the log will carry', () => {
    const outcome = mergeByAnchor([
      raised('resolveProject'),
      raised('resolveProject', { prompt: 'What does resolveProject do on an unknown path?', brief: 'The test step needs to know.' }),
    ]);
    const brief = outcome.questions[0]?.draft.brief ?? '';
    expect(brief).toContain('Throwing makes a missing registration loud');
    expect(brief).toContain('The test step needs to know.');
    expect(brief).toContain('Also asked as: "What does resolveProject do on an unknown path?"');
    expect(brief).toContain(
      'This one question stands for 2 raised questions: they share the anchor "resolveProject:unregistered"',
    );
  });

  it('takes the shortest window any asker declared, so no subagent waits past the deadline it set', () => {
    const outcome = mergeByAnchor([
      raised('resolveProject', { default_window_ms: 30 * 60 * 1000 }),
      raised('resolveProject', { default_window_ms: 5 * 60 * 1000 }),
    ]);
    expect(outcome.questions[0]?.draft.default_window_ms).toBe(5 * 60 * 1000);
  });

  it('unions the options by id, keeping the card within three', () => {
    const outcome = mergeByAnchor([
      raised('resolveProject'),
      raised('resolveProject', {
        options: [
          { id: 'null', label: 'Return null', consequence: 'The installer can offer to register the path.' },
          { id: 'register', label: 'Register it', consequence: 'The path is registered on first use.' },
        ],
      }),
    ]);
    expect(outcome.questions[0]?.draft.options.map((option) => option.id)).toStrictEqual(['throw', 'null', 'register']);
  });
});

describe('two questions on different anchors are not merged, however alike they read (matrix 10)', () => {
  it('keeps same-prose questions about a symbol and its longer namesake apart', () => {
    // The same sentence, word for word, save the symbol. Prose similarity is total; anchors differ.
    const outcome = mergeByAnchor([
      raised('resolveProject', { prompt: 'Should resolveProject throw on a miss?' }),
      raised('resolveProjectPath', { prompt: 'Should resolveProjectPath throw on a miss?' }),
    ]);
    expect(outcome.questions).toHaveLength(2);
    expect(outcome.questions.map((card) => card.basis)).toStrictEqual(['single', 'single']);
    expect(outcome.questions.map((card) => card.anchors.map((a) => a.symbol))).toStrictEqual([
      ['resolveProject'],
      ['resolveProjectPath'],
    ]);
  });

  it('keeps two questions about one symbol apart when they ask about different aspects (matrix 18)', () => {
    const outcome = mergeByAnchor([
      raised('resolveProject', {}, 'implement', 'unregistered'),
      raised('resolveProject', {}, 'verify', 'caching'),
    ]);
    expect(outcome.questions).toHaveLength(2);
    expect(outcome.questions.map((card) => card.anchors[0]?.aspect)).toStrictEqual(['unregistered', 'caching']);
  });

  it('does not confuse two anchors whose joined display form is the same', () => {
    // "a:b" / "c" and "a" / "b:c" both render as "a:b:c"; they are still two anchors.
    const outcome = mergeByAnchor([raised('a:b', {}, 'implement', 'c'), raised('a', {}, 'verify', 'b:c')]);
    expect(outcome.questions).toHaveLength(2);
  });

  it('keeps identical prompts apart when their anchors differ only in case', () => {
    const outcome = mergeByAnchor([raised('Session'), raised('session')]);
    expect(outcome.questions).toHaveLength(2);
  });

  it('never merges two questions that both lack a usable anchor', () => {
    const outcome = mergeByAnchor([raised(''), raised(''), raised('src/project.ts:42'), raised('src/project.ts:42')]);
    expect(outcome.questions).toHaveLength(4);
    expect(outcome.questions.every((card) => card.anchors.length === 0)).toBe(true);
  });

  it('passes a lone question through with its draft unchanged', () => {
    const only = raised('resolveProject');
    const outcome = mergeByAnchor([only]);
    expect(outcome.questions[0]?.draft).toStrictEqual(only.draft);
    expect(outcome.questions[0]?.basis).toBe('single');
  });
});

describe('a merged question still satisfies assertAskableDraft (matrix 11)', () => {
  it('produces a card the Q1 gate accepts: options within three, an escape, a default and a window', () => {
    const outcome = mergeByAnchor([raised('resolveProject'), raised('resolveProject'), raised('resolveProject')]);
    const card = outcome.questions[0];
    expect(card).toBeDefined();
    expect(() => assertAskableDraft(card?.draft)).not.toThrow();
    expect(card?.draft.options.length).toBeLessThanOrEqual(3);
    expect(card?.draft.escape.id).toBe('ask-later');
    expect(card?.draft.recommended_option_id).toBe('null');
  });

  it('refuses a merge whose parts leave the card with no window, rather than asking an open-ended question', () => {
    // One asker declared a zero window; the shortest-window rule carries it into the card, and the gate
    // refuses the card — a merge is not a way past Q2.
    const outcome = mergeByAnchor([raised('resolveProject'), raised('resolveProject', { default_window_ms: 0 })]);
    expect(outcome.questions).toStrictEqual([]);
    expect(outcome.refused).toHaveLength(1);
    expect(outcome.refused[0]?.field).toBe('default_window_ms');
    expect(outcome.refused[0]?.raised).toHaveLength(2);
  });

  it('hands back a group whose options would exceed three, instead of dropping one', () => {
    const outcome = mergeByAnchor([
      raised('resolveProject'),
      raised('resolveProject', {
        options: [
          { id: 'null', label: 'Return null', consequence: 'The installer can offer to register the path.' },
          { id: 'register', label: 'Register it', consequence: 'Registered on first use.' },
          { id: 'warn', label: 'Warn and continue', consequence: 'A warning is printed.' },
        ],
      }),
    ]);
    expect(outcome.questions).toStrictEqual([]);
    expect(outcome.awaitingJudgment).toHaveLength(1);
    expect(outcome.awaitingJudgment[0]?.reason).toContain('4 distinct options');
  });

  it('hands back a group whose askers recommend different defaults, since picking one is a judgement', () => {
    const outcome = mergeByAnchor([raised('resolveProject'), raised('resolveProject', { recommended_option_id: 'throw' })]);
    expect(outcome.questions).toStrictEqual([]);
    expect(outcome.awaitingJudgment[0]?.reason).toContain('recommend different defaults');
  });

  it('hands back a group in which one option id means two different things', () => {
    const outcome = mergeByAnchor([
      raised('resolveProject'),
      raised('resolveProject', {
        options: [
          { id: 'throw', label: 'Throw a typed error', consequence: 'Callers catch ProjectMissing.' },
          { id: 'null', label: 'Return null', consequence: 'The installer can offer to register the path.' },
        ],
      }),
    ]);
    expect(outcome.awaitingJudgment[0]?.reason).toContain('option "throw" means different things');
  });
});

describe('one refused draft or group is reported alone, and the rest of the batch still compresses (matrix 21)', () => {
  it('reports a bad single draft and a bad group, and still composes the good cards beside them', () => {
    const outcome = mergeByAnchor([
      raised('widgetCache', { prompt: 'Should widgetCache be shared?' }, 'implement', 'sharing'),
      raised('sessionKey', { default_window_ms: 0 }, 'implement', 'rotation'),
      raised('resolveProject', { brief: '' }),
      raised('resolveProject', { brief: '' }),
      raised('ProjectStore', {}, 'verify', 'lookup'),
    ]);
    expect(outcome.questions.map((card) => card.anchors[0]?.symbol)).toStrictEqual(['widgetCache', 'ProjectStore']);
    expect(outcome.refused.map((refusal) => [refusal.raised.length, refusal.field])).toStrictEqual([
      [1, 'default_window_ms'],
      [2, 'brief'],
    ]);
  });
});

describe('a merge loses nothing any asker declared (matrix 22)', () => {
  it('hands back a group whose askers state different default actions', () => {
    const outcome = mergeByAnchor([
      raised('resolveProject'),
      raised('resolveProject', { default_action: 'resolveProject returns null and logs a warning.' }),
    ]);
    expect(outcome.questions).toStrictEqual([]);
    expect(outcome.awaitingJudgment[0]?.reason).toContain('different default actions');
  });

  it('hands back a group whose askers offer different escapes', () => {
    const outcome = mergeByAnchor([
      raised('resolveProject'),
      raised('resolveProject', {
        escape: { id: 'defer', label: 'Defer to the reviewer', consequence: 'The reviewer decides.' },
      }),
    ]);
    expect(outcome.awaitingJudgment[0]?.reason).toContain('different escapes');
  });

  it('checks every asker’s escape against the options, not only the first asker’s', () => {
    // The second asker's escape id is the same id the first offers as a concrete option.
    const escape = { id: 'throw', label: 'Throw', consequence: 'A caller that forgot to register fails loudly.' };
    const outcome = mergeByAnchor([
      raised('resolveProject', { escape }),
      raised('resolveProject', { escape }),
    ]);
    expect(outcome.questions).toStrictEqual([]);
    expect(outcome.awaitingJudgment[0]?.reason).toContain('escape "throw" is a concrete option');
  });
});

describe('a merged card says how many raised questions it stands for, where the rate can read it (matrix 28)', () => {
  it('reads back the count a merged brief states, and 1 for a brief that states none', () => {
    const outcome = mergeByAnchor([raised('resolveProject'), raised('resolveProject'), raised('resolveProject')]);
    expect(raisedQuestionsStatedIn(outcome.questions[0]?.draft.brief ?? '')).toBe(3);
    expect(raisedQuestionsStatedIn(aDraft().brief)).toBe(1);
    // A subagent's brief quoting the words mid-text is not a merge.
    expect(raisedQuestionsStatedIn('This one question stands for 9 raised questions: no.\n\nMore prose.')).toBe(1);
  });
});

describe('a live judgement merges what the anchors missed, and is recorded as the reason (matrix 16)', () => {
  const judged = (): readonly RaisedQuestion[] => [
    raised('resolveProject'),
    raised('ProjectStore.lookup', { prompt: 'Should ProjectStore.lookup throw on a miss?' }),
  ];

  it('merges on the judgement and states the judgement itself as the reason', () => {
    const card = mergeOnJudgment(judged(), {
      reason: 'resolveProject is a thin wrapper over ProjectStore.lookup, so one answer settles both',
      draft: aDraft(),
    });
    expect(card.basis).toBe('judgment');
    expect(card.reason).toBe('resolveProject is a thin wrapper over ProjectStore.lookup, so one answer settles both');
    expect(card.anchors.map((a) => a.symbol)).toStrictEqual(['resolveProject', 'ProjectStore.lookup']);
    // Recorded where the `question.asked` line will carry it, not left in memory.
    expect(card.draft.brief).toContain(
      'This one question stands for 2 raised questions: the Interviewer judged them the same question — ' +
        'resolveProject is a thin wrapper over ProjectStore.lookup',
    );
  });

  it('uses the shortest window among the judged card and every draft it replaces (matrix 23)', () => {
    const card = mergeOnJudgment(
      [raised('resolveProject', { default_window_ms: 10 * 60 * 1000 }), raised('ProjectStore', { default_window_ms: 2 * 60 * 1000 })],
      { reason: 'one answer settles both', draft: aDraft({ default_window_ms: 60 * 60 * 1000 }) },
    );
    expect(card.draft.default_window_ms).toBe(2 * 60 * 1000);
  });

  it('refuses a judgement that gives no reason, because the merge would be left implicit', () => {
    expect(() => mergeOnJudgment(judged(), { reason: '   ', draft: aDraft() })).toThrow(MergeJudgmentRefused);
  });

  it('refuses a judged card that breaks Q1, because a judgement can merge questions but cannot waive the gate', () => {
    const tooMany = aDraft({
      options: [
        { id: 'a', label: 'A', consequence: 'a' },
        { id: 'b', label: 'B', consequence: 'b' },
        { id: 'c', label: 'C', consequence: 'c' },
        { id: 'd', label: 'D', consequence: 'd' },
      ],
      recommended_option_id: 'a',
    });
    expect(() => mergeOnJudgment(judged(), { reason: 'the same question', draft: tooMany })).toThrow(QuestionDraftRefused);
    expect(() =>
      mergeOnJudgment(judged(), { reason: 'the same question', draft: aDraft({ recommended_option_id: '' }) }),
    ).toThrow(QuestionDraftRefused);
  });

  it('refuses a judgement over fewer than two questions, which is not a merge', () => {
    expect(() => mergeOnJudgment([raised('resolveProject')], { reason: 'alone', draft: aDraft() })).toThrow(
      MergeJudgmentRefused,
    );
  });
});
