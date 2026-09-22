/**
 * AD-1's spawn contract, driven against a real subprocess and recorded fixtures.
 *
 * Two things about the shape of this suite are deliberate.
 *
 * **It spawns a real child.** `tests/helpers/fake-claude.ts` is a Node script the spawner really
 * executes, replaying a committed transcript. Everything this story can get wrong is a property of a
 * real process — a signal arriving mid-stream, stdout cut into chunks that split a JSON line, an exit
 * code racing the final flush, a session id that must reach the parent before the child dies — and an
 * in-process double has none of them. It also satisfies the acceptance criterion literally: no real
 * `claude` process is created and no model call is spent.
 *
 * **It asserts the flag set explicitly, not the behaviour that depends on it.** A missing
 * `--restricted` or `--strict-mcp-config` widens the permission surface and changes nothing else that
 * a test could notice, so the argv is compared against the declared constant and the child is asked
 * what it actually received.
 */
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { dispositionFor, exportContract, StepInputSchema } from '../src/contracts/index.js';
import type { StepInput } from '../src/contracts/index.js';
import {
  REDACTION_MARKER,
  Recorder,
  readEventLog,
  redactValue,
  runPaths,
} from '../src/runtime/index.js';
import type { EventEnvelope } from '../src/contracts/index.js';
import {
  AD1_REQUIRED_FLAGS,
  AgentGrantUnresolved,
  ApiKeyModeRefusedError,
  ClaudeCliVersionError,
  McpToolNotPreApproved,
  createStepSpawner,
  buildStepArgv,
  errorCodeForResult,
  missingRequiredFlags,
  signalFromExitCode,
  resolveClaudeCli,
  ResumeRefused,
  SPAWN_GRANT_PAYLOAD_KEYS,
  SPAWNER_EMITTER,
  SPAWNER_EVENT_TYPES,
  takeConfigSnapshot,
  StepSpawnFailed,
  STREAM_OUTPUT_FORMAT,
} from '../src/engine/index.js';
import type {
  AgentGrant,
  ChildNode,
  ClaudeCli,
  SpawnPlan,
  StepSpawner,
  StepStartRequest,
} from '../src/engine/index.js';

import { RUNNER_ALLOWED_TOOL } from '../src/runner/index.js';

import { fixtureGrant } from './helpers/agent-grant.js';
import {
  fixtureAgent,
  fixtureProfile,
  writeAgentFile,
  writeProfile,
} from './helpers/config-fixture.js';

const FAKE_CLI_PATH = fileURLToPath(new URL('./helpers/fake-claude.ts', import.meta.url));
const FIXTURES = fileURLToPath(new URL('./fixtures/stream-json/', import.meta.url));

/** The fake CLI, presented as a resolved one. The version is the recorded transcript's own. */
const fakeCli: ClaudeCli = {
  path: FAKE_CLI_PATH,
  version: '2.1.278',
  auth: 'subscription',
  interpreter: 'node',
};

/** The interpreter this suite runs on, which has already passed the engine's own floor assertion. */
const childNode: ChildNode = {
  path: process.execPath,
  version: process.versions.node,
  source: 'parent',
};

const REAL_SESSION_ID = '33f452b6-11d0-4ea7-89e9-7dc2962643ad';

/** The id the real CLI's refusal transcript was recorded against. */
const DEAD_SESSION_ID = '00000000-dead-4bee-8000-000000000000';

const stepInputFixture = (): StepInput =>
  StepInputSchema.parse(
    JSON.parse(
      readFileSync(new URL('./fixtures/structured-output/step.input.json', import.meta.url), 'utf8'),
    ),
  );

interface Harness {
  readonly run: string;
  readonly feature: string;
  readonly worktree: string;
  /** The temp `ORCH_HOME` this harness's run lives under, for a case that snapshots configuration. */
  readonly home: string;
  readonly spawner: StepSpawner;
  /** The same recorder the spawner writes through, for a test that builds a second spawner. */
  readonly recorder: Recorder;
  readonly env: NodeJS.ProcessEnv;
  readonly request: (overrides?: Partial<StepStartRequest>) => StepStartRequest;
  readonly sessionIds: string[];
  readonly events: () => readonly EventEnvelope[];
  readonly eventsOfType: (type: string) => readonly EventEnvelope[];
  readonly argvSeenByChild: () => readonly string[];
  readonly close: () => void;
}

const open = (
  options: {
    readonly fixture?: string;
    /** An absolute transcript path, for a variant derived inside a single test. */
    readonly fixturePath?: string;
    readonly fakeEnv?: NodeJS.ProcessEnv;
    readonly cli?: ClaudeCli | (() => ClaudeCli);
    readonly mcpConfigs?: readonly string[];
    readonly wrap?: (plan: SpawnPlan) => SpawnPlan;
    /** Run the fake through a `#!/bin/sh` shim, so the `direct` interpreter branch really executes. */
    readonly direct?: boolean;
    readonly attemptTimeoutMs?: number;
    readonly killGraceMs?: number;
    readonly refusalFixture?: string;
    /**
     * The AD-17 grant `--tools` is built from.
     *
     * Injected rather than resolved from a snapshot: this suite's subject is the process, and the
     * resolution from `.orch/agents/` through the AD-9 snapshot is `tests/engine.agents.test.ts`'s. There
     * is no default *inside* the spawner — `grantFor` has no fallback — so something has to supply one
     * here, which is the point of making it a required argument.
     */
    readonly grant?: AgentGrant;
  } = {},
): Harness => {
  const home = mkdtempSync(join(tmpdir(), 'orch-spawner-home-'));
  const worktree = mkdtempSync(join(tmpdir(), 'orch-spawner-tree-'));
  const run = '01JSPAWNER000000000000000A';
  const feature = 'step-spawner';
  const argvOut = join(home, 'argv.json');

  const recorder = Recorder.open({ runId: run, feature, orchHome: home });
  const sessionIds: string[] = [];

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...(options.fixturePath === undefined ? {} : { FAKE_CLAUDE_FIXTURE: options.fixturePath }),
    ...(options.fixture === undefined
      ? {}
      : { FAKE_CLAUDE_FIXTURE: join(FIXTURES, options.fixture) }),
    FAKE_CLAUDE_ARGV_OUT: argvOut,
    FAKE_CLAUDE_REFUSAL_FIXTURE: join(FIXTURES, options.refusalFixture ?? 'resume-refused.jsonl'),
    ...options.fakeEnv,
  };
  // A developer's own API-key environment must not decide what this suite proves.
  delete env['ANTHROPIC_API_KEY'];
  delete env['ANTHROPIC_AUTH_TOKEN'];

  /**
   * A real executable that execs the fake.
   *
   * The `direct` branch is the one a real install takes — `claude` on this machine is a compiled
   * Mach-O binary, which `classifyCliEntry` calls `direct` — and pinning `interpreter: 'node'` in every
   * test left it never executed. A `#!/bin/sh` shim is a genuine executable with no Node interpreter to
   * substitute, so the branch runs for real and the same argv assertions apply to it.
   */
  const directShim = (): ClaudeCli => {
    const shim = join(home, 'claude');
    writeFileSync(shim, `#!/bin/sh\nexec ${process.execPath} ${FAKE_CLI_PATH} "$@"\n`, 'utf8');
    chmodSync(shim, 0o755);
    return { path: shim, version: '2.1.278', auth: 'subscription', interpreter: 'direct' };
  };

  const grant = options.grant ?? fixtureGrant();
  const spawner = createStepSpawner({
    recorderFor: () => recorder,
    cli: options.cli ?? (options.direct === true ? directShim() : fakeCli),
    node: childNode,
    env,
    grantFor: () => grant,
    ...(options.mcpConfigs === undefined ? {} : { mcpConfigs: options.mcpConfigs }),
    ...(options.wrap === undefined ? {} : { wrap: options.wrap }),
    ...(options.attemptTimeoutMs === undefined ? {} : { attemptTimeoutMs: options.attemptTimeoutMs }),
    ...(options.killGraceMs === undefined ? {} : { killGraceMs: options.killGraceMs }),
  });

  const inputPath = join(worktree, 'step-input.json');
  const input = stepInputFixture();
  mkdirSync(worktree, { recursive: true });
  writeFileSync(inputPath, JSON.stringify(input), 'utf8');

  const request = (overrides: Partial<StepStartRequest> = {}): StepStartRequest => ({
    run,
    feature,
    step: 'implement',
    phase: 'implementation',
    contractId: 'step.output',
    input,
    inputPath,
    baselineRef: 'ddd9bed4d286ac1f8a0f4f7bfef9530046605787',
    worktree,
    modelTier: 'claude-haiku-4-5',
    attempt: 1,
    mode: 'live',
    onSessionId: (sessionId: string) => {
      sessionIds.push(sessionId);
    },
    ...overrides,
  });

  const events = (): readonly EventEnvelope[] => readEventLog(runPaths(run, home).eventLog);

  return {
    run,
    feature,
    worktree,
    home,
    spawner,
    recorder,
    env,
    request,
    sessionIds,
    events,
    eventsOfType: (type: string): readonly EventEnvelope[] =>
      events().filter((event) => event.type === type),
    argvSeenByChild: (): readonly string[] =>
      JSON.parse(readFileSync(argvOut, 'utf8')) as readonly string[],
    close: (): void => {
      spawner.killAll();
      recorder.close();
    },
  };
};

const harnesses: Harness[] = [];

const openTracked = (...args: Parameters<typeof open>): Harness => {
  const harness = open(...args);
  harnesses.push(harness);
  return harness;
};

afterEach(() => {
  while (harnesses.length > 0) harnesses.pop()?.close();
});

/**
 * The two arguments story 2-4 made required on `buildStepArgv`.
 *
 * They have no defaults in the function, so every call names them: an argv built with no grant is a
 * compile error rather than a spawn that quietly passed none. Spelled as literals here, and the
 * assertions below compare the argv to literals too, so no case compares a value to itself.
 */
const GRANTED_TOOLS = 'Read,Grep,Glob';
const ADD_DIR = '/tmp/orch-spawner-argv-worktree';

describe('the AD-1 argv', () => {
  it('carries every required flag, and the suite knows which they are', () => {
    expect([...AD1_REQUIRED_FLAGS]).toStrictEqual([
      '--json-schema',
      '--output-format',
      '--strict-mcp-config',
      '--restricted',
      // ADR-001's last two, absent from this list until story 2-4 — which is why
      // `missingRequiredFlags` reported that the contract held while the grant was never passed.
      // `tests/engine.spawner.tools.test.ts` asserts the list against ADR-001's enumeration itself.
      '--add-dir',
      '--tools',
    ]);
    const argv = buildStepArgv({
      schema: exportContract('step.output'),
      prompt: 'do the thing',
      model: 'claude-haiku-4-5',
      tools: GRANTED_TOOLS,
      addDir: ADD_DIR,
    });
    expect(missingRequiredFlags(argv)).toStrictEqual([]);
    // The guard itself has to be able to fail, or it proves nothing about the argv it passes.
    expect(missingRequiredFlags(argv.filter((arg) => arg !== '--restricted'))).toStrictEqual([
      '--restricted',
    ]);
  });

  it('passes the registered contract\'s draft-7 export to --json-schema, not a hand-built schema', () => {
    const argv = buildStepArgv({
      schema: exportContract('step.output'),
      prompt: 'p',
      model: 'claude-sonnet-5',
      tools: GRANTED_TOOLS,
      addDir: ADD_DIR,
    });
    const schemaArg = argv[argv.indexOf('--json-schema') + 1] ?? '';
    expect(JSON.parse(schemaArg)).toStrictEqual(exportContract('step.output'));
    // AD-2: draft-7, because `--json-schema` rejects draft-2020-12.
    expect(JSON.parse(schemaArg)).toHaveProperty('$schema', 'http://json-schema.org/draft-07/schema#');
    expect(argv[argv.indexOf('--output-format') + 1]).toBe(STREAM_OUTPUT_FORMAT);
    expect(argv[argv.indexOf('--model') + 1]).toBe('claude-sonnet-5');
  });

  it('passes --strict-mcp-config with no servers, and --mcp-config only when there are some', () => {
    const none = buildStepArgv({
      schema: {},
      prompt: 'p',
      model: 'claude-haiku-4-5',
      tools: GRANTED_TOOLS,
      addDir: ADD_DIR,
    });
    expect(none).toContain('--strict-mcp-config');
    // Still an absence worth asserting, and still about MCP: `--mcp-config` is a different flag from the
    // two story 2-4 added, and neither of those can make this pass for a new reason.
    expect(none).not.toContain('--mcp-config');

    const some = buildStepArgv({
      schema: {},
      prompt: 'p',
      model: 'claude-haiku-4-5',
      tools: GRANTED_TOOLS,
      addDir: ADD_DIR,
      mcpConfigs: ['/a.json', '/b.json'],
    });
    expect(some).toContain('--mcp-config');
    expect(some.slice(some.indexOf('--mcp-config') + 1)).toStrictEqual(['/a.json', '/b.json']);
  });

  it('adds --resume only for a resume, and only the recorded id', () => {
    expect(
      buildStepArgv({
        schema: {},
        prompt: 'p',
        model: 'claude-haiku-4-5',
        tools: GRANTED_TOOLS,
        addDir: ADD_DIR,
      }),
    ).not.toContain('--resume');
    const resumed = buildStepArgv({
      schema: {},
      prompt: 'p',
      model: 'claude-haiku-4-5',
      tools: GRANTED_TOOLS,
      addDir: ADD_DIR,
      resumeSessionId: REAL_SESSION_ID,
    });
    expect(resumed[resumed.indexOf('--resume') + 1]).toBe(REAL_SESSION_ID);
  });

  it('is what the child actually receives, and the child is run by an absolute Node', async () => {
    const harness = openTracked({ fixture: 'completed.jsonl' });
    await harness.spawner.start(harness.request());

    const plan = harness.spawner.lastPlan();
    expect(plan).not.toBeNull();
    expect(plan?.command).toBe(process.execPath);
    expect(plan?.command.startsWith('/')).toBe(true);
    expect(plan?.node.version).toBe(process.versions.node);
    expect(plan?.cwd).toBe(harness.worktree);
    // No real CLI was involved anywhere.
    expect(plan?.cli.path).toBe(FAKE_CLI_PATH);

    // What the child saw, read back from the child itself rather than from the plan.
    const argv = harness.argvSeenByChild();
    for (const flag of AD1_REQUIRED_FLAGS) expect(argv).toContain(flag);
    expect(argv[argv.indexOf('--output-format') + 1]).toBe(STREAM_OUTPUT_FORMAT);
    // ADR-001's two, read back from the child rather than from the plan: `--add-dir` is the run worktree
    // and `--tools` is the grant, both as the process actually received them.
    expect(argv[argv.indexOf('--add-dir') + 1]).toBe(harness.worktree);
    expect(argv[argv.indexOf('--tools') + 1]).toBe('Read,Write,Edit,Grep,Glob,Bash');
    expect(JSON.parse(argv[argv.indexOf('--json-schema') + 1] ?? '')).toStrictEqual(
      exportContract('step.output'),
    );
    expect(argv).toContain('--print');
  });

  it('records the resolved child Node version, as AD-28 requires', async () => {
    const harness = openTracked({ fixture: 'completed.jsonl' });
    await harness.spawner.start(harness.request());
    const spawned = harness.eventsOfType(SPAWNER_EVENT_TYPES.AgentSpawned);
    expect(spawned).toHaveLength(1);
    expect(spawned[0]?.payload['node_version']).toBe(process.versions.node);
    expect(spawned[0]?.payload['cli_version']).toBe('2.1.278');
    expect(spawned[0]?.payload['flags']).toStrictEqual([...AD1_REQUIRED_FLAGS]);
    expect(spawned[0]?.emitter).toBe(SPAWNER_EMITTER);
  });
});

describe('a step that completes', () => {
  it('returns the re-parsed output from the recorded transcript', async () => {
    const harness = openTracked({ fixture: 'completed.jsonl' });
    const termination = await harness.spawner.start(harness.request());

    expect(termination.disposition).toBe('completed');
    expect(termination.error).toBeNull();
    expect(termination.sessionId).toBe(REAL_SESSION_ID);
    expect(termination.output).not.toBeNull();
    expect(termination.output?.contract_id).toBe('step.output');
    expect(termination.output?.status).toBe('completed');
    // The value the loop receives is the parsed object, not the raw stream text.
    expect(termination.output?.summary).toContain('answer');
  });

  it('emits exactly one spawn and one exit per attempt', async () => {
    const harness = openTracked({ fixture: 'completed.jsonl' });
    await harness.spawner.start(harness.request());
    expect(harness.eventsOfType(SPAWNER_EVENT_TYPES.AgentSpawned)).toHaveLength(1);
    const exits = harness.eventsOfType(SPAWNER_EVENT_TYPES.AgentExited);
    expect(exits).toHaveLength(1);
    expect(exits[0]?.payload['disposition']).toBe('completed');
    expect(exits[0]?.payload['had_terminal_output']).toBe(true);
  });

  /**
   * Story 1-11's task 5, asserted on the one path a real run takes.
   *
   * `tests/contracts.usage.test.ts` proves the parser and `tests/engine.usage.test.ts` proves the fold, but
   * both hand their numbers in: one calls `usageFromResultLine` directly and the other scripts an executor
   * double with a pre-built `StepTermination`. Neither touches the single line in `spawner.ts` where the
   * parsed usage crosses onto the termination the reconciler writes to `step.terminated` — so replacing it
   * with `usage: null` left all 1522 tests passing, and the whole cost-and-token half of this story could
   * have been a no-op in production while every surface read `(not recorded)` and AD-24's ceilings had
   * nothing to decide against. This is the assertion that closes that: the real spawner, the real
   * transcript, the numbers that transcript actually carries.
   */
  it('carries the cost and token counts the transcript reports onto the termination', async () => {
    const harness = openTracked({ fixture: 'completed.jsonl' });
    const termination = await harness.spawner.start(harness.request());

    expect(termination.disposition).toBe('completed');
    // The values are the recorded transcript's own terminal result line, not a fixture written here.
    expect(termination.usage).toEqual({
      cost_usd: 0.0354739,
      input_tokens: 18,
      output_tokens: 524,
      cache_creation_input_tokens: 15647,
      cache_read_input_tokens: 15419,
    });
  });

  it('survives stdout arriving in chunks that cut JSON lines apart', async () => {
    const harness = openTracked({
      fixture: 'completed.jsonl',
      fakeEnv: { FAKE_CLAUDE_SPLIT_WRITES: '64' },
    });
    const termination = await harness.spawner.start(harness.request());
    expect(termination.disposition).toBe('completed');
    expect(harness.eventsOfType(SPAWNER_EVENT_TYPES.AgentStreamUnparseable)).toHaveLength(0);
  });
});

describe('an output that fails its schema', () => {
  it('is not accepted as completed and never reaches the loop', async () => {
    const harness = openTracked({ fixture: 'schema-invalid-output.jsonl' });
    const termination = await harness.spawner.start(harness.request());

    expect(termination.disposition).not.toBe('completed');
    expect(termination.disposition).toBe('failed');
    expect(termination.output).toBeNull();
    expect(termination.error?.code).toBe('step.schema_invalid_output');
    // AD-35 makes this the model-ladder promotion trigger, not a retry.
    expect(termination.error?.retryable).toBe(false);

    const rejected = harness.eventsOfType(SPAWNER_EVENT_TYPES.AgentOutputRejected);
    expect(rejected).toHaveLength(1);
    expect(String(rejected[0]?.payload['detail'])).toContain('status');
    // The invalid value itself is not in the log either; only why it was rejected.
    expect(JSON.stringify(harness.events())).not.toContain('finished');
  });

  it('treats a stream with no structured output as failed, not completed', async () => {
    const harness = openTracked({ fixture: 'no-structured-output.jsonl' });
    const termination = await harness.spawner.start(harness.request());
    expect(termination.disposition).toBe('failed');
    expect(termination.output).toBeNull();
    expect(termination.error?.code).toBe('step.stream_malformed');
  });

  it('maps a CLI error result onto the code its subtype earns', async () => {
    const harness = openTracked({ fixture: 'error-result.jsonl' });
    const termination = await harness.spawner.start(harness.request());
    expect(termination.disposition).toBe('failed');
    expect(termination.error?.code).toBe('step.timed_out');
    expect(
      errorCodeForResult({
        kind: 'result',
        subtype: 'error_during_execution',
        isError: true,
        hasStructuredOutput: false,
        structuredOutput: undefined,
        sessionId: null,
        numTurns: null,
        errors: [],
        // Story 1-11 added the field; a result carrying no usage records none (R8).
        usage: null,
      }),
    ).toBe('step.stream_malformed');
  });
});

describe('the session id', () => {
  it('is reported once, before the termination resolves', async () => {
    const harness = openTracked({
      fixture: 'completed.jsonl',
      // Pause after the init line, which is the line that announces the session id.
      fakeEnv: { FAKE_CLAUDE_PAUSE_AFTER: '1', FAKE_CLAUDE_PAUSE_MS: '150' },
    });

    let terminationResolved = false;
    const running = harness.spawner.start(harness.request()).then((termination) => {
      terminationResolved = true;
      return termination;
    });

    // Wait for the id to arrive, then check the attempt is demonstrably still in flight.
    while (harness.sessionIds.length === 0) await new Promise((resolve) => setImmediate(resolve));
    expect(terminationResolved).toBe(false);
    expect(harness.sessionIds).toStrictEqual([REAL_SESSION_ID]);

    const termination = await running;
    expect(termination.sessionId).toBe(REAL_SESSION_ID);
    // Once per attempt, however many stream lines carry it.
    expect(harness.sessionIds).toStrictEqual([REAL_SESSION_ID]);
    expect(harness.eventsOfType(SPAWNER_EVENT_TYPES.AgentSessionAnnounced)).toHaveLength(1);
    expect(harness.eventsOfType(SPAWNER_EVENT_TYPES.AgentSessionAnnounced)[0]?.session_id).toBe(
      REAL_SESSION_ID,
    );
  });
});

describe('the disposition mapping', () => {
  it('maps a child killed by a signal with no terminal output to interrupted, not failed', async () => {
    const harness = openTracked({
      fixture: 'no-terminal-output.jsonl',
      fakeEnv: { FAKE_CLAUDE_SIGNAL: 'SIGKILL' },
    });
    const termination = await harness.spawner.start(harness.request());

    // Getting this backwards makes resume dead code, and a naive test still passes.
    expect(termination.disposition).toBe('interrupted');
    expect(termination.error).toBeNull();
    expect(termination.output).toBeNull();
    // With the session id, which is the only thing a resume can be attempted by.
    expect(termination.sessionId).toBe(REAL_SESSION_ID);
    expect(harness.eventsOfType(SPAWNER_EVENT_TYPES.AgentExited)[0]?.payload['signal']).toBe(
      'SIGKILL',
    );
  });

  it('maps an executor-initiated stop to killed, which AD-8 never resumes', async () => {
    const harness = openTracked({
      fixture: 'no-terminal-output.jsonl',
      fakeEnv: { FAKE_CLAUDE_HANG: '1' },
    });
    const running = harness.spawner.start(harness.request());
    while (harness.sessionIds.length === 0) await new Promise((resolve) => setImmediate(resolve));

    expect(harness.spawner.kill('implement')).toBe(true);
    const termination = await running;
    expect(termination.disposition).toBe('killed');
    expect(termination.sessionId).toBe(REAL_SESSION_ID);
    expect(harness.spawner.kill('implement')).toBe(false);
  });

  it('maps a non-zero exit with no terminal output to failed, with a code the table knows', async () => {
    const harness = openTracked({
      fixture: 'no-terminal-output.jsonl',
      fakeEnv: { FAKE_CLAUDE_EXIT: '3', FAKE_CLAUDE_STDERR: 'the CLI gave up' },
    });
    const termination = await harness.spawner.start(harness.request());
    expect(termination.disposition).toBe('failed');
    expect(termination.error?.code).toBe('step.stream_malformed');
    expect(termination.error?.cause).toContain('the CLI gave up');
    expect(harness.eventsOfType(SPAWNER_EVENT_TYPES.AgentStderr)).toHaveLength(1);
  });

  it('carries a step\'s own blocked status through as a blocked termination', async () => {
    // Derived from the real result line by editing the status the agent reported about its own work.
    const lines = readFileSync(join(FIXTURES, 'completed.jsonl'), 'utf8').trim().split('\n');
    const result = JSON.parse(lines.at(-1) ?? '{}') as Record<string, unknown>;
    result['structured_output'] = {
      ...(result['structured_output'] as Record<string, unknown>),
      status: 'blocked',
      error: {
        code: 'question.unanswerable',
        message: 'the input does not say which of two schemas to use',
        retryable: false,
        cause: null,
      },
    };
    const path = join(mkdtempSync(join(tmpdir(), 'orch-blocked-')), 'blocked.jsonl');
    writeFileSync(path, `${[...lines.slice(0, -1), JSON.stringify(result)].join('\n')}\n`, 'utf8');

    const harness = openTracked({ fixturePath: path });
    const termination = await harness.spawner.start(harness.request());

    expect(termination.disposition).toBe('blocked');
    expect(termination.error?.code).toBe('question.unanswerable');
    // The port gives `output` only to a completed step; what the AD-35 table judges is the code.
    expect(termination.output).toBeNull();
  });
});

describe('resume', () => {
  it('completes from the resumed session, passing the recorded id', async () => {
    const harness = openTracked({ fixture: 'completed.jsonl' });
    const termination = await harness.spawner.resume({
      ...harness.request(),
      sessionId: REAL_SESSION_ID,
    });
    expect(termination.disposition).toBe('completed');
    expect(harness.argvSeenByChild()).toContain('--resume');
    expect(
      harness.argvSeenByChild()[harness.argvSeenByChild().indexOf('--resume') + 1],
    ).toBe(REAL_SESSION_ID);
  });

  it('throws ResumeRefused carrying step.resume_failed, in the shape the real CLI produces', async () => {
    const harness = openTracked({ fakeEnv: { FAKE_CLAUDE_REFUSE_RESUME: 'both' } });
    let thrown: unknown;
    try {
      await harness.spawner.resume({ ...harness.request(), sessionId: DEAD_SESSION_ID });
    } catch (error: unknown) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ResumeRefused);
    const refusal = thrown as ResumeRefused;
    expect(refusal.code).toBe('step.resume_failed');
    expect(refusal.sessionId).toBe(DEAD_SESSION_ID);
    expect(refusal.message).toContain('baseline');
    // The detail is the CLI's own sentence, taken from the structured `errors` array.
    expect(refusal.message).toContain('No conversation found with session ID');
  });

  it('does not report the dead session id the refusal line carries', async () => {
    // Recorded: the refusal result line carries the *requested* session id. Announcing it would have
    // the checkpoint record a session that does not exist as the live one, and AD-8 grants one resume
    // per recorded id — so the next pass would spend it on a session the CLI has already denied.
    const harness = openTracked({ fakeEnv: { FAKE_CLAUDE_REFUSE_RESUME: 'both' } });
    await expect(
      harness.spawner.resume({ ...harness.request(), sessionId: DEAD_SESSION_ID }),
    ).rejects.toThrowError(ResumeRefused);

    expect(harness.sessionIds).toStrictEqual([]);
    expect(harness.eventsOfType(SPAWNER_EVENT_TYPES.AgentSessionAnnounced)).toHaveLength(0);
  });

  it('recognises the refusal from the errors array alone, with nothing on stderr', async () => {
    // Pins the structural signal by itself: the recorded stdout line and no stderr at all, so a
    // regression that deleted the `errors` check could not be masked by the prose match.
    const harness = openTracked({ fakeEnv: { FAKE_CLAUDE_REFUSE_RESUME: 'stdout-only' } });
    let thrown: unknown;
    try {
      await harness.spawner.resume({ ...harness.request(), sessionId: DEAD_SESSION_ID });
    } catch (error: unknown) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ResumeRefused);
    expect(harness.eventsOfType(SPAWNER_EVENT_TYPES.AgentStderr)).toHaveLength(0);
    const exited = harness.eventsOfType(SPAWNER_EVENT_TYPES.AgentExited);
    expect(exited[0]?.payload['evidence']).toBe('the result line carried an errors array');
  });

  it('recognises a refusal the errors array cannot see, from stderr alone', async () => {
    // Pins the secondary signal by itself: an init line arrives (so the silence heuristic cannot fire)
    // and the result line has no `errors` (so the structural signal cannot fire). Only the text is left.
    const harness = openTracked({
      fakeEnv: { FAKE_CLAUDE_REFUSE_RESUME: 'both' },
      refusalFixture: 'resume-refused-no-errors.jsonl',
    });
    let thrown: unknown;
    try {
      await harness.spawner.resume({ ...harness.request(), sessionId: DEAD_SESSION_ID });
    } catch (error: unknown) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ResumeRefused);
    const exited = harness.eventsOfType(SPAWNER_EVENT_TYPES.AgentExited);
    expect(exited[0]?.payload['evidence']).toBe('the CLI said so on stderr');
  });

  it('never attempts a second resume against the same id', async () => {
    const harness = openTracked({ fakeEnv: { FAKE_CLAUDE_REFUSE_RESUME: 'both' } });
    const resumeRequest = { ...harness.request(), sessionId: DEAD_SESSION_ID };

    await expect(harness.spawner.resume(resumeRequest)).rejects.toThrowError(ResumeRefused);
    const spawnsAfterFirst = harness.eventsOfType(SPAWNER_EVENT_TYPES.AgentSpawned).length;

    await expect(harness.spawner.resume(resumeRequest)).rejects.toThrowError(ResumeRefused);
    // The second refusal created no process at all: the spent id is refused before the spawn.
    expect(harness.eventsOfType(SPAWNER_EVENT_TYPES.AgentSpawned)).toHaveLength(spawnsAfterFirst);
  });

  it('does not spend the one resume AD-8 grants on a refusal that created no process', async () => {
    // The preflight refuses before any child exists, so the id has not been used. A resume that then
    // becomes possible must still be allowed — burning it here would make a machine misconfiguration
    // permanently cost the run its recovery.
    const harness = openTracked({
      fixture: 'completed.jsonl',
      cli: {
        path: join(tmpdir(), 'orch-no-such-cli-ever.ts'),
        version: '2.1.278',
        auth: 'subscription',
        interpreter: 'node',
      },
    });
    const resumeRequest = { ...harness.request(), sessionId: DEAD_SESSION_ID };
    await expect(harness.spawner.resume(resumeRequest)).rejects.toThrowError(StepSpawnFailed);
    // Not `ResumeRefused`: the id is still unspent, so the same resume is attempted again for real.
    await expect(harness.spawner.resume(resumeRequest)).rejects.toThrowError(StepSpawnFailed);
  });

  it('does not spend the id on a resume that succeeded', async () => {
    // A step that resumed, was interrupted again and is resumed again is the loop doing its job.
    const harness = openTracked({ fixture: 'completed.jsonl' });
    const resumeRequest = { ...harness.request(), sessionId: REAL_SESSION_ID };
    expect((await harness.spawner.resume(resumeRequest)).disposition).toBe('completed');
    expect((await harness.spawner.resume(resumeRequest)).disposition).toBe('completed');
    expect(harness.eventsOfType(SPAWNER_EVENT_TYPES.AgentSpawned)).toHaveLength(2);
  });

  it('refuses a resume whose child produced nothing at all', async () => {
    const harness = openTracked({ fakeEnv: { FAKE_CLAUDE_EXIT: '1' } });
    let thrown: unknown;
    try {
      await harness.spawner.resume({ ...harness.request(), sessionId: 'sess-that-is-gone' });
    } catch (error: unknown) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ResumeRefused);
    const exited = harness.eventsOfType(SPAWNER_EVENT_TYPES.AgentExited);
    expect(exited[0]?.payload['evidence']).toBe(
      'no session was opened and no result was produced',
    );
  });
});

describe('the stream as the permission and telemetry surface', () => {
  it('records a tool use with parent_tool_use_id preserved byte for byte', async () => {
    const harness = openTracked({ fixture: 'nested-tool-use.jsonl' });
    await harness.spawner.start(harness.request());

    const used = harness.eventsOfType(SPAWNER_EVENT_TYPES.AgentToolUsed);
    expect(used.length).toBeGreaterThan(0);
    const nested = used.find((event) => event.parent_tool_use_id !== null);
    expect(nested?.parent_tool_use_id).toBe('toolu_01ParentOfTheNestedSubagentCall');
    expect(nested?.payload['tool']).toBe('Read');
    // The id survived the AD-21 pass unchanged, which is what AD-5's verbatim rule requires.
    expect(readFileSync(join(FIXTURES, 'nested-tool-use.jsonl'), 'utf8')).toContain(
      String(nested?.parent_tool_use_id),
    );
  });

  it('records a permission denial as a permission.denied event', async () => {
    const harness = openTracked({ fixture: 'completed-with-denial.jsonl' });
    const termination = await harness.spawner.start(harness.request());
    expect(termination.disposition).toBe('completed');

    const denied = harness.eventsOfType('permission.denied');
    expect(denied).toHaveLength(1);
    expect(denied[0]?.payload['tool']).toBe('Write');
    expect(String(denied[0]?.payload['reason'])).toContain('--restricted');
    expect(denied[0]?.emitter).toBe(SPAWNER_EMITTER);
  });

  it('records and skips an unparseable line, and the step still terminates', async () => {
    const harness = openTracked({ fixture: 'unparseable-line.jsonl' });
    const termination = await harness.spawner.start(harness.request());

    expect(termination.disposition).toBe('completed');
    const skipped = harness.eventsOfType(SPAWNER_EVENT_TYPES.AgentStreamUnparseable);
    expect(skipped).toHaveLength(1);
    expect(Number(skipped[0]?.payload['bytes'])).toBeGreaterThan(0);
  });

  it('writes every event through the recorder, which assigns seq', async () => {
    const harness = openTracked({ fixture: 'completed.jsonl' });
    await harness.spawner.start(harness.request());
    const events = harness.events();
    expect(events.length).toBeGreaterThan(2);
    expect(events.map((event) => event.seq)).toStrictEqual(
      events.map((_event, index) => index + 1),
    );
    for (const event of events) {
      expect(event.run).toBe(harness.run);
      expect(event.feature).toBe(harness.feature);
    }
  });
});

describe('a spawn that cannot happen', () => {
  it('throws StepSpawnFailed when the CLI is absent', async () => {
    const harness = openTracked({
      cli: {
        path: join(tmpdir(), 'orch-no-such-cli-ever.ts'),
        version: '2.1.278',
        auth: 'subscription',
        interpreter: 'node',
      },
    });
    // Thrown, not returned as a termination.
    await expect(harness.spawner.start(harness.request())).rejects.toThrowError(StepSpawnFailed);
  });

  it('refuses API-key mode before creating a process, keeping its own AD-35 code', async () => {
    const harness = openTracked({
      cli: () =>
        resolveClaudeCli({
          env: { ...process.env, ANTHROPIC_API_KEY: 'a-key-that-should-never-be-used' },
          path: FAKE_CLI_PATH,
          probeVersion: () => {
            throw new Error('a process was created before the refusal');
          },
        }),
    });
    let thrown: unknown;
    try {
      await harness.spawner.start(harness.request());
    } catch (error: unknown) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ApiKeyModeRefusedError);
    expect((thrown as ApiKeyModeRefusedError).code).toBe('model.api_key_mode_refused');
    expect((thrown as Error).message).toContain('subscription');
    // No process, so no spawn event either.
    expect(harness.eventsOfType(SPAWNER_EVENT_TYPES.AgentSpawned)).toHaveLength(0);
  });

  it('refuses a CLI below the pinned floor, naming the required version', async () => {
    const harness = openTracked({
      cli: () =>
        resolveClaudeCli({
          env: { ...process.env, ANTHROPIC_API_KEY: '' },
          path: FAKE_CLI_PATH,
          probeVersion: () => '2.1.100',
        }),
    });
    let thrown: unknown;
    try {
      await harness.spawner.start(harness.request());
    } catch (error: unknown) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ClaudeCliVersionError);
    expect((thrown as Error).message).toContain('2.1.259');
    expect(harness.eventsOfType(SPAWNER_EVENT_TYPES.AgentSpawned)).toHaveLength(0);
  });
});

describe('the AD-20 container seam', () => {
  it('runs whatever vector the wrapper returns, and this story composes no flags of its own', async () => {
    const seen: SpawnPlan[] = [];
    const harness = openTracked({
      fixture: 'completed.jsonl',
      wrap: (plan) => {
        seen.push(plan);
        // A wrapper prefixes the vector; story 1-5 supplies the real one.
        return { ...plan, args: [...plan.args] };
      },
    });
    const termination = await harness.spawner.start(harness.request());
    expect(termination.disposition).toBe('completed');
    expect(seen).toHaveLength(1);
    // The seam receives everything a wrapper needs: the CLI argv, the cwd and the resolved Node.
    expect(seen[0]?.cliArgs).toContain('--restricted');
    expect(seen[0]?.cwd).toBe(harness.worktree);
    expect(seen[0]?.node.path).toBe(process.execPath);
    expect(harness.eventsOfType(SPAWNER_EVENT_TYPES.AgentSpawned)[0]?.payload['wrapped']).toBe(true);
  });
});

describe('AD-1\'s second catch, on the stream', () => {
  it('fails the attempt when the CLI names a key source that is not the subscription login', async () => {
    // Derived from the real transcript by editing only the init line's apiKeySource. Without this the
    // whole `api_key_source` branch could be deleted and every fixture would still pass, because all
    // of them carry "none".
    const harness = openTracked({ fixture: 'api-key-mode.jsonl' });
    const termination = await harness.spawner.start(harness.request());

    expect(termination.disposition).toBe('failed');
    expect(termination.output).toBeNull();
    expect(termination.error?.code).toBe('model.api_key_mode_refused');
    expect(termination.error?.retryable).toBe(false);
    expect(harness.eventsOfType(SPAWNER_EVENT_TYPES.AgentExited)[0]?.payload['api_key_source']).toBe(
      'ANTHROPIC_API_KEY',
    );
  });

  it('does not brick a spawn whose init line simply lacks the field', async () => {
    // Absence is not denial. Treating it as API-key mode would fail every attempt with an
    // escalate-to-human code no retry clears, on nothing more than a field this build did not find.
    const harness = openTracked({ fixture: 'api-key-source-unreported.jsonl' });
    const termination = await harness.spawner.start(harness.request());

    expect(termination.disposition).toBe('completed');
    expect(harness.eventsOfType(SPAWNER_EVENT_TYPES.AgentExited)[0]?.payload['api_key_source']).toBe(
      'unreported',
    );
  });

  it('records that no init line arrived, rather than silently skipping the check', async () => {
    const harness = openTracked({ fakeEnv: { FAKE_CLAUDE_EXIT: '0' } });
    await harness.spawner.start(harness.request());
    expect(harness.eventsOfType(SPAWNER_EVENT_TYPES.AgentExited)[0]?.payload['api_key_source']).toBe(
      'no-init-line',
    );
  });
});

describe('the direct interpreter, which is the branch a real install takes', () => {
  it('executes a compiled entry with the full AD-1 argv', async () => {
    const harness = openTracked({ fixture: 'completed.jsonl', direct: true });
    const termination = await harness.spawner.start(harness.request());
    expect(termination.disposition).toBe('completed');

    const plan = harness.spawner.lastPlan();
    expect(plan?.cli.interpreter).toBe('direct');
    // The command is the CLI itself, with no Node prefixed — there is no interpreter to substitute.
    expect(plan?.command).toBe(plan?.cli.path);
    expect(plan?.args[0]).toBe('--print');

    // The same argv assertions as the node branch, read back from the child itself.
    const argv = harness.argvSeenByChild();
    for (const flag of AD1_REQUIRED_FLAGS) expect(argv).toContain(flag);
    expect(argv[argv.indexOf('--output-format') + 1]).toBe(STREAM_OUTPUT_FORMAT);
    // ADR-001's two, read back from the child rather than from the plan: `--add-dir` is the run worktree
    // and `--tools` is the grant, both as the process actually received them.
    expect(argv[argv.indexOf('--add-dir') + 1]).toBe(harness.worktree);
    expect(argv[argv.indexOf('--tools') + 1]).toBe('Read,Write,Edit,Grep,Glob,Bash');
    expect(JSON.parse(argv[argv.indexOf('--json-schema') + 1] ?? '')).toStrictEqual(
      exportContract('step.output'),
    );
    // AD-28 still holds for a compiled CLI: the resolved Node reaches it through the environment.
    expect(plan?.env['ORCH_NODE']).toBe(process.execPath);
  });
});

describe('MCP servers the engine was given', () => {
  it('reaches the spawned child as --mcp-config, under --strict-mcp-config', async () => {
    const configs = [join(tmpdir(), 'orch-mcp-a.json'), join(tmpdir(), 'orch-mcp-b.json')];
    const harness = openTracked({ fixture: 'completed.jsonl', mcpConfigs: configs });
    await harness.spawner.start(harness.request());

    // Asserted on the child's own argv: a dropped forward would leave --strict-mcp-config suppressing
    // the repository's servers and the engine's own never loading, with nothing else to notice.
    const argv = harness.argvSeenByChild();
    expect(argv).toContain('--mcp-config');
    expect(argv.slice(argv.indexOf('--mcp-config') + 1, argv.indexOf('--mcp-config') + 3)).toStrictEqual(
      configs,
    );
    expect(argv).toContain('--strict-mcp-config');
    expect(harness.eventsOfType(SPAWNER_EVENT_TYPES.AgentSpawned)[0]?.payload['mcp_config_count']).toBe(2);
  });
});

/** A transcript whose structured output is edited to a given status, derived from the real result. */
const withStatus = (status: string, error: unknown): string => {
  const lines = readFileSync(join(FIXTURES, 'completed.jsonl'), 'utf8').trim().split('\n');
  const result = JSON.parse(lines.at(-1) ?? '{}') as Record<string, unknown>;
  result['structured_output'] = {
    ...(result['structured_output'] as Record<string, unknown>),
    status,
    error,
  };
  const path = join(mkdtempSync(join(tmpdir(), `orch-${status}-`)), 'derived.jsonl');
  writeFileSync(path, `${[...lines.slice(0, -1), JSON.stringify(result)].join('\n')}\n`, 'utf8');
  return path;
};

describe('an agent-reported status with no error of its own', () => {
  it('gives a blocked step the escalate-to-human code', async () => {
    // The two fallbacks have opposite dispositions, so a swap sends every blocked step to a model that
    // cannot answer the question. Only an `error: null` fixture makes the fallback evaluate at all.
    const harness = openTracked({ fixturePath: withStatus('blocked', null) });
    const termination = await harness.spawner.start(harness.request());
    expect(termination.disposition).toBe('blocked');
    expect(termination.error?.code).toBe('question.unanswerable');
    expect(termination.error?.retryable).toBe(false);
  });

  it('gives a failed step the escalate-model-tier code', async () => {
    const harness = openTracked({ fixturePath: withStatus('failed', null) });
    const termination = await harness.spawner.start(harness.request());
    expect(termination.disposition).toBe('failed');
    expect(termination.error?.code).toBe('step.verification_failed');
  });
});

/**
 * An agent whose `retryable` disagrees with the AD-35 table for the code it reported.
 *
 * This is a schema question answered at the spawner, because the spawner is where the cost lands. The
 * field is a *derived* boolean on a model-facing contract, and the rule deriving it emits nothing into
 * the exported JSON Schema — so the model is never told it and sometimes gets it wrong. While
 * `OrchErrorSchema` *refused* the disagreement, one wrong boolean failed the whole
 * `StepOutputSchema.parse` at AD-1's re-parse, which `reparse` answers with
 * `step.schema_invalid_output` — `escalate-model-tier`. The agent below reports `budget.exhausted`,
 * which is abandon-and-hand-off: its code was discarded, the loop promoted to a more expensive rung,
 * and it re-ran a step that had just said the budget was gone.
 *
 * So what is asserted is that the agent's *code* survives and only the derived flag is corrected.
 */
describe('an agent whose retryable flag contradicts the code it reported', () => {
  it('keeps the code and corrects the flag, rather than destroying the whole output', async () => {
    const harness = openTracked({
      fixturePath: withStatus('failed', {
        code: 'budget.exhausted',
        message: 'the step budget is gone',
        // The contradiction: `budget.exhausted` is abandon-and-hand-off, so the table says false.
        retryable: true,
        cause: null,
      }),
    });
    const termination = await harness.spawner.start(harness.request());

    expect(termination.disposition).toBe('failed');
    // The code the agent reported, not a schema complaint about the flag beside it.
    expect(termination.error?.code).toBe('budget.exhausted');
    expect(termination.error?.retryable).toBe(false);
    // And specifically *not* the promotion trigger, which is what the refusal turned this into.
    expect(termination.error?.code).not.toBe('step.schema_invalid_output');
  });

  it('corrects a flag that claims a retryable code is not retryable, in the other direction too', async () => {
    const harness = openTracked({
      fixturePath: withStatus('failed', {
        code: 'model.rate_limited',
        message: 'the model said to come back later',
        retryable: false,
        cause: null,
      }),
    });
    const termination = await harness.spawner.start(harness.request());

    expect(termination.error?.code).toBe('model.rate_limited');
    expect(termination.error?.retryable).toBe(true);
  });
});

describe('an output that is not about this attempt', () => {
  it('is rejected even though it satisfies the contract', async () => {
    const lines = readFileSync(join(FIXTURES, 'completed.jsonl'), 'utf8').trim().split('\n');
    const result = JSON.parse(lines.at(-1) ?? '{}') as Record<string, unknown>;
    result['structured_output'] = {
      ...(result['structured_output'] as Record<string, unknown>),
      step: 'some-other-step',
    };
    const path = join(mkdtempSync(join(tmpdir(), 'orch-wrong-step-')), 'derived.jsonl');
    writeFileSync(path, `${[...lines.slice(0, -1), JSON.stringify(result)].join('\n')}\n`, 'utf8');

    const harness = openTracked({ fixturePath: path });
    const termination = await harness.spawner.start(harness.request());
    // Schema-valid, and still not this step's result: accepting it would mark a step complete that
    // never ran.
    expect(termination.disposition).toBe('failed');
    expect(termination.output).toBeNull();
    expect(termination.error?.code).toBe('step.schema_invalid_output');
    expect(termination.error?.cause).toContain('some-other-step');
  });

  it('reports a wiring fault as config.invalid, not as a reason to promote the model', async () => {
    // An unknown contract id is a registry fault. `escalate-model-tier` would spend the run's one
    // promotion per step on something no model rung can fix.
    const harness = openTracked({ fixture: 'completed.jsonl' });
    const termination = await harness.spawner.start(
      harness.request({ contractId: 'step.output' }),
    );
    expect(termination.disposition).toBe('completed');

    const unknown = openTracked({
      fixture: 'completed.jsonl',
      // The schema has to come from somewhere, since an unknown id has no registry export.
    });
    const spawner = createStepSpawner({
      recorderFor: () => unknown.recorder,
      cli: fakeCli,
      node: childNode,
      env: unknown.env,
      schemaFor: () => exportContract('step.output'),
      // The grant has no default anywhere in the spawner, so a second spawner built here supplies one
      // too; without it this case would fail for the wrong reason — a missing AD-9 snapshot rather than
      // an unregistered contract id.
      grantFor: () => fixtureGrant(),
    });
    const failed = await spawner.start(unknown.request({ contractId: 'step.not_registered' }));
    expect(failed.disposition).toBe('failed');
    expect(failed.error?.code).toBe('config.invalid');
    expect(failed.error?.retryable).toBe(false);
  });
});

describe('a child that does not stop on its own', () => {
  it('is bounded by a wall clock, and the hang is interrupted rather than killed', async () => {
    // Without a bound `start()` never settles, so the run holds its AD-29 writer claim and its AD-30
    // engine lock forever: one wedged step makes the whole ORCH_HOME unreconcilable.
    const harness = openTracked({
      fixture: 'no-terminal-output.jsonl',
      fakeEnv: { FAKE_CLAUDE_HANG: '1' },
      attemptTimeoutMs: 200,
      killGraceMs: 100,
    });
    const termination = await harness.spawner.start(harness.request());

    // `interrupted`, not `killed`: nobody decided to stop this step, it stopped making progress — and
    // `killed` is the one disposition AD-8 never resumes or re-runs.
    expect(termination.disposition).toBe('interrupted');
    expect(termination.sessionId).toBe(REAL_SESSION_ID);
    expect(harness.eventsOfType(SPAWNER_EVENT_TYPES.AgentExited)[0]?.payload['timed_out']).toBe(true);
  });

  it('is killed outright when it ignores the first signal, so killAll cannot hang', async () => {
    const harness = openTracked({
      fixture: 'no-terminal-output.jsonl',
      // A child that traps SIGTERM and keeps going. One SIGTERM alone would never end this attempt.
      fakeEnv: { FAKE_CLAUDE_HANG: '1', FAKE_CLAUDE_IGNORE_SIGTERM: '1' },
      killGraceMs: 100,
    });
    const running = harness.spawner.start(harness.request());
    while (harness.sessionIds.length === 0) await new Promise((resolve) => setImmediate(resolve));

    expect(harness.spawner.kill('implement')).toBe(true);
    const termination = await running;
    expect(termination.disposition).toBe('killed');
    // The escalation is what made it settle: SIGTERM was declined.
    expect(harness.eventsOfType(SPAWNER_EVENT_TYPES.AgentExited)[0]?.payload['signal']).toBe('SIGKILL');
  });
});

describe('two concurrent attempts at a same-named step', () => {
  it('are distinct children, and a kill is scoped by the run that owns them', async () => {
    // One spawner serves every run, so a step name alone is not an identity: keyed by step, the second
    // attempt evicts the first and a steering kill reaches the wrong child.
    const first = openTracked({
      fixture: 'no-terminal-output.jsonl',
      fakeEnv: { FAKE_CLAUDE_HANG: '1' },
      killGraceMs: 100,
    });
    const otherRun = '01JSPAWNER000000000000000B';

    const runningA = first.spawner.start(first.request());
    const runningB = first.spawner.start(
      first.request({ run: first.run, step: 'implement', attempt: 2 }),
    );
    while (first.sessionIds.length < 2) await new Promise((resolve) => setImmediate(resolve));

    // Both are live under distinct keys, so both are reachable and both are stopped.
    expect(first.spawner.kill('implement', first.run)).toBe(true);
    const [a, b] = await Promise.all([runningA, runningB]);
    expect(a.disposition).toBe('killed');
    expect(b.disposition).toBe('killed');
    // A kill naming a run that has nothing in flight stops nothing.
    expect(first.spawner.kill('implement', otherRun)).toBe(false);
    // Each attempt's plan is retrievable on its own identity, not overwritten by the other.
    expect(first.spawner.planOf(first.run, 'implement', 1)).not.toBeNull();
    expect(first.spawner.planOf(first.run, 'implement', 2)).not.toBeNull();
  });
});

describe('the AD-1 guard covers what is executed, not what was built', () => {
  it('refuses a wrapper that rebuilt the vector and dropped a required flag', async () => {
    // The silent widening the constant exists to prevent: `cliArgs` still carries every flag, so a
    // guard reading only the pre-wrap vector would pass this.
    const harness = openTracked({
      fixture: 'completed.jsonl',
      wrap: (plan) => ({ ...plan, args: plan.args.filter((arg) => arg !== '--restricted') }),
    });
    await expect(harness.spawner.start(harness.request())).rejects.toThrowError(
      /--restricted/,
    );
    // Refused before any process: the spawn event is never written.
    expect(harness.eventsOfType(SPAWNER_EVENT_TYPES.AgentSpawned)).toHaveLength(0);
  });

  it('logs the flags observed on the executed vector, not the constant', async () => {
    const harness = openTracked({ fixture: 'completed.jsonl' });
    await harness.spawner.start(harness.request());
    const spawned = harness.eventsOfType(SPAWNER_EVENT_TYPES.AgentSpawned)[0];
    expect(spawned?.payload['flags']).toStrictEqual([...AD1_REQUIRED_FLAGS]);
    expect(harness.spawner.lastPlan()?.args).toContain('--restricted');
  });
});

describe('a wrapper that reports its child\'s signal as an exit code', () => {
  it('maps 128+n to interrupted, so resume stays reachable at the AD-20 seam', async () => {
    // A container wrapper does not forward the inner signal; it exits 128+n. Read as a plain non-zero
    // code that is `failed`, and resume becomes dead code exactly where story 1-5 plugs in.
    expect(signalFromExitCode(128 + 9)).toBe('SIGKILL');
    expect(signalFromExitCode(128 + 15)).toBe('SIGTERM');
    expect(signalFromExitCode(1)).toBeNull();
    expect(signalFromExitCode(0)).toBeNull();
    expect(signalFromExitCode(null)).toBeNull();

    const harness = openTracked({
      fixture: 'no-terminal-output.jsonl',
      fakeEnv: { FAKE_CLAUDE_EXIT: String(128 + 9) },
    });
    const termination = await harness.spawner.start(harness.request());
    expect(termination.disposition).toBe('interrupted');
    expect(termination.sessionId).toBe(REAL_SESSION_ID);
  });
});

/**
 * Matrix 24, 33 and 34 — the parts of the grant path that the injected `grantFor` hides.
 *
 * Every other case in this suite passes `grantFor`, so the *default* resolution — read the run's AD-9
 * snapshot, look the phase up in it, refuse when nothing declares it — was never executed here at all:
 * changing `phase: request.phase` to `request.step` inside it, or dropping the `orchHome` it is given,
 * compiled and failed nothing. These build a spawner without one, against a real snapshot on disk.
 */
describe('the grant the spawner resolves for itself', () => {
  const rosterRepository = (
    agents: readonly { readonly id: string; readonly tools: readonly string[] }[],
  ): string => {
    const repository = mkdtempSync(join(tmpdir(), 'orch-spawner-repo-'));
    writeProfile(repository, fixtureProfile());
    for (const agent of agents) {
      writeAgentFile(
        repository,
        `${agent.id}.toml`,
        fixtureAgent({ id: agent.id, tools: [...agent.tools] as never }),
      );
    }
    return repository;
  };

  it('resolves it from the run snapshot, keyed by the request’s phase (matrix 24)', async () => {
    const harness = openTracked({ fixture: 'completed.jsonl' });
    // Deliberately not ADR-003's row for either phase, and different between the two, so the argv can
    // only match if the lookup used this phase and this snapshot.
    const repository = rosterRepository([
      { id: 'analysis', tools: ['Glob', 'Read'] },
      { id: 'implementation', tools: ['Read', 'Edit'] },
    ]);
    takeConfigSnapshot({ repository, runId: harness.run, orchHome: harness.home });

    const spawner = createStepSpawner({
      recorderFor: () => harness.recorder,
      cli: fakeCli,
      node: childNode,
      env: harness.env,
      // No `grantFor`. This is the case the default exists for.
      orchHome: harness.home,
    });
    // The step name stays the fixture's, because the recorded transcript's output names it and AD-1's
    // re-parse refuses an output about another step. The *phase* is what the grant is resolved by, which
    // is the whole point of the case.
    const termination = await spawner.start(harness.request({ phase: 'analysis' }));

    expect(termination.disposition).toBe('completed');
    const argv = harness.argvSeenByChild();
    expect(argv[argv.indexOf('--tools') + 1]).toBe('Glob,Read');
    expect(argv[argv.indexOf('--add-dir') + 1]).toBe(harness.worktree);
    expect(spawner.lastPlan()?.grant.agentId).toBe('analysis');
    expect(spawner.lastPlan()?.grant.declaredAt).toContain(harness.run);
  });

  it('refuses a phase the snapshot does not declare, keeping config.invalid (matrix 34)', async () => {
    const harness = openTracked({ fixture: 'completed.jsonl' });
    const repository = rosterRepository([{ id: 'analysis', tools: ['Read'] }]);
    takeConfigSnapshot({ repository, runId: harness.run, orchHome: harness.home });

    const spawner = createStepSpawner({
      recorderFor: () => harness.recorder,
      cli: fakeCli,
      node: childNode,
      env: harness.env,
      orchHome: harness.home,
    });

    await expect(
      spawner.start(harness.request({ phase: 'planning' })),
    ).rejects.toThrowError(AgentGrantUnresolved);
    // The refusal keeps its own AD-35 code rather than being relabelled `step.spawn_failed`, which is
    // `retry-with-backoff`: a loop retrying a roster would re-spawn an unbuildable step for ever.
    await expect(
      spawner.start(harness.request({ phase: 'planning' })),
    ).rejects.toMatchObject({ code: 'config.invalid' });
    expect(dispositionFor('config.invalid')).toBe('escalate-to-human');
  });

  it('refuses a run with no snapshot at all, and does not relabel that either', async () => {
    const harness = openTracked({ fixture: 'completed.jsonl' });
    const spawner = createStepSpawner({
      recorderFor: () => harness.recorder,
      cli: fakeCli,
      node: childNode,
      env: harness.env,
      orchHome: harness.home,
    });
    // AD-9: a step reads the snapshot and is not permitted to fall back to `.orch/`.
    await expect(spawner.start(harness.request())).rejects.toMatchObject({ code: 'config.invalid' });
  });

  it('records the grant verbatim on agent.spawned, elevated apart from granted (matrix 33)', async () => {
    const grant = fixtureGrant();
    const harness = openTracked({ fixture: 'completed.jsonl', grant });
    await harness.spawner.start(harness.request());

    const spawned = harness.eventsOfType(SPAWNER_EVENT_TYPES.AgentSpawned)[0];
    const payload = spawned?.payload ?? {};
    expect(payload[SPAWN_GRANT_PAYLOAD_KEYS.GrantedTools]).toStrictEqual([
      'Read',
      'Write',
      'Edit',
      'Grep',
      'Glob',
      'Bash',
    ]);
    // The elevated subset, not a copy of the grant: the two differ, so recording one for the other is
    // visible here rather than passing because a fixture made them equal.
    expect(payload[SPAWN_GRANT_PAYLOAD_KEYS.ElevatedTools]).toStrictEqual(['Write', 'Edit', 'Bash']);
    expect(payload[SPAWN_GRANT_PAYLOAD_KEYS.ElevatedTools]).not.toStrictEqual(
      payload[SPAWN_GRANT_PAYLOAD_KEYS.GrantedTools],
    );
    // A user-defined agent: after ADR-004 no built-in is granted `Bash`, and this case is about the
    // grant being recorded verbatim rather than corrected, which is exactly what AD-17 leaves possible.
    expect(payload[SPAWN_GRANT_PAYLOAD_KEYS.AgentId]).toBe('my-own-implementer');
    expect(payload[SPAWN_GRANT_PAYLOAD_KEYS.GrantDeclaredAt]).toBe('my-own-implementer.toml');
    expect(grant.declaredAt.endsWith('my-own-implementer.toml')).toBe(true);
  });

  /**
   * What AD-21 does to `grant_declared_at`, pinned rather than discovered.
   *
   * A snapshot path contains the run's 26-character ULID, which the entropy sweep replaces at its
   * 24-character threshold. The decision is to record the path anyway: the run id is on the *envelope*
   * verbatim under AD-5's passthrough allow-list, so the pair still locates the file, and a second,
   * shorter spelling of a path this system already has one of would be the worse trade.
   */
  it('keeps the declaration’s file name after AD-21 rewrites the run id inside the path', async () => {
    const harness = openTracked({ fixture: 'completed.jsonl' });
    const repository = rosterRepository([{ id: 'implementation', tools: ['Read'] }]);
    takeConfigSnapshot({ repository, runId: harness.run, orchHome: harness.home });
    const spawner = createStepSpawner({
      recorderFor: () => harness.recorder,
      cli: fakeCli,
      node: childNode,
      env: harness.env,
      orchHome: harness.home,
    });
    await spawner.start(harness.request());

    const spawned = harness.eventsOfType(SPAWNER_EVENT_TYPES.AgentSpawned)[0];
    const recordedFile = spawned?.payload[SPAWN_GRANT_PAYLOAD_KEYS.GrantDeclaredAt];
    const declaredFile = typeof recordedFile === 'string' ? recordedFile : '';
    // The name survives the pass intact — it is short and carries a dot.
    expect(declaredFile).toBe('implementation.toml');
    expect(declaredFile).not.toContain(REDACTION_MARKER);
    // The full path would not have: `orch/agents/implementation` is one unbroken high-entropy run, so
    // this is what the payload would have carried had the path been recorded instead.
    const wholePath = spawner.lastPlan()?.grant.declaredAt ?? '';
    expect(wholePath).toContain('implementation.toml');
    const passed = redactValue(wholePath);
    expect(passed.ok).toBe(true);
    expect(passed.ok ? passed.value : '').not.toContain('implementation.toml');
    // And the envelope still says which run, verbatim, which is why the pair still locates the file.
    expect(spawned?.run).toBe(harness.run);
  });
});

/**
 * ADR-004 — the served tool reaches the *executed* vector, or the spawn does not happen.
 *
 * This is the wiring `buildStepArgv`'s own suite cannot see: that suite is handed the grant's served
 * tools and the pre-approval as two arguments, and asserts what it does with them. What decides
 * whether a real spawn passes them at all is `planFor`, and nothing asserted it — a mutation making
 * it pass `[]` for both left every test in this repository green while the step that was granted the
 * command runner would have been unable to reach it. Asserted here against the argv the child
 * actually received, for the same reason story 1-4 asserts every other flag that way.
 */
describe('a spawn for a phase granted the runner carries it (ADR-004, matrix 8)', () => {
  const grantWithRunner = (): AgentGrant => ({
    ...fixtureGrant(),
    phase: 'verification',
    agentId: 'verification',
    tools: ['Read', 'Grep', 'Glob', 'RunDeclaredCommand'],
    elevated: ['RunDeclaredCommand'],
  });

  it('names the served tool in --allowedTools on the vector the child received', async () => {
    const harness = openTracked({
      fixture: 'completed.jsonl',
      grant: grantWithRunner(),
      mcpConfigs: ['/tmp/run/mcp.json'],
    });
    await harness.spawner.start(harness.request());

    const argv = harness.argvSeenByChild();
    expect(argv).toContain('--mcp-config');
    expect(argv).toContain('--strict-mcp-config');
    expect(argv[argv.indexOf('--allowedTools') + 1]).toBe(RUNNER_ALLOWED_TOOL);
    // And `--tools` still names built-ins only: the served name travels on the other flag, never
    // this one, where the CLI would silently drop it as a name outside the built-in set.
    expect(argv[argv.indexOf('--tools') + 1]).toBe('Read,Grep,Glob');

    // The grant is recorded as it was declared, with the pre-approval beside it, so an audit can see
    // both what was granted and whether the step could actually reach it.
    const spawnedEvent = harness.eventsOfType(SPAWNER_EVENT_TYPES.AgentSpawned)[0];
    expect(spawnedEvent?.payload?.[SPAWN_GRANT_PAYLOAD_KEYS.GrantedTools]).toContain(
      'RunDeclaredCommand',
    );
    expect(spawnedEvent?.payload?.['pre_approved_tools']).toStrictEqual([RUNNER_ALLOWED_TOOL]);
  });

  it('refuses the spawn when no server would be started, rather than granting a tool that cannot exist', async () => {
    // No `--mcp-config`, so nothing serves the tool the roster granted. The refusal is loud and
    // keeps `config.invalid`; a spawn that went ahead would leave the step asking for a tool that
    // does not exist, which under `--restricted` is a wait nobody can end.
    const harness = openTracked({ fixture: 'completed.jsonl', grant: grantWithRunner() });
    await expect(harness.spawner.start(harness.request())).rejects.toThrowError(
      McpToolNotPreApproved,
    );
  });
});
