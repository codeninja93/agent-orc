/**
 * How wide a string is on a terminal, in cells rather than in UTF-16 units.
 *
 * Every width guarantee this directory makes is a guarantee about a *terminal* — "keeps every line
 * inside 40 columns, with the mode and status still present" is one of the story's declared render
 * states, and the reason it is declared is that a mode line cut in half is the mode confusion
 * `interface-contract.md` calls an accident class. `String.length` counts UTF-16 code units, which is
 * neither of the two things that matter: an emoji or a CJK character occupies two cells while counting
 * as one or two units, and a combining mark occupies none while counting as one. Measuring with it
 * therefore wraps a line of Japanese at twice the terminal's width and a line of accented Latin at less
 * than it, in both cases breaking the bound a person actually reads.
 *
 * Measured here rather than with a package: Ink depends on `string-width` transitively, but the story's
 * Never list forbids adding a dependency beyond React and Ink without recording it as a deviation, and
 * reaching for a transitive dependency is adding one without saying so. What this needs is narrower than
 * that package anyway — the two facts a monospace terminal cares about, which are "this cluster takes
 * two cells" and "this cluster takes none".
 *
 * Text is walked as grapheme clusters, so a base character and its combining marks, and an emoji built
 * from several code points, each count once.
 */

/** The East Asian Wide and Fullwidth blocks, plus the emoji planes: two cells each. */
const WIDE_RANGES: readonly (readonly [number, number])[] = Object.freeze([
  [0x1100, 0x115f],
  [0x2e80, 0x303e],
  [0x3041, 0x33ff],
  [0x3400, 0x4dbf],
  [0x4e00, 0x9fff],
  [0xa000, 0xa4cf],
  [0xa960, 0xa97f],
  [0xac00, 0xd7a3],
  [0xf900, 0xfaff],
  [0xfe10, 0xfe19],
  [0xfe30, 0xfe6f],
  [0xff00, 0xff60],
  [0xffe0, 0xffe6],
  [0x1f300, 0x1f64f],
  [0x1f900, 0x1f9ff],
  [0x20000, 0x3fffd],
]);

/** Combining marks, variation selectors and the zero-width controls: no cells at all. */
const ZERO_WIDTH_RANGES: readonly (readonly [number, number])[] = Object.freeze([
  [0x0300, 0x036f],
  [0x0483, 0x0489],
  [0x1ab0, 0x1aff],
  [0x1dc0, 0x1dff],
  [0x200b, 0x200f],
  [0x20d0, 0x20ff],
  [0xfe00, 0xfe0f],
  [0xfe20, 0xfe2f],
  [0xfeff, 0xfeff],
]);

const within = (ranges: readonly (readonly [number, number])[], code: number): boolean =>
  ranges.some(([from, to]) => code >= from && code <= to);

/** The cells one grapheme cluster occupies: none for a mark, two for a wide character, one otherwise. */
export const clusterWidth = (cluster: string): number => {
  const code = cluster.codePointAt(0);
  if (code === undefined) return 0;
  if (within(ZERO_WIDTH_RANGES, code)) return 0;
  return within(WIDE_RANGES, code) ? 2 : 1;
};

/**
 * The grapheme clusters of a string, in order.
 *
 * `Intl.Segmenter` rather than a spread over code points, because a cluster is the unit a terminal
 * draws and the unit a person sees: slicing a long word between a base character and its accent would
 * put half a letter on each of two rows.
 */
const SEGMENTER = new Intl.Segmenter('en', { granularity: 'grapheme' });

export const clustersOf = (text: string): readonly string[] =>
  [...SEGMENTER.segment(text)].map((entry) => entry.segment);

/** How many terminal cells this string occupies. */
export const displayWidth = (text: string): number => {
  let width = 0;
  for (const cluster of clustersOf(text)) width += clusterWidth(cluster);
  return width;
};

/**
 * The longest leading part of a string that fits in `cells`, and the rest.
 *
 * Used only for a word wider than the whole line, where something has to be cut: the cut falls between
 * grapheme clusters, and never inside one.
 */
export const splitAtWidth = (
  text: string,
  cells: number,
): { readonly head: string; readonly tail: string } => {
  let head = '';
  let width = 0;
  const clusters = clustersOf(text);
  for (const [index, cluster] of clusters.entries()) {
    const next = clusterWidth(cluster);
    if (width + next > cells) return { head, tail: clusters.slice(index).join('') };
    head += cluster;
    width += next;
  }
  return { head, tail: '' };
};

/** The narrowest line this wraps to. Below it, wrapping produces rows nothing can be read from. */
export const MIN_WRAP_COLUMNS = 20;

/**
 * Wrap a line to a width in terminal cells, breaking on spaces and never mid-word unless a word is
 * wider than the line.
 *
 * Wrapping rather than truncating, because the 40-column case is a declared state and a mode line cut
 * in half is precisely the mode confusion the interface contract calls an accident class. It lives here
 * rather than beside the frame because the control hints wrap too, and the hints may not import the
 * frame that draws them.
 */
export const wrapToWidth = (line: string, columns: number): readonly string[] => {
  const width = Math.max(columns, MIN_WRAP_COLUMNS);
  if (displayWidth(line) <= width) return [line];
  const out: string[] = [];
  let current = '';
  for (const word of line.split(' ')) {
    if (current === '') {
      current = word;
    } else if (displayWidth(`${current} ${word}`) <= width) {
      current = `${current} ${word}`;
    } else {
      out.push(current);
      current = word;
    }
    while (displayWidth(current) > width) {
      const split = splitAtWidth(current, width);
      out.push(split.head);
      current = split.tail;
    }
  }
  if (current !== '') out.push(current);
  return out;
};
