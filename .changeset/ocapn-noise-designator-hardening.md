---
'@endo/ocapn-noise': patch
---

Harden how the initiator validates a peer designator before dialling.

`provideSession` now requires the `np` locator's designator to be canonical
lowercase hex (`/^[0-9a-f]{64}$/`). Previously it checked only the length, and
`hexToBytes` maps any non-hex character to a zero byte, so `'z'.repeat(64)`
was accepted as 32 zero bytes — a small-order key. The raw designator string
also keys the `active`, `inProgress`, and `waiters` maps, so an uppercase
spelling of a peer already held would open a second, duplicate session (or
tear down the first); rejecting non-canonical designators closes that too.

The Rust `derive_remote_static_pubkey` now rejects a weak responder static —
a small-order or torsion-carrying Ed25519 key — returning error code 3 from
`initiator_write_syn`. A weak responder static makes the `es`/`ss`
Diffie-Hellman results all zeros (`noise-rust-crypto`'s X25519 does not reject
a zero output), which destroys the initiator's identity hiding and lets a
party holding no keys complete the handshake and pass a forged location
signature. This mirrors the responder-side key check.

The Noise handshake FFI also copies each wire message out of the shared
`static mut` buffer before `read_message`/`write_message` rather than passing
two slices of the same buffer, removing overlapping shared/exclusive borrows.
The emitted bytes are unchanged; the committed wasm is rebuilt and remains
bit-reproducible.

No wire-format change.
