---
'@endo/agent-tools': minor
---

`makeWorkspaceTools` and `provisionWorkspaceTools` accept a `gitFacet` option (`'reader'` or `'writer'`, default `'writer'`) that selects the git-tool catalog, so a read-only `Git` can be provisioned without advertising verbs it would refuse.
