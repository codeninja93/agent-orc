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

/**
 * How the CLI says it authenticated. `none` is the subscription login (AD-1).
 *
 * `reported` is separate from `source` because absence and denial are different facts. An init line
 * that simply does not carry `apiKeySource` — an older CLI, a field renamed — says nothing about how
 * the session authenticated, and treating that silence as API-key mode would fail *every* attempt with
 * `model.api_key_mode_refused`, an `escalate-to-human` code no retry clears. A fact the stream does
 * not state is not evidence against the machine, so an unreported source is not a refusal; the
 * spawner records which of the three cases happened.
 */
export interface ApiKeySourceRecord {
  readonly kind: 'api_key_source';
  /** The reported value, or `(unreported)` when the init line carried no such field. */
  readonly source: string;
  /** False only when the CLI positively named a key source that is not the subscription login. */
  readonly subscription: boolean;
  /** True when the init line actually carried the field. */
  readonly reported: boolean;
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

/** The name carried by a denial whose tool the CLI did not name in a shape this parser recognises. */
export const UNNAMED_DENIED_TOOL = '(unnamed tool)';

/** A tool call the permission layer refused. */
export interface PermissionDeniedRecord {
  readonly kind: 'permission_denied';
  /** {@link UNNAMED_DENIED_TOOL} when the refusal named no tool this parser could read. */
  readonly toolName: string;
  /**
   * Whether the refusal arrived as its own `system` line or inside the result's `permission_denials`.
   *
   * The CLI reports the same refusal in both places, so the parser must suppress the second — but the
   * only value shared by the two reports is `tool_use_id`, and it is not always present. The origin
   * lets the de-duplicator count occurrences *within* each report instead of across them, so two
   * genuinely distinct refusals of the same tool for the same reason both survive.
   */
  readonly origin: 'line' | 'result';
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
  /**
   * The CLI's own `errors` array, verbatim.
   *
   * This is structured JSON the CLI owns, and it is how a refused `--resume` is recognised. Recorded:
   * a resume against a session the CLI no longer has emits one result line carrying
   * `subtype: "error_during_execution"`, `is_error: true`, `num_turns: 0`, the *requested* session id
   * and `errors: ["No conversation found with session ID: …"]`. Reading the refusal off this array
   * rather than off a stderr message means the signal does not depend on wording this system does not
   * own. Empty for an ordinary result.
   */
  readonly errors: readonly string[];
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

/** What {@link ApiKeySourceRecord.source} reads when the init line carried no such field. */
export const UNREPORTED_API_KEY_SOURCE = '(unreported)';

/**
 * The most a single line may grow to before the parser gives up on it.
 *
 * `pending` holds bytes from another process that has not yet written a newline, so without a cap a
 * child emitting one enormous line — or no newline at all — grows it without limit from output this
 * system does not control. Past the cap the line is skipped like any other unreadable one and the
 * parser resynchronises on the next newline.
 */
export const MAX_STREAM_LINE_BYTES = 4 * 1024 * 1024;

/** The CLI's own `errors` array, keeping only the strings in it. */
const errorsOf = (line: Record<string, unknown>): readonly string[] => {
  const raw = line['errors'];
  if (!Array.isArray(raw)) return [];
  return raw.filter((entry): entry is string => typeof entry === 'string');
};

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
  origin: PermissionDeniedRecord['origin'],
): PermissionDeniedRecord | null => {
  if (!isObject(entry)) return null;
  // A refusal whose tool name cannot be read is still a refusal. Reporting it under
  // `UNNAMED_DENIED_TOOL` keeps a `permission.denied` event on the log; dropping it would make a
  // renamed field turn a refused tool call into silence, which is the one direction a permission
  // event must never fail in.
  const toolName =
    stringOrNull(entry['tool_name']) ?? stringOrNull(entry['name']) ?? UNNAMED_DENIED_TOOL;
  return {
    kind: 'permission_denied',
    toolName,
    origin,
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
  const type = stringOrNull(parsed['type']) ?? '(untyped)';
  const subtype = stringOrNull(parsed['subtype']);
  const errors = errorsOf(parsed);

  /**
   * A refusal line announces no session.
   *
   * Recorded: a refused `--resume` emits one result line carrying the *requested* session id and an
   * `errors` array saying the conversation was not found. That id names a session that does not exist,
   * so reporting it would have the checkpoint record a dead id as the live one — and AD-8 grants one
   * resume per recorded id, so the next pass would spend it on a session the CLI has already denied.
   * A session opened for real is announced by the `init` line, which is not a refusal.
   */
  const announcesSession = !(type === 'result' && errors.length > 0);
  if (sessionId !== null && announcesSession) records.push({ kind: 'session', sessionId });

  if (type === 'system' && subtype === 'init') {
    const reported = stringOrNull(parsed['apiKeySource']);
    records.push({
      kind: 'api_key_source',
      source: reported ?? UNREPORTED_API_KEY_SOURCE,
      // Absence is not denial: only a positively named non-subscription source is a refusal.
      subscription: reported === null || reported === SUBSCRIPTION_SOURCE,
      reported: reported !== null,
    });
    return records;
  }

  if (type === 'system' && subtype === 'permission_denied') {
    const denial = denialFromEntry(parsed, sessionId, 'line');
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
        const denial = denialFromEntry(entry, sessionId, 'result');
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
      errors,
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
  /**
   * How the CLI said it authenticated, or `null` when no `init` line ever arrived.
   *
   * The distinction is recorded rather than collapsed: "the CLI said API-key mode", "the CLI said
   * nothing about it" and "there was no init line to say anything" are three different facts, and only
   * the first is a refusal.
   */
  readonly apiKeySource: () => ApiKeySourceRecord | null;
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
  let overlong = false;
  let lineNumber = 0;
  let seenSessionId: string | null = null;
  let seenApiKeySource: ApiKeySourceRecord | null = null;
  let terminal: ResultRecord | null = null;
  const seenDenials = new Set<string>();
  /** Denials with no `tool_use_id`, counted per origin, so the ordinal is the only thing shared. */
  const anonymousDenials = new Map<string, number>();

  /**
   * The key one refusal is remembered by.
   *
   * With a `tool_use_id` the identity is the CLI's own and nothing else is needed. Without one, the
   * ordinal *within the origin* stands in for it: the `system` lines number their id-less refusals
   * 1, 2, 3… and the result's `permission_denials` numbers its own 1, 2, 3…, so the second report of
   * one refusal collides with the first while two genuinely distinct refusals of the same tool for the
   * same reason do not.
   */
  const denialKey = (record: PermissionDeniedRecord): string => {
    if (record.toolUseId !== null) return `id:${record.toolUseId}`;
    const counter = `${record.origin}:${record.toolName}:${record.reason ?? ''}`;
    const ordinal = (anonymousDenials.get(counter) ?? 0) + 1;
    anonymousDenials.set(counter, ordinal);
    return `anon:${record.toolName}:${record.reason ?? ''}:${String(ordinal)}`;
  };

  const keep = (records: readonly StreamRecord[]): readonly StreamRecord[] => {
    const kept: StreamRecord[] = [];
    for (const record of records) {
      if (record.kind === 'session') {
        if (seenSessionId !== null) continue;
        seenSessionId = record.sessionId;
      }
      if (record.kind === 'api_key_source') {
        if (seenApiKeySource !== null) continue;
        seenApiKeySource = record;
      }
      if (record.kind === 'permission_denied') {
        // One refusal, one event — whether it arrived as a `system` line, on the result, or both.
        const key = denialKey(record);
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
      const records: StreamRecord[] = [];
      pending += chunk;
      const parts = pending.split('\n');
      // The last part is whatever followed the final newline: a partial line, or the empty string.
      pending = parts.pop() ?? '';
      for (const line of parts) {
        if (overlong) {
          // The newline that ends the line already reported as overlong resynchronises the parser.
          overlong = false;
          continue;
        }
        records.push(...consume(line));
      }
      if (!overlong && pending.length > MAX_STREAM_LINE_BYTES) {
        // Skip the line rather than keep buffering it: the bytes are unvalidated output from another
        // process, and the fail-safe direction is one recorded skip, not unbounded growth.
        lineNumber += 1;
        records.push(
          ...keep([
            {
              kind: 'unparseable',
              reason: `the line exceeded the ${String(MAX_STREAM_LINE_BYTES)}-byte cap before any newline`,
              bytes: pending.length,
              line: lineNumber,
            },
          ]),
        );
        overlong = true;
        pending = '';
      } else if (overlong) {
        pending = '';
      }
      return records;
    },
    end: (): readonly StreamRecord[] => {
      if (overlong) {
        overlong = false;
        pending = '';
        return [];
      }
      if (pending === '') return [];
      const last = pending;
      pending = '';
      return consume(last);
    },
    sessionId: (): string | null => seenSessionId,
    result: (): ResultRecord | null => terminal,
    apiKeySource: (): ApiKeySourceRecord | null => seenApiKeySource,
  };
};

/** Parse a whole transcript at once. The convenience a fixture-driven suite reads a file with. */
export const parseStream = (text: string): readonly StreamRecord[] => {
  const parser = createStreamParser();
  return [...parser.push(text), ...parser.end()];
};
