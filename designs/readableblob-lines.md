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
materialized string needlessly duplicates it, and is ambiguous at CR, LF, CRLF,
and a final unterminated line.

## Design

Add this method directly to `readableBlobMethodGuards`, the single shared
interface-guard object (owned by
[fs-interface-consolidation.md](fs-interface-consolidation.md)) that every
`ReadableBlob`-derived exo spreads. A *guard* here is the interface contract that
validates an exo's method calls at the CapTP boundary; defining `lines` once on the
shared record propagates it to every exo that spreads that record. The single
exception is `BlobRef`, which hand-declares its own guard rather than spreading the
shared record (§ Implementations and migration): it must be given `lines`
explicitly, and so is the one producer where "define once, propagate everywhere"
does not reach by identity. The method signature:

```ts
lines(options?: {
  startLine?: number;
  endLine?: number;
  buffer?: number;
}): PassableReader<string, undefined>
```

`lines` returns an exo stream made with `readerFromIterator`. The caller
consumes it with `iterateReader(E(blob).lines(options))`. All options are
optional. `startLine` and `endLine` select the half-open line range
`[startLine, endLine)`. Line indices are non-negative, zero-based, end-exclusive
JavaScript `number`s. An omitted `startLine` defaults to `0` (the first line); an
omitted `endLine` selects through the last line.

This is the first line-addressing method on the shared base guard
`readableBlobMethodGuards`, so it establishes a new addressing convention there.
The existing
`rangeReadText(startLine, endLine)` lives on the narrower
`rangeReadConvenienceMethodGuards`, which today only `LocalBlob` implements, and
its `textRange(startLine, endLine)` successor in
[readableblob-range-attenuation.md](readableblob-range-attenuation.md) is still
`Status: Proposed`. `lines` shares those methods' *range-index* convention: the
`startLine`/`endLine` bounds are non-negative, zero-based, end-exclusive
JavaScript `number`s; `endLine` clamps to the last line; and a negative,
fractional, non-safe, or inverted bound rejects with `EINVAL`. A caller therefore
reasons about which line index a bound names the same way across all three
methods. The bounds are carried positionally by `rangeReadText`/`textRange` and
in an options bag by `lines` (which also carries `buffer`); the bag keys are
spelled `startLine`/`endLine` to match the sibling vocabulary rather than
diverging on names for an identical index value.

`lines` is bare-named rather than prefixed `streamLines`, even though it returns a
stream like the guard's one existing stream-returning member, `streamBase64` (which
pumps the blob's bytes to the caller as a base64-encoded stream). It is unlike the
materializing `text`/`json` pair. The `streamBase64` prefix
disambiguates an *encoding*: it names which representation the base64 pump emits,
not merely that the method streams, so its prefix is not a general "this returns a
stream" convention on the guard that `lines` would violate. `lines` instead
carries the near-universal cross-ecosystem spelling for a per-line reader (Node's
`readline`, Python's `.readlines()`), which is the name a caller reaches for, and
the commissioning prompt fixes that spelling. The materialize-vs-stream signal a
caller needs is therefore carried by the return type
(`PassableReader<string, undefined>`, consumed via `iterateReader`, not `await`)
and, as noted where the terminator-retention callout is required below (§
Implementations and migration), by the per-surface `help()` text and TypeScript
doc-comments, which must state that `lines` returns a reader to be
iterated, not a materialized value.

Two consequences of the bare spelling are called out so they are not left to the
implementation. First, this repo's feature detection keys on method *names*, not on
the exo tag (`readableBlobMethodGuards`' own comment, and `AGENTS.md` § CapTP
introspection, which instructs a caller to enumerate `__getMethodNames__()` and
reason from the name). A caller listing this guard sees `text`, `json`, `lines`,
`streamBase64`, `getInfo`, `fetch`; by this repo's own naming pattern `text`,
`json`, and `lines` all read as materializing accessors, yet only `lines` is a
remotable driven with `iterateReader`. Because the bare name cannot itself carry
the "returns a stream" signal that name-based discovery relies on, the guard's own
shared doc-comment (not only per-producer `help()`/TSDoc) must carry the
"returns a reader to iterate, not a value" callout, so a maintainer reading the
full method set off the guard learns it at the first place they look. Second,
`lines` and `streamBase64` are the guard's only two stream-returning members but
use incompatible invocation protocols: `streamBase64(syncPromise)` is a
caller-driven pump that takes a synchronization promise and returns a raw promise
chain, whereas `lines(options)` returns a `PassableReader` the caller drives via
`iterateReader` (the newer `@endo/exo-stream` idiom used by `followNameChanges`
and the mount watcher). A caller who has learned to drive one cannot reuse that
pattern for the other. This design does not migrate `streamBase64`; whether it
should eventually converge on the `PassableReader` shape is left to the broader
reader-level design noted under Follow-up.

`lines` deliberately does **not** share those methods' *line-boundary* model,
and the divergence is intrinsic to its purpose, so the two surfaces are not
interchangeable line-for-line and this design makes no value-semantics-parity
claim. `rangeReadText` (`packages/platform/src/fs-node/local-blob.js`,
`split('\n')`) and the `textRange` design both split on LF alone (a lone CR is
content, not a boundary) and, following `String.prototype.split`, a final LF
yields a trailing empty line element. `lines` instead recognizes CR, LF, and
CRLF as three terminators (its commissioning prompt requires the terminator be
retained on each value) and yields no synthetic trailing empty line after a final
terminator. For `a\nb\n`, `rangeReadText`/`textRange` address three line slots
(`'a'`, `'b'`, `''`) while `lines` yields two (`'a\n'`, `'b\n'`); for any text
containing a lone CR the two also disagree on line count and contents. Because the
line models differ, line index `N` need not denote the same span across the
surfaces: `lines` is not a drop-in continuation of a `rangeReadText`/`textRange`
window's line numbering, and callers must not assume line-index parity between
them.

A unifying alternative was weighed on its merits before accepting the divergence,
independent of the commissioning prompt. The alternative is a single boundary
model behind a mode flag (for example `lines({ terminators: 'lf' | 'crlf-aware',
retain: boolean })`) letting one method reproduce `rangeReadText`/`textRange`'s
LF-only, terminator-stripped, trailing-empty-line slots *and* the CR/LF/CRLF,
terminator-retained, no-trailing-empty stream. It is rejected on three counts, not
merely because the prompt fixes the CR/LF/CRLF-retaining shape. First, it moves a
line-boundary decision from the design into every call site and every guard
predicate, so a reviewer or caller can no longer read the boundary model off the
method name; a mode flag that silently changes what a *line* is (not just which
lines are selected) is the "same name, divergent meaning" hazard the design already
works to avoid on `startLine`/`endLine`. Second, the two modes want different
return shapes (`rangeReadText` joins its LF slots into one string and `textRange`
returns a sub-blob, while `lines` streams individual terminator-bearing values), so
a single method spanning both would either force one mode into an unnatural return
type or fan out into the very family of methods the flag was meant to collapse.
Third, terminator retention is not an orthogonal toggle: retaining CR/LF/CRLF is
what lets `lines` stream without a normalization pass and lets a caller reassemble
the exact bytes, so pairing "retain" with the LF-split model yields a fourth,
un-asked-for semantics with no consumer. The three sibling methods therefore
deliberately share only the *range-index* convention and stay distinct on the
boundary model and return shape; the prompt fixes which of these already-preferred
shapes `lines` takes, it is not the sole reason for the divergence.

A negative, fractional, or non-safe bound rejects with `EINVAL` before opening
the source (via the shared `toSafeNumber`), so the same input class throws
rather than being silently reinterpreted. An inverted range (`startLine > endLine`)
also rejects with `EINVAL`, matching `textRange`, which rejects an inverted
interval the same way; the shared *index* convention therefore agrees on the
error as well as on how a bound selects an index (the surfaces still differ on the
line-boundary model that maps an index to bytes, per above). An `endLine` past the
last line clamps to the end, and an empty range (`startLine === endLine`) yields
nothing, so an in-bounds empty window is defined without an error. A `startLine`
at or past the total line count likewise yields nothing rather than erroring: the
skip-forward exhausts the source and the stream ends empty, the same result as an
in-bounds empty range. For five lines,
for example, `{ startLine: 1, endLine: 3 }` selects lines 1 and 2;
`{ startLine: 2 }` selects lines 2, 3, and 4; `{ endLine: 2 }` selects lines 0 and
1; `{ startLine: 4, endLine: 9 }` selects only line 4 (the `endLine` clamps); and
`{ startLine: 9 }` selects nothing (the `startLine` is past the last line).

`buffer` has the same meaning as the `@endo/exo-stream` `buffer` option: it is
the number of selected line values pre-pulled before the producer waits for
further synchronization. It is not a byte length, source-read chunk size, or
permission to read past the selected `endLine`. It defaults to
`0`, so the default is pull-based. There is no clearly better fixed default.

The guard admits an omitted options bag with optional `startLine`, `endLine`, and
`buffer` properties and returns a `PassableReader` remotable. Supplied bounds
must be non-negative safe integers, and a supplied `buffer` must be a
non-negative safe integer. Invalid options reject with `EINVAL` before opening
the source. The implementation passes `readPattern: M.string()` to
`readerFromIterator`, so the advertised string item type is checked at the
exo-stream boundary as well as in TypeScript.

Because every range is non-negative and end-exclusive, `lines` preserves
ordinary forward streaming with no whole-source materialization: the byte-to-line
adapter (the single shared component implemented in `@endo/platform`, detailed
under "Implementations and migration" below) skips the lines before `startLine`
and closes the source immediately after yielding the last line before `endLine`. It never reads to EOF before emitting a first item, so streaming is incremental
both for the common "process a file line by line from the top" case and for any
bounded window. The amount retained is governed only by the source chunk,
an unfinished line straddling chunks, and the exo-stream buffer, not by the
requested range.

The one bound this design does *not* impose is a per-line cap: because a value is
not yielded until the scanner finds its terminator (or EOF), a single overlong or
entirely unterminated line (a minified bundle, a binary file mistyped as text, or
a stalled writer that never emits a terminator) forces the adapter to accumulate
that whole line in memory before it can yield anything, which for a source that is
one unterminated line degrades to whole-source materialization. This is an
accepted, documented limitation, not an oversight: `lines` bounds memory per
*line*, not per byte, and offers no maximum-line-length option in this iteration.
A caller that must defend against adversarial or pathological line lengths should
range-attenuate the blob first (`textRange`, once landed) or use the byte reader
directly; a future maximum-line-length option is noted under Follow-up. The
verification plan's overlong-line case asserts the line is delivered whole rather
than truncated, pinning this behavior.

This "never materializes the source" property is the adapter's, and it is only as
incremental as the byte iterator a given producer hands it. Producers backed by a
genuinely incremental source get the full benefit: `LocalBlob`
(`fs.createReadStream`), the daemon mount view, git's streaming blob path, and the
browser bridge (`file.stream().getReader()`). Producers whose bytes are already
resident, `BlobRef` and `blobFromBytes` (both wrap an in-memory `Uint8Array`) and
git's whole-object `fetch`/`getInfo`/`text` paths, hand the adapter a buffer that
is already fully in memory; there the adapter still avoids building a second
materialized line array and still paces per line, but it cannot make the source
smaller than the producer already made it. The uniform guarantee is the adapter's,
not the source's.

Each yielded item is one decoded line, including its original terminator. Within
that same adapter, the terminator scanner recognizes the byte terminators before
UTF-8 decoding, while a streaming `TextDecoder` preserves multi-byte characters
split across source chunks. The scanner must hold a trailing CR until it can
distinguish CRLF from
lone CR. This preserves both line boundaries and the original terminator without
normalizing the text.

| Input bytes, shown as text | `lines()` values |
|---|---|
| `a\nb\n` | `['a\\n', 'b\\n']` |
| `a\rb\r` | `['a\\r', 'b\\r']` |
| `a\r\nb\r\n` | `['a\\r\\n', 'b\\r\\n']` |
| `a\r\nb\rc` | `['a\\r\\n', 'b\\r', 'c']` |
| `` (empty) | `[]` |

The final non-empty suffix is yielded once with the empty terminator. A blob
that ends in CR, LF, or CRLF has no additional empty line. A CRLF split across
source chunks remains one line terminator. Invalid UTF-8 follows the existing
non-fatal `text()` decoding behavior; this method does not create a stricter
text codec.

The returned reader is one-use, like the existing byte readers. It has the
normal reader cancellation behavior: an early consumer `return()` closes the
underlying byte reader or file handle. `lines()` does not change blob identity,
range authority, or the behavior of `text`, `json`, and `streamBase64`.

Two source-liveness contracts are stated here rather than deferred to the
verification plan, because both are capability-safety properties a conformance
test must assert against a defined outcome.

*Revocation mid-stream.* On the daemon mount view, the underlying byte reader
re-checks the mount's confinement/revocation on each read, exactly as `getInfo`
and `fetch` do. If the mount is revoked while a `lines()` stream is in flight, the
next pull that reaches the revoked source rejects: the reader yields already-buffered
lines that were pulled before revocation, and then the pending/next iteration
settles to a rejection carrying the same revocation error `fetch`/`getInfo` throw
on a revoked mount (an `EPERM`-class error marshalled across the CapTP boundary as
that error's passable form), not a silent stream end. The adapter does not swallow
the error into a clean `done`, so a caller cannot mistake revocation for
end-of-content.

*Growth mid-stream (live sources).* A mount file is a live, non-snapshot face:
its bytes can grow underneath the reader. `lines()` reads the source to *current*
EOF and ends the stream there; it does not wait for further appends the way a
directory watch does. A caller processing a growing log therefore drains the
lines available at the moment it started, sees `done`, and resumes by invoking
`lines({ startLine: <count already consumed> })` again. The zero-based
`startLine` skip makes resumption exact without re-reading consumed lines. `lines`
is deliberately a finite reader over the content present when it opens the source,
not a tail-follower; a follow-mode reader, if wanted, is separate future work
noted under Follow-up.

Once `textRange` lands, three line-range methods will share the same
range-*index* addressing on this interface while differing in both return shape
and line-boundary model: `rangeReadText(startLine, endLine)` returns an LF-split
window as a single joined string, `textRange(startLine, endLine)` returns a new
`ReadableBlob` bounded to that LF-split window (a re-addressable capability), and
`lines()` streams a terminator-aware window as individual line values with their
original CR/LF/CRLF terminators. Today only `rangeReadText` exists, and only on
`LocalBlob`, so this composition is forward-looking. `textRange` and `lines` can
be composed, but the composition is over *bytes*, not line indices:
`E(blob).textRange(a, b)` yields a sub-blob; `.lines()` can then re-scan its bytes
when a caller wants flow control and per-line values rather than a materialized
string or a sub-blob.
Because the two use different line-boundary models, the line numbering `lines()`
reports over that sub-blob is not the same as `textRange`'s own LF-based
`[a, b)` slots; a caller reaches for `lines` for incremental terminator-retaining
per-line values, not as a drop-in substitute for the other two methods' slot
addressing.

## Implementations and migration

The shared guard is intentionally widened in one change, and this design
deliberately departs from the narrow-guard containment that
[platform-range-and-tree-reads.md](platform-range-and-tree-reads.md) §
"Interface layering (blast radius)" adopted for `rangeRead`/`rangeReadText`/
`listTree`. That containment exists because those methods are *not universally
implementable*: range attenuation and recursive tree listing are `LocalBlob`/
`LocalTree` capabilities that the daemon, git, and mount exos cannot all cheaply
provide, so folding them into the shared record would force implementers to
supply a method they have no backing for. `lines` is the opposite case: every
producer can trivially satisfy the adapter's iterator shape (each row in the table
below names the byte source it hands the adapter), so every exo can implement
`lines` through the one shared byte-to-line adapter, and this design commits to
landing all implementations in the same change. That uniformity is at the adapter
*interface*, not at the source: `LocalBlob`, the mount view, git's streaming path,
and the browser bridge feed a genuinely incremental iterator, while `BlobRef`,
`blobFromBytes`, and git's whole-object `fetch`/`getInfo`/`text` paths hand the
adapter one fully-resident buffer (the degenerate single-chunk case, per the
"never materializes the source" paragraph above). Both classes satisfy the same
adapter contract; the wide-blast-radius move is safe because that contract is
universally implementable, not because every source is already incremental. Placing `lines` on a temporary narrow guard would therefore only
add a parallel interface to fold back into the shared record once the (already
enumerated) producers land, which is net churn for a method that is universal by
construction. The wide blast radius is accepted here precisely because the guard
and the behavior can stay coherent across all implementers at once; a producer
that cannot yet read incrementally is a reason to fix that producer, not to
narrow the guard. Compatibility migrations and a temporary richer interface are
unnecessary at this stage.

Widening the guard in one step and landing every implementation in one PR are
separable decisions, and the reviewability argument that the precedent
([platform-range-and-tree-reads.md](platform-range-and-tree-reads.md) §
"Interface layering (blast radius)") makes for staging a change applies to the
second decision, not the first. That precedent, and its sibling
[fs-interface-consolidation.md](fs-interface-consolidation.md) § "Follow-ups"
deferring the `getInfo` -> `contentAddress` rename "to keep this change
reviewable," stage work whose per-site edits carry *independent* meaning: a rename
touches each call site with a distinct name in a distinct context, so a reviewer
must read each site on its own terms and the review cost grows with the site
count. `lines` is deliberately the opposite: the semantics live once in the shared
byte-to-line adapter, and each producer's change is the same mechanical shape:
open the backing byte iterator this row already names and feed it to that adapter.
The review cost is therefore dominated by one adapter plus a single repeated
pattern a reviewer verifies once and then confirms per row, not by N independent
changes, so the reviewability axis the precedent weighs does not push this scope
toward staging the way a rename's did. Landing the producers together also keeps
the guard and its implementers coherent at every commit (no interval in which the
widened guard outruns a producer that cannot yet satisfy it), which is the
property the one-PR choice buys. Should the single PR nonetheless prove
unwieldy in review, the fallback is to land the adapter, the guard widening, and
the platform/local/base producers first, then stage the daemon, mount, git, and
browser producers as enumerated follow-ups, since the guard is universal by
construction and each staged producer is the same mechanical delegation.

Update the matching TypeScript declarations and every
exo that currently spreads the shared readable-blob methods:

| Area | Implementations and work |
|---|---|
| Platform base and snapshots | `blobFromBytes` in `packages/platform/src/blob.js` and `snapshotBlobMethods` in `packages/platform/src/fs/snapshot-blob.js`; the former also supplies unzip leaves. |
| Platform local | `makeLocalBlob` in `packages/platform/src/fs-node/local-blob.js`; read incrementally rather than `readFile`ing the full text. |
| Platform extended | Add `lines` to `BlobRefInterface` in `packages/platform/src/fs/extended/type-guards.js` and implement it in `makeBlobRefExo` in `packages/platform/src/fs/extended/shared/blob-ref.js`, alongside its existing `getInfo`, `fetch`, `text`, and `json` methods. `BlobRef` keeps hand-declaring its guard rather than spreading the shared record, so it gains `lines` without gaining `streamBase64` ([fs-interface-consolidation.md](fs-interface-consolidation.md) § C4 keeps `streamBase64` daemon-only because the extended layer streams via `fetch` / `PassableBytesReader`). |
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

The common cross-ecosystem "lines" idiom (Node's `readline`, Python's
`.readlines()` iteration, `String.split('\n')`) strips the terminator, but
`lines` keeps the original terminator on each value, so the per-surface `help()`
text and TypeScript doc-comments must carry the terminator-retention callout as
prominently as the table above, since `help()` is the discoverability path a
caller hits at the call site rather than this design doc.

## Verification plan

Add shared adapter tests and per-surface conformance tests. Cover CR, LF,
CRLF, an empty blob, a final unterminated line, a final terminated line, and
every terminator split over source chunks. Include multi-byte UTF-8 split
across chunks and an overlong line. Exercise omitted options and fields;
half-open positive ranges; an omitted `startLine` or `endLine`; reversed and
empty ranges; bounds at and beyond the available line indices, including a
`startLine` at or past the total line count (the skip-forward exhausts the source
and the stream ends empty, matching the in-bounds empty-range case) as well as an
`endLine` past the last line (which clamps); and
negative, fractional, and non-safe bounds rejecting with `EINVAL`. Include
`buffer` values `0` and greater than the selected line count, invalid buffer
values, early iterator return, early source closure at `endLine`, and propagated
source errors. The mount cases must also verify revocation mid-stream. Because
`lines` diverges from `rangeReadText`/`textRange` on the line-boundary model,
include a case that pins the divergence rather than asserting parity: for a
terminator-ending input (`a\nb\n`) and a lone-CR input (`a\rb\r`), assert that
`lines` yields the terminator-retaining, no-trailing-empty-line values documented
above, distinct from the LF-split, trailing-empty-line slots the sibling methods
would report.

Assert in the daemon mount conformance test that `lines` is in the exact
`ReadableBlob` method set. Test the platform base/local/snapshot, extended
`BlobRef`, daemon stored and transient, mount read-only view, Git, unzip, and
browser-bridge paths so a later implementation cannot satisfy the guard while
omitting a producer.

## Dependencies

| Design | Relationship |
|---|---|
| [fs-interface-consolidation.md](fs-interface-consolidation.md) | Owns the shared readable-blob guard whose deliberate widening makes this method universal. |
| [platform-range-and-tree-reads.md](platform-range-and-tree-reads.md) | Establishes the layered readable-blob interfaces and the conformance boundary this change extends. |
| [readableblob-range-attenuation.md](readableblob-range-attenuation.md) | Companion design (Status: Proposed); `lines` shares its zero-based, end-exclusive, non-negative range-*index* convention but deliberately uses a different line-boundary model (CR/LF/CRLF terminators retained and no synthetic trailing empty line, vs. `textRange`'s LF-only split with a trailing empty line). Composition is therefore byte-level (`.lines()` re-scans a `textRange` sub-blob's bytes), not line-index parity. |

## Follow-up

A separate design will consider a CoDel-inspired (Controlled Delay) control algorithm that can
implicitly adjust reader pace and buffer size. Such an API still needs an
explicit alpha parameter so callers can select relative aggressiveness. This
proposal keeps the fixed `buffer = 0` default until that broader reader-level
design establishes a replacement. That broader reader-level design is also the
natural place to decide whether `streamBase64` should converge on the same
`PassableReader` invocation shape `lines` uses, so the guard's two stream-returning
members stop diverging on protocol.

Two further extensions are deliberately out of scope here and left as follow-ups: a
maximum-line-length option (or error) to bound the per-line buffering this design
accepts as unbounded; and a follow/tail mode that waits for further appends on a
live source rather than ending at current EOF, for callers processing a still-growing
log. Both are additive to the finite, per-line-bounded reader specified here.

## Prompt

> Please design a `lines()` method addition to all implementations of the
> readable blob interface. It produces an exo stream of strings, one line per
> item, including the line terminator: `"\\r"`, `"\\n"`, `"\\r\\n"`, or an
> empty terminator for a final unterminated line. The method takes a buffer
> length following the exo-stream method convention. Source: [PR #826 review](https://github.com/endojs/endo-but-for-bots/pull/826#pullrequestreview-4757241489).
