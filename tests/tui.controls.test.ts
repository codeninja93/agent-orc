/**
 * AD-19 and AD-3 — a control writes one durable file, and the table of controls is total.
 *
 * The two claims this suite exists for:
 *
 * **A control's only effect is an intent file.** Invoking one writes exactly one file under
 * `runs/<run-id>/commands/` and changes nothing else — not `state.json`, not `events.jsonl`, not the
 * worktree. A renderer that mutated run state would be a second command path, which AD-19 admits no
 * possibility of, and the test for that is an inventory of the run directory before and after.
 *
 * **The intent a renderer writes is the one the loop consumes.** Asserting the file's shape against the
 * contract would prove the shape and nothing about the path, so the file written here is handed to the
 * engine's own reader and then to a real reconciler pass, which stops the run. That is the whole of
 * "renderers reach the engine only by writing command intent files", end to end, with no method call.
 *
 * The compile-error claim — a `Command` member with no entry in the control table fails `tsc` — is
 * checked by compiling a file that omits one, because a runtime assertion cannot observe a compile
 * error and a comment claiming one is not evidence.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { COMMANDS, Command, CommandIntentSchema } from '../src/contracts/index.js';
import {
  Reconciler,
  createRecordingResetter,
  createScriptedExecutor,
  readIntentFiles,
  terminated,
} from '../src/engine/index.js';
import { isLoggableIntentId, runPaths } from '../src/runtime/index.js';
import {
  ALWAYS_AVAILABLE_CONTROL,
  CONTROLS,
  CONTROL_KEYS,
  CONTROL_ORDER,
  ControlArgumentRequired,
  controlForKey,
  invokeControl,
  invokeControlByKey,
} from '../src/tui/index.js';

import { makeHome, makePlan, planProvider } from './helpers/engine-fixture.js';

const BASELINE = 'ddd9bed4d286ac1f8a0f4f7bfef9530046605787';
const RUN = '01K5NQ9ZJ7V3M2P9XQWRTC4BDE';
const FEATURE = 'tui-shell';
const PRINCIPAL = { kind: 'user' as const, id: 'deep' };

let home: string;
const toRemove: string[] = [];
const toClose: Reconciler[] = [];

beforeEach(() => {
  home = makeHome('tui-controls');
  toRemove.push(home);
});

afterEach(() => {
  for (const reconciler of toClose.splice(0)) reconciler.close();
  for (const dir of toRemove.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Every file under a directory, with its size and modification time: the run's observable state. */
const inventory = (dir: string): Record<string, string> => {
  const out: Record<string, string> = {};
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        walk(path);
        continue;
      }
      const stat = statSync(path);
      out[relative(dir, path)] = `${String(stat.size)}:${String(stat.mtimeMs)}`;
    }
  };
  if (existsSync(dir)) walk(dir);
  return out;
};

describe('the control table is total over the Command enum', () => {
  it('has an entry for every command, and no more', () => {
    for (const command of COMMANDS) {
      expect(Object.prototype.hasOwnProperty.call(CONTROLS, command), command).toBe(true);
      expect(CONTROLS[command].command).toBe(command);
    }
    expect(CONTROL_ORDER).toHaveLength(COMMANDS.length);
  });

  it('gives every control its own keystroke, so none is unreachable', () => {
    expect(new Set(CONTROL_KEYS).size).toBe(CONTROL_KEYS.length);
    for (const control of CONTROL_ORDER) {
      expect(controlForKey(control.key)?.command).toBe(control.command);
      expect(controlForKey(control.key.toUpperCase())?.command).toBe(control.command);
    }
    expect(controlForKey('?')).toBeNull();
  });

  it('keeps one gesture that always means stop, and gives it a key of its own', () => {
    expect(ALWAYS_AVAILABLE_CONTROL).toBe(Command.Disengage);
    const stop = CONTROLS[ALWAYS_AVAILABLE_CONTROL];
    expect(CONTROL_ORDER.filter((control) => control.key === stop.key)).toHaveLength(1);
  });

  it('fails to compile when a command has no entry in the table', () => {
    // The claim in the acceptance criteria is about `tsc`, so `tsc` is what answers it. The probe is a
    // `CommandMap` missing exactly one member, compiled by the project's own configuration.
    const probeDir = join(process.cwd(), '.probe-control-table');
    const probeConfig = join(process.cwd(), 'tsconfig.control-table-probe.json');
    toRemove.push(probeDir);
    toRemove.push(probeConfig);
    mkdirSync(probeDir, { recursive: true });
    writeFileSync(
      join(probeDir, 'missing-control.ts'),
      [
        "import { Command } from '../src/contracts/index.js';",
        "import type { CommandMap } from '../src/contracts/index.js';",
        '',
        '// Every member but `disengage`, which is the one a renderer must never be able to omit.',
        'export const PARTIAL: CommandMap<string> = {',
        ...COMMANDS.filter((command) => command !== Command.Disengage).map(
          (command) => `  [${JSON.stringify(command)}]: 'present',`,
        ),
        '};',
        '',
      ].join('\n'),
      'utf8',
    );
    writeFileSync(
      probeConfig,
      `${JSON.stringify(
        { extends: './tsconfig.json', include: ['.probe-control-table/**/*.ts'] },
        null,
        2,
      )}\n`,
      'utf8',
    );

    let compiled = true;
    let output = '';
    try {
      execFileSync(process.execPath, [require.resolve('typescript/bin/tsc'), '-p', probeConfig], {
        cwd: process.cwd(),
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (thrown: unknown) {
      compiled = false;
      output = String((thrown as { stdout?: string }).stdout ?? '');
    }

    expect(compiled, 'a control table missing a command compiled cleanly').toBe(false);
    expect(output).toContain('disengage');
  });
});

describe('invoking a control writes a durable intent, and nothing else', () => {
  it('writes one file into commands/ and leaves the rest of the run untouched', () => {
    const paths = runPaths(RUN, home);
    mkdirSync(paths.runDir, { recursive: true });
    writeFileSync(paths.eventLog, '', 'utf8');
    writeFileSync(join(paths.runDir, 'state.json'), '{"schema_version":1}', 'utf8');
    const before = inventory(paths.runDir);

    const outcome = invokeControl(Command.Disengage, {
      paths,
      feature: FEATURE,
      principal: PRINCIPAL,
    });

    expect(existsSync(outcome.intentPath)).toBe(true);
    expect(outcome.intentPath.startsWith(paths.commandsDir)).toBe(true);

    const after = inventory(paths.runDir);
    const added = Object.keys(after).filter((path) => !(path in before));
    expect(added).toHaveLength(1);
    expect(added[0]?.startsWith('commands/')).toBe(true);
    // Nothing that existed changed: not the checkpoint, and not the log.
    for (const [path, fingerprint] of Object.entries(before)) {
      expect(after[path], `${path} was modified by a renderer`).toBe(fingerprint);
    }
  });

  it('writes an intent the contract accepts, attributed and sourced', () => {
    const paths = runPaths(RUN, home);
    const outcome = invokeControl(
      Command.Reject,
      { paths, feature: FEATURE, currentStep: 'implement', principal: PRINCIPAL },
      'the criteria do not cover the empty-log case',
    );

    const intent = CommandIntentSchema.parse(JSON.parse(readFileSync(outcome.intentPath, 'utf8')));
    expect(intent.command).toBe('reject');
    expect(intent.run).toBe(RUN);
    expect(intent.feature).toBe(FEATURE);
    expect(intent.step).toBe('implement');
    expect(intent.principal).toStrictEqual(PRINCIPAL);
    expect(intent.source).toBe('tui');
    expect(intent.argument).toBe('the criteria do not cover the empty-log case');
  });

  it('targets the run rather than a step for a run-level control', () => {
    const paths = runPaths(RUN, home);
    const outcome = invokeControl(Command.JustDoIt, {
      paths,
      feature: FEATURE,
      currentStep: 'implement',
      principal: PRINCIPAL,
    });
    const intent = CommandIntentSchema.parse(JSON.parse(readFileSync(outcome.intentPath, 'utf8')));
    expect(intent.step).toBeNull();
  });

  it('mints an intent id the log can carry, without the engine minting it', () => {
    const paths = runPaths(RUN, home);
    const ids = new Set<string>();
    for (let index = 0; index < 20; index += 1) {
      const outcome = invokeControl(Command.Pause, { paths, feature: FEATURE, principal: PRINCIPAL });
      // The exactly-once key must survive the AD-21 entropy sweep in the payload that carries it.
      expect(isLoggableIntentId(outcome.intentId), outcome.intentId).toBe(true);
      ids.add(outcome.intentId);
    }
    expect(ids.size).toBe(20);
  });

  it('refuses a control whose free text is the decision, rather than recording silence', () => {
    const paths = runPaths(RUN, home);
    expect(() =>
      invokeControl(Command.Answer, { paths, feature: FEATURE, principal: PRINCIPAL }, '   '),
    ).toThrow(ControlArgumentRequired);
    expect(existsSync(paths.commandsDir)).toBe(false);
  });

  it('invokes by keystroke, and answers null for a key that is not a control', () => {
    const paths = runPaths(RUN, home);
    const outcome = invokeControlByKey('x', { paths, feature: FEATURE, principal: PRINCIPAL });
    expect(outcome?.command).toBe(Command.Disengage);
    expect(invokeControlByKey('?', { paths, feature: FEATURE, principal: PRINCIPAL })).toBeNull();
  });
});

describe('the file a renderer writes is the file the loop consumes', () => {
  it('is read back by the engine as a pending intent', () => {
    const paths = runPaths(RUN, home);
    const outcome = invokeControl(Command.Kill, {
      paths,
      feature: FEATURE,
      currentStep: 'implement',
      principal: PRINCIPAL,
    });

    const read = readIntentFiles(paths);
    expect(read.refused).toStrictEqual([]);
    expect(read.pending).toHaveLength(1);
    expect(read.pending[0]?.intent.intent_id).toBe(outcome.intentId);
    expect(read.pending[0]?.intent.command).toBe('kill');
  });

  it('stops a real run through the file path alone, with no call into the engine', async () => {
    const plan = makePlan({ feature: 'tui-controls-run' });
    const reconciler = Reconciler.open({
      orchHome: home,
      executor: createScriptedExecutor({
        onStart: (request) => terminated(request.step, 'completed', { sessionId: `sess-${request.step}` }),
        sessionIdFor: (request) => `sess-${request.step}`,
      }),
      plans: planProvider(plan),
      baseline: createRecordingResetter(BASELINE),
    });
    toClose.push(reconciler);

    const accepted = reconciler.acceptFeature(plan);
    const paths = runPaths(accepted.run, home);

    // The only thing the renderer does: one file. No method, no socket, no signal.
    invokeControl(Command.Disengage, {
      paths,
      feature: plan.feature,
      principal: PRINCIPAL,
    });

    await reconciler.pass();

    const state = JSON.parse(readFileSync(join(paths.runDir, 'state.json'), 'utf8')) as {
      readonly state: string;
    };
    expect(state.state).toBe('killed');
  });
});
