---
'@endo/harden': minor
---

Export `./make-hardener.js`, so a host that already has a `harden` decision to
make can build a hardener directly instead of going through the selector.

The selector in `index.js` is the right entry point for ordinary consumers: it
adopts `Object[Symbol.for('harden')]` or `globalThis.harden` if either exists,
and installs its own only when neither does. That last step is deliberately
lockdown-poisoning — it defines `Object[Symbol.for('harden')]` non-configurably,
and SES's `repairIntrinsics` refuses to run at all when it finds that slot
occupied.

An environment that must supply `globalThis.harden` *before* `lockdown()` needs
the hardener without that installation step, and `makeHardener` is exactly it.
`@endo/test262-runner`'s Ironhorse SES prelude is the first such consumer: it
hands the selector a `makeHardener({ traversePrototypes: false })` to adopt, so
nothing lands in the poisoning slot and the intrinsics `lockdown()` still has to
tame are not frozen out from under it.

Two ordering constraints come with that use, and both have bitten already.
Install it AFTER the `ses` shim's module evaluation: `makeHardener()` in
`ses/src/make-hardener.js` adopts an existing `globalThis.harden`, and
`ses/src/lockdown.js` calls it at module scope, so a hardener present earlier
becomes the guest's `harden` for the life of the realm — `lockdown()` reinstalls
it rather than replacing it, and a non-traversing one then leaves every hardened
object's prototype extensible. And withdraw it BEFORE calling `lockdown()`: the
shim collects the start global's own `harden` as an intrinsic and separately
adds its own, and `ses/src/intrinsics.js` rejects the pair as `Conflicting
definitions of harden`.

Additive: no existing export or behaviour changes.
