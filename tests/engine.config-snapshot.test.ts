/**
 * AD-9, matrix rows 17 and 18 — the configuration snapshot is taken once at run start, and a live run
 * never sees an edit to `.orch/`.
 *
 * Row 18 is asserted in the strong form the story asks for: after the edit, the snapshot's **bytes are
 * unchanged** and the step's values are the old ones. "No error was thrown" would pass against a step
 * that read `.orch/` and happened to find the same numbers there, which is the whole failure this
 * arrangement exists to prevent. The suite also deletes `.orch/` outright after the snapshot and reads the
 * configuration again: a step that reached for the repository has nothing to reach for, so the test fails
 * loudly rather than coincidentally.
 */
import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { CURRENT_SCHEMA_VERSION } from '../src/contracts/index.js';
import type { Profile } from '../src/contracts/index.js';
import {
  ProfileNotFound,
  readStepConfiguration,
  snapshotConfiguration,
  takeConfigSnapshot,
} from '../src/engine/index.js';
import { runConfigPaths, runPaths } from '../src/runtime/index.js';

import {
  FIXTURE_PROJECT_ID,
  fixtureAgent,
  fixtureProfile,
  makeWorkspace,
  writeAgentFile,
  writeInstructionFile,
  writeProfile,
  writeRawProfile,
} from './helpers/config-fixture.js';

const workspaces: string[] = [];

const workspace = (label: string): string => {
  const created = makeWorkspace(label);
  workspaces.push(created);
  return created;
};

afterAll(() => {
  for (const path of workspaces) rmSync(path, { recursive: true, force: true });
});

/** A ULID-shaped run id, as AD-29 mints. Fixed rather than minted so a failure names the same run. */
const RUN_ID = '01K5ZQ4RUNIDFIXTUREAA';

const CLAUDE_MD = '# Conventions\n\nNever call `resolveProject` from a renderer.\n';

/** The fixture profile, with the AD-10 pointer naming the repository it is written into. */
const profileFor = (repository: string, overrides: Partial<Profile> = {}): Profile =>
  fixtureProfile({
    project: { id: FIXTURE_PROJECT_ID, path: repository, remote: '' },
    ...overrides,
  });

interface Fixture {
  readonly repository: string;
  readonly orchHome: string;
}

/**
 * A repository with a profile, two agents and a `CLAUDE.md`, and an `ORCH_HOME` to snapshot into.
 *
 * The profile records this repository's **real** path, which matters for row 18: a step that reached for
 * `.orch/` would reach it through `project.path` and would succeed, quietly returning the edited values.
 * A fixture recording a placeholder path would make that mistake fail for the wrong reason.
 */
const fixture = (label: string): Fixture => {
  const repository = workspace(`${label}-repo`);
  const orchHome = workspace(`${label}-home`);
  writeProfile(repository, profileFor(repository));
  writeAgentFile(repository, 'analysis.toml', fixtureAgent());
  writeAgentFile(repository, 'planning.toml', fixtureAgent({ id: 'planning' }));
  writeInstructionFile(repository, 'CLAUDE.md', CLAUDE_MD);
  return { repository, orchHome };
};

/** Every file in the snapshot with its bytes, so "unchanged" is a comparison and not a feeling. */
const snapshotBytes = (at: Fixture): ReadonlyMap<string, string> => {
  const paths = runConfigPaths(runPaths(RUN_ID, at.orchHome));
  const collected = new Map<string, string>();
  const walk = (dir: string, prefix: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true, encoding: 'utf8' })) {
      const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) {
        walk(join(dir, entry.name), relative);
        continue;
      }
      collected.set(relative, readFileSync(join(dir, entry.name), 'utf8'));
    }
  };
  if (existsSync(paths.dir)) walk(paths.dir, '');
  return collected;
};

describe('run start writes the snapshot AD-9 requires (matrix 17)', () => {
  it('carries the profile, the roster and the conventions text under runs/<run-id>/config/', () => {
    const at = fixture('take');

    const snapshot = takeConfigSnapshot({ repository: at.repository, runId: RUN_ID, orchHome: at.orchHome });

    expect(snapshot.disposition).toBe('taken');
    expect(snapshot.dir).toBe(runConfigPaths(runPaths(RUN_ID, at.orchHome)).dir);
    expect([...snapshot.files]).toStrictEqual([
      'agents/analysis.toml',
      'agents/planning.toml',
      'conventions/CLAUDE.md',
      'profile.toml',
    ]);
    expect(snapshot.profile.mechanics.commands.test).toBe('npm test');
    expect(snapshot.roster.agents.map((entry) => entry.id)).toStrictEqual(['analysis', 'planning']);
    expect(snapshot.profile.conventions.files[0]?.text).toBe(CLAUDE_MD);
    expect(snapshot.summary).toContain('AD-9');
  });

  it('copies the bytes rather than re-serialising them, so a step reads what a person reviewed', () => {
    const at = fixture('bytes');

    takeConfigSnapshot({ repository: at.repository, runId: RUN_ID, orchHome: at.orchHome });

    const bytes = snapshotBytes(at);
    expect(bytes.get('profile.toml')).toBe(
      readFileSync(join(at.repository, '.orch', 'profile.toml'), 'utf8'),
    );
    expect(bytes.get('agents/planning.toml')).toBe(
      readFileSync(join(at.repository, '.orch', 'agents', 'planning.toml'), 'utf8'),
    );
    expect(bytes.get('conventions/CLAUDE.md')).toBe(
      readFileSync(join(at.repository, 'CLAUDE.md'), 'utf8'),
    );
  });

  it('snapshots a repository that states no conventions without inventing a file', () => {
    const at = fixture('no-conventions');
    rmSync(join(at.repository, 'CLAUDE.md'));

    const snapshot = takeConfigSnapshot({
      repository: at.repository,
      runId: RUN_ID,
      orchHome: at.orchHome,
    });

    expect(snapshot.files).not.toContain('conventions/CLAUDE.md');
    expect(snapshot.profile.conventions.files).toStrictEqual([]);
    expect(snapshot.summary).toContain('no instruction file');
  });

  it('refuses at run start rather than mid-run, and copies nothing it could not read', () => {
    const at = fixture('unreadable');
    writeRawProfile(at.repository, {
      ...profileFor(at.repository),
      schema_version: CURRENT_SCHEMA_VERSION + 98,
    });

    expect(() =>
      takeConfigSnapshot({ repository: at.repository, runId: RUN_ID, orchHome: at.orchHome }),
    ).toThrowError(/schema_version 99/);
    expect(snapshotBytes(at).size).toBe(0);
  });

  it('refuses a repository with no profile, with the project-scope wording', () => {
    const repository = workspace('uninstalled-repo');
    const orchHome = workspace('uninstalled-home');

    expect(() => takeConfigSnapshot({ repository, runId: RUN_ID, orchHome })).toThrowError(
      ProfileNotFound,
    );
  });

  it('carries a roster file it refuses, so a step sees the roster run start saw', () => {
    const at = fixture('refused-entry');
    // A file discovery refuses is still part of this run's configuration. Dropping it from the snapshot
    // would show the step a smaller roster than run start had, and would hide the refusal entirely.
    writeAgentFile(at.repository, 'inventive.toml', fixtureAgent({ id: 'inventive', contract: 'step.invented' }));

    const snapshot = takeConfigSnapshot({
      repository: at.repository,
      runId: RUN_ID,
      orchHome: at.orchHome,
    });

    expect(snapshot.files).toContain('agents/inventive.toml');
    expect(snapshot.roster.agents.map((entry) => entry.id)).toStrictEqual(['analysis', 'planning']);
    expect(snapshot.roster.refused).toHaveLength(1);
    const step = readStepConfiguration(RUN_ID, { orchHome: at.orchHome });
    expect(step.roster.refused[0]?.reason).toContain('step.invented');
    expect(step.roster.refused[0]?.path).toBe(
      join(snapshot.dir, 'agents', 'inventive.toml'),
    );
  });

  it('completes a snapshot a crash left without its profile, because the profile is written last', () => {
    const at = fixture('partial');
    takeConfigSnapshot({ repository: at.repository, runId: RUN_ID, orchHome: at.orchHome });
    const paths = runConfigPaths(runPaths(RUN_ID, at.orchHome));
    // The state a process killed between the agents and the profile leaves behind.
    rmSync(paths.profile);

    const second = takeConfigSnapshot({
      repository: at.repository,
      runId: RUN_ID,
      orchHome: at.orchHome,
    });

    expect(second.disposition).toBe('taken');
    expect(second.files).toContain('profile.toml');
  });
});

describe('a live run never sees an edit to .orch/ (matrix 18)', () => {
  /** Snapshot, then edit every part of the project-scope configuration underneath it. */
  const snapshotThenEdit = (label: string): { at: Fixture; before: ReadonlyMap<string, string> } => {
    const at = fixture(label);
    takeConfigSnapshot({ repository: at.repository, runId: RUN_ID, orchHome: at.orchHome });
    const before = snapshotBytes(at);

    writeProfile(
      at.repository,
      profileFor(at.repository, {
        mechanics: {
          package_manager: 'pnpm',
          commands: { test: 'pnpm vitest --run', lint: 'x', build: 'y', run: 'z' },
          source_layout: ['app'],
          resources: 'postgres',
        },
      }),
    );
    writeAgentFile(at.repository, 'committing.toml', fixtureAgent({ id: 'committing' }));
    writeInstructionFile(at.repository, 'CLAUDE.md', '# Conventions\n\nEdited mid-run.\n');
    return { at, before };
  };

  it('leaves the snapshot byte-identical after the edit', () => {
    const { at, before } = snapshotThenEdit('edited');

    const after = snapshotBytes(at);

    expect([...after.keys()].sort()).toStrictEqual([...before.keys()].sort());
    for (const [path, contents] of before) {
      expect(after.get(path), path).toBe(contents);
    }
    // And the repository really did change, so the comparison above is not comparing two unchanged
    // things — the premise of the row, asserted rather than assumed.
    expect(readFileSync(join(at.repository, '.orch', 'profile.toml'), 'utf8')).not.toBe(
      before.get('profile.toml'),
    );
  });

  it('gives a step the snapshot\'s values, not the new ones', () => {
    const { at } = snapshotThenEdit('step-reads');

    const step = readStepConfiguration(RUN_ID, { orchHome: at.orchHome });

    expect(step.profile.mechanics.commands.test).toBe('npm test');
    expect(step.profile.mechanics.package_manager).toBe('npm');
    expect(step.profile.conventions.files[0]?.text).toBe(CLAUDE_MD);
    expect(step.roster.agents.map((entry) => entry.id)).toStrictEqual(['analysis', 'planning']);
    expect(step.source.scope).toBe('run');
    expect(step.summary).toContain('npm test');
  });

  it('reads the snapshot even when .orch/ is gone entirely', () => {
    // The sharpest form of the rule: a step that reached for the repository's configuration would find
    // nothing here. Editing `.orch/` can be survived by coincidence; deleting it cannot.
    const at = fixture('orch-deleted');
    takeConfigSnapshot({ repository: at.repository, runId: RUN_ID, orchHome: at.orchHome });
    rmSync(join(at.repository, '.orch'), { recursive: true, force: true });
    rmSync(join(at.repository, 'CLAUDE.md'));

    const step = readStepConfiguration(RUN_ID, { orchHome: at.orchHome });

    expect(step.profile.mechanics.commands.test).toBe('npm test');
    expect(step.roster.agents.map((entry) => entry.id)).toStrictEqual(['analysis', 'planning']);
    expect(step.profile.conventions.files[0]?.text).toBe(CLAUDE_MD);
  });

  it('takes the snapshot once: a second call copies nothing and says so', () => {
    const { at, before } = snapshotThenEdit('second-call');

    const second = takeConfigSnapshot({
      repository: at.repository,
      runId: RUN_ID,
      orchHome: at.orchHome,
    });

    expect(second.disposition).toBe('already_taken');
    expect(second.summary).toContain('nothing was copied');
    expect(second.profile.mechanics.commands.test).toBe('npm test');
    expect(second.roster.agents.map((entry) => entry.id)).toStrictEqual(['analysis', 'planning']);
    for (const [path, contents] of before) {
      expect(snapshotBytes(at).get(path), path).toBe(contents);
    }
  });

  it('refuses a step whose run has no snapshot, and refuses to fall back to .orch/', () => {
    const at = fixture('no-snapshot');

    try {
      readStepConfiguration(RUN_ID, { orchHome: at.orchHome });
      expect.unreachable('a run with no snapshot must be refused');
    } catch (error) {
      expect(error).toBeInstanceOf(ProfileNotFound);
      const refusal = error as ProfileNotFound;
      expect(refusal.scope).toBe('run');
      expect(refusal.message).toContain('AD-9');
      expect(refusal.message).toContain('not permitted to fall back');
      // The repository is perfectly installed; that is exactly why falling back would have "worked".
      expect(existsSync(join(at.repository, '.orch', 'profile.toml'))).toBe(true);
    }
  });

  it('names the snapshot, not the repository, as the source a step read from', () => {
    const at = fixture('source-named');
    takeConfigSnapshot({ repository: at.repository, runId: RUN_ID, orchHome: at.orchHome });

    const source = snapshotConfiguration(RUN_ID, { orchHome: at.orchHome });

    expect(source.scope).toBe('run');
    expect(source.profile.startsWith(runPaths(RUN_ID, at.orchHome).runDir)).toBe(true);
    expect(source.agentsDir).toBe(runConfigPaths(runPaths(RUN_ID, at.orchHome)).agentsDir);
    expect(source.conventionsDir).toBe(runConfigPaths(runPaths(RUN_ID, at.orchHome)).conventionsDir);
    expect(readStepConfiguration(RUN_ID, { orchHome: at.orchHome }).source).toStrictEqual(source);
  });

  it('keeps two runs of one repository independent', () => {
    const at = fixture('two-runs');
    takeConfigSnapshot({ repository: at.repository, runId: RUN_ID, orchHome: at.orchHome });
    writeProfile(
      at.repository,
      profileFor(at.repository, {
        mechanics: {
          package_manager: 'bun',
          commands: { test: 'bun test', lint: 'x', build: 'y', run: 'z' },
          source_layout: ['src'],
          resources: 'none',
        },
      }),
    );
    const laterRun = '01K5ZQ4RUNIDFIXTUREBB';

    takeConfigSnapshot({ repository: at.repository, runId: laterRun, orchHome: at.orchHome });

    expect(readStepConfiguration(RUN_ID, { orchHome: at.orchHome }).profile.mechanics.commands.test).toBe(
      'npm test',
    );
    expect(
      readStepConfiguration(laterRun, { orchHome: at.orchHome }).profile.mechanics.commands.test,
    ).toBe('bun test');
  });
});

describe('the snapshot is the only configuration a step can name', () => {
  it('offers a step reader with nowhere to pass a repository path', () => {
    // A structural guarantee rather than a rule to remember: `readStepConfiguration` takes a run id and an
    // `ORCH_HOME`, so there is no argument a caller could hand the live `.orch/` in. The same shape
    // `UnlocatedProject` gets by having no path field.
    expect(readStepConfiguration.length).toBeLessThanOrEqual(2);
    const source = readFileSync(new URL('../src/engine/config-snapshot.ts', import.meta.url), 'utf8');
    const body = source.slice(source.indexOf('export const readStepConfiguration'));
    const code = body.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
    expect(code).not.toContain('projectConfiguration');
    expect(code).not.toContain('ORCH_DIR_NAME');
  });

  it('writes nothing into the repository while snapshotting', () => {
    const at = fixture('read-only');
    const before = readdirSync(at.repository).sort();

    takeConfigSnapshot({ repository: at.repository, runId: RUN_ID, orchHome: at.orchHome });

    expect(readdirSync(at.repository).sort()).toStrictEqual(before);
    expect(
      readdirSync(join(at.repository, '.orch'), { recursive: true, encoding: 'utf8' }).sort(),
    ).toStrictEqual(['agents', 'agents/analysis.toml', 'agents/planning.toml', 'profile.toml']);
  });

  it('leaves no temporary behind, so nothing under config/ is debris', () => {
    const at = fixture('no-debris');

    const snapshot = takeConfigSnapshot({
      repository: at.repository,
      runId: RUN_ID,
      orchHome: at.orchHome,
    });

    for (const file of snapshot.files) expect(file.endsWith('.tmp')).toBe(false);
    expect([...snapshotBytes(at).keys()].some((path) => path.endsWith('.tmp'))).toBe(false);
  });
});
