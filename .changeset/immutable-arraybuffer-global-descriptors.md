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

A Node.js `vm` context's global is V8's *global proxy* — not an ECMAScript
`Proxy`, `util.types.isProxy` returns `false` for it — and its
`defineProperty` interceptor completes a partial descriptor with the spec's
`false` defaults instead of merging. In such a realm the shim silently turned
all eleven TypedArray globals and `DataView` non-writable and
NON-configurable. Measured identically on Node 20, 21 and 22, so this is not
version-specific.

That is not cosmetic. SES's `lockdown()` repairs the global object by
redefining the intrinsics it permits, and cannot redefine a non-configurable
one, so it aborted with `TypeError: Cannot redefine property: BigInt64Array`.
The shim therefore worked on a real global and broke inside a `vm` realm —
which is where `test262-harness --host-type node` evaluates every case. Once
two earlier causes in that corpus's own prelude were removed, this was what
still stopped `@endo/test262-runner`'s `ses-xs-parity` lane from locking down
on the node host.

The global-replacement step moved to `installEmulatedGlobalConstructors` in
`src/lib.js`, which takes the target global so the descriptor it leaves behind
can be tested against a `vm` global rather than only the host's. Asserting the
descriptors in the host realm cannot catch this, because there the partial form
merges correctly.

Two tests guard it. `test/shim-global-descriptors.test.js` pins the helper,
and `test/shim-vm-realm.test.js` evaluates the real `src/shim.js` inside a
`vm` realm, so it also catches a change that inlines the install back with a
partial descriptor — the configuration that caused this, which the helper test
alone does not see. No bundler is needed for that: `src/lib.js` has no
imports, so the graph is two modules and `vm.SourceTextModule` links them
directly.

Scope, stated precisely: **no released version contains this code.** The
published shim through 2.0.0 touches only `ArrayBuffer.prototype`; the
global-constructor replacement is unreleased, so the defect has never reached
a consumer and this fix prevents rather than repairs.
