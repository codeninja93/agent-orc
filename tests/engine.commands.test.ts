/**
 * AD-19 — the durable command transport.
 *
 * The property this suite exists to pin is the one the story calls its crux: **delivery is at-least-once
 * and the effect is exactly-once**. Everything else here serves it. A file is never deleted by being
 * read; a redelivered intent has one effect; a crash between reading an intent and recording its effect
 * loses nothing; and nothing the loop cannot understand is met again on every later pass.
 *
 * Two tests are deliberately about *shape*, because getting them wrong is silent. An intent id that the
 * AD-21 redaction pass would replace destroys the exactly-once key in the only place it is durably kept,
 * and story 1-2's and 1-3's reviews both caught a test that missed exactly that class of bug by using a
 * low-entropy stand-in. So the round-trip here is driven through a real recorder with a real minted id.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CURRENT_SCHEMA_VERSION, formatTimestamp } from '../src/contracts/index.js';
import type { CommandIntent, EventEnvelope } from '../src/contracts/index.js';
import { REDACTION_MARKER, readEventLog, runPaths } from '../src/runtime/index.js';
import {
  COMMAND_EVENT_TYPES,
  MAX_INTENT_ID_TOKEN_RUN,
  Reconciler,
  appliedIntentIds,
  createRecordingResetter,
  createScriptedExecutor,
  intentFileName,
  isLoggableIntentId,
  mintIntentId,
  mintRunId,
  newCommandIntent,
  orderIntents,
  quarantineIntent,
  readIntentFiles,
  rebuildFromLog,
  retireIntent,
  terminated,
  writeCommandIntent,
  writeCommandIntentTruncated,
} from '../src/engine/index.js';
import type { PendingIntent } from '../src/engine/index.js';

import { makeHome, makePlan, planProvider } from './helpers/engine-fixture.js';

const BASELINE = 'ddd9bed4d286ac1f8a0f4f7bfef9530046605787';

let home: string;
const toRemove: string[] = [];
const toClose: Reconciler[] = [];

beforeEach(() => {
  home = makeHome('engine-commands');
  toRemove.push(home);
});

afterEach(() => {
  for (const reconciler of toClose.splice(0)) reconciler.close();
  for (const dir of toRemove.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A reconciler whose every step completes, over one plan. */
const openReconciler = (): { readonly reconciler: Reconciler; readonly executor: ReturnType<typeof createScriptedExecutor> } => {
  const executor = createScriptedExecutor({
    onStart: (request) => terminated(request.step, 'completed', { sessionId: `sess-${request.step}` }),
    sessionIdFor: (request) => `sess-${request.step}`,
  });
  const reconciler = Reconciler.open({
    orchHome: home,
    executor,
    plans: planProvider(makePlan()),
    baseline: createRecordingResetter(BASELINE),
  });
  toClose.push(reconciler);
  return { reconciler, executor };
};

const anIntent = (overrides: Partial<CommandIntent> = {}): CommandIntent =>
  newCommandIntent({
    intentId: overrides.intent_id ?? mintIntentId(mintRunId()),
    command: overrides.command ?? 'kill',
    run: overrides.run ?? '01K5NQ9ZJ7V3M2P9XQWRTC4BDE',
    feature: overrides.feature ?? 'engine-reconciler',
    step: overrides.step ?? null,
    principal: overrides.principal ?? { kind: 'user', id: 'deep' },
    source: overrides.source ?? 'tui',
    argument: overrides.argument ?? null,
    ...(overrides.issued_at === undefined ? {} : { issuedAt: new Date(overrides.issued_at) }),
  });

/** Write a file into `commands/` by hand, as a renderer of a later build or another version might. */
const writeRawIntentFile = (run: string, name: string, body: string): string => {
  const paths = runPaths(run, home);
  mkdirSync(paths.commandsDir, { recursive: true });
  const target = join(paths.commandsDir, name);
  writeFileSync(target, body, 'utf8');
  return target;
};

describe('an intent is a durable file, and the only command path', () => {
  it('writes into commands/ and reads back the contract it wrote', () => {
    const run = '01K5NQ9ZJ7V3M2P9XQWRTC4BDE';
    const paths = runPaths(run, home);
    const intent = anIntent({ run, command: 'disengage' });

    const written = writeCommandIntent(paths, intent);
    expect(existsSync(written)).toBe(true);
    expect(written.startsWith(paths.commandsDir)).toBe(true);

    const read = readIntentFiles(paths);
    expect(read.pending).toHaveLength(1);
    expect(read.pending[0]?.intent).toStrictEqual(intent);
    expect(read.refused).toStrictEqual([]);
  });

  it('refuses to write an intent into the commands directory of another run', () => {
    const paths = runPaths('01K5NQ9ZJ7V3M2P9XQWRTC4BDE', home);
    expect(() => writeCommandIntent(paths, anIntent({ run: '01K5NQ9ZJ7V3M2P9XQWRTC4BDF' }))).toThrowError(
      /names run/,
    );
  });

  it('never deletes a file it has read: reading twice yields the same intent', () => {
    const run = '01K5NQ9ZJ7V3M2P9XQWRTC4BDE';
    const paths = runPaths(run, home);
    writeCommandIntent(paths, anIntent({ run }));

    expect(readIntentFiles(paths).pending).toHaveLength(1);
    // At-most-once delivery is what deleting on read would produce, and a lost disengage is the cost.
    expect(readIntentFiles(paths).pending).toHaveLength(1);
  });
});

describe('a file the loop cannot understand is refused, and never retried for ever', () => {
  const run = '01K5NQ9ZJ7V3M2P9XQWRTC4BDE';

  it('refuses a command outside the enum, naming what it is not', () => {
    const paths = runPaths(run, home);
    const intent = anIntent({ run });
    writeRawIntentFile(
      run,
      intentFileName(intent),
      JSON.stringify({ ...intent, command: 'self_destruct' }),
    );

    const read = readIntentFiles(paths);
    expect(read.pending).toStrictEqual([]);
    expect(read.refused).toHaveLength(1);
    expect(read.refused[0]?.reason).toBe('unrecognised-command');
    expect(read.refused[0]?.detail).toContain('self_destruct');
  });

  it('refuses an intent with no principal, naming the field', () => {
    const paths = runPaths(run, home);
    const intent = anIntent({ run });
    const { principal: _absent, ...withoutPrincipal } = intent;
    writeRawIntentFile(run, intentFileName(intent), JSON.stringify(withoutPrincipal));

    const read = readIntentFiles(paths);
    expect(read.refused).toHaveLength(1);
    expect(read.refused[0]?.reason).toBe('missing-principal');
    expect(read.refused[0]?.detail).toContain('principal');
  });

  it('refuses an intent id the redaction pass would replace, because the key would be lost', () => {
    const paths = runPaths(run, home);
    // A bare ULID: 26 unbroken high-entropy characters, which is exactly what AD-21 sweeps.
    const ulid = mintRunId();
    expect(isLoggableIntentId(ulid)).toBe(false);
    const intent = anIntent({ run });
    writeRawIntentFile(run, `hand-written.json`, JSON.stringify({ ...intent, intent_id: ulid }));

    const read = readIntentFiles(paths);
    expect(read.refused).toHaveLength(1);
    expect(read.refused[0]?.reason).toBe('unloggable-intent-id');
    expect(() => writeCommandIntent(paths, { ...intent, intent_id: ulid })).toThrowError(/intent id/);
  });

  it('refuses an intent addressed to another run, naming both', () => {
    const paths = runPaths(run, home);
    const foreign = anIntent({ run: '01K5NQ9ZJ7V3M2P9XQWRTC4BDF' });
    writeRawIntentFile(run, intentFileName(foreign), JSON.stringify(foreign));

    const read = readIntentFiles(paths);
    expect(read.refused[0]?.reason).toBe('misaddressed');
  });

  it('refuses whole JSON that is not a command intent at all', () => {
    const paths = runPaths(run, home);
    writeRawIntentFile(run, 'not-an-intent.json', JSON.stringify({ hello: 'world' }));
    expect(readIntentFiles(paths).refused[0]?.reason).toBe('malformed');
  });

  it('quarantines a refused file into commands/refused/ with the reason beside it', () => {
    const paths = runPaths(run, home);
    writeRawIntentFile(run, 'not-an-intent.json', JSON.stringify({ hello: 'world' }));
    const found = readIntentFiles(paths).refused[0];
    expect(found).toBeDefined();
    if (found === undefined) return;

    const quarantined = quarantineIntent(paths, found);
    expect(quarantined.quarantinedTo).not.toBeNull();
    // Moved, not deleted: the evidence of what a renderer wrote survives.
    expect(existsSync(join(paths.commandsDir, 'not-an-intent.json'))).toBe(false);
    expect(existsSync(join(paths.commandsRefusedDir, 'not-an-intent.json'))).toBe(true);

    const sidecar = JSON.parse(
      readFileSync(join(paths.commandsRefusedDir, 'not-an-intent.json.refusal.json'), 'utf8'),
    ) as { reason: string; detail: string };
    expect(sidecar.reason).toBe('malformed');

    // And it is gone from the pending set, so no later pass meets it again.
    expect(readIntentFiles(paths).refused).toStrictEqual([]);
    expect(readIntentFiles(paths).pending).toStrictEqual([]);
  });
});

describe('a torn file is not consumed, and not a poison file either', () => {
  const run = '01K5NQ9ZJ7V3M2P9XQWRTC4BDE';

  it('leaves a partial write alone while its writer might still be finishing', () => {
    const paths = runPaths(run, home);
    const path = writeCommandIntentTruncated(paths, anIntent({ run }), 40);

    const read = readIntentFiles(paths);
    // Refused of nothing, applied to nothing, and *still there*: the matrix's "not treated as consumed".
    expect(read.pending).toStrictEqual([]);
    expect(read.refused).toStrictEqual([]);
    expect(read.incomplete).toHaveLength(1);
    expect(existsSync(path)).toBe(true);
  });

  it('treats a partial write older than the grace as abandoned, and quarantines it', () => {
    const paths = runPaths(run, home);
    writeCommandIntentTruncated(paths, anIntent({ run }), 40);

    // The only honest discriminator between a writer mid-write and a writer that died is time.
    const read = readIntentFiles(paths, { tornGraceMs: 0 });
    expect(read.refused).toHaveLength(1);
    expect(read.refused[0]?.reason).toBe('abandoned-partial-write');
    expect(read.incomplete).toStrictEqual([]);
  });

  it('applies the valid intent sitting beside a torn one in the same pass', () => {
    const paths = runPaths(run, home);
    writeCommandIntentTruncated(paths, anIntent({ run, command: 'kill' }), 30);
    writeCommandIntent(paths, anIntent({ run, command: 'disengage' }));

    const read = readIntentFiles(paths);
    expect(read.pending).toHaveLength(1);
    expect(read.pending[0]?.intent.command).toBe('disengage');
  });
});

describe('two intents in one pass are ordered deterministically', () => {
  const pending = (issuedAt: string, intentId: string): PendingIntent => ({
    intent: anIntent({ issued_at: issuedAt, intent_id: intentId }),
    fileName: `${issuedAt}__${intentId}.json`,
    path: `/nowhere/${intentId}.json`,
  });

  it('orders by issue time, then by intent id, whatever order they arrived in', () => {
    const early = pending('2026-09-20T10:00:00.000Z', 'cmd-b');
    const late = pending('2026-09-20T10:00:01.000Z', 'cmd-a');
    const tie = pending('2026-09-20T10:00:00.000Z', 'cmd-a');

    const forwards = orderIntents([early, late, tie]).map((entry) => entry.intent.intent_id);
    const backwards = orderIntents([late, tie, early]).map((entry) => entry.intent.intent_id);

    expect(forwards).toStrictEqual(['cmd-a', 'cmd-b', 'cmd-a']);
    // The same three in a different arrival order reach the same sequence: a restart cannot diverge.
    expect(backwards).toStrictEqual(forwards);
  });

  it('reads a directory in a stable order regardless of how the filesystem listed it', () => {
    const run = '01K5NQ9ZJ7V3M2P9XQWRTC4BDE';
    const paths = runPaths(run, home);
    writeCommandIntent(paths, anIntent({ run, command: 'kill', issued_at: '2026-09-20T10:00:02.000Z' }));
    writeCommandIntent(paths, anIntent({ run, command: 'approve', issued_at: '2026-09-20T10:00:01.000Z' }));

    expect(readIntentFiles(paths).pending.map((entry) => entry.intent.command)).toStrictEqual([
      'approve',
      'kill',
    ]);
  });
});

describe('the exactly-once key survives the log, which is what makes redelivery safe', () => {
  it('mints an id with no run long enough for the AD-21 entropy sweep to reach', () => {
    const minted = mintIntentId(mintRunId());
    expect(isLoggableIntentId(minted)).toBe(true);
    for (const token of minted.match(/[A-Za-z0-9+/=]+/g) ?? []) {
      expect(token.length).toBeLessThanOrEqual(MAX_INTENT_ID_TOKEN_RUN);
    }
  });

  it('reads a minted id back out of a real event log unchanged', async () => {
    const { reconciler } = openReconciler();
    const accepted = reconciler.acceptFeature(makePlan());
    const intentId = mintIntentId(mintRunId());
    reconciler.confirm(accepted.run, { intentId });
    await reconciler.pass();

    const applied = readEventLog(runPaths(accepted.run, home).eventLog).filter(
      (event) => event.type === COMMAND_EVENT_TYPES.Applied,
    );
    expect(applied).toHaveLength(1);
    // Verbatim, not `[redacted]`. A redacted id would silently destroy the exactly-once ledger, and the
    // run would keep working — which is why this is asserted against a real minted id and a real pass.
    expect(applied[0]?.payload['intent_id']).toBe(intentId);
    expect(JSON.stringify(applied[0]?.payload)).not.toContain(REDACTION_MARKER);
    expect(appliedIntentIds(readEventLog(runPaths(accepted.run, home).eventLog)).has(intentId)).toBe(true);
  });

  it('applies a redelivered intent exactly once, and retires the file both times', async () => {
    const { reconciler } = openReconciler();
    const accepted = reconciler.acceptFeature(makePlan());
    const paths = runPaths(accepted.run, home);

    const intent = newCommandIntent({
      intentId: mintIntentId(mintRunId()),
      command: 'confirm_spec',
      run: accepted.run,
      feature: 'engine-reconciler',
      principal: { kind: 'user', id: 'deep' },
      source: 'tui',
    });

    writeCommandIntent(paths, intent);
    const first = await reconciler.pass();
    expect(first.steering[0]?.applied.map((entry) => entry.kind)).toStrictEqual(['applied']);
    expect(reconciler.load(accepted.run).state.state).toBe('confirmed');

    // The same intent presented again — a renderer that could not tell whether its write landed.
    writeCommandIntent(paths, intent);
    const second = await reconciler.pass();
    expect(second.steering[0]?.recognised.map((entry) => entry.kind)).toStrictEqual(['already-applied']);
    expect(second.steering[0]?.applied).toStrictEqual([]);

    const applied = readEventLog(paths.eventLog).filter(
      (event) => event.type === COMMAND_EVENT_TYPES.Applied,
    );
    expect(applied).toHaveLength(1);
    // Both copies were retired rather than deleted, so the evidence of both deliveries survives.
    expect(readdirSync(paths.commandsAppliedDir).length).toBe(2);
  });

  it('still applies an intent whose effect never reached the log, and applies it once', async () => {
    /**
     * The crash between consume and apply. The process reads an intent, dies before the effect is
     * durable, and the file is still there — because nothing deletes a file by reading it. The restart
     * finds no `command.applied` for the id, so it applies it, and only then retires the file.
     */
    const { reconciler } = openReconciler();
    const accepted = reconciler.acceptFeature(makePlan());
    const paths = runPaths(accepted.run, home);

    const intent = newCommandIntent({
      intentId: mintIntentId(mintRunId()),
      command: 'confirm_spec',
      run: accepted.run,
      feature: 'engine-reconciler',
      principal: { kind: 'timeout', id: 'spec-echo-default' },
      source: 'timeout',
    });
    writeCommandIntent(paths, intent);

    expect(appliedIntentIds(readEventLog(paths.eventLog)).size).toBe(0);
    expect(reconciler.load(accepted.run).state.state).toBe('drafting');

    await reconciler.pass();
    expect(reconciler.load(accepted.run).state.state).toBe('confirmed');
    expect(
      readEventLog(paths.eventLog).filter((event) => event.type === COMMAND_EVENT_TYPES.Applied),
    ).toHaveLength(1);

    for (let index = 0; index < 3; index += 1) await reconciler.pass();
    expect(
      readEventLog(paths.eventLog).filter((event) => event.type === COMMAND_EVENT_TYPES.Applied),
    ).toHaveLength(1);
  });

  it('records the principal with the effect, so an approval is attributable', () => {
    const { reconciler } = openReconciler();
    const accepted = reconciler.acceptFeature(makePlan());
    reconciler.confirm(accepted.run, {
      principal: { kind: 'agent', id: 'interviewer' },
      source: 'web',
    });

    const applied = readEventLog(runPaths(accepted.run, home).eventLog).find(
      (event) => event.type === COMMAND_EVENT_TYPES.Applied,
    );
    expect(applied?.payload['principal_kind']).toBe('agent');
    expect(applied?.payload['principal_id']).toBe('interviewer');
    expect(applied?.payload['source']).toBe('web');
  });
});

describe('the fold itself ignores an intent id it has already seen', () => {
  it('applies one effect for two identical command.applied lines', () => {
    /**
     * The second line of defence, tested at its own surface. `decideSteering` never appends a second
     * line for one id, so this asserts the *fold* rather than the caller: if a duplicate ever reached
     * the log — a redelivery applied by two builds, a file restored from a backup — the checkpoint must
     * still show one effect. The two lines below disagree on purpose, so a fold that took both would
     * show it by ending in the second one's state.
     */
    const line = (seq: number, toState: string): EventEnvelope => ({
      schema_version: CURRENT_SCHEMA_VERSION,
      ts: `2026-09-20T10:00:0${String(seq)}.000Z`,
      seq,
      feature: 'engine-reconciler',
      run: '01K5NQ9ZJ7V3M2P9XQWRTC4BDE',
      step: null,
      emitter: 'engine.reconciler',
      type: COMMAND_EVENT_TYPES.Applied,
      payload: {
        intent_id: 'cmd-once-only',
        command: 'confirm_spec',
        principal_kind: 'user',
        principal_id: 'deep',
        source: 'tui',
        effect: 'confirmed',
        reason: 'the user confirmed the acceptance criteria',
        to_state: toState,
      },
    });

    const folded = rebuildFromLog([line(1, 'confirmed'), line(2, 'killed')], {
      run: '01K5NQ9ZJ7V3M2P9XQWRTC4BDE',
      plan: makePlan(),
    });
    expect(folded.state).toBe('confirmed');
  });
});

describe('an intent for a run with no state is quarantined, not met by every pass', () => {
  it('quarantines it and leaves the incomplete run directory alone', async () => {
    const { reconciler } = openReconciler();
    const live = reconciler.acceptFeature(makePlan());
    reconciler.confirm(live.run);

    // What a crash between creating the directory and recording `run.created` leaves — plus an intent
    // somebody wrote against it.
    const orphan = '01K5NQ9ZJ7V3M2P9XQWRTC4BDE';
    const orphanPaths = runPaths(orphan, home);
    mkdirSync(orphanPaths.runDir, { recursive: true });
    writeCommandIntent(orphanPaths, anIntent({ run: orphan, command: 'kill' }));

    const result = await reconciler.pass();
    expect(result.refusals).toStrictEqual([]);
    const orphanSteering = result.steering.find((entry) => entry.run === orphan);
    expect(orphanSteering?.refused[0]?.reason).toBe('unknown-run');
    expect(readIntentFiles(orphanPaths).pending).toStrictEqual([]);
    // No log was created for it: opening a recorder would have repaired a directory AD-4 forbids repairing.
    expect(existsSync(orphanPaths.eventLog)).toBe(false);

    // And the live run advanced in the same pass.
    expect(result.actions.some((action) => action.run === live.run)).toBe(true);
  });
});

describe('the transport needs no server: the file path alone works', () => {
  it('drives a run from drafting to committed with nothing but files written into commands/', async () => {
    const { reconciler } = openReconciler();
    const accepted = reconciler.acceptFeature(makePlan());
    const paths = runPaths(accepted.run, home);

    writeCommandIntent(
      paths,
      newCommandIntent({
        intentId: mintIntentId(mintRunId()),
        command: 'confirm_spec',
        run: accepted.run,
        feature: 'engine-reconciler',
        principal: { kind: 'user', id: 'deep' },
        // A renderer, with no engine method called and no server running.
        source: 'tui',
      }),
    );

    let passes = 0;
    while (reconciler.load(accepted.run).state.state !== 'committed' && passes < 10) {
      await reconciler.pass();
      passes += 1;
    }
    expect(reconciler.load(accepted.run).state.state).toBe('committed');
  });
});

describe('retiring an intent', () => {
  it('moves it into commands/applied/ and gives it a fresh name rather than overwriting', () => {
    const run = '01K5NQ9ZJ7V3M2P9XQWRTC4BDE';
    const paths = runPaths(run, home);
    const intent = anIntent({ run });

    writeCommandIntent(paths, intent);
    const firstPending = readIntentFiles(paths).pending[0];
    expect(firstPending).toBeDefined();
    if (firstPending === undefined) return;
    retireIntent(paths, firstPending);

    writeCommandIntent(paths, intent);
    const secondPending = readIntentFiles(paths).pending[0];
    expect(secondPending).toBeDefined();
    if (secondPending === undefined) return;
    retireIntent(paths, secondPending);

    expect(readdirSync(paths.commandsAppliedDir).length).toBe(2);
    expect(readIntentFiles(paths).pending).toStrictEqual([]);
  });
});

describe('the intent contract is the one the registry declares', () => {
  it('carries the current schema version and an RFC3339 issue time', () => {
    const intent = anIntent();
    expect(intent.schema_version).toBe(CURRENT_SCHEMA_VERSION);
    expect(intent.issued_at).toBe(formatTimestamp(new Date(intent.issued_at)));
  });
});
