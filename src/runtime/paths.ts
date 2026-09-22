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

/**
 * The two names the AD-9 snapshot shares with `<target-repo>/.orch/`, imported rather than re-spelled.
 *
 * `src/contracts/installer.ts` already owns them because three units read what one unit writes; a
 * second spelling here would let the snapshot and the installer disagree about a file name, which is
 * the two-on-disk-layouts failure every other name in this module exists to prevent.
 */
import { AGENTS_DIR_NAME, PROFILE_FILE_NAME } from '../contracts/index.js';

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

/**
 * AD-9, AD-10, AD-33 — `projects/<project-id>/registration.json`, the central registration record.
 *
 * Spelled here beside the run file names for the reason every other name in this module is: a second
 * spelling would be a second on-disk layout, and this file is what makes a moved repository *the same
 * project*. An installer writing one name and a resolver reading another would silently register every
 * move as a new project, which is exactly the split AD-10 exists to prevent.
 *
 * JSON rather than TOML, per the Consistency Conventions: it is machine-owned state, not a file a
 * person is invited to edit. `projects/<project-id>/` holds the per-project ledger and memory too
 * (stories 5-1 and on), so the registration is a *file* inside that directory rather than being the
 * directory's only content.
 */
export const PROJECT_REGISTRATION_FILE_NAME = 'registration.json';

/** `projects/<project-id>/registration.json` for one project id. */
export const projectRegistrationPath = (
  projectId: string,
  orchHome: string = resolveOrchHome(),
): string => join(projectDir(projectId, orchHome), PROJECT_REGISTRATION_FILE_NAME);

/** The file names inside a run directory, so no caller spells one itself. */
export const EVENT_LOG_FILE_NAME = 'events.jsonl';
export const FETCH_RECORD_FILE_NAME = 'fetch-record.json';
export const EVENT_LOG_LOCK_FILE_NAME = 'events.jsonl.lock';
export const RUN_CONFIG_DIR_NAME = 'config';

/**
 * AD-9, AD-34 — what the per-run configuration snapshot under `runs/<run-id>/config/` is made of.
 *
 * The snapshot carries the *same file names* as `<target-repo>/.orch/`, plus `conventions/` for the
 * repository's own instruction files, and that is deliberate rather than convenient: AD-34 makes run
 * scope "the immutable snapshot at `runs/<run-id>/config/` … the only configuration a step reads", so
 * one reader has to be able to read either scope. Identical names mean the profile loader and roster
 * discovery take a directory and cannot tell which scope they were pointed at — the alternative, a
 * snapshot in a shape of its own, would need a second reader, and a second reader is how a step comes
 * to read `.orch/` because that was the one the loader supported.
 *
 * `conventions/` exists because the instruction files are the one piece of configuration that does not
 * live in `.orch/`: `CLAUDE.md` and `AGENTS.md` sit at the repository root, and a run that read them
 * from there would read whatever the feature branch has done to them mid-run.
 */
export const RUN_CONFIG_CONVENTIONS_DIR_NAME = 'conventions';

/** Every path inside `runs/<run-id>/config/`, so no caller joins a segment of its own. */
export interface RunConfigPaths {
  /** `runs/<run-id>/config/` */
  readonly dir: string;
  /** `runs/<run-id>/config/profile.toml` — the snapshotted AD-16 profile. */
  readonly profile: string;
  /** `runs/<run-id>/config/agents/` — the snapshotted AD-17 roster, one TOML per agent. */
  readonly agentsDir: string;
  /** `runs/<run-id>/config/conventions/` — the repository's instruction files, verbatim. */
  readonly conventionsDir: string;
}

/**
 * The snapshot's paths for one run.
 *
 * Takes a {@link RunPaths} rather than a run id, because the run directory has already been validated
 * by then: a second `assertSafePathSegment` on the same id would be a second place to forget one.
 */
export const runConfigPaths = (paths: RunPaths): RunConfigPaths => ({
  dir: paths.configDir,
  profile: join(paths.configDir, PROFILE_FILE_NAME),
  agentsDir: join(paths.configDir, AGENTS_DIR_NAME),
  conventionsDir: join(paths.configDir, RUN_CONFIG_CONVENTIONS_DIR_NAME),
});

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
 * AD-25 — `runs/<run-id>/questions/`, the durable question state files.
 *
 * Spelled once here for the same reason `commands/` is: a second spelling would be a second on-disk
 * layout, and AD-25 makes the compare-and-set on these files *the* decision of which resolver won. A
 * renderer that wrote an answer against one directory and an engine that resolved against another would
 * hand two resolvers a win each, which is exactly the poisoned decision ledger AD-25 exists to prevent.
 */
export const QUESTIONS_DIR_NAME = 'questions';

/**
 * `questions/<question-id>/state.json` — the AD-25 question state, and `outcome.json` — the claim.
 *
 * Two files rather than one, and which is which is the whole mechanism. `outcome.json` is created with
 * `O_EXCL`, so the first creator wins by construction and every later resolver's `open` fails; the
 * state file is *derived* from it and is therefore never the thing contended for. A design that
 * contended for the state file directly would have to read it before writing, and two processes can
 * both read `asked`.
 */
export const QUESTION_STATE_FILE_NAME = 'state.json';
export const QUESTION_OUTCOME_FILE_NAME = 'outcome.json';

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
  /** `runs/<run-id>/questions/` — the AD-25 question state files, one directory per question. */
  readonly questionsDir: string;
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
    questionsDir: join(dir, QUESTIONS_DIR_NAME),
    handoffDocument: join(dir, HANDOFF_DOCUMENT_FILE_NAME),
  };
};

/** Every path belonging to one question, so no caller joins a segment of its own. */
export interface QuestionPaths {
  readonly runId: string;
  readonly questionId: string;
  /** `runs/<run-id>/questions/<question-id>/` */
  readonly dir: string;
  /** `.../state.json` — the AD-25 question state, derived from the outcome once one exists. */
  readonly state: string;
  /** `.../outcome.json` — the exclusively created claim whose first creator won the compare-and-set. */
  readonly outcome: string;
}

/**
 * `runs/<run-id>/questions/<question-id>/` and the two files in it.
 *
 * A question id reaches this module as data — minted by the engine, and in the web resolver's case
 * arriving over a transport — so it is validated as a path segment here rather than trusted, exactly as
 * a run id is.
 */
export const questionPaths = (paths: RunPaths, questionId: string): QuestionPaths => {
  const safeQuestionId = assertSafePathSegment(questionId, 'a question id');
  const dir = join(paths.questionsDir, safeQuestionId);
  return {
    runId: paths.runId,
    questionId: safeQuestionId,
    dir,
    state: join(dir, QUESTION_STATE_FILE_NAME),
    outcome: join(dir, QUESTION_OUTCOME_FILE_NAME),
  };
};
