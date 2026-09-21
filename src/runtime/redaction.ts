/**
 * AD-21 — redaction before append, failing closed.
 *
 * This pass sits on the boundary between a producer and the log. AD-13 records every external read
 * and AD-4 makes every appended line immutable, so the two compose into a permanent, un-redactable
 * leak unless the secret is removed *before* the append. There is no after-the-fact remedy.
 *
 * Failing closed means the pass never returns a partially-redacted value and never explains itself
 * with a fragment of what it was looking at: a failure carries a fixed reason and a value-free
 * cause, and the caller drops the artifact (see `recorder.ts`).
 *
 * The covered classes are the five AD-21 names: known token prefixes, high-entropy strings,
 * env-file contents, private-key headers, and the literal values of injected credentials.
 */

/** What replaces a secret. Deliberately one fixed string, carrying no length or hash of what it replaced. */
export const REDACTION_MARKER = '[redacted]';

/** The five AD-21 classes, plus the structural guards that force a drop. */
export const REDACTION_CLASSES = [
  'registered-secret',
  'token-prefix',
  'private-key',
  'url-credential',
  'env-file',
  'high-entropy',
] as const;

export type RedactionClass = (typeof REDACTION_CLASSES)[number];

/** Why a pass failed. Every reason is a constant: none is built from the value being redacted. */
export const REDACTION_FAILURE_REASONS = [
  'redactor-threw',
  'passthrough-carries-secret',
  'depth-exceeded',
  'size-exceeded',
  'cycle-detected',
  'unsupported-value',
  'unserialisable-value',
  'secret-survived-serialisation',
] as const;

export type RedactionFailureReason = (typeof REDACTION_FAILURE_REASONS)[number];

/** A credential injected into a tool server, registered so its literal value can never be logged. */
export interface RegisteredSecret {
  /** A name safe to log — the credential's role, never its value. */
  readonly name: string;
  readonly value: string;
}

/** What was replaced, counted by class. Counts only: a path could itself be a secret. */
export interface RedactionFinding {
  readonly kind: RedactionClass;
  readonly count: number;
}

export interface RedactionSuccess<T> {
  readonly ok: true;
  readonly value: T;
  readonly findings: readonly RedactionFinding[];
}

export interface RedactionFailure {
  readonly ok: false;
  readonly reason: RedactionFailureReason;
  /** A value-free description of the cause: a thrown value's class name, never its message. */
  readonly cause: string;
}

export type RedactionResult<T> = RedactionSuccess<T> | RedactionFailure;

export interface RedactionPolicy {
  /** Literal credential values. Matched first, whole, and case-sensitively. */
  readonly secrets?: readonly (string | RegisteredSecret)[];
  /** Shortest run of token characters the high-entropy rule will consider. */
  readonly highEntropyMinLength?: number;
  /** Shannon entropy per character at or above which a candidate run is treated as a secret. */
  readonly highEntropyMinBits?: number;
  /** Maximum nesting the walk will follow before failing closed. */
  readonly maxDepth?: number;
  /** Maximum serialised size, in characters, the pass will accept before failing closed. */
  readonly maxSerialisedChars?: number;
}

/**
 * The shortest token run the high-entropy rule considers when a policy names no length of its own.
 *
 * Exported because a second unit has to reason about it rather than guess it: `isLoggableIntentId`
 * refuses an intent id whose token runs could reach this length, and the exactly-once key depends on
 * that refusal being computed from the *same* number this pass uses. A literal `23` beside it was a
 * second spelling of this threshold, and the two would have drifted the day a policy changed it.
 */
export const DEFAULT_HIGH_ENTROPY_MIN_LENGTH = 24;
const DEFAULT_HIGH_ENTROPY_MIN_BITS = 3.5;
const DEFAULT_MAX_DEPTH = 64;
const DEFAULT_MAX_SERIALISED_CHARS = 16 * 1024 * 1024;

/**
 * Known token prefixes. Each is anchored to the prefix and consumes the token body, so the marker
 * replaces the whole credential rather than leaving a usable tail behind.
 */
export const TOKEN_PREFIX_PATTERN =
  /\b(?:sk-ant-[A-Za-z0-9_-]{8,}|sk-[A-Za-z0-9_-]{16,}|sk_(?:live|test)_[A-Za-z0-9]{8,}|rk_(?:live|test)_[A-Za-z0-9]{8,}|gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{8,}|xox[abprs]-[A-Za-z0-9-]{8,}|AKIA[0-9A-Z]{12,}|ASIA[0-9A-Z]{12,}|AIza[A-Za-z0-9_-]{30,}|ya29\.[A-Za-z0-9_-]{20,}|npm_[A-Za-z0-9]{30,}|dop_v1_[A-Za-z0-9]{32,}|shp(?:at|ss|ca|pa)_[A-Za-z0-9]{16,}|hf_[A-Za-z0-9]{16,}|figd_[A-Za-z0-9_-]{16,}|SG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})/g;

/**
 * A PEM private key, header to footer. An unterminated header is treated as running to the end of
 * the string: a truncated key is still key material, and leaving the tail would leak most of it.
 */
export const PRIVATE_KEY_BLOCK_PATTERN =
  /-----BEGIN (?:[A-Z0-9 ]*)PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END (?:[A-Z0-9 ]*)PRIVATE KEY(?: BLOCK)?-----|$)/g;

/**
 * A credential in a URL's userinfo: `scheme://user:password@host`. The password is replaced and the
 * user and host are kept, so the connection stays identifiable without carrying the secret.
 */
export const URL_USERINFO_PATTERN = /([a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^\s:@/]+:)([^\s@/]+)(@)/g;

/** `KEY=value`, optionally `export`-prefixed, as a `.env` file writes it. */
const ENV_ASSIGNMENT_LINE = /^(\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*)(.*)$/;

/** Key names whose value is a credential by convention, so a single such line is env-file content. */
const SECRET_ENV_KEY =
  /(?:TOKEN|SECRET|PASSWORD|PASSWD|PASS|CREDENTIAL|PRIVATE|APIKEY|API_KEY|ACCESS_KEY|AUTH|SESSION|COOKIE|BEARER|SIGNATURE|SIGNING|SALT|DSN|CONNECTION_STRING|WEBHOOK)/i;

/**
 * Runs the high-entropy rule considers: unbroken alphanumerics, plus the `+/=` of base64.
 *
 * Separators are deliberately excluded, and that exclusion is the whole discriminator. A secret is
 * one unbroken run of symbols; an identifier is punctuated — `feature/runtime-recorder`, a UUID's
 * hyphen groups, `toolu_01A09q…`, `2026-09-19T12:34:56.789Z` — so it splits into pieces below the
 * length threshold and survives on its own shape rather than on a by-name exemption. There is no
 * exemption list: a ULID or a commit SHA appearing unbroken *inside a payload* is redacted, which is
 * the fail-safe direction. The two fields AD-5 requires verbatim are handled by name by the
 * recorder, not by this rule.
 */
const HIGH_ENTROPY_CANDIDATE = /[A-Za-z0-9+/=]{8,}/g;

/** Failure is a value, not an exception: the caller must handle the drop. */
const failure = (reason: RedactionFailureReason, cause: string): RedactionFailure => ({
  ok: false,
  reason,
  cause,
});

/** Normalise the registered secrets: named or bare, blank values dropped, longest first. */
const normaliseSecrets = (
  declared: readonly (string | RegisteredSecret)[] | undefined,
): readonly RegisteredSecret[] =>
  (declared ?? [])
    .map((entry) => (typeof entry === 'string' ? { name: 'an injected credential', value: entry } : entry))
    .filter((entry) => entry.value !== '')
    .slice()
    .sort((a, b) => b.value.length - a.value.length);

/** Shannon entropy in bits per character. */
export const shannonEntropyBitsPerChar = (value: string): number => {
  if (value === '') return 0;
  const counts = new Map<string, number>();
  for (const char of value) counts.set(char, (counts.get(char) ?? 0) + 1);
  let bits = 0;
  for (const count of counts.values()) {
    const p = count / value.length;
    bits -= p * Math.log2(p);
  }
  return bits;
};

/**
 * A candidate run is high-entropy secret material when it is long enough and carries enough entropy
 * per character. Nothing else: no mixed-case requirement and no hexadecimal exemption, both of which
 * left whole families of real keys — a hex HMAC secret, a hex digest, a single-case token — unredacted.
 */
export const isHighEntropySecret = (
  candidate: string,
  minLength: number,
  minBits: number,
): boolean =>
  candidate.length >= minLength && shannonEntropyBitsPerChar(candidate) >= minBits;

interface StringPass {
  readonly value: string;
  readonly counts: Map<RedactionClass, number>;
}

/** Count a replacement without recording where it happened. */
const bump = (counts: Map<RedactionClass, number>, kind: RedactionClass, by = 1): void => {
  if (by > 0) counts.set(kind, (counts.get(kind) ?? 0) + by);
};

/** Redact the values of a `.env`-style assignment, keeping the key so the shape stays readable. */
const redactEnvAssignments = (value: string, counts: Map<RedactionClass, number>): string => {
  if (!value.includes('=')) return value;
  const lines = value.split('\n');
  const assignments = lines.filter((line) => ENV_ASSIGNMENT_LINE.test(line));
  if (assignments.length === 0) return value;
  const meaningful = lines.filter((line) => line.trim() !== '' && !line.trim().startsWith('#'));
  /** Either the whole string reads as an env file, or an individual key names a credential. */
  const wholeFileIsEnv = assignments.length >= 2 && assignments.length === meaningful.length;
  let replaced = 0;
  const out = lines.map((line) => {
    const match = ENV_ASSIGNMENT_LINE.exec(line);
    if (match === null) return line;
    const [, prefix = '', key = '', body = ''] = match;
    if (body.trim() === '') return line;
    if (!wholeFileIsEnv && !SECRET_ENV_KEY.test(key)) return line;
    replaced += 1;
    return `${prefix}${REDACTION_MARKER}`;
  });
  bump(counts, 'env-file', replaced);
  return replaced === 0 ? value : out.join('\n');
};

/**
 * The string pass, in order: registered literals first (they are known certainties), then private
 * keys, then known token prefixes, then env-file assignments, then the high-entropy sweep over
 * whatever is left.
 */
const redactString = (
  input: string,
  secrets: readonly RegisteredSecret[],
  minLength: number,
  minBits: number,
): StringPass => {
  const counts = new Map<RedactionClass, number>();
  let value = input;

  for (const secret of secrets) {
    if (!value.includes(secret.value)) continue;
    let occurrences = 0;
    let at = value.indexOf(secret.value);
    while (at !== -1) {
      occurrences += 1;
      at = value.indexOf(secret.value, at + secret.value.length);
    }
    value = value.split(secret.value).join(REDACTION_MARKER);
    bump(counts, 'registered-secret', occurrences);
  }

  value = value.replace(PRIVATE_KEY_BLOCK_PATTERN, () => {
    bump(counts, 'private-key');
    return REDACTION_MARKER;
  });

  value = value.replace(TOKEN_PREFIX_PATTERN, () => {
    bump(counts, 'token-prefix');
    return REDACTION_MARKER;
  });

  value = value.replace(URL_USERINFO_PATTERN, (_match, before: string, _password, after: string) => {
    bump(counts, 'url-credential');
    return `${before}${REDACTION_MARKER}${after}`;
  });

  value = redactEnvAssignments(value, counts);

  value = value.replace(HIGH_ENTROPY_CANDIDATE, (candidate) => {
    if (!isHighEntropySecret(candidate, minLength, minBits)) return candidate;
    bump(counts, 'high-entropy');
    return REDACTION_MARKER;
  });

  return { value, counts };
};

/** Merge per-string counts into the pass-wide findings. */
const mergeCounts = (
  into: Map<RedactionClass, number>,
  from: Map<RedactionClass, number>,
): void => {
  for (const [kind, count] of from) bump(into, kind, count);
};

/**
 * A plain JSON object, and nothing else. A wrapper such as `new String(secret)` walks as an object
 * whose enumerable properties are the secret's characters in order: redacting each character
 * individually leaves the value trivially reconstructable, so an exotic prototype is a failure
 * rather than something to inspect.
 */
const isPlainRecord = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

/**
 * Serialise a redacted value and prove the literal secrets are absent from the text.
 *
 * The structural walk can only redact what it recognises as a string; this last gate is what makes
 * the guarantee about the *bytes that reach disk* rather than about the walk's own thoroughness.
 */
const serialiseAndProve = (
  value: unknown,
  secrets: readonly RegisteredSecret[],
  maxChars: number,
): RedactionResult<string> => {
  let serialised: string;
  try {
    const text = JSON.stringify(value);
    if (typeof text !== 'string') {
      return failure('unserialisable-value', 'JSON.stringify produced no output');
    }
    serialised = text;
  } catch (thrown: unknown) {
    return failure('unserialisable-value', describeThrown(thrown, secrets));
  }
  if (serialised.length > maxChars) {
    return failure('size-exceeded', 'the serialised artifact is larger than the accepted maximum');
  }
  for (const secret of secrets) {
    if (serialised.includes(secret.value)) {
      return failure(
        'secret-survived-serialisation',
        'a registered credential was still present after the pass',
      );
    }
  }
  return { ok: true, value: serialised, findings: [] };
};

/**
 * Describe a thrown value without quoting it. A message can carry the very secret the pass was
 * removing, so only the class name is reported, and even that is refused if it contains a
 * registered literal.
 */
export const describeThrown = (
  thrown: unknown,
  secrets: readonly RegisteredSecret[] = [],
): string => {
  let described: string;
  try {
    described =
      thrown instanceof Error
        ? `a thrown ${thrown.constructor.name}`
        : `a thrown ${typeof thrown} value`;
  } catch {
    return 'a thrown value that could not be described';
  }
  for (const secret of secrets) {
    if (secret.value !== '' && described.includes(secret.value)) {
      return 'a thrown value that could not be described';
    }
  }
  return described;
};

const findingsFrom = (counts: Map<RedactionClass, number>): readonly RedactionFinding[] =>
  REDACTION_CLASSES.filter((kind) => (counts.get(kind) ?? 0) > 0).map((kind) => ({
    kind,
    count: counts.get(kind) ?? 0,
  }));

/**
 * Run the pass over an arbitrary JSON value.
 *
 * Object keys are redacted as well as values: a map keyed by a credential would otherwise carry the
 * secret in a field name. A cycle, a value no JSON can represent, or nesting past the depth limit is
 * a failure rather than a best effort, because a partially-redacted artifact is exactly what AD-21
 * forbids.
 */
export const redactValue = <T = unknown>(
  input: T,
  policy: RedactionPolicy = {},
): RedactionResult<T> => {
  const secrets = normaliseSecrets(policy.secrets);
  const minLength = policy.highEntropyMinLength ?? DEFAULT_HIGH_ENTROPY_MIN_LENGTH;
  const minBits = policy.highEntropyMinBits ?? DEFAULT_HIGH_ENTROPY_MIN_BITS;
  const maxDepth = policy.maxDepth ?? DEFAULT_MAX_DEPTH;
  const maxChars = policy.maxSerialisedChars ?? DEFAULT_MAX_SERIALISED_CHARS;

  const counts = new Map<RedactionClass, number>();
  const seen = new Set<object>();

  const walk = (node: unknown, depth: number): unknown => {
    if (depth > maxDepth) throw new RedactionWalkError('depth-exceeded');
    if (node === null) return null;
    switch (typeof node) {
      case 'string': {
        const pass = redactString(node, secrets, minLength, minBits);
        mergeCounts(counts, pass.counts);
        return pass.value;
      }
      case 'number':
        return Number.isFinite(node) ? node : null;
      case 'boolean':
        return node;
      case 'undefined':
        return undefined;
      case 'object': {
        if (seen.has(node)) throw new RedactionWalkError('cycle-detected');
        seen.add(node);
        try {
          if (Array.isArray(node)) return node.map((child) => walk(child, depth + 1));
          if (!isPlainRecord(node)) throw new RedactionWalkError('unsupported-value');
          const out: Record<string, unknown> = {};
          for (const [key, child] of Object.entries(node)) {
            const keyPass = redactString(key, secrets, minLength, minBits);
            mergeCounts(counts, keyPass.counts);
            out[keyPass.value] = walk(child, depth + 1);
          }
          return out;
        } finally {
          seen.delete(node);
        }
      }
      default:
        // bigint, function and symbol cannot be serialised, and their text may carry a secret.
        throw new RedactionWalkError('unsupported-value');
    }
  };

  let redacted: unknown;
  try {
    redacted = walk(input, 0);
  } catch (thrown: unknown) {
    if (thrown instanceof RedactionWalkError) {
      return failure(thrown.reason, thrown.detail);
    }
    return failure('redactor-threw', describeThrown(thrown, secrets));
  }

  const proof = serialiseAndProve(redacted, secrets, maxChars);
  if (!proof.ok) return proof;

  return { ok: true, value: redacted as T, findings: findingsFrom(counts) };
};

/** An internal signal carrying a constant reason; never surfaced to a caller as an exception. */
class RedactionWalkError extends Error {
  readonly reason: RedactionFailureReason;
  readonly detail: string;

  constructor(reason: RedactionFailureReason) {
    super(reason);
    this.name = 'RedactionWalkError';
    this.reason = reason;
    this.detail = WALK_FAILURE_DETAIL[reason];
  }
}

const WALK_FAILURE_DETAIL: Readonly<Record<RedactionFailureReason, string>> = {
  'redactor-threw': 'the redaction pass threw',
  'passthrough-carries-secret': 'a stream passthrough field carried a registered credential',
  'depth-exceeded': 'the artifact nests deeper than the pass will follow',
  'size-exceeded': 'the serialised artifact is larger than the accepted maximum',
  'cycle-detected': 'the artifact contains a cycle, so it cannot be fully inspected',
  'unsupported-value': 'the artifact holds a value JSON cannot represent',
  'unserialisable-value': 'the artifact could not be serialised',
  'secret-survived-serialisation': 'a registered credential was still present after the pass',
};

/**
 * Both forms a literal can take in a serialised line: as written, and as JSON escapes it. A secret
 * carrying a quote, a backslash or a control character appears on disk only in the escaped form, so
 * checking the raw form alone would make the last gate a no-op for exactly those values.
 */
const serialisedForms = (secret: string): readonly string[] => {
  const escaped = JSON.stringify(secret).slice(1, -1);
  return escaped === secret ? [secret] : [secret, escaped];
};

/** A redactor bound to one policy, so the recorder and the fetch record share one pass. */
export interface Redactor {
  readonly policy: RedactionPolicy;
  readonly secrets: readonly RegisteredSecret[];
  redact: <T>(value: T) => RedactionResult<T>;
  /** Prove a serialised line carries no registered literal, as the last gate before an append. */
  provesFree: (serialised: string) => boolean;
  /**
   * Prove a value that must survive *verbatim* carries no secret any pattern class recognises.
   *
   * Every class but the high-entropy heuristic, which is a guess about shape and would condemn the
   * very identifiers AD-5 requires unchanged. A field this returns `false` for is dropped, not
   * rewritten: the caller cannot both keep it verbatim and redact it.
   */
  provesPatternFree: (value: string) => boolean;
}

export const createRedactor = (policy: RedactionPolicy = {}): Redactor => {
  const secrets = normaliseSecrets(policy.secrets);
  const forms = secrets.flatMap((secret) => serialisedForms(secret.value));
  /** The same policy with the entropy sweep switched off by a length no candidate can reach. */
  const patternOnly: RedactionPolicy = {
    ...policy,
    highEntropyMinLength: Number.POSITIVE_INFINITY,
  };
  return {
    policy,
    secrets,
    redact: <T>(value: T): RedactionResult<T> => redactValue<T>(value, policy),
    provesFree: (serialised: string): boolean => !forms.some((form) => serialised.includes(form)),
    provesPatternFree: (value: string): boolean => {
      const result = redactValue(value, patternOnly);
      return result.ok && result.value === value;
    },
  };
};
