# daemon-make-archive

| | |
|---|---|
| **Created** | 2026-04-23 |
| **Updated** | 2026-04-23 |
| **Author** | Kris Kowal (prompted) |
| **Status** | **Complete** |

## What is the Problem Being Solved?

The daemon currently exposes `makeBundle`, which executes a JavaScript caplet
packaged as an `endoZipBase64` bundle (a JSON document whose
`endoZipBase64` field is a base-64-encoded ZIP of a compartment map plus
**precompiled** ESM/CJS modules).  This shape is convenient for Node.js but
incompatible with our Rust supervisor and XS workers:

- Bundles are JSON-wrapped binary that has to be decoded and re-parsed before
  execution.
- The precompiled module formats (`pre-mjs-json`, `pre-cjs-json`) carry
  Babel-compiled functor source, which is significantly larger than the
  original modules and cannot be re-shared with workers that lack the
  precompile parsers.
- Rust workers cannot read a base-64 JSON wrapper out-of-band and cannot
  reuse the daemon's content-addressable store (CAS) for module sources.

We want to replace `makeBundle` with `makeArchive`, which:

1. Takes a readable blob reference to a **ZIP file** containing
   `compartment-map.json` and modules in their **source** formats (no
   precompiled module formats).
2. Lets Node.js workers compile each module at runtime via
   `@endo/module-source`.
3. Lets Rust workers read the underlying content directly from the CAS and
   run in-process.
4. Removes `makeBundle` entirely; replaces every `-b`/`--bundle` CLI option
   with `-z`/`--archive`.

## Status

- [x] Design captured (this document).
- [x] Daemon: `MakeArchiveFormula`, dispatcher case, `formulateArchive`.
- [x] Worker (Node): `makeArchive` on the worker daemon facet streams
  the archive via `streamBase64` and runs `compartment-mapper`'s
  `parseArchive` with the import-archive-all-parsers set.
- [x] Host: `EndoHost.makeArchive` mirroring the legacy `makeBundle`.
- [x] CLI: `endo archive`, plus `-z`/`--archive` on `endo run` /
  `endo make`.  `endo run` and `endo make` now build a source-only
  archive on the fly when given a bare file path.
- [x] Help text: `makeArchive` entry added; `makeBundle` entry removed.
- [x] Tests: full `makeBundle` end-to-end coverage migrated to
  `makeArchive` (env, persistence, cancellation, request flow).
- [x] **Phase 5 — Removal**: `makeBundle` is gone from the daemon
  (`WorkerDaemonFacet`, `MakeBundleFormula`, dispatcher case,
  `formulateBundle`, `EndoHost.makeBundle`, the inspector case, the
  formula-type whitelist), from the CLI (`endo bundle` command, the
  `-b`/`--bundle` options on `run`/`make`, `commands/bundle.js`, and
  `@endo/bundle-source` + `@endo/import-bundle` dependencies), and
  from the daemon test suite (`doMakeBundle`, `bundleSource` import).
- [x] **Phase 4 — Worker (Rust / XS)**: the XS worker bootstrap
  (`rust/endo/xsnap/src/worker_bootstrap.js`) already implements
  `makeArchive` end-to-end: it streams the archive bytes via
  `streamBase64`, decodes and assembles them, then calls the Rust
  host function `hostImportArchive` (defined at
  `rust/endo/xsnap/src/worker_io.rs:508`) which parses the ZIP via
  `archive::load_archive` and installs the entry compartment via
  `archive::install_archive`.  The worker then captures the entry
  namespace and runs `make(powers, context, { env })`.

  The dead `makeBundle` stub was removed from
  `worker_bootstrap.js` alongside the Phase 5 daemon-side removal.

  *Open optimisation:* the worker currently streams the archive
  through CapTP; for archives already in the CAS we could skip the
  stream and have the Rust worker fetch the SHA-256 directly from
  `cas_archive::load_archive_from_cas`.  Tracked as a follow-up; not
  required for correctness.

## Design

### Wire format

The archive is the same ZIP shape that `@endo/compartment-mapper`'s
`makeArchive` produces today, with one constraint: modules must be
recorded in their **source** language (`mjs`, `cjs`, `json`, `text`,
`bytes`) rather than the precompiled forms (`pre-mjs-json`,
`pre-cjs-json`).  The compartment map's `compartment-map.json` lists
each module with its parser language; the loader on the worker side
uses that to dispatch to the right `ModuleSource` constructor.

The daemon stores the ZIP exactly as it stores any other readable blob
today — as an entry under the CAS keyed by SHA-256.  The Rust supervisor
already ingests archives into CAS via `rust/endo/src/cas_archive.rs`'s
`ingest_archive`, so no on-the-wire format change is needed there.

### Formula type

```ts
type MakeArchiveFormula = {
  type: 'make-archive';
  worker: FormulaIdentifier;
  powers: FormulaIdentifier;
  archive: FormulaIdentifier;     // readable-blob ID of the ZIP
  env?: Record<string, string>;
  cancelWithWorker?: FormulaIdentifier;
};
```

`extractLabeledDeps` reports `[['worker', ...], ['powers', ...],
['archive', ...]]`, plus optional `cancelWithWorker`.  The dispatcher
runs `makeArchive(workerId, powersId, archiveId, env, context,
cancelWithWorker)`, which (mirroring `makeBundle`):

1. Provides the worker controller and looks up its daemon facet.
2. Provides the archive blob (`readable-blob`).
3. Provides the powers ID.
4. Calls `E(workerDaemonFacet).makeArchive(readableArchiveP, powersP,
   farContext, env)`.

### Worker — Node.js

```js
makeArchive: async (readableP, powersP, contextP, env) => {
  const archiveBytes = await E(readableP).bytes();
  const { parseArchive } = await import('@endo/compartment-mapper');
  const { defaultParserForLanguage } = await import(
    '@endo/compartment-mapper/import-parsers.js'
  );
  const application = await parseArchive(archiveBytes, '<archive>', {
    parserForLanguage: defaultParserForLanguage,
  });
  const { namespace } = await application.import({ globals: endowments });
  return namespace.make(powersP, contextP, { env });
};
```

`defaultParserForLanguage` from `import-parsers.js` is the Babel-using
source set (mjs/cjs/json/text/bytes).  This is the only path that
accepts source modules from the archive.

### Worker — Rust / XS

The Rust supervisor already implements archive loading from CAS via
`load_archive_from_cas` and `run_xs_archive_loaded`.  When the daemon
dispatches a `make-archive` formula to a Rust-supervised worker, the
worker daemon facet receives the readable blob, asks the supervisor for
the underlying CAS root hash, and invokes the existing in-process
loader.  No new wire protocol verb is required because the existing
`deliver` envelope already carries enough state.

`makeBundle` is removed from the Rust worker — it has no path to handle
precompiled JSON bundles and was never supported.

### Host

```js
async makeArchive(workerName, archiveName, options) { ... }
```

Mirrors `makeBundle` exactly: looks up the archive pet name, runs
`prepareMakeCaplet`, calls `formulateArchive(...)`.

### CLI

- `endo archive <path>` — replaces `endo bundle`.  Invokes
  `compartment-mapper.makeArchive` (which returns a `Uint8Array`),
  stores the bytes as a readable blob, prints the SHA-512.
- `endo install -z <archive-name> ...` — replaces `-b`.
- `endo run -z <archive-name> ...` — same.
- `endo make -z <archive-name> ...` — same.

The `-b`/`--bundle` option and `endo bundle` command are removed.

### Tests

Every existing `makeBundle` end-to-end test is rewritten to call
`makeArchive` against a source-only archive.  The archive is built from
existing test fixtures with `compartment-mapper.makeArchive`.

The internal `doMakeBundle` test helper in `packages/daemon/test/endo.test.js`
is replaced with `doMakeArchive`.

## Phased implementation

1. **Phase 1 (additive)** — add `make-archive` alongside `make-bundle`:
   formula type, dispatcher case, host method, worker facet method, CLI
   `endo archive` command and `-z` option, archive-based test helper,
   one passing end-to-end archive test.
2. **Phase 2 (migration)** — convert every existing `makeBundle` test
   to `makeArchive`.  Confirm the full suite passes.
3. **Phase 3 (removal)** — delete `makeBundle`, `MakeBundleFormula`,
   the dispatcher case, the host method, the worker facet method, the
   CLI `endo bundle` command, the `-b`/`--bundle` options, and the
   help-text entries.  Bump the daemon's interface version if any
   external consumers exist.

This plan keeps every milestone individually shippable.

## Design Decisions

1. **Same readable-blob storage.** The archive is just bytes; we reuse
   the existing `readable-blob` formula type rather than introducing a
   new `archive-blob` type.  The loader on each worker decides how to
   interpret the bytes.
2. **Compartment-mapper's `parseArchive` on the Node worker.** It
   already handles the ZIP+map format, exposes a clean Application
   facade, and is the canonical Endo loader.  We avoid building a
   second ZIP+map parser.
3. **Source-only contract.** Workers reject archives that contain
   precompiled module languages (`pre-mjs-json`, `pre-cjs-json`).  The
   `parserForLanguage` map we hand to `parseArchive` simply omits the
   precompiled parsers, so attempting to import a precompiled module
   surfaces a clean "unknown language" error from compartment-mapper.
4. **Remove rather than deprecate.** Keeping `makeBundle` would force
   us to maintain the precompiled path on every worker including XS,
   for a feature that has a strict superset (`makeArchive`).  The user
   has authorised removal in this round.

## Dependencies

| Design | Relationship |
|--------|--------------|
| daemon-cas-management | `makeArchive` reuses the CAS archive ingestion path on the Rust side. |
| daemon-capability-bus | Worker facet method dispatch unchanged; uses the existing CapTP envelope. |

## Known Gaps and TODOs

- [ ] Decide what `endo archive` should do when the project tree contains
  a `package.json` without a `main` entry (today `endo bundle` errors
  with a compartment-mapper message; we should mirror that).
- [ ] Consider whether `makeArchive` should accept a CAS root-hash
  reference *directly* (skipping the readable-blob wrapper) for Rust
  workers, to avoid one round-trip through the daemon.  Current design
  punts: the daemon hands a `readable-blob` ref and the Rust worker
  resolves it locally.

## Prompt

> I would like to deprecate makeBundle in favor of a makeArchive routine.
> The difference is that makeArchive will take a readable blob reference
> for a ZIP file containing a compartment-map.json and modules in their
> source formats: no precompiled module formats. The Node.js worker
> implementation would read the ZIP file and compile each module at
> runtime with the ModuleSource from `@endo/module-source`. The Rust
> version would oblige the worker to read the underlying content from
> the CAS directly and run in memory. makeBundle would not be supported
> by Rust workers and so no tests can use it. We would presumably remove
> it entirely, replacing all the CLI that take -b with -z for
> non-pre-compiled ZIP archives. Please flesh out the design, implement,
> and test.
