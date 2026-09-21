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

import {
  ARGUMENT_REQUIRED_COMMANDS,
  COMMANDS,
  Command,
  CommandIntentSchema,
  commandRequiresArgument,
} from '../src/contracts/index.js';
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
  DuplicateControlKey,
  controlForKey,
  displayWidth,
  formatControlHints,
  indexControlsByKey,
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

  /**
   * The uniqueness check the table's own comment claims, made into one.
   *
   * `CONTROL_KEYS` was a list that checked nothing and `controlForKey` resolved by linear search, so two
   * controls sharing a key made the later one permanently unreachable while the table still typechecked
   * and this suite still passed — a control a person has and cannot use, which is the same defect as a
   * missing control wearing a different coat (AD-3). The index now refuses to be built.
   */
  it('refuses to build a keystroke index in which one control is unreachable', () => {
    const clashing = CONTROL_ORDER.map((control) =>
      control.command === Command.JustDoIt
        ? { ...control, key: CONTROLS[Command.Kill].key }
        : control,
    );
    expect(() => indexControlsByKey(clashing)).toThrow(DuplicateControlKey);
    expect(() => indexControlsByKey(clashing)).toThrow(/just_do_it|kill/);
    // The real table builds, and resolves every key to the control that declared it.
    expect(indexControlsByKey(CONTROL_ORDER).size).toBe(CONTROL_ORDER.length);
  });

  it('states that closing the viewer is not the gesture that stops the run', () => {
    /**
     * Ctrl-c is deliberately left as "quit the viewer" — see `QUIT_IS_NOT_DISENGAGE_HINT` for why — so
     * the hint line has to say which of the two it is. A person who quits believing they disengaged has
     * exactly the false belief about what the system is doing that this shell exists to prevent.
     */
    const hints = formatControlHints(80).join('\n');
    expect(hints).toContain('ctrl-c');
    expect(hints).toContain('leaves the run advancing');
    expect(hints.startsWith('x stop')).toBe(true);
  });

  it('wraps the hints to a narrow terminal, measured in cells rather than code units', () => {
    for (const line of formatControlHints(40)) {
      expect(displayWidth(line), line).toBeLessThanOrEqual(40);
    }
  });

  /**
   * The contract decides which controls need text; this table has to agree with it.
   *
   * A control the renderer invokes with no argument, for a command the contract refuses without one,
   * writes an intent file that every reader then rejects — the user presses a key, a file appears, and
   * nothing happens. Asserted against `ARGUMENT_REQUIRED_COMMANDS` rather than restated as a list here,
   * so adding a command to the contract's set fails this test until the keystroke asks for text.
   */
  it('asks for text for exactly the commands the contract refuses without it', () => {
    for (const command of ARGUMENT_REQUIRED_COMMANDS) {
      expect(CONTROLS[command].argument, command).toBe('required');
    }
    for (const command of COMMANDS) {
      if (CONTROLS[command].argument === 'required') {
        expect(commandRequiresArgument(command), command).toBe(true);
      }
    }
  });

  it('keeps one gesture that always means stop, and gives it a key of its own', () => {
    expect(ALWAYS_AVAILABLE_CONTROL).toBe(Command.Disengage);
    const stop = CONTROLS[ALWAYS_AVAILABLE_CONTROL];
    expect(CONTROL_ORDER.filter((control) => control.key === stop.key)).toHaveLength(1);
  });

  it('fails to compile when a command has no entry in the table', () => {
    /**
     * The claim in the acceptance criteria is about `tsc`, so `tsc` is what answers it. The probe is a
     * `CommandMap` missing exactly one member, compiled by the project's own configuration.
     *
     * **Both artifacts live under `node_modules/`, and that is the fix rather than the mess.** They used
     * to be written into the repository root — `.probe-control-table/` and a generated tsconfig beside
     * it — where neither is git-ignored, so an interrupted run left two untracked paths in `git status`
     * for somebody to wonder about. `node_modules/` is ignored by the repository and rebuilt by any
     * install, so debris there costs nothing; the directory holds the generated config too, so teardown
     * removes one path rather than two. `exclude: []` is needed because TypeScript's default excludes
     * `node_modules`, and the probe has to be compiled rather than skipped — a skipped probe compiles
     * cleanly and would assert the opposite of what this test means.
     */
    const probeDir = join(process.cwd(), 'node_modules', '.probe-control-table');
    const probeConfig = join(probeDir, 'tsconfig.probe.json');
    toRemove.push(probeDir);
    mkdirSync(probeDir, { recursive: true });
    writeFileSync(
      join(probeDir, 'missing-control.ts'),
      [
        "import { Command } from '../../src/contracts/index.js';",
        "import type { CommandMap } from '../../src/contracts/index.js';",
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
        {
          extends: join(process.cwd(), 'tsconfig.json'),
          include: [join(probeDir, '**', '*.ts')],
          exclude: [],
        },
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
    // And it claims no AD-35 code: it crosses no unit boundary, and `config.invalid` — whose declared
    // disposition is `escalate-to-human` — filed a correctable keystroke as a broken installation.
    const thrown = new ControlArgumentRequired(Command.Answer);
    expect('code' in thrown).toBe(false);
    expect(thrown.message).toContain('carries free text');
  });

  /**
   * Two intents minted in the same millisecond sort in the order they were issued.
   *
   * `orderIntents` breaks a tie on `issued_at` — a millisecond timestamp — with the intent id, so for two
   * commands issued inside one millisecond the id *is* the order they are applied in. A seed drawn
   * entirely from `randomUUID` made that a coin toss, which is the one order a steering surface may not
   * get wrong; the seed now opens with the minting instant and a within-process count.
   */
  it('mints ids that sort in the order they were issued', () => {
    const paths = runPaths(RUN, home);
    const minted: string[] = [];
    for (let index = 0; index < 30; index += 1) {
      minted.push(
        invokeControl(Command.Pause, { paths, feature: FEATURE, principal: PRINCIPAL }).intentId,
      );
    }
    expect([...minted].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))).toStrictEqual(minted);
    expect(new Set(minted).size).toBe(minted.length);
    for (const id of minted) expect(isLoggableIntentId(id), id).toBe(true);
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
