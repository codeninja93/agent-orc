/**
 * `src/runner/` — the command runner ADR-004 named as `Bash`'s replacement, and **the only unit in
 * the system that places a step's command inside a container**.
 *
 * ADR-004, decision 2: "The engine supplies a command-runner MCP server through `--mcp-config`, with
 * `--strict-mcp-config` so no other server can load. The server is the only thing in the system that
 * starts a container, and it runs exactly the commands the profile's `mechanics.commands` declares."
 *
 * Five decisions in here are load-bearing, and each is the thing a plausible alternative gets wrong.
 *
 * **It takes a name, never a command.** See `commands.ts`: the tool's input is a closed enum of the
 * profile's declared command names, so an arbitrary command is unsayable rather than refused. A
 * runner that accepted a string would be `Bash` with extra steps and would undo ADR-004 on the day
 * it shipped.
 *
 * **It composes no flag.** AD-20 gives one wrapper sole ownership of every container invocation, and
 * this is not that wrapper: the flag set, the image reference, the mount allow-list and the `--rm`
 * rule all come from `src/container/`, through {@link containedCommandPlan}. What this module
 * decides is *which argv goes inside*, which is exactly the part ADR-001 said changes.
 *
 * **The command runs under the image's shell, inside the boundary.** A declared command is a line a
 * person typed at the interview — `npm run lint`, `pytest -k "not slow"`, `make test && make lint` —
 * and splitting it on whitespace would run `pytest -k '"not' 'slow"'` and report a failure the
 * repository does not have. So the argv placed inside is `/bin/sh -c <the declared line>`. A shell
 * is what the container is *for*: ADR-001 put the boundary around command execution precisely
 * because "arbitrary code — `npm install`, a test suite, a build script — is what actually needs a
 * read-only root, dropped capabilities, seccomp, pid and memory limits and no egress". What must
 * never exist is a shell *outside* the boundary, and after ADR-004 none does.
 *
 * **Output is an evidence pointer, never a return value.** AD-23: the control plane is the typed
 * step input and output plus the checkpoint "and nothing else", and a test suite's stdout is
 * megabytes. The tool answers with an exit status and a path; the bytes go to
 * `runs/<run-id>/evidence/` through the AD-21 pattern sweep, so a credential *shape* cannot land on
 * disk even though nothing credential-shaped is passed into the container to begin with.
 *
 * **Running a declared command is not writing a file on an agent's behalf.** ADR-003 gives
 * `verification` no `Write` and no `Edit` because it must not be able to change what it judges, and
 * ADR-004's reasoning leaves that standing. This tool has one verb and no path parameter: there is
 * nothing a step can ask it to write. What a declared command does to the worktree is the
 * repository's own business — a test run that writes a coverage file is the repository's script
 * doing what it always does — and it is bounded by the one writable mount AD-20 allows.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  MCP_SERVER_NAME,
  MCP_TOOL_CLI_NAMES,
  makeError,
  toJsonSchema,
} from '../contracts/index.js';
import type { MechanicsCommands, OrchError } from '../contracts/index.js';
import {
  CONTAINER_SUBCOMMANDS,
  containerNameFor,
  createImageResolver,
  createPhaseSequencer,
  ensureSessionDir,
  executionPlan,
  sessionDirFor,
} from '../container/index.js';
import type {
  ContainerInvoker,
  ContainerRuntime,
  ImageResolver,
  PhasePlan,
} from '../container/index.js';
import { EVIDENCE_DIR_NAME, redactValue, resolveOrchHome, runPaths } from '../runtime/index.js';

import { DeclaredCommandRequestSchema, declaredCommandFor } from './commands.js';
import type { DeclaredCommandName } from './commands.js';

export * from './commands.js';

/**
 * The shell inside the image that runs a declared command line.
 *
 * An absolute path rather than a `PATH` lookup, for the reason `IMAGE_CLI_PATH` is one: the
 * container has a read-only root and a built environment, and resolving a program name through
 * `PATH` is a dependency on a variable this system deliberately does not carry.
 */
export const IMAGE_SHELL_PATH = '/bin/sh';

/**
 * How long one declared command may run before the runtime kills it.
 *
 * A gate is minutes, not seconds — a cold test suite on a mounted worktree is the slow case ADR-001
 * accepted when it chose per-command container lifetime. The bound exists because the opposite is
 * worse than a slow gate: a hung command with no timeout is a run that never reaches a disposition
 * and a container the AD-32 sweep will not reclaim, because its run is not terminal.
 */
export const DECLARED_COMMAND_TIMEOUT_MS = 15 * 60 * 1000;

/** What one declared command did. The control-plane half; the output is behind `evidence`. */
export interface CommandRunResult {
  readonly command: DeclaredCommandName;
  /** The command line the profile declares for it, verbatim. `''` when it declares none. */
  readonly declared: string;
  readonly outcome: 'passed' | 'failed' | 'skipped';
  /** The exit status the command returned, or `null` for a skipped gate, which ran nothing. */
  readonly exitStatus: number | null;
  /**
   * Where the output was written, relative to the run directory (AD-23), or `''` for a skip.
   *
   * Relative rather than absolute because a pointer is resolved by its reader against the run it
   * belongs to: an absolute path in the control plane is a path that outlives the machine it was
   * true on, and `step.verification` refuses one.
   */
  readonly evidence: string;
  /** The container this command ran in, so the AD-32 sweep and a person can both find it. */
  readonly containerName: string | null;
  /** One line stating what happened, for the event the caller records. */
  readonly summary: string;
}

/** A declared command could not be run at all — which is not the same as a gate that failed. */
export class CommandRunFailed extends Error {
  readonly code = 'container.start_failed';
  readonly orchError: OrchError;

  constructor(command: string, detail: string) {
    const message =
      `The "${command}" command could not be run inside the AD-20 container: ${detail}. This is not ` +
      'a failing gate — nothing ran — and it is reported separately so a container that would not ' +
      'start is never recorded as a repository whose tests fail.';
    super(message);
    this.name = 'CommandRunFailed';
    this.orchError = makeError(this.code, message, detail);
  }
}

export interface CommandRunnerOptions {
  readonly run: string;
  /** The step on whose behalf commands run, for the container name and the AD-32 labels. */
  readonly step: string;
  /** The declared commands, read from the run's AD-9 profile snapshot by the caller. */
  readonly commands: MechanicsCommands;
  /** The run worktree: the one writable mount, and the working directory inside. */
  readonly worktree: string;
  /** The single invocation path into the runtime. Required for a real run; injected by the suite. */
  readonly invoke?: ContainerInvoker;
  readonly runtime?: ContainerRuntime;
  /** A resolver, or a tag for a caller that has already resolved one. */
  readonly image?: ImageResolver | string;
  readonly orchHome?: string;
  readonly sessionDir?: string;
  readonly timeoutMs?: number;
  /**
   * Which attempt of the step these gates belong to, so a re-run names a different container.
   *
   * **This is not cosmetic, and it was measured.** AD-20 forbids `--rm` while a run is live, so the
   * container of a step's first attempt still exists when the step is re-run — and a runner built
   * fresh per attempt starts its own counter at 1, composing the name the previous attempt already
   * took. The runtime then refuses the invocation with "the container name is already in use", the
   * command never runs, and the exit status the refusal carries would be read as a failing gate: a
   * repository reported as having broken tests because of a name. Story 1-5 fixed exactly this for
   * the wrapper; the runner inherits both the problem and the shape of the answer.
   *
   * Defaults to 1, which is correct for a caller that builds one runner per step.
   */
  readonly attempt?: number;
}

/** The runner's surface: one verb, and nothing that takes a path or a command line. */
export interface CommandRunner {
  readonly run: (command: string) => CommandRunResult;
  /** The plan one declared command *would* execute, for a caller asserting the argv (AD-20). */
  readonly planFor: (command: string) => PhasePlan | null;
}

/**
 * Compose the container plan for one declared command.
 *
 * Exported because it is the seam the suite asserts the argv at, and because it is the whole of
 * what this module contributes to an invocation: the image, the flags, the mounts and the `--rm`
 * rule are `src/container/`'s and are passed through untouched. `executionPlan` is what refuses a
 * plan that carries a network and what composes AD-20's set, so a flag added or dropped here is
 * impossible rather than merely unreviewed.
 */
export const containedCommandPlan = (request: {
  readonly image: string;
  readonly run: string;
  readonly step: string;
  readonly attempt: number;
  readonly containerName: string;
  readonly worktree: string;
  readonly sessionDir: string;
  readonly declared: string;
  readonly orchHome: string;
}): PhasePlan =>
  executionPlan({
    image: request.image,
    run: request.run,
    step: request.step,
    attempt: request.attempt,
    containerName: request.containerName,
    worktree: request.worktree,
    sessionDir: request.sessionDir,
    command: IMAGE_SHELL_PATH,
    // `-c` and the declared line as **one** argument: the shell parses it, and this process never
    // does. Building a string and letting a host shell split it is the injection this whole design
    // removes, and there is no host shell left to split it anyway.
    commandArgs: ['-c', request.declared],
    orchHome: request.orchHome,
  });

/** The evidence file one command's output is written to, relative to the run directory (AD-23). */
export const evidencePointerFor = (command: string, attempt: number): string =>
  `${EVIDENCE_DIR_NAME}/${command}-${String(attempt)}.log`;

/**
 * The command runner.
 *
 * In-process rather than only over MCP, because two callers need it and they are not the same
 * caller: the engine runs the deterministic gates *before* it spawns a verification step (CAP-13's
 * economics), and a step granted the tool reaches the same runner over stdio. One implementation is
 * the point — two would be two answers to "what does `test` run here".
 */
export const createCommandRunner = (options: CommandRunnerOptions): CommandRunner => {
  const orchHome = options.orchHome ?? resolveOrchHome();
  const paths = runPaths(options.run, orchHome);
  /** Attempts per command, so a second run of one gate names a second container (AD-20: no `--rm`). */
  const attempts = new Map<string, number>();

  const imageTag = (): string => {
    if (typeof options.image === 'string') return options.image;
    const resolver: ImageResolver | null =
      typeof options.image === 'object'
        ? options.image
        : options.invoke === undefined
          ? null
          : createImageResolver({ invoke: options.invoke });
    if (resolver === null) {
      throw new CommandRunFailed(
        'a declared command',
        'no image and no container invoker were supplied, so the locally built executor image ' +
          '(AD-11) cannot be resolved',
      );
    }
    return resolver.resolve().tag;
  };

  const nextAttempt = (name: string): number => {
    const attempt = (attempts.get(name) ?? 0) + 1;
    attempts.set(name, attempt);
    return attempt;
  };

  /**
   * The container's name: unique per run, step, command, *step attempt* and repeat within one runner.
   *
   * The step attempt is what makes it unique across runner instances, and the repeat count what makes
   * it unique within one. Both are needed and neither is enough: the first alone collides when a
   * caller runs one gate twice, the second alone collides on every re-run of the step.
   */
  const containerFor = (command: string, repeat: number): string =>
    containerNameFor(
      options.run,
      `${options.step}-${command}-${String(options.attempt ?? 1)}`,
      repeat,
    );

  /**
   * The exit status the runtime itself reports when it could not run the container at all.
   *
   * A number rather than a name, because this package may not spell the runtime's (AD-20) — and it
   * is the documented convention: the CLI reserves 125 for "the runtime failed before the command
   * started", leaving the command's own status to travel unchanged. A name collision, an image that
   * vanished and an unreachable daemon all arrive as this.
   *
   * The ambiguity is real and is resolved in the safe direction: a declared command that genuinely
   * exits 125 is reported as a failed *start* rather than as a failed gate. Getting it the other way
   * round is worse by a long way — it sends a person to read their own test suite for a fault in the
   * machine, and it makes a broken environment look like broken code.
   */
  const RUNTIME_COULD_NOT_START = 125;

  const planFor = (command: string): PhasePlan | null => {
    const declared = declaredCommandFor(options.commands, command);
    if (declared.kind === 'skipped') return null;
    const repeat = nextAttempt(declared.name);
    return containedCommandPlan({
      image: imageTag(),
      run: options.run,
      step: options.step,
      attempt: options.attempt ?? 1,
      containerName: containerFor(declared.name, repeat),
      worktree: options.worktree,
      sessionDir: ensureSessionDir(options.sessionDir ?? sessionDirFor(options.run, orchHome)),
      declared: declared.declared,
      orchHome,
    });
  };

  const run = (command: string): CommandRunResult => {
    // Refused here, before anything is composed: an undeclared name never reaches an image, a
    // container name or an evidence file. See `UndeclaredCommandError` for why it throws.
    const declared = declaredCommandFor(options.commands, command);
    if (declared.kind === 'skipped') {
      /**
       * A skip starts no container, and says so.
       *
       * The exit status is `null` rather than `0` because zero is what a command that *ran* and
       * succeeded returns, and a gate with no command has not succeeded at anything. The two are
       * kept apart at every layer — here, in `step.verification`'s refusals, and in the event the
       * caller records — because a skip that reads as a pass is how a repository with no tests
       * appears fully verified.
       */
      return {
        command: declared.name,
        declared: '',
        outcome: 'skipped',
        exitStatus: null,
        evidence: '',
        containerName: null,
        summary:
          `the ${declared.name} gate is skipped: this repository declares no ${declared.name} ` +
          'command, so nothing ran and nothing passed',
      };
    }

    const invoke = options.invoke;
    if (invoke === undefined) {
      throw new CommandRunFailed(
        declared.name,
        'no container invoker was supplied, and a declared command runs inside the AD-20 container ' +
          'or it does not run — falling back to the host is the failure containment exists to prevent',
      );
    }
    const repeat = nextAttempt(declared.name);
    const containerName = containerFor(declared.name, repeat);
    const plan = containedCommandPlan({
      image: imageTag(),
      run: options.run,
      step: options.step,
      attempt: options.attempt ?? 1,
      containerName,
      worktree: options.worktree,
      sessionDir: ensureSessionDir(options.sessionDir ?? sessionDirFor(options.run, orchHome)),
      declared: declared.declared,
      orchHome,
    });

    /**
     * The phase ordering, stated rather than assumed.
     *
     * ADR-001's two-phase sandbox is provisioning-with-a-network then execution-without-one, and
     * `skipProvisioning` is the explicit statement that this command needs nothing installed — which
     * is not the same thing as forgetting to provision, and the sequencer refuses to let it be. The
     * sequencer also re-reads the composed argv and refuses one carrying a network, so "execution
     * has no egress" is enforced on the vector that will run rather than on the call that built it.
     */
    const sequencer = createPhaseSequencer();
    sequencer.skipProvisioning();
    sequencer.beginExecution(plan);

    /**
     * The runtime's *name*, for the evidence header only.
     *
     * Not resolved when an invoker was supplied: the invoker already is the path to the runtime, and
     * `requireContainerRuntime` would refuse on a machine with no binary on `PATH` — which would make
     * an injected invoker unusable and turn "this unit is testable without a daemon" into a claim
     * nothing supports.
     */
    const runtimeName = options.runtime?.name ?? '(the configured container runtime)';
    const result = invoke({
      subcommand: CONTAINER_SUBCOMMANDS.run,
      args: [...plan.args],
      timeoutMs: options.timeoutMs ?? DECLARED_COMMAND_TIMEOUT_MS,
    });
    sequencer.endExecution();

    if (result.status === RUNTIME_COULD_NOT_START) {
      /**
       * Nothing ran, so there is no gate outcome to report — and reporting one would be the lie this
       * refusal exists to prevent. `container.start_failed` is `retry-with-backoff`, which is the
       * right answer for a name still held by a container the sweep has not reclaimed yet and for a
       * daemon that was restarting.
       */
      throw new CommandRunFailed(
        declared.name,
        `the runtime reported ${String(RUNTIME_COULD_NOT_START)} before the command started: ` +
          `${result.stderr.trim() === '' ? result.stdout.trim() : result.stderr.trim()}`,
      );
    }

    const evidence = evidencePointerFor(declared.name, repeat);
    writeEvidence(join(paths.runDir, evidence), {
      runtime: runtimeName,
      container: containerName,
      declared: declared.declared,
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
    });

    /**
     * A status of `null` is the runtime reporting no exit code at all — a timeout, or a signal.
     *
     * It is a *failed* gate rather than a refusal, because something did run and did not succeed,
     * and the run needs a gate outcome it can route on (AD-35). It is not reported as passed, which
     * is the only direction that would be wrong.
     */
    const passed = result.status === 0;
    return {
      command: declared.name,
      declared: declared.declared,
      outcome: passed ? 'passed' : 'failed',
      exitStatus: result.status,
      evidence,
      containerName,
      summary:
        `the ${declared.name} gate ran "${declared.declared}" inside ${containerName} and ` +
        `${passed ? 'passed' : `failed with exit status ${String(result.status ?? -1)}`}; its output ` +
        `is at ${evidence}`,
    };
  };

  return { run, planFor };
};

/**
 * Write one command's output into the run's evidence plane.
 *
 * **Through the AD-21 pattern sweep, with the entropy heuristic off.** The sweep's shape classes —
 * token prefixes, private-key headers, URL user-info — cost nothing and close the case where a
 * repository's own script prints a credential it was given. The entropy heuristic is deliberately
 * disabled: a build log is full of long high-entropy strings that are hashes, base64 fixtures and
 * snapshot digests, and rewriting those would make the evidence unreadable for the one purpose it
 * exists for. Nothing credential-shaped is passed *into* the container in the first place
 * (`composeContainerEnv` refuses it), so this is the second line and not the first.
 */
const writeEvidence = (
  path: string,
  record: {
    readonly runtime: string;
    readonly container: string;
    readonly declared: string;
    readonly status: number | null;
    readonly stdout: string;
    readonly stderr: string;
  },
): void => {
  const body = [
    `# command: ${record.declared}`,
    `# container: ${record.container} (${record.runtime})`,
    `# exit status: ${record.status === null ? '(none reported)' : String(record.status)}`,
    '',
    record.stdout,
    record.stderr === '' ? '' : `--- stderr ---\n${record.stderr}`,
  ].join('\n');
  const swept = redactValue(body, { highEntropyMinLength: Number.POSITIVE_INFINITY });
  mkdirSync(join(path, '..'), { recursive: true });
  /**
   * A pass that failed drops the artifact and writes why, rather than writing what it could not
   * prove clean. AD-21 fails closed and says so: "dropping the artifact and recording a
   * `redaction.failed` event rather than writing unredacted content". The event is the caller's to
   * record — this module writes files, not the log (AD-29) — so what lands here is the placeholder
   * that keeps the pointer resolvable.
   */
  writeFileSync(
    path,
    swept.ok
      ? swept.value
      : `# the output of "${record.declared}" was dropped: the AD-21 redaction pass failed ` +
          `(${swept.reason}), and AD-21 fails closed rather than writing what it could not prove clean\n`,
    'utf8',
  );
};

/* ------------------------------------------------------------------ the MCP surface (ADR-004 #2) */

/**
 * The revision of the Model Context Protocol this server speaks.
 *
 * Declared rather than echoed back from the client: a server that agrees to whatever version it is
 * offered cannot tell a client it is too new, and the failure then arrives as a tool call that is
 * shaped differently from what either side expected.
 */
export const MCP_PROTOCOL_VERSION = '2025-06-18';

/** The tool's name as the server publishes it, and as `--allowedTools` must pre-approve it. */
export const RUNNER_TOOL_NAME = 'run_declared_command';

/** The `mcp__<server>__<tool>` spelling, taken from the declared vocabulary and never re-spelled. */
export const RUNNER_ALLOWED_TOOL = MCP_TOOL_CLI_NAMES.RunDeclaredCommand;

/** The one tool this server serves. ADR-004: "Its tool surface should stay minimal". */
export const runnerToolDescriptor = (
  commands: MechanicsCommands,
): Readonly<Record<string, unknown>> => ({
  name: RUNNER_TOOL_NAME,
  description:
    'Run one of the commands this repository declares, by name, inside the confined container. ' +
    'Declared here: ' +
    Object.entries(commands)
      .map(([name, line]) => `${name} = ${line === '' ? '(none)' : line}`)
      .join('; ') +
    '. A name is all this takes: the command line is the profile’s, and a command with no ' +
    'declaration is reported as skipped rather than run. The output is written to the run’s ' +
    'evidence plane and answered as a pointer, never returned inline.',
  inputSchema: toJsonSchema(DeclaredCommandRequestSchema),
});

/** A JSON-RPC request as this server reads one. Unknown fields are ignored, never rejected. */
export interface JsonRpcRequest {
  readonly jsonrpc?: string;
  readonly id?: string | number | null;
  readonly method?: string;
  readonly params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  readonly jsonrpc: '2.0';
  readonly id: string | number | null;
  readonly result?: unknown;
  readonly error?: { readonly code: number; readonly message: string };
}

/** JSON-RPC's own codes, used for what they mean and nothing else. */
const JSON_RPC_INVALID_PARAMS = -32_602;
const JSON_RPC_METHOD_NOT_FOUND = -32_601;

/**
 * Answer one MCP request.
 *
 * A pure function of the request and the runner, so every behaviour that matters — the refusal for
 * an undeclared name, the shape of the published input schema, a skip reported as a skip — is
 * assertable without a subprocess, a pipe or a daemon. The stdio loop below is the thin part, and
 * the thin part is the part that cannot be tested cheaply.
 *
 * A notification (no `id`) is answered with `null`: JSON-RPC forbids a response to one, and a server
 * that replied anyway would desynchronise a client that is counting responses.
 */
export const handleMcpRequest = (
  runner: CommandRunner,
  commands: MechanicsCommands,
  request: JsonRpcRequest,
): JsonRpcResponse | null => {
  const id = request.id ?? null;
  const respond = (result: unknown): JsonRpcResponse => ({ jsonrpc: '2.0', id, result });
  const fail = (code: number, message: string): JsonRpcResponse => ({
    jsonrpc: '2.0',
    id,
    error: { code, message },
  });

  switch (request.method) {
    case 'initialize':
      return respond({
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: MCP_SERVER_NAME, version: '1' },
      });
    case 'notifications/initialized':
      return null;
    case 'ping':
      return respond({});
    case 'tools/list':
      return respond({ tools: [runnerToolDescriptor(commands)] });
    case 'tools/call': {
      const params = request.params ?? {};
      if (params['name'] !== RUNNER_TOOL_NAME) {
        return fail(
          JSON_RPC_METHOD_NOT_FOUND,
          `This server serves one tool, "${RUNNER_TOOL_NAME}", and nothing named ` +
            `"${String(params['name'])}". ADR-004 keeps the surface minimal on purpose.`,
        );
      }
      /**
       * The arguments are parsed against the schema the tool published, so the closed enum is what
       * refuses an arbitrary command rather than a check written beside it. A call that the CLI's
       * own validation let through — an older client, a hand-written request — meets the same
       * shape here.
       */
      const parsed = DeclaredCommandRequestSchema.safeParse(params['arguments']);
      if (!parsed.success) {
        return fail(
          JSON_RPC_INVALID_PARAMS,
          `Refusing the call: this tool takes the name of a declared command and nothing else. ` +
            `Declared: ${Object.keys(commands).join(', ')}. ` +
            parsed.error.issues
              .map((issue) => `${issue.path.map((part) => String(part)).join('.') || '(root)'}: ${issue.message}`)
              .join('; '),
        );
      }
      try {
        const outcome = runner.run(parsed.data.command);
        return respond({
          // The control-plane answer: a status and a pointer. The output itself stays on disk
          // (AD-23), which is why there is no field here that could carry it.
          content: [{ type: 'text', text: JSON.stringify(outcome) }],
          structuredContent: outcome,
          // A failing gate is a *result*, not a tool error: matrix row 3. `isError` would make the
          // CLI report the tool as broken, and a step would then retry the runner rather than
          // report the gate it just learned about.
          isError: false,
        });
      } catch (thrown: unknown) {
        return fail(
          JSON_RPC_INVALID_PARAMS,
          thrown instanceof Error ? thrown.message : 'the declared command could not be run',
        );
      }
    }
    default:
      return fail(
        JSON_RPC_METHOD_NOT_FOUND,
        `This server implements initialize, tools/list and tools/call, not "${String(request.method)}".`,
      );
  }
};

/**
 * The `--mcp-config` entry that launches this server for a run.
 *
 * Built here and *written* by the caller, because AD-9 puts a run's configuration under the run
 * directory and this module writes only the evidence plane. The shape is the CLI's own
 * `mcpServers` map; `--strict-mcp-config` is what makes this the only server that loads, and it is
 * the spawner that passes it.
 *
 * The interpreter is the absolute Node AD-28 resolved, never `node` from `PATH`: an MCP server is a
 * child of `claude -p`, which is a child of the engine, and a stale version manager two levels down
 * is exactly the opaque failure AD-28 exists to prevent.
 */
export const commandRunnerMcpConfig = (server: {
  readonly nodePath: string;
  readonly entryPoint: string;
  readonly run: string;
  readonly step: string;
  readonly orchHome: string;
}): Readonly<Record<string, unknown>> => ({
  mcpServers: {
    [MCP_SERVER_NAME]: {
      command: server.nodePath,
      args: [server.entryPoint],
      env: {
        ORCH_HOME: server.orchHome,
        ORCH_RUN: server.run,
        ORCH_STEP: server.step,
      },
    },
  },
});

/**
 * Serve the runner over a pair of streams, which is what `--mcp-config` starts.
 *
 * MCP's stdio transport is newline-delimited JSON-RPC, so the loop is a split on `\n` and nothing
 * more. It takes the streams rather than reaching for `process.stdin`, for the reason every port in
 * this codebase takes its dependency: a transport that can only be driven by starting a subprocess
 * is a transport nothing asserts, and the one thing that must not be got wrong here — a malformed
 * line must not kill the server, because the step on the other end would then hang for ever waiting
 * for an answer — is only observable from inside.
 *
 * A line that is not whole JSON is answered with a parse error and the loop continues. There is
 * nowhere else to report it: no unit writes diagnostics to stdout, and stdout here is the protocol.
 */
export const serveCommandRunnerOverStdio = (
  runner: CommandRunner,
  commands: MechanicsCommands,
  input: NodeJS.ReadableStream,
  output: NodeJS.WritableStream,
): void => {
  let buffered = '';
  const send = (message: JsonRpcResponse): void => {
    output.write(`${JSON.stringify(message)}\n`);
  };
  input.setEncoding('utf8');
  input.on('data', (chunk: string | Buffer) => {
    buffered += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    const lines = buffered.split('\n');
    buffered = lines.pop() ?? '';
    for (const line of lines) {
      if (line.trim() === '') continue;
      let request: JsonRpcRequest;
      try {
        request = JSON.parse(line) as JsonRpcRequest;
      } catch {
        send({
          jsonrpc: '2.0',
          id: null,
          error: { code: -32_700, message: 'the line was not whole JSON and was skipped' },
        });
        continue;
      }
      const response = handleMcpRequest(runner, commands, request);
      if (response !== null) send(response);
    }
  });
};
