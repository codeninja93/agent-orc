/**
 * AD-16, matrix rows 4–6 — the repository's own instructions are read as text and passed through.
 *
 * The suite's shape follows the boundary the story draws: **a loader must not try to parse prose**. So
 * the assertions are about bytes (the text is verbatim, including its blank lines and its trailing
 * newline) and about one mechanical question (does this document mention this symbol), and there is a
 * test that the returned shape carries no extracted rules at all — because the way that boundary would
 * be crossed is by somebody adding a helpful `rules` field, not by a function announcing itself.
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import {
  INSTRUCTION_FILE_NAMES,
  conventionsSpeakingTo,
  mentionsSymbol,
  readConventions,
} from '../src/engine/index.js';

import { makeWorkspace, writeInstructionFile } from './helpers/config-fixture.js';

const workspaces: string[] = [];

const workspace = (): string => {
  const created = makeWorkspace('conventions');
  workspaces.push(created);
  return created;
};

afterAll(() => {
  for (const path of workspaces) rmSync(path, { recursive: true, force: true });
});

/**
 * A `CLAUDE.md` with the awkward features a real one has: fenced code, a list, trailing whitespace and
 * a final newline. Every one of them is a thing a parser would normalise and a pass-through must not.
 */
const CLAUDE_MD = [
  '# Conventions',
  '',
  'Errors carry `code`, `message`, `retryable`, `cause`.   ',
  '',
  '- Never call `resolveProject` from a renderer.',
  '',
  '```ts',
  'const at = locate(projectId, orchHome);',
  '```',
  '',
].join('\n');

const AGENTS_MD = '# Agent notes\n\nPrefer `leaseWorktree` over a bare `git worktree add`.\n';

describe('the repository states its conventions and the loader passes them through (matrix 4)', () => {
  it('carries a CLAUDE.md byte for byte, including the whitespace a parser would tidy', () => {
    const repository = workspace();
    const path = writeInstructionFile(repository, 'CLAUDE.md', CLAUDE_MD);

    const conventions = readConventions(repository);

    expect(conventions.files).toHaveLength(1);
    expect(conventions.files[0]?.name).toBe('CLAUDE.md');
    expect(conventions.files[0]?.path).toBe(path);
    expect(conventions.files[0]?.text).toBe(CLAUDE_MD);
    // Named individually, because "equals the constant" would still pass if both sides were trimmed.
    expect(conventions.files[0]?.text.endsWith('\n')).toBe(true);
    expect(conventions.files[0]?.text).toContain('`cause`.   \n');
    expect(conventions.files[0]?.text).toContain('```ts');
  });

  it('extracts no rules from the prose, and carries no field that could hold any', () => {
    const repository = workspace();
    writeInstructionFile(repository, 'CLAUDE.md', CLAUDE_MD);

    const conventions = readConventions(repository);

    // The story's landmine: a loader that derived rules from prose would be inventing the conflict AD-16
    // exists to resolve. The shape is asserted rather than the behaviour, because a `rules` field is how
    // that would arrive — quietly, as a convenience, in a later story.
    expect(Object.keys(conventions).sort()).toStrictEqual(['directory', 'files', 'summary']);
    for (const file of conventions.files) {
      expect(Object.keys(file).sort()).toStrictEqual(['name', 'path', 'text']);
    }
  });

  it('says in one line which file is authoritative for conventions', () => {
    const repository = workspace();
    writeInstructionFile(repository, 'CLAUDE.md', CLAUDE_MD);

    expect(readConventions(repository).summary).toContain('CLAUDE.md');
    expect(readConventions(repository).summary).toContain('AD-16');
  });
});

describe('either instruction file will do, and both is not an error (matrix 5)', () => {
  it('reads AGENTS.md when there is no CLAUDE.md', () => {
    const repository = workspace();
    writeInstructionFile(repository, 'AGENTS.md', AGENTS_MD);

    const conventions = readConventions(repository);

    expect(conventions.files.map((file) => file.name)).toStrictEqual(['AGENTS.md']);
    expect(conventions.files[0]?.text).toBe(AGENTS_MD);
  });

  it('carries both when both exist, in the declared order rather than the directory order', () => {
    const repository = workspace();
    // Written AGENTS.md first, so a listing that reported filesystem order would come back reversed.
    writeInstructionFile(repository, 'AGENTS.md', AGENTS_MD);
    writeInstructionFile(repository, 'CLAUDE.md', CLAUDE_MD);

    const conventions = readConventions(repository);

    expect(conventions.files.map((file) => file.name)).toStrictEqual([...INSTRUCTION_FILE_NAMES]);
    expect(conventions.summary).toContain('CLAUDE.md and AGENTS.md');
  });

  it('ignores a directory that happens to be named like an instruction file', () => {
    const repository = workspace();
    mkdirSync(join(repository, 'CLAUDE.md'), { recursive: true });
    writeFileSync(join(repository, 'CLAUDE.md', 'inner.md'), 'not the conventions\n', 'utf8');

    expect(readConventions(repository).files).toStrictEqual([]);
  });
});

describe('a repository with neither instruction file states no conventions (matrix 6)', () => {
  it('reports them absent rather than failing', () => {
    const repository = workspace();

    const conventions = readConventions(repository);

    expect(conventions.files).toStrictEqual([]);
    expect(conventions.summary).toContain('no CLAUDE.md and no AGENTS.md');
  });

  it('has nothing speaking to any anchor, so every knowledge entry stands', () => {
    const repository = workspace();

    expect(conventionsSpeakingTo(readConventions(repository), 'resolveProject')).toStrictEqual([]);
  });
});

describe('an instruction file speaks to an anchor when it names it as a whole token', () => {
  const conventionsOf = (files: Readonly<Record<string, string>>): ReturnType<typeof readConventions> => {
    const repository = workspace();
    for (const [name, text] of Object.entries(files)) writeInstructionFile(repository, name, text);
    return readConventions(repository);
  };

  it('names the file that speaks to the anchor, not merely that one does', () => {
    const conventions = conventionsOf({ 'CLAUDE.md': CLAUDE_MD, 'AGENTS.md': AGENTS_MD });

    expect(conventionsSpeakingTo(conventions, 'resolveProject').map((file) => file.name)).toStrictEqual(
      ['CLAUDE.md'],
    );
    expect(conventionsSpeakingTo(conventions, 'leaseWorktree').map((file) => file.name)).toStrictEqual(
      ['AGENTS.md'],
    );
  });

  it('answers with both files when both name the anchor', () => {
    const conventions = conventionsOf({
      'CLAUDE.md': 'Call `locate` before writing.\n',
      'AGENTS.md': 'The helper is `locate`.\n',
    });

    expect(conventionsSpeakingTo(conventions, 'locate')).toHaveLength(2);
  });

  it('does not treat a longer symbol as a mention of the shorter one it contains', () => {
    // `resolveProjectPath` is a different symbol. A substring test would flag an entry about
    // `resolveProject` because of a document that never mentions it.
    expect(mentionsSymbol('Use resolveProjectPath for the pointer.', 'resolveProject')).toBe(false);
    expect(mentionsSymbol('Use resolveProject for the pointer.', 'resolveProject')).toBe(true);
  });

  it('is case-sensitive, because a symbol is', () => {
    expect(mentionsSymbol('Session lives in the checkpoint.', 'session')).toBe(false);
    expect(mentionsSymbol('session lives in the checkpoint.', 'session')).toBe(true);
  });

  it('reads a punctuated mention: backticks, brackets, a full stop, a line end', () => {
    for (const text of [
      '`resolveProject`',
      'resolveProject.',
      '(resolveProject)',
      'call resolveProject',
      'resolveProject',
    ]) {
      expect(mentionsSymbol(text, 'resolveProject'), text).toBe(true);
    }
  });

  it('reads a module-name and a file-path anchor, which carry dots and slashes', () => {
    expect(mentionsSymbol('See src/runtime/projects.ts for the record.', 'src/runtime/projects.ts')).toBe(
      true,
    );
    expect(mentionsSymbol('The runtime.recorder module appends.', 'runtime.recorder')).toBe(true);
    // The anchor is data, never a pattern: `.` must not match an arbitrary character.
    expect(mentionsSymbol('The runtimeXrecorder module appends.', 'runtime.recorder')).toBe(false);
  });

  it('answers false for an empty symbol rather than matching everything', () => {
    expect(mentionsSymbol('anything at all', '')).toBe(false);
  });
});
