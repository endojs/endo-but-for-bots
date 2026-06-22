# `@endo/utf8`

`@endo/utf8` transcodes between JavaScript strings and UTF-8
`Uint8Array` values using the web `TextEncoder` and `TextDecoder` APIs.

The package mirrors the shape of `@endo/hex` and `@endo/base64`:
three focused sub-path exports, each capturing its platform object once
at module load before SES lockdown freezes the globals.

## Install

```sh
npm install @endo/utf8
```

## Usage

```js
import { encodeUtf8 } from '@endo/utf8/encode.js';
import { decodeUtf8 } from '@endo/utf8/decode.js';
import { strictDecodeUtf8 } from '@endo/utf8/strict-decode.js';

encodeUtf8('hello'); // Uint8Array [104, 101, 108, 108, 111]
decodeUtf8(new Uint8Array([104, 101, 108, 108, 111])); // 'hello'
strictDecodeUtf8(new Uint8Array([0xc3, 0x28])); // throws TypeError
```

## API

### `encodeUtf8(s) -> Uint8Array`

Encodes a string as UTF-8 bytes.

### `decodeUtf8(input) -> string`

Decodes UTF-8 bytes to a string, substituting U+FFFD for any malformed
sequences.

Accepts a frozen `Uint8Array` backed by an immutable `ArrayBuffer`
(the byteArray passable form), any other `ArrayBufferView`, or a bare
`ArrayBufferLike`.

### `strictDecodeUtf8(input) -> string`

Decodes UTF-8 bytes to a string.
Throws a `TypeError` on any malformed UTF-8 sequence rather than
substituting U+FFFD.

Accepts the same input forms as `decodeUtf8`.

## Hardened JavaScript

`TextEncoder` and `TextDecoder` are captured once at module load, before
SES lockdown freezes the globals.
Post-lockdown mutation of the globals cannot redirect the dispatched
calls.
All exports are hardened.
