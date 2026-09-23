/**
 * Matrix 2, 7, 8, 13–15, 18 and 19 — `step.committing`, and the three intents a committing step produces.
 *
 * The contract is defined as much by what it has no field for as by what it has. AD-22 names five things
 * the note carries and every one of them is a fact the engine already holds; story 2-6 shipped a contract
 * that asked a model for facts of exactly that kind and its review named that the highest-severity
 * finding. So the assertions below come in pairs: the field is absent *and* an output that supplies it
 * anyway is refused, because a shape that silently strips what it will not accept reports nothing to
 * anybody.
 *
 * The force-push assertions are the same shape one level down. ADR-001 says force-push is never
 * permitted; the weak way to hold that is a `force` field an executor is trusted to ignore. Here the
 * property list is pinned and the parse is strict, so adding one fails a test rather than adding a flag
 * nobody reads.
 */
import { describe, expect, it } from 'vitest';

import {
  ANALYSIS_CONTRACT_ID,
  COMMITTING_CONTRACT_ID,
  CommittingOutputSchema,
  NOTE_REF,
  STEP_CONTRACT_IDS,
  STEP_DISPOSITIONS,
  WRITE_INTENT_KINDS,
  WriteIntentSchema,
  exportContract,
  getContract,
  toJsonSchema,
} from '../src/contracts/index.js';
import { composeCommit, intentIdFor } from '../src/engine/index.js';
import type { CommitRunRecord } from '../src/engine/index.js';

const committingOutput = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  contract_id: COMMITTING_CONTRACT_ID,
  step: 'commit',
  status: 'completed',
  summary: 'Composed the pull-request prose for the committer story.',
  provenance: ['commit: src/engine/committer.ts'],
  decisions: [],
  artifacts: [],
  questions: [],
  write_intents: [],
  error: null,
  pull_request_title: 'Committer: branch naming, pull request and the AD-22 note',
  pull_request_body: 'Gives the committer its phase and contract, and composes the three intents.',
  ...overrides,
});

const record: CommitRunRecord = {
  run: '01JBQ8Z1X2Y3W4V5U6T7S8R9Q0',
  feature: 'committer-branch-naming',
  steps: [
    { step: 'implement', phase: 'implementation', disposition: 'completed' },
    { step: 'verify', phase: 'verification', disposition: 'completed' },
  ],
  acceptance_criteria: ['The branch name comes from the profile'],
  usage: null,
  decisions: [],
};

const prose = { title: 'Committer', body: 'The committer names the branch.' };

describe('step.committing is a registered contract of its own (matrix 2)', () => {
  it('resolves from the registry and exports to draft-7', () => {
    expect(getContract(COMMITTING_CONTRACT_ID).kind).toBe('step');
    expect(getContract(COMMITTING_CONTRACT_ID).model_produced).toBe(true);
    expect(exportContract(COMMITTING_CONTRACT_ID)['$schema']).toContain('draft-07');
  });

  it('is distinct from every other step contract, by export and by the id it pins', () => {
    const mine = JSON.stringify(exportContract(COMMITTING_CONTRACT_ID));
    for (const id of STEP_CONTRACT_IDS) {
      if (id === COMMITTING_CONTRACT_ID) continue;
      expect(JSON.stringify(exportContract(id)), id).not.toBe(mine);
    }
    // And the pin is on the artifact, not only in the spawner's comparison: an output claiming the
    // shared envelope is refused by every reader, which is the defect story 2-4 found in the roster.
    expect(
      CommittingOutputSchema.safeParse(committingOutput({ contract_id: 'step.output' })).success,
    ).toBe(false);
    expect(
      getContract(ANALYSIS_CONTRACT_ID).schema.safeParse(committingOutput()).success,
    ).toBe(false);
  });

  it('accepts the prose an ordinary committing step composes', () => {
    expect(CommittingOutputSchema.safeParse(committingOutput()).success).toBe(true);
  });
});

describe('the record is the engine’s and the prose is the model’s (matrix 7, 8)', () => {
  /**
   * Matrix 8, as a refusal rather than as a silent deletion.
   *
   * Every other output shape is an ordinary `z.object`, which strips an unknown key: the same payload
   * against `step.implementation` parses, the invented field vanishes, and nothing reports that a model
   * tried to state a fact it was never given. That difference is the mechanism, so it is asserted on
   * both sides.
   */
  it('refuses a committing output that states a step disposition', () => {
    const stating = committingOutput({
      steps: [
        { step: 'implement', disposition: 'completed' },
        { step: 'verify', disposition: 'failed' },
      ],
    });
    expect(CommittingOutputSchema.safeParse(stating).success).toBe(false);
  });

  it.each(['gates', 'usage', 'acceptance_criteria', 'note'])(
    'refuses a committing output carrying a %s field, which is a fact the engine holds and withheld',
    (field) => {
      expect(
        CommittingOutputSchema.safeParse(committingOutput({ [field]: [] })).success,
        field,
      ).toBe(false);
    },
  );

  /**
   * The structural half: there is no field for any of it, so nothing has to be refused in the first
   * place. Every property `step.committing` adds to the envelope is a plain string — prose — and none is
   * an enum, a list of objects or anything else through which a run fact could be reported.
   */
  it('adds nothing to the envelope but prose, so no run fact is expressible', () => {
    const envelope = exportContract('step.output')['properties'] as Record<string, unknown>;
    const mine = exportContract(COMMITTING_CONTRACT_ID)['properties'] as Record<string, unknown>;
    const added = Object.keys(mine).filter((name) => !(name in envelope));
    expect(added.sort()).toStrictEqual(['pull_request_body', 'pull_request_title']);
    for (const name of added) {
      expect(mine[name], name).toMatchObject({ type: 'string' });
    }
  });

  it('spells no step disposition anywhere in its export, so none can be asked for', () => {
    const exported = JSON.stringify(exportContract(COMMITTING_CONTRACT_ID));
    // The envelope's own `status` is the step's report about *itself* and is a different vocabulary;
    // `interrupted` and `killed` belong only to how a step ended, which is the engine's to record.
    for (const disposition of ['interrupted', 'killed']) {
      expect(STEP_DISPOSITIONS).toContain(disposition);
      expect(exported, disposition).not.toContain(`"${disposition}"`);
    }
  });

  it('refuses a completed committing step that composed no prose', () => {
    expect(
      CommittingOutputSchema.safeParse(committingOutput({ pull_request_title: '  ' })).success,
    ).toBe(false);
    expect(
      CommittingOutputSchema.safeParse(committingOutput({ pull_request_body: '' })).success,
    ).toBe(false);
    // Bound to `completed`, so an honest refusal is still expressible: refusing it would promote the
    // model ladder against a step that said it could not proceed.
    expect(
      CommittingOutputSchema.safeParse(
        committingOutput({ status: 'blocked', pull_request_title: '', pull_request_body: '' }),
      ).success,
    ).toBe(true);
  });

  it('refuses a multi-line title, which is a body written into the wrong field', () => {
    expect(
      CommittingOutputSchema.safeParse(
        committingOutput({ pull_request_title: 'Committer\nand the note' }),
      ).success,
    ).toBe(false);
  });

  /**
   * AD-22 takes intent composition back from this one agent: the committer is the only unit that names a
   * branch, so an intent declared by the model carries a branch some model chose.
   */
  it('refuses a committing output declaring a write intent of its own', () => {
    const declaring = committingOutput({
      write_intents: [
        {
          intent_id: 'commit.git_push',
          kind: 'git_push',
          target: 'feature/whatever-the-model-liked',
          summary: 'Push it',
          reversibility: 'irreversible',
        },
      ],
    });
    expect(CommittingOutputSchema.safeParse(declaring).success).toBe(false);
  });
});

describe('a write intent cannot express a force (matrix 13)', () => {
  it('has exactly the five fields AD-15 needs, and no sixth', () => {
    const exported = toJsonSchema(WriteIntentSchema);
    expect(Object.keys(exported['properties'] as Record<string, unknown>).sort()).toStrictEqual([
      'intent_id',
      'kind',
      'reversibility',
      'summary',
      'target',
    ]);
    expect((exported['required'] as readonly string[]).length).toBe(5);
    expect(exported['additionalProperties']).toBe(false);
  });

  it('carries no boolean at all, so there is no shape a flag could take', () => {
    const properties = toJsonSchema(WriteIntentSchema)['properties'] as Record<
      string,
      { readonly type?: string }
    >;
    for (const [name, schema] of Object.entries(properties)) {
      expect(schema.type, name).not.toBe('boolean');
    }
  });


  it.each(['target', 'summary'])(
    'refuses an intent whose %s is blank, which its own description already promised',
    (field) => {
      const result = WriteIntentSchema.safeParse({
        intent_id: 'commit.git_push',
        kind: 'git_push',
        target: 'feature/x',
        summary: 'Push',
        reversibility: 'irreversible',
        [field]: '   ',
      });
      // A description that states a rule nothing checks is the worst of both: the producer is told,
      // and the artifact is accepted anyway.
      expect(result.success).toBe(false);
      expect(result.error?.issues.map((issue) => issue.path.join('.'))).toContain(field);
    },
  );

  it('refuses a title broken by a line separator, not only by a newline', () => {
    // U+2028 and U+2029 are invisible in most editors and terminate a line in JavaScript's own
    // grammar, so a check that saw only \n let a two-line title through as a one-line one.
    for (const brk of ['\n', '\r', '\u2028', '\u2029']) {
      expect(
        CommittingOutputSchema.safeParse(
          committingOutput({ pull_request_title: `Committer${brk}and the note` }),
        ).success,
        JSON.stringify(brk),
      ).toBe(false);
    }
  });

  it('refuses an intent that carries a force anyway, rather than stripping it', () => {
    const forced = {
      intent_id: 'commit.git_push',
      kind: 'git_push',
      target: 'feature/committer-branch-naming',
      summary: 'Push',
      reversibility: 'irreversible',
      force: true,
    };
    const result = WriteIntentSchema.safeParse(forced);
    expect(result.success).toBe(false);
    // Stripping is the failure mode this replaces: the value would parse, `force` would vanish, and the
    // artifact would go on saying a force was asked for while nothing recorded that anything refused it.
    expect(result.data).toBeUndefined();
  });
});

describe('the three composed intents, and the key they are recognised by (matrix 14, 15, 18, 19)', () => {
  it('composes one intent per kind, in a fixed order, and performs none of them', () => {
    const composed = composeCommit({ record, branchPattern: null, prose, step: 'commit' });
    expect(composed.intents.map((intent) => intent.kind)).toStrictEqual([
      'git_push',
      'pull_request',
      'git_note',
    ]);
    for (const kind of composed.intents.map((intent) => intent.kind)) {
      expect(WRITE_INTENT_KINDS).toContain(kind);
    }
  });

  it('names the branch the committer named on the push and the pull request, and nothing else', () => {
    const composed = composeCommit({
      record,
      branchPattern: 'release/<slug>',
      prose,
      step: 'commit',
    });
    expect(composed.branch).toBe('release/committer-branch-naming');
    expect(composed.pull_request.head).toBe(composed.branch);
    const byKind = new Map(composed.intents.map((intent) => [intent.kind, intent.target]));
    expect(byKind.get('git_push')).toBe(composed.branch);
    expect(byKind.get('pull_request')).toBe(composed.branch);
  });

  it('names the single AD-22 ref on the note intent, and carries the note beside it', () => {
    const composed = composeCommit({ record, branchPattern: null, prose, step: 'commit' });
    const noteIntent = composed.intents.find((intent) => intent.kind === 'git_note');
    expect(noteIntent?.target).toBe(NOTE_REF);
    // Matrix 7: the note's step list is the record's, and the model's output has no field it could
    // have come from.
    expect(composed.note.steps.map((step) => step.step)).toStrictEqual(['implement', 'verify']);
    expect(composed.note.run).toBe(record.run);
  });

  /**
   * Matrix 18 and 19 — the idempotency key, and the half that only a second run can show.
   *
   * With the run id this is AD-15's key and 2-11's executor recognises a repeat by it, so an id taken
   * from a clock, a counter or randomness would make every re-run a new write: AD-8 re-runs a step from
   * its baseline, and the second attempt would push again and open a second pull request. Asserting the
   * ids on one composition says nothing about that — a `Date.now()` in the derivation passes it — so the
   * assertion is on two compositions of the same step.
   */
  it('produces the same intent ids on a re-run of the same step', () => {
    const first = composeCommit({ record, branchPattern: null, prose, step: 'commit' });
    const second = composeCommit({
      record,
      branchPattern: null,
      // A re-run composes different prose; the key is what the write *is*, not what it says.
      prose: { title: 'Committer, second attempt', body: 'Reworded.' },
      step: 'commit',
    });
    expect(second.intents.map((intent) => intent.intent_id)).toStrictEqual(
      first.intents.map((intent) => intent.intent_id),
    );
    expect(first.intents.map((intent) => intent.intent_id)).toStrictEqual([
      'commit.git_push',
      'commit.pull_request',
      'commit.git_note',
    ]);
  });

  it('gives the three writes of one step three different ids, so the key identifies one write', () => {
    const composed = composeCommit({ record, branchPattern: null, prose, step: 'commit' });
    const ids = composed.intents.map((intent) => intent.intent_id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const kind of WRITE_INTENT_KINDS) {
      expect(intentIdFor('commit', kind)).toBe(`commit.${kind}`);
    }
  });

  /**
   * The derivation is of the step and the kind, and of nothing that varies between runs.
   *
   * Two different steps give two different keys — which is what makes the ids unique *within* a run —
   * while the same step gives the same one however often it runs.
   */
  it('keys on the step, so two committing steps of one run do not collide', () => {
    expect(intentIdFor('commit', 'git_push')).not.toBe(intentIdFor('commit-again', 'git_push'));
  });
});
