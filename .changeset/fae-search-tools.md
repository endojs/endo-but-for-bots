---
'@endo/fae': minor
---

Add `glob` and `grep` filesystem tool makers to `@endo/fae`'s `src/tool-makers.js`.
The tools use `@endo/platform/fs/search` to find paths by pattern and search file contents with ECMAScript regular expressions.
The `grep` tool applies a conservative complexity check that rejects nested quantifiers and some other high-risk regular expressions.
Fae's filesystem tool makers now reject paths in sibling directories that share the root's name prefix, which the previous prefix check accepted.
Fae agents no longer register these path-rooted tools themselves (the `setup-fs-tools` caplets are removed); a harness that wants them registers the tool makers itself.
