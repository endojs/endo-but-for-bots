---
'@endo/agent-tools': minor
'@endo/agentry': minor
'@endo/lal': patch
---

Upgrade `@earendil-works/pi-agent-core` and `@earendil-works/pi-ai` to 0.81.1.

pi-agent-core 0.81 evaluates `runtimeOptions.streamFn ?? getDefaultStreamFn()`
in the `Agent` **constructor**, and `getDefaultStreamFn()` throws unconditionally
unless the host has called the upstream `setDefaultStreamFn` hook (ambient
mutable module state this repository deliberately declines). `@endo/agentry`'s
`makePiAgent` harness now supplies `streamSimple`
from `@earendil-works/pi-ai/compat` explicitly — as
`streamFn ?? streamSimple` so a caller can override it —
restoring the implicit 0.80 behavior where construction does not throw.

`@endo/agent-tools` narrows its (optional) `peerDependency` floor on
`@earendil-works/pi-agent-core` and `@earendil-works/pi-ai` from `^0.80.3` to
`^0.81.1`; on 0.x those caret ranges are disjoint, so a consumer resolving
pi 0.80.x now fails peer resolution and must move to 0.81.x.

`@endo/lal` is a range repoint only (its `makePiAgent` call already routes
through `@endo/agentry/harness`, which supplies the stream-function default).
