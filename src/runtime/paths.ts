/**
 * AD-9 — the on-disk layout of runtime state, owned in one place.
 *
 * All runtime state lives under `ORCH_HOME`, defaulting to `~/.orch`. Every later story asks this
 * module where a run lives rather than joining path segments of its own, so two units cannot
 * disagree about the location of an `events.jsonl`.
 *
 * Path construction only: nothing here creates, reads or writes a file, and nothing here decides
 * policy. The single exception to "no logic" is segment validation — a run id is minted by the
 * engine (AD-29) and arrives here as data, so a segment that could escape the run directory is
 * refused by name rather than silently resolved.
 */
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

/** The environment variable AD-9 names. */
export const ORCH_HOME_ENV_VAR = 'ORCH_HOME';

/** The directory name of the AD-9 default, `~/.orch`. */
export const DEFAULT_ORCH_HOME_DIR_NAME = '.orch';

/** The AD-9 default `ORCH_HOME`, `~/.orch`. */
export const defaultOrchHome = (): string => join(homedir(), DEFAULT_ORCH_HOME_DIR_NAME);

/**
 * A path segment safe to place under `ORCH_HOME`: no separator, no `.` or `..`, no leading dash or
 * whitespace. A ULID run id satisfies it; so does a kebab-case feature slug.
 */
export const SAFE_PATH_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Refusal to build a path from a segment that could escape the directory it belongs under. */
export class UnsafePathSegmentError extends Error {
  readonly segment: string;
  readonly role: string;

  constructor(segment: string, role: string) {
    super(
      `Refusing to build a path from ${role} "${segment}": a path segment must match ` +
        `${String(SAFE_PATH_SEGMENT)} so it cannot escape ORCH_HOME. ` +
        'Run ids are ULIDs minted by the engine (AD-29) and reach the runtime as data.',
    );
    this.name = 'UnsafePathSegmentError';
    this.segment = segment;
    this.role = role;
  }
}

/** Return the segment unchanged, or refuse it by name. */
export const assertSafePathSegment = (segment: string, role: string): string => {
  if (segment === '..' || segment === '.' || !SAFE_PATH_SEGMENT.test(segment)) {
    throw new UnsafePathSegmentError(segment, role);
  }
  return segment;
};

/**
 * Resolve `ORCH_HOME`: the environment variable when it carries a non-blank value, else `~/.orch`.
 * A relative value is resolved against the current working directory, so every consumer sees one
 * absolute path for one configured home.
 */
export const resolveOrchHome = (env: NodeJS.ProcessEnv = process.env): string => {
  const declared = env[ORCH_HOME_ENV_VAR];
  if (declared === undefined || declared.trim() === '') return defaultOrchHome();
  return isAbsolute(declared) ? declared : resolve(declared);
};

/** The four top-level directories AD-9 places under `ORCH_HOME`. */
export const runsDir = (orchHome: string = resolveOrchHome()): string => join(orchHome, 'runs');
export const worktreesDir = (orchHome: string = resolveOrchHome()): string =>
  join(orchHome, 'worktrees');
export const poolDir = (orchHome: string = resolveOrchHome()): string => join(orchHome, 'pool');
export const projectsDir = (orchHome: string = resolveOrchHome()): string =>
  join(orchHome, 'projects');

/** `worktrees/<run-id>/` — the checkout a run's steps work in (AD-9). */
export const worktreeDir = (runId: string, orchHome: string = resolveOrchHome()): string =>
  join(worktreesDir(orchHome), assertSafePathSegment(runId, 'a run id'));

/** `projects/<project-id>/` — central registration and memory, keyed per AD-10. */
export const projectDir = (projectId: string, orchHome: string = resolveOrchHome()): string =>
  join(projectsDir(orchHome), assertSafePathSegment(projectId, 'a project id'));

/** The file names inside a run directory, so no caller spells one itself. */
export const EVENT_LOG_FILE_NAME = 'events.jsonl';
export const FETCH_RECORD_FILE_NAME = 'fetch-record.json';
export const EVENT_LOG_LOCK_FILE_NAME = 'events.jsonl.lock';
export const RUN_CONFIG_DIR_NAME = 'config';

/**
 * AD-19 — `runs/<run-id>/commands/`, the durable steering intent files.
 *
 * Spelled once here for the reason every other name in this module is: a second spelling of this
 * directory would be a second on-disk layout, and AD-19 makes these files *the* command path. A
 * renderer that guessed the directory and an engine that read another would leave a user's disengage
 * sitting in a folder nothing consumes.
 */
export const COMMANDS_DIR_NAME = 'commands';

/**
 * `commands/applied/` and `commands/refused/` — where a consumed and a quarantined intent go.
 *
 * Neither is a second command path: nothing is *read* from either. They exist because an intent is
 * never deleted — a file is moved aside once its effect is durable, so the evidence of what steered a
 * run survives, and a file the loop cannot understand is moved out of the way rather than retried on
 * every pass for ever.
 */
export const COMMANDS_APPLIED_DIR_NAME = 'applied';
export const COMMANDS_REFUSED_DIR_NAME = 'refused';

/**
 * CAP-23 — `runs/<run-id>/HANDOFF.md`, the document written when the system gives up.
 *
 * Upper-case and Markdown because its only audience is a person: it is the one artifact in the system
 * whose failure mode is being unreadable rather than being incorrect.
 */
export const HANDOFF_DOCUMENT_FILE_NAME = 'HANDOFF.md';

/** Every path inside `runs/<run-id>/` that this story's units touch. */
export interface RunPaths {
  /** The resolved `ORCH_HOME` these paths were built under. */
  readonly orchHome: string;
  readonly runId: string;
  /** `runs/<run-id>/` */
  readonly runDir: string;
  /** `runs/<run-id>/events.jsonl` — the AD-4 durable truth, appended by the recorder alone. */
  readonly eventLog: string;
  /** `runs/<run-id>/events.jsonl.lock` — the AD-29 single-writer claim. */
  readonly eventLogLock: string;
  /** `runs/<run-id>/fetch-record.json` — the AD-14 run shared fetch record. */
  readonly fetchRecord: string;
  /** `runs/<run-id>/config/` — the AD-9 per-run configuration snapshot. */
  readonly configDir: string;
  /** `runs/<run-id>/commands/` — the AD-19 durable steering intent files, and the only command path. */
  readonly commandsDir: string;
  /** `runs/<run-id>/commands/applied/` — intents whose effect is durable, kept rather than deleted. */
  readonly commandsAppliedDir: string;
  /** `runs/<run-id>/commands/refused/` — intents the loop refused, quarantined rather than retried. */
  readonly commandsRefusedDir: string;
  /** `runs/<run-id>/HANDOFF.md` — the CAP-23 document, written when the system gives up. */
  readonly handoffDocument: string;
}

/** `runs/<run-id>/` and everything under it. */
export const runPaths = (runId: string, orchHome: string = resolveOrchHome()): RunPaths => {
  const safeRunId = assertSafePathSegment(runId, 'a run id');
  const dir = join(runsDir(orchHome), safeRunId);
  return {
    orchHome,
    runId: safeRunId,
    runDir: dir,
    eventLog: join(dir, EVENT_LOG_FILE_NAME),
    eventLogLock: join(dir, EVENT_LOG_LOCK_FILE_NAME),
    fetchRecord: join(dir, FETCH_RECORD_FILE_NAME),
    configDir: join(dir, RUN_CONFIG_DIR_NAME),
    commandsDir: join(dir, COMMANDS_DIR_NAME),
    commandsAppliedDir: join(dir, COMMANDS_DIR_NAME, COMMANDS_APPLIED_DIR_NAME),
    commandsRefusedDir: join(dir, COMMANDS_DIR_NAME, COMMANDS_REFUSED_DIR_NAME),
    handoffDocument: join(dir, HANDOFF_DOCUMENT_FILE_NAME),
  };
};
