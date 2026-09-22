/**
 * `step.planning` — matrix rows 2, 16 and 19, and the phase-vocabulary rows 14 and 15.
 *
 * Row 16 is the unusual one: "a planning output grounded on analysis's `summary` instead of the request"
 * is expected to be *impossible*, and the only honest way to assert an impossibility is to assert the
 * absence of the thing that would make it possible — so the assertion is over `StepInputSchema`'s own
 * field list, which is where a summary field would have to appear, rather than over any planning output.
 *
 * Rows 14 and 15 are here because `PlannedStepSchema` is the contract that carries the phase enum, and
 * because row 15's refusal is about the *order* of two checks: an artifact written by a build that knows a
 * phase this one does not must be refused for its `schema_version`, not crash on its enum.
 */
import { describe, expect, it } from 'vitest';

import {
  ANALYSIS_CONTRACT_ID,
  CURRENT_SCHEMA_VERSION,
  PLANNING_CONTRACT_ID,
  PlanningOutputSchema,
  RunStateSchema,
  SCHEMA_VERSION_UNRECOGNISED_CODE,
  STEP_PHASES,
  SchemaVersionRefusal,
  StepInputSchema,
  StepOutputSchema,
  exportContract,
  getContract,
  isContractId,
  parseVersionedArtifact,
} from '../src/contracts/index.js';
import type { PlannedStep, PlanningOutput } from '../src/contracts/index.js';

const plannedStep = (overrides: Partial<PlannedStep> = {}): PlannedStep => ({
  step: 'implement-grant',
  phase: 'implementation',
  contract_id: 'step.output',
  intent: 'Wire the roster grant into the argv.',
  territory: ['src/engine/spawner.ts'],
  provenance: { step: 'plan-grant', source: 'docs/specs/spec-agent-orchestrator/architecture.md' },
  ...overrides,
});

const planningOutput = (overrides: Partial<PlanningOutput> = {}): unknown => ({
  contract_id: PLANNING_CONTRACT_ID,
  step: 'plan-grant',
  status: 'completed',
  summary: 'Two steps: wire the grant, then assert the flag list against ADR-001.',
  provenance: ['plan-grant: docs/specs/spec-agent-orchestrator/architecture.md'],
  decisions: [],
  artifacts: [],
  questions: [],
  write_intents: [],
  error: null,
  plan: [plannedStep()],
  territory: ['src/engine'],
  ...overrides,
});

describe('planning is its own contract, not a second name for analysis (matrix 2)', () => {
  it('resolves by id and exports draft-7 for --json-schema', () => {
    expect(isContractId(PLANNING_CONTRACT_ID)).toBe(true);
    expect(getContract(PLANNING_CONTRACT_ID).kind).toBe('step');
    expect(getContract(PLANNING_CONTRACT_ID).model_produced).toBe(true);
    expect(exportContract(PLANNING_CONTRACT_ID)['$schema']).toBe(
      'http://json-schema.org/draft-07/schema#',
    );
  });

  it('is a different shape from analysis, and neither accepts the other', () => {
    const analysis = exportContract(ANALYSIS_CONTRACT_ID);
    const planning = exportContract(PLANNING_CONTRACT_ID);
    expect(planning).not.toStrictEqual(analysis);
    expect(Object.keys(planning['properties'] as Record<string, unknown>)).toContain('plan');
    expect(Object.keys(planning['properties'] as Record<string, unknown>)).not.toContain('claims');
    expect(Object.keys(analysis['properties'] as Record<string, unknown>)).not.toContain('plan');

    expect(PlanningOutputSchema.safeParse(planningOutput()).success).toBe(true);
    expect(
      getContract(ANALYSIS_CONTRACT_ID).schema.safeParse(planningOutput()).success,
    ).toBe(false);
  });

  it('is still a step output the loop can read, so a termination can carry it', () => {
    const parsed = PlanningOutputSchema.parse(planningOutput());
    expect(StepOutputSchema.safeParse(parsed).success).toBe(true);
  });
});

describe('each planned step carries its own provenance', () => {
  it('attributes every step, asserted per step rather than over the array', () => {
    const parsed = PlanningOutputSchema.parse(
      planningOutput({
        plan: [
          plannedStep({ step: 'analyse', phase: 'analysis' }),
          plannedStep({ step: 'implement-grant' }),
          plannedStep({ step: 'verify-flags', phase: 'verification' }),
        ],
      }),
    );
    expect(parsed.plan).toHaveLength(3);
    for (const step of parsed.plan) {
      expect(step.provenance.step, step.step).toBe('plan-grant');
      expect(step.provenance.source, step.step).not.toBe('');
    }
  });

  it('refuses a plan whose middle step is unattributed', () => {
    const result = PlanningOutputSchema.safeParse(
      planningOutput({
        plan: [
          plannedStep({ step: 'one' }),
          plannedStep({ step: 'two', provenance: { step: '', source: '' } }),
          plannedStep({ step: 'three' }),
        ],
      }),
    );
    expect(result.success).toBe(false);
    expect((result.error?.issues ?? []).map((issue) => issue.path.join('.'))).toContain(
      'plan.1.provenance',
    );
  });

  it('refuses a step claiming a path the plan’s own territory does not cover', () => {
    const result = PlanningOutputSchema.safeParse(
      planningOutput({ territory: ['src/engine'], plan: [plannedStep({ territory: ['src/tui'] })] }),
    );
    expect(result.success).toBe(false);
  });

  it('refuses the same step id twice, because a re-run updates a record rather than adding one', () => {
    const result = PlanningOutputSchema.safeParse(
      planningOutput({ plan: [plannedStep({ step: 'one' }), plannedStep({ step: 'one' })] }),
    );
    expect(result.success).toBe(false);
  });
});

describe('the contract id is the phase’s, and a disagreement is refused (matrix 19)', () => {
  it('refuses an output reporting a contract it was not validated against', () => {
    const result = PlanningOutputSchema.safeParse({
      ...(planningOutput() as Record<string, unknown>),
      contract_id: ANALYSIS_CONTRACT_ID,
    });
    expect(result.success).toBe(false);
    expect((result.error?.issues ?? []).map((issue) => issue.path.join('.'))).toContain('contract_id');
  });

  it('pins the id in the export, so a producer is told which contract it is answering', () => {
    const properties = exportContract(PLANNING_CONTRACT_ID)['properties'] as Record<string, unknown>;
    expect(properties['contract_id']).toMatchObject({ const: PLANNING_CONTRACT_ID });
  });
});

describe('planning re-grounds on the request, because there is nothing else to read (matrix 16)', () => {
  it('has no input field carrying a summary of the request', () => {
    const properties = exportContract('step.input')['properties'] as Record<string, unknown>;
    const fields = Object.keys(properties);
    expect(fields).toContain('request');
    expect(fields).toContain('acceptance_criteria');
    for (const field of fields) {
      expect(field, `${field} would be a summary to ground on instead of the request`).not.toMatch(
        /summary|analysis|digest|abstract/i,
      );
    }
  });

  it('keeps the user’s words as their own field, so a re-run reads the same bytes', () => {
    const input = StepInputSchema.parse({
      schema_version: CURRENT_SCHEMA_VERSION,
      contract_id: PLANNING_CONTRACT_ID,
      run: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
      feature: 'grant-wiring',
      step: 'plan-grant',
      mode: 'live',
      baseline_ref: 'ddd9bed4d286ac1f8a0f4f7bfef9530046605787',
      request: 'make the spawner pass the tools the roster grants',
      acceptance_criteria: ['--tools carries the roster grant'],
      decisions: [],
      evidence: [],
      budget: { steps_remaining: 3, wall_clock_ms_remaining: 1000, rate_limit_budget_consumed: 0.1 },
      created_at: '2026-09-22T09:00:00.000Z',
    });
    expect(input.request).toBe('make the spawner pass the tools the roster grants');
  });
});

describe('the phase vocabulary, widened safely (matrix 14, 15)', () => {
  it('carries analysis and planning alongside the two it had', () => {
    expect([...STEP_PHASES]).toStrictEqual(['analysis', 'planning', 'implementation', 'verification']);
  });

  it('is the vocabulary a planned step’s phase is drawn from', () => {
    for (const phase of STEP_PHASES) {
      expect(PlanningOutputSchema.safeParse(planningOutput({ plan: [plannedStep({ phase })] })).success)
        .toBe(true);
    }
    expect(
      PlanningOutputSchema.safeParse(
        planningOutput({ plan: [{ ...plannedStep(), phase: 'committing' } as unknown as PlannedStep] }),
      ).success,
    ).toBe(false);
  });

  /**
   * Row 15. The artifact is one a *newer* build wrote: a phase this build has never heard of, under a
   * `schema_version` it does not read. Both are wrong from this build's point of view, and which refusal
   * arrives matters — `config.schema_version_unrecognised` sends a person to the installer, while a Zod
   * enum issue sends them to a file to fix a value that is not the problem.
   */
  it('refuses a state.json from a build that knows a phase this one does not, by version', () => {
    const fromTheFuture = {
      schema_version: CURRENT_SCHEMA_VERSION + 1,
      run: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
      feature: 'grant-wiring',
      mode: 'live',
      state: 'running',
      territory: ['src/engine'],
      steps: [
        {
          step: 'document',
          phase: 'documentation',
          contract_id: 'step.output',
          disposition: null,
          session_id: null,
          baseline_ref: 'ddd9bed4d286ac1f8a0f4f7bfef9530046605787',
          model_tier: 'claude-haiku-4-5',
          promotions: 0,
          attempts: 1,
          credited_attempts: 0,
          resets: 0,
          started_at: '2026-09-22T09:00:00.000Z',
          terminated_at: null,
          error: null,
        },
      ],
      last_event_seq: 3,
      created_at: '2026-09-22T09:00:00.000Z',
      updated_at: '2026-09-22T09:00:01.000Z',
      handoff: null,
    };

    expect(() =>
      parseVersionedArtifact(RunStateSchema, fromTheFuture, 'runs/01ARZ/state.json'),
    ).toThrowError(SchemaVersionRefusal);
    try {
      parseVersionedArtifact(RunStateSchema, fromTheFuture, 'runs/01ARZ/state.json');
      expect.unreachable('the refusal must be raised');
    } catch (error) {
      expect(error).toBeInstanceOf(SchemaVersionRefusal);
      expect((error as SchemaVersionRefusal).code).toBe(SCHEMA_VERSION_UNRECOGNISED_CODE);
      expect((error as SchemaVersionRefusal).artifact).toBe('runs/01ARZ/state.json');
      // The refusal is about the version, not about the phase it could not have placed either way.
      expect((error as SchemaVersionRefusal).message).not.toContain('documentation');
    }
  });

  it('refuses an unknown phase at the current version as the shape problem it is, not as a crash', () => {
    const result = RunStateSchema.safeParse({
      schema_version: CURRENT_SCHEMA_VERSION,
      run: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
      feature: 'grant-wiring',
      mode: 'live',
      state: 'running',
      territory: ['src/engine'],
      steps: [
        {
          step: 'document',
          phase: 'documentation',
          contract_id: 'step.output',
          disposition: null,
          session_id: null,
          baseline_ref: 'ddd9bed4d286ac1f8a0f4f7bfef9530046605787',
          model_tier: 'claude-haiku-4-5',
          promotions: 0,
          attempts: 1,
          credited_attempts: 0,
          resets: 0,
          started_at: null,
          terminated_at: null,
          error: null,
        },
      ],
      last_event_seq: 3,
      created_at: '2026-09-22T09:00:00.000Z',
      updated_at: '2026-09-22T09:00:01.000Z',
      handoff: null,
    });
    expect(result.success).toBe(false);
    expect((result.error?.issues ?? []).map((issue) => issue.path.join('.'))).toContain(
      'steps.0.phase',
    );
  });
});
