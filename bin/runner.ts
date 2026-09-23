#!/usr/bin/env node
/**
 * The command runner's entry point: the process `--mcp-config` starts, per ADR-004.
 *
 * ADR-004 decision 2 says the engine "supplies a command-runner MCP server through `--mcp-config`",
 * and a config naming a command that does not exist serves nothing. Until this file existed the
 * roster granted `RunDeclaredCommand` to two agents, `commandRunnerMcpConfig` could describe the
 * server, and nothing could start it — so the grant was inert and the first real spawn refused for
 * want of a config.
 *
 * It owns the environment in and a stream pair out, and nothing else. Everything it calls is in
 * `src/runner/`, where the same typecheck, lint and tests reach it — an entry point is the one file
 * a test cannot easily drive, so the less that lives here the better. `bin/init.ts` is the same
 * shape for the same reason.
 *
 * **It is delivered as JavaScript**, like `bin/init.ts`: Node refuses to strip types for a file
 * under `node_modules` (`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`), and an installed package is
 * exactly that. `prepare` compiles it to `dist/bin/runner.js`, which is what `package.json` names
 * and what the generated config points at.
 *
 * **Nothing here writes to stdout but the protocol.** stdout *is* the transport, so a diagnostic
 * printed there would be read as a malformed JSON-RPC message by the step on the other end — which
 * is the Consistency Conventions' "no unit writes diagnostics to stdout" holding for a reason
 * stronger than tidiness. A refusal goes to stderr and exits non-zero, where the CLI reports it as a
 * server that would not start rather than as a tool that answered strangely.
 */
import { createCommandRunnerFromEnvironment, serveCommandRunnerOverStdio } from 'agent-orcastrator/runner';

const main = (): number => {
  let assembled;
  try {
    assembled = createCommandRunnerFromEnvironment(process.env);
  } catch (error: unknown) {
    process.stderr.write(
      `${error instanceof Error ? error.message : 'the command runner could not be started'}\n`,
    );
    return 1;
  }
  serveCommandRunnerOverStdio(assembled.runner, assembled.commands, process.stdin, process.stdout);
  // No exit: the server lives as long as its stdin is open, which is as long as the step that
  // started it is running. Returning here would close the transport before the first call.
  return 0;
};

const code = main();
if (code !== 0) process.exit(code);
