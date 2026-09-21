/**
 * The third AD-31 suite: containment, proved against a real container runtime.
 *
 * AD-31 names three suites as the floor before any unattended run — contract round-trips, reconciler
 * crash injection, and this one: "the container wrapper has an assertion test proving no push credential
 * and no docker socket are reachable from inside". It is half the stage-1 gate, and the only one of the
 * three whose subject is a security property rather than a correctness one.
 *
 * It needs a daemon, and a daemon is not always there. **It must never pass when it did not run.** So:
 *
 * 1. reachability is probed once, at import time;
 * 2. if nothing answers, every assertion here is skipped and the suite's own name carries
 *    {@link CONTAINMENT_SKIP_MARKER}, so the skip is visible in the output rather than a blank line;
 * 3. either way a marker is written to `ORCH_HOME/gates/container-assertion.json` saying exactly what
 *    happened, and `verified` is written *only* after every named check has passed;
 * 4. `tests/container.gate.test.ts` always runs and makes the containment claim undeclarable while that
 *    marker says anything other than `verified` for the current Dockerfile.
 *
 * `npm test` may therefore be green on a machine with no runtime. The stage-1 gate may not be declared
 * met on one — `assertContainmentVerified()` throws — and that difference is the whole design.
 *
 * One container, one read. Everything AD-20 claims about the inside is asserted from a single probe run,
 * because a suite that starts six containers is a suite that takes a minute per assertion and gets
 * quietly disabled.
 */
import { chmodSync, mkdirSync, rmSync } from 'node:fs';
import { isAbsolute, relative, sep } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  CONTAINER_BUILD_TIMEOUT_MS,
  CONTAINER_SUBCOMMANDS,
  CONTAINMENT_SKIP_MARKER,
  DEFAULT_MEMORY_LIMIT,
  DEFAULT_PIDS_LIMIT,
  EXECUTOR_UID,
  IMAGE_CLI_PATH,
  REQUIRED_CONTAINMENT_CHECKS,
  RUNTIME_SOCKET_PATHS,
  composeRunArgs,
  containerNameFor,
  createContainerInvoker,
  createImageResolver,
  currentDockerfileHash,
  ensureSessionDir,
  isCredentialEnvName,
  memoryLimitBytes,
  probeContainerRuntime,
  readContainmentMarker,
  recordContainmentMarker,
  removeContainerIfTerminal,
  sessionDirFor,
} from '../src/container/index.js';
import type { ContainerInvoker } from '../src/container/index.js';
import { resolveOrchHome, runPaths, worktreeDir } from '../src/runtime/index.js';

/** Probed once, at import time, so the decision to skip is made before any test is collected. */
const runtime = probeContainerRuntime();

/**
 * The checks that must all have passed before the marker may say `verified`.
 *
 * Imported rather than re-listed: the verifier in `src/container/lifecycle.ts` now refuses a marker
 * that names fewer than all of them, so a second copy here could drift and the gate would accept a
 * proof of less than it claims.
 */
const REQUIRED_CHECKS = REQUIRED_CONTAINMENT_CHECKS;

const passed = new Set<string>();

const RUN_ID = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const SUITE = 'tests/container.assertion.test.ts';

const suiteName = runtime.reachable
  ? 'AD-31 — containment, against a real container runtime'
  : `AD-31 — containment, against a real container runtime [${CONTAINMENT_SKIP_MARKER}: ${runtime.detail}]`;

/**
 * The two directories the probe container mounts.
 *
 * Under `ORCH_HOME`, at the paths AD-9 gives a run's worktree and session directory, because
 * `composeRunArgs` now refuses an allow-list that is not rooted there — the probe is given the same shape
 * a real run has, with nothing of the host in it, and a temp directory somewhere else would have been a
 * shape no run can have. Removed again in `afterAll`.
 */
const probeWorktree = worktreeDir(RUN_ID);
const probeSession = sessionDirFor(RUN_ID);
mkdirSync(probeWorktree, { recursive: true });
ensureSessionDir(probeSession);
// Writable by any uid, because the container runs as 10001 and these directories are created by whoever
// runs the suite. That ownership question is real for a production run too — a bind-mounted worktree
// owned by the host user is not writable by the executor uid on Linux — and it belongs to story 1-6,
// which creates worktrees. Here it is settled locally so the assertion below tests the *mount* (the
// worktree is not read-only) rather than the host's uid map.
chmodSync(probeWorktree, 0o777);
chmodSync(probeSession, 0o777);

// Written at import time on the skip path: a suite whose every test is skipped runs no hook, and the
// marker is the only thing that keeps the skip from reading as a pass.
if (!runtime.reachable) {
  recordContainmentMarker({
    state: 'skipped',
    at: new Date().toISOString(),
    reason: runtime.detail,
    dockerfileHash: currentDockerfileHash(),
    imageTag: null,
    runtimeVersion: runtime.clientVersion,
    checks: [],
    suite: SUITE,
  });
}

/**
 * The host's own `HOME`, passed *into* the probe.
 *
 * The `no-host-home` check used to assert that the probe's output did not contain `${hostHome}/.` while
 * the probe only ever stat-ed paths inside the container — so it could not fail for the reason it names.
 * The container has to be asked about the host's path by name for the answer to mean anything.
 */
const hostHome = process.env['HOME'] ?? '';

/** The probe script: `key=value` lines, read back by the assertions below. */
const PROBE_SCRIPT = [
  'set -u',
  'echo "uid=$(id -u)"',
  'echo "gid=$(id -g)"',
  // `id -un`, not only `id -u`. A uid with no passwd entry ships as fully "verified" otherwise: every
  // observation below is identical, while `id -un` fails and git has no identity inside any tier-2 step.
  'echo "uname=$(id -un 2>/dev/null || echo NO_PASSWD_ENTRY)"',
  'echo "home_env=$HOME"',
  // The substitution the whole wrapper design rests on: the image's own CLI at the absolute path
  // `wrapper.ts` composes. Asserted by *running* it, because comparing the argv to the same constant the
  // argv was built from proves only that the constant exists.
  `if [ -x ${IMAGE_CLI_PATH} ]; then echo "cli_executable=yes"; else echo "cli_executable=no"; fi`,
  `echo "cli_version=$(${IMAGE_CLI_PATH} --version 2>&1 | head -1)"`,
  // The limits, read back from inside rather than trusted because the flag was composed. cgroup v2
  // first, then v1, because a limit nobody can read is a limit nobody has checked.
  'echo "memory_max=$(cat /sys/fs/cgroup/memory.max 2>/dev/null || cat /sys/fs/cgroup/memory/memory.limit_in_bytes 2>/dev/null || echo unknown)"',
  'echo "pids_max=$(cat /sys/fs/cgroup/pids.max 2>/dev/null || cat /sys/fs/cgroup/pids/pids.max 2>/dev/null || echo unknown)"',
  // `--network none` from the inside: a name that does not resolve and a connection that does not open.
  'if getent hosts example.com >/dev/null 2>&1; then echo "dns=resolved"; else echo "dns=failed"; fi',
  'node -e \'const s=require("net").connect(80,"93.184.216.34");s.setTimeout(3000);' +
    's.on("error",()=>{console.log("egress=error");process.exit(0)});' +
    's.on("timeout",()=>{console.log("egress=timeout");process.exit(0)});' +
    's.on("connect",()=>{console.log("egress=connected");process.exit(0)})\'',
  // A credential by the shape of its *value*, not of its name — so the prover and the filter can
  // disagree. Asserting with the same predicate that does the filtering only proves the pair agrees.
  'if env | grep -Eq "(ghp_|gho_|ghs_|github_pat_|sk-ant-|sk-[A-Za-z0-9]{20}|AKIA[0-9A-Z]{16}|-----BEGIN )"; then echo "credvalue=yes"; else echo "credvalue=no"; fi',
  'if touch /orch-probe-write 2>/dev/null; then echo "root_writable=yes"; else echo "root_writable=no"; fi',
  'echo "caps=$(awk \'/^CapEff/ {print $2}\' /proc/self/status)"',
  'echo "cap_bnd=$(awk \'/^CapBnd/ {print $2}\' /proc/self/status)"',
  'echo "nnp=$(awk \'/^NoNewPrivs/ {print $2}\' /proc/self/status)"',
  'echo "seccomp=$(awk \'/^Seccomp:/ {print $2}\' /proc/self/status)"',
  ...RUNTIME_SOCKET_PATHS.map((path) => `if [ -e "${path}" ]; then echo "socket=${path}"; fi`),
  'for p in "$HOME/.ssh" "$HOME/.aws" "$HOME/.netrc" "$HOME/.git-credentials" "$HOME/.gitconfig" "$HOME/.config/gh" "$HOME/.docker"; do',
  '  if [ -e "$p" ]; then echo "credpath=$p"; fi',
  'done',
  'echo "env_names=$(env | cut -d= -f1 | sort | tr "\\n" " ")"',
  // The host's HOME, asked of the container by its real path. It can *exist* without being a leak: the
  // worktree and the session directory are mounted at their own absolute paths and AD-9's default
  // ORCH_HOME is `~/.orch`, so the runtime creates the empty path chain that leads to each mount. What
  // may never exist is any of the host's content under it — which is the thing a mounted HOME would
  // bring, and the thing the old form could not have detected.
  ...(hostHome === ''
    ? []
    : [
        `for p in "${hostHome}/.ssh" "${hostHome}/.aws" "${hostHome}/.gitconfig" ` +
          `"${hostHome}/.git-credentials" "${hostHome}/.netrc" "${hostHome}/.claude" ` +
          `"${hostHome}/.npmrc" "${hostHome}/.docker" "${hostHome}/.config" "${hostHome}/Library"; do`,
        '  if [ -e "$p" ]; then echo "hostcredpath=$p"; fi',
        'done',
        `echo "hosthome_entries=$(ls -A "${hostHome}" 2>/dev/null | tr "\\n" " ")"`,
      ]),
  'echo "workdir=$(pwd)"',
  'if [ -w . ]; then echo "worktree_writable=yes"; else echo "worktree_writable=no"; fi',
  'echo "done=1"',
].join('\n');

interface Probe {
  readonly lines: readonly string[];
  readonly value: (key: string) => string | undefined;
  readonly all: (key: string) => readonly string[];
  readonly status: number | null;
  readonly stderr: string;
}

let probe: Probe | null = null;
let imageTag: string | null = null;
let invoke: ContainerInvoker | null = null;
let containerName: string | null = null;

describe.skipIf(!runtime.reachable)(suiteName, () => {
  beforeAll(() => {
    invoke = createContainerInvoker();
    imageTag = createImageResolver({ invoke }).resolve().tag;
    containerName = containerNameFor(RUN_ID, 'ad31probe', 1);

    const args = composeRunArgs({
      image: imageTag,
      run: RUN_ID,
      step: 'ad31probe',
      attempt: 1,
      containerName,
      worktree: probeWorktree,
      sessionDir: probeSession,
      command: '/bin/sh',
      commandArgs: ['-c', PROBE_SCRIPT],
      phase: 'execution',
    });
    const result = invoke({ subcommand: CONTAINER_SUBCOMMANDS.run, args, timeoutMs: 120_000 });
    const lines = result.stdout.split('\n').map((line) => line.trim());
    probe = {
      lines,
      status: result.status,
      stderr: result.stderr,
      value: (key: string): string | undefined =>
        lines.find((line) => line.startsWith(`${key}=`))?.slice(key.length + 1),
      all: (key: string): readonly string[] =>
        lines.filter((line) => line.startsWith(`${key}=`)).map((line) => line.slice(key.length + 1)),
    };
  }, CONTAINER_BUILD_TIMEOUT_MS);

  afterAll(() => {
    const everyCheck = REQUIRED_CHECKS.every((check) => passed.has(check));
    recordContainmentMarker({
      state: everyCheck ? 'verified' : 'failed',
      at: new Date().toISOString(),
      reason: everyCheck
        ? 'every containment property was asserted from inside a running tier-2 container'
        : `only these checks passed: ${[...passed].join(', ') || '(none)'}`,
      dockerfileHash: currentDockerfileHash(),
      imageTag,
      runtimeVersion: runtime.serverVersion,
      checks: [...passed],
      suite: SUITE,
    });
    if (invoke !== null && containerName !== null) {
      // The probe's run is over, so its container is at a terminal disposition and is reclaimed
      // through the same path a real run's is — never with `--rm` (AD-20).
      removeContainerIfTerminal(containerName, 'committed', invoke);
    }
    // The two directories go too. They live under ORCH_HOME at a real run's paths, and a suite that
    // leaves them behind leaves a machine holding a worktree and a transcript for a run that never was.
    rmSync(probeWorktree, { recursive: true, force: true });
    rmSync(runPaths(RUN_ID).runDir, { recursive: true, force: true });
  });

  it('ran the probe at all', () => {
    expect(probe?.stderr ?? '').not.toMatch(/cannot connect|permission denied/i);
    expect(probe?.value('done')).toBe('1');
    expect(probe?.status).toBe(0);
  });

  it('runs the CLI the wrapper substitutes, at the absolute path it substitutes it at', () => {
    // The wrapper drops the host's interpreter and runs `IMAGE_CLI_PATH` with story 1-4's argv. Until
    // now that path was only ever compared to the constant it was built from, and the one suite that
    // starts a real container ran `/bin/sh` — so the substitution the whole design rests on was verified
    // nowhere. Here the image is asked to execute it.
    expect(probe?.value('cli_executable')).toBe('yes');
    expect(probe?.value('cli_version') ?? '').toMatch(/\d+\.\d+\.\d+/);
  });

  it('has no general network, and the limits the argv asked for', () => {
    // `--network none` from the inside rather than from the argv: a name that does not resolve and a
    // connection that does not open. And the limits read back out of the cgroup, because a flag composed
    // is not a limit imposed — `--memory 0` is the same argv shape with no limit at all.
    expect(probe?.value('dns')).toBe('failed');
    expect(probe?.value('egress')).not.toBe('connected');
    expect(probe?.value('memory_max')).toBe(String(memoryLimitBytes(DEFAULT_MEMORY_LIMIT)));
    expect(probe?.value('pids_max')).toBe(String(DEFAULT_PIDS_LIMIT));
  });

  it('reaches no push credential from inside', () => {
    // Two halves: no credential-shaped environment variable, and no credential file on disk.
    const names = (probe?.value('env_names') ?? '').split(/\s+/).filter((name) => name !== '');
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) expect(isCredentialEnvName(name), name).toBe(false);
    expect(probe?.all('credpath') ?? []).toStrictEqual([]);
    // And by the shape of the *values*, which is a different question from the shape of the names: the
    // filter and the prover can now disagree, where asserting with `isCredentialEnvName` alone only
    // proved the one predicate agrees with itself.
    expect(probe?.value('credvalue')).toBe('no');
    passed.add('no-push-credential');
  });

  it('reaches no container runtime socket from inside', () => {
    // The highest-value escape path in the threat model, asserted by looking for every conventional
    // location from inside the container rather than by trusting that the mount list omitted them.
    expect(probe?.all('socket') ?? []).toStrictEqual([]);
    passed.add('no-runtime-socket');
  });

  it('has a read-only root filesystem, with the worktree the one writable place', () => {
    expect(probe?.value('root_writable')).toBe('no');
    expect(probe?.value('worktree_writable')).toBe('yes');
    passed.add('read-only-root');
  });

  it('is not root, and is a uid the image actually has a passwd entry for', () => {
    expect(probe?.value('uid')).not.toBe('0');
    expect(probe?.value('gid')).not.toBe('0');
    // The exact uid `flags.ts` passes to `--user`, so a Dockerfile that drifted from the constant is
    // caught here rather than at the first `git` a step runs.
    expect(probe?.value('uid')).toBe(String(EXECUTOR_UID));
    // And the uid resolves to a name. A uid with no passwd entry passed every other assertion in this
    // file unchanged — `id -u` is the same number, the root is as read-only, the capabilities are as
    // dropped — while `id -un` fails, `$HOME` belongs to nobody, and git has no identity to work from.
    const name = probe?.value('uname') ?? '';
    expect(name).not.toBe('NO_PASSWD_ENTRY');
    expect(name).not.toBe('');
    expect(name).not.toMatch(/^\d+$/);
    passed.add('non-root-user');
  });

  it('has every capability dropped, cannot regain one, and is confined by seccomp', () => {
    expect(probe?.value('caps')).toMatch(/^0+$/);
    expect(probe?.value('cap_bnd')).toMatch(/^0+$/);
    expect(probe?.value('nnp')).toBe('1');
    // 2 is SECCOMP_MODE_FILTER. 0 would mean no profile is in force at all.
    expect(probe?.value('seccomp')).toBe('2');
    passed.add('capabilities-dropped');
  });

  it('cannot see the host home directory', () => {
    expect(hostHome).not.toBe('');
    expect(probe?.value('workdir')).toBe(probeWorktree);
    // The host's path, asked of the container by name. The old form asserted that the probe's own output
    // did not mention `${hostHome}/.` while the probe only ever stat-ed paths *inside* the container, so
    // it could not fail for the reason it names.
    expect(probe?.all('hostcredpath') ?? []).toStrictEqual([]);
    // And nothing of the host's under it at all: the only entries permitted are the empty directories the
    // runtime had to create to place the two mounts, since AD-9's default ORCH_HOME is inside HOME.
    const permitted = new Set<string>();
    for (const mount of [probeWorktree, probeSession]) {
      const rel = relative(hostHome, mount);
      if (rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)) {
        const first = rel.split(sep)[0];
        if (first !== undefined) permitted.add(first);
      }
    }
    const entries = (probe?.value('hosthome_entries') ?? '').split(/\s+/).filter((one) => one !== '');
    for (const entry of entries) expect(permitted, entry).toContain(entry);
    // And the container's own HOME is the tmpfs one, not a path of the host's.
    expect(probe?.value('home_env')).not.toBe(hostHome);
    // The original form of this assertion, kept and made able to fail. It reads every line of the probe's
    // output for a dotted path under the host's HOME — the shape a mounted `~/.ssh` or `~/.claude` would
    // take. The one exception is ORCH_HOME itself: AD-9's default is `~/.orch`, so the run worktree and
    // the session transcript legitimately have the host home as a path prefix, and refusing that would
    // refuse the layout AD-9 defines rather than a leak.
    const dottedHomePaths = (probe?.lines ?? []).filter(
      (line) => line.includes(`${hostHome}/.`) && !line.includes(resolveOrchHome()),
    );
    expect(dottedHomePaths).toStrictEqual([]);
    passed.add('no-host-home');
  });
});

describe('the record this suite leaves behind', () => {
  it('says what happened, whichever state this machine is in', () => {
    // Always runs. Without it, a machine with no runtime would produce a file of skipped tests and no
    // trace anywhere that AD-31's third suite had not run.
    const marker = readContainmentMarker();
    expect(marker).not.toBeNull();
    expect(marker?.suite).toBe(SUITE);
    if (runtime.reachable) {
      expect(['verified', 'failed']).toContain(marker?.state);
    } else {
      expect(marker?.state).toBe('skipped');
      expect(marker?.reason).toBe(runtime.detail);
      expect(marker?.checks).toStrictEqual([]);
    }
  });
});
