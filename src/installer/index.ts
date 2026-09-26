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
 *   5. **Register the project centrally (AD-10).** The id 2-1 confirms is the id that exists under
 *      `ORCH_HOME/projects/<project-id>/`, so `.orch/` and the central record cannot disagree about
 *      which project this repository is. Registration is idempotent along with everything else, and a
 *      repository that has moved updates its pointer rather than becoming a second project (AD-33).
 *
 * **What this does not do.** It does not compress the interview through a model; these thirteen
 * questions are asked in the terminal. It does not run a feature: this installs a project, it does
 * not start one. And it stores no memory centrally — the registration record is a pointer, and what
 * memory is kept beside it is story 5-1's.
 */
import { createInterface } from 'node:readline/promises';

import { AGENTS_DIR_NAME } from '../contracts/index.js';
import { registerProject } from '../runtime/projects.js';
import type { RegisteredProject } from '../runtime/projects.js';

import { detectDefaults } from './detect.js';
import { orchPaths, readExistingInstall } from './answers.js';
import { BUILT_IN_AGENT_IDS, completeAnswers, missingQuestions, runInterview } from './interview.js';
import type { InstallMode, InterviewIo, PartialAnswers, Prompt, QuestionId } from './interview.js';
import { findHalfInstall } from './manifest.js';
import type { HalfInstallFinding } from './manifest.js';
import { writeInstall } from './write.js';
import type { FileOutcome } from './write.js';

/**
 * Re-exported so `bin/init.ts` has one import: it prints the version, and AD-12 / AD-28 make that
 * the installer version the manifest records, which is this package's own.
 */
export { PACKAGE_VERSION } from '../contracts/index.js';

/**
 * AD-9's prune and AD-10's registration, re-exported so `bin/init.ts` keeps one import.
 *
 * They live in `src/runtime/projects.ts`, where every other `ORCH_HOME` write does. What is re-exported
 * here is the *command* surface: `bin/init.ts` is this package's only entry point, `package.json`
 * exposes it through `./installer`, and AD-9's prune is a subcommand of that same binary. A second
 * export map entry would make the delivery path — the one thing story 2-1 proved by running rather
 * than by reading — carry a second contract for no gain.
 */
export { pruneProject, readProjectRegistration, registerProject, resolveProject } from '../runtime/projects.js';
export type {
  ProjectResolution,
  PruneOptions,
  PruneOutcome,
  RegisteredProject,
} from '../runtime/projects.js';

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
  /**
   * Where the central registration lands. Defaults to the AD-9 `ORCH_HOME`.
   *
   * Injected for the same reason `now` is: a test that registered into a developer's real `~/.orch`
   * would leave records behind on the machine it ran on.
   */
  readonly orchHome?: string;
  /**
   * "express" or "custom", decided already (typically from a CLI flag) — skips
   * {@link InterviewIo.chooseInstallMode} entirely. Omitted defers to that, and if the `io` offers no
   * such choice either, `runInit` proceeds exactly as every install did before express mode existed:
   * every question asked, in full.
   */
  readonly mode?: InstallMode;
  /**
   * Reopen `mechanics`, `source_layout` and `resources` even though they are already answered — the
   * three questions detection can inform, offered fresh with whatever is now on disk (new scripts, a
   * new directory, documentation that did not exist yet). Every other answer is untouched. Default
   * `false`: a plain re-run stays exactly as quiet as it always was.
   */
  readonly refresh?: boolean;
}

export interface InitOutcome {
  readonly repository: string;
  readonly projectId: string;
  readonly asked: readonly QuestionId[];
  readonly dispositions: readonly FileOutcome[];
  readonly recovered: readonly HalfInstallFinding[];
  readonly gitignore: 'appended' | 'unchanged';
  /** What registering this project under `ORCH_HOME/projects/<project-id>/` did (AD-10). */
  readonly registration: RegisteredProject;
  /** R3 — one headline that stands alone, before any detail. */
  readonly summary: string;
  /**
   * Advice that stands beside the install rather than blocking it — currently just the one case: no
   * documentation was found for detection to read at all. Empty when there is nothing to say.
   */
  readonly advisories: readonly string[];
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
  registration: RegisteredProject,
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
  // The central record is named in the headline because it is the half of the install that is not in
  // the repository: a person who saw only file dispositions would have no way to tell whether the
  // project this `.orch/` describes exists centrally (AD-10).
  parts.push(
    registration.disposition === 'created'
      ? `project ${registration.projectId} registered`
      : registration.disposition === 'pointer_updated'
        ? `project ${registration.projectId} re-pointed here`
        : `project ${registration.projectId} already registered`,
  );
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
  const reconciled = lostCustomAgent ? withoutCustomAgents : identified;

  /**
   * `--refresh` — the three questions detection ever actually informs, reopened even though they are
   * already answered.
   *
   * `target_path` and `project` are also `detected`-sourced, and deliberately excluded: AD-10 makes
   * the project id stable identity, not something a later run re-derives, and re-offering the path is
   * pointless once the repository has not moved. `mechanics`, `source_layout` and `resources` are the
   * three whose right answer can genuinely change as a project grows — new scripts, a new directory, a
   * database mentioned in documentation that did not exist yet — and re-detecting them costs nothing
   * an ordinary answer already on disk did not: they are offered as suggestions exactly like a first
   * run, confirmed or corrected at the interview, never silently overwritten.
   */
  const withoutRefreshed = (answers: PartialAnswers): PartialAnswers => {
    const { mechanics: _mechanics, source_layout: _sourceLayout, resources: _resources, ...rest } =
      answers;
    return rest;
  };
  const settled = options.refresh === true ? withoutRefreshed(reconciled) : reconciled;

  /**
   * The express/custom choice is asked at most once per install, and only when there is at least one
   * question actually missing — a re-run that has nothing left to ask must stay exactly that quiet,
   * which `tests/installer.idempotence.test.ts` holds as "asks nothing at all" (`io.asked` empty).
   * `chooseInstallMode` is deliberately not routed through `io.ask`/`io.asked`: it is not one of the
   * fourteen questions, and mixing it into that channel would put a fifteenth id in front of every
   * caller that already enumerates the interview by its own known order.
   */
  const missingBeforeMode = missingQuestions(settled);
  const mode: InstallMode =
    options.mode ?? (missingBeforeMode.length === 0 ? 'custom' : ((await options.io.chooseInstallMode?.()) ?? 'custom'));

  const { answers, asked } = await runInterview(settled, options.io, detected, {
    express: mode === 'express',
  });
  const complete = completeAnswers(answers);
  if (complete === null) {
    throw new InstallRefusal(
      'The interview did not settle every answer, so nothing was written. Missing: ' +
        missingQuestions(answers)
          .map((entry) => entry.id)
          .join(', '),
    );
  }

  /**
   * The confirmed id has to *be* this repository's first commit, and this is the last moment nothing
   * has been written.
   *
   * Question 2 offers the detected SHA and checks that what comes back is shaped like one, and a
   * disagreeing id already on disk is re-asked above — but a person can still type forty different
   * hexadecimal characters at the prompt. Writing that would put one id in `.orch/profile.toml` and
   * another in `ORCH_HOME/projects/`, which is the split into two projects AD-10 exists to prevent.
   * Refusing here rather than after `writeInstall` keeps the property matrix rows 7 and 8 rely on:
   * every refusal is taken before a file is touched.
   */
  if (complete.project.id !== detected.firstCommitSha) {
    throw new InstallRefusal(
      `The confirmed project id ${complete.project.id} is not this repository's first commit, which ` +
        `is ${detected.firstCommitSha}. A project is identified by the SHA of its first commit ` +
        '(AD-10), so installing under another id would key this repository to a project it is not. ' +
        'Re-run the installer and accept the offered id. Nothing has been written.',
    );
  }

  const written = writeInstall(detected.repositoryPath, complete, options.now ?? new Date());

  /**
   * Registration comes last, because it records a *completed* install (matrix 16).
   *
   * The id is computed from the repository by `registerProject` rather than passed to it, and the id
   * the interview settled is handed over as `expectedProjectId` so the two are checked against each
   * other rather than one being trusted. A failure here leaves `.orch/` written and the manifest
   * describing it, which is the same recoverable half-install AD-12 already requires a re-run to
   * complete — registration is idempotent, so the re-run finishes it.
   */
  const registration = registerProject(detected.repositoryPath, {
    expectedProjectId: complete.project.id,
    ...(options.orchHome === undefined ? {} : { orchHome: options.orchHome }),
    ...(options.now === undefined ? {} : { now: options.now }),
  });

  /**
   * The one advisory this installer offers: nothing was there for `resources`, `mechanics` or
   * `source_layout` to be *informed* by beyond a lockfile and a directory listing, because no
   * documentation exists yet. Writing one and running `orch init --refresh` re-offers exactly those
   * three with whatever it can then read, changing nothing else already answered.
   */
  const advisories: string[] =
    detected.documentation.files.length === 0
      ? [
          'No project documentation was found (looked for CLAUDE.md, AGENTS.md, README.md, ' +
            'docs/README.md). Consider adding one describing what this repository is and needs — ' +
            'in particular, whether it needs a database. Once it exists, run `orch init --refresh` to ' +
            're-offer mechanics, source_layout and resources with whatever can now be read; nothing ' +
            'else already answered is touched.',
        ]
      : [];

  return {
    repository: detected.repositoryPath,
    projectId: complete.project.id,
    asked,
    dispositions: written.dispositions,
    recovered,
    gitignore: written.gitignore,
    registration,
    summary: summarise(
      detected.repositoryPath,
      asked,
      written.dispositions,
      recovered,
      written.gitignore,
      registration,
    ),
    advisories,
  };
};

/** Where `.orch/` would go, for a caller that wants to say so before running. */
export const installTarget = (repository: string): string => orchPaths(repository).orchDir;

export interface ParsedArguments {
  readonly kind: 'init' | 'prune' | 'help' | 'version';
  readonly repository: string;
  /**
   * The project id `prune` names, and `null` for every other command.
   *
   * A project id, never a path — AD-9's prune deletes central state, and a command that took a path
   * would let a person standing in the wrong directory delete the wrong project's memory. There is
   * deliberately no default: `prune` with no argument is a usage error rather than a prune of whatever
   * repository the shell happens to be sitting in.
   */
  readonly projectId: string | null;
  /** `prune --force`: delete a project that still resolves. Off unless it was asked for. */
  readonly force: boolean;
  /**
   * `init --express` or `init --custom`, decided on the command line rather than at a prompt.
   * `null` for every other command, and for `init` with neither flag — which defers to
   * {@link InterviewIo.chooseInstallMode} instead of skipping the choice.
   */
  readonly mode: InstallMode | null;
  /** `init --refresh`: reopen `mechanics`, `source_layout` and `resources`. `false` for every other command. */
  readonly refresh: boolean;
  /** Present only for `kind: 'help'` reached by a usage error, which exits non-zero. */
  readonly error: string | null;
}

export const USAGE = `orch init [path] [--express | --custom] [--refresh]
orch prune <project-id> [--force]

init — onboard a repository: ask what the orchestrator needs to know about it and
write <path>/.orch/ — profile.toml, permissions.toml, agents/*.toml and a manifest
— appending the runtime paths to .gitignore, and registering the project centrally
under ORCH_HOME/projects/<project-id>/. Defaults to the current directory.

  --express    accept every detected or fixed default silently, asking only about
               the few things nothing can default (most commonly, where the code
               actually lives, if nothing conventional was found)
  --custom     walk through every question, each with an explanation of what it
               collects and why, before asking

  Neither flag: if the terminal offers a choice, you are asked once, up front,
  which of the two you want. Answers already on disk are never re-asked either way.

  --refresh    reopen mechanics, source_layout and resources even though they are
               already answered — the three questions detection can inform, offered
               fresh with whatever is now on disk (new scripts, a new directory,
               documentation that did not exist yet). Every other answer is left
               exactly as it was. A repository with no CLAUDE.md, AGENTS.md,
               README.md or docs/README.md is told to add one and run this after.

prune — remove the central state of one project, named by its project id, which is
the SHA of its first commit (AD-10). It takes an id and never a path, so standing
in the wrong directory cannot delete the wrong project. A project whose repository
is still there is refused rather than pruned: prune is for state orphaned by a
deleted project directory (AD-9), and --force is how you say you mean otherwise.

  --help       print this and exit
  --version    print the installer version and exit

Re-running init preserves every answer already on disk and asks only what is
missing, which is how an upgrade works (AD-12). Nothing is written until every
question is answered, and no credential is ever collected: question 9 takes the
NAMES of the environment variables holding them.`;

/**
 * Parse `init [path]` and `prune <project-id>`, plus the two flags every entry point is expected to
 * answer.
 *
 * It lives here rather than in `bin/init.ts` so it is covered by the same typecheck, lint and tests
 * as everything else; the entry point keeps only what an entry point has to own, which is process
 * arguments in and an exit code out.
 *
 * Flags are validated **per command** rather than globally, which is why `--force` does not simply
 * join the accepted set: `orch init --force` has to stay a usage error, because a flag the command
 * does not act on being silently accepted is how a person comes to believe they forced something.
 */
export const parseInitArguments = (argv: readonly string[]): ParsedArguments => {
  const args = argv.filter((argument) => argument !== '');
  const cwd = process.cwd();
  const base = { repository: cwd, projectId: null, force: false, mode: null, refresh: false } as const;
  if (args.includes('--help') || args.includes('-h')) {
    return { ...base, kind: 'help', error: null };
  }
  if (args.includes('--version') || args.includes('-v')) {
    return { ...base, kind: 'version', error: null };
  }
  const positional = args.filter((argument) => !argument.startsWith('-'));
  const flags = args.filter((argument) => argument.startsWith('-'));
  const [command, first, ...rest] = positional;

  if (command === 'init') {
    const unknownFlag = flags.find(
      (flag) => flag !== '--express' && flag !== '--custom' && flag !== '--refresh',
    );
    if (unknownFlag !== undefined) {
      return { ...base, kind: 'help', error: `Unknown option "${unknownFlag}".` };
    }
    if (flags.includes('--express') && flags.includes('--custom')) {
      return {
        ...base,
        kind: 'help',
        error: '--express and --custom name opposite choices; give at most one.',
      };
    }
    if (rest.length > 0) {
      return {
        ...base,
        kind: 'help',
        error: `init takes at most one path; received ${String(positional.length - 1)}.`,
      };
    }
    const mode = flags.includes('--express') ? 'express' : flags.includes('--custom') ? 'custom' : null;
    return {
      ...base,
      kind: 'init',
      repository: first ?? cwd,
      mode,
      refresh: flags.includes('--refresh'),
      error: null,
    };
  }

  if (command === 'prune') {
    const unknownFlag = flags.find((flag) => flag !== '--force');
    if (unknownFlag !== undefined) {
      return { ...base, kind: 'help', error: `Unknown option "${unknownFlag}".` };
    }
    if (first === undefined) {
      return {
        ...base,
        kind: 'help',
        error:
          'prune needs the project id to remove: the SHA of that project\'s first commit (AD-10). ' +
          'It takes an id and never a path, so the directory you are standing in decides nothing.',
      };
    }
    if (rest.length > 0) {
      return {
        ...base,
        kind: 'help',
        error: `prune takes exactly one project id; received ${String(positional.length - 1)}.`,
      };
    }
    return {
      ...base,
      kind: 'prune',
      projectId: first,
      force: flags.includes('--force'),
      error: null,
    };
  }

  return {
    ...base,
    kind: 'help',
    error: command === undefined ? 'No command given.' : `Unknown command "${command}".`,
  };
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
    /**
     * Read through the same pulled-line iterator `ask` uses, for the reason `ask`'s own doc comment
     * gives: a second, independent reader (`rl.question`) would drop whatever arrived before it
     * started listening. Blank, or anything but "express"/"e", is "custom" — the default this
     * question's own field carries, and the behaviour every install had before this choice existed.
     */
    chooseInstallMode: async (): Promise<InstallMode> => {
      process.stderr.write(
        'Two ways to answer what follows: "express" accepts every detected or fixed default ' +
          'silently, asking only about the few things nothing can default; "custom" walks through ' +
          'every question with an explanation of what it collects and why.\n',
      );
      process.stdout.write('Express or custom? (express, custom) [custom]: ');
      const next = await lines.next();
      const typed = (next.done === true ? '' : next.value).trim().toLowerCase();
      return typed === 'express' || typed === 'e' ? 'express' : 'custom';
    },
    close: (): void => {
      rl.close();
    },
  };
};
