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

import { REPAIRED_PAYLOAD_KEY, SpecRecordedPayloadSchema } from '../src/contracts/index.js';
import type { EventEnvelope, QuestionDraft } from '../src/contracts/index.js';
import {
  Reconciler,
  SPEC_CRITERION_EDITED_EVENT_TYPE,
  SPEC_RECORDED_EVENT_TYPE,
  TERRITORY_DECLARED_EVENT_TYPE,
  createRecordingResetter,
  createScriptedExecutor,
  criterionEditedPayload,
  mintIntentId,
  mintRunId,
  newCommandIntent,
  terminated,
  writeCommandIntent,
} from '../src/engine/index.js';
import { REDACTION_MARKER, Recorder, readEventLog, runPaths } from '../src/runtime/index.js';
import {
  REDACTED_PRESENTATION,
  buildSpecEchoCard,
  editCriterionArgument,
  foldEvents,
} from '../src/tui/index.js';
import type { SpecEchoCard } from '../src/tui/index.js';

import { makeHome, makePlan, planProvider } from './helpers/engine-fixture.js';

const BASELINE = 'ddd9bed4d286ac1f8a0f4f7bfef9530046605787';
const PRINCIPAL = { kind: 'user' as const, id: 'deep' };
const FEATURE = 'engine-reconciler';

/**
 * A **genuine** ULID — 26 Crockford-base32 characters at roughly 4.6 bits each, measured in
 * `tests/runtime.redaction-survival.test.ts`. A stand-in of repeated characters carries near-zero entropy
 * and would sail through the sweep, which is the false pass this project has recorded three times.
 */
const GENUINE_ULID = '01K5NQ9ZJ7V3M2P9XQWRTC4BDE';

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

  it('never refuses a person’s free text, even when the number they typed is unrepresentable (Q6)', () => {
    /**
     * `Number.parseInt` on a long run of digits yields a finite value outside the safe integer range —
     * `Number.isInteger(1e20)` is `true` — and `z.int()` refuses it, so the payload builder threw, the throw
     * reached `applyIntent`, and the amendment was quarantined. Q6 promises free text is never refused, and
     * a mistyped line number is free text. It is an addressing failure, which this already has an answer
     * for: record the wording with no line.
     */
    const typed = 'criterion 99999999999999999999: the mode line is always visible';
    expect(() => criterionEditedPayload(typed)).not.toThrow();
    expect(criterionEditedPayload(typed)).toStrictEqual({
      line: null,
      text: 'the mode line is always visible',
    });
    // The boundary itself, stated: the largest line number that can be represented is still a line number.
    expect(criterionEditedPayload(`criterion ${String(Number.MAX_SAFE_INTEGER)}: reword`).line).toBe(
      Number.MAX_SAFE_INTEGER,
    );
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

/**
 * A criterion the AD-21 sweep replaced, from the log a real `acceptFeature` wrote (matrix 2).
 *
 * Nothing pinned this, and the gap was measurable: replacing `presentValue(criterion.text)` with
 * `criterion.text` in `src/tui/cards/spec-echo.ts` left the whole suite green, and the card then printed the
 * engine's internal `[redacted]` marker inside a numbered list while going on to offer "confirm all N as
 * written". CAP-18 makes that confirmation a durable decision, so a line the log does not carry must read as
 * one — and the card must say so before asking.
 */
describe('a criterion the redaction sweep replaced is presented as redacted, never as content', () => {
  const QUOTED = `the takeover branch for ${GENUINE_ULID} is never inferred by a renderer`;

  const cardFor = (criteria: readonly string[]): SpecEchoCard => {
    const reconciler = openReconciler(criteria);
    const accepted = reconciler.acceptFeature(makePlan({ acceptance_criteria: criteria }));
    // Nothing but the log: this is the same reconstruction the stage-1 gate turns on.
    return buildSpecEchoCard({ view: foldEvents(eventsOf(accepted.run)) });
  };

  it('never prints the engine’s own marker, and states the line as redacted instead', () => {
    const card = cardFor([GENUINE_ULID, ...CRITERIA]);

    // The log's truth: the sweep really did replace it, so this is not a test of a value that survived.
    expect(card.criteria[0]?.text).toBe(REDACTION_MARKER);
    const text = card.lines.join('\n');
    expect(text).not.toContain(REDACTION_MARKER);
    expect(text).not.toContain(GENUINE_ULID);
    expect(text).toContain(`1. ${REDACTED_PRESENTATION}`);
  });

  it('tells a person a line is unreadable before offering to confirm the set (CAP-18)', () => {
    const card = cardFor([GENUINE_ULID, ...CRITERIA]);
    const text = card.lines.join('\n');

    // The confirm is still offered — the criteria exist and the run is waiting on them — but not silently.
    expect(text).toContain(`press "${card.confirmKey}" to confirm all 4 as written`);
    expect(text).toMatch(/1 of these .*is not in the log/u);
  });

  it('keeps the prose around an identifier the sweep replaced inside it (story 1-9’s fix)', () => {
    const card = cardFor([QUOTED]);

    // The embedded case: `presentValue` splits on the marker rather than testing the whole value for
    // equality, so the sentence survives with a hole in it rather than reading as one bare phrase.
    expect(card.criteria[0]?.text).toBe(
      `the takeover branch for ${REDACTION_MARKER} is never inferred by a renderer`,
    );
    expect(card.lines.join('\n')).toContain(
      `1. the takeover branch for ${REDACTED_PRESENTATION} is never inferred by a renderer`,
    );
  });
});

/**
 * `recordDeclarations` runs inside the pass's enumeration of every run, so what it does to a run it cannot
 * finish is a property of the whole loop rather than of one repair.
 *
 * Three failures were live here and each is pinned below: a line AD-21 dropped froze the run on every
 * subsequent pass; a back-fill landing after a person's amendments reset the criteria to the original set;
 * and a repair built from today's plan was indistinguishable from the declaration the run was accepted
 * against. The fourth property — that a terminal run is not back-filled at all — is what keeps enumerating
 * runs from appending to logs of runs that have already finished.
 */
describe('the back-fill repairs what the log owes without rewriting what it holds', () => {
  /** The log a kill between `run.created` and the declarations leaves behind (crash boundary 1). */
  const truncateToRunCreated = (run: string): void => {
    const [created] = eventsOf(run);
    if (created === undefined) throw new Error('no run.created line');
    releaseEngine();
    writeFileSync(runPaths(run, home).eventLog, `${JSON.stringify(created)}\n`, 'utf8');
  };

  it('marks a repaired declaration as a repair, and the original as not one (AD-5)', async () => {
    const reconciler = openReconciler();
    const accepted = reconciler.acceptFeature(makePlan({ acceptance_criteria: CRITERIA }));

    // The line `acceptFeature` wrote, at the moment the run was accepted: a declaration, not a repair.
    expect(specLines(accepted.run)[0]?.payload[REPAIRED_PAYLOAD_KEY]).toBeUndefined();

    truncateToRunCreated(accepted.run);
    await openReconciler().pass();

    /**
     * The repair is built from the plan as it reads *now*, which may not be the plan the run was accepted
     * against. Nothing else in the line says so, so a replay would read a reconstruction as a declaration.
     */
    const repaired = specLines(accepted.run)[0];
    expect(repaired?.payload[REPAIRED_PAYLOAD_KEY]).toBe(true);
    expect(
      eventsOf(accepted.run).find((event) => event.type === TERRITORY_DECLARED_EVENT_TYPE)?.payload[
        REPAIRED_PAYLOAD_KEY
      ],
    ).toBe(true);
  });

  it('does not discard amendments the log already carries (the fold is later-wins)', async () => {
    const reconciler = openReconciler();
    const accepted = reconciler.acceptFeature(makePlan({ acceptance_criteria: CRITERIA }));
    truncateToRunCreated(accepted.run);

    // A person amends a criterion on a log that carries no `spec.recorded`: the methods write and consume
    // one durable intent (AD-19), so this is the ordinary path and not a hand-built line.
    const amended = 'a restart converges on the same state, from a kill at any transition';
    const editing = openReconciler();
    editing.ask(accepted.run, DRAFT);
    editing.editCriterion(accepted.run, editCriterionArgument(2, amended), { principal: PRINCIPAL });
    expect(specLines(accepted.run)).toHaveLength(0);
    releaseEngine();

    await openReconciler().pass();

    /**
     * Appending `spec.recorded` after the edit and stopping there would leave the amendment in the log and
     * gone from every surface — the one kind of loss a durable record must not manufacture. The edits are
     * replayed after the set they amend, each marked as a repair.
     */
    const view = foldEvents(eventsOf(accepted.run));
    expect(view.spec.criteria.map((criterion) => criterion.text)).toStrictEqual([
      CRITERIA[0],
      amended,
      CRITERIA[2],
    ]);
    expect(view.spec.criteria[1]?.edited).toBe(true);
    const edits = eventsOf(accepted.run).filter(
      (event) => event.type === SPEC_CRITERION_EDITED_EVENT_TYPE,
    );
    expect(edits).toHaveLength(2);
    expect(edits[1]?.payload[REPAIRED_PAYLOAD_KEY]).toBe(true);

    // Bounded: the next pass sees `spec.recorded` carried and owes nothing, so nothing is replayed twice.
    await toClose[0]?.pass();
    expect(
      eventsOf(accepted.run).filter((event) => event.type === SPEC_CRITERION_EDITED_EVENT_TYPE),
    ).toHaveLength(2);
  });

  it('leaves a terminal run exactly as its log left it', async () => {
    const reconciler = openReconciler();
    const accepted = reconciler.acceptFeature(makePlan({ acceptance_criteria: CRITERIA }));
    truncateToRunCreated(accepted.run);

    const killing = openReconciler();
    killing.kill(accepted.run, { principal: PRINCIPAL });
    releaseEngine();
    const before = eventsOf(accepted.run).length;

    await openReconciler().pass();

    /**
     * A killed run never acts again, so the repair buys nothing — and what it costs is a declaration built
     * from today's plan appended to the record of a run that finished without one. Absence is the honest
     * answer (R8, R12), and enumerating runs stays a read for every run that is done.
     */
    expect(specLines(accepted.run)).toHaveLength(0);
    expect(eventsOf(accepted.run)).toHaveLength(before);
  });

  it('does not freeze a run whose declaration the redaction pass drops (AD-21 fails closed)', async () => {
    // Criteria long enough that a `spec.recorded` line exceeds the pass's serialised bound while every
    // other line this run writes stays well under it. Prose, so nothing here is redacted for entropy.
    const LONG = Array.from(
      { length: 12 },
      (_unused, index) =>
        `criterion ${String(index + 1)}: ` +
        'the reconciler takes at most one action per pass and writes the checkpoint from the log '.repeat(4),
    );
    const accepted = openReconciler(LONG).acceptFeature(makePlan({ acceptance_criteria: LONG }));
    truncateToRunCreated(accepted.run);

    // A confirm sitting in `commands/`, so the pass has something to do for this run beyond the repair.
    writeCommandIntent(
      runPaths(accepted.run, home),
      newCommandIntent({
        intentId: mintIntentId(mintRunId()),
        command: 'confirm_spec',
        run: accepted.run,
        feature: FEATURE,
        step: null,
        principal: PRINCIPAL,
        source: 'tui',
        argument: null,
      }),
    );

    const reconciler = Reconciler.open({
      orchHome: home,
      executor: createScriptedExecutor({ onStart: (request) => terminated(request.step, 'completed') }),
      plans: planProvider(makePlan({ acceptance_criteria: LONG })),
      baseline: createRecordingResetter(BASELINE),
      // The declaration cannot be written; every shorter line still can.
      redaction: { maxSerialisedChars: 2_000 },
    });
    toClose.push(reconciler);
    const result = await reconciler.pass();

    // The line really was refused, and refused as itself rather than as a silent no-op.
    expect(specLines(accepted.run)).toHaveLength(0);
    expect(
      eventsOf(accepted.run).some((event) => event.type === 'redaction.failed'),
    ).toBe(true);
    expect(result.refusals.map((refusal) => refusal.code)).toContain('redaction.failed');

    /**
     * And the run still advanced. Letting the throw out of the repair left the run out of the pass's own
     * list, so its durable intent was never read — on this pass and on every pass after it, because the
     * repair is attempted again every time. That is the poison loop story 1-7's review found in
     * `applyIntent`, on a path that runs for every run on every pass.
     */
    expect(result.steering.map((outcome) => outcome.run)).toContain(accepted.run);
    expect(result.steering.find((outcome) => outcome.run === accepted.run)?.applied).toHaveLength(1);
  });
});
