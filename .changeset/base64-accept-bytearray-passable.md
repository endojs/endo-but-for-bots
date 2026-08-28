---
'@endo/base64': patch
---

`@endo/base64` now encodes a frozen `Uint8Array` byteArray passable (issue
#573) correctly, bringing it to parity with its `@endo/hex` twin.

`jsEncodeBase64` and `encodeBase64` accept a `Uint8Array` (the narrowed
byteArray shape) and gate on `ArrayBuffer.isView`, the committed
genuine-vs-emulated distinguisher: a genuine view (mutable or immutable
buffer) is read in place, while an emulated `@endo/immutable-arraybuffer`
wrapper — a plain object reporting `isView === false`, whose `bytes[i]` reads
`undefined` — is thawed into a mutable `Uint8Array` first.
`encodeBase64` also dispatches to the native `Uint8Array.prototype.toBase64`
intrinsic (or the legacy `globalThis.Base64.encode` XS binding) only for
genuine views, whose bytes the native code can read; an emulated wrapper falls
through to the pure-JavaScript polyfill. Previously the polyfill's
integer-indexed read silently produced all-zero output for an emulated
byteArray, and the native path had no such guard. Not reached by an in-repo
passable today, but the byteArray narrowing that reached `@endo/hex` did not
reach its twin.
