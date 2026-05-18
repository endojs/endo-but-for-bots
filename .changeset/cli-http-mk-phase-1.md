---
'@endo/daemon': minor
'@endo/cli': minor
---

Add `endo http mk` (Phase 1 of `designs/cli-http-client.md`).
The verb constructs a paired HTTP controller + client capability under
two pet names, with a host-curated origin allowlist set at
construction.
The controller bears the policy (Phase 1: read-only `inspect()`); the
client bears the use-the-policy authority (`request({ url, method?,
headers? })` and `allowedOrigins()`) and enforces the allowlist on
every call.

The mint signature on `EndoHost` is
`makeHttpClient(controllerName, clientName, allowedOrigins)`.

Subsequent phases land the `allow`, `deny`, `revoke`, `inspect` verbs
(Phase 2), rate / size / timing guards and per-request cancellation
(Phase 3), and methods beyond GET-class plus response streaming
(Phase 4).
