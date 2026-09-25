/**
 * Story 5-5 — the bootstrap agent's engine half: `BOOTSTRAP_AGENT_DECLARATION`, `bootstrapPlan` driven
 * through a real `Reconciler`, and `mergeBootstrapAnalysis`'s purity.
 *
 * **What the reconciler-integration test proves, and what it does not.** It proves that a real
 * `Reconciler`, given this plan shape and a scripted (never a real subprocess) executor, accepts and
 * drives it to a terminal state exactly the way it drives any other feature's plan — no engine
 * modification was needed for that. It does **not** prove that a real `createStepSpawner` resolves the
 * correct grant for this plan: the scripted executor here never builds a `SpawnPlan`, never calls
 * `resolveAgentGrant`, and so never exercises the phase-based-lookup mismatch `src/engine/bootstrap.ts`'s
 * own docblock describes (the plan reuses `phase: 'analysis'`, which a real spawner's default `grantFor`
 * would resolve against the *target repository's* `analysis` agent, not `BOOTSTRAP_AGENT_DECLARATION`).
 * That needs a real-spawner test gated on the same AD-31 fixture this story already tracks as pending
 * (`tests/contracts.bootstrap.test.ts`), and is not attempted here.
 */
import { rmSync } from 'node:fs';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { BOOTSTRAP_CONTRACT_ID, STEP_PHASES } from '../src/contracts/index.js';
import type { BootstrapAnalysis } from '../src/contracts/index.js';
import {
  BOOTSTRAP_AGENT_DECLARATION,
  BOOTSTRAP_FEATURE_SLUG,
  BOOTSTRAP_STEP_NAME,
  Reconciler,
  bootstrapPlan,
  createRecordingResetter,
  createScriptedExecutor,
  mergeBootstrapAnalysis,
  terminated,
} from '../src/engine/index.js';
import { BUILT_IN_AGENTS } from '../src/installer/interview.js';

import { fixtureProfile, knowledgeEntry, knowledgeSection } from './helpers/config-fixture.js';
import { makeHome, planProvider } from './helpers/engine-fixture.js';

let home: string;
const toRemove: string[] = [];
const toClose: Reconciler[] = [];

/**
 * A stand-in for the disposable, engine-created scratch worktree `bootstrapPlan`'s own doc comment
 * requires (built via `createWorktree` in real use) — deliberately not a path that looks like, or is, a
 * person's own live repository checkout. Nothing in this suite ever runs `git reset --hard` /
 * `git clean -fd` against it (the scripted executor never reaches `reset-and-rerun`), so the path itself
 * is never touched; it exists only to be asserted back off `plan.worktree`.
 */
const SCRATCH_WORKTREE = '/scratch/bootstrap-worktree-stand-in';

beforeEach(() => {
  home = makeHome('engine-bootstrap');
  toRemove.push(home);
});

afterEach(() => {
  for (const reconciler of toClose.splice(0)) reconciler.close();
  for (const dir of toRemove.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('BOOTSTRAP_AGENT_DECLARATION is declared like a built-in, and is not one (AC4)', () => {
  it('is AgentDeclarationInput-shaped: id, purpose, contract, tools, mcp_domains, reversibility, model', () => {
    expect(Object.keys(BOOTSTRAP_AGENT_DECLARATION).sort()).toStrictEqual(
      ['contract', 'id', 'mcp_domains', 'model', 'purpose', 'reversibility', 'tools'].sort(),
    );
    expect(BOOTSTRAP_AGENT_DECLARATION.id).toBe('bootstrap');
    expect(BOOTSTRAP_AGENT_DECLARATION.contract).toBe(BOOTSTRAP_CONTRACT_ID);
  });

  it('is never a member of BUILT_IN_AGENTS, and no built-in shares its id', () => {
    expect(BUILT_IN_AGENTS).not.toContainEqual(BOOTSTRAP_AGENT_DECLARATION);
    expect(BUILT_IN_AGENTS.map((agent) => agent.id)).not.toContain(BOOTSTRAP_AGENT_DECLARATION.id);
  });

  it('is read-only, matching analysis\'s own grant and reasoning (ADR-003)', () => {
    expect(BOOTSTRAP_AGENT_DECLARATION.tools).toStrictEqual(['Read', 'Grep', 'Glob']);
    expect(BOOTSTRAP_AGENT_DECLARATION.mcp_domains).toStrictEqual([]);
    expect(BOOTSTRAP_AGENT_DECLARATION.reversibility).toBe('reversible');
  });
});

describe('bootstrapPlan builds an ordinary analysis-phase FeaturePlan', () => {
  it('declares a single step in the existing "analysis" phase — STEP_PHASES is unchanged', () => {
    const plan = bootstrapPlan(SCRATCH_WORKTREE);
    expect(STEP_PHASES).toContain('analysis');
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0]).toStrictEqual({
      step: BOOTSTRAP_STEP_NAME,
      contract_id: BOOTSTRAP_CONTRACT_ID,
      phase: 'analysis',
    });
    expect(plan.feature).toBe(BOOTSTRAP_FEATURE_SLUG);
    // `plan.worktree` carries the caller's `worktreePath` verbatim — see bootstrapPlan's own doc comment
    // for why that value must always be a disposable scratch worktree, never a live repository checkout.
    expect(plan.worktree).toBe(SCRATCH_WORKTREE);
    expect(plan.mode).toBe('shadow');
  });

  it('lets a caller name a different feature slug, for running more than one bootstrap at once', () => {
    const plan = bootstrapPlan(SCRATCH_WORKTREE, { feature: 'bootstrap-other-repo' });
    expect(plan.feature).toBe('bootstrap-other-repo');
  });

  it('lets a caller override the run mode', () => {
    const plan = bootstrapPlan(SCRATCH_WORKTREE, { mode: 'live' });
    expect(plan.mode).toBe('live');
  });

  it('lets a caller override the starting model tier', () => {
    const plan = bootstrapPlan(SCRATCH_WORKTREE, { startingModelTier: 'claude-opus-5' });
    expect(plan.starting_model_tier).toBe('claude-opus-5');
  });
});

describe('the bootstrap plan runs through the existing, unmodified reconciler/spawner pipeline', () => {
  it('is accepted by a real Reconciler and reaches a terminal state under a scripted executor', async () => {
    const plan = bootstrapPlan(SCRATCH_WORKTREE);
    const executor = createScriptedExecutor({
      onStart: (request) => terminated(request.step, 'completed', { sessionId: `sess-${request.step}` }),
    });
    const reconciler = Reconciler.open({
      orchHome: home,
      executor,
      plans: planProvider(plan),
      baseline: createRecordingResetter('a'.repeat(40)),
    });
    toClose.push(reconciler);

    const accepted = reconciler.acceptFeature(plan);
    expect(reconciler.load(accepted.run).state.state).toBe('drafting');
    expect(reconciler.confirm(accepted.run).state).toBe('confirmed');

    const taken = await reconciler.runUntilSettled();
    expect(taken.map((action) => action.kind)).toContain('run-step');
    expect(executor.started.map((request) => request.step)).toStrictEqual([BOOTSTRAP_STEP_NAME]);
    expect(executor.started[0]?.phase).toBe('analysis');
    expect(executor.started[0]?.contractId).toBe(BOOTSTRAP_CONTRACT_ID);

    /**
     * "A terminal or gate-appropriate state": every declared step of this plan is complete, and
     * `decideAction`'s "every declared step completed" rule (src/engine/reconciler.ts) reaches
     * `committed` regardless of which phases a plan declares — the same rule any other feature's plan is
     * driven to completion by. Nothing about this outcome required a special case for an analysis-only
     * plan, which is this test's own proof that the pipeline needed no engine modification.
     */
    const final = reconciler.load(accepted.run).state;
    expect(final.state).toBe('committed');
    expect(final.steps).toStrictEqual([
      expect.objectContaining({ step: BOOTSTRAP_STEP_NAME, disposition: 'completed' }),
    ]);
  });
});

describe('mergeBootstrapAnalysis is pure (matrix rows 4, 5, 6)', () => {
  const bootstrapAnalysis = (overrides: Partial<BootstrapAnalysis> = {}): BootstrapAnalysis => ({
    contract_id: BOOTSTRAP_CONTRACT_ID,
    step: BOOTSTRAP_STEP_NAME,
    status: 'completed',
    summary: 'This repository needs postgres.',
    provenance: ['bootstrap-analysis: docker-compose.yml'],
    decisions: [],
    artifacts: [],
    questions: [],
    write_intents: [],
    error: null,
    claims: [
      {
        claim: 'A postgres service is declared in the compose file.',
        paths: ['docker-compose.yml'],
        provenance: { step: BOOTSTRAP_STEP_NAME, source: 'docker-compose.yml' },
      },
    ],
    resources: 'postgres',
    high_blast_radius_paths: ['src/engine/reconciler.ts'],
    conflict_domains: ['src/engine'],
    knowledge: [knowledgeEntry({ anchor: 'newSymbol', claim: 'Newly discovered by bootstrap.' })],
    ...overrides,
  });

  it('appends knowledge to a profile\'s existing entries, never replacing them (row 4)', () => {
    const existing = [
      knowledgeEntry({ anchor: 'existingOne', claim: 'From consolidation.' }),
      knowledgeEntry({ anchor: 'existingTwo', claim: 'Also from consolidation.' }),
    ];
    const profile = fixtureProfile({ knowledge: knowledgeSection(existing) });

    const merged = mergeBootstrapAnalysis(profile, bootstrapAnalysis());

    expect(merged.knowledge?.entries).toHaveLength(3);
    expect(merged.knowledge?.entries.slice(0, 2)).toStrictEqual(existing);
    expect(merged.knowledge?.entries[2]?.anchor).toBe('newSymbol');
  });

  it('appends onto a profile with no knowledge section yet', () => {
    const profile = fixtureProfile();
    expect(profile.knowledge).toBeUndefined();

    const merged = mergeBootstrapAnalysis(profile, bootstrapAnalysis());
    expect(merged.knowledge?.entries).toHaveLength(1);
    expect(merged.knowledge?.entries[0]?.anchor).toBe('newSymbol');
  });

  it('replaces mechanics.resources and risk.* with the analysis\'s own values (row 5)', () => {
    const profile = fixtureProfile({
      mechanics: {
        package_manager: 'npm',
        commands: {
          test: 'npm test',
          typecheck: 'npm run typecheck',
          lint: 'npm run lint',
          build: 'npm run build',
          run: 'npm start',
        },
        source_layout: ['src'],
        resources: 'none',
      },
      risk: { high_blast_radius_paths: ['old/path'], conflict_domains: ['old-domain'] },
    });

    const merged = mergeBootstrapAnalysis(profile, bootstrapAnalysis());

    expect(merged.mechanics.resources).toBe('postgres');
    expect(merged.risk.high_blast_radius_paths).toStrictEqual(['src/engine/reconciler.ts']);
    expect(merged.risk.conflict_domains).toStrictEqual(['src/engine']);
  });

  it('refuses to merge a "blocked" analysis, rather than silently applying its incomplete fields', () => {
    const profile = fixtureProfile({
      mechanics: {
        package_manager: 'npm',
        commands: {
          test: 'npm test',
          typecheck: 'npm run typecheck',
          lint: 'npm run lint',
          build: 'npm run build',
          run: 'npm start',
        },
        source_layout: ['src'],
        resources: 'postgres',
      },
      risk: { high_blast_radius_paths: ['good/path'], conflict_domains: ['good-domain'] },
    });
    const blocked = bootstrapAnalysis({ status: 'blocked', claims: [], resources: 'none' });

    expect(() => mergeBootstrapAnalysis(profile, blocked)).toThrowError(/blocked/);
    // And the profile's own good values are provably untouched by the refused call.
    expect(profile.mechanics.resources).toBe('postgres');
    expect(profile.risk.high_blast_radius_paths).toStrictEqual(['good/path']);
  });

  it('refuses to merge a "failed" analysis for the same reason', () => {
    const profile = fixtureProfile();
    const failed = bootstrapAnalysis({ status: 'failed', claims: [], resources: 'none' });

    expect(() => mergeBootstrapAnalysis(profile, failed)).toThrowError(/failed/);
  });

  it('writes nothing anywhere: a pure value in, a pure value out (row 6)', () => {
    const profile = fixtureProfile({ knowledge: knowledgeSection([knowledgeEntry()]) });
    const before = JSON.parse(JSON.stringify(profile)) as unknown;

    const merged = mergeBootstrapAnalysis(profile, bootstrapAnalysis());

    // The input profile is untouched — a caller's own already-loaded Profile is never mutated.
    expect(JSON.parse(JSON.stringify(profile)) as unknown).toStrictEqual(before);
    // The result is a genuinely new value, not the same object (or nested object) mutated in place.
    expect(merged).not.toBe(profile);
    expect(merged.mechanics).not.toBe(profile.mechanics);
    expect(merged.risk).not.toBe(profile.risk);
    expect(merged.knowledge).not.toBe(profile.knowledge);
  });
});
