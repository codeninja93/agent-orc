/**
 * AD-9 — the per-run configuration snapshot: taken once at run start, and the only configuration any
 * step of that run reads.
 *
 * "A config snapshot is taken once at run start into `runs/<run-id>/config/` and is the only
 * configuration any step of that run reads; mid-run edits to `.orch/` never affect a live run." That
 * sentence has two callers in it and no third:
 *
 * - **run start** — {@link takeConfigSnapshot}, which reads `<target-repo>/.orch/` and the repository's
 *   instruction files and copies them under the run;
 * - **a step** — {@link readStepConfiguration}, which reads the snapshot.
 *
 * A step reading `.orch/` directly is the defect this arrangement exists to prevent, and the arrangement
 * is structural rather than advisory: {@link readStepConfiguration} takes a run id and an `ORCH_HOME`
 * and **has no parameter a repository path could arrive in**. There is nothing for a well-meaning caller
 * to pass, which is the same guarantee `UnlocatedProject` gets by having no path field.
 *
 * **Why the copy is bytes and not a re-serialisation.** The snapshot is the *same file* under a new
 * name: `profile.toml` and each `agents/<id>.toml` are copied verbatim, so the values a step reads are
 * the values a person reviewed (AD-16 has them review the profile before first use). Re-rendering
 * through the serialiser would make the snapshot a second author of the artifact, and a formatting
 * change in that serialiser would silently change what a running step reads.
 *
 * **The profile is written last, as the installer writes its manifest last.** It is the marker of a
 * complete snapshot: a process killed part-way leaves agents and conventions on disk with no profile, so
 * the next attempt completes the snapshot rather than finding one and trusting it. Over-promising is the
 * dangerous direction.
 *
 * **A snapshot that exists is never rewritten.** AD-9 says *once*, and the whole point is that an edit
 * to `.orch/` after this moment reaches nothing. So a second call copies nothing at all and reports
 * `already_taken` — not because writing would be slow, but because writing would be the mid-run edit
 * arriving through the front door.
 */
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import type { Dirent } from 'node:fs';
import { dirname, join } from 'node:path';

import { fsyncDirectory, runConfigPaths, runPaths } from '../runtime/index.js';
import type { RunConfigPaths } from '../runtime/index.js';

import { discoverRoster, rosterFileNames } from './roster.js';
import type { DiscoveredRoster } from './roster.js';
import { projectConfiguration, resolveProfile } from './profile.js';
import type { ConfigurationSource, ResolvedProfile } from './profile.js';

/** Distinguishes one write's temporary from a concurrent process's, and one call's from the next. */
let tempCounter = 0;

/**
 * Write one snapshot file atomically: temporary beside the target, fsync, rename, fsync the directory.
 *
 * The same shape `src/runtime/projects.ts` and `src/installer/write.ts` use, and for the same reason: a
 * step arriving mid-snapshot sees the whole file or no file. `fsyncDirectory` is imported from the module
 * that owns the call rather than re-implemented — the file's own fsync makes its *contents* survive a
 * power loss and only the directory's makes the *name* survive one.
 */
const writeSnapshotFile = (absolute: string, contents: string): void => {
  const directory = dirname(absolute);
  mkdirSync(directory, { recursive: true });
  tempCounter += 1;
  const temp = `${absolute}.${String(process.pid)}.${String(tempCounter)}.tmp`;
  writeFileSync(temp, contents, { encoding: 'utf8', mode: 0o644 });
  const fd = openSync(temp, 'r');
  try {
    fsyncSync(fd);
  } catch {
    // Unsynced contents are a durability weakness, not a torn file: the rename is still atomic.
  }
  closeSync(fd);
  renameSync(temp, absolute);
  fsyncDirectory(directory);
};

export interface ConfigSnapshotOptions {
  /** Defaults to the AD-9 `ORCH_HOME`; injected so a test is not written against a real home. */
  readonly orchHome?: string;
}

const snapshotPaths = (runId: string, options: ConfigSnapshotOptions): RunConfigPaths =>
  runConfigPaths(
    options.orchHome === undefined ? runPaths(runId) : runPaths(runId, options.orchHome),
  );

/**
 * Run scope: the immutable snapshot at `runs/<run-id>/config/`.
 *
 * The snapshot's file names are the same as `.orch/`'s, which is what lets the profile loader and roster
 * discovery read either scope without being told which one they are in — `src/runtime/paths.ts` says why
 * that matters.
 */
export const snapshotConfiguration = (
  runId: string,
  options: ConfigSnapshotOptions = {},
): ConfigurationSource => {
  const paths = snapshotPaths(runId, options);
  return {
    scope: 'run',
    label: paths.dir,
    profile: paths.profile,
    agentsDir: paths.agentsDir,
    conventionsDir: paths.conventionsDir,
  };
};

/** Whether this call took the snapshot or found one already taken (AD-9 takes it once). */
export const CONFIG_SNAPSHOT_DISPOSITIONS = ['taken', 'already_taken'] as const;

export type ConfigSnapshotDisposition = (typeof CONFIG_SNAPSHOT_DISPOSITIONS)[number];

export interface ConfigSnapshot {
  readonly runId: string;
  readonly dir: string;
  readonly disposition: ConfigSnapshotDisposition;
  /** Every file in the snapshot, relative to `config/` with `/` separators, sorted. */
  readonly files: readonly string[];
  /**
   * The profile as the *snapshot* states it, not as `.orch/` does.
   *
   * Re-read from what was just written rather than handed back from the load that validated it: a
   * snapshot that cannot be read back is a snapshot no step can use, and run start is the moment to
   * find that out.
   */
  readonly profile: ResolvedProfile;
  readonly roster: DiscoveredRoster;
  readonly summary: string;
}

export interface TakeConfigSnapshotOptions extends ConfigSnapshotOptions {
  /** The repository whose `.orch/` is snapshotted — project scope, read exactly once, here. */
  readonly repository: string;
  readonly runId: string;
}

/**
 * Every file in a snapshot, relative to `config/`, sorted by code unit for a stable report.
 *
 * Recursive, because the snapshot has subdirectories — `agents/` and `conventions/` — and a flat listing
 * would report a complete snapshot as a single file. Sorted by code unit rather than by locale so two
 * machines report the same snapshot identically.
 */
const snapshotFiles = (dir: string, prefix = ''): readonly string[] => {
  // The encoding is pinned so `readdirSync` resolves to the string-named overload; without it TS picks
  // the Buffer one and `entry.name` comes back as bytes.
  let listing: Dirent<string>[];
  try {
    listing = readdirSync(dir, { withFileTypes: true, encoding: 'utf8' });
  } catch {
    return [];
  }
  const found: string[] = [];
  for (const entry of listing) {
    const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      found.push(...snapshotFiles(join(dir, entry.name), relative));
      continue;
    }
    found.push(relative);
  }
  return found.sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
};

/**
 * Take the AD-9 snapshot for a run, from the repository's project-scope configuration.
 *
 * The profile is **resolved before anything is copied**, which is deliberate: a `schema_version` this
 * build does not read is a refusal at run start rather than a surprise three steps in, and nothing is
 * copied from a profile that could not be loaded. A roster file that does not load is a different case —
 * it is copied, and the refusal is reported on the returned roster, because matrix row 12 requires the
 * other agents to load and a step must see the same roster run start saw.
 */
export const takeConfigSnapshot = (options: TakeConfigSnapshotOptions): ConfigSnapshot => {
  const target = snapshotPaths(options.runId, options);
  const runScope = snapshotConfiguration(options.runId, options);

  if (existsSync(target.profile)) {
    // AD-9: taken once. A snapshot that exists is this run's configuration for the rest of its life, so
    // this path copies nothing — re-copying would be exactly the mid-run edit the snapshot prevents.
    const profile = resolveProfile(runScope);
    const roster = discoverRoster(runScope);
    return {
      runId: options.runId,
      dir: target.dir,
      disposition: 'already_taken',
      files: snapshotFiles(target.dir),
      profile,
      roster,
      summary:
        `Run ${options.runId} already has a configuration snapshot at ${target.dir}; nothing was ` +
        'copied. AD-9 takes it once at run start and a live run never sees an edit to .orch/.',
    };
  }

  const projectScope = projectConfiguration(options.repository);
  // Loading before copying: this is what refuses a profile this build cannot read, while `config/` is
  // still empty and the run has taken no other action. A *roster* file it cannot read is not a refusal
  // here — matrix row 12 keeps the other agents loading — so it is copied and reported on
  // `snapshot.roster.refused` instead, where the caller decides what it means for the run.
  const loaded = resolveProfile(projectScope);

  mkdirSync(target.dir, { recursive: true });

  // Every roster *file*, not only the ones that loaded: a file discovery refuses is part of this run's
  // configuration, and a snapshot that quietly dropped it would show a step a smaller roster than run
  // start saw — and would hide the refusal from whatever reads the snapshot later.
  for (const fileName of rosterFileNames(projectScope.agentsDir)) {
    writeSnapshotFile(
      join(target.agentsDir, fileName),
      readFileSync(join(projectScope.agentsDir, fileName), 'utf8'),
    );
  }
  for (const file of loaded.conventions.files) {
    // Verbatim, per AD-16: the conventions a step reads are the repository's own text, and a run reads
    // them from here because the feature branch can edit the repository's copy while the run is live.
    writeSnapshotFile(join(target.conventionsDir, file.name), file.text);
  }
  // Last, as the installer writes its manifest last: the profile's presence is what marks a snapshot
  // complete, so a process killed part-way leaves one that the next attempt completes.
  writeSnapshotFile(target.profile, readFileSync(projectScope.profile, 'utf8'));
  fsyncDirectory(target.dir);

  const profile = resolveProfile(runScope);
  const roster = discoverRoster(runScope);
  return {
    runId: options.runId,
    dir: target.dir,
    disposition: 'taken',
    files: snapshotFiles(target.dir),
    profile,
    roster,
    summary:
      `Snapshotted the configuration of project ${profile.profile.project.id} for run ` +
      `${options.runId} into ${target.dir}: the profile, ${String(roster.agents.length)} agent ` +
      `${roster.agents.length === 1 ? 'declaration' : 'declarations'} and ` +
      `${profile.conventions.files.length === 0 ? 'no instruction file' : profile.conventions.files.map((file) => file.name).join(' and ')}` +
      '. It is this run\'s only configuration from now on (AD-9).',
  };
};

/** The configuration one step of a run works from: the snapshot, and nothing else. */
export interface StepConfiguration {
  readonly runId: string;
  readonly source: ConfigurationSource;
  readonly profile: ResolvedProfile;
  readonly roster: DiscoveredRoster;
  readonly summary: string;
}

/**
 * Read a run's configuration as a step does.
 *
 * **There is no repository parameter, and that is the point.** AD-9 makes the snapshot the only
 * configuration a step reads; a function that accepted a repository path would let a caller hand a step
 * the live `.orch/`, and the failure would be invisible — the values are usually identical, right up to
 * the run where somebody edits the profile while it is going.
 *
 * A run with no snapshot is refused by {@link ProfileNotFound} with the run-scope wording, which says
 * that falling back to `.orch/` is not permitted rather than leaving a reader to wonder.
 */
export const readStepConfiguration = (
  runId: string,
  options: ConfigSnapshotOptions = {},
): StepConfiguration => {
  const source = snapshotConfiguration(runId, options);
  const profile = resolveProfile(source);
  const roster = discoverRoster(source);
  return {
    runId,
    source,
    profile,
    roster,
    summary:
      `Run ${runId} reads its configuration from ${source.label}: test command ` +
      `"${profile.mechanics.commands.test}", ${String(roster.agents.length)} ` +
      `${roster.agents.length === 1 ? 'agent' : 'agents'}, and ` +
      `${String(profile.knowledge.stale.length)} knowledge ` +
      `${profile.knowledge.stale.length === 1 ? 'entry' : 'entries'} flagged stale (AD-9, AD-16).`,
  };
};
