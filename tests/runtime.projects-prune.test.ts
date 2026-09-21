/**
 * Matrix 10–13 — prune, the only thing in this system that deletes a project's central state.
 *
 * Three properties, and each one is a way the wrong project gets deleted:
 *
 * - **It names an id, never a path.** A command that took a path would let a person standing in the
 *   wrong directory delete a neighbour's memory, which is the mistake AD-10 is about.
 * - **It refuses a project that still resolves.** AD-9 asks for prune so that state *orphaned* by a
 *   deleted project directory can be removed, and a project whose repository is sitting right there is
 *   precisely not orphaned. The deletion is unrecoverable, so the default is the safe one.
 * - **It removes exactly one project.** Everything else in `ORCH_HOME/projects/` survives byte for
 *   byte, which is asserted by comparing bytes rather than by counting directories.
 */
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { USAGE, parseInitArguments } from '../src/installer/index.js';
import {
  UnsafePathSegmentError,
  projectDir,
  projectsDir,
  pruneProject,
  registerProject,
  resolveProject,
} from '../src/runtime/index.js';
import { makeRepository } from './helpers/installer-fixture.js';

const disposable: string[] = [];

afterAll(() => {
  for (const path of disposable.splice(0)) rmSync(path, { recursive: true, force: true });
});

const scratch = (prefix: string): string => {
  const created = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  disposable.push(created);
  return created;
};

const home = (): string => scratch('orch-prune-home-');

/** A repository whose first commit is its own: see the fixture note in `runtime.projects.test.ts`. */
const repository = (): string => {
  const created = makeRepository({ files: { 'PROJECT-ID.txt': `${randomUUID()}\n` } });
  disposable.push(created);
  return created;
};

const AT = new Date('2026-09-21T09:00:00.000Z');
const LATER = new Date('2026-09-22T11:30:00.000Z');

/** Every file under `projects/`, as path-to-contents, so "survived" can mean byte for byte. */
const centralState = (orchHome: string): ReadonlyMap<string, string> => {
  const found = new Map<string, string>();
  const walk = (directory: string, prefix: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true, encoding: 'utf8' })) {
      const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) {
        walk(join(directory, entry.name), relative);
        continue;
      }
      found.set(relative, readFileSync(join(directory, entry.name), 'utf8'));
    }
  };
  if (existsSync(projectsDir(orchHome))) walk(projectsDir(orchHome), '');
  return found;
};

/**
 * A project whose repository is gone, with something beside its registration.
 *
 * The extra file stands in for the per-project ledger and memory stories 5-1 and on put in this same
 * directory: prune removes a project's *central state*, and a prune that removed only the record it
 * knows about would leave the thing that actually matters behind.
 */
const orphanedProject = (orchHome: string): { readonly projectId: string; readonly repo: string } => {
  const repo = repository();
  const registered = registerProject(repo, { orchHome, now: AT });
  writeFileSync(join(projectDir(registered.projectId, orchHome), 'ledger.jsonl'), '{}\n', 'utf8');
  rmSync(repo, { recursive: true, force: true });
  return { projectId: registered.projectId, repo };
};

describe('matrix 10 — pruning an unlocated project removes its central state and reports it', () => {
  it('removes the whole directory and names every file it removed', () => {
    const orchHome = home();
    const { projectId } = orphanedProject(orchHome);

    const outcome = pruneProject(projectId, { orchHome, now: LATER });

    expect(outcome.kind).toBe('pruned');
    expect(outcome).toMatchObject({ removed: ['ledger.jsonl', 'registration.json'] });
    expect(outcome.summary).toContain(projectId);
    expect(existsSync(projectDir(projectId, orchHome))).toBe(false);
    expect(resolveProject(projectId, { orchHome }).kind).toBe('unregistered');
  });

  it('prunes a project that has not been resolved since its repository went, without being told', () => {
    const orchHome = home();
    const repo = repository();
    const registered = registerProject(repo, { orchHome, now: AT });
    rmSync(repo, { recursive: true, force: true });

    // The record still says `located` — nothing has looked since. Prune verifies for itself rather
    // than trusting the mark, which is the same rule resolution obeys about the pointer.
    const outcome = pruneProject(registered.projectId, { orchHome, now: LATER });

    expect(outcome.kind).toBe('pruned');
  });
});

describe('matrix 11 — a project that still resolves is refused, not pruned', () => {
  it('refuses, names the located path, and removes nothing', () => {
    const orchHome = home();
    const repo = repository();
    const registered = registerProject(repo, { orchHome, now: AT });
    const before = centralState(orchHome);

    const outcome = pruneProject(registered.projectId, { orchHome, now: LATER });

    expect(outcome).toMatchObject({ kind: 'refused', locatedPath: repo });
    expect(outcome.summary).toContain(repo);
    // "Orphaned" is what prune is for, and a living project is precisely not that.
    expect(outcome.summary).toContain('AD-9');
    expect(centralState(orchHome)).toStrictEqual(before);
  });

  it('says how to mean it anyway, and --force then removes it', () => {
    const orchHome = home();
    const repo = repository();
    const registered = registerProject(repo, { orchHome, now: AT });

    const refused = pruneProject(registered.projectId, { orchHome, now: LATER });
    expect(refused.summary).toContain('--force');

    const forced = pruneProject(registered.projectId, { orchHome, now: LATER, force: true });

    expect(forced.kind).toBe('pruned');
    expect(existsSync(projectDir(registered.projectId, orchHome))).toBe(false);
    // The repository itself is untouched: prune deletes central state and nothing inside a project.
    expect(existsSync(join(repo, '.git'))).toBe(true);
  });

  it('is refused by default, so nothing but an explicit flag can delete a living project', () => {
    const orchHome = home();
    const repo = repository();
    const registered = registerProject(repo, { orchHome, now: AT });

    // The default is the answer to the question AD-9 asked; `force` is opt-in and off.
    expect(pruneProject(registered.projectId, { orchHome }).kind).toBe('refused');
    expect(pruneProject(registered.projectId, { orchHome, force: false }).kind).toBe('refused');
    expect(existsSync(projectDir(registered.projectId, orchHome))).toBe(true);
  });
});

describe('matrix 12 — pruning an id that was never registered says so and removes nothing', () => {
  it('reports it and creates nothing in its name', () => {
    const orchHome = home();
    const unknown = 'c'.repeat(40);

    const outcome = pruneProject(unknown, { orchHome, now: AT });

    expect(outcome).toMatchObject({ kind: 'unregistered', projectId: unknown });
    expect(outcome.summary).toContain('nothing was removed');
    expect(existsSync(projectDir(unknown, orchHome))).toBe(false);
  });
});

describe('matrix 13 — prune removes exactly the project it was named', () => {
  it('leaves every other record byte-identical', () => {
    const orchHome = home();
    const keptOne = registerProject(repository(), { orchHome, now: AT });
    const keptTwo = registerProject(repository(), { orchHome, now: AT });
    const doomed = orphanedProject(orchHome);
    const before = centralState(orchHome);

    pruneProject(doomed.projectId, { orchHome, now: LATER });

    const after = centralState(orchHome);
    for (const [path, contents] of before) {
      if (path.startsWith(`${doomed.projectId}/`)) {
        expect(after.has(path), path).toBe(false);
        continue;
      }
      expect(after.get(path), path).toBe(contents);
    }
    expect(readdirSync(projectsDir(orchHome)).sort()).toStrictEqual(
      [keptOne.projectId, keptTwo.projectId].sort(),
    );
  });
});

describe('prune takes a project id and never a path', () => {
  it('refuses a path by name rather than operating on something', () => {
    const orchHome = home();
    const repo = repository();
    registerProject(repo, { orchHome, now: AT });

    // The repository's own path, which is exactly what a person standing in it would reach for.
    expect(() => pruneProject(repo, { orchHome })).toThrow(UnsafePathSegmentError);
    expect(() => pruneProject('..', { orchHome })).toThrow(UnsafePathSegmentError);
    expect(centralState(orchHome).size).toBe(1);
  });

  it('is parsed as a command that requires one, and takes --force only there', () => {
    const id = 'd'.repeat(40);
    expect(parseInitArguments(['prune', id])).toMatchObject({
      kind: 'prune',
      projectId: id,
      force: false,
      error: null,
    });
    expect(parseInitArguments(['prune', id, '--force'])).toMatchObject({ kind: 'prune', force: true });

    // No id: a usage error rather than a prune of whatever the shell is sitting in.
    expect(parseInitArguments(['prune']).kind).toBe('help');
    expect(parseInitArguments(['prune']).error).toContain('project id');
    expect(parseInitArguments(['prune', id, 'again']).error).toContain('exactly one project id');
    // And `--force` is a flag of this command only: accepting it silently elsewhere is how a person
    // comes to believe they forced something.
    expect(parseInitArguments(['init', '--force']).error).toContain('--force');
  });

  it('is documented in the usage text as taking an id, with what refusing means', () => {
    expect(USAGE).toContain('prune <project-id>');
    expect(USAGE).toContain('--force');
    expect(USAGE).toContain('AD-9');
  });
});
