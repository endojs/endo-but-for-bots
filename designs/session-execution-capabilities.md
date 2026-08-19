# Daemon-Backed Code-Mode Capability Grants

| | |
|---|---|
| **Created** | 2026-08-06 |
| **Updated** | 2026-08-19 |
| **Author** | 0xpatrickdev (prompted) |
| **Status** | Proposed |
| **Builds on** | [daemon-mount-capabilities](daemon-mount-capabilities.md), [daemon-git-capability](daemon-git-capability.md), [daemon-git-remotes](daemon-git-remotes.md), [endo-agent-tools](endo-agent-tools.md), and [endo-fetch](endo-fetch.md) |

## Summary

Daemon-backed code mode is present on `llm`.
It can retain a guest across daemon restarts and grant workspace, named mount,
and Git capabilities, but mediated network authority is not yet wired into its
tools or globals.
The portable package-manager facets and the reusable backend coordinator have
both landed in `@endo/exo-package-manager`.
The registry contract convergence, loopback broker, confined backend, daemon
formula, and frozen-install provisioning remain to be integrated.

This document is the plan of record for completing independently granted
workspace, Git, package-manager, and Web capabilities for code-mode consumers.
The durable product is a daemon-owned formula graph and trusted grant path, not
an endo-pi controller or any other harness-specific launcher.
Endo-pi remains one consumer and one end-to-end acceptance surface.

This plan covers one of two distinct execution planes. Endor already resolves
verified package graphs into the CAS and executes module entry points with no
npm CLI, no install step, and no package-script interpretation. This
design adopts that path rather than competing with it, and owns only the
remaining case where a development session needs a real npm, pnpm, or Yarn
process against a real project. The
[execution-plane boundary](#execution-planes) below states which questions
belong to which plane.

The two largest missing product surfaces are dependency hydration and mediated
Web research.
The network work begins with reusable public-address semantics and a DNS-pinned
Node HTTP transport, then composes those into transport-neutral HTTP policy and
a passable `WebResearch` capability.
The package-manager work composes only the installer facet from the portable
capability stack and never exposes the executor facet in a strict session.
The installer facet is narrower than the executor facet, but its name is not an
assurance claim.
The portable facade and merged coordinator are useful at any assurance level;
the planned `@endo/package-manager` backend is broker-configured and
conformance-qualified rather than a host-ambient default.
The [#950](https://github.com/endojs/endo-but-for-bots/pull/950) agent-tools
projection is deliberately held until that backend and the loopback broker
complete one operation end to end.

Workspace, Git, package-manager, and Web authority remain separate grants.
Every effect carries bounded and cancellable protocol contracts at the portable
facade, and its backend is responsible for enforcing them. Strong path, process,
and network containment additionally requires a conformance-qualified confined
backend. Durable policy contains no secrets or live handles, restart
reconstructs capabilities but never automatically replays interrupted work,
and out-of-band daemon-store purge remains explicitly destructive.

## Scope

This design covers:

- the generic trusted-grant and durable-reconstruction contract for code mode;
- independently provisioned workspace, Git, package-manager, and Web grants;
- installer authority for frozen dependency hydration through a real native
  package manager, with backend assurance stated separately;
- reusable public-address classification and DNS-pinned HTTP transport;
- mediated Web fetch and search with the existing `webFetch` and `webSearch`
  product names;
- public HTTPS Git clone and fetch, followed by separately credentialed fetch
  and push; and
- backend-independent acceptance through code mode, including an endo-pi
  example.

It does not add runtime code in this pull request, grant a raw shell, expose a
package-manager executor on the host, combine registry access with arbitrary
Web authority, or make one UI's policy record the general capability identity.

Three neighboring bodies of work are adopted rather than restated here:

- Endor's CAS-native resolution, artifact fetch, compartment assembly, and
  module execution, owned by
  [endor-npm-registry-proxy](endor-npm-registry-proxy.md) and
  [endor-run-expanded](endor-run-expanded.md) and their pull requests;
- CAS identities, artifact records, install graphs, materialization, action
  caches, and native Git ownership, owned by the merged
  [CAS package substrate architecture](https://github.com/0xpatrickdev/garden/blob/4998506899/designs/draft/cas-git-package-substrate.md);
  and
- sandbox driver, mount, network, rootfs, process, and cleanup mechanics, owned
  by the stacked
  [session-sandbox-backend design](https://github.com/endojs/endo-but-for-bots/pull/953).

The strict posture also does not preserve ambient harness tools. The
development-only `piTools: 'preserve'` compatibility posture is documented
separately and is outside whole-session confinement claims.

## Execution Planes

Two execution planes consume npm package content. They have different
authority, different mechanics, and different owners, and neither replaces the
other.

**Actor plane: Endor CAS-native module execution.** Endor resolves a package
graph with its own registry table and Minimum Version Selection, fetches and
SRI-verifies artifacts into the CAS, assembles a deterministic compartment map
whose locations are `cas:sha256:<tree>` references, and executes the entry
point in an XS machine. It runs no npm CLI, performs no install, consults no
lockfile, and interprets no package scripts. It never produces a
`node_modules` tree, and its executable form is always a CAS compartment map
rather than an installed layout; where a `node_modules` tree already exists on
disk, `endor run` may read it as one resolution input, which is a way of
finding module sources and not a way of installing them.
This path is landed on `llm`
through [#276](https://github.com/endojs/endo-but-for-bots/pull/276),
[#799](https://github.com/endojs/endo-but-for-bots/pull/799),
[#800](https://github.com/endojs/endo-but-for-bots/pull/800),
[#803](https://github.com/endojs/endo-but-for-bots/pull/803),
[#857](https://github.com/endojs/endo-but-for-bots/pull/857),
[#873](https://github.com/endojs/endo-but-for-bots/pull/873), and
[#875](https://github.com/endojs/endo-but-for-bots/pull/875), and is specified
by [endor-npm-registry-proxy](endor-npm-registry-proxy.md). This design adopts
it. It proposes no second resolver, Minimum Version Selection table, artifact
fetcher, compartment-assembly path, or Endor module loader, and it does not own
Endor's runtime-identity and condition questions.

That plane is still being extended, and this design adopts the extensions on
the same terms. [#282](https://github.com/endojs/endo-but-for-bots/pull/282)
adds the dependency walk for `endor run <entry.js>` under
[endor-run-expanded](endor-run-expanded.md), including the local
`node_modules` resolution input described above;
[#876](https://github.com/endojs/endo-but-for-bots/pull/876) adds the
`--conditions` flag and a webcrypto endowment for browser-build packages; and
[#879](https://github.com/endojs/endo-but-for-bots/pull/879) and
[#892](https://github.com/endojs/endo-but-for-bots/pull/892) hold the
runtime-identity and remaining design questions. None of them is this
document's to specify, and none of them is a prerequisite for the sandbox
plane below.

**Sandbox plane: native package-manager operation.** Development sessions work
on foreign repositories that expect their own package manager. That plane needs
real npm, pnpm, or Yarn semantics: lockfile format and update rules, workspace
protocols, peer-dependency resolution, the manager-specific `node_modules` or
store layout, `.bin` lookup, and package-script behavior. Reproducing those
semantics inside Endo is not a prerequisite for useful sessions and is not
proposed here. This design owns the capability, grant, broker, confinement,
bounds, and lifecycle rules for running the real manager.

Install-time lifecycle scripts remain disabled by default on the sandbox plane.
Explicitly granted test, build, or lifecycle execution is a separate bounded
sandbox operation through the executor facet, never a side effect of
installation.

CAS serves the sandbox plane as the verified artifact source, the durable
store, and the acceleration layer behind the loopback broker. It does not
replace the native package manager, and a manager-specific installed layout
never becomes canonical dependency state; the canonical state is the verified
artifact and graph records described by the CAS substrate architecture.
The two acquisition paths are expected to converge on the same canonical
content there, and how they converge is that architecture's question, not this
document's.

| Question | Plane | Owner |
|---|---|---|
| Resolve and execute an Endo or npm module graph with no manager | Actor | Endor npm-via-CAS path |
| Version selection, artifact fetch, and SRI verification for the actor plane | Actor | Endor registry table and resolver |
| The same for the sandbox plane, over the shared CAS | Sandbox | Portable registry contract plus daemon adapters |
| Lockfile semantics, workspaces, peers, linker layout, `.bin` | Sandbox | Native manager under `@endo/package-manager` |
| Serving those artifacts to a manager process | Sandbox | `@endo/npm-registry-broker` |
| Lifecycle, test, and build script execution | Sandbox, separately granted | Executor facet plus [#953](https://github.com/endojs/endo-but-for-bots/pull/953) |
| Which grants a session holds and how they survive restart | Sandbox | This design |

## Verified Current State

This state was refreshed on 2026-08-19 against `llm` commit
`c6b70e8fdb98d4bbfc72e7e0d655f942134eaa50` and the live pull-request heads.
Open implementation branches remain owned by their existing pull requests and
must not be absorbed into this design branch.

| Surface | State | Live evidence and remaining boundary |
|---|---|---|
| Daemon-backed code mode | **Landed on `llm`.** | [#905](https://github.com/endojs/endo-but-for-bots/pull/905) and [#907](https://github.com/endojs/endo-but-for-bots/pull/907) supply retained daemon guests, restart/reconnect behavior, and the endo-pi `evaluate` acceptance surface. They do not supply package-manager or mediated Web grants. |
| Endor CAS-native module execution | **Landed on `llm`, with extensions in flight.** | [#276](https://github.com/endojs/endo-but-for-bots/pull/276), [#799](https://github.com/endojs/endo-but-for-bots/pull/799), [#800](https://github.com/endojs/endo-but-for-bots/pull/800), [#803](https://github.com/endojs/endo-but-for-bots/pull/803), [#857](https://github.com/endojs/endo-but-for-bots/pull/857), [#873](https://github.com/endojs/endo-but-for-bots/pull/873), and [#875](https://github.com/endojs/endo-but-for-bots/pull/875) supply the registry table, Minimum Version Selection resolver, artifact fetch and verification, `cas:sha256:` compartment assembly, XS execution, offline mode, and peer, workspace, and `imports` handling. [#282](https://github.com/endojs/endo-but-for-bots/pull/282) adds the `endor run` dependency walk and local `node_modules` resolution input, and [#876](https://github.com/endojs/endo-but-for-bots/pull/876) adds `--conditions` and a webcrypto endowment. Runtime identity and remaining design questions belong to [#879](https://github.com/endojs/endo-but-for-bots/pull/879) and [#892](https://github.com/endojs/endo-but-for-bots/pull/892). This design adopts that plane, landed and in flight, and adds nothing to it. |
| Portable package manager | **Landed on `llm`.** | [#948](https://github.com/endojs/endo-but-for-bots/pull/948), merged 2026-08-17, defines structurally distinct cumulative reader, installer, and executor facets plus the injected backend protocol. |
| Package-manager coordinator | **Merged into `llm` on 2026-08-19.** | [#1011](https://github.com/endojs/endo-but-for-bots/pull/1011) is merged at `c6b70e8fdb98d4bbfc72e7e0d655f942134eaa50` and places the reusable coordinator in `@endo/exo-package-manager`: fixed argv, snapshot revalidation, generated configuration handoff, bounds, cancellation, exact-version evidence, and structured results. It added no ambient backend package and no host authority. |
| Package-manager projection | **Open draft, deliberately held.** | [#950](https://github.com/endojs/endo-but-for-bots/pull/950), head `f0bf013a800b5081484815843318696983883cd2`, projects metadata tools for a reader, adds `installDependencies` only for an installer, and adds `runPackageScript` only for an executor. It stays held until the broker and confined backend complete one operation end to end, so the projected tools describe an authority that actually works. |
| Named Git grants and truthful generic grants | **Landed on `llm`.** | [#958](https://github.com/endojs/endo-but-for-bots/pull/958), merged 2026-08-18, adds named nested Git grants, named mount selection, canonical-root persistence, and retained reconstruction. [#965](https://github.com/endojs/endo-but-for-bots/pull/965), merged 2026-08-19, converges live endowments, checked declarations, prompts, and retained provisioning on locally trusted grant minters. Package-manager and Web provisioning extend that path rather than adding a second one. |
| Registry contract convergence | **Open alignment issue.** | [#1027](https://github.com/endojs/endo-but-for-bots/issues/1027) records the overlap between portable [#403](https://github.com/endojs/endo-but-for-bots/pull/403) and daemon-local [#671](https://github.com/endojs/endo-but-for-bots/pull/671). The portable contract lives in the landed `@endo/exo-npm`; the daemon keeps authority-bearing adapters and formula integration. The `@endo/exo-npm-registry` rename is later compatibility work and blocks neither the broker nor the backend. |
| Package-manager backend and formula | **No implementation PR yet.** | The planned `@endo/package-manager` is a broker-configured confined backend composed from the merged `@endo/exo-package-manager` coordinator. No host-ambient backend is a default or a future package assignment. The loopback broker, daemon formula, durable policy, cleanup, and grant provisioning remain. |
| Public-Web transport and `WebResearch` | **No implementation PR yet.** | [#566](https://github.com/endojs/endo-but-for-bots/pull/566) landed `@endo/http-confine` and `@endo/exo-http-client`. The retired Genie package remains historical reference material for `webFetch`, `webSearch`, and its parser at the [last pre-retirement tree](https://github.com/endojs/endo-but-for-bots/tree/a54c3adb/packages/genie). No reusable DNS-pinned public-Web transport, passable WebResearch capability, daemon formula, or code-mode `web` grant exists. |
| Registry acquisition and package artifacts | **Landed foundations with contract convergence open.** | Portable [#403](https://github.com/endojs/endo-but-for-bots/pull/403) and daemon-local [#671](https://github.com/endojs/endo-but-for-bots/pull/671) supply overlapping `EndoRegistry` interfaces and resolvers. The daemon path supplies HTTP acquisition, explicit SRI verification, persistent CAS/cache, `@registry`, and formula powers. Artifact identity, retention, and install-graph records belong to the CAS substrate architecture, not to this document. |
| Sandbox lifecycle | **Landed on `llm`.** | [#954](https://github.com/endojs/endo-but-for-bots/pull/954), merged 2026-08-18, serializes spawn and dispose, bounds captured output, labels operation containers, and reconciles owned orphans. It is the first lifecycle cut, not a complete confined session backend. |
| Code-mode workspace surface | **Landed on `llm`.** | [#961](https://github.com/endojs/endo-but-for-bots/pull/961), merged 2026-08-17, aligns code-mode workspace bindings with the daemon `EndoMount` and keeps the extended `Filesystem` surface as a separate local seam. It is reconciled with #958's named-mount projection on `llm`. |
| Mount containment hardening | **Open on `llm`.** | [#897](https://github.com/endojs/endo-but-for-bots/pull/897), head `dc6834e475cfa2e75c15581a491d8255e828c1db`, includes symlink-deny and mid-walk revocation fixes. Until it or equivalent fixes land, portable mount facades must not be described as complete path containment. |
| Git capability evolution | **Landed on `llm`.** | [#960](https://github.com/endojs/endo-but-for-bots/pull/960) adds linked-worktree operations, [#962](https://github.com/endojs/endo-but-for-bots/pull/962) makes status bounded copy data and adds tracking, [#974](https://github.com/endojs/endo-but-for-bots/pull/974) adds worktree-relative path designators, and [#973](https://github.com/endojs/endo-but-for-bots/pull/973) bounds network-sourced `GitRemote` results and audit fields, all merged between 2026-08-17 and 2026-08-18. A sandbox Git backend must implement or explicitly exclude every one of those public methods. |
| Confined execution backend | **Design draft, with incomplete substrate guarantees.** | [#953](https://github.com/endojs/endo-but-for-bots/pull/953), head `de32dff0b5e7e1b6016517ac680e5054fc469d7d`, defines sandbox-backed project-code execution and owns the driver, mount, network, rootfs, process, and cleanup mechanics. Current `@endo/sandbox` proves `network: 'none'`; bwrap private egress is not wired, Podman filtering remains operator-owned, and the bwrap default seccomp profile is not loaded. [#971](https://github.com/endojs/endo-but-for-bots/pull/971) supplies adjacent capability-first mount projection on the `feat/hosted-endo-management` stack, not on `llm`; the backend design should evaluate reuse rather than assume a new bridge. |
| Context cancellation cleanup | **Landed on `llm`.** | [#1010](https://github.com/endojs/endo-but-for-bots/pull/1010), merged 2026-08-18, settles daemon context cancellation hooks. It improves graceful cleanup but does not add the durable mutating-effect records or reconciliation planned below. |

## Durable Grant Contract

The durable session is one authority graph, not one workspace. Its normalized
policy and retained controller may record these grants independently:

- compatibility `workspace` plus zero or more named mount grants, each with its
  own read-only or read-write mode and canonical mount lineage;
- zero or more named Git grants, each selecting one mount and a validated
  mount-relative repository path, with read-only, read-write, or
  history-rewrite authority;
- named `GitRemote` capabilities with endpoint, direction, refspec, optional
  credential policy, and an explicit selected Git grant;
- `packageManager`: reader metadata plus an installer or executor facet bound
  to an explicit mount and mount-relative project directory; and
- `web`: independently selected `fetch` and `search` operations on a
  `WebResearch` capability.

No grant implies a sibling. Multiple mount and Git grants may coexist, and no
sandbox incarnation automatically receives all of them. A package-manager
grant does not expose Git or a mount global, a registry broker does not grant
arbitrary Web access, and a Web grant does not grant Git or registry transport.

Grant identity and backing-resource identity are different. Pet names and
formula IDs identify durable grants. Mutation coordination and effect
reconciliation use the canonical backing mount lineage plus the selected
relative root, so aliases or overlapping grants cannot evade serialization.
Every capability that shares bytes derives from that canonical resource
lineage even when its mount is not guest-visible.

Now that #958 and #965 have landed, package-manager and Web provisioning extend
their normalized policy, trusted grant minter, formula lookup, declaration, and
prompt path.
They do not introduce a competing grant record, accept a caller-authored
capability/declaration pair, or add a Pi-only policy channel.
The daemon mints or reconstructs a live capability first; trusted agentry code
then derives the exact declaration and prompt from that capability and its
normalized posture.

The durable record contains only versioned, non-secret policy and formula
identifiers.
It retains mount lineages, Git and remote policy, package-manager bounds,
registry origins, cache identifiers, Web provider selection, URL policy, and
effect limits.
It never contains a live process, socket, DNS result, Undici Agent, stream,
pending promise, proxy address, credential material, or other ephemeral handle.

After a daemon restart, each formula reconstructs its ephemeral implementation
from durable policy. Reconstructing a pinned backend under the same versioned
policy may preserve public grant identity. Changing driver, rootfs, enforcement
policy, or another assurance-relevant input is an explicit migration. It mints
a new grant identity unless conformance establishes behaviorally equivalent
authority and the migration records that proof.

The planned operation records separate process liveness from effect outcome.
An entry whose former process was live becomes `interrupted` with reason
`daemon-restart`, while a durable mutating operation may later reconcile to
`no-effect`, `completed`, or `indeterminate`. A Git push can be locally
interrupted while its remote-ref outcome remains indeterminate. An install or
project script can leave partially changed workspace bytes and may have no
sound reconciliation stronger than `indeterminate`.

Durable write-ahead recording is required for operations that may mutate
durable workspace or external state. Read-only fetch, search, and Git
inspection use bounded operation receipts and cancellation, but need not turn
every call into a durable transaction. After restart they reject as
interrupted unless a consumer separately requested durable receipt retention.
No operation is automatically replayed.

The disconnected caller receives any retained receipt and reconciliation
status and must explicitly decide whether to retry. Retention is bounded. A
durable record contains only non-secret operation kind, policy and formula
identifiers, canonical resource identity, timestamps, liveness, outcome, and
reconciliation metadata. It never stores credentials, response bodies,
process handles, or sockets.

Purging the daemon store out of band can remove the controller, formulas,
aliases, policies, and daemon-owned caches.
Externally backed workspace bytes may remain, but they do not silently recreate
the session or its grants.
The caller must explicitly reprovision and revalidate them.

### Ephemeral backend selection

A confined backend owner may coordinate a lazy pool of ephemeral sandbox
incarnations. Each incarnation is keyed by its exact selected mount grants and
modes, rootfs or toolchain profile, network posture, limits, and policy version.
It receives only the authority needed for the admitted operation. Pool reuse
and eviction are private optimizations, not durable identity, and the design
does not pre-create every possible grant combination.

The owner serializes spawn and disposal for each incarnation while coordinating
mutations across incarnations by canonical backing-resource identity. The
current `SandboxHandle` chooses networking per handle, so `none`, workload
broker-only, and broad public project networking require distinct incarnations
until a proven per-spawn attenuation contract exists.

## Harness Postures and Claim Scope

Strict code mode removes Pi's standard and extension tools before activating
`evaluate`. In that posture, omission grants nothing and the zero-grant claim
means that `evaluate` is the only active tool. Capability absence, revocation,
and confinement acceptance tests in this document use strict posture.

`piTools: 'preserve'` is a development-only compatibility escape hatch for
improving the harness while capabilities are still under development. It keeps
the tools that Pi already activated and appends the code-mode prompt. Those
retained tools can carry ambient filesystem, shell, network, or extension
authority outside the Endo grant graph. Preservation therefore invalidates
whole-session claims such as "zero grants means no filesystem or network
authority" even though Endo itself minted no such grant.

Provisioning output, declarations, and prompt text must state which posture is
active. Strict acceptance runs leave preservation off. A separate compatibility
test proves that preservation adds no Endo grants beyond the retained harness
tools and never represents those tools as daemon-minted capabilities.

## Registry convergence and broker boundary

Merged [#403](https://github.com/endojs/endo-but-for-bots/pull/403) and
[#671](https://github.com/endojs/endo-but-for-bots/pull/671) are overlapping
implementations of the registry contract.
The portable PR added the `@endo/exo-npm` interface, resolver, injected cache
and CAS seams, while the daemon PR added daemon-local interface and resolver code plus
the daemon's HTTP acquisition, cryptographic verification, persistent
CAS/cache, `@registry`, and formula powers.
The convergence issue [#1027](https://github.com/endojs/endo-but-for-bots/issues/1027)
requests alignment: the portable package owns the canonical interface and
resolution logic, while the daemon instantiates it with its authority-bearing
adapters instead of retaining a duplicate resolver and table.

That portable contract lives today in the landed `@endo/exo-npm` package, and
the `@endo/exo-npm-registry` name is a later compatibility rename and migration.
The rename is not a correctness prerequisite for adapters, the broker, or the
confined backend, and no work below waits on it.
The issue is an alignment request, not a formal explicit-Kris-approval gate for
ordinary implementation work.
If the portable-canonical interpretation is wrong, the issue should be corrected
before the convergence lands, but implementation can proceed against the stated
contracts.

The daemon's HTTP, cryptographic, persistent CAS/cache, `@registry`, and formula
adapters produce verified package-artifact records.
`@endo/npm-registry-broker` owns only the operation-scoped loopback protocol
projection consumed by a package-manager process and accepts those records as
input.
It serves manager-compatible metadata and the original verified tarball bytes,
rewrites tarball URLs to itself, and authorizes only the packages and versions
admitted for that operation.
It is neither a second resolver nor the CAS.
The artifact representation, install-graph normalization, direct
materialization, and build-cache strategy remain in the merged
[CAS package substrate architecture](https://github.com/0xpatrickdev/garden/blob/4998506899/designs/draft/cas-git-package-substrate.md),
not in this capability roadmap.

## Package Ownership

| Package | Durable ownership |
|---|---|
| `@endo/net-address` in `packages/net-address` | Portable strict IPv4 and IPv6 normalization, CIDR parsing and matching, IPv4-mapped IPv6 handling, the shared special-purpose address registry, classification, and `isPublicAddress`. |
| `@endo/http-dialer` in `packages/http-dialer` | Node-specific DNS resolution and direct Undici dependency, a normal Undici `Agent` with a custom connector, pinned numeric-address connection, peer verification, Fetch-compatible injection, and close/destroy lifecycle. |
| `@endo/http-confine` | Transport-neutral method and header policy, URL authorization, manual redirects, timeouts, request-rate and response-byte limits, cancellation, and revocation. It does not import the Node dialer. |
| `@endo/exo-web-research` in `packages/exo-web-research` | Passable `WebResearch.fetch` and `WebResearch.search` interfaces, bounded copy result shapes, injected provider and transport seams, and an initial DuckDuckGo adapter salvaged from or informed by the retired Genie implementation. It has no ambient fetch or Undici dependency. |
| `packages/daemon` | Formula and lifecycle composition, serializable provider and policy selection, trusted grant reconstruction, registry adapters over the portable contract, `@endo/npm-registry-broker` projection, ephemeral transport recreation after restart, operation interruption, and transport disposal on shutdown. |
| `@endo/agent-tools` | JSON-tool and code-mode projection plus the independent `web` grant group. It owns neither provider logic nor network transport. |
| `@endo/agentry` | Generic trusted grant minting, declarations, prompt construction, and consumer-independent code-mode provisioning. |
| `@endo/exo-http-client` | An exact-origin `HttpClient` capability over an injected transport. Its origin authority does not silently widen into arbitrary public-Web authority. |
| `@endo/fetch` | A durable unconfined plugin intentionally configurable for explicit origins, including private origins. It is not the public-Web dialer. |
| `@endo/exo-package-manager` | The landed portable reader, installer, and executor facets plus the merged reusable backend coordinator: manager detection, fixed argv, snapshot revalidation, generated configuration handoff, exact-version evidence, cancellation scoping, bounds, structured results, and the injected backend protocol. It owns no native process and no network authority; the installer name denotes narrower authority, not backend assurance. |
| `@endo/exo-npm` (`@endo/exo-npm-registry` after the deferred rename) | The portable canonical registry interface, resolution logic, structured errors, and artifact identity. It accepts injected daemon adapters for HTTP acquisition, cryptographic verification, persistent CAS/cache access, `@registry` integration, and formula lifecycle; its package-artifact records are the broker's verified input. |
| `@endo/npm-registry-broker` | The operation-scoped loopback protocol projection for package-manager processes. It serves manager-compatible metadata and original verified tarball bytes from artifact records, rewrites tarball URLs, authorizes only that operation's packages and versions, and owns no CAS storage, extraction, resolution, install-graph planning, or direct materialization. |
| `@endo/package-manager` | The broker-configured confined backend that composes the merged coordinator with the loopback broker, pinned native manager execution, workspace and configuration revalidation, output/process bounds, and cleanup. It is not a host-ambient default and may claim hostile-workspace containment only after the selected sandbox profile passes conformance. |
| Endor npm-via-CAS path in `rust/endo` | Actor-plane resolution, Minimum Version Selection, artifact fetch, CAS storage, compartment assembly, and module execution with no npm CLI, no install, and no package scripts. It emits CAS compartments rather than an installed layout, though it may read an existing `node_modules` tree as a resolution input. It is adopted by this design and owned by [endor-npm-registry-proxy](endor-npm-registry-proxy.md) and [endor-run-expanded](endor-run-expanded.md). |
| `@endo/exo-git`, `packages/git`, and `packages/daemon` | Existing Git capability and native backend policy, plus the remaining public HTTPS broker, credential-free public fetch, bounded process lifecycle, and daemon provisioning. |

### Shared address semantics

`@endo/net-address` replaces reusable parsing primitives currently local to
`packages/daemon/src/cidr.js`.
The daemon keeps ownership of ingress allow/deny policy and constructs its
address checker from the leaf package.
`packages/sandbox/src/net/blocked-ranges.js` uses the same factual registry,
while sandbox profiles and enforcement choices remain owned by the sandbox.

The public-Web decision is globally reachable unicast, not merely “not RFC
1918.”
Classification follows the IANA
[IPv4](https://www.iana.org/assignments/iana-ipv4-special-registry/iana-ipv4-special-registry.xhtml)
and
[IPv6](https://www.iana.org/assignments/iana-ipv6-special-registry/iana-ipv6-special-registry.xhtml)
special-purpose registries and additionally rejects multicast.
It rejects unspecified, loopback, link-local, private/unique-local, shared
carrier space, documentation, benchmarking, discard-only, protocol-assignment,
and IPv4-mapped forms whose embedded IPv4 address is not public.
Unknown, malformed, zone-qualified, or non-canonical address text fails closed.

The package exports normalized address and CIDR records rather than exposing a
mutable list as policy.
Registry data is hardened and source-attributed so a later IANA update is a
reviewable package change.
Tests cover CIDR boundaries and normalization independently of daemon, sandbox,
and HTTP behavior.

### DNS-pinned HTTP transport

`@endo/http-dialer` owns a direct Undici dependency and constructs a normal
`Agent({ connect })`.
Undici documents the
[connector option](https://github.com/nodejs/undici/blob/main/docs/docs/api/Connector.md)
as the per-socket control point and its
[fetch dispatcher option](https://github.com/nodejs/undici/blob/main/docs/docs/api/Fetch.md)
as the request injection seam.
A custom `Dispatcher` subclass is unnecessary unless implementation proves a
constraint that a normal Agent and connector cannot satisfy.

For each new socket, the connector:

1. parses the original HTTP or HTTPS destination and rejects URL userinfo,
   ambiguous numeric literals, unsupported schemes, and prohibited hostnames;
2. resolves all A and AAAA answers through an injected resolver with the
   equivalent of `dns.lookup(hostname, { all: true })`;
3. normalizes every answer with `@endo/net-address` and rejects the complete
   answer set if any member is non-public;
4. selects one validated numeric address and connects the socket directly to
   that address without a second hostname lookup;
5. preserves the original hostname for HTTP Host, TLS SNI, and certificate
   hostname verification; and
6. after connect, normalizes `socket.remoteAddress`, verifies it is public and
   is the selected address, and destroys the socket on any mismatch.

A numeric literal becomes a one-member normalized answer set and never enters
the hostname resolver.

Every new or replacement connection repeats resolution and validation.
Connection reuse therefore cannot transfer approval to a different origin, and
DNS rebinding cannot exploit a later unresolved socket creation.
Redirects are manual at the HTTP policy layer and invoke the complete URL and
connection path again.

The package never installs a global dispatcher and never adopts ambient proxy
configuration.
Its Fetch-compatible function always passes its private Agent explicitly, so
`HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY`, an ambient proxy agent, or global
dispatcher mutation cannot redirect or bypass the connector.
The returned transport has explicit graceful `close()` and forceful
`destroy(error)` operations that cover every pooled origin and socket.

### Transport-neutral HTTP policy

`@endo/http-confine` gains an injected asynchronous URL-authorizer seam.
The seam is invoked for the initial normalized URL and every redirect target
before dispatch.
Exact-origin clients configure it with their allowed origins; public Web
configures it with scheme, hostname, and request policy that can authorize any
candidate public URL while leaving address resolution to the injected dialer.

The confinement layer continues to own allowed methods and headers, manual
redirect count and method rules, deadlines, cancellation, rate limits, response
byte caps, bounded decompression, revocation, and response disposal.
It accepts a Fetch-like transport and contains no `node:*` or Undici import.
Redirect processing is a bounded request loop rather than delegating to ambient
fetch redirect behavior.

`@endo/exo-http-client` keeps its exact-origin meaning and injected transport.
`@endo/fetch` keeps its durable unconfined-plugin meaning and may intentionally
be configured for a private origin.
A separate hardening change should deprecate omitted ambient-fetch arguments in
reusable constructors and make `@endo/fetch` pass its ambient power explicitly.
That hardening must not change the authority of an existing exact-origin grant.

### Passable Web research

`@endo/exo-web-research` exposes a `WebResearch` capability whose initial
surface is:

- `fetch({ url, timeoutMs? })`, limited to safe read methods and returning a
  bounded copy record containing final URL, status, content type, decoded text,
  and truncation metadata; and
- `search({ query, count? })`, returning a bounded copy record of normalized
  `{ title, url, snippet }` results plus truncation metadata.

Guards bound URL and query length, result count, every string field, response
bytes, redirects, and deadlines.
Provider result URLs are inert data; returning one neither fetches it nor grants
authority to it.
A later fetch of that URL starts a new fully authorized operation.

The package injects a Fetch-like transport and a search-provider adapter.
The initial DuckDuckGo HTML adapter and parser are salvaged from, or use as a
reference, the retired Genie's last pre-retirement implementation. The new
package receives no ambient fetch.
Provider selection is durable policy, while DNS, Agent, connection pool, socket,
and cancellation state are recreated by the daemon formula after restart.
Formula cancellation and daemon shutdown close or destroy the transport.

Agent-tools retains the `webFetch` and `webSearch` product names as adapters
over the supplied `WebResearch` capability. It projects the same capability
into JSON tools and a code-mode `web` global only when the independent `web`
grant is present.
Agentry and daemon provisioning bind it through the trusted generic grant path
used by other capabilities.

### Recommended Web implementation stack

The Web feature is delivered as four reviewable pull requests in this order:

1. **Shared address semantics and consumers.** Add `@endo/net-address`, move
   reusable daemon CIDR primitives, and make daemon and sandbox factual
   registries consume it.
   Stop when strict IPv4/IPv6/CIDR and complete special-address tests pass and
   daemon ingress and sandbox profile behavior remain intentionally owned by
   their packages.
2. **DNS-pinned public HTTP transport.** Add `@endo/http-dialer` with a normal
   Undici Agent, custom connector, full-answer-set validation, numeric dialing,
   TLS hostname and peer verification, direct proxy-independent fetch, and
   close/destroy lifecycle.
   Stop when adversarial transport tests prove every socket is validated and no
   DNS, proxy, peer-address, or disposal bypass remains.
3. **HTTP authorizer, WebResearch, and formula.** Add the transport-neutral
   `@endo/http-confine` URL-authorizer and redirect loop, add
   `@endo/exo-web-research`, move the DuckDuckGo adapter, and add the daemon
   formula over injected transport.
   Stop when bounded fetch/search work through a reconstructed formula and all
   initial and redirect URLs cross both the authorizer and dialer.
4. **Product adapters and trusted grant exposure.** Add agent-tools
   JSON/code-mode adapters, salvaging or consulting the retired Genie
   implementation, and extend agentry and daemon generic provisioning with the
   independent `web` grant.
   Stop when a code-mode consumer receives exactly the granted Web operations,
   declarations stay truthful, and absence or revocation removes the surface.

The first two pull requests are the missing reusable transport substrate.
All four are required for usable code-mode Web research.
Daemon-owned Web research does not depend on the sandbox backend because the
guest never receives a network process or socket.

## Assurance Levels

The architecture has three distinct assurance levels. Claims in this document
name the level they require.

1. **Portable capability guarantees.** The Exo facade is the authority
   boundary independent of backend. In #948 it mints non-escalating reader,
   installer, and executor facets; guards passable inputs; verifies mount
   lineage and path segments; constructs fixed manager argv; defaults installs
   to frozen lockfile posture while allowing host policy to deny updates;
   accepts no shell string or opaque installer arguments; clamps time policy;
   scopes cancellation by operation; and passes output bounds plus the expected
   workspace snapshot through the backend protocol. These checks materially
   prevent authority widening through the public API. Actual output
   enforcement and snapshot revalidation remain backend obligations.
2. **Broker-configured integration.** The coordinator and registry broker may
   be exercised with a trusted host adapter while the confined implementation
   is developed, but this is defense in depth and not a host-ambient default,
   package ownership commitment, or hostile-workspace claim. Fixed argv, hook
   denials, sanitized environment, process-group cleanup, and broker
   configuration remain required integration behavior.
3. **Conformance-qualified confined backend.** Production use with untrusted
   workspaces requires `@endo/package-manager` and its selected sandbox driver
   to prove the applicable filesystem, process, secret, and network profiles
   with driver-owned probes and adversarial tests. Only this level may make
   hostile-workspace path, broker-bypass, child-process, and cleanup claims.

The portable facade and merged coordinator delegate actual filesystem access,
symlink resolution, process creation, network enforcement, atomic
revalidation, termination, and reaping to their backend.
An Exo guard can reject a malformed path record or an ungranted method, but it
cannot prove what a native process does after spawn.
The portable layer is therefore necessary at every level and is not a
substitute for a confined backend at level 3.
There is no planned host-ambient package-manager backend; a host adapter is a
development aid only.
#897's still-open symlink-deny and mid-walk revocation fixes are concrete
evidence that the portable mount containment surface is still being hardened.

`@endo/sandbox` is the planned level-3 substrate, not a present blanket
guarantee. Its `network: 'none'` profile is implemented. Its current bwrap
`private` profile does not wire the documented pasta and nftables path, Podman
private filtering remains operator responsibility, and bwrap does not load the
default seccomp profile. The stacked
[session-sandbox-backend design](https://github.com/endojs/endo-but-for-bots/pull/953)
must keep these limitations explicit and define the probes that graduate a
driver and profile to conformance.

## Network Mediation by Workload

The strongest practical plan keeps native Git and package-manager semantics
but places their sockets behind kernel-enforced broker-only egress. A generic
CONNECT proxy by itself is only the shortest implementation path. It is not the
security boundary because an unconstrained process can ignore proxy settings.

- **Web research** remains daemon-owned HTTP. `@endo/http-confine` applies
  method, header, redirect, decompression, body, deadline, and rate policy over
  `@endo/http-dialer` sockets. No guest or native child receives those sockets.
- **Package installation** uses a loopback registry and tarball broker backed
  by the portable registry contract and verified package-artifact records. The
  manager retains lockfile, workspace, peer, and linker semantics, while the
  broker sees only bounded package-artifact projections and enforces registry,
  tarball, integrity, and byte policy. A conformance-qualified sandbox permits
  the manager to reach only this broker.
- **Git HTTPS** uses an exact-origin CONNECT broker because Git must retain the
  end-to-end TLS connection needed for its native protocol and certificate
  checks. The broker validates the CONNECT origin, every DNS answer, and the
  numeric connected peer, then bounds the raw tunnel and its lifetime. Git
  retains hostname and certificate verification. Because the TLS stream is
  opaque to the broker, `@endo/http-confine` method, header, redirect, body,
  and decompression rules do not apply inside the tunnel.

The sandbox therefore needs a `broker-only` network posture, implemented as a
dedicated handle/profile or a future per-spawn network contract. The current
`SandboxHandle` selects networking per handle, not per spawn. Conformance
requires that the child can reach its named loopback or sidecar broker and
nothing else: no direct public socket, private or metadata address, host
service, alternate proxy, or DNS escape.

Reimplementing complete Git and package-manager network protocols inside the
daemon would provide a smaller child network surface in theory, but it would
also duplicate mature client semantics and create a much larger security code
surface. Broker-only egress with workload-specific mediators is the stronger
practical plan.

## Daemon-Backed Frozen Installation

### Authority posture

#948 defines three cumulative but structurally distinct capabilities:

- a reader with `detect` and `scripts` metadata;
- an installer that adds `install` and operation-scoped `cancel`; and
- an executor that additionally adds named-script `run`.

#950 projects exactly those facets as `detectPackageManager` and
`listPackageScripts`, then `installDependencies`, then `runPackageScript`.
It remains held until the broker and confined backend run one real installation
end to end, because a projected tool that no backend can satisfy would advertise
authority the session cannot exercise.
The daemon-backed milestone mints, retains, and exposes only the installer
facet. It cannot invoke named scripts or the executor surface, but that
structural attenuation is not a promise that the selected backend safely
processes hostile package-manager configuration.
It does not simulate an executor, expose `runPackageScript`, or retain an
executor internally where a guest could recover it through attenuation.

Project-code execution, lifecycle execution, package binaries, and the executor
facet belong only to a conformance-qualified confined backend in
[the stacked sandbox design](https://github.com/endojs/endo-but-for-bots/pull/953).
They are not prerequisites for frozen installation in a trusted development
workspace. A hostile workspace still requires the confined backend even when
only the installer facet is exposed, because manager parsing, filesystem
access, and network activity occur below the portable facade.

### Portable argv and backend enforcement

The reviewed #948 builder is the normative portable argv source.
Its current frozen profiles and version assumptions are:

| Manager | Current #948 frozen argv | Current #948 version assumption | Host-backend checks beyond argv |
|---|---|---|---|
| npm | `npm ci --ignore-scripts` | No npm major is asserted by the portable layer. | Pin an installed tested version; require matching `package-lock.json` or `npm-shrinkwrap.json`; deny project/user configuration, lifecycle approval, Git/arbitrary URL/file escapes, manager download, audit/fund side effects, and explicit run/exec surfaces. |
| pnpm | `pnpm install --frozen-lockfile --ignore-scripts` | No pnpm major is asserted by the portable layer. | Pin an installed tested version; require `pnpm-lock.yaml`; force trusted `ignorePnpmfile` configuration and reject project `.pnpmfile.cjs`/`.mjs`, plugins, runtime downloads, Git/arbitrary URL sources, and store/path escapes. |
| Yarn 1 | `yarn install --frozen-lockfile --ignore-scripts` | The caller supplies a positive Yarn major. | Pin a tested Yarn 1 version; require `yarn.lock`; ignore or reject project `yarn-path`, plugins, executable configuration, registry/proxy/path overrides, and script surfaces. |
| Yarn 2 | `yarn install --immutable --skip-builds` | #948 rejects Yarn 2 before 2.4. | Pin a tested 2.4+ version; set trusted configuration and environment, reject `yarnPath`, plugins, environment-file injection, executable configuration, and unsupported offline or production requests. |
| Yarn 3+ | `yarn install --immutable --mode=skip-build` | The portable layer selects this branch for every major above 2. | Pin individually tested major/minor versions and apply the same project-configuration denials; do not infer compatibility from the major branch alone. |

#948 additionally owns its fixed optional offline and production flags and
rejects those modes for Yarn 2 and later.
The host policy may narrow or disable those inputs but must not restate a second
portable argv builder.

Trusted backend configuration complements, but does not replace, those argv
profiles.
It points npm and pnpm at generated configuration rather than user or project
configuration, sets pnpm `ignorePnpmfile`, and rejects project hook/plugin
files.
Yarn 1 runs with `YARN_IGNORE_PATH=1`.
Modern Yarn additionally runs with scripts and telemetry disabled and rejects
environment-file injection; `--skip-builds` or `--mode=skip-build` remains
mandatory because a configuration default alone is not the reviewed execution
boundary.

This split matches the authoritative manager documentation:

- npm [`ci`](https://docs.npmjs.com/cli/v11/commands/npm-ci/) requires an
  existing matching lockfile, does not update manifests or lockfiles, and
  documents that `ignore-scripts` does not prevent an explicitly invoked
  `npm run`;
- pnpm [`install`](https://pnpm.io/cli/install) documents frozen-lockfile and
  ignore-scripts behavior, while the
  [pnpmfile](https://pnpm.io/pnpmfile) documentation identifies install hooks
  and `ignorePnpmfile` as the companion control;
- Yarn Classic documents
  [frozen lockfiles and ignored scripts](https://classic.yarnpkg.com/lang/en/docs/cli/install/);
  and
- modern Yarn documents immutable installation and
  [`skip-build` mode](https://yarnpkg.com/cli/install), with project-controlled
  `enableScripts`, `ignorePath`, `injectEnvironmentFiles`, and `yarnPath`
  settings in its
  [configuration reference](https://yarnpkg.com/configuration/yarnrc).

The merged coordinator in `@endo/exo-package-manager` implements the injected
backend protocol and directly supplies only trusted, pinned npm, pnpm, or Yarn
command data with fixed argv.
Host-shell and exo-shell are not the engine.
The planned `@endo/package-manager` backend composes that coordinator with the
broker and a conformance-qualified process runner.
Its public surface permits only frozen dependency hydration and has no
lifecycle, project plugin/hook, package-script, package-binary, `exec`, `npx`,
or `dlx` method.
Those restrictions narrow authority, but portable checks alone do not make an
unconfined child safe for hostile workspaces.

Immediately before spawn, the backend atomically revalidates:

- mount lineage and mount-relative `cwd`;
- the portable manifest, lockfile, and manager-selection snapshot;
- manager binary identity and supported pinned version;
- all manager and project configuration that can redirect execution, paths,
  registries, proxies, plugins, hooks, runtime downloads, or scripts;
- allowed registry and tarball HTTPS origins; and
- manager-owned cache, store, scratch HOME, and temporary paths.

The process receives closed stdin, a sanitized fixed environment, a generated
empty HOME, bounded stdout and stderr, a deadline, and an operation-scoped
cancellation signal.
It runs in a process group or equivalent parent-death wrapper.
Output overflow, cancellation, deadline, daemon shutdown, and backend error all
follow one terminate, hard-kill-after-grace, bounded-drain, reap, and orphan
cleanup path.

Registry metadata and tarballs pass through a daemon-selected loopback broker
backed by portable-contract package-artifact records, published-integrity
checks, and daemon-provided CAS persistence.
The manager still writes its own `node_modules`, store, or virtual layout in the
workspace; CAS supplies the verified bytes and the acceleration, not the layout.
The package-manager process receives trusted configuration naming only that
broker, with proxy bypass disabled.
During development a host adapter may exercise this cooperatively, but it is
not the plan's default backend.
At the confined level, the `broker-only` sandbox profile enforces that the
manager cannot connect around the broker.
The broker endpoint and arbitrary Web capability are never guest bindings.

Cache contents and policy are durable but non-secret.
The daemon formula records cache identifiers, supported manager identity,
registry policy, limits, and reconstruction version.
Live manager processes, proxy listeners, pipes, temporary credentials, and
in-flight operations are explicitly non-durable. Restart interrupts former
process liveness, then reconciles and records the effect outcome separately.

## Git Completion Work

The native Git capability, fixed-argv backend, repository identity checks,
configuration hardening, remote policy, credential formula, and retained guest
seams are already present on `llm`.
#958 and #965 landed named grants and truthful generic provisioning.
The remaining Git work should reuse those seams and stay proportionate to the
two missing remote behaviors.

First, allow credential-free public HTTPS endpoints for clone and fetch without
weakening the rule that a supplied credential is daemon-minted and audience
bound.
Route Git HTTPS through an exact-origin CONNECT broker that reuses the shared
address classifier, resolves and validates every answer, dials a selected
numeric peer, and bounds the opaque tunnel.
The Git client preserves TLS hostname and certificate verification.
Because CONNECT cannot inspect HTTPS redirects, Git must reject any redirect or
follow only a destination independently authorized by Git policy and a fresh
broker tunnel.
Continue using the policy URL rather than repository configuration and deny
HTTP, SSH, scp syntax, `git:`, `ext`, local file production transport, helpers,
URL rewriting, submodule recursion, and executable configuration.

Second, retain operation-scoped authenticated fetch and push.
Credential material is requested only after endpoint, direction, and refspec
authorization and travels through the existing anonymous descriptor path.
It never enters argv, environment values, configuration, storage, logs, result
records, or model context.
Rotation, revocation, cancellation, timeout, and restart invalidate the
operation, close the descriptor, and kill and reap the process.

Clone destinations and repository roots remain confined to the canonical
lineage of their selected daemon-minted mount grant.
Git output, deadlines, cancellation, process groups, shutdown interruption, and
orphan cleanup use the same bounded runner discipline as package installation.
For untrusted repositories, the confined runner's `broker-only` network profile
must make direct sockets impossible. Proxy configuration alone is not a
confinement boundary.

## Dependency-Ordered Work

The checklist is the work ledger for this design. An unchecked item without a
linked pull request is unposted work, not implied follow-up.

### Landed foundations

- [x] Retained code-mode reconstruction and Pi integration. Owners:
  `@endo/agentry` and daemon. Tracking: #905 and #907. Done: durable non-secret
  session policy reconstructs the guest and the Pi acceptance surface.
- [x] Attenuated Git facets and fixed native backend seams. Owners:
  `@endo/exo-git`, `packages/git`, and daemon. Tracking: #906 and prior Git
  capability work. Done: reader, writer, and rewriter authority is distinct and
  the backend receives normalized policy.
- [x] Exact-origin HTTP confinement and Exo client. Owners:
  `@endo/http-confine` and `@endo/exo-http-client`. Tracking: #566. Done:
  bounded transport-neutral HTTP policy can receive an injected transport.
- [x] Registry acquisition, published-integrity verification, and package
  records. Owners: portable `@endo/exo-npm` from [#403](https://github.com/endojs/endo-but-for-bots/pull/403)
  and daemon-local `EndoRegistry` from [#671](https://github.com/endojs/endo-but-for-bots/pull/671).
  Done: both implementations can acquire and verify package bytes through
  injected fetch and persistence seams; convergence remains tracked by
  [#1027](https://github.com/endojs/endo-but-for-bots/issues/1027).
- [x] Graceful CapTP shutdown. Owner: `@endo/captp`. Tracking: #947. Done:
  deliberate disconnects settle through the graceful shutdown path. This does
  not complete crash recovery or effect reconciliation.
- [x] Portable package-manager facets. Owner: `@endo/exo-package-manager`.
  Tracking: #948. Done: reader, installer, and executor are non-escalating,
  fixed-argv facets with operation-scoped cancellation, bounded protocol
  inputs, and expected-snapshot handoff to the backend.
- [x] Fail-closed Git and filesystem foundations. Owners: daemon,
  `@endo/exo-git`, and `@endo/platform`. Tracking: #920, #929, #941, and #959.
  Done: writable Git rejects read-only mounts, remote policy is normalized,
  extended filesystem guards use typed records, and large status output is
  streamed. #962 landed the bounded-copy-data follow-up.
- [x] Development-only Pi tool preservation. Owner: `@endo/agentry`.
  Tracking: #957. Done: `piTools: 'preserve'` is an explicit compatibility
  posture and does not become a strict-session authority claim.
- [x] Endor CAS-native module resolution and execution. Owner: the Endor
  npm-via-CAS path. Tracking: #276, #799, #800, #803, #857, #873, and #875,
  with #282 and #876 extending the plane in flight. Done: verified package
  graphs resolve into the CAS and entry points execute with no npm CLI, no
  install, no lockfile, and no package scripts. This design adopts that plane
  and adds no competing implementation.
- [x] Reusable package-manager backend coordinator. Owner:
  `@endo/exo-package-manager`. Tracking: #1011, merged 2026-08-19. Done: fixed
  argv, generated configuration handoff, snapshot revalidation, bounds,
  cancellation, exact-version evidence, and structured results are
  backend-independent and carry no process or network authority.
- [x] Named mount and Git authority graph with truthful generic provisioning.
  Owners: `@endo/agentry` and daemon. Tracking: #958 and #965, merged
  2026-08-18 and 2026-08-19. Done: multiple named mounts coexist, each Git
  grant selects one mount plus a relative path, and checked declarations and
  prompts derive from trusted live minters.
- [x] Code-mode mount-surface reconciliation. Owners: `@endo/agent-tools`,
  `@endo/agentry`, and daemon. Tracking: #961, merged 2026-08-17. Done:
  guest-visible workspace and named-mount declarations expose the daemon
  `EndoMount` contract and the extended `Filesystem` stays a derived local
  seam.
- [x] Bounded sandbox lifecycle ownership. Owner: `@endo/sandbox`. Tracking:
  #954, merged 2026-08-18. Done: spawn/dispose ordering, capture caps,
  exact-label orphan cleanup, and operation-container cleanup landed without
  claiming the later mount or network profiles.
- [x] Evolved Git public surface. Owners: `@endo/exo-git` and `packages/git`.
  Tracking: #960, #962, #973, and #974. Done: linked worktrees, bounded
  status and tracking data, worktree-relative designators, and bounded remote
  results are public. Each selected backend must now implement or explicitly
  exclude them before it is advertised.
- [x] Daemon context cancellation hooks. Owner: daemon. Tracking: #1010, merged
  2026-08-18. Done: graceful cancellation cannot strand a cleanup hook. This
  does not substitute for the durable operation work below.

### Open pull requests

- [ ] Close portable mount containment gaps. Owner: daemon mount. Tracking:
  #897. Done when symlink-deny and mid-walk revocation behavior are covered by
  adversarial tests and the remaining level-1 claims are accurate.
- [ ] Extend named startup grant provisioning. Owner: `@endo/agentry`.
  Tracking: #1021, stacked on landed #965. Done when a configured grant path is
  resolved once by the host, its exact formula is retained, and the capability
  is bound in code mode without exposing host lookup authority. The
  package-manager and Web grants below extend this path rather than adding a
  second one.
- [ ] Land exact package-manager projection. Owner: `@endo/agent-tools`.
  Tracking: #950, based on landed #948 and #1011. Dependencies: the loopback
  broker and the confined backend demonstrating one end-to-end installation.
  Held until then. Done when tool and code-mode surfaces expose only the
  methods present on the received facet and every exposed method has a working
  backend.
- [ ] Amend the stacked sandbox design to use the same liveness and outcome
  vocabulary, assurance levels, and `broker-only` requirement. Owner:
  [session-sandbox-backend](https://github.com/endojs/endo-but-for-bots/pull/953).
  Tracking: #953.
  Dependency: this design revision. Done when it no longer treats every
  interrupted operation as a known no-effect outcome or current sandbox
  profiles as already conforming.

### Unposted implementation work

- [ ] Add shared public-address semantics. Owner: new `@endo/net-address`, with
  daemon and sandbox consumers. Dependency: none of the open stacks. Done when
  strict IPv4, IPv6, mapped-address, CIDR, and special-purpose registry tests
  pass without moving policy ownership into the leaf package.
- [ ] Add the DNS-pinned daemon HTTP transport. Owner: new
  `@endo/http-dialer`. Dependency: shared address semantics. Done when every
  socket validates the full answer set and numeric peer while preserving TLS
  hostname verification and explicit disposal.
- [ ] Add `WebResearch` and its daemon formula. Owners: `@endo/http-confine`,
  new `@endo/exo-web-research`, and daemon. Dependency: the HTTP dialer. Done
  when bounded fetch and search reconstruct without ambient fetch; retired
  Genie code is salvaged or used only as reference.
- [ ] Add Web product adapters and the independent trusted `web` grant. Owners:
  `@endo/agent-tools`, `@endo/agentry`, and daemon. Dependencies: WebResearch
  plus #965. Done when only selected fetch or search operations appear in
  checked declarations, prompts, and globals.
- [ ] Converge the daemon registry adapters on the portable contract. Owners:
  `@endo/exo-npm` and daemon. Tracking: [#1027](https://github.com/endojs/endo-but-for-bots/issues/1027),
  with [#403](https://github.com/endojs/endo-but-for-bots/pull/403) and
  [#671](https://github.com/endojs/endo-but-for-bots/pull/671). Done when the
  portable package owns the canonical interface and resolution logic, daemon
  HTTP, cryptographic, persistent CAS/cache, `@registry`, and formula adapters
  preserve verified package-artifact provenance, and duplicate daemon-local
  contracts are retired. The `@endo/exo-npm-registry` rename and its migration
  are separate later compatibility work and gate nothing below.
- [ ] Add the loopback registry and tarball broker. Owner:
  `@endo/npm-registry-broker`. Dependency: the landed portable registry
  contract and the merged coordinator; it does not wait on the rename or on a
  complete install graph. Done when lockfile-selected acquisition consumes
  verified package-artifact records and broker policy rejects arbitrary
  registry, tarball, and byte flows without owning the CAS substrate.
- [ ] Add the broker-configured confined package-manager backend. Owner:
  `@endo/package-manager`. Dependencies: the merged coordinator,
  [#953](https://github.com/endojs/endo-but-for-bots/pull/953), and the broker.
  Done when pinned managers, generated configuration, fixed argv, bounds,
  cancellation, revalidation, and reaping pass the selected sandbox conformance
  profile; no host-ambient backend is required or exposed.
- [ ] Demonstrate one end-to-end brokered installation, then release the
  held #950 projection. Owners: `@endo/package-manager`,
  `@endo/npm-registry-broker`, and `@endo/agent-tools`. Dependencies: the
  broker and the confined backend. Done when a real npm, pnpm, or Yarn process
  hydrates a fixture workspace through the broker under bounds and cleanup, and
  only then does the agent-tools projection land.
- [ ] Implement and qualify sandbox `broker-only` networking. Owner:
  `@endo/sandbox` plus the session sandbox backend. Dependencies: #953 design
  amendment and workload brokers. Done for the first production cut when one
  reference driver enforces broker reachability with no direct socket, host,
  private, metadata, DNS, or alternate-proxy escape through driver-owned
  probes. Every additional advertised driver must pass the same profile before
  it is enabled; parity does not block the first qualified backend.
- [ ] Add the package-manager formula and grant exposure. Owners: daemon,
  `@endo/agentry`, and `@endo/agent-tools`. Dependencies: landed #948, #965,
  and #1011, plus the released #950 projection, the daemon registry adapters,
  the broker, and `@endo/package-manager`. Done when restart reconstructs
  exactly the broker-configured installer posture and code mode never exposes
  `runPackageScript` without an executor grant.
- [ ] Add exact-origin Git CONNECT brokering for public clone/fetch and
  credentialed fetch/push. Owners: `@endo/exo-git`, `packages/git`, and daemon.
  Dependency: shared address semantics over landed #958 and #965. Done when origin,
  DNS answers, numeric peer, tunnel bounds, TLS validation, direction,
  refspec, and operation credential are enforced. Host use is development
  defense in depth; untrusted use additionally depends on `broker-only`.
- [ ] Let every named Git remote select a named Git grant. Owners:
  `@endo/agentry`, daemon, and `@endo/exo-git`. Dependency: landed #958. Done when each
  remote records an explicit Git-grant selector and no compatibility-root
  `git` binding is required when only named Git grants exist.
- [ ] Define the durable bounded operation-record schema. Owner: daemon.
  Dependency: existing operation IDs. Done when the record is limited to
  operations that can mutate durable workspace or external state, separates
  liveness from `no-effect`, `completed`, and `indeterminate`, keys mutation
  obligations by canonical resource identity, and contains only versioned
  non-secret metadata.
- [ ] Add write-ahead operation recording, receipt/status inspection, and
  bounded retention. Owner: daemon. Dependency: the operation schema. Done when
  callers can inspect a stable receipt after reconnect and retention limits do
  not erase still-live reconciliation obligations.
- [ ] Integrate mutating Git, install, and project execution with durable
  operation records. Owners: their backends and daemon formulas. Dependency:
  write-ahead records. Done when mutation dispatch cannot occur before the
  durable running record and final settlement cannot occur before the
  effect-specific outcome record. Read-only calls retain bounded receipts only
  when requested and are never promoted into transactions by default.
- [ ] Add effect-specific reconciliation. Owners: Git, package-manager,
  project-execution, and daemon. Dependency: journal integration. Done when Git
  compares remote refs, installation examines workspace and dependency state,
  arbitrary project execution remains conservatively `indeterminate`, and
  retry guidance never assumes idempotence.
- [ ] Add crash-point recovery tests. Owner: daemon integration tests.
  Dependency: reconciliation. Done when tests cover crash before dispatch,
  during execution, after external completion, and before journal settlement
  for every effect family.
- [ ] Run consumer-independent strict acceptance, with endo-pi as one example.
  Owners: agentry and daemon integration tests. Dependencies: Web, package,
  Git, journal, and required confined-backend items above. Done when selected
  grants alone survive restart without replay, complete the end-to-end flow,
  and report purge, interruption, and indeterminate outcomes truthfully.

Address semantics, the broker, the confined package backend, and the operation
schema can proceed in parallel now that the coordinator has landed and the
portable registry contract exists.
None of them waits on the deferred registry rename.
Final Web and package projection composes with #965's landed trusted grant path
rather than introducing a second policy model.
Untrusted native-process acceptance waits for a conformance-qualified confined
backend; daemon-owned Web acceptance does not.

## Acceptance and Security Tests

The capability roadmap is complete only when tests prove all of the following
at the assurance level named by each claim.

### Grant and durability contract

- in strict posture, zero grants yields only `evaluate`, and every combination
  of compatibility workspace, named mounts, named Git, package-manager, Web
  fetch, and Web search omits ungranted siblings;
- in development preservation posture, retained Pi tools are identified as
  ambient harness authority and do not appear as Endo grants;
- declarations and prompt text match the exact trusted live posture, including
  reader versus installer and absence of the executor;
- each related capability derives from its selected mount grant's canonical
  lineage before and after restart, multiple sibling mount grants coexist, and
  aliases to one backing resource share mutation coordination;
- restart preserves durable identities, workspace bytes, formula policy,
  non-secret caches, grant selection, and bounded operation receipts but never
  a live process, connection, credential, or in-flight handle;
- interrupted mutating operations expose separately reconciled `no-effect`,
  `completed`, or `indeterminate` outcomes, read-only operations reject without
  automatic replay, and every retry requires an explicit caller decision; and
- out-of-band daemon-store purge is reported and tested as destructive.

### Network and Web contract

- direct IPv4 and IPv6 literals, alternate IPv4 encodings, malformed literals,
  IPv4-mapped IPv6, unspecified, loopback, private/ULA, shared carrier,
  link-local, multicast, documentation, benchmarking, and metadata addresses
  all fail closed;
- localhost aliases and cloud metadata names fail before connect;
- mixed A/AAAA answer sets are rejected, every new socket re-resolves and
  revalidates, controlled rebinding cannot change the peer, and the connected
  peer address must equal the selected public address;
- HTTPS preserves the original hostname for SNI, Host, and certificate
  verification while the socket connects only to the validated number;
- redirects re-run URL authorization, resolution, and address checks, including
  redirect-to-private and redirect-loop cases;
- for daemon-owned Web, ambient proxies, proxy environment variables,
  `NO_PROXY`, and global dispatcher mutation cannot intercept or bypass the
  transport;
- oversized plain or compressed bodies, decompression expansion, result-field
  sizes, redirect counts, rates, deadlines, cancellation, and revocation are
  bounded; and
- graceful close and forceful destroy dispose every Agent, origin pool, socket,
  body, and pending request.

Web HTTP tests apply the complete `@endo/http-confine` contract. Git CONNECT
tests instead prove exact-origin, DNS-answer, numeric-peer, TLS, tunnel-byte,
deadline, and disposal bounds because HTTP methods, headers, redirects, and
bodies are opaque inside the tunnel.

### Package-manager and Git contract

- every supported pinned manager version is tested with root and dependency
  lifecycle canaries, pnpm hooks, Yarn plugins and configuration, package
  binaries, explicit scripts, and manager download requests;
- snapshots, manager selection, selected mount lineage, configuration, registries,
  cache/scratch paths, and executable identity are revalidated immediately
  before spawn;
- only frozen hydration occurs and neither manifests nor lockfiles change at
  every backend level, and the installed layout the native manager produces is
  accepted as the manager's own projection rather than reproduced by Endo;
- one end-to-end brokered installation with a real pinned manager precedes the
  #950 agent-tools projection, so no exposed method lacks a working backend;
- coordinator and broker integration tests prove fixed configuration, output,
  cancellation, verified package-artifact handling, and process cleanup for
  trusted fixtures without representing them as hostile-workspace confinement
  tests;
- conformance-qualified confined tests prove no process writes outside the
  workspace and explicit cache/scratch paths, and no process reaches a
  non-granted origin or bypasses its broker;
- registry convergence tests prove the shared interface and resolver contract,
  explicit published SRI verification, and the verified link from original
  tarball bytes to the extracted readable tree, without adding a resolver or
  artifact store beside the Endor actor-plane path;
- broker conformance tests prove that only verified package-artifact records are
  projected over loopback and that arbitrary registry, tarball, byte, proxy,
  and direct-network requests fail closed;
- stdout/stderr overflow, deadlines, cancellation, daemon restart, and child
  pipes that remain open all terminate and reap the complete process group;
- public HTTPS Git clone/fetch works without credentials while authenticated
  operations require the exact separately granted audience, direction, remote,
  and refspec; and
- Git rejects configuration rewriting, remote helpers, protocols, symlink/path
  escapes, broker bypass, credential disclosure, rotation races, cancellation,
  and restart continuation, with path and broker-bypass claims reserved for the
  conformance-qualified confined tier.

An endo-pi scenario may supply the final UI acceptance: start with selected
grants, research a public page, clone or open a repository, inspect and edit the
workspace, hydrate frozen dependencies, commit, fetch, and conditionally push.
The strict scenario runs with `piTools: 'preserve'` absent.
The same capability composition must be usable by a non-Pi code-mode consumer
without importing an endo-pi controller or launcher.

## Relationship to the Confined Sandbox Backend

The
[session-sandbox-backend design](https://github.com/endojs/endo-but-for-bots/pull/953)
defines the Session Sandbox Execution Backend.
It may implement the same backend-independent capabilities and is the only
planned posture for lifecycle scripts, package binaries, named scripts, and
broader project execution. It is also the planned production boundary for
native package-manager or Git processes that consume untrusted workspace
content.

That design owns the sandbox driver, mount, network, rootfs, process, and
cleanup mechanics; this document states only the capability, grant, and
assurance obligations it must satisfy.
The portable facade, broker integration, and four-pull-request daemon-owned
Web stack can progress before it.
Selecting a backend for a new grant does not change the public interface.
Migrating an existing grant across driver, rootfs, or enforcement policy is
versioned and explicit, and preserves identity only after equivalence is
established.
Hostile-workspace path, process, broker-bypass, and orphan claims remain
disabled until the selected sandbox driver and profile pass the conformance
tests in this document.

## Alternatives Rejected

- **One general network grant:** registry, Git, and Web authority have different
  destination and effect bounds and must remain independently attenuated.
- **Turning `@endo/exo-http-client` or `@endo/fetch` into the public dialer:** an
  exact-origin grant and an intentionally unconfined durable plugin have useful
  meanings that should not silently change.
- **Recreating the retired Genie transport as the authority boundary:** its
  ambient-fetch implementation is useful reference material, not a reusable
  safe arbitrary-public-Web transport.
- **A custom Undici Dispatcher:** a normal Agent already accepts the per-socket
  connector and explicit fetch dispatcher seams required by this design.
- **Raw caller grant records or Pi-only policy:** either lets declarations
  self-assert authority or couples the capability system to one consumer.
- **Host package-manager executor:** explicit `run`, lifecycle, package binary,
  and project-code authority exceed the frozen-installer posture.
- **A durable transaction for every read-only call:** cancellation and bounded
  receipts are sufficient for ordinary fetch, search, and Git inspection;
  durable write-ahead state is reserved for effects that may mutate durable or
  external state.
- **One permanent sandbox or every possible grant combination:** either widens
  ambient authority or creates a combinatorial pool. Lazy exact-authority
  incarnations preserve least authority without making pooling public policy.
- **Automatic replay after restart:** install, Git, and network effects are not
  generally idempotent and require a live caller decision.
- **A second resolver, version-selection table, artifact fetcher, or module
  loader beside Endor's:** the actor plane already resolves verified graphs into
  the CAS and executes entry points, and this design consumes that work instead
  of forking it.
- **An Endo-native linker that emulates npm, Yarn Berry, and pnpm layouts:**
  development sessions need each manager's exact semantics, which the manager
  itself already implements; a generic lockfile-to-`node_modules` engine would
  be a large surface with no session-visible benefit.
- **Treating an installed `node_modules` tree as canonical package state:** it
  is one manager-specific projection of verified artifacts and graph records.
- **Landing the #950 projection before a working backend:** a tool that names an
  installer no backend can run advertises authority the session does not have.

## Open Questions

The registry convergence issue [#1027](https://github.com/endojs/endo-but-for-bots/issues/1027)
is the alignment point for the shared contracts and adapter ownership, and for
the later `@endo/exo-npm-registry` rename.
It is not a formal explicit-Kris-approval gate for ordinary implementation
work, and neither the broker nor the confined backend waits on the rename.
The order in which the broker serves artifacts remains open: metadata and
tarballs from the daemon CAS alone, or a narrow authorized upstream refill for
versions the CAS has not yet seen. The refill path, if any, is registry-adapter
authority, not broker authority.
The confined backend must select and test exact npm, pnpm, and Yarn versions
rather than treating #948's portable version branches as support claims.
Provider choice beyond the initial DuckDuckGo adapter and deployment-specific
registry origin sets remain explicit daemon policy.
The confined implementation must encode `broker-only` in the immutable handle
specification, creating a separate lazy incarnation from `none` and broad
public project networking until the current interface gains proven per-spawn
attenuation. It must also decide whether to reuse the #971 9P projection for
foreign filesystem grants or directly mount daemon `EndoMount` capabilities;
it must not commit to a new filesystem protocol before that comparison.

## Prompt

> Refresh the code-mode capability roadmap as the current plan of record.
> Distinguish what has landed, what is open in #948, #950, #958, and #965, and
> what has no implementation pull request.
> Complete independently granted workspace, Git, safe package-manager, and
> mediated Web capabilities through generic daemon formulas and trusted grant
> provisioning, with endo-pi as one acceptance surface rather than the
> architecture.
> Give public-address semantics, DNS-pinned HTTP, WebResearch, daemon
> composition, safe-install enforcement, restart, bounds, credentials, and
> acceptance concrete package owners and stop conditions.
> Keep the sandbox as the optional backend described separately in #953.

## Revision Prompt (2026-08-16)

> Scope zero-grant and confinement claims so `piTools: 'preserve'` remains a
> developer-only harness aid. State which guarantees come from the Exo facade,
> which rely on a trusted host development backend, and which require a
> conformance-qualified `@endo/sandbox` backend. Track landed, open, and
> unposted implementation work with checked and unchecked items. Separate
> interrupted process liveness from external effect outcome. Choose the
> strongest practical network plan rather than CONNECT alone, and retain the
> retired Genie implementation only as salvage or reference material.

## Revision Prompt (2026-08-17)

> Reconcile the plan with the live named-mount and Git authority graph in #958,
> the `EndoMount` workspace correction in #961, sandbox lifecycle work in #954,
> mount hardening in #897, and the evolving Git stacks in #960, #962, #973,
> and #974. Separate grant identity from canonical backing-resource identity.
> Use lazy exact-authority sandbox incarnations rather than one ambient handle
> or every possible grant combination. Reserve durable write-ahead recording
> for mutating effects, make backend migration explicit, qualify one reference
> driver before requiring parity, and evaluate reuse of #971's 9P projection
> before inventing another filesystem bridge.

## Revision Prompt (2026-08-18)

> Make this design the package-manager plan of record while the CAS package
> substrate remains the storage and data strategy.
> Reconcile portable PR #403 and daemon-local PR #671 through issue #1027,
> propose `@endo/exo-npm-registry` as the canonical registry package, and
> separate the `@endo/npm-registry-broker` loopback projection from verified
> package-artifact storage.
> Record PR #1011 as the coordinator-only `@endo/exo-package-manager` change,
> remove the host-ambient backend plan, and make `@endo/package-manager` the
> broker-configured confined backend.
> Preserve the exact manager argv, configuration denials, frozen-install,
> capability-facet, daemon-grant, lifecycle, and acceptance analysis.
> State that issue #1027 requests alignment but is not an explicit-Kris-approval
> gate for ordinary implementation work.

## Revision Prompt (2026-08-19)

> Refresh this design around the CAS and full-npm boundary so it remains the
> product, authority, composition, and package-manager plan without duplicating
> the CAS substrate or current Endor work.
> Adopt Endor's actor-side path, which resolves verified package graphs into CAS
> and executes module entry points without the npm CLI, `node_modules`, or
> package scripts, and propose no competing resolver, Minimum Version Selection
> table, artifact fetcher, compartment assembly, or module loader.
> Keep native npm, pnpm, and Yarn semantics for sandbox development, with CAS as
> the verified artifact source, durable store, and acceleration layer rather
> than a replacement manager or a canonical installed layout.
> Record `@endo/exo-package-manager` as owning the landed facets and merged
> coordinator, `@endo/package-manager` as the confined backend, and
> `@endo/npm-registry-broker` as the operation-scoped loopback projection.
> Keep the possible `@endo/exo-npm-registry` rename as later compatibility work
> that blocks neither, hold PR #950 until a working end-to-end backend, update
> every PR #1011 reference from open to merged, and keep the security boundary
> concise.
