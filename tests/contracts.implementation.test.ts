/**
 * `step.implementation` — matrix rows 1, 2, 9, 10 and 11.
 *
 * Row 10 is the one this suite exists for, and the way it is asserted is the whole point. Story 2-4
 * already proves the spawn carries `--add-dir` scoped to the run worktree; re-asserting that here
 * would be testing 2-4's property with this story's name on it. What is unproven is the other half:
 * that the *contract* leaves no channel — no field an agent can fill with a path outside the worktree
 * and have some later unit act on it. So the assertion is over the exported schema's own string
 * fields, every one of which must be a closed vocabulary, a field refused for an outside path, or a
 * named inert one. A field added later is refused by the enumeration until somebody classifies it,
 * which is the difference between "the channels we thought of are closed" and "these are all the
 * channels".
 */
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  CHANGE_KINDS,
  IMPLEMENTATION_CONTRACT_ID,
  ImplementationOutputSchema,
  WRITE_INTENT_KINDS,
  attributesClaim,
  exportContract,
  getContract,
  isContractId,
} from '../src/contracts/index.js';
import { STANDARD_PLAN_STEPS } from '../src/engine/index.js';

import type { ImplementationOutput, ImplementedChange } from '../src/contracts/index.js';

const change = (overrides: Partial<ImplementedChange> = {}): ImplementedChange => ({
  path: 'src/engine/spawner.ts',
  kind: 'modified',
  summary: 'The grant reaches --tools from the roster rather than from a table here.',
  provenance: { step: 'implement-grant', source: 'src/engine/agents.ts' },
  ...overrides,
});

/** A valid implementation output, built here rather than read from the fixture so cases can mutate. */
const implementationOutput = (overrides: Partial<ImplementationOutput> = {}): unknown => ({
  contract_id: IMPLEMENTATION_CONTRACT_ID,
  step: 'implement-grant',
  status: 'completed',
  summary: 'The spawner reads the grant from the roster and passes it to --tools.',
  provenance: ['implement-grant: src/engine/agents.ts'],
  decisions: [],
  artifacts: [],
  questions: [],
  write_intents: [],
  error: null,
  changes: [change()],
  territory: ['src/engine'],
  ...overrides,
});

/** The spellings of "outside the run worktree", each one a different way of leaving it. */
const OUTSIDE_THE_WORKTREE = [
  '/etc/passwd',
  '../../etc/passwd',
  '~/.ssh/id_rsa',
  'C:\\Windows\\System32\\drivers\\etc\\hosts',
  '\\\\server\\share\\secret',
  '',
  '   ',
];

describe('the contract is registered and exports for --json-schema (matrix 1)', () => {
  it('resolves by id and exports draft-7, so a spawn can carry it', () => {
    expect(isContractId(IMPLEMENTATION_CONTRACT_ID)).toBe(true);
    const entry = getContract(IMPLEMENTATION_CONTRACT_ID);
    expect(entry.kind).toBe('step');
    // AD-31: a model produces this one, so the round-trip suite demands a recorded real fixture.
    expect(entry.model_produced).toBe(true);
    const exported = exportContract(IMPLEMENTATION_CONTRACT_ID);
    expect(exported['$schema']).toBe('http://json-schema.org/draft-07/schema#');
    expect(Object.keys(exported['properties'] as Record<string, unknown>)).toContain('changes');
  });

  it('re-parses the recorded real output the round-trip suite holds', () => {
    const recorded: unknown = JSON.parse(
      readFileSync(
        new URL('./fixtures/structured-output/step.implementation.json', import.meta.url),
        'utf8',
      ),
    );
    const parsed = ImplementationOutputSchema.parse(recorded);
    expect(parsed.contract_id).toBe(IMPLEMENTATION_CONTRACT_ID);
    expect(parsed.changes.length).toBeGreaterThan(0);
    for (const recordedChange of parsed.changes) {
      expect(attributesClaim(recordedChange.provenance), recordedChange.path).toBe(true);
    }
  });
});

/**
 * Matrix 8 — the standard plan's `implement` step names this contract.
 *
 * It is asserted here, beside the contract, because the two are one pairing and only fail together:
 * a plan naming `step.output` for an implementing step is validated against the generic envelope, so
 * every refusal this contract adds is dead for every default run and nothing in the suite notices —
 * the same defect story 2-4 found in the roster's declarations, one file over. The Code Map named no
 * home for this row; putting it with the contract keeps the pairing in one place.
 */
describe('the standard plan points its implement step at this contract (matrix 8)', () => {
  it('names step.implementation, not the generic envelope', () => {
    const implement = STANDARD_PLAN_STEPS.find((step) => step.phase === 'implementation');
    expect(implement, 'the standard plan runs an implementation step').toBeDefined();
    expect(implement?.contract_id).toBe(IMPLEMENTATION_CONTRACT_ID);
    expect(implement?.contract_id).not.toBe('step.output');
  });

  /**
   * The pairing, not the two facts side by side: an output produced under this plan step must be
   * accepted by the contract that step names, and refused when it claims the envelope instead.
   */
  it('gives that step a contract that refuses an output claiming step.output', () => {
    const implement = STANDARD_PLAN_STEPS.find((step) => step.phase === 'implementation');
    const schema = getContract(implement?.contract_id ?? '').schema;
    expect(schema.safeParse(implementationOutput()).success).toBe(true);
    // Spread rather than passed through the typed helper: `contract_id` is pinned to a literal, so
    // the case the plan step has to be safe against is one the type already refuses to express.
    const claimingTheEnvelope = {
      ...(implementationOutput() as Record<string, unknown>),
      contract_id: 'step.output',
    };
    expect(schema.safeParse(claimingTheEnvelope).success).toBe(false);
  });

  it('leaves verify on the generic envelope, which is story 2-6’s to change', () => {
    const verify = STANDARD_PLAN_STEPS.find((step) => step.phase === 'verification');
    expect(verify?.contract_id).toBe('step.output');
  });
});

describe('an output claiming another contract is refused (matrix 2)', () => {
  it.each(['step.output', 'step.analysis', 'step.planning'])(
    'refuses an output claiming %s, the way 2-4’s contracts refuse it',
    (claimed) => {
      const result = ImplementationOutputSchema.safeParse(
        implementationOutput({ contract_id: claimed } as Partial<ImplementationOutput>),
      );
      expect(result.success).toBe(false);
      expect((result.error?.issues ?? []).map((issue) => issue.path.join('.'))).toContain(
        'contract_id',
      );
    },
  );

  it('accepts its own id, so the refusal above is about the value and not about the field', () => {
    expect(ImplementationOutputSchema.safeParse(implementationOutput()).success).toBe(true);
  });
});

describe('every change carries its own provenance (matrix 9)', () => {
  it('names, per change, the step that made it and the source it was read from', () => {
    const parsed = ImplementationOutputSchema.parse(
      implementationOutput({
        changes: [
          change({ path: 'src/engine/spawner.ts' }),
          change({
            path: 'src/engine/agents.ts',
            provenance: { step: 'implement-grant', source: 'src/engine/roster.ts' },
          }),
          change({
            path: 'src/contracts/installer.ts',
            provenance: { step: 'implement-grant', source: 'src/contracts/installer.ts' },
          }),
        ],
        territory: ['src/engine', 'src/contracts'],
      }),
    );

    expect(parsed.changes).toHaveLength(3);
    for (const parsedChange of parsed.changes) {
      expect(attributesClaim(parsedChange.provenance), parsedChange.path).toBe(true);
    }
    expect(parsed.changes.map((entry) => entry.provenance.source)).toStrictEqual([
      'src/engine/agents.ts',
      'src/engine/roster.ts',
      'src/contracts/installer.ts',
    ]);
  });

  it('refuses three changes when one carries no provenance, and names only that one', () => {
    const result = ImplementationOutputSchema.safeParse(
      implementationOutput({
        changes: [
          change({ path: 'src/engine/a.ts' }),
          change({ path: 'src/engine/b.ts', provenance: { step: '', source: '' } }),
          change({ path: 'src/engine/c.ts' }),
        ],
      }),
    );
    expect(result.success).toBe(false);
    const paths = (result.error?.issues ?? []).map((issue) => issue.path.join('.'));
    expect(paths).toContain('changes.1.provenance');
    expect(paths).not.toContain('changes.0.provenance');
    expect(paths).not.toContain('changes.2.provenance');
  });

  /**
   * The flat `provenance` array `step.output` carries, shown attributing nothing.
   *
   * It is the defect story 2-4's review named, and it is still on the envelope this contract extends.
   * An assertion over its length passes on an output whose three changes share one entry, so the
   * per-change rule above is the one that binds — and this case is what it is better than.
   */
  it('is not satisfied by one entry in the flat provenance array beside three changes', () => {
    const output = implementationOutput({
      provenance: ['implement-grant'],
      changes: [
        change({ path: 'src/engine/a.ts', provenance: { step: 'implement-grant', source: '' } }),
        change({ path: 'src/engine/b.ts', provenance: { step: 'implement-grant', source: '' } }),
        change({ path: 'src/engine/c.ts', provenance: { step: 'implement-grant', source: '' } }),
      ],
    }) as { readonly provenance: readonly string[] };

    // The weaker assertion, passing.
    expect(output.provenance.length).toBeGreaterThan(0);
    // The contract's, refusing — once per unattributed change.
    const result = ImplementationOutputSchema.safeParse(output);
    expect(result.success).toBe(false);
    const paths = (result.error?.issues ?? []).map((issue) => issue.path.join('.'));
    expect(paths).toStrictEqual([
      'changes.0.provenance',
      'changes.1.provenance',
      'changes.2.provenance',
    ]);
  });

  it('refuses a completed implementation that changed nothing, and accepts a blocked one', () => {
    const empty = ImplementationOutputSchema.safeParse(implementationOutput({ changes: [] }));
    expect(empty.success).toBe(false);
    expect((empty.error?.issues ?? []).map((issue) => issue.path.join('.'))).toContain('changes');

    // Reporting "blocked" is the honest refusal, and refusing it would promote the ladder against a
    // step that did its job: `step.schema_invalid_output` is `escalate-model-tier`.
    const blocked = ImplementationOutputSchema.safeParse(
      implementationOutput({ status: 'blocked', changes: [], territory: [] }),
    );
    expect(blocked.success).toBe(true);
  });
});

describe('no path outside the run worktree can be returned (matrix 10)', () => {
  it.each(OUTSIDE_THE_WORKTREE)('refuses %j as the path of a change', (path) => {
    const result = ImplementationOutputSchema.safeParse(
      implementationOutput({ changes: [change({ path })] }),
    );
    expect(result.success).toBe(false);
    expect((result.error?.issues ?? []).map((issue) => issue.path.join('.'))).toContain(
      'changes.0.path',
    );
  });

  it.each(OUTSIDE_THE_WORKTREE)('refuses %j as a declared territory entry', (path) => {
    const result = ImplementationOutputSchema.safeParse(
      implementationOutput({ territory: [path], changes: [] , status: 'blocked' }),
    );
    expect(result.success).toBe(false);
    expect((result.error?.issues ?? []).map((issue) => issue.path.join('.'))).toContain(
      'territory.0',
    );
  });

  /**
   * AD-23 — an artifact is referenced by a pointer into the run's evidence plane, and a pointer that
   * resolves outside it is the same escape one plane over.
   */
  it.each(OUTSIDE_THE_WORKTREE)('refuses %j as an evidence pointer’s path', (path) => {
    const result = ImplementationOutputSchema.safeParse(
      implementationOutput({
        artifacts: [{ kind: 'diff', path, description: 'the diff this step wrote' }],
      }),
    );
    expect(result.success).toBe(false);
    expect((result.error?.issues ?? []).map((issue) => issue.path.join('.'))).toContain(
      'artifacts.0.path',
    );
  });

  it('refuses a change inside the worktree but outside the territory this output declares', () => {
    const result = ImplementationOutputSchema.safeParse(
      implementationOutput({
        territory: ['src/engine'],
        changes: [change({ path: 'src/tui/frame.tsx' })],
      }),
    );
    expect(result.success).toBe(false);
    const issues = result.error?.issues ?? [];
    expect(issues.map((issue) => issue.path.join('.'))).toContain('changes.0.path');
    expect(issues.map((issue) => issue.message).join(' ')).toContain('outside the territory');
  });

  it('refuses one file reported twice, however the two records spell it', () => {
    const result = ImplementationOutputSchema.safeParse(
      implementationOutput({
        changes: [
          change({ path: 'src/engine/spawner.ts', kind: 'created' }),
          change({ path: './src/engine/spawner.ts', kind: 'deleted' }),
        ],
      }),
    );
    expect(result.success).toBe(false);
    expect((result.error?.issues ?? []).map((issue) => issue.path.join('.'))).toContain(
      'changes.1.path',
    );
  });
});

/**
 * Matrix 24, 25 and 26 — the holes through which a containment check passes without checking.
 *
 * Each of these parsed before story 2-5's review. None is an outside path; all three are ways for the
 * *inside* checks to stop meaning anything, which is the failure mode a suite about "outside" misses.
 */
describe('a containment check cannot be made vacuous (matrix 24, 25, 26)', () => {
  it('refuses changes with no territory whatever status the step reports (matrix 24)', () => {
    // The case that parsed: blocked, no territory, and a real change — so `territoryWellFormed` was
    // false and every per-change containment refinement below it was skipped.
    const result = ImplementationOutputSchema.safeParse(
      implementationOutput({
        status: 'blocked',
        territory: [],
        changes: [change({ path: 'src/engine/spawner.ts' })],
      }),
    );
    expect(result.success).toBe(false);
    expect((result.error?.issues ?? []).map((issue) => issue.path.join('.'))).toContain('territory');
  });

  it.each(['blocked', 'failed'] as const)(
    'still lets a %s step that changed nothing declare no territory',
    (status) => {
      // The honest refusal stays possible: the rule is "changed something, said where", not "always".
      expect(
        ImplementationOutputSchema.safeParse(
          implementationOutput({ status, territory: [], changes: [] }),
        ).success,
      ).toBe(true);
    },
  );

  it('proves the refinement it protects actually runs once a territory is declared', () => {
    // The positive control for the case above: with a territory present, the containment check bites.
    const result = ImplementationOutputSchema.safeParse(
      implementationOutput({
        status: 'blocked',
        territory: ['src/tui'],
        changes: [change({ path: 'src/engine/spawner.ts' })],
      }),
    );
    expect(result.success).toBe(false);
    expect((result.error?.issues ?? []).map((issue) => issue.path.join('.'))).toContain(
      'changes.0.path',
    );
  });

  it.each(['.', './', '  .  '])('refuses %j as a changed file: a change names one file (matrix 25)', (path) => {
    const result = ImplementationOutputSchema.safeParse(
      implementationOutput({ territory: ['.'], changes: [change({ path })] }),
    );
    expect(result.success).toBe(false);
    expect((result.error?.issues ?? []).map((issue) => issue.path.join('.'))).toContain(
      'changes.0.path',
    );
  });

  it('refuses "." as an evidence pointer, which would resolve to the run directory (matrix 25)', () => {
    const result = ImplementationOutputSchema.safeParse(
      implementationOutput({
        artifacts: [{ kind: 'diff', path: '.', description: 'the diff' }],
      }),
    );
    expect(result.success).toBe(false);
    expect((result.error?.issues ?? []).map((issue) => issue.path.join('.'))).toContain(
      'artifacts.0.path',
    );
  });

  it('keeps "." legal as a territory, because that is the documented whole-repository claim', () => {
    // The narrower rule belongs at the narrower field: a territory of "." collides with every other
    // feature and is a real, fail-safe answer; a *change* of "." is not.
    expect(
      ImplementationOutputSchema.safeParse(
        implementationOutput({ territory: ['.'], changes: [change({ path: 'src/a.ts' })] }),
      ).success,
    ).toBe(true);
  });

  it('refuses a territory carrying one path twice, however each copy is spelled (matrix 26)', () => {
    const result = ImplementationOutputSchema.safeParse(
      implementationOutput({ territory: ['src', 'src'], changes: [change({ path: 'src/a.ts' })] }),
    );
    expect(result.success).toBe(false);
    expect((result.error?.issues ?? []).map((issue) => issue.path.join('.'))).toContain(
      'territory.1',
    );
  });

  it.each(['./src', 'src/', 'src/engine/../engine'])(
    'refuses %j, an entry that is not spelled normalised (matrix 26)',
    (entry) => {
      const result = ImplementationOutputSchema.safeParse(
        implementationOutput({ territory: [entry], changes: [change({ path: 'src/engine/a.ts' })] }),
      );
      expect(result.success).toBe(false);
      expect((result.error?.issues ?? []).map((issue) => issue.path.join('.'))).toContain(
        'territory.0',
      );
    },
  );

  it('accepts the normalised spelling of each of those, so the refusal is about the spelling', () => {
    expect(
      ImplementationOutputSchema.safeParse(
        implementationOutput({ territory: ['src'], changes: [change({ path: 'src/a.ts' })] }),
      ).success,
    ).toBe(true);
  });
});

/**
 * Matrix 10, the structural half — the enumeration that makes "no other channel" a measurement.
 *
 * Every string-valued leaf of the draft-7 export is found by walking the export itself, so a field
 * added to this contract later appears here whether or not anybody remembered this suite. Each leaf
 * must be one of three things, and the three are exhaustive by construction: a closed vocabulary
 * (`enum` or `const` — it cannot hold a path at all), a path field the contract refuses an outside
 * path in, or an inert field named below with the reason nothing resolves it as a filesystem
 * location.
 */
describe('the contract’s string fields are enumerated, and each one is accounted for', () => {
  /** The fields a refusal covers, each asserted against above. */
  const REFUSED_PATH_FIELDS = ['changes[].path', 'territory[]', 'artifacts[].path'];

  /**
   * The inert fields, and why each is not a channel.
   *
   * "Inert" is a claim about what reads the field, so each entry states the reader. A field whose
   * reader changes — one that starts being resolved against the filesystem — moves to the list above
   * and gets a refusal; it does not stay here with a stale reason.
   */
  const INERT_FIELDS: Readonly<Record<string, string>> = {
    contract_id: 'pinned to a literal; compared, never resolved',
    step: 'a step id, keyed on in the checkpoint; never joined to a path',
    summary: 'prose shown to a person',
    'provenance[]': 'the flat attribution list of the envelope; rendered, never opened',
    'changes[].provenance.step': 'a step id, as above',
    'changes[].provenance.source':
      'attribution for a read, not an instruction to read: ADR-001 leaves a host-side agent able to ' +
      'read outside the worktree, so refusing an outside source would refuse an honest report of ' +
      'something that happened, and nothing acts on this field',
    'changes[].summary': 'prose shown to a person',
    'decisions[].question': 'the CAP-18 ledger, rendered',
    'decisions[].answer': 'the CAP-18 ledger, rendered',
    'decisions[].rationale': 'the CAP-18 ledger, rendered',
    'artifacts[].description': 'prose beside the pointer, rendered',
    'questions[].prompt': 'a CAP-3 question draft, compressed by the Interviewer and shown',
    'questions[].brief': 'a CAP-3 question draft, shown',
    'questions[].options[].id': 'an option id, matched against the person’s answer',
    'questions[].options[].label': 'a CAP-3 question draft, shown',
    'questions[].options[].consequence': 'a CAP-3 question draft, shown',
    'questions[].escape.id': 'an option id, as above',
    'questions[].escape.label': 'a CAP-3 question draft, shown',
    'questions[].escape.consequence': 'a CAP-3 question draft, shown',
    'questions[].recommended_option_id': 'an option id, as above',
    'questions[].default_action': 'prose describing what happens if nobody answers',
    'write_intents[].intent_id': 'half of the AD-15 idempotency key; never a path',
    'write_intents[].target':
      'the target of an enumerated write intent — a branch, a pull request, a note, a tag or a ' +
      'domain record. AD-15’s surface has no member that writes a file, asserted below',
    'write_intents[].summary': 'prose shown to a person before the engine executes the intent',
    'error.code': 'dispositioned through the AD-35 table',
    'error.message': 'prose shown to a person',
    'error.cause': 'a rendered thrown value',
  };

  const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

  /** Every string leaf of a draft-7 export, with the dotted path a reader would name it by. */
  const stringLeaves = (node: unknown, at: string, found: Map<string, boolean>): void => {
    if (!isRecord(node)) return;
    // `type` is a string, or — for a nullable leaf, which Zod exports as a type union rather than an
    // `anyOf` — an array holding it. A walk that read only the first spelling would miss every
    // nullable string field, which is the half of the enumeration most likely to carry a path.
    const type = node['type'];
    const isString =
      type === 'string' || (Array.isArray(type) && type.includes('string'));
    if (isString) {
      const closed = 'enum' in node || 'const' in node;
      found.set(at, closed);
      return;
    }
    const properties = node['properties'];
    if (isRecord(properties)) {
      for (const [name, child] of Object.entries(properties)) {
        stringLeaves(child, at === '' ? name : `${at}.${name}`, found);
      }
    }
    if ('items' in node) stringLeaves(node['items'], `${at}[]`, found);
    for (const key of ['anyOf', 'oneOf', 'allOf']) {
      const branches = node[key];
      // A nullable field exports as a union with `{type: "null"}`; the string branch keeps the field's
      // own name, because the two branches are one field to everybody who reads it.
      if (Array.isArray(branches)) for (const branch of branches) stringLeaves(branch, at, found);
    }
  };

  const leaves = ((): Map<string, boolean> => {
    const found = new Map<string, boolean>();
    stringLeaves(exportContract(IMPLEMENTATION_CONTRACT_ID), '', found);
    return found;
  })();

  it('finds the fields it is about, so the walk is not silently returning nothing', () => {
    expect(leaves.size).toBeGreaterThan(20);
    for (const field of REFUSED_PATH_FIELDS) {
      expect([...leaves.keys()], `${field} is not in the export`).toContain(field);
    }
  });

  it('accounts for every string field: closed vocabulary, refused path, or named inert', () => {
    const unaccounted = [...leaves.entries()]
      .filter(([field, closed]) => {
        if (closed) return false;
        if (REFUSED_PATH_FIELDS.includes(field)) return false;
        return !(field in INERT_FIELDS);
      })
      .map(([field]) => field);

    expect(
      unaccounted,
      'a string field of step.implementation is unclassified: either it is refused an outside path, ' +
        'or it is inert and the reason belongs in INERT_FIELDS',
    ).toStrictEqual([]);
  });

  it('names nothing that is not there, so the inert list cannot rot into a list of wishes', () => {
    const absent = Object.keys(INERT_FIELDS).filter((field) => !leaves.has(field));
    expect(absent).toStrictEqual([]);
  });

  it('classifies the closed vocabularies as closed, which is why they need no refusal', () => {
    expect(leaves.get('changes[].kind')).toBe(true);
    expect(leaves.get('status')).toBe(true);
    expect(leaves.get('write_intents[].kind')).toBe(true);
    expect([...CHANGE_KINDS]).toStrictEqual(['created', 'modified', 'deleted']);
  });
});

describe('a write intent is declared, never performed (matrix 11)', () => {
  const intent = {
    intent_id: 'open-pr-for-grant-wiring',
    kind: 'pull_request',
    target: 'feature/grant-wiring',
    summary: 'Open the pull request for the grant wiring.',
    reversibility: 'recoverable',
  };

  it('accepts an output declaring one, alongside the changes it wrote', () => {
    const parsed = ImplementationOutputSchema.parse(
      implementationOutput({ write_intents: [intent] } as Partial<ImplementationOutput>),
    );
    expect(parsed.write_intents).toHaveLength(1);
    expect(parsed.write_intents[0]?.intent_id).toBe('open-pr-for-grant-wiring');
  });

  /**
   * AD-15 — the write surface is enumerated, and this is what makes `target` inert rather than a
   * second path field: there is no member of the surface that writes a file, so no target can be a
   * filesystem location the engine would write to.
   */
  it('has no kind that writes a file, so a target is never a path the engine writes', () => {
    expect([...WRITE_INTENT_KINDS]).toStrictEqual([
      'git_push',
      'pull_request',
      'git_note',
      'git_tag',
      'domain_mutation',
    ]);
    for (const kind of WRITE_INTENT_KINDS) {
      expect(kind, 'a file-writing kind would make write_intents[].target a path channel').not.toMatch(
        /file|path|write_file|fs/,
      );
    }
  });

  it('refuses a kind outside the enumerated surface, so a new write cannot arrive as data', () => {
    // Built by spreading rather than through the typed helper: the point of the case is a kind the
    // type system already refuses, so it has to be expressible without the type asserting it away.
    const result = ImplementationOutputSchema.safeParse({
      ...(implementationOutput() as Record<string, unknown>),
      write_intents: [{ ...intent, kind: 'file_write', target: '/etc/passwd' }],
    });
    expect(result.success).toBe(false);
    expect((result.error?.issues ?? []).map((issue) => issue.path.join('.'))).toContain(
      'write_intents.0.kind',
    );
  });
});
