---
'@endo/fetch': major
'@endo/confined-fetch': major
'@endo/exo-http-client': major
'@endo/http-confine': major
---

`@endo/fetch` is a new plugin whose `make()` returns a passable, unfettered `Fetch` capability over the worker's own `fetch`.
A response is a record with the Fetch Standard `type`, status, headers, and a `CloseablePassableBytesReader` body.
A request may carry a `cancelled` token that aborts it.
The `@endo/fetch/timer.js` plugin provides a cancellable `Timer` for confined plugins that need time.
Neither capability is for guests.

`@endo/confined-fetch` is a new plugin that gives a guest a bounded `HttpClient` (origin allowlist, rate and byte caps, trust-on-first-bind pins) over a `Fetch` and `Timer` you endow.
The integration keeps the `HttpClientControl`.
Policy and pins persist in a private state directory, so a service revived under `@pins` keeps them.
A stored policy that cannot be read refuses revival instead of falling back to the provisioning `env`.

`@endo/exo-http-client` breaking changes:
- `FetchLikeRequestOptions.signal` is replaced by `cancelled`, a `Promise<never>`, so an injected `fetch` must honor `cancelled`.
  Wrap a platform `fetch` with the new `makeFetchLikeFromPlatformFetch`; the default ambient `fetch` is wrapped already.
- Every `HttpClientControl` mutator, including `revoke`, `setMaxRequestsPerMinute`, `setMaxResponseBytes`, and `setPolicyMode`, returns `Promise<void>`.
- `makeHttpClientAndControl` and `makeTrustOnFirstBindPolicyAdapter` take a `delay` function for request deadlines, rate windows, and policy-prompt timeouts.
  A caller-supplied `now` now only stamps bindings and audit entries, and may return a `Promise<number>`.
- `policyPromptTimeoutMs` must be at most `2 ** 31 - 1`.
- A policy authority is invoked with `E(authority).decide(request)`, so it may be remote, and receives a hardened request.

`@endo/exo-http-client` additions:
- `initialBindings` reconstitutes the trust-on-first-bind table on restart.
- `onPolicyChange(snapshot)` reports each durable policy or binding change.
  A control mutation resolves only after the callback's returned promise fulfills, and rejects if it rejects.
- The package exports a `Delay` type.

`@endo/http-confine` breaking changes:
- `makeRequestSignal` is removed.
  `makeRequestCancellation({ timeoutMs, cancellation, delay })` returns a cancellation token instead of an `AbortSignal`.
- `FetchLikeRequestOptions.signal` is replaced by `cancelled`, and `limitResponseBytes` takes `cancelled` instead of `signal`.
- `makeRateLimiter` takes `{ maxPerMinute, delay, cancelled }` instead of `{ maxPerMinute, now }`, and its limiter gains `setMaxPerMinute`.
- `makeHttpConfinement(policy, { fetch, delay })` no longer reads a `now` option.
- `timeoutMs` must be at most `2 ** 31 - 1`.

`@endo/http-confine` behavior changes:
- Redirect validation applies only to the Fetch redirect statuses (301, 302, 303, 307, 308), so a 304 or other 3xx response without a `Location` is no longer rejected.
- An opaque redirect and a malformed `Location` are rejected.
- The `x-http-method`, `x-http-method-override`, and `x-method-override` request headers are forbidden.
- If the rate window's `delay` rejects, the limiter refuses every later request.
- `setMaxRequestsPerMinute` retunes the existing limiter, so requests already in the window still count.

Migration: pass `cancelled` where `signal` was passed, a `delay` function where `now` drove timing, and await the control mutators.
In tests, inject a fake `delay` rather than a fake `now` to control rate windows.
