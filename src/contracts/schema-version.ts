/**
 * AD-28 — every on-disk configuration and state artifact carries a `schema_version`, and an
 * unrecognised version is refused rather than silently upgraded.
 *
 * Forward compatibility for *events* is covered by the AD-5 ignore-unknown-types rule.
 * Configuration and state have no such latitude: a version this build does not recognise is a
 * refusal that names the installer version involved.
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
 * The `schema_version` field itself. Deliberately `z.number()` with an integrality refinement
 * rather than `z.int()`: `z.int()` exports `minimum`/`maximum` bounds, which AD-2 places outside
 * the structured-outputs subset, and this field appears in step contracts.
 */
export const schemaVersionField = z
  .number()
  .refine(Number.isInteger, { message: 'schema_version must be an integer' });

/** Wrap an object shape so the artifact carries `schema_version` as its first field. */
export const versioned = <Shape extends z.ZodRawShape>(
  shape: Shape,
): z.ZodObject<{ schema_version: typeof schemaVersionField } & Shape> =>
  z.object({ schema_version: schemaVersionField, ...shape });

/** Refusal to operate on an artifact whose `schema_version` this build does not recognise. */
export class SchemaVersionRefusal extends Error {
  /**
   * The AD-35 code this refusal crosses a unit boundary as, whose declared disposition is
   * `escalate-to-human`: nothing retries its way out of an artifact this build cannot read.
   *
   * Carried on the class so a caller routing a caught refusal reaches the table rather than the
   * unknown-code fallback, which would report a precisely-diagnosed version problem as an unrecognised
   * internal failure.
   */
  readonly code = 'config.schema_version_unrecognised';
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

/**
 * Parse a versioned artifact: the schema decides shape (a missing `schema_version` is a parse
 * failure naming the field), then the version gate decides whether this build may read it.
 */
export const parseVersionedArtifact = <Schema extends z.ZodType<{ schema_version: number }>>(
  schema: Schema,
  value: unknown,
  artifact: string,
): z.output<Schema> => {
  const parsed = schema.parse(value);
  assertRecognisedSchemaVersion(parsed.schema_version, artifact);
  return parsed;
};
