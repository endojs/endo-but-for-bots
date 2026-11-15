---
'@endo/exo-http-client': major
'@endo/http-confine': major
---

Neither package has been released yet, so these breaking changes affect only in-repo consumers.

`@endo/exo-http-client` breaking changes:
- `FetchLikeRequestOptions.signal` is replaced by `cancelled`, a `Promise<never>`, so an injected `fetch` must honor `cancelled`.
  Wrap a platform `fetch` with the new `makeFetchLikeFromPlatformFetch`; the default ambient `fetch` is wrapped already.
- Every `HttpClientControl` mutator, including `revoke`, `setMaxRequestsPerMinute`, `setMaxResponseBytes`, and `setPolicyMode`, returns `Promise<void>`.
  A caller that does not await a mutator does not see an `onPolicyChange` persistence failure.
- `makeHttpClientAndControl` and `makeTrustOnFirstBindPolicyAdapter` take a `delay` function for request deadlines, rate windows, and policy-prompt timeouts.
  A caller-supplied `now` now only stamps bindings and audit entries, and may return a `Promise<number>`.
- `policyPromptTimeoutMs` must be at most `2 ** 31 - 1`.
- A policy authority is invoked with `E(authority).decide(request)`, so it may be remote, and receives a hardened request.

`@endo/exo-http-client` additions:
- `initialBindings` reconstitutes the trust-on-first-bind table on restart.
- `onPolicyChange(snapshot)` reports each durable policy or binding change.
  A control mutation resolves only after the callback's returned promise fulfills, and rejects if it rejects.
- The package re-exports the `Delay` and `FetchLike` types from `@endo/http-confine`.

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
