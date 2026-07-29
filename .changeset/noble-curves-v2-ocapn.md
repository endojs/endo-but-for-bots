---
'@endo/ocapn': patch
---

Update `@noble/curves` to v2. OCapN Ed25519 verification now follows the
current ZIP-215 wire-encoding rules; deployments that exchange non-canonical
encodings must upgrade both peers together.
