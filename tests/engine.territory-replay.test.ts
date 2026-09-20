/**
 * Matrix 8 and 9 — a declared territory rebuilt from the log, and an overlap detectable from two logs.
 *
 * The Consistency Conventions serialise features whose declared territories overlap, and before story 1-11
 * the territory lived only in the in-memory plan and the AD-9 config snapshot. So a replay could see *that*
 * two features were serialised and never *why* — which is a decision AD-4 requires the log to be able to
 * reconstruct, not merely to repeat.
 *
 * The suite also pins the case AD-21 makes unavoidable. A path long enough with no dot and no hyphen is one
 * unbroken high-entropy run and the sweep replaces it, so a replay can meet a territory it cannot fully
 * read. The fail-safe direction is the whole of the design: an incomplete territory becomes the whole
 * repository, which collides with everything — a feature serialised unnecessarily costs a pass, and one
 * admitted wrongly costs another feature's work in a shared worktree.
 */
import { rmSync } from 'node:fs';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { REDACTION_MARKER, readEventLog, runPaths } from '../src/runtime/index.js';
import type { EventEnvelope } from '../src/contracts/index.js';
import {
  Reconciler,
  TERRITORY_DECLARED_EVENT_TYPE,
  WHOLE_REPOSITORY_TERRITORY,
  admissionTerritoryOf,
  admitReplayedTerritories,
  createRecordingResetter,
  createScriptedExecutor,
  normaliseTerritory,
  replayedOverlap,
  territoriesFromLogs,
  territoryDeclaredPayload,
  territoryFromEvents,
  terminated,
} from '../src/engine/index.js';

import { makeHome, makePlan, planProvider } from './helpers/engine-fixture.js';

const BASELINE = 'ddd9bed4d286ac1f8a0f4f7bfef9530046605787';

let home: string;
const toClose: Reconciler[] = [];
const toRemove: string[] = [];

beforeEach(() => {
  home = makeHome('engine-territory-replay');
  toRemove.push(home);
});

afterEach(() => {
  for (const reconciler of toClose.splice(0)) reconciler.close();
  for (const dir of toRemove.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Accept one feature through a real reconciler and hand back its log. */
const acceptedLog = (
  feature: string,
  territory: readonly string[],
): { readonly run: string; readonly events: readonly EventEnvelope[] } => {
  const plan = makePlan({ feature, territory, worktree: `/tmp/wt-${feature}` });
  const reconciler = Reconciler.open({
    orchHome: home,
    executor: createScriptedExecutor({ onStart: (request) => terminated(request.step, 'completed') }),
    plans: planProvider(plan),
    baseline: createRecordingResetter(BASELINE),
  });
  toClose.push(reconciler);
  const accepted = reconciler.acceptFeature(plan);
  reconciler.close();
  toClose.pop();
  return { run: accepted.run, events: readEventLog(runPaths(accepted.run, home).eventLog) };
};

describe('a feature that declared a territory has it rebuilt by replay (matrix 8)', () => {
  it('rebuilds exactly the declared territory, normalised, from the log alone', () => {
    const declared = ['./src/engine/', 'src/runtime/recorder.ts', 'src/engine'];
    const { run, events } = acceptedLog('territory-replay', declared);

    const replayed = territoryFromEvents(events);
    expect(replayed).not.toBeNull();
    expect(replayed?.territory).toStrictEqual(normaliseTerritory(declared));
    expect(replayed?.complete).toBe(true);
    expect(replayed?.unreadable).toBe(0);
    // The run and the feature come off the envelope, never a payload: `run` is on the AD-21 allow-list and
    // a bare ULID in a payload would have been replaced.
    expect(replayed?.run).toBe(run);
    expect(replayed?.feature).toBe('territory-replay');
  });

  it('declares it exactly once per run, at acceptance', () => {
    const { events } = acceptedLog('territory-once', ['src/tui']);
    expect(events.filter((event) => event.type === TERRITORY_DECLARED_EVENT_TYPE)).toHaveLength(1);
  });

  it('lets the later declaration win, because a re-declaration is a correction', () => {
    const { events } = acceptedLog('territory-corrected', ['src/engine']);
    const last = events.at(-1);
    if (last === undefined) throw new Error('the log has lines');
    const corrected: EventEnvelope = {
      ...last,
      seq: events.length + 1,
      type: TERRITORY_DECLARED_EVENT_TYPE,
      payload: territoryDeclaredPayload(['src/tui', 'src/web']),
    };
    const replayed = territoryFromEvents([...events, corrected]);
    expect(replayed?.territory).toStrictEqual(['src/tui', 'src/web']);
    // Not concatenated: the feature does not hold a territory it corrected away from.
    expect(replayed?.territory).not.toContain('src/engine');
  });

  it('answers null for a log that declares none, and never throws (AD-5)', () => {
    expect(territoryFromEvents([])).toBeNull();
    const { events } = acceptedLog('territory-absent', ['src/engine']);
    const withoutDeclaration = events.filter(
      (event) => event.type !== TERRITORY_DECLARED_EVENT_TYPE,
    );
    expect(territoryFromEvents(withoutDeclaration)).toBeNull();
    expect(territoriesFromLogs([withoutDeclaration])).toStrictEqual([]);
  });
});

describe('two features with overlapping territories, rebuilt from the logs (matrix 9)', () => {
  it('detects the overlap from the logs alone, and names the path they both claim', () => {
    const first = acceptedLog('alpha', ['src/engine']);
    const second = acceptedLog('beta', ['src/engine/lock.ts']);

    const [alpha, beta] = territoriesFromLogs([first.events, second.events]);
    if (alpha === undefined || beta === undefined) throw new Error('both logs declare a territory');
    expect(replayedOverlap(alpha, beta)).toStrictEqual(['src/engine']);

    const admission = admitReplayedTerritories([first.events, second.events]);
    // The older run holds the territory, which is the deterministic half: a ULID's order is chronological.
    expect(admission.admitted.map((candidate) => candidate.feature)).toStrictEqual(['alpha']);
    expect(admission.deferred.map((deferral) => deferral.feature)).toStrictEqual(['beta']);
    expect(admission.deferred[0]?.blockedBy).toBe(first.run);
    // The deferral names the *deferred* feature's own colliding path, which is the one its author declared
    // and would recognise; `replayedOverlap` above names it from the other direction.
    expect(admission.deferred[0]?.overlap).toStrictEqual(['src/engine/lock.ts']);
  });

  it('admits two disjoint territories together, so the replay is not simply serialising everything', () => {
    const first = acceptedLog('alpha', ['src/engine']);
    const second = acceptedLog('beta', ['src/tui']);
    const admission = admitReplayedTerritories([first.events, second.events]);
    expect(admission.admitted.map((candidate) => candidate.feature).sort()).toStrictEqual([
      'alpha',
      'beta',
    ]);
    expect(admission.deferred).toStrictEqual([]);
  });

  it('treats a territory the log could not fully carry as colliding with everything (AD-21)', () => {
    // A path with no dot and no hyphen long enough to be one unbroken high-entropy run: the sweep replaces
    // it, so the replay reports what it could not read and refuses to shrink the conflict domain.
    const unreadable: EventEnvelope[] = [
      {
        ts: '2026-09-20T09:00:00.000Z',
        seq: 1,
        feature: 'redacted-territory',
        run: '01K5NQ9ZJ7V3M2P9XQWRTC4BDE',
        step: null,
        emitter: 'engine.reconciler',
        type: TERRITORY_DECLARED_EVENT_TYPE,
        payload: { paths: ['src/engine', REDACTION_MARKER] },
      },
    ];
    const replayed = territoryFromEvents(unreadable);
    if (replayed === null) throw new Error('the log declares a territory');
    expect(replayed.complete).toBe(false);
    expect(replayed.unreadable).toBe(1);
    // The readable half is still reported, and the admission territory is the whole repository.
    expect(replayed.territory).toStrictEqual(['src/engine']);
    expect(admissionTerritoryOf(replayed)).toStrictEqual(WHOLE_REPOSITORY_TERRITORY);

    // So an unrelated feature is serialised behind it rather than admitted alongside it.
    const unrelated = acceptedLog('unrelated', ['docs']);
    const admission = admitReplayedTerritories([unreadable, unrelated.events]);
    expect(admission.deferred).toHaveLength(1);
    expect(admission.deferred[0]?.overlap.length).toBeGreaterThan(0);
  });

  it('reports a complete territory as its own, not as the whole repository', () => {
    const { events } = acceptedLog('complete', ['src/engine']);
    const replayed = territoryFromEvents(events);
    if (replayed === null) throw new Error('the log declares a territory');
    expect(admissionTerritoryOf(replayed)).toStrictEqual(['src/engine']);
    expect(admissionTerritoryOf(replayed)).not.toStrictEqual(WHOLE_REPOSITORY_TERRITORY);
  });
});
