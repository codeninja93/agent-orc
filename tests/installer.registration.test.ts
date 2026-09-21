/**
 * Matrix 16 — a completed install registers the project it just configured, through the installer's
 * own path.
 *
 * The property is not "registration happened" but "the two agree": the id story 2-1 confirms into
 * `<target-repo>/.orch/profile.toml` is the id the central record is keyed by. They are written by
 * different units into different scopes (AD-34), and the failure they would otherwise have is silent —
 * one repository becoming two projects, one of which has all the memory and neither of which is
 * obviously wrong.
 */
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { ProfileSchema } from '../src/contracts/index.js';
import { InstallRefusal, parseToml, runInit } from '../src/installer/index.js';
import { projectsDir, readProjectRegistration, resolveProject } from '../src/runtime/index.js';
import { makeRepository, readTree, scriptedIo } from './helpers/installer-fixture.js';

const disposable: string[] = [];

afterAll(() => {
  for (const path of disposable.splice(0)) rmSync(path, { recursive: true, force: true });
});

const scratch = (prefix: string): string => {
  const created = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  disposable.push(created);
  return created;
};

const home = (): string => scratch('orch-install-home-');

/** A repository whose first commit is its own: see the fixture note in `runtime.projects.test.ts`. */
const repository = (): string => {
  const created = makeRepository({ files: { 'PROJECT-ID.txt': `${randomUUID()}\n` } });
  disposable.push(created);
  return created;
};

const FIRST_RUN_AT = new Date('2026-09-21T09:00:00.000Z');
const SECOND_RUN_AT = new Date('2026-09-22T11:30:00.000Z');

const profileProjectId = (repo: string): string =>
  ProfileSchema.parse(parseToml(readFileSync(join(repo, '.orch', 'profile.toml'), 'utf8'))).project.id;

describe('a completed install registers the project it configured (matrix 16)', () => {
  it('writes a central record whose id is the id in .orch/profile.toml', async () => {
    const orchHome = home();
    const repo = repository();

    const outcome = await runInit({
      repository: repo,
      io: scriptedIo(),
      now: FIRST_RUN_AT,
      orchHome,
    });

    expect(outcome.registration.disposition).toBe('created');
    const record = readProjectRegistration(outcome.projectId, { orchHome });
    expect(record).not.toBeNull();
    expect(record?.project_id).toBe(profileProjectId(repo));
    expect(record?.path).toBe(repo);
    // And the central record resolves back to the repository that was just installed into.
    expect(resolveProject(outcome.projectId, { orchHome })).toMatchObject({
      kind: 'located',
      path: repo,
    });
  });

  it('says so in the one line it prints, because the record is not in the repository', async () => {
    const orchHome = home();
    const repo = repository();

    const outcome = await runInit({ repository: repo, io: scriptedIo(), now: FIRST_RUN_AT, orchHome });

    expect(outcome.summary).toContain(outcome.projectId);
    expect(outcome.summary).toContain('registered');
  });

  it('registers into the AD-9 ORCH_HOME when the caller names none', async () => {
    const orchHome = home();
    const repo = repository();
    const before = process.env['ORCH_HOME'];
    process.env['ORCH_HOME'] = orchHome;
    try {
      const outcome = await runInit({ repository: repo, io: scriptedIo(), now: FIRST_RUN_AT });
      expect(readProjectRegistration(outcome.projectId, { orchHome })?.path).toBe(repo);
    } finally {
      if (before === undefined) delete process.env['ORCH_HOME'];
      else process.env['ORCH_HOME'] = before;
    }
  });
});

describe('registration is idempotent along with everything else a re-run guarantees', () => {
  it('re-registers the same project rather than creating a second one', async () => {
    const orchHome = home();
    const repo = repository();

    const first = await runInit({ repository: repo, io: scriptedIo(), now: FIRST_RUN_AT, orchHome });
    const firstRecord = readProjectRegistration(first.projectId, { orchHome });
    const second = await runInit({ repository: repo, io: scriptedIo(), now: SECOND_RUN_AT, orchHome });

    expect(second.asked).toStrictEqual([]);
    expect(second.registration.disposition).toBe('refreshed');
    expect(readdirSync(projectsDir(orchHome))).toStrictEqual([first.projectId]);
    const secondRecord = readProjectRegistration(second.projectId, { orchHome });
    // Only its own timestamp moved: the project was first registered when it was first registered.
    expect(secondRecord?.first_registered_at).toBe(firstRecord?.first_registered_at);
    expect(secondRecord?.last_registered_at).toBe(SECOND_RUN_AT.toISOString());
  });

  it('moves the pointer when the repository moved, rather than onboarding a second project', async () => {
    const orchHome = home();
    const repo = repository();
    const first = await runInit({ repository: repo, io: scriptedIo(), now: FIRST_RUN_AT, orchHome });

    const moved = join(scratch('orch-install-moved-'), 'project');
    renameSync(repo, moved);
    const second = await runInit({ repository: moved, io: scriptedIo(), now: SECOND_RUN_AT, orchHome });

    expect(second.projectId).toBe(first.projectId);
    expect(second.registration.disposition).toBe('pointer_updated');
    expect(readdirSync(projectsDir(orchHome))).toStrictEqual([first.projectId]);
    expect(readProjectRegistration(first.projectId, { orchHome })?.path).toBe(moved);
  });
});

describe('the id in .orch/ and the id of the central record cannot disagree', () => {
  it('refuses a confirmed id that is not this repository’s first commit, before writing anything', async () => {
    const orchHome = home();
    const repo = repository();
    const before = readTree(repo);

    await expect(
      runInit({
        repository: repo,
        // Forty hexadecimal characters, which question 2 accepts as *shaped* like a SHA — and which
        // is not this repository's first commit, so it would key the wrong central record.
        io: scriptedIo({ 'project.id': 'f'.repeat(40) }),
        now: FIRST_RUN_AT,
        orchHome,
      }),
    ).rejects.toThrow(InstallRefusal);

    expect(existsSync(join(repo, '.orch'))).toBe(false);
    expect(readTree(repo)).toStrictEqual(before);
    expect(existsSync(projectsDir(orchHome))).toBe(false);
  });
});
