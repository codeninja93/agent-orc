/**
 * Matrix 1–9 and 15 — registering a project, moving its pointer, and resolving it by *verifying* that
 * pointer rather than trusting it.
 *
 * Against real git repositories throughout, because a first-commit SHA is not a fixture: it is what git
 * computes from a tree, an author, a message and a second of wall-clock time, and every property here —
 * that a move keeps one id, that a clone shares one, that a rewritten root commit is a different project
 * — is a property of that computation and not of a string a test made up.
 *
 * Which is also why the fixture plants a unique file in every repository, and why the first test in this
 * file measures that it worked. Two repositories built in the same second from the same tree with the
 * same message and the same author have the *same* first-commit SHA, and a "different repository" test
 * standing on colliding ids would pass while asserting nothing.
 */
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, describe, expect, it } from 'vitest';

import { CURRENT_SCHEMA_VERSION, SchemaVersionRefusal } from '../src/contracts/index.js';
import {
  ForeignProjectRegistration,
  ProjectIdentityMismatch,
  ProjectIdentityUnavailable,
  UnsafePathSegmentError,
  firstCommitSha,
  projectDir,
  projectRegistrationPath,
  projectsDir,
  readProjectRegistration,
  registerProject,
  resolveProject,
} from '../src/runtime/index.js';
import type { ProjectRegistration } from '../src/contracts/index.js';
import { git, makeRepository } from './helpers/installer-fixture.js';

const disposable: string[] = [];

afterAll(() => {
  for (const path of disposable.splice(0)) rmSync(path, { recursive: true, force: true });
});

/**
 * A scratch directory, resolved through `realpathSync`.
 *
 * The resolution is not tidiness: on macOS `tmpdir()` is a symlink, and every path this module records
 * comes back from git already resolved. A fixture comparing an unresolved path against a resolved one
 * measures the symlink and calls it a moved project.
 */
const scratch = (prefix: string): string => {
  const created = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  disposable.push(created);
  return created;
};

const home = (): string => scratch('orch-projects-home-');

/**
 * A repository with a history of its own.
 *
 * The planted file is what makes the first commit unique: without it two repositories created in the
 * same second are byte-identical inputs to git's hash and come back with one id between them.
 */
const repository = (): string => {
  const created = makeRepository({ files: { 'PROJECT-ID.txt': `${randomUUID()}\n` } });
  disposable.push(created);
  return created;
};

const AT = new Date('2026-09-21T09:00:00.000Z');
const LATER = new Date('2026-09-22T11:30:00.000Z');
const LATER_STILL = new Date('2026-09-23T08:15:00.000Z');

/** The record as it is on disk, read as bytes rather than as whatever the API last returned. */
const recordOnDisk = (projectId: string, orchHome: string): ProjectRegistration =>
  JSON.parse(readFileSync(projectRegistrationPath(projectId, orchHome), 'utf8')) as ProjectRegistration;

const registeredProjectIds = (orchHome: string): readonly string[] =>
  existsSync(projectsDir(orchHome)) ? readdirSync(projectsDir(orchHome)).sort() : [];

describe('the fixture gives every repository a history of its own', () => {
  it('builds two repositories with different first commits, so a comparison compares something', () => {
    const one = repository();
    const other = repository();
    expect(firstCommitSha(one)).not.toBeNull();
    expect(firstCommitSha(one)).not.toBe(firstCommitSha(other));
  });
});

describe('a project is registered under the SHA of its first commit (matrix 1)', () => {
  it('writes a record carrying the id, the path and a schema_version', () => {
    const orchHome = home();
    const repo = repository();

    const registered = registerProject(repo, { orchHome, now: AT });

    expect(registered.projectId).toBe(firstCommitSha(repo));
    expect(registered.disposition).toBe('created');
    const record = recordOnDisk(registered.projectId, orchHome);
    expect(record.project_id).toBe(registered.projectId);
    expect(record.path).toBe(repo);
    expect(record.schema_version).toBe(CURRENT_SCHEMA_VERSION);
    expect(record.location).toBe('located');
    expect(record.first_registered_at).toBe(AT.toISOString());
  });

  it('computes the id from the repository rather than taking one from the caller', () => {
    const orchHome = home();
    const repo = repository();
    const sha = firstCommitSha(repo);

    const registered = registerProject(repo, { orchHome, now: AT, expectedProjectId: sha ?? '' });
    expect(registered.projectId).toBe(sha);

    // A caller that believes something else about this repository is refused, not obeyed: the record
    // would otherwise key this repository to a project it is not (AD-10).
    expect(() =>
      registerProject(repo, { orchHome, now: AT, expectedProjectId: 'f'.repeat(40) }),
    ).toThrow(ProjectIdentityMismatch);
    expect(registeredProjectIds(orchHome)).toStrictEqual([sha]);
  });

  it('refuses a repository with no commits, naming why, and writes nothing (matrix 4)', () => {
    const orchHome = home();
    const empty = makeRepository({ commit: false });
    disposable.push(empty);

    let thrown: unknown = null;
    try {
      registerProject(empty, { orchHome, now: AT });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ProjectIdentityUnavailable);
    expect((thrown as ProjectIdentityUnavailable).reason).toBe('no-commits');
    expect((thrown as ProjectIdentityUnavailable).code).toBe('config.invalid');
    expect((thrown as ProjectIdentityUnavailable).message).toContain('AD-10');
    expect(registeredProjectIds(orchHome)).toStrictEqual([]);
  });

  it('refuses a directory that is not a repository at all, and writes nothing', () => {
    const orchHome = home();
    const directory = scratch('orch-not-a-repo-');

    let thrown: unknown = null;
    try {
      registerProject(directory, { orchHome, now: AT });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ProjectIdentityUnavailable);
    expect((thrown as ProjectIdentityUnavailable).reason).toBe('not-a-repository');
    expect(registeredProjectIds(orchHome)).toStrictEqual([]);
  });

  it('registers the repository root when it is handed a directory inside one', () => {
    const orchHome = home();
    const repo = repository();

    const registered = registerProject(join(repo, 'src'), { orchHome, now: AT });

    // AD-9 puts `.orch/` at the root, so the root is the only pointer a resolved project is usable from.
    expect(registered.path).toBe(repo);
    expect(recordOnDisk(registered.projectId, orchHome).path).toBe(repo);
  });
});

describe('the recorded path is a pointer the record corrects (matrix 2, 3)', () => {
  it('changes nothing but its own timestamp when the same path registers again', () => {
    const orchHome = home();
    const repo = repository();

    const first = registerProject(repo, { orchHome, now: AT });
    const before = recordOnDisk(first.projectId, orchHome);

    const again = registerProject(repo, { orchHome, now: LATER });

    expect(again.disposition).toBe('refreshed');
    const after = recordOnDisk(first.projectId, orchHome);
    expect(after.last_registered_at).toBe(LATER.toISOString());
    const { last_registered_at: _beforeStamp, ...beforeRest } = before;
    const { last_registered_at: _afterStamp, ...afterRest } = after;
    expect(afterRest).toStrictEqual(beforeRest);
  });

  it('moves the pointer and keeps the id and everything else when the repository moves', () => {
    const orchHome = home();
    const repo = repository();
    const registered = registerProject(repo, { orchHome, now: AT });
    const before = recordOnDisk(registered.projectId, orchHome);

    const moved = join(scratch('orch-moved-'), 'project');
    renameSync(repo, moved);

    const again = registerProject(moved, { orchHome, now: LATER });

    expect(again.disposition).toBe('pointer_updated');
    expect(again.previousPath).toBe(repo);
    expect(again.projectId).toBe(registered.projectId);
    const after = recordOnDisk(registered.projectId, orchHome);
    expect(after.path).toBe(moved);
    expect(after.project_id).toBe(before.project_id);
    // The record is not rebuilt: a project that moved is the project that moved, so what it had
    // accumulated — starting with when it was first registered — survives the move.
    expect(after.first_registered_at).toBe(before.first_registered_at);
  });

  it('reattaches a moved repository to one record rather than making a second project (AD-33)', () => {
    const orchHome = home();
    const repo = repository();
    const registered = registerProject(repo, { orchHome, now: AT });

    const moved = join(scratch('orch-moved-'), 'project');
    renameSync(repo, moved);
    registerProject(moved, { orchHome, now: LATER });

    expect(registeredProjectIds(orchHome)).toStrictEqual([registered.projectId]);
    expect(resolveProject(registered.projectId, { orchHome })).toMatchObject({
      kind: 'located',
      path: moved,
    });
  });

  it('clears an earlier unlocated mark when the project is registered again', () => {
    const orchHome = home();
    const repo = repository();
    const registered = registerProject(repo, { orchHome, now: AT });

    const moved = join(scratch('orch-moved-'), 'project');
    renameSync(repo, moved);
    expect(resolveProject(registered.projectId, { orchHome, now: LATER }).kind).toBe('unlocated');

    registerProject(moved, { orchHome, now: LATER_STILL });

    const record = recordOnDisk(registered.projectId, orchHome);
    expect(record.location).toBe('located');
    expect(record.unlocated_since).toBeNull();
  });
});

describe('resolution verifies the pointer and marks it unlocated otherwise (matrix 5, 6, 7)', () => {
  it('resolves a registered project to the repository it points at', () => {
    const orchHome = home();
    const repo = repository();
    const registered = registerProject(repo, { orchHome, now: AT });

    const resolution = resolveProject(registered.projectId, { orchHome, now: LATER });

    expect(resolution.kind).toBe('located');
    expect(resolution).toMatchObject({ path: repo, projectId: registered.projectId });
  });

  it('marks the registration unlocated rather than deleting it when the path is gone (matrix 5)', () => {
    const orchHome = home();
    const repo = repository();
    const registered = registerProject(repo, { orchHome, now: AT });
    rmSync(repo, { recursive: true, force: true });

    const resolution = resolveProject(registered.projectId, { orchHome, now: LATER });

    expect(resolution).toMatchObject({ kind: 'unlocated', reason: 'path_absent' });
    // The record survives, whole, with its pointer intact: AD-33 — the absence of a path is not
    // abandonment, and what is at stake is this project's accumulated memory.
    expect(existsSync(projectDir(registered.projectId, orchHome))).toBe(true);
    const record = recordOnDisk(registered.projectId, orchHome);
    expect(record.project_id).toBe(registered.projectId);
    expect(record.path).toBe(repo);
    expect(record.first_registered_at).toBe(AT.toISOString());
    expect(record.location).toBe('unlocated');
    expect(record.unlocated_since).toBe(LATER.toISOString());
    expect(registeredProjectIds(orchHome)).toStrictEqual([registered.projectId]);
  });

  it('keeps the first sighting when an unlocated project is resolved again', () => {
    const orchHome = home();
    const repo = repository();
    const registered = registerProject(repo, { orchHome, now: AT });
    rmSync(repo, { recursive: true, force: true });

    resolveProject(registered.projectId, { orchHome, now: LATER });
    const second = resolveProject(registered.projectId, { orchHome, now: LATER_STILL });

    expect(second).toMatchObject({ unlocatedSince: LATER.toISOString() });
    expect(recordOnDisk(registered.projectId, orchHome).unlocated_since).toBe(LATER.toISOString());
  });

  /**
   * The dangerous stale pointer, and the reason existence is not verification.
   *
   * A directory that is gone fails loudly. A directory that now holds *another* repository resolves
   * perfectly well — and following it reads one project's central record against another project's
   * code, silently. So the id at the pointed path is read and compared, and the result of the
   * comparison is the only thing that makes a pointer live.
   */
  it('marks it unlocated when the path now holds a different repository (matrix 6)', () => {
    const orchHome = home();
    const repo = repository();
    const registered = registerProject(repo, { orchHome, now: AT });

    const intruder = repository();
    const intruderId = firstCommitSha(intruder);
    rmSync(repo, { recursive: true, force: true });
    renameSync(intruder, repo);

    const resolution = resolveProject(registered.projectId, { orchHome, now: LATER });

    expect(resolution).toMatchObject({ kind: 'unlocated', reason: 'different_repository' });
    expect(resolution).toMatchObject({ foundProjectId: intruderId });
    expect(recordOnDisk(registered.projectId, orchHome).location).toBe('unlocated');
  });

  it('never hands back the other repository’s path, in any field of the result (matrix 6)', () => {
    const orchHome = home();
    const repo = repository();
    const registered = registerProject(repo, { orchHome, now: AT });

    const intruder = repository();
    rmSync(repo, { recursive: true, force: true });
    renameSync(intruder, repo);

    const resolution = resolveProject(registered.projectId, { orchHome, now: LATER });

    // Not "the `path` field is absent" but "the path is nowhere in what came back": a caller reaching
    // for any field of this value must not end up with a directory that belongs to another project.
    expect(JSON.stringify(resolution)).not.toContain(repo);
    expect(resolution).not.toHaveProperty('path');
    expect(resolution).not.toHaveProperty('registration');
  });

  it('says so and creates nothing when the id was never registered (matrix 7)', () => {
    const orchHome = home();
    const unknown = 'a'.repeat(40);

    const resolution = resolveProject(unknown, { orchHome, now: AT });

    expect(resolution).toMatchObject({ kind: 'unregistered', projectId: unknown });
    expect(existsSync(projectDir(unknown, orchHome))).toBe(false);
    expect(registeredProjectIds(orchHome)).toStrictEqual([]);
  });

  it('refuses a filesystem path handed in where a project id belongs', () => {
    const orchHome = home();
    expect(() => resolveProject('/Users/someone/code/project', { orchHome })).toThrow(
      UnsafePathSegmentError,
    );
    expect(() => resolveProject('../../etc', { orchHome })).toThrow(UnsafePathSegmentError);
  });

  it('resolves again once the repository is back where the record points', () => {
    const orchHome = home();
    const repo = repository();
    const registered = registerProject(repo, { orchHome, now: AT });
    const stashed = join(scratch('orch-stash-'), 'project');
    renameSync(repo, stashed);
    expect(resolveProject(registered.projectId, { orchHome, now: LATER }).kind).toBe('unlocated');

    renameSync(stashed, repo);
    const resolution = resolveProject(registered.projectId, { orchHome, now: LATER_STILL });

    expect(resolution).toMatchObject({ kind: 'located', path: repo });
    // The mark records what the pointer *is*, so a verification that succeeds clears it.
    const record = recordOnDisk(registered.projectId, orchHome);
    expect(record.location).toBe('located');
    expect(record.unlocated_since).toBeNull();
  });
});

describe('matrix 8 — a rewritten root commit is a different project', () => {
  it('registers under a new id and leaves the old record untouched and unlocated', () => {
    const orchHome = home();
    const repo = repository();
    const before = registerProject(repo, { orchHome, now: AT });
    const oldRecord = recordOnDisk(before.projectId, orchHome);

    // The root commit itself is rewritten, which is what a history rewrite does to a project's identity.
    git(repo, ['commit', '--amend', '-m', 'rewritten root']);
    const after = firstCommitSha(repo);
    expect(after).not.toBe(before.projectId);

    const reregistered = registerProject(repo, { orchHome, now: LATER });

    expect(reregistered.projectId).toBe(after);
    expect(reregistered.disposition).toBe('created');
    expect(registeredProjectIds(orchHome).length).toBe(2);
    // The old project is not deleted, not merged and not migrated: it is a project whose repository
    // can no longer be found, which is exactly what `unlocated` says.
    const resolution = resolveProject(before.projectId, { orchHome, now: LATER_STILL });
    expect(resolution).toMatchObject({ kind: 'unlocated', reason: 'different_repository' });
    const stillThere = recordOnDisk(before.projectId, orchHome);
    expect(stillThere.project_id).toBe(oldRecord.project_id);
    expect(stillThere.path).toBe(oldRecord.path);
    expect(stillThere.first_registered_at).toBe(oldRecord.first_registered_at);
  });
});

describe('matrix 9 — two checkouts of one repository are one project', () => {
  it('keeps one record, points it at the most recent, and resolves both to it', () => {
    const orchHome = home();
    const original = repository();
    const clone = join(scratch('orch-clone-'), 'checkout');
    git(original, ['clone', '--quiet', original, clone]);

    const first = registerProject(original, { orchHome, now: AT });
    const second = registerProject(clone, { orchHome, now: LATER });

    // AD-10 makes them one project: a clone shares its first commit, so it shares its id.
    expect(second.projectId).toBe(first.projectId);
    expect(registeredProjectIds(orchHome)).toStrictEqual([first.projectId]);
    // The record holds one pointer, so the last registration wins. That is the named consequence of
    // AD-10, not a defect: holding two paths would be two answers to "where is this project".
    expect(second.disposition).toBe('pointer_updated');
    expect(resolveProject(first.projectId, { orchHome })).toMatchObject({
      kind: 'located',
      path: clone,
    });
    // And registering the original again moves it back, which is the same mechanism and not a repair.
    expect(registerProject(original, { orchHome, now: LATER_STILL }).path).toBe(original);
  });
});

describe('the record is read through the AD-28 gate', () => {
  it('refuses an unrecognised schema_version carrying config.schema_version_unrecognised (matrix 14)', () => {
    const orchHome = home();
    const repo = repository();
    const registered = registerProject(repo, { orchHome, now: AT });
    const path = projectRegistrationPath(registered.projectId, orchHome);
    const future = { ...recordOnDisk(registered.projectId, orchHome), schema_version: 99 };
    writeFileSync(path, `${JSON.stringify(future, null, 2)}\n`, 'utf8');

    let thrown: unknown = null;
    try {
      readProjectRegistration(registered.projectId, { orchHome });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(SchemaVersionRefusal);
    expect((thrown as SchemaVersionRefusal).code).toBe('config.schema_version_unrecognised');
    // The advice a person can act on, which is the half a "malformed file" message loses.
    expect((thrown as SchemaVersionRefusal).message).toContain('Re-run the installer');
    // And every entry point meets the same refusal, rather than resolution reading it as current.
    expect(() => resolveProject(registered.projectId, { orchHome })).toThrow(SchemaVersionRefusal);
  });

  it('refuses a record found under one project that says it belongs to another', () => {
    const orchHome = home();
    const repo = repository();
    const registered = registerProject(repo, { orchHome, now: AT });
    const path = projectRegistrationPath(registered.projectId, orchHome);
    const foreign = { ...recordOnDisk(registered.projectId, orchHome), project_id: 'b'.repeat(40) };
    writeFileSync(path, `${JSON.stringify(foreign, null, 2)}\n`, 'utf8');

    expect(() => readProjectRegistration(registered.projectId, { orchHome })).toThrow(
      ForeignProjectRegistration,
    );
  });
});

/**
 * Matrix 15 — two registrations racing for one id, from separate OS processes.
 *
 * In one event loop the second create is ordered after the first by construction, so an in-process
 * test of this asserts the ordering it should be doubting. These are real children on a barrier, the
 * shape `tests/runtime.writer-claim.test.ts` established for the two write claims.
 */
describe('two registrations racing for one id leave exactly one whole record (matrix 15)', () => {
  const HELPER = fileURLToPath(new URL('helpers/register-race.ts', import.meta.url));
  const JITI = fileURLToPath(new URL('../node_modules/jiti/lib/jiti-register.mjs', import.meta.url));
  const CONTENDERS = 4;
  const ROUNDS = 5;

  interface Report {
    readonly round: number;
    readonly pid: number;
    readonly disposition: string;
    readonly projectId: string;
    readonly path: string;
  }

  interface Handle {
    readonly child: ChildProcess;
    readonly exited: Promise<unknown>;
    readonly out: () => { readonly stdout: string; readonly stderr: string };
  }

  it(
    'has exactly one creator per project, and every contender reads a record it can parse',
    async () => {
      const orchHome = home();
      const reposRoot = scratch('orch-race-repos-');
      const barrierDir = scratch('orch-race-barrier-');
      const barrier = join(barrierDir, 'barrier');

      const expectedIds: string[] = [];
      for (let round = 0; round < ROUNDS; round += 1) {
        const built = repository();
        const target = join(reposRoot, `round-${String(round)}`);
        renameSync(built, target);
        const id = firstCommitSha(target);
        expect(id).not.toBeNull();
        expectedIds.push(id ?? '');
      }

      const children: ChildProcess[] = [];
      const handles: Handle[] = Array.from({ length: CONTENDERS }, () => {
        const child = spawn(
          process.execPath,
          ['--import', JITI, HELPER, orchHome, reposRoot, barrier, String(ROUNDS)],
          { stdio: ['ignore', 'pipe', 'pipe'] },
        );
        children.push(child);
        // Attached before the child can exit: `once` on an event that has been and gone waits for ever.
        const exited = once(child, 'exit');
        let stdout = '';
        let stderr = '';
        child.stdout?.on('data', (chunk: Buffer) => {
          stdout += chunk.toString('utf8');
        });
        child.stderr?.on('data', (chunk: Buffer) => {
          stderr += chunk.toString('utf8');
        });
        return { child, exited, out: () => ({ stdout, stderr }) };
      });

      try {
        for (let round = 0; round < ROUNDS; round += 1) {
          const prefix = `barrier.ready.${String(round)}.`;
          const deadline = Date.now() + 120_000;
          for (;;) {
            const ready = readdirSync(barrierDir).filter((name) => name.startsWith(prefix)).length;
            if (ready >= handles.length) break;
            for (const handle of handles) {
              if (handle.child.exitCode !== null || handle.child.signalCode !== null) {
                throw new Error(
                  `a contender exited (code ${String(handle.child.exitCode)}) before round ` +
                    `${String(round)}: ${handle.out().stderr}`,
                );
              }
            }
            if (Date.now() > deadline) {
              throw new Error(`not every contender reached the barrier for round ${String(round)}`);
            }
            await new Promise((resolve) => setTimeout(resolve, 5));
          }
          // Every child is inside its spin loop. This is the starting gun.
          writeFileSync(`${barrier}.go.${String(round)}`, 'go\n', 'utf8');
        }

        await Promise.all(handles.map((handle) => handle.exited));

        const reports = handles.flatMap((handle): readonly Report[] => {
          if (handle.child.exitCode !== 0) {
            throw new Error(
              `a contender exited ${String(handle.child.exitCode)}: ${handle.out().stderr}`,
            );
          }
          return handle
            .out()
            .stdout.trim()
            .split('\n')
            .filter((line) => line !== '')
            .map((line) => JSON.parse(line) as Report);
        });

        expect(reports).toHaveLength(CONTENDERS * ROUNDS);
        for (let round = 0; round < ROUNDS; round += 1) {
          const forRound = reports.filter((report) => report.round === round);
          expect(forRound).toHaveLength(CONTENDERS);
          // Exactly one creator: the exclusive create is what decides, and it decides once.
          expect(forRound.filter((report) => report.disposition === 'created')).toHaveLength(1);
          expect(new Set(forRound.map((report) => report.projectId)).size).toBe(1);
          expect(forRound[0]?.projectId).toBe(expectedIds[round]);
        }

        // One record per project, and each one whole: a contender that read a torn record would have
        // exited non-zero above rather than reporting a round at all.
        expect(registeredProjectIds(orchHome)).toStrictEqual([...expectedIds].sort());
        for (const id of expectedIds) {
          const record = recordOnDisk(id, orchHome);
          expect(record.project_id).toBe(id);
          expect(record.location).toBe('located');
          expect(readdirSync(projectDir(id, orchHome))).toStrictEqual(['registration.json']);
        }
      } finally {
        for (const child of children) {
          if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        }
      }
    },
    180_000,
  );
});
