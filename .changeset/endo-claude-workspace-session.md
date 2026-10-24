---
'@endo/claude': minor
---

Add `provisionEndoClaudeGuest`, which binds a workspace mount, Git, GitRemote,
and Shell into a guest for an endo-claude session. The provisioner refuses a
Shell unless its own `inspect()` result reports the sandbox engine.
