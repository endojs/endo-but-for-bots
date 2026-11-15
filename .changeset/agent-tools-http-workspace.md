---
'@endo/agent-tools': minor
'@endo/daemon': patch
---

Compose a granted `HttpClient` into `makeWorkspaceTools` and
`provisionWorkspaceTools`. The combined catalog qualifies colliding Shell,
GitRemote, and HTTP method names as `inspectShell`, `inspectGitRemote`,
`fetchGitRemote`, and `fetchHttp`.

Deprecate the daemon-specific `provideHttpClient` and `getHttpClientControl`
provisioning APIs and their formula types. Provision confined HTTP through the
`@endo/fetch` plugin instead.
