# `@endo/ascii`

`@endo/ascii` transcodes between JavaScript strings and ASCII
`Uint8Array` values using plain charCode arithmetic.

`TextEncoder` and `TextDecoder` do not support an `"ascii"` encoding
label; this package provides the same encode/decode/strict-decode shape
as `@endo/utf8` for the ASCII subset.

## Install

```sh
npm install @endo/ascii
```

## Usage

```js
import { encodeAscii } from '@endo/ascii/encode.js';
import { decodeAscii } from '@endo/ascii/decode.js';
import { strictDecodeAscii } from '@endo/ascii/strict-decode.js';

encodeAscii('hello'); // Uint8Array [104, 101, 108, 108, 111]
decodeAscii(new Uint8Array([104, 101, 108, 108, 111])); // 'hello'
strictDecodeAscii(new Uint8Array([0x80])); // throws RangeError
```

## API

### `encodeAscii(s) -> Uint8Array`

Encodes a string as ASCII bytes (one byte per character).
Throws a `RangeError` if any character code exceeds 127.

### `decodeAscii(bytes) -> string`

Decodes ASCII bytes to a string.
Bytes outside the ASCII range (0-127) are passed through without error.
Use `strictDecodeAscii` to reject them.

### `strictDecodeAscii(bytes) -> string`

Decodes ASCII bytes to a string.
Throws a `RangeError` if any byte value exceeds 127 (out of the ASCII range 0-127).

## Hardened JavaScript

All exports are hardened.
