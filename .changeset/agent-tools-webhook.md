---
"@endo/daemon": minor
---

Add WebhookEndpoint kit: a host-controlled inbound webhook capability with
a 32-byte HMAC-SHA256 secret. The endpoint exposes `verify(body,
signatureHex)` for constant-time signature checking and `handleRequest`
auto-rejects payloads with an invalid `x-webhook-signature` header.
Includes payload-size and rate limits, plus `disable`/`enable` and
`revoke` lifecycle hooks. The endpoint is delivered to the agent's
mailbox via an `onPayload` callback wired by the host. (CLI exposure of
the webhook surface lands in a follow-up; this changeset documents the
exo pair only.)
