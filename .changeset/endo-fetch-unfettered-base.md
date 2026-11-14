---
'@endo/fetch': major
---

`@endo/fetch` is now the unconfined base plugin: `make()` adapts the worker's ambient `fetch` into a passable, unfettered `Fetch` capability with no allowlist, caps, policy, or persistence.
A response body is a `CloseablePassableBytesReader`, and a request may carry a `cancelled` promise that aborts it.
The new `timer.js` entry provides a cancellable `Timer` that confined plugins are endowed with instead of ambient time.
The stateful service, allowlist, and pins moved to `@endo/confined-fetch`; provision that plugin, endowed with a base `Fetch` from this one.
