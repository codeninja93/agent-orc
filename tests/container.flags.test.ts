/**
 * The AD-20 flag set, asserted on the composed argument vector.
 *
 * Every assertion here reads the vector `composeRunArgs` produced, never the table it was produced
 * from. Restating the flag list would prove the list exists; the vector is what the runtime would
 * actually receive, and it is the only thing whose absence of a flag is the absence of containment.
 */
import { describe, expect, it } from 'vitest';

import {
  AD20_REQUIRED_FLAGS,
  composeContainerEnv,
  CONTAINER_HOME,
  CredentialLeakError,
  DEFAULT_MEMORY_LIMIT,
  DEFAULT_PIDS_LIMIT,
  DEFAULT_SECCOMP_PROFILE,
  EXECUTOR_USER,
  envEntriesOf,
  FORBIDDEN_RUN_FLAGS,
  ForbiddenFlagError,
  MountDisciplineError,
  NETWORK_NONE,
  NETWORK_PROVISIONING,
  REFUSED_SECCOMP_PROFILE,
  RUNTIME_SOCKET_PATHS,
  assertMountsAllowed,
  composeMounts,
  composeRunArgs,
  isCredentialEnvName,
  missingAd20Flags,
  mountsOf,
} from '../src/container/index.js';
import type { ContainerRunRequest } from '../src/container/index.js';

const HOME = '/Users/somebody';
const WORKTREE = '/tmp/orch-home/worktrees/01ARZ3NDEKTSV4RRFFQ69G5FAV';
const SESSION = '/tmp/orch-home/runs/01ARZ3NDEKTSV4RRFFQ69G5FAV/session';

const request = (overrides: Partial<ContainerRunRequest> = {}): ContainerRunRequest => ({
  image: 'orch-executor:0123456789abcdef',
  run: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
  step: 'implement',
  attempt: 1,
  containerName: 'orch-01ARZ3NDEKTSV4RRFFQ69G5FAV-implement-1',
  worktree: WORKTREE,
  sessionDir: SESSION,
  command: '/usr/local/bin/claude',
  commandArgs: ['--print', 'do the thing', '--restricted'],
  home: HOME,
  ...overrides,
});

/** The value the flag at `name` was given, read back out of the vector. */
const valueOf = (argv: readonly string[], name: string): string | undefined =>
  argv[argv.indexOf(name) + 1];

const valuesOf = (argv: readonly string[], name: string): readonly string[] =>
  argv.flatMap((value, index) => (argv[index - 1] === name ? [value] : []));

describe('the composed tier-2 argv', () => {
  it('carries every flag AD-20 names', () => {
    const argv = composeRunArgs(request());
    expect(missingAd20Flags(argv)).toStrictEqual([]);
    // Named individually as well, so a future change to the required list cannot quietly shrink it.
    expect(argv).toContain('--read-only');
    expect(argv).toContain('--tmpfs');
    expect(argv).toContain('--user');
    expect(argv).toContain('--cap-drop');
    expect(argv).toContain('--memory');
    expect(argv).toContain('--pids-limit');
    expect(argv).toContain('--network');
    expect(argv).toContain('--security-opt');
  });

  it('gives each of those flags a value that is actually restrictive', () => {
    const argv = composeRunArgs(request());
    // A flag present with a permissive value is what a name-only check misses: `--cap-drop NET_RAW`
    // satisfies "carries --cap-drop" and drops nothing that matters.
    expect(valueOf(argv, '--cap-drop')).toBe('ALL');
    expect(valueOf(argv, '--user')).toBe(EXECUTOR_USER);
    expect(valueOf(argv, '--memory')).toBe(DEFAULT_MEMORY_LIMIT);
    expect(valueOf(argv, '--memory-swap')).toBe(DEFAULT_MEMORY_LIMIT);
    expect(valueOf(argv, '--pids-limit')).toBe(String(DEFAULT_PIDS_LIMIT));
    expect(valueOf(argv, '--network')).toBe(NETWORK_NONE);
    expect(valuesOf(argv, '--security-opt')).toStrictEqual([
      'no-new-privileges',
      `seccomp=${DEFAULT_SECCOMP_PROFILE}`,
    ]);
    const tmpfs = valuesOf(argv, '--tmpfs');
    expect(tmpfs.some((mount) => mount.startsWith('/tmp:'))).toBe(true);
    expect(tmpfs.every((mount) => /\bnoexec\b/.test(mount) && /\bsize=/.test(mount))).toBe(true);
  });

  it('refuses a seccomp value that is the absence of a profile', () => {
    expect(() => composeRunArgs(request({ seccompProfile: REFUSED_SECCOMP_PROFILE }))).toThrow(
      ForbiddenFlagError,
    );
  });

  it('carries no flag that would undo the containment or the exit code', () => {
    const argv = composeRunArgs(request());
    const beforeImage = argv.slice(0, argv.indexOf(request().image));
    for (const flag of FORBIDDEN_RUN_FLAGS) expect(beforeImage).not.toContain(flag);
    // Named explicitly: --rm is AD-20's own prohibition and --detach would report every step as an
    // instant success.
    expect(beforeImage).not.toContain('--rm');
    expect(beforeImage).not.toContain('--detach');
    expect(beforeImage).not.toContain('-d');
  });

  it('ends with the image and then the step command, so nothing is appended past the boundary', () => {
    const argv = composeRunArgs(request());
    const image = argv.indexOf(request().image);
    expect(image).toBeGreaterThan(0);
    expect(argv[image + 1]).toBe('/usr/local/bin/claude');
    expect(argv.slice(image + 2)).toStrictEqual(['--print', 'do the thing', '--restricted']);
  });

  it('refuses an image that is a registry reference', () => {
    expect(() => composeRunArgs(request({ image: 'ghcr.io/somebody/orch-executor:latest' }))).toThrow(
      ForbiddenFlagError,
    );
  });

  it('never pulls: the run is told the image must already be local', () => {
    expect(valueOf(composeRunArgs(request()), '--pull')).toBe('never');
  });
});

describe('mount discipline', () => {
  it('mounts the worktree and the session directory, and nothing else', () => {
    const mounts = mountsOf(composeRunArgs(request()));
    expect(mounts).toHaveLength(2);
    expect(mounts[0]).toBe(`type=bind,source=${WORKTREE},target=${WORKTREE}`);
    expect(mounts[1]).toBe(`type=bind,source=${SESSION},target=${SESSION}`);
  });

  it('names no HOME, ssh path, cloud credential path or runtime socket in any mount', () => {
    const argv = composeRunArgs(request());
    const mounts = mountsOf(argv).join(' ');
    for (const forbidden of [
      HOME,
      `${HOME}/.ssh`,
      `${HOME}/.aws`,
      `${HOME}/.config/gcloud`,
      `${HOME}/.claude`,
      ...RUNTIME_SOCKET_PATHS,
    ]) {
      expect(mounts).not.toContain(forbidden);
    }
    // And the whole vector, not only its mounts: a socket path arriving as any other argument would
    // be just as reachable.
    for (const socket of RUNTIME_SOCKET_PATHS) expect(argv.join(' ')).not.toContain(socket);
  });

  it('refuses a mount the allow-list does not cover, naming what it was', () => {
    const allow = { worktree: WORKTREE, sessionDir: SESSION };
    const cases: readonly [string, RegExp][] = [
      [HOME, /host HOME directory/],
      [`${HOME}/.ssh`, /credential or runtime path/],
      [`${HOME}/.aws/credentials`, /credential or runtime path/],
      ['/var/run/docker.sock', /credential or runtime path/],
      ['/etc/passwd', /neither the run worktree/],
      ['/', /neither the run worktree/],
    ];
    for (const [source, expected] of cases) {
      expect(() =>
        assertMountsAllowed([{ source, target: source, readOnly: true }], allow, HOME),
      ).toThrow(expected);
      expect(() =>
        assertMountsAllowed([{ source, target: source, readOnly: true }], allow, HOME),
      ).toThrow(MountDisciplineError);
    }
  });

  it('accepts a path inside the worktree, which is the one legitimate variation', () => {
    expect(() =>
      assertMountsAllowed(
        [{ source: `${WORKTREE}/packages/app`, target: `${WORKTREE}/packages/app`, readOnly: false }],
        { worktree: WORKTREE, sessionDir: SESSION },
        HOME,
      ),
    ).not.toThrow();
  });

  it('leaves the worktree and the transcript writable, which resume depends on', () => {
    const mounts = composeMounts({ worktree: WORKTREE, sessionDir: SESSION });
    expect(mounts.map((mount) => mount.readOnly)).toStrictEqual([false, false]);
  });
});

describe('the environment a container receives', () => {
  it('is built from an allow-list, not inherited', () => {
    const env = composeContainerEnv(
      request({
        env: {
          GITHUB_TOKEN: 'ghp_notreal',
          AWS_SECRET_ACCESS_KEY: 'notreal',
          ANTHROPIC_API_KEY: 'sk-notreal',
          SSH_AUTH_SOCK: '/tmp/agent.sock',
          PATH: '/usr/bin',
          HOME: HOME,
          LANG: 'en_GB.UTF-8',
          ORCH_RUN_MODE: 'live',
        },
      }),
    );
    expect(Object.keys(env).sort()).toStrictEqual([
      'CLAUDE_CONFIG_DIR',
      'HOME',
      'LANG',
      'ORCH_CONTAINED',
      'ORCH_RUN',
      'ORCH_RUN_MODE',
      'ORCH_STEP',
      'ORCH_TIER',
    ]);
    // HOME is the container's tmpfs one, never the host's.
    expect(env['HOME']).toBe(CONTAINER_HOME);
    expect(env['CLAUDE_CONFIG_DIR']).toBe(SESSION);
  });

  it('refuses loudly when a credential is handed to it under an allow-listed name', () => {
    // A host `GITHUB_TOKEN` is simply not passed; an `ORCH_GITHUB_TOKEN` is somebody deliberately
    // giving the executor a push credential, and AD-20 says it has none.
    expect(() => composeContainerEnv(request({ env: { ORCH_GITHUB_TOKEN: 'ghp_notreal' } }))).toThrow(
      CredentialLeakError,
    );
  });

  it('recognises a credential by shape as well as by name', () => {
    for (const name of [
      'GITHUB_TOKEN',
      'NPM_TOKEN',
      'AWS_SECRET_ACCESS_KEY',
      'ANTHROPIC_API_KEY',
      'DEPLOY_PASSWORD',
      'SIGNING_KEY',
      'SSH_AUTH_SOCK',
      'GIT_ASKPASS',
      'SOME_CREDENTIALS_FILE',
    ]) {
      expect(isCredentialEnvName(name), name).toBe(true);
    }
    for (const name of ['ORCH_RUN', 'LANG', 'CLAUDE_CONFIG_DIR', 'ORCH_TIER', 'HOME']) {
      expect(isCredentialEnvName(name), name).toBe(false);
    }
  });

  it('reaches the argv as --env entries and nothing else', () => {
    const entries = envEntriesOf(composeRunArgs(request({ env: { ORCH_RUN_MODE: 'shadow' } })));
    expect(entries).toContain('ORCH_RUN_MODE=shadow');
    expect(entries).toContain(`HOME=${CONTAINER_HOME}`);
    expect(entries.some((entry) => entry.startsWith('PATH='))).toBe(false);
  });
});

describe('the two phases', () => {
  it('gives provisioning a network and execution none', () => {
    expect(valueOf(composeRunArgs(request({ phase: 'provisioning' })), '--network')).toBe(
      NETWORK_PROVISIONING,
    );
    expect(valueOf(composeRunArgs(request({ phase: 'execution' })), '--network')).toBe(NETWORK_NONE);
    // The default is the restrictive one: a caller that forgets to say gets no network.
    expect(valueOf(composeRunArgs(request()), '--network')).toBe(NETWORK_NONE);
  });

  it('hardens provisioning exactly as it hardens execution', () => {
    // The two-phase sandbox trades network for time, not for containment.
    const provisioning = composeRunArgs(request({ phase: 'provisioning' }));
    expect(missingAd20Flags(provisioning)).toStrictEqual([]);
    expect(valueOf(provisioning, '--cap-drop')).toBe('ALL');
    expect(provisioning).toContain('--read-only');
  });
});

describe('the required-flag list itself', () => {
  it('reports what a vector is missing rather than only that it is wrong', () => {
    expect(missingAd20Flags(['--read-only'])).toStrictEqual(
      AD20_REQUIRED_FLAGS.filter((flag) => flag !== '--read-only'),
    );
  });
});
