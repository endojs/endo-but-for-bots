---
'@endo/fae': minor
---

Add `glob` and `grep` filesystem tools to Fae agents.
The tools use `@endo/platform/fs/search` to find paths by pattern and search file contents with ECMAScript regular expressions.
The `grep` tool rejects regular expressions with potentially exponential evaluation cost.
Run `yarn setup-fs-tools` to add them to an agent's tool inventory.
