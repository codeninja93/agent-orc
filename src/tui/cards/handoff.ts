/**
 * The handoff card: a colleague's note, not a stack trace.
 *
 * `interface-contract.md` asks for exactly that register, and R3 asks for a headline that stands alone, so
 * this card opens with why the run stopped in a sentence and never with an error code. The code is a fact
 * about the system's own vocabulary and it goes at the end, where a person who wants it will look.
 *
 * The full document `src/engine/handoff.ts` writes is the long form — what was attempted, how far it got,
 * where the work is, what to do next. This card is the short form that points at it: a person reading a
 * terminal needs to know that the note exists, where their work is, and that nothing was thrown away.
 *
 * **The branch and the document are derived from the run id, through the units that own their names.**
 * Story 1-10 had to be handed both, because AD-22 forbids a renderer inferring a branch name and
 * `takeoverBranchFor` lived in `src/engine/handoff.ts`, which the spine forbids `src/tui/` importing. Story
 * 1-11 closed that by moving the *name* to `src/runtime/branches.ts` — so this card now calls the one
 * function that names the branch and the one module that names the path, and infers nothing. AD-22 is
 * satisfied because there is still exactly one owner of each name, which is what the rule is about.
 *
 * **Nothing was added to the `handoff.recorded` payload, and that was the point.** Story 1-10 recommended
 * adding `branch` and `document` to it. Both are pure functions of the run id, which every envelope already
 * carries verbatim — `run` is on the AD-21 verbatim allow-list — so the facts were already reconstructable
 * and only the functions were out of reach. Adding the fields would have put a bare 26-character ULID inside
 * a payload string, and AD-21's entropy sweep replaces it: `orch/takeover/<ulid>` measures 5.07 bits per
 * character against the sweep's 3.5 threshold, so the payload would have read `[redacted]` and the only
 * escape would have been a wider allow-list, which AD-21 admits no remedy for.
 *
 * **The card stays pure, so the derivation takes its inputs rather than reading an environment.** The run id
 * comes from an envelope the caller folded; `ORCH_HOME` comes from the caller too. Without the run id the
 * card says the branch is not recorded rather than guessing; with the run id but no `ORCH_HOME` it names the
 * branch and says the document's path is not recorded, because a path resolved against the wrong home would
 * send a person to a file that is not there.
 */
import { runPaths, takeoverBranchOrNull } from '../../runtime/index.js';
import { UNRECORDED_PRESENTATION } from '../projection.js';
import type { ShellView } from '../projection.js';

import type { CardBody } from './index.js';

/** Where a handed-off run's work and note are, as their owners named them. */
export interface HandoffLocation {
  /** `orch/takeover/<run-id>` — an ordinary git branch, named by the escape hatch (AD-22). */
  readonly branch?: string | null;
  /** `runs/<run-id>/HANDOFF.md` — from the AD-9 paths, never spelled by a card. */
  readonly document?: string | null;
}

export interface HandoffCard extends CardBody {
  readonly kind: 'handoff';
  /** Why the run stopped, in a sentence, as the log recorded it. */
  readonly why: string;
  readonly branch: string;
  readonly document: string;
  /** What a person does next, in their own tools. */
  readonly nextStep: string;
}

export interface HandoffCardInput {
  readonly view: ShellView;
  /** An explicitly known location. Wins over the derivation, for a caller that has the escape outcome. */
  readonly location?: HandoffLocation;
  /**
   * The run id, read out of an event envelope.
   *
   * Not on `ShellView`, deliberately: R6 keeps the run id out of the view entirely so no render can require
   * a person to know one, and `tests/tui.projection.test.ts` asserts the view never carries it. A caller
   * that has folded a log has the envelope, so it passes the id in for the derivation and the view stays
   * free of it.
   */
  readonly run?: string | null;
  /** `ORCH_HOME`, so the document's path is resolved by the module that owns the AD-9 layout. */
  readonly orchHome?: string;
}

/**
 * Where the work and the note are, derived from the run id through their owners.
 *
 * Each half fails to `null` independently, because they need different things: the branch needs only a run
 * id that is a safe path segment, and the document needs the home as well.
 */
const derivedLocation = (input: HandoffCardInput): HandoffLocation => {
  const run = input.run ?? null;
  const branch = takeoverBranchOrNull(run);
  const orchHome = input.orchHome;
  let document: string | null = null;
  if (run !== null && branch !== null && orchHome !== undefined) {
    try {
      document = runPaths(run, orchHome).handoffDocument;
    } catch {
      // A run id no path could be built from is stated as unrecorded, never guessed at: a card must not
      // throw at a value it read out of a log.
      document = null;
    }
  }
  return { branch, document };
};

/**
 * The fold already turned the `handoff.recorded` line into a sentence, and this is its one reader.
 *
 * Reading the notice rather than re-deriving the sentence from the payload keeps one spelling of one fact:
 * the notice a person sees in the shell's own list and the headline on this card are the same words,
 * because they are literally the same string.
 */
const HANDOFF_NOTICE_MARK = 'handed off';

const whyFromNotices = (view: ShellView): string | null =>
  [...view.notices].reverse().find((notice) => notice.text.includes(HANDOFF_NOTICE_MARK))?.text ?? null;

/**
 * Build the handoff card.
 *
 * Pure. A run whose log records no hand-off reason still gets a card that says so: the feature state is
 * what put this card on the screen, and a card that rendered nothing because the reason was missing would
 * leave a person with a stopped run and no explanation at all.
 */
export const buildHandoffCard = (input: HandoffCardInput): HandoffCard => {
  const view = input.view;
  const given = input.location ?? {};
  const derived = derivedLocation(input);
  // An explicitly given location wins: a caller holding the escape hatch's own outcome knows which branch
  // the work actually landed on, and the derivation only knows which branch it would have been named.
  const knownBranch = given.branch ?? derived.branch ?? null;
  const knownDocument = given.document ?? derived.document ?? null;
  const feature = view.feature ?? 'this feature';

  const why =
    whyFromNotices(view) ??
    `I stopped working on ${feature} and the log records no reason, so treat the work as unfinished ` +
      'rather than as abandoned for a known cause';
  const branch = knownBranch ?? UNRECORDED_PRESENTATION;
  const document = knownDocument ?? UNRECORDED_PRESENTATION;
  const nextStep =
    knownBranch === null
      ? 'the work is wherever the run left it; the note names the worktree it was in'
      : `pick the work up with: git checkout ${knownBranch}`;

  const lines = [
    why,
    `I have stopped working on ${feature} and left everything where it is. Nothing was merged, and ` +
      'nothing was thrown away.',
    `your work is on the branch: ${branch}`,
    `the full note, in prose: ${document}`,
    nextStep,
    'this run will not restart itself, and no later pass picks a handed-off run back up',
  ];

  return {
    kind: 'handoff',
    title: `${feature} — handed off to you`,
    why,
    branch,
    document,
    nextStep,
    lines,
  };
};
