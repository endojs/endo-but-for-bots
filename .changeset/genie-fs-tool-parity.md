---
'@endo/genie': minor
---

Bring the genie filesystem tool surface to parity with the other agent
surfaces. `editFile` now delegates to the shared exact-string-replacement
algorithm (`@endo/agentry/edit-text`): it takes a single `oldText`/`newText`
pair or an `edits` array, enforces unique matches and non-overlap, preserves
line endings and BOM, and returns `{ applied, diff }` — replacing the former
first-occurrence `old_string`/`new_string`/`replace_all` shape. New `glob`
and `grep` tools delegate to the shared platform search engine
(`@endo/platform/fs/search`) over any VFS backing (node, memory, mount),
with the engine's confinement, denial, and batching semantics. The `VFS`
contract gains an optional `realPath` (implemented by the node backing) so
search confinement can exclude symlink escapes.
