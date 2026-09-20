/**
 * The composed argv for a leased service container.
 *
 * With no daemon reachable the argv is the only assertable part of a leased instance — and it is also the
 * part that matters, because AD-20's containment *is* the flag set. So this suite asserts the vector the
 * runtime would receive rather than the table it was composed from, the same lesson story 1-4 learned at
 * its own seam and story 1-5 repeated at the executor's.
 *
 * Nothing here needs a runtime: every invocation goes through a recording double, which also lets the
 * five operations of `ServiceOperator` be asserted by the invocations they produce.
 */
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_SERVICE_MEMORY_LIMIT,
  DEFAULT_SERVICE_PIDS_LIMIT,
  FORBIDDEN_SERVICE_FLAGS,
  REFUSED_SECCOMP_PROFILE,
  SERVICE_DEFINITIONS,
  SERVICE_ENV_SHAPE_EXCEPTIONS,
  SERVICE_KINDS,
  SERVICE_LABEL_KEYS,
  SERVICE_PUBLISH_ADDRESS,
  SERVICE_REQUIRED_FLAGS,
  SERVICE_USER,
  CONTAINER_SUBCOMMANDS,
  composeServiceExecArgs,
  composeServiceRunArgs,
  createServiceOperator,
  envEntriesOf,
  instanceFor,
  isCredentialEnvName,
  isServiceEnvNamePermitted,
  missingServiceFlags,
  mountsOf,
  serviceDefinition,
} from '../src/container/index.js';
import type { ContainerInvocation, ContainerInvoker, ServiceKind, ServiceStartRequest } from '../src/container/index.js';

const RUN = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const LEASE = 'lease-9f1c';

const request = (kind: ServiceKind, overrides: Partial<ServiceStartRequest> = {}): ServiceStartRequest => ({
  kind,
  run: RUN,
  lease: LEASE,
  containerName: `orch-pool-${kind}-${LEASE}`,
  hostPort: 55_401,
  ...overrides,
});

/** An invoker that records what it was asked and answers success. */
const recordingInvoker = (
  seen: ContainerInvocation[],
  answer: (invocation: ContainerInvocation) => { status: number; stdout: string } = () => ({
    status: 0,
    stdout: '',
  }),
): ContainerInvoker => {
  return (invocation: ContainerInvocation) => {
    seen.push(invocation);
    const { status, stdout } = answer(invocation);
    return {
      status,
      stdout,
      stderr: '',
      argv: ['<runtime>', ...invocation.subcommand, ...invocation.args],
    };
  };
};

describe.each(SERVICE_KINDS)('the composed argv for a leased %s', (kind) => {
  const definition = serviceDefinition(kind);
  const args = composeServiceRunArgs(request(kind));

  it('carries every flag AD-20 requires of a service', () => {
    expect(missingServiceFlags(args)).toStrictEqual([]);
    for (const flag of SERVICE_REQUIRED_FLAGS) expect(args, flag).toContain(flag);
  });

  it('drops every capability, refuses new privileges and names a real seccomp profile', () => {
    expect(args[args.indexOf('--cap-drop') + 1]).toBe('ALL');
    const securityOptions = args.flatMap((value, index) =>
      args[index - 1] === '--security-opt' ? [value] : [],
    );
    expect(securityOptions).toContain('no-new-privileges');
    const seccomp = securityOptions.find((option) => option.startsWith('seccomp='));
    expect(seccomp).toBeDefined();
    expect(seccomp).not.toBe(`seccomp=${REFUSED_SECCOMP_PROFILE}`);
  });

  it('runs as a non-root user with a read-only root and its data on tmpfs', () => {
    expect(args[args.indexOf('--user') + 1]).toBe(SERVICE_USER);
    expect(SERVICE_USER.startsWith('0:')).toBe(false);
    expect(args).toContain('--read-only');
    const tmpfs = args.flatMap((value, index) => (args[index - 1] === '--tmpfs' ? [value] : []));
    expect(tmpfs).toStrictEqual([...definition.tmpfsMounts]);
    expect(tmpfs.length).toBeGreaterThan(0);
  });

  it('mounts nothing from the host, so no residue can outlive the lease', () => {
    expect(mountsOf(args)).toStrictEqual([]);
    for (const flag of ['--volume', '-v', '--mount']) expect(args, flag).not.toContain(flag);
  });

  it('carries the memory and pid limits, with swap pinned to the memory limit', () => {
    expect(args[args.indexOf('--memory') + 1]).toBe(DEFAULT_SERVICE_MEMORY_LIMIT);
    expect(args[args.indexOf('--memory-swap') + 1]).toBe(DEFAULT_SERVICE_MEMORY_LIMIT);
    expect(args[args.indexOf('--pids-limit') + 1]).toBe(String(DEFAULT_SERVICE_PIDS_LIMIT));
  });

  it('publishes on loopback only, at the port the pool allocated', () => {
    const published = args[args.indexOf('--publish') + 1];
    expect(published).toBe(`${SERVICE_PUBLISH_ADDRESS}:55401:${String(definition.internalPort)}`);
    expect(published?.startsWith('127.0.0.1:')).toBe(true);
  });

  it('labels the instance with its run, its lease and its kind, so a sweep can find it', () => {
    const labels = args.flatMap((value, index) => (args[index - 1] === '--label' ? [value] : []));
    expect(labels).toContain(`${SERVICE_LABEL_KEYS.run}=${RUN}`);
    expect(labels).toContain(`${SERVICE_LABEL_KEYS.lease}=${LEASE}`);
    expect(labels).toContain(`${SERVICE_LABEL_KEYS.resource}=${kind}`);
  });

  it('is detached, because a service outlives the invocation that starts it', () => {
    // The opposite of the executor's rule, and for the opposite reason: a step's exit code is its
    // disposition, and a service has no exit code to wait for.
    expect(args).toContain('--detach');
  });

  it('never carries --rm: removal is a reclamation action (AD-32)', () => {
    expect(args).not.toContain('--rm');
  });

  it('carries no forbidden flag before the image', () => {
    const beforeImage = args.slice(0, args.indexOf(definition.image));
    for (const flag of FORBIDDEN_SERVICE_FLAGS) expect(beforeImage, flag).not.toContain(flag);
    expect(FORBIDDEN_SERVICE_FLAGS).not.toContain('--detach');
  });

  it('ends at the image, so nothing is appended where the service would receive it', () => {
    expect(args.at(-1)).toBe(definition.image);
  });

  it('passes no credential-shaped environment name except an argued exception', () => {
    for (const entry of envEntriesOf(args)) {
      const name = entry.split('=')[0] ?? '';
      expect(isServiceEnvNamePermitted(name), name).toBe(true);
    }
    for (const name of Object.keys(definition.env)) {
      expect(isServiceEnvNamePermitted(name), name).toBe(true);
    }
  });

  it('declares a readiness probe, a wipe and an emptiness probe', () => {
    expect(definition.readiness.length).toBeGreaterThan(0);
    expect(definition.wipe.length).toBeGreaterThan(0);
    expect(definition.emptyProbe.length).toBeGreaterThan(0);
  });

  it('reads an emptiness probe that counts nothing as empty and anything as residue', () => {
    expect(definition.residueOf('0\n')).toStrictEqual([]);
    expect(definition.residueOf('3\n')).toHaveLength(1);
    // Unreadable fails closed: an answer nobody can parse has not established emptiness.
    expect(definition.residueOf('could not connect')).toHaveLength(1);
  });
});

describe('the service table', () => {
  it('refuses a seccomp profile that is the absence of one', () => {
    expect(() =>
      composeServiceRunArgs({ ...request('redis'), seccompProfile: REFUSED_SECCOMP_PROFILE }),
    ).toThrow(/unconfined/);
  });

  it('argues every environment-name exception, and holds none the guard would not have caught', () => {
    // An exception that was never shape-matched is a name nobody objected to, sitting in a table that
    // reads as a waiver — which is how the guard quietly stops meaning anything.
    for (const [name, reason] of Object.entries(SERVICE_ENV_SHAPE_EXCEPTIONS)) {
      expect(isCredentialEnvName(name), name).toBe(true);
      expect(reason.length, name).toBeGreaterThan(40);
    }
    expect(isServiceEnvNamePermitted('POSTGRES_PASSWORD')).toBe(false);
    expect(isServiceEnvNamePermitted('AWS_SECRET_ACCESS_KEY')).toBe(false);
  });

  it('pins every image by tag rather than leaving it floating', () => {
    for (const kind of SERVICE_KINDS) {
      const image = SERVICE_DEFINITIONS[kind].image;
      expect(image, image).toMatch(/:[\w.-]+$/);
      expect(image, image).not.toMatch(/:latest$/);
    }
  });

  it('raises the limits a caller declares rather than ignoring them', () => {
    const args = composeServiceRunArgs({ ...request('postgres'), memoryLimit: '4g', pidsLimit: 1024 });
    expect(args[args.indexOf('--memory') + 1]).toBe('4g');
    expect(args[args.indexOf('--memory-swap') + 1]).toBe('4g');
    expect(args[args.indexOf('--pids-limit') + 1]).toBe('1024');
  });

  it('refuses an exec with no command, which would report success for doing nothing', () => {
    expect(() => composeServiceExecArgs(instanceFor(request('redis')), [])).toThrow(/no-op/);
  });
});

describe('the operator: five operations, every one an invocation through the single invoker', () => {
  const instance = instanceFor(request('redis'));

  it('starts an instance with the composed run argv', () => {
    const seen: ContainerInvocation[] = [];
    const outcome = createServiceOperator(recordingInvoker(seen)).start(request('redis'));
    expect(outcome.ok).toBe(true);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.subcommand).toStrictEqual([...CONTAINER_SUBCOMMANDS.run]);
    expect(seen[0]?.args).toStrictEqual([...composeServiceRunArgs(request('redis'))]);
    expect(outcome.instance.containerName).toBe(`orch-pool-redis-${LEASE}`);
  });

  it('asks readiness inside the instance and reads the answer rather than the exit code alone', () => {
    const seen: ContainerInvocation[] = [];
    const ready = createServiceOperator(
      recordingInvoker(seen, () => ({ status: 0, stdout: 'PONG\n' })),
    ).ready(instance);
    expect(ready.ok).toBe(true);
    expect(seen[0]?.subcommand).toStrictEqual([...CONTAINER_SUBCOMMANDS.exec]);
    expect(seen[0]?.args).toStrictEqual([
      instance.containerName,
      ...serviceDefinition('redis').readiness,
    ]);

    // Exit zero with the wrong answer is not readiness.
    const wrong = createServiceOperator(recordingInvoker([], () => ({ status: 0, stdout: 'LOADING' }))).ready(
      instance,
    );
    expect(wrong.ok).toBe(false);
  });

  it('wipes, then reports residue, and treats an unreadable probe as residue', () => {
    const seen: ContainerInvocation[] = [];
    const operator = createServiceOperator(
      recordingInvoker(seen, (invocation) =>
        invocation.args.includes('dbsize') ? { status: 0, stdout: '0\n' } : { status: 0, stdout: '' },
      ),
    );
    expect(operator.wipe(instance).ok).toBe(true);
    expect(seen[0]?.args).toStrictEqual([instance.containerName, ...serviceDefinition('redis').wipe]);
    const residue = operator.residue(instance);
    expect(residue.ok).toBe(true);
    expect(residue.residue).toStrictEqual([]);

    const failing = createServiceOperator(recordingInvoker([], () => ({ status: 1, stdout: '' })));
    const refused = failing.residue(instance);
    expect(refused.ok).toBe(false);
    expect(refused.residue.length).toBeGreaterThan(0);
  });

  it('reports residue when the instance still holds data', () => {
    const operator = createServiceOperator(recordingInvoker([], () => ({ status: 0, stdout: '7\n' })));
    const residue = operator.residue(instance);
    expect(residue.ok).toBe(false);
    expect(residue.residue.join(' ')).toContain('7');
  });

  it('destroys an instance by stopping then removing it, and treats already-gone as done', () => {
    const seen: ContainerInvocation[] = [];
    const destroyed = createServiceOperator(recordingInvoker(seen)).destroy(instance);
    expect(destroyed.ok).toBe(true);
    expect(seen.map((invocation) => invocation.subcommand.join(' '))).toStrictEqual([
      CONTAINER_SUBCOMMANDS.stop.join(' '),
      CONTAINER_SUBCOMMANDS.remove.join(' '),
    ]);

    const gone = createServiceOperator((invocation) => ({
      status: invocation.subcommand[0] === 'rm' ? 1 : 0,
      stdout: '',
      stderr: 'Error: No such container: orch-pool-redis-lease-9f1c',
      argv: [],
    })).destroy(instance);
    expect(gone.ok).toBe(true);
    expect(gone.detail).toContain('already gone');
  });
});
