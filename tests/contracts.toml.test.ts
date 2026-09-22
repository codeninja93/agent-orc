/**
 * The TOML subset, which had no suite of its own.
 *
 * Story 2-1 implemented the codec and tested it only through the installer's artifacts; story 2-3 moved it
 * to `src/contracts/` and gave the engine a second reader. The three things asserted here are the ones that
 * turn out not to be covered anywhere:
 *
 * - **An explicitly `undefined` value is omitted.** The one runtime change the move made was
 *   `if (value === undefined) continue`, and deleting that line left the whole suite green. Zod keeps a key
 *   spelled `knowledge: undefined` while dropping an absent one, so the spread form every caller uses is
 *   exactly what reaches this branch.
 * - **The serialiser never writes a file the loader rejects.** A table whose every value is `undefined` was
 *   emitting `[knowledge]` — the "empty table" this codec documents as *different from absent*, and one
 *   `ProfileSchema` refuses on read-back.
 * - **A prototype key is refused.** `parseToml('[__proto__]\nx = 1\n')` used to pollute `Object.prototype`
 *   process-wide. Pre-existing from story 2-1, and in scope now because the engine parses `profile.toml` at
 *   run start, in the process that spawns every step (matrix row 25).
 */
import { describe, expect, it } from 'vitest';

import {
  CURRENT_SCHEMA_VERSION,
  FORBIDDEN_TOML_KEYS,
  ProfileSchema,
  TomlParseError,
  parseToml,
  serialiseToml,
} from '../src/contracts/index.js';
import type { TomlTable } from '../src/contracts/index.js';

describe('an undefined value is a key that is not there', () => {
  it('omits an explicitly undefined key, byte for byte as if it were absent', () => {
    const withUndefined: TomlTable = { a: 1, knowledge: undefined };
    const withoutKey: TomlTable = { a: 1 };

    expect(serialiseToml(withUndefined)).toBe(serialiseToml(withoutKey));
    expect(serialiseToml(withUndefined)).toBe('a = 1\n');
    expect(serialiseToml(withUndefined)).not.toContain('knowledge');
  });

  it('emits no header for a table whose every value is undefined', () => {
    // The bug in its original form: `[knowledge]` for a section that is not there.
    expect(serialiseToml({ a: 1, knowledge: { entries: undefined } })).toBe('a = 1\n');
  });

  it('still emits a header for a table deliberately declared empty', () => {
    // Which is the distinction the codec's docblock draws: "there is a section and it holds nothing" is a
    // different fact from "there is no section", and only the first is written.
    expect(serialiseToml({ a: 1, knowledge: {} })).toBe('a = 1\n\n[knowledge]\n');
  });

  it('never writes a profile its own schema would refuse on read-back', () => {
    // The round trip is the property that matters: `{ knowledge: undefined }` is what a profile with no
    // knowledge section looks like in memory, and the bytes have to load again.
    const profile = ProfileSchema.parse({
      schema_version: CURRENT_SCHEMA_VERSION,
      project: { id: 'abc', path: '/tmp/x', remote: '' },
      mechanics: {
        package_manager: 'npm',
        commands: { test: 'npm test', lint: '', build: '', run: '' },
        source_layout: ['src'],
        resources: 'none',
      },
      risk: { high_blast_radius_paths: [], conflict_domains: [] },
      roster: { builtin_agents: [] },
      branch_pattern: 'feature/<feature-slug>',
      autonomy_start: 'live',
      ceilings: { steps: 1, wall_clock_minutes: 1, rate_limit_budget_percent: 1 },
    });

    const bytes = serialiseToml({ ...profile, knowledge: undefined });

    expect(bytes).not.toContain('[knowledge]');
    expect(ProfileSchema.safeParse(parseToml(bytes)).success).toBe(true);
  });
});

describe('a key that names a prototype is refused (matrix 25)', () => {
  it.each(['__proto__', 'constructor', 'prototype'])('refuses [%s] as a table header', (key) => {
    let threw: unknown;
    try {
      parseToml(`[${key}]\nx = 1\n`);
    } catch (error) {
      threw = error;
    }

    expect(threw).toBeInstanceOf(TomlParseError);
    expect((threw as TomlParseError).code).toBe('config.invalid');
    expect((threw as TomlParseError).line).toBe(1);
    expect((threw as Error).message).toContain(key);
  });

  it.each(['__proto__', 'constructor', 'prototype'])('refuses %s as a bare key', (key) => {
    expect(() => parseToml(`${key} = 1\n`)).toThrowError(TomlParseError);
  });

  it('refuses one buried in a dotted key path or a table-array header', () => {
    expect(() => parseToml('a.__proto__.b = 1\n')).toThrowError(TomlParseError);
    expect(() => parseToml('[[constructor]]\nx = 1\n')).toThrowError(TomlParseError);
    expect(() => parseToml('[a.__proto__]\nx = 1\n')).toThrowError(TomlParseError);
  });

  it('leaves Object.prototype untouched, which is the whole of the reason', () => {
    // The old behaviour returned a table with no own keys and left `({}).x === 1` for the rest of the
    // process — every object in the engine, from one hand edit of a profile.
    try {
      parseToml('[__proto__]\nx = 1\n');
    } catch {
      // The refusal is asserted above; here the only claim is about what the attempt left behind.
    }
    expect('x' in {}).toBe(false);
    expect(Object.prototype).not.toHaveProperty('x');
  });

  it('builds tables with no prototype, so an assignment cannot reach one', () => {
    const table = parseToml('[a]\nb = 1\n');

    expect(Object.getPrototypeOf(table)).toBeNull();
    expect(Object.getPrototypeOf(table['a'] as object)).toBeNull();
    // A prototype member is therefore not inherited: a lookup of one answers `undefined` rather than an
    // `Object` member masquerading as a value read from the file.
    expect(Object.prototype.hasOwnProperty.call(table, 'toString')).toBe(false);
    expect('toString' in table).toBe(false);
  });

  it('names the forbidden keys once, so the refusal and the docs cannot disagree', () => {
    expect([...FORBIDDEN_TOML_KEYS].sort()).toStrictEqual(['__proto__', 'constructor', 'prototype']);
  });

  it('still reads an ordinary key that merely contains a forbidden word', () => {
    // The refusal is on the key, not on a substring of it: `constructor_notes` is an ordinary name.
    expect(parseToml('constructor_notes = "fine"\n')['constructor_notes']).toBe('fine');
  });
});
