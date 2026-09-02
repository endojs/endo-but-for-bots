---
'@endo/pass-style': major
'@endo/bytes': major
'@endo/utf8': minor
'@endo/patterns': patch
'@endo/marshal': patch
'@endo/ocapn': patch
'@endo/ocapn-noise': patch
---

Narrow the `byteArray` pass style to plain frozen `Uint8Array` only.

Add `@endo/utf8` with `encodeUtf8`, `decodeUtf8`, and `strictDecodeUtf8`, and
remove the superseded UTF-8 entry points from `@endo/bytes`.

The `byteArray` pass-style brand check previously accepted both raw
immutable `ArrayBuffer` values and plain frozen `Uint8Array` values
backed by an immutable `ArrayBuffer`. It now accepts only the latter
shape: a plain frozen `Uint8Array` whose backing buffer is a plain
frozen immutable `ArrayBuffer`. Raw immutable `ArrayBuffer` values
are no longer recognised as `byteArray`; the `ByteArray` TypeScript
alias is now `Uint8Array` (was `ArrayBuffer`).

The emulated-vs-genuine distinction the narrowed brand check draws — an
emulated `@endo/immutable-arraybuffer` wrapper versus a genuine
integer-indexed `Uint8Array` view — is committed to a single fidelity
loss, `ArrayBuffer.isView`: an emulated wrapper is a plain object and is
not a view, a genuine view (mutable or native-immutable) is. `@endo/pass-style`'s
`byteArray` brand check discriminates on `ArrayBuffer.isView` (a non-view
must carry zero own indexed properties, a genuine view exactly
`length`-many matching the buffer), which is strictly more precise than
accepting either count unconditionally. `@endo/bytes`'s `compareBytes`
likewise gates on `ArrayBuffer.isView`, indexing a genuine view in place
and copying only a non-view (emulated) wrapper or bare buffer. The
integer-indexed-read (`view[i] === undefined`) and `[Symbol.toStringTag]`
(`'[object Object]'`) behaviors of an emulated wrapper are incidental
consequences of its plain-object shape, not separately committed fidelity
losses.

`@endo/bytes`: the immutable-byte adapters — consolidated into
`frozenBytes` and `thawedBytes` and re-homed in
`@endo/immutable-arraybuffer` (see the consolidation changeset) — take
on the narrowed shape. `frozenBytes(view)` now wraps the immutable
`ArrayBuffer` produced by `sliceToImmutable` in a fresh frozen
`Uint8Array` before hardening; the return type is now `Uint8Array`
(was `ArrayBuffer`). `thawedBytes` accepts the new shape
(`ArrayBufferView`) in addition to the prior `ArrayBufferLike`.
`concatImmutables` returns a `Uint8Array` rather than an
`ArrayBuffer`, and accepts `Uint8Array` on input. `bytesEqual` now
gates on `ArrayBuffer.isView` like its `compareBytes` sibling: it
compares a genuine view in place and thaws a non-view (emulated) wrapper
or bare buffer into a mutable `Uint8Array` first. Previously it indexed
its arguments directly, so two distinct equal-length emulated byteArrays
read `undefined` at every position and compared equal, while an
emulated-vs-genuine pair compared unequal.

`@endo/marshal`: the byteArray rank-compare's `ArrayBuffer.prototype`
dispatch arm becomes dead code and is removed. Values arrive as a frozen
`Uint8Array` backed by an immutable `ArrayBuffer`. On the emulated
`@endo/immutable-arraybuffer` path such a wrapper has no integer-indexed
own properties, so the bytes are read by first copying each wrapper into
a genuine mutable `Uint8Array` (via `slice`, which the shim amplifies)
and then delegating the equal-length lexicographic comparison to
`@endo/bytes`'s `compareBytes`, deduplicating the byte-comparison loop.

`@endo/patterns`: the `byteArray` matcher's `TypeFromPattern` and
`getMatcherKind` types resolve to `Uint8Array` (was `ArrayBuffer`).

`@endo/ocapn`: the syrup `writeBytestring` types (and the crypto,
codec, client, cbor, and bytewise-compare byte params throughout the
package) narrow to `Uint8Array`; no function is typed to accept both a
buffer and a buffer view. Where a codec dispatcher still tolerates a raw
`ArrayBuffer` from an older peer, that buffer is normalized to a
`Uint8Array` at the boundary rather than propagated into the callee's
signature. The hub's `hexFromBytes`/`swissnumHex` helpers and
`attachSession`'s `powers.identity` handshake fields
(`sessionId`/`peerPublicKeyQ`/`selfPrivateKeyBytes`) narrow to `Uint8Array`
the same way: `hexFromBytes` gates on `ArrayBuffer.isView` (like
`@endo/bytes`' `toIndexableUint8`), reading a genuine view in place and
copying only an emulated `@endo/immutable-arraybuffer` wrapper — the shape a
`frozenBytes`/`makeSessionId` session id takes — so no handshake or
gift-handoff signature is typed to accept both a buffer and a buffer view.
The byteArray-shaped branded
client types (`SessionId`, `SwissNum`, `PublicKeyId`) change from
`ArrayBufferLike & {_brand}` to `Uint8Array & {_brand}`. Printable
swissnum strings are encoded with canonical `@endo/ascii` before immutable
wrapping. Decoder paths keep non-ASCII swissnums as bytes rather than
coercing them through the WHATWG `ascii` decoder. The CBOR
diagnostic-notation `equals`/`diagnosticEquals` helper's byte comparison
now gates on `ArrayBuffer.isView` as well, thawing an emulated wrapper
before indexing; previously (like the pre-fix `asUint8`) it trusted
`instanceof Uint8Array` and read `undefined` from an emulated wrapper, so
distinct equal-length byteArrays compared equal (latent — diagnostic
notation has no wire consumers).

`@endo/ocapn-noise`: adapt to the narrowed `byteArray`. Its `asUint8`
helper previously trusted `instanceof Uint8Array` and returned the value
as-is, which broke the peer-key comparison in the crossed-hellos
handshake on the emulated `@endo/immutable-arraybuffer` path: the
decoded public key arrives as a frozen `Uint8Array` wrapper with no
integer-indexed own properties, so `peerBytes[i]` read `undefined` and
every byte compared unequal. It now discriminates on `ArrayBuffer.isView`
(as `@endo/immutable-arraybuffer`'s `thawedBytes` does), copying an emulated
wrapper into a genuine mutable `Uint8Array`. The stale
`OcapnNoiseSession.sessionId` type is updated from `ArrayBufferLike` to
the now-`Uint8Array`-shaped `SessionId`.
