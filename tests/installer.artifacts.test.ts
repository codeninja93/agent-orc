/**
 * Matrix rows 5, 6, 11, 13 and 14 — what lands on disk.
 *
 * Every assertion here is over bytes the installer wrote, never over what it asked. That is the
 * division `build-sequencing.md` draws: the wording of a question is free, and the artifact it
 * produces is fixed by AD-9, AD-12, AD-17 and AD-28.
 *
 * Two of these rows are about something *not* being there — a credential value (row 5) and any
 * reference to BMad (row 14) — and an absence is only worth asserting if the assertion can fail. So
 * both guards are run twice: once over the real tree, where they must find nothing, and once over a
 * tree with the thing planted in a **subdirectory**, where they must find it. A guard that stopped
 * at the top level is how stage 1's `src/tui/` import rule silently stopped covering 44% of its own
 * directory the moment a subdirectory appeared.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  CURRENT_SCHEMA_VERSION,
  PROFILE_SCHEMA_VERSION,
  ManifestSchema,
  PermissionsSchema,
  ProfileSchema,
  SchemaVersionRefusal,
} from '../src/contracts/index.js';
import { AgentDeclarationSchema } from '../src/contracts/index.js';
import { parseToml, runInit } from '../src/installer/index.js';
import { git, makeRepository, readTree, scriptedIo } from './helpers/installer-fixture.js';

const disposable: string[] = [];

const repository = (): string => {
  const created = makeRepository();
  disposable.push(created);
  return created;
};

const scratchDirectory = (): string => {
  const created = mkdtempSync(join(tmpdir(), 'orch-guard-'));
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

/** A credential that is not one: shaped like the real thing, and never valid anywhere. */
const PLANTED_SECRET = 'sk-ant-api03-fixture-value-never-a-name-0123456789';
const CREDENTIAL_VARIABLE = 'FIXTURE_DOMAIN_TOKEN';

/**
 * Run with `process.env` behind a recording proxy, so "no value was read" is a measurement.
 *
 * The installer's only subprocess is git, and it is given an explicit environment, so nothing copies
 * this one wholesale — which is what makes a recorded read a genuine *lookup* rather than an
 * inherited environment passing through.
 */
const recordEnvironmentReads = async <T>(
  run: () => Promise<T>,
): Promise<{ readonly result: T; readonly reads: readonly string[] }> => {
  const reads: string[] = [];
  const real = process.env;
  const proxy = new Proxy(real, {
    get: (target, key): unknown => {
      if (typeof key === 'string') reads.push(key);
      return Reflect.get(target, key);
    },
  });
  Object.defineProperty(process, 'env', { value: proxy, configurable: true, writable: true });
  try {
    return { result: await run(), reads };
  } finally {
    Object.defineProperty(process, 'env', { value: real, configurable: true, writable: true });
  }
};

interface Reference {
  readonly path: string;
  readonly where: 'path' | 'contents';
}

/** Every mention of `needle`, anywhere under `root`, at any depth. */
const referencesTo = (root: string, needle: RegExp): readonly Reference[] => {
  const found: Reference[] = [];
  for (const [path, contents] of readTree(root)) {
    if (needle.test(path)) found.push({ path, where: 'path' });
    if (needle.test(contents)) found.push({ path, where: 'contents' });
  }
  return found;
};

/** AD-18 — nothing under `.orch/` may require `_bmad`, a BMad skill or a BMad command. */
const BMAD = /bmad/i;

describe('question 9 records the NAME of a variable and never its value (matrix 5)', () => {
  it('writes the name, and no value of it reaches the tree', async () => {
    const repo = repository();
    process.env[CREDENTIAL_VARIABLE] = PLANTED_SECRET;
    try {
      const { reads } = await recordEnvironmentReads(async () =>
        runInit({
          repository: repo,
          io: scriptedIo({
            'external_domains.domain': ['jira.example.com', ''],
            'external_domains.credential_env': CREDENTIAL_VARIABLE,
          }),
        }),
      );

      const permissions = parseToml(readFileSync(join(repo, '.orch', 'permissions.toml'), 'utf8'));
      expect(PermissionsSchema.parse(permissions).egress_allowlist).toStrictEqual([
        { domain: 'jira.example.com', credential_env: [CREDENTIAL_VARIABLE] },
      ]);

      // The name is in the tree; the value is nowhere in it.
      expect(referencesTo(join(repo, '.orch'), new RegExp(CREDENTIAL_VARIABLE)).length).toBeGreaterThan(0);
      expect(referencesTo(join(repo, '.orch'), new RegExp(PLANTED_SECRET))).toStrictEqual([]);
      expect(readFileSync(join(repo, '.gitignore'), 'utf8')).not.toContain(PLANTED_SECRET);

      // And the installer never even looked the variable up.
      expect(reads).not.toContain(CREDENTIAL_VARIABLE);
    } finally {
      delete process.env[CREDENTIAL_VARIABLE];
    }
  });

  it('would have caught a value that did reach the tree, so the absence above is evidence', () => {
    const planted = scratchDirectory();
    mkdirSync(join(planted, 'agents'), { recursive: true });
    writeFileSync(join(planted, 'agents', 'leaky.toml'), `token = "${PLANTED_SECRET}"\n`, 'utf8');
    expect(referencesTo(planted, new RegExp(PLANTED_SECRET))).toStrictEqual([
      { path: 'agents/leaky.toml', where: 'contents' },
    ]);
  });
});

describe('an answer shaped like a secret is refused as a value, not stored (matrix 6)', () => {
  it('refuses it naming the distinction, and accepts the name given instead', async () => {
    const repo = repository();
    // A refused answer re-asks the whole question, so the script answers it twice: once with the
    // value that must be refused, then once with the name.
    const io = scriptedIo({
      'external_domains.domain': ['jira.example.com', '', 'jira.example.com', ''],
      'external_domains.credential_env': [PLANTED_SECRET, CREDENTIAL_VARIABLE],
    });
    await runInit({ repository: repo, io });

    const refusal = io.said.find((line) => line.includes(PLANTED_SECRET));
    expect(refusal).toBeDefined();
    expect(refusal).toContain('NAME');
    expect(refusal).toContain('never the credential itself');

    const permissions = PermissionsSchema.parse(
      parseToml(readFileSync(join(repo, '.orch', 'permissions.toml'), 'utf8')),
    );
    expect(permissions.egress_allowlist).toStrictEqual([
      { domain: 'jira.example.com', credential_env: [CREDENTIAL_VARIABLE] },
    ]);
    expect(referencesTo(join(repo, '.orch'), new RegExp(PLANTED_SECRET))).toStrictEqual([]);
  });

  it('refuses a value that is shaped like a name but reads as secret material', async () => {
    const repo = repository();
    const io = scriptedIo({
      'external_domains.domain': ['aws.example.com', '', 'aws.example.com', ''],
      // Upper snake case, so the name pattern alone would admit it; the AD-21 redaction pass knows
      // an access key id when it sees one, and that is the authority this defers to.
      'external_domains.credential_env': ['AKIAIOSFODNN7EXAMPLE', 'AWS_ACCESS_KEY_ID'],
    });
    await runInit({ repository: repo, io });

    expect(io.said.some((line) => line.includes('AKIAIOSFODNN7EXAMPLE'))).toBe(true);
    const permissions = PermissionsSchema.parse(
      parseToml(readFileSync(join(repo, '.orch', 'permissions.toml'), 'utf8')),
    );
    expect(permissions.egress_allowlist).toStrictEqual([
      { domain: 'aws.example.com', credential_env: ['AWS_ACCESS_KEY_ID'] },
    ]);
  });
});

describe('everything written carries a schema_version and appears in the manifest (matrix 13)', () => {
  it('writes only into .orch/ and .gitignore, as git sees it', async () => {
    const repo = repository();
    await runInit({ repository: repo, io: scriptedIo() });

    const touched = git(repo, ['status', '--porcelain'])
      .split('\n')
      .map((line) => line.slice(3).trim())
      .filter((line) => line !== '');
    expect(touched.length).toBeGreaterThan(0);
    for (const path of touched) {
      expect(path === '.gitignore' || path.startsWith('.orch/'), path).toBe(true);
    }
  });

  it('gives every .orch/ artifact the current schema_version, through its own schema', async () => {
    const repo = repository();
    await runInit({ repository: repo, io: scriptedIo() });

    /**
     * Every artifact carries the version **its own schema** declares, which since story 2-6 is not
     * one number for all of them.
     *
     * The profile's advanced when `mechanics.commands` gained `typecheck`, and AD-28 makes that a
     * version change for the artifact whose shape changed and for no other — a shared bump would
     * have refused every `state.json` and every lease written before the upgrade, so a run in
     * flight could not be read back. What must not weaken is the rule: every artifact still carries
     * a version and every one of them is still checked, which is what this loop asserts by reading
     * the expected value *per artifact* rather than by dropping the assertion.
     */
    const tree = readTree(join(repo, '.orch'));
    for (const [path, contents] of tree) {
      const table = parseToml(contents);
      expect(table['schema_version'], path).toBe(
        path === 'profile.toml' ? PROFILE_SCHEMA_VERSION : CURRENT_SCHEMA_VERSION,
      );
      const schema = path.startsWith('agents/')
        ? AgentDeclarationSchema
        : path === 'profile.toml'
          ? ProfileSchema
          : path === 'permissions.toml'
            ? PermissionsSchema
            : ManifestSchema;
      expect(() => schema.parse(table), path).not.toThrow();
    }
  });

  it('lists every file it created in the manifest, and lists nothing it did not', async () => {
    const repo = repository();
    await runInit({ repository: repo, io: scriptedIo() });

    const manifest = ManifestSchema.parse(
      parseToml(readFileSync(join(repo, '.orch', 'manifest.toml'), 'utf8')),
    );
    const onDisk = [...readTree(join(repo, '.orch')).keys()]
      .map((path) => `.orch/${path}`)
      .filter((path) => path !== '.orch/manifest.toml')
      .sort();
    expect(manifest.files.map((entry) => entry.path)).toStrictEqual(onDisk);
    for (const entry of manifest.files) {
      const contents = readFileSync(join(repo, ...entry.path.split('/')), 'utf8');
      expect(entry.bytes, entry.path).toBe(Buffer.byteLength(contents, 'utf8'));
    }
  });

  it('records the installer version that wrote it, so AD-28 can name it later', async () => {
    const repo = repository();
    await runInit({ repository: repo, io: scriptedIo() });
    const manifest = ManifestSchema.parse(
      parseToml(readFileSync(join(repo, '.orch', 'manifest.toml'), 'utf8')),
    );
    expect(manifest.installer_version).toMatch(/^\d+\.\d+\.\d+/);
  });
});

describe('an .orch/ from an unrecognised schema_version is refused, never read as current (matrix 11)', () => {
  it('refuses by name and leaves the file exactly as it found it', async () => {
    const repo = repository();
    await runInit({ repository: repo, io: scriptedIo() });

    const profilePath = join(repo, '.orch', 'profile.toml');
    const future = readFileSync(profilePath, 'utf8').replace(
      `schema_version = ${String(PROFILE_SCHEMA_VERSION)}`,
      `schema_version = ${String(PROFILE_SCHEMA_VERSION + 1)}`,
    );
    // The substitution has to have happened, or the file is unchanged and the refusal below would be
    // asserting nothing — which is how this test would have silently stopped testing anything when
    // the profile's version moved.
    expect(future).not.toBe(readFileSync(profilePath, 'utf8'));
    writeFileSync(profilePath, future, 'utf8');

    await expect(runInit({ repository: repo, io: scriptedIo() })).rejects.toThrow(
      SchemaVersionRefusal,
    );
    expect(readFileSync(profilePath, 'utf8')).toBe(future);
  });

  it('re-runs over a v1 install rather than refusing the one thing it advises (matrix 34)', async () => {
    /**
     * The route forward this story would otherwise have closed.
     *
     * Story 2-6 advanced the profile past `typecheck`, and the refusal an engine raises for a v1
     * profile ends "Re-run the installer to migrate" — so an installer that refused the same file
     * left every existing installation with no way through, and the only advice on offer was the
     * thing it had just refused to do. The re-run *is* the migration: it reads answers, each through
     * its own schema, and writes a v2 profile.
     */
    const repo = repository();
    await runInit({ repository: repo, io: scriptedIo() });
    const profilePath = join(repo, '.orch', 'profile.toml');
    writeFileSync(
      profilePath,
      readFileSync(profilePath, 'utf8').replace(
        `schema_version = ${String(PROFILE_SCHEMA_VERSION)}`,
        `schema_version = ${String(CURRENT_SCHEMA_VERSION)}`,
      ),
      'utf8',
    );
    expect(readFileSync(profilePath, 'utf8')).toContain(
      `schema_version = ${String(CURRENT_SCHEMA_VERSION)}`,
    );

    await expect(runInit({ repository: repo, io: scriptedIo() })).resolves.toBeDefined();
    // And what it wrote is the current shape, not the one it read.
    const rewritten = parseToml(readFileSync(profilePath, 'utf8'));
    expect(rewritten['schema_version']).toBe(PROFILE_SCHEMA_VERSION);
    expect(ProfileSchema.safeParse(rewritten).success).toBe(true);
  });

  it('still refuses a profile from a version it has never written', async () => {
    // The gate that must not weaken: a file from a *future* installer is not something to
    // re-interview from, because the answers it holds are ones this build cannot read.
    const repo = repository();
    await runInit({ repository: repo, io: scriptedIo() });
    const profilePath = join(repo, '.orch', 'profile.toml');
    writeFileSync(
      profilePath,
      readFileSync(profilePath, 'utf8').replace(
        `schema_version = ${String(PROFILE_SCHEMA_VERSION)}`,
        `schema_version = ${String(PROFILE_SCHEMA_VERSION + 1)}`,
      ),
      'utf8',
    );
    await expect(runInit({ repository: repo, io: scriptedIo() })).rejects.toThrow(
      SchemaVersionRefusal,
    );
  });

  it('names the artifact and the installer versions involved', async () => {
    const repo = repository();
    await runInit({ repository: repo, io: scriptedIo() });
    const manifestPath = join(repo, '.orch', 'manifest.toml');
    writeFileSync(
      manifestPath,
      readFileSync(manifestPath, 'utf8').replace('schema_version = 1', 'schema_version = 99'),
      'utf8',
    );

    let thrown: unknown = null;
    try {
      await runInit({ repository: repo, io: scriptedIo() });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(SchemaVersionRefusal);
    expect((thrown as SchemaVersionRefusal).artifact).toBe('.orch/manifest.toml');
    expect((thrown as SchemaVersionRefusal).message).toContain('Re-run the installer');
  });
});

describe('nothing written references BMad (matrix 14, AD-18)', () => {
  it('finds no mention of it anywhere under .orch/, at any depth', async () => {
    const repo = repository();
    await runInit({
      repository: repo,
      io: scriptedIo({
        'custom_agents.id': ['reviewer', ''],
        'custom_agents.purpose': 'Review the diff against the acceptance criteria.',
        'custom_agents.tools': 'Read, Grep',
        'custom_agents.mcp_domains': '',
      }),
    });

    expect(referencesTo(join(repo, '.orch'), BMAD)).toStrictEqual([]);
    expect(BMAD.test(readFileSync(join(repo, '.gitignore'), 'utf8'))).toBe(false);
    // The tree really does have a subdirectory, so the recursive guard above had somewhere to go.
    expect([...readTree(join(repo, '.orch')).keys()].some((path) => path.includes('/'))).toBe(true);
  });

  it('catches a reference planted in a subdirectory, which is how a non-recursive guard fails', () => {
    const planted = scratchDirectory();
    mkdirSync(join(planted, 'agents'), { recursive: true });
    writeFileSync(join(planted, 'profile.toml'), 'schema_version = 1\n', 'utf8');
    writeFileSync(
      join(planted, 'agents', 'analysis.toml'),
      'workflow = "_bmad/bmm/workflows/analysis"\n',
      'utf8',
    );
    expect(referencesTo(planted, BMAD)).toStrictEqual([
      { path: 'agents/analysis.toml', where: 'contents' },
    ]);
  });

  it('catches a reference in a file name as well as in a file’s contents', () => {
    const planted = scratchDirectory();
    mkdirSync(join(planted, 'agents'), { recursive: true });
    writeFileSync(join(planted, 'agents', 'bmad-dev.toml'), 'schema_version = 1\n', 'utf8');
    expect(referencesTo(planted, BMAD)).toStrictEqual([
      { path: 'agents/bmad-dev.toml', where: 'path' },
    ]);
  });
});
