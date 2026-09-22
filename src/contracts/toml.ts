/**
 * The TOML the installer writes and the engine reads back.
 *
 * The Consistency Conventions make human-edited configuration TOML, and the four artifacts of AD-9
 * are human-edited by definition — AD-16 has a person review the profile before first use. Node has
 * no TOML in its standard library and AD-2 keeps this to one package, so the format is implemented
 * here rather than imported: a dependency added to the delivery surface is a dependency AD-12's
 * `npx` path has to resolve on every install, for a serialiser whose whole job is four known shapes.
 *
 * **It lives in `src/contracts/` because two layers read the same bytes.** Story 2-1 wrote it under
 * `src/installer/`, where it was the only reader; story 2-3's profile loader and roster discovery are
 * in `src/engine/`, and the spine's dependency graph draws no edge from the engine to the installer —
 * so the codec moved to the one layer both may depend on rather than being written a second time.
 * `src/installer/toml.ts` re-exports this and nothing else, so every existing import still resolves
 * and there is still exactly one parser. It imports nothing, which is what keeps `src/contracts/` the
 * root of the graph.
 *
 * **Deliberately a subset, and it refuses rather than guesses.** Strings, integers, booleans, arrays
 * of those, tables, and arrays of tables — that is every construct the four artifacts use. A float,
 * a datetime, an inline table or a multi-line string is a named refusal carrying its line number,
 * because a parser that silently mis-reads a hand edit turns a person's correction into a different
 * answer than the one they wrote.
 *
 * **The emitted bytes are a function of the value alone.** Story 2-1's idempotence is observable —
 * two runs leave `.orch/` byte-identical except where an answer actually changed — and that is only
 * true if serialising the same answers twice produces the same bytes. So key order follows the
 * object's own insertion order, arrays stay on one line, and nothing here reads a clock or a locale.
 */

/** A value this subset can carry. */
export type TomlScalar = string | number | boolean;

export type TomlValue = TomlScalar | readonly TomlScalar[] | TomlTable | readonly TomlTable[];

/**
 * A table. Its index signature admits `undefined` because **TOML has no null and an optional section
 * that is absent is a key that is not there** — `ProfileSchema.knowledge` is optional (story 2-1 wrote
 * no knowledge section and story 2-3 must still read those profiles), so the serialiser meets a property
 * whose value is `undefined` and the honest emission is nothing at all.
 *
 * Not the same thing as an empty table: `[knowledge]` with no keys says "there is a knowledge section and
 * it holds nothing", and a reader that wrote one for an absent section would be inventing an answer.
 */
export interface TomlTable {
  readonly [key: string]: TomlValue | undefined;
}

/** A refusal that names the line, because a hand-edited file is the only way this is reached. */
export class TomlParseError extends Error {
  readonly code = 'config.invalid';
  readonly line: number;

  constructor(message: string, line: number) {
    super(`${message} (line ${String(line)})`);
    this.name = 'TomlParseError';
    this.line = line;
  }
}

/** A bare key needs no quoting; anything else is quoted, so a key is never ambiguous. */
const BARE_KEY_PATTERN = /^[A-Za-z0-9_-]+$/;

/**
 * Keys that reach `Object.prototype` rather than the table, and are refused rather than assigned.
 *
 * `parseToml('[__proto__]\nx = 1\n')` used to return a table with no own keys and leave `({}).x === 1`
 * — prototype pollution, process-wide, from one hand edit of `profile.toml`. It was survivable while the
 * installer was the only reader of its own output; the engine now parses the profile at run start, in the
 * process that spawns every step, so a profile is untrusted input on a path that matters.
 *
 * Both halves of the fix are needed: tables are built with `Object.create(null)`, so an assignment cannot
 * reach a prototype at all, and these names are refused outright, so a key that would silently vanish into
 * one is a named refusal carrying its line instead.
 */
export const FORBIDDEN_TOML_KEYS: readonly string[] = Object.freeze([
  '__proto__',
  'constructor',
  'prototype',
]);

const escapeString = (value: string): string =>
  value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');

const formatKey = (key: string): string =>
  BARE_KEY_PATTERN.test(key) ? key : `"${escapeString(key)}"`;

const formatScalar = (value: TomlScalar, path: string): string => {
  if (typeof value === 'string') return `"${escapeString(value)}"`;
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (!Number.isInteger(value)) {
    throw new Error(
      `Refusing to serialise ${path}: ${String(value)} is not an integer, and this subset carries ` +
        'no floats — AD-24 counts steps, minutes and percent, none of which is fractional.',
    );
  }
  return String(value);
};

const isTable = (value: unknown): value is TomlTable =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isTableArray = (value: unknown): value is readonly TomlTable[] =>
  Array.isArray(value) && value.every(isTable);

const isScalar = (value: unknown): value is TomlScalar =>
  typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';

const isScalarArray = (value: unknown): value is readonly TomlScalar[] =>
  Array.isArray(value) && value.every(isScalar);

/** `a.b` as a table header, with each segment quoted only when it has to be. */
const formatHeader = (path: readonly string[]): string => path.map(formatKey).join('.');

const serialiseTable = (table: TomlTable, path: readonly string[], out: string[]): void => {
  const scalars: string[] = [];
  const tables: [string, TomlTable][] = [];
  const tableArrays: [string, readonly TomlTable[]][] = [];

  for (const [key, value] of Object.entries(table)) {
    const where = [...path, key].join('.');
    // An absent optional section emits nothing, so a re-serialised profile that never had a knowledge
    // section is byte-identical to the one the installer wrote — which is what story 2-1's idempotence
    // measures, and what makes the section safe to add.
    if (value === undefined) continue;
    // An *empty* array of tables is indistinguishable from an empty array of scalars, and `key = []`
    // is the form that reads back as the empty list it is — so the length check comes first.
    if (isTableArray(value) && value.length > 0) {
      tableArrays.push([key, value]);
      continue;
    }
    if (isTable(value)) {
      tables.push([key, value]);
      continue;
    }
    if (isScalarArray(value)) {
      const items = value.map((item) => formatScalar(item, where));
      scalars.push(`${formatKey(key)} = [${items.join(', ')}]`);
      continue;
    }
    if (!isScalar(value)) {
      throw new Error(
        `Refusing to serialise ${where}: an array mixing tables and scalars has no TOML form.`,
      );
    }
    scalars.push(`${formatKey(key)} = ${formatScalar(value, where)}`);
  }

  // Scalars before sub-tables: in TOML every key after a table header belongs to that table, so a
  // scalar emitted after one would silently change owner.
  if (scalars.length > 0) {
    if (path.length > 0) out.push(`[${formatHeader(path)}]`);
    out.push(...scalars, '');
  } else if (
    path.length > 0 &&
    tables.length === 0 &&
    tableArrays.length === 0 &&
    Object.keys(table).length === 0
  ) {
    /**
     * A table deliberately declared empty still has to appear, or reading the file back loses the fact
     * that it is there.
     *
     * The `Object.keys` check is what distinguishes that from a table whose every value is `undefined`,
     * which is how an absent optional section arrives — `{ knowledge: { entries: undefined } }`. Without
     * it, the serialiser emitted `[knowledge]` for a section that is not there: the very "empty table"
     * this file documents as *different from absent*, and one `ProfileSchema` then refuses on read-back,
     * so the codec could write a file the loader rejects.
     */
    out.push(`[${formatHeader(path)}]`, '');
  }

  for (const [key, value] of tables) serialiseTable(value, [...path, key], out);
  for (const [key, entries] of tableArrays) {
    for (const entry of entries) {
      // Entries carry scalars and arrays only. A nested table inside a `[[…]]` entry needs a header
      // naming the whole path, and no artifact has one — so this refuses rather than emitting a
      // header that would read back as a different table.
      if (Object.values(entry).some((value) => isTable(value) || isTableArray(value))) {
        throw new Error(
          `Refusing to serialise ${[...path, key].join('.')}: a table-array entry carrying a nested ` +
            'table is outside this subset.',
        );
      }
      out.push(`[[${formatHeader([...path, key])}]]`);
      const nested: string[] = [];
      serialiseTable(entry, [], nested);
      out.push(...nested);
    }
  }
};

/**
 * Serialise a table to TOML text, ending in exactly one newline.
 *
 * A trailing blank line would be a byte that differs between a hand-edited file and a rewritten one,
 * which is the difference the idempotence test measures.
 */
export const serialiseToml = (table: TomlTable): string => {
  const out: string[] = [];
  serialiseTable(table, [], out);
  while (out.length > 0 && out[out.length - 1] === '') out.pop();
  return out.length === 0 ? '' : `${out.join('\n')}\n`;
};

/** Split a key path such as `a."b c".d` into its segments. */
const splitKeyPath = (raw: string, line: number): string[] => {
  const segments: string[] = [];
  let current = '';
  let quoted = false;
  for (const char of raw) {
    if (char === '"') {
      quoted = !quoted;
      continue;
    }
    if (char === '.' && !quoted) {
      segments.push(current.trim());
      current = '';
      continue;
    }
    current += char;
  }
  segments.push(current.trim());
  if (segments.some((segment) => segment === '')) {
    throw new TomlParseError(`"${raw}" is not a key`, line);
  }
  // Every key and every table header comes through here, so one check covers `__proto__ = 1`,
  // `a.__proto__.b = 1`, `[__proto__]` and `[[constructor]]` alike.
  const forbidden = segments.find((segment) => FORBIDDEN_TOML_KEYS.includes(segment));
  if (forbidden !== undefined) {
    throw new TomlParseError(
      `"${forbidden}" cannot be a key: it names a JavaScript object's prototype rather than a value in ` +
        'this table, so reading it would change every object in the process instead of this file',
      line,
    );
  }
  return segments;
};

const unescapeString = (body: string, line: number): string => {
  let out = '';
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index];
    if (char !== '\\') {
      out += char;
      continue;
    }
    index += 1;
    const escape = body[index];
    switch (escape) {
      case 'n':
        out += '\n';
        break;
      case 'r':
        out += '\r';
        break;
      case 't':
        out += '\t';
        break;
      case '"':
        out += '"';
        break;
      case '\\':
        out += '\\';
        break;
      default:
        throw new TomlParseError(`unsupported escape "\\${escape ?? ''}"`, line);
    }
  }
  return out;
};

/** Strip a comment that is not inside a string. */
const stripComment = (text: string): string => {
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === '"' && text[index - 1] !== '\\') quoted = !quoted;
    if (char === '#' && !quoted) return text.slice(0, index);
  }
  return text;
};

const parseScalar = (raw: string, line: number): TomlScalar => {
  const text = raw.trim();
  if (text.startsWith('"')) {
    if (!text.endsWith('"') || text.length < 2) {
      throw new TomlParseError('an unterminated string', line);
    }
    return unescapeString(text.slice(1, -1), line);
  }
  if (text === 'true') return true;
  if (text === 'false') return false;
  if (/^[+-]?\d+$/.test(text)) return Number(text);
  if (text.startsWith('{')) {
    throw new TomlParseError(
      'an inline table, which this subset does not read; use a [table] header instead',
      line,
    );
  }
  throw new TomlParseError(
    `"${text}" is not a string, integer or boolean, and this subset reads nothing else`,
    line,
  );
};

/** Split an array body on commas that are not inside a string. */
const splitArrayItems = (body: string): string[] => {
  const items: string[] = [];
  let current = '';
  let quoted = false;
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index];
    if (char === '"' && body[index - 1] !== '\\') quoted = !quoted;
    if (char === ',' && !quoted) {
      items.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  if (current.trim() !== '') items.push(current);
  return items;
};

const parseArray = (body: string, line: number): TomlScalar[] =>
  splitArrayItems(body).map((item) => parseScalar(item, line));

/** The parser's own table while it is being filled. Mirrors {@link TomlTable}, mutably. */
type MutableTable = Record<string, TomlValue | undefined>;

/** A table with no prototype, so no assignment into it can ever reach `Object.prototype`. */
const emptyTable = (): MutableTable => Object.create(null) as MutableTable;

const childTable = (parent: MutableTable, key: string, line: number): MutableTable => {
  const existing = parent[key];
  if (existing === undefined) {
    const created: MutableTable = emptyTable();
    parent[key] = created;
    return created;
  }
  // A key that is already a table array belongs to the entry being filled: `[[a]]` then `[a.b]`
  // puts `b` inside the last `a`, not beside the array.
  if (isTableArray(existing)) {
    const last = existing.at(-1);
    if (last !== undefined) return last;
  }
  if (isTable(existing)) return existing;
  throw new TomlParseError(`"${key}" is already a value and cannot also be a table`, line);
};

/**
 * Parse the subset. The result is a plain object; every reader hands it straight to a Zod schema,
 * which is where the *shape* is decided — this only decides what the bytes say.
 */
export const parseToml = (text: string): TomlTable => {
  const root: MutableTable = emptyTable();
  let current: MutableTable = root;
  const lines = text.split('\n');

  for (let index = 0; index < lines.length; index += 1) {
    const lineNumber = index + 1;
    const line = stripComment(lines[index] ?? '').trim();
    if (line === '') continue;

    if (line.startsWith('[[')) {
      if (!line.endsWith(']]')) throw new TomlParseError('an unterminated table-array header', lineNumber);
      const path = splitKeyPath(line.slice(2, -2), lineNumber);
      let table: MutableTable = root;
      for (const segment of path.slice(0, -1)) table = childTable(table, segment, lineNumber);
      const key = path[path.length - 1] ?? '';
      const existing = table[key];
      const entry: MutableTable = emptyTable();
      if (existing === undefined) {
        table[key] = [entry];
      } else if (isTableArray(existing)) {
        table[key] = [...existing, entry];
      } else {
        throw new TomlParseError(`"${key}" is already a value and cannot also be a table array`, lineNumber);
      }
      current = entry;
      continue;
    }

    if (line.startsWith('[')) {
      if (!line.endsWith(']')) throw new TomlParseError('an unterminated table header', lineNumber);
      const path = splitKeyPath(line.slice(1, -1), lineNumber);
      let table: MutableTable = root;
      for (const segment of path) table = childTable(table, segment, lineNumber);
      current = table;
      continue;
    }

    const separator = line.indexOf('=');
    if (separator === -1) throw new TomlParseError(`"${line}" is neither a header nor a key`, lineNumber);
    const path = splitKeyPath(line.slice(0, separator), lineNumber);
    let value = line.slice(separator + 1).trim();

    if (value.startsWith('[')) {
      // A hand edit may spread an array over several lines; the serialiser never does.
      while (!value.endsWith(']') && index + 1 < lines.length) {
        index += 1;
        value += ` ${stripComment(lines[index] ?? '').trim()}`;
      }
      if (!value.endsWith(']')) throw new TomlParseError('an unterminated array', lineNumber);
    }

    let table: MutableTable = current;
    for (const segment of path.slice(0, -1)) table = childTable(table, segment, lineNumber);
    const key = path[path.length - 1] ?? '';
    if (Object.prototype.hasOwnProperty.call(table, key)) {
      throw new TomlParseError(`"${key}" is declared twice`, lineNumber);
    }
    table[key] = value.startsWith('[')
      ? parseArray(value.slice(1, -1), lineNumber)
      : parseScalar(value, lineNumber);
  }

  return root;
};
