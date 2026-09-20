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
import { readFileSync, readdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  CONTAINER_SUBCOMMANDS,
  IMAGE_CLI_PATH,
  IMAGE_NODE_PATH,
  LiveRunRemovalError,
  NETWORK_NONE,
  PhaseOrderError,
  TierTwoUnconfinableError,
  UnprotectedDefaultBranchError,
  containerNameFor,
  createContainerWrapper,
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
const WORKTREE = '/tmp/orch-home/worktrees/01ARZ3NDEKTSV4RRFFQ69G5FAV';
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
      orchHome: '/tmp/orch-home',
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
      orchHome: '/tmp/orch-home',
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
      orchHome: '/tmp/orch-home',
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
      orchHome: '/tmp/orch-home',
    });
    const args = wrapper(plan()).args;
    const mounts = mountsOf(args);
    expect(mounts).toHaveLength(2);
    expect(mounts[0]).toContain(WORKTREE);
    expect(mounts[1]).toContain(sessionDirFor(RUN, '/tmp/orch-home'));
    expect(sessionDirFor(RUN, '/tmp/orch-home')).toBe(
      join('/tmp/orch-home', 'runs', RUN, 'session'),
    );
  });

  it('passes the image\'s Node through ORCH_NODE and drops the host credential', () => {
    const wrapper = createContainerWrapper({
      tier: 2,
      runtime: RUNTIME,
      image: 'orch-executor:0123456789abcdef',
      invoke: presentImage(),
      orchHome: '/tmp/orch-home',
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
      orchHome: '/tmp/orch-home',
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
    const wrapper = createContainerWrapper({ tier: 2, runtime: RUNTIME, orchHome: '/tmp/orch-home' });
    expect(() => wrapper(plan())).toThrow(TierTwoUnconfinableError);
  });

  it('reports what it did for the event log, wrapped or not', () => {
    const records: { readonly tier: number; readonly wrapped: boolean }[] = [];
    const wrapper = createContainerWrapper({
      tier: (candidate) => (candidate.step === 'implement' ? 2 : 1),
      runtime: RUNTIME,
      image: 'orch-executor:0123456789abcdef',
      invoke: presentImage(),
      orchHome: '/tmp/orch-home',
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
    expect(removals).toHaveLength(4);
    expect(removals[0]?.subcommand).toStrictEqual([...CONTAINER_SUBCOMMANDS.remove]);
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
    sessionDir: sessionDirFor(RUN, '/tmp/orch-home'),
    command: IMAGE_CLI_PATH,
    commandArgs: ['--print', 'x'],
    home: '/Users/somebody',
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
    sequencer.provision(provisioningPlan(request, ['npm', 'ci']));
    expect(sequencer.state()).toBe('provisioned');
    sequencer.beginExecution(executionPlan(request));
    expect(sequencer.state()).toBe('executing');
    sequencer.endExecution();
    // And provisioning cannot come back afterwards, which would be a networked phase after execution.
    expect(() => sequencer.provision(provisioningPlan(request, ['npm', 'ci']))).toThrow(PhaseOrderError);
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
    // A sanity check on the one path this package does write: the AD-31 marker, which AD-9 puts under
    // ORCH_HOME. A temp ORCH_HOME proves the path is derived from it rather than from cwd.
    const home = mkdtempSync(join(tmpdir(), 'orch-home-'));
    expect(sessionDirFor(RUN, home).startsWith(home)).toBe(true);
  });
});
