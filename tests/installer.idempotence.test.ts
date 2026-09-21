/**
 * Matrix rows 2, 4, 9 and 10 — the re-run, the half-install and the `.gitignore` append.
 *
 * **Idempotence is asserted in bytes, not in the absence of an error.** AD-12 makes an upgrade a
 * re-run, so "it ran again and did not complain" is not the property; "the tree is what the first
 * run left, except where an answer actually changed" is. These tests compare file contents and
 * modification times, because a rewrite of identical bytes would pass the first check and fail the
 * second — and a rewrite is exactly what an idempotent installer must not do.
 */
import { appendFileSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ManifestSchema } from '../src/contracts/index.js';
import { GITIGNORE_LINES, parseToml, runInit } from '../src/installer/index.js';
import { makeRepository, readTree, scriptedIo } from './helpers/installer-fixture.js';

const disposable: string[] = [];

const repository = (options?: Parameters<typeof makeRepository>[0]): string => {
  const created = makeRepository(options);
  disposable.push(created);
  return created;
};

afterAll(() => {
  for (const path of disposable.splice(0)) rmSync(path, { recursive: true, force: true });
});

/**
 * Story 2-2 — a completed install registers the project under `ORCH_HOME` (AD-10), so this suite points
 * `ORCH_HOME` at a scratch directory of its own.
 *
 * Not a nicety: without it these tests would leave registration records in the real `~/.orch` of
 * whichever machine ran them, and a suite whose side effects escape its temporary directories is a
 * suite that changes the thing it is measuring.
 */
const realOrchHome = process.env['ORCH_HOME'];

beforeAll(() => {
  const home = mkdtempSync(join(tmpdir(), 'orch-home-'));
  disposable.push(home);
  process.env['ORCH_HOME'] = home;
});

afterAll(() => {
  if (realOrchHome === undefined) delete process.env['ORCH_HOME'];
  else process.env['ORCH_HOME'] = realOrchHome;
});

const FIRST_RUN_AT = new Date('2026-09-21T09:00:00.000Z');
const SECOND_RUN_AT = new Date('2026-09-21T11:30:00.000Z');

const manifestOf = (repo: string): unknown =>
  ManifestSchema.parse(parseToml(readFileSync(join(repo, '.orch', 'manifest.toml'), 'utf8')));

const modifiedTimes = (repo: string): ReadonlyMap<string, number> => {
  const times = new Map<string, number>();
  for (const path of readTree(join(repo, '.orch')).keys()) {
    times.set(path, statSync(join(repo, '.orch', ...path.split('/'))).mtimeMs);
  }
  return times;
};

describe('a second run changes nothing but the manifest’s own refresh (matrix 2)', () => {
  it('asks nothing, and leaves every other file byte-identical', async () => {
    const repo = repository();
    await runInit({ repository: repo, io: scriptedIo(), now: FIRST_RUN_AT });
    const before = readTree(join(repo, '.orch'));
    const beforeGitignore = readFileSync(join(repo, '.gitignore'), 'utf8');

    const io = scriptedIo();
    const second = await runInit({ repository: repo, io, now: SECOND_RUN_AT });

    expect(second.asked).toStrictEqual([]);
    expect(io.asked).toStrictEqual([]);

    const after = readTree(join(repo, '.orch'));
    expect([...after.keys()].sort()).toStrictEqual([...before.keys()].sort());
    for (const [path, contents] of after) {
      if (path === 'manifest.toml') continue;
      expect(contents, path).toBe(before.get(path));
    }
    expect(readFileSync(join(repo, '.gitignore'), 'utf8')).toBe(beforeGitignore);
  });

  it('does not even rewrite the files it leaves alone', async () => {
    const repo = repository();
    await runInit({ repository: repo, io: scriptedIo(), now: FIRST_RUN_AT });
    const beforeTimes = modifiedTimes(repo);

    await runInit({ repository: repo, io: scriptedIo(), now: SECOND_RUN_AT });

    const afterTimes = modifiedTimes(repo);
    for (const [path, time] of afterTimes) {
      if (path === 'manifest.toml') continue;
      expect(time, path).toBe(beforeTimes.get(path));
    }
  });

  it('refreshes the manifest, and refreshes nothing in it but the time it was written', async () => {
    const repo = repository();
    await runInit({ repository: repo, io: scriptedIo(), now: FIRST_RUN_AT });
    const before = manifestOf(repo) as Record<string, unknown>;

    await runInit({ repository: repo, io: scriptedIo(), now: SECOND_RUN_AT });
    const after = manifestOf(repo) as Record<string, unknown>;

    expect(before['written_at']).toBe(FIRST_RUN_AT.toISOString());
    expect(after['written_at']).toBe(SECOND_RUN_AT.toISOString());
    const { written_at: _first, ...beforeRest } = before;
    const { written_at: _second, ...afterRest } = after;
    expect(afterRest).toStrictEqual(beforeRest);
  });

  it('rewrites exactly the file whose answer changed, and no other', async () => {
    const repo = repository();
    await runInit({ repository: repo, io: scriptedIo(), now: FIRST_RUN_AT });
    const before = readTree(join(repo, '.orch'));

    // Remove one answer and give a different one, which is the only way a re-run may change a file.
    const profilePath = join(repo, '.orch', 'profile.toml');
    writeFileSync(
      profilePath,
      readFileSync(profilePath, 'utf8')
        .split('\n')
        .filter((line) => !line.startsWith('autonomy_start'))
        .join('\n'),
      'utf8',
    );
    await runInit({
      repository: repo,
      io: scriptedIo({ 'autonomy_start.autonomy': 'live' }),
      now: SECOND_RUN_AT,
    });

    const after = readTree(join(repo, '.orch'));
    for (const [path, contents] of after) {
      if (path === 'profile.toml' || path === 'manifest.toml') continue;
      expect(contents, path).toBe(before.get(path));
    }
    expect(parseToml(readFileSync(profilePath, 'utf8'))['autonomy_start']).toBe('live');
  });
});

describe('a run interrupted between two writes is recovered from the manifest (matrix 4)', () => {
  it('restores a file the manifest lists and the tree no longer has, asking nothing', async () => {
    const repo = repository();
    await runInit({ repository: repo, io: scriptedIo(), now: FIRST_RUN_AT });
    const before = readTree(join(repo, '.orch'));

    rmSync(join(repo, '.orch', 'agents', 'testing.toml'));

    const io = scriptedIo();
    const outcome = await runInit({ repository: repo, io, now: SECOND_RUN_AT });

    expect(outcome.recovered).toStrictEqual([
      { path: '.orch/agents/testing.toml', reason: 'absent' },
    ]);
    expect(outcome.asked).toStrictEqual([]);
    expect(readFileSync(join(repo, '.orch', 'agents', 'testing.toml'), 'utf8')).toBe(
      before.get('agents/testing.toml'),
    );
    expect(outcome.summary).toContain('recovered');
  });

  it('restores a file that exists but is no longer what the manifest recorded', async () => {
    const repo = repository();
    await runInit({ repository: repo, io: scriptedIo(), now: FIRST_RUN_AT });
    const before = readTree(join(repo, '.orch'));

    const agentPath = join(repo, '.orch', 'agents', 'planning.toml');
    writeFileSync(agentPath, readFileSync(agentPath, 'utf8').slice(0, 40), 'utf8');

    const outcome = await runInit({ repository: repo, io: scriptedIo(), now: SECOND_RUN_AT });

    expect(outcome.recovered).toStrictEqual([
      { path: '.orch/agents/planning.toml', reason: 'altered' },
    ]);
    expect(readFileSync(agentPath, 'utf8')).toBe(before.get('agents/planning.toml'));
  });

  it('completes an install whose remaining answer went with the missing file', async () => {
    const repo = repository();
    await runInit({
      repository: repo,
      io: scriptedIo({
        'external_domains.domain': ['jira.example.com', ''],
        'external_domains.credential_env': 'JIRA_API_TOKEN',
      }),
      now: FIRST_RUN_AT,
    });

    rmSync(join(repo, '.orch', 'permissions.toml'));

    const io = scriptedIo({
      'external_domains.domain': ['jira.example.com', ''],
      'external_domains.credential_env': 'JIRA_API_TOKEN',
    });
    const outcome = await runInit({ repository: repo, io, now: SECOND_RUN_AT });

    // The manifest says what is missing; the interview fills the answer that was only in it.
    expect(outcome.recovered).toStrictEqual([{ path: '.orch/permissions.toml', reason: 'absent' }]);
    expect(outcome.asked).toStrictEqual(['external_domains']);
    expect(readFileSync(join(repo, '.orch', 'permissions.toml'), 'utf8')).toContain(
      'JIRA_API_TOKEN',
    );
  });

  it('reports nothing recovered when nothing was lost, so the report is not noise', async () => {
    const repo = repository();
    await runInit({ repository: repo, io: scriptedIo(), now: FIRST_RUN_AT });
    const outcome = await runInit({ repository: repo, io: scriptedIo(), now: SECOND_RUN_AT });
    expect(outcome.recovered).toStrictEqual([]);
    expect(outcome.summary).not.toContain('recovered');
  });
});

describe('the .gitignore append is idempotent, line by line (matrix 9 and 10)', () => {
  it('adds each runtime path once, however many times the installer runs', async () => {
    const repo = repository();
    await runInit({ repository: repo, io: scriptedIo(), now: FIRST_RUN_AT });
    await runInit({ repository: repo, io: scriptedIo(), now: SECOND_RUN_AT });

    const lines = readFileSync(join(repo, '.gitignore'), 'utf8').split('\n');
    for (const runtimePath of GITIGNORE_LINES) {
      expect(lines.filter((line) => line.trim() === runtimePath).length, runtimePath).toBe(1);
    }
  });

  it('adds nothing at all when a person already listed the runtime paths by hand', async () => {
    const repo = repository({ files: { '.gitignore': `node_modules\n${GITIGNORE_LINES.join('\n')}\n` } });
    const before = readFileSync(join(repo, '.gitignore'), 'utf8');

    const outcome = await runInit({ repository: repo, io: scriptedIo(), now: FIRST_RUN_AT });

    expect(outcome.gitignore).toBe('unchanged');
    expect(readFileSync(join(repo, '.gitignore'), 'utf8')).toBe(before);
  });

  it('does not join its first line to a last line that had no newline (matrix 10)', async () => {
    const repo = repository({ files: { '.gitignore': 'node_modules' } });
    await runInit({ repository: repo, io: scriptedIo(), now: FIRST_RUN_AT });

    const lines = readFileSync(join(repo, '.gitignore'), 'utf8').split('\n');
    expect(lines[0]).toBe('node_modules');
    expect(lines.filter((line) => line.trim() === GITIGNORE_LINES[0]).length).toBe(1);
    expect(lines.some((line) => line.startsWith('node_modules') && line.length > 12)).toBe(false);
  });

  it('appends to a .gitignore that does not exist yet without disturbing anything else', async () => {
    const repo = repository({ files: {} });
    rmSync(join(repo, '.gitignore'), { force: true });
    await runInit({ repository: repo, io: scriptedIo(), now: FIRST_RUN_AT });

    const contents = readFileSync(join(repo, '.gitignore'), 'utf8');
    expect(contents.startsWith('#')).toBe(true);
    expect(contents.endsWith('\n')).toBe(true);
  });

  it('leaves a later hand edit alone on the next run', async () => {
    const repo = repository();
    await runInit({ repository: repo, io: scriptedIo(), now: FIRST_RUN_AT });
    appendFileSync(join(repo, '.gitignore'), 'coverage/\n', 'utf8');
    const edited = readFileSync(join(repo, '.gitignore'), 'utf8');

    await runInit({ repository: repo, io: scriptedIo(), now: SECOND_RUN_AT });
    expect(readFileSync(join(repo, '.gitignore'), 'utf8')).toBe(edited);
  });
});
