---
'@endo/daemon': minor
---

Add Phase 1 of message streaming: a new `streamReply(messageNumber, options?)` method on the mail facet (exposed on `EndoHost` and `EndoGuest`) that opens a streaming reply to an existing inbox message.  The sender receives a `StreamWriter` with `append(text)`, `setPhase(phase)`, `end()`, and `abort(reason)`; the recipient sees the message with a `stream` async-iterator exo (next/return/throw) whose values are `StreamEvent` records (`type` is one of `append`, `phase`, `end`, `abort`).  The finalised message persists on `end()` or `abort()` as a normal `package` message carrying the assembled text plus any phase/abort metadata; in-flight stream state lives in memory only.  Back-pressure and the alternative `streamSend` for new conversations are deferred to a follow-up phase.  See `designs/daemon-message-streaming.md`.
