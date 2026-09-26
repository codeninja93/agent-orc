#!/usr/bin/env node
/**
 * Story 3-1's entry point: resolve `ORCH_HOME`, start the loopback web control surface, print the
 * bound port.
 *
 * It owns the environment in and an exit code out, and nothing else. Everything it calls is in
 * `src/web/`, where it is covered by the same typecheck, lint and tests as the rest of the package —
 * the same reason `bin/orch-run.ts` is this thin. It is TypeScript, not pre-compiled JavaScript like
 * `bin/init.ts`/`bin/runner.ts`: it is not part of the type-stripped `npx` install path those two
 * exist for, so `tsconfig.bin.json` compiling it to `dist/bin/orch-web.js` at `prepare` time is enough.
 *
 * **Nothing here writes to stdout but the bound port**, the one fact a caller scripting this needs
 * (Consistency Conventions: "no unit writes diagnostics to stdout"). `ORCH_HOME` and a startup refusal
 * both go to stderr.
 *
 * With no server started at all, every steering control still works through the AD-19 file path this
 * server only accelerates — starting this process is optional, never a precondition for a run.
 */
import { startWebServer } from 'agent-orcastrator/web';

const PORT_ENV_VAR = 'ORCH_WEB_PORT';

/** A whole string of digits only — `Number.parseInt` on its own accepts "8080abc" as 8080. */
const WHOLE_NUMBER_PATTERN = /^\d+$/;

const parsePort = (raw: string | undefined): number | null => {
  if (raw === undefined || raw.trim() === '') return 0;
  const trimmed = raw.trim();
  if (!WHOLE_NUMBER_PATTERN.test(trimmed)) return null;
  const parsed = Number.parseInt(trimmed, 10);
  return parsed <= 65_535 ? parsed : null;
};

const main = async (): Promise<number> => {
  const port = parsePort(process.env[PORT_ENV_VAR]);
  if (port === null) {
    process.stderr.write(
      `${PORT_ENV_VAR} must be an integer between 0 and 65535; got "${process.env[PORT_ENV_VAR] ?? ''}"\n`,
    );
    return 2;
  }

  let handle;
  try {
    handle = await startWebServer({ port });
  } catch (error: unknown) {
    process.stderr.write(
      `${error instanceof Error ? error.message : 'the web server could not be started'}\n`,
    );
    return 1;
  }

  process.stderr.write(`orch-web: ORCH_HOME=${handle.orchHome}\n`);
  process.stdout.write(`${String(handle.port)}\n`);

  const shutdown = (): void => {
    void handle.close().then(() => {
      process.exit(0);
    });
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  // No exit here: the process stays up for as long as the server is listening, exactly like
  // `bin/runner.ts` stays up for as long as its stdin is open.
  return 0;
};

main()
  .then((code) => {
    if (code !== 0) process.exitCode = code;
  })
  .catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : 'unknown error'}\n`);
    process.exitCode = 1;
  });
