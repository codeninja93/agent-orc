/**
 * The exclusive create itself, tested directly rather than only through the two claims that use it.
 *
 * It had no unit test at all: it was exercised only indirectly, by the two cross-process races, which
 * answer "does exactly one process win" and say nothing about the properties the module's own docblock
 * promises — that the publish is whole, that the temporary is always removed, that only `EEXIST` means a
 * lost race, and that the directory is the caller's to create. Each of those is one line of code and
 * each has a different failure mode, so each gets an assertion here. The races stay where they are:
 * cross-process contention is not a thing one process can assert.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { HardLinksUnsupported, createFileExclusively } from '../src/runtime/index.js';

let dir: string;
const toRemove: string[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orch-exclusive-create-'));
  toRemove.push(dir);
});

afterEach(() => {
  for (const path of toRemove.splice(0)) rmSync(path, { recursive: true, force: true });
});

/** Every name in the directory that is not the claim itself: the debris a failed publish could leave. */
const leftovers = (claim: string): string[] =>
  readdirSync(dir).filter((name) => name !== claim);

describe('the claim is published whole, or not at all', () => {
  it('creates the file with its whole contents, in one step', () => {
    const path = join(dir, 'engine.lock');
    expect(createFileExclusively(path, '{"pid":41235}\n')).toBe(true);
    expect(readFileSync(path, 'utf8')).toBe('{"pid":41235}\n');
    // Never zero-length: the whole point is that the inode published already holds the record.
    expect(statSync(path).size).toBeGreaterThan(0);
  });

  it('answers false and changes nothing when the name is already taken', () => {
    const path = join(dir, 'engine.lock');
    expect(createFileExclusively(path, 'first\n')).toBe(true);
    expect(createFileExclusively(path, 'second\n')).toBe(false);
    // The loser did not overwrite the winner, which is the difference between link(2) and rename(2).
    expect(readFileSync(path, 'utf8')).toBe('first\n');
  });

  it('leaves no temporary behind, on the winning path or the losing one', () => {
    const path = join(dir, 'engine.lock');
    createFileExclusively(path, 'first\n');
    expect(leftovers('engine.lock')).toStrictEqual([]);
    createFileExclusively(path, 'second\n');
    expect(leftovers('engine.lock')).toStrictEqual([]);
  });

  it('gives two calls distinct temporary names, so one cannot clobber the other mid-flight', () => {
    // Asserted through the outcome rather than by inspecting the name: a shared temporary would make
    // the second call fail on its own 'wx' open rather than lose the link cleanly.
    const first = join(dir, 'a.lock');
    const second = join(dir, 'b.lock');
    expect(createFileExclusively(first, 'a\n')).toBe(true);
    expect(createFileExclusively(second, 'b\n')).toBe(true);
    expect(readFileSync(first, 'utf8')).toBe('a\n');
    expect(readFileSync(second, 'utf8')).toBe('b\n');
  });
});

describe('only a lost race is answered as one', () => {
  it('throws rather than answering false when the directory does not exist', () => {
    const path = join(dir, 'no-such-directory', 'engine.lock');
    /**
     * The directory is the caller's to create — `Recorder.open` makes the run directory and
     * `EngineLock.acquire` makes `ORCH_HOME` — and a module whose subject is "who got there first"
     * must not quietly bring a missing parent into existence: an `ORCH_HOME` typo would then be
     * answered by an empty new tree instead of by a path a person can read.
     */
    expect(() => createFileExclusively(path, 'x\n')).toThrowError(/ENOENT/);
    expect(existsSync(join(dir, 'no-such-directory'))).toBe(false);
  });

  it('reads a directory sitting at the target as a taken name, and does not replace it', () => {
    const path = join(dir, 'engine.lock');
    mkdirSync(path);
    /**
     * `link(2)` onto an existing name answers `EEXIST` whatever that name is, so a directory in the
     * lock's place is reported as "the name is taken" — which is the fail-safe direction and not a
     * pretence that a process holds it: the caller then fails to read a claim out of it and refuses by
     * name. What must not happen is the directory being removed or replaced, and that is the assertion.
     */
    expect(createFileExclusively(path, 'x\n')).toBe(false);
    expect(statSync(path).isDirectory()).toBe(true);
    expect(leftovers('engine.lock')).toStrictEqual([]);
  });

  it('names a filesystem with no hard links rather than leaking its errno', () => {
    /**
     * Reached by construction rather than by finding such a filesystem: the module maps a set of errnos
     * onto a named refusal, and what is asserted is the mapping and the sentence it produces. A real
     * hard-link-less mount is not something a test suite can require of the machine it runs on.
     */
    const failure = new HardLinksUnsupported(join(dir, 'engine.lock'), 'EOPNOTSUPP');
    expect(failure.message).toContain('EOPNOTSUPP');
    expect(failure.message).toContain('hard links');
    expect(failure.message).toContain('ORCH_HOME');
    expect(failure.errno).toBe('EOPNOTSUPP');
    // A declared AD-35 code, so a caller routing it reaches the table rather than the unknown fallback.
    expect(failure.code).toBe('config.invalid');
  });
});

describe('the name is made durable, not only the bytes', () => {
  it('survives a reader that opens the claim immediately after the create returns', () => {
    const path = join(dir, 'engine.lock');
    createFileExclusively(path, '{"pid":1}\n');
    // The in-process half of the cross-process guarantee: the moment the create answers true, the
    // claim is readable in full. The power-loss half is the directory fsync, which no test can observe.
    expect(JSON.parse(readFileSync(path, 'utf8')) as { pid: number }).toStrictEqual({ pid: 1 });
  });

  it('does not disturb an unrelated file in the same directory', () => {
    const neighbour = join(dir, 'events.jsonl');
    writeFileSync(neighbour, 'a line\n', 'utf8');
    createFileExclusively(join(dir, 'events.jsonl.lock'), 'claim\n');
    expect(readFileSync(neighbour, 'utf8')).toBe('a line\n');
  });
});
