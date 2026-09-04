---
'@endo/agent-tools': minor
'@endo/exo-git': minor
'@endo/git': minor
---

Add `checkoutConflict` to the Git capability, native backend, and mount-bridged
agent tools, with confined mount-entry inputs and exact Git index-side
semantics.
`makeGitTool` can now derive reader, writer, and rewriter catalogs from the
granted facet, while `makeGitHistoryTool` retains its four-tool compatibility
inventory using the canonical rewriter schemas and guards.
