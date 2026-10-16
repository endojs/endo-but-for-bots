---
'@endo/immutable-arraybuffer': patch
---

Spell out the descriptor when the shim replaces the global TypedArray
constructors and `DataView`, so they stay configurable on a global object that
is not an ordinary object.

The install used `defineProperty(globalThis, name, { value })` and relied on
the merge semantics an ordinary object gives it: omitted attributes keep
whatever they already were, so a global constructor stayed
`{ writable: true, enumerable: false, configurable: true }`.

A Node.js `vm` context's global is a Proxy, and its `defineProperty` completes
a partial descriptor with the spec's `false` defaults instead of merging. In
such a realm the shim silently turned all eleven TypedArray globals and
`DataView` non-writable and NON-configurable.

That is not cosmetic. SES's `lockdown()` repairs the global object by
redefining the intrinsics it permits, and cannot redefine a non-configurable
one, so it aborted with `TypeError: Cannot redefine property: BigInt64Array`.
The shim therefore worked on a real global and broke inside a `vm` realm —
which is where `test262-harness --host-type node` evaluates every case, and
why `@endo/test262-runner`'s `ses-xs-parity` corpus could not lock down on the
node host.

The global-replacement step moved to `installEmulatedGlobalConstructors` in
`src/lib.js`, which takes the target global so the descriptor it leaves behind
can be tested against a `vm` global rather than only the host's. Asserting the
descriptors in the host realm cannot catch this, because there the partial form
merges correctly.
