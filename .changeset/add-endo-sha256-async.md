---
'@endo/sha256': minor
---

Add `@endo/sha256/async`, the asynchronous analogue of `@endo/sha256`.
`sha256Async(bytes) -> Promise<Uint8Array(32)>` and `sha256IntoAsync(out,
bytes, offset)` mirror the synchronous pair byte for byte, resolving through
the same conditional exports: `node` and `xs` wrap their synchronous
`node:crypto` and Endor `hostSha256Bytes` builds in a promise, while the
`browser` and `default` arm uses WebCrypto's `crypto.subtle.digest` — the
native digest the synchronous package could not use, because it returns a
`Promise` and `@endo/sha256`'s only in-graph consumer content-addresses inside
a synchronous exo factory. The browser arm falls back to the same pure-JS
digest when `crypto.subtle` is absent (an insecure `http://` context, or a
`default`-arm environment with no WebCrypto), deciding per call so an early
digest cannot pin the fallback for the process.
