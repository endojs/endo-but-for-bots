---
'@endo/base64': patch
---

- `encodeBase64` now dispatches to the native `Uint8Array.prototype.toBase64`
  intrinsic (TC39 proposal-arraybuffer-base64, Stage 4) when available,
  falling through to the existing `globalThis.Base64.encode` XS binding and
  the pure-JavaScript polyfill otherwise.
- `decodeBase64` dispatches to the native `Uint8Array.fromBase64` intrinsic
  with the same fallthrough chain. The optional `name` parameter is silently
  accepted and ignored on the native path because the TC39 intrinsic does
  not embed a caller-supplied name in its `SyntaxError` messages.
- No public API change. The polyfill implementations remain exported as
  `jsEncodeBase64` and `jsDecodeBase64` for benchmarking and for consumers
  that rely on the polyfill's exact error-message text.
