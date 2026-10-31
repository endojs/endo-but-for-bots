---
'@endo/agent-tools': patch
---

The read-only code-mode Git declaration now advertises the whole reader facet,
adding `help`, `followRootChanges`, and `followLatestRoot`, which the reader
facet already accepted but the prompt omitted.
