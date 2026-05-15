# SES Import Attributes

| | |
|---|---|
| **Created** | 2026-05-14 |
| **Updated** | 2026-05-15 |
| **Author** | Kris Kowal (prompted) |
| **Status** | Draft |

## Problem statement

JavaScript's [import attributes](https://github.com/tc39/proposal-import-attributes)
proposal (Stage 4, merged into ECMA-262) extends every static and dynamic
import with an options bag carried through a `with` clause:

```js
import data from './data.json' with { type: 'json' };
const data = await import('./data.json', { with: { type: 'json' } });
```

The attributes are normalized, participate in the host's module-map cache key,
and reach the host's module loader so a single specifier can resolve to
different module sources based on its declared type.
The companion [JSON modules](https://github.com/tc39/proposal-json-modules)
proposal (also Stage 4) defines the first source-type variant: a module whose
body is a JSON document and whose default export is the parsed value.

SES's `Compartment` exposes the closest shim-side analogue of the host module
loader through `importHook(specifier)` and the `ModuleSource` shape produced
by `@endo/module-source`.
Today neither carries attributes.
Specifically:

- The static analyzer in `@endo/module-source` records imported specifiers as
  bare strings, not specifier+attributes tuples.
- The runtime in `packages/ses/src/module-load.js` resolves and memoizes
  modules by `(compartment, full-specifier)`.
- `importHook` and `importNowHook` take a single specifier and return a
  module descriptor; the dispatch on source type happens entirely on the
  hook implementer's side without participating in the memo.

This design extends the analyzer, the memo, and the hooks so SES can carry
`with { ... }` clauses to the host's loader.
SES already exposes a virtual-module-source surface
(`VirtualModuleSource` in `packages/ses/src/module-link.js`), and that
surface is sufficient for hosts that want to serve JSON, CSS, Wasm, or
any other content-typed module: the hook reads bytes, parses, and
returns a virtual source whose `execute` binds the parsed value to
`default`.
This design therefore does not introduce a JSON-specific source variant.
The `ModuleSource` shapes (`PrecompiledModuleSource`, `VirtualModuleSource`)
stay as they are today; the import-attributes work threads attributes
through to the existing hook surface, which a host implementation can use
to dispatch to a virtual-source response.

## Scope and non-goals

In scope for v1:

- Capturing the `with { ... }` clause on static and dynamic imports through
  `@endo/module-source`.
- A canonical normalization for the attributes bag.
- Extending SES's module memo key to include normalized attributes.
- An augmented `importHook` / `importNowHook` signature that receives
  attributes, with explicit backward compatibility for single-argument hooks.
- A new compartment-construction option (`modulesWithAttributes`) for
  priming memo entries with non-default attributes.
- Backward compatibility for archive bundles produced before attributes
  existed.

Out of scope (already served by virtual module sources, or deferred to
follow-up designs):

- JSON modules (`with { type: 'json' }`), CSS modules
  (`with { type: 'css' }`), and WebAssembly modules
  (`with { type: 'wasm' }`).
  A host's `importHook` already returns a `VirtualModuleSource` whose
  `execute` binds parsed JSON, a `CSSStyleSheet`, or Wasm instance
  bindings to `default`.
  Standardizing per-type source variants in `@endo/module-source` is a
  separate question that this design does not need to answer.
- Any host-defined attribute key beyond `type`.
  The spec leaves these to the host; SES intentionally normalizes them but
  does not interpret them.
- The compartment-mapper-side propagation of attributes through
  `package.json` resolution.
  This design walks the surfaces of `@endo/compartment-mapper` that the
  shim-side work touches (see `## Compartment-mapper implications`),
  but the per-`package.json` propagation is deferred.

## Normalized attribute representation

The TC39 spec leaves the precise normalization to the host but constrains its
shape: attribute keys are string identifiers or string literals, attribute
values are string literals, and the host's cache key includes the normalized
attributes so that the same `(referrer, specifier)` with different attributes
produces different module instances.

SES's normalization rule, applied wherever attributes enter the system
(parser, hook return values, compartment `moduleMap` entries):

1. **Clone, then freeze.** The wire shape is
   `{ [key: string]: string }` with `__proto__: null`, all values
   primitive strings.
   The normalizer never mutates the input; it builds a fresh
   null-prototype object, copies validated key / value pairs into it,
   and `harden`s the result.
   The original options bag the caller passed remains unmodified.
   `undefined` and `null` values are rejected.
   Non-string values are rejected.
2. **Reject duplicate keys at parse time.** Per the spec, two attributes with
   the same key in one `with` clause is a *SyntaxError*.
   The analyzer enforces this; runtime adapters trust it.
3. **Sort keys lexicographically (UTF-16 code unit order).**
   The fresh object's keys are written in sorted order, making object
   identity irrelevant to the downstream memo key.
4. **Canonicalize the empty case to a single sentinel.**
   Imports without a `with` clause carry the frozen empty
   `{ __proto__: null }` value exported as `EMPTY_ATTRIBUTES` from
   `@endo/module-source`.
   Returning a single shared sentinel for the dominant empty case
   avoids per-import allocation; non-empty inputs always yield a fresh
   frozen clone.
   The memo key collapses to the legacy specifier-only shape when this
   sentinel is present (see Backward compatibility for serialized bundles).
5. **Serialize for use in the extended memo key as `JSON.stringify`
   over a `[fullSpecifier, attributes]` tuple.**
   The serialization is what enters the `Map<string, ...>` memo, not
   the object itself: two distinct object instances with the same
   normalized content collapse to the same key.
   See `## Memo key extension` for the encoding.

The normalization function lives in `@endo/module-source` as
`normalizeImportAttributes(attributes)` and is re-exported from `ses` for the
small number of consumers (notably `compartment-mapper`'s `link.js`) that
construct attributes on the fly.

## Memo key extension

SES's per-compartment module memo currently keys on a bare
`Map<fullSpecifier, ModuleRecord>` (`packages/ses/src/compartment.js`,
the `moduleRecords` map, populated throughout
`packages/ses/src/module-load.js`).
Today, the key for `import x from './a.js'` is the resolved string
`'./a.js'` directly.

The extended key is the JSON-stringification of a two-element tuple:

```
JSON.stringify([fullSpecifier, normalizedAttributes])
```

Both halves are JSON-stringified, so the key is unambiguous for any
specifier the host accepts.
An earlier draft picked `U+0000` as a separator on the assumption that
NUL cannot appear in a module specifier; the import-attributes spec
does not forbid NUL in specifiers, so the unambiguous embedding has to
come from the encoding itself.
JSON encodes string contents (escaping `"`, `\`, control characters,
and NUL), so two distinct (specifier, attributes) tuples cannot
collide on serialization.

Legacy collapse rule.
When the normalized attributes are empty (the `EMPTY_ATTRIBUTES`
sentinel), the memo continues to use the bare `fullSpecifier` string
as the key.
The legacy and extended keys live in the same `Map` keyed by string;
the legacy form is the bare specifier, the extended form is the
two-element JSON tuple.
The two forms cannot collide because the extended form always begins
with `[` and a bare specifier never does.
This keeps the hot path (modules with no attributes) on the same key
shape as today, so pre-attributes bundles thread through without
re-keying.

Worked example.
A compartment imports the same specifier two ways:

```js
import a   from './doc.json';                          // no `with` clause
import b   from './doc.json' with { type: 'json' };
import c   from './doc.json' with { type: 'css'  };
```

After resolution against the compartment's `resolveHook`, all three
produce `fullSpecifier = './doc.json'`.
The memo entries are:

| Memo key                                          | Form                 |
|---------------------------------------------------|----------------------|
| `./doc.json`                                      | legacy collapse      |
| `["./doc.json",{"type":"json"}]`                  | extended (JSON tuple)|
| `["./doc.json",{"type":"css"}]`                   | extended (JSON tuple)|

The unattributed import lands in the legacy-collapse slot and is
distinct from either typed import.
This is the spec's behavior: an unattributed import and a
`with { type: 'js' }` import are *not* the same module, because the
host is allowed to pick different bytes for them.

Implication for parent-module caches.
`moduleRecord.resolvedImports` today is a `Record<importSpecifier,
fullSpecifier>`.
It becomes
`Record<importSpecifier, { specifier: string, attributes: Attributes }>`
so the link step can recover the exact key when it dereferences a
dependency.

## importHook signature

The current type, from `packages/ses/types.d.ts`:

```ts
export type ImportHook = (moduleSpecifier: string) =>
  Promise<ModuleDescriptor>;
export type ImportNowHook = (moduleSpecifier: string) =>
  ModuleDescriptor | undefined;
```

The augmented type:

```ts
export type ImportHook = (
  moduleSpecifier: string,
  attributes?: Attributes,
) => Promise<ModuleDescriptor>;
export type ImportNowHook = (
  moduleSpecifier: string,
  attributes?: Attributes,
) => ModuleDescriptor | undefined;
```

`attributes` is the normalized frozen object described above.
The parameter is optional only on the type; in practice the loader always
passes a value (`EMPTY_ATTRIBUTES` when there is no `with` clause).
Making it optional on the type lets old hook implementations type-check
unchanged.

Arity-based backward compatibility.
JavaScript's `function.length` returns the number of declared
parameters before the first default-valued parameter or rest element.
The SES loader uses this property on a hook to detect whether the hook
was authored against the pre-attributes signature; before invoking, it
inspects `hook.length`:

| `hook.length` | Behavior                                                                                     |
|---------------|----------------------------------------------------------------------------------------------|
| `0`           | Treated as a hook that does its own argument parsing.  Called with both arguments anyway.    |
| `1`           | Legacy single-arg hook.  Called with `(specifier)` only when the attributes are empty or carry `{ type: 'js' }`.  When the attributes carry any other `type` value, the loader throws a *TypeError* (see exact text below). |
| `2` or more   | New hook.  Called with `(specifier, attributes)`.                                            |

The throw-on-non-js-type-against-legacy-hook is the safe default.
A legacy hook cannot honor `with { type: 'json' }` (it has no way to
know the import asked for JSON), so silently dropping the attribute
would let the user import the file as JavaScript and execute
attacker-controlled content as code.
The `type: 'js'` case is treated the same as the empty case because a
JS request is what a legacy hook already serves; the only attribute a
non-attributes-aware hook cannot honor is a request for a non-JS
content type.
The same arity dispatch applies to `importNowHook`.

This arity-based detection is shim-side only.
It exists to ease migration across the SES ecosystem's existing hook
implementations and is not part of any upstream proposal; a host
language never sees `hook.length`-based dispatch in the standard
import-attributes flow.

Exact `TypeError` text.
The loader raises:

```
TypeError: importHook for "<full-specifier>" does not accept attributes;
  request was with { type: "<type>" }
  (hook arity 1; expected 2+ to honor non-JS attributes)
```

`importNowHook` raises the same shape with the hook name substituted.
Naming the exact text lets a downstream test suite assert on it without
duplicating the message.

Migration path for existing hooks.
The cookbook entry: change

```js
const importHook = async specifier => { /* ... */ };
```

to

```js
const importHook = async (specifier, attributes) => {
  if (attributes.type === 'json') { /* ... */ }
  /* ... */
};
```

For hooks that genuinely want to ignore attributes, the explicit two-argument
form with `attributes` unused is enough to satisfy the arity check and pass
through.

## Source dispatch

`ModuleSource` shapes (`PrecompiledModuleSource`, `VirtualModuleSource`)
are unchanged.
The hook's job is to dispatch on the attribute and return whichever
existing source shape carries the parsed result.
For a hook serving JSON under `with { type: 'json' }`:

```js
const importHook = async (specifier, attributes) => {
  const bytes = await readBytes(specifier);
  if (attributes.type === 'json') {
    const value = harden(JSON.parse(new TextDecoder().decode(bytes)));
    return {
      source: harden({
        imports: [],
        exports: ['default'],
        execute(env) { env.default = value; },
      }),
    };
  }
  /* default JS path returns a PrecompiledModuleSource or a
     VirtualModuleSource with a code-bearing execute */
};
```

The `VirtualModuleSource` shape (`{ imports, exports, execute }`) is the
existing surface; it covers JSON, CSS, and Wasm equally well.
A type-specific source variant in `@endo/module-source` is not introduced
by this design.

A hook may also throw when it receives an unsupported attribute combination;
the SES loader surfaces that throw as a module load failure annotated with
the offending specifier and the normalized attributes.
The host (not SES) is responsible for content-type rejection per the
import-attributes spec.

## Backward compatibility for serialized bundles

`@endo/compartment-mapper` is the package that turns a Node-style
application's package graph into a single, replayable archive
(typically a `tar.gz`) containing every module in the graph plus a
synthetic compartment configuration that re-instantiates it at runtime.
The archive replays through a synthetic `importHook` the mapper
generates from the captured graph.
A bundle captured before this design lands does not record attributes
at the import sites and does not key its synthetic memo by attributes.
The user-visible compatibility guarantees:

- **Bundle reader.** When the bundle does not record an `attributes` field
  on an import, the reader injects `EMPTY_ATTRIBUTES` (the frozen empty
  object).
- **Memo key.** Per the legacy collapse rule, the empty case keys the memo
  identically to the pre-attributes key, so a re-loaded bundle continues
  to resolve every import in the same memo slot it did before.
- **Bundle writer (forward-compat).** A bundle captured by an
  attributes-aware mapper records attributes only on imports whose
  `with` clause is non-empty.
  This keeps bundles produced from purely-JavaScript graphs byte-identical
  to today's output, which preserves SHA-pinned archive integrity for the
  vast majority of consumers.
- **Hooks shipped inside a bundle.**
  A bundle's synthetic `importHook` produced by an older mapper is by
  construction a single-arg hook.
  Per the arity rule, the SES loader still accepts it; it would only
  throw if the bundle now contained an import with a non-JS `type`,
  which an old mapper could not have produced.
  No upgrade is required for bundles that never used attributes.

The implementation surfaces inside `@endo/compartment-mapper` that
realize this contract are enumerated under
`## Compartment-mapper implications`.

## Alternatives considered

- **Side-channel parameter on the call site.**
  Threading attributes via a per-compartment registry keyed by call site or
  via a wrapper on `compartment.import`.
  Rejected: it does not flow through static imports inside compiled
  modules, which is exactly where attributes need to live per the spec.
- **Always return a discriminated union from importHook.**
  Mandating that every hook return `{ kind, ... }` and breaking single-arg
  hooks unconditionally.
  Rejected: it forces every consumer of SES to migrate in lockstep with the
  shim's adoption of attributes, even for graphs that never use them.
  Arity-based backward compatibility costs little and avoids the breaking
  change.
- **A type-specific source variant (`JsonModuleSource`, `CssModuleSource`).**
  Adding a new `ModuleSource` shape per content type, alongside
  `PrecompiledModuleSource` and `VirtualModuleSource`, with a
  type-tag own-property the linker dispatches on.
  Rejected: the existing `VirtualModuleSource` shape already covers
  every content type a host might want to serve (the hook parses,
  builds an `execute` that binds the parsed value to `default`, and
  returns the virtual source).
  Introducing per-type variants in `@endo/module-source` would
  duplicate the surface for no semantic gain and would require
  publishing a new source-shape every time a new type appears in the
  ecosystem.
  Standardizing such variants remains an option for a follow-up design
  if a concrete need emerges.
- **A separate `jsonImportHook` for JSON modules.**
  Adding a parallel hook just for JSON and keeping `importHook`
  untouched.
  Rejected: the single attribute-bearing hook composes across types;
  parallel hooks would multiply the surface per content type and would
  not give the host any expressive power it does not already have.

## Compartment construction: priming attribute-bearing modules

`moduleMap` and `moduleMapHook` are preserved unchanged.
The compartment's `moduleMap` is keyed by specifier and an entry's
implicit attribute set is the empty bag (equivalently `{ type: 'js' }`).
This keeps the existing surface stable for every caller that does not
use attributes.

A new compartment-construction option `modulesWithAttributes` carries
the attribute-bearing priming path.
Its shape is an array of three-element tuples:

```ts
new Compartment({
  globals,
  resolveHook,
  importHook,
  moduleMap: {
    './a.js': aSource,                       // specifier-keyed, type: 'js' implicit
  },
  modulesWithAttributes: [
    ['./data.json', { type: 'json' }, jsonSource],
    ['./styles.css', { type: 'css' }, cssSource],
  ],
});
```

Each triple is `[specifier, attributes, source]`.
The compartment normalizes the `attributes` half on construction (per
`## Normalized attribute representation`), JSON-stringifies the
`[specifier, normalizedAttributes]` tuple to produce the extended memo
key, and seats the source under that key.
A subsequent `import './data.json' with { type: 'json' }` from inside
the compartment hits the primed entry before the `importHook` is
consulted.

`moduleMap` and `modulesWithAttributes` cannot collide.
`moduleMap` only ever seats the legacy-collapse slot (bare specifier),
and `modulesWithAttributes` only ever seats the extended slot (JSON
tuple); a compartment that wants both for the same specifier supplies
the legacy form via `moduleMap` and the typed form via
`modulesWithAttributes`.

`moduleMapHook` is unchanged.
The hook is called as today with just the specifier and returns a
specifier-keyed module record.
Attributes do not pass through `moduleMapHook` for the same reason
they do not pass through `resolveHook`: resolution and specifier-map
linkage do not need attributes to do their job today.
A future revision may add an `attributesMapHook` or an
attribute-bearing argument if a concrete need emerges.

## Resolution and resolveHook

Attributes do not pass through `resolveHook`.
The compartment resolves specifiers identically regardless of any
`with` clause; the attributes accompany the resolved full specifier
only at the *load* boundary (the memo key and the `importHook` call).
A specifier means the same module-shaped reference whether it appears
under a `with` clause or not, so adding attributes to the signature of
`resolveHook` would burden every existing implementation for no
expressive gain.

This is a watch point.
If a concrete case emerges where the host genuinely needs to resolve
two specifier strings to different paths based on attributes (a
content-typed redirect at resolution time, say), the design will
extend `resolveHook` rather than silently strip the information.
The forward-compatible move is to keep the attribute-bearing
information adjacent to the resolved specifier so a later revision
can plumb it through if needed.

The dynamic-import options bag, `import(specifier, { with: { ... } })`,
threads through `compartmentImport` in
`packages/ses/src/compartment.js`.
The runtime carries the attributes from the call site to the loader's
memo lookup directly, bypassing `resolveHook` per the rule above, and
the loader treats the resulting `(fullSpecifier, attributes)` pair
identically to the static-import path.

## Compartment-mapper implications

`@endo/compartment-mapper` consumes the SES surface this design
extends.
A `compartment-mapper` archive is a `tar.gz` (or similar) bundle that
captures the full closed module graph of an application together with
a synthetic compartment configuration that replays it at runtime
through a `Compartment`-shaped wrapper.
The mapper builds those archives at design time and replays them at
runtime via a synthetic `importHook`.
The following surfaces are touched by the attribute-bearing
extension; each is sketched here so the implementation PR for
`compartment-mapper` starts with the catalogue.

- **`packages/compartment-mapper/src/link.js`.**
  This is the file the SES re-export of `normalizeImportAttributes`
  most directly addresses.
  The linker constructs compartments from the mapped graph, populates
  `moduleMap` and (in the new world) `modulesWithAttributes`, and
  wires the synthetic `importHook`.
  Touchpoints:
  - When a module record carries non-empty attributes, the linker
    routes that triple through `modulesWithAttributes` instead of
    `moduleMap`.
  - The synthetic `importHook` becomes a two-arg hook (its `length`
    is 2) so the SES loader does not gate it against the legacy
    single-arg rule.
- **Archive read path.**
  The compartment-mapper archive format records each import's
  resolved specifier; under this design, it also records the
  normalized attributes when non-empty.
  The reader injects `EMPTY_ATTRIBUTES` for archive entries that
  predate this design.
- **Archive write path.**
  An attributes-aware mapper records the attributes field only on
  imports whose `with` clause is non-empty.
  This keeps archives produced from purely-JavaScript graphs
  byte-identical to today's output, which preserves SHA-pinned
  archive integrity for the vast majority of consumers.
- **Synthetic-importHook construction.**
  The mapper produces a synthetic `importHook` per compartment that
  dispatches on the in-archive specifier.
  The new version dispatches on `[specifier, attributes]` (the same
  tuple SES uses for the memo key).
  Single-arg synthetic hooks produced by older mapper versions still
  load under the arity rule for graphs that never used attributes.
- **`package.json` resolution.**
  The compartment-mapper resolves bare-specifier imports against the
  application's `package.json` graph today.
  Propagating attributes through that resolution (e.g., to honor
  package-level conditions on a `with { type: '...' }` import) is
  *not* in this design's scope.
  This design's only requirement on the resolver is that it preserves
  attributes alongside the resolved specifier so a downstream
  refactor can pick them up; the per-`package.json` propagation work
  is a follow-up design.

## Test plan

The eventual implementation PR is expected to ship the following
test catalogue, in `packages/ses/test/` and
`packages/module-source/test/`:

- **Parser.** A static import with a `with` clause produces a
  `ModuleSource.imports` entry whose attributes match the source.
  A `with` clause with duplicate keys raises a *SyntaxError* at parse
  time.
  A `with` clause with a non-string value raises a *TypeError* at
  parse time.
- **Normalization.** `normalizeImportAttributes` returns
  `EMPTY_ATTRIBUTES` for an empty bag and a fresh frozen object for
  every non-empty input.
  The same input passed twice returns objects that JSON-stringify to
  the same string (sorted-key invariant).
  The caller's input is not mutated.
- **Memo collapse.** Two imports of the same specifier without a
  `with` clause share a single memo entry (legacy collapse).
- **Per-attribute memo separation.** Two imports of the same
  specifier with different `type` values produce two memo entries.
  An unattributed import and a `with { type: 'json' }` import for the
  same specifier produce two memo entries.
- **Arity-rule throw.** A `with { type: 'json' }` import against a
  legacy single-arg `importHook` raises the documented *TypeError*
  (asserting on the exact text from `## importHook signature`).
  A `with { type: 'js' }` import against the same hook succeeds.
- **Arity-rule pass-through.** A two-arg hook receives the normalized
  attributes object on every call, including the empty case
  (`EMPTY_ATTRIBUTES`).
- **modulesWithAttributes priming.** A compartment constructed with a
  `modulesWithAttributes` triple satisfies the matching attribute-
  bearing import from the primed entry without invoking `importHook`.
- **Dynamic-import path.** `import('./x.json', { with: { type: 'json' } })`
  threads attributes through to the loader and produces the same
  memo entry as the static form.
- **Bundle replay.** A `compartment-mapper` archive captured before
  this design loads identically after; its synthetic single-arg
  `importHook` continues to satisfy specifier-only imports without
  the arity throw.

## References

External, Markdown link text:

- [TC39 proposal-import-attributes](https://github.com/tc39/proposal-import-attributes)
  (Stage 4, merged into ECMA-262; the spec this design hosts).
- [test262 import-attributes coverage](https://github.com/tc39/test262/tree/main/test/language/module-code/import-attributes)
  (the conformance suite the eventual SES test plan can borrow shape
  from).

In-repo, backticked paths:

- `packages/ses/src/module-load.js` (memo and hook invocation).
- `packages/ses/src/module-link.js` (variant brand-check seat).
- `packages/ses/src/compartment.js` (`compartmentImport`,
  dynamic-import path).
- `packages/ses/types.d.ts` (`ImportHook`, `ImportNowHook`,
  `ModuleSource`, `ModuleDescriptor`).
- `packages/module-source/src/module-source.js` (parser entry point;
  future home of `normalizeImportAttributes`).
- `packages/compartment-mapper/src/link.js` (synthetic compartment
  construction; the seat for `modulesWithAttributes` plumbing).

## Prompt

> Draft a design document for SES and `@endo/module-source` covering
> TC39 import attributes (Stage 4). The document should cover the
> normalization of attribute bags, the extension of SES's per-
> compartment module memo to carry attributes in the cache key, the
> shape of `importHook` / `importNowHook` after the extension,
> backward compatibility for hooks authored before the change,
> backward compatibility for `@endo/compartment-mapper` archives
> captured before the change, and how attributes flow through
> `compartment-mapper` once the SES surface is in place. Out of scope
> for v1: any new `ModuleSource` shape (virtual module sources cover
> JSON, CSS, and Wasm equally), and per-`package.json` propagation of
> attributes through the compartment-mapper resolver.
