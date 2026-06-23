---
'ses': minor
---

Adds `TextEncoder` and `TextDecoder` to the permitted universal intrinsics.
These WHATWG Encoding Standard constructors are pure transformations between
`string` and `Uint8Array` with no static ambient-authority methods and no
exposed iterator prototype, so they are now sampled during the
intrinsics-collection pass, whitelisted, and hardened like any other
universal intrinsic. On hosts that do not provide them (such as XS),
lockdown proceeds without them exactly as before.

Note: as with every permitted intrinsic, the codecs and their prototypes
are frozen after `lockdown()`. Code that monkey-patches
`TextEncoder.prototype` or `TextDecoder.prototype` must do so before
lockdown.
