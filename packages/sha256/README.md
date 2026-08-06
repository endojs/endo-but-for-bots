# @endo/sha256

`@endo/sha256` provides synchronous SHA-256 over `Uint8Array` values across
Node.js, browsers, and XS.

```js
import { sha256, sha256Into } from '@endo/sha256';

const digest = sha256(bytes); // a new 32-byte Uint8Array
sha256Into(output, bytes, offset); // writes 32 bytes and returns 32
```

Inputs and output buffers must be `Uint8Array` instances. `sha256Into` throws a
`RangeError` if fewer than 32 bytes remain in its output buffer. Digests are raw
bytes so callers choose their own text encoding.

The package selects Node's `node:crypto` under the `node` condition, a
synchronous pure-JavaScript implementation under `browser` and `default`, and
the Endo XS SHA-256 host functions under `xs`.
When those host functions are unavailable, the XS entry uses the synchronous
pure-JavaScript implementation.

## Why a pure-JavaScript browser implementation instead of Web Crypto?

The Web Crypto API exposes SHA-256 only through `crypto.subtle.digest`, which is
**asynchronous** — it returns a `Promise<ArrayBuffer>`. This package guarantees a
**synchronous** `Uint8Array -> Uint8Array` primitive, and browsers offer no
synchronous digest to build that on, so there is nothing to ponyfill against. The
pure-JavaScript implementation is consequently the mainline, evergreen browser
and `default` path rather than a legacy-only fallback. It is also the code that
runs on legacy XS hosts (such as the Agoric chain) that lack the native SHA-256
host functions used under the `xs` condition.
