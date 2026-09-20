/**
 * AD-11: the tag is the Dockerfile's content hash, the build happens when and only when that hash
 * changes, and nothing is ever pulled from a registry.
 *
 * Driven through the injected invoker rather than a daemon, because the behaviour being asserted is a
 * *decision sequence* — resolve, resolve again, change the file, resolve again — and a decision is
 * assertable with no runtime at all. The daemon's part of this story is `container.assertion.test.ts`.
 */
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';

import {
  CONTAINER_SUBCOMMANDS,
  IMAGE_DIGEST_LABEL,
  IMAGE_REPOSITORY,
  IMAGE_TAG_HASH_LENGTH,
  ImageBuildError,
  createImageResolver,
  dockerfilePath,
  hashDockerfileContent,
  imageTagForContent,
} from '../src/container/index.js';
import type { ContainerInvocation, ContainerResult } from '../src/container/index.js';

/** A recording invoker: every invocation is kept, and the image is "absent" until a build succeeds. */
const fakeRuntime = (
  options: { readonly presentTags?: readonly string[]; readonly buildFails?: boolean } = {},
): {
  readonly invoke: (invocation: ContainerInvocation) => ContainerResult;
  readonly seen: ContainerInvocation[];
  readonly builds: () => readonly ContainerInvocation[];
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
  };
};

let dir: string;
let dockerfile: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orch-image-'));
  dockerfile = join(dir, 'Dockerfile');
  writeFileSync(dockerfile, 'FROM node:24.21.0-bookworm-slim\nUSER 10001:10001\n', 'utf8');
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
