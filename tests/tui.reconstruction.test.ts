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
import { readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { QuestionDraft, StepUsage } from '../src/contracts/index.js';
import {
  Reconciler,
  createRecordingResetter,
  createScriptedExecutor,
  takeoverBranchFor,
  terminated,
} from '../src/engine/index.js';
import type { WorktreeGit } from '../src/engine/index.js';
import { readEventLog, runPaths } from '../src/runtime/index.js';
import type { EventEnvelope } from '../src/contracts/index.js';
import {
  DEFAULT_BRIEF_HEIGHT,
  NARROW_COLUMNS,
  STATUS_UNRECORDED,
  UNRECORDED_PRESENTATION,
  buildBriefCard,
  buildCompletionCard,
  buildHandoffCard,
  buildKillCard,
  buildQuestionCard,
  buildSpecEchoCard,
  cardLines,
  cardText,
  displayWidth,
  foldEvents,
  foldFleet,
  invokeControl,
  reduceKeys,
  typedKeys,
  wrapLine,
} from '../src/tui/index.js';
import type { Card } from '../src/tui/index.js';

import {
  fixtureGit,
  makeGitWorktree,
  makeHome,
  makePlan,
  planProvider,
} from './helpers/engine-fixture.js';
import type { GitWorktree } from './helpers/engine-fixture.js';

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

/**
 * The environment-pinned git the escape hatch runs through.
 *
 * A take-over commits the partial work onto an ordinary branch (CAP-23, AD-22), so the fixture drives a
 * real repository: a fake could not tell a branch that holds the work from one that does not. The global
 * and system configuration are neutralised by `fixtureGit`, so a developer's own hooks or `commit.gpgsign`
 * cannot make this behave differently here than in CI.
 */
const fixtureWorktreeGit: WorktreeGit = (worktree, args) => {
  try {
    return { status: 0, stdout: fixtureGit(worktree, args), stderr: '' };
  } catch (thrown: unknown) {
    const error = thrown as { status?: number; stderr?: Buffer | string } | null;
    const stderr = error?.stderr;
    return {
      status: typeof error?.status === 'number' ? error.status : 1,
      stdout: '',
      stderr: typeof stderr === 'string' ? stderr : (stderr?.toString('utf8') ?? 'git failed'),
    };
  }
};

const freshWorktree = (label: string): GitWorktree => {
  const worktree = makeGitWorktree(label);
  toRemove.push(worktree.dir);
  return worktree;
};

/** What a step reports having consumed, so the kill card's usage is folded rather than injected (R10). */
const STEP_USAGE: StepUsage = {
  cost_usd: 0.42,
  input_tokens: 12_480,
  output_tokens: 3_150,
  cache_creation_input_tokens: 2_048,
  cache_read_input_tokens: 9_216,
};

const HANDED_OFF_FEATURE = 'tui-reconstruction-handoff';
const IN_FLIGHT_FEATURE = 'tui-reconstruction-in-flight';

interface HandedOffRun {
  readonly run: string;
  readonly events: readonly EventEnvelope[];
}

/**
 * A run a **person** took over, through the keys their fingers actually press, with only its log left.
 *
 * The take-over is not a method call: `t` goes through {@link reduceKeys}, the effect it names goes through
 * `invokeControl`, one durable intent file lands in `commands/` (AD-19) and the reconciler's next pass
 * consumes it. That is the whole point — the defect this fixture exists to pin was on the *intent* path and
 * not on the AD-35 disposition path, so a fixture that called `reconciler.takeOver` would have gone on
 * passing while a person's take-over recorded nothing.
 *
 * Each step reports usage, so the kill card built from this log states what the run consumed from the log
 * rather than from an injected fact.
 */
const handedOffRunWithOnlyItsLog = async (): Promise<HandedOffRun> => {
  const worktree = freshWorktree('tui-reconstruction-handoff');
  const plan = makePlan({ feature: HANDED_OFF_FEATURE, worktree: worktree.dir });
  const reconciler = Reconciler.open({
    orchHome: home,
    executor: createScriptedExecutor({
      sessionIdFor: (request) => `sess-${request.step}`,
      onStart: (request) => {
        // Real work in the worktree, as there is when somebody decides to take it over.
        writeFileSync(
          join(request.worktree, 'src', `${request.step}.ts`),
          `export const ${request.step} = 'half done';\n`,
          'utf8',
        );
        return terminated(request.step, 'completed', {
          sessionId: `sess-${request.step}`,
          usage: STEP_USAGE,
        });
      },
    }),
    plans: planProvider(plan),
    baseline: createRecordingResetter(BASELINE),
    worktreeGit: fixtureWorktreeGit,
  });
  toClose.push(reconciler);

  const accepted = reconciler.acceptFeature(plan);
  const paths = runPaths(accepted.run, home);
  reconciler.confirm(accepted.run);
  await reconciler.pass();

  const { effects } = reduceKeys([{ input: 't' }]);
  const effect = effects.find((candidate) => candidate.kind === 'invoke');
  if (effect?.kind !== 'invoke') throw new Error('pressing "t" did not invoke a control');
  expect(effect.command).toBe('take_over');
  invokeControl(effect.command, { paths, feature: HANDED_OFF_FEATURE, principal: PRINCIPAL }, effect.argument);

  await reconciler.pass();
  expect(reconciler.load(accepted.run).state.state).toBe('handed_off');
  reconciler.close();

  for (const entry of readdirSync(paths.runDir)) {
    if (entry === 'events.jsonl') continue;
    rmSync(join(paths.runDir, entry), { recursive: true, force: true });
  }
  expect(readdirSync(paths.runDir)).toStrictEqual(['events.jsonl']);

  return { run: accepted.run, events: readEventLog(paths.eventLog) };
};

/**
 * A run left mid-flight, so the brief has a real entry to fold rather than reporting an empty fleet.
 *
 * Confirmed and started and then left alone: `drafting` would be in flight too, but a run that never ran a
 * step records no step name and no instant, and an entry whose every column reads `(not recorded)` proves
 * only that the builder tolerates absence.
 */
const inFlightRunWithOnlyItsLog = async (): Promise<string> => {
  const worktree = freshWorktree('tui-reconstruction-in-flight');
  const plan = makePlan({ feature: IN_FLIGHT_FEATURE, worktree: worktree.dir });
  const reconciler = Reconciler.open({
    orchHome: home,
    executor: createScriptedExecutor({
      sessionIdFor: (request) => `sess-${request.step}`,
      onStart: (request) =>
        terminated(request.step, 'completed', {
          sessionId: `sess-${request.step}`,
          usage: STEP_USAGE,
        }),
    }),
    plans: planProvider(plan),
    baseline: createRecordingResetter(BASELINE),
    worktreeGit: fixtureWorktreeGit,
  });
  toClose.push(reconciler);

  const accepted = reconciler.acceptFeature(plan);
  reconciler.confirm(accepted.run);
  // One pass only: the first step completes and the run is left `running`, which is what "in flight" is.
  await reconciler.pass();
  expect(reconciler.load(accepted.run).state.state).toBe('running');
  reconciler.close();

  const paths = runPaths(accepted.run, home);
  for (const entry of readdirSync(paths.runDir)) {
    if (entry === 'events.jsonl') continue;
    rmSync(join(paths.runDir, entry), { recursive: true, force: true });
  }
  return accepted.run;
};

/**
 * The words a card carries that no wrap can break without cutting through the middle of one.
 *
 * Matrix 15 asks for two things at 40 columns — "no row wider than the width, nothing truncated
 * mid-identifier" — and only the first was being checked, by an assertion that could not fail: the rows
 * were produced by `wrapLine`, which hard-slices any word wider than the width, so measuring them asserted
 * a property of the wrapper. This measures the **card's own** words instead, in terminal cells, so a card
 * that acquires an unbreakable token wider than the narrow terminal fails here rather than being silently
 * cut in half on a person's screen.
 */
const overWideWords = (card: Card): readonly string[] =>
  cardLines(card)
    .flatMap((line) => line.split(/\s+/))
    .filter((word) => displayWidth(word) > NARROW_COLUMNS);

describe('all six cards render from one completed run event log, with nothing else on disk', () => {
  /**
   * The gate's evidence, and it has to observe what it claims.
   *
   * Three runs rather than one, because building all six cards from a single **committed** run made three
   * of them degenerate and nothing noticed: the brief said "nothing is in flight" (a committed run folds to
   * zero entries), the kill card stated nothing R11 exists for, and the handoff card rendered its "the log
   * records no reason" fallback, because a committed run carries no hand-off. Each was a card that rendered
   * *something*, which is all the assertions checked, and the gate's claim is not that six builders return
   * a value — it is that the six required surfaces are reconstructable from logs alone.
   *
   * So each card is built from a run in the state that card exists for, and all three runs live under one
   * `ORCH_HOME` with nothing but `events.jsonl` left in any of them.
   */
  it('builds every surface from the log alone, each in the state that surface exists for', async () => {
    const completed = await completedRunWithOnlyItsLog();
    const handedOff = await handedOffRunWithOnlyItsLog();
    await inFlightRunWithOnlyItsLog();

    const view = foldEvents(completed.events);
    const handedOffView = foldEvents(handedOff.events);
    const fleet = foldFleet({ orchHome: home });

    const cards: readonly { readonly label: string; readonly card: Card }[] = [
      { label: 'question', card: buildQuestionCard({ view }) },
      { label: 'spec echo', card: buildSpecEchoCard({ view }) },
      {
        label: 'brief',
        card: buildBriefCard({
          fleet,
          height: DEFAULT_BRIEF_HEIGHT,
          wrap: (line) => wrapLine(line, 80),
        }),
      },
      // The kill card from the run that recorded usage, so R10's number is folded rather than absent.
      { label: 'kill', card: buildKillCard({ view: handedOffView }) },
      { label: 'completion', card: buildCompletionCard({ view }) },
      {
        label: 'handoff',
        // From a run a person really took over, so the card states the hand-off rather than its fallback.
        // Derived from the run id the log's own envelopes carry, by the card, through the units that own
        // the two names. Nothing is passed in but the id and the home — no branch, no path, no payload
        // field.
        card: buildHandoffCard({
          view: handedOffView,
          run: handedOff.events[0]?.run ?? null,
          orchHome: home,
        }),
      },
    ];

    for (const { label, card } of cards) {
      expect(card.title.trim(), label).not.toBe('');
      expect(cardLines(card).length, label).toBeGreaterThan(1);
      for (const row of cardLines(card).flatMap((line) => wrapLine(line, NARROW_COLUMNS))) {
        expect(row.length, `${label}: ${row}`).toBeLessThanOrEqual(NARROW_COLUMNS);
      }
      /**
       * Matrix 15's second half, and the one that can fail.
       *
       * The row check above cannot: its rows come from `wrapLine`, which hard-slices any word wider than
       * the width, so it asserts a property of the wrapper rather than of the card. This measures the
       * **card's own** words, in terminal cells, so a card that acquires an unbreakable token wider than a
       * narrow terminal — a run id leaking into prose, an undivided identifier, a URL — fails here.
       *
       * The handoff card is excluded and asserted separately below, because it is the one card that states
       * things whose length a *machine* chose: the absolute path of the note, and the worktree the escape
       * hatch quoted into its reason. Neither fits forty columns on any real machine, and neither is
       * something a person retypes.
       */
      if (label !== 'handoff') {
        expect(
          overWideWords(card),
          `${label}: words wider than ${String(NARROW_COLUMNS)} cells`,
        ).toStrictEqual([]);
      }
    }

    /**
     * What matrix 15 is actually protecting on the handoff card: the identifier a person has to retype.
     *
     * The branch name is the one string on any card that is copied by hand, so it is the one that must
     * survive the narrow terminal in one piece — and it does, at exactly forty cells, which is a property
     * of `takeoverBranchFor` this assertion pins rather than assumes.
     */
    const branch = takeoverBranchFor(handedOff.run);
    expect(displayWidth(branch)).toBeLessThanOrEqual(NARROW_COLUMNS);
    const handoffCard = cards.find((entry) => entry.label === 'handoff')?.card;
    if (handoffCard?.kind !== 'handoff') throw new Error('the handoff card was not built');
    expect(
      cardLines(handoffCard).flatMap((line) => wrapLine(line, NARROW_COLUMNS)),
    ).toContain(branch);

    // Matrix 13 — the card states *why*, from the log, and not the fallback a run with no recorded reason
    // gets. This is the half the gate could not observe while the take-over path appended no line at all.
    expect(handoffCard.why).toContain('took the work over');
    expect(handoffCard.why).not.toContain('the log records no reason');
    /**
     * And the fact is in the log under the type that declares it, which is the gate's own claim.
     *
     * Asserted here as well as on the card because the two are no longer the same assertion: the fold now
     * also reads the `handoff_code` a `command.applied` line carries (AD-5, so an older log still states
     * why), which means a card that reads correctly no longer proves that `handoff.recorded` was written.
     * AD-5 makes the event vocabulary the shared thing every emitter and reader is built against, so a
     * hand-off recorded by two of three paths is a vocabulary with a hole in it.
     */
    expect(
      handedOff.events.filter((event) => event.type === 'handoff.recorded').map((e) => e.payload['code']),
    ).toStrictEqual(['user.take_over']);

    // And the log really is the whole input: the feature is named, the steps are named, and no run id is
    // anywhere a person has to read (R6).
    expect(view.feature).toBe(FEATURE);
    expect(view.featureState).toBe('committed');
    expect(handedOffView.featureState).toBe('handed_off');
    expect(view.progress.steps.map((step) => step.step)).toStrictEqual(['implement', 'verify']);
    for (const { label, card } of cards) {
      if (label === 'handoff') continue;
      expect(cardText(card), label).not.toContain(completed.run);
      expect(cardText(card), label).not.toContain(handedOff.run);
    }
  });

  /**
   * The handoff card names the take-over, and the log is why it can.
   *
   * This is the assertion the engine defect hid. `handoff.recorded` was emitted at exactly one place — the
   * private `handOff`, reached from the AD-35 `hand-off` disposition and the baseline-reset failure — so
   * the *intent* path a person's `t` takes wrote `HANDOFF.md` and appended no line of that type at all. The
   * card, which reads the fold's hand-off, therefore rendered "the log records no reason" for the commonest
   * hand-off there is, and AD-4 makes the log the only durable truth.
   */
  it('names the take-over a person drove, rather than the no-reason fallback (patch 1)', async () => {
    const handedOff = await handedOffRunWithOnlyItsLog();

    const recorded = handedOff.events.filter((event) => event.type === 'handoff.recorded');
    expect(recorded.map((event) => event.payload['code'])).toStrictEqual(['user.take_over']);
    const reason = recorded[0]?.payload['reason'];
    expect(typeof reason === 'string' ? reason : '').toContain('took the work over');

    // The line lands before `command.applied`, which is the ledger entry that carries `to_state` and the
    // one that retires the intent (story 1-7): a crash in between redelivers the intent rather than
    // leaving a run recorded as `handed_off` with its reason lost.
    const recordedSeq = recorded[0]?.seq;
    // The *take-over's own* `command.applied`, not the `confirm_spec` one earlier in the same log.
    const appliedSeq = handedOff.events.find(
      (event) => event.type === 'command.applied' && event.payload['command'] === 'take_over',
    )?.seq;
    if (recordedSeq === undefined || appliedSeq === undefined) {
      throw new Error('the log carries no take-over hand-off');
    }
    expect(recordedSeq).toBeLessThan(appliedSeq);

    const view = foldEvents(handedOff.events);
    const card = buildHandoffCard({ view, run: handedOff.run, orchHome: home });
    expect(card.why).toContain('took the work over');
    expect(card.why).not.toContain('the log records no reason');
    expect(card.branch).toBe(takeoverBranchFor(handedOff.run));
  });

  /**
   * The brief folds a run that is actually in flight (CAP-22).
   *
   * The gate's brief used to be built from a home holding one *committed* run, so it folded zero entries
   * and rendered "nothing is in flight" — a sentence that exercises the empty branch and says nothing about
   * whether a feature's line is right.
   */
  it('folds a real in-flight feature into the brief, from its log alone (CAP-22)', async () => {
    await completedRunWithOnlyItsLog();
    await handedOffRunWithOnlyItsLog();
    await inFlightRunWithOnlyItsLog();

    const brief = buildBriefCard({
      fleet: foldFleet({ orchHome: home }),
      height: DEFAULT_BRIEF_HEIGHT,
      wrap: (line) => wrapLine(line, 80),
    });

    // One of the three runs is still running; the committed one and the handed-off one are finished.
    expect(brief.inFlight).toBe(1);
    expect(brief.entries.map((entry) => entry.feature)).toStrictEqual([IN_FLIGHT_FEATURE]);
    expect(cardText(brief)).not.toContain('nothing is in flight');

    const entry = brief.entries[0];
    if (entry === undefined) throw new Error('the brief folded no entry');
    // What it needs and what it cost are both read out of the log, not stated as unrecorded.
    expect(entry.problem).toBeNull();
    expect(entry.needs).not.toBe(UNRECORDED_PRESENTATION);
    expect(entry.needs).not.toContain('could not be read');
    expect(entry.usage).not.toBe(UNRECORDED_PRESENTATION);
    expect(entry.cost).toContain('1 of 2');
    // R6 — a run id is never something a person has to read, even in a fleet fold.
    for (const run of foldFleet({ orchHome: home }).runs) {
      expect(cardText(brief)).not.toContain(run.runId);
    }
  });

  /**
   * The kill card's numbers come from the log — and what the log does not carry is pinned as absent.
   *
   * R10's token counts are folded from the `step.terminated` lines the run really wrote. The other two
   * halves of R11's sentence are **not** in any stage-1 log and this states so rather than leaving it
   * unobserved: nothing in `src/engine/` emits `budget.degraded` or `budget.exhausted`, and `run.created`
   * carries `{ mode, step_count }` with no `wall_clock_ms_estimate` — ceilings and their estimate are story
   * 2-9's, which this story's Boundaries say explicitly. The day one is recorded, this assertion is the
   * reminder that the card can now say more.
   */
  it('folds the kill card’s usage out of the log, and states the estimate it has none of (R10, R11)', async () => {
    const handedOff = await handedOffRunWithOnlyItsLog();
    const view = foldEvents(handedOff.events);
    const card = buildKillCard({ view });

    // One step ran, and reported this.
    expect(view.usage.total).toStrictEqual(STEP_USAGE);
    expect(card.tokens).not.toBe(UNRECORDED_PRESENTATION);
    expect(card.tokens).toContain('out');
    expect(cardText(card)).toContain(card.tokens);
    // R10 — subscription usage, never currency, whatever the CLI reported.
    expect(cardText(card)).not.toContain('0.42');
    expect(cardText(card)).not.toContain('$');

    // The two facts no stage-1 log carries, stated as absent rather than invented.
    expect(view.usage.estimateMs).toBeNull();
    expect(view.usage.rateLimitBudgetConsumed).toBeNull();
    expect(card.elapsed).toContain('no estimate recorded');
    expect(card.overEstimate).toBe(false);
    expect(card.usage).toBe(STATUS_UNRECORDED);
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
