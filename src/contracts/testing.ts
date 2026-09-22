/**
 * `step.testing` — what the testing agent returns: the tests it wrote, and what each one is for.
 *
 * **Why a contract of its own rather than `step.output`.** AD-17 has a declaration reference a
 * contract by *id*, so two agents sharing one id cannot be told apart by anything the engine reads —
 * the defect story 2-4 found in the roster's own declarations and story 2-5 closed for
 * `implementation`. Until this story `testing` still named the generic envelope, whose `provenance`
 * is a flat `z.array(z.string())` beside the claims it is supposed to attribute, and which has no
 * field at all for the thing a testing step actually produces: which test files it wrote, and which
 * behaviour each one pins.
 *
 * **It is `step.implementation`'s shape, one noun over, and deliberately so.** A testing agent
 * writes files in the run worktree exactly as the implementing agent does, so it closes the same
 * channel the same way: every path is refused unless it stays inside the run worktree and inside the
 * territory *this same output* declares, and there is no field for "a path to write elsewhere". The
 * per-claim provenance idiom is `step.analysis`'s, reused rather than re-invented.
 *
 * **What it deliberately does not carry is a gate result.** Running a test is
 * `src/runner/`'s — the command runner ADR-004 made the only way a step executes anything — and what
 * the run is authoritative about is the event the engine recorded when that command ran, not what
 * the agent says about it afterwards (AD-4). A `passed: true` field here would be a second answer to
 * a question the log has already answered, and the two would disagree on exactly the runs where it
 * mattered. `step.verification` carries gate outcomes because the verification step is the one whose
 * *job* is to report them, and even there the log wins.
 *
 * **Bounds are refinements plus prose.** AD-2's structured-outputs subset admits no `minItems` above
 * one and no `minLength`, and a refinement emits nothing into the draft-7 export — so every rule a
 * refinement enforces is also stated in the `.describe()` of the field it binds. A rule the producer
 * cannot see makes `step.schema_invalid_output` the normal outcome, and that code is
 * `escalate-model-tier`: an invisible rule spends the run's one promotion on a step that did its job.
 *
 * It carries no `schema_version`, for the reason `step.analysis` gives: this is the model-facing
 * contract, not an on-disk artifact.
 */
import { z } from 'zod';

import { ClaimProvenanceSchema, attributesClaim } from './analysis.js';
import { StepOutputSchema } from './step.js';
import { isRepositoryRelativePath, normaliseTerritoryPath, territoryContains } from './territory.js';

/** The registry id this contract is registered under (AD-17), spelled once. */
export const TESTING_CONTRACT_ID = 'step.testing';

/**
 * What happened to one test file.
 *
 * A closed vocabulary rather than free text, for the reason `CHANGE_KINDS` is one: the reviewer
 * reading a run's record branches on it, and "added"/"created"/"new" spelled three ways is three
 * answers to one question. `deleted` is absent on purpose — a testing step that removes coverage is
 * doing the one thing this agent exists to prevent, and if it is ever legitimate it arrives as a
 * decision rather than as a value nobody chose.
 */
export const TEST_CHANGE_KINDS = ['added', 'updated'] as const;

export type TestChangeKind = (typeof TEST_CHANGE_KINDS)[number];

/**
 * One test file the step wrote, and what it pins.
 *
 * `covers` is the behaviour the test asserts, in a person's words. It is required and never blank
 * because a test nobody can describe is a test nobody can tell from a tautology — which is the
 * failure mode a testing agent has, and the one CAP-13's "something actively tries to break the
 * result" exists to bound.
 */
export const WrittenTestSchema = z.object({
  path: z
    .string()
    .describe(
      'The repository-relative path of the test file, inside the declared territory. Never blank, ' +
        'never absolute, never a home-directory path, never climbing out of the worktree, never ' +
        '"." — a test names one file, not the whole repository — and each path appears at most once.',
    ),
  kind: z
    .enum(TEST_CHANGE_KINDS)
    .describe('Whether this test file was added by this step or an existing one updated.'),
  covers: z
    .string()
    .describe(
      'The behaviour this test pins, in one line that stands alone and says what would break if it ' +
        'regressed. Never blank.',
    ),
  /**
   * **`provenance.source` is the one path-shaped field here that is deliberately not refused.**
   *
   * The reason is `step.implementation`'s: ADR-001 accepts that a host-side agent can *read* outside
   * the run worktree though it cannot write there, so a source naming a file outside is an honest
   * report of something that happened. It is safe to leave open because nothing resolves it — it is
   * attribution, rendered beside the test and never opened, joined or written to.
   */
  provenance: ClaimProvenanceSchema.describe(
    'The step that wrote this test and the source it was read from — the requirement, the change ' +
      'under test, or the file it was derived from. The source is attribution only; nothing opens it.',
  ),
});

export type WrittenTest = z.infer<typeof WrittenTestSchema>;

const TestingOutputShape = StepOutputSchema.extend({
  /**
   * Pinned to the registered id, so an output claiming `step.output` is refused by every reader of
   * the artifact and not only by the spawner's own comparison.
   */
  contract_id: z.literal(TESTING_CONTRACT_ID),
  tests: z
    .array(WrittenTestSchema)
    .describe(
      'Every test file this step wrote, each carrying its own provenance. A completed testing step ' +
        'wrote at least one; report "blocked" rather than completing with none.',
    ),
  territory: z
    .array(z.string())
    .describe(
      'Repository-relative paths this step was admitted to and wrote within, covering every test ' +
        'file. Declare at least one whenever any test was written; "." means the whole repository. ' +
        'Never blank, never absolute, never climbing out of the worktree, each entry spelled already ' +
        'normalised (no "./" prefix, no trailing slash) and appearing at most once.',
    ),
});

/**
 * `step.testing`'s output.
 *
 * Every refinement is applied per element and names the element it refused, so a refusal says which
 * test was unattributed or outside the territory rather than that "tests was invalid".
 */
export const TestingOutputSchema = TestingOutputShape.superRefine((output, ctx) => {
  /**
   * The territory is validated before containment is asked of it, for the reason `step.analysis`
   * gives: a malformed entry makes `territoryContains` answer about a territory that is not the
   * declared one, and every test is then blamed for the territory's fault.
   */
  let territoryWellFormed = output.territory.length > 0;
  const declaredEntries = new Set<string>();
  output.territory.forEach((path, index) => {
    if (!isRepositoryRelativePath(path)) {
      territoryWellFormed = false;
      ctx.addIssue({
        code: 'custom',
        path: ['territory', index],
        message:
          `"${path}" is not a repository-relative path, so no run worktree contains it. A blank entry, ` +
          'an absolute path or a "src/.." would normalise to the whole repository and make every ' +
          'test-inside-its-territory check vacuous.',
      });
      return;
    }
    const normalised = normaliseTerritoryPath(path);
    if (normalised !== path.trim()) {
      ctx.addIssue({
        code: 'custom',
        path: ['territory', index],
        message:
          `"${path}" is not spelled normalised; declare it as "${normalised}". Two spellings of one ` +
          'path compare unequal, and an overlap read as disjoint is the direction that corrupts a worktree.',
      });
    }
    if (declaredEntries.has(normalised)) {
      ctx.addIssue({
        code: 'custom',
        path: ['territory', index],
        message: `"${path}" is declared twice; one territory entry names one place exactly once`,
      });
    }
    declaredEntries.add(normalised);
  });

  /**
   * **A territory is required by the tests, not by the status**, which is `step.implementation`'s
   * rule and it is here for the same measured reason: binding it to `completed` left a `blocked`
   * output that had written files parsing with no territory at all, and with none declared every
   * per-test containment refinement below passed vacuously. A step that blocked halfway still wrote
   * the files it wrote.
   */
  if (output.tests.length > 0 && output.territory.length === 0) {
    ctx.addIssue({
      code: 'custom',
      path: ['territory'],
      message:
        'this output wrote a test and declared no territory, so every test-inside-its-territory ' +
        'check would pass vacuously. Declare the paths the step was admitted to, whatever status it ' +
        'reports.',
    });
  }

  if (output.status === 'completed' && output.tests.length === 0) {
    ctx.addIssue({
      code: 'custom',
      path: ['tests'],
      message:
        'a completed testing step wrote at least one test; an empty list is a completion with ' +
        'nothing written, and it makes every per-test rule pass vacuously. Report "blocked" instead ' +
        'if no test could be written.',
    });
  }

  const seen = new Set<string>();
  output.tests.forEach((test, index) => {
    if (test.covers.trim() === '') {
      ctx.addIssue({
        code: 'custom',
        path: ['tests', index, 'covers'],
        message:
          'a test says what it pins; a blank line describes nothing and cannot be told from a ' +
          'tautology that passes whatever the code does',
      });
    }
    if (!attributesClaim(test.provenance)) {
      ctx.addIssue({
        code: 'custom',
        path: ['tests', index, 'provenance'],
        message:
          'every test carries the step that wrote it and the source it was derived from ' +
          '(architecture.md, Coordination); a test with either half blank is unattributed',
      });
    }
    if (!isRepositoryRelativePath(test.path)) {
      ctx.addIssue({
        code: 'custom',
        path: ['tests', index, 'path'],
        message:
          `"${test.path}" is not inside the run worktree, so this step cannot have written it: ` +
          'ADR-001 bounds this agent by --restricted plus --add-dir scoped to that worktree, and a ' +
          'file anywhere else is a write intent the engine executes (AD-15), never one this step wrote',
      });
      return;
    }
    if (normaliseTerritoryPath(test.path) === '.') {
      ctx.addIssue({
        code: 'custom',
        path: ['tests', index, 'path'],
        message:
          `"${test.path}" is the repository root, not a file. A test names the one file it is in; ` +
          'the root would report every file in the tree as a test and satisfy every containment check.',
      });
      return;
    }
    // Only asked when the territory itself parsed: see the note at the top of this refinement.
    if (territoryWellFormed && !territoryContains(output.territory, test.path)) {
      ctx.addIssue({
        code: 'custom',
        path: ['tests', index, 'path'],
        message:
          `"${test.path}" is outside the territory this output declares (${output.territory.join(', ')}); ` +
          'the declared territory is what the reconciler serialises two features on, so a file ' +
          'outside it is a write into another feature’s conflict domain',
      });
    }
    const normalised = normaliseTerritoryPath(test.path);
    if (seen.has(normalised)) {
      ctx.addIssue({
        code: 'custom',
        path: ['tests', index, 'path'],
        message:
          `"${test.path}" is reported twice; one file has one outcome in one step, and two records ` +
          'for it are two answers to what happened to it',
      });
    }
    seen.add(normalised);
  });

  /**
   * An evidence pointer names a path **in the evidence plane** (AD-23), and that plane is rooted in
   * the run directory. The spelling rule is `step.implementation`'s, unchanged, because it is the
   * same escape one plane over: an absolute path, a home-directory spelling or a `..` reaches a file
   * the run does not own.
   */
  output.artifacts.forEach((pointer, index) => {
    if (!isRepositoryRelativePath(pointer.path)) {
      ctx.addIssue({
        code: 'custom',
        path: ['artifacts', index, 'path'],
        message:
          `"${pointer.path}" is not a path inside the run's evidence plane; AD-23 has an artifact ` +
          'referenced by a pointer into that plane, never by an absolute path, a home-directory path ' +
          'or one climbing out of the run directory',
      });
      return;
    }
    if (normaliseTerritoryPath(pointer.path) === '.') {
      ctx.addIssue({
        code: 'custom',
        path: ['artifacts', index, 'path'],
        message:
          `"${pointer.path}" resolves to the run directory itself, not to an artifact in it; an ` +
          'evidence pointer names the one thing it points at (AD-23)',
      });
    }
  });
});

export type TestingOutput = z.infer<typeof TestingOutputSchema>;
