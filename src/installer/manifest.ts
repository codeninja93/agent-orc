/**
 * AD-12's manifest: every file the installer created, so a half-install is detectable and
 * recoverable.
 *
 * **A digest, not just a name.** "Detectable" has to cover a file that exists and is *wrong* — a run
 * killed between the `write` and the `rename`, a truncated copy, a file half-restored from a backup
 * — and not only one that is absent. So each entry carries the sha-256 and the length the installer
 * wrote, and a re-run compares both. That is what lets the outcome state what it *recovered* rather
 * than just that it ran.
 *
 * **The manifest does not list itself, and does not list `.gitignore`.** It cannot carry its own
 * digest, and `.gitignore` is appended to rather than created — its contents are the repository's,
 * so recording a digest for it would report every later edit a person makes as a damaged install.
 * The append is idempotent by line, which is what makes it recoverable without being recorded.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  CURRENT_SCHEMA_VERSION,
  INSTALLER_VERSION,
  MANIFEST_FILE_NAME,
  formatTimestamp,
} from '../contracts/index.js';
import type { Manifest, ManifestEntry } from '../contracts/index.js';

/** One file the installer is responsible for, as bytes plus the path the manifest names it by. */
export interface WrittenFile {
  /** Repository-relative, `/`-separated — the path a manifest entry carries. */
  readonly path: string;
  readonly contents: string;
}

export const digestOf = (contents: string): string =>
  createHash('sha256').update(contents, 'utf8').digest('hex');

export const manifestEntryFor = (file: WrittenFile): ManifestEntry => ({
  path: file.path,
  sha256: digestOf(file.contents),
  bytes: Buffer.byteLength(file.contents, 'utf8'),
});

/**
 * Build the manifest for a completed install.
 *
 * `written_at` is the only field that moves when nothing else did, and that is deliberate: matrix
 * row 2 has the manifest *refreshed* on a re-run while the rest of the tree stays byte-identical, so
 * the refresh has to be visible somewhere and nowhere else.
 */
export const buildManifest = (
  projectId: string,
  files: readonly WrittenFile[],
  at: Date = new Date(),
): Manifest => ({
  schema_version: CURRENT_SCHEMA_VERSION,
  installer_version: INSTALLER_VERSION,
  written_at: formatTimestamp(at),
  project_id: projectId,
  files: files
    .filter((file) => !file.path.endsWith(MANIFEST_FILE_NAME))
    .map(manifestEntryFor)
    .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0)),
});

/** Why a file the manifest lists is not what the installer left. */
export const HALF_INSTALL_REASONS = ['absent', 'altered'] as const;

export type HalfInstallReason = (typeof HALF_INSTALL_REASONS)[number];

export interface HalfInstallFinding {
  readonly path: string;
  readonly reason: HalfInstallReason;
}

/**
 * What the previous manifest promised and the tree no longer holds.
 *
 * This is the half-install reader: a run interrupted between two writes left a manifest listing
 * files it had not yet written, and this is what a re-run consults to say what it is recovering.
 * Nothing is repaired here — the writer does that, from the answers — because a repair that guessed
 * at contents from a digest would be inventing the file rather than rebuilding it.
 */
export const findHalfInstall = (
  manifest: Manifest | null,
  repository: string,
): readonly HalfInstallFinding[] => {
  if (manifest === null) return [];
  const findings: HalfInstallFinding[] = [];
  for (const entry of manifest.files) {
    const absolute = join(repository, ...entry.path.split('/'));
    if (!existsSync(absolute)) {
      findings.push({ path: entry.path, reason: 'absent' });
      continue;
    }
    if (digestOf(readFileSync(absolute, 'utf8')) !== entry.sha256) {
      findings.push({ path: entry.path, reason: 'altered' });
    }
  }
  return findings;
};
