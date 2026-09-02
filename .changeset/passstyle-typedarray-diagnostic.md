---
'@endo/pass-style': patch
---

`passStyleOf` no longer blames mutability when a non-`Uint8Array` typed array
is rejected. The `byteArray` pass style accepts only a whole-buffer
`Uint8Array` over an immutable `ArrayBuffer`; a typed array of any other
element type is rejected for its element type, not its mutability. The
late fall-through guard previously reported every unclaimed genuine
`TypedArray` with the "Cannot pass mutable typed arrays" message, which
misleads for a genuinely frozen non-`Uint8Array` typed array over an
immutable buffer (reachable on a native Immutable-ArrayBuffer engine, and on
the shim leg under unsafe harden taming) — mutability is not the problem
there. That case now reports "Cannot pass typed arrays other than Uint8Array".
A `Uint8Array` still reports the mutable message, since it only reaches that
guard backed by a mutable buffer (an immutable-backed one is always accepted).
