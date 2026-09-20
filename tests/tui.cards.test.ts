/**
 * The six surfaces, asserted as view-models rather than as rendered frames.
 *
 * This is the split story 1-9 earned the right to insist on: its thirty-one pure tests caught both of the
 * mutations its parent injected and its single frame test caught neither. So every claim a card makes is
 * checked by calling a function, and the frame's own invariants — the mode still present, the slot still a
 * section, nothing wider than the terminal — live in `tests/tui.frame.test.ts` where a frame is actually
 * drawn.
 *
 * Three of these tests are about drift rather than about behaviour, and they are the ones that would
 * otherwise fail silently:
 *
 * - the kill card's `narrow` row is compared against `commandAvailability` itself, so a card that hard-coded
 *   the owner would pass today and lie the day story 2-9 lands;
 * - the spec echo's keystrokes are compared against the control table, for the same reason;
 * - the completion notice is checked for what it does *not* say, because R8's failure mode is a notice that
 *   reads as a pass rather than one that reads as wrong.
 */
import { readFileSync, readdirSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { CURRENT_SCHEMA_VERSION, Command, QuestionStateSchema } from '../src/contracts/index.js';
import type { QuestionState } from '../src/contracts/index.js';
import { commandAvailability, describeDefaultTaken } from '../src/runtime/index.js';
import {
  CONTROLS,
  KILL_CARD_COMMANDS,
  MAX_QUESTION_CARD_OPTIONS,
  UNRECORDED_PRESENTATION,
  buildBriefCard,
  buildCompletionCard,
  buildHandoffCard,
  buildKillCard,
  buildQuestionCard,
  buildSpecEchoCard,
  cardForView,
  cardText,
  editCriterionArgument,
  foldEvents,
  idleShellView,
} from '../src/tui/index.js';
import type { QuestionDetail, ShellView } from '../src/tui/index.js';

import {
  FIXTURE_RUN_START_MS,
  budgetDegraded,
  buildLog,
  featureStateChanged,
  handoffRecorded,
  questionAsked,
  questionDefaultTaken,
  runCreated,
  stepStarted,
  stepTerminated,
} from './helpers/tui-log.js';

/** A question id shaped as the engine mints them: punctuated, so AD-21's sweep cannot reach it. */
const QUESTION_ID = 'q-01K5NQ9Z-J7V3M2P9-XQWRTC4B-DE';

const ASKED_AT = new Date(FIXTURE_RUN_START_MS + 2_000).toISOString();

/** The question as the state file holds it: three options, an escape, a brief and a window. */
const threeOptionQuestion = (): QuestionDetail => ({
  id: QUESTION_ID,
  prompt: 'Should the shell poll the log, or watch it?',
  brief:
    'The shell re-reads the log to redraw. Polling cannot miss a line; watching is cheaper but can drop ' +
    'a notification on some filesystems.',
  options: [
    { id: 'poll', label: 'poll', consequence: 'one read per second, and no notification can be missed' },
    { id: 'watch', label: 'watch', consequence: 'redraws instantly, and may miss a line on some volumes' },
    { id: 'both', label: 'watch and poll slowly', consequence: 'instant, with a slow poll as a backstop' },
  ],
  escape: { id: 'ask-me', label: 'ask me again with more detail', consequence: 'nothing changes yet' },
  recommended_option_id: 'poll',
  default_action: 'the shell polls every second',
  default_window_ms: 600_000,
  asked_at: ASKED_AT,
});

const pendingQuestionView = (): ShellView =>
  foldEvents(
    buildLog([
      runCreated(),
      featureStateChanged('confirmed'),
      { ...questionAsked(QUESTION_ID), atMs: 2_000 },
    ]),
  );

const defaultedQuestionView = (): ShellView =>
  foldEvents(
    buildLog([
      runCreated(),
      { ...questionAsked(QUESTION_ID), atMs: 2_000 },
      { ...questionDefaultTaken(QUESTION_ID), atMs: 602_000 },
    ]),
  );

/** The settled state file the engine would have written when the clock won the compare-and-set. */
const timedOutState = (): QuestionState =>
  QuestionStateSchema.parse({
    schema_version: CURRENT_SCHEMA_VERSION,
    question: {
      id: QUESTION_ID,
      feature: 'tui-cards',
      run: '01K5NQ9ZJ7V3M2P9XQWRTC4BDE',
      step: null,
      asked_at: ASKED_AT,
      prompt: threeOptionQuestion().prompt,
      brief: threeOptionQuestion().brief,
      options: threeOptionQuestion().options,
      escape: threeOptionQuestion().escape,
      recommended_option_id: 'poll',
      default_action: 'the shell polls every second',
      default_window_ms: 600_000,
    },
    status: 'resolved',
    resolution: {
      resolver: 'timeout_default',
      principal: { kind: 'timeout', id: 'question.window' },
      answer: 'The window of 600000ms passed with no answer, so the recommended default was taken: poll.',
      option_id: 'poll',
      resolved_at: new Date(FIXTURE_RUN_START_MS + 602_000).toISOString(),
    },
    deflection: null,
  });

describe('the one-question card states everything Q1 through Q3 require', () => {
  const card = buildQuestionCard({
    view: pendingQuestionView(),
    question: threeOptionQuestion(),
    now: new Date(FIXTURE_RUN_START_MS + 62_000),
  });

  it('states the prompt and a self-contained mini-brief, so the feature need not be reloaded', () => {
    expect(card.prompt).toBe('Should the shell poll the log, or watch it?');
    expect(card.brief).toContain('Polling cannot miss a line');
    expect(card.brief).not.toBe(UNRECORDED_PRESENTATION);
  });

  it('carries every option with its own consequence, and marks the recommended one', () => {
    expect(card.options.map((option) => option.id)).toStrictEqual(['poll', 'watch', 'both', 'ask-me']);
    for (const option of card.options) expect(option.consequence).not.toBe('');
    expect(card.options.filter((option) => option.recommended).map((option) => option.id)).toStrictEqual([
      'poll',
    ]);
    expect(cardText(card)).toContain('(recommended)');
  });

  it('states what happens if it is ignored, and how long is left before it does', () => {
    expect(card.defaultAction).toBe('the shell polls every second');
    // Asked at +2s with a ten-minute window, read at +62s: nine minutes remain, not ten.
    expect(card.window).toBe('9m00s left before the default is taken');
    expect(card.window).not.toContain('600000');
  });

  it('says the window has passed rather than counting into the negative', () => {
    const late = buildQuestionCard({
      view: pendingQuestionView(),
      question: threeOptionQuestion(),
      now: new Date(FIXTURE_RUN_START_MS + 900_000),
    });
    expect(late.window).toContain('the window has passed');
  });

  it('states the brief as unrecorded when only the log line was in reach, never inventing one', () => {
    const fromLogAlone = buildQuestionCard({ view: pendingQuestionView() });
    expect(fromLogAlone.prompt).toBe('Should the shell poll the log, or watch it?');
    expect(fromLogAlone.brief).toBe(UNRECORDED_PRESENTATION);
    // The log carries the declared window but not the instant it started, so the card says which it means.
    expect(fromLogAlone.window).toContain('from when it was asked');
  });
});

describe('a question with more than three options shows three plus the escape', () => {
  const fourOptions: QuestionDetail = {
    ...threeOptionQuestion(),
    options: [
      ...(threeOptionQuestion().options ?? []),
      { id: 'sqlite', label: 'index it in SQLite', consequence: 'fastest, and one more thing to keep' },
    ],
  };
  const card = buildQuestionCard({ view: pendingQuestionView(), question: fourOptions });

  it('bounds the concrete options to three and never drops the escape', () => {
    expect(card.options.filter((option) => !option.escape)).toHaveLength(MAX_QUESTION_CARD_OPTIONS);
    expect(card.options.filter((option) => option.escape).map((option) => option.id)).toStrictEqual([
      'ask-me',
    ]);
    expect(cardText(card)).toContain('[esc]');
  });

  it('states how many were offered and not shown, rather than dropping them in silence', () => {
    expect(card.optionsNotShown).toBe(1);
    expect(cardText(card)).toContain('1 further option');
  });
});

describe('the window closing while somebody is typing', () => {
  const half = 'poll, because missing a line is worse than a redraw';
  const card = buildQuestionCard({
    view: defaultedQuestionView(),
    question: { ...threeOptionQuestion(), settled: timedOutState() },
    draft: half,
  });

  it('states the default was taken, in the words the engine tells a losing resolver', () => {
    // The engine's own sentence, not a paraphrase: the terminal and the refusal say the same thing about
    // the same decision, which is what story 1-8 established a losing resolver is owed.
    expect(card.outcome).toBe(describeDefaultTaken(timedOutState()));
    expect(cardText(card)).toContain('the recommended default was taken');
  });

  it('says the typed text was not submitted, rather than leaving a person to assume it was', () => {
    expect(card.draft).toBe(half);
    expect(cardText(card)).toContain('was not submitted');
    expect(cardText(card)).toContain(half);
  });

  it('states the default was taken even with only the log line in reach', () => {
    const fromLogAlone = buildQuestionCard({ view: defaultedQuestionView() });
    expect(fromLogAlone.state).toBe('defaulted');
    expect(fromLogAlone.outcome).toContain('the window closed');
  });
});

describe('the spec echo is numbered, confirmable in one keystroke and editable line by line', () => {
  const criteria = [
    'the loop takes at most one action per pass',
    'a restart converges on the same state',
    'a killed step is never re-run',
    'every event passes redaction before it is appended',
    'the mode is displayed in every render state',
  ];
  const card = buildSpecEchoCard({ view: idleShellView('tui-cards'), criteria });

  it('numbers every criterion from one, so each is individually addressable', () => {
    expect(card.criteria.map((criterion) => criterion.line)).toStrictEqual([1, 2, 3, 4, 5]);
    expect(card.criteria[4]?.text).toBe('the mode is displayed in every render state');
    for (const criterion of card.criteria) {
      expect(cardText(card)).toContain(`${String(criterion.line)}. ${criterion.text}`);
    }
  });

  it('offers one keystroke that confirms all of them, read from the control table', () => {
    expect(card.confirmKey).toBe(CONTROLS[Command.ConfirmSpec].key);
    expect(card.editKey).toBe(CONTROLS[Command.EditCriterion].key);
    expect(cardText(card)).toContain(`press "${card.confirmKey}" to confirm all 5 as written`);
  });

  it('names the line an amendment changes, in the text the intent carries', () => {
    const argument = editCriterionArgument(3, 'a killed step is never re-run and never resumed');
    expect(argument).toContain('criterion 3');
    expect(argument).toContain('never resumed');
  });

  it('says the criteria are unrecorded rather than offering to confirm nothing', () => {
    const empty = buildSpecEchoCard({ view: idleShellView('tui-cards') });
    expect(empty.unrecorded).toBe(true);
    expect(cardText(empty)).toContain(UNRECORDED_PRESENTATION);
    expect(cardText(empty)).toContain('nothing to confirm yet');
    expect(cardText(empty)).not.toContain('confirm all 0');
  });
});

/** A run that has burned its estimate: degraded at a ceiling, with a wall-clock remaining recorded. */
const overEstimateView = (): ShellView =>
  foldEvents(
    buildLog([
      runCreated(),
      featureStateChanged('confirmed'),
      featureStateChanged('running', 'confirmed'),
      stepStarted('implement'),
      { ...budgetDegraded(0.82, 60_000), atMs: 120_000 },
      { ...featureStateChanged('degraded', 'running'), atMs: 120_500 },
    ]),
  );

const OVER_ESTIMATE_NOW = new Date(FIXTURE_RUN_START_MS + 900_000);

describe('the kill card states usage and elapsed against estimate', () => {
  const card = buildKillCard({ view: overEstimateView(), now: OVER_ESTIMATE_NOW });

  it('states the consumed rate-limit budget as a share of its own ceiling, never as money', () => {
    expect(card.usage).toBe('0.82 of 1.00');
    expect(cardText(card)).not.toMatch(/[$£€]/);
  });

  it('states elapsed against the estimate the log recorded', () => {
    expect(card.elapsed).toContain('of ~');
    expect(card.elapsed).toContain('estimated');
  });

  it('says the run has passed its estimate, which is why the card is on the screen', () => {
    expect(card.overEstimate).toBe(true);
    expect(cardText(card)).toContain('passed the estimate');
    const early = buildKillCard({
      view: overEstimateView(),
      now: new Date(FIXTURE_RUN_START_MS + 60_000),
    });
    expect(early.overEstimate).toBe(false);
    expect(cardText(early)).toContain('still within the estimate');
  });

  it('offers continue, narrow, kill and take over, with the keystroke each one is on', () => {
    expect(card.controls.map((control) => control.command)).toStrictEqual([...KILL_CARD_COMMANDS]);
    for (const control of card.controls) {
      expect(control.key).toBe(CONTROLS[control.command].key);
      expect(cardText(card)).toContain(`[${control.key}] ${control.label}`);
    }
  });
});

describe('a control nothing acts on yet says so, in the words of the table that knows', () => {
  const card = buildKillCard({ view: overEstimateView(), now: OVER_ESTIMATE_NOW });
  const narrow = card.controls.find((control) => control.command === Command.Narrow);

  it('renders narrow rather than hiding it, because the intent file is durable (AD-19)', () => {
    expect(narrow).toBeDefined();
    expect(cardText(card)).toContain('narrow');
  });

  it('names the owner the steering table names, rather than a literal of its own', () => {
    const declared = commandAvailability(Command.Narrow);
    expect(declared.owner).not.toBeNull();
    // The card is asserted against the table itself: a card carrying its own copy of this sentence would
    // pass today and be wrong the day the table changes.
    expect(narrow?.owner).toBe(declared.owner);
    expect(cardText(card)).toContain(declared.owner ?? 'an owner the table names');
  });

  it('does not present narrow as effective, and does present kill and take over as effective', () => {
    expect(narrow?.honoured).toBe(false);
    expect(narrow?.availability).toContain('written and kept');
    expect(narrow?.availability).toContain('nothing narrows yet');
    for (const command of [Command.Kill, Command.TakeOver]) {
      expect(card.controls.find((control) => control.command === command)?.honoured).toBe(true);
    }
  });
});

/** A run the log records as committed, with one verification step that completed. */
const committedView = (): ShellView =>
  foldEvents(
    buildLog([
      runCreated(),
      featureStateChanged('confirmed'),
      featureStateChanged('running', 'confirmed'),
      stepStarted('implement'),
      stepTerminated('implement'),
      stepStarted('verify', 'verification'),
      stepTerminated('verify'),
      featureStateChanged('verifying', 'running'),
      featureStateChanged('committed', 'verifying'),
    ]),
  );

describe('the completion notice states what was not verified rather than omitting it', () => {
  const card = buildCompletionCard({
    view: committedView(),
    now: new Date(FIXTURE_RUN_START_MS + 10_000),
  });

  it('renders the merge, the file count and the test result as unrecorded, each of them present', () => {
    expect(card.merged).toBe(UNRECORDED_PRESENTATION);
    expect(card.fileCount).toBe(UNRECORDED_PRESENTATION);
    expect(card.testStatus).toBe(UNRECORDED_PRESENTATION);
    for (const label of ['merged:', 'files changed:', 'tests:']) {
      expect(cardText(card)).toContain(`${label} ${UNRECORDED_PRESENTATION}`);
    }
  });

  it('lists every unrecorded fact as something that was not verified (R8)', () => {
    expect(card.notVerified.join(' ')).toContain('no test result is recorded');
    expect(card.notVerified.join(' ')).toContain('no merge is recorded');
    expect(card.notVerified.join(' ')).toContain('no file count is recorded');
    expect(cardText(card)).toContain('not verified:');
  });

  it('does not read as a verified pass anywhere', () => {
    const text = cardText(card).toLowerCase();
    // The three spellings an unrecorded fact must never wear: a tick, a pass, or the claim of a merge.
    expect(text).not.toContain('tests: passed');
    expect(text).not.toContain('✓');
    expect(text).not.toContain('merged: yes');
    expect(card.nothingIsNeeded).toContain('unverified is unverified');
  });

  it('states plainly that nothing is needed, because silence means success (R1)', () => {
    expect(cardText(card)).toContain('nothing is needed from you');
  });

  it('names the verification step the log records as completed, and the one it does not', () => {
    expect(card.verified).toStrictEqual(['verify']);
    const halfVerified = buildCompletionCard({
      view: foldEvents(
        buildLog([
          runCreated(),
          stepStarted('verify', 'verification'),
          stepTerminated('verify', 'failed'),
          featureStateChanged('committed'),
        ]),
      ),
    });
    expect(halfVerified.verified).toStrictEqual([]);
    expect(halfVerified.notVerified.join(' ')).toContain('"verify" did not complete');
  });

  it('carries a fact a later story records, once something records it', () => {
    const recorded = buildCompletionCard({
      view: committedView(),
      facts: { merged: 'feature/tui-cards into main', fileCount: 14, testStatus: '1024 passed' },
    });
    expect(recorded.merged).toBe('feature/tui-cards into main');
    expect(recorded.fileCount).toBe('14 files');
    expect(recorded.testStatus).toBe('1024 passed');
    expect(recorded.notVerified).toStrictEqual([]);
    expect(recorded.nothingIsNeeded).toContain('finished and verified');
  });
});

const handedOffView = (): ShellView =>
  foldEvents(
    buildLog([
      runCreated(),
      featureStateChanged('confirmed'),
      stepStarted('implement'),
      handoffRecorded(
        'user.take_over',
        'user "deep" took the work over, so the partial work is on its own branch and the run halted',
      ),
      featureStateChanged('handed_off', 'running'),
    ]),
  );

describe('the handoff card reads as a colleague note, not a stack trace', () => {
  const card = buildHandoffCard({
    view: handedOffView(),
    location: {
      branch: 'orch/takeover/01K5NQ9ZJ7V3M2P9XQWRTC4BDE',
      document: '/tmp/orch/runs/01K5NQ9ZJ7V3M2P9XQWRTC4BDE/HANDOFF.md',
    },
  });

  it('opens with why, in a sentence', () => {
    expect(card.why).toContain('took the work over');
    expect(card.title).toContain('handed off');
    // The headline stands alone (R3): it is not an error code and not a frame.
    expect(card.title).not.toContain('user.take_over');
  });

  it('names the branch the work is on and points at the document', () => {
    expect(card.branch).toBe('orch/takeover/01K5NQ9ZJ7V3M2P9XQWRTC4BDE');
    expect(card.document).toContain('HANDOFF.md');
    expect(card.nextStep).toContain('git checkout orch/takeover/');
  });

  it('carries no stack frame and no error code as its headline', () => {
    const text = cardText(card);
    expect(text).not.toContain('at Object.');
    expect(text).not.toContain('Error:');
    expect(text).toContain('nothing was thrown away');
  });

  it('says the branch is unrecorded rather than guessing at a name it does not own (AD-22)', () => {
    const withoutLocation = buildHandoffCard({ view: handedOffView() });
    expect(withoutLocation.branch).toBe(UNRECORDED_PRESENTATION);
    expect(withoutLocation.nextStep).toContain('wherever the run left it');
    expect(cardText(withoutLocation)).not.toContain('orch/takeover/');
  });
});

describe('which card a view calls for is decided in one place', () => {
  it('gives a pending question its card, whatever else the run is doing', () => {
    expect(cardForView(pendingQuestionView())?.kind).toBe('question');
  });

  it('gives a drafting run the spec echo, a committed one the notice, a handed-off one the note', () => {
    expect(cardForView(foldEvents(buildLog([runCreated()])))?.kind).toBe('spec-echo');
    expect(cardForView(committedView())?.kind).toBe('completion');
    expect(cardForView(handedOffView())?.kind).toBe('handoff');
  });

  it('gives a run past its estimate the kill card', () => {
    expect(cardForView(overEstimateView(), { now: OVER_ESTIMATE_NOW })?.kind).toBe('kill');
  });

  it('draws no card when nothing needs deciding, rather than one for the sake of it', () => {
    const running = foldEvents(
      buildLog([
        runCreated(),
        featureStateChanged('confirmed'),
        featureStateChanged('running', 'confirmed'),
        stepStarted('implement'),
      ]),
    );
    expect(cardForView(running, { now: new Date(FIXTURE_RUN_START_MS + 4_000) })).toBeNull();
  });

  it('passes the facts it is given through to the card that states them', () => {
    const card = cardForView(committedView(), { completion: { testStatus: '1024 passed' } });
    if (card === null) throw new Error('a committed run was given no card');
    expect(card.kind).toBe('completion');
    expect(cardText(card)).toContain('1024 passed');
  });
});

describe('src/tui/cards/ imports only contracts, runtime and its own siblings', () => {
  const cardsDir = new URL('../src/tui/cards/', import.meta.url);
  const files = readdirSync(cardsDir).filter((name) => name.endsWith('.ts'));

  /** Statement forms only, so a quoted word after "from" in prose is not read as an import. */
  const IMPORT_PATTERNS = [
    /^\s*(?:import|export)\b[^'";]*\bfrom\s*['"]([^'"]+)['"]/gm,
    /^\s*import\s*['"]([^'"]+)['"]/gm,
    /\bimport\s*\(\s*['"]([^'"]+)['"]/g,
    /\brequire\s*\(\s*['"]([^'"]+)['"]/g,
  ];

  const importsOf = (source: string): string[] =>
    IMPORT_PATTERNS.flatMap((pattern) =>
      [...source.matchAll(pattern)].map((match) => match[1] ?? ''),
    );

  it('has card files to inspect, and reads the imports it claims to', () => {
    expect(files.length).toBeGreaterThan(0);
    const source = readFileSync(new URL('kill.ts', cardsDir), 'utf8');
    expect(importsOf(source)).toContain('../../runtime/index.js');
  });

  it.each(files)('%s never imports src/engine/', (file) => {
    const source = readFileSync(new URL(file, cardsDir), 'utf8');
    for (const specifier of importsOf(source)) {
      expect(specifier.includes('/engine/'), `${file} imports "${specifier}"`).toBe(false);
      const allowed =
        specifier.startsWith('./') ||
        specifier.startsWith('../') ||
        specifier.startsWith('node:') ||
        ['react', 'react/jsx-runtime', 'ink'].includes(specifier);
      expect(allowed, `${file} imports "${specifier}"`).toBe(true);
      if (specifier.startsWith('../../')) {
        expect(
          specifier.startsWith('../../contracts/') || specifier.startsWith('../../runtime/'),
          `${file} imports "${specifier}"`,
        ).toBe(true);
      }
    }
  });

  it.each(files)('%s writes no file of its own', (file) => {
    // A card is a pure function of a view. One that opened a file would be a second read path, and the
    // shape a second write path arrives in (AD-19).
    const source = readFileSync(new URL(file, cardsDir), 'utf8');
    for (const forbidden of ['writeFileSync', 'appendFileSync', 'renameSync', 'readFileSync']) {
      expect(source, `${file} reaches ${forbidden}`).not.toContain(forbidden);
    }
  });
});

/**
 * R10 across every card, not only the ambient frame.
 *
 * `tests/tui.status.test.ts` has asserted since story 1-9 that the shell frame renders no currency amount,
 * and it kept passing while story 1-11 put `0.0396 usd as the CLI reported it` on the brief and the
 * completion notice — because a card is not the shell frame. The guard went around, not through, so it is
 * restated here over every card a person can see. The CLI's `total_cost_usd` is still recorded in the log
 * for AD-24's ceilings and stage 3's measurement; R10 governs what is shown, not what is kept.
 */
describe('no card renders a currency amount (R10)', () => {
  /** Every spelling a currency amount arrives as. The word "cost" is a legitimate label and is not one. */
  const CURRENCY_MARKERS = ['$', '€', '£', '¥', 'usd', 'eur', 'gbp', 'dollar', 'price'];

  const withUsage = (): ShellView =>
    foldEvents(
      buildLog([
        runCreated(),
        stepStarted('implement'),
        stepTerminated('implement', 'completed'),
        featureStateChanged('committed'),
      ]),
    );

  const cards: Readonly<Record<string, string>> = {
    question: cardText(buildQuestionCard({ view: pendingQuestionView(), question: threeOptionQuestion() })),
    'spec echo': cardText(buildSpecEchoCard({ view: withUsage() })),
    kill: cardText(buildKillCard({ view: withUsage() })),
    completion: cardText(buildCompletionCard({ view: withUsage() })),
    handoff: cardText(buildHandoffCard({ view: idleShellView('checkout') })),
    brief: cardText(
      buildBriefCard({
        fleet: {
          runs: [{ runId: '01K5NQ9Z-J7V3M2P9-XQWRTC4B-DE', view: withUsage(), inFlight: true }],
        },
        height: 24,
      }),
    ),
  };

  it.each(Object.keys(cards))('renders no currency amount on the %s card', (name) => {
    const text = (cards[name] ?? '').toLowerCase();
    for (const marker of CURRENCY_MARKERS) {
      expect(text, `the ${name} card rendered "${marker}"`).not.toContain(marker);
    }
  });

  it('renders no bare decimal figure that could only be money', () => {
    for (const [name, text] of Object.entries(cards)) {
      // Four decimal places was the shape the cost figure used; no legitimate card value has it.
      expect(text, name).not.toMatch(/\d+\.\d{4}\b/);
    }
  });
});
