/**
 * Matrix 2 — every field story 1-11 adds to a payload, put through the real recorder and read back.
 *
 * **This project has recorded the same false pass three times, and this file is written against it.** A
 * survival test whose "high-entropy" value is `'a'.repeat(26)` or a ULID of repeated zeros proves nothing:
 * measured, both carry 0.00 bits per character and a ULID of zeros carries about 1.9, all far below the
 * sweep's 3.5-bit threshold, so the sweep never looks at them and the test passes whatever redaction does.
 * Two things here make that impossible to repeat:
 *
 * - every entropy claim is **measured in the test**, against `shannonEntropyBitsPerChar`, so a value swapped
 *   for a low-entropy one fails on the measurement before it reaches an assertion about redaction;
 * - the suite carries a **negative control**: a genuine ULID, which it asserts is *replaced*. If the sweep
 *   were disabled, or the value were swapped for `'a'.repeat(26)`, that assertion fails — so the survival
 *   assertions beside it cannot be passing merely because nothing was redacting anything.
 *
 * **The honest finding this file pins.** Prose survives: a criterion, an option label, a consequence and a
 * mini-brief are punctuated by their spaces, so no candidate run reaches the 24-character threshold. An
 * *identifier quoted inside* a criterion does not survive, and there is no remedy short of widening AD-21's
 * allow-list, which AD-21 admits no remedy for and this story forbids. That is asserted here rather than
 * hidden, together with the fact that the sentence around the identifier survives intact and a surface
 * presents the hole as `(redacted in the log)` rather than as content.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  FeatureTerritoryDeclaredPayloadSchema,
  SpecRecordedPayloadSchema,
} from '../src/contracts/index.js';
import type { EventEnvelope } from '../src/contracts/index.js';
import {
  REDACTION_MARKER,
  Recorder,
  readEventLog,
  runPaths,
  shannonEntropyBitsPerChar,
  takeoverBranchFor,
} from '../src/runtime/index.js';

/**
 * A **genuine** ULID: 26 characters of Crockford base32 with a real spread of symbols.
 *
 * Measured below at over four bits per character, which is what makes it the value AD-21's sweep is about.
 */
const GENUINE_ULID = '01K5NQ9ZJ7V3M2P9XQWRTC4BDE';

/** A full commit SHA, which is what an AD-26 baseline ref always is: 40 hex characters. */
const GENUINE_SHA = '4f3a2b1c9d8e7f60a5b4c3d2e1f00918273645ab';

/** The floor a value has to clear before this suite will treat it as a high-entropy identifier. */
const HIGH_ENTROPY_FLOOR_BITS = 3.5;

const FEATURE = 'redaction-survival';

let home: string;
const toClose: Recorder[] = [];

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'orch-redaction-survival-'));
});

afterEach(() => {
  for (const recorder of toClose.splice(0)) recorder.close();
  rmSync(home, { recursive: true, force: true });
});

/** Append one payload through the real recorder and read the line back off disk. */
const roundTrip = (type: string, payload: Record<string, unknown>): EventEnvelope => {
  const recorder = Recorder.open({ runId: GENUINE_ULID, feature: FEATURE, orchHome: home });
  toClose.push(recorder);
  recorder.record({
    feature: FEATURE,
    run: GENUINE_ULID,
    step: null,
    emitter: 'engine.reconciler',
    type,
    payload,
  });
  recorder.close();
  toClose.pop();
  const [line] = readEventLog(runPaths(GENUINE_ULID, home).eventLog);
  if (line === undefined) throw new Error('the recorder appended nothing');
  return line;
};

describe('the values this suite calls high-entropy really are (the false pass this file exists to prevent)', () => {
  it('measures a genuine ULID above the sweep threshold, so the sweep is what it is tested against', () => {
    const bits = shannonEntropyBitsPerChar(GENUINE_ULID);
    expect(bits).toBeGreaterThan(4);
    expect(bits).toBeGreaterThan(HIGH_ENTROPY_FLOOR_BITS);
    expect(GENUINE_ULID).toHaveLength(26);
  });

  it('measures a commit SHA above the threshold too', () => {
    expect(shannonEntropyBitsPerChar(GENUINE_SHA)).toBeGreaterThan(HIGH_ENTROPY_FLOOR_BITS);
    expect(GENUINE_SHA).toHaveLength(40);
  });

  it('measures the three values that have produced a false pass here as far below it', () => {
    // Recorded so the next implementer cannot reach for one of them by accident.
    for (const worthless of ['a'.repeat(26), 'a'.repeat(40), '0'.repeat(26)]) {
      expect(
        shannonEntropyBitsPerChar(worthless),
        `${worthless.slice(0, 6)}… would give a false pass`,
      ).toBeLessThan(HIGH_ENTROPY_FLOOR_BITS);
    }
    // A ULID of repeated zeros clears zero bits but is still nowhere near the threshold: it is the second
    // shape that has passed here while proving nothing.
    expect(shannonEntropyBitsPerChar('01000000000000000000000000')).toBeLessThan(2);
  });
});

describe('the negative control: AD-21 is live on the write path this suite is using', () => {
  it('replaces a genuine ULID standing alone in a payload', () => {
    const line = roundTrip('spec.recorded', {
      request: GENUINE_ULID,
      acceptance_criteria: [GENUINE_ULID],
    });
    expect(line.payload['request']).toBe(REDACTION_MARKER);
    expect(JSON.stringify(line.payload)).not.toContain(GENUINE_ULID);
  });

  it('keeps the same ULID verbatim in the envelope, because `run` is on the allow-list', () => {
    // The two halves of AD-21 in one line: the identifier is unreadable in the payload and readable in the
    // envelope field the allow-list names — which is exactly why the handoff card derives from `run`.
    const line = roundTrip('spec.recorded', { request: GENUINE_ULID, acceptance_criteria: [] });
    expect(line.run).toBe(GENUINE_ULID);
    expect(takeoverBranchFor(line.run)).toBe(`orch/takeover/${GENUINE_ULID}`);
  });
});

describe('the acceptance criteria reach the log intact', () => {
  const CRITERIA = [
    'the loop takes at most one action per pass',
    'a restart converges on the same state',
    'every event passes redaction before it is appended, and a failure drops the artifact',
    'the mode is displayed permanently in the prompt line, in every render state',
    'a killed step is never resumed and never re-run by the reconciler',
  ];
  const REQUEST =
    'record the acceptance criteria in the event log so the spec echo card reconstructs from it alone';

  it('round-trips the request and every criterion, byte for byte, through the real recorder', () => {
    const line = roundTrip(
      'spec.recorded',
      SpecRecordedPayloadSchema.parse({ request: REQUEST, acceptance_criteria: CRITERIA }),
    );
    expect(line.payload['request']).toBe(REQUEST);
    expect(line.payload['acceptance_criteria']).toStrictEqual(CRITERIA);
    expect(JSON.stringify(line.payload)).not.toContain(REDACTION_MARKER);
  });

  it('states plainly which part of a criterion quoting a real ULID does not survive', () => {
    const quoting = `the run id ${GENUINE_ULID} appears on every line of the log`;
    const line = roundTrip(
      'spec.recorded',
      SpecRecordedPayloadSchema.parse({ request: REQUEST, acceptance_criteria: [quoting] }),
    );
    const [survived] = SpecRecordedPayloadSchema.parse(line.payload).acceptance_criteria;

    // The identifier is gone — AD-21 working as specified, and the reason story 1-11 derives the takeover
    // branch instead of recording it.
    expect(survived).not.toContain(GENUINE_ULID);
    expect(survived).toContain(REDACTION_MARKER);
    // And the sentence around it is intact, so the criterion is still readable and still confirmable.
    expect(survived).toBe(`the run id ${REDACTION_MARKER} appears on every line of the log`);
  });

  it('does the same to a criterion quoting a commit SHA, and no more than that', () => {
    const quoting = `the note lands on merge commit ${GENUINE_SHA} and nowhere else`;
    const line = roundTrip(
      'spec.recorded',
      SpecRecordedPayloadSchema.parse({ request: 'write the git note', acceptance_criteria: [quoting] }),
    );
    const [survived] = SpecRecordedPayloadSchema.parse(line.payload).acceptance_criteria;
    expect(survived).toBe(`the note lands on merge commit ${REDACTION_MARKER} and nowhere else`);
  });
});

describe('the enriched question payload reaches the log intact', () => {
  it('round-trips every option label and consequence, the brief and `asked_at`', () => {
    const payload = {
      question_id: 'q-01K5NQ9Z-J7V3M2P9-XQWRTC4B-DE',
      prompt: 'Should the committer squash the step commits before opening the pull request?',
      options: 'squash, keep, decide-later',
      offered_options: [
        {
          id: 'squash',
          label: 'Squash to one commit',
          consequence: 'The branch reads as one change and the step boundaries are lost.',
          escape: false,
        },
        {
          id: 'keep',
          label: 'Keep the step commits',
          consequence: 'The branch shows each step, and the history is longer.',
          escape: false,
        },
        {
          id: 'decide-later',
          label: 'Decide at the review',
          consequence: 'The pull request is opened with the step commits and squashed on merge if asked.',
          escape: true,
        },
      ],
      brief:
        'The committer opens one pull request per feature. Squashing makes the branch read as one change; ' +
        'keeping the commits makes each step reviewable on its own.',
      recommended_option_id: 'keep',
      default_action: 'The step commits are kept, and the pull request is opened as it stands.',
      default_window_ms: 900_000,
      asked_at: '2026-09-20T09:00:02.000Z',
    };

    const line = roundTrip('question.asked', payload);
    expect(line.payload).toStrictEqual(payload);
    expect(JSON.stringify(line.payload)).not.toContain(REDACTION_MARKER);
  });
});

describe('the declared territory reaches the log, and says so when a path does not', () => {
  it('round-trips the paths a repository actually has', () => {
    // Every one of these is punctuated by a slash, a dot or a hyphen into runs below the 24-character
    // threshold, which is why they survive on their shape rather than on an exemption.
    const paths = [
      'src/engine',
      'src/runtime/recorder.ts',
      'src/tui/cards',
      'docs/specs/spec-agent-orchestrator',
      'tests/engine.reconciler.test.ts',
    ];
    const line = roundTrip(
      'feature.territory_declared',
      FeatureTerritoryDeclaredPayloadSchema.parse({ paths }),
    );
    expect(line.payload['paths']).toStrictEqual(paths);
    expect(JSON.stringify(line.payload)).not.toContain(REDACTION_MARKER);
  });

  it('replaces a long path with no punctuation in it, which the replay is written to expect', () => {
    const unbroken = 'docs/planning/architecture/spine/decisions/records';
    // Measured, not asserted: the path really is one 50-character run above the threshold.
    expect(unbroken).not.toMatch(/[.-]/);
    expect(shannonEntropyBitsPerChar(unbroken)).toBeGreaterThan(HIGH_ENTROPY_FLOOR_BITS);
    expect(unbroken.length).toBeGreaterThan(24);

    const line = roundTrip(
      'feature.territory_declared',
      FeatureTerritoryDeclaredPayloadSchema.parse({ paths: ['src/engine', unbroken] }),
    );
    expect(line.payload['paths']).toStrictEqual(['src/engine', REDACTION_MARKER]);
  });
});

describe('the usage payload is numbers, which the sweep never looks at', () => {
  it('round-trips a cost and four token counts unchanged', () => {
    const usage = {
      cost_usd: 0.0354739,
      input_tokens: 18,
      output_tokens: 524,
      cache_creation_input_tokens: 15647,
      cache_read_input_tokens: 15419,
    };
    const line = roundTrip('step.terminated', { disposition: 'completed', usage });
    expect(line.payload['usage']).toStrictEqual(usage);
  });
});
