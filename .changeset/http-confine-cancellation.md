---
'@endo/http-confine': major
---

Breaking API changes:
- `makeRequestSignal` is removed. The new `makeRequestCancellation({ timeoutMs, cancellation, delay })` returns a cancellation token rather than an `AbortSignal`.
- `FetchLikeRequestOptions.signal` is replaced by `cancelled`, a `Promise<never>`, and `limitResponseBytes` takes `cancelled` instead of `signal`.
- `makeRateLimiter` takes `{ maxPerMinute, delay, cancelled }` instead of `{ maxPerMinute, now }`, and its limiter gains `setMaxPerMinute`.
- `makeHttpConfinement(policy, { fetch, delay })` no longer reads a `now` option.
- `timeoutMs` must be at most `2 ** 31 - 1`.

Migration: pass `cancelled` where `signal` was passed, and a `delay` function (typed by the newly exported `Delay`) where `now` was passed.

Behavior changes:
- Redirect validation applies only to the Fetch redirect statuses (301, 302, 303, 307, 308), so a 304 or other 3xx response without a `Location` is no longer rejected. An opaque redirect and a malformed `Location` are rejected.
- The `x-http-method`, `x-http-method-override`, and `x-method-override` request headers are forbidden.
- If the rate window's `delay` rejects, the limiter refuses every later request rather than releasing the slot.
- `setMaxRequestsPerMinute` retunes the existing limiter, so requests already in the window still count.
