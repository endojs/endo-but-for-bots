---
'@endo/eventual-send': minor
'ses': patch
---

Install the eventual-send peers (delegate, applyMethod, applyFunction, get, resolve, etc.) at registered-symbol slots on `Promise`, anticipating the TC39 `Promise.delegate` direction.
The package main entry exports lexical ponyfill thunks (`delegate`, `applyMethod`, `applyMethodSendOnly`, `applyFunction`, `applyFunctionSendOnly`, `get`, `getSendOnly`, `resolve`) that lazily resolve the realm-shared peer on first call.
The eager `@endo/eventual-send/shim.js` installs all peers at module load; the lazy main entry installs each peer on first call to its corresponding thunk.
Both surfaces converge on the same realm-shared peers via the symbol slots, regardless of import order vs lockdown.
SES permits the new `RegisteredSymbol(...)` slots on `Promise`, strictly parallel to `Object[Symbol.for('harden')]`.
The legacy `HandledPromise` constructor surface is preserved as a back-compat adapter.
