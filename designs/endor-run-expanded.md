# Expanded `endor run`: Archives, Directories, and Entry Points

| | |
|---|---|
| **Created** | 2026-04-17 |
| **Updated** | 2026-05-18 |
| **Author** | Kris Kowal (prompted) |
| **Status** | In Progress |

## Status

Phases 1-2 and Phase 4 (no-dependency case) implemented; Phase 3
is in review on PR #278; Phase 5 (entry-point with dependency
resolution) remains.

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
  `cmd_run_entry_point_with_cas`. The ZIP-versus-entry-point
  discrimination follows the design's "input form detection by
  file type, not flags" rule: extension first, then a four-byte
  `PK\x03\x04` magic check for extension-less ZIPs.
  Execution converges with Phases 2 and 3 on
  `run_xs_archive_loaded`, so the same XS install path runs all
  three forms.

### Deviation from the design's Option B (deferred to Phase 5)

The design proposes an XS-hosted compartment mapper bundle
(Option B § Compartment mapper implementation) as the chosen
near-term approach for Phase 4. For the no-dependency case the
design pins for Phase 4 ("`endor run hello.js` with a simple
module that has no dependencies"), the XS-hosted mapper would
walk an empty `package.json` and produce exactly the
one-compartment, one-module shape `ingest_entry_point`
synthesises directly. The Rust-side synthesis is the smallest
change that satisfies Phase 4's acceptance criterion without
landing the (substantial) bundling, fs-power-wiring, and
two-machine-handshake infrastructure the XS-hosted mapper
requires.

The XS-hosted mapper becomes load-bearing in Phase 5, where it
walks `package.json`, follows `dependencies`, and resolves a
non-trivial graph. Phase 5 lands the bundle and the
mapper-machine handshake; at that point Phase 4's synthetic
helper can either remain (as the fast path for the
no-dependency case) or be replaced by a single XS-mapper
invocation with an empty resolver. The choice is a Phase 5
design decision and is not pre-empted here.

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

1. Add `package.json` resolution to the XS-hosted mapper.
2. Support `node_modules` tree walking for local
   dependencies.
3. Support registry table lookup for remote dependencies
   (requires [endor-npm-registry-proxy](endor-npm-registry-proxy.md)).
4. **Test**: `endor run app.js` where `app.js` imports from
   a local `node_modules` package.

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
