# SES Import Attributes

| Status | Priority |
|--------|----------|
| Draft  | medium   |

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

This design extends the analyzer, the memo, the hooks, and the `ModuleSource`
surface so SES can host import attributes, with JSON modules as the first
source-type variant.

## Scope and non-goals

In scope for v1:

- Capturing the `with { ... }` clause on static and dynamic imports through
  `@endo/module-source`.
- A canonical normalization for the attributes bag.
- Extending SES's module memo key to include normalized attributes.
- An augmented `importHook` / `importNowHook` signature that receives
  attributes, with explicit backward compatibility for single-argument hooks.
- A `'json'` source-type variant of `ModuleSource`.
- Backward compatibility for archive bundles produced before attributes
  existed.

Out of scope (deferred to follow-up designs):

- CSS modules (`with { type: 'css' }`). Sketched here only at the
  source-type-variant table level; the CSS source-type record and the
  CSSStyleSheet intrinsic question are left for a follow-up.
- WebAssembly modules (`with { type: 'wasm' }`).
  Source-phase imports add a second axis that needs its own design.
- Any host-defined attribute key beyond `type`.
  The spec leaves these to the host; SES intentionally normalizes them but
  does not interpret them.
- The compartment-mapper-side propagation of attributes through
  `package.json` resolution.
  That work consumes the surfaces this design defines and gets its own
  document.

## Normalized attribute representation

The TC39 spec leaves the precise normalization to the host but constrains its
shape: attribute keys are string identifiers or string literals, attribute
values are string literals, and the host's cache key includes the normalized
attributes so that the same `(referrer, specifier)` with different attributes
produces different module instances.

SES's normalization rule, applied wherever attributes enter the system
(parser, hook return values, compartment `moduleMap` entries):

1. **Coerce to a frozen plain object.** The wire shape is
   `{ [key: string]: string }` with `__proto__: null`, all values primitive
   strings.
   `undefined` and `null` values are rejected.
   Non-string values are rejected.
2. **Reject duplicate keys at parse time.** Per the spec, two attributes with
   the same key in one `with` clause is a *SyntaxError*.
   The analyzer enforces this; runtime adapters trust it.
3. **Sort keys lexicographically (UTF-16 code unit order).**
   This makes object identity irrelevant to the downstream memo key.
4. **Canonicalize the empty case to a single sentinel.**
   Imports without a `with` clause carry the frozen empty
   `Object.create(null)` value
   exported as `EMPTY_ATTRIBUTES` from `@endo/module-source`.
   The memo key collapses to the legacy specifier-only shape when this
   sentinel is present (see Backward compatibility for serialized bundles).
5. **Serialize for use as a memo-key suffix as `JSON.stringify` over the
   sorted-key object.**
   The serialization is what enters the `Map<string, ...>` memo, not the
   object itself: two distinct object instances with the same normalized
   content collapse to the same key.

The normalization function lives in `@endo/module-source` as
`normalizeImportAttributes(attributes)` and is re-exported from `ses` for the
small number of consumers (notably `compartment-mapper`'s `link.js`) that
construct attributes on the fly.

## Memo key extension

SES's per-compartment module memo currently keys on a bare
`Map<fullSpecifier, ModuleRecord>` (`packages/ses/src/compartment.js`,
the `moduleRecords` map, populated throughout
`packages/ses/src/module-load.js`).

The extended key is the string

```
<fullSpecifier> + '\0' + <normalized-attributes-json>
```

with `\0` (U+0000) chosen because it cannot appear in a valid module
specifier.
The legacy collapse rule: when the normalized attributes JSON is the empty
object literal `{}`, the key is `<fullSpecifier>` alone, byte-identical to
the pre-attributes key.
This keeps the hot path (modules with no attributes) untouched and lets
existing bundles thread through without re-keying.

Worked example.
A compartment imports the same specifier with two types:

```js
import schema from './doc.json' with { type: 'json' };
import sheet  from './doc.json' with { type: 'css'  };
```

After resolution against the compartment's `resolveHook`, both produce
`fullSpecifier = './doc.json'`.
The memo entries are:

| Memo key                                | ModuleSource variant |
|-----------------------------------------|----------------------|
| `./doc.json` (no `with` clause anywhere)| legacy collapse      |
| `./doc.json\0{"type":"json"}`           | JSON source          |
| `./doc.json\0{"type":"css"}`            | CSS source (v2)      |

A third import without an attribute would land in the legacy-collapse slot
and is distinct from either typed import.
This is the spec's behavior: an unattributed import and a `with { type: 'js' }`
import are *not* the same module, because the host is allowed to pick
different bytes for them.

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
The loader, before invoking a hook, inspects `hook.length`:

| `hook.length` | Behavior                                                                                     |
|---------------|----------------------------------------------------------------------------------------------|
| `0`           | Treated as a hook that does its own argument parsing.  Called with both arguments anyway.    |
| `1`           | Legacy single-arg hook.  Called with `(specifier)` only.  If attributes are non-empty, the loader throws a *TypeError* explaining the hook does not support attributes. |
| `2` or more   | New hook.  Called with `(specifier, attributes)`.                                            |

The throw-on-non-empty-attributes-against-legacy-hook is the safe default:
a legacy hook cannot honor `with { type: 'json' }` (it has no way to know
the import asked for JSON), so silently dropping the attribute would let
the user import the file as JavaScript and execute attacker-controlled
content as code.
The same arity dispatch applies to `importNowHook`.

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

## Source-type multiplex

The `importHook` can return a `ModuleSource` (or a `ModuleDescriptor`
wrapping one) whose shape depends on the declared type.
SES v1 ships the JSON variant and reserves the design space for others.

| `type`     | v1     | ModuleSource variant      | Default export contract                  | Notes |
|------------|--------|---------------------------|------------------------------------------|-------|
| (omitted)  | yes    | existing JS variants      | as today                                 | Legacy collapse keeps memo key compatible |
| `'json'`   | yes    | `JsonModuleSource`        | parsed JSON value                        | Sole export is `default`; no named exports |
| `'css'`    | future | `CssModuleSource` (TBD)   | `CSSStyleSheet` instance (TBD)           | Sketched; deferred for follow-up |
| `'wasm'`   | future | `WasmModuleSource` (TBD)  | instance bindings (TBD)                  | Coordinates with source-phase imports |

A hook may also throw when it receives an unsupported attribute combination;
the SES loader surfaces that throw as a module load failure annotated with
the offending specifier and attributes JSON.
This matches the JSON-modules spec's mandate that hosts reject content that
does not match the declared type.

### JSON modules in detail

The `JsonModuleSource` variant is a third kind of `ModuleSource` alongside
the existing `PrecompiledModuleSource` and `VirtualModuleSource`.
Its shape:

```ts
export interface JsonModuleSource {
  imports: readonly [];                   // JSON modules import nothing
  exports: readonly ['default'];          // sole export
  /** Pre-parsed value, frozen.  Produced by the hook or by an analyzer. */
  json: unknown;
}
```

`imports` is empty, `exports` is the singleton `['default']`, and `json` is
the parsed value.
The linker recognizes the variant by the presence of the `json` own property
(the same kind of brand-check that distinguishes `PrecompiledModuleSource`
from `VirtualModuleSource` today via `__syncModuleProgram__` and
`execute`, in `packages/ses/src/module-link.js`).

The evaluator binds `default` directly from `json` without entering a
function evaluator, which preserves SES's invariant that JSON evaluation
cannot run code.

Round trip for `import data from './data.json' with { type: 'json' };`:

```mermaid
sequenceDiagram
  participant U as User module
  participant P as @endo/module-source parser
  participant L as SES loader (module-load.js)
  participant H as importHook
  participant E as SES evaluator (module-link / module-instance)

  U->>P: source text with `with { type: 'json' }`
  P->>P: analyze; record import as<br/>{ specifier: './data.json',<br/>  attributes: { type: 'json' } }
  P-->>L: ModuleSource.imports[i]<br/>= ('./data.json', {type:'json'})
  L->>L: normalize attributes;<br/>memo key = './data.json\0{"type":"json"}'
  L->>H: importHook('./data.json',<br/>frozen {type:'json'})
  H-->>L: { source: JsonModuleSource{<br/>  imports:[], exports:['default'],<br/>  json: <parsed value> } }
  L->>L: memoize under extended key
  L->>E: link: bind 'default' = json
  E-->>U: namespace.default === <parsed value>
```

## Backward compatibility for serialized bundles

`@endo/compartment-mapper` archives capture the closed graph of modules as a
single bundle and replay it at runtime through a synthetic `importHook`.
A bundle captured before this design lands does not record attributes at
the import sites and does not key its synthetic memo by attributes.

The compatibility contract:

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
  A bundle's synthetic importHook produced by an older mapper is by
  construction a single-arg hook.
  Per the arity rule, the SES loader still accepts it and only throws if
  the bundle now contains an import with non-empty attributes, which an
  old mapper could not have produced.
  No upgrade is required for bundles that never used attributes.

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
- **Separate `jsonImportHook` for JSON modules.**
  Adding a parallel hook just for JSON and keeping `importHook` untouched.
  Rejected: it forecloses CSS, Wasm, and any future host-defined type;
  each would need its own parallel hook.
  The single attribute-bearing hook composes.
- **Carry attributes only as far as the linker, not the hook.**
  Doing the JSON parse inside the linker so the hook never sees the
  attribute.
  Rejected: the hook is where filesystem / network fetches happen and
  where the host is required by the JSON-modules spec to reject
  content-type mismatches.
  The hook must see the attribute to enforce that rejection.

## Open questions

- **Should the normalization function freeze the input object or return a
  new frozen object?**
  Mutating-and-returning the input avoids allocation in the hot path but
  surprises a caller that retains the original reference.
  Returning a fresh frozen object is cleaner but doubles allocations
  for the dominant empty case (mitigated by the `EMPTY_ATTRIBUTES`
  sentinel).
  Likely answer: always return the sentinel for the empty case, return a
  fresh frozen object otherwise.
  Maintainer to confirm.
- **Should the legacy-hook arity rule throw or warn when a single-arg hook
  receives a request with non-empty attributes?**
  This design proposes *throw*.
  A `console.warn` fallback that loads the module without honoring the
  attribute is less safe (silently misinterprets JSON as JS) but might be
  the right pragmatic posture during the migration window.
  Maintainer to pick.
- **Where exactly does the JSON parse happen, in the hook or in the
  linker?**
  Per the spec the host parses, so the natural seat is *the hook*: the
  hook reads bytes, verifies the MIME / extension, parses, and returns a
  `JsonModuleSource` whose `json` field is the already-parsed value.
  The linker would then have no JSON-specific code path at all, which is
  the design's preference.
  Confirmation needed that `compartment-mapper`'s archive flow can
  accommodate parsing at archive-replay time rather than at archive-build
  time (it likely can; archives already record `ModuleSource` values, not
  raw bytes).
- **Dynamic-import options bag.**
  `import(specifier, { with: { type: 'json' } })` exists in the spec;
  SES's dynamic-import implementation in
  `packages/ses/src/compartment.js` (`compartmentImport`) currently takes a
  bare `fullSpecifier`.
  Augmenting it to accept and propagate attributes is straightforward but
  the *resolution* step (`resolveHook`) does not currently see attributes.
  Should `resolveHook` also gain a second argument, or do attributes
  bypass `resolveHook` entirely?
  Maintainer's call; the design assumes attributes bypass `resolveHook`
  (specifiers resolve identically regardless of attributes) unless told
  otherwise.
- **Interaction with `moduleMap` and `moduleMapHook`.**
  The compartment's `moduleMap` is keyed by specifier today.
  Two natural choices: extend the map key to include attributes
  (symmetric with the memo), or treat `moduleMap` as resolving the
  specifier-to-source binding and let attributes select the variant on
  the resolved side.
  The latter is simpler and preserves the existing `moduleMap` shape.
  Maintainer to confirm direction.

## References

- [TC39 proposal-import-attributes](https://github.com/tc39/proposal-import-attributes) (Stage 4)
- [TC39 proposal-json-modules](https://github.com/tc39/proposal-json-modules) (Stage 4)
- [test262 import-attributes coverage](https://github.com/tc39/test262/tree/main/test/language/module-code/import-attributes)
- `packages/ses/src/module-load.js` (memo and hook invocation)
- `packages/ses/src/module-link.js` (variant brand-check seat)
- `packages/ses/src/compartment.js` (`compartmentImport`, dynamic-import path)
- `packages/ses/types.d.ts` (`ImportHook`, `ImportNowHook`, `ModuleSource`, `ModuleDescriptor`)
- `packages/module-source/src/module-source.js` (parser entry point; future home of `normalizeImportAttributes`)
