# Unlinked TODO comments on actual/master

Snapshot at 2026-05-01 02:06 UTC.  HEAD = `401fd20a21`.

Block-deduped counts: a contiguous comment block containing one or
more TODO/FIXME/XXX tokens counts once.
Raw line count (every line that mentions a token): 396.
CHANGELOG.md files are excluded (their TODO mentions are commit history,
not active markers).

## Summary

| Metric | Count |
| --- | --- |
| Total TODO/FIXME/XXX comment blocks in tree | 365 |
| Linked (issue/PR/bug-tracker cited) | 39 |
| Unlinked (need an issue) | 324 |
| Ambiguous (cite a doc/note, not a tracker) | 2 |

Linked rate: **10.7%** (39 of 365 blocks).

## Top packages by unlinked-TODO count

| Package | Unlinked count |
| --- | --- |
| `@endo/ses` | 60 |
| `@endo/pass-style` | 40 |
| `@endo/patterns` | 38 |
| `@endo/daemon` | 34 |
| `@endo/marshal` | 34 |
| `@endo/compartment-mapper` | 33 |
| `@endo/zip` | 11 |
| `@endo/captp` | 9 |
| `@endo/eventual-send` | 9 |
| `@endo/exo` | 9 |
| `@endo/test262-runner` | 9 |
| `@endo/module-source` | 7 |
| `@endo/cli` | 5 |
| `@endo/eslint-plugin` | 5 |
| `@endo/harden` | 3 |
| `@endo/ses-ava` | 3 |
| `@endo/bundle-source` | 2 |
| `@endo/evasive-transform` | 2 |
| `@endo/cache-map` | 1 |
| `@endo/cjs-module-analyzer` | 1 |
| `@endo/common` | 1 |
| `@endo/errors` | 1 |
| `@endo/immutable-arraybuffer` | 1 |
| `@endo/import-bundle` | 1 |
| `@endo/memoize` | 1 |
| `@endo/ocapn` | 1 |
| `@endo/panic` | 1 |
| `@endo/promise-kit` | 1 |
| `@endo/where` | 1 |

## Unlinked TODOs by file

Grouped by package, sorted by file path.

### `@endo/bundle-source`

#### `packages/bundle-source/src/is-entrypoint.js` — 1 unlinked

- **L14** `FIXME: Should maybe be exported by '@endo/something'?`
  - **Proposed issue:** `Promote isEntrypoint to a shared @endo/* utility`

    > `packages/bundle-source/src/is-entrypoint.js:14` defines an
    > `isEntrypoint(href)` helper that determines whether the current module
    > is the script invoked from the command line.
    > Several Endo packages reimplement this idiom.
    > Consider moving the helper into a shared package such as
    > `@endo/where`, `@endo/cli`, or a new utility module so callers can
    > import it instead of duplicating it.

#### `packages/bundle-source/src/script.js` — 1 unlinked

- **L126** `TODO`
  - **Proposed issue:** `Emit a real source map from bundle-source script format`

    > `packages/bundle-source/src/script.js:126` returns a hardened bundle
    > result with `sourceMap: ''`.
    > The script bundler does not currently produce a source map even
    > though the public shape exposes the field.
    > Either populate `sourceMap` with a real value collected from the
    > `sourceMapJobs` accumulator above, or document that the script
    > format intentionally omits source maps and remove the placeholder.

### `@endo/cache-map`

#### `packages/cache-map/src/cachemap.js` — 1 unlinked

- **L140** `TODO?`
  - **Proposed issue:** `Decide whether cache-map should expose richer metrics`

    > `packages/cache-map/src/cachemap.js:140` lists candidate metrics
    > (per-method counts and live/evicted touch statistics with
    > approximate quantiles) that the cache could expose alongside
    > `totalQueryCount` and `totalHitCount`.
    > Decide whether to expand the metrics surface, and if so, settle on
    > a streaming-histogram implementation.
    > If the extended metrics are not desired, delete the speculative
    > comment.

### `@endo/captp`

##### Proposed umbrella issue: Reclassify `@ts-expect-error XXX/FIXME` markers in `@endo/captp`

These typing-debt markers in `packages/captp/src/ts-types.d.ts` (lines
4, 25, 27, 31) suppress `@endo/eventual-send` type imports and a known
constraint mismatch in `Parameters<T[P]>` when `T[P]` is not callable.
Either link each marker to a real type-fixing issue (a single tracker
covering captp's TypeScript debt would be appropriate) or replace the
`FIXME` keyword with a non-TODO marker (for example a doc comment) so
the hygiene scan stops counting them.

#### `packages/captp/src/atomics.js` — 1 unlinked

- **L154** `TODO: It would be nice to use an error type, but captp is just too`
  - **Proposed issue:** `Reduce captp logging noise so trap atomics can throw typed errors`

    > `packages/captp/src/atomics.js:154` notes that the trap host
    > iterator is told to throw `null` rather than a real `Error`
    > because captp emits "Temporary logging of sent error" diagnostics
    > whenever an iterator-throw is observed.
    > Audit the captp send path so that `it.throw(makeError(...))` no
    > longer produces spurious console output, then replace the
    > `it.throw(null)` call with a typed error.

#### `packages/captp/src/captp.js` — 1 unlinked

- **L329** `TODO: fix captp to be compatible with smallcaps`
  - **Proposed issue:** `Make captp compatible with the smallcaps marshalling format`

    > `packages/captp/src/captp.js:329` hard-codes
    > `serializeBodyFormat: 'capdata'` because captp's wire format is
    > not yet compatible with `smallcaps`.
    > Migrate captp's marshalling defaults to `smallcaps`, providing a
    > compatibility shim or version negotiation if existing peers still
    > expect the legacy `capdata` format.

#### `packages/captp/src/finalize.js` — 1 unlinked

- **L78** `it unregisters. TODO If this is not actually guaranteed, i.e., if`
  - **Proposed issue:** `Confirm FinalizationRegistry unregister suppresses pending finalizations`

    > `packages/captp/src/finalize.js:78` assumes that calling
    > `FinalizationRegistry.unregister(key)` synchronously suppresses
    > any pending finalization callback for that key.
    > If finalizations may already have been scheduled at the time of
    > `unregister`, the bookkeeping in `finalizingMap` could delete a
    > newer binding by mistake.
    > Verify the spec and engine behaviors and either rewrite the map
    > to be unregister-race-safe or document the assumption explicitly.
    > Note: the same TODO is duplicated at
    > `packages/ocapn/src/captp/finalize.js:78`.

#### `packages/captp/src/trap.js` — 2 unlinked

- **L57** `TODO: has property is not yet transferrable over captp.`
- **L93** `TODO: has property is not yet transferrable over captp.`
  - **Proposed issue:** `Implement transferrable hasProperty trap over captp`

    > `packages/captp/src/trap.js:57` and `:93` always return `true`
    > from the `has` proxy trap because captp does not yet transmit a
    > `hasProperty` query across the wire.
    > Add a captp message kind for hasProperty, route it through
    > `TrapProxyHandler` and `makeTrapGetterProxy`, and replace the
    > placeholder `return true` with a real synchronous trap.

#### `packages/captp/src/ts-types.d.ts` — 4 unlinked

- **L4** `@ts-expect-error FIXME these aren't defined`
- **L25** `@ts-expect-error FIXME Type 'T[P]' does not satisfy the constraint '(...args: any) => any'.`
- **L27** `@ts-expect-error FIXME ditto`
- **L31** `  ? // @ts-expect-error FIXME ditto`
  - See umbrella above:
    `Reclassify @ts-expect-error XXX/FIXME markers in @endo/captp`.

### `@endo/cjs-module-analyzer`

#### `packages/cjs-module-analyzer/index.js` — 1 unlinked

- **L224** `TODO: <!-- XML comment support`
  - **Proposed issue:** `Decide whether cjs-module-analyzer should support legacy <!-- XML --> comments`

    > `packages/cjs-module-analyzer/index.js:224` flags the `<` token in
    > the analyzer's tokenizer with a TODO about supporting legacy
    > `<!--` HTML-style comments that some annex-B environments accept
    > inside CommonJS scripts.
    > Confirm whether the analyzer needs to recognize HTML-style
    > comments at all (modern CommonJS rarely uses them), and either
    > implement the case or delete the TODO.

### `@endo/cli`

#### `packages/cli/demo/cat.js` — 1 unlinked

- **L756** `TODO await (and respect cancellation)`
  - **Proposed issue:** `cat demo: await promise values when rendering passable trees`

    > `packages/cli/demo/cat.js:756` renders a `promise` passable as a
    > literal hourglass glyph rather than awaiting and rendering the
    > resolved value.
    > Update the renderer to await the promise (subject to a
    > cancellation signal) and substitute the resolved DOM node when
    > settled.

#### `packages/cli/src/client.js` — 2 unlinked

- **L24** `    return await /** @type {any} XXX EndoBootstrap not exported */ (`
- **L36** `    return /** @type {any} XXX EndoBootstrap not exported */ (`
  - **Proposed issue:** `Export EndoBootstrap so cli/client.js does not need any-cast`

    > `packages/cli/src/client.js:24` and `:36` cast `makeEndoClient`'s
    > result to `any` because the `EndoBootstrap` type is not exported
    > from `@endo/daemon`.
    > Export the `EndoBootstrap` (and any related host bootstrap)
    > types from the daemon's public types module, then drop the two
    > `any` casts in the CLI client.

#### `packages/cli/src/commands/install.js` — 1 unlinked

- **L32** `TODO alternately, make a temporary session-scoped GC pet store`
- See umbrella issue:
  `Provide a session-scoped temporary pet store for cli install/make`
  (also covers `packages/cli/src/commands/make.js:51`).

  > `packages/cli/src/commands/install.js:32` and
  > `packages/cli/src/commands/make.js:51` both generate
  > `tmp-bundle-<hex>` pet names when the user did not supply
  > `bundleName`.
  > These names accumulate in the persistent pet store.
  > Add a session-scoped pet store that overshadows the permanent
  > one and is implicitly dropped when the CapTP session ends, then
  > stop manufacturing `tmp-bundle-*` names in the install and make
  > commands.

#### `packages/cli/src/commands/make.js` — 1 unlinked

- **L51** `TODO alternately, make a temporary session-scoped GC pet store`
  - See `packages/cli/src/commands/install.js:32` for the proposed
    umbrella issue.

### `@endo/common`

#### `packages/common/test/object-meta-assign.test.js` — 1 unlinked

- **L7** `TODO more testing`
  - **Proposed issue:** `Expand objectMetaAssign tests beyond a single happy path`

    > `packages/common/test/object-meta-assign.test.js:7` covers only
    > one trivial case for `objectMetaAssign`.
    > Add coverage for property descriptor merging, accessor
    > properties, non-enumerable keys, symbol keys, and prototype
    > preservation so the helper's documented contract is exercised.

### `@endo/compartment-mapper`

#### `packages/compartment-mapper/README.md` — 13 unlinked

##### Proposed umbrella issue: Track future-version TODOs in `compartment-mapper/README.md`

The `compartment-mapper` README enumerates roadmap items inline using
`> TODO:` admonitions and bare `// TODO` comments inside the
`CompartmentMap` type sketch (lines 71, 351, 354, 367, 449, 453, 468,
589, 618, 637, 729, 736, 764).
The themes are:

> 1. distributing global and built-in choices to third-party packages
>    (LavaMoat parity, line 71);
> 2. respecting `imports` (351) and wildcard patterns in `exports` and
>    `imports` (354);
> 3. acting on the `package.json` `files` globs and exposing
>    per-compartment file access (367);
> 4. respecting import-map properties (449);
> 5. source-to-source translators in `package.json` (453);
> 6. compartment-map plugins for `devDependencies` (468);
> 7. defining the `Realm`/`realms` shape and lockdown options
>    (589, 618, 729, 736);
> 8. clarifying that an absent `compartment` name may mean either an
>    internal alias or a user-supplied module (637);
> 9. reaching policy parity with LavaMoat's `policy.json` (764).
>
> Likely overlap with endojs/endo#2388 for `exports`/`imports`
> conditions.
> Maintainer should split the list into individual issues (or link
> existing ones), and either inline the issue references in the
> README or strip the TODO comments entirely once they are tracked
> elsewhere.

- **L71** `> TODO: A future version will allow application authors to distribute their`
- **L351** `> TODO: A future version may also respect the 'imports' property.`
- **L354** `> TODO: A future version may also respect wildcard patterns in 'exports' and`
- **L367** `> TODO: The compartment mapper does not yet do anything with the 'files' globs`
- **L449** `> TODO: The compartment mapper may elect to respect some properties specified`
- **L453** `> TODO: A future version of the compartment mapper may add support for`
- **L468** `> TODO: The compartment mapper may also add support for compartment map plugins`
- **L589** `  realms: Record<RealmName, Realm>, // TODO`
- **L618** `  realm?: RealmName // TODO`
- **L637** `TODO an absent compartment name may imply either`
- **L729** `TODO everything hereafter...`
- **L736** `TODO lockdown options`
- **L764** `> TODO: Endo policy support is intended to reach parity with LavaMoat's`

#### `packages/compartment-mapper/src/bundle-cjs.js` — 1 unlinked

- **L33** `TODO: specifier not found handling`
  - **Proposed issue:** `bundle-cjs runtime require: surface a clear error when specifier is unknown`

    > `packages/compartment-mapper/src/bundle-cjs.js:33` builds a
    > `requireImpl(specifier)` that does
    > `cells[imports[specifier]].default.get()` without checking that
    > `imports[specifier]` is defined.
    > Add an explicit "module not found" error path so a missing
    > specifier produces a recognizable runtime error rather than a
    > "Cannot read property of undefined" stack.

#### `packages/compartment-mapper/src/capture-lite.js` — 1 unlinked

- **L160** `TODO: A mapping of canonical name to compartment name is generated by`
  - **Proposed issue:** `Expose canonical-name to compartment-name mapping from mapNodeModules`

    > `packages/compartment-mapper/src/capture-lite.js:160` recomputes
    > the canonical-name to compartment-name mapping by scanning
    > `compartmentMap.compartments` because the mapping that
    > `mapNodeModules()` already builds is not exposed.
    > Surface the mapping as either an out-parameter on
    > `mapNodeModules()` or an option on `captureFromMap()` so the
    > redundant scan in `capture-lite.js` can be removed.

#### `packages/compartment-mapper/src/compartment-map.js` — 2 unlinked

- **L34** `TODO convert to the new '||' assert style.`
  - **Proposed issue:** `Migrate compartment-map.js error messages to assert.details/X tagged templates`

    > `packages/compartment-mapper/src/compartment-map.js:34` notes
    > that the file uses plain template strings and a local
    > `q = JSON.stringify` helper instead of the modern `assert(cond,
    > X\`...\`)` / `assert.quote` idiom used elsewhere in Endo.
    > Convert the file's assertions to the standard pattern so error
    > messages participate in the structured-errors machinery.
- **L598** `TODO: It may be prudent to assert that there exists some module referring`
  - **Proposed issue:** `Assert that each compartment has at least one module referring to it`

    > `packages/compartment-mapper/src/compartment-map.js:598` calls
    > out a missing structural check inside the compartment-map
    > validator: there is currently no assertion that every named
    > compartment is actually referred to by some module entry.
    > Add the assertion (or document why orphan compartments are
    > legal) so malformed maps are rejected closer to the source.

#### `packages/compartment-mapper/src/hooks.md` — 1 unlinked

- **L93** `> [TODO]`
  - **Proposed issue:** `Update hooks.md bundle/archive diagram once hook integration lands`

    > `packages/compartment-mapper/src/hooks.md:93` carries a `[TODO]`
    > admonition to copy the bundle-and-archive subgraph into the
    > main hook diagram once the bundle and archive entry points
    > start passing hooks.
    > Either update `bundle.js` and `archive.js` to thread hooks
    > through and refresh the diagram, or remove the placeholder
    > diagram if hook coverage there is not on the roadmap.

#### `packages/compartment-mapper/src/infer-exports.js` — 1 unlinked

- **L207** `TODO Otherwise, glob 'files' for all '.js', '.cjs', and '.mjs' entry`
  - **Proposed issue:** `inferExports: glob package.json files for entry modules when exports is absent`

    > `packages/compartment-mapper/src/infer-exports.js:207` notes
    > that when neither `main` nor `exports` is provided, the
    > compartment mapper should fall back to globbing the
    > `package.json` `files` field for `.js`, `.cjs`, and `.mjs`
    > entry modules (excluding `node_modules`).
    > Implement the glob fallback so legacy packages that rely on
    > `files` continue to expose their entry points.

#### `packages/compartment-mapper/src/link.js` — 1 unlinked

- **L64** `TODO: can we just use 'Object.hasOwn' instead?`
  - **Proposed issue:** `Replace local has() helper in link.js with Object.hasOwn`

    > `packages/compartment-mapper/src/link.js:64` defines a private
    > `has(object, key)` helper using `Function.prototype.apply` and
    > `hasOwnProperty`.
    > `Object.hasOwn` is now available in all targeted environments
    > and reads more clearly.
    > Replace the helper with `Object.hasOwn` and audit the file's
    > other primordial-bound utilities for the same simplification.

#### `packages/compartment-mapper/src/node-modules.js` — 1 unlinked

- **L204** `TODO: This only validates that the value is a plain object. As mentioned in`
  - **Proposed issue:** `Strengthen assertPackageDescriptor to validate package.json shape`

    > `packages/compartment-mapper/src/node-modules.js:204` defines
    > `assertPackageDescriptor` to check only that the value is a
    > non-function object.
    > The function's TypeScript type implies that `name` is required,
    > but in practice many real `package.json` files omit it.
    > Decide on the canonical shape, document which fields are truly
    > required, and tighten the runtime assertion to match.

#### `packages/compartment-mapper/src/policy-format.js` — 1 unlinked

- **L343** `TODO: Shouldn't need type assertions here`
  - **Proposed issue:** `Eliminate redundant type assertion on isEmptyObject in policy-format.js`

    > `packages/compartment-mapper/src/policy-format.js:343` casts
    > the result of `and([isPlainObject, ...])` to a more specific
    > `TypeGuard<unknown, Record<PropertyKey, never>>`.
    > Refine the typings on `and` and the underlying guard helpers
    > so the cast is no longer needed.

#### `packages/compartment-mapper/src/policy.js` — 2 unlinked

- **L209** `TODO: uncurry bind for security?`
  - **Proposed issue:** `Audit attenuator binding for prototype-poisoning safety`

    > `packages/compartment-mapper/src/policy.js:209` builds an
    > attenuator by calling
    > `attenuator[attenuatorExportName].bind(attenuator, params)`.
    > If `bind` is shadowed on the attenuator's prototype chain a
    > malicious attenuator could observe or replace the bound value.
    > Replace the call with a hardened `uncurryThis`-style invocation
    > of `Function.prototype.bind` to ensure the binding semantics
    > cannot be tampered with.
- **L353** `          )}: ${q(error.message)}', // TODO: consider an option to expose stacktrace for ease of debugging`
  - **Proposed issue:** `Add an opt-in option to surface stack traces from policy attenuator failures`

    > `packages/compartment-mapper/src/policy.js:353` swallows the
    > stack trace of an attenuator failure and only quotes
    > `error.message` in the rethrown error.
    > Add a debugging option (analogous to other compartment-mapper
    > debug flags) that, when enabled, includes the original stack
    > trace so attenuator authors can diagnose failures.

#### `packages/compartment-mapper/test/dynamic-require.test.js` — 3 unlinked

- **L694** `TODO: see if we can somehow use the pantspack.js entry`
- **L748** `TODO: see if we can somehow use the pantspack.js entry`
- **L807** `TODO: see if we can somehow use the pantspack.js entry`
  - **Proposed issue:** `Reuse pantspack.js entry in dynamic-require tests`

    > `packages/compartment-mapper/test/dynamic-require.test.js`
    > duplicates an entry-resolution snippet at lines 694, 748, and
    > 807 inside the `dynamic require of ancestor` cases.
    > Each currently constructs a `webpackish-app/build.js` URL
    > rather than using the `pantspack.js` entry point that the
    > fixture exposes.
    > Refactor the tests to use `pantspack.js` so the duplication is
    > collapsed and the test better reflects the fixture's intended
    > entry shape.

#### `packages/compartment-mapper/test/main.test.js` — 1 unlinked

- **L143** `TODO: relax the assertion to match any of the dev dependencies regardless of loading order`
  - **Proposed issue:** `Relax dev-dependency error assertion in compartment-mapper main.test.js`

    > `packages/compartment-mapper/test/main.test.js:143` matches
    > exactly `Cannot find external module "typemodule"`, which
    > pins the test to a specific dev-dependency loading order.
    > Replace the regex with one that matches any of the relevant
    > dev dependencies so the test is not flaky if loading order
    > changes.

#### `packages/compartment-mapper/test/project-fixture.js` — 1 unlinked

- **L427** `                  location, // TODO: style if file URL`
  - **Proposed issue:** `Stylize file:// URLs in compartment-mapper project-fixture snapshots`

    > `packages/compartment-mapper/test/project-fixture.js:427`
    > forwards `location` verbatim into snapshot output.
    > When `location` is a `file://` URL it bakes absolute paths into
    > the snapshot.
    > Apply the same stylize/relativize treatment used elsewhere in
    > the fixture to keep snapshots portable.

#### `packages/compartment-mapper/test/scaffold.js` — 2 unlinked

- **L617** `@ts-expect-error XXX TS2345`
- **L678** `@ts-expect-error XXX TS2345`
  - See umbrella below:
    `Reclassify @ts-expect-error XXX markers in @endo/compartment-mapper`.

##### Proposed umbrella issue: Reclassify `@ts-expect-error XXX` markers in `@endo/compartment-mapper`

The two `@ts-expect-error XXX TS2345` markers in
`packages/compartment-mapper/test/scaffold.js` (lines 617 and 678) sit
on `test(name, async (t, Compartment) => {...})` calls.
They suppress AVA's overload selection complaint when the test
implementation accepts an extra `Compartment` argument supplied by an
AVA macro.
Either teach the test scaffold's typings about the macro signature so
the suppressions become unnecessary, or replace the `XXX` keyword with
a non-TODO marker (for example a doc comment) so the hygiene scan
stops counting them.

#### `packages/compartment-mapper/test/snapshot-utilities.js` — 1 unlinked

- **L47** `TODO: Validate resulting CompartmentMapDescriptor`
  - **Proposed issue:** `Validate relativized CompartmentMapDescriptor in snapshot tooling`

    > `packages/compartment-mapper/test/snapshot-utilities.js:47`
    > notes that `relativizeCompartmentMap` returns a
    > `PackageCompartmentMapDescriptor` cast through the input type
    > parameter without validating that the result still satisfies
    > the descriptor schema.
    > Run the descriptor through the existing assertion helpers
    > before returning so snapshot drift is caught at test time.

#### `packages/compartment-mapper/test/test.types.d.ts` — 1 unlinked

- **L91** `TODO: Upstream & remove this.`
  - **Proposed issue:** `Upstream FixedCustomInspectFunction third parameter to @types/node`

    > `packages/compartment-mapper/test/test.types.d.ts:91` defines
    > a local `FixedCustomInspectFunction` because Node's
    > `CustomInspectFunction` in `@types/node` lacks the third
    > `inspect` parameter.
    > Open a DefinitelyTyped PR to add the parameter, then remove
    > the local override once the upstream change is published.

### `@endo/daemon`

#### `packages/daemon/src/daemon-node-powers.js` — 2 unlinked

- **L58** `TODO Respect back-pressure signal and avoid accepting new connections.`
  - **Proposed issue:** `daemon-node-powers: respect back-pressure when accepting TCP connections`

    > `packages/daemon/src/daemon-node-powers.js:58` accepts every
    > inbound connection and pushes it to `writeTo.next` without
    > waiting for the consumer to drain.
    > Track the writer's back-pressure signal and pause the
    > underlying server (or buffer with a bounded queue) until the
    > consumer is ready.
- **L443** `TODO Take care to write atomically with a rename here.`
  - **Proposed issue:** `daemon-node-powers: write formula files atomically using temp + rename`

    > `packages/daemon/src/daemon-node-powers.js:443` writes formula
    > files via `makePath` followed by `writeFileText` directly to
    > the destination path.
    > A crash mid-write can corrupt the persisted formula store.
    > Switch to a write-to-temp-then-rename pattern, mirroring the
    > pattern used elsewhere for content-addressed blobs.

#### `packages/daemon/src/daemon.js` — 8 unlinked

##### Proposed umbrella issue: Daemon TODO sweep across `daemon.js` bootstrap path

The 8 unlinked TODOs in `packages/daemon/src/daemon.js` cluster around
the daemon bootstrap and formulation surface area:

> 1. L488 `makeEval`: when an eval result is plain data, optionally
>    promote the resolution into the content-addressed store and
>    truncate the dependency chain (potentially by racing two
>    formulas).
> 2. L527, L550 `makeUnconfined` and `makeBundle` cast `powers` and
>    `farContext` through `any` because the worker daemon facet's
>    types are not yet precise.
> 3. L1344 `addPeerInfo` short-circuits when a peer is already known
>    instead of merging the inbound connection info.
> 4. L2310 `formulatePeer` skips validation of `addresses` and stores
>    mutable address state in the formula.
> 5. L2433 `makePeer` connects on the first supported address rather
>    than racing supported networks (with retry/back-off and
>    invalidation on connection loss).
> 6. L2506 `accept`-invitation flow needs to confirm that
>    `formulaGraphJobs.enqueue()` is sufficient to cancel the
>    previous incarnation and revoke the invitation.
> 7. L2753 `makeDaemon` hardcodes `gracePeriodMs = 100` instead of
>    threading the value through command arguments.

These themes are cohesive: the daemon's bootstrap and peer pathways
need a focused review to land them. Either split into one issue per
TODO or open a single tracker covering the daemon TODO sweep.

- **L488** `TODO check whether the promise resolves to data that can be marshalled`
- **L527** `TODO fix type`
- **L550** `TODO fix type`
- **L1344** `TODO: merge connection info`
- **L2310** `TODO: validate addresses`
- **L2433** `TODO race networks that support protocol for connection`
- **L2506** `TODO ensure that this is sufficient to cancel the previous`
- **L2753** `TODO thread through command arguments.`

#### `packages/daemon/src/directory.js` — 1 unlinked

- **L297** `TODO thread context`
  - **Proposed issue:** `Thread Context through makeIdentifiedDirectory`

    > `packages/daemon/src/directory.js:297` declares
    > `makeIdentifiedDirectory({ petStoreId, context })` but the
    > `context` argument is destructured and never used.
    > Plumb `context` into the directory's lifetime management so
    > sub-resources (pet store, child directories) inherit
    > cancellation and disposal.

#### `packages/daemon/src/mail.js` — 3 unlinked

##### Proposed umbrella issue: Validate request messages and add reject coverage in mail.js

`packages/daemon/src/mail.js` has three TODOs in the same handler:

> 1. L497 `respond` casts `message` to `Request` without validating
>    its shape.
> 2. L505 there is no test for the `reject` path.
> 3. L511 `reject` similarly casts `message` without verifying it is
>    a request.
>
> Add a runtime shape guard (using `@endo/patterns` matchers) for
> request messages, share it between `respond` and `reject`, then
> add an AVA test that exercises rejection of an outstanding request.

- **L497** `TODO validate shape of request`
- **L505** `TODO test reject`
- **L511** `TODO verify that the message is a request.`

#### `packages/daemon/src/networks/tcp-netstring.js` — 5 unlinked

##### Proposed umbrella issue: Bring up the tcp-netstring network device's request and logging hygiene

`packages/daemon/src/networks/tcp-netstring.js` has five TODOs that
cluster into a single bring-up effort:

> 1. L33 a stub `request('port to listen for public web socket
>    connections')` call is commented out.
> 2. L50 the `request()` API is awkward to respond to and lacks
>    defaults, type hints, and validation.
> 3. L68 the assigned port is not logged.
> 4. L85 and L144 inbound and outbound connection logs omit the
>    listen and connect addresses.
>
> Tighten the device's bootstrap so it requests the listening
> address through a typed prompt, logs the assigned port and the
> peer addresses on accept and connect, and adds basic shape
> validation to `request()`.

- **L33** `TODO`
- **L50** `TODO make responding to this less of a pain.`
- **L68** `TODO log assigned port`
- **L85** `TODO listen and connect addresses should be logged`
- **L144** `TODO listen and connect addresses should be logged`

#### `packages/daemon/src/pet-store.js` — 2 unlinked

- **L186** `TODO consider retaining a backlog of deleted names for recovery`
- **L223** `TODO consider retaining a backlog of overwritten names for recovery`
  - **Proposed issue:** `pet-store: retain a backlog of deleted and overwritten names for recovery`

    > `packages/daemon/src/pet-store.js:186` (delete) and `:223`
    > (rename overwriting an existing pet name) drop the prior
    > mapping with no way to recover from a misclick.
    > Either add a bounded undo log (with a configurable retention
    > limit) or document why the operations are intentionally
    > destructive and remove the TODOs.

#### `packages/daemon/src/remote-control.js` — 1 unlinked

- **L44** `TODO: For the case where we leave a peer wedged half-open, we`
  - **Proposed issue:** `remote-control: add health checks for half-open peer connections`

    > `packages/daemon/src/remote-control.js:44` documents that the
    > daemon currently treats every duplicate inbound connection as
    > a lost race, which leaves wedged half-open connections in
    > place.
    > Add a health check (for example a periodic ping or
    > heartbeat) so a stale connection can be replaced when the
    > peer restarts without disrupting healthy connections.

#### `packages/daemon/src/serve-private-port-http.js` — 3 unlinked

##### Proposed umbrella issue: Finish the daemon's serve-private-port-http endpoints

`packages/daemon/src/serve-private-port-http.js` has three TODOs in
the private HTTP path:

> 1. L37 the `/bootstrap.js` route should be served by a readable
>    mutable file formula with a file watcher rather than recursing
>    into the bootstrap to fetch the script.
> 2. L60 the `connect()` handler needs to select an attenuated
>    bootstrap based on the subdomain instead of using the full
>    bootstrap.
> 3. L87 the bootstrap pings the web client once on connect; the
>    daemon should set up a heart-monitor for liveness.
>
> Land these together (mutable-file formula plus subdomain-scoped
> attenuation plus heart monitor) since they all reshape the same
> private HTTP serving path. Note the same pattern repeats in
> `packages/daemon/src/web-server-node.js`.

- **L37** `TODO readable mutable file formula (with watcher?)`
- **L60** `TODO select attenuated bootstrap based on subdomain`
- **L87** `TODO set up heart monitor`

#### `packages/daemon/src/types.d.ts` — 3 unlinked

- **L167** `TODO formula slots`
- **L210** `TODO formula slots`
- **L218** `TODO formula slots`
  - **Proposed issue:** `Define formula slots for eval, make-unconfined, and make-bundle formulas`

    > `packages/daemon/src/types.d.ts:167`, `:210`, `:218` mark the
    > eval, make-unconfined, and make-bundle formula types as
    > requiring "formula slots".
    > Define the slot shape (likely a typed positional list of
    > formula identifiers with a corresponding parameter index in
    > the source) and update the formula types and consumers
    > accordingly.

#### `packages/daemon/src/web-server-node-powers.js` — 3 unlinked

- **L47** `TODO Node.js headers are a far more detailed type.`
  - **Proposed issue:** `Tighten Node.js header type in web-server-node-powers respond shim`

    > `packages/daemon/src/web-server-node-powers.js:47` casts
    > `req.headers` to a permissive `Record<string, string |
    > Array<string> | undefined>`.
    > Replace the cast with the precise `IncomingHttpHeaders` type
    > from `@types/node` (or a hardened subset that survives
    > pass-style coercion).
- **L91** `TODO: Log this error locally.`
  - **Proposed issue:** `Log internal-server-error origins in web-server-node-powers`

    > `packages/daemon/src/web-server-node-powers.js:91` swallows
    > the original error before responding 500.
    > Log the error locally (with a sanitized message) so daemon
    > operators can diagnose 500s.
- **L123** `TODO Ignoring back-pressure signal:`
  - **Proposed issue:** `Honor WebSocketServer back-pressure when piping bytes`

    > `packages/daemon/src/web-server-node-powers.js:123` calls
    > `sink.next(bytes)` without awaiting the writer's
    > back-pressure signal because it is unclear whether
    > WebSocketServer pauses the underlying socket on its own.
    > Confirm WebSocketServer's behavior and either await the
    > sink or implement bounded buffering with explicit pause and
    > resume.

#### `packages/daemon/src/web-server-node.js` — 2 unlinked

- **L89** `TODO readable mutable file formula (with watcher?)`
- **L138** `TODO set up heart monitor`
  - See related umbrella for `packages/daemon/src/serve-private-port-http.js`
    above. The same readable-mutable-file and heart-monitor
    requirements apply to `web-server-node.js`.

#### `packages/daemon/test/endo.test.js` — 1 unlinked

- **L164** `TODO: We should be able to use {import('../src/types').EndoHost} for 'host',`
  - **Proposed issue:** `endo.test.js: replace 'any' host type with EndoHost laundered through E()`

    > `packages/daemon/test/endo.test.js:164` documents that typing
    > the test helper's `host` parameter as `EndoHost` collapses to
    > `never` once it goes through `E()`.
    > Investigate whether the issue is in `E()`'s type or in
    > `EndoHost`'s exo guard, fix the underlying inference, and
    > replace the `any` annotation in `doMakeBundle` with the
    > correct type.

### `@endo/errors`

#### `packages/errors/index.js` — 1 unlinked

- **L80** `XXX module exports fail if these aren't in scope`
  - **Proposed action: delete the comment**

    > `packages/errors/index.js:80` is a `// XXX` note above an
    > `@import` JSDoc directive explaining a present-day quirk of
    > the TypeScript compiler in this project: type-only imports
    > must be in scope for re-exported symbols to typecheck.
    > The comment describes the safety check that is in force, not
    > future work.
    > Replace the `XXX` keyword with a regular comment (or delete
    > the line entirely) so the hygiene scan stops counting it.

### `@endo/eslint-plugin`

#### `packages/eslint-plugin/lib/rules/harden-exports.js` — 4 unlinked

##### Proposed umbrella issue: Reclassify `@ts-expect-error xxx` markers in `@endo/eslint-plugin`

`packages/eslint-plugin/lib/rules/harden-exports.js` lines 50, 52, 81,
and 84 suppress AST type errors because the rule walks
`exportNode.declaration.declarations[i]`, `declaration.id.name`, and
`statement.expression.callee.name` without narrowing the ESLint AST
union types.
Either narrow the AST nodes explicitly using ESTree's discriminated
unions (so the suppressions become unnecessary) or replace the `xxx`
keyword with a non-TODO marker (for example a doc comment) so the
hygiene scan stops counting them.

- **L50** `@ts-expect-error xxx typedef`
- **L52** `@ts-expect-error xxx typedef`
- **L81** `@ts-expect-error xxx typedef`
- **L84** `@ts-expect-error xxx typedef`

#### `packages/eslint-plugin/lib/rules/restrict-comparison-operands.js` — 1 unlinked

- **L37** `TODO: 'allowMixedNumerics: { type: "boolean" }'?`
  - **Proposed issue:** `restrict-comparison-operands: decide on allowMixedNumerics option`

    > `packages/eslint-plugin/lib/rules/restrict-comparison-operands.js:37`
    > leaves a placeholder for an `allowMixedNumerics` rule option.
    > Decide whether the rule should accept comparisons between
    > `number` and `bigint` under an opt-in flag, then either add
    > the option (with documented behavior and tests) or delete the
    > TODO.

### `@endo/evasive-transform`

#### `packages/evasive-transform/src/generate.js` — 1 unlinked

- **L7** `@ts-ignore XXX no types defined`
  - **Proposed issue:** `Tighten Babel generator typing in evasive-transform/generate.js`

    > `packages/evasive-transform/src/generate.js:7` uses
    > `@ts-ignore XXX` to import `@babel/generator`.
    > `@babel/generator` does ship a default-export type declaration
    > but the consumer-side interop pattern
    > (`babelGenerator.default || babelGenerator`) confuses the
    > inference.
    > Either upgrade to Babel 8 (the comment notes this likely
    > resolves the issue) or rewrite the import using `* as` syntax
    > with an explicit type assertion so the suppression can be
    > deleted.

#### `packages/evasive-transform/src/parse-ast.js` — 1 unlinked

- **L27** `XXX returns 'any' to work around: The inferred type of 'parseAst' cannot be named without a reference to '@babel/parser/node_modules/@bab...`
  - **Proposed issue:** `parse-ast.js: type parseAst's return without a nested-node_modules reference`

    > `packages/evasive-transform/src/parse-ast.js:27` returns `any`
    > to dodge `tsc`'s "inferred type cannot be named without a
    > reference to `@babel/parser/node_modules/@babel/types`"
    > diagnostic, which arises when nested transitive `@babel/types`
    > installs differ from the top-level one.
    > Pin `@babel/types` to a single version across the workspace
    > or annotate the return with a top-level
    > `import('@babel/types').File` so the cast can be removed.

### `@endo/eventual-send`

#### `packages/eventual-send/src/E.js` — 3 unlinked

##### Proposed umbrella issue: Reclassify `@ts-expect-error XXX/FIXME` markers in `@endo/eventual-send`

`@ts-expect-error` markers in `@endo/eventual-send` (E.js lines 211,
225, 249, and `eventual-send.test.js:14`) suppress complaints about
proxy constructor signatures and the missing `test.onFinish` typing on
AVA's exported test object.
The cross-cutting note in this report points out that the proxy ones
are downstream of microsoft/TypeScript#61838.
Either link each marker to a real type-fixing tracker (the upstream
TypeScript issue for the proxy ones, an AVA typing PR for `onFinish`)
or replace the `XXX` / `FIXME` keyword with a non-TODO marker so the
hygiene scan stops counting them.

- **L211** `@ts-expect-error XXX typedef`
- **L225** `@ts-expect-error XXX typedef`
- **L249** `@ts-expect-error XXX typedef`

#### `packages/eventual-send/src/handled-promise.js` — 1 unlinked

- **L573** `FIXME: This is really ugly to bypass the type system, but it will be better`
  - **Proposed issue:** `handled-promise.js: drop type-system bypass when migrating to Promise.delegate`

    > `packages/eventual-send/src/handled-promise.js:573` casts the
    > internal `baseHandledPromise` constructor onto `HandledPromise`
    > with `@ts-expect-error cast` because the current shim has
    > `[[Construct]]` semantics that confuse the inferred type.
    > Once `Promise.delegate` lands and HandledPromise no longer
    > acts as a constructor, remove the cast.

#### `packages/eventual-send/src/local.js` — 1 unlinked

- **L14** `TODO Consolidate with 'isPrimitive' that's currently in '@endo/pass-style'.`
  - See `Consolidate isPrimitive across @endo packages` umbrella
    below; the same TODO appears in `@endo/ses/src/commons.js:362`,
    `@endo/harden/make-hardener.js:142`,
    `@endo/promise-kit/src/memo-race.js:34`, and
    `@endo/eventual-send/src/local.js:14`.

##### Proposed umbrella issue: Consolidate `isPrimitive` across `@endo` packages

Four packages duplicate an `isPrimitive(val)` helper because the
underlying layering does not yet allow them to share one source:

> 1. `packages/eventual-send/src/local.js:14`
> 2. `packages/harden/make-hardener.js:142`
> 3. `packages/promise-kit/src/memo-race.js:34`
> 4. `packages/ses/src/commons.js:362`
>
> Each TODO points at the existing `isPrimitive` in
> `@endo/pass-style` and notes the layering constraint.
> Decide on a layer-bottom utility package (for example
> `@endo/common`, or a new `@endo/primitives`) that all of the
> above can import, then remove the duplicates.
> If the layering constraint truly cannot be lifted, replace the
> TODOs with explanatory comments so the hygiene scan stops
> counting them.

#### `packages/eventual-send/src/message-breakpoints.js` — 1 unlinked

- **L143** `TODO enable function breakpointing`
  - **Proposed issue:** `message-breakpoints: support breakpoints on function-presence sends`

    > `packages/eventual-send/src/message-breakpoints.js:143`
    > short-circuits to `return false` whenever `methodName` is
    > undefined or null, which is the case for function-presence
    > calls (i.e. `E(fn)(...)`).
    > Add a separate breakpoint table keyed by recipient class for
    > function-presence sends so users can break on E(fn)(...) calls.

#### `packages/eventual-send/src/no-shim.js` — 1 unlinked

- **L3** `XXX module exports for HandledPromise fail if these aren't in scope`
  - **Proposed action: delete the comment**

    > `packages/eventual-send/src/no-shim.js:3` is a `// XXX` note
    > above an `@import` JSDoc directive describing the present
    > behavior of `tsc` (type-only imports must be in scope for
    > re-exports to typecheck), not future work.
    > Replace the `XXX` keyword with a regular comment or delete
    > the line so the hygiene scan stops counting it.

#### `packages/eventual-send/test/eventual-send.test.js` — 2 unlinked

- **L14** `@ts-expect-error FIXME onFinish does not exist`
  - See umbrella above:
    `Reclassify @ts-expect-error XXX/FIXME markers in @endo/eventual-send`.
- **L211** `TODO: define a function presence instead.`
  - **Proposed issue:** `eventual-send tests: cover function-presence resolutions`

    > `packages/eventual-send/test/eventual-send.test.js:211` uses
    > `rwp(handler2)` as a placeholder where the test really wants
    > a function presence.
    > Add a function-presence helper and rewrite the case so it
    > exercises `applyFunction` against a properly resolved
    > function presence.

### `@endo/exo`

#### `packages/exo/src/types.d.ts` — 1 unlinked

- **L122** `TODO Though note that only the virtual and durable exos currently`
  - **Proposed issue:** `Enforce stateShape in heap exos`

    > `packages/exo/src/types.d.ts:122` documents that only the
    > virtual and durable exos enforce the `stateShape` invariant.
    > The heap exos accept the option silently.
    > Either implement runtime enforcement of `stateShape` in heap
    > exos (so the invariant holds across zones) or downgrade the
    > documentation to acknowledge the heap zone difference.

#### `packages/exo/test/_prepare-test-env-ava-label-instances.js` — 1 unlinked

- **L6** `TODO consider adding env option setting APIs to @endo/env-options`
  - See umbrella below covering both this and
    `packages/ses-ava/prepare-endo.js:10`.

##### Proposed umbrella issue: Add an env-option setter API to `@endo/env-options`

Two prepare-test-env scripts construct `globalThis.process.env`
mutations by hand because `@endo/env-options` only offers a reader
API:

> 1. `packages/exo/test/_prepare-test-env-ava-label-instances.js:6`
> 2. `packages/ses-ava/prepare-endo.js:10`
>
> Add a small setter API to `@endo/env-options`
> (for example `addEnvironmentOption(name, value)`) so test setup
> code does not need to manipulate `process.env` directly.

#### `packages/exo/test/exo-wobbly-point.test.js` — 2 unlinked

- **L76** `TODO not true for other zones. May make heap zone more like`
- **L198** `But other zones insist on at least passability, and TODO we may eventually`
  - **Proposed issue:** `exo: align heap zone state and presence handling with virtual/durable zones`

    > `packages/exo/test/exo-wobbly-point.test.js:76` and `:198`
    > document two divergences between the heap zone and the
    > virtual or durable zones: heap exos accept mutable
    > non-frozen `state` records, and heap exos do not require
    > injected callbacks to be passable.
    > Decide whether the heap zone should be brought in line with
    > the others (so test fixtures stop documenting the gap) or
    > whether the divergence is intentional (and the comments
    > should be reworded as documentation, not TODOs).

#### `packages/exo/test/heap-classes.test.js` — 2 unlinked

- **L45** `TODO M.number() should not be needed to get a better error message`
- **L52** `TODO M.number() should not be needed to get a better error message`
- See umbrella below: also covers
  `packages/exo/test/non-enumerable-methods.test.js:12`.

##### Proposed umbrella issue: Improve M.gte error messages without requiring M.number()

Three exo tests share the same TODO:

> 1. `packages/exo/test/heap-classes.test.js:45`
> 2. `packages/exo/test/heap-classes.test.js:52`
> 3. `packages/exo/test/non-enumerable-methods.test.js:12`
>
> All three define an interface guard like
> `M.optional(M.and(M.number(), M.gte(0)))` purely so that
> non-number arguments produce a readable error message.
> Improve `M.gte` (and other `@endo/patterns` numeric matchers) so
> they emit a clear "must be a number" diagnostic on their own.
> Remove the redundant `M.number()` wrappers across the affected
> tests once the upstream matcher is fixed.

#### `packages/exo/test/non-enumerable-methods.test.js` — 2 unlinked

- **L12** `TODO M.number() should not be needed to get a better error message`
  - See umbrella above:
    `Improve M.gte error messages without requiring M.number()`.
- **L44** `FIXME typedef should catch bad arg`
  - **Proposed action: delete the FIXME**

    > `packages/exo/test/non-enumerable-methods.test.js:44` predates
    > the current interface-guard implementation, which now does
    > catch the bad argument and produces the asserted "Must be a
    > number" error.
    > The FIXME refers to a behavior the test already exercises
    > directly.
    > Delete the FIXME line.

#### `packages/exo/types-index.d.ts` — 1 unlinked

- **L39** `TODO: If TypeScript gains exact types for generic object literals, the`
  - **Proposed action: delete the TODO**

    > `packages/exo/types-index.d.ts:39` is conditioned on a
    > hypothetical TypeScript language feature ("exact types for
    > generic object literals") that does not exist and is not on
    > the TypeScript roadmap.
    > Replace the TODO with explanatory documentation, or delete
    > it, since there is no actionable engineering work without
    > the upstream feature.

### `@endo/harden`

#### `packages/harden/make-hardener.js` — 1 unlinked

- **L142** `TODO Consolidate with 'isPrimitive' that's currently in '@endo/pass-style'`
  - See `Consolidate isPrimitive across @endo packages` umbrella under
    `@endo/eventual-send`.

#### `packages/harden/test/make-hardener-shallow.test.js` — 1 unlinked

- **L117** `TODO: Use fast-check to generate arbitrary input.`
  - See umbrella below: `Adopt fast-check for hardener and key-collection tests`.

##### Proposed umbrella issue: Adopt fast-check for hardener and key-collection tests

Several tests carry an identical "Use fast-check to generate
arbitrary input" TODO:

> 1. `packages/harden/test/make-hardener.test.js:117`
> 2. `packages/harden/test/make-hardener-shallow.test.js:117`
> 3. `packages/ses/test/make-hardener.test.js:118`
> 4. `packages/patterns/test/copyBag.test.js:132`
> 5. `packages/patterns/test/copyMap.test.js:120`
> 6. `packages/patterns/test/copySet.test.js:93`
>
> Add `fast-check` (or another property-based testing library) as a
> dev dependency in the affected packages, then convert the
> hand-written input tables in each file to property-based generators.
> Track whether the existing repo already accepts a property-testing
> library before introducing a new dev dependency.

#### `packages/harden/test/make-hardener.test.js` — 1 unlinked

- **L117** `TODO: Use fast-check to generate arbitrary input.`
  - See umbrella above: `Adopt fast-check for hardener and key-collection tests`.

### `@endo/immutable-arraybuffer`

#### `packages/immutable-arraybuffer/src/immutable-arraybuffer-shim.js` — 1 unlinked

- **L78** `TODO, if the primordials are frozen after the prior implementation, such as`
  - **Proposed issue:** `immutable-arraybuffer-shim: clarify warning when primordials are frozen post-install`

    > `packages/immutable-arraybuffer/src/immutable-arraybuffer-shim.js:78`
    > notes that if SES `lockdown` runs between a prior shim's
    > installation and this shim's load, then `arrayBufferPrototype`
    > is frozen and the existing "warning text will be confusing."
    > Detect the frozen-prototype case and emit a more accurate
    > warning (or skip the overwrite attempt entirely) so users do
    > not see misleading messages.

### `@endo/import-bundle`

#### `packages/import-bundle/src/compartment-wrapper.js` — 1 unlinked

- **L85** `different). TODO: update this when that happens, we need something`
  - **Proposed issue:** `import-bundle compartment-wrapper: track upcoming child-compartment divergence`

    > `packages/import-bundle/src/compartment-wrapper.js:85` notes
    > that the present implementation relies on child compartments
    > behaving identically to the parent, which is expected to
    > change as their module tables diverge.
    > Once the divergence lands in `@endo/ses` (or
    > `@endo/compartment-mapper`), update the wrapper to wrap the
    > child compartment's own `Compartment` rather than reassigning
    > the parent's `NewCompartment` into the child globalThis.

### `@endo/marshal`

#### `packages/marshal/src/dot-membrane.js` — 3 unlinked

##### Proposed umbrella issue: Tighten dot-membrane converter typing and revocation

`packages/marshal/src/dot-membrane.js` collects three TODOs around the
membrane-converter machinery:

> 1. L21 `makeConverter` accepts a `mirrorConverter` typed as `any`
>    and notes that a real `Converter` type should be defined.
> 2. L59 the cross-side promise-rejection path catches a
>    `metaReason` that is then passed back through `pass`; verify
>    that `metaReason` is provably my-side-safe (or that the
>    pass-back is your-side-safe).
> 3. L78 the `myMethodToYours` closure captures `mineIf` from the
>    outer scope, which means revocation cannot be observed for
>    GC.  Restructure the scoping so that post-revoke garbage
>    collection of `mine` is observable.
>
> Land these together since they all sharpen the membrane's
> security and performance contract.

- **L21** `TODO(erights): Add Converter type`
- **L59** `TODO verify that metaReason must be my-side-safe, or rather,`
- **L78** `TODO Could rewrite to keep scopes more separate, so post-revoke`

#### `packages/marshal/src/encodePassable.js` — 4 unlinked

##### Proposed umbrella issue: encodePassable: reject forbidden encodings, decode nested arrays once, implement byteArray

`packages/marshal/src/encodePassable.js` has four TODOs along the
encoder/decoder roundtrip:

> 1. L231 the bigint decoder for type prefix `n` does not assert
>    against forbidden encodings like `n0:`, `n00:...`, or
>    `n91:...` through `n99:...`.
> 2. L241 the bigint decoder similarly does not reject `n9:0`,
>    `n8:00`, or `n8:91` through `n8:99`.
> 3. L371 nested arrays are validated during outer-array decoding
>    but their decoded contents are discarded; consider caching
>    them rather than decoding twice.
> 4. L481 `encodeByteArray` is unimplemented and currently throws
>    `Fail` at runtime.
>
> A single change set can land the four together (well-formed-input
> rejection, byteArray support, nested-array reuse), since they all
> touch the encoder/decoder pair.

- **L231** `TODO Assert to reject forbidden encodings`
- **L241** `TODO Assert to reject forbidden encodings`
- **L371** `TODO: Since the syntax of nested arrays must be validated as part of`
- **L481** `TODO implement`

#### `packages/marshal/src/encodeToCapData.js` — 4 unlinked

##### Proposed umbrella issue: encodeToCapData: canonical-JSON ordering, byteArray, deprecated qclass cleanup, Hilbert rest assertion

`packages/marshal/src/encodeToCapData.js` has four TODOs that share
the encoder's ordering and shape concerns:

> 1. L110 the implementation depends on the textual order of object
>    literals to produce a canonical encoding for non-record
>    properties; switching to a canonical-JSON encoder would make
>    the canonicalness modular.
> 2. L197 the `byteArray` case is unimplemented and currently
>    throws.
> 3. L356 the deprecated `@@asyncIterator` qclass should become
>    conditional on an environment variable and eventually be
>    removed once no senders rely on it.
> 4. L409 the Hilbert-Hotel `rest` decoding does not assert that
>    `passStyleOf(rest)` is `'copyRecord'` because hardening would
>    be premature.
>
> Each item touches the same encoder; consider one tracker that
> covers the whole canonicalization and shape-validation effort.

- **L110** `they are literally written below. TODO perhaps we should indeed switch`
- **L197** `TODO implement`
- **L356** `Deprecated qclass. TODO make conditional`
- **L409** `TODO really should assert that 'passStyleOf(rest)' is`

#### `packages/marshal/src/encodeToSmallcaps.js` — 4 unlinked

##### Proposed umbrella issue: encodeToSmallcaps: define encoding types, canonical-JSON ordering, byteArray support

`packages/marshal/src/encodeToSmallcaps.js` carries four TODO and
FIXME markers that overlap with the `encodeToCapData.js` umbrella:

> 1. L23 `SmallcapsEncoding` and `SmallcapsEncodingUnion` are
>    aliased to `any`; define actual types.
> 2. L156 the encoder depends on the textual order of object
>    literals (parallel to the capdata case).
> 3. L233 `byteArray` is unimplemented (parallel to the capdata
>    case).
> 4. L394 `@ts-ignore XXX SmallCapsEncoding` suppresses the
>    `passStyleOf(result)` check downstream of the `any`-typed
>    encoding.
>
> Defining the types in (1) is likely a prerequisite for removing
> the `@ts-ignore` in (4). Group with the capdata umbrella above
> if both are tackled in the same change.

- **L23** `FIXME define actual types`
- **L156** `they are literally written below. TODO perhaps we should indeed switch`
- **L233** `TODO implement`
- **L394** `@ts-ignore XXX SmallCapsEncoding`

#### `packages/marshal/src/marshal-justin.js` — 2 unlinked

- **L139** `TODO now that ibids are gone, we should fold this back together into`
  - **Proposed issue:** `marshal-justin: fold validating pass back into the recur pass`

    > `packages/marshal/src/marshal-justin.js:139` notes that the
    > decoder runs an explicit validating pass mirroring `recur`
    > because the original code supported ibid backrefs.
    > Now that ibids are gone, the two passes can be merged so
    > there is only one traversal.
- **L323** `TODO deprecated. Eventually remove.`
  - **Proposed issue:** `marshal-justin: remove deprecated @@asyncIterator qclass`

    > `packages/marshal/src/marshal-justin.js:323` still emits
    > `Symbol.asyncIterator` for the deprecated `@@asyncIterator`
    > qclass.
    > Coordinate with the parallel deprecation tracking in
    > `encodeToCapData.js:356` and remove once no senders rely on
    > the legacy qclass.

#### `packages/marshal/src/marshal-stringify.js` — 1 unlinked

- **L41** `TODO fix tests to works with smallcaps.`
  - **Proposed issue:** `marshal-stringify: switch default to smallcaps and update tests`

    > `packages/marshal/src/marshal-stringify.js:41` hard-codes
    > `serializeBodyFormat: 'capdata'` because the existing tests
    > do not pass under `smallcaps`.
    > Update the tests to be format-agnostic, then flip the default
    > to `smallcaps`.

#### `packages/marshal/src/marshal.js` — 6 unlinked

##### Proposed umbrella issue: Marshal hardening pass: iface assertions, error fields, slot disambiguation, smallcaps types

`packages/marshal/src/marshal.js` collects six TODOs along the same
hot path:

> 1. L86 `encodeSlotCommon` does not assert that the cached iface
>    matches the new request.
> 2. L113 `encodeErrorCommon` does not yet encode `cause` or
>    `errors`; it should do so once all decoders tolerate them.
> 3. L195 the smallcaps slot encoder has a special case for
>    `iface === undefined`; explore removing it.
> 4. L250 SECURITY HAZARD: `decodeSlotCommon` does not enforce
>    that the encoded distinction between remotable and promise
>    matches what the caller requested.
> 5. L374 and L376 `@ts-ignore XXX SmallCapsEncoding` because
>    smallcaps's encoding type is `any`. (Resolved when
>    `encodeToSmallcaps.js` defines real types.)
>
> Issue 4 is a security gap and should be the highest priority
> within this group.

- **L86** `TODO assert that it's the same iface as before`
- **L113** `TODO Must encode 'cause', 'errors', but`
- **L195** `TODO explore removing this special case`
- **L250** `TODO SECURITY HAZARD: must enfoce that remotable vs promise`
- **L374** `@ts-ignore XXX SmallCapsEncoding`
- **L376** `@ts-ignore XXX SmallCapsEncoding`

#### `packages/marshal/src/rankOrder.js` — 2 unlinked

- **L47** `but TODO we need a better name for the API.`
  - **Proposed issue:** `rankOrder: rename sameValueZero to a public-ready name`

    > `packages/marshal/src/rankOrder.js:47` notes that
    > `sameValueZero` is the EcmaScript spec name for the equality
    > comparison used by the API but is not a great public name.
    > Pick a friendlier name (for example `sameKey` or
    > `keyEquality`) and rename the export, with a deprecation
    > shim if needed.
- **L390** `TODO assert on bug could lead to infinite recursion. Fix.`
  - **Proposed issue:** `rankOrder: avoid potential infinite recursion in assertRankSorted error path`

    > `packages/marshal/src/rankOrder.js:390` calls `sortByRank`
    > inside the `Fail` template tag of `assertRankSorted`.
    > If `sortByRank` itself triggers an assertion failure that
    > calls back into `assertRankSorted`, the recursion does not
    > terminate.
    > Either render the comparison summary lazily (so it is only
    > computed when the error is actually formatted) or cap the
    > diagnostic to a non-recursive helper.

#### `packages/marshal/test/encodePassable.test.js` — 1 unlinked

- **L343** `TODO: Make a common utility for finding the first difference between iterables.`
  - **Proposed issue:** `Add a shared firstDiff iterable utility for marshal tests`

    > `packages/marshal/test/encodePassable.test.js:343` defines
    > a private `commonStringPrefix` helper inline and points at a
    > hypothetical shared `firstDiff(a, b)` utility.
    > Promote the helper into `@endo/common` (or a marshal test
    > utilities module) so it can be reused by other diff-style
    > assertions.

#### `packages/marshal/test/marshal-capdata.test.js` — 1 unlinked

- **L17** `TODO: Remove after dropping support for pre-AggregateError implementations.`
  - See umbrella below: `Drop pre-AggregateError fallbacks across @endo`.

##### Proposed umbrella issue: Drop pre-AggregateError fallbacks across `@endo`

Several test files carry an identical TODO marking branches that
exist only to support engines that pre-date `AggregateError`:

> 1. `packages/marshal/test/marshal-capdata.test.js:17`
> 2. `packages/marshal/test/marshal-smallcaps.test.js:24`
> 3. `packages/ses/test/error/aggregate-error.test.js:8`
> 4. `packages/ses/test/error/aggregate-error-console.test.js:7`
> 5. `packages/ses/test/error/aggregate-error-console-demo.test.js:12`
>
> Confirm that all supported engines (Node 18+, modern XS, modern
> JSC, Hermes, etc.) ship `AggregateError`, then delete the
> `supportsAggregateError` checks and the `Error`-fallback paths.

#### `packages/marshal/test/marshal-justin.test.js` — 3 unlinked

##### Proposed umbrella issue: Make Justin work with smallcaps in marshal tests

`packages/marshal/test/marshal-justin.test.js` has three TODOs:

> 1. L55 `serialize decodeToJustin eval round trip pairs` test
>    forces `serializeBodyFormat: 'capdata'` because Justin does
>    not yet handle smallcaps.
> 2. L79 the indented round-trip test does the same.
> 3. L112 the diagnostic representation of slots in `qp` could
>    show slot contents through an outer `bestEffortsStringify`
>    rather than only by slot index.
>
> All three are gated on extending Justin's decoder to handle
> smallcaps. Track them together.

- **L55** `TODO make Justin work with smallcaps`
- **L79** `TODO make Justin work with smallcaps`
- **L112** `TODO maybe better would be to show the slot contents using an outer`

#### `packages/marshal/test/marshal-smallcaps.test.js` — 1 unlinked

- **L24** `TODO: Remove after dropping support for pre-AggregateError implementations.`
  - See umbrella above:
    `Drop pre-AggregateError fallbacks across @endo`.

#### `packages/marshal/test/rankOrder.test.js` — 1 unlinked

- **L166** `XXX This test is skipped because of unresolved impedance mismatch between the`
  - **Proposed issue:** `rankOrder: re-enable range queries test under string-encoded-key cover scheme`

    > `packages/marshal/test/rankOrder.test.js:166` skips a range
    > queries test because the cover scheme has migrated from
    > value-based to string-encoded-key-based but the test was not
    > updated.
    > As part of adding composite-key handling to the durable
    > store, update and re-enable the test.

#### `packages/marshal/tools/marshal-test-data.js` — 1 unlinked

- **L454** `TODO Probe UTF-16 vs Unicode vs UTF-8 (Moddable) ordering.`
  - **Proposed issue:** `marshal-test-data: probe UTF-16, Unicode, and UTF-8 string ordering across engines`

    > `packages/marshal/tools/marshal-test-data.js:454` notes that
    > the lexicographic-strings section of the rank-order golden
    > data assumes one specific code-unit ordering.
    > Add cases that distinguish UTF-16, Unicode codepoint, and
    > UTF-8 (Moddable XS) orderings so any future divergence is
    > caught explicitly.

### `@endo/memoize`

#### `packages/memoize/src/memoize.js` — 1 unlinked

- **L16** `(TODO turn into link once there's a URL)`
  - **Proposed issue:** `Replace memoize.md cross-reference with a documentation URL`

    > `packages/memoize/src/memoize.js:16` references the local
    > `memoize.md` file as the source of "Memoization Safety
    > properties".
    > Once the docs site renders the markdown to a stable URL,
    > update the comment with the URL and drop the TODO.

### `@endo/module-source`

#### `packages/module-source/DESIGN.md` — 1 unlinked

- **L152** `TODO Consider removing the import argument.`
  - **Proposed issue:** `module-source DESIGN.md: decide whether ExportAlls still needs the import argument`

    > `packages/module-source/DESIGN.md:152` calls out that the
    > `import` argument passed alongside `ExportAlls` does not
    > appear to be used by module instances.
    > Audit consumers, then either remove the argument from the
    > module functor signature or document the reason it stays.

#### `packages/module-source/src/module-source.js` — 1 unlinked

- **L58** `XXX implements import('ses').PrecompiledModuleSource but adding`
  - **Proposed issue:** `module-source: enable @implements PrecompiledModuleSource on ModuleSource factory`

    > `packages/module-source/src/module-source.js:58` notes that
    > attempting to annotate the factory with `@implements
    > import('ses').PrecompiledModuleSource` causes TypeScript to
    > complain because the value is a function rather than a
    > class.
    > Reshape the factory (for example by exposing a class
    > wrapper) or extend the JSDoc plugin to accept `@implements`
    > on factory-style exports, then add the annotation.

#### `packages/module-source/src/transform-analyze.js` — 2 unlinked

- **L1** `@ts-nocheck XXX Babel types`
  - See umbrella below:
    `Reclassify @ts-nocheck/@ts-expect-error markers in @endo/module-source`.
- **L143** `TODO: Provide a way to allow hardening of the import expression.`
  - **Proposed issue:** `module-source: allow callers to harden the injected import expression`

    > `packages/module-source/src/transform-analyze.js:143`
    > builds an `importExpr` function with a mutable `meta`
    > sub-object so it cannot be hardened by the caller.
    > Provide an opt-in shape (for example a separate
    > `hardenedImportExpr` accessor) that produces a hardened
    > `importExpr` for callers that want it.

#### `packages/module-source/src/transform-source.js` — 1 unlinked

- **L1** `@ts-nocheck XXX Babel types`
  - See umbrella below:
    `Reclassify @ts-nocheck/@ts-expect-error markers in @endo/module-source`.

##### Proposed umbrella issue: Reclassify `@ts-nocheck` and `@ts-expect-error` markers in `@endo/module-source`

`@endo/module-source` carries three TS suppression markers:

> 1. `packages/module-source/src/transform-analyze.js:1`
>    `@ts-nocheck XXX Babel types` disables type checking for the
>    whole file because `@babel/types` shape inference is unstable
>    in the workspace install.
> 2. `packages/module-source/src/transform-source.js:1` does the
>    same for the same reason.
> 3. `packages/module-source/test/_native.js:3` suppresses a
>    `globalThis.Compartment` typing error.
>
> Either pin `@babel/types` to a single workspace version (so the
> file-wide suppressions can be removed in favor of targeted
> assertions) and add a typed shim for `globalThis.Compartment`,
> or replace the `XXX` keyword with a non-TODO marker so the
> hygiene scan stops counting them.

#### `packages/module-source/test/_native.js` — 1 unlinked

- **L3** `@ts-expect-error XXX typedef`
  - See umbrella above:
    `Reclassify @ts-nocheck/@ts-expect-error markers in @endo/module-source`.

#### `packages/module-source/test/module-source.test.js` — 1 unlinked

- **L655** `TODO cross product let, class, maybe var:`
  - **Proposed issue:** `module-source: cross product hasOwnProperty test across let, class, var bindings`

    > `packages/module-source/test/module-source.test.js:655`
    > tests only the `const` form of an `Object.hasOwnProperty`
    > override.
    > Add cases for `let`, `class`, and possibly `var` bindings so
    > the analyzer's handling of the override mistake is exercised
    > across all binding kinds.

### `@endo/ocapn`

#### `packages/ocapn/src/captp/finalize.js` — 1 unlinked

- **L78** `it unregisters. TODO If this is not actually guaranteed, i.e., if`
  - This is a duplicate of the TODO at
    `packages/captp/src/finalize.js:78`.
    See that entry's proposed issue
    `Confirm FinalizationRegistry unregister suppresses pending finalizations`.
    Once filed, link both call sites to the same issue (or
    deduplicate the implementation between captp and ocapn).

### `@endo/panic`

#### `packages/panic/index.js` — 1 unlinked

- **L39** `TODO use Moddable XS print function if we can reliably distinguish it`
  - **Proposed issue:** `panic: emit panic message via Moddable XS print when console is unavailable`

    > `packages/panic/index.js:39` falls silent on engines that
    > lack `console.error`.
    > Detect Moddable XS reliably (perhaps via a host-provided
    > capability or feature test) and call its `print` function so
    > XS-only deployments still surface the panic message.

### `@endo/pass-style`

##### Proposed umbrella issue: Reclassify `@ts-expect-error XXX/xxx` markers in `@endo/pass-style`

`@endo/pass-style`'s test suite carries 14 `@ts-expect-error` markers
suppressing the same `passStyleOf` typing limitation:

> 1. `packages/pass-style/test/far-wobbly-point.test.js:70`, `:111`
> 2. `packages/pass-style/test/passStyleOf.test.js:230, 248, 259,
>    264, 277, 513, 522`
>
> The shared cause is that `passStyleOf`'s argument type currently
> rejects most heterogeneous `__proto__`-engineered remotables in
> these tests. Either tighten `PassStyleOf`'s union to admit the
> shapes the tests build, or replace the `XXX` / `xxx` keyword with
> a non-TODO marker so the hygiene scan stops counting them.

#### `packages/pass-style/doc/copyArray-guarantees.md` — 1 unlinked

- **L32** `Taken together, the security, robustness, and simplicity guarantees of 'assertCopyArray(arr)' are similar to that provided by the "tuples...`
  - **Proposed issue:** `pass-style docs: link CopyArray guarantees to the Records and Tuples proposal`

    > `packages/pass-style/doc/copyArray-guarantees.md:32` mentions
    > the TC39 "Arrays and Tuples" proposal with a "(TODO need
    > link)" placeholder.
    > Insert the canonical proposal URL
    > (https://github.com/tc39/proposal-record-tuple) and remove
    > the placeholder.

#### `packages/pass-style/doc/copyRecord-guarantees.md` — 1 unlinked

- **L36** `Taken together, the security, robustness, and simplicity guarantees of 'assertRecord(r)' are similar to that provided by the "records" of...`
  - **Proposed issue:** `pass-style docs: link CopyRecord guarantees to the Records and Tuples proposal`

    > `packages/pass-style/doc/copyRecord-guarantees.md:36`
    > mirrors the placeholder in `copyArray-guarantees.md:32` for
    > the records side of the proposal.
    > Add the canonical link and remove the placeholder.

#### `packages/pass-style/src/copyRecord.js` — 1 unlinked

- **L38** `TODO: Update message now that there is no such thing as "implicit Remotable".`
  - **Proposed issue:** `copyRecord: refresh error message that mentions "implicit Remotable"`

    > `packages/pass-style/src/copyRecord.js:38` rejects records
    > containing non-far functions with a message that warns about
    > "implicit Remotable", a concept that was removed.
    > Reword the message to describe the actual constraint
    > (records cannot contain methods of any object).

#### `packages/pass-style/src/deeplyFulfilled.js` — 4 unlinked

- **L20** `TODO Should migrate here and then, if needed, reexported there.`
- **L30** `TODO Should migrate here and then, if needed, reexported there.`
- **L37** `TODO Should migrate here and then, if needed, reexported there.`
- **L47** `TODO Should migrate here and then, if needed, reexported there.`
  - **Proposed issue:** `deeplyFulfilled: own the Simplify, Callable, DeeplyAwaited, and DeeplyAwaitedObject typedefs`

    > `packages/pass-style/src/deeplyFulfilled.js:20`, `:30`,
    > `:37`, `:47` each mark a typedef as currently copied from
    > `@agoric/internal/utils.js`.
    > Move the four type definitions (`Simplify`, `Callable`,
    > `DeeplyAwaited`, `DeeplyAwaitedObject`) into a public
    > location in `@endo/pass-style` (or a shared types module),
    > then re-export from `@agoric/internal` if it still needs
    > them.

#### `packages/pass-style/src/error.js` — 2 unlinked

- **L157** `TODO: Maintenance hazard: Coordinate with the list of errors in the SES`
  - **Proposed issue:** `pass-style/error.js: share error-constructor list with SES whitelist`

    > `packages/pass-style/src/error.js:157` maintains a hand-coded
    > `errorConstructors` map that must stay in sync with the SES
    > whitelist.
    > Either consume the canonical list from `@endo/ses` (so the
    > coordination is a single source of truth) or add a CI check
    > that verifies the two lists match.
- **L203** `TODO: Need a better test than instanceof`
  - **Proposed issue:** `pass-style: replace error instanceof check with a structural test`

    > `packages/pass-style/src/error.js:203` uses
    > `candidate instanceof Error` to recognize errors, which
    > misses errors crossing realm boundaries.
    > Use a structural check (presence of `name`, `message`,
    > prototype on the realm's known error classes) so realm-
    > foreign errors round-trip correctly.

#### `packages/pass-style/src/make-far.js` — 1 unlinked

- **L87** `TODO: When iface is richer than just string, we need to get the allegedName`
  - **Proposed issue:** `make-far: handle non-string iface when extracting allegedName`

    > `packages/pass-style/src/make-far.js:87` extracts
    > `allegedName` from `iface` assuming `iface` is a string.
    > Once `iface` can be a richer pure-data shape, update the
    > extraction to handle that shape (or document the gap as
    > intentional).

#### `packages/pass-style/src/passStyleOf.js` — 4 unlinked

- **L103** `it does have some observability on proxies. TODO need to assess`
  - **Proposed issue:** `passStyleOf: assess whether passStyleMemo creates a static communications channel`

    > `packages/pass-style/src/passStyleOf.js:103` notes that the
    > module-level `passStyleMemo` WeakMap is mutable static state
    > with limited observability through Proxy traps.
    > Conduct an audit (with worked examples of plausible attacks
    > by Proxy authors) and either justify the cache, scope it, or
    > replace it with a per-instance equivalent.
- **L293** `TODO Adopt a more flexible notion of passable error, in which`
- **L350** `TODO Adopt a more flexitble notion of throwable, in which`
- **L366** `This will need to be fixed to do the TODO above.`
  - **Proposed issue:** `passStyleOf: extend passable error and throwable to allow throwable own data`

    > `packages/pass-style/src/passStyleOf.js:293`, `:350`, and
    > `:366` describe a planned generalization where:
    >
    > 1. a passable error may carry additional own data
    >    properties whose values are themselves throwable, and
    > 2. `toThrowable` recursively coerces nested non-passable
    >    errors inside otherwise-passable containers.
    >
    > Land both extensions together since the second depends on
    > the first.

#### `packages/pass-style/src/remotable.js` — 3 unlinked

- **L23** `TODO HAZARD Because we check this on the way to hardening a remotable,`
  - **Proposed issue:** `pass-style: close canBeMethod inheritance-after-check hazard`

    > `packages/pass-style/src/remotable.js:23` documents a hazard:
    > `canBeMethod` cannot assert that `func` is hardened because
    > the check runs on the way to hardening.
    > Without that assertion, `func`'s prototype chain may change
    > after the `PASS_STYLE` check, undermining the invariant.
    > Identify a safe ordering (or an alternative invariant) that
    > closes this gap, possibly by checking the prototype chain at
    > a different stage.
- **L78** `TODO other possible ifaces, once we have third party veracity`
  - **Proposed issue:** `pass-style: extend confirmIface to allow non-string ifaces with third-party veracity`

    > `packages/pass-style/src/remotable.js:78` allows only string
    > ifaces.
    > Once a third-party veracity scheme exists, broaden
    > `confirmIface` to accept richer iface shapes (and update the
    > error message accordingly).
- **L121** `TODO: It would be nice to typedef this shape, but we can't declare a type`
  - **Proposed issue:** `pass-style: typedef the tag-record shape with PASS_STYLE in JSDoc`

    > `packages/pass-style/src/remotable.js:121` notes that the
    > tag-record shape `{ [PASS_STYLE]: string,
    > [Symbol.toStringTag]: string }` cannot be expressed in JSDoc
    > because PASS_STYLE is a Symbol.
    > Either move the typedef into a `.d.ts` (which can use
    > computed-property keys) and import it from JSDoc, or wait
    > for the JSDoc parser to grow the syntax.

#### `packages/pass-style/src/safe-promise.js` — 1 unlinked

- **L68** `TODO should we also enforce anything on the contents of the string,`
  - **Proposed issue:** `safe-promise: decide whether Symbol.toStringTag value must start with "Promise"`

    > `packages/pass-style/src/safe-promise.js:68` allows a
    > promise's `Symbol.toStringTag` to take any string value.
    > Decide whether passable promises must advertise a tag that
    > starts with `'Promise'`, then either tighten the check or
    > delete the TODO.

#### `packages/pass-style/src/string.js` — 1 unlinked

- **L73** `TODO once the switch is removed, simplify 'assertPassableString' to`
  - **Proposed issue:** `pass-style: remove the ONLY_WELL_FORMED_STRINGS_PASSABLE switch`

    > `packages/pass-style/src/string.js:73` notes that once the
    > `ONLY_WELL_FORMED_STRINGS_PASSABLE` env-options switch is
    > removed (after performance-impact assessment), the assertion
    > can simplify to a direct call to `assertWellFormedString`.
    > Track the assessment and the switch's eventual removal.

#### `packages/pass-style/src/types.d.ts` — 1 unlinked

- **L154** `TODO SECURITY BUG we plan to enforce this, giving PureData the same security`
  - **Proposed issue:** `pass-style: enforce no-Proxy invariant for PureData containers`

    > `packages/pass-style/src/types.d.ts:154` documents a security
    > BUG: PureData is supposed to be free of Proxy instances so it
    > cannot serve as a side channel, but no runtime enforcement
    > exists yet.
    > Implement a check that rejects Proxy-based containers in the
    > PureData path, then update the surrounding doc to point at
    > the non-trapping shim.

#### `packages/pass-style/src/types.test-d.ts` — 1 unlinked

- **L68** `FIXME promise for a non-Passable is not Passable`
  - **Proposed issue:** `pass-style: tighten Passable type so Promise<NonPassable> is rejected`

    > `packages/pass-style/src/types.test-d.ts:68` documents that
    > `Promise.resolve(fn)` (where `fn` is not Passable) currently
    > typechecks as Passable but should not.
    > Refine the `Passable` recursive type so promises only count
    > when their fulfillment type is itself Passable.

#### `packages/pass-style/test/deeplyFulfilled.test.js` — 1 unlinked

- **L8** `TODO extend to test cases unique to deeplyFulfilled, i.e. primitives`
  - **Proposed issue:** `deeplyFulfilled tests: cover primitives, byteArray, tagged, and error cases`

    > `packages/pass-style/test/deeplyFulfilled.test.js:8` says
    > the test was copied from `deeplyFulfilledObject` and only
    > exercises one shape.
    > Add cases for primitives, ByteArray, CopyTagged, errors,
    > and rejected promises so each branch of `deeplyFulfilled` is
    > covered.

#### `packages/pass-style/test/far-class-instances.test.js` — 2 unlinked

- **L63** `TODO message depends on JS engine, and so is a fragile golden test`
- **L117** `TODO message depends on JS engine, and so is a fragile golden test`
  - **Proposed issue:** `far-class-instances tests: replace fragile golden messages with regex matchers`

    > `packages/pass-style/test/far-class-instances.test.js:63`
    > and `:117` assert exact V8-specific TypeError messages
    > ("Class constructor ... cannot be invoked without 'new'" and
    > "Cannot define property z, object is not extensible").
    > Replace the literal messages with regex matchers that
    > tolerate engine variation, and add separate XS or JSC
    > assertions if engine-specific behavior matters.

#### `packages/pass-style/test/far-wobbly-point.test.js` — 3 unlinked

- **L70** `@ts-expect-error xxx typedef`
- **L111** `@ts-expect-error xxx typedef`
  - See umbrella `Reclassify @ts-expect-error XXX/xxx markers in
    @endo/pass-style` at the top of this section.
- **L130** `TODO great error message, but is a golden specific to v8`
  - **Proposed issue:** `far-wobbly-point: relax v8-specific private-field error message assertion`

    > `packages/pass-style/test/far-wobbly-point.test.js:130`
    > pins the test to V8's exact private-field violation message.
    > Replace the literal with a regex (or a per-engine table) so
    > the test passes on XS, JSC, and Hermes once they support
    > private-class-field syntax.

#### `packages/pass-style/test/passStyleOf.test.js` — 9 unlinked

- **L230** `@ts-expect-error XXX PassStyleOf`
- **L248** `@ts-expect-error XXX PassStyleOf`
- **L259** `@ts-expect-error XXX PassStyleOf`
- **L264** `@ts-expect-error XXX PassStyleOf`
- **L277** `@ts-expect-error XXX PassStyleOf`
- **L513** `@ts-expect-error XXX PassStyleOf`
- **L522** `@ts-expect-error XXX PassStyleOf`
  - See umbrella `Reclassify @ts-expect-error XXX/xxx markers in
    @endo/pass-style` at the top of this section.
- **L238** `TODO In order to run this test before we have explicit support for a`
- **L438** `TODO In order to run this test before we have explicit support for a`
  - **Proposed issue:** `passStyleOf tests: rewrite proto-not-frozen tests once non-trapping integrity trait lands`

    > `packages/pass-style/test/passStyleOf.test.js:238` and
    > `:438` document a workaround: the tests must `freeze` (not
    > `harden`) their inputs to verify that a non-frozen
    > `__proto__` is not passable, because there is no way to
    > make an object explicitly non-trapping today.
    > Once SES gains a non-trapping integrity trait (see
    > `packages/ses/docs/preparing-for-stabilize.md`), rewrite the
    > tests to mark inputs as non-trapping rather than partially
    > freezing them.

#### `packages/pass-style/tools/arb-passable.js` — 4 unlinked

- **L27** `TODO Once we flip symbol representation, we should revisit everywhere`
  - **Proposed issue:** `arb-passable: revisit @@-prefixed symbol special-case after symbol representation change`

    > `packages/pass-style/tools/arb-passable.js:27` filters out
    > symbol names beginning with `@@` to avoid hitting the
    > legacy passable-symbol representation.
    > Once the symbol representation flip lands, audit every
    > `@@`-related branch in arbitrary generators and remove the
    > filters that are no longer needed.
- **L100** `TODO: A valid copySet payload must be a reverse sorted array,`
- **L111** `TODO: A valid copyBag payload must be a reverse sorted array,`
- **L126** `TODO: In a valid copyMap payload, the keys must be a`
  - **Proposed issue:** `arb-passable: emit reverse-sorted payloads for copySet, copyBag, and copyMap`

    > `packages/pass-style/tools/arb-passable.js:100`, `:111`,
    > `:126` note that the arbitrary generators currently produce
    > only `uniqueArray` payloads for `copySet`, `copyBag`, and
    > `copyMap`, but a valid payload must be reverse sorted (with
    > the additional same-length keys/values requirement for
    > `copyMap`).
    > Extend the generators to produce reverse-sorted variants in
    > addition to the unsorted ones so property tests cover the
    > valid-payload path explicitly.

### `@endo/patterns`

##### Proposed umbrella issue: Reclassify `@ts-expect-error XXX Key types` markers in `@endo/patterns`

`@endo/patterns` carries five `@ts-expect-error XXX Key types` markers
that all stem from the gap between the `Key`/`Passable` runtime
contract and the static `Key` type:

> 1. `packages/patterns/src/keys/copyBag.js:103`
> 2. `packages/patterns/src/keys/keycollection-operators.js:31, 61, 64`
> 3. `packages/patterns/test/patterns.test.js:585`
>
> Either tighten the `Key` and `assertRankSorted` types so the
> suppressions become unnecessary, or replace the `XXX` keyword with a
> non-TODO marker (for example a doc comment) so the hygiene scan
> stops counting them.

#### `packages/patterns/CONTRIBUTING.md` — 2 unlinked

- **L7** `Guards do not yet exist as distinct kinds, so we ignore them for now. TODO: Expand this if kinds expand to include guards.`
  - **Proposed issue:** `patterns CONTRIBUTING.md: revisit guards-as-kinds wording when kinds expand`

    > `packages/patterns/CONTRIBUTING.md:7` notes that guards are not
    > yet kinds and asks the doc to be expanded if that ever changes.
    > Track whether endojs/endo#1737 (or successor patterns redesign)
    > introduces guards as kinds, then update the section accordingly.
- **L25** `TODO: Include a diagram visually demonstrating the following.`
  - **Proposed issue:** `patterns CONTRIBUTING.md: add Venn-style diagram of Passables and Patterns`

    > `packages/patterns/CONTRIBUTING.md:25` requests a visual diagram
    > of the Passables, Keys, Patterns, Data, Scalars, and Capabilities
    > relationships.
    > Add a Mermaid (or SVG) diagram to the section so the textual
    > set-theoretic explanation is augmented visually.

#### `packages/patterns/src/keys/checkKey.js` — 1 unlinked

- **L470** `TODO This`
  - **Proposed issue:** `checkKey: include reverse-rank-sort criterion in copyMap validation`

    > `packages/patterns/src/keys/checkKey.js:470` notes that
    > `makeCopyMap` reverse-rank-sorts entries, which would solve the
    > copyMap cover issue tracked in `patternMatchers.js`, but the
    > criterion is not validated when receiving a copyMap.
    > Add the validation so foreign-constructed copyMaps must satisfy
    > the same ordering invariant.

#### `packages/patterns/src/keys/copyBag.js` — 3 unlinked

- **L29** `TODO: If doing this reduntantly turns out to be expensive, we`
  - See umbrella below: `Memoize and consolidate keys-collection duplicate
    detection in @endo/patterns`.
- **L38** `TODO Once all our tooling is ready for '&&=', the following`
  - See umbrella below: `Adopt &&= and ||= operators across @endo/patterns
    keys helpers`.
- **L103** `@ts-expect-error XXX Key types`
  - See top-of-section umbrella
    `Reclassify @ts-expect-error XXX Key types markers in @endo/patterns`.

##### Proposed umbrella issue: Memoize and consolidate keys-collection duplicate detection in `@endo/patterns`

`packages/patterns/src/keys/copyBag.js:29` and
`packages/patterns/src/keys/copySet.js:29` carry the same TODO:
the duplicate-detection helpers re-enumerate the entire array on each
call. If profiling confirms the cost matters, memoize the
no-duplicate finding independent of the `fullOrder` used to reach it.
A single change set that adds the memo to both helpers (and shares
the underlying `confirmNoDuplicates` machinery) is more efficient
than two independent issues.

##### Proposed umbrella issue: Adopt `&&=` and `||=` operators across `@endo/patterns` keys helpers

`packages/patterns/src/keys/copyBag.js:38` and
`packages/patterns/src/keys/copySet.js:38` both note that once tooling
support is uniform, the `fullCompare = fullCompare || ...` lines
should be rewritten with the logical-assignment operators (`||=`).
Confirm that the project's prettier and ESLint configs accept the
operators, then sweep the patterns codebase converting in-place.

#### `packages/patterns/src/keys/copySet.js` — 2 unlinked

- **L29** `TODO: If doing this reduntantly turns out to be expensive, we`
  - See umbrella above:
    `Memoize and consolidate keys-collection duplicate detection in @endo/patterns`.
- **L38** `TODO Once all our tooling is ready for '&&=', the following`
  - See umbrella above:
    `Adopt &&= and ||= operators across @endo/patterns keys helpers`.

#### `packages/patterns/src/keys/keycollection-operators.js` — 3 unlinked

- **L31** `@ts-expect-error XXX Key types`
- **L61** `@ts-expect-error XXX Key types`
- **L64** `@ts-expect-error XXX Key types`
  - See top-of-section umbrella
    `Reclassify @ts-expect-error XXX Key types markers in @endo/patterns`.

#### `packages/patterns/src/keys/merge-bag-operators.js` — 1 unlinked

- **L17** `TODO share more code with that file and keycollection-operators.js.`
- See umbrella below: `Consolidate merge-{set,bag}-operators with
  keycollection-operators in @endo/patterns`.

##### Proposed umbrella issue: Consolidate `merge-{set,bag}-operators` with `keycollection-operators` in `@endo/patterns`

`packages/patterns/src/keys/merge-bag-operators.js:17` and
`packages/patterns/src/keys/merge-set-operators.js:17` both ask for
more code sharing with `keycollection-operators.js` (and with each
other). Extract the common iteration/merge primitives into a single
helper module so the bag and set merge implementations become thin
specializations.

#### `packages/patterns/src/keys/merge-set-operators.js` — 1 unlinked

- **L17** `TODO share more code with keycollection-operators.js.`
  - See umbrella above:
    `Consolidate merge-{set,bag}-operators with keycollection-operators in @endo/patterns`.

#### `packages/patterns/src/patterns/getGuardPayloads.js` — 9 unlinked

##### Proposed umbrella issue: Retire legacy guard shape compatibility in `getGuardPayloads.js`

`packages/patterns/src/patterns/getGuardPayloads.js` carries nine
TODOs centered on the legacy `klass:`-style guard payloads that
predate endojs/endo#1712:

> 1. L48, L81, L97, L106, L111, L127, L179 each duplicate a payload
>    shape (`Legacy*Shape`) that must be kept in sync with its
>    modern counterpart so legacy guard data still validates.
> 2. L268 `getInterfaceMethodKeys` would prefer `@ts-expect-error`
>    but the suppression "works locally but not from @endo/exo".
> 3. L293 references PRs removing symbol-named methods and method
>    guards (placeholder URL only).
>
> The first six are tightly coupled: once the project decides it no
> longer needs to accept legacy `klass:` guard data, every
> `Legacy*Shape` and the corresponding `adapt*` helper can be
> deleted in one change.
> Issue 8 should either link the PR finalizing symbol-method
> removal or be reworded to track that effort directly.

- **L48** `TODO manually maintain correspondence with AwaitArgGuardPayloadShape`
- **L81** `TODO manually maintain correspondence with SyncMethodGuardPayloadShape`
- **L97** `TODO manually maintain correspondence with ArgGuardShape`
- **L106** `TODO manually maintain correspondence with ArgGuardListShape`
- **L111** `TODO manually maintain correspondence with AsyncMethodGuardPayloadShape`
- **L127** `TODO manually maintain correspondence with MethodGuardPayloadShape`
- **L179** `TODO manually maintain correspondence with InterfaceGuardPayloadShape`
- **L268** `TODO at-ts-expect-error works locally but not from @endo/exo`
- **L293** `(TODO link to PRs removing symbol-named methods and method guards.)`

#### `packages/patterns/src/patterns/patternMatchers.js` — 8 unlinked

##### Proposed umbrella issue: patternMatchers cleanup pass: rank covers, MatchHelper parameterization, and difference accumulation

`packages/patterns/src/patterns/patternMatchers.js` has 8 TODO and XXX
markers along the same matcher pipeline:

> 1. L1 file-level "TODO parameterize MatchHelper" preceding a
>    blanket `eslint-disable no-continue`. The work would let many
>    of the file's other helpers drop the disable.
> 2. L377 `confirmPatternInternal` parallels `confirmKey` and they
>    should share more logic.
> 3. L531 record-pattern matching uses two `listDifference` calls;
>    a single iter-disjoint-union pass would be cheaper.
> 4. L681, L693, L720, L742 four `XXX this doesn't get along with
>    the world of cover === pair of strings` markers in the
>    `getRankCover` switch document a regression introduced when
>    rank covers were redefined as string pairs (also flagged as
>    a "POSSIBLE SILENT CORRECTNESS BUG" in the same block).
> 5. L1035 `match:nat` rank cover is conservative ("Could be more
>    precise"); a tighter cover would shorten range queries.
>
> Issue 4 is the most consequential (silent correctness bug); the
> rest are good cleanup that the same change set could address.

- **L1** `TODO parameterize MatchHelper which will solve most of them`
- **L377** `Purposely parallels chonfirmKey. TODO reuse more logic between them.`
- **L531** `TODO Detect and accumulate difference in one pass.`
- **L681** `XXX this doesn't get along with the world of cover === pair of`
- **L693** `XXX this doesn't get along with the world of cover === pair of`
- **L720** `XXX this doesn't get along with the world of cover === pair of`
- **L742** `XXX this doesn't get along with the world of cover === pair of`
- **L1035** `TODO Could be more precise`

#### `packages/patterns/src/type-from-pattern.ts` — 1 unlinked

- **L129** `  byteArray: ArrayBuffer; // TODO: update to Uint8Array when @endo/pass-style changes the byteArray type`
  - **Proposed issue:** `type-from-pattern: switch byteArray TS type to Uint8Array when pass-style flips`

    > `packages/patterns/src/type-from-pattern.ts:129` types
    > `byteArray` as `ArrayBuffer` because `@endo/pass-style` still
    > exposes it that way.
    > Once pass-style flips the public byteArray type to
    > `Uint8Array`, mirror the change here and remove the TODO.
    > Memory note: the project prefers `Uint8Array` over `Buffer` for
    > portability across XS and SES realms.

#### `packages/patterns/src/types.ts` — 1 unlinked

- **L321** `TODO: Reject attempts to create a kind matcher with unknown 'kind'?`
  - **Proposed issue:** `patterns: decide whether M.kind() should reject unknown kind names`

    > `packages/patterns/src/types.ts:321` notes that `M.kind('foo')`
    > silently produces a matcher that never matches when `'foo'` is
    > not a known kind.
    > Decide whether to reject unknown kinds at construction time
    > (which would catch typos) or document the silently-empty
    > behavior intentionally.

#### `packages/patterns/test/copyBag.test.js` — 1 unlinked

- **L132** `TODO: incorporate fast-check for property-based testing that construction`
  - See umbrella `Adopt fast-check for hardener and key-collection
    tests` under `@endo/harden`.

#### `packages/patterns/test/copyMap.test.js` — 1 unlinked

- **L120** `TODO: incorporate fast-check for property-based testing that construction`
  - See umbrella `Adopt fast-check for hardener and key-collection
    tests` under `@endo/harden`.

#### `packages/patterns/test/copySet.test.js` — 1 unlinked

- **L93** `TODO: incorporate fast-check for property-based testing that construction`
  - See umbrella `Adopt fast-check for hardener and key-collection
    tests` under `@endo/harden`.

#### `packages/patterns/test/patterns.test.js` — 3 unlinked

- **L581** `TODO Remove 't.throws' and 'Fail' when CopyMap comparison is implemented`
- **L895** `TODO Remove 't.throws' and 'Fail' when CopyMap comparison is implemented`
  - **Proposed issue:** `Implement CopyMap comparison and unwrap the t.throws guards in patterns.test.js`

    > `packages/patterns/test/patterns.test.js:581` and `:895` skip
    > CopyMap comparison cases by wrapping them in `t.throws` with
    > `Fail`-emitted "No CopyMap comparison support" messages.
    > Implement CopyMap comparison in the matcher engine, then
    > unwrap the assertions so the round-trip equality is exercised
    > directly.
- **L585** `@ts-expect-error XXX Key types`
  - See top-of-section umbrella
    `Reclassify @ts-expect-error XXX Key types markers in @endo/patterns`.

### `@endo/promise-kit`

#### `packages/promise-kit/src/memo-race.js` — 1 unlinked

- **L34** `TODO Consolidate with 'isPrimitive' that's currently in '@endo/pass-style'.`
  - See umbrella `Consolidate isPrimitive across @endo packages`
    under `@endo/eventual-send`.

### `@endo/ses`

#### `packages/ses/docs/secure-coding-guide.md` — 2 unlinked

- **L344** `JavaScript 'class' syntax. (TODO: or we do any I just don't know it yet. I`
  - **Proposed issue:** `secure-coding-guide.md: document a class-syntax pattern that meets SES goals`

    > `packages/ses/docs/secure-coding-guide.md:344` admits the
    > guide does not yet describe a secure pattern that uses
    > JavaScript `class` syntax (private fields, this confusion).
    > Either document a recommended pattern (perhaps building on
    > exo class definitions or hardened classes from
    > `@endo/exo`) or rewrite the section to recommend the
    > closure-based factory pattern explicitly and remove the
    > placeholder.
- **L516** `(TODO: is this actually secure? 's' might be a "thenable", and have control`
  - **Proposed issue:** `secure-coding-guide.md: confirm Promise.resolve(s) safety against thenables`

    > `packages/ses/docs/secure-coding-guide.md:516` raises a
    > genuine question: can a thenable's `.then` be invoked
    > synchronously by `Promise.resolve(s)`?
    > Audit the SES taming of Promise to confirm that
    > `Promise.resolve` cannot run attacker-supplied `.then`
    > synchronously, and update the guide with the result and a
    > pointer to the relevant taming logic.

#### `packages/ses/src/commons.js` — 1 unlinked

- **L362** `TODO Consolidate with 'isPrimitive' that's currently in '@endo/pass-style'.`
  - See umbrella `Consolidate isPrimitive across @endo packages`
    under `@endo/eventual-send`.

#### `packages/ses/src/compartment-evaluate.js` — 1 unlinked

- **L61** `TODO Maybe relax string check and coerce instead:`
  - **Proposed issue:** `compartmentEvaluate: align with proposal-dynamic-code-brand-checks`

    > `packages/ses/src/compartment-evaluate.js:61` rejects non-
    > string `source` outright.
    > Track the TC39
    > [proposal-dynamic-code-brand-checks](https://github.com/tc39/proposal-dynamic-code-brand-checks)
    > and either coerce to string (per the proposal) or document
    > the deliberate divergence.

#### `packages/ses/src/compartment.js` — 2 unlinked

- **L388** `TODO: consider merging into a single initialization if internal`
  - **Proposed issue:** `compartment: merge constant and mutable global property initialization`

    > `packages/ses/src/compartment.js:388` notes that the
    > Compartment constructor splits global property setup into
    > constant and mutable phases because the safe evaluator might
    > read constants eagerly.
    > Once the evaluator no longer needs eager construction, merge
    > the two phases.
- **L406** `TODO: maybe add evalTaming to the Compartment constructor 3rd options?`
  - **Proposed issue:** `compartment: surface evalTaming as a Compartment constructor option`

    > `packages/ses/src/compartment.js:406` proposes letting
    > callers control `evalTaming` from the Compartment options
    > rather than only from `lockdown`.
    > Decide whether per-Compartment `evalTaming` is supportable
    > under SES's safety model, and either add the option or
    > delete the TODO.

#### `packages/ses/src/console-shim.js` — 1 unlinked

- **L5** `TODO possible additional exports. Some are privileged.`
  - **Proposed issue:** `console-shim: decide which privileged console helpers to export and document them`

    > `packages/ses/src/console-shim.js:5` lists candidate exports
    > that are deliberately privileged (`makeCausalConsole`,
    > `assertLogs`, `throwsAndLogs`, etc.).
    > Decide which subset SES wants to expose, document the
    > security expectations of the consumers, and either uncomment
    > the exports or delete the placeholder list.

#### `packages/ses/src/error/console.js` — 2 unlinked

- **L430** `TODO: Fix this horrible kludge, and indent in a sane manner.`
  - **Proposed issue:** `console: replace indentAfterAllSeps kludge with proper line-based indentation`

    > `packages/ses/src/error/console.js:430` documents a
    > workaround that prepends an empty string to the args list
    > to compensate for AVA's logger joining the args with a
    > space.
    > Replace the helper with a logger-aware indentation strategy
    > (or push the indentation responsibility into the logger
    > itself) so the kludge can go.
- **L519** `TODO do something with optional topic string`
  - **Proposed issue:** `filterConsole: surface optional topic in filtered console output`

    > `packages/ses/src/error/console.js:519` accepts a `_topic`
    > parameter and ignores it.
    > Decide what filtering or labeling behavior the topic should
    > drive (for example prefixing the logger output) and
    > implement it, then unbork the leading underscore.

#### `packages/ses/src/error/tame-error-constructor.js` — 1 unlinked

- **L60** `TODO Likely expensive!`
  - **Proposed issue:** `tame-error-constructor: avoid per-Error captureStackTrace cost on v8`

    > `packages/ses/src/error/tame-error-constructor.js:60`
    > unconditionally calls `originalCaptureStackTrace` on every
    > tamed Error allocation under v8.
    > Profile the cost and either guard the call behind an
    > opt-in option (for example `errorTaming: 'unsafe-debug'`),
    > or use V8's `--stack-trace-limit` to bound the work.

#### `packages/ses/src/error/tame-v8-error-constructor.js` — 7 unlinked

##### Proposed umbrella issue: tame-v8-error-constructor cleanup pass: censor configurability, performance, types, and cross-engine factoring

`packages/ses/src/error/tame-v8-error-constructor.js` carries seven
TODOs that cluster into V8-specific cleanup work:

> 1. L49 the `'toString'` entry of `safeV8CallSiteMethodNames` is
>    overly permissive; replace it with a wrapper that emits only
>    permitted info.
> 2. L52 the per-callsite proxy is "ridiculously expensive";
>    switch to a cheaper representation.
> 3. L98 expose `FILENAME_CENSORS` as a `lockdown` option.
> 4. L110 move `filterFileName` somewhere it can apply to non-V8
>    engines too.
> 5. L186 expose `CALLSITE_PATTERNS` as a `lockdown` option.
> 6. L198 move `shortenCallSiteString` somewhere non-V8-specific.
> 7. L223 define proper TypeScript types for V8's `CallSite`
>    instead of `{}`.
>
> Issues 3 and 5 should land together (one config surface).
> Issues 4 and 6 share a refactor target.

- **L49** `  'toString', // TODO replace to use only permitted info`
- **L52** `TODO this is a ridiculously expensive way to attenuate callsites.`
- **L98** `TODO Enable users to configure FILENAME_CENSORS via 'lockdown' options.`
- **L110** `TODO Move so that it applies not just to v8.`
- **L186** `TODO Enable users to configure CALLSITE_PATTERNS via 'lockdown' options.`
- **L198** `TODO Move so that it applies not just to v8.`
- **L223** `TODO: Proper CallSite types`

#### `packages/ses/src/error/types.js` — 1 unlinked

- **L35** `TODO: We'd like to add the following properties to the above`
  - **Proposed issue:** `ses error types: add Console.profile and profileEnd to VirtualConsole when supported`

    > `packages/ses/src/error/types.js:35` documents that
    > `Console['profile']` and `Console['profileEnd']` are
    > omitted because some TypeScript Console typings lack them.
    > Investigate the affected TypeScript versions, then either
    > add the properties (with `?` if needed) or document why
    > they remain absent.

#### `packages/ses/src/global-object.js` — 1 unlinked

- **L127** `TODO These should still be tamed according to the permits before`
  - **Proposed issue:** `global-object: tame perCompartmentGlobals before installing them`

    > `packages/ses/src/global-object.js:127` installs
    > `perCompartmentGlobals` directly via `defineProperty`
    > without taming them through the permits machinery first.
    > Route the values through the same taming pipeline that
    > shared globals use, so per-compartment globals respect the
    > permits.

#### `packages/ses/src/intrinsics.js` — 1 unlinked

- **L186** `TODO pass a proper reporter to 'makeIntrinsicsCollector'`
  - **Proposed issue:** `intrinsics: thread the configured reporter into makeIntrinsicsCollector`

    > `packages/ses/src/intrinsics.js:186` calls
    > `makeIntrinsicsCollector(reporter)` but the surrounding
    > comment notes that the reporter is not properly threaded.
    > Audit the call sites of `getGlobalIntrinsics`, plumb the
    > caller-configured reporter all the way through, and remove
    > the TODO.

#### `packages/ses/src/lockdown.js` — 1 unlinked

- **L538** `TODO consider moving this to the end of the repair phase, and`
  - **Proposed issue:** `lockdown: decide whether enablePropertyOverrides runs before or after vetted shims`

    > `packages/ses/src/lockdown.js:538` notes that the
    > "Enabling property overrides" step might better run at the
    > end of the repair phase, before vetted shims, instead of
    > after.
    > Investigate the ordering trade-offs and either move the
    > call or document why the current ordering is correct.

#### `packages/ses/src/make-function-constructor.js` — 1 unlinked

- **L55** `TODO: since we create an anonymous function, the 'this' value`
  - **Proposed issue:** `make-function-constructor: align this binding with spec for the safe Function constructor`

    > `packages/ses/src/make-function-constructor.js:55`
    > documents that the safe Function constructor's anonymous
    > function leaves `this` undefined rather than bound to the
    > global object as the spec requires.
    > Adjust the generated source so the resulting function's
    > `this` matches the spec, or document the divergence.

#### `packages/ses/src/permits.js` — 12 unlinked

##### Proposed umbrella issue: SES permits cleanup: future intrinsics, engine quirks, and Promise.delegate transition

`packages/ses/src/permits.js` carries 12 TODOs that fall into three
clusters:

> 1. Future intrinsics not yet permitted, awaiting standards or
>    SES policy:
>    - L92 `DisposableStack`, `AsyncDisposableStack`
>    - L97 `ShadowRealm`
>    - L167, L190 `Temporal` (start vs shared)
>    - L689, L703 `SuppressedError` and its prototype
>    - L701 `AggregateError.errors` permit
> 2. Engine-quirk workarounds:
>    - L335 Hermes-specific `caller`/`arguments` patch
>    - L576, L578 QuickJS `fileName` and `lineNumber` getters
>      should be grabbed for console use
>    - L668 `Error.prototype.at` "proposed de-facto, assumed
>      TODO" placeholder
> 3. L1612 the `HandledPromise` global will be replaced by
>    `Promise.delegate`.
>
> Land each cluster as a separate change set rather than 12
> issues: the future-intrinsic permits are blocked on standards
> progress, the engine quirks share a feature-detect pattern, and
> the Promise.delegate transition has its own TC39 timing.

- **L92** `TODO DisposableStack, AsyncDisposableStack`
- **L97** `TODO ShadowRealm`
- **L167** `TODO Temporal`
- **L190** `TODO Temporal`
- **L335** `TODO Remove this once we no longer support the Hermes that needed this.`
- **L576** `Seen on QuickJS. TODO grab getter for use by console`
- **L578** `Seen on QuickJS. TODO grab getter for use by console`
- **L668** `proposed de-facto, assumed TODO`
- **L689** `TODO SuppressedError`
- **L701** `TODO AggregateError .errors`
- **L703** `TODO SuppressedError`
- **L1612** `TODO: To be replaced with Promise.delegate`

#### `packages/ses/src/shim-arraybuffer-transfer.js` — 1 unlinked

- **L30** `TODO Rather than doing nothing, should the endo ses-shim throw`
  - **Proposed issue:** `shim-arraybuffer-transfer: throw on platforms lacking both transfer and structuredClone`

    > `packages/ses/src/shim-arraybuffer-transfer.js:30` returns
    > silently when neither `Array.prototype.transfer` nor
    > `structuredClone` is available, which previously covered
    > Node 16.
    > Now that Endo no longer supports Node 16 and all browsers
    > expose `structuredClone`, throw a `TypeError` to surface
    > the platform gap explicitly.

#### `packages/ses/test/break-function-eval.test.js` — 1 unlinked

- **L81** `TODO: review the limitations previously described below.`
  - **Proposed issue:** `break-function-eval test: review backtick-escape limitations and document remaining gaps`

    > `packages/ses/test/break-function-eval.test.js:81` invites a
    > review of attack scenarios where the backtick in `arg=`
    > consumes the trailing block-comment that separates the
    > parameters from the body.
    > Walk through each scenario, confirm the current source
    > injection defenses cover them, and update the test
    > narration with conclusions.

#### `packages/ses/test/compartment.test.js` — 1 unlinked

- **L32** `  // something to the global, except that global has been frozen. todo:`
  - **Proposed action: delete the TODO**

    > `packages/ses/test/compartment.test.js:32` is inside a
    > commented-out test for the long-removed
    > `SES.makeSESRootRealm` and `SES.confine` API.
    > The "todo" tag is dead-letter against APIs that no longer
    > exist; delete the entire commented block.

#### `packages/ses/test/error/_throws-and-logs.js` — 2 unlinked

- **L55** `TODO It currently checks the console by temporarily assigning`
- **L117** `TODO It currently checks the console by temporarily assigning`
  - **Proposed issue:** `_throws-and-logs: run console-checking helpers inside a Compartment with our console`

    > `packages/ses/test/error/_throws-and-logs.js:55` and `:117`
    > note that `assertLogs` and `throwsAndLogs` mutate
    > `globalThis.console` to install a logging console for the
    > duration of `thunk()`.
    > Once full Compartment support exists in tests, run each
    > thunk inside a Compartment that exposes the desired
    > `console`, eliminating the global mutation.

#### `packages/ses/test/error/aggregate-error-console-demo.test.js` — 1 unlinked

- **L12** `TODO: Remove after dropping support for pre-AggregateError implementations.`
  - See umbrella `Drop pre-AggregateError fallbacks across @endo`
    under `@endo/marshal`.

#### `packages/ses/test/error/aggregate-error-console.test.js` — 1 unlinked

- **L7** `TODO: Remove after dropping support for pre-AggregateError implementations.`
  - See umbrella `Drop pre-AggregateError fallbacks across @endo`
    under `@endo/marshal`.

#### `packages/ses/test/error/aggregate-error.test.js` — 1 unlinked

- **L8** `TODO: Remove after dropping support for pre-AggregateError implementations.`
  - See umbrella `Drop pre-AggregateError fallbacks across @endo`
    under `@endo/marshal`.

#### `packages/ses/test/error/assert-log.test.js` — 1 unlinked

- **L509** `throw. Potentially useful in many other tests. TODO put somewhere reusable`
  - **Proposed issue:** `Promote alwaysThrowProxy helper to a shared test utility`

    > `packages/ses/test/error/assert-log.test.js:509` defines a
    > local proxy that throws on every trap, useful for
    > stringification and quoting tests.
    > Move it into a shared test utility module so other tests
    > can import it without duplicating the helper.

#### `packages/ses/test/error/assert.test.js` — 1 unlinked

- **L15** `@ts-expect-error XXX typedef`
  - **Proposed issue:** `assert.test.js: refine an() typing so the {} call site stops needing @ts-expect-error`

    > `packages/ses/test/error/assert.test.js:15` suppresses a
    > typedef error on `an({})` because `an`'s parameter is
    > typed as `string`.
    > Refine `an`'s signature to accept any value and coerce
    > internally, removing the suppression.

#### `packages/ses/test/error/tame-v8-error-unsafe.test.js` — 2 unlinked

- **L5** `TODO test Error API in`
  - **Proposed issue:** `Cover Error API in non-start compartments, errorTaming safe, and non-v8 engines`

    > `packages/ses/test/error/tame-v8-error-unsafe.test.js:5`
    > says the file currently exercises only one configuration.
    > Add cross-product coverage for non-start compartments,
    > `errorTaming: 'safe'`, and non-V8 engines so the
    > error-API guarantees are tested everywhere they apply.
- **L221** `TODO: upgrade to tape 5.x for t.match`
  - **Proposed action: delete the TODO**

    > `packages/ses/test/error/tame-v8-error-unsafe.test.js:221`
    > references `tape 5.x for t.match`, but this file already
    > uses AVA (`import test from 'ava'`) which has `t.regex`.
    > The TODO is dead-letter; replace the manual
    > `stack[0].search(...)` with `t.regex(stack[0], /at middle/)`
    > and delete the comment.

#### `packages/ses/test/import-legacy.test.js` — 1 unlinked

- **L473** `TODO The following commented test does not pass, and might not be valid.`
  - **Proposed issue:** `import-legacy: decide the fate of the commented module-instance-per-request-url test`

    > `packages/ses/test/import-legacy.test.js:473` carries a
    > commented-out test that probes whether browsers create one
    > module instance per request URL while caching by response
    > URL.
    > Either confirm the assertion is correct and re-enable the
    > test (perhaps marked browser-only), or delete it.
    > The same TODO appears in
    > `packages/ses/test/import.test.js:435`.

#### `packages/ses/test/import-now-hook.test.js` — 1 unlinked

- **L524** `TODO: I had expected this to be an actual AggregateError, but it is not`
  - **Proposed issue:** `import-now-hook: surface AggregateError from importNow when noAggregateLoadErrors is false`

    > `packages/ses/test/import-now-hook.test.js:524` expected
    > `importNow` with `noAggregateLoadErrors: false` to throw
    > an `AggregateError` but observes only a regular `Error`
    > with "1 underlying failures" in the message.
    > Investigate whether the importNow path should produce a
    > real `AggregateError` (with `errors` populated) and align
    > the implementation with the test's expectation.

#### `packages/ses/test/import.test.js` — 1 unlinked

- **L435** `TODO The following commented test does not pass, and might not be valid.`
  - See `import-legacy.test.js:473` proposed issue above.

#### `packages/ses/test/make-hardener.test.js` — 1 unlinked

- **L118** `TODO: Use fast-check to generate arbitrary input.`
  - See umbrella `Adopt fast-check for hardener and key-collection
    tests` under `@endo/harden`.

#### `packages/ses/test/ses.test.js` — 1 unlinked

- **L91** `  // something to the global, except that global has been frozen. todo:`
  - **Proposed action: delete the TODO**

    > `packages/ses/test/ses.test.js:91` is the same dead-letter
    > comment as `packages/ses/test/compartment.test.js:32`,
    > inside an old commented-out `SES.makeSESRootRealm` block.
    > Delete the commented block and the TODO together.

#### `packages/ses/test/v8-callsite-properties.test.js` — 1 unlinked

- **L19** `TODO: if we're not under v8, 'sst' will be undefined or an empty`
  - **Proposed issue:** `v8-callsite-properties: skip on non-v8 engines instead of accessing undefined sst`

    > `packages/ses/test/v8-callsite-properties.test.js:19` runs
    > the check unconditionally and indexes into a possibly-
    > undefined `sst`.
    > Detect V8 (for example via `Error.captureStackTrace`) and
    > skip the test on non-V8 engines.

##### Proposed umbrella issue: Reconcile SES test262 cross-realm and noStrict exclusions with realm/sloppy support plans

Five SES test262 harness scripts exclude the `cross-realm` feature
(and in some cases the `noStrict` flag) because the SES Evaluator
does not create realms or support sloppy mode:

> 1. `packages/ses/test262/compartment-shim.js:143`
> 2. `packages/ses/test262/tame-global-date-object.js:11`
> 3. `packages/ses/test262/tame-global-error-object.js:16`
> 4. `packages/ses/test262/tame-global-math-object.js:11`
> 5. `packages/ses/test262/tame-global-regexp-object.js:34`
>
> Document the long-term plan for realm and sloppy-mode coverage
> in test262 and either remove the exclusions (once the gap is
> filled) or convert the TODOs into permanent doc comments.

#### `packages/ses/test262/compartment-shim.js` — 1 unlinked

- **L143** `    'cross-realm', // TODO: Evaluator does not create realms.`
  - See umbrella above.

#### `packages/ses/test262/tame-global-date-object.js` — 1 unlinked

- **L11** `    'cross-realm', // TODO: Evaluator does not create realms.`
  - See umbrella above.

#### `packages/ses/test262/tame-global-error-object.js` — 1 unlinked

- **L16** `    'cross-realm', // TODO: Evaluator does not create realms.`
  - See umbrella above.

#### `packages/ses/test262/tame-global-math-object.js` — 1 unlinked

- **L11** `    'cross-realm', // TODO: Evaluator does not create realms.`
  - See umbrella above.

#### `packages/ses/test262/tame-global-regexp-object.js` — 2 unlinked

- **L9** `    'test/built-ins/RegExp/property-escapes/', // TODO refine`
  - **Proposed issue:** `test262 RegExp: refine property-escapes and match-indices exclusions`

    > `packages/ses/test262/tame-global-regexp-object.js:9` and
    > the adjacent `match-indices/` exclusion broadly skip whole
    > directories of RegExp tests.
    > Walk each excluded test, identify which subset is actually
    > unsupported by SES's tamed RegExp, and replace the
    > directory exclusions with file-level exclusions plus
    > inline justifications.
- **L34** `    'cross-realm', // TODO: Evaluator does not create realms.`
  - See umbrella above:
    `Reconcile SES test262 cross-realm and noStrict exclusions
    with realm/sloppy support plans`.

#### `packages/ses/types.d.ts` — 2 unlinked

- **L25** `TODO Somehow remove the redundancy between these type deinitions and the`
  - **Proposed issue:** `ses types: dedupe RepairOptions/lockdown getenv casts`

    > `packages/ses/types.d.ts:25` notes that `RepairOptions` is
    > redundantly described both here and at every `getenv` call
    > site in `lockdown.js`.
    > Generate one from the other (for example a satisfies-style
    > schema) so the two cannot drift.
- **L243** `TODO inline overloading`
  - **Proposed issue:** `ses types: inline AssertTypeof overloads when JSDoc supports it`

    > `packages/ses/types.d.ts:243` keeps the `AssertTypeof*`
    > overloads as separate type aliases because JSDoc could not
    > represent the union ergonomically when the comment was
    > written.
    > Inline the overloads into a single function signature once
    > the JSDoc parser handles overloaded callables fluently,
    > and delete the per-typeof aliases.

### `@endo/ses-ava`

#### `packages/ses-ava/prepare-endo.js` — 1 unlinked

- **L10** `TODO consider adding env option setting APIs to @endo/env-options`
  - See umbrella `Add an env-option setter API to @endo/env-options`
    under `@endo/exo`.

#### `packages/ses-ava/src/ses-ava-test.js` — 1 unlinked

- **L38** `TODO For some reason, the following declaration (with "at-" as "@")`
  - **Proposed issue:** `ses-ava: revisit VirtualConsole typedef once TS/typedoc no longer break`

    > `packages/ses-ava/src/ses-ava-test.js:38` falls back to
    > `@typedef {any} VirtualConsole` because the proper
    > `@typedef {import('ses/console-tools.js').VirtualConsole}`
    > caused TypeScript to widen the type to `any` in vscode and
    > broke typedoc.
    > Investigate the root cause (likely an export-resolution
    > issue in the `ses` package's typings or in typedoc's
    > module resolution), and replace the `any` typedef with the
    > real type.

#### `packages/ses-ava/test/panic.test.js` — 1 unlinked

- **L19** `@ts-expect-error XXX unique symbol`
  - **Proposed issue:** `ses-ava panic test: type PanicEndowmentSymbol so the unique-symbol comparison checks`

    > `packages/ses-ava/test/panic.test.js:19` suppresses a
    > "unique symbol" mismatch because
    > `PanicEndowmentSymbol`'s declared type is the unique-symbol
    > `Symbol.for('@endo panic')` brand, but the test compares it
    > against a freshly-resolved symbol via
    > `Symbol.for('@endo panic')` whose static type is `symbol`.
    > Either widen `PanicEndowmentSymbol`'s type to `symbol` or
    > assert that the two symbols are pointer-equal in a way TS
    > accepts (for example via `assert(typeof
    > PanicEndowmentSymbol === 'symbol')`).

### `@endo/test262-runner`

##### Proposed umbrella issue: Track upstream test262 TODOs vendored into `@endo/test262-runner`

All nine `@endo/test262-runner` TODOs sit inside files copied verbatim
from the upstream `tc39/test262` repository:

> 1. `packages/test262-runner/test262/harness/async-gc.js:40`
> 2. `packages/test262-runner/test262/harness/testAtomics.js:105`
> 3. `packages/test262-runner/test262/test/harness/timer.js:18`
> 4. `packages/test262-runner/test262/test/intl402/NumberFormat/prototype/format/format-non-finite-numbers.js:12`
> 5. `packages/test262-runner/test262/test/intl402/NumberFormat/prototype/format/numbering-systems.js:48`
> 6. `packages/test262-runner/test262/test/intl402/NumberFormat/prototype/format/percent-formatter.js:18, 22`
> 7. `packages/test262-runner/test262/test/language/expressions/typeof/built-in-functions.js:35`
> 8. `packages/test262-runner/test262/test/language/expressions/typeof/native-call.js:76`
>
> These TODOs belong to upstream `tc39/test262` and are already
> tracked in that project's issue tracker. They should not generate
> `endojs/endo` issues. Either teach the hygiene scan to ignore the
> `packages/test262-runner/test262/` subtree as vendored upstream
> code, or replace each `TODO`/`FIXME` keyword with a non-TODO
> marker (for example `XXX-upstream`) so the scan stops counting
> them.

#### `packages/test262-runner/test262/harness/async-gc.js` — 1 unlinked

- **L40** `TODO: Remove this when $262.clearKeptObject becomes documented and required`
  - See vendored-test262 umbrella above.

#### `packages/test262-runner/test262/harness/testAtomics.js` — 1 unlinked

- **L105** `TODO: Proxy?`
  - See vendored-test262 umbrella above.

#### `packages/test262-runner/test262/test/harness/timer.js` — 1 unlinked

- **L18** `TODO: assert semantics`
  - See vendored-test262 umbrella above.

#### `packages/test262-runner/test262/test/intl402/NumberFormat/prototype/format/format-non-finite-numbers.js` — 1 unlinked

- **L12** `FIXME: We are only listing Numeric_Type=Decimal. May need to add more`
  - See vendored-test262 umbrella above.

#### `packages/test262-runner/test262/test/intl402/NumberFormat/prototype/format/numbering-systems.js` — 1 unlinked

- **L48** `FIXME: Unfinished`
  - See vendored-test262 umbrella above.

#### `packages/test262-runner/test262/test/intl402/NumberFormat/prototype/format/percent-formatter.js` — 2 unlinked

- **L18** `FIXME: May not work for some theoretical locales where percents and`
- **L22** `FIXME: Move this to somewhere appropriate`
  - See vendored-test262 umbrella above.

#### `packages/test262-runner/test262/test/language/expressions/typeof/built-in-functions.js` — 1 unlinked

- **L35** `TODO: should this be expanded to check all built-ins?`
  - See vendored-test262 umbrella above.

#### `packages/test262-runner/test262/test/language/expressions/typeof/native-call.js` — 1 unlinked

- **L76** `TODO: Should this be extended to include all built-ins?`
  - See vendored-test262 umbrella above.

### `@endo/where`

#### `packages/where/index.js` — 1 unlinked

- **L12** `TODO support roaming data for shared content addressable state and`
  - **Proposed issue:** `where: support roaming AppData for shared content-addressable state on Windows`

    > `packages/where/index.js:12` documents the deliberate
    > preference for `LOCALAPPDATA` because Endo currently
    > assumes the host that listens is the host that connects.
    > For shared content-addressable state that may legitimately
    > roam, decide on a merge strategy (or bind it to a specific
    > Endo subdirectory) and add a `whereHomeRoamingWindows()` or
    > equivalent helper.

### `@endo/zip`

#### `packages/zip/src/format-reader.js` — 3 unlinked

- **L123** `TODO read extra fields, particularly Zip64`
- **L362** `TODO Date integrity check would be easier on the original bytes.`
- **L476** `TODO handle explicit directory entries`
  - See umbrella below: `@endo/zip: extend reader and writer for full
    spec coverage (Zip64, extra fields, directory records, dates)`.

#### `packages/zip/src/format-writer.js` — 7 unlinked

- **L83** `TODO count of extra fields length`
- **L86** `TODO write extra fields`
- **L106** `TODO extra fields length`
- **L114** `TODO extra fields`
- **L218** `TODO Add support for directory records.`
- **L238** `    versionNeeded: 0, // TODO this is probably too lax.`
- **L261** `TODO collate directoryRecords from file bases.`
  - See umbrella below: `@endo/zip: extend reader and writer for full
    spec coverage (Zip64, extra fields, directory records, dates)`.

##### Proposed umbrella issue: `@endo/zip`: extend reader and writer for full spec coverage (Zip64, extra fields, directory records, dates)

`@endo/zip` collects 10 TODOs across the reader and writer that all
describe specific Zip-spec features the implementation does not yet
support:

> 1. Reader (`packages/zip/src/format-reader.js`):
>    - L123 read extra fields, particularly Zip64
>    - L362 perform date integrity check on original bytes
>    - L476 handle explicit directory entries
> 2. Writer (`packages/zip/src/format-writer.js`):
>    - L83 count of extra-fields length
>    - L86 write extra fields
>    - L106 extra-fields length
>    - L114 extra fields
>    - L218 add support for directory records
>    - L238 `versionNeeded: 0` is too lax
>    - L261 collate directory records from file bases
>
> Land these as one ZIP-spec-compliance pass. Either pair the
> reader and writer changes (extra fields, directory records,
> Zip64) so the round-trip stays consistent, or split into one
> issue per ZIP feature pair.

#### `packages/zip/test/zip.test.js` — 1 unlinked

- **L28** `XXX would use optional chaining but it's currently forbidding 2025-05-28`
  - **Proposed action: delete the comment**

    > `packages/zip/test/zip.test.js:28` is a date-stamped
    > reminder ("2025-05-28") that an optional-chaining lint rule
    > was tripping at the time the test was written.
    > Either confirm the lint rule has since been relaxed (in
    > which case rewrite the call site with `?.` and delete the
    > comment) or, if the rule still applies, replace the `XXX`
    > keyword with a non-TODO marker so the hygiene scan stops
    > counting it.

## Ambiguous TODOs (cite a doc or external note, not a tracker)

- `packages/ses/src/make-eval-function.js:19` `TODO Recent proposals from Mike Samuel may change this non-string`
- `packages/ses/src/permits.js:118` `  HandledPromise: 'HandledPromise', // TODO: Until Promise.delegate (see below).`

## Suggested follow-ups

### Files with three-or-more unlinked TODOs (one tracking issue per file is likely cheaper than one per TODO)

- `packages/compartment-mapper/README.md` — 13 unlinked
- `packages/ses/src/permits.js` — 12 unlinked
- `packages/pass-style/test/passStyleOf.test.js` — 9 unlinked
- `packages/patterns/src/patterns/getGuardPayloads.js` — 9 unlinked
- `packages/daemon/src/daemon.js` — 8 unlinked
- `packages/patterns/src/patterns/patternMatchers.js` — 8 unlinked
- `packages/ses/src/error/tame-v8-error-constructor.js` — 7 unlinked
- `packages/zip/src/format-writer.js` — 7 unlinked
- `packages/marshal/src/marshal.js` — 6 unlinked
- `packages/daemon/src/networks/tcp-netstring.js` — 5 unlinked
- `packages/captp/src/ts-types.d.ts` — 4 unlinked
- `packages/eslint-plugin/lib/rules/harden-exports.js` — 4 unlinked
- `packages/marshal/src/encodePassable.js` — 4 unlinked
- `packages/marshal/src/encodeToCapData.js` — 4 unlinked
- `packages/marshal/src/encodeToSmallcaps.js` — 4 unlinked
- `packages/pass-style/src/deeplyFulfilled.js` — 4 unlinked
- `packages/pass-style/src/passStyleOf.js` — 4 unlinked
- `packages/pass-style/tools/arb-passable.js` — 4 unlinked
- `packages/compartment-mapper/test/dynamic-require.test.js` — 3 unlinked
- `packages/daemon/src/mail.js` — 3 unlinked
- `packages/daemon/src/serve-private-port-http.js` — 3 unlinked
- `packages/daemon/src/types.d.ts` — 3 unlinked
- `packages/daemon/src/web-server-node-powers.js` — 3 unlinked
- `packages/eventual-send/src/E.js` — 3 unlinked
- `packages/marshal/src/dot-membrane.js` — 3 unlinked
- `packages/marshal/test/marshal-justin.test.js` — 3 unlinked
- `packages/pass-style/src/remotable.js` — 3 unlinked
- `packages/pass-style/test/far-wobbly-point.test.js` — 3 unlinked
- `packages/patterns/src/keys/copyBag.js` — 3 unlinked
- `packages/patterns/src/keys/keycollection-operators.js` — 3 unlinked
- `packages/patterns/test/patterns.test.js` — 3 unlinked
- `packages/zip/src/format-reader.js` — 3 unlinked

### Cross-cutting patterns

- **TypeScript error-suppression markers (`@ts-expect-error XXX <reason>`,
  `@ts-ignore XXX <reason>`, `@ts-nocheck XXX <reason>`)** account for
  ~38 of the unlinked entries (mostly in `@endo/pass-style/test/passStyleOf.test.js`,
  `@endo/marshal/src/{marshal,encodeToSmallcaps}.js`,
  `@endo/eventual-send/src/E.js`, `@endo/module-source/src/transform-*.js`,
  and `@endo/compartment-mapper/test/scaffold.js`).
  These are not really TODOs; they are typing debt. Consider an umbrella
  issue "replace `@ts-expect-error XXX` markers with proper types" and
  link the umbrella from each site, or treat them as a known accepted
  pattern and stop tagging them with XXX.
- **`@endo/compartment-mapper/README.md`** has 13 unlinked `> TODO:` notes
  describing future spec coverage (`exports`/`imports` patterns, `files`
  globs, lockdown options, plugins). Likely candidates for
  endojs/endo#2388 (graceful tags-to-conditions migration) and a generic
  "compartment-mapper README parity tracker" umbrella issue.
- **`@endo/ses/src/permits.js`** has 12 unlinked TODOs about engine quirks
  (XS, Hermes, JSC, QuickJS) — a single "taming-permits cleanup" tracking
  issue would group these.
- **`@endo/patterns/src/patterns/{patternMatchers,getGuardPayloads}.js`**
  has 17 unlinked TODOs across two files; likely covered by an existing
  patterns redesign discussion. Maintainer should confirm whether
  endojs/endo#1737 covers them.
- **`@endo/zip/src/format-writer.js`** has 7 unlinked TODOs that all read
  like spec-conformance gaps ("verify", "check", "truncate").
  One "zip writer spec-compliance" tracking issue is more useful than
  individual issues.
- **`@endo/daemon/src/daemon.js`** has 8 unlinked TODOs across the
  daemon's bootstrap path. The daemon is still under active development
  per AGENTS.md, so an architectural "daemon TODO sweep" is reasonable.
- **`@endo/ses/src/error/tame-v8-error-constructor.js`** has 7 unlinked
  TODOs that look like V8-specific quirks; many already cite Chromium
  bugs in nearby comments — the maintainer should re-grep this file for
  bug numbers that are present a few lines away from the TODO line.

### Likely-known-issue candidates (worth re-confirming, do not auto-link)

- TODOs in `@endo/compartment-mapper` that reference `exports`/`imports`
  conditions or wildcards likely overlap with endojs/endo#2388.
- TODOs in `@endo/eventual-send/src/E.js` about callable type-mapping
  cite microsoft/TypeScript#61838 in linked siblings; the unlinked
  `@ts-expect-error XXX typedef` lines are downstream of the same gap.
- TODOs in `@endo/ses/src/strict-scope-terminator.js`, `eval-strict.js`,
  and surrounding tame-error files mention "JSC" / "Safari" / "Hermes";
  some have linked-sibling comments referencing endojs/endo#1490 etc.
  that the comment block probably should pull in.

### Probable dead-letter (consider deletion rather than tracking)

- `@endo/exo/test/non-enumerable-methods.test.js:44` — "FIXME typedef
  should catch bad arg" — single-line stale FIXME with no context.
- `@endo/module-source/test/_native.js:3` — `@ts-expect-error XXX
  typedef` in test scaffolding; if the test still passes, the XXX is
  not actionable as a TODO.
- Various single-line `XXX module exports fail if these aren't in scope`
  comments in `@endo/errors/index.js`, `@endo/eventual-send/src/no-shim.js`
  describe an existing safety check, not future work.
- `@endo/zip/test/zip.test.js:28` — `XXX would use optional chaining
  but it's currently forbidding 2025-05-28` — date-stamped reminder
  about a tooling restriction; either link to the upstream issue
  blocking optional chaining, or delete once the restriction lifts.

## Notes on hygiene

- The bulk of unlinked TODOs are concentrated in
  `@endo/ses` (60), `@endo/pass-style`
  (40), `@endo/patterns`
  (38), `@endo/daemon`
  (34), `@endo/marshal`
  (34), and `@endo/compartment-mapper`
  (33).
- Only **10.7%** of TODO/FIXME/XXX blocks reference an issue
  or PR; this is below typical engineering-hygiene targets (often 60-80%).
  A large share of the gap is `@ts-expect-error XXX <reason>` markers,
  which arguably should be reclassified as accepted typing debt rather
  than tracked individually.
- Recommend filing one umbrella issue per file in the "3+ unlinked"
  cluster list above, and adopting a convention that any new TODO must
  cite an issue (enforceable via a lightweight ESLint rule or grep CI check).
