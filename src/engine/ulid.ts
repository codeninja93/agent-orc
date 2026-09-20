/**
 * AD-29 — run ids are ULIDs minted solely by the engine.
 *
 * A ULID is 26 characters of Crockford base32: 10 encoding a 48-bit millisecond timestamp, then 16
 * encoding 80 bits of randomness. Lexicographic order is chronological order, which is what lets the
 * reconciler pick a deterministic winner between two features contending for one territory without
 * consulting a clock or a counter it would have to keep in memory (AD-7).
 *
 * Monotonic within a process: two ids minted in the same millisecond differ, and the second sorts
 * strictly after the first. The Stack table names no ULID library, so nothing here adds a dependency
 * — `node:crypto` supplies the randomness and the encoding is twenty lines.
 */
import { randomBytes } from 'node:crypto';

/** Crockford base32: the digits and the alphabet less `I`, `L`, `O` and `U`. */
export const CROCKFORD_BASE32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** The radix, spelled once. */
const RADIX = CROCKFORD_BASE32.length;

/**
 * The character for a digit index. `charAt` rather than an index expression so nothing here needs a
 * non-null assertion to satisfy `noUncheckedIndexedAccess` — every index is already in range by
 * construction, and an assertion would be noise around that fact rather than a check of it.
 */
const digitChar = (digit: number): string => CROCKFORD_BASE32.charAt(digit);

/** 26 characters: 10 of timestamp, 16 of randomness. */
export const ULID_LENGTH = 26;
export const ULID_TIME_CHARS = 10;
export const ULID_RANDOM_CHARS = 16;

/**
 * The largest timestamp 10 base32 characters hold: 2^48 - 1 milliseconds, which is the year 10889.
 * A clock beyond it cannot be encoded, and silently wrapping would break the sort order the whole
 * scheme rests on.
 */
export const ULID_MAX_TIME = 2 ** 48 - 1;

/**
 * A well-formed ULID. The first character is at most `7` because 10 base32 characters hold 50 bits
 * and the timestamp is 48, so the two leading bits are always zero.
 */
export const ULID_PATTERN = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;

export const isUlid = (value: string): boolean =>
  value.length === ULID_LENGTH && ULID_PATTERN.test(value);

/** Refusal to mint or read a ULID. A malformed id is never repaired into a plausible one. */
export class UlidError extends Error {
  readonly code = 'internal.invariant_violated';

  constructor(message: string) {
    super(message);
    this.name = 'UlidError';
  }
}

/** Encode a millisecond timestamp as the 10 leading characters. */
export const encodeUlidTime = (milliseconds: number): string => {
  if (!Number.isInteger(milliseconds) || milliseconds < 0 || milliseconds > ULID_MAX_TIME) {
    throw new UlidError(
      `Cannot encode ${String(milliseconds)} as a ULID timestamp: it must be a whole number of ` +
        `milliseconds between 0 and ${String(ULID_MAX_TIME)}.`,
    );
  }
  let remaining = milliseconds;
  const out = new Array<string>(ULID_TIME_CHARS);
  for (let index = ULID_TIME_CHARS - 1; index >= 0; index -= 1) {
    const digit = remaining % RADIX;
    out[index] = digitChar(digit);
    remaining = (remaining - digit) / RADIX;
  }
  return out.join('');
};

/** Read the minting time back out of a ULID. */
export const decodeUlidTime = (ulid: string): number => {
  if (!isUlid(ulid)) {
    throw new UlidError(
      `"${ulid}" is not a ULID: ${String(ULID_LENGTH)} characters of Crockford base32 are required.`,
    );
  }
  let milliseconds = 0;
  for (const char of ulid.slice(0, ULID_TIME_CHARS)) {
    milliseconds = milliseconds * RADIX + CROCKFORD_BASE32.indexOf(char);
  }
  return milliseconds;
};

/**
 * Lexicographic comparison, which for a ULID is chronological. Used wherever a deterministic order
 * over runs is needed: the same order after a restart is what makes a scheduling decision
 * reproducible rather than dependent on directory-read order.
 */
export const compareUlid = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** 16 base32 *digit indexes*, so incrementing is base-32 addition rather than string surgery. */
const freshRandomDigits = (random: (bytes: number) => Uint8Array): number[] => {
  const bytes = random(ULID_RANDOM_CHARS);
  if (bytes.length < ULID_RANDOM_CHARS) {
    throw new UlidError(
      `The randomness source returned ${String(bytes.length)} bytes where ` +
        `${String(ULID_RANDOM_CHARS)} were required.`,
    );
  }
  return Array.from(bytes)
    .slice(0, ULID_RANDOM_CHARS)
    .map((byte) => byte % RADIX);
};

/**
 * Add one to the randomness, least-significant digit first. Returns `false` when every digit was
 * already at its maximum, i.e. the 80-bit space for this millisecond is exhausted — at which point
 * the minter borrows a millisecond from the future rather than emitting a duplicate.
 */
const incrementRandomDigits = (digits: number[]): boolean => {
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    const digit = digits[index];
    if (digit === undefined) continue;
    if (digit < RADIX - 1) {
      digits[index] = digit + 1;
      return true;
    }
    digits[index] = 0;
  }
  return false;
};

export interface UlidMinterOptions {
  /** Injectable clock in milliseconds, so a test can pin two mints to one instant. */
  readonly now?: () => number;
  /** Injectable randomness, so a test can pin the 80 random bits and observe the increment. */
  readonly random?: (bytes: number) => Uint8Array;
}

/** The engine's id minter. One per process is enough for AD-29's monotonicity claim. */
export interface UlidMinter {
  /** A fresh ULID, strictly after every id this minter has already produced. */
  mint: () => string;
}

/**
 * A minter that is monotonic within its own lifetime.
 *
 * Three cases, and the middle one is the whole reason this is a factory rather than a function:
 *
 * - a later millisecond than the last mint: fresh randomness;
 * - the *same* millisecond: the previous randomness plus one, so the second id sorts strictly after
 *   the first even though their timestamps are equal;
 * - an *earlier* millisecond — a clock stepped backwards by NTP or by a suspend — treated as the
 *   same millisecond as the last mint, so a regressing clock can never make a new run id sort before
 *   an older one.
 */
export const createUlidMinter = (options: UlidMinterOptions = {}): UlidMinter => {
  const now = options.now ?? ((): number => Date.now());
  const random = options.random ?? ((bytes: number): Uint8Array => randomBytes(bytes));

  let lastTime = -1;
  let digits: number[] = [];

  return {
    mint: (): string => {
      const observed = Math.floor(now());
      if (!Number.isFinite(observed)) {
        throw new UlidError('The clock returned a value that is not a finite number of milliseconds.');
      }
      let time = Math.max(observed, lastTime);
      if (time === lastTime && digits.length === ULID_RANDOM_CHARS) {
        if (!incrementRandomDigits(digits)) {
          // 80 bits of randomness exhausted inside one millisecond. Borrowing the next millisecond
          // keeps the order strict; the alternative is a duplicate run id, which AD-29 forbids.
          time += 1;
          digits = freshRandomDigits(random);
        }
      } else {
        digits = freshRandomDigits(random);
      }
      lastTime = time;
      const encoded = encodeUlidTime(time) + digits.map(digitChar).join('');
      if (!isUlid(encoded)) {
        throw new UlidError(`Minted "${encoded}", which is not a well-formed ULID.`);
      }
      return encoded;
    },
  };
};

/**
 * The process-wide minter. AD-29 makes the engine the sole minter of run ids, and "monotonic within a
 * process" is a property of one minter, so the engine shares this one unless a caller injects its own.
 */
export const defaultUlidMinter: UlidMinter = createUlidMinter();

/** Mint a run id from the process-wide minter. */
export const mintRunId = (): string => defaultUlidMinter.mint();
