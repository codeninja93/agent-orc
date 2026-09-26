/**
 * Story 4-4 — the fleet-wide answer to "which of my runs need me right now", and literal silence when
 * the answer is none.
 *
 * `runsNeedingAttention` (`../fleet.js`) is the fold; this is the second, separate invocation that
 * renders it, mirroring how the morning brief (`./brief.js`) is a separate invocation from `cardForView`
 * rather than a seventh branch inside it. **This is deliberately not a `Card`** (Boundaries):
 * `cardForView` answers which surface *one open run's* screen shows, and this answers a fleet-wide
 * question no single view can decide — like the brief, it is a card-shaped structure a person, or a
 * future automated poller, reads on its own.
 *
 * A run id is never rendered here (R6): every entry is addressed by feature name, falling back to
 * `UNNAMED_FEATURE` exactly as the brief does, because it is the same rule applied to the same absence.
 */
import { MAX_FLEET_RUNS, runsNeedingAttention } from '../fleet.js';
import type { AttentionEntry, AttentionReason, FleetView } from '../fleet.js';
import { handoffSentence } from '../projection.js';

import { UNNAMED_FEATURE } from './brief.js';

/** One run's line: its feature, why it needs a person, and the sentence that says so. */
export interface AttentionCardEntry {
  readonly feature: string;
  readonly reason: AttentionReason;
  /** The sentence a person reads for this entry — never a run id, never a percentage. */
  readonly detail: string;
}

/**
 * A card-shaped structure, not a member of `Card` (Boundaries) — not because it is fleet-wide (`BriefCard`
 * is also fleet-wide and *is* a member of `CARD_KINDS`/`Card`), but because `src/tui/cards.tsx`'s
 * `CardView` switch is documented as total over `Card['kind']` ("a seventh surface is a compile error here
 * rather than a card that silently draws nothing"): joining `CARD_KINDS`/`Card` would force an
 * `AttentionCardView` Ink component into existence purely to satisfy that exhaustiveness check, for a card
 * nothing mounts yet — out of scope for this story.
 */
export interface AttentionCard {
  readonly kind: 'attention';
  /** The headline, which stands alone (R3): how many runs need a person, or that none do. */
  readonly title: string;
  readonly lines: readonly string[];
  readonly entries: readonly AttentionCardEntry[];
}

/**
 * The sentence a person reads for one entry, chosen from what the fold already knows rather than
 * restating `reason` as a word.
 *
 * An unreadable log states the problem the reader gave; a hand-off states the same sentence the hand-off
 * card itself would (`handoffSentence`), so the two surfaces never disagree about the same fact; a
 * hibernation and a completion get their own plain sentence because `nextGateFor`'s own text for both
 * ("nothing: …") is written for a person already looking at that one run and would read as contradicting
 * this card's whole point — that something here does need them. A decision point's sentence is the one
 * `nextGateFor` already computed (`view.progress.nextGate`), because for `blocked`, `interrupted`, and a
 * pending question alike that text already is the call to action.
 *
 * The pending-question check runs *before* the `handed_off`/`hibernated`/`committed` checks, mirroring
 * `attentionReasonFor`'s own precedence (`../fleet.js`) exactly: neither `command.applied`'s hand-off
 * handling nor `BudgetExhausted`'s hibernation handling (`../projection.js`) ever clears `question`, so a
 * run can reach one of those three terminal states while a question is still pending. `attentionReasonFor`
 * would tag that run `'decision_point'`, and this function has to agree — showing the hand-off/hibernation/
 * completion sentence instead would be a card that names one reason and then reads a sentence for another.
 */
const detailFor = (entry: AttentionEntry): string => {
  const view = entry.run.view;
  if (view.problem !== null) return view.problem;
  if (view.question.state === 'pending') return view.progress.nextGate;
  if (view.featureState === 'handed_off') {
    return view.handoff === null ? 'the run handed off, but recorded no reason' : handoffSentence(view.handoff);
  }
  if (view.featureState === 'hibernated') {
    return 'a ceiling was reached and the run hibernated on its own';
  }
  if (view.featureState === 'committed') {
    return 'the work is committed';
  }
  return view.progress.nextGate;
};

/** How many runs need a person, in one sentence — the headline for a non-empty result. */
const titleFor = (count: number): string =>
  count === 1 ? '1 run needs you' : `${String(count)} runs need you`;

/**
 * Build the attention card: one line per run that needs a person, or a title saying none does.
 *
 * No height bound, unlike the brief: this is not one of `interface-contract.md`'s bounded-to-one-screen
 * surfaces (Boundaries), so every entry is always shown.
 */
export const buildAttentionCard = (fleet: FleetView): AttentionCard => {
  const needing = runsNeedingAttention(fleet);
  const entries: readonly AttentionCardEntry[] = needing.map((entry) => ({
    feature: entry.run.view.feature ?? UNNAMED_FEATURE,
    reason: entry.reason,
    detail: detailFor(entry),
  }));

  /**
   * The count that was not read, stated in the title — mirroring `buildBriefCard`'s own pattern
   * (`./brief.js`).
   *
   * `foldFleet` bounds itself to `MAX_FLEET_RUNS` most-recent runs, so on a machine with more run
   * directories than that this card is a fold of the most recent ones and not of everything. An exception
   * sitting in one of the unread older runs would otherwise make this card say "nothing needs you" while
   * something genuinely does — the exact claim R1 exists to make honestly.
   */
  const notRead = fleet.notRead;

  if (entries.length === 0) {
    return {
      kind: 'attention',
      // One sentence, and no empty table: R1 makes silence the default, and a card that says "nothing
      // needs you" reads the same whether the fleet is empty or every run in it is quiet.
      title:
        'nothing needs you: every run is quiet' +
        (notRead > 0 ? `, among the ${String(MAX_FLEET_RUNS)} most recent runs` : ''),
      lines: [],
      entries: [],
    };
  }

  return {
    kind: 'attention',
    title: titleFor(entries.length) + (notRead > 0 ? `, of the ${String(MAX_FLEET_RUNS)} most recent runs` : ''),
    lines: entries.map((entry) => `${entry.feature} — ${entry.detail}`),
    entries,
  };
};
