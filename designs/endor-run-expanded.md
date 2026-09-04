# Expanded `endor run`: Archives, Directories, and Entry Points

| | |
|---|---|
| **Created** | 2026-04-17 |
| **Updated** | 2026-08-27 |
| **Author** | Kris Kowal (prompted) |
| **Status** | In Progress |

## Status

Phases 1-2 and Phase 4 (no-dependency case) are implemented; Phase 3
is in review on PR #278. Phase 5's local-`node_modules` walk and its
fixture-parity ratchet are implemented on this PR (stacked on PR #279).
The Rust walker now covers CommonJS and statically analyzable dynamic
edges, conditional and subpath exports/imports, dependency-kind
classification, duplicate and symlinked packages, browser resolution,
non-JavaScript assets, and emulated host hooks. The XS-hosted
compartment mapper bundle remains deferred.

Phase 5's item 3 (the registry-table resolution path) landed
**independently** in `llm` via `designs/endor-npm-registry-proxy.md`
Phases 4/5 (`assemble_entry` + `cmd_run_entry`, merged in
PRs #799 #800 #803 #805 #812 #818 #862) and, on this PR's rebase
onto `llm`, became the **default** resolver for `endor run
<entry.js>`. The `node_modules` walker this PR contributes is now
the **legacy** resolver, reachable behind an explicit
`--node-modules` flag. See § Reconciliation with the registry-cache
resolver below — this is the shape the maintainer asked for on
PR #282 (registry-cache default, a flag for the legacy Node-style
walk).

- **Phase 1**: `ContentStore` is available standalone via
  `endo::cas::ContentStore::open()` (implemented in
  daemon-cas-management).
- **Phase 2**: `rust/endo/src/cas_archive.rs` — `ingest_archive`
  extracts ZIP contents into CAS as blobs with tree manifests.
  `load_archive_from_cas` reconstructs `LoadedArchive` from a root
  hash. `endor run` now ingests to CAS and prints root hash.
  `endor run --cas <hash>` re-runs from CAS. `--no-cas` preserves
  legacy behavior. `run_xs_archive_loaded` added to xsnap for
  executing pre-loaded archives.
- **Phase 4** (no-dependency case):
  `rust/endo/src/cas_archive.rs` — `ingest_entry_point(cas, path)`
  synthesises a one-compartment, one-module archive around a
  single source file, stores both the synthesised
  `compartment-map.json` and the entry source as CAS blobs, and
  returns the same `IngestedArchive` shape Phases 2 and 3 use.
  `rust/endo/src/bin/endor.rs` — `endor run <entry.js>` detects
  source-extension inputs (`.js`, `.mjs`, `.cjs`, `.json`) via
  the new `classify_run_input` helper and dispatches to
  `cmd_run_entry_node_modules`. The ZIP-versus-entry-point
  discrimination follows the design's "input form detection by
  file type, not flags" rule: extension first, then a four-byte
  `PK\x03\x04` magic check for extension-less ZIPs.
  Execution converges with Phases 2 and 3 on
  `run_xs_archive_loaded`, so the same XS install path runs all
  three forms.

- **Phase 5** (entry-point with local `node_modules` walk):
  `rust/endo/src/entry_walk.rs` —
  `ingest_entry_point_with_deps(cas, entry_path)` walks the
  static-import graph starting from `entry_path`, classifies
  each specifier as relative (same compartment) or bare
  (resolved via sibling `node_modules` upward from the
  importer), and emits a multi-compartment archive whose
  compartment-map.json carries one `<unscoped-name>-v<version>`
  compartment per resolved package plus the entry compartment
  (`entry-v1.0.0` when the entry has no sibling `package.json`,
  `<pkg>-v<ver>` when it does). Cross-compartment references
  are encoded as `ModuleDescriptor::Link` entries so the
  XS-side install path lights up unchanged.
  `rust/endo/src/bin/endor.rs` — `cmd_run_entry_node_modules`
  pre-scans the entry source for static imports and routes to
  the walker when any are present; entries without imports stay
  on the Phase 4 fast path (the no-deps regression surface is
  unchanged).
  Acceptance: the design's Phase 5 test (`endor run app.js`
  where `app.js` imports from a local `node_modules` package)
  is covered by `ingest_walks_bare_import_into_separate_compartment`
  in the test suite plus a hand smoke-test of the CLI binary.

### Reconciliation with the registry-cache resolver

While this PR was in review, `llm` shipped a *second*, independently
designed implementation of the same `endor run <entry.js>` surface:
`designs/endor-npm-registry-proxy.md` Phases 4/5 (`assemble_entry` +
`cmd_run_entry`). The two resolvers reach the same on-disk CAS
layout by opposed means:

- **This PR's walker** (`entry_walk::ingest_entry_point_with_deps`)
  emulates Node by walking a sibling `node_modules` tree on disk. It
  is a second implementation of `@endo/compartment-mapper`'s
  resolution logic in Rust, and requires the dependencies to have
  already been installed into `node_modules` by a package manager.
- **The registry-cache resolver** (`assemble::assemble_entry`) does
  **not** consult `node_modules` at all. It discovers the enclosing
  workspace and resolves dependency edges naming sibling workspace
  members to their **local working trees** (`workspace:` ranges
  always; plain semver ranges when the local version satisfies),
  and resolves every **non-workspace** dependency from the endor
  registry cache (the registry table as lock/cache, fetching and
  content-addressing on a miss). It is the "new semantics" — a
  program runs from its source tree plus a content-addressed cache,
  with no `node_modules` materialisation required.

On the rebase onto `llm`, a plain auto-merge silently routed the
default `endor run <entry.js>` to this PR's walker, dropping the
registry path `llm` had shipped. That was resolved additively (this
PR's reconcile commit) per the maintainer's PR #282 direction:

- **Default** `endor run <entry.js>` -> the registry-cache resolver
  (`cmd_run_entry`). No `node_modules` consulted. This is the
  intended steady state: it covers both the workspace-local and the
  external-dependency cases, so it is a complete replacement for the
  walker's job on real programs — not a stub.
- **`--node-modules`** `endor run <entry.js>` -> this PR's legacy
  Node-style walker (`cmd_run_entry_node_modules`), for the
  install-first, `node_modules`-present workflow.

The dispatch is a pure `entry_resolution()` discriminator pinned by
unit tests (`bin/endor.rs`), because the `endo` crate is not in the
CI matrix and the choice must not silently regress on a future
rebase.

**End-state of the walker.** The `--node-modules` path is a legacy
escape hatch, not a permanent parallel resolver. Its long-term fate
is deprecation once the registry-cache resolver's Node-emulation
parity is *proven and drift-guarded* — the work the maintainer asked
for in the same review as this reconciliation: run every applicable
`@endo/compartment-mapper` test fixture against the resolver and fail
the suite when an unaccounted fixture appears (tracked separately as
the compartment-mapper fixture-parity job on this PR). Until that
safeguard demonstrates the registry-cache path matches
compartment-mapper's resolution on the full fixture corpus, the
walker stays as the fallback for cases the registry path has not yet
been proven to cover. Removing it is a follow-up gated on that
parity, not part of this PR.

### Fixture-parity ratchet

The walker is checked against committed compartment-map goldens produced by
the independent `@endo/compartment-mapper` implementation. The manifest in
`rust/endo/tests/compartment_mapper_fixture_parity.rs` accounts for every
`packages/compartment-mapper/test/fixtures-*` directory exactly once and has a
monotonic exercised floor. Adding or removing an unaccounted fixture fails the
test, so exclusions cannot silently accumulate.

The goldens are produced by a single node reference oracle
(`packages/compartment-mapper/test/_parity-oracle.js`) with two consumers, so
their notion of "the node compartment map for a fixture" cannot drift apart.
`rust/endo/tools/gen-parity-golden.mjs` is the CLI that (re)generates and
`--check`s the committed goldens. The compartment mapper's own ava suite
(`packages/compartment-mapper/test/fixture-parity.test.js`) imports the same
oracle and confirms, on Node.js as part of `yarn test`, that every committed
golden still matches what the pure-JavaScript implementation produces — so a
change to `@endo/compartment-mapper` that would invalidate a golden fails the
package's own tests rather than only the separate generator `--check`. For
`endor-baseline` fixtures (where compartment-mapper does not yield a comparable
fixture-local map) the ava test asserts the documented divergence still holds,
so a mapper change that *removes* the divergence is surfaced rather than
silently skipped.

Fixture-specific harness inputs are **emulated, not refactored away**. The Node
oracle and Rust walker receive equivalent conditions, common dependencies,
language registrations, exit modules, and module-source hooks. This preserves
the fixture as the test subject instead of simplifying away the behavior under
comparison. The campaign groups are:

1. Group A: CommonJS `require()` graph following.
2. Group B: statically analyzable dynamic `import()` and `require()`.
3. Group C: conditional and subpath `exports` and `#imports`.
4. Group D: development, peer, optional, and bundled dependency semantics.
5. Group E: language-for-extension and non-JavaScript assets.
6. Group F: exit-module and module-source host hooks.
7. Group G: duplicate and nested packages, common dependencies, symlinks, and
   browser resolution.

The increments through Group F raise the exercised floor from 7 to 32 fixtures.
Future increments move entries from the accounted-exclusion set to the exercised
set and raise that floor; they must not weaken the golden diff or drift guard.

### Deviation from the design's Option B (XS-hosted mapper still deferred)

The design proposes an XS-hosted compartment mapper bundle
(Option B § Compartment mapper implementation) as the chosen
near-term approach. Phase 4 deferred it ("the XS-hosted mapper
becomes load-bearing in Phase 5"); Phase 5 chose Option A (a
Rust-native mapper) instead, for the same reason Phase 4 chose
Rust-side synthesis: the infrastructure the XS-hosted mapper
requires (bundling `@endo/compartment-mapper` for XS, wiring
filesystem host powers into a fresh mapper machine, and a
two-machine handshake that captures the mapper's
CompartmentMap output before the execution machine boots) is
large enough to warrant its own phase, separate from "walk
local dependencies into a multi-compartment archive".

For the Phase 5 acceptance test (static ES imports ->
relative/bare resolution -> `package.json` `exports.default` /
`main` / `index.js` cascade -> `node_modules` upward walk),
Option A and Option B converge on the same `CompartmentMap`
shape and the same on-disk CAS layout. The fixture-parity increments on this PR
subsequently implemented the conditional/subpath exports, dynamic import,
CommonJS, host-hook, and asset-language capabilities originally listed here as
deferred. The remaining architectural deviation is therefore the
implementation engine itself: the legacy `--node-modules` path is Rust-native
rather than an XS-hosted invocation of `@endo/compartment-mapper`. The golden
oracle and drift guard described in § Fixture-parity ratchet constrain that
reimplementation until the registry resolver fully supersedes it.

### Deviation from the design's Phase 5 plan: local node_modules first

The design's Phase 5 plan calls out three sub-items:

1. `package.json` resolution to the XS-hosted mapper.
2. `node_modules` tree walking for local dependencies.
3. Registry-table lookup for remote dependencies (requires
   `designs/endor-npm-registry-proxy.md` Phase 4).

This PR ships items 1 and 2 (in the Rust walk per the
above deviation note) plus the design's acceptance test for
the phase. **Item 3 has since landed** — not as an extension of
this walker, but as the standalone registry-cache resolver in
`designs/endor-npm-registry-proxy.md` Phases 4/5, merged to `llm`
(`assemble_entry` + `cmd_run_entry`; PRs #799 #800 #803 #805 #812
#818 #862). Rather than teaching this walker's `resolve_bare` to
fall back to the registry table on a `find_node_modules_package`
miss — the plan when this note was written — the registry path
became the **default** resolver and this walker became the legacy
`--node-modules` path (see § Reconciliation with the registry-cache
resolver above). The original "extend `resolve_bare`" plan is
therefore superseded: the two resolution strategies live side by
side under the dispatch flag instead of being fused into one walk.

### Cross-PR coordination with Phase 3

Phase 3 (directory input, PR #278) is in review against `llm` at
this PR's open time; both Phase 3 and Phase 4 branch off `llm`
and target `llm`. The two PRs touch `cas_archive.rs` and
`endor.rs` in non-overlapping regions: Phase 3 adds
`ingest_directory` and the `RunInput::Directory` dispatch
branch; Phase 4 adds `ingest_entry_point` and the
`RunInput::EntryPoint` dispatch branch. When Phase 3 lands
first, this PR's rebase needs:

1. The `RunInput` enum gains a `Directory` variant; the
   classifier returns it when `p.is_dir()`.
2. The CLI dispatch grows a `RunInput::Directory` arm calling
   `cmd_run_directory_with_cas`.
3. The `encode_manifest_sorted` determinism helper Phase 3
   introduces should be used by `ingest_entry_point`'s tree
   serialisation calls so the synthesised root hash is
   reproducible across runs. This is not required by Phase 4's
   own tests (the synthetic map has one or two entries and
   `HashMap` iteration is effectively stable per-run for those
   sizes) but it brings entry-point ingestion under the same
   determinism contract as the ZIP and directory paths.

When this PR lands first, Phase 3's rebase needs the mirror
change: insert the `Directory` arm alongside the existing
`EntryPoint` arm in the classifier and dispatch.

## What is the Problem Being Solved?

`endor run` currently accepts only a pre-built ZIP archive.
The archive is read entirely into memory, its modules
extracted, and a standalone XS machine executes the entry
compartment.

This is limiting in three ways:

1. **No CAS integration.**
   The archive contents are ephemeral — they exist only in
   memory for the duration of the run.
   There is no deduplication, no caching, and no way for the
   running program to refer to its own modules by hash.

2. **No directory input.**
   A developer with an unpacked archive (a directory
   containing `compartment-map.json` and module sources)
   must first zip it before running.
   This is friction during development.

3. **No entry-point input.**
   A developer with a single `.js` file (or a package with
   `package.json`) must first run the compartment mapper to
   produce an archive, then run the archive.
   `endor run app.js` should just work.

This design expands `endor run` to accept three input forms
and integrates the CAS as the backing store for module
content.

## Design

### Input forms

```
endor run <archive.zip>        # Form 1: ZIP archive
endor run <directory/>         # Form 2: unpacked archive
endor run <entry.js>           # Form 3: entry-point module
```

The CLI detects the form by examining the path:

1. If the path has a `.zip` extension or is a file whose
   first bytes are the ZIP magic number (`PK\x03\x04`),
   treat it as a ZIP archive.
2. If the path is a directory containing
   `compartment-map.json`, treat it as an unpacked archive.
3. Otherwise, treat it as an entry-point module.

### Form 1: ZIP archive (enhanced)

Current behavior: read ZIP into memory, extract modules,
execute.

Enhanced behavior:

1. Read the ZIP file.
2. Extract each module source into the CAS as a blob.
3. Build a tree entry in the CAS representing the archive's
   directory structure.
4. Store the `compartment-map.json` as a blob.
5. Create a root tree entry referencing the manifest and all
   compartment trees.
6. Execute the program using CAS-backed module loading: the
   XS import hook fetches module sources by hash from the
   CAS instead of from in-memory buffers.

The root hash is printed to stderr so it can be reused:

```
endor[run]: archive root sha256:abc123...
```

A subsequent run can use the hash directly:

```
endor run --cas sha256:abc123...
```

### Form 2: Unpacked directory

1. Walk the directory tree.
2. For each file, compute SHA-256 and store in the CAS
   (skip if already present — deduplication).
3. Build tree entries bottom-up, mirroring the directory
   structure.
4. Read `compartment-map.json` from the directory root.
5. Execute using the same CAS-backed module loading as
   Form 1.

This is equivalent to zipping the directory and running
Form 1, but avoids the intermediate ZIP.

### Form 3: Entry-point module

This is the most complex form.
It requires running the compartment mapper to discover
dependencies, resolve modules, and build the archive — all
before executing the program.

#### Step 1: Compartment mapping

`endor run app.js` invokes a built-in compartment mapper
that:

1. Reads `app.js` and determines its module type (ESM or
   CJS) from file extension and any nearby `package.json`.
2. Walks the dependency graph by parsing `import`/`require`
   statements (static analysis, not execution).
3. Resolves package specifiers using the registry table
   (see [endor-npm-registry-proxy](endor-npm-registry-proxy.md))
   or the local `node_modules` tree if present.
4. Builds a `CompartmentMap` structure.

#### Step 2: CAS ingestion

For each module discovered by the mapper:

1. Read the source bytes.
2. Store in the CAS as a blob.
3. Record the hash in the compartment map's module
   descriptor.

Build tree entries for each compartment and a root tree
for the archive.

#### Step 3: Execution

Execute using CAS-backed module loading, same as Forms 1
and 2.

#### Compartment mapper implementation

The compartment mapper is a substantial piece of code.
The existing `@endo/compartment-mapper` package in Node.js
performs this role.
For `endor run`, three options:

**Option A: Rust-native mapper (preferred for long term).**
Implement module resolution and dependency walking in Rust.
This avoids depending on Node.js for the build step.
The mapper needs:
- A JavaScript parser for `import`/`require` extraction
  (or a simpler regex-based heuristic for static imports).
- `package.json` reading and `exports`/`main` resolution.
- The registry table for package resolution (Phase 3).

**Option B: XS-hosted mapper (preferred for near term).**
Run the compartment mapper itself inside an XS machine.
The mapper is JavaScript — it can execute in XS with
filesystem host functions.
The flow: create an XS machine with fs powers, load the
compartment mapper bundle, invoke `mapNodeModules()`, get
back a `CompartmentMap`, then ingest sources into the CAS.

This reuses the existing well-tested mapper code with
minimal new Rust code.
The cost is a startup latency for the mapper machine, but
this is a one-time cost per `endor run` invocation.

**Option C: Shell out to Node.js.**
Use `node -e "..."` to run the compartment mapper.
This defeats the purpose of `endor run` being
self-contained.
Rejected.

**Chosen approach: Option B** (XS-hosted mapper) for the
near term, with Option A as a future optimization.

### CAS-backed module loading

The key architectural change is that module loading in the
XS worker reads from the CAS by hash rather than from
in-memory buffers or ZIP entries.

The `archive.rs` module gains a new loading mode:

```rust
pub fn load_archive_from_cas(
    cas: &ContentStore,
    root_hash: &str,
) -> Result<LoadedArchive, ArchiveError>
```

This:
1. Fetches the root tree from the CAS.
2. Reads `compartment-map.json` from the tree.
3. For each module in the compartment map, records its
   CAS hash (derived from the tree entry) instead of
   loading bytes eagerly.
4. The import hook fetches module bytes lazily from the
   CAS on first import.

Lazy loading is important for large applications where
only a subset of modules are actually imported at runtime.

### CLI changes

```
endor run [options] <path-or-hash>

Options:
  -e, --engine <engine>   Engine to use (default: xs)
  --cas <hash>            Run from CAS root hash directly
  --cas-dir <path>        CAS directory (default: state/store-sha256)
  --no-cas                Don't use CAS (current behavior, for compat)
```

The `--cas-dir` flag allows using a CAS in a non-default
location.
This is useful for standalone runs without a running daemon.

When `--no-cas` is specified, the current behavior is
preserved: ZIP contents are loaded into memory without CAS
integration.
This is a fallback for environments where CAS writes are
undesirable (e.g., read-only filesystems).

## Dependencies

| Design | Relationship |
|--------|-------------|
| [daemon-cas-management](daemon-cas-management.md) | Requires: ContentStore for blob/tree storage, retain/release |
| [endor-npm-registry-proxy](endor-npm-registry-proxy.md) | Enables: Form 3 package resolution without node_modules |
| [daemon-endor-architecture](daemon-endor-architecture.md) | Extends: `endor run` becomes CAS-aware |

## Implementation phases

### Phase 1: ContentStore in standalone mode

1. Extract `ContentStore` from the daemon CAS design into a
   shared crate or module usable by both the daemon and
   `endor run`.
2. `endor run` creates a `ContentStore` at `--cas-dir`
   (defaulting to a temporary directory for standalone runs,
   or `{statePath}/store-sha256` if a daemon state directory
   is detected).
3. **Test**: `ContentStore` store/fetch round-trip in a temp
   directory.

### Phase 2: ZIP archive CAS ingestion

1. When running a ZIP, extract each file into the CAS.
2. Build tree entries for the archive structure.
3. Print root hash to stderr.
4. Load modules from CAS instead of memory.
5. Support `--cas <hash>` for re-running a previously
   ingested archive.
6. **Test**: run a ZIP, verify CAS files created, re-run
   from hash.

### Phase 3: Unpacked directory input

1. Detect directory input in CLI.
2. Walk directory, ingest files into CAS.
3. Build compartment map from `compartment-map.json` in the
   directory.
4. Execute using CAS-backed loading.
5. **Test**: create a directory with compartment-map.json and
   module sources, `endor run dir/`, verify execution.

### Phase 4: Entry-point module input

**Status**: Implemented for the no-dependency case in Rust;
the XS-hosted mapper is deferred to Phase 5 where the bundle
and the dependency walk become load-bearing together. See the
*Deviation from the design's Option B* note in the Status
section.

1. (Deferred to Phase 5.) Bundle the compartment mapper for
   XS execution.
2. (Deferred to Phase 5.) Implement the two-phase flow: map
   in XS, then execute in a fresh XS machine.
3. Synthesise a one-compartment, one-module
   `compartment-map.json` directly in Rust. CAS ingestion
   stores the entry source and the synthesised map as blobs;
   the root tree mirrors `ingest_archive`'s layout so the
   shared `load_archive_from_cas` reader handles all input
   forms identically.
4. **Test**: `endor run hello.js` with a simple module that
   has no dependencies. Eight new tests in
   `cas_archive::tests` cover the synthesis, the root tree
   layout, the CAS round-trip, the parser-by-extension
   mapping, the rejection paths (missing file, directory
   input, unsupported extension), and the shape equivalence
   with the ZIP path.

### Phase 5: Entry-point with dependencies

**Status**: items 1 and 2 are implemented in Rust (Option A) on
this PR. Item 3 landed independently through
`designs/endor-npm-registry-proxy.md` and is now the default resolver.
The fixture-parity increments also implement conditional and subpath
exports/imports, CommonJS and dynamic edges, dependency classification,
asset languages, and host hooks. The XS-hosted mapper (Option B) remains
deferred; see the Status section's deviation and fixture-parity notes.

1. (Done in Rust.) `package.json` resolution: the walker reads
   `name`, `version`, `main`, `module`, and
   `exports["."]["default"]` (with the
   `exports["."]` string shorthand and the bare `exports`
   shorthand). Resolution cascades
   `exports.default` -> `module` -> `main` -> `index.<ext>` per
   `entry_walk::resolve_package_main`.
2. (Done in Rust.) `node_modules` tree walking via
   `entry_walk::find_node_modules_package`: walks upward from
   the importing file's directory, honouring scoped packages
   (`@scope/name`) and subpaths
   (`pkg/sub/foo.js`). Each resolved package becomes its own
   compartment in the synthesised compartment-map.
3. (Done independently.) Registry-table lookup for remote dependencies
   landed through [endor-npm-registry-proxy](endor-npm-registry-proxy.md).
   Its `assemble_entry` path is the default for `endor run <entry.js>`;
   this PR's local walker remains behind `--node-modules`. The original
   plan to extend `entry_walk::resolve_bare` on a
   `find_node_modules_package` miss is superseded.
4. **Test** (done): the unit and integration suites cover the acceptance
   test (`ingest_walks_bare_import_into_separate_compartment`), scan
   grammar, package metadata, resolution cascade, escape rejection,
   dependency-kind behavior, and deterministic CAS trees. The fixture-parity
   integration suite independently checks 32 compartment-mapper fixtures and
   accounts for every fixture through its drift guard.

## Design decisions

1. **CAS as the universal backing store.**
   All three input forms converge on the same CAS-backed
   module loading path.
   This means the runtime behavior is identical regardless
   of input form — only the ingestion differs.

2. **Lazy module loading from CAS.**
   Large applications may have thousands of modules but only
   import a fraction at runtime.
   Fetching bytes on demand avoids loading unused modules
   into memory.

3. **XS-hosted compartment mapper (near term).**
   Reuses the battle-tested `@endo/compartment-mapper`
   JavaScript code.
   The alternative (Rust-native mapper) is a large
   undertaking that duplicates well-tested logic.
   The XS-hosted approach has ~100ms startup overhead for
   the mapper machine — acceptable for a CLI tool.

4. **Standalone CAS for `endor run`.**
   When no daemon is running, `endor run` creates a local
   CAS in a temp directory.
   This avoids coupling `endor run` to the daemon lifecycle
   while still enabling CAS deduplication and caching when
   the daemon is present.

5. **Input form detection by file type, not flags.**
   `endor run foo` examines `foo` to determine the form.
   Explicit `--zip`, `--dir`, `--entry` flags are available
   for disambiguation but rarely needed.

## Prompt

> Propose a design document for how we can expand the utility
> of the `endor run` command, such that the zip file presented
> would be first extracted into the content address store,
> enabling the child process to load modules from the CAS by
> root hash and path. Then, generalize `endor run` such that
> it can absorb an application in any of these ways:
> 1. by presenting a zip
> 2. by presenting a directory with the content in the same
>    shape as the zip, including compartment-map.json
> 3. by presenting the entry point module, in which case we
>    first run a program that uses the compartment mapper to
>    write an archive of the application directly to the content
>    address store, using specialized write powers, then
>    executes it.
