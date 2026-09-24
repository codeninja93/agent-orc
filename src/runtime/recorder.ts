/**
 * AD-29 / AD-4 — the runtime recorder: the only process that appends to a run's `events.jsonl`, and
 * the sole assigner of `seq`.
 *
 * Every other producer — MCP servers running as children of `claude -p`, step subprocesses, the
 * engine itself — emits through this unit rather than opening the file. Two appenders on one file
 * interleave, and AD-4 makes the result permanent, so the single-writer claim is taken as a lock on
 * disk and refused by name rather than assumed by convention.
 *
 * The order of operations on the write path is fixed and is the whole point of the unit:
 *
 *   1. assign `seq` — monotonic per file, no gaps, one assigner;
 *   2. validate the envelope (AD-5) — a missing declared field is a rejection, an unknown `type` is
 *      not;
 *   3. redact (AD-21) — and on failure drop the artifact and append `redaction.failed` in its place;
 *   4. append one whole line, ending in a newline, in a single write.
 *
 * Diagnostics never go to stdout; everything observable is an event.
 */
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { hostname } from 'node:os';

import {
  EVENT_ENVELOPE_STREAM_FIELDS,
  EVENT_ENVELOPE_VERBATIM_FIELDS,
  EVENT_PAYLOAD_VERBATIM_FIELDS,
  EventEnvelopeSchema,
  dispositionFor,
  formatTimestamp,
  hasEventIdentityShape,
} from '../contracts/index.js';
import type { EventEnvelope } from '../contracts/index.js';

import { createFileExclusively } from './exclusive-create.js';
import { runPaths } from './paths.js';
import type { RunPaths } from './paths.js';
import { createRedactor, describeThrown, REDACTION_MARKER } from './redaction.js';
import type { RedactionFailure, RedactionPolicy, Redactor } from './redaction.js';

/** The emitter name the recorder uses for the events it originates itself. */
export const RECORDER_EMITTER = 'runtime.recorder';

/**
 * `redaction.failed` is both a declared event type (AD-5) and a declared error code (AD-35), and the
 * recorder is the first unit to emit both. They are not the same thing and are not conflated here:
 * the *type* names the line in the log, and the *code* is what the disposition table answers about.
 * The disposition is read from the table rather than restated, so the two cannot drift apart.
 */
export const REDACTION_FAILED_EVENT_TYPE = 'redaction.failed';
export const REDACTION_FAILED_ERROR_CODE = 'redaction.failed';

/** The AD-35 disposition of the error code, read from the table, never asserted independently. */
export const redactionFailedDisposition = (): string => dispositionFor(REDACTION_FAILED_ERROR_CODE);

/** The first `seq` in a file. `seq` is 1-based, so 0 is never a valid assigned value. */
export const FIRST_SEQ = 1;

/**
 * What a producer submits. `seq` is never submitted — it is the recorder's to assign — and `ts`
 * is optional, because a producer that does not keep a clock should not invent one.
 *
 * The runtime API accepts `unknown` rather than this type: the producers include MCP servers whose
 * submissions arrive over a transport, so validation is a runtime gate, not a compile-time one.
 * This type is what an in-process producer builds against.
 */
export interface EventSubmission {
  readonly ts?: string;
  readonly feature: string;
  readonly run: string;
  readonly step: string | null;
  readonly emitter: string;
  readonly type: string;
  readonly payload: Record<string, unknown>;
  readonly parent_tool_use_id?: string | null;
  readonly session_id?: string | null;
  /** AD-26 — the commit the emitting step's worktree stood at. An envelope field, never a payload entry. */
  readonly baseline_ref?: string | null;
}

/** The holder of a run's single-writer claim, as recorded in the lock file. */
export interface WriterClaim {
  readonly pid: number;
  readonly host: string;
  readonly run: string;
  readonly since: string;
}

const isWriterClaim = (value: unknown): value is WriterClaim => {
  if (typeof value !== 'object' || value === null) return false;
  const claim = value as Record<string, unknown>;
  return (
    typeof claim['pid'] === 'number' &&
    typeof claim['host'] === 'string' &&
    typeof claim['run'] === 'string' &&
    typeof claim['since'] === 'string'
  );
};

/**
 * AD-29 — a second writer is refused, naming the holder. There is no fallback to unsynchronised
 * appends: a caller that cannot establish the claim does not write.
 *
 * The code is `engine.lock_held`, the AD-35 table's one lock-held code. No recorder-specific code is
 * declared yet, and inventing one here would be a contracts change this story's Code Map excludes.
 */
export class WriterConflictError extends Error {
  readonly code = 'engine.lock_held';
  readonly logPath: string;
  readonly holder: WriterClaim | null;

  constructor(logPath: string, holder: WriterClaim | null, detail: string) {
    super(
      `Refusing to open ${logPath} for append: ${detail}. ` +
        'AD-29 gives an events.jsonl exactly one writer and one seq assigner; ' +
        'every other producer emits through the holder.',
    );
    this.name = 'WriterConflictError';
    this.logPath = logPath;
    this.holder = holder;
  }
}

/** A submission that is not an AD-5 envelope. Rejected before any write; the file is unchanged. */
export class EventEnvelopeRejected extends Error {
  readonly fields: readonly string[];

  constructor(fields: readonly string[], detail: string) {
    super(
      `Refusing the event: ${detail}. ` +
        'AD-5 makes a missing or malformed declared field a rejection, while an unknown `type` is ' +
        'accepted — adding an event type is never breaking.',
    );
    this.name = 'EventEnvelopeRejected';
    this.fields = fields;
  }
}

/**
 * An existing log whose last line is not whole. AD-4 forbids mutating or rewriting a line, so the
 * recorder refuses the run rather than truncating the file: the corruption is reported, never
 * silently repaired.
 */
export class EventLogCorruptError extends Error {
  readonly code = 'internal.invariant_violated';
  readonly logPath: string;
  readonly line: number;

  constructor(logPath: string, line: number, detail: string) {
    super(
      `Refusing ${logPath}: line ${String(line)} ${detail}. ` +
        'AD-4 forbids mutating or rewriting an appended line, so this file is not repaired here.',
    );
    this.name = 'EventLogCorruptError';
    this.logPath = logPath;
    this.line = line;
  }
}

/** Raised at the boundary where a caller must be told its artifact was dropped (AD-21). */
export class RedactionFailedError extends Error {
  readonly code: string = REDACTION_FAILED_ERROR_CODE;
  readonly reason: string;

  constructor(failure: RedactionFailure) {
    super(
      `The artifact was dropped: redaction failed because ${failure.cause} (${failure.reason}). ` +
        'AD-21 fails closed; nothing unredacted is written and the triggering value is not reported.',
    );
    this.name = 'RedactionFailedError';
    this.reason = failure.reason;
  }
}

export interface RecorderOptions {
  /** The run id, minted by the engine (AD-29) and received here. */
  readonly runId: string;
  /** The feature slug the run belongs to, used for events the recorder originates itself. */
  readonly feature: string;
  /** `ORCH_HOME`; defaults to the AD-9 resolution. */
  readonly orchHome?: string;
  /** The AD-21 policy, including the literal values of injected credentials. */
  readonly redaction?: RedactionPolicy;
  /** Injectable clock, so a test can make `ts` disagree with `seq` on purpose. */
  readonly now?: () => Date;
  /** `fsync` after each append. On by default: the log is the durable truth. */
  readonly fsync?: boolean;
  /**
   * Reclaim a lock whose recorded pid is verifiably gone on this host (AD-30's rule, applied to the
   * log's claim). Never reclaims a live holder's lock.
   */
  readonly reclaimStaleLock?: boolean;
}

/** The in-process holders, keyed by resolved log path. */
const IN_PROCESS_HOLDERS = new Map<string, WriterClaim>();

const parseJson = (text: string): unknown => JSON.parse(text) as unknown;

/** True when a pid is running on this host. A pid that is gone can have its lock reclaimed. */
const pidIsAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (thrown: unknown) {
    // EPERM means the process exists but belongs to another user.
    return (thrown as { code?: string } | null)?.code === 'EPERM';
  }
};

const readClaim = (lockPath: string): WriterClaim | null => {
  try {
    const parsed = parseJson(readFileSync(lockPath, 'utf8'));
    return isWriterClaim(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

const describeHolder = (holder: WriterClaim | null): string =>
  holder === null
    ? 'the claim is held by an unreadable lock file'
    : `the claim is held by pid ${String(holder.pid)} on ${holder.host} since ${holder.since}`;

/** Parse whole lines into envelopes, refusing any line that is not one (AD-5). */
const parseEventLines = (logPath: string, lines: readonly string[]): EventEnvelope[] =>
  lines.map((line, index) => {
    let parsed: unknown;
    try {
      parsed = parseJson(line);
    } catch {
      throw new EventLogCorruptError(logPath, index + 1, 'is not whole JSON');
    }
    const result = EventEnvelopeSchema.safeParse(parsed);
    if (!result.success) {
      throw new EventLogCorruptError(logPath, index + 1, 'is not an AD-5 envelope');
    }
    return result.data;
  });

/**
 * Read back the appended lines. A reader orders by `seq` and ignores an unknown `type` rather than
 * erroring (AD-5); a line that is not whole JSON, or is not an envelope, is a corruption report.
 */
export const readEventLog = (logPath: string): EventEnvelope[] => {
  if (!existsSync(logPath)) return [];
  const text = readFileSync(logPath, 'utf8');
  if (text === '') return [];
  const lines = text.split('\n');
  const trailing = lines.pop();
  if (trailing !== '') {
    throw new EventLogCorruptError(logPath, lines.length + 1, 'is not terminated by a newline');
  }
  return parseEventLines(logPath, lines);
};

/** What {@link readCompleteEventLines} found: the whole lines, and whether one was still arriving. */
export interface CompleteEventLines {
  readonly events: EventEnvelope[];
  /**
   * True when the file's final line had no newline yet — an append in progress, not a corruption.
   *
   * The distinction matters to a reader that is not the recorder: a renderer polls this file while the
   * recorder appends to it, so meeting a half-written final line is an ordinary race rather than a fault.
   */
  readonly incompleteTail: boolean;
}

/**
 * Read the lines that are whole, and report separately that the last one was not.
 *
 * The same race the engine's intent reader was given `TORN_INTENT_GRACE_MS` for, met from the reading
 * side: AD-4 makes the log the sole durable truth and every renderer a projection of it, and a renderer
 * polls the file the recorder appends to. A line without its newline is a line mid-`write`, and every
 * line before it is complete and immutable (AD-4 forbids mutating an appended line) — so the honest
 * reading of a torn tail is "everything up to here, and one more is arriving", not "this file cannot be
 * read".
 *
 * Only the *unterminated last line* is tolerated. A complete line that is not whole JSON or not an AD-5
 * envelope still throws, because no writer produces one of those in the ordinary course and a reader
 * that swallowed it would hide real corruption.
 */
export const readCompleteEventLines = (logPath: string): CompleteEventLines => {
  if (!existsSync(logPath)) return { events: [], incompleteTail: false };
  const text = readFileSync(logPath, 'utf8');
  if (text === '') return { events: [], incompleteTail: false };
  const lines = text.split('\n');
  const trailing = lines.pop();
  return {
    events: parseEventLines(logPath, lines),
    incompleteTail: trailing !== '',
  };
};

/**
 * The `seq` the next append takes, given a log that may already hold lines.
 *
 * The acceptance criterion is `1..n` with no gaps, so line *i* must carry seq *i*. That one check
 * covers a repeat, a gap and a seq below `FIRST_SEQ` alike: each is something one assigner cannot
 * have produced, so the run is refused rather than continued from a number that would cement it.
 */
const scanForNextSeq = (logPath: string): number => {
  const existing = readEventLog(logPath);
  for (const [index, event] of existing.entries()) {
    const expected = FIRST_SEQ + index;
    if (event.seq !== expected) {
      throw new EventLogCorruptError(
        logPath,
        index + 1,
        `carries seq ${String(event.seq)} where ${String(expected)} was expected — one assigner ` +
          'produces 1..n with no gaps and no repeats',
      );
    }
  }
  return FIRST_SEQ + existing.length;
};

/** What one append put on disk: the line as written, and whether it replaced the submitted one. */
interface AppendOutcome {
  readonly event: EventEnvelope;
  readonly substituted: boolean;
}

/** What `record` did with a submission. */
export interface RecordedEvent {
  readonly event: EventEnvelope;
  /** True when the submitted artifact was dropped and `redaction.failed` was appended instead. */
  readonly dropped: boolean;
}

/** A step name safe to carry on a recorder-originated event without trusting the producer. */
const SAFE_STEP_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** A type name safe to name as the dropped artifact's type. Anything else is reported as null. */
const SAFE_TYPE_NAME = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*$/;

export class Recorder {
  readonly paths: RunPaths;
  readonly feature: string;
  readonly redactor: Redactor;

  private readonly fd: number;
  private readonly claim: WriterClaim;
  private readonly now: () => Date;
  private readonly fsyncEachAppend: boolean;
  private nextSeq: number;
  private closed = false;

  private constructor(
    paths: RunPaths,
    feature: string,
    fd: number,
    claim: WriterClaim,
    nextSeq: number,
    redactor: Redactor,
    now: () => Date,
    fsyncEachAppend: boolean,
  ) {
    this.paths = paths;
    this.feature = feature;
    this.fd = fd;
    this.claim = claim;
    this.nextSeq = nextSeq;
    this.redactor = redactor;
    this.now = now;
    this.fsyncEachAppend = fsyncEachAppend;
  }

  /**
   * Claim sole writership of `runs/<run-id>/events.jsonl` and open it for append.
   *
   * The claim is an exclusively-created lock file recording pid, host and start time. A second
   * recorder — in this process or another — is refused naming the holder, and the log is never
   * opened for append twice.
   *
   * The claim is published whole, by {@link createFileExclusively}: the create and the content are one
   * step, so a second recorder that loses the race always reads a claim it can name the holder of
   * rather than a file that exists and says nothing.
   */
  static open(options: RecorderOptions): Recorder {
    const paths = runPaths(options.runId, options.orchHome);
    mkdirSync(paths.runDir, { recursive: true });

    const held = IN_PROCESS_HOLDERS.get(paths.eventLog);
    if (held !== undefined) {
      throw new WriterConflictError(
        paths.eventLog,
        held,
        `${describeHolder(held)} in this same process`,
      );
    }

    const claim: WriterClaim = {
      pid: process.pid,
      host: hostname(),
      run: paths.runId,
      // The claim's own timestamp is diagnostic and comes from the wall clock; the injectable
      // clock belongs to the events, where `ts` is a declared field.
      since: formatTimestamp(),
    };

    const claimLine = `${JSON.stringify(claim)}\n`;
    if (!createFileExclusively(paths.eventLogLock, claimLine)) {
      // Losing the create is the only thing that means another writer holds the log. Every other
      // failure — EACCES, ENOSPC, EROFS, ENOTDIR — throws out of the create, because reporting one of
      // them as "an unreadable lock file" would hide the real fault behind the wrong advice.
      const existing = readClaim(paths.eventLogLock);
      const reclaimable =
        (options.reclaimStaleLock ?? true) &&
        existing !== null &&
        existing.host === claim.host &&
        existing.pid !== process.pid &&
        !pidIsAlive(existing.pid);
      if (!reclaimable) {
        throw new WriterConflictError(
          paths.eventLog,
          existing,
          `${describeHolder(existing)}${existing !== null && pidIsAlive(existing.pid) ? ' and that process is alive' : ''}`,
        );
      }
      // AD-30's rule: a stale claim is reclaimed only once the recorded pid is verifiably gone.
      unlinkSync(paths.eventLogLock);
      if (!createFileExclusively(paths.eventLogLock, claimLine)) {
        throw new WriterConflictError(
          paths.eventLog,
          readClaim(paths.eventLogLock),
          'the claim was taken while a stale lock was being reclaimed',
        );
      }
    }

    let nextSeq: number;
    let fd: number;
    try {
      nextSeq = scanForNextSeq(paths.eventLog);
      fd = openSync(paths.eventLog, 'a');
    } catch (thrown: unknown) {
      unlinkSync(paths.eventLogLock);
      throw thrown;
    }

    IN_PROCESS_HOLDERS.set(paths.eventLog, claim);
    return new Recorder(
      paths,
      options.feature,
      fd,
      claim,
      nextSeq,
      createRedactor(options.redaction ?? {}),
      options.now ?? ((): Date => new Date()),
      options.fsync ?? true,
    );
  }

  /** Who holds this run's log. */
  get holder(): WriterClaim {
    return this.claim;
  }

  /** The `seq` the next append will take. Exposed for assertions, never for assignment. */
  get seqOfNextAppend(): number {
    return this.nextSeq;
  }

  get logPath(): string {
    return this.paths.eventLog;
  }

  /**
   * Assign `seq`, validate, redact and append one line.
   *
   * Returns the envelope as written. When redaction fails the submitted artifact is dropped and a
   * `redaction.failed` event is appended in its place; the returned `dropped` flag says so, and the
   * returned event carries no part of the triggering value.
   */
  recordResult(submission: unknown): RecordedEvent {
    this.assertOpen();
    const seq = this.nextSeq;
    const candidate = this.envelopeFor(submission, seq);

    let redacted;
    try {
      redacted = this.redactor.redact(candidate);
    } catch (thrown: unknown) {
      // The pass is meant to return a failure rather than throw; a throw is still a failure.
      redacted = {
        ok: false as const,
        reason: 'redactor-threw' as const,
        cause: describeThrown(thrown, this.redactor.secrets),
      };
    }

    if (!redacted.ok) {
      return { event: this.appendRedactionFailure(seq, candidate, redacted), dropped: true };
    }

    /**
     * The verbatim allow-list of {@link EVENT_ENVELOPE_VERBATIM_FIELDS}, restored from the
     * submission after the pass. Every entry is an identifier the system reads back — the run, the
     * feature, the step, the AD-26 baseline ref and the two AD-5 stream fields — and each is
     * restored only when the original is proven free of every credential class. A stream field that
     * fails the proof fails the whole artifact closed, because AD-5 admits no rewritten value; an
     * identity field keeps what the pass produced, so a line is still written.
     */
    const preserved = this.preservePassthrough(candidate, redacted.value);
    if (preserved === null) {
      return {
        event: this.appendRedactionFailure(seq, candidate, {
          ok: false,
          reason: 'passthrough-carries-secret',
          cause: 'a stream passthrough field carried a registered credential',
        }),
        dropped: true,
      };
    }

    /**
     * Story 3-3 — the payload-scoped counterpart to the restore just above. `preservePassthrough` only
     * ever reaches the envelope's own top-level keys; a commit SHA nested under a payload key (`pull_
     * request.merge_fidelity`'s `head_ref_oid`/`merge_commit`) needs its own restore, over
     * `EVENT_PAYLOAD_VERBATIM_FIELDS`, or it is silently destroyed by the entropy sweep with nothing here
     * to rescue it.
     */
    const preservedWithPayload = this.preservePassthroughPayload(candidate, preserved);

    // The envelope is re-validated after redaction: the pass may not turn a valid line invalid.
    const reparsed = EventEnvelopeSchema.safeParse(preservedWithPayload);
    if (!reparsed.success) {
      return {
        event: this.appendRedactionFailure(seq, candidate, {
          ok: false,
          reason: 'redactor-threw',
          cause: 'the redacted artifact was no longer a valid envelope',
        }),
        dropped: true,
      };
    }

    const appended = this.append(reparsed.data);
    // `dropped` describes the line on disk, not the intent: the last gate can still have replaced it.
    return { event: appended.event, dropped: appended.substituted };
  }

  /**
   * Restore the {@link EVENT_ENVELOPE_VERBATIM_FIELDS} allow-list, or refuse the artifact.
   *
   * Each original is run back through every pattern class — registered literals, token prefixes,
   * private keys, URL credentials, env assignments — and a value the pass would have changed is not
   * restored. Only the high-entropy heuristic is excluded, because it is a guess about shape and
   * condemns exactly the identifiers the log must carry: an unbroken ULID run id, a commit SHA and a
   * `claude` session id all read as secret material to it.
   *
   * This is an allow-list by *field path*, which is the fix story 1-2 named for the case where
   * reconstruction needs an identifier back — never a shape exemption, which is what let a real
   * credential through there.
   */
  private preservePassthrough(
    candidate: EventEnvelope,
    redacted: EventEnvelope,
  ): EventEnvelope | null {
    const restored: Record<string, unknown> = { ...redacted };
    for (const field of EVENT_ENVELOPE_VERBATIM_FIELDS) {
      const original = candidate[field];
      if (original === undefined) continue;
      const verbatimOrDropped = (EVENT_ENVELOPE_STREAM_FIELDS as readonly string[]).includes(field);

      if (typeof original === 'string') {
        if (!this.redactor.provesPatternFree(original)) {
          // AD-5 leaves a stream field no third option: it is verbatim or the artifact is dropped.
          if (verbatimOrDropped) return null;
          // An identity field keeps what the pass produced. The fail-safe direction is a line whose
          // `step` reads `[redacted]`, not a run with no line at all.
          continue;
        }
        // Proven free of every *pattern* class is not enough on its own: the proof runs with the
        // entropy heuristic off, so an unknown-format high-entropy secret would pass it. An identity
        // field is restored only when the value is the identifier the field claims to hold, checked
        // against a fixed-length restricted alphabet no credential format satisfies.
        if (!verbatimOrDropped && !hasEventIdentityShape(field, original)) continue;
      }

      restored[field] = original;
    }
    return restored as EventEnvelope;
  }

  /**
   * Story 3-3 — restore {@link EVENT_PAYLOAD_VERBATIM_FIELDS} inside `payload`, the payload-scoped
   * counterpart to {@link preservePassthrough}.
   *
   * Same discipline, one field narrower: a candidate value is restored only when it is a string, proven
   * free of every pattern class, and shaped exactly like the *one* identity shape that field is declared
   * to hold — a commit SHA for `head_ref_oid`/`merge_commit`, a ULID for story 4-3's own `forked_run`
   * (`run.forked` carries a *second*, different run's id in its payload, because the envelope's own `run`
   * field already means this line's own run). `hasEventIdentityShape` is the exact function
   * {@link preservePassthrough} already tests an envelope field's shape with — reused here rather than a
   * second copy, so a payload field and an envelope field are proven safe the same way.
   *
   * **Never "any declared shape passes for any field."** An earlier draft checked each candidate against
   * every shape in `EVENT_ENVELOPE_IDENTITY_SHAPES`, which would have let a ULID-shaped value survive
   * redaction under `head_ref_oid`/`merge_commit` — fields that should only ever hold a commit SHA. Still
   * caught by `provesPatternFree` if it were a real secret, but a real loss of field-specific precision;
   * `EVENT_PAYLOAD_VERBATIM_FIELDS`'s own map is what pins each field to the one shape it may be restored
   * as. Never verbatim-or-dropped: unlike the two AD-5 stream fields, a payload field that fails the proof
   * simply keeps whatever the pass produced — there is no "drop the whole artifact" case for a payload
   * key, the same fail-safe direction the envelope's own identity fields already take.
   */
  private preservePassthroughPayload(
    candidate: EventEnvelope,
    redacted: EventEnvelope,
  ): EventEnvelope {
    const candidatePayload = candidate.payload;
    const restoredPayload: Record<string, unknown> = { ...redacted.payload };
    for (const [field, shape] of Object.entries(EVENT_PAYLOAD_VERBATIM_FIELDS)) {
      const original = candidatePayload[field];
      if (typeof original !== 'string') continue;
      if (!this.redactor.provesPatternFree(original)) continue;
      if (!hasEventIdentityShape(shape, original)) continue;
      restoredPayload[field] = original;
    }
    return { ...redacted, payload: restoredPayload };
  }

  /**
   * A recorder-owned identity field, proven safe or replaced by a fixed placeholder.
   *
   * `feature`, `run` and `step` are written onto the `redaction.failed` line without having been
   * through the pass — that line is built here, not submitted — so the line reporting a failure could
   * otherwise carry the very secret that caused it.
   */
  private safeIdentity(value: string): string {
    return this.redactor.provesPatternFree(value) ? value : REDACTION_MARKER;
  }

  /** The common path: append and hand back the line as written. */
  record(submission: unknown): EventEnvelope {
    return this.recordResult(submission).event;
  }

  /**
   * Append `redaction.failed` in place of an artifact that failed the pass, for a caller that holds
   * the artifact rather than an envelope (the fetch record does).
   */
  recordRedactionFailure(
    failure: RedactionFailure,
    context: { readonly step?: string | null; readonly droppedType?: string } = {},
  ): EventEnvelope {
    this.assertOpen();
    const seq = this.nextSeq;
    return this.appendRedactionFailure(seq, null, failure, context);
  }

  /** Release the claim. The log itself is never rewritten, compacted or deleted. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    closeSync(this.fd);
    IN_PROCESS_HOLDERS.delete(this.paths.eventLog);
    try {
      // Only this recorder's own claim is released. Once another recorder has reclaimed a stale
      // lock, the file describes *that* holder, and deleting it would strip a live writer's claim.
      const held = readClaim(this.paths.eventLogLock);
      if (held !== null && held.pid === this.claim.pid && held.host === this.claim.host) {
        unlinkSync(this.paths.eventLogLock);
      }
    } catch {
      // A lock file that cannot be removed is reclaimed by the pid-liveness check on next open.
    }
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new WriterConflictError(
        this.paths.eventLog,
        this.claim,
        'this recorder has released its claim',
      );
    }
  }

  /** Build the envelope: the recorder's `seq`, the producer's fields, a `ts` if none was given. */
  private envelopeFor(submission: unknown, seq: number): EventEnvelope {
    if (typeof submission !== 'object' || submission === null || Array.isArray(submission)) {
      throw new EventEnvelopeRejected(
        ['(root)'],
        'an event must be a JSON object carrying the AD-5 envelope fields',
      );
    }
    const fields = { ...(submission as Record<string, unknown>) };
    if (!('ts' in fields) || fields['ts'] === undefined) {
      fields['ts'] = formatTimestamp(this.now());
    }
    if ('seq' in fields && fields['seq'] !== seq && fields['seq'] !== undefined) {
      throw new EventEnvelopeRejected(
        ['seq'],
        'seq is assigned by the recorder alone (AD-29) and may not be submitted',
      );
    }
    fields['seq'] = seq;

    // AD-4 makes this file the truth about *this* run, so a producer may not name another one: a
    // foreign `run` would put a line about someone else's run into the file that *is* this run's
    // truth. Absence stays a rejection by the envelope itself, naming the field.
    for (const [field, owned] of [
      ['run', this.paths.runId],
      ['feature', this.feature],
    ] as const) {
      const submitted = fields[field];
      if (submitted !== undefined && submitted !== owned) {
        throw new EventEnvelopeRejected(
          [field],
          `${field} is ${JSON.stringify(submitted)} but this recorder holds "${owned}"; ` +
            'the recorder owns the identity of the log it appends to',
        );
      }
    }

    const result = EventEnvelopeSchema.safeParse(fields);
    if (!result.success) {
      const offending = result.error.issues.map((issue) =>
        issue.path.length === 0 ? '(root)' : issue.path.map((part) => String(part)).join('.'),
      );
      const detail = result.error.issues
        .map((issue, index) => `${offending[index] ?? '(root)'} is ${issue.code}`)
        .join('; ');
      throw new EventEnvelopeRejected(offending, detail);
    }
    return result.data;
  }

  /**
   * The `redaction.failed` line. Every field on it is either recorder-owned or proven safe:
   *
   * - `feature` and `run` come from the recorder's own construction, not from the submission;
   * - `step` is carried only when the submitted value is a plain identifier;
   * - `payload` names the reason and a value-free cause, and never a length, hash or fragment of the
   *   value that triggered the failure.
   */
  private appendRedactionFailure(
    seq: number,
    candidate: EventEnvelope | null,
    failure: RedactionFailure,
    context: { readonly step?: string | null; readonly droppedType?: string } = {},
  ): EventEnvelope {
    const submittedStep = context.step ?? candidate?.step ?? null;
    const step =
      typeof submittedStep === 'string' &&
      SAFE_STEP_NAME.test(submittedStep) &&
      this.redactor.provesPatternFree(submittedStep)
        ? submittedStep
        : null;
    const submittedType = context.droppedType ?? candidate?.type ?? null;
    const droppedType =
      typeof submittedType === 'string' &&
      SAFE_TYPE_NAME.test(submittedType) &&
      submittedType.length <= 64 &&
      this.redactor.provesPatternFree(submittedType)
        ? submittedType
        : null;

    const event: EventEnvelope = {
      ts: formatTimestamp(this.now()),
      seq,
      feature: this.safeIdentity(this.feature),
      run: this.safeIdentity(this.paths.runId),
      step,
      emitter: RECORDER_EMITTER,
      type: REDACTION_FAILED_EVENT_TYPE,
      payload: {
        reason: failure.reason,
        cause: failure.cause,
        dropped_event_type: droppedType,
        disposition: redactionFailedDisposition(),
        detail:
          'The artifact was dropped before any append. AD-21 fails closed and records no part of ' +
          'the value that triggered the failure.',
      },
    };
    return this.append(event).event;
  }

  /**
   * One whole line, appended in one write.
   *
   * The line is serialised first, checked to contain no newline of its own and no registered
   * credential, and only then written: the buffer handed to `write` already ends in the newline, so
   * an interrupted process leaves whole lines and never a torn trailing one. A short write is
   * resumed from its offset rather than retried from the start, which would duplicate a prefix.
   */
  private append(event: EventEnvelope): AppendOutcome {
    const serialised = JSON.stringify(event);
    if (serialised.includes('\n')) {
      // Unreachable through JSON.stringify, which escapes newlines; asserted rather than assumed,
      // because a torn line is permanent corruption of the durable truth.
      throw new EventLogCorruptError(this.paths.eventLog, this.nextSeq, 'would contain a newline');
    }

    let lineEvent = event;
    let substituted = false;
    let safe = serialised;
    if (!this.redactor.provesFree(serialised)) {
      // The bytes still carry a registered literal, so the line is replaced wholesale rather than
      // trusted. The substitute is validated like any other line and proven in turn: if even it
      // carries the literal, nothing is written at all.
      lineEvent = EventEnvelopeSchema.parse(this.minimalFailureLine(event.seq));
      safe = JSON.stringify(lineEvent);
      substituted = true;
      if (!this.redactor.provesFree(safe)) {
        throw new EventLogCorruptError(
          this.paths.eventLog,
          event.seq,
          'could not be written free of a registered credential, so nothing was appended',
        );
      }
    }

    const buffer = Buffer.from(`${safe}\n`, 'utf8');
    let written = 0;
    while (written < buffer.length) {
      written += writeSync(this.fd, buffer, written, buffer.length - written);
    }
    if (this.fsyncEachAppend) {
      try {
        // Durability of the truth outranks append throughput for a local, single-run tool.
        fsyncSync(this.fd);
      } catch {
        // A filesystem that refuses fsync does not make the written line less whole.
      }
    }
    this.nextSeq = event.seq + 1;
    return { event: lineEvent, substituted };
  }

  /**
   * The last gate: a line that still carries a registered credential is replaced wholesale by a
   * `redaction.failed` line carrying nothing from it. Reaching here means the pass missed something,
   * so the line is dropped rather than trusted.
   */
  private minimalFailureLine(seq: number): EventEnvelope {
    return {
      ts: formatTimestamp(this.now()),
      seq,
      feature: this.safeIdentity(this.feature),
      run: this.safeIdentity(this.paths.runId),
      step: null,
      emitter: RECORDER_EMITTER,
      type: REDACTION_FAILED_EVENT_TYPE,
      payload: {
        reason: 'secret-survived-serialisation',
        cause: 'a registered credential was still present after the pass',
        dropped_event_type: null,
        disposition: redactionFailedDisposition(),
        marker: REDACTION_MARKER,
      },
    };
  }
}

/** A convenience for a reader asserting the whole-lines-only property of AD-4. */
export const isWholeLineTerminated = (text: string): boolean => text === '' || text.endsWith('\n');
