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
 */
import { Box, Text, render } from 'ink';
import type { ReactNode } from 'react';

import { formatControlHints } from './controls.js';
import { formatModeExplanation, formatModeLine } from './mode.js';
import { loadShellView, presentValue } from './projection.js';
import type { ShellView } from './projection.js';
import { formatStatusSegment } from './status.js';

/** The width assumed when the terminal does not say. 40 columns is the declared narrow case. */
export const DEFAULT_COLUMNS = 80;
export const NARROW_COLUMNS = 40;

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
}

/** The label the question slot always carries, so the slot is recognisable when it is empty. */
export const QUESTION_SLOT_LABEL = 'question';

/** What the slot says when nothing is pending. Silence means success (R1), and this is what it reads as. */
export const QUESTION_SLOT_EMPTY = 'none pending — nothing needs you';

/**
 * Wrap a line to a width, breaking on spaces and never mid-word unless a word is wider than the line.
 *
 * Wrapping rather than truncating, because the 40-column case is a declared state and a mode line cut
 * in half is precisely the mode confusion the interface contract calls an accident class.
 */
export const wrapLine = (line: string, columns: number): readonly string[] => {
  const width = Math.max(columns, 20);
  if (line.length <= width) return [line];
  const out: string[] = [];
  let current = '';
  for (const word of line.split(' ')) {
    if (current === '') {
      current = word;
    } else if (`${current} ${word}`.length <= width) {
      current = `${current} ${word}`;
    } else {
      out.push(current);
      current = word;
    }
    while (current.length > width) {
      out.push(current.slice(0, width));
      current = current.slice(width);
    }
  }
  if (current !== '') out.push(current);
  return out;
};

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
  return sections;
};

/** One frame as lines, for a suite and for anything that is not a terminal. */
export const shellFrameLines = (view: ShellView, options: FrameOptions = {}): readonly string[] =>
  shellSections(view, options).flatMap((section) => section.lines);

/** One frame as text. */
export const shellFrameText = (view: ShellView, options: FrameOptions = {}): string =>
  shellFrameLines(view, options).join('\n');

export interface ShellProps extends FrameOptions {
  readonly view: ShellView;
  /**
   * The question card, when one exists.
   *
   * The seam story 1-10 fills: a card passed here is drawn inside the persistent slot, and the slot's
   * own lines stay above it so the state of the question is stated even when the card is absent.
   */
  readonly questionCard?: ReactNode;
}

/** The persistent question slot (R14). A section of its own, so nothing later can scroll it away. */
export const QuestionSlot = ({
  view,
  columns,
  children,
}: {
  readonly view: ShellView;
  readonly columns?: number;
  readonly children?: ReactNode;
}): ReactNode => (
  <Box flexDirection="column">
    {questionSlotLines(view)
      .flatMap((line) => wrapLine(line, columns ?? DEFAULT_COLUMNS))
      .map((line, index) => (
        <Text key={`question-${String(index)}-${line}`}>{line}</Text>
      ))}
    {children}
  </Box>
);

/** The shell: the sections, in order, with the question card placed inside the slot. */
export const Shell = ({ view, columns, now, questionCard }: ShellProps): ReactNode => {
  const sections = shellSections(view, {
    ...(columns === undefined ? {} : { columns }),
    ...(now === undefined ? {} : { now }),
  });
  return (
    <Box flexDirection="column">
      {sections.map((section) =>
        section.id === 'question' ? (
          <QuestionSlot key={section.id} view={view} {...(columns === undefined ? {} : { columns })}>
            {questionCard}
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

/** What a mounted shell hands back: a way to re-read the log, and a way to stop. */
export interface ShellHandle {
  /** Re-read the log and redraw. The log is the only input, so this is the whole of "refresh". */
  readonly refresh: () => void;
  readonly unmount: () => void;
  readonly lastView: () => ShellView;
}

export interface MountShellOptions extends FrameOptions {
  /** `runs/<run-id>/events.jsonl` — read, never written: the recorder is its sole writer (AD-29). */
  readonly eventLog: string;
  /** The feature name, for the frame a log too young to name it would otherwise leave blank. */
  readonly feature?: string | null;
  /** How often to re-read the log. `null` for a shell a caller refreshes itself. */
  readonly pollMs?: number | null;
  readonly stdout?: NodeJS.WriteStream;
  readonly questionCard?: ReactNode;
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
 * The shell holds no state: every frame is a fresh fold of the log, which is what makes it impossible
 * for the terminal to drift from the durable truth (AD-4). Polling rather than watching because a
 * poll cannot miss a notification and cannot leak a watcher; the interval is unreferenced, so it never
 * keeps a process alive on its own (AD-32 — nothing here is a shutdown handler).
 */
export const mountShell = (options: MountShellOptions): ShellHandle => {
  const load = (): ShellView =>
    loadShellView(options.eventLog, { feature: options.feature ?? null });
  let view = load();

  const frame = (current: ShellView): ReactNode => (
    <Shell
      view={current}
      {...(options.columns === undefined ? {} : { columns: options.columns })}
      {...(options.now === undefined ? {} : { now: options.now })}
      {...(options.questionCard === undefined ? {} : { questionCard: options.questionCard })}
    />
  );

  const instance = render(frame(view), {
    // Never patched: a shell that rewired `console` would change the behaviour of whatever mounted it,
    // and nothing here writes diagnostics to stdout in any case (Consistency Conventions).
    patchConsole: false,
    ...(options.stdout === undefined ? {} : { stdout: options.stdout }),
    ...(options.debug === undefined ? {} : { debug: options.debug }),
  });

  const refresh = (): void => {
    view = load();
    instance.rerender(frame(view));
  };

  const timer =
    options.pollMs === undefined || options.pollMs === null
      ? null
      : setInterval(refresh, options.pollMs);
  timer?.unref();

  return {
    refresh,
    lastView: (): ShellView => view,
    unmount: (): void => {
      if (timer !== null) clearInterval(timer);
      instance.unmount();
    },
  };
};
