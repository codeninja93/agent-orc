/**
 * The stage-1 gate's reconstructability half: **a run is fully reconstructable from git and the event log
 * alone.**
 *
 * So this suite runs a real feature to `committed` through a real reconciler — asking a question and
 * answering it through a durable intent file on the way, because a run nobody steered would not exercise
 * the half of the log that records steering — and then *deletes everything in the run directory except
 * `events.jsonl`*. No `state.json`, no `commands/`, no `questions/`, no step input files, no side file of
 * any kind. Every card is then built from what is left.
 *
 * Deleting rather than ignoring is the whole point. A test that simply did not read the checkpoint would
 * pass just as happily if a card quietly read one, and "reconstructable from the log" would be a claim
 * nobody had checked. With the files gone, a card that reached for one cannot silently succeed.
 *
 * Story 1-11 closed the two gaps this suite used to document:
 *
 * - **The acceptance criteria are in the log**, as `spec.recorded`, so the spec echo reconstructs from it
 *   and offers the one-keystroke confirmation. The assertion that used to pin the criteria as *absent* is
 *   inverted below, which is the gate's remaining half becoming true.
 * - **The takeover branch and the document are derived, not recorded.** Both are pure functions of the run
 *   id, which every envelope carries verbatim because `run` is on the AD-21 allow-list — so the card calls
 *   `takeoverBranchFor` and the AD-9 paths rather than reading a payload field. Nothing was added to
 *   `handoff.recorded`: a bare ULID inside a payload string is replaced by the entropy sweep, and the only
 *   escape would have been a wider allow-list.
 */
import { readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { QuestionDraft } from '../src/contracts/index.js';
import {
  Reconciler,
  createRecordingResetter,
  createScriptedExecutor,
  takeoverBranchFor,
  terminated,
} from '../src/engine/index.js';
import { readEventLog, runPaths } from '../src/runtime/index.js';
import type { EventEnvelope } from '../src/contracts/index.js';
import {
  DEFAULT_BRIEF_HEIGHT,
  NARROW_COLUMNS,
  UNRECORDED_PRESENTATION,
  buildBriefCard,
  buildCompletionCard,
  buildHandoffCard,
  buildKillCard,
  buildQuestionCard,
  buildSpecEchoCard,
  cardLines,
  cardText,
  foldEvents,
  foldFleet,
  invokeControl,
  reduceKeys,
  typedKeys,
  wrapLine,
} from '../src/tui/index.js';
import type { Card } from '../src/tui/index.js';

import { makeHome, makePlan, planProvider } from './helpers/engine-fixture.js';

const BASELINE = 'ddd9bed4d286ac1f8a0f4f7bfef9530046605787';
const PRINCIPAL = { kind: 'user' as const, id: 'deep' };
const FEATURE = 'tui-reconstruction';
const ANSWER = 'poll it, and keep the interval at a second';

const DRAFT: QuestionDraft = {
  prompt: 'Should the shell poll the log, or watch it?',
  brief: 'Polling cannot miss a line; watching is cheaper and can drop a notification on some volumes.',
  options: [
    { id: 'poll', label: 'poll', consequence: 'one read per second, and nothing is missed' },
    { id: 'watch', label: 'watch', consequence: 'redraws instantly, and may miss a line' },
  ],
  escape: { id: 'ask-me', label: 'ask me again with more detail', consequence: 'nothing changes yet' },
  recommended_option_id: 'poll',
  default_action: 'the shell polls every second',
  default_window_ms: 600_000,
};

let home: string;
const toRemove: string[] = [];
const toClose: Reconciler[] = [];

beforeEach(() => {
  home = makeHome('tui-reconstruction');
  toRemove.push(home);
});

afterEach(() => {
  for (const reconciler of toClose.splice(0)) reconciler.close();
  for (const dir of toRemove.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface CompletedRun {
  readonly run: string;
  readonly questionId: string;
  readonly events: readonly EventEnvelope[];
}

/**
 * Run one feature to `committed`, steered by a real intent file, then leave only the log on disk.
 *
 * The answer goes in through the keystroke reducer and `invokeControl`, so the path under test is the one a
 * person's fingers take: no method call into the engine anywhere in it (AD-19).
 */
const completedRunWithOnlyItsLog = async (): Promise<CompletedRun> => {
  const plan = makePlan({ feature: FEATURE });
  const reconciler = Reconciler.open({
    orchHome: home,
    executor: createScriptedExecutor({
      onStart: (request) => terminated(request.step, 'completed', { sessionId: `sess-${request.step}` }),
      sessionIdFor: (request) => `sess-${request.step}`,
    }),
    plans: planProvider(plan),
    baseline: createRecordingResetter(BASELINE),
  });
  toClose.push(reconciler);

  const accepted = reconciler.acceptFeature(plan);
  const paths = runPaths(accepted.run, home);
  const asked = reconciler.ask(accepted.run, DRAFT);

  const { effects } = reduceKeys([{ input: 'a' }, ...typedKeys(ANSWER), { input: '', return: true }]);
  const effect = effects.find((candidate) => candidate.kind === 'invoke');
  if (effect?.kind !== 'invoke') throw new Error('the reducer did not submit the answer');
  invokeControl(effect.command, { paths, feature: FEATURE, principal: PRINCIPAL }, effect.argument);

  reconciler.confirm(accepted.run);
  await reconciler.runUntilSettled();
  expect(reconciler.load(accepted.run).state.state).toBe('committed');
  reconciler.close();

  // Everything but the log, gone. A card that reaches for a side file now fails rather than passing quietly.
  for (const entry of readdirSync(paths.runDir)) {
    if (entry === 'events.jsonl') continue;
    rmSync(join(paths.runDir, entry), { recursive: true, force: true });
  }
  expect(readdirSync(paths.runDir)).toStrictEqual(['events.jsonl']);
  expect(statSync(paths.eventLog).size).toBeGreaterThan(0);

  return { run: accepted.run, questionId: asked.question.id, events: readEventLog(paths.eventLog) };
};

describe('all six cards render from one completed run event log, with nothing else on disk', () => {
  it('builds every surface from the log alone', async () => {
    const completed = await completedRunWithOnlyItsLog();
    const view = foldEvents(completed.events);

    const cards: readonly { readonly label: string; readonly card: Card }[] = [
      { label: 'question', card: buildQuestionCard({ view }) },
      { label: 'spec echo', card: buildSpecEchoCard({ view }) },
      {
        label: 'brief',
        card: buildBriefCard({
          fleet: foldFleet({ orchHome: home }),
          height: DEFAULT_BRIEF_HEIGHT,
          wrap: (line) => wrapLine(line, 80),
        }),
      },
      { label: 'kill', card: buildKillCard({ view }) },
      { label: 'completion', card: buildCompletionCard({ view }) },
      {
        label: 'handoff',
        // Derived from the run id the log's own envelopes carry, by the card, through the units that own the
        // two names. Nothing is passed in but the id and the home — no branch, no path, no payload field.
        card: buildHandoffCard({ view, run: completed.events[0]?.run ?? null, orchHome: home }),
      },
    ];

    for (const { label, card } of cards) {
      expect(card.title.trim(), label).not.toBe('');
      expect(cardLines(card).length, label).toBeGreaterThan(1);
      for (const row of cardLines(card).flatMap((line) => wrapLine(line, NARROW_COLUMNS))) {
        expect(row.length, `${label}: ${row}`).toBeLessThanOrEqual(NARROW_COLUMNS);
      }
    }

    // And the log really is the whole input: the feature is named, the steps are named, and no run id is
    // anywhere a person has to read (R6).
    expect(view.feature).toBe(FEATURE);
    expect(view.featureState).toBe('committed');
    expect(view.progress.steps.map((step) => step.step)).toStrictEqual(['implement', 'verify']);
    for (const { label, card } of cards) {
      if (label === 'handoff') continue;
      expect(cardText(card), label).not.toContain(completed.run);
    }
  });

  it('reconstructs the question, its answer and who answered it', async () => {
    const completed = await completedRunWithOnlyItsLog();
    const view = foldEvents(completed.events);
    const card = buildQuestionCard({ view });

    expect(card.state).toBe('resolved');
    expect(card.prompt).toBe(DRAFT.prompt);
    expect(cardText(card)).toContain(ANSWER);
    expect(card.outcome).toContain('answered');

    // The question id survived the AD-21 pass in the payload that carries it: the engine minted it
    // punctuated for exactly this reason, and the log reads back the id it was given.
    const asked = completed.events.find((event) => event.type === 'question.asked');
    expect(asked?.payload['question_id']).toBe(completed.questionId);
  });

  it('reconstructs the completion notice, with every unrecorded fact stated as unrecorded (R8)', async () => {
    const completed = await completedRunWithOnlyItsLog();
    const card = buildCompletionCard({ view: foldEvents(completed.events) });

    expect(card.merged).toBe(UNRECORDED_PRESENTATION);
    expect(card.fileCount).toBe(UNRECORDED_PRESENTATION);
    expect(card.testStatus).toBe(UNRECORDED_PRESENTATION);
    // The verified half is real, and folded from the log: the verification step this run completed.
    expect(card.verified).toStrictEqual(['verify']);
    expect(card.notVerified.length).toBeGreaterThan(0);
    expect(cardText(card)).toContain('nothing is needed from you');
  });

  it('reconstructs the brief from the run directories, with no checkpoint in reach', async () => {
    const completed = await completedRunWithOnlyItsLog();
    const brief = buildBriefCard({ fleet: foldFleet({ orchHome: home }) });

    // The run is committed, so it is not in flight — which is itself a fact read out of the log.
    expect(brief.inFlight).toBe(0);
    expect(cardText(brief)).toContain('nothing is in flight');
    expect(foldFleet({ orchHome: home }).runs.map((run) => run.view.feature)).toStrictEqual([FEATURE]);
    expect(completed.events.length).toBeGreaterThan(5);
  });

  it('reconstructs the acceptance criteria, which the log now carries (story 1-11, matrix 14)', async () => {
    const completed = await completedRunWithOnlyItsLog();
    const card = buildSpecEchoCard({ view: foldEvents(completed.events) });
    const plan = makePlan({ feature: FEATURE });

    // The inversion of story 1-10's pinned gap: this assertion used to say the criteria were *absent*.
    expect(card.unrecorded).toBe(false);
    expect(card.criteria.map((criterion) => criterion.text)).toStrictEqual([
      ...plan.acceptance_criteria,
    ]);
    expect(card.criteria.map((criterion) => criterion.line)).toStrictEqual([1, 2]);
    // Numbered and individually addressable, and confirmable in one keystroke (CAP-2).
    expect(cardText(card)).toContain(`press "${card.confirmKey}" to confirm all 2 as written`);
    expect(cardText(card)).not.toContain(UNRECORDED_PRESENTATION);
    // And it really is the log: each criterion is in the bytes on disk.
    for (const criterion of plan.acceptance_criteria) {
      expect(readFileSync(runPaths(completed.run, home).eventLog, 'utf8')).toContain(criterion);
    }
  });

  it('reconstructs the question’s consequences and counts down from asked_at (matrix 6)', async () => {
    const completed = await completedRunWithOnlyItsLog();
    const asked = completed.events.find((event) => event.type === 'question.asked');
    const askedAt = asked?.payload['asked_at'];
    if (typeof askedAt !== 'string') throw new Error('the log carries no asked_at');

    // Rendered as if the question were still open, at a known instant inside its window, so the countdown
    // is a number this test can name rather than one it has to trust.
    const pending = foldEvents(completed.events.filter((event) => event.type !== 'question.resolved'));
    const card = buildQuestionCard({
      view: pending,
      now: new Date(Date.parse(askedAt) + 60_000),
    });

    expect(card.brief).toBe(DRAFT.brief);
    expect(card.options.map((option) => option.id)).toStrictEqual(['poll', 'watch', 'ask-me']);
    for (const option of card.options) {
      expect(option.consequence, option.id).not.toBe(UNRECORDED_PRESENTATION);
      expect(option.consequence, option.id).not.toBe('');
    }
    // Every consequence the draft declared is on the card, verbatim.
    for (const declared of [...DRAFT.options, DRAFT.escape]) {
      expect(cardText(card)).toContain(declared.consequence);
    }
    // Q2 — nine minutes of a ten-minute window, counted down from the log's own instant.
    expect(card.window).toBe('9m00s left before the default is taken');
    expect(card.options.filter((option) => option.recommended).map((option) => option.id)).toStrictEqual([
      'poll',
    ]);
  });

  it('names the takeover branch and the document, derived from the envelope’s run (matrix 7)', async () => {
    const completed = await completedRunWithOnlyItsLog();
    const view = foldEvents(completed.events);
    const run = completed.events[0]?.run;
    if (run === undefined) throw new Error('the log carries no run id');

    const card = buildHandoffCard({ view, run, orchHome: home });
    // The names come from their owners: `takeoverBranchFor` and the AD-9 paths, called by the card.
    expect(card.branch).toBe(takeoverBranchFor(run));
    expect(card.document).toBe(runPaths(run, home).handoffDocument);
    expect(card.nextStep).toContain(`git checkout ${takeoverBranchFor(run)}`);

    // And nothing was added to the payload to make it possible: no `handoff.recorded` line carries either.
    for (const event of completed.events) {
      expect(Object.keys(event.payload)).not.toContain('branch');
      expect(Object.keys(event.payload)).not.toContain('document');
    }

    // Without the run id it still says so rather than guessing at a pattern it does not own (AD-22).
    expect(buildHandoffCard({ view }).branch).toBe(UNRECORDED_PRESENTATION);
  });

  it('reconstructs what the run consumed, or says it was not measured — never a zero (matrix 12)', async () => {
    const completed = await completedRunWithOnlyItsLog();
    const view = foldEvents(completed.events);
    const card = buildCompletionCard({ view });

    // The scripted executor reports no usage, which is exactly the case R8 is about.
    expect(view.usage.total).toBeNull();
    expect(card.tokens).toBe(UNRECORDED_PRESENTATION);
    expect(cardText(card)).not.toContain('$0.00');
    expect(cardText(card)).not.toContain('0.0000');
  });

  it('leaves no checkpoint for a card to have read', async () => {
    const completed = await completedRunWithOnlyItsLog();
    const paths = runPaths(completed.run, home);
    expect(readdirSync(paths.runDir)).toStrictEqual(['events.jsonl']);
    // Every line is one whole JSON object, which is what makes the log replayable at all (AD-4, AD-5).
    for (const line of readFileSync(paths.eventLog, 'utf8').trim().split('\n')) {
      expect(() => JSON.parse(line) as unknown).not.toThrow();
    }
  });
});
