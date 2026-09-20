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
import { chmodSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  CONTAINER_BUILD_TIMEOUT_MS,
  CONTAINER_SUBCOMMANDS,
  CONTAINMENT_SKIP_MARKER,
  REQUIRED_CONTAINMENT_CHECKS,
  RUNTIME_SOCKET_PATHS,
  composeRunArgs,
  containerNameFor,
  createContainerInvoker,
  createImageResolver,
  currentDockerfileHash,
  isCredentialEnvName,
  probeContainerRuntime,
  readContainmentMarker,
  recordContainmentMarker,
  removeContainerIfTerminal,
} from '../src/container/index.js';
import type { ContainerInvoker } from '../src/container/index.js';

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
 * Real directories, because `composeRunArgs` refuses any mount outside the allow-list and the allow-list
 * is exactly these two — the probe is given the same shape a run has, with nothing of the host in it.
 */
const probeRoot = mkdtempSync(join(tmpdir(), 'orch-ad31-'));
const probeWorktree = join(probeRoot, 'worktree');
const probeSession = join(probeRoot, 'session');
mkdirSync(probeWorktree, { recursive: true });
mkdirSync(probeSession, { recursive: true });
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

/** The probe script: `key=value` lines, read back by the assertions below. */
const PROBE_SCRIPT = [
  'set -u',
  'echo "uid=$(id -u)"',
  'echo "gid=$(id -g)"',
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
  });

  it('ran the probe at all', () => {
    expect(probe?.stderr ?? '').not.toMatch(/cannot connect|permission denied/i);
    expect(probe?.value('done')).toBe('1');
    expect(probe?.status).toBe(0);
  });

  it('reaches no push credential from inside', () => {
    // Two halves: no credential-shaped environment variable, and no credential file on disk.
    const names = (probe?.value('env_names') ?? '').split(/\s+/).filter((name) => name !== '');
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) expect(isCredentialEnvName(name), name).toBe(false);
    expect(probe?.all('credpath') ?? []).toStrictEqual([]);
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

  it('is not root', () => {
    expect(probe?.value('uid')).not.toBe('0');
    expect(probe?.value('gid')).not.toBe('0');
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
    const home = process.env['HOME'] ?? '';
    expect(home).not.toBe('');
    expect(probe?.value('workdir')).toBe(probeWorktree);
    expect(probe?.lines.join('\n')).not.toContain(`${home}/.`);
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
