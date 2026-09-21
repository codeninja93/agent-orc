/**
 * The seam, the lifecycle and the dependency direction.
 *
 * Three things are proven here that nothing else can prove:
 *
 * - the wrapper is usable as story 1-4's `SpawnWrapper` — asserted by *assigning* it to one, so the
 *   typechecker is the assertion and a shape change breaks the build rather than a comment;
 * - a tier-0 or tier-1 plan comes back as the same object, so "identical to the input" is true by
 *   reference rather than by a field-by-field comparison that could miss a field nobody listed;
 * - `src/container/` imports only `src/contracts/`, `src/runtime/` and `node:` builtins, and the
 *   runtime is named in exactly one file — which is the AD-20 invariant the whole package exists to
 *   make true.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, describe, expect, it } from 'vitest';

import {
  CONTAINER_SUBCOMMANDS,
  IMAGE_CLI_PATH,
  IMAGE_NODE_PATH,
  LiveRunRemovalError,
  NETWORK_NONE,
  PhaseOrderError,
  TierTwoUnconfinableError,
  UnprotectedDefaultBranchError,
  EXECUTOR_UID,
  containerNameFor,
  createContainerWrapper,
  ensureSessionDir,
  createPhaseSequencer,
  envEntriesOf,
  executionPlan,
  missingAd20Flags,
  mountsOf,
  provisioningPlan,
  removeContainer,
  removeContainerIfTerminal,
  sessionDirFor,
  assertDefaultBranchProtected,
} from '../src/container/index.js';
import type {
  BranchProtection,
  ContainerInvocation,
  ContainerResult,
  ContainerRunRequest,
  ContainerRuntime,
} from '../src/container/index.js';
import type { Recorder } from '../src/runtime/index.js';
import type { SpawnPlan, SpawnWrapper, StepSpawnerOptions } from '../src/engine/index.js';

const RUN = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
/**
 * A real temp `ORCH_HOME`, not a literal path.
 *
 * Two reasons it has to be real now. The mount allow-list refuses a worktree that is not under
 * `ORCH_HOME/worktrees/` (AD-9), so the fixture has to name one that is; and the wrapper *creates* the
 * session directory, because `--mount type=bind` does not create its source and a real daemon refuses
 * the invocation with "bind source path does not exist". A temp home keeps both facts true without the
 * suite writing into the machine's own state.
 */
const ORCH_HOME = mkdtempSync(join(tmpdir(), 'orch-wrapper-home-'));
const WORKTREE = join(ORCH_HOME, 'worktrees', RUN);
mkdirSync(WORKTREE, { recursive: true });

afterAll(() => {
  rmSync(ORCH_HOME, { recursive: true, force: true });
});
const RUNTIME: ContainerRuntime = { command: '/usr/local/bin/orch-runtime', name: 'runtime', source: 'path' };

/** A plan exactly as story 1-4 builds one: host Node, host CLI entry, and the CLI argv on its own. */
const plan = (overrides: Partial<SpawnPlan> = {}): SpawnPlan => ({
  command: '/usr/local/bin/node',
  args: ['/opt/claude/cli.js', '--print', 'do the thing', '--strict-mcp-config', '--restricted'],
  cwd: WORKTREE,
  env: { PATH: '/usr/bin', ORCH_NODE: '/usr/local/bin/node', GITHUB_TOKEN: 'ghp_notreal' },
  cliArgs: ['--print', 'do the thing', '--strict-mcp-config', '--restricted'],
  cli: { path: '/opt/claude/cli.js', version: '2.1.278', auth: 'subscription', interpreter: 'node' },
  node: { path: '/usr/local/bin/node', version: '24.21.0', source: 'path' },
  step: 'implement',
  run: RUN,
  ...overrides,
});

const presentImage = (): ((invocation: ContainerInvocation) => ContainerResult) => {
  return (invocation: ContainerInvocation): ContainerResult => ({
    status: 0,
    stdout: '[{}]',
    stderr: '',
    argv: ['<runtime>', ...invocation.subcommand, ...invocation.args],
  });
};

describe('the SpawnWrapper story 1-4 left unfilled', () => {
  it('is assignable to the seam\'s own type, without this package importing it', () => {
    // The assignment is the assertion: `createContainerWrapper` returns a generic identity-preserving
    // function, which satisfies `(plan: SpawnPlan) => SpawnPlan` structurally. If the shape drifts,
    // `npm run typecheck` fails here — which is the only place that drift is catchable at all, since
    // `src/container/` may not import `src/engine/`.
    const wrapper: SpawnWrapper = createContainerWrapper({ tier: 1 });
    expect(typeof wrapper).toBe('function');
  });

  it('is what the spawner takes as its `wrap` option, with nothing adapting between them', () => {
    // The seam is "supplied", not reshaped: the wrapper goes in as `wrap` exactly as it comes out of
    // this package. An adapter here would be a second place the invocation is defined.
    const options: StepSpawnerOptions = {
      recorderFor: (): Recorder => ({}) as Recorder,
      wrap: createContainerWrapper({ tier: 2, invoke: presentImage(), runtime: RUNTIME }),
    };
    expect(typeof options.wrap).toBe('function');
  });

  it('returns a tier-0 and a tier-1 plan unchanged, with no container involved', () => {
    for (const tier of [0, 1] as const) {
      const invocations: ContainerInvocation[] = [];
      const wrapper = createContainerWrapper({
        tier,
        invoke: (invocation: ContainerInvocation): ContainerResult => {
          invocations.push(invocation);
          return presentImage()(invocation);
        },
      });
      const input = plan();
      const output = wrapper(input);
      // The same object, not a copy: nothing can be lost to a partial spread.
      expect(output).toBe(input);
      expect(invocations).toStrictEqual([]);
    }
  });

  it('wraps a tier-2 plan into a container invocation and keeps everything else', () => {
    const wrapper = createContainerWrapper({
      tier: 2,
      runtime: RUNTIME,
      invoke: presentImage(),
      image: 'orch-executor:0123456789abcdef',
      orchHome: ORCH_HOME,
    });
    const input = plan();
    const output = wrapper(input);

    expect(output.command).toBe(RUNTIME.command);
    expect(output.args[0]).toBe(CONTAINER_SUBCOMMANDS.run[0]);
    expect(missingAd20Flags(output.args)).toStrictEqual([]);

    // Everything the engine put on the plan rides through untouched.
    expect(output.cwd).toBe(input.cwd);
    expect(output.env).toStrictEqual(input.env);
    expect(output.cli).toBe(input.cli);
    expect(output.node).toBe(input.node);
    expect(output.step).toBe(input.step);
    expect(output.run).toBe(input.run);
  });

  it('runs the image\'s own CLI with story 1-4\'s argv, dropping the host interpreter', () => {
    const wrapper = createContainerWrapper({
      tier: 2,
      runtime: RUNTIME,
      image: 'orch-executor:0123456789abcdef',
      invoke: presentImage(),
      orchHome: ORCH_HOME,
    });
    const output = wrapper(plan());
    const image = output.args.indexOf('orch-executor:0123456789abcdef');

    expect(output.args[image + 1]).toBe(IMAGE_CLI_PATH);
    // The AD-1 argv, byte for byte. Story 1-4 validates its flag set against the *executed* vector,
    // so dropping --restricted or --strict-mcp-config here would fail its suite, not just this one.
    expect(output.args.slice(image + 2)).toStrictEqual(plan().cliArgs);
    expect(output.cliArgs).toStrictEqual(plan().cliArgs);
    expect(output.args).toContain('--restricted');
    expect(output.args).toContain('--strict-mcp-config');
    // The host's Node and the host's CLI entry do not exist in the image, so neither is the command.
    expect(output.args).not.toContain('/opt/claude/cli.js');
    expect(output.args.slice(0, image)).not.toContain('/usr/local/bin/node');
  });

  it('does not rewrite the exit code, because it cannot: the invocation is in the foreground', () => {
    const wrapper = createContainerWrapper({
      tier: 2,
      runtime: RUNTIME,
      image: 'orch-executor:0123456789abcdef',
      invoke: presentImage(),
      orchHome: ORCH_HOME,
    });
    const args = wrapper(plan()).args;
    // A detached invocation would exit 0 the instant the container started, so every step would be
    // recorded as completed and `interrupted` — AD-8's only resumable disposition — would never occur.
    expect(args).not.toContain('--detach');
    expect(args).not.toContain('-d');
    expect(args).toContain('--init');
  });

  it('mounts only the worktree and the run\'s session directory', () => {
    const wrapper = createContainerWrapper({
      tier: 2,
      runtime: RUNTIME,
      image: 'orch-executor:0123456789abcdef',
      invoke: presentImage(),
      orchHome: ORCH_HOME,
    });
    const args = wrapper(plan()).args;
    const mounts = mountsOf(args);
    expect(mounts).toHaveLength(2);
    expect(mounts[0]).toContain(WORKTREE);
    expect(mounts[1]).toContain(sessionDirFor(RUN, ORCH_HOME));
    expect(sessionDirFor(RUN, ORCH_HOME)).toBe(join(ORCH_HOME, 'runs', RUN, 'session'));
    // And it exists on disk by now, writable by the uid the container runs as: a bind mount does not
    // create its source, so a missing session directory is a container that never starts.
    const sessionDir = sessionDirFor(RUN, ORCH_HOME);
    expect(existsSync(sessionDir)).toBe(true);
    const mode = statSync(sessionDir).mode & 0o777;
    expect(statSync(sessionDir).uid === EXECUTOR_UID || (mode & 0o007) === 0o007).toBe(true);
  });

  it('passes the image\'s Node through ORCH_NODE and drops the host credential', () => {
    const wrapper = createContainerWrapper({
      tier: 2,
      runtime: RUNTIME,
      image: 'orch-executor:0123456789abcdef',
      invoke: presentImage(),
      orchHome: ORCH_HOME,
    });
    const entries = envEntriesOf(wrapper(plan()).args);
    expect(entries).toContain(`ORCH_NODE=${IMAGE_NODE_PATH}`);
    expect(entries.some((entry) => entry.startsWith('GITHUB_TOKEN='))).toBe(false);
    expect(entries.some((entry) => entry.includes('ghp_notreal'))).toBe(false);
  });

  it('resolves the image through the invoker when no tag was supplied', () => {
    const seen: ContainerInvocation[] = [];
    const wrapper = createContainerWrapper({
      tier: 2,
      runtime: RUNTIME,
      orchHome: ORCH_HOME,
      invoke: (invocation: ContainerInvocation): ContainerResult => {
        seen.push(invocation);
        return presentImage()(invocation);
      },
    });
    const args = wrapper(plan()).args;
    expect(seen[0]?.subcommand).toStrictEqual([...CONTAINER_SUBCOMMANDS.inspectImage]);
    expect(args.some((value) => value.startsWith('orch-executor:'))).toBe(true);
  });

  it('refuses to run a tier-2 step at all when it cannot be confined', () => {
    // No invoker and no tag: the image cannot be resolved, so the step does not run on the host
    // instead. Falling back is the failure containment exists to prevent.
    const wrapper = createContainerWrapper({ tier: 2, runtime: RUNTIME, orchHome: ORCH_HOME });
    expect(() => wrapper(plan())).toThrow(TierTwoUnconfinableError);
  });

  it('names a different container on a second wrap of the same plan', () => {
    // `--rm` is never composed (AD-20), so attempt 1's container still exists when a step is retried.
    // A fixed default attempt of 1 therefore named the retry's container the same thing, and the retry
    // died at container start with "name already in use" rather than running.
    const names: (string | null)[] = [];
    const wrapper = createContainerWrapper({
      tier: 2,
      runtime: RUNTIME,
      image: 'orch-executor:0123456789abcdef',
      invoke: presentImage(),
      orchHome: ORCH_HOME,
      onWrap: (record) => names.push(record.containerName),
    });
    wrapper(plan());
    wrapper(plan());
    expect(names).toStrictEqual([containerNameFor(RUN, 'implement', 1), containerNameFor(RUN, 'implement', 2)]);
    expect(new Set(names).size).toBe(2);
    // A caller that tracks attempts itself still wins.
    const fixed: (string | null)[] = [];
    const explicit = createContainerWrapper({
      tier: 2,
      runtime: RUNTIME,
      image: 'orch-executor:0123456789abcdef',
      invoke: presentImage(),
      orchHome: ORCH_HOME,
      attemptFor: () => 7,
      onWrap: (record) => fixed.push(record.containerName),
    });
    explicit(plan());
    expect(fixed).toStrictEqual([containerNameFor(RUN, 'implement', 7)]);
  });

  it('refuses a worktree that is not the run\'s, rather than mounting it writable', () => {
    // The default is the plan's cwd, so whatever the engine set became the one writable bind mount —
    // a target repository, or `/`. AD-9 says where a run worktree lives; anything else is a tier-2 step
    // that does not run, because falling back to the host is the failure containment prevents.
    for (const worktree of ['/', '/etc', '/Users/somebody', join(ORCH_HOME, 'worktrees')]) {
      const wrapper = createContainerWrapper({
        tier: 2,
        runtime: RUNTIME,
        image: 'orch-executor:0123456789abcdef',
        invoke: presentImage(),
        orchHome: ORCH_HOME,
        worktreeFor: () => worktree,
      });
      expect(() => wrapper(plan()), worktree).toThrow(TierTwoUnconfinableError);
    }
    // Including through the plan's own cwd, which is where the default comes from.
    const wrapper = createContainerWrapper({
      tier: 2,
      runtime: RUNTIME,
      image: 'orch-executor:0123456789abcdef',
      invoke: presentImage(),
      orchHome: ORCH_HOME,
    });
    expect(() => wrapper(plan({ cwd: '/Users/somebody/some-target-repo' }))).toThrow(
      TierTwoUnconfinableError,
    );
  });

  it('reports what it did for the event log, wrapped or not', () => {
    const records: { readonly tier: number; readonly wrapped: boolean }[] = [];
    const wrapper = createContainerWrapper({
      tier: (candidate) => (candidate.step === 'implement' ? 2 : 1),
      runtime: RUNTIME,
      image: 'orch-executor:0123456789abcdef',
      invoke: presentImage(),
      orchHome: ORCH_HOME,
      onWrap: (record) => records.push({ tier: record.tier, wrapped: record.wrapped }),
    });
    wrapper(plan());
    wrapper(plan({ step: 'review' }));
    expect(records).toStrictEqual([
      { tier: 2, wrapped: true },
      { tier: 1, wrapped: false },
    ]);
  });
});

describe('removal, which happens only at a terminal disposition', () => {
  const removals: ContainerInvocation[] = [];
  const invoke = (invocation: ContainerInvocation): ContainerResult => {
    removals.push(invocation);
    return { status: 0, stdout: '', stderr: '', argv: ['<runtime>', ...invocation.subcommand] };
  };

  it('keeps the container while the run is live, so the transcript survives for resume', () => {
    removals.length = 0;
    for (const state of ['running', 'blocked', 'degraded', 'interrupted', 'verifying'] as const) {
      const decision = removeContainerIfTerminal('orch-c', state, invoke);
      expect(decision.removed, state).toBe(false);
      expect(decision.reason).toContain('not terminal');
    }
    expect(removals).toStrictEqual([]);
  });

  it('removes it once the run reaches a terminal state', () => {
    removals.length = 0;
    for (const state of ['committed', 'hibernated', 'killed', 'handed_off'] as const) {
      expect(removeContainerIfTerminal('orch-c', state, invoke).removed, state).toBe(true);
    }
    // Two invocations per removal now: the stop that a running container needs, then the removal.
    // Asserted as a sequence rather than as a count, because the order is the whole fix.
    expect(removals).toHaveLength(8);
    expect(removals[0]?.subcommand).toStrictEqual([...CONTAINER_SUBCOMMANDS.stop]);
    expect(removals[1]?.subcommand).toStrictEqual([...CONTAINER_SUBCOMMANDS.remove]);
    expect(removals[0]?.args).toContain('orch-c');
  });

  it('reclaims a container that is still running, which a removal alone cannot', () => {
    // A run can reach a terminal state — `killed`, a hand-off — with its container still up, and a
    // removal refuses a running container. Without the stop the sweep reported `removed: false` on
    // every pass for ever, and the resource AD-32 exists to reclaim was never reclaimed.
    const seen: ContainerInvocation[] = [];
    let running = true;
    const runningContainer = (invocation: ContainerInvocation): ContainerResult => {
      seen.push(invocation);
      const argv = ['<runtime>', ...invocation.subcommand, ...invocation.args];
      if (invocation.subcommand.join(' ') === CONTAINER_SUBCOMMANDS.stop.join(' ')) {
        running = false;
        return { status: 0, stdout: 'orch-c', stderr: '', argv };
      }
      return running
        ? {
            status: 1,
            stdout: '',
            stderr:
              'Error response from daemon: cannot remove container "orch-c": container is running: ' +
              'stop the container before removing or force remove',
            argv,
          }
        : { status: 0, stdout: 'orch-c', stderr: '', argv };
    };
    const decision = removeContainerIfTerminal('orch-c', 'killed', runningContainer);
    expect(decision.removed).toBe(true);
    expect(seen.map((one) => one.subcommand.join(' '))).toStrictEqual([
      CONTAINER_SUBCOMMANDS.stop.join(' '),
      CONTAINER_SUBCOMMANDS.remove.join(' '),
    ]);
    // And still never with --force: a stop the runtime declines is a fact to record, where a forced
    // removal would discard the transcript the stop was waiting to flush (AD-8).
    for (const invocation of seen) {
      expect(invocation.args).not.toContain('--force');
      expect(invocation.args).not.toContain('-f');
    }
  });

  it('reports a removal that still failed, and what the stop before it said', () => {
    const decision = removeContainerIfTerminal('orch-c', 'committed', (invocation) => ({
      status: invocation.subcommand.join(' ') === CONTAINER_SUBCOMMANDS.stop.join(' ') ? 1 : 1,
      stdout: '',
      stderr: 'Error response from daemon: container is restarting',
      argv: ['<runtime>', ...invocation.subcommand],
    }));
    expect(decision.removed).toBe(false);
    expect(decision.reason).toContain('removal failed');
    expect(decision.reason).toContain('the stop before it reported 1');
  });

  it('treats an already-gone container as removed rather than as a failure', () => {
    const decision = removeContainerIfTerminal('orch-c', 'committed', (invocation) => ({
      status: 1,
      stdout: '',
      stderr: 'Error response from daemon: No such container: orch-c',
      argv: ['<runtime>', ...invocation.subcommand],
    }));
    expect(decision.removed).toBe(true);
  });

  it('is loud when a caller asserts a terminal state that is not one', () => {
    expect(() => removeContainer('orch-c', 'running', invoke)).toThrow(LiveRunRemovalError);
  });

  it('names a container per attempt, greppable by run', () => {
    expect(containerNameFor(RUN, 'implement', 2)).toBe(`orch-${RUN}-implement-2`);
    expect(containerNameFor(RUN, 'weird/step name', 1)).toBe(`orch-${RUN}-weird-step-name-1`);
  });
});

describe('provisioning, then execution', () => {
  const request: Omit<ContainerRunRequest, 'phase'> = {
    image: 'orch-executor:0123456789abcdef',
    run: RUN,
    step: 'implement',
    attempt: 1,
    containerName: 'orch-c',
    worktree: WORKTREE,
    sessionDir: sessionDirFor(RUN, ORCH_HOME),
    command: IMAGE_CLI_PATH,
    commandArgs: ['--print', 'x'],
    home: '/Users/somebody',
    // The ORCH_HOME the two mountable directories belong to: the allow-list is checked against it.
    orchHome: ORCH_HOME,
  };

  it('gives the install phase a network and the execution phase none', () => {
    const provisioning = provisioningPlan(request, ['npm', 'ci']);
    const execution = executionPlan(request);
    expect(provisioning.args[provisioning.args.indexOf('--network') + 1]).toBe('bridge');
    expect(execution.args[execution.args.indexOf('--network') + 1]).toBe(NETWORK_NONE);
    // The install command is the provisioning container's command, not the step's.
    const image = provisioning.args.indexOf(request.image);
    expect(provisioning.args.slice(image + 1)).toStrictEqual(['npm', 'ci']);
  });

  it('refuses to execute before provisioning has ended', () => {
    const sequencer = createPhaseSequencer();
    expect(() => sequencer.beginExecution(executionPlan(request))).toThrow(PhaseOrderError);
    // The outcome of the provisioning *container*, not only its argv: see the test below.
    sequencer.provision(provisioningPlan(request, ['npm', 'ci']), { status: 0 });
    expect(sequencer.state()).toBe('provisioned');
    sequencer.beginExecution(executionPlan(request));
    expect(sequencer.state()).toBe('executing');
    sequencer.endExecution();
    // And provisioning cannot come back afterwards, which would be a networked phase after execution.
    expect(() =>
      sequencer.provision(provisioningPlan(request, ['npm', 'ci']), { status: 0 }),
    ).toThrow(PhaseOrderError);
  });

  it('does not treat a composed provisioning argv as a provisioned worktree', () => {
    // Marking `provisioned` on composition authorised execution on the strength of an argv nobody had
    // run: a provisioning container that exited non-zero, or never started, still let the step run with
    // no network to install anything with. The declared `provisioning` state was unreachable, too.
    const sequencer = createPhaseSequencer();
    expect(() =>
      sequencer.provision(provisioningPlan(request, ['npm', 'ci']), {
        status: 1,
        stderr: 'npm error code E404',
      }),
    ).toThrow(PhaseOrderError);
    expect(sequencer.state()).toBe('provisioning');
    expect(() => sequencer.beginExecution(executionPlan(request))).toThrow(PhaseOrderError);
  });

  it('lets a caller state that nothing needs installing, which is not the same as forgetting', () => {
    const sequencer = createPhaseSequencer();
    sequencer.skipProvisioning();
    expect(() => sequencer.beginExecution(executionPlan(request))).not.toThrow();
  });

  it('refuses an execution plan that carries a network', () => {
    const sequencer = createPhaseSequencer();
    sequencer.skipProvisioning();
    const networked = { ...executionPlan(request), args: ['--network', 'bridge'] };
    expect(() => sequencer.beginExecution(networked)).toThrow(PhaseOrderError);
  });

  it('reads the token after --network rather than looking for the word anywhere in the argv', () => {
    // `args.includes('none')` is satisfied by any label, path or environment value containing the word
    // — so an argv on `bridge` passed as long as something, anywhere, said `none`.
    const sequencer = () => {
      const one = createPhaseSequencer();
      one.skipProvisioning();
      return one;
    };
    const disguised = {
      ...executionPlan(request),
      args: ['--label', 'orch.profile=none', '--network', 'bridge'],
    };
    expect(() => sequencer().beginExecution(disguised)).toThrow(/--network bridge/);
    // Two --network flags is the same defect from the other side: the last one wins and the first is
    // what a reader sees.
    const twice = {
      ...executionPlan(request),
      args: ['--network', NETWORK_NONE, '--network', 'bridge'],
    };
    expect(() => sequencer().beginExecution(twice)).toThrow(/2 --network flags/);
    // A --network with nothing after it is refused rather than read as absent.
    expect(() => sequencer().beginExecution({ ...executionPlan(request), args: ['--network'] })).toThrow(
      PhaseOrderError,
    );
  });
});

describe('branch protection at run start', () => {
  const protection = (overrides: Partial<BranchProtection> = {}): BranchProtection => ({
    branch: 'main',
    protected: true,
    forcePushDisabled: true,
    deletionDisabled: true,
    source: 'a test probe',
    ...overrides,
  });

  it('starts the run when the default branch is protected', () => {
    expect(
      assertDefaultBranchProtected({
        repository: '/repo',
        defaultBranch: 'main',
        probe: () => protection(),
      }).branch,
    ).toBe('main');
  });

  it('refuses naming the branch when it is unprotected', () => {
    for (const overrides of [
      { protected: false },
      { forcePushDisabled: false },
      { deletionDisabled: false },
    ]) {
      let thrown: unknown;
      try {
        assertDefaultBranchProtected({
          repository: '/repo',
          defaultBranch: 'trunk',
          probe: () => protection(overrides),
        });
      } catch (error: unknown) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(UnprotectedDefaultBranchError);
      expect((thrown as Error).message).toContain('trunk');
      expect((thrown as UnprotectedDefaultBranchError).code).toBe('write.branch_protection_violation');
    }
  });

  it('refuses when protection cannot be established at all', () => {
    // Fail closed. "We could not check" and "it is not protected" have the same consequence, and the
    // opposite default is how an unattended run ends up pushing to an unprotected main.
    expect(() => assertDefaultBranchProtected({ repository: '/repo', defaultBranch: 'main' })).toThrow(
      UnprotectedDefaultBranchError,
    );
  });

  it('holds no forge credential of its own: the probe is a port', () => {
    const source = readFileSync(new URL('../src/container/lifecycle.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/https?:\/\/api\./);
    expect(source).not.toContain('Authorization');
  });
});

describe('the dependency direction', () => {
  const containerDir = fileURLToPath(new URL('../src/container/', import.meta.url));
  const files = readdirSync(containerDir).filter((name) => name.endsWith('.ts'));

  it('has the files the Code Map names', () => {
    // A stale guard would silently stop checking a file that had been renamed away.
    expect(files.sort()).toStrictEqual([
      'flags.ts',
      'image.ts',
      'index.ts',
      'lifecycle.ts',
      'runtime.ts',
      // Story 1-6: the flag set for a leased service container, so a pool composes no flag of its own.
      'service.ts',
      'tiers.ts',
      'wrapper.ts',
    ]);
  });

  it('imports only from src/contracts/, src/runtime/ and node: builtins', () => {
    for (const file of files) {
      const source = readFileSync(join(containerDir, file), 'utf8');
      // Anchored to an import or re-export statement: an unanchored match also finds the word "from"
      // inside a quoted sentence, and a refusal message in this package legitimately contains one.
      const specifiers = [...source.matchAll(/^(?:import|export)\b[^;]*?from '([^']+)';/gms)].map(
        (match) => match[1] ?? '',
      );
      // A regex that matched nothing would make this test pass by finding no imports at all.
      expect(specifiers.length, `${file} has imports the guard can see`).toBeGreaterThan(0);
      for (const specifier of specifiers) {
        const legal =
          specifier.startsWith('node:') ||
          specifier.startsWith('./') ||
          specifier.startsWith('../contracts/') ||
          specifier.startsWith('../runtime/');
        expect(legal, `${file} imports ${specifier}`).toBe(true);
      }
      expect(source, file).not.toContain("../engine/");
    }
  });

  it('names the container runtime in exactly one file', () => {
    // AD-20's actual invariant. "Dockerfile" is the build definition's proper name and appears where
    // the image is hashed; what may not appear twice is the runtime itself — the binary to execute,
    // its socket, or a sibling implementation's name — because that is what lets a second unit compose
    // an invocation.
    const namesTheRuntime = /['"]docker['"]|docker\.sock|\bpodman\b|\bcontainerd\b/;
    for (const file of files) {
      const source = readFileSync(join(containerDir, file), 'utf8');
      if (file === 'runtime.ts') {
        expect(namesTheRuntime.test(source), file).toBe(true);
        continue;
      }
      expect(namesTheRuntime.test(source), file).toBe(false);
    }
  });

  it('keeps the runtime\'s name out of src/engine/, src/runtime/ and src/contracts/ entirely', () => {
    // The mirror of story 1-4's own guard, asserted from this side too: the seam is worthless if the
    // engine can name the runtime beside it.
    for (const dir of ['engine', 'runtime', 'contracts']) {
      const base = fileURLToPath(new URL(`../src/${dir}/`, import.meta.url));
      for (const name of readdirSync(base).filter((file) => file.endsWith('.ts'))) {
        const source = readFileSync(join(base, name), 'utf8').toLowerCase();
        for (const forbidden of ['docker', 'podman', 'containerd']) {
          expect(source.includes(forbidden), `src/${dir}/${name}`).toBe(false);
        }
      }
    }
  });

  it('writes nothing inside a target repository', () => {
    // The two paths this package writes are the session directory and the AD-31 marker, and AD-9 puts
    // both under ORCH_HOME. Asserted by writing: the directory tree of the working directory — which is
    // the *target repository* for most of this system's life — is compared before and after, because a
    // test that only derives a path proves nothing about where a write lands.
    const home = mkdtempSync(join(tmpdir(), 'orch-home-'));
    const before = readdirSync(process.cwd()).sort();
    const sessionDir = ensureSessionDir(sessionDirFor(RUN, home));
    expect(sessionDir.startsWith(home)).toBe(true);
    expect(existsSync(sessionDir)).toBe(true);
    expect(readdirSync(process.cwd()).sort()).toStrictEqual(before);
    rmSync(home, { recursive: true, force: true });
  });
});
