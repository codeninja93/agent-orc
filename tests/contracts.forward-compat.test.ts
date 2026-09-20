/**
 * Matrix 13 — AD-5's forward compatibility, in both directions, as executable assertions.
 *
 * AD-5 makes two promises and each one has a failure mode that only shows up across builds:
 *
 * - **A new event type is invisible to an older reader.** A reader must ignore a type it does not know
 *   rather than erroring — and, sharper than that, it must change *nothing* from it: not a counter, not a
 *   timestamp, not a notice. A fold that quietly advanced `lastActivityAt` on an unknown line would make an
 *   older shell's elapsed disagree with a newer one's about the same log.
 * - **A new payload key survives an older parse.** `EventEnvelopeSchema` is a `z.looseObject` for exactly
 *   this, and every payload schema story 1-11 adds is loose for the same reason: a key stripped by a parse
 *   is a key the next writer of that line silently drops.
 *
 * And the reverse direction, which is the one this story could have broken: a log an *older* build wrote,
 * carrying none of the new types and none of the new keys, must still fold — with the new facts reading as
 * unrecorded and nothing throwing. That is what makes recording them a non-breaking change rather than a
 * migration.
 */
import { describe, expect, it } from 'vitest';

import {
  EVENT_TYPES,
  EventEnvelopeSchema,
  FeatureTerritoryDeclaredPayloadSchema,
  SpecCriterionEditedPayloadSchema,
  SpecRecordedPayloadSchema,
  isDeclaredEventType,
} from '../src/contracts/index.js';
import { territoryFromEvents } from '../src/engine/index.js';
import {
  UNRECORDED_PRESENTATION,
  buildCompletionCard,
  buildHandoffCard,
  buildKillCard,
  buildQuestionCard,
  buildSpecEchoCard,
  cardForView,
  cardText,
  foldEvents,
} from '../src/tui/index.js';

import {
  FIXTURE_RUN_START_MS,
  buildLog,
  featureStateChanged,
  handoffRecorded,
  questionAsked,
  questionAskedEnriched,
  runCreated,
  specCriterionEdited,
  specRecorded,
  stepStarted,
  stepTerminated,
  unknownEvent,
} from './helpers/tui-log.js';

/** A log exactly as a build before story 1-11 wrote it: no spec, no territory, no usage, no enrichment. */
const olderBuildLog = (): ReturnType<typeof buildLog> =>
  buildLog([
    runCreated(),
    featureStateChanged('confirmed'),
    { ...questionAsked('q-01K5NQ9Z-J7V3M2P9-XQWRTC4B-DE'), atMs: 2_000 },
    featureStateChanged('running', 'confirmed'),
    stepStarted('implement'),
    stepTerminated('implement'),
    stepStarted('verify', 'verification'),
    stepTerminated('verify'),
    featureStateChanged('committed', 'verifying'),
  ]);

describe('a log written by an older build still folds, and the new facts read as unrecorded', () => {
  const view = foldEvents(olderBuildLog());

  it('folds without throwing, and reports the run it always did', () => {
    expect(view.featureState).toBe('committed');
    expect(view.progress.steps.map((step) => step.step)).toStrictEqual(['implement', 'verify']);
    expect(view.problem).toBeNull();
  });

  it('reads the criteria as unrecorded rather than inventing an empty set to confirm', () => {
    expect(view.spec.recorded).toBe(false);
    expect(view.spec.criteria).toStrictEqual([]);
    expect(view.spec.request).toBeNull();
    const card = buildSpecEchoCard({ view });
    expect(card.unrecorded).toBe(true);
    expect(cardText(card)).toContain(UNRECORDED_PRESENTATION);
    expect(cardText(card)).not.toContain('confirm all 0');
  });

  it('reads the usage as unrecorded rather than as a zero (R8)', () => {
    expect(view.usage.total).toBeNull();
    expect(buildCompletionCard({ view }).tokens).toBe(UNRECORDED_PRESENTATION);
    expect(buildKillCard({ view }).tokens).toBe(UNRECORDED_PRESENTATION);
  });

  it('reads the question’s brief, options and asked-at as unrecorded, and still states the window', () => {
    const asked = foldEvents(
      buildLog([runCreated(), { ...questionAsked('q-01K5NQ9Z-AAAA'), atMs: 2_000 }]),
    );
    expect(asked.question.brief).toBeNull();
    expect(asked.question.options).toStrictEqual([]);
    expect(asked.question.askedAt).toBeNull();

    const card = buildQuestionCard({ view: asked, now: new Date(FIXTURE_RUN_START_MS + 62_000) });
    expect(card.brief).toBe(UNRECORDED_PRESENTATION);
    expect(card.options).toStrictEqual([]);
    // Q2 — the declared window is all the older line carried, so the card says which it means rather than
    // counting down from an instant it does not have.
    expect(card.window).toContain('from when it was asked');
    expect(cardText(card)).toContain(UNRECORDED_PRESENTATION);
  });

  it('declares no territory, and the replay answers that rather than guessing one', () => {
    expect(territoryFromEvents(olderBuildLog())).toBeNull();
  });

  it('still chooses the right card for the run, so nothing about dispatch depended on the new keys', () => {
    // The older log leaves a question pending, and a pending question outranks everything (R14) — the same
    // answer this dispatch gave before story 1-11 touched it.
    expect(cardForView(view)?.kind).toBe('question');
    expect(cardForView(foldEvents(buildLog([runCreated()])))?.kind).toBe('spec-echo');
    const committed = foldEvents(
      buildLog([runCreated(), stepStarted('verify', 'verification'), stepTerminated('verify'), featureStateChanged('committed')]),
    );
    expect(cardForView(committed)?.kind).toBe('completion');
  });

  it('builds all five single-run cards from it without throwing', () => {
    for (const build of [
      () => buildQuestionCard({ view }),
      () => buildSpecEchoCard({ view }),
      () => buildKillCard({ view }),
      () => buildCompletionCard({ view }),
      () => buildHandoffCard({ view }),
    ]) {
      expect(build).not.toThrow();
      expect(cardText(build()).trim()).not.toBe('');
    }
  });
});

describe('a new event type is invisible to a reader that does not know it', () => {
  it('parses an undeclared type rather than refusing the envelope', () => {
    const envelope = {
      ts: '2026-09-20T09:00:00.000Z',
      seq: 1,
      feature: 'forward-compat',
      run: '01K5NQ9ZJ7V3M2P9XQWRTC4BDE',
      step: null,
      emitter: 'engine.reconciler',
      type: 'trust.record_updated',
      payload: { area: 'src/tui', merged_unchanged: 3 },
    };
    expect(isDeclaredEventType(envelope.type)).toBe(false);
    expect(EventEnvelopeSchema.parse(envelope).type).toBe('trust.record_updated');
  });

  it('changes nothing at all in the fold — not a counter, not a timestamp, not a notice', () => {
    /**
     * Every line carries an explicit instant, so the two logs are identical *except* for the unknown lines.
     *
     * Without that the builder's index-derived timestamps would shift every line after the insertion, and
     * the comparison would fail for a reason that has nothing to do with AD-5 — which is a comparison that
     * proves nothing either way.
     */
    const known = [
      { ...runCreated(), atMs: 0 },
      { ...featureStateChanged('confirmed'), atMs: 1_000 },
      { ...questionAsked('q-01K5NQ9Z-J7V3M2P9-XQWRTC4B-DE'), atMs: 2_000 },
      { ...featureStateChanged('running', 'confirmed'), atMs: 3_000 },
      { ...stepStarted('implement'), atMs: 4_000 },
      { ...stepTerminated('implement'), atMs: 6_000 },
      { ...stepStarted('verify', 'verification'), atMs: 7_000 },
      { ...stepTerminated('verify'), atMs: 8_000 },
      { ...featureStateChanged('committed', 'verifying'), atMs: 9_000 },
    ];
    const without = buildLog(known);
    // Inserted in the middle *and* at the end, which are the two places a fold that touched
    // `lastActivityAt` or appended a notice would give itself away.
    const withUnknown = buildLog([
      ...known.slice(0, 5),
      { ...unknownEvent(), atMs: 5_000 },
      ...known.slice(5),
      { ...unknownEvent('consolidation.compacted'), atMs: 10_000 },
    ]);

    // `seq` differs by construction — the recorder assigns 1..n per file — so the comparison is on
    // everything the fold *derives*, which is what an older shell would show a person.
    expect(foldEvents(withUnknown)).toStrictEqual(foldEvents(without));
  });

  it('declares every new type in the shared vocabulary, dot-namespaced and past-tense', () => {
    for (const type of ['spec.recorded', 'spec.criterion_edited', 'feature.territory_declared']) {
      expect(EVENT_TYPES).toContain(type);
      expect(isDeclaredEventType(type)).toBe(true);
      expect(type).toMatch(/^[a-z_]+\.[a-z_]+$/);
    }
  });
});

describe('a new payload key survives an older parse', () => {
  it('keeps an unknown key on every payload schema this story adds', () => {
    // Loose objects, all three: a key a later build adds must reach a reader rather than being stripped by
    // the parse on the way through.
    expect(
      SpecRecordedPayloadSchema.parse({
        request: 'do the thing',
        acceptance_criteria: ['it is done'],
        confirmed_by: 'deep',
      })['confirmed_by'],
    ).toBe('deep');
    expect(
      SpecCriterionEditedPayloadSchema.parse({ line: 1, text: 'amended', previous: 'original' })[
        'previous'
      ],
    ).toBe('original');
    expect(
      FeatureTerritoryDeclaredPayloadSchema.parse({ paths: ['src'], source: 'profile' })['source'],
    ).toBe('profile');
  });

  it('keeps the older meaning of `options` on question.asked while adding the richer list', () => {
    // AD-5 — adding a key is non-breaking and changing one's meaning is breaking, so `options` is still the
    // joined ids and `offered_options` is the new list beside it.
    const [line] = buildLog([questionAskedEnriched('q-01K5NQ9Z-AAAA')]);
    expect(typeof line?.payload['options']).toBe('string');
    expect(line?.payload['options']).toBe('poll, watch, ask-me');
    expect(Array.isArray(line?.payload['offered_options'])).toBe(true);
  });

  it('reads the enriched keys when they are there, which is the other half of the promise', () => {
    const view = foldEvents(
      buildLog([runCreated(), specRecorded(['it is done']), { ...questionAskedEnriched('q-01K5NQ9Z-AAAA'), atMs: 2_000 }]),
    );
    expect(view.question.options.map((option) => option.id)).toStrictEqual(['poll', 'watch', 'ask-me']);
    expect(view.question.brief).toContain('Polling cannot miss a line');
    expect(view.question.askedAt).not.toBeNull();
    expect(view.spec.criteria.map((criterion) => criterion.text)).toStrictEqual(['it is done']);
  });

  it('folds an edit against a set an older log never recorded without throwing', () => {
    // The awkward crossing: a build that writes `spec.criterion_edited` against a log whose `spec.recorded`
    // predates it. Nothing to amend, so nothing is amended, and the fold says so rather than failing.
    const view = foldEvents(
      buildLog([runCreated(), specCriterionEdited(2, 'amended out of nowhere')]),
    );
    expect(view.spec.criteria).toStrictEqual([]);
    expect(view.notices.map((notice) => notice.text).join(' ')).toContain('name no numbered line');
  });

  it('survives a payload whose new keys are the wrong type entirely', () => {
    const view = foldEvents(
      buildLog([
        runCreated(),
        { type: 'spec.recorded', payload: { request: 42, acceptance_criteria: 'not a list' } },
        { type: 'spec.criterion_edited', payload: { line: 'two', text: null } },
        { type: 'step.terminated', step: 'implement', payload: { disposition: 'completed', usage: 'lots' } },
      ]),
    );
    expect(view.spec.recorded).toBe(true);
    expect(view.spec.criteria).toStrictEqual([]);
    expect(view.spec.request).toBeNull();
    expect(view.usage.total).toBeNull();
    // A handoff card still builds, which is the "nothing throws" half of matrix 13.
    expect(() => buildHandoffCard({ view: foldEvents(buildLog([handoffRecorded()])) })).not.toThrow();
  });
});
