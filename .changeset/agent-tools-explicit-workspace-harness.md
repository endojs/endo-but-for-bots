---
'@endo/agent-tools': major
'@endo/agentry': minor
---

Breaking: a `makeWorkspaceTools` or `provisionWorkspaceTools` catalog now names the Shell bounds tool `inspectShell` and the GitRemote bounds tool `inspectGitRemote` instead of `inspect`.
Callers that dispatch the composed catalog's `inspect` tool must adopt the qualified name; the standalone `makeShellTool` and `makeGitRemoteTool` makers keep `inspect`.
Shell and GitRemote grants can now coexist in one workspace catalog without a name collision.
Add `@endo/agentry/workspace-agent`, whose `defineWorkspaceAgent` builds a Pi agent from explicitly supplied workspace grants and never searches a guest petstore for additional authority.
