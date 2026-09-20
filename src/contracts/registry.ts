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

import { CommandIntentSchema } from './command.js';
import { EventEnvelopeSchema } from './event.js';
import { OrchErrorSchema } from './error.js';
import { FetchRecordSchema } from './fetch.js';
import { QuestionStateSchema } from './question.js';
import { RunStateSchema } from './state.js';
import { StepInputSchema, StepOutputSchema } from './step.js';

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
