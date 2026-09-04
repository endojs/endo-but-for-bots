# Endor Registry Proxy Mapper Worker

| | |
|---|---|
| **Created** | 2026-08-06 |
| **Author** | Kris Kowal (prompted) |
| **Status** | Proposed |

## What is the Problem Being Solved?

The npm-via-CAS path described by
[endor-npm-registry-proxy](endor-npm-registry-proxy.md) now acquires packages,
selects versions, assembles a compartment graph, and executes that graph without
`node_modules`. The acquisition half belongs in Rust: it owns HTTP, npm
configuration, the registry table, semver selection, integrity checking, and the
CAS. Package module resolution does not. After
[PR 875](https://github.com/endojs/endo-but-for-bots/pull/875), Endor has a second
implementation of package `main`, `exports`, and `imports` interpretation,
conditional targets, and subpath-pattern precedence in
`rust/endo/xsnap/src/archive.rs`.

This duplication will drift whenever Node package semantics change. The
compartment mapper already implements these rules and already turns package
descriptors into compartment maps. Endor should give a JavaScript mapper worker
a read-only view of the packages Rust acquired, then execute the source-only
archive that worker produces.

## Scope

This design moves package-to-module mapping into an XS-hosted JavaScript worker
and makes packaged-application fixtures a shared contract among Node,
`@endo/compartment-mapper`, and Endor. It does not move registry access, version
selection, workspace selection, integrity verification, or CAS persistence out
of Rust. It also does not add Node builtins to the confined runtime.

## Design

### Two phases, two machines

`endor run <entry>` becomes an explicit build-and-run pipeline:

1. Rust resolves versions, fetches missing tarballs, verifies them, and stores
   the entry package and every selected package as CAS trees.
2. A fresh mapper XS machine runs a bundled `@endo/compartment-mapper`. It maps
   the CAS graph and emits a source-only archive.
3. Rust stores the archive in the CAS and executes it in a separate XS machine.

The mapper machine is trusted build tooling, but receives no network, registry,
SQLite, environment, clock, or guest endowments. The executor receives no mapper
read power. No application module is evaluated while the mapper captures the
graph.

### Rust-to-worker boundary

After `resolve_transitive_outcome`, Rust replaces `build_compartment_map` with a
canonical graph plan:

```ts
type EndorGraphPlan = {
  entry: { package: string; module: string };
  packages: Record<string, {
    treeHash: string;
    dependencies: Record<string, string>; // requested name -> package key
  }>;
  conditions: string[];
};
```

Package keys are opaque and stable for this run. The entry and workspace trees
use the same representation as registry packages. Optional dependencies that
Rust could not resolve are absent; every included edge names one selected tree.

The host exposes two narrow synchronous callbacks to the mapper bundle:

- `maybeRead(virtualFileUrl)` returns bytes from one named CAS tree or
  `undefined`.
- `canonical(virtualFileUrl)` resolves a virtual dependency alias to its
  target package URL.

The adapter presents roots as `file:///endor/packages/<key>/` so existing
compartment-mapper URL and `node_modules` search logic can be used unchanged.
For example,
`file:///endor/packages/a/node_modules/b/package.json` is an alias for the tree
named by `packages.a.dependencies.b`; `canonical` maps it to package `b`'s
canonical virtual root. Nothing is materialized on disk.

The worker calls `mapNodeModules` with these read powers, then
`makeArchiveFromMap` with the source parsers. Its single success result is the
source-only archive bytes plus their digest. Its failure result is a structured
phase, virtual URL, and diagnostic. Rust enforces input/output size limits and
stores output only after the worker succeeds. Repeating a cached, offline run
must produce the same graph plan and archive hash.

### Shared normalized package resolution

The archive must also preserve behavior for a runtime-computed CommonJS
`require`, which cannot always be reduced to the specifiers observed during
capture. Add a compartment-mapper API that normalizes a package descriptor into
separate import and require resolution tables:

- exact external exports and internal `#` aliases;
- ordered wildcard descriptors, including `null` blocks;
- targets that name a local module or a concrete dependency compartment;
- concrete default entry and parser hints;
- targets selected under the configured conditions plus `import` or `require`.

`node-modules.js` and the Endor mapper worker both use this API. The archive map
retains these normalized tables instead of retaining raw `package.json` as a
second resolver input. The executor applies them with the shared
`makeMultiSubpathReplacer` bundled for XS. Thus condition traversal and pattern
precedence have one implementation in `packages/compartment-mapper`; the Rust
archive crate merely deserializes tables and installs exact links and sources.

This division deliberately leaves generic runtime mechanics in
`rust/endo/xsnap/src/archive.rs`: compartment construction, source lookup,
relative path normalization, CJS module caching and evaluation, and archive
error reporting. It delegates or removes the following package semantics:

| Current location | Delegated responsibility |
|---|---|
| `assemble.rs` `build_compartment_map` / `bind_edges` | Package graph and concrete module-link construction |
| `execute.rs` `collect_module_files` | Reachable-source capture by `makeArchiveFromMap` |
| `execute.rs` `read_tree_manifest`, `normalize_to_esm`, and `cjs_lexer` | Parser choice and static CJS import/export analysis from compartment-mapper; the executor retains only its XS-specific CJS facade |
| `execute.rs` `parse_map` and its unresolved `"."` link synthesis | Loading the mapper-produced source archive |
| `archive.rs` `__packageManifest`, `__parsePackageName` | Manifest interpretation and package/subpath splitting |
| `archive.rs` `__resolveExportTarget`, `__matchSubpathMap`, `__matchExports` | Conditions, arrays, `null`, and pattern precedence |
| `archive.rs` `__resolveExports`, `__resolveImports` | `main` / `exports` / `imports` target selection |

During migration, `load_assembled_archive` may remain behind a test-only legacy
adapter. The production path must not fall back to the handwritten resolver;
otherwise parity failures would be masked.

## Shared Packaged-Application Fixtures

The current `fixtures-package-imports-exports` case is shared only at the source
file level: Node and compartment-mapper execute it directly, while the Rust test
hand-assembles its manifest and files. Replace that one-off with a corpus runner.

Create a neutral corpus at `test/fixtures/packaged-applications/`. Each case
contains package source directories and a small `fixture.json` naming the entry,
conditions, expected success or failure, and feature requirements. Successful
entries are self-checking: they throw on a wrong result and export a fixed
sentinel. The descriptor contains no runtime-specific expected value or skip.

Three adapters consume every eligible case:

- The Node adapter creates a temporary package layout and executes the entry
  under Node, including `--conditions` from the descriptor.
- The compartment-mapper adapter exposes the same package directories through
  read powers and exercises both `importFromMap` and source-archive execution.
- The Endor adapter generates deterministic mock registry metadata and tarballs
  from the package directories, invokes the full resolve -> mapper worker -> XS
  execution path, then repeats with a network-refusing client to prove offline
  replay.

Start by moving the packaged-application cases for ESM and CJS linkage, JSON,
cycles, package `main`, conditional and patterned `exports`, package `imports`,
optional dependencies, and multiple versions. Mapper-internal fixtures for
policy, exit modules, custom parsers, symlink canonicalization, or malformed
graph diagnostics stay under `packages/compartment-mapper/test`; they do not
describe behavior all three runtimes claim to support. A generic `requires`
list records such capabilities when a later case needs them, and each adapter's
declared capability set controls eligibility. The corpus runner fails if a case
requiring only the common baseline is not exercised by all three adapters.

The move is staged: first add the neutral corpus and adapters, then `git mv` each
qualifying fixture and delete its old runtime-specific assertion. No adapter may
copy fixture source into a second checked-in location. This makes the top-level
directory the canonical set without forcing every compartment-mapper unit
fixture into a global namespace.

## Phased Implementation

1. Extract and test the pure package-resolution API in
   `packages/compartment-mapper`; make `node-modules.js` consume it and add
   import-vs-require golden tables.
2. Add the virtual-CAS read powers, mapper entry module, reproducible bundle
   script, and a Rust host wrapper. Prove a graph plan maps identically twice
   without evaluating its entry.
3. Have assembly store the mapper-produced source archive. Teach the Rust loader
   to consume parser tags and normalized resolution tables, then remove the
   handwritten package resolver from the production path.
4. Establish `test/fixtures/packaged-applications` and the three adapters; migrate
   `fixtures-package-imports-exports` first, then the rest of the common-baseline
   matrix.
5. Delete the legacy map builder/resolver and its hand-assembled parity tests
   after the shared corpus is green on Node, compartment-mapper, and Endor.

## Acceptance Criteria

- No production code in `rust/endo` interprets `main`, `exports`, or `imports`,
  traverses conditional targets, or orders subpath patterns.
- The mapper and executor use resolution code imported from
  `packages/compartment-mapper`, not a copied JavaScript string.
- `endor run --offline` maps and executes an already-cached application without
  filesystem materialization or network access, with a deterministic archive
  hash.
- Every common-baseline packaged-application fixture runs under Node,
  compartment-mapper source/archive paths, and Endor; the test harness reports
  the same case names for all three.
- The PR 875 subpath fixture has one source location and no Rust
  `include_str!` file inventory.

## Dependencies

| Design | Relationship |
|---|---|
| [endor-npm-registry-proxy](endor-npm-registry-proxy.md) | Refactors its implemented assembly and execution halves |
| [endor-run-expanded](endor-run-expanded.md) | Completes its chosen XS-hosted mapper direction |
| [daemon-make-archive](daemon-make-archive.md) | Reuses the source-only archive contract |

## Open Questions

- Resolved: Should all compartment-mapper fixtures move to the top level? No.
  Only packaged-application cases that express cross-runtime behavior move;
  mapper implementation fixtures remain package-local.
- Resolved: Should mapper and application code share one XS machine? No. Mapping
  and execution have different powers and lifetimes, so they use fresh machines.

## Prompt

> Follow up on the approval review of PR 875 by moving more of the npm-via-CAS
> registry proxy into a JavaScript worker that reuses compartment-mapper, testing
> Endor against compartment-mapper's packaged-application fixtures, and
> considering a shared top-level fixture directory.
