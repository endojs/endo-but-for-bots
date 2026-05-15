---
'ses': minor
---

Permit `TextEncoder` and `TextDecoder` as universal intrinsics.

`TextEncoder` and `TextDecoder` are pure transformations between `string` and
`Uint8Array` with no static side channels, so they are now permitted on every
compartment (start compartment and every compartment created after lockdown,
identity-equal). Their prototypes are frozen alongside the other tamed
primordials. On hosts that do not provide them (XS), lockdown proceeds without
them and compartments observe their absence as before.

Code that monkey-patches `TextEncoder.prototype` or `TextDecoder.prototype`
after `lockdown()` will now throw, because the prototypes are frozen. Such
mutations must happen before lockdown, the same rule that already applies to
every other intrinsic.

Lockdown's `cauterizeProperty` helper now tolerates non-configurable
`arguments` and `caller` own properties on native function intrinsics
(such as Chromium V8's `TextEncoder` and `TextDecoder` constructors)
rather than throwing. The properties remain in place and a warning is
emitted; in strict mode any read of `.arguments` or `.caller` still
throws, so the property's continued presence is not a post-lockdown
integrity hazard.
