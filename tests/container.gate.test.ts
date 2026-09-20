/**
 * The gate. This file always runs, and it is what makes a skipped security test unable to read as a pass.
 *
 * Five times in this project a green suite has hidden a deleted guard. Here that failure mode would be a
 * security property rather than a correctness one: AD-31 requires the container assertion suite to have
 * proved, against a real runtime, that no push credential and no runtime socket is reachable from inside
 * a tier-2 container, and on a machine with no daemon that suite skips. So this file asserts the claim
 * *about* the claim:
 *
 * - `assertContainmentVerified()` refuses unless the marker says `verified`, its Dockerfile digest still
 *   matches, and a runtime answers now — each of the three driven here against a temp `ORCH_HOME`;
 * - the assertion suite still records what it did and still names its skip visibly, read out of its
 *   source, so removing the visibility is itself a failing test;
 * - on this machine, right now, the live gate is reported: with no runtime the containment claim is
 *   undeclarable, and that is asserted rather than assumed.
 *
 * `npm test` may be green while the stage-1 gate is not declarable. That is the honest state of a machine
 * whose daemon does not answer, and it is the state this file exists to keep visible.
 */
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import {
  CONTAINMENT_SKIP_MARKER,
  ContainmentUnverifiedError,
  REQUIRED_CONTAINMENT_CHECKS,
  assertContainmentVerified,
  containmentMarkerPath,
  containmentVerification,
  currentDockerfileHash,
  probeContainerRuntime,
  readContainmentMarker,
  recordContainmentMarker,
} from '../src/container/index.js';
import type { ContainerInvocation, ContainerResult, ContainmentMarker } from '../src/container/index.js';

const SUITE_PATH = fileURLToPath(new URL('./container.assertion.test.ts', import.meta.url));

/** A fake runtime that answers, so the "a daemon is up" half of the gate can be driven anywhere. */
const answeringRuntime = (invocation: ContainerInvocation): ContainerResult => ({
  status: 0,
  stdout: invocation.subcommand[0] === 'info' ? '29.7.2\n' : '29.7.2\n',
  stderr: '',
  argv: ['<runtime>', ...invocation.subcommand, ...invocation.args],
});

/** A fake runtime whose binary is there and whose daemon is not — this machine's actual state. */
const silentDaemon = (invocation: ContainerInvocation): ContainerResult =>
  invocation.subcommand[0] === 'version'
    ? { status: 0, stdout: '29.7.2\n', stderr: '', argv: ['<runtime>', ...invocation.subcommand] }
    : {
        status: 1,
        stdout: '',
        stderr: 'Cannot connect to the container runtime daemon. Is it running?',
        argv: ['<runtime>', ...invocation.subcommand],
      };

const temps: string[] = [];

/** A temp `ORCH_HOME`, so the gate's own state is driven without touching the machine's. */
const tempHome = (): NodeJS.ProcessEnv => {
  const home = mkdtempSync(join(tmpdir(), 'orch-gate-'));
  temps.push(home);
  return { ORCH_HOME: home };
};

const marker = (overrides: Partial<ContainmentMarker> = {}): ContainmentMarker => ({
  state: 'verified',
  at: '2026-09-20T00:00:00.000Z',
  reason: 'every containment property was asserted',
  dockerfileHash: currentDockerfileHash(),
  imageTag: 'orch-executor:0123456789abcdef',
  runtimeVersion: '29.7.2',
  // Every required check, because the verifier refuses a marker that names fewer than all of them.
  checks: [...REQUIRED_CONTAINMENT_CHECKS],
  suite: 'tests/container.assertion.test.ts',
  ...overrides,
});

afterEach(() => {
  for (const home of temps.splice(0)) rmSync(home, { recursive: true, force: true });
});

describe('the containment claim, and what it takes to make it', () => {
  it('cannot be made when the assertion suite has never run here', () => {
    const env = tempHome();
    const verification = containmentVerification({ env, invoke: answeringRuntime });
    expect(verification.verified).toBe(false);
    expect(verification.reason).toContain('never recorded an outcome');
    expect(() => assertContainmentVerified({ env, invoke: answeringRuntime })).toThrow(
      ContainmentUnverifiedError,
    );
  });

  it('cannot be made when the suite skipped, and the refusal repeats the skip\'s reason', () => {
    const env = tempHome();
    recordContainmentMarker(
      marker({ state: 'skipped', reason: 'the runtime CLI 29.7.2 is installed but its daemon did not answer' }),
      env,
    );
    const verification = containmentVerification({ env, invoke: answeringRuntime });
    expect(verification.verified).toBe(false);
    expect(verification.reason).toContain('skipped');
    expect(verification.reason).toContain('daemon did not answer');
  });

  it('cannot be made when the suite ran and some check failed', () => {
    const env = tempHome();
    recordContainmentMarker(marker({ state: 'failed', reason: 'only no-runtime-socket passed' }), env);
    expect(containmentVerification({ env, invoke: answeringRuntime }).verified).toBe(false);
  });

  it('cannot be made about a Dockerfile that has changed since', () => {
    // AD-11 already treats a changed Dockerfile as a different image; a proof about the old one is a
    // proof about a different sandbox.
    const env = tempHome();
    recordContainmentMarker(marker({ dockerfileHash: 'a'.repeat(64) }), env);
    const verification = containmentVerification({ env, invoke: answeringRuntime });
    expect(verification.verified).toBe(false);
    expect(verification.reason).toContain('different image');
  });

  it('cannot be made on a machine whose runtime has since stopped answering', () => {
    const env = tempHome();
    recordContainmentMarker(marker(), env);
    const verification = containmentVerification({ env, invoke: silentDaemon });
    expect(verification.verified).toBe(false);
    expect(verification.reason).toContain('no container runtime answers now');
  });

  it('refuses a marker that claims verification but names fewer than every required check', () => {
    // The writer only emits `verified` once all six pass, but a reader that trusts the word and not
    // the list enforces three of its four properties. The risk is drift, not forgery: a marker
    // written before a check was added would otherwise keep vouching for a property nothing proved.
    const env = tempHome();
    recordContainmentMarker(marker({ checks: [...REQUIRED_CONTAINMENT_CHECKS].slice(0, 3) }), env);
    const verification = containmentVerification({ env, invoke: answeringRuntime });
    expect(verification.verified).toBe(false);
    expect(verification.reason).toContain('3 of 6');
    expect(verification.reason).toContain('capabilities-dropped');
  });

  it('is made exactly when all four conditions hold', () => {
    const env = tempHome();
    recordContainmentMarker(marker(), env);
    const verification = containmentVerification({ env, invoke: answeringRuntime });
    expect(verification.verified).toBe(true);
    expect(verification.reason).toContain('containment properties');
    expect(() => assertContainmentVerified({ env, invoke: answeringRuntime })).not.toThrow();
  });

  it('ignores a marker that has been corrupted rather than trusting it', () => {
    const env = tempHome();
    const path = containmentMarkerPath(env);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, '{"state": "totally verified", "checks"', 'utf8');
    expect(readContainmentMarker(env)).toBeNull();
    expect(containmentVerification({ env, invoke: answeringRuntime }).verified).toBe(false);
  });

  it('puts its marker under ORCH_HOME and nowhere near a repository', () => {
    const env = tempHome();
    const path = containmentMarkerPath(env);
    expect(path.startsWith(env['ORCH_HOME'] ?? '')).toBe(true);
    expect(path).toContain(join('gates', 'container-assertion.json'));
  });
});

describe('the assertion suite\'s own visibility, read out of its source', () => {
  const source = readFileSync(SUITE_PATH, 'utf8');

  it('still probes the runtime and skips rather than failing or pretending', () => {
    expect(source).toContain('probeContainerRuntime()');
    expect(source).toContain('describe.skipIf(!runtime.reachable)');
  });

  it('still names its skip visibly in the suite title', () => {
    // The marker string reaches the test output, so a skipped security suite is a line somebody reads
    // rather than an absence nobody notices.
    expect(source).toContain('CONTAINMENT_SKIP_MARKER');
    expect(source).toMatch(/\[\$\{CONTAINMENT_SKIP_MARKER\}/);
    expect(CONTAINMENT_SKIP_MARKER).toContain('SKIPPED');
  });

  it('still records what it did on both paths', () => {
    const records = [...source.matchAll(/recordContainmentMarker\(/g)];
    expect(records.length).toBeGreaterThanOrEqual(2);
    expect(source).toContain("state: 'skipped'");
    // And `verified` is written only behind the every-check gate, never unconditionally.
    expect(source).toContain('REQUIRED_CHECKS.every');
    expect(source).toContain("everyCheck ? 'verified' : 'failed'");
    expect(source).not.toMatch(/state:\s*'verified'/);
  });

  it('asserts both halves of AD-31\'s sentence', () => {
    expect(source).toContain('no push credential');
    expect(source).toContain('no container runtime socket');
  });
});

describe('the live gate on this machine', () => {
  const runtime = probeContainerRuntime();
  const verification = containmentVerification();

  it('reports the runtime state it actually found', () => {
    // Not an assertion about which state we are in — both are legitimate — but a refusal to be vague
    // about it. `detail` is the sentence a skip marker and a refusal both carry.
    expect(typeof runtime.reachable).toBe('boolean');
    expect(runtime.detail.length).toBeGreaterThan(0);
  });

  it('makes the containment claim undeclarable while no runtime answers', () => {
    if (runtime.reachable) {
      // A reachable runtime: the claim is exactly as strong as the marker the suite wrote, and if it
      // is verified then the suite must have recorded the checks it verified.
      const live = readContainmentMarker();
      if (verification.verified) {
        expect(live?.state).toBe('verified');
        expect((live?.checks ?? []).length).toBeGreaterThan(0);
        expect(live?.dockerfileHash).toBe(currentDockerfileHash());
      }
      return;
    }
    expect(verification.verified).toBe(false);
    expect(() => assertContainmentVerified()).toThrow(ContainmentUnverifiedError);
    // And the refusal says what AD-31 is owed, so the message is usable by whoever reads it.
    expect(() => assertContainmentVerified()).toThrow(/stage-1 containment gate cannot be declared met/);
  });
});
