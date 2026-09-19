/**
 * AD-29 / AD-4 / AD-5 — the properties the stage-1 gate rests on.
 *
 * `seq` monotonicity across producers, rejection of a malformed envelope, passthrough of an unknown
 * type, the single-writer refusal, and that an interrupted append leaves only whole lines. The last
 * is asserted by killing a real writing process, because a torn trailing line is permanent
 * corruption of the durable truth and no in-process assertion can stand for it.
 */
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir, hostname, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  EVENT_ENVELOPE_REQUIRED_FIELDS,
  EVENT_TYPES,
  ERROR_CODES,
  compareEventOrder,
  dispositionFor,
  formatTimestamp,
  isDeclaredEventType,
  isErrorCode,
} from '../src/contracts/index.js';
import {
  EventEnvelopeRejected,
  EventLogCorruptError,
  FIRST_SEQ,
  REDACTION_FAILED_ERROR_CODE,
  REDACTION_FAILED_EVENT_TYPE,
  Recorder,
  UnsafePathSegmentError,
  WriterConflictError,
  isWholeLineTerminated,
  readEventLog,
  resolveOrchHome,
  runPaths,
} from '../src/runtime/index.js';
import type { EventSubmission } from '../src/runtime/index.js';

const RUN_ID = '01JBQZ8Q0000000000000000AA';
const FEATURE = 'runtime-recorder';

let home: string;
let open: Recorder[] = [];

const recorderFor = (runId: string = RUN_ID, now?: () => Date): Recorder => {
  const recorder = Recorder.open({
    runId,
    feature: FEATURE,
    orchHome: home,
    fsync: false,
    ...(now === undefined ? {} : { now }),
  });
  open.push(recorder);
  return recorder;
};

const submission = (overrides: Partial<EventSubmission> = {}): EventSubmission => ({
  feature: FEATURE,
  run: RUN_ID,
  step: 'implementation',
  emitter: 'engine',
  type: 'step.started',
  payload: { step: 'implementation' },
  ...overrides,
});

const logPathFor = (runId: string = RUN_ID): string => runPaths(runId, home).eventLog;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'orch-recorder-'));
  open = [];
});

afterEach(() => {
  for (const recorder of open) recorder.close();
  rmSync(home, { recursive: true, force: true });
});

describe('AD-9 — one place owns the run layout', () => {
  it('defaults ORCH_HOME to ~/.orch and honours the environment variable', () => {
    expect(resolveOrchHome({})).toBe(join(homedir(), '.orch'));
    expect(resolveOrchHome({ ORCH_HOME: '  ' })).toBe(join(homedir(), '.orch'));
    expect(resolveOrchHome({ ORCH_HOME: '/tmp/somewhere' })).toBe('/tmp/somewhere');
    // A relative value is resolved, so every consumer sees one absolute path for one configured home.
    expect(resolveOrchHome({ ORCH_HOME: 'relative/orch' })).toBe(resolve('relative/orch'));
  });

  it('places a run at runs/<run-id>/ with the two files this story owns', () => {
    const paths = runPaths(RUN_ID, '/orch');
    expect(paths.runDir).toBe(join('/orch', 'runs', RUN_ID));
    expect(paths.eventLog).toBe(join('/orch', 'runs', RUN_ID, 'events.jsonl'));
    expect(paths.fetchRecord).toBe(join('/orch', 'runs', RUN_ID, 'fetch-record.json'));
    expect(paths.configDir).toBe(join('/orch', 'runs', RUN_ID, 'config'));
  });

  it.each(['..', '.', '../../etc', 'a/b', '', '-dash'])(
    'refuses %o as a run id rather than resolving it',
    (segment) => {
      expect(() => runPaths(segment, '/orch')).toThrowError(UnsafePathSegmentError);
    },
  );
});

describe('AD-29 — the recorder is the sole assigner of seq', () => {
  it('assigns seq 1 to the first append of a fresh run', () => {
    const recorder = recorderFor();
    expect(recorder.seqOfNextAppend).toBe(FIRST_SEQ);
    const event = recorder.record(submission());
    expect(event.seq).toBe(1);
    expect(readEventLog(logPathFor())).toHaveLength(1);
  });

  it('numbers n appends from several producers exactly 1..n in submission order', () => {
    const recorder = recorderFor();
    const emitters = ['engine', 'step.subprocess', 'tool.github', 'tui', 'mcp.linear'];
    const submitted = Array.from({ length: 50 }, (_unused, index) =>
      recorder.record(
        submission({
          emitter: emitters[index % emitters.length] ?? 'engine',
          payload: { index },
        }),
      ),
    );

    const events = readEventLog(logPathFor());
    expect(events.map((event) => event.seq)).toStrictEqual(
      Array.from({ length: 50 }, (_unused, index) => index + 1),
    );
    expect(new Set(events.map((event) => event.seq)).size).toBe(events.length);
    // No assigned seq is ever zero or negative, so compareEventOrder is never asked about one.
    expect(events.every((event) => event.seq >= FIRST_SEQ)).toBe(true);
    expect(events.map((event) => event.payload['index'])).toStrictEqual(
      submitted.map((event) => event.payload['index']),
    );
    expect(events.map((event) => event.emitter)).toStrictEqual(
      submitted.map((event) => event.emitter),
    );
  });

  it('continues without a gap when the same run is recorded again later', () => {
    const first = recorderFor();
    first.record(submission());
    first.record(submission());
    first.close();

    const second = recorderFor();
    expect(second.seqOfNextAppend).toBe(3);
    expect(second.record(submission()).seq).toBe(3);
    expect(readEventLog(logPathFor()).map((event) => event.seq)).toStrictEqual([1, 2, 3]);
  });

  it('refuses a submitted seq — assignment is the recorder`s alone', () => {
    const recorder = recorderFor();
    expect(() => recorder.record({ ...submission(), seq: 99 })).toThrowError(
      /seq is assigned by the recorder alone/,
    );
    expect(readEventLog(logPathFor())).toHaveLength(0);
  });

  it('never appends a line whose seq already appears in the file', () => {
    const recorder = recorderFor();
    for (let index = 0; index < 20; index += 1) recorder.record(submission());
    const seqs = readEventLog(logPathFor()).map((event) => event.seq);
    expect(new Set(seqs).size).toBe(seqs.length);
    // A tie is therefore unreachable rather than merely untested: compareEventOrder is never
    // asked to order two lines of one file with equal seq.
    expect(seqs.every((seq, index) => index === 0 || seq > (seqs[index - 1] ?? 0))).toBe(true);
  });

  it.each([
    ['repeats a seq', [1, 1]],
    ['leaves a gap', [1, 3]],
    ['starts below the first seq', [0, 1]],
    ['counts backwards', [2, 1]],
  ])('refuses to reopen a log whose seq %s, rather than continuing from it', (_name, seqs) => {
    const recorder = recorderFor();
    const template = recorder.record(submission());
    recorder.close();
    writeFileSync(
      logPathFor(),
      seqs.map((seq) => `${JSON.stringify({ ...template, seq })}\n`).join(''),
      'utf8',
    );

    let caught: unknown;
    try {
      recorderFor();
    } catch (thrown: unknown) {
      caught = thrown;
    }
    expect(caught).toBeInstanceOf(EventLogCorruptError);
    // The offending line is named, so the corruption can be found without reading the whole file.
    expect((caught as EventLogCorruptError).line).toBeGreaterThan(0);
  });
});

describe('AD-4 — a log that is not whole is refused, never silently tolerated', () => {
  /**
   * A reader that drops a torn trailing line lets the next append fuse onto it, turning recoverable
   * corruption into permanent corruption of the durable truth. Both the reader and the claim refuse.
   */
  const corruptions: [string, (line: string) => string, number][] = [
    ['a torn trailing line', (line) => `${line}\n${line.slice(0, 40)}`, 2],
    ['a line that is not whole JSON', (line) => `${line}\n{"ts":"2026-09-1\n`, 2],
    [
      'a line that is valid JSON but not an envelope',
      (line) => `${line}\n${JSON.stringify({ ts: '2026-09-19T12:00:00.000Z', seq: 2 })}\n`,
      2,
    ],
  ];

  it.each(corruptions)('refuses %s, naming the line', (_name, corrupt, line) => {
    const recorder = recorderFor();
    const first = JSON.stringify(recorder.record(submission()));
    recorder.close();
    writeFileSync(logPathFor(), corrupt(first), 'utf8');

    for (const act of [(): unknown => readEventLog(logPathFor()), (): unknown => recorderFor()]) {
      let caught: unknown;
      try {
        act();
      } catch (thrown: unknown) {
        caught = thrown;
      }
      expect(caught).toBeInstanceOf(EventLogCorruptError);
      expect((caught as EventLogCorruptError).line).toBe(line);
      expect((caught as Error).message).toContain(String(line));
    }
  });
});

describe('AD-29 — seq is the only ordering authority', () => {
  it('orders by seq even when ts disagrees', () => {
    // A clock that runs backwards: the second event carries the earlier timestamp.
    const stamps = ['2026-09-19T12:00:02.000Z', '2026-09-19T12:00:01.000Z'];
    let at = 0;
    const recorder = recorderFor(RUN_ID, () => new Date(stamps[at++] ?? stamps[0] ?? ''));
    recorder.record(submission({ payload: { order: 'first' } }));
    recorder.record(submission({ payload: { order: 'second' } }));

    const events = readEventLog(logPathFor());
    expect(events.map((event) => event.ts)).toStrictEqual(stamps);
    expect(events.map((event) => event.seq)).toStrictEqual([1, 2]);

    const byTimestamp = [...events].sort((a, b) => a.ts.localeCompare(b.ts));
    const bySeq = [...events].sort(compareEventOrder);
    expect(bySeq.map((event) => event.payload['order'])).toStrictEqual(['first', 'second']);
    expect(byTimestamp.map((event) => event.payload['order'])).toStrictEqual(['second', 'first']);
  });

  it('stamps ts itself when a producer keeps no clock, in the one accepted format', () => {
    const recorder = recorderFor();
    const event = recorder.record(submission());
    expect(event.ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });
});

describe('AD-5 — the envelope is validated, the vocabulary is not', () => {
  /**
   * `ts` and `seq` are the two declared fields a producer may omit: `seq` is the recorder's to
   * assign (AD-29) and a producer that keeps no clock should not invent a timestamp. Every other
   * declared field is a rejection when absent.
   */
  const PRODUCER_SUPPLIED_FIELDS = EVENT_ENVELOPE_REQUIRED_FIELDS.filter(
    (field) => field !== 'ts' && field !== 'seq',
  );

  it('fills the two fields a producer may omit rather than rejecting them', () => {
    const recorder = recorderFor();
    const { ts: _noTs, ...withoutTs } = submission();
    const event = recorder.record(withoutTs);
    expect(event.ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(event.seq).toBe(1);
  });

  it.each(PRODUCER_SUPPLIED_FIELDS)(
    'rejects an event missing %s, naming the field, and leaves the file unchanged',
    (field) => {
      const recorder = recorderFor();
      recorder.record(submission());
      const before = readFileSync(logPathFor(), 'utf8');

      const incomplete: Record<string, unknown> = { ...submission() };
      delete incomplete[field];
      let caught: unknown;
      try {
        recorder.record(incomplete);
      } catch (thrown: unknown) {
        caught = thrown;
      }
      expect(caught).toBeInstanceOf(EventEnvelopeRejected);
      expect((caught as EventEnvelopeRejected).fields).toContain(field);
      expect((caught as Error).message).toContain(field);
      expect(readFileSync(logPathFor(), 'utf8')).toBe(before);
    },
  );

  it.each([
    ['2026-09-19T12:34:56Z', 'no milliseconds'],
    ['2026-09-19T12:34:56.789+02:00', 'an offset rather than UTC'],
    ['19/09/2026 12:34:56.789', 'not RFC3339 at all'],
  ])('rejects ts %s (%s) before any write', (ts) => {
    const recorder = recorderFor();
    expect(() => recorder.record(submission({ ts }))).toThrowError(EventEnvelopeRejected);
    expect(existsSync(logPathFor()) ? readFileSync(logPathFor(), 'utf8') : '').toBe('');
  });

  it.each([
    ['run', 'SOME-OTHER-RUN'],
    ['feature', 'some-other-feature'],
  ])('rejects a submission naming a foreign %s, and leaves the file unchanged', (field, value) => {
    const recorder = recorderFor();
    recorder.record(submission());
    const before = readFileSync(logPathFor(), 'utf8');

    let caught: unknown;
    try {
      recorder.record({ ...submission(), [field]: value });
    } catch (thrown: unknown) {
      caught = thrown;
    }
    expect(caught).toBeInstanceOf(EventEnvelopeRejected);
    expect((caught as EventEnvelopeRejected).fields).toContain(field);
    expect((caught as Error).message).toContain(value);
    expect(readFileSync(logPathFor(), 'utf8')).toBe(before);
  });

  it('rejects a submission that is not a JSON object', () => {
    const recorder = recorderFor();
    for (const bad of ['a string', 42, null, ['an', 'array']]) {
      expect(() => recorder.record(bad)).toThrowError(EventEnvelopeRejected);
    }
  });

  it('appends an event whose type is outside the vocabulary, and reads it back unchanged', () => {
    const recorder = recorderFor();
    const submitted = submission({
      type: 'consolidation.compacted',
      payload: { lines: 12, nested: { kept: true } },
    });
    const written = recorder.record(submitted);
    const [read] = readEventLog(logPathFor());

    expect(read).toStrictEqual(written);
    expect(read?.type).toBe('consolidation.compacted');
    expect(read?.payload).toStrictEqual(submitted.payload);
    // A field the envelope does not declare survives too: adding one is never breaking.
    const extended = recorder.record({ ...submission(), parent_tool_use_id: 'toolu_01', extra: 7 });
    expect((extended as unknown as Record<string, unknown>)['extra']).toBe(7);
    expect(extended.parent_tool_use_id).toBe('toolu_01');
  });
});

describe('AD-5 — the stream-origin fields are preserved verbatim', () => {
  it('keeps parent_tool_use_id and session_id byte for byte, identifiers though they look random', () => {
    const recorder = recorderFor();
    const toolUseId = 'toolu_01A09q90qw90lq917835lq9';
    const sessionId = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';
    const event = recorder.record(
      submission({
        emitter: 'step.subprocess',
        type: 'agent.tool_used',
        parent_tool_use_id: toolUseId,
        session_id: sessionId,
        payload: { tool: 'Read', tool_use_id: toolUseId },
      }),
    );
    expect(event.parent_tool_use_id).toBe(toolUseId);
    expect(event.session_id).toBe(sessionId);
    // The same id inside the payload survives too, so stream events stay linkable.
    expect(event.payload['tool_use_id']).toBe(toolUseId);
    expect(readFileSync(logPathFor(), 'utf8')).toContain(toolUseId);
  });

  it('drops the artifact when a passthrough field carries a registered credential', () => {
    const secret = 'ProductionDomainToken-Aa0Bb1Cc2Dd3';
    const recorder = Recorder.open({
      runId: RUN_ID,
      feature: FEATURE,
      orchHome: home,
      fsync: false,
      redaction: { secrets: [{ name: 'the linear domain credential', value: secret }] },
    });
    open.push(recorder);
    const outcome = recorder.recordResult(submission({ session_id: secret }));
    expect(outcome.dropped).toBe(true);
    expect(outcome.event.type).toBe('redaction.failed');
    expect(outcome.event.payload['reason']).toBe('passthrough-carries-secret');
    expect(readFileSync(logPathFor(), 'utf8')).not.toContain(secret);
  });
});

describe('redaction.failed is an event type and an error code, and the two are not conflated', () => {
  it('emits the type, and reads the disposition from the AD-35 table rather than restating it', () => {
    const recorder = recorderFor();
    const cyclic: Record<string, unknown> = {};
    cyclic['self'] = cyclic;
    const event = recorder.recordResult(submission({ payload: cyclic })).event;

    // One name, two vocabularies: the type names a line, the code names a failure.
    expect(isDeclaredEventType(REDACTION_FAILED_EVENT_TYPE)).toBe(true);
    expect(isErrorCode(REDACTION_FAILED_ERROR_CODE)).toBe(true);
    expect(EVENT_TYPES).toContain(REDACTION_FAILED_EVENT_TYPE);
    expect(ERROR_CODES).toContain(REDACTION_FAILED_ERROR_CODE);

    expect(event.type).toBe(REDACTION_FAILED_EVENT_TYPE);
    expect(event.payload['disposition']).toBe(dispositionFor(REDACTION_FAILED_ERROR_CODE));
    // The line carries the event type, never a disposition masquerading as one, and the reason is
    // the redaction pass's own vocabulary rather than an error code.
    expect(isErrorCode(String(event.payload['reason']))).toBe(false);
    expect(event.emitter).toBe('runtime.recorder');
  });
});

describe('AD-4 — an appended line is never mutated', () => {
  it('only ever grows the file: the bytes already written are byte-identical afterwards', () => {
    const recorder = recorderFor();
    for (let index = 0; index < 5; index += 1) recorder.record(submission({ payload: { index } }));
    const after5 = readFileSync(logPathFor(), 'utf8');

    for (let index = 5; index < 12; index += 1) recorder.record(submission({ payload: { index } }));
    const after12 = readFileSync(logPathFor(), 'utf8');

    expect(after12.startsWith(after5)).toBe(true);
    expect(after12.slice(0, after5.length)).toBe(after5);
    expect(after12.length).toBeGreaterThan(after5.length);
    expect(isWholeLineTerminated(after12)).toBe(true);
  });

  it('offers no delete, compact, truncate or rewrite operation', () => {
    const recorder = recorderFor();
    const surface = [
      ...Object.getOwnPropertyNames(Object.getPrototypeOf(recorder) as object),
      ...Object.getOwnPropertyNames(Recorder),
    ];
    for (const forbidden of ['delete', 'compact', 'truncate', 'rewrite', 'prune', 'clear']) {
      expect(surface.some((name) => name.toLowerCase().includes(forbidden))).toBe(false);
    }
  });
});

describe('AD-21 — a registered credential never reaches the line', () => {
  it('replaces the literal value with a marker and leaves it nowhere in the file', () => {
    const secret = 'ProductionDomainToken-Aa0Bb1Cc2Dd3';
    const recorder = Recorder.open({
      runId: RUN_ID,
      feature: FEATURE,
      orchHome: home,
      fsync: false,
      redaction: { secrets: [{ name: 'the linear domain credential', value: secret }] },
    });
    open.push(recorder);
    const event = recorder.record(
      submission({ payload: { header: `Authorization: Bearer ${secret}` } }),
    );

    // The event is appended, not dropped: the marker replaces the value in place, and the rest of
    // the line is untouched. Asserting the type and the surviving text is what distinguishes a
    // redacted append from the last-gate replacement that a missing pass would fall back to.
    expect(event.type).toBe('step.started');
    expect(event.payload['header']).toBe('Authorization: Bearer [redacted]');
    expect(JSON.stringify(event)).not.toContain(secret);

    const [line, ...rest] = readEventLog(logPathFor());
    expect(rest).toHaveLength(0);
    expect(line).toStrictEqual(event);
    expect(readFileSync(logPathFor(), 'utf8')).not.toContain(secret);
  });

  it('redacts a secret class the last gate cannot know about, and still appends the event', () => {
    // No registered literal here: an `sk-ant-` token is caught by the pattern set alone, so this
    // asserts the pass itself ran rather than the serialisation gate catching a known value.
    const token = 'sk-ant-api03-Aa0Bb1Cc2Dd3Ee4Ff5Gg6Hh7Ii8Jj9Kk0Ll1Mm2';
    const recorder = recorderFor();
    const event = recorder.record(submission({ payload: { note: `used ${token} to authenticate` } }));

    expect(event.type).toBe('step.started');
    expect(event.payload['note']).toBe('used [redacted] to authenticate');
    expect(readFileSync(logPathFor(), 'utf8')).not.toContain('sk-ant-api03');
  });
});

describe('AD-21 — the last gate before an append', () => {
  it('replaces a line that carries a registered literal only in its serialised form, and says so', () => {
    /**
     * The literal spans JSON syntax, so no single string in the artifact contains it: the pass cannot
     * see it and only the pre-append gate over the serialised bytes can. Reached here through the AD-5
     * passthrough restore — `session_id` is put back verbatim after the pass has proven the redacted
     * copy, so the bytes that reach the gate are not the bytes that were proven.
     */
    const sessionId = 'qT7pLx2ZfNc4Wb9JmK1sVh6Ry3Dg8Eu5';
    const literal = `"session_id":"${sessionId}"`;
    const recorder = Recorder.open({
      runId: RUN_ID,
      feature: FEATURE,
      orchHome: home,
      fsync: false,
      redaction: { secrets: [{ name: 'a literal spanning JSON syntax', value: literal }] },
    });
    open.push(recorder);

    const outcome = recorder.recordResult(submission({ session_id: sessionId }));

    // The caller is told what actually landed, not what it asked for.
    expect(outcome.dropped).toBe(true);
    expect(outcome.event.type).toBe('redaction.failed');
    expect(outcome.event.payload['reason']).toBe('secret-survived-serialisation');

    const text = readFileSync(logPathFor(), 'utf8');
    expect(text).not.toContain(literal);
    expect(text).not.toContain(sessionId);
    // What was returned is what is on disk, byte for byte.
    expect(readEventLog(logPathFor())).toStrictEqual([outcome.event]);
  });

  it('drops the artifact when a passthrough field carries a pattern-recognised secret, not only a literal', () => {
    // No registered literal at all: the token is caught by the prefix class, and a field AD-5 keeps
    // verbatim cannot be rewritten, so the artifact is dropped rather than written unredacted.
    const recorder = recorderFor();
    const outcome = recorder.recordResult(
      submission({ parent_tool_use_id: 'sk-ant-api03-BBBBBBBBBBBBBBBBBBBBBBBBBBBB' }),
    );
    expect(outcome.dropped).toBe(true);
    expect(outcome.event.type).toBe('redaction.failed');
    expect(outcome.event.payload['reason']).toBe('passthrough-carries-secret');
    expect(readFileSync(logPathFor(), 'utf8')).not.toContain('sk-ant-api03');
  });

  it('keeps no producer-supplied step on the failure line when that step is itself a secret', () => {
    const recorder = recorderFor();
    const token = 'ghp_Aa0Bb1Cc2Dd3Ee4Ff5Gg6Hh7Ii8Jj9Kk';
    const cyclic: Record<string, unknown> = {};
    cyclic['self'] = cyclic;
    const outcome = recorder.recordResult(submission({ step: token, payload: cyclic }));

    expect(outcome.dropped).toBe(true);
    expect(outcome.event.step).toBeNull();
    expect(readFileSync(logPathFor(), 'utf8')).not.toContain('ghp_');
  });
});

describe('AD-29 — exactly one writer per events.jsonl', () => {
  it('refuses a second recorder in this process, naming the holder', () => {
    const first = recorderFor();
    let caught: unknown;
    try {
      recorderFor();
    } catch (thrown: unknown) {
      caught = thrown;
    }
    expect(caught).toBeInstanceOf(WriterConflictError);
    const conflict = caught as WriterConflictError;
    expect(conflict.holder?.pid).toBe(first.holder.pid);
    expect(conflict.message).toContain(String(first.holder.pid));
    expect(conflict.message).toContain(first.holder.host);
    expect(conflict.code).toBe('engine.lock_held');
  });

  it('refuses a second recorder in another live process, and that process keeps writing', async () => {
    const child = spawnWriter(RUN_ID);
    try {
      await waitUntil(() => existsSync(logPathFor()) && statSync(logPathFor()).size > 0);
      const sizeWhileHeld = statSync(logPathFor()).size;
      expect(() => recorderFor()).toThrowError(WriterConflictError);
      // The holder is unaffected by the refusal: it is still the one writer, still appending.
      await waitUntil(() => statSync(logPathFor()).size > sizeWhileHeld);
    } finally {
      child.kill('SIGKILL');
      await once(child, 'exit');
    }
  }, 30_000);

  it('lets the next recorder in once the holder has released its claim', () => {
    const first = recorderFor();
    first.record(submission());
    first.close();
    expect(() => recorderFor()).not.toThrow();
  });

  it('releases only its own claim, never a holder that reclaimed the lock after it', () => {
    const first = recorderFor();
    first.record(submission());
    const lockPath = runPaths(RUN_ID, home).eventLogLock;

    // A later holder's claim, as a reclaim would have written it.
    const laterHolder = {
      pid: process.pid + 1,
      host: hostname(),
      run: RUN_ID,
      since: formatTimestamp(),
    };
    writeFileSync(lockPath, `${JSON.stringify(laterHolder)}\n`, 'utf8');

    first.close();
    expect(existsSync(lockPath)).toBe(true);
    expect(JSON.parse(readFileSync(lockPath, 'utf8')) as typeof laterHolder).toStrictEqual(
      laterHolder,
    );
  });

  it('refuses to write through a recorder that has released its claim', () => {
    const recorder = recorderFor();
    recorder.close();
    expect(() => recorder.record(submission())).toThrowError(WriterConflictError);
  });

  it('reports a filesystem fault as itself, not as a writer conflict', () => {
    const paths = runPaths(RUN_ID, home);
    mkdirSync(paths.runDir, { recursive: true });
    // Read and execute only: the lock cannot be created, and the reason has nothing to do with a
    // holder. Reporting it as "an unreadable lock file" would hide the real fault.
    chmodSync(paths.runDir, 0o500);
    try {
      let caught: unknown;
      try {
        recorderFor();
      } catch (thrown: unknown) {
        caught = thrown;
      }
      expect(caught).toBeInstanceOf(Error);
      expect(caught).not.toBeInstanceOf(WriterConflictError);
      expect((caught as { code?: string }).code).toBe('EACCES');
    } finally {
      chmodSync(paths.runDir, 0o700);
    }
  });

  it('reclaims a lock only once the recorded pid is gone from this host', async () => {
    const paths = runPaths(RUN_ID, home);
    mkdirSync(paths.runDir, { recursive: true });

    // A pid that is alive: refused, never reclaimed.
    writeFileSync(
      paths.eventLogLock,
      `${JSON.stringify({ pid: process.pid, host: hostname(), run: RUN_ID, since: formatTimestamp() })}\n`,
    );
    expect(() => recorderFor()).toThrowError(WriterConflictError);

    // A pid that is gone: reclaimed, and numbering continues from the file.
    const deadPid = await spawnAndReap();
    writeFileSync(
      paths.eventLogLock,
      `${JSON.stringify({ pid: deadPid, host: hostname(), run: RUN_ID, since: formatTimestamp() })}\n`,
    );
    const recorder = recorderFor();
    expect(recorder.record(submission()).seq).toBe(1);
  });
});

describe('AD-4 — an interrupted append leaves only whole lines', () => {
  it('holds only parsable lines and one seq each after the writer is SIGKILLed mid-run', async () => {
    const child = spawnWriter(RUN_ID);
    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });

    // Kill it only once it is well into the log, so the signal lands during a write, not before one.
    // Each appended line is a little over 4 KiB, so this threshold guarantees well over 50 of them.
    await waitUntil(() => existsSync(logPathFor()) && statSync(logPathFor()).size > 512 * 1024);
    child.kill('SIGKILL');
    await once(child, 'exit');

    expect(stderr, stderr).toBe('');
    const text = readFileSync(logPathFor(), 'utf8');
    expect(text.length).toBeGreaterThan(512 * 1024);
    expect(isWholeLineTerminated(text)).toBe(true);

    // Every line is whole JSON and a valid envelope — readEventLog refuses anything else.
    const events = readEventLog(logPathFor());
    expect(events.length).toBeGreaterThan(50);
    expect(events.map((event) => event.seq)).toStrictEqual(
      events.map((_unused, index) => index + 1),
    );
    for (const event of events) expect(typeof event.payload['filler']).toBe('string');

    // The killed writer left its claim behind; the next recorder reclaims it and continues.
    const resumed = recorderFor();
    expect(resumed.record(submission()).seq).toBe(events.length + 1);
  }, 40_000);
});

describe('the dependency direction is fixed', () => {
  const runtimeDir = new URL('../src/runtime/', import.meta.url);
  const files = readdirSync(runtimeDir).filter((name) => name.endsWith('.ts'));

  const IMPORT_PATTERNS = [
    /^\s*(?:import|export)\b[^'";]*\bfrom\s*['"]([^'"]+)['"]/gm,
    /^\s*import\s*['"]([^'"]+)['"]/gm,
    /\bimport\s*\(\s*['"]([^'"]+)['"]/g,
    /\brequire\s*\(\s*['"]([^'"]+)['"]/g,
  ];

  const importsOf = (source: string): string[] =>
    IMPORT_PATTERNS.flatMap((pattern) =>
      [...source.matchAll(pattern)].map((match) => match[1] ?? ''),
    );

  it('has source files to inspect, and reads the imports it claims to', () => {
    expect(files.length).toBeGreaterThan(0);
    const source = readFileSync(new URL('recorder.ts', runtimeDir), 'utf8');
    expect(importsOf(source)).toContain('../contracts/index.js');
    expect(importsOf(source)).toContain('node:fs');
  });

  it.each(files)('%s imports only src/contracts/ and node: builtins', (file) => {
    const source = readFileSync(new URL(file, runtimeDir), 'utf8');
    for (const specifier of importsOf(source)) {
      if (!specifier.startsWith('.')) {
        expect(specifier.startsWith('node:'), `${file} imports "${specifier}"`).toBe(true);
        continue;
      }
      if (specifier.startsWith('../')) {
        expect(specifier.startsWith('../contracts/'), `${file} imports "${specifier}"`).toBe(true);
        continue;
      }
      expect(specifier.startsWith('./'), `${file} imports "${specifier}"`).toBe(true);
      expect(specifier.slice(2)).not.toContain('/');
    }
  });

  it('writes no diagnostics to stdout', () => {
    for (const file of files) {
      const source = readFileSync(new URL(file, runtimeDir), 'utf8');
      expect(source, file).not.toContain('process.stdout');
      expect(source, file).not.toMatch(/\bconsole\.\w+\(/);
    }
  });
});

/** Wait until a condition holds. Asynchronous on purpose: a busy-wait would starve the child. */
const waitUntil = async (condition: () => boolean, timeoutMs = 15_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for a child process');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

/** Spawn the writer that never stops, so a test can kill it mid-append. */
const spawnWriter = (runId: string): ChildProcess =>
  spawn(
    process.execPath,
    [
      '--import',
      fileURLToPath(new URL('../node_modules/jiti/lib/jiti-register.mjs', import.meta.url)),
      fileURLToPath(new URL('helpers/append-until-killed.ts', import.meta.url)),
      home,
      runId,
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  );

/** A pid that has certainly exited, for the stale-lock reclamation rule. */
const spawnAndReap = async (): Promise<number> => {
  const probe = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
  const pid = probe.pid ?? -1;
  await once(probe, 'exit');
  return pid;
};
