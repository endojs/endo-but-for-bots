# @endo/sha256

Platform-neutral one-shot SHA-256 hash over binary buffers.

## API

```ts
function sha256(bytes: Uint8Array): Uint8Array; // 32-byte raw digest
function sha256Into(out: Uint8Array, bytes: Uint8Array, offset?: number): number; // returns 32
```

Both functions are synchronous. Input and output are always `Uint8Array` — never
strings or Node `Buffer`. Callers that hash text should encode it first via
`@endo/bytes` (`bytesFromText`).

## Platform resolution

The package uses conditional exports:

| Condition    | Entry point              | Runtime       |
| ------------ | ------------------------ | ------------- |
| `"browser"`  | `sha256-browser.js`      | pure-JS sync  |
| `"node"`     | `sha256-node.js`         | `node:crypto` |
| `"xs"`       | `sha256-xs.js`           | host functions|
| *default*    | `sha256-node.js`         | Node          |

The bundler honors `"browser"` and `"xs"` conditions for the target platform;
Node uses `"node"`.

## License

Apache-2.0
