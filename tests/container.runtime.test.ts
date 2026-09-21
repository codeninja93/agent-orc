/**
 * Locating the runtime binary — the one decision in `src/container/` that had no test at all.
 *
 * `wrapper.ts` calls `requireContainerRuntime(plan.env)` and puts whatever comes back at argv[0]: it is
 * literally the binary that confines a step. Everything about it was nevertheless untested, so a
 * resolution that silently returned the wrong candidate, or a refusal that named the wrong binary, was
 * invisible. Driven the way `tests/container.gate.test.ts` drives the gate — a synthetic `env` and a temp
 * directory with a stub in it — because the property is "what does this function do with an environment",
 * and using the machine's own `PATH` would assert whatever this machine happens to have installed.
 *
 * No daemon is involved. Reachability is `probeContainerRuntime`, which is driven here through an
 * injected invoker for the two facts that are decisions rather than observations: the version floor is
 * refused, and the client-only version spelling goes through a declared subcommand.
 */
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  CONTAINER_RUNTIME_ENV_VAR,
  CONTAINER_RUNTIME_MIN_VERSION,
  CONTAINER_SUBCOMMANDS,
  ContainerRuntimeBelowFloorError,
  ContainerRuntimeMissingError,
  DEFAULT_CONTAINER_RUNTIME,
  locateContainerRuntime,
  probeContainerRuntime,
  requireContainerRuntime,
  requireReachableContainerRuntime,
} from '../src/container/index.js';
import type { ContainerInvocation, ContainerResult } from '../src/container/index.js';

const temps: string[] = [];

/** A temp directory holding one stub binary, returned with its path. */
const stubDir = (name: string, options: { readonly executable?: boolean } = {}): {
  readonly dir: string;
  readonly path: string;
} => {
  const dir = mkdtempSync(join(tmpdir(), 'orch-runtime-'));
  temps.push(dir);
  const path = join(dir, name);
  writeFileSync(path, '#!/bin/sh\nexit 0\n', 'utf8');
  chmodSync(path, options.executable === false ? 0o644 : 0o755);
  return { dir, path };
};

afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('locating the binary that confines a step', () => {
  it('returns an absolute command for a name found on PATH', () => {
    // Absolute, because argv[0] is executed by the spawner and a relative name resolves against
    // whatever cwd the engine happens to be in — the target repository, for most of this system's life.
    const stub = stubDir(DEFAULT_CONTAINER_RUNTIME);
    const located = locateContainerRuntime({ PATH: stub.dir });
    expect(located).toStrictEqual({ command: stub.path, name: DEFAULT_CONTAINER_RUNTIME, source: 'path' });
  });

  it('takes the first PATH entry that holds an executable of that name, in order', () => {
    const first = stubDir(DEFAULT_CONTAINER_RUNTIME);
    const second = stubDir(DEFAULT_CONTAINER_RUNTIME);
    expect(locateContainerRuntime({ PATH: [first.dir, second.dir].join(delimiter) })?.command).toBe(
      first.path,
    );
    expect(locateContainerRuntime({ PATH: [second.dir, first.dir].join(delimiter) })?.command).toBe(
      second.path,
    );
  });

  it('honours the machine-scope override, and records that the name came from it', () => {
    // AD-34 puts the endpoint in machine configuration, and `source` is what lets a refusal say where
    // the name it could not find was configured.
    const stub = stubDir('some-other-runtime');
    const located = locateContainerRuntime({
      [CONTAINER_RUNTIME_ENV_VAR]: 'some-other-runtime',
      PATH: stub.dir,
    });
    expect(located).toStrictEqual({ command: stub.path, name: 'some-other-runtime', source: 'env' });
  });

  it('takes an absolute override as the command itself, without consulting PATH', () => {
    const stub = stubDir('runtime-at-an-absolute-path');
    const located = locateContainerRuntime({
      [CONTAINER_RUNTIME_ENV_VAR]: stub.path,
      PATH: '',
    });
    expect(located).toStrictEqual({ command: stub.path, name: stub.path, source: 'env' });
    // An absolute override that is not there is `null` rather than a fallback to the default name: a
    // configured binary that does not exist is a machine to fix, not a name to guess.
    expect(
      locateContainerRuntime({ [CONTAINER_RUNTIME_ENV_VAR]: join(stub.dir, 'absent'), PATH: stub.dir }),
    ).toBeNull();
  });

  it('treats a blank override as unset, so an empty variable is not a binary named ""', () => {
    const stub = stubDir(DEFAULT_CONTAINER_RUNTIME);
    for (const declared of ['', '   ']) {
      const located = locateContainerRuntime({ [CONTAINER_RUNTIME_ENV_VAR]: declared, PATH: stub.dir });
      expect(located?.name, JSON.stringify(declared)).toBe(DEFAULT_CONTAINER_RUNTIME);
      expect(located?.source, JSON.stringify(declared)).toBe('path');
    }
  });

  it('does not accept a candidate that is not executable, or is a directory', () => {
    // The file existing is not the question. A non-executable file at that path is a spawn that fails
    // with EACCES at the moment a step was supposed to start being confined.
    const stub = stubDir(DEFAULT_CONTAINER_RUNTIME, { executable: false });
    expect(locateContainerRuntime({ PATH: stub.dir })).toBeNull();

    const asDirectory = mkdtempSync(join(tmpdir(), 'orch-runtime-'));
    temps.push(asDirectory);
    mkdirSync(join(asDirectory, DEFAULT_CONTAINER_RUNTIME));
    expect(locateContainerRuntime({ PATH: asDirectory })).toBeNull();
  });

  it('finds nothing when PATH is empty or absent, rather than searching the machine', () => {
    expect(locateContainerRuntime({ PATH: '' })).toBeNull();
    expect(locateContainerRuntime({})).toBeNull();
  });
});

describe('the refusal when there is no binary to confine with', () => {
  it('names the configured binary, which is the only actionable part of the message', () => {
    let thrown: unknown;
    try {
      requireContainerRuntime({ [CONTAINER_RUNTIME_ENV_VAR]: 'not-installed-here', PATH: '' });
    } catch (error: unknown) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ContainerRuntimeMissingError);
    expect((thrown as ContainerRuntimeMissingError).runtimeName).toBe('not-installed-here');
    expect((thrown as Error).message).toContain('not-installed-here');
    // AD-20: a missing runtime is a run that must not start, not a degraded one.
    expect((thrown as ContainerRuntimeMissingError).code).toBe('container.start_failed');
  });

  it('names the default when nothing was configured', () => {
    expect(() => requireContainerRuntime({ PATH: '' })).toThrow(
      new RegExp(`"${DEFAULT_CONTAINER_RUNTIME}"`),
    );
  });

  it('returns the located runtime when there is one', () => {
    const stub = stubDir(DEFAULT_CONTAINER_RUNTIME);
    expect(requireContainerRuntime({ PATH: stub.dir }).command).toBe(stub.path);
  });
});

describe('the version floor, which the probe reports and the requirement enforces', () => {
  /** A daemon that answers every question with one version. */
  const answering = (version: string) => (invocation: ContainerInvocation): ContainerResult => ({
    status: 0,
    stdout: `${version}\n`,
    stderr: '',
    argv: ['<runtime>', ...invocation.subcommand, ...invocation.args],
  });

  it('refuses a daemon below the Stack table\'s floor rather than reporting it and continuing', () => {
    // `meetsVersionFloor` was computed and consumed by nothing, against the field's own promise that the
    // floor is "never silently ignored". A daemon too old to know a flag accepts the argv and does not
    // honour it, which is containment that is not there.
    let thrown: unknown;
    try {
      requireReachableContainerRuntime({ env: { PATH: '' }, invoke: answering('24.0.7') });
    } catch (error: unknown) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ContainerRuntimeBelowFloorError);
    expect((thrown as Error).message).toContain(CONTAINER_RUNTIME_MIN_VERSION);
    expect((thrown as ContainerRuntimeBelowFloorError).version).toBe('24.0.7');
  });

  it('accepts a daemon at or above it', () => {
    for (const version of [CONTAINER_RUNTIME_MIN_VERSION, '29.8.0', '30.0.1']) {
      const probe = requireReachableContainerRuntime({ env: { PATH: '' }, invoke: answering(version) });
      expect(probe.meetsVersionFloor, version).toBe(true);
      expect(probe.reachable, version).toBe(true);
    }
  });

  it('asks for the client-only version through a declared subcommand', () => {
    // `ContainerInvocation` says its `subcommand` is one of `CONTAINER_SUBCOMMANDS`. The client-only
    // fallback passed an empty subcommand and `--version` as an argument, which is where a second
    // vocabulary starts.
    const seen: ContainerInvocation[] = [];
    probeContainerRuntime({
      env: { PATH: '' },
      invoke: (invocation: ContainerInvocation): ContainerResult => {
        seen.push(invocation);
        return { status: 1, stdout: '', stderr: 'nothing answered', argv: ['<runtime>'] };
      },
    });
    expect(seen.length).toBeGreaterThan(0);
    const declared = Object.values(CONTAINER_SUBCOMMANDS).map((subcommand) => subcommand.join(' '));
    for (const invocation of seen) {
      expect(declared, invocation.subcommand.join(' ')).toContain(invocation.subcommand.join(' '));
    }
    expect(seen.map((one) => one.subcommand.join(' '))).toContain(
      CONTAINER_SUBCOMMANDS.versionFlag.join(' '),
    );
  });
});
