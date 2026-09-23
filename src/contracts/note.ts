/**
 * AD-22 — the in-repository durable record: a git note on the merge commit, under a single named ref.
 *
 * **This is an artifact, not a step contract, and the difference is the whole design.** AD-22 names
 * exactly what the note carries — the run id, the ordered step list with dispositions, the acceptance
 * criteria, usage totals and the decisions taken — and every one of those is a fact the *engine* already
 * holds in `events.jsonl` and `state.json`. So the note is composed from the run's record and never from
 * a model's output. Story 2-6 shipped the opposite shape once, a contract asking a model to report gate
 * facts the engine had and did not pass in, and its review named that the highest-severity finding: a
 * field a model must fill with something only the engine knows is an invitation to invent it.
 * `src/contracts/committing.ts` is the model-facing half and carries prose alone.
 *
 * **It carries its own `schema_version` (ADR-005).** AD-22 says "the note shape is a versioned contract",
 * and after ADR-005 a version is per artifact: a note written last month must stay readable when the
 * profile gains a field, and the profile advancing must not refuse a note that never changed shape. The
 * two numbers are independent and {@link NOTE_SCHEMA_VERSION_POLICY} is this one's.
 *
 * **There is deliberately no timestamp.** The run id is a ULID minted by the engine at run creation
 * (AD-29) and carries its own minting time, so a `recorded_at` beside it would be a second authority on
 * when the run happened — and, worse here than elsewhere, it would make the note vary between two
 * compositions of the same run, which is the property AD-15's idempotency key depends on staying true of
 * everything the committer produces.
 *
 * Zod habits, carried from `src/contracts/state.ts`: bounds are refinements rather than JSON Schema
 * keywords, and every rule a refinement enforces is stated in the `.describe()` of the field it binds.
 * The structured-outputs subset does not bind an artifact, but the registry's artifact sweep does, and it
 * asserts this shape refuses a version it does not recognise and one it carries none of.
 */
import { z } from 'zod';

import { DecisionRecordSchema, STEP_DISPOSITIONS } from './step.js';
import { STEP_PHASES } from './state.js';
import { StepUsageSchema } from './usage.js';
import { versioned } from './schema-version.js';
import type { SchemaVersionPolicy } from './schema-version.js';

/** The registry id this artifact is registered under (AD-17), spelled once. */
export const NOTE_CONTRACT_ID = 'note.record';

/**
 * The **single named ref** AD-22 requires, spelled exactly once in the package.
 *
 * "Under a single named ref" is the part of AD-22 that a second spelling would break quietly: a note
 * written to `refs/notes/orch` and read from `refs/notes/orchestrator` is a durable record nothing can
 * find, and the failure surfaces only when somebody goes looking for a run that has already ended.
 * `tests/contracts.note.test.ts` holds it to being the only spelling in `src/`.
 */
export const NOTE_REF = 'refs/notes/orch';

/**
 * The note's own `schema_version`, independent of every other artifact's (ADR-005).
 *
 * It starts at 1 because this shape is new, and it advances when *this* shape changes and never because
 * another artifact's did. The direction that matters is the one ADR-005 was written for: advancing the
 * profile must not refuse a note, and advancing the note must not refuse a `state.json` a run in flight
 * depends on.
 */
export const NOTE_SCHEMA_VERSION = 1;

export const NOTE_SCHEMA_VERSION_POLICY: SchemaVersionPolicy = {
  current: NOTE_SCHEMA_VERSION,
  /**
   * Only the current one, for the reason the profile's policy gives: this build has one shape to read a
   * note as, and reading an older one would mean defaulting a field AD-22 requires — which is
   * indistinguishable, once written, from a run that genuinely recorded nothing there.
   */
  supported: [NOTE_SCHEMA_VERSION],
};

/**
 * One step of the run, as the note records it.
 *
 * `disposition` is **not** nullable, unlike `StepRecord`'s. A `null` there means "in flight", and a note
 * is written on a merge commit — by which point every step of the run has terminated. A note that could
 * spell an in-flight step would be a durable record of a run that had not finished, which is the one
 * thing the in-repo record must not be able to say.
 */
export const NotedStepSchema = z.object({
  step: z
    .string()
    .describe('The step id, as the plan declared it. A stable name, never a positional index.'),
  phase: z.enum(STEP_PHASES).describe('Which phase of the pipeline the step belonged to.'),
  disposition: z
    .enum(STEP_DISPOSITIONS)
    .describe(
      'How the step ended (AD-8). Every step in a note has terminated, so there is no in-flight ' +
        'disposition and none may be recorded.',
    ),
});

export type NotedStep = z.infer<typeof NotedStepSchema>;

/**
 * The git note on the merge commit.
 *
 * `steps` is *ordered*: AD-22 says "the ordered step list", and the order is the order the run met them,
 * which is what makes the note readable as an account of what happened rather than as a set of outcomes.
 *
 * `usage` is nullable because absence is recorded as absence and never as a zero
 * (`src/contracts/usage.ts`): a run whose steps reported no usage records none, and a zeroed total would
 * be a claim that the run was free.
 */
export const GitNoteSchema = versioned(
  {
    /** The run id: a ULID minted solely by the engine (AD-29). */
    run: z.string().describe('The run id this note records. Never blank.'),
    feature: z
      .string()
      .describe('The feature slug the run was accepted for, kebab-case. Never blank.'),
    /**
     * The branch the committer named.
     *
     * AD-22 does not list it, and it is here for what the note is *for*: the note is the record that
     * survives the worktree and the central state, and a reader holding only the repository has no other
     * way back to where the work was done. The committer is its only source (`src/engine/committer.ts`),
     * which is the same rule AD-22 states about naming it in the first place.
     */
    branch: z.string().describe('The branch the committer named for this feature. Never blank.'),
    steps: z
      .array(NotedStepSchema)
      .describe(
        'Every step of the run with its disposition, in the order the run met them. A note records at ' +
          'least one step, and names each step once.',
      ),
    acceptance_criteria: z
      .array(z.string())
      .describe('The criteria the run was accepted with, verbatim and in their declared order.'),
    usage: StepUsageSchema.nullable().describe(
      'The run’s usage totals, or null when no step reported any. Never a zeroed record: absence ' +
        'is absence, and zero is a claim that the run cost nothing.',
    ),
    decisions: z
      .array(DecisionRecordSchema)
      .describe('The decisions taken during the run, as the ledger recorded them (CAP-18).'),
  },
  NOTE_SCHEMA_VERSION_POLICY,
).superRefine((note, ctx) => {
  if (note.run.trim() === '') {
    ctx.addIssue({
      code: 'custom',
      path: ['run'],
      message: 'a note records the run it is about; a blank run id records nothing findable',
    });
  }
  if (note.feature.trim() === '') {
    ctx.addIssue({
      code: 'custom',
      path: ['feature'],
      message: 'a note names the feature the run was accepted for; a blank slug names nothing',
    });
  }
  if (note.branch.trim() === '') {
    ctx.addIssue({
      code: 'custom',
      path: ['branch'],
      message:
        'a note names the branch the work was done on, because the note outlives the worktree and a ' +
        'reader holding only the repository has no other way back to it',
    });
  }
  /**
   * A note with no steps is the failure this artifact exists to prevent.
   *
   * AD-22 makes the note "the durable in-repo record", and an empty step list is a record of a run that
   * did nothing — which no run reaching a merge commit ever is. It also makes the per-step rules below
   * pass vacuously, which is the shape story 2-6's review named in `VerificationOutputSchema`.
   */
  if (note.steps.length === 0) {
    ctx.addIssue({
      code: 'custom',
      path: ['steps'],
      message:
        'a note records the ordered steps the run took; an empty list is a durable record of a run ' +
        'that did nothing, and it makes every per-step rule pass vacuously',
    });
  }
  const named = new Set<string>();
  note.steps.forEach((step, index) => {
    if (step.step.trim() === '') {
      ctx.addIssue({
        code: 'custom',
        path: ['steps', index, 'step'],
        message: 'a step is recorded under the id the plan declared; a blank id names nothing',
      });
    }
    if (named.has(step.step)) {
      ctx.addIssue({
        code: 'custom',
        path: ['steps', index, 'step'],
        message:
          `"${step.step}" appears twice; a re-run updates a step's record (AD-26), so two entries are ` +
          'two answers to how one step ended',
      });
    }
    named.add(step.step);
  });
});

export type GitNote = z.infer<typeof GitNoteSchema>;
