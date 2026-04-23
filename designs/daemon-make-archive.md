# daemon-make-archive

| | |
|---|---|
| **Created** | 2026-04-23 |
| **Updated** | 2026-04-23 |
| **Author** | Kris Kowal (prompted) |
| **Status** | In Progress |

> **Phases 1–5 are complete.**  The design has since grown a Phase 6
> (the `@node` special name, described below) and a Phase 7
> (`makeCaplet` from a readable tree).  Status is now **In Progress**
> again.

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

- [ ] **Phase 6 — `@node` special name, XS never runs
  `makeUnconfined`.**  We explicitly decide *not* to implement
  `makeUnconfined` on XS workers.  A host agent that needs to run a
  Node-only plugin must address the `@node` special name, which
  resolves to a pre-provisioned Node.js worker formula under that
  agent.  Guests do **not** see `@node`; it is a host-only
  capability.  See the "Phase 6" section below.

- [ ] **Phase 7 — `makeCaplet` from a readable tree.**  Once
  `@node` plus archive execution are the only two paths, we reopen
  the `makeCaplet(readableTree, powers, options)` surface: the
  caller hands a `ReadableTree` (a CAS snapshot or a live mount
  point), a powers pet name, and optional env — and the daemon
  runs the named entry module from that tree in whichever worker
  the powers scope implies.  Source modules are loaded the same
  way `makeArchive` loads them; the difference is that the map
  lives in a tree shape rather than a ZIP.  See "Phase 7" below.

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

### Phase 6 — `@node`, and XS workers never run `makeUnconfined`

`makeUnconfined(workerName, specifier, …)` executes a Node.js plugin
module by pathname.  There is no portable way to satisfy that
contract inside an XS worker: the plugin comes from the host's
filesystem, may have arbitrary Node-only dependencies, and expects a
`module` + `require` environment that XS does not and should not
provide.  Rather than leave `makeUnconfined` as a worker-type split
brain, we make the decision explicit:

> **XS workers never implement `makeUnconfined`.  Every call to
> `makeUnconfined` is routed to a Node.js worker via the `@node`
> special name.**

The `@node` special name joins the existing `@agent` / `@self` /
`@host` / `@keypair` / `@mail` / `@nets` set on **host agents**.
It resolves to a long-lived Node.js worker formula that the daemon
provisions on first access, scoped to that host.  Semantically:

- `E(host).lookup('@node')` → the Node worker capability.
- `E(host).makeUnconfined('@node', '/absolute/path/to/plugin.js', …)`
  is the canonical `makeUnconfined` invocation.  `workerName`
  values other than `@node` either (a) already resolve to a Node
  worker, which continues to work, or (b) resolve to an XS worker,
  which **rejects the call** with a clean `"makeUnconfined requires
  a Node.js worker; use @node"` error.
- Guests **do not** see `@node`.  The pet-sitter that overlays
  special names on the guest's pet store omits `@node`; an attempt
  to `lookup('@node')` from guest scope returns `undefined`.  A
  guest that wants a Node-confined caplet must go through the host
  in the usual way.
- The host may choose to cancel `@node` (which terminates the
  pre-provisioned Node worker); the next `@node` lookup provisions
  a fresh one.

#### Implementation sketch

- `packages/daemon/src/host.js` grows a `provideNodeWorker()`
  helper that uses `provideWorker` with `kind: 'node'`.  The host's
  `specialStore` gets `'@node': nodeWorkerHandleId`.
- `packages/daemon/src/pet-name.js`'s `isSpecialName` regex already
  accepts `@node`.  No change there.
- `packages/daemon/src/guest.js`'s `makePetSitter` already filters
  the special-name set passed in.  Pass an explicit allowlist that
  excludes `@node`.
- The XS worker's `makeUnconfined` stub (currently `throw new
  Error('makeUnconfined not yet implemented in XS worker')`)
  becomes the explicit error message cited above — so a stray call
  to an XS worker produces the right hint.

#### Migration note

Tests that call `makeUnconfined` without naming a worker need to
pass `'@node'` (or pre-provision a Node worker explicitly).  The
one-line change is mechanical; the larger question is which CLI
flag we offer.  `endo make --UNCONFINED` already implies a Node
worker; the CLI can default `workerName` to `'@node'` when
`--UNCONFINED` is set and no other worker is named.

### Phase 7 — `makeCaplet` from a readable tree

With `@node` delimiting Node-only terrain and `makeArchive` handling
source-only ZIPs, the last gap in the surface is running a caplet
from a *tree* rather than a ZIP — either a live mount point (the
daemon already exposes these) or a `readable-tree` snapshot in the
CAS (the same building block the archive story rests on).  The new
method:

```ts
makeCaplet(
  workerPetName: string | undefined,
  treeName: string,     // pet name of a ReadableTree or Mount
  options?: MakeCapletOptions & { entry?: string },
): Promise<unknown>;
```

Where:

- `treeName` resolves to either a `readable-tree` (CAS snapshot) or
  a `mount` (live filesystem).
- `options.entry` names the entry module path within the tree
  (defaults to following `compartment-map.json` / `package.json`
  `main`).
- The worker — chosen the same way `makeArchive` chooses one —
  reads the compartment map and module sources through the tree's
  filesystem-like surface (`list`, `lookup`, `readText`).  XS
  workers walk the tree through the Rust host's CAS bindings; Node
  workers walk it through `compartment-mapper`'s `ReadFn`.
- Source-only contract is preserved: `parserForLanguage` omits the
  precompiled parsers, so a tree that somehow contains
  `pre-mjs-json` files produces a clean "unknown language" error.

Once this lands, `makeArchive` becomes a thin adapter: "parse the
blob as a compartment-mapper ZIP, expose it as a tree, call
`makeCaplet`".  The XS-side fast path still uses
`hostImportArchive` for zero-copy archive loads; the semantic
equivalence means clients can use whichever is convenient.

### The legacy Node.js bridge

`@node` and `makeCaplet` together mean that — once Phase 7 lands —
every caplet source falls into one of three buckets:

1. **Archive (ZIP)** or **readable tree** loaded in *any* worker
   (Node or XS), via `makeArchive` / `makeCaplet`.  Source modules
   only, no precompiled formats.  This is the preferred path.
2. **Unconfined Node plugin** loaded in a Node worker via
   `makeUnconfined('@node', …)`.  The bridge we keep open for code
   that depends on Node's ambient authority (native modules, fs,
   net, etc.).
3. **Eval** inside an individual worker via `E(worker).evaluate(…)`.
   The ad-hoc escape hatch; unchanged by this design.

The stated long-term goal: grow the ecosystem (native capabilities,
network capabilities, platform packages) so that bucket 2
shrinks.  It is not our goal to remove `@node`; it is our goal to
make it rarely necessary.

## Phased implementation

1. **Phase 1 (additive)** — add `make-archive` alongside `make-bundle`:
   formula type, dispatcher case, host method, worker facet method, CLI
   `endo archive` command and `-z` option, archive-based test helper,
   one passing end-to-end archive test.  *Done.*
2. **Phase 2 (migration)** — convert every existing `makeBundle` test
   to `makeArchive`.  Confirm the full suite passes.  *Done.*
3. **Phase 3 (removal)** — delete `makeBundle`, `MakeBundleFormula`,
   the dispatcher case, the host method, the worker facet method, the
   CLI `endo bundle` command, the `-b`/`--bundle` options, and the
   help-text entries.  Bump the daemon's interface version if any
   external consumers exist.  *Done.*
4. **Phase 4 (Rust / XS worker)** — XS worker `makeArchive` via
   `hostImportArchive`; removal of the `makeBundle` worker stub.
   *Done.*
5. **Phase 5 (Node-side wiring closure)** — Node worker `makeArchive`
   passes same env/context contract as `makeBundle` did.  *Done.*
6. **Phase 6 (@node, high priority)** — host-only `@node` special
   name that provisions a Node worker; XS workers explicitly reject
   `makeUnconfined` with a message pointing at `@node`; guests do
   not see `@node`.  CLI `endo make --UNCONFINED` defaults the
   worker to `@node` when none is given.
7. **Phase 7 (readable-tree caplets)** — `makeCaplet(treeName, …)`
   running source modules out of either a CAS snapshot or a live
   mount point.  `makeArchive` becomes a thin specialisation.

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
5. **XS workers do not implement `makeUnconfined`.**  `makeUnconfined`
   is inherently Node-shaped — it loads a plugin by filesystem path
   from the host's Node.js module graph.  Rather than paper over that
   with host-delegation magic, we make the constraint explicit: XS
   workers refuse `makeUnconfined`; hosts that need it address the
   `@node` special name instead.
6. **`@node` is a host-only special name.**  Guests inherit a
   filtered view of special names that omits `@node`.  A guest that
   needs a Node-confined caplet goes through the host in the
   normal way — which is also the permission boundary where the
   host can decide whether to grant access.
7. **`makeCaplet` unifies the archive and tree paths.**  Once the
   readable-tree variant lands, `makeArchive` is a specialisation
   (it treats a ZIP blob as a tree).  We keep `makeArchive` as the
   cheap common case because the XS side has a zero-copy archive
   loader (`hostImportArchive`) that avoids tree-walk overhead.
8. **The legacy Node.js bridge stays open indefinitely.**  We
   neither deprecate nor remove `makeUnconfined`.  The goal is to
   make it rarely necessary by growing the ecosystem of capability
   providers that run in any worker — not to force code through
   the archive path when it genuinely needs Node's ambient
   authority.

## Dependencies

| Design | Relationship |
|--------|--------------|
| daemon-cas-management | `makeArchive` reuses the CAS archive ingestion path on the Rust side; `makeCaplet` (Phase 7) does the same for CAS tree snapshots. |
| daemon-capability-bus | Worker facet method dispatch unchanged; uses the existing CapTP envelope. |
| daemon-mount | `makeCaplet` (Phase 7) consumes live mounts as its readable-tree input. |

## Known Gaps and TODOs

- [ ] **Phase 6 — `@node` special name.**  Implement the host-only
  special; filter it out of guest pet-sitters; update the XS worker's
  `makeUnconfined` error message to point at `@node`; adjust CLI
  `endo make --UNCONFINED` to default `workerName = '@node'`.
- [ ] **Phase 7 — `makeCaplet(treeName, …)` from a readable tree.**
  New host/guest method, new `MakeCapletFormula` (or reuse
  `MakeArchiveFormula` with a tree-ref variant), dispatcher case,
  tree-walk adapter on the Node worker side, CAS-tree adapter on the
  XS worker side.
- [ ] `endo archive` behaviour when the project tree contains a
  `package.json` without a `main` entry (today `endo bundle` errors
  with a compartment-mapper message; we should mirror that).
- [ ] Whether `makeArchive` should accept a CAS root-hash reference
  *directly* (skipping the readable-blob wrapper) for Rust workers,
  to avoid one round-trip through the daemon.  Subsumed by Phase 7
  if `makeCaplet` takes a `readable-tree` by formula id.
- [ ] XS-side SQLite port of `daemon-database.js`; needed for
  durability of pet-store/agent-keys/retention on the Rust
  supervisor path.  Currently shimmed with in-memory maps.

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

### Follow-on prompt (Phases 6 and 7)

> Regarding makeUnconfined on XS, let's explicitly decide not to
> implement makeUnconfined on XS and instead ensure that all usage of
> makeUnconfined uses a Node.js worker explicitly.  This requires us
> to expose a `@node` special name to host agents (and explicitly
> exclude this capability in guest agents).  Revise the documented
> design for this as a high priority next step.
>
> That will leave makeArchive as the preferred method for making a
> capability from a ZIP file, eschewing, deprecating, then
> eliminating the bundle system.
>
> We can then move on to a facility for creating capabilities from
> modules in arbitrary readable trees, either mount points or
> snapshots in the content address store, which should work without
> reservation based on the same systems that support makeUnconfined.
>
> That would just leave a hole for making unconfined capabilities on
> Node.js.  We would, in time, hope our ecosystem grows to have
> feature parity without the legacy Node.js platform, but will need
> to keep a bridge open.
