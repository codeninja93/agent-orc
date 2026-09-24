#!/usr/bin/env node
/**
 * Story 2-11's first real entry point: drive one already-confirmed feature, in a real repository,
 * through a real `Reconciler` to a terminal state — `git push`, a real pull request, an `awaiting_merge`
 * wait, and (once a person merges it) the AD-22 note on the real merge commit.
 *
 * It owns process arguments in and an exit code out, and nothing else. Everything it calls is in
 * `src/assembly/`, where the same typecheck, lint and tests as the rest of the package reach it — the
 * same reason `bin/init.ts` and `bin/runner.ts` are this thin.
 *
 * **Usage:** `orch-run [--resume <run-id>] <repository> <spec.json>`, where `spec.json` is
 * `{ "feature": "kebab-slug", "request": "...", "acceptance_criteria": ["..."] }` — CAP-1 through CAP-4's
 * interview is what ordinarily produces this; this entry point takes its output rather than rebuilding
 * the interview. `--resume <run-id>` picks an already-accepted run back up — the timeout error a run
 * parked in `awaiting_merge` past `maxPasses` reports names exactly this flag, because re-running with no
 * `--resume` always mints a *new* run and leaves the parked one behind, still waiting.
 *
 * **Preconditions this file asserts rather than performs.** `<repository>` must already be
 * `.orch/`-installed (`npx github:<owner>/<repo> init`, AD-12) — a repository with none refuses here,
 * naming the missing profile, rather than three steps into a run. `gh` and `git` must be on `PATH` and
 * authenticated for the pull request and the branch-protection probe to do anything but report
 * "unverified".
 *
 * **Nothing here writes to stdout but the run's own outcome.** Progress, and the pull-request URL the
 * moment it is known, go to stderr as the run advances (Consistency Conventions: "no unit writes
 * diagnostics to stdout"); the final line on stdout is the one fact a caller scripting this needs — the
 * run id, its terminal state, and the worktree it finished in.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { parseConfirmedFeatureSpec, runFeatureToCompletion } from 'agent-orcastrator/assembly';
import type { ConfirmedFeatureSpec } from 'agent-orcastrator/assembly';

const USAGE = 'Usage: orch-run [--resume <run-id>] <repository> <spec.json>\n';

interface ParsedArgv {
  readonly resume: string | null;
  readonly positional: readonly string[];
}

/** Pulls `--resume <run-id>` out of the argument list, wherever it appears; everything else is positional. */
const parseArgv = (argv: readonly string[]): ParsedArgv | null => {
  const positional: string[] = [];
  let resume: string | null = null;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--resume') {
      const value = argv[index + 1];
      if (value === undefined) return null;
      resume = value;
      index += 1;
      continue;
    }
    positional.push(arg ?? '');
  }
  return { resume, positional };
};

const main = async (argv: readonly string[]): Promise<number> => {
  const parsedArgv = parseArgv(argv);
  if (parsedArgv?.positional.length !== 2) {
    process.stderr.write(USAGE);
    return 2;
  }
  const [repositoryArg, specPathArg] = parsedArgv.positional;
  const repository = resolve(repositoryArg ?? '');
  const specPath = resolve(specPathArg ?? '');

  let spec: ConfirmedFeatureSpec;
  try {
    spec = parseConfirmedFeatureSpec(readFileSync(specPath, 'utf8'));
  } catch (error: unknown) {
    process.stderr.write(
      `${error instanceof Error ? error.message : 'the spec file could not be read'}\n`,
    );
    return 2;
  }

  try {
    const outcome = await runFeatureToCompletion({
      repository,
      spec,
      ...(parsedArgv.resume === null ? {} : { run: parsedArgv.resume }),
      onProgress: (action): void => {
        process.stderr.write(`[${action.run}] ${action.from} -> ${action.to} (${action.kind})\n`);
      },
      onPullRequestUrl: (url): void => {
        process.stderr.write(`Pull request opened: ${url}\n`);
      },
    });
    process.stdout.write(`${JSON.stringify(outcome)}\n`);
    return 0;
  } catch (error: unknown) {
    process.stderr.write(`${error instanceof Error ? error.message : 'the run failed'}\n`);
    return 1;
  }
};

const argv = process.argv.slice(2);
main(argv)
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : 'unknown error'}\n`);
    process.exitCode = 1;
  });
