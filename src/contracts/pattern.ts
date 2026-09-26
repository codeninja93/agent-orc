/**
 * Story 5-4 — CAP-19/AD-34: the fixed home for cross-project memory, `ORCH_HOME/memory/`, "because it
 * spans projects and can belong to no repository". Every memory store this stage has built so far
 * (`consolidated.jsonl`, `decisions.jsonl`) is deliberately per-project, anchored to one repository's own
 * files; a pattern learned building one product has nowhere to go that another product could ever read.
 * `CrossRepoPattern` is that shape.
 *
 * **Structurally incapable of carrying a code snippet or a per-repo specific.** Unlike
 * `KnowledgeEntry` (`src/contracts/knowledge.ts`), whose whole shape assumes one repository's own files —
 * an anchor, an anchor kind tied to that repository's own files — this schema has no anchor, no file
 * path, and no symbol field of any kind. "Stores no code snippets and no per-repo specifics" is enforced
 * by the schema having nowhere to put either, not by a content heuristic trying to detect one after the
 * fact: a heuristic strong enough to catch real code reliably would also catch legitimate prose that
 * quotes a symbol name, and one weak enough not to would catch nothing that mattered. Whether the *prose
 * itself* obeys "no code snippets" is a human or a later story's judgement, exactly as AD-16 makes a
 * person the reviewer of `profile.toml`'s own knowledge section.
 *
 * **Carries a decay policy, exactly as `KnowledgeEntrySchema` does.** An earlier version of this file
 * argued the store needed none, on the claim that "nothing in this codebase implements them for any tier
 * yet". That was wrong on this file's own terms: `KnowledgeEntrySchema` (story 5-1) requires
 * `decay_policy`/`decay_features` as mandatory fields, and `src/engine/consolidation.ts` assigns one to
 * every fact it writes. A cross-repo pattern is exactly the kind of record AD-16's "every entry carries a
 * decay policy chosen at write time" is about, so `decayPolicy`/`decayFeatures` are here, reusing
 * `DECAY_POLICIES`/`DecayPolicy` from `src/contracts/knowledge.ts` directly rather than a second
 * enum — one vocabulary for what "decay" means, never two that could drift apart — and mirroring that
 * schema's own two cross-field refinements verbatim.
 *
 * **Six fields, non-blank and non-padded refinements on every string a caller composes.** `topic`,
 * `pattern`, and `sourceProjectId` all reuse `KnowledgeAnchorSchema`'s own blank-refusal and
 * trim-equality reasoning (not imported — a genuinely different shape, no anchor): a field nothing can be
 * retrieved by, or nothing was actually recorded, is worse than the field being absent, and a field
 * carrying leading or trailing whitespace is refused outright rather than silently trimmed — a schema
 * that silently rewrote the value would store something other than what the file says. `sourceProjectId`
 * is AD-10's project id, never a repository path, so provenance survives a repository moving or being
 * renamed — provenance on a record, never a partition of the store. `recordedAt` reuses `TimestampSchema`.
 *
 * **Topic matching is exact and case-sensitive.** `retrievePatterns` filters by `===`, never case-folded
 * or normalised, so `'Auth'` and `'auth'` are two different topics that will never be joined by a lookup.
 * Callers choosing a topic string are responsible for using one consistent spelling across every project
 * that records or retrieves under it.
 */
import { z } from 'zod';

import { TimestampSchema } from './event.js';
import { DECAY_POLICIES } from './knowledge.js';

/** What a blank field is: absent, spelled as present — `knowledge.ts`'s own definition, restated here. */
const isBlank = (value: string): boolean => value.trim() === '';

/**
 * One cross-repo pattern: an abstraction, where it came from, and how long it lasts.
 *
 * No anchor, no file path, no symbol field, and no code field of any kind — the schema itself is the
 * boundary. `topic` is the retrieval key `retrievePatterns` filters on (exact, case-sensitive match);
 * `pattern` is the free prose the abstraction is written as; `sourceProjectId` is provenance, never a
 * store partition — the one shared `ORCH_HOME/memory/patterns.jsonl` is read and written by every
 * project.
 */
export const CrossRepoPatternSchema = z
  .object({
    /**
     * A short label, the retrieval key. Blank is refused: a topic nothing can be retrieved by is no
     * topic. Padded is refused rather than trimmed: `retrievePatterns` filters by exact string equality,
     * so a topic recorded as `' auth'` would silently never match a lookup for `'auth'`.
     */
    topic: z
      .string()
      .refine((value) => !isBlank(value), {
        message:
          'a cross-repo pattern with a blank topic can never be retrieved by topic, which is the whole ' +
          'of how retrievePatterns finds it',
      })
      .refine((value) => isBlank(value) || value === value.trim(), {
        message:
          'a topic carries no surrounding whitespace: it is matched verbatim by retrievePatterns, so a ' +
          'padded topic is one nothing can ever match',
      }),
    /** Free prose — the abstraction itself, never a code snippet or a per-repo specific. */
    pattern: z
      .string()
      .refine((value) => !isBlank(value), {
        message: 'a cross-repo pattern with no prose records nothing: pattern is the abstraction itself',
      })
      .refine((value) => isBlank(value) || value === value.trim(), {
        message:
          'a pattern carries no surrounding whitespace: a schema that silently trimmed it would store ' +
          'something other than what was actually recorded',
      }),
    /**
     * AD-10's project id — provenance that survives a repository moving or being renamed. Blank and
     * padded are refused for the same reasons `topic` and `pattern` are: provenance nobody recorded, or
     * recorded illegibly, is not provenance.
     */
    sourceProjectId: z
      .string()
      .refine((value) => !isBlank(value), {
        message:
          'a cross-repo pattern with a blank sourceProjectId records no provenance, undermining the one ' +
          "thing this field exists for: surviving a repository moving or being renamed",
      })
      .refine((value) => isBlank(value) || value === value.trim(), {
        message:
          'sourceProjectId carries no surrounding whitespace: a padded id is not the id AD-10 assigned',
      }),
    /** RFC3339 with milliseconds in UTC. */
    recordedAt: TimestampSchema,
    decayPolicy: z.enum(DECAY_POLICIES),
    /** How many features an `n-features` pattern survives; zero for every other policy. */
    decayFeatures: z.int(),
  })
  .refine((pattern) => (pattern.decayPolicy === 'n-features' ? pattern.decayFeatures >= 1 : true), {
    message:
      'decayPolicy "n-features" needs decayFeatures of at least 1: an N-features pattern with no N is a ' +
      'pattern that can never be expired',
    path: ['decayFeatures'],
  })
  .refine((pattern) => (pattern.decayPolicy === 'n-features' ? true : pattern.decayFeatures === 0), {
    message:
      'decayFeatures is read only by decayPolicy "n-features"; every other policy records 0, so a count ' +
      'nobody acts on cannot read as one that somebody does',
    path: ['decayFeatures'],
  });

export type CrossRepoPattern = z.infer<typeof CrossRepoPatternSchema>;
