/**
 * AD-20's flag set for a *leased service* container, and the operations a lease performs on one.
 *
 * CAP-11 gives a feature a postgres or a redis quickly and leaves no residue behind it. Every one of
 * those verbs — start, probe for readiness, wipe, verify empty, destroy — is a container invocation, and
 * AD-20 gives one place ownership of every container flag. So the flag set lives here, inside
 * `src/container/`, and `src/pool/` states intent: "start a postgres for this run's lease", never
 * "compose `--publish`". A pool that composed its own flags would be the second containment boundary
 * AD-20 exists to prevent, and the one nobody would think to audit.
 *
 * Four decisions here differ from the executor's flag set in `flags.ts`, and each difference is the
 * point rather than an oversight:
 *
 * **`--detach` is composed here and refused there.** An executor invocation must stay in the
 * foreground: story 1-4 reads the step's exit code, and a detached run reports success the instant the
 * container starts. A service is the opposite — it outlives the invocation that started it by
 * definition, and a foreground `run` would block the pass that leased it forever.
 *
 * **Nothing from the host is mounted at all.** The executor mounts its worktree and its session
 * directory; a leased service mounts nothing. Its data directory is a tmpfs, so "leaves no residue" is
 * a property of where the bytes live rather than of remembering to delete them — and the wipe-then-
 * verify-empty cycle below is the second line of defence for an instance that is reused warm.
 *
 * **`--rm` is absent for AD-32's reason rather than AD-8's.** The executor keeps its container so the
 * session transcript survives for a resume. A service keeps its container so that a reclamation *pass*
 * is what removes it: a self-removing container is a resource whose disappearance no pass witnessed,
 * and a crash between "wiped" and "removed" would leave the pool's durable record pointing at nothing
 * with no way to tell that from a leak.
 *
 * **The network is published on loopback, not absent.** A database nothing can reach is not a leased
 * resource. The publish is bound to `127.0.0.1` explicitly, so the instance is reachable from this
 * machine and from nowhere else; wiring a *confined* step to it is story 2-10's egress work and is
 * deliberately not attempted here.
 *
 * Nothing in this file names the container runtime: the subcommands come from `runtime.ts`, which is
 * the only file allowed to spell it.
 */
import { makeError } from '../contracts/index.js';
import type { OrchError } from '../contracts/index.js';

import {
  DEFAULT_SECCOMP_PROFILE,
  ForbiddenFlagError,
  FORBIDDEN_RUN_FLAG_REASONS,
  firstForbiddenFlag,
  isCredentialEnvName,
  REFUSED_SECCOMP_PROFILE,
} from './flags.js';
import { CONTAINER_CONTROL_TIMEOUT_MS, CONTAINER_SUBCOMMANDS } from './runtime.js';
import type { ContainerInvoker } from './runtime.js';

/** The two resource kinds CAP-11 names. A third arrives as a definition, not as a new code path. */
export const SERVICE_KINDS = ['postgres', 'redis'] as const;

export type ServiceKind = (typeof SERVICE_KINDS)[number];

/**
 * The label keys a reclamation sweep finds a leased instance by, without parsing a name.
 *
 * `pool` is the one the sweep in {@link ServiceOperator.sweep} actually keys on, and the distinction
 * matters: a warm instance leased a second time is never restarted, so its `run` and `lease` labels still
 * name the *first* lease for the rest of its life. Acting on those would attribute a live instance to a
 * finished run. `pool` and `resource` are properties of the container itself and stay true; `run` and
 * `lease` are evidence about its first lease and are read by a person, never by a pass.
 */
export const SERVICE_LABEL_KEYS = {
  run: 'orch.run',
  lease: 'orch.lease',
  resource: 'orch.resource',
  pool: 'orch.pool',
} as const;

/**
 * The uid:gid a leased service runs as.
 *
 * Non-root for the same reason the executor is, and *not* the executor's own uid: a step and the
 * database it leases have no reason to share an identity, and the tmpfs data directory below is owned
 * by whichever uid the service runs as.
 */
export const SERVICE_USER = '10002:10002';

/** AD-20's limits, as defaults a caller may raise for a larger dataset. */
export const DEFAULT_SERVICE_MEMORY_LIMIT = '1g';
export const DEFAULT_SERVICE_PIDS_LIMIT = 256;

/** The loopback address a leased instance is published on, and nowhere else. */
export const SERVICE_PUBLISH_ADDRESS = '127.0.0.1';

/**
 * The ceiling on a start invocation when the caller declares no bound of its own.
 *
 * Longer than {@link CONTAINER_CONTROL_TIMEOUT_MS} on purpose: the first start of a kind pulls its image,
 * and a 30s control-plane timeout killed that pull and handed the caller a failure that read as a lease
 * timeout. A caller with a declared bound passes it through `ServiceStartRequest.timeoutMs` instead, so the
 * bound it promised is the one that applies.
 */
export const SERVICE_START_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Everything that differs between one leasable service and the next.
 *
 * Data rather than a subclass per kind, so `tests/container.service.test.ts` can assert the composed
 * argv and the composed wipe for every kind the table declares rather than for the one somebody
 * remembered to cover.
 */
export interface ServiceDefinition {
  readonly kind: ServiceKind;
  /** A stock image, pinned by tag. AD-11's build-it-locally rule binds the *executor* image. */
  readonly image: string;
  /** The port inside the container, published on loopback at the host port the pool allocates. */
  readonly internalPort: number;
  /** Writable paths the service needs, as tmpfs specifications: its data lives in memory only. */
  readonly tmpfsMounts: readonly string[];
  /** Environment the image needs to start. Asserted to hold no credential-shaped name. */
  readonly env: Readonly<Record<string, string>>;
  /** The command that answers "is this instance ready to serve". */
  readonly readiness: readonly string[];
  /** The command that removes every datum a feature could have written. */
  readonly wipe: readonly string[];
  /** The command whose output says what, if anything, survived the wipe. */
  readonly emptyProbe: readonly string[];
  /** True when the readiness command's output says the instance is serving. */
  readonly readyWhen: (stdout: string) => boolean;
  /** What the empty probe found, as one line per surviving thing. Empty means empty. */
  readonly residueOf: (stdout: string) => readonly string[];
}

/** The integer a probe printed, or `null` when it printed something else. */
const firstInteger = (stdout: string): number | null => {
  const parsed = /-?\d+/.exec(stdout.trim());
  if (parsed === null) return null;
  const value = Number.parseInt(parsed[0], 10);
  return Number.isNaN(value) ? null : value;
};

/**
 * A probe whose output could not be read is residue, not emptiness.
 *
 * `resource.return_dirty` is declared `escalate-to-human`, and handing an instance on because its
 * emptiness check was unreadable is exactly the leak the check exists to prevent. Unreadable fails
 * closed, the same direction AD-21 takes for redaction.
 */
const countedResidue = (stdout: string, noun: string): readonly string[] => {
  const count = firstInteger(stdout);
  if (count === null) {
    return [`the emptiness probe printed ${JSON.stringify(stdout.trim())}, which names no ${noun} count`];
  }
  return count === 0 ? [] : [`${String(count)} ${noun}(s) survived the wipe`];
};

/**
 * What redis's `INFO keyspace` section says survived, across every database rather than one.
 *
 * An empty instance prints the section header and no `dbN:` line, which is why the header is what marks
 * the output as readable: without it, the answer is a connection error or a truncated read, and an
 * unreadable answer has not established emptiness. Fails closed, like {@link countedResidue}.
 */
const keyspaceResidue = (stdout: string): readonly string[] => {
  if (!/#\s*keyspace/i.test(stdout)) {
    return [
      `the emptiness probe printed ${JSON.stringify(stdout.trim())}, which carries no keyspace section`,
    ];
  }
  const databases = [...stdout.matchAll(/^db(\d+):keys=(\d+)/gm)];
  const keys = databases.reduce((total, match) => total + Number.parseInt(match[2] ?? '0', 10), 0);
  if (keys === 0) return [];
  return [
    `${String(keys)} key(s) survived the wipe, across ${String(databases.length)} database(s): ` +
      databases.map((match) => `db${match[1] ?? '?'}`).join(', '),
  ];
};

/** The in-container user the postgres image's own tools expect. */
const POSTGRES_ROLE = 'orch';
const POSTGRES_DATABASE = 'orch';

/**
 * The service table.
 *
 * `POSTGRES_HOST_AUTH_METHOD=trust` rather than a password: a password would put a credential-shaped
 * name in a container's environment, which `flags.ts` refuses on principle and which would then have to
 * be excepted here. The instance is published on loopback only and its whole lifetime is one lease, so
 * the honest containment is the address it answers on rather than a secret both ends have to hold.
 */
export const SERVICE_DEFINITIONS: Readonly<Record<ServiceKind, ServiceDefinition>> = {
  postgres: {
    kind: 'postgres',
    image: 'postgres:17.2-alpine',
    internalPort: 5432,
    tmpfsMounts: [
      '/var/lib/postgresql/data:rw,nosuid,nodev,size=1g',
      '/var/run/postgresql:rw,nosuid,nodev,size=16m',
      '/tmp:rw,noexec,nosuid,nodev,size=64m',
    ],
    env: {
      POSTGRES_USER: POSTGRES_ROLE,
      POSTGRES_DB: POSTGRES_DATABASE,
      POSTGRES_HOST_AUTH_METHOD: 'trust',
      PGDATA: '/var/lib/postgresql/data/pgdata',
    },
    // No `-q`: with it, `pg_isready` prints nothing on success, and a readiness rule can then only be a
    // *negative* match on the empty string — which is true of every unreadable answer as well. The
    // positive phrase is the claim, the same shape redis's `/pong/i` has.
    readiness: ['pg_isready', '-U', POSTGRES_ROLE, '-d', POSTGRES_DATABASE],
    // Dropping and recreating the schema removes tables, sequences, views and types in one statement,
    // which a `TRUNCATE` sweep over the tables it happened to find does not. Every *other* non-system
    // schema goes with it: a feature may `CREATE SCHEMA`, and a wipe that only knew about `public` left
    // one feature's tables standing where the emptiness probe never looked.
    wipe: [
      'psql',
      '-U',
      POSTGRES_ROLE,
      '-d',
      POSTGRES_DATABASE,
      '-v',
      'ON_ERROR_STOP=1',
      '-c',
      "DO $$DECLARE s text; BEGIN FOR s IN SELECT nspname FROM pg_namespace WHERE nspname NOT IN " +
        "('pg_catalog','information_schema','pg_toast') AND nspname NOT LIKE 'pg\\_%' LOOP " +
        'EXECUTE format(\'DROP SCHEMA IF EXISTS %I CASCADE\', s); END LOOP; END$$',
      '-c',
      'CREATE SCHEMA public',
    ],
    // Counts everything a feature could have left anywhere in the cluster, summed to one integer:
    // relations in any non-system schema, extra schemas, extra databases and extra roles. `CREATE
    // DATABASE` and `CREATE ROLE` are cluster-wide and the wipe above cannot reach them, so they are
    // *reported* — an instance carrying one is quarantined for a person rather than handed on, which is
    // the fail-closed direction CAP-11 asks for.
    emptyProbe: [
      'psql',
      '-U',
      POSTGRES_ROLE,
      '-d',
      POSTGRES_DATABASE,
      '-At',
      '-c',
      'SELECT (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE ' +
        "n.nspname NOT IN ('pg_catalog','information_schema','pg_toast') AND n.nspname NOT LIKE 'pg\\_%') " +
        '+ (SELECT count(*) FROM pg_namespace WHERE nspname NOT IN ' +
        "('pg_catalog','information_schema','pg_toast','public') AND nspname NOT LIKE 'pg\\_%') " +
        `+ (SELECT count(*) FROM pg_database WHERE datname NOT IN ('postgres','template0','template1','${POSTGRES_DATABASE}')) ` +
        `+ (SELECT count(*) FROM pg_roles WHERE rolname <> '${POSTGRES_ROLE}' AND rolname NOT LIKE 'pg\\_%')`,
    ],
    readyWhen: (stdout: string): boolean => /accepting connections/i.test(stdout),
    residueOf: (stdout: string): readonly string[] => countedResidue(stdout, 'surviving object'),
  },
  redis: {
    kind: 'redis',
    image: 'redis:7.4-alpine',
    internalPort: 6379,
    tmpfsMounts: ['/data:rw,nosuid,nodev,size=512m', '/tmp:rw,noexec,nosuid,nodev,size=64m'],
    env: { REDIS_ARGS: '--save "" --appendonly no' },
    readiness: ['redis-cli', 'ping'],
    wipe: ['redis-cli', 'flushall'],
    // `info keyspace`, not `dbsize`: `flushall` clears all sixteen databases and `dbsize` reports only the
    // selected one, so the probe verified a sixteenth of what the wipe cleared. The keyspace section names
    // every database that holds a key, which is exactly the set the wipe is claiming to have emptied.
    emptyProbe: ['redis-cli', 'info', 'keyspace'],
    readyWhen: (stdout: string): boolean => /pong/i.test(stdout),
    residueOf: (stdout: string): readonly string[] => keyspaceResidue(stdout),
  },
};

export const serviceDefinition = (kind: ServiceKind): ServiceDefinition => SERVICE_DEFINITIONS[kind];

/**
 * Names whose *shape* is credential-like but which carry no secret, each with the argument for it.
 *
 * `flags.ts` refuses a credential-shaped environment name on principle, and that refusal is worth
 * keeping sharp rather than relaxing: the next credential this system meets will have a name nobody has
 * seen. An exception is therefore a named entry carrying its reason, not a loosened pattern — and the
 * suite asserts that every entry here is in fact shape-matched, so the table cannot quietly accumulate
 * names the guard never objected to.
 */
export const SERVICE_ENV_SHAPE_EXCEPTIONS: Readonly<Record<string, string>> = {
  POSTGRES_HOST_AUTH_METHOD:
    'it names an authentication *method*, and the method is "trust": the point of the value is that ' +
    'this instance has no password for anything to leak. The containment is the loopback publish and ' +
    'the one-lease lifetime, not a secret both ends would have to hold',
};

/** True when a name may reach a leased service's environment. */
export const isServiceEnvNamePermitted = (name: string): boolean =>
  !isCredentialEnvName(name) ||
  Object.prototype.hasOwnProperty.call(SERVICE_ENV_SHAPE_EXCEPTIONS, name);

/** The flags a service invocation must carry, asserted against the composed argv by the suite. */
export const SERVICE_REQUIRED_FLAGS = [
  '--detach',
  '--read-only',
  '--tmpfs',
  '--user',
  '--cap-drop',
  '--security-opt',
  '--memory',
  '--pids-limit',
  '--publish',
] as const;

export type ServiceFlag = (typeof SERVICE_REQUIRED_FLAGS)[number];

/**
 * The flags a service invocation may not carry.
 *
 * `flags.ts`'s list, minus the two that are about a *step's* exit code rather than about containment:
 * a detached service is required, not forbidden. `--volume` and `--mount` are added, because a leased
 * instance that bind-mounts a host path is an instance whose residue outlives its lease.
 */
export const FORBIDDEN_SERVICE_FLAG_REASONS: Readonly<Record<string, string>> = Object.freeze({
  ...Object.fromEntries(
    Object.entries(FORBIDDEN_RUN_FLAG_REASONS).filter(([flag]) => flag !== '-d' && flag !== '--detach'),
  ),
  '--volume':
    'a leased instance mounts nothing from the host: its data lives on a tmpfs so that "leaves no ' +
    'residue" is where the bytes are rather than something to remember',
  '--mount': 'a leased instance mounts nothing from the host; see --volume',
});

export const FORBIDDEN_SERVICE_FLAGS: readonly string[] = Object.keys(FORBIDDEN_SERVICE_FLAG_REASONS);

/** What a caller states when it wants an instance. Every flag below is derived from it. */
export interface ServiceStartRequest {
  readonly kind: ServiceKind;
  /** The run the lease belongs to, recorded as a label so a sweep can find the instance. */
  readonly run: string;
  /** The lease id, recorded as a label for the same reason. */
  readonly lease: string;
  readonly containerName: string;
  /** The loopback port the instance is published on, allocated by the pool. */
  readonly hostPort: number;
  readonly memoryLimit?: string;
  readonly pidsLimit?: number;
  readonly seccompProfile?: string;
  /**
   * How long the start invocation itself may take. The caller's declared bound, when it has one.
   *
   * Without it the invocation took the 30s control-plane default, which is shorter than a cold image pull
   * and longer than the caller's own bound — so a lease could both be killed mid-pull *and* spend 60s
   * inside a 30s bound. The lease passes its remaining bound here so the declared number covers the whole
   * acquire rather than only the readiness wait (CAP-11).
   */
  readonly timeoutMs?: number;
}

/**
 * One leased instance, as the pool records it durably.
 *
 * The container name is the handle every later operation uses, which is what makes the operations below
 * survive a restart: a pass that finds a lease record can wipe, probe and destroy the instance it names
 * without having been the process that started it.
 */
export interface ServiceInstance {
  readonly kind: ServiceKind;
  readonly containerName: string;
  readonly hostPort: number;
  readonly image: string;
}

/**
 * Compose the arguments after the `run` subcommand for a leased service.
 *
 * Same order discipline as `flags.ts`: identity and labels, then the hardening, then the network, then
 * the environment, then the image — and the image is the last element, which is what makes "no flag was
 * appended after it, where the runtime would hand it to the service instead" an assertable property.
 */
export const composeServiceRunArgs = (request: ServiceStartRequest): readonly string[] => {
  const definition = serviceDefinition(request.kind);
  const seccomp = request.seccompProfile ?? DEFAULT_SECCOMP_PROFILE;
  if (seccomp === REFUSED_SECCOMP_PROFILE) {
    throw new ForbiddenFlagError(
      `--security-opt seccomp=${REFUSED_SECCOMP_PROFILE}`,
      'AD-20 requires a seccomp profile, and "unconfined" is the absence of one',
    );
  }
  for (const name of Object.keys(definition.env)) {
    if (!isServiceEnvNamePermitted(name)) {
      throw new ForbiddenFlagError(
        `--env ${name}`,
        'a leased service is reached on loopback rather than by a secret, so a credential-shaped ' +
          'name in its environment is a secret this system would then have to keep out of a log. ' +
          'A name whose shape is misleading belongs in SERVICE_ENV_SHAPE_EXCEPTIONS with its argument',
      );
    }
  }

  const memory = request.memoryLimit ?? DEFAULT_SERVICE_MEMORY_LIMIT;
  const args: string[] = [
    '--name',
    request.containerName,
    '--label',
    `${SERVICE_LABEL_KEYS.run}=${request.run}`,
    '--label',
    `${SERVICE_LABEL_KEYS.lease}=${request.lease}`,
    '--label',
    `${SERVICE_LABEL_KEYS.resource}=${request.kind}`,
    '--label',
    `${SERVICE_LABEL_KEYS.pool}=1`,
    // A service outlives the invocation that starts it; see this file's header.
    '--detach',
    '--init',
    '--read-only',
    ...definition.tmpfsMounts.flatMap((mount) => ['--tmpfs', mount]),
    '--user',
    SERVICE_USER,
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    '--security-opt',
    `seccomp=${seccomp}`,
    '--memory',
    memory,
    '--memory-swap',
    memory,
    '--pids-limit',
    String(request.pidsLimit ?? DEFAULT_SERVICE_PIDS_LIMIT),
    '--publish',
    `${SERVICE_PUBLISH_ADDRESS}:${String(request.hostPort)}:${String(definition.internalPort)}`,
    ...Object.entries(definition.env).flatMap(([name, value]) => ['--env', `${name}=${value}`]),
    definition.image,
  ];

  const runtimeFlags = args.slice(0, args.indexOf(definition.image));
  // `firstForbiddenFlag`, not a local `includes` loop. The loop that stood here repeated `flags.ts`'s own
  // `=`-form blind spot on a table derived from the same source: `--cap-add=SYS_ADMIN` passed it, and
  // every value-bearing entry it inherited (`--pid=host`, `--network=host`) could never fire at all,
  // because no argv contains that joined string as one token unless somebody wrote it that way. One
  // matcher over both tables is one place the spelling can be forgotten.
  const forbidden = firstForbiddenFlag(runtimeFlags, FORBIDDEN_SERVICE_FLAG_REASONS);
  if (forbidden !== null) throw new ForbiddenFlagError(forbidden.flag, forbidden.reason);
  return args;
};

/** Which of {@link SERVICE_REQUIRED_FLAGS} an argv is missing. Empty means the flag set holds. */
export const missingServiceFlags = (argv: readonly string[]): readonly ServiceFlag[] =>
  SERVICE_REQUIRED_FLAGS.filter((flag) => !argv.includes(flag));

/** The arguments after the `exec` subcommand: the instance, then the command to run inside it. */
export const composeServiceExecArgs = (
  instance: ServiceInstance,
  command: readonly string[],
): readonly string[] => {
  if (command.length === 0) {
    throw new ForbiddenFlagError(
      'exec',
      'an empty command inside a leased instance is a no-op that would report success',
    );
  }
  return [instance.containerName, ...command];
};

/** A container operation on a leased instance failed. The pool reports it; it never retries blindly. */
export class ServiceOperationError extends Error {
  readonly code = 'container.start_failed';
  readonly orchError: OrchError;

  constructor(operation: string, instanceName: string, detail: string) {
    const message = `The ${operation} of leased instance ${instanceName} failed: ${detail}`;
    super(message);
    this.name = 'ServiceOperationError';
    this.orchError = makeError(this.code, message, detail);
  }
}

/** What one operation on an instance reported. A negative answer is data, never an exception. */
export interface ServiceOperationResult {
  readonly ok: boolean;
  readonly detail: string;
}

export interface ServiceResidueResult extends ServiceOperationResult {
  /** One line per thing that survived the wipe. Empty is the only clean answer. */
  readonly residue: readonly string[];
}

/**
 * Every container operation a lease performs, as one port.
 *
 * `src/pool/` holds this type and nothing more: it starts, waits, wipes, verifies and destroys through
 * these five functions and never learns that a container was involved. The implementation below is the
 * only one that talks to a runtime, and a test double is the only other thing that satisfies it — which
 * is what makes the pool's time bound, its dirty refusal and its isolation assertable on a machine with
 * no daemon.
 */
export interface ServiceOperator {
  readonly start: (request: ServiceStartRequest) => ServiceStartOutcome;
  /**
   * Whether the container an instance names is still there at all.
   *
   * Separate from `ready` because the two answers have different remedies. A container that exists and is
   * not yet serving is worth waiting for, up to the declared bound. A container that is *gone* — the state
   * after a reboot, since the pool's records are durable and containers are not — will never become ready,
   * and polling it for the full bound instead of starting a fresh instance is a lease that fails for no
   * reason.
   */
  readonly exists: (instance: ServiceInstance) => ServiceOperationResult;
  readonly ready: (instance: ServiceInstance) => ServiceOperationResult;
  readonly wipe: (instance: ServiceInstance) => ServiceOperationResult;
  readonly residue: (instance: ServiceInstance) => ServiceResidueResult;
  readonly destroy: (instance: ServiceInstance) => ServiceOperationResult;
  /**
   * Every pooled container the runtime holds, found by label rather than by a durable record.
   *
   * This is what {@link SERVICE_LABEL_KEYS} is *for*, and until now nothing swept by it: a pass could only
   * see containers its own records named, so a container whose record was lost was reclaimable by nothing —
   * the exact invisible leak AD-32 exists to prevent. The sweep keys on `orch.pool` alone, deliberately:
   * a warm instance leased a second time is never restarted, so its `orch.run` and `orch.lease` labels
   * still name the *first* lease and are not safe to act on. `orch.pool` stays true for the container's
   * whole life.
   */
  readonly sweep: () => ServiceSweepResult;
}

/** One pooled container a label sweep found, with what its labels could say about it. */
export interface SweptInstance {
  readonly containerName: string;
  /** The kind its `orch.resource` label names, or `null` when the label is missing or unrecognised. */
  readonly kind: ServiceKind | null;
  readonly image: string;
}

export interface ServiceSweepResult extends ServiceOperationResult {
  readonly instances: readonly SweptInstance[];
}

export interface ServiceStartOutcome extends ServiceOperationResult {
  readonly instance: ServiceInstance;
  /** The complete argv the invocation carried, so a suite can assert it without a daemon. */
  readonly argv: readonly string[];
}

/** The instance a start request describes, whether or not the start succeeded. */
export const instanceFor = (request: ServiceStartRequest): ServiceInstance => ({
  kind: request.kind,
  containerName: request.containerName,
  hostPort: request.hostPort,
  image: serviceDefinition(request.kind).image,
});

/** The real operator: five invocations, no shell, every flag composed above. */
export const createServiceOperator = (invoke: ContainerInvoker): ServiceOperator => {
  const exec = (instance: ServiceInstance, command: readonly string[]): ServiceOperationResult => {
    const result = invoke({
      subcommand: CONTAINER_SUBCOMMANDS.exec,
      args: composeServiceExecArgs(instance, command),
      timeoutMs: CONTAINER_CONTROL_TIMEOUT_MS,
    });
    const detail = (result.stderr.trim() === '' ? result.stdout : result.stderr).trim();
    return { ok: result.status === 0, detail: detail === '' ? result.stdout.trim() : detail };
  };

  return {
    start: (request: ServiceStartRequest): ServiceStartOutcome => {
      const args = composeServiceRunArgs(request);
      const result = invoke({
        subcommand: CONTAINER_SUBCOMMANDS.run,
        args,
        // The caller's bound when it declared one; otherwise a ceiling generous enough for a cold image
        // pull, because the 30s control-plane default killed one and reported it as a lease timeout.
        timeoutMs: request.timeoutMs ?? SERVICE_START_TIMEOUT_MS,
      });
      return {
        ok: result.status === 0,
        detail: result.status === 0 ? result.stdout.trim() : (result.stderr.trim() || result.stdout.trim()),
        instance: instanceFor(request),
        argv: result.argv,
      };
    },
    exists: (instance: ServiceInstance): ServiceOperationResult => {
      const result = invoke({
        subcommand: CONTAINER_SUBCOMMANDS.inspectContainer,
        args: ['--format', '{{.State.Status}}', instance.containerName],
        timeoutMs: CONTAINER_CONTROL_TIMEOUT_MS,
      });
      const detail = (result.stdout.trim() === '' ? result.stderr : result.stdout).trim();
      return { ok: result.status === 0, detail: detail === '' ? 'no such container' : detail };
    },
    ready: (instance: ServiceInstance): ServiceOperationResult => {
      const definition = serviceDefinition(instance.kind);
      const result = invoke({
        subcommand: CONTAINER_SUBCOMMANDS.exec,
        args: composeServiceExecArgs(instance, definition.readiness),
        timeoutMs: CONTAINER_CONTROL_TIMEOUT_MS,
      });
      const output = `${result.stdout}\n${result.stderr}`;
      return {
        ok: result.status === 0 && definition.readyWhen(output),
        detail: output.trim(),
      };
    },
    wipe: (instance: ServiceInstance): ServiceOperationResult =>
      exec(instance, serviceDefinition(instance.kind).wipe),
    residue: (instance: ServiceInstance): ServiceResidueResult => {
      const definition = serviceDefinition(instance.kind);
      const result = invoke({
        subcommand: CONTAINER_SUBCOMMANDS.exec,
        args: composeServiceExecArgs(instance, definition.emptyProbe),
        timeoutMs: CONTAINER_CONTROL_TIMEOUT_MS,
      });
      if (result.status !== 0) {
        const detail = (result.stderr.trim() === '' ? result.stdout : result.stderr).trim();
        // A probe that could not run has not established emptiness. Fails closed.
        return { ok: false, residue: [`the emptiness probe failed: ${detail}`], detail };
      }
      const residue = definition.residueOf(result.stdout);
      return { ok: residue.length === 0, residue, detail: result.stdout.trim() };
    },
    destroy: (instance: ServiceInstance): ServiceOperationResult => {
      const stopped = invoke({
        subcommand: CONTAINER_SUBCOMMANDS.stop,
        args: ['--timeout', '5', instance.containerName],
      });
      const removed = invoke({
        subcommand: CONTAINER_SUBCOMMANDS.remove,
        // `--force` because the `stop` above can legitimately fail: a process that ignores SIGTERM and
        // outlives the grace period leaves the container *running*, and a plain `rm` refuses a running
        // container — so the instance would then be destroyed by nothing at all, on this pass or any
        // later one. AD-32 makes the pass the only thing that removes a container, so the pass has to be
        // able to.
        args: ['--force', '--volumes', instance.containerName],
      });
      const detail = (removed.stderr.trim() === '' ? removed.stdout : removed.stderr).trim();
      if (removed.status === 0) return { ok: true, detail: detail === '' ? 'removed' : detail };
      // Already gone is the outcome the caller wanted, reached by another route.
      if (/no such container/i.test(detail)) return { ok: true, detail: 'the instance was already gone' };
      return { ok: false, detail: `${detail} (stop reported ${String(stopped.status)})` };
    },
    sweep: (): ServiceSweepResult => {
      const result = invoke({
        subcommand: CONTAINER_SUBCOMMANDS.list,
        args: [
          '--all',
          '--filter',
          `label=${SERVICE_LABEL_KEYS.pool}=1`,
          '--format',
          `{{.Names}}\t{{.Label "${SERVICE_LABEL_KEYS.resource}"}}\t{{.Image}}`,
        ],
        timeoutMs: CONTAINER_CONTROL_TIMEOUT_MS,
      });
      if (result.status !== 0) {
        const detail = (result.stderr.trim() === '' ? result.stdout : result.stderr).trim();
        // A sweep that could not run has established nothing. It must never read as "no containers".
        return { ok: false, instances: [], detail };
      }
      const instances = result.stdout
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line !== '')
        .map((line): SweptInstance => {
          const [name = '', resource = '', image = ''] = line.split('\t');
          return {
            containerName: name,
            kind: (SERVICE_KINDS as readonly string[]).includes(resource) ? (resource as ServiceKind) : null,
            image,
          };
        })
        .filter((instance) => instance.containerName !== '');
      return {
        ok: true,
        instances,
        detail: `${String(instances.length)} pooled container(s) carry ${SERVICE_LABEL_KEYS.pool}=1`,
      };
    },
  };
};
