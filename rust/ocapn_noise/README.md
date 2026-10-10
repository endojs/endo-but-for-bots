# OCapN Noise

This package provides cryptographic support for an [OCapN](https://ocapn.org/)
netlayer that uses [Noise Protocol](https://noiseprotocol.org/),
suitable for use on the web and in Node.js, anywhere WebAssembly can be
brought to bear.

This is a binding of the Rust `noise-protocol` and `noise-rust-crypto`
crates for the **`Noise_IK_25519_ChaChaPoly_BLAKE2s`** pattern.  The
OCapN identity is a single Ed25519 keypair; the X25519 keypair Noise
needs is derived deterministically from the same Ed25519 seed via the
Edwards→Montgomery birational map (the libsodium / age /
wireguard-tools convention), so peers publish only their Ed25519
verifying key.

An instance of the resulting WebAssembly module is small and suitable
for performing IK handshakes in the role of either initiator or
responder and the subsequent encryption/decryption of session
messages, and performs no heap allocations on the Rust side of the FFI
boundary.

## Technical details

- **Noise IK pattern**: 2-message handshake.  Initiator already knows
  the responder's static (its Ed25519 identity, converted to X25519);
  responder learns the initiator's static through the encrypted msg 1.
  Identity hiding (Noise §7.8 property 4): the initiator's static is
  encrypted on the wire under the responder's static, without forward
  secrecy.
- **X25519**: Diffie-Hellman, derived from each peer's Ed25519 seed.
- **ChaCha20-Poly1305**: AEAD for the handshake payloads and all
  session messages.
- **BLAKE2s**: hash and HKDF-like derivation inside Noise.
- **Ed25519**: long-term identity.  No per-message signature inside
  the handshake; the post-handshake `op:start-session` location
  signature carries the Noise transcript hash as a channel-binding
  value so it cannot be replayed across sessions.

### Prologue

Both peers feed the same prologue bytes into Noise's symmetric state
before any wire message is exchanged:

```
prologue = b"OCapN/np/1\0" || INTENDED_RESPONDER_KEY (32B Ed25519)
```

The prologue commits the handshake to the OCapN protocol identifier
plus the responder's published Ed25519 verifying key, so an attacker
cannot replay a handshake payload across protocols or against a
different responder, and a successful handshake binds the channel to
the responder identity the initiator dialed.

This package does not use a JavaScript binding abstraction.  The Rust
machine has some `static mut` state and communicates exclusively with
pointers/offsets into its linear memory; the parent JavaScript process
copies data in and out of the Memory's underlying `ArrayBuffer`.

The JavaScript bindings and demo are in `@endo/ocapn-noise`.

## Building and verifying

With a Rust toolchain installed, running `bash build.sh` (or
`yarn build:wasm` from the repo root) rebuilds the WASM module and
copies it into `packages/ocapn-noise/gen/ocapn-noise.wasm`.

The artifact is committed to git so JavaScript-only contributors can
run the test suite without a Rust toolchain.  **Anyone modifying
anything under `rust/ocapn_noise/` MUST rebuild and commit the
artifact** along with their changes:

```
bash rust/ocapn_noise/build.sh
git add packages/ocapn-noise/gen/ocapn-noise.wasm
```

The pinned channel in `rust-toolchain.toml` and the deps fixed by
the workspace `Cargo.lock` together ensure that a fresh `bash
build.sh` produces bit-identical bytes across contributors.
Because `rust/ocapn_noise` is a member of the top-level Rust workspace
(`../../Cargo.toml`), the only lockfile cargo consults is the
workspace-root `../../Cargo.lock`; an inner-member `Cargo.lock`
would be silently ignored, so this crate intentionally has none.
**If a workspace-wide `cargo update` lands for an unrelated member
(e.g. `rust/endo`), the wasm here MUST be regenerated and recommitted**
in the same change, or `build-wasm` will go red on every PR until
someone does it.
CI's `build-wasm` job rebuilds from source and runs
`git diff --exit-code packages/ocapn-noise/gen/ocapn-noise.wasm`,
catching drift between Rust source and the committed binary.
The build is pinned with `--locked` so a stale or hand-edited lockfile
fails loudly rather than silently embedding fresh dep versions.
Cargo caches survive across runs via `actions/cache` keyed on
`Cargo.lock` plus the Rust source tree, so a clean rebuild is only
paid when the inputs change.

## Why IK

IK is a 2-message pattern in which the initiator already knows the
responder's static — exactly OCapN's dial-by-identity model — and
gives initiator identity hiding (Noise §7.8 property 4): the
initiator's static is encrypted in msg 1 under the responder's
static.  The responder's identity is fixed at handshake start, so the
prologue can bind to the responder's published Ed25519 verifying key
plus a fixed protocol identifier without a chicken/egg problem.

No per-message Ed25519 signatures appear inside the handshake.  The
static X25519 is deterministically derived from the Ed25519 seed, so
a successful Noise DH against the published Ed25519 identity already
proves control of the corresponding signing key.
The initiator's Ed25519 verifying key, however, arrives as a claim in
the encrypted SYN payload, and Noise authenticates only the static
X25519 key the initiator used.
`responder_read_syn` therefore rejects the SYN (error code 5) unless
the claimed verifying key is a valid point with no small-order
component whose Montgomery form equals that static; otherwise an
initiator holding any keypair could present itself as any identity.
The torsion check matters because X25519 clamping erases a small-order
component, so without it the holder of A could also claim A + T for
each torsion point T.
The conversion drops the sign of x, so the holder of A can still claim
-A, a second identity for the same key holder.
`derive_remote_static_pubkey` applies the same valid/strong check to the
responder static the initiator dials (error code 3): a weak responder
key zeroes the `es`/`ss` DH results, forfeiting identity hiding and
letting a keyless party complete the handshake.
IK message 1 carries no freshness (Noise §7.7 destination property 2),
so a captured SYN passes this check again when replayed.
This check binds the claimed identity to the handshake; it does not make
message 1 fresh.
The JavaScript netlayer (`@endo/ocapn-noise`) is what keeps a replay
from closing the named peer's session: it defers displacing that session
until the post-handshake `op:start-session` proves the peer is live, and
bounds the pre-liveness work with a per-local-identity handshake cap.
