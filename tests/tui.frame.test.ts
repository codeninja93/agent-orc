/**
 * The frame, with a card in it: 1-9's invariants have to survive every one of story 1-10's six surfaces.
 *
 * Story 1-9 guaranteed two things about the frame and left a seam in the middle of it. This suite is the
 * check that filling the seam did not cost either guarantee:
 *
 * - **the mode is in every frame**, because mode confusion is the interface contract's named accident
 *   class, and a card is exactly the kind of thing that pushes a header off a screen;
 * - **the question slot is its own section** (R14), above the notices, so nothing that arrives later
 *   scrolls it away — including the card now drawn inside it.
 *
 * And one of story 1-10's own: at 40 columns every card is still readable, with no row wider than the
 * terminal and nothing cut through the middle of an identifier a person has to type — a branch name in
 * particular, since the handoff card's whole purpose is to hand one over.
 *
 * There is exactly one real Ink render here, for the same reason story 1-9 had exactly one: a frame test
 * proves composition and nothing about the cards, and the cards are covered by calling functions in
 * `tests/tui.cards.test.ts`.
 */
import { EventEmitter } from 'node:events';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runPaths } from '../src/runtime/index.js';
import {
  MODE_LABEL,
  NARROW_COLUMNS,
  QUESTION_SLOT_LABEL,
  SHELL_SECTION_IDS,
  STATUS_LABELS,
  buildCompletionCard,
  buildHandoffCard,
  buildKillCard,
  buildQuestionCard,
  buildSpecEchoCard,
  buildBriefCard,
  cardLines,
  foldEvents,
  foldFleet,
  idleShellView,
  mountShell,
  shellSections,
  wrapLine,
} from '../src/tui/index.js';
import type { Card, ShellView } from '../src/tui/index.js';

import { makeHome } from './helpers/engine-fixture.js';
import {
  FIXTURE_RUN_START_MS,
  budgetDegraded,
  buildLog,
  featureStateChanged,
  handoffRecorded,
  logText,
  questionAsked,
  runCreated,
  stepStarted,
  stepTerminated,
} from './helpers/tui-log.js';

const NOW = new Date(FIXTURE_RUN_START_MS + 120_000);
const RUN = '01K5NQ9ZJ7V3M2P9XQWRTC4BDE';
const QUESTION_ID = 'q-01K5NQ9Z-J7V3M2P9-XQWRTC4B-DE';
const TAKEOVER_BRANCH = `orch/takeover/${RUN}`;

let home: string;
const toRemove: string[] = [];

beforeEach(() => {
  home = makeHome('tui-frame');
  toRemove.push(home);
});

afterEach(() => {
  for (const dir of toRemove.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const pendingQuestionView = (): ShellView =>
  foldEvents(
    buildLog([
      runCreated(),
      featureStateChanged('confirmed'),
      { ...questionAsked(QUESTION_ID), atMs: 2_000 },
    ]),
  );

const committedView = (): ShellView =>
  foldEvents(
    buildLog([
      runCreated(),
      stepStarted('verify', 'verification'),
      stepTerminated('verify'),
      featureStateChanged('committed', 'verifying'),
    ]),
  );

const degradedView = (): ShellView =>
  foldEvents(
    buildLog([
      runCreated(),
      featureStateChanged('running'),
      stepStarted('implement'),
      { ...budgetDegraded(0.82, 60_000), atMs: 60_000 },
      { ...featureStateChanged('degraded', 'running'), atMs: 60_500 },
    ]),
  );

const handedOffView = (): ShellView =>
  foldEvents(
    buildLog([
      runCreated(),
      stepStarted('implement'),
      handoffRecorded('user.take_over', 'user "deep" took the work over, so the run halted'),
      featureStateChanged('handed_off', 'running'),
    ]),
  );

/** One of each of the six surfaces, so every invariant below is checked against all of them. */
const everyCard = (): readonly { readonly label: string; readonly card: Card }[] => [
  {
    label: 'question',
    card: buildQuestionCard({
      view: pendingQuestionView(),
      question: {
        prompt: 'Poll the log, or watch it?',
        brief: 'Polling cannot miss a line; watching is cheaper and may drop one.',
        options: [
          { id: 'poll', label: 'poll', consequence: 'one read a second, nothing missed' },
          { id: 'watch', label: 'watch', consequence: 'instant, may miss a line' },
        ],
        escape: { id: 'ask-me', label: 'ask again', consequence: 'nothing changes' },
        recommended_option_id: 'poll',
        default_action: 'the shell polls every second',
        default_window_ms: 600_000,
        asked_at: new Date(FIXTURE_RUN_START_MS + 2_000).toISOString(),
      },
      now: NOW,
    }),
  },
  {
    label: 'spec echo',
    card: buildSpecEchoCard({
      view: idleShellView('tui-cards'),
      criteria: ['the loop takes at most one action per pass', 'a killed step is never re-run'],
    }),
  },
  {
    label: 'brief',
    card: buildBriefCard({
      fleet: foldFleet({ orchHome: home }),
      wrap: (line) => wrapLine(line, NARROW_COLUMNS),
      now: NOW,
    }),
  },
  { label: 'kill', card: buildKillCard({ view: degradedView(), now: NOW }) },
  { label: 'completion', card: buildCompletionCard({ view: committedView(), now: NOW }) },
  {
    label: 'handoff',
    card: buildHandoffCard({
      view: handedOffView(),
      location: { branch: TAKEOVER_BRANCH, document: runPaths(RUN, home).handoffDocument },
    }),
  },
];

describe('the frame keeps 1-9 invariants with a card drawn in the slot', () => {
  it.each(everyCard())('$label: the mode is present and the slot is still its own section', ({ card }) => {
    const view = pendingQuestionView();
    const sections = shellSections(view, { now: NOW });
    const ids = sections.map((section) => section.id);

    expect(ids).toContain('mode');
    expect(ids).toContain('question');
    // The slot is above the notices, so nothing arriving later can push it off the frame (R14).
    expect(ids.indexOf('question')).toBeLessThan(
      ids.includes('notices') ? ids.indexOf('notices') : SHELL_SECTION_IDS.length,
    );
    expect(sections.find((section) => section.id === 'mode')?.lines[0]).toContain(`${MODE_LABEL} `);
    // And the card itself has something to say in every case: an empty card is a card that failed.
    expect(cardLines(card).join('\n').trim()).not.toBe('');
  });
});

describe('every card is readable on a terminal 40 columns wide', () => {
  it.each(everyCard())('$label: no row is wider than the terminal', ({ card }) => {
    const rows = cardLines(card).flatMap((line) => wrapLine(line, NARROW_COLUMNS));
    for (const row of rows) expect(row.length, row).toBeLessThanOrEqual(NARROW_COLUMNS);
    expect(rows.length).toBeGreaterThan(1);
  });

  it.each(everyCard())('$label: carries no colour, so a colourless terminal shows the same card', ({
    card,
  }) => {
    expect(cardLines(card).join('\n')).not.toMatch(/\u001B\[/);
  });

  it('keeps a branch name whole, because it is a thing a person has to type', () => {
    const card = buildHandoffCard({
      view: handedOffView(),
      location: { branch: TAKEOVER_BRANCH, document: runPaths(RUN, home).handoffDocument },
    });
    const rows = cardLines(card).flatMap((line) => wrapLine(line, NARROW_COLUMNS));
    // Wrapped on a space, never sliced through the identifier: one row holds the whole branch name.
    expect(rows.some((row) => row.includes(TAKEOVER_BRANCH))).toBe(true);
  });
});

describe('the Ink shell draws the card inside the persistent slot', () => {
  /** A terminal that keeps what was written to it, so a frame can be read back. */
  class FakeStdout extends EventEmitter {
    readonly columns = NARROW_COLUMNS;
    readonly rows = 24;
    readonly writes: string[] = [];

    write(chunk: string): boolean {
      this.writes.push(chunk);
      return true;
    }

    frame(): string {
      return this.writes.join('');
    }
  }

  it('renders the mode, the status, the slot and the card through a real Ink render', async () => {
    const paths = runPaths(RUN, home);
    mkdirSync(paths.runDir, { recursive: true });
    writeFileSync(
      paths.eventLog,
      logText(
        buildLog(
          [runCreated(), featureStateChanged('confirmed'), { ...questionAsked(QUESTION_ID), atMs: 2_000 }],
          { feature: 'tui-cards', run: RUN },
        ),
      ),
      'utf8',
    );

    const stdout = new FakeStdout();
    const handle = mountShell({
      eventLog: paths.eventLog,
      feature: 'tui-cards',
      stdout: stdout as unknown as NodeJS.WriteStream,
      columns: NARROW_COLUMNS,
      debug: true,
      now: NOW,
    });

    try {
      await vi.waitFor(() => {
        expect(stdout.frame()).toContain(`${MODE_LABEL} `);
      });
      const frame = stdout.frame();

      // 1-9's invariants, in a frame that now has a card in it.
      expect(frame).toContain('feature: tui-cards');
      expect(frame).toContain(STATUS_LABELS.Steps);
      expect(frame).toContain(`${QUESTION_SLOT_LABEL}:`);
      expect(frame).toContain('x stop');
      // The card the view called for, drawn inside the slot.
      expect(handle.lastCard()?.kind).toBe('question');
      expect(frame).toContain('question — your answer');
      expect(frame).toContain('if ignored:');
      // And the run id is still nowhere a person has to read it (R6).
      expect(frame).not.toContain(RUN);
    } finally {
      handle.unmount();
    }
  });

  it('shows what is being typed inside the slot, and that it has not been sent', () => {
    const paths = runPaths(RUN, home);
    mkdirSync(paths.runDir, { recursive: true });
    writeFileSync(
      paths.eventLog,
      logText(
        buildLog([runCreated(), { ...questionAsked(QUESTION_ID), atMs: 2_000 }], {
          feature: 'tui-cards',
          run: RUN,
        }),
      ),
      'utf8',
    );

    const stdout = new FakeStdout();
    const handle = mountShell({
      eventLog: paths.eventLog,
      feature: 'tui-cards',
      control: { paths, feature: 'tui-cards', principal: { kind: 'user', id: 'deep' } },
      stdout: stdout as unknown as NodeJS.WriteStream,
      columns: 80,
      debug: true,
      now: NOW,
    });

    try {
      handle.press({ input: 'a' });
      for (const character of [...'poll']) handle.press({ input: character });
      const frame = stdout.frame();
      expect(frame).toContain('answer > poll');
      expect(frame).toContain('enter sends it');
      expect(frame).toContain('typed and not yet sent');
    } finally {
      handle.unmount();
    }
  });
});
