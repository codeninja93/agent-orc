---
name: 'Schema versions advance per artifact, not all at once'
type: architecture-decision-record
status: accepted
created: '2026-09-22'
decides:
  - 'AD-28 (the shape of the version, not its intent)'
raised-by:
  - 'story 2-6 (adding `typecheck` to the profile)'
---

# ADR-005 — Schema versions advance per artifact, not all at once

**Status: accepted 2026-09-22 by Deep.** Implemented and verified in story 2-6.

## The problem, measured

AD-28 binds every on-disk artifact to carry a `schema_version` and makes an unrecognised one a refusal. It
does not say whether that number is one number. Until story 2-6 it was: a single `CURRENT_SCHEMA_VERSION`
answered for the profile, `state.json`, question outcomes, command intents, leases and the fetch record.

Story 2-6 had to add `typecheck` to `mechanics.commands`, because CAP-13 requires a typecheck gate and the
profile had nowhere to declare one. That is a change to the **profile's** shape. Under one shared constant,
advancing it would have refused every other artifact written before the upgrade.

The consequence was verified rather than argued. With the shared constant advanced to 2, a `state.json`, a
question state and a command intent each written at version 1 are all refused:

```
{ runStateV1Refused: true, questionStateV1Refused: true, commandIntentV1Refused: true }
```

No reader was already tolerant. So a run in flight when the installer was upgraded could no longer be read
back, and AD-8's resume would have had nothing to resume from — a person would lose work in progress because
a *different* artifact gained a field.

## Decision

**Each artifact kind carries its own schema version and advances independently.**

- `schemaVersionFieldFor` gives an artifact its own version and its own recognised set; `versioned` keeps the
  shared default for the artifacts that have not moved.
- Only `ProfileSchema` advances, to 2. Every other artifact stays at 1 and keeps reading what it wrote.
- AD-28 is unchanged in intent: every artifact still carries a version, and still refuses one it does not
  recognise. What changes is that one artifact's shape changing is not every artifact's shape changing.

### Why this is the right shape

The alternative — bumping everything — makes the version number mean "the last time anything changed", which
is not a fact about the artifact being read. A reader asks "can I understand this file", and the honest answer
depends only on that file's own shape. Coupling them means every future field on any artifact costs a
compatibility break on all of them, which is the strongest possible incentive not to version anything
honestly.

## Consequences accepted

- **Six versions to keep straight rather than one.** The guard is that every artifact-kind contract is
  asserted in both directions — too new and too old — and for carrying no version at all.
- **A refusal message must name which artifact** it is about, since "version 2 is unrecognised" is now
  ambiguous across kinds. `parseVersionedArtifact` reads the schema's own refusal and substitutes the
  artifact's name, rather than re-deciding the version against a policy it was handed — which had become a
  second authority the moment one artifact moved, and returned a v1 profile as a Zod shape error instead of
  `config.schema_version_unrecognised`.
- **`INSTALLER_VERSION_BY_SCHEMA_VERSION` must gain the profile's new version**, and as first written did
  not: the map held only `{1: '0.1.0'}`, so `installerVersionFor(2)` answered `null` and a build refusing a
  v2 profile would say "written by an installer older than X" instead of naming the version that wrote it —
  losing the provenance the map exists for. Story 2-6's review caught it.

  Worth recording as a failure of this document rather than of the code: the paragraph above originally
  stated that consequence as already handled. It was the second architecture record in two stories to assert
  an intended consequence as an accomplished fact — ADR-004 did the same about an amendment to ADR-003. A
  consequence written in the past tense reads as verified, and neither was.

- **A version number alone no longer identifies a writer, and the fix for the paragraph above was
  incomplete.** Adding `2` to the shared table makes `installerVersionFor(2)` name this installer — which is
  right for the profile and wrong for everything else, because no `state.json`, lease or command intent has
  ever reached version 2. Taken literally, this document's own correction would have had the code tell a
  person that a v2 command intent "was written by installer 0.1.0": a confident statement about a build that
  does not exist. So the table entry stands *and* the refusal's writer lookup is bounded by the artifact's
  own policy — a version past what this build writes **for that artifact** has no known writer, whatever the
  shared table says about the number. Both directions are asserted. This is the consequence of the decision
  that took two attempts to state correctly, which is itself the argument for per-artifact versions: a
  number that means different things for different artifacts cannot be read on its own.

## Open question this ADR does NOT decide

**Whether an artifact may ever read a version older than its current one.** Today every artifact recognises
exactly one version and refuses the rest, so an upgrade is always a re-run of the installer. A migration path
— read v1, write v2 — is a different decision, and the first artifact that carries a person's accumulated
work rather than their configuration is where it will have to be taken.
