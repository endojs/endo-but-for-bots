---
'@endo/exo-agent-factory': minor
---

New `@endo/exo-agent-factory` package: a capability-scoped coordinator that
provisions durable child-agent guests from a held `AgentDriverMaker`.
Bound facets create, list, look up, and remove children inside a namespace
whose policy only narrows under `bind` and `attenuate`, with quota nested
across derived namespaces and `revokeDerived` reclaiming a derived namespace
without its facet.
Every provisioning step is journaled and proved before adoption, so a crash at
any effect converges to exactly one committed child or none on restart.
