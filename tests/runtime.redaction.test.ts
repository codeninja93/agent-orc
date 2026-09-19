/**
 * AD-21 — the fail-closed redaction pass, one describe per covered secret class.
 *
 * A redaction hole is invisible until a secret is already permanent: AD-13 records every external
 * read and AD-4 forbids rewriting a line, so a miss here cannot be fixed later. Each class is
 * therefore asserted positively (the secret goes) and negatively (an identifier stays), and the
 * fail-closed path is asserted against the *bytes of the file*, not against the dropped artifact.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  REDACTION_CLASSES,
  REDACTION_MARKER,
  Recorder,
  createRedactor,
  describeThrown,
  isHighEntropySecret,
  redactValue,
  shannonEntropyBitsPerChar,
} from '../src/runtime/index.js';
import type { RedactionClass, RedactionResult } from '../src/runtime/index.js';

/** A registered credential's literal value: what AD-21's last class names. */
const INJECTED_TOKEN = 'Hunter2RealSecretValue-XyZ987654321';
const SECRETS = [{ name: 'the github domain credential', value: INJECTED_TOKEN }];

const redact = (value: unknown): RedactionResult<unknown> =>
  redactValue(value, { secrets: SECRETS });

const rendered = (result: RedactionResult<unknown>): string => JSON.stringify(result);

const classesOf = (result: RedactionResult<unknown>): RedactionClass[] =>
  result.ok ? result.findings.map((finding) => finding.kind) : [];

/** Every substring of a secret, long enough to be a meaningful leak. */
const fragmentsOf = (secret: string, size = 8): string[] => {
  const out: string[] = [];
  for (let at = 0; at + size <= secret.length; at += 1) out.push(secret.slice(at, at + size));
  return out;
};

describe('AD-21 — registered literal credential values', () => {
  it('replaces the literal wherever it appears: value, nested value and array element', () => {
    const result = redact({
      note: `Authorization: Bearer ${INJECTED_TOKEN}`,
      nested: { deeper: [INJECTED_TOKEN, 'ordinary text'] },
    });
    expect(result.ok).toBe(true);
    expect(rendered(result)).not.toContain(INJECTED_TOKEN);
    expect(rendered(result)).toContain(REDACTION_MARKER);
    expect(classesOf(result)).toContain('registered-secret');
  });

  it('replaces the literal when it is an object key, not only a value', () => {
    const result = redact({ [INJECTED_TOKEN]: 'value under a secret key' });
    expect(result.ok).toBe(true);
    expect(rendered(result)).not.toContain(INJECTED_TOKEN);
    expect(result.ok && Object.keys(result.value as object)).toStrictEqual([REDACTION_MARKER]);
  });

  it('leaves the credential name alone — a name is loggable, a value is not', () => {
    const result = redact({ credential: 'the github domain credential' });
    expect(result.ok && result.value).toStrictEqual({ credential: 'the github domain credential' });
  });
});

describe('AD-21 — known token prefixes', () => {
  const tokens = [
    ['anthropic', 'sk-ant-api03-Aa0Bb1Cc2Dd3Ee4Ff5Gg6Hh7Ii8Jj9Kk0Ll1Mm2'],
    ['openai-style', 'sk-Aa0Bb1Cc2Dd3Ee4Ff5Gg6Hh7Ii8Jj'],
    ['github pat', 'ghp_Aa0Bb1Cc2Dd3Ee4Ff5Gg6Hh7Ii8Jj9Kk0L'],
    ['github fine-grained', 'github_pat_11ABCDEFG0aBcDeFgHiJkLmNoPqRsTuVwXyZ'],
    ['gitlab', 'glpat-Aa0Bb1Cc2Dd3Ee4Ff5'],
    ['slack bot', 'xoxb-123456789012-1234567890123-AbCdEfGhIjKlMnOpQrSt'],
    ['aws access key', 'AKIAIOSFODNN7EXAMPLE'],
    ['google api key', 'AIzaSyA1234567890abcdefghijklmnopqrstuv'],
    ['npm', 'npm_Aa0Bb1Cc2Dd3Ee4Ff5Gg6Hh7Ii8Jj9Kk0L'],
    ['stripe live', 'sk_live_Aa0Bb1Cc2Dd3Ee4Ff5Gg6Hh'],
    ['huggingface', 'hf_Aa0Bb1Cc2Dd3Ee4Ff5Gg6'],
    ['jwt', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1g'],
  ] as const;

  it.each(tokens)('redacts a %s token, whole', (_name, token) => {
    const result = redact({ payload: `Authorization: ${token} trailing` });
    expect(result.ok).toBe(true);
    const text = rendered(result);
    expect(text).not.toContain(token);
    // No usable tail may survive: a prefix-only replacement would leave most of the token behind.
    for (const fragment of fragmentsOf(token, 12)) expect(text).not.toContain(fragment);
    expect(text).toContain('trailing');
  });

  it('leaves a bare word that merely starts with a prefix alone', () => {
    const result = redact({ note: 'sk-short and ghp_tiny are not tokens' });
    expect(result.ok && result.value).toStrictEqual({
      note: 'sk-short and ghp_tiny are not tokens',
    });
  });
});

describe('AD-21 — private-key headers', () => {
  const body = 'MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7VJTUt9Us8cKj';

  it('redacts a whole PEM block, header to footer', () => {
    const pem = `-----BEGIN RSA PRIVATE KEY-----\n${body}\n-----END RSA PRIVATE KEY-----`;
    const result = redact({ key: pem });
    const text = rendered(result);
    expect(text).not.toContain(body);
    expect(text).not.toContain('BEGIN RSA PRIVATE KEY');
    expect(classesOf(result)).toContain('private-key');
  });

  it('redacts an unterminated header to the end — a truncated key is still key material', () => {
    const result = redact({ key: `-----BEGIN OPENSSH PRIVATE KEY-----\n${body}` });
    expect(rendered(result)).not.toContain(body);
    expect(classesOf(result)).toContain('private-key');
  });

  it('leaves a public key alone', () => {
    const pem = `-----BEGIN PUBLIC KEY-----\n${body}\n-----END PUBLIC KEY-----`;
    const result = redact({ key: pem });
    expect(classesOf(result)).not.toContain('private-key');
  });
});

describe('AD-21 — env-file contents', () => {
  it('redacts every value of a string that reads as a .env file, keeping the keys', () => {
    const envFile = [
      '# local development',
      'DATABASE_URL=postgres://user:pa55word@localhost/app',
      'GITHUB_TOKEN=notatokenprefixbutstillsecret',
      'PORT=8080',
    ].join('\n');
    const result = redact({ file: envFile });
    const text = rendered(result);
    expect(text).not.toContain('pa55word');
    expect(text).not.toContain('notatokenprefixbutstillsecret');
    expect(text).toContain('DATABASE_URL=');
    expect(classesOf(result)).toContain('env-file');
  });

  it('redacts a single assignment whose key names a credential', () => {
    const result = redact({ line: 'export STRIPE_SECRET_KEY=whateverthisis' });
    expect(rendered(result)).not.toContain('whateverthisis');
    expect(rendered(result)).toContain('STRIPE_SECRET_KEY=');
  });

  it('leaves an ordinary assignment that names no credential alone', () => {
    const result = redact({ line: 'width=100' });
    expect(result.ok && result.value).toStrictEqual({ line: 'width=100' });
  });
});

describe('AD-21 — credentials embedded in a URL', () => {
  it('redacts the password of scheme://user:password@host, keeping the user and the host', () => {
    const result = redact({ dsn: 'postgres://appuser:pa55word-secret@db.internal:5432/main' });
    const text = rendered(result);
    expect(text).not.toContain('pa55word-secret');
    expect(text).toContain('postgres://appuser:[redacted]@db.internal:5432/main');
    expect(classesOf(result)).toContain('url-credential');
  });

  it('leaves a URL carrying no userinfo alone', () => {
    const result = redact({ url: 'https://db.internal:5432/main?page=2' });
    expect(result.ok && result.value).toStrictEqual({ url: 'https://db.internal:5432/main?page=2' });
  });
});

describe('AD-21 — high-entropy strings', () => {
  it('redacts a high-entropy token carrying no recognised prefix', () => {
    const opaque = 'qT7pLx2ZfNc4Wb9JmK1sVh6Ry3Dg8Eu5';
    const result = redact({ opaque });
    expect(rendered(result)).not.toContain(opaque);
    expect(classesOf(result)).toContain('high-entropy');
  });

  const families = [
    ['a 40-character hex HMAC secret', '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b'],
    ['a 64-character hex secret', '2c26b46b68ffc68ff99b453c1d30413413422d706483bfa0f98a5e886266e7ae'],
    ['an upper-case-and-digits token', 'K3M9X2P7Q1W8Z4R6T5Y0N3B7V6C2L8J4'],
    ['a lower-case-and-digits token', 'k3m9x2p7q1w8z4r6t5y0n3b7v6c2l8j4'],
    ['a single-case token with no digits at all', 'qwlkjhxzmnbvcpoiuytrasdfghjklzxcvbnmqwer'],
  ] as const;

  it.each(families)('redacts %s — neither mixed case nor a non-hex alphabet is required', (_name, secret) => {
    const result = redact({ secret });
    expect(rendered(result)).not.toContain(secret);
    expect(classesOf(result)).toContain('high-entropy');
  });

  const identifiers = [
    ['a ULID run id', '01JBQZ8Q0000000000000000AA'],
    ['a UUID session id', '3f2504e0-4f89-11d3-9a0c-0305e82c3301'],
    ['a kebab-case feature slug', 'runtime-recorder-redaction-and-seq'],
    ['a branch name', 'feature/runtime-recorder-and-fetch-record'],
    ['a step id', 'implementation-step-3-of-4-verify'],
    ['a stream tool use id', 'toolu_01A09q90qw90lq917835lq9'],
    ['an RFC3339 timestamp', '2026-09-19T12:34:56.789Z'],
    ['a long sentence', 'the recorder is the sole assigner of seq for one events file'],
  ] as const;

  /**
   * These survive on their shape, not on an exemption list: an identifier is punctuated, so it splits
   * into runs below the length threshold, while a secret is one unbroken run of symbols.
   */
  it.each(identifiers)('leaves %s intact — a redacted identifier makes the log unreadable', (_name, value) => {
    const result = redact({ value });
    expect(result.ok && result.value).toStrictEqual({ value });
  });

  it('over-redacts an unbroken high-entropy identifier inside a payload, which is the fail-safe direction', () => {
    // A commit SHA and a real ULID are indistinguishable from key material once punctuation is gone.
    // The two fields AD-5 requires verbatim are protected by name in the recorder, not here.
    for (const identifier of ['3f786850e387550fdab836ed7e6dc881de23001b', '01K5QJ9F7ZXM3VB8TQW2RHNE6P']) {
      const result = redact({ identifier });
      expect(result.ok && result.value).toStrictEqual({ identifier: REDACTION_MARKER });
    }
  });

  it('measures entropy per character, so the threshold means something', () => {
    expect(shannonEntropyBitsPerChar('aaaaaaaa')).toBe(0);
    expect(shannonEntropyBitsPerChar('qT7pLx2ZfNc4Wb9JmK1sVh6Ry3Dg8Eu5')).toBeGreaterThan(4);
    expect(isHighEntropySecret('qT7pLx2ZfNc4Wb9JmK1sVh6Ry3Dg8Eu5', 24, 3.5)).toBe(true);
    expect(isHighEntropySecret('01JBQZ8Q0000000000000000AA', 24, 3.5)).toBe(false);
    expect(isHighEntropySecret('qT7pLx2Z', 24, 3.5)).toBe(false);
  });
});

describe('AD-21 — the pass fails closed', () => {
  it('reports every class it covers, so the set is inspectable', () => {
    expect([...REDACTION_CLASSES]).toStrictEqual([
      'registered-secret',
      'token-prefix',
      'private-key',
      'url-credential',
      'env-file',
      'high-entropy',
    ]);
  });

  const failing: [string, () => unknown, string][] = [
    [
      'a cycle, which cannot be fully inspected',
      () => {
        const cyclic: Record<string, unknown> = { note: INJECTED_TOKEN };
        cyclic['self'] = cyclic;
        return cyclic;
      },
      'cycle-detected',
    ],
    [
      'a value JSON cannot represent',
      () => ({ note: INJECTED_TOKEN, size: 10n }),
      'unsupported-value',
    ],
    [
      'a getter that throws while the walk reads it',
      () => {
        const hostile: Record<string, unknown> = {};
        Object.defineProperty(hostile, 'note', {
          enumerable: true,
          get: (): string => {
            throw new Error(`reading failed near ${INJECTED_TOKEN}`);
          },
        });
        return hostile;
      },
      'redactor-threw',
    ],
    [
      'nesting deeper than the pass will follow',
      () => {
        let node: Record<string, unknown> = { note: INJECTED_TOKEN };
        for (let depth = 0; depth < 200; depth += 1) node = { child: node };
        return node;
      },
      'depth-exceeded',
    ],
  ];

  it.each(failing)('fails on %s', (_name, build, reason) => {
    const result = redact(build());
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toBe(reason);
  });

  it.each(failing)('carries no fragment of the triggering value when failing on %s', (_name, build) => {
    const result = redact(build());
    const text = rendered(result);
    expect(text).not.toContain(INJECTED_TOKEN);
    for (const fragment of fragmentsOf(INJECTED_TOKEN)) expect(text).not.toContain(fragment);
    // Nor a length or a hash that would reproduce it.
    expect(text).not.toContain(String(INJECTED_TOKEN.length));
  });

  it('describes a thrown value by its class, never by its message', () => {
    expect(describeThrown(new RangeError(INJECTED_TOKEN), SECRETS)).toBe('a thrown RangeError');
    expect(describeThrown(INJECTED_TOKEN, SECRETS)).toBe('a thrown string value');
  });

  it('refuses a wrapper object rather than walking it character by character', () => {
    // `new String(secret)` enumerates as {0:'H',1:'u',…}: redacting each character would leave the
    // value trivially reconstructable, so the pass fails closed on the exotic prototype instead.
    const result = redact({ note: new String(INJECTED_TOKEN) });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toBe('unsupported-value');
    const text = rendered(result);
    for (const fragment of fragmentsOf(INJECTED_TOKEN)) expect(text).not.toContain(fragment);
  });

  it('refuses when the serialised bytes still carry a registered literal, whatever the walk saw', () => {
    // The gate is about the bytes that would reach disk, not about the walk's thoroughness: this
    // literal exists only once the object is serialised, so no string pass could have removed it.
    const result = redactValue({ a: 'b' }, { secrets: [{ name: 'a pathological literal', value: '"a":"b"' }] });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toBe('secret-survived-serialisation');
  });

  it('exposes the serialisation gate to the recorder as provesFree', () => {
    const redactor = createRedactor({ secrets: SECRETS });
    expect(redactor.provesFree('{"payload":"ordinary"}')).toBe(true);
    expect(redactor.provesFree(`{"payload":"${INJECTED_TOKEN}"}`)).toBe(false);
  });

  it('proves against the JSON-escaped form too, so a quoted or escaped literal is still caught', () => {
    const awkward = 'pa"ss\\word\nnext';
    const redactor = createRedactor({ secrets: [{ name: 'an awkward credential', value: awkward }] });
    const serialised = JSON.stringify({ payload: awkward });
    // On disk the literal exists only in its escaped form; the raw comparison alone would miss it.
    expect(serialised).not.toContain(awkward);
    expect(redactor.provesFree(serialised)).toBe(false);
  });

  it('fails closed when the artifact is larger than the accepted maximum', () => {
    const result = redactValue({ note: 'x'.repeat(200) }, { secrets: SECRETS, maxSerialisedChars: 64 });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toBe('size-exceeded');
  });

  it('checks every field a verbatim value must pass, but not the entropy guess', () => {
    const redactor = createRedactor({ secrets: SECRETS });
    // A pattern-recognised secret is never verbatim-safe…
    expect(redactor.provesPatternFree('ghp_Aa0Bb1Cc2Dd3Ee4Ff5Gg6Hh7Ii8Jj9Kk0L')).toBe(false);
    expect(redactor.provesPatternFree(INJECTED_TOKEN)).toBe(false);
    expect(redactor.provesPatternFree('postgres://u:pa55word@host/db')).toBe(false);
    // …while a high-entropy identifier is, because that class is a guess about shape.
    expect(redactor.provesPatternFree('01K5QJ9F7ZXM3VB8TQW2RHNE6P')).toBe(true);
    expect(redactor.provesPatternFree('toolu_01A09q90qw90lq917835lq9')).toBe(true);
  });
});

describe('AD-21 — the trigger value never reaches disk', () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'orch-redaction-'));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it('drops the artifact, appends redaction.failed, and leaves no fragment in the file', () => {
    const runId = '01JBQZ8Q0000000000000000RD';
    const recorder = Recorder.open({
      runId,
      feature: 'runtime-recorder',
      orchHome: home,
      redaction: { secrets: SECRETS },
    });
    try {
      const cyclic: Record<string, unknown> = { note: INJECTED_TOKEN };
      cyclic['self'] = cyclic;
      const outcome = recorder.recordResult({
        feature: 'runtime-recorder',
        run: runId,
        step: 'implementation',
        emitter: 'tool.github',
        type: 'agent.tool_used',
        payload: cyclic,
      });

      expect(outcome.dropped).toBe(true);
      expect(outcome.event.type).toBe('redaction.failed');
      expect(outcome.event.seq).toBe(1);
    } finally {
      recorder.close();
    }

    const text = readFileSync(join(home, 'runs', runId, 'events.jsonl'), 'utf8');
    expect(text).not.toContain(INJECTED_TOKEN);
    for (const fragment of fragmentsOf(INJECTED_TOKEN)) expect(text).not.toContain(fragment);
    expect(text).toContain('redaction.failed');
    // The replacement event names the reason and its disposition, and nothing about the value.
    const line = JSON.parse(text.trim()) as { payload: Record<string, unknown> };
    expect(line.payload['reason']).toBe('cycle-detected');
    expect(line.payload['disposition']).toBe('abandon-and-hand-off');
  });
});
