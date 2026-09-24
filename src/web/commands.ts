/**
 * The command route's handler: dispatch a posted control through the TUI's own table, and nothing else.
 *
 * AD-3 makes `invokeControlByKey` a total lookup over the `Command` enum by way of `CONTROL_BY_KEY`
 * (both keyed on the same single-character keystroke the TUI's `src/tui/input.ts` already dispatches
 * on), so a `key` this build does not recognise returns `null` from that one call — there is no second
 * table here to keep in sync, and no separate membership check before it: an unrecognised key is
 * reported as a refusal because `invokeControlByKey` itself said so, not because this module first
 * asked the same question a second way.
 *
 * AD-19 makes the durable intent file the only effect of a command, and `invokeControlByKey` already
 * is the renderer's whole write surface (see `src/tui/controls.ts`'s own header) — this module writes
 * nothing directly, calls nothing in `src/engine/`, and performs no second write.
 *
 * Two refusals this module *does* add, deliberately, because neither is the enum-membership check
 * AD-3 already makes free: a run id naming no run directory (matrix row 7 — a command for a run that
 * does not exist must be a clear refusal, never a raw exception), and an intent that would carry
 * required text it was not given (`ControlArgumentRequired`, thrown by `invokeControl` itself and
 * caught here rather than left to crash the request).
 */
import { existsSync } from 'node:fs';

import type { Principal } from '../contracts/index.js';
import { resolveOrchHome, runPaths } from '../runtime/index.js';
import type { RunPaths } from '../runtime/index.js';
import { ControlArgumentRequired, invokeControlByKey, loadShellView } from '../tui/index.js';
import type { ControlOutcome } from '../tui/index.js';

/**
 * Every command the web surface issues is attributed to this fixed local principal — "a single local
 * user" is the whole of AD-3's threat model, and the reconciler's own default principal for an
 * unattended timeout is the only other fixed principal this codebase declares, so this mirrors its
 * shape rather than inventing one.
 */
export const WEB_PRINCIPAL: Principal = Object.freeze({ kind: 'user', id: 'local' });

export interface PostCommandRequest {
  readonly runId: string;
  /** The control's single-character keystroke, exactly as `CONTROL_BY_KEY` indexes it. */
  readonly key: string;
  readonly argument?: string | null;
  readonly orchHome?: string;
}

export type PostCommandResult =
  | { readonly ok: true; readonly outcome: ControlOutcome }
  | { readonly ok: false; readonly status: 400 | 404; readonly reason: string };

const refuse = (status: 400 | 404, reason: string): PostCommandResult => ({ ok: false, status, reason });

/**
 * Post one command, exactly as `invokeControlByKey` would for the TUI, with `source: 'web'`.
 *
 * Refuses cleanly, rather than throwing, for every failure that is the *caller's* mistake: a malformed
 * run id, a run with no directory, an unrecognised key, or a control invoked without the text it
 * requires. Anything else — a genuine write failure this function cannot attribute to the request —
 * propagates to the caller, which is `src/web/server.ts`'s own catch-all, so it is reported as a server
 * error rather than a client one.
 */
export const postCommand = (request: PostCommandRequest): PostCommandResult => {
  const orchHome = request.orchHome ?? resolveOrchHome();

  let paths: RunPaths;
  try {
    paths = runPaths(request.runId, orchHome);
  } catch (error) {
    return refuse(400, error instanceof Error ? error.message : `"${request.runId}" is not a run id`);
  }

  if (!existsSync(paths.runDir)) {
    return refuse(404, `no run "${request.runId}" exists`);
  }

  // The same state the view routes already load (per the Design Notes sketch): the command route reads
  // it rather than deriving the feature and the in-flight step a second way.
  const view = loadShellView(paths.eventLog);
  if (view.feature === null) {
    return refuse(400, `run "${request.runId}" has not recorded a feature yet`);
  }

  try {
    const outcome = invokeControlByKey(
      request.key,
      {
        paths,
        feature: view.feature,
        currentStep: view.progress.currentStep,
        principal: WEB_PRINCIPAL,
        source: 'web',
      },
      request.argument ?? null,
    );
    return outcome === null
      ? refuse(400, `"${request.key}" is not a recognised control`)
      : { ok: true, outcome };
  } catch (error) {
    // Only `ControlArgumentRequired` is the caller's own mistake — a control invoked without the text
    // it requires. Anything else (a write failure, a filesystem error) is not the client's fault, so it
    // is left to propagate to the route's own 500 handling rather than being misreported as a 400.
    if (error instanceof ControlArgumentRequired) {
      return refuse(400, error.message);
    }
    throw error;
  }
};
