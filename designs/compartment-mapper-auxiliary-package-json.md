# Compartment Mapper: Auxiliary `package.json` Overrides

| | |
|---|---|
| **Created** | 2026-05-06 |
| **Updated** | 2026-05-06 |
| **Author** | Kris Kowal (prompted) |
| **Status** | Not Started |
| **Source** | Maintainer comment on PR endojs/endo-but-for-bots#70; tracks endojs/endo issue #1845. |

## What is the Problem Being Solved?

The Node.js `package.json` file overloads two distinct responsibilities.

A `package.json` with a `name` field defines a **package**, which is the
unit npm publishes, that downstream packages depend on by name, and that
the compartment mapper turns into a compartment with its own
`packageLocation`, `parsers`, alias tables, and policy seat.

A `package.json` *without* a `name` field is also a sanctioned Node.js
construct.
The Node.js module resolution algorithm walks upward from a source file
to the nearest enclosing `package.json` to determine the `type`
(`"module"` vs `"commonjs"`) and the language for ambiguous extensions
such as `.js`.
A package author can drop a minimal `{"type": "module"}` (or the
inverse) into a subdirectory of an otherwise CommonJS package to scope a
small subtree to ECMAScript modules.
This pattern is widely used by transpiled libraries that emit a `cjs/`
sibling next to an `esm/` sibling and want the file extension `.js` to
resolve to different parsers in each subtree.
We refer to such a descriptor as an **auxiliary `package.json`**: it
exists only to override resolution rules within a parent named
package's subtree, and does not imply a separate compartment.

The compartment mapper currently mixes these two responsibilities into
a single descriptor type.
`searchDescriptor` and `findPackage` walk upward looking for *any*
`package.json` and adopt the first one as the compartment root.
When the first one found is auxiliary, the mapper either silently
produces a compartment with `name: undefined` (pre PR 70) or, with the
diagnostic from PR 70 in place, throws and refuses to map the entry.
Neither is correct: the auxiliary descriptor was never meant to define
a compartment.
The intent of `{"type": "module"}` in `apackage/afolder/package.json`
is to flip the parser for `.js` files in `afolder/` while still being
served as part of the `apackage` compartment.

The fixture
`packages/compartment-mapper/test/fixtures-nested-pkg/node_modules/apackage/afolder/package.json`
is the canonical reproducer.
The existing `nested-pkg.test.js` exercises one half of the pattern
(an aliased sub-path consumed via `apackage/file2`), where the upward
walk in `readDescriptorUpwards` happens to do the right thing because
the alias is bound from the named ancestor's `exports` map.
The other half (an entry that lands directly inside `afolder/`) hits
the new diagnostic and has no path to a correct compartment.

## Design

### Two kinds of descriptor

Distinguish two read shapes.

A **compartment-defining descriptor** has a non-empty `name`, declares
dependencies, exports, and parsers, and corresponds 1:1 to a
compartment node in the graph.
This is the only kind of descriptor that may seat in `policy`,
contribute a `packageLocation`, or appear as a node in the package
graph.

An **auxiliary descriptor** has no `name` (or has an empty `name`).
It contributes only to **language-for-extension overrides** for files
whose path is at or below the directory containing the auxiliary
`package.json`, scoped within a single compartment-defining ancestor.
It does not contribute exports, dependencies, aliases, conditions, a
`packageLocation`, a label, or a policy seat.
A `name` field on an auxiliary descriptor (if present) is not used.

The single field that flips the classification is the presence of a
non-empty `name`.
This matches Node.js's own behavior: Node consults the nearest
enclosing `package.json` for `type`, regardless of whether that file
has a `name`, but only the named one defines what `import 'apackage'`
resolves to.

### Extracted package.json cache

Today the `package.json` cache is private to one invocation of
`graphPackages` (the `memo` keyed by `packageLocation` and the
`readDescriptor` closure built around it).
The cache answers exactly one question: "what is the descriptor at this
exact directory?"

Promote the cache to a first-class structure that answers two
questions, indexed by absolute file URL:

1. **Enclosing compartment root.**
   Given any path under the entry's tree, return the `FileUrlString` of
   the nearest ancestor directory whose `package.json` is
   compartment-defining (has a `name`).
   The walk skips past auxiliary descriptors transparently.
   When no named ancestor exists at all, fall through to the existing
   PR 70 diagnostic: at that point the package itself is anonymous and
   has no compartment to belong to.

2. **Layered language-for-extension overrides.**
   Given any path under the entry's tree, return an ordered list of
   descriptors from the compartment root down to the file's parent,
   shallowest first.
   The list begins with the compartment-defining descriptor (whose
   `parsers` and `type` set the baseline) and continues with each
   auxiliary descriptor on the path, layered shallow-to-deep so deeper
   overrides win on conflicting extensions.

The cache itself is still keyed by directory and still memoizes one
read per directory.
What changes is that lookups by file path become a recognized
operation, and that the cache distinguishes the two descriptor kinds
at insert time so neither lookup needs to re-classify.

### Sketch of the cache module and the upgraded `mapNodeModules`

Add a sibling module that exports the descriptor cache and the two read
APIs, then thread the cache through `mapNodeModules` as an opt-in
capability.
The cache is the load-bearing factoring; `mapNodeModules` itself
keeps its public signature.

```js
// @ts-check
// packages/compartment-mapper/src/package-descriptor-cache.js

/**
 * @import {
 *   FileUrlString,
 *   MaybeReadFn,
 *   PackageDescriptor,
 * } from './types.js'
 */

/**
 * @typedef {object} CompartmentRootDescriptor
 * @property {FileUrlString} packageLocation
 * @property {PackageDescriptor} packageDescriptor
 *   Always has a non-empty `name`.
 * @property {ReadonlyArray<AuxiliaryDescriptor>} auxiliaryDescriptors
 *   In path order from the compartment root down. Empty on a flat package.
 */

/**
 * @typedef {object} AuxiliaryDescriptor
 * @property {FileUrlString} location
 *   Directory containing the auxiliary package.json.
 * @property {PackageDescriptor} packageDescriptor
 *   Has no `name` (or an empty `name`).
 */

/**
 * @typedef {object} PackageDescriptorCache
 * @property {(path: FileUrlString) => Promise<CompartmentRootDescriptor>}
 *   findEnclosingCompartmentRoot
 *   Walks upward past auxiliary descriptors. Throws with the PR 70
 *   diagnostic when no named ancestor exists.
 * @property {(path: FileUrlString) => Promise<ReadonlyArray<PackageDescriptor>>}
 *   collectLanguageOverrides
 *   Returns the layered descriptor list for the file at `path`,
 *   shallowest first. The first element is the compartment root's
 *   descriptor; subsequent elements are auxiliary descriptors whose
 *   directory prefixes `path`.
 */

/**
 * @param {MaybeReadFn} maybeRead
 * @returns {PackageDescriptorCache}
 */
export const makePackageDescriptorCache = maybeRead => {
  // memoizes one read per directory; classifies on insert.
  // ...
};
```

`mapNodeModules` keeps its public signature.
The upgraded behavior is reached by threading a
`packageDescriptorCache` (and any related capabilities the cache
needs) through `MapNodeModulesOptions`.
When a caller passes the cache, `mapNodeModules` walks past
intermediate auxiliary descriptors to find the enclosing named
compartment and layers their language-for-extension fields per the
"Computing language-for-extension overrides per file" section.
When a caller does not pass it, the call site continues to use the
existing private read-and-memoize closure, and the PR 70 diagnostic
fires unchanged on an entry that lands in an unnamed `package.json`.

```js
// packages/compartment-mapper/src/node-modules.js

/**
 * @typedef {object} MapNodeModulesOptions
 * ...
 * @property {PackageDescriptorCache} [packageDescriptorCache]
 *   When supplied, `mapNodeModules` resolves auxiliary `package.json`
 *   files (descriptors without a `name`) as language-for-extension
 *   overrides on the enclosing named compartment, rather than treating
 *   them as compartment roots.
 *   When omitted, behavior is unchanged: an entry that lands in an
 *   unnamed `package.json` triggers the PR 70 diagnostic.
 */
```

This keeps a single public entry point (`mapNodeModules`) and lets
adopters opt in by constructing and threading the cache.
A subsequent release can construct the cache by default and remove
the opt-in switch, at which point auxiliary handling is the only
behavior.
The maintainer's review on this design records that no downstream
consumer can depend on the current handling of auxiliary descriptors
(see Design Decisions §4), so the opt-in is a near-term carrying
strategy rather than a permanent dual lane.

### Resolving the entry

When `mapNodeModules` is invoked with a `packageDescriptorCache`
and the entry path falls inside an auxiliary subtree:

1. Use `findEnclosingCompartmentRoot(moduleLocation)` to get the named
   compartment's `packageLocation` and descriptor.
2. Compute `moduleSpecifier` as
   `relativize(relative(packageLocation, moduleLocation))`, exactly as
   the existing `search` does, except that `packageLocation` is the
   *named* ancestor's directory, not the auxiliary's.
3. Pass the named compartment's descriptor (not the auxiliary's) to
   `compartmentMapForNodeModules_` as `mainPackageDescriptor`.

For `apackage/afolder/file.js` the result is a compartment rooted at
`apackage/`, with `moduleSpecifier === './afolder/file.js'`.

### Computing language-for-extension overrides per file

Today `inferParsers` runs once per compartment using the compartment
root's descriptor.
That stays.
The new behavior layers on top.

For a single compartment, build a base language-for-extension map from
the named descriptor.
For each auxiliary descriptor on the path between the compartment root
and any traversed file, layer its `type`, `module`, and existing
`parsers` field shallow-to-deep, with deeper auxiliaries overriding
shallower ones for conflicting extensions.
The result is an ordered list of `(directoryPrefix, languageForExtension)`
tuples within the compartment, sorted from shortest prefix to longest
so that lookup by the deepest matching prefix is a linear scan from
the end.
At parse time, the deepest matching prefix's map is used.

The compartment descriptor in the resulting `CompartmentMapDescriptor`
carries this list as a new optional field alongside its existing flat
`parsers` field.
The candidate field name is open (see Open Questions, "Naming the
prefix-keyed override list").
The working name in this design is `languageOverrides`, an ordered
array of `{ prefix, languageForExtension }` records.
When the override list is absent or empty, downstream consumers fall
back to the flat existing field, preserving current behavior for
compartments without auxiliary descriptors.

The aliased-sub-path case
(`readDescriptorUpwards` reading the type of an aliased path's
ancestor) is subsumed by this layering: the existing one-off lookup
becomes a particular query on the cache.

### Hub-less / unknown-canonical case

If the upward walk reaches a filesystem boundary without finding any
named `package.json`, the entry's package itself is anonymous (not just
its subtree).
The cache-supplied path delegates to the PR 70 diagnostic in that case.
The diagnostic is unchanged: it points at the topmost `package.json`
encountered and reports a missing `name`.
Callers who want auxiliary semantics for the *workspace root* (an
unnamed `package.json` at the top of a yarn workspace, for example)
must add a `name` there, exactly as PR 70 already requires.

## Alternatives Considered

**Rename auxiliary descriptors to `auxiliary.json`.**
Rejected.
The type-scoping `{"type": "module"}` pattern is a Node.js convention.
Third-party packages use it without coordinating with us; we cannot
require them to rename their files.

**Throw a different, more permissive error for auxiliary descriptors.**
Rejected.
A different error message gives no path forward to actually use the
auxiliary descriptors as their authors intended.
The diagnostic from PR 70 is already a strict improvement over the
silent `name: undefined` regression; replacing it with a more
permissive error trades a clear failure for a less clear failure.

**A separate sibling entry point
(`mapNodeModulesWithAuxiliaryDescriptors`).**
Rejected after maintainer review.
A first draft proposed a sibling function so adopters could opt in
per call site without touching `mapNodeModules`'s contract.
The maintainer observed that no downstream consumer can depend on
the current handling of auxiliary descriptors: any package whose
entry sits inside an unnamed `package.json` is unbundle-able today
(the bundle would treat the package as nameless), and the PR 70
diagnostic now fails the same case loudly.
There is therefore no working caller whose behavior the upgrade
would change, and a permanent dual lane would only multiply the
public surface to be documented and tested.
The opt-in via `MapNodeModulesOptions.packageDescriptorCache` is a
near-term carrying strategy that lets adopters land the cache
incrementally, after which the option can be removed and the
auxiliary handling becomes unconditional.

**Single-pass walk that classifies as it goes, no separate cache
module.**
Rejected as too invasive for a first phase.
The walk-and-classify logic is exactly what the cache structure
captures.
Putting it behind a small module gives us one place to put the
two-question API, two test vectors, and one place for the policy work
(future) to hook in.

## Test Plan

The upgraded `mapNodeModules` needs evidence that the auxiliary case
works, that auxiliary nesting works, that the named-vs-unnamed
disambiguation holds, and that the PR 70 diagnostic still fires when
there is no named ancestor at all.
Each test case runs against `mapNodeModules` with a
`packageDescriptorCache` supplied via options.

**Auxiliary type-scoping case.**
Use the existing
`fixtures-nested-pkg/node_modules/apackage/afolder/package.json`
fixture.
Call `mapNodeModules` with the cache option and an entry
`apackage/afolder/file.js`.
Assert: the resulting compartment is rooted at `apackage/`, its name
is `"apackage"`, and the layered language overrides for files under
`afolder/` report `mjs` for `.js` files.
Round-trip through `loadLocation` to assert the file actually
imports.

**Nested auxiliary case.**
Add a fixture with two auxiliary descriptors on the same path
(`pkg/sub1/package.json` with `{"type": "module"}` and
`pkg/sub1/sub2/package.json` with `{"type": "commonjs"}`).
Assert: a file at `pkg/sub1/sub2/x.js` is parsed as CommonJS, a file
at `pkg/sub1/x.js` is parsed as ECMAScript modules, a file at
`pkg/x.js` is parsed using the named root's `type`.

**Named-vs-unnamed disambiguation.**
A fixture where a `package.json` with a `name` *and* an unnamed
sub-tree `package.json` coexist.
Assert: the named one is the compartment root, the unnamed one
contributes only its language overrides.

**PR 70 diagnostic regression.**
The existing PR 70 fixtures (`fixtures-no-name`) still throw the
"must have a `name` field" diagnostic when called with the cache
option, because the entry sits inside a fully anonymous package with
no named ancestor.
This proves the upgraded path does not silently relax the diagnostic
in the cases PR 70 was written to catch.

**Cache-omitted regression.**
A call to `mapNodeModules` without the cache option exercises the
unchanged code path; the existing `nested-pkg.test.js` continues to
pass.
This proves the opt-in does not silently retire the existing behavior.

**Existing nested-pkg test.**
The original `nested-pkg.test.js` continues to pass under both
shapes: against `mapNodeModules` without the cache (existing
semantics) and with the cache supplied (new semantics), since the
existing test exercises an aliased sub-path and the cache-supplied
path handles that case at least as well as the old.

## Phased Implementation

1. **Extract the cache.**
   New module
   `packages/compartment-mapper/src/package-descriptor-cache.js`.
   Move the read-and-memoize logic out of `node-modules.js` and into
   the cache.
   The cache exposes `findEnclosingCompartmentRoot` and
   `collectLanguageOverrides`.
   Internal use by `node-modules.js` stays unchanged in this phase
   (the cache is consumed via a thin shim that preserves the existing
   `MaybeReadDescriptorFn` signature).

2. **Add the two-question API.**
   Implement `findEnclosingCompartmentRoot` and
   `collectLanguageOverrides` against the cache.
   Test the cache module in isolation against synthetic file URLs and
   a stub `maybeRead`.

3. **Thread the cache through `mapNodeModules`.**
   Extend `MapNodeModulesOptions` with an optional
   `packageDescriptorCache`.
   When supplied, `mapNodeModules` calls the cache to find the
   enclosing named compartment, computes the entry's module
   specifier against the named ancestor, builds the layered
   language-for-extension override list, and delegates to
   `compartmentMapForNodeModules_`.
   When omitted, behavior is unchanged.

4. **Add fixtures and tests.**
   Add new fixtures for the nested-auxiliary and named-vs-unnamed
   cases.
   Reuse the existing `fixtures-nested-pkg` fixture and the PR 70
   `fixtures-no-name` fixture.
   Cover both the cache-supplied and cache-omitted code paths so
   the unchanged-default behavior is also load-bearing in tests.

5. **Promote the cache to the default in a later release.**
   Once adopters have moved over and the auxiliary semantics are
   confirmed in the field, construct the cache by default inside
   `mapNodeModules` and remove the `packageDescriptorCache` option.
   At that point auxiliary handling is the only behavior; the
   `parsers` field on the resulting compartment descriptor falls
   back to the flat shape only when the entry has no auxiliary
   ancestors. This phase is out of scope for this design but is
   the intended endpoint.

## Design Decisions

1. **Deeper overrides win for parsers.**
   This matches the Node.js convention for `type`: the nearest
   enclosing `package.json` decides.
   It also matches what the author of an auxiliary descriptor
   intends: a deeper auxiliary is a more specific override of a
   broader rule.

2. **Named ancestor wins over auxiliary for `packageLocation`.**
   A compartment exists to be addressable: as a node in the policy
   graph, as the target of a `from` in `exports`, as a row in the
   compartment map.
   An auxiliary descriptor cannot be addressed (no name); it cannot
   be a compartment.

3. **Auxiliary descriptors do not contribute exports, dependencies,
   aliases, conditions, or a policy seat.**
   Even if a third-party author writes them, the cache-supplied path
   ignores them.
   The semantics of an unnamed descriptor are scoped to "what does
   this subdirectory look like to the parser?" and nothing else.
   A future revision can broaden this if a real use case appears,
   but the conservative scope is easier to defend.

4. **Upgrade `mapNodeModules` in place via an opt-in cache option.**
   Per the maintainer's review on this design.
   No working downstream consumer can depend on the current handling
   of auxiliary descriptors: a package whose entry sits inside an
   unnamed `package.json` would be interpreted as a nameless
   compartment and is unbundle-able today, and the PR 70 diagnostic
   already fails the same case loudly.
   Threading the cache through `MapNodeModulesOptions` lets adopters
   move incrementally without forcing a public sibling entry point
   that would have to be supported indefinitely.
   The opt-in is a near-term carrying strategy; the endpoint is
   constructing the cache by default.

5. **The cache is the right factoring for both questions.**
   Both `findEnclosingCompartmentRoot` and `collectLanguageOverrides`
   walk the same upward path.
   Sharing the walk and the read-memoization avoids duplicate I/O
   and keeps the two answers consistent (the same descriptors that
   classify the boundary also classify the overrides).

6. **PR 70 diagnostic stays as the floor.**
   The upgraded `mapNodeModules` only reclassifies *intermediate*
   unnamed descriptors.
   When there is no named ancestor at all, the entry's package is
   genuinely anonymous and PR 70 is right to fail loudly.

## Open Questions

### Naming the prefix-keyed override list

The maintainer's review on PR 96 flagged that `parsers` (a flat map
from extension to language) is a poor name for either the existing
field or the new prefix-keyed structure that layers them.
The proposal under review is "an array of tuples, from prefix to
language for extension map" rather than a nested object.
The working name in this design is `languageOverrides`, an array
of `{ prefix, languageForExtension }` records.
Candidates the maintainer asked to consider:

1. **`languageOverrides`** (working choice in this design).
   Pros: short, says what the field does (it overrides the
   compartment-root language map for files under `prefix`).
   Cons: leaves the flat existing field still called `parsers`,
   so the compartment descriptor carries two differently-named
   shapes for the same idea.

2. **`languageForExtensionByPrefix`** (or its
   `commonjs`/`module`-split variants).
   Pros: literally describes the structure; mirrors the existing
   `parsers` semantics one-to-one.
   Cons: long; redundant with the field's tuple shape.

3. **Split into three fields:
   `languageForExtension`, `commonjsLanguageForExtension`,
   `moduleLanguageForExtension`.**
   The maintainer asked whether this finer split is worth the
   complexity, and asked for test cases that would exercise a
   meaningful difference between the three.
   A meaningful difference would arise when the same extension
   (e.g. `.js`) needs to resolve to different languages depending
   on whether the *enclosing* descriptor declared
   `"type": "module"` or `"type": "commonjs"`.
   The current `parsers` field already conflates the three; if no
   real fixture in the test suite distinguishes them, the unified
   shape suffices and the split can wait for the first reproducer
   that needs it.

The working text uses `languageOverrides` so the design reads
end-to-end; the maintainer's choice settles the field's ultimate
name before the builder lands the implementation.

### Other open items

- [ ] Whether the cache should be constructed by default in a
  later release, removing the `packageDescriptorCache` opt-in
  entirely.
  The Phased Implementation §5 anticipates this but does not
  schedule it.
- [ ] Whether composition with `policy` JSON is in scope.
  Today policy is keyed by canonical name and an auxiliary
  descriptor produces no canonical name.
  Plausibly there is no interaction; confirm with a fixture and
  document.
- [ ] Whether the same model applies to `archive`, `bundle`, and
  `import` (which today funnel through `mapNodeModules`'s
  contract).
  Each should accept the same `packageDescriptorCache` option,
  or share a constructor that builds the cache once per call.
- [ ] Performance: the cache adds one descriptor read per ancestor
  directory along each entry's path.
  This is bounded by directory depth (typically less than ten) and
  amortized by memoization, but worth confirming on a large
  monorepo before promoting to default.

## Dependencies

| Design / PR | Relationship |
|---|---|
| [endojs/endo-but-for-bots PR #70](https://github.com/endojs/endo-but-for-bots/pull/70) | Adds the loud diagnostic this design replaces in the auxiliary case. |
| [endojs/endo issue #1845](https://github.com/endojs/endo/issues/1845) | The upstream tracking issue for the original "no name" diagnostic; this design is the deeper fix promised in the PR 70 review thread. |

## Prompt

> Please dispatch a designer to submit a new design PR that addresses
> the auxiliary package.json problem, where a package.json exists in
> order to override the local language-for-extensions mapping for a
> subtree without implying a separate compartment. I expect this to
> be an invasive change and difficult to do without creating another
> lane of functions, avoiding a breaking change. The augmented
> behavior needs to extract the package.json cache so we can reuse it
> both for discovering packages and overriding language-for-extensions
> rules in matching subtree prefixes.
