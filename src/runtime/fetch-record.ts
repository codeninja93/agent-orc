/**
 * AD-13 / AD-14 — the run shared fetch record.
 *
 * Every external read is recorded, through the AD-21 pass, to both `events.jsonl` (as
 * `fetch.recorded`) and `runs/<run-id>/fetch-record.json`. A request already present is served from
 * the record and the domain is not contacted, so within one run an external record has exactly one
 * value and a re-run is deterministic.
 *
 * The record is written by whoever holds the run's log: a `Recorder` is required rather than a path,
 * which makes the AD-29 single-writer claim cover this artifact too. Writes are atomic — a temporary
 * file in the same directory, then a rename — per the Consistency Conventions.
 */
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

import {
  CURRENT_SCHEMA_VERSION,
  renderCause,
  FETCH_RECORD_CONTRACT_ID,
  FetchRecordSchema,
  emptyFetchRecord,
  fetchRequestKey,
  findFetchRecordEntry,
  formatTimestamp,
  parseVersionedArtifact,
} from '../contracts/index.js';
import type { FetchRecord, FetchRecordEntry, FetchRequest, FetchResponse } from '../contracts/index.js';

import { FETCH_RECORD_FILE_NAME } from './paths.js';
import { RedactionFailedError } from './recorder.js';
import type { Recorder } from './recorder.js';

/** A record file belonging to another run. Serving it would make this run's replay someone else's. */
export class ForeignFetchRecordError extends Error {
  readonly code = 'config.invalid';
  readonly expectedRun: string;
  readonly foundRun: string;

  constructor(path: string, expectedRun: string, foundRun: string) {
    super(
      `Refusing ${path}: it records run "${foundRun}" but this is run "${expectedRun}". ` +
        'AD-14 scopes a fetch record to one run; a record copied from another run is not this ' +
        "run's evidence and is never served as if it were.",
    );
    this.name = 'ForeignFetchRecordError';
    this.expectedRun = expectedRun;
    this.foundRun = foundRun;
  }
}

/** Where a served value came from. A re-run of a recorded read never says `domain`. */
export const FETCH_SOURCES = ['domain', 'record'] as const;

export type FetchSource = (typeof FETCH_SOURCES)[number];

export interface ServedFetch {
  readonly entry: FetchRecordEntry;
  readonly response: FetchResponse;
  readonly source: FetchSource;
}

export interface RunFetchRecordOptions {
  /** The holder of the run's log; its claim covers this artifact and its redactor is shared. */
  readonly recorder: Recorder;
  /** The step attributed with a first fetch, or null for a run-level read. */
  readonly step?: string | null;
}

const parseJson = (text: string): unknown => JSON.parse(text) as unknown;

/** The temporary-file shape `write` uses, so a crashed write can be swept rather than left forever. */
const TEMPORARY_SUFFIX = '.tmp';

/** Remove temporary files a crashed write left behind. A rename is atomic, so a leftover is debris. */
const sweepStaleTemporaries = (directory: string): void => {
  try {
    for (const name of readdirSync(directory)) {
      if (name.startsWith(`${FETCH_RECORD_FILE_NAME}.`) && name.endsWith(TEMPORARY_SUFFIX)) {
        unlinkSync(join(directory, name));
      }
    }
  } catch {
    // Debris that cannot be removed is harmless: the next write picks its own temporary name.
  }
};

/** Flush a file or directory entry to disk, ignoring a filesystem that refuses the request. */
const fsyncPath = (path: string): void => {
  let fd: number | null = null;
  try {
    fd = openSync(path, 'r');
    fsyncSync(fd);
  } catch {
    // Durability is best-effort here; atomicity comes from the rename and does not depend on it.
  } finally {
    if (fd !== null) closeSync(fd);
  }
};

/** Read the record through the AD-28 version gate and the AD-14 run-identity check. */
const readRecordFile = (path: string, expectedRun: string): FetchRecord => {
  const parsed = parseVersionedArtifact(
    FetchRecordSchema,
    parseJson(readFileSync(path, 'utf8')),
    FETCH_RECORD_FILE_NAME,
  );
  if (parsed.run !== expectedRun) {
    throw new ForeignFetchRecordError(path, expectedRun, parsed.run);
  }
  return parsed;
};

export class RunFetchRecord {
  readonly path: string;
  private readonly recorder: Recorder;
  private readonly step: string | null;
  private record: FetchRecord;

  private constructor(recorder: Recorder, step: string | null, record: FetchRecord) {
    this.recorder = recorder;
    this.step = step;
    this.record = record;
    this.path = recorder.paths.fetchRecord;
  }

  /**
   * Load the run's record, or start an empty one.
   *
   * An existing file is parsed through the AD-28 gate: an unrecognised `schema_version` is refused,
   * naming the installer version that wrote it, and never silently upgraded.
   */
  static open(options: RunFetchRecordOptions): RunFetchRecord {
    const { recorder } = options;
    mkdirSync(recorder.paths.runDir, { recursive: true });
    const path = recorder.paths.fetchRecord;
    const step = options.step ?? null;
    sweepStaleTemporaries(recorder.paths.runDir);

    if (!existsSync(path)) {
      return new RunFetchRecord(
        recorder,
        step,
        emptyFetchRecord(recorder.paths.runId, CURRENT_SCHEMA_VERSION),
      );
    }
    const parsed = readRecordFile(path, recorder.paths.runId);
    return new RunFetchRecord(recorder, step, parsed);
  }

  /** The contract id this artifact is registered under (AD-17). */
  static readonly contractId: string = FETCH_RECORD_CONTRACT_ID;

  /**
   * The key for a request, derived from the *redacted* request — the same one the record stores.
   *
   * Keying the raw request would make the stored key unre-derivable: a later reader holding an entry
   * could not compute its key from `entry.request` and so could not verify or rebuild the record.
   * A request whose parameters carry a credential is therefore keyed by its redacted form, which is
   * also the only form that ever reaches disk.
   */
  keyFor(request: FetchRequest): string {
    return fetchRequestKey(this.redactRequest(request));
  }

  /** What the record holds for a request, or null when the domain has not been contacted for it. */
  lookup(request: FetchRequest): FetchRecordEntry | null {
    return findFetchRecordEntry(this.record, this.keyFor(request));
  }

  /**
   * The request as it will be stored and keyed. A request that cannot be redacted is dropped, not
   * looked up: AD-21 has no partial outcome, and a key over a value that may not be written is not
   * a key at all.
   */
  private redactRequest(request: FetchRequest): FetchRequest {
    const redacted = this.recorder.redactor.redact(request);
    if (!redacted.ok) {
      this.recorder.recordRedactionFailure(redacted, {
        step: this.step,
        droppedType: 'fetch.recorded',
      });
      throw new RedactionFailedError(redacted);
    }
    return redacted.value;
  }

  /** Every recorded read of this run, in the order the domain was contacted. */
  get entries(): readonly FetchRecordEntry[] {
    return this.record.entries;
  }

  /**
   * Serve a request: from the record when it is already recorded, otherwise by performing the read
   * and recording it.
   *
   * `perform` is not called for a request already in the record — that is the AD-14 guarantee, and
   * the reason this method exists rather than a bare `record`.
   */
  async serve(
    request: FetchRequest,
    perform: () => Promise<FetchResponse> | FetchResponse,
  ): Promise<ServedFetch> {
    const recorded = this.lookup(request);
    if (recorded !== null) {
      this.emitRecorded(recorded, 'record');
      return { entry: recorded, response: recorded.response, source: 'record' };
    }
    let response: FetchResponse;
    try {
      response = await perform();
    } catch (thrown: unknown) {
      // AD-13 records *every* external read, and a read that failed is a read: the failure is
      // recorded as an `ok: false` value and emitted, then handed back to the caller unchanged.
      this.put(request, {
        ok: false,
        status: null,
        body: { error: renderCause(thrown) },
      });
      throw thrown;
    }
    const entry = this.put(request, response);
    return { entry, response: entry.response, source: 'domain' };
  }

  /**
   * Record a request and its response, through redaction.
   *
   * On a redaction failure nothing is written to the record, a `redaction.failed` event is appended
   * in the artifact's place, and the caller is told by exception: AD-21 has no partial outcome. A key
   * already present keeps its first value — within one run an external record has exactly one value.
   */
  put(request: FetchRequest, response: FetchResponse): FetchRecordEntry {
    const redactedRequest = this.redactRequest(request);
    const key = fetchRequestKey(redactedRequest);
    const existing = findFetchRecordEntry(this.record, key);
    if (existing !== null) {
      this.emitRecorded(existing, 'record');
      return existing;
    }

    const redacted = this.recorder.redactor.redact(response);
    if (!redacted.ok) {
      this.recorder.recordRedactionFailure(redacted, {
        step: this.step,
        droppedType: 'fetch.recorded',
      });
      throw new RedactionFailedError(redacted);
    }

    const entry: FetchRecordEntry = {
      key,
      request: redactedRequest,
      response: redacted.value,
      recorded_at: formatTimestamp(),
      recorded_by_step: this.step,
    };

    // Re-read immediately before writing, so a second live instance's entries are not clobbered by
    // this one's snapshot. The first recorded value for a key still wins — AD-14 gives one run one
    // value per record, whichever instance got there first.
    this.record = this.reload();
    const already = findFetchRecordEntry(this.record, key);
    if (already !== null) {
      this.emitRecorded(already, 'record');
      return already;
    }

    const next: FetchRecord = {
      ...this.record,
      entries: [...this.record.entries, entry],
    };
    // Parse before writing: the artifact on disk is always one this build would accept reading.
    this.record = FetchRecordSchema.parse(next);
    this.write();
    this.emitRecorded(entry, 'domain');
    return entry;
  }

  /**
   * AD-4 — the event log carries the same read the record does. The payload names the key and the
   * request as redacted, never the response body: the body is evidence plane (AD-23) and lives in
   * the record, referenced from the log by key.
   */
  private emitRecorded(entry: FetchRecordEntry, source: FetchSource): void {
    this.recorder.record({
      feature: this.recorder.feature,
      run: this.recorder.paths.runId,
      step: this.step,
      emitter: 'runtime.fetch-record',
      type: 'fetch.recorded',
      payload: {
        key: entry.key,
        domain: entry.request.domain,
        operation: entry.request.operation,
        source,
        ok: entry.response.ok,
        status: entry.response.status,
        recorded_at: entry.recorded_at,
        record: FETCH_RECORD_FILE_NAME,
      },
    });
  }

  /** What the file holds right now, or an empty record when there is no file yet. */
  private reload(): FetchRecord {
    if (!existsSync(this.path)) {
      return emptyFetchRecord(this.recorder.paths.runId, CURRENT_SCHEMA_VERSION);
    }
    return readRecordFile(this.path, this.recorder.paths.runId);
  }

  /**
   * Atomic and durable: a temporary file in the same directory, fsynced, then renamed, then the
   * directory itself fsynced so the rename survives a crash. The event log fsyncs each append for
   * the same reason; a record that is atomic but not durable can still vanish after a power loss.
   */
  private write(): void {
    const directory = this.recorder.paths.runDir;
    const temporary = join(directory, `${FETCH_RECORD_FILE_NAME}.${String(process.pid)}.tmp`);
    try {
      writeFileSync(temporary, `${JSON.stringify(this.record, null, 2)}\n`, 'utf8');
      fsyncPath(temporary);
      renameSync(temporary, this.path);
      fsyncPath(directory);
    } catch (thrown: unknown) {
      if (existsSync(temporary)) {
        try {
          unlinkSync(temporary);
        } catch {
          // The temporary file is in the run directory and is overwritten by the next attempt.
        }
      }
      throw thrown;
    }
  }
}
