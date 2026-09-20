/**
 * Matrix 1, 3 and 4 — the acceptance criteria as lines of the durable truth.
 *
 * Driven through a **real reconciler** rather than through hand-built envelopes, because the claim is that
 * the engine records the criteria on the path a run actually takes: `acceptFeature` for the declaration, a
 * durable `edit_criterion` intent for an amendment (AD-19), and a crash-truncated log for the recovery case.
 * A suite that appended its own `spec.recorded` line would prove that the fold works and nothing about the
 * engine.
 *
 * Matrix 4's later-wins rule gets the sharpest test in the file, because concatenation is the failure that
 * looks harmless: a card offering to confirm five criteria where the run declared three is a durable
 * decision about a set the run never had (CAP-18).
 */
import { rmSync, writeFileSync } from 'node:fs';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SpecRecordedPayloadSchema } from '../src/contracts/index.js';
import type { EventEnvelope, QuestionDraft } from '../src/contracts/index.js';
import {
  Reconciler,
  SPEC_CRITERION_EDITED_EVENT_TYPE,
  SPEC_RECORDED_EVENT_TYPE,
  createRecordingResetter,
  createScriptedExecutor,
  criterionEditedPayload,
  terminated,
} from '../src/engine/index.js';
import { Recorder, readEventLog, runPaths } from '../src/runtime/index.js';
import { buildSpecEchoCard, editCriterionArgument, foldEvents } from '../src/tui/index.js';

import { makeHome, makePlan, planProvider } from './helpers/engine-fixture.js';

const BASELINE = 'ddd9bed4d286ac1f8a0f4f7bfef9530046605787';
const PRINCIPAL = { kind: 'user' as const, id: 'deep' };
const FEATURE = 'engine-reconciler';

const CRITERIA = [
  'the loop takes at most one action per pass',
  'a restart converges on the same state',
  'a killed step is never re-run',
];

/** A question, so an `edit_criterion` intent has the compare-and-set it resolves through (AD-25). */
const DRAFT: QuestionDraft = {
  prompt: 'Is criterion 2 worded the way you meant?',
  brief: 'The second criterion is the crash-recovery one, and its wording decides what the gate measures.',
  options: [
    { id: 'as-is', label: 'leave it', consequence: 'the criteria are confirmed as first recorded' },
    { id: 'amend', label: 'amend it', consequence: 'the amended wording replaces that line' },
  ],
  escape: { id: 'ask-me', label: 'ask me again later', consequence: 'nothing changes yet' },
  recommended_option_id: 'as-is',
  default_action: 'the criteria stand as first recorded',
  default_window_ms: 900_000,
};

let home: string;
const toClose: Reconciler[] = [];
const toRemove: string[] = [];

beforeEach(() => {
  home = makeHome('engine-spec-record');
  toRemove.push(home);
});

afterEach(() => {
  for (const reconciler of toClose.splice(0)) reconciler.close();
  for (const dir of toRemove.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const openReconciler = (criteria: readonly string[] = CRITERIA): Reconciler => {
  const reconciler = Reconciler.open({
    orchHome: home,
    executor: createScriptedExecutor({
      onStart: (request) => terminated(request.step, 'completed'),
    }),
    plans: planProvider(makePlan({ acceptance_criteria: criteria })),
    baseline: createRecordingResetter(BASELINE),
  });
  toClose.push(reconciler);
  return reconciler;
};

/** Close whatever reconciler is open, so a direct recorder can take the AD-29 single-writer claim. */
const releaseEngine = (): void => {
  for (const reconciler of toClose.splice(0)) reconciler.close();
};

const eventsOf = (run: string): readonly EventEnvelope[] =>
  readEventLog(runPaths(run, home).eventLog);

const specLines = (run: string): readonly EventEnvelope[] =>
  eventsOf(run).filter((event) => event.type === SPEC_RECORDED_EVENT_TYPE);

/** Append one line as another emitter would, with the engine's claim released first (AD-29). */
const appendDirectly = (run: string, type: string, payload: Record<string, unknown>): void => {
  releaseEngine();
  const recorder = Recorder.open({ runId: run, feature: FEATURE, orchHome: home });
  try {
    recorder.record({ feature: FEATURE, run, step: null, emitter: 'engine.reconciler', type, payload });
  } finally {
    recorder.close();
  }
};

describe('a feature whose criteria are known records them in the log (matrix 1)', () => {
  it('records the request and the ordered criteria when the run is accepted', () => {
    const reconciler = openReconciler();
    const accepted = reconciler.acceptFeature(makePlan({ acceptance_criteria: CRITERIA }));

    const [line] = specLines(accepted.run);
    expect(line).toBeDefined();
    const payload = SpecRecordedPayloadSchema.parse(line?.payload);
    expect(payload.acceptance_criteria).toStrictEqual(CRITERIA);
    expect(payload.request).toBe('add a reconciler loop that advances a feature by one action per pass');
  });

  it('builds the spec echo from that log alone, in order, with the one-keystroke confirm', () => {
    const reconciler = openReconciler();
    const accepted = reconciler.acceptFeature(makePlan({ acceptance_criteria: CRITERIA }));

    // Nothing but the log: no plan, no checkpoint, no injected criteria.
    const card = buildSpecEchoCard({ view: foldEvents(eventsOf(accepted.run)) });
    expect(card.unrecorded).toBe(false);
    expect(card.criteria.map((criterion) => criterion.text)).toStrictEqual(CRITERIA);
    expect(card.criteria.map((criterion) => criterion.line)).toStrictEqual([1, 2, 3]);
    expect(card.lines.join('\n')).toContain(`press "${card.confirmKey}" to confirm all 3 as written`);
  });

  it('records the criteria for a run whose creation was killed before it could (AD-32)', async () => {
    // The declaration is a reconcile action, not a creation-time one: a run left holding only `run.created`
    // has its criteria appended by the next pass. Without that, the gate would hold only for runs that were
    // never interrupted — which is what the crash-injection suite caught at boundaries 1 and 2.
    const reconciler = openReconciler();
    const accepted = reconciler.acceptFeature(makePlan({ acceptance_criteria: CRITERIA }));
    const paths = runPaths(accepted.run, home);
    const [created] = eventsOf(accepted.run);
    if (created === undefined) throw new Error('no run.created line');
    releaseEngine();

    // The log a kill between `run.created` and the two declarations would have left behind.
    writeFileSync(paths.eventLog, `${JSON.stringify(created)}\n`, 'utf8');
    expect(specLines(accepted.run)).toHaveLength(0);

    await openReconciler().pass();

    expect(specLines(accepted.run)).toHaveLength(1);
    expect(
      SpecRecordedPayloadSchema.parse(specLines(accepted.run)[0]?.payload).acceptance_criteria,
    ).toStrictEqual(CRITERIA);
    // And a second pass appends nothing, because the guard is what the log already carries.
    await toClose[0]?.pass();
    expect(specLines(accepted.run)).toHaveLength(1);
  });
});

describe('a criterion edited through edit_criterion reaches the log (matrix 3)', () => {
  it('records the amendment, and the card renders the current text and that it was edited', () => {
    const reconciler = openReconciler();
    const accepted = reconciler.acceptFeature(makePlan({ acceptance_criteria: CRITERIA }));
    reconciler.ask(accepted.run, DRAFT);

    const amended = 'a restart converges on the same state, from a kill at any transition';
    reconciler.editCriterion(accepted.run, editCriterionArgument(2, amended), {
      principal: PRINCIPAL,
    });

    const edits = eventsOf(accepted.run).filter(
      (event) => event.type === SPEC_CRITERION_EDITED_EVENT_TYPE,
    );
    expect(edits).toHaveLength(1);
    expect(edits[0]?.payload).toStrictEqual({ line: 2, text: amended });

    const card = buildSpecEchoCard({ view: foldEvents(eventsOf(accepted.run)) });
    expect(card.criteria.map((criterion) => criterion.text)).toStrictEqual([
      CRITERIA[0],
      amended,
      CRITERIA[2],
    ]);
    expect(card.criteria[1]?.edited).toBe(true);
    expect(card.criteria[0]?.edited).toBe(false);
    expect(card.lines.join('\n')).toContain('(edited)');
    expect(card.lines.join('\n')).toContain('amended after they were first recorded');
  });

  it('records an amendment that names no line rather than discarding a person’s words (Q6)', () => {
    // Q6 forbids imposing a format, so "the second one should say…" is a person's answer and not a fault.
    expect(criterionEditedPayload('the second one should mention the crash boundaries')).toStrictEqual({
      line: null,
      text: 'the second one should mention the crash boundaries',
    });
  });

  it('reads the card’s own spelling of a line number back, so the two halves cannot drift', () => {
    // `editCriterionArgument` writes it and `criterionEditedPayload` reads it: one agreement, two files.
    expect(criterionEditedPayload(editCriterionArgument(4, 'the mode is always visible'))).toStrictEqual({
      line: 4,
      text: 'the mode is always visible',
    });
    // A line number that is not a positive integer is no line number, and is recorded as none rather than
    // as criterion zero.
    expect(criterionEditedPayload('criterion 0: nothing').line).toBeNull();
  });

  it('states an amendment naming a line the set does not have, rather than applying it anywhere', () => {
    const reconciler = openReconciler();
    const accepted = reconciler.acceptFeature(makePlan({ acceptance_criteria: CRITERIA }));
    appendDirectly(accepted.run, SPEC_CRITERION_EDITED_EVENT_TYPE, {
      line: 9,
      text: 'a criterion that does not exist',
    });

    const view = foldEvents(eventsOf(accepted.run));
    expect(view.spec.criteria.map((criterion) => criterion.text)).toStrictEqual(CRITERIA);
    expect(view.spec.criteria.some((criterion) => criterion.edited)).toBe(false);
    expect(view.notices.map((notice) => notice.text).join(' ')).toContain('name no numbered line');
  });
});

describe('spec.recorded seen twice for one feature: the later one wins (matrix 4)', () => {
  const first = ['one action per pass', 'a restart converges'];
  const second = [
    'one action per pass',
    'a restart converges from any kill',
    'a killed step is never re-run',
  ];

  it('replaces the earlier set rather than concatenating or duplicating it', () => {
    const reconciler = openReconciler(first);
    const accepted = reconciler.acceptFeature(makePlan({ acceptance_criteria: first }));
    appendDirectly(
      accepted.run,
      SPEC_RECORDED_EVENT_TYPE,
      SpecRecordedPayloadSchema.parse({
        request: 'the corrected request',
        acceptance_criteria: second,
      }),
    );

    const view = foldEvents(eventsOf(accepted.run));
    expect(view.spec.criteria.map((criterion) => criterion.text)).toStrictEqual(second);
    expect(view.spec.request).toBe('the corrected request');
    // The sharp part: no criterion twice, and the count is the later set's.
    expect(view.spec.criteria).toHaveLength(second.length);
    expect(new Set(view.spec.criteria.map((criterion) => criterion.text)).size).toBe(second.length);
    expect(view.spec.criteria.map((criterion) => criterion.line)).toStrictEqual([1, 2, 3]);

    const card = buildSpecEchoCard({ view });
    expect(card.lines.join('\n')).toContain('confirm all 3 as written');
    expect(card.lines.join('\n')).not.toContain('confirm all 5');
    // And no criterion from the earlier set survives that the later one dropped.
    expect(card.lines.join('\n')).not.toContain('a restart converges\n');
  });

  it('resets the edit flags with the set, because an amendment applied to the criteria then current', () => {
    const reconciler = openReconciler(first);
    const accepted = reconciler.acceptFeature(makePlan({ acceptance_criteria: first }));
    appendDirectly(accepted.run, SPEC_CRITERION_EDITED_EVENT_TYPE, { line: 2, text: 'amended once' });
    expect(foldEvents(eventsOf(accepted.run)).spec.criteria[1]?.edited).toBe(true);

    appendDirectly(
      accepted.run,
      SPEC_RECORDED_EVENT_TYPE,
      SpecRecordedPayloadSchema.parse({ request: 'redeclared', acceptance_criteria: second }),
    );
    const after = foldEvents(eventsOf(accepted.run)).spec;
    expect(after.criteria.some((criterion) => criterion.edited)).toBe(false);
    expect(after.criteria.map((criterion) => criterion.text)).toStrictEqual(second);
  });

  it('says the criteria are unrecorded for a log that carries no spec.recorded at all (AD-5)', () => {
    const view = foldEvents([]);
    expect(view.spec.recorded).toBe(false);
    expect(view.spec.criteria).toStrictEqual([]);
    expect(buildSpecEchoCard({ view }).unrecorded).toBe(true);
  });
});
