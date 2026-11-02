---
'@endo/floot': patch
---

The work-area setup in the Floot system prompt now clones with one `provideGitClone` call that also names the `origin` remote, and tells the agent that a failed clone can be retried as is.
