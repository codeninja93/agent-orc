/**
 * Story 2-10 — the Jira tool server, dispatch-level: matrix rows 1, 2, 4, 5, 6, 7 against real
 * dispatch code, mirroring `tests/runner.command.test.ts`'s own shape one domain over.
 *
 * **Amended after review pass 1.** These matrix-row tests are unchanged in what they assert — only
 * the server's own construction path (how it obtains a `RunFetchRecord`) changed beneath them, per
 * the KEEP instructions in the story's Spec Change Log. What is new in this file is the standalone
 * fetch-record construction path itself: it needs no live `Recorder`, and it still refuses a second
 * concurrent standalone writer for the same run (AD-14's "exactly one value" holding regardless of
 * which process reached it first).
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { FetchRecordWriterConflictError, Recorder, RunFetchRecord, readEventLog } from '../src/runtime/index.js';
import {
  JIRA_FETCH_TIMEOUT_MS,
  JiraServerStartupError,
  UndeclaredJiraOperationError,
  createJiraServer,
  handleJiraMcpRequest,
  jiraCredentialFromEnvironment,
} from '../src/tool-servers/jira/index.js';
import type { JiraFetchImpl } from '../src/tool-servers/jira/index.js';

/** A `JiraFetchImpl` that answers from a scripted queue and records what it was called with. */
const fakeFetch = (
  responses: readonly { readonly status: number; readonly body: unknown }[],
): {
  readonly impl: JiraFetchImpl;
  readonly calls: { readonly url: string; readonly headers: Readonly<Record<string, string>> }[];
} => {
  const calls: { readonly url: string; readonly headers: Readonly<Record<string, string>> }[] = [];
  let index = 0;
  const impl: JiraFetchImpl = (request) => {
    calls.push({ url: request.url, headers: request.headers });
    const next = responses[Math.min(index, responses.length - 1)];
    index += 1;
    if (next === undefined) throw new Error('fakeFetch called with no scripted response left');
    return Promise.resolve(next);
  };
  return { impl, calls };
};

const credential = { baseUrl: 'https://example.atlassian.net', value: 'jira-token-Zz9Yy8Xx7Ww6' };

describe('dispatch-level: every read goes through the run’s fetch record', () => {
  const RUN_ID = '01JBQZ8Q0000000000000JIRA1';
  const FEATURE = 'jira-tool-server';
  let home: string;
  let recorder: Recorder;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'orch-jira-'));
    recorder = Recorder.open({ runId: RUN_ID, feature: FEATURE, orchHome: home, fsync: false });
  });

  afterEach(() => {
    recorder.close();
    rmSync(home, { recursive: true, force: true });
  });

  describe('matrix row 1 — a request not yet recorded this run calls Jira once and records it', () => {
    it('calls Jira, records the response, and answers the agent', async () => {
      const fetchRecord = RunFetchRecord.open({ recorder, step: 'analyse' });
      const { impl, calls } = fakeFetch([{ status: 200, body: { key: 'PROJ-1', fields: {} } }]);
      const server = createJiraServer({ credential, fetchRecord, fetchImpl: impl });

      const response = await server.call('get_issue', { key: 'PROJ-1' });

      expect(response).toStrictEqual({ ok: true, status: 200, body: { key: 'PROJ-1', fields: {} } });
      expect(calls).toHaveLength(1);
      expect(calls[0]?.url).toBe('https://example.atlassian.net/rest/api/3/issue/PROJ-1');
      expect(calls[0]?.headers['Authorization']).toBe(`Bearer ${credential.value}`);

      const events = readEventLog(join(home, 'runs', RUN_ID, 'events.jsonl')).filter(
        (event) => event.type === 'fetch.recorded',
      );
      expect(events).toHaveLength(1);
      expect(events[0]?.payload['domain']).toBe('jira');
      expect(events[0]?.payload['operation']).toBe('get_issue');
    });
  });

  describe('matrix row 2 — the same request again in the same run is served from the record', () => {
    it('does not contact Jira a second time', async () => {
      const fetchRecord = RunFetchRecord.open({ recorder, step: 'analyse' });
      const { impl, calls } = fakeFetch([{ status: 200, body: { key: 'PROJ-1' } }]);
      const server = createJiraServer({ credential, fetchRecord, fetchImpl: impl });

      const first = await server.call('get_issue', { key: 'PROJ-1' });
      const second = await server.call('get_issue', { key: 'PROJ-1' });

      expect(calls).toHaveLength(1);
      expect(second).toStrictEqual(first);
    });
  });

  describe('matrix row 4 — a failed call is recorded, and the same failure is served, not retried', () => {
    it('re-throws the failure once, then serves the recorded failure without contacting Jira again', async () => {
      const fetchRecord = RunFetchRecord.open({ recorder, step: 'analyse' });
      const failing: JiraFetchImpl = () => Promise.reject(new Error('ECONNREFUSED'));
      const server = createJiraServer({ credential, fetchRecord, fetchImpl: failing });

      await expect(server.call('get_issue', { key: 'PROJ-1' })).rejects.toThrow('ECONNREFUSED');

      const second = await server.call('get_issue', { key: 'PROJ-1' });
      expect(second.ok).toBe(false);
      expect(second.status).toBeNull();
    });
  });

  describe('matrix row 5 — get_issue and search_issues are distinct fetch-record entries', () => {
    it('keys the two operations separately, even over an overlapping-looking parameter', async () => {
      const fetchRecord = RunFetchRecord.open({ recorder, step: 'analyse' });
      const { impl, calls } = fakeFetch([
        { status: 200, body: { key: 'PROJ-1' } },
        { status: 200, body: { issues: [] } },
      ]);
      const server = createJiraServer({ credential, fetchRecord, fetchImpl: impl });

      await server.call('get_issue', { key: 'PROJ-1' });
      await server.call('search_issues', { jql: 'key = PROJ-1' });

      expect(calls).toHaveLength(2);
      expect(fetchRecord.entries).toHaveLength(2);
      expect(new Set(fetchRecord.entries.map((entry) => entry.key)).size).toBe(2);
    });
  });

  describe('matrix row 6 — an operation the server does not declare is refused before any network call', () => {
    it('refuses an unsayable operation over the direct call', async () => {
      const fetchRecord = RunFetchRecord.open({ recorder, step: 'analyse' });
      const { impl, calls } = fakeFetch([{ status: 200, body: {} }]);
      const server = createJiraServer({ credential, fetchRecord, fetchImpl: impl });

      await expect(server.call('delete_issue', { key: 'PROJ-1' })).rejects.toThrow(
        UndeclaredJiraOperationError,
      );
      expect(calls).toHaveLength(0);
    });

    it('refuses over the MCP wire too, naming what is declared, without a network call', async () => {
      const fetchRecord = RunFetchRecord.open({ recorder, step: 'analyse' });
      const { impl, calls } = fakeFetch([{ status: 200, body: {} }]);
      const server = createJiraServer({ credential, fetchRecord, fetchImpl: impl });

      const response = await handleJiraMcpRequest(server, {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'delete_issue', arguments: { key: 'PROJ-1' } },
      });

      expect(response?.error?.message).toContain('get_issue and search_issues');
      expect(calls).toHaveLength(0);
    });

    it('refuses a known operation shaped wrong, before any network call', async () => {
      const fetchRecord = RunFetchRecord.open({ recorder, step: 'analyse' });
      const { impl, calls } = fakeFetch([{ status: 200, body: {} }]);
      const server = createJiraServer({ credential, fetchRecord, fetchImpl: impl });

      await expect(server.call('get_issue', {})).rejects.toThrow(/takes a Jira issue key/);
      expect(calls).toHaveLength(0);
    });
  });
});

describe('matrix row 7 — the server refuses to start rather than serving with no credential', () => {
  it('refuses when ORCH_JIRA_CREDENTIAL_ENV names no variable', () => {
    expect(() => jiraCredentialFromEnvironment({})).toThrow(JiraServerStartupError);
  });

  it('refuses when the named variable is unset or blank', () => {
    expect(() =>
      jiraCredentialFromEnvironment({
        ORCH_JIRA_CREDENTIAL_ENV: 'JIRA_API_TOKEN',
        ORCH_JIRA_BASE_URL: 'https://example.atlassian.net',
      }),
    ).toThrow(JiraServerStartupError);
    expect(() =>
      jiraCredentialFromEnvironment({
        ORCH_JIRA_CREDENTIAL_ENV: 'JIRA_API_TOKEN',
        JIRA_API_TOKEN: '   ',
        ORCH_JIRA_BASE_URL: 'https://example.atlassian.net',
      }),
    ).toThrow(JiraServerStartupError);
  });

  it('refuses when the base URL is unset, even with a real credential', () => {
    expect(() =>
      jiraCredentialFromEnvironment({
        ORCH_JIRA_CREDENTIAL_ENV: 'JIRA_API_TOKEN',
        JIRA_API_TOKEN: 'a-real-token',
      }),
    ).toThrow(JiraServerStartupError);
  });

  it('assembles the credential from its own environment when both are present', () => {
    const found = jiraCredentialFromEnvironment({
      ORCH_JIRA_CREDENTIAL_ENV: 'JIRA_API_TOKEN',
      JIRA_API_TOKEN: 'a-real-token',
      ORCH_JIRA_BASE_URL: 'https://example.atlassian.net',
    });
    expect(found).toStrictEqual({ baseUrl: 'https://example.atlassian.net', value: 'a-real-token' });
  });
});

describe('the fetch timeout amendment', () => {
  it('bounds a Jira call, so an unresponsive instance fails the read rather than blocking forever', () => {
    // A boundary rather than a network test: `defaultJiraFetch` is not exported (only `callJiraApi`
    // is, and every dispatch-level test above injects its own `fetchImpl`), so what is asserted here
    // is that the bound exists and is a sane, finite one — the amendment review pass 1 required.
    expect(JIRA_FETCH_TIMEOUT_MS).toBeGreaterThan(0);
    expect(JIRA_FETCH_TIMEOUT_MS).toBeLessThan(5 * 60 * 1000);
  });
});

/**
 * Story 2-10, review pass 1's amendment — `RunFetchRecord.openStandalone()`. No test above opens a
 * `Recorder` for these run ids at all: that is the whole point of this construction path, and a
 * suite that opened one alongside it would not be testing what it claims to.
 */
describe('the standalone fetch-record path needs no live Recorder (review pass 1)', () => {
  const RUN_ID = '01JBQZ8Q0000000000STANDALO';
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'orch-jira-standalone-'));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it('opens, serves and persists to fetch-record.json with no Recorder held for the run', async () => {
    const standalone = RunFetchRecord.openStandalone({ runId: RUN_ID, orchHome: home, step: 'analyse' });
    try {
      const served = await standalone.serve(
        { domain: 'jira', operation: 'get_issue', parameters: { key: 'PROJ-1' } },
        () => ({ ok: true, status: 200, body: { key: 'PROJ-1' } }),
      );
      expect(served.source).toBe('domain');
    } finally {
      standalone.close();
    }

    const onDisk = JSON.parse(
      readFileSync(join(home, 'runs', RUN_ID, 'fetch-record.json'), 'utf8'),
    ) as { readonly entries: readonly unknown[] };
    expect(onDisk.entries).toHaveLength(1);

    // AD-13's mirror in events.jsonl is the reconciler's to backfill, at a point where it holds its
    // own live Recorder — this path appends nothing to that file itself, which here has never even
    // been created.
    expect(existsSync(join(home, 'runs', RUN_ID, 'events.jsonl'))).toBe(false);
  });

  it('opens cleanly even while the engine holds a live Recorder for the very same run', () => {
    // The exact scenario review pass 1 found broken: the reconciler already holds `events.jsonl`'s
    // AD-29 writer claim for this run's whole lifetime while a step (and so this server, its own
    // child) is executing. `Recorder.open()` for this run would throw `WriterConflictError`; the
    // standalone path must not, because it never touches that claim at all.
    const recorder = Recorder.open({ runId: RUN_ID, feature: 'jira-tool-server', orchHome: home, fsync: false });
    try {
      let standalone: RunFetchRecord | undefined;
      expect(() => {
        standalone = RunFetchRecord.openStandalone({ runId: RUN_ID, orchHome: home, step: 'analyse' });
      }).not.toThrow();
      standalone?.close();
    } finally {
      recorder.close();
    }
  });

  it('serves a request already on disk from a previous standalone instance, without recontacting Jira', async () => {
    const first = RunFetchRecord.openStandalone({ runId: RUN_ID, orchHome: home });
    await first.serve({ domain: 'jira', operation: 'get_issue', parameters: { key: 'PROJ-1' } }, () => ({
      ok: true,
      status: 200,
      body: { key: 'PROJ-1' },
    }));
    first.close();

    // A second, later short-lived server for the same run — exactly what a later step's own Jira
    // MCP child is.
    const second = RunFetchRecord.openStandalone({ runId: RUN_ID, orchHome: home });
    try {
      let contacted = false;
      const served = await second.serve(
        { domain: 'jira', operation: 'get_issue', parameters: { key: 'PROJ-1' } },
        () => {
          contacted = true;
          return { ok: true, status: 200, body: { key: 'PROJ-1' } };
        },
      );
      expect(contacted).toBe(false);
      expect(served.source).toBe('record');
    } finally {
      second.close();
    }
  });

  it('refuses a second standalone writer for the same run while the first is still open', () => {
    const first = RunFetchRecord.openStandalone({ runId: RUN_ID, orchHome: home });
    try {
      expect(() => RunFetchRecord.openStandalone({ runId: RUN_ID, orchHome: home })).toThrow(
        FetchRecordWriterConflictError,
      );
    } finally {
      first.close();
    }
  });

  it('lets a later caller open cleanly once the first has released its claim', () => {
    const first = RunFetchRecord.openStandalone({ runId: RUN_ID, orchHome: home });
    first.close();

    const second = RunFetchRecord.openStandalone({ runId: RUN_ID, orchHome: home });
    expect(() => second.close()).not.toThrow();
  });
});
