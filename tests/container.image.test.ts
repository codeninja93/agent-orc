/**
 * AD-11: the tag is the Dockerfile's content hash, the build happens when and only when that hash
 * changes, and nothing is ever pulled from a registry.
 *
 * Driven through the injected invoker rather than a daemon, because the behaviour being asserted is a
 * *decision sequence* — resolve, resolve again, change the file, resolve again — and a decision is
 * assertable with no runtime at all. The daemon's part of this story is `container.assertion.test.ts`.
 */
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  CONTAINER_HOME,
  CONTAINER_SUBCOMMANDS,
  ContainerRuntimeUnreachableError,
  EXECUTOR_GID,
  EXECUTOR_UID,
  IMAGE_CLI_PATH,
  IMAGE_DIGEST_LABEL,
  IMAGE_NODE_PATH,
  IMAGE_REPOSITORY,
  IMAGE_TAG_HASH_LENGTH,
  ImageBuildError,
  createImageResolver,
  dockerfilePath,
  hashDockerfileContent,
  imageTagForContent,
  imageTagForHash,
} from '../src/container/index.js';
import type { ContainerInvocation, ContainerResult } from '../src/container/index.js';

/** A recording invoker: every invocation is kept, and the image is "absent" until a build succeeds. */
const fakeRuntime = (
  options: { readonly presentTags?: readonly string[]; readonly buildFails?: boolean } = {},
): {
  readonly invoke: (invocation: ContainerInvocation) => ContainerResult;
  readonly seen: ContainerInvocation[];
  readonly builds: () => readonly ContainerInvocation[];
  /** Remove a tag the way a prune outside this process does: every later inspect says absent. */
  readonly forget: (tag: string) => void;
} => {
  const present = new Set<string>(options.presentTags ?? []);
  const seen: ContainerInvocation[] = [];
  const invoke = (invocation: ContainerInvocation): ContainerResult => {
    seen.push(invocation);
    const argv = ['<runtime>', ...invocation.subcommand, ...invocation.args];
    if (invocation.subcommand.join(' ') === CONTAINER_SUBCOMMANDS.inspectImage.join(' ')) {
      const tag = invocation.args[0] ?? '';
      return present.has(tag)
        ? { status: 0, stdout: '[{}]', stderr: '', argv }
        : { status: 1, stdout: '', stderr: `Error: No such image: ${tag}`, argv };
    }
    if (invocation.subcommand.join(' ') === CONTAINER_SUBCOMMANDS.build.join(' ')) {
      if (options.buildFails === true) {
        return { status: 1, stdout: '', stderr: 'failed to solve: process did not complete', argv };
      }
      const tag = invocation.args[invocation.args.indexOf('--tag') + 1];
      if (tag !== undefined) present.add(tag);
      return { status: 0, stdout: 'built', stderr: '', argv };
    }
    return { status: 0, stdout: '', stderr: '', argv };
  };
  return {
    invoke,
    seen,
    builds: (): readonly ContainerInvocation[] =>
      seen.filter((one) => one.subcommand.join(' ') === CONTAINER_SUBCOMMANDS.build.join(' ')),
    forget: (tag: string): void => {
      present.delete(tag);
    },
  };
};

let dir: string;
let dockerfile: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orch-image-'));
  dockerfile = join(dir, 'Dockerfile');
  writeFileSync(dockerfile, 'FROM node:24.21.0-bookworm-slim\nUSER 10001:10001\n', 'utf8');
});

// Removed rather than left behind: a suite that leaks a temp directory per test leaves a machine a
// little dirtier every run, and this one writes a file into each.
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('the tag', () => {
  it('carries the hash of the Dockerfile\'s content', () => {
    const content = 'FROM node:24.21.0-bookworm-slim\n';
    const expected = createHash('sha256').update(content).digest('hex');
    expect(imageTagForContent(content)).toBe(
      `${IMAGE_REPOSITORY}:${expected.slice(0, IMAGE_TAG_HASH_LENGTH)}`,
    );
    expect(hashDockerfileContent(content)).toBe(expected);
  });

  it('is a local reference with no registry in it', () => {
    const tag = imageTagForContent('FROM scratch\n');
    expect(tag.startsWith(`${IMAGE_REPOSITORY}:`)).toBe(true);
    expect(tag).not.toContain('/');
  });

  it('refuses to be derived from anything that is not the Dockerfile\'s full digest', () => {
    // AD-11 makes the hash the identity, so slicing whatever string arrives mints a *different*
    // identity that still looks like one — and `--pull never` then reports it as a missing image rather
    // than as the bad digest it is.
    const digest = hashDockerfileContent('FROM scratch\n');
    expect(imageTagForHash(digest)).toBe(`${IMAGE_REPOSITORY}:${digest.slice(0, IMAGE_TAG_HASH_LENGTH)}`);
    for (const bad of ['', 'orch-executor:0123456789abcdef', digest.slice(0, 16), digest.toUpperCase(), `${digest}0`]) {
      expect(() => imageTagForHash(bad), JSON.stringify(bad)).toThrow(/full/);
    }
  });

  it('changes when the Dockerfile changes, which is what makes a stale image unusable', () => {
    expect(imageTagForContent('FROM scratch\n')).not.toBe(imageTagForContent('FROM scratch\n# tweak\n'));
  });

  it('is derived from this repository\'s own Dockerfile, which exists and is hashable', () => {
    const resolver = createImageResolver({ invoke: fakeRuntime().invoke });
    expect(dockerfilePath().endsWith(join('docker', 'Dockerfile'))).toBe(true);
    expect(resolver.hash()).toMatch(/^[0-9a-f]{64}$/);
    expect(resolver.tag()).toBe(`${IMAGE_REPOSITORY}:${resolver.hash().slice(0, IMAGE_TAG_HASH_LENGTH)}`);
  });
});

describe('build-only-when-the-hash-changes', () => {
  it('builds once when the image is absent, and not again at the same hash', () => {
    const runtime = fakeRuntime();
    const resolver = createImageResolver({ invoke: runtime.invoke, dockerfile, context: dir });

    const first = resolver.resolve();
    expect(first.built).toBe(true);
    expect(first.reason).toBe('absent');
    expect(runtime.builds()).toHaveLength(1);

    const second = resolver.resolve();
    expect(second.built).toBe(false);
    expect(second.tag).toBe(first.tag);
    expect(runtime.builds()).toHaveLength(1);
  });

  it('does not build at all when the tag is already present on the machine', () => {
    const content = 'FROM node:24.21.0-bookworm-slim\nUSER 10001:10001\n';
    const runtime = fakeRuntime({ presentTags: [imageTagForContent(content)] });
    const resolver = createImageResolver({ invoke: runtime.invoke, dockerfile, context: dir });
    const resolution = resolver.resolve();
    expect(resolution.built).toBe(false);
    expect(resolution.reason).toBe('present');
    expect(runtime.builds()).toHaveLength(0);
  });

  it('rebuilds exactly once when the Dockerfile changes, and keeps the old tag valid', () => {
    const runtime = fakeRuntime();
    const resolver = createImageResolver({ invoke: runtime.invoke, dockerfile, context: dir });
    const before = resolver.resolve();

    writeFileSync(dockerfile, 'FROM node:24.21.0-bookworm-slim\nUSER 10001:10001\n# hardened\n', 'utf8');
    const after = resolver.resolve();
    expect(after.tag).not.toBe(before.tag);
    expect(after.built).toBe(true);
    expect(runtime.builds()).toHaveLength(2);

    // A third resolution at the new content builds nothing: "exactly once for the new hash".
    expect(resolver.resolve().built).toBe(false);
    expect(runtime.builds()).toHaveLength(2);
  });

  it('records the full digest on the image it builds', () => {
    const runtime = fakeRuntime();
    const resolver = createImageResolver({ invoke: runtime.invoke, dockerfile, context: dir });
    const resolution = resolver.resolve();
    const build = runtime.builds()[0];
    expect(build?.args).toContain(`${IMAGE_DIGEST_LABEL}=${resolution.hash}`);
    expect(build?.args).toContain('--file');
    expect(build?.args[build.args.indexOf('--file') + 1]).toBe(dockerfile);
  });
});

describe('the registry refusal', () => {
  it('never issues a pull, and tells the build not to refresh the pinned base', () => {
    const runtime = fakeRuntime();
    createImageResolver({ invoke: runtime.invoke, dockerfile, context: dir }).resolve();
    for (const invocation of runtime.seen) {
      expect(invocation.subcommand).not.toContain('pull');
      expect(invocation.args).not.toContain('pull');
    }
    expect(runtime.builds()[0]?.args).toContain('--pull=false');
  });

  it('builds from a local Dockerfile path, never a remote context', () => {
    const runtime = fakeRuntime();
    createImageResolver({ invoke: runtime.invoke, dockerfile, context: dir }).resolve();
    const context = runtime.builds()[0]?.args.at(-1) ?? '';
    expect(context).toBe(dir);
    expect(context).not.toMatch(/^(https?|git|github\.com)/);
  });
});

describe('a build that fails', () => {
  it('raises the declared AD-35 code rather than degrading to a pulled image', () => {
    const runtime = fakeRuntime({ buildFails: true });
    const resolver = createImageResolver({ invoke: runtime.invoke, dockerfile, context: dir });
    let thrown: unknown;
    try {
      resolver.resolve();
    } catch (error: unknown) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ImageBuildError);
    expect((thrown as ImageBuildError).code).toBe('container.image_build_failed');
    expect((thrown as ImageBuildError).orchError.retryable).toBe(true);
    expect((thrown as Error).message).toContain('failed to solve');
  });

  it('refuses when the Dockerfile itself cannot be read', () => {
    const resolver = createImageResolver({
      invoke: fakeRuntime().invoke,
      dockerfile: join(dir, 'absent', 'Dockerfile'),
      context: dir,
    });
    expect(() => resolver.resolve()).toThrow(ImageBuildError);
  });
});

describe('an image that went away behind this process\'s back', () => {
  it('is rebuilt, because the machine is asked every time rather than the memo', () => {
    // The cache was a memory of what was once true. An image pruned, removed or lost to a disk reclaim
    // left it vouching for a tag that is gone, and `--pull never` turns that into a run that cannot
    // start — with no build, because this resolver was sure it was already there.
    const runtime = fakeRuntime();
    const resolver = createImageResolver({ invoke: runtime.invoke, dockerfile, context: dir });
    const first = resolver.resolve();
    expect(first.built).toBe(true);
    expect(resolver.resolve().reason).toBe('cached');
    expect(runtime.builds()).toHaveLength(1);

    // Removed outside this process: every later inspect says absent.
    runtime.forget(first.tag);
    const again = resolver.resolve();
    expect(again.built).toBe(true);
    expect(again.tag).toBe(first.tag);
    expect(runtime.builds()).toHaveLength(2);
  });

  it('reports a daemon that is down as unreachable, not as a build failure', () => {
    // "The image is absent" and "nothing is listening" are different facts with different fixes, and an
    // inspect that failed because the daemon is down is not evidence about any image. Reported as a
    // build failure it sends a reader to the Dockerfile for a machine that needs its daemon started.
    const resolver = createImageResolver({
      invoke: (invocation) => ({
        status: 1,
        stdout: '',
        stderr: 'Cannot connect to the container runtime daemon at unix:///var/run/x.sock. Is the runtime daemon running?',
        argv: ['<runtime>', ...invocation.subcommand, ...invocation.args],
      }),
      dockerfile,
      context: dir,
    });
    let thrown: unknown;
    try {
      resolver.resolve();
    } catch (error: unknown) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ContainerRuntimeUnreachableError);
    expect(thrown).not.toBeInstanceOf(ImageBuildError);
    expect((thrown as Error).message).toContain('daemon did not answer');
  });
});

describe('the Dockerfile and the constants that describe it', () => {
  const source = readFileSync(dockerfilePath(), 'utf8');

  it('creates the exact user src/container/flags.ts passes to --user', () => {
    // Two sources of truth for one uid is the drift the image cannot survive: a container running as a
    // uid with no passwd entry has no name for `id -un`, no home, and no identity for git. The values
    // are literal in the Dockerfile on purpose — the tag is this file's content hash, so a build
    // argument is a value the identity does not cover.
    expect(source).toMatch(new RegExp(`--uid ${String(EXECUTOR_UID)}\\b`));
    expect(source).toMatch(new RegExp(`--gid ${String(EXECUTOR_GID)}\\b`));
    expect(source).toContain(`USER ${String(EXECUTOR_UID)}:${String(EXECUTOR_GID)}`);
    expect(source).toContain(`--home-dir ${CONTAINER_HOME}`);
    expect(source).toContain(`ENV HOME=${CONTAINER_HOME}`);
    // Nothing the image's identity does not cover may decide who the container runs as.
    expect(source).not.toMatch(/ARG\s+EXECUTOR_/);
  });

  it('puts the two absolute paths the wrapper runs where it says they are', () => {
    expect(source).toContain(`test -x ${IMAGE_CLI_PATH}`);
    expect(source).toContain(`test -x ${IMAGE_NODE_PATH}`);
  });

  it('claims only the determinism it has', () => {
    // `apt-get install` resolves whatever the archive serves and `npm install --global` resolves the
    // CLI's transitive dependencies at build time, so "the same hash always means the same sandbox" was
    // a stronger claim than the file can keep. The base image is still pinned, which is the part that is
    // true and the part that matters for the tag.
    expect(source).not.toContain('the same Dockerfile hash always means the same sandbox');
    expect(source).toContain('FROM node:24.21.0-bookworm-slim');
    expect(source).toMatch(/does not mean a byte-identical image/);
    // The toolchain the header enumerates is the toolchain the build installs. `ripgrep` was installed
    // and unnamed, so the header described an image the file does not build.
    const header = source.split('\n').filter((line) => line.startsWith('#')).join('\n');
    for (const tool of ['git', 'ripgrep']) {
      expect(new RegExp(`^\\s+${tool}\\s*\\\\?$`, 'm').test(source), tool).toBe(true);
      expect(header, tool).toContain(tool);
    }
  });
});
