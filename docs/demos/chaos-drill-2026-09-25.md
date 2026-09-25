# Chaos drill — 2026-09-25

The stage-4-gate audit (`threat-model.md`, 2026-09-25 note) found that the closing instruction —
"kill an agent mid-run and confirm the system halts cleanly, the event log is intact, and the escape
hatch works" — had never been performed as a dedicated, deliberate exercise, only covered piecemeal by
unit/integration tests. This is that exercise, run once, directly against real production code.

## What ran

A standalone script (not a test double, not a fixture that only models the behavior) wired:

- a real git worktree (`git init`, one committed file),
- a real `fake-claude.ts` subprocess (the same one `tests/engine.disengage.test.ts` drives against
  production spawner code — it replays a genuine captured `claude -p --output-format stream-json`
  transcript and spends no model call), started with `FAKE_CLAUDE_HANG=1` so it stays alive until
  something stops it,
- a real `Reconciler`, `createStepSpawner`, and the real `stepStopperFrom` adapter (`dist/engine/*`,
  the actual compiled production code, not test-only helpers),
- a real command-intent file, written to disk exactly as a TUI or web renderer would write one — no
  engine method called directly.

Two scenarios, each against its own fresh run:

1. **`kill`** mid-step, while the child is genuinely running.
2. **`take_over`** (the escape hatch, CAP-23) mid-step, while the child is genuinely running.

Script: kept in this session's scratchpad, not committed — it imports from `dist/`, hand-rolls the
fixture setup `tests/helpers/` provides (those helpers import TS-sourced paths that only resolve under
vitest's transform, not under plain Node), and has no ongoing value once the drill's own record exists.

## Result: `kill`

- The child announced its session (`agent.session_announced`) before the kill intent was written,
  confirming the process was genuinely running, not merely spawned.
- `reconciler.pass()` returned with exactly the one `run-step` action.
- Final run state: **`killed`**. Step disposition: **`killed`**.
- The on-disk event log was read back fresh (not from anything in memory): **16 lines, all parsed
  successfully** — no truncation, no corruption.
- Exactly **one** `command.applied` event for the kill intent's id — no double-application.

## Result: `take_over`

- Same real-subprocess setup; the child was confirmed running before the intent was written.
- `reconciler.pass()` returned with exactly the one `run-step` action.
- Final run state: **`handed_off`**. Step disposition: **`killed`**.
- Event log: **17 lines, all parsed successfully**; exactly **one** `command.applied` event for the
  take-over intent's id.
- The escape hatch genuinely ran real git: `git branch --list` on the worktree afterward shows
  `orch/takeover/<run-id>` alongside `main`, with the worktree restored to `main` afterward.
- `HANDOFF.md` was genuinely written (to the run's own directory under `ORCH_HOME`, per
  `runPaths().handoffDocument` — not to the worktree) with the real prose a person would read: what was
  attempted, that the step was stopped by a steering command and never re-run, that nothing was merged
  or thrown away, which branch and commit the work landed on, and how to pick it back up
  (`git checkout orch/takeover/<run-id>`).

## Conclusion

All three claims in the closing instruction hold against a real run, not just against isolated unit
coverage: a kill mid-run halts the system cleanly (`killed`/`killed`, no stuck state), the event log
stays intact and exactly-once under a live stop, and the escape hatch produces a real, checked-out-able
branch and a genuinely legible hand-off document. `threat-model.md`'s closing line is now satisfied as
a performed exercise, not only as tested mechanisms in isolation.
