/**
 * AD-4 — the renderer is a projection of the log, and this is where that is machine-checked.
 *
 * The suite is deliberately almost all pure-function tests, and that is the story's own reasoning: a
 * fold from events to view state needs no terminal, no Ink and no React, and it is where the reporting
 * rules stop being prose and become assertions — no share of a whole as progress, feature names rather
 * than run ids, an unknown type ignored, the same events giving the same view. A suite of rendered
 * frames would be slower, more brittle, and would still not say whether the projection is right.
 *
 * Two tests here are about drift rather than behaviour, and they are the ones that would otherwise fail
 * silently:
 *
 * - the fold declares the event vocabulary as its own constants, because the spine forbids a renderer
 *   importing `src/engine/` — so one test compares those constants against the engine's own tables *in
 *   the test*, which is the only place the two may meet;
 * - one test folds a log a **real reconciler wrote**, because every other test here builds its own
 *   envelopes, and a payload key renamed on the engine's side would leave all of them passing while the
 *   shell displayed nothing.
 */
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { EVENT_TYPES, STEP_PHASES } from '../src/contracts/index.js';
import {
  COMMAND_EVENT_TYPES,
  ENGINE_EVENT_TYPES,
  QUESTION_EVENT_TYPES,
  Reconciler,
  createRecordingResetter,
  createScriptedExecutor,
  terminated,
} from '../src/engine/index.js';
import { REDACTION_MARKER, readEventLog, runPaths } from '../src/runtime/index.js';
import {
  REDACTED_PRESENTATION,
  TUI_EVENT_TYPES,
  foldEvents,
  idleShellView,
  loadShellView,
  presentValue,
  shellFrameText,
} from '../src/tui/index.js';

import { makeHome, makePlan, planProvider } from './helpers/engine-fixture.js';
import {
  FIXTURE_FEATURE,
  FIXTURE_RUN,
  budgetDegraded,
  buildLog,
  commandApplied,
  commandRefused,
  featureStateChanged,
  handoffRecorded,
  logText,
  permissionDenied,
  questionAsked,
  questionDeflected,
  questionResolved,
  redactionFailed,
  runCreated,
  stepStarted,
  stepTerminated,
  unknownEvent,
} from './helpers/tui-log.js';

const BASELINE = 'ddd9bed4d286ac1f8a0f4f7bfef9530046605787';

let home: string;
const toRemove: string[] = [];
const toClose: Reconciler[] = [];

beforeEach(() => {
  home = makeHome('tui-projection');
  toRemove.push(home);
});

afterEach(() => {
  for (const reconciler of toClose.splice(0)) reconciler.close();
  for (const dir of toRemove.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A run in progress: created, confirmed, one step started and not terminated. */
const midStepLog = (): ReturnType<typeof buildLog> =>
  buildLog([
    runCreated(),
    featureStateChanged('confirmed'),
    featureStateChanged('running', 'confirmed'),
    stepStarted('implement'),
  ]);

describe('an empty log folds to a coherent idle view', () => {
  it('renders without a crash and without a blank screen', () => {
    const view = foldEvents([]);
    expect(view).toStrictEqual(idleShellView());
    expect(view.problem).toBeNull();

    const frame = shellFrameText(view, { now: new Date() });
    expect(frame.trim()).not.toBe('');
    // The mode is a safety property, so it is present even when there is nothing else to say.
    expect(frame).toContain('mode interactive');
  });

  it('states a next gate rather than leaving a person to guess', () => {
    expect(foldEvents([]).progress.nextGate).toContain('first step');
  });
});

describe('a run in progress shows the step name and the next gate, never a share of a whole', () => {
  const view = foldEvents(midStepLog());

  it('names the step in flight and the phase it belongs to', () => {
    expect(view.progress.currentStep).toBe('implement');
    expect(view.progress.currentStepPhase).toBe('implementation');
    expect(view.featureState).toBe('running');
    expect(view.progress.stepsStarted).toBe(1);
    expect(view.progress.stepsCompleted).toBe(0);
    expect(view.progress.plannedSteps).toBe(2);
  });

  it('states the next gate as a gate, in words', () => {
    expect(view.progress.nextGate).toBe('verification, once the implementation steps are done');
  });

  /**
   * Matrix 32 — every member of `STEP_PHASES`, folded, so the next widening is covered by construction.
   *
   * Story 2-4 widened the enum to four and this suite kept passing, because every fixture here starts an
   * `implementation` or a `verification` step: `stepPhase` was a pair of literals and reverting it to that
   * pair left all eighty TUI tests green. A phase the projection cannot place renders as no phase at all,
   * and the next-up line took the `else` branch and told a person the implementation steps were done
   * before any had started. Driven from the constant so a fifth phase fails here on the day it is added.
   */
  describe('every declared phase (matrix 32)', () => {
    it.each(STEP_PHASES)('reports %s as the phase of the step in flight', (phase) => {
      const folded = foldEvents(
        buildLog([
          runCreated(),
          featureStateChanged('confirmed'),
          featureStateChanged('running', 'confirmed'),
          stepStarted(`step-${phase}`, phase),
        ]),
      );
      expect(folded.progress.currentStepPhase).toBe(phase);
      expect(folded.progress.currentStep).toBe(`step-${phase}`);
    });

    it.each(STEP_PHASES)('says what a run in %s is waiting for, without claiming a later phase', (phase) => {
      const folded = foldEvents(
        buildLog([
          runCreated(),
          featureStateChanged('confirmed'),
          featureStateChanged('running', 'confirmed'),
          stepStarted(`step-${phase}`, phase),
        ]),
      );
      expect(folded.progress.nextGate).not.toBe('');
      if (phase === 'analysis' || phase === 'planning') {
        // The sentence the two-literal branch produced for these two, which was false.
        expect(folded.progress.nextGate).not.toContain('once the implementation steps are done');
      }
    });

    it('ignores a phase this build does not know, rather than naming one it invented', () => {
      const folded = foldEvents(
        buildLog([
          runCreated(),
          featureStateChanged('confirmed'),
          featureStateChanged('running', 'confirmed'),
          stepStarted('step-future', 'documentation'),
        ]),
      );
      expect(folded.progress.currentStepPhase).toBeNull();
      expect(folded.progress.nextGate).toContain('does not recognise');
    });
  });

  it('renders no share of a whole anywhere in the frame (R7)', () => {
    const frame = shellFrameText(view, { now: new Date() });
    // The two spellings a share arrives in: the sign, and the word.
    expect(frame).not.toContain('%');
    expect(frame.toLowerCase()).not.toContain('percent');
    expect(frame).toContain('step "implement"');
    expect(frame).toContain('next gate:');
  });

  it('keeps counting steps as they terminate', () => {
    const later = foldEvents(
      buildLog([
        runCreated(),
        featureStateChanged('confirmed'),
        featureStateChanged('running', 'confirmed'),
        stepStarted('implement'),
        stepTerminated('implement'),
        stepStarted('verify', 'verification'),
      ]),
    );
    expect(later.progress.stepsCompleted).toBe(1);
    expect(later.progress.currentStep).toBe('verify');
    expect(later.progress.nextGate).toBe('the verification gates');
  });
});

describe('the fold is a projection: the same events give the same view', () => {
  it('folds one sequence twice to an identical view', () => {
    const events = buildLog([
      runCreated(),
      featureStateChanged('confirmed'),
      featureStateChanged('running', 'confirmed'),
      stepStarted('implement'),
      questionAsked('q-01'),
      budgetDegraded(0.4, 300_000),
      commandApplied('pause'),
    ]);
    expect(foldEvents(events)).toStrictEqual(foldEvents(events));
  });

  it('does not depend on the order the lines were handed to it, because `seq` orders them', () => {
    const events = midStepLog();
    const shuffled = [events[3], events[1], events[0], events[2]].filter(
      (event): event is NonNullable<typeof event> => event !== undefined,
    );
    expect(foldEvents(shuffled)).toStrictEqual(foldEvents(events));
  });
});

describe('an unknown event type is ignored, and adding a type is never breaking (AD-5)', () => {
  it('folds a log carrying an unknown type to exactly the view without it', () => {
    const known = midStepLog();
    // The known lines keep the timestamps they have in `midStepLog`, so the only difference between the
    // two logs is the presence of the lines this build does not declare.
    const withUnknown = buildLog([
      { ...runCreated(), atMs: 0 },
      { ...featureStateChanged('confirmed'), atMs: 1_000 },
      { ...unknownEvent(), atMs: 1_500 },
      { ...featureStateChanged('running', 'confirmed'), atMs: 2_000 },
      { ...stepStarted('implement'), atMs: 3_000 },
      { ...unknownEvent('consolidation.swept'), atMs: 4_000 },
    ]);
    // Not merely "does not throw": the view is identical, so an unknown type moves no counter and no
    // timestamp either.
    expect(foldEvents(withUnknown)).toStrictEqual(foldEvents(known));
  });

  it('ignores a command it does not know without losing the mode', () => {
    const view = foldEvents(
      buildLog([runCreated(), commandApplied('teleport'), commandApplied('just_do_it')]),
    );
    expect(view.autonomy).toBe('just-do-it');
  });
});

describe('everything is addressed by feature name (R6)', () => {
  it('carries the feature and never the run id', () => {
    const view = foldEvents(midStepLog());
    expect(view.feature).toBe(FIXTURE_FEATURE);
    expect(JSON.stringify(view)).not.toContain(FIXTURE_RUN);

    const frame = shellFrameText(view, { now: new Date() });
    expect(frame).toContain(`feature: ${FIXTURE_FEATURE}`);
    expect(frame).not.toContain(FIXTURE_RUN);
    // Nor the emitter: an agent name is not something a person should have to know.
    expect(frame).not.toContain('engine.reconciler');
  });
});

describe('a redacted field is presented as redacted, never as a value and never as an error', () => {
  it('shows the marker as redaction rather than as the prompt', () => {
    const view = foldEvents(
      buildLog([runCreated(), questionAsked('q-01', { prompt: REDACTION_MARKER })]),
    );
    expect(view.question.state).toBe('pending');
    expect(presentValue(view.question.prompt)).toBe(REDACTED_PRESENTATION);
    expect(shellFrameText(view, { now: new Date() })).toContain(REDACTED_PRESENTATION);
  });
});

describe('a log the reader refuses leaves the shell up and saying so', () => {
  it('states the problem plainly rather than throwing a stack trace', () => {
    const paths = runPaths(FIXTURE_RUN, home);
    mkdirSync(paths.runDir, { recursive: true });
    writeFileSync(paths.eventLog, '{"ts":"2026-09-20T09:00:00.000Z","seq":1,not json\n', 'utf8');

    const view = loadShellView(paths.eventLog, { feature: FIXTURE_FEATURE });
    expect(view.problem).not.toBeNull();
    expect(view.problem).toContain('could not be read');

    const frame = shellFrameText(view, { now: new Date() });
    expect(frame).toContain('could not be read');
    // Still up, and still stating the mode: the two things the matrix asks for in this case.
    expect(frame).toContain('mode interactive');
    expect(frame).not.toContain('at Object.');
  });

  it('reads a well-formed log from disk into the same view the fold gives', () => {
    const paths = runPaths(FIXTURE_RUN, home);
    mkdirSync(paths.runDir, { recursive: true });
    const events = midStepLog();
    writeFileSync(paths.eventLog, logText(events), 'utf8');

    expect(loadShellView(paths.eventLog)).toStrictEqual(foldEvents(events));
  });

  it('folds an absent log as an idle run rather than as a failure', () => {
    const paths = runPaths(FIXTURE_RUN, home);
    expect(loadShellView(paths.eventLog, { feature: FIXTURE_FEATURE })).toStrictEqual(
      idleShellView(FIXTURE_FEATURE),
    );
  });
});

describe('the fold reads the log a real reconciler wrote', () => {
  it('projects a real run without any hand-built envelope', async () => {
    const plan = makePlan({ feature: 'tui-real-run' });
    const reconciler = Reconciler.open({
      orchHome: home,
      executor: createScriptedExecutor({
        onStart: (request) => terminated(request.step, 'completed', { sessionId: `sess-${request.step}` }),
        sessionIdFor: (request) => `sess-${request.step}`,
      }),
      plans: planProvider(plan),
      baseline: createRecordingResetter(BASELINE),
    });
    toClose.push(reconciler);

    const accepted = reconciler.acceptFeature(plan);
    reconciler.steer(accepted.run, 'confirm_spec', { principal: { kind: 'user', id: 'deep' } });
    await reconciler.pass();

    const paths = runPaths(accepted.run, home);
    const view = foldEvents(readEventLog(paths.eventLog));

    // The payload keys the fold reads are the engine's: a rename on either side breaks this line.
    expect(view.feature).toBe('tui-real-run');
    expect(view.runMode).toBe('live');
    expect(view.progress.plannedSteps).toBe(plan.steps.length);
    expect(view.progress.stepsStarted).toBeGreaterThan(0);
    expect(view.progress.steps[0]?.step).toBe('implement');
    expect(view.progress.steps[0]?.phase).toBe('implementation');
    expect(view.featureState).not.toBeNull();
    // And the run id the engine minted is nowhere in the frame (R6).
    expect(shellFrameText(view, { now: new Date() })).not.toContain(accepted.run);
  });

  /**
   * The mode and the notice, asserted against a payload the **engine** wrote.
   *
   * Every other mode and notice assertion in the repository is driven by `commandApplied()` in
   * `tests/helpers/tui-log.ts`, a builder written by the same hand as the reader — so the two agreed
   * with each other and nothing checked that either agreed with the producer. The autonomy mode is
   * derived from the `command` key of a `command.applied` payload, declared locally as
   * `TUI_PAYLOAD_KEYS.Command` because `src/tui/` may not import the engine; the one test that folded a
   * real reconciler's log asserted the feature, the run mode, the planned steps and the step phase, and
   * never `view.autonomy` or `view.notices`. This closes that: a real `just_do_it` and a real
   * `disengage`, folded from the file the recorder appended to.
   */
  it('reads the autonomy mode and the notices out of payloads the engine wrote', () => {
    const plan = makePlan({ feature: 'tui-real-mode' });
    const reconciler = Reconciler.open({
      orchHome: home,
      executor: createScriptedExecutor({
        onStart: (request) => terminated(request.step, 'completed', { sessionId: `sess-${request.step}` }),
        sessionIdFor: (request) => `sess-${request.step}`,
      }),
      plans: planProvider(plan),
      baseline: createRecordingResetter(BASELINE),
    });
    toClose.push(reconciler);

    const principal = { kind: 'user' as const, id: 'deep' };
    const accepted = reconciler.acceptFeature(plan);
    const paths = runPaths(accepted.run, home);

    reconciler.steer(accepted.run, 'just_do_it', { principal });
    const engaged = foldEvents(readEventLog(paths.eventLog));
    expect(engaged.autonomy).toBe('just-do-it');
    expect(engaged.notices.map((notice) => notice.text).join('\n')).toContain('just do it applied');

    reconciler.steer(accepted.run, 'disengage', { principal });
    const stopped = foldEvents(readEventLog(paths.eventLog));
    expect(stopped.autonomy).toBe('stopped');
    expect(stopped.notices.map((notice) => notice.text).join('\n')).toContain('disengage applied');
    // The frame a person reads says it too, which is the whole point of deriving it.
    expect(shellFrameText(stopped, { now: new Date() })).toContain('mode stopped');
  });
});

describe('the "something went wrong" channel says so, for every event that carries one', () => {
  /**
   * Five event types reach a person only as a notice, and none of them had a test.
   *
   * Guarding all four `notice(...)` calls below with `if (false)` — and collapsing `deflected` into
   * `resolved` — left the whole repository green. In a system whose stated convention is that silence
   * means success (R1), a refusal that produces no notice is a person watching their keystroke vanish
   * with nothing to read, which is the one outcome the interface contract rules out twice.
   */
  const noticesOf = (view: ReturnType<typeof foldEvents>): string =>
    view.notices.map((entry) => entry.text).join('\n');

  it('says a control was refused, and that nothing changed', () => {
    const view = foldEvents(buildLog([runCreated(), commandRefused('approve')]));
    const text = noticesOf(view);
    expect(text).toContain('a control was refused');
    expect(text).toContain('wrong-target-state');
    expect(text).toContain('nothing changed');
    expect(shellFrameText(view, { now: new Date() })).toContain('a control was refused');
  });

  it('says the run handed off, with the code and the reason the log recorded (CAP-23)', () => {
    const view = foldEvents(
      buildLog([runCreated(), handoffRecorded('user.take_over', 'you took the work over')]),
    );
    expect(noticesOf(view)).toContain('handed off (user.take_over): you took the work over');
  });

  it('says a tool was denied and that the step carried on without it', () => {
    const view = foldEvents(buildLog([runCreated(), stepStarted('implement'), permissionDenied()]));
    expect(noticesOf(view)).toContain('denied by the permission surface');
  });

  it('says an artifact was dropped rather than written unredacted (AD-21)', () => {
    const view = foldEvents(buildLog([runCreated(), redactionFailed()]));
    expect(noticesOf(view)).toContain('dropped rather than written unredacted');
  });

  it('distinguishes a deflected question from an answered one, because nobody was asked (Q4)', () => {
    const view = foldEvents(
      buildLog([runCreated(), questionAsked('q-01'), questionDeflected('q-01')]),
    );
    expect(view.question.state).toBe('deflected');
    expect(view.question.outcome).toContain('nobody was asked');
    // And the frame says which of the two happened, rather than only that it is settled.
    expect(shellFrameText(view, { now: new Date() })).toContain('deflected:');
  });

  it('keeps the notice list bounded, so nothing can push the question slot off the frame (R14)', () => {
    const view = foldEvents(
      buildLog([
        runCreated(),
        questionAsked('q-01'),
        commandRefused('approve'),
        permissionDenied(),
        redactionFailed(),
        handoffRecorded(),
        commandRefused('pause', 'not-yet-honoured'),
      ]),
    );
    expect(view.notices.length).toBeLessThanOrEqual(4);
    expect(view.question.state).toBe('pending');
  });
});

describe('a second question does not erase the first, because the engine answers the earliest', () => {
  /**
   * Story 1-8's review established that the engine targets the *earliest* still-asked question.
   *
   * So a slot that showed the later one was actively misleading: it named the question a person's next
   * answer would not reach, and made the one being answered disappear from the only place that reports
   * it. The earliest keeps the slot; the later one is announced and inherits it.
   */
  const twoQuestions = (): ReturnType<typeof buildLog> =>
    buildLog([
      runCreated(),
      { ...questionAsked('q-01', { prompt: 'Poll the log, or watch it?' }), atMs: 1_000 },
      { ...questionAsked('q-02', { prompt: 'Squash the branch, or keep it?' }), atMs: 2_000 },
    ]);

  it('keeps the earlier question in the slot and says another is waiting', () => {
    const view = foldEvents(twoQuestions());
    expect(view.question.state).toBe('pending');
    expect(view.question.prompt).toBe('Poll the log, or watch it?');
    expect(view.notices.map((notice) => notice.text).join('\n')).toContain(
      'a second question is waiting',
    );
  });

  it('promotes the waiting question once the one in the slot is settled', () => {
    const view = foldEvents([
      ...twoQuestions(),
      ...buildLog([{ ...questionResolved('q-01'), atMs: 3_000 }]).map((event) => ({
        ...event,
        seq: 4,
      })),
    ]);
    expect(view.question.state).toBe('pending');
    expect(view.question.prompt).toBe('Squash the branch, or keep it?');
    // The outcome of the one that closed is stated rather than vanishing with it.
    expect(view.notices.map((notice) => notice.text).join('\n')).toContain(
      'the question in the slot was settled',
    );
  });

  it('does not let a later question\'s outcome clear the slot the earlier one holds', () => {
    const view = foldEvents([
      ...twoQuestions(),
      ...buildLog([{ ...questionResolved('q-02'), atMs: 3_000 }]).map((event) => ({
        ...event,
        seq: 4,
      })),
    ]);
    expect(view.question.state).toBe('pending');
    expect(view.question.prompt).toBe('Poll the log, or watch it?');
    expect(view.notices.map((notice) => notice.text).join('\n')).toContain(
      'another question was settled',
    );
  });
});

describe('a partly redacted value is presented as redacted, and never leaks the marker into prose', () => {
  it('flags the marker inside a longer string, not only as the whole of one', () => {
    const inside = `use ${REDACTION_MARKER} to authenticate`;
    expect(presentValue(inside)).toContain(REDACTED_PRESENTATION);
    expect(presentValue(inside)).not.toContain(REDACTION_MARKER);
    expect(presentValue(inside)).toContain('to authenticate');
  });

  it('keeps the engine\'s internal marker out of a notice', () => {
    const view = foldEvents(
      buildLog([runCreated(), commandApplied('reject', { effect: REDACTION_MARKER })]),
    );
    const frame = shellFrameText(view, { now: new Date() });
    expect(frame).toContain(REDACTED_PRESENTATION);
    expect(frame).not.toContain(REDACTION_MARKER);
  });
});

describe('a log being appended to while it is read does not change the mode (the torn-read race)', () => {
  /**
   * The hazard this story exists to prevent, arriving by a race rather than by a disagreement.
   *
   * `readEventLog` refuses a file whose last line has no newline yet, and a renderer polls the file the
   * recorder appends to — so meeting a half-written line is ordinary. The refusal used to reset the
   * frame to `idleShellView`, whose autonomy is `interactive`: for that frame a stopped run read as
   * interactive, which `interface-contract.md` names as the primary interface hazard of a system with
   * autonomy tiers.
   */
  const stoppedLogWithTornTail = (): string => {
    const whole = logText(buildLog([runCreated(), commandApplied('disengage')]));
    return `${whole}{"ts":"2026-09-20T09:00:02.000Z","seq":3,"feature":"tui-shell"`;
  };

  it('keeps the mode the whole lines recorded, rather than resetting to interactive', () => {
    const paths = runPaths(FIXTURE_RUN, home);
    mkdirSync(paths.runDir, { recursive: true });
    writeFileSync(paths.eventLog, stoppedLogWithTornTail(), 'utf8');

    const view = loadShellView(paths.eventLog, { feature: FIXTURE_FEATURE });
    expect(view.autonomy).toBe('stopped');

    const frame = shellFrameText(view, { now: new Date() });
    expect(frame).toContain('mode stopped');
    expect(frame).not.toContain('mode interactive');
    // And says the frame is one line behind, rather than implying it is whole (R12).
    expect(view.problem).not.toBeNull();
    expect(frame).toContain('still being appended');
  });

  it('keeps the last good view when a whole line really is corrupt, mode and all', () => {
    const paths = runPaths(FIXTURE_RUN, home);
    mkdirSync(paths.runDir, { recursive: true });
    writeFileSync(paths.eventLog, logText(buildLog([runCreated(), commandApplied('pause')])), 'utf8');
    const good = loadShellView(paths.eventLog, { feature: FIXTURE_FEATURE });
    expect(good.autonomy).toBe('paused');

    writeFileSync(paths.eventLog, '{"ts":"2026-09-20T09:00:00.000Z","seq":1,not json\n', 'utf8');
    const after = loadShellView(paths.eventLog, { feature: FIXTURE_FEATURE, previous: good });
    expect(after.autonomy).toBe('paused');
    expect(after.problem).toContain('could not be read');
    expect(shellFrameText(after, { now: new Date() })).toContain('mode paused');
  });
});

describe('the vocabulary the fold declares still agrees with the engine that writes it', () => {
  it('names only types the engine or the shared vocabulary declares', () => {
    // The renderer may not import the engine; a *test* may, and this is the one place the two tables
    // are allowed to meet. A type the engine stopped writing would show up here rather than as an
    // empty frame.
    const written = new Set<string>([
      ...Object.values(ENGINE_EVENT_TYPES),
      ...Object.values(COMMAND_EVENT_TYPES),
      ...Object.values(QUESTION_EVENT_TYPES),
      ...EVENT_TYPES,
    ]);
    for (const type of Object.values(TUI_EVENT_TYPES)) {
      expect(written.has(type), `the log carries no "${type}"`).toBe(true);
    }
  });

  it('acts on the state-bearing types the engine folds, so the two cannot disagree about a run', () => {
    const acted = new Set<string>(Object.values(TUI_EVENT_TYPES));
    for (const type of [
      ENGINE_EVENT_TYPES.RunCreated,
      ENGINE_EVENT_TYPES.FeatureStateChanged,
      ENGINE_EVENT_TYPES.StepStarted,
      ENGINE_EVENT_TYPES.StepTerminated,
      COMMAND_EVENT_TYPES.Applied,
      QUESTION_EVENT_TYPES.Asked,
      QUESTION_EVENT_TYPES.Resolved,
      QUESTION_EVENT_TYPES.DefaultTaken,
    ]) {
      expect(acted.has(type), `the fold ignores "${type}"`).toBe(true);
    }
  });
});

describe('src/tui/ imports only contracts, runtime and node: builtins', () => {
  const sourceDir = new URL('../src/tui/', import.meta.url);
  const contractsDir = new URL('../src/contracts/', import.meta.url);
  const runtimeDir = new URL('../src/runtime/', import.meta.url);

  /**
   * Every source file under `src/tui/`, **including the ones in subdirectories**.
   *
   * A flat `readdirSync` saw nine files while sixteen existed: the seven under `src/tui/cards/` — 44% of
   * the directory, and the half story 1-10 added — were checked by neither the engine-import rule nor the
   * writes-no-file rule. The story offers this guard as its substitute for discipline, so a guard that
   * stops at the first subdirectory is the story's own rule going unenforced over the newest code.
   */
  const listSources = (dir: URL, prefix = ''): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory()
        ? listSources(new URL(`${entry.name}/`, dir), `${prefix}${entry.name}/`)
        : entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')
          ? [`${prefix}${entry.name}`]
          : [],
    );

  const files = listSources(sourceDir);

  /** Statement forms only, so a quoted word after "from" in prose is not read as an import. */
  const IMPORT_PATTERNS = [
    /^\s*(?:import|export)\b[^'";]*\bfrom\s*['"]([^'"]+)['"]/gm,
    /^\s*import\s*['"]([^'"]+)['"]/gm,
    /\bimport\s*\(\s*['"]([^'"]+)['"]/g,
    /\brequire\s*\(\s*['"]([^'"]+)['"]/g,
  ];

  const importsOf = (source: string): string[] =>
    IMPORT_PATTERNS.flatMap((pattern) =>
      [...source.matchAll(pattern)].map((match) => match[1] ?? ''),
    );

  /** React and Ink, pinned by the Stack table. Nothing else is added without a recorded deviation. */
  const ALLOWED_PACKAGES = ['react', 'react/jsx-runtime', 'ink'];

  it('has source files to inspect, and reads the imports it claims to', () => {
    expect(files.length).toBeGreaterThan(0);
    const source = readFileSync(new URL('controls.ts', sourceDir), 'utf8');
    expect(importsOf(source)).toContain('../contracts/index.js');
    expect(importsOf(source)).toContain('../runtime/index.js');
  });

  it('descends into every subdirectory, so no part of the renderer is outside the rule', () => {
    // Named files rather than only a count: a listing that silently stopped recursing would otherwise
    // still pass both rules below by having nothing left to check.
    expect(files).toContain('cards/question.ts');
    expect(files).toContain('cards/handoff.ts');
    expect(files.filter((file) => file.includes('/')).length).toBeGreaterThan(1);
  });

  it.each(files)('%s never imports src/engine/', (file) => {
    const from = new URL(file, sourceDir);
    const source = readFileSync(from, 'utf8');
    for (const specifier of importsOf(source)) {
      expect(specifier.includes('/engine/'), `${file} imports "${specifier}"`).toBe(false);
      if (!specifier.startsWith('.')) {
        expect(
          specifier.startsWith('node:') || ALLOWED_PACKAGES.includes(specifier),
          `${file} imports "${specifier}"`,
        ).toBe(true);
        continue;
      }
      /**
       * A relative specifier is resolved against the file that wrote it before it is judged.
       *
       * A prefix test cannot work once the directory has subdirectories: `../projection.js` from
       * `cards/` is inside `src/tui/`, while the identical string from the top level would be outside
       * it. Resolving asks the question that is actually being asked — does this import leave the three
       * directories the spine allows.
       */
      const target = new URL(specifier, from).href;
      const allowed =
        target.startsWith(sourceDir.href) ||
        target.startsWith(contractsDir.href) ||
        target.startsWith(runtimeDir.href);
      expect(allowed, `${file} imports "${specifier}"`).toBe(true);
    }
  });

  it.each(files)('%s writes no file of its own', (file) => {
    // A renderer mutating run state would be a second command path (AD-19), so the shell reaches no
    // write at all: the one write a control performs is the intent file, and it lives in
    // `src/runtime/commands.ts` behind `invokeControl`.
    const source = readFileSync(new URL(file, sourceDir), 'utf8');
    for (const forbidden of ['writeFileSync', 'appendFileSync', 'renameSync', 'node:fs']) {
      expect(source, `${file} reaches ${forbidden}`).not.toContain(forbidden);
    }
  });
});
