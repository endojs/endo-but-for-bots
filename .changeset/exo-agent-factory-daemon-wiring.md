---
'@endo/exo-agent-factory': minor
---

Wire the child-agent coordinator to a real daemon.
`installChildAgentFactory(host, { rootPolicy })` creates the dedicated
`agent-factory` child host, formulates the coordinator over it with
`makeUnconfined`, pins it in the deploying host's `@pins`, and returns the
root facet, so the daemon revives every committed child's runner at start
with no holder call and no mail.
Bound facets and each runner's lifecycle facet are `evaluate` formulas over
the coordinator, so they keep working after a restart without being
re-issued, and a revoked facet keeps rejecting.
`AgentDriverMaker.installDriver` now returns the runner's module specifier
rather than a responder value: the coordinator formulates the runner at its
own derived name, where a replay can prove its formula type and powers.
