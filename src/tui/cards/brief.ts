/**
 * The morning brief: every in-flight feature, what each needs and what it cost, inside one screen.
 *
 * CAP-22's success criterion is that all in-flight features fit one screen without scrolling, and
 * "untested, 'fits one screen' is a wish". So the height is an argument, the brief returns lines bounded by
 * it, and a fleet that does not fit says how many features are not shown rather than overflowing quietly.
 * A person who can see eleven of twelve features and does not know there is a twelfth is worse off than one
 * who can see nine and knows there are three more.
 *
 * **The wrapper is injected, because the bound has to be measured over the lines the frame will draw.** A
 * brief that counted its own unwrapped lines would promise a bound it does not keep the moment a feature
 * name and a gate together exceed the terminal width. The frame's own `wrapLine` is what the shell passes
 * in; the default wraps nothing, which is correct for a caller that has already decided its lines fit.
 *
 * **What each needs, and what it cost.** "Needs" is the next gate the projection derived — prose, never a
 * percentage (R7) — and "cost" is the ambient trio R10 and R11 require — steps, consumed rate-limit budget,
 * elapsed against estimate — plus, since story 1-11 put them in the log, the tokens the run actually consumed
 * and the CLI's own reported figure. No currency *mark* appears anywhere, because R10 makes cost
 * subscription usage rather than money and AD-24 admits no currency ceiling; a run whose steps recorded no
 * usage reads `(not recorded)` rather than zero, because CAP-22's brief is where a person decides what to
 * abandon and an unmeasured run must not look like a free one.
 *
 * **A run whose log could not be read gets a line saying so.** That is the same choice `loadShellView`
 * already makes for a single run, applied to the list: one unreadable log costs that feature's line and
 * nothing else.
 */
import { MAX_FLEET_RUNS, inFlightRuns } from '../fleet.js';
import type { FleetRun, FleetView } from '../fleet.js';
import { statusFields } from '../status.js';

import type { CardBody } from './index.js';

/** One feature's line in the brief: what it is, what it needs, and what it has cost so far. */
export interface FleetEntry {
  readonly feature: string;
  /** What the run is waiting for, in a person's words (R7). */
  readonly needs: string;
  /** Steps, consumed rate-limit budget, elapsed against estimate (R10, R11). */
  readonly cost: string;
  /** The tokens and the reported figure the log records, or `(not recorded)` (R10). */
  readonly usage: string;
  /** Why this feature cannot be reported on, or `null` when it can. */
  readonly problem: string | null;
}

export interface BriefCard extends CardBody {
  readonly kind: 'brief';
  /** The entries that fit. */
  readonly entries: readonly FleetEntry[];
  /** How many in-flight features did not fit the screen. Stated, never dropped. */
  readonly notShown: number;
  /** How many in-flight features there are in total. */
  readonly inFlight: number;
  /** The height the brief was bounded to, so a caller can assert against what it asked for. */
  readonly height: number;
}

/** How a line is broken to fit the terminal. The frame's own wrapper, passed in rather than reimplemented. */
export type LineWrapper = (line: string) => readonly string[];

export interface BriefCardInput {
  readonly fleet: FleetView;
  /** The terminal's height, in rows. The bound the brief keeps. */
  readonly height?: number;
  readonly wrap?: LineWrapper;
  readonly now?: Date;
}

/** The height assumed when the terminal does not say. 24 rows is the oldest safe answer, and still true. */
export const DEFAULT_BRIEF_HEIGHT = 24;

/** What a feature is called when its log has not named one yet. Never a run id (R6). */
export const UNNAMED_FEATURE = '(a run that has not named its feature)';

/** One feature's line, folded from its view. */
export const fleetEntry = (run: FleetRun, now: Date): FleetEntry => {
  const view = run.view;
  const fields = statusFields(view, now);
  return {
    feature: view.feature ?? UNNAMED_FEATURE,
    needs: view.problem === null ? view.progress.nextGate : 'nothing can be said: its log could not be read',
    cost: `${fields.steps} · ${fields.budget} · ${fields.elapsed}`,
    usage: fields.tokens,
    problem: view.problem,
  };
};

/**
 * The lines one entry occupies before wrapping: what it needs, what it cost, what it consumed.
 *
 * Three rather than two, and the third is on its own row rather than appended to the cost row on purpose:
 * the height bound is measured over wrapped lines, so a single long row and two short ones cost the same
 * screen, and two labels on one row is what makes a 40-column brief unreadable.
 */
const entryLines = (entry: FleetEntry): readonly string[] => [
  `${entry.feature} — needs: ${entry.needs}`,
  `  cost: ${entry.cost}`,
  `  usage: ${entry.usage}`,
];

/**
 * Build the morning brief, bounded by the terminal height.
 *
 * Every in-flight feature is listed, and then the tail is dropped until the whole brief measures within the
 * height, with the number dropped reported. Pure — `now` is passed in, so the elapsed column is
 * reproducible.
 */
export const buildBriefCard = (input: BriefCardInput): BriefCard => {
  const height = input.height ?? DEFAULT_BRIEF_HEIGHT;
  const wrap = input.wrap ?? ((line: string): readonly string[] => [line]);
  const now = input.now ?? new Date();
  const runs = inFlightRuns(input.fleet);
  const all = runs.map((run) => fleetEntry(run, now));

  /**
   * The count that was not read, stated in the **title**, which is the one row never given up.
   *
   * `foldFleet` is bounded (`MAX_FLEET_RUNS`), so on a machine with more run directories than that the
   * brief is a fold of the most recent ones and not of everything. Saying so in a body line would be
   * saying so in the rows the height bound drops first, which is the same as not saying it.
   */
  const notRead = input.fleet.notRead;
  const title =
    `morning brief — ${String(all.length)} feature${all.length === 1 ? '' : 's'} in flight` +
    (notRead > 0 ? `, of the ${String(MAX_FLEET_RUNS)} most recent runs` : '');
  const titleRows = wrap(title).length;

  if (all.length === 0) {
    return {
      kind: 'brief',
      title:
        'morning brief — nothing is in flight' +
        (notRead > 0 ? `, among the ${String(MAX_FLEET_RUNS)} most recent runs` : ''),
      entries: [],
      notShown: 0,
      inFlight: 0,
      height,
      // One sentence, and no table: an empty table with headings is a frame borrowed from a case that is
      // not this one, and it makes a person look for rows that do not exist.
      lines: ['no feature is running, so there is nothing to report and nothing to decide'],
    };
  }

  /**
   * The bound is checked over the *finished* line list, not estimated while building it.
   *
   * The overflow line's own height depends on the number it reports and on the width it wraps at, so an
   * estimate of "one row for the tail" is wrong at 40 columns exactly when the bound matters most. Dropping
   * the last entry until the whole thing measures within the height costs a few passes over a list that is
   * at most a screenful, and it is the difference between a measured screen and a hopeful one.
   */
  const overflowLine = (count: number): string =>
    `and ${String(count)} more in flight, not shown: this terminal has ${String(height)} rows`;

  /**
   * The same fact in the fewest cells it can be said in, for a terminal with no room for the long form.
   *
   * It drops the explanation and keeps the count, because the count is the part a person cannot infer and
   * the explanation is the part they are looking at.
   */
  const shortOverflowLine = (count: number): string => `and ${String(count)} more, not shown`;

  const rowsOf = (lines: readonly string[]): number => lines.flatMap((line) => wrap(line)).length;

  const bodyFor = (entries: readonly FleetEntry[], short: boolean): readonly string[] => {
    const hidden = all.length - entries.length;
    return [
      ...entries.flatMap((entry) => entryLines(entry)),
      ...(hidden > 0 ? [short ? shortOverflowLine(hidden) : overflowLine(hidden)] : []),
    ];
  };

  /**
   * The rows the body may occupy: the height, less the title, which is never given up.
   *
   * The title carries the count of everything in flight, so it is the one row that stays honest when
   * nothing else fits — and R3 makes a headline that stands alone the point of it.
   */
  const room = Math.max(height - titleRows, 0);

  let shown = [...all];
  while (shown.length > 0 && rowsOf(bodyFor(shown, false)) > room) shown = shown.slice(0, -1);

  /**
   * The floor the loop above cannot reach, and where the bound used to break.
   *
   * `while (shown.length > 0 && …)` stops at zero entries **without re-checking**, so when the wrapped
   * title plus the wrapped overflow line alone exceeded the height the card returned more rows than it
   * advertised — measured, the twelve-run fixture at heights 1, 2 and 3 all drew three rows at 40 columns.
   * The 80-column case never reached that shape, which is why nothing caught it: at 80 the title is one row
   * and so is the overflow line.
   *
   * So the tail shrinks when the entries have run out, and gives way entirely when even the short form does
   * not fit. Losing the line is not losing the fact: the title states how many features are in flight and
   * none are listed beneath it, which is visibly incomplete rather than quietly wrong — and a card that
   * overflowed its own bound would put the *first* rows of the terminal, including whatever is above it,
   * out of reach.
   */
  let lines = bodyFor(shown, false);
  if (rowsOf(lines) > room) lines = bodyFor(shown, true);
  if (rowsOf(lines) > room) lines = [];

  const notShown = all.length - shown.length;

  return { kind: 'brief', title, entries: shown, notShown, inFlight: all.length, height, lines };
};
