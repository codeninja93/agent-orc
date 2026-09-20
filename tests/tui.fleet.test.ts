/**
 * CAP-22 — every in-flight feature, on one screen, measured.
 *
 * "One screen" is the only success criterion CAP-22 states, and it is the one thing a brief can silently
 * fail: a list that overflows looks correct in every test that does not count rows. So the height is an
 * argument, every test here counts the lines the frame would actually draw — through the frame's own
 * `wrapLine`, at 80 columns and at 40 — and the overflow is asserted to be *stated* rather than merely to
 * have happened.
 *
 * The fleet is folded from real run directories on disk rather than from hand-built views, because the
 * claim being tested is that one unreadable log costs only its own line. A fake fleet could not fail that
 * way, so it could not prove it either.
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runPaths, runsDir } from '../src/runtime/index.js';
import {
  DEFAULT_BRIEF_HEIGHT,
  NARROW_COLUMNS,
  UNNAMED_FEATURE,
  buildBriefCard,
  cardText,
  foldFleet,
  inFlightRuns,
  wrapLine,
} from '../src/tui/index.js';

import { makeHome } from './helpers/engine-fixture.js';
import {
  FIXTURE_RUN_START_MS,
  budgetDegraded,
  buildLog,
  featureStateChanged,
  logText,
  runCreated,
  stepStarted,
  stepTerminated,
} from './helpers/tui-log.js';

const NOW = new Date(FIXTURE_RUN_START_MS + 120_000);

/** Distinct run ids of the shape the engine mints: 26 characters, sorting chronologically. */
const runIdFor = (index: number): string =>
  `01K5NQ9ZJ7V3M2P9XQWRTC4${String(index).padStart(2, '0')}`;

let home: string;
const toRemove: string[] = [];

beforeEach(() => {
  home = makeHome('tui-fleet');
  toRemove.push(home);
});

afterEach(() => {
  for (const dir of toRemove.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A run in flight: created, confirmed, one step running, some budget consumed. */
const writeRunningLog = (index: number, feature: string): string => {
  const runId = runIdFor(index);
  const paths = runPaths(runId, home);
  mkdirSync(paths.runDir, { recursive: true });
  writeFileSync(
    paths.eventLog,
    logText(
      buildLog(
        [
          runCreated(),
          featureStateChanged('confirmed'),
          featureStateChanged('running', 'confirmed'),
          stepStarted('implement'),
          budgetDegraded(0.25, 600_000),
        ],
        { feature, run: runId },
      ),
    ),
    'utf8',
  );
  return runId;
};

/** A run the reader will refuse: a line that is not whole JSON. */
const writeTornLog = (index: number): string => {
  const runId = runIdFor(index);
  const paths = runPaths(runId, home);
  mkdirSync(paths.runDir, { recursive: true });
  writeFileSync(paths.eventLog, '{"ts":"2026-09-20T09:00:00.000Z","seq":1,not json\n', 'utf8');
  return runId;
};

/** A run that has finished: terminal, so not in flight. */
const writeCommittedLog = (index: number, feature: string): string => {
  const runId = runIdFor(index);
  const paths = runPaths(runId, home);
  mkdirSync(paths.runDir, { recursive: true });
  writeFileSync(
    paths.eventLog,
    logText(
      buildLog(
        [
          runCreated(),
          featureStateChanged('confirmed'),
          stepStarted('implement'),
          stepTerminated('implement'),
          featureStateChanged('committed', 'verifying'),
        ],
        { feature, run: runId },
      ),
    ),
    'utf8',
  );
  return runId;
};

/** The rows the frame would draw for this brief at a given width. */
const drawnRows = (lines: readonly string[], columns: number): number =>
  lines.flatMap((line) => wrapLine(line, columns)).length;

describe('three features in flight, on a terminal 24 rows tall', () => {
  it('lists all three with what each needs and what it cost, inside the height', () => {
    writeRunningLog(1, 'tui-cards');
    writeRunningLog(2, 'question-lifecycle');
    writeRunningLog(3, 'command-transport');

    const brief = buildBriefCard({
      fleet: foldFleet({ orchHome: home }),
      height: DEFAULT_BRIEF_HEIGHT,
      wrap: (line) => wrapLine(line, 80),
      now: NOW,
    });

    expect(brief.inFlight).toBe(3);
    expect(brief.notShown).toBe(0);
    expect(brief.entries.map((entry) => entry.feature)).toStrictEqual([
      'tui-cards',
      'question-lifecycle',
      'command-transport',
    ]);
    for (const entry of brief.entries) {
      // What it needs is the gate, in words, and never a share of a whole (R7).
      expect(entry.needs).not.toBe('');
      expect(entry.cost).toContain('0.25 of 1.00');
      expect(entry.cost).toContain('estimated');
    }
    expect(drawnRows(cardText(brief).split('\n'), 80)).toBeLessThanOrEqual(DEFAULT_BRIEF_HEIGHT);
    expect(cardText(brief)).not.toContain('%');
  });

  it('addresses every feature by name and never by run id (R6)', () => {
    const first = writeRunningLog(1, 'tui-cards');
    writeRunningLog(2, 'question-lifecycle');

    const brief = buildBriefCard({ fleet: foldFleet({ orchHome: home }), now: NOW });
    expect(cardText(brief)).toContain('tui-cards');
    expect(cardText(brief)).not.toContain(first);
  });

  it('leaves a finished run out of the brief, because it is not in flight', () => {
    writeRunningLog(1, 'tui-cards');
    writeCommittedLog(2, 'question-lifecycle');

    const fleet = foldFleet({ orchHome: home });
    expect(fleet.runs).toHaveLength(2);
    expect(inFlightRuns(fleet).map((run) => run.view.feature)).toStrictEqual(['tui-cards']);
  });
});

describe('twelve features in flight, on a terminal 24 rows tall', () => {
  const twelve = (): void => {
    for (let index = 1; index <= 12; index += 1) writeRunningLog(index, `feature-${String(index)}`);
  };

  it('lists what fits and states how many more, without exceeding the height', () => {
    twelve();
    const brief = buildBriefCard({
      fleet: foldFleet({ orchHome: home }),
      height: DEFAULT_BRIEF_HEIGHT,
      wrap: (line) => wrapLine(line, 80),
      now: NOW,
    });

    expect(brief.inFlight).toBe(12);
    expect(brief.notShown).toBeGreaterThan(0);
    expect(brief.entries.length + brief.notShown).toBe(12);
    expect(drawnRows(cardText(brief).split('\n'), 80)).toBeLessThanOrEqual(DEFAULT_BRIEF_HEIGHT);
    expect(cardText(brief)).toContain(`and ${String(brief.notShown)} more in flight, not shown`);
  });

  it('keeps the height when the terminal is 40 columns and every line wraps', () => {
    twelve();
    const brief = buildBriefCard({
      fleet: foldFleet({ orchHome: home }),
      height: DEFAULT_BRIEF_HEIGHT,
      wrap: (line) => wrapLine(line, NARROW_COLUMNS),
      now: NOW,
    });

    // The narrow case is the one an unmeasured bound gets wrong: every entry now takes several rows, so
    // fewer features fit and more have to be reported as not shown.
    expect(drawnRows(cardText(brief).split('\n'), NARROW_COLUMNS)).toBeLessThanOrEqual(
      DEFAULT_BRIEF_HEIGHT,
    );
    expect(brief.notShown).toBeGreaterThan(0);
    expect(cardText(brief)).toContain('more in flight, not shown');
  });

  it('keeps the height on a terminal too short for even one feature, and says nothing is shown', () => {
    twelve();
    const brief = buildBriefCard({
      fleet: foldFleet({ orchHome: home }),
      height: 2,
      wrap: (line) => wrapLine(line, 80),
      now: NOW,
    });
    expect(brief.entries).toHaveLength(0);
    expect(brief.notShown).toBe(12);
    expect(drawnRows(cardText(brief).split('\n'), 80)).toBeLessThanOrEqual(2);
  });
});

describe('one unreadable log among three', () => {
  it('states on that feature line that its log could not be read, and leaves the other two alone', () => {
    writeRunningLog(1, 'tui-cards');
    writeTornLog(2);
    writeRunningLog(3, 'command-transport');

    const brief = buildBriefCard({
      fleet: foldFleet({ orchHome: home }),
      height: DEFAULT_BRIEF_HEIGHT,
      wrap: (line) => wrapLine(line, 80),
      now: NOW,
    });

    expect(brief.inFlight).toBe(3);
    const broken = brief.entries.find((entry) => entry.problem !== null);
    expect(broken?.needs).toContain('could not be read');
    expect(broken?.feature).toBe(UNNAMED_FEATURE);

    // The other two are exactly what they would have been on their own: one bad log costs one line.
    const healthy = brief.entries.filter((entry) => entry.problem === null);
    expect(healthy.map((entry) => entry.feature)).toStrictEqual(['tui-cards', 'command-transport']);
    for (const entry of healthy) expect(entry.cost).toContain('0.25 of 1.00');
    expect(cardText(brief)).toContain('could not be read');
    expect(cardText(brief)).not.toContain('at Object.');
  });

  it('folds a run whose log is missing entirely without dropping the fleet', () => {
    writeRunningLog(1, 'tui-cards');
    mkdirSync(runPaths(runIdFor(2), home).runDir, { recursive: true });

    const fleet = foldFleet({ orchHome: home });
    expect(fleet.runs).toHaveLength(2);
    // A run directory with nothing recorded has not started, so it is not reported as in flight — but it
    // is still folded rather than throwing.
    expect(inFlightRuns(fleet)).toHaveLength(1);
  });
});

describe('nothing in flight', () => {
  it('says so in one sentence, with no empty table and no borrowed frame', () => {
    writeCommittedLog(1, 'tui-cards');

    const brief = buildBriefCard({ fleet: foldFleet({ orchHome: home }), now: NOW });
    expect(brief.inFlight).toBe(0);
    expect(brief.entries).toStrictEqual([]);
    expect(brief.lines).toHaveLength(1);
    expect(brief.lines[0]).toContain('no feature is running');
    expect(cardText(brief)).not.toContain('needs:');
    expect(cardText(brief)).not.toContain('cost:');
  });

  it('says the same on a machine with no runs at all', () => {
    const brief = buildBriefCard({ fleet: foldFleet({ orchHome: home }), now: NOW });
    expect(brief.inFlight).toBe(0);
    expect(cardText(brief)).toContain('nothing is in flight');
  });
});

describe('the fleet fold reads the layout AD-9 declares', () => {
  it('enumerates the run directories under runs/, in chronological id order', () => {
    writeRunningLog(3, 'third');
    writeRunningLog(1, 'first');
    writeRunningLog(2, 'second');

    const fleet = foldFleet({ orchHome: home });
    expect(fleet.runs.map((run) => run.view.feature)).toStrictEqual(['first', 'second', 'third']);
    // The directory it read is the one the runtime names, not one this test spelled itself.
    expect(runsDir(home)).toContain('runs');
  });

  it('folds only the runs it is given, when a caller already knows them', () => {
    writeRunningLog(1, 'first');
    writeRunningLog(2, 'second');

    const fleet = foldFleet({ orchHome: home, runIds: [runIdFor(2)] });
    expect(fleet.runs.map((run) => run.view.feature)).toStrictEqual(['second']);
  });
});
