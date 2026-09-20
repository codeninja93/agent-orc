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
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { exportContract, StepInputSchema } from '../src/contracts/index.js';
import type { StepInput } from '../src/contracts/index.js';
import { Recorder, readEventLog, runPaths } from '../src/runtime/index.js';
import type { EventEnvelope } from '../src/contracts/index.js';
import {
  AD1_REQUIRED_FLAGS,
  ApiKeyModeRefusedError,
  ClaudeCliVersionError,
  createStepSpawner,
  buildStepArgv,
  errorCodeForResult,
  missingRequiredFlags,
  resolveClaudeCli,
  ResumeRefused,
  SPAWNER_EMITTER,
  SPAWNER_EVENT_TYPES,
  StepSpawnFailed,
  STREAM_OUTPUT_FORMAT,
} from '../src/engine/index.js';
import type {
  ChildNode,
  ClaudeCli,
  SpawnPlan,
  StepSpawner,
  StepStartRequest,
} from '../src/engine/index.js';

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
  readonly spawner: StepSpawner;
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
    ...options.fakeEnv,
  };
  // A developer's own API-key environment must not decide what this suite proves.
  delete env['ANTHROPIC_API_KEY'];
  delete env['ANTHROPIC_AUTH_TOKEN'];

  const spawner = createStepSpawner({
    recorderFor: () => recorder,
    cli: options.cli ?? fakeCli,
    node: childNode,
    env,
    ...(options.mcpConfigs === undefined ? {} : { mcpConfigs: options.mcpConfigs }),
    ...(options.wrap === undefined ? {} : { wrap: options.wrap }),
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
    spawner,
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

describe('the AD-1 argv', () => {
  it('carries every required flag, and the suite knows which they are', () => {
    expect([...AD1_REQUIRED_FLAGS]).toStrictEqual([
      '--json-schema',
      '--output-format',
      '--strict-mcp-config',
      '--restricted',
    ]);
    const argv = buildStepArgv({
      schema: exportContract('step.output'),
      prompt: 'do the thing',
      model: 'claude-haiku-4-5',
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
    });
    const schemaArg = argv[argv.indexOf('--json-schema') + 1] ?? '';
    expect(JSON.parse(schemaArg)).toStrictEqual(exportContract('step.output'));
    // AD-2: draft-7, because `--json-schema` rejects draft-2020-12.
    expect(JSON.parse(schemaArg)).toHaveProperty('$schema', 'http://json-schema.org/draft-07/schema#');
    expect(argv[argv.indexOf('--output-format') + 1]).toBe(STREAM_OUTPUT_FORMAT);
    expect(argv[argv.indexOf('--model') + 1]).toBe('claude-sonnet-5');
  });

  it('passes --strict-mcp-config with no servers, and --mcp-config only when there are some', () => {
    const none = buildStepArgv({ schema: {}, prompt: 'p', model: 'claude-haiku-4-5' });
    expect(none).toContain('--strict-mcp-config');
    expect(none).not.toContain('--mcp-config');

    const some = buildStepArgv({
      schema: {},
      prompt: 'p',
      model: 'claude-haiku-4-5',
      mcpConfigs: ['/a.json', '/b.json'],
    });
    expect(some).toContain('--mcp-config');
    expect(some.slice(some.indexOf('--mcp-config') + 1)).toStrictEqual(['/a.json', '/b.json']);
  });

  it('adds --resume only for a resume, and only the recorded id', () => {
    expect(
      buildStepArgv({ schema: {}, prompt: 'p', model: 'claude-haiku-4-5' }),
    ).not.toContain('--resume');
    const resumed = buildStepArgv({
      schema: {},
      prompt: 'p',
      model: 'claude-haiku-4-5',
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

  it('throws ResumeRefused carrying step.resume_failed when the session is gone', async () => {
    const harness = openTracked({
      fixture: 'completed.jsonl',
      fakeEnv: { FAKE_CLAUDE_REFUSE_RESUME: '1' },
    });
    let thrown: unknown;
    try {
      await harness.spawner.resume({ ...harness.request(), sessionId: REAL_SESSION_ID });
    } catch (error: unknown) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ResumeRefused);
    const refusal = thrown as ResumeRefused;
    expect(refusal.code).toBe('step.resume_failed');
    expect(refusal.sessionId).toBe(REAL_SESSION_ID);
    expect(refusal.message).toContain('baseline');
  });

  it('never attempts a second resume against the same id', async () => {
    const harness = openTracked({
      fixture: 'completed.jsonl',
      fakeEnv: { FAKE_CLAUDE_REFUSE_RESUME: '1' },
    });
    const resumeRequest = { ...harness.request(), sessionId: REAL_SESSION_ID };

    await expect(harness.spawner.resume(resumeRequest)).rejects.toThrowError(ResumeRefused);
    const spawnsAfterFirst = harness.eventsOfType(SPAWNER_EVENT_TYPES.AgentSpawned).length;

    await expect(harness.spawner.resume(resumeRequest)).rejects.toThrowError(ResumeRefused);
    // The second refusal created no process at all: the spent id is refused before the spawn.
    expect(harness.eventsOfType(SPAWNER_EVENT_TYPES.AgentSpawned)).toHaveLength(spawnsAfterFirst);
  });

  it('refuses a resume whose child never opened a session, without a message to match on', async () => {
    const harness = openTracked({
      fakeEnv: { FAKE_CLAUDE_EXIT: '1' },
    });
    await expect(
      harness.spawner.resume({ ...harness.request(), sessionId: 'sess-that-is-gone' }),
    ).rejects.toThrowError(ResumeRefused);
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
