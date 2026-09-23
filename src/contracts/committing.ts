/**
 * `step.committing` — what the committing agent returns: the pull-request prose, and nothing else.
 *
 * **The engine supplies the record; the model composes the prose.** AD-22 requires the note to carry the
 * run id, the ordered step list with dispositions, the acceptance criteria, usage totals and the
 * decisions taken — every one of which the engine already holds in `events.jsonl` and `state.json`. Story
 * 2-6 shipped a contract that asked a model to report gate facts the engine had and did not pass in, and
 * its review named that the highest-severity finding: a field only the engine can answer, put in front of
 * a model, is a field the model will fill by inventing. So this contract has no field for a step
 * disposition, no field for a gate outcome and no field for a usage total, and an output carrying one is
 * refused rather than stripped. `src/contracts/note.ts` is the record half.
 *
 * **This is the one step contract that is strict, and that is the mechanism above.** Every other output
 * shape is an ordinary `z.object`, which *strips* an unknown key: an output carrying
 * `steps: [{step, disposition}]` would parse, the extra field would vanish, and nothing would report that
 * the model had tried to state a fact it was never given. The draft-7 export already says
 * `additionalProperties: false`, so the spawn-time contract and the re-parse disagreed on exactly this
 * point; strictness makes them agree, and makes matrix row 8 a refusal rather than a silent deletion.
 *
 * **It declares no write intent.** AD-15 has an agent declare an intent and the engine execute it, and
 * for every other phase that is where an intent is composed. AD-22 takes it back for this one: the
 * committer is the only unit that names a branch and the note's only writer, so the three intents are
 * composed by `src/engine/committer.ts` from the run's record. An intent declared here would be a branch
 * name inferred by a model — which is the exact thing AD-22 forbids of every unit including this one — so
 * a committing output declaring one is refused.
 *
 * **`committing` holds no command tool and no edit tools** (ADR-003, ADR-004). It runs no gate and writes
 * no file; `tests/contracts.agent-grants.test.ts` pins the grant beside this contract id.
 *
 * **Bounds are refinements plus prose.** AD-2's structured-outputs subset admits no `minLength`, no
 * `minItems` above one and no `minimum`, and a refinement emits nothing into the draft-7 export — so
 * every rule a refinement enforces is also stated in the `.describe()` of the field it binds. A rule the
 * producer cannot see makes `step.schema_invalid_output` the normal outcome, and that code is
 * `escalate-model-tier`: an invisible rule spends the run's one promotion on a step that did its job.
 *
 * It carries no `schema_version`: it is the model-facing contract, not an on-disk artifact.
 */
import { z } from 'zod';

import { StepOutputSchema } from './step.js';

/** The registry id this contract is registered under (AD-17), spelled once. */
export const COMMITTING_CONTRACT_ID = 'step.committing';

const CommittingOutputShape = StepOutputSchema.extend({
  /**
   * Pinned to the registered id, so an output claiming `step.output` is refused by every reader of the
   * artifact and not only by the spawner's own comparison (the defect the pinned grant table caught in
   * story 2-4's declarations).
   */
  contract_id: z.literal(COMMITTING_CONTRACT_ID),
  pull_request_title: z
    .string()
    .describe(
      'The pull request’s title: one line that stands alone and says what the change does. Never ' +
        'blank, and never more than one line — a title carrying a newline is a body in the wrong field.',
    ),
  pull_request_body: z
    .string()
    .describe(
      'The pull request’s body, in prose. Describe the change and why it was made. Do not state ' +
        'how any step ended, what any gate did, or what the run cost: the engine records those from ' +
        'its own log and puts them in the AD-22 git note, and this step is not told them.',
    ),
}).strict();

/**
 * `step.committing`'s output.
 *
 * The refinements name the field they refused, so a refusal says which half of the prose was missing
 * rather than that "the output was invalid".
 */
export const CommittingOutputSchema = CommittingOutputShape.superRefine((output, ctx) => {
  /**
   * AD-22 gives branch naming and the note to the committer *unit*, not to the committing *agent*.
   *
   * The three intents are composed in `src/engine/committer.ts` from the run's record, so an intent
   * arriving here carries a target some model chose — a branch it inferred, or a ref it named — and
   * accepting it would put the one thing AD-22 reserves back in the model's hands. Refused whatever the
   * status, because a blocked step that still declared a push has still declared a push.
   */
  if (output.write_intents.length > 0) {
    ctx.addIssue({
      code: 'custom',
      path: ['write_intents'],
      message:
        'a committing output declares no write intent. AD-22 makes the committer the only unit that ' +
        'names a branch and the git note’s only writer, so the push, the pull request and the note ' +
        'are composed by the engine from the run’s record; an intent declared here carries a ' +
        'target a model chose.',
    });
  }

  /**
   * A completed committing step composed prose; a blocked or failed one need not.
   *
   * Bound to the status rather than asserted always, for the reason `step.implementation` gives: refusing
   * a blank title on a step that honestly reported it could not compose one would promote the model
   * ladder against a step that did the right thing, because `step.schema_invalid_output` is
   * `escalate-model-tier`.
   */
  if (output.status === 'completed') {
    if (output.pull_request_title.trim() === '') {
      ctx.addIssue({
        code: 'custom',
        path: ['pull_request_title'],
        message:
          'a completed committing step composed a title; a blank one opens a pull request nobody can ' +
          'tell apart from another. Report "blocked" instead if there was nothing to say.',
      });
    }
    if (output.pull_request_body.trim() === '') {
      ctx.addIssue({
        code: 'custom',
        path: ['pull_request_body'],
        message:
          'a completed committing step composed a body; composing the prose is the whole of what this ' +
          'step does, and an empty one is a completion with nothing written. Report "blocked" instead.',
      });
    }
  }

  // A title is one line by construction, not by convention: the pull-request host renders it on one
  // line whatever it is given, so a newline here silently truncates everything after it.
  if (output.pull_request_title.includes('\n')) {
    ctx.addIssue({
      code: 'custom',
      path: ['pull_request_title'],
      message:
        'a pull-request title is one line; text after a newline is dropped by every host that renders ' +
        'it, so a multi-line title is a body written into the wrong field',
    });
  }
});

export type CommittingOutput = z.infer<typeof CommittingOutputSchema>;
