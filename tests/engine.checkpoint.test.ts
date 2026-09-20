/**
 * AD-4 and AD-28 — the checkpoint ranks below the log, and an unrecognised `schema_version` is refused.
 *
 * Four matrix rows: a missing checkpoint is rebuilt from the log, a checkpoint naming a step the log
 * never started is discarded in the log's favour, an interrupted write leaves either the previous
 * checkpoint or the new one, and a `state.json` carrying a version this build does not read is refused
 * rather than silently upgraded.
 *
 * The distinction this suite exists to hold is between *refuse* and *discard*. A checkpoint this build
 * cannot recognise is refused, because AD-28 gives state no forward-compatibility latitude. A checkpoint
 * this build cannot trust — truncated, not JSON, the wrong shape — is discarded, because AD-4 makes it
 * derived and the log can produce another. Confusing the two either strands a run on a corrupt derived
 * file or performs the implicit upgrade AD-28 forbids.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  CURRENT_SCHEMA_VERSION,
  RUN_STATE_FILE_NAME,
  SchemaVersionRefusal,
  featureStateFingerprint,
  formatTimestamp,
} from '../src/contracts/index.js';
import type { EventEnvelope, RunState } from '../src/contracts/index.js';
import { runPaths } from '../src/runtime/index.js';
import type { RunPaths } from '../src/runtime/index.js';
import {
  ENGINE_EMITTER,
  ENGINE_EVENT_TYPES,
  checkpointPath,
  compareCheckpointToLog,
  emptyRunState,
  readCheckpoint,
  rebuildFromLog,
  reconcileCheckpointAgainstLog,
  sweepCheckpointTemporaries,
  writeCheckpoint,
  writeCheckpointNonAtomically,
} from '../src/engine/index.js';
import type { FeaturePlan } from '../src/engine/index.js';

const RUN = '01K5NQ8ZJ7V3M2P9XQWRTC4BDE';
const BASELINE = 'a'.repeat(40);
const OTHER_BASELINE = 'b'.repeat(40);

const PLAN: FeaturePlan = {
  feature: 'engine-reconciler',
  mode: 'live',
  territory: ['src/engine'],
  steps: [
    { step: 'implement', contract_id: 'step.output', phase: 'implementation' },
    { step: 'verify', contract_id: 'step.output', phase: 'verification' },
  ],
  request: 'add the reconciler',
  acceptance_criteria: ['the loop takes one action per pass'],
  starting_model_tier: 'claude-haiku-4-5',
  worktree: '/tmp/worktree',
};

let home: string;
let paths: RunPaths;
let seq = 0;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'orch-engine-checkpoint-'));
  paths = runPaths(RUN, home);
  mkdirSync(paths.runDir, { recursive: true });
  seq = 0;
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

/** An envelope as the recorder would have written it: identifiers in envelope fields, never payloads. */
const event = (
  type: string,
  overrides: Partial<EventEnvelope> = {},
): EventEnvelope => {
  seq += 1;
  return {
    ts: formatTimestamp(new Date(1_770_000_000_000 + seq * 1_000)),
    seq,
    feature: PLAN.feature,
    run: RUN,
    step: null,
    emitter: ENGINE_EMITTER,
    type,
    payload: {},
    ...overrides,
  };
};

/** The log of a run that ran `implement` to completion. */
const completedImplementLog = (): EventEnvelope[] => [
  event(ENGINE_EVENT_TYPES.RunCreated, { payload: { mode: 'live', step_count: 2 } }),
  event(ENGINE_EVENT_TYPES.FeatureStateChanged, { payload: { from: 'drafting', to: 'confirmed' } }),
  event(ENGINE_EVENT_TYPES.FeatureStateChanged, {
    step: 'implement',
    payload: { from: 'confirmed', to: 'running' },
  }),
  event(ENGINE_EVENT_TYPES.StepStarted, {
    step: 'implement',
    baseline_ref: BASELINE,
    payload: {
      attempt: 1,
      phase: 'implementation',
      contract_id: 'step.output',
      model_tier: 'claude-haiku-4-5',
      mode: 'live',
      input: 'steps/implement/input.json',
    },
  }),
  event(ENGINE_EVENT_TYPES.StepTerminated, {
    step: 'implement',
    baseline_ref: BASELINE,
    session_id: 'sess-implement-1',
    payload: { disposition: 'completed' },
  }),
];

const rebuild = (events: readonly EventEnvelope[]): RunState =>
  rebuildFromLog(events, { run: RUN, plan: PLAN });

describe('AD-4 — the checkpoint is rebuilt from the log', () => {
  it('folds an empty log to a drafting run at seq 0', () => {
    const state = rebuild([]);
    expect(state.state).toBe('drafting');
    expect(state.steps).toStrictEqual([]);
    expect(state.last_event_seq).toBe(0);
    expect(state.run).toBe(RUN);
    expect(state.feature).toBe(PLAN.feature);
  });

  it('rebuilds the run when no state.json exists at all, and the run continues', () => {
    const events = completedImplementLog();
    expect(readCheckpoint(paths).discarded?.reason).toBe('absent');

    const rebuilt = rebuild(events);
    expect(rebuilt.state).toBe('running');
    expect(rebuilt.steps).toHaveLength(1);
    expect(rebuilt.steps[0]?.disposition).toBe('completed');
    // The AD-26 ref survives the round trip through the log: it travels as an envelope field, so the
    // AD-21 pass leaves it intact where a payload entry would have been replaced.
    expect(rebuilt.steps[0]?.baseline_ref).toBe(BASELINE);
    expect(rebuilt.steps[0]?.session_id).toBe('sess-implement-1');

    const written = writeCheckpoint(paths, rebuilt);
    expect(readCheckpoint(paths).state).toStrictEqual(written);
  });

  it('records a step still in flight as carrying no disposition', () => {
    const events = completedImplementLog().slice(0, 4);
    const state = rebuild(events);
    expect(state.steps[0]?.disposition).toBeNull();
    expect(state.steps[0]?.started_at).not.toBeNull();
    expect(state.steps[0]?.terminated_at).toBeNull();
  });

  it('counts each start as an attempt and each reset as a reset', () => {
    const events = [
      ...completedImplementLog().slice(0, 4),
      event(ENGINE_EVENT_TYPES.StepTerminated, {
        step: 'implement',
        baseline_ref: BASELINE,
        payload: { disposition: 'interrupted' },
      }),
      event(ENGINE_EVENT_TYPES.StepBaselineReset, { step: 'implement', baseline_ref: BASELINE }),
      event(ENGINE_EVENT_TYPES.StepStarted, {
        step: 'implement',
        baseline_ref: BASELINE,
        payload: { attempt: 2, phase: 'implementation', contract_id: 'step.output' },
      }),
    ];
    const record = rebuild(events).steps[0];
    expect(record?.attempts).toBe(2);
    expect(record?.resets).toBe(1);
    // AD-26 — the ref does not move between attempts, which is what makes the re-run identical.
    expect(record?.baseline_ref).toBe(BASELINE);
  });

  it('spends one promotion and moves the rung', () => {
    const events = [
      ...completedImplementLog().slice(0, 4),
      event(ENGINE_EVENT_TYPES.StepTerminated, {
        step: 'implement',
        payload: { disposition: 'failed' },
      }),
      event(ENGINE_EVENT_TYPES.StepTierPromoted, {
        step: 'implement',
        payload: { from: 'claude-haiku-4-5', to: 'claude-sonnet-5' },
      }),
    ];
    const record = rebuild(events).steps[0];
    expect(record?.promotions).toBe(1);
    expect(record?.model_tier).toBe('claude-sonnet-5');
  });

  it('clears the session id when a resume is refused, so the next routing re-runs', () => {
    const events = [
      ...completedImplementLog().slice(0, 4),
      event(ENGINE_EVENT_TYPES.StepTerminated, {
        step: 'implement',
        session_id: 'sess-implement-1',
        payload: { disposition: 'interrupted' },
      }),
      event(ENGINE_EVENT_TYPES.StepResumeRefused, {
        step: 'implement',
        payload: { code: 'step.resume_failed' },
      }),
    ];
    const record = rebuild(events).steps[0];
    expect(record?.disposition).toBe('interrupted');
    expect(record?.session_id).toBeNull();
  });

  it('orders by seq, not by timestamp, because ts carries no ordering authority', () => {
    // Two events whose timestamps disagree with their seq order: the later `seq` must win.
    const first = event(ENGINE_EVENT_TYPES.FeatureStateChanged, {
      ts: '2026-09-19T23:00:00.000Z',
      payload: { from: 'drafting', to: 'confirmed' },
    });
    const second = event(ENGINE_EVENT_TYPES.FeatureStateChanged, {
      ts: '2026-09-19T01:00:00.000Z',
      payload: { from: 'confirmed', to: 'running' },
    });
    expect(rebuild([second, first]).state).toBe('running');
  });

  it('ignores an unknown event type rather than erroring (AD-5)', () => {
    const events = [
      ...completedImplementLog(),
      event('some.type.a.later.build.invented', { payload: { whatever: true } }),
    ];
    const state = rebuild(events);
    expect(state.state).toBe('running');
    // The unknown line still advances the folded position: it happened, it just means nothing here.
    expect(state.last_event_seq).toBe(events.length);
  });

  it('records a hand-off with its code and the step it happened at', () => {
    const events = [
      ...completedImplementLog(),
      event(ENGINE_EVENT_TYPES.HandoffRecorded, {
        step: 'implement',
        payload: { code: 'not.a.declared.code', reason: 'unrecognised failure' },
      }),
      event(ENGINE_EVENT_TYPES.FeatureStateChanged, {
        payload: { from: 'running', to: 'handed_off' },
      }),
    ];
    const state = rebuild(events);
    expect(state.state).toBe('handed_off');
    expect(state.handoff?.code).toBe('not.a.declared.code');
    expect(state.handoff?.step).toBe('implement');
  });
});

describe('AD-4 — where they disagree, the log wins', () => {
  it('detects a checkpoint naming a step the log never started', () => {
    const rebuilt = rebuild(completedImplementLog());
    const invented: RunState = {
      ...rebuilt,
      steps: [
        ...rebuilt.steps,
        {
          step: 'verify',
          phase: 'verification',
          contract_id: 'step.output',
          disposition: 'completed',
          session_id: null,
          baseline_ref: BASELINE,
          model_tier: 'claude-haiku-4-5',
          promotions: 0,
          attempts: 1,
          resets: 0,
          started_at: rebuilt.updated_at,
          terminated_at: rebuilt.updated_at,
          error: null,
        },
      ],
    };

    const disagreements = compareCheckpointToLog(invented, rebuilt);
    expect(disagreements.map((entry) => entry.field)).toContain('steps.verify');
    expect(disagreements.find((entry) => entry.field === 'steps.verify')?.log).toContain(
      'never started this step',
    );
  });

  it('discards the invented checkpoint and returns the log’s version', () => {
    const rebuilt = rebuild(completedImplementLog());
    const invented: RunState = { ...rebuilt, state: 'committed', last_event_seq: 99 };
    const reconciled = reconcileCheckpointAgainstLog(invented, rebuilt);
    expect(reconciled.checkpointDiscarded).toBe(true);
    expect(reconciled.state).toStrictEqual(rebuilt);
    // The rebuilt state is exactly what replaying the log alone produces — asserted by rebuilding twice.
    expect(featureStateFingerprint(reconciled.state)).toBe(
      featureStateFingerprint(rebuild(completedImplementLog())),
    );
  });

  it('returns the log’s version even when the checkpoint agrees, so the log wins unconditionally', () => {
    const rebuilt = rebuild(completedImplementLog());
    const reconciled = reconcileCheckpointAgainstLog(rebuilt, rebuilt);
    expect(reconciled.disagreements).toStrictEqual([]);
    expect(reconciled.checkpointDiscarded).toBe(false);
    expect(reconciled.state).toBe(rebuilt);
  });

  it('reports a step the log started that the checkpoint has not caught up with', () => {
    const rebuilt = rebuild(completedImplementLog());
    const stale: RunState = { ...rebuilt, steps: [], last_event_seq: 2 };
    const fields = compareCheckpointToLog(stale, rebuilt).map((entry) => entry.field);
    expect(fields).toContain('steps.implement');
    expect(fields).toContain('last_event_seq');
  });

  it.each([
    ['disposition', { disposition: 'failed' as const }],
    ['session_id', { session_id: 'a-different-session' }],
    ['baseline_ref', { baseline_ref: OTHER_BASELINE }],
    ['attempts', { attempts: 7 }],
    ['model_tier', { model_tier: 'claude-opus-5' as const }],
  ])('detects a checkpoint whose %s differs from the log', (field, override) => {
    const rebuilt = rebuild(completedImplementLog());
    const [record] = rebuilt.steps;
    if (record === undefined) throw new Error('the log started a step, so the fold must record one');
    const drifted: RunState = { ...rebuilt, steps: [{ ...record, ...override }] };
    expect(compareCheckpointToLog(drifted, rebuilt).map((entry) => entry.field)).toContain(
      `steps.implement.${field}`,
    );
  });

  it('does not treat a territory change as a checkpoint diverging from the truth', () => {
    // Territory is declared configuration, not run state: the log is not its authority, so a difference
    // there is a configuration change and must not trigger a discard.
    const rebuilt = rebuild(completedImplementLog());
    const reterritoried: RunState = { ...rebuilt, territory: ['src/engine', 'docs/specs'] };
    expect(compareCheckpointToLog(reterritoried, rebuilt)).toStrictEqual([]);
  });
});

describe('every state write is atomic', () => {
  it('writes through a temporary file in the same directory and leaves none behind', () => {
    writeCheckpoint(paths, emptyRunState({ run: RUN, plan: PLAN }));
    const stray = readdirSync(paths.runDir).filter((name) => name.endsWith('.tmp'));
    expect(stray).toStrictEqual([]);
    expect(existsSync(checkpointPath(paths))).toBe(true);
  });

  it('leaves either the previous checkpoint or the new one, never a partial', () => {
    const first = writeCheckpoint(paths, emptyRunState({ run: RUN, plan: PLAN }));
    const second = writeCheckpoint(paths, { ...first, state: 'confirmed' });

    // Every byte on disk is one of the two whole documents. There is no interleaving to test for,
    // because a rename either happened or did not.
    const onDisk = readFileSync(checkpointPath(paths), 'utf8');
    expect([`${JSON.stringify(first, null, 2)}\n`, `${JSON.stringify(second, null, 2)}\n`]).toContain(
      onDisk,
    );
    expect(readCheckpoint(paths).state?.state).toBe('confirmed');
  });

  it('discards a truncated checkpoint, which is what a non-atomic write would have produced', () => {
    const state = writeCheckpoint(paths, emptyRunState({ run: RUN, plan: PLAN }));
    const serialised = JSON.stringify(state, null, 2);
    // The comparison case: writing in place, interrupted halfway. The reader must not accept it.
    writeCheckpointNonAtomically(paths, serialised.slice(0, Math.floor(serialised.length / 2)));

    const read = readCheckpoint(paths);
    expect(read.state).toBeNull();
    expect(read.discarded?.reason).toBe('not-json');
    // Discarded, not refused: it is derived, so the log produces another.
    expect(() => readCheckpoint(paths)).not.toThrow();
  });

  it('sweeps a temporary file a killed write left behind, and touches nothing else', () => {
    writeFileSync(join(paths.runDir, `${RUN_STATE_FILE_NAME}.99999.1.tmp`), '{"partial":', 'utf8');
    writeFileSync(join(paths.runDir, 'fetch-record.json'), '{}', 'utf8');
    expect(sweepCheckpointTemporaries(paths)).toBe(1);
    expect(readdirSync(paths.runDir).filter((name) => name.endsWith('.tmp'))).toStrictEqual([]);
    expect(existsSync(join(paths.runDir, 'fetch-record.json'))).toBe(true);
  });

  it('refuses to write a checkpoint naming another run', () => {
    const foreign = { ...emptyRunState({ run: RUN, plan: PLAN }), run: '01K5NQ9ZJ7V3M2P9XQWRTC4BDE' };
    expect(() => writeCheckpoint(paths, foreign)).toThrowError(/names run/);
  });

  it('refuses to write a checkpoint that is not the declared shape, rather than writing it', () => {
    const invalid = {
      ...emptyRunState({ run: RUN, plan: PLAN }),
      state: 'not-a-state',
    } as unknown as RunState;
    expect(() => writeCheckpoint(paths, invalid)).toThrow();
    // Nothing reached disk, so the next reader does not discard a checkpoint the fold had established.
    expect(existsSync(checkpointPath(paths))).toBe(false);
  });

  it('discards a checkpoint sitting in another run’s directory', () => {
    const foreign = { ...emptyRunState({ run: RUN, plan: PLAN }), run: '01K5NQ9ZJ7V3M2P9XQWRTC4BDE' };
    writeFileSync(checkpointPath(paths), `${JSON.stringify(foreign)}\n`, 'utf8');
    expect(readCheckpoint(paths).discarded?.reason).toBe('foreign-run');
  });

  it('discards a checkpoint that is valid JSON but not a run state', () => {
    writeFileSync(checkpointPath(paths), JSON.stringify({ schema_version: 1, hello: 'world' }), 'utf8');
    expect(readCheckpoint(paths).discarded?.reason).toBe('not-a-run-state');
  });
});

describe('AD-28 — an unrecognised schema_version is refused, never upgraded', () => {
  it('refuses a newer version, naming the file and stating which versions this build reads', () => {
    const future = { ...emptyRunState({ run: RUN, plan: PLAN }), schema_version: CURRENT_SCHEMA_VERSION + 1 };
    writeFileSync(checkpointPath(paths), `${JSON.stringify(future)}\n`, 'utf8');

    expect(() => readCheckpoint(paths)).toThrowError(SchemaVersionRefusal);
    expect(() => readCheckpoint(paths)).toThrowError(new RegExp(`runs/${RUN}/state\\.json`));
    expect(() => readCheckpoint(paths)).toThrowError(/nothing is upgraded implicitly/);
  });

  it('refuses an older version too, and states the direction', () => {
    const older = { ...emptyRunState({ run: RUN, plan: PLAN }), schema_version: 0 };
    writeFileSync(checkpointPath(paths), `${JSON.stringify(older)}\n`, 'utf8');
    let raised: SchemaVersionRefusal | null = null;
    try {
      readCheckpoint(paths);
    } catch (thrown: unknown) {
      raised = thrown as SchemaVersionRefusal;
    }
    expect(raised).toBeInstanceOf(SchemaVersionRefusal);
    expect(raised?.schemaVersion).toBe(0);
    expect(raised?.message).toContain('older than');
  });

  it('refuses rather than discards, so a version refusal is never mistaken for a rebuildable file', () => {
    const future = { ...emptyRunState({ run: RUN, plan: PLAN }), schema_version: 99 };
    writeFileSync(checkpointPath(paths), `${JSON.stringify(future)}\n`, 'utf8');
    // A discard here would rebuild over the file and destroy the evidence of which installer wrote it.
    expect(() => readCheckpoint(paths)).toThrowError(SchemaVersionRefusal);
    expect(readFileSync(checkpointPath(paths), 'utf8')).toContain('"schema_version":99');
  });

  it('accepts the version this build writes', () => {
    writeCheckpoint(paths, emptyRunState({ run: RUN, plan: PLAN }));
    expect(readCheckpoint(paths).state?.schema_version).toBe(CURRENT_SCHEMA_VERSION);
  });
});
