---
'@endo/agent-tools': major
'@endo/agentry': minor
---

Breaking: `makeWorkspaceTools` and `provisionWorkspaceTools` now qualify method names that collide across granted capabilities.
Shell and GitRemote inspection tools are `inspectShell` and `inspectGitRemote`.
GitRemote and HTTP fetch tools are `fetchGitRemote` and `fetchHttp`.
Callers that dispatch the composed catalog's former `inspect` or `fetch` names must adopt the qualified names; standalone tool makers keep their established names.
Shell, GitRemote, and HTTP grants can now coexist in one workspace catalog without a name collision.
Add `@endo/agentry/workspace-agent`, whose `defineWorkspaceAgent` builds a Pi agent from explicitly supplied workspace grants and never searches a guest petstore for additional authority.
