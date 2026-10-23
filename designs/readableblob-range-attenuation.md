# ReadableBlob Range Attenuation

| | |
|---|---|
| **Created** | 2026-07-22 |
| **Updated** | 2026-10-23 |
| **Author** | kriscendobot (prompted) |
| **Status** | **Complete** |

## Status

[PR #1301](https://github.com/endojs/endo-but-for-bots/pull/1301), merged
2026-09-20, delivered the clean replacement described here across platform,
daemon, mount, and Git blob implementations. The old `getInfo()` / `fetch()`
and `rangeRead*` methods are absent from the public blob guards. The shipped
surface is `sha256()` / `size()` / `bytes()` plus `byteRange()` /
`textRange()`, assembled as `ReadableBlobRangeInterface`.

## Problem

`ReadableBlob.fetch(offset, length)` was a byte-window read, not a network
operation. Its name hid both its unit and its capability meaning. It returned a
one-use bytes reader, so a caller could not pass the selected part of a blob on
as the same read capability.

The replacement is an attenuation. `byteRange` and `textRange` return a new,
ephemeral `ReadableBlob` with exactly the authority to read the selected
portion. The returned value has the same interface, so ranges compose and can
be handed to code that already accepts a readable blob.

## Current surface and terminology

The public range surface is not confined to the daemon. The shared platform
guards in
[`packages/platform/src/fs/interfaces.js`](../packages/platform/src/fs/interfaces.js)
separate whole-selection reads (`rangeReadMethodGuards`: `sha256()`, `size()`,
and `bytes()`) from authority attenuation (`rangeAttenuationMethodGuards`:
`byteRange()` and `textRange()`). `ReadableBlobRangeInterface` combines both
records with the base readable-blob surface.

The daemon's `BlobInterface` in
[`packages/daemon/src/interfaces.js`](../packages/daemon/src/interfaces.js)
uses that guard. Its persisted `makeReadableBlob` and transient `makeBytesBlob`
implementations are in
[`packages/daemon/src/manager.js`](../packages/daemon/src/manager.js). The
live `EndoMountFile` and its `readOnly()` view implement it in
[`packages/daemon/src/mount.js`](../packages/daemon/src/mount.js). The same
shape is also implemented by platform `LocalBlob`
([`packages/platform/src/fs-node/local-blob.js`](../packages/platform/src/fs-node/local-blob.js)),
extended `BlobRef`
([`packages/platform/src/fs/extended/type-guards.js`](../packages/platform/src/fs/extended/type-guards.js)
and `shared/blobref.js`), and the Git blob in
[`packages/git/src/native-git-backend.js`](../packages/git/src/native-git-backend.js).
`packages/exo-git/src/types.ts` aliases this rich type as its `ReadableBlob`.

There are no public `readRange*` or `rangeRead*` methods on blobs or on the
directory-like daemon exos.
`EndoDirectory`, `EndoGuest`, and `EndoHost` expose `readText` and
`maybeReadText`; trees expose `has`, `list`, and `lookup`. The similarly named
`ContentStoreBlob.readRange` is an internal safe-number backing seam, not a
CapTP method. Range selection on a public blob uses `byteRange()` or
`textRange()` and then the ordinary blob read methods. The delivered design
therefore does not extend the internal directory or content-store convention.

## Shipped interface

Range attenuation is part of the one rich readable-blob surface. Every public
rich blob has the following methods in addition to its whole-value convenience
methods.

```ts
sha256(): Promise<string>
size(): Promise<bigint>
bytes(): Promise<PassableBytesReader>
byteRange(start: bigint, end: bigint): ReadableBlob
textRange(startLine: number, endLine: number): Promise<ReadableBlob>
```

An eventual send to either method naturally resolves to the returned remote
capability. The runtime guard for `byteRange()` requires a returned
`ReadableBlob`, not `M.any()`, so the same-interface guarantee is enforced at
the CapTP boundary; `textRange()` returns a promise because it reads bytes to
find line boundaries.

### Byte ranges

`byteRange(start, end)` selects the half-open byte interval `[start, end)`, relative
to the receiver. Both values must be non-negative `bigint` values representable
by the backing implementation's safe-offset domain. `start > end`, a negative
value, or a non-safe value rejects with `EINVAL`; `start === end` returns an
empty readable blob. The endpoint convention intentionally differs from the
old `(offset, length)` signature: an end offset makes nested ranges and
adjacent ranges mechanically clear.

The selection clamps at the receiver's end. Thus `byteRange(100n, 200n)` on a
12-byte blob is a valid empty attenuation, and `byteRange(6n, 100n)` yields the
suffix. Constructing a byte range does not read or persist bytes. The returned
cap retains only its source cap plus the composed interval, so a range of a
range intersects the two intervals and can never regain authority outside the
parent interval.

Every ordinary read applies to the attenuated bytes. In particular, `text()`
and `json()` decode only those bytes, `streamBase64()` streams only those bytes,
`sha256()` reports the selected content's digest, and `size()` reports its length.
For an immutable source that is a stable content address for the selected
bytes. For the existing live mount-file face, it preserves the current live
semantics: each operation observes the source at that operation, subject to
the fixed interval; callers needing a stable selection first take a snapshot.
An empty range has size `0n` and the SHA-256 of empty bytes.

### Text ranges

`textRange(startLine, endLine)` selects lines `[startLine, endLine)`, relative
to the receiver's current bytes, and returns the corresponding byte-slice as a
`ReadableBlob`. The shipped model follows the former `rangeReadText`
addressing convention: line indices are non-negative integer JavaScript
`number`s, zero-based, and end-exclusive. A negative, fractional, or
non-safe index rejects with `EINVAL`; an inverted interval rejects with
`EINVAL`; an equal interval or a start at or beyond the end returns an empty
blob. An end after the last line clamps at the end.

Line boundaries are LF (`0x0a`). A CR before LF remains content, so CRLF is
preserved rather than normalized. A final LF creates the same terminal empty
line used by `rangeReadText`; selecting through that line preserves the final
LF. The replacement keeps the same line origin, endpoint, clamping, and
trailing-newline behavior as the retired method.
UTF-8 decoding is only performed by `text()` or `json()` and follows their
existing decoder behavior; finding LF byte boundaries neither normalizes nor
materializes unrelated bytes.

`textRange` is intentionally defined on the receiver, not on the original
blob. A text range of a byte range indexes the lines visible in that byte
range; a byte range of a text range indexes its selected bytes. This is the
useful attenuation law, even when a byte range begins or ends mid-line.

## Relationship to the retired `rangeRead*` surface

PR #1301 replaced `rangeRead(offset, length)` with `byteRange(start, end)` and
`rangeReadText(startLine, endLine)` with `textRange(startLine, endLine)`. The
result-type change is intentional: callers read the returned attenuated blob by
its normal methods rather than receiving a special materialized value. Neither
spelling was added to `Directory`,
`ReadableTree`, `EndoDirectory`, `EndoGuest`, or `EndoHost`; path selection
continues to happen with `lookup`, then range selection happens on the blob.

## Delivered rename and refactor

This was a semantic rename, not a mechanical `fetch` search-and-replace. The
old method's result was `PassableBytesReader`; the new method's result is a
same-interface capability. In particular, `fetch` cannot be an alias of
`byteRange`.

The migration covered the following range-specific definitions and callers.
The list excludes unrelated HTTP, Git-transport, and content-store methods also
named `fetch`:

| Area | Definitions and callers migrated |
|---|---|
| Shared lite contract | `packages/platform/src/fs/interfaces.js`, `types.d.ts`, `index.js`, and `packages/exo-git/src/types.ts` |
| Implementations | `packages/platform/src/fs-node/local-blob.js`; `packages/platform/src/fs/extended/shared/blobref.js`; `packages/daemon/src/manager.js` (`makeReadableBlob`, `makeBytesBlob`); `packages/daemon/src/mount.js` (`makeMountFileExo`, `makeReadableBlobView`); `packages/git/src/native-git-backend.js` |
| Extended guard and consumers | `packages/platform/src/fs/extended/type-guards.js`, `cas.js`, and `cached-fs.js` |
| Daemon guard, declarations, and help | `packages/daemon/src/interfaces.js`, `types.d.ts`, `help-text-data.js`, and `help.md` |
| Existing range tests | `packages/platform/test/{local-blob,blobref,node-fs,optimal-querying}.test.js`; `packages/daemon/test/{endo,mount,git}.test.js`; the mount conformance tests |
| Design and API prose | `designs/{fs-interface-consolidation,platform-range-and-tree-reads,agentry-git-eval-scenarios,endo-fs-from-git,fs-interface-reconciliation,registry-capability,snapshot-mapper}.md`, `designs/README.md`, and `packages/platform/src/fs/extended/DESIGN.md` |

1. A shared attenuation helper and tests cover byte composition, empty and
   EOF-clamped selections, revocation/liveness, `sha256()` and `size()` on
   selected content, and text-line selections. Every rich blob implementation
   above adopts it or the same interval-composition contract. Derived ranges
   receive no formula, name, or persistence entry.
2. `fetch`, `rangeRead`, and `rangeReadText` were replaced by `bytes`,
   `byteRange`, and `textRange` on every producer in one clean break. There are
   no deprecated aliases, compatibility window, or legacy-adapter package.
   Internal consumers use the new capability shape.
3. `ReadableBlobRangeInterface` is the one assembled rich surface, generated
   declarations and help text use it, and conformance tests assert that every
   derived capability exposes the same methods as its parent.

The test matrix includes nested byte ranges, byte-after-text and
text-after-byte ranges, terminal-LF behavior, CRLF preservation, invalid
arguments, `start === end`, EOF clamping, immutable snapshot stability, live
mount changes, and revocation.

## Resolved decisions

1. `textRange` keeps the zero-based, end-exclusive, LF-with-terminal-empty-line
   model, staying consistent with `rangeReadText` rather than adopting a
   divergent line/terminal-LF convention. The two spellings address lines
   identically.
2. No compatibility window and no versioned legacy-adapter package. Migration
   is not a concern, so the old methods are replaced outright rather than kept
   as deprecated aliases for a release.
3. Every current rich blob (`BlobRef`, LocalBlob, daemon stored and transient
   blobs, mount views, and Git blobs) adopts the new surface in the one clean
   release. There is no daemon-only-first phase and no temporary interface
   split.
4. Read methods are named by the {byte, text} x {all, range} cross product:
   `bytes` / `byteRange` / `text` / `textRange`. The whole-content byte reader
   `fetch` becomes `bytes`; the byte-range attenuator written `range` above
   becomes `byteRange`, symmetric with `textRange`. (Build review
   [#5252703859](https://github.com/endojs/endo-but-for-bots/pull/1301#pullrequestreview-5252703859),
   inline on `git-declarations.js`.)
5. Blob content metadata is exposed as one accessor method per hashing
   algorithm (`sha256()`, `sha512()`, and others) plus a separate `size()`
   method, rather than a bundled metadata accessor. A blob may offer several algorithms and favor one
   internally; the external surface migrates gradually — an added algorithm is a
   new method, never a reshaped return value. (Build review
   [#5252703859](https://github.com/endojs/endo-but-for-bots/pull/1301#pullrequestreview-5252703859),
   inline on `fs-declarations.js`.)
