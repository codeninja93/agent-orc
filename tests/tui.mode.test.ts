/**
 * The mode display is a safety invariant, so this suite enumerates render states rather than sampling.
 *
 * `interface-contract.md`: "Mode confusion — the human believing the system is in one mode while it is
 * in another — is a known accident class in aviation and the primary interface hazard of a system with
 * autonomy tiers." A test that checked the mode appeared in *a* frame would pass over exactly the
 * defect that matters, which is a state where it does not. So the states are enumerated — idle,
 * mid-step, question pending, after a kill, and every autonomy mode crossed with all four — and the
 * mode is asserted present in each.
 *
 * The frame tests at the end are about composition, which is the one thing the pure fold cannot show:
 * that the question slot is above the notices and the notices are bounded, so nothing arriving later
 * pushes the slot off the frame; that 40 columns still reads; and that a real Ink render of the shell
 * contains the same mode line the composer produced.
 */
import { EventEmitter } from 'node:events';

import { describe, expect, it, vi } from 'vitest';

import { COMMANDS } from '../src/contracts/index.js';
import {
  AUTONOMY_MODES,
  AUTONOMY_MODE_DESCRIPTIONS,
  AUTONOMY_MODE_TRANSITIONS,
  MODE_LABEL,
  NARROW_COLUMNS,
  QUESTION_SLOT_LABEL,
  SHADOW_MODE_NOTE,
  STATUS_LABELS,
  applyCommandToMode,
  foldEvents,
  formatModeLine,
  mountShell,
  shellFrameLines,
  shellFrameText,
} from '../src/tui/index.js';
import type { ShellView } from '../src/tui/index.js';

import {
  buildLog,
  commandApplied,
  featureStateChanged,
  questionAsked,
  runCreated,
  stepStarted,
  stepTerminated,
} from './helpers/tui-log.js';

const NOW = new Date('2026-09-20T09:10:00.000Z');

/** The four render states the matrix names, each folded from a log rather than hand-built. */
const RENDER_STATES: Readonly<Record<string, () => ShellView>> = {
  idle: () => foldEvents([]),
  'mid-step': () =>
    foldEvents(
      buildLog([runCreated(), featureStateChanged('running'), stepStarted('implement')]),
    ),
  'question pending': () =>
    foldEvents(
      buildLog([
        runCreated(),
        featureStateChanged('running'),
        stepStarted('implement'),
        questionAsked('q-01'),
      ]),
    ),
  'post-kill': () =>
    foldEvents(
      buildLog([
        runCreated(),
        featureStateChanged('running'),
        stepStarted('implement'),
        commandApplied('kill', { step_disposition: 'killed', effect: 'the step was killed' }),
        stepTerminated('implement', 'killed'),
        featureStateChanged('killed', 'running'),
      ]),
    ),
};

describe('the mode is displayed in every render state', () => {
  it.each(Object.keys(RENDER_STATES))('states the mode when %s', (state) => {
    const view = RENDER_STATES[state]?.() ?? foldEvents([]);
    const frame = shellFrameText(view, { now: NOW });

    expect(frame).toContain(`${MODE_LABEL} `);
    expect(frame).toContain(`${MODE_LABEL} ${view.autonomy}`);
    expect(AUTONOMY_MODES).toContain(view.autonomy);
    // And what the mode means, because a label a person has to decode is a label they can misread.
    expect(frame).toContain(AUTONOMY_MODE_DESCRIPTIONS[view.autonomy]);
  });

  it.each(Object.keys(RENDER_STATES))('never renders %s without the ambient status either', (state) => {
    const frame = shellFrameText(RENDER_STATES[state]?.() ?? foldEvents([]), { now: NOW });
    expect(frame).toContain(STATUS_LABELS.Steps);
    expect(frame).toContain(STATUS_LABELS.Budget);
    expect(frame).toContain(STATUS_LABELS.Elapsed);
  });

  it.each(AUTONOMY_MODES)('shows the mode line for %s in all four render states', (mode) => {
    for (const state of Object.keys(RENDER_STATES)) {
      const base = RENDER_STATES[state]?.() ?? foldEvents([]);
      const view: ShellView = { ...base, autonomy: mode };
      expect(shellFrameText(view, { now: NOW }), `${mode} in ${state}`).toContain(
        `${MODE_LABEL} ${mode}`,
      );
    }
  });

  it('is the first thing in the frame after a problem report', () => {
    const lines = shellFrameLines(RENDER_STATES['mid-step']?.() ?? foldEvents([]), { now: NOW });
    const modeIndex = lines.findIndex((line) => line.startsWith(`${MODE_LABEL} `));
    expect(modeIndex).toBeGreaterThanOrEqual(0);
    expect(modeIndex).toBeLessThanOrEqual(2);
  });
});

describe('the mode a person reads is the mode the log recorded', () => {
  it('reads just-do-it once the command has been applied', () => {
    const view = foldEvents(buildLog([runCreated(), commandApplied('just_do_it')]));
    expect(view.autonomy).toBe('just-do-it');
  });

  it('does not walk just-do-it back on a continue, because nobody asked to be asked again', () => {
    const view = foldEvents(
      buildLog([runCreated(), commandApplied('just_do_it'), commandApplied('continue')]),
    );
    expect(view.autonomy).toBe('just-do-it');
  });

  it('reads paused after a pause, and taken-over after a take over', () => {
    expect(foldEvents(buildLog([runCreated(), commandApplied('pause')])).autonomy).toBe('paused');
    expect(foldEvents(buildLog([runCreated(), commandApplied('take_over')])).autonomy).toBe(
      'taken-over',
    );
  });

  it('reads stopped after a disengage, and after a kill', () => {
    expect(foldEvents(buildLog([runCreated(), commandApplied('disengage')])).autonomy).toBe('stopped');
    expect((RENDER_STATES['post-kill']?.() ?? foldEvents([])).autonomy).toBe('stopped');
  });

  it('forces stopped on a terminal feature state, whatever the commands said', () => {
    // The false belief this whole module exists to prevent: a mode line reading just-do-it over a run
    // that has stopped.
    const view = foldEvents(
      buildLog([
        runCreated(),
        commandApplied('just_do_it'),
        featureStateChanged('handed_off', 'running'),
      ]),
    );
    expect(view.autonomy).toBe('stopped');
    expect(shellFrameText(view, { now: NOW })).toContain(`${MODE_LABEL} stopped`);
  });

  it('says what a shadow run does differently, rather than only naming it (AD-27)', () => {
    const view = foldEvents(buildLog([runCreated({ mode: 'shadow', step_count: 2 })]));
    expect(view.runMode).toBe('shadow');
    expect(formatModeLine(view)).toContain(SHADOW_MODE_NOTE);
  });
});

describe('the mode table is total over the Command enum', () => {
  it('decides an effect on the mode for every command, including "no change"', () => {
    for (const command of COMMANDS) {
      expect(
        Object.prototype.hasOwnProperty.call(AUTONOMY_MODE_TRANSITIONS, command),
        `no mode decision for "${command}"`,
      ).toBe(true);
    }
    expect(Object.keys(AUTONOMY_MODE_TRANSITIONS)).toHaveLength(COMMANDS.length);
  });

  it('describes every mode in the enum', () => {
    for (const mode of AUTONOMY_MODES) {
      expect(AUTONOMY_MODE_DESCRIPTIONS[mode].length).toBeGreaterThan(0);
    }
  });

  it('leaves the mode alone for a command a newer build invented', () => {
    expect(applyCommandToMode('interactive', 'teleport')).toBe('interactive');
  });
});

describe('the question slot is persistent, and nothing later scrolls it away (R14)', () => {
  const withQuestionThenTraffic = (): ShellView =>
    foldEvents(
      buildLog([
        runCreated(),
        featureStateChanged('running'),
        stepStarted('implement'),
        questionAsked('q-01'),
        commandApplied('narrow', { intent_id: 'cmd-narrow-01' }),
        commandApplied('inject_note', { intent_id: 'cmd-note-01' }),
        stepTerminated('implement'),
        stepStarted('verify', 'verification'),
        commandApplied('continue', { intent_id: 'cmd-continue-01' }),
        commandApplied('approve', { intent_id: 'cmd-approve-01' }),
      ]),
    );

  it('still holds the pending question after a run of later events', () => {
    const view = withQuestionThenTraffic();
    expect(view.question.state).toBe('pending');
    const lines = shellFrameLines(view, { now: NOW });
    const slotIndex = lines.findIndex((line) => line.startsWith(`${QUESTION_SLOT_LABEL}:`));
    expect(slotIndex).toBeGreaterThanOrEqual(0);
    // Above the notices, so a notice cannot displace it — and the notices are bounded by the fold.
    const firstNotice = lines.findIndex((line) => line.startsWith('- '));
    expect(firstNotice).toBeGreaterThan(slotIndex);
    expect(lines.filter((line) => line.startsWith('- ')).length).toBeLessThanOrEqual(4);
  });

  it('keeps the slot present, and states the outcome, once the question is settled', () => {
    const view = foldEvents(
      buildLog([
        runCreated(),
        questionAsked('q-01'),
        { type: 'question.default_taken', payload: { question_id: 'q-01', resolver: 'timeout_default' } },
        stepStarted('implement'),
      ]),
    );
    expect(view.question.state).toBe('defaulted');
    const frame = shellFrameText(view, { now: NOW });
    expect(frame).toContain(`${QUESTION_SLOT_LABEL}:`);
    // Story 1-8's rule, made visible: a losing resolver is told plainly what happened.
    expect(frame).toContain('did not land');
  });

  it('holds a slot even when nothing is pending, so the slot never appears from nowhere', () => {
    const frame = shellFrameText(RENDER_STATES['mid-step']?.() ?? foldEvents([]), { now: NOW });
    expect(frame).toContain(`${QUESTION_SLOT_LABEL}:`);
  });
});

describe('a narrow or colourless terminal is still readable', () => {
  it('keeps every line inside 40 columns, with the mode and status still present', () => {
    const view = RENDER_STATES['question pending']?.() ?? foldEvents([]);
    const lines = shellFrameLines(view, { columns: NARROW_COLUMNS, now: NOW });

    for (const line of lines) expect(line.length, line).toBeLessThanOrEqual(NARROW_COLUMNS);
    expect(lines.some((line) => line.startsWith(`${MODE_LABEL} `))).toBe(true);
    expect(lines.join('\n')).toContain(STATUS_LABELS.Steps);
    expect(lines.join('\n')).toContain(QUESTION_SLOT_LABEL);
  });

  it('carries no colour at all, so a terminal without colour shows the same frame', () => {
    const frame = shellFrameText(RENDER_STATES['post-kill']?.() ?? foldEvents([]), { now: NOW });
    // No escape sequence of any kind: nothing in the shell sets a colour or an attribute.
    expect(frame).not.toMatch(/\[/);
  });
});

describe('the Ink shell draws the frame the composer produced', () => {
  /** A terminal that keeps what was written to it, so a frame can be read back. */
  class FakeStdout extends EventEmitter {
    readonly columns = 80;
    readonly rows = 40;
    readonly writes: string[] = [];

    write(chunk: string): boolean {
      this.writes.push(chunk);
      return true;
    }

    frame(): string {
      return this.writes.join('');
    }
  }

  it('renders the mode, the status, the progress and the slot through a real Ink render', async () => {
    const stdout = new FakeStdout();
    const handle = mountShell({
      // No log on disk: the idle state is a render state like any other, and the one that needs no
      // fixture. What is being asserted here is the composition, not the fold.
      eventLog: '/nonexistent/events.jsonl',
      feature: 'tui-shell',
      stdout: stdout as unknown as NodeJS.WriteStream,
      debug: true,
      now: NOW,
    });

    try {
      await vi.waitFor(() => {
        expect(stdout.frame()).toContain(`${MODE_LABEL} `);
      });
      const frame = stdout.frame();
      expect(frame).toContain('feature: tui-shell');
      expect(frame).toContain(STATUS_LABELS.Steps);
      expect(frame).toContain(`${QUESTION_SLOT_LABEL}:`);
      expect(frame).toContain('next gate:');
      // The one gesture that always means stop is on the frame, not behind a command.
      expect(frame).toContain('x stop');
      expect(handle.lastView().problem).toBeNull();
    } finally {
      handle.unmount();
    }
  });
});
