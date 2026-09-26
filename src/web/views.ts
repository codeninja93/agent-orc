/**
 * Thin read wrappers over the TUI's own projections, shaped as the JSON the web routes return.
 *
 * AD-4 makes `loadShellView`/`foldFleet` the sole fold from `events.jsonl` to view state, and this
 * story must not build a second one — "a divergence between what the TUI shows and what the web
 * surface shows would be exactly the failure AD-4 exists to prevent". So this module adds no
 * projection logic of its own: it resolves the AD-9 paths for a run and hands the result of the
 * existing fold straight back. `ShellView` and `FleetView` are plain data (strings, numbers, nested
 * plain objects and arrays), so `JSON.stringify` of either is already the response body — nothing
 * here reshapes a field.
 */
import { resolveOrchHome, runPaths } from '../runtime/index.js';
import { foldFleet, loadShellView } from '../tui/index.js';
import type { FleetView, ShellView } from '../tui/index.js';

/**
 * A run's current view, exactly as `loadShellView` produces it.
 *
 * A run id that does not resolve to a safe path segment throws `UnsafePathSegmentError` (from
 * `runPaths`); a run id that is well-formed but has no directory yet folds to an idle view, the same
 * way `loadShellView` already answers an absent log — a run about to exist is not a failure.
 */
export const runView = (runId: string, orchHome: string = resolveOrchHome()): ShellView => {
  const paths = runPaths(runId, orchHome);
  return loadShellView(paths.eventLog);
};

/** Every run on this machine, exactly as `foldFleet` produces it. */
export const fleetView = (orchHome: string = resolveOrchHome()): FleetView => foldFleet({ orchHome });
