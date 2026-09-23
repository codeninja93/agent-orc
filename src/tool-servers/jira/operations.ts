/**
 * The vocabulary of the Jira tool server: what a step may ask Jira for, and the refusal for
 * everything else.
 *
 * **A closed enum of two read-only operations, never a free-form query surface.** CAP-7 and this
 * story's own scope hold Jira to reads, and `src/runner/commands.ts`'s own reasoning applies unchanged
 * one domain over: a request shaped for an operation this server does not declare is rejected at the
 * schema boundary before any network call (matrix row 6), which is a shape the request cannot take
 * rather than a check somebody could forget to make.
 *
 * **The two request schemas are `z.strictObject`, for the same reason `DeclaredCommandRequestSchema`
 * is.** An unknown field silently stripped is a field a caller cannot be sure was not passed, and this
 * server's whole surface is small enough that "exactly these fields" costs nothing to state.
 */
import { z } from 'zod';

import { JIRA_TOOL_NAMES } from '../../contracts/index.js';
import type { FetchResponse, JiraToolName } from '../../contracts/index.js';

export { JIRA_TOOL_NAMES };
export type { JiraToolName };

/** `get_issue` — one issue, by key. */
export const GetIssueRequestSchema = z.strictObject({
  key: z.string().min(1).describe('The Jira issue key, e.g. "PROJ-123".'),
});

export type GetIssueRequest = z.infer<typeof GetIssueRequestSchema>;

/**
 * `search_issues` — a bounded JQL search.
 *
 * `maxResults` is bounded rather than open-ended: an unbounded search is a read this server cannot
 * size before it happens, and every read here is meant to be a small, typed, cacheable request — the
 * shape `RunFetchRecord`'s key is derived over.
 */
export const SearchIssuesRequestSchema = z.strictObject({
  jql: z.string().min(1).describe('A JQL query.'),
  maxResults: z.number().int().min(1).max(100).default(50),
});

export type SearchIssuesRequest = z.infer<typeof SearchIssuesRequestSchema>;

/** The request schema for each declared operation, keyed by the same name the tool is called by. */
export const JIRA_OPERATION_REQUEST_SCHEMAS = {
  get_issue: GetIssueRequestSchema,
  search_issues: SearchIssuesRequestSchema,
} as const;

/** True when a name is one of the two operations this server declares. */
export const isJiraOperationName = (name: string): name is JiraToolName =>
  (JIRA_TOOL_NAMES as readonly string[]).includes(name);

/**
 * A request shaped for an operation this server does not declare, or shaped wrong for the one it
 * names.
 *
 * `config.invalid` → `escalate-to-human` in the AD-35 table, the same disposition
 * `UndeclaredCommandError` carries: no retry and no model rung makes an unsayable request sayable.
 */
export class UndeclaredJiraOperationError extends Error {
  readonly code = 'config.invalid';

  constructor(requested: string) {
    super(
      `Refusing "${requested}": it is not a Jira operation this server declares. Declared: ` +
        `${JIRA_TOOL_NAMES.join(', ')}. CAP-7 and this server hold Jira to exactly these two reads; a ` +
        'write operation is a different, later decision.',
    );
    this.name = 'UndeclaredJiraOperationError';
  }
}

/**
 * Parse a request against the schema its own operation name declares.
 *
 * Two-step, deliberately: the operation name is validated as a closed enum first (an operation this
 * server has never heard of gets a refusal naming what it does declare, not a schema-validation
 * message about a union it cannot see into), and only once that holds is the *shape* of its
 * parameters checked.
 */
export const parseJiraRequest = (
  operation: string,
  parameters: unknown,
):
  | { readonly ok: true; readonly value: GetIssueRequest | SearchIssuesRequest }
  | { readonly ok: false; readonly message: string } => {
  if (!isJiraOperationName(operation)) {
    throw new UndeclaredJiraOperationError(operation);
  }
  const schema = JIRA_OPERATION_REQUEST_SCHEMAS[operation];
  const parsed = schema.safeParse(parameters);
  if (!parsed.success) {
    return {
      ok: false,
      message:
        `Refusing the call: "${operation}" takes ${describeShape(operation)}. ` +
        parsed.error.issues
          .map(
            (issue) =>
              `${issue.path.map((part) => String(part)).join('.') || '(root)'}: ${issue.message}`,
          )
          .join('; '),
    };
  }
  return { ok: true, value: parsed.data };
};

const describeShape = (operation: JiraToolName): string =>
  operation === 'get_issue'
    ? 'a Jira issue key ("key")'
    : 'a JQL query ("jql") and an optional "maxResults"';

/** The Jira credential this server was started with: never logged, never passed to a network call by name. */
export interface JiraCredential {
  readonly baseUrl: string;
  readonly value: string;
}

/**
 * Injectable via `fetchImpl` so the dispatch-level suite never makes a real network call: what is
 * proven here is that the *right* request is built and the *response* is translated into the shape
 * `RunFetchRecord.serve()` records, never that a particular Jira deployment answers a particular way.
 */
export type JiraFetchImpl = (request: {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
}) => Promise<{ readonly status: number; readonly body: unknown }>;

/**
 * How long this server waits for Jira to answer one request before giving up.
 *
 * **Amended after review pass 1.** `defaultJiraFetch` called plain `fetch()` with no bound at all, so
 * an unresponsive Jira instance blocked the step indefinitely — a run's own wall-clock ceiling was the
 * only eventual backstop. An `AbortSignal` on this timeout turns that into a recorded failure
 * (matrix row 4: `{ ok: false, ... }`, served the same way to a later identical request) rather than a
 * hang nothing routes on.
 */
export const JIRA_FETCH_TIMEOUT_MS = 30_000;

const defaultJiraFetch: JiraFetchImpl = async (request) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), JIRA_FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(request.url, { headers: request.headers, signal: controller.signal });
    const text = await response.text();
    let body: unknown = text;
    try {
      body = text === '' ? null : JSON.parse(text);
    } catch {
      // A non-JSON body is carried as text rather than dropped: Jira's own error pages are HTML.
    }
    return { status: response.status, body };
  } finally {
    clearTimeout(timer);
  }
};

/** The REST path one operation resolves to, relative to the credential's base URL. */
const jiraRequestUrl = (
  baseUrl: string,
  operation: JiraToolName,
  parameters: GetIssueRequest | SearchIssuesRequest,
): string => {
  const trimmedBase = baseUrl.replace(/\/+$/, '');
  if (operation === 'get_issue') {
    const { key } = parameters as GetIssueRequest;
    return `${trimmedBase}/rest/api/3/issue/${encodeURIComponent(key)}`;
  }
  const { jql, maxResults } = parameters as SearchIssuesRequest;
  const search = new URLSearchParams({ jql, maxResults: String(maxResults) });
  return `${trimmedBase}/rest/api/3/search?${search.toString()}`;
};

/**
 * Call Jira for one already-validated request, and answer with the shape `RunFetchRecord.serve()`
 * expects: `{ ok, status, body }`, never a thrown transport error for an ordinary non-2xx response.
 *
 * A network failure (DNS, refused connection, timeout) *is* thrown, because that is not Jira answering
 * — it is Jira not being reachable at all — and `RunFetchRecord.serve()` records exactly that
 * distinction: a reachable-but-erroring Jira is `{ ok: false, status: <code>, body }`, an unreachable
 * one is a recorded failure with no status (matrix row 4 either way).
 */
export const callJiraApi = async (
  operation: JiraToolName,
  parameters: unknown,
  credential: JiraCredential,
  fetchImpl: JiraFetchImpl = defaultJiraFetch,
): Promise<FetchResponse> => {
  const url = jiraRequestUrl(credential.baseUrl, operation, parameters as GetIssueRequest | SearchIssuesRequest);
  const { status, body } = await fetchImpl({
    url,
    headers: { Authorization: `Bearer ${credential.value}`, Accept: 'application/json' },
  });
  return { ok: status >= 200 && status < 300, status, body: body as FetchResponse['body'] };
};
