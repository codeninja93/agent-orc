/**
 * The step-executor port: the boundary between the reconciler's *decisions* and story 1-4's
 * *process handling*.
 *
 * AD-8 describes the reconciler attempting `claude -p --resume`, but spawning is story 1-4's subject.
 * The split this port draws is the one that lets 1-4 arrive without touching the loop:
 *
 * - the **loop** owns every decision — which disposition is resumable, when to reset and re-run, which
 *   rung to run on, when to escalate and when to hand off;
 * - the **executor** owns every process — the spawn, the `--json-schema` argument, the stream parse,
 *   the container wrapper, and the `--resume` invocation — and reports back exactly one thing: how the
 *   step terminated.
 *
 * Nothing in this file spawns, waits on or kills a process. Story 1-3 drives a double; story 1-4
 * supplies the real implementation.
 *
 * Two shapes here are the port's load-bearing decisions, and are worth more review than the loop
 * around them:
 *
 * **A termination is a value, not an exception.** `failed`, `blocked`, `interrupted` and `killed` are
 * all ordinary returns carrying a disposition, because every one of them is a case the AD-35 table has
 * an answer for. Only a *refused resume* throws, and only because it is the one outcome that says
 * nothing about the step at all — it says the port could not attempt what it was asked to.
 *
 * **The session id is reported as soon as it is known, not only at the end.** AD-8 requires the
 * checkpoint to record the `claude` session id "as soon as the subprocess reports it", because a
 * crash after the spawn and before the termination is exactly the case a resume exists for. The port
 * therefore takes an `onSessionId` callback rather than returning the id only on termination.
 */
import type {
  ModelRung,
  OrchError,
  RunMode,
  StepDisposition,
  StepInput,
  StepOutput,
  StepPhase,
  StepUsage,
} from '../contracts/index.js';

/** What the loop hands the executor to start a step. */
export interface StepStartRequest {
  readonly run: string;
  readonly feature: string;
  readonly step: string;
  readonly phase: StepPhase;
  /** The registered contract id the output is re-parsed against (AD-1, AD-17). */
  readonly contractId: string;
  /** The typed input file's contents. A step is a pure function over exactly this (AD-23). */
  readonly input: StepInput;
  /** Where that file was written, so a re-run reads the same bytes (CAP-6). */
  readonly inputPath: string;
  /** AD-26 — the commit the worktree stood at when this attempt began. */
  readonly baselineRef: string;
  /** The worktree the step works in. */
  readonly worktree: string;
  /** The rung this attempt runs on (Stack model rungs). */
  readonly modelTier: ModelRung;
  /** 1 for the first attempt, incrementing for each re-run. */
  readonly attempt: number;
  /** AD-27 — `shadow` suppresses writes in the intent executor and the committer, nothing else. */
  readonly mode: RunMode;
  /**
   * Called the moment the subprocess reports its session id, so the checkpoint records it before the
   * step can be interrupted (AD-8). Called at most once per attempt.
   */
  readonly onSessionId: (sessionId: string) => void;
}

/** What the loop hands the executor to resume an interrupted step. */
export interface StepResumeRequest extends StepStartRequest {
  /** The recorded `claude` session id. Only an `interrupted` disposition reaches here (AD-8). */
  readonly sessionId: string;
}

/**
 * How a step ended.
 *
 * `output` is present only for a `completed` step, and the executor has already re-parsed it against
 * the originating Zod schema (AD-1) — the loop does not accept a `structured_output` the port has not
 * validated. `error` is present for `failed` and `blocked`, and its code is what the AD-35 table is
 * consulted about.
 */
export interface StepTermination {
  readonly step: string;
  readonly disposition: StepDisposition;
  /** The session id the attempt ran under, when one was reported. */
  readonly sessionId: string | null;
  readonly output: StepOutput | null;
  readonly error: OrchError | null;
  /**
   * What the attempt cost and consumed, or `null` when the CLI reported nothing.
   *
   * On the termination rather than only inside the executor because the *loop* is what records events:
   * AD-29 gives the recorder one writer and the reconciler owns `step.terminated`, so usage the spawner
   * parsed has to travel out through the port to reach the log. It is reported for *every* disposition,
   * not only `completed` — a step that failed after twenty turns consumed exactly as much as one that
   * succeeded, and story 2-9's ceilings would under-count a thrashing run if a failure reported nothing.
   */
  readonly usage: StepUsage | null;
}

/**
 * The port story 1-4 implements.
 *
 * Both methods resolve with a termination and reject only for a condition that is not a termination:
 * `start` rejects when the process could not be created at all, `resume` rejects with
 * {@link ResumeRefused} when the recorded session cannot be resumed.
 */
export interface StepExecutor {
  start: (request: StepStartRequest) => Promise<StepTermination>;
  resume: (request: StepResumeRequest) => Promise<StepTermination>;
}

/**
 * The resume could not be attempted: the session is gone, expired, or belongs to a transcript the CLI
 * no longer has.
 *
 * The code is `step.resume_failed`, declared `retry-with-backoff` in the AD-35 table — and the retry
 * it means is specifically AD-8's: reset to the step's `baseline_ref` and re-run from the typed input.
 * The refusal is not a step failure, which is why it is an exception rather than a `failed` disposition
 * carrying this code: a `failed` step has produced something the table should judge, and a refused
 * resume has produced nothing at all.
 */
export class ResumeRefused extends Error {
  readonly code = 'step.resume_failed';
  readonly step: string;
  readonly sessionId: string;

  constructor(step: string, sessionId: string, detail: string) {
    super(
      `The executor refused to resume step "${step}" from session ${sessionId}: ${detail}. ` +
        'AD-8 makes the recovery a reset to the step baseline and a re-run from the typed input, ' +
        'never a second resume against the same id.',
    );
    this.name = 'ResumeRefused';
    this.step = step;
    this.sessionId = sessionId;
  }
}

/** The process could not be created. Distinct from a step that ran and failed. */
export class StepSpawnFailed extends Error {
  readonly code = 'step.spawn_failed';
  readonly step: string;

  constructor(step: string, detail: string) {
    super(`The executor could not start step "${step}": ${detail}.`);
    this.name = 'StepSpawnFailed';
    this.step = step;
  }
}

/** A termination with the fields a caller usually leaves out. */
export const terminated = (
  step: string,
  disposition: StepDisposition,
  extra: {
    readonly sessionId?: string | null;
    readonly output?: StepOutput | null;
    readonly error?: OrchError | null;
    readonly usage?: StepUsage | null;
  } = {},
): StepTermination => ({
  step,
  disposition,
  sessionId: extra.sessionId ?? null,
  output: extra.output ?? null,
  error: extra.error ?? null,
  // Absent means unrecorded, never zero: a double that says nothing about usage must not have the loop
  // record that the step was free (R8).
  usage: extra.usage ?? null,
});

/**
 * An executor that reports a termination the caller supplies, and records every request it received.
 *
 * It lives in the implementation rather than in a test file on purpose. The port's shape is the thing
 * most likely to be wrong — if it is, story 1-4 has to change the reconciler — so the double every
 * suite drives is defined beside the interface it doubles, and a change to one is a compile error in
 * the other rather than a silently stale copy in six test files.
 */
export interface ScriptedExecutorOptions {
  /**
   * The termination for an attempt. Called with the request and the 1-based number of times this step
   * has been started or resumed, so a script can make a step fail once and then succeed.
   */
  readonly onStart: (request: StepStartRequest, attemptOfStep: number) => StepTermination;
  /**
   * The termination for a resume, or a thrown {@link ResumeRefused} to exercise AD-8's fallback.
   * Absent means every resume is refused.
   */
  readonly onResume?: (request: StepResumeRequest, attemptOfStep: number) => StepTermination;
  /** A session id to report through `onSessionId` when a step starts. */
  readonly sessionIdFor?: (request: StepStartRequest) => string | null;
}

export interface ScriptedExecutor extends StepExecutor {
  readonly started: readonly StepStartRequest[];
  readonly resumed: readonly StepResumeRequest[];
}

export const createScriptedExecutor = (options: ScriptedExecutorOptions): ScriptedExecutor => {
  const started: StepStartRequest[] = [];
  const resumed: StepResumeRequest[] = [];
  const counts = new Map<string, number>();
  const count = (step: string): number => {
    const next = (counts.get(step) ?? 0) + 1;
    counts.set(step, next);
    return next;
  };

  return {
    started,
    resumed,
    start: (request: StepStartRequest): Promise<StepTermination> => {
      started.push(request);
      const sessionId = options.sessionIdFor?.(request) ?? null;
      if (sessionId !== null) request.onSessionId(sessionId);
      return Promise.resolve(options.onStart(request, count(request.step)));
    },
    resume: (request: StepResumeRequest): Promise<StepTermination> => {
      resumed.push(request);
      if (options.onResume === undefined) {
        return Promise.reject(
          new ResumeRefused(request.step, request.sessionId, 'this double refuses every resume'),
        );
      }
      try {
        return Promise.resolve(options.onResume(request, count(request.step)));
      } catch (thrown: unknown) {
        return Promise.reject(thrown instanceof Error ? thrown : new Error(String(thrown)));
      }
    },
  };
};
