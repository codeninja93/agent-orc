/**
 * AD-13 / AD-14 — the run shared fetch record, as an on-disk contract.
 *
 * Every external read is recorded, through the AD-21 redaction pass, to the event log and to
 * `runs/<run-id>/fetch-record.json`. Within one run an external record has exactly one value: a
 * later step asking for a request already present is served from the record, and the domain is not
 * contacted. That is what makes a re-run deterministic (AD-8).
 *
 * The request *key* lives here rather than in the runtime because both the recorder and any later
 * MCP server must derive the same key for the same request; a key derived two ways is two records.
 * It is a SHA-256 over a canonical rendering, so the key can be a map key on disk without carrying
 * request parameters — which may hold a credential — in the clear.
 */
import { createHash } from 'node:crypto';

import { z } from 'zod';

import { TimestampSchema } from './event.js';
import { versioned } from './schema-version.js';

/** The registry id this artifact is registered under (AD-17), spelled once. */
export const FETCH_RECORD_CONTRACT_ID = 'fetch.record';

/** One external request, identified by the domain that serves it and the operation invoked. */
export const FetchRequestSchema = z.object({
  /** The AD-13 domain: one MCP server, one credential, one name. */
  domain: z.string(),
  /** The read operation invoked on that domain — an MCP tool name or an endpoint. */
  operation: z.string(),
  /** The arguments that make this request this request. Part of the key. */
  parameters: z.record(z.string(), z.unknown()),
});

export type FetchRequest = z.infer<typeof FetchRequestSchema>;

/**
 * A JSON response body. Deliberately non-recursive: nested structure is `unknown`, which keeps the
 * export free of `$ref` cycles while still requiring the field to be present.
 */
export const FetchResponseBodySchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
  z.array(z.unknown()),
  z.record(z.string(), z.unknown()),
]);

export const FetchResponseSchema = z.object({
  /** Whether the domain answered the read. A recorded failure is still a recorded value. */
  ok: z.boolean(),
  /** A transport status where the domain has one, else null. */
  status: z.number().nullable(),
  body: FetchResponseBodySchema,
});

export type FetchResponse = z.infer<typeof FetchResponseSchema>;

/** The key prefix, so a key is self-describing about how it was derived. */
export const FETCH_REQUEST_KEY_PREFIX = 'sha256:';

/**
 * The digest is carried at 64 bits, not its full width: the key travels in the event log, which every
 * line passes the AD-21 redaction pass on the way to, and an unbroken 64-character digest reads as
 * high-entropy secret material there — a redacted key would break the pointer AD-23 relies on. 64
 * bits keys one run's fetch record with no realistic collision.
 */
export const FETCH_REQUEST_KEY_DIGEST_CHARS = 16;

export const FETCH_REQUEST_KEY_PATTERN = /^sha256:[0-9a-f]{16}$/;

export const FetchRequestKeySchema = z.string().refine(
  (key) => FETCH_REQUEST_KEY_PATTERN.test(key),
  { message: 'must be a sha256: key over the canonical request rendering' },
);

/**
 * Canonical JSON: object keys sorted, no insertion-order dependence, so two callers that build the
 * same request in different field orders derive the same key.
 */
export const canonicalJson = (value: unknown): string => {
  if (value === null) return 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, child]) => child !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`);
    return `{${entries.join(',')}}`;
  }
  if (typeof value === 'undefined') return 'null';
  return JSON.stringify(value) ?? 'null';
};

/** The canonical rendering a key is taken over. Domain and operation are part of the identity. */
export const canonicalFetchRequest = (request: FetchRequest): string =>
  canonicalJson({
    domain: request.domain,
    operation: request.operation,
    parameters: request.parameters,
  });

/**
 * The request key. One value per request per run, and safe to store in the clear: a digest carries
 * no recoverable parameter, so the key itself can never be the leak the redaction pass prevents.
 */
export const fetchRequestKey = (request: FetchRequest): string =>
  FETCH_REQUEST_KEY_PREFIX +
  createHash('sha256')
    .update(canonicalFetchRequest(request), 'utf8')
    .digest('hex')
    .slice(0, FETCH_REQUEST_KEY_DIGEST_CHARS);

/** One recorded external read. The request and response stored here have passed redaction. */
export const FetchRecordEntrySchema = z.object({
  key: FetchRequestKeySchema,
  request: FetchRequestSchema,
  response: FetchResponseSchema,
  /** When the domain was contacted. Ordering authority stays with the log's `seq` (AD-29). */
  recorded_at: TimestampSchema,
  /** The step that first fetched it, or null for a run-level read. */
  recorded_by_step: z.string().nullable(),
});

export type FetchRecordEntry = z.infer<typeof FetchRecordEntrySchema>;

/**
 * `runs/<run-id>/fetch-record.json`. Carries `schema_version` per AD-28, so an unrecognised version
 * is refused rather than silently upgraded.
 */
export const FetchRecordSchema = versioned({
  run: z.string(),
  entries: z.array(FetchRecordEntrySchema),
}).refine(
  (record) => new Set(record.entries.map((entry) => entry.key)).size === record.entries.length,
  {
    message: 'within one run an external record has exactly one value, so keys are unique (AD-14)',
    path: ['entries'],
  },
);

export type FetchRecord = z.infer<typeof FetchRecordSchema>;

/** The empty record a run starts from. */
export const emptyFetchRecord = (run: string, schemaVersion: number): FetchRecord => ({
  schema_version: schemaVersion,
  run,
  entries: [],
});

/** Look a key up in a record. `null` rather than `undefined`, so a miss is a decision, not an absence. */
export const findFetchRecordEntry = (record: FetchRecord, key: string): FetchRecordEntry | null =>
  record.entries.find((entry) => entry.key === key) ?? null;
