/**
 * AD-28 — every on-disk configuration and state artifact carries a `schema_version`, and an
 * unrecognised version is refused rather than silently upgraded.
 *
 * Forward compatibility for *events* is covered by the AD-5 ignore-unknown-types rule.
 * Configuration and state have no such latitude: a version this build does not recognise is a
 * refusal that names the installer version involved.
 *
 * The refusal lives in {@link schemaVersionField}, which is to say in the schema itself. A gate that
 * only one helper applies is a gate every other entry point walks past — and every reader of a
 * versioned artifact holds its schema, so `Schema.parse(json)` has to be enough on its own.
 */
import { z } from 'zod';

import { PACKAGE_VERSION } from './node-floor.js';

/** The `schema_version` this build writes. */
export const CURRENT_SCHEMA_VERSION = 1;

/** The versions this build can read. Anything else is refused. */
export const SUPPORTED_SCHEMA_VERSIONS: readonly number[] = [CURRENT_SCHEMA_VERSION];

/**
 * The versions *one* artifact is written at and read at.
 *
 * AD-28 binds every on-disk artifact to carry a `schema_version` and makes an unrecognised one a
 * refusal; it does not say the number advances for all of them at once. Until story 2-6 it did,
 * because one constant answered for every artifact — and that is wrong in a direction that matters:
 * `typecheck` joining `mechanics.commands` is a change to the *profile*, and a global bump would have
 * refused every `state.json`, every lease and every question outcome written before it, so a run in
 * flight when the installer was upgraded could no longer be read back and AD-8's resume would have
 * nothing to resume from. One artifact's shape changing is not every artifact's shape changing.
 *
 * So a version is per artifact, and {@link DEFAULT_SCHEMA_VERSION_POLICY} is what an artifact whose
 * shape has never changed uses. `supported` is a list rather than a maximum because reading two
 * versions is a decision an artifact makes for itself: the profile reads only its current one,
 * because a v1 profile is missing a field CAP-13's gates need and defaulting it silently is exactly
 * what AD-28 exists to stop.
 */
export interface SchemaVersionPolicy {
  /** The version this build writes for the artifact. */
  readonly current: number;
  /** Every version this build reads for it. Anything else is refused. */
  readonly supported: readonly number[];
}

/** What an artifact whose shape this build has never changed is written at and read at. */
export const DEFAULT_SCHEMA_VERSION_POLICY: SchemaVersionPolicy = {
  current: CURRENT_SCHEMA_VERSION,
  supported: SUPPORTED_SCHEMA_VERSIONS,
};

/** The installer version this build reports as the writer of what it produces (AD-12). */
export const INSTALLER_VERSION: string = PACKAGE_VERSION;

/**
 * Provenance: which installer version wrote a given `schema_version`. Entries are appended as
 * versions age, so a refusal can always name the installer responsible for a version it knows of.
 */
export const INSTALLER_VERSION_BY_SCHEMA_VERSION: Readonly<Record<number, string>> = {
  [CURRENT_SCHEMA_VERSION]: INSTALLER_VERSION,
};

/**
 * The AD-35 code an unrecognised version crosses a unit boundary as. Its declared disposition is
 * `escalate-to-human`: nothing retries its way out of an artifact this build cannot read.
 *
 * Named once and carried by both refusal paths — the schema's own check and
 * {@link SchemaVersionRefusal} — so a caller routing either one reaches the table rather than the
 * unknown-code fallback, which would report a precisely-diagnosed version problem as an unrecognised
 * internal failure.
 */
export const SCHEMA_VERSION_UNRECOGNISED_CODE = 'config.schema_version_unrecognised';

/** The installer version known to have written this `schema_version`, or `null` if unknown. */
export const installerVersionFor = (schemaVersion: number): string | null =>
  INSTALLER_VERSION_BY_SCHEMA_VERSION[schemaVersion] ?? null;

export const isRecognisedSchemaVersion = (
  schemaVersion: number,
  policy: SchemaVersionPolicy = DEFAULT_SCHEMA_VERSION_POLICY,
): boolean => policy.supported.includes(schemaVersion);

export const schemaVersionRefusalMessage = (
  artifact: string,
  schemaVersion: number,
  policy: SchemaVersionPolicy = DEFAULT_SCHEMA_VERSION_POLICY,
): string => {
  const writer = installerVersionFor(schemaVersion);
  const provenance =
    writer !== null
      ? `It was written by installer version ${writer}`
      : schemaVersion > policy.current
        ? `It was written by an installer newer than ${INSTALLER_VERSION}`
        : `It was written by an installer older than ${INSTALLER_VERSION}`;
  return (
    `Refusing ${artifact}: schema_version ${String(schemaVersion)} is not recognised. ` +
    `${provenance}; installer version ${INSTALLER_VERSION} is reading it. ` +
    `This build reads schema_version ${policy.supported.join(', ')}. ` +
    `Re-run the installer to migrate; nothing is upgraded implicitly.`
  );
};

/**
 * The artifact name used when the refusal is raised from inside the field.
 *
 * A field-level check knows the value and nothing about the file it came from, so it says so rather
 * than guessing. {@link parseVersionedArtifact} re-raises the identical refusal with the real name for
 * the callers that have one.
 */
const UNNAMED_ARTIFACT = 'this versioned artifact';

/**
 * The `schema_version` field itself.
 *
 * Deliberately `z.number()` with an integrality refinement rather than `z.int()`: `z.int()` exports
 * `minimum`/`maximum` bounds, which AD-2 places outside the structured-outputs subset, and this field
 * appears in step contracts.
 *
 * **The recognition check is part of the field, not of a helper the caller may skip.** A version this
 * build does not recognise is a refusal whichever entry point reached the artifact, and the message
 * and the `config.schema_version_unrecognised` code are the same ones the named refusal carries — so
 * there is one behaviour, not two. The integrality check is repeated inside the second refinement
 * because Zod runs both: `1.5` would otherwise be reported twice, once for each reason.
 */
export const schemaVersionFieldFor = (
  policy: SchemaVersionPolicy = DEFAULT_SCHEMA_VERSION_POLICY,
): z.ZodNumber =>
  z
    .number()
    .refine(Number.isInteger, { message: 'schema_version must be an integer' })
    .refine((value) => !Number.isInteger(value) || isRecognisedSchemaVersion(value, policy), {
      error: (issue): string =>
        `${SCHEMA_VERSION_UNRECOGNISED_CODE}: ${schemaVersionRefusalMessage(
          UNNAMED_ARTIFACT,
          typeof issue.input === 'number' ? issue.input : Number.NaN,
          policy,
        )}`,
      params: { code: SCHEMA_VERSION_UNRECOGNISED_CODE },
    });

/** The field for an artifact whose shape this build has never changed. */
export const schemaVersionField = schemaVersionFieldFor();

/**
 * Wrap an object shape so the artifact carries `schema_version` as its first field.
 *
 * **The recognition check is invisible to a model, and that is acceptable here in a way it was not for
 * `retryable`.** {@link schemaVersionField}'s check is a Zod refinement, and a refinement emits nothing
 * into the JSON Schema `z.toJSONSchema` exports — so a step contract wrapped in `versioned()` carries
 * `schema_version` to `claude -p --json-schema` as a bare `{"type": "number"}` with no hint that only
 * certain values are read. The one step contract that is wrapped is `StepInputSchema`, and it is the
 * *engine* that writes that file and the step agent that reads it: no model is ever asked to produce a
 * `schema_version`, so there is no model to mislead and no artifact for a model to fail at AD-1's
 * re-parse. `StepOutputSchema` — the one a model does produce — deliberately carries no
 * `schema_version` at all, which its own docblock says and which is the reason this stays true.
 *
 * A later story adding `versioned()` to a model-produced contract would change that, and would have to
 * answer the question `src/contracts/error.ts` answers for `retryable`: a rule a model cannot see must
 * be repaired on ingest, not used to reject the artifact carrying it.
 */
export const versioned = <Shape extends z.ZodRawShape>(
  shape: Shape,
  policy: SchemaVersionPolicy = DEFAULT_SCHEMA_VERSION_POLICY,
): z.ZodObject<{ schema_version: z.ZodNumber } & Shape> =>
  z.object({ schema_version: schemaVersionFieldFor(policy), ...shape });

/** Refusal to operate on an artifact whose `schema_version` this build does not recognise. */
export class SchemaVersionRefusal extends Error {
  readonly code = SCHEMA_VERSION_UNRECOGNISED_CODE;
  readonly artifact: string;
  readonly schemaVersion: number;
  readonly writtenBy: string | null;

  constructor(message: string, artifact: string, schemaVersion: number, writtenBy: string | null) {
    super(message);
    this.name = 'SchemaVersionRefusal';
    this.artifact = artifact;
    this.schemaVersion = schemaVersion;
    this.writtenBy = writtenBy;
  }
}

/** Throw a {@link SchemaVersionRefusal} unless the version is one this build reads. */
export const assertRecognisedSchemaVersion = (
  schemaVersion: number,
  artifact: string,
  policy: SchemaVersionPolicy = DEFAULT_SCHEMA_VERSION_POLICY,
): void => {
  if (!isRecognisedSchemaVersion(schemaVersion, policy)) {
    throw new SchemaVersionRefusal(
      schemaVersionRefusalMessage(artifact, schemaVersion, policy),
      artifact,
      schemaVersion,
      installerVersionFor(schemaVersion),
    );
  }
};

/** The `schema_version` a candidate artifact declares, or `null` when it declares no number. */
const declaredSchemaVersion = (value: unknown): number | null => {
  if (typeof value !== 'object' || value === null) return null;
  const declared = (value as Record<string, unknown>)['schema_version'];
  return typeof declared === 'number' && Number.isInteger(declared) ? declared : null;
};

/**
 * Parse a versioned artifact, naming it in the refusal.
 *
 * **The schema decides, and this reads its answer rather than asking the question again.** Every
 * versioned artifact's `schema_version` field carries its own {@link SchemaVersionPolicy} — the
 * profile's is ahead of the rest since story 2-6 — so a helper that re-checked the version against a
 * policy *it* was given would be a second authority, and the two would disagree for exactly the
 * artifact whose version had moved. That is not hypothetical: it is the shape of the bug this
 * function had the moment the profile's version advanced, reporting a v1 profile as a Zod shape
 * error rather than as `config.schema_version_unrecognised`.
 *
 * What it adds is the artifact's *name*. The field-level refusal cannot know which file it came
 * from, so it says `this versioned artifact`; here the real name is substituted into the same
 * message, and the typed {@link SchemaVersionRefusal} carries the artifact, the version and the
 * installer that wrote it — which a caller reporting the problem to a person needs and a Zod issue
 * cannot hold.
 */
export const parseVersionedArtifact = <Schema extends z.ZodType<{ schema_version: number }>>(
  schema: Schema,
  value: unknown,
  artifact: string,
): z.output<Schema> => {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  const versionIssue = parsed.error.issues.find(
    (issue) =>
      issue.path.length === 1 &&
      issue.path[0] === 'schema_version' &&
      issue.message.startsWith(`${SCHEMA_VERSION_UNRECOGNISED_CODE}: `),
  );
  // Only the version is re-raised as the named refusal. Every other parse failure is a shape problem
  // and is reported as one: dressing a missing field as a version refusal would send a reader to the
  // installer for a fault the installer has nothing to do with.
  if (versionIssue !== undefined) {
    const declared = declaredSchemaVersion(value);
    throw new SchemaVersionRefusal(
      versionIssue.message
        .slice(`${SCHEMA_VERSION_UNRECOGNISED_CODE}: `.length)
        .replace(`Refusing ${UNNAMED_ARTIFACT}:`, `Refusing ${artifact}:`),
      artifact,
      declared ?? Number.NaN,
      declared === null ? null : installerVersionFor(declared),
    );
  }
  throw parsed.error;
};
