/**
 * AD-1 — the real {@link StepExecutor}: one `claude -p` subprocess per step attempt.
 *
 * Story 1-3 defined the port and drove a scripted double, so until now no step had ever run. This is
 * the unit that actually spawns, and it is where the system's permission surface is fixed. Five
 * decisions in here are load-bearing, and each is the thing some plausible alternative gets wrong:
 *
 * **The flag set is a declared constant, not a call-site list.** {@link AD1_REQUIRED_FLAGS} names
 * `--json-schema`, `--output-format`, `--strict-mcp-config`, `--restricted`, `--add-dir` and `--tools`,
 * and the suite asserts the built argv against it *and* the list itself against
 * {@link ADR001_REQUIRED_FLAGS}. A missing `--restricted` or `--strict-mcp-config` silently *widens* the
 * permission surface — the target repository's own `.mcp.json` and hooks become able to introduce
 * tools and credentials — and nothing about the run looks different when it happens. That is the
 * failure mode AD-1 exists to close, so the flags are asserted rather than trusted. The last two were
 * absent from both the list and the argv until story 2-4, which is the worse version of the same failure:
 * `missingRequiredFlags` reported that the contract held while the grant that bounds the agent was never
 * passed at all.
 *
 * **The grant comes from the roster, never from a table here.** `--tools` carries what the run's AD-9
 * configuration snapshot declares for the phase, resolved by `src/engine/agents.ts`; a phase with no
 * declaration is a refused spawn, not a default grant (AD-17).
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
import { accessSync, constants as fsConstants, statSync } from 'node:fs';
import { constants as osConstants } from 'node:os';
import { basename, isAbsolute } from 'node:path';

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
import { AgentGrantUnresolved, resolveAgentGrant, toolsArgumentFor } from './agents.js';
import { ProfileNotFound, ProfileUnreadable } from './profile.js';
import type { AgentGrant } from './agents.js';
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
 * The `agent.spawned` keys carrying the AD-17 grant, spelled once.
 *
 * The rest of that payload is spelled inline, and these four are not, for the same reason
 * `DECLARATION_PAYLOAD_KEYS` exists in `src/contracts/event.ts`: they are the record of a *security*
 * decision, they are the only fields on this event a reviewer or a later audit reads back, and a key
 * renamed at the emitter while a reader still looks for the old one loses the grant silently. Declared
 * here rather than in contracts because no unit outside the engine reads `agent.spawned` yet; the day one
 * does, this moves there and the emitter does not change.
 */
export const SPAWN_GRANT_PAYLOAD_KEYS = {
  /** Exactly what the roster declared, in the order it declared it. */
  GrantedTools: 'granted_tools',
  /** The subset of those that can change something. Never a copy of the grant. */
  ElevatedTools: 'elevated_tools',
  /** The agent id the phase resolved to. */
  AgentId: 'agent_id',
  /** The declaration file the grant was read from, by name: AD-21 rewrites the path around it. */
  GrantDeclaredAt: 'grant_declared_file',
} as const;

/**
 * The four flags ADR-001's accepted decision requires on every spawn, as that decision enumerates them.
 *
 * Quoted so the list can be compared to the ADR rather than to itself: "`--restricted` (which ignores
 * user, project and local settings files, confines the file tools to the working directories, refuses
 * `bypassPermissions`, and requires approval for writes to settings, git and tool-configuration files),
 * plus `--strict-mcp-config`, plus `--add-dir` scoped to the run worktree, plus `--tools` naming exactly
 * what that agent is granted."
 *
 * Two of the four were missing from {@link AD1_REQUIRED_FLAGS} until story 2-4, and neither `--add-dir`
 * nor `--tools` appeared anywhere in `src/` — so `missingRequiredFlags` returned empty, reporting that the
 * contract held, while the grant was unenforced. A required-flag list that omits a required flag is a
 * guard that reads as coverage while covering less, which is why this is a separate constant the suite
 * compares the list against: the assertion is about the *enumeration*, not about one argv.
 */
export const ADR001_REQUIRED_FLAGS = [
  '--restricted',
  '--strict-mcp-config',
  '--add-dir',
  '--tools',
] as const;

/**
 * The AD-1 flags every spawn carries, asserted by the suite rather than trusted to a call site.
 *
 * `--output-format` is named without its value because the assertion is about presence; the value is
 * asserted separately, as `stream-json` and nothing else. `--json-schema` and `--output-format` are AD-1's
 * own; the other four are {@link ADR001_REQUIRED_FLAGS}, and the suite asserts this list contains every
 * one of them.
 */
export const AD1_REQUIRED_FLAGS = [
  '--json-schema',
  '--output-format',
  '--strict-mcp-config',
  '--restricted',
  '--add-dir',
  '--tools',
] as const;

/**
 * The `--add-dir` value was not an absolute path, so the spawn cannot be bounded to the run worktree.
 *
 * `config.invalid` → `escalate-to-human`, and listed in {@link KEEPS_ITS_OWN_CODE} so it is not relabelled
 * as a retryable spawn failure: a run whose worktree is empty or relative is misconfigured, and a loop
 * retrying it would re-spawn the same unbuildable step for ever.
 */
export class AddDirNotAbsolute extends Error {
  readonly code = 'config.invalid';
  readonly addDir: string;

  constructor(addDir: string) {
    super(
      `Refusing to spawn with --add-dir "${addDir}": ADR-001 scopes it to the run worktree, which is an ` +
        'absolute path. A relative value is resolved against the CLI\u2019s own working directory and an ' +
        'empty one admits nothing, and under --restricted this flag is half of what bounds the ' +
        'agent\u2019s file tools \u2014 so a wrong value widens the surface with no other symptom.',
    );
    this.name = 'AddDirNotAbsolute';
    this.addDir = addDir;
  }
}

/** The one accepted `--output-format`. The parser in `stream.ts` reads this and only this. */
export const STREAM_OUTPUT_FORMAT = 'stream-json';

/** How much of the child's stderr is kept, for a refusal message and one bounded event. */
export const STDERR_TAIL_LIMIT = 2000;

/** Signals the CLI is stopped with when the executor is asked to stop a step. */
export const EXECUTOR_KILL_SIGNAL = 'SIGTERM';

/**
 * How long a stopped child is given to exit before it is killed outright.
 *
 * One `SIGTERM` and nothing else is a stop that a child may simply decline, and the consequences are
 * not local: the attempt promise never settles, so the `killed` termination never reaches the loop and
 * `killAll()` blocks a shutdown that is holding the AD-29 writer claim. The escalation is what makes
 * "stop this step" a statement rather than a request.
 */
export const EXECUTOR_KILL_GRACE_MS = 5_000;

/** The signal a child that ignored {@link EXECUTOR_KILL_SIGNAL} is stopped with. */
export const EXECUTOR_FORCE_KILL_SIGNAL = 'SIGKILL';

/**
 * The wall-clock bound on one attempt.
 *
 * Without one, a child that hangs means `start()` never settles: the run holds its recorder claim and
 * its engine lock forever, and AD-30's "one engine per ORCH_HOME" turns a single wedged step into a
 * machine that cannot be reconciled at all. The ceiling story is AD-24's and is story 2-9's to own —
 * this is not that. It is the floor under it: a bound that always exists so a hang is an `interrupted`
 * attempt the loop can decide about rather than silence.
 */
export const DEFAULT_ATTEMPT_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * Translate a shell-convention exit code back into the signal it reports.
 *
 * A wrapper between this executor and the CLI — the AD-20 container wrapper of story 1-5 is exactly
 * that — does not forward its child's signal. It exits `128 + n` instead, which arrives here as an
 * ordinary non-zero code with `signal === null`. Without this translation the same interruption maps to
 * `interrupted` when unwrapped and to `failed` when wrapped, so resume becomes dead code precisely at
 * the seam story 1-5 plugs into, which is the failure this story's Design Notes single out.
 */
export const signalFromExitCode = (code: number | null): NodeJS.Signals | null => {
  if (code === null || code <= 128 || code >= 128 + 65) return null;
  const number = code - 128;
  for (const [name, value] of Object.entries(osConstants.signals)) {
    if (value === number) return name as NodeJS.Signals;
  }
  return null;
};

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
  /**
   * The AD-17 grant this argv's `--tools` was built from, and the declaration it came from.
   *
   * On the plan so the log can record what was *granted* beside what was *passed*, and so the AD-20
   * wrapper can see the grant it is containing the commands of. A wrapper that rebuilds `args` cannot
   * change this, which is the point: the guard compares the vector that will run against the flags, and
   * this says where the grant in it was declared.
   */
  readonly grant: AgentGrant;
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
  /**
   * The AD-17 grant `--tools` is built from. Defaults to reading the run's AD-9 configuration snapshot.
   *
   * Injectable for the same reason `cli` and `node` are — a suite must be able to drive a grant without a
   * snapshot on disk — and *not* defaultable to anything but a roster read: `src/engine/agents.ts` holds
   * the refusal for a phase nothing declares, and a caller that supplied a constant here would be taking
   * the security decision ADR-001 made load-bearing. There is no option that means "use a default grant".
   */
  readonly grantFor?: (request: StepStartRequest) => AgentGrant;
  /** `ORCH_HOME`, for the default grant resolution. Defaults to the AD-9 resolution. */
  readonly orchHome?: string;
  /** The draft-7 export for a contract id. Defaults to the AD-2 registry export. */
  readonly schemaFor?: (contractId: string) => JsonSchema;
  /** The wall-clock bound on one attempt. Defaults to {@link DEFAULT_ATTEMPT_TIMEOUT_MS}. */
  readonly attemptTimeoutMs?: number;
  /** How long a stopped child is given before {@link EXECUTOR_FORCE_KILL_SIGNAL}. */
  readonly killGraceMs?: number;
}

/** The executor, plus the two things a caller and a suite legitimately need to see. */
export interface StepSpawner extends StepExecutor {
  /** The plan the most recent attempt executed. Read by the suite; never by the loop. */
  readonly lastPlan: () => SpawnPlan | null;
  /**
   * Stop a running step. The resulting termination is `killed`, which AD-8 never resumes or re-runs —
   * this is the executor-initiated stop a steering command reaches the executor as.
   *
   * `run` narrows the stop to one run's attempt. One spawner serves every run and reconciliation is
   * concurrent across features, so a step name alone does not identify a child: two runs of the same
   * plan have a step called `implement` each, and stopping "implement" without saying whose would stop
   * whichever was found first. Omitting `run` stops every live attempt at that step, which is what a
   * shutdown wants and what a steering command must not rely on.
   */
  readonly kill: (step: string, run?: string) => boolean;
  /** Stop every running step. For a caller shutting down. */
  readonly killAll: () => void;
  /** The plan one identified attempt executed, for a caller holding more than one in flight. */
  readonly planOf: (run: string, step: string, attempt: number) => SpawnPlan | null;
}

/**
 * The prompt a step agent is given.
 *
 * It names the typed input file rather than carrying its contents: a step is a pure function over
 * exactly that file (AD-23), and a re-run must read the same bytes (CAP-6). It carries no timestamp
 * and no attempt number, so two attempts at one step are byte-identical invocations — which is what
 * makes a re-run a re-run rather than a different request.
 *
 * It points the agent at `request` and says the word verbatim, because architecture.md's re-grounding rule
 * is a rule about what the *agent* reads: "Every agent reads the original, verbatim feature request — never
 * a summary of a summary." The input carries no summary field for it to read instead, and the prompt does
 * not invite one.
 */
export const defaultPromptFor = (request: StepStartRequest): string =>
  [
    `You are running step "${request.step}" (${request.phase}) of feature "${request.feature}".`,
    `Read the typed step input file at ${request.inputPath}. It is the complete statement of this`,
    'step: its `request` field carries the user\u2019s original words verbatim and is what you ground your',
    'work on — never a summary of them — alongside the acceptance criteria, the decisions already taken',
    'and pointers to the evidence you may read. Work only inside the current working directory.',
    `Finish by producing the structured output required by the "${request.contractId}" contract, with`,
    `its \`step\` field set to "${request.step}". Report status "blocked" rather than guessing if the`,
    'input does not determine what to do.',
  ].join(' ');

export interface StepArgvOptions {
  /** The draft-7 export of the registered contract (AD-2). Passed to `--json-schema`. */
  readonly schema: JsonSchema;
  readonly prompt: string;
  readonly model: ModelRung;
  /**
   * The `--tools` value: exactly what this agent's AD-17 declaration grants, comma-separated.
   *
   * Required rather than optional, and a string rather than a list of names, for two different reasons.
   * Required, because an optional grant has a default, and the default would be *the* security decision —
   * taken by this function, which has never read a roster. A string, because the value is composed by
   * `toolsArgumentFor` in `src/engine/agents.ts` from the declaration: if this took tool *names* it would
   * be a second place that knows what a tool name is, and the empty grant the CLI spells `""` would have
   * two spellings.
   */
  readonly tools: string;
  /**
   * The directory `--add-dir` admits: the run worktree, and nothing above it.
   *
   * ADR-001 moved the containment boundary off the agent process, so `--restricted` plus this flag is the
   * whole of what bounds the agent's file tools. A missing `--add-dir` under `--restricted` confines those
   * tools to the working directory only, which happens to be the same worktree — so the omission is
   * invisible until a wrapper changes `cwd`, and then it is a silent widening.
   */
  readonly addDir: string;
  readonly mcpConfigs?: readonly string[];
  /** Present only for a resume, and only ever the recorded session id (AD-8). */
  readonly resumeSessionId?: string | null;
}

/**
 * The AD-1 argv, as amended by ADR-001.
 *
 * `--verbose` is here because the CLI requires it alongside `--print --output-format stream-json`; it
 * is a precondition of the stream this story parses, not a diagnostic choice, and no unit writes
 * diagnostics to stdout regardless.
 *
 * `--tools` and `--add-dir` are parameters with no defaults, so there is no argv this function can build
 * that omits either one: ADR-001 requires both on every spawn, and `--tools` under `--restricted` is what
 * decides whether the agent has any code-running tool at all.
 *
 * `--mcp-config` is passed only when servers were supplied. `--strict-mcp-config` is passed either
 * way, and that asymmetry is the point: with no servers supplied, strict mode means *no* MCP server
 * loads, which is a narrower surface than omitting both flags and letting the repository's own
 * `.mcp.json` decide.
 */
export const buildStepArgv = (options: StepArgvOptions): readonly string[] => {
  /**
   * `--add-dir` is the absolute run worktree or it is nothing.
   *
   * A relative value is resolved by the CLI against *its own* working directory, so `--add-dir ''` or
   * `--add-dir worktrees/x` admits some directory nobody chose — and an empty string is what an unset
   * `request.worktree` arrives as. Under `--restricted` this is half of what bounds the agent's file
   * tools, so a wrong value here is a widening with no other symptom, which is the same class of failure
   * the flag list itself had. Refused with `config.invalid`: no retry and no model rung fixes a run
   * configured without a worktree.
   */
  if (!isAbsolute(options.addDir)) throw new AddDirNotAbsolute(options.addDir);
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
    // ADR-001: the two flags that bound a host-side agent. `--tools` carries the AD-17 grant verbatim,
    // including the CLI's own empty value for an agent a roster grants nothing.
    '--add-dir',
    options.addDir,
    '--tools',
    options.tools,
    '--model',
    options.model,
  ];
  const configs = options.mcpConfigs ?? [];
  if (configs.length > 0) argv.push('--mcp-config', ...configs);
  const resume = options.resumeSessionId ?? null;
  if (resume !== null) argv.push('--resume', resume);
  return argv;
};

/**
 * The values a caller can require an argv to carry, not merely to mention.
 *
 * Both are the ones ADR-001 makes load-bearing, and both are what a wrapper is in a position to rewrite.
 */
export interface RequiredFlagValues {
  /** The `--tools` value the AD-17 grant composed. `''` is a real value: an agent granted nothing. */
  readonly tools?: string;
  /** The `--add-dir` value: the absolute run worktree. */
  readonly addDir?: string;
}

/** The value an argv carries after a flag, or `null` when the flag is absent or ends the vector. */
const valueAfter = (argv: readonly string[], flag: string): string | null => {
  const at = argv.indexOf(flag);
  if (at === -1 || at + 1 >= argv.length) return null;
  return argv[at + 1] ?? null;
};

/**
 * Which flags of {@link AD1_REQUIRED_FLAGS} an argv is missing. Empty means the contract holds.
 *
 * **A flag's presence is not its value, and this guard failed that way once already.** The list it replaced
 * omitted `--tools` outright and so reported "the contract holds" for an argv with no grant. Checking only
 * that the *name* appears repeats the shape of that defect one level down: the AD-20 wrapper is free to
 * rebuild `args`, and one that kept `--tools` while emptying or rewriting its value would hand the agent a
 * different grant from the one the roster declared, with the guard still answering empty. So when the
 * caller knows what the values must be — the spawner always does; it composed them — it passes them, and a
 * flag whose value does not match is reported as missing. It is *missing* rather than "wrong" because the
 * flag the contract requires is `--tools <the grant>`, and an argv carrying `--tools` with something else
 * does not carry that flag.
 *
 * With no expectations supplied the check is presence-only, which is what a caller holding an argv it did
 * not build can honestly ask.
 */
export const missingRequiredFlags = (
  argv: readonly string[],
  expected: RequiredFlagValues = {},
): readonly string[] =>
  AD1_REQUIRED_FLAGS.filter((flag) => {
    if (!argv.includes(flag)) return true;
    if (flag === '--tools' && expected.tools !== undefined) {
      return valueAfter(argv, flag) !== expected.tools;
    }
    if (flag === '--add-dir' && expected.addDir !== undefined) {
      return valueAfter(argv, flag) !== expected.addDir;
    }
    return false;
  });

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
  // A phase nothing declares is `config.invalid` → `escalate-to-human`: no model rung and no retry fixes a
  // roster, and relabelling it `retryable` would have the loop re-spawning a step that cannot be built.
  AgentGrantUnresolved,
  // Resolving that grant reads the run's AD-9 snapshot, so the profile refusals are now on this path too,
  // and they carry `config.invalid` for the same reason: a run with no snapshot, or one this build cannot
  // read, is not a condition a retry reaches the other side of.
  ProfileNotFound,
  ProfileUnreadable,
  // A worktree that is not an absolute path is a misconfigured run, not a transient spawn failure.
  AddDirNotAbsolute,
] as const;

/**
 * The code a non-completed output takes when the agent reported no error of its own.
 *
 * Named rather than inlined because the two are not interchangeable and their dispositions are
 * opposites. A *blocked* step is waiting on a decision only a person can make, so
 * `question.unanswerable` is `escalate-to-human`; a *failed* one produced work that did not hold up,
 * which is what the model ladder exists for, so `step.verification_failed` is `escalate-model-tier`.
 * Swapping them sends every blocked step to a model that cannot answer the question and every failed
 * step to a person who has nothing to decide.
 */
const FALLBACK_STATUS_CODES: Readonly<Record<'blocked' | 'failed', string>> = {
  blocked: 'question.unanswerable',
  failed: 'step.verification_failed',
};

const fallbackDetail = (output: StepOutput): string =>
  `The step reported status "${output.status}" without an error: ${output.summary}`;

/** What one attempt observed. Everything the disposition mapping is a function of. */
interface AttemptOutcome {
  readonly sessionId: string | null;
  readonly result: ResultRecord | null;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stderrTail: string;
  /** True when this executor stopped the child, which is what distinguishes `killed` (AD-8). */
  readonly killedByExecutor: boolean;
  /** True when the attempt's wall-clock bound expired, which is an `interrupted`, not a `killed`. */
  readonly timedOut: boolean;
  /** Set only when the CLI positively named an `apiKeySource` other than the subscription login. */
  readonly apiKeySource: string | null;
  /**
   * What the stream said about authentication: the named source, `unreported` when the init line
   * carried no such field, or `no-init-line` when no init line arrived. Recorded on the exit event so
   * "the check did not run" is a fact on the log rather than a silence.
   */
  readonly apiKeySourceReport: string;
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

/**
 * The identity of one attempt: the run, the step and the attempt number together.
 *
 * A step name alone is not an identity. One spawner serves every run, reconciliation is concurrent
 * across features, and two runs of one plan each have a step called `implement` — so keying children by
 * step name means the second attempt evicts the first from the table: a steering kill then stops the
 * wrong child, and the evicted one becomes unkillable because the first `finish()` deletes the entry
 * the other was found under.
 */
const attemptKey = (run: string, step: string, attempt: number): string =>
  `${run}\u0000${step}\u0000${String(attempt)}`;

/** A child in flight, and what is known about it without reaching for the process. */
interface LiveAttempt {
  readonly run: string;
  readonly step: string;
  readonly attempt: number;
  /** Stop the child: the executor-initiated stop that becomes a `killed` disposition. */
  readonly stop: () => void;
}

/** Session ids kept bounded, oldest evicted first, so a long-lived engine does not grow forever. */
const SPENT_SESSION_MEMORY = 1024;

/**
 * Event types that must reach the log even if their stream passthrough fields cannot.
 *
 * Both carry an AD-5 verbatim-or-dropped field, so both can be dropped wholesale by a pass that cannot
 * prove the id safe — and both are facts the log must state: that a tool call was refused, and that a
 * session exists to resume.
 */
const MUST_SURVIVE_A_DROPPED_PASSTHROUGH: readonly string[] = [
  'permission.denied',
  'agent.session_announced',
];

export const createStepSpawner = (options: StepSpawnerOptions): StepSpawner => {
  /** Children in flight, by attempt identity, so a steering kill reaches exactly one of them. */
  const live = new Map<string, LiveAttempt>();
  /**
   * Session ids a refused resume has already been spent on. AD-8 grants exactly one resume per
   * recorded id, and the refusal is what spends it: a preflight that never created a process has not
   * spent the run's one chance, and a resume that *worked* has not either — an attempt that resumed,
   * was interrupted again and is resumed again is the loop doing its job, not a second bite.
   *
   * Bounded, with the oldest evicted first: an engine that runs for weeks would otherwise accumulate
   * one entry per refused resume for its whole lifetime.
   */
  const spentSessions = new Set<string>();
  const rememberSpent = (sessionId: string): void => {
    spentSessions.add(sessionId);
    while (spentSessions.size > SPENT_SESSION_MEMORY) {
      const oldest = spentSessions.values().next();
      if (oldest.done === true) break;
      spentSessions.delete(oldest.value);
    }
  };
  /** The plan each attempt executed, keyed by attempt identity, plus the most recent for convenience. */
  const plans = new Map<string, SpawnPlan>();
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
  const grantFor =
    options.grantFor ??
    ((request: StepStartRequest): AgentGrant =>
      resolveAgentGrant({
        run: request.run,
        phase: request.phase,
        ...(options.orchHome === undefined ? {} : { orchHome: options.orchHome }),
      }));
  const promptFor = options.promptFor ?? defaultPromptFor;

  /**
   * Emit one event through the recorder. Identifiers go in envelope fields, never in the payload.
   *
   * Two things this does beyond forwarding:
   *
   * **It reads the recorder's answer.** `record` does not throw when the AD-21 pass fails; it drops the
   * artifact, appends `redaction.failed` in its place and reports `dropped`. For an ordinary event that
   * is the right trade, but `permission.denied` and `agent.session_announced` carry the two AD-5 stream
   * fields, which are verbatim-or-dropped — so precisely the events that matter most are the ones that
   * can vanish, and a refused tool call disappearing from the log is the worst direction for a
   * permission event to fail in. A drop is therefore re-stated as a field-free event of the same type,
   * so the log still says a refusal happened even when it may not say which.
   *
   * **It cannot throw.** Every call site is inside a `data` or `close` handler, where a throw escapes as
   * an uncaught exception and leaves the attempt promise unsettled forever. An event that could not be
   * appended must not cost the termination.
   */
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
    const submit = (carryStreamFields: boolean): boolean => {
      const recorded = recorder.recordResult({
        feature: recorder.feature,
        run: recorder.paths.runId,
        step: event.step,
        emitter: SPAWNER_EMITTER,
        type: event.type,
        payload: event.payload,
        ...(carryStreamFields && event.sessionId !== undefined
          ? { session_id: event.sessionId }
          : {}),
        ...(carryStreamFields && event.parentToolUseId !== undefined
          ? { parent_tool_use_id: event.parentToolUseId }
          : {}),
        ...(event.baselineRef === undefined ? {} : { baseline_ref: event.baselineRef }),
      });
      return recorded.dropped;
    };

    try {
      if (!submit(true)) return;
      if (!MUST_SURVIVE_A_DROPPED_PASSTHROUGH.includes(event.type)) return;
      // The artifact was dropped because a stream passthrough field failed the pass. Re-state the
      // event without those fields: the log loses the id, not the fact.
      recorder.recordResult({
        feature: recorder.feature,
        run: recorder.paths.runId,
        step: event.step,
        emitter: SPAWNER_EMITTER,
        type: event.type,
        payload: { ...event.payload, passthrough_dropped: true },
        ...(event.baselineRef === undefined ? {} : { baseline_ref: event.baselineRef }),
      });
    } catch {
      // A recorder that refuses the append does not get to cost the termination. There is nowhere
      // else to report this: no unit writes diagnostics to stdout, and the log is the thing that failed.
    }
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
      if (statSync(resolvedCli.path).isFile()) {
        // A compiled entry is executed directly, so it must be executable; a script entry is read by
        // the resolved Node and need not be.
        if (resolvedCli.interpreter === 'direct') accessSync(resolvedCli.path, fsConstants.X_OK);
        return;
      }
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
    /**
     * The AD-17 grant, resolved before the argv exists.
     *
     * It is resolved per attempt rather than memoised like the CLI and the Node: those are facts about the
     * machine, and this is a fact about one run's configuration snapshot, which is a different snapshot per
     * run. A refusal here is a refused spawn — see the `catch` in `runAttempt` for why it keeps its own
     * AD-35 code rather than being relabelled retryable.
     */
    const grant = grantFor(request);
    const cliArgs = buildStepArgv({
      schema: schemaFor(request.contractId),
      prompt: promptFor(request),
      model: request.modelTier,
      tools: toolsArgumentFor(grant),
      // ADR-001: scoped to the run worktree, which is also the cwd — the flag is what keeps that true
      // after a wrapper has had the plan.
      addDir: request.worktree,
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
      grant,
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
    recorder: Recorder,
    // The default is a no-op by design: only `resume` needs to know a child exists, so that it can
    // mark the session spent after the process is real rather than before it.
    // eslint-disable-next-line @typescript-eslint/no-empty-function
    onChildStarted: () => void = (): void => {},
  ): Promise<AttemptOutcome> => {
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
    const key = attemptKey(request.run, request.step, request.attempt);
    lastPlan = plan;
    plans.set(key, plan);

    /**
     * The guard is over the vector that will actually be executed, not the one that was built.
     *
     * `cliArgs` is the pre-wrap argv, and the wrapper of AD-20 is free to rebuild `args`. A wrapper
     * that rebuilt it and dropped `--restricted` or `--strict-mcp-config` would pass a guard that only
     * read `cliArgs` — and the resulting widening of the permission surface has no other observable
     * symptom, which is the entire reason the constant exists. So what is asserted is what is run.
     */
    const observedFlags = AD1_REQUIRED_FLAGS.filter((flag) => plan.args.includes(flag));
    // The values as well as the names: the wrapper is free to rebuild `args`, and one that kept `--tools`
    // while emptying it would hand the agent a grant nobody declared. See `missingRequiredFlags`.
    const missing = missingRequiredFlags(plan.args, {
      tools: toolsArgumentFor(plan.grant),
      // The request's worktree, not the plan's `cwd`: the wrapper may legitimately change where the
      // process runs, and ADR-001 scopes `--add-dir` to the run worktree either way.
      addDir: request.worktree,
    });
    if (missing.length > 0) {
      throw new StepSpawnFailed(
        request.step,
        `the argv that would be executed is missing the AD-1 flags ${missing.join(', ')}, which would ` +
          'widen the permission surface without any other observable difference. A flag named with a ' +
          'value other than the one the grant and the worktree composed counts as missing: the contract ' +
          'requires the flag and its value, not the word.',
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
        /**
         * What the roster granted, recorded verbatim beside where it was declared.
         *
         * The roster is authoritative (AD-17), so a grant that diverges from ADR-003's table is passed and
         * *reported* rather than corrected — a corrected grant would make the declaration a lie and hide a
         * misconfiguration. `elevated_tools` is the part a reviewer acts on: it names every granted tool
         * that can change something, which for an agent ADR-003 grants read tools is the divergence itself.
         */
        [SPAWN_GRANT_PAYLOAD_KEYS.GrantedTools]: [...plan.grant.tools],
        [SPAWN_GRANT_PAYLOAD_KEYS.ElevatedTools]: [...plan.grant.elevated],
        [SPAWN_GRANT_PAYLOAD_KEYS.AgentId]: plan.grant.agentId,
        /**
         * The declaration's **file name**, not its path, because AD-21 destroys the path.
         *
         * Measured rather than assumed: `/…/.orch/agents/implementation.toml` comes back from the
         * redaction pass as `/…/.[redacted].toml`. A path segment run with no dot or hyphen —
         * `orch/agents/implementation`, or a 26-character run ULID — crosses the sweep's 24-character,
         * 3.5-bits-per-character threshold and is replaced whole, so recording the path would log the
         * noise and lose the part that locates anything. The file name survives (it is short and carries
         * a dot), the run id is on the envelope verbatim under AD-5's passthrough allow-list, and the
         * directory is `runs/<run-id>/config/agents/` for every run — so the two together still name the
         * file, which the path on its own no longer would. `tests/engine.spawner.test.ts` pins the
         * post-redaction value so this stays a decision rather than a surprise.
         */
        [SPAWN_GRANT_PAYLOAD_KEYS.GrantDeclaredAt]: basename(plan.grant.declaredAt),
        // The flags observed on the executed vector, not the constant that was required: a log that
        // records the requirement rather than the fact cannot be used to audit what actually ran.
        flags: observedFlags,
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
      let stderrTail = '';
      let stderrBytes = 0;
      let nonSubscriptionSource: string | null = null;
      let killedByExecutor = false;
      let timedOut = false;
      let settled = false;

      let child;
      try {
        child = spawn(plan.command, [...plan.args], {
          cwd: plan.cwd,
          env: plan.env,
          stdio: ['ignore', 'pipe', 'pipe'],
          // Its own process group, so a stop reaches the whole tree. `claude` spawns children of its
          // own — MCP servers, hooks — and signalling only the CLI leaves those running, holding the
          // worktree and whatever they had open. This is what makes `-pid` below meaningful.
          detached: true,
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
      onChildStarted();

      /** Signal the whole process group, falling back to the child alone. */
      const signalTree = (signal: NodeJS.Signals): void => {
        try {
          if (child.pid !== undefined) process.kill(-child.pid, signal);
          else child.kill(signal);
        } catch {
          // The group is already gone, or was never one. Either way there is nothing left to signal.
          try {
            child.kill(signal);
          } catch {
            // Nothing to stop.
          }
        }
      };

      let forceKillTimer: NodeJS.Timeout | null = null;
      let attemptTimer: NodeJS.Timeout | null = null;
      const clearTimers = (): void => {
        if (forceKillTimer !== null) clearTimeout(forceKillTimer);
        if (attemptTimer !== null) clearTimeout(attemptTimer);
        forceKillTimer = null;
        attemptTimer = null;
      };

      /**
       * Stop the child, and mean it.
       *
       * `SIGTERM` is a request the child may decline; the escalation to `SIGKILL` after a grace period
       * is what makes the stop terminate. Without it the attempt promise never settles, so the `killed`
       * termination never reaches the loop and a shutdown blocks while still holding the AD-29 writer
       * claim and the AD-30 engine lock.
       */
      const stop = (markKilled: boolean): void => {
        if (markKilled) killedByExecutor = true;
        signalTree(EXECUTOR_KILL_SIGNAL);
        if (forceKillTimer !== null) return;
        forceKillTimer = setTimeout(() => {
          signalTree(EXECUTOR_FORCE_KILL_SIGNAL);
        }, options.killGraceMs ?? EXECUTOR_KILL_GRACE_MS);
        forceKillTimer.unref();
      };

      live.set(key, {
        run: request.run,
        step: request.step,
        attempt: request.attempt,
        stop: () => {
          stop(true);
        },
      });

      /**
       * The wall-clock bound on the attempt.
       *
       * A hang is reported as `interrupted`, not `killed`: `killed` means a person or a steering command
       * stopped this step and AD-8 never resumes or re-runs it, whereas a child that stopped making
       * progress is exactly the case a resume exists for. Calling a timeout `killed` would quietly make
       * every hang terminal.
       */
      attemptTimer = setTimeout(
        () => {
          timedOut = true;
          stop(false);
        },
        options.attemptTimeoutMs ?? DEFAULT_ATTEMPT_TIMEOUT_MS,
      );
      attemptTimer.unref();

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
                try {
                  request.onSessionId(record.sessionId);
                } catch {
                  // The callback runs inside a stdout handler, where a throw escapes as an uncaught
                  // exception and leaves the attempt promise unsettled forever. The id is already on
                  // the log, so the checkpoint can still be rebuilt from it (AD-4).
                }
              }
              break;
            }
            case 'api_key_source': {
              // The decision is taken at `finish` from the parser's own record, so the three cases —
              // named source, unreported field, no init line at all — are distinguishable there. The
              // assertion itself still lives in `cli.ts`, which owns what counts as subscription auth.
              if (!isSubscriptionApiKeySource(record.source) && record.reported) {
                nonSubscriptionSource = record.source;
              }
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

      /** Parse and handle one chunk without letting anything escape into the `data` handler. */
      const consume = (chunk: string): void => {
        try {
          handle(parser.push(chunk));
        } catch {
          // Nothing the parser or the recorder can do wrong is worth an unsettled attempt promise.
        }
      };

      child.stdout?.setEncoding('utf8');
      child.stdout?.on('data', (chunk: string) => {
        consume(chunk);
      });
      child.stderr?.setEncoding('utf8');
      child.stderr?.on('data', (chunk: string) => {
        stderrBytes += Buffer.byteLength(chunk, 'utf8');
        stderrTail = appendTail(stderrTail, chunk);
      });

      const finish = (exitCode: number | null, signal: NodeJS.Signals | null): void => {
        if (settled) return;
        settled = true;
        clearTimers();
        live.delete(key);
        try {
          handle(parser.end());
        } catch {
          // As above: a failed append does not cost the termination.
        }
        if (stderrBytes > 0) {
          emit(recorder, {
            step: request.step,
            type: SPAWNER_EVENT_TYPES.AgentStderr,
            payload: { bytes: stderrBytes, tail: stderrTail },
          });
        }
        const reported = parser.apiKeySource();
        settle({
          sessionId: parser.sessionId(),
          result: parser.result(),
          exitCode,
          // A wrapper reports its child's signal as exit code 128+n, so the translation is applied
          // here rather than at each reader of the outcome.
          signal: signal ?? signalFromExitCode(exitCode),
          stderrTail,
          killedByExecutor,
          timedOut,
          apiKeySource: nonSubscriptionSource,
          // Which of the three cases happened, recorded rather than collapsed: the CLI named a source,
          // the init line carried no such field, or no init line arrived at all.
          apiKeySourceReport:
            reported === null ? 'no-init-line' : reported.reported ? reported.source : 'unreported',
        });
      };

      child.on('error', (thrown: Error) => {
        if (settled) return;
        settled = true;
        clearTimers();
        live.delete(key);
        // `error` before any exit means the process was never created: ENOENT on the command, a cwd
        // that does not exist, a permission problem on the executable. The port says that throws.
        reject(new StepSpawnFailed(request.step, `${thrown.name}: ${thrown.message}`));
      });
      child.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
        finish(code, signal);
      });
    });
  };

  /**
   * Re-parse the terminal output against the originating Zod schema (AD-1).
   *
   * The failure *code* is part of the answer, not an afterthought. `step.schema_invalid_output` is
   * `escalate-model-tier`, so it is the right answer only when a model produced something wrong and a
   * better model might not. An unknown contract id and a shape the port cannot carry are both wiring
   * faults — a registry entry missing, a contract that is not a step output — and no model rung fixes
   * either, so promoting the ladder against them burns the run's one promotion per step on something
   * that will fail identically. Those take `config.invalid`, which is `escalate-to-human`.
   */
  const reparse = (
    contractId: string,
    request: StepStartRequest,
    value: unknown,
  ):
    | { readonly ok: true; readonly output: StepOutput; readonly contractOutput: unknown }
    | { readonly ok: false; readonly detail: string; readonly code: string } => {
    let contract;
    try {
      contract = getContract(contractId);
    } catch (thrown: unknown) {
      return {
        ok: false,
        code: 'config.invalid',
        detail: renderCause(thrown) ?? `unknown contract id "${contractId}"`,
      };
    }
    const first = contract.schema.safeParse(value);
    if (!first.success) {
      return {
        ok: false,
        code: 'step.schema_invalid_output',
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
        code: 'config.invalid',
        detail:
          `the output satisfied "${contractId}" but is not a step output the loop can read: ` +
          shaped.error.issues
            .map((issue) => `${issue.path.map((part) => String(part)).join('.') || '(root)'}: ${issue.code}`)
            .join('; '),
      };
    }

    /**
     * The output has to be about the step that was asked for.
     *
     * Schema validity says the shape is right, not that the content belongs to this attempt. A model
     * that names another step — copying the step name out of the evidence it read, or resuming a session
     * whose transcript was about something else — produces an output that parses perfectly and that the
     * loop would then record as *this* step's result, marking a step complete that never ran.
     */
    if (shaped.data.step !== request.step) {
      return {
        ok: false,
        code: 'step.schema_invalid_output',
        detail: `the output reports step "${shaped.data.step}" but this attempt is step "${request.step}"`,
      };
    }
    if (shaped.data.contract_id !== contractId) {
      return {
        ok: false,
        code: 'step.schema_invalid_output',
        detail: `the output reports contract "${shaped.data.contract_id}" but was validated against "${contractId}"`,
      };
    }
    /**
     * Both values travel: the narrowed one the loop reads, and the one the contract validated.
     *
     * `StepOutputSchema.safeParse` *strips* the fields a phase-specific contract adds — `step.analysis`'s
     * declared territory among them — so returning only `shaped.data` would mean the engine could never
     * see the territory it is supposed to record. `shaped` stays the proof that the value is a step output
     * the loop can read; it is no longer the only thing handed back.
     */
    return { ok: true, output: shaped.data, contractOutput: first.data };
  };

  /** Map one attempt's outcome onto a termination. The whole of AD-8's reachability lives here. */
  const terminationFor = (
    request: StepStartRequest,
    outcome: AttemptOutcome,
    recorder: Recorder,
  ): StepTermination => {
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
          timed_out: outcome.timedOut,
          had_terminal_output: outcome.result !== null,
          api_key_source: outcome.apiKeySourceReport,
          ...(error === null ? {} : { code: error.code }),
        },
        ...(sessionId === null ? {} : { sessionId }),
        baselineRef: request.baselineRef,
      });
    };

    /**
     * Every termination carries the session id and the usage, whatever the disposition.
     *
     * Composed once rather than at each `terminated` call, because a disposition that forgot the usage
     * would silently under-report what a run consumed — and a missing cost reads as a free step, which is
     * the one direction R8 forbids. A result the parser never saw contributes `null`, which is absence.
     */
    const withSession = { sessionId, usage: outcome.result?.usage ?? null };

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

    if (outcome.timedOut) {
      // The attempt's wall-clock bound expired. `interrupted` rather than `killed`, because nobody
      // decided to stop this step — it stopped making progress, which is what a resume is for.
      record('interrupted', null);
      return terminated(request.step, 'interrupted', withSession);
    }

    const result = outcome.result;
    if (result === null) {
      // `outcome.signal` already carries a wrapper's 128+n translation, so a signalled inner process
      // reaches the same branch whether the child was the CLI or a wrapper around it.
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

    const parsed = reparse(request.contractId, request, result.structuredOutput);
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
        parsed.code,
        `The step's structured output was not accepted against the "${request.contractId}" contract, ` +
          'so it was not accepted as a completed step.',
        parsed.detail,
      );
      record('failed', error);
      return terminated(request.step, 'failed', { ...withSession, error });
    }

    const output = parsed.output;
    if (output.status === 'completed') {
      record('completed', null);
      return terminated(request.step, 'completed', {
        ...withSession,
        output,
        contractOutput: parsed.contractOutput,
      });
    }
    // The agent reported its own work blocked or failed. The output is not carried: the port gives
    // `output` only to a `completed` step, and what the AD-35 table is consulted about is the code.
    const error = output.error ?? makeError(FALLBACK_STATUS_CODES[output.status], fallbackDetail(output));
    record(output.status, error);
    return terminated(request.step, output.status, { ...withSession, error });
  };

  return {
    lastPlan: (): SpawnPlan | null => lastPlan,
    planOf: (run: string, step: string, attempt: number): SpawnPlan | null =>
      plans.get(attemptKey(run, step, attempt)) ?? null,
    kill: (step: string, run?: string): boolean => {
      let stopped = false;
      for (const running of live.values()) {
        if (running.step !== step) continue;
        if (run !== undefined && running.run !== run) continue;
        running.stop();
        stopped = true;
      }
      return stopped;
    },
    killAll: (): void => {
      for (const running of live.values()) running.stop();
    },
    start: async (request: StepStartRequest): Promise<StepTermination> => {
      // Resolved once per attempt and passed down. The provider may open a recorder, and AD-29 gives a
      // log exactly one writer — so a second call after the child has already run would hit the
      // single-writer refusal and throw away a termination that was fully earned.
      const recorder = options.recorderFor(request.run, request.feature);
      return terminationFor(request, await runAttempt(request, null, recorder), recorder);
    },
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

      const recorder = options.recorderFor(request.run, request.feature);
      // Whether a child existed at all. A preflight refusal has not spent the run's one resume, so the
      // id is only remembered as spent once a process really ran and really refused.
      let childStarted = false;
      const outcome = await runAttempt(request, request.sessionId, recorder, () => {
        childStarted = true;
      });

      /**
       * The refusal is read off the CLI's own `errors` array first.
       *
       * Recorded: a resume against a session the CLI no longer has emits a *complete* result line —
       * `subtype: "error_during_execution"`, `is_error: true`, `num_turns: 0`, the requested session id,
       * and `errors: ["No conversation found with session ID: …"]` — and exits 1. So the old structural
       * test ("no result line and no session id") was false on both conjuncts and never fired, leaving a
       * prose match on stderr as the only live signal. `errors` is structured JSON the CLI owns, which is
       * what this should have been keyed on.
       *
       * The stderr patterns stay as a secondary signal, for a refusal that produces no result line at
       * all, and each is pinned by its own test so neither can rot unnoticed.
       */
      const refusedByErrors =
        outcome.result !== null &&
        outcome.result.isError &&
        outcome.result.errors.length > 0 &&
        !outcome.result.hasStructuredOutput;
      const refusedByText = RESUME_REFUSAL_PATTERNS.some((pattern) =>
        pattern.test(outcome.stderrTail),
      );
      // A resume whose child never opened a session and produced no result at all did not find it.
      const refusedBySilence =
        outcome.sessionId === null &&
        outcome.result === null &&
        outcome.signal === null &&
        !outcome.killedByExecutor &&
        !outcome.timedOut &&
        outcome.exitCode !== 0;

      if (refusedByErrors || refusedByText || refusedBySilence) {
        const evidence = refusedByErrors
          ? 'the result line carried an errors array'
          : refusedByText
            ? 'the CLI said so on stderr'
            : 'no session was opened and no result was produced';
        if (childStarted) rememberSpent(request.sessionId);
        emit(recorder, {
          step: request.step,
          type: SPAWNER_EVENT_TYPES.AgentExited,
          payload: {
            disposition: 'resume_refused',
            exit_code: outcome.exitCode,
            signal: outcome.signal,
            code: 'step.resume_failed',
            evidence,
          },
          sessionId: request.sessionId,
          baselineRef: request.baselineRef,
        });
        const reported = outcome.result?.errors[0] ?? outcome.stderrTail.trim();
        throw new ResumeRefused(
          request.step,
          request.sessionId,
          reported === ''
            ? `the CLI exited with code ${String(outcome.exitCode)} without opening the session`
            : reported,
        );
      }

      return terminationFor(request, outcome, recorder);
    },
  };
};
