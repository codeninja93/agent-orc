#!/usr/bin/env node
/**
 * The Jira tool server's entry point: the process `--mcp-config` starts for a step granted a Jira
 * operation, per story 2-10.
 *
 * `bin/runner.ts`'s own reasoning, one domain over: a config naming a command that does not exist
 * serves nothing, so this file has to exist at `dist/bin/jira-server.js` for the grant to be anything
 * but inert. Everything it calls lives in `src/tool-servers/jira/`, where the same typecheck, lint and
 * tests reach it; this file owns the environment in and a stream pair out, and nothing else.
 *
 * **Delivered as JavaScript**, for the reason `bin/runner.ts` and `bin/init.ts` are: Node refuses to
 * strip types for a file under `node_modules`, and an installed package is exactly that. `prepare`
 * compiles it to `dist/bin/jira-server.js`, which `package.json`'s `bin` field names and which the
 * generated `--mcp-config` points at.
 *
 * **Nothing here writes to stdout but the protocol.** stdout *is* the transport; a refusal goes to
 * stderr and exits non-zero, where the CLI reports it as a server that would not start.
 *
 * **Closes the fetch record's own handle on stdin end, a process signal, or a crash.** The server
 * obtains this run's fetch record through `RunFetchRecord.openStandalone()`, which holds a dedicated
 * lock over `fetch-record.json` for as long as this instance is open (story 2-10, review pass 1's
 * amendment). Releasing it here — rather than relying only on process exit — is what lets the *next*
 * short-lived Jira server for this run (the next step granted a Jira operation) open cleanly rather
 * than reclaim a lock this process could have released on its own.
 *
 * **A signal handler must still end the process.** Registering a `SIGTERM`/`SIGINT` listener replaces
 * Node's default terminate-on-signal behaviour with whatever the listener does, so a handler that only
 * released the lock and returned would leave the process alive to be killed a second, harder way. Each
 * handler calls `process.exit()` itself, after the lock is released.
 *
 * **An uncaught exception or rejection releases the lock before the process dies.** Node's own default
 * behaviour for either is to crash the process anyway; what a guard adds is running `release()` first,
 * so a synchronous throw does not leave a stale lock file for the next opener's pid-liveness reclaim to
 * clean up instead.
 */
import { createJiraServerFromEnvironment, serveJiraServerOverStdio } from 'agent-orcastrator/tool-servers/jira';

/** The conventional shell exit code for a process that died to a signal: 128 + the signal's number. */
const SIGNAL_EXIT_CODES: Readonly<Record<'SIGTERM' | 'SIGINT', number>> = {
  SIGINT: 130,
  SIGTERM: 143,
};

const main = (): number => {
  let assembled;
  try {
    assembled = createJiraServerFromEnvironment(process.env);
  } catch (error: unknown) {
    process.stderr.write(
      `${error instanceof Error ? error.message : 'the Jira tool server could not be started'}\n`,
    );
    return 1;
  }

  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    assembled.fetchRecord.close();
  };

  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => {
      release();
      process.exit(SIGNAL_EXIT_CODES[signal]);
    });
  }

  // A crash releases the lock before Node's own default behaviour ends the process; neither handler
  // calls `process.exit()` itself, so Node's default non-zero exit for an uncaught error still applies.
  process.once('uncaughtException', (error: unknown) => {
    release();
    process.stderr.write(
      `${error instanceof Error ? error.message : 'the Jira tool server crashed unexpectedly'}\n`,
    );
    process.exit(1);
  });
  process.once('unhandledRejection', (error: unknown) => {
    release();
    process.stderr.write(
      `${error instanceof Error ? error.message : 'the Jira tool server crashed unexpectedly'}\n`,
    );
    process.exit(1);
  });

  serveJiraServerOverStdio(assembled.server, process.stdin, process.stdout, release);
  // No exit: the server lives as long as its stdin is open, which is as long as the step that
  // started it is running.
  return 0;
};

const code = main();
if (code !== 0) process.exit(code);
