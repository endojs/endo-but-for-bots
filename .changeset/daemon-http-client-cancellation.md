---
'@endo/daemon': patch
---

The `http-client` maker adapts the platform `fetch` with `makeFetchLikeFromPlatformFetch`, so a request timeout or revocation still aborts the in-flight request.
`HttpClientControl` mutators returned by `getHttpClientControl` now return promises that settle once the change is durable.
