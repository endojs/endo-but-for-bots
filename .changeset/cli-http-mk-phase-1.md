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

The runtime confinement is delegated to the landed `@endo/exo-http-client`
capability (over `@endo/http-confine`): the daemon `http-client` formula
builds the confined `HttpClient` through `makeHttpClientAndControl` and
adapts its `fetch()` surface to the `request({ url, method?, headers? })`
shape, rather than re-implementing origin/redirect/rate confinement in the
daemon. `@endo/daemon` now depends on `@endo/exo-http-client`.

Subsequent phases land the `allow`, `deny`, `revoke`, `inspect` verbs
(Phase 2), rate / size / timing guards and per-request cancellation
(Phase 3), and methods beyond GET-class plus response streaming
(Phase 4).
