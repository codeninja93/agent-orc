/**
 * The TOML subset, re-exported from where it now lives.
 *
 * Story 2-1 implemented the codec here because the installer was its only reader. Story 2-3 made the
 * engine read the same bytes — `profile.toml` and `agents/*.toml` — and the spine's dependency graph
 * draws no edge from `src/engine/` to `src/installer/`, so the implementation moved to
 * `src/contracts/toml.ts`, the one layer both units may depend on.
 *
 * This file stays as the re-export rather than being deleted, because the installer's own modules and
 * suites name `./toml.js` and `src/installer/index.js` exports it: a second spelling of the *module*
 * is harmless, while a second implementation of the *parser* is the thing that must never exist.
 */
export * from '../contracts/toml.js';
