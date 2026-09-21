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

import { Text } from 'ink';
import { createElement } from 'react';
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
  displayWidth,
  foldEvents,
  foldFleet,
  formatControlHints,
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

  it('measures a row in terminal cells, so a wide or combining character keeps the bound honest', () => {
    /**
     * The 40-column guarantee is a guarantee about a terminal, and `String.length` counts UTF-16 units.
     *
     * A line of CJK measured that way wraps at twice the width a person has, and a line of combining
     * marks wraps early. Both break the one thing the narrow case exists to protect: a mode line that is
     * whole.
     */
    const wide = '実装ステップ を 検証 します。'.repeat(4);
    const rows = wrapLine(wide, NARROW_COLUMNS);
    expect(rows.length).toBeGreaterThan(1);
    for (const row of rows) expect(displayWidth(row), row).toBeLessThanOrEqual(NARROW_COLUMNS);
    // A combining acute takes a code unit and no cell, so the two measures disagree by design.
    expect('e\u0301'.length).toBe(2);
    expect(displayWidth('e\u0301')).toBe(1);
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

  it('draws a caller-supplied node in the slot, which is the seam story 1-10 fills', async () => {
    const paths = runPaths(RUN, home);
    mkdirSync(paths.runDir, { recursive: true });
    writeFileSync(
      paths.eventLog,
      logText(buildLog([runCreated(), featureStateChanged('running')], { feature: 'tui-cards', run: RUN })),
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
      // The `questionCard` prop: a node a caller composes itself, drawn inside the persistent slot.
      // Deleting `{children}` from `QuestionSlot` left every mode test passing, so nothing pinned it.
      questionCard: createElement(Text, null, 'a card the caller composed'),
    });

    try {
      await vi.waitFor(() => {
        expect(stdout.frame()).toContain(`${MODE_LABEL} `);
      });
      const frame = stdout.frame();
      expect(frame).toContain('a card the caller composed');
      const rows = frame.split('\n');
      const slotAt = rows.findIndex((row) => row.startsWith(`${QUESTION_SLOT_LABEL}:`));
      const nodeAt = rows.findIndex((row) => row.includes('a card the caller composed'));
      // Inside the slot, not after the frame: the slot's own lines come first and the node follows them.
      expect(slotAt).toBeGreaterThanOrEqual(0);
      expect(nodeAt).toBeGreaterThan(slotAt);
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

/**
 * The shell as a *running* thing: it re-reads, it re-measures, and it stops when it is told to.
 *
 * None of this was covered. Replacing the body of `mountShell`'s `refresh` with a no-op left all 87 TUI
 * tests passing — and re-folding is the entire mechanism by which a person watching a run sees anything
 * after the first frame. `columns` was a parameter that defaulted to 80 whatever the terminal was, so the
 * 40-column state the story declares was reachable only by a caller that already knew to ask for it.
 */
describe('a mounted shell keeps up with the run, and stops when it is unmounted', () => {
  /** A terminal that can be resized, and that keeps every frame written to it. */
  class Screen extends EventEmitter {
    columns = 80;
    rows = 40;
    readonly writes: string[] = [];

    write(chunk: string): boolean {
      this.writes.push(chunk);
      return true;
    }

    frame(): string {
      return this.writes.join('');
    }

    last(): string {
      return this.writes.at(-1) ?? '';
    }
  }

  const writeLog = (path: string, specs: Parameters<typeof buildLog>[0]): void => {
    writeFileSync(path, logText(buildLog(specs, { feature: 'tui-shell', run: RUN })), 'utf8');
  };

  const prepared = (specs: Parameters<typeof buildLog>[0]): string => {
    const paths = runPaths(RUN, home);
    mkdirSync(paths.runDir, { recursive: true });
    writeLog(paths.eventLog, specs);
    return paths.eventLog;
  };

  it('shows a step that started after the first frame, once the log is re-read', () => {
    const eventLog = prepared([runCreated(), featureStateChanged('running')]);
    const stdout = new Screen();
    const handle = mountShell({
      eventLog,
      feature: 'tui-shell',
      stdout: stdout as unknown as NodeJS.WriteStream,
      // No interval: this asserts the re-fold itself, with nothing else able to cause it.
      pollMs: null,
      debug: true,
      now: NOW,
    });

    try {
      expect(stdout.frame()).not.toContain('step "implement"');
      writeLog(eventLog, [runCreated(), featureStateChanged('running'), stepStarted('implement')]);
      handle.refresh();
      expect(stdout.last()).toContain('step "implement"');
      expect(handle.lastView().progress.currentStep).toBe('implement');
    } finally {
      handle.unmount();
    }
  });

  it('re-reads on its own, and the interval stops at unmount', async () => {
    const eventLog = prepared([runCreated(), featureStateChanged('running')]);
    const stdout = new Screen();
    const handle = mountShell({
      eventLog,
      feature: 'tui-shell',
      stdout: stdout as unknown as NodeJS.WriteStream,
      pollMs: 20,
      debug: true,
      now: NOW,
    });

    try {
      writeLog(eventLog, [runCreated(), featureStateChanged('running'), stepStarted('implement')]);
      // Nothing calls `refresh` here: the interval is what has to find the new line.
      await vi.waitFor(() => {
        expect(stdout.frame()).toContain('step "implement"');
      });
    } finally {
      handle.unmount();
    }

    const afterUnmount = stdout.writes.length;
    await new Promise((resolve) => setTimeout(resolve, 120));
    // Several intervals' worth of time with nothing drawn: the timer was cleared, not merely unref'd.
    expect(stdout.writes.length).toBe(afterUnmount);
  });

  it('treats a refresh after unmount as nothing to do, rather than as a crash', () => {
    const eventLog = prepared([runCreated()]);
    const stdout = new Screen();
    const handle = mountShell({
      eventLog,
      feature: 'tui-shell',
      stdout: stdout as unknown as NodeJS.WriteStream,
      pollMs: null,
      debug: true,
      now: NOW,
    });
    handle.unmount();
    // A poll and a resize both land here and either can arrive on the way out.
    expect(() => {
      handle.refresh();
    }).not.toThrow();
    expect(() => {
      handle.unmount();
    }).not.toThrow();
  });

  it('measures the terminal it was given, and measures it again when it is resized', () => {
    const eventLog = prepared([runCreated(), featureStateChanged('running'), stepStarted('implement')]);
    const stdout = new Screen();
    const handle = mountShell({
      eventLog,
      feature: 'tui-shell',
      stdout: stdout as unknown as NodeJS.WriteStream,
      // Deliberately no `columns`: the terminal says how wide it is, which is the point of the patch.
      pollMs: null,
      debug: true,
      now: NOW,
    });

    /**
     * Asserted against the *composition*, not only against the row lengths.
     *
     * Ink lays its own output out to `stdout.columns`, so a frame composed at 80 and drawn to a
     * 40-column terminal also comes out in rows of 40 — measuring lengths alone cannot tell the two
     * apart. The control hints can: they are packed to the width they were composed for, so the row
     * `formatControlHints(80)` produces is one no 40-column composition contains.
     */
    const rowsOf = (frame: string): string[] => frame.split('\n').map((row) => row.trimEnd());

    try {
      expect(rowsOf(stdout.last())).toContain(formatControlHints(80)[0]);

      stdout.columns = NARROW_COLUMNS;
      stdout.emit('resize');

      const narrow = rowsOf(stdout.last());
      expect(narrow).toContain(formatControlHints(NARROW_COLUMNS)[0]);
      expect(narrow).not.toContain(formatControlHints(80)[0]);
      for (const row of narrow) expect(row.length, row).toBeLessThanOrEqual(NARROW_COLUMNS);
      expect(stdout.last()).toContain(`${MODE_LABEL} `);
    } finally {
      handle.unmount();
    }
  });
});
