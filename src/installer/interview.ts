/**
 * The thirteen questions of `build-sequencing.md`, as data.
 *
 * **The sequence is a value, not a script.** Every question carries its order, its prompt, the shape
 * of what it collects, how its default is arrived at, and the validator that turns typed text into
 * the answer an artifact records. That is what makes "ask only what is missing" a filter over a list
 * rather than a branch in a procedure, and what lets a test enumerate the interview without running
 * a terminal.
 *
 * **Wording is free; what a question produces is not.** `build-sequencing.md` says so outright, and
 * fixes the output by AD-9, AD-12, AD-17 and AD-28 instead. That is why {@link Prompt} carries a
 * stable `id` beside the human sentence: a caller — including a test — addresses a prompt by the
 * answer it collects, so nothing outside this file depends on how the sentence is phrased. A test
 * that matched on the sentence would pin the one thing the contract deliberately frees.
 *
 * **Question 9 collects names and refuses values.** AD-12 forbids the installer bundling any
 * credential, and the single authority on what looks like one is the AD-21 redaction pass in
 * `src/runtime/redaction.ts` — so {@link looksLikeCredentialValue} asks *it* rather than inventing a
 * second opinion. Nothing in this file reads `process.env`: the installer records the name a person
 * typed and never learns what it holds.
 */
import {
  ENV_VAR_NAME_PATTERN,
  MAX_ENV_VAR_NAME_LENGTH,
  MECHANICS_COMMAND_NAMES,
  MODEL_RUNGS,
  PACKAGE_MANAGERS,
  RESOURCE_NEEDS,
  REVERSIBILITY_CLASSES,
  RUN_MODES,
  isContractId,
} from '../contracts/index.js';
import type {
  Ceilings,
  ExternalDomain,
  MechanicsCommands,
  PackageManager,
  ResourceNeed,
  ReversibilityClass,
  RunMode,
} from '../contracts/index.js';
import { redactValue } from '../runtime/redaction.js';

import type { DetectedDefaults } from './detect.js';

/** An agent declaration as the interview collects it; the `schema_version` is the writer's to add. */
export interface AgentDeclarationInput {
  readonly id: string;
  readonly purpose: string;
  readonly contract: string;
  readonly tools: readonly string[];
  readonly mcp_domains: readonly string[];
  readonly reversibility: ReversibilityClass;
  readonly model: { readonly start_tier: string; readonly promotion_policy: 'on-gate-failure' | 'never' };
}

/**
 * The thirteen answers, keyed by question id.
 *
 * The key is the question's identity everywhere: in the interview list, in the prompt ids a caller
 * scripts against, and in the "what is still missing" filter. It is deliberately not the prompt.
 */
export interface Answers {
  readonly target_path: string;
  /** `remote` is empty when there is none: TOML has no null, so the artifact carries the same. */
  readonly project: { readonly id: string; readonly remote: string };
  readonly mechanics: {
    readonly package_manager: PackageManager;
    readonly commands: MechanicsCommands;
  };
  readonly source_layout: readonly string[];
  readonly resources: ResourceNeed;
  readonly high_blast_radius_paths: readonly string[];
  readonly conflict_domains: readonly string[];
  readonly branch_pattern: string;
  readonly external_domains: readonly ExternalDomain[];
  readonly builtin_agents: readonly string[];
  readonly custom_agents: readonly AgentDeclarationInput[];
  readonly autonomy_start: RunMode;
  readonly ceilings: Ceilings;
}

export type QuestionId = keyof Answers;

/** What is on disk so far. A key is absent exactly when its question still has to be asked. */
export type PartialAnswers = { readonly [K in QuestionId]?: Answers[K] };

/** Where a field's offered default comes from, stated so a reader never has to guess. */
export type DefaultSource =
  | { readonly kind: 'detected'; readonly from: string }
  | { readonly kind: 'fixed'; readonly value: string }
  | { readonly kind: 'none' };

export interface FieldSpec {
  /** Stable, and part of the prompt id a caller addresses this field by. */
  readonly key: string;
  readonly prompt: string;
  readonly defaultSource: DefaultSource;
  /** The suggestion to offer for this repository, or `null` when there is none to offer. */
  readonly suggest: (detected: DetectedDefaults) => string | null;
}

export type QuestionForm =
  | { readonly kind: 'fields'; readonly fields: readonly FieldSpec[] }
  | { readonly kind: 'repeating'; readonly entry: readonly FieldSpec[] };

/** One entry's raw text, keyed by {@link FieldSpec.key}; a repeating question collects a list. */
export type RawEntry = Readonly<Record<string, string>>;

export type RawAnswer = RawEntry | readonly RawEntry[];

export type Parsed<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly refusal: string };

export interface InterviewQuestion<K extends QuestionId> {
  /** 1 to 13, in `build-sequencing.md`'s order. */
  readonly order: number;
  readonly id: K;
  readonly prompt: string;
  readonly form: QuestionForm;
  readonly parse: (raw: RawAnswer, detected: DetectedDefaults) => Parsed<Pick<Answers, K>>;
}

/** Any of the thirteen, keeping each one's key bound to its own answer type. */
export type AnyQuestion = { [K in QuestionId]: InterviewQuestion<K> }[QuestionId];

/** Identity, for the inference it gives each literal below. */
const question = <K extends QuestionId>(spec: InterviewQuestion<K>): InterviewQuestion<K> => spec;

const refuse = (refusal: string): { ok: false; refusal: string } => ({ ok: false, refusal });

/** A comma-separated list, with blanks dropped, so an empty answer is an empty list. */
const list = (raw: string): readonly string[] =>
  raw
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item !== '');

const isEntryList = (raw: RawAnswer): raw is readonly RawEntry[] => Array.isArray(raw);

const entries = (raw: RawAnswer): readonly RawEntry[] => (isEntryList(raw) ? raw : [raw]);

const single = (raw: RawAnswer): RawEntry => entries(raw)[0] ?? {};

const field = (raw: RawAnswer, key: string): string => (single(raw)[key] ?? '').trim();

const detectedFrom = (from: string): DefaultSource => ({ kind: 'detected', from });

const fixed = (value: string): DefaultSource => ({ kind: 'fixed', value });

const noDefault: DefaultSource = { kind: 'none' };

const always = (value: string) => (): string => value;

const noSuggestion = (): null => null;

/**
 * The built-in roster of stage 2, which question 10 enables by writing one TOML each (AD-17).
 *
 * The engine holds no compiled-in list — it discovers agents by reading `.orch/agents/` — so this is
 * the installer's list of what it can *write*, not the system's list of what exists. An agent added
 * here becomes an offer at question 10 and nothing else; the implementations are stories 2-3 to 2-7.
 *
 * Each references a *registered* contract id (AD-17), never an inline schema. Four of the six reference
 * `step.output`, the shared step envelope: a roster member that needs a genuinely new contract shape needs an
 * engine change, and those four do not. `analysis` and `planning` do — story 2-4 registered `step.analysis`
 * and `step.planning`, whose shapes carry per-claim provenance and a declared territory — and they name them
 * here. A declaration naming `step.output` while its agent's contract pins `contract_id` to its own id is a
 * pairing that can never both hold: every refusal the new contract adds would be dead for a default install,
 * with nothing able to notice. `tests/contracts.agent-grants.test.ts` pins the contract id beside the grant
 * for exactly that reason.
 */
export const BUILT_IN_AGENTS: readonly AgentDeclarationInput[] = Object.freeze([
  {
    id: 'analysis',
    purpose: 'Read the repository and the request, and state what the work actually is.',
    contract: 'step.analysis',
    tools: ['Read', 'Grep', 'Glob'],
    mcp_domains: [],
    reversibility: 'reversible',
    model: { start_tier: 'claude-haiku-4-5', promotion_policy: 'on-gate-failure' },
  },
  {
    id: 'planning',
    purpose: 'Turn the analysis into ordered steps with declared file territories.',
    contract: 'step.planning',
    tools: ['Read', 'Grep', 'Glob'],
    mcp_domains: [],
    reversibility: 'reversible',
    model: { start_tier: 'claude-sonnet-5', promotion_policy: 'on-gate-failure' },
  },
  {
    id: 'implementation',
    purpose: 'Write the change in the run worktree, against the plan.',
    contract: 'step.output',
    tools: ['Read', 'Write', 'Edit', 'Grep', 'Glob', 'Bash'],
    mcp_domains: [],
    reversibility: 'recoverable',
    model: { start_tier: 'claude-sonnet-5', promotion_policy: 'on-gate-failure' },
  },
  {
    id: 'testing',
    purpose: 'Write and run the tests that decide whether the change did what was asked.',
    contract: 'step.output',
    tools: ['Read', 'Write', 'Edit', 'Grep', 'Glob', 'Bash'],
    mcp_domains: [],
    reversibility: 'recoverable',
    model: { start_tier: 'claude-sonnet-5', promotion_policy: 'on-gate-failure' },
  },
  {
    id: 'verification',
    purpose: 'Run the declared gates and report what was verified and what was not.',
    contract: 'step.output',
    tools: ['Read', 'Grep', 'Glob', 'Bash'],
    mcp_domains: [],
    reversibility: 'reversible',
    model: { start_tier: 'claude-haiku-4-5', promotion_policy: 'on-gate-failure' },
  },
  {
    id: 'committing',
    // AD-15 names the committer while forbidding exactly this: pull request creation, `git push`, notes
    // and tags are engine-executed write intents that no agent may perform. So this agent reads the diff
    // and composes the intent; the engine executes it once against an idempotency key. It holds no `Bash`,
    // because that is the one tool that would let the roster's only irreversible agent do the write itself
    // (ADR-003).
    purpose: 'Read the change and compose the write intent the engine executes to open the pull request and record the AD-22 note.',
    contract: 'step.output',
    tools: ['Read', 'Grep', 'Glob'],
    mcp_domains: [],
    reversibility: 'irreversible',
    model: { start_tier: 'claude-sonnet-5', promotion_policy: 'never' },
  },
]);

export const BUILT_IN_AGENT_IDS: readonly string[] = BUILT_IN_AGENTS.map((agent) => agent.id);

/** An agent id is a file name under `.orch/agents/`, so it may hold nothing a path can mean. */
export const AGENT_ID_PATTERN = /^[a-z][a-z0-9-]*$/;

/**
 * True when the answer looks like the credential rather than like the name of the variable holding
 * it.
 *
 * The judgement is the AD-21 redaction pass's, not a second opinion: if the pass would rewrite this
 * string in an event payload, it is secret-shaped, and secret-shaped is exactly what must not reach
 * `.orch/`. Asking the existing authority also means a token family added to the redactor is
 * refused here on the same day, rather than the two drifting apart.
 */
export const looksLikeCredentialValue = (candidate: string): boolean => {
  const pass = redactValue(candidate);
  return !pass.ok || pass.value !== candidate;
};

export const isEnvVarName = (candidate: string): boolean =>
  candidate.length <= MAX_ENV_VAR_NAME_LENGTH &&
  ENV_VAR_NAME_PATTERN.test(candidate) &&
  !looksLikeCredentialValue(candidate);

/** The refusal for question 9, which has to name the distinction rather than just say "invalid". */
export const credentialNameRefusal = (candidate: string): string =>
  `"${candidate}" is not the name of an environment variable. This question collects the NAME of ` +
  'the variable that holds the credential — ANTHROPIC_API_KEY, JIRA_API_TOKEN — and never the ' +
  'credential itself: AD-12 says the installer bundles no credential, and nothing you type here is ' +
  'ever looked up in the environment. A name is upper snake case, at most ' +
  `${String(MAX_ENV_VAR_NAME_LENGTH)} characters, and is not something the redaction pass would ` +
  'treat as secret material. If you have pasted a value, remove it from your shell history too.';

const parseCeiling = (raw: string, name: string, max: number): number | string => {
  if (!/^\d+$/.test(raw)) return `${name} must be a whole number; "${raw}" is not one.`;
  const value = Number(raw);
  if (value < 1 || value > max) return `${name} must be between 1 and ${String(max)}; ${raw} is not.`;
  return value;
};

/** AD-24's third ceiling is a share of the rate-limit window, so its maximum is a hundred percent. */
export const MAX_RATE_LIMIT_BUDGET_PERCENT = 100;

/** Bounds that exist so a typo cannot declare a ceiling no run could reach. */
export const MAX_CEILING_STEPS = 10_000;
export const MAX_CEILING_WALL_CLOCK_MINUTES = 10_080;

export const DEFAULT_BRANCH_PATTERN = 'feature/<slug>';

/** The thirteen, in `build-sequencing.md`'s order. */
export const INTERVIEW: readonly AnyQuestion[] = Object.freeze([
  question({
    order: 1,
    id: 'target_path',
    prompt: 'Which repository is being onboarded?',
    form: {
      kind: 'fields',
      fields: [
        {
          key: 'path',
          prompt: 'Repository path',
          defaultSource: detectedFrom('the path the installer was pointed at'),
          suggest: (detected): string => detected.repositoryPath,
        },
      ],
    },
    parse: (raw) => {
      const path = field(raw, 'path');
      if (path === '') return refuse('A repository path is required; there is no default to fall back to.');
      return { ok: true, value: { target_path: path } };
    },
  }),
  question({
    order: 2,
    id: 'project',
    prompt: 'Confirm the project id and remote.',
    form: {
      kind: 'fields',
      fields: [
        {
          key: 'id',
          prompt: 'Project id (the first-commit SHA)',
          defaultSource: detectedFrom('git rev-list --max-parents=0 HEAD'),
          suggest: (detected): string | null => detected.firstCommitSha,
        },
        {
          key: 'remote',
          prompt: 'Git remote (blank for none)',
          defaultSource: detectedFrom('git remote get-url origin'),
          suggest: (detected): string | null => detected.remote,
        },
      ],
    },
    parse: (raw) => {
      const id = field(raw, 'id');
      // AD-10 — the id is a commit SHA and the whole registration is keyed by it; a typo here would
      // split one project into two central records, which is the failure AD-10 exists to prevent.
      if (!/^[0-9a-f]{40}$/.test(id)) {
        return refuse(
          `"${id}" is not a commit SHA. The project id is the SHA of this repository's first commit ` +
            '(AD-10), forty hexadecimal characters, and it is confirmed rather than invented.',
        );
      }
      return { ok: true, value: { project: { id, remote: field(raw, 'remote') } } };
    },
  }),
  question({
    order: 3,
    id: 'mechanics',
    prompt: 'How is this repository built and checked?',
    form: {
      kind: 'fields',
      fields: [
        {
          key: 'package_manager',
          prompt: `Package manager (${PACKAGE_MANAGERS.join(', ')})`,
          defaultSource: detectedFrom('the lockfile in the repository root'),
          suggest: (detected): string | null => detected.packageManager,
        },
        ...MECHANICS_COMMAND_NAMES.map((name) => ({
          key: name,
          prompt: `${name[0]?.toUpperCase() ?? ''}${name.slice(1)} command (blank if there is none)`,
          defaultSource: detectedFrom('the scripts in package.json'),
          suggest: (detected: DetectedDefaults): string | null => {
            const command = detected.commands[name];
            return command === '' ? null : command;
          },
        })),
      ],
    },
    parse: (raw) => {
      const manager = field(raw, 'package_manager');
      if (!(PACKAGE_MANAGERS as readonly string[]).includes(manager)) {
        return refuse(
          `"${manager}" is not one of ${PACKAGE_MANAGERS.join(', ')}. Pick "other" for a repository ` +
            'built by something else; the four commands beside it are free text.',
        );
      }
      const commands: MechanicsCommands = {
        test: field(raw, 'test'),
        lint: field(raw, 'lint'),
        build: field(raw, 'build'),
        run: field(raw, 'run'),
      };
      return {
        ok: true,
        value: { mechanics: { package_manager: manager as PackageManager, commands } },
      };
    },
  }),
  question({
    order: 4,
    id: 'source_layout',
    prompt: 'Where does the code live?',
    form: {
      kind: 'fields',
      fields: [
        {
          key: 'directories',
          prompt: 'Source directories, comma-separated',
          defaultSource: detectedFrom('the directories present in the repository root'),
          suggest: (detected): string | null =>
            detected.sourceLayout.length === 0 ? null : detected.sourceLayout.join(', '),
        },
      ],
    },
    parse: (raw) => {
      const directories = list(field(raw, 'directories'));
      if (directories.length === 0) {
        return refuse('At least one source directory is required; a run has to know where code lives.');
      }
      return { ok: true, value: { source_layout: directories } };
    },
  }),
  question({
    order: 5,
    id: 'resources',
    prompt: 'What does a run of this repository need?',
    form: {
      kind: 'fields',
      fields: [
        {
          key: 'resources',
          prompt: `Resources (${RESOURCE_NEEDS.join(', ')})`,
          defaultSource: fixed('none'),
          suggest: always('none'),
        },
      ],
    },
    parse: (raw) => {
      const answer = field(raw, 'resources');
      if (!(RESOURCE_NEEDS as readonly string[]).includes(answer)) {
        return refuse(`"${answer}" is not one of ${RESOURCE_NEEDS.join(', ')}.`);
      }
      return { ok: true, value: { resources: answer as ResourceNeed } };
    },
  }),
  question({
    order: 6,
    id: 'high_blast_radius_paths',
    prompt: 'Which paths should force a higher isolation tier?',
    form: {
      kind: 'fields',
      fields: [
        {
          key: 'paths',
          prompt: 'High-blast-radius paths, comma-separated (blank for none)',
          defaultSource: noDefault,
          suggest: noSuggestion,
        },
      ],
    },
    parse: (raw) => ({ ok: true, value: { high_blast_radius_paths: list(field(raw, 'paths')) } }),
  }),
  question({
    order: 7,
    id: 'conflict_domains',
    prompt: 'Which directories must not be worked on concurrently?',
    form: {
      kind: 'fields',
      fields: [
        {
          key: 'domains',
          prompt: 'Conflict-domain directories, comma-separated (blank for none)',
          defaultSource: noDefault,
          suggest: noSuggestion,
        },
      ],
    },
    parse: (raw) => ({ ok: true, value: { conflict_domains: list(field(raw, 'domains')) } }),
  }),
  question({
    order: 8,
    id: 'branch_pattern',
    prompt: 'What should a feature branch be called?',
    form: {
      kind: 'fields',
      fields: [
        {
          key: 'pattern',
          prompt: 'Branch-name pattern',
          defaultSource: fixed(DEFAULT_BRANCH_PATTERN),
          suggest: always(DEFAULT_BRANCH_PATTERN),
        },
      ],
    },
    parse: (raw) => {
      const pattern = field(raw, 'pattern');
      if (!pattern.includes('<slug>')) {
        return refuse(
          `"${pattern}" carries no <slug>, so every feature would land on the same branch. The ` +
            'pattern is a template: <slug> is replaced by the feature slug.',
        );
      }
      return { ok: true, value: { branch_pattern: pattern } };
    },
  }),
  question({
    order: 9,
    id: 'external_domains',
    prompt: 'Which external domains should be enabled, and which variables hold their credentials?',
    form: {
      kind: 'repeating',
      entry: [
        {
          key: 'domain',
          prompt: 'Domain (blank to stop)',
          defaultSource: noDefault,
          suggest: noSuggestion,
        },
        {
          key: 'credential_env',
          prompt: 'Environment variable NAMES holding its credentials, comma-separated',
          defaultSource: noDefault,
          suggest: noSuggestion,
        },
      ],
    },
    parse: (raw) => {
      const collected: ExternalDomain[] = [];
      for (const entry of entries(raw)) {
        const domain = (entry['domain'] ?? '').trim();
        if (domain === '') continue;
        const names = list(entry['credential_env'] ?? '');
        for (const name of names) {
          if (!isEnvVarName(name)) return refuse(credentialNameRefusal(name));
        }
        collected.push({ domain, credential_env: [...names] });
      }
      return { ok: true, value: { external_domains: collected } };
    },
  }),
  question({
    order: 10,
    id: 'builtin_agents',
    prompt: 'Which built-in agents should be enabled?',
    form: {
      kind: 'fields',
      fields: [
        {
          key: 'agents',
          prompt: `Built-in agents, comma-separated (${BUILT_IN_AGENT_IDS.join(', ')})`,
          defaultSource: fixed(BUILT_IN_AGENT_IDS.join(', ')),
          suggest: always(BUILT_IN_AGENT_IDS.join(', ')),
        },
      ],
    },
    parse: (raw) => {
      const chosen = list(field(raw, 'agents'));
      const unknown = chosen.filter((id) => !BUILT_IN_AGENT_IDS.includes(id));
      if (unknown.length > 0) {
        return refuse(
          `${unknown.join(', ')} ${unknown.length === 1 ? 'is not a' : 'are not'} built-in agent` +
            `${unknown.length === 1 ? '' : 's'}. The built-ins are ${BUILT_IN_AGENT_IDS.join(', ')}; ` +
            'anything else is a custom agent, which the next question collects.',
        );
      }
      return { ok: true, value: { builtin_agents: chosen } };
    },
  }),
  question({
    order: 11,
    id: 'custom_agents',
    prompt: 'Are there custom agents to declare?',
    form: {
      kind: 'repeating',
      entry: [
        { key: 'id', prompt: 'Agent id (blank to stop)', defaultSource: noDefault, suggest: noSuggestion },
        { key: 'purpose', prompt: 'What it is for', defaultSource: noDefault, suggest: noSuggestion },
        {
          key: 'contract',
          prompt: 'Registered contract id it uses',
          defaultSource: fixed('step.output'),
          suggest: always('step.output'),
        },
        { key: 'tools', prompt: 'Tools granted, comma-separated', defaultSource: noDefault, suggest: noSuggestion },
        {
          key: 'mcp_domains',
          prompt: 'MCP domains granted, comma-separated',
          defaultSource: noDefault,
          suggest: noSuggestion,
        },
        {
          key: 'start_tier',
          prompt: `Starting model rung (${MODEL_RUNGS.join(', ')})`,
          defaultSource: fixed('claude-haiku-4-5'),
          suggest: always('claude-haiku-4-5'),
        },
        {
          key: 'reversibility',
          prompt: `Reversibility class (${REVERSIBILITY_CLASSES.join(', ')})`,
          defaultSource: fixed('reversible'),
          suggest: always('reversible'),
        },
      ],
    },
    parse: (raw) => {
      const collected: AgentDeclarationInput[] = [];
      for (const entry of entries(raw)) {
        const id = (entry['id'] ?? '').trim();
        if (id === '') continue;
        if (!AGENT_ID_PATTERN.test(id)) {
          return refuse(
            `"${id}" is not an agent id. An id names a file under .orch/agents/, so it is lower ` +
              'kebab case and nothing a path could otherwise mean.',
          );
        }
        if (BUILT_IN_AGENT_IDS.includes(id)) {
          return refuse(
            `"${id}" is a built-in agent. Enable it at the previous question rather than ` +
              'redeclaring it, or give the custom agent its own id.',
          );
        }
        const contract = (entry['contract'] ?? '').trim();
        // AD-17 — a declaration references a *registered* contract id, never an inline schema.
        if (!isContractId(contract)) {
          return refuse(
            `"${contract}" is not a registered contract id. AD-17: an agent references a contract ` +
              'registered in code, because AD-2 puts every schema in code.',
          );
        }
        const tier = (entry['start_tier'] ?? '').trim();
        if (!(MODEL_RUNGS as readonly string[]).includes(tier)) {
          return refuse(`"${tier}" is not one of ${MODEL_RUNGS.join(', ')}.`);
        }
        const reversibility = (entry['reversibility'] ?? '').trim();
        if (!(REVERSIBILITY_CLASSES as readonly string[]).includes(reversibility)) {
          return refuse(`"${reversibility}" is not one of ${REVERSIBILITY_CLASSES.join(', ')}.`);
        }
        collected.push({
          id,
          purpose: (entry['purpose'] ?? '').trim(),
          contract,
          tools: list(entry['tools'] ?? ''),
          mcp_domains: list(entry['mcp_domains'] ?? ''),
          reversibility: reversibility as ReversibilityClass,
          model: { start_tier: tier, promotion_policy: 'on-gate-failure' },
        });
      }
      return { ok: true, value: { custom_agents: collected } };
    },
  }),
  question({
    order: 12,
    id: 'autonomy_start',
    prompt: 'How much autonomy should this project start with?',
    form: {
      kind: 'fields',
      fields: [
        {
          key: 'autonomy',
          prompt: `Autonomy start level (${RUN_MODES.join(', ')})`,
          defaultSource: fixed('shadow'),
          suggest: always('shadow'),
        },
      ],
    },
    parse: (raw) => {
      const answer = field(raw, 'autonomy');
      if (!(RUN_MODES as readonly string[]).includes(answer)) {
        return refuse(
          `"${answer}" is not one of ${RUN_MODES.join(', ')}. "shadow" analyses and proposes and ` +
            'writes nothing (AD-27); "live" lets a run reach the write surface AD-15 enumerates.',
        );
      }
      return { ok: true, value: { autonomy_start: answer as RunMode } };
    },
  }),
  question({
    order: 13,
    id: 'ceilings',
    prompt: 'What should a run’s ceilings be?',
    form: {
      kind: 'fields',
      fields: [
        { key: 'steps', prompt: 'Maximum steps in a run', defaultSource: fixed('60'), suggest: always('60') },
        {
          key: 'wall_clock_minutes',
          prompt: 'Maximum wall-clock minutes',
          defaultSource: fixed('120'),
          suggest: always('120'),
        },
        {
          key: 'rate_limit_budget_percent',
          prompt: 'Maximum share of the rate-limit window, in percent',
          defaultSource: fixed('50'),
          suggest: always('50'),
        },
      ],
    },
    parse: (raw) => {
      const steps = parseCeiling(field(raw, 'steps'), 'The step ceiling', MAX_CEILING_STEPS);
      if (typeof steps === 'string') return refuse(steps);
      const minutes = parseCeiling(
        field(raw, 'wall_clock_minutes'),
        'The wall-clock ceiling',
        MAX_CEILING_WALL_CLOCK_MINUTES,
      );
      if (typeof minutes === 'string') return refuse(minutes);
      const percent = parseCeiling(
        field(raw, 'rate_limit_budget_percent'),
        'The rate-limit budget ceiling',
        MAX_RATE_LIMIT_BUDGET_PERCENT,
      );
      if (typeof percent === 'string') return refuse(percent);
      return {
        ok: true,
        value: {
          ceilings: {
            steps,
            wall_clock_minutes: minutes,
            rate_limit_budget_percent: percent,
          },
        },
      };
    },
  }),
]);

/** The questions whose answers are not on disk yet, in order. */
export const missingQuestions = (answers: PartialAnswers): readonly AnyQuestion[] =>
  INTERVIEW.filter((entry) => answers[entry.id] === undefined);

/**
 * One prompt put to a person.
 *
 * `id` is stable and `question` is not: a caller — a terminal, a test — decides what to answer from
 * the id, which is `<question-id>` or `<question-id>.<field-key>`. That is the mechanism by which
 * `build-sequencing.md`'s "wording is free to change" stays true of this code.
 */
export interface Prompt {
  readonly id: string;
  readonly question: string;
  readonly suggestion: string | null;
}

export interface InterviewIo {
  readonly ask: (prompt: Prompt) => Promise<string>;
  /** Everything the person is told that is not a question: a refusal, or what was recovered. */
  readonly say: (line: string) => void;
}

/** The prompt id a field is addressed by. */
export const promptId = (questionId: QuestionId, fieldKey: string): string =>
  `${questionId}.${fieldKey}`;

/** How many times a refused answer is re-asked before the install gives up rather than looping. */
export const MAX_ATTEMPTS_PER_QUESTION = 5;

/** A bound on a repeating question, so a caller that always answers "one more" still terminates. */
export const MAX_REPEATING_ENTRIES = 64;

export class InterviewAbandoned extends Error {
  readonly code = 'config.invalid';
  readonly questionId: QuestionId;

  constructor(questionId: QuestionId, attempts: number) {
    super(
      `Giving up on question "${questionId}" after ${String(attempts)} refused answers. Nothing has ` +
        'been written: the install is abandoned rather than completed with an answer that did not ' +
        'validate.',
    );
    this.name = 'InterviewAbandoned';
    this.questionId = questionId;
  }
}

const collectEntry = async (
  fields: readonly FieldSpec[],
  questionId: QuestionId,
  io: InterviewIo,
  detected: DetectedDefaults,
  /**
   * Repeating questions only: a blank first field ends the list, so the remaining fields of an entry
   * that is not going to exist are never put to anybody. A fixed-field question asks all of its
   * fields whatever the first one said, because a blank there is an answer its validator judges.
   */
  stopOnBlankFirstField: boolean,
): Promise<RawEntry> => {
  const collected: Record<string, string> = {};
  for (const [index, spec] of fields.entries()) {
    const suggestion = spec.suggest(detected);
    const typed = await io.ask({
      id: promptId(questionId, spec.key),
      question: spec.prompt,
      suggestion,
    });
    // An empty answer takes the offered default. That is what makes a detected default a default:
    // matrix row 12 wants it offered, and a person who agrees should not have to retype it.
    collected[spec.key] = typed.trim() === '' ? (suggestion ?? '') : typed.trim();
    if (stopOnBlankFirstField && index === 0 && collected[spec.key] === '') break;
  }
  return collected;
};

/** Ask one question until it validates, and answer with the patch it produced. */
export const askQuestion = async (
  entry: AnyQuestion,
  io: InterviewIo,
  detected: DetectedDefaults,
): Promise<PartialAnswers> => {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS_PER_QUESTION; attempt += 1) {
    let raw: RawAnswer;
    if (entry.form.kind === 'fields') {
      raw = await collectEntry(entry.form.fields, entry.id, io, detected, false);
    } else {
      const collected: RawEntry[] = [];
      for (let index = 0; index < MAX_REPEATING_ENTRIES; index += 1) {
        const one = await collectEntry(entry.form.entry, entry.id, io, detected, true);
        const first = entry.form.entry[0];
        if (first === undefined || (one[first.key] ?? '') === '') break;
        collected.push(one);
      }
      raw = collected;
    }
    const parsed = entry.parse(raw, detected);
    if (parsed.ok) return parsed.value;
    io.say(parsed.refusal);
  }
  throw new InterviewAbandoned(entry.id, MAX_ATTEMPTS_PER_QUESTION);
};

export interface InterviewResult {
  readonly answers: PartialAnswers;
  /** Exactly the questions that were put to a person, in order. */
  readonly asked: readonly QuestionId[];
}

/**
 * Ask only what is missing, and answer with what is now known.
 *
 * AD-12's upgrade path *is* a re-run, so "ask only what is missing" is the contract rather than a
 * convenience: an install that re-asked a settled question would be an upgrade that quietly changed
 * an answer a person had already given.
 */
export const runInterview = async (
  existing: PartialAnswers,
  io: InterviewIo,
  detected: DetectedDefaults,
): Promise<InterviewResult> => {
  let answers: PartialAnswers = existing;
  const asked: QuestionId[] = [];
  for (const entry of missingQuestions(existing)) {
    answers = { ...answers, ...(await askQuestion(entry, io, detected)) };
    asked.push(entry.id);
  }
  return { answers, asked };
};

/** Every answer, or `null` when one is still missing — the type guard the writer needs. */
export const completeAnswers = (answers: PartialAnswers): Answers | null =>
  missingQuestions(answers).length === 0 ? (answers as Answers) : null;
