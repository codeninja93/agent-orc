/**
 * AD-1 — the real {@link StepExecutor}: one `claude -p` subprocess per step attempt.
 *
 * Story 1-3 defined the port and drove a scripted double, so until now no step had ever run. This is
 * the unit that actually spawns, and it is where the system's permission surface is fixed. Five
 * decisions in here are load-bearing, and each is the thing some plausible alternative gets wrong:
 *
 * **The flag set is a declared constant, not a call-site list.** {@link AD1_REQUIRED_FLAGS} names
 * `--json-schema`, `--output-format`, `--strict-mcp-config` and `--restricted`, and the suite asserts
 * the built argv against it. A missing `--restricted` or `--strict-mcp-config` silently *widens* the
 * permission surface — the target repository's own `.mcp.json` and hooks become able to introduce
 * tools and credentials — and nothing about the run looks different when it happens. That is the
 * failure mode AD-1 exists to close, so the flags are asserted rather than trusted.
 *
 * **The session id is reported before anything else can happen to the attempt.** `onSessionId` is
 * called synchronously from the stdout handler the instant the CLI announces the id, not on
 * termination, because a crash after the spawn and before the termination is precisely the case a
 * resume exists for (AD-8). At most once per attempt, enforced in the stream parser.
 *
 * **`structured_output` is re-parsed against the originating Zod schema before `completed` is
 * returned.** An output that fails the re-parse never reaches the loop: it becomes a `failed`
 * termination carrying `step.schema_invalid_output`, whose AD-35 disposition is `escalate-model-tier`,
 * which is exactly the Stack's promotion trigger for a second schema-invalid output.
 *
 * **A signal with no terminal output is `interrupted`, never `failed`.** `interrupted` is the only
 * resumable disposition, so getting this backwards makes resume dead code and turns every interruption
 * into a re-run from scratch — and a naive test still passes, because a re-run also eventually
 * succeeds. The mapping is therefore asserted directly.
 *
 * **The container is a seam, not a flag.** AD-20 gives one wrapper sole ownership of every container
 * invocation, and that wrapper is story 1-5. So this unit builds a {@link SpawnPlan} — a command, an
 * argument vector, a cwd and an environment — and runs whatever {@link StepSpawnerOptions.wrap}
 * returns. Story 1-5 supplies a wrapped vector, and no container-runtime name appears anywhere in
 * `src/engine/`, which is asserted rather than left to discipline.
 *
 * Everything observable goes through the runtime recorder (AD-29). This unit never opens
 * `events.jsonl`, never assigns `seq` and never writes to stdout.
 */
import { spawn } from 'node:child_process';
import { statSync } from 'node:fs';

import {
  exportContract,
  getContract,
  makeError,
  renderCause,
  StepOutputSchema,
} from '../contracts/index.js';
import type { JsonSchema, ModelRung, OrchError, StepOutput } from '../contracts/index.js';
import type { Recorder } from '../runtime/index.js';

import {
  ApiKeyModeRefusedError,
  ClaudeCliUnavailableError,
  ClaudeCliVersionError,
  isSubscriptionApiKeySource,
  resolveClaudeCliOnce,
} from './cli.js';
import type { ClaudeCli } from './cli.js';
import {
  ChildNodeUnavailableError,
  childEnvWithNode,
  resolveChildNodeOnce,
} from './node-path.js';
import type { ChildNode } from './node-path.js';
import { createStreamParser } from './stream.js';
import type { ResultRecord, StreamRecord } from './stream.js';
import { ResumeRefused, StepSpawnFailed, terminated } from './executor.js';
import type {
  StepExecutor,
  StepResumeRequest,
  StepStartRequest,
  StepTermination,
} from './executor.js';

/** The emitter name every event this unit originates carries. */
export const SPAWNER_EMITTER = 'engine.spawner';

/**
 * The event vocabulary this unit adds.
 *
 * None of these is a type the AD-4 fold acts on, and that is deliberate: `step.started`,
 * `step.session_recorded` and `step.terminated` belong to the reconciler, which mints them from its
 * own decisions. A spawner emitting them too would have the fold count one step twice. AD-5's
 * ignore-unknown-types rule makes adding these safe without a contracts change, and
 * `agent.tool_used` and `permission.denied` are already in the declared vocabulary.
 */
export const SPAWNER_EVENT_TYPES = {
  /** One `claude -p` process was created: the argv flags, the CLI version, the AD-28 child Node. */
  AgentSpawned: 'agent.spawned',
  /** The subprocess announced its session id (AD-8). Carried in the envelope, never the payload. */
  AgentSessionAnnounced: 'agent.session_announced',
  /** A tool the agent used. `parent_tool_use_id` preserved verbatim (AD-5). */
  AgentToolUsed: 'agent.tool_used',
  /** The permission layer refused a tool call. */
  PermissionDenied: 'permission.denied',
  /** A stream line that was not whole JSON. Recorded and skipped; the attempt continues. */
  AgentStreamUnparseable: 'agent.stream_unparseable',
  /** The process ended: exit code or signal, and the disposition it was mapped to. */
  AgentExited: 'agent.exited',
  /** A terminal `structured_output` that failed AD-1's re-parse. Never returned to the loop. */
  AgentOutputRejected: 'agent.output_rejected',
  /** The child wrote to stderr. Evidence, kept bounded; the payload passes the AD-21 pass. */
  AgentStderr: 'agent.stderr',
} as const;

export type SpawnerEventType = (typeof SPAWNER_EVENT_TYPES)[keyof typeof SPAWNER_EVENT_TYPES];

/**
 * The AD-1 flags every spawn carries, asserted by the suite rather than trusted to a call site.
 *
 * `--output-format` is named without its value because the assertion is about presence; the value is
 * asserted separately, as `stream-json` and nothing else.
 */
export const AD1_REQUIRED_FLAGS = [
  '--json-schema',
  '--output-format',
  '--strict-mcp-config',
  '--restricted',
] as const;

/** The one accepted `--output-format`. The parser in `stream.ts` reads this and only this. */
export const STREAM_OUTPUT_FORMAT = 'stream-json';

/** How much of the child's stderr is kept, for a refusal message and one bounded event. */
export const STDERR_TAIL_LIMIT = 2000;

/** Signals the CLI is stopped with when the executor is asked to stop a step. */
export const EXECUTOR_KILL_SIGNAL = 'SIGTERM';

/**
 * Patterns a refused resume is recognised by, read off the CLI's own stderr.
 *
 * A refusal is also inferred structurally — a resume whose child never announced a session id did not
 * find the session — so these are a second, narrower signal rather than the only one. Matching on
 * text alone would make the refusal depend on a message this system does not own.
 */
const RESUME_REFUSAL_PATTERNS = [
  /no conversation found/i,
  /session .*not found/i,
  /could not (?:be )?resume/i,
  /invalid session/i,
  /unknown session/i,
];

/** What the executor is about to run. The seam story 1-5's container wrapper plugs into (AD-20). */
export interface SpawnPlan {
  /** The executable. By default the absolute child Node, or the CLI itself when it is a binary. */
  readonly command: string;
  /** Its complete argument vector, the CLI argv included. */
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  /** The CLI argv alone, before any interpreter or wrapper prefixed it. Asserted by the suite. */
  readonly cliArgs: readonly string[];
  /** The resolved CLI. */
  readonly cli: ClaudeCli;
  /** The AD-28 child Node: an absolute path and the version proven behind it. */
  readonly node: ChildNode;
  /** The step this plan belongs to, so a wrapper can name the worktree it mounts. */
  readonly step: string;
  readonly run: string;
}

/**
 * The container seam. Story 1-5 supplies a function returning a plan whose `command` is the wrapper,
 * leaving everything else intact. The default is the identity.
 */
export type SpawnWrapper = (plan: SpawnPlan) => SpawnPlan;

export interface StepSpawnerOptions {
  /**
   * The recorder for a run. The caller owns the AD-29 single-writer claim and hands the same recorder
   * the reconciler is already writing through; the spawner never opens a log of its own.
   */
  readonly recorderFor: (run: string, feature: string) => Recorder;
  /** The resolved CLI, or a thunk resolving it lazily. Defaults to the `cli.ts` preflight. */
  readonly cli?: ClaudeCli | (() => ClaudeCli);
  /** The resolved child Node, or a thunk. Defaults to the `node-path.ts` resolution (AD-28). */
  readonly node?: ChildNode | (() => ChildNode);
  /** AD-20's seam. Story 1-5 supplies the container wrapper here. */
  readonly wrap?: SpawnWrapper;
  /** MCP server configs passed with `--mcp-config`. This story passes them; story 2-10 writes them. */
  readonly mcpConfigs?: readonly string[];
  /** The environment the child inherits, before the AD-28 Node entries are added. */
  readonly env?: NodeJS.ProcessEnv;
  /** The prompt a step is given. Overridable so a suite can assert argv without asserting prose. */
  readonly promptFor?: (request: StepStartRequest) => string;
  /** The draft-7 export for a contract id. Defaults to the AD-2 registry export. */
  readonly schemaFor?: (contractId: string) => JsonSchema;
}

/** The executor, plus the two things a caller and a suite legitimately need to see. */
export interface StepSpawner extends StepExecutor {
  /** The plan the most recent attempt executed. Read by the suite; never by the loop. */
  readonly lastPlan: () => SpawnPlan | null;
  /**
   * Stop a running step. The resulting termination is `killed`, which AD-8 never resumes or re-runs —
   * this is the executor-initiated stop a steering command reaches the executor as.
   */
  readonly kill: (step: string) => boolean;
  /** Stop every running step. For a caller shutting down. */
  readonly killAll: () => void;
}

/**
 * The prompt a step agent is given.
 *
 * It names the typed input file rather than carrying its contents: a step is a pure function over
 * exactly that file (AD-23), and a re-run must read the same bytes (CAP-6). It carries no timestamp
 * and no attempt number, so two attempts at one step are byte-identical invocations — which is what
 * makes a re-run a re-run rather than a different request.
 */
export const defaultPromptFor = (request: StepStartRequest): string =>
  [
    `You are running step "${request.step}" (${request.phase}) of feature "${request.feature}".`,
    `Read the typed step input file at ${request.inputPath}. It is the complete statement of this`,
    'step: the original request, the acceptance criteria, the decisions already taken and pointers to',
    'the evidence you may read. Work only inside the current working directory.',
    `Finish by producing the structured output required by the "${request.contractId}" contract, with`,
    `its \`step\` field set to "${request.step}". Report status "blocked" rather than guessing if the`,
    'input does not determine what to do.',
  ].join(' ');

export interface StepArgvOptions {
  /** The draft-7 export of the registered contract (AD-2). Passed to `--json-schema`. */
  readonly schema: JsonSchema;
  readonly prompt: string;
  readonly model: ModelRung;
  readonly mcpConfigs?: readonly string[];
  /** Present only for a resume, and only ever the recorded session id (AD-8). */
  readonly resumeSessionId?: string | null;
}

/**
 * The AD-1 argv.
 *
 * `--verbose` is here because the CLI requires it alongside `--print --output-format stream-json`; it
 * is a precondition of the stream this story parses, not a diagnostic choice, and no unit writes
 * diagnostics to stdout regardless.
 *
 * `--mcp-config` is passed only when servers were supplied. `--strict-mcp-config` is passed either
 * way, and that asymmetry is the point: with no servers supplied, strict mode means *no* MCP server
 * loads, which is a narrower surface than omitting both flags and letting the repository's own
 * `.mcp.json` decide.
 */
export const buildStepArgv = (options: StepArgvOptions): readonly string[] => {
  const argv: string[] = [
    '--print',
    options.prompt,
    '--output-format',
    STREAM_OUTPUT_FORMAT,
    '--verbose',
    '--json-schema',
    JSON.stringify(options.schema),
    '--strict-mcp-config',
    '--restricted',
    '--model',
    options.model,
  ];
  const configs = options.mcpConfigs ?? [];
  if (configs.length > 0) argv.push('--mcp-config', ...configs);
  const resume = options.resumeSessionId ?? null;
  if (resume !== null) argv.push('--resume', resume);
  return argv;
};

/** Which flags of {@link AD1_REQUIRED_FLAGS} an argv is missing. Empty means the contract holds. */
export const missingRequiredFlags = (argv: readonly string[]): readonly string[] =>
  AD1_REQUIRED_FLAGS.filter((flag) => !argv.includes(flag));

/**
 * Map a result line that is not a usable success onto an AD-35 code.
 *
 * `error_max_turns` is a ceiling the CLI hit, which a later attempt with a fresh budget can clear, so
 * it takes `step.timed_out` (`retry-with-backoff`). Anything else that ends the stream without a
 * usable terminal output is `step.stream_malformed`, also retryable: the attempt produced nothing for
 * the table to judge, and the honest statement is that the stream did not deliver an output.
 */
export const errorCodeForResult = (result: ResultRecord): string =>
  result.subtype === 'error_max_turns' ? 'step.timed_out' : 'step.stream_malformed';

/**
 * Preflight refusals that already name their own AD-35 code, and so are re-raised unchanged rather
 * than relabelled as a spawn failure. See {@link createStepSpawner} for why that distinction matters.
 */
const KEEPS_ITS_OWN_CODE = [
  ApiKeyModeRefusedError,
  ClaudeCliVersionError,
  ChildNodeUnavailableError,
] as const;

/** What one attempt observed. Everything the disposition mapping is a function of. */
interface AttemptOutcome {
  readonly sessionId: string | null;
  readonly result: ResultRecord | null;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stderrTail: string;
  /** True when this executor stopped the child, which is what distinguishes `killed` (AD-8). */
  readonly killedByExecutor: boolean;
  /** Set when the CLI reported an `apiKeySource` other than the subscription login. */
  readonly apiKeySource: string | null;
}

const resolveThunk = <T>(value: T | (() => T) | undefined, fallback: () => T): T => {
  if (value === undefined) return fallback();
  return typeof value === 'function' ? (value as () => T)() : value;
};

/** The bounded stderr tail: the last {@link STDERR_TAIL_LIMIT} characters, never the whole stream. */
const appendTail = (tail: string, chunk: string): string => {
  const joined = tail + chunk;
  return joined.length <= STDERR_TAIL_LIMIT ? joined : joined.slice(-STDERR_TAIL_LIMIT);
};

export const createStepSpawner = (options: StepSpawnerOptions): StepSpawner => {
  /** Children in flight, by step name, so a steering kill can reach one. */
  const live = new Map<string, { readonly stop: () => void }>();
  /** Session ids a resume has already been attempted against. AD-8 allows exactly one. */
  const spentSessions = new Set<string>();
  let lastPlan: SpawnPlan | null = null;

  // Both defaults are the memoised resolutions: AD-28 says the absolute Node path is resolved *once*
  // and passed to every child, and the CLI preflight is the same kind of fact — a machine does not
  // acquire a different `claude` between two steps of one run, and re-probing per attempt would spend
  // a process per step to re-learn it.
  const cli = (): ClaudeCli =>
    resolveThunk(options.cli, () =>
      resolveClaudeCliOnce({ ...(options.env === undefined ? {} : { env: options.env }) }),
    );
  const node = (): ChildNode =>
    resolveThunk(options.node, () =>
      resolveChildNodeOnce({ ...(options.env === undefined ? {} : { env: options.env }) }),
    );
  const schemaFor = options.schemaFor ?? ((contractId: string): JsonSchema => exportContract(contractId));
  const promptFor = options.promptFor ?? defaultPromptFor;

  /** Emit one event through the recorder. Identifiers go in envelope fields, never in the payload. */
  const emit = (
    recorder: Recorder,
    event: {
      readonly step: string;
      readonly type: string;
      readonly payload: Record<string, unknown>;
      readonly sessionId?: string | null;
      readonly parentToolUseId?: string | null;
      readonly baselineRef?: string | null;
    },
  ): void => {
    recorder.record({
      feature: recorder.feature,
      run: recorder.paths.runId,
      step: event.step,
      emitter: SPAWNER_EMITTER,
      type: event.type,
      payload: event.payload,
      ...(event.sessionId === undefined ? {} : { session_id: event.sessionId }),
      ...(event.parentToolUseId === undefined ? {} : { parent_tool_use_id: event.parentToolUseId }),
      ...(event.baselineRef === undefined ? {} : { baseline_ref: event.baselineRef }),
    });
  };

  /**
   * An absent CLI is an impossible spawn, and it has to be proven absent *before* the child starts.
   *
   * `resolveClaudeCli` already proves the entry is there, but a caller may inject an already-resolved
   * {@link ClaudeCli} — story 1-5's wrapper will, and this suite does — and by then nothing has
   * re-checked the path. Without this, a missing script entry is spawned successfully: the *Node*
   * exists, so the process is created, and it exits non-zero having written nothing. That maps to a
   * `failed` step, which says the step ran and produced nothing. It did not run at all, and the
   * matrix is explicit that an absent CLI throws rather than returning a termination.
   */
  const assertCliPresent = (resolvedCli: ClaudeCli): void => {
    try {
      if (statSync(resolvedCli.path).isFile()) return;
    } catch {
      // Falls through to the refusal; the reason is the same either way.
    }
    throw new ClaudeCliUnavailableError(`${resolvedCli.path} is not a file that can be executed`);
  };

  /** Build the plan for one attempt, including the AD-20 wrapper the caller supplied. */
  const planFor = (request: StepStartRequest, resumeSessionId: string | null): SpawnPlan => {
    const resolvedCli = cli();
    assertCliPresent(resolvedCli);
    const resolvedNode = node();
    const cliArgs = buildStepArgv({
      schema: schemaFor(request.contractId),
      prompt: promptFor(request),
      model: request.modelTier,
      ...(options.mcpConfigs === undefined ? {} : { mcpConfigs: options.mcpConfigs }),
      resumeSessionId,
    });

    // AD-28: the child is executed *by* the absolute Node when the entry is a script, and is handed
    // that same absolute path through its environment either way, so a grandchild cannot resolve a
    // stale `node` from PATH. A compiled CLI has no interpreter to substitute, so only the second
    // half applies to it — the assertion is that no child resolves `node` itself, not that every
    // child is a Node script.
    const underNode = resolvedCli.interpreter === 'node';
    const base: SpawnPlan = {
      command: underNode ? resolvedNode.path : resolvedCli.path,
      args: underNode ? [resolvedCli.path, ...cliArgs] : [...cliArgs],
      cwd: request.worktree,
      env: childEnvWithNode(resolvedNode, options.env ?? process.env),
      cliArgs,
      cli: resolvedCli,
      node: resolvedNode,
      step: request.step,
      run: request.run,
    };

    return (options.wrap ?? ((plan: SpawnPlan): SpawnPlan => plan))(base);
  };

  /**
   * Run exactly one child and observe it. Rejects only when the process could not be created; every
   * other outcome is data for the disposition mapping.
   */
  const runAttempt = async (
    request: StepStartRequest,
    resumeSessionId: string | null,
  ): Promise<AttemptOutcome> => {
    const recorder = options.recorderFor(request.run, request.feature);

    let plan: SpawnPlan;
    try {
      plan = planFor(request, resumeSessionId);
    } catch (thrown: unknown) {
      // A refused preflight is an impossible spawn and no process has been created, so the port says
      // it throws. *What* it throws matters: an API-key environment, a CLI below the floor and an
      // absent child Node each already carry the AD-35 code that describes them —
      // `model.api_key_mode_refused`, `config.invalid`, `engine.node_floor_unmet`, all
      // `escalate-to-human` — and re-raising them as `StepSpawnFailed` would relabel each as
      // `retry-with-backoff`, which is a loop retrying a machine misconfiguration forever. Only the
      // genuinely unexplained is turned into a spawn failure.
      if (KEEPS_ITS_OWN_CODE.some((kind) => thrown instanceof kind)) throw thrown;
      throw new StepSpawnFailed(request.step, renderCause(thrown) ?? 'the preflight refused the spawn');
    }
    lastPlan = plan;

    const missing = missingRequiredFlags(plan.cliArgs);
    if (missing.length > 0) {
      // Unreachable through `buildStepArgv`; asserted because a widened permission surface is silent.
      throw new StepSpawnFailed(
        request.step,
        `the built argv is missing the AD-1 flags ${missing.join(', ')}, which would widen the ` +
          'permission surface without any other observable difference',
      );
    }

    emit(recorder, {
      step: request.step,
      type: SPAWNER_EVENT_TYPES.AgentSpawned,
      payload: {
        // AD-28 requires the resolved child Node version in the run event log.
        node_version: plan.node.version,
        node_source: plan.node.source,
        cli_version: plan.cli.version,
        cli_interpreter: plan.cli.interpreter,
        model_tier: request.modelTier,
        attempt: request.attempt,
        mode: request.mode,
        phase: request.phase,
        contract_id: request.contractId,
        output_format: STREAM_OUTPUT_FORMAT,
        flags: [...AD1_REQUIRED_FLAGS],
        mcp_config_count: (options.mcpConfigs ?? []).length,
        resumed: resumeSessionId !== null,
        wrapped: options.wrap !== undefined,
      },
      baselineRef: request.baselineRef,
      ...(resumeSessionId === null ? {} : { sessionId: resumeSessionId }),
    });

    return await new Promise<AttemptOutcome>((settle, reject) => {
      const parser = createStreamParser();
      let sessionReported = false;
      let apiKeySource: string | null = null;
      let stderrTail = '';
      let stderrBytes = 0;
      let killedByExecutor = false;
      let settled = false;

      let child;
      try {
        child = spawn(plan.command, [...plan.args], {
          cwd: plan.cwd,
          env: plan.env,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (thrown: unknown) {
        reject(
          new StepSpawnFailed(
            request.step,
            renderCause(thrown) ?? `${plan.command} could not be executed`,
          ),
        );
        return;
      }

      const stop = (): void => {
        killedByExecutor = true;
        child.kill(EXECUTOR_KILL_SIGNAL);
      };
      live.set(request.step, { stop });

      const handle = (records: readonly StreamRecord[]): void => {
        for (const record of records) {
          switch (record.kind) {
            case 'session': {
              // AD-8 — reported the instant the subprocess announces it, before the attempt can be
              // interrupted, and at most once per attempt.
              if (!sessionReported) {
                sessionReported = true;
                emit(recorder, {
                  step: request.step,
                  type: SPAWNER_EVENT_TYPES.AgentSessionAnnounced,
                  payload: { attempt: request.attempt, resumed: resumeSessionId !== null },
                  sessionId: record.sessionId,
                  baselineRef: request.baselineRef,
                });
                request.onSessionId(record.sessionId);
              }
              break;
            }
            case 'api_key_source': {
              if (!isSubscriptionApiKeySource(record.source)) apiKeySource = record.source;
              break;
            }
            case 'tool_use': {
              emit(recorder, {
                step: request.step,
                type: SPAWNER_EVENT_TYPES.AgentToolUsed,
                payload: { tool: record.toolName, tool_use_id: record.toolUseId },
                parentToolUseId: record.parentToolUseId,
                ...(record.sessionId === null ? {} : { sessionId: record.sessionId }),
              });
              break;
            }
            case 'permission_denied': {
              emit(recorder, {
                step: request.step,
                type: SPAWNER_EVENT_TYPES.PermissionDenied,
                payload: {
                  tool: record.toolName,
                  tool_use_id: record.toolUseId,
                  reason: record.reason,
                  reason_type: record.reasonType,
                  disposition: 'escalate-to-human',
                },
                parentToolUseId: record.parentToolUseId,
                ...(record.sessionId === null ? {} : { sessionId: record.sessionId }),
              });
              break;
            }
            case 'unparseable': {
              emit(recorder, {
                step: request.step,
                type: SPAWNER_EVENT_TYPES.AgentStreamUnparseable,
                payload: { reason: record.reason, bytes: record.bytes, line: record.line },
              });
              break;
            }
            case 'result':
            case 'ignored':
              break;
          }
        }
      };

      child.stdout?.setEncoding('utf8');
      child.stdout?.on('data', (chunk: string) => {
        handle(parser.push(chunk));
      });
      child.stderr?.setEncoding('utf8');
      child.stderr?.on('data', (chunk: string) => {
        stderrBytes += Buffer.byteLength(chunk, 'utf8');
        stderrTail = appendTail(stderrTail, chunk);
      });

      const finish = (exitCode: number | null, signal: NodeJS.Signals | null): void => {
        if (settled) return;
        settled = true;
        live.delete(request.step);
        handle(parser.end());
        if (stderrBytes > 0) {
          emit(recorder, {
            step: request.step,
            type: SPAWNER_EVENT_TYPES.AgentStderr,
            payload: { bytes: stderrBytes, tail: stderrTail },
          });
        }
        settle({
          sessionId: parser.sessionId(),
          result: parser.result(),
          exitCode,
          signal,
          stderrTail,
          killedByExecutor,
          apiKeySource,
        });
      };

      child.on('error', (thrown: Error) => {
        if (settled) return;
        settled = true;
        live.delete(request.step);
        // `error` before any exit means the process was never created: ENOENT on the command, a cwd
        // that does not exist, a permission problem on the executable. The port says that throws.
        reject(new StepSpawnFailed(request.step, `${thrown.name}: ${thrown.message}`));
      });
      child.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
        finish(code, signal);
      });
    });
  };

  /** Re-parse the terminal output against the originating Zod schema (AD-1). */
  const reparse = (
    contractId: string,
    value: unknown,
  ): { readonly ok: true; readonly output: StepOutput } | { readonly ok: false; readonly detail: string } => {
    let contract;
    try {
      contract = getContract(contractId);
    } catch (thrown: unknown) {
      return { ok: false, detail: renderCause(thrown) ?? `unknown contract id "${contractId}"` };
    }
    const first = contract.schema.safeParse(value);
    if (!first.success) {
      return {
        ok: false,
        detail: first.error.issues
          .map((issue) => `${issue.path.map((part) => String(part)).join('.') || '(root)'}: ${issue.code}`)
          .join('; '),
      };
    }
    // The port carries a `StepOutput`, so the validated value is proven to be one before it is
    // returned. For `step.output` this is the same schema twice; for a later step contract it is the
    // difference between "valid against its own contract" and "a shape the loop can read".
    const shaped = StepOutputSchema.safeParse(first.data);
    if (!shaped.success) {
      return {
        ok: false,
        detail:
          `the output satisfied "${contractId}" but is not a step output the loop can read: ` +
          shaped.error.issues
            .map((issue) => `${issue.path.map((part) => String(part)).join('.') || '(root)'}: ${issue.code}`)
            .join('; '),
      };
    }
    return { ok: true, output: shaped.data };
  };

  /** Map one attempt's outcome onto a termination. The whole of AD-8's reachability lives here. */
  const terminationFor = (request: StepStartRequest, outcome: AttemptOutcome): StepTermination => {
    const recorder = options.recorderFor(request.run, request.feature);
    const sessionId = outcome.sessionId;

    const record = (disposition: string, error: OrchError | null): void => {
      emit(recorder, {
        step: request.step,
        type: SPAWNER_EVENT_TYPES.AgentExited,
        payload: {
          disposition,
          exit_code: outcome.exitCode,
          signal: outcome.signal,
          killed_by_executor: outcome.killedByExecutor,
          had_terminal_output: outcome.result !== null,
          ...(error === null ? {} : { code: error.code }),
        },
        ...(sessionId === null ? {} : { sessionId }),
        baselineRef: request.baselineRef,
      });
    };

    const withSession = { sessionId };

    // AD-1's positive assertion, caught a second time on the stream. The preflight refuses an
    // API-key environment before any process exists; this catches a CLI that resolved a key some
    // other way, and it is a `failed` termination rather than a throw because the process did run.
    if (outcome.apiKeySource !== null) {
      const error = makeError(
        'model.api_key_mode_refused',
        `The CLI reported apiKeySource "${outcome.apiKeySource}", so this attempt did not run on the ` +
          "user's own Claude Code subscription login, which AD-1 requires.",
      );
      record('failed', error);
      return terminated(request.step, 'failed', { ...withSession, error });
    }

    if (outcome.killedByExecutor) {
      // AD-8 — a step the executor stopped records `killed` and is never resumed or re-run.
      record('killed', null);
      return terminated(request.step, 'killed', withSession);
    }

    const result = outcome.result;
    if (result === null) {
      if (outcome.signal !== null) {
        // The one mapping that makes resume reachable at all.
        record('interrupted', null);
        return terminated(request.step, 'interrupted', withSession);
      }
      const error = makeError(
        'step.stream_malformed',
        `The step subprocess exited with code ${String(outcome.exitCode)} without a terminal ` +
          'structured output, so the attempt produced nothing to judge.',
        outcome.stderrTail === '' ? null : outcome.stderrTail,
      );
      record('failed', error);
      return terminated(request.step, 'failed', { ...withSession, error });
    }

    if (result.isError || !result.hasStructuredOutput || result.structuredOutput === null) {
      const code = result.isError ? errorCodeForResult(result) : 'step.stream_malformed';
      const error = makeError(
        code,
        result.isError
          ? `The CLI reported result subtype "${result.subtype}" with no usable structured output.`
          : 'The stream ended without a structured output, so AD-1 had nothing to re-parse.',
        outcome.stderrTail === '' ? null : outcome.stderrTail,
      );
      record('failed', error);
      return terminated(request.step, 'failed', { ...withSession, error });
    }

    const parsed = reparse(request.contractId, result.structuredOutput);
    if (!parsed.ok) {
      // The invalid output never reaches the loop, and never reaches the log either: only the reason
      // is recorded. AD-35 makes this code `escalate-model-tier`, which is the Stack's promotion
      // trigger for a second schema-invalid output.
      emit(recorder, {
        step: request.step,
        type: SPAWNER_EVENT_TYPES.AgentOutputRejected,
        payload: { contract_id: request.contractId, detail: parsed.detail },
        ...(sessionId === null ? {} : { sessionId }),
      });
      const error = makeError(
        'step.schema_invalid_output',
        `The step's structured output did not satisfy the "${request.contractId}" contract, so it was ` +
          'not accepted as a completed step.',
        parsed.detail,
      );
      record('failed', error);
      return terminated(request.step, 'failed', { ...withSession, error });
    }

    const output = parsed.output;
    if (output.status === 'completed') {
      record('completed', null);
      return terminated(request.step, 'completed', { ...withSession, output });
    }
    // The agent reported its own work blocked or failed. The output is not carried: the port gives
    // `output` only to a `completed` step, and what the AD-35 table is consulted about is the code.
    const error =
      output.error ??
      makeError(
        output.status === 'blocked' ? 'question.unanswerable' : 'step.verification_failed',
        `The step reported status "${output.status}" without an error: ${output.summary}`,
      );
    record(output.status, error);
    return terminated(request.step, output.status, { ...withSession, error });
  };

  return {
    lastPlan: (): SpawnPlan | null => lastPlan,
    kill: (step: string): boolean => {
      const running = live.get(step);
      if (running === undefined) return false;
      running.stop();
      return true;
    },
    killAll: (): void => {
      for (const running of live.values()) running.stop();
    },
    start: async (request: StepStartRequest): Promise<StepTermination> =>
      terminationFor(request, await runAttempt(request, null)),
    resume: async (request: StepResumeRequest): Promise<StepTermination> => {
      // AD-8 allows exactly one resume per recorded id: the fallback is a baseline reset and a
      // re-run, which the loop already owns. A second attempt against a spent id is refused without
      // creating a process, so "never a second resume against the same id" is a property of this
      // unit rather than of the caller's discipline.
      if (spentSessions.has(request.sessionId)) {
        throw new ResumeRefused(
          request.step,
          request.sessionId,
          'this session id has already been resumed once and is spent',
        );
      }
      spentSessions.add(request.sessionId);

      const outcome = await runAttempt(request, request.sessionId);

      const refusedByText = RESUME_REFUSAL_PATTERNS.some((pattern) =>
        pattern.test(outcome.stderrTail),
      );
      // A resume that never reached an `init` line never found the session: the CLI died before
      // opening one. That is a structural signal, not a message this system owns.
      const refusedStructurally =
        outcome.sessionId === null &&
        outcome.result === null &&
        outcome.signal === null &&
        !outcome.killedByExecutor &&
        outcome.exitCode !== 0;
      if (refusedByText || refusedStructurally) {
        const recorder = options.recorderFor(request.run, request.feature);
        emit(recorder, {
          step: request.step,
          type: SPAWNER_EVENT_TYPES.AgentExited,
          payload: {
            disposition: 'resume_refused',
            exit_code: outcome.exitCode,
            signal: outcome.signal,
            code: 'step.resume_failed',
            evidence: refusedByText ? 'the CLI said so' : 'no session was opened',
          },
          sessionId: request.sessionId,
          baselineRef: request.baselineRef,
        });
        throw new ResumeRefused(
          request.step,
          request.sessionId,
          outcome.stderrTail === ''
            ? `the CLI exited with code ${String(outcome.exitCode)} without opening the session`
            : outcome.stderrTail.trim(),
        );
      }

      return terminationFor(request, outcome);
    },
  };
};
