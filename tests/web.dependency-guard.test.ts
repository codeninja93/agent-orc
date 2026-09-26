/**
 * `src/web/` follows the dependency rule `src/tui/`'s own header states for a renderer, extended to
 * the one thing this story's web surface is built to reuse: `src/tui/` itself.
 *
 * Mirrors `tests/tui.projection.test.ts`'s own guard, scanning `src/web/` instead: every source file's
 * imports are read as text (a renderer may not import `src/engine/`, and every bare-package import must
 * be declared), and every relative import must resolve inside `src/web/`, `src/tui/`, `src/contracts/`
 * or `src/runtime/`.
 *
 * Unlike the TUI's own guard, this one does **not** forbid `node:fs` outright: `src/tui/` is a pure
 * projection that reaches no file directly, but this story's server legitimately reads the static page
 * and checks whether a run directory exists (matrix row 7) — reads, never writes. What AD-19 actually
 * forbids is a *second write path*, so this guard instead asserts that no file under `src/web/` calls
 * `writeFileSync`, `appendFileSync` or `renameSync` — every durable write still goes through
 * `invokeControlByKey`, in `src/tui/controls.ts`, which calls `src/runtime/commands.ts`'s
 * `writeCommandIntent`.
 */
import { readFileSync, readdirSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const sourceDir = new URL('../src/web/', import.meta.url);
const tuiDir = new URL('../src/tui/', import.meta.url);
const contractsDir = new URL('../src/contracts/', import.meta.url);
const runtimeDir = new URL('../src/runtime/', import.meta.url);

const listSources = (dir: URL, prefix = ''): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? listSources(new URL(`${entry.name}/`, dir), `${prefix}${entry.name}/`)
      : entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')
        ? [`${prefix}${entry.name}`]
        : [],
  );

const files = listSources(sourceDir);

/** Statement forms only, so a quoted word after "from" in prose is not read as an import. */
const IMPORT_PATTERNS = [
  /^\s*(?:import|export)\b[^'";]*\bfrom\s*['"]([^'"]+)['"]/gm,
  /^\s*import\s*['"]([^'"]+)['"]/gm,
  /\bimport\s*\(\s*['"]([^'"]+)['"]/g,
  /\brequire\s*\(\s*['"]([^'"]+)['"]/g,
];

const importsOf = (source: string): string[] =>
  IMPORT_PATTERNS.flatMap((pattern) => [...source.matchAll(pattern)].map((match) => match[1] ?? ''));

/** No HTTP framework and no bundler: every import is a relative one, `src/tui/`, or a `node:` builtin. */
const ALLOWED_PACKAGES: readonly string[] = [];

describe('src/web/ imports only contracts, runtime, tui and node: builtins', () => {
  it('has source files to inspect, and reads the imports it claims to', () => {
    expect(files.length).toBeGreaterThan(0);
    expect(files).toContain('server.ts');
    expect(files).toContain('commands.ts');
    const source = readFileSync(new URL('commands.ts', sourceDir), 'utf8');
    expect(importsOf(source)).toContain('../runtime/index.js');
    expect(importsOf(source)).toContain('../tui/index.js');
  });

  it.each(files)('%s never imports src/engine/', (file) => {
    const from = new URL(file, sourceDir);
    const source = readFileSync(from, 'utf8');
    for (const specifier of importsOf(source)) {
      expect(specifier.includes('/engine/'), `${file} imports "${specifier}"`).toBe(false);
      if (!specifier.startsWith('.')) {
        expect(
          specifier.startsWith('node:') || ALLOWED_PACKAGES.includes(specifier),
          `${file} imports "${specifier}"`,
        ).toBe(true);
        continue;
      }
      const target = new URL(specifier, from).href;
      const allowed =
        target.startsWith(sourceDir.href) ||
        target.startsWith(tuiDir.href) ||
        target.startsWith(contractsDir.href) ||
        target.startsWith(runtimeDir.href);
      expect(allowed, `${file} imports "${specifier}"`).toBe(true);
    }
  });

  it.each(files)('%s writes no file directly — every durable write goes through invokeControlByKey', (file) => {
    const source = readFileSync(new URL(file, sourceDir), 'utf8');
    for (const forbidden of ['writeFileSync', 'appendFileSync', 'renameSync']) {
      expect(source, `${file} calls ${forbidden}`).not.toContain(forbidden);
    }
  });
});
