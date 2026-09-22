/**
 * AD-16 — the shape of one profile knowledge entry: an anchor, provenance, and a decay policy.
 *
 * AD-16 requires a contradicted profile entry to be *flagged stale rather than silently applied*, and
 * a loader cannot judge semantic contradiction — no code decides whether a sentence in a `CLAUDE.md`
 * disagrees with a claim in a TOML. What makes the rule decidable is the structure AD-16 already
 * demands of an entry: it declares **the anchor it speaks to**, and it is stale when the repository's
 * own instructions speak to that same anchor. So the anchor is not documentation here; it is the field
 * precedence is decided by, which is why an entry without one is refused at parse rather than stored
 * and skipped. An entry nothing can check is an entry nothing can flag.
 *
 * **Line numbers are refused, in the vocabulary of `memory-design.md`.** It ranks anchors by
 * durability — test names, then public API symbols, then module names, then file paths — and says
 * outright "never line numbers". A line number is not a weak anchor but a wrong one: it resolves to a
 * different thing after every edit above it, so an entry anchored on one would be flagged, or not
 * flagged, by whichever unrelated change moved the line last.
 *
 * **Every field is flat and scalar, deliberately.** An entry is written as a `[[knowledge.entries]]`
 * table in `profile.toml`, and `src/contracts/toml.ts` refuses a nested table inside a table-array
 * entry rather than emitting a header that would read back as a different table. A decay policy
 * spelled as a sub-table would therefore be unwritable; `decay_policy` plus `decay_features` is the
 * same information in the form the artifact can actually carry.
 *
 * **Nothing writes one of these yet.** The profile story 2-1 writes has no knowledge section, and
 * entries arrive with the bootstrap agent in stage 5 — which is why the section is optional on
 * {@link ProfileSchema} and why this path is exercised by tests rather than by a run. The mechanism is
 * here anyway because the loader is the only place it can live, and the story that starts writing
 * entries should not also have to invent what happens when one contradicts the repository.
 */
import { z } from 'zod';

import { TimestampSchema } from './event.js';

/**
 * Anchor kinds, in `memory-design.md`'s durability order.
 *
 * `file-path` is last and is still legal: "no file paths as anchors where a symbol will do" is a
 * judgement about a particular entry, which no schema can take — the kind is declared so a sweep and a
 * reviewer can see which entries rest on the weakest anchor, not so this file can refuse one.
 */
export const ANCHOR_KINDS = ['test-name', 'api-symbol', 'module-name', 'file-path'] as const;

export type AnchorKind = (typeof ANCHOR_KINDS)[number];

/**
 * The decay policies AD-16 names, in `memory-design.md`'s vocabulary: permanent, until-refactor,
 * N-features, session.
 *
 * Acting on one is story 5-2's re-validation sweep. The field is required here because AD-16 requires
 * it *at write time* — "every entry carries a decay policy chosen at write time" — and a policy chosen
 * later is a policy chosen by whoever is doing the pruning rather than by whoever knew what the entry
 * was worth.
 */
export const DECAY_POLICIES = ['permanent', 'until-refactor', 'n-features', 'session'] as const;

export type DecayPolicy = (typeof DECAY_POLICIES)[number];

/**
 * The forms that name a line rather than a symbol, each refused as an anchor.
 *
 * **Not end-anchored, and not unanchored either — a line reference attaches to a file extension.** Two
 * corrections are folded in here, in opposite directions. The first version ended `:\d+$` and required the
 * `L` in `#L42`, so six ordinary spellings walked through: a range (`src/foo.ts:42-58`), a parenthesised
 * line (`foo.ts(42)`), a bare `#42`, an `:L42`, an `@42`, and any of them followed by prose
 * (`src/a.ts:42 in the handler`) — a line number is not made acceptable by having words after it. The
 * replacement then over-refused in the other direction: bare `@\d+` and `:\d+` also match `zod@4`,
 * `react@18.2.0` and `timeout:5000`, so a person naming a package version or a settings key was told their
 * anchor is a line number.
 *
 * What separates the two is what the number is attached to: a line reference follows a **file extension**
 * (`.ts`, `.tsx`, `.md`), a version follows a package name. `memory-design.md` ranks test names and module
 * names above file paths, and a version-bearing test name is an ordinary anchor in this project — so the
 * extension is required in the four positional forms, and the three forms that need no extension are the
 * ones that cannot be anything but a line: a bare number, the words `line`/`lines`, and an explicit `#L42`.
 */
export const LINE_NUMBER_ANCHOR_PATTERNS: readonly RegExp[] = Object.freeze([
  /** `src/auth/session.ts:42`, the `:42:7` a compiler prints, `:42-58`, `:L42`, and any of them mid-string. */
  /\.[A-Za-z][A-Za-z0-9]*:L?\d+/i,
  /** `session.ts#42` — the bare `#` some tools print, which needs the extension to be distinguishable. */
  /\.[A-Za-z][A-Za-z0-9]*#L?\d+/i,
  /** `session.ts(42)`, as a stack trace spells it. */
  /\.[A-Za-z][A-Za-z0-9]*\(\d+\)/i,
  /** `session.ts@42`. Distinguished from `zod@4` by the extension, which a package name does not carry. */
  /\.[A-Za-z][A-Za-z0-9]*@\d+/i,
  /** A bare number, and `L42`. */
  /^\s*L?\d+\s*$/i,
  /** `line 42`, `lines 42-58`. */
  /\blines?\s+\d+/i,
  /** `session#L42`, and GitHub's `#L42-L58`: the explicit `L` needs no extension to be unambiguous. */
  /#L\d+/i,
]);

/** True when a candidate anchor names a line rather than a symbol (`memory-design.md`). */
export const isLineNumberAnchor = (candidate: string): boolean =>
  LINE_NUMBER_ANCHOR_PATTERNS.some((pattern) => pattern.test(candidate));

/** What a blank field is: absent, spelled as present. */
const isBlank = (value: string): boolean => value.trim() === '';

/**
 * The anchor a knowledge entry speaks to.
 *
 * Three refusals, all structural. A blank anchor is refused because a key left in place with nothing in
 * it is the same unfalsifiable entry as a key left out — the loader would have nothing to compare the
 * repository's instructions against, and would apply the entry for ever. A line-number anchor is
 * refused per `memory-design.md`.
 *
 * **A padded anchor is refused for the blank anchor's reason, not for tidiness.** `"  resolveProject  "`
 * is stored verbatim and matched verbatim, and no instruction file contains a symbol with two spaces
 * either side of it — so the anchor can never match, the entry can never be flagged, and it is applied
 * for ever. That is precisely the outcome AD-16 forbids, reached through the hole the blank refusal
 * exists to close. Refused rather than trimmed, because a schema that silently rewrote the value would
 * store something other than what the file says, and because a transform cannot be exported to JSON
 * Schema (AD-2 exports every contract).
 */
export const KnowledgeAnchorSchema = z
  .string()
  .refine((value) => !isBlank(value), {
    message:
      'a knowledge entry must declare the anchor it speaks to: precedence against the repository\'s ' +
      'instructions is decided by that anchor (AD-16), so an entry with none can never be flagged',
  })
  .refine((value) => isBlank(value) || value === value.trim(), {
    message:
      'an anchor carries no surrounding whitespace: it is matched verbatim against the repository\'s ' +
      'instructions, so a padded anchor is one nothing can ever match and an entry nothing can ever flag',
  })
  .refine((value) => isBlank(value) || !isLineNumberAnchor(value), {
    message:
      'an anchor names a symbol, never a line number: memory-design.md ranks anchors by durability — ' +
      'test names, public API symbols, module names, then file paths — and line numbers are never valid',
  });

/**
 * One entry of the profile's knowledge section.
 *
 * A total record rather than an optional bag, for the reason `MechanicsCommandsSchema` is one: a reader
 * distinguishes "there is no N" from "nobody recorded one". `decay_features` is therefore always
 * present and is zero for every policy that does not count features — which the cross-field refinement
 * below enforces in both directions, so `n-features` with no N cannot exist and neither can a
 * `permanent` entry carrying a count nothing will ever read.
 */
export const KnowledgeEntrySchema = z
  .object({
    anchor: KnowledgeAnchorSchema,
    anchor_kind: z.enum(ANCHOR_KINDS),
    /** What the entry claims about that anchor. Prose for an agent to read, never parsed. */
    claim: z.string().refine((value) => !isBlank(value), {
      message: 'a knowledge entry with no claim says nothing; AD-16 makes the section additive',
    }),
    /**
     * Where the entry came from — AD-16's "every knowledge entry carries provenance".
     *
     * Free text naming the writer rather than an enum, because the writers are not all declared yet:
     * the bootstrap agent of story 5-5 is one, a person editing `profile.toml` by hand is another, and
     * a consolidation pass is a third. Blank is refused: provenance nobody recorded is not provenance.
     */
    provenance: z.string().refine((value) => !isBlank(value), {
      message: 'a knowledge entry carries provenance (AD-16): what recorded it, and from what',
    }),
    /** RFC3339 with milliseconds in UTC, per the Consistency Conventions. */
    recorded_at: TimestampSchema,
    decay_policy: z.enum(DECAY_POLICIES),
    /** How many features an `n-features` entry survives; zero for every other policy. */
    decay_features: z.int(),
  })
  .refine(
    (entry) => (entry.decay_policy === 'n-features' ? entry.decay_features >= 1 : true),
    {
      message:
        'decay_policy "n-features" needs decay_features of at least 1: an N-features entry with no N ' +
        'is an entry the story 5-2 sweep can never expire',
      path: ['decay_features'],
    },
  )
  .refine(
    (entry) => (entry.decay_policy === 'n-features' ? true : entry.decay_features === 0),
    {
      message:
        'decay_features is read only by decay_policy "n-features"; every other policy records 0, so a ' +
        'count nobody acts on cannot read as one that somebody does',
      path: ['decay_features'],
    },
  );

export type KnowledgeEntry = z.infer<typeof KnowledgeEntrySchema>;

/**
 * The profile's knowledge section: entries and nothing else.
 *
 * A table holding one array rather than the array itself, because TOML gives `[[knowledge.entries]]` a
 * home that a later field — a sweep's last-run stamp, say — can be added beside without changing how
 * an entry is spelled.
 */
export const KnowledgeSectionSchema = z.object({
  entries: z.array(KnowledgeEntrySchema),
});

export type KnowledgeSection = z.infer<typeof KnowledgeSectionSchema>;
