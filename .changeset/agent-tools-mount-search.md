---
'@endo/agent-tools': minor
---

Add `makeMountGlobTool` / `makeMountGrepTool` / `makeMountSearchTools`, the
capability-backed file-name and content search tools for an agent, filling the
previously-empty Search group of the daemon agent-tool catalog. Both close over
the smallest slice of `EndoMount` — `glob` / `grep` — structurally typed to
avoid a circular `@endo/daemon` dependency (the `git-mount-tool.js` precedent),
and both are `scope: 'read'`. `mountGlob { pattern, maxResults? }` returns sorted
mount-relative `paths` and a `truncated` flag; `mountGrep { pattern, filesGlob?,
maxResults? }` returns `{ file, line, text }` matches and a `truncated` flag,
performing the glob→grep composition at the tool layer
(`grep(pattern, glob(filesGlob))`) so an LLM pays neither a round trip nor the
token cost of ferrying a path list through its context — while the *capabilities*
stay decoupled. Patterns and paths are authenticated at the mount boundary, never
petnames. See designs/platform-search-pushdown.md § "Agent tool surface".
