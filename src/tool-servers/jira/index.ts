/**
 * `src/tool-servers/jira/` — the first instance of the general tool-server pattern (story 2-10),
 * proving CAP-7 ("each external domain reachable by exactly one agent, enforced by where its
 * credential lives") against a real external domain.
 *
 * Structurally this mirrors `src/runner/index.ts`'s own MCP surface: a stdio JSON-RPC loop, a pure
 * `handleJiraMcpRequest` the loop is a thin wrapper around, and a `createJiraServerFromEnvironment`
 * that assembles the server from nothing but the environment `--mcp-config` gives it. What differs is
 * the domain this server owns and what it does with a call once one arrives:
 *
 * **The credential lives only here.** It is injected by the engine at spawn time
 * (`jiraMcpConfig`/`src/engine/spawner.ts`) into an env var named by the profile, read once at
 * startup, and never logged, never returned to a caller, and never passed to the network call by
 * name — only its value travels, inside an `Authorization` header. A server that starts with its named
 * credential env var unset or empty refuses to start (matrix row 7): serving with no credential is not
 * a degraded mode this server has, it is a state it never enters.
 *
 * **Every read goes through the run's fetch record.** `createJiraServer` calls
 * `RunFetchRecord.serve()` for both declared operations, which is the whole of this story's Boundary
 * on redaction, replay and one-value-per-run — nothing new is built for it here, only called.
 *
 * **Amended after review pass 1.** This server no longer opens a live `Recorder` for the run — the
 * engine's reconciler already holds that AD-29 claim for the run's whole lifetime while a step (and
 * therefore this server, spawned as the step's own child) is executing, and a second `Recorder.open()`
 * would throw `WriterConflictError` on every real, engine-driven invocation. Instead this server opens
 * the run's fetch record through `RunFetchRecord.openStandalone()`, which needs no live `Recorder` and
 * appends nothing to `events.jsonl` itself; the reconciler backfills that mirror once it next holds its
 * own live `Recorder` for the run (`src/engine/reconciler.ts`). The record on disk — the durable,
 * authoritative source of "was this served from record" — is unaffected either way.
 *
 * **Nothing here mutates Jira.** Both declared operations are reads; a write operation is a different,
 * later decision this story does not make.
 */
import {
  JIRA_SERVER_NAME,
  makeError,
  toJsonSchema,
} from '../../contracts/index.js';
import type { OrchError } from '../../contracts/index.js';
import { RunFetchRecord, resolveOrchHome } from '../../runtime/index.js';
import type { FetchResponse } from '../../contracts/index.js';

import {
  JIRA_OPERATION_REQUEST_SCHEMAS,
  JIRA_TOOL_NAMES,
  callJiraApi,
  isJiraOperationName,
  parseJiraRequest,
} from './operations.js';
import type { JiraCredential, JiraFetchImpl } from './operations.js';

export * from './operations.js';

/** The revision of the Model Context Protocol this server speaks. See `src/runner/index.ts` for why. */
export const MCP_PROTOCOL_VERSION = '2025-06-18';

/** The server's own MCP tool names, one per declared operation. The two coincide for Jira. */
export { JIRA_TOOL_NAMES as JIRA_MCP_TOOL_NAMES };

/**
 * The Jira tool server refused to start.
 *
 * `config.invalid` → `escalate-to-human`: no retry and no model rung supplies a credential nobody
 * configured. Matrix row 7 is exactly this, raised at the moment the server would otherwise have
 * started serving with none.
 */
export class JiraServerStartupError extends Error {
  readonly code = 'config.invalid';
  readonly orchError: OrchError;

  constructor(detail: string) {
    const message = `Refusing to start the Jira tool server: ${detail}.`;
    super(message);
    this.name = 'JiraServerStartupError';
    this.orchError = makeError(this.code, message, detail);
  }
}

export interface JiraServerOptions {
  readonly credential: JiraCredential;
  readonly fetchRecord: RunFetchRecord;
  /** Injectable so no dispatch-level test makes a real network call. Defaults to a real `fetch`. */
  readonly fetchImpl?: JiraFetchImpl;
}

/** The server's surface: one verb, dispatching on the operation name. */
export interface JiraServer {
  readonly call: (operation: string, parameters: unknown) => Promise<FetchResponse>;
}

/**
 * The Jira tool server.
 *
 * Every call is routed through the run's fetch record: a request already recorded this run is served
 * from it and Jira is not contacted again (matrix row 2); a request that fails is recorded as a
 * failure and the same failure is served to an identical later request rather than retried (matrix
 * row 4); `search_issues` and `get_issue` are distinct entries because `operation` is part of the
 * fetch-record key (matrix row 5).
 */
export const createJiraServer = (options: JiraServerOptions): JiraServer => {
  const call = async (operation: string, parameters: unknown): Promise<FetchResponse> => {
    // Refused here, before any fetch-record lookup or network call: an operation this server does not
    // declare, or one shaped wrong for the one it names, never reaches `.serve()` (matrix row 6).
    const parsed = parseJiraRequest(operation, parameters);
    if (!parsed.ok) {
      throw Object.assign(new Error(parsed.message), { code: 'config.invalid' });
    }
    const request = {
      domain: 'jira',
      operation,
      parameters: parsed.value as unknown as Record<string, unknown>,
    };
    const served = await options.fetchRecord.serve(request, () =>
      callJiraApi(operation as 'get_issue' | 'search_issues', parsed.value, options.credential, options.fetchImpl),
    );
    return served.response;
  };
  return { call };
};

/** The MCP tool descriptor for one declared operation, published by `tools/list`. */
export const jiraToolDescriptors = (): readonly Readonly<Record<string, unknown>>[] =>
  JIRA_TOOL_NAMES.map((name) => ({
    name,
    description:
      name === 'get_issue'
        ? 'Read one Jira issue by key. Read-only; served from this run’s fetch record when already read.'
        : 'Search Jira issues with a bounded JQL query. Read-only; served from this run’s fetch ' +
          'record when already read.',
    inputSchema: toJsonSchema(JIRA_OPERATION_REQUEST_SCHEMAS[name]),
  }));

/** A JSON-RPC request as this server reads one. Unknown fields are ignored, never rejected. */
export interface JsonRpcRequest {
  readonly jsonrpc?: string;
  readonly id?: string | number | null;
  readonly method?: string;
  readonly params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  readonly jsonrpc: '2.0';
  readonly id: string | number | null;
  readonly result?: unknown;
  readonly error?: {
    readonly code: number;
    readonly message: string;
    /** This system's own AD-35 code, when the refusal carries one. */
    readonly data?: { readonly code: string };
  };
}

const JSON_RPC_INVALID_PARAMS = -32_602;
const JSON_RPC_METHOD_NOT_FOUND = -32_601;
const JSON_RPC_INTERNAL_ERROR = -32_603;
const JSON_RPC_PARSE_ERROR = -32_700;

/**
 * Answer one MCP request.
 *
 * `src/runner/index.ts`'s own `handleMcpRequest`, one domain over, with the one structural
 * difference a read of an external domain has: a Jira call reaches the network, so this is async
 * where the command runner's is not.
 */
export const handleJiraMcpRequest = async (
  server: JiraServer,
  request: JsonRpcRequest,
): Promise<JsonRpcResponse | null> => {
  const id = request.id ?? null;
  const respond = (result: unknown): JsonRpcResponse => ({ jsonrpc: '2.0', id, result });
  const fail = (code: number, message: string, orchCode: string | null = null): JsonRpcResponse => ({
    jsonrpc: '2.0',
    id,
    error: { code, message, ...(orchCode === null ? {} : { data: { code: orchCode } }) },
  });

  switch (request.method) {
    case 'initialize':
      return respond({
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: JIRA_SERVER_NAME, version: '1' },
      });
    case 'notifications/initialized':
      return null;
    case 'ping':
      return respond({});
    case 'tools/list':
      return respond({ tools: jiraToolDescriptors() });
    case 'tools/call': {
      const params = request.params ?? {};
      const name = params['name'];
      if (typeof name !== 'string' || !isJiraOperationName(name)) {
        return fail(
          JSON_RPC_METHOD_NOT_FOUND,
          `This server serves ${JIRA_TOOL_NAMES.join(' and ')}, and nothing named "${String(name)}". ` +
            'CAP-7 keeps the surface to exactly the reads it declares.',
        );
      }
      try {
        const response = await server.call(name, params['arguments']);
        return respond({
          // The control-plane answer, exactly as it was recorded: `RunFetchRecord.serve()` already
          // redacted it, so there is nothing further to strip here.
          content: [{ type: 'text', text: JSON.stringify(response) }],
          structuredContent: response,
          // A Jira read that answered `ok: false` is a *result*, not a tool error: the same reasoning
          // `src/runner/index.ts` gives a failing gate. `isError` would make the CLI report the tool
          // itself as broken, and a step would retry the server rather than act on what Jira said.
          isError: false,
        });
      } catch (thrown: unknown) {
        const code =
          thrown !== null && typeof thrown === 'object' && 'code' in thrown
            ? String((thrown as { readonly code: unknown }).code)
            : null;
        return fail(
          code === 'config.invalid' || code === null ? JSON_RPC_INVALID_PARAMS : JSON_RPC_INTERNAL_ERROR,
          thrown instanceof Error ? thrown.message : 'the Jira request could not be served',
          code,
        );
      }
    }
    default:
      return fail(
        JSON_RPC_METHOD_NOT_FOUND,
        `This server implements initialize, tools/list and tools/call, not "${String(request.method)}".`,
      );
  }
};

/**
 * Read the Jira credential from this server's own environment, or refuse to start (matrix row 7).
 *
 * `ORCH_JIRA_CREDENTIAL_ENV` names *which* of this process's own environment entries holds the
 * credential — a per-profile choice the server cannot otherwise know — and `ORCH_JIRA_BASE_URL` is
 * the (non-secret) API root the profile also records. Both arrive from `jiraMcpConfig`
 * (`src/contracts/installer.ts`), composed by the engine at spawn time from the run's own profile and
 * the engine's own environment; nothing here ever reads `.orch/` or any environment but its own.
 */
export const jiraCredentialFromEnvironment = (env: NodeJS.ProcessEnv = process.env): JiraCredential => {
  const credentialEnvVar = (env['ORCH_JIRA_CREDENTIAL_ENV'] ?? '').trim();
  const baseUrl = (env['ORCH_JIRA_BASE_URL'] ?? '').trim();
  if (credentialEnvVar === '') {
    throw new JiraServerStartupError(
      'ORCH_JIRA_CREDENTIAL_ENV names no environment variable, so there is nothing to read the ' +
        'credential from — the Jira domain is most likely not enabled in this profile',
    );
  }
  const value = (env[credentialEnvVar] ?? '').trim();
  if (value === '') {
    throw new JiraServerStartupError(`its named credential env var "${credentialEnvVar}" is unset or empty`);
  }
  if (baseUrl === '') {
    throw new JiraServerStartupError('ORCH_JIRA_BASE_URL is unset or empty, so there is no API to call');
  }
  return { baseUrl, value };
};

/** What assembling the server from the environment produces: the server, and its own fetch record. */
export interface AssembledJiraServer {
  readonly server: JiraServer;
  readonly fetchRecord: RunFetchRecord;
}

/**
 * Build the server for the run and step the environment names, opening this run's fetch record.
 *
 * **Nothing here imports `src/engine/`, for the reason `src/runner/index.ts` gives for itself:** this
 * process is started by a step's own `claude -p`, and the richer engine-side readers resolve far more
 * than a tool server needs.
 *
 * **Amended after review pass 1 — opens the fetch record standalone, not through a `Recorder`.** The
 * engine's reconciler already holds the run's AD-29 `events.jsonl` claim for the run's whole lifetime
 * while this server's own step is executing, so `Recorder.open()` would throw `WriterConflictError` on
 * every real invocation. `RunFetchRecord.openStandalone()` is the other door: its own dedicated
 * exclusive lock over `fetch-record.json` alone, serialising this run's tool-server processes against
 * each other without needing the engine's own claim at all.
 */
export const createJiraServerFromEnvironment = (
  env: NodeJS.ProcessEnv = process.env,
): AssembledJiraServer => {
  const run = env['ORCH_RUN'] ?? '';
  const step = env['ORCH_STEP'] ?? '';
  if (run === '' || step === '') {
    throw new JiraServerStartupError(
      'ORCH_RUN and ORCH_STEP name the run and step this server serves, and one of them is unset — ' +
        'a server that guessed would record one step’s reads under another’s run',
    );
  }
  const credential = jiraCredentialFromEnvironment(env);
  const orchHome = resolveOrchHome(env);
  const fetchRecord = RunFetchRecord.openStandalone({ runId: run, orchHome, step });
  return { server: createJiraServer({ credential, fetchRecord }), fetchRecord };
};

export const serveJiraServerOverStdio = (
  server: JiraServer,
  input: NodeJS.ReadableStream,
  output: NodeJS.WritableStream,
  /**
   * Called once stdin ends (the step that started this server has finished) so the caller can release
   * whatever this server's construction acquired — the standalone fetch record's dedicated lock, for
   * `createJiraServerFromEnvironment`'s assembly. Defaults to nothing, for a caller with nothing to
   * release.
   */
  // The default is a no-op: a caller with nothing to release (a dispatch-level test, for instance).
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  onInputEnded: () => void = (): void => {},
): void => {
  let buffered = '';
  const send = (message: JsonRpcResponse): void => {
    output.write(`${JSON.stringify(message)}\n`);
  };
  const answer = async (line: string): Promise<void> => {
    if (line.trim() === '') return;
    let request: JsonRpcRequest;
    try {
      request = JSON.parse(line) as JsonRpcRequest;
    } catch {
      send({
        jsonrpc: '2.0',
        id: null,
        error: { code: JSON_RPC_PARSE_ERROR, message: 'the line was not whole JSON and was skipped' },
      });
      return;
    }
    const response = await handleJiraMcpRequest(server, request);
    if (response !== null) send(response);
  };

  input.setEncoding('utf8');
  input.on('data', (chunk: string | Buffer) => {
    buffered += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    const lines = buffered.split('\n');
    buffered = lines.pop() ?? '';
    for (const line of lines) {
      // Requests are answered as their bytes arrive; the underlying fetch record still serialises any
      // race over one key (AD-14), so concurrent calls from one step are safe in whichever order the
      // network answers them.
      void answer(line);
    }
  });
  /** A last line with no trailing newline is still a request. See `src/runner/index.ts` for why. */
  input.on('end', () => {
    const remaining = buffered;
    buffered = '';
    void answer(remaining).finally(onInputEnded);
  });
  input.on('error', (cause: Error) => {
    send({
      jsonrpc: '2.0',
      id: null,
      error: {
        code: JSON_RPC_INTERNAL_ERROR,
        message: `the request stream failed, so no further call can be read: ${cause.message}`,
      },
    });
    onInputEnded();
  });
  output.on('error', () => {
    // Nothing can be sent on a broken output; see `src/runner/index.ts` for why this is silent.
  });
};
