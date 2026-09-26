/**
 * Story 5-1 — the consolidation pass's I/O matrix, plus the idempotency property across two calls.
 *
 * A cross-run fold, so — matching `tests/engine.trust-record.test.ts`'s own reasoning — the fixture is
 * real run directories on disk rather than hand-built views: the claim under test is a join across a
 * `feature.state_changed` line and a `feature.territory_declared` line read from `runsDir`, and a fake
 * fleet could not fail the way a real one can.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  consolidate,
  consolidateRun,
  runConsolidationPass,
  writeConsolidatedFacts,
} from '../src/engine/index.js';
import type { KnowledgeEntry } from '../src/contracts/index.js';
import { REDACTION_MARKER, projectMemoryPath, runPaths } from '../src/runtime/index.js';

import { makeHome } from './helpers/engine-fixture.js';
import { FIXTURE_RUN_START_MS, buildLog, featureStateChanged, logText, territoryDeclared } from './helpers/tui-log.js';
import type { EventSpec } from './helpers/tui-log.js';

let home: string;
const toRemove: string[] = [];

beforeEach(() => {
  home = makeHome('engine-consolidation');
  toRemove.push(home);
});

afterEach(() => {
  for (const dir of toRemove.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const PROJECT_ID = 'project-under-test';

const writeRun = (runId: string, feature: string, specs: readonly EventSpec[]): void => {
  const paths = runPaths(runId, home);
  mkdirSync(paths.runDir, { recursive: true });
  writeFileSync(paths.eventLog, logText(buildLog(specs, { feature, run: runId })), 'utf8');
};

/** The ISO timestamp `buildLog` assigns to the spec at `index` (one second per line, from a fixed start). */
const tsAt = (index: number): string => new Date(FIXTURE_RUN_START_MS + index * 1_000).toISOString();

describe('consolidateRun — the I/O matrix', () => {
  it('a committed run with one area produces one positive fact, until-refactor decay', () => {
    writeRun('run-committed', 'feature-committed', [
      territoryDeclared(['src/engine/x.ts']),
      featureStateChanged('committed'),
    ]);

    expect(consolidateRun('run-committed', { orchHome: home })).toStrictEqual([
      {
        anchor: 'engine',
        anchor_kind: 'module-name',
        claim: 'the run entered committed',
        provenance: 'consolidation:run-committed:engine',
        recorded_at: tsAt(1),
        decay_policy: 'until-refactor',
        decay_features: 0,
      },
    ] satisfies KnowledgeEntry[]);
  });

  it('a handed-off run with one area produces one negative fact, permanent decay', () => {
    writeRun('run-handed-off', 'feature-handed-off', [
      territoryDeclared(['src/tui/y.ts']),
      featureStateChanged('handed_off'),
    ]);

    expect(consolidateRun('run-handed-off', { orchHome: home })).toStrictEqual([
      {
        anchor: 'tui',
        anchor_kind: 'module-name',
        claim: 'the run entered handed_off',
        provenance: 'consolidation:run-handed-off:tui',
        recorded_at: tsAt(1),
        decay_policy: 'permanent',
        decay_features: 0,
      },
    ] satisfies KnowledgeEntry[]);
  });

  it('a hibernated run has the same shape as a handed-off one: negative, permanent decay', () => {
    writeRun('run-hibernated', 'feature-hibernated', [
      territoryDeclared(['src/tui/y.ts']),
      featureStateChanged('hibernated'),
    ]);

    expect(consolidateRun('run-hibernated', { orchHome: home })).toStrictEqual([
      {
        anchor: 'tui',
        anchor_kind: 'module-name',
        claim: 'the run entered hibernated',
        provenance: 'consolidation:run-hibernated:tui',
        recorded_at: tsAt(1),
        decay_policy: 'permanent',
        decay_features: 0,
      },
    ] satisfies KnowledgeEntry[]);
  });

  it('a killed run produces no fact', () => {
    writeRun('run-killed', 'feature-killed', [
      territoryDeclared(['src/engine/x.ts']),
      featureStateChanged('killed'),
    ]);

    expect(consolidateRun('run-killed', { orchHome: home })).toStrictEqual([]);
  });

  it('a run still in flight (no terminal feature.state_changed at all) produces no fact', () => {
    writeRun('run-in-flight', 'feature-in-flight', [
      territoryDeclared(['src/engine/x.ts']),
      featureStateChanged('running', 'confirmed'),
    ]);

    expect(consolidateRun('run-in-flight', { orchHome: home })).toStrictEqual([]);
  });

  it('a run with a terminal transition but no declared territory produces no fact', () => {
    writeRun('run-no-territory', 'feature-no-territory', [featureStateChanged('committed')]);

    expect(consolidateRun('run-no-territory', { orchHome: home })).toStrictEqual([]);
  });

  it('a run whose declared territory was partly redacted (AD-21, incomplete) produces no fact', () => {
    // One path survived the log and one did not (`REDACTION_MARKER`), so `territoryFromEvents` reports
    // `complete: false`. Anchoring a `permanent`-decay fact on the surviving path alone would treat a
    // partial territory as the run's whole one, and — unlike `trust-record.ts`'s live, always-recomputed
    // fold — this fact is never re-consolidated once written, so a wrong anchor would persist forever.
    writeRun('run-redacted-territory', 'feature-redacted-territory', [
      territoryDeclared(['src/engine/x.ts', REDACTION_MARKER]),
      featureStateChanged('committed'),
    ]);

    expect(consolidateRun('run-redacted-territory', { orchHome: home })).toStrictEqual([]);
  });

  it('a run whose only declared area reduces to a blank anchor (bare "src") produces no fact', () => {
    // `areaOf` strips a leading `src` segment first; a territory that is nothing but `src` reduces to an
    // empty string, which `KnowledgeAnchorSchema` refuses as blank. That must not throw out of
    // `KnowledgeEntrySchema.parse` and silently cost the run every other area's fact too (there is only
    // one area here, so the run gets none).
    writeRun('run-blank-anchor', 'feature-blank-anchor', [
      territoryDeclared(['src']),
      featureStateChanged('committed'),
    ]);

    expect(consolidateRun('run-blank-anchor', { orchHome: home })).toStrictEqual([]);
  });

  it('a mix of one valid-anchor area and one blank-anchor area still produces the valid one’s fact', () => {
    writeRun('run-mixed-anchors', 'feature-mixed-anchors', [
      territoryDeclared(['src', 'src/engine/x.ts']),
      featureStateChanged('committed'),
    ]);

    expect(consolidateRun('run-mixed-anchors', { orchHome: home })).toStrictEqual([
      {
        anchor: 'engine',
        anchor_kind: 'module-name',
        claim: 'the run entered committed',
        provenance: 'consolidation:run-mixed-anchors:engine',
        recorded_at: tsAt(1),
        decay_policy: 'until-refactor',
        decay_features: 0,
      },
    ] satisfies KnowledgeEntry[]);
  });

  it('a terminal transition with a blank reason produces no fact, same as a run still in flight', () => {
    // `lastTerminalTransition` requires a non-blank `reason` in addition to a terminal `to` — safer than,
    // though not identical to, the spec's own Boundaries text ("the last feature.state_changed event whose
    // `to` is terminal"). This locks in the code's actual, correct behaviour.
    writeRun('run-blank-reason', 'feature-blank-reason', [
      territoryDeclared(['src/engine/x.ts']),
      { type: 'feature.state_changed', payload: { from: 'drafting', to: 'committed', reason: '   ' } },
    ]);

    expect(consolidateRun('run-blank-reason', { orchHome: home })).toStrictEqual([]);
  });

  it('a terminal transition with a missing reason produces no fact', () => {
    writeRun('run-missing-reason', 'feature-missing-reason', [
      territoryDeclared(['src/engine/x.ts']),
      { type: 'feature.state_changed', payload: { from: 'drafting', to: 'committed' } },
    ]);

    expect(consolidateRun('run-missing-reason', { orchHome: home })).toStrictEqual([]);
  });

  it('a territory spanning several areas produces one fact per area, all positive', () => {
    writeRun('run-multi-area', 'feature-multi-area', [
      territoryDeclared(['src/engine/x.ts', 'src/tui/y.ts']),
      featureStateChanged('committed'),
    ]);

    expect(consolidateRun('run-multi-area', { orchHome: home })).toStrictEqual([
      {
        anchor: 'engine',
        anchor_kind: 'module-name',
        claim: 'the run entered committed',
        provenance: 'consolidation:run-multi-area:engine',
        recorded_at: tsAt(1),
        decay_policy: 'until-refactor',
        decay_features: 0,
      },
      {
        anchor: 'tui',
        anchor_kind: 'module-name',
        claim: 'the run entered committed',
        provenance: 'consolidation:run-multi-area:tui',
        recorded_at: tsAt(1),
        decay_policy: 'until-refactor',
        decay_features: 0,
      },
    ] satisfies KnowledgeEntry[]);
  });
});

describe('consolidate — batch folding and per-run isolation', () => {
  it('defaults to every run under runsDir when no runIds are given', () => {
    writeRun('run-a', 'feature-a', [territoryDeclared(['src/engine/x.ts']), featureStateChanged('committed')]);
    writeRun('run-b', 'feature-b', [territoryDeclared(['src/tui/y.ts']), featureStateChanged('handed_off')]);

    const facts = consolidate(undefined, { orchHome: home });
    expect(facts.map((fact) => fact.provenance).sort()).toStrictEqual([
      'consolidation:run-a:engine',
      'consolidation:run-b:tui',
    ]);
  });

  it('folds only the runs it is given, when a caller already knows them', () => {
    writeRun('run-a', 'feature-a', [territoryDeclared(['src/engine/x.ts']), featureStateChanged('committed')]);
    writeRun('run-b', 'feature-b', [territoryDeclared(['src/tui/y.ts']), featureStateChanged('committed')]);

    const facts = consolidate(['run-a'], { orchHome: home });
    expect(facts.map((fact) => fact.provenance)).toStrictEqual(['consolidation:run-a:engine']);
  });

  it('one unreadable run costs only its own credit; every other run in the batch still consolidates', () => {
    writeRun('run-good', 'feature-good', [
      territoryDeclared(['src/engine/x.ts']),
      featureStateChanged('committed'),
    ]);
    const badPaths = runPaths('run-bad', home);
    mkdirSync(badPaths.runDir, { recursive: true });
    // Not whole JSON: readEventLog throws EventLogCorruptError for this run alone.
    writeFileSync(badPaths.eventLog, 'not json at all\n', 'utf8');

    const facts = consolidate(['run-good', 'run-bad'], { orchHome: home });
    expect(facts.map((fact) => fact.provenance)).toStrictEqual(['consolidation:run-good:engine']);
  });
});

describe('writeConsolidatedFacts — the idempotent, durable append', () => {
  it('writes every candidate fact to projects/<project-id>/memory/consolidated.jsonl', () => {
    writeRun('run-committed', 'feature-committed', [
      territoryDeclared(['src/engine/x.ts']),
      featureStateChanged('committed'),
    ]);
    const candidates = consolidateRun('run-committed', { orchHome: home });

    const appended = writeConsolidatedFacts(PROJECT_ID, candidates, { orchHome: home });
    expect(appended).toStrictEqual(candidates);

    const storePath = projectMemoryPath(PROJECT_ID, home);
    expect(existsSync(storePath)).toBe(true);
    const lines = readFileSync(storePath, 'utf8').split('\n').filter((line) => line !== '');
    expect(lines.map((line) => JSON.parse(line) as KnowledgeEntry)).toStrictEqual(candidates);
  });

  it('never duplicates a fact whose provenance run id is already in the store', () => {
    writeRun('run-committed', 'feature-committed', [
      territoryDeclared(['src/engine/x.ts']),
      featureStateChanged('committed'),
    ]);
    const candidates = consolidateRun('run-committed', { orchHome: home });

    writeConsolidatedFacts(PROJECT_ID, candidates, { orchHome: home });
    const second = writeConsolidatedFacts(PROJECT_ID, candidates, { orchHome: home });

    expect(second).toStrictEqual([]);
    const storePath = projectMemoryPath(PROJECT_ID, home);
    const lines = readFileSync(storePath, 'utf8').split('\n').filter((line) => line !== '');
    expect(lines).toHaveLength(1);
  });

  it('one malformed line in the store costs only itself: dedup and append still work around it', () => {
    writeRun('run-committed', 'feature-committed', [
      territoryDeclared(['src/engine/x.ts']),
      featureStateChanged('committed'),
    ]);
    const existing = consolidateRun('run-committed', { orchHome: home });
    writeConsolidatedFacts(PROJECT_ID, existing, { orchHome: home });

    // Corrupt the store by hand, as if one line had been half-written or hand-edited badly.
    const storePath = projectMemoryPath(PROJECT_ID, home);
    const withGarbage = `${readFileSync(storePath, 'utf8')}not json at all\n`;
    writeFileSync(storePath, withGarbage, 'utf8');

    writeRun('run-new', 'feature-new', [
      territoryDeclared(['src/tui/y.ts']),
      featureStateChanged('handed_off'),
    ]);
    const fresh = consolidateRun('run-new', { orchHome: home });

    // `existing` is still recognised as already consolidated (dedup survives the garbage line), and the
    // new run's fact is still appended (append survives it too).
    const appended = writeConsolidatedFacts(PROJECT_ID, [...existing, ...fresh], { orchHome: home });
    expect(appended).toStrictEqual(fresh);

    const lines = readFileSync(storePath, 'utf8')
      .split('\n')
      .filter((line) => line !== '' && line !== 'not json at all');
    expect(lines.map((line) => (JSON.parse(line) as KnowledgeEntry).provenance).sort()).toStrictEqual(
      [...existing, ...fresh].map((fact) => fact.provenance).sort(),
    );
  });
});

describe('projectMemoryPath — the documented on-disk layout, independent of the writer', () => {
  it('resolves to projects/<project-id>/memory/consolidated.jsonl under ORCH_HOME', () => {
    const expected = join(home, 'projects', PROJECT_ID, 'memory', 'consolidated.jsonl');
    expect(projectMemoryPath(PROJECT_ID, home)).toBe(expected);
  });
});

describe('reconciler.ts never imports the consolidation module', () => {
  it('long-term memory is written only from consolidation.ts’s own entry point, never from the step-driving loop', () => {
    // A direct regression guard for the module doc's own claim — "nothing in src/engine/reconciler.ts
    // imports this module" — which today was checked only by a one-time manual grep, not by anything
    // `npm test` re-runs.
    const reconcilerPath = fileURLToPath(new URL('../src/engine/reconciler.ts', import.meta.url));
    const source = readFileSync(reconcilerPath, 'utf8');
    expect(source).not.toContain('./consolidation');
    expect(source).not.toContain('consolidation.js');
  });
});

describe('runConsolidationPass — the one entry point, and the idempotency acceptance property', () => {
  it('folds and writes in one call', () => {
    writeRun('run-committed', 'feature-committed', [
      territoryDeclared(['src/engine/x.ts']),
      featureStateChanged('committed'),
    ]);

    const written = runConsolidationPass({ orchHome: home, projectId: PROJECT_ID });
    expect(written).toStrictEqual([
      {
        anchor: 'engine',
        anchor_kind: 'module-name',
        claim: 'the run entered committed',
        provenance: 'consolidation:run-committed:engine',
        recorded_at: tsAt(1),
        decay_policy: 'until-refactor',
        decay_features: 0,
      },
    ] satisfies KnowledgeEntry[]);
  });

  it('re-running over an overlapping run-id set never duplicates a fact', () => {
    writeRun('run-a', 'feature-a', [territoryDeclared(['src/engine/x.ts']), featureStateChanged('committed')]);
    writeRun('run-b', 'feature-b', [territoryDeclared(['src/tui/y.ts']), featureStateChanged('handed_off')]);

    const first = runConsolidationPass({
      orchHome: home,
      projectId: PROJECT_ID,
      runIds: ['run-a'],
    });
    expect(first).toHaveLength(1);

    // Second call's run-id set overlaps the first (`run-a` again) and adds a new run (`run-b`).
    const second = runConsolidationPass({
      orchHome: home,
      projectId: PROJECT_ID,
      runIds: ['run-a', 'run-b'],
    });
    expect(second.map((fact) => fact.provenance)).toStrictEqual(['consolidation:run-b:tui']);

    const storePath = projectMemoryPath(PROJECT_ID, home);
    const lines = readFileSync(storePath, 'utf8').split('\n').filter((line) => line !== '');
    expect(lines).toHaveLength(2);
    expect(lines.map((line) => (JSON.parse(line) as KnowledgeEntry).provenance).sort()).toStrictEqual([
      'consolidation:run-a:engine',
      'consolidation:run-b:tui',
    ]);
  });

  it('a multi-area run interrupted between writes still gets the missing area consolidated on a later pass', () => {
    // Simulates a process killed after writing only one of a multi-area run's two facts: the store already
    // carries `consolidation:run-multi-area:engine` but not `...:tui`, so the run's id is "present" in the
    // store even though it is not fully consolidated.
    writeRun('run-multi-area', 'feature-multi-area', [
      territoryDeclared(['src/engine/x.ts', 'src/tui/y.ts']),
      featureStateChanged('committed'),
    ]);
    const candidates = consolidateRun('run-multi-area', { orchHome: home });
    const engineOnly = candidates.filter((fact) => fact.anchor === 'engine');
    expect(engineOnly).toHaveLength(1);
    writeConsolidatedFacts(PROJECT_ID, engineOnly, { orchHome: home });

    const second = runConsolidationPass({
      orchHome: home,
      projectId: PROJECT_ID,
      runIds: ['run-multi-area'],
    });

    // Only the missing `tui` fact is appended: the `engine` fact is skipped as already consolidated.
    expect(second.map((fact) => fact.provenance)).toStrictEqual(['consolidation:run-multi-area:tui']);

    const storePath = projectMemoryPath(PROJECT_ID, home);
    const lines = readFileSync(storePath, 'utf8').split('\n').filter((line) => line !== '');
    expect(lines.map((line) => (JSON.parse(line) as KnowledgeEntry).provenance).sort()).toStrictEqual([
      'consolidation:run-multi-area:engine',
      'consolidation:run-multi-area:tui',
    ]);
  });
});
