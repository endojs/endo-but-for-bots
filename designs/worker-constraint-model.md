# Worker Constraint Model

| | |
|---|---|
| **Created** | 2026-08-16 |
| **Author** | Kris Kowal (prompted) |
| **Status** | Proposed |

## What is the Problem Being Solved?

Every worker the daemon spawns is selected by a single closed field,
`kind?: 'locked' | 'node'`, threaded identically from the `worker`
formula through the daemon core down to all three supervisor backends:

- `packages/daemon/src/types.d.ts` — `WorkerFormula.kind?: 'locked' | 'node'`
  (the persisted, content-addressed formula field) and
  `DaemonicControlPowers.makeWorker(..., kind?: 'locked' | 'node', ...)`
  (the control-power contract every backend implements).
- `packages/daemon/src/manager.js` — `formulateNumberedWorker`,
  `makeIdentifiedWorker`, `provideWorkerId`, the `defaultWorkerKind`
  daemon option, and the `workerFormula.kind ?? defaultWorkerKind`
  locked-vs-node resolution that decides archive-vs-tree loading.
- `packages/daemon/src/bus-manager-rust-xs.js` — the load-bearing seam:
  `makeWorker` picks `ENDO_NODE_WORKER_BIN` for `kind === 'node'` and
  `ENDO_WORKER_BIN` (the XS binary) otherwise.
- `packages/daemon/src/manager-node-powers.js` and
  `manager-go-powers.js` — `makeWorker` accepts `kind` but currently
  ignores it (Node-only backends).

Two problems follow from encoding worker selection as this one closed
union:

1. **It hard-codes today's two kinds as the ceiling.** `'locked'` and
   `'node'` conflate *which engine runs guest code* with *how the
   worker is supervised*. They leave no room for the runtime axis to
   grow (XS-in-Rust via Ironhorse, PR #600, is a genuine third point on
   that axis, not a fourth `kind`), and no room at all for orthogonal
   concerns — durability, version, platform/architecture — that a
   caller will increasingly need to express.

2. **Every emerging worker category has to fight the union.** The
   maintainer's headline case is a *durable, orthogonally persistent*
   worker (snapshotted, transcripted, message-embargoed for
   hangover-consistency — `@endo/thixotrope`, PR #786; the quiescence
   embargo, PR #989; the snapshot substrate, PR #281; the
   metered-storage worker, issue #984). Under the closed union each of
   these becomes a bespoke new `kind`, cross-multiplying with the
   runtime axis (a durable XS worker, a durable node worker, a durable
   XS-in-Rust worker are three `kind`s for one idea). Version pinning
   and platform/arch binary selection have no home in the union at all.

This design replaces the closed union with an **open, multi-axis
constraint expression** a caller passes when requesting a worker. Each
axis is independent and individually optional; an omitted axis means
*flexible — the daemon resolves it*. Today's `'locked'` and `'node'`
become the two seed points of one axis (runtime) with every other axis
flexible, migrated with **zero behavior change and zero formula-identity
churn**. The remaining axes (persistence, version, platform/arch) land
now as **typed, named extension points** — most not yet implementable,
but shaped so the converging work slots in additively rather than
reworking the seam.

## Goals and Non-Goals

**Goals.**

- Define a `WorkerConstraints` schema with independent, individually
  optional axes: **runtime**, **persistence**, **version**, **platform**.
- Migrate today's `'locked'` / `'node'` onto the runtime axis as its
  first two instances, byte-for-byte preserving existing worker formula
  identities and behavior.
- Keep the wire/API surface **strictly additive** over
  `kind?: 'locked' | 'node'`, so existing callers (CLI `@node`
  selection, `provideWorkerId`, `formulateWorker`) need no change.
- Give the durable/persistence, version, and platform/arch categories
  each an explicit, well-typed place in the schema, and name the exact
  seam where each resolves — without designing those mechanisms here.

**Non-Goals (flagged, not resolved).**

- The durable-worker *mechanism* (snapshot/transcript/embargo). That is
  thixotrope + #989 + #281 + #984; this design only makes it
  *expressible* as a constraint.
- The version *resolution* mechanism (how a pin maps to a build).
- The platform/arch *binary-fetch* mechanism (e.g. S3 pull). This
  design only marks the seam.
- Any change to the three supervisor backends' actual spawn logic
  beyond the mechanical `kind → constraints.runtime` normalization.

## Current State (the seam as it exists)

Tracing one worker request end to end on `llm`:

1. **Formula.** A worker is a persisted, content-addressed formula:
   ```ts
   type WorkerFormula = {
     type: 'worker';
     label?: string;
     trustedShims?: string[];
     kind?: 'locked' | 'node';
   };
   ```
   `formulateNumberedWorker` (`manager.js`) spreads `kind` in **only
   when truthy** (`...(kind ? { kind } : undefined)`), so a
   flexible-default worker persists as `{ type: 'worker', label }` with
   no `kind` key at all. This omission is load-bearing for identity (see
   *Migration*).

2. **Default resolution.** The daemon carries a `defaultWorkerKind`
   option (`'node'` by default; the Rust supervisor bring-up in
   `bus-manager-rust-xs.js` sets `defaultWorkerKind: 'locked'`). The
   effective kind is `workerFormula.kind ?? defaultWorkerKind`, used at
   `manager.js:~2155` to choose the archive-packing path (locked/XS
   workers cannot yet run `parseArchive` themselves) versus the
   `makeFromTree` path.

3. **Provision.** `makeIdentifiedWorker(workerId, context, kind, ...)`
   forwards `kind` to `controlPowers.makeWorker(...)`.

4. **Control power.** `DaemonicControlPowers.makeWorker` carries
   `kind?: 'locked' | 'node'`. Only `bus-manager-rust-xs.js` acts on it
   (binary selection); the Node and Go powers accept and ignore it.

5. **Caller surfaces.** `provideWorkerId(..., kind)` mints a distinct
   Node worker when a `'node'` worker is asked for under a `'locked'`
   default; the host registers special names `@main` and `@node`
   (`host.js`); the CLI's `endo make --UNSAFE`/import path defaults the
   unconfined worker to `@node`.

The constraint model threads through **exactly these five points** and
no others.

## The Constraint Model

A caller expresses worker requirements as a `WorkerConstraints` record.
Every axis is optional. An omitted (or `undefined`) axis means
**flexible**: the daemon resolves it from its configured defaults
(preserving today's `defaultWorkerKind` semantics precisely). A present
axis is either a concrete pin or an explicit flexibility qualifier
(e.g. a version range).

```ts
/**
 * A partial specification of a worker. Every axis is independently
 * optional. Omitting an axis delegates its resolution to the daemon
 * (flexible). The empty object {} is fully flexible and is the
 * canonical form of "any worker the daemon would make by default" —
 * it MUST resolve identically to today's no-`kind` formula.
 */
export type WorkerConstraints = {
  /** Engine + supervision axis. Open set; see WorkerRuntime. */
  runtime?: WorkerRuntime;
  /** Ephemeral vs. durable/orthogonally-persistent. See WorkerPersistence. */
  persistence?: WorkerPersistence;
  /** Worker build/version pin. See WorkerVersionConstraint. */
  version?: WorkerVersionConstraint;
  /** Target platform/architecture. See WorkerPlatformConstraint. */
  platform?: WorkerPlatformConstraint;
};
```

### Axis 1 — runtime (migrates today's `kind`)

The runtime axis names *which engine executes guest code and how it is
supervised*. It is an **open string-tagged set**, seeded with today's
two values and reserving the near-term third:

```ts
/**
 * Open set. The daemon rejects a runtime it cannot service, so callers
 * and the schema can grow independently. Seed values:
 *   'locked'      — XS guest under xsnap, confined; today's 'locked'.
 *   'node'        — plain Node.js worker; today's 'node'.
 *   'xs-in-rust'  — XS embedded in a Rust process (Ironhorse, PR #600).
 *                   RESERVED; not yet wired at this seam.
 */
export type WorkerRuntime = 'locked' | 'node' | 'xs-in-rust' | string;
```

The three points `xs-in-rust` / `locked` (XS-via-xsnap) / `node` are one
axis, per the maintainer's framing, not three unrelated kinds. Keeping
`WorkerRuntime` an open union (`| string`) is deliberate: a new engine
is a new *value*, added at the resolver, with no change to the schema or
to callers that don't ask for it.

### Axis 2 — persistence (the durable-worker extension point) — *Not Started*

The persistence axis names the worker's **durability class**: whether
its heap and in-flight obligations survive daemon restart, and under
what consistency guarantee.

```ts
/**
 * EXTENSION POINT — schema only; no resolution implemented here.
 *   'ephemeral' — today's behavior: no snapshot, no transcript, lost on
 *                 daemon exit. The flexible default.
 *   'durable'   — orthogonally persistent: heap snapshotted and/or
 *                 message-transcripted, inbound messages embargoed at
 *                 quiescence to prevent hangover-inconsistency, host
 *                 obligations at-most-once across resume.
 */
export type WorkerPersistence =
  | 'ephemeral'
  | 'durable'
  | {
      class: 'durable';
      /** Durable substrate. Reserved; see thixotrope / #281 / #984. */
      journal?: 'snapshot' | 'transcript' | 'snapshot+transcript';
      /**
       * Expose snapshot/message-byte growth for external metering
       * (issue #984, Minion Town). Reserved.
       */
      metered?: boolean;
      /** Indefinite-ledger retention (issue #984). Reserved. */
      retention?: 'session' | 'indefinite';
    };
```

This is the axis that lets issue **#984 (metered-storage worker)** be
expressed as *one constraint combination*
(`{ persistence: { class: 'durable', metered: true, retention: 'indefinite' } }`)
rather than a bespoke worker kind — which the job brief names as the
acceptance test for the schema. The `durable` class corresponds to the
`@endo/thixotrope` worker (PR #786; sleepy workers, XS heap snapshots,
delivered-watermark journals, at-most-once host obligations); the
message-embargo guarantee corresponds to PR #989's quiescence embargo
(one inbound envelope per crank, outbound flushed atomically), which
composes with thixotrope's journal-replay embargo rather than replacing
it; the snapshot/suspend/resume substrate underneath both is the
`daemon-xs-worker-snapshot` design + PR #281. Snapshot continuity across
a live code upgrade (issue #813) is a property of the `durable` class,
not a separate axis. **None of this is resolved here** — the axis is a
typed name so the mechanism lands additively.

### Axis 3 — version (unfiled; first home here) — *Not Started*

The version axis pins the worker *build* (engine/binary version), not
just the runtime family.

```ts
/**
 * EXTENSION POINT — schema only; no resolution mechanism here.
 *   omitted        — flexible: daemon uses whatever build it has (latest).
 *   { exact }      — pin one build (e.g. an xsnap/Ironhorse version).
 *   { range }      — a semver-style acceptable range.
 *   'latest'       — explicit flexible-latest (same effect as omitted).
 */
export type WorkerVersionConstraint =
  | 'latest'
  | { exact: string }
  | { range: string };
```

Sketched, not committed: whether a pin resolves against a local build
registry, a fetched manifest, or the platform-fetch provider (Axis 4) is
an **open question**. The schema commits only to the *shape* of the
request (exact vs. range vs. flexible-latest).

### Axis 4 — platform/architecture (unfiled; first home here) — *Not Started*

The platform axis names the target OS/architecture for the worker
binary. On deployments like minion.town the daemon may need to fetch a
platform+arch-matched binary from remote storage rather than assume a
local one is present.

```ts
/**
 * EXTENSION POINT — schema only; no fetch mechanism here.
 *   omitted     — flexible: use the daemon host's own platform/arch.
 *   { os, arch } — pin a target (e.g. { os: 'linux', arch: 'arm64' }).
 */
export type WorkerPlatformConstraint = {
  os?: 'linux' | 'darwin' | 'win32' | string;
  arch?: 'x64' | 'arm64' | string;
};
```

**The seam, named but not built.** A pinned (or non-local) platform
resolves in `bus-manager-rust-xs.js`'s `makeWorker`, exactly where
`ENDO_WORKER_BIN` / `ENDO_NODE_WORKER_BIN` are read today. A future
binary-fetch provider would be an injected power consulted there — given
`{ runtime, version, platform }`, it returns a local path to a matched
binary (fetching from S3 or similar on a miss), and the existing
`endoWorkerBin`/`endoNodeWorkerBin` env lookups become the *local,
flexible-platform* branch of that provider. This is **adjacent to but
distinct from** the AWS storage line (PR #637, PR #689,
`designs/endo-daemon-aws-storage.md`): that work is DynamoDB+S3 for the
daemon's *structured state and blobs* and never mentions worker binaries
or platform/arch selection. Nothing here designs the fetch — it marks
where it plugs in.

## The Seam It Plugs Into (resolution)

The constraint object is resolved in one place and lowered to the
existing backend call. Introduce a `resolveWorkerConstraints` step in
`manager.js` between formulation and `controlPowers.makeWorker`:

```
WorkerConstraints (caller)
  │  normalize legacy `kind` ⇆ `constraints.runtime`   (see Migration)
  ▼
resolveWorkerConstraints(constraints, daemonDefaults)
  │  runtime      := constraints.runtime ?? defaultWorkerKind
  │  persistence  := constraints.persistence ?? 'ephemeral'
  │  version      := constraints.version ?? 'latest'
  │  platform     := constraints.platform ?? <host platform>
  ▼
controlPowers.makeWorker(id, ..., resolved)   // backend acts per axis
```

Axis-to-backend mapping (where each axis *lands*, once built):

| Axis | Resolves at | Today |
|------|-------------|-------|
| runtime | `bus-manager-rust-xs.js` `makeWorker` binary select | `ENDO_WORKER_BIN` vs `ENDO_NODE_WORKER_BIN`; `locked`↔archive path |
| persistence | thixotrope / #281 snapshot+journal substrate | always ephemeral |
| version | (open) build registry / fetch provider | implicit "whatever is installed" |
| platform | `bus-manager-rust-xs.js` `makeWorker` binary select | implicit host platform |

Only the runtime and platform axes touch the *existing* backend seam;
persistence resolves into the thixotrope/#281 substrate; version's
resolution point is deliberately left open.

The control-power contract widens **additively**:

```ts
// types.d.ts — the widened signature (old `kind` retained, deprecated).
makeWorker: (
  id: string,
  daemonWorkerFacet: DaemonWorkerFacet,
  cancelled: Promise<never>,
  forceCancelled: Promise<never>,
  capTpConnectionRegistrar?: CapTpConnectionRegistrar,
  trustedShims?: string[],
  label?: string,
  /** @deprecated pass `constraints.runtime`; retained for one migration cycle. */
  kind?: 'locked' | 'node',
  marshalLoadError?: (err: Error, errorId?: string) => void,
  /** NEW: resolved constraints. When present, `kind` is ignored. */
  constraints?: ResolvedWorkerConstraints,
) => Promise<{ workerTerminated; workerDaemonFacet }>;
```

(A cleaner eventual signature folds `kind`, `trustedShims`, `label`, and
`constraints` into one options bag — flagged as a follow-up cleanup, not
required to land the model.)

## Migration of Today's Two Kinds (zero behavior, zero identity churn)

Worker formulas are **content-addressed**; the persisted formula's
canonical form is part of the worker's identity. Two invariants make
this migration safe:

1. **Fully-flexible ≡ today's no-`kind` formula.** A caller passing no
   constraints, or `{}`, must persist as `{ type: 'worker', label }`
   with no new key — byte-identical to today. Achieved by spreading a
   `constraints` field into the formula **only when it carries a
   non-default axis**, mirroring the existing
   `...(kind ? { kind } : undefined)` treatment.

2. **The two legacy kinds keep their exact formula bytes.** Rather than
   rewrite `{ kind: 'node' }` formulas to `{ constraints: { runtime: 'node' } }`
   (which would change every existing node worker's identity), the
   **formula layer keeps `kind` as the persisted form for the two seed
   runtime values.** Normalization is bidirectional and lives above the
   formula:
   - inbound: `constraints.runtime ∈ {'locked','node'}` and no other
     non-default axis ⟹ persist as legacy `{ kind }`;
   - a genuinely new axis (persistence/version/platform) or a new
     runtime value ⟹ persist a `constraints` object;
   - outbound: `formula.kind` reads back as `{ runtime: formula.kind }`.

   This means **no formula migration, no identity change, no rewrite of
   the formula graph** for any worker that exists today. The
   `constraints` key appears in the persisted formula only for workers
   that use a genuinely new capability — which by definition did not
   exist before, so there is nothing to preserve.

Resolution precedence (single rule, everywhere):
`constraints.runtime` (explicit) **>** legacy `kind` **>**
`defaultWorkerKind`. All existing call sites keep working:

- `formulateWorker` / `formulateNumberedWorker` gain an optional
  `constraints` alongside the retained `kind`.
- `provideWorkerId(..., kind)` keeps its `kind` parameter; internally it
  becomes sugar for `{ runtime: kind }`.
- CLI `@node` selection, `@main`/`@node` special names, and
  `defaultWorkerKind` bring-up are untouched — they resolve through the
  same precedence.

**Behavioral acceptance:** with no caller passing `constraints`, every
formula, every spawn, and every content address is identical to `llm`
today. The model is inert until a caller opts into a non-default axis.

## Reconciliation With Converging Work

This design **does not duplicate** any of the following; it provides the
constraint vocabulary they attach to.

- **`@endo/thixotrope` / orthogonal persistence** (PR #786 merged, In
  Progress; `designs/ocapn-orthogonal-persistence.md`). Supplies the
  `persistence: 'durable'` mechanism (snapshots, journals, at-most-once
  host obligations, sleepy resume). This design names the axis; that one
  builds it. Phases 5–9 (name-hub upgrade-by-rebinding, resource vats,
  non-reifying host) are orthogonal to the constraint schema.
- **Quiescence embargo** (PR #989, draft). Supplies the message-embargo
  guarantee inside the `durable` class; composes with thixotrope's
  journal-replay embargo. Referenced by the persistence axis, not
  re-specified.
- **`daemon-xs-worker-snapshot` + PR #281** (In Progress / open). The
  streaming-CAS snapshot/suspend/resume substrate under `durable`.
- **Issue #984 (metered-storage worker)** (open, unclaimed). Becomes the
  `{ persistence: { class: 'durable', metered: true, retention: 'indefinite' } }`
  combination — the schema's stated acceptance criterion.
- **Issue #813 (snapshot continuity across live upgrade)** (open). A
  property of the `durable` class.
- **Ironhorse / XS-in-Rust** (PR #600, merged). Motivates the
  `runtime: 'xs-in-rust'` reserved value as a third point on the runtime
  axis. `designs/worker-rust-xs.md` is stale (marked "Not Started"
  though #600 merged) and **needs a status sync — informational only,
  out of scope for this job.**
- **Sturdy-refs / worker retention** (PR #511, draft). Worker retention
  interacts with the persistence axis (a retained/sturdy worker is
  durable-classed); reconcile when #511 firms up.
- **AWS daemon storage** (PR #637, PR #689 draft,
  `designs/endo-daemon-aws-storage.md`). *Distinct* from the platform
  axis: that is DynamoDB+S3 for daemon structured state and blobs, with
  no worker-binary or platform/arch selection. The platform axis's
  binary-fetch provider is a *sibling* S3 consumer, not the same seam.

## Open Questions

1. **Options-bag refactor timing.** Fold `kind`/`trustedShims`/`label`/
   `constraints` into one options argument to `makeWorker` now, or keep
   the additive positional param for one migration cycle? (Leaning:
   additive now, bag later.)
2. **Version resolution locus.** Does a `version` pin resolve against a
   local build registry, a manifest, or the platform-fetch provider?
   Deferred until a concrete version-pinning use case exists.
3. **Constraint validation & rejection surface.** How does the daemon
   report "I cannot service `runtime: 'xs-in-rust'` on this host"? A
   typed rejection at `resolveWorkerConstraints` vs. at `makeWorker`.
4. **Do the Node and Go backends ever honor non-runtime axes**, or do
   durable/version/platform remain Rust-supervisor-only? (Today Node/Go
   ignore even `kind`.)
5. **Persistence × runtime feasibility matrix.** Is `durable` meaningful
   for `runtime: 'node'`, or only for XS-based runtimes with heap
   snapshots? Likely constrained; enumerate when thixotrope's engine
   adapter lands.

## Status and Scope

**Proposed.** The load-bearing, buildable core is the `WorkerConstraints`
schema (Axis 1 runtime), the `resolveWorkerConstraints` seam, the
additive `makeWorker`/formula surface, and the zero-churn migration of
`'locked'`/`'node'` — all of which can land now with no behavior change.
Axes 2–4 (persistence, version, platform/arch) land as **typed,
`Not Started` extension points**, deliberately not implemented here; each
names the converging work or the exact seam it will plug into. The one
adjacent doc-hygiene item surfaced — `designs/worker-rust-xs.md`'s stale
"Not Started" status after PR #600 merged — is flagged as informational
and is **not** part of this job.
