---
'@endo/compartment-mapper': minor
---

Introduce a `package-descriptor-cache.js` module that distinguishes
**compartment-defining** `package.json` files (those with a `name`) from
**auxiliary** ones (those without a `name`, which exist only to scope
language-for-extension rules to a subdirectory of a parent named
package).

`mapNodeModules` now accepts an opt-in `packageDescriptorCache` option.
When supplied, the entry resolution walks past intermediate auxiliary
descriptors to the enclosing named compartment, so an entry under
`apackage/afolder/` where `afolder/package.json` is auxiliary resolves
to the `apackage/` compartment with `moduleSpecifier` relative to it,
instead of triggering the
[`endojs/endo-but-for-bots#70`](https://github.com/endojs/endo-but-for-bots/pull/70)
diagnostic.

A sibling `mapNodeModulesWithAuxiliary` constructor wires a default
cache so casual callers reach the auxiliary handling without threading
a new capability; advanced callers that share a cache across multiple
`mapNodeModules` calls pass their own via the option.

Behavior without the cache option is unchanged: the diagnostic from
`#70` still fires when an entry lands directly inside an unnamed
`package.json`.

See `designs/compartment-mapper-auxiliary-package-json.md` for the
design this implements; subsequent work threads the cache through
`archive`, `bundle`, and `import` and lands the per-file
layered-language-override pipeline.
