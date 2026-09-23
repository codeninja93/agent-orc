/**
 * The I/O and edge-case matrix of story 1-1, asserted row by row: the event envelope's
 * forward compatibility (AD-5), the error disposition table's unknown-code fallback (AD-35), the
 * `schema_version` gate (AD-28), the `Command` enum's coverage of every steering control (AD-3),
 * and the question lifecycle's single accepted transition (AD-25).
 */
import { describe, expect, it } from 'vitest';

import {
  ARGUMENT_REQUIRED_COMMANDS,
  BudgetSchema,
  CURRENT_SCHEMA_VERSION,
  Command,
  CommandIntentSchema,
  COMMANDS,
  DISPOSITIONS,
  ERROR_CODES,
  ERROR_DISPOSITIONS,
  EVENT_ENVELOPE_REQUIRED_FIELDS,
  EVENT_TYPES,
  EventEnvelopeSchema,
  OrchErrorSchema,
  PACKAGE_VERSION,
  QuestionDraftSchema,
  QuestionStateSchema,
  SCHEMA_VERSION_UNRECOGNISED_CODE,
  PROFILE_SCHEMA_VERSION,
  ProfileSchema,
  installerVersionFor,
  RunStateSchema,
  SchemaVersionRefusal,
  TimestampSchema,
  commandRequiresArgument,
  compareEventOrder,
  contractIdsOfKind,
  deflectQuestion,
  dispositionFor,
  dispositionForError,
  eventTypeForResolution,
  formatTimestamp,
  getContract,
  isDeclaredEventType,
  isErrorCode,
  isResumable,
  isRetryable,
  makeError,
  parseVersionedArtifact,
  renderCause,
  resolveQuestion,
  schemaVersionRefusalMessage,
  toJsonSchema,
  writesToDecisionLedger,
} from '../src/contracts/index.js';
import type { CommandMap, QuestionState, StepDisposition } from '../src/contracts/index.js';

/**
 * The `code` a Zod issue carries in its `params`, or `undefined`.
 *
 * Narrowed rather than cast: `params` is present only on a custom issue, so reaching for it on the issue
 * union is a claim about which member this is. Written as a guard so the assertion below fails by
 * returning `undefined` rather than by throwing somewhere unrelated.
 */
const paramsCodeOf = (issue: unknown): unknown => {
  if (typeof issue !== 'object' || issue === null || !('params' in issue)) return undefined;
  const params: unknown = issue.params;
  if (typeof params !== 'object' || params === null || !('code' in params)) return undefined;
  return params.code;
};

const validEnvelope = {
  ts: '2026-09-19T12:34:56.789Z',
  seq: 42,
  feature: 'contracts-package',
  run: '01JBQZ8Q0000000000000000AA',
  step: 'implementation',
  emitter: 'engine',
  type: 'step.started',
  payload: { step: 'implementation' },
};

describe('AD-5 — the event envelope', () => {
  it('parses an envelope carrying all eight fields', () => {
    const parsed = EventEnvelopeSchema.parse(validEnvelope);
    for (const field of EVENT_ENVELOPE_REQUIRED_FIELDS) {
      expect(parsed).toHaveProperty(field);
    }
  });

  it('accepts only RFC3339 with milliseconds in UTC', () => {
    expect(TimestampSchema.safeParse('2026-09-19T12:34:56.789Z').success).toBe(true);
    for (const bad of [
      '2026-09-19T12:34:56Z',
      '2026-09-19T12:34:56.789+02:00',
      '2026-09-19 12:34:56.789Z',
      '2026-09-19T12:34:56.789123Z',
      '2026-13-19T12:34:56.789Z',
    ]) {
      expect(TimestampSchema.safeParse(bad).success, bad).toBe(false);
    }
  });

  it('accepts an event type outside the declared vocabulary — adding a type is never breaking', () => {
    const unknown = { ...validEnvelope, type: 'consolidation.compacted' };
    expect(isDeclaredEventType(unknown.type)).toBe(false);
    expect(EventEnvelopeSchema.parse(unknown).type).toBe('consolidation.compacted');
  });

  it('declares a dot-namespaced, past-tense vocabulary', () => {
    for (const type of EVENT_TYPES) {
      expect(type).toMatch(/^[a-z_]+\.[a-z_]+$/);
      expect(isDeclaredEventType(type)).toBe(true);
    }
  });

  it('fails when a required field is missing, naming the field', () => {
    const { emitter: _omitted, ...withoutEmitter } = validEnvelope;
    const result = EventEnvelopeSchema.safeParse(withoutEmitter);
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.path.join('.'))).toContain('emitter');
  });

  it('preserves the stream-origin fields verbatim', () => {
    const streamOrigin = {
      ...validEnvelope,
      emitter: 'step.implementation',
      parent_tool_use_id: 'toolu_01ABCdefGHIjklMNOpqrST',
      session_id: 'cd74ff61-b185-4d5c-b8aa-b4622f7ad3f7',
    };
    const parsed = EventEnvelopeSchema.parse(streamOrigin);
    expect(parsed.parent_tool_use_id).toBe(streamOrigin.parent_tool_use_id);
    expect(parsed.session_id).toBe(streamOrigin.session_id);
  });

  it('keeps unknown keys rather than dropping them', () => {
    const parsed = EventEnvelopeSchema.parse({ ...validEnvelope, usage_tokens: 1234 });
    expect(parsed['usage_tokens']).toBe(1234);
  });

  it('formats a timestamp the schema accepts, to exactly millisecond precision', () => {
    expect(TimestampSchema.safeParse(formatTimestamp()).success).toBe(true);
    expect(formatTimestamp(new Date(Date.UTC(2026, 8, 19, 12, 34, 56, 789)))).toBe(
      '2026-09-19T12:34:56.789Z',
    );
  });

  it('orders by seq, not by timestamp (AD-29)', () => {
    const later = { ...validEnvelope, seq: 7, ts: '2026-09-19T12:00:00.000Z' };
    const earlier = { ...validEnvelope, seq: 3, ts: '2026-09-19T13:00:00.000Z' };
    expect(compareEventOrder(EventEnvelopeSchema.parse(earlier), EventEnvelopeSchema.parse(later))).toBeLessThan(0);
    expect(compareEventOrder(EventEnvelopeSchema.parse(later), EventEnvelopeSchema.parse(later))).toBe(0);
  });
});

describe('AD-35 — every failure code carries a declared disposition', () => {
  it('maps every registered code to exactly one of the four dispositions', () => {
    expect(ERROR_CODES.length).toBeGreaterThan(0);
    for (const code of ERROR_CODES) {
      expect(DISPOSITIONS).toContain(ERROR_DISPOSITIONS[code]);
    }
  });

  it('resolves a registered code to its declared disposition', () => {
    expect(dispositionFor('model.rate_limited')).toBe('retry-with-backoff');
    expect(dispositionFor('step.verification_failed')).toBe('escalate-model-tier');
    expect(dispositionFor('permission.denied')).toBe('escalate-to-human');
    expect(dispositionFor('redaction.failed')).toBe('abandon-and-hand-off');
  });

  it('resolves an unknown code to abandon-and-hand-off, and never retries it', () => {
    const unknown = makeError('gremlin.unheard_of', 'something nobody declared');
    expect(dispositionForError(unknown)).toBe('abandon-and-hand-off');
    expect(unknown.retryable).toBe(false);
    expect(isRetryable('gremlin.unheard_of')).toBe(false);
  });

  it('parses an error whose code is unknown rather than throwing a second failure', () => {
    const parsed = OrchErrorSchema.parse({
      code: 'gremlin.unheard_of',
      message: 'x',
      retryable: false,
      cause: null,
    });
    expect(parsed.code).toBe('gremlin.unheard_of');
  });

  it.each(['constructor', 'toString', '__proto__', 'valueOf', 'hasOwnProperty'])(
    'treats the prototype key %s as an unknown code, not a registered one',
    (key) => {
      expect(isErrorCode(key)).toBe(false);
      expect(dispositionFor(key)).toBe('abandon-and-hand-off');
      expect(DISPOSITIONS).toContain(dispositionFor(key));
      expect(isRetryable(key)).toBe(false);
    },
  );

  it('renders any thrown value as a cause string, never "[object Object]"', () => {
    expect(renderCause(new TypeError('bad input'))).toBe('TypeError: bad input');
    expect(renderCause('plain')).toBe('plain');
    expect(renderCause(null)).toBeNull();
    expect(renderCause(undefined)).toBeNull();
    expect(renderCause({ exit: 1 })).toBe('{"exit":1}');
    expect(renderCause({ exit: 1 })).not.toContain('[object Object]');
  });

  it('derives retryable from the table, so the flag cannot disagree with it', () => {
    for (const code of ERROR_CODES) {
      expect(makeError(code, 'm').retryable).toBe(
        ERROR_DISPOSITIONS[code] === 'retry-with-backoff',
      );
    }
  });

  /**
   * The table is the authority, and the field is on the wire — so the parse *derives* it.
   *
   * `retryable` reaches the system inside a step agent's structured output, where a model writes whatever
   * it believes. A payload whose flag disagrees with the code used to parse cleanly, leaving two answers
   * to one question and a later consumer free to trust the wrong one — which is the drift AD-35 exists to
   * prevent. Asserted across every declared code rather than for a sample, so a code added to the table
   * with the wrong disposition cannot slip through with it.
   *
   * It is *repaired*, not refused, and the difference is the whole point. A refusal here fails the entire
   * `StepOutputSchema.parse` at AD-1's re-parse, which the spawner turns into `step.schema_invalid_output`
   * — `escalate-model-tier` — so one wrong boolean discarded the agent's real code and promoted the model
   * ladder. And the rule could not be *told* to the model: a Zod refinement emits nothing into the
   * exported JSON Schema, which is asserted directly below. The agent's code survives; the one field the
   * table already knows the answer to is overwritten with that answer.
   */
  it('derives retryable from the table when the payload contradicts it, keeping the code', () => {
    for (const code of ERROR_CODES) {
      const contradicting = { ...makeError(code, 'm'), retryable: !isRetryable(code) };
      const result = OrchErrorSchema.safeParse(contradicting);
      expect(result.success, code).toBe(true);
      // The flag is the table's answer, not the payload's...
      expect(result.data?.retryable, code).toBe(isRetryable(code));
      // ...and the code — the part only the agent knows — is untouched.
      expect(result.data?.code, code).toBe(code);
      expect(result.data?.message, code).toBe('m');
    }
  });

  it('accepts every error orchError() builds, unchanged', () => {
    for (const code of ERROR_CODES) {
      const built = makeError(code, 'the message', 'the cause');
      expect(OrchErrorSchema.parse(built), code).toStrictEqual(built);
    }
  });

  it('derives false for an unknown code claiming to be retryable, because unknown is never retried', () => {
    const parsed = OrchErrorSchema.parse({
      code: 'gremlin.unheard_of',
      message: 'x',
      retryable: true,
      cause: null,
    });
    expect(parsed.retryable).toBe(false);
    expect(parsed.code).toBe('gremlin.unheard_of');
  });

  /**
   * The exported contract still says only `{"type": "boolean"}`, and that is the deliberate choice.
   *
   * Asserted rather than assumed, because the whole defect was a rule the model was never told. Draft-7
   * *could* carry it as a `oneOf` of a `const` per declared code, but that would close `code` — which is
   * an open string on purpose, so an unrecognised failure is dispositioned rather than throwing a second
   * failure while handling the first. So the export stays honest about what it is: a boolean the engine
   * decides. If a later story enumerates it, this assertion is what will make that a decision rather than
   * an accident.
   */
  it('exports retryable as a plain boolean, because the engine derives it rather than the model', () => {
    const exported = toJsonSchema(OrchErrorSchema) as {
      properties: { retryable: Record<string, unknown> };
    };
    expect(exported.properties.retryable).toStrictEqual({ type: 'boolean' });
    // The rule is nowhere in the exported text, which is exactly why it may not be a refusal.
    expect(JSON.stringify(exported)).not.toContain('disposition');
  });
});

describe('AD-28 — schema_version', () => {
  const artifact = {
    schema_version: CURRENT_SCHEMA_VERSION,
    intent_id: 'intent-1',
    command: Command.Kill,
    run: '01JBQZ8Q0000000000000000AA',
    feature: 'contracts-package',
    step: 'implementation',
    principal: { kind: 'user', id: 'deep' },
    source: 'tui',
    issued_at: '2026-09-19T12:34:56.789Z',
    argument: null,
  };

  it('accepts an artifact at the current version', () => {
    expect(parseVersionedArtifact(CommandIntentSchema, artifact, 'a command intent').command).toBe(
      Command.Kill,
    );
  });

  it('fails to parse an artifact with no schema_version, naming the field', () => {
    const { schema_version: _omitted, ...withoutVersion } = artifact;
    const result = CommandIntentSchema.safeParse(withoutVersion);
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.path.join('.'))).toContain('schema_version');
  });

  it('refuses a future version, stating the installer versions involved', () => {
    const future = { ...artifact, schema_version: CURRENT_SCHEMA_VERSION + 1 };
    try {
      parseVersionedArtifact(CommandIntentSchema, future, 'a command intent');
      expect.unreachable('a future schema_version must be refused');
    } catch (error) {
      expect(error).toBeInstanceOf(SchemaVersionRefusal);
      const refusal = error as SchemaVersionRefusal;
      expect(refusal.message).toContain('not recognised');
      expect(refusal.message).toMatch(/installer/);
      expect(refusal.message).toContain('Re-run the installer');
      expect(refusal.writtenBy).toBeNull();
    }
  });

  it('rejects a non-integer schema_version', () => {
    expect(CommandIntentSchema.safeParse({ ...artifact, schema_version: 1.5 }).success).toBe(false);
  });

  /**
   * Asserted across the registry rather than against one schema, so a new on-disk artifact that
   * forgets `versioned()` is caught by the check growing to cover it.
   */
  it.each(contractIdsOfKind('artifact'))(
    '%s fails to parse when schema_version is absent',
    (id) => {
      const result = getContract(id).schema.safeParse({});
      expect(result.success).toBe(false);
      expect(result.error?.issues.map((issue) => issue.path.join('.'))).toContain('schema_version');
    },
  );

  /**
   * Matrix 7 — the gate is the schema's, so a bare `.parse()` cannot walk past it.
   *
   * Before this, `parseVersionedArtifact` was the only thing that checked, and every other reader of a
   * versioned artifact holds its schema: `CommandIntentSchema.parse(json)` accepted a version from a
   * future installer and handed back a typed value, which is exactly what AD-28 says must not happen.
   */
  it('refuses an unrecognised version at a bare .parse(), carrying the AD-35 code', () => {
    const future = { ...artifact, schema_version: CURRENT_SCHEMA_VERSION + 1 };
    const result = CommandIntentSchema.safeParse(future);
    expect(result.success).toBe(false);
    const issue = result.error?.issues.find((entry) => entry.path.join('.') === 'schema_version');
    expect(issue).toBeDefined();
    expect(issue?.message).toContain(SCHEMA_VERSION_UNRECOGNISED_CODE);
    expect(issue?.message).toContain('not recognised');
    expect(issue?.message).toContain('Re-run the installer');
    // The code is carried as data as well as in the sentence, so a caller can route it to the table
    // rather than matching on prose.
    expect(paramsCodeOf(issue)).toBe(SCHEMA_VERSION_UNRECOGNISED_CODE);
  });

  /**
   * Matrix 8 — one behaviour, not two. Both entry points refuse, and they refuse for the same reason
   * with the same message; the named refusal adds the artifact's name and the installer that wrote it,
   * which a Zod issue has nowhere to put.
   */
  it('refuses it identically through the named helper, naming the artifact', () => {
    const future = { ...artifact, schema_version: CURRENT_SCHEMA_VERSION + 1 };
    const bare = CommandIntentSchema.safeParse(future);
    let named: SchemaVersionRefusal | null = null;
    try {
      parseVersionedArtifact(CommandIntentSchema, future, 'a command intent');
    } catch (error) {
      named = error instanceof SchemaVersionRefusal ? error : null;
    }
    expect(named).not.toBeNull();
    expect(named?.code).toBe(SCHEMA_VERSION_UNRECOGNISED_CODE);
    expect(named?.artifact).toBe('a command intent');
    expect(named?.schemaVersion).toBe(CURRENT_SCHEMA_VERSION + 1);
    // The same sentence, minus the artifact's name: neither path tells a user something the other does not.
    expect(named?.message).toContain('is not recognised');
    expect(bare.error?.issues[0]?.message).toContain('is not recognised');
    expect(named?.message).toContain(PACKAGE_VERSION);
  });

  it.each(contractIdsOfKind('artifact'))(
    '%s refuses an unrecognised schema_version through its own schema',
    (id) => {
      const result = getContract(id).schema.safeParse({ schema_version: 99 });
      expect(result.success).toBe(false);
      const issue = result.error?.issues.find((entry) => entry.path.join('.') === 'schema_version');
      expect(issue?.message, id).toContain(SCHEMA_VERSION_UNRECOGNISED_CODE);
    },
  );

  /**
   * Story 2-6 made the version **per artifact**, and this is the guard that the split did not weaken
   * the rule it splits.
   *
   * The reason for the split is that one constant answered for every artifact: the profile's shape
   * changed when `mechanics.commands` gained `typecheck`, and advancing a shared number would have
   * refused every `state.json`, every lease and every question outcome written before it — so a run
   * in flight when the installer was upgraded could no longer be read back and AD-8's resume would
   * have had nothing to resume from. What AD-28 requires is that every artifact carries a version and
   * that an unrecognised one is refused, and both still hold for every one of them.
   */
  describe('versions advance per artifact, and none of them stops being checked', () => {
    it.each(contractIdsOfKind('artifact'))('%s refuses a version below its own', (id) => {
      // The direction the profile's bump created: a *lower* version is as unrecognised as a higher
      // one, because this build cannot read the shape that wrote it either way.
      const result = getContract(id).schema.safeParse({ schema_version: 0 });
      expect(result.success, id).toBe(false);
      const issue = result.error?.issues.find((entry) => entry.path.join('.') === 'schema_version');
      expect(issue?.message, id).toContain(SCHEMA_VERSION_UNRECOGNISED_CODE);
    });

    it.each(contractIdsOfKind('artifact'))('%s refuses an artifact carrying no version at all', (id) => {
      const result = getContract(id).schema.safeParse({});
      expect(result.success, id).toBe(false);
      expect(
        result.error?.issues.map((issue) => issue.path.join('.')),
        id,
      ).toContain('schema_version');
    });

    it('advances the profile without refusing an artifact whose shape did not change', () => {
      /**
       * The premise the split rests on, demonstrated rather than asserted.
       *
       * The profile reads only version 2; a `state.json` at version 1 — the version every run in
       * flight carries — still parses. Had the number been shared, the second of these would be a
       * refusal, and the run would be unreadable because a *profile* field was added.
       */
      expect(PROFILE_SCHEMA_VERSION).toBeGreaterThan(CURRENT_SCHEMA_VERSION);
      expect(
        ProfileSchema.safeParse({ schema_version: CURRENT_SCHEMA_VERSION }).error?.issues.some(
          (issue) => issue.path.join('.') === 'schema_version',
        ),
      ).toBe(true);
      expect(
        RunStateSchema.safeParse({ schema_version: CURRENT_SCHEMA_VERSION }).error?.issues.some(
          (issue) => issue.path.join('.') === 'schema_version',
        ),
      ).toBe(false);
    });

    it('names the installer that wrote the profile\u2019s own version (ADR-005)', () => {
      /**
       * A refusal has to be able to say who wrote what it is refusing (AD-28), and once versions
       * advance per artifact a *number* no longer identifies one. Both halves are asserted: the
       * profile's version has a known writer, and the same number carried by an artifact that has
       * never reached it has none — because telling a person their command intent "was written by
       * installer 0.1.0" is a confident false statement about a build that does not exist.
       */
      expect(installerVersionFor(PROFILE_SCHEMA_VERSION)).toBe(PACKAGE_VERSION);
      expect(installerVersionFor(CURRENT_SCHEMA_VERSION)).toBe(PACKAGE_VERSION);

      let fromProfile: SchemaVersionRefusal | null = null;
      try {
        parseVersionedArtifact(ProfileSchema, { schema_version: 99 }, '.orch/profile.toml');
      } catch (error: unknown) {
        fromProfile = error instanceof SchemaVersionRefusal ? error : null;
      }
      expect(fromProfile?.writtenBy).toBeNull();

      let fromIntent: SchemaVersionRefusal | null = null;
      try {
        parseVersionedArtifact(
          CommandIntentSchema,
          { ...artifact, schema_version: PROFILE_SCHEMA_VERSION },
          'a command intent',
        );
      } catch (error: unknown) {
        fromIntent = error instanceof SchemaVersionRefusal ? error : null;
      }
      expect(fromIntent).not.toBeNull();
      expect(fromIntent?.writtenBy).toBeNull();
    });

    it('names the artifact in the refusal a per-artifact policy raises', () => {
      // `parseVersionedArtifact` reads the schema's *own* answer rather than re-checking against a
      // policy it was handed — which is what it did until story 2-6, and why a v1 profile came back
      // as a Zod shape error instead of `config.schema_version_unrecognised`.
      let thrown: unknown = null;
      try {
        parseVersionedArtifact(
          ProfileSchema,
          { schema_version: CURRENT_SCHEMA_VERSION },
          '.orch/profile.toml',
        );
      } catch (error: unknown) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(SchemaVersionRefusal);
      const named = thrown as SchemaVersionRefusal;
      expect(named.code).toBe(SCHEMA_VERSION_UNRECOGNISED_CODE);
      expect(named.artifact).toBe('.orch/profile.toml');
      expect(named.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
      // And the supported list in the message is the *profile's*, not the shared one.
      expect(named.message).toContain(`schema_version ${String(PROFILE_SCHEMA_VERSION)}`);
    });
  });

  it('still accepts a shape problem as a shape problem, not as a version refusal', () => {
    // A missing field must not be dressed up as an unrecognised version: that would send a reader to the
    // installer for a fault the installer has nothing to do with.
    const { intent_id: _omitted, ...withoutIntentId } = artifact;
    let thrown: unknown = null;
    try {
      parseVersionedArtifact(CommandIntentSchema, withoutIntentId, 'a command intent');
    } catch (error) {
      thrown = error;
    }
    expect(thrown).not.toBeNull();
    expect(thrown).not.toBeInstanceOf(SchemaVersionRefusal);
  });

  it('states the direction of an unrecognised version, older as well as newer', () => {
    expect(schemaVersionRefusalMessage('a state file', CURRENT_SCHEMA_VERSION + 1)).toContain(
      'newer than',
    );
    expect(schemaVersionRefusalMessage('a state file', 0)).toContain('older than');
    expect(schemaVersionRefusalMessage('a state file', 0)).not.toContain('newer than');
  });
});

describe('AD-3 — one Command enum covering every steering control', () => {
  it('covers every control named by the interface contract and CAP-5, CAP-15 and CAP-23', () => {
    expect([...COMMANDS].sort()).toStrictEqual(
      [
        'answer',
        'approve',
        'confirm_spec',
        'continue',
        'disengage',
        'edit_criterion',
        'fork',
        'inject_note',
        'just_do_it',
        'kill',
        'narrow',
        'pause',
        'reject',
        'take_over',
      ].sort(),
    );
  });

  it('makes a renderer missing a control a compile error, via a total map', () => {
    const labels: CommandMap<string> = {
      [Command.Answer]: 'Answer',
      [Command.ConfirmSpec]: 'Confirm spec',
      [Command.EditCriterion]: 'Edit criterion',
      [Command.Approve]: 'Approve',
      [Command.Reject]: 'Reject',
      [Command.Continue]: 'Continue',
      [Command.Narrow]: 'Narrow',
      [Command.Pause]: 'Pause',
      [Command.InjectNote]: 'Inject note',
      [Command.Kill]: 'Kill',
      [Command.Fork]: 'Fork',
      [Command.TakeOver]: 'Take over',
      [Command.Disengage]: 'Disengage',
      [Command.JustDoIt]: 'Just do it',
    };
    expect(Object.keys(labels)).toHaveLength(COMMANDS.length);
  });

  /**
   * AD-19's two cross-field rules, which are the intent file's shape rather than a consumer's checking.
   *
   * An intent file is read by the engine, by both renderers and by any later replay, so a rule enforced at
   * one reader is a rule the others do not have. Both of these were previously unchecked anywhere: a
   * `narrow` with no argument was accepted and then silently did nothing, and a timeout's default could be
   * recorded as a person's decision — which the decision ledger then keeps for ever.
   */
  describe('the intent shape refuses what no consumer could act on', () => {
    const anIntent = (overrides: Record<string, unknown>): Record<string, unknown> => ({
      schema_version: CURRENT_SCHEMA_VERSION,
      intent_id: 'intent-1',
      command: Command.Kill,
      run: '01JBQZ8Q0000000000000000AA',
      feature: 'contracts-package',
      step: 'implementation',
      principal: { kind: 'user', id: 'deep' },
      source: 'tui',
      issued_at: '2026-09-19T12:34:56.789Z',
      argument: null,
      ...overrides,
    });

    it.each([...ARGUMENT_REQUIRED_COMMANDS])(
      'refuses a %s intent with no argument, rather than accepting one that does nothing',
      (command) => {
        const result = CommandIntentSchema.safeParse(anIntent({ command, argument: null }));
        expect(result.success).toBe(false);
        expect(result.error?.issues.map((issue) => issue.path.join('.'))).toContain('argument');
      },
    );

    it.each([...ARGUMENT_REQUIRED_COMMANDS])(
      'refuses a %s intent whose argument is only whitespace',
      (command) => {
        expect(CommandIntentSchema.safeParse(anIntent({ command, argument: '   ' })).success).toBe(
          false,
        );
      },
    );

    it.each([Command.Pause, Command.Disengage, Command.Kill, Command.Approve, Command.ConfirmSpec])(
      'accepts a %s intent with no argument, because it means something without text',
      (command) => {
        expect(commandRequiresArgument(command)).toBe(false);
        expect(CommandIntentSchema.safeParse(anIntent({ command, argument: null })).success).toBe(
          true,
        );
      },
    );

    it('accepts the commands that need text once they carry some', () => {
      for (const command of ARGUMENT_REQUIRED_COMMANDS) {
        const parsed = CommandIntentSchema.parse(anIntent({ command, argument: 'the first option' }));
        // The argument reaches the consumer exactly as written: trimming decides, it never rewrites (Q6).
        expect(parsed.argument).toBe('the first option');
      }
    });

    it('refuses a timeout-sourced intent attributed to a user, because a clock is not a person', () => {
      const result = CommandIntentSchema.safeParse(
        anIntent({ source: 'timeout', principal: { kind: 'user', id: 'deep' } }),
      );
      expect(result.success).toBe(false);
      expect(result.error?.issues.map((issue) => issue.path.join('.'))).toContain('principal.kind');
    });

    it('accepts a timeout-sourced intent attributed to the timeout', () => {
      expect(
        CommandIntentSchema.safeParse(
          anIntent({ source: 'timeout', principal: { kind: 'timeout', id: 'question.window' } }),
        ).success,
      ).toBe(true);
    });

    it('leaves every other source free to be a user, which is what they are', () => {
      for (const source of ['tui', 'web', 'cli'] as const) {
        expect(
          CommandIntentSchema.safeParse(
            anIntent({ source, principal: { kind: 'user', id: 'deep' } }),
          ).success,
          source,
        ).toBe(true);
      }
    });

    /**
     * The inverse, which is the dangerous direction and was the one that was accepted.
     *
     * The rule used to be an implication — refuse `source: 'timeout'` with a `user` principal — so it
     * guarded a clock's default wearing a person's name and accepted a person's decision wearing the
     * clock's. That is the harmful one: a human choice laundered into "the system did it automatically",
     * kept for ever by the CAP-18 ledger. The rule is now an equivalence, so both directions are refused.
     */
    it.each(['tui', 'web', 'cli'] as const)(
      'refuses a %s-sourced intent claiming a timeout principal, so a person cannot hide behind the clock',
      (source) => {
        const result = CommandIntentSchema.safeParse(
          anIntent({ source, principal: { kind: 'timeout', id: 'question.window' } }),
        );
        expect(result.success, source).toBe(false);
        expect(result.error?.issues.map((issue) => issue.path.join('.')), source).toContain(
          'principal.kind',
        );
      },
    );

    it.each(['user', 'agent'] as const)(
      'refuses a timeout-sourced intent attributed to a %s principal',
      (kind) => {
        expect(
          CommandIntentSchema.safeParse(
            anIntent({ source: 'timeout', principal: { kind, id: 'whoever' } }),
          ).success,
          kind,
        ).toBe(false);
      },
    );

    it.each(['tui', 'web', 'cli'] as const)(
      'leaves an agent principal free on %s, because only the clock pairing is fixed',
      (source) => {
        expect(
          CommandIntentSchema.safeParse(
            anIntent({ source, principal: { kind: 'agent', id: 'interviewer' } }),
          ).success,
          source,
        ).toBe(true);
      },
    );
  });
});

describe('AD-25 — the question lifecycle is one compare-and-set transition', () => {
  const asked: QuestionState = QuestionStateSchema.parse({
    schema_version: CURRENT_SCHEMA_VERSION,
    question: {
      id: 'q-1',
      feature: 'contracts-package',
      run: '01JBQZ8Q0000000000000000AA',
      step: null,
      prompt: 'Which package manager should the profile name?',
      brief: 'The repository has both a package-lock.json and a pnpm-lock.yaml.',
      options: [
        { id: 'npm', label: 'npm', consequence: 'package-lock.json stays authoritative.' },
        { id: 'pnpm', label: 'pnpm', consequence: 'package-lock.json is deleted.' },
      ],
      escape: { id: 'ask-later', label: 'Decide later', consequence: 'The run pauses.' },
      recommended_option_id: 'npm',
      default_action: 'Take npm and record the decision.',
      default_window_ms: 600000,
      asked_at: '2026-09-19T12:34:56.789Z',
    },
    status: 'asked',
    resolution: null,
    deflection: null,
  });

  const tuiAnswer = {
    resolver: 'tui' as const,
    principal: { kind: 'user' as const, id: 'deep' },
    answer: 'npm, the lockfile is committed',
    option_id: 'npm',
    resolved_at: '2026-09-19T12:35:10.001Z',
  };

  it('accepts the first transition and records its resolver and principal', () => {
    const first = resolveQuestion(asked, tuiAnswer);
    expect(first.accepted).toBe(true);
    expect(first.state.status).toBe('resolved');
    expect(first.state.resolution?.resolver).toBe('tui');
    expect(first.state.resolution?.principal.id).toBe('deep');
    expect(writesToDecisionLedger(first.state)).toBe(true);
  });

  it('refuses every later resolver with an already-resolved result, writing nothing', () => {
    const resolved = resolveQuestion(asked, tuiAnswer).state;
    for (const resolver of ['web', 'timeout_default'] as const) {
      const late = resolveQuestion(resolved, { ...tuiAnswer, resolver });
      expect(late.accepted).toBe(false);
      expect(late.refusal).toContain('already resolved');
      expect(late.state).toStrictEqual(resolved);
    }
  });

  it('reports a timeout default as question.default_taken and any other resolver as question.resolved', () => {
    expect(eventTypeForResolution({ ...tuiAnswer, resolver: 'timeout_default' })).toBe(
      'question.default_taken',
    );
    expect(eventTypeForResolution(tuiAnswer)).toBe('question.resolved');
    expect(EVENT_TYPES).toContain('question.default_taken');
  });

  it('deflects from the repository, history or ledger, and does not write the ledger', () => {
    const deflected = deflectQuestion(asked, {
      source: 'decision_ledger',
      answer: 'npm',
      anchor: 'decision:package-manager',
      deflected_at: '2026-09-19T12:34:57.000Z',
    });
    expect(deflected.accepted).toBe(true);
    expect(deflected.state.status).toBe('deflected');
    expect(writesToDecisionLedger(deflected.state)).toBe(false);
    expect(resolveQuestion(deflected.state, tuiAnswer).accepted).toBe(false);
  });

  it('refuses a resolution naming an option that was never offered', () => {
    const bogus = resolveQuestion(asked, { ...tuiAnswer, option_id: 'yarn' });
    expect(bogus.accepted).toBe(false);
    expect(bogus.refusal).toContain('never offered');
    expect(bogus.state).toStrictEqual(asked);
    expect(resolveQuestion(asked, { ...tuiAnswer, option_id: 'ask-later' }).accepted).toBe(true);
  });

  it('requires a resolved status and a resolution to accompany each other', () => {
    expect(QuestionStateSchema.safeParse({ ...asked, status: 'resolved' }).success).toBe(false);
    expect(
      QuestionStateSchema.safeParse({ ...asked, resolution: tuiAnswer }).success,
    ).toBe(false);
    expect(QuestionStateSchema.safeParse({ ...asked, status: 'deflected' }).success).toBe(false);
  });

  it('requires a recommended option that exists, and unique option ids', () => {
    const card = asked.question;
    expect(QuestionDraftSchema.safeParse({ ...card, recommended_option_id: 'yarn' }).success).toBe(
      false,
    );
    expect(QuestionDraftSchema.safeParse({ ...card, options: [] }).success).toBe(false);
    expect(
      QuestionDraftSchema.safeParse({
        ...card,
        options: [card.options[0], card.options[0]],
      }).success,
    ).toBe(false);
    // The escape is a legitimate recommendation.
    expect(
      QuestionDraftSchema.safeParse({ ...card, recommended_option_id: card.escape.id }).success,
    ).toBe(true);
  });

  it('holds a question to at most three options plus an escape', () => {
    const tooMany = {
      ...asked,
      question: {
        ...asked.question,
        options: ['a', 'b', 'c', 'd'].map((id) => ({ id, label: id, consequence: id })),
      },
    };
    expect(QuestionStateSchema.safeParse(tooMany).success).toBe(false);
  });
});

describe('AD-8 and AD-24 — step dispositions and run ceilings', () => {
  it('treats only the interrupted disposition as resumable', () => {
    expect(isResumable('interrupted')).toBe(true);
    for (const disposition of ['completed', 'blocked', 'failed', 'killed'] as StepDisposition[]) {
      expect(isResumable(disposition), disposition).toBe(false);
    }
  });

  it('rejects a budget that is negative, fractional in steps, or a share above one', () => {
    const budget = {
      steps_remaining: 9,
      wall_clock_ms_remaining: 5400000,
      rate_limit_budget_consumed: 0.18,
    };
    expect(BudgetSchema.safeParse(budget).success).toBe(true);
    expect(BudgetSchema.safeParse({ ...budget, steps_remaining: -3.5 }).success).toBe(false);
    expect(BudgetSchema.safeParse({ ...budget, steps_remaining: 2.5 }).success).toBe(false);
    expect(BudgetSchema.safeParse({ ...budget, wall_clock_ms_remaining: -1 }).success).toBe(false);
    expect(BudgetSchema.safeParse({ ...budget, rate_limit_budget_consumed: 47 }).success).toBe(false);
    expect(BudgetSchema.safeParse({ ...budget, rate_limit_budget_consumed: -0.1 }).success).toBe(
      false,
    );
  });
});
