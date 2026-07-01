---
'@endo/pass-style': minor
'@endo/marshal': minor
'@endo/eventual-send': minor
'@endo/captp': minor
'ses': minor
---

Add the pass-style promise: a frozen, non-thenable carrier that satisfies `passStyleOf(x) === 'promise'` without exposing a `then` method, so `await passStylePromise` resolves to the carrier itself rather than to a settlement target. `@endo/pass-style` exports `makePromise()`, `isPassStylePromise(x)`, and a `PassStylePromise` type. `@endo/eventual-send` adds `HandledPromise.subscribe(x, onFulfilled, onRejected?)` (the fire-once primitive), `HandledPromise.settle(x)` (the promise-returning convenience that walks chains of pass-style and native promises), `makeSubscribableKit()`, and the `resolveExternalPassStylePromise` / `rejectExternalPassStylePromise` host bridges; `E.when` is re-implemented in terms of `HandledPromise.settle` without behavior change on native promises. `@endo/marshal` and `@endo/captp` recognize the new shape so that pass-style and native promise carriers encode through `convertValToSlot` identically. `ses` reflects the corresponding `HandledPromise` permit additions. Closes the "then-pinhole" footgun where an inbound promise reference would implicitly synchronize on `await`; producers and subscribers now synchronize only through an explicit operation. See endojs/endo#2869 for the design.
