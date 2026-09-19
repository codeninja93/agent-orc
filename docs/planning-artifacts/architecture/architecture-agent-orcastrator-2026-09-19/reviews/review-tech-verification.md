---
review: technology-verification
target: ../ARCHITECTURE-SPINE.md
reviewer: tech-verification
date: '2026-09-19'
method: live registry queries, official vendor docs, and empirical execution of the `claude` CLI and Zod 4.6.5 on this machine
---

# Technology Verification Review — Architecture Spine, Agent Orchestration System

Findings only. Anything not listed below was checked and holds; see the closing line.

Severity scale: **BLOCKER** (the spine as written does not work), **HIGH** (a committed decision is materially wrong or will break on a near-term upgrade), **MEDIUM** (a real constraint the spine omits that a builder will hit), **LOW** (inaccuracy or internal inconsistency).

---

## BLOCKER-1 — `z.toJSONSchema()` with no `target` produces a schema `claude -p --json-schema` rejects outright

**What the spine commits to.** AD-2: "every step contract is a Zod v4 schema exported via `z.toJSONSchema()` and passed to `claude -p --json-schema`". Consistency Conventions, Data & formats: "Every schema is defined once as a Zod v4 schema and exported with `z.toJSONSchema()`, never hand-written." Stack row: "Zod | 4.6.5 — native `z.toJSONSchema()`, no external converter."

**What is actually true.** Zod 4's `z.toJSONSchema()` defaults to `target: "draft-2020-12"` and stamps `"$schema": "https://json-schema.org/draft/2020-12/schema"` on the output. Claude Code's `--json-schema` validator is draft-07 and rejects a schema that declares a newer draft.

Anthropic states this explicitly: *"The SDK validates schemas with JSON Schema draft-07, so schemas that declare a newer version are rejected. Zod targets draft 2020-12 by default, so pass `target: "draft-7"` when converting your schema."*
— https://code.claude.com/docs/en/agent-sdk/structured-outputs

Reproduced on this machine (zod 4.6.5, claude 2.1.278):

```
$ node -e "... z.toJSONSchema(S)"
{"$schema":"https://json-schema.org/draft/2020-12/schema", ...}

$ claude -p "x" --json-schema '{"$schema":"https://json-schema.org/draft/2020-12/schema", ...}'
Error: --json-schema is not a valid JSON Schema: no schema with key or ref "https://json-schema.org/draft/2020-12/schema"
```

The same schema with `{"$schema":"http://json-schema.org/draft-07/schema#"}` runs to a successful result. So this is not a subtlety — the literal call the spine mandates fails at process start, before any model request, on every step.

**What the spine must say instead.** The exported form is `z.toJSONSchema(schema, { target: "draft-7" })`. Because AD-1 makes `--json-schema` the sole step-contract mechanism and AD-2 makes Zod the sole schema source, this argument is an invariant, not a call-site detail — it belongs in the AD-2 rule text and in the Consistency Conventions row, otherwise two units will export schemas two ways and one half of the system will fail to spawn.

---

## BLOCKER-2 — AD-12's `npx github:<owner>/<repo> init` is blocked by default in the very npm the spine pins

**What the spine commits to.** AD-12: "`npx github:<owner>/<repo> init` is the only supported way to onboard a project — not clone-and-run and not a published npm package." Stack row: "npm | 12.x".

**What is actually true.** npm v12 changed three install defaults specifically to close git/remote code-execution paths:

- *"`--allow-git` defaults to `none`: npm install will no longer resolve Git dependencies (direct or transitive) unless explicitly allowed via `--allow-git`."*
- *"Allow Scripts Defaults to Off"* — `preinstall`/`install`/`postinstall` from dependencies no longer run, and *"`prepare` scripts from git, file, and link dependencies are blocked the same way"*. The changelog notes the `allow-scripts` config applies to *"npx and global installs."*
- *"`--allow-remote` defaults to `none`"* for https tarballs.

— https://github.blog/changelog/2026-06-09-upcoming-breaking-changes-for-npm-v12/

A `github:` spec is a git dependency, and a TypeScript package run straight from git needs its `prepare` script to build before `bin/init.ts` is runnable. Under npm 12's defaults both of those are off. The spine therefore pins the one npm major that breaks its only supported distribution path, and it does so without noting the interaction.

**Unverified sub-claim.** The changelog does not state in so many words whether `npx <git-spec>` is refused outright or merely runs unbuilt; the `allow-scripts` sentence covers npx, the `--allow-git` sentence is phrased around `npm install`. I could not settle this without installing npm 12 globally on this machine, which I did not do. **AD-12 must not be locked until someone runs `npx github:<owner>/<repo> init` under npm 12 and records the result.** If it is refused, AD-12's "only supported way" is not viable as written and the rule needs either a documented `--allow-git --allow-scripts` invocation (which a first-run user must type, changing the onboarding UX) or a different distribution decision.

**Related.** The Stack row "npm | 12.x — local npx 11.4.2" is doubly off:
- Local `npm -v` is **11.4.2**, not 12.x — the machine is a full major below the pin. The note calls it "local npx" but npm and npx are the same version; the row reads as if only npx lagged.
- Neither recommended Node ships npm 12. Node **24.21.0 bundles npm 11.19.0**; Node **22.23.2 bundles npm 10.9.8** (checked in `deps/npm/package.json` at each tag). So "npm 12.x" mandates a manual `npm i -g npm@12` on every dev and CI machine — and that global upgrade is exactly what turns on the git-dependency block above. The spine should either drop to the Node-bundled npm 11.x line or state the upgrade and its consequences.

---

## HIGH-1 — TypeScript 7 is a different compiler implementation with no compiler API, and the spine carries none of it

**What the spine commits to.** Stack row: "TypeScript | 7.0.2", with no annotation. AD-2 makes one TypeScript package own engine, TUI and web.

**What is actually true.** `typescript@7.0.2` is real and is the `latest` dist-tag (published 2026-07-08), so the pin is not fictional. But TypeScript 7 is **Project Corsa — a native Go port replacing the JavaScript compiler**, not an increment on 5.x/6.x. The registry metadata confirms the shape: `"type": "module"` and 20 platform-specific native binary packages (`@typescript/typescript-darwin-arm64`, `@typescript/typescript-linux-x64`, …) as both `dependencies` and `optionalDependencies`.

The consequences a builder must know, from the official announcement (https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/):

1. **There is no compiler API.** *"TypeScript 7.0 does not ship with an API. We expect TypeScript 7.1 to ship with a new (and different) API."*
2. **typescript-eslint and ts-morph do not work on TS 7.** Anything that reads the compiler as a library — custom transformers, `tsup --dts`, Vue/Svelte/Astro/Angular/MDX language tooling — is pinned to the TypeScript 6.x line until 7.1 lands and each tool adopts the new API. Microsoft's own guidance is to *"use TypeScript 7 in scenarios where language server plugins are not required."*
3. **The bridge is `@typescript/typescript6`**, a compatibility package installable side-by-side with 7.0 for tools that still need the 6.x API.
4. **Defaults and targets changed:** removed ES5 target, `downlevelIteration`, AMD/UMD/SystemJS modules, `baseUrl`, classic `moduleResolution`; new defaults `strict: true`, `module: esnext`, `noUncheckedSideEffectImports: true`, `types: []` (was `["*"]`).

**Why this is load-bearing here, not trivia.** AD-2 fixes one language for engine + TUI + web and forbids a second. Adopting TS 7.0.2 as written silently also decides that this repository **has no typescript-eslint** — for a system whose own AD-16 treats "lint command" as first-class project mechanics, shipping a codebase that cannot lint itself is a decision, and an undeclared one. The spine should either annotate the Stack row with the 7.0 API gap and how linting is handled (e.g. Biome/oxlint, or `@typescript/typescript6` alongside for the lint toolchain only), or pin the 6.x line until 7.1.

**Corollary for AD-11.** TS 7's native binaries have **no musl/Alpine variant** — the 20 platform packages cover glibc Linux (`linux-x64`, `linux-arm64`, …), darwin, win32, the BSDs, aix, sunos, but nothing musl. `docker/Dockerfile` (AD-11, tier-2 executor) therefore cannot be Alpine-based if the executor needs `tsc`. Worth one line in AD-11 or in the Structural Seed note, because AD-11 fixes the image as the single hardening surface and a base-image swap late in the build would invalidate the content hash contract.

---

## HIGH-2 — `--bare` "will become the default for `-p` in a future release", which silently inverts AD-1's auth model

**What the spine commits to.** AD-1: "the engine spawns exactly one `claude -p` process per step and **never in bare mode**". Consistency Conventions: "Auth is the user's own Claude Code subscription login via non-bare `claude -p`; no `ANTHROPIC_API_KEY` path and no bundled credential." AD-12 rests on the same thing: bundling no credential because every user authenticates with their own login.

**What is actually true — and confirms the spine's premises, for now.** Both load-bearing assumptions are documented verbatim at https://code.claude.com/docs/en/headless:

- *"Set `ANTHROPIC_API_KEY` before running it, because bare mode doesn't use your subscription login."* and *"In bare mode, Claude Code never reads OAuth credentials or the system keychain."* → (a) confirmed.
- *"Without `--bare`, a `-p` session runs the hooks in a project's `.claude/settings.json` and connects the servers in its `.mcp.json`, even in a folder you've never trusted. A `-p` session shows no workspace trust dialog and no per-server approval prompt."* → (b) confirmed, exactly as the spine's Deferred item describes it.

**The risk the spine does not carry.** The same page states: *"`--bare` is the recommended mode for scripted and SDK calls, and will become the default for `-p` in a future release."*

When that flips, an engine that spawns `claude -p` and relies on the absence of `--bare` stops using the subscription login and starts demanding `ANTHROPIC_API_KEY` — the one thing the Consistency Conventions row forbids and AD-12 was written to avoid. It will present as every step failing with a missing-authentication result, on a routine `claude` upgrade, with no code change on this side. No `--no-bare` opt-out is documented in the CLI reference (https://code.claude.com/docs/en/cli-reference).

AD-1's "never in bare mode" is currently expressed as the *absence* of a flag, which is not a durable guarantee. The spine should state the exposure and how it is detected — the cheapest check is that `system/init` reports the loaded MCP servers and plugins, so the runtime recorder can assert on the first event of a run that project context loaded, and fail loudly rather than silently re-authenticating. Also worth asking Anthropic for a `--no-bare` before this is built on.

---

## MEDIUM-1 — Zod-generated step contracts will hit documented `--json-schema` limitations that the spine's own conventions steer builders straight into

`z.toJSONSchema()` exists natively in Zod 4 with no external dependency, as the spine says, and supports `draft-04`/`draft-07`/`draft-2020-12`/`openapi-3.0` targets (https://zod.dev/json-schema). But the accepted JSON Schema subset on the Claude side is narrower than what Zod emits, and three of the gaps land on things the spine mandates.

Supported/unsupported list: https://platform.claude.com/docs/en/build-with-claude/structured-outputs#json-schema-limitations

| Zod idiom | Emitted keyword (verified locally, zod 4.6.5, `target: "draft-7"`) | Status |
| --- | --- | --- |
| `z.date()` | — throws `Date cannot be represented in JSON Schema` | **unrepresentable**; `cycles`/`unrepresentable`/`reused`/`io` options exist but the default is `throw` |
| `z.string().min(1)` | `"minLength": 1` | string constraints **not supported** |
| `z.array(x).min(2)` | `"minItems": 2` | array `minItems` supported **only for values 0 and 1** |
| `z.number().min(0)` | `minimum` | numerical constraints **not supported** |
| `z.iso.datetime()` | `"format": "date-time"` **plus a `pattern`** | `format` is accepted only as an unenforced annotation; the extra `pattern` is outside the documented supported set |
| recursive schema (getter self-reference) | `{"$ref": "#"}` | `$ref`/`$defs` are supported, but **recursive schemas that reference themselves are not** |

Three specific consequences for this spine:

1. **Timestamps.** Consistency Conventions mandate RFC3339-with-milliseconds everywhere including the event envelope and state files. The natural Zod spelling `z.date()` is unrepresentable and throws at schema-export time; `z.iso.datetime()` works but drags in a `pattern`. AD-5's envelope and every typed step output need a single decided spelling, or units will pick differently and one of them will fail to export.
2. **Cycles.** Zod's default `cycles: "ref"` emits a self-`$ref`, and self-referential schemas are explicitly unsupported by structured outputs. Any step contract with a recursive shape — a nested plan tree, a nested finding tree, a nested intent — is not expressible. AD-15's "declared write intents" and any tree-shaped planner output are the likely places this bites. The spine should state that step contracts are non-recursive.
3. **Validation constraints don't survive.** A builder who writes `z.string().min(1)` on a required field is expressing an invariant the CLI will not enforce. The platform docs note the Python/TypeScript **SDKs** strip unsupported constraints and re-validate locally against the original schema — but AD-1 forbids the SDK, so this project gets no such safety net. The engine must re-`parse()` `structured_output` against the original Zod schema after the subprocess returns. That is a real engine responsibility AD-1 currently leaves unstated, and it is exactly the kind of thing two units would implement differently.

None of this defeats AD-2 — Zod 4 genuinely provides the pydantic-equivalent chain the memlog reasoned from — but AD-2's rule text is one sentence short of being buildable.

---

## MEDIUM-2 — Ink 7's ESM-only packaging and React 19.2 peer are omitted from the Stack row

Stack row says only: "Ink | 7.1.1 — engines: node `>=22`". Verified from `registry.npmjs.org/ink/7.1.1`:

- `"engines": {"node": ">=22"}` — correct as stated.
- `"type": "module"` with `"exports": {"types": "./build/index.d.ts", "default": "./build/index.js"}` and **no `main` and no `require` condition**. Ink 7 is **ESM-only**. AD-2 puts engine, TUI and web in one TypeScript package, so that package is ESM — which lands on top of TS 7's `module: esnext` default and its own `"type": "module"`. Consistent, but it is a whole-package constraint arriving via a TUI library, and the spine's Structural Seed shows `bin/init.ts` and `src/**` with no module-format statement.
- `"peerDependencies": {"react": ">=19.2.0", "@types/react": ">=19.2.0", "react-devtools-core": ">=6.1.2"}`. React `latest` is 19.3.0, so this is satisfiable today — but React is not in the Stack table at all, despite being a hard floor on a committed dependency. Add it.

---

## LOW-1 — The `claude` CLI floor doesn't match its own stated justification

Stack row: "`claude` CLI | `>=2.1.269`, local 2.1.278 — floor set by `--permission-prompts` at 2.1.259 and nested-subagent stream events at 2.1.219".

Both cited floors are correct against the docs — `--permission-prompts` *"Requires Claude Code v2.1.259 or later"* and *"Before v2.1.219, messages from nested subagents didn't appear in the stream"* (https://code.claude.com/docs/en/headless). But `max(2.1.259, 2.1.219)` is 2.1.259, not 2.1.269. 2.1.269 is the floor for `/output-style` in `-p` mode, which the spine never mentions using.

Over-pinning is safe, but the row's rationale doesn't derive its own number, which means the next person to touch it cannot tell whether 2.1.269 is load-bearing. Either correct the floor to `>=2.1.259` or name the real reason for 2.1.269.

Worth adding while you are there, since AD-8 and AD-13 depend on them and both have version floors:
- `--resume` searching **every project on the machine** by session id requires **v2.1.223** — AD-8 rejoins by session id and AD-9 puts worktrees under `$ORCH_HOME` while the repo lives elsewhere, so the cross-directory search is load-bearing, not incidental.
- `--mcp-config` with `-p` **waiting for pending servers before the first turn** requires **v2.1.221**; without it AD-13's "each domain runs as exactly one MCP server passed with `--mcp-config`" can start a turn before the domain is connected. Also note `mcp_server_errors` in `system/init` (v2.1.219+) is the only signal for a silently skipped server — the run *"continues and exits cleanly"* otherwise, which would let a step run without its domain and record a wrong result to the event log.

---

## LOW-2 — Dev machine is below the spine's own Node floor, and the floor's phrasing invites confusion

Stack row: "Node.js | `>=22.22` Jod LTS; 24.x Krypton LTS recommended — dev machine currently 22.14.0".

Everything factual here checks out. From `raw.githubusercontent.com/nodejs/Release/main/schedule.json` and `nodejs.org/dist/index.json`:

- **Node 22 "Jod"**: entered maintenance **2025-10-21**, EOL **2027-04-30**. Latest 22.23.2. `22.22.x` exists (22.22.0–22.22.3), so the floor is a real version.
- **Node 24 "Krypton"**: Active LTS since 2025-10-28, maintenance from 2026-10-20, EOL **2028-04-30**. Latest 24.21.0.
- Node 26 becomes LTS 2026-10-28 (EOL 2029-04-30), ~5 weeks out.

**The recommendation is sound** — 24.x buys a full extra year of support over 22.x and is the only one of the two still in Active LTS. Two notes:

1. **The dev machine at 22.14.0 does not meet the spine's own `>=22.22` floor**, and the row records that as a neutral observation rather than an action. Anyone building against this spine today on that machine is below the stated minimum from line one. Ink's `>=22` is satisfied, so nothing fails loudly — it fails the written contract silently. Make it an explicit "upgrade before build" item.
2. Node 22 enters its final six months around the time this system would plausibly ship. If the floor's purpose is "the lowest version a user's machine may have", `>=22.22` is defensible; if it is "what we build and test on", it should just be 24.x. The row currently reads as both.

---

## LOW-3 — Docker Engine pin is a point release behind

Stack row: "Docker Engine | `>=29.7`, local 29.7.2". Local `docker --version` confirms 29.7.2. Current upstream release is **29.8.1** (published 2026-09-15), with 29.8.0 on 2026-09-03 (https://github.com/moby/moby/releases).

`>=29.7` is a valid and satisfiable floor, so this is informational only — but AD-11 ties the executor image's identity to a Dockerfile content hash and makes the image the single hardening surface, so the engine version that builds it is part of that surface and is worth keeping current.

---

## Unverifiable / needs empirical confirmation before the relevant AD is locked

1. **`npx github:<owner>/<repo>` under npm 12** (BLOCKER-2). The changelog's `--allow-git` language is scoped to `npm install`; its `allow-scripts` language explicitly covers npx. Whether npx refuses the git spec, or resolves it but skips the `prepare` build, decides whether AD-12 is viable as written. Requires running it under a real npm 12.
2. **Whether Claude Code strips or rejects unsupported schema keywords** (`minLength`, `minItems: 2`, `minimum`, `pattern`) rather than failing at API call time. Startup validation accepted a draft-07 schema in my test, but I did not spend a model call per unsupported keyword to find out where each one fails. Cheap to determine and worth doing before the contracts package is written, because the answer decides whether Zod refinements may be used at all in step contracts.
3. **Whether a future `claude` release provides `--no-bare`** (HIGH-2). Not currently documented.

---

## Verified, no finding

Checked and correct as the spine states them: `typescript@7.0.2`, `zod@4.6.5` and `ink@7.1.1` are all the current `latest` on the npm registry and actively maintained; Node 22.22/24.x version numbers, codenames, LTS status and EOL dates, and the soundness of recommending 24.x; Docker Engine `>=29.7` as a satisfiable floor; the existence and documented semantics of every `claude` flag the architecture depends on — `-p`, `--output-format json|stream-json`, `--json-schema`, `--mcp-config`, `--agents`, `--permission-mode`, `--allowedTools`, `--permission-prompts`, `--resume`, `--bare`; both load-bearing `--bare`/non-bare claims in AD-1 and the Consistency Conventions (bare requires `ANTHROPIC_API_KEY` and reads no OAuth credentials, non-bare `-p` runs a project's hooks and `.mcp.json` servers with no trust dialog and no per-server approval); AD-5's reliance on `parent_tool_use_id` and `session_id` in the stream and on nested-subagent forwarding; AD-1's specific combination of `--json-schema` with `--output-format stream-json`, which the docs only illustrate with `--output-format json` — I ran it on this machine and the final `result` line carried `"subtype":"success"` and `"structured_output":{"n":7}`, so the combination works and AD-1's consumption model is sound; `z.toJSONSchema()` existing natively in Zod 4 with no external converter; and Zod 4 emitting `additionalProperties: false` for plain `z.object()`, which is what the structured-outputs API requires.
