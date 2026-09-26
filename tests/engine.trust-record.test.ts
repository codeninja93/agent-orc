/**
 * Story 3-3 — `trustRecord`, matrix row 14 and the boundaries around it.
 *
 * A cross-run fold, so — matching `tests/tui.fleet.test.ts`'s own reasoning for `foldFleet` — the fixture
 * is real run directories on disk rather than hand-built views: the claim under test is a join across two
 * event types read from `runsDir`, and a fake fleet could not fail the way a real one can.
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  PULL_REQUEST_MERGE_FIDELITY_EVENT_TYPE,
  PULL_REQUEST_MERGE_FIDELITY_PAYLOAD_KEYS,
} from '../src/contracts/index.js';
import { areaOf, trustRecord } from '../src/engine/index.js';
import { runPaths } from '../src/runtime/index.js';

import { makeHome } from './helpers/engine-fixture.js';
import { buildLog, logText, territoryDeclared } from './helpers/tui-log.js';
import type { EventSpec } from './helpers/tui-log.js';

let home: string;
const toRemove: string[] = [];

beforeEach(() => {
  home = makeHome('engine-trust-record');
  toRemove.push(home);
});

afterEach(() => {
  for (const dir of toRemove.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const mergeFidelityRecorded = (
  outcome: 'unchanged' | 'corrected',
  headRefOid = 'a'.repeat(40),
  mergeCommit = 'b'.repeat(40),
): EventSpec => ({
  type: PULL_REQUEST_MERGE_FIDELITY_EVENT_TYPE,
  payload: {
    [PULL_REQUEST_MERGE_FIDELITY_PAYLOAD_KEYS.Outcome]: outcome,
    [PULL_REQUEST_MERGE_FIDELITY_PAYLOAD_KEYS.HeadRefOid]: headRefOid,
    [PULL_REQUEST_MERGE_FIDELITY_PAYLOAD_KEYS.MergeCommit]: mergeCommit,
  },
});

const mergeFidelityUnreadable = (code = 'pull_request.merge_fidelity_tree_unreadable'): EventSpec => ({
  type: PULL_REQUEST_MERGE_FIDELITY_EVENT_TYPE,
  payload: { [PULL_REQUEST_MERGE_FIDELITY_PAYLOAD_KEYS.Code]: code },
});

const writeRun = (runId: string, feature: string, specs: readonly EventSpec[]): void => {
  const paths = runPaths(runId, home);
  mkdirSync(paths.runDir, { recursive: true });
  writeFileSync(paths.eventLog, logText(buildLog(specs, { feature, run: runId })), 'utf8');
};

describe('areaOf — the module boundary, not the raw first segment', () => {
  it('strips one leading src segment, then takes the first meaningful segment of what remains', () => {
    expect(areaOf('src/engine/rework-rate.ts')).toBe('engine');
    expect(areaOf('src/contracts/territory.ts')).toBe('contracts');
  });

  it('falls back to the first segment unchanged for a path with no leading src', () => {
    expect(areaOf('tests/engine.rework-rate.test.ts')).toBe('tests');
    expect(areaOf('docs/specs/spec.md')).toBe('docs');
  });
});

describe('trustRecord — matrix row 14', () => {
  it('credits every area a territory spans, not one src area', () => {
    writeRun('run-unchanged-1', 'multi-area-feature', [
      territoryDeclared(['src/engine/x.ts', 'src/tui/y.ts']),
      mergeFidelityRecorded('unchanged'),
    ]);

    expect(trustRecord({ orchHome: home })).toStrictEqual([
      { area: 'engine', unchanged: 1, corrected: 0 },
      { area: 'tui', unchanged: 1, corrected: 0 },
    ]);
  });

  it('accumulates unchanged and corrected across separate runs into the same area', () => {
    writeRun('run-a', 'feature-a', [territoryDeclared(['src/engine/x.ts']), mergeFidelityRecorded('unchanged')]);
    writeRun('run-b', 'feature-b', [territoryDeclared(['src/engine/y.ts']), mergeFidelityRecorded('corrected')]);

    expect(trustRecord({ orchHome: home })).toStrictEqual([{ area: 'engine', unchanged: 1, corrected: 1 }]);
  });

  it('credits nothing for a run whose merge-fidelity comparison could not be made', () => {
    writeRun('run-unreadable', 'feature-c', [
      territoryDeclared(['src/engine/x.ts']),
      mergeFidelityUnreadable(),
    ]);

    expect(trustRecord({ orchHome: home })).toStrictEqual([]);
  });

  it('credits nothing for a run that never merged (no pull_request.merge_fidelity line at all)', () => {
    writeRun('run-unmerged', 'feature-d', [territoryDeclared(['src/engine/x.ts'])]);

    expect(trustRecord({ orchHome: home })).toStrictEqual([]);
  });

  it('credits nothing for a merged run that declared no territory', () => {
    writeRun('run-no-territory', 'feature-e', [mergeFidelityRecorded('unchanged')]);

    expect(trustRecord({ orchHome: home })).toStrictEqual([]);
  });

  it('reports no areas at all when nothing has ever merged', () => {
    expect(trustRecord({ orchHome: home })).toStrictEqual([]);
  });

  it('folds only the runs it is given, when a caller already knows them', () => {
    writeRun('run-a', 'feature-a', [territoryDeclared(['src/engine/x.ts']), mergeFidelityRecorded('unchanged')]);
    writeRun('run-b', 'feature-b', [territoryDeclared(['src/tui/y.ts']), mergeFidelityRecorded('unchanged')]);

    expect(trustRecord({ orchHome: home, runIds: ['run-a'] })).toStrictEqual([
      { area: 'engine', unchanged: 1, corrected: 0 },
    ]);
  });

  it('credits an area once, not twice, when two declared paths land in the same area', () => {
    writeRun('run-same-area', 'feature-same-area', [
      territoryDeclared(['src/engine/a.ts', 'src/engine/b.ts']),
      mergeFidelityRecorded('unchanged'),
    ]);

    expect(trustRecord({ orchHome: home })).toStrictEqual([{ area: 'engine', unchanged: 1, corrected: 0 }]);
  });

  it('sorts the areas alphabetically, not by insertion order', () => {
    // Inserted in the order tui, contracts, engine — alphabetically the opposite of that.
    writeRun('run-tui', 'feature-tui', [territoryDeclared(['src/tui/x.ts']), mergeFidelityRecorded('unchanged')]);
    writeRun('run-contracts', 'feature-contracts', [
      territoryDeclared(['src/contracts/x.ts']),
      mergeFidelityRecorded('unchanged'),
    ]);
    writeRun('run-engine', 'feature-engine', [
      territoryDeclared(['src/engine/x.ts']),
      mergeFidelityRecorded('unchanged'),
    ]);

    expect(trustRecord({ orchHome: home }).map((entry) => entry.area)).toStrictEqual([
      'contracts',
      'engine',
      'tui',
    ]);
  });
});
