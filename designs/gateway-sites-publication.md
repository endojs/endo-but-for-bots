# Directory Publication over HTTP (the `sites` grant)

| | |
|---|---|
| **Created** | 2026-07-20 |
| **Updated** | 2026-07-20 |
| **Author** | Claude (prompted by kumavis) |
| **Status** | Proposed |
| **Relates to** | [gateway-package](gateway-package.md), [daemon-weblet-application](daemon-weblet-application.md), [familiar-unified-weblet-server](familiar-unified-weblet-server.md), [weblet-next](weblet-next.md), [endo-app-sharing](endo-app-sharing.md), [daemon-256-bit-identifiers](daemon-256-bit-identifiers.md), [daemon-content-store-gc](daemon-content-store-gc.md) |

## What is the Problem Being Solved?

A guest holds a directory of resources and wants to publish it at a stable,
unguessable web address so that HTTP clients can read it.
The guest must keep the authority to replace the contents, and to withdraw the
publication, without changing that address.

The authority to publish, modify, and withdraw is expressed through Endo object
capabilities, not through an HTTP account, cookie, or password.
The public address is a bearer reference for *read* access only.
Anyone who receives it can fetch the published resources.
No one who merely knows it can edit or withdraw the publication.

This is the capability-first framing of the weblet-hosting problem that
[weblet-next](weblet-next.md) documents as removed and that
[daemon-weblet-application](daemon-weblet-application.md) and
[familiar-unified-weblet-server](familiar-unified-weblet-server.md) are
rebuilding.
It differs from those in emphasis rather than substrate.
It names the guest-facing publish/withdraw grant (`sites`), pins the identity
and idempotency rules of the registry, specifies the browser response policy,
and states the durability and recovery contract.
It composes the same content-store, readable-tree, and gateway machinery those
designs establish.

The prior increment on this branch — an in-memory `@endo/endo-fs-asset-server`
caplet that held mounts in a `Map` — is superseded.
A `Map` does not survive daemon restart, and "durable hosted directories at a
cap path" is the primary requirement.

## Honest substrate assessment

The parts of this design that concern **durable storage** are composition of
primitives that already exist.
The parts that concern **HTTP serving and origin isolation** are largely
unbuilt, and one of them (per-publication browser origin) is gated on an open
gateway problem, not a settled mechanism.
This section states which is which so the plan is not read as "just wiring."

Exists today (verified against `origin/llm`):

- A content-addressed store: `@endo/daemon-cas` `makeContentStore` (sha256;
  `store` / `fetch` / `has` / `remove`, plus windowed `fetch().readRange`).
- Immutable content-addressed snapshots: the `readable-tree` formula, produced
  by `checkin` / `E(mount).snapshot()`, with `has` / `list` / `lookup`.
- The publisher's mutable directory: `Mount` (`provideMount`), with a
  `readOnly()` reader facet and a `snapshot()` commit boundary.
- Live change observation: `followNameChanges`.
- 256-bit identifiers ([daemon-256-bit-identifiers](daemon-256-bit-identifiers.md),
  Complete).
- A platform HTTP request/response seam: `@endo/platform/http/server`
  (`makeHttpServer`) and `@endo/platform/http/node` (`makeNodeHttpBackend`),
  landed on this branch.

Not built yet — this design's actual work:

- HTTP serving of a snapshot's entries as individual browser resources
  (content type, response policy, caching, path safety, `index.html`).
- The durable publication registry (minted label → directory, idempotency,
  reload-on-reincarnation) and the `sites` grant.
- Host demultiplexing / vhost serving.
  `@endo/gateway` is by its own README a "phase-1 skeleton": it has an
  in-memory `AppsNameHub` *table* (`bind` / `unbind` / `list` / `lookup`) and
  no HTTP listener or `Host` demultiplexing at all.
- Per-publication browser origin — see Decision 4; this is an unsolved gateway
  problem, not a mechanism waiting to be called.

Garbage collection of unreachable snapshots and blobs is a separate daemon
mark-and-sweep ([daemon-content-store-gc](daemon-content-store-gc.md)), not a
method on the content store; this design must register its retention roots with
that sweep rather than assume the store collects.

## Shape

```text
Publisher (a guest)
  holds a publication grant (conventionally `sites`)
  holds a directory writer (a Mount / EndoDirectory)
            │
            │ introduces the directory
            ▼
Publication registry  (durable Endo formula)
  minted 256-bit label  →  directory + current snapshot
            │
            │ selects the current committed snapshot
            ▼
HTTP server  (least authority: readers only)
  address + path  →  resource response (bytes + headers)
```

The directory supplies the publication's durable identity and mutable content.
The registry retains the reference needed to recover it across restart.
The HTTP server holds only enough authority to read registered content and
deliver responses; it never holds a directory writer or the publisher's broader
namespace.

## Glossary (map to Endo nouns)

New code SHOULD use the established Endo nouns; the vendor-neutral terms appear
in this document only where they read better.

- **publication** — a registry binding from a minted label to a directory
  (conceptually an `AppsNameHub` entry once the gateway can serve one).
- **manifest** / **committed revision** — a `readable-tree` snapshot.
- **resource** — a `readable-tree` blob entry.
- **content store** — the `@endo/daemon-cas` CAS.

## Publication authority (`sites`)

A host may endow a guest with a publication grant, conventionally named `sites`.
The grant determines whether the guest can publish and constrains its resource
use (publication count, retained bytes, upload size).
It is delivered as an ordinary introduced capability.
A guest without the grant has no registration operation to invoke.

The guest prepares a directory containing exactly the resources it means to
serve and introduces it to the registry, retaining the writer.
Publication grants the service read access to those resources.
It does not grant authority to modify the directory or to inspect unrelated
storage.

Names selecting directories or resources are resolved in the publisher's own
namespace before introduction.
The server never resolves a caller-supplied pet name in its own host namespace;
its serving authority is exactly the directory introduced to it.
An entry that is not a supported readable resource or sub-directory is not
serialized into a reference or made remotely invocable — Endo objects stored
elsewhere in the publisher's namespace do not become HTTP resources.

## Registration and the publication handle

```js
// Illustrative capability interface.
const publication = await E(sites).register(directory);
const url = await E(publication).getURL();
// ... later ...
await E(publication).withdraw();
```

Registration takes the publisher's directory and returns a **publication
handle**.
Registration completes only when the publication can actually be served; an
unsuccessful operation must not return a successful receipt (see Durability).

The handle carries management authority (withdraw, commit, list revisions) for
that one registration.
A separate read-only facet reveals the address and status without granting
withdrawal, so viewing can be delegated apart from control.

A guest's `sites` grant is bound to its publishing principal when granted;
`register` does not accept a caller-selected owner id.
An optional publisher-scoped facet lists the publications created under that
grant and cannot enumerate or manage others'.

**Idempotency (constrained — see Decision 3 and Open Questions).**
The intent is that re-registering the *same* directory while its publication is
active returns the same identity, while registering a *fresh* directory creates
a separate publication even if every byte is identical.
Realizing this requires a stable directory identity the registry can key on.
That key is not the `readOnly()` reader (which mints a fresh view per call); it
must be the underlying directory's formula identity, which only a daemon-side
registry can resolve — and whether a guest-introduced capability exposes such a
stable identity to the registry is an open question this design does not yet
close.

## Stable addresses

Each publication has a minted, unguessable **256-bit identity**, independent of
the current content digest, the publisher's name, and any document title.
The service derives a canonical public **label** from that identity and retains
the complete Endo reference needed to recover the directory.
Editing files preserves the address; two independently published directories
stay distinct even with identical content; storage deduplication never merges
their addresses or authority.

The identity is **random and registry-recorded**, not derived from the directory
or its content (see Decision 3).
Random identity means unguessability does not rest on the directory identity
staying secret, and withdrawal truly invalidates the address.

Addresses are **bearer references**: whoever receives one may fetch the
published resources.
The service offers no unauthenticated enumeration.
Complete addresses in logs, analytics, and diagnostics are access-bearing and
must be treated as secrets; private listings are available only through the
appropriate capability.
Note the unresolved tension in Decision 4/S: if the label is carried as a DNS
hostname for origin isolation, the "secret" label leaks in cleartext through DNS
and TLS SNI, which is at odds with treating it as a secret.

## Readable resources and storage

A publication directory presents a tree of resource names; each resource
resolves to bytes plus a media type and the metadata HTTP delivery needs.
The serving representation is an immutable manifest mapping relative paths to
content-addressed blobs — a `readable-tree` snapshot over the `@endo/daemon-cas`
store:

```text
manifest (readable-tree snapshot)
  index.html → { blob: <sha256>, contentType: "text/html; charset=utf-8", length }
  app.js     → { blob: <sha256>, contentType: "text/javascript; charset=utf-8", length }
  style.css  → { blob: <sha256>, contentType: "text/css; charset=utf-8", length }
```

Identical resource bytes share stored blobs; the directory remains the mutable
reference selecting the current tree.
A content change selects a *new* snapshot; it never rewrites bytes under an
existing digest.
The content store exposes separate write and read capabilities: importing
requires write authority, while the HTTP server receives only a reader
sufficient to stream published resources.

A digest is an internal storage address.
The HTTP interface resolves resources only through an active publication and its
selected snapshot; there is no global `content/<digest>` endpoint on this
surface that makes every stored blob readable to anyone who learns a digest.
(The daemon does expose a peer-facing digest-addressed content route —
advertised by `makeHttpContentShare` in
`packages/daemon/src/http-content-plane.js` and served by
`packages/daemon/src/ws-gateway.js` — but it is a CAS-replication / web-seed
plane for peers, not a browser-facing publication surface, and this design does
not reuse it for serving.)

## HTTP request handling

For each request the server validates the publication label, resolves its active
registration, selects the current snapshot, and looks up the requested path
within it.
It streams the resource with its declared media type, length, and cache
metadata.

- `GET` and `HEAD` only.
- The root path and paths ending in `/` select `index.html`.
- Query parameters never select a different storage root or convey management
  authority.
- Path safety is enforced in the request handler: the pathname is
  percent-decoded (a malformed encoding is a `400`), split, and each segment is
  passed through the `normalizeSegments` check in
  `packages/endo-fs-asset-server/src/asset-server.js`, which rejects `.` / `..`
  and embedded NUL.
  Names are looked up *within the tree* and never joined onto a host filesystem
  path, so traversal cannot escape the introduced directory.
- Unknown publications, missing resources, and unavailable content produce a
  closed `404`.
- Publisher-supplied metadata (media types) is validated against an allowlist
  before becoming a response header; resource content cannot inject headers or
  loosen the response policy.
- No directory listing unless the publisher provides one as a resource.

Sending an HTTP mutation to a published address confers no authority; management
stays on the Endo capability interface.

## Updates and visibility

Updating is an operation on the publisher's own directory through the writer it
already holds; no new address or credential is required.
Each committed revision selects a complete snapshot, and an individual HTTP
response uses one snapshot — including a response already streaming when a later
revision becomes visible.

A multi-file release becomes visible through a **single snapshot selection**:
the publisher stages writes into the directory and commits one `snapshot()`, so
intermediate states are never served.
The handle exposes a way to await visibility of a committed revision; completion
means subsequently admitted requests select that revision or later, not that
clients have discarded already-downloaded resources.
Updates preserve origin-scoped browser state; changing files does not reload or
wipe a running page.

## Caching

Mutable resource URLs default to `Cache-Control: private, no-cache`: private
storage allowed, revalidation required before reuse.
The server emits an `ETag` identifying the selected representation (the snapshot
digest plus path, or the blob digest) and honors conditional requests against
the current revision.
Sensitive resources may use `no-store`.
Immutability of a stored blob does not imply an immutable public URL — the same
path may select different bytes after an update — so long-lived immutable
browser caching is appropriate only for URLs whose meaning is explicitly
immutable (for example digest-versioned asset paths the publisher chooses).
Internal snapshots and blobs may be cached by digest, but serving must observe
revisions and withdrawals, so a cached registration cannot indefinitely override
the publisher.

## Browser boundaries

Separate publication origins isolate DOM access and origin-scoped storage.
The service never attaches a publisher's private management session to content
requests and sets no ambient authentication cookie.
The default response policy confines scripts, connections, forms, and most loads
to the publication's own origin, disables object embedding, prevents framing,
suppresses `Referer`, disables MIME sniffing, and applies cross-origin
resource/opener/embedder isolation; CORS is off by default.
The same baseline applies to success, conditional, and failure responses.
A publisher may *tighten* the policy through supported options; loosening
(embedding, cross-origin) requires an explicit grant with stated isolation
consequences.
Browser restrictions complement — they do not replace — the capability boundary:
a non-browser client with the address can still read it, and a recipient can
still copy what it downloaded.
Everything in this section is contingent on genuinely separate origins per
publication, which is exactly the unresolved problem in Decision 4.

## Withdrawal and content lifetime

Withdrawal removes the active registration and invalidates its serving
projections; it completes when newly admitted requests can no longer resolve the
publication.
Requests admitted before that boundary may finish streaming.
Withdrawal leaves the publisher's directory intact and does not erase downloaded
files or client caches.

An active publication retains the directory reference and all content reachable
from its selected snapshot; in-flight responses retain what they use.
Reclamation (the `daemon-content-store-gc` sweep) must account for active
publications, in-flight responses, and staged writes before collecting
unreachable snapshots and blobs, with a grace period and a consistent view of
concurrent changes.
Removing one registration does not prove its former blobs are unused; shared
blobs are retained while any active publication needs them.

## Durability and recovery

The registry is a **durable Endo formula**: it retains directory references,
publication identities, revisions, and principal associations so that active
publications recover after restart without changing their addresses.
The HTTP process holds only a restricted registry reader and content reader —
never the administrative facet or any writer — and its local indexes and caches
are recoverable projections of durable state.

Registration, update, and withdrawal are recoverable across interruptions.
The daemon's "disk before graph" rule (`packages/daemon/AGENTS.md`) applies: a
publication's durable record is persisted before it becomes routable, so a crash
mid-registration leaves the publication either completed or visibly incomplete
and eligible for cleanup — never a routable binding with no backing record.
A recorded withdrawal is not undone by replaying a stale serving index; an
unavailable directory or content store fails closed rather than falling back to
another publication or to broader host authority.

## Resource limits

The `sites` grant may carry limits on retained bytes, resource counts, upload
size, and active registrations; the serving layer may limit request concurrency,
response size, and transfer rate.
Limits are applied through the capabilities granted to the responsible
components — a host supplies quota/metering facets without making any particular
accounting or payment system part of the abstraction.
Admission happens before committing work whose bounds are known in advance; a
rejected import or revision leaves the previous revision serving; canceled
requests release streams and temporary holds.

## Resolved decisions

These were the open questions after mapping the proposal onto the substrate.

### Decision 1 — Media type comes from the resource name

`readable-tree` / CAS entries are bytes-by-name with no intrinsic media type.
**Resolution:** infer the media type from the resource's name extension through a
validated allowlist, defaulting to `application/octet-stream` (browsers download
rather than execute it).
`packages/endo-fs-asset-server/src/mime.js` already carries this map and its
tests; reuse it.
A per-tree sidecar (an `.endo/content-types.json` entry, or blob xattrs) is a
later, optional enhancement, deferred because extension inference is
deterministic, needs no new resource type, and keeps "publisher metadata
validated before it becomes a header" trivially true.

### Decision 2 — A revision is a snapshot of a mutable directory

**Resolution:** a publication references a **mutable directory** (Mount /
`EndoDirectory`); a committed revision is the immutable `readable-tree` from
`E(mount).snapshot()`.
The service serves the latest committed snapshot and pins one snapshot per
response.
The publisher commits a multi-file release atomically by staging writes and
taking one snapshot; `awaitVisibility(revision)` resolves once the service has
adopted that snapshot or a later one.
The stable address binds to the *directory* identity, not the snapshot digest,
so edits preserve the address while each snapshot stays content-addressed and
immutable.
Auto-committing on `followNameChanges` quiescence is a later option; the first
cut takes an explicit commit to avoid serving intermediate states.

### Decision 3 — Random, registry-recorded identity

**Resolution:** mint a **random 256-bit** identity per registration and record it
durably, rather than deriving it from the directory or content.
Deriving the label as `H(directory-identity)` was considered and rejected: it
would make unguessability depend on the directory identity staying secret, and
would resurrect the same address after withdrawal.
Idempotency (Registration section) is the residual difficulty: it needs a stable
directory-identity key that the current `readOnly()` reader does not provide, so
the first implementation may treat every `register` as minting a fresh
publication and defer keyed idempotency until the directory-identity hook is
settled (Open Questions).

### Decision 4 — Per-publication origin is an unsolved gateway problem, not a settled mechanism

This is the hardest and least-settled part, and the earlier draft overstated it.
The [familiar-unified-weblet-server](familiar-unified-weblet-server.md) design is
explicit that the gateway **does not** demultiplex by `Host` header today, and
that standalone browsers cannot get origin isolation from Host routing at all:
only Electron's privileged `localhttp://` scheme can route by a `Host` token over
loopback, while "Chat weblets (standalone browser use without Electron) still
need a separate HTTP port per isolated page."
So there is no ready subdomain-vhost mechanism to call, and the options each cost
something real:

- **Subdomain per publication** (`<label>.<host>`): gives a true separate origin,
  but needs wildcard DNS and a wildcard TLS certificate, and — critically — the
  unguessable label then travels in cleartext through DNS resolution and TLS SNI
  (mitigated only partly by DNS-over-HTTPS and Encrypted Client Hello), which
  contradicts treating the address as a bearer secret (S1).
- **Port per publication**: matches the existing standalone-browser decision and
  leaks no hostname, but does not scale to many publications and produces
  unfriendly public URLs.
- **Path per publication** (`/<label>/…`): friendly URLs and no hostname leak,
  but shares one origin across publications, defeating the DOM/storage/CSP
  isolation the Browser-boundaries section depends on.
  Rejected for the isolated surface.

**Resolution:** this design does not pick a browser-origin strategy on its own.
It depends on the gateway multiplexing and per-session confidentiality work that
[familiar-unified-weblet-server](familiar-unified-weblet-server.md) and the OCapN
Noise netlayer are converging on, and it states the tradeoff table above as a
constraint on that work.
Until then, the serving core (Phase 1) is origin-agnostic and testable behind a
single origin, and a single-process dev harness may use path-based routing with
the origin-sharing caveat stated in its docs — never as the production contract.

## Phased implementation plan

Each phase is independently testable and lands behind an adversarial subagent
review.
Phase 1 is the load-bearing, buildable-today core; later phases depend on daemon
and gateway work that is partly unbuilt.

1. **Serving core (library).** A pure request handler
   `(HttpRequest) => HttpResponse` over `@endo/platform/http/server` that, given
   a snapshot (`readable-tree`) plus a content reader, resolves a path to a blob,
   infers content type (Decision 1), applies the response-policy and caching
   baseline, enforces path safety, serves `index.html`, and `404`s.
   No registry, no origin story; the snapshot is injected.
   Reuses `normalizeSegments` and `mime.js`.
2. **Publication registry + `sites` grant + durability.** The durable registry
   exo: `register(directory) → publication{ getURL, getStatus, commit,
   awaitVisibility, withdraw }`, minted 256-bit label (Decision 3), persisted
   record, reload-on-reincarnation.
   Durability is demonstrated by rebuilding the routing table from the persisted
   store (restart simulated in tests).
   Keyed idempotency lands here only if the directory-identity hook is settled;
   otherwise register mints fresh and the open question is recorded.
3. **Gateway embedding + origin strategy.** Gated on the gateway gaining a `Host`
   demultiplexer / per-session confidentiality (Decision 4).
   Bind labels once the gateway can serve; wire the restricted readers into a
   least-authority HTTP process.
4. **Update/visibility + GC integration.** `followNameChanges` auto-commit
   option; reconcile retention with the
   [daemon-content-store-gc](daemon-content-store-gc.md) sweep so active
   publications, in-flight responses, and staged writes are retention roots.
5. **Quotas, metering, and policy options.** `sites` limits; publisher
   policy-tightening options; conditional-request / ETag polish.

## Relationship to existing designs

- [gateway-package](gateway-package.md): the eventual home; this is the `sites`
  flavor of its per-tenant weblet feature, and the registry is an `AppsNameHub`
  consumer once the gateway can serve.
- [daemon-weblet-application](daemon-weblet-application.md): supplies the
  zip → `readable-tree` ingestion path a publisher can build a directory with.
  Complementary — that design is ingestion, this is publication and serving
  authority.
- [familiar-unified-weblet-server](familiar-unified-weblet-server.md): owns the
  gateway multiplexing / origin-isolation problem this design depends on; its
  revision (Host routing not for standalone browsers) directly constrains
  Decision 4.
- [weblet-next](weblet-next.md): the reference record of the removed weblet
  implementation; useful for the serving details it captured.
- [endo-app-sharing](endo-app-sharing.md): the durable-receiver /
  content-addressed-tree machinery a shared app lands in and can then be
  published by this grant.
- [daemon-256-bit-identifiers](daemon-256-bit-identifiers.md): the identity width
  the label uses.

## Open questions

- Does a guest-introduced directory capability expose a **stable identity** the
  registry can key idempotency on, given `readOnly()` mints a fresh reader per
  call?
  Without it, keyed idempotency (Decision 3) is not realizable and `register`
  mints fresh each time.
- Where does `sites` live — the host, the gateway, or a dedicated publication
  service formula? (Leaning: a gateway-owned registry formula the host vends
  `sites` facets from.)
- Which browser-origin strategy does the gateway adopt (Decision 4), and does it
  accept the DNS/SNI hostname leak, choose ports, or wait on Noise-based
  confidentiality?
- Content-type sidecar format, if and when Decision 1's inference is
  insufficient (SVG-as-image vs SVG-as-download, source maps).

## Prompt

This design was prompted by kumavis with the following proposal (captured per
`designs/CLAUDE.md`), lightly reflowed:

> An Endo HTTP server service publishes a readable directory at a stable,
> unguessable web address. The publisher retains control of the directory and
> can replace its contents without changing that address. HTTP clients can
> retrieve the published resources; authority to publish, modify, and withdraw
> them is expressed through Endo object capabilities.
>
> The service connects two kinds of access. On the Endo side, a guest introduces
> a directory it holds to a publication capability. On the HTTP side, a client
> presents a publication address and requests a resource within that directory.
> The service resolves requests only through the directory introduced for that
> publication.
>
> Themes elaborated in the proposal: a host endows a guest with a publication
> capability (conventionally `sites`) carrying resource limits; registration
> accepts a directory capability and returns a publication handle whose
> management facet can withdraw it and whose read-only facet reveals address and
> status; each publication has an unguessable identity giving a canonical public
> label and its own browser origin, independent of content digest, stable across
> edits; the serving representation is an immutable manifest of content-addressed
> blobs, with no global digest endpoint; request handling supports GET/HEAD,
> `index.html` for directory paths, and path normalization that cannot escape the
> introduced directory; updates install a new complete revision through the
> writer the publisher holds, made visible atomically; caching defaults to
> `private, no-cache` with ETag revalidation; a strict same-origin CSP baseline
> with COOP/COEP/no-sniff and no CORS; withdrawal stops new retrieval while
> letting in-flight responses finish; the registry is a durable Endo service that
> recovers publications across restart without changing addresses; and resource
> limits are applied through granted capabilities.
>
> The full proposal text is preserved in the pull request that introduced this
> document.
