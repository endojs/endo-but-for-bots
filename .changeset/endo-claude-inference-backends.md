---
'@endo/claude': minor
---

New: `makeClaudeCliBackend` (`@endo/claude/cli-backend.js`) and `makeClaudeSdkBackend` (`@endo/claude/sdk-backend.js`) are `@endo/inference` backends, each made over a single `CredentialSource`.
Both accept an optional `maxBudgetUsd` spend ceiling.
A backend reports `unavailable` and runs nothing unless the installed `claude` binary matches the pinned version, so install that version to use it.
Authentication failures are not yet classified as `needs-auth`; they surface as a generic failure.
