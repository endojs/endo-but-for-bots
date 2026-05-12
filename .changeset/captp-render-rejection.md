---
'@endo/daemon': minor
---

Render `Error` reasons in CapTP rejection diagnostics. When a CapTP
`CTP_DISCONNECT.reason` carries an `Error` instance, the JSON-encoded
form on the wire was `{}` because `Error`'s own properties (`message`,
`stack`, `name`) are non-enumerable and therefore invisible to
`JSON.stringify`. The receiving side then surfaced the literal `{}`
for what was a structured exception, defeating triage of disconnect
causes.

`messageToBytes` now branches on
`message.type === 'CTP_DISCONNECT' && message.reason instanceof Error`
and rewrites the `reason` field as a plain
`{ '@@error': true, name, message, stack }` object before
`JSON.stringify`. The narrow guard keeps the fast path for `CTP_CALL`
and friends untouched, since those already serialize Error fulfilments
through `@endo/marshal`.

A new exported `renderRejection(reason)` helper formats a real `Error`,
the `@@error` sentinel shape, any other Passable via `passableAsJustin`,
and a non-Passable fallthrough as
`(non-passable <typeof>) <String(reason)>`, for use by callers that log
a CapTP rejection reason.
