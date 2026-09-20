/**
 * AD-29 — run ids are ULIDs minted solely by the engine.
 *
 * Three properties the rest of the system leans on: the *length and alphabet*, because a run id is a
 * path segment under `ORCH_HOME/runs/`; *monotonicity within a process*, because the reconciler breaks
 * a territory tie by run-id order and a tie it cannot break is a non-deterministic pass; and
 * *sortability*, because lexicographic order being chronological is what makes that tie-break mean
 * "the older run wins" rather than "whichever run sorts first".
 */
import { describe, expect, it } from 'vitest';

import { SAFE_PATH_SEGMENT, runPaths } from '../src/runtime/index.js';
import {
  CROCKFORD_BASE32,
  ULID_LENGTH,
  ULID_MAX_TIME,
  UlidError,
  compareUlid,
  createUlidMinter,
  decodeUlidTime,
  encodeUlidTime,
  isUlid,
  mintRunId,
} from '../src/engine/index.js';

/** Randomness pinned to its maximum, so the increment has to carry through every digit. */
const maximalRandom = (bytes: number): Uint8Array => new Uint8Array(bytes).fill(31);

describe('AD-29 — a run id is a 26-character Crockford base32 ULID', () => {
  it('mints 26 characters drawn only from the Crockford alphabet', () => {
    const minter = createUlidMinter();
    for (let index = 0; index < 64; index += 1) {
      const id = minter.mint();
      expect(id).toHaveLength(ULID_LENGTH);
      expect(ULID_LENGTH).toBe(26);
      for (const char of id) expect(CROCKFORD_BASE32).toContain(char);
      expect(isUlid(id)).toBe(true);
    }
  });

  it('excludes I, L, O and U, which is what makes the alphabet Crockford rather than base32', () => {
    for (const excluded of ['I', 'L', 'O', 'U']) {
      expect(CROCKFORD_BASE32).not.toContain(excluded);
    }
    expect(CROCKFORD_BASE32).toHaveLength(32);
  });

  it('is a safe path segment, so `runs/<run-id>/` needs no escaping', () => {
    const id = mintRunId();
    expect(SAFE_PATH_SEGMENT.test(id)).toBe(true);
    expect(runPaths(id, '/tmp/orch-home').runDir).toBe(`/tmp/orch-home/runs/${id}`);
  });

  it('rejects a value that is not a ULID rather than coercing it', () => {
    for (const notAUlid of [
      '',
      'not-a-ulid',
      '01K5NQ8ZJ7V3M2P9XQWRTC4BD', // 25 characters
      '01K5NQ8ZJ7V3M2P9XQWRTC4BDEF', // 27 characters
      '01K5NQ8ZJ7V3M2P9XQWRTC4BDI', // contains the excluded I
      '81K5NQ8ZJ7V3M2P9XQWRTC4BDE', // first character above 7, so over 48 bits of timestamp
      '01k5nq8zj7v3m2p9xqwrtc4bde', // lower case
    ]) {
      expect(isUlid(notAUlid), notAUlid).toBe(false);
      expect(() => decodeUlidTime(notAUlid)).toThrowError(UlidError);
    }
  });
});

describe('AD-29 — monotonic within a process', () => {
  it('sorts the second id of one millisecond strictly after the first', () => {
    const minter = createUlidMinter({ now: () => 1_770_000_000_000 });
    const first = minter.mint();
    const second = minter.mint();
    expect(second).not.toBe(first);
    expect(compareUlid(first, second)).toBeLessThan(0);
    // The timestamps are equal, so the ordering can only have come from the randomness increment.
    expect(decodeUlidTime(second)).toBe(decodeUlidTime(first));
  });

  it('keeps every id of one millisecond strictly increasing across a long burst', () => {
    const minter = createUlidMinter({ now: () => 1_770_000_000_000 });
    const ids = Array.from({ length: 500 }, () => minter.mint());
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort(compareUlid)).toStrictEqual(ids);
  });

  it('borrows the next millisecond when 80 bits of randomness run out inside one', () => {
    // Randomness pinned to all-ones, so the very first increment carries off the end.
    const minter = createUlidMinter({ now: () => 1_770_000_000_000, random: maximalRandom });
    const first = minter.mint();
    const second = minter.mint();
    expect(compareUlid(first, second)).toBeLessThan(0);
    expect(decodeUlidTime(first)).toBe(1_770_000_000_000);
    expect(decodeUlidTime(second)).toBe(1_770_000_000_001);
  });

  it('never lets a clock stepped backwards produce an id that sorts before an older one', () => {
    let clock = 1_770_000_000_500;
    const minter = createUlidMinter({ now: () => clock });
    const before = minter.mint();
    // NTP correction, a suspend, a manual change: the clock goes back half a second.
    clock = 1_770_000_000_000;
    const after = minter.mint();
    expect(compareUlid(before, after)).toBeLessThan(0);
    expect(decodeUlidTime(after)).toBe(decodeUlidTime(before));
  });

  it('is monotonic across a real clock too, not only a pinned one', () => {
    const ids = Array.from({ length: 200 }, () => mintRunId());
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort(compareUlid)).toStrictEqual(ids);
  });

  it('gives two independent minters independent sequences, so monotonicity is per process', () => {
    const now = (): number => 1_770_000_000_000;
    const a = createUlidMinter({ now });
    const b = createUlidMinter({ now });
    // Different randomness, so the two sequences differ; each is internally ordered.
    expect(a.mint()).not.toBe(b.mint());
  });
});

describe('the timestamp half round-trips', () => {
  it('encodes and decodes a millisecond exactly', () => {
    for (const at of [0, 1, 1_000, 1_770_000_000_000, ULID_MAX_TIME]) {
      const encoded = encodeUlidTime(at);
      expect(encoded).toHaveLength(10);
      expect(decodeUlidTime(`${encoded}${'0'.repeat(16)}`)).toBe(at);
    }
  });

  it('refuses a timestamp 10 base32 characters cannot hold, rather than wrapping it', () => {
    // Wrapping would silently reverse the sort order, which every tie-break in the engine depends on.
    expect(() => encodeUlidTime(ULID_MAX_TIME + 1)).toThrowError(UlidError);
    expect(() => encodeUlidTime(-1)).toThrowError(UlidError);
    expect(() => encodeUlidTime(1.5)).toThrowError(UlidError);
  });

  it('refuses a clock that does not return a finite number', () => {
    expect(() => createUlidMinter({ now: () => Number.NaN }).mint()).toThrowError(UlidError);
  });

  it('refuses a randomness source that returns too few bytes', () => {
    expect(() =>
      createUlidMinter({ random: () => new Uint8Array(4) }).mint(),
    ).toThrowError(UlidError);
  });

  it('orders a later millisecond after an earlier one', () => {
    const earlier = `${encodeUlidTime(1_770_000_000_000)}${'0'.repeat(16)}`;
    const later = `${encodeUlidTime(1_770_000_001_000)}${'0'.repeat(16)}`;
    expect(compareUlid(earlier, later)).toBeLessThan(0);
    expect(compareUlid(later, earlier)).toBeGreaterThan(0);
    expect(compareUlid(earlier, earlier)).toBe(0);
  });
});
