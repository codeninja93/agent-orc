#!/usr/bin/env node
/**
 * AD-12's entry point: `npx github:<owner>/<repo> init`.
 *
 * It owns process arguments in and an exit code out, and nothing else. Everything it calls is in
 * `src/installer/`, where it is covered by the same typecheck, lint and tests as the rest of the
 * package — an entry point is the one file a test cannot easily reach, so the less that lives here
 * the better.
 *
 * **It is delivered as JavaScript, not as TypeScript.** The Stack table says this file is the reason
 * the Node floor is 22.18, "being where native TypeScript type stripping lands, which the
 * `bin/init.ts` npx entry point requires". Measured, that is not how it ends up working: Node
 * refuses to strip types for any file under `node_modules`
 * (`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`), and `npx` installs this package into exactly
 * that. So the delivery path compiles this file to `dist/bin/init.js` in `prepare`, and the
 * `package.json` `bin` field names the compiled file. The source stays here, where the spine's
 * layout puts it.
 *
 * Exit codes are the contract a script calling this depends on:
 *   0  the install completed, the prune completed or found nothing to remove, or `--help`/`--version`
 *      answered
 *   1  a refusal — not a repository, no commits, an unreadable `schema_version`, an abandoned
 *      interview, or a prune of a project that still resolves. Nothing was written or removed, or
 *      what was written is described by the manifest.
 *   2  the arguments themselves were wrong, so nothing was attempted.
 *
 * `prune` naming an id nothing is registered under exits 0 rather than 1, because the state the
 * command asked for is the state that holds: there is no central state for that project. A prune
 * *refused* because the project is alive is the failure, and it is the one a script must be able to
 * see, so it is the one that exits non-zero.
 */
import {
  InstallRefusal,
  PACKAGE_VERSION,
  USAGE,
  parseInitArguments,
  pruneProject,
  runInit,
  terminalIo,
} from 'agent-orcastrator/installer';

const main = async (argv: readonly string[]): Promise<number> => {
  const parsed = parseInitArguments(argv);

  if (parsed.kind === 'version') {
    process.stdout.write(`${PACKAGE_VERSION}\n`);
    return 0;
  }
  if (parsed.kind === 'help') {
    if (parsed.error === null) {
      process.stdout.write(`${USAGE}\n`);
      return 0;
    }
    process.stderr.write(`${parsed.error}\n\n${USAGE}\n`);
    return 2;
  }

  /**
   * AD-9's prune, which is the only thing in the system that deletes central state.
   *
   * It is handled before the interview's terminal is opened, because it asks nothing: the id names
   * what to remove, and a project that still resolves is refused rather than confirmed at a prompt —
   * a prompt would make the safe default depend on what a person typed under time pressure.
   */
  if (parsed.kind === 'prune' && parsed.projectId !== null) {
    try {
      const outcome = pruneProject(parsed.projectId, { force: parsed.force });
      const stream = outcome.kind === 'refused' ? process.stderr : process.stdout;
      stream.write(`${outcome.summary}\n`);
      if (outcome.kind === 'pruned') {
        for (const path of outcome.removed) process.stdout.write(`  removed   ${path}\n`);
      }
      return outcome.kind === 'refused' ? 1 : 0;
    } catch (error) {
      // An id that is not an id — a path, most likely — arrives here as a named refusal from the
      // runtime rather than as a usage error, because it is the *value* that is wrong and the parser
      // has no business knowing what a project id looks like.
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      return 1;
    }
  }

  const io = terminalIo();
  try {
    const outcome = await runInit({
      repository: parsed.repository,
      io,
      refresh: parsed.refresh,
      ...(parsed.mode === null ? {} : { mode: parsed.mode }),
    });
    // R3 — the headline stands alone; the detail is one line per file and nothing more.
    process.stdout.write(`${outcome.summary}\n`);
    for (const file of outcome.dispositions) {
      process.stdout.write(`  ${file.disposition.padEnd(9)} ${file.path}\n`);
    }
    for (const finding of outcome.recovered) {
      process.stdout.write(`  recovered ${finding.path} (was ${finding.reason})\n`);
    }
    // Advice, not detail — kept off stdout's own one-line-per-file shape and given room to itself.
    for (const advisory of outcome.advisories) {
      process.stderr.write(`\n${advisory}\n`);
    }
    return 0;
  } catch (error) {
    // A refusal is the expected shape of "this cannot be installed", and it already names what was
    // needed. Anything else keeps its stack, because nobody can act on a summary of a fault.
    if (error instanceof InstallRefusal) {
      process.stderr.write(`${error.message}\n`);
      return 1;
    }
    if (error instanceof Error) {
      process.stderr.write(`${error.stack ?? error.message}\n`);
      return 1;
    }
    throw error;
  } finally {
    io.close();
  }
};

// `exitCode` rather than `exit()`: the readline interface is closed in the `finally` above, and
// `exit()` would terminate before it ran and before stdout had drained.
process.exitCode = await main(process.argv.slice(2));
