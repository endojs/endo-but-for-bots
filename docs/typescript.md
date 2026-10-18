# TypeScript

This repo uses a "type-stripping" approach to TypeScript. Source files are
authored in `.ts` with only erasable type syntax (no `enum`, `namespace`,
`const enum`, or parameter properties). This lets the same source work:

- **At development time** — imported directly as `.ts`, stripped by Node's
  built-in type stripping, which is on by default from Node.js 22.18 and 23.6.
  The workspace therefore declares `engines.node` `^22.18.0 || >=23.6.0`, and
  the `endo` command exits with an error when type stripping is unavailable.
  Processes the daemon forks inherit the same built-in stripping.
- **At bundle time** — `@endo/bundle-source` strips types from `.ts` modules
  that a bundle reaches through workspace packages. Code that calls
  `@endo/compartment-mapper` directly on workspace sources must supply a
  parser for `ts` the same way.
- **At publish time** — converted to `.js` by stripping type annotations

## Authoring `.ts` source

Write TypeScript using only syntax that can be erased without changing runtime
semantics. This means:

- Type annotations, interfaces, type aliases — all fine
- `import type` / `export type` — fine
- `enum`, `namespace`, `const enum`, parameter properties — **not allowed**
  (these require emit-time transformation, not just erasure)

This is the same "erasable syntax only" subset that Node's built-in type
stripping (powered by [amaro](https://github.com/nodejs/amaro)) accepts. See
the [Node.js TypeScript docs](https://nodejs.org/api/typescript.html) for the
full set of restrictions.

### Import specifiers

In `.ts` source files, import other source files using `.ts` specifiers, but
**only by relative path within the same package**:

```ts
import { foo } from './foo.ts';
import type { Bar } from './types.ts';
```

At pack time these specifiers are automatically rewritten to `.js` for the
published tarball by [ts-node-pack](https://github.com/turadg/ts-node-pack).

Do **not** import another package's source by a `.ts` specifier, whether by
package name (`import { x } from '@endo/foo/src/bar.ts'`) or by a relative path
that leaves the package. Node.js refuses to load `.ts` resolved under
`node_modules`, and a relative path into another package names a file that is
not in the published tarball. Reach other packages through their `.js`
entrypoint. The `@endo/no-nonrelative-ts-import` lint rule rejects the
package-name form.

### Package entrypoints stay `.js`

A package's entrypoint (its `main` / `exports` target) must be a `.js` file in
source, because consumers — and Node.js generally — resolve it from
`node_modules`, where `.ts` is not loadable. Keep the entrypoint a `.js`
file that imports the `.ts` implementation by relative specifier:

```js
// index.js — published entrypoint
export * from './src/index.ts';
```

`.ts` entrypoints are intentionally out of scope for now. Letting a package's
public entry be `.ts` would require resolving `.ts` across package boundaries
(which Node.js forbids under `node_modules`) plus lint rules and specifier
rewriting to keep cross-package imports same-repo-only. Until that machinery
exists, every entrypoint is a `.js` file and every `.ts` import is relative.

## Build

### The `emitDeclarationOnly` constraint

The repo-wide `tsconfig-build-options.json` sets `emitDeclarationOnly: true`,
so `tsc` only generates `.d.ts` files. Most sources are still `.js`, and
without this setting `tsc` would try to overwrite them with its `.js` output.

## Packing

`yarn pack:all` builds every public workspace's tarball into `dist/` with
[ts-node-pack](https://github.com/turadg/ts-node-pack), which erases types
from `.ts` sources, rewrites relative `.ts` specifiers to `.js`, and fails if
any `.ts` specifier remains. `yarn release:npm` publishes those tarballs.

## Exported types

For packages that need to export types to consumers:

- Use `.ts` files for modules defining exported types
- Package entrypoints export explicit types
- Use `/** @import */` comments (in `.js` files) or `import type` (in `.ts`
  files) to import types without runtime module loading

### The `types-index` pattern (legacy)

Some packages still use the `types-index` pattern from before `.ts` source was
supported:

**types-index.js** (empty twin):
```js
export {};
```

**types-index.d.ts**:
```ts
export type * from './src/types.js';
```

As packages migrate, this pattern is replaced by authoring types in `.ts`
source and re-exporting them through the package's `.js` entrypoint (`.ts`
files cannot themselves be entrypoints — see above).
