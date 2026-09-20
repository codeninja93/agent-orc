/**
 * The autonomy mode: how it is derived from the log, and how it is presented.
 *
 * `interface-contract.md` puts this module's reason for existing in one sentence: "Mode confusion —
 * the human believing the system is in one mode while it is in another — is a known accident class in
 * aviation and the primary interface hazard of a system with autonomy tiers." That makes the mode's
 * presence a safety invariant rather than a header decoration, and it is why every function here
 * returns a non-empty string for every input. There is no state of the system — not an empty log, not
 * a run mid-step, not a question pending, not a run somebody killed — in which this module can answer
 * "no mode".
 *
 * Two things are deliberately separate, because they are different facts and a person needs both:
 *
 * - the **autonomy mode**, which says how much the system will do without asking, and is folded from
 *   the steering commands the log records as applied;
 * - the **run mode** of AD-27, `live` or `shadow`, which says whether a write will actually happen.
 *
 * Neither is inferred from anything but the log. A renderer holds no authoritative state of its own
 * (AD-4), so the mode a person reads here is the mode the log says the system is in.
 */
import { Command } from '../contracts/index.js';
import type { CommandMap, FeatureState, RunMode } from '../contracts/index.js';

/**
 * The autonomy modes, each a claim about what the system will do next without being asked.
 *
 * The set is closed on purpose: a mode a person cannot name is a mode they cannot hold a belief
 * about, and the hazard this module exists for is a *wrong* belief.
 */
export const AUTONOMY_MODES = [
  /** Gates hold, questions are asked, and nothing irreversible happens unapproved. */
  'interactive',
  /** `just-do-it`: stop asking, use judgement, review at the end (interface-contract, first-class). */
  'just-do-it',
  /** Paused by a person; clean resumable state, and nothing advances until it is resumed. */
  'paused',
  /** A person took manual control, so the system advances nothing (CAP-23). */
  'taken-over',
  /** Disengaged, killed, handed off or finished: the system is advancing nothing at all. */
  'stopped',
] as const;

export type AutonomyMode = (typeof AUTONOMY_MODES)[number];

/** The mode a run is in before any steering command has been applied to it. */
export const DEFAULT_AUTONOMY_MODE: AutonomyMode = 'interactive';

/**
 * One line of prose per mode, so what a person reads is a claim about behaviour rather than a label
 * they have to decode. A total map, so a mode added to the enum without a sentence is a compile error.
 */
export const AUTONOMY_MODE_DESCRIPTIONS: Readonly<Record<AutonomyMode, string>> = Object.freeze({
  interactive: 'asks before anything irreversible',
  'just-do-it': 'uses judgement, asks nothing, review at the end',
  paused: 'nothing advances until you resume',
  'taken-over': 'you have manual control; the system advances nothing',
  stopped: 'the system is advancing nothing',
});

/**
 * What each command does to the autonomy mode, as a total map over the `Command` enum.
 *
 * Total because AD-3 makes the enum the single declaration of every control: a command with no entry
 * here would be a control whose effect on the displayed mode nobody decided, which is exactly how a
 * person ends up believing the wrong one. `null` is an explicit decision that the command changes no
 * mode — `approve` and `answer` move a run along without changing how much it will do unasked.
 */
export const AUTONOMY_MODE_TRANSITIONS: CommandMap<AutonomyMode | null> = Object.freeze({
  [Command.Answer]: null,
  [Command.ConfirmSpec]: null,
  [Command.EditCriterion]: null,
  [Command.Approve]: null,
  [Command.Reject]: null,
  /** Continue past a kill card: back to asking, unless `just-do-it` is still engaged. */
  [Command.Continue]: 'interactive',
  [Command.Narrow]: null,
  [Command.Pause]: 'paused',
  [Command.InjectNote]: null,
  [Command.Kill]: 'stopped',
  [Command.Fork]: null,
  [Command.TakeOver]: 'taken-over',
  [Command.Disengage]: 'stopped',
  [Command.JustDoIt]: 'just-do-it',
});

/**
 * The modes a `continue` does not walk back.
 *
 * `just-do-it` is sustained: a person who said "stop asking" and then continued past a kill card has
 * not asked to be asked again. `stopped` and `taken-over` are not walked back either, because neither
 * is something a `continue` undoes — the log would have to record the command that does.
 */
const STICKY_AUTONOMY_MODES: readonly AutonomyMode[] = ['just-do-it', 'stopped', 'taken-over'];

/**
 * Fold one applied command into the mode.
 *
 * A command outside the enum leaves the mode alone rather than throwing: a newer engine's log may
 * carry a control this build does not have, and AD-5's ignore-what-you-do-not-know applies to the
 * value of a field as much as to the type of an event.
 */
export const applyCommandToMode = (mode: AutonomyMode, command: string): AutonomyMode => {
  if (!Object.prototype.hasOwnProperty.call(AUTONOMY_MODE_TRANSITIONS, command)) return mode;
  const next = AUTONOMY_MODE_TRANSITIONS[command as Command];
  if (next === null) return mode;
  if (next === 'interactive' && STICKY_AUTONOMY_MODES.includes(mode)) return mode;
  return next;
};

/**
 * The feature states that force `stopped`, whatever the commands said.
 *
 * A run that has reached a terminal state is advancing nothing, and a mode line still reading
 * `just-do-it` over a killed run is precisely the false belief this module exists to prevent. The
 * list is the spine's four terminal states plus `hibernated`'s sibling reasoning: each is a state the
 * lifecycle draws an arrow to `[*]` from.
 */
export const STOPPED_FEATURE_STATES: readonly FeatureState[] = [
  'committed',
  'hibernated',
  'killed',
  'handed_off',
];

/** The mode a feature state forces, or `null` when the state leaves the commands' answer standing. */
export const modeForFeatureState = (state: FeatureState | null): AutonomyMode | null =>
  state !== null && STOPPED_FEATURE_STATES.includes(state) ? 'stopped' : null;

/** Everything the mode line states, as facts rather than as text. */
export interface ModeDisplay {
  readonly autonomy: AutonomyMode;
  readonly runMode: RunMode;
  /** The feature state, when the log has recorded one; presented beside the mode, never instead. */
  readonly featureState: FeatureState | null;
}

/** The label every mode line opens with, spelled once so a suite can look for it. */
export const MODE_LABEL = 'mode';

/** How a shadow run is spelled out, because "shadow" alone does not say what it changes (AD-27). */
export const SHADOW_MODE_NOTE = 'shadow: writes recorded, none executed';

/**
 * The permanently displayed mode line.
 *
 * It never returns an empty string and never omits the mode, for any input: that is the whole
 * invariant, and `tests/tui.mode.test.ts` enumerates the render states rather than trusting this
 * sentence. The feature state rides along because "stopped" invites the question "why", and the log
 * already knows.
 */
export const formatModeLine = (display: ModeDisplay): string => {
  const parts = [`${MODE_LABEL} ${display.autonomy}`];
  if (display.runMode === 'shadow') parts.push(SHADOW_MODE_NOTE);
  if (display.featureState !== null) parts.push(display.featureState.replace(/_/g, ' '));
  return parts.join(' · ');
};

/** The mode line's second line: what the mode means, for a person who has just met it. */
export const formatModeExplanation = (display: ModeDisplay): string =>
  AUTONOMY_MODE_DESCRIPTIONS[display.autonomy];
