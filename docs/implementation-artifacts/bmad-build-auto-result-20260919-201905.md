---
status: blocked
---

# BMad Build Auto Result

Status: blocked
Blocking condition: unclear intent

The workflow was invoked with an empty prompt: no spec file path with recognized `status` frontmatter, no spec folder + story id (folder+id dispatch), and no starting intent (story ID, ticket ID, file path, or description). Step 1's intent check therefore could not identify what to implement, and per its rule the run halts before loading context or planning.
