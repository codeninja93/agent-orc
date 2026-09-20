/**
 * A Node script that impersonates `claude -p`, so the engine suites spawn a real subprocess and
 * spend no model call.
 *
 * The acceptance criterion is explicit — "given the test suite, when it runs, then it spawns no real
 * `claude` process and spends no model call" — and a double that lives inside the test process cannot
 * satisfy it: the things this story gets wrong most easily are all properties of a *real* child. A
 * signal arriving mid-stream, stdout arriving in chunks that cut a JSON line in half, an exit code
 * racing the last flush, a session id that has to reach the parent before the process dies. An
 * in-process fake has none of those, so this is a real script the spawner really spawns.
 *
 * It replays a fixture rather than inventing a stream. Every fixture under
 * `tests/fixtures/stream-json/` descends from one genuine `claude -p --output-format stream-json`
 * transcript, so what this script writes is what the CLI actually emitted.
 *
 * It is configured through the environment, never through argv, because argv belongs to the CLI it is
 * impersonating: the suite asserts the exact argument vector AD-1 requires, and a flag this script
 * invented would be indistinguishable from one the spawner passed.
 *
 *   FAKE_CLAUDE_FIXTURE       absolute path to a `.jsonl` transcript to replay
 *   FAKE_CLAUDE_ARGV_OUT      write the received argv here as JSON, for the argv assertions
 *   FAKE_CLAUDE_VERSION       what `--version` reports (default 2.1.278, the recorded one)
 *   FAKE_CLAUDE_EXIT          exit code after the replay (default 0)
 *   FAKE_CLAUDE_STDERR        text written to stderr before exiting
 *   FAKE_CLAUDE_LINE_DELAY_MS pause between lines (default 0)
 *   FAKE_CLAUDE_PAUSE_AFTER   pause FAKE_CLAUDE_PAUSE_MS after this many lines
 *   FAKE_CLAUDE_PAUSE_MS      how long that pause is (default 60)
 *   FAKE_CLAUDE_STOP_AFTER    stop replaying after this many lines
 *   FAKE_CLAUDE_SIGNAL        kill self with this signal instead of exiting
 *   FAKE_CLAUDE_HANG          stay alive after the replay until something kills it
 *   FAKE_CLAUDE_IGNORE_SIGTERM decline SIGTERM, as a child that must be escalated against does
 *   FAKE_CLAUDE_REFUSE_RESUME refuse any argv carrying --resume, in the recorded shape (see below)
 *   FAKE_CLAUDE_SPLIT_WRITES  write the transcript in fixed-size chunks that cut lines apart
 *
 * `FAKE_CLAUDE_REFUSE_RESUME` takes a mode, because the two signals the spawner recognises a refusal
 * by have to be pinnable one at a time:
 *
 *   `1` / `both`  the measured reality: the recorded result line on stdout *and* the recorded stderr
 *   `stdout-only` the recorded result line and no stderr, so only the `errors` array can be read
 *   `stderr-only` an init line and a result line with `errors` stripped, plus the recorded stderr
 *
 * The refusal bytes are the real CLI's, recorded from a resume against a session id that never
 * existed: one result line with `subtype: "error_during_execution"`, `is_error: true`,
 * `num_turns: 0`, the *requested* session id, and
 * `errors: ["No conversation found with session ID: …"]`, then exit 1. The earlier version of this
 * script wrote nothing to stdout and the message to stderr, which is the inverse of what the CLI does.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';

/** The version the recorded transcripts were captured with. */
const DEFAULT_FAKE_VERSION = '2.1.278';

const env = process.env;
const argv = process.argv.slice(2);

const read = (name: string): string | null => {
  const value = env[name];
  return value === undefined || value === '' ? null : value;
};

const readNumber = (name: string, fallback: number): number => {
  const raw = read(name);
  if (raw === null) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
};

/** The session id the committed refusal transcript was recorded against. */
const RECORDED_DEAD_SESSION_ID = '00000000-dead-4bee-8000-000000000000';

/** The non-empty lines of a transcript named by an environment variable. */
const readFixture = (variable: string): readonly string[] => {
  const path = read(variable);
  if (path === null) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line !== '');
};

const write = (text: string): Promise<void> =>
  new Promise<void>((resolve) => {
    // `write` can return false when the pipe is full; the callback is what says the bytes left.
    process.stdout.write(text, () => {
      resolve();
    });
  });

const main = async (): Promise<void> => {
  if (read('FAKE_CLAUDE_IGNORE_SIGTERM') !== null) {
    // A child that declines the polite stop. Without an escalation behind it, the attempt promise
    // would never settle and `killAll()` would block a shutdown forever.
    // An empty handler is the point: it is what makes this child decline the polite stop, so the
    // SIGKILL escalation has something to escalate against.
    // eslint-disable-next-line @typescript-eslint/no-empty-function
    process.on('SIGTERM', () => {});
  }

  const argvOut = read('FAKE_CLAUDE_ARGV_OUT');
  if (argvOut !== null) writeFileSync(argvOut, JSON.stringify(argv), 'utf8');

  if (argv.includes('--version')) {
    await write(`${read('FAKE_CLAUDE_VERSION') ?? DEFAULT_FAKE_VERSION} (Claude Code)\n`);
    process.exit(0);
  }

  const refuseResume = read('FAKE_CLAUDE_REFUSE_RESUME');
  if (refuseResume !== null && argv.includes('--resume')) {
    const requested = argv[argv.indexOf('--resume') + 1] ?? RECORDED_DEAD_SESSION_ID;
    const message = `No conversation found with session ID: ${requested}`;
    const lines = readFixture('FAKE_CLAUDE_REFUSAL_FIXTURE');
    for (const line of lines) {
      // The recorded refusal line, with the requested id substituted for the recorded one so the
      // stream says what a real refusal of *this* id would say.
      await write(`${line.replaceAll(RECORDED_DEAD_SESSION_ID, requested)}\n`);
    }
    if (refuseResume !== 'stdout-only') process.stderr.write(`${message}\n`);
    process.exit(1);
  }

  const lines = readFixture('FAKE_CLAUDE_FIXTURE');

  const stopAfter = readNumber('FAKE_CLAUDE_STOP_AFTER', lines.length);
  const pauseAfter = readNumber('FAKE_CLAUDE_PAUSE_AFTER', -1);
  const pauseMs = readNumber('FAKE_CLAUDE_PAUSE_MS', 60);
  const lineDelay = readNumber('FAKE_CLAUDE_LINE_DELAY_MS', 0);
  const splitWrites = readNumber('FAKE_CLAUDE_SPLIT_WRITES', 0);

  const replayed = lines.slice(0, stopAfter);

  if (splitWrites > 0) {
    // One transcript written in fixed-size chunks, which cut JSON lines wherever they fall. This is
    // the shape a real pipe delivers, and the shape a per-chunk parse tears on.
    const whole = `${replayed.join('\n')}\n`;
    for (let offset = 0; offset < whole.length; offset += splitWrites) {
      await write(whole.slice(offset, offset + splitWrites));
      if (lineDelay > 0) await delay(lineDelay);
    }
  } else {
    for (const [index, line] of replayed.entries()) {
      await write(`${line}\n`);
      if (index + 1 === pauseAfter) await delay(pauseMs);
      else if (lineDelay > 0) await delay(lineDelay);
    }
  }

  const stderr = read('FAKE_CLAUDE_STDERR');
  if (stderr !== null) process.stderr.write(`${stderr}\n`);

  const signal = read('FAKE_CLAUDE_SIGNAL');
  if (signal !== null) {
    process.kill(process.pid, signal);
    // SIGKILL never returns here; a catchable signal might, so the process still waits to be reaped.
    await delay(5000);
  }

  if (read('FAKE_CLAUDE_HANG') !== null) {
    // Stay alive until the executor stops us. This is the `killed` disposition's fixture.
    await delay(30_000);
  }

  process.exit(readNumber('FAKE_CLAUDE_EXIT', 0));
};

void main();
