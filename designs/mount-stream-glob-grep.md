# Streaming Mount Search: `streamGlob` and `streamGrep`

| | |
|---|---|
| **Created** | 2026-07-09 |
| **Author** | Kris Kowal (prompted) |
| **Status** | Not Started |
| **Source** | Review comment on [PR #127](https://github.com/endojs/endo-but-for-bots/pull/127#discussion_r3548861664) (mount extensions help text) |

## What is the Problem Being Solved?

The mount extensions branch (PR #127, `feat/mount-extensions`) gives
`EndoMount` two bulk search methods that return fully materialized arrays:

- `glob(pattern) -> Promise<string[]>`
- `grep(pattern, options?) -> Promise<Array<{ file, line, text }>>`

Eager materialization has three scaling problems.
First, protective caps (`GLOB_MAX_RESULTS`, 10,000 paths; `grep`
`options.maxResults`, default 1,000 matches) silently truncate large result
sets, and the protocol offers no way to ask for the rest.
Second, the caller sees nothing until the whole walk finishes, so
time-to-first-result on a large mount is the full traversal time.
Third, memory and marshalled-message size are proportional to the whole
result set on both sides of the CapTP boundary, and `grep` additionally
materializes its entire candidate file list (a full `glob` result) before
reading the first file.

The maintainer directed on the PR #127 help-text review: "Please post a plan
to design exo-stream variants of these methods, like `streamGlob` and
`streamGrep`."

This design adds streaming variants built on `@endo/exo-stream`, the
package this repository already uses for byte streams (`EndoMountFile.
streamBase64`, `write` blob ingestion, tar check-in) and which exists
precisely to bridge async iteration over CapTP with flow control and
pattern guards.

## Design

### Surface

Two new methods on `EndoMount`:

```
streamGlob(pattern, options?) -> PassableReader<string>
streamGrep(pattern, options?) -> PassableReader<{ file, line, text }>
```

- `streamGlob` options: `{ buffer?: number }`.
- `streamGrep` options: `{ glob?: string, buffer?: number }`.
  There is deliberately no `maxResults`: the consumer bounds the stream by
  returning early, which stops the remote walk (see cancellation below).

Both return a fresh `PassableReader` remotable (from
`@endo/exo-stream/reader-from-iterator.js`) synchronously, the same way
`entry` returns an `EndoMountEntry` and `readOnly` returns the view, so the
consumer can pipeline without an extra round trip:

```js
import { E } from '@endo/far';
import { iterateReader } from '@endo/exo-stream/iterate-reader.js';

for await (const { file, line, text } of iterateReader(
  E(mount).streamGrep('TODO', { glob: 'src/**/*.js' }),
)) {
  if (foundEnough()) break; // stops the remote walk too
}
```

Interface guards in `MountInterface` (`packages/daemon/src/interfaces.js`):

```js
// Search (streaming)
streamGlob: M.call(M.string())
  .optional(M.splitRecord({}, { buffer: M.number() }))
  .returns(M.remotable('PassableReader')),
streamGrep: M.call(M.string())
  .optional(M.splitRecord({}, { glob: M.string(), buffer: M.number() }))
  .returns(M.remotable('PassableReader')),
```

Each reader self-describes its element shape through the exo-stream
`readPattern()` facility, so consumers can rely on well-shaped elements or
the stream breaks with an error:

- `streamGlob`: `M.string()` (mount-relative path).
- `streamGrep`: `harden({ file: M.string(), line: M.number(), text: M.string() })`.

### Producer implementation

Refactor the existing walker rather than adding a second one, so the eager
and streaming variants cannot drift behaviorally:

1. `walkGlob` (in `packages/daemon/src/mount.js`) changes from
   accumulate-into-array to an async generator, `walkGlobMatches`, yielding
   mount-relative paths in the same deterministic sorted depth-first order
   it produces today (it already sorts each directory listing).
2. `glob()` collects `walkGlobMatches` up to `GLOB_MAX_RESULTS`.
   Behavior and existing tests are unchanged.
3. A second generator, `grepMatches`, composes over `walkGlobMatches`: for
   each candidate path it skips directories, reads the file text (skipping
   unreadable files exactly as `grep` does today), and yields one
   `{ file, line, text }` record per matching line.
4. `grep()` collects `grepMatches` up to `maxResults`. This incidentally
   fixes the intermediate materialization: today `grep` awaits the full
   `glob` array before reading any file.
5. `streamGlob()` and `streamGrep()` wrap the generators:

```js
streamGlob(pattern, options = {}) {
  assertLive();
  const { buffer = 0 } = options;
  return readerFromIterator(walkGlobMatches(/* ... */), {
    buffer: clampStreamBuffer(buffer),
    readPattern: M.string(),
  });
},
```

Async generators are lazy: the walk advances only when the stream is
pulled, so no traversal runs ahead of consumer demand beyond the requested
pre-ack buffer.

```mermaid
sequenceDiagram
  participant C as Consumer (initiator)
  participant M as EndoMount (responder)
  C->>M: streamGlob(pattern)
  M-->>C: PassableReader
  C->>M: syn (give me one)
  M->>M: walk one step (readDirectory, confinement, deny checks)
  M-->>C: ack "src/index.js"
  C->>M: syn
  M-->>C: ack "src/mount.js"
  C->>M: return() (early close)
  M->>M: generator finally; walk abandoned
  M-->>C: terminal ack
```

### Backpressure and cancellation

Both are delegated wholesale to the Exo Stream Protocol
(`packages/exo-stream/PROTOCOL.md`): data flows on the acknowledge chain,
flow control on the synchronize chain.

- **Backpressure.** With the default `buffer: 0` the stream is fully
  synchronized: the mount performs at most one walk step ahead of consumer
  demand. Consumers on high-latency links pass `buffer > 0` to let the
  producer pre-ack that many elements. The producer clamps the requested
  buffer (`clampStreamBuffer`, proposed ceiling 1,024) so a remote caller
  cannot demand unbounded pre-materialization; the clamp replaces the eager
  variants' result caps as the daemon-side resource bound.
- **Cancellation.** A consumer that breaks out of `for await` (or calls
  `return(value)` on the iterator) sends the close on the final
  synchronize node; the reader pump calls the generator's `return()`, the
  generator's `finally` runs, and no further filesystem I/O happens. A
  consumer `throw` closes the same way through `iterateReader`.

### Revocation

`streamGlob` and `streamGrep` call `assertLive()` at invocation, and the
generators re-check `assertLive()` before each directory read and each
yield. A `MountControl.revoke()` mid-stream therefore causes the next pull
to reject on the acknowledge chain with the same "Mount has been revoked"
error the eager methods throw; `iterateReader` surfaces it as a thrown
error at the consumer's `for await`. A revoked-but-never-pulled stream
holds only a suspended generator closure (no open file handles between
pulls), so no separate teardown registration with the revocation context is
needed.

### Confinement, deny patterns, and attenuations

Identical to the eager methods by construction, because the walker is
shared: `isDeniedSegment` and `isConfinedPath` apply to every entry, so
deny-listed names (`.ssh`, `.env`, and the rest) and paths escaping the
confinement root are never yielded. On a `subView` / `subDir` sub-mount the
generator walks under the sub-root's own confinement root.

The streaming methods are reads, so they are available on read-only mounts
(a mount made with `readOnly: true`). The structural `readOnly()`
`ReadableTree` view does **not** carry them, consistent with the existing
exclusion of `glob`, `grep`, and `stat` from that view: the view is the
minimal shared read contract from `@endo/platform/fs`, and callers that
need search keep a mount reference.

### Help text and types

`packages/daemon/src/help-text-data.js` gains two `EndoMount` entries:

- `streamGlob: 'streamGlob(pattern, options?) -> PassableReader<string>\n...'`
- `streamGrep: 'streamGrep(pattern, options?) -> PassableReader<{ file, line, text }>\n...'`

Each names the options, states that the consumer iterates with
`iterateReader` from `@endo/exo-stream`, and states that closing the
iterator early stops the walk. The eager `glob` and `grep` entries gain a
cross-reference sentence ("results are capped; for incremental or
unbounded result sets use streamGlob / streamGrep"). The mount typedefs
type the two methods with `PassableReader` imported from
`@endo/exo-stream`.

### Scope: other bulk methods

- `list(...path)`: one `readDirectory`, bounded by a single directory's
  width. Considered and rejected: `streamList`. Reason: redundant, since
  `streamGlob('*')` (one level) and `streamGlob('**/*')` (recursive) are
  the streaming enumerations.
- `snapshot()`: already scales, since it returns a content-addressed
  `SnapshotTree` whose per-file bytes stream over `streamBase64`; the
  check-in walk is a content-store concern settled in
  [daemon-mount-capabilities](daemon-mount-capabilities.md). Out of scope.
- `followNameChanges()`: declared but unimplemented pending a filesystem
  watcher (see [fs-interface-consolidation](fs-interface-consolidation.md)
  § C1). A change feed is an infinite stream and should ride the same
  `PassableReader` shape when the watcher design lands; named here so that
  design adopts the same protocol (tracking design to be filed with the
  watcher work).

## Dependencies

| Artifact | Relationship |
| --- | --- |
| [PR #127](https://github.com/endojs/endo-but-for-bots/pull/127) `feat/mount-extensions` | Defines `glob`/`grep` and `walkGlob`; the implementation stacks on this branch or lands after the mount stack merges to `llm` |
| `@endo/exo-stream` (`PROTOCOL.md`, `DESIGN.md`) | The stream remotable shape, reader pump, buffer option, pattern guards |
| [daemon-mount](daemon-mount.md), [daemon-mount-capabilities](daemon-mount-capabilities.md) | The mount surface being extended |
| [fs-interface-consolidation](fs-interface-consolidation.md) § C1 | `followNameChanges` placeholder that should reuse this stream shape |

## Phased Implementation

1. **Walker refactor.** `walkGlob` becomes the `walkGlobMatches` async
   generator; `glob()` and `grep()` become bounded collectors over the
   generators. Existing glob/grep tests pass unchanged.
2. **Stream surface.** `streamGlob` / `streamGrep` methods, `MountInterface`
   guards, help-text entries, typedefs.
3. **Tests** per the plan below.

One implementation PR, one commit per phase. Its base follows the
repository's base-branch inference: on `feat/mount-extensions` while
PR #127 is open, otherwise on the branch the mount stack merged to.

## Design Decisions

1. **Return the `PassableReader` synchronously** (guard
   `M.remotable('PassableReader')`, not `M.promise()`), so
   `iterateReader(E(mount).streamGlob(p))` pipelines. Precedent: `entry`
   and `readOnly` return remotables directly.
2. **No `maxResults` on stream variants.** The consumer's pull-based flow
   control is the bound; early `return()` stops the walk. The caps remain
   on the eager variants, whose purpose (bounded single-message results)
   they fit.
3. **Clamp the `buffer` option** rather than trusting the caller, so the
   pre-ack window is the only daemon-side memory commitment.
4. **One shared walker** for eager and streaming variants, preventing
   behavioral drift in confinement, deny patterns, and ordering.
5. **Per-step `assertLive()`** inside the generators, so revocation cuts
   in-flight streams at the next pull.
6. **Streaming search lives on `EndoMount` only**, not on the structural
   `ReadableTree` view, matching the existing `glob`/`grep`/`stat`
   exclusion.
7. **Ordering is the same deterministic sorted depth-first order** as
   eager `glob`, so collecting a stream reproduces the eager result.

## Test Plan

Extend `packages/daemon/test/mount.test.js` on the same fixture the
glob/grep tests use (a temporary directory tree plus `makeMount`, helpers
in `packages/daemon/test/_mount-test-helpers.js`), coordinating the fixture
shape with the mount-extensions reconstruction effort that owns those
tests:

- **Parity**: collecting `streamGlob` equals `glob`; collecting
  `streamGrep` equals `grep`, on the same fixture tree, including order.
- **Incrementality**: with an instrumented `filePowers` counting
  `readDirectory` calls, pull one match from a deep fixture then
  `return()`; assert the walk did not complete.
- **Backpressure**: with `buffer: 0`, assert directory reads do not run
  ahead of pulls (call counter sampled between pulls).
- **Cancellation**: break out of `for await`; no unhandled rejection; the
  generator's `finally` ran.
- **Revocation mid-stream**: revoke between pulls; the next pull rejects
  with "Mount has been revoked".
- **Confinement and denial**: fixture containing a `.ssh` entry and an
  escaping symlink; assert neither is ever yielded (streaming parity with
  the existing denial tests).
- **Pattern guard**: `readPattern()` returns the documented shape; each
  yielded element matches it.
- **Options**: `streamGrep` respects `options.glob`; an oversized `buffer`
  is clamped.

## Open Questions

- Should a later pass add streaming search to the structural
  `ReadableTree` view (and `SnapshotTree`), so read-only tree consumers
  can search without holding a mount reference? Default here: no; the view
  stays minimal.
- Is 1,024 the right `buffer` clamp? Any small constant preserves the
  resource bound; tune during implementation.
