---
'@endo/exo-http-client': minor
---

Breaking API changes (a `minor` bump, as for any breaking change before 1.0):
- `FetchLikeRequestOptions.signal` is replaced by `cancelled`, so an injected `fetch` must honor `cancelled` instead of an `AbortSignal`.
- The `HttpClientControl` methods `setAllowedOrigins`, `addAllowedOrigin`, `removeAllowedOrigin`, `revokeBinding`, and `unpin` return `Promise<void>`.
- `makeHttpClientAndControl` and `makeTrustOnFirstBindPolicyAdapter` take a `delay` function for request deadlines, rate windows, and policy-prompt timeouts; a caller-supplied `now` no longer drives the rate window, and `now` may return a `Promise<number>`.
- `policyPromptTimeoutMs` must be at most `2 ** 31 - 1`.

Migration: await the control mutators, and inject a fake `delay` rather than a fake `now` to control rate windows in tests.

Additions: `initialBindings` reconstitutes the trust-on-first-bind table, `onPolicyChange(snapshot)` reports each durable policy or binding change, and the `Delay` type is re-exported from `@endo/http-confine`.
A binding revocation or unpin takes effect before its audit timestamp resolves.
