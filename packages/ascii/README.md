# `@endo/ascii`

`@endo/ascii` transcodes between JavaScript strings and ASCII
`Uint8Array` values using plain charCode arithmetic.

`TextEncoder` and `TextDecoder` do not support an `"ascii"` encoding
label; this package provides encode/decode utilities for the ASCII
subset using the same subpath-export shape as `@endo/utf8`.

## Install

```sh
npm install @endo/ascii
```

## Usage

```js
import { encodeAscii } from '@endo/ascii/encode.js';
import { decodeAscii } from '@endo/ascii/decode.js';

encodeAscii('hello'); // Uint8Array [104, 101, 108, 108, 111]
decodeAscii(new Uint8Array([104, 101, 108, 108, 111])); // 'hello'
```

## API

### `encodeAscii(s) -> Uint8Array`

Encodes a string as ASCII bytes (one byte per character).
Throws a `RangeError` if any character code exceeds 127.

### `decodeAscii(bytes) -> string`

Decodes ASCII bytes to a string.
Bytes outside the ASCII range (0-127) are passed through without error.
Use `encodeAscii` on the source string to ensure only valid ASCII bytes
enter the pipeline.

## Hardened JavaScript

All exports are hardened.
