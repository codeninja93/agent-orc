/**
 * AD-17 — the agent roster, discovered by reading a directory.
 *
 * "The engine discovers agents only by reading that directory and holds no compiled-in list." So this
 * module reads `.orch/agents/*.toml` and reports what is there, and there is no fallback anywhere in it:
 * an empty or absent directory is an **empty roster**, said plainly. The installer's `BUILT_IN_AGENTS`
 * is the installer's template for what to *write*, and ADR-003 has just pinned that array with tests —
 * which makes reusing it more tempting, not less, and is why `tests/engine.roster.test.ts` walks
 * `src/engine/` recursively and fails if anything under it imports the installer at all. A built-in
 * agent exists because its file is on disk, exactly as a user-defined one does; that is the whole
 * substance of AD-17, and a default would make a user-defined roster invisible to half the system.
 *
 * **Validation is parsing, because the constraints are already in the schemas.** AD-17 requires a
 * reference to a *registered* contract id and ADR-003 requires every granted tool name to be a declared
 * name; `AgentDeclarationSchema` enforces the tool vocabulary at parse and `getContract` refuses an
 * unregistered id with the registry's own list, exactly as `src/installer/write.ts` does on the way in.
 * Nothing here re-states either rule.
 *
 * **A bad entry is refused, and the others still load.** One unreadable TOML must not make a project
 * rosterless — that turns a typo in a sixth agent into "this repository has no agents", which reads like
 * a configuration decision. So refusals are collected, named, and reported beside the roster; the caller
 * decides what a refusal means for a run, and `refused` being non-empty is never silent.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import {
  AgentDeclarationSchema,
  SchemaVersionRefusal,
  getContract,
  parseToml,
  parseVersionedArtifact,
} from '../contracts/index.js';
import type { AgentDeclaration } from '../contracts/index.js';

import type { ConfigurationSource } from './profile.js';

/** The extension a roster file carries. Anything else in the directory is not an agent declaration. */
export const AGENT_FILE_EXTENSION = '.toml';

/** One declared agent, and the file that declared it. */
export interface RosterEntry {
  /** The agent id, which is also its file's base name — the two are checked against each other. */
  readonly id: string;
  readonly path: string;
  readonly declaration: AgentDeclaration;
}

/**
 * A file under `agents/` that is not a usable declaration.
 *
 * It carries the AD-35 `code` as well as a message so a caller routes it through the disposition table
 * rather than through the unknown-code fallback: an unrecognised `schema_version` is
 * `config.schema_version_unrecognised`, and everything else about a hand-edited TOML is
 * `config.invalid`. Both dispose to `escalate-to-human`, and they are told apart because they send a
 * person to two different places — one to the installer, the other to the file.
 */
export interface RosterRefusal {
  readonly path: string;
  readonly code: string;
  readonly reason: string;
}

/** What reading the roster directory found. */
export interface DiscoveredRoster {
  readonly agentsDir: string;
  /** The agents that loaded, ordered by id. Empty is a real answer, never a signal to fall back. */
  readonly agents: readonly RosterEntry[];
  readonly refused: readonly RosterRefusal[];
  readonly summary: string;
}

/**
 * Every `*.toml` in the directory, sorted, or nothing at all when there is no directory.
 *
 * Exported because the AD-9 snapshot copies the same set: run scope has to hold *every* roster file,
 * including one discovery refuses, or a step would see a smaller roster than run start did and the
 * snapshot would stop being a faithful copy of the configuration. One answer to "which files are the
 * roster", in the module that owns the question.
 */
export const rosterFileNames = (agentsDir: string): readonly string[] => {
  if (!existsSync(agentsDir)) return [];
  let names: readonly string[];
  try {
    names = readdirSync(agentsDir, { encoding: 'utf8' });
  } catch {
    // Unreadable is indistinguishable from absent for the purpose of discovery, and both are an empty
    // roster rather than an invented one.
    return [];
  }
  return names
    .filter((name) => name.endsWith(AGENT_FILE_EXTENSION))
    .filter((name) => {
      try {
        return statSync(join(agentsDir, name)).isFile();
      } catch {
        return false;
      }
    })
    /**
     * Sorted by file name, which decides the *discovery* order.
     *
     * `localeCompare` is used everywhere else in this codebase for a reported list, and is avoided
     * here: it is locale-sensitive, and the order of a roster is part of what a step is handed. Two
     * machines must discover the same agents in the same order, so the comparison is by code unit.
     */
    .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
};

const reasonOf = (error: unknown): { code: string; reason: string } => {
  if (error instanceof SchemaVersionRefusal) return { code: error.code, reason: error.message };
  if (error instanceof Error) {
    const code = 'code' in error && typeof error.code === 'string' ? error.code : 'config.invalid';
    return { code, reason: error.message };
  }
  return { code: 'config.invalid', reason: String(error) };
};

/**
 * Read one declaration, or say why it is not one.
 *
 * The file name is checked against the declared id (matrix row 14) because one entry cannot have two
 * names: `.orch/agents/reviewer.toml` declaring `id = "review"` would be discovered as `review` while
 * every person, every manifest line and every `git log` calls it `reviewer` — and the profile's roster
 * answer, which records *which built-ins were enabled*, is keyed by the same name.
 */
const readDeclaration = (agentsDir: string, fileName: string): RosterEntry | RosterRefusal => {
  const path = join(agentsDir, fileName);
  const expectedId = fileName.slice(0, -AGENT_FILE_EXTENSION.length);
  try {
    const declaration = parseVersionedArtifact(
      AgentDeclarationSchema,
      parseToml(readFileSync(path, 'utf8')),
      path,
    );
    if (declaration.id !== expectedId) {
      return {
        path,
        code: 'config.invalid',
        reason:
          `Refusing ${path}: it declares id "${declaration.id}" but its file name says ` +
          `"${expectedId}". AD-17 declares one agent per file in <target-repo>/.orch/agents/, so the ` +
          'file name and the id are one name — rename the file or the id so they agree.',
      };
    }
    // AD-17 — a declaration references a *registered* contract id, never an inline schema. The
    // registry's own refusal names every registered id, which is what a person needs to fix it, and it
    // is the same check `src/installer/write.ts` applies on the way in.
    getContract(declaration.contract);
    return { id: declaration.id, path, declaration };
  } catch (error) {
    const { code, reason } = reasonOf(error);
    return { path, code, reason };
  }
};

const isRefusal = (entry: RosterEntry | RosterRefusal): entry is RosterRefusal =>
  'reason' in entry;

const count = (value: number, singular: string, plural = `${singular}s`): string =>
  `${String(value)} ${value === 1 ? singular : plural}`;

const rosterSummary = (
  agentsDir: string,
  agents: readonly RosterEntry[],
  refused: readonly RosterRefusal[],
): string => {
  if (agents.length === 0 && refused.length === 0) {
    return (
      `No agents are declared in ${agentsDir}, so this roster is empty. That is the roster: AD-17 ` +
      'discovers agents only by reading that directory, and the engine holds no built-in list to fall ' +
      'back to. Re-run the installer, or write one TOML per agent there, to declare some.'
    );
  }
  const refusals =
    refused.length === 0 ? '' : `; ${count(refused.length, 'file')} refused: ${refused.map((entry) => entry.path).join(', ')}`;
  return (
    `${count(agents.length, 'agent')} declared in ${agentsDir}: ` +
    `${agents.map((entry) => entry.id).join(', ')}${refusals}.`
  );
};

/**
 * Discover the roster of a configuration source.
 *
 * It takes a {@link ConfigurationSource} for the same reason the profile loader does: run start
 * discovers from `<target-repo>/.orch/agents/`, a step discovers from the AD-9 snapshot, and neither
 * call site knows which one it is — so a step cannot be given the live directory by a caller that meant
 * well. The agents are ordered by id, which for a well-formed roster is the file order and is stable
 * across machines either way.
 */
export const discoverRoster = (source: ConfigurationSource): DiscoveredRoster => {
  const agents: RosterEntry[] = [];
  const refused: RosterRefusal[] = [];
  for (const fileName of rosterFileNames(source.agentsDir)) {
    const result = readDeclaration(source.agentsDir, fileName);
    if (isRefusal(result)) {
      refused.push(result);
      continue;
    }
    agents.push(result);
  }
  agents.sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  return {
    agentsDir: source.agentsDir,
    agents,
    refused,
    summary: rosterSummary(source.agentsDir, agents, refused),
  };
};

/** One agent by id, or `null` — a lookup, never a default. */
export const rosterAgent = (roster: DiscoveredRoster, id: string): RosterEntry | null =>
  roster.agents.find((entry) => entry.id === id) ?? null;
