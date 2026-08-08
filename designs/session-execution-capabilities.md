# Daemon-Backed Code-Mode Capability Grants

| | |
|---|---|
| **Created** | 2026-08-06 |
| **Updated** | 2026-08-08 |
| **Author** | 0xpatrickdev (prompted) |
| **Status** | Proposed |
| **Builds on** | [daemon-mount-capabilities](daemon-mount-capabilities.md), [daemon-git-capability](daemon-git-capability.md), [daemon-git-remotes](daemon-git-remotes.md), [endo-agent-tools](endo-agent-tools.md), and [endo-fetch](endo-fetch.md) |

## Summary

Daemon-backed code mode is present on `llm`.
It can retain a guest across daemon restarts and grant workspace and Git
capabilities, but mediated network authority is not yet wired into its tools or
globals.
Package-manager capability and projection work is open, while the host backend,
daemon formula, and safe-install provisioning do not yet have implementation
pull requests.

This document is the plan of record for completing independently granted
workspace, Git, package-manager, and Web capabilities for code-mode consumers.
The durable product is a daemon-owned formula graph and trusted grant path, not
an endo-pi controller or any other harness-specific launcher.
Endo-pi remains one consumer and one end-to-end acceptance surface.

The two largest missing product surfaces are safe dependency hydration and
mediated Web research.
The network work begins with reusable public-address semantics and a DNS-pinned
Node HTTP transport, then composes those into transport-neutral HTTP policy and
a passable `WebResearch` capability.
The package-manager work composes only the safe-installer facet from the open
portable capability stack and never exposes the executor facet on the host.

Workspace, Git, package-manager, and Web authority remain separate grants.
Every effect is bounded and cancellable, durable policy contains no secrets or
live handles, restart reconstructs capabilities but never replays interrupted
work, and out-of-band daemon-store purge remains explicitly destructive.

## Scope

This design covers:

- the generic trusted-grant and durable-reconstruction contract for code mode;
- independently provisioned workspace, Git, package-manager, and Web grants;
- safe frozen dependency hydration with no host execution of project code;
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

## Verified Current State

This state was verified on 2026-08-08 against `llm` commit
`5f9ccdea246d1c0d7c68b1a00bc1ed9ff349fdc8` and the live pull-request heads.
Open implementation branches remain owned by their existing pull requests and
must not be absorbed into this design branch.

| Surface | State | Live evidence and remaining boundary |
|---|---|---|
| Daemon-backed code mode | **Landed on `llm`.** | [#907](https://github.com/endojs/endo-but-for-bots/pull/907) merged as `be3dca21c024b29b93432e9e6d4bb462294706d1`. It supplies retained daemon guests, restart/reconnect behavior, and the endo-pi `evaluate` acceptance surface. It does not supply package-manager or mediated Web grants. |
| Portable package manager | **Open draft on `llm`.** | [#948](https://github.com/endojs/endo-but-for-bots/pull/948), head `20374e0ca81abaff5758b72dc41ba3df6bc65534`, defines structurally distinct cumulative reader, safe-installer, and executor facets plus the injected backend protocol. |
| Package-manager projection | **Open draft stacked on #948.** | [#950](https://github.com/endojs/endo-but-for-bots/pull/950), head `1c6638047d6891dbb47ea2d0ff5dc2e3610b4341`, projects metadata tools for a reader, adds `installDependencies` only for an installer, and adds `runPackageScript` only for an executor. Its recorded base snapshot is `b9301c6d6ba416e5164e713f70a290745ee693c7`; #948 has since advanced, so stack maintenance remains with those implementation PRs. |
| Named Git grants | **Open draft on `llm`.** | [#958](https://github.com/endojs/endo-but-for-bots/pull/958), head `026ec9b864559694403d1a21ddefea7a3d8fe776`, adds named nested Git grants, named mount selection, canonical-root persistence, and retained reconstruction. |
| Truthful generic grants | **Open draft stacked on #958.** | [#965](https://github.com/endojs/endo-but-for-bots/pull/965), head `14f2a15b6b26dfd3156f2a5f3dec8b33998fb393`, converges live endowments, checked declarations, prompts, and retained provisioning on locally trusted grant minters. Its recorded base snapshot is `b4b66062b7f234fd0963811c7645257f421bd920`; #958 has since advanced. |
| Host safe-install backend and formula | **No implementation PR yet.** | `packages/package-manager` does not exist on `llm` or #948. The backend, registry broker, daemon formula, durable policy, cleanup, and trusted provisioning remain. |
| Public-Web transport and `WebResearch` | **No implementation PR yet.** | `@endo/http-confine` and `@endo/exo-http-client` provide bounded exact-origin HTTP, while Genie has ambient-fetch `webFetch` and `webSearch` implementations. No reusable DNS-pinned public-Web transport, passable WebResearch capability, daemon formula, or code-mode `web` grant exists. |
| Optional confined execution backend | **Optional later work in a stacked draft.** | [#953](https://github.com/endojs/endo-but-for-bots/pull/953) defines sandbox-backed project-code execution and defense in depth. It is not required by the safe installer or Web stack. |

## Durable Grant Contract

The normalized code-mode policy and retained controller record these grants
independently:

- `workspace`: a read-only or read-write filesystem or mount view;
- root and named Git grants: read-only, read-write, or history-rewrite facets;
- named `GitRemote` capabilities with endpoint, direction, refspec, and optional
  credential policy;
- `packageManager`: reader metadata plus the safe-installer posture; and
- `web`: independently selected `fetch` and `search` operations on a
  `WebResearch` capability.

No grant implies a sibling.
A package-manager grant does not expose Git or a workspace global, a registry
broker does not grant arbitrary Web access, and a Web grant does not grant Git
or registry transport.
When capabilities share a workspace, their mount entries must come from the
same validated lineage even if the workspace itself is not guest-visible.

Once #958 and #965 land, package-manager and Web provisioning extend their
normalized policy, trusted grant minter, formula lookup, declaration, and prompt
path.
They do not introduce a competing grant record, accept a caller-authored
capability/declaration pair, or add a Pi-only policy channel.
The daemon mints or reconstructs a live capability first; trusted agentry code
then derives the exact declaration and prompt from that capability and its
normalized posture.

The durable record contains only versioned, non-secret policy and formula
identifiers.
It retains workspace lineage, Git and remote policy, package-manager bounds,
registry origins, cache identifiers, Web provider selection, URL policy, and
effect limits.
It never contains a live process, socket, DNS result, Undici Agent, stream,
pending promise, proxy address, credential material, or other ephemeral handle.

After a daemon restart, each formula reconstructs its ephemeral implementation
from durable policy.
Every operation journal entry left in `running` becomes `interrupted` with
reason `daemon-restart` before the capability accepts new work.
The disconnected caller receives a rejection and must explicitly retry; Git,
install, fetch, and search operations are never replayed automatically.

Purging the daemon store out of band can remove the controller, formulas,
aliases, policies, and daemon-owned caches.
Externally backed workspace bytes may remain, but they do not silently recreate
the session or its grants.
The caller must explicitly reprovision and revalidate them.

## Package Ownership

| Package | Durable ownership |
|---|---|
| `@endo/net-address` in `packages/net-address` | Portable strict IPv4 and IPv6 normalization, CIDR parsing and matching, IPv4-mapped IPv6 handling, the shared special-purpose address registry, classification, and `isPublicAddress`. |
| `@endo/http-dialer` in `packages/http-dialer` | Node-specific DNS resolution and direct Undici dependency, a normal Undici `Agent` with a custom connector, pinned numeric-address connection, peer verification, Fetch-compatible injection, and close/destroy lifecycle. |
| `@endo/http-confine` | Transport-neutral method and header policy, URL authorization, manual redirects, timeouts, request-rate and response-byte limits, cancellation, and revocation. It does not import the Node dialer. |
| `@endo/exo-web-research` in `packages/exo-web-research` | Passable `WebResearch.fetch` and `WebResearch.search` interfaces, bounded copy result shapes, injected provider and transport seams, and the initial DuckDuckGo adapter moved out of Genie. It has no ambient fetch or Undici dependency. |
| `packages/daemon` | Formula and lifecycle composition, serializable provider and policy selection, trusted grant reconstruction, ephemeral transport recreation after restart, operation interruption, and transport disposal on shutdown. |
| `packages/genie` | The existing `webFetch` and `webSearch` product names as adapters over an injected `WebResearch` capability. |
| `@endo/agent-tools` | JSON-tool and code-mode projection plus the independent `web` grant group. It owns neither provider logic nor network transport. |
| `@endo/agentry` | Generic trusted grant minting, declarations, prompt construction, and consumer-independent code-mode provisioning. |
| `@endo/exo-http-client` | An exact-origin `HttpClient` capability over an injected transport. Its origin authority does not silently widen into arbitrary public-Web authority. |
| `@endo/fetch` | A durable unconfined plugin intentionally configurable for explicit origins, including private origins. It is not the public-Web dialer. |
| `@endo/exo-package-manager` | The portable reader, safe-installer, and executor facets, manager detection, fixed argv, snapshot contract, cancellation scoping, and backend protocol from #948. |
| `packages/package-manager` | The host-only safe-install backend, trusted manager spawn, workspace and configuration revalidation, exact-origin registry broker integration, output/process bounds, and orphan cleanup. |
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
The initial DuckDuckGo HTML adapter and parser move from Genie into this package
and receive no ambient fetch.
Provider selection is durable policy, while DNS, Agent, connection pool, socket,
and cancellation state are recreated by the daemon formula after restart.
Formula cancellation and daemon shutdown close or destroy the transport.

Genie retains the `webFetch` and `webSearch` names but delegates to a supplied
`WebResearch` capability.
Agent-tools projects the same capability into JSON tools and a code-mode `web`
global only when the independent `web` grant is present.
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
4. **Product adapters and trusted grant exposure.** Adapt Genie, add
   agent-tools JSON/code-mode projection, and extend agentry and daemon generic
   provisioning with the independent `web` grant.
   Stop when a code-mode consumer receives exactly the granted Web operations,
   declarations stay truthful, and absence or revocation removes the surface.

The first two pull requests are the missing reusable transport substrate.
All four are required for usable code-mode Web research.
None depends on the optional sandbox backend.

## Daemon-Backed Safe Installation

### Authority posture

#948 defines three cumulative but structurally distinct capabilities:

- a reader with `detect` and `scripts` metadata;
- a safe installer that adds `install` and operation-scoped `cancel`; and
- an executor that additionally adds named-script `run`.

#950 projects exactly those facets as `detectPackageManager` and
`listPackageScripts`, then `installDependencies`, then `runPackageScript`.
The daemon-backed milestone mints, retains, and exposes only the safe-installer
facet.
It does not simulate an executor, expose `runPackageScript`, or retain an
executor internally where a guest could recover it through attenuation.

Project-code execution, lifecycle execution, package binaries, and the executor
facet belong only to the optional confined backend in
[PR #953](https://github.com/endojs/endo-but-for-bots/pull/953).
They are not prerequisites for safe frozen installation.

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

The host backend in `packages/package-manager` implements #948's injected
backend protocol and directly spawns only trusted, pinned npm, pnpm, or Yarn
executables with fixed argv.
Host-shell and exo-shell are not the engine.
The first posture permits only frozen dependency hydration and has no lifecycle,
project plugin/hook, package-script, package-binary, `exec`, `npx`, or `dlx`
surface.

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

Registry and tarball HTTPS pass through an exact-origin broker.
The broker reuses `@endo/net-address`, `@endo/http-dialer`, and the bounded HTTP
policy, but it grants only the normalized registry and lockfile-selected tarball
origins.
The package-manager process receives only a daemon-selected loopback proxy and
trusted configuration with proxy bypass disabled.
The proxy endpoint and arbitrary Web capability are never guest bindings, and
conformance proves the pinned manager cannot connect around the broker.

Cache contents and policy are durable but non-secret.
The daemon formula records cache identifiers, supported manager identity,
registry policy, limits, and reconstruction version.
Live manager processes, proxy listeners, pipes, temporary credentials, and
in-flight operations are explicitly non-durable and are interrupted on restart.

## Git Completion Work

The native Git capability, fixed-argv backend, repository identity checks,
configuration hardening, remote policy, credential formula, and retained guest
seams are already present on `llm`.
#958 and #965 are the in-flight path for named grants and truthful generic
provisioning.
The remaining Git work should reuse those seams and stay proportionate to the
two missing remote behaviors.

First, allow credential-free public HTTPS endpoints for clone and fetch without
weakening the rule that a supplied credential is daemon-minted and audience
bound.
Route Git HTTPS through an exact-origin broker that reuses the shared address
classifier and DNS-pinned transport, disables proxy bypass, and permits only the
policy origin and authorized redirects.
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

Clone destinations and repository roots remain confined to a daemon-minted
workspace lineage.
Git output, deadlines, cancellation, process groups, shutdown interruption, and
orphan cleanup use the same bounded runner discipline as package installation.

## Dependency-Ordered Work

| Order | Work item and owner | Dependency | Stop condition |
|---|---|---|---|
| 1 | Land the portable package-manager capability in #948 and maintain the #950 projection stack. Owners: `@endo/exo-package-manager` and `@endo/agent-tools`. | Existing open stack. | Reader, safe-installer, and executor remain structurally distinct; #950 exposes only tools supported by the exact facet. |
| 2 | Land or compose with #958 and #965. Owner: `@endo/agentry` and daemon provisioning. | Existing open Git/grant stack. | Named capabilities are rebound from durable policy and all live capabilities, declarations, and prompt text come from trusted minters rather than caller assertions. |
| 3 | Deliver Web stack PRs 1 and 2. Owners: `@endo/net-address`, daemon/sandbox consumers, and `@endo/http-dialer`. | None of #948, #950, #958, #965, or #953. | Shared address truth and a DNS-pinned, peer-verified, disposable public HTTP transport pass adversarial tests. |
| 4 | Deliver Web stack PRs 3 and 4. Owners: `@endo/http-confine`, `@endo/exo-web-research`, daemon, Genie, agent-tools, and agentry. | Order 2 for final generic grant exposure; order 3 for transport. | Bounded Web fetch/search is reconstructed by the daemon and appears only under the independent trusted `web` grant. |
| 5 | Add the host-only safe-install backend. Owner: `packages/package-manager`. | #948 contract; shared address and HTTP transport for online registry use. | Frozen npm, pnpm, Yarn 1, and supported Yarn 2+ fixtures hydrate with no lifecycle/plugin/script/binary canary, path escape, ambient secret, direct network, output-cap, cancellation, or orphan escape. |
| 6 | Add the package-manager formula and generic provisioning. Owners: daemon, agentry, and agent-tools. | Orders 1, 2, and 5. | Restart reconstructs only the safe-installer posture and its policy; code mode exposes metadata plus `installDependencies`, never `runPackageScript`. |
| 7 | Complete public and authenticated HTTPS Git brokers. Owners: `@endo/exo-git`, `packages/git`, and daemon. | Order 3 transport and #958/#965 grant infrastructure. | Public clone/fetch works without credentials, authenticated fetch/push requires the exact credential, and protocol, destination, proxy, configuration, output, cancellation, and restart escapes fail closed. |
| 8 | Run consumer-independent acceptance, with endo-pi as one example. Owners: agentry and daemon integration tests. | Orders 4, 6, and 7. | A code-mode session receives only selected grants, survives restart without replay, completes research/clone/edit/install/commit/fetch and conditional push, and reports purge or interruption truthfully. |

Orders 3 and the host-only parts of order 5 can proceed in parallel.
Final projection in orders 4 and 6 composes with #965's trusted grant path
rather than racing it with a second policy model.
The optional sandbox backend is a separate order after the safe-installer
milestone whenever project-code execution is desired.

## Acceptance and Security Tests

The capability roadmap is complete only when tests prove all of the following.

### Grant and durability contract

- zero grants yields only `evaluate`, and every combination of workspace, root
  or named Git, package-manager, Web fetch, and Web search omits ungranted
  siblings;
- declarations and prompt text match the exact trusted live posture, including
  reader versus safe-installer and absence of the executor;
- one canonical mount lineage backs every related capability before and after
  restart, while sibling grants remain independent;
- restart preserves durable identities, workspace bytes, formula policy,
  non-secret caches, and grant selection but never a process, connection,
  credential material, or in-flight operation;
- interrupted effects require explicit retry and are never automatically
  replayed; and
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
- ambient proxies, proxy environment variables, `NO_PROXY`, and global
  dispatcher mutation cannot intercept or bypass the transport;
- oversized plain or compressed bodies, decompression expansion, result-field
  sizes, redirect counts, rates, deadlines, cancellation, and revocation are
  bounded; and
- graceful close and forceful destroy dispose every Agent, origin pool, socket,
  body, and pending request.

### Package-manager and Git contract

- every supported pinned manager version is tested with root and dependency
  lifecycle canaries, pnpm hooks, Yarn plugins and configuration, package
  binaries, explicit scripts, and manager download requests;
- snapshots, manager selection, workspace lineage, configuration, registries,
  cache/scratch paths, and executable identity are revalidated immediately
  before spawn;
- only frozen hydration occurs, neither manifests nor lockfiles change, no
  process writes outside the workspace and explicit cache/scratch paths, and no
  process reaches a non-granted origin or bypasses its broker;
- stdout/stderr overflow, deadlines, cancellation, daemon restart, and child
  pipes that remain open all terminate and reap the complete process group;
- public HTTPS Git clone/fetch works without credentials while authenticated
  operations require the exact separately granted audience, direction, remote,
  and refspec; and
- Git rejects configuration rewriting, remote helpers, protocols, symlink/path
  escapes, broker bypass, credential disclosure, rotation races, cancellation,
  and restart continuation.

An endo-pi scenario may supply the final UI acceptance: start with selected
grants, research a public page, clone or open a repository, inspect and edit the
workspace, hydrate frozen dependencies, commit, fetch, and conditionally push.
The same capability composition must be usable by a non-Pi code-mode consumer
without importing an endo-pi controller or launcher.

## Relationship to the Optional Sandbox Backend

[PR #953](https://github.com/endojs/endo-but-for-bots/pull/953) defines the
optional Session Sandbox Execution Backend and defense-in-depth layer for
project-code execution.
It may implement the same backend-independent capabilities and is the only
planned posture for lifecycle scripts, package binaries, named scripts, and
broader project execution.
The safe-installer and four-PR Web stack above neither depend on it nor change
their public grant identities when it is later selected.

## Alternatives Rejected

- **One general network grant:** registry, Git, and Web authority have different
  destination and effect bounds and must remain independently attenuated.
- **Turning `@endo/exo-http-client` or `@endo/fetch` into the public dialer:** an
  exact-origin grant and an intentionally unconfined durable plugin have useful
  meanings that should not silently change.
- **Leaving transport in Genie:** ambient fetch is not a reusable safe
  arbitrary-public-Web transport and would duplicate daemon policy.
- **A custom Undici Dispatcher:** a normal Agent already accepts the per-socket
  connector and explicit fetch dispatcher seams required by this design.
- **Raw caller grant records or Pi-only policy:** either lets declarations
  self-assert authority or couples the capability system to one consumer.
- **Host package-manager executor:** explicit `run`, lifecycle, package binary,
  and project-code authority exceed the safe-installer posture.
- **Automatic replay after restart:** install, Git, and network effects are not
  generally idempotent and require a live caller decision.

## Open Questions

No package-ownership or sequencing question blocks the stack.
The host backend pull request must select and test exact npm, pnpm, and Yarn
versions rather than treating #948's portable version branches as support
claims.
Provider choice beyond the initial DuckDuckGo adapter and deployment-specific
registry origin sets remain explicit daemon policy.

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
