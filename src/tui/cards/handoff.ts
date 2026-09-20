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
 * **The branch and the document are given to this card, never derived by it.** AD-22 gives branch naming a
 * single owner and says no other unit may infer a branch name; the takeover branch is named by
 * `src/engine/handoff.ts` and the document's path by the AD-9 paths. Neither is recorded in the
 * `handoff.recorded` payload today, so a reader that has them passes them in and one that does not gets a
 * card that says plainly they are not recorded — which is the honest answer, and a better one than a
 * renderer guessing at a branch pattern it does not own.
 */
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
  readonly location?: HandoffLocation;
}

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
  const location = input.location ?? {};
  const feature = view.feature ?? 'this feature';

  const why =
    whyFromNotices(view) ??
    `I stopped working on ${feature} and the log records no reason, so treat the work as unfinished ` +
      'rather than as abandoned for a known cause';
  const branch = location.branch ?? UNRECORDED_PRESENTATION;
  const document = location.document ?? UNRECORDED_PRESENTATION;
  const nextStep =
    location.branch === undefined || location.branch === null
      ? 'the work is wherever the run left it; the note names the worktree it was in'
      : `pick the work up with: git checkout ${location.branch}`;

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
