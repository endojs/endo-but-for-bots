---
'@endo/exo-agent-factory': major
---

New `@endo/exo-agent-factory` package for creating and managing durable child-agent guests inside a policy-scoped namespace.
A holder of a factory facet can create, list, look up, and remove children, and can derive narrower factories whose quota counts against their issuer's.
Provisioning recovers from a crash at any step to exactly one committed child or none.
