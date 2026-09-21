/**
 * `src/installer/` — AD-12's `npx github:<owner>/<repo> init`, from the refusals it takes before
 * writing anything to the outcome it reports when it is done.
 *
 * The order of what follows is the contract, and each step exists because of the one before it:
 *
 *   1. **Refuse before writing.** A directory that is not a repository root, and a repository with
 *      no commits, are refused from detection alone — before `.orch/` is read, let alone created.
 *      AD-10 makes the project id the first-commit SHA, so a repository without one cannot be
 *      onboarded; a half-written refusal would be worse than a refusal.
 *   2. **Read `.orch/` as authority (AD-12).** An upgrade is a re-run, so an answer already on disk
 *      is never asked for again, and an artifact whose `schema_version` this build does not
 *      recognise is refused by name rather than read as if it were current (AD-28).
 *   3. **Ask only what is missing**, in `build-sequencing.md`'s order.
 *   4. **Write atomically, skipping what would not change**, and record every file in the manifest.
 *
 * **What this does not do.** It does not register the project centrally — the first-commit SHA is
 * detected and confirmed here, and story 2-2 owns registration and the prune command. It does not
 * compress the interview through a model; these thirteen questions are asked in the terminal. It
 * does not run a feature: this installs a project, it does not start one.
 */
import { createInterface } from 'node:readline/promises';

import { AGENTS_DIR_NAME } from '../contracts/index.js';

import { detectDefaults } from './detect.js';
import { orchPaths, readExistingInstall } from './answers.js';
import { BUILT_IN_AGENT_IDS, completeAnswers, missingQuestions, runInterview } from './interview.js';
import type { InterviewIo, Prompt, QuestionId } from './interview.js';
import { findHalfInstall } from './manifest.js';
import type { HalfInstallFinding } from './manifest.js';
import { writeInstall } from './write.js';
import type { FileOutcome } from './write.js';

/**
 * Re-exported so `bin/init.ts` has one import: it prints the version, and AD-12 / AD-28 make that
 * the installer version the manifest records, which is this package's own.
 */
export { PACKAGE_VERSION } from '../contracts/index.js';

export * from './answers.js';
export * from './detect.js';
export * from './interview.js';
export * from './manifest.js';
export * from './toml.js';
export * from './write.js';

/**
 * A refusal taken before anything was written.
 *
 * The AD-35 code is `config.invalid`, whose declared disposition is `escalate-to-human`: there is
 * nothing to retry about a directory that is not a repository. The message names *what was needed*
 * rather than what was wrong, because the person reading it is about to go and provide it.
 */
export class InstallRefusal extends Error {
  readonly code = 'config.invalid';

  constructor(message: string) {
    super(message);
    this.name = 'InstallRefusal';
  }
}

export interface InitOptions {
  /** The repository to onboard, as the caller spelled it. */
  readonly repository: string;
  readonly io: InterviewIo;
  /** Injected so a test can assert on the manifest's own refresh rather than race a clock. */
  readonly now?: Date;
}

export interface InitOutcome {
  readonly repository: string;
  readonly projectId: string;
  readonly asked: readonly QuestionId[];
  readonly dispositions: readonly FileOutcome[];
  readonly recovered: readonly HalfInstallFinding[];
  readonly gitignore: 'appended' | 'unchanged';
  /** R3 — one headline that stands alone, before any detail. */
  readonly summary: string;
}

const count = (value: number, singular: string, plural = `${singular}s`): string =>
  `${String(value)} ${value === 1 ? singular : plural}`;

/** R3, R8 — what happened, in one line, including what was recovered rather than merely written. */
const summarise = (
  repository: string,
  asked: readonly QuestionId[],
  dispositions: readonly FileOutcome[],
  recovered: readonly HalfInstallFinding[],
  gitignore: 'appended' | 'unchanged',
): string => {
  const created = dispositions.filter((entry) => entry.disposition === 'created').length;
  const updated = dispositions.filter((entry) => entry.disposition === 'updated').length;
  const unchanged = dispositions.filter((entry) => entry.disposition === 'unchanged').length;
  const parts = [
    `${count(created, 'file')} created`,
    `${count(updated, 'file')} updated`,
    `${count(unchanged, 'file')} unchanged`,
    `${count(asked.length, 'question')} asked`,
  ];
  if (recovered.length > 0) parts.push(`${count(recovered.length, 'file')} recovered`);
  if (gitignore === 'appended') parts.push('.gitignore appended');
  return `.orch/ is installed in ${repository}: ${parts.join(', ')}.`;
};

/**
 * Onboard a repository.
 *
 * Every refusal here is taken before a directory is created, which is the property matrix rows 7 and
 * 8 ask for and the reason detection is a pure read.
 */
export const runInit = async (options: InitOptions): Promise<InitOutcome> => {
  const detected = detectDefaults(options.repository);

  if (detected.gitRoot === null) {
    throw new InstallRefusal(
      `${detected.repositoryPath} is not a git repository. The installer needs one: a project is ` +
        'identified by the SHA of its first commit (AD-10), the run worktree is a git worktree, and ' +
        'the record of a run is a note on a commit. Run `git init` and make a first commit, then ' +
        'run the installer again. Nothing has been written.',
    );
  }
  if (detected.gitRoot !== detected.repositoryPath) {
    throw new InstallRefusal(
      `${detected.repositoryPath} is inside the git repository at ${detected.gitRoot}, but is not ` +
        'its root. `.orch/` belongs at the repository root, beside the `.gitignore` the installer ' +
        `appends to (AD-9). Run the installer against ${detected.gitRoot}. Nothing has been written.`,
    );
  }
  if (detected.firstCommitSha === null) {
    throw new InstallRefusal(
      `${detected.repositoryPath} is a git repository with no commits. The project id is the SHA of ` +
        'the first commit (AD-10), so there is nothing to identify this project by yet. Make a ' +
        'commit and run the installer again. Nothing has been written.',
    );
  }

  const existing = readExistingInstall(detected.repositoryPath);
  const recovered = findHalfInstall(existing.manifest, detected.repositoryPath);

  /**
   * A project id on disk that is not this repository's first commit is not an answer to keep.
   *
   * AD-10 makes the id identity and the path a pointer, so the same `.orch/` meeting a *different*
   * first commit means this directory now holds another repository. Re-asking question 2 puts the
   * disagreement in front of a person with the detected value offered, rather than writing an id
   * that would key the wrong central record.
   */
  const { project: _mismatched, ...withoutProject } = existing.answers;
  const identified =
    existing.answers.project !== undefined &&
    existing.answers.project.id !== detected.firstCommitSha
      ? withoutProject
      : existing.answers;

  /**
   * A custom agent's file is the only copy of its declaration, so losing one loses the answer.
   *
   * A built-in's file is rebuilt from the profile's roster; a custom one cannot be rebuilt from
   * anything, so the honest move is to ask question 11 again rather than to report a recovery that
   * did not happen. Existing agent files are never deleted, so the ones that survived stay where
   * they are and are read back on the next run.
   */
  const lostCustomAgent = recovered.some((finding) => {
    const name = finding.path.split('/').at(-1) ?? '';
    return (
      finding.path.includes(`/${AGENTS_DIR_NAME}/`) &&
      finding.reason === 'absent' &&
      !BUILT_IN_AGENT_IDS.includes(name.replace(/\.toml$/, ''))
    );
  });
  const { custom_agents: _lost, ...withoutCustomAgents } = identified;
  const settled = lostCustomAgent ? withoutCustomAgents : identified;

  const { answers, asked } = await runInterview(settled, options.io, detected);
  const complete = completeAnswers(answers);
  if (complete === null) {
    throw new InstallRefusal(
      'The interview did not settle every answer, so nothing was written. Missing: ' +
        missingQuestions(answers)
          .map((entry) => entry.id)
          .join(', '),
    );
  }

  const written = writeInstall(detected.repositoryPath, complete, options.now ?? new Date());

  return {
    repository: detected.repositoryPath,
    projectId: complete.project.id,
    asked,
    dispositions: written.dispositions,
    recovered,
    gitignore: written.gitignore,
    summary: summarise(
      detected.repositoryPath,
      asked,
      written.dispositions,
      recovered,
      written.gitignore,
    ),
  };
};

/** Where `.orch/` would go, for a caller that wants to say so before running. */
export const installTarget = (repository: string): string => orchPaths(repository).orchDir;

export interface ParsedArguments {
  readonly kind: 'init' | 'help' | 'version';
  readonly repository: string;
  /** Present only for `kind: 'help'` reached by a usage error, which exits non-zero. */
  readonly error: string | null;
}

export const USAGE = `orch init [path]

Onboard a repository: ask what the orchestrator needs to know about it and write
<path>/.orch/ — profile.toml, permissions.toml, agents/*.toml and a manifest —
appending the runtime paths to .gitignore. Defaults to the current directory.

  --help       print this and exit
  --version    print the installer version and exit

Re-running preserves every answer already on disk and asks only what is missing,
which is how an upgrade works (AD-12). Nothing is written until every question is
answered, and no credential is ever collected: question 9 takes the NAMES of the
environment variables holding them.`;

/**
 * Parse `init [path]`, plus the two flags every entry point is expected to answer.
 *
 * It lives here rather than in `bin/init.ts` so it is covered by the same typecheck, lint and tests
 * as everything else; the entry point keeps only what an entry point has to own, which is process
 * arguments in and an exit code out.
 */
export const parseInitArguments = (argv: readonly string[]): ParsedArguments => {
  const args = argv.filter((argument) => argument !== '');
  if (args.includes('--help') || args.includes('-h')) {
    return { kind: 'help', repository: process.cwd(), error: null };
  }
  if (args.includes('--version') || args.includes('-v')) {
    return { kind: 'version', repository: process.cwd(), error: null };
  }
  const positional = args.filter((argument) => !argument.startsWith('-'));
  const unknownFlag = args.find((argument) => argument.startsWith('-'));
  if (unknownFlag !== undefined) {
    return { kind: 'help', repository: process.cwd(), error: `Unknown option "${unknownFlag}".` };
  }
  const [command, path, ...rest] = positional;
  if (command !== 'init') {
    return {
      kind: 'help',
      repository: process.cwd(),
      error: command === undefined ? 'No command given.' : `Unknown command "${command}".`,
    };
  }
  if (rest.length > 0) {
    return {
      kind: 'help',
      repository: process.cwd(),
      error: `init takes at most one path; received ${String(positional.length - 1)}.`,
    };
  }
  return { kind: 'init', repository: path ?? process.cwd(), error: null };
};

/**
 * The terminal the interview is conducted in (Q5: answers are given in the terminal, never a
 * browser).
 *
 * Prompts go to stdout and refusals to stderr. The Consistency Conventions' "no unit writes
 * diagnostics to stdout" is about a *run*, whose observable output is the event log — and this
 * process runs before any run exists, with nowhere else for a question to go.
 */
export const terminalIo = (): InterviewIo & { readonly close: () => void } => {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  /**
   * Lines are *pulled*, not awaited through `rl.question`.
   *
   * `question` only listens from the moment it is called, so input that arrived earlier is dropped —
   * which is invisible when a person is typing and fatal when the answers are piped in, as the
   * delivery test pipes them. The async iterator pauses the stream between pulls, so every line is
   * read by the question it belongs to. End of input answers every remaining question with the empty
   * string, which takes the offered default and refuses where there is none.
   */
  const lines = rl[Symbol.asyncIterator]();
  return {
    ask: async (prompt: Prompt): Promise<string> => {
      const suffix = prompt.suggestion === null ? '' : ` [${prompt.suggestion}]`;
      process.stdout.write(`${prompt.question}${suffix}: `);
      const next = await lines.next();
      return next.done === true ? '' : next.value;
    },
    say: (line: string): void => {
      process.stderr.write(`${line}\n`);
    },
    close: (): void => {
      rl.close();
    },
  };
};
