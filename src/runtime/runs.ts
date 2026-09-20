/**
 * Which runs exist under `ORCH_HOME/runs/`.
 *
 * One function, moved out of `src/engine/checkpoint.ts` for the reason every other relocation in stories
 * 1-9 and 1-10 happened: CAP-22's morning brief is a fold over *every* in-flight feature, so the fold has
 * to enumerate the run directories — and the spine's dependency graph gives `tui -> contracts, runtime`
 * with no edge to the engine. Enumerating a directory AD-9 lays out is a durable-file concern the runtime
 * already owns; deciding what to do with a run is not, and nothing of that kind moved. `src/engine/
 * checkpoint.ts` re-exports the name, so the reconciler's own caller is unchanged.
 *
 * It is also the only place in the TUI's reach that touches `node:fs` for a directory, which is
 * deliberate: `tests/tui.projection.test.ts` asserts that no file in `src/tui/` names `node:fs` at all,
 * because a renderer reaching the filesystem directly is how a second read path — and eventually a second
 * write path — gets built by accident.
 */
import { readdirSync } from 'node:fs';

/**
 * Every run id with a directory under `ORCH_HOME/runs/`, in ULID order, which is chronological.
 *
 * An unreadable or absent directory answers with no runs rather than throwing: a machine with nothing run
 * on it yet is the ordinary first case, not an error, and a brief that crashed on it would be a brief
 * nobody could open before their first feature.
 */
export const listRunIds = (runsDirectory: string): string[] => {
  let entries: string[];
  try {
    entries = readdirSync(runsDirectory, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
  return entries.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
};
