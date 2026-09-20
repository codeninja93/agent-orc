/**
 * The `--output-format stream-json` parser, driven from recorded transcripts.
 *
 * Every fixture here descends from one genuine `claude -p --output-format stream-json` invocation,
 * committed under `tests/fixtures/stream-json/`. That is the whole point of the suite and it is worth
 * being explicit about: a parser tested against fixtures written from the parser's own assumptions
 * proves only that it agrees with itself. `completed.jsonl` is the real transcript; the error-shape
 * variants were produced by editing *that* shape, and `permission-denied-real.jsonl` is a second real
 * transcript recorded against a real refusal.
 *
 * The first test therefore checks the fixtures are what they claim to be, before anything is asserted
 * about the parser. A fixture quietly replaced by hand-written JSON would make every test below pass
 * and mean nothing.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { createStreamParser, parseStream, parseStreamLine } from '../src/engine/index.js';
import type { StreamRecord } from '../src/engine/index.js';

const FIXTURES = new URL('./fixtures/stream-json/', import.meta.url);

const fixture = (name: string): string => readFileSync(new URL(name, FIXTURES), 'utf8');

const fixturePath = (name: string): string => fileURLToPath(new URL(name, FIXTURES));

const of = <K extends StreamRecord['kind']>(
  records: readonly StreamRecord[],
  kind: K,
): readonly Extract<StreamRecord, { kind: K }>[] =>
  records.filter((record): record is Extract<StreamRecord, { kind: K }> => record.kind === kind);

/** The session id the real transcript was recorded under. */
const REAL_SESSION_ID = '33f452b6-11d0-4ea7-89e9-7dc2962643ad';

describe('the fixtures are recorded, not invented', () => {
  it('the real transcript is a whole CLI run, init line to result line', () => {
    const lines = fixture('completed.jsonl').trim().split('\n');
    const first = JSON.parse(lines[0] ?? '{}') as Record<string, unknown>;
    const last = JSON.parse(lines[lines.length - 1] ?? '{}') as Record<string, unknown>;

    // Fields only the CLI writes: the version it ran as, the api key source it resolved, the cost it
    // reported. None of these would be in a transcript someone wrote to satisfy the parser.
    expect(first['type']).toBe('system');
    expect(first['subtype']).toBe('init');
    expect(first['claude_code_version']).toBe('2.1.278');
    expect(first['apiKeySource']).toBe('none');
    expect(last['type']).toBe('result');
    expect(last).toHaveProperty('total_cost_usd');
    expect(last).toHaveProperty('modelUsage');
    expect(last['session_id']).toBe(REAL_SESSION_ID);
  });

  it('the derived variants keep the recorded shape and change only what they are named for', () => {
    const real = JSON.parse(fixture('completed.jsonl').trim().split('\n').at(-1) ?? '{}') as Record<
      string,
      unknown
    >;
    const invalid = JSON.parse(
      fixture('schema-invalid-output.jsonl').trim().split('\n').at(-1) ?? '{}',
    ) as Record<string, unknown>;
    // Same real result line, one field of the structured output edited out of the contract.
    expect(invalid['uuid']).toBe(real['uuid']);
    expect(invalid['total_cost_usd']).toBe(real['total_cost_usd']);
    expect((invalid['structured_output'] as Record<string, unknown>)['status']).toBe('finished');
  });

  it('the permission denial is a real refusal, not a shape written to match the parser', () => {
    const lines = fixture('permission-denied-real.jsonl').trim().split('\n');
    const denial = lines
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .find((line) => line['subtype'] === 'permission_denied');
    expect(denial).toBeDefined();
    expect(denial?.['tool_name']).toBe('Write');
    // The CLI's own words, which is the evidence this was refused rather than declined by the model.
    expect(String(denial?.['decision_reason'])).toContain('--restricted');
  });
});

describe('the terminal structured output', () => {
  it('is read off the real transcript, unvalidated, with the session id beside it', () => {
    const records = parseStream(fixture('completed.jsonl'));
    const results = of(records, 'result');
    expect(results).toHaveLength(1);
    const result = results[0]!;
    expect(result.subtype).toBe('success');
    expect(result.isError).toBe(false);
    expect(result.hasStructuredOutput).toBe(true);
    expect(result.sessionId).toBe(REAL_SESSION_ID);
    expect(result.structuredOutput).toMatchObject({
      contract_id: 'step.output',
      step: 'implement',
      status: 'completed',
    });
  });

  it('distinguishes an absent structured output from a present one', () => {
    const bare = of(parseStream(fixture('no-structured-output.jsonl')), 'result')[0]!;
    expect(bare.hasStructuredOutput).toBe(false);
    expect(bare.isError).toBe(false);

    const errored = of(parseStream(fixture('error-result.jsonl')), 'result')[0]!;
    expect(errored.isError).toBe(true);
    expect(errored.subtype).toBe('error_max_turns');
    expect(errored.hasStructuredOutput).toBe(false);
  });

  it('is absent entirely from a stream that never reached its result line', () => {
    const records = parseStream(fixture('no-terminal-output.jsonl'));
    expect(of(records, 'result')).toHaveLength(0);
    // The session id survives, which is what makes the interrupted attempt resumable at all.
    expect(of(records, 'session')[0]?.sessionId).toBe(REAL_SESSION_ID);
  });
});

describe('the session id', () => {
  it('is emitted once for a whole stream, however many lines carry it', () => {
    const lines = fixture('completed.jsonl').trim().split('\n');
    const carrying = lines.filter((line) =>
      Object.prototype.hasOwnProperty.call(JSON.parse(line) as object, 'session_id'),
    );
    expect(carrying.length).toBeGreaterThan(1);

    const sessions = of(parseStream(fixture('completed.jsonl')), 'session');
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.sessionId).toBe(REAL_SESSION_ID);
  });

  it('is emitted from the first line that carries it, before any tool use', () => {
    const records = parseStream(fixture('completed.jsonl'));
    const sessionAt = records.findIndex((record) => record.kind === 'session');
    const toolAt = records.findIndex((record) => record.kind === 'tool_use');
    expect(sessionAt).toBeGreaterThanOrEqual(0);
    expect(toolAt).toBeGreaterThan(sessionAt);
  });
});

describe('tool uses', () => {
  it('are read with their ids, and a null parent when the call is direct', () => {
    const uses = of(parseStream(fixture('completed.jsonl')), 'tool_use');
    expect(uses.length).toBeGreaterThan(0);
    const read = uses.find((use) => use.toolName === 'Read')!;
    expect(read.toolUseId).toBe('toolu_01So4bBVT8bibePJo5jqrdws');
    expect(read.parentToolUseId).toBeNull();
    expect(read.sessionId).toBe(REAL_SESSION_ID);
  });

  it('preserve a nested call\'s parent_tool_use_id verbatim, byte for byte', () => {
    const uses = of(parseStream(fixture('nested-tool-use.jsonl')), 'tool_use');
    const nested = uses.find((use) => use.parentToolUseId !== null)!;
    // AD-5 requires the value unchanged: not trimmed, not normalised, not re-cased.
    expect(nested.parentToolUseId).toBe('toolu_01ParentOfTheNestedSubagentCall');
    expect(fixture('nested-tool-use.jsonl')).toContain('toolu_01ParentOfTheNestedSubagentCall');
  });
});

describe('permission denials', () => {
  it('are read from the CLI\'s own refusal line, with its reason', () => {
    const denials = of(parseStream(fixture('permission-denied-real.jsonl')), 'permission_denied');
    expect(denials).toHaveLength(1);
    const denial = denials[0]!;
    expect(denial.toolName).toBe('Write');
    expect(denial.toolUseId).toBe('toolu_01FbdXqnGtJ7vqKHFbqgaqNZ');
    expect(denial.reasonType).toBe('other');
    expect(denial.reason).toContain('--restricted');
  });

  it('are not emitted twice when the result line repeats them', () => {
    // The real CLI reports a refusal on a `system` line *and* again in the result's
    // `permission_denials`. One refusal is one event.
    const text = fixture('completed-with-denial.jsonl');
    expect(text).toContain('"permission_denials"');
    expect(text).toContain('"subtype":"permission_denied"');
    const denials = of(parseStream(text), 'permission_denied');
    expect(denials).toHaveLength(1);
    expect(denials[0]?.toolName).toBe('Write');
  });

  it('are read from the result line alone when that is the only place they appear', () => {
    const resultLine = fixture('completed-with-denial.jsonl').trim().split('\n').at(-1) ?? '';
    const records = parseStreamLine(resultLine);
    expect(of(records, 'permission_denied')).toHaveLength(1);
  });
});

describe('an unparseable line', () => {
  it('is recorded and skipped, and the stream still reaches its result', () => {
    const records = parseStream(fixture('unparseable-line.jsonl'));
    const skipped = of(records, 'unparseable');
    expect(skipped).toHaveLength(1);
    expect(skipped[0]?.reason).toContain('whole JSON');
    expect(skipped[0]?.bytes).toBeGreaterThan(0);
    // The whole point: the torn line costs one line, not the attempt.
    expect(of(records, 'result')).toHaveLength(1);
    expect(of(records, 'session')[0]?.sessionId).toBe(REAL_SESSION_ID);
  });

  it('never carries the bytes it could not read', () => {
    const records = parseStreamLine('{"secret":"sk-ant-notarealkeybutshapedlikeone"');
    const skipped = of(records, 'unparseable');
    expect(skipped).toHaveLength(1);
    expect(JSON.stringify(skipped[0])).not.toContain('sk-ant');
    expect(JSON.stringify(skipped[0])).not.toContain('secret');
  });

  it('covers a line that is valid JSON but not an object', () => {
    expect(of(parseStreamLine('"just a string"'), 'unparseable')).toHaveLength(1);
    expect(of(parseStreamLine('[1,2,3]'), 'unparseable')).toHaveLength(1);
    expect(parseStreamLine('   ')).toHaveLength(0);
    expect(parseStreamLine('')).toHaveLength(0);
  });
});

describe('the incremental parser', () => {
  it('holds a partial line back rather than tearing on it', () => {
    const text = fixture('completed.jsonl');
    const parser = createStreamParser();
    const records: StreamRecord[] = [];
    // Chunks that cut JSON lines wherever they fall, which is what a real pipe delivers.
    for (let offset = 0; offset < text.length; offset += 97) {
      records.push(...parser.push(text.slice(offset, offset + 97)));
    }
    records.push(...parser.end());

    expect(of(records, 'unparseable')).toHaveLength(0);
    expect(of(records, 'result')).toHaveLength(1);
    expect(of(records, 'session')).toHaveLength(1);
    expect(of(records, 'tool_use').length).toBeGreaterThan(0);
    // Chunked and whole agree, which is the claim.
    expect(records.map((record) => record.kind)).toStrictEqual(
      parseStream(text).map((record) => record.kind),
    );
  });

  it('flushes a trailing line that never got its newline', () => {
    const parser = createStreamParser();
    expect(parser.push('{"type":"system","subtype":"init","apiKeySource":"none"}')).toHaveLength(0);
    const flushed = parser.end();
    expect(of(flushed, 'api_key_source')[0]?.subscription).toBe(true);
    expect(parser.end()).toHaveLength(0);
  });

  it('reports the session id and result through its accessors', () => {
    const parser = createStreamParser();
    parser.push(fixture('completed.jsonl'));
    parser.end();
    expect(parser.sessionId()).toBe(REAL_SESSION_ID);
    expect(parser.result()?.subtype).toBe('success');
  });
});

describe('the authentication the CLI reports', () => {
  it('is read off the init line, and the real transcript says subscription', () => {
    const sources = of(parseStream(fixture('completed.jsonl')), 'api_key_source');
    expect(sources).toHaveLength(1);
    expect(sources[0]?.source).toBe('none');
    expect(sources[0]?.subscription).toBe(true);
  });

  it('reports a key source that is not the subscription login', () => {
    const records = parseStreamLine(
      '{"type":"system","subtype":"init","apiKeySource":"ANTHROPIC_API_KEY","session_id":"s1"}',
    );
    expect(of(records, 'api_key_source')[0]?.subscription).toBe(false);
  });
});

describe('every recorded fixture parses', () => {
  const names = [
    'completed.jsonl',
    'completed-with-denial.jsonl',
    'schema-invalid-output.jsonl',
    'no-structured-output.jsonl',
    'error-result.jsonl',
    'unparseable-line.jsonl',
    'no-terminal-output.jsonl',
    'nested-tool-use.jsonl',
    'permission-denied-real.jsonl',
  ];

  it.each(names)('%s yields records and announces a session', (name) => {
    expect(fixturePath(name)).toContain('fixtures/stream-json');
    const records = parseStream(fixture(name));
    expect(records.length).toBeGreaterThan(0);
    expect(of(records, 'session')).toHaveLength(1);
  });
});
