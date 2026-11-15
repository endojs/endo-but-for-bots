---
'@endo/fetch': minor
'@endo/confined-fetch': minor
---

`@endo/fetch` is a new plugin whose `make()` returns a passable, unfettered `Fetch` capability over the worker's own `fetch`, and whose `@endo/fetch/timer.js` plugin provides a cancellable `Timer`.
Neither capability is for guests.

`@endo/confined-fetch` is a new plugin that gives a guest a bounded `HttpClient` (origin allowlist, rate and byte caps, trust-on-first-bind pins) over an endowed `Fetch` and `Timer`, and keeps policy and pins across restarts.
