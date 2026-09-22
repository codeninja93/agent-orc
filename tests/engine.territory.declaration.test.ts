/**
 * Matrix rows 5 to 8 — the territory analysis declares, recorded by the engine.
 *
 * `acceptFeature` emits `feature.territory_declared` from the caller's plan at run creation, before any
 * step has read the repository. Analysis is the first unit that knows which files a feature actually
 * touches, so its output *corrects* that declaration, and `territoryFromEvents` already reads the last
 * line as the correction.
 *
 * The row that matters is 6. A re-declaration that **widens** the territory can newly overlap a feature
 * that is already admitted and already writing; admission is recomputed every pass, so the next pass
 * serialises them, and the work already done concurrently is not undone. There is no rollback in the
 * architecture and this story does not invent one — so what is asserted here is that the widening is
 * *visible in the log*, which is the thing a replay can act on.
 */
import { rmSync } from 'node:fs';

import { afterAll, describe, expect, it } from 'vitest';

import {
  DECLARATION_PAYLOAD_KEYS,
  normaliseTerritory as normaliseTerritoryFromContracts,
} from '../src/contracts/index.js';
import type { EventEnvelope } from '../src/contracts/index.js';
import {
  TERRITORY_DECLARED_EVENT_TYPE,
  TERRITORY_PATHS_PAYLOAD_KEY,
  admitByTerritory,
  normaliseTerritory,
  recordTerritoryRedeclaration,
  territoryDeclaredPayload,
  territoryFromEvents,
  territoryRedeclaration,
} from '../src/engine/index.js';
import { Recorder, readEventLog, runPaths } from '../src/runtime/index.js';

import { makeWorkspace } from './helpers/config-fixture.js';

const homes: string[] = [];

afterAll(() => {
  for (const home of homes) rmSync(home, { recursive: true, force: true });
});

const RUN = '01JTERRITORY000000000000A';
const FEATURE = 'analysis-declares-territory';

interface Log {
  readonly recorder: Recorder;
  readonly events: () => readonly EventEnvelope[];
  readonly declarations: () => readonly EventEnvelope[];
  readonly close: () => void;
}

/** A real run log, with the run-creation declaration already on it, as `acceptFeature` leaves one. */
const openLog = (planTerritory: readonly string[]): Log => {
  const orchHome = makeWorkspace('territory-home');
  homes.push(orchHome);
  const recorder = Recorder.open({ runId: RUN, feature: FEATURE, orchHome });
  recorder.recordResult({
    feature: FEATURE,
    run: RUN,
    step: null,
    emitter: 'engine.reconciler',
    type: TERRITORY_DECLARED_EVENT_TYPE,
    payload: territoryDeclaredPayload(planTerritory),
  });
  const events = (): readonly EventEnvelope[] => readEventLog(runPaths(RUN, orchHome).eventLog);
  return {
    recorder,
    events,
    declarations: (): readonly EventEnvelope[] =>
      events().filter((event) => event.type === TERRITORY_DECLARED_EVENT_TYPE),
    close: (): void => {
      recorder.close();
    },
  };
};

describe('an analysis output re-declares the territory, and replay reads the correction (matrix 5)', () => {
  it('emits a declaration carrying the declared paths, which the replay takes as the current one', () => {
    const log = openLog(['src/engine']);
    try {
      const recorded = recordTerritoryRedeclaration({
        recorder: log.recorder,
        step: 'analyse',
        previous: ['src/engine'],
        declared: ['src/engine', 'src/contracts'],
      });
      expect(recorded.recorded).toBe(true);

      expect(log.declarations()).toHaveLength(2);
      const last = log.declarations()[1];
      expect(last?.step).toBe('analyse');
      expect(last?.payload[TERRITORY_PATHS_PAYLOAD_KEY]).toStrictEqual([
        'src/contracts',
        'src/engine',
      ]);

      // The replay reads the *last* declaration, which is what makes a re-declaration a correction
      // rather than an addition.
      const replayed = territoryFromEvents(log.events());
      expect(replayed?.territory).toStrictEqual(['src/contracts', 'src/engine']);
      expect(replayed?.complete).toBe(true);
      expect(replayed?.run).toBe(RUN);
      expect(replayed?.feature).toBe(FEATURE);
    } finally {
      log.close();
    }
  });

  it('records the step that corrected it, so the log says which one did', () => {
    const log = openLog(['.']);
    try {
      recordTerritoryRedeclaration({
        recorder: log.recorder,
        step: 'analyse',
        previous: ['.'],
        declared: ['src/tui'],
      });
      expect(log.declarations()[0]?.step).toBeNull();
      expect(log.declarations()[1]?.step).toBe('analyse');
    } finally {
      log.close();
    }
  });
});

describe('a widening is visible in the log rather than silently applied (matrix 6)', () => {
  it('records what was added, and says the territory widened', () => {
    const log = openLog(['src/engine']);
    try {
      const recorded = recordTerritoryRedeclaration({
        recorder: log.recorder,
        step: 'analyse',
        previous: ['src/engine'],
        declared: ['src/engine', 'src/tui'],
      });

      expect(recorded.widened).toBe(true);
      expect(recorded.added).toStrictEqual(['src/tui']);
      expect(recorded.removed).toStrictEqual([]);
      expect(recorded.summary).toContain('src/tui');
      expect(recorded.summary).toContain('already overlap a feature that is admitted and writing');

      const payload = log.declarations()[1]?.payload ?? {};
      expect(payload[DECLARATION_PAYLOAD_KEYS.TerritoryWidened]).toBe(true);
      expect(payload[DECLARATION_PAYLOAD_KEYS.TerritoryAddedPaths]).toStrictEqual(['src/tui']);
      expect(payload[DECLARATION_PAYLOAD_KEYS.TerritoryPreviousPaths]).toStrictEqual(['src/engine']);
    } finally {
      log.close();
    }
  });

  it('serialises the newly overlapping feature from the next pass, and undoes nothing', () => {
    const holder = { run: '01JTERRITORY000000000000B', feature: 'tui-work', territory: ['src/tui'] };
    const widening = { run: RUN, feature: FEATURE, territory: ['src/engine'] };

    // Before the re-declaration the two are disjoint and both advance.
    expect(admitByTerritory([widening, holder]).admitted.map((entry) => entry.feature)).toStrictEqual([
      FEATURE,
      'tui-work',
    ]);

    // After it they collide, and the older run keeps the territory. Nothing here reverses the work the
    // other feature did while they were disjoint: there is no mechanism that could, and the log line is
    // the whole of the remedy.
    const after = admitByTerritory([{ ...widening, territory: ['src/engine', 'src/tui'] }, holder]);
    expect(after.admitted.map((entry) => entry.feature)).toStrictEqual([FEATURE]);
    expect(after.deferred[0]?.feature).toBe('tui-work');
    expect(after.deferred[0]?.overlap).toStrictEqual(['src/tui']);
  });

  it('does not call a narrowing inside the old territory a widening', () => {
    // `src/engine` already contained `src/engine/lock.ts`, so claiming the file adds no ground. A set
    // difference would have reported this as widening and sent a reader looking for an overlap that
    // cannot exist.
    const narrower = territoryRedeclaration(['src/engine'], ['src/engine/lock.ts']);
    expect(narrower.widened).toBe(false);
    expect(narrower.added).toStrictEqual([]);
    expect(narrower.removed).toStrictEqual(['src/engine']);
  });
});

describe('a narrowing is recorded, and admission recomputes next pass (matrix 7)', () => {
  it('records what is no longer claimed', () => {
    const log = openLog(['src/engine', 'src/tui']);
    try {
      const recorded = recordTerritoryRedeclaration({
        recorder: log.recorder,
        step: 'analyse',
        previous: ['src/engine', 'src/tui'],
        declared: ['src/engine'],
      });

      expect(recorded.narrowed).toBe(true);
      expect(recorded.widened).toBe(false);
      expect(recorded.removed).toStrictEqual(['src/tui']);
      expect(log.declarations()[1]?.payload[DECLARATION_PAYLOAD_KEYS.TerritoryRemovedPaths]).toStrictEqual(
        ['src/tui'],
      );
      expect(log.declarations()[1]?.payload[DECLARATION_PAYLOAD_KEYS.TerritoryWidened]).toBe(false);

      // The replay now admits on the narrowed territory, which is what "recomputed every pass" means.
      const replayed = territoryFromEvents(log.events());
      expect(replayed?.territory).toStrictEqual(['src/engine']);
    } finally {
      log.close();
    }
  });

  it('frees the feature that was serialised behind it', () => {
    const holder = { run: RUN, feature: FEATURE, territory: ['src/engine'] };
    const other = { run: '01JTERRITORY000000000000C', feature: 'tui-work', territory: ['src/tui'] };
    expect(admitByTerritory([{ ...holder, territory: ['.'] }, other]).deferred).toHaveLength(1);
    expect(admitByTerritory([holder, other]).deferred).toStrictEqual([]);
  });

  it('can widen and narrow at once, because a territory can move', () => {
    const moved = territoryRedeclaration(['src/engine'], ['src/contracts']);
    expect(moved.widened).toBe(true);
    expect(moved.narrowed).toBe(true);
    expect(moved.added).toStrictEqual(['src/contracts']);
    expect(moved.removed).toStrictEqual(['src/engine']);
  });
});

describe('a loosely spelled declaration is normalised by the existing normaliser (matrix 8)', () => {
  it('normalises a leading ./, a trailing slash, a backslash and a duplicate', () => {
    const log = openLog(['src/engine']);
    try {
      recordTerritoryRedeclaration({
        recorder: log.recorder,
        step: 'analyse',
        previous: ['src/engine'],
        declared: ['./src/engine/', 'src\\contracts', 'src/engine', 'src/contracts'],
      });
      expect(log.declarations()[1]?.payload[TERRITORY_PATHS_PAYLOAD_KEY]).toStrictEqual([
        'src/contracts',
        'src/engine',
      ]);
    } finally {
      log.close();
    }
  });

  it('is the one normaliser, not a second implementation beside it', () => {
    // The engine's export *is* the contracts one — moved there so `step.analysis` could refuse a claim
    // outside its declared territory at parse time. Identity, not equivalence: two implementations that
    // agree today are the thing this assertion exists to prevent.
    expect(normaliseTerritory).toBe(normaliseTerritoryFromContracts);
    expect(normaliseTerritory(['./src/b/', 'src/a', 'src/a/'])).toStrictEqual(['src/a', 'src/b']);
  });

  it('spells the payload the same way whichever helper wrote it', () => {
    const declared = ['./src/engine/', 'src/contracts'];
    const first = territoryDeclaredPayload(declared);
    const corrected = territoryRedeclaration([], declared);
    expect(first[TERRITORY_PATHS_PAYLOAD_KEY]).toStrictEqual([...corrected.declared]);
  });
});
