---
"@endo/lal": minor
---

Lal workers now compact their conversation automatically when it nears the
model's context window, and the host can compact on demand by sending the worker
`/compact [instructions]`. Each compaction replaces older messages with one
structured summary that builds on the previous one, and keeps a cumulative list
of files the agent touched. Configure it with the `LAL_COMPACTION_*` variables in
the daemon's environment.
