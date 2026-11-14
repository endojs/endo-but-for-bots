---
'@endo/confined-fetch': minor
---

`@endo/confined-fetch` is a new plugin that builds the `@endo/exo-http-client` `HttpClient` and `HttpClientControl` pair over an endowed base `Fetch` and `Timer`, never ambient `fetch` or time.
A guest receives only the `HttpClient` from its `client()` facet.
Policy and trust-on-first-bind pins persist in a private state directory, so a service revived under `@pins` keeps them.
