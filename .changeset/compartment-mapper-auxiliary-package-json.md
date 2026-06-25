---
'@endo/compartment-mapper': minor
---

Introduce a `package-descriptor-cache.js` module that distinguishes
**compartment-defining** `package.json` files (those with a `name`) from
**auxiliary** ones (those without a `name`, which exist only to scope
language-for-extension rules to a subdirectory of a parent named
package).

`mapNodeModules` now constructs a `packageDescriptorCache` on demand, so
this auxiliary handling is the default: an entry under
`apackage/afolder/` where `afolder/package.json` is auxiliary resolves
to the `apackage/` compartment with `moduleSpecifier` relative to it,
instead of triggering the
[`endojs/endo-but-for-bots#70`](https://github.com/endojs/endo-but-for-bots/pull/70)
diagnostic. Its relatives — `archive`, `bundle`, and `import` — inherit
the behavior through `mapNodeModules`. Advanced callers that share a
cache across multiple `mapNodeModules` calls still pass their own via
the `packageDescriptorCache` option.

The `#70` diagnostic remains the floor: an entry whose enclosing package
has no named ancestor — the walk reaches a `node_modules` boundary or
the filesystem root after passing an unnamed `package.json` without
finding a `name` — still fails loudly.

The auxiliary descriptors on the path to the entry module are also
honored at parse time: the entry compartment carries a
`languageForExtensionByPrefix` list (layered shortest-prefix-first, the
deepest matching prefix winning) so a `{"type": "module"}` auxiliary
actually flips `.js` parsing to ECMAScript within its subtree, and a
`{"type": "commonjs"}` auxiliary nested inside it flips back. A
compartment with no auxiliary descriptors keeps its flat `parsers` map
unchanged. The fully general per-file walk for auxiliaries discovered
lazily deep inside dependency subtrees (rather than on the entry path)
remains future work.

See `designs/compartment-mapper-auxiliary-package-json.md` for the
design this implements.
