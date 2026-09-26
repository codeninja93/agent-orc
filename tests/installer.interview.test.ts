/**
 * Matrix rows 1, 3 and 12 — the sequence, the merge and the detected defaults.
 *
 * **Nothing here asserts a prompt's wording.** `build-sequencing.md` fixes thirteen questions in
 * order and says their wording is free to change while AD-9, AD-12, AD-17 and AD-28 fix what they
 * must produce. So every assertion below is on a question's *id*, on the order it comes in, on the
 * suggestion offered, or on what ends up in the artifact — never on the sentence a person reads. A
 * test that pinned a sentence would pin the one thing the contract deliberately frees.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  PLACEHOLDER_RATE_LIMIT_WINDOW_TOKENS,
  PROFILE_SCHEMA_VERSION,
  ProfileSchema,
} from '../src/contracts/index.js';
import { INTERVIEW, detectDefaults, detectDocumentation, parseToml, runInit } from '../src/installer/index.js';
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

/**
 * The ids, in the order `build-sequencing.md` states its thirteen questions, plus story 2-10's
 * fourteenth: whether the Jira tool domain is enabled.
 */
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
  'jira',
];

describe('the interview is data, and the data is build-sequencing.md’s thirteen questions', () => {
  it('yields the documented fourteen questions in order', () => {
    expect(INTERVIEW.map((entry) => entry.id)).toStrictEqual(EXPECTED_ORDER);
    expect(INTERVIEW.map((entry) => entry.order)).toStrictEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14,
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
  it('puts all fourteen questions and writes the four artifacts (matrix 1)', async () => {
    const repo = repository();
    const io = scriptedIo();
    const outcome = await runInit({ repository: repo, io });

    expect(outcome.asked).toStrictEqual(EXPECTED_ORDER);
    const tree = readTree(join(repo, '.orch'));
    expect([...tree.keys()].sort()).toStrictEqual([
      'agents/adversarial.toml',
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
  it('offers the package manager and every command the repository already declares', async () => {
    const repo = repository();
    const io = scriptedIo();
    await runInit({ repository: repo, io });

    expect(io.suggestions.get('mechanics.package_manager')).toBe('npm');
    expect(io.suggestions.get('mechanics.test')).toBe('npm run test');
    /**
     * Matrix 35 — the gate CAP-13 names, detected rather than left to a person to remember.
     *
     * Nothing asserted this, and the fixture repository declared no `typecheck` script, so every
     * install in every suite wrote `typecheck = ""` — which is recorded as *skipped*. Emptying the
     * detection table left the whole suite green while CAP-13's first gate went silently missing on
     * every repository that has one.
     */
    expect(io.suggestions.get('mechanics.typecheck')).toBe('npm run typecheck');
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
      // The written profile, not only the offer: a suggestion nothing records is a suggestion the
      // run never sees, and `typecheck` reaching the file is what makes the gate runnable.
      commands: { test: 'npm run test', typecheck: 'npm run typecheck', lint: 'npm run lint' },
    });
  });

  it('detects the three spellings the ecosystem uses for it, and offers none when there is none', () => {
    // `typecheck`, `type-check` and `tsc` are all common; a table naming one would leave the other
    // two undetected and the gate empty. The negative case is what keeps this from passing on a
    // detector that answers the same thing whatever it reads.
    for (const [script, expected] of [
      ['typecheck', 'npm run typecheck'],
      ['type-check', 'npm run type-check'],
      ['tsc', 'npm run tsc'],
    ] as const) {
      const repo = repository();
      writeFileSync(
        join(repo, 'package.json'),
        JSON.stringify({ name: 'fixture', version: '1.0.0', scripts: { [script]: 'tsc --noEmit' } }),
        'utf8',
      );
      expect(detectDefaults(repo).commands.typecheck, script).toBe(expected);
    }
    const bare = repository();
    writeFileSync(
      join(bare, 'package.json'),
      JSON.stringify({ name: 'fixture', version: '1.0.0', scripts: { test: 'vitest run' } }),
      'utf8',
    );
    expect(detectDefaults(bare).commands.typecheck).toBe('');
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

  it('writes the rate-limit window size into the ceilings, the placeholder when nobody states one', async () => {
    const accepted = repository();
    await runInit({ repository: accepted, io: scriptedIo({}) });
    const defaulted = parseToml(readFileSync(join(accepted, '.orch', 'profile.toml'), 'utf8'));
    expect(defaulted['ceilings']).toMatchObject({ rate_limit_window_tokens: PLACEHOLDER_RATE_LIMIT_WINDOW_TOKENS });

    const stated = repository();
    await runInit({ repository: stated, io: scriptedIo({ 'ceilings.rate_limit_window_tokens': '250000' }) });
    const written = parseToml(readFileSync(join(stated, '.orch', 'profile.toml'), 'utf8'));
    expect(written['ceilings']).toMatchObject({ rate_limit_window_tokens: 250_000 });
  });

  it('refuses a window of zero tokens and asks again', async () => {
    const repo = repository();
    const io = scriptedIo({ 'ceilings.rate_limit_window_tokens': ['0', '300000'] });
    await runInit({ repository: repo, io });
    expect(io.said.some((line) => line.includes('The rate-limit window size must be between 1'))).toBe(true);
    const profile = parseToml(readFileSync(join(repo, '.orch', 'profile.toml'), 'utf8'));
    expect(profile['ceilings']).toMatchObject({ rate_limit_window_tokens: 300_000 });
  });

  it('reads a profile written before the window field existed, at the same schema version, as the placeholder', async () => {
    const repo = repository();
    await runInit({ repository: repo, io: scriptedIo({ 'ceilings.rate_limit_window_tokens': '250000' }) });
    // The profile a story 2-1 installer wrote: the same file with the fourth ceiling taken back out.
    const profile = ProfileSchema.parse({
      ...parseToml(readFileSync(join(repo, '.orch', 'profile.toml'), 'utf8')),
      ceilings: { steps: 60, wall_clock_minutes: 120, rate_limit_budget_percent: 50 },
    });
    // Read at the version the installer writes today, whatever that is: the field did not need a bump.
    expect(profile.schema_version).toBe(PROFILE_SCHEMA_VERSION);
    expect(profile.ceilings.rate_limit_window_tokens).toBe(PLACEHOLDER_RATE_LIMIT_WINDOW_TOKENS);
    expect(profile.ceilings).toMatchObject({ steps: 60, wall_clock_minutes: 120, rate_limit_budget_percent: 50 });
  });

  it('refuses an answer it cannot use and asks again rather than writing a guess', async () => {
    const repo = repository();
    const io = scriptedIo({ 'branch_pattern.pattern': ['every-feature-on-one-branch', 'work/<slug>'] });
    await runInit({ repository: repo, io });

    expect(io.said.some((line) => line.includes('<slug>'))).toBe(true);
    const profile = parseToml(readFileSync(join(repo, '.orch', 'profile.toml'), 'utf8'));
    expect(profile['branch_pattern']).toBe('work/<slug>');
  });

  /**
   * Story 2-7, matrix 25 — AD-22's own spelling of the placeholder, typed by a person.
   *
   * AD-22 says the pattern defaults "to `feature/<feature-slug>`", and the interview's original check
   * asked for the substring `<slug>` — which `'feature/<feature-slug>'.includes('<slug>')` answers
   * `false` for. So the architecture's own default was an answer the installer refused, and a person
   * copying it out of the spine would have been re-asked for ever. Every existing case here types
   * `<slug>`, so the widening that fixed it was exercised by nothing: this is the case that fails if
   * the two spellings ever stop being one vocabulary.
   */
  it('accepts AD-22’s own spelling of the placeholder and writes it', async () => {
    const repo = repository();
    const io = scriptedIo({ 'branch_pattern.pattern': 'feature/<feature-slug>' });
    await runInit({ repository: repo, io });

    const profile = parseToml(readFileSync(join(repo, '.orch', 'profile.toml'), 'utf8'));
    expect(profile['branch_pattern']).toBe('feature/<feature-slug>');
    // Accepted first time: no refusal was printed and the person was not asked again.
    expect(io.said.some((line) => line.includes('carries no'))).toBe(false);
  });

  /**
   * A pattern that could not name a git branch is refused where a person can retype it.
   *
   * The placeholder check answers "can this name two branches"; this one answers "is this a branch
   * name". `feature/../<slug>` has a placeholder and climbs a path, so the first check passes it and
   * only the second stops it reaching `git`'s argv.
   */
  it('refuses a pattern that could not name a git branch, even with a placeholder in it', async () => {
    const repo = repository();
    const io = scriptedIo({ 'branch_pattern.pattern': ['feature/../<slug>', 'work/<slug>'] });
    await runInit({ repository: repo, io });

    expect(io.said.some((line) => line.includes('".."'))).toBe(true);
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

/**
 * Story 2-10, question 14 — enable the Jira tool domain, and if so, its credential's env-var *name*
 * and its base URL. Never a credential value: AD-12 forbids the installer bundling one, and question
 * 14 asks for a name for the same reason question 9 does.
 */
describe('question 14 — the Jira tool domain is enabled by name, never by value', () => {
  it('defaults to not enabled, recording both fields blank, when nobody answers', async () => {
    const repo = repository();
    await runInit({ repository: repo, io: scriptedIo() });

    const profile = parseToml(readFileSync(join(repo, '.orch', 'profile.toml'), 'utf8'));
    expect(profile['tool_servers']).toEqual({ jira: { credential_env: '', base_url: '' } });
  });

  it('writes only the env-var name and the base URL, never a value, when enabled', async () => {
    const repo = repository();
    await runInit({
      repository: repo,
      io: scriptedIo({
        'jira.enabled': 'yes',
        'jira.credential_env': 'JIRA_API_TOKEN',
        'jira.base_url': 'https://your-domain.atlassian.net',
      }),
    });

    const profileText = readFileSync(join(repo, '.orch', 'profile.toml'), 'utf8');
    const profile = parseToml(profileText);
    // Exactly the name and the URL — no third field a value could have landed in.
    expect(profile['tool_servers']).toEqual({
      jira: { credential_env: 'JIRA_API_TOKEN', base_url: 'https://your-domain.atlassian.net' },
    });
    const jiraTable = (profile['tool_servers'] as { readonly jira: object }).jira;
    expect(Object.keys(jiraTable).sort()).toStrictEqual(['base_url', 'credential_env']);
  });

  it('discards any credential-env or base-URL text typed alongside "no"', async () => {
    const repo = repository();
    await runInit({
      repository: repo,
      io: scriptedIo({
        'jira.enabled': 'no',
        'jira.credential_env': 'JIRA_API_TOKEN',
        'jira.base_url': 'https://your-domain.atlassian.net',
      }),
    });

    const profile = parseToml(readFileSync(join(repo, '.orch', 'profile.toml'), 'utf8'));
    expect(profile['tool_servers']).toEqual({ jira: { credential_env: '', base_url: '' } });
  });

  it('refuses a malformed base URL, at interview time rather than writing it', async () => {
    const repo = repository();
    // Every field is re-asked on a refused attempt (`askQuestion` re-collects the whole entry), so
    // "yes" and the credential name are scripted for both the refused attempt and the one that holds.
    const io = scriptedIo({
      'jira.enabled': ['yes', 'yes'],
      'jira.credential_env': ['JIRA_API_TOKEN', 'JIRA_API_TOKEN'],
      'jira.base_url': ['not-a-url', 'https://your-domain.atlassian.net'],
    });
    await runInit({ repository: repo, io });

    expect(io.said.some((line) => line.includes('not a valid http'))).toBe(true);
    const profile = parseToml(readFileSync(join(repo, '.orch', 'profile.toml'), 'utf8'));
    expect(profile['tool_servers']).toEqual({
      jira: { credential_env: 'JIRA_API_TOKEN', base_url: 'https://your-domain.atlassian.net' },
    });
  });

  /**
   * Amended after review pass 1 — the interview's own blank-check and `JiraToolServerSchema`'s refine
   * now share one definition of blank (`isBlankToolServerField`), so a whitespace-only base URL is
   * refused here, the friendly way, the same as an empty one — never as an unhandled schema error at
   * write time.
   */
  it('refuses a whitespace-only base URL the same way an empty one is refused', async () => {
    const repo = repository();
    const io = scriptedIo({
      'jira.enabled': ['yes', 'yes'],
      'jira.credential_env': ['JIRA_API_TOKEN', 'JIRA_API_TOKEN'],
      'jira.base_url': ['   ', 'https://your-domain.atlassian.net'],
    });
    await runInit({ repository: repo, io });

    expect(io.said.some((line) => line.includes('base URL is required'))).toBe(true);
  });

  it('refuses a credential_env that is not a valid environment-variable name', async () => {
    const repo = repository();
    const io = scriptedIo({
      'jira.enabled': ['yes', 'yes'],
      'jira.credential_env': ['lower-case-not-allowed', 'JIRA_API_TOKEN'],
      'jira.base_url': ['https://your-domain.atlassian.net', 'https://your-domain.atlassian.net'],
    });
    await runInit({ repository: repo, io });

    expect(io.said.some((line) => line.includes('is not the name of an environment variable'))).toBe(
      true,
    );
  });

  /**
   * Amended after review pass 1's second finding on this question: a reserved name is now caught by
   * the interview's own `parse`, not only by the schema at final write time, so it gets the same
   * friendly re-prompt every other refusal in this question gets rather than an unhandled `ZodError`.
   */
  it('refuses a credential_env that collides with one of jiraMcpConfig’s own fixed keys', async () => {
    const repo = repository();
    const io = scriptedIo({
      'jira.enabled': ['yes', 'yes'],
      'jira.credential_env': ['ORCH_RUN', 'JIRA_API_TOKEN'],
      'jira.base_url': ['https://your-domain.atlassian.net', 'https://your-domain.atlassian.net'],
    });
    await runInit({ repository: repo, io });

    expect(io.said.some((line) => line.includes('ORCH_RUN'))).toBe(true);
    const profile = parseToml(readFileSync(join(repo, '.orch', 'profile.toml'), 'utf8'));
    expect(profile['tool_servers']).toEqual({
      jira: { credential_env: 'JIRA_API_TOKEN', base_url: 'https://your-domain.atlassian.net' },
    });
  });

  /**
   * A re-run must not re-ask question 14 once it has a real, enabled answer on disk — the same
   * round trip `tests/installer.idempotence.test.ts` proves for the disabled default, now for the
   * enabled case, which every other test in this file leaves unexercised.
   */
  it('is not re-asked on a re-run once enabled, and the profile’s answer is unchanged', async () => {
    const repo = repository();
    await runInit({
      repository: repo,
      io: scriptedIo({
        'jira.enabled': 'yes',
        'jira.credential_env': 'JIRA_API_TOKEN',
        'jira.base_url': 'https://your-domain.atlassian.net',
      }),
    });
    const before = parseToml(readFileSync(join(repo, '.orch', 'profile.toml'), 'utf8'))[
      'tool_servers'
    ];

    const io = scriptedIo();
    const second = await runInit({ repository: repo, io });

    expect(second.asked).not.toContain('jira');
    expect(io.asked.some((id) => id.startsWith('jira.'))).toBe(false);
    const after = parseToml(readFileSync(join(repo, '.orch', 'profile.toml'), 'utf8'))['tool_servers'];
    expect(after).toEqual(before);
    expect(after).toEqual({
      jira: { credential_env: 'JIRA_API_TOKEN', base_url: 'https://your-domain.atlassian.net' },
    });
  });
});

/**
 * Express and custom install modes.
 *
 * **Express is verified by silence, not by what it accepted.** Every field express mode resolves
 * without asking lands on exactly the same value `collectEntry`'s existing "empty answer takes the
 * offered default" already gave a person who pressed enter at every prompt — so the behaviour to pin
 * is that `io.ask` is never called at all, which `io.asked` records precisely.
 *
 * **Custom is verified by the description appearing.** `askQuestion` shows a question's description
 * once, the first time it is actually put to a person — in custom mode, that is every question; in
 * express mode's fallback, only the one question that could not be silently defaulted.
 */
describe('express and custom install modes', () => {
  it('resolves every question silently on a repository detection can fully answer, asking nothing', async () => {
    const repo = repository();
    const io = scriptedIo();
    const outcome = await runInit({ repository: repo, io, mode: 'express' });

    expect(io.asked).toStrictEqual([]);
    // Still resolved, just never asked: the summary's own "questions asked" count over silence is the
    // pre-existing meaning of `asked` (resolved this run), not a claim that a person was interrupted.
    expect(outcome.asked).toStrictEqual(EXPECTED_ORDER);
    const profile = ProfileSchema.parse(
      parseToml(readFileSync(join(repo, '.orch', 'profile.toml'), 'utf8')),
    );
    expect(profile.mechanics.source_layout).toStrictEqual(['src']);
    expect(profile.autonomy_start).toBe('shadow');
  });

  it('falls back to asking, with the description shown once, when nothing can default a field', async () => {
    const repo = repository({ node: false });
    // A repository with no lockfile and no conventional source directory leaves `mechanics` and
    // `source_layout` unable to validate silently. The fallback is per *question*, not per field —
    // `mechanics`'s other five fields (blank commands, all valid) are asked too once package_manager's
    // silent attempt fails, because one entry answers every field of its question together.
    const io = scriptedIo({
      'mechanics.package_manager': 'npm',
      'source_layout.directories': 'src',
    });
    const outcome = await runInit({ repository: repo, io, mode: 'express' });

    expect(io.asked).toStrictEqual([
      'mechanics.package_manager',
      'mechanics.typecheck',
      'mechanics.lint',
      'mechanics.test',
      'mechanics.build',
      'mechanics.run',
      'source_layout.directories',
    ]);
    expect(outcome.asked).toStrictEqual(EXPECTED_ORDER);
    const mechanicsQuestion = INTERVIEW.find((entry) => entry.id === 'mechanics');
    const sourceLayoutQuestion = INTERVIEW.find((entry) => entry.id === 'source_layout');
    expect(io.said).toContain(mechanicsQuestion?.description);
    expect(io.said).toContain(sourceLayoutQuestion?.description);
    const profile = ProfileSchema.parse(
      parseToml(readFileSync(join(repo, '.orch', 'profile.toml'), 'utf8')),
    );
    expect(profile.mechanics.source_layout).toStrictEqual(['src']);
    expect(profile.mechanics.package_manager).toBe('npm');
  });

  it('custom mode asks every question and shows every description exactly once', async () => {
    const io = scriptedIo();
    await runInit({ repository: repository(), io, mode: 'custom' });

    for (const entry of INTERVIEW) {
      expect(io.said.filter((line) => line === entry.description), entry.id).toHaveLength(1);
    }
  });

  it('asks InterviewIo.chooseInstallMode exactly once when a mode was not decided already', async () => {
    const io = scriptedIo(
      { 'mechanics.package_manager': 'npm', 'source_layout.directories': 'src' },
      { installMode: 'express' },
    );
    await runInit({ repository: repository({ node: false }), io });

    expect(io.installModeCalls()).toBe(1);
    // Express was the scripted choice, so only the two questions with nothing to default were asked.
    expect(io.asked).toStrictEqual([
      'mechanics.package_manager',
      'mechanics.typecheck',
      'mechanics.lint',
      'mechanics.test',
      'mechanics.build',
      'mechanics.run',
      'source_layout.directories',
    ]);
  });

  it('never asks chooseInstallMode when there is nothing left to ask (a settled re-run)', async () => {
    const repo = repository();
    await runInit({ repository: repo, io: scriptedIo() });

    const io = scriptedIo({}, { installMode: 'express' });
    const second = await runInit({ repository: repo, io });

    expect(second.asked).toStrictEqual([]);
    expect(io.installModeCalls()).toBe(0);
  });

  it('defaults to custom when the io offers no chooseInstallMode and no mode was given, unchanged from before express mode existed', async () => {
    const io = scriptedIo();
    const outcome = await runInit({ repository: repository(), io });

    // Every field asked, exactly as `runInit` behaved before this story — the same shape
    // `EXPECTED_ORDER`'s own describe block already pins for the default call, restated here as the
    // explicit default of the new `mode` option rather than an implicit absence of one.
    expect(outcome.asked).toStrictEqual(EXPECTED_ORDER);
    expect(io.asked.length).toBeGreaterThan(EXPECTED_ORDER.length);
  });

  it('an explicit mode option is never overridden by what chooseInstallMode would have said', async () => {
    const io = scriptedIo({}, { installMode: 'custom' });
    await runInit({ repository: repository(), io, mode: 'express' });

    expect(io.installModeCalls()).toBe(0);
    expect(io.asked).toStrictEqual([]);
  });
});

/**
 * `resources` reads CLAUDE.md, AGENTS.md, README.md and docs/README.md for a literal mention of
 * postgres or redis, and the installer names the gap when none of those files exist at all.
 *
 * **A word-boundary text scan, not understanding.** `detectDocumentation` never claims more than "one
 * of two words appears somewhere in this text" — real project understanding is the bootstrap agent's
 * job (`src/engine/bootstrap.ts`), not this pure, instant read. What is pinned here is exactly that
 * narrow claim, offered as an ordinary overridable suggestion like every other detected field.
 */
describe('resources is informed by the repository’s own documentation', () => {
  it('finds nothing to suggest when no documentation file exists', () => {
    const signals = detectDocumentation(repository({ node: false }));
    expect(signals.files).toStrictEqual([]);
    expect(signals.resourceHint).toBeNull();
  });

  it.each([
    ['postgres', 'This app stores everything in Postgres.', 'postgres'],
    ['postgresql, spelled out', 'Requires PostgreSQL 16 or newer.', 'postgres'],
    ['redis', 'Session state lives in Redis.', 'redis'],
    ['both', 'Uses Postgres for storage and Redis for the job queue.', 'both'],
    ['neither', 'A small static site with no backend at all.', null],
  ] as const)('reads %s from README.md', (_label, prose, expected) => {
    const repo = repository({ node: false, files: { 'README.md': prose } });
    const signals = detectDocumentation(repo);
    expect(signals.files).toStrictEqual(['README.md']);
    expect(signals.resourceHint).toBe(expected);
  });

  it('prefers CLAUDE.md and AGENTS.md, and reads every file that exists rather than only the first', () => {
    const repo = repository({
      node: false,
      files: {
        'CLAUDE.md': 'A CLI tool, no database.',
        'AGENTS.md': 'Agents may read the repository.',
        'README.md': 'Uses Redis for caching.',
      },
    });
    const signals = detectDocumentation(repo);
    expect(signals.files).toStrictEqual(['CLAUDE.md', 'AGENTS.md', 'README.md']);
    // Redis is mentioned only in README.md, and is still found: the scan reads all of them together.
    expect(signals.resourceHint).toBe('redis');
  });

  it('offers the detected hint as the resources suggestion, confirmed or overridden like any other', async () => {
    const repo = repository({
      node: false,
      files: { 'README.md': 'A queue-backed worker using Postgres.' },
    });
    const io = scriptedIo({
      'mechanics.package_manager': 'npm',
      'source_layout.directories': 'src',
    });
    await runInit({ repository: repo, io, mode: 'custom' });
    expect(io.suggestions.get('resources.resources')).toBe('postgres');
  });

  it('names the missing-documentation gap in an advisory, and says nothing when documentation exists', async () => {
    const undocumented = repository({ node: false });
    const outcome = await runInit({
      repository: undocumented,
      io: scriptedIo({ 'mechanics.package_manager': 'npm', 'source_layout.directories': 'src' }),
    });
    expect(outcome.advisories).toHaveLength(1);
    expect(outcome.advisories[0]).toContain('CLAUDE.md');
    expect(outcome.advisories[0]).toContain('--refresh');

    const documented = repository({
      node: false,
      files: { 'README.md': 'A small library, no backend.' },
    });
    const documentedOutcome = await runInit({
      repository: documented,
      io: scriptedIo({ 'mechanics.package_manager': 'npm', 'source_layout.directories': 'src' }),
    });
    expect(documentedOutcome.advisories).toStrictEqual([]);
  });
});

/**
 * `orch init --refresh` — the one way an already-completed install reopens a settled answer.
 *
 * Scoped to exactly `mechanics`, `source_layout` and `resources`: the three questions detection can
 * inform. Everything else a person already answered — `branch_pattern`, `ceilings`, `builtin_agents`,
 * and so on — must survive a refresh completely untouched, which is what distinguishes "reopen what
 * detection can improve on" from "start the interview over".
 */
describe('orch init --refresh reopens exactly what detection can inform', () => {
  it('reopens mechanics, source_layout and resources, and nothing else', async () => {
    const repo = repository({ node: false });
    await runInit({
      repository: repo,
      io: scriptedIo({
        'mechanics.package_manager': 'npm',
        'source_layout.directories': 'src',
        'branch_pattern.pattern': 'release/<slug>',
      }),
    });

    // The repository has grown since the first install: documentation, a lockfile, and real source.
    writeFileSync(join(repo, 'README.md'), 'Backed by Redis for session storage.', 'utf8');
    writeFileSync(join(repo, 'package-lock.json'), '{}\n', 'utf8');
    mkdirSync(join(repo, 'src'), { recursive: true });
    writeFileSync(join(repo, 'src', 'index.js'), 'module.exports = {};\n', 'utf8');

    const io = scriptedIo();
    const outcome = await runInit({ repository: repo, io, refresh: true });

    expect([...outcome.asked].sort()).toStrictEqual(['mechanics', 'resources', 'source_layout'].sort());
    expect(io.suggestions.get('mechanics.package_manager')).toBe('npm');
    expect(io.suggestions.get('resources.resources')).toBe('redis');

    const profile = parseToml(readFileSync(join(repo, '.orch', 'profile.toml'), 'utf8'));
    expect(profile['mechanics']).toMatchObject({ resources: 'redis' });
    // Untouched: the branch pattern answered on the first install is exactly what a refresh must not
    // disturb, and nothing here offered it again.
    expect(profile['branch_pattern']).toBe('release/<slug>');
    expect(io.asked.some((id) => id.startsWith('branch_pattern.'))).toBe(false);
  });

  it('is a no-op on a repository with nothing yet to refresh (a first-ever install)', async () => {
    const repo = repository();
    const io = scriptedIo();
    const outcome = await runInit({ repository: repo, io, refresh: true });

    // Identical to an ordinary first run: refresh only changes what counts as already answered.
    expect(outcome.asked).toStrictEqual(EXPECTED_ORDER);
  });
});
