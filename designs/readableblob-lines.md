# ReadableBlob Lines Stream

| | |
|---|---|
| **Created** | 2026-07-22 |
| **Updated** | 2026-08-29 |
| **Author** | kriscendobot (prompted) |
| **Status** | Proposed |

## Problem

`ReadableBlob.text()` materializes a whole file. Callers that process a log,
source file, or other text record-by-record instead need a reader that is
CapTP-safe (a remotable that marshals across a capability boundary, not a raw
async iterator) and flow-controlled (the consumer paces the producer through the
exo-stream `buffer`, so the source is not read ahead of demand). Splitting a
materialized string is both needlessly large and ambiguous at CR, LF, CRLF, and
a final unterminated line.

## Design

Add this method directly to `readableBlobMethodGuards`, the single shared
interface-guard object (owned by
[fs-interface-consolidation.md](fs-interface-consolidation.md)) that every
`ReadableBlob`-derived exo spreads, so defining it once propagates it to every
exo that spreads that record:

```ts
lines(options?: {
  start?: number;
  end?: number;
  buffer?: number;
}): PassableReader<string, undefined>
```

`lines` returns an exo stream made with `readerFromIterator`. The caller
consumes it with `iterateReader(E(blob).lines(options))`. All options are
optional. `start` and `end` select the half-open line range `[start, end)`. Line
indices are non-negative, zero-based, end-exclusive JavaScript `number`s. An
omitted `start` defaults to `0` (the first line); an omitted `end` selects
through the last line.

This is the first line-addressing method on the shared base guard
`readableBlobMethodGuards`, so it establishes that convention on the base guard
rather than reusing one already adopted there. The existing
`rangeReadText(startLine, endLine)` lives on the narrower
`rangeReadConvenienceMethodGuards`, which today only `LocalBlob` implements, and
its `textRange(startLine, endLine)` successor in
[readableblob-range-attenuation.md](readableblob-range-attenuation.md) is still
`Status: Proposed`. `lines` deliberately adopts the same value semantics those
narrower methods define (non-negative, zero-based, end-exclusive line indices),
so a caller who later learns `rangeReadText` or `textRange` reads a `lines` bound
the same way. The call shape differs, though: `rangeReadText` and `textRange`
take the range positionally, while `lines` carries it in an options bag, so the
shared meaning ports between them but the argument spelling does not. The bag
properties are named `start` and `end` rather than `startLine`/`endLine` because
the method name `lines` already supplies the line context.

A negative, fractional, or non-safe bound rejects with `EINVAL` before opening
the source (via the shared `toSafeNumber`), so the same input class throws
rather than being silently reinterpreted. An inverted range (`start > end`) also
rejects with `EINVAL`, matching `textRange`, which rejects an inverted interval
the same way; the shared convention therefore agrees on the error as well as on
the valid-range meaning. An `end` past the last line clamps to the end, and an
empty range (`start === end`) yields nothing, so an in-bounds empty window is
defined without an error. For five lines, for example, `{ start: 1, end: 3 }` selects lines 1 and 2;
`{ start: 2 }` selects lines 2, 3, and 4; `{ end: 2 }` selects lines 0 and 1; and
`{ start: 4, end: 9 }` selects only line 4 (the `end` clamps).

`buffer` has the same meaning as the `@endo/exo-stream` `buffer` option: it is
the number of selected line values pre-pulled before the producer waits for
further synchronization. It is not a byte length, source-read chunk size, or
permission to read past the selected `end`. It defaults to
`0`, so the default is pull-based. There is no clearly better fixed default.

The guard admits an omitted options bag with optional `start`, `end`, and
`buffer` properties and returns a `PassableReader` remotable. Supplied bounds
must be non-negative safe integers, and a supplied `buffer` must be a
non-negative safe integer. Invalid options reject with `EINVAL` before opening
the source. The implementation passes `readPattern: M.string()` to
`readerFromIterator`, so the advertised string item type is checked at the
exo-stream boundary as well as in TypeScript.

Because every range is non-negative and end-exclusive, `lines` preserves
ordinary forward streaming with no whole-source materialization: the adapter
skips through `start` and closes the source immediately after yielding the last
line before `end`. It never reads to EOF before emitting a first item, so both
the common "process a file line by line from the top" case and any bounded window
stream incrementally. The amount retained is governed only by the source chunk,
an unfinished line straddling chunks, and the exo-stream buffer, not by the
requested range.

Each yielded item is one decoded line, including its original terminator. The
scanner recognizes the byte terminators before UTF-8 decoding, while a
streaming `TextDecoder` preserves multi-byte characters split across source
chunks. The scanner must hold a trailing CR until it can distinguish CRLF from
lone CR. This preserves both line boundaries and the original terminator without
normalizing the text.

| Input bytes, shown as text | `lines()` values |
|---|---|
| `a\nb\n` | `['a\\n', 'b\\n']` |
| `a\rb\r` | `['a\\r', 'b\\r']` |
| `a\r\nb\r\n` | `['a\\r\\n', 'b\\r\\n']` |
| `a\r\nb\rc` | `['a\\r\\n', 'b\\r', 'c']` |
| `` (empty) | `[]` |

The final nonempty suffix is yielded once with the empty terminator. A blob
that ends in CR, LF, or CRLF has no additional empty line. A CRLF split across
source chunks remains one line terminator. Invalid UTF-8 follows the existing
non-fatal `text()` decoding behavior; this method does not create a stricter
text codec.

The returned reader is one-use, like the existing byte readers. It has the
normal reader cancellation behavior: an early consumer `return()` closes the
underlying byte reader or file handle. `lines()` does not change blob identity,
range authority, or the behavior of `text`, `json`, and `streamBase64`.

Once `textRange` lands, three line-range methods will share one addressing
convention on this interface, differing only in return shape:
`rangeReadText(startLine, endLine)` returns the window as a single joined string,
`textRange(startLine, endLine)` returns a new `ReadableBlob` bounded to that
window (a re-addressable capability), and `lines()` streams the window as
individual line values with their original terminators. Today only
`rangeReadText` exists, and only on `LocalBlob`, so the composition below is
forward-looking. Because the value semantics are identical, a caller will be able
to compose them freely, for example `E(blob).textRange(a, b)` then `.lines()` on
the result, reaching for `lines` when it wants flow control and per-line values
rather than a materialized string or a sub-blob.

## Implementations and migration

The shared guard is intentionally widened in one change. Compatibility
migrations and a temporary richer interface are unnecessary at this stage.
Update the matching TypeScript declarations and every exo that currently
spreads the shared readable-blob methods:

| Area | Implementations and work |
|---|---|
| Platform base and snapshots | `blobFromBytes` in `packages/platform/src/blob.js` and `snapshotBlobMethods` in `packages/platform/src/fs/snapshot-blob.js`; the former also supplies unzip leaves. |
| Platform local | `makeLocalBlob` in `packages/platform/src/fs-node/local-blob.js`; read incrementally rather than `readFile`ing the full text. |
| Platform extended | Add `lines` to `BlobRefInterface` in `packages/platform/src/fs/extended/type-guards.js` and implement it in `makeBlobRefExo` in `packages/platform/src/fs/extended/shared/blob-ref.js`, alongside its existing `getInfo`, `fetch`, `text`, and `json` methods. `BlobRef` keeps hand-declaring its guard rather than spreading the shared record, so it gains `lines` without gaining `streamBase64` (fs-interface-consolidation.md § C4 keeps `streamBase64` daemon-only because the extended layer streams via `fetch` / `PassableBytesReader`). |
| Daemon CAS and transient | `makeReadableBlob` and `makeBytesBlob` in `packages/daemon/src/manager.js`. |
| Daemon mount | `makeMountFileExo` and `makeReadableBlobView` in `packages/daemon/src/mount.js`; preserve confinement and re-check revocation while reading. |
| Git | `makeGitBlob` in `packages/git/src/native-git-backend.js`, using its existing byte iterator. |
| Browser bridge | `makeBrowserBlob` in `packages/spaces-util/src/browser-tree.js`, reading incrementally from the browser file stream. |
| Public surfaces | `packages/platform/src/fs/interfaces.js`, `types.ts`, and extended declarations; daemon interfaces/types/help; `packages/exo-git/src/types.ts`; and generated agent-tool declarations. |

This keeps `BlobRef` coherent with the shared read model on the whole-value and
line surfaces (`text`, `json`, `lines`) while preserving its one deliberate
difference: `streamBase64` stays daemon-only per
[fs-interface-consolidation.md](fs-interface-consolidation.md) § C4, because the
extended layer streams via `fetch` and `PassableBytesReader` rather than the
CapTP base64 pump. The extended TypeScript declaration must express the same
relationship.

Implement the byte-to-line adapter once in `@endo/platform` and reuse it from
each producer where the byte iterator is available. Each implementation still
owns opening and closing its backing reader, liveness checks, and error
propagation. Do not implement `lines` by delegating to `text()`.

## Verification plan

Add shared adapter tests and per-surface conformance tests. Cover CR, LF,
CRLF, an empty blob, a final unterminated line, a final terminated line, and
every terminator split over source chunks. Include multi-byte UTF-8 split
across chunks and an overlong line. Exercise omitted options and fields;
half-open positive ranges; an omitted `start` or `end`; reversed and empty
ranges; bounds at and beyond the available line indices (clamping `end`); and
negative, fractional, and non-safe bounds rejecting with `EINVAL`. Include
`buffer` values `0` and greater than the selected line count, invalid buffer
values, early iterator return, early source closure at `end`, and propagated
source errors. The mount cases must also verify revocation mid-stream.

The daemon mount conformance test should assert that `lines` is in the exact
`ReadableBlob` method set. Test the platform base/local/snapshot, extended
`BlobRef`, daemon stored and transient, mount read-only view, Git, unzip, and
browser-bridge paths so a later implementation cannot satisfy the guard while
omitting a producer.

## Dependencies

| Design | Relationship |
|---|---|
| [fs-interface-consolidation.md](fs-interface-consolidation.md) | Owns the shared readable-blob guard whose deliberate widening makes this method universal. |
| [platform-range-and-tree-reads.md](platform-range-and-tree-reads.md) | Establishes the layered readable-blob interfaces and the conformance boundary this change extends. |
| [readableblob-range-attenuation.md](readableblob-range-attenuation.md) | Companion design (Status: Proposed); `lines` shares its zero-based, end-exclusive, non-negative line-addressing convention, so ranges and lines compose by applying `lines` to the receiver's bytes. |

## Follow-up

A separate design will consider a CoDel-inspired (Controlled Delay) control algorithm that can
implicitly adjust reader pace and buffer size. Such an API still needs an
explicit alpha parameter so callers can select relative aggressiveness. This
proposal keeps the fixed `buffer = 0` default until that broader reader-level
design establishes a replacement.

## Prompt

> Please design a `lines()` method addition to all implementations of the
> readable blob interface. It produces an exo stream of strings, one line per
> item, including the line terminator: `"\\r"`, `"\\n"`, `"\\r\\n"`, or an
> empty terminator for a final unterminated line. The method takes a buffer
> length following the exo-stream method convention. Source: [PR #826 review](https://github.com/endojs/endo-but-for-bots/pull/826#pullrequestreview-4757241489).
