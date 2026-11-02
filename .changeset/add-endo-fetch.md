---
'@endo/fetch': major
'@endo/confined-fetch': major
'@endo/exo-http-client': minor
'@endo/http-confine': minor
---

`@endo/fetch` is the unconfined base plugin.
Its `make()` adapts the worker's ambient `fetch` into a passable, unfettered `Fetch` capability with no allowlist, caps, policy, or persistence.
A response body is a `CloseablePassableBytesReader`, and a request may carry a `cancelled` promise that aborts it.
Its `timer.js` entry provides a cancellable `Timer` that confined plugins are endowed with instead of ambient time.
Migration: the stateful service, allowlist, and pins that `@endo/fetch` previously provisioned (`./src/service.js`, `./src/store.js`) moved to `@endo/confined-fetch`.
Replace a provisioned `@endo/fetch` plugin with `@endo/confined-fetch`, endowed with a base `Fetch` from `@endo/fetch`.
Both packages are private and unpublished, so no released consumer is affected.

`@endo/confined-fetch` is a new plugin that builds the `@endo/exo-http-client` `HttpClient` and `HttpClientControl` pair over an endowed base `Fetch`, never ambient `fetch`.
A guest receives only the `HttpClient` from its `client()` facet.
It requires a `timer` power, and persists policy and trust-on-first-bind pins in a private state directory so a service revived under `@pins` keeps them.

`@endo/http-confine` changes its public API.
`makeRequestSignal` is removed in favor of `makeRequestCancellation`, which takes `{ timeoutMs, cancellation, delay }` and returns a cancellation token rather than an `AbortSignal`.
`FetchLikeRequestOptions.signal` is replaced by `cancelled` (a `Promise<never>`).
`makeRateLimiter` takes `{ maxPerMinute, delay, cancelled }` instead of `{ maxPerMinute, now }`.
`limitResponseBytes` takes a `cancelled` option instead of `signal`.
`makeHttpConfinement(policy, { fetch, delay })` no longer reads a `now` option.
Migration: pass `cancelled` where `signal` was passed, and a `delay` function where `now` was passed.
Redirect validation now applies only to the Fetch redirect statuses (301, 302, 303, 307, 308), so a 304 or other 3xx response without a `Location` is no longer rejected.
An opaque redirect and a malformed `Location` are rejected.
The `x-http-method`, `x-http-method-override`, and `x-method-override` request headers are now forbidden.
The package now depends on `@endo/cancel`.

`@endo/exo-http-client` changes its public API.
`FetchLikeRequestOptions.signal` is replaced by `cancelled`, so an injected `fetch` must honor `cancelled` instead of an `AbortSignal`.
The `HttpClientControl` methods `setAllowedOrigins`, `addAllowedOrigin`, `removeAllowedOrigin`, `revokeBinding`, and `unpin` now return `Promise<void>`.
`makeHttpClientAndControl` and `makeTrustOnFirstBindPolicyAdapter` take a `delay` function for request deadlines, rate windows, and policy-prompt timeouts.
A caller-supplied `now` no longer drives the rate window, and `now` may return a `Promise<number>`.
Migration: await the control mutators, and inject a fake `delay` rather than a fake `now` to control rate windows in tests.
`policyPromptTimeoutMs` must be at most `2 ** 31 - 1`.
Two additive seams let a request-time pin survive a restart: `initialBindings` reconstitutes the trust-on-first-bind table, and `onPolicyChange(snapshot)` reports each durable policy or binding change.
The package exports a new `Delay` type and depends on `@endo/cancel`.
