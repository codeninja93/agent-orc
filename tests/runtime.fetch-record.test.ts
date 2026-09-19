/**
 * AD-13 / AD-14 — the run shared fetch record: record, serve from the record without contacting the
 * domain, one value per record per run, and the AD-28 version refusal.
 *
 * Without these, AD-13's replay guarantee is unenforced: two steps of one run could see different
 * values for one external record, and a re-run could contact a domain the recorded run did not.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  CURRENT_SCHEMA_VERSION,
  FETCH_RECORD_CONTRACT_ID,
  FetchRecordSchema,
  SchemaVersionRefusal,
  canonicalFetchRequest,
  fetchRequestKey,
  getContract,
  parseVersionedArtifact,
} from '../src/contracts/index.js';
import type { FetchRequest, FetchResponse } from '../src/contracts/index.js';
import {
  ForeignFetchRecordError,
  RedactionFailedError,
  Recorder,
  RunFetchRecord,
  readEventLog,
} from '../src/runtime/index.js';

const RUN_ID = '01JBQZ8Q0000000000000000FR';
const FEATURE = 'runtime-recorder';
const DOMAIN_TOKEN = 'LinearDomainCredential-Zz9Yy8Xx7';

let home: string;
let recorder: Recorder;

const request: FetchRequest = {
  domain: 'linear',
  operation: 'issue.get',
  parameters: { id: 'ENG-412', include: ['comments', 'labels'] },
};

const response: FetchResponse = {
  ok: true,
  status: 200,
  body: { title: 'Recorder assigns seq', state: 'in progress' },
};

const recordPath = (): string => join(home, 'runs', RUN_ID, 'fetch-record.json');

const readRecordFile = (): unknown => JSON.parse(readFileSync(recordPath(), 'utf8')) as unknown;

const fetchEvents = (): ReturnType<typeof readEventLog> =>
  readEventLog(join(home, 'runs', RUN_ID, 'events.jsonl')).filter(
    (event) => event.type === 'fetch.recorded',
  );

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'orch-fetch-'));
  recorder = Recorder.open({
    runId: RUN_ID,
    feature: FEATURE,
    orchHome: home,
    fsync: false,
    redaction: { secrets: [{ name: 'the linear domain credential', value: DOMAIN_TOKEN }] },
  });
});

afterEach(() => {
  recorder.close();
  rmSync(home, { recursive: true, force: true });
});

describe('AD-13 — every external read is recorded to both the log and the record', () => {
  it('records the request and response to fetch-record.json and fetch.recorded to the log', async () => {
    const record = RunFetchRecord.open({ recorder, step: 'research' });
    const served = await record.serve(request, () => response);

    expect(served.source).toBe('domain');
    expect(served.response).toStrictEqual(response);

    const onDisk = parseVersionedArtifact(FetchRecordSchema, readRecordFile(), 'fetch-record.json');
    expect(onDisk.schema_version).toBe(CURRENT_SCHEMA_VERSION);
    expect(onDisk.run).toBe(RUN_ID);
    expect(onDisk.entries).toHaveLength(1);
    expect(onDisk.entries[0]?.key).toBe(fetchRequestKey(request));
    expect(onDisk.entries[0]?.recorded_by_step).toBe('research');
    expect(onDisk.entries[0]?.response).toStrictEqual(response);

    const events = fetchEvents();
    expect(events).toHaveLength(1);
    expect(events[0]?.payload['source']).toBe('domain');
    expect(events[0]?.payload['key']).toBe(fetchRequestKey(request));
    expect(events[0]?.payload['domain']).toBe('linear');
    expect(events[0]?.step).toBe('research');
    // AD-23 — the body is evidence plane: the log references the record, it does not carry it.
    expect(JSON.stringify(events[0]?.payload)).not.toContain('in progress');
  });

  it('registers fetch.record as an artifact-kind contract carrying schema_version (AD-17, AD-28)', () => {
    const entry = getContract(FETCH_RECORD_CONTRACT_ID);
    expect(entry.kind).toBe('artifact');
    expect(entry.model_produced).toBe(false);
    expect(entry.schema.safeParse({}).success).toBe(false);
    expect(RunFetchRecord.contractId).toBe(FETCH_RECORD_CONTRACT_ID);
  });

  it('redacts the recorded response, so a credential in a body never lands in the record', async () => {
    const record = RunFetchRecord.open({ recorder, step: 'research' });
    await record.serve(request, () => ({
      ok: true,
      status: 200,
      body: { header: `Authorization: Bearer ${DOMAIN_TOKEN}` },
    }));
    const text = readFileSync(recordPath(), 'utf8');
    expect(text).not.toContain(DOMAIN_TOKEN);
    expect(text).toContain('[redacted]');
  });
});

describe('AD-14 — one value per record per run, served from the record', () => {
  it('does not contact the domain for a request already recorded', async () => {
    const record = RunFetchRecord.open({ recorder, step: 'research' });
    let calls = 0;
    const perform = (): FetchResponse => {
      calls += 1;
      return response;
    };

    const first = await record.serve(request, perform);
    const second = await record.serve(request, perform);

    expect(calls).toBe(1);
    expect(first.source).toBe('domain');
    expect(second.source).toBe('record');
    expect(second.response).toStrictEqual(first.response);
    // The served read is still recorded: the log shows two reads, one of them from the record.
    expect(fetchEvents().map((event) => event.payload['source'])).toStrictEqual([
      'domain',
      'record',
    ]);
  });

  it('holds the first value even when the domain would now answer differently', async () => {
    const record = RunFetchRecord.open({ recorder, step: 'research' });
    await record.serve(request, () => response);
    const later = await record.serve(request, () => ({
      ok: true,
      status: 200,
      body: { title: 'a different answer' },
    }));

    expect(later.response).toStrictEqual(response);
    expect(record.entries).toHaveLength(1);
    expect(readFileSync(recordPath(), 'utf8')).not.toContain('a different answer');
  });

  it('is visible to a later step of the same run', async () => {
    const research = RunFetchRecord.open({ recorder, step: 'research' });
    await research.serve(request, () => response);

    const implementation = RunFetchRecord.open({ recorder, step: 'implementation' });
    let calls = 0;
    const served = await implementation.serve(request, () => {
      calls += 1;
      return response;
    });

    expect(calls).toBe(0);
    expect(served.source).toBe('record');
    expect(served.entry.recorded_by_step).toBe('research');
  });

  it('keys a request by domain, operation and parameters, whatever order they were built in', () => {
    const reordered: FetchRequest = {
      operation: request.operation,
      domain: request.domain,
      parameters: { include: ['comments', 'labels'], id: 'ENG-412' },
    };
    expect(canonicalFetchRequest(reordered)).toBe(canonicalFetchRequest(request));
    expect(fetchRequestKey(reordered)).toBe(fetchRequestKey(request));
    expect(fetchRequestKey(request)).toMatch(/^sha256:[0-9a-f]{16}$/);

    for (const different of [
      { ...request, domain: 'github' },
      { ...request, operation: 'issue.list' },
      { ...request, parameters: { id: 'ENG-413', include: ['comments', 'labels'] } },
    ]) {
      expect(fetchRequestKey(different)).not.toBe(fetchRequestKey(request));
    }
  });

  it('stores a key a later reader can re-derive from the entry it sits on', async () => {
    const record = RunFetchRecord.open({ recorder, step: 'research' });
    // A parameter that redaction rewrites: keying the raw request would leave the stored key
    // unre-derivable from the stored request, which is the only request any reader ever sees.
    const withSecret: FetchRequest = {
      domain: 'linear',
      operation: 'issue.get',
      parameters: { id: 'ENG-412', token: DOMAIN_TOKEN },
    };
    await record.serve(withSecret, () => response);

    const onDisk = parseVersionedArtifact(FetchRecordSchema, readRecordFile(), 'fetch-record.json');
    const entry = onDisk.entries[0];
    expect(entry).toBeDefined();
    expect(JSON.stringify(entry?.request)).not.toContain(DOMAIN_TOKEN);
    expect(fetchRequestKey(entry?.request ?? withSecret)).toBe(entry?.key);
    // And the same raw request still finds it, so the lookup and the stored key agree.
    expect(record.lookup(withSecret)?.key).toBe(entry?.key);
  });

  it('carries no request parameter in the key itself', () => {
    const key = fetchRequestKey({
      domain: 'linear',
      operation: 'issue.get',
      parameters: { token: DOMAIN_TOKEN },
    });
    expect(key).not.toContain(DOMAIN_TOKEN);
  });

  it('refuses a record file that holds one key twice', () => {
    const entry = {
      key: fetchRequestKey(request),
      request,
      response,
      recorded_at: '2026-09-19T12:00:00.000Z',
      recorded_by_step: 'research',
    };
    const result = FetchRecordSchema.safeParse({
      schema_version: CURRENT_SCHEMA_VERSION,
      run: RUN_ID,
      entries: [entry, entry],
    });
    expect(result.success).toBe(false);
  });
});

describe('AD-13 — a read that failed is still a read', () => {
  it('records an ok: false value, emits the event, and hands the failure back unchanged', async () => {
    const record = RunFetchRecord.open({ recorder, step: 'research' });
    const failure = new Error('the domain refused the connection');

    await expect(
      record.serve(request, () => {
        throw failure;
      }),
    ).rejects.toBe(failure);

    expect(record.entries).toHaveLength(1);
    expect(record.entries[0]?.response.ok).toBe(false);
    expect(record.entries[0]?.response.status).toBeNull();
    expect(fetchEvents()).toHaveLength(1);
    expect(fetchEvents()[0]?.payload['ok']).toBe(false);

    // And the recorded failure is what a later step of the run is served (AD-14: one value per run).
    let calls = 0;
    const served = await record.serve(request, () => {
      calls += 1;
      return response;
    });
    expect(calls).toBe(0);
    expect(served.source).toBe('record');
    expect(served.response.ok).toBe(false);
  });
});

describe('AD-14 — two live instances of one run share one record', () => {
  it('does not clobber an entry written by the other instance', async () => {
    const research = RunFetchRecord.open({ recorder, step: 'research' });
    const implementation = RunFetchRecord.open({ recorder, step: 'implementation' });
    const second: FetchRequest = { ...request, parameters: { id: 'ENG-999' } };

    // `implementation` was opened before `research` wrote, so its snapshot is empty: writing from
    // that snapshot alone would drop the first entry.
    await research.serve(request, () => response);
    await implementation.serve(second, () => response);

    const onDisk = parseVersionedArtifact(FetchRecordSchema, readRecordFile(), 'fetch-record.json');
    expect(onDisk.entries.map((entry) => entry.key).sort()).toStrictEqual(
      [fetchRequestKey(request), fetchRequestKey(second)].sort(),
    );
  });
});

describe('AD-21 — a fetch that fails redaction is dropped, not partly recorded', () => {
  it('writes nothing to the record, appends redaction.failed, and tells the caller', async () => {
    const record = RunFetchRecord.open({ recorder, step: 'research' });
    const cyclic: Record<string, unknown> = { note: DOMAIN_TOKEN };
    cyclic['self'] = cyclic;

    await expect(
      record.serve(request, () => ({ ok: true, status: 200, body: cyclic })),
    ).rejects.toBeInstanceOf(RedactionFailedError);

    expect(record.entries).toHaveLength(0);
    expect(existsOrEmpty(recordPath())).toBe('');

    const events = readEventLog(join(home, 'runs', RUN_ID, 'events.jsonl'));
    expect(events.map((event) => event.type)).toStrictEqual(['redaction.failed']);
    expect(events[0]?.payload['dropped_event_type']).toBe('fetch.recorded');
    expect(readFileSync(join(home, 'runs', RUN_ID, 'events.jsonl'), 'utf8')).not.toContain(
      DOMAIN_TOKEN,
    );
  });
});

describe('AD-28 — an unrecognised fetch-record version is refused', () => {
  it('names the installer version and never upgrades silently', () => {
    mkdirSync(join(home, 'runs', RUN_ID), { recursive: true });
    writeFileSync(
      recordPath(),
      JSON.stringify({
        schema_version: CURRENT_SCHEMA_VERSION + 1,
        run: RUN_ID,
        entries: [],
      }),
      'utf8',
    );

    let caught: unknown;
    try {
      RunFetchRecord.open({ recorder, step: 'research' });
    } catch (thrown: unknown) {
      caught = thrown;
    }
    expect(caught).toBeInstanceOf(SchemaVersionRefusal);
    const refusal = caught as SchemaVersionRefusal;
    expect(refusal.artifact).toBe('fetch-record.json');
    expect(refusal.schemaVersion).toBe(CURRENT_SCHEMA_VERSION + 1);
    expect(refusal.message).toContain('installer version');
    // The file is left exactly as it was found.
    expect(readRecordFile()).toStrictEqual({
      schema_version: CURRENT_SCHEMA_VERSION + 1,
      run: RUN_ID,
      entries: [],
    });
  });

  it('refuses a record file that belongs to another run', () => {
    mkdirSync(join(home, 'runs', RUN_ID), { recursive: true });
    writeFileSync(
      recordPath(),
      JSON.stringify({
        schema_version: CURRENT_SCHEMA_VERSION,
        run: '01JBQZ8Q00000000000000OTHR',
        entries: [],
      }),
      'utf8',
    );

    let caught: unknown;
    try {
      RunFetchRecord.open({ recorder, step: 'research' });
    } catch (thrown: unknown) {
      caught = thrown;
    }
    expect(caught).toBeInstanceOf(ForeignFetchRecordError);
    expect((caught as ForeignFetchRecordError).foundRun).toBe('01JBQZ8Q00000000000000OTHR');
    expect((caught as ForeignFetchRecordError).expectedRun).toBe(RUN_ID);
  });

  it('sweeps a temporary file a crashed write left behind', () => {
    mkdirSync(join(home, 'runs', RUN_ID), { recursive: true });
    const debris = `${recordPath()}.9999.tmp`;
    writeFileSync(debris, '{"partial":', 'utf8');
    RunFetchRecord.open({ recorder, step: 'research' });
    expect(existsSync(debris)).toBe(false);
  });

  it('refuses a record file with no schema_version, naming the field', () => {
    mkdirSync(join(home, 'runs', RUN_ID), { recursive: true });
    writeFileSync(recordPath(), JSON.stringify({ run: RUN_ID, entries: [] }), 'utf8');
    expect(() => RunFetchRecord.open({ recorder, step: 'research' })).toThrowError(
      /schema_version/,
    );
  });
});

/** '' when the file does not exist, so a "nothing was written" assertion reads plainly. */
const existsOrEmpty = (path: string): string => {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
};
