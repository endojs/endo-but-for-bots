---
'@endo/fetch': minor
'@endo/confined-fetch': minor
'@endo/exo-http-client': minor
'@endo/http-confine': patch
---

Split confined outbound HTTP into two plugins per `designs/endo-fetch.md`.

`@endo/fetch` is now the unconfined base plugin: its `make()` adapts the
worker's ambient `fetch` into a passable, unfettered `Fetch` capability with no
allowlist, caps, policy, or persistence. A response is a record whose body is a
`CloseablePassableBytesReader`, and a request may carry a `cancelled`
promise that aborts it, so the capability crosses vat boundaries. Its
`timer.js` entry provides the separately endowed, cancellable `Timer` used by
confined plugins without granting ambient time.

`@endo/confined-fetch` is the stateful confined plugin, endowed with that base
`Fetch` and a private virtual-file-system state directory. It builds the
`@endo/exo-http-client` `HttpClient` / `HttpClientControl` pair over the
endowed base only, never ambient `fetch`, and returns a `ConfinedFetchService`
whose `client()` is the only facet a guest receives. Durable policy
(`config.json`) and trust-on-first-bind pins (`bindings.json`) persist through
write-then-`move` replacement; the store, not the `env` initials, is
authoritative across restarts, and a revoked service revives revoked when the
integration re-endows the same base and directory under `@pins`.

`@endo/exo-http-client`'s `makeHttpClientAndControl` and
`makeTrustOnFirstBindPolicyAdapter` gain two backward-compatible persistence
seams so a request-time pin can survive a restart: an `initialBindings` argument
that reconstitutes the trust-on-first-bind table, and a change-notification
callback invoked in a later event after any durable policy or binding mutation. On
`makeHttpClientAndControl` the callback is `onPolicyChange(snapshot)`, receiving
the persistable snapshot; the underlying `makeTrustOnFirstBindPolicyAdapter`
exposes the lower-level `onChange()` (no argument), which `makeHttpClientAndControl`
adapts into the snapshot-bearing form.

The confinement stack now uses `@endo/cancel` tokens and injected `delay` /
async-capable `now` seams for request deadlines, revocation, rate windows,
policy-prompt timeouts, and audit stamps. `@endo/confined-fetch` requires an
endowed Timer and therefore runs in the ordinary daemon confined-worker
compartment without ambient timers, `AbortController`, or `Date.now()`.
