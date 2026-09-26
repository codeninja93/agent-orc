/**
 * AD-5 — one event envelope shared by every emitter.
 *
 * Every line of an `events.jsonl` is one JSON object carrying the eight declared fields. Readers
 * must ignore unknown `type` values rather than erroring, so adding an event type is never a
 * breaking change; the envelope is therefore open on `type` and open to unknown keys, while a
 * missing declared field is a parse failure.
 *
 * This module defines the envelope's shape only. `seq` assignment and the writing of
 * `events.jsonl` belong to the runtime recorder (AD-29), which is story 1-2.
 */
import { z } from 'zod';

import type { OrchError } from './error.js';

/**
 * RFC3339 with milliseconds in UTC — the one timestamp format in the system.
 *
 * Carried as a plain `z.string()`, never `z.date()`: AD-2 places date types outside the
 * structured-outputs subset, and `z.toJSONSchema` cannot represent them at all. The format is
 * enforced by a refinement, which leaves the exported JSON Schema as a bare string and so keeps
 * the export free of `pattern` and `format` keywords.
 */
export const RFC3339_MILLIS_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export const isRfc3339Millis = (value: string): boolean =>
  RFC3339_MILLIS_UTC.test(value) && !Number.isNaN(Date.parse(value));

export const TimestampSchema = z.string().refine(isRfc3339Millis, {
  message: 'must be RFC3339 with milliseconds in UTC, e.g. 2026-09-19T12:34:56.789Z',
});

/** Format a moment in the one accepted timestamp format. */
export const formatTimestamp = (at: Date = new Date()): string => at.toISOString();

/**
 * The ledger line a resolved question writes (AD-25, amended by ADR-002).
 *
 * Declared here, as a named constant, for the reason ADR-002 gives: AD-25 *requires* a decision ledger
 * and says only a resolved question writes to it, so the type carrying that record has to be declarable.
 * AD-5's open vocabulary makes an undeclared type legal to *read*, which is not a reason for this
 * project's own writer to emit one — and `isDeclaredEventType('decision.recorded')` answered `false`
 * while `isDeclaredEventType('question.resolved')` answered `true`.
 *
 * `src/engine/decision.ts` points its `DECISION_EVENT_TYPE` at this constant rather than spelling the
 * string a second time, so there is one spelling of the type in the codebase.
 */
export const DECISION_RECORDED_EVENT_TYPE = 'decision.recorded';

/**
 * The three types story 1-11 added, and the payload keys they and the enriched `question.asked` carry.
 *
 * **Spelled here and nowhere else**, which the story claimed and did not have: each name was written out
 * again in `src/engine/` and a third time in `TUI_PAYLOAD_KEYS`, so a rename would have left a writer and a
 * reader disagreeing about a string with nothing to catch it — and a fold that silently stops reading a key
 * is exactly the drift `TUI_PAYLOAD_KEYS`' own comment warns about. `src/tui/` may not import `src/engine/`,
 * but it may import this, so the one shared home for a name on disk is the contracts layer.
 */
export const SPEC_RECORDED_EVENT_TYPE = 'spec.recorded';
export const SPEC_CRITERION_EDITED_EVENT_TYPE = 'spec.criterion_edited';
export const FEATURE_TERRITORY_DECLARED_EVENT_TYPE = 'feature.territory_declared';

/** The payload keys of the three declaration types, and of the keys 1-11 added to `question.asked`. */
export const DECLARATION_PAYLOAD_KEYS = {
  /** `spec.recorded` — the user's own words. */
  Request: 'request',
  /** `spec.recorded` — the criteria, in their declared order. */
  AcceptanceCriteria: 'acceptance_criteria',
  /** `spec.criterion_edited` — which line, 1-based, or `null` for an amendment that named none (Q6). */
  CriterionLine: 'line',
  /** `spec.criterion_edited` — the amended wording, as the person wrote it. */
  CriterionText: 'text',
  /** `feature.territory_declared` — the normalised declared paths. */
  TerritoryPaths: 'paths',
  /**
   * `feature.territory_declared` — the territory this line replaced, and how it differs.
   *
   * A re-declaration is a *correction*, so `territoryFromEvents` takes the last one and the earlier paths
   * are gone from the fold. That is right for the admission decision and wrong for a reader asking what
   * happened: a declaration that **widens** the territory can newly overlap a feature already admitted and
   * already writing, and admission being recomputed every pass serialises them from the next pass onward
   * while the work already done concurrently is not undone. The architecture has no rollback for that, so
   * the story's job is to make the widening visible rather than to invent one — these keys are that
   * visibility. They are additive and optional, which AD-5 makes non-breaking: the first declaration of a
   * run carries none of them and an older reader ignores them.
   */
  TerritoryPreviousPaths: 'previous_paths',
  /** `feature.territory_declared` — paths this declaration claims that the previous one did not. */
  TerritoryAddedPaths: 'added_paths',
  /** `feature.territory_declared` — paths the previous declaration claimed and this one does not. */
  TerritoryRemovedPaths: 'removed_paths',
  /** `feature.territory_declared` — true when this declaration claims ground the previous did not. */
  TerritoryWidened: 'widened',
  /** `question.asked` — each option's id, label, consequence and escape flag (Q1). */
  OfferedOptions: 'offered_options',
  /** `question.asked` — the self-contained mini-brief (Q3). */
  Brief: 'brief',
  /** `question.asked` — the instant a countdown is measured from (Q2). */
  AskedAt: 'asked_at',
  /**
   * `question.asked` — how many raised questions this one card stands for; `1` for an unmerged one.
   *
   * A number in the payload rather than a sentence in the brief, because the deflection rate counts raised
   * questions (story 2-8, matrix 28) and a count parsed back out of prose fails by reading as `1` — a
   * plausible value nobody would notice. Additive, which AD-5 makes non-breaking: a line written before it
   * existed carries no such key, and a reader treats the absence as absence.
   */
  RaisedQuestionCount: 'raised_question_count',
} as const;

/** CAP-13's first tier, one type per outcome so a skip is legible without reading a payload. */
export const GATE_PASSED_EVENT_TYPE = 'gate.passed';
export const GATE_FAILED_EVENT_TYPE = 'gate.failed';
export const GATE_SKIPPED_EVENT_TYPE = 'gate.skipped';

/**
 * The review that was not spawned, and why.
 *
 * **It has two causes, and `narrowed_by` is the key that tells them apart.** Story 2-6 emits it when a
 * deterministic gate failed (CAP-13: no review spend on a failing run), carrying the failed gates. Story 2-9
 * emits it when a degraded run narrows scope (AD-24) and every gate that ran passed; that line carries
 * {@link REVIEW_SKIPPED_PAYLOAD_KEYS}.NarrowedBy set to `budget.degraded`, and an empty `failed_gates`. A
 * reader must check `narrowed_by` rather than infer the cause from `failed_gates` being empty.
 */
export const REVIEW_SKIPPED_EVENT_TYPE = 'verification.review_skipped';

/** The payload keys a `verification.review_skipped` line may carry. */
export const REVIEW_SKIPPED_PAYLOAD_KEYS = {
  Reason: 'reason',
  FailedGates: 'failed_gates',
  PassedGates: 'passed_gates',
  /** Present only on a narrowed skip: the event type that caused it, `budget.degraded`. Absent means a gate failed. */
  NarrowedBy: 'narrowed_by',
  /** True when the skip was decided on a resume, from the outcomes the resumed attempt had already recorded. */
  Resumed: 'resumed',
} as const;

/**
 * Story 4-2 — a completed verification step's own per-criterion verdicts, promoted from the artifact
 * into the durable log.
 *
 * `step.verification`'s own docblock draws the line that matters here: a contract sees one artifact and
 * cannot see the run, so it cannot enforce a rule that spans two steps. Whether every one of `verify`'s
 * own judgements is `met` is exactly such a rule — the reconciler's spawn-gating check for `adversarial`
 * needs it on a *later* pass, and AD-4/AD-7 make the log the only place a later pass may read a fact
 * from. Without this line, a verification step's `judgements` lived only in the terminal output the
 * spawner already discards for a `completed` step's record beyond `contractOutput`, which does not
 * survive past the pass that produced it.
 *
 * One line per completed step, carrying every judgement at once, rather than one line per judgement the
 * way `gate.*` does: a gate's per-line split exists so a skip is legible without parsing a payload, and
 * that reasoning does not carry over to a criterion, which is read back programmatically here rather
 * than watched live.
 */
export const VERIFICATION_JUDGEMENTS_RECORDED_EVENT_TYPE = 'verification.judgements_recorded';

/** The payload keys a `verification.judgements_recorded` line carries. */
export const VERIFICATION_JUDGEMENTS_RECORDED_PAYLOAD_KEYS = {
  /** Every judgement the completed output reported: `{ criterion, verdict }` pairs, in the output's order. */
  Judgements: 'judgements',
} as const;

/**
 * Story 4-2 — the `adversarial` step was not spawned because `verify`'s own judgements were not all
 * `met`.
 *
 * The same "declared but not run" shape a skipped deterministic gate already has (`gate.skipped`):
 * CAP-13's third tier is never spent on an implementation the cheaper tier has already found wanting,
 * and that has to be a line in the log rather than an absent `agent.spawned` a reader has to interpret.
 */
export const ADVERSARIAL_SKIPPED_EVENT_TYPE = 'adversarial.skipped';

/** The payload keys an `adversarial.skipped` line carries. */
export const ADVERSARIAL_SKIPPED_PAYLOAD_KEYS = {
  Reason: 'reason',
  /** The criteria `verify` judged `unmet` or `undetermined`, which is what stopped the spawn. */
  UnresolvedCriteria: 'unresolved_criteria',
} as const;

/**
 * AD-24's two ceiling lines, spelled once for the writer and every reader.
 *
 * Both were in {@link EVENT_TYPES} as bare literals from story 1-1 with no emitter, and `src/tui/` spells
 * them a third time. A constant here is what lets the engine's writer and the fold's reader be the same
 * string by construction rather than by two people typing it identically.
 */
export const BUDGET_DEGRADED_EVENT_TYPE = 'budget.degraded';
export const BUDGET_EXHAUSTED_EVENT_TYPE = 'budget.exhausted';

/**
 * A degraded run's step put on a lower rung by budget pressure (AD-24) — never a promotion run backwards.
 *
 * Declared here rather than only in the engine's own table because a renderer has to show it: a downshift is
 * the visible half of degradation, and AD-5's ignore-unknown rule would otherwise have the timeline drop it.
 */
export const STEP_TIER_DOWNSHIFTED_EVENT_TYPE = 'step.tier_downshifted';

/**
 * The payload keys a `budget.degraded` or `budget.exhausted` line carries beside two `BudgetSchema` fields.
 *
 * `wall_clock_ms_remaining` and `rate_limit_budget_consumed` travel under their `BudgetSchema` names because
 * `src/tui/projection.ts` already folds those names off exactly these two types, so a second spelling here
 * would be a field no surface reads. Both are unclamped in the log — a negative remainder or a share past 1
 * is the overshoot this line exists to report (R12) — though a step input clamps them to its schema.
 * What is added is *which* ceiling tripped and by how much, which the budget alone cannot say. Every value
 * is a short enum member or a number, so AD-21's entropy sweep has nothing to rewrite (AD-5 additive).
 */
export const BUDGET_PAYLOAD_KEYS = {
  /** Which of AD-24's three ceilings this line is about. */
  Dimension: 'dimension',
  /** The unit `consumed` and `ceiling` are in: `step_attempts`, `ms` or `tokens`. */
  Unit: 'unit',
  /** Consumed over ceiling on that dimension, unclamped: an overshoot is reported as one (R12). */
  Fraction: 'fraction',
  /** What was consumed on that dimension, in its own unit. */
  Consumed: 'consumed',
  /** The ceiling that dimension is measured against, in the same unit. */
  Ceiling: 'ceiling',
  /**
   * False when the reading could not be measured (a zero ceiling, an unparseable timestamp): the fraction is
   * then written as exactly `1`, "treated as reached", instead of `NaN`/`Infinity` serialising as `null`.
   */
  Measurable: 'measurable',
  /**
   * Declared plan steps with no completed record — the *plan's* count, which is not the step-attempt ceiling
   * `dimension: 'steps'` measures. Named for what it is so the two are not read as one figure; the step input
   * carries the same number as `BudgetSchema.steps_remaining`.
   */
  PlanStepsRemaining: 'plan_steps_remaining',
  Reason: 'reason',
} as const;

/**
 * The branch-protection assertion taken at run start, and what it concluded (ADR-001, story 2-7).
 *
 * One type carrying an outcome rather than three, which is the opposite of what the gate lines do, and the
 * difference is that a gate is one of several and this is one assertion per run: a reader asking "was
 * protection asserted, and what came back" reads one line either way, so splitting it would buy nothing
 * and leave a reader to check three names to find out it was never recorded. The outcome that matters most
 * is `unknown`, and it is the one this line exists to make sayable — an unverifiable protection reported as
 * satisfied is indistinguishable from a verified one on every surface.
 */
export const BRANCH_PROTECTION_ASSERTED_EVENT_TYPE = 'branch.protection_asserted';

/**
 * What the assertion concluded. `unknown` is a first-class answer and not an error case.
 *
 * **All three refuse the run except the first.** "We could not check" and "it is not protected" have the
 * same consequence, which is the fail-closed direction `src/container/lifecycle.ts` already took and the
 * threat model's reason for it: protected main is the one control that survives total agent failure, so
 * an unverified branch is treated exactly as an unprotected one. The vocabulary still distinguishes them
 * because the *log* must — a person reading a refusal needs to know whether their branch is unprotected
 * or whether nothing could reach the host, and those are two different things to go and fix.
 *
 * **Declared here rather than in `src/container/lifecycle.ts`, which owns the assertion itself.** The
 * engine may import only `src/contracts/`, `src/runtime/` and `node:` builtins — asserted in
 * `tests/engine.reconciler.test.ts` — so a vocabulary spelled in the container package is one the
 * reconciler that records the line cannot see. The decision lives in one place; the words it answers in
 * live where both readers are allowed to look.
 */
export const BRANCH_PROTECTION_OUTCOMES = ['protected', 'unprotected', 'unknown'] as const;

export type BranchProtectionOutcome = (typeof BRANCH_PROTECTION_OUTCOMES)[number];

/** The payload keys of a `branch.protection_asserted` line, spelled once. */
export const BRANCH_PROTECTION_PAYLOAD_KEYS = {
  Outcome: 'outcome',
  /**
   * `default_branch` and not `branch`, for two reasons that agree. It names the branch a pull request
   * would merge *into*, not the branch a feature's work is on. And `branch` is a payload key story 1-11
   * forbade outright — `tests/tui.reconstruction.test.ts` asserts no payload carries one — because the
   * take-over branch embeds a ULID and AD-21's entropy sweep would rewrite it. A default branch is
   * `main` or `master`: low entropy, product-meaningful and safe in a payload.
   */
  Branch: 'default_branch',
  Reason: 'reason',
} as const;

/**
 * The outcome of the run-start branch-protection assertion, as the recorder of the line receives it.
 *
 * `refusal` carries the AD-35 error shape when the outcome is not `protected`, so the unit that records
 * the line and the unit that decides the run cannot disagree about whether this outcome stops a run.
 */
export interface BranchProtectionReport {
  readonly outcome: BranchProtectionOutcome;
  /** The branch asserted about, or `null` when none could even be named. */
  readonly branch: string | null;
  /** Why this outcome, in one line that stands alone. Never blank, including for `protected`. */
  readonly reason: string;
  readonly refusal: OrchError | null;
}

/**
 * The commit a completed committing step composed: the branch, the intents and the note (AD-22, AD-15).
 *
 * Emitted by the reconciler when a committing step completes, so the composition is in the durable
 * record rather than living only in the value a method returned. Story 2-11's executor reads the intents
 * back from here and from the artifact this line points at; nothing in this build executes one.
 */
export const COMMIT_COMPOSED_EVENT_TYPE = 'commit.composed';

/**
 * The payload keys of that line, spelled once.
 *
 * Every value is short and punctuated. The note itself is **not** in the payload: it carries the run id,
 * which is an unbroken ULID, and AD-21's entropy sweep rewrites one wherever it appears in a payload. So
 * the line carries a pointer into the evidence plane (AD-23) and the composed artifact is on disk, which
 * is the same split every other large value in this system takes.
 */
export const COMMIT_COMPOSED_PAYLOAD_KEYS = {
  Branch: 'composed_branch',
  IntentIds: 'intent_ids',
  NoteRef: 'note_ref',
  NoteSchemaVersion: 'note_schema_version',
  Artifact: 'artifact',
  /** Present instead of the rest when the record could not be composed, carrying the AD-35 code. */
  Refusal: 'refusal_code',
} as const;

/**
 * Story 2-11 — AD-15's durable-before-write pair, plus the outcome a failed call leaves behind.
 *
 * `write.attempted` is durable before the underlying `git`/`gh` call, per AD-15's fixed ordering.
 * `write.executed` follows a call that landed (or a reconciliation check that found it already had).
 * `write.failed` is the third outcome: the call did not land, so `write.executed` is never written for
 * that attempt, and the *absence* of one is what tells a later pass — or a person reading the log — that
 * this intent still needs the reconciliation check run again before anything is retried. It is spelled
 * out here, once, so `src/engine/write-executor.ts` (the one file allowed to perform a write) and every
 * reader use the same three strings.
 */
export const WRITE_ATTEMPTED_EVENT_TYPE = 'write.attempted';
export const WRITE_EXECUTED_EVENT_TYPE = 'write.executed';
export const WRITE_FAILED_EVENT_TYPE = 'write.failed';

/**
 * Story 3-2 (AD-27) — what a shadow run's write executor records in place of `write.executed`.
 *
 * `write.attempted` and the read-only probe happen exactly as they do for a live run (AD-15's durability
 * half still holds); this is the "executes" half suppressed, said explicitly rather than left as an
 * absence. It carries the same `intent_id`/`kind`/`target` identity every write line does, plus whether
 * the probe found the target already carrying something different from what this run would have produced
 * — the zero-tolerance case the stage-3 autonomy gate hard-fails on (story 3-3) — and a detail line stating
 * what the probe found and what would have happened.
 */
export const WRITE_SUPPRESSED_EVENT_TYPE = 'write.suppressed';

/** The payload keys every `write.attempted` line carries — the intent, named, before the call. */
export const WRITE_ATTEMPTED_PAYLOAD_KEYS = {
  /** The AD-15 idempotency key with the run id: `{step}.{kind}`, never minted. */
  IntentId: 'intent_id',
  Kind: 'kind',
  Target: 'target',
} as const;

/**
 * The payload keys a `write.executed` line carries: the intent, and enough of the outcome to
 * reconstruct what happened without re-deriving it (a re-run's reconciliation check answers the same
 * question again from the target, never from this line — it exists for a person and a replay, not as
 * an authority the executor reads back).
 */
export const WRITE_EXECUTED_PAYLOAD_KEYS = {
  IntentId: 'intent_id',
  Kind: 'kind',
  Target: 'target',
  /** True when the check found the write already reflected on the target and the call was never made. */
  AlreadyPresent: 'already_present',
  /** One line, short and punctuated, stating what happened. Never a raw commit SHA or URL body. */
  Detail: 'detail',
} as const;

/** The payload keys a `write.failed` line carries: the intent, and the AD-35 error it failed with. */
export const WRITE_FAILED_PAYLOAD_KEYS = {
  IntentId: 'intent_id',
  Kind: 'kind',
  Target: 'target',
  Code: 'code',
  Reason: 'reason',
} as const;

/** The payload keys a `write.suppressed` line carries — story 3-2, AD-27. */
export const WRITE_SUPPRESSED_PAYLOAD_KEYS = {
  IntentId: 'intent_id',
  Kind: 'kind',
  Target: 'target',
  /**
   * True when the probe found the target already carrying something different from what this run would
   * have produced — reusing 2-11's own probe verdict (`git ls-remote`/`gh pr list`/`git notes show`)
   * rather than a second classification axis. False when the target does not yet exist, or exists and
   * already matches.
   */
  Destructive: 'destructive',
  /** One line, short and punctuated: what the probe found, and what would have happened. */
  Detail: 'detail',
} as const;

/**
 * Story 4-1 — AD-12's reversibility gate, said durably rather than only decided in memory.
 *
 * **`write.gate_opened` is what `settlePreMergeWrites` emits in place of calling the write executor**,
 * for the first not-yet-settled intent of a composed commit whose `reversibility` is one of the
 * project's `gated_reversibility_classes` (`PermissionsSchema`, `src/contracts/installer.ts`). One line
 * per gate, never one per intent settled after it opens: `settlePreMergeWrites` checks the run's own
 * `pending_gate` record (never a per-intent `write.gate_approved` lookup — round-1 review's fix, see
 * {@link WRITE_GATE_APPROVED_EVENT_TYPE}'s own docblock) before ever opening a second one.
 *
 * **`batch` discloses the whole remaining batch, not only the intent whose class triggered the check —
 * added in round-1 review.** `settlePreMergeWrites`'s settlement loop has no gate check inside it: once
 * this one gate clears, every intent still unsettled at open time runs in the same pass. The first
 * version's payload named only the triggering intent, understating what one approval actually authorises;
 * `batch` lists every one of them (kind and target each), so a person approving sees the real blast
 * radius.
 *
 * **`write.gate_approved`/`write.gate_rejected` are the only two ways a gate closes, and neither clears it
 * — round-1 review's most serious finding.** Each is recorded by `applyIntent` alongside the
 * `command.applied` line that retires the `approve`/`reject` intent — before it, for the reason
 * `handoff.recorded` is: a crash between the two redelivers the intent rather than losing the resolution.
 * The first version folded either line straight to `pending_gate: null`, which raced the *separate*
 * `feature.state_changed` line the same effect also emits: a crash landing the resolution durably but not
 * the state change left the fold reporting no gate at all while the run was still `blocked` — for a
 * rejection, a later `Command.Approve` would then find nothing to refuse against and silently reverse it.
 * Fixed: these two lines set `resolution: 'approved'`/`'rejected'` on the *existing* `pending_gate` record
 * (`src/contracts/state.ts`'s `PendingGateSchema`); only the `feature.state_changed` line that follows,
 * once it actually lands, clears the record to `null`. Approval carries only the `intent_id`; nothing else
 * about the write changed. Rejection carries the person's own reason text, which
 * `ARGUMENT_REQUIRED_COMMANDS` already guarantees `Command.Reject` never reaches here without
 * (`src/contracts/command.ts`).
 */
export const WRITE_GATE_OPENED_EVENT_TYPE = 'write.gate_opened';
export const WRITE_GATE_APPROVED_EVENT_TYPE = 'write.gate_approved';
export const WRITE_GATE_REJECTED_EVENT_TYPE = 'write.gate_rejected';

/** One entry of a `write.gate_opened` line's `batch` array: enough to disclose the write, never a payload. */
export const WRITE_GATE_BATCH_ENTRY_PAYLOAD_KEYS = {
  IntentId: 'intent_id',
  Kind: 'kind',
  Target: 'target',
} as const;

/** The payload keys a `write.gate_opened` line carries: the intent, its class, and the step it came from. */
export const WRITE_GATE_OPENED_PAYLOAD_KEYS = {
  /** The AD-15 idempotency key of the intent whose `reversibility` triggered the gate. */
  IntentId: 'intent_id',
  Kind: 'kind',
  Target: 'target',
  /** The class that gated it — always one of the project's own `gated_reversibility_classes`. */
  Reversibility: 'reversibility',
  /** The committing step this write's intent belongs to. Never a step that failed: none did. */
  Step: 'step',
  /**
   * Every intent still unsettled when this gate opened, `IntentId`'s own included — the whole remaining
   * batch one approval or rejection covers, each shaped by {@link WRITE_GATE_BATCH_ENTRY_PAYLOAD_KEYS}.
   */
  Batch: 'batch',
} as const;

/** The payload keys a `write.gate_approved` line carries: the intent, and nothing else. */
export const WRITE_GATE_APPROVED_PAYLOAD_KEYS = {
  IntentId: 'intent_id',
} as const;

/** The payload keys a `write.gate_rejected` line carries: the intent, and the person's own reason text. */
export const WRITE_GATE_REJECTED_PAYLOAD_KEYS = {
  IntentId: 'intent_id',
  Reason: 'reason',
} as const;

/**
 * Story 3-2 (AD-27) — the one raw, per-run result a shadow run produces: its resulting worktree tree
 * compared against the real merge commit it was shadowing (`src/engine/shadow.ts`'s `compareShadowRun`).
 * Emitted once, whether the comparison succeeded or failed — a failure to produce it is durably recorded
 * here too, rather than only ever existing as an in-memory return value nobody else can see, matching the
 * `write.*` trio's own discipline of never leaving a fact silently un-logged.
 */
export const SHADOW_COMPARED_EVENT_TYPE = 'shadow.compared';

/** The payload keys a `shadow.compared` line carries. */
export const SHADOW_COMPARED_PAYLOAD_KEYS = {
  /** `'accepted'` or `'material_change'` (`ShadowComparisonOutcome`); absent when the comparison failed. */
  Outcome: 'outcome',
  ShadowTreeRef: 'shadow_tree_ref',
  /** The real, already-merged feature's merge commit this run was shadowing. */
  RealMergeCommit: 'real_merge_commit',
  /**
   * Present only when the comparison itself could not be produced (a `git` read failure) — the run may
   * still have reached `committed`; only the grading of it is missing. Absent on a successful comparison.
   */
  Code: 'code',
  /** One line, short and punctuated. Never the raw diff: AD-23 makes a diff evidence, not control plane. */
  Detail: 'detail',
} as const;

/**
 * Story 3-3 — the trust record's one new durable fact: a merged pull request's head-branch tree versus
 * its merge commit's tree, captured once at merge-detection time by
 * `src/engine/write-executor.ts`'s `mergeFidelityOf` and emitted by the reconciler at the same
 * `awaiting_merge` → `committed` call site that already confirms the merge.
 *
 * Dedicated structured fields rather than a `Detail` free-text line, matching `shadow.compared`'s own
 * `RealMergeCommit` precedent for why a raw commit SHA in a *named* field is fine even though
 * `WRITE_EXECUTED_PAYLOAD_KEYS.Detail`'s own comment forbids one in free text: a replay needs the two
 * oids to reconstruct what was compared, not merely a sentence about it.
 */
export const PULL_REQUEST_MERGE_FIDELITY_EVENT_TYPE = 'pull_request.merge_fidelity';

/** The payload keys a `pull_request.merge_fidelity` line carries. */
export const PULL_REQUEST_MERGE_FIDELITY_PAYLOAD_KEYS = {
  /** `'unchanged'` or `'corrected'`. Absent when the comparison itself could not be made (`Code` instead). */
  Outcome: 'outcome',
  /** The head branch's own final commit, as `gh pr view` reports it even after the branch is merged. */
  HeadRefOid: 'head_ref_oid',
  MergeCommit: 'merge_commit',
  /**
   * Present only when a tree could not be read (`git rev-parse <ref>^{tree}` failed on either ref) —
   * exactly like `SHADOW_COMPARED_PAYLOAD_KEYS.Code`'s own absent-on-success shape. Never guessed as
   * `unchanged`; absent on a successful comparison.
   */
  Code: 'code',
  /** One line, short and punctuated: what the comparison found, or why it could not be made. */
  Detail: 'detail',
} as const;

/**
 * Story 4-3 — a durable note landed against a run: a person's steering colour (`kind: 'note'`), or a
 * person-initiated scope reduction (`kind: 'narrow'`, CAP-16's own person-initiated half). One event
 * type for both, discriminated by `kind`, because the two are the same shape of thing delivered the same
 * way — a scope-narrowing instruction is a note whose *content* asks for less, not a structurally
 * different delivery (see this story's own Design Notes on why `narrow` is not folded into story 2-9's
 * `Degradation` machinery instead).
 *
 * Folded into `RunState.pending_note` (`src/contracts/state.ts`), set here and cleared by the next
 * `step.started` line for the run — the same "set by one event, cleared by a later one" shape story 4-1's
 * `pending_gate` already established. A second `note.injected` before the first is consumed **replaces**
 * it: the fold is a plain assignment, never an append, so only one note is ever pending at a time.
 */
export const NOTE_INJECTED_EVENT_TYPE = 'note.injected';

/** The payload keys a `note.injected` line carries: the free text, and which of the two it is. */
export const NOTE_INJECTED_PAYLOAD_KEYS = {
  Text: 'text',
  Kind: 'kind',
} as const;

/**
 * Story 4-3 — a run was forked into a wholly new, independent run, seeded from this run's own current
 * worktree state. Emitted on the *source* run's own log — never the forked run's — so a person reading
 * the source run's timeline sees that it was forked and where to; the source run's own `FeatureState` and
 * step disposition are untouched, which is why this is not folded into anything (`fork` is not an
 * `IntentEffect`: see `src/engine/steering.ts`'s own docblock for why that shape only ever mutates the
 * *same* run).
 *
 * `IntentId` is carried in addition to the one key this story's own Tasks list names (`forked_run`), for
 * a reason that key alone cannot cover: AD-19's delivery is at-least-once, and forking a run is not an
 * idempotent side effect the way `escapeHatch`/`writeHandoff` are — a naive redelivery would mint and
 * create a *second* new run. Carrying the intent id lets the engine recognise "this exact fork already
 * happened" from the log alone, before ever creating another one, the same way `WRITE_GATE_APPROVED_
 * PAYLOAD_KEYS.IntentId` lets a redelivered approval catch up rather than re-approve.
 */
export const RUN_FORKED_EVENT_TYPE = 'run.forked';

/** The payload keys a `run.forked` line carries. */
export const RUN_FORKED_PAYLOAD_KEYS = {
  /** The new, independent run's own id. */
  ForkedRun: 'forked_run',
  /** The `fork` intent's id, so a redelivery is recognised without creating a second run. */
  IntentId: 'intent_id',
} as const;

/**
 * The declared event vocabulary. Dot-namespaced and past-tense. The vocabulary is open by
 * design: a reader meeting a type absent from this list accepts the envelope and ignores the
 * event, so later stories add types without a breaking change.
 */
export const EVENT_TYPES = [
  'step.started',
  'agent.tool_used',
  'fetch.recorded',
  WRITE_ATTEMPTED_EVENT_TYPE,
  WRITE_EXECUTED_EVENT_TYPE,
  WRITE_FAILED_EVENT_TYPE,
  /** Story 3-2 (AD-27) — a shadow run's write executor records this in place of `write.executed`. */
  WRITE_SUPPRESSED_EVENT_TYPE,
  'permission.denied',
  'redaction.failed',
  BUDGET_DEGRADED_EVENT_TYPE,
  BUDGET_EXHAUSTED_EVENT_TYPE,
  STEP_TIER_DOWNSHIFTED_EVENT_TYPE,
  'question.asked',
  'question.resolved',
  'question.default_taken',
  'question.deflected',
  /**
   * The decision a resolved question left (AD-25, ADR-002 decision 4).
   *
   * Separate from `question.resolved` on purpose: the first says a transition happened, this says a
   * decision was recorded — which is what makes "only a resolved question writes to the decision ledger"
   * observable rather than inferred, because a deflection emits the first kind of line and never this one.
   */
  DECISION_RECORDED_EVENT_TYPE,
  /**
   * The request and the ordered acceptance criteria this run is built against (CAP-2).
   *
   * Story 1-10 found that the criteria reached disk only in a step input file and `state.json`, both of
   * which AD-4 ranks below the log — so the spec echo was the one required surface that could not be
   * reconstructed from `events.jsonl` alone. This type is that gap closed. The later line wins: a second
   * `spec.recorded` for one feature replaces the set rather than adding to it.
   */
  SPEC_RECORDED_EVENT_TYPE,
  /** One criterion amended through `edit_criterion`, so the current text is in the log (CAP-2). */
  SPEC_CRITERION_EDITED_EVENT_TYPE,
  /**
   * The declared file territory, so an overlap is recomputable by replay.
   *
   * The Consistency Conventions serialise features whose declared territories overlap, and until now the
   * territory lived only in the in-memory plan and the AD-9 config snapshot — so a replay could not tell
   * why two features were serialised. See {@link FeatureTerritoryDeclaredPayloadSchema} for the one thing
   * AD-21 does to this payload that a reader has to expect.
   */
  FEATURE_TERRITORY_DECLARED_EVENT_TYPE,
  /**
   * What each deterministic gate did before a verification step was spawned (CAP-13, story 2-6).
   *
   * Three types rather than one carrying an outcome, because `gate.skipped` is the one a person most
   * needs to see: a repository that declares no test command has not passed its tests, and on every
   * surface but this one the two look alike. Declared here — rather than only in the engine's own
   * table — because both renderers read them, and AD-5's ignore-unknown rule would otherwise have a
   * screen quietly drop the line that says a gate did not run.
   */
  GATE_PASSED_EVENT_TYPE,
  GATE_FAILED_EVENT_TYPE,
  GATE_SKIPPED_EVENT_TYPE,
  /** No model-based review was spawned, and why (CAP-13's economics, said out loud). */
  REVIEW_SKIPPED_EVENT_TYPE,
  /** Story 4-2 — a completed verification step's own per-criterion verdicts, read back by a later pass. */
  VERIFICATION_JUDGEMENTS_RECORDED_EVENT_TYPE,
  /** Story 4-2 — the adversarial step was not spawned because a preceding judgement was not `met`. */
  ADVERSARIAL_SKIPPED_EVENT_TYPE,
  /** What the run-start branch-protection assertion concluded, including that it could not be made. */
  BRANCH_PROTECTION_ASSERTED_EVENT_TYPE,
  /** The branch, the three write intents and the note a completed committing step composed (AD-22). */
  COMMIT_COMPOSED_EVENT_TYPE,
  /** Story 3-2 (AD-27) — a shadow run's own tree-comparison result, or that producing one failed. */
  SHADOW_COMPARED_EVENT_TYPE,
  /** Story 3-3 — a confirmed merge's head-branch tree compared against its merge commit's tree. */
  PULL_REQUEST_MERGE_FIDELITY_EVENT_TYPE,
  /** Story 4-1 — AD-12's reversibility gate opened, and the two ways it closes. */
  WRITE_GATE_OPENED_EVENT_TYPE,
  WRITE_GATE_APPROVED_EVENT_TYPE,
  WRITE_GATE_REJECTED_EVENT_TYPE,
  /** Story 4-3 — a durable note or person-initiated narrowing landed against a run. */
  NOTE_INJECTED_EVENT_TYPE,
  /** Story 4-3 — a run was forked into a wholly new, independent run. */
  RUN_FORKED_EVENT_TYPE,
] as const;

export type DeclaredEventType = (typeof EVENT_TYPES)[number];

export const isDeclaredEventType = (type: string): type is DeclaredEventType =>
  (EVENT_TYPES as readonly string[]).includes(type);

/**
 * The AD-5 envelope.
 *
 * - `type` is an open string, not an enum: an unknown type parses (AD-5).
 * - `step` is required but nullable, because run-level events carry no step.
 * - `parent_tool_use_id` and `session_id` are the stream-origin passthrough fields, preserved
 *   verbatim when the event came from a `claude -p` stream.
 * - `baseline_ref` is the AD-26 commit the emitting step's worktree stood at. It is an envelope
 *   field rather than a payload entry because the AD-21 pass redacts an unbroken commit SHA inside
 *   a payload, and a ref the reconciler cannot read back is a ref the log cannot reconstruct a run
 *   from (AD-4). {@link EVENT_ENVELOPE_VERBATIM_FIELDS} names it as one of the identifier fields a
 *   recorder restores verbatim after the pass, each still proven free of every credential class.
 * - The object is loose so unknown keys survive a parse instead of being dropped, which is the
 *   read-side half of "adding a field is never breaking".
 */
export const EventEnvelopeSchema = z.looseObject({
  ts: TimestampSchema,
  seq: z.int(),
  feature: z.string(),
  run: z.string(),
  step: z.string().nullable(),
  emitter: z.string(),
  type: z.string(),
  payload: z.record(z.string(), z.unknown()),
  parent_tool_use_id: z.string().nullable().optional(),
  session_id: z.string().nullable().optional(),
  baseline_ref: z.string().nullable().optional(),
});

export type EventEnvelope = z.infer<typeof EventEnvelopeSchema>;

/** The eight fields AD-5 requires on every line, in their declared order. */
export const EVENT_ENVELOPE_REQUIRED_FIELDS = [
  'ts',
  'seq',
  'feature',
  'run',
  'step',
  'emitter',
  'type',
  'payload',
] as const;

/**
 * The fields a recorder restores verbatim after the AD-21 pass, by field path.
 *
 * The list is as short as it can be, and the reason is the shape of the risk. The pass's entropy
 * heuristic replaces any unbroken high-entropy run, so exactly two of the envelope's identifiers need
 * rescuing from it — a run id and a baseline ref, both of which are high-entropy *by construction* and
 * would otherwise leave the durable truth unable to name its own run or the commit a step began at,
 * against AD-4. Two more, the AD-5 stream-origin fields, must survive verbatim because AD-5 says so.
 *
 * `feature` and `step` are deliberately **not** here. Their legitimate values are punctuated and
 * low-entropy — a kebab-case slug, a dotted declared name — so the pass leaves them untouched and there
 * is nothing to restore. Putting them on the list would have bought nothing and cost everything: their
 * shapes admit any alphanumeric run, so a high-entropy token with no known prefix would satisfy the
 * shape and be written verbatim while the same value in a payload was replaced. A field is on this list
 * only when its *legitimate* values are indistinguishable from secret material and its shape is narrow
 * enough that no secret satisfies it.
 *
 * The allow-list is by *field path*, never by value shape alone: story 1-2 established that a shape
 * exemption is what let a real credential through, so a listed field is restored only when the original
 * is proven free of every credential class the pass recognises *and* is the identifier the field claims
 * to hold. The two stream fields are dropped when the first proof fails, because AD-5 requires them
 * verbatim or not at all; the two identity fields keep the redacted value instead, so a line is still
 * written.
 */
export const EVENT_ENVELOPE_VERBATIM_FIELDS = [
  'run',
  'baseline_ref',
  'parent_tool_use_id',
  'session_id',
] as const;

export type EventEnvelopeVerbatimField = (typeof EVENT_ENVELOPE_VERBATIM_FIELDS)[number];

/**
 * Story 3-3's own review round — the payload-scoped counterpart to {@link EVENT_ENVELOPE_VERBATIM_FIELDS}.
 *
 * `EVENT_ENVELOPE_VERBATIM_FIELDS` only ever restores a *top-level envelope* key by name; it has no
 * mechanism reaching into `payload`, so a commit SHA nested under a payload key — `pull_request.
 * merge_fidelity`'s own `head_ref_oid`/`merge_commit` — was silently destroyed by the AD-21 entropy pass
 * with no rescue at all (a real 40-character hex SHA scores ~3.58 bits/char, above the pass's default
 * 3.5-bit/24-length threshold). This is a second, narrower allow-list rather than a widening of the first,
 * because the two live at different depths in the envelope and `src/runtime/recorder.ts`'s
 * `preservePassthrough` walks the envelope's own top-level keys only.
 *
 * By field *name*, not by event type: both keys are unique to `pull_request.merge_fidelity` today, so no
 * per-event-type scoping is needed, and a later event type reusing either name gets the same rescue for
 * the same reason (a commit SHA is a commit SHA regardless of which line carries it).
 *
 * Story 4-3 adds `forked_run`: `run.forked` carries the new run's own id — an unbroken ULID — in its
 * payload rather than in an envelope field, because `EVENT_ENVELOPE_VERBATIM_FIELDS`'s own `run` field
 * already means *this* line's own run (the source, per every other event type), and `run.forked` is the
 * one line whose payload has to name a *second*, different run. Without this it would be silently
 * destroyed the same way `head_ref_oid`/`merge_commit` were before this list existed.
 *
 * **Story 4-3, round-1 review — a map from field to the *one* shape it is allowed, never a flat list
 * checked against every declared shape.** The first draft of this addition was a plain array, and
 * `src/runtime/recorder.ts`'s `preservePassthroughPayload` checked each entry against *every* shape in
 * {@link EVENT_ENVELOPE_IDENTITY_SHAPES} — which would have let a ULID-shaped value survive redaction
 * under `head_ref_oid`/`merge_commit`, fields that should only ever hold a commit SHA. Still caught by
 * `provesPatternFree` if the value were a real secret, but a genuine loss of the field-specific precision
 * {@link hasEventIdentityShape} already established at the envelope level — extended here to the
 * payload-scoped fields by the same convention, rather than invented separately: each value names the
 * *one* `EVENT_ENVELOPE_IDENTITY_SHAPES` key that field's value must match, and `hasEventIdentityShape`
 * is the one function either level actually tests a value against a shape with.
 */
export const EVENT_PAYLOAD_VERBATIM_FIELDS: Readonly<
  Record<string, keyof typeof EVENT_ENVELOPE_IDENTITY_SHAPES>
> = Object.freeze({
  head_ref_oid: 'baseline_ref',
  merge_commit: 'baseline_ref',
  forked_run: 'run',
});

export type EventPayloadVerbatimField = keyof typeof EVENT_PAYLOAD_VERBATIM_FIELDS;

/**
 * The two AD-5 stream-origin fields, which are verbatim-or-dropped: the pass may not rewrite them,
 * so the only safe alternative to keeping the value is dropping the whole artifact.
 */
export const EVENT_ENVELOPE_STREAM_FIELDS = ['parent_tool_use_id', 'session_id'] as const;

/**
 * The two identity fields, and the shape each must have to be restored verbatim.
 *
 * Being proven free of every credential *class* is not sufficient on its own, and this is the gap the
 * shapes close. The proof deliberately runs with the entropy heuristic switched off — it has to, because
 * that heuristic is what condemns a ULID and a commit SHA in the first place — so without a shape check
 * a high-entropy secret carrying no known prefix would be restored verbatim here while the same value in
 * a payload was replaced.
 *
 * So the gate does not ask "does this look safe?" but "is this the identifier the field claims to hold?".
 * Both shapes are a fixed length over a restricted alphabet, which no credential format satisfies. A
 * value failing its shape keeps whatever the pass produced.
 */
export const EVENT_ENVELOPE_IDENTITY_SHAPES: Readonly<Record<string, RegExp>> = Object.freeze({
  /** A ULID: 26 characters of Crockford base32, the leading one at most `7` (AD-29). */
  run: /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/,
  /** A full commit SHA, which is what an AD-26 baseline ref always is. */
  baseline_ref: /^[0-9a-f]{40}$/,
});

/**
 * Whether a value is the identifier its field claims to hold.
 *
 * A field with no declared shape answers `false`: the allow-list grows by declaring a narrow shape, never
 * by a field appearing in it without one.
 */
export const hasEventIdentityShape = (field: string, value: string): boolean => {
  // Own-property membership only, so a prototype key such as `constructor` cannot resolve to an
  // `Object` member masquerading as a declared shape.
  if (!Object.prototype.hasOwnProperty.call(EVENT_ENVELOPE_IDENTITY_SHAPES, field)) return false;
  return EVENT_ENVELOPE_IDENTITY_SHAPES[field]?.test(value) ?? false;
};

/** Ordering is by `seq`; timestamps carry no ordering authority across processes (AD-29). */
export const compareEventOrder = (a: EventEnvelope, b: EventEnvelope): number => a.seq - b.seq;

/**
 * The key a *repair* carries, so a replay can tell a back-filled declaration from the original one.
 *
 * `recordDeclarations` in `src/engine/reconciler.ts` appends the declarations a crash left the log owing,
 * on a later pass and from the plan as it reads *then*. Nothing else distinguishes that from the line
 * `acceptFeature` writes at the moment the run is accepted — so a run whose plan changed in between would
 * gain a declaration claiming to be what it was accepted against, and a reader reconstructing the run from
 * the log alone would have no way to doubt it. The key is optional and additive, which AD-5 makes
 * non-breaking: an older reader ignores it and a newer one knows not to read a repair as a declaration.
 *
 * Spelled once, here, beside the three schemas that admit it, so the emitter and every reader use the same
 * string.
 */
export const REPAIRED_PAYLOAD_KEY = 'repaired';

/** The optional `repaired` marker the three declaration payloads share. */
const repairedKey = { [REPAIRED_PAYLOAD_KEY]: z.boolean().optional() };

/**
 * The payload of a `spec.recorded` line: the user's words, and the criteria in the order they were stated.
 *
 * Loose rather than closed, for the same reason the envelope is: AD-5 makes adding a key non-breaking, so
 * a key a later build adds must survive this build's parse rather than being stripped by it.
 *
 * **What AD-21 does to this payload, stated because it is the one surprise here.** The criteria are prose
 * and prose survives the entropy sweep — a run of punctuated words never reaches the 24-character unbroken
 * threshold. An *identifier quoted inside* a criterion does not: a genuine ULID carries roughly 4.6 bits
 * per character and a full commit SHA roughly 4.0, both above the sweep's 3.5, so each is replaced by the
 * redaction marker while the sentence around it survives. That is AD-21 working as specified and there is
 * no remedy for it that is not a wider allow-list, which AD-21 forbids: a surface therefore presents such
 * a criterion through `presentValue`, which says `(redacted in the log)` rather than showing a marker as
 * content. `tests/runtime.redaction-survival.test.ts` pins both halves against a real ULID.
 */
export const SpecRecordedPayloadSchema = z.looseObject({
  /** The user's original words, verbatim. */
  [DECLARATION_PAYLOAD_KEYS.Request]: z.string(),
  /** The criteria, in the declared order. Replaced wholesale by a later `spec.recorded`. */
  [DECLARATION_PAYLOAD_KEYS.AcceptanceCriteria]: z.array(z.string()),
  ...repairedKey,
});

export type SpecRecordedPayload = z.infer<typeof SpecRecordedPayloadSchema>;

/**
 * The payload of a `spec.criterion_edited` line.
 *
 * `line` is 1-based, as the spec echo card numbers them, and nullable because Q6 forbids imposing a format
 * on a person: an amendment whose wording names no line is still recorded, with the text it carried, and a
 * reader states it as an edit it could not place rather than discarding it.
 */
export const SpecCriterionEditedPayloadSchema = z.looseObject({
  [DECLARATION_PAYLOAD_KEYS.CriterionLine]: z.int().nullable(),
  /** The amended criterion as the person wrote it, unaltered. */
  [DECLARATION_PAYLOAD_KEYS.CriterionText]: z.string(),
  ...repairedKey,
});

export type SpecCriterionEditedPayload = z.infer<typeof SpecCriterionEditedPayloadSchema>;

/**
 * The payload of a `feature.territory_declared` line.
 *
 * **A long path does not survive AD-21, and the replay must expect that.** A repository path is usually
 * broken by a dot or a hyphen and so splits into runs far below the sweep's 24-character threshold —
 * `src/engine`, `src/runtime/recorder.ts`. A long path with no dot and no hyphen does not: measured,
 * `docs/planning/architecture/spine/decisions/records` is a single 50-character run at 3.78 bits per
 * character and is replaced whole. The replay in `src/engine/territory.ts` therefore reports how many
 * entries it could not read and treats an incomplete territory as colliding with everything, which is the
 * fail-safe direction — a feature serialised unnecessarily costs a pass, and one admitted wrongly costs
 * another feature's work.
 */
export const FeatureTerritoryDeclaredPayloadSchema = z.looseObject({
  /** The normalised declared paths. */
  [DECLARATION_PAYLOAD_KEYS.TerritoryPaths]: z.array(z.string()),
  /**
   * What a *re-declaration* replaced, and how. All four are optional and absent on a first declaration:
   * the run-creation line carries only `paths`, and a reader that ignores these still folds the territory
   * correctly, because `paths` remains the whole of the declaration.
   */
  [DECLARATION_PAYLOAD_KEYS.TerritoryPreviousPaths]: z.array(z.string()).optional(),
  [DECLARATION_PAYLOAD_KEYS.TerritoryAddedPaths]: z.array(z.string()).optional(),
  [DECLARATION_PAYLOAD_KEYS.TerritoryRemovedPaths]: z.array(z.string()).optional(),
  [DECLARATION_PAYLOAD_KEYS.TerritoryWidened]: z.boolean().optional(),
  ...repairedKey,
}).refine(
  (payload) => {
    const widened = payload[DECLARATION_PAYLOAD_KEYS.TerritoryWidened];
    const added = payload[DECLARATION_PAYLOAD_KEYS.TerritoryAddedPaths];
    if (widened === undefined || added === undefined) return true;
    return widened === added.length > 0;
  },
  {
    /**
     * `widened` is a *summary* of `added_paths`, and a payload where the two disagree says two things.
     *
     * The flag is what a reader acts on and the list is what it acts with, so a line claiming
     * `widened: false` beside a non-empty `added_paths` would have a replay conclude that a real widening
     * never happened — the exact failure the keys were added to prevent. Bound here rather than trusted to
     * the emitter, because a payload is read by units that never ran the emitter.
     */
    message:
      'widened is true exactly when added_paths is non-empty; a flag that disagrees with the list it ' +
      'summarises would have a replay read a real widening as none',
    path: [DECLARATION_PAYLOAD_KEYS.TerritoryWidened],
  },
);

export type FeatureTerritoryDeclaredPayload = z.infer<typeof FeatureTerritoryDeclaredPayloadSchema>;
