---
'@endo/immutable-arraybuffer': patch
---

The shim's emulated TypedArray constructors now carry every own static of the
genuine constructor they replace. On engines that implement the ArrayBuffer
base64 proposal, `Uint8Array.fromBase64` and `Uint8Array.fromHex` were hidden
behind the replacement `Uint8Array` global, so feature tests such as
`@endo/base64`'s fell back to JavaScript decoding.
