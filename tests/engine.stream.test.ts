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

import {
  createStreamParser,
  MAX_STREAM_LINE_BYTES,
  parseStream,
  parseStreamLine,
  UNNAMED_DENIED_TOOL,
  UNREPORTED_API_KEY_SOURCE,
} from '../src/engine/index.js';
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

describe('the refused resume, recorded from the real CLI', () => {
  it('is one complete result line carrying the requested id and an errors array', () => {
    // The shape that made the old structural test dead: there *is* a result line, and it *does* carry
    // a session id, so a check for "neither" could never fire.
    const records = parseStream(fixture('resume-refused.jsonl'));
    const result = of(records, 'result')[0]!;
    expect(result.subtype).toBe('error_during_execution');
    expect(result.isError).toBe(true);
    expect(result.numTurns).toBe(0);
    expect(result.hasStructuredOutput).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('No conversation found with session ID');
    // The line carries the id that was *asked for*, which is why it must not be announced.
    expect(result.sessionId).toBe('00000000-dead-4bee-8000-000000000000');
  });

  it('announces no session, because the id on it names one that does not exist', () => {
    const records = parseStream(fixture('resume-refused.jsonl'));
    expect(of(records, 'session')).toHaveLength(0);
    const parser = createStreamParser();
    parser.push(fixture('resume-refused.jsonl'));
    expect(parser.sessionId()).toBeNull();
  });

  it('still announces the session opened by an init line before a later error result', () => {
    // A real session that then errors is not a refusal: the id is live and resume may use it.
    const records = parseStream(fixture('error-result.jsonl'));
    expect(of(records, 'session')[0]?.sessionId).toBe(REAL_SESSION_ID);
    expect(of(records, 'result')[0]?.errors).toHaveLength(0);
  });
});

describe('the reported authentication source', () => {
  it('treats an init line with no apiKeySource as unreported, never as a refusal', () => {
    const records = parseStream(fixture('api-key-source-unreported.jsonl'));
    const source = of(records, 'api_key_source')[0]!;
    expect(source.reported).toBe(false);
    expect(source.source).toBe(UNREPORTED_API_KEY_SOURCE);
    // Absence is not denial: an unreported field must not fail every spawn with an unretryable code.
    expect(source.subscription).toBe(true);
  });

  it('treats a named non-subscription source as a refusal', () => {
    const source = of(parseStream(fixture('api-key-mode.jsonl')), 'api_key_source')[0]!;
    expect(source.reported).toBe(true);
    expect(source.source).toBe('ANTHROPIC_API_KEY');
    expect(source.subscription).toBe(false);
  });

  it('reports no record at all when no init line arrived', () => {
    const parser = createStreamParser();
    parser.push(fixture('resume-refused.jsonl'));
    // Distinct from "unreported": the check never ran, and the spawner records which happened.
    expect(parser.apiKeySource()).toBeNull();
  });
});

describe('a denial the parser cannot fully read', () => {
  it('is still a denial, under a placeholder name', () => {
    // Silence is the one direction a permission event must never fail in, so an unreadable tool name
    // costs the name, not the event.
    const records = parseStreamLine(
      '{"type":"system","subtype":"permission_denied","decision_reason":"blocked","session_id":"s1"}',
    );
    const denials = of(records, 'permission_denied');
    expect(denials).toHaveLength(1);
    expect(denials[0]?.toolName).toBe(UNNAMED_DENIED_TOOL);
    expect(denials[0]?.origin).toBe('line');
  });

  it('keeps two distinct id-less refusals of the same tool for the same reason', () => {
    const line = '{"type":"system","subtype":"permission_denied","tool_name":"Write","decision_reason":"same","session_id":"s1"}';
    const parser = createStreamParser();
    const records = [...parser.push(`${line}\n${line}\n`), ...parser.end()];
    // Two refusals happened, so two events must exist. Collapsing them hides one.
    expect(of(records, 'permission_denied')).toHaveLength(2);
  });

  it('still collapses the result line\'s repeat of an id-less refusal', () => {
    const systemLine =
      '{"type":"system","subtype":"permission_denied","tool_name":"Write","decision_reason":"same","session_id":"s1"}';
    const resultLine =
      '{"type":"result","subtype":"success","session_id":"s1","permission_denials":[{"tool_name":"Write","decision_reason":"same"}]}';
    const parser = createStreamParser();
    const records = [...parser.push(`${systemLine}\n${resultLine}\n`), ...parser.end()];
    expect(of(records, 'permission_denied')).toHaveLength(1);
  });
});

describe('the pending buffer', () => {
  it('is capped, so an endless line cannot grow it without limit', () => {
    const parser = createStreamParser();
    const chunk = 'x'.repeat(1024 * 1024);
    let skipped = 0;
    // Five megabytes with no newline anywhere: unvalidated output from another process.
    for (let i = 0; i < 5; i += 1) skipped += of(parser.push(chunk), 'unparseable').length;
    expect(skipped).toBe(1);
    expect(of(parser.push(chunk), 'unparseable')).toHaveLength(0);
  });

  it('resynchronises on the newline after an over-long line', () => {
    const parser = createStreamParser();
    parser.push('y'.repeat(MAX_STREAM_LINE_BYTES + 1));
    const after = parser.push('\n{"type":"system","subtype":"init","apiKeySource":"none"}\n');
    expect(of(after, 'api_key_source')).toHaveLength(1);
    expect(of(after, 'unparseable')).toHaveLength(0);
  });

  it('never carries the over-long bytes into the record', () => {
    const parser = createStreamParser();
    const records = parser.push(`sk-ant-${'z'.repeat(MAX_STREAM_LINE_BYTES)}`);
    const skipped = of(records, 'unparseable')[0]!;
    expect(skipped.reason).toContain('cap');
    expect(JSON.stringify(skipped)).not.toContain('sk-ant');
  });
});

describe('the spliced denial fixture', () => {
  it('names only the session that actually ran', () => {
    // A foreign session id on a spliced line would attribute the denial the spawner suite asserts on
    // to a session that never existed in that transcript.
    const text = fixture('completed-with-denial.jsonl');
    expect(text).not.toContain('68fdef4f');
    for (const record of of(parseStream(text), 'permission_denied')) {
      expect(record.sessionId).toBe(REAL_SESSION_ID);
    }
  });
});
