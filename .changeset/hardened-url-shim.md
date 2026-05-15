---
'ses': minor
---

Permit `URL` and `URLSearchParams` as universal intrinsics.

`URL` and `URLSearchParams` are now permitted on every compartment (start compartment and every compartment created after lockdown, identity-equal). Their prototypes are frozen alongside the other tamed primordials. On hosts that do not provide them (XS), lockdown proceeds without them and compartments observe their absence as before.

The dangerous static methods `URL.createObjectURL` and `URL.revokeObjectURL` are cauterized off the constructor everywhere. Both mint or revoke handles into a host blob registry observable across realms, which is ambient authority and exactly the kind of side-channel that ocap discipline forbids. Code that needs `createObjectURL` must obtain it from the host before lockdown and explicitly endow a wrapper into the compartment that needs it.

The otherwise-hidden `%URLSearchParamsIteratorPrototype%` (reachable only as `Object.getPrototypeOf(new URLSearchParams().entries())`, not on `globalThis`) is seeded into the anonymous-intrinsics graph so its `next` method is hardened. Without that seeding, a compartment that obtained a single `URLSearchParams` could mutate the iterator prototype and influence every other compartment's iteration over a `URLSearchParams`.

Code that monkey-patches `URL.prototype` or `URLSearchParams.prototype` after `lockdown()` will now throw, because the prototypes are frozen. Such mutations must happen before lockdown, the same rule that already applies to every other intrinsic.

Lockdown's `cauterizeProperty` helper now tolerates non-configurable `arguments` and `caller` own properties on native function intrinsics (such as Chromium V8's `URL` constructor) rather than throwing. The properties remain in place and a warning is emitted; in strict mode any read of `.arguments` or `.caller` still throws, so the property's continued presence is not a post-lockdown integrity hazard.
