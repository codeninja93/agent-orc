/**
 * Story 3-3 — `shadowGateVerdict`, matrix rows 15-17.
 *
 * A cross-run fold, so — matching `tests/engine.trust-record.test.ts` and `tests/tui.fleet.test.ts`'s own
 * reasoning — the fixture is real run directories on disk rather than hand-built views.
 *
 * Run ids are the ULID-shaped, zero-padded sequence `tests/tui.fleet.test.ts` already uses: `listRunIds`
 * sorts lexicographically, which is chronological for a real ULID, so the padded numeric suffix here keeps
 * "oldest first" exactly the order the fold itself relies on.
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  SHADOW_COMPARED_EVENT_TYPE,
  SHADOW_COMPARED_PAYLOAD_KEYS,
  WRITE_SUPPRESSED_EVENT_TYPE,
  WRITE_SUPPRESSED_PAYLOAD_KEYS,
} from '../src/contracts/index.js';
import { SHADOW_GATE_WINDOW_SIZE, shadowGateVerdict } from '../src/engine/index.js';
import { runPaths } from '../src/runtime/index.js';

import { makeHome } from './helpers/engine-fixture.js';
import { buildLog, logText } from './helpers/tui-log.js';
import type { EventSpec } from './helpers/tui-log.js';

let home: string;
const toRemove: string[] = [];

beforeEach(() => {
  home = makeHome('engine-shadow-gate');
  toRemove.push(home);
});

afterEach(() => {
  for (const dir of toRemove.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const runIdFor = (index: number): string => `01K5NQ9ZJ7V3M2P9XQWRTC4B${String(index).padStart(2, '0')}`;

const shadowCompared = (outcome: 'accepted' | 'material_change'): EventSpec => ({
  type: SHADOW_COMPARED_EVENT_TYPE,
  payload: {
    [SHADOW_COMPARED_PAYLOAD_KEYS.Outcome]: outcome,
    [SHADOW_COMPARED_PAYLOAD_KEYS.ShadowTreeRef]: 'HEAD',
    [SHADOW_COMPARED_PAYLOAD_KEYS.RealMergeCommit]: 'c'.repeat(40),
  },
});

const writeSuppressed = (destructive: boolean): EventSpec => ({
  type: WRITE_SUPPRESSED_EVENT_TYPE,
  payload: {
    [WRITE_SUPPRESSED_PAYLOAD_KEYS.IntentId]: 'shadow.git_push',
    [WRITE_SUPPRESSED_PAYLOAD_KEYS.Kind]: 'git_push',
    [WRITE_SUPPRESSED_PAYLOAD_KEYS.Target]: 'feature/shadowed',
    [WRITE_SUPPRESSED_PAYLOAD_KEYS.Destructive]: destructive,
    [WRITE_SUPPRESSED_PAYLOAD_KEYS.Detail]: 'the probe found this in the test fixture',
  },
});

const writeGradedRun = (index: number, specs: readonly EventSpec[]): void => {
  const runId = runIdFor(index);
  const paths = runPaths(runId, home);
  mkdirSync(paths.runDir, { recursive: true });
  writeFileSync(paths.eventLog, logText(buildLog(specs, { feature: `shadow-${String(index)}`, run: runId })), 'utf8');
};

describe('shadowGateVerdict — matrix row 15: fewer than the window size', () => {
  it('reports met: false with the true count, never padded and never inapplicable', () => {
    for (let index = 1; index <= 5; index += 1) writeGradedRun(index, [shadowCompared('accepted')]);

    expect(shadowGateVerdict({ orchHome: home })).toStrictEqual({
      runsInWindow: 5,
      accepted: 5,
      materialChange: 0,
      destructive: 0,
      met: false,
    });
  });

  it('reports met: false, with zero, on a fleet with no graded shadow runs at all', () => {
    expect(shadowGateVerdict({ orchHome: home })).toStrictEqual({
      runsInWindow: 0,
      accepted: 0,
      materialChange: 0,
      destructive: 0,
      met: false,
    });
  });
});

describe('shadowGateVerdict — matrix row 16: the window clears the 80% bar', () => {
  it('reports met: true when the most recent 20 graded runs clear 80% accepted with zero destructive', () => {
    // The oldest 5, dropped by the rolling window, are all accepted — so the total across all 25 graded
    // runs is 21 accepted (matching the matrix's own "25 graded, 21 accepted"), while the windowed 20
    // (16 accepted, 4 material_change) sit exactly on the 80% bar the gate actually checks.
    for (let index = 1; index <= 5; index += 1) writeGradedRun(index, [shadowCompared('accepted')]);
    for (let index = 6; index <= 21; index += 1) writeGradedRun(index, [shadowCompared('accepted')]);
    for (let index = 22; index <= 25; index += 1) writeGradedRun(index, [shadowCompared('material_change')]);

    expect(shadowGateVerdict({ orchHome: home })).toStrictEqual({
      runsInWindow: SHADOW_GATE_WINDOW_SIZE,
      accepted: 16,
      materialChange: 4,
      destructive: 0,
      met: true,
    });
  });
});

describe('shadowGateVerdict — matrix row 17: zero-tolerance overrides the accept rate', () => {
  it('reports met: false when one destructive write exists anywhere in the window, even at 100% accepted', () => {
    // The oldest 5 (dropped) are 4 accepted + 1 material_change, so the total across 25 is 24 accepted
    // (matching the matrix's own "25 graded, 24 accepted"); the windowed 20 are all accepted (96% overall,
    // 100% windowed), but one of them also suppressed a destructive write.
    for (let index = 1; index <= 4; index += 1) writeGradedRun(index, [shadowCompared('accepted')]);
    writeGradedRun(5, [shadowCompared('material_change')]);
    for (let index = 6; index <= 25; index += 1) {
      const specs: EventSpec[] = [shadowCompared('accepted')];
      if (index === 10) specs.push(writeSuppressed(true));
      writeGradedRun(index, specs);
    }

    expect(shadowGateVerdict({ orchHome: home })).toStrictEqual({
      runsInWindow: SHADOW_GATE_WINDOW_SIZE,
      accepted: SHADOW_GATE_WINDOW_SIZE,
      materialChange: 0,
      destructive: 1,
      met: false,
    });
  });

  it('counts a non-destructive write.suppressed toward nothing', () => {
    for (let index = 1; index <= SHADOW_GATE_WINDOW_SIZE; index += 1) {
      writeGradedRun(index, [shadowCompared('accepted'), writeSuppressed(false)]);
    }

    expect(shadowGateVerdict({ orchHome: home })).toStrictEqual({
      runsInWindow: SHADOW_GATE_WINDOW_SIZE,
      accepted: SHADOW_GATE_WINDOW_SIZE,
      materialChange: 0,
      destructive: 0,
      met: true,
    });
  });
});

describe('shadowGateVerdict — destructive stops counting once a run falls out of the window', () => {
  it('never counts a destructive write from a run older than the most recent window', () => {
    // The oldest run (dropped by the window) suppressed a destructive write; the 20 most recent are all
    // accepted with nothing destructive. If the destructive tally leaked past the window boundary, this
    // would report `destructive: 1` and `met: false` instead.
    writeGradedRun(1, [shadowCompared('accepted'), writeSuppressed(true)]);
    for (let index = 2; index <= SHADOW_GATE_WINDOW_SIZE + 1; index += 1) {
      writeGradedRun(index, [shadowCompared('accepted')]);
    }

    expect(shadowGateVerdict({ orchHome: home })).toStrictEqual({
      runsInWindow: SHADOW_GATE_WINDOW_SIZE,
      accepted: SHADOW_GATE_WINDOW_SIZE,
      materialChange: 0,
      destructive: 0,
      met: true,
    });
  });
});

describe('shadowGateVerdict — folds only the runs it is given, when a caller already knows them', () => {
  it('ignores a run outside the supplied ids', () => {
    writeGradedRun(1, [shadowCompared('accepted')]);
    writeGradedRun(2, [shadowCompared('material_change')]);

    const verdict = shadowGateVerdict({ orchHome: home, runIds: [runIdFor(1)] });
    expect(verdict.runsInWindow).toBe(1);
    expect(verdict.accepted).toBe(1);
    expect(verdict.materialChange).toBe(0);
  });
});
