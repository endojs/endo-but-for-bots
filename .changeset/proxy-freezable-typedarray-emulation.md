---
'@endo/immutable-arraybuffer': minor
---

Add a Proxy-based freezable-TypedArray emulation as an alternative for
comparison, published as `@endo/immutable-arraybuffer/proxy-lib.js`.

The shipped emulation (`./shim.js`) wraps the hidden genuine TypedArray in a
plain ordinary object, so integer-indexed assignment (`view[0] = 42`) creates a
wrapper-local own property rather than throwing. The new `proxy-lib.js` exports
a `Proxy`-based variant whose `set` trap rejects integer-indexed keys with a
`TypeError` while forwarding every other operation:

- `makeIndexRejectingProxy(genuineTA, immutableBuffer)` — the natural shape
  (target is the genuine TypedArray). Integer-indexed reads and methods forward;
  integer-indexed assignment throws; **`Object.freeze` / `harden` throw**,
  because an integer-indexed exotic refuses to make index `"0"` non-configurable.
- `makeFreezableIndexRejectingProxy(genuineTA, immutableBuffer, flavorProto)` —
  the repaired shape (target is a freeze-able plain object). Same assignment
  behavior, but `Object.freeze` / `harden` succeed, at the cost of
  `ownKeys` / `getOwnPropertyDescriptor` reflection diverging from a genuine view.
- `makeProxyPseudoTypedArrayConstructor(OriginalCtor, isBufferImmutable)` — a
  drop-in constructor analog that produces the freezable variant.

This is a library-only addition: it installs nothing on the primordials and
does not change the behavior of `./shim.js`. It exists so the three objections
in `designs/freezable-typedarray.md` ("Why not a Proxy wrapper?") — freezability
under proxy invariants, hot-path overhead, and the value of a throwing write —
can be checked empirically. The design's worked example is corrected: a fresh
plain-object emulated view returns `undefined` for `view[0]` (there is no
integer-indexed slot), a read-parity gap the Proxy variant closes.

Property-assignment parity between an emulated view and a genuine TypedArray is
pinned down on both Node and XS by a new `@endo/test262-runner` suite
(`yarn workspace @endo/test262-runner test262:iab`).
