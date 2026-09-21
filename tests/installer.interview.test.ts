/**
 * Matrix rows 1, 3 and 12 — the sequence, the merge and the detected defaults.
 *
 * **Nothing here asserts a prompt's wording.** `build-sequencing.md` fixes thirteen questions in
 * order and says their wording is free to change while AD-9, AD-12, AD-17 and AD-28 fix what they
 * must produce. So every assertion below is on a question's *id*, on the order it comes in, on the
 * suggestion offered, or on what ends up in the artifact — never on the sentence a person reads. A
 * test that pinned a sentence would pin the one thing the contract deliberately frees.
 */
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { INTERVIEW, detectDefaults, parseToml, runInit } from '../src/installer/index.js';
import type { QuestionId } from '../src/installer/index.js';
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

/** The thirteen ids, in the order `build-sequencing.md` states the questions. */
const EXPECTED_ORDER: readonly QuestionId[] = [
  'target_path',
  'project',
  'mechanics',
  'source_layout',
  'resources',
  'high_blast_radius_paths',
  'conflict_domains',
  'branch_pattern',
  'external_domains',
  'builtin_agents',
  'custom_agents',
  'autonomy_start',
  'ceilings',
];

describe('the interview is data, and the data is build-sequencing.md’s thirteen questions', () => {
  it('yields thirteen questions in the documented order', () => {
    expect(INTERVIEW.map((entry) => entry.id)).toStrictEqual(EXPECTED_ORDER);
    expect(INTERVIEW.map((entry) => entry.order)).toStrictEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13,
    ]);
  });

  it('names how every field’s default is arrived at, or that it has none', () => {
    const fields = INTERVIEW.flatMap((entry) =>
      entry.form.kind === 'fields' ? entry.form.fields : entry.form.entry,
    );
    expect(fields.length).toBeGreaterThan(13);
    for (const spec of fields) {
      expect(['detected', 'fixed', 'none']).toContain(spec.defaultSource.kind);
    }
  });

  it('offers exactly the value a fixed default declares', () => {
    const detected = detectDefaults(repository());
    for (const entry of INTERVIEW) {
      const fields = entry.form.kind === 'fields' ? entry.form.fields : entry.form.entry;
      for (const spec of fields) {
        if (spec.defaultSource.kind !== 'fixed') continue;
        expect(spec.suggest(detected), `${entry.id}.${spec.key}`).toBe(spec.defaultSource.value);
      }
    }
  });

  it('offers nothing at all for a field declared to have no default', () => {
    const detected = detectDefaults(repository());
    for (const entry of INTERVIEW) {
      const fields = entry.form.kind === 'fields' ? entry.form.fields : entry.form.entry;
      for (const spec of fields) {
        if (spec.defaultSource.kind !== 'none') continue;
        expect(spec.suggest(detected), `${entry.id}.${spec.key}`).toBeNull();
      }
    }
  });
});

describe('a repository with no .orch/ is asked everything, in order', () => {
  it('puts all thirteen questions and writes the four artifacts (matrix 1)', async () => {
    const repo = repository();
    const io = scriptedIo();
    const outcome = await runInit({ repository: repo, io });

    expect(outcome.asked).toStrictEqual(EXPECTED_ORDER);
    const tree = readTree(join(repo, '.orch'));
    expect([...tree.keys()].sort()).toStrictEqual([
      'agents/analysis.toml',
      'agents/committing.toml',
      'agents/implementation.toml',
      'agents/planning.toml',
      'agents/testing.toml',
      'agents/verification.toml',
      'manifest.toml',
      'permissions.toml',
      'profile.toml',
    ]);
  });

  it('puts every prompt id in the question’s own namespace, so an answer is addressed by id', async () => {
    const io = scriptedIo();
    await runInit({ repository: repository(), io });
    const namespaces = new Set(io.asked.map((id) => id.split('.')[0]));
    expect([...namespaces]).toStrictEqual([...EXPECTED_ORDER]);
  });
});

describe('detected defaults are offered, and every one of them can be overridden (matrix 12)', () => {
  it('offers the package manager and the four commands the repository already declares', async () => {
    const repo = repository();
    const io = scriptedIo();
    await runInit({ repository: repo, io });

    expect(io.suggestions.get('mechanics.package_manager')).toBe('npm');
    expect(io.suggestions.get('mechanics.test')).toBe('npm run test');
    expect(io.suggestions.get('mechanics.lint')).toBe('npm run lint');
    expect(io.suggestions.get('mechanics.build')).toBe('npm run build');
    expect(io.suggestions.get('mechanics.run')).toBe('npm run start');
    expect(io.suggestions.get('source_layout.directories')).toBe('src');
    expect(io.suggestions.get('project.id')).toMatch(/^[0-9a-f]{40}$/);
  });

  it('takes the detected default when the answer is empty, and writes it', async () => {
    const repo = repository();
    await runInit({ repository: repo, io: scriptedIo() });
    const profile = parseToml(readFileSync(join(repo, '.orch', 'profile.toml'), 'utf8'));
    expect(profile['mechanics']).toMatchObject({
      package_manager: 'npm',
      commands: { test: 'npm run test', lint: 'npm run lint' },
    });
  });

  it('writes the person’s answer instead when they give one', async () => {
    const repo = repository();
    await runInit({
      repository: repo,
      io: scriptedIo({
        'mechanics.package_manager': 'pnpm',
        'mechanics.test': 'pnpm vitest run --coverage',
        'source_layout.directories': 'lib, app',
        'branch_pattern.pattern': 'agent/<slug>',
        'ceilings.steps': '12',
      }),
    });

    const profile = parseToml(readFileSync(join(repo, '.orch', 'profile.toml'), 'utf8'));
    expect(profile['mechanics']).toMatchObject({
      package_manager: 'pnpm',
      commands: { test: 'pnpm vitest run --coverage' },
      source_layout: ['lib', 'app'],
    });
    expect(profile['branch_pattern']).toBe('agent/<slug>');
    expect(profile['ceilings']).toMatchObject({ steps: 12 });
  });

  it('refuses an answer it cannot use and asks again rather than writing a guess', async () => {
    const repo = repository();
    const io = scriptedIo({ 'branch_pattern.pattern': ['every-feature-on-one-branch', 'work/<slug>'] });
    await runInit({ repository: repo, io });

    expect(io.said.some((line) => line.includes('<slug>'))).toBe(true);
    const profile = parseToml(readFileSync(join(repo, '.orch', 'profile.toml'), 'utf8'));
    expect(profile['branch_pattern']).toBe('work/<slug>');
  });
});

describe('a re-run asks only the question whose answer is missing (matrix 3)', () => {
  it('asks only that one, and leaves every other answer untouched', async () => {
    const repo = repository();
    await runInit({ repository: repo, io: scriptedIo() });

    const profilePath = join(repo, '.orch', 'profile.toml');
    const before = parseToml(readFileSync(profilePath, 'utf8'));
    writeFileSync(
      profilePath,
      readFileSync(profilePath, 'utf8')
        .split('\n')
        .filter((line) => !line.startsWith('branch_pattern'))
        .join('\n'),
      'utf8',
    );

    const io = scriptedIo({ 'branch_pattern.pattern': 'release/<slug>' });
    const second = await runInit({ repository: repo, io });

    expect(second.asked).toStrictEqual(['branch_pattern']);
    const after = parseToml(readFileSync(profilePath, 'utf8'));
    expect(after['branch_pattern']).toBe('release/<slug>');
    for (const key of ['project', 'mechanics', 'risk', 'roster', 'ceilings', 'autonomy_start']) {
      expect(after[key], key).toStrictEqual(before[key]);
    }
  });

  it('asks nothing at all when every answer is already on disk', async () => {
    const repo = repository();
    await runInit({ repository: repo, io: scriptedIo() });
    const io = scriptedIo();
    const second = await runInit({ repository: repo, io });

    expect(second.asked).toStrictEqual([]);
    expect(io.asked).toStrictEqual([]);
  });
});
