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

export const isRecognisedSchemaVersion = (schemaVersion: number): boolean =>
  SUPPORTED_SCHEMA_VERSIONS.includes(schemaVersion);

export const schemaVersionRefusalMessage = (artifact: string, schemaVersion: number): string => {
  const writer = installerVersionFor(schemaVersion);
  const provenance =
    writer !== null
      ? `It was written by installer version ${writer}`
      : schemaVersion > CURRENT_SCHEMA_VERSION
        ? `It was written by an installer newer than ${INSTALLER_VERSION}`
        : `It was written by an installer older than ${INSTALLER_VERSION}`;
  return (
    `Refusing ${artifact}: schema_version ${String(schemaVersion)} is not recognised. ` +
    `${provenance}; installer version ${INSTALLER_VERSION} is reading it. ` +
    `This build reads schema_version ${SUPPORTED_SCHEMA_VERSIONS.join(', ')}. ` +
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
export const schemaVersionField = z
  .number()
  .refine(Number.isInteger, { message: 'schema_version must be an integer' })
  .refine((value) => !Number.isInteger(value) || isRecognisedSchemaVersion(value), {
    error: (issue): string =>
      `${SCHEMA_VERSION_UNRECOGNISED_CODE}: ${schemaVersionRefusalMessage(
        UNNAMED_ARTIFACT,
        typeof issue.input === 'number' ? issue.input : Number.NaN,
      )}`,
    params: { code: SCHEMA_VERSION_UNRECOGNISED_CODE },
  });

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
): z.ZodObject<{ schema_version: typeof schemaVersionField } & Shape> =>
  z.object({ schema_version: schemaVersionField, ...shape });

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
export const assertRecognisedSchemaVersion = (schemaVersion: number, artifact: string): void => {
  if (!isRecognisedSchemaVersion(schemaVersion)) {
    throw new SchemaVersionRefusal(
      schemaVersionRefusalMessage(artifact, schemaVersion),
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
 * The schema decides everything, including the version: this adds no gate the field does not already
 * apply. What it adds is the artifact's *name* — `assertRecognisedSchemaVersion` is what produces the
 * typed {@link SchemaVersionRefusal} carrying the artifact, the version and the installer that wrote
 * it, which a caller reporting the problem to a person needs and a Zod issue cannot hold.
 */
export const parseVersionedArtifact = <Schema extends z.ZodType<{ schema_version: number }>>(
  schema: Schema,
  value: unknown,
  artifact: string,
): z.output<Schema> => {
  const parsed = schema.safeParse(value);
  if (parsed.success) {
    /**
     * Unreachable while the field carries the check, and kept anyway.
     *
     * This helper is the gate callers *name* when they mean AD-28, and a gate that held only because
     * another module still had a refinement in it would be lost by one edit somewhere else. Asserting
     * here costs an array lookup and makes this function's contract true on its own terms.
     */
    assertRecognisedSchemaVersion(parsed.data.schema_version, artifact);
    return parsed.data;
  }
  const declared = declaredSchemaVersion(value);
  // Only the version is re-raised as the named refusal. Every other parse failure is a shape problem
  // and is reported as one: dressing a missing field as a version refusal would send a reader to the
  // installer for a fault the installer has nothing to do with.
  if (declared !== null) assertRecognisedSchemaVersion(declared, artifact);
  throw parsed.error;
};
