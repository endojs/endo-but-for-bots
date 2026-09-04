---
'@endo/sha256': major
---

Add `@endo/sha256`, a platform-neutral synchronous SHA-256 over bytes. One
import specifier resolves through conditional exports to `node:crypto` under
`node`, to Endor's `hostSha256Bytes` contract under `xs`, and to a
pure-JavaScript digest under `browser` and `default`. The API is `sha256(bytes)
-> Uint8Array(32)` and `sha256Into(out, bytes, offset)`; input and output are
`Uint8Array`, the digest is raw bytes rather than hex or base64, and a
non-`Uint8Array` argument throws `TypeError` rather than being coerced.

It exists so a module that has to survive the SES/XS bundler can hash without a
static `node:crypto` import, which that bundler cannot resolve. Streaming is
deliberately out of scope: the daemon's streaming digest already arrives as an
injected `CryptoPowers` capability, and only *static* imports are the problem.
