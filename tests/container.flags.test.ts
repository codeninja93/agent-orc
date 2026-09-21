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
  CREDENTIAL_ENV_NAMES,
  CREDENTIAL_ENV_PATTERNS,
  CREDENTIAL_ENV_SHAPE_EXEMPTIONS,
  CredentialLeakError,
  DEFAULT_MEMORY_LIMIT,
  DEFAULT_PIDS_LIMIT,
  DEFAULT_SECCOMP_PROFILE,
  EXECUTOR_USER,
  envEntriesOf,
  FORBIDDEN_RUN_FLAG_REASONS,
  FORBIDDEN_RUN_FLAGS,
  ForbiddenFlagError,
  firstForbiddenFlag,
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
/**
 * The allow-list is now rooted in an `ORCH_HOME` rather than in the caller's own request, so the fixture
 * states which one. AD-9 puts a run worktree under `worktrees/` and a run's session directory under
 * `runs/<run-id>/`, and a request naming anything else is refused — which is what makes the allow-list a
 * list rather than a restatement of whatever was asked for.
 */
const ORCH_HOME = '/tmp/orch-home';
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
  orchHome: ORCH_HOME,
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
    // `--init` is load-bearing for the exit code rather than for a permission: without it a signalled
    // step is reported as a plain failure and story 1-4's `signalFromExitCode` can never reach
    // `interrupted`, which is AD-8's only resumable disposition.
    expect(argv).toContain('--init');
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
    // The container's HOME is a tmpfs too, and it has to be: a read-only root with an unwritable HOME
    // is a step that fails on its first log line, and mounting the host's would break AD-20's rule.
    expect(tmpfs.some((mount) => mount.startsWith(`${CONTAINER_HOME}:`))).toBe(true);
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
        assertMountsAllowed([{ source, target: source, readOnly: true }], allow, HOME, ORCH_HOME),
      ).toThrow(expected);
      expect(() =>
        assertMountsAllowed([{ source, target: source, readOnly: true }], allow, HOME, ORCH_HOME),
      ).toThrow(MountDisciplineError);
    }
  });

  it('accepts a path inside the worktree, which is the one legitimate variation', () => {
    expect(() =>
      assertMountsAllowed(
        [{ source: `${WORKTREE}/packages/app`, target: `${WORKTREE}/packages/app`, readOnly: false }],
        { worktree: WORKTREE, sessionDir: SESSION },
        HOME,
        ORCH_HOME,
      ),
    ).not.toThrow();
  });

  it('refuses an allow-list that is not itself inside ORCH_HOME, which is what makes it a list', () => {
    // The hole this closes: every mount was checked against `allow.worktree` and `allow.sessionDir`,
    // and both arrive from the same caller as the mounts. Naming `/` as the worktree therefore made `/`
    // an allowed mount — the allow-list agreed with itself and admitted the whole filesystem.
    const mount = (source: string) => [{ source, target: source, readOnly: false }];
    for (const allow of [
      { worktree: '/', sessionDir: SESSION },
      { worktree: '/etc', sessionDir: SESSION },
      { worktree: HOME, sessionDir: SESSION },
      { worktree: `${ORCH_HOME}/worktrees`, sessionDir: SESSION },
      { worktree: 'worktrees/relative', sessionDir: SESSION },
    ]) {
      expect(() => assertMountsAllowed(mount(allow.worktree), allow, HOME, ORCH_HOME), allow.worktree).toThrow(
        MountDisciplineError,
      );
    }
    for (const allow of [
      { worktree: WORKTREE, sessionDir: '/tmp/somewhere/session' },
      { worktree: WORKTREE, sessionDir: `${ORCH_HOME}/runs` },
      { worktree: WORKTREE, sessionDir: 'runs/relative/session' },
    ]) {
      expect(() => assertMountsAllowed(mount(allow.worktree), allow, HOME, ORCH_HOME), allow.sessionDir).toThrow(
        MountDisciplineError,
      );
    }
    // And through the composer, which is the path a wrapper actually takes.
    expect(() => composeRunArgs(request({ worktree: '/', sessionDir: SESSION }))).toThrow(
      MountDisciplineError,
    );
    expect(() => composeRunArgs(request({ orchHome: '/tmp/somebody-elses-home' }))).toThrow(
      MountDisciplineError,
    );
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

describe('the self-check on the composed vector', () => {
  it('catches a forbidden flag in either spelling, and a value-bearing one as a pair', () => {
    // A runtime accepts `--cap-add SYS_ADMIN` and `--cap-add=SYS_ADMIN` alike, so a check that knows
    // only the separated spelling is a check that can be walked past in one character. And the two
    // entries the table writes with a value — `--pid=host`, `--network=host` — are composed as two
    // tokens, so matching only the joined form made those entries unable to fire at all.
    expect(firstForbiddenFlag(['--read-only', '--cap-add=SYS_ADMIN'])?.flag).toBe('--cap-add');
    expect(firstForbiddenFlag(['--read-only', '--cap-add', 'SYS_ADMIN'])?.flag).toBe('--cap-add');
    expect(firstForbiddenFlag(['--pid=host'])?.flag).toBe('--pid=host');
    expect(firstForbiddenFlag(['--pid', 'host'])?.flag).toBe('--pid=host');
    expect(firstForbiddenFlag(['--network=host'])?.flag).toBe('--network=host');
    expect(firstForbiddenFlag(['--network', 'host'])?.flag).toBe('--network=host');
    expect(firstForbiddenFlag(['--rm'])?.flag).toBe('--rm');
    expect(firstForbiddenFlag(['--detach'])?.flag).toBe('--detach');
    // The refusal carries the table's own reason, so a message says why rather than only what.
    expect(firstForbiddenFlag(['--rm'])?.reason).toBe(FORBIDDEN_RUN_FLAG_REASONS['--rm']);
  });

  it('leaves the flags AD-20 does compose alone, --network among them', () => {
    // `--network` is required; only `--network host` is the violation. A check that refused the flag
    // itself would refuse every argv this file builds.
    expect(firstForbiddenFlag(composeRunArgs(request()))).toBeNull();
    expect(firstForbiddenFlag(['--network', NETWORK_NONE, '--pid', 'container:other'])).toBeNull();
  });
});

describe('the limits, which are the one part of the set a caller gives a value for', () => {
  it('refuses a limit that means "unlimited" while the flag stays present', () => {
    // `--memory 0` and `--pids-limit -1` are how a runtime is told there is no limit. Every flag is
    // still there, `missingAd20Flags` is still empty, and the containment is gone — which is why the
    // value is checked and not only the name.
    for (const memoryLimit of ['0', '0g', '', 'lots', '2', '1g', '512m']) {
      expect(() => composeRunArgs(request({ memoryLimit })), memoryLimit).toThrow(ForbiddenFlagError);
    }
    for (const pidsLimit of [-1, 0, 1, 511, 1.5, Number.NaN]) {
      expect(() => composeRunArgs(request({ pidsLimit })), String(pidsLimit)).toThrow(ForbiddenFlagError);
    }
  });

  it('accepts a raise, which is what "overridable upward" means', () => {
    const argv = composeRunArgs(request({ memoryLimit: '8g', pidsLimit: 2048 }));
    expect(valueOf(argv, '--memory')).toBe('8g');
    expect(valueOf(argv, '--memory-swap')).toBe('8g');
    expect(valueOf(argv, '--pids-limit')).toBe('2048');
    // Expressed in another unit, the same size passes: the comparison is bytes, not the string.
    expect(valueOf(composeRunArgs(request({ memoryLimit: '4096m' })), '--memory')).toBe('4096m');
  });
});

describe('the composed identity', () => {
  it('wins over a host variable of the same name', () => {
    // `ORCH_` is an allow-listed prefix, so a host `ORCH_TIER=0` or an empty `ORCH_CONTAINED` reached
    // the loop and replaced the values composed above — and then disagreed with the `orch.tier` label
    // on the same argv. Two answers to "is this contained" on one invocation is the ambiguity AD-20's
    // one-boundary rule exists to remove.
    const env = composeContainerEnv(
      request({
        env: {
          ORCH_TIER: '0',
          ORCH_CONTAINED: '',
          ORCH_RUN: 'some-other-run',
          ORCH_STEP: 'some-other-step',
          HOME: HOME,
          CLAUDE_CONFIG_DIR: '/Users/somebody/.claude',
        },
      }),
    );
    expect(env['ORCH_TIER']).toBe('2');
    expect(env['ORCH_CONTAINED']).toBe('1');
    expect(env['ORCH_RUN']).toBe('01ARZ3NDEKTSV4RRFFQ69G5FAV');
    expect(env['ORCH_STEP']).toBe('implement');
    expect(env['HOME']).toBe(CONTAINER_HOME);
    expect(env['CLAUDE_CONFIG_DIR']).toBe(SESSION);
    // And the argv agrees with the labels, which is the property the disagreement broke.
    const argv = composeRunArgs(request({ env: { ORCH_TIER: '0' } }));
    expect(envEntriesOf(argv)).toContain('ORCH_TIER=2');
    expect(argv).toContain('orch.tier=2');
  });
});

describe('the credential filter\'s escape hatch', () => {
  it('exempts only declared names, and only ones the patterns would actually have caught', () => {
    // The patterns are deliberately broad, and breadth on a refusal path costs something: an
    // `ORCH_SESSION_ID` — an identifier this engine mints and already puts in the argv — was refused
    // with no way past it, so a naming choice in another story made a tier-2 run unlaunchable. The
    // hatch is a declared entry with a reason, and this asserts the table cannot accumulate names the
    // guard never objected to in the first place.
    for (const [name, reason] of Object.entries(CREDENTIAL_ENV_SHAPE_EXEMPTIONS)) {
      expect(CREDENTIAL_ENV_PATTERNS.some((pattern) => pattern.test(name)), name).toBe(true);
      expect(CREDENTIAL_ENV_NAMES, name).not.toContain(name);
      expect(reason.length, name).toBeGreaterThan(40);
      expect(isCredentialEnvName(name), name).toBe(false);
    }
    // A run can therefore actually launch with them, which is the point.
    expect(() =>
      composeRunArgs(request({ env: { ORCH_SESSION_ID: '01ARZ3NDEKTSV4RRFFQ69G5FAV' } })),
    ).not.toThrow();
    // And the names either side of them are still refused.
    for (const name of ['ORCH_SESSION_TOKEN', 'ORCH_SIGNING_KEY', 'ORCH_GITHUB_TOKEN']) {
      expect(isCredentialEnvName(name), name).toBe(true);
    }
  });
});
