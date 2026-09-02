# Split `@endo/cbor` into `encode` and `decode` entry points

| | |
|---|---|
| **Created** | 2026-07-30 |
| **Author** | gardener (prompted by kriskowal) |
| **Status** | Not Started |

## What is the Problem Being Solved?

`@endo/cbor` ships a single `index.js` that exports both the writer
machinery (`makeCborWriter`, `cborWriterBytes`, `writeHead`, `writeUint`,
…, `writeBignum`) and the reader machinery (`makeCborReader`, `readHead`,
`peekHead`, `readUint`, …, `readBignum`, `assertConsumed`) from one
module. A consumer that only decodes — the OCapN decoder
(`packages/ocapn/src/cbor/decode.js`), a future signature-verification
path, a diagnostics reader — nevertheless imports from a module whose
graph retains every `write*` function, the `append` / `appendBytes` /
`appendBigEndian` / `minimalBignumBytes` writer helpers, and the
`CborWriter` buffer-growth state. A consumer that only encodes — the
OCapN encoder (`packages/ocapn/src/cbor/encode.js`), the slot-machine
wire writer, the daemon envelope writer — retains the matching reader
machinery (`readHeadInternal`, `take`, `expectHead`, `headCount`,
`readerError`).

Today the cost is conceptual rather than measurable: the file is 741
lines, every export is hardened, and a bundler that performs
tree-shaking on ESM can in principle drop the unused half. But the
contract the package advertises is "import everything from
`@endo/cbor`", so no consumer can rely on that drop, and a bundler that
does not tree-shake (XS's module loader, an audit tool, a hand-written
`import * as cbor`) retains the whole codec. The package's own README
and the cbor-codec design both document the encode and decode surfaces
as one import, so the single-module shape is the documented contract,
not an accident.

The originating review on PR
[#885](https://github.com/endojs/endo-but-for-bots/pull/885#pullrequestreview-4813762886)
asks for the split:

> Please propose a follow-up refactor that splits `@endo/cbor` into
> `@endo/cbor/encode` and `@endo/cbor/decode` so that readers do not
> retain writers and vice versa.

PR #885 (the ocapn adoption, phase 2 of
[cbor-codec](cbor-codec.md)) already imports the two halves from
`@endo/cbor` along a clean line: `encode.js` imports only
`makeCborWriter`, `cborWriterBytes`, and the `write*` functions;
`decode.js` imports only `makeCborReader`, `readHead`, `peekHead`, and
the `read*` functions. The split this design proposes lands after #885
merges and retargets those imports from `@endo/cbor` to `@endo/cbor/encode`
and `@endo/cbor/decode` respectively. **This design does not modify PR
#885.**

## Goal

A consumer that only decodes can import from `@endo/cbor/decode` and
retain no encoding machinery; a consumer that only encodes can import
from `@endo/cbor/encode` and retain no decoding machinery. The
existing `@endo/cbor` root entry point continues to work unchanged so
consumers that genuinely use both halves (the package's own test
suite, a future value codec) pay no migration cost.

## Scope

In scope:

- Splitting `packages/cbor/index.js` into an encode entry point, a
  decode entry point, and an internal shared module for the constants
  and one helper both halves need.
- Declaring `./encode` and `./decode` subpath exports in
  `packages/cbor/package.json`.
- Keeping the `.` root export re-exporting both halves, so the public
  API is unchanged.
- Retargeting the package's own test imports to exercise both the
  subpath entries and the root re-export.
- A migration path for the two known consumers (ocapn encode/decode,
  the future slots migration), with the root import remaining valid.

Out of scope:

- Splitting `@endo/cbor-frame` (the framing sibling); it has its own
  design.
- Any change to the OCapN policy layer (`CborWriter` / `CborReader`
  classes, structure stacks, record labels, `peekTypeHint`); those
  stay in `packages/ocapn` and continue to import the primitives.
- Any change to the canonicality posture, the number domain, or the
  API signatures — those are settled in
  [cbor-codec](cbor-codec.md) and unchanged by this refactor.
- A reflective `encode(value)` / `decode(bytes)` value codec; that
  remains explicitly not this package.

## Design

### What is shared, what is encode-only, what is decode-only

The current `index.js` (741 lines) splits cleanly into three buckets.
Auditing every module-level binding:

**Shared by both halves** (an internal module, not exported to
consumers):

| Binding | Used by encode | Used by decode |
|---|---|---|
| `UINT64_BOUND` | `assertHeadArgument` (write head validation) | `canonicalInfo` is bounded by it; the read-side minimality check compares against `canonicalInfo(value)` |
| `UINT32_BOUND` | `assertCount` (write count validation) | `headCount` rejects counts `>= UINT32_BOUND` |
| `CANONICAL_NAN` | `writeFloat64` (emits the canonical bytes) | `readFloat64` (rejects any other NaN bit pattern) |
| `canonicalInfo` | `writeHead` (picks the minimal additional-info nibble to emit) | `readHeadInternal` (rejects a non-minimal head by comparing the observed nibble to `canonicalInfo(value)`) |

The two reader/writer state typedefs (`CborWriter`, `CborReader`) are
type-only. They are shared as JSDoc `@typedef` declarations; consumers
reference them via `@import` from the entry point that owns the state
they use (`CborWriter` from `@endo/cbor/encode`, `CborReader` from
`@endo/cbor/decode`), so the typedefs do not need a shared runtime
module — only the four runtime bindings above do.

**Encode-only** (the `./encode` entry point):

- Writer buffer helpers: `append`, `appendBytes`, `appendBigEndian`.
- Write validation: `assertHeadArgument`, `assertCount`, `assertMajor`.
- `writeCountHead`, `minimalBignumBytes` (encode-private helpers).
- `makeCborWriter`, `cborWriterBytes`.
- Every `write*` export: `writeHead`, `writeUint`, `writeInt`,
  `writeByteString`, `writeTextString`, `writeArrayHeader`,
  `writeMapHeader`, `writeTag`, `writeBoolean`, `writeNull`,
  `writeUndefined`, `writeFloat64`, `writeBignum`.

**Decode-only** (the `./decode` entry point):

- Reader cursor helpers: `readerError`, `take`.
- `readHeadInternal`, `headCount`, `expectHead` (decode-private
  helpers).
- `makeCborReader`.
- Every `read*` export: `readHead`, `peekHead`, `readUint`, `readInt`,
  `readByteString`, `readTextString`, `readArrayHeader`,
  `readMapHeader`, `readTag`, `readBoolean`, `readFloat64`,
  `readBignum`, `readOptionalUndefined`, `readNull`,
  `readOptionalNull`, `assertConsumed`.

The seam is the minimal-length computation `canonicalInfo` and the two
domain bounds plus the canonical NaN constant. Everything else is
already on one side of the encode/decode line; no function crosses it.

### Module layout

```
packages/cbor/
  index.js          # root re-export: `export * from './encode.js'; export * from './decode.js';`
  encode.js         # the encode-only exports + encode-private helpers
  decode.js         # the decode-only exports + decode-private helpers
  internals.js      # UINT64_BOUND, UINT32_BOUND, CANONICAL_NAN, canonicalInfo
  package.json      # declares ./encode and ./decode subpath exports
  test/
    cbor.test.js    # retargeted to exercise subpaths + root
    golden-vectors.json
```

`internals.js` is **not** a subpath export: it has no `exports` entry
in `package.json`, so the Node ESM resolver refuses
`@endo/cbor/internals` from outside the package, and the file's
bindings are imported only by `encode.js` and `decode.js` via relative
path (`./internals.js`). This keeps the shared constants out of the
public surface while letting both halves reference the one definition
of `canonicalInfo` — the function whose single source of truth is the
byte-identity invariant between the writer's emit and the reader's
minimality rejection.

### `package.json` exports

```jsonc
{
  "type": "module",
  "main": "./index.js",
  "exports": {
    ".": "./index.js",
    "./encode": "./encode.js",
    "./decode": "./decode.js",
    "./package.json": "./package.json"
  }
}
```

The `.` export stays first and points at `index.js`, which re-exports
both halves. The two subpath exports are the new review surface. No
`./internals` entry is declared.

A consumer that only decodes:

```js
import {
  makeCborReader,
  readHead,
  readByteString,
  assertConsumed,
} from '@endo/cbor/decode';
```

retains `decode.js` + `internals.js` and nothing from `encode.js`. A
consumer that only encodes:

```js
import {
  makeCborWriter,
  cborWriterBytes,
  writeUint,
  writeByteString,
} from '@endo/cbor/encode';
```

retains `encode.js` + `internals.js` and nothing from `decode.js`.

### Root re-export contract

`index.js` becomes:

```js
// @ts-check
export * from './encode.js';
export * from './decode.js';
```

`export *` is safe here because the two halves have **disjoint export
names** (no `write*` name collides with a `read*` name, and the
factories `makeCborWriter` / `makeCborReader` and
`cborWriterBytes` / `assertConsumed` are distinct). A future export
name collision would be a silent override under `export *`; the test
plan asserts the two export sets are disjoint so the invariant is
checked, not assumed.

The root re-export preserves the existing public API verbatim: every
name importable from `@endo/cbor` today is importable from
`@endo/cbor` after the split, from the same path, with the same
signature. The package's own README usage example continues to work
unchanged. Consumers that use both halves (the test suite, a future
value codec) keep importing from the root.

### Why an internal shared module, not duplication

`canonicalInfo` is the minimal-length head selector. The writer calls
it to decide which additional-info nibble to emit; the reader calls it
to reject a head whose observed nibble is wider than the minimal one.
These two calls must agree byte-for-byte: if they diverge, the writer
emits a head the reader rejects, or the reader accepts a head the
writer would never emit, breaking the byte-identity contract with
`rust/endo/slots` that [cbor-codec](cbor-codec.md) Design Decision 5
established. Two copies of `canonicalInfo` — one in `encode.js`, one
in `decode.js` — would make that agreement a review-time
inspection rather than a single-source-of-truth guarantee. One
internal module that both halves import is the smallest change that
keeps the invariant structural.

The same argument applies to `CANONICAL_NAN`: the writer emits it and
the reader rejects any other NaN bit pattern, so the constant must be
one definition. `UINT64_BOUND` and `UINT32_BOUND` are domain bounds
the two halves enforce from opposite directions (the writer rejects an
argument outside the range before emitting; the reader rejects a
decoded value outside the range), so they belong with the shared
definitions for the same reason.

### Typedef placement

`CborWriter` is the state `makeCborWriter` returns and the `write*`
functions accept; it is declared in `encode.js` and importable from
`@endo/cbor/encode`. `CborReader` is the state `makeCborReader`
returns and the `read*` functions accept; it is declared in
`decode.js` and importable from `@endo/cbor/decode`. The root
`index.js` re-exports both typedefs via the `export *` of each half,
so `@import { CborWriter, CborReader } from '@endo/cbor'` continues to
resolve. A consumer using only `@endo/cbor/encode` references
`CborWriter` from that entry; a consumer using only `@endo/cbor/decode`
references `CborReader` from that entry.

### Hardening

Each export in `encode.js` and `decode.js` is hardened immediately
after declaration, as today. The `internals.js` bindings are not
exported to consumers and are not hardened: they are module-private
constants and a pure function used only by the two halves, matching
the current file's treatment of `CANONICAL_NAN` (deliberately not
hardened because `harden` on a typed array is a false guarantee). The
hardening surface is unchanged from the consumer's perspective.

### TypeScript

The package ships `.d.ts` files generated from JSDoc. The split adds
`encode.d.ts` and `decode.d.ts` alongside `index.d.ts`. The
`tsconfig.composite.json` and `tsconfig.build.json` references are
updated to include the new files. `@endo/cbor/encode` and
`@endo/cbor/decode` resolve to their `.js` entry points under the
package's ESM `exports` map; TypeScript's `moduleResolution: "node16"`
/ `"bundler"` honors subpath `exports`, so type resolution follows the
runtime path. The `@import` declarations in `encode.js` and
`decode.js` point at the shared typedefs via relative path
(`./internals.js` carries no types; the bounds are `bigint` / `number`
literals) — no new `@endo/cbor/internals` type surface is exposed.

## Migration Path

Phased so each step is independently landable and verifiable. This
refactor lands **after PR #885 merges** to `llm`; it does not touch
#885's branch.

1. **Split the module.** Create `packages/cbor/internals.js` with the
   four shared bindings; create `packages/cbor/encode.js` and
   `packages/cbor/decode.js` importing from `./internals.js`; reduce
   `packages/cbor/index.js` to the two `export *` lines. Add the
   `./encode` and `./decode` entries to `package.json` `exports`.
   Acceptance: `yarn test` in `packages/cbor` is green with the test
   file retargeted to import from the subpaths (one test block per
   entry) **and** from the root (one test block asserting the union),
   proving all three entry points resolve and export the same
   surfaces. `yarn lint:types` and `yarn lint:eslint` clean.

2. **Retarget ocapn.** Change `packages/ocapn/src/cbor/encode.js` to
   import from `@endo/cbor/encode` and
   `packages/ocapn/src/cbor/decode.js` to import from
   `@endo/cbor/decode`. The `@import` type references follow
   (`CborWriter as CborWriterState` from `@endo/cbor/encode`,
   `CborReader as CborReaderState` from `@endo/cbor/decode`).
   Acceptance: the ocapn CBOR, codecs, interop, and downstream
   `@endo/ocapn-noise` suites stay green unchanged; the encoder module
   no longer names any `read*` binding and the decoder module no
   longer names any `write*` binding. `.changeset` patch bump (pure
   refactor; no public API change at the `@endo/ocapn` surface).

3. **Retarget slots when it adopts** (phase 3 of cbor-codec, gated on
   PR #124). The slots wire writer imports from
   `@endo/cbor/encode`; if a slots reader is added it imports from
   `@endo/cbor/decode`. This is the same import-path-only migration
   cbor-codec already specifies, with the entry point narrowed.

4. **Optional: retarget the daemon envelope codec** (phase 4 of
   cbor-codec). The envelope writer helpers import from
   `@endo/cbor/encode` and the reader helpers from
   `@endo/cbor/decode`.

The root `@endo/cbor` import remains valid throughout; consumers that
do not need the split pay no cost and need no change.

## Dependencies

| Design | Relationship |
|---|---|
| [cbor-codec](cbor-codec.md) | This design refines the package's entry-point shape. cbor-codec remains the source of truth for the API surface, canonicality posture, and number domain; this split changes only how the surface is packaged for import. |
| [cbors](cbors.md) | Unaffected. The framing package `@endo/cbor-frame` is a separate package with its own exports. |

## Design Decisions

1. **Subpath exports, not two packages.** `@endo/cbor/encode` and
   `@endo/cbor/decode` are subpath exports of one `@endo/cbor`
   package, not separate `@endo/cbor-encode` / `@endo/cbor-decode`
   packages. The two halves share `internals.js` and the
   byte-identity invariant it carries; splitting them into separate
   packages would either duplicate `canonicalInfo` (breaking
   single-source-of-truth) or create a third `@endo/cbor-internals`
   package whose only consumers are the two siblings, which is
   package-graph noise for no benefit. Subpath exports give the
   retention isolation the review asks for without that cost.
2. **One internal shared module, not zero.** `canonicalInfo`,
   `CANONICAL_NAN`, and the two bounds are the minimal shared set
   that keeps the writer's emit and the reader's rejection agreeing
   from one definition. Duplicating them across `encode.js` and
   `decode.js` would make the byte-identity contract a review
   inspection rather than a structural guarantee; one
   `internals.js` is the smallest change that preserves it.
3. **`internals.js` is not a subpath export.** It has no `exports`
   entry, so `@endo/cbor/internals` is unresolvable from outside the
   package. The shared bindings are an implementation detail, not a
   review surface; exposing them would invite consumers to depend on
   `canonicalInfo` directly, which is the writer/reader agreement
   they should never see.
4. **The root `.` export is preserved.** Existing consumers, the
   README usage example, and the package's own test suite keep
   importing from `@endo/cbor`. The split is additive: it adds two
   narrower entry points, it does not narrow the existing one. A
   consumer that uses both halves pays no migration cost.
5. **`export *` is safe because the export name sets are disjoint.**
   No `write*` name collides with a `read*` name, and the factories
   and utilities (`makeCborWriter` / `makeCborReader`,
   `cborWriterBytes` / `assertConsumed`) are distinct. The test plan
   asserts the disjointness so a future colliding export is caught by
   CI rather than silently overriding under `export *`.
6. **No change to signatures, canonicality, or the number domain.**
   This is a packaging refactor. Every function's name, parameter
   types, return types, and behavior are identical to the current
   `index.js`; they merely live in a different file. The
   canonical-always writer and strict-reader posture
   ([cbor-codec](cbor-codec.md) Design Decision 5) is unchanged.

## Test Plan

- **Ported suite, retargeted.** The existing
  `packages/cbor/test/cbor.test.js` cases run three times: once with
  the write-side names imported from `@endo/cbor/encode` and the
  read-side names from `@endo/cbor/decode` (the split posture), once
  with everything from `@endo/cbor/encode` only where applicable and
  `@endo/cbor/decode` only where applicable, and once with the full
  set from the root `@endo/cbor` (the unchanged posture). The golden
  vectors (`golden-vectors.json`) pass in all three configurations.
- **Export-name disjointness.** A test that imports the named exports
  of `@endo/cbor/encode` and `@endo/cbor/decode` and asserts the two
  sets are disjoint, so `export *` in `index.js` cannot silently
  override. (A future colliding export fails this test rather than
  quietly shadowing.)
- **Root re-export completeness.** A test that the named exports of
  `@endo/cbor` are exactly the union of the named exports of the two
  subpaths, so the root entry point neither drops nor adds a name
  relative to the split.
- **Internals are not exported.** A test that
  `@endo/cbor/internals` is not resolvable (the import rejects per
  the `exports` map), so the shared module stays an implementation
  detail.
- **Migration acceptance (phase 2).** The ocapn suites
  (`packages/ocapn/test/cbor/{encode,decode,interop}.test.js`,
  `test/codecs/*`, and the downstream `@endo/ocapn-noise` suite)
  stay green unchanged after retargeting, proving the split is
  behavior-preserving at the consumer boundary.

## Open Questions

1. **Should the root `@endo/cbor` import be deprecated in favor of the
   subpaths?** This design preserves it. Deprecating it would force
   every consumer to choose a half and would break the README example
   and the test suite's "use both" posture. The review asks for the
   narrower entry points to exist, not for the broad one to go away;
   deprecating is a maintainer call, not a designer one. Resolved:
   keep the root, surface the question here for the maintainer to
   reopen if they want a future deprecation cycle.
2. **Does `internals.js` warrant a `@endo/cbor/internals` subpath
   export for audit tools that want to inspect the shared
   definitions?** This design says no: the definitions are an
   implementation detail and exposing them invites direct consumer
   dependence on the writer/reader agreement. An auditor reads the
   file in the repo. Resolved: no export; reopen if a maintainer
   wants the definitions addressable from a consumer import.

## Prompt

> Please propose a follow-up refactor that splits `@endo/cbor` into
> `@endo/cbor/encode` and `@endo/cbor/decode` so that readers do not
> retain writers and vice versa.

(kriskowal, approving review of
[endojs/endo-but-for-bots#885](https://github.com/endojs/endo-but-for-bots/pull/885#pullrequestreview-4813762886),
2026-07-29.)
