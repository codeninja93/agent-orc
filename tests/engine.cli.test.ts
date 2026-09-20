/**
 * AD-1's preflight and AD-28's child Node.
 *
 * Both are refusals, and a refusal is only worth anything if it names what was required. So every
 * assertion here checks the *message* as well as the throw: "the CLI is too old" that does not say
 * which version is needed sends the reader to the source, which is the failure the AD is written
 * against.
 *
 * The API-key case additionally asserts that nothing was probed. AD-1 forbids bare mode positively,
 * and "refused before any spawn" is not a figure of speech — the environment is read, and no process
 * is created, not even the version probe.
 */
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { nodeFloor, parseNodeFloor } from '../src/contracts/index.js';
import {
  ApiKeyModeRefusedError,
  CHILD_NODE_ENV_VAR,
  ChildNodeUnavailableError,
  CLAUDE_API_KEY_MODE_ENV_VARS,
  CLAUDE_CLI_VERSION_FLOOR,
  ClaudeCliUnavailableError,
  ClaudeCliVersionError,
  assertSubscriptionAuth,
  childEnvWithNode,
  classifyCliEntry,
  findOnPath,
  isSubscriptionApiKeySource,
  forgetChildNode,
  forgetClaudeCli,
  nodeCandidatesOnPath,
  parseClaudeVersion,
  parseNodeVersionOutput,
  probeClaudeVersion,
  resolveChildNode,
  resolveChildNodeOnce,
  resolveClaudeCli,
  resolveClaudeCliOnce,
} from '../src/engine/index.js';

const FAKE_CLI = fileURLToPath(new URL('./helpers/fake-claude.ts', import.meta.url));

/** An environment with every API-key variable cleared, so a developer's own shell cannot skew a run. */
const cleanEnv = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra };
  for (const variable of CLAUDE_API_KEY_MODE_ENV_VARS) {
    if (!(variable in extra)) delete env[variable];
  }
  if (!(CHILD_NODE_ENV_VAR in extra)) delete env[CHILD_NODE_ENV_VAR];
  return env;
};

/** A probe that fails the test if it is ever called. The evidence that no process was created. */
const forbiddenProbe = (): string | null => {
  throw new Error('a process was created before the authentication assertion refused the spawn');
};

describe('the claude CLI version floor', () => {
  it('is the Stack table pin, and is named in the refusal', () => {
    expect(CLAUDE_CLI_VERSION_FLOOR).toBe('2.1.259');
    let thrown: unknown;
    try {
      resolveClaudeCli({ env: cleanEnv(), path: FAKE_CLI, probeVersion: () => '2.1.258' });
    } catch (error: unknown) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ClaudeCliVersionError);
    const error = thrown as ClaudeCliVersionError;
    expect(error.required).toBe('2.1.259');
    expect(error.found).toBe('2.1.258');
    expect(error.message).toContain('2.1.259');
    expect(error.message).toContain('2.1.258');
  });

  it('accepts the floor exactly, and anything above it', () => {
    for (const version of ['2.1.259', '2.1.278', '2.2.0', '3.0.0']) {
      const cli = resolveClaudeCli({
        env: cleanEnv(),
        path: FAKE_CLI,
        probeVersion: () => version,
      });
      expect(cli.version).toBe(version);
      expect(cli.auth).toBe('subscription');
    }
  });

  it('reads a version out of the CLI banner, and refuses a binary that reports none', () => {
    expect(parseClaudeVersion('2.1.278 (Claude Code)\n')).toBe('2.1.278');
    expect(parseClaudeVersion('v2.1.278')).toBe('2.1.278');
    expect(parseClaudeVersion('no version here')).toBeNull();

    expect(() =>
      resolveClaudeCli({ env: cleanEnv(), path: FAKE_CLI, probeVersion: () => null }),
    ).toThrowError(ClaudeCliUnavailableError);
  });

  it('probes a real executable rather than trusting its name', () => {
    // A genuine end-to-end probe: `node --version` really runs, and the banner really parses.
    expect(probeClaudeVersion(process.execPath)).toBe(process.versions.node);
    expect(probeClaudeVersion(join(tmpdir(), 'orch-no-such-binary-ever'))).toBeNull();
  });
});

describe('API-key mode is refused before any process exists', () => {
  it.each(CLAUDE_API_KEY_MODE_ENV_VARS)('refuses when %s is set, naming subscription auth', (variable) => {
    let thrown: unknown;
    try {
      resolveClaudeCli({
        env: cleanEnv({ [variable]: 'set-to-something' }),
        path: FAKE_CLI,
        probeVersion: forbiddenProbe,
      });
    } catch (error: unknown) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ApiKeyModeRefusedError);
    const error = thrown as ApiKeyModeRefusedError;
    expect(error.code).toBe('model.api_key_mode_refused');
    expect(error.evidence).toBe(variable);
    expect(error.message).toContain('subscription');
    expect(error.message).toContain(variable);
  });

  it('is not tripped by a variable set to an empty value', () => {
    expect(() => assertSubscriptionAuth(cleanEnv({ ANTHROPIC_API_KEY: '' }))).not.toThrow();
    expect(() => assertSubscriptionAuth(cleanEnv({ ANTHROPIC_API_KEY: '   ' }))).not.toThrow();
  });

  it('reads the CLI\'s own report of how it authenticated', () => {
    // Recorded, not assumed: the committed real transcript carries "apiKeySource":"none".
    expect(isSubscriptionApiKeySource('none')).toBe(true);
    expect(isSubscriptionApiKeySource('ANTHROPIC_API_KEY')).toBe(false);
    expect(isSubscriptionApiKeySource('apiKeyHelper')).toBe(false);
    expect(isSubscriptionApiKeySource(undefined)).toBe(false);
  });
});

describe('an absent CLI', () => {
  it('is refused naming what was searched, not reported as a version problem', () => {
    const empty = mkdtempSync(join(tmpdir(), 'orch-empty-path-'));
    let thrown: unknown;
    try {
      resolveClaudeCli({ env: cleanEnv({ PATH: empty }) });
    } catch (error: unknown) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ClaudeCliUnavailableError);
    const error = thrown as ClaudeCliUnavailableError;
    expect(error.code).toBe('step.spawn_failed');
    expect(error.searched).toContain(empty);
  });

  it('refuses an explicit path that is not a file', () => {
    expect(() =>
      resolveClaudeCli({
        env: cleanEnv(),
        path: join(tmpdir(), 'orch-no-such-cli-ever'),
        probeVersion: () => '2.1.278',
      }),
    ).toThrowError(/is not a file/);
  });

  it('finds a binary that is on PATH, as an absolute path', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orch-fake-path-'));
    const binary = join(dir, 'claude');
    writeFileSync(binary, '#!/bin/sh\necho "2.1.278 (Claude Code)"\n', 'utf8');
    chmodSync(binary, 0o755);
    expect(findOnPath('claude', { PATH: dir })).toBe(binary);
    expect(findOnPath('claude', { PATH: mkdtempSync(join(tmpdir(), 'orch-other-')) })).toBeNull();

    const cli = resolveClaudeCli({ env: cleanEnv({ PATH: dir }) });
    expect(cli.path).toBe(binary);
    expect(cli.version).toBe('2.1.278');
  });
});

describe('how the CLI entry is executed', () => {
  it('runs a script under the resolved Node and a compiled binary directly', () => {
    // The real `claude` on a developer machine is a compiled executable with no extension; the fake
    // the suite drives is a TypeScript script. Both have to work, and they work differently.
    expect(classifyCliEntry(FAKE_CLI)).toBe('node');
    expect(classifyCliEntry(process.execPath)).toBe('direct');

    const dir = mkdtempSync(join(tmpdir(), 'orch-shebang-'));
    const script = join(dir, 'claude');
    writeFileSync(script, '#!/usr/bin/env node\nconsole.log(1);\n', 'utf8');
    expect(classifyCliEntry(script)).toBe('node');

    const shell = join(dir, 'claude.sh');
    writeFileSync(shell, '#!/bin/sh\nexit 0\n', 'utf8');
    expect(classifyCliEntry(shell)).toBe('direct');
  });
});

describe('AD-28 — the absolute child Node', () => {
  it('uses the running interpreter when it meets the floor, without probing anything', () => {
    const resolved = resolveChildNode({ env: cleanEnv(), probe: forbiddenProbe });
    expect(resolved.path).toBe(process.execPath);
    expect(resolved.version).toBe(process.versions.node);
    expect(resolved.source).toBe('parent');
  });

  it('never hands a child a PATH Node below the floor', () => {
    // The failure AD-28 exists for: a stale version manager leaves an old `node` first on PATH.
    const dir = mkdtempSync(join(tmpdir(), 'orch-stale-node-'));
    writeFileSync(join(dir, 'node'), '#!/bin/sh\necho v18.0.0\n', 'utf8');
    chmodSync(join(dir, 'node'), 0o755);

    let thrown: unknown;
    try {
      resolveChildNode({
        env: cleanEnv({ PATH: dir }),
        parentExecPath: null,
        parentVersion: null,
        probe: (path) => (path === join(dir, 'node') ? '18.0.0' : null),
      });
    } catch (error: unknown) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ChildNodeUnavailableError);
    const error = thrown as ChildNodeUnavailableError;
    expect(error.code).toBe('engine.node_floor_unmet');
    expect(error.message).toContain(nodeFloor().version);
    expect(error.candidates.map((candidate) => candidate.version)).toContain('18.0.0');
  });

  it('takes a PATH Node that does meet the floor when the parent does not', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orch-good-node-'));
    const good = join(dir, 'node');
    writeFileSync(good, '#!/bin/sh\necho v24.21.0\n', 'utf8');
    chmodSync(good, 0o755);
    const resolved = resolveChildNode({
      env: cleanEnv({ PATH: dir }),
      parentExecPath: '/somewhere/old/node',
      parentVersion: '20.0.0',
    });
    expect(resolved.path).toBe(good);
    expect(resolved.version).toBe('24.21.0');
    expect(resolved.source).toBe('path');
  });

  it('refuses a pin that does not meet the floor rather than quietly preferring another Node', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orch-pinned-node-'));
    const pinned = join(dir, 'node');
    writeFileSync(pinned, '#!/bin/sh\necho v20.0.0\n', 'utf8');
    chmodSync(pinned, 0o755);
    expect(() => resolveChildNode({ env: cleanEnv({ [CHILD_NODE_ENV_VAR]: pinned }) })).toThrowError(
      ChildNodeUnavailableError,
    );
    // ... and honours one that does, over the running interpreter.
    const good = join(dir, 'good-node');
    writeFileSync(good, '#!/bin/sh\necho v24.21.0\n', 'utf8');
    chmodSync(good, 0o755);
    const resolved = resolveChildNode({ env: cleanEnv({ [CHILD_NODE_ENV_VAR]: good }) });
    expect(resolved.path).toBe(good);
    expect(resolved.source).toBe('env');
  });

  it('reads a version from a real `node --version`, and lists only real files on PATH', () => {
    expect(parseNodeVersionOutput('v24.21.0\n')).toBe('24.21.0');
    expect(parseNodeVersionOutput('24.21\n')).toBeNull();
    const candidates = nodeCandidatesOnPath({ PATH: join(process.execPath, '..') });
    expect(candidates).toContain(process.execPath);
  });

  it('publishes the resolved interpreter to the child so a grandchild cannot resolve a stale one', () => {
    const node = resolveChildNode({ env: cleanEnv() });
    const env = childEnvWithNode(node, { PATH: '/usr/bin' });
    expect(env[CHILD_NODE_ENV_VAR]).toBe(node.path);
    expect(env['PATH']?.startsWith(join(node.path, '..'))).toBe(true);
  });

  it('reads the floor from the manifest rather than restating it', () => {
    // A third home for the floor is the drift AD-28 names; the floor here is the declared one.
    expect(nodeFloor()).toStrictEqual(parseNodeFloor(nodeFloor().range));
  });
});

describe('resolving once', () => {
  it('memoises the child Node, and forgets it on request', () => {
    forgetChildNode();
    let probes = 0;
    const count = (): string | null => {
      probes += 1;
      return '24.21.0';
    };
    const first = resolveChildNodeOnce({
      env: cleanEnv(),
      parentExecPath: null,
      parentVersion: null,
      probe: count,
      floor: parseNodeFloor('>=22.22'),
    });
    const second = resolveChildNodeOnce({ env: cleanEnv() });
    // AD-28 resolves the absolute child Node once; the second call re-probes nothing.
    expect(second).toBe(first);
    const probesAfterMemoising = probes;
    forgetChildNode();
    resolveChildNodeOnce({ env: cleanEnv() });
    expect(probes).toBe(probesAfterMemoising);
    forgetChildNode();
  });

  it('memoises the CLI preflight, so a run does not re-probe it per step', () => {
    forgetClaudeCli();
    let probes = 0;
    const first = resolveClaudeCliOnce({
      env: cleanEnv(),
      path: FAKE_CLI,
      probeVersion: () => {
        probes += 1;
        return '2.1.278';
      },
    });
    expect(probes).toBe(1);
    expect(resolveClaudeCliOnce({ env: cleanEnv(), path: FAKE_CLI, probeVersion: forbiddenProbe })).toBe(
      first,
    );
    forgetClaudeCli();
  });
});
