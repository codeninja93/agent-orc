/**
 * The wrapper that puts **a command** inside AD-20's boundary, and returns a tier-0 or tier-1 plan
 * untouched.
 *
 * **Repointed by ADR-004, not rebuilt.** ADR-001 was explicit about what survives: "the flag set, the
 * image, the mount allow-list, the `--rm` rule and the AD-31 suite are all unchanged and all still
 * correct. What changes is the argv placed inside: a command, not `claude -p`." Every one of those
 * still lives in `flags.ts`, `image.ts` and `lifecycle.ts` and is composed by `composeRunArgs`
 * exactly as before; story 1-5's AD-31 assertion suite drives `composeRunArgs` directly and does not
 * touch this file. What changed here is two fields of one request object.
 *
 * **Why it had to change at all.** Until ADR-004 this wrapper substituted the image's own
 * `/usr/local/bin/claude` for the host's interpreter and ran story 1-4's CLI argv inside the
 * container — which is the pre-ADR-001 design, and it is unsatisfiable: the Claude subscription
 * credential is in the macOS keychain, so no mount can put it inside, and AD-1 refuses API-key mode
 * positively. A container that cannot authenticate is a step that cannot run. So `claude -p` runs on
 * the host, confined at the configuration level (`--restricted`, `--add-dir`, `--tools`), and what
 * goes inside the boundary is the untrusted party the threat model was written for: a command.
 *
 * Four decisions in this file are the ones a plausible alternative gets wrong.
 *
 * **Nothing here composes a flag.** `composeRunArgs` owns the whole AD-20 set and refuses `--rm`,
 * `--detach`, a mount outside the allow-list and a credential-shaped environment name. This file
 * chooses the image, the name, the two mountable directories and the argv inside, and that is all it
 * is allowed to choose.
 *
 * **The worktree is mounted at its own absolute path.** A declared command is a line a person wrote
 * for their own repository, and it may name a path in it — a config file, a coverage output, a
 * fixture directory. Mounting the worktree at, say, `/workspace` would silently break every one of
 * those, and mounting host path onto the same container path makes the question not arise.
 *
 * **The plan is generic over its own shape, and no engine type is imported.** `src/container/` may
 * import only `src/contracts/`, `src/runtime/` and `node:` builtins, so the wrapper is *generic over*
 * the plan it is handed — `<P extends ContainedCommandPlan>(plan: P) => P` — and preserves every
 * field its caller added without this package knowing what they are. It is no longer assignable to
 * story 1-4's `SpawnWrapper`, and that is the change ADR-004 makes rather than an omission: a
 * wrapper the *spawner* could still be handed is a wrapper that would put `claude -p` back inside a
 * container it cannot authenticate from, and the type system is the right place for that to be
 * impossible.
 *
 * **The exit code is not touched.** The invocation is foreground — `--detach` is refused outright —
 * so the runtime forwards the command's exit status, which is the fact a gate's pass or failure is
 * decided by. Remapping it here would make a failing gate indistinguishable from a container that
 * would not start.
 */
import { makeError } from '../contracts/index.js';
import type { OrchError } from '../contracts/index.js';
import { resolveOrchHome, worktreesDir } from '../runtime/index.js';

import { composeRunArgs, isStrictlyWithin } from './flags.js';
import type { ContainerRunRequest } from './flags.js';
import { createImageResolver } from './image.js';
import type { ImageResolver } from './image.js';
import { containerNameFor, ensureSessionDir, sessionDirFor } from './lifecycle.js';
import { CONTAINER_SUBCOMMANDS, requireContainerRuntime } from './runtime.js';
import type { ContainerInvoker, ContainerRuntime } from './runtime.js';
import { selectTier, tierUsesContainer } from './tiers.js';
import type { ChangeShape, IsolationTier } from './tiers.js';

/**
 * The absolute path of the CLI inside the image.
 *
 * A constant rather than a `PATH` lookup: `--restricted` and a read-only root mean the container's
 * `PATH` is not something this system should depend on resolving, and an absolute entry point is what
 * AD-28 requires of the host side for the same reason.
 *
 * **Kept after ADR-004, though this wrapper no longer runs it.** The image still ships the CLI and
 * the AD-31 assertion suite still executes it from inside the container — that check is what proves
 * the image is the one the Dockerfile defines, and it is one of the six the stage-1 gate requires.
 * Removing the constant would edit that suite, which ADR-001 says is unchanged and still correct.
 */
export const IMAGE_CLI_PATH = '/usr/local/bin/claude';

/** The absolute Node inside the image, published to the step through `ORCH_NODE` as AD-28 requires. */
export const IMAGE_NODE_PATH = '/usr/local/bin/node';

/**
 * What a caller hands this wrapper: a command it means to run, and where.
 *
 * A structural subset, so the wrapper accepts a richer plan without importing its caller's type. The
 * fields are the ones AD-20 needs: what to run, where, as whom, and which run and step it belongs to.
 *
 * `contained` is the whole of what ADR-004 changed. It is the argv to place **inside** the boundary —
 * program first, arguments after — and it replaces the `cliArgs` this interface carried when the
 * thing inside was `claude -p`. The rename is deliberate rather than cosmetic: a field still called
 * `cliArgs` would invite the next caller to hand this wrapper an agent invocation again, and the
 * whole of ADR-004 is that an agent invocation cannot go in there.
 */
export interface ContainedCommandPlan {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  /** The argv to run inside the container: the program, then its arguments. Never empty. */
  readonly contained: readonly string[];
  readonly step: string;
  readonly run: string;
}

/**
 * The wrapper's type: identity-preserving over any plan shape.
 *
 * A generic that returns its own parameter type, so a caller's extra fields survive the wrap and
 * nothing can be lost to a partial spread.
 */
export type PlanWrapper = <P extends ContainedCommandPlan>(plan: P) => P;

/** What the wrapper did with one plan, for the caller's event log. Emitted, never written here. */
export interface WrapRecord {
  readonly run: string;
  readonly step: string;
  readonly tier: IsolationTier;
  readonly wrapped: boolean;
  /** Present only for tier 2. */
  readonly image: string | null;
  readonly containerName: string | null;
  readonly worktree: string;
  readonly sessionDir: string | null;
  readonly reason: string;
}

/** A tier-2 plan could not be confined, so it is not run at all. */
export class TierTwoUnconfinableError extends Error {
  readonly code = 'container.start_failed';
  readonly orchError: OrchError;

  constructor(step: string, detail: string) {
    const message =
      `Refusing to run step "${step}" unconfined: ${detail}. A tier-2 step runs inside the AD-20 ` +
      'container or it does not run; falling back to the host is the failure mode containment exists ' +
      'to prevent.';
    super(message);
    this.name = 'TierTwoUnconfinableError';
    this.orchError = makeError(this.code, message, detail);
  }
}

export interface ContainerWrapperOptions {
  /**
   * The tier this plan runs at: a constant, or a function of the plan.
   *
   * Required and never defaulted. A default of 2 would containerise every typo (the tax the
   * architecture rejects) and a default of 0 would silently un-confine a feature; the tier is a
   * decision the caller has already made, and {@link tierForShape} is how a caller derives it.
   */
  readonly tier: IsolationTier | ((plan: ContainedCommandPlan) => IsolationTier);
  /** The single invocation path. Required for tier 2, since the image has to be resolved. */
  readonly invoke?: ContainerInvoker;
  /** The located runtime. Resolved from `PATH` when omitted. */
  readonly runtime?: ContainerRuntime;
  /** A resolver, or a tag for a caller that has already resolved one. */
  readonly image?: ImageResolver | string;
  readonly orchHome?: string;
  /**
   * The worktree to mount. Defaults to the plan's cwd, which story 1-6 sets to the run worktree.
   *
   * Whatever it resolves to is refused unless it is inside `ORCH_HOME/worktrees/` (AD-9), because this
   * is the one writable mount: a cwd the engine set to a target repository would otherwise become a
   * writable bind mount of that repository.
   */
  readonly worktreeFor?: (plan: ContainedCommandPlan) => string;
  /** The run's session directory. Defaults to `ORCH_HOME/runs/<run-id>/session`. */
  readonly sessionDirFor?: (plan: ContainedCommandPlan) => string;
  /**
   * The attempt number, for the container's name.
   *
   * Defaults to how many times *this* wrapper has already wrapped this run and step. A fixed default of
   * 1 named every retry's container the same thing, and since `--rm` is never composed (AD-20) the
   * first attempt's container still exists — so the retry died at container start with "name already in
   * use" rather than running. A caller that tracks attempts itself passes them and wins.
   */
  readonly attemptFor?: (plan: ContainedCommandPlan) => number;
  readonly memoryLimit?: string;
  readonly pidsLimit?: number;
  readonly seccompProfile?: string;
  /** Observability: called once per plan, wrapped or not. The caller records it (AD-29). */
  readonly onWrap?: (record: WrapRecord) => void;
}

/** The tier a change shape runs at, refusing a softened tier and a container for a tier-0 change. */
export const tierForShape = (shape: ChangeShape): IsolationTier => selectTier(shape).tier;

/**
 * Create the wrapper the engine passes as its `wrap` option.
 *
 * Tiers 0 and 1 return the plan itself — the same object, not a copy — so "the returned spawn plan is
 * identical to the input" is true by reference and no field can be lost to a partial spread.
 */
export const createContainerWrapper = (options: ContainerWrapperOptions): PlanWrapper => {
  const resolveTier = (plan: ContainedCommandPlan): IsolationTier =>
    typeof options.tier === 'function' ? options.tier(plan) : options.tier;

  const imageResolver: ImageResolver | null =
    typeof options.image === 'object'
      ? options.image
      : options.image === undefined && options.invoke !== undefined
        ? createImageResolver({ invoke: options.invoke })
        : null;

  const imageTag = (step: string): string => {
    if (typeof options.image === 'string') return options.image;
    if (imageResolver === null) {
      throw new TierTwoUnconfinableError(
        step,
        'no image and no container invoker were supplied, so the locally built executor image ' +
          '(AD-11) cannot be resolved',
      );
    }
    return imageResolver.resolve().tag;
  };

  /** How many times this wrapper has wrapped each run and step, which is that step's attempt count. */
  const attempts = new Map<string, number>();

  const wrap = <P extends ContainedCommandPlan>(plan: P): P => {
    const tier = resolveTier(plan);
    const worktree = options.worktreeFor?.(plan) ?? plan.cwd;

    if (!tierUsesContainer(tier)) {
      options.onWrap?.({
        run: plan.run,
        step: plan.step,
        tier,
        wrapped: false,
        image: null,
        containerName: null,
        worktree,
        sessionDir: null,
        reason: `tier ${String(tier)} runs on the host: no container is involved`,
      });
      return plan;
    }

    const contained = plan.contained[0];
    if (contained === undefined) {
      throw new TierTwoUnconfinableError(
        plan.step,
        'the plan carries no argv to place inside the container. A container with no command runs ' +
          "the image's own CMD, which is `claude --version` — so the step would report a clean exit " +
          'having done nothing, which is the one outcome indistinguishable from success',
      );
    }
    const orchHome = options.orchHome ?? resolveOrchHome(plan.env);
    // The one writable mount, refused unless AD-9 says a run worktree can be there. The allow-list in
    // `flags.ts` asks the same question of the request it is given; this is the side that can still name
    // the *step* in its refusal, and a tier-2 step that cannot be confined does not run at all.
    if (!isStrictlyWithin(worktreesDir(orchHome), worktree)) {
      throw new TierTwoUnconfinableError(
        plan.step,
        `its worktree ${worktree} is not inside ${worktreesDir(orchHome)}, so mounting it writable ` +
          'would hand the container a directory AD-20 never admitted — the run worktree is the only ' +
          'checkout a step may edit (AD-23)',
      );
    }
    // A bind mount does not create its source: without this the runtime refuses the invocation with
    // "bind source path does not exist" and the step never starts.
    const sessionDir = ensureSessionDir(options.sessionDirFor?.(plan) ?? sessionDirFor(plan.run, orchHome));
    const priorAttempts = attempts.get(`${plan.run} ${plan.step}`) ?? 0;
    attempts.set(`${plan.run} ${plan.step}`, priorAttempts + 1);
    const attempt = options.attemptFor?.(plan) ?? priorAttempts + 1;
    const containerName = containerNameFor(plan.run, plan.step, attempt);
    const runtime = options.runtime ?? requireContainerRuntime(plan.env);
    const image = imageTag(plan.step);

    const request: ContainerRunRequest = {
      image,
      run: plan.run,
      step: plan.step,
      attempt,
      containerName,
      worktree,
      sessionDir,
      // ADR-004's one change to this request: the command the step runs, not the image's own CLI.
      // Split here rather than in `flags.ts` because `composeRunArgs` takes a program and its
      // arguments, and the caller holds one argv — a program with no arguments is legal and an
      // empty argv is refused above, so the first element always exists.
      command: contained,
      commandArgs: plan.contained.slice(1),
      // AD-28 inside the container: the absolute interpreter is the image's, not the host's.
      env: { ...plan.env, ORCH_NODE: IMAGE_NODE_PATH },
      phase: 'execution',
      // The same ORCH_HOME the two mountable directories were derived from, so the allow-list in
      // `flags.ts` checks them against the machine this run belongs to rather than the ambient default.
      orchHome,
      ...(options.memoryLimit === undefined ? {} : { memoryLimit: options.memoryLimit }),
      ...(options.pidsLimit === undefined ? {} : { pidsLimit: options.pidsLimit }),
      ...(options.seccompProfile === undefined ? {} : { seccompProfile: options.seccompProfile }),
    };

    const args = [...CONTAINER_SUBCOMMANDS.run, ...composeRunArgs(request)];

    options.onWrap?.({
      run: plan.run,
      step: plan.step,
      tier,
      wrapped: true,
      image,
      containerName,
      worktree,
      sessionDir,
      reason: 'tier 2 runs inside the AD-20 container',
    });

    // The caller's own fields ride through untouched: only `command` and `args` change, and
    // `contained` stays exactly what the caller built, so an assertion about what will run inside
    // has something to compare the composed vector against.
    return { ...plan, command: runtime.command, args };
  };

  return wrap;
};
