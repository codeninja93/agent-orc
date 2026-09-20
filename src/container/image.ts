/**
 * AD-11 — the executor image is built locally, tagged by its Dockerfile's content hash, and never
 * pulled from a registry.
 *
 * The hash *is* the identity. That single decision closes a failure mode that no amount of care about
 * tag names does: with a mutable tag, a hardening change to the Dockerfile leaves every machine that
 * already has `orch-executor:latest` running the old sandbox, and nothing about the run looks
 * different. With the content hash in the tag, an image that does not match the Dockerfile in this
 * checkout simply is not the image the invocation asks for, so the build happens — and happens exactly
 * once, because the second request finds the tag present.
 *
 * "Never pulled" is enforced in two places for two different reasons. The build passes `--pull=false`
 * so a base layer already on the machine is not silently refreshed mid-run (the base is pinned in the
 * Dockerfile; a refresh would make the same tag mean two things). The *run* passes `--pull never`
 * — composed in `flags.ts` — so a missing image is a failure rather than a registry round trip. The
 * build is the only networked step this package performs, which is exactly AD-11's clause.
 *
 * Resolution is a small object with a cache rather than a free function with a module-level set,
 * because "rebuilt when and only when the hash changes" is a statement about a *sequence* of requests
 * and a suite has to be able to drive that sequence from a clean state.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { makeError } from '../contracts/index.js';
import type { OrchError } from '../contracts/index.js';

import {
  CONTAINER_BUILD_TIMEOUT_MS,
  CONTAINER_SUBCOMMANDS,
  DOCKERFILE_RELATIVE_PATH,
} from './runtime.js';
import type { ContainerInvoker } from './runtime.js';

/** The image's repository name. No registry host and no slash: AD-11 forbids a registry reference. */
export const IMAGE_REPOSITORY = 'orch-executor';

/**
 * How much of the Dockerfile's SHA-256 the tag carries.
 *
 * 16 hex characters is 64 bits of the digest. The population is "Dockerfiles this repository has ever
 * had", so a collision is not a security boundary — the full digest is recorded in the build's own
 * labels, and the tag only has to be unambiguous among a handful of versions on one machine.
 */
export const IMAGE_TAG_HASH_LENGTH = 16;

/** The label the full digest is recorded under, so a tag can be traced back to its whole hash. */
export const IMAGE_DIGEST_LABEL = 'orch.dockerfile.sha256';

/**
 * The package root, resolved from this module rather than from `process.cwd()`.
 *
 * `cwd` is the *target repository* for most of this system's life, so a Dockerfile path relative to it
 * would resolve into whatever project is being worked on. Both layouts land on the same root:
 * `src/container/image.ts` and `dist/container/image.js` are each two levels down.
 */
export const packageRoot = (): string => resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** The Dockerfile this build uses. */
export const dockerfilePath = (root: string = packageRoot()): string =>
  join(root, DOCKERFILE_RELATIVE_PATH);

/** The full SHA-256 of a Dockerfile's exact bytes. */
export const hashDockerfileContent = (content: string | Uint8Array): string =>
  createHash('sha256').update(content).digest('hex');

/** The tag a Dockerfile of this content is built as: `orch-executor:<first 16 hex of its sha256>`. */
export const imageTagForContent = (content: string | Uint8Array): string =>
  `${IMAGE_REPOSITORY}:${hashDockerfileContent(content).slice(0, IMAGE_TAG_HASH_LENGTH)}`;

/** The tag a hash corresponds to, when the hash is already in hand. */
export const imageTagForHash = (hash: string): string =>
  `${IMAGE_REPOSITORY}:${hash.slice(0, IMAGE_TAG_HASH_LENGTH)}`;

/** The build failed. `container.image_build_failed` is retryable — a transient network is the usual cause. */
export class ImageBuildError extends Error {
  readonly code = 'container.image_build_failed';
  readonly tag: string;
  readonly orchError: OrchError;

  constructor(tag: string, detail: string) {
    const message =
      `Could not build the executor image ${tag}: ${detail}. AD-11 builds the image locally from ` +
      'docker/Dockerfile and never pulls one, so there is no registry fallback to degrade to.';
    super(message);
    this.name = 'ImageBuildError';
    this.tag = tag;
    this.orchError = makeError(this.code, message, detail);
  }
}

/** What one resolution did. `built: false` is the steady state; `true` happens once per hash. */
export interface ImageResolution {
  readonly tag: string;
  /** The full SHA-256 of the Dockerfile the tag was derived from. */
  readonly hash: string;
  /** Whether this resolution ran a build. */
  readonly built: boolean;
  /** Why it did or did not: `present`, `cached`, or `absent`. */
  readonly reason: 'present' | 'cached' | 'absent';
  readonly dockerfile: string;
}

export interface ImageResolverOptions {
  readonly invoke: ContainerInvoker;
  /** Defaults to `<package root>/docker/Dockerfile`. */
  readonly dockerfile?: string;
  /** The build context. Defaults to the Dockerfile's directory: the image copies nothing else. */
  readonly context?: string;
  readonly buildTimeoutMs?: number;
}

export interface ImageResolver {
  /** The tag for the Dockerfile as it stands right now, building it if it is not already present. */
  readonly resolve: () => ImageResolution;
  /** The tag alone, with no invocation at all. For a caller composing an argv it will not run. */
  readonly tag: () => string;
  /** The Dockerfile's full digest as it stands right now. */
  readonly hash: () => string;
}

/**
 * Create a resolver over one Dockerfile.
 *
 * The cache holds tags this resolver has already proven present, which is what makes a second request
 * at an unchanged hash cost nothing at all — not even an `image inspect`. A changed Dockerfile produces
 * a different tag, misses the cache, is found absent and is built once; the old tag stays cached and
 * stays valid, because it still describes an image that exists.
 */
export const createImageResolver = (options: ImageResolverOptions): ImageResolver => {
  const dockerfile = options.dockerfile ?? dockerfilePath();
  const context = options.context ?? dirname(dockerfile);
  const present = new Set<string>();

  const readHash = (): string => {
    try {
      return hashDockerfileContent(readFileSync(dockerfile));
    } catch (thrown: unknown) {
      throw new ImageBuildError(
        `${IMAGE_REPOSITORY}:<unknown>`,
        `the Dockerfile at ${dockerfile} could not be read (${
          thrown instanceof Error ? thrown.message : String(thrown)
        })`,
      );
    }
  };

  const resolve = (): ImageResolution => {
    const hash = readHash();
    const tag = imageTagForHash(hash);
    if (present.has(tag)) {
      return { tag, hash, built: false, reason: 'cached', dockerfile };
    }

    const inspected = options.invoke({
      subcommand: CONTAINER_SUBCOMMANDS.inspectImage,
      args: [tag],
    });
    if (inspected.status === 0) {
      present.add(tag);
      return { tag, hash, built: false, reason: 'present', dockerfile };
    }

    const build = options.invoke({
      subcommand: CONTAINER_SUBCOMMANDS.build,
      args: [
        '--tag',
        tag,
        '--file',
        dockerfile,
        '--label',
        `${IMAGE_DIGEST_LABEL}=${hash}`,
        // Explicit: the pinned base layer is not refreshed behind the tag's back (AD-11).
        '--pull=false',
        context,
      ],
      timeoutMs: options.buildTimeoutMs ?? CONTAINER_BUILD_TIMEOUT_MS,
    });
    if (build.status !== 0) {
      const detail = (build.stderr.trim() === '' ? build.stdout : build.stderr).trim();
      throw new ImageBuildError(tag, detail === '' ? `the build exited ${String(build.status)}` : detail);
    }
    present.add(tag);
    return { tag, hash, built: true, reason: 'absent', dockerfile };
  };

  return {
    resolve,
    tag: (): string => imageTagForHash(readHash()),
    hash: readHash,
  };
};
