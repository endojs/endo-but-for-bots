---
'ses': minor
---

Tame and whitelist native `TextEncoder` and `TextDecoder` constructors as
permitted intrinsics in SES.

The hosts that provide `TextEncoder` and `TextDecoder` (Node.js, browsers) now
have their text codecs exposed to post-lockdown compartments on
`universalPropertyNames`: one identity-equal constructor across the start
compartment and every shared compartment.

On hosts without the codecs (XS), lockdown proceeds without them and
compartments observe their absence exactly as they do today for any missing
intrinsic; `typeof TextEncoder` returns `'undefined'`.

No code outside `packages/ses/src/permits.js` changes. The sampling mechanism
already tolerates missing properties: a permit whose name is absent on the host
global is simply skipped.

Any code that monkey-patches `TextEncoder.prototype` or `TextDecoder.prototype`
after `@endo/init` will now throw, because the permitted intrinsics are frozen.
Such code must perform its mutation before lockdown -- the same rule that
already applies to every other intrinsic.
