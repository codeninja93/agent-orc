/**
 * AD-16 — the repository's own instructions, read as text and passed through unparsed.
 *
 * AD-16 splits one question into two that cannot conflict: the profile is authoritative for
 * **mechanics** — the four commands, the package manager, the layout, resource needs, risk tiers,
 * conflict domains — and the repository's own instructions are authoritative for **code conventions**.
 * Nothing in a `CLAUDE.md` competes with a test command, because prose does not declare one in a form
 * anything can read; and nothing here tries to read one.
 *
 * **This module extracts no rules, and that is the whole of its design.** It answers two questions and
 * no others: what does the repository's instruction file *say* (verbatim, byte for byte, handed to an
 * agent to read), and does it *mention* a given anchor. A loader that tried to derive rules from prose
 * would be inventing the conflict AD-16's precedence rule exists to resolve — it would have to decide
 * that one English sentence contradicts another, which is not decidable by code and would make the
 * verdict depend on the phrasing of a paragraph nobody wrote for a parser.
 *
 * **"Speaks to the same point" is therefore occurrence of a symbol, not agreement about a meaning.**
 * `conventionsSpeakingTo` looks for the anchor as a whole token in the instruction text. That is
 * mechanical, reproducible, and explainable to the person whose entry got flagged: their entry named
 * `resolveProject`, and `CLAUDE.md` names `resolveProject`, so the repository wins (AD-16) and the
 * entry is reported stale rather than applied.
 *
 * **Both files may exist, and that is not an error.** `CLAUDE.md` and `AGENTS.md` are two spellings of
 * the same convention: a repository with both has two instruction files, and the loader carries both in
 * a fixed order rather than picking a winner — there is no precedence *between* them to declare,
 * because both are the repository speaking.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The instruction file names, in the order they are reported.
 *
 * Fixed rather than discovered, and ordered rather than sorted at read time, because the order is part
 * of what a step is handed: the same repository must produce the same conventions list on every run, or
 * two runs of one feature would put the same two documents in front of an agent in two orders.
 */
export const INSTRUCTION_FILE_NAMES = ['CLAUDE.md', 'AGENTS.md'] as const;

export type InstructionFileName = (typeof INSTRUCTION_FILE_NAMES)[number];

/** One instruction file: its name, where it was read from, and its text exactly as it was on disk. */
export interface InstructionFile {
  readonly name: string;
  readonly path: string;
  /**
   * The file's bytes, decoded as UTF-8 and otherwise untouched.
   *
   * Not trimmed, not normalised, not split into rules. This is the field AD-16 means by "the
   * repository's own instructions are authoritative": an agent is handed the text and reads it, exactly
   * as a person would.
   */
  readonly text: string;
}

/**
 * The repository's conventions, which are its instruction files and nothing derived from them.
 *
 * There is deliberately no `rules`, no `sections` and no parsed anything in this shape. The absence is
 * the design: a field holding extracted rules would be a second authority on conventions beside the
 * text itself, and the first time the two disagreed the extraction would win silently.
 */
export interface RepositoryConventions {
  /** Where the instruction files were read from — a repository root, or a snapshot's `conventions/`. */
  readonly directory: string;
  /** Present files, in {@link INSTRUCTION_FILE_NAMES} order. Empty when the repository has neither. */
  readonly files: readonly InstructionFile[];
  /** R3 — one line that stands alone, including when it says there are none. */
  readonly summary: string;
}

/** True when the path exists and is a regular file, so a `CLAUDE.md/` directory is not read as one. */
const isFile = (path: string): boolean => {
  if (!existsSync(path)) return false;
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
};

/**
 * Read whichever instruction files a directory holds.
 *
 * A directory with neither is not a failure — matrix row 6: conventions are simply absent, and the
 * profile's mechanics still load. A repository that has never written a `CLAUDE.md` is an ordinary
 * repository, and refusing to run in one would make AD-16's split into a requirement to adopt one.
 */
export const readConventions = (directory: string): RepositoryConventions => {
  const files: InstructionFile[] = [];
  for (const name of INSTRUCTION_FILE_NAMES) {
    const path = join(directory, name);
    if (!isFile(path)) continue;
    files.push({ name, path, text: readFileSync(path, 'utf8') });
  }
  return {
    directory,
    files,
    summary:
      files.length === 0
        ? `${directory} has no ${INSTRUCTION_FILE_NAMES.join(' and no ')}, so the repository states ` +
          'no conventions of its own; the profile\'s mechanics are unaffected (AD-16).'
        : `${directory} states its conventions in ${files
            .map((file) => file.name)
            .join(' and ')}, which is authoritative for conventions (AD-16) and is passed through ` +
          'unparsed.',
  };
};

/** Identifier characters: a match bounded by one of these is part of a longer name, not the name. */
const IDENTIFIER_CHARACTER = /[A-Za-z0-9_$]/;

/**
 * True when `text` mentions `symbol` as a whole token.
 *
 * Whole-token rather than substring, because `resolveProjectPath` is a different symbol from
 * `resolveProject` and an entry anchored on the shorter one must not be flagged by a document that
 * only ever names the longer. Case-sensitive, because these are symbols: `Session` and `session` are
 * two names in every language this orchestrator will meet.
 *
 * Boundaries are judged by the characters *around* a match rather than by a constructed regular
 * expression, because an anchor is data — a file-path anchor carries `/` and `.`, both of which mean
 * something else in a pattern, and building a regex from a value is how an anchor comes to match
 * things it does not name.
 */
export const mentionsSymbol = (text: string, symbol: string): boolean => {
  if (symbol === '') return false;
  for (let at = text.indexOf(symbol); at !== -1; at = text.indexOf(symbol, at + 1)) {
    const before = at === 0 ? '' : text.charAt(at - 1);
    const after = text.charAt(at + symbol.length);
    const boundedBefore = before === '' || !IDENTIFIER_CHARACTER.test(before);
    const boundedAfter = after === '' || !IDENTIFIER_CHARACTER.test(after);
    if (boundedBefore && boundedAfter) return true;
  }
  return false;
};

/**
 * Which instruction files speak to an anchor — the one question AD-16's precedence rule needs.
 *
 * The answer is a list of files rather than a boolean because the flag has to *name* what overrode the
 * entry: "your entry about `resolveProject` was not applied" is an assertion a person cannot check,
 * while "`CLAUDE.md` speaks to `resolveProject`, so it wins (AD-16)" sends them to the paragraph that
 * did it.
 */
export const conventionsSpeakingTo = (
  conventions: RepositoryConventions,
  anchor: string,
): readonly InstructionFile[] => conventions.files.filter((file) => mentionsSymbol(file.text, anchor));
