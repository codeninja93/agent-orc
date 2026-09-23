/**
 * AD-7 — the engine is a reconciler over on-disk state, not an in-memory supervisor.
 *
 * The loop reads the checkpoint, takes at most one next action, writes the checkpoint, and holds no
 * authoritative run state in memory. Killing it at any instant and restarting must produce identical
 * behaviour to never having stopped — which is a property of the *shape* of the loop, not of a set of
 * shutdown handlers that each have to be correct.
 *
 * Four decisions make that property hold, and each is worth stating because each is load-bearing:
 *
 * **The checkpoint is written from the log, never from memory.** After every action the loop re-reads
 * `events.jsonl`, folds it, and writes the result. So a checkpoint can never carry a fact the durable
 * truth does not, and "where they disagree the log wins" (AD-4) is structural rather than a branch
 * somebody has to remember to take.
 *
 * **An action is a step driven to termination.** Splitting "start" and "observe the outcome" across two
 * passes would mean holding an in-flight process in memory between them, which is exactly the
 * in-memory owner AD-7 forbids. So the loop starts a step, waits for the port to report a termination,
 * records it, and writes the checkpoint — one action, and the whole of it is durable before the pass
 * returns.
 *
 * **A step found in flight after a restart is adopted as `interrupted`.** That is the only honest
 * reading of the state: the engine was killed inside the step, the subprocess is gone with it, and AD-8
 * says an interruption is resumed by session id and otherwise re-run from the baseline. The adoption is
 * itself a recorded action, so it is visible in the log rather than inferred by each reader.
 *
 * **Every identifier travels in an envelope field.** Story 1-2's redaction pass replaces an unbroken
 * ULID or commit SHA wherever it appears in a payload, so the run id, the baseline ref and the session
 * id are envelope fields on the verbatim allow-list. Payloads carry only short, punctuated,
 * low-entropy values. Getting this wrong is silent: the run works and the log becomes unreadable.
 */
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  ANALYSIS_CONTRACT_ID,
  COMMITTING_CONTRACT_ID,
  DETERMINISTIC_GATE_NAMES,
  IMPLEMENTATION_CONTRACT_ID,
  TESTING_CONTRACT_ID,
  VERIFICATION_CONTRACT_ID,
  declaredTerritoryIn,
  CURRENT_SCHEMA_VERSION,
  DECLARATION_PAYLOAD_KEYS,
  PLANNING_CONTRACT_ID,
  MODEL_RUNGS,
  REPAIRED_PAYLOAD_KEY,
  SPEC_CRITERION_EDITED_EVENT_TYPE,
  SPEC_RECORDED_EVENT_TYPE,
  SpecCriterionEditedPayloadSchema,
  SpecRecordedPayloadSchema,
  StepInputSchema,
  USAGE_PAYLOAD_KEY,
  compareEventOrder,
  featureStateFingerprint,
  findStepRecord,
  formatTimestamp,
  inFlightStep,
  isTerminalFeatureState,
  makeError,
  renderCause,
  renderSchemaRefusal,
} from '../contracts/index.js';
import type {
  Command,
  CommandIntent,
  CommandSource,
  DeflectionSource,
  EventEnvelope,
  FeatureState,
  GateOutcome,
  MechanicsCommands,
  ModelRung,
  OrchError,
  Principal,
  QuestionDraft,
  QuestionState,
  RunState,
  StepInput,
  StepRecord,
} from '../contracts/index.js';
import {
  REDACTION_FAILED_EVENT_TYPE,
  REDACTION_MARKER,
  Recorder,
  isStopCommand,
  readEventLog,
  resolveOrchHome,
  runPaths,
  runsDir,
} from '../runtime/index.js';
import type { RedactionPolicy, RunPaths } from '../runtime/index.js';

import { BaselineResetError, gitBaselineResetter, resetToBaseline } from './baseline.js';
import type { BaselineResetter } from './baseline.js';
import {
  checkpointPath,
  listRunIds,
  readCheckpoint,
  sweepCheckpointTemporaries,
  writeCheckpoint,
} from './checkpoint.js';
import {
  COMMAND_EVENT_TYPES,
  TORN_INTENT_GRACE_MS,
  appliedIntentIds,
  mintIntentId,
  newCommandIntent,
  pruneRetiredIntents,
  quarantineIntent,
  readIntentFiles,
  retireIntent,
  sweepCommandTemporaries,
  writeCommandIntent,
} from './commands.js';
import type { IntentRefusal, IntentRefusalReason, PendingIntent } from './commands.js';
import {
  DECLARED_STEP_ATTEMPT_LIMIT,
  attemptBoundReached,
  attemptsAgainstBound,
  returnsToSameStep,
  routeRefusedResume,
  routeTermination,
} from './dispositions.js';
import {
  escapeHatch,
  execFileWorktreeGit,
  handoffTimestamp,
  writeHandoffDocument,
} from './handoff.js';
import type { EscapeHatchOutcome, WorktreeGit } from './handoff.js';
import {
  commandAppliedPayload,
  commandRefusedPayload,
  decideSteering,
  effectTarget,
} from './steering.js';
import type { IntentEffect, QuestionSteering } from './steering.js';
import { DECISION_EVENT_TYPE, decidedQuestionIds, decisionFor, decisionPayload } from './decision.js';
import {
  QUESTION_EVENT_TYPES,
  UnloggableQuestionId,
  activeQuestion,
  askQuestion,
  askedQuestionIds,
  attemptQuestionDeflection,
  attemptQuestionResolution,
  lastSettledQuestion,
  listQuestionIds,
  mintQuestionId,
  parseOptionSelection,
  questionAskedPayload,
  questionEventPayload,
  questionResolution,
  readQuestionDirectory,
  settleQuestion,
  settledQuestionIds,
  sweepQuestionTemporaries,
} from './questions.js';
import type { QuestionClaim, SettledQuestion } from './questions.js';
import {
  describeDefaultTaken,
  isQuestionDefaultDue,
  takeQuestionDefault,
} from './question-window.js';
import { ResumeRefused, terminated } from './executor.js';
import type { StepExecutor, StepStartRequest, StepTermination } from './executor.js';
import {
  ENGINE_EMITTER,
  ENGINE_EVENT_TYPES,
  RESUME_COUNTS_TOWARD_BOUND_KEY,
  rebuildFromLog,
  reconcileCheckpointAgainstLog,
} from './rebuild.js';
import type { CheckpointDisagreement, FeaturePlan, PlanStep } from './rebuild.js';
import {
  TERRITORY_DECLARED_EVENT_TYPE,
  admitByTerritory,
  recordTerritoryRedeclaration,
  territoryDeclaredPayload,
} from './territory.js';
import type { TerritoryCandidate, TerritoryDeferral } from './territory.js';
import { EngineLock } from './lock.js';
import { resolveAgentGrant } from './agents.js';
import { readStepConfiguration } from './config-snapshot.js';
import { ProfileNotFound } from './profile.js';
import {
  BRANCH_PROTECTION_ASSERTED_EVENT_TYPE,
  BRANCH_PROTECTION_NOT_CONFIGURED,
  BRANCH_PROTECTION_PAYLOAD_KEYS,
  assertBranchProtection,
} from './protection.js';
import type { BranchProtectionRequest } from './protection.js';
import { ModelRungUnrecognised, rungForAttempt } from './promotion.js';
import { defaultUlidMinter } from './ulid.js';
import type { UlidMinter } from './ulid.js';

/** `runs/<run-id>/steps/` — where a step's typed input file lives. */
export const STEPS_DIR_NAME = 'steps';

/**
 * The steps a feature runs, one per phase, in the order a run meets them.
 *
 * **Why the engine states the sequence and not the grants.** AD-17 forbids the engine a compiled-in list
 * of *agents* — who exists, and what each may do — because that is declarative configuration a repository
 * owns. The order the four phases run in is not that: it is the workflow AD-1 and CAP-13 describe, a
 * feature is analysed before it is planned and verified after it is built, and `FeaturePlan` has always
 * been the engine's own shape. Each step names a *registered contract id*, which is the reference AD-17
 * requires, and the grant for each phase is still read from the roster at spawn time and nowhere else.
 *
 * Until story 2-4 this list existed only in the test fixtures and held two steps, so no plan ever carried
 * `phase: 'analysis'` and the analysis contract, the phase vocabulary and the territory re-declaration were
 * each reachable only by a test constructing them by hand. A caller may still supply its own plan; this is
 * what a feature gets when nobody does.
 */
export const STANDARD_PLAN_STEPS: readonly PlanStep[] = Object.freeze([
  { step: 'analyse', contract_id: ANALYSIS_CONTRACT_ID, phase: 'analysis' },
  { step: 'plan', contract_id: PLANNING_CONTRACT_ID, phase: 'planning' },
  // Story 2-5 registered `step.implementation`, whose shape pins `contract_id` to its own id. A plan
  // still naming `step.output` here would be validated against the generic envelope, so every
  // per-change provenance and outside-the-worktree refusal the new contract adds would be dead for
  // every default run — the same pairing failure story 2-4 found in the roster's declarations.
  { step: 'implement', contract_id: IMPLEMENTATION_CONTRACT_ID, phase: 'implementation' },
  // Story 2-6. `testing` was a declared agent with no phase and no step, so the plan went from the
  // change straight to judging it: CAP-13's "something actively tries to break the result" had
  // nothing in the plan that tried. It sits before `verify` because a test written after the
  // verdict is a test written to agree with it.
  { step: 'test', contract_id: TESTING_CONTRACT_ID, phase: 'testing' },
  // `verify` named the generic envelope until story 2-6 — the same pairing failure as above, and the
  // one that mattered most: `step.verification` is what makes a gate outcome and a per-criterion
  // verdict sayable at all, and under `step.output` every refusal it adds was unreachable.
  { step: 'verify', contract_id: VERIFICATION_CONTRACT_ID, phase: 'verification' },
  // Story 2-7. `committing` was a declared agent with no phase and no step, so the standard plan ended at
  // the verdict and nothing in it ever reached AD-22's note — the one record that survives the worktree.
  // It is last because the note is written on the merge commit, which is the end of the run.
  { step: 'commit', contract_id: COMMITTING_CONTRACT_ID, phase: 'committing' },
]);
export const STEP_INPUT_FILE_NAME = 'input.json';

/**
 * Where a step's input file sits, relative to the run directory.
 *
 * Spelled once because two callers now need it at different moments: `step.started` names it before
 * the file exists — the gates run between the two, and their outcomes go into it — and `stepInput`
 * returns it beside the value it wrote.
 */
export const stepInputRelativePath = (step: string): string =>
  `${STEPS_DIR_NAME}/${step}/${STEP_INPUT_FILE_NAME}`;

// -------------------------------------------------------------------------------------------------
// CAP-2 — the acceptance criteria as lines of the durable truth
// -------------------------------------------------------------------------------------------------

/**
 * The two spec event types, and the payloads they carry.
 *
 * They live beside the loop that emits them rather than in `rebuild.ts` for one reason: the payloads are
 * built from a {@link FeaturePlan}, which is *declared configuration* and not run state, and this is the
 * only unit that holds both. The types themselves are declared in `src/contracts/event.ts` with their
 * schemas, because a reader outside the engine — the renderer today, story 3-1's web surface next — must be
 * able to look them up without importing the engine.
 *
 * Neither type folds into the checkpoint. `state.json` already carries the plan's criteria as declared
 * configuration; what was missing was the *log* carrying them, so the six required surfaces are
 * reconstructable from `events.jsonl` alone (AD-4). Recording them in both places is not a second
 * authority: the log is authoritative and the checkpoint is discarded and rebuilt from it.
 */
export { SPEC_RECORDED_EVENT_TYPE, SPEC_CRITERION_EDITED_EVENT_TYPE };

/** The command whose argument is an amended criterion, spelled once (CAP-2). */
const EDIT_CRITERION_COMMAND = 'edit_criterion';

/**
 * How an amendment names the line it amends, read back here.
 *
 * `editCriterionArgument` in `src/tui/cards/spec-echo.ts` writes `criterion 3: <wording>`, and this is the
 * other half of that one agreement. It is a *parse*, not a format: Q6 forbids imposing a format on a
 * person, so an amendment that names no line is still recorded with the text it carried and a `null` line,
 * and a reader states it as an edit it could not place rather than discarding what somebody wrote.
 *
 * **The word `criterion` is optional, because nobody types it.** A keystroke sends the raw draft — there is
 * no line selection in the card and the card's own hint tells a person to give the number themselves — so
 * the commonest amendment there is reads `3: <wording>`, and requiring the noun recorded every one of them
 * with `line: null`. The card said "give its number", the engine accepted only "criterion 3:", and the two
 * halves of CAP-2's one agreement disagreed with nobody in a position to notice. Parsing what a person
 * actually types is what Q6 means by the system parsing.
 */
const CRITERION_AMENDMENT = /^\s*(?:criterion\s+)?(\d+)\s*[:.\-]\s*(.*)$/is;

/** The payload of a `spec.recorded` line: the request, and the criteria in their declared order. */
export const specRecordedPayload = (plan: FeaturePlan): Record<string, unknown> =>
  SpecRecordedPayloadSchema.parse({
    [DECLARATION_PAYLOAD_KEYS.Request]: plan.request,
    [DECLARATION_PAYLOAD_KEYS.AcceptanceCriteria]: [...plan.acceptance_criteria],
  });

/** The payload of a `spec.criterion_edited` line, parsed out of the intent's free text (Q6). */
export const criterionEditedPayload = (argument: string): Record<string, unknown> => {
  const match = CRITERION_AMENDMENT.exec(argument);
  const line = match === null ? null : Number.parseInt(match[1] ?? '', 10);
  const text = match === null ? argument.trim() : (match[2] ?? '').trim();
  return SpecCriterionEditedPayloadSchema.parse({
    /**
     * A line number that did not parse to a positive integer is no line number: better an edit recorded
     * without one than an edit attached to criterion zero.
     *
     * **Safe** integer, not merely integer. `Number.parseInt` on a long run of digits yields a finite value
     * outside the safe range — `Number.isInteger(1e20)` is `true` — and `z.int()` refuses it, so the parse
     * below threw, the throw reached `applyIntent` and the amendment was quarantined. Q6 promises a person's
     * free text is never refused, and "criterion 99999999999999999999: reword" is free text. It is an
     * addressing failure, which this line already has an answer for: record the wording with no line.
     */
    [DECLARATION_PAYLOAD_KEYS.CriterionLine]:
      line === null || !Number.isSafeInteger(line) || line < 1 ? null : line,
    // The wording a person gave, never the wrapper the card put around it — and never empty, because an
    // amendment with no text is still evidence that somebody edited that line.
    [DECLARATION_PAYLOAD_KEYS.CriterionText]: text === '' ? argument.trim() : text,
  });
};

/** A step id safe as a directory name. Step ids are stable declared names, never free text. */
const SAFE_STEP_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/**
 * A declared wall-clock allowance carried on the step input so the contract is satisfied.
 *
 * AD-24's ceilings — step count, wall clock and rate-limit budget — are story 2-9's to *enforce*, and
 * this story's Never list excludes them. The value is therefore declared and passed through, and
 * nothing here degrades, hibernates or refuses on it. Naming it rather than inlining a number is what
 * keeps that honest: when 2-9 arrives it replaces this constant, it does not discover a magic literal.
 */
export const DECLARED_WALL_CLOCK_MS = 60 * 60 * 1000;

/**
 * How often the loop looks at `runs/<run-id>/commands/` while a step is in flight.
 *
 * AD-7 forbids holding authoritative state in memory, not reading the disk: the poll reads the same
 * durable files a pass reads, so a restart mid-step reaches the same conclusion from the same evidence.
 * It is a poll rather than a watcher because `fs.watch` is not reliable across every platform and
 * filesystem this will run on, and a missed watch event is a disengage the user pressed and nothing
 * happened — the one failure this mechanism exists to prevent.
 */
export const STEERING_POLL_INTERVAL_MS = 25;

/**
 * The loop's own share of the disengage latency: gesture on disk to stop delivered.
 *
 * The budget is the poll interval, one directory read, and the call into the executor's stop — two
 * orders of magnitude of slack over their sum, because the claim must hold on a loaded machine and not
 * only on an idle one. **This is the part the loop controls, and it is the only part it can promise.**
 * Once the stop has been delivered, how long the child takes to die is the executor's business.
 */
export const DECLARED_DISENGAGE_OBSERVATION_BOUND_MS = 2_000;

/**
 * The declared end-to-end bound on disengagement: gesture on disk to the run recorded as halted.
 *
 * `interface-contract.md` says disengagement is "instant, obvious and always available", and "instant"
 * is a measurable claim, so it gets a number. **The number this story declared was wrong**, and it was
 * wrong by construction rather than by measurement. It was 2s — the loop's share above — while story
 * 1-4's `EXECUTOR_KILL_GRACE_MS` gives a child that ignores `SIGTERM` a further 5s before `SIGKILL`.
 * A child that declines the first signal therefore cannot be dead inside 2s no matter what this loop
 * does, so the production stopper could never have met the bound the story promised.
 *
 * **The kill grace is authoritative, and this number is derived from it.** The grace is a decision about
 * a child process — how long a `claude -p` is given to finish a write and exit cleanly rather than lose
 * it to a `SIGKILL` — and it is owned by the unit that signals the child. A bound declared here cannot
 * shorten it; it can only describe the total honestly. So this is the grace, plus the loop's own share
 * above, plus a second for the termination and the intent's effect to be recorded:
 *
 *     5_000 (EXECUTOR_KILL_GRACE_MS, story 1-4) + 2_000 (observation) + 1_000 (record) = 8_000
 *
 * The arithmetic is spelled out rather than imported because `src/engine/spawner.ts` is the *adapter*
 * behind the {@link StepStopper} port and this module deliberately does not depend on it — importing the
 * constant would drag `node:child_process` into the loop's graph to read a number. The relationship is
 * asserted in `tests/engine.disengage.test.ts` instead, where a test may import both and does.
 *
 * A well-behaved child exits on the first signal in milliseconds, so the *typical* latency is the
 * observation bound. This is the worst case a user may be promised, not the case they will usually see.
 */
export const DECLARED_DISENGAGE_BOUND_MS = 8_000;

/**
 * The port a steering command stops a live child through.
 *
 * A port for the same reason the executor is one: the loop owns the decision that a step must stop, and
 * learns nothing about processes. Story 1-4's spawner satisfies it — `kill(step, run)` — and
 * {@link stepStopperFrom} adapts it without this module importing the spawner's type.
 *
 * Returns whether anything was stopped, which the loop records rather than asserts: an executor with
 * nothing live to stop is the ordinary case for a step that finished a millisecond earlier.
 */
export type StepStopper = (target: {
  readonly run: string;
  readonly step: string;
  readonly command: Command;
  readonly reason: string;
}) => boolean;

/**
 * The two things the mid-step watcher records, declared here because nothing folds them.
 *
 * AD-5 makes the vocabulary open: a reader meeting a type outside the declared list accepts the envelope
 * and ignores the event. Both of these are *observations about the loop* rather than facts about a run's
 * state — the state change a stop causes is the `command.applied` the intent produces — so neither is in
 * `FOLDED_EVENT_TYPES` and a checkpoint rebuilt without them is identical.
 */
export const STEERING_EVENT_TYPES = {
  /** A stop gesture was seen mid-step and the executor was asked to stop the child. */
  StopDelivered: 'steering.stop_delivered',
  /** A step ran on an engine with no stopper wired, so CAP-5's mid-step promise could not be kept. */
  StopperUnwired: 'steering.stopper_unwired',
} as const;

export type SteeringEventType = (typeof STEERING_EVENT_TYPES)[keyof typeof STEERING_EVENT_TYPES];

/** What the mid-step watcher saw, so the action that owns the step can report and apply it. */
export interface StopObservation {
  readonly intentId: string;
  readonly command: Command;
  /** Whether the executor had a live child to stop. `false` for a step that ended a moment earlier. */
  readonly stopped: boolean;
  readonly observedAt: string;
}

/** Adapt story 1-4's spawner to {@link StepStopper}, structurally so no type crosses the boundary. */
export const stepStopperFrom = (spawner: {
  readonly kill: (step: string, run?: string) => boolean;
}): StepStopper => (target): boolean => spawner.kill(target.step, target.run);

/** What one intent's consumption did. */
export const INTENT_OUTCOMES = [
  /** The effect was applied and recorded, and the file retired. */
  'applied',
  /** The id was already in the log: recognised, the file retired, nothing changed. */
  'already-applied',
  /** The run is already the way the command asked for: recognised, the file retired, nothing changed. */
  'already-satisfied',
  /** Recorded with its principal; this build changes no run state for it. */
  'acknowledged',
  /** AD-25 — the intent won the question's compare-and-set, and the decision is recorded. */
  'resolved-question',
  /** Left in place for the unit that owns this command. */
  'awaiting',
] as const;

export type IntentOutcomeKind = (typeof INTENT_OUTCOMES)[number];

/** One intent a pass looked at, and what became of it. */
export interface IntentOutcome {
  readonly intentId: string;
  readonly command: Command;
  readonly kind: IntentOutcomeKind;
  readonly principal: Principal;
  readonly reason: string;
}

/** What consuming one run's intents did. Reported by the pass; never acted on again. */
export interface IntentPassOutcome {
  readonly run: string;
  /** Intents whose effect or acknowledgement is now in the log. */
  readonly applied: readonly IntentOutcome[];
  /** Intents already in the log, retired without a second effect. */
  readonly recognised: readonly IntentOutcome[];
  /** Intents left for a later story's unit, named in each reason. */
  readonly awaiting: readonly IntentOutcome[];
  /** Intents refused and quarantined, each naming why. */
  readonly refused: readonly IntentRefusal[];
  /** Files not whole JSON yet, inside the grace their writer is given. Untouched. */
  readonly incomplete: readonly string[];
  /**
   * The state after everything applied, or `null` for a run directory that carries no state at all —
   * the case where the only thing that could be done with an intent was to quarantine it.
   */
  readonly state: RunState | null;
}

/** What became of one question in one pass. */
export const QUESTION_PASS_OUTCOMES = [
  /** A `question.asked` line the log still owed was appended. */
  'asked',
  /** A resolver won the compare-and-set and the decision is recorded (AD-25). */
  'resolved',
  /** CAP-4 — the window passed, the default was taken, and the decision is recorded. */
  'default-taken',
  /** Q4 — the question was answered without reaching the user, so no decision is recorded. */
  'deflected',
] as const;

export type QuestionPassOutcomeKind = (typeof QUESTION_PASS_OUTCOMES)[number];

/** One question a pass acted on, and what it left in the log. */
export interface QuestionPassAction {
  readonly questionId: string;
  readonly kind: QuestionPassOutcomeKind;
  /** Whether AD-25's decision record was written. False for every deflection, always. */
  readonly decisionRecorded: boolean;
  readonly reason: string;
}

/** A question a pass could not read, reported against its id rather than thrown. */
export interface QuestionRefusal {
  readonly questionId: string;
  readonly code: string;
  readonly reason: string;
}

/** What one run's questions did in one pass. Reported; never acted on again. */
export interface QuestionPassOutcome {
  readonly run: string;
  /** Questions whose state changed, or whose owed line was appended, this pass. */
  readonly settled: readonly QuestionPassAction[];
  /** Questions still `asked` whose window has not yet passed. Nothing is owed for them. */
  readonly open: readonly string[];
  /**
   * Questions still `asked` that nothing will ever resolve, because their run has reached `[*]`.
   *
   * A bucket of their own, and the distinction is a renderer's whole problem. AD-8 keeps a default from
   * being taken against a terminal run — a decision about work that has stopped — so such a question keeps
   * its `asked` state for ever, which is the honest record. It was nevertheless counted among {@link open},
   * whose own docblock says "whose window has not yet passed", so story 1-10's card said `N question(s)
   * open, none due` about a question nobody is waiting on and no window will close. Separating them is what
   * lets a surface say "abandoned unanswered" instead of "still waiting".
   */
  readonly abandoned: readonly string[];
  /**
   * Questions this pass could not act on — a torn state file, an unrecognised version, a read that failed,
   * or a directory name that is not a loggable question id.
   */
  readonly refused: readonly QuestionRefusal[];
}

/**
 * Which of a question's three lines the log already carries.
 *
 * Mutable, and threaded through one pass rather than re-read per question: every append updates it, so two
 * questions settled in one pass cannot each decide independently that a line is still owed.
 */
interface QuestionLedger {
  readonly asked: Set<string>;
  readonly settled: Set<string>;
  readonly decided: Set<string>;
}

/**
 * One line naming what a pass did to a run's questions, for a reader.
 *
 * An abandoned question is named as abandoned rather than counted as open, because those are two different
 * things to tell a person: one is a question still waiting for them, the other is one their run ended
 * without.
 */
export const describeQuestions = (outcome: QuestionPassOutcome): string => {
  const parts = outcome.settled.map((entry) => `${entry.questionId} ${entry.kind}`);
  for (const entry of outcome.refused) parts.push(`${entry.questionId} refused: ${entry.code}`);
  if (parts.length > 0) return `Questions settled: ${parts.join('; ')}.`;
  const waiting = `${String(outcome.open.length)} question(s) open, none due.`;
  return outcome.abandoned.length === 0
    ? waiting
    : `${waiting} ${String(outcome.abandoned.length)} abandoned unanswered on a terminal run.`;
};

/** One line naming what a pass did to a run's intents, for the action it is reported as. */
export const describeSteering = (outcome: IntentPassOutcome): string => {
  const parts: string[] = [];
  for (const entry of outcome.applied) parts.push(`${entry.command} applied (${entry.kind})`);
  for (const entry of outcome.recognised) parts.push(`${entry.command} was already applied`);
  for (const entry of outcome.refused) parts.push(`${entry.command ?? 'an intent'} refused: ${entry.reason}`);
  for (const entry of outcome.awaiting) parts.push(`${entry.command} left for its owner`);
  return parts.length === 0
    ? 'Durable intents were read and none of them changed anything.'
    : `Durable steering intents consumed: ${parts.join('; ')}.`;
};

/**
 * A run directory holding neither an event log nor a checkpoint.
 *
 * `acceptFeature` creates the directory and then appends `run.created`, so a crash in between leaves one
 * of these. It carries no run state at all — not even the feature it belongs to — so there is nothing to
 * reconcile and nothing to act on. It is named as its own condition rather than reported as a fault,
 * because a pass must step over it: letting it throw would stop every *other* feature from advancing for
 * as long as the directory exists, which is permanent.
 */
export class IncompleteRunDirectory extends Error {
  readonly code = 'config.invalid';
  readonly run: string;

  constructor(run: string) {
    super(
      `Run ${run} has a directory but neither an event log nor a checkpoint, so it carries no state ` +
        'and no feature. A crash between creating the directory and recording run.created leaves this; ' +
        'the run is skipped, never repaired.',
    );
    this.name = 'IncompleteRunDirectory';
    this.run = run;
  }
}

/**
 * A steering command refused because the run is past taking it.
 *
 * A terminal run has reached `[*]` in the lifecycle: confirming, approving or killing it would walk a
 * finished run backwards into `running`, and AD-8 is explicit that a `killed` step is never resumed and
 * never re-run. The refusal is raised rather than silently ignored so story 1-7 can render *why* a
 * control did nothing.
 */
export class SteeringRefused extends Error {
  readonly code = 'internal.invariant_violated';
  readonly run: string;
  readonly state: FeatureState;

  constructor(run: string, state: FeatureState, detail: string) {
    super(`Refusing to steer run ${run}: it is ${state}. ${detail}`);
    this.name = 'SteeringRefused';
    this.run = run;
    this.state = state;
  }
}

/**
 * An action whose event the redaction pass dropped.
 *
 * AD-21 fails closed, so a `step.started` or `step.terminated` carrying something unredactable is
 * replaced by a `redaction.failed` line — and the fold then cannot see the action at all. Proceeding
 * would leave the loop re-deciding the same action forever against a log that never records it, so the
 * action is abandoned loudly instead. The code's declared disposition is `abandon-and-hand-off`.
 */
export class UnrecordedAction extends Error {
  readonly code = 'redaction.failed';
  readonly eventType: string;

  constructor(eventType: string) {
    super(
      `The ${eventType} event was dropped by the redaction pass, so this action is not in the log. ` +
        'AD-21 fails closed and AD-4 makes the log the only truth, so an action the log cannot record ' +
        'is abandoned rather than performed unrecorded.',
    );
    this.name = 'UnrecordedAction';
    this.eventType = eventType;
  }
}

/** What the loop decided to do about one feature in one pass. */
export type ReconcileAction =
  /** Nothing to do: the feature is terminal, or a step was stopped by a steering command. */
  | { readonly kind: 'idle'; readonly reason: string }
  /**
   * AD-19 — durable intents were found in `commands/` and consumed.
   *
   * It is an action of its own, and it takes precedence over every other, so a pass that steers a run
   * does nothing else to it. Starting a step in the same pass that applied a kill would be two actions,
   * and the second would be work the user has just asked to stop.
   */
  | {
      readonly kind: 'apply-intents';
      readonly applied: number;
      readonly refused: number;
      readonly reason: string;
    }
  /** CAP-2 — no feature enters execution without user-confirmed criteria. */
  | { readonly kind: 'await-confirmation'; readonly reason: string }
  /** CAP-12 — an irreversible gate is waiting on a person. */
  | { readonly kind: 'await-approval'; readonly reason: string }
  /** A step was in flight when the engine died; record the interruption it actually suffered. */
  | { readonly kind: 'adopt-orphan'; readonly step: string; readonly reason: string }
  /** Start a step, from its typed input file, and record how it terminated. */
  | {
      readonly kind: 'run-step';
      readonly step: PlanStep;
      readonly transitionTo: FeatureState;
      readonly reason: string;
    }
  /** AD-8 — resume by the recorded session id. */
  | {
      readonly kind: 'resume-step';
      readonly step: string;
      readonly sessionId: string;
      readonly transitionTo: FeatureState;
      readonly reason: string;
    }
  /** AD-26 — reset the worktree to the step's `baseline_ref`, then re-run from the typed input. */
  | {
      readonly kind: 'reset-and-rerun';
      readonly step: string;
      readonly promoteTo: ModelRung | null;
      readonly transitionTo: FeatureState;
      readonly reason: string;
    }
  /** A lifecycle transition with no step attached, e.g. every step done so the run is committed. */
  | { readonly kind: 'advance-state'; readonly to: FeatureState; readonly reason: string }
  /** AD-35 — a condition no retrying resolves but a person can. */
  | { readonly kind: 'escalate-to-human'; readonly step: string | null; readonly reason: string }
  /** CAP-23 — stop and explain rather than thrash. */
  | {
      readonly kind: 'hand-off';
      readonly step: string | null;
      readonly code: string;
      readonly reason: string;
    };

export type ReconcileActionKind = ReconcileAction['kind'];

/** The action kinds that append nothing to the log, and so advance nothing. */
export const INERT_ACTION_KINDS: readonly ReconcileActionKind[] = [
  'idle',
  'await-confirmation',
  'await-approval',
];

export const isInertAction = (kind: ReconcileActionKind): boolean =>
  INERT_ACTION_KINDS.includes(kind);

/** What one feature's single action did, as the pass reports it. */
export interface PassAction {
  readonly run: string;
  readonly feature: string;
  readonly kind: ReconcileActionKind;
  readonly step: string | null;
  readonly from: FeatureState;
  readonly to: FeatureState;
  readonly reason: string;
  /** True when a checkpoint on disk disagreed with the log and was discarded in its favour. */
  readonly checkpointRebuilt: boolean;
  readonly disagreements: readonly CheckpointDisagreement[];
}

/**
 * A run this pass could not read or could not advance, reported rather than thrown.
 *
 * AD-28's refusal and AD-4's corrupt-log refusal are both *per artifact*: the rule is "never continue a
 * run whose log the reader refuses", not "never continue". One unreadable run must not stop every
 * unrelated feature, so a refusal is collected against its own run id and the pass carries on.
 */
export interface RunRefusal {
  readonly run: string;
  readonly code: string;
  readonly reason: string;
  /**
   * What the refusal is about, when it is not one run.
   *
   * `run` is documented as holding a run id, and a consumer that builds `runs/<run>/` from it is entitled
   * to. A pass-wide refusal — the reclamation sweep throwing, a resource it could not release — has no run
   * id to give, so it carries `scope: 'pass'` and an *empty* `run` rather than a readable placeholder: an
   * empty segment is refused by `assertSafePathSegment`, where a placeholder like `(reclamation)` would be
   * refused too but only after reading as though it were a real id.
   */
  readonly scope?: 'run' | 'pass';
}

/**
 * One resource a reclamation pass acted on, or declined to.
 *
 * `kind` is an open string rather than an enum for the same reason the error shape's `code` is: the unit
 * that owns resources declares what kinds exist, and the loop only reports what it was told.
 */
export interface ReclaimedResource {
  readonly kind: string;
  readonly id: string;
  readonly run: string;
  readonly reason: string;
  /**
   * The AD-35 code a failed reclamation carries, when the pass declared one.
   *
   * Reported, not acted on, like every other field here: the loop's job is to make a failure visible and the
   * next pass's job is to try again. `tests/pool.reclaim.test.ts` asserts at compile time that this shape and
   * `src/pool/reclaim.ts`'s stay identical, because two hand-kept copies of a seam drift silently.
   */
  readonly code?: string;
}

/** What one reclamation pass decided and did. Reported by the pass that invoked it, never acted on here. */
export interface ReclamationSummary {
  readonly reclaimed: readonly ReclaimedResource[];
  readonly retained: readonly ReclaimedResource[];
  readonly failed: readonly ReclaimedResource[];
}

/**
 * AD-32 — the reclamation pass a reconcile pass invokes.
 *
 * A port, satisfied structurally, for the same reason the executor and the spawn wrapper are: the loop
 * decides *when* reclamation happens and learns nothing about what a resource is. The rule AD-32 states
 * is about the when — "a reconcile pass comparing live resources against runs, never a shutdown handler"
 * — so that is the part the loop owns, and it is why this is called from `pass` rather than from `close`,
 * from an exit hook or from a `finally` around a run. A crash skips all three of those; it cannot skip
 * being called again by the next pass.
 */
export type ReclamationPass = () => ReclamationSummary;

export interface PassResult {
  /** One entry per feature the pass touched, each having taken at most one action. */
  readonly actions: readonly PassAction[];
  /** Features held back this pass because another holds an overlapping territory. */
  readonly deferred: readonly TerritoryDeferral[];
  /** Runs this pass refused to read or could not advance. Every other run still advanced. */
  readonly refusals: readonly RunRefusal[];
  /** AD-32 — what this pass reclaimed, or `null` when no reclamation pass is wired in. */
  readonly reclaimed: ReclamationSummary | null;
  /** AD-19 — one entry per run whose `commands/` directory held anything this pass looked at. */
  readonly steering: readonly IntentPassOutcome[];
  /** AD-25 — one entry per run whose `questions/` directory held anything this pass looked at. */
  readonly questions: readonly QuestionPassOutcome[];
}

/** What one `load` established: the paths, the declared plan, and the state the log folds to. */
export interface LoadedState {
  readonly paths: RunPaths;
  readonly plan: FeaturePlan;
  readonly state: RunState;
  /**
   * The log this state was folded from.
   *
   * Carried rather than re-read because the exactly-once ledger lives in the log: consuming an intent
   * has to know which ids are already applied, and folding the log twice in one pass to learn it would
   * double the expensive part of a pass for no new information.
   */
  readonly events: readonly EventEnvelope[];
  readonly disagreements: readonly CheckpointDisagreement[];
  readonly checkpointRebuilt: boolean;
}

/** One run and the state a pass loaded for it, threaded rather than folded twice. */
interface LoadedRun {
  readonly run: string;
  readonly loaded: LoadedState;
}

/** Render a thrown value as a per-run refusal, taking its declared code when it has one. */
const refusalFor = (run: string, thrown: unknown): RunRefusal => {
  const code = (thrown as { code?: unknown } | null)?.code;
  return {
    run,
    code: typeof code === 'string' ? code : 'internal.invariant_violated',
    reason: renderCause(thrown) ?? 'the run could not be read or advanced, and said nothing about why',
    scope: 'run',
  };
};

/** The same, for something that belongs to the pass rather than to any one run. */
const passRefusal = (code: string, reason: string): RunRefusal => ({
  run: '',
  code,
  reason,
  scope: 'pass',
});

/**
 * A port rejection, rendered as the termination it stands in for.
 *
 * A thrown value carrying a declared `code` is dispositioned by that code — `step.spawn_failed` retries.
 * Anything else gets `internal.invariant_violated`, whose declared disposition is abandon-and-hand-off:
 * a failure the port never declared is not one to retry into.
 */
const terminationFromThrown = (step: string, thrown: unknown): StepTermination => {
  const code = (thrown as { code?: unknown } | null)?.code;
  const rendered = renderCause(thrown) ?? 'the executor rejected without a reason';
  return terminated(step, 'failed', {
    error: makeError(
      typeof code === 'string' ? code : 'internal.invariant_violated',
      `the executor rejected step "${step}": ${rendered}`,
      rendered,
    ),
  });
};

/** Supplies a feature's declared configuration. Re-supplied after a restart, never folded from the log. */
export type FeaturePlanProvider = (feature: string) => FeaturePlan;

/**
 * A durable boundary the loop just crossed: either a line landed in the log, or a checkpoint landed on
 * disk. Every one of them is a point a crash-injection suite must be able to kill at.
 *
 * Declared surface, not a test hook bolted on: AD-31 requires killing the loop at *every* state
 * transition, and a suite cannot do that unless the loop says where its transitions are. The labels are
 * `event-appended:<type>` and `checkpoint-written:<state>`.
 */
export type DurableBoundaryObserver = (label: string) => void;

/**
 * What one deterministic gate did, as the loop reads it.
 *
 * Structurally what `src/runner/`'s `CommandRunResult` is, and **declared here rather than imported**
 * — the same seam AD-20's wrapper reaches the spawner through. `src/runner/` is the one unit that may
 * start a container, so an engine that imported it would be one `createCommandRunner` call away from
 * being a second one, and the guard in `tests/runner.command.test.ts` would have to carve out an
 * exception for the file most worth guarding. A structural port costs an interface and keeps the
 * claim absolute.
 */
export interface GateOutcomeRecord {
  readonly command: string;
  readonly declared: string;
  readonly outcome: 'passed' | 'failed' | 'skipped';
  readonly exitStatus: number | null;
  readonly evidence: string;
  readonly containerName: string | null;
  readonly summary: string;
  /** Why the evidence file is a placeholder: the AD-21 pass could not prove the output clean. */
  readonly evidenceDropped?: string;
}

/** The runner, as the loop needs it: one verb, over a name the profile declares. */
export interface DeterministicGateRunner {
  readonly run: (command: string) => GateOutcomeRecord;
}

/** What the loop tells the runner about the step whose gates it is running. */
export interface GateRunRequest {
  readonly run: string;
  readonly step: string;
  readonly worktree: string;
  /**
   * The profile's declared commands, read from the run's AD-9 snapshot by the loop.
   *
   * `MechanicsCommands` rather than a loose record, so a real assembly hands this straight to
   * `createCommandRunner` — which wants exactly that type — instead of casting. A port whose shape
   * needs a cast at the only call site that matters is a port that has not been fitted.
   */
  readonly commands: MechanicsCommands;
  /**
   * Which attempt of the step this is.
   *
   * Passed because the runner names a container with it, and AD-20 forbids `--rm` while a run is
   * live: the first attempt's container still exists when the step is re-run, so a name that did not
   * carry the attempt would be refused as already in use — and the refusal would read as a failing
   * gate. Measured against a real runtime, not reasoned about.
   */
  readonly attempt: number;
}

/**
 * The run's profile exists and cannot be read, so which gates it declares is unknown.
 *
 * Its own class rather than a re-raise, because the *reason* a gate did not run is the thing a
 * person needs: "this engine has no runner" and "this profile cannot be read" have different fixes
 * and only one of them involves the installer. `config.invalid` → `escalate-to-human`, like every
 * other configuration refusal here — nothing retries its way out of an unreadable profile.
 */
export class UnreadableGateConfiguration extends Error {
  readonly code = 'config.invalid';
  readonly run: string;

  constructor(run: string, cause: unknown) {
    super(
      `Run ${run} has a configuration snapshot whose profile cannot be read: ` +
        `${cause instanceof Error ? cause.message : String(cause)}. Which deterministic gates this ` +
        'repository declares is therefore unknown, and CAP-13 requires them to run before any ' +
        'model-based review — so the review is not spawned and the run stops here rather than ' +
        'treating an unreadable profile as a repository that declares no gates.',
      { cause },
    );
    this.name = 'UnreadableGateConfiguration';
    this.run = run;
  }
}

export interface ReconcilerOptions {
  /** `ORCH_HOME`; defaults to the AD-9 resolution. */
  readonly orchHome?: string;
  /**
   * How a run's recorder is obtained, so the loop and the executor can share one (AD-29).
   *
   * Defaults to opening one per run, which is what every caller has needed until now. It is
   * injectable because AD-29 makes the recorder the *single* appender to a run's `events.jsonl` and
   * enforces it with an exclusive claim — so a loop that opens its own and a spawner that opens its
   * own cannot both run against one run, and the second `Recorder.open` throws. Story 1-4's spawner
   * already says the caller "owns the AD-29 single-writer claim and hands the same recorder the
   * reconciler is already writing through"; until this option there was no way to hand it one, which
   * is why nothing in `src/` had ever assembled the two.
   */
  readonly recorderFor?: (run: string, feature: string) => Recorder;
  /**
   * CAP-13's first tier: how the loop runs the deterministic gates before it spawns a review.
   *
   * Omitted rather than defaulted, for the reason `reclamation` and `stopStep` are: the loop cannot
   * build one, because building one means starting a container and `src/engine/` may not. What is
   * *not* softened is the consequence — a run whose profile declares a gate and whose engine has no
   * runner wired in does not skip the gate and spend a review anyway. It blocks, naming the gate it
   * could not run. CAP-13's claim is that the gates run before any review, and an engine that cannot
   * run them cannot make that claim about itself.
   */
  readonly gates?: ((request: GateRunRequest) => DeterministicGateRunner) | null;
  /** The port story 1-4 implements. This story drives a double. */
  readonly executor: StepExecutor;
  /** A feature's declared plan, territory and mode. */
  readonly plans: FeaturePlanProvider;
  /** AD-26 — how a worktree is read and reset. Defaults to real `git`. */
  readonly baseline?: BaselineResetter;
  /** Injectable clock. */
  readonly now?: () => Date;
  /** AD-29 — the run-id minter. Defaults to a fresh monotonic one per reconciler. */
  readonly minter?: UlidMinter;
  /** AD-31 — where the loop's durable boundaries are, so a suite can kill at each in turn. */
  readonly onDurableBoundary?: DurableBoundaryObserver;
  /**
   * AD-21 — the redaction policy the run's recorder applies, including the literal values of the
   * credentials injected into this run's tool servers.
   *
   * The engine is the unit that knows which credentials a run was given, so it is the unit that can
   * register them. Passed through to the recorder rather than reimplemented: one pass, one policy.
   */
  readonly redaction?: RedactionPolicy;
  /** Skip the AD-30 lock. Only for a caller that already holds it; never in production. */
  readonly lock?: EngineLock | null;
  /**
   * AD-32 — the reclamation pass, invoked once per reconcile pass. Omitted means none is wired in.
   *
   * Omitted rather than defaulted because the loop cannot build one: resources live in `src/pool/`, which
   * this package may not import — the same direction that keeps the container boundary in exactly one
   * place. An engine with no reclamation reclaims nothing and says so, which is a visible gap rather than
   * a silent one.
   */
  readonly reclamation?: ReclamationPass | null;
  /**
   * CAP-5 — how a steering command stops a step that is already running.
   *
   * Omitted rather than defaulted, and the consequence is stated plainly: with no stopper wired in, a
   * disengage written mid-step is still consumed, but not until the step it arrived during has finished
   * on its own. That is a visible gap rather than a silent one, and it is why story 1-4's spawner is
   * adapted through {@link stepStopperFrom} by whoever assembles the two.
   */
  readonly stopStep?: StepStopper | null;
  /** How often `commands/` is read while a step is in flight. Defaults to the declared interval. */
  readonly steeringPollIntervalMs?: number;
  /** How long a partly-written intent file is left for its writer. Defaults to the declared grace. */
  readonly tornIntentGraceMs?: number;
  /** CAP-23 — how the escape hatch reaches git. Defaults to real `git`. */
  readonly worktreeGit?: WorktreeGit;
  /**
   * Who a steering command taken through this reconciler's own methods is attributed to.
   *
   * AD-19 requires every command to record a principal, and a method call carries none of its own. The
   * default names the local user, because that is who is at the terminal; a caller with better
   * information — a timeout, an agent — passes it per command instead.
   */
  readonly principal?: Principal;
  /**
   * The run-start branch-protection assertion (ADR-001), or `null` when nothing can make it.
   *
   * Absent is *not* "protected": `acceptFeature` records the outcome as `unknown` and starts the run,
   * because refusing every repository the engine cannot reach would stop an offline machine running at
   * all. `src/engine/protection.ts` holds the three outcomes and the judgement.
   */
  readonly branchProtection?: BranchProtectionRequest | null;
}

/**
 * What a method-shaped control supplies, beyond the run and the command.
 *
 * Every field has a default, because a caller at a terminal has a principal and a source whether it says
 * so or not, and AD-19 requires both to be recorded either way. `intentId` is settable so a caller that
 * retries a gesture can retry *the same* intent — which is the whole point of keying the effect on it:
 * a renderer whose write may or may not have landed rewrites it under the same id and gets one effect.
 */
export interface SteerOptions {
  /** AD-19 — who this command is attributable to. Defaults to the reconciler's declared principal. */
  readonly principal?: Principal;
  /** Which renderer or mechanism issued it. Defaults to `cli`. */
  readonly source?: CommandSource;
  /** The step the command targets, or `null` for a run-level command. */
  readonly step?: string | null;
  /** Free text; the system parses. Never impose a format on the human (Q6). */
  readonly argument?: string | null;
  /** The exactly-once key. Defaults to a freshly minted one. */
  readonly intentId?: string;
}

/** What asking a question through the reconciler supplies beyond the draft. */
export interface AskOptions {
  /** The step that raised the question, or `null` for a run-level one. */
  readonly step?: string | null;
  /**
   * The question id, so a caller that retries an ask retries *the same* question.
   *
   * Defaults to a freshly minted one. Settable for the same reason `intentId` is: a renderer whose write
   * may or may not have landed asks again under the same id and gets one question, not two.
   */
  readonly questionId?: string;
}

/** What accepting a feature produced. */
export interface AcceptedFeature {
  /** The minted run id: a 26-character Crockford base32 ULID (AD-29). */
  readonly run: string;
  readonly state: RunState;
}

/**
 * The reconciler.
 *
 * One per `ORCH_HOME`, holding the AD-30 lock for its lifetime. Every method that changes anything goes
 * through the same three motions — fold the log, act once, write the checkpoint from the log again —
 * so there is no path that advances a run without leaving the durable truth able to reproduce it.
 */
export class Reconciler {
  readonly orchHome: string;

  private readonly executor: StepExecutor;
  private readonly plans: FeaturePlanProvider;
  private readonly baseline: BaselineResetter;
  private readonly now: () => Date;
  private readonly minter: UlidMinter;
  private readonly boundaryObserver: DurableBoundaryObserver | null;
  private readonly redaction: RedactionPolicy;
  private readonly engineLock: EngineLock | null;
  private readonly ownsLock: boolean;
  private readonly reclamation: ReclamationPass | null;
  private readonly gates: ((request: GateRunRequest) => DeterministicGateRunner) | null;
  private readonly openRecorder: ((run: string, feature: string) => Recorder) | null;
  private readonly stopStep: StepStopper | null;
  private readonly pollIntervalMs: number;
  private readonly tornGraceMs: number;
  private readonly worktreeGit: WorktreeGit;
  private readonly principal: Principal;
  private readonly branchProtection: BranchProtectionRequest | null;
  /** Open recorders, keyed by run id. An I/O handle, not run state: nothing is read back from it. */
  private readonly recorders = new Map<string, Recorder>();
  private closed = false;

  /**
   * Runs already told, in the log, that this engine has no stopper wired.
   *
   * In memory rather than read back from the log on purpose: the fact is about *this process's* assembly,
   * so a restart is a different assembly and worth recording again. It is a report, never a decision —
   * nothing reads it to choose an action.
   */
  private readonly reportedMissingStopper = new Set<string>();

  /**
   * Intent outcomes produced *inside* an action, waiting for the pass to report them.
   *
   * The mid-step watcher's consumption happens in the middle of `driveStep`, which returns a step name
   * and has nowhere to put an `IntentPassOutcome`. Parking it here rather than discarding it is what makes
   * a mid-step refusal visible in `PassResult.steering` instead of silent. Drained by `pass`, so nothing
   * accumulates: a caller driving `advance` directly drains it on its next `pass`, and `close` drops it.
   */
  private readonly midStepSteering: IntentPassOutcome[] = [];

  private constructor(options: ReconcilerOptions, lock: EngineLock | null, ownsLock: boolean) {
    this.orchHome = options.orchHome ?? resolveOrchHome();
    this.executor = options.executor;
    this.plans = options.plans;
    this.baseline = options.baseline ?? gitBaselineResetter;
    this.now = options.now ?? ((): Date => new Date());
    // AD-29 makes monotonicity a property *per process*, so the process-wide minter is the default:
    // a fresh minter per reconciler could mint two ids in one millisecond that do not order against
    // each other, and the territory tie-break reads that order as "which run is older".
    this.minter = options.minter ?? defaultUlidMinter;
    this.boundaryObserver = options.onDurableBoundary ?? null;
    this.redaction = options.redaction ?? {};
    this.engineLock = lock;
    this.ownsLock = ownsLock;
    this.reclamation = options.reclamation ?? null;
    this.gates = options.gates ?? null;
    this.openRecorder = options.recorderFor ?? null;
    this.stopStep = options.stopStep ?? null;
    this.pollIntervalMs = options.steeringPollIntervalMs ?? STEERING_POLL_INTERVAL_MS;
    this.tornGraceMs = options.tornIntentGraceMs ?? TORN_INTENT_GRACE_MS;
    this.worktreeGit = options.worktreeGit ?? execFileWorktreeGit;
    this.principal = options.principal ?? { kind: 'user', id: 'local' };
    this.branchProtection = options.branchProtection ?? null;
  }

  /**
   * Start an engine: claim the `ORCH_HOME` lock, or refuse naming the holder.
   *
   * The lock is taken before anything is read, so a second engine never gets as far as opening a log
   * the first one is appending to.
   */
  static open(options: ReconcilerOptions): Reconciler {
    if (options.lock !== undefined && options.lock !== null) {
      return new Reconciler(options, options.lock, false);
    }
    const lock = EngineLock.acquire(
      options.orchHome === undefined ? {} : { orchHome: options.orchHome },
    );
    return new Reconciler(options, lock, true);
  }

  get lock(): EngineLock | null {
    return this.engineLock;
  }

  /**
   * Release the lock and every recorder claim this instance took. The log itself is never rewritten.
   *
   * A recorder a *caller* supplied is not closed here, for the reason the AD-30 lock is released only
   * when `ownsLock`: the claim belongs to whoever took it, and closing another unit's recorder would
   * release AD-29's single-writer claim out from under a caller that is still using it.
   */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.openRecorder === null) {
      for (const recorder of this.recorders.values()) recorder.close();
    }
    this.recorders.clear();
    if (this.ownsLock) this.engineLock?.release();
  }

  // ---------------------------------------------------------------------------------------------
  // Accepting and steering a feature
  // ---------------------------------------------------------------------------------------------

  /**
   * Accept a feature request: mint a run id and record the run at `drafting`.
   *
   * The id is minted here and nowhere else (AD-29). No step runs until the criteria are confirmed
   * (CAP-2), which is why the initial state is `drafting` rather than `running`.
   */
  acceptFeature(plan: FeaturePlan): AcceptedFeature {
    this.assertOpen();
    const run = this.minter.mint();
    const paths = runPaths(run, this.orchHome);
    mkdirSync(paths.runDir, { recursive: true });

    const recorder = this.recorderFor(run, plan.feature);
    this.emit(recorder, {
      step: null,
      type: ENGINE_EVENT_TYPES.RunCreated,
      payload: { mode: plan.mode, step_count: plan.steps.length },
    });

    /**
     * CAP-2 — the criteria go in the log, at the moment the run enters `drafting`.
     *
     * Here and not at confirmation, because the spec echo card is what a person confirms *from*: a run in
     * `drafting` whose criteria were not yet recorded would show `(not recorded)` and refuse to offer the
     * confirmation, which is the gap story 1-10 pinned. Recording them before anything can read them also
     * means the later-wins rule of `spec.recorded` has something to replace.
     */
    this.emit(recorder, {
      step: null,
      type: SPEC_RECORDED_EVENT_TYPE,
      payload: specRecordedPayload(plan),
    });

    /**
     * The declared territory, so a replay can recompute why two features were serialised.
     *
     * A path long enough reads as high-entropy secret material to the AD-21 pass, so this payload is the
     * one place in the engine that knowingly writes something the pass may rewrite. That is handled by the
     * *reader* rather than by an exemption: `territoryFromEvents` reports how many entries it could not
     * read and treats an incomplete territory as colliding with everything, which serialises a feature
     * unnecessarily at worst and never admits one wrongly. The plan remains the live authority for a
     * running pass; this line is what makes the decision reconstructable afterwards (AD-4).
     */
    this.emit(recorder, {
      step: null,
      type: TERRITORY_DECLARED_EVENT_TYPE,
      payload: territoryDeclaredPayload(plan.territory),
    });

    /**
     * ADR-001 — branch protection on the default branch, asserted at run start.
     *
     * Last of the four lines and not first, because the assertion is *about this run* and has to be
     * recorded against it: a refusal raised before `run.created` would leave a person with a refusal and
     * no run to read it on, and the three lines above are what makes the run readable at all. The
     * refusal still happens before anything is spawned, which is what "at run start" is for.
     *
     * An `unknown` outcome is recorded and the run continues. That is the honest degradation
     * `src/engine/protection.ts` exists for: a repository with no remote, or a host the engine cannot
     * reach, cannot be asserted against, and reporting that as satisfied would be a guarantee nobody
     * checked reading exactly like one somebody did.
     */
    const protection =
      this.branchProtection === null
        ? BRANCH_PROTECTION_NOT_CONFIGURED
        : assertBranchProtection(this.branchProtection);
    this.emit(recorder, {
      step: null,
      type: BRANCH_PROTECTION_ASSERTED_EVENT_TYPE,
      payload: {
        [BRANCH_PROTECTION_PAYLOAD_KEYS.Outcome]: protection.outcome,
        [BRANCH_PROTECTION_PAYLOAD_KEYS.Branch]: protection.branch,
        [BRANCH_PROTECTION_PAYLOAD_KEYS.Reason]: protection.reason,
      },
    });

    return { run, state: this.checkpointFromLog(paths, plan) };
  }

  /**
   * Write a steering intent and consume it: how every method-shaped control reaches the loop.
   *
   * This is **not** a second command path. AD-19 admits exactly one — a durable file under
   * `runs/<run-id>/commands/` — and this method writes that file and then consumes it, so the effect
   * arrives by the same route a renderer's would and through the same guards. Story 1-3 left `confirm`,
   * `approve` and `kill` as bare methods and recorded that as a deferral; this closes it without
   * changing what a caller sees.
   *
   * The consumption happens here rather than being left to the next pass because a caller that asked for
   * a state change and was handed the old state back would have to poll to discover whether anything
   * happened. The file is written first regardless, so a crash between the two leaves the intent on disk
   * for the next pass — the direction that loses nothing.
   */
  steer(run: string, command: Command, options: SteerOptions = {}): RunState {
    this.assertOpen();
    /**
     * Loaded before anything is written. A run with no state must be refused by name rather than have a
     * `commands/` directory created under it, which would turn a typo into a directory the loop then has
     * to step over on every pass.
     */
    const loaded = this.load(run);
    /**
     * A refusal by the contract is still a refusal, and is reported as one rather than as a crash.
     *
     * `newCommandIntent` calls `CommandIntentSchema.parse`, and story 1-12 moved two rules into that
     * schema — an argument-required command needs text, and the `timeout` source and the `timeout`
     * principal are one fact. So `reconciler.answer(run, '')` began throwing a bare `ZodError` out of a
     * method whose documented refusal is {@link SteeringRefused} carrying a sentence a person can read,
     * and the engine-side `missing-answer` guard became unreachable from the method path. The engine
     * guard stays where it is — it is the file path's, which is the path AD-19 actually admits — and
     * this converts the contract's refusal into the same shape the rest of this method raises. Nothing
     * is written: an intent the contract rejects is not a durable file anybody should have to sweep.
     */
    let intent: CommandIntent;
    try {
      intent = newCommandIntent({
        intentId: options.intentId ?? mintIntentId(this.minter.mint()),
        command,
        run,
        feature: loaded.state.feature,
        step: options.step ?? null,
        principal: options.principal ?? this.principal,
        source: options.source ?? 'cli',
        argument: options.argument ?? null,
        issuedAt: this.now(),
      });
    } catch (thrown: unknown) {
      const refusedBy = renderSchemaRefusal(thrown);
      if (refusedBy === null) throw thrown;
      throw new SteeringRefused(
        run,
        loaded.state.state,
        `the "${command}" intent is not one the declared contract accepts, so nothing was written: ` +
          refusedBy,
      );
    }

    writeCommandIntent(loaded.paths, intent);
    this.boundary(`intent-written:${command}`);

    const outcome = this.consumeIntents(this.load(run));
    const refused = outcome.refused.find((entry) => entry.intentId === intent.intent_id);
    if (refused !== undefined) {
      // Already recorded and already quarantined. It is *also* thrown, because a caller holding a
      // control in their hand is owed the reason it did nothing — story 1-3's guard, at its own surface.
      throw new SteeringRefused(run, loaded.state.state, refused.detail);
    }
    /**
     * A command nothing applied is not a command that worked.
     *
     * An `awaiting` decision leaves the file in place, unconsumed and unrecorded, for a later story's
     * unit — which is right for the file and wrong for this caller: it was handed the *old* state and no
     * error, so `reconciler.steer(run, 'pause')` read exactly like a pause that had happened. A caller
     * holding a control in their hand is owed the reason it did nothing, and "story 2-9 owns this" is a
     * reason. The file is deliberately **not** quarantined: its owner still has to see it, and that is the
     * whole point of `awaiting`.
     */
    const parked = outcome.awaiting.find((entry) => entry.intentId === intent.intent_id);
    if (parked !== undefined) {
      throw new SteeringRefused(run, loaded.state.state, parked.reason);
    }
    // `consumeIntents` returns `null` only for a run directory carrying no state at all, and `load`
    // above has already refused that case by name, so the fallback is unreachable rather than lenient.
    return outcome.state ?? this.load(run).state;
  }

  /**
   * CAP-2 — the user confirmed the acceptance criteria, so the feature may enter execution.
   *
   * Refused unless the run is still `drafting`: at-least-once delivery means one gesture can leave two
   * files, and a second confirmation applied to a running feature would drag it back to `confirmed`.
   */
  confirm(run: string, options: SteerOptions = {}): RunState {
    return this.steer(run, 'confirm_spec', options);
  }

  /**
   * CAP-12 — a person approved the gate the feature blocked at, so it may continue.
   *
   * Two facts land in one line, and the second is what makes this a continuation rather than a loop back
   * into the same escalation: the feature returns to `running`, *and* the blocked step's error is spent.
   * Without the second, the next pass would read the same `permission.denied` off the same termination
   * and block again on the thing a person has just answered.
   */
  approve(run: string, options: SteerOptions = {}): RunState {
    return this.steer(run, 'approve', options);
  }

  /**
   * AD-8 — a steering command terminated the step, which records `killed`.
   *
   * A killed step is never resumed and never re-run, and both halves are enforced: the record says
   * `killed`, which `routeTermination` answers with `stop`, and the feature enters the terminal `killed`
   * state, which every later pass answers with `idle`. Either alone would do; a recovery loop silently
   * undoing the kill control is the failure AD-8 exists to prevent, so it is closed twice.
   *
   * Only a step actually in flight is terminated. A kill normally arrives between passes, when the last
   * record is a step that has already finished — rewriting that record would put a permanent line in the
   * log saying work that was done never happened, and nothing would ever put it back.
   */
  kill(run: string, options: SteerOptions = {}): RunState {
    return this.steer(run, 'kill', options);
  }

  /**
   * CAP-5 — the single gesture that always means stop.
   *
   * The same effect as {@link kill}, and deliberately so: the Always list says a step stopped by a
   * steering command records `killed`, and AD-8 says the same, so the two gestures cannot differ in what
   * they leave behind. What differs is the record — the log says which command stopped the run and who
   * issued it — and the promise: a disengage is available at every moment, including the middle of a
   * step, within {@link DECLARED_DISENGAGE_BOUND_MS}.
   *
   * Everything needed to pick the work up again stays on disk: the checkpoint, the full event log, the
   * step's session id and its `baseline_ref`, and the worktree exactly as the step left it.
   */
  disengage(run: string, options: SteerOptions = {}): RunState {
    return this.steer(run, 'disengage', options);
  }

  /**
   * CAP-23 — a person takes the work over: partial work onto an ordinary branch, then the run halts.
   *
   * The branch is named from the run id (`orch/takeover/<run-id>`) and never from a feature slug,
   * because AD-22 gives the committer sole ownership of feature-branch naming.
   */
  takeOver(run: string, options: SteerOptions = {}): RunState {
    return this.steer(run, 'take_over', options);
  }

  // ---------------------------------------------------------------------------------------------
  // Asking and resolving a question (AD-25)
  // ---------------------------------------------------------------------------------------------

  /**
   * AD-25, CAP-4 — ask a question durably.
   *
   * The state file lands before the `question.asked` line, and that order is the crash story: the window
   * CAP-4 measures starts at `asked_at`, so a question whose event preceded its file would have a window
   * nothing could evaluate. A draft that the interface contract forbids asking — no recommended default,
   * no window, no brief, or more than three options — is refused naming the field, and nothing reaches
   * disk.
   */
  ask(run: string, draft: QuestionDraft, options: AskOptions = {}): QuestionState {
    this.assertOpen();
    const loaded = this.load(run);
    const questionId = options.questionId ?? mintQuestionId(this.minter.mint());
    const asked = askQuestion({
      paths: loaded.paths,
      questionId,
      feature: loaded.state.feature,
      step: options.step ?? null,
      draft,
      askedAt: this.now(),
    });
    this.boundary(`question-asked:${asked.created ? 'created' : 'already-durable'}`);
    this.recordQuestion(
      loaded.paths,
      loaded.state.feature,
      { paths: asked.paths, state: asked.state, outcome: null, eventType: null },
      this.questionLedger(loaded.events),
    );
    return asked.state;
  }

  /**
   * Q6 — answer the run's active question. Free text; the system parses.
   *
   * Routed through a durable intent file like every other control (AD-19), so the answer a renderer writes
   * and the answer a method call makes reach the compare-and-set by the same path and through the same
   * guards. If the window has already taken the default, this throws {@link SteeringRefused} carrying the
   * plain sentence saying so — a caller holding a control in their hand is owed the reason it did nothing,
   * and "it timed out while I was typing" is the case that must not be silent.
   */
  answer(run: string, answer: string, options: SteerOptions = {}): RunState {
    return this.steer(run, 'answer', { ...options, argument: answer });
  }

  /** CAP-18 — reject, with a reason that becomes the decision. The reason is never discarded. */
  reject(run: string, reason: string, options: SteerOptions = {}): RunState {
    return this.steer(run, 'reject', { ...options, argument: reason });
  }

  /** CAP-2 — amend one acceptance criterion, resolving the question that asked for it. */
  editCriterion(run: string, amended: string, options: SteerOptions = {}): RunState {
    return this.steer(run, 'edit_criterion', { ...options, argument: amended });
  }

  /**
   * Q4 — the question was answered from repository, git history or the decision ledger.
   *
   * It competes in the same compare-and-set as every resolver, because a deflection and a user's answer can
   * race: the Interviewer reading the ledger while the user types must produce one outcome. Nothing is
   * recorded as a decision — nobody was asked, so there is nobody to attribute one to (AD-25).
   */
  deflect(
    run: string,
    questionId: string,
    deflection: {
      readonly source: DeflectionSource;
      readonly answer: string;
      /** A durable anchor — a test name, API symbol or module name. Never a line number. */
      readonly anchor: string;
    },
  ): QuestionClaim {
    this.assertOpen();
    const loaded = this.load(run);
    const claim = attemptQuestionDeflection(loaded.paths, questionId, {
      source: deflection.source,
      answer: deflection.answer,
      anchor: deflection.anchor,
      deflected_at: formatTimestamp(this.now()),
    });
    this.boundary(`question-claimed:${claim.created ? 'deflection' : 'lost'}`);
    this.recordQuestion(
      loaded.paths,
      loaded.state.feature,
      settleQuestion(loaded.paths, questionId),
      this.questionLedger(loaded.events),
    );
    return claim;
  }

  /** Every question of one run, each already reconciled against the outcome that stands. */
  questions(run: string): readonly SettledQuestion[] {
    this.assertOpen();
    const paths = runPaths(run, this.orchHome);
    return listQuestionIds(paths).map((questionId) => settleQuestion(paths, questionId));
  }

  // ---------------------------------------------------------------------------------------------
  // Consuming durable intents
  // ---------------------------------------------------------------------------------------------

  /**
   * AD-19 — consume every durable intent for one run.
   *
   * The order of the motions inside is the whole of at-least-once delivery with an exactly-once effect,
   * and none of them may be swapped:
   *
   * 1. the intent is *read*, and reading deletes nothing;
   * 2. any side effect that has to survive — the escape hatch's branch, the hand-off document — happens
   *    next, and every one of them is idempotent, so repeating it costs nothing;
   * 3. one `command.applied` line carries the `intent_id` **and** every state change the intent makes,
   *    so the ledger entry and the effect cannot come apart;
   * 4. only then is the file moved into `commands/applied/`.
   *
   * A crash anywhere in that sequence redelivers the intent, and the id in step 3 is what makes the
   * redelivery a no-op. A crash *before* step 3 loses nothing, because the file is still there.
   */
  private consumeIntents(loaded: LoadedState): IntentPassOutcome {
    const { paths, plan } = loaded;
    let state = loaded.state;
    // A map, not a set: the command beside each id is what tells a redelivery from a different command
    // reusing an id, which the ledger would otherwise swallow as "already applied".
    const applied = new Map(appliedIntentIds(loaded.events));
    const read = readIntentFiles(paths, { now: this.now, tornGraceMs: this.tornGraceMs });

    const appliedOutcomes: IntentOutcome[] = [];
    const recognised: IntentOutcome[] = [];
    const awaiting: IntentOutcome[] = [];
    const refused: IntentRefusal[] = [];

    // Files that never parsed: quarantined before anything else, so a directory full of debris cannot
    // stop a valid intent sitting behind it from being applied in this same pass.
    for (const found of read.refused) refused.push(this.refuseIntent(paths, state.feature, found));

    for (const pending of read.pending) {
      const intent = pending.intent;
      const decision = decideSteering(intent, state, { applied });
      const outcome = (kind: IntentOutcomeKind, reason: string): IntentOutcome => ({
        intentId: intent.intent_id,
        command: intent.command,
        kind,
        principal: intent.principal,
        reason,
      });

      switch (decision.kind) {
        case 'awaiting':
          // Left on disk, unconsumed and unrecorded. Reported so it is visible rather than invisible.
          awaiting.push(outcome('awaiting', decision.reason));
          break;

        case 'already-applied':
        case 'already-satisfied':
          // Retired, not quarantined: nothing was wrong with the intent, and nothing was left to do.
          this.retire(paths, pending);
          recognised.push(outcome(decision.kind, decision.reason));
          break;

        case 'refuse':
          refused.push(
            this.refuseIntent(paths, state.feature, {
              reason: decision.reason,
              fileName: pending.fileName,
              intentId: intent.intent_id,
              command: intent.command,
              detail: decision.detail,
              quarantinedTo: null,
            }),
          );
          break;

        case 'resolve-question': {
          /**
           * AD-25 — the intent competes in the compare-and-set, and only then is it recorded.
           *
           * The order is the same one every other intent follows, for the same reason: the durable claim
           * lands first, and the `command.applied` line carrying the `intent_id` lands after it. A crash in
           * between redelivers the intent, which the id recorded *inside the claim* recognises as the same
           * gesture rather than as a second resolver — so a redelivery is told it won, not told it lost to
           * itself.
           */
          const resolved = this.resolveQuestionFromIntent(paths, state, pending, decision.question);
          if (resolved.refusal !== null) {
            refused.push(this.refuseIntent(paths, state.feature, resolved.refusal));
            break;
          }
          /**
           * The ledger line names the effect for what it was.
           *
           * An effect carrying no lifecycle state and no step disposition, because a question resolution
           * changes neither — but a *named* one, so a reader of the log sees `question-resolved` rather than
           * `acknowledged`, which is what a command that deliberately changes nothing records.
           */
          this.applyIntent(
            paths,
            plan,
            state,
            pending,
            {
              summary: 'question-resolved',
              toState: null,
              step: null,
              stepDisposition: null,
              clearsStepError: false,
              escapeHatch: false,
              handoff: null,
            },
            resolved.reason,
          );
          applied.set(intent.intent_id, intent.command);
          state = this.checkpointFromLog(paths, plan);
          this.retire(paths, pending);
          appliedOutcomes.push(outcome('resolved-question', resolved.reason));
          break;
        }

        case 'acknowledge':
        case 'apply': {
          const effect = decision.kind === 'apply' ? decision.effect : null;
          try {
            this.applyIntent(paths, plan, state, pending, effect, decision.reason);
          } catch (thrown: unknown) {
            /**
             * An effect that throws is quarantined, not left pending.
             *
             * Left pending it is a poison file with an effect's clothes on: the same intent is decided
             * again on the next pass, throws again, and again on every 25ms mid-step poll, for ever —
             * and because the throw used to escape `consumeIntents`, it took the whole run's pass with
             * it. Nothing was recorded, so the failure was invisible as well as permanent.
             *
             * Quarantining it is safe in the direction that matters: `command.applied` is the ledger
             * entry *and* the effect, so an intent whose emit threw has no effect in the log — there is
             * nothing half-applied to undo. The refusal below records why, the file leaves `commands/`,
             * and the pass carries on with the next intent.
             *
             * {@link UnrecordedAction} lands here too, and belongs here: a payload AD-21 cannot redact is
             * the same payload on every pass, so leaving it pending would loop for ever on a line that
             * will never be written. The refusal itself goes through the recorder directly, which does not
             * throw, so the explanation survives even when the effect could not.
             */
            refused.push(
              this.refuseIntent(paths, state.feature, {
                reason: 'effect-failed',
                fileName: pending.fileName,
                intentId: intent.intent_id,
                command: intent.command,
                detail:
                  `applying "${intent.command}" failed: ${
                    thrown instanceof Error ? thrown.message : String(thrown)
                  } Nothing was applied — the one line that carries an effect never reached the log — ` +
                  'and the file is moved aside rather than retried on every later pass.',
                quarantinedTo: null,
              }),
            );
            break;
          }
          applied.set(intent.intent_id, intent.command);
          // Re-folded before the next intent is decided: two intents in one pass are applied in order,
          // and the second must see what the first did rather than the state the pass opened with.
          state = this.checkpointFromLog(paths, plan);
          this.retire(paths, pending);
          appliedOutcomes.push(
            outcome(decision.kind === 'apply' ? 'applied' : 'acknowledged', decision.reason),
          );
          break;
        }
      }
    }

    return {
      run: paths.runId,
      applied: appliedOutcomes,
      recognised,
      awaiting,
      refused,
      incomplete: read.incomplete,
      state,
    };
  }

  /** Apply one intent's effect, as a single durable append preceded by its idempotent side effects. */
  private applyIntent(
    paths: RunPaths,
    plan: FeaturePlan,
    state: RunState,
    pending: PendingIntent,
    effect: IntentEffect | null,
    reason: string,
  ): void {
    const recorder = this.recorderFor(state.run, state.feature);

    /**
     * An effect naming a step the run has no record of is refused, not half-applied.
     *
     * `commandAppliedPayload` carries the `to_state` and the `step_disposition` in one line, and the fold
     * applies each independently: an unknown step means the lifecycle change lands and the step change is
     * silently dropped. For a kill that is a run recorded as `killed` with the step it named left
     * unrecorded — the exact shape of the defect story 1-3's review found, arrived at from the other end.
     * {@link effectTarget} is the check, and throwing here is how the intent reaches the quarantine in
     * `consumeIntents` rather than leaving a line that applies half of itself.
     */
    if (effect !== null && effect.step !== null && effectTarget(state, effect) === null) {
      throw new Error(
        `Refusing to apply "${pending.intent.command}" for run ${state.run}: its effect names step ` +
          `"${effect.step}", which this run has no record of. The one line that carries an effect would ` +
          'record the state change and drop the step change, leaving a run halted with the step it named ' +
          'untouched.',
      );
    }

    let escape: EscapeHatchOutcome | null = null;

    if (effect?.escapeHatch === true) {
      /**
       * CAP-23 — the work is put where a person can reach it *before* the line that says it was.
       *
       * A crash in between then leaves the work saved and the intent unretired, so the next pass does it
       * again — and `escapeHatch` is idempotent precisely so that is free. The other order would leave a
       * record claiming the work was preserved when it was not, which is the one outcome CAP-23 forbids.
       */
      escape = escapeHatch({
        run: state.run,
        feature: state.feature,
        worktree: plan.worktree,
        git: this.worktreeGit,
      });
      this.boundary(`escape-hatch:${escape.preserved ? 'committed' : 'branch-only'}`);
    }

    /**
     * CAP-23 — the recorded reason is corrected when the escape hatch failed, not only the document.
     *
     * The take-over's reason is composed in `decideSteering`, *before* the hatch runs, and it asserts that
     * "the partial work is put on an ordinary branch". When git fails there is no branch — and only
     * `HANDOFF.md` used to be told: the `command.applied` payload and the checkpoint the fold builds from
     * it kept the original claim, so the durable record said the work was on a branch that does not exist.
     * AD-4 makes the log the only authority, which is exactly why a false sentence in it is worse than a
     * false sentence in a document a person can compare against the disk.
     */
    const corrected: IntentEffect | null =
      effect?.handoff === undefined || effect.handoff === null || escape === null
        ? effect
        : {
            ...effect,
            handoff: {
              code: effect.handoff.code,
              // The hatch's own `detail` is the one sentence that is true in both directions — it says
              // "committed on the branch" when it was and "still in the worktree, uncommitted" when it was
              // not — so it is appended rather than the reason making a claim of its own about a branch.
              reason: `${effect.handoff.reason} ${escape.detail}`,
            },
          };

    if (corrected !== null && corrected.handoff !== null) {
      this.writeHandoff(paths, plan, state, {
        code: corrected.handoff.code,
        reason: corrected.handoff.reason,
        escape,
      });
      /**
       * AD-4 — a hand-off a *person* asked for is recorded in the log, not only in a document on disk.
       *
       * This line was missing, and its absence falsified the stage-1 gate rather than merely degrading a
       * card. `handoff.recorded` was emitted at exactly one place — {@link handOff}, reached from the AD-35
       * `hand-off` disposition and the baseline-reset failure — so the take-over intent path wrote
       * `HANDOFF.md` and appended nothing. A run a person took over therefore reached `handed_off` with
       * *why* existing nowhere in the durable truth: `command.applied` carries the state change and its
       * `reason`, but nothing carried the AD-35 code, so `rebuildFromLog` left `handoff` null and every
       * reader fell back. AD-4 makes the log the sole durable truth and the gate reads "fully
       * reconstructable from the event log alone" — a document is not the log, and the commonest hand-off
       * there is was the one that could not be reconstructed.
       *
       * **Before `command.applied`, for the reason every other side effect here is.** `command.applied` is
       * the ledger entry and the effect in one append (story 1-7): it carries `to_state: 'handed_off'`, so
       * the fold does not reach `handed_off` until it lands, and `consumeIntents` retires the file only
       * after this method returns. A crash between the two therefore leaves the intent unretired and the
       * next pass applies it again — appending this line a second time, which both folds absorb because
       * each is a plain assignment of the whole `handoff` record rather than an accumulation. The opposite
       * order is the one that cannot be recovered from: it would retire a run into `handed_off` with the
       * reason lost, which is precisely the defect being fixed. Merged into `command.applied` it would be
       * worse again — two facts in one line means a reader wanting the code has to know which command
       * implies one, and `handoff.recorded` is already the type both folds read (AD-5).
       */
      this.emit(recorder, {
        step: effect === null ? pending.intent.step : effect.step,
        type: ENGINE_EVENT_TYPES.HandoffRecorded,
        payload: { code: corrected.handoff.code, reason: corrected.handoff.reason },
      });
    }

    /**
     * CAP-2 — an amended criterion reaches the log as the amendment, not only as a command.
     *
     * `command.applied` records *that* `edit_criterion` was applied, with its principal and its effect,
     * and deliberately not the argument it carried — so before this the current text of an edited
     * criterion existed nowhere in the durable truth and the spec echo would have gone on rendering the
     * original. The line goes before `command.applied` for the reason every other side effect does: the
     * ledger entry is what retires the intent, so a crash in between redelivers the intent and the edit is
     * recorded again rather than lost.
     */
    if (pending.intent.command === EDIT_CRITERION_COMMAND && pending.intent.argument !== null) {
      this.emit(recorder, {
        step: null,
        type: SPEC_CRITERION_EDITED_EVENT_TYPE,
        payload: criterionEditedPayload(pending.intent.argument),
      });
    }

    // The *corrected* effect, so the payload the fold reads and the document a person reads carry the same
    // sentence about where the work is.
    this.emit(recorder, {
      step: effect === null ? pending.intent.step : effect.step,
      type: COMMAND_EVENT_TYPES.Applied,
      payload: commandAppliedPayload(pending.intent, { effect: corrected, reason }),
    });
  }

  /** Record a refusal and quarantine the file, in that order, so neither is lost to the other. */
  private refuseIntent(paths: RunPaths, feature: string, found: IntentRefusal): IntentRefusal {
    const recorder = this.recorderFor(paths.runId, feature);
    /**
     * Recorded through the recorder directly rather than through `emit`, and that is the point: `emit`
     * throws when the redaction pass drops a line, because an *action* the log cannot record must not
     * happen. A refusal is not an action — nothing changes — so a dropped refusal line must not abort
     * the pass that was refusing. The sidecar written beside the quarantined file is the record that
     * cannot be dropped.
     */
    recorder.recordResult({
      feature,
      run: paths.runId,
      step: null,
      emitter: ENGINE_EMITTER,
      type: COMMAND_EVENT_TYPES.Refused,
      payload: commandRefusedPayload(found.reason, found.detail, {
        intentId: found.intentId,
        command: found.command,
      }),
    });
    this.boundary(`event-appended:${COMMAND_EVENT_TYPES.Refused}`);

    const quarantined = quarantineIntent(paths, found);
    this.boundary(`intent-quarantined:${found.reason}`);
    return quarantined;
  }

  /**
   * Quarantine the intents of a run directory carrying no state at all.
   *
   * No recorder is opened: doing so would create an `events.jsonl` and turn the incomplete directory
   * into a run, which is the repair AD-4 forbids. The refusal sidecar on disk is therefore the only
   * record, and it is enough — without this, an intent addressed to a run with no state would be met,
   * and skipped, by every pass for ever.
   */
  private quarantineOrphanIntents(paths: RunPaths): readonly IntentRefusal[] {
    const read = readIntentFiles(paths, { now: this.now, tornGraceMs: this.tornGraceMs });
    const out: IntentRefusal[] = [];
    for (const found of read.refused) out.push(quarantineIntent(paths, found));
    for (const pending of read.pending) {
      /**
       * A *valid* intent gets the same grace a torn one does, and for the same reason.
       *
       * `acceptFeature` creates the run directory and then appends `run.created`, so there is a window in
       * which a perfectly good intent can be written to a run that carries no state *yet*. Quarantining on
       * sight destroyed exactly that command — a user who pressed a key a millisecond too early lost it,
       * with no log to record the loss in. A directory that will never carry state still has its intents
       * quarantined; it just has to be old enough to prove it, which is the discriminator the torn-file
       * case already uses. An unreadable age counts as old, because waiting on an unreadable age never ends.
       */
      if (pending.ageMs !== null && pending.ageMs >= 0 && pending.ageMs < this.tornGraceMs) continue;
      out.push(
        quarantineIntent(paths, {
          reason: 'unknown-run',
          fileName: pending.fileName,
          intentId: pending.intent.intent_id,
          command: pending.intent.command,
          detail:
            `Run ${paths.runId} has a directory but no state at all — no event log and no checkpoint ` +
            '— so there is no run here to steer. The intent is quarantined rather than met by every ' +
            'later pass.',
          quarantinedTo: null,
        }),
      );
    }
    if (out.length > 0) this.boundary('intent-quarantined:unknown-run');
    return out;
  }

  /** Move a consumed intent aside. Called only once its effect is in the log. */
  private retire(paths: RunPaths, pending: PendingIntent): void {
    retireIntent(paths, pending);
    this.boundary(`intent-retired:${pending.intent.command}`);
  }

  // ---------------------------------------------------------------------------------------------
  // Questions (AD-25)
  // ---------------------------------------------------------------------------------------------

  /**
   * Which question lines the log already carries, so none is appended twice.
   *
   * This *is* the idempotence of a question transition, and it is why the question id has to survive the
   * AD-21 pass: the durable claim precedes every line it causes, so the only way a later pass can tell
   * "already emitted" from "still owed" is to read the ids back out of the payloads. An id the pass
   * replaced with the redaction marker would make every pass emit the same three lines for ever.
   */
  private questionLedger(events: readonly EventEnvelope[]): QuestionLedger {
    return {
      asked: new Set(askedQuestionIds(events)),
      settled: new Set(settledQuestionIds(events)),
      decided: new Set(decidedQuestionIds(events)),
    };
  }

  /**
   * Append whatever lines a question's durable state still owes the log, in order.
   *
   * Every append is guarded by the ledger, so this is safe to call on every pass and after every crash:
   * the outcome file on disk is the decision, and these lines are its report. The order — asked, then the
   * outcome, then the decision — is the order the facts happened in, and a reader folding the log sees a
   * question asked before it sees one resolved even when a crash meant both lines landed in one pass.
   *
   * **Only a resolved question records a decision.** A deflection appends `question.deflected` and stops:
   * nobody was asked, so there is nobody the decision is attributable to (AD-25).
   */
  private recordQuestion(
    paths: RunPaths,
    feature: string,
    settled: SettledQuestion,
    ledger: QuestionLedger,
  ): QuestionPassAction | null {
    const state = settled.state;
    const questionId = state.question.id;
    const recorder = this.recorderFor(paths.runId, feature);
    let kind: QuestionPassOutcomeKind | null = null;

    if (!ledger.asked.has(questionId)) {
      this.emit(recorder, {
        step: state.question.step,
        type: QUESTION_EVENT_TYPES.Asked,
        payload: questionAskedPayload(state, this.redaction),
      });
      ledger.asked.add(questionId);
      kind = 'asked';
    }

    if (settled.outcome !== null && settled.eventType !== null && !ledger.settled.has(questionId)) {
      this.emit(recorder, {
        step: state.question.step,
        type: settled.eventType,
        payload: questionEventPayload(state, this.redaction),
      });
      ledger.settled.add(questionId);
      kind =
        settled.eventType === QUESTION_EVENT_TYPES.Deflected
          ? 'deflected'
          : settled.eventType === QUESTION_EVENT_TYPES.DefaultTaken
            ? 'default-taken'
            : 'resolved';
    }

    const decision = decisionFor(state);
    let decisionRecorded = false;
    if (decision !== null && !ledger.decided.has(questionId)) {
      this.emit(recorder, {
        step: state.question.step,
        type: DECISION_EVENT_TYPE,
        payload: decisionPayload(decision, this.redaction),
      });
      ledger.decided.add(questionId);
      decisionRecorded = true;
      kind ??= state.resolution?.resolver === 'timeout_default' ? 'default-taken' : 'resolved';
    }

    if (kind === null) return null;
    return {
      questionId,
      kind,
      decisionRecorded,
      reason:
        kind === 'asked'
          ? `Question ${questionId} is durable and asked; its default is due after ` +
            `${String(state.question.default_window_ms)}ms (CAP-4).`
          : `Question ${questionId} is ${state.status}` +
            (state.resolution === null ? '' : ` by the ${state.resolution.resolver} resolver`) +
            (decisionRecorded ? ', and the decision is recorded.' : ', and no decision is recorded.'),
    };
  }

  /**
   * CAP-4, AD-25 — take every due default, and finish every transition a crash left half-reported.
   *
   * Called once per run per pass, and it is the reason a window is a window rather than a hope: a default
   * that only fired when something else happened to run would make "what happens if you ignore this" a
   * promise the system keeps by coincidence.
   *
   * Two jobs, and the second is the crash story. A question still `asked` whose window has passed has its
   * default taken *through the same compare-and-set* every other resolver uses, so an answer that landed a
   * millisecond earlier wins and this call writes nothing. A question whose outcome file exists but whose
   * lines are not in the log — a process killed between the claim and the append — has those lines
   * appended now. Both are idempotent, so a pass that repeats does nothing the second time.
   */
  private settleQuestions(loaded: LoadedState): QuestionPassOutcome | null {
    const { paths } = loaded;
    const listing = readQuestionDirectory(paths);
    if (listing.ids.length === 0 && listing.unloggable.length === 0) return null;

    /**
     * The log is re-read rather than taken from the loaded state, and it has to be: consuming an intent
     * earlier in this same pass may have appended a question's lines already, and a ledger built from the
     * state the pass *opened* with would append them a second time. The read costs nothing for a run with
     * no questions, because it is guarded above.
     */
    const events = readEventLog(paths.eventLog);
    const ledger = this.questionLedger(events);
    /**
     * The *feature state* is re-read from those same lines, for exactly the reason the ledger is.
     *
     * `pass` consumes intents before it settles questions, so a `kill` sitting in `commands/` has already
     * been applied by the time this runs — and reading `loaded.state`, which is the state the pass *opened*
     * with, said the run was still live. The consequence was not cosmetic: an overdue question on a run this
     * very pass had killed had its default taken, `question.default_taken` appended and a decision recorded
     * against work that had already stopped, which is the one thing the terminal guard below exists to
     * prevent. AD-4 makes the log the authority, so the state is folded from the lines as they stand now.
     */
    const current = rebuildFromLog(events, {
      run: paths.runId,
      plan: loaded.plan,
      now: this.now,
    });
    const terminal = isTerminalFeatureState(current.state);
    const settledActions: QuestionPassAction[] = [];
    const open: string[] = [];
    const abandoned: string[] = [];
    const refused: QuestionRefusal[] = [];

    /**
     * A directory name this build cannot carry into a payload is refused, not skipped.
     *
     * Skipping it — which is what filtering the listing amounted to — made the question invisible to every
     * pass: no window taken, no line appended, no refusal, and nobody told that a question existed at all.
     * An id from an older build, or one story 3-1's web resolver minted differently, would have vanished
     * without trace, while a torn state file beside it was reported. Same class of fault, same treatment.
     */
    for (const name of listing.unloggable) {
      const unusable = new UnloggableQuestionId(name);
      refused.push({ questionId: name, code: unusable.code, reason: unusable.message });
    }

    for (const questionId of listing.ids) {
      try {
        let settled = settleQuestion(paths, questionId);

        /**
         * A terminal run's window is not taken.
         *
         * AD-8 and the lifecycle agree that nothing walks a finished run backwards, and a default taken
         * against a killed run would record a decision about work that has stopped. The question keeps its
         * `asked` state, which is the honest record: it was asked and never answered.
         */
        if (settled.outcome === null && !terminal && isQuestionDefaultDue(settled.state, this.now())) {
          const claim = takeQuestionDefault(paths, questionId, settled.state.question, this.now());
          this.boundary(`question-claimed:${claim.created ? 'timeout_default' : 'lost'}`);
          settled = settleQuestion(paths, questionId);
        }

        const acted = this.recordQuestion(paths, current.feature, settled, ledger);
        if (acted !== null) settledActions.push(acted);
        // Still `asked`, and told apart by whether anything can still resolve it: a live run's question is
        // waiting for a person, a terminal run's is one the run ended without.
        if (settled.outcome === null) (terminal ? abandoned : open).push(questionId);
      } catch (thrown: unknown) {
        /**
         * One unreadable question does not stop the others, for the same reason one unreadable run does not
         * stop the pass: the refusal is per artifact. A torn state file is refused and *no* transition is
         * attempted against it — never a partial read, and never a default taken against a question the
         * loop cannot see the whole of.
         */
        const code = (thrown as { code?: unknown } | null)?.code;
        refused.push({
          questionId,
          code: typeof code === 'string' ? code : 'internal.invariant_violated',
          reason: renderCause(thrown) ?? 'the question could not be read, and said nothing about why',
        });
      }
    }

    return { run: paths.runId, settled: settledActions, open, abandoned, refused };
  }

  /**
   * AD-25 — resolve the run's active question from one steering intent.
   *
   * The compare-and-set decides, and this only reports. Three outcomes, and the middle one is the case the
   * Design Notes single out:
   *
   * - the intent won, so the transition's lines are appended and the caller is told;
   * - the intent lost — the window took the default while the person was typing, or the other renderer got
   *   there first — and it is refused carrying the sentence that says so plainly, because a user who
   *   believes their answer landed and a system that took the default have diverged about a decision AD-25
   *   has already made durable;
   * - there is no question to answer at all, which is refused by name rather than treated as a lost race.
   */
  private resolveQuestionFromIntent(
    paths: RunPaths,
    state: RunState,
    pending: PendingIntent,
    steering: QuestionSteering,
  ): { readonly reason: string; readonly refusal: IntentRefusal | null } {
    const intent = pending.intent;
    const refusal = (reason: IntentRefusalReason, detail: string): IntentRefusal => ({
      reason,
      fileName: pending.fileName,
      intentId: intent.intent_id,
      command: intent.command,
      detail,
      quarantinedTo: null,
    });

    const target = activeQuestion(paths) ?? lastSettledQuestion(paths);
    if (target === null) {
      /**
       * No question exists, so the refusal has to say what *is* true rather than describe a question the
       * person never saw.
       *
       * `reject` is the case that forced this sentence to be written carefully. Its own note cites CAP-18 —
       * rejection at an approval gate — and that is exactly the case it cannot serve: `approve` is an
       * `effect` command that acts on a `blocked` run, while `reject` is a `question` command, so a person
       * looking at a gate who presses reject reaches this branch. Telling them their rejection "has nothing
       * to resolve" under `questions/` describes machinery they were never shown. So a blocked run is named
       * as a blocked run, and the refusal states plainly that this build's rejection answers a question
       * rather than a gate. Giving `reject` a non-question path means declaring a lifecycle transition for a
       * rejected gate, which nothing in the spine or the lifecycle declares — so it is a spec decision, not
       * a patch, and is reported rather than guessed at.
       */
      const atAGate = state.state === 'blocked';
      return {
        reason: '',
        refusal: refusal(
          'no-open-question',
          atAGate
            ? `Run ${paths.runId} is blocked at a gate, and "${intent.command}" is a question command in ` +
              'this build: it resolves an open question through the AD-25 compare-and-set, and this run ' +
              'has none. So nothing was recorded, and the gate still stands exactly as it did — it was ' +
              'not rejected, and nothing about the run changed. Approving the gate is "approve"; what a ' +
              'rejection at a gate should do to the run is not a transition this build declares (CAP-18).'
            : `Run ${paths.runId} has no question under questions/, so "${intent.command}" has nothing ` +
              'to resolve. The answer is quarantined rather than met by every later pass, and nothing ' +
              'was recorded: an answer to no question is not a decision.',
        ),
      };
    }

    const question = target.settled.state.question;
    const resolution = questionResolution({
      resolver: steering.resolver,
      principal: intent.principal,
      answer: steering.answer,
      optionId: parseOptionSelection(question, steering.answer),
      resolvedAt: this.now(),
    });
    const claim = attemptQuestionResolution(paths, target.questionId, resolution, {
      intentId: intent.intent_id,
    });
    this.boundary(`question-claimed:${claim.created ? steering.resolver : 'lost'}`);

    if (!claim.accepted) {
      return {
        reason: '',
        refusal: refusal(
          'wrong-target-state',
          describeDefaultTaken(claim.state) +
            ` (${claim.refusal ?? 'the first transition stands'})`,
        ),
      };
    }

    const acted = this.recordQuestion(
      paths,
      state.feature,
      settleQuestion(paths, target.questionId),
      this.questionLedger(readEventLog(paths.eventLog)),
    );
    return {
      reason:
        `"${intent.command}" won the compare-and-set on question ${target.questionId} as the ` +
        `${steering.resolver} resolver` +
        (acted?.decisionRecorded === true ? ', and the decision is recorded (AD-25).' : '.'),
      refusal: null,
    };
  }

  /** CAP-23 — the document, written before the line that records the hand-off. */
  private writeHandoff(
    paths: RunPaths,
    plan: FeaturePlan,
    state: RunState,
    options: {
      readonly code: string;
      readonly reason: string;
      readonly escape: EscapeHatchOutcome | null;
    },
  ): string {
    const document = writeHandoffDocument(
      paths,
      {
        run: state.run,
        feature: state.feature,
        // The state the run is *entering*: the document is only ever written on the way to handing off,
        // and telling a person the run is still `running` would be the one thing it must not do.
        state: 'handed_off',
        request: plan.request,
        acceptanceCriteria: plan.acceptance_criteria,
        code: options.code,
        reason: options.reason,
        steps: state.steps,
        worktree: plan.worktree,
        runDirectory: paths.runDir,
        checkpoint: checkpointPath(paths),
        escape: options.escape,
        writtenAt: handoffTimestamp(this.now()),
      },
      this.redaction,
    );
    this.boundary('handoff-document-written');
    return document;
  }

  // ---------------------------------------------------------------------------------------------
  // Reading state
  // ---------------------------------------------------------------------------------------------

  /**
   * Read a run's state: fold the log, compare the checkpoint against it, and let the log win.
   *
   * The comparison's *result* never decides anything — the folded state is returned either way. It is
   * reported so a disagreement is visible, not so a caller can choose.
   */
  load(run: string): LoadedState {
    const paths = runPaths(run, this.orchHome);
    sweepCheckpointTemporaries(paths);
    /**
     * The same sweep for `commands/`, which had none.
     *
     * A writer killed between its `write` and its `rename` leaves a `.tmp` the reader already skips — so it
     * is not a poison file, it is an unbounded leak in the one directory a renderer writes to on every
     * keystroke. The two quarantine directories are the same shape of leak with the opposite cause: one
     * file per command, kept for evidence, for the life of a run. Both are bounded here, beside the
     * checkpoint's sweep, because `load` is the one place every path through the loop passes through.
     */
    sweepCommandTemporaries(paths, { now: this.now });
    /**
     * And the same sweep for `questions/`, which had none either.
     *
     * A resolver killed between its `write` and its `link` or `rename` leaves a `.tmp` beside the outcome —
     * debris, never a decision, because nothing reads a name that was never published. Bounded here beside
     * the other two for the same reason: `load` is the one place every path through the loop passes
     * through, and a directory that only ever grows is a slower version of the same fault. It also keeps
     * the AD-25 directory listing to the two files ADR-002 says it holds, which the race suite asserts.
     */
    sweepQuestionTemporaries(paths, { now: this.now });
    pruneRetiredIntents(paths);
    const events = readEventLog(paths.eventLog);
    // An unrecognised `schema_version` throws out of here, per AD-28: this build does not operate on a
    // state file it cannot read, and rebuilding over it would destroy the evidence of who wrote it.
    // Read once and passed on, because a fold is already the expensive part of a pass.
    const onDisk = readCheckpoint(paths);
    const plan = this.planFor(paths, events, onDisk.state);
    const rebuilt = rebuildFromLog(events, { run, plan, now: this.now });
    const reconciled = reconcileCheckpointAgainstLog(onDisk.state, rebuilt);
    return {
      paths,
      plan,
      events,
      state: reconciled.state,
      disagreements: reconciled.disagreements,
      checkpointRebuilt: onDisk.state === null || reconciled.checkpointDiscarded,
    };
  }

  /** The lifecycle-significant identity of a run, which is what AD-7's claim is about. */
  fingerprint(run: string): string {
    return featureStateFingerprint(this.load(run).state);
  }

  /** Every run id under `ORCH_HOME/runs/`, in ULID order. */
  runIds(): readonly string[] {
    return listRunIds(runsDir(this.orchHome));
  }

  // ---------------------------------------------------------------------------------------------
  // The loop
  // ---------------------------------------------------------------------------------------------

  /**
   * One pass over every run.
   *
   * Concurrent across features, serialised across any two whose declared territories overlap. Each
   * admitted feature takes at most one action, and its checkpoint is written before the pass returns.
   *
   * A pass also leaves *no* run's checkpoint disagreeing with its log, including the runs it does not
   * act on. That second job is not tidiness. A terminal run is never advanced again, so if a crash left
   * its checkpoint naming a state the log has since left behind — killed between the final
   * `feature.state_changed` and the checkpoint write — nothing else would ever reconcile it, and
   * `state.json` would answer `verifying` for a committed run for good. AD-4 lets the log win, but a
   * derived file that stays wrong forever is the two-authorities divergence AD-4 exists to prevent,
   * surviving precisely because the run was finished.
   */
  async pass(): Promise<PassResult> {
    this.assertOpen();

    const entries: LoadedRun[] = [];
    const refusals: RunRefusal[] = [];
    const steering: IntentPassOutcome[] = [];
    const questions: QuestionPassOutcome[] = [];

    // AD-32, first thing in the pass and on every pass: a comparison of what is held against what the
    // runs say, taken before any run advances so it reads one consistent picture of on-disk state. A run
    // that becomes terminal later in this pass is reclaimed by the next one, which is the language AD-32
    // itself uses. Nothing below depends on it having happened.
    const reclaimed = this.reclaim(refusals);

    for (const run of this.runIds()) {
      try {
        const loaded = this.load(run);
        // Re-read when a declaration was appended: the entry below is decided from this snapshot, and a
        // snapshot whose `last_event_seq` predates the lines just written would be checkpointed as a
        // disagreement with the log on the very next pass.
        entries.push({
          run,
          loaded: this.recordDeclarations(loaded, refusals) ? this.load(run) : loaded,
        });
      } catch (thrown: unknown) {
        // A directory with neither log nor checkpoint carries no state to reconcile and no feature to
        // name, so it is stepped over silently rather than reported as a fault every pass forever. Its
        // intents are not: an intent nothing ever consumes is exactly the poison file AD-19 must not
        // leave behind, so it is quarantined here and met by no later pass.
        if (thrown instanceof IncompleteRunDirectory) {
          const orphaned = this.quarantineOrphanIntents(runPaths(run, this.orchHome));
          if (orphaned.length > 0) {
            steering.push({
              run,
              applied: [],
              recognised: [],
              awaiting: [],
              refused: orphaned,
              incomplete: [],
              state: null,
            });
          }
          continue;
        }
        refusals.push(refusalFor(run, thrown));
      }
    }

    /**
     * AD-19 — the durable intents, consumed before anything else is decided.
     *
     * Before, because a steering command is the user's word about work that has not happened yet: a pass
     * that started a step and *then* read the kill sitting in `commands/` would have done the thing it
     * was told not to. Every loaded run is offered, including terminal ones, because an intent for a
     * finished run has to be refused rather than left on disk for ever.
     *
     * A run whose intents changed something takes no *other* action this pass — that is what keeps
     * "at most one action per pass" true — and it does not contend for a territory, because deferring a
     * disengage behind an unrelated feature's worktree would make "always available" conditional.
     */
    const steered: { readonly entry: LoadedRun; readonly outcome: IntentPassOutcome }[] = [];
    const untouched: LoadedRun[] = [];
    for (const entry of entries) {
      let outcome: IntentPassOutcome | null = null;
      try {
        outcome = this.consumeIntents(entry.loaded);
      } catch (thrown: unknown) {
        refusals.push(refusalFor(entry.run, thrown));
      }
      if (outcome === null) continue;
      if (outcome.applied.length > 0 || outcome.refused.length > 0) {
        steering.push(outcome);
        steered.push({ entry, outcome });
        continue;
      }
      if (outcome.recognised.length > 0 || outcome.awaiting.length > 0 || outcome.incomplete.length > 0) {
        steering.push(outcome);
      }
      // Nothing changed, so the run is decided from the state the pass already loaded.
      untouched.push(entry);
    }

    /**
     * CAP-4, AD-25 — the question windows, taken after the intents and before anything is decided.
     *
     * *After* the intents because an answer already on disk is the user's word and must beat a window that
     * expired while it sat there: the pass that consumes the answer is the pass that would otherwise take
     * the default, and consuming first is what makes "an answer arriving before expiry wins" true rather
     * than a race against the loop's own scheduling.
     *
     * Settling a question changes no lifecycle state, so it is not one of the pass's at-most-one actions and
     * a run does not forfeit its step to it. It appends lines and reports them — which is the whole of
     * AD-25's record — and every append is guarded by the log, so a pass that repeats appends nothing.
     */
    for (const entry of entries) {
      try {
        const outcome = this.settleQuestions(entry.loaded);
        if (outcome !== null) questions.push(outcome);
      } catch (thrown: unknown) {
        refusals.push(refusalFor(entry.run, thrown));
      }
    }

    /**
     * Only a feature with real work to do contends for a territory.
     *
     * An inert action — awaiting confirmation, awaiting a person, or a terminal run — performs no worktree
     * I/O, so it cannot conflict with anything. Letting it contend would mean a feature parked in
     * `drafting` held its whole territory for as long as the user took to confirm, and every overlapping
     * feature was deferred behind it indefinitely. Inert runs are still *reported*, so a reader can see
     * what each is waiting for; they simply hold nothing while they wait.
     */
    const decided = untouched
      .filter((entry) => !isTerminalFeatureState(entry.loaded.state.state))
      .map((entry) => ({ ...entry, action: decideAction(entry.loaded.state, entry.loaded.plan) }));
    const inert = decided.filter((entry) => isInertAction(entry.action.kind));
    const contending = decided.filter((entry) => !isInertAction(entry.action.kind));

    const { admitted, deferred } = admitByTerritory(
      contending.map(
        (entry): TerritoryCandidate => ({
          run: entry.run,
          feature: entry.loaded.state.feature,
          territory: entry.loaded.state.territory,
          worktree: entry.loaded.plan.worktree,
        }),
      ),
    );
    const admittedRuns = new Set(admitted.map((candidate) => candidate.run));

    const acting = [...inert, ...contending.filter((entry) => admittedRuns.has(entry.run))];
    // A steered run's checkpoint was written by `consumeIntents`, so it is settled for this pass too.
    const actingRuns = new Set([
      ...acting.map((entry) => entry.run),
      ...steered.map((entry) => entry.entry.run),
    ]);

    // The runs this pass will not act on: terminal ones, and ones serialised behind an overlapping
    // territory. An acting run's checkpoint is written by `advance`, so writing it here too would double
    // the work and hide the rebuild from the action it is reported on.
    for (const entry of entries) {
      if (!actingRuns.has(entry.run) && entry.loaded.checkpointRebuilt) {
        this.writeCheckpoint(entry.loaded.paths, entry.loaded.state);
      }
    }

    /**
     * `allSettled`, for the same reason the load loop catches per run: one feature whose action fails must
     * not discard the actions of every feature that succeeded in the same pass. A rejection is reported
     * against its own run and the rest of the pass stands.
     */
    const settled = await Promise.allSettled(
      // The entry is threaded through rather than re-loaded: `advance` would otherwise fold the log a
      // second time, and a fold is the expensive part of a pass.
      acting.map((entry) => this.advance(entry.run, entry.loaded)),
    );

    const actions: PassAction[] = [];
    for (const { entry, outcome } of steered) {
      const settledState = outcome.state ?? entry.loaded.state;
      actions.push({
        run: entry.run,
        feature: settledState.feature,
        kind: 'apply-intents',
        step: null,
        from: entry.loaded.state.state,
        to: settledState.state,
        reason: describeSteering(outcome),
        checkpointRebuilt: entry.loaded.checkpointRebuilt,
        disagreements: entry.loaded.disagreements,
      });
    }
    for (const [index, outcome] of settled.entries()) {
      const run = acting[index]?.run ?? '(unknown)';
      if (outcome.status === 'fulfilled') actions.push(outcome.value);
      else refusals.push(refusalFor(run, outcome.reason));
    }

    /**
     * The intents a step's own action consumed, reported with the pass that ran it.
     *
     * Drained rather than read, so nothing accumulates. They are appended *after* the pass's own
     * consumption because that is the order they happened in: the pass read `commands/` before deciding,
     * the watcher read it again while the step was in flight, and a reader following `steering` down the
     * array is following the run's timeline.
     */
    steering.push(...this.midStepSteering.splice(0));

    return { actions, deferred, refusals, reclaimed, steering, questions };
  }

  /**
   * Invoke the reclamation pass, reporting a rejection rather than losing the whole pass to it.
   *
   * A sweep that throws is one resource's problem at worst, and every feature in this pass still has to
   * advance — the same per-artifact rule that keeps one unreadable run from wedging the loop. The
   * `try`/`catch` here is error reporting and not a cleanup path: there is no `finally`, and nothing is
   * reclaimed by this process ending.
   */
  private reclaim(refusals: RunRefusal[]): ReclamationSummary | null {
    if (this.reclamation === null) return null;
    try {
      const summary = this.reclamation();
      for (const resource of summary.reclaimed) {
        this.boundary(`resource-reclaimed:${resource.kind}`);
      }
      // A resource the sweep could not release is surfaced here or nowhere. `summary.failed` was reported
      // into `PassResult` and read by nothing, so a resource failing reclamation on every pass leaked with
      // no signal at all — the invisible state AD-32 exists to prevent, arrived at through the pass that was
      // supposed to prevent it. The refusal channel is where this loop already says "something did not
      // happen", so that is where a failed reclamation says it too.
      for (const resource of summary.failed) {
        refusals.push(
          passRefusal(
            resource.code ?? 'internal.invariant_violated',
            `the reclamation pass could not release the ${resource.kind} ${resource.id}: ${resource.reason}`,
          ),
        );
      }
      return summary;
    } catch (thrown: unknown) {
      // `run: ''` rather than a `(reclamation)` placeholder: the field holds run ids, and a literal that
      // reads like one is a literal a consumer will try to build a path from.
      const code = (thrown as { code?: unknown } | null)?.code;
      refusals.push(
        passRefusal(
          typeof code === 'string' ? code : 'internal.invariant_violated',
          renderCause(thrown) ?? 'the reclamation pass threw and said nothing about why',
        ),
      );
      return null;
    }
  }

  /**
   * Advance one feature by at most one action.
   *
   * The whole of the action is durable before this returns: the events it appended are in the log, and
   * the checkpoint has been rebuilt from that log. A crash at any point inside leaves a state the next
   * call converges from.
   *
   * **Called without a preloaded snapshot, it consumes that run's durable intents first.** This is a
   * deliberate decision rather than an omission, and it was an omission: only `pass` and `steer`
   * consumed intents, so a caller driving `advance` per run honoured a disengage only if the mid-step
   * watcher happened to catch it, and an intent written *between* `advance` calls was never applied at
   * all. AD-19 makes the intent file the only path a command reaches the loop by, so a public entry point
   * that starts a step without reading it is an entry point that can do the thing it was told not to.
   *
   * With a preloaded snapshot it consumes nothing, because the only caller that passes one is `pass`,
   * which has already consumed them for every run and decided this action from the result. Reading them
   * again here would fold the log a second time to find nothing.
   */
  async advance(run: string, preloaded?: LoadedState): Promise<PassAction> {
    this.assertOpen();
    if (preloaded === undefined) {
      const steered = this.consumeIntents(this.load(run));
      // Parked for the next `pass` to report, the same way a mid-step consumption is: `PassAction` has no
      // field for an intent outcome, and dropping it is how a refusal becomes invisible.
      this.midStepSteering.push(steered);
    }
    const loaded = preloaded ?? this.load(run);
    const { paths, plan } = loaded;
    let state = loaded.state;

    // A checkpoint that disagreed with the log is discarded and rebuilt *before* anything is decided,
    // so no action is ever chosen from a state the durable truth does not support.
    if (loaded.checkpointRebuilt) state = this.writeCheckpoint(paths, state);

    const action = decideAction(state, plan);
    const from = state.state;

    if (isInertAction(action.kind)) {
      // Nothing is appended, so nothing is rebuilt. The checkpoint is still written, so a reader always
      // finds one after a pass even for a run that had no work.
      const settled = this.writeCheckpoint(paths, state);
      return this.report(run, settled, action, from, null, loaded);
    }

    const step = await this.perform(paths, plan, state, action);
    const settled = this.checkpointFromLog(paths, plan);
    return this.report(run, settled, action, from, step, loaded);
  }

  /**
   * Drive the loop until nothing is left to do.
   *
   * This is what an uninterrupted run is, and the crash-injection suite needs one to compare against:
   * "converges on the same state as an uninterrupted run" is not assertable without knowing what that
   * run produces. `maxPasses` is a test-harness bound, not an AD-24 ceiling — it exists so a bug that
   * makes the loop fail to converge shows up as a bounded failure rather than as a hang.
   */
  async runUntilSettled(maxPasses = 200): Promise<readonly PassAction[]> {
    const taken: PassAction[] = [];
    for (let index = 0; index < maxPasses; index += 1) {
      const result = await this.pass();
      const effective = result.actions.filter((action) => !isInertAction(action.kind));
      taken.push(...result.actions);
      if (effective.length === 0) return taken;
    }
    throw new Error(
      `The loop took ${String(maxPasses)} passes without settling, which means an action is not ` +
        'advancing the state it claims to advance.',
    );
  }

  // ---------------------------------------------------------------------------------------------
  // Performing one action
  // ---------------------------------------------------------------------------------------------

  private async perform(
    paths: RunPaths,
    plan: FeaturePlan,
    state: RunState,
    action: ReconcileAction,
  ): Promise<string | null> {
    const recorder = this.recorderFor(state.run, state.feature);

    switch (action.kind) {
      case 'adopt-orphan': {
        const record = findStepRecord(state, action.step);
        // The engine was killed inside this step, so the subprocess is gone with it. Recording the
        // interruption it actually suffered is what lets the next pass reach AD-8's resume rule.
        this.emit(recorder, {
          step: action.step,
          type: ENGINE_EVENT_TYPES.StepTerminated,
          payload: { disposition: 'interrupted', reason: action.reason },
          sessionId: record?.session_id ?? null,
          baselineRef: record?.baseline_ref ?? null,
        });
        this.emit(recorder, {
          step: action.step,
          type: ENGINE_EVENT_TYPES.FeatureStateChanged,
          payload: { from: state.state, to: 'interrupted', reason: 'the engine was killed mid-step' },
        });
        return action.step;
      }

      case 'run-step': {
        await this.driveStep(paths, plan, state, {
          step: action.step,
          transitionTo: action.transitionTo,
          promoteTo: null,
          reset: false,
        });
        return action.step.step;
      }

      case 'reset-and-rerun': {
        const planStep = this.planStepFor(plan, action.step);
        await this.driveStep(paths, plan, state, {
          step: planStep,
          transitionTo: action.transitionTo,
          promoteTo: action.promoteTo,
          reset: true,
        });
        return action.step;
      }

      case 'resume-step': {
        const record = this.requireStepRecord(state, action.step);
        const planStep = this.planStepFor(plan, action.step);
        /**
         * **A resume does not re-run the gates, and that is a decision rather than an omission
         * (matrix 32).**
         *
         * CAP-13's economics are about what a run *spends*: "no review spend occurs on a run that
         * fails them". A resume continues an attempt whose gates already passed — the review was
         * spawned, the session id exists, and the turns are already gone — so running the gates
         * again could not un-spend anything. What it would cost is a second container per gate on
         * the one path a long-running step reaches most often, which is the cost the ordering
         * exists to avoid.
         *
         * The gates are not skipped, either: their outcomes are on the step input this resume
         * hands back to the same session, written when the attempt started, so the step still
         * judges against what the engine observed. A gate that would fail *now* — because the
         * worktree moved under a crash — is caught where AD-26 catches everything else of that
         * kind: the next `reset-and-rerun`, which goes through `driveStep` and gates in full.
         */
        const request = this.startRequest(paths, plan, state, planStep, record, record.model_tier);

        this.emit(recorder, {
          step: action.step,
          type: ENGINE_EVENT_TYPES.StepResumeAttempted,
          payload: {
            /**
             * Post-increment, like `step.started`'s.
             *
             * The fold derives this resume's attempt number as `attempts + 1`, and `step.started` writes
             * the number of the attempt it is starting — so writing `record.attempts` here numbered the
             * resume as the attempt before it, and starts and resumes numbered themselves on two
             * conventions in one log. `StepStartRequest.attempt` on the resume path is still the
             * pre-resume count; that is this story's own recorded deferral, because it reaches container
             * naming and story 1-4's fixtures.
             */
            attempt: record.attempts + 1,
            // The build boundary: only a line this build wrote counts against the bound (see the fold).
            [RESUME_COUNTS_TOWARD_BOUND_KEY]: true,
          },
          sessionId: action.sessionId,
          baselineRef: record.baseline_ref,
        });

        /**
         * CAP-5 — the same watcher a fresh step gets, for the same reason and for the same window.
         *
         * A resumed step is a step in flight. It was started before this process existed, it is the case
         * a long-running step reaches most often — a crash, a restart, a resume by recorded session id —
         * and it was the one path with no watcher at all: a disengage written during a resume was not
         * observed, the child stayed live past the declared bound, the step finished on its own recording
         * `completed`, and the run was left `interrupted`. CAP-5 failed for exactly the long-running case
         * it exists for, and no deferral recorded it. The watcher and the post-termination consumption
         * below are the same two calls `driveStep` makes, deliberately identical: a second, subtly
         * different mid-step stop path is how one of them drifts.
         */
        const watch = this.watchForStopIntents(paths, state, action.step);

        let termination: StepTermination;
        try {
          termination = await this.executor.resume({ ...request, sessionId: action.sessionId });
          watch.stop();
        } catch (thrown: unknown) {
          // Stopped on both paths rather than in a `finally`, exactly as `driveStep` does: AD-32's rule is
          // about behaviour on an exit path, and two visible calls read as two calls.
          watch.stop();
          if (!(thrown instanceof ResumeRefused)) throw thrown;
          // AD-8 — the recorded id is spent. Recording that fact is the whole action: the next pass
          // sees an `interrupted` step with no session id and reaches the reset-and-re-run on its own,
          // so the fallback lives in one place rather than being duplicated here.
          this.emit(recorder, {
            step: action.step,
            type: ENGINE_EVENT_TYPES.StepResumeRefused,
            payload: {
              code: thrown.code,
              reason: routeRefusedResume(action.step).reason,
            },
            baselineRef: record.baseline_ref,
          });
          // A stop that arrived during a refused resume still stopped nothing and still has to be applied:
          // the gesture is the user's word, and a refused resume is not a reason to lose it.
          this.applyStopObservation(state, action.step, watch.observed());
          return action.step;
        }

        this.recordTermination(state, planStep, record.baseline_ref, termination, {
          transitionTo: action.transitionTo,
        });
        this.applyStopObservation(state, action.step, watch.observed());
        return action.step;
      }

      case 'advance-state': {
        this.emit(recorder, {
          step: null,
          type: ENGINE_EVENT_TYPES.FeatureStateChanged,
          payload: { from: state.state, to: action.to, reason: action.reason },
        });
        return null;
      }

      case 'escalate-to-human': {
        this.emit(recorder, {
          step: action.step,
          type: ENGINE_EVENT_TYPES.FeatureStateChanged,
          payload: { from: state.state, to: 'blocked', reason: action.reason },
        });
        return action.step;
      }

      case 'hand-off': {
        this.handOff(paths, plan, state, action.step, action.code, action.reason);
        return action.step;
      }

      case 'idle':
      case 'await-confirmation':
      case 'await-approval':
        return null;

      case 'apply-intents':
        /**
         * Never reached: intents are consumed by `pass` *before* any action is decided, and a run whose
         * intents changed something takes no other action in that pass. The case is enumerated rather
         * than defaulted so the compiler keeps this true if a later story routes intents differently.
         */
        return null;
    }
  }

  /**
   * Start or re-run a step and record how it terminated.
   *
   * The order is fixed and every part of it matters:
   *
   * 1. the lifecycle transition, if the feature is entering a new state;
   * 2. the promotion, if one is being spent, so the rung the attempt ran on is in the log *before* the
   *    attempt;
   * 3. the baseline reset, for a re-run, because a re-run that ran first and reset after would have
   *    doubled the previous attempt's effects — which is the whole thing AD-26 prevents;
   * 4. `step.started`, carrying the baseline ref on the envelope;
   * 5. the port call, with the session id recorded the moment it is reported;
   * 6. `step.terminated`, carrying the disposition.
   */
  private async driveStep(
    paths: RunPaths,
    plan: FeaturePlan,
    state: RunState,
    options: {
      readonly step: PlanStep;
      readonly transitionTo: FeatureState;
      readonly promoteTo: ModelRung | null;
      readonly reset: boolean;
    },
  ): Promise<void> {
    const recorder = this.recorderFor(state.run, state.feature);
    const existing = findStepRecord(state, options.step.step);

    if (state.state !== options.transitionTo) {
      this.emit(recorder, {
        step: options.step.step,
        type: ENGINE_EVENT_TYPES.FeatureStateChanged,
        payload: {
          from: state.state,
          to: options.transitionTo,
          reason: `step "${options.step.step}" is the ${options.step.phase} step to run next`,
        },
      });
    }

    /**
     * The ladder owns the precedence — a promotion, then the rung the step already reached, then what
     * was declared for it — so a re-run never drops below a rung it climbed to.
     *
     * The declared rung is the *agent's*, from its AD-17 roster entry, with the feature plan's
     * `starting_model_tier` standing behind it. An unplaceable rung is refused rather than clamped, and
     * `config.invalid` is `escalate-to-human`, so the refusal blocks the feature for a person instead of
     * escaping the pass as an uncaught throw and taking every other feature's pass with it — the same
     * treatment the baseline reset below already gets.
     */
    let tier: ModelRung;
    try {
      tier = rungForAttempt({
        promoteTo: options.promoteTo,
        recorded: existing?.model_tier ?? null,
        declared: this.declaredStartingRung(state.run, options.step.phase) ?? plan.starting_model_tier,
      });
    } catch (thrown: unknown) {
      if (!(thrown instanceof ModelRungUnrecognised)) throw thrown;
      this.emit(recorder, {
        step: options.step.step,
        type: ENGINE_EVENT_TYPES.FeatureStateChanged,
        payload: { from: state.state, to: 'blocked', reason: thrown.message },
      });
      return;
    }
    if (options.promoteTo !== null) {
      this.emit(recorder, {
        step: options.step.step,
        type: ENGINE_EVENT_TYPES.StepTierPromoted,
        payload: {
          from: existing?.model_tier ?? plan.starting_model_tier,
          to: options.promoteTo,
          ladder: MODEL_RUNGS.join('>'),
        },
      });
    }

    /**
     * AD-26 — the ref a re-run resets to is the one the *first* attempt recorded, so it is read from
     * the existing record and never re-read from the worktree. Re-reading it would make each re-run
     * record whatever the previous attempt left behind, and the identical-effect guarantee would decay
     * one attempt at a time.
     */
    const baselineRef =
      existing !== null && existing.baseline_ref !== ''
        ? existing.baseline_ref
        : this.baseline.currentRef(plan.worktree);

    if (options.reset) {
      try {
        resetToBaseline(plan.worktree, baselineRef, this.baseline);
      } catch (thrown: unknown) {
        if (!(thrown instanceof BaselineResetError)) throw thrown;
        /**
         * AD-26 makes the reset the *precondition* of a re-run, and `git.baseline_reset_failed` is
         * declared `abandon-and-hand-off` for exactly this reason: a worktree that cannot be returned to
         * a known commit is the half-mutated state a re-run must never start from. So the failure routes
         * through the table like any other rather than escaping the pass — which would abandon the run
         * with no recorded reason and take every other feature's pass down with it.
         */
        this.handOff(paths, plan, state, options.step.step, thrown.orchError.code, thrown.orchError.message);
        return;
      }
      this.emit(recorder, {
        step: options.step.step,
        type: ENGINE_EVENT_TYPES.StepBaselineReset,
        payload: { reason: 'a re-run resets the worktree to the step baseline first (AD-26)' },
        baselineRef,
      });
    }

    const attempt = (existing?.attempts ?? 0) + 1;

    this.emit(recorder, {
      step: options.step.step,
      type: ENGINE_EVENT_TYPES.StepStarted,
      payload: {
        attempt,
        phase: options.step.phase,
        contract_id: options.step.contract_id,
        model_tier: tier,
        mode: plan.mode,
        input: stepInputRelativePath(options.step.step),
      },
      baselineRef,
    });

    /**
     * CAP-13's first tier, before anything is spawned.
     *
     * The order is the whole claim: "deterministic gates (typecheck, lint, tests) run before any
     * model-based review, and no review spend occurs on a run that fails them". `agent.spawned` is
     * emitted by the spawner, so a failing gate returning here means that event never exists — which
     * is how the economics are asserted in `tests/engine.gate-economics.test.ts`, by absence rather
     * than by a counter that could read zero because nothing incremented it.
     */
    const gates = this.runGatesBeforeReview(
      plan,
      state,
      options.step,
      baselineRef,
      options.transitionTo,
      attempt,
    );
    if (gates === null) return;

    /**
     * The input is written **after** the gates ran, because it carries what they returned.
     *
     * The order is the whole of matrix row 28: the engine has the declared line, the exit status and
     * the evidence pointer of every gate by this point, and `step.verification` requires the model to
     * report exactly those. Writing the input first and handing over `evidence: []` left the step two
     * ways to satisfy its contract — re-run every gate through the command runner, doubling the
     * container time CAP-13's ordering exists to save, or invent them.
     */
    const input = this.stepInput(paths, plan, state, options.step, baselineRef, gates);

    const request = this.startRequest(
      paths,
      plan,
      state,
      options.step,
      { baseline_ref: baselineRef, attempts: attempt },
      tier,
      input.value,
    );

    /**
     * A rejection from the port is a termination, not an escape.
     *
     * `step.started` is already in the log at this point. If the rejection propagated, the pass would die
     * with the step recorded as in flight, and the next pass would adopt it as `interrupted`, re-run it
     * and fail identically — a non-terminating loop built out of a code the AD-35 table has a perfectly
     * good answer for. Recording the termination lets the table answer it: `step.spawn_failed` retries,
     * an undeclared code hands off.
     */
    /**
     * CAP-5 — the disengage watcher, for the whole time the step is in flight.
     *
     * Started after `step.started` is in the log and before the port is called, so the window it covers
     * is exactly the window a step occupies. It is the answer to story 1-3's own deferral: an action
     * drives a step synchronously to termination, so without this a kill could only ever land between
     * passes.
     */
    const watch = this.watchForStopIntents(paths, state, options.step.step);

    let termination: StepTermination;
    try {
      termination = await this.executor.start(request);
      watch.stop();
    } catch (thrown: unknown) {
      // Stopped explicitly on both paths rather than in a `finally`. AD-32's rule is about behaviour on
      // an exit path, and two visible calls cost less than a reader having to decide whether a `finally`
      // here is a cleanup handler.
      watch.stop();
      termination = terminationFromThrown(options.step.step, thrown);
    }

    this.recordTermination(state, options.step, baselineRef, termination, {
      transitionTo: options.transitionTo,
    });

    this.applyStopObservation(state, options.step.step, watch.observed());
  }

  /**
   * Record and apply what the mid-step watcher saw, once the step's termination is durable.
   *
   * Three things happen here and each closes a gap the watcher left:
   *
   * 1. **The stop is recorded.** `StopObservation` carried four facts — which intent, which command,
   *    whether there was a live child to signal, and when — and every one of them was computed and then
   *    only null-checked. So nothing anywhere said a stop signal had been *delivered*, which is the one
   *    fact a person asking "did my disengage reach it?" wants. The line is not folded (AD-5), because it
   *    changes no state: the `command.applied` the intent produces is the state change.
   * 2. **The intent is applied inside this action.** The watcher writes nothing — it runs inside somebody
   *    else's action, and a second writer inside one action is how two lines interleave — so the gesture
   *    is still pending here. Applying it now is what makes {@link DECLARED_DISENGAGE_BOUND_MS} a claim
   *    about the run rather than only about the child.
   * 3. **The outcome is kept rather than discarded.** The `IntentPassOutcome` used to be thrown away, so
   *    an intent applied mid-step never reached `PassResult.steering` and a refusal raised there was
   *    invisible — which contradicts `steering` being how a refusal becomes visible rather than silent.
   *    It is parked for `pass` to report.
   */
  private applyStopObservation(
    state: RunState,
    step: string,
    observed: StopObservation | null,
  ): void {
    if (observed === null) return;

    this.recorderFor(state.run, state.feature).recordResult({
      feature: state.feature,
      run: state.run,
      step,
      emitter: ENGINE_EMITTER,
      type: STEERING_EVENT_TYPES.StopDelivered,
      payload: {
        intent_id: observed.intentId,
        command: observed.command,
        stopped: observed.stopped,
        observed_at: observed.observedAt,
        reason: observed.stopped
          ? 'the executor had a live child for this step and was asked to stop it'
          : 'the executor had nothing live to stop, so the step had already ended when the gesture arrived',
      },
    });
    this.boundary(`stop-delivered:${observed.command}`);

    this.midStepSteering.push(this.consumeIntents(this.load(state.run)));
  }

  /**
   * Watch `commands/` while a step is in flight, and stop the step when a stop gesture appears.
   *
   * This is the mechanism behind the one property AD-7 says the loop exists to host. Story 1-3 drove a
   * step synchronously to termination, so a kill could only land *between* passes — and a pass that
   * checks between steps cannot provide "instant", because a step is where all the time goes.
   *
   * What it does and does not do is worth being exact about. It only ever *stops the child*: it appends
   * nothing to the log and applies no intent, because it runs inside somebody else's action and a second
   * writer inside one action is how two lines end up interleaved. The intent stays pending, and the
   * moment the step's termination is durable the same action consumes it — so the effect is recorded by
   * the one code path that records every effect.
   *
   * The timer is unref'd: a poll must never be the reason a process stays alive, and it is not a cleanup
   * path — nothing is reclaimed when it stops, so AD-32 is untouched.
   */
  private watchForStopIntents(
    paths: RunPaths,
    state: RunState,
    step: string,
  ): { readonly stop: () => void; readonly observed: () => StopObservation | null } {
    const run = state.run;
    if (this.stopStep === null) {
      this.recordMissingStopper(state, step);
      return { stop: (): void => undefined, observed: (): StopObservation | null => null };
    }

    let observation: StopObservation | null = null;
    const poll = (): void => {
      if (observation !== null) return;
      const read = readIntentFiles(paths, { now: this.now, tornGraceMs: this.tornGraceMs });
      /**
       * A stop command, **and one that either names this step or names none**.
       *
       * Matching on the command alone made an intent naming a *different* step stop whatever happened to
       * be running: a person who killed step "verify" while "implement" was still in flight got the wrong
       * child stopped and the wrong step recorded `killed` — permanently, because AD-8 never re-runs a
       * killed step. A run-level stop (`step: null`) is the ordinary case and still stops whatever is
       * live, which is what a disengage means.
       */
      const halting = read.pending.find(
        (pending) =>
          isStopCommand(pending.intent.command) &&
          (pending.intent.step === null || pending.intent.step === step),
      );
      if (halting === undefined) return;

      const reason =
        `${halting.intent.principal.kind} "${halting.intent.principal.id}" issued ` +
        `"${halting.intent.command}" while step "${step}" was running`;
      observation = {
        intentId: halting.intent.intent_id,
        command: halting.intent.command,
        stopped: this.stopStep?.({ run, step, command: halting.intent.command, reason }) ?? false,
        observedAt: formatTimestamp(this.now()),
      };
    };

    const timer = setInterval(poll, this.pollIntervalMs);
    timer.unref();
    // Polled once immediately as well, so the latency is the executor's, not the first interval's.
    poll();
    return {
      stop: (): void => {
        clearInterval(timer);
      },
      observed: (): StopObservation | null => observation,
    };
  }

  /**
   * Record, once per run per engine, that a step ran with no way to stop it.
   *
   * CAP-5's mid-step property is inert as this build is assembled: `stopStep` reaches the reconciler only
   * through `options.stopStep`, and nothing in `src/` constructs a `Reconciler` at all — the production
   * assembly point is a later story's, the same gap stories 1-5 and 1-6 recorded for their own ports.
   * Wiring it here would be inventing that assembly point in the wrong story.
   *
   * What can be fixed now is the *silence*. Without this line, a run driven by an engine with no stopper
   * behaved exactly like a run whose disengage was simply slow: the intent sat in `commands/` until the
   * step ended on its own, and nothing anywhere said the capability was missing. Now the log says so, so
   * a person reading a run that ignored their disengage finds the reason rather than inferring it.
   *
   * Once per run and *per engine process*, not per pass and not per step: the fact is about how this
   * process was assembled, so it is worth saying once, and a restart with a different assembly is a
   * different fact worth saying again. It is not folded (AD-5) — it changes no state.
   */
  private recordMissingStopper(state: RunState, step: string): void {
    if (this.reportedMissingStopper.has(state.run)) return;
    this.reportedMissingStopper.add(state.run);

    this.recorderFor(state.run, state.feature).recordResult({
      feature: state.feature,
      run: state.run,
      step,
      emitter: ENGINE_EMITTER,
      type: STEERING_EVENT_TYPES.StopperUnwired,
      payload: {
        reason:
          'This engine was assembled with no step stopper, so a disengage, kill or take-over written ' +
          'while a step is in flight cannot reach the child. The intent is not lost — it stays in ' +
          'commands/ and is applied as soon as the step ends on its own — but it does not stop the step, ' +
          'so CAP-5’s mid-step promise is not being kept by this process.',
        capability: 'mid-step stop (CAP-5)',
      },
    });
    this.boundary('stopper-unwired');
  }

  /** CAP-23 — stop and explain, as its own recorded facts, so every caller hands off identically. */
  private handOff(
    paths: RunPaths,
    plan: FeaturePlan,
    state: RunState,
    step: string | null,
    code: string,
    reason: string,
  ): void {
    const recorder = this.recorderFor(state.run, state.feature);
    // The document first: a person having a bad day needs the note whether or not the two lines below
    // landed, and rewriting it whole makes a repeated hand-off free.
    this.writeHandoff(paths, plan, state, { code, reason, escape: null });
    this.emit(recorder, {
      step,
      type: ENGINE_EVENT_TYPES.HandoffRecorded,
      payload: { code, reason },
    });
    this.emit(recorder, {
      step,
      type: ENGINE_EVENT_TYPES.FeatureStateChanged,
      payload: { from: state.state, to: 'handed_off', reason },
    });
  }

  /**
   * Append the termination, and the lifecycle transition the termination itself implies.
   *
   * Only `interrupted` implies one here, and the diagram says why: `running → interrupted` is the arrow
   * an engine kill, a crash or a closed laptop takes, and the run is *in* that state the moment the step
   * reports it — not later, when a pass gets round to routing it. `failed` and `blocked` imply nothing
   * yet: what they mean is the AD-35 table's answer, which the next pass reads.
   */
  private recordTermination(
    state: RunState,
    step: PlanStep,
    baselineRef: string,
    termination: StepTermination,
    context: { readonly transitionTo: FeatureState },
  ): void {
    const recorder = this.recorderFor(state.run, state.feature);
    this.emit(recorder, {
      step: step.step,
      type: ENGINE_EVENT_TYPES.StepTerminated,
      payload: {
        disposition: termination.disposition,
        ...(termination.error === null ? {} : { error: termination.error }),
        /**
         * What the attempt cost and consumed (R10, and what story 2-9's ceilings will read).
         *
         * Spread rather than written unconditionally, because the key's *absence* is the record that the
         * CLI reported nothing. Writing `usage: null`, or worse a record of zeros, would have the
         * completion notice state `0` where R8 requires `(not recorded)` — a step nobody measured is not
         * a step that was free. Numbers are safe in a payload: AD-21's entropy sweep only rewrites
         * strings, which is why the usage lives here and an identifier has to live in the envelope.
         */
        ...(termination.usage === null ? {} : { [USAGE_PAYLOAD_KEY]: termination.usage }),
      },
      sessionId: termination.sessionId,
      baselineRef,
    });

    if (termination.disposition === 'completed') {
      this.recordDeclaredTerritory(state, step, recorder, termination);
    }

    if (termination.disposition === 'interrupted' && context.transitionTo !== 'interrupted') {
      this.emit(recorder, {
        step: step.step,
        type: ENGINE_EVENT_TYPES.FeatureStateChanged,
        payload: {
          from: context.transitionTo,
          to: 'interrupted',
          reason: `step "${step.step}" reported an interruption, which is the one resumable disposition`,
        },
      });
    }
  }

  /**
   * The rung this phase's agent *declares* it starts on (AD-17), or `null` when nothing declares one.
   *
   * Read from the run's AD-9 configuration snapshot, which is the only configuration a step reads, so a
   * mid-run edit to `.orch/` reaches nothing. A run whose snapshot declares no agent for the phase
   * answers `null` and the feature plan's tier applies: that is an *absence*, not a default invented
   * here, and the spawn that follows still refuses for want of a grant (`src/engine/agents.ts`), so
   * nothing is softened by reading the tier leniently.
   *
   * A rung the build cannot place is *not* softened: {@link startingRung} throws inside
   * `grantFromRoster`, and the caller routes that to a person.
   */
  private declaredStartingRung(run: string, phase: string): ModelRung | null {
    try {
      return resolveAgentGrant({ run, phase, orchHome: this.orchHome }).startTier;
    } catch (thrown: unknown) {
      if (thrown instanceof ModelRungUnrecognised) throw thrown;
      // No snapshot, no roster, or no entry for this phase: nothing is declared, and nothing is invented.
      return null;
    }
  }

  /**
   * Run the deterministic gates for a verification step, and say whether the review may be spawned.
   *
   * Returns what the gates did when the step should go on to spend model turns — an empty list for a
   * step that has no gates to run — and `null` when this pass is over because the step has already
   * been terminated here. The outcomes travel because the step input carries them: the engine is the
   * only thing that knows what the gates returned, and the verification contract requires the model
   * to report exactly that.
   *
   * **Why the loop runs them and not the agent.** A spawn is the thing that costs, and a step cannot
   * decline to be spawned: an agent told "run the gates first, and stop if they fail" has already
   * been paid for by the time it reads the instruction. CAP-13's economics are only real if the
   * decision is taken by the unit that does the spawning.
   *
   * **Only `verification`.** The story's Boundaries settle this: "the two tiers live inside
   * verification, because there is no review agent". `testing` reaches the same runner as an MCP
   * tool, because the tests it writes are its own to run.
   */
  private runGatesBeforeReview(
    plan: FeaturePlan,
    state: RunState,
    step: PlanStep,
    baselineRef: string,
    transitionTo: FeatureState,
    attempt: number,
  ): readonly GateOutcomeRecord[] | null {
    if (step.phase !== 'verification') return [];
    let commands: MechanicsCommands | null;
    try {
      commands = this.declaredCommands(state.run);
    } catch (thrown: unknown) {
      // The refusal is a *step termination*, not an escape: a pass that threw here would leave the
      // step recorded as in flight and take every other feature's pass down with it.
      if (!(thrown instanceof UnreadableGateConfiguration)) throw thrown;
      this.recordTermination(
        state,
        step,
        baselineRef,
        {
          step: step.step,
          disposition: 'failed',
          sessionId: null,
          output: null,
          error: makeError(thrown.code, thrown.message, renderCause(thrown.cause)),
          usage: null,
        },
        { transitionTo },
      );
      return null;
    }
    /**
     * No snapshot or no profile: nothing is declared, so there is no gate to run and none to skip.
     *
     * Not the same as "the gates passed", and the difference is why nothing is recorded as passing
     * here. A run with no configuration snapshot is a run that was assembled without one, which the
     * roster's own refusal (`src/engine/agents.ts`) reports at the spawn a moment later.
     */
    if (commands === null) return [];

    const declared = DETERMINISTIC_GATE_NAMES.filter((name) => (commands[name] ?? '').trim() !== '');
    const recorder = this.recorderFor(state.run, state.feature);
    if (declared.length > 0 && this.gates === null) {
      /**
       * Declared gates and no runner: the run blocks rather than reviewing unverified work.
       *
       * This is the fail-closed direction, and it is the one the whole story turns on. Spawning
       * anyway would spend a review on a change whose gates nobody ran while the log said nothing
       * about it — a run that *looks* verified. `config.invalid` is `escalate-to-human`: no retry
       * and no model rung wires a command runner into an engine.
       */
      this.recordTermination(
        state,
        step,
        baselineRef,
        {
          step: step.step,
          disposition: 'failed',
          sessionId: null,
          output: null,
          error: makeError(
            'config.invalid',
            `This engine has no command runner wired in, so the ${declared.join(', ')} gate` +
              `${declared.length === 1 ? '' : 's'} this repository declares cannot be run. CAP-13 ` +
              'requires the deterministic gates to run before any model-based review, so the ' +
              'review is not spawned and the run stops here rather than judging unverified work.',
            'no gate runner is configured',
          ),
          usage: null,
        },
        { transitionTo },
      );
      return null;
    }

    /**
     * A throw from the *factory* is caught for the same reason a throw from `run` is.
     *
     * Building a runner resolves an image and locates a runtime, either of which fails on a machine
     * whose daemon is not answering — and an uncaught throw here escapes the whole pass, leaving
     * the step recorded as in flight and taking every other feature's pass down with it. It is the
     * same kind of failure as a container that would not start, so it takes the same code.
     */
    let runner: DeterministicGateRunner | null = null;
    if (this.gates !== null) {
      try {
        runner = this.gates({
          run: state.run,
          step: step.step,
          worktree: plan.worktree,
          commands,
          attempt,
        });
      } catch (thrown: unknown) {
        this.recordTermination(
          state,
          step,
          baselineRef,
          {
            step: step.step,
            disposition: 'failed',
            sessionId: null,
            output: null,
            error: makeError(
              'container.start_failed',
              `The deterministic gates could not be prepared for step "${step.step}": ` +
                `${renderCause(thrown) ?? 'the gate runner could not be built'}. Nothing ran, so no ` +
                'gate failed and no review was spawned.',
              renderCause(thrown),
            ),
            usage: null,
          },
          { transitionTo },
        );
        return null;
      }
    }

    const results: GateOutcomeRecord[] = [];
    for (const name of DETERMINISTIC_GATE_NAMES) {
      /**
       * A gate with no declared command is skipped, and the *log line says skipped*.
       *
       * Reported without asking the runner at all when there is none wired: the answer does not
       * depend on a container, and a skip is the one gate outcome that costs nothing to be sure of.
       */
      const declaredCommand = (commands[name] ?? '').trim();
      if (declaredCommand === '' || runner === null) {
        const skipped: GateOutcomeRecord = {
          command: name,
          declared: '',
          outcome: 'skipped',
          exitStatus: null,
          evidence: '',
          containerName: null,
          summary: `the ${name} gate is skipped: this repository declares no ${name} command`,
        };
        results.push(skipped);
        this.emit(recorder, {
          step: step.step,
          type: ENGINE_EVENT_TYPES.GateSkipped,
          payload: { gate: name, reason: skipped.summary },
          baselineRef,
        });
        continue;
      }
      /**
       * A gate that could not be *started* is not a gate that failed.
       *
       * The runner refuses rather than returning an outcome when the runtime could not run the
       * container at all — a name still held by a container AD-32 has not reclaimed, an image that
       * vanished, a daemon that was restarting. Recording that as a failing gate would tell a person
       * their tests are broken when nothing ran, so it routes through the AD-35 table under its own
       * code (`container.start_failed`, `retry-with-backoff`) and the review is still not spawned.
       */
      let outcome: GateOutcomeRecord;
      try {
        outcome = runner.run(name);
      } catch (thrown: unknown) {
        const error =
          thrown instanceof Error && 'orchError' in thrown
            ? (thrown as { readonly orchError: OrchError }).orchError
            : makeError(
                'container.start_failed',
                `The ${name} gate could not be run: ${renderCause(thrown) ?? 'the runner refused'}`,
              );
        this.recordTermination(
          state,
          step,
          baselineRef,
          {
            step: step.step,
            disposition: 'failed',
            sessionId: null,
            output: null,
            error,
            usage: null,
          },
          { transitionTo },
        );
        return null;
      }
      results.push(outcome);
      /**
       * AD-21 — a dropped artifact is recorded as `redaction.failed`, never passed over in silence.
       *
       * "The pass fails closed, dropping the artifact and recording a `redaction.failed` event
       * rather than writing unredacted content." The runner does the dropping, because it holds the
       * bytes; the log line is the engine's, because AD-29 gives the recorder one writer. Without
       * it a gate whose output was dropped looked exactly like one whose output was written, and
       * the pointer resolved to a placeholder nobody had been told about.
       */
      if (outcome.evidenceDropped !== undefined) {
        this.emit(recorder, {
          step: step.step,
          type: REDACTION_FAILED_EVENT_TYPE,
          payload: { gate: name, evidence: outcome.evidence, reason: outcome.evidenceDropped },
          baselineRef,
        });
      }
      this.emit(recorder, {
        step: step.step,
        type:
          outcome.outcome === 'passed'
            ? ENGINE_EVENT_TYPES.GatePassed
            : outcome.outcome === 'failed'
              ? ENGINE_EVENT_TYPES.GateFailed
              : ENGINE_EVENT_TYPES.GateSkipped,
        payload: {
          gate: name,
          command: outcome.declared,
          exit_status: outcome.exitStatus,
          // AD-23: the pointer, never the output. A test suite's stdout is megabytes and the control
          // plane is bounded by a declared token ceiling.
          evidence: outcome.evidence,
          reason: outcome.summary,
        },
        baselineRef,
      });
    }

    const failed = results.filter((result) => result.outcome === 'failed');
    if (failed.length === 0) return results;

    /**
     * The failure names which gate and its exit status, which is matrix row 20's other half: a run
     * that says "verification failed" and nothing else sends a person to read a transcript to learn
     * what a single line could have told them.
     */
    const named = failed
      .map((gate) => `${gate.command} exited ${String(gate.exitStatus ?? -1)} (${gate.evidence})`)
      .join('; ');
    this.emit(recorder, {
      step: step.step,
      type: ENGINE_EVENT_TYPES.ReviewSkipped,
      payload: {
        reason:
          'the deterministic gates failed, so no model-based review was spawned for this step ' +
          '(CAP-13: no review spend occurs on a run that fails them)',
        failed_gates: failed.map((gate) => gate.command),
      },
      baselineRef,
    });
    this.recordTermination(
      state,
      step,
      baselineRef,
      {
        step: step.step,
        disposition: 'failed',
        sessionId: null,
        output: null,
        // `step.verification_failed` is `escalate-model-tier`, which is the Stack's own promotion
        // trigger — "one promotion per step per run, on a failed verification gate". A failing gate
        // is exactly that trigger, and routing it through the table is what keeps this step's
        // failure indistinguishable from any other failed verification to every reader downstream.
        error: makeError('step.verification_failed', `A declared gate failed: ${named}.`, named),
        usage: null,
      },
      { transitionTo },
    );
    return null;
  }

  /**
   * The commands the run's profile declares, from its AD-9 snapshot, or `null` when it has none.
   *
   * Read from the snapshot rather than from `.orch/`, for the reason every other configuration read
   * in this class is: run scope is the only configuration a step's world is built from (AD-34), so a
   * profile edited mid-run changes nothing about a run already under way.
   */
  private declaredCommands(run: string): MechanicsCommands | null {
    try {
      return readStepConfiguration(run, { orchHome: this.orchHome }).profile.mechanics.commands;
    } catch (thrown: unknown) {
      /**
       * **Absent and unreadable are different answers, and conflating them disabled the gates.**
       *
       * A run with no snapshot declares no commands, so there is no gate to run and none to skip —
       * an absence, whose refusal is the roster's at the spawn a moment later. A profile that
       * *exists* and cannot be read is the opposite: it may declare every gate CAP-13 names, and
       * answering `null` for it spawned the review with no gate events at all and nothing in the log
       * saying why. A v1 profile — exactly what this story's own version bump creates — raises
       * `SchemaVersionRefusal` here, so the commonest case was the silent one.
       *
       * This is the distinction story 2-3's review drew for the roster directory, one file over.
       */
      if (thrown instanceof ProfileNotFound) return null;
      throw new UnreadableGateConfiguration(run, thrown);
    }
  }

  /**
   * Record the territory a completed step *declared*, when its output is one that declares one.
   *
   * This is the join the story is named for: a feature is accepted with the territory its caller guessed,
   * analysis reads the repository and says which files it actually touches, and the next admission pass
   * serialises whatever that newly overlaps. Until it existed, `acceptFeature`'s run-creation line was the
   * only `feature.territory_declared` any production path ever wrote.
   *
   * **Keyed on the field, not on the phase and not on one contract's schema.** The test is whether the
   * output carries a declared territory at all. A phase test would be a second place that decides what an
   * analysis agent is; asking `AnalysisOutputSchema.safeParse` — which is what this did until story 2-5 —
   * is the same defect one level down, because that schema pins `contract_id` to `step.analysis`, so
   * `step.planning` and `step.implementation` declared territories the engine threw away. `contractOutput`
   * is the value that contract validated, before `StepOutputSchema` narrowed it and stripped the territory
   * out, and {@link declaredTerritoryIn} asks it the one question this needs answered.
   *
   * The comparison is against the *log*, inside `recordTerritoryRedeclaration`, never against the plan:
   * the plan is what the caller declared at run creation and may already be two corrections behind.
   */
  private recordDeclaredTerritory(
    state: RunState,
    step: PlanStep,
    recorder: Recorder,
    termination: StepTermination,
  ): void {
    const declared = declaredTerritoryIn(termination.contractOutput);
    // Not an output that declares a territory. Every other contract reaches here too, and says nothing.
    if (declared === null) return;

    const paths = runPaths(state.run, this.orchHome);
    const recorded = recordTerritoryRedeclaration({
      recorder,
      step: step.step,
      events: readEventLog(paths.eventLog),
      declared,
    });
    // AD-4: a correction the log does not carry is one the next pass will not see, so a dropped line is
    // the same unrecorded action every other emit treats as one rather than something to carry on past.
    if (!recorded.recorded) throw new UnrecordedAction(TERRITORY_DECLARED_EVENT_TYPE);
  }

  /** Build the port's request. Nothing here spawns: that is story 1-4's whole subject. */
  private startRequest(
    paths: RunPaths,
    plan: FeaturePlan,
    state: RunState,
    step: PlanStep,
    record: Pick<StepRecord, 'baseline_ref' | 'attempts'>,
    tier: ModelRung,
    prepared?: StepInput,
  ): StepStartRequest {
    const input = prepared ?? this.stepInput(paths, plan, state, step, record.baseline_ref).value;
    const recorder = this.recorderFor(state.run, state.feature);
    return {
      run: state.run,
      feature: state.feature,
      step: step.step,
      phase: step.phase,
      contractId: step.contract_id,
      input,
      inputPath: stepInputPath(paths, step.step),
      baselineRef: record.baseline_ref,
      worktree: plan.worktree,
      modelTier: tier,
      attempt: record.attempts,
      mode: plan.mode,
      /**
       * AD-8 — the session id is recorded the moment the subprocess reports it, not when the step
       * ends. A crash between the spawn and the termination is exactly the case a resume exists for,
       * and a session id that only landed at the end would be missing in precisely that case.
       */
      onSessionId: (sessionId: string): void => {
        this.emit(recorder, {
          step: step.step,
          type: ENGINE_EVENT_TYPES.StepSessionRecorded,
          payload: { attempt: record.attempts },
          sessionId,
          baselineRef: record.baseline_ref,
        });
      },
    };
  }

  // ---------------------------------------------------------------------------------------------
  // The typed input file
  // ---------------------------------------------------------------------------------------------

  /**
   * The step's typed input file, written once and reused by every re-run.
   *
   * "Re-run the step from its typed input file" (AD-8, CAP-6) is only true if the file does not change
   * between attempts, so an existing one is read back rather than regenerated. The one thing that is
   * checked is the baseline ref: an input file naming a different commit than the record would make the
   * reset and the re-run disagree about what the step started from.
   */
  private stepInput(
    paths: RunPaths,
    plan: FeaturePlan,
    state: RunState,
    step: PlanStep,
    baselineRef: string,
    gates: readonly GateOutcomeRecord[] = [],
  ): { readonly value: StepInput; readonly relativePath: string } {
    const path = stepInputPath(paths, step.step);
    const relativePath = stepInputRelativePath(step.step);
    const recorded = gates.map(
      (gate): GateOutcome => ({
        command: gate.command,
        declared: gate.declared,
        outcome: gate.outcome,
        exit_status: gate.exitStatus,
        evidence: gate.evidence,
      }),
    );

    if (existsSync(path)) {
      const parsed = StepInputSchema.safeParse(JSON.parse(readFileSync(path, 'utf8')));
      if (
        parsed.success &&
        parsed.data.baseline_ref === baselineRef &&
        parsed.data.contract_id === step.contract_id &&
        /**
         * **And the gates it carries are this attempt's.** CAP-6 has a re-run read the same bytes,
         * and for every other field that is exactly right — the request, the criteria and the
         * baseline do not change between attempts. The gate outcomes do: re-running a verification
         * step runs them again, and that is the point of re-running it. An input reused across a
         * re-run would hand the step the *previous* attempt's exit statuses and evidence pointers,
         * which is a step judging one run of the gates while the log records another.
         */
        JSON.stringify(parsed.data.gates) === JSON.stringify(recorded)
      ) {
        return { value: parsed.data, relativePath };
      }
      /**
       * An input that does not parse, names another baseline, **or names another contract** is not this
       * step's input. It is rewritten rather than trusted: a re-run from the wrong input is worse than a
       * re-run from a regenerated one.
       *
       * The contract comparison is what story 2-5 added, and the case is concrete. A run started before
       * the plan's `implement` step was repointed has `steps/implement/input.json` on disk saying
       * `step.output`, while the spawn now hands the child `--json-schema` for `step.implementation` and
       * AD-1 re-parses the result against the same. The agent would be told one contract by its input
       * file and judged by another — and the shape it produced would fail at the re-parse as
       * `step.schema_invalid_output`, which is `escalate-model-tier`, so a stale file would spend the
       * run's one promotion on a disagreement no model can resolve.
       */
    }

    const completed = state.steps.filter((record) => record.disposition === 'completed').length;
    const value: StepInput = {
      schema_version: CURRENT_SCHEMA_VERSION,
      contract_id: step.contract_id,
      run: state.run,
      feature: state.feature,
      step: step.step,
      mode: plan.mode,
      baseline_ref: baselineRef,
      request: plan.request,
      acceptance_criteria: [...plan.acceptance_criteria],
      // Story 1-8 supplies the ledger answers; an empty list is the honest value until it does.
      decisions: [],
      /**
       * AD-23 — evidence is referenced by pointer, and a gate's output is the first pointer this
       * system produces. Story 1-8 supplies the rest.
       */
      evidence: recorded
        .filter((gate) => gate.evidence !== '')
        .map((gate) => ({
          kind: 'log' as const,
          path: gate.evidence,
          description: `the output of the ${gate.command} gate, which ran "${gate.declared}"`,
        })),
      gates: recorded,
      budget: {
        steps_remaining: Math.max(plan.steps.length - completed, 0),
        wall_clock_ms_remaining: DECLARED_WALL_CLOCK_MS,
        rate_limit_budget_consumed: 0,
      },
      created_at: formatTimestamp(this.now()),
    };

    const validated = StepInputSchema.parse(value);
    mkdirSync(join(paths.runDir, STEPS_DIR_NAME, step.step), { recursive: true });
    writeFileSync(path, `${JSON.stringify(validated, null, 2)}\n`, 'utf8');
    return { value: validated, relativePath };
  }

  // ---------------------------------------------------------------------------------------------
  // Plumbing
  // ---------------------------------------------------------------------------------------------

  /**
   * The terminal-state guard story 1-3 added now lives in `decideSteering`, and deliberately so.
   *
   * Every command travels through the same decision function, so the guard is applied once to the whole
   * enum rather than once per method — which is how story 1-3's review found `kill` relabelling a
   * completed step and `approve` resurrecting a killed one: three methods, three chances to forget. The
   * refusal still surfaces as {@link SteeringRefused} at the method boundary, so a caller sees no change.
   */

  /**
   * AD-32, AD-7 — append the run-level declarations the log still owes, on any pass.
   *
   * `acceptFeature` records `spec.recorded` and `feature.territory_declared` when the run is created, and
   * that is not sufficient on its own: a kill between `run.created` and those two lines leaves a run whose
   * criteria never reach the durable truth, so the spec echo card would read `(not recorded)` for the rest
   * of that run's life and the stage-1 gate would hold only for runs that were never interrupted. The
   * crash-injection suite caught exactly that, at boundaries 1 and 2.
   *
   * So the repair is a *reconcile* action rather than a creation-time one, which is the shape AD-32 requires
   * of everything: guarded by what the log already carries, safe on every pass, and reached again after a
   * restart. It changes no lifecycle state and is therefore not one of the pass's at-most-one actions —
   * exactly like `settleQuestions`, and for the same reason.
   *
   * Four properties are load-bearing and each was missing once:
   *
   * **A terminal run is left exactly as its log left it.** This method runs inside the pass's enumeration of
   * every run, which turned enumerating runs from a read into an append — including appends onto runs that
   * have already committed, been killed or been handed off. Such a run will never act again, so the repair
   * buys nothing, and what it costs is real: the declaration is built from the plan as it reads *today*, so
   * a finished run would gain a claim about what it was accepted against that nobody made. Absence is the
   * honest answer for a run whose log genuinely never carried the fact (R8, R12).
   *
   * **A repair is marked as one.** {@link REPAIRED_PAYLOAD_KEY} is what distinguishes a line written at
   * `acceptFeature` from a line written days later out of a plan that may have changed since. Without it a
   * replay cannot tell a declaration from a reconstruction of one, which is precisely the confusion AD-4's
   * "the log is the durable truth" must not be built on. The key is additive and optional, so AD-5 makes it
   * invisible to an older reader.
   *
   * **Amendments already in the log are replayed after the declaration.** The fold's later-wins rule means a
   * `spec.recorded` appended *after* a run's `spec.criterion_edited` lines resets the criteria to the
   * original set — so a person's amendments would be in the log and gone from every surface, on exactly the
   * runs this repair exists for. They are re-appended, in `seq` order, each marked as a repair.
   *
   * **A line the log refuses does not poison the run.** {@link emit} throws {@link UnrecordedAction} when
   * AD-21 drops a line, because an *action* the log cannot record must not happen. A declaration is not an
   * action — nothing changes — and letting it throw out of here left the run refused on this pass and on
   * every pass after it, never advancing: the poison loop story 1-7's review found in `applyIntent`, on a
   * path that runs for every run on every pass. The failure is reported against its own run and the run goes
   * on being reconciled with the declaration still owed.
   *
   * Returns true when a line was appended, so the caller re-reads the state it had loaded rather than
   * carrying a `last_event_seq` the log has already moved past.
   */
  private recordDeclarations(loaded: LoadedState, refusals: RunRefusal[]): boolean {
    if (isTerminalFeatureState(loaded.state.state)) return false;

    const carried = new Set(loaded.events.map((event) => event.type));
    const repaired = (payload: Record<string, unknown>): Record<string, unknown> => ({
      ...payload,
      [REPAIRED_PAYLOAD_KEY]: true,
    });
    const owesSpec = !carried.has(SPEC_RECORDED_EVENT_TYPE);
    const owed: { readonly type: string; readonly payload: Record<string, unknown> }[] = [
      ...(owesSpec
        ? [{ type: SPEC_RECORDED_EVENT_TYPE, payload: repaired(specRecordedPayload(loaded.plan)) }]
        : []),
      ...(carried.has(TERRITORY_DECLARED_EVENT_TYPE)
        ? []
        : [
            {
              type: TERRITORY_DECLARED_EVENT_TYPE,
              payload: repaired(territoryDeclaredPayload(loaded.plan.territory)),
            },
          ]),
    ];
    if (owesSpec) {
      // The amendments, restated after the set they amend, or the fold would discard them. Bounded: the
      // next pass sees `spec.recorded` carried and owes nothing, so no edit is ever replayed twice.
      for (const event of [...loaded.events].sort(compareEventOrder)) {
        if (event.type !== SPEC_CRITERION_EDITED_EVENT_TYPE) continue;
        owed.push({ type: SPEC_CRITERION_EDITED_EVENT_TYPE, payload: repaired(event.payload) });
      }
    }
    if (owed.length === 0) return false;

    const recorder = this.recorderFor(loaded.state.run, loaded.state.feature);
    let appended = false;
    for (const line of owed) {
      try {
        this.emit(recorder, { step: null, ...line });
        appended = true;
      } catch (thrown: unknown) {
        // Fail closed for the rest of the batch — a declaration the log refused leaves the amendments after
        // it meaningless — and report it against this run rather than throwing into the enumeration.
        refusals.push(refusalFor(loaded.state.run, thrown));
        break;
      }
    }
    return appended;
  }

  /**
   * Emit one event through the recorder.
   *
   * The engine never opens `events.jsonl` (AD-29). Identifiers go in envelope fields — `run`, `step`,
   * `session_id`, `baseline_ref` — never in the payload, where the AD-21 pass would replace them.
   */
  private emit(
    recorder: Recorder,
    event: {
      readonly step: string | null;
      readonly type: string;
      readonly payload: Record<string, unknown>;
      readonly sessionId?: string | null;
      readonly baselineRef?: string | null;
    },
  ): void {
    const recorded = recorder.recordResult({
      feature: recorder.feature,
      run: recorder.paths.runId,
      step: event.step,
      emitter: ENGINE_EMITTER,
      type: event.type,
      payload: event.payload,
      ...(event.sessionId === undefined ? {} : { session_id: event.sessionId }),
      ...(event.baselineRef === undefined ? {} : { baseline_ref: event.baselineRef }),
    });
    // A line did land — the `redaction.failed` substitute — so the boundary is real either way.
    this.boundary(`event-appended:${event.type}`);
    if (recorded.dropped) {
      // The log does not record this action, and AD-4 makes the log the only truth. Proceeding would
      // leave the fold re-deciding the same action against a log that never remembers it.
      throw new UnrecordedAction(event.type);
    }
  }

  /** Fold the log and write the checkpoint from it. The only way a checkpoint is produced. */
  private checkpointFromLog(paths: RunPaths, plan: FeaturePlan): RunState {
    const events = readEventLog(paths.eventLog);
    const rebuilt = rebuildFromLog(events, { run: paths.runId, plan, now: this.now });
    return this.writeCheckpoint(paths, rebuilt);
  }

  private writeCheckpoint(paths: RunPaths, state: RunState): RunState {
    const written = writeCheckpoint(paths, {
      ...state,
      updated_at: formatTimestamp(this.now()),
    });
    this.boundary(`checkpoint-written:${written.state}`);
    return written;
  }

  private boundary(label: string): void {
    this.boundaryObserver?.(label);
  }

  private recorderFor(run: string, feature: string): Recorder {
    const existing = this.recorders.get(run);
    if (existing !== undefined) return existing;
    // A caller that assembles the loop with an executor of its own supplies the shared recorder, and
    // is then the one holding AD-29's claim. Cached here either way, so the loop asks once per run.
    if (this.openRecorder !== null) {
      const supplied = this.openRecorder(run, feature);
      this.recorders.set(run, supplied);
      return supplied;
    }
    const recorder = Recorder.open({
      runId: run,
      feature,
      orchHome: this.orchHome,
      now: this.now,
      redaction: this.redaction,
    });
    this.recorders.set(run, recorder);
    return recorder;
  }

  /**
   * A run's declared plan, found by the feature slug the run names.
   *
   * The log is asked first, in keeping with AD-4, and the checkpoint is the fallback — not only for a run
   * with no lines yet, but for the case where the log's own `feature` is unusable. A slug is punctuated
   * and low-entropy so the redaction pass leaves it alone, but it is not *guaranteed* to: one that folded
   * to the redaction marker would make the plan lookup fail, and since `load` is called for every run on
   * every pass, that would wedge the whole loop permanently on one run's unlucky slug. Falling back costs
   * nothing and removes a class of unrecoverable state.
   */
  private planFor(
    paths: RunPaths,
    events: readonly { readonly feature: string }[],
    checkpoint: RunState | null,
  ): FeaturePlan {
    const candidates = [events[0]?.feature, checkpoint?.feature].filter(
      (feature): feature is string =>
        typeof feature === 'string' && feature !== '' && feature !== REDACTION_MARKER,
    );
    if (candidates.length === 0) throw new IncompleteRunDirectory(paths.runId);

    let lastFailure: unknown = null;
    for (const feature of candidates) {
      try {
        return this.plans(feature);
      } catch (thrown: unknown) {
        lastFailure = thrown;
      }
    }
    throw lastFailure;
  }

  private planStepFor(plan: FeaturePlan, step: string): PlanStep {
    const found = plan.steps.find((entry) => entry.step === step);
    if (found === undefined) {
      throw new Error(
        `Step "${step}" is recorded in the run but absent from the feature's declared plan, so the ` +
          'loop has no contract to re-run it against. A plan may grow, never lose a started step.',
      );
    }
    return found;
  }

  private requireStepRecord(state: RunState, step: string): StepRecord {
    const record = findStepRecord(state, step);
    if (record === null) {
      throw new Error(`Step "${step}" has no record in run ${state.run}.`);
    }
    return record;
  }

  private report(
    run: string,
    state: RunState,
    action: ReconcileAction,
    from: FeatureState,
    step: string | null,
    loaded: { readonly disagreements: readonly CheckpointDisagreement[]; readonly checkpointRebuilt: boolean },
  ): PassAction {
    return {
      run,
      feature: state.feature,
      kind: action.kind,
      step,
      from,
      to: state.state,
      reason: action.reason,
      checkpointRebuilt: loaded.checkpointRebuilt,
      disagreements: loaded.disagreements,
    };
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new Error('This reconciler has released its ORCH_HOME lock and cannot act (AD-30).');
    }
  }
}

/** `runs/<run-id>/steps/<step>/input.json`. */
export const stepInputPath = (paths: RunPaths, step: string): string => {
  if (!SAFE_STEP_ID.test(step)) {
    throw new Error(
      `Refusing to build a path from step id "${step}": a step id is a stable declared name matching ` +
        `${String(SAFE_STEP_ID)}, so it cannot escape the run directory.`,
    );
  }
  return join(paths.runDir, STEPS_DIR_NAME, step, STEP_INPUT_FILE_NAME);
};

/**
 * Choose the one action a pass takes for a feature.
 *
 * A pure function of the checkpoint and the plan, which is the point: the decision is reproducible
 * from durable state alone, so a restart at any instant reaches the same one. The order of the tests
 * below is the specification.
 */
export const decideAction = (state: RunState, plan: FeaturePlan): ReconcileAction => {
  if (isTerminalFeatureState(state.state)) {
    return {
      kind: 'idle',
      reason: `The feature is ${state.state}, which is terminal: no further pass acts on it.`,
    };
  }

  if (state.state === 'drafting') {
    return {
      kind: 'await-confirmation',
      reason: 'No feature enters execution without user-confirmed acceptance criteria (CAP-2).',
    };
  }

  if (state.state === 'blocked') {
    return {
      kind: 'await-approval',
      reason: 'The feature blocked at a gate and waits for a person, not for another pass (CAP-12).',
    };
  }

  // A step carrying no disposition is one the engine was killed inside. It is adopted before anything
  // else is considered: every other decision would be made from a state that is not the run's.
  const orphan = inFlightStep(state);
  if (orphan !== null) {
    return {
      kind: 'adopt-orphan',
      step: orphan.step,
      reason:
        `Step "${orphan.step}" is recorded as started with no termination, so the engine was killed ` +
        'inside it. AD-8 records that as "interrupted", which is the one resumable disposition.',
    };
  }

  /**
   * The *earliest* step carrying a termination that is not `completed`, not the last record.
   *
   * Taking the last one leaves an earlier failure unrouted: the fall-through below then picks that same
   * step as "the next step with no completed record" and starts it again — a re-run with no baseline
   * reset, forever, because nothing ever consults the table about it.
   */
  const pending =
    state.steps.find(
      (record) => record.disposition !== null && record.disposition !== 'completed',
    ) ?? null;

  if (pending !== null && pending.disposition !== null) {
    const routing = routeTermination({
      step: pending.step,
      disposition: pending.disposition,
      sessionId: pending.session_id,
      error: pending.error,
      modelTier: pending.model_tier,
      promotions: pending.promotions,
    });

    /**
     * The attempt bound, applied to every routing that returns to the same step.
     *
     * It is asked *after* the routing and not before, which is what makes it one rule rather than a list
     * of dispositions kept in step by hand. `routeTermination` has already decided whether the loop comes
     * back to this step — by a resume (AD-8), by a re-run after an AD-26 baseline reset, or by a re-run at
     * a promoted rung — and the bound applies to exactly that set. A `killed` step is never returned to,
     * so a user's kill still stops rather than handing off; a `blocked` step escalates to a person, which
     * is not an attempt at all; and a step that completed never reaches here.
     *
     * The count is `attempts` less the attempts a person's approval has credited, folded from the log,
     * so a restart does not reset it (AD-4) and the resume path cannot walk around it — while a CAP-12
     * approval of a step standing at the bound gets the run it authorised rather than an immediate
     * hand-off.
     *
     * **The code is always `internal.invariant_violated`, and the step's own code is carried as the
     * cause.** It used to be `pending.error?.code ?? 'internal.invariant_violated'`, which meant that in
     * the common case — a step failing on a declared-retryable code — the hand-off went out labelled
     * `step.timed_out`, whose AD-35 disposition is `retry-with-backoff`. A hand-off written *because*
     * retrying has been exhausted must not be labelled as a thing to retry. What has actually been proved
     * is that the system spent its declared attempts on one step and cannot finish it, which is an
     * invariant it broke about itself: `abandon-and-hand-off`, never retried by whoever reads it. The
     * condition the step reported is not lost — it is named in the reason, where a person reads it.
     */
    if (returnsToSameStep(routing.action) && attemptBoundReached(attemptsAgainstBound(pending))) {
      const spent = attemptsAgainstBound(pending);
      const reported = pending.error?.code ?? null;
      return {
        kind: 'hand-off',
        step: pending.step,
        code: 'internal.invariant_violated',
        reason:
          `Step "${pending.step}" has been attempted ${String(spent)} times — every start, ` +
          `re-run and resume — and has still not completed, which is the declared limit of ` +
          `${String(DECLARED_STEP_ATTEMPT_LIMIT)}. The next action would be "${routing.action}", which ` +
          'returns to the same step, so the run stops and writes a hand-off document rather than ' +
          'retrying for ever (CAP-23, AD-35). ' +
          (reported === null
            ? 'The step reported no error code of its own; the bound is what ended it.'
            : `The condition it last reported was "${reported}", which is carried here as the cause ` +
              'rather than as the label: the hand-off itself is not a thing to retry.'),
      };
    }

    const target = targetStateFor(plan, pending.step);
    const sessionId = pending.session_id;
    switch (routing.action) {
      case 'resume':
        // `routeTermination` returns `resume` only for a step carrying a session id, so the null branch
        // is unreachable. It falls to the reset-and-re-run rather than asserting, because that is the
        // behaviour AD-8 prescribes for an interrupted step with no id — so an unreachable state stays
        // correct instead of merely loud.
        return sessionId === null
          ? {
              kind: 'reset-and-rerun',
              step: pending.step,
              promoteTo: null,
              transitionTo: target,
              reason: routing.reason,
            }
          : {
              kind: 'resume-step',
              step: pending.step,
              sessionId,
              transitionTo: target,
              reason: routing.reason,
            };
      case 'reset-and-rerun':
        return {
          kind: 'reset-and-rerun',
          step: pending.step,
          promoteTo: null,
          transitionTo: target,
          reason: routing.reason,
        };
      case 'promote-model-tier':
        // A promotion is not an action of its own: promoting and then not re-running would leave the
        // step's `failed` disposition standing, and the next pass would route it as an exhausted ladder.
        return {
          kind: 'reset-and-rerun',
          step: pending.step,
          promoteTo: routing.promoteTo,
          transitionTo: target,
          reason: routing.reason,
        };
      case 'escalate-to-human':
        return { kind: 'escalate-to-human', step: pending.step, reason: routing.reason };
      case 'hand-off':
        return {
          kind: 'hand-off',
          step: pending.step,
          code: routing.code ?? 'internal.invariant_violated',
          reason: routing.reason,
        };
      case 'stop':
        return {
          kind: 'idle',
          reason: routing.reason,
        };
      case 'advance':
        break;
    }
  }

  const completed = new Set(
    state.steps.filter((record) => record.disposition === 'completed').map((record) => record.step),
  );
  const next = plan.steps.find((entry) => !completed.has(entry.step));

  if (next === undefined) {
    return {
      kind: 'advance-state',
      to: 'committed',
      reason:
        'Every declared step completed, so the gates have passed and the run reaches its terminal ' +
        'state. Opening the pull request is the committer’s work in story 2-7.',
    };
  }

  return {
    kind: 'run-step',
    step: next,
    transitionTo: next.phase === 'verification' ? 'verifying' : 'running',
    reason:
      `Step "${next.step}" is the next declared ${next.phase} step with no completed record, so the ` +
      'reconciler claims it.',
  };
};

/** The feature state a step's phase puts the run in while that step runs. */
const targetStateFor = (plan: FeaturePlan, step: string): FeatureState => {
  const entry = plan.steps.find((candidate) => candidate.step === step);
  return entry?.phase === 'verification' ? 'verifying' : 'running';
};
