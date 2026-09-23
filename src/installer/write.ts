/**
 * The four artifacts and the `.gitignore` append — the only things the installer puts in a target
 * repository (AD-9, AD-12).
 *
 * **Every write is atomic, and a write that would change nothing does not happen.** The atomic shape
 * is the one `src/runtime/` already uses: a temporary beside the target, `fsync`, `rename`, then
 * `fsync` of the directory, so a reader arriving mid-install sees the whole file or no file. The
 * *skip* is what makes story 2-1's idempotence observable rather than merely claimed: a second run
 * that changed no answer performs no write on those files at all, so their bytes and their
 * modification times are the ones the first run left.
 *
 * **Nothing rendered here may reference BMad (AD-18).** This package is delivered from a repository
 * that contains `_bmad/`, which is exactly how a skill name or a path leaks into a generated profile.
 * The guard is a recursive test over the written tree in `tests/installer.artifacts.test.ts`; the
 * defence in this file is that every byte written comes from an answer or from a literal here, and
 * nothing is copied out of the installer's own repository.
 *
 * **Agent files are never removed.** The roster on disk *is* the answer to questions 10 and 11 — that
 * is how a re-run knows not to ask them — so a file in `.orch/agents/` is authority, including one a
 * person wrote by hand. Pruning it would delete the answer and then ask for it again.
 */
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import {
  AGENTS_DIR_NAME,
  AgentDeclarationSchema,
  CURRENT_SCHEMA_VERSION,
  PROFILE_SCHEMA_VERSION,
  KnowledgeSectionSchema,
  MANIFEST_FILE_NAME,
  ManifestSchema,
  PERMISSIONS_FILE_NAME,
  PROFILE_FILE_NAME,
  PermissionsSchema,
  ProfileSchema,
  getContract,
} from '../contracts/index.js';
import type {
  AgentDeclaration,
  KnowledgeSection,
  Manifest,
  Permissions,
  Profile,
} from '../contracts/index.js';
import { fsyncDirectory } from '../runtime/commands.js';

import { orchPaths, relativeOrchPath } from './answers.js';
import { BUILT_IN_AGENTS } from './interview.js';
import type { AgentDeclarationInput, Answers } from './interview.js';
import { buildManifest } from './manifest.js';
import type { WrittenFile } from './manifest.js';
import { parseToml, serialiseToml } from './toml.js';
import type { TomlTable } from './toml.js';

/**
 * The runtime paths appended to `.gitignore`, per AD-9.
 *
 * `.orch/` itself is committed — it is project scope under AD-34 — so the only thing in it that must
 * never be committed is the debris of an interrupted atomic write: a `<name>.<pid>.tmp` beside the
 * file it was about to become. Everything else the runtime produces lives under `ORCH_HOME` and
 * never enters the repository at all, which is why this list is short rather than defensive.
 */
export const GITIGNORE_LINES: readonly string[] = ['.orch/**/*.tmp'];

/** Written above the lines on a first append, and never matched against, so it never duplicates. */
export const GITIGNORE_HEADER = '# agent-orchestrator runtime paths (AD-9); .orch/ itself is committed.';

/** The reversibility classes that stop for a person. CAP-12: an irreversible action is gated. */
export const GATED_REVERSIBILITY_CLASSES = ['irreversible'] as const;

export type WriteDisposition = 'created' | 'updated' | 'unchanged';

export interface FileOutcome {
  readonly path: string;
  readonly disposition: WriteDisposition;
}

export interface WriteOutcome {
  readonly files: readonly WrittenFile[];
  readonly dispositions: readonly FileOutcome[];
  readonly gitignore: 'appended' | 'unchanged';
}

/**
 * Write one file atomically, or leave it alone because it already holds exactly these bytes.
 *
 * Reading before writing is not an optimisation. It is the difference between "the installer is
 * idempotent" and "the installer rewrites the same bytes and calls that idempotent": only the skip
 * leaves a re-run's tree indistinguishable from the first run's.
 */
export const writeFileIfChanged = (absolute: string, contents: string): WriteDisposition => {
  const exists = existsSync(absolute);
  if (exists && readFileSync(absolute, 'utf8') === contents) return 'unchanged';

  const directory = dirname(absolute);
  // The temporary lives beside its target, because `rename` cannot cross a filesystem boundary and
  // a temporary elsewhere would fail with EXDEV on exactly the machines that separate them.
  const temp = `${absolute}.${String(process.pid)}.tmp`;
  writeFileSync(temp, contents, { encoding: 'utf8', mode: 0o644 });
  const fd = openSync(temp, 'r');
  try {
    fsyncSync(fd);
  } catch {
    // Unsynced contents are a durability weakness, not a torn file: the rename is still atomic.
  }
  // Closed on both paths without a `finally`, matching the idiom in `src/runtime/commands.ts`.
  closeSync(fd);
  renameSync(temp, absolute);
  // Only now is the *name* durable; the file's own fsync makes only its contents so.
  fsyncDirectory(directory);
  return exists ? 'updated' : 'created';
};

/**
 * The knowledge section already on disk, so a re-run does not destroy it.
 *
 * AD-16 makes the section **additive** and AD-12 makes an upgrade a **re-run**, and those two together are
 * a requirement on this function: `renderProfile` builds the profile from the interview's answers, the
 * interview has no question that produces a knowledge entry, and `profile.toml` is rewritten whole — so
 * without this, every entry the stage-5 bootstrap agent writes is erased by the next `orch init`, and the
 * half-install check then reports the profile as `altered` and restores the shorter version.
 *
 * Read leniently, in the idiom `src/installer/answers.ts` uses for the same file: an unreadable or
 * unrecognised section carries nothing forward rather than refusing an install. The strict read belongs to
 * the engine's loader, which is the unit that acts on the entries.
 */
export const existingKnowledge = (repositoryPath: string): KnowledgeSection | undefined => {
  const path = orchPaths(repositoryPath).profile;
  if (!existsSync(path)) return undefined;
  try {
    const parsed = KnowledgeSectionSchema.safeParse(parseToml(readFileSync(path, 'utf8'))['knowledge']);
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
};

/** The profile as a table, in the order it is written. */
export const renderProfile = (answers: Answers, repositoryPath: string): Profile => {
  const knowledge = existingKnowledge(repositoryPath);
  return {
    // The profile's own version, which is ahead of the others: story 2-6 added
    // `mechanics.commands.typecheck`, and AD-28 makes a shape change a version change for the
    // artifact whose shape changed and for no other.
    schema_version: PROFILE_SCHEMA_VERSION,
    project: {
      id: answers.project.id,
      /**
       * The path the installer actually ran against, not the one the previous profile recorded.
       *
       * AD-10 — the id is the first-commit SHA and the filesystem path is "a mutable pointer updated
       * on mismatch". A repository that moved keeps its id and gets its pointer corrected here.
       */
      path: repositoryPath,
      remote: answers.project.remote,
    },
    mechanics: {
      package_manager: answers.mechanics.package_manager,
      commands: answers.mechanics.commands,
      source_layout: [...answers.source_layout],
      resources: answers.resources,
    },
    risk: {
      high_blast_radius_paths: [...answers.high_blast_radius_paths],
      conflict_domains: [...answers.conflict_domains],
    },
    roster: { builtin_agents: [...answers.builtin_agents] },
    branch_pattern: answers.branch_pattern,
    autonomy_start: answers.autonomy_start,
    ceilings: answers.ceilings,
    tool_servers: { jira: answers.jira },
    // Carried through rather than rebuilt: no answer produces one, so the copy on disk is the only copy.
    ...(knowledge === undefined ? {} : { knowledge }),
  };
};

/** Every agent the answers enable, built-in and custom, in the order they are written. */
export const enabledAgents = (answers: Answers): readonly AgentDeclarationInput[] => [
  ...BUILT_IN_AGENTS.filter((agent) => answers.builtin_agents.includes(agent.id)),
  ...answers.custom_agents,
];

export const renderAgent = (agent: AgentDeclarationInput): AgentDeclaration => {
  // AD-17 — a declaration references a *registered* contract id, never an inline schema. The
  // registry's own refusal names every registered id, which is what a person needs to fix it.
  getContract(agent.contract);
  return AgentDeclarationSchema.parse({
    schema_version: CURRENT_SCHEMA_VERSION,
    id: agent.id,
    purpose: agent.purpose,
    contract: agent.contract,
    tools: [...agent.tools],
    mcp_domains: [...agent.mcp_domains],
    reversibility: agent.reversibility,
    model: { start_tier: agent.model.start_tier, promotion_policy: agent.model.promotion_policy },
  });
};

/**
 * Permissions: the tools the enabled roster grants between them, the gate table, and the egress
 * allowlist carrying question 9's *names*.
 *
 * The allowlist is where a credential would end up if one were ever collected, so this function is
 * the one to read when asking whether a value can reach `.orch/`: it copies the names the interview
 * validated and reads nothing from the environment.
 */
export const renderPermissions = (answers: Answers): Permissions => {
  const tools = new Set<string>();
  for (const agent of enabledAgents(answers)) for (const tool of agent.tools) tools.add(tool);
  return {
    schema_version: CURRENT_SCHEMA_VERSION,
    granted_tools: [...tools].sort(),
    gated_reversibility_classes: [...GATED_REVERSIBILITY_CLASSES],
    egress_allowlist: answers.external_domains.map((domain) => ({
      domain: domain.domain,
      credential_env: [...domain.credential_env],
    })),
  };
};

/** A parsed artifact, serialised. Parsing first is what makes the contract the writer's gate. */
const tomlFor = (value: TomlTable): string => serialiseToml(value);

/** The `.orch/` files an answer set produces, in the order they are written. */
export const renderFiles = (answers: Answers, repositoryPath: string): readonly WrittenFile[] => {
  const profile = ProfileSchema.parse(renderProfile(answers, repositoryPath));
  const permissions = PermissionsSchema.parse(renderPermissions(answers));
  const files: WrittenFile[] = [
    { path: relativeOrchPath(PROFILE_FILE_NAME), contents: tomlFor(profile) },
    { path: relativeOrchPath(PERMISSIONS_FILE_NAME), contents: tomlFor(permissions) },
  ];
  for (const agent of enabledAgents(answers)) {
    files.push({
      path: relativeOrchPath(AGENTS_DIR_NAME, `${agent.id}.toml`),
      contents: tomlFor(renderAgent(agent)),
    });
  }
  return files;
};

/** The manifest's own bytes, once every other file is known. */
export const renderManifest = (manifest: Manifest): WrittenFile => ({
  path: relativeOrchPath(MANIFEST_FILE_NAME),
  contents: tomlFor(ManifestSchema.parse(manifest)),
});

/**
 * Append the runtime paths to `.gitignore`, once.
 *
 * Idempotent per *line* rather than per block: matrix row 9 has a repository that already lists the
 * paths by hand, and appending a block because the installer's own header was absent would leave a
 * duplicate a person then has to clean up. A file with no trailing newline gets one first, so the
 * first appended line is its own line (row 10).
 */
export const appendGitignore = (gitignorePath: string): 'appended' | 'unchanged' => {
  const existing = existsSync(gitignorePath) ? readFileSync(gitignorePath, 'utf8') : '';
  const present = new Set(existing.split('\n').map((line) => line.trim()));
  const missing = GITIGNORE_LINES.filter((line) => !present.has(line));
  if (missing.length === 0) return 'unchanged';

  const separator = existing === '' || existing.endsWith('\n') ? '' : '\n';
  const block = `${GITIGNORE_HEADER}\n${missing.join('\n')}\n`;
  writeFileIfChanged(gitignorePath, `${existing}${separator}${block}`);
  return 'appended';
};

/**
 * Write everything, and answer with what each file did.
 *
 * The manifest is written last on purpose: it is the record of what exists, so a run killed part-way
 * leaves a manifest describing *less* than the tree rather than more. Over-promising is the
 * dangerous direction — a re-run trusting a manifest that listed files nobody wrote would report a
 * half-install as complete.
 */
export const writeInstall = (
  repository: string,
  answers: Answers,
  at: Date = new Date(),
): WriteOutcome => {
  const paths = orchPaths(repository);
  mkdirSync(paths.orchDir, { recursive: true });
  mkdirSync(paths.agentsDir, { recursive: true });

  const files = renderFiles(answers, repository);
  const dispositions: FileOutcome[] = [];
  for (const file of files) {
    const absolute = join(repository, ...file.path.split('/'));
    dispositions.push({ path: file.path, disposition: writeFileIfChanged(absolute, file.contents) });
  }

  const manifest = renderManifest(buildManifest(answers.project.id, files, at));
  dispositions.push({
    path: manifest.path,
    disposition: writeFileIfChanged(paths.manifest, manifest.contents),
  });

  return {
    files: [...files, manifest],
    dispositions,
    gitignore: appendGitignore(paths.gitignore),
  };
};
