/**
 * What a repository says about itself: its root, AD-10's project id, and its remote.
 *
 * Every function here is a pure read of a path — nothing is written, nothing is cached and nothing is
 * asked — which is what lets a refusal be taken *before* anything lands on disk, and what makes a
 * detected value a default rather than a decision.
 *
 * **Why this is in `src/runtime/` and not in `src/installer/`, where it was written.** Story 2-1 put
 * these three reads in `src/installer/detect.ts`, where the interview needed them. Story 2-2 needs
 * one of them — {@link firstCommitSha} — on the *resolution* path: AD-10 makes a registration's
 * recorded path a pointer, and a pointer is verified by reading the first-commit SHA at it and
 * comparing, which `src/runtime/projects.ts` does. The runtime may not import the installer (the
 * dependency direction is asserted in `tests/runtime.recorder.test.ts`), and a second copy of the
 * probe would be two answers to "what is this project's id" — the exact split AD-10 exists to
 * prevent. So the reads moved down and `src/installer/detect.ts` re-exports all three, which is the
 * relocation stories 1-9 and 1-11 made for the same rule: no existing caller changed.
 *
 * **Nothing here reads an environment variable's value.** The only environment fact the installer
 * collects is a variable's *name*, typed by a person at question 9 (AD-12). A probe that helpfully
 * looked one up would be the credential leak story 2-1 exists to prevent, so the two variables `git`
 * is given are named rather than inherited — see {@link gitEnvironment}.
 */
import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';

/**
 * The environment git is given: the two variables it needs and nothing else.
 *
 * A child process that inherits this one's environment inherits every credential in it, and AD-12's
 * whole position is that the installer handles no credential. Naming what git gets is also what
 * makes "no value of the named variable was read" provable rather than asserted — an inherited
 * environment is read wholesale on the way into `spawn`, so a test could not tell a copy from a
 * lookup. `GIT_TERMINAL_PROMPT` is off because an installer that stopped at a git credential prompt
 * would look like a hang in the middle of an interview.
 */
const gitEnvironment = (): NodeJS.ProcessEnv => ({
  PATH: process.env['PATH'] ?? '',
  HOME: process.env['HOME'] ?? '',
  GIT_TERMINAL_PROMPT: '0',
  LC_ALL: 'C',
});

/**
 * Run a git command in the repository, answering `null` for every failure.
 *
 * `null` means "git did not say", and every caller treats it as an undecided fact rather than as a
 * negative answer — the same shape as the npm version in `src/contracts/node-floor.ts`. The refusals
 * that depend on it are stated by the caller, which knows what it needed and can name it.
 */
const git = (repositoryPath: string, args: readonly string[]): string | null => {
  try {
    const output = execFileSync('git', [...args], {
      cwd: repositoryPath,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      env: gitEnvironment(),
      // A repository whose hooks or config hang would hang the install; the interview is interactive
      // and a person would have no way to tell a slow probe from a dead one.
      timeout: 10_000,
    });
    const trimmed = output.trim();
    return trimmed === '' ? null : trimmed;
  } catch {
    return null;
  }
};

/** The repository root, or `null` when the path is not inside a git repository. */
export const gitRoot = (repositoryPath: string): string | null => {
  const root = git(repositoryPath, ['rev-parse', '--show-toplevel']);
  if (root === null) return null;
  try {
    return realpathSync(root);
  } catch {
    return root;
  }
};

/**
 * AD-10 — the project id is the SHA of the first commit.
 *
 * `--max-parents=0` lists every root commit, newest first, and a repository with merged histories has
 * more than one. The last line is the oldest of them, which is the first commit of the history this
 * repository grew from; picking the newest would key one project by whichever unrelated history was
 * grafted in most recently.
 */
export const firstCommitSha = (repositoryPath: string): string | null => {
  const roots = git(repositoryPath, ['rev-list', '--max-parents=0', 'HEAD']);
  if (roots === null) return null;
  const lines = roots
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
  return lines[lines.length - 1] ?? null;
};

/** The push remote, or `null` when there is none. A repository with no remote is a real answer. */
export const gitRemote = (repositoryPath: string): string | null =>
  git(repositoryPath, ['remote', 'get-url', 'origin']);

/** One commit as history search returns it: its SHA, its whole message, and its note if it has one. */
export interface CommitRecord {
  readonly sha: string;
  /** The subject and body, as the author wrote them. */
  readonly message: string;
  /** The note under the requested ref, or `''` — the committer's AD-22 record lives there, not here. */
  readonly note: string;
}

export interface CommitSearchOptions {
  /** How many of the newest candidates to return. Bounded so a large history cannot stall a question. */
  readonly limit?: number;
  /** A notes ref whose text is searched as if it were part of the message, as `git log --notes` does. */
  readonly notesRef?: string;
}

/** The default candidate bound: generous for a question's lifetime, small beside any real history. */
export const DEFAULT_COMMIT_SEARCH_LIMIT = 200;

/** Unit and record separators: characters no commit message is written with, so a split is exact. */
const FIELD_SEPARATOR = '\u001f';
const RECORD_SEPARATOR = '\u001e';

/**
 * Commits whose message or note *contains* `needle`, newest first — a prefilter, never a verdict.
 *
 * Q4 makes git history one of the three places a question is attempted against before it reaches a
 * person, and this is the read that attempt needs. **It deliberately answers "contains", which is
 * weaker than what a deflection may rest on.** `--fixed-strings --grep` is a substring test, so
 * `resolveProject` finds a commit that only ever names `resolveProjectPath`; the whole-token decision
 * belongs to the engine's anchor comparison, which is the same one story 2-3 uses for staleness. Git
 * narrows a history of thousands to a handful; it does not decide which of them speaks to the anchor.
 *
 * Fixed strings rather than a pattern because an anchor is data: a file-path anchor carries `.` and a
 * symbol may carry `$`, and a regular expression built from one matches things it does not name.
 *
 * Runs through {@link git}, so it inherits {@link gitEnvironment}'s named-not-inherited environment and
 * its `null`-for-every-failure rule — a path that is not a repository, or has no commits, answers with
 * no commits rather than an error. A question must never be blocked by the attempt to deflect it.
 */
export const searchCommitHistory = (
  repositoryPath: string,
  needle: string,
  options: CommitSearchOptions = {},
): readonly CommitRecord[] => {
  if (needle === '') return [];
  const limit = options.limit ?? DEFAULT_COMMIT_SEARCH_LIMIT;
  const notes = options.notesRef === undefined ? [] : [`--notes=${options.notesRef}`];
  const output = git(repositoryPath, [
    'log',
    `--max-count=${String(limit)}`,
    '--fixed-strings',
    `--grep=${needle}`,
    ...notes,
    `--format=%H${FIELD_SEPARATOR}%B${FIELD_SEPARATOR}%N${RECORD_SEPARATOR}`,
  ]);
  if (output === null) return [];
  const commits: CommitRecord[] = [];
  for (const record of output.split(RECORD_SEPARATOR)) {
    const [sha = '', message = '', note = ''] = record.split(FIELD_SEPARATOR);
    const trimmedSha = sha.trim();
    if (trimmedSha === '') continue;
    commits.push({ sha: trimmedSha, message: message.trim(), note: note.trim() });
  }
  return commits;
};
