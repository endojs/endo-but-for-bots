---
'@endo/fae': minor
---

Add `glob` and `grep` filesystem tools to Fae agents.
The tools use `@endo/platform/fs/search` to find paths by pattern and search file contents with ECMAScript regular expressions.
The `grep` tool applies a conservative complexity check that rejects nested quantifiers and some other high-risk regular expressions.
Fae filesystem tools now reject paths in sibling directories that share the root's name prefix, which the previous prefix check accepted.
Consumers of the exported Fae tool makers can register these tools in their own harnesses.
