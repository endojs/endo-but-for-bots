# Surface module pattern for public-API exports

## The rule

A package's public API lives in **physical surface modules at the
package root** (e.g. `packages/daemon/locator.js`), not under `src/`.
Each surface module re-exports the **public** subset of
`./src/<name>.js`, and **omits** any export that exists only for
unit tests.
The `package.json` `exports` map points the public name (e.g.
`./locator.js`) at the surface module, not at the source-tree path.

## Why

Three reasons, in increasing order of long-term importance:

1. **Older tools that predate the `exports` feature need a file path
   they can resolve.**
   The `exports` map enforces the public subset for newer Node.js,
   bundlers, and linters; tools that ignore `exports` fall back to
   the literal file at the path.
   Mirroring every key and value in `exports` keeps both audiences
   served.
2. **The surface module is the filter.**
   Re-exporting the source file directly via `exports` (e.g.
   `"./locator.js": "./src/locator.js"`) leaves no place to mask
   helpers exported solely so that a `*.test.js` in the same package
   can import them.
   Without a surface module the maintainer's only choices are to
   either un-export the helper (breaking the test) or expose it to
   every external consumer; the surface module gives a third choice.
3. **Hyrum's Law: contributors will reach through `lib/` and `src/`
   paths unless we stop them.**
   Even before the `exports` feature, the convention was that
   importers should not reach through internal paths; in practice
   they did, and library authors then felt unable to break them.
   A physical surface module above `src/` lets us shape the public
   surface independently of the internal layout, and lets us mask
   non-public exports cleanly.

The maintainer's note that introduced this rule (kriskowal on PR
#159 of `endojs/endo-but-for-bots`):

> When the ecosystem has wholly adopted the `exports` convention,
> we will be more free to shape the public exports, and will not
> need to keep the file extension or reexport from a surface
> module, a module above `src`.
> It will remain a useful convention, though, for masking out
> non-public methods that were exported to internal tests.

## How

Three artifacts per public name:

### 1. The source-of-truth module (`packages/<pkg>/src/<name>.js`)

Continues to export everything the package's own `src/*.js` siblings
and the package's own `test/*.test.js` files need.
Hardens at declaration as usual.
Internal-only helpers stay `export`-ed here; the filtering happens
in the surface module.

### 2. The surface module (`packages/<pkg>/<name>.js`)

A small physical file at the package root that re-exports only the
public names:

```js
// @ts-check

// Surface module: re-exports the public locator API from the source
// tree while masking exports that exist only for unit tests
// (e.g. `LOCAL_NODE` sentinel, `formatLocatorForSharing` internal
// helper).

export {
  addressesFromLocator,
  assertValidLocator,
  externalizeId,
  formatLocator,
  idFromLocator,
  internalizeLocator,
  parseLocator,
} from './src/locator.js';
```

The surface module does NOT add `harden()` calls; the source module
is the source-of-truth for hardening.
The surface module is purely a filter on the public surface.

### 3. The `exports` entry in `package.json`

Both key and value name the surface module, not the source tree:

```json
"exports": {
  ".": {
    "types": "./types.d.ts",
    "default": "./index.js"
  },
  "./locator.js": "./locator.js",
  "./pet-name.js": "./pet-name.js",
  "./package.json": "./package.json"
}
```

Note the value is `./locator.js` (the surface module), not
`./src/locator.js` (the source).
The key keeps the `.js` file extension so older tools that ignore
`exports` and resolve through the literal path still find a file.

## When to use

Every time a builder or fixer adds a new module to a package's
public API.
The default is "if it's importable from outside the package, it has
a surface module".

The cited rationale also applies to existing modules that were
exposed via `"./<name>.js": "./src/<name>.js"` from earlier work; if
a maintainer review touches the `exports` map for one of them, take
the opportunity to introduce the surface module.

## Identifying the public subset

Walk the source module's exports and classify each one:

1. **Used by external packages** (search across `packages/` for
   imports of `@endo/<pkg>/<name>.js`): public.
2. **Used by other `src/*.js` files in the same package**: public
   (an internal consumer is a public consumer for surface-module
   purposes; the `src/*.js` files import from `./<name>.js`
   relative anyway, so masking from the surface is moot for them).
3. **Used only by `test/*.test.js` files**: internal-only, omit from
   the surface module.
4. **Exported but not imported anywhere** (sentinel constants
   referenced only in comments, helpers that became dead code):
   internal-only, omit from the surface module.

For step 1 use:

```sh
grep -rn "@endo/<pkg>/<name>\.js" packages/ \
  --include='*.js' --include='*.ts'
```

For step 3 contrast:

```sh
grep -rn "from '\\.\\./src/<name>\\.js'" packages/<pkg>/test/
grep -rn "from '\\./<name>\\.js'" packages/<pkg>/src/
```

The maintainer's example at PR #159 omitted `LOCAL_NODE` (referenced
only in a comment in `test/endo.test.js`, never actually imported)
and `formatLocatorForSharing` (called only by the source module's
own `externalizeId` and by direct unit tests of the helper, with no
external consumer wanting the four-argument variant).

## Pitfalls

- **Re-exporting from `src/` via `exports` is the anti-pattern.**
  PR #159 hit this with `"./locator.js": "./src/locator.js"`; the
  fixup added the missing surface module.
  If a maintainer review says "we need a physical `./<name>.js`",
  this is the pattern being requested.
- **The `files` glob in `package.json` must list the surface
  module.**
  The `@endo/daemon` `package.json` has `"./*.js"` already, which
  picks up surface modules at the package root; if the package's
  `files` is more restrictive, add the surface module path
  explicitly.
  Otherwise `npm pack` ships the `exports` map but not the file the
  map points at, and consumers see a 404.
- **The surface module's import path is relative within the
  package.**
  Always `from './src/<name>.js'`, not `from '@endo/<pkg>/src/...'`;
  a self-import via the package name causes a circular resolution
  through the `exports` map.
- **`harden()` belongs in the source module, not the surface
  module.**
  The surface module is a re-export only; if a public name needs
  hardening it must already be hardened by the source.
  Adding a second `harden()` call in the surface module is a no-op
  on a frozen value but suggests a misread of where the
  source-of-truth lives.
- **Older surface modules in the same package may use `export *`.**
  `packages/daemon/ref-reader.js` and `reader-ref.js` are
  one-liners (`export * from './src/ref-reader.js';`).
  `export *` is wrong for the surface-module-as-filter use case
  because it forwards every export, including the ones that should
  be masked.
  Use named re-exports when the source has any internal-only
  exports; reserve `export *` for cases where every source export
  is genuinely public.
- **The maintainer may not name the test-only exports for you.**
  The review will say "omit any internal exports (exports from the
  source tree that were only exported for unit tests)"; the fixer
  is responsible for identifying which specific exports those are.
  Use the public-subset identification procedure above; don't
  guess.

## Future evolution

When the ecosystem has fully adopted the `exports` convention,
the file-extension-and-surface-module redundancy can be relaxed and
the public name can be the bare path without `.js`.
Until then, both patterns coexist for backward compatibility.
The surface module remains useful as a masking layer even after
the ecosystem catches up.

## Cited from

- [`../roles/builder.md`](../roles/builder.md): every newly-public
  module in a package's `exports` map needs a surface module.
- [`../roles/fixer.md`](../roles/fixer.md): a maintainer review that
  asks for a "physical `./<name>.js`" is asking for this pattern.

## Session example

PR #159 (`endojs/endo-but-for-bots`) added
`"./locator.js": "./src/locator.js"` so that
`packages/chat/locator.js` could re-export `assertValidLocator` from
`@endo/daemon/locator.js`.
The maintainer's review (id 4255977281) said this was the
anti-pattern: a physical surface module is required.
The fixer added `packages/daemon/locator.js` (a 12-line file
re-exporting seven of the source's nine names) and changed the
`exports` value from `./src/locator.js` to `./locator.js`.
The chat-side re-export continued to work transparently because
`assertValidLocator` was in the public subset.
The two omitted names were `LOCAL_NODE` (sentinel constant,
referenced only in a comment) and `formatLocatorForSharing`
(internal helper called by `externalizeId`, exposed only for direct
unit tests).
