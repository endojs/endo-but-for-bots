---
title: package.json cross-tool semantics
group: Documents
category: Reference
---

# `package.json` cross-tool semantics

`package.json` is not governed by one complete specification.
It is a shared namespace read by package managers, JavaScript runtimes,
resolvers, bundlers, compilers, and application tools.
The same spelling can therefore have different meanings in different tools.

This catalog records those meanings as of **2026-07-30**.
It is a first-edition interoperability reference, not a schema that every
manifest must satisfy.

## How to read this catalog

The words in the behavior column have narrow meanings:

- **reads** means the tool uses the value to change behavior;
- **writes** means the tool may create or normalize the value;
- **rejects** means the documented operation can fail because of the value;
- **ignores** means the cited tool deliberately does not apply the value in the
  stated context; and
- **publishes** means the package manager copies or substitutes the value while
  creating a publication artifact.

An absent behavior does not imply that a tool deletes or even validates the
field.
Most consumers parse the JSON object and look up only fields they understand.
This document does not assume that an unknown field is preserved across a
command that rewrites the manifest.

"Root" means the project or workspace root.
"Leaf" means a workspace member.
"Installed manifest" means a manifest under a dependency tree rather than a
manifest authored as part of the current project.

Version labels identify the documentation generation or the earliest documented
change where a primary source gives one.
Archived documentation is evidence for that generation, not a promise about
every patch release in its major line.

## Research inventory and coverage boundary

The inventory is deliberately auditable.
The "complete field set" column transcribes every named field heading from each
tool's primary manifest reference, while grouping documented sub-properties
under their parent.
Fields described on separate primary pages are listed in the last column.

| Consumer and reference | Complete field set on its primary manifest page | Additional directly consumed fields covered here |
| --- | --- | --- |
| [npm 6](https://docs.npmjs.com/cli/v6/configuring-npm/package-json/) | `name`, `version`, `description`, `keywords`, `homepage`, `bugs`, `license`, `author`, `contributors`, `funding`, `files`, `main`, `browser`, `bin`, `man`, `directories`, `repository`, `scripts`, `config`, `dependencies`, `devDependencies`, `peerDependencies`, `bundledDependencies`, `optionalDependencies`, `engines`, `engineStrict`, `os`, `cpu`, `preferGlobal`, `private`, `publishConfig` | Dependency specifier forms and lifecycle defaults |
| [npm 7](https://docs.npmjs.com/cli/v7/configuring-npm/package-json/) | `name`, `version`, `description`, `keywords`, `homepage`, `bugs`, `license`, `author`, `contributors`, `funding`, `files`, `main`, `browser`, `bin`, `man`, `directories.bin`, `directories.man`, `repository`, `scripts`, `config`, `dependencies`, `devDependencies`, `peerDependencies`, `peerDependenciesMeta`, `bundledDependencies`/`bundleDependencies`, `optionalDependencies`, `engines`, `os`, `cpu`, `private`, `publishConfig`, `workspaces` | npm 7 peer installation behavior |
| [npm 9](https://docs.npmjs.com/cli/v9/configuring-npm/package-json/) | `name`, `version`, `description`, `keywords`, `homepage`, `bugs`, `license`, `author`, `contributors`, `funding`, `files`, `main`, `browser`, `bin`, `man`, `directories.bin`, `directories.man`, `repository`, `scripts`, `config`, `dependencies`, `devDependencies`, `peerDependencies`, `peerDependenciesMeta`, `bundleDependencies`/`bundledDependencies`, `optionalDependencies`, `overrides`, `engines`, `os`, `cpu`, `private`, `publishConfig`, `workspaces` | None |
| [npm 11](https://docs.npmjs.com/cli/v11/configuring-npm/package-json/) | `name`, `version`, `description`, `keywords`, `homepage`, `bugs`, `license`, `author`, `contributors`, `funding`, `files`, `exports`, `main`, `type`, `browser`, `bin`, `man`, `directories.bin`, `directories.man`, `repository`, `scripts`, `gypfile`, `config`, `dependencies`, `devDependencies`, `peerDependencies`, `peerDependenciesMeta`, `bundleDependencies`/`bundledDependencies`, `optionalDependencies`, `overrides`, `engines`, `os`, `cpu`, `libc`, `devEngines`, `private`, `publishConfig`, `workspaces` | None |
| [npm 12](https://docs.npmjs.com/cli/v12/configuring-npm/package-json/) | `name`, `version`, `description`, `keywords`, `homepage`, `bugs`, `license`, `author`, `contributors`, `funding`, `files`, `exports`, `main`, `type`, `browser`, `bin`, `man`, `directories.bin`, `directories.man`, `repository`, `scripts`, `gypfile`, `config`, `dependencies`, `devDependencies`, `peerDependencies`, `peerDependenciesMeta`, `bundleDependencies`/`bundledDependencies`, `optionalDependencies`, `overrides`, `packageExtensions`, `engines`, `os`, `cpu`, `libc`, `devEngines`, `private`, `publishConfig`, `workspaces` | None |
| [Yarn Classic](https://classic.yarnpkg.com/lang/en/docs/package-json/) | `name`, `version`, `description`, `keywords`, `license`, `homepage`, `bugs`, `repository`, `maintainers`, `author`, `contributors`, `files`, `main`, `bin`, `man`, `directories`, `scripts`, `config`, `dependencies`, `devDependencies`, `peerDependencies`, `peerDependenciesMeta`, `optionalDependencies`, `bundledDependencies`, `flat`, `resolutions`, `engines`, `os`, `cpu`, `private`, `publishConfig` | [`workspaces`](https://classic.yarnpkg.com/lang/en/docs/workspaces/) and [`workspaces.nohoist`](https://classic.yarnpkg.com/blog/2018/02/15/nohoist/) |
| [Modern Yarn](https://yarnpkg.com/configuration/manifest) | `name`, `version`, `packageManager`, `type`, `private`, `license`, `os`, `cpu`, `libc`, `main`, `module`, `languageName`, `bin`, `scripts`, `dependencies`, `optionalDependencies`, `devDependencies`, `peerDependencies`, `workspaces`, `dependenciesMeta`, `peerDependenciesMeta`, `resolutions`, `preferUnplugged`, `files`, `publishConfig`, `installConfig` | `.yarnrc.yml` `packageExtensions` |
| [pnpm 9 archive](https://github.com/pnpm/pnpm.io/blob/b613ea5827e6f9290a60d7d474879a56c8ad8090/versioned_docs_archived/version-9.x/package_json.md) | `engines`, `dependenciesMeta`, `peerDependenciesMeta`, `publishConfig`, `pnpm`, and `resolutions`, including every `pnpm.*` key enumerated below | `pnpm-workspace.yaml` |
| [pnpm 11](https://pnpm.io/package_json) | `engines`, `devEngines`, `dependenciesMeta`, `peerDependencies`, `peerDependenciesMeta`, `publishConfig` | Settings moved to [`pnpm-workspace.yaml`](https://pnpm.io/settings) |
| [Node.js packages](https://nodejs.org/api/packages.html#nodejs-packagejson-field-definitions) | `name`, `main`, `type`, `exports`, `imports` | Conditional exports, self references, package scopes |
| [TypeScript module reference](https://www.typescriptlang.org/docs/handbook/modules/reference.html#packagejson-exports) | `name`, `type`, `main`, `exports`, `imports`, `types`, `typings`, `typesVersions` | Resolution-mode conditions |
| [Babel configuration](https://babeljs.io/docs/config-files) | `babel` | `browserslist` through target resolution |
| Bundlers and resolvers | No shared manifest reference exists | Webpack, Vite, Turbopack, Browserify, esbuild, Rollup's Node resolver, and Parcel fields are inventoried below from their own primary references |

The catalog covers the complete field sets above and established ecosystem
fields for which the named tools document direct behavior.
It does not enumerate arbitrary application metadata, every package registry,
every historical prerelease, or tools that merely receive already-resolved
files from another resolver.
It also does not treat similarly named external configuration as a manifest
field.

## Core metadata and publication

### Identity, people, and discovery

| Field | Accepted shape | Consumers and behavior | Portability notes |
| --- | --- | --- | --- |
| `name` | Package name string, optionally scoped | npm and Yarn read it for identity and publication; Node reads it with `exports` for [self-reference](https://nodejs.org/api/packages.html#self-referencing-a-package-using-its-name) | Registry naming validation is stricter than generic JSON parsing |
| `version` | Semantic-version string | npm and Yarn require it with `name` for publication; dependency resolvers compare it with ranges | A private workspace can often omit it, but published packages should not |
| `description`, `keywords` | String; array of strings for `keywords` | npm and Yarn registry metadata | They do not affect runtime resolution |
| `homepage` | URL string | npm and Yarn registry metadata | Not a module URL |
| `bugs` | URL string, email string, or object with `url` and/or `email` | npm and Yarn registry metadata; npm exposes the URL through `npm bugs` | Not an issue-tracker configuration |
| `license` | SPDX expression or `UNLICENSED` | npm and Yarn metadata; npm also documents `SEE LICENSE IN <filename>` | Legacy license arrays and object forms are obsolete |
| `author`, `contributors`, `maintainers` | Person string or person object; contributor and maintainer lists are arrays | npm documents `author` and `contributors`; Yarn Classic also documents `maintainers` | Registries may add maintainer data independently |
| `funding` | URL string, object with `url` and optional `type`, or array | npm reads it for `npm fund`; Yarn Classic lists it | It has no installation semantics |
| `repository` | URL string or object with `type`, `url`, and optional `directory` | npm and Yarn registry metadata; npm accepts hosted-git shorthands and `npm pkg fix` can normalize them | Use a full VCS URL in published data; `directory` identifies a monorepo subdirectory |

The authoritative npm shapes and normalization rules are on the
[npm 12 package reference](https://docs.npmjs.com/cli/v12/configuring-npm/package-json/).
Yarn Classic's additional `maintainers` spelling is on its
[manifest reference](https://classic.yarnpkg.com/lang/en/docs/package-json/).

### Publication surface and substitutions

| Field | Shape and precedence | Consumers and hazards |
| --- | --- | --- |
| `files` | Array of file and directory patterns; npm always includes `package.json`, `README`, `LICENSE`, and the `main` target, while always excluding some VCS and temporary files | npm's rules combine this allow-list with `.npmignore` and `.gitignore`; entries can be negated, but npm recommends positive patterns. Modern Yarn defaults to `["*"]`, prefers `.npmignore`, and otherwise uses `.gitignore`. Always inspect the packed archive |
| `private` | Boolean | npm refuses publication when `true`; Yarn requires a private root for Classic workspaces and uses it as a publication guard |
| `publishConfig` | Object | npm applies supported npm configuration values such as `access`, `tag`, and `registry` at publish time. Yarn documents `access`, `registry`, `provenance`, and replacement entry fields. pnpm documents the broader replacement set below |
| `bundleDependencies`, `bundledDependencies` | Boolean or array of dependency names; the spellings are aliases in npm | npm packs selected dependencies, or all production dependencies when `true`. Do not confuse bundling into a registry tarball with bundler-generated JavaScript |

The npm details, mandatory inclusions, and alias are defined in the
[npm 12 reference](https://docs.npmjs.com/cli/v12/configuring-npm/package-json/#files).
Modern Yarn's pack behavior and `publishConfig` keys are in its
[manifest reference](https://yarnpkg.com/configuration/manifest#files).

pnpm can replace package metadata in the published manifest without changing the
development manifest.
Its `publishConfig` accepts `bin`, `main`, `exports`, `types`/`typings`,
`typesVersions`, `module`, `browser`, `esnext`, `es2015`, `unpkg`, `umd:main`,
`cpu`, `os`, and `engines`, plus `executableFiles`, `directory`, and
`linkDirectory`.
The `engines` replacement was added in pnpm 10.22 according to the
[pnpm package reference](https://pnpm.io/package_json#publishconfig).
Consumers of the source tree see the ordinary fields; consumers of the tarball
see the replacements.

Always validate publication with the package manager's dry-run or pack command.
Different ignore rules and publish-time substitutions make a source-tree file
listing insufficient.

## Dependencies and installation

### Dependency families and specifiers

| Field | Meaning | Installation behavior |
| --- | --- | --- |
| `dependencies` | Runtime dependency map from name to version range or supported package specifier | Installed for consumers; npm accepts registry ranges, tarball and HTTP URLs, Git URLs, hosted Git shorthands, aliases, and local paths |
| `devDependencies` | Development-only dependency map | Installed for development but normally omitted from a production or consumer install |
| `optionalDependencies` | Dependency map whose install failure is non-fatal | Takes precedence over the same key in `dependencies`; source code must still tolerate absence |
| `peerDependencies` | Compatibility requirements supplied by the consumer or surrounding dependency graph | npm 3 through 6 warned but did not install peers; npm 7 and later installs peers by default and can fail on unsatisfied conflicts |
| `peerDependenciesMeta` | Object keyed by peer name; `{ "optional": true }` marks an optional peer | npm, Yarn, and pnpm suppress missing-peer requirements for marked peers; the peer must still be declared in `peerDependencies` |

The npm shapes and supported dependency specifiers are in the
[npm 12 dependency documentation](https://docs.npmjs.com/cli/v12/configuring-npm/package-json/#dependencies).
The npm 7 peer change is recorded in the
[npm 7 changelog](https://docs.npmjs.com/cli/v7/using-npm/changelog/).

Modern Yarn has an extra interaction:
when a package appears in both `dependencies` and `peerDependencies`, the peer
is used when provided and the ordinary dependency is a fallback.
This is documented under
[modern Yarn `peerDependencies`](https://yarnpkg.com/configuration/manifest#peerDependencies).

pnpm 11.14 and later accepts the `workspace:` and `catalog:` protocols in
`peerDependencies` and substitutes normal ranges during publication.
The exact supported schemes and version boundary are in the
[pnpm peer dependency reference](https://pnpm.io/package_json#peerdependencies).

### Scripts, native builds, and package-scoped configuration

| Field | Shape | Behavior |
| --- | --- | --- |
| `scripts` | Map from lifecycle or user-defined name to shell command | npm, Yarn, and pnpm run supported lifecycle names and expose user commands. Exact shells, environment variables, parallelism, and lifecycle sets are manager-specific |
| `config` | Object | npm exposes values to package scripts as `npm_package_config_*` and permits user overrides through npm configuration |
| `gypfile` | Boolean | npm treats a root `binding.gyp` as a native build unless `gypfile` is `false` or an `install`/`preinstall` script already exists |
| `directories.bin`, `directories.man` | Directory strings | npm expands files into `bin` or `man`; specifying both `directories.bin` and `bin` is an error |

npm supplies two notable defaults:
`server.js` can imply `"start": "node server.js"`, and `binding.gyp` can imply
`"install": "node-gyp rebuild"`.
It can also derive `contributors` from `AUTHORS`.
These defaults are documented under
[npm default values](https://docs.npmjs.com/cli/v12/configuring-npm/package-json/#default-values).

npm 6 also documented `directories.lib`, `directories.doc`,
`directories.example`, and `directories.test` as CommonJS metadata hints.
They had no general runtime-resolution semantics and are absent from the current
npm reference.
The historical list remains visible in the
[npm 6 reference](https://docs.npmjs.com/cli/v6/configuring-npm/package-json/#directories).

Install scripts are a supply-chain execution boundary.
Whether a manager permits, blocks, caches, or selectively approves them belongs
to that manager's policy configuration; the presence of `scripts` alone does
not prove that a script ran.

## Entry points, module format, and conditional resolution

### The high-risk field matrix

| Field | Node.js | TypeScript | Webpack | Vite | Turbopack | Browserify | esbuild / Rollup resolver / Parcel |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `main` | Legacy package entry fallback | JavaScript fallback, and declaration fallback only after `types`/`typings` | Fallback through configurable `mainFields` | Fallback through `resolve.mainFields` | Implementation fallback after modern maps and browser/module candidates | Primary entry, then `index.js` | Configurable fallback |
| `module` | Ignored as a package field | Not a TypeScript package-field convention | Preferred before `main` for web and Node targets by default | Preferred in the default list | Source-verified optional candidate | Not documented | Preferred by default in esbuild and Rollup's Node resolver; Parcel reads it |
| `browser` | Ignored as a package field | Not a TypeScript package-field convention | Web entry candidate and alias map by default | Entry candidate | Source-verified entry candidate and alias map | String entry or object substitution map | esbuild and Parcel read string/map; Rollup reads it only when enabled |
| `type` | Defines the nearest package scope for ambiguous `.js` files | Affects detected module format in Node modes | Passed through to parsers and Node-style resolution where applicable | Also changes library output extensions | Node-compatible resolver input | Not documented | Read where the resolver emulates Node package scopes |
| `exports` | Authoritative package entry/subpath map; takes precedence over `main` | Read in `node16`, `nodenext`, and `bundler` modes | Preferred through `exportsFields` | Preferred before `mainFields` | Source-verified first entry map | Not documented | esbuild, Rollup's Node resolver, and Parcel can read it |
| `imports` | Internal `#` import map | Read in `node16`, `nodenext`, and `bundler` modes | Read through `importsFields` | Node-compatible resolver input | Source-verified internal map | Not documented | esbuild, Rollup's Node resolver, and Parcel can read it |
| `types`, `typings` | Ignored by Node.js | Declaration entry aliases; `types` is preferred by convention | Usually delegated to TypeScript tooling | Used by TypeScript tooling, not Vite's runtime resolver | Not a runtime entry | Not documented | Publication or type-tool metadata, not JavaScript runtime entry |
| `typesVersions` | Ignored | Compiler-version-specific declaration map, bypassed when `exports` is used | Delegated to TypeScript | Delegated to TypeScript | Not a runtime entry | Not documented | Publication/type metadata |

"Ignored" in this table is about resolution behavior, not JSON retention.
The Node.js rules are normative runtime behavior from the
[Node.js package documentation](https://nodejs.org/api/packages.html).
TypeScript's ordering and resolution-mode limits come from the
[TypeScript modules reference](https://www.typescriptlang.org/docs/handbook/modules/reference.html#packagejson-main-and-types).

### `main`, `module`, and `browser`

`main` is the long-established CommonJS package entry.
Node uses it only when `exports` does not provide the applicable entry.
For compatibility with Node.js 10 and older consumers, a package can publish
both `main` and `exports`, with `exports` taking precedence in newer Node.js.

`module` is an ecosystem convention rather than a Node.js field.
Modern Yarn lists it in its manifest model and bundlers commonly treat it as an
ECMAScript-module entry.
Tools do not guarantee that the file's syntax matches the hint.

`browser` has two established shapes:

- a string selects a browser entry; and
- an object maps module or file requests to replacements, with `false` commonly
  meaning an empty shim.

Browserify defines both shapes in its
[`browser` field documentation](https://github.com/browserify/browserify#browser-field).
The standalone
[browser field specification](https://github.com/defunctzombie/package-browser-field-spec)
records the ecosystem convention.
Node ignores the field.
Bundlers differ on whether the map is enabled, when it runs, and whether it
aliases package names as well as files.

### `type`

Node added `type` in 12.0.0.
The nearest parent package scope controls how ambiguous `.js` files are parsed:
`"module"` selects ECMAScript modules and `"commonjs"` selects CommonJS.
`.mjs` and `.cjs` remain explicit regardless of `type`.
Nested manifests create new scopes.

TypeScript's `node16` and `nodenext` modes use the same nearest-scope signal for
`.ts`, `.tsx`, `.js`, and corresponding declaration files.
A declaration file published under the wrong package scope can therefore
describe a different module kind than the JavaScript beside it.
See [TypeScript module-format detection](https://www.typescriptlang.org/docs/handbook/modules/reference.html#module-format-detection).

Vite's library build changes generated `.js` and `.cjs` suffixes based on
`type`.
Its packaging recommendations are in the
[Vite library guide](https://vite.dev/guide/build.html#library-mode).

### `exports` and `imports`

Node added `exports` in 12.7.0, unflagged conditional exports in 12.17.0 and
13.7.0, and `imports` in 12.19.0 and 14.6.0.
Subpath patterns became generally available in Node 12.20.0 and 14.13.0.
The history is recorded beside the features in the
[Node.js package documentation](https://nodejs.org/api/packages.html#package-entry-points).

`exports` accepts a string, an array of fallbacks, or a nested object.
It may define the `"."` entry, explicit `"./subpath"` entries, subpath patterns,
or condition objects.
Defining it encapsulates unlisted subpaths and can break consumers that
previously reached private files.

`imports` uses keys beginning with `#`, applies only within the package, and may
map to external packages as well as local targets.
`exports` targets for published package subpaths are more restricted.

Conditional objects are ordered.
Node tests keys from most specific to least specific, with `"default"` normally
last.
Tools supply different active condition sets, so an unknown custom condition is
skipped rather than treated as an error.
Arrays are fallback lists, not condition priority lists.

Common portability hazards are:

- placing `"default"` before `"node"` or `"browser"`, making later branches
  unreachable in tools that honor object order;
- emitting different singleton implementations for `"import"` and `"require"`,
  creating the [dual package hazard](https://nodejs.org/api/packages.html#dual-commonjses-module-packages);
- exposing a new `exports` map without preserving formerly public subpaths;
- using extensionless and extensioned public subpaths inconsistently; and
- assuming every bundler activates Node's exact condition set.

TypeScript always includes a `"types"` condition in supported Node-style modes
and may match versioned conditions such as `"types@>=5.2"`.
If it resolves through `exports`, it does not apply `typesVersions`.
This precedence is documented in
[TypeScript package lookup](https://www.typescriptlang.org/docs/handbook/modules/reference.html#packagejson-typesversions).

### `types`, `typings`, and `typesVersions`

`types` and `typings` are string paths to a package's primary declaration file.
They are aliases for TypeScript, with `types` the recommended spelling.
When TypeScript is not resolving through `exports`, it checks `types`, then
`typings`, then applies a declaration-file substitution to `main`, then falls
back to an index declaration.
The publishing shapes are documented in
[TypeScript declaration publishing](https://www.typescriptlang.org/docs/handbook/declaration-files/publishing.html#including-declarations-in-your-npm-package).

`typesVersions` is an object whose keys are compiler-version ranges and whose
values are path-pattern maps to arrays of substitutions.
TypeScript selects the first matching version range.
Key order can therefore change which declaration surface a compiler receives.
It then applies the selected path mapping rather than treating all matching
ranges as fallbacks.

Node ignores all three fields.
Bundlers that appear to support them generally delegate declaration lookup to
TypeScript or another type tool; they are not JavaScript runtime entry points.
Prefer an `exports` `"types"` condition when the runtime entry map needs
per-subpath declarations, while retaining an appropriate fallback for older
TypeScript versions.

### Resolver-specific precedence

| Tool | Documented default |
| --- | --- |
| Webpack 5 | `exportsFields: ["exports"]`, `importsFields: ["imports"]`; web `mainFields: ["browser", "module", "main"]`, Node `["module", "main"]`; web `aliasFields: ["browser"]`. [`resolve` reference](https://webpack.js.org/configuration/resolve/) |
| Vite current | `exports` first, then `resolve.mainFields`, whose default is `["browser", "module", "jsnext:main", "jsnext"]`; its documented default conditions include `module`, `browser`, and the active development/production condition. [`resolve` reference](https://vite.dev/config/shared-options.html#resolve-mainfields) |
| Vite 4 | `mainFields` defaulted to `["module", "jsnext:main", "jsnext"]`, while `browserField` was a separate option. [`Vite 4 reference`](https://v4.vite.dev/config/shared-options.html#resolve-mainfields) |
| esbuild | Browser platform defaults to `browser,module,main`, Node to `main,module`, and neutral to no main fields. It also interprets browser maps and conditions. [`main-fields` reference](https://esbuild.github.io/api/#main-fields) |
| Rollup | Core Rollup does not itself provide Node package lookup. `@rollup/plugin-node-resolve` reads `exports`/`imports`, then defaults to `module,main`; browser behavior is opt-in. [`node-resolve` reference](https://github.com/rollup/plugins/tree/master/packages/node-resolve#readme) |
| Parcel 2 | Tries `source`, `exports`, `browser`, `module`, then `main`; package exports require the resolver option documented by Parcel. [`dependency resolution`](https://parceljs.org/features/dependency-resolution/) |

Vite removed its old heuristic that inspected `browser` and `module` contents
and now follows `mainFields` order.
The change is recorded in the
[Vite migration guide](https://vite.dev/guide/migration.html).
Pin a Vite generation before depending on exact fallback order.

Turbopack does not publish a standalone `package.json` schema.
The Next.js option is configured in `next.config.js` or `next.config.ts`, not in
a `"turbopack"` manifest field, and a `webpack()` configuration is not applied
to Turbopack.
The public configuration boundary is documented in the
[Next.js Turbopack reference](https://nextjs.org/docs/app/api-reference/config/next-config-js/turbopack).

For implementation evidence, the Turbopack resolver reads `exports`, `imports`,
`browser`, `module`, and `main`, with browser aliases and condition-dependent
paths, in the immutable
[Turbopack resolver source](https://github.com/vercel/next.js/blob/8ca5321d08f7e4cfe7fc5f7fbeb08791dc56142f/turbopack/crates/turbopack-resolve/src/resolve.rs).
Its import and require condition construction is visible in the
[ECMAScript resolver source](https://github.com/vercel/next.js/blob/8ca5321d08f7e4cfe7fc5f7fbeb08791dc56142f/turbopack/crates/turbopack-resolve/src/ecmascript.rs).
Those source links describe that revision, not a stable public configuration
contract.

## Executables, manual pages, and platform gates

| Field | Shape | Semantics and disagreements |
| --- | --- | --- |
| `bin` | String for a single command, or object from command name to file | npm and Yarn create executable shims. Files should begin with an appropriate shebang. `directories.bin` expands a directory instead |
| `man` | String or array of paths | npm retains the metadata but npm 12 no longer registers system manual pages; older npm references describe generated names and installation |
| `engines` | Object of runtime or package-manager names to ranges | npm treats incompatibility as advisory unless policy makes it strict; Yarn and pnpm enforcement varies by command and configuration |
| `os`, `cpu`, `libc` | Arrays of allowed or `!`-blocked values | npm gates installation; `libc` applies only with Linux. Yarn modern also documents all three |
| `engineStrict`, `preferGlobal` | Historical booleans | npm 6 retained the headings but `engineStrict` had been removed in npm 3 and `preferGlobal` was deprecated. Do not use them as portable controls |

The current accepted values and negation syntax are in the
[npm platform reference](https://docs.npmjs.com/cli/v12/configuring-npm/package-json/#os).
The changed npm 12 `man` behavior is documented in the
[npm `man` section](https://docs.npmjs.com/cli/v12/configuring-npm/package-json/#man).

## Workspaces and package-manager selection

### `workspaces`

npm, Yarn Classic, and modern Yarn accept `workspaces` as an array of package
directory patterns on the root manifest.
Patterns identify leaf packages, while leaf `name` values identify dependency
links.
Root-only metadata and hoisting mean that testing from a clean packed artifact
is safer than assuming the workspace layout matches consumer installation.

Yarn Classic also accepts an object with `packages` and `nohoist`.
`nohoist` was added in Yarn 1.4.2 and matches virtual dependency paths, not
ordinary file paths.
It is a Classic compatibility feature, not a modern Yarn manifest field.
See the [Classic workspace reference](https://classic.yarnpkg.com/lang/en/docs/workspaces/)
and [nohoist announcement](https://classic.yarnpkg.com/blog/2018/02/15/nohoist/).

pnpm requires a `pnpm-workspace.yaml` file to establish a workspace.
A `workspaces` field can coexist for other tools but does not replace that file.
See [pnpm workspaces](https://pnpm.io/workspaces).

### `packageManager`, `engines`, and `devEngines`

`packageManager` is a string such as `"yarn@4.13.0"`.
Modern Yarn writes it through `yarn set version`, and Corepack uses it to select
a manager version.
Corepack also permits an integrity hash in the version reference.
See [Yarn's field definition](https://yarnpkg.com/configuration/manifest#packageManager)
and [Corepack's project specification](https://github.com/nodejs/corepack#when-authoring-packages).

`engines` is the old, widely recognized compatibility map.
It normally expresses ranges for `node`, `npm`, or other runtimes and managers,
but enforcement is manager-specific.
It is not a lock or an installer selection mechanism.

npm 11 and 12 define `devEngines` with keys `cpu`, `os`, `libc`, `runtime`, and
`packageManager`.
Each value is an object or array of objects with required `name` and optional
`version` and `onFail`.
`onFail` is `warn`, `error`, or `ignore`, and defaults to `error`.
npm runs checks before `install`, `ci`, and `run` commands.
npm currently accepts only `node` as the runtime name and `npm` as the package
manager name.
See [npm `devEngines`](https://docs.npmjs.com/cli/v12/configuring-npm/package-json/#devengines).

Corepack reads only `devEngines.packageManager`.
It expects an object with `name`, `version`, and optional `onFail`, recognizes
Yarn, npm, and pnpm, and gives the top-level `packageManager` field precedence.
Its documented fallback behavior differs from npm's broader object family.
See [Corepack `devEngines.packageManager`](https://github.com/nodejs/corepack#devenginespackagemanager).

pnpm uses still different subfields:
`devEngines.runtime` was added in 10.14 for Node.js, Deno, or Bun, and
`devEngines.packageManager` was added in pnpm 11 with a version range that pnpm
resolves into its lockfile.
pnpm also added `engines.runtime` in 10.21 to provision a runtime for a
dependency.
See [pnpm runtime management](https://pnpm.io/package_json#devenginesruntime)
and [pnpm package-manager management](https://pnpm.io/package_json#devenginespackagemanager).

These three `devEngines` consumers overlap in spelling but not schema or
accepted names.
Do not copy one tool's value into a cross-manager project without testing every
declared manager.

## Overrides, resolutions, and package extensions

These mechanisms all modify a dependency graph, but they are not aliases.

| Mechanism | Location and shape | Scope and precedence | Principal hazard |
| --- | --- | --- | --- |
| npm `overrides` | Root object; nested selectors, version-qualified parents, replacement specs, and `$name` references | Only the root manifest is considered; installed-package and leaf overrides are ignored | Overriding a direct dependency with a mismatched spec is rejected |
| Yarn Classic `resolutions` | Root map from dependency paths or glob patterns to versions | Selective-version resolution across the install | Glob matching and warnings differ from npm's nested selector grammar |
| Modern Yarn `resolutions` | Root map from descriptor paths to resolutions | Leaf declarations produce a warning and are ignored | Descriptor syntax is Yarn-specific |
| pnpm 9 `pnpm.overrides` | Root map; supports `parent>child`, `$directDependency`, and deletion with `-` from 9.12 | Root only | Not the same key as npm `overrides` |
| pnpm 9 `resolutions` | Root object | Merged with `pnpm.overrides`; `pnpm.overrides` wins | A compatibility alias in pnpm 9, not Yarn's full semantics |
| npm 12 `packageExtensions` | Root object keyed by package selector; values contain only dependency and peer metadata families | Only root; npm refuses to publish a non-private package containing it | Adds missing metadata but does not rewrite the installed manifest |
| pnpm 9 `pnpm.packageExtensions` | Root map using pnpm selectors | Root install correction | Stored under `pnpm`, unlike npm 12 |
| Modern Yarn `packageExtensions` | `.yarnrc.yml` setting | Project configuration, not `package.json` | Putting it in a manifest invents an unsupported Yarn field |

npm's `packageExtensions` value may contain only `dependencies`,
`optionalDependencies`, `peerDependencies`, and `peerDependenciesMeta`.
Dependency additions cannot replace existing entries, peer ranges can be
replaced, metadata merges, deletion is unsupported, and conflicting matches
fail.
See the [npm 12 `packageExtensions` reference](https://docs.npmjs.com/cli/v12/configuring-npm/package-json/#packageextensions).

npm's separate selector and direct-dependency rules are in the
[`overrides` reference](https://docs.npmjs.com/cli/v12/configuring-npm/package-json/#overrides).
Yarn's root behavior is in the
[modern `resolutions` reference](https://yarnpkg.com/configuration/manifest#resolutions).
Modern Yarn extensions belong in
[`.yarnrc.yml` `packageExtensions`](https://yarnpkg.com/configuration/yarnrc#packageExtensions).

pnpm 9's exact manifest forms are frozen in the
[archived pnpm 9 reference](https://github.com/pnpm/pnpm.io/blob/b613ea5827e6f9290a60d7d474879a56c8ad8090/versioned_docs_archived/version-9.x/package_json.md#pnpmoverrides).
In pnpm 11, settings formerly stored under the `pnpm` manifest key moved to
`pnpm-workspace.yaml`.
The current [pnpm manifest reference](https://pnpm.io/package_json) explicitly
states that the `pnpm` field is no longer read.

### Complete pnpm 9 extension-key inventory

The archived pnpm 9 page enumerates these package-manager extensions:

- `pnpm.overrides`;
- `pnpm.packageExtensions`;
- `pnpm.peerDependencyRules.ignoreMissing`,
  `pnpm.peerDependencyRules.allowedVersions`, and
  `pnpm.peerDependencyRules.allowAny`;
- `pnpm.neverBuiltDependencies`, `pnpm.onlyBuiltDependencies`, and
  `pnpm.onlyBuiltDependenciesFile`;
- `pnpm.allowedDeprecatedVersions`;
- `pnpm.patchedDependencies` and `pnpm.allowNonAppliedPatches`;
- `pnpm.updateConfig.ignoreDependencies`;
- `pnpm.auditConfig.ignoreCves` and `pnpm.auditConfig.ignoreGhsas`;
- `pnpm.requiredScripts`;
- `pnpm.supportedArchitectures`;
- `pnpm.ignoredOptionalDependencies`; and
- `pnpm.executionEnv.nodeVersion`.

The same page also documents top-level `resolutions`,
`dependenciesMeta.*.injected`, `peerDependenciesMeta.*.optional`, and the
pnpm-specific `publishConfig` keys listed earlier.
For pnpm 11 projects, translate relevant settings to the current
[`pnpm-workspace.yaml` settings](https://pnpm.io/settings) rather than retaining
the old namespace.

## Tree shaking and environment targeting

### `sideEffects`

`sideEffects` is not a JavaScript language guarantee.
It is a bundler optimization assertion.

Webpack accepts a boolean or an array of file globs.
`false` says that unused modules in the package can be removed; an array
identifies files that must be treated as side-effectful.
Patterns without a slash are treated like recursive patterns, and CSS or other
effect-only imports must be included.
Webpack can also override the value through `module.rules.sideEffects`.
See [Webpack tree shaking](https://webpack.js.org/guides/tree-shaking/#mark-the-file-as-side-effect-free).

esbuild reads the same boolean or array convention and may remove imports based
on it.
`ignoreAnnotations` disables trust in this and related annotations when a
package is incorrect.
See [esbuild tree shaking](https://esbuild.github.io/api/#tree-shaking).

Parcel accepts `false`, a string glob, or an array of globs.
Its scope-hoisting documentation warns that a wrong value can remove needed
code.
See [Parcel `sideEffects`](https://parceljs.org/features/scope-hoisting/#side-effects).

Glob implementations are not a shared specification.
Test CSS, polyfill, registration, and global-patching imports with every target
bundler before publishing a narrow array.

### `browserslist`

`browserslist` accepts a query string, an array of query strings, or an object
whose keys name environments and whose values are queries.
It is consumed by the Browserslist library and therefore indirectly by tools
such as Babel, Autoprefixer, and Parcel.

Browserslist searches for `.browserslistrc`, the `browserslist` manifest field,
or a `browserslist` file.
Environment selection considers `BROWSERSLIST_ENV`, then `NODE_ENV`, then
`production`, then `defaults`.
The supported query language and lookup rules are in the
[Browserslist project reference](https://github.com/browserslist/browserslist#config-file).

Babel uses Browserslist data while resolving targets unless
`ignoreBrowserslistConfig` is set.
See [Babel target options](https://babeljs.io/docs/options#targets).
Vite's development transform and build target are separately configured; the
mere presence of `browserslist` is not a universal Vite build-target override.

## Tool namespaces stored in `package.json`

Namespaced configuration is convenient, but its inheritance boundary belongs
to the consuming tool.

| Field | Consumer, shape, and external-config interaction |
| --- | --- |
| `babel` | Babel reads an object equivalent to a `.babelrc` file. Babel 7 searches relative configuration only within a package boundary; a root `babel.config.*` can apply project-wide, and `babelrcRoots` opts workspace packages into relative lookup. Babel 6 traversed differently. See [Babel config files](https://babeljs.io/docs/config-files) |
| `browserify` | Browserify reads an object whose `transform` array contains transform names or `[name, options]` pairs. Package transforms apply to that package, not automatically to dependencies. The CLI can change the field name or disable package transforms. See [Browserify transforms](https://github.com/browserify/browserify#browserifytransform) |
| `prettier` | Prettier accepts a configuration object in `package.json`, alongside dedicated JavaScript, JSON, TOML, or YAML files. It searches upward from the formatted file and deliberately has no global configuration. See [Prettier configuration](https://prettier.io/docs/configuration) |
| `eslintConfig` | Legacy ESLint eslintrc configuration object. ESLint's current flat configuration belongs in `eslint.config.js`, `mjs`, `cjs`, `ts`, `mts`, or `cts`; the package field belongs to the deprecated eslintrc system. See the [ESLint configuration migration guide](https://eslint.org/docs/latest/use/configure/migration-guide#packagejson-configuration) |
| `jest` | Jest accepts its configuration object in `package.json` or a dedicated config file; a dedicated config can also be selected explicitly. See [Jest configuration](https://jestjs.io/docs/configuration) |
| `ava` | AVA accepts its configuration object under `ava` or in an `ava.config.*` file; `extends` is available only in the dedicated file. See [AVA configuration](https://github.com/avajs/ava/blob/main/docs/06-configuration.md) |
| `nyc` | nyc accepts an `nyc` object and also reads `.nycrc` variants; command-line arguments override configuration-file values. See [nyc configuration](https://github.com/istanbuljs/nyc#configuring-nyc) |

Webpack belongs in `webpack.config.js` or another explicitly selected config
file, Vite in `vite.config.*`, and Turbopack in `next.config.*`.
None of their cited primary references defines a general `"webpack"`, `"vite"`,
or `"turbopack"` manifest configuration field.
Do not create one by analogy with Babel or Jest.

## Tool-specific package fields

### Modern Yarn

In addition to common fields, modern Yarn directly documents:

- `languageName`, which selects the package linker's language treatment;
- `dependenciesMeta.*.built`, `optional`, and `unplugged`;
- `preferUnplugged`, a package author's hint for Plug'n'Play extraction;
- `installConfig.hoistingLimits` and `installConfig.selfReferences`; and
- publish-time `publishConfig` entry replacements and
  `publishConfig.executableFiles`.

Most `dependenciesMeta` entries are meaningful at the workspace root.
The `optional` subfield is the documented exception that may be set in a
workspace.
`built` can deny a dependency's build scripts, or permit them when the project
has disabled scripts generally.
The complete shapes and inheritance notes are in the
[modern Yarn manifest reference](https://yarnpkg.com/configuration/manifest#dependenciesMeta).

Yarn Classic's `flat` instead asks the installer to choose one version of each
dependency and may write selections into `resolutions`.
This is a Classic install mode, not the modern Yarn `installConfig` schema.

### Parcel

Parcel reads the following build-oriented fields directly:

- `source` for source entry points;
- `targets` for named output configurations;
- `main`, `module`, `browser`, and `types` as built-in output target names;
- `browserslist` and `engines` for target environments; and
- `alias` for dependency and file substitutions.

A target object may contain `source`, `context`, `engines`, `outputFormat`,
`scopeHoist`, `isLibrary`, `optimize`, `includeNodeModules`, `sourceMap`,
`distDir`, and `publicUrl`.
An arbitrary top-level field with the same name as a declared target can serve
as that target's output path.
These are build outputs, not alternate runtime entries in every consumer.
See [Parcel targets](https://parceljs.org/features/targets/) and
[Parcel aliases](https://parceljs.org/features/dependency-resolution/#aliases).

### Browserify

Browserify's `browserify.transform` is distinct from its top-level `browser`
resolution field.
The former configures source transforms; the latter replaces entry points or
modules for browser builds.
Neither implies Babel behavior unless a Babel transform is explicitly selected.

## Common migration checks

Before moving a package between tools or major versions:

1. Pack it and inspect the archive, including publish-time manifest
   substitutions.
2. Resolve every public `exports` subpath through both import and require paths
   where both are supported.
3. Compile declarations with each supported TypeScript resolution mode.
4. Test browser and Node builds separately, especially `browser` maps and
   condition order.
5. Install from a clean root and from a workspace leaf to expose ignored
   root-only overrides and resolutions.
6. Exercise optional peers both present and absent.
7. Run effect-only imports through production tree shaking.
8. Test runtime and package-manager guards with every declared manager.
9. Remove stale pnpm manifest settings when moving to pnpm 11 and create
   `pnpm-workspace.yaml`.
10. Treat generated lockfiles and packed manifests as observable outputs, not
    proof that another tool shares the same semantics.

## Adding a tool or version

Keep additions reviewable:

1. Record the tool and exact documentation generation in the research inventory.
2. Transcribe every field named by its primary manifest reference before adding
   selective ecosystem fields.
3. Link each semantic claim to a fully qualified primary-source URL.
4. Mark implementation-source evidence as such and use an immutable revision.
5. Record accepted shapes, read/write/reject/ignore behavior, version boundaries,
   defaults, precedence, root-versus-leaf scope, and external configuration.
6. Add disagreements to an existing comparison table rather than only to a
   tool-specific section.
7. Run a link check, a Markdown formatter check, and the documentation build.
8. Advance the coverage date only after rechecking the complete inventory.

## Checked backlog

The following primary references were considered but remain outside this first
edition's detailed compatibility matrix:

- Deno and Bun runtime-specific manifest resolution;
- npm versions before 6 and behavioral changes that are documented only in
  individual changelog entries;
- Yarn Berry generations between Classic and the current manifest reference;
- pnpm manifest extensions before 9 and the complete option-by-option migration
  from pnpm 10 to 11;
- JSPM import maps and registry metadata;
- React Native and Metro's package entry conventions;
- Electron-specific condition behavior outside the Parcel summary; and
- registry-specific metadata from GitHub Packages and alternate npm-compatible
  registries.

These are explicit omissions, not claims that the tools ignore the listed
fields.
