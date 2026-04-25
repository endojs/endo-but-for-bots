# Change Log

## 0.1.0 (unreleased)

- Initial release.
  Provides `encodeHex` and `decodeHex` as a ponyfill for the TC39
  `Uint8Array.prototype.toHex` and `Uint8Array.fromHex` intrinsics.
  Dispatches to the native intrinsics at module load when available,
  falling through to a portable pure-JavaScript implementation.
