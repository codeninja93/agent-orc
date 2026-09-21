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
  CONTAINER_CONTROL_TIMEOUT_MS,
  DEFAULT_SERVICE_MEMORY_LIMIT,
  DEFAULT_SERVICE_PIDS_LIMIT,
  FORBIDDEN_SERVICE_FLAGS,
  FORBIDDEN_SERVICE_FLAG_REASONS,
  REFUSED_SECCOMP_PROFILE,
  SERVICE_START_TIMEOUT_MS,
  firstForbiddenFlag,
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

/**
 * What each kind's emptiness probe prints when the instance is empty, and when it is not.
 *
 * Per kind because the probes are not the same shape: postgres sums its surviving objects to one integer,
 * and redis reports a keyspace section — which is what makes its answer cover all sixteen databases rather
 * than only the selected one.
 */
const EMPTY_PROBE_OUTPUT: Readonly<Record<ServiceKind, { readonly empty: string; readonly dirty: string }>> = {
  postgres: { empty: '0\n', dirty: '3\n' },
  redis: {
    empty: '# Keyspace\r\n\r\n',
    dirty: '# Keyspace\r\ndb0:keys=3,expires=0,avg_ttl=0\r\n\r\n',
  },
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
    // FIXTURE CHANGED: the samples are now per kind. Redis's probe is `info keyspace` rather than `dbsize`,
    // because `flushall` clears all sixteen databases and `dbsize` reported only the selected one — so the
    // check verified a sixteenth of what the wipe cleared. The intent of this case is unchanged: empty reads
    // as empty, anything reads as residue, and unreadable fails closed.
    expect(definition.residueOf(EMPTY_PROBE_OUTPUT[kind].empty)).toStrictEqual([]);
    expect(definition.residueOf(EMPTY_PROBE_OUTPUT[kind].dirty)).toHaveLength(1);
    // Unreadable fails closed: an answer nobody can parse has not established emptiness.
    expect(definition.residueOf('could not connect')).toHaveLength(1);
  });

  it('carries no forbidden flag in either spelling the runtime accepts', () => {
    // The check here used to be a local `includes` loop, which repeated `flags.ts`'s own `=`-form blind
    // spot: `--cap-add=SYS_ADMIN` walked straight past it, and every value-bearing entry it inherited
    // (`--pid=host`, `--network=host`) could never fire at all. `firstForbiddenFlag` is the one matcher.
    for (const vector of [
      ['--cap-add', 'SYS_ADMIN'],
      ['--cap-add=SYS_ADMIN'],
      ['--privileged'],
      ['--pid', 'host'],
      ['--pid=host'],
      ['--network', 'host'],
      ['--network=host'],
      ['--volume', '/etc:/etc'],
      ['--volume=/etc:/etc'],
      ['--mount', 'type=bind,src=/etc,dst=/etc'],
    ]) {
      const hit = firstForbiddenFlag(vector, FORBIDDEN_SERVICE_FLAG_REASONS);
      expect(hit, vector.join(' ')).not.toBe(null);
      expect(hit?.reason.length, vector.join(' ')).toBeGreaterThan(10);
    }
    // And the flags a service legitimately carries are not caught by it.
    expect(firstForbiddenFlag([...args], FORBIDDEN_SERVICE_FLAG_REASONS)).toBe(null);
    // `--detach` is required of a service and forbidden of a step: the two tables differ on purpose.
    expect(firstForbiddenFlag(['--detach'], FORBIDDEN_SERVICE_FLAG_REASONS)).toBe(null);
    expect(firstForbiddenFlag(['--detach'])).not.toBe(null);
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
    // FIXTURE CHANGED: the probe's answer is now a keyspace section rather than a bare count, for the reason
    // the emptiness-probe case above records. The intent is unchanged.
    const seen: ContainerInvocation[] = [];
    const operator = createServiceOperator(
      recordingInvoker(seen, (invocation) =>
        invocation.args.includes('keyspace')
          ? { status: 0, stdout: EMPTY_PROBE_OUTPUT.redis.empty }
          : { status: 0, stdout: '' },
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

  it('reports residue when the instance still holds data, in any database', () => {
    const operator = createServiceOperator(
      recordingInvoker([], () => ({
        status: 0,
        // Two databases, which is precisely what `dbsize` could not see: it read the selected one only,
        // while `flushall` clears all sixteen.
        stdout: '# Keyspace\r\ndb0:keys=4,expires=0,avg_ttl=0\r\ndb3:keys=3,expires=0,avg_ttl=0\r\n',
      })),
    );
    const residue = operator.residue(instance);
    expect(residue.ok).toBe(false);
    expect(residue.residue.join(' ')).toContain('7');
    expect(residue.residue.join(' ')).toContain('db3');
  });

  it('asks whether a container exists, separately from whether it is ready', () => {
    // Two different remedies: a container that exists and is not serving is worth waiting for; one that is
    // gone — the state a reboot leaves, since records are durable and containers are not — never will be.
    const seen: ContainerInvocation[] = [];
    const present = createServiceOperator(
      recordingInvoker(seen, () => ({ status: 0, stdout: 'running\n' })),
    ).exists(instance);
    expect(present.ok).toBe(true);
    expect(seen[0]?.subcommand).toStrictEqual([...CONTAINER_SUBCOMMANDS.inspectContainer]);
    expect(seen[0]?.args.at(-1)).toBe(instance.containerName);

    const gone = createServiceOperator((invocation) => ({
      status: 1,
      stdout: '',
      stderr: 'Error: No such object: orch-pool-redis-lease-9f1c',
      argv: [...invocation.subcommand],
    })).exists(instance);
    expect(gone.ok).toBe(false);
  });

  it('forces the removal, because a container that ignored stop is still running', () => {
    // Without `--force` a plain `rm` refuses a running container, so an instance whose process ignores
    // SIGTERM was destroyed by nothing at all — on this pass or any later one. AD-32 makes the pass the only
    // thing that removes a container, so the pass has to be able to.
    const seen: ContainerInvocation[] = [];
    createServiceOperator(recordingInvoker(seen)).destroy(instance);
    const removal = seen.find(
      (invocation) => invocation.subcommand.join(' ') === CONTAINER_SUBCOMMANDS.remove.join(' '),
    );
    expect(removal?.args).toContain('--force');
    expect(removal?.args).toContain('--volumes');
    expect(removal?.args.at(-1)).toBe(instance.containerName);
  });

  it('sweeps pooled containers by the one label that stays true for a container’s whole life', () => {
    // `SERVICE_LABEL_KEYS` was documented as the sweep's discovery mechanism and nothing swept by it, so a
    // container whose durable record was lost was reclaimable by no pass. The sweep keys on `orch.pool`
    // alone: a warm instance leased a second time is never restarted, so its `orch.run` and `orch.lease`
    // labels still name the *first* lease and are evidence for a person rather than a fact to act on.
    const seen: ContainerInvocation[] = [];
    const swept = createServiceOperator(
      recordingInvoker(seen, () => ({
        status: 0,
        stdout: 'orch-pool-redis-a\tredis\tredis:7.4-alpine\norch-pool-postgres-b\t\tpostgres:17.2-alpine\n',
      })),
    ).sweep();

    expect(seen[0]?.subcommand).toStrictEqual([...CONTAINER_SUBCOMMANDS.list]);
    expect(seen[0]?.args).toContain(`label=${SERVICE_LABEL_KEYS.pool}=1`);
    expect(seen[0]?.args).toContain('--all');
    expect(seen[0]?.args.join(' ')).not.toContain(SERVICE_LABEL_KEYS.run);
    expect(swept.ok).toBe(true);
    expect(swept.instances.map((one) => one.containerName)).toStrictEqual([
      'orch-pool-redis-a',
      'orch-pool-postgres-b',
    ]);
    expect(swept.instances[0]?.kind).toBe('redis');
    // An unlabelled or unrecognised kind is `null`, never guessed from the container's name.
    expect(swept.instances[1]?.kind).toBe(null);
  });

  it('never reads a sweep that could not run as “no containers”', () => {
    const failed = createServiceOperator((invocation) => ({
      status: 1,
      stdout: '',
      stderr: 'Cannot connect to the container runtime',
      argv: [...invocation.subcommand],
    })).sweep();
    expect(failed.ok).toBe(false);
    expect(failed.instances).toStrictEqual([]);
  });

  it('gives the start invocation a ceiling a cold image pull can fit inside', () => {
    const seen: ContainerInvocation[] = [];
    createServiceOperator(recordingInvoker(seen)).start(request('postgres'));
    expect(seen[0]?.timeoutMs).toBe(SERVICE_START_TIMEOUT_MS);
    expect(SERVICE_START_TIMEOUT_MS).toBeGreaterThan(CONTAINER_CONTROL_TIMEOUT_MS);

    // And a caller with a declared bound gets its own number, so the bound it promised is the one that holds.
    const bounded: ContainerInvocation[] = [];
    createServiceOperator(recordingInvoker(bounded)).start({ ...request('redis'), timeoutMs: 9_000 });
    expect(bounded[0]?.timeoutMs).toBe(9_000);
  });

  it('asks readiness with a positive match rather than the absence of a complaint', () => {
    // `pg_isready -q` prints nothing on success, and the rule was a *negative* match — so the empty string
    // `-q` guarantees read as ready, and so did every unreadable answer. The claim is now the phrase itself.
    expect(serviceDefinition('postgres').readiness).not.toContain('-q');
    expect(serviceDefinition('postgres').readyWhen('')).toBe(false);
    expect(serviceDefinition('postgres').readyWhen('some unrelated output')).toBe(false);
    expect(serviceDefinition('postgres').readyWhen('/tmp:5432 - accepting connections')).toBe(true);
    // Redis was already positive; both kinds now read the same way.
    expect(serviceDefinition('redis').readyWhen('')).toBe(false);
    expect(serviceDefinition('redis').readyWhen('PONG')).toBe(true);
  });

  it('wipes every non-system schema, not only public, and reports what the wipe cannot reach', () => {
    const definition = serviceDefinition('postgres');
    const wipe = definition.wipe.join(' ');
    expect(wipe).toContain('DROP SCHEMA');
    // A feature may `CREATE SCHEMA`; a wipe that knew only about `public` left its tables standing.
    expect(wipe).toContain('pg_namespace');
    const probe = definition.emptyProbe.join(' ');
    // Cluster-wide objects the wipe cannot reach are *reported*, so the instance is quarantined for a person
    // rather than handed on — the fail-closed direction CAP-11 asks for.
    expect(probe).toContain('pg_database');
    expect(probe).toContain('pg_roles');
    expect(probe).toContain('pg_namespace');
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
