/**
 * The shared half of every guard that reads `src/` and asserts something about what it finds.
 *
 * Three suites had their own copy of the comment stripper, which is the wrong number: a guard's claim is
 * about *code*, and a stripper that drifted between two files would have one guard reading its own
 * documentation as a violation while the other did not. Story 1-10's `src/tui/` guard already showed what
 * the recursion half costs when it is written per-suite — a flat `readdirSync` saw nine files of sixteen,
 * so the seven under `src/tui/cards/` were checked by nothing.
 */
import { readdirSync } from 'node:fs';

/**
 * A source with its comments removed, so a guard matches code and not prose.
 *
 * Block comments first, then whole-line `//` comments. A trailing `//` after code is deliberately left
 * alone: cutting it needs to know whether the `//` is inside a string or a regex, and a guard that
 * mangled `'https://…'` would be worse than one that reads one comment too many.
 */
export const stripComments = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

/** Every `.ts` file under a directory, **including the ones in subdirectories**, sorted. */
export const sourceFilesUnder = (root: URL): readonly string[] =>
  readdirSync(root, { recursive: true })
    .filter((name): name is string => typeof name === 'string' && name.endsWith('.ts'))
    .sort();
