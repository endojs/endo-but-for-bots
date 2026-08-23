# @endo/sha256

Synchronous SHA-256 over bytes, with one import specifier that resolves to a
different implementation on Node.js, in a browser, and under Endor.

```js
import { sha256, sha256Into } from '@endo/sha256';

const digest = sha256(bytes); // Uint8Array, length 32
```

## Why this package exists

A module that statically imports `node:crypto` cannot pass through the SES/XS
bundler (`@endo/compartment-mapper/bundle.js`), because there is no
`node:crypto` to resolve on the far side. That is what kept
`@endo/platform/fs/extended`'s content-addressed `BlobRef` out of the XS daemon
bundle: it hashed inline with `createHash('sha256')`. Such a module can import
`@endo/sha256` instead, and the bundler's conditions steer it to an
implementation that resolves.

See [`designs/platform-neutral-hash.md`](../../designs/platform-neutral-hash.md).

## API

### `sha256(bytes) -> Uint8Array`

The raw 32-byte digest of `bytes`.

### `sha256Into(out, bytes, offset = 0) -> number`

Writes the same 32 bytes into `out` starting at `offset`, and returns 32. A
convenience for callers that already own a destination; it is not faster than
`sha256`.

Both:

- **Bytes in, bytes out.** Input and output are `Uint8Array`, never a Node
  `Buffer` and never a string. Hash text by encoding it first
  (`@endo/bytes`' `bytesFromText`).
- **Raw digest, not hex or base64.** Encoding is the caller's choice, via
  `@endo/hex` or `@endo/base64`. Keeping the primitive in raw bytes avoids
  baking an encoding in and keeps the XS path to one host round trip.
- **Synchronous.** The only in-graph consumer, `makeBlobRefExo`, content
  addresses inside a synchronous exo factory, so WebCrypto's asynchronous
  `crypto.subtle.digest` cannot back this API.
- **Errors, not coercion.** A non-`Uint8Array` argument throws `TypeError`; an
  `out` with fewer than 32 bytes left at `offset` throws `RangeError`.
- **No streaming.** The streaming shape is already served by the injected
  `CryptoPowers.makeSha256`. If a future *static-import* site needs streaming,
  add it here then.

## Conditions

| condition | implementation | backing |
| --- | --- | --- |
| `node` | `src/sha256-node.js` | `node:crypto` `createHash('sha256')` |
| `xs` | `src/sha256-endor.js` | Endor's `hostSha256Bytes` contract |
| `browser`, `default` | `src/sha256-browser.js` | pure-JS synchronous SHA-256 |

`default` maps to the pure-JS build so that a browser bundler setting none of
the three still gets a working digest.

The Endor build is named for its platform contract rather than either engine
that can execute it. Endor/XS and Endor/IronHorse provide the binary-safe,
one-shot `hostSha256Bytes` global before application modules evaluate. There
is no fallback: selecting this build outside Endor is a configuration error.
Every digest from the host is copied and length-checked before it is returned;
a wrong-sized digest would otherwise become a wrong content address.
