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

Auxiliary descriptors also carry their language: a `{"type": "module"}`
(or `{"type": "commonjs"}`) auxiliary now flips `.js` parsing within its
subtree, including for modules reached by relative import rather than a
package `export`. The import hook walks upward from each loaded module to
its compartment root, layers any intermediate auxiliary descriptors'
language-for-extension deltas shallow-to-deep onto the compartment's base
parser map (deeper auxiliaries win), records the result on the new
optional `languageForExtensionByPrefix` compartment-descriptor field, and
parses the module against its deepest-matching prefix. `importArchive` and
other fully-described compartment maps are unaffected, since their
per-module language is already pinned.

See `designs/compartment-mapper-auxiliary-package-json.md` for the design
this implements.
