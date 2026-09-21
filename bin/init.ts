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
 *   0  the install completed, or `--help`/`--version` answered
 *   1  a refusal — not a repository, no commits, an unreadable `schema_version`, an abandoned
 *      interview. Nothing was written, or what was written is described by the manifest.
 *   2  the arguments themselves were wrong, so nothing was attempted.
 */
import {
  InstallRefusal,
  PACKAGE_VERSION,
  USAGE,
  parseInitArguments,
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

  const io = terminalIo();
  try {
    const outcome = await runInit({ repository: parsed.repository, io });
    // R3 — the headline stands alone; the detail is one line per file and nothing more.
    process.stdout.write(`${outcome.summary}\n`);
    for (const file of outcome.dispositions) {
      process.stdout.write(`  ${file.disposition.padEnd(9)} ${file.path}\n`);
    }
    for (const finding of outcome.recovered) {
      process.stdout.write(`  recovered ${finding.path} (was ${finding.reason})\n`);
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
