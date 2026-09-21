/**
 * The seam story 1-4 left: a `SpawnWrapper` that confines a tier-2 step and returns tiers 0 and 1
 * untouched.
 *
 * Story 1-4 builds a {@link WrappablePlan} — a command, an argument vector, a cwd, an environment, and
 * the CLI argv on its own — and runs whatever the wrapper returns. Filling that seam from *outside*
 * `src/engine/` is the mechanism, not a stylistic choice: the engine suite asserts that no file under
 * `src/engine/` contains the container runtime's name, comments included, so the only way the runtime
 * can be named at all is here.
 *
 * Four decisions in this file are the ones a plausible alternative gets wrong.
 *
 * **The type is never imported from the engine.** `src/container/` may import only `src/contracts/`,
 * `src/runtime/` and `node:` builtins, so `SpawnWrapper` cannot be referenced by name. The wrapper is
 * instead *generic over* the plan it is handed — `<P extends WrappablePlan>(plan: P) => P` — which is
 * structurally assignable to `(plan: SpawnPlan) => SpawnPlan` and preserves every field the engine
 * added without this package knowing what they are. `tests/container.wrapper.test.ts` assigns it to a
 * real `SpawnWrapper`, so the compatibility is proven by the typechecker rather than asserted in prose.
 *
 * **The worktree is mounted at its own absolute path.** The CLI argv the engine built already names
 * host paths — the typed input file, an MCP config, the prompt's reference to the input file. Mounting
 * the worktree at, say, `/workspace` would require rewriting every one of those, and a path this
 * package failed to rewrite becomes a step that cannot find its own input. Mounting host path onto the
 * same container path makes the rewrite unnecessary, and the only substitution left is the interpreter.
 *
 * **The interpreter is substituted, not rewritten.** The host's Node and the host's CLI entry point do
 * not exist inside the image, so the wrapper drops the host interpreter prefix and runs the image's own
 * CLI with `plan.cliArgs` — which is exactly why story 1-4 exposes `cliArgs` separately from `args`.
 * Every AD-1 flag survives untouched; `--restricted` and `--strict-mcp-config` in particular, which
 * story 1-4's suite now validates against the *executed* vector, so dropping one is a failing test
 * there rather than a silently widened permission surface here.
 *
 * **The exit code is not touched.** The invocation is foreground — `--detach` is refused outright — so
 * the runtime forwards the container's exit status, and a signalled step arrives at story 1-4 as
 * `128 + n`, which `signalFromExitCode` translates back into `interrupted`. Remapping or swallowing the
 * code here would make `interrupted` unreachable and AD-8's resume dead code: the same failure 1-4's
 * review found at this seam, from the other side.
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
 */
export const IMAGE_CLI_PATH = '/usr/local/bin/claude';

/** The absolute Node inside the image, published to the step through `ORCH_NODE` as AD-28 requires. */
export const IMAGE_NODE_PATH = '/usr/local/bin/node';

/**
 * The part of story 1-4's `SpawnPlan` this wrapper reads.
 *
 * A structural subset, so the wrapper accepts the engine's richer plan without importing its type. The
 * fields are the ones AD-20 needs: what to run, where, as whom, and which run and step it belongs to.
 */
export interface WrappablePlan {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  /** The CLI argv alone, before any interpreter or wrapper prefixed it. */
  readonly cliArgs: readonly string[];
  readonly step: string;
  readonly run: string;
}

/**
 * The wrapper's type: identity-preserving over any plan shape.
 *
 * Assignable to story 1-4's `SpawnWrapper` — `(plan: SpawnPlan) => SpawnPlan` — because a generic that
 * returns its own parameter type satisfies both the contravariant parameter and the covariant return.
 */
export type PlanWrapper = <P extends WrappablePlan>(plan: P) => P;

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
  readonly tier: IsolationTier | ((plan: WrappablePlan) => IsolationTier);
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
  readonly worktreeFor?: (plan: WrappablePlan) => string;
  /** The run's session directory. Defaults to `ORCH_HOME/runs/<run-id>/session`. */
  readonly sessionDirFor?: (plan: WrappablePlan) => string;
  /**
   * The attempt number, for the container's name.
   *
   * Defaults to how many times *this* wrapper has already wrapped this run and step. A fixed default of
   * 1 named every retry's container the same thing, and since `--rm` is never composed (AD-20) the
   * first attempt's container still exists — so the retry died at container start with "name already in
   * use" rather than running. A caller that tracks attempts itself passes them and wins.
   */
  readonly attemptFor?: (plan: WrappablePlan) => number;
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
  const resolveTier = (plan: WrappablePlan): IsolationTier =>
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

  const wrap = <P extends WrappablePlan>(plan: P): P => {
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
      // The image's own CLI, with the AD-1 argv untouched. Never the host's interpreter.
      command: IMAGE_CLI_PATH,
      commandArgs: plan.cliArgs,
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

    // The engine's own fields ride through untouched: only the command and the argv change, and
    // `cliArgs` stays exactly what story 1-4 built so its executed-vector assertions still hold.
    return { ...plan, command: runtime.command, args };
  };

  return wrap;
};
