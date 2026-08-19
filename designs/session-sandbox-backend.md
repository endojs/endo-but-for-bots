# Session Sandbox Execution Backend

|               |                                                                                                                                                                                                                                                    |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Created**   | 2026-08-06                                                                                                                                                                                                                                         |
| **Updated**   | 2026-08-19                                                                                                                                                                                                                                         |
| **Author**    | 0xpatrickdev (prompted)                                                                                                                                                                                                                             |
| **Status**    | Proposed                                                                                                                                                                                                                                           |
| **Builds on** | [session-execution-capabilities](session-execution-capabilities.md), [endo-posix-sandbox](endo-posix-sandbox.md), [endo-fs-backend-seam](endo-fs-backend-seam.md), [daemon-mount-capabilities](daemon-mount-capabilities.md), and [daemon-git-remotes](daemon-git-remotes.md) |

## Summary

The base code-mode design defines a durable authority graph containing
independent mount, Git, Git-remote, package-manager, Web, and project-execution
grants. This design adds an optional confined native-process backend without
turning a sandbox, container, driver, or rootfs into public capability identity.

One daemon-private backend owner lazily creates sandbox incarnations for the
exact authority an operation needs. An incarnation is keyed by its selected
mount grants and modes, rootfs or toolchain profile, network posture, limits,
and policy version. No incarnation automatically receives every mount in the
session, and the owner does not pre-create every possible grant combination.

The backend is the planned production boundary for native Git and
package-manager/project processes that consume untrusted workspace content.
For package management, it is only the enforcement and adapter layer: it
consumes the operation-scoped generated broker configuration and selected mount
specified by the [session-execution-capabilities](session-execution-capabilities.md)
base design. It does not make the
portable Exo facades, trusted-host development backend, or daemon-owned Web
research depend on sandbox availability.

Enforcement-only does not mean semantics-free. The concrete confined
`@endo/package-manager` backend is the runner half of the coordinator merged
into `@endo/exo-package-manager`, and it runs a real pinned npm, pnpm, or Yarn
executable. The manager keeps its own lockfile rules, workspace protocols,
peer-dependency resolution, manager-specific `node_modules` or store layout,
`.bin` lookup, shell and process behavior, environment, and package-script
semantics. This design therefore has to describe a sandbox that a real manager
process can actually run inside, because `pnpm run test` on a foreign
repository is the workflow it exists to support. Endor's actor-side `run` path
is module-graph execution over CAS compartments; it is a different plane, not a
replacement for package scripts, and this design proposes nothing on it.

The first implementation should qualify one reference driver and the profiles
it actually supports. Other drivers become available only after passing the
same profile-specific conformance suite. Initial delivery does not require
bwrap and Podman to reach parity at the same time.

## Scope

This design covers:

- a versioned private binding from durable grants to ephemeral sandbox
  incarnations;
- least-authority mount projection for compatibility and named mount grants;
- sandbox-backed local and remote Git;
- workload-specific broker-only networking for Git and package management;
- separately granted broad public networking for project-selected code;
- operation-scoped Git credential descriptors;
- an enforcement adapter for the package-manager and project-execution backend;
- the native-manager compatibility profile that adapter needs, covering the
  pinned toolchain, writable paths, process environment, and declared resource
  envelope for install and for explicitly granted script operations;
- bounded process lifecycle, cancellation, output, and orphan cleanup;
- restart interruption and conservative mutating-effect reconciliation; and
- driver- and profile-specific conformance tests.

It does not expose `SandboxFactory`, `SandboxHandle`, driver names, rootfs paths,
host paths, broker endpoints, process handles, or secret descriptors to the
guest. It does not make proxy environment variables a security boundary,
promise that arbitrary scripts are reconcilable, or silently fall back to host
execution.

It also owns no part of the package data path. Packument synthesis, version
resolution, artifact identity and verification, tarball extraction, persistent
CAS, install-graph records, direct materialization, action caching, and
registry-contract convergence belong to the base design, to
`@endo/npm-registry-broker`, and to the merged
[CAS package substrate architecture](https://github.com/0xpatrickdev/garden/blob/4998506899/designs/draft/cas-git-package-substrate.md).
This design decides only what the confined process may touch and reach.

## Verified Current State

This state was refreshed on 2026-08-19 against `llm` commit
`c6b70e8fdb98d4bbfc72e7e0d655f942134eaa50`, the refreshed stacked base, and the
live pull-request heads. Most of the surfaces this design waited on have since
merged, so the ledger below records what remains rather than what is queued.

| Surface | Current state and consequence |
| ------- | ----------------------------- |
| `@endo/sandbox` | `SandboxFactory.make(spec)` and `SandboxHandle.spawn(argv, opts)` exist with bwrap and Podman driver seams, mount-capability inputs, passable byte streams, and an implemented `network: 'none'` posture. Networking is selected per handle, not per spawn. |
| Package-manager coordinator | [#1011](https://github.com/endojs/endo-but-for-bots/pull/1011) **merged** on 2026-08-19 and placed the reusable coordinator in `@endo/exo-package-manager`. It supplies the fixed argv, snapshot revalidation immediately before execution, generated-configuration handoff, bounds, cancellation, exact-version evidence, and structured results. It defines the `PackageManagerRunner` seam this backend implements, and owns no process and no network. |
| Package-manager integration | The refreshed base design owns the portable facets, the merged coordinator's placement, generated operation configuration, `@endo/npm-registry-broker`, verified package-artifact substrate, and grant policy. This backend adds the confined runner that enforces the selected mount, pinned toolchain, native-manager compatibility profile, process bounds, and named-broker network profile. |
| Package-manager projection | [#950](https://github.com/endojs/endo-but-for-bots/pull/950), head `f0bf013a800b5081484815843318696983883cd2`, is an open draft that is **intentionally held**. The maintainer keeps the `@endo/agent-tools` projection unposted until this backend and the broker complete one representative operation end to end, so no projected tool advertises authority no backend can satisfy. |
| Network enforcement | Bwrap does not yet wire the documented private-egress namespace and filter path; `spec.network === 'private'` still records a teardown placeholder rather than a pasta and nftables handshake. Podman private filtering remains operator-owned. Bwrap also does not load the default seccomp profile. Only `network: 'none'` has the present implementation evidence needed here. |
| Existing loopback profile | The shipped `host-loopback` profile shares the host network namespace so that only loopback is reachable. That is not `package-broker-only`: it exposes every service listening on host loopback, including the daemon itself. A broker profile must reach exactly one named endpoint. |
| Driver selection | The current automatic factory path selects a registered driver; it does not mean “probe every driver and choose the first conforming implementation.” A durable binding must record a concrete driver selected by explicit probing or track the factory change that supplies that behavior. |
| Lifecycle work | [#954](https://github.com/endojs/endo-but-for-bots/pull/954) **merged** on 2026-08-18. It serializes spawn and disposal, bounds captured output, labels operation containers, and reconciles exact-owner orphans. It is the first implementation cut for this design, not a complete confined backend. |
| Authority graph | [#958](https://github.com/endojs/endo-but-for-bots/pull/958) **merged** on 2026-08-18 with multiple named mount and Git grants, canonical-root persistence, and retained reconstruction; [#965](https://github.com/endojs/endo-but-for-bots/pull/965) **merged** on 2026-08-19 and converged live endowments, checked declarations, prompts, and retained provisioning on locally trusted grant minters. [#1021](https://github.com/endojs/endo-but-for-bots/pull/1021) is the open stacked draft that provisions named startup grants; package-manager grants extend that path rather than adding a second one. |
| Workspace surface | [#961](https://github.com/endojs/endo-but-for-bots/pull/961) **merged** on 2026-08-17 and aligned code-mode workspace with the daemon `EndoMount`, keeping extended `Filesystem` as a separate local seam. It is reconciled with #958's named-mount projection on `llm`, so this backend can bind to the `EndoMount` contract. |
| Mount containment | [#897](https://github.com/endojs/endo-but-for-bots/pull/897), head `dc6834e475cfa2e75c15581a491d8255e828c1db`, is still open and still carries symlink-deny and mid-walk revocation hardening. The Exo facade prevents public API escalation but does not make these backend path checks unnecessary. |
| Adjacent mount projection | [#971](https://github.com/endojs/endo-but-for-bots/pull/971) merged capability-first 9P projection under `/mnt/` on the separate `feat/hosted-endo-management` feature stack, not on `llm`. It removes a host-path fast path and recreates a slice when its mount set changes. It is useful prior art whose reuse is still an open implementation decision. |
| Git evolution | [#960](https://github.com/endojs/endo-but-for-bots/pull/960) linked worktree operations, [#962](https://github.com/endojs/endo-but-for-bots/pull/962) bounded status copy data and tracking, [#974](https://github.com/endojs/endo-but-for-bots/pull/974) worktree-relative path designators, and [#973](https://github.com/endojs/endo-but-for-bots/pull/973) bounded network-sourced remote results and audit fields all **merged** between 2026-08-17 and 2026-08-18. The public Git surface is settled, so a sandbox backend must implement or explicitly exclude each of those methods rather than wait. |
| Recovery | Merged #973 bounds the network-sourced fields of `GitRemote` audit records, which remain post-result evidence. They are not write-ahead mutating-effect receipts, liveness state, or restart reconciliation. [#1010](https://github.com/endojs/endo-but-for-bots/pull/1010) **merged** on 2026-08-18 and settled context cancellation cleanup, but it does not add that durable record. |

## Assurance Levels

Claims use the same three levels as the base design.

1. **Portable Exo facade.** Guards, attenuation, fixed operation shapes, mount
   selectors, Git policy, bounded copy results, and cancellation prevent callers
   from invoking authority that the received facet does not advertise. They do
   not control what a native process does after spawn.
2. **Trusted host development.** Fixed argv, generated configuration, sanitized
   environment, cooperative cancellation, and bounded output are useful for
   trusted workspaces. They do not establish kernel-enforced containment
   against hostile package configuration or repository contents.
3. **Conformance-qualified confined backend.** A specific driver, rootfs, and
   profile pass adversarial filesystem, process, secret, network, and cleanup
   tests. Only this level supports hostile-workspace path, broker-bypass,
   child-process, or orphan-prevention claims.

`piTools: 'preserve'` remains a development-only harness posture. Retained Pi
tools may carry ambient authority outside the Endo grant graph, so no
whole-session confinement result is derived from a preserved run.

## Architecture

```mermaid
flowchart TD
    G[durable authority graph] --> M1[mount grant A]
    G --> M2[mount grant B]
    G --> Git[named Git grant selects mount and path]
    G --> PM[package or project grant selects mount and directory]
    G --> B[private backend binding]
    B --> O[backend owner]
    O --> H1[exact-authority incarnation: no network]
    O --> H2[exact-authority incarnation: Git broker only]
    O --> H3[exact-authority incarnation: package broker only]
    M1 --> H1
    M1 --> H2
    M2 --> H3
    Git --> H2
    PM --> H3
    O --> L[mutation coordinator keyed by canonical resource]
```

The durable graph identifies authority. The private binding selects one
implementation of that authority. Handles, namespaces, containers, bridges,
brokers, sockets, and child processes remain ephemeral.

## Durable Binding and Migration

The daemon records a host-private backend binding containing only versioned,
non-secret reconstruction inputs:

| Field | Meaning |
| ----- | ------- |
| `sandboxFactoryId` | Formula that reconstructs the factory. |
| `backend` | Concrete driver selected after the required probes pass. `auto` is not persisted. |
| `rootfsProfile` | Immutable rootfs mount or digest-pinned image plus a declared toolchain profile. |
| `mountGrantIds` | Authority ceiling from which an operation may select mounts. This is not a directive to mount all of them together. |
| `networkProfiles` | Versioned profiles this binding has qualified, initially `none` and any workload-specific broker profiles. |
| `operationProfiles` | Per-operation-kind compatibility profiles and resource envelopes this binding advertises, such as frozen install and granted script execution. An unadvertised envelope is not silently widened. |
| `limits`, `envPolicy`, `policyVersion` | Normalized process and compatibility policy. |

Restart may reconstruct an incarnation under the same pinned driver, rootfs,
policy, and exact authority. Changing driver, rootfs, mount-projection protocol,
network enforcement, or another assurance-relevant input is an explicit
migration. It mints a new grant identity unless conformance establishes
behaviorally equivalent authority and the migration records that proof.

The public capability never promises transparent migration across materially
different enforcement behavior.

## Exact-Authority Incarnation Pool

One daemon-private owner coordinates a lazy pool. A normalized incarnation key
contains:

- the ordered selected mount grant IDs, modes, and inner roots;
- the rootfs or toolchain profile;
- one network posture;
- resource limits and seccomp policy; and
- the backend policy version.

An operation borrows the least-authority matching incarnation. The owner may
reuse, idle, or evict an incarnation without changing durable grant identity.
It does not instantiate the Cartesian product of all session grants.

Exactly one owner controls each live handle. Borrowers can cancel their own
leases but cannot dispose the handle. Admission, spawn registration, disposal,
and orphan cleanup are serialized so either spawn is registered before dispose
observes it or spawn fails before crossing the driver boundary.

Different incarnations may project aliases or overlapping subroots of the same
physical resource. Mutation locks and mutating-effect records therefore use
canonical backing-resource identity plus selected relative root, not guest pet
name, grant name, handle ID, or sandbox path.

## Mount Projection

The compatibility mount named `workspace` maps to `/workspace`. Other selected
named mounts map to deterministic `/mnt/<name>` roots after pet-name validation
and collision checks. A handle receives only the mounts selected for the
operation. Read-only posture is enforced by the driver projection, not merely
by omitting Exo mutation methods.

A named Git grant derives its inner repository root from:

```text
selected mount inner root + validated mount-relative path segments
```

Package-manager and project-execution grants use the same selection rule for
their working directory. No adapter accepts a host path or independently
rediscovers a workspace.

The guest-visible workspace and named-mount capabilities are daemon
`EndoMount`s, reconciled on `llm` by merged #958 and #961. An extended
`Filesystem` may be derived locally where an adapter needs that interface, but
this backend does not redefine mount globals as a different capability type.

### Projection implementation decision

This design specifies containment properties, not a new filesystem protocol.
Implementation must compare these paths before choosing one:

1. directly project daemon `EndoMount` capabilities through an existing sandbox
   driver seam; or
2. reuse or extract #971's capability-first 9P projection for foreign
   filesystem grants, including slice recreation when the selected mount set
   changes.

A new CBOR `FsBackend` bridge is not the default. It is considered only if both
reuse paths fail a documented requirement, and then receives its own protocol,
bounds, lifecycle, compatibility, and race review.

Every selected approach must prove read-only enforcement, path-segment
validation, symlink-race resistance, cross-mount denial, revocation during
walks, and absence of a host-path fast path. #897 or equivalent hardening is a
prerequisite for the corresponding portable-containment claims.

## Network Postures

Networking is immutable for the lifetime of the current `SandboxHandle`.
Therefore the following are distinct incarnation keys until a proven per-spawn
attenuation contract exists:

- `none`: no network namespace reachability;
- `package-broker-only`: reach only the operation's named
  `@endo/npm-registry-broker` endpoint;
- `git-broker-only`: reach only the selected exact-origin Git mediator; and
- `public-project`: filtered public egress for explicitly granted project code.

Package-manager and Git operations never borrow `public-project` merely because
that handle already exists. Broker-only profiles are kernel-enforced: the child
may reach its named sidecar, socket, or isolated endpoint and cannot open a
direct public, private, host-service, metadata, DNS, or alternate-proxy
connection. The shipped `host-loopback` profile does not satisfy
`package-broker-only`, because sharing the host loopback namespace reaches every
locally listening service rather than one named endpoint. A qualifying
implementation gives the operation its own namespace and admits exactly the
broker socket, whether that is a unix socket projected into the namespace or an
isolated address reachable only from it. The package broker and verified
package-artifact substrate are injected dependencies owned by the base design;
this backend neither defines their protocol or records nor synthesizes registry
metadata, resolves packages, stores artifacts, or materializes a CAS.

DNS filtering is transport enforcement, not origin authorization. A driver may
classify answers and constrain packet destinations, but it cannot inspect HTTPS
redirects inside an opaque TLS tunnel. HTTP redirects remain the responsibility
of an HTTP-aware broker. Git either rejects them or establishes a fresh tunnel
for a destination independently authorized by the Git grant.

The first production cut qualifies one reference driver for each advertised
profile. Bwrap must own its namespace and filtering path. Podman must install
and verify equivalent per-container policy before advertising that profile;
operator configuration alone is insufficient. A driver that cannot prove a
requested profile fails closed.

## Sandbox-Backed Git

The sandbox Git adapter implements the public `GitBackend` methods that have
landed when the backend is advertised. Merged #960, #962, #973, and #974 settled
that method set and its bounded result shapes, so the adapter implements or
explicitly excludes each of them rather than waiting on their stacks. Silent
host fallback is forbidden.

Every Git grant names a selected mount and relative repository root. Every
`GitRemote` must select a named Git grant. The current compatibility behavior
that attaches remotes only to the root `git` binding is a tracked gap, not the
multi-grant design.

The adapter receives a borrower, the selected inner root, retained repository
identity, normalized remote policy, and fixed Git executable from its rootfs
profile. It does not import ambient host `child_process`, filesystem, path, or
process powers.

Fixed Git configuration disables or bounds hooks, helpers, fsmonitor, external
attributes, filters, signing, pagers, editors, prompts, URL rewriting,
submodules, alternate protocols, and executable configuration. Repository
identity checks occur before mutation and after restart. Linked-worktree and
worktree-relative operations use the same selected mount ceiling rather than
resolving host paths.

### Operation-scoped credentials

The first credential need is Git HTTPS. The initial driver primitive should be
narrow enough to prove that use case before becoming a general arbitrary-secret
spawn API.

A credential is delivered through a one-shot anonymous descriptor only after
endpoint, direction, refspec, and credential-version authorization. Secret
bytes never enter argv, environment values, configuration, a mount, formula,
result, audit record, log, or model context.

The fixed launcher closes unrelated descriptors, becomes non-dumpable where the
platform supports it, acknowledges readiness, reads one bounded role-tagged
frame, and disables fallback prompting. Cancellation, revocation, timeout, and
restart close the descriptor, kill and reap Git, and discard unused bytes.

If a driver cannot preserve and isolate the descriptor from unrelated session
processes, credentialed Git is unavailable on that driver. There is no secret
file or persistent environment fallback.

## Package Management and Project Execution

The public reader, installer, and executor facets, their cumulative authority,
and the backend-independent coordinator contract belong to the
[session-execution-capabilities](session-execution-capabilities.md) base design.
That design also assigns package-artifact production, registry resolution,
broker protocol, durable policy, and grant provisioning to their respective
owners. This design does not restate those contracts.

The confined adapter accepts one coordinator-produced operation at a time with
these enforcement inputs:

- the selected mount grant and validated mount-relative working directory;
- the immutable rootfs and pinned toolchain profile;
- operation-scoped generated broker configuration naming the selected
  `@endo/npm-registry-broker` endpoint; and
- process bounds, sanitized environment policy, deadline, and cancellation.

The generated configuration is ephemeral operation input, not user or project
configuration. The adapter accepts no shell fragment, host path, unvalidated
working directory, ambient package-manager configuration, or opaque extra
process arguments. It does not synthesize npm metadata or packuments, resolve
packages, store tarballs or CAS records, choose portable manager arguments,
materialize artifacts, or decide daemon grants.

Frozen installation and any package operation that needs package transport use
`package-broker-only`. Named scripts, lifecycle hooks, package binaries, tests,
builds, and generators require the executor or project-execution grant and use
`none` unless broad public networking is independently granted. The selected
mount and profile are enforcement inputs; package semantics remain in the
coordinator and injected substrate.

### Composition with the merged coordinator

The coordinator merged in #1011 is the portable half of the operation and this
backend is the confined half. The coordinator selects the manager, builds fixed
argv, revalidates the workspace snapshot as its final act before execution,
obtains the generated configuration, and shapes the structured result. It then
calls a single injected runner method with the operation kind, manager name,
requested manager version, revalidated target, fixed argument list, optional
generated configuration, output-byte cap, deadline, and operation identifier.
The runner returns termination kind, exit code, signal, bounded output,
truncation flags, the manager version it actually established, and an explicit
cleanup confirmation. A separate cancel method takes the operation identifier.

Three consequences follow for this design, and they are contract obligations
rather than stylistic choices:

- **The runner resolves the executable.** The coordinator hands over a manager
  name and the arguments after it, never a path. Mapping `npm`, `pnpm`, or
  `yarn` to a concrete binary is the confined backend's job, and it resolves
  that name only inside the pinned rootfs and toolchain profile, never through
  an inherited `PATH`, a corepack download, a project `yarnPath` or
  `packageManager` download request, or any other runtime acquisition.
- **The runner must prove the exact version.** The coordinator rejects the
  operation when the reported manager version does not equal the requested one,
  so the profile has to establish and report a pinned version rather than
  accept whatever the image happens to contain.
- **The runner must confirm complete cleanup.** An operation whose runner
  cannot confirm that it terminated and reaped its process group is a failure,
  not a success with a warning. This is the same one-path kill-and-reap
  invariant described under process lifecycle, surfaced in the result.

The backend adds no second argv builder, no second snapshot check, no second
cancellation model, and no second result shape.

### Native manager compatibility profile

A frozen install and a granted `pnpm run test` are ordinary POSIX process
workloads. The confined profile has to be habitable for them, or the manager
fails in ways that look like policy but are really missing substrate. The
package profile therefore declares:

| Requirement | Why the native manager needs it |
| ----------- | ------------------------------- |
| A writable workspace subtree at the selected mount-relative working directory | The manager writes its own `node_modules`, virtual store links, and lockfile-adjacent state there. That layout is the manager's projection, never canonical dependency state. |
| A writable manager store, cache, scratch `HOME`, and `TMPDIR` outside the workspace | npm, pnpm, and Yarn all write outside the project. Leaving these unset makes the manager fall back to ambient host paths, which the profile must not expose. Whether the store is scoped per operation, per grant, or per binding is an open question below; the scratch `HOME` and `TMPDIR` are always per operation. |
| Store and workspace on one projected filesystem where the manager links rather than copies | pnpm's default linker hardlinks from its store into `node_modules`. A cross-device projection silently degrades to copying. A writable hardlink from a workspace into shared verified content stays prohibited, so the store is a writable projection the session owns, never the CAS itself. |
| A real shell and the pinned Node runtime in the rootfs | Package scripts are shell commands. `run` is not an argv-only path, and a rootfs without `sh` cannot run `pnpm run test` at all. |
| `.bin` resolution left to the manager | The manager prepends `node_modules/.bin` to the child environment itself. The sanitized fixed environment supplies the pinned toolchain entries and must not strip or rewrite what the manager adds. |
| Child process creation, process groups, and signal delivery | Test runners fork workers. A seccomp or resource policy that forbids `fork`/`exec` forbids the workload; a process-count cap is the correct bound instead. |
| A declared resource envelope: CPU, memory, scratch, process count, and wall-clock deadline | Installs and test suites are resource-heavy, and the deadline and output cap the coordinator passes are only two of the bounds an operation needs. |

The profile is declared per operation kind, not per session. An operation that
requests an envelope the selected profile does not advertise fails closed. The
backend never widens a profile to make a workload succeed.

### Install and granted-script operations

Install-time lifecycle scripts remain disabled by default, and the merged
coordinator enforces that directly: an install that does not declare disabled
lifecycle scripts is rejected before any argv is built. This design adds the
enforcement that makes the rejection meaningful, since a manager that could
reach an ambient configuration file could re-enable hooks below the portable
facade.

Explicitly granted test, build, or lifecycle commands are separate bounded
operations through the executor or project-execution grant. Each such operation
uses the sandbox powers and resource envelope declared for it, and native
toolchains are available only when the selected rootfs profile grants them. A
package that needs a compiler, `node-gyp`, or a native addon build runs only
under a profile that advertises those tools; under a profile that does not, the
operation fails closed rather than silently producing a partial tree. Which
build results are worth retaining, and how they are keyed, is action-cache and
provenance work owned by the CAS substrate architecture, not by this design.

Named scripts run with `network: 'none'` unless broader network authority is
independently granted for that operation. The executor grant is authority to
run a declared script, not authority to reach the network.

### Worked path: `pnpm run test`

The representative development workflow this backend has to support end to end
is: open a foreign repository through a mount grant, hydrate dependencies, and
run its own test script.

- The reader facet detects `pnpm` from the workspace snapshot.
- The installer facet requests a frozen install. The coordinator refuses
  without a `pnpm-lock.yaml`, builds `pnpm install --frozen-lockfile
  --ignore-scripts`, and hands the runner the arguments after `pnpm`.
- The confined runner borrows a `package-broker-only` incarnation carrying only
  the selected mount, writes the generated configuration where only this
  operation can read it, and runs the pinned pnpm from the rootfs profile. The
  manager resolves the lockfile, fetches every tarball from the named broker,
  and writes its own store and `node_modules` layout.
- The executor facet requests the `test` script. The coordinator confirms the
  script is still declared in the revalidated snapshot, builds `pnpm run test`,
  and hands over the arguments after `pnpm`.
- The confined runner borrows a `none`-network incarnation with the same
  selected mount, the writable workspace, the script resource envelope, and the
  pinned shell and Node runtime, then runs the script and reaps its whole
  process group.

The same sequence with `npm ci --ignore-scripts` plus `npm run test`, or with
the Yarn install profiles the portable layer selects, must work on the same
qualified driver before the profile is advertised. Endor's actor-side `run`
executes a module graph from CAS compartments and answers a different question;
it neither runs this repository's `test` script nor removes the need for this
path.

### Generated configuration and bypass denial

The coordinator supplies at most one generated configuration record per
operation, carrying the manager it was generated for, a manager-appropriate
format, and opaque bytes, and it rejects a record generated for a different
manager. This backend places those bytes where the manager will read them and
nowhere else: a per-operation path inside the incarnation, readable by the
operation and destroyed with it.

The configuration names the operation's `@endo/npm-registry-broker` endpoint and
nothing else. It is not a user or project configuration file, it is never
written into the selected mount, and it never persists across operations. The
profile denies every ambient and project-supplied configuration source that
could redirect the manager: inherited home and user configuration, project
`.npmrc`, `.yarnrc.yml`, `.pnpmfile.cjs`, plugins, hooks, `yarnPath`,
environment-file injection, and manager or runtime download requests.

Configuration is a compatibility mechanism, not the boundary. Proxy and
registry settings tell a cooperative manager where to go; they do not stop an
uncooperative one. The boundary is the `package-broker-only` posture, and the
package profile is advertised only when driver-owned probes show, from inside a
live incarnation, both halves of the claim:

- a positive connection to the operation's named broker endpoint succeeds; and
- direct connections fail closed for the public registry and its CDN, any
  alternate proxy or CONNECT endpoint, arbitrary DNS resolvers, the cloud
  metadata service address, private and link-local ranges, host loopback
  services other than the named broker, and any host-side socket the incarnation
  did not receive.

A driver that cannot demonstrate both halves does not advertise the package
profile, and an operation that requests it fails rather than degrading to a
weaker posture.

If the confined backend is unavailable after restart, executor and project-code
operations remain unavailable. They never fall back to ambient execution,
host-shell, exo-shell, or the trusted-host installer.

## Process Lifecycle and Bounds

All sandbox consumers share these invariants:

- the argv the backend spawns is a fixed executable from the pinned profile plus
  validated operation arguments, never a caller-supplied shell command; a
  package manager that runs a declared script through a shell does so inside the
  incarnation, below this boundary, and that is why script execution needs its
  own grant and envelope;
- stdin is closed or a specifically granted bounded reader;
- stdout and stderr remain separate `PassableBytesReader` capabilities;
- byte caps are enforced before decoding, and overflow kills before waiting for
  EOF;
- drain and graceful-termination windows are bounded before hard-kill and reap;
- cancellation, timeout, revocation, disposal, and shutdown use one idempotent
  kill-and-reap path; and
- diagnostics redact host paths, endpoint userinfo, secret descriptors, and
  secret material.

Bwrap uses parent-death and process-group containment. Podman labels every
container with exact backend-binding and operation identities. Startup removes
only exact-owner orphans and never sweeps unrelated containers. Merged #954 is
the first lifecycle cut this backend builds on, and the runner reports its
cleanup result to the coordinator rather than assuming it.

## Restart and Effect Outcomes

Restart preserves durable grants, canonical mount and backing-resource
identities, normalized policy, rootfs profile, backend binding, and any bounded
mutating-effect records. It preserves no namespace, container, handle, broker,
child, stream, descriptor, credential bytes, or pending promise.

Startup:

1. reconciles exact-owner orphan processes and containers;
2. marks formerly live operations `interrupted` with reason `daemon-restart`;
3. reconstructs dependencies and reruns the selected profile's required probes;
4. admits new operations only after a matching incarnation is ready; and
5. never automatically replays an interrupted operation.

Process liveness and effect outcome are separate. A durable mutating operation
may reconcile as `no-effect`, `completed`, or `indeterminate`. Git may compare
remote refs. Installation may inspect lockfile and workspace state. Arbitrary
scripts, builds, or tests commonly remain `indeterminate`; the backend does not
promise rollback or distributed transactions.

Durable write-ahead recording is required only for operations that may mutate
durable workspace or external state. Web fetch and search plus Git status and
inspection use bounded receipts and reject as interrupted after restart unless
a consumer explicitly requested retention. Git fetch is mutating because it
updates repository objects and refs. Existing GitRemote audit records are
post-result evidence only; merged #973 bounds their network-sourced fields.

The caller decides whether to retry. Retained records contain non-secret
operation kind, policy and grant identifiers, canonical resource identity,
timestamps, liveness, outcome, and reconciliation metadata. They contain no
response bodies, output streams, credentials, or live handles.

## Dependency-Ordered Work

The checklist is the implementation ledger. An unchecked item without a linked
pull request is unposted work.

### Landed foundations

- [x] Sandbox factory, handle, bwrap and Podman driver seams, mount-capability
  inputs, passable process streams, and `network: 'none'`. Owner:
  `@endo/sandbox`. Tracking: [endo-posix-sandbox](endo-posix-sandbox.md).
- [x] Backend-independent Git and package-manager facades. Owners:
  `@endo/exo-git` and `@endo/exo-package-manager`. Tracking: landed Git work and
  merged #948.
- [x] Reusable package-manager coordinator. Owner: `@endo/exo-package-manager`.
  Tracking: #1011, merged 2026-08-19. It supplies the runner seam, fixed argv,
  pre-execution revalidation, configuration handoff, bounds, cancellation, and
  result shapes this backend composes rather than reimplements.
- [x] Bounded sandbox lifecycle ownership. Owner: `@endo/sandbox`. Tracking:
  #954, merged 2026-08-18. Serialized spawn and dispose, output caps,
  exact-owner labels, operation containers, and orphan reconciliation are
  present; later network profiles are not.
- [x] Named authority graph and unified grant provisioning. Owners:
  `@endo/agentry` and daemon. Tracking: #958 and #965, merged 2026-08-18 and
  2026-08-19. Multiple named mount and Git grants reconstruct across restart.
- [x] Guest-visible mount types. Owners: `@endo/agent-tools`, `@endo/agentry`,
  and daemon. Tracking: #961, merged 2026-08-17 and reconciled with #958 on
  `llm`. Compatibility and named mount declarations expose the daemon
  `EndoMount` contract, so this backend binds to that type.
- [x] Public Git surface. Owners: `@endo/exo-git` and `packages/git`. Tracking:
  #960, #962, #973, and #974, merged 2026-08-17 through 2026-08-18. The method
  set and bounded result shapes are settled, so an advertised sandbox backend
  implements or explicitly excludes each of them.
- [x] Daemon cancellation cleanup. Owner: daemon. Tracking: #1010, merged
  2026-08-18. Graceful cancellation no longer strands owner cleanup hooks. It
  does not replace durable mutating-effect records.
- [x] Revised durable authority and assurance contract. Owner:
  [session-execution-capabilities](session-execution-capabilities.md). Done:
  multiple mount and Git grants, exact-authority incarnations, mutating-effect
  record scope, explicit backend migration, and scoped confinement claims are
  the stacked base.

### Open pull requests

- [ ] Close portable mount containment gaps. Owner: daemon mount. Tracking:
  #897. Done when symlink-deny and mid-walk revocation tests land.
- [ ] Extend named grant provisioning to startup-selected grants. Owners:
  `@endo/agentry` and daemon. Tracking: #1021, stacked on merged #965. Done when
  package-manager and project-execution grants provision through that path
  instead of a second one.
- [ ] Hold the `@endo/agent-tools` package-manager projection. Owner:
  `@endo/agent-tools`. Tracking: #950, deliberately unposted. Released when this
  backend and the broker complete one representative install plus granted-script
  operation end to end, so no projected tool advertises authority no backend can
  satisfy.

### Unposted implementation work

- [ ] Define the versioned private backend binding and explicit migration rule.
  Done when `auto` cannot be persisted, a concrete probed driver is recorded,
  and assurance-relevant changes cannot silently preserve grant identity.
- [ ] Implement the lazy exact-authority incarnation pool over merged #954.
  Done when mount sets and network postures are part of normalized keys,
  borrowers cannot dispose handles, and aliases coordinate by canonical
  resource identity.
- [ ] Decide and implement mount projection over the merged #958 and #961 mount
  types. Dependency: #897. Done when direct `EndoMount` projection and
  extraction of #971's 9P path are compared, the selected approach has no
  host-path fast path, and any new protocol requires a separate reviewed
  justification.
- [ ] Add `package-broker-only` and `git-broker-only` to one reference driver.
  The package profile consumes an operation-scoped generated configuration and
  a named `@endo/npm-registry-broker` endpoint supplied by the package-manager
  stack. Done when packet-level probes prove the child reaches its named
  mediator and nothing else, and when the existing `host-loopback` profile is
  explicitly rejected as a substitute.
- [ ] Define and implement the native-manager compatibility profile. Done when
  a pinned npm, pnpm, and Yarn each resolve only from the rootfs profile and
  report the requested version, the workspace subtree is writable, the manager
  store, cache, scratch `HOME`, and `TMPDIR` are per-operation and outside the
  workspace, store-to-workspace linking does not silently degrade across a
  device boundary, and a declared script can start a shell, spawn children, and
  be reaped as a group.
- [ ] Declare per-operation resource envelopes. Done when install and granted
  script operations each declare CPU, memory, scratch, process-count, and
  wall-clock bounds; an operation requesting an envelope the selected profile
  does not advertise fails closed; and native build tools are present only under
  a profile that grants them.
- [ ] Qualify additional drivers independently. Dependency: a reference
  profile. Done per driver and profile; parity does not block first delivery.
- [ ] Add the narrow operation-scoped Git credential descriptor primitive.
  Done when concurrent-process, process-inspection, cancellation, redaction,
  and restart probes find no disclosure or fallback.
- [ ] Implement sandbox Git over selected mount grants. Dependencies: the
  authority graph, mount projection, Git surface reconciliation, and network
  profiles. Done when local and remote methods use fixed policy and no host
  process or path power.
- [ ] Let every named Git remote select a named Git grant over the merged #958
  graph. Done when compatibility root `git` is unnecessary for named-only
  sessions.
- [ ] Implement the package-manager and project-execution enforcement adapters
  as the merged coordinator's runner. Dependencies: merged #1011, the base
  design's broker contract, mount projection, lifecycle, the compatibility
  profile, and network profiles. Done when the runner resolves the manager
  executable only from the pinned profile, reports the established version and a
  complete cleanup result, honors the coordinator's deadline, output cap, and
  cancellation, and consumes only operation-scoped generated broker
  configuration, the selected mount, and independently granted network
  authority. Packument synthesis, package resolution, artifact identity and
  extraction, persistent CAS, install-graph records, materialization, action
  caching, portable manager arguments, and daemon grant policy remain outside
  this design.
- [ ] Add durable write-ahead records for mutating effects. Owner: daemon.
  Done when dispatch follows durable admission, liveness and outcome are
  separate, arbitrary execution may remain `indeterminate`, and read-only calls
  are not transactions by default.
- [ ] Add crash-point and cross-driver conformance tests. Done when every
  advertised driver and profile proves its own filesystem, lifecycle, network,
  credential, restart, and cleanup claims. Package-driver probes must include
  a positive connection to the named broker and negative direct-connection
  probes for public, private, host, metadata, DNS, and alternate-proxy paths.
- [ ] Prove one representative native operation end to end. Dependencies: the
  runner, the compatibility profile, the package network profile, and the
  broker. Done when a foreign repository is hydrated with a pinned manager
  through the broker and its own declared test script runs and reports a
  bounded result under a granted envelope. This is the gate that releases the
  held #950 projection.
- [ ] Run strict consumer-independent acceptance. Done when a session with
  selected grants can open or clone a repository, edit, install, run a bounded
  test, commit, fetch, conditionally push, restart between steps, and explicitly
  decide whether to retry one interrupted mutation without ambient Pi tools.

Mount-projection evaluation, the compatibility profile, and operation-record
schema design can proceed in parallel now that lifecycle, mount types, the
authority graph, the public Git surface, and the coordinator have landed.
Sandbox Git no longer waits on the public method set. The first production path
waits for one qualified driver, not for all drivers, and the held #950
projection waits for the end-to-end operation rather than for parity.

## Conformance Matrix

Each driver advertises only the rows and profiles it passes.

| Area | Required evidence |
| ---- | ----------------- |
| Authority | Exact selected mount set and network posture; no sibling session grant appears in the handle. |
| Lifecycle | Every spawn/dispose race is leak-free; output overflow kills before EOF; exact-owner orphan cleanup leaves unrelated processes and containers alone. |
| Filesystem | Read-only enforcement, relative-path validation, symlink-race resistance, revocation during walks, cross-mount denial, and no host-path fast path. |
| Network | `none` blocks all sockets; `package-broker-only` reaches only the operation's named `@endo/npm-registry-broker`, `git-broker-only` reaches only its selected Git mediator, and public-project blocks host, private, link-local, metadata, multicast, alternate DNS, and rebinding paths. |
| Git | Selected-grant roots, repository identity, configuration and protocol denials, bounded results, cancellation, public fetch, authenticated fetch/push, and no host fallback. |
| Credentials | No argv, environment, formula, mount, log, stream, model-context, process-inspection, or concurrent-process disclosure. |
| Package network | Driver-owned probes start the adapter with a selected mount and operation-scoped generated broker configuration, reach the named broker, and fail closed for the public registry and CDN, alternate proxies and CONNECT endpoints, arbitrary DNS resolvers, the metadata-service address, private and link-local ranges, other host loopback services, and any unreceived host socket. Ambient and project configuration cannot redirect the manager, and no ambient execution fallback exists. |
| Native manager compatibility | A pinned npm, pnpm, and Yarn each resolve only from the rootfs profile, report the requested version, hydrate a frozen lockfile through the broker, and produce the manager's own layout. Store-to-workspace linking does not silently degrade across a device boundary, and manager store, cache, scratch `HOME`, and `TMPDIR` stay per-operation and outside the workspace. |
| Granted script execution | A declared script starts a shell from the pinned profile, resolves `.bin` entries the manager added, spawns children, respects the declared CPU, memory, scratch, process-count, and deadline envelope, and is reaped as a complete process group. Install-time lifecycle scripts stay disabled, and an operation requesting an unadvertised envelope or absent native toolchain fails closed. |
| Restart | Fresh incarnation, exact-owner orphan cleanup, interrupted liveness, conservative outcome, no replay, and fail-closed unavailable dependencies. |

Strict acceptance has `piTools: 'preserve'` absent. Trusted-host tests are
reported separately and never count as confined-backend conformance.

## Alternatives Rejected

- **One session-wide handle:** it accumulates every mount and the broadest
  network authority used anywhere in the session.
- **One handle for every possible grant combination:** it creates a
  combinatorial pool before operations demonstrate a need. Lazy normalized
  incarnation keys give the same least-authority property.
- **Locking by grant or handle identity:** aliases and overlapping grants can
  refer to the same bytes. Coordination follows canonical backing-resource
  identity and relative root.
- **A new CBOR filesystem bridge by default:** it duplicates protocol,
  lifecycle, compatibility, and race-hardening work before direct mount and
  existing 9P reuse are evaluated.
- **Requiring two-driver parity before first delivery:** it delays a qualified
  reference backend and expands the initial attack surface. Every advertised
  driver still has to pass the same profile contract.
- **A general secret-spawn API before the Git case is proven:** it creates a
  broad security commitment without a second demonstrated consumer.
- **Proxy configuration as network confinement:** a hostile child can ignore
  it. Broker-only reachability is enforced outside the process.
- **Reimplementing package metadata or artifact handling here:** the adapter
  consumes the base design's operation-scoped broker configuration and
  verified package-artifact substrate. Duplicating registry resolution,
  packuments, tarball or CAS storage, install-graph records, materialization,
  action caching, or grant policy would split authority ownership and weaken the
  enforcement boundary.
- **Reproducing manager semantics instead of confining a manager:** an Endo
  reimplementation of lockfile rules, workspace protocols, peer resolution,
  linker layout, and package scripts would have to match three managers exactly
  before a session became useful. The manager keeps its semantics; this design
  bounds what it can touch and reach.
- **Treating Endor's actor-side `run` as the script path:** it executes a module
  graph from CAS compartments with no manager, no install, and no package
  scripts. It answers a different question and does not run a repository's own
  `test` script.
- **A profile stripped down until the manager breaks:** removing the shell,
  child-process creation, or writable manager paths does not produce a safer
  install, it produces a failed one. Confinement comes from the mount set,
  network posture, and declared envelope, not from an uninhabitable rootfs.
- **Widening a profile to make a workload succeed:** an operation that needs an
  unadvertised envelope or an absent native toolchain fails closed and is
  granted deliberately, never accommodated silently.
- **Stable identity across unproven backend migration:** a driver, rootfs, or
  policy change can alter authority and assurance.
- **Durable transactions for read-only calls:** cancellation and bounded
  receipts suffice unless a consumer explicitly asks for retained status.
- **Automatic replay:** native process, Git, installation, and project effects
  are not generally idempotent.

## Open Questions

Three implementation choices remain deliberately open:

1. whether direct daemon `EndoMount` projection satisfies every confined
   adapter or whether the capability-first 9P path from #971 should be
   extracted for foreign filesystem grants;
2. which driver becomes the first reference implementation for broker-only
   networking and operation-scoped credential descriptors; and
3. whether the manager store is scoped per operation, per grant, or per backend
   binding. Per-operation is the most conservative and the slowest, because a
   pnpm store loses its reuse value when it is discarded; a longer-lived store
   shared across operations of one grant needs its own poisoning and eviction
   argument before it is adopted.

None of these questions changes the durable public authority graph. All must be
settled with implementation probes before the design claims the corresponding
profiles are available.

Package-manager metadata, resolution, artifact records, broker protocol, and
grant policy are not open questions for this design. They follow the revised
[session-execution-capabilities](session-execution-capabilities.md) contract and
its referenced package-substrate work; this design only decides whether a
selected driver enforces the named broker, the selected mount, and the declared
compatibility profile and envelope.

## Prompt

> Define the optional confined execution backend over the durable code-mode
> authority graph. Keep public grants independent of sandbox identity. Use one
> private owner and lazy exact-authority incarnations keyed by selected mount
> set, rootfs, network posture, limits, and policy version. Reuse daemon
> `EndoMount` and evaluate the adjacent #971 9P path before introducing another
> filesystem protocol. Provide sandbox-backed Git, frozen installation,
> project execution, workload-specific broker-only networking,
> descriptor-scoped credentials, bounded lifecycle, conservative restart
> outcomes, and profile-specific conformance without host fallback.

## Revision Prompt (2026-08-17)

> Reconcile the backend with #954, #958, #961, #965, #897, #960, #962, #971,
> #973, #974, and #1010. Replace one canonical workspace and one live handle
> with multiple mount grants and a lazy exact-authority pool. Separate grant
> identity from canonical resource identity. Remove the presumed CBOR
> filesystem bridge, qualify one reference driver before parity, narrow secret
> descriptors to the proven Git use case, make backend migration explicit, and
> reserve durable write-ahead records for mutating effects.

## Revision Prompt (2026-08-19)

> Refresh the backend so its package-manager profile describes the full native
> manager compatibility path needed for sandbox development while keeping
> enforcement-only ownership. The confined `@endo/package-manager` backend runs
> a pinned npm, pnpm, or Yarn executable as the merged #1011 coordinator's
> runner and retains real lockfile, workspace, peer, layout, `.bin`, shell,
> environment, and package-script semantics, so `pnpm run test` works and
> Endor's actor-side `run` is not treated as a replacement. Keep install-time
> lifecycle scripts disabled by default and give explicitly granted test, build,
> or lifecycle commands a declared sandbox power set and resource envelope.
> Prove broker reachability and every bypass denial. Own no packument
> synthesis, resolution, artifact identity, extraction, persistent CAS, or
> registry convergence. Record #1011 as merged and #950 as held until a
> representative end-to-end operation passes.
