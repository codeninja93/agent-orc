/**
 * AD-17 — the contract registry. An agent's TOML declaration references a contract by *id*, never
 * an inline schema, because AD-2 requires every schema to be a Zod schema in code. Adding an agent
 * that reuses a registered contract therefore needs no engine change.
 *
 * AD-2 — this module owns the only call to `z.toJSONSchema` in the package, and always passes
 * `{ target: "draft-7" }`. Zod 4 defaults to draft-2020-12, which `claude -p --json-schema`
 * rejects at spawn time; keeping the call in one place is what stops the argument being forgotten
 * at a call site. `tests/contracts.round-trip.test.ts` asserts no other file calls it.
 */
import { z } from 'zod';

import { ADVERSARIAL_CONTRACT_ID, AdversarialOutputSchema } from './adversarial.js';
import { ANALYSIS_CONTRACT_ID, AnalysisOutputSchema } from './analysis.js';
import { BOOTSTRAP_CONTRACT_ID, BootstrapAnalysisSchema } from './bootstrap.js';
import { COMMITTING_CONTRACT_ID, CommittingOutputSchema } from './committing.js';
import { CommandIntentSchema } from './command.js';
import { NOTE_CONTRACT_ID, GitNoteSchema } from './note.js';
import { EventEnvelopeSchema } from './event.js';
import { OrchErrorSchema } from './error.js';
import { FetchRecordSchema } from './fetch.js';
import { IMPLEMENTATION_CONTRACT_ID, ImplementationOutputSchema } from './implementation.js';
import {
  AgentDeclarationSchema,
  ManifestSchema,
  PermissionsSchema,
  ProfileSchema,
} from './installer.js';
import { PLANNING_CONTRACT_ID, PlanningOutputSchema } from './planning.js';
import { ProjectRegistrationSchema } from './project.js';
import { QuestionStateSchema } from './question.js';
import { RunStateSchema } from './state.js';
import { StepInputSchema, StepOutputSchema } from './step.js';
import { TESTING_CONTRACT_ID, TestingOutputSchema } from './testing.js';
import { VERIFICATION_CONTRACT_ID, VerificationOutputSchema } from './verification.js';

/**
 * What a contract is for, which decides what is asserted about it:
 * - `step` — handed to `claude -p --json-schema`; bound by the structured-outputs subset and
 *   required to have a recorded real `structured_output` fixture (AD-2, AD-31).
 * - `artifact` — an on-disk configuration or state file; carries `schema_version` (AD-28).
 * - `event` — the event envelope; forward-compatible by the ignore-unknown-types rule (AD-5).
 * - `support` — a shape embedded in the others, not itself an artifact.
 */
export const CONTRACT_KINDS = ['step', 'artifact', 'event', 'support'] as const;

export type ContractKind = (typeof CONTRACT_KINDS)[number];

export interface ContractEntry {
  readonly id: string;
  readonly kind: ContractKind;
  readonly description: string;
  /**
   * True when a model produces instances of this contract, i.e. it is handed to
   * `claude -p --json-schema` and comes back as `structured_output`. Only those contracts can have a
   * *recorded real* fixture (AD-31); a step's input file is written by the engine, not by a model.
   */
  readonly model_produced: boolean;
  readonly schema: z.ZodType;
}

/** The registry. Keyed by the contract id an agent TOML references. */
export const CONTRACTS = {
  'event.envelope': {
    id: 'event.envelope',
    kind: 'event',
    description: 'The AD-5 event envelope shared by every emitter.',
    model_produced: false,
    schema: EventEnvelopeSchema,
  },
  'command.intent': {
    id: 'command.intent',
    kind: 'artifact',
    description: 'A durable steering intent file under runs/<run-id>/commands/ (AD-19).',
    model_produced: false,
    schema: CommandIntentSchema,
  },
  'question.state': {
    id: 'question.state',
    kind: 'artifact',
    description: 'The compare-and-set question state file under runs/<run-id>/questions/ (AD-25).',
    model_produced: false,
    schema: QuestionStateSchema,
  },
  'fetch.record': {
    id: 'fetch.record',
    kind: 'artifact',
    description:
      'The run shared fetch record at runs/<run-id>/fetch-record.json (AD-13, AD-14, AD-28).',
    model_produced: false,
    schema: FetchRecordSchema,
  },
  'run.state': {
    id: 'run.state',
    kind: 'artifact',
    description:
      'The rebuildable run checkpoint at runs/<run-id>/state.json, written only by the reconciler ' +
      '(AD-4, AD-7, AD-28).',
    model_produced: false,
    schema: RunStateSchema,
  },
  'installer.profile': {
    id: 'installer.profile',
    kind: 'artifact',
    description:
      'The per-repo profile at <target-repo>/.orch/profile.toml, written by the installer (AD-9, ' +
      'AD-16, AD-28).',
    model_produced: false,
    schema: ProfileSchema,
  },
  'installer.agent': {
    id: 'installer.agent',
    kind: 'artifact',
    description:
      'One agent declaration at <target-repo>/.orch/agents/<agent-id>.toml, referencing a ' +
      'registered contract id (AD-17, AD-28).',
    model_produced: false,
    schema: AgentDeclarationSchema,
  },
  'installer.permissions': {
    id: 'installer.permissions',
    kind: 'artifact',
    description:
      'Granted tools, the reversibility gate table and the egress allowlist at ' +
      '<target-repo>/.orch/permissions.toml (AD-9, AD-13, AD-28).',
    model_produced: false,
    schema: PermissionsSchema,
  },
  'installer.manifest': {
    id: 'installer.manifest',
    kind: 'artifact',
    description:
      'Every file the installer created, at <target-repo>/.orch/manifest.toml, so a half-install ' +
      'is detectable and recoverable (AD-12, AD-28).',
    model_produced: false,
    schema: ManifestSchema,
  },
  'project.registration': {
    id: 'project.registration',
    kind: 'artifact',
    description:
      'The central registration record at ORCH_HOME/projects/<project-id>/registration.json, keyed ' +
      'by the first-commit SHA (AD-9, AD-10, AD-28, AD-33).',
    model_produced: false,
    schema: ProjectRegistrationSchema,
  },
  'error.shape': {
    id: 'error.shape',
    kind: 'support',
    description: 'The error shape every failure crossing a unit boundary uses (AD-35).',
    model_produced: false,
    schema: OrchErrorSchema,
  },
  'step.input': {
    id: 'step.input',
    kind: 'step',
    description: 'The typed input file a step agent is a pure function over.',
    model_produced: false,
    schema: StepInputSchema,
  },
  'step.output': {
    id: 'step.output',
    kind: 'step',
    description: 'The typed output a step agent produces, passed to claude -p --json-schema.',
    model_produced: true,
    schema: StepOutputSchema,
  },
  /**
   * The two phase-specific output contracts of story 2-4.
   *
   * Registered rather than reusing `step.output` because AD-17 has a roster entry reference a contract by
   * *id*: two agents sharing one id cannot be told apart by anything the engine reads, and the shapes
   * genuinely differ — claims with per-claim provenance on one, an ordered plan on the other. Both are
   * `model_produced`, so AD-31 requires each a recorded real `structured_output` fixture, and both stay
   * inside the AD-2 structured-outputs subset.
   */
  [ANALYSIS_CONTRACT_ID]: {
    id: ANALYSIS_CONTRACT_ID,
    kind: 'step',
    description:
      'The analysis agent\'s output: claims carrying per-claim provenance, the territory the feature ' +
      'touches, and the files that were read (architecture.md Agent contract, ADR-003).',
    model_produced: true,
    schema: AnalysisOutputSchema,
  },
  [PLANNING_CONTRACT_ID]: {
    id: PLANNING_CONTRACT_ID,
    kind: 'step',
    description:
      'The planning agent\'s output: the ordered steps, each carrying its provenance and the paths it ' +
      'expects to touch, inside the declared territory.',
    model_produced: true,
    schema: PlanningOutputSchema,
  },
  /**
   * Story 2-5's implementing agent. Registered for the reason the two above are — a roster entry
   * references a contract by id, and `step.output` cannot tell an implementing agent from any other —
   * and because the shape genuinely differs: the files changed, each with its own provenance, inside a
   * declared territory, with no field through which a path outside the run worktree can be returned.
   */
  [IMPLEMENTATION_CONTRACT_ID]: {
    id: IMPLEMENTATION_CONTRACT_ID,
    kind: 'step',
    description:
      'The implementation agent\'s output: the files it changed, each carrying its provenance and ' +
      'lying inside the declared territory, plus the write intents the engine executes (AD-15).',
    model_produced: true,
    schema: ImplementationOutputSchema,
  },
  /**
   * Story 2-6's two, registered for the reason the three above are — AD-17 has a roster entry
   * reference a contract by id, and `step.output` cannot tell a testing agent from a verifying one,
   * which is exactly the pair that must be told apart: one may write files and the other may not.
   *
   * The shapes differ from each other as much as from the envelope: `step.testing` reports the tests
   * written and the territory they were written in, and `step.verification` reports what the
   * deterministic gates did and then what was judged against the criteria the run was accepted with.
   */
  [TESTING_CONTRACT_ID]: {
    id: TESTING_CONTRACT_ID,
    kind: 'step',
    description:
      'The testing agent\'s output: the test files it wrote, each carrying its provenance and the ' +
      'behaviour it pins, inside the declared territory.',
    model_produced: true,
    schema: TestingOutputSchema,
  },
  [VERIFICATION_CONTRACT_ID]: {
    id: VERIFICATION_CONTRACT_ID,
    kind: 'step',
    description:
      'The verification agent\'s output: what each deterministic gate CAP-13 names did, and the ' +
      'verdict on each acceptance criterion the run was accepted with.',
    model_produced: true,
    schema: VerificationOutputSchema,
  },
  /**
   * Story 4-2's adversarial tester, registered for the reason the pair above are — AD-17 has a roster
   * entry reference a contract by id, and `step.output` cannot tell it apart from `verification`, which
   * is exactly the pair that must be told apart: one judges the change against fixed criteria, the
   * other tries to break what was judged, and neither may be the other wearing a different prompt.
   */
  [ADVERSARIAL_CONTRACT_ID]: {
    id: ADVERSARIAL_CONTRACT_ID,
    kind: 'step',
    description:
      'The adversarial tester\'s output: the gate report copied verbatim from `verify`\'s own input, ' +
      'and one attempt per element to break the implementation, each carrying its provenance and a ' +
      'verdict of "held" or "broken".',
    model_produced: true,
    schema: AdversarialOutputSchema,
  },
  /**
   * Story 2-7's committing agent, registered for the reason the five above are — AD-17 has a roster entry
   * reference a contract by id, and `step.output` cannot tell a committing agent from any other.
   *
   * The shape differs by what it *omits*: it is prose and nothing else, because AD-22's note carries facts
   * the engine holds and a field asking a model for one is a field it will invent. It is also the one step
   * contract that refuses an unknown key rather than stripping it, which is what makes that omission a
   * refusal instead of a silent deletion.
   */
  [COMMITTING_CONTRACT_ID]: {
    id: COMMITTING_CONTRACT_ID,
    kind: 'step',
    description:
      'The committing agent\'s output: the pull-request title and body, in prose. It states no step ' +
      'disposition, no gate outcome and no usage total — the engine supplies those from the run\'s ' +
      'record — and declares no write intent, which AD-22 reserves to the committer unit.',
    model_produced: true,
    schema: CommittingOutputSchema,
  },
  /**
   * Story 5-5's bootstrap agent, registered for the reason every step contract above is — AD-17 has a
   * roster entry reference a contract by id, and `step.output` cannot tell it apart from any other.
   *
   * **`model_produced: true`, and its AD-31 fixture is a named, deferred gap — not registered here as an
   * afterthought.** This is a brand-new contract, and AD-31's own fixture has to come from a real
   * `claude -p --json-schema` invocation against this contract's exported draft-7 schema, which needs
   * subscription auth this build environment cannot provide. It is not omitted from the registry over
   * that gap — an unregistered contract is one `getContract` cannot resolve at all, which would make
   * `BOOTSTRAP_AGENT_DECLARATION`'s own `contract` field a reference to nothing. Instead it is registered
   * exactly like its six siblings, and {@link PENDING_AD31_FIXTURE_CONTRACT_IDS} names it as owing a
   * fixture; `tests/contracts.round-trip.test.ts` reads that list to turn its fixture-dependent legs into
   * a visible, explicit gap for this one id rather than a red suite nobody in this repository could fix,
   * or a silent exclusion with nothing pointing at it.
   */
  [BOOTSTRAP_CONTRACT_ID]: {
    id: BOOTSTRAP_CONTRACT_ID,
    kind: 'step',
    description:
      'The bootstrap agent\'s output: the three profile judgement fields detection cannot answer ' +
      '(mechanics.resources, risk.high_blast_radius_paths/conflict_domains, and knowledge), each ' +
      'attributed to what was read (CAP-20).',
    model_produced: true,
    schema: BootstrapAnalysisSchema,
  },
  /**
   * AD-22's git note, the in-repository durable record written on the merge commit.
   *
   * An `artifact` and not a `step`: no model produces it. The engine composes it from `events.jsonl` and
   * `state.json`, and `src/engine/committer.ts` is its only composer, as AD-22 makes the committer its
   * only writer. It carries its own `schema_version` per ADR-005.
   */
  [NOTE_CONTRACT_ID]: {
    id: NOTE_CONTRACT_ID,
    kind: 'artifact',
    description:
      'The AD-22 git note written on the merge commit under a single named ref, carrying the run id, ' +
      'the ordered steps with dispositions, the acceptance criteria, usage totals and the decisions ' +
      'taken (AD-22, ADR-005).',
    model_produced: false,
    schema: GitNoteSchema,
  },
} as const satisfies Readonly<Record<string, ContractEntry>>;

export type ContractId = keyof typeof CONTRACTS;

export const CONTRACT_IDS: readonly ContractId[] = Object.freeze(
  Object.keys(CONTRACTS) as ContractId[],
);

/**
 * Own-property membership only, so a prototype key such as `toString` is an unknown contract id and
 * gets the named AD-17 refusal rather than an `Object` member masquerading as a registry entry.
 */
export const isContractId = (id: string): id is ContractId =>
  Object.prototype.hasOwnProperty.call(CONTRACTS, id);

/** Look a contract up by id, failing with the registered ids rather than `undefined`. */
export const getContract = (id: string): ContractEntry => {
  if (!isContractId(id)) {
    throw new Error(
      `Unknown contract id "${id}". Registered ids: ${CONTRACT_IDS.join(', ')}. ` +
        'AD-17: an agent declaration references a registered contract id, never an inline schema.',
    );
  }
  return CONTRACTS[id];
};

export const contractIdsOfKind = (kind: ContractKind): readonly ContractId[] =>
  CONTRACT_IDS.filter((id) => CONTRACTS[id].kind === kind);

/** The contracts bound by the structured-outputs subset (AD-2). */
export const STEP_CONTRACT_IDS: readonly ContractId[] = contractIdsOfKind('step');

/** The contracts a model produces, and so the ones AD-31 requires a recorded fixture for. */
export const MODEL_PRODUCED_CONTRACT_IDS: readonly ContractId[] = CONTRACT_IDS.filter(
  (id) => CONTRACTS[id].model_produced,
);

/**
 * Model-produced contracts registered without an AD-31 fixture yet, each a **named, dated, recorded**
 * gap rather than a silent one.
 *
 * AD-31 requires a recorded real `claude -p --json-schema` transcript for every contract a model
 * produces, and that recording needs subscription auth no build of this package can supply for itself —
 * it is a session a person runs once, by hand, and commits the result of. A contract can therefore be
 * registered — as AD-17 requires, so a roster entry's `contract` field resolves to something real — before
 * that session has happened, and this list is where that honest, temporary state is written down.
 * `tests/contracts.round-trip.test.ts` reads it to turn the fixture-dependent legs of its own suite into a
 * visible, explicit exclusion for exactly these ids, rather than either fabricating a fixture (which
 * story 5-5's own Boundary forbids: "a schema this codebase cannot actually validate against a real
 * model's output is worse than an honestly incomplete round-trip test") or failing the whole suite for a
 * reason nobody working inside this repository could resolve.
 *
 * **Removing an id here is a two-step act, not a one-line edit.** Drop it only in the same change that
 * commits `tests/fixtures/structured-output/<id>.json`, a real recorded transcript — never on its own,
 * which would silently re-admit the very gap this list exists to keep visible.
 *
 * Story 5-5: `step.bootstrap` needed one. Deep ran a real `claude -p --json-schema` session against this
 * contract's exported draft-7 schema on 2026-09-25; the resulting `structured_output` is committed at
 * `tests/fixtures/structured-output/step.bootstrap.json`, verified against the schema, against the
 * exported draft-7 JSON Schema, and for lossless round-trip. The list is empty again — the next entry
 * here should be a new contract's own gap, not this one reopened.
 */
export const PENDING_AD31_FIXTURE_CONTRACT_IDS: readonly ContractId[] = Object.freeze([]);

/** The draft-07 dialect every export must declare. */
export const JSON_SCHEMA_DIALECT = 'http://json-schema.org/draft-07/schema#';

export type JsonSchema = Record<string, unknown>;

/**
 * The one call to `z.toJSONSchema` in this package. The `draft-7` target is mandatory, not
 * guidance: `claude -p --json-schema` rejects draft-2020-12, and the resulting spawn error
 * surfaces far from its cause.
 *
 * `reused: 'inline'` is passed explicitly rather than relied on as a default: were a reused
 * subschema emitted as a `$ref` instead, the subset guard's recursion rule would read ordinary
 * deduplication as a self-referential schema and fail a contract that is in fact legal.
 */
export const toJsonSchema = (schema: z.ZodType): JsonSchema =>
  z.toJSONSchema(schema, { target: 'draft-7', reused: 'inline' });

/** The draft-7 JSON Schema for a registered contract id. */
export const exportContract = (id: string): JsonSchema => toJsonSchema(getContract(id).schema);

/**
 * Parse a planning output, and refuse a plan naming a contract id the registry does not hold.
 *
 * **Why the check is here and not in `PlannedStepSchema`.** `src/contracts/planning.ts` cannot ask the
 * registry whether an id is registered — the registry imports the schema, so the reverse import would be a
 * cycle. That is the same reason `AgentDeclarationSchema.contract` is a plain string and
 * `src/installer/write.ts` resolves it through {@link getContract} on the way in. This module is the one
 * that already holds both halves, so the check goes here, and the refusal is the registry's own: it names
 * every registered id, which is what a person needs to fix the plan.
 *
 * Without it, `getContract` throws when the engine turns the plan into a step — mid-run, several steps after
 * the plan was accepted, with the failure a long way from the output that caused it.
 */
export const parsePlanningOutput = (value: unknown): z.output<typeof PlanningOutputSchema> => {
  const parsed = PlanningOutputSchema.parse(value);
  parsed.plan.forEach((step, index) => {
    if (!isContractId(step.contract_id)) {
      throw new Error(
        `Refusing the plan: step ${String(index)} ("${step.step}") names contract id ` +
          `"${step.contract_id}", which is not registered. Registered ids: ${CONTRACT_IDS.join(', ')}. ` +
          'AD-17: a step references a registered contract id, never an inline schema.',
      );
    }
  });
  return parsed;
};
