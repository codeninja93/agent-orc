/**
 * AD-31, first suite — every contract in `contracts/` has round-trip tests asserting that its Zod
 * schema, its draft-7 export and a recorded real `structured_output` agree.
 *
 * The third leg cannot be synthesised: the fixture for every *model-produced* contract — one a model
 * returns as `structured_output` — was captured once by a real `claude -p` invocation against that
 * contract's exported draft-7 schema and committed. `step.input` is not model-produced: the engine
 * writes a step's input file, so its fixture is a schema-conformance sample, held to the same
 * schema/export agreement but carrying no claim about what a model emits. Recording a fixture:
 *
 *   node -e "import('./dist/contracts/index.js').then(m => \
 *     console.log(JSON.stringify(m.exportContract('<contract-id>'))))" > /tmp/schema.json
 *   claude -p --output-format json --json-schema "$(cat /tmp/schema.json)" '<prompt>' \
 *     | node -e "…" > tests/fixtures/structured-output/<contract-id>.json
 *
 * The suite fails when a registered step contract has no fixture, which keeps the guarantee honest
 * as contracts are added in later stories.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { Ajv } from 'ajv';
import { describe, expect, it } from 'vitest';

import {
  CONTRACTS,
  CONTRACT_IDS,
  JSON_SCHEMA_DIALECT,
  MODEL_PRODUCED_CONTRACT_IDS,
  STEP_CONTRACT_IDS,
  exportContract,
  getContract,
  isContractId,
  toJsonSchema,
} from '../src/contracts/index.js';
import type { ContractId } from '../src/contracts/index.js';

const REPO_ROOT = new URL('../', import.meta.url);
const FIXTURE_DIR = new URL('fixtures/structured-output/', import.meta.url);

const readFixture = (id: ContractId): unknown =>
  JSON.parse(readFileSync(new URL(`${id}.json`, FIXTURE_DIR), 'utf8'));

const ajv = new Ajv({ strict: false, allErrors: true });

/** Spelled indirectly so this guard does not count itself when it scans `src/`. */
const CALL = `to${'JSONSchema'}(`;

describe('the registry exports draft-7 JSON Schema', () => {
  it('registers at least one contract of each load-bearing kind', () => {
    expect(CONTRACT_IDS.length).toBeGreaterThan(0);
    expect(STEP_CONTRACT_IDS.length).toBeGreaterThan(0);
  });

  it.each(CONTRACT_IDS)('%s declares the draft-07 dialect', (id) => {
    const exported = exportContract(id);
    expect(exported['$schema']).toBe(JSON_SCHEMA_DIALECT);
    expect(JSON_SCHEMA_DIALECT).toContain('draft-07');
  });

  it.each(CONTRACT_IDS)('%s exports a schema ajv compiles as draft-7', (id) => {
    expect(() => ajv.compile(exportContract(id))).not.toThrow();
  });

  it('refuses an unregistered contract id, naming the registered ones', () => {
    expect(() => getContract('step.nope')).toThrowError(/Unknown contract id "step\.nope"/);
    expect(() => getContract('step.nope')).toThrowError(/step\.output/);
  });

  it.each(['toString', 'constructor', '__proto__', 'hasOwnProperty'])(
    'treats the prototype key %s as an unregistered id, not a registry entry',
    (key) => {
      expect(isContractId(key)).toBe(false);
      expect(() => getContract(key)).toThrowError(/Unknown contract id/);
    },
  );

  it('exports every registered id through the one draft-7 helper', () => {
    for (const id of CONTRACT_IDS) {
      expect(exportContract(id)).toStrictEqual(toJsonSchema(CONTRACTS[id].schema));
    }
  });

  /**
   * AD-2 — "no export path uses `z.toJSONSchema` with default arguments". Enforced structurally
   * across the whole of `src/`, not just `src/contracts/`, so a call added by a later story in
   * `src/engine/` is caught too. Comments are stripped before matching, the window around each call
   * spans lines so a multi-line options object is still seen, and the target is matched without
   * depending on quote style.
   */
  it('calls z.toJSONSchema in exactly one place in src/, always with target draft-7', () => {
    const sourceRoot = new URL('src/', REPO_ROOT);
    const files = readdirSync(sourceRoot, { recursive: true })
      .filter((name): name is string => typeof name === 'string' && name.endsWith('.ts'))
      .sort();
    expect(files.length).toBeGreaterThan(0);

    const stripComments = (source: string): string =>
      source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

    const callers = new Set<string>();
    for (const file of files) {
      const source = stripComments(readFileSync(new URL(file, sourceRoot), 'utf8'));
      for (let at = source.indexOf(CALL); at !== -1; at = source.indexOf(CALL, at + 1)) {
        callers.add(file);
        expect(source.slice(at, at + 400), `${file} calls ${CALL}`).toMatch(
          /target:\s*(['"`])draft-7\1/,
        );
      }
    }
    expect([...callers]).toStrictEqual(['contracts/registry.ts']);
  });
});

describe('recorded real structured_output agrees with the schema and its export', () => {
  const recorded = readdirSync(fileURLToPath(FIXTURE_DIR))
    .filter((name) => name.endsWith('.json'))
    .map((name) => name.slice(0, -'.json'.length));

  it('has one fixture per registered step contract, and no orphans', () => {
    expect([...recorded].sort()).toStrictEqual([...STEP_CONTRACT_IDS].sort());
  });

  it('has a recorded real structured_output for every model-produced contract', () => {
    expect(MODEL_PRODUCED_CONTRACT_IDS.length).toBeGreaterThan(0);
    for (const id of MODEL_PRODUCED_CONTRACT_IDS) {
      expect(recorded, `${id} has no recorded claude -p structured_output`).toContain(id);
    }
  });

  it.each(STEP_CONTRACT_IDS)('%s: the fixture parses against the Zod schema', (id) => {
    const result = getContract(id).schema.safeParse(readFixture(id));
    expect(result.success, JSON.stringify(result.error?.issues ?? [], null, 2)).toBe(true);
  });

  it.each(STEP_CONTRACT_IDS)('%s: the fixture validates against the draft-7 export', (id) => {
    const validate = ajv.compile(exportContract(id));
    const valid = validate(readFixture(id));
    expect(valid, JSON.stringify(validate.errors ?? [], null, 2)).toBe(true);
  });

  it.each(STEP_CONTRACT_IDS)('%s: the parse is lossless, so the legs agree in both directions', (id) => {
    const fixture = readFixture(id);
    const parsed: unknown = getContract(id).schema.parse(fixture);
    expect(parsed).toStrictEqual(fixture);
    const validate = ajv.compile(exportContract(id));
    expect(validate(parsed)).toBe(true);
  });
});
