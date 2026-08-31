# Compartment Mapper Import Attributes

| | |
|---|---|
| **Created** | 2026-05-15 |
| **Updated** | 2026-08-31 |
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

**Landing-order dependency.** This design is a sibling of
[SES Import Attributes](./ses-import-attributes.md) and depends on it;
that design landed on `llm` via PR #248. This document is based on a
revision of `llm` that already includes that design, so every one of
the cross-references below into `ses-import-attributes.md` resolves
against the same base a reviewer or builder reads this design on. That
covers each cited
primitive (`EMPTY_ATTRIBUTES`, the arity rule, `modulesWithAttributes`,
the JSON-tuple memo key) and every section anchor. The design
registry in [`designs/README.md`](./README.md) carries both rows.

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
  field carries the attributes, and how `link.js` routes non-JS
  attribute-bearing records to SES's `modulesWithAttributes` option
  versus the existing `moduleMapHook`/`importHook` path (`moduleMapHook`
  is the per-compartment dynamic linker hook, defined in full in
  `## link.js` below; there is no static `moduleMap` in play in
  `link.js` today).
- The synthetic `importHook` shape inside both `import.js` (live
  node-modules import) and `import-archive-lite.js` (archive replay):
  the hook becomes a two-argument hook so the SES arity rule lets
  it honor non-JS `type` attributes.
- The archive write path: the per-import record gains an optional
  `attributes` field that is omitted when empty so existing archives
  remain byte-identical.
- The archive read path: an archive entry without an `attributes`
  field is read as the SES sentinel `EMPTY_ATTRIBUTES`, and the
  legacy-collapse rule (the bare-string vs. `{ specifier, attributes }`
  serialization defined in full under `## Per-import attribute record in
  the compartment-map descriptor` below) keeps it on the same memo key
  as today.
- The compartment-map JSON schema bump (a new optional field on the
  per-import record), and the backward-compatibility guarantee for
  archives produced by older mapper versions.

Out of scope:

- The SES surface itself: parser, normalization, memo key, `ImportHook`
  signature, `modulesWithAttributes` option.
  All in [SES Import Attributes](./ses-import-attributes.md).
- Any host-defined attribute *semantics* beyond selecting the parser
  the graph already carries.
  The TC39 proposal leaves attribute meaning to the host. This design
  propagates whatever the SES normalization accepts and interprets none
  of it, with one bounded exception that is *selection*, not
  interpretation: it may route an import to a parser the graph already
  registers for that language (for example, a `with { type: 'json' }`
  import to the existing JSON parser). It defines no new attribute keys,
  no new source shapes, and no bespoke decoding of its own; the
  `link.js` and archive-read walkthroughs below stay within this bound.
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
There is exactly **one** mechanism whose identity model cannot
express the companion value: `moduleMapHook` — not a sixth peer hop but
a sub-mechanism *inside* the `link` participant (the per-compartment
dynamic linker hook, defined in full in `## link.js` below), whose
return contract is specifier-keyed by construction (SES sibling §
`## Compartment construction`). It is not a hop that carries the pair
and coerces it to empty; it is a path the pair never reaches, because
attribute-bearing records are seated through `modulesWithAttributes` at
construction time
and never routed through `moduleMapHook` (see case 1 of the three-case
`moduleMapHook` analysis in `## link.js`). The uniform carry rule above
therefore holds for every hop that carries the pair; `moduleMapHook` is
called out here as the sole path inside `link` outside that set, so a
reader does not mistake its specifier-only contract for a silent loss
of a value that was ever threaded to it. Nothing in this paragraph is
needed to follow the five-participant model or the worked examples
below; a first reader may treat it as a forward-referenced caveat that
`## link.js` discharges in detail.

**SES arity rule.** This design leans repeatedly on the SES loader's
hook-arity discriminator (defined in the sibling design's
[`## importHook signature`](./ses-import-attributes.md#importhook-signature)
section). The rule: when a hook (`importHook`, `importNowHook`, the
synthetic archive hook) reports `length === 2`, the SES loader passes
the normalized attribute object on every invocation, including the
empty case; when the hook reports `length === 1`, the loader calls it
specifier-only whenever the attributes are **empty or carry
`{ type: 'js' }`**, and throws only when its own dispatch reaches the
hook with a *non-JS* `type` value (the exception the sibling design's
[`## importHook signature`](./ses-import-attributes.md#importhook-signature)
table spells out: `type: 'js'` is treated the same as the empty case,
because a JS request is exactly what a legacy hook already serves). So
a non-empty attribute bag is not by itself the throw trigger; only a
non-JS content-type request is. The rule is what gives a
v0 caller of `link.js` a soft landing: a `makeImportHook` that still
returns a single-argument hook keeps working for graphs whose imports
are all either unattributed or explicitly `with { type: 'js' }`. Every later
reference to "the arity rule" in this design points back to this
paragraph, and every "empty vs. non-empty" partition in this design
means **JS-serviceable (empty or `type: 'js'`) vs. non-JS** unless it
says otherwise.

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
The new *persisted* field is deliberately named `imports`, distinct
from the existing *in-memory* `resolvedImports` map above; the two are
adjacent concepts (persisted versus execution-side) and are not meant to
be the same field. A future pass may converge the two names once the
bundler (`## Open questions` § 3) also becomes attribute-aware and its
`resolvedImports` shape has to reconcile with this schema field; until
then they stay separate, and this paragraph is the note that says so.
Whether the persisted field should instead take a name that needs no
such disambiguating caveat — so a reader never has to hold two
same-shaped `imports`/`resolvedImports`/`ResolvedImport` concepts apart
by prose alone — is deferred to `## Open questions` § 6, which the
implementation PR must settle before the schema field name is locked.

The extended shape carries the attributes alongside the resolved
specifier. The in-memory record, carried during the map and link legs:

```ts
// In-memory only, during the map and link legs.
type ResolvedImport = {
  specifier: string;
  attributes?: Record<string, string>; // undefined === EMPTY_ATTRIBUTES
};

type ResolvedImports = Record<string /* import specifier */, ResolvedImport>;
```

**One canonical persisted form.**
`ResolvedImport` has exactly one serialized shape, the same union that
`## Compartment-map JSON schema` records for the `imports` field, so
the two sections describe one value, not two competing wire shapes:

```ts
// Persisted (JSON) form of a single resolved import.
type PersistedImport =
  | string // legacy collapse: an attribute-free resolved specifier
  | { specifier: string; attributes: Record<string, string> };
```

The map from `ResolvedImport` to `PersistedImport` is total and lives
in exactly one place, the serializer:

- An attribute-free import (`attributes` absent, that is
  `EMPTY_ATTRIBUTES`) serializes as the **bare resolved-specifier
  string**, never as `{ specifier }` and never as
  `{ specifier, attributes: {} }`. A reader recovering a bare string
  reconstructs `EMPTY_ATTRIBUTES` for it, matching the SES sentinel.
- An attribute-bearing import serializes as the object arm, whose
  `attributes` bag is non-empty by construction (the empty bag never
  reaches the object arm).

Byte-identity for legacy graphs falls out of this one rule at two
scales: a compartment with **no** attribute-bearing import omits the
`imports` field entirely (so a purely-JavaScript archive is
byte-identical to today's, which records no `imports` field at all),
and within a *mixed* compartment that does carry the field, each
attribute-free sibling is a bare string identical to how a
specifier-only entry would otherwise read. The union is therefore
observed only inside a compartment that already contains at least one
attribute-bearing import; that is the single case the `## Test plan`'s
"JSON contract: bare-string vs. object form" entry exercises.

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
what content type it expects.
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

**Structural distinctness of the companion key.**
The worked example places `withAttributes` as a bare sibling of genuine
condition names (`import`, `require`, `browser`, ...) inside the same
object, and nothing in the JSON *syntax* marks it as a different kind of
thing — a generic third-party walker (a publint-style linter, a bundler
enumerating "conditions this entry supports") cannot tell metadata from
condition without hardcoded knowledge of this one key. That is a real
surface-coherence cost, and it deserves an explicit accounting rather
than a silent overload, because the compartment-map already carries one
cautionary precedent for repurposing an author-controlled string space
(see `## Archive write path` on the `tags` field).

The bare-sibling placement is not a careless choice, though: it is the
**only** shape that stays backward-compatible with stock Node.js
resolution, which is the `## References` "mirror Node.js" aim. Node
resolves a subpath by matching conditions and *ignores any condition
key it does not recognize*, so a bare sibling named `withAttributes`
is silently skipped by Node while the real `import`/`require` target
still resolves. Every structurally-distinct alternative that would mark
the key as non-condition breaks that property: moving the attributes to
the **value** side (`"import": { "$target": "./src/policy.json",
"$attributes": {...} }`) makes Node read the value as a *nested
conditions object* and try to match `$target`/`$attributes` as
conditions, none of which match, so Node resolution fails outright — a
strictly worse outcome than a harmlessly-ignored sibling. Conditions
are open-ended, host/package-declared strings, so there is likewise no
prefix or namespace that is *guaranteed* collision-free.

Given that tension, this design's contract is: (a) the grapher
**reserves** the exact companion key — a `package.json` that needs a
user-defined *condition* literally named `withAttributes` is
unsupported, and the map leg should surface that collision as a lint
error rather than silently reinterpret it; (b) the chosen spelling
should be as unlike a plausible runtime condition as possible (the
`withAttributes`/`with`/`attributes` candidates in `## Open questions`
§ 1 all read as metadata, not as a build target or platform); and
(c) the placement-and-collision-safety question — not just the *name* —
is itself carried as an open decision in `## Open questions` § 1, so the
maintainer chooses the reservation-plus-lint contract deliberately
rather than inheriting it by omission.

**Precedence when both surfaces speak.**
Two independent surfaces can now declare attributes for the same
import: the import site's own `with { ... }` clause and the
package-declared `withAttributes` companion on the matched
`exports`/`imports` entry. The rule is **whole-value, presence-based
override**:

- When the import site supplies **no** `with` clause, the
  package-declared `withAttributes` record is the attribute value in
  full (the worked example above).
- When the import site supplies **any** `with` clause, that whole
  record is the attribute value and the package-declared
  `withAttributes` is discarded entirely — not merged key-by-key. A
  caller who writes `with { type: 'text' }` against a package entry that
  declares `withAttributes: { type: 'json', encoding: 'utf8' }` gets
  exactly `{ type: 'text' }`, and does **not** silently inherit an
  `encoding` key it never wrote.

The design deliberately does **not** do a per-key merge of the two
records. A per-key merge would let the effective attribute bag combine
a key the import site wrote with a key only the package author wrote,
producing a combination *neither party authored* — and that breaks the
independence the section opened by asserting (condition dimension vs.
attribute dimension). Whole-value override keeps every effective
attribute bag traceable to exactly one author, and it matches how a
caller's explicit choice already beats a package default everywhere else
in `package.json` resolution: all-or-nothing whole-entry selection, not
a novel field-by-field blend with no analogue in the existing
`exports` machinery. The v1 need this design names is single-key bags
(`{ type: 'json' }`), which whole-value override serves completely; if a
concrete multi-key case later needs one author to inherit a second
author's field, that is a deliberate future widening (`## Open
questions` § 6), not something to generalize into ahead of a motivating
case. This is not left open; it is fixed here as whole-value override
and exercised by a dedicated `## Test plan` conflict case.

`withAttributes` is thus a *default* layer, never a partial override:
the more specific, caller-supplied record wins whole when present, the
package default applies whole when the caller is silent.

**`withAttributes` scope across sibling conditions.**
A subpath entry may carry several condition branches (`import`,
`require`, `browser`, user-defined) that resolve to different files.
`withAttributes` is a non-condition sibling key that applies
**uniformly to whichever condition wins** for that subpath entry; it
is not itself a condition and does not vary per branch. A package that
needs different attributes per condition splits the subpath into
separate entries. This preserves the existing `exports` mental model:
every *condition* sibling is still a mutually-exclusive alternative,
and `withAttributes` is one default layered over the winner.

This is the minimum surface the package author needs to ship a
content-typed export today without forcing every caller to spell out
the attribute at the import site.
Note that `withAttributes` is **new ground**: it has no TC39 or
Node.js precedent. Node.js honors the import-site `with` clause but has
no package-declared default-attribute surface; the `## References`
"mirror Node.js" aim covers the import-site `with` semantics, not this
companion field, which this design invents. `## Open questions` § 1
litigates only its *name* (alternatives include `with`, mirroring the
syntax, and `attributes`, mirroring the SES API); that a package may
declare default import attributes at all is a deliberate new surface
this design proposes, not inherited prior art.

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
Today (`packages/compartment-mapper/src/link.js` § `link`, the sole
`new Compartment(...)` call site):

- The linker iterates compartment descriptors and, for each, builds a
  single per-compartment `moduleMapHook` via `makeModuleMapHook`
  (closed over `compartmentDescriptor` and its `modules` descriptor).
  It supplies **only** that hook, in
  `new Compartment({ moduleMapHook, importHook, importNowHook, ... })`;
  there is no static `moduleMap` construction option in play today.
  The hook returns a specifier-keyed module record for a
  cross-compartment alias and `undefined` for a specifier the
  compartment should resolve through its own `importHook`.

  **Correction of the sibling design.** This is a deliberate correction
  of the landed sibling [SES Import Attributes](./ses-import-attributes.md),
  whose `## Compartment-mapper implications` section states `link.js`
  "populates `moduleMap` and (in the new world) `modulesWithAttributes`"
  and routes attribute-free records "through `modulesWithAttributes`
  instead of `moduleMap`" — describing a *static* `moduleMap`
  construction path. No such path exists: `link.js`'s sole
  `new Compartment(...)` call supplies `moduleMapHook` (the dynamic
  hook), never a static `moduleMap` option (verified against
  `packages/compartment-mapper/src/link.js` on this design's base). This
  distinction is load-bearing here — the whole `modulesWithAttributes`
  vs. `moduleMapHook` partition below turns on it — so this design
  corrects the sibling's characterization explicitly rather than
  superseding it silently. The sibling document should be edited to say
  `moduleMapHook`; that fix is a follow-up on `ses-import-attributes.md`,
  out of scope for this PR's diff.
- Each compartment's `importHook` is built by `makeImportHook` (from
  the caller's `LinkOptions`), a single-argument hook keyed on
  specifier alone.

Under this design:

- The linker inspects each per-compartment module descriptor's import
  record and seats the ones the arity rule cannot serve legacy-style
  (the non-JS attribute-bearing records, that is everything other than
  empty or `{ type: 'js' }` per the corrected arity rule above)
  through the new `modulesWithAttributes` construction option from the
  SES sibling design. Every other entry (unattributed or explicitly
  `with { type: 'js' }`) is served exactly as today: through the
  existing dynamic `moduleMapHook` and, on fall-through, the
  compartment's `importHook`. No new static `moduleMap` is introduced;
  "legacy-collapse slot" throughout this design names this unchanged
  hook path, not a static map.
- `makeImportHook` is invoked at the same site, but the returned hook
  is two-argument (`(specifier, attributes) => ...`).
  The hook honors the SES arity rule: a hook with `length` 2 receives
  the normalized attribute object on every call, including the empty
  case.
- The synthetic hook dispatches on `(specifier, attributes)`.
  For a `with { type: 'json' }` import, the hook *selects* the JSON
  parser the graph already registers (the same parser today's
  specifier-only path reaches for a `.json` module) rather than
  implementing any bespoke decoding of its own; the resulting record
  binds the parsed value to `default` per the SES design's
  [`## Source dispatch`](./ses-import-attributes.md#source-dispatch)
  section. This is parser *selection* keyed on the attribute, staying
  inside the bound that `## Scope and non-goals` draws: the hook interprets
  no attribute semantics beyond choosing among the parsers the graph
  already carries.

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
   the primed entry, and does not consult `moduleMapHook` for
   that `(specifier, attributes)` pair. The same specifier with the
   empty attribute bag continues to flow through `moduleMapHook`
   under the legacy-collapse rule.
2. *A `moduleMapHook` record whose underlying source carries
   parser-emitted attributes.*
   `moduleMapHook`'s return shape is specifier-keyed by contract
   ([SES sibling](./ses-import-attributes.md#compartment-construction-priming-attribute-bearing-modules))
   so it cannot itself surface an attribute bag. The linker treats
   any record returned by `moduleMapHook` as if its caller-side
   attribute set were empty; the hook's job remains specifier-keyed
   substitution, not attribute-aware dispatch. A compartment that
   wants attribute-aware dynamic substitution uses
   `modulesWithAttributes` at construction time, or implements the
   dispatch inside its `importHook` (the two-argument one).
3. *Attribute-free import whose specifier is not in
   `modulesWithAttributes`.*
   Unchanged from today: `moduleMapHook` is consulted, then the
   compartment falls through to the two-argument `importHook` with an
   empty attribute bag. The arity rule keeps the empty-bag case
   indistinguishable from today's specifier-only call from the
   `importHook`'s point of view (a v0 single-argument hook still
   satisfies the call).

Concrete touchpoints in `link.js`:

| Site                                | Change                                                                                                              |
|-------------------------------------|---------------------------------------------------------------------------------------------------------------------|
| `makeModuleMapHook`                 | Unchanged. Continues to return a single-argument specifier-keyed hook.                                              |
| `link` body, per-compartment loop   | Partition the `modules` record: non-JS attribute-bearing entries go to a new `modulesWithAttributes` seat; every other entry stays on the unchanged `moduleMapHook`/`importHook` path.  |
| `importHook` construction call      | The caller's `makeImportHook` becomes a factory for a two-argument hook (see *Implications for callers* below).     |
| `new Compartment({ ... })` call     | Add a `modulesWithAttributes` option (alongside the existing `moduleMapHook`) when the partition produced non-JS attribute-bearing entries; otherwise the call is byte-for-byte today's for parity.   |

The partition step is mechanical: walk
`compartmentDescriptor.modules`, look at each entry's
`attributes` field, and send the entry to `modulesWithAttributes` only
when it carries a non-JS `type` (per the arity rule, everything other
than empty or `{ type: 'js' }`); otherwise leave it on the existing
hook path untouched.
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
hook continues to work for graphs whose imports are all
JS-serviceable (unattributed or explicitly `with { type: 'js' }`);
every such import stays in the legacy-collapse slot, the legacy
single-argument hook suffices, and SES does not throw the arity
*TypeError*.
A migration-aware caller updates its hook to the two-argument shape
to gain the ability to serve attribute-bearing imports.

`makeImportNowHook` (the synchronous counterpart used for `require`-
style call sites) gets the same widening.

**Live-path upgrade diagnostic (symmetric with the archive path).**
The soft landing above is only soft when every import in the graph is
JS-serviceable (unattributed or `with { type: 'js' }`). An explicit
`with { type: 'js' }` import is non-empty yet still served
specifier-only by the arity rule, so it does **not** trip this
diagnostic; only a *non-JS* attribute type does. When a v0 caller's
single-argument `makeImportHook` meets a graph that carries a non-JS
attribute-bearing import, the naive outcome is SES's internal arity
`TypeError`, a low-level, illegible failure.

This design requires `link.js` to detect that combination up front and
fail with a compartment-mapper-level diagnostic instead. The detection
condition is: the partition step (below) seated at least one entry into
`modulesWithAttributes` — which per the partition rule happens only for
a non-JS attribute type — while the caller's hook reports
`length === 1`. The diagnostic reads "this graph uses import
attributes; upgrade `makeImportHook` to accept
`(specifier, attributes)`", the live-path mirror of the archive read
path's `assertFileCompartmentMap` upgrade message. The two
backward-incompatible paths (live link, archive read) thus surface the
same class of failure with the same legibility rather than leaving the
live path to a raw SES `TypeError`.

**Coverage boundary: statically-discoverable imports only.** This
up-front diagnostic is *not* total, and the symmetry claim above is
bounded to the statically-discoverable graph. The partition walks
`compartmentDescriptor.modules`, which is populated from the import
records `@endo/module-source` records *statically* — the parser records
a dynamic import only as `dynamicImport.present: boolean`
(`packages/module-source/src/source-options.js`), never an enumerated
list of dynamic specifiers. A dynamic
`import(computedSpecifier, { with: { type: 'json' } })` whose specifier
is not a literal is therefore invisible to the map/link static walk: it
cannot be seated into `modulesWithAttributes` and cannot raise the
up-front diagnostic. A v0 single-argument hook that reaches such a call
at runtime still hits the raw SES arity `TypeError`. This design does
**not** claim to eliminate that case; the `link.js`-level diagnostic
covers the statically-discoverable graph (the same boundary every other
map-leg guarantee in this design draws), and the raw-`TypeError` floor
remains for computed-specifier dynamic imports. The `## Test plan`
covers both the statically-discoverable diagnostic and, as an explicit
negative, the dynamic-specifier gap.

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
2. **Compartment-map schema version marker (a dedicated field, not a
   `tags` entry).**
   Earlier drafts of this design signaled the attribute-aware format by
   appending a sentinel string (`'import-attributes-v1'`) to the
   top-level `tags` array. That is rejected. `tags` is **not** a
   free-form metadata slot: `node-modules.js` and `compartment-map.js`
   both populate it as the literal package.json export/import
   **condition set** used to build the map (`tags: [...conditions]` at
   `packages/compartment-mapper/src/node-modules.js:1085-1087`,
   `tags: conditions` at
   `packages/compartment-mapper/src/compartment-map.js:800-801`), and
   both carry an active `// TODO graceful migration from tags to
   conditions` comment pointing at
   [endojs/endo#2388](https://github.com/endojs/endo/issues/2388).
   Conditions are open-ended, host/package-declared strings, so
   injecting a magic `'import-attributes-v1'` string into that array
   both risks a genuine collision with a real condition name and
   compounds the scope of the in-flight #2388 rename (which would then
   have to special-case the sentinel). Overloading `tags` is exactly the
   author-controlled-string-space repurposing the `withAttributes`
   companion above also had to avoid.
   Instead, this design adds a **dedicated** optional top-level schema
   field for the version marker — `importAttributes?: 'v1'` on the
   top-level compartment-map schema in
   `packages/compartment-mapper/src/types/compartment-map-schema.ts`,
   net-new and orthogonal to `tags`. The field is written (value `'v1'`)
   when the archive contains a *non-JS* attribute-bearing import — the
   same partition boundary the arity rule and the live-path diagnostic
   use — and omitted entirely otherwise. An explicit `with { type: 'js' }`
   import writes its per-import attributes field (so a v1 reader recovers
   the memo-distinct key) but does **not** set the marker, because a
   legacy reader can serve those sealed bytes as JavaScript exactly as it
   serves an unattributed import; only a non-JS content type is something
   an old reader genuinely cannot honor.
   An archive whose graph is purely JavaScript-serviceable omits the
   field, so its `tags` and its whole top-level object stay byte-identical
   to today's. The marker lets readers fail clearly on a content type
   they cannot honor instead of silently mis-loading it as code.
   (`## Open questions` § 2 carries the marker's *shape* — a dedicated
   `'v1'` string vs. a numeric `compartmentMapVersion` — as an open
   decision; what is fixed here is only that it is a dedicated field, not
   a `tags` entry.)

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
  raises a *deferred error* (an error object returned in place of a
  module source and thrown at first use, rather than at load time)
  rather than silently falling through.

Backward compatibility on the read side:

- An archive without the `importAttributes` marker field reads under a
  legacy single-argument hook. This covers both a purely-JavaScript
  graph (no `attributes` fields at all) and a graph whose only
  attributes are `with { type: 'js' }`: the latter carries per-import
  `attributes` fields but no marker, so an older reader ignores the
  unknown field and serves those sealed bytes as JavaScript (exactly
  what the arity rule permits), while a v1 reader recovers the
  memo-distinct key. In neither case does the SES arity rule reject the
  synthetic single-argument hook.
- An archive with the marker (which fires only for a *non-JS*
  attribute-bearing import) read by an older mapper version (no
  `attributes` support in the reader) fails fast at the
  `assertFileCompartmentMap` step with a clear "this archive uses
  import attributes, please upgrade `@endo/compartment-mapper`"
  diagnostic rather than silently mis-loading a non-JS module as code.

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
The value type here is exactly the `PersistedImport` union defined in
`## Per-import attribute record in the compartment-map descriptor`;
this section and that one describe one canonical wire shape, not two:

```diff
 export interface FileModuleConfiguration extends BaseModuleConfiguration {
   location?: string;
   parser: Language;
   /** in base 16, hex */
   sha512?: string;
+  /**
+   * Resolved imports (the persisted `PersistedImport` union), with
+   * optional per-import attributes.
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
A v0 reader sees `imports[specifier]: string` everywhere and needs no
special handling; a v1 reader pattern-matches and recovers the
attribute bag where present.

## Test plan

The implementation PR is expected to ship the following test
catalogue, in `packages/compartment-mapper/test/`:

- **Map: parser-emitted attributes round-trip.**
  A package whose source contains
  `import x from './x.json' with { type: 'json' }` produces a
  per-compartment descriptor whose `imports[<spec>]` records the
  attributes bag.
- **Map: `package.json` `exports` `withAttributes` companion.**
  A package whose `exports` field carries a `withAttributes`
  companion propagates the attributes to the resolved import record
  and to the descriptor.
- **Map: `package.json` `imports` (`#specifier`) `withAttributes`
  companion.**
  Per `## infer-exports.js and package.json conditions` (which claims
  `interpretImports` gets the same companion-field handling as
  `interpretExports`), a package whose `imports` field maps a
  `#`-specifier subpath with a `withAttributes` companion propagates
  the attributes from the `#name` to the resolved internal specifier,
  exactly as the `exports` walker does. This exercises the second
  package.json surface the companion-field claim covers, not only the
  `exports` surface.
- **Map: import-site vs. `withAttributes` precedence (whole-value
  override).**
  Per `## infer-exports.js and package.json conditions`, an import
  site's own `with { type: 'text' }` clause overrides a package entry
  that declares `withAttributes: { type: 'json', encoding: 'utf8' }`
  for the same subpath: the effective attribute bag is exactly
  `{ type: 'text' }` and the caller does **not** inherit `encoding`
  from the discarded package default (whole-value override, not a
  per-key merge). A second case with the import site silent confirms the
  package default applies whole.
- **Map: empty bag omitted.**
  A graph with no attribute-bearing imports produces a compartment-
  map JSON byte-identical to the legacy form (no `attributes` field
  anywhere, no `importAttributes` marker field, and `tags` unchanged).
- **Link: legacy-collapse vs. extended seating.**
  A compartment with a mix of JS-serviceable entries (attribute-free
  or `with { type: 'js' }`) and non-JS attribute-bearing entries keeps
  the former on the existing `moduleMapHook`/`importHook` path and
  seats only the latter through `modulesWithAttributes`. A
  `with { type: 'js' }`-only compartment produces no
  `modulesWithAttributes` seat.
- **Link: `modulesWithAttributes` beats `moduleMapHook` for the same
  specifier.**
  Per case 1 of the three-case `moduleMapHook` analysis, a specifier
  that is both attribute-bearing and seated through `moduleMapHook`
  resolves the primed `modulesWithAttributes` entry and never consults
  `moduleMapHook` for that `(specifier, attributes)` pair, while the
  same specifier with an empty attribute bag still flows through
  `moduleMapHook`.
- **Link: single-argument hook meets non-JS attribute-bearing graph.**
  Per `## Implications for callers of link.js`, a v0 caller whose
  `makeImportHook` returns a single-argument hook, linking a graph
  that contains a *non-JS* attribute-bearing import (for example
  `with { type: 'json' }`), fails with the compartment-mapper-level
  upgrade diagnostic (not a raw SES arity `TypeError`). The companion
  case (the same v0 hook against a graph whose only attributed import
  is `with { type: 'js' }`) links cleanly with no diagnostic, since
  the arity rule serves that import specifier-only.
- **Link: two-argument synthetic importHook.**
  The hook returned by `makeImportHook` reports `length === 2` and
  receives the normalized attributes on every invocation.
- **Link: dynamic computed-specifier attribute import is not
  statically diagnosed.**
  Per `## Implications for callers of link.js` § "Coverage boundary", a
  v0 single-argument hook linking a graph whose *only* attribute-bearing
  import is a dynamic `import(computedSpecifier, { with: { type: 'json' } })`
  with a non-literal specifier links **without** the up-front
  compartment-mapper diagnostic (the static walk cannot see it), and the
  failure surfaces only as the raw SES arity `TypeError` when the dynamic
  call executes. This is the explicit negative that bounds the live-path
  symmetry claim to the statically-discoverable graph.
- **Archive: write + read round-trip.**
  An archive produced from an attribute-bearing graph reads back
  through `importArchive` with the same memo entries the live
  `import` produced.
- **Archive: pre-attributes archive replay.**
  An archive captured by a pre-attributes mapper (fixture committed
  as test data) loads through this design's reader without throwing,
  and its synthetic single-argument `importHook` continues to satisfy
  specifier-only imports.
- **Archive: marker-mismatch diagnostic.**
  An archive with `importAttributes: 'v1'` read by a
  reader without attribute support fails at
  `assertFileCompartmentMap` with the documented error message.
- **Archive: `type: 'js'` carries no marker.**
  An archive whose only attributed import is `with { type: 'js' }`
  writes per-import `attributes` fields (so a v1 reader recovers the
  memo-distinct key) but emits **no** `importAttributes` marker field, so
  a pre-attributes reader loads it without the `assertFileCompartmentMap`
  fail-fast and serves the sealed bytes as JavaScript, the read-side
  mirror of the live-path companion case above.
- **JSON contract: bare-string vs. object form.**
  A reader's pattern match on `imports[spec]` returns the right
  shape for each form, and a serializer's choice between forms is
  driven entirely by attribute-bag emptiness.
- **Policy: attribute-passthrough invariant.**
  This design keys the policy gate on specifier alone, even though it
  widens the memo/dispatch identity everywhere else from `specifier` to
  the `(specifier, attributes)` tuple. The two are reconciled by the
  `## Scope and non-goals` bound, not by luck: attributes here select
  only among parsers the graph *already registers*, so an attribute can
  never conjure a module the specifier-keyed graph did not already
  contain; the set of things policy could admit is unchanged by the
  identity widening, so the specifier-only gate remains complete by
  construction under the v1 scope bound. `## Open questions` § 5 leaves
  open whether a *future* design adds a per-attribute policy axis; that
  is a widening of the scope bound, not a gap in this invariant. The
  implementation test catalogue therefore includes one explicit
  policy-passthrough check: a compartment whose policy permits a
  specifier admits the same specifier under both an empty attribute bag
  and a `with { type: 'json' }` bag (no extra per-attribute gate runs).
  A follow-up design that adds a per-attribute policy axis would replace
  this test with a richer one; until then the invariant is the contract.
- **Bundler: attribute-bearing graph rejected.**
  Per `## Open questions` § 3, `bundle.js` / `bundle-lite.js` reject a
  graph that contains any attribute-bearing import with the clear
  "bundler does not yet support import attributes" error rather than
  silently dropping the attributes.
- **CommonJS: `require` of an attribute-bearing module is a domain
  error.**
  Per `## Open questions` § 4, a CJS `require` reaching an
  attribute-bearing module raises the documented domain error rather
  than silently ignoring the attributes.

## Alternatives considered

- **Always serialize the attributes field, even when empty.**
  Rejected for the same *SHA-pinned archive integrity* reason the SES
  design uses: bundles produced from purely-JavaScript graphs must stay
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

1. **`withAttributes` companion-field name *and placement* on
   `package.json`.**
   This design proposes `withAttributes` to mirror the
   `with { ... }` clause at the import site.
   Alternatives for the *name*: `with` (verbatim mirror), `attributes`
   (mirrors the SES API).
   Beyond the name, the *placement* is also open: the companion sits as
   a bare sibling of condition names, which stock Node.js resolution
   ignores harmlessly (the property that keeps it Node-compatible) but
   which a generic condition-walking tool cannot distinguish from a real
   condition (see `## infer-exports.js and package.json conditions` §
   "Structural distinctness of the companion key"). Because conditions
   are open-ended author-declared strings, no bare key is
   collision-proof; the design's contract is a **reserved key plus a
   map-leg lint** on a package that declares a user condition of the
   same name. The maintainer decides both the spelling and whether the
   reservation-plus-lint contract is acceptable, or whether a stronger
   structural marking is worth breaking Node-ignore compatibility for.
   Resolving the name needs a brief survey of the TC39 and Node.js
   tracker for any existing convention that other tools already
   honor; if none, the maintainer picks.
2. **Shape of the schema-version marker (a dedicated field either way).**
   This design signals an archive that requires attribute-aware reading
   with a **dedicated top-level field**, `importAttributes: 'v1'` — not
   a `tags` entry, because `tags` already holds the package.json
   condition set and is mid-migration under
   [endojs/endo#2388](https://github.com/endojs/endo/issues/2388) (see
   `## Archive write path`). What remains open is only the field's
   *shape*: a dedicated `'v1'` string versus a numeric
   `compartmentMapVersion` field, which gives more headroom for future
   schema changes but is a larger schema migration. The lightweight
   dedicated-string marker is the design's default; the maintainer may
   prefer the explicit numeric version field if other schema changes are
   queued. Overloading `tags` is off the table regardless.
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
   alone and attributes do not affect policy evaluation.
6. **Persisted-field naming convergence and multi-key merge.**
   Two deferred decisions the implementation PR must settle before it
   locks the schema in:
   (a) The persisted per-import field is named `imports`, one letter and
   one shape away from the pre-existing in-memory `resolvedImports` map
   (`ResolvedImport`/`resolvedImports`/`PersistedImport` all coexist).
   This design keeps them separate and disambiguates by prose (see
   `## Per-import attribute record in the compartment-map descriptor`),
   but whether the persisted field should instead take a name that needs
   no such caveat — or whether the two concepts should converge once the
   bundler (§ 3) also becomes attribute-aware — is left to the
   implementation PR, which owns the final schema field name.
   (b) The `withAttributes`-vs-import-site precedence rule is fixed as
   **whole-value override** (see `## infer-exports.js and package.json
   conditions` § "Precedence when both surfaces speak"), which serves
   the v1 single-key bag need completely. If a concrete case later needs
   one author to inherit a *second* author's individual attribute key,
   introducing a field-level merge is a deliberate future widening to be
   motivated by that case — not generalized into pre-emptively here.

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
  (per-compartment `moduleMapHook`/`importHook` vs.
  `modulesWithAttributes` partition, two-argument `importHook` wiring).
- `packages/compartment-mapper/src/import-archive-lite.js`
  (`makeArchiveImportHookMaker`; the synthetic two-argument hook).
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
