/**
 * Story 5-3 — the queryable index over `decision.recorded` lines.
 *
 * `buildDecisionIndex`'s own I/O matrix is driven against hand-built ledger runs, in
 * `tests/engine.consolidation.test.ts`'s own style: a run directory on disk holding exactly the AD-5
 * envelopes a real reconciler would have appended. `queryDecisionIndex`'s matching semantics are then
 * checked directly, and — the acceptance criterion this story is built around — against the live linear
 * fold `attemptDeflection` still performs (`matchDecisionLedger`, `src/engine/deflection.ts`), so the two
 * paths are shown to agree rather than merely asserted to.
 *
 * Each decision below is minted its own question id (`aDecision`'s default), unlike
 * `tests/engine.deflection.test.ts`'s own fixture, which happily reuses one hardcoded id across several
 * `aDecision()` calls because `matchDecisionLedger` never looks at it. This index does: its idempotence
 * key *is* the question id, so two genuinely distinct decisions sharing one by fixture accident would
 * collapse into one entry here while the linear fold still saw both — a divergence this suite exists to
 * rule out, not reproduce.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as decisionModule from '../src/engine/decision.js';
import {
  attemptDeflection,
  buildDecisionIndex,
  mintRunId,
  namesAnchor,
  queryDecisionIndex,
  readDecisionIndex,
} from '../src/engine/index.js';
import type { DecisionIndexEntry, DeflectionContext, QuestionAnchor } from '../src/engine/index.js';
import { decisionIndexPath, runPaths } from '../src/runtime/index.js';

import { makeHome } from './helpers/engine-fixture.js';

let home: string;
let idCounter: number;
const toRemove: string[] = [];

beforeEach(() => {
  home = makeHome('engine-decision-index');
  toRemove.push(home);
  idCounter = 0;
});

afterEach(() => {
  for (const dir of toRemove.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const PROJECT_ID = 'project-under-test';

const SCHEMA_EXTRAS: QuestionAnchor = { symbol: 'StepOutputSchema', aspect: 'unknown fields' };

/** One `decision.recorded` payload, in `decision.ts`'s shape, minting its own question id by default. */
const aDecision = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  question_id: `q-fixture-${String(idCounter++)}`,
  question: 'Should StepOutputSchema reject unknown fields?',
  answer: 'reject them',
  option_id: null,
  resolver: 'tui',
  principal_kind: 'user',
  principal_id: 'deep',
  resolved_at: '2026-09-20T10:00:00.000Z',
  ...overrides,
});

/** A run whose log is exactly these decision lines, each a whole AD-5 envelope. */
const runWithLedger = (decisions: readonly Record<string, unknown>[]): string => {
  const run = mintRunId();
  const paths = runPaths(run, home);
  mkdirSync(paths.runDir, { recursive: true });
  const lines = decisions.map((payload, index) =>
    JSON.stringify({
      ts: '2026-09-23T10:00:00.000Z',
      seq: index + 1,
      feature: 'engine-reconciler',
      run,
      step: null,
      emitter: 'engine',
      type: 'decision.recorded',
      payload,
    }),
  );
  writeFileSync(paths.eventLog, `${lines.join('\n')}\n`, 'utf8');
  return run;
};

const context = (overrides: Partial<DeflectionContext> = {}): DeflectionContext => ({
  repository: null,
  orchHome: home,
  ledgerRuns: [],
  ...overrides,
});

const readStoreLines = (): readonly string[] =>
  readFileSync(decisionIndexPath(PROJECT_ID, home), 'utf8')
    .split('\n')
    .filter((line) => line !== '');

describe('buildDecisionIndex — the I/O matrix', () => {
  it('indexes one entry for a run with one decision.recorded line', () => {
    const payload = aDecision({ question_id: 'q-one' });
    const run = runWithLedger([payload]);

    const entries = buildDecisionIndex([run], PROJECT_ID, { orchHome: home });

    expect(entries).toStrictEqual([{ questionId: 'q-one', run, payload }]);
    expect(readStoreLines().map((line) => JSON.parse(line) as DecisionIndexEntry)).toStrictEqual(entries);
  });

  it('re-indexing the same run twice produces no duplicate entry', () => {
    const payload = aDecision({ question_id: 'q-one' });
    const run = runWithLedger([payload]);

    const first = buildDecisionIndex([run], PROJECT_ID, { orchHome: home });
    const second = buildDecisionIndex([run], PROJECT_ID, { orchHome: home });

    expect(second).toStrictEqual(first);
    expect(second).toHaveLength(1);
    expect(readStoreLines()).toHaveLength(1);
  });

  it('deduplicates a run id repeated within a single runIds array', () => {
    const payload = aDecision({ question_id: 'q-one' });
    const run = runWithLedger([payload]);

    const entries = buildDecisionIndex([run, run], PROJECT_ID, { orchHome: home });

    expect(entries).toStrictEqual([{ questionId: 'q-one', run, payload }]);
    expect(readStoreLines()).toHaveLength(1);
  });

  it('running over an overlapping run-id set never duplicates an entry', () => {
    const payloadA = aDecision({ question_id: 'q-a' });
    const runA = runWithLedger([payloadA]);
    const first = buildDecisionIndex([runA], PROJECT_ID, { orchHome: home });
    expect(first).toHaveLength(1);

    const payloadB = aDecision({ question_id: 'q-b' });
    const runB = runWithLedger([payloadB]);
    const second = buildDecisionIndex([runA, runB], PROJECT_ID, { orchHome: home });

    expect(second.map((entry) => entry.questionId).sort()).toStrictEqual(['q-a', 'q-b']);
    expect(readStoreLines()).toHaveLength(2);
  });

  it('a multi-decision run interrupted between indexing passes still gets the missing decision on a later one', () => {
    const first = aDecision({ question_id: 'q-first' });
    const second = aDecision({ question_id: 'q-second' });
    const run = runWithLedger([first, second]);

    // Simulate a first pass that only reached one of the two decisions by hand-writing the store.
    mkdirSync(join(home, 'projects', PROJECT_ID, 'memory'), { recursive: true });
    writeFileSync(
      decisionIndexPath(PROJECT_ID, home),
      `${JSON.stringify({ questionId: 'q-first', run, payload: first })}\n`,
      'utf8',
    );

    const entries = buildDecisionIndex([run], PROJECT_ID, { orchHome: home });
    expect(entries.map((entry) => entry.questionId).sort()).toStrictEqual(['q-first', 'q-second']);
    expect(readStoreLines()).toHaveLength(2);
  });

  it('one ledger run’s unreadable log contributes nothing; the others still index', () => {
    const payload = aDecision({ question_id: 'q-good' });
    const good = runWithLedger([payload]);
    const corrupt = mintRunId();
    mkdirSync(runPaths(corrupt, home).runDir, { recursive: true });
    writeFileSync(runPaths(corrupt, home).eventLog, 'this is not json\n', 'utf8');

    const entries = buildDecisionIndex([corrupt, good], PROJECT_ID, { orchHome: home });

    expect(entries).toStrictEqual([{ questionId: 'q-good', run: good, payload }]);
  });

  it('an absent run and an unsafe run id are skipped like an unreadable one', () => {
    const payload = aDecision({ question_id: 'q-good' });
    const good = runWithLedger([payload]);
    const absent = mintRunId();

    const entries = buildDecisionIndex([absent, '../escape', good], PROJECT_ID, { orchHome: home });

    expect(entries).toStrictEqual([{ questionId: 'q-good', run: good, payload }]);
  });

  it('a decision line with no usable question id is not indexed', () => {
    const blank = aDecision({ question_id: '' });
    const missing = { ...aDecision(), question_id: undefined };
    const good = aDecision({ question_id: 'q-good' });
    const run = runWithLedger([blank, missing, good]);

    const entries = buildDecisionIndex([run], PROJECT_ID, { orchHome: home });

    expect(entries.map((entry) => entry.questionId)).toStrictEqual(['q-good']);
  });

  it('rebuilds identical content after the store is deleted — a derived projection, per AD-4', () => {
    const payload = aDecision({ question_id: 'q-replay' });
    const run = runWithLedger([payload]);
    const first = buildDecisionIndex([run], PROJECT_ID, { orchHome: home });

    rmSync(decisionIndexPath(PROJECT_ID, home));
    const rebuilt = buildDecisionIndex([run], PROJECT_ID, { orchHome: home });

    expect(rebuilt).toStrictEqual(first);
  });

  it('a run whose read fails with something other than an unreadable-log error is not silently skipped', () => {
    const run = runWithLedger([aDecision()]);
    const spy = vi.spyOn(decisionModule, 'decisionsInLog').mockImplementation(() => {
      throw new TypeError('a shape decisionsInLog was not built to expect');
    });
    try {
      expect(() => buildDecisionIndex([run], PROJECT_ID, { orchHome: home })).toThrow(TypeError);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('readDecisionIndex — the exported, read-only reader (story 5-3)', () => {
  it('skips a store line whose payload is an array, like other corrupt lines', () => {
    const storePath = decisionIndexPath(PROJECT_ID, home);
    mkdirSync(join(home, 'projects', PROJECT_ID, 'memory'), { recursive: true });
    const good: DecisionIndexEntry = { questionId: 'q-good', run: 'run-a', payload: { question: 'x', answer: 'y' } };
    const badArrayPayload = { questionId: 'q-bad', run: 'run-b', payload: [] };
    writeFileSync(storePath, `${JSON.stringify(good)}\n${JSON.stringify(badArrayPayload)}\n`, 'utf8');

    expect(readDecisionIndex(storePath)).toStrictEqual([good]);
  });

  it('reads the store back without indexing new runs, unlike buildDecisionIndex', () => {
    const payload = aDecision({ question_id: 'q-one' });
    const run = runWithLedger([payload]);
    buildDecisionIndex([run], PROJECT_ID, { orchHome: home });

    expect(readDecisionIndex(decisionIndexPath(PROJECT_ID, home))).toStrictEqual([
      { questionId: 'q-one', run, payload },
    ]);
  });
});

describe('queryDecisionIndex — matchDecisionLedger’s semantics over indexed entries', () => {
  it('returns the newer decision when two name the same anchor from different runs', () => {
    const older = aDecision({ answer: 'reject them', resolved_at: '2026-09-20T10:00:00.000Z' });
    const newer = aDecision({ answer: 'allow them', resolved_at: '2026-09-22T10:00:00.000Z' });
    const runOlder = runWithLedger([older]);
    const runNewer = runWithLedger([newer]);

    const entries = buildDecisionIndex([runOlder, runNewer], PROJECT_ID, { orchHome: home });
    const match = queryDecisionIndex(entries, SCHEMA_EXTRAS);

    expect(match?.source).toBe('decision_ledger');
    expect(match?.run).toBe(runNewer);
    expect(match?.answer).toBe('allow them');
  });

  it('breaks a resolved_at tie by the entries’ own order, favouring the later one', () => {
    const first = aDecision({ answer: 'first answer', resolved_at: '2026-09-20T10:00:00.000Z' });
    const second = aDecision({ answer: 'second answer', resolved_at: '2026-09-20T10:00:00.000Z' });
    const entries: DecisionIndexEntry[] = [
      { questionId: 'q-first', run: 'run-a', payload: first },
      { questionId: 'q-second', run: 'run-b', payload: second },
    ];

    expect(queryDecisionIndex(entries, SCHEMA_EXTRAS)?.answer).toBe('second answer');
  });

  it('reports no match when the newest decision’s answer was redacted, never falling back', () => {
    const older = aDecision({ answer: 'reject them', resolved_at: '2026-09-20T10:00:00.000Z' });
    const newer = aDecision({ answer: '[redacted]', redacted_fields: 'answer', resolved_at: '2026-09-22T10:00:00.000Z' });
    const run = runWithLedger([older, newer]);

    const entries = buildDecisionIndex([run], PROJECT_ID, { orchHome: home });

    expect(queryDecisionIndex(entries, SCHEMA_EXTRAS)).toBeNull();
  });

  it('reports no match when the newest decision recorded a blank answer', () => {
    const older = aDecision({ answer: 'reject them', resolved_at: '2026-09-20T10:00:00.000Z' });
    const newer = aDecision({ answer: '   ', resolved_at: '2026-09-22T10:00:00.000Z' });
    const run = runWithLedger([older, newer]);

    const entries = buildDecisionIndex([run], PROJECT_ID, { orchHome: home });

    expect(queryDecisionIndex(entries, SCHEMA_EXTRAS)).toBeNull();
  });

  it('still uses an older real decision when only a newer timeout followed it', () => {
    const older = aDecision({ answer: 'reject them', resolved_at: '2026-09-20T10:00:00.000Z' });
    const newer = aDecision({
      resolver: 'timeout_default',
      principal_kind: 'timeout',
      answer: 'allow them',
      resolved_at: '2026-09-22T10:00:00.000Z',
    });
    const run = runWithLedger([older, newer]);

    const entries = buildDecisionIndex([run], PROJECT_ID, { orchHome: home });

    expect(queryDecisionIndex(entries, SCHEMA_EXTRAS)?.answer).toBe('reject them');
  });

  it('returns no match when no indexed decision names the anchor', () => {
    const payload = aDecision({ question: 'Is widgetCache per process?', answer: 'yes' });
    const run = runWithLedger([payload]);

    const entries = buildDecisionIndex([run], PROJECT_ID, { orchHome: home });

    expect(queryDecisionIndex(entries, SCHEMA_EXTRAS)).toBeNull();
  });

  it('refuses an unusable anchor before comparing anything', () => {
    const payload = aDecision();
    const run = runWithLedger([payload]);

    const entries = buildDecisionIndex([run], PROJECT_ID, { orchHome: home });

    expect(queryDecisionIndex(entries, { symbol: 'StepOutputSchema', aspect: '' })).toBeNull();
  });
});

describe('queryDecisionIndex agrees with matchDecisionLedger’s live linear fold', () => {
  /** Build the index from `ledgerRuns` and assert the two paths report the same verdict for `anchor`. */
  const agree = (ledgerRuns: readonly string[], anchor: QuestionAnchor): void => {
    const viaFold = attemptDeflection(anchor, context({ ledgerRuns }));
    const entries = buildDecisionIndex(ledgerRuns, PROJECT_ID, { orchHome: home });
    const viaIndex = queryDecisionIndex(entries, anchor);

    if (viaFold.match === null) {
      expect(viaIndex).toBeNull();
      return;
    }
    expect(viaIndex).not.toBeNull();
    expect(viaIndex?.run).toBe(viaFold.match.run);
    // matchDecisionLedger's answer wraps the raw answer with "decided in run … (question …): "; the
    // index's own answer is the raw text underneath that wrapping.
    expect(viaFold.match.answer.endsWith(`: ${viaIndex?.answer ?? ''}`)).toBe(true);
  };

  it('agrees on a straightforward match', () => {
    const run = runWithLedger([aDecision()]);
    agree([run], SCHEMA_EXTRAS);
  });

  it('agrees on newest-wins across two runs', () => {
    const older = runWithLedger([aDecision({ answer: 'reject them', resolved_at: '2026-09-20T10:00:00.000Z' })]);
    const newer = runWithLedger([aDecision({ answer: 'allow them', resolved_at: '2026-09-22T10:00:00.000Z' })]);
    agree([older, newer], SCHEMA_EXTRAS);
  });

  it('agrees that a redacted newest answer yields no match, without falling back', () => {
    const run = runWithLedger([
      aDecision({ answer: 'reject them', resolved_at: '2026-09-20T10:00:00.000Z' }),
      aDecision({ answer: '[redacted]', redacted_fields: 'answer', resolved_at: '2026-09-22T10:00:00.000Z' }),
    ]);
    agree([run], SCHEMA_EXTRAS);
  });

  it('agrees that a blank newest answer yields no match', () => {
    const run = runWithLedger([
      aDecision({ answer: 'reject them', resolved_at: '2026-09-20T10:00:00.000Z' }),
      aDecision({ answer: '   ', resolved_at: '2026-09-22T10:00:00.000Z' }),
    ]);
    agree([run], SCHEMA_EXTRAS);
  });

  it('agrees that a timeout_default newest is not a decision, and an older real one still is', () => {
    const run = runWithLedger([
      aDecision({ answer: 'reject them', resolved_at: '2026-09-20T10:00:00.000Z' }),
      aDecision({
        resolver: 'timeout_default',
        principal_kind: 'timeout',
        answer: 'allow them',
        resolved_at: '2026-09-22T10:00:00.000Z',
      }),
    ]);
    agree([run], SCHEMA_EXTRAS);
  });

  it('agrees when nothing names the anchor', () => {
    const run = runWithLedger([aDecision({ question: 'Is widgetCache per process?', answer: 'yes' })]);
    agree([run], SCHEMA_EXTRAS);
  });

  it('agrees when the anchor is unusable', () => {
    const run = runWithLedger([aDecision()]);
    agree([run], { symbol: 'StepOutputSchema', aspect: '' });
  });

  it('agrees when every ledger run is unreadable', () => {
    const corrupt = mintRunId();
    mkdirSync(runPaths(corrupt, home).runDir, { recursive: true });
    writeFileSync(runPaths(corrupt, home).eventLog, '{"torn":', 'utf8');
    agree([corrupt], SCHEMA_EXTRAS);
  });

  it('agrees when there are no ledger runs at all', () => {
    agree([], SCHEMA_EXTRAS);
  });

  it(
    'agrees on a resolved_at tie between two decisions, when built and queried in the same run order ' +
      '(the tie-break both paths share is caller-order-dependent; this is the one order it is proven under)',
    () => {
      const run = runWithLedger([
        aDecision({ answer: 'first answer', resolved_at: '2026-09-20T10:00:00.000Z' }),
        aDecision({ answer: 'second answer', resolved_at: '2026-09-20T10:00:00.000Z' }),
      ]);
      agree([run], SCHEMA_EXTRAS);
    },
  );

  it('agrees that a decision about a longer symbol sharing a prefix does not match (whole-token, not substring)', () => {
    // Mirrors tests/engine.deflection.test.ts's "does not deflect from a decision about a longer symbol
    // with the same prefix" (matrix 7's boundary case), for the decision_ledger source specifically.
    const run = runWithLedger([
      aDecision({ question: 'Should StepOutputSchemaV2 reject unknown fields?', answer: 'reject them' }),
    ]);
    agree([run], SCHEMA_EXTRAS);
  });

  it('agrees that a decision about a different aspect of the same symbol does not match (two questions, not one)', () => {
    // Mirrors tests/engine.deflection.test.ts's "does not deflect from a decision about the same symbol
    // and a different aspect" (matrix 18), for the decision_ledger source specifically.
    const run = runWithLedger([aDecision({ question: 'Should StepOutputSchema be versioned?', answer: 'yes' })]);
    agree([run], SCHEMA_EXTRAS);
  });
});

describe('decisionIndexPath — the documented on-disk layout, independent of the writer', () => {
  it('resolves to projects/<project-id>/memory/decisions.jsonl under ORCH_HOME', () => {
    expect(decisionIndexPath(PROJECT_ID, home)).toBe(
      join(home, 'projects', PROJECT_ID, 'memory', 'decisions.jsonl'),
    );
  });
});

describe('namesAnchor — exported for reuse (story 5-3), behaviour unchanged', () => {
  it('names both parts as whole tokens, exactly as the live deflection matcher requires', () => {
    expect(namesAnchor('Should resolveProject throw on a miss?', { symbol: 'resolveProject', aspect: 'miss' })).toBe(
      true,
    );
    expect(namesAnchor('Should resolveProject throw on a hit?', { symbol: 'resolveProject', aspect: 'miss' })).toBe(
      false,
    );
  });
});
