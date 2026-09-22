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
  ANALYSIS_CONTRACT_ID,
  AnalysisOutputSchema,
  DECLARATION_PAYLOAD_KEYS,
  FeatureTerritoryDeclaredPayloadSchema,
  StepOutputSchema,
  dispositionFor,
  normaliseTerritory as normaliseTerritoryFromContracts,
} from '../src/contracts/index.js';
import type { EventEnvelope } from '../src/contracts/index.js';
import {
  Reconciler,
  STANDARD_PLAN_STEPS,
  TERRITORY_DECLARED_EVENT_TYPE,
  TERRITORY_PATHS_PAYLOAD_KEY,
  TerritoryDeclaresNothing,
  admitByTerritory,
  normaliseTerritory,
  recordTerritoryRedeclaration,
  territoryDeclaredPayload,
  territoryFromEvents,
  createScriptedExecutor,
  terminated,
  territoriesOverlap,
  territoryRedeclaration,
} from '../src/engine/index.js';
import { Recorder, readEventLog, runPaths } from '../src/runtime/index.js';

import { makeWorkspace } from './helpers/config-fixture.js';
import { makePlan, planProvider } from './helpers/engine-fixture.js';

/** The commit a step's baseline is taken at; this suite never resets a worktree. */
const BASELINE = 'ddd9bed4d286ac1f8a0f4f7bfef9530046605787';

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
        events: log.events(),
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
        events: log.events(),
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
        events: log.events(),
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
        events: log.events(),
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
        events: log.events(),
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

describe('a re-declaration compares against the log, not against what a caller remembers (matrix 30)', () => {
  it('uses the log’s last declaration, so a second correction widens from the first', () => {
    const log = openLog(['src/engine']);
    try {
      recordTerritoryRedeclaration({
        recorder: log.recorder,
        step: 'analyse',
        events: log.events(),
        declared: ['src/contracts'],
      });
      // A caller holding the *plan* still believes the territory is `src/engine`. The comparison is not
      // its to make: a stale `previous` would record this as widening by `src/contracts` — ground the run
      // already claimed — and say nothing about `src/tui`, which is the entry that can newly overlap.
      const second = recordTerritoryRedeclaration({
        recorder: log.recorder,
        step: 'analyse-again',
        events: log.events(),
        declared: ['src/contracts', 'src/tui'],
      });

      expect(second.previous).toStrictEqual(['src/contracts']);
      expect(second.added).toStrictEqual(['src/tui']);
      expect(second.widened).toBe(true);
      expect(log.declarations()).toHaveLength(3);
    } finally {
      log.close();
    }
  });

  it('treats a run whose log declares nothing as having held nothing', () => {
    const orchHome = makeWorkspace('territory-home');
    homes.push(orchHome);
    const recorder = Recorder.open({ runId: RUN, feature: FEATURE, orchHome });
    try {
      const recorded = recordTerritoryRedeclaration({
        recorder,
        step: 'analyse',
        events: [],
        declared: ['src/engine'],
      });
      expect(recorded.previous).toStrictEqual([]);
      expect(recorded.added).toStrictEqual(['src/engine']);
    } finally {
      recorder.close();
    }
  });
});

describe('a re-declaration that declares nothing is refused (matrix 31)', () => {
  it.each([[[] as readonly string[]], [['']], [['   ']]])(
    'refuses %j rather than recording a territory that overlaps nothing',
    (declared) => {
      const log = openLog(['src/engine']);
      try {
        expect(() =>
          recordTerritoryRedeclaration({
            recorder: log.recorder,
            step: 'analyse',
            events: log.events(),
            declared,
          }),
        ).toThrowError(TerritoryDeclaresNothing);
        // Nothing was appended: the refusal is before the write, so the log still holds one declaration.
        expect(log.declarations()).toHaveLength(1);
      } finally {
        log.close();
      }
    },
  );

  it('carries config.invalid, so the AD-35 table sends it to a person rather than a retry', () => {
    const refusal = new TerritoryDeclaresNothing('analyse', 'it names no path at all');
    expect(refusal.code).toBe('config.invalid');
    expect(dispositionFor(refusal.code)).toBe('escalate-to-human');
  });
});

/**
 * Matrix 22 and 23 — the seam the story is named for, crossed in one test.
 *
 * The intent says this story produces "the feature's declared file territory **that the reconciler uses to
 * serialize overlapping work**". Every part of that chain existed before this test and none of it was
 * joined: the plan had no analysis step, so no spawn ever carried `phase: 'analysis'`; the re-declaration
 * had no production caller; and the admission tests were handed literal arrays on both sides.
 *
 * So this drives the whole chain and **folds the territory back out of the log it just wrote**, rather
 * than asserting against the value it passed in. Admission is then asked about *that* — which is the only
 * way the join can be shown to hold, because a test that hand-assembles both sides would pass with the
 * two halves wired to nothing.
 */
describe('a completed analysis re-declares the territory the next pass serialises on (matrix 22, 23)', () => {
  const analysisOutputDeclaring = (
    step: string,
    territory: readonly string[],
  ): Record<string, unknown> => ({
    contract_id: ANALYSIS_CONTRACT_ID,
    step,
    status: 'completed',
    summary: 'read the repository and found what the feature touches',
    provenance: [`${step}: src/engine/spawner.ts`],
    decisions: [],
    artifacts: [],
    questions: [],
    write_intents: [],
    error: null,
    claims: [
      {
        claim: 'the grant reaches the argv from the roster',
        paths: ['src/engine/spawner.ts'],
        provenance: { step, source: 'src/engine/spawner.ts' },
      },
    ],
    territory: [...territory],
    files_read: ['src/engine/spawner.ts'],
  });

  it('carries an analysis step, records what it declared, and defers the feature it now overlaps', async () => {
    const orchHome = makeWorkspace('territory-seam');
    homes.push(orchHome);

    /** What the analysis step declares: wider than the plan, and over ground another feature holds. */
    const declaredByAnalysis = ['src/engine', 'src/tui'];
    const phasesSpawned: string[] = [];

    const reconciler = Reconciler.open({
      orchHome,
      plans: planProvider(
        makePlan({ feature: 'grant-wiring', steps: STANDARD_PLAN_STEPS, territory: ['src/engine'] }),
      ),
      baseline: { currentRef: () => BASELINE, resetTo: () => undefined },
      executor: createScriptedExecutor({
        onStart: (request) => {
          phasesSpawned.push(request.phase);
          if (request.phase !== 'analysis') return terminated(request.step, 'completed', {});
          const raw = analysisOutputDeclaring(request.step, declaredByAnalysis);
          return terminated(request.step, 'completed', {
            output: StepOutputSchema.parse(raw),
            contractOutput: AnalysisOutputSchema.parse(raw),
          });
        },
      }),
    });

    try {
      const accepted = reconciler.acceptFeature(
        makePlan({ feature: 'grant-wiring', steps: STANDARD_PLAN_STEPS, territory: ['src/engine'] }),
      );
      reconciler.confirm(accepted.run);
      // One action per pass, so the analysis step needs a pass of its own to run to termination.
      await reconciler.pass();

      // Matrix 22: the plan carries the phase, so the spawn did.
      expect(phasesSpawned).toContain('analysis');
      expect([...STANDARD_PLAN_STEPS].map((step) => step.phase)).toStrictEqual([
        'analysis',
        'planning',
        'implementation',
        'verification',
      ]);

      const events = readEventLog(runPaths(accepted.run, orchHome).eventLog);
      const declarations = events.filter((event) => event.type === TERRITORY_DECLARED_EVENT_TYPE);
      // Two: the one `acceptFeature` wrote from the plan, and the correction the completed analysis made.
      expect(declarations).toHaveLength(2);
      expect(declarations[1]?.step).toBe('analyse');
      expect(declarations[1]?.payload[DECLARATION_PAYLOAD_KEYS.TerritoryWidened]).toBe(true);
      expect(declarations[1]?.payload[DECLARATION_PAYLOAD_KEYS.TerritoryAddedPaths]).toStrictEqual([
        'src/tui',
      ]);

      /**
       * The join: the territory is folded back **out of the log** and admission is asked about that.
       *
       * Nothing here repeats `declaredByAnalysis`. If the reconciler had recorded nothing, or had
       * recorded the plan's territory, this replay would read `src/engine` and the other feature would be
       * admitted beside it — which is precisely the state that existed before this test.
       */
      const replayed = territoryFromEvents(events);
      expect(replayed?.complete).toBe(true);
      const holder = { run: accepted.run, feature: 'grant-wiring', territory: replayed?.territory ?? [] };
      const other = { run: '01ZZZZZZZZZZZZZZZZZZZZZZZZ', feature: 'tui-work', territory: ['src/tui'] };

      const admission = admitByTerritory([holder, other]);
      expect(admission.admitted.map((entry) => entry.feature)).toStrictEqual(['grant-wiring']);
      expect(admission.deferred.map((entry) => entry.feature)).toStrictEqual(['tui-work']);
      expect(admission.deferred[0]?.overlap).toStrictEqual(['src/tui']);
    } finally {
      reconciler.close();
    }
  });

  it('records nothing for a step whose output declares no territory', async () => {
    const orchHome = makeWorkspace('territory-seam-none');
    homes.push(orchHome);
    const reconciler = Reconciler.open({
      orchHome,
      plans: planProvider(makePlan({ feature: 'grant-wiring', steps: STANDARD_PLAN_STEPS })),
      baseline: { currentRef: () => BASELINE, resetTo: () => undefined },
      executor: createScriptedExecutor({
        onStart: (request) => terminated(request.step, 'completed', {}),
      }),
    });
    try {
      const accepted = reconciler.acceptFeature(
        makePlan({ feature: 'grant-wiring', steps: STANDARD_PLAN_STEPS }),
      );
      reconciler.confirm(accepted.run);
      await reconciler.pass();
      const events = readEventLog(runPaths(accepted.run, orchHome).eventLog);
      // Only the run-creation line. A completed step that declares nothing corrects nothing.
      expect(events.filter((event) => event.type === TERRITORY_DECLARED_EVENT_TYPE)).toHaveLength(1);
    } finally {
      reconciler.close();
    }
  });
});

describe('the payload\u2019s own consistency', () => {
  it('refuses a line claiming it did not widen beside a non-empty added_paths', () => {
    // `widened` is a summary of `added_paths`, and a payload where the two disagree says two things: a
    // replay acting on the flag would read a real widening as none, which is what the keys exist to
    // prevent. Bound in the schema, because a payload is read by units that never ran the emitter.
    expect(() =>
      FeatureTerritoryDeclaredPayloadSchema.parse({
        [TERRITORY_PATHS_PAYLOAD_KEY]: ['src/engine', 'src/tui'],
        [DECLARATION_PAYLOAD_KEYS.TerritoryAddedPaths]: ['src/tui'],
        [DECLARATION_PAYLOAD_KEYS.TerritoryWidened]: false,
      }),
    ).toThrowError();
    expect(() =>
      FeatureTerritoryDeclaredPayloadSchema.parse({
        [TERRITORY_PATHS_PAYLOAD_KEY]: ['src/engine'],
        [DECLARATION_PAYLOAD_KEYS.TerritoryAddedPaths]: [],
        [DECLARATION_PAYLOAD_KEYS.TerritoryWidened]: true,
      }),
    ).toThrowError();
  });

  it('still accepts a first declaration, which carries neither key', () => {
    expect(() => territoryDeclaredPayload(['src/engine'])).not.toThrow();
  });

  it('reports removed entry by entry, which is coarser than file by file', () => {
    // Narrowing a directory to one file inside it reports the *entry* as removed, because the directory
    // as a whole is no longer claimed — not because that file stopped being claimed. Pinned so the
    // coarseness is a documented property rather than a surprise read off a field name.
    const narrower = territoryRedeclaration(['src/engine'], ['src/engine/lock.ts']);
    expect(narrower.removed).toStrictEqual(['src/engine']);
    expect(narrower.declared).toStrictEqual(['src/engine/lock.ts']);
    expect(territoriesOverlap(narrower.removed, narrower.declared)).toBe(true);
  });
});
