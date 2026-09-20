/**
 * AD-1 — the `--output-format stream-json` parser.
 *
 * Because no unit may link the Claude Agent SDK as a library, this parser *is* the system's whole
 * view of what a step agent did: the session id a resume depends on (AD-8), every tool use, every
 * permission denial, and the terminal `structured_output` AD-1 re-parses. There is no second channel.
 *
 * Three properties are worth more attention than the shape-matching around them:
 *
 * **The shapes are recorded, not invented.** Every field read here was read off a real
 * `claude -p --output-format stream-json` transcript committed under `tests/fixtures/stream-json/`,
 * including the `system`/`permission_denied` line and the `permission_denials` array on the result —
 * both captured from real refusals. A parser tested only against fixtures written from its own
 * assumptions proves that it agrees with itself.
 *
 * **An unparseable line is skipped, never fatal.** A step's stream is bytes from another process; a
 * torn line means that line is lost, not that the attempt is lost. The parser reports the skip so the
 * spawner can record it and carries on, which is what makes the step still terminate.
 *
 * **The parser never reproduces the line it could not read.** An `unparseable` record carries the
 * reason and the byte count and nothing else. The bytes are unvalidated model-adjacent output, and
 * the fail-safe direction for something about to be appended to an immutable log (AD-4, AD-21) is to
 * describe it rather than to carry it.
 *
 * Nothing here spawns, reads a file or emits an event: the parser turns text into records, and the
 * spawner decides what they mean.
 */

/** The kinds of record a stream yields. */
export const STREAM_RECORD_KINDS = [
  'session',
  'api_key_source',
  'tool_use',
  'permission_denied',
  'result',
  'unparseable',
  'ignored',
] as const;

export type StreamRecordKind = (typeof STREAM_RECORD_KINDS)[number];

/** The session id the CLI reported, emitted at most once per stream (AD-8). */
export interface SessionRecord {
  readonly kind: 'session';
  readonly sessionId: string;
}

/** How the CLI says it authenticated. `none` is the subscription login (AD-1). */
export interface ApiKeySourceRecord {
  readonly kind: 'api_key_source';
  readonly source: string;
  readonly subscription: boolean;
}

/** A tool the agent used. `parentToolUseId` is preserved verbatim per AD-5. */
export interface ToolUseRecord {
  readonly kind: 'tool_use';
  readonly toolName: string;
  readonly toolUseId: string;
  /** Non-null when the call came from a nested subagent. Carried verbatim, never normalised. */
  readonly parentToolUseId: string | null;
  readonly sessionId: string | null;
}

/** A tool call the permission layer refused. */
export interface PermissionDeniedRecord {
  readonly kind: 'permission_denied';
  readonly toolName: string;
  readonly toolUseId: string | null;
  /** The CLI's own explanation, e.g. `--restricted: path outside the working directory`. */
  readonly reason: string | null;
  readonly reasonType: string | null;
  readonly parentToolUseId: string | null;
  readonly sessionId: string | null;
}

/** The terminal line. `structuredOutput` is still unvalidated here; AD-1's re-parse is the spawner's. */
export interface ResultRecord {
  readonly kind: 'result';
  readonly subtype: string;
  readonly isError: boolean;
  /** Distinguishes "absent" from "present and null", which map to different failures. */
  readonly hasStructuredOutput: boolean;
  readonly structuredOutput: unknown;
  readonly sessionId: string | null;
  readonly numTurns: number | null;
}

/** A line that was not whole JSON. Carries no part of the line itself. */
export interface UnparseableRecord {
  readonly kind: 'unparseable';
  readonly reason: string;
  readonly bytes: number;
  /** 1-based position in the stream, so two skips are distinguishable in the log. */
  readonly line: number;
}

/** A line the parser read and had nothing to say about. Kept so a suite can prove coverage. */
export interface IgnoredRecord {
  readonly kind: 'ignored';
  readonly type: string;
  readonly subtype: string | null;
}

export type StreamRecord =
  | SessionRecord
  | ApiKeySourceRecord
  | ToolUseRecord
  | PermissionDeniedRecord
  | ResultRecord
  | UnparseableRecord
  | IgnoredRecord;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const stringOrNull = (value: unknown): string | null => (typeof value === 'string' ? value : null);

/**
 * The `system`/`init` value that says the login is a subscription. Duplicated from `cli.ts` as a
 * comparison rather than imported, so the parser stays free of the preflight's resolution concerns.
 */
const SUBSCRIPTION_SOURCE = 'none';

/** Tool-use blocks inside an assistant message. */
const toolUsesIn = (line: Record<string, unknown>): readonly ToolUseRecord[] => {
  const message = line['message'];
  if (!isObject(message)) return [];
  const content = message['content'];
  if (!Array.isArray(content)) return [];
  const sessionId = stringOrNull(line['session_id']);
  const parentToolUseId = stringOrNull(line['parent_tool_use_id']);
  const records: ToolUseRecord[] = [];
  for (const block of content) {
    if (!isObject(block) || block['type'] !== 'tool_use') continue;
    const toolName = stringOrNull(block['name']);
    const toolUseId = stringOrNull(block['id']);
    if (toolName === null || toolUseId === null) continue;
    records.push({ kind: 'tool_use', toolName, toolUseId, parentToolUseId, sessionId });
  }
  return records;
};

/**
 * One denial entry from the result line's `permission_denials`.
 *
 * The recorded shape is `{ tool_name, tool_use_id, tool_input }`. The alternative spellings are read
 * too, and deliberately: this is the one shape in the stream the system depends on that is carried
 * inside an array rather than as a top-level line, so a rename would otherwise turn a refused tool
 * call into silence — the single worst direction for a permission event to fail in.
 */
const denialFromEntry = (
  entry: unknown,
  sessionId: string | null,
): PermissionDeniedRecord | null => {
  if (!isObject(entry)) return null;
  const toolName = stringOrNull(entry['tool_name']) ?? stringOrNull(entry['name']);
  if (toolName === null) return null;
  return {
    kind: 'permission_denied',
    toolName,
    toolUseId: stringOrNull(entry['tool_use_id']) ?? stringOrNull(entry['id']),
    reason: stringOrNull(entry['decision_reason']) ?? stringOrNull(entry['reason']),
    reasonType: stringOrNull(entry['decision_reason_type']),
    parentToolUseId: stringOrNull(entry['parent_tool_use_id']),
    sessionId,
  };
};

/**
 * Turn one whole line into the records it carries.
 *
 * Pure: it neither remembers a session id it already saw nor suppresses a repeated denial. Those are
 * per-stream facts and belong to {@link createStreamParser}, which is the only thing that can know
 * whether something has been seen before.
 */
export const parseStreamLine = (line: string, lineNumber = 1): readonly StreamRecord[] => {
  const trimmed = line.trim();
  if (trimmed === '') return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed) as unknown;
  } catch {
    return [
      {
        kind: 'unparseable',
        reason: 'the line was not whole JSON',
        bytes: Buffer.byteLength(line, 'utf8'),
        line: lineNumber,
      },
    ];
  }
  if (!isObject(parsed)) {
    return [
      {
        kind: 'unparseable',
        reason: 'the line parsed to something that is not a JSON object',
        bytes: Buffer.byteLength(line, 'utf8'),
        line: lineNumber,
      },
    ];
  }

  const records: StreamRecord[] = [];
  const sessionId = stringOrNull(parsed['session_id']);
  if (sessionId !== null) records.push({ kind: 'session', sessionId });

  const type = stringOrNull(parsed['type']) ?? '(untyped)';
  const subtype = stringOrNull(parsed['subtype']);

  if (type === 'system' && subtype === 'init') {
    const source = stringOrNull(parsed['apiKeySource']) ?? '(unreported)';
    records.push({
      kind: 'api_key_source',
      source,
      subscription: source === SUBSCRIPTION_SOURCE,
    });
    return records;
  }

  if (type === 'system' && subtype === 'permission_denied') {
    const denial = denialFromEntry(parsed, sessionId);
    if (denial !== null) records.push(denial);
    else records.push({ kind: 'ignored', type, subtype });
    return records;
  }

  if (type === 'assistant') {
    const uses = toolUsesIn(parsed);
    if (uses.length === 0) records.push({ kind: 'ignored', type, subtype });
    else records.push(...uses);
    return records;
  }

  if (type === 'result') {
    const denials = parsed['permission_denials'];
    if (Array.isArray(denials)) {
      for (const entry of denials) {
        const denial = denialFromEntry(entry, sessionId);
        if (denial !== null) records.push(denial);
      }
    }
    const numTurns = parsed['num_turns'];
    records.push({
      kind: 'result',
      subtype: subtype ?? '(unreported)',
      isError: parsed['is_error'] === true,
      hasStructuredOutput: Object.prototype.hasOwnProperty.call(parsed, 'structured_output'),
      structuredOutput: parsed['structured_output'],
      sessionId,
      numTurns: typeof numTurns === 'number' ? numTurns : null,
    });
    return records;
  }

  records.push({ kind: 'ignored', type, subtype });
  return records;
};

export interface StreamParser {
  /** Feed a chunk of stdout. Returns the records completed by it; a partial line is held back. */
  readonly push: (chunk: string) => readonly StreamRecord[];
  /** Flush a trailing line with no newline after it. Safe to call more than once. */
  readonly end: () => readonly StreamRecord[];
  /** The session id, once seen. */
  readonly sessionId: () => string | null;
  /** The terminal result, once seen. */
  readonly result: () => ResultRecord | null;
}

/**
 * An incremental parser over the child's stdout.
 *
 * It holds one partial line, which is the whole reason it exists: stdout arrives in chunks that cut
 * lines anywhere, and a per-chunk `JSON.parse` would report a torn parse for every large tool result.
 * A line is only ever handed to {@link parseStreamLine} once it is whole.
 *
 * It also carries the two per-stream facts a pure line parser cannot know: the session id is emitted
 * the first time it appears and never again, so `onSessionId` is called at most once per attempt
 * (AD-8); and a denial already seen as a `system` line is not emitted a second time when the result
 * line repeats it in `permission_denials`.
 */
export const createStreamParser = (): StreamParser => {
  let pending = '';
  let lineNumber = 0;
  let seenSessionId: string | null = null;
  let seenApiKeySource = false;
  let terminal: ResultRecord | null = null;
  const seenDenials = new Set<string>();

  const keep = (records: readonly StreamRecord[]): readonly StreamRecord[] => {
    const kept: StreamRecord[] = [];
    for (const record of records) {
      if (record.kind === 'session') {
        if (seenSessionId !== null) continue;
        seenSessionId = record.sessionId;
      }
      if (record.kind === 'api_key_source') {
        if (seenApiKeySource) continue;
        seenApiKeySource = true;
      }
      if (record.kind === 'permission_denied') {
        // One refusal, one event — whether it arrived as a `system` line, on the result, or both.
        const key = record.toolUseId ?? `${record.toolName}:${record.reason ?? ''}`;
        if (seenDenials.has(key)) continue;
        seenDenials.add(key);
      }
      if (record.kind === 'result') terminal = record;
      kept.push(record);
    }
    return kept;
  };

  const consume = (line: string): readonly StreamRecord[] => {
    lineNumber += 1;
    return keep(parseStreamLine(line, lineNumber));
  };

  return {
    push: (chunk: string): readonly StreamRecord[] => {
      pending += chunk;
      const parts = pending.split('\n');
      // The last part is whatever followed the final newline: a partial line, or the empty string.
      pending = parts.pop() ?? '';
      return parts.flatMap((line) => consume(line));
    },
    end: (): readonly StreamRecord[] => {
      if (pending === '') return [];
      const last = pending;
      pending = '';
      return consume(last);
    },
    sessionId: (): string | null => seenSessionId,
    result: (): ResultRecord | null => terminal,
  };
};

/** Parse a whole transcript at once. The convenience a fixture-driven suite reads a file with. */
export const parseStream = (text: string): readonly StreamRecord[] => {
  const parser = createStreamParser();
  return [...parser.push(text), ...parser.end()];
};
