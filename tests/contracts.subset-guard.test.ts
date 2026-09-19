/**
 * AD-2 — step contracts stay inside the structured-outputs subset. The subset is invisible until a
 * spawn fails, and that failure surfaces as an opaque `claude -p` error far from its cause, so the
 * constraint is a test rather than prose.
 *
 * Forbidden, per AD-2 and the Consistency Conventions: date types (`z.date()` cannot be exported
 * at all; `z.iso.datetime()` exports a `format`), recursive or self-referential schemas,
 * `minLength`, `minItems` above one, and `minimum`.
 *
 * This file also holds the dependency-direction guard: `src/contracts/` is the root of the graph
 * and imports from no other `src/` directory.
 */
import { readFileSync, readdirSync } from 'node:fs';

import { z } from 'zod';
import { describe, expect, it } from 'vitest';

import { STEP_CONTRACT_IDS, getContract, toJsonSchema } from '../src/contracts/index.js';
import type { JsonSchema } from '../src/contracts/index.js';

interface SubsetViolation {
  /** The registered contract id the violation was found in. */
  readonly contract: string;
  /** The field path within the contract, as a JSON pointer-ish path. */
  readonly field: string;
  readonly keyword: string;
  readonly detail: string;
}

/** Date and time formats are outside the subset; timestamps are plain strings (AD-2). */
const FORBIDDEN_FORMATS = new Set(['date', 'date-time', 'time', 'duration']);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const walk = (node: unknown, contract: string, field: string, found: SubsetViolation[]): void => {
  if (Array.isArray(node)) {
    node.forEach((child, index) => {
      walk(child, contract, `${field}[${String(index)}]`, found);
    });
    return;
  }
  if (!isRecord(node)) return;

  const add = (keyword: string, detail: string, at: string = field): void => {
    found.push({ contract, field: at === '' ? '(root)' : at, keyword, detail });
  };

  const format = node['format'];
  if (typeof format === 'string' && FORBIDDEN_FORMATS.has(format)) {
    add('format', `format "${format}" — use a plain string carrying RFC3339 with milliseconds`);
  }
  if ('minLength' in node) {
    add('minLength', 'minLength is outside the structured-outputs subset');
  }
  if ('minItems' in node && typeof node['minItems'] === 'number' && node['minItems'] > 1) {
    add('minItems', `minItems ${String(node['minItems'])} is above the permitted maximum of 1`);
  }
  if ('minimum' in node) {
    add('minimum', 'minimum is outside the structured-outputs subset');
  }
  if ('exclusiveMinimum' in node) {
    add('exclusiveMinimum', 'exclusiveMinimum is a numeric lower bound, outside the subset');
  }
  if ('$ref' in node) {
    add('$ref', 'a $ref means a recursive or self-referential schema, which is outside the subset');
  }
  if ('$defs' in node || 'definitions' in node) {
    add('$defs', 'shared definitions mean a self-referential schema, which is outside the subset');
  }

  // Structured outputs accept only closed objects whose every property is required. An optional
  // property (absent from `required`) or an open `additionalProperties` is rejected at spawn time,
  // so `.optional()`, `z.record()` and `z.looseObject()` are all outside the subset for a step.
  if (node['type'] === 'object') {
    const properties = node['properties'];
    if (isRecord(properties)) {
      const required = node['required'];
      const listed = new Set(
        Array.isArray(required) ? required.filter((name): name is string => typeof name === 'string') : [],
      );
      for (const name of Object.keys(properties)) {
        if (!listed.has(name)) {
          add(
            'required',
            `property "${name}" is optional; every property of a step contract must be required`,
            field === '' ? `properties.${name}` : `${field}.properties.${name}`,
          );
        }
      }
    }
    if (node['additionalProperties'] !== false) {
      add(
        'additionalProperties',
        'the object is open; a step contract object must close with additionalProperties: false',
      );
    }
  }

  for (const [key, value] of Object.entries(node)) {
    if (key === '$schema' || key === 'description' || key === 'title') continue;
    walk(value, contract, field === '' ? key : `${field}.${key}`, found);
  }
};

/** Find every subset violation in a contract's draft-7 export. */
export const findSubsetViolations = (contract: string, schema: z.ZodType): SubsetViolation[] => {
  let exported: JsonSchema;
  try {
    exported = toJsonSchema(schema);
  } catch (error) {
    // `z.date()` cannot be represented in JSON Schema at all, so the export itself throws.
    return [
      {
        contract,
        field: '(root)',
        keyword: 'export',
        detail: `the draft-7 export failed: ${error instanceof Error ? error.message : String(error)}`,
      },
    ];
  }
  const found: SubsetViolation[] = [];
  walk(exported, contract, '', found);
  return found;
};

const describeViolations = (violations: readonly SubsetViolation[]): string =>
  violations
    .map((v) => `${v.contract} at ${v.field}: ${v.keyword} — ${v.detail}`)
    .join('\n');

describe('every registered step contract stays inside the structured-outputs subset', () => {
  it.each(STEP_CONTRACT_IDS)('%s has no subset violation', (id) => {
    const violations = findSubsetViolations(id, getContract(id).schema);
    expect(describeViolations(violations)).toBe('');
  });
});

describe('the guard detects each forbidden construct, naming the contract and field', () => {
  const offenders: readonly [string, z.ZodType, string, string][] = [
    ['offender.date', z.object({ created_at: z.date() }), 'export', '(root)'],
    ['offender.iso', z.object({ created_at: z.iso.datetime() }), 'format', 'properties.created_at'],
    ['offender.min-length', z.object({ slug: z.string().min(1) }), 'minLength', 'properties.slug'],
    ['offender.min-items', z.object({ tags: z.array(z.string()).min(2) }), 'minItems', 'properties.tags'],
    ['offender.minimum', z.object({ steps: z.number().int() }), 'minimum', 'properties.steps'],
    ['offender.positive', z.object({ steps: z.number().positive() }), 'exclusiveMinimum', 'properties.steps'],
    [
      'offender.optional',
      z.object({ slug: z.string(), note: z.string().optional() }),
      'required',
      'properties.note',
    ],
    [
      'offender.open-record',
      z.record(z.string(), z.unknown()),
      'additionalProperties',
      '(root)',
    ],
    [
      'offender.loose-object',
      z.looseObject({ slug: z.string() }),
      'additionalProperties',
      '(root)',
    ],
  ];

  it.each(offenders)('%s is caught as %s', (id, schema, keyword, field) => {
    const violations = findSubsetViolations(id, schema);
    expect(violations.length).toBeGreaterThan(0);
    const match = violations.find((v) => v.keyword === keyword);
    expect(match, describeViolations(violations)).toBeDefined();
    expect(match?.contract).toBe(id);
    expect(match?.field).toBe(field);
  });

  it('catches a self-referential schema by its $ref', () => {
    const Node: z.ZodType = z.object({
      value: z.string(),
      get child(): z.ZodType {
        return z.nullable(Node);
      },
    });
    const violations = findSubsetViolations('offender.recursive', Node);
    expect(violations.some((v) => v.keyword === '$ref')).toBe(true);
    expect(violations[0]?.contract).toBe('offender.recursive');
  });

  it('reports one clean contract for comparison, so the guard is not vacuous', () => {
    expect(findSubsetViolations('clean', z.object({ a: z.string(), b: z.number() }))).toStrictEqual(
      [],
    );
  });
});

describe('src/contracts/ is the root of the dependency graph', () => {
  const sourceDir = new URL('../src/contracts/', import.meta.url);
  const files = readdirSync(sourceDir).filter((name) => name.endsWith('.ts'));

  /** Statement forms only, so a quoted word after "from" in prose is not read as an import. */
  const IMPORT_PATTERNS = [
    /^\s*(?:import|export)\b[^'";]*\bfrom\s*['"]([^'"]+)['"]/gm,
    /^\s*import\s*['"]([^'"]+)['"]/gm,
    /\bimport\s*\(\s*['"]([^'"]+)['"]/g,
    /\brequire\s*\(\s*['"]([^'"]+)['"]/g,
  ];

  const importsOf = (source: string): string[] =>
    IMPORT_PATTERNS.flatMap((pattern) =>
      [...source.matchAll(pattern)].map((match) => match[1] ?? ''),
    );

  it('has source files to inspect', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it('reads the import statements it claims to inspect', () => {
    const source = readFileSync(new URL('registry.ts', sourceDir), 'utf8');
    expect(importsOf(source)).toContain('./step.js');
    expect(importsOf(source)).toContain('zod');
  });

  it.each(files)('%s imports from no other src/ directory', (file) => {
    const source = readFileSync(new URL(file, sourceDir), 'utf8');
    for (const specifier of importsOf(source)) {
      if (!specifier.startsWith('.')) {
        // A bare specifier is an external package or a node: builtin, never a sibling src/ layer.
        expect(specifier.startsWith('node:') || specifier === 'zod').toBe(true);
        continue;
      }
      // Relative imports may only name a sibling inside this same directory.
      expect(specifier.startsWith('./'), `${file} imports "${specifier}"`).toBe(true);
      expect(specifier.slice(2)).not.toContain('/');
    }
  });
});
