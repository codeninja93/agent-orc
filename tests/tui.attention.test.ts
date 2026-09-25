/**
 * Story 4-4 — exceptions-only notifications.
 *
 * `runsNeedingAttention` and `buildAttentionCard` are exercised directly against every row of the
 * story's I/O Matrix. Fixtures are hand-folded `ShellView`s built from `idleShellView`, not real event
 * logs: the classification under test is a total function of five already-computed fields (`problem`,
 * `question.state`, `featureState`), so holding those five steady is enough — whether the fold itself
 * computes them correctly from a log is `tests/tui.projection.test.ts`'s job, not this one's.
 */
import { describe, expect, it } from 'vitest';

import {
  MAX_FLEET_RUNS,
  UNNAMED_FEATURE,
  buildAttentionCard,
  cardLines,
  handoffSentence,
  idleShellView,
  isRunInFlight,
  runsNeedingAttention,
} from '../src/tui/index.js';
import type { FleetRun, FleetView, ShellView } from '../src/tui/index.js';

/** One fleet run, folded from a `ShellView` built by overriding `idleShellView`'s defaults. */
const runOf = (feature: string | null, overrides: Partial<ShellView> = {}): FleetRun => {
  const view: ShellView = { ...idleShellView(feature), ...overrides };
  return { runId: `run-id-for-${feature ?? 'unnamed'}`, view, inFlight: isRunInFlight(view) };
};

const fleetOf = (runs: readonly FleetRun[], notRead = 0): FleetView => ({ runs, notRead });

describe('runsNeedingAttention', () => {
  it('returns [] for a fleet of ordinary, unattended progress', () => {
    const fleet = fleetOf([
      runOf('running-run', { featureState: 'running' }),
      runOf('verifying-run', { featureState: 'verifying' }),
      runOf('confirmed-run', { featureState: 'confirmed' }),
      runOf('drafting-run', { featureState: 'drafting' }),
      runOf('degraded-run', { featureState: 'degraded' }),
      runOf('awaiting-merge-run', { featureState: 'awaiting_merge' }),
    ]);
    expect(runsNeedingAttention(fleet)).toEqual([]);
  });

  it('tags a mixed fleet: blocked as decision_point, committed as completion, running absent', () => {
    const blocked = runOf('blocked-run', { featureState: 'blocked' });
    const committed = runOf('committed-run', { featureState: 'committed' });
    const running = runOf('running-run', { featureState: 'running' });
    const entries = runsNeedingAttention(fleetOf([blocked, committed, running]));
    expect(entries).toEqual([
      { run: blocked, reason: 'decision_point' },
      { run: committed, reason: 'completion' },
    ]);
  });

  it('tags interrupted as decision_point too', () => {
    const run = runOf('interrupted-run', { featureState: 'interrupted' });
    expect(runsNeedingAttention(fleetOf([run]))).toEqual([{ run, reason: 'decision_point' }]);
  });

  it('tags an unreadable log as exception, independent of featureState', () => {
    const run = runOf('broken-run', {
      featureState: 'running',
      problem: 'the log could not be read',
    });
    expect(runsNeedingAttention(fleetOf([run]))).toEqual([{ run, reason: 'exception' }]);
  });

  it('tags a pending question as decision_point mid-run, not missed because state is not blocked', () => {
    const run = runOf('mid-run', {
      featureState: 'running',
      question: { ...idleShellView().question, state: 'pending' },
    });
    expect(runsNeedingAttention(fleetOf([run]))).toEqual([{ run, reason: 'decision_point' }]);
  });

  it('gives a killed run no entry and a hibernated run exception', () => {
    const killed = runOf('killed-run', { featureState: 'killed' });
    const hibernated = runOf('hibernated-run', { featureState: 'hibernated' });
    expect(runsNeedingAttention(fleetOf([killed, hibernated]))).toEqual([
      { run: hibernated, reason: 'exception' },
    ]);
  });

  it('tags a handed-off run as exception', () => {
    const run = runOf('handed-off-run', { featureState: 'handed_off' });
    expect(runsNeedingAttention(fleetOf([run]))).toEqual([{ run, reason: 'exception' }]);
  });

  it('returns [] for an empty fleet', () => {
    expect(runsNeedingAttention(fleetOf([]))).toEqual([]);
  });

  it('returns [] for a run whose featureState is null, a real reachable silent case', () => {
    const run = runOf('never-started-run', { featureState: null });
    expect(runsNeedingAttention(fleetOf([run]))).toEqual([]);
  });

  it('tags a decision_point run whose featureState is handed_off/hibernated/committed but whose question is still pending', () => {
    for (const featureState of ['handed_off', 'hibernated', 'committed'] as const) {
      const run = runOf(`pending-question-${featureState}`, {
        featureState,
        question: { ...idleShellView().question, state: 'pending' },
      });
      const entries = runsNeedingAttention(fleetOf([run]));
      expect(entries).toEqual([{ run, reason: 'decision_point' }]);
    }
  });
});

describe('buildAttentionCard', () => {
  it('states nothing needs the person when nothing does, with no entries', () => {
    const card = buildAttentionCard(fleetOf([runOf('running-run', { featureState: 'running' })]));
    expect(card.entries).toEqual([]);
    expect(card.lines).toEqual([]);
    expect(card.title.toLowerCase()).toContain('nothing needs you');
  });

  it('reads the same for an empty fleet as for a fleet where nothing needs attention', () => {
    const empty = buildAttentionCard(fleetOf([]));
    const quiet = buildAttentionCard(fleetOf([runOf('running-run', { featureState: 'running' })]));
    expect(empty.title).toBe(quiet.title);
    expect(empty.lines).toEqual(quiet.lines);
    expect(empty.entries).toEqual(quiet.entries);
  });

  it('carries one entry per run needing attention, tagged with its reason', () => {
    const blocked = runOf('blocked-run', { featureState: 'blocked' });
    const committed = runOf('committed-run', { featureState: 'committed' });
    const running = runOf('running-run', { featureState: 'running' });
    const card = buildAttentionCard(fleetOf([blocked, committed, running]));
    expect(card.entries).toEqual([
      expect.objectContaining({ feature: 'blocked-run', reason: 'decision_point' }),
      expect.objectContaining({ feature: 'committed-run', reason: 'completion' }),
    ]);
    expect(card.title).toContain('2');
  });

  it('never renders a run id, addresses runs by feature name, and falls back to UNNAMED_FEATURE', () => {
    const named = runOf('checkout', { featureState: 'blocked' });
    const unnamed = runOf(null, { featureState: 'blocked' });
    const card = buildAttentionCard(fleetOf([named, unnamed]));
    const text = cardLines(card).join('\n');
    expect(text).not.toContain(named.runId);
    expect(text).not.toContain(unnamed.runId);
    expect(text).toContain('checkout');
    expect(text).toContain(UNNAMED_FEATURE);
  });

  it('says how many runs were not read, in the title, for both the empty and non-empty cases', () => {
    const quiet = buildAttentionCard(fleetOf([runOf('running-run', { featureState: 'running' })], 3));
    expect(quiet.entries).toEqual([]);
    expect(quiet.title.toLowerCase()).toContain('nothing needs you');
    expect(quiet.title).toContain(String(MAX_FLEET_RUNS));

    const blocked = runOf('blocked-run', { featureState: 'blocked' });
    const nonEmpty = buildAttentionCard(fleetOf([blocked], 3));
    expect(nonEmpty.entries).toHaveLength(1);
    expect(nonEmpty.title).toContain('1');
    expect(nonEmpty.title).toContain(String(MAX_FLEET_RUNS));
  });

  it("drops the raw reason slug from a line's text, using only the feature and the detail sentence", () => {
    const blocked = runOf('blocked-run', { featureState: 'blocked' });
    const card = buildAttentionCard(fleetOf([blocked]));
    expect(card.lines).toEqual([`blocked-run — ${blocked.view.progress.nextGate}`]);
    expect(card.lines[0]).not.toContain('decision_point');
  });

  it("states each branch's detail sentence", () => {
    const handoff = { code: 'AD-35-X', reason: 'ran out of budget', at: '2026-09-25T00:00:00.000Z' };
    const handedOffWithReason = runOf('handed-off-with-reason', {
      featureState: 'handed_off',
      handoff,
    });
    const handedOffNoReason = runOf('handed-off-no-reason', {
      featureState: 'handed_off',
      handoff: null,
    });
    const hibernated = runOf('hibernated-run', { featureState: 'hibernated' });
    const committed = runOf('committed-run', { featureState: 'committed' });
    const blocked = runOf('blocked-run', { featureState: 'blocked' });

    const card = buildAttentionCard(
      fleetOf([handedOffWithReason, handedOffNoReason, hibernated, committed, blocked]),
    );

    const byFeature = Object.fromEntries(card.entries.map((entry) => [entry.feature, entry.detail]));
    expect(byFeature['handed-off-with-reason']).toBe(handoffSentence(handoff));
    expect(byFeature['handed-off-no-reason']).toBe('the run handed off, but recorded no reason');
    expect(byFeature['hibernated-run']).toBe('a ceiling was reached and the run hibernated on its own');
    expect(byFeature['committed-run']).toBe('the work is committed');
    expect(byFeature['blocked-run']).toBe(blocked.view.progress.nextGate);
  });

  it('gives a decision_point reason and the nextGate detail to a handed-off/hibernated/committed run whose question is still pending', () => {
    for (const featureState of ['handed_off', 'hibernated', 'committed'] as const) {
      const run = runOf(`pending-question-${featureState}`, {
        featureState,
        question: { ...idleShellView().question, state: 'pending' },
      });
      const card = buildAttentionCard(fleetOf([run]));
      expect(card.entries).toEqual([
        { feature: `pending-question-${featureState}`, reason: 'decision_point', detail: run.view.progress.nextGate },
      ]);
    }
  });

  it('is not bounded to a screen height: every entry appears, however many there are', () => {
    const many = Array.from({ length: 50 }, (_unused, index) =>
      runOf(`blocked-run-${String(index)}`, { featureState: 'blocked' }),
    );
    const card = buildAttentionCard(fleetOf(many));
    expect(card.entries).toHaveLength(50);
    expect(card.lines).toHaveLength(50);
  });
});
