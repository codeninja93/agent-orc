---
title: 'Profile loader, precedence rules, and agent roster discovery'
type: 'feature'
created: '2026-09-22'
status: 'done'
review_loop_iteration: 0
followup_review_recommended: true
baseline_revision: 'd913599'
context:
  - '{project-root}/docs/planning-artifacts/architecture/architecture-agent-orcastrator-2026-09-19/ARCHITECTURE-SPINE.md'
  - '{project-root}/docs/planning-artifacts/architecture/architecture-agent-orcastrator-2026-09-19/ADR-003-built-in-agent-tool-grants.md'
  - '{project-root}/docs/specs/spec-agent-orchestrator/memory-design.md'
  - '{project-root}/docs/specs/spec-agent-orchestrator/stories/2-1-installer.md'
deferred:
- summary: 'Four pre-existing defects in the TOML codec, carried over unchanged by the move.'
  evidence: |-
    All four reproduced against the real module, and all four are byte-identical to
    `d913599:src/installer/toml.ts`, so they are story 2-1's and not this story's — but the engine now
    parses `profile.toml` at run start, so they are newly reachable.
    (1) `stripComment` cannot tell an escaped quote from a quote following an escaped backslash, so
    `path = "C:\repo\" # comment` is refused as "an unterminated string". `splitArrayItems` is identical.
    (2) A multi-line string is silently mis-read rather than named: a `"""..."""` value parses as a string
    of embedded quotes, against the docblock's promise of a named refusal. A float, a datetime and a
    single-quoted literal all fall to one generic message.
    (3) Two adjacent quoted strings parse instead of being refused: `k = "a" "b"` yields `a" "b`.
    (4) A duplicate `[table]` header merges silently while a duplicate key is refused; TOML makes both
    errors. The `__proto__` pollution in the same file was fixed in this round rather than deferred.
  location: src/contracts/toml.ts
  severity: medium
- summary: 'The failed-run-scope-resolve cleanup is implemented but not covered, and deliberately so.'
  evidence: |-
    On a failed run-scope resolve the snapshot directory is removed before rethrowing, so a profile edited
    inside the copy window cannot wedge the run for ever. The trigger is an edit landing between the
    project-scope validation and the byte copy, inside one synchronous call, and it is not reachable from
    an external fixture: every other route either gets pruned before the copy or fails earlier in it. The
    first attempt at a test for it passed with the `rmSync` deleted — it never reached the copy window — so
    it was removed rather than shipped as coverage that cannot fail. Covering it needs an injectable reader
    or a post-copy hook, which is a design change rather than a fix.
  location: src/engine/config-snapshot.ts
  severity: medium
- summary: 'The loader evaluates no decay policy, applies colliding entries, and entries carry no id.'
  evidence: |-
    `memory-design.md:68` gives decay to "a periodic sweep [that] samples entries, checks anchors still
    resolve, and flags the dead", so a loader that ignores `decay_policy` is the design rather than a
    defect. What is fair in the finding: nothing records that decay was *not* evaluated, two entries on one
    anchor with contradictory claims are both applied silently, and an entry has no stable id, so stage 5's
    sweep will have nothing to key on but `(anchor, recorded_at)`.
  location: src/engine/profile.ts
  severity: low
- summary: 'Conventions discovery is the two root instruction files only, and the text is uncapped.'
  evidence: |-
    `INSTRUCTION_FILE_NAMES` is `['CLAUDE.md','AGENTS.md']`, which matches AD-16's letter. Whether
    `.claude/CLAUDE.md`, `CLAUDE.local.md` and nested per-directory files also bind is an AD-level question
    this story should not settle alone — but since "speaks to this anchor" decides precedence, a convention
    stated in a file the loader does not read silently loses to a profile entry. Separately there is no
    size cap: the whole text is read, copied into the snapshot and handed to every step.
  location: src/engine/conventions.ts
  severity: low
- summary: 'Three low-severity consequences of the precedence machinery having no producer yet.'
  evidence: |-
    From the intent-alignment layer, all three verified and all three following from the section being
    optional and unwritten. (1) Every non-empty precedence assertion is fed by
    `tests/helpers/config-fixture.ts`, because the installer emits no entries. (2) "The repository's
    instructions win" has no observable win beyond `stale[]` and sentences in summaries:
    `RepositoryConventions` carries no rules field by design, and `ResolvedKnowledge.applied` is returned
    and never consumed. (3) Anchor discipline is asserted mostly at the schema — the matrix 9/10 block
    calls `KnowledgeEntrySchema.safeParse` directly and one test routes a refusal through `loadProfile`.
  severity: low
- summary: 'Duplicated helpers, including a tenth copy of the atomic-write idiom.'
  evidence: |-
    `count()` is defined in both `src/engine/profile.ts` and `src/engine/roster.ts`. The temp-write /
    fsync / rename / fsync-directory helper is not a fourth copy but a tenth: `renameSync` appears in ten
    files across `src/`. Consolidating it is a cross-story refactor, not this story's fix — but the
    argument this story made for moving the TOML codec ("a second implementation of the parser is the thing
    that must never exist") applies to it with equal force.
  severity: low
- summary: 'Two pieces of scope beyond the verbatim intent for 2-3.'
  evidence: |-
    The intent in `stories.yaml` names the profile loader, the precedence rule and roster discovery. It
    does not mention AD-9's run-start snapshot, which is 278 source lines and the largest new test file —
    that came from this spec, citing AD-9's requirement that nothing was meeting. Nor does it mention the
    TOML codec move, which is in neither the intent nor the original Code Map. Both are defensible and both
    are recorded; the point is that the spec widened the intent rather than the implementer widening the
    spec.
  severity: low
- summary: 'Review pass 1 ran all four layers; one implemented branch remains uncovered.'
  evidence: 'Blind-hunter, edge-case, verification-gap and intent-alignment all reported: 46 findings,
    triaged high 4 / medium 29 / low 11 / false 2, routed 23 patch / 4 bad_spec / 13 defer / 6 reject. All
    23 patches applied and verified, and the three bad_spec causes were amended into the spec and then
    implemented. `followup_review_recommended` is true because a `high` was patched. Supersedes this
    entry''s original text, which said no review layer had run.'
  severity: low
- summary: 'The TOML codec moved to `src/contracts/toml.ts`; `src/installer/toml.ts` is now a re-export.'
  evidence: 'Not in the Code Map. The engine must read `profile.toml` and `agents/*.toml`, and
    `tests/engine.reconciler.test.ts` asserts every `src/engine/` file imports only `../contracts/`,
    `../runtime/` and `node:` builtins. Verified independently: `parseToml` and `serialiseToml` are each
    defined exactly once, both in `src/contracts/toml.ts`, and no file under `src/engine/` imports the
    installer. The alternative — relaxing the engine guard to admit `../installer/toml.js` — was rejected
    because it opens the edge that makes importing `BUILT_IN_AGENTS` a one-line change.'
  location: src/contracts/toml.ts
  severity: medium
- summary: 'The config snapshot carries no schema of its own; it is a verbatim byte copy.'
  evidence: 'AD-28 requires every on-disk artifact to be versioned. Rather than invent a
    `run.config_snapshot` schema, the snapshot copies `profile.toml` and `agents/*.toml` byte for byte —
    artifacts that already carry `schema_version` — under the same file names as `.orch/`. Verified: the
    writer only ever `readFileSync`s and writes; it never re-serialises, so the snapshot cannot drift from
    what was on disk at run start. The consequence is deliberate: one reader serves both scopes, so
    `loadProfile`/`discoverRoster` cannot tell which scope they were handed, and `readStepConfiguration`
    has no parameter a repository path could enter through. That is what keeps a step out of `.orch/`
    structurally rather than by discipline. Whether AD-28 wants the snapshot versioned as a unit anyway is
    a spine question.'
  location: src/engine/config-snapshot.ts
  severity: medium
- summary: 'A refused roster entry does not fail run start; whether it should is undecided.'
  evidence: 'Matrix 12 requires the remaining agents to load when one file is malformed, so discovery
    reports the refusal on `snapshot.roster.refused` and continues. No AD fixes whether a run may begin
    with an agent the roster could not parse — a run that needs that agent will fail later and further
    from the cause. The snapshot copies every roster file including the refused one, so the refusal is at
    least not silently dropped.'
  location: src/engine/roster.ts
  severity: medium
- summary: 'Three encodings were chosen where AD-16 and `memory-design.md` name a vocabulary but not a form.'
  evidence: '(1) "Both speak to the same anchor" is a whole-token, case-sensitive occurrence of the anchor
    symbol in the instruction text, with boundaries judged by adjacent characters rather than a regex built
    from data. It errs toward flagging — a document that merely mentions the anchor wins — which is the only
    safe direction given AD-16 forbids silently applying a contradicted entry, and it parses no prose.
    (2) `decay_features` is required and must be 0 unless the policy is `n-features`, so "there is no N" and
    "nobody recorded one" stay distinguishable. (3) A second `takeConfigSnapshot` copies nothing and returns
    `already_taken`, and the profile is written last, so a crash mid-snapshot leaves one the next attempt
    completes rather than one it trusts.'
  severity: low
- summary: 'Nothing writes a knowledge entry yet, so the precedence rule is exercised only by fixtures.'
  evidence: 'The section is optional and story 2-1 writes none — the installer-driven test asserts
    `resolved.profile.knowledge` is `undefined`. Entries arrive with the bootstrap agent in stage 5, which
    is the first point at which the stale-flagging path meets an entry a person wrote rather than one a test
    planted.'
  severity: low
---

# Story 2-3 — Profile loader, precedence rules, and agent roster discovery

## Intent

**Problem:** story 2-1 writes `.orch/profile.toml` and `.orch/agents/*.toml`, and nothing reads them. The
engine has no way to learn a repository's test command, and no way to learn which agents exist — so every
later roster story would have to invent its own reader, which is the two-sources-of-truth failure AD-16 and
AD-17 exist to prevent. AD-9 also requires a per-run configuration snapshot that nothing takes.

**Approach:** add the profile loader with AD-16's fixed precedence, the roster discovery AD-17 requires, and
AD-9's run-start config snapshot. The engine learns mechanics from the profile, defers to the repository on
conventions, and discovers agents by reading a directory — holding no list of its own.

## Boundaries & Constraints

**Mechanics and conventions are different questions, and only one of them can conflict.** The profile is
authoritative for mechanics — the four commands, the package manager, the layout, resource needs, risk tiers,
conflict domains — and nothing in a `CLAUDE.md` competes with it, because prose does not declare a test
command in a form anything can read. Conventions are the reverse: the repository's own instructions win, and
the loader's job there is to pass the text through, not to parse it. **A loader that tried to extract rules
from prose would be inventing the conflict it exists to resolve.**

**"Both speak to the same point" has to be mechanical, so it is decided by anchors.** AD-16 requires a
contradicted profile entry to be *flagged stale rather than silently applied* — and a loader cannot judge
semantic contradiction. What makes it decidable is the structure AD-16 already requires of a knowledge entry:
provenance, a decay policy, and an anchor that a sweep can check. So an entry declares the anchor it speaks
to, and it is flagged stale when the repository's instructions speak to that same anchor. Anchors are symbols
rather than paths and never line numbers, per `memory-design.md`.

**Nothing writes a knowledge entry yet, and the mechanism is still this story's.** The profile story 2-1
writes carries `project`, `mechanics` and `risk` and no knowledge section; entries arrive with the bootstrap
agent in stage 5. Building the precedence machinery here anyway is deliberate: the loader is the only place it
can live, and a later story adding entries should not also have to invent what happens when one contradicts
the repository. Said plainly so a reader knows this path is exercised by tests and not yet by a run.

**The engine holds no roster.** AD-17: "the engine discovers agents only by reading that directory and holds
no compiled-in list." Story 2-1 has a `BUILT_IN_AGENTS` array — the installer's template for what to *write* —
and ADR-003 just pinned it with tests, which makes it more tempting to reuse, not less. The engine must not
import it. That is a guard test over imports, in the shape stage 1 used for `src/tui/`, and it must recurse:
a non-recursive version of that guard silently stopped covering 44% of its directory when a subdirectory
appeared.

**A config snapshot is taken once, and a live run never sees an edit.** AD-9: the snapshot in
`runs/<run-id>/config/` is the only configuration any step of that run reads, and mid-run edits to `.orch/`
never affect it. So the loader has two distinct callers — run start, which snapshots, and a step, which reads
the snapshot — and a step reading `.orch/` directly is the defect this arrangement exists to prevent.

**A roster entry's contract id and tool grant are already constrained.** AD-17 requires a reference to a
*registered* contract id, never an inline schema; ADR-003 requires every granted tool name to be a declared
name. Both are already enforced at parse by the schemas story 2-1 shipped, so discovery validates by parsing
rather than by re-checking — and an entry naming an unregistered contract is refused with the registry's own
list, as the installer already does.

**Not in this story.** No agent behaviour — 2-4 through 2-7 implement the agents this discovers. No bootstrap
authoring (5-5). No memory content or decay sweep (5-1, 5-2): entries carry a decay policy here because AD-16
requires the field, and acting on it is not this story's. No profile editing: the installer writes it and a
person edits it by hand.

**What anchor-based precedence cannot do, stated so it is not overclaimed.** Deciding "the same point" by
anchor catches a contradiction the repository states *about the anchor the entry declares*. It does not catch
one stated under a different anchor: an entry claiming X, and a `CLAUDE.md` contradicting X while naming
something else, both pass. That is a real limit of the mechanism and not a bug in it — the alternative is
judging prose, which a loader cannot do. The consequence to accept is that AD-16's "a contradicted entry is
flagged" holds for anchor-addressable contradictions only, and the error direction is toward flagging.

## I/O & Edge-Case Matrix

| # | Input | Expected |
|---|---|---|
| 1 | A `.orch/` written by the installer | The profile loads, mechanics are available, and the roster is the agents on disk |
| 2 | No `.orch/` at all | Refused naming what to run to create it, never a silent default profile |
| 3 | A profile carrying an unrecognised `schema_version` | Refused with `config.schema_version_unrecognised`, as every versioned artifact is |
| 4 | A repository with a `CLAUDE.md` | Its text is available as authoritative for conventions, unparsed |
| 5 | A repository with `AGENTS.md` and no `CLAUDE.md` | Same, from whichever exists; both present is not an error |
| 6 | A repository with neither | Conventions are absent, and the profile's mechanics still load |
| 7 | A knowledge entry whose anchor the repository's instructions also speak to | Flagged stale, not applied, and the flag names the anchor and the instruction file |
| 8 | A knowledge entry whose anchor nothing else speaks to | Applied, carrying its provenance and decay policy |
| 9 | A knowledge entry with no anchor | Refused at parse: an entry nothing can check is an entry nothing can flag |
| 10 | A knowledge entry anchored on a line number | Refused: `memory-design.md` forbids line numbers as anchors |
| 11 | `.orch/agents/` holding three TOMLs | Exactly those three agents, in a deterministic order |
| 12 | An agent TOML naming an unregistered contract id | Refused naming the registered ids, and the other agents still load |
| 13 | An agent TOML granting a tool ADR-003 does not declare | Refused at parse |
| 14 | An agent TOML whose id disagrees with its file name | Refused: one entry cannot have two names |
| 15 | `.orch/agents/` empty or absent | An empty roster, said plainly — not a built-in default |
| 16 | The engine's own source | Nothing under it imports the installer's `BUILT_IN_AGENTS`, checked recursively |
| 17 | Run start | A snapshot is written under `runs/<run-id>/config/`, carrying **all three artifacts AD-9 names** — the profile, the roster and `permissions.toml` — plus the conventions text |
| 18 | `.orch/` edited after a snapshot exists | The snapshot is unchanged and a step reads the snapshot's values, not the new ones |
| 19 | A snapshot attempt that fails part-way | No `profile.toml` is left behind, so the next attempt re-takes rather than trusting a partial snapshot |
| 20 | A snapshot resumed after a failed attempt | It carries what `.orch/` holds now — a file deleted between attempts is gone from the snapshot too |
| 21 | A stale `*.tmp` under `config/` | Excluded from the snapshot's reported files; it is debris, not configuration |
| 22 | `.orch/agents/` present but unreadable | A named refusal, never an empty roster — absent and unreadable are different answers |
| 23 | `orch init` re-run over a profile carrying knowledge entries | The entries survive: AD-16 makes the section additive and AD-12 makes an upgrade a re-run |
| 24 | An anchor with surrounding whitespace | Refused or normalised, never stored padded — a padded anchor is one nothing can ever match |
| 25 | A `[__proto__]` table in a hand-edited profile | Refused; parsing a profile never reaches `Object.prototype` |

## Code Map

| File | Change | Why |
|---|---|---|
| `src/contracts/knowledge.ts` | new | The knowledge entry: anchor, provenance, decay policy — AD-16's required fields, in `memory-design.md`'s vocabulary. AD-2 puts every schema in code. |
| `src/contracts/installer.ts` | modify | `ProfileSchema` gains the optional knowledge section. Optional because every profile written so far has none. |
| `src/engine/profile.ts` | new | Load, apply AD-16's precedence, produce the resolved configuration. |
| `src/engine/conventions.ts` | new | Read `CLAUDE.md`/`AGENTS.md` as text and answer which anchors they speak to — the one question precedence needs. |
| `src/engine/roster.ts` | new | Discovery by directory read; the spine's layout names "roster discovery" in the engine. |
| `src/engine/config-snapshot.ts` | new | AD-9's run-start snapshot, and the step-side reader. |
| `src/runtime/paths.ts` | modify | The snapshot's path beside the other `ORCH_HOME` names. |
| `src/installer/write.ts` | modify | `renderProfile` must carry an existing knowledge section through a re-run; AD-12 makes an upgrade a re-run and AD-16 makes the section additive. |
| `src/contracts/toml.ts` | modify | Refuse `__proto__`/`constructor`/`prototype` as keys. Pre-existing, but the engine now parses `profile.toml` at run start. |
| `tests/engine.profile.test.ts` | new | Matrix 1–3, 7–10. |
| `tests/engine.conventions.test.ts` | new | Matrix 4–6. |
| `tests/engine.roster.test.ts` | new | Matrix 11–16, including the recursive import guard. |
| `tests/engine.config-snapshot.test.ts` | new | Matrix 17, 18. |

## Tasks & Acceptance

1. **Load the profile, versioned and refused rather than defaulted.**
   - **Given** a `.orch/` the installer wrote, **when** the profile is loaded, **then** the four commands, the
     package manager, the layout, resource needs and the risk tiers are available.
   - **Given** no `.orch/`, **when** a load is attempted, **then** it is refused naming what creates one, and
     no default profile is invented.
   - **Given** an unrecognised `schema_version`, **when** it is read, **then** it is refused carrying
     `config.schema_version_unrecognised`.

2. **Pass conventions through, unparsed.**
   - **Given** a repository with a `CLAUDE.md`, **when** conventions are read, **then** its text is available
     verbatim and nothing has tried to extract rules from it.
   - **Given** a repository with neither instruction file, **when** conventions are read, **then** they are
     absent and mechanics still load.

3. **Decide precedence by anchor.**
   - **Given** a knowledge entry whose anchor the repository's instructions also speak to, **when** the
     profile is resolved, **then** the entry is flagged stale, is not applied, and the flag names both the
     anchor and the file that overrode it.
   - **Given** an entry whose anchor nothing else speaks to, **when** the profile is resolved, **then** it is
     applied carrying its provenance and decay policy.
   - **Given** an entry with no anchor, or one anchored on a line number, **when** it is parsed, **then** it
     is refused.

4. **Discover the roster by reading the directory, and hold no list.**
   - **Given** three agent TOMLs, **when** the roster is discovered, **then** exactly those three load, in a
     deterministic order.
   - **Given** an entry naming an unregistered contract id, **when** it is read, **then** it is refused naming
     the registered ids, and the other entries still load.
   - **Given** an empty or absent `.orch/agents/`, **when** the roster is discovered, **then** it is empty and
     says so — never a built-in default.
   - **Given** the engine's source, **when** its imports are walked **recursively**, **then** nothing under it
     imports the installer's built-in roster.

5. **Snapshot the configuration once at run start.**
   - **Given** a run starting, **when** the snapshot is taken, **then** `runs/<run-id>/config/` carries the
     profile, the roster and the conventions text.
   - **Given** `.orch/` edited after the snapshot, **when** a step reads its configuration, **then** it reads
     the snapshot's values and the snapshot is unchanged.

## Spec Change Log

### 2026-09-22 — amended by review pass 1 (three `bad_spec` root causes)

**Triggering findings.** BH1/EC19 — the snapshot omitted `permissions.toml`. VG4 — a second `orch init`
erased the profile's knowledge section. IA3.1 — the anchor mechanism was presented as satisfying AD-16
without its limit stated.

**What was amended.** Matrix row 17 now names all three artifacts AD-9 lists rather than enumerating two of
them plus the conventions. Rows 19–25 were added for the states the first pass left unasserted: a part-way
failure, a resumed snapshot, `*.tmp` debris, an unreadable agents directory, a re-run over a profile carrying
entries, a padded anchor, and a `[__proto__]` table. Boundaries gained a paragraph stating what anchor-based
precedence cannot catch. The Code Map gained `src/installer/write.ts` and `src/contracts/toml.ts`.

**The known-bad state avoided.** Matrix row 17's original wording — "the profile, the roster and the
conventions text" — is what the implementation faithfully built, and AD-9's Rule names `profile.toml`,
`agents/*.toml` **and** `permissions.toml` while calling the snapshot "the only configuration any step of
that run reads". A snapshot missing one of the three either denies a step that artifact or sends it to live
`.orch/`, which is the one thing the snapshot exists to prevent. The spec, not the code, drew the line wrong.

**KEEP instructions — what worked and must survive.** (1) The snapshot stays a **verbatim byte copy** under
the same file names as `.orch/`, so one reader serves both scopes and `readStepConfiguration` keeps having no
parameter a repository path could enter through; that structural guarantee is the best thing in the story.
(2) The recursive import guard in `tests/engine.roster.test.ts`, including its comment-stripping, its
positive control, and the fixture tree that demonstrates what a flat listing misses. (3) The conventions
pass-through: `RepositoryConventions` must keep having no field an extracted rule could live in. (4) The
matrix-15 behavioural tests, which are name-agnostic and caught an inlined roster with no import. (5) The
single TOML parser — one implementation, `src/installer/toml.ts` as a re-export. (6) The premise tests that
prove two fixture sources are genuinely distinct before asserting which one wins.


## Review Triage Log

### 2026-09-22 — Review pass
- verdicts: 46 findings — high 4, medium 29, low 11, false 2, maybe-false 0
- findings:
  - `[medium]` `[bad_spec]` BH1 — the snapshot omits `permissions.toml` — AD-9's Rule names `profile.toml`, `agents/*.toml` and `permissions.toml` as the three artifacts the installer writes and calls the snapshot "the only configuration any step of that run reads"; `src/installer/write.ts:190` writes it and `runConfigPaths` has no path for it. Matrix row 17 enumerated three items and left it out, so the spec settled the question wrongly. Invisible to the suite because the fixture hand-builds `.orch/` and pins its listing at `tests/engine.config-snapshot.test.ts:380`.
  - `[medium]` `[defer]` BH2 — `stripComment` mis-tracks an escaped backslash, refusing valid TOML — reproduced: `path = "C:\\repo\\" # comment` throws "an unterminated string (line 1)". Pre-existing: byte-identical to `d913599:src/installer/toml.ts`.
  - `[medium]` `[defer]` BH3 — a multi-line string is silently mis-read rather than named — reproduced: `claim = """hello"""` parses to `{"claim":"\"\"hello\"\""}`, against the docblock's promise of a named refusal. Pre-existing, byte-identical.
  - `[high]` `[patch]` BH4 — a padded anchor is an entry nothing can ever flag — reproduced by me against a fixture whose positive control I verified first: `anchor: '  resolveProject  '` parses, stores the padding verbatim, and `mentionsSymbol('we use resolveProject here', '  resolveProject  ')` is `false`, so the entry lands in `applied` for ever. That is the one outcome AD-16 forbids, reached through the hole the blank-anchor refusal was written to close.
  - `[medium]` `[patch]` BH5 — a resumed snapshot is a hybrid of two points in time — the completing call copies what `.orch/` holds now into a `config/` it never clears, so a file deleted from `.orch/` between attempts persists and `readStepConfiguration` hands the step an agent the repository no longer declares.
  - `[low]` `[reject]` BH6 — `existsSync(target.profile)` then copy is check-then-act, with `createFileExclusively` unused — AD-30 permits one engine per ORCH_HOME and run ids are engine-minted ULIDs, so two concurrent starts for one run id is not a state shown reachable; the fix adds a guard over that unreachable state.
  - `[medium]` `[patch]` BH7 — crash debris is reported as snapshot content and a failed rename leaks its temp — a planted `agents/analysis.toml.99999.1.tmp` comes back inside `snapshot.files`, and `writeSnapshotFile` has no `try/finally` unlinking the temp when `renameSync` throws.
  - `[medium]` `[patch]` BH8 — unreadable is silently reported as absent, in `rosterFileNames` and `snapshotFiles` — both swallow the error and return `[]`, so EACCES on `.orch/agents/` reads to a person as "No agents are declared … the engine holds no built-in list to fall back to". No test reaches either catch.
  - `[medium]` `[patch]` BH9 — the line-number refusal covers only terminal forms, and `anchor_kind` is read by nothing — probed: `src/foo.ts:42-58`, `foo.ts(42)`, `foo.ts#42`, `src/foo.ts:L42`, `src/a.ts:42 in the handler` and `a.ts@42` all parse, because `:\d+$` is end-anchored and `#L\d+` requires the `L`. `anchor_kind` is left as declared: it is justified for stage 5's sweep, and deleting it is not this story's call.
  - `[low]` `[defer]` BH10 — the loader evaluates no decay policy, applies colliding entries, and entries carry no stable id — `memory-design.md:68` gives decay to "a periodic sweep [that] samples entries, checks anchors still resolve, and flags the dead", so the loader ignoring it is the design; what is fair is that nothing records decay was not evaluated, and stage 5 will want an id to key on.
  - `[low]` `[defer]` BH11 — duplicated helpers — `count()` is defined in both `src/engine/profile.ts:226` and `src/engine/roster.ts:160`. The atomic-write helper is not a fourth copy but a tenth: `renameSync` appears in ten files across `src/`, so consolidating it is a cross-story refactor rather than this story's fix.
  - `[medium]` `[patch]` BH12 — the serialiser can emit a file the loader rejects, and duplicate `[table]` headers merge silently — reproduced: `serialiseToml({a: 1, knowledge: {entries: undefined}})` returns `"a = 1\n\n[knowledge]\n"`, which is precisely the empty table the new docblock says must differ from absent, and `ProfileSchema` then refuses it on read-back. The duplicate-header half (`[a]\nx=1\n[a]\ny=2` → `{a:{x:1,y:2}}`) is pre-existing and deferred with BH2/BH3.
  - `[low]` `[defer]` BH13 — conventions discovery is the two root files only, with no size cap — `INSTRUCTION_FILE_NAMES` is `['CLAUDE.md','AGENTS.md']`, which matches AD-16's letter; whether `.claude/CLAUDE.md`, `CLAUDE.local.md` and nested files also bind is an AD-level question, and the whole text is read, snapshotted and handed to every step uncapped.
  - `[medium]` `[patch]` BH14 — a user-facing refusal prints a literal placeholder — `src/engine/profile.ts:112` tells a person to run `npx github:<owner>/<repo> init`. Everywhere else that string sits inside a doc comment; this is the first place it is shown to someone instructed to run it.
  - `[low]` `[patch]` BH15 — the snapshot fixtures' run ids are not ULIDs though the comment says they are — `'01K5ZQ4RUNIDFIXTUREAA'` and `'01K5ZQ4RUNIDFIXTUREBB'` are 21 characters and contain `I` and `U`, which Crockford base32 excludes, against `ULID_LENGTH = 26`. They pass only because `runPaths` applies `assertSafePathSegment`, so the suite would not catch a reader that validated the id.
  - `[high]` `[defer]` EC1 — `[__proto__]` in a hand-edited profile pollutes `Object.prototype` process-wide — reproduced: `parseToml('[__proto__]\nx = 1\n')` returns a table with no own keys and leaves `({}).x === 1`. Pre-existing and byte-identical to story 2-1's parser, but newly reachable from the engine, which now reads `profile.toml` at run start. Recorded at high severity despite the defer.
  - `[medium]` `[defer]` EC2 — escaped-backslash mis-tracking in `stripComment`, and identically in `splitArrayItems` — same defect as BH1's sibling BH2; pre-existing.
  - `[medium]` `[defer]` EC3 — two adjacent quoted strings parse instead of being refused — reproduced: `k = "a" "b"` yields `{"k":"a\" \"b"}`, against the module's claim that it refuses rather than guesses. Pre-existing.
  - `[medium]` `[defer]` EC4 — a duplicate `[table]` header merges while a duplicate key is refused — reproduced; TOML makes both errors. Pre-existing.
  - `[medium]` `[patch]` EC5 — the empty-table branch emits a header for a table whose every value is `undefined` — same root cause as BH12's first half; caused by this story's `if (value === undefined) continue`.
  - `[high]` `[patch]` EC6 — the anchor is never trimmed — same root cause as BH4; independently reproduced by two layers and then by me.
  - `[medium]` `[patch]` EC7 — `LINE_NUMBER_ANCHOR_PATTERNS` misses ranges and other separators — same root cause as BH9.
  - `[medium]` `[patch]` EC8 — `readConventions` lets a raw fs error escape with no disposition code — `readFileSync` at the `isFile` check is unwrapped, so an EACCES or a file deleted between the two calls escapes `readConventions`, `resolveProfile` and `takeConfigSnapshot` carrying no AD-35 code for the disposition table to route.
  - `[medium]` `[patch]` EC9 — `loadProfile` lets EISDIR, EACCES and `TomlParseError` escape uncoded — `existsSync` gives `ProfileNotFound` and `parseVersionedArtifact` carries the `schema_version` code, but the `readFileSync` and `parseToml` between them do not, so a `profile.toml` that is a directory or unreadable reaches callers with nothing to route on.
  - `[medium]` `[patch]` EC10 — a hyphen is not an identifier character, so a kebab-case name over-matches — reproduced: `mentionsSymbol('see migration-review docs', 'review')` is `true` while the underscore form is `false`, so a document naming only `migration-review` flags an entry anchored on `review` stale and the person loses a good entry.
  - `[medium]` `[patch]` EC11 — an aborted attempt's files survive into the completing snapshot — same root cause as BH5.
  - `[low]` `[reject]` EC12 — the snapshot is not claimed atomically — same root cause as BH6, rejected on the same AD-30 reasoning.
  - `[low]` `[reject]` EC13 — a roster file removed mid-copy aborts the copy with an uncaught ENOENT — real, but the abort happens before the profile is written, so the next attempt re-takes; that is the designed recovery, and a per-file try/catch adds a branch over a state whose handling is already correct.
  - `[medium]` `[patch]` EC14 — a profile edited during the copy window lands unvalidated and wedges the run for ever — the bytes are copied after `resolveProfile(projectScope)` succeeded and before `resolveProfile(runScope)` runs, so a mid-copy edit leaves bytes the run-scope resolve then rejects, while `already_taken` makes every later call take the same failing path with no way out but deleting `config/`.
  - `[low]` `[reject]` EC15 — `already_taken` trusts the profile's presence and cannot notice a deleted `agents/` or `conventions/` — requires someone deleting inside `runs/<run-id>/config/` mid-run, and the fix is a manifest, which is new surface over an unlikely state.
  - `[medium]` `[patch]` EC16 — widening `TomlTable`'s index signature to admit `undefined` silently drops any undefined-valued key — before the move a caller that spelled a required field `undefined` threw; now it writes a file missing the field. Grouped with VG1: the fix pins the new contract with a test rather than redesigning the type.
  - `[medium]` `[patch]` EC17 — line-number anchors escape the refusal (filed against task 3's acceptance criterion) — same root cause as BH9/EC7.
  - `[high]` `[patch]` EC18 — a padded anchor is applied for ever (filed against task 3's acceptance criterion) — same root cause as BH4/EC6.
  - `[medium]` `[bad_spec]` EC19 — `permissions.toml` has no snapshot path, so a step needing it must read live `.orch/` — same root cause as BH1.
  - `[medium]` `[patch]` VG1 — the serialiser's `undefined`-skip is unverified; deleting the line leaves 1839/1839 green — arrives pre-verified: no TOML-codec suite exists anywhere, and no test passes a table with an explicitly-undefined key. Zod keeps a key spelled `knowledge: undefined` while dropping an absent one, so this branch's input is exactly the natural spread form.
  - `[medium]` `[patch]` VG2 — "the profile is written last" is unverified; reordering it to first leaves 1839/1839 green — arrives pre-verified: the existing test deletes `profile.toml` from a complete snapshot, which passes under any write order. With the order reversed, a part-way snapshot is reported `already_taken` and the run executes against zero agents and zero conventions with no refusal, because an empty roster is a legitimate answer.
  - `[medium]` `[patch]` VG3 — the test named "leaves no temporary behind" cannot fail — arrives pre-verified: `renameSync` is unconditional on the success path, so no successful take leaves a temp. The repo tests the opposite case three times (`engine.checkpoint.test.ts:512`, `engine.commands.test.ts:890`, `runtime.fetch-record.test.ts:368`); the snapshot has no equivalent.
  - `[medium]` `[bad_spec]` VG4 — a second `orch init` erases the profile's knowledge section — verified by me: `renderProfile` (`src/installer/write.ts:108`) carries no `knowledge` key and `writeArtifacts` rewrites `profile.toml` wholesale, so the section is reported as `altered` and restored from the manifest. AD-16 makes the section additive and AD-12 makes an upgrade a re-run, so every entry stage 5 writes is destroyed by an upgrade. Announced rather than silent, and caused by this story creating a section the installer discards.
  - `[medium]` `[bad_spec]` IA3.1 — a token occurrence of the anchor stands in for "these two statements disagree", and the false-negative direction is pinned as intended — the test `decides nothing from the claim text, only from the anchor` writes a claim that contradicts `CLAUDE.md` in plain English under a different anchor and asserts it is **applied**. So the anchor mechanism cannot satisfy AD-16 in general, not merely imprecisely.
  - `[low]` `[defer]` IA3.2 — the precedence surface has no producer — the section is optional, the installer emits none, and every non-empty precedence assertion is fed by `tests/helpers/config-fixture.ts`. Already recorded as a deferred entry.
  - `[low]` `[defer]` IA3.3 — "the repository's instructions win on conventions" has no observable win — `RepositoryConventions` carries no rules field by design, and `ResolvedKnowledge.applied` is returned and never consumed, so winning shows up only as `stale[]` and as sentences in summaries.
  - `[low]` `[defer]` IA3.4 — anchor discipline is asserted at the schema, not through the loader — the matrix 9/10 block calls `KnowledgeEntrySchema.safeParse` directly and exactly one test routes a refusal through `loadProfile`.
  - `[medium]` `[defer]` IA3.5 — scope beyond the verbatim intent — the AD-9 snapshot (278 source lines, 395 test lines) is named nowhere in the intent, and the TOML codec move is in neither the intent nor the Code Map. The snapshot is specified by AD-9 and by my matrix rows 17–18; the codec move is already a deferred entry.
  - `[false]` `[reject]` IA3.6 — "discovered from a location the intent does not name" — refuted: the snapshot is a verbatim byte copy, asserted by `copies the bytes rather than re-serialising them`, and I confirmed the writer only ever reads bytes and writes them. The roster a step discovers is the same bytes `.orch/agents/` held at run start.
  - `[medium]` `[patch]` IA3.7 — an unreadable agents directory reads as an empty roster, untested — same root cause as BH8.
  - `[false]` `[reject]` IA3.8 — "a roster inlined under another name passes the guard" — refuted: the matrix-15 test asserts `expect(roster.agents).toHaveLength(0)` against an empty directory, which is name-agnostic, and opens with `expect(BUILT_IN_AGENT_IDS.length).toBeGreaterThan(0)` so it cannot pass by iterating an empty list. My own mutation inlined the list with no import and three tests still failed.

- actions taken, per routed row:
  - BH1, EC19 `[bad_spec]` — amended matrix row 17 to name all three artifacts AD-9 lists; then implemented: `permissions.toml` is copied byte-for-byte, `RunConfigPaths` and `ConfigurationSource` gained its path, and the fixture now builds a `.orch/` containing it so the omission is visible. Pinned: dropping it from the copy set fails row 17 and the bytes test.
  - VG4 `[bad_spec]` — amended: new matrix row 23, and `src/installer/write.ts` added to the Code Map. Implemented: `existingKnowledge` reads the section already on disk and `renderProfile` carries it through, leniently, so an unrecognised section carries nothing forward rather than refusing an install. Pinned: dropping the carried section fails row 23.
  - IA3.1 `[bad_spec]` — amended: the Boundaries section now states what anchor precedence cannot catch — a contradiction stated under a different anchor — so AD-16's guarantee is not overclaimed. No code change; the limit was the thing missing.
  - BH4, EC6, EC18 `[patch]` — a padded anchor is now refused rather than trimmed, because `.transform()` cannot be exported to JSON Schema and `installer.profile` is exported (AD-2). New matrix row 24. Pinned by 5 tests.
  - BH9, EC7, EC17 `[patch]` — the line-number pattern set was replaced, then corrected twice: the first version was end-anchored and let six spellings through; the replacement was unanchored and refused `zod@4`, `react@18.2.0` and `timeout:5000`. The rule now turns on a file extension. Both directions are pinned and the accept table grew from 5 entries to 18.
  - EC10 `[patch]` — `-` added to `IDENTIFIER_CHARACTER`, so `migration-review` is one name and no longer counts as a mention of `review`. Pinned.
  - BH5, EC11 `[patch]` — the copy set is built before any write and `pruneStaleEntries` removes every existing file under `config/` the new set will not replace. Pruning by set rather than clearing the directory is deliberate: it leaves a directory obstructing a copy-set path in place, so the write fails loudly instead of being cleared away. New matrix row 20. Pinned.
  - VG2 `[patch]` — new matrix row 19, pinned by injecting a mid-copy failure with `fs` alone (a directory pre-created at a copy-set path so `renameSync` throws), then asserting the call threw, no `profile.toml` was left behind, the rest of the partial snapshot is still there, and a later call reports `taken`.
  - BH7, VG3 `[patch]` — `snapshotFiles` excludes `*.tmp` over a new unfiltered `snapshotEntries` that pruning uses, and `writeSnapshotFile` gained a `try/finally` unlinking its temp when the publish fails. New matrix row 21, pinned by planting a stale temp into a complete snapshot so nothing clears it and the exclusion has to do the work.
  - BH8, IA3.7 `[patch]` — `rosterFileNames` throws `RosterDirectoryUnreadable` when the directory exists and cannot be listed; `discoverRoster` catches it into `refused` with the path, code and reason, and its summary no longer claims the engine holds no built-in list. Absent still yields an empty roster, so row 15 is unchanged. New matrix row 22, covered with a real `chmod 000` plus a guard asserting the test is not vacuous under uid 0.
  - BH12, EC5, EC16, VG1 `[patch]` — an empty table header is emitted only for a table with no keys at all, never for one whose every value is `undefined`. New `tests/contracts.toml.test.ts` pins the undefined-key omission as byte-identical to the key-absent table, the empty-table distinction, and the profile round trip — the codec had no suite at all before.
  - EC14 `[patch]` — on a failed run-scope resolve, `config/` is removed before rethrowing. Implemented, and honestly **not** pinned: see the deferred entry.
  - EC8, EC9 `[patch]` — `readConventions` wraps `readFileSync` in `ConventionsUnreadable` and `loadProfile` wraps read-and-parse in `ProfileUnreadable`, both carrying `config.invalid`, the path, and `cause` so a `TomlParseError`'s line number survives to the person.
  - BH14 `[patch]` — `ProfileNotFound` no longer prints `<owner>`/`<repo>`; it names `orch init` from inside the repository or with its path, and the test asserts the message contains neither placeholder.
  - BH15 `[patch]` — the two 21-character run-id fixtures containing `I` and `U` were replaced with real 26-character Crockford ULIDs.
  - EC1 `[defer]` — fixed anyway, at the user's direction: `FORBIDDEN_TOML_KEYS` are refused in `splitKeyPath`, covering bare keys, dotted paths, `[table]` and `[[array]]` headers alike, and tables are built with `Object.create(null)`. New matrix row 25.

## Design Notes

## Verification

Run by me after the patch round, with the suite's own exit status captured to a variable rather than piped:
`npm run typecheck && npm run lint && npm run build && npm test` — **exit 0, 1888 tests across 67 files, zero
failures, zero skips.** Baseline `d913599` was 1736 across 62; the first implementation reached 1839/66 and the
review's patches took it to 1888/67. Node pinned to v24.21.0, above the >=22.22 floor.

Mutations across both rounds, each applied, run and reverted, with the suite green afterwards and
`grep MUTATION src tests` returning nothing. First round:

| Mutation | Caught by |
|---|---|
| Roster falls back to the installer's `BUILT_IN_AGENTS` via import | 5 tests, including the pre-existing `engine.reconciler` dependency guard |
| The same fallback with the list **inlined**, so no import guard can see it | 3 tests — the behavioural matrix-15 tests, not just the import guard |
| The import guard made non-recursive | exactly 1: `catches a violation in a subdirectory, which a flat listing silently walks past` |
| A contradicted knowledge entry applied instead of flagged | 7 tests in `engine.profile` |
| A step re-resolves through `projectConfiguration(profile.project.path)` instead of reading the snapshot | 4 tests, including the structural `offers a step reader with nowhere to pass a repository path` |
| (mine) `isLineNumberAnchor` always false | 8 tests, one per refused spelling |

Patch round — eleven of twelve pins bite:

| Mutation | Caught by |
|---|---|
| Profile written **first** instead of last | rows 19 and 20 |
| The serialiser's `undefined`-skip deleted | 3 TOML tests |
| `*.tmp` filter removed from `snapshotFiles` | row 21 |
| `pruneStaleEntries` removed | row 20 |
| `permissions.toml` dropped from the copy set | row 17 and the bytes test |
| Hyphen removed from `IDENTIFIER_CHARACTER` | the kebab-case test |
| Padded-anchor refinement removed | 5 tests |
| Line-number patterns reverted to end-anchored | exactly the 6 escaping spellings |
| Line-number patterns reverted to **unanchored** | 6 tests, including the both-directions pin |
| Unreadable roster directory swallowed as absent | row 22 |
| `renderProfile` dropping the carried knowledge section | row 23 |
| `writeSnapshotFile`'s temp unlink removed | the temp-cleanup test |

The twelfth — the failed-run-scope-resolve cleanup — has no pin, and that is a deferred entry rather than
something papered over.

**Verified by me directly, not taken on report.** A positive control first in every probe, after my own first
probe was invalidated by an inexact fixture: `anchor_kind: 'symbol'` is not in the vocabulary, which made
twelve refusals meaningless until the fixture was corrected. Then: a padded anchor is refused; all 13
line-number spellings refuse and all 18 legitimate anchors are accepted, including `zod@4`, `react@18.2.0`,
`timeout:5000` and a test name carrying a version; `mentionsSymbol('see migration-review docs', 'review')` is
`false` while `migration-review` still matches itself; `__proto__`, `constructor` and `prototype` are refused
as keys, dotted paths and headers, `Object.prototype` is left clean and parsed tables are null-prototype; the
serialiser emits no `[knowledge]` for an all-undefined table and still emits one for a genuinely empty table;
`parseToml` and `serialiseToml` are each defined exactly once; no file under `src/engine/` imports the
installer; the snapshot writer never re-serialises; and `readStepConfiguration` still has no parameter a
repository path could enter through.

## Auto Run Result

**Status: done, reviewed.** The engine reads `.orch/` for the first time — mechanics from the profile,
conventions deferred to the repository, agents discovered from a directory — and AD-9's run-start snapshot now
carries all three artifacts AD-9 names.

**Files changed.** `src/contracts/knowledge.ts` (new: the entry, its anchor rules, the decay vocabulary);
`src/contracts/toml.ts` (new: the codec moved from the installer, plus the forbidden-key refusal);
`src/contracts/installer.ts` (the optional knowledge section); `src/engine/profile.ts`,
`src/engine/conventions.ts`, `src/engine/roster.ts`, `src/engine/config-snapshot.ts` (new);
`src/runtime/paths.ts` (the snapshot's paths); `src/installer/write.ts` (carry an existing knowledge section
through a re-run); `src/installer/toml.ts` (now a re-export); four new engine suites plus
`tests/contracts.toml.test.ts` and `tests/helpers/config-fixture.ts`.

**Review findings: 46 across four layers** — high 4, medium 29, low 11, false 2, maybe-false 0. Routed: 23
patch, 4 bad_spec, 13 defer, 6 reject. All 23 patches applied and verified.

**The three `bad_spec` root causes were amended in the spec and then implemented**, rather than triggering the
protocol's revert-and-re-derive cascade. That was the user's explicit decision, taken because the code was
already committed at `b9a5efd` with 1839 tests passing; it is recorded here as a deliberate deviation from the
cascade, not an oversight.

**Those three spec defects were mine, not the implementation's.** Matrix row 17 enumerated the snapshot as
"the profile, the roster and the conventions text", and the implementation built exactly that — while AD-9's
Rule names `profile.toml`, `agents/*.toml` **and** `permissions.toml` and calls the snapshot "the only
configuration any step of that run reads". The spec also said nothing about the installer preserving a
knowledge section that `renderProfile` would rewrite away, and it presented anchor-based precedence without
stating what it cannot catch.

**Rejected findings, with reasons.** Six. The check-then-act race on `existsSync`-then-copy, filed twice by two
layers: AD-30 permits one engine per ORCH_HOME and run ids are engine-minted ULIDs, so two concurrent starts
for one run id is not a state shown reachable, and the fix guards it anyway. A roster file removed mid-copy
aborting with an uncaught ENOENT: the abort happens before the profile is written, so the next attempt
re-takes, which is the designed recovery. `already_taken` not noticing a deleted `agents/` or `conventions/`:
requires deleting inside `runs/<run-id>/config/` mid-run, and the fix is a manifest. And two claims refuted
outright — that the roster is discovered from a location the intent does not name (it is a verbatim byte copy,
asserted), and that a roster inlined under another name would pass the import guard (the matrix-15 test asserts
`toHaveLength(0)`, which is name-agnostic, and a mutation that inlined the list with no import failed three
tests).

**One finding was fixed although it routed to defer**, at the user's direction: `[__proto__]` in a hand-edited
profile set `Object.prototype.x` process-wide. Byte-identical pre-existing code from story 2-1 and so formally
out of scope — but this story made it newly reachable by having the engine parse `profile.toml` at run start,
which is reason enough.

**My own verification found a defect the patch round introduced.** The replacement line-number patterns were
unanchored, so `zod@4`, `react@18.2.0` and `timeout:5000` were refused with a message claiming they named a
line number. Every one of the six newly-refused spellings had been asserted, and *nothing asserted that a
version-bearing anchor survives* — a refusal list with no accepting counterweight, which is this project's
recurring verifies-something-adjacent-to-its-claim pattern, inverted. The rule now turns on a file extension,
both directions are pinned, and the accept table grew from 5 entries to 18.

**Follow-up review recommended: true.** A `high` entry was patched — the padded anchor — which sets it on a
first pass. Patched counts by verdict: high 1, medium 20, low 2. The specific unverified risk is the
failed-run-scope-resolve cleanup: it is implemented and has no test, because the branch is not reachable from
an external fixture and the first attempt at covering it passed with the cleanup deleted.

**Residual risks.** Nothing writes a knowledge entry until the bootstrap agent in stage 5, so the whole
precedence path is still exercised only by fixtures, and the anchor match remains a token comparison standing
in for "these two sources speak to the same point" — now with its limit written into the Boundaries rather than
implied. Four pre-existing TOML codec defects are deferred with evidence. And one test was deleted during the
patch round for being unable to fail: 1888 tests that can each fail is the better number.
