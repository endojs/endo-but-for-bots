# @endo/hex

`@endo/hex` encodes and decodes between `Uint8Array` and hexadecimal
strings.
It is a ponyfill for the TC39 `Uint8Array.prototype.toHex` and
`Uint8Array.fromHex` intrinsics (proposal-arraybuffer-base64, Stage 4).

On engines that ship the native intrinsics, `encodeHex` and `decodeHex`
dispatch to them at module load time.
On older engines, and in SES-locked-down compartments where a realm
has removed the intrinsics, the package falls through to a portable
pure-JavaScript implementation.

```js
import { encodeHex, decodeHex } from '@endo/hex';

encodeHex(new Uint8Array([0xde, 0xad, 0xbe, 0xef])); // 'deadbeef'
decodeHex('deadbeef'); // Uint8Array(4) [0xde, 0xad, 0xbe, 0xef]
```

## API

### `encodeHex(bytes, options?) -> string`

Encodes a `Uint8Array` as a hex string.
The default output is lowercase; pass `{ uppercase: true }` to force
uppercase.
The native `Uint8Array.prototype.toHex` intrinsic only produces
lowercase, so uppercase requests fall through to the pure-JavaScript
path unconditionally.

### `decodeHex(string, name?) -> Uint8Array`

Decodes a hex string to a `Uint8Array`.
Accepts both upper- and lowercase input.
Throws on odd-length strings and on characters outside `[0-9a-fA-F]`.
The optional `name` parameter is included in error messages for
diagnostic context.

## Design

See `designs/hex-package.md` in the endo repository for the audit,
migration plan, and design decisions.

## Hardened JavaScript

The native intrinsic reference is captured once at module load, before
any caller can reach the exported functions and before SES lockdown
freezes `Uint8Array`.
Post-lockdown mutation of `Uint8Array` cannot redirect the dispatched
bindings.
