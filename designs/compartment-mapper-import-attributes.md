# Compartment Mapper Import Attributes

| | |
|---|---|
| **Created** | 2026-05-15 |
| **Updated** | 2026-05-15 |
| **Author** | Kris Kowal (prompted) |
| **Status** | Proposed |

## Problem statement

The sibling design [SES Import Attributes](./ses-import-attributes.md)
extends `Compartment`, `@endo/module-source`, and the SES module memo to
carry the `with { ... }` clause from each static and dynamic import all
the way to a host's `importHook`.
It explicitly stops at the SES boundary; the per-`package.json`
propagation through `@endo/compartment-mapper` is deferred to this
design.

`@endo/compartment-mapper` is the package that turns a Node-style
application's package graph into a single, replayable archive
(typically a `tar.gz`) containing every module in the graph plus a
synthetic compartment configuration that re-instantiates it at runtime.
A `compartment-mapper` workflow has three legs:

1. **Map.** Walk the application's `node_modules`, read every
   `package.json`, and produce a compartment-map descriptor.
   `packages/compartment-mapper/src/node-modules.js` and
   `packages/compartment-mapper/src/infer-exports.js` are the seats.
2. **Link.** Construct a DAG of `Compartment` instances from that
   descriptor.
   `packages/compartment-mapper/src/link.js` is the seat.
3. **Archive.** Write the captured graph and a synthesized
   compartment-map to a zip file; read it back at runtime through a
   synthetic `importHook`.
   `packages/compartment-mapper/src/archive-lite.js` and
   `packages/compartment-mapper/src/import-archive-lite.js` are the
   seats.

The SES sibling design lands a summary of the touchpoints in its
[`## Compartment-mapper implications`](./ses-import-attributes.md#compartment-mapper-implications)
section.
This design walks each touchpoint at the level of detail a future
builder dispatch needs to land an implementation PR.
The design intentionally stops at the propagation contract; the
implementation PR will be a separate builder dispatch rooted on
`master` per the maintainer's framing that designs land on `llm` and
implementations land on `master`.

## Scope and non-goals

In scope for v1:

- The shape of the per-import attribute record in the compartment-map
  descriptor and how it is populated during the map leg.
- The shape change to `interpretExports` / `interpretImports` in
  `infer-exports.js` so a `package.json` condition on an exported
  module specifier can carry a default attribute set.
- The handoff from the resolver to `link.js`: which module-descriptor
  field carries the attributes, and how `link.js` routes attribute-
  bearing records to SES's `modulesWithAttributes` option versus the
  legacy `moduleMap`.
- The synthetic `importHook` shape inside both `import.js` (live
  Node-modules import) and `import-archive-lite.js` (archive replay):
  the hook becomes a two-argument hook so the SES arity rule lets
  it honor non-JS `type` attributes.
- The archive write path: the per-import record gains an optional
  `attributes` field that is omitted when empty so existing archives
  remain byte-identical.
- The archive read path: an archive entry without an `attributes`
  field is read as the SES sentinel `EMPTY_ATTRIBUTES`, and the
  legacy collapse rule keeps it on the same memo key as today.
- The compartment-map JSON schema bump (a new optional field on the
  per-import record), and the backward-compatibility guarantee for
  archives produced by older mapper versions.

Out of scope:

- The SES surface itself: parser, normalization, memo key, `ImportHook`
  signature, `modulesWithAttributes` option.
  All in [SES Import Attributes](./ses-import-attributes.md).
- Any host-defined attribute key beyond `type`.
  The TC39 proposal leaves these to the host; this design propagates
  whatever the SES normalization accepts but interprets none of it.
- A new `package.json` condition that keys on attribute values
  (a `with-type-json` condition or similar).
  Today's conditions (`import`, `require`, `node`, `browser`,
  user-defined) stay as they are; see `## Open questions` for the
  case for a follow-up.
- Per-type source variants in `@endo/module-source`
  (`JsonModuleSource`, `CssModuleSource`).
  The SES design rejects these; the compartment-mapper side likewise
  builds whatever a host's two-argument hook returns and asks for no
  new source shape.

## Propagation overview

The flow from `package.json` to module-record construction has four
hops, threaded through five participants. Listed in the order they
appear in the diagram below:

1. **`pkg`**: the application's `package.json` files (one per package
   in the graph).
2. **`mod`**: `@endo/module-source`, the parser, which reads each
   module's body and emits an `imports` set of `{ specifier,
   attributes }` records.
3. **`graph`**: `packages/compartment-mapper/src/node-modules.js` plus
   `packages/compartment-mapper/src/infer-exports.js`, which walk
   `node_modules` and the `exports`/`imports` fields of each
   `package.json` to produce the compartment-map descriptor.
4. **`link`**: `packages/compartment-mapper/src/link.js`, which
   constructs the runtime DAG of `Compartment` instances from the
   descriptor.
5. **`ses`**: the runtime SES `Compartment`, with its module-load
   memo and `importHook`.

This design adds an `Attributes` companion to the existing
specifier-shaped data at each hop without changing the resolver's
single-pass shape.

```mermaid
sequenceDiagram
  participant pkg as package.json
  participant mod as @endo/module-source<br/>(parser)
  participant graph as node-modules.js<br/>+ infer-exports.js
  participant link as link.js
  participant ses as SES Compartment<br/>(memo + importHook)

  Note over pkg,mod: design-time map leg
  pkg->>mod: module source bytes
  pkg->>graph: exports / imports / conditions
  mod->>graph: ModuleSource.imports records<br/>(specifier, attributes)
  graph->>graph: gather per-import attributes<br/>into module descriptor
  Note over graph,link: design-time link leg
  graph->>link: compartment-map descriptor<br/>with per-import attributes
  link->>ses: modulesWithAttributes triples<br/>+ two-arg importHook
  Note over link,ses: runtime
  ses->>link: importHook(specifier, attributes)
  link->>ses: ModuleDescriptor<br/>(dispatched on attributes)
```

The carry rule for every hop is the same: a specifier-shaped value
becomes a `(specifier, attributes)` pair, where the attributes half
is the normalized frozen object SES exposes, and an absent or empty
`with` clause is the `EMPTY_ATTRIBUTES` sentinel from the sibling
design, which collapses to the legacy specifier-only slot in every
keyed structure (memo, module-map, descriptor record).

**SES arity rule.** This design leans repeatedly on the SES loader's
hook-arity discriminator (defined in the sibling design's
[`## importHook signature`](./ses-import-attributes.md#importhook-signature)
section). The rule: when a hook (`importHook`, `importNowHook`, the
synthetic archive hook) reports `length === 2`, the SES loader passes
the normalized attribute object on every invocation, including the
empty case; when the hook reports `length === 1`, the loader calls it
specifier-only (and throws if the loader's own dispatch ever reaches
the hook with a non-empty attribute bag). The rule is what gives a
v0 caller of `link.js` a soft landing: a `makeImportHook` that still
returns a one-arg hook keeps working for graphs that contain no
attribute-bearing imports. Every later reference to "the arity rule"
in this design points back to this paragraph.

## Per-import attribute record in the compartment-map descriptor

`@endo/module-source` parses each module and emits the set of imported
specifiers.
Today the parser records an import as a bare string; under the sibling
design the parser records each import as
`{ specifier, attributes }` (see [SES Import Attributes § Normalized
attribute representation](./ses-import-attributes.md#normalized-attribute-representation)).
The compartment-mapper's grapher consumes those records and writes
them into the per-compartment module descriptor.

Today's per-module descriptor (`FileModuleConfiguration` in
`packages/compartment-mapper/src/types/compartment-map-schema.ts`)
records `location`, `parser`, and `sha512` and carries no per-import
shape on the persisted form.
The resolved-import map of `Record<importSpecifier, fullSpecifier>`
that `bundle-lite.js`, `parse-cjs.js`, and `policy.js` walk under the
name `resolvedImports` is an in-memory and execution-side construct,
not a schema field; the JSON-serialized compartment-map descriptor
does not record it today.
This design adds an optional `imports` field to
`FileModuleConfiguration` (and a parallel field on
`CompartmentModuleConfiguration`) so the archive can name each
import's resolved specifier *and* its attribute bag.
The extended shape carries the attributes alongside the resolved
specifier:

```ts
type ResolvedImport = {
  specifier: string;
  attributes?: Record<string, string>;
};

type ResolvedImports = Record<string /* import specifier */, ResolvedImport>;
```

Legacy collapse on the descriptor.
When the attributes bag is empty, the `attributes` field is *omitted*
from the JSON-serialized form rather than serialized as `{}`.
A reader recovering a descriptor without an `attributes` field
constructs `EMPTY_ATTRIBUTES` for it, matching the SES sentinel.
This keeps archives produced from purely-JavaScript graphs byte-
identical to today's output and keeps the schema migration backward
compatible.

In-memory shape during the map and link legs is symmetric: an
attribute-free import carries `attributes: undefined` on the
in-memory record and the JSON serializer omits the field when
serializing.

## `infer-exports.js` and `package.json` conditions

`infer-exports.js` walks the `exports` and `imports` fields of a
`package.json`, picks the highest-priority condition match for the
caller's set of active conditions, and yields
`[exportedName, internalSpecifier]` pairs.

This design does **not** introduce a new condition keyed on
attribute values.
The condition set continues to be the dimension the package author
uses to pick between alternative entry points, and the attribute set
continues to be the dimension the import site uses to tell the host
what content-type it expects.
The two are independent.

What *does* change in `infer-exports.js` is its handling of an
already-attribute-bearing `internalSpecifier`.
Today the yielded internal specifier is always a bare string; under
this design the yielded form may include an attribute set that the
package author has declared adjacent to a specific export.
A worked example, with the speculative `withAttributes` companion
field on a `package.json` exports entry:

```jsonc
{
  "name": "@example/data",
  "exports": {
    "./policy.json": {
      "import": "./src/policy.json",
      "withAttributes": { "type": "json" }
    }
  }
}
```

Under this design the grapher records the export as
`('./policy.json', { specifier: './src/policy.json',
attributes: { type: 'json' } })`.
A consumer that does `import policy from
'@example/data/policy.json'` (no `with` clause at the import site)
then sees the package's declared attribute set propagate through to
the synthetic `importHook` invocation at runtime.

This is the minimum hook the package author needs to ship a content-
typed export today without forcing every caller to spell the
attribute at the import site.
See `## Open questions` for whether `withAttributes` is the right
field name (alternatives include `with`, mirroring the syntax, and
`attributes`, mirroring the SES API).

Pre-existing behavior is preserved.
A `package.json` whose `exports` field uses no `withAttributes`
companion field yields the same shape it does today; only the
in-memory carrier widens.
The compartment-map serializer omits the empty-attribute form per the
legacy-collapse rule above.

`interpretImports` (the `package.json` `imports` field walker)
gets the same companion-field handling.
A subpath imports key with a `withAttributes` companion propagates
attributes from the `#name` to the resolved internal specifier
exactly as the exports walker does.

## `link.js`: routing attribute-bearing records to SES

`link.js` is where the compartment-map descriptor becomes a DAG of
`Compartment` instances.
Today (`packages/compartment-mapper/src/link.js` § `link`):

- The linker iterates compartment descriptors, builds a per-compartment
  `moduleMap` (specifier-keyed) and `moduleMapHook` (returns a
  specifier-keyed module record), and supplies them to
  `new Compartment({ moduleMap, moduleMapHook, importHook, ... })`.
- Each compartment's `importHook` is built by `makeImportHook` (from
  the caller's `LinkOptions`), a single-argument hook keyed on
  specifier alone.

Under this design:

- The linker partitions the per-compartment module descriptors into two
  groups based on the attribute set on each descriptor's import record:
  empty (legacy collapse) goes to `moduleMap`, non-empty (extended)
  goes to the new `modulesWithAttributes` option from the SES sibling
  design.
- `makeImportHook` is invoked at the same site, but the returned hook
  is two-argument (`(specifier, attributes) => ...`).
  The hook honors the SES arity rule: a hook with `length` 2 receives
  the normalized attribute object on every call, including the empty
  case.
- The synthetic hook dispatches on `(specifier, attributes)`.
  For a `with { type: 'json' }` import, the hook reads the resolved
  bytes, decodes them as JSON, and returns a `VirtualModuleSource`
  whose `execute` binds the parsed value to `default` per the SES
  design's
  [`## Source dispatch`](./ses-import-attributes.md#source-dispatch)
  section.

`moduleMapHook` stays untouched.
Per the SES design's
[`## Compartment construction: priming attribute-bearing modules`](./ses-import-attributes.md#compartment-construction-priming-attribute-bearing-modules)
section, attributes do not pass through `moduleMapHook` (the hook
returns a specifier-keyed module record and the linker collapses
attribute-free entries through it).
A compartment that needs to thread an attribute-bearing entry seats
it via `modulesWithAttributes` at construction time and lets the
attribute-aware `importHook` handle the dynamic case.

**`moduleMapHook` + attribute-bearing entry, in detail.**
Three cases exhaust the interaction between `moduleMapHook` (the
specifier-keyed dynamic linker hook) and an import whose parser-side
record carries non-empty attributes:

1. *Attribute-bearing import whose specifier is also seated through
   `moduleMapHook`.*
   The linker's partition step (see the table below) routes the
   attribute-bearing record to `modulesWithAttributes` at construction
   time. The SES loader resolves the extended memo key first, hits
   the primed entry, and the `moduleMapHook` is not consulted for
   that `(specifier, attributes)` pair. The same specifier with the
   empty attribute bag continues to flow through `moduleMapHook`
   under the legacy-collapse rule.
2. *`moduleMapHook` returns a record whose underlying source carries
   parser-emitted attributes.*
   `moduleMapHook`'s return shape is specifier-keyed by contract
   ([SES sibling](./ses-import-attributes.md#compartment-construction-priming-attribute-bearing-modules))
   so it cannot itself surface an attribute bag. The linker treats
   any record returned by `moduleMapHook` as if its caller-side
   attribute set were empty; the hook's job remains specifier-keyed
   substitution, not attribute-aware dispatch. A compartment that
   wants attribute-aware dynamic substitution uses
   `modulesWithAttributes` at construction time, or implements the
   dispatch inside its `importHook` (the two-arg one).
3. *Attribute-free import whose specifier is not in
   `modulesWithAttributes`.*
   Unchanged from today: `moduleMapHook` is consulted, then
   `moduleMap`, then the two-arg `importHook` with an empty
   attribute bag. The arity rule keeps the empty-bag case
   indistinguishable from today's specifier-only call from the
   `importHook`'s point of view (a v0 single-arg hook still
   satisfies the call).

Concrete touchpoints in `link.js`:

| Site                                | Change                                                                                                              |
|-------------------------------------|---------------------------------------------------------------------------------------------------------------------|
| `makeModuleMapHook`                 | Unchanged. Continues to return a single-argument specifier-keyed hook.                                              |
| `link` body, per-compartment loop   | Partition the `modules` record into legacy-collapse (`moduleMap`) and extended (`modulesWithAttributes`) seats.     |
| `importHook` construction call      | The caller's `makeImportHook` becomes a factory for a two-argument hook (see *Implications for callers* below).     |
| `new Compartment({ ... })` call     | Pass `modulesWithAttributes` when the partition produced non-empty entries; otherwise omit the option for parity.   |

The partition step is mechanical: walk
`compartmentDescriptor.modules`, look at each entry's
`attributes` field, send the entry to `moduleMap` if absent and to
`modulesWithAttributes` if present.
The `[specifier, attributes, source]` triple shape comes from the SES
design.

### Implications for callers of `link.js`

`makeImportHook` is supplied by the caller of `link.js`
(`assemble`, `loadArchive`, `parseArchive`, and a small number of
direct `link()` callers).
Under the legacy single-argument signature, the caller's hook
implementation looks like:

```js
const makeImportHook = ({ packageLocation, ... }) => {
  return async specifier => { /* ... */ };
};
```

Under this design, the hook becomes two-argument:

```js
const makeImportHook = ({ packageLocation, ... }) => {
  return async (specifier, attributes) => { /* ... */ };
};
```

The `ImportHookMaker` type in
`packages/compartment-mapper/src/types/internal.ts` widens
accordingly.
The arity rule from the SES side gives existing callers a soft
landing: a `makeImportHook` that still returns a single-argument
hook continues to work for graphs that never use attributes (every
import is in the legacy-collapse slot, the legacy single-arg hook
suffices, SES does not throw the arity *TypeError*).
A migration-aware caller updates its hook to the two-argument shape
to gain the ability to serve attribute-bearing imports.

`makeImportNowHook` (the synchronous counterpart used for `require`-
style call sites) gets the same widening.

## Archive write path

`packages/compartment-mapper/src/archive-lite.js` produces the
compartment-map JSON that lands inside the archive.
The serializer walks the in-memory per-compartment descriptor and
writes each module's metadata.
Two changes:

1. **Per-import attributes.**
   When a module's parser-emitted import records include a non-empty
   attributes bag, the serializer writes the bag onto the
   `imports[specifier]` entry of the persisted
   `FileModuleConfiguration` (the new schema field introduced under
   `## Compartment-map JSON schema` below).
   An attribute-free import serializes as a bare-string entry,
   matching the legacy-collapse rule.
2. **Compartment-map schema version bump.**
   The top-level `tags` array gains a sentinel (e.g.,
   `'import-attributes-v1'`) when the archive contains any
   attribute-bearing import.
   An archive whose graph is purely JavaScript continues to write the
   pre-attributes `tags` exactly as today.
   The sentinel lets readers fail clearly on a version they cannot
   honor instead of silently mis-keying memo entries.

The write path's *SHA-pinned archive integrity* guarantee from the
SES design carries through: an archive produced from a purely-
JavaScript graph is byte-identical to today's output, because the
serializer emits no `attributes` field and no version sentinel.

## Archive read path

`packages/compartment-mapper/src/import-archive-lite.js`'s
`makeArchiveImportHookMaker` produces the synthetic `importHook`
that replays an archive.
Today (`importHook: async moduleSpecifier => { ... }`), the hook is
single-argument and dispatches on the in-archive specifier alone.

Under this design:

- The synthetic hook becomes a two-argument hook
  (`async (moduleSpecifier, attributes) => { ... }`).
- The hook dispatches on `(moduleSpecifier, attributes)`.
  For the dominant empty-attributes case the dispatch table key is
  the bare specifier; for a non-empty case the key is the JSON-
  stringified `[specifier, normalizedAttributes]` tuple per the SES
  memo key rule.
- Per-archive-entry attributes recovered from the compartment-map
  JSON populate the synthetic dispatch table during the archive's
  preload phase.
- The `parse(moduleBytes, ...)` step today returns a record for the
  archived language.
  Under this design the hook may dispatch on attributes *before*
  calling `parse`: a `with { type: 'json' }` entry whose stored
  parser is `'json'` already does the right thing through the
  existing JSON parser, but an unrecognized attribute combination
  raises a deferred error rather than silently falling through.

Backward compatibility on the read side:

- An archive without the `'import-attributes-v1'` tag and without any
  per-import `attributes` field reads identically to today.
  Every import lands in the legacy-collapse slot, the SES arity rule
  keeps the synthetic single-arg hook valid (a v0 mapper produces a
  one-arg hook; a v1 mapper produces a two-arg hook), and the memo
  collapses to the bare-specifier key.
- An archive with the tag but read by an older mapper version (no
  `attributes` support in the reader) fails fast at the
  `assertFileCompartmentMap` step with a clear "this archive uses
  import attributes, please upgrade `@endo/compartment-mapper`"
  diagnostic rather than silently mis-loading.

## Compartment-map JSON schema

The schema bump adds one optional field, `imports`, to the per-module
`FileModuleConfiguration` (and a parallel field on
`CompartmentModuleConfiguration` for forwarded modules).
`FileModuleConfiguration` currently records only `location`, `parser`,
and `sha512`; the field is net-new, not a widening of an existing
property.
The optional shape means an archive whose graph is purely JavaScript
and whose author has not opted into per-import metadata still
serializes byte-identically to today.

```diff
 export interface FileModuleConfiguration extends BaseModuleConfiguration {
   location?: string;
   parser: Language;
   /** in base 16, hex */
   sha512?: string;
+  /**
+   * Resolved imports, with optional per-import attributes.
+   * Specifier-only entries (the dominant case) serialize as a bare
+   * string for backward compatibility; entries with non-empty
+   * attributes serialize as { specifier, attributes }.
+   */
+  imports?: Record<string, string | { specifier: string; attributes: Record<string, string> }>;
 }
```

The mixed string-or-object value shape is a deliberate forward-
compatibility choice: legacy entries serialized as bare strings stay
that way, and only attribute-bearing entries upgrade to the object
shape.
A v0 reader sees `imports[specifier]: string` everywhere and is none
the wiser; a v1 reader pattern-matches and recovers the attribute
bag where present.

## Test plan

The implementation PR is expected to ship the following test
catalogue, in `packages/compartment-mapper/test/`:

- **Map: parser-emitted attributes round-trip.**
  A package whose source contains
  `import x from './x.json' with { type: 'json' }` produces a
  per-compartment descriptor whose `imports[<spec>]` records the
  attributes bag.
- **Map: `package.json` `withAttributes` companion.**
  A package whose `exports` field carries a `withAttributes`
  companion propagates the attributes to the resolved import record
  and to the descriptor.
- **Map: empty bag omitted.**
  A graph with no attribute-bearing imports produces a compartment-
  map JSON byte-identical to the legacy form (no `attributes` field
  anywhere, no `import-attributes-v1` tag).
- **Link: legacy-collapse vs. extended seating.**
  A compartment with a mix of attribute-free and attribute-bearing
  module entries seats the former through `moduleMap` and the
  latter through `modulesWithAttributes`.
- **Link: two-arg synthetic importHook.**
  The hook returned by `makeImportHook` reports `length === 2` and
  receives the normalized attributes on every invocation.
- **Archive: write + read round-trip.**
  An archive produced from an attribute-bearing graph reads back
  through `importArchive` with the same memo entries the live
  `import` produced.
- **Archive: pre-attributes archive replay.**
  An archive captured by a pre-attributes mapper (fixture committed
  as test data) loads through this design's reader without throwing,
  and its synthetic single-arg `importHook` continues to satisfy
  specifier-only imports.
- **Archive: tag-mismatch diagnostic.**
  An archive with `tags: [..., 'import-attributes-v1']` read by a
  reader without attribute support fails at
  `assertFileCompartmentMap` with the documented error message.
- **JSON contract: bare-string vs. object form.**
  A reader's pattern match on `imports[spec]` returns the right
  shape for each form, and a serializer's choice between forms is
  driven entirely by attribute-bag emptiness.
- **Policy: attribute-passthrough invariant.**
  Per `## Open questions` § 5, this design assumes the policy gate
  keys on specifier alone and that attributes do not affect policy
  evaluation. The implementation test catalogue therefore includes
  one explicit policy-passthrough check: a compartment whose policy
  permits a specifier admits the same specifier under both an empty
  attribute bag and a `with { type: 'json' }` bag (no extra
  per-attribute gate runs). A follow-up design that adds a
  per-attribute policy axis would replace this test with a richer
  one; until then the invariant is the contract.

## Alternatives considered

- **Always serialize the attributes field, even when empty.**
  Rejected for the same SHA-pinned-integrity reason the SES design
  uses: bundles produced from purely-JavaScript graphs must stay
  byte-identical so production archives whose hashes are pinned
  upstream do not regenerate on a no-op mapper upgrade.
- **A new `package.json` condition keyed on attribute values
  (`'with-type-json'` or similar).**
  Rejected for v1: it would conflate the package-author's role
  (which entry point to pick) with the import-site's role (what
  content type to expect).
  See `## Open questions` for the case for revisiting if a concrete
  need emerges.
- **A new top-level compartment-map descriptor field for attribute-
  bearing modules.**
  Rejected: keeping attributes adjacent to the per-import record on
  the existing `imports` field localizes the schema change and lets
  every existing tool (digest, archive, bundle) walk the same shape
  it already does, with one new branch on the value's type.
- **Carry attributes through `resolveHook` as well.**
  Rejected for symmetry with the SES design's
  [`## Resolution and resolveHook`](./ses-import-attributes.md#resolution-and-resolvehook)
  section: resolution does not need attributes and the burden on
  every existing `resolveHook` is not justified by any current use
  case.

## Open questions

1. **`withAttributes` companion-field name on `package.json`.**
   This design proposes `withAttributes` to mirror the
   `with { ... }` clause at the import site.
   Alternatives: `with` (verbatim mirror), `attributes` (mirrors the
   SES API).
   Resolving this needs a brief survey of the TC39 and Node.js
   tracker for any existing convention that other tools already
   honor; if none, the maintainer picks.
2. **Scope of the schema-version sentinel.**
   This design uses a `tags` entry (`'import-attributes-v1'`) to
   signal an archive that requires attribute-aware reading.
   An alternative is a numeric `compartmentMapVersion` field, which
   gives more headroom for future schema changes but is a larger
   schema migration.
   The lightweight tag approach is the design's default; the
   maintainer may prefer the explicit version field if other schema
   changes are queued.
3. **Attribute-aware bundler.**
   `packages/compartment-mapper/src/bundle.js` (and
   `bundle-lite.js`) produce a single-file bundle of the graph for
   environments that cannot eval an archive.
   The bundler's `resolvedImports` shape is the legacy `Record<string,
   string>`.
   Propagating attributes through the bundler is a follow-up; the
   default for v1 is that the bundler rejects any graph that
   contains an attribute-bearing import with a clear "bundler does
   not yet support import attributes" error.
4. **CommonJS interop.**
   CommonJS modules in the graph do not have an import-attributes
   syntactic form (CJS predates the proposal).
   The current contract is that `with` clauses are an ESM-only
   feature and that a CJS `require` of an attribute-bearing module
   is a domain error.
   The design assumes this, but the maintainer may want a more
   explicit story (a CJS `require` falling back to the default
   attribute set, say) before the builder lands the implementation.
5. **Policy: per-attribute allow / deny.**
   `@endo/compartment-mapper`'s policy format (see
   `policy-format.js`) gates which modules a compartment may
   import.
   A per-attribute policy gate (allow a compartment to import a
   module only with `with { type: 'json' }`, say) is plausible but
   not in v1's scope.
   The design assumes the policy gate continues to key on specifier
   alone and attributes do not affect policy-evaluation.

## References

External, Markdown link text:

- [TC39 proposal-import-attributes](https://github.com/tc39/proposal-import-attributes)
  (Stage 4, merged into ECMA-262; the spec this design hosts the
  compartment-mapper-side propagation of).
- [Node.js documentation: import attributes](https://nodejs.org/api/esm.html#import-attributes)
  (the reference implementation the compartment-mapper's behavior
  should aim to mirror for the cases where it does not introduce
  SES-specific divergence).

In-repo, backticked paths:

- `designs/ses-import-attributes.md` (the canonical SES-side design;
  this design picks up where it stops).
- `packages/compartment-mapper/src/link.js`
  (per-compartment `moduleMap` / `modulesWithAttributes` partition,
  two-arg `importHook` wiring).
- `packages/compartment-mapper/src/import-archive-lite.js`
  (`makeArchiveImportHookMaker`; the synthetic two-arg hook).
- `packages/compartment-mapper/src/archive-lite.js`
  (compartment-map JSON serializer; the `imports` field
  serialization).
- `packages/compartment-mapper/src/infer-exports.js`
  (`interpretExports` and `interpretImports`; the
  `withAttributes` companion-field handling).
- `packages/compartment-mapper/src/node-modules.js`
  (the grapher that consumes parser-emitted imports and writes the
  compartment descriptors).
- `packages/compartment-mapper/src/types/compartment-map-schema.ts`
  (the JSON schema; the optional `imports` field shape change).

## Prompt

> Author a sibling design covering compartment-mapper-side
> propagation of import attributes, picking up where the SES-side
> design (`designs/ses-import-attributes.md`) stops.
> Trace how attributes flow from `package.json` exports/imports
> conditions through the resolver and `link.js` to module-record
> construction.
> Include the archive read/write paths and the synthetic-importHook
> construction.
> Out of scope: the SES surface (covered by the sibling design) and
> implementation.
