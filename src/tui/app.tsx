/**
 * The Ink shell: the frame the other four modules compose into, and the slot story 1-10 fills.
 *
 * The shell is deliberately thin, and the reason is in the story's design notes: a fold from events to
 * view state needs no terminal to test, while a suite made mostly of rendered frames is slow, brittle
 * and still silent about whether the projection is right. So every line of the frame is produced by a
 * pure function — {@link shellSections} — and the Ink components below only place those lines in a
 * layout. The frame a person sees and the frame a suite asserts are therefore the same strings by
 * construction, not by two implementations agreeing.
 *
 * What the shell guarantees, beyond composing:
 *
 * - **The mode is in every frame.** It is the first section after a problem report, it has no
 *   conditional, and there is no view for which it renders empty.
 * - **The question slot is permanent** (R14). It is a section of its own, above the notices rather than
 *   below them, and the notices are bounded by the fold — so nothing that arrives later can push the
 *   slot off the frame. Story 1-10 fills it by passing a card as `children`; until then it states
 *   whether a question is pending and what happens if it is ignored.
 * - **No colour is load-bearing.** Nothing here sets a colour, so a terminal without colour support
 *   renders exactly what a terminal with it does. The narrow case is handled by wrapping every line to
 *   the column count rather than by letting the terminal truncate.
 *
 * Story 1-10 filled the slot and closed the keyboard loop, and both are deliberately thin:
 *
 * - **The card is chosen by `cardForView` and drawn by `CardView`.** Which card a run calls for is one
 *   decision in one place, and it is a pure function of the view — so the frame a person sees and the card
 *   a suite asserts are the same structure, not two agreeing implementations.
 * - **A keystroke reaches `invokeControl` and nothing else.** {@link reduceKey} decides what a key means;
 *   invoking a control writes one durable intent file (AD-19). Nothing in this file executes anything,
 *   signals anything or touches run state, so the keyboard cannot become a second command path.
 * - **The two things the shell now remembers are not run state.** A half-typed draft and the
 *   acknowledgement of the last keystroke exist only in this process and are deliberately *not* in the
 *   log: the recorder is the log's sole writer (AD-29), and a draft nobody has sent is not a fact about
 *   the run. Everything else is still re-folded from the log on every frame, so the terminal still cannot
 *   drift from the durable truth (AD-4).
 */
import { Box, Text, render, useInput, useStdin } from 'ink';
import type { ReactNode } from 'react';

import { Command } from '../contracts/index.js';

import { BriefCardView, CardView } from './cards.js';
import { DEFAULT_BRIEF_HEIGHT, buildBriefCard, cardForView } from './cards/index.js';
import type { BriefCard, Card, CardInputs } from './cards/index.js';
import { CONTROLS, formatControlHints, invokeControl } from './controls.js';
import type { ControlContext, ControlOutcome } from './controls.js';
import { foldFleet } from './fleet.js';
import type { FleetView } from './fleet.js';
import { initialInputState, reduceKey } from './input.js';
import type { InputEffect, InputKey, InputState } from './input.js';
import { formatModeExplanation, formatModeLine } from './mode.js';
import { loadShellView, presentValue } from './projection.js';
import type { ShellView } from './projection.js';
import { formatStatusSegment } from './status.js';
import { wrapToWidth } from './width.js';

/** The width assumed when the terminal does not say. 40 columns is the declared narrow case. */
export const DEFAULT_COLUMNS = 80;
export const NARROW_COLUMNS = 40;

/**
 * How often a mounted shell re-reads the log when the caller names no interval.
 *
 * A default rather than nothing, because the previous `undefined` meant *no interval at all*: elapsed
 * froze at the instant of mount unless an embedder called `refresh` itself, while R11 requires
 * elapsed-versus-estimate to be visible and the story describes the number as "still growing". One
 * second is the resolution the duration format has — it renders whole seconds — so a shorter interval
 * would re-read the log to draw the identical frame.
 */
export const DEFAULT_POLL_MS = 1_000;

/**
 * The shortest interval a caller can ask for.
 *
 * `0` or a negative number handed to `setInterval` is a continuous re-read of the whole log, which on a
 * long run is a busy loop holding a file open — so a supplied value is clamped rather than obeyed.
 */
export const MIN_POLL_MS = 50;

/**
 * The rows a frame keeps whatever the terminal's height, so bounding it cannot empty it.
 *
 * The problem line, the feature, the two mode lines, the status, the two progress lines and the question
 * slot are the frame's spine: every one of them is a statement about what is true *now*, and the mode is
 * a safety property. Nothing here is ever dropped to make room.
 */
export const MIN_FRAME_ROWS = 10;

/** The sections of a frame, in the order they are drawn. The question slot is one of them, always. */
export const SHELL_SECTION_IDS = [
  'problem',
  'feature',
  'mode',
  'status',
  'progress',
  'question',
  'notices',
  'controls',
] as const;

export type ShellSectionId = (typeof SHELL_SECTION_IDS)[number];

/** One section: its id, and the already-wrapped lines it draws. */
export interface ShellSection {
  readonly id: ShellSectionId;
  readonly lines: readonly string[];
}

export interface FrameOptions {
  readonly columns?: number;
  readonly now?: Date;
  /**
   * How many rows the terminal has, when the caller knows.
   *
   * R14 says the active question occupies a slot that does not scroll away, and bounding the notice list
   * (`MAX_NOTICES`) only bounds one section: a frame is still free to be taller than the terminal, and
   * the terminal then scrolls, and what scrolls off the top is whatever came first — the problem line,
   * the mode, the status and the question slot, in that order. So the frame is bounded here too, and the
   * lines that are given up are notices, which are the only section that is a history rather than a
   * statement of what is true now.
   */
  readonly rows?: number;
}

/** The label the question slot always carries, so the slot is recognisable when it is empty. */
export const QUESTION_SLOT_LABEL = 'question';

/** What the slot says when nothing is pending. Silence means success (R1), and this is what it reads as. */
export const QUESTION_SLOT_EMPTY = 'none pending — nothing needs you';

/**
 * Wrap a line to a width, breaking on spaces and never mid-word unless a word is wider than the line.
 *
 * The measurement is in terminal *cells* rather than UTF-16 units, which is what `width.ts` exists for:
 * a line of CJK measured by `String.length` wraps at twice the terminal's width, and one carrying
 * combining marks wraps early — in both cases breaking the 40-column guarantee the story declares.
 */
export const wrapLine = (line: string, columns: number): readonly string[] =>
  wrapToWidth(line, columns);

const wrapAll = (lines: readonly string[], columns: number): readonly string[] =>
  lines.flatMap((line) => wrapLine(line, columns));

/** The progress lines: the current step's name and the next gate, and never a share of a whole (R7). */
export const progressLines = (view: ShellView): readonly string[] => {
  const current =
    view.progress.currentStep === null
      ? 'no step running'
      : `step "${view.progress.currentStep}"${
          view.progress.currentStepPhase === null ? '' : ` (${view.progress.currentStepPhase})`
        }`;
  return [current, `next gate: ${view.progress.nextGate}`];
};

/** The question slot's own lines. Present in every frame, whatever the slot holds. */
export const questionSlotLines = (view: ShellView): readonly string[] => {
  const question = view.question;
  if (question.state === 'empty') return [`${QUESTION_SLOT_LABEL}: ${QUESTION_SLOT_EMPTY}`];

  if (question.state === 'pending') {
    const lines = [`${QUESTION_SLOT_LABEL}: ${presentValue(question.prompt)}`];
    if (question.recommendedOptionId !== null) {
      lines.push(`recommended: ${question.recommendedOptionId}`);
    }
    if (question.defaultAction !== null) {
      const window =
        question.defaultWindowMs === null
          ? ''
          : ` in ${String(Math.round(question.defaultWindowMs / 1000))}s`;
      lines.push(`if ignored${window}: ${question.defaultAction}`);
    }
    return lines;
  }

  return [
    `${QUESTION_SLOT_LABEL}: ${presentValue(question.prompt)}`,
    `${question.state}: ${question.outcome ?? 'no outcome recorded'}`,
    ...(question.answer === null ? [] : [`recorded answer: ${presentValue(question.answer)}`]),
  ];
};

/**
 * Every line of one frame, as sections.
 *
 * Pure, and the single source of what a frame contains: the Ink tree below draws these lines and adds
 * nothing of its own, so a suite that asserts against this function is asserting against the frame.
 */
export const shellSections = (view: ShellView, options: FrameOptions = {}): readonly ShellSection[] => {
  const columns = options.columns ?? DEFAULT_COLUMNS;
  const now = options.now ?? new Date();
  const display = { autonomy: view.autonomy, runMode: view.runMode, featureState: view.featureState };

  const sections: ShellSection[] = [];
  if (view.problem !== null) {
    sections.push({ id: 'problem', lines: wrapAll([view.problem], columns) });
  }
  sections.push({
    id: 'feature',
    lines: wrapAll([`feature: ${view.feature ?? '(no feature yet)'}`], columns),
  });
  sections.push({
    id: 'mode',
    lines: wrapAll([formatModeLine(display), formatModeExplanation(display)], columns),
  });
  sections.push({ id: 'status', lines: wrapAll([formatStatusSegment(view, now)], columns) });
  sections.push({ id: 'progress', lines: wrapAll(progressLines(view), columns) });
  sections.push({ id: 'question', lines: wrapAll(questionSlotLines(view), columns) });
  if (view.notices.length > 0) {
    sections.push({
      id: 'notices',
      lines: wrapAll(
        view.notices.map((notice) => `- ${notice.text}`),
        columns,
      ),
    });
  }
  sections.push({ id: 'controls', lines: formatControlHints(columns) });
  return boundToRows(sections, options.rows);
};

/**
 * Drop lines until the frame fits the terminal, giving up history before anything that is true now.
 *
 * The order is the order of what a person loses by not seeing it. Notices go first, oldest first: each
 * is something that already happened and is already in the log. The control hints go next, from the end
 * — never the first row, which carries `x stop`, the one gesture the contract requires to be always
 * available. Everything else stays: a frame that dropped the mode to fit would be the accident class
 * this shell exists to prevent, and a frame that dropped the question slot would be R14's defect
 * exactly.
 */
const boundToRows = (
  sections: readonly ShellSection[],
  rows: number | undefined,
): readonly ShellSection[] => {
  if (rows === undefined || !Number.isFinite(rows)) return sections;
  const limit = Math.max(Math.trunc(rows), MIN_FRAME_ROWS);
  const draft = sections.map((section) => ({ id: section.id, lines: [...section.lines] }));
  let total = draft.reduce((count, section) => count + section.lines.length, 0);
  if (total <= limit) return sections;

  const notices = draft.find((section) => section.id === 'notices');
  while (total > limit && notices !== undefined && notices.lines.length > 0) {
    notices.lines.shift();
    total -= 1;
  }
  const controls = draft.find((section) => section.id === 'controls');
  while (total > limit && controls !== undefined && controls.lines.length > 1) {
    controls.lines.pop();
    total -= 1;
  }
  return draft
    .filter((section) => section.lines.length > 0)
    .map((section) => ({ id: section.id, lines: section.lines }));
};

/** One frame as lines, for a suite and for anything that is not a terminal. */
export const shellFrameLines = (view: ShellView, options: FrameOptions = {}): readonly string[] =>
  shellSections(view, options).flatMap((section) => section.lines);

/** One frame as text. */
export const shellFrameText = (view: ShellView, options: FrameOptions = {}): string =>
  shellFrameLines(view, options).join('\n');

/**
 * The prompt a person types an answer into.
 *
 * Drawn inside the question slot rather than at the bottom of the frame, because what is being typed
 * belongs to the question it answers (R14) — a prompt that sat elsewhere would be a second place to look
 * for the one thing the run is waiting on. The label is the control's own, so a person can see which
 * gesture they are in the middle of, and the trailing block stands in for a cursor without any escape
 * sequence, which keeps the frame colourless and comparable.
 */
export const INPUT_PROMPT_CURSOR = '\u2588';

export const inputPromptLine = (input: InputState): string | null =>
  input.mode === 'composing' && input.composingFor !== null
    ? `${CONTROLS[input.composingFor].label} > ${input.draft}${INPUT_PROMPT_CURSOR}  ` +
      '(enter sends it, esc discards it)'
    : null;

export interface ShellProps extends FrameOptions {
  readonly view: ShellView;
  /**
   * The card this run is asking for, already chosen.
   *
   * The seam story 1-9 reserved: the card is drawn inside the persistent slot, and the slot's own lines
   * stay above it so the state of the question is stated even when no card is drawn.
   */
  readonly card?: Card | null;
  /** The keyboard loop's state, so a half-typed answer is visible where the question is. */
  readonly input?: InputState;
  /** What the last keystroke did, in one line. Never a stack trace, and never silence. */
  readonly keystrokeNotice?: string | null;
  /** A node to draw in the slot, for a caller composing its own. */
  readonly questionCard?: ReactNode;
}

/**
 * The persistent question slot (R14). A section of its own, so nothing later can scroll it away.
 *
 * `lines` are the slot's lines **as the composer already produced them**, not a second derivation. The
 * module's opening claim is that "the frame a person sees and the frame a suite asserts are the same
 * strings by construction"; recomputing and re-wrapping here made that untrue for the one section R14
 * names, and any bound the composer applied to the frame would have been applied to a copy of the slot
 * that Ink then ignored. `view` remains the fallback for a caller composing the slot on its own.
 */
export const QuestionSlot = ({
  view,
  columns,
  lines,
  children,
}: {
  readonly view: ShellView;
  readonly columns?: number;
  readonly lines?: readonly string[];
  readonly children?: ReactNode;
}): ReactNode => (
  <Box flexDirection="column">
    {(lines ?? questionSlotLines(view).flatMap((line) => wrapLine(line, columns ?? DEFAULT_COLUMNS))).map(
      (line, index) => (
        <Text key={`question-${String(index)}-${line}`}>{line}</Text>
      ),
    )}
    {children}
  </Box>
);

/** The shell: the sections, in order, with the card, the prompt and any notice inside the slot. */
export const Shell = ({
  view,
  columns,
  rows,
  now,
  card,
  input,
  keystrokeNotice,
  questionCard,
}: ShellProps): ReactNode => {
  const sections = shellSections(view, {
    ...(columns === undefined ? {} : { columns }),
    ...(rows === undefined ? {} : { rows }),
    ...(now === undefined ? {} : { now }),
  });
  const width = columns ?? DEFAULT_COLUMNS;
  const prompt = input === undefined ? null : inputPromptLine(input);
  return (
    <Box flexDirection="column">
      {sections.map((section) =>
        section.id === 'question' ? (
          <QuestionSlot
            key={section.id}
            view={view}
            lines={section.lines}
            {...(columns === undefined ? {} : { columns })}
          >
            {card === undefined || card === null ? null : (
              <CardView card={card} {...(columns === undefined ? {} : { columns })} />
            )}
            {questionCard}
            {prompt === null
              ? null
              : wrapLine(prompt, width).map((line, index) => (
                  <Text key={`prompt-${String(index)}-${line}`}>{line}</Text>
                ))}
            {keystrokeNotice === undefined || keystrokeNotice === null
              ? null
              : wrapLine(keystrokeNotice, width).map((line, index) => (
                  <Text key={`keystroke-${String(index)}-${line}`}>{line}</Text>
                ))}
          </QuestionSlot>
        ) : (
          <Box key={section.id} flexDirection="column">
            {section.lines.map((line, index) => (
              <Text key={`${section.id}-${String(index)}-${line}`}>{line}</Text>
            ))}
          </Box>
        ),
      )}
    </Box>
  );
};

/**
 * The keyboard, bound to the reducer and to nothing else.
 *
 * Gated on raw mode being supported, because Ink's `useInput` puts `stdin` into raw mode and a process
 * whose `stdin` is a pipe — a test, a CI run, a shell with input redirected — cannot be put into it. The
 * alternative to the gate is a shell that throws on mount in exactly those cases, and a renderer that
 * cannot be mounted by a suite is a renderer whose composition nobody checks.
 *
 * It renders nothing. A component that both listened and drew would make the listening untestable without
 * a terminal, which is the whole thing this directory avoids.
 */
export const Keyboard = ({
  onKey,
  active,
}: {
  readonly onKey: (key: InputKey) => void;
  readonly active?: boolean;
}): ReactNode => {
  const { isRawModeSupported } = useStdin();
  useInput(
    (input, key) => {
      onKey({
        input,
        return: key.return,
        escape: key.escape,
        backspace: key.backspace,
        delete: key.delete,
        ctrl: key.ctrl,
      });
    },
    // Coerced to a strict boolean on purpose: Ink reads `isTTY` straight off the stream, where "not a
    // terminal" is `undefined` rather than `false`, and its own guard is `isActive === false`. An
    // `undefined` here would therefore read as active and throw on mount in exactly the non-TTY case this
    // gate exists for.
    { isActive: (active ?? true) && isRawModeSupported === true },
  );
  return null;
};

/** What a mounted shell hands back: a way to re-read the log, to press a key, and to stop. */
export interface ShellHandle {
  /** Re-read the log and redraw. The log is the only input, so this is the whole of "refresh". */
  readonly refresh: () => void;
  readonly unmount: () => void;
  readonly lastView: () => ShellView;
  /**
   * Deliver one keystroke, exactly as the terminal would.
   *
   * Exposed because a keyboard loop that could only be driven by a real TTY would be a keyboard loop no
   * suite drives: the same function Ink's handler calls, so what a test exercises is the loop itself and
   * not a second path built for testing.
   */
  readonly press: (key: InputKey) => InputEffect;
  readonly inputState: () => InputState;
  /** The last intent a keystroke wrote, or `null` when none has. */
  readonly lastControl: () => ControlOutcome | null;
  /** The card the current view called for, or `null` when it called for none. */
  readonly lastCard: () => Card | null;
}

export interface MountShellOptions extends FrameOptions {
  /** `runs/<run-id>/events.jsonl` — read, never written: the recorder is its sole writer (AD-29). */
  readonly eventLog: string;
  /** The feature name, for the frame a log too young to name it would otherwise leave blank. */
  readonly feature?: string | null;
  /**
   * How often to re-read the log, in milliseconds.
   *
   * Omitted means {@link DEFAULT_POLL_MS}, because a shell that never re-read would freeze elapsed at
   * the instant of mount and R11 makes elapsed-versus-estimate always visible. `null` — explicitly —
   * installs no interval, for an embedder that drives `refresh` itself. A supplied value is clamped to
   * {@link MIN_POLL_MS}.
   */
  readonly pollMs?: number | null;
  readonly stdout?: NodeJS.WriteStream;
  readonly questionCard?: ReactNode;
  /**
   * Where a keystroke's intent file goes, and who it is attributable to (AD-19).
   *
   * Absent means the keys are inert: a shell mounted over a log with no run to steer — a demonstration, a
   * suite asserting composition — must not write an intent into a directory nobody named. A keystroke then
   * says so rather than failing silently.
   */
  readonly control?: ControlContext | null;
  /** The facts the cards accept beyond the view; each is `(not recorded)` when absent. */
  readonly cards?: CardInputs;
  /**
   * Write whole frames rather than terminal escapes.
   *
   * Ink's own debug mode, exposed because it is how a suite reads a frame: with it off, what reaches
   * `stdout` is a cursor dance that says nothing about what a person would see.
   */
  readonly debug?: boolean;
}

/**
 * Mount the shell over a run's event log.
 *
 * Every frame is a fresh fold of the log, which is what makes it impossible for the terminal to drift from
 * the durable truth (AD-4). Polling rather than watching because a poll cannot miss a notification and
 * cannot leak a watcher; the interval is unreferenced, so it never keeps a process alive on its own (AD-32
 * — nothing here is a shutdown handler).
 *
 * The only things held between frames are the keyboard's own state and the acknowledgement of the last
 * keystroke. Neither is run state, neither is written anywhere, and both are lost on exit — which is
 * correct: an answer nobody sent is not a decision, and AD-25 makes a decision durable.
 */
export const mountShell = (options: MountShellOptions): ShellHandle => {
  /**
   * The terminal the frame is drawn to, and the one whose size it is measured against.
   *
   * Read from the stream rather than taken as a parameter: `columns` defaulted to 80 whatever the
   * terminal was, so the 40-column case the story declares was reachable only by a caller that already
   * knew to pass `columns: 40` — which is to say, by a suite. A real 40-column terminal composed at 80
   * and the terminal did the cutting, which is the one thing the wrapping exists to prevent.
   */
  const screen: NodeJS.WriteStream = options.stdout ?? process.stdout;
  const columnsNow = (): number =>
    options.columns ?? screen.columns ?? process.stdout.columns ?? DEFAULT_COLUMNS;
  const rowsNow = (): number | undefined => options.rows ?? screen.rows ?? process.stdout.rows;

  /**
   * The previous view is handed to every read, so a failed one keeps the mode it last knew.
   *
   * A renderer polls the file the recorder appends to, so a read can meet a line mid-`write`. Resetting
   * to the idle view on that race displayed `mode interactive` over a run that was paused, stopped or
   * taken over — mode confusion manufactured by a race rather than by anything the log said.
   */
  const load = (previous: ShellView | null): ShellView =>
    loadShellView(options.eventLog, { feature: options.feature ?? null, previous });
  let view = load(null);
  let input: InputState = initialInputState;
  let notice: string | null = null;
  let lastControl: ControlOutcome | null = null;

  /**
   * The draft, but only when it is an answer to the question the card is about.
   *
   * `cardForView` hands its `draft` to the question card, whose field means "what you have typed and not
   * sent *in reply to this question*" — and the whole draft was being passed through whatever it was being
   * composed for. A rejection reason half-typed at a gate, or the wording of an amended criterion,
   * therefore rendered under "typed and not yet sent" beneath the pending question, as if it were an
   * answer about to resolve it. Q6 makes the answer free text, so nothing about the characters themselves
   * could have told the card otherwise; what distinguishes them is the control they belong to, which the
   * reducer already records.
   */
  const answerDraft = (): string | null =>
    input.composingFor === Command.Answer && input.draft !== '' ? input.draft : null;

  /**
   * The context one keystroke writes against, resolved now rather than at mount.
   *
   * `ControlContext.currentStep` is what a `current-step` control — approve, reject, kill, inject-note —
   * names in its intent file, and it was taken from the object the caller handed over when the shell was
   * mounted. A shell is mounted once and lives for the whole run, so that value is a snapshot: it was
   * `null` for every shell mounted before a step started, and stale for every step after the first. An
   * approval recorded against a null or stale step is an approval attributed to the wrong gate, and AD-19
   * makes the intent durable and its principal attributable precisely so it can be read back later.
   *
   * The view is re-folded from the log on every frame, so its `currentStep` is what the log says is in
   * flight right now (AD-4). A caller's own value is kept as the fallback for the case the view has none —
   * an embedder that knows a step the log has not recorded yet is still believed over nothing.
   */
  const contextNow = (control: ControlContext): ControlContext => ({
    ...control,
    currentStep: view.progress.currentStep ?? control.currentStep ?? null,
  });

  const cardFor = (current: ShellView): Card | null =>
    cardForView(current, {
      ...options.cards,
      ...(options.now === undefined ? {} : { now: options.now }),
      draft: answerDraft(),
    });

  let card = cardFor(view);

  const frame = (): ReactNode => {
    const rows = rowsNow();
    return (
      <>
        <Shell
          view={view}
          card={card}
          input={input}
          keystrokeNotice={notice}
          columns={columnsNow()}
          {...(rows === undefined ? {} : { rows })}
          {...(options.now === undefined ? {} : { now: options.now })}
          {...(options.questionCard === undefined ? {} : { questionCard: options.questionCard })}
        />
        <Keyboard onKey={press} active={options.control !== undefined && options.control !== null} />
      </>
    );
  };

  /** True once `unmount` has run. Every entry point checks it, so nothing draws to a dead instance. */
  let unmounted = false;

  /**
   * The Ink instance, which does not exist yet when the first frame is being committed.
   *
   * `draw` closed over a `const instance` assigned only after `render(frame())` *returns*, while `frame()`
   * itself mounts {@link Keyboard} — so a keystroke delivered during that first commit reached `draw` and
   * threw a `ReferenceError` from the temporal dead zone, taking the whole terminal down on the one
   * keystroke a person is most likely to have already been pressing. Declared here and checked, so the
   * effect is still applied and the redraw happens as soon as there is something to draw to.
   */
  let instance: ReturnType<typeof render> | null = null;
  let drawPending = false;

  const draw = (): void => {
    if (unmounted) return;
    card = cardFor(view);
    if (instance === null) {
      drawPending = true;
      return;
    }
    instance.rerender(frame());
  };

  /**
   * One keystroke: decide what it means, then perform the one effect a renderer is allowed to perform.
   *
   * The write is `invokeControl` and nothing else — one durable intent file under `commands/`, which the
   * reconciler picks up on its next pass (AD-19). A refusal is caught and stated in a line rather than
   * thrown, because a person who typed a blank answer has made a correctable mistake and a terminal that
   * died of it would lose whatever else they had typed.
   */
  function press(key: InputKey): InputEffect {
    /**
     * After `unmount`, a keystroke does nothing — including writing an intent file.
     *
     * `refresh` already answered this way and `press` did not, so a key delivered to a handle a caller had
     * finished with still reached `invokeControl` and wrote a durable command (AD-19) on behalf of a view
     * that no longer exists. `none` is the honest effect: nothing was decided and nothing happened.
     */
    if (unmounted) return { kind: 'none' };

    const next = reduceKey(input, key);
    input = next.state;
    const effect = next.effect;

    switch (effect.kind) {
      case 'invoke': {
        const control = options.control ?? null;
        if (control === null) {
          notice =
            `"${effect.command}" was not written: this shell was mounted with no run to steer, so ` +
            'there is no commands directory to write an intent into';
          break;
        }
        try {
          lastControl = invokeControl(effect.command, contextNow(control), effect.argument);
          notice =
            `"${effect.command}" written as a durable intent; the loop applies it on its next pass`;
        } catch (thrown: unknown) {
          notice = thrown instanceof Error ? thrown.message : `"${effect.command}" was not written`;
        }
        break;
      }
      case 'compose':
        notice = null;
        break;
      case 'cancelled':
        notice = `"${effect.command}" was abandoned; nothing was written`;
        break;
      case 'empty':
        notice =
          `"${effect.command}" carries your words and there are none yet, so nothing was written — ` +
          'an empty answer would record that you said nothing';
        break;
      case 'ignored':
      case 'none':
        /**
         * The last keystroke's acknowledgement is about the *last* keystroke.
         *
         * Left standing, the sentence from an earlier key sat beside every unbound key and every typed
         * character that followed it — so "answer was abandoned; nothing was written" stayed on the frame
         * while somebody typed the next sentence, which reads as a statement about what they are typing
         * now. A key that did nothing is acknowledged by there being nothing to acknowledge.
         */
        notice = null;
        break;
    }

    draw();
    return effect;
  }

  instance = render(frame(), {
    // Never patched: a shell that rewired `console` would change the behaviour of whatever mounted it,
    // and nothing here writes diagnostics to stdout in any case (Consistency Conventions).
    patchConsole: false,
    ...(options.stdout === undefined ? {} : { stdout: options.stdout }),
    ...(options.debug === undefined ? {} : { debug: options.debug }),
  });

  // A keystroke that landed during the first commit changed the state but had nothing to draw to. Now
  // there is, so the frame catches up rather than showing what was true before the key was pressed.
  if (drawPending) {
    drawPending = false;
    draw();
  }

  /**
   * Re-fold the log and redraw. After `unmount` it does nothing.
   *
   * Nothing rather than a throw: a poll and a resize both land here, and either can arrive between a
   * person pressing a key and the process exiting. A viewer that died on its own way out would turn an
   * ordinary quit into a stack trace over the terminal.
   */
  const refresh = (): void => {
    if (unmounted) return;
    view = load(view);
    draw();
  };

  /** Re-measure and redraw when the terminal is resized, so 40 columns is 40 columns from then on. */
  const onResize = (): void => {
    draw();
  };
  screen.on('resize', onResize);

  const interval =
    options.pollMs === null
      ? null
      : Math.max(options.pollMs ?? DEFAULT_POLL_MS, MIN_POLL_MS);
  const timer = interval === null ? null : setInterval(refresh, interval);
  timer?.unref();

  return {
    refresh,
    press,
    inputState: (): InputState => input,
    lastControl: (): ControlOutcome | null => lastControl,
    lastCard: (): Card | null => card,
    lastView: (): ShellView => view,
    unmount: (): void => {
      if (unmounted) return;
      unmounted = true;
      if (timer !== null) clearInterval(timer);
      screen.off('resize', onResize);
      instance?.unmount();
    },
  };
};

// -------------------------------------------------------------------------------------------------
// The morning brief, which is a fold of every run rather than of one
// -------------------------------------------------------------------------------------------------

/**
 * Mount the morning brief (CAP-22).
 *
 * **Why this is a second mount rather than a seventh branch of `cardForView`.** Five of the six surfaces
 * are folds of one `ShellView`; the brief is a fold of *every* run under `runsDir`, so it cannot be chosen
 * by looking at one view — that reasoning is story 1-10's and it still holds. What did not hold was the
 * conclusion drawn from it: the brief was left with no mount at all, so the **first** entry under the
 * contract's "Required surfaces" existed only as a function a suite called. A surface nothing can put on a
 * screen is not a surface.
 *
 * So the brief is a separate invocation, which is what it is: `mountShell` is "watch this feature" and this
 * is "what is everything doing". Nothing here is a fleet-steering UX — there is no selection, no cursor and
 * no keyboard, because a keystroke needs one run to write its intent against (AD-19) and choosing that run
 * is a decision this round is not entitled to take. It draws, it re-folds, and it stops.
 *
 * The bound is measured, as CAP-22 requires: the height is the terminal's own rows and the wrapper is the
 * frame's own `wrapLine` at the terminal's own columns, so "fits one screen" is a claim about the screen
 * being drawn to rather than about an assumed one.
 */
export interface MountBriefOptions {
  /** `ORCH_HOME`. Defaults to the one the runtime resolves, exactly as every other reader does. */
  readonly orchHome?: string;
  /** The runs to fold. Defaults to every directory under `runs/`. */
  readonly runIds?: readonly string[];
  /** How often to re-fold the fleet. `null` installs no interval, for a caller driving `refresh` itself. */
  readonly pollMs?: number | null;
  readonly columns?: number;
  readonly rows?: number;
  readonly now?: Date;
  readonly stdout?: NodeJS.WriteStream;
  readonly debug?: boolean;
}

/** What a mounted brief hands back. No `press`: the brief steers nothing (AD-19). */
export interface BriefHandle {
  /** Re-fold every run and redraw. The logs are the only input, so this is the whole of "refresh". */
  readonly refresh: () => void;
  readonly unmount: () => void;
  readonly lastCard: () => BriefCard;
  readonly lastFleet: () => FleetView;
}

export const mountBrief = (options: MountBriefOptions = {}): BriefHandle => {
  const screen: NodeJS.WriteStream = options.stdout ?? process.stdout;
  const columnsNow = (): number =>
    options.columns ?? screen.columns ?? process.stdout.columns ?? DEFAULT_COLUMNS;
  const rowsNow = (): number =>
    options.rows ?? screen.rows ?? process.stdout.rows ?? DEFAULT_BRIEF_HEIGHT;

  const fold = (): FleetView =>
    foldFleet({
      ...(options.orchHome === undefined ? {} : { orchHome: options.orchHome }),
      ...(options.runIds === undefined ? {} : { runIds: options.runIds }),
    });

  let fleet = fold();

  const build = (): BriefCard => {
    const columns = columnsNow();
    return buildBriefCard({
      fleet,
      height: rowsNow(),
      // The frame's own wrapper at the terminal's own width, so the height bound is measured over the
      // rows that are actually drawn rather than over unwrapped lines.
      wrap: (line: string): readonly string[] => wrapLine(line, columns),
      ...(options.now === undefined ? {} : { now: options.now }),
    });
  };

  let card = build();
  let unmounted = false;

  const frame = (): ReactNode => <BriefCardView card={card} columns={columnsNow()} />;

  const draw = (): void => {
    if (unmounted) return;
    card = build();
    instance.rerender(frame());
  };

  const instance = render(frame(), {
    patchConsole: false,
    ...(options.stdout === undefined ? {} : { stdout: options.stdout }),
    ...(options.debug === undefined ? {} : { debug: options.debug }),
  });

  const refresh = (): void => {
    if (unmounted) return;
    fleet = fold();
    draw();
  };

  const onResize = (): void => {
    draw();
  };
  screen.on('resize', onResize);

  const interval =
    options.pollMs === null ? null : Math.max(options.pollMs ?? DEFAULT_POLL_MS, MIN_POLL_MS);
  const timer = interval === null ? null : setInterval(refresh, interval);
  timer?.unref();

  return {
    refresh,
    lastCard: (): BriefCard => card,
    lastFleet: (): FleetView => fleet,
    unmount: (): void => {
      if (unmounted) return;
      unmounted = true;
      if (timer !== null) clearInterval(timer);
      screen.off('resize', onResize);
      instance.unmount();
    },
  };
};
