# Daemon-Backed Session Execution Capabilities

| | |
|---|---|
| **Created** | 2026-08-06 |
| **Updated** | 2026-08-06 |
| **Author** | 0xpatrickdev (prompted) |
| **Status** | Proposed |
| **Builds on** | [daemon-mount-capabilities](daemon-mount-capabilities.md), [daemon-git-capability](daemon-git-capability.md), [daemon-git-remotes](daemon-git-remotes.md), [endo-agent-tools](endo-agent-tools.md), and [endo-fetch](endo-fetch.md) |

## Summary

An endo-pi session becomes useful when it can inspect and edit a workspace,
install declared dependencies, research the public Web, and exchange Git
changes through capabilities that survive an ordinary daemon restart.
None of those operations requires an OS sandbox as its public identity or as a
prerequisite for a first safe release.

The durable identity is the daemon-owned session controller and its retained
formula graph.
The graph records one canonical workspace mount, independently selected grants,
and reconstructible non-secret policy.
The guest receives only backend-independent capabilities: `Filesystem`,
`EndoGit`, `GitRemote`, `EndoPackageManager`, and a mediated Web research
capability.
No public session record, capability interface, or model global contains a
`SandboxHandle`, driver name, root filesystem, host path, or process handle.

The first release uses the existing daemon-backed workspace and native Git
paths, adds a tightly restricted host package-manager backend, and routes all
public network use through purpose-specific daemon mediators.
It never runs untrusted package code on the host.
Package lifecycle hooks, package scripts, package binaries, `exec`, `dlx`, and
equivalent command surfaces remain unavailable until a separately designed
confined execution backend can provide them.

An optional sandbox backend may later implement the same capability contracts,
widen the set of safely executable operations, and add defense in depth.
It does not replace the durable session identity and does not gate this
milestone.

## Problem and Scope

Current `llm` already has most of the useful base path:

- `@endo/agentry` normalizes a versioned, non-secret code-mode policy, derives
  a deterministic retained session path, reconnects to a daemon guest, and
  rejects policy changes during reconstruction;
- `packages/daemon` retains mounts, Git capabilities, Git remotes, HTTP clients,
  credentials, aliases, and guests as formulas;
- `@endo/git` supplies a native `GitBackend` with fixed argv, a sanitized
  environment, repository identity checks, executable-config refusal,
  protocol restrictions, timeouts, output bounds, and anonymous-pipe askpass;
- `@endo/agent-tools` projects granted filesystem, Git, Git remote, Shell, and
  HTTP capabilities into tools and code-mode globals; and
- Genie already names `webFetch` and `webSearch`, but their implementations use
  ambient daemon-worker `fetch` and explicitly do not yet share a confined
  network dialer.

The missing product layer is the binding among those pieces.
Today code-mode provisioning can create separate `workspace` and
`git-workspace` mounts for the same host directory, `GitRemote` requires a
credential even for public HTTPS fetch, the generic HTTP client authorizes
origins but not resolved destination addresses, and no native
`@endo/package-manager` backend exists.

This design covers:

- durable session identity and reconstruction;
- independent workspace, Git, package-manager, and Web grants;
- one canonical workspace lineage;
- dependency installation without untrusted code execution;
- mediated public Web fetch and search;
- public HTTPS Git clone and fetch, followed by explicitly credentialed
  fetch and push; and
- endo-pi provisioning and acceptance.

It does not implement runtime code, grant a raw shell, design registry-to-CAS
module import, execute project-selected code on the host, or make a sandbox a
condition of ordinary workspace, Git, package installation, or Web use.

## Verified Current Seams

This design was checked on 2026-08-06 against `llm` commit
`885ad2e027f0a9be7b8748b1dec35114ed61cdf4` and the then-current heads of pull
requests 907, 948, and 950, then rechecked after the portable package-manager
review follow-up.

| Package | Existing seam | Ownership added by this design |
|---|---|---|
| `packages/agentry` | `provisionEndoCodeMode`, `normalizeEndoProvisionSpec`, and `realizeEndoProvisionOnHost` own the caller policy, deterministic session controller path, host realization, and guest bindings. | Version the policy for `packageManager` and Web grants, converge workspace aliases, and reconstruct the same granted formula identifiers without naming a backend. |
| `packages/daemon` | `provideMount`, `provideGit`, `provideGitClone`, `provideGitRemote`, `provideHttpClient`, formula makers, pet stores, and credential controllers own durable capabilities and host powers. | Own the canonical mount, package-manager formula and runner, public-Web mediator, network brokers, operation journal, and restart interruption. |
| `packages/git` | `makeNativeGitBackend` and `gitClone` own native Git argv, environment, repository checks, protocol selection, output bounds, and askpass transport. | Route HTTPS through a destination-checking broker, support credential-free public fetch, and tighten clone/fetch process cleanup without changing ExoGit. |
| `packages/package-manager` | No package exists on `llm` or on the portable-capability head. | Add the host-only backend that consumes `PackageManagerBackend`, validates the final manager-specific execution profile, and spawns only pinned npm, pnpm, or Yarn binaries. |
| `packages/agent-tools` | Workspace composition and generated code-mode globals are conditional on held capabilities; HTTP and Git-remote adapters already preserve capability bounds. | Bind the package-manager predecessor, omit host-unsafe package execution tools, and project the mediated Web capability using the established `webFetch` and `webSearch` names. |

PR [#907](https://github.com/endojs/endo-but-for-bots/pull/907) is an
evaluate-only Pi extension and launcher over retained code-mode provisioning.
Its live base is `llm`, and it changes no workspace backend, Git backend,
package manager, or network mediator.
It is orthogonal and may land independently.

PR [#948](https://github.com/endojs/endo-but-for-bots/pull/948) is the portable
`EndoPackageManager` capability and fixed-argv policy layer on `llm`.
PR [#950](https://github.com/endojs/endo-but-for-bots/pull/950) is the agent-tool
projection stacked on the portable package-manager branch.
Neither is based on this design branch.
They are predecessors or parallel work, not changes to absorb here; this design
specifies the daemon backend, safe host policy, provisioning, and acceptance
that remain after they land.

## Durable Session and Capability Contract

### Identity and persistence

The stable session identity remains the normalized harness/session key and the
daemon-retained controller path derived from it.
The controller retains aliases for the guest, canonical workspace mount, and
each granted capability formula.
Formula identifiers and backend internals stay host-side; the caller-held
reconnection record remains versioned, plain, non-secret policy.

An ordinary daemon restart preserves:

- the session controller identity, guest formula, aliases, and grant policy;
- the canonical workspace mount formula and persistent files;
- Git formula identity, commit-identity policy, remote endpoint policy,
  refspec and direction bounds, and credential formula identity;
- package-manager selection and execution bounds, allowed registry origins,
  and cache formula identifiers, but no ambient manager configuration; and
- Web fetch/search policy, rate and byte limits, provider selection, and a
  bounded non-secret operation journal.

It does not preserve a live daemon process, child process, network connection,
pipe, stream, pending promise, or credential material.
On startup, every journal entry left in `running` becomes `interrupted` with
reason `daemon-restart` before capability reconstruction.
The disconnected caller receives a rejection and must explicitly retry; no Git
operation, install, or Web request replays automatically.

Purging the daemon store out of band is explicitly destructive.
It can remove the controller, formula graph, aliases, grants, and daemon-owned
scratch data.
An externally backed workspace directory may remain on disk, but it is not a
retained session until a caller explicitly reprovisions and revalidates it.

### Independent grants and workspace coherence

The normalized policy treats these as independent grants:

- `workspace`: a read-only or read-write `Filesystem` view;
- `git`: a read-only, read-write, or history-rewrite `EndoGit`;
- named `GitRemote` capabilities, each with its own endpoint and operation
  policy;
- `packageManager`: metadata plus the safe install operation described below;
  and
- `web`: independently selectable fetch and search authority.

No grant implies another.
A Git-only session need not expose `workspace`; a package-manager-only session
need not expose Git; Web research does not imply registry or Git transport; and
a registry grant does not provide a general Web client.
The guest never receives a generic `network: true` switch.

Provisioning creates or looks up one canonical workspace mount formula and
derives every filesystem-facing capability from that lineage.
It removes the separate `git-workspace` alias.
When both workspace and Git are granted, `Git.worktree()` and the `workspace`
global must refer to that same mount identity.
Package-manager `cwd` entries must be minted by the same lineage.

Current Git construction refuses writable Git over a read-only mount, and
current code-mode policy refuses `workspace: readOnly` with writable Git.
The base release retains that fail-closed rule and applies the same rule to a
mutating package-manager grant.
Writable Git or package installation may exist without exposing a workspace
global, but if a workspace global is also granted it must be read-write.
A later read-only facet over a writable physical lineage may relax the
presentation without weakening the backing authority check.

### Public interfaces are backend-independent

The session policy records requested behavior, not implementation selection.
`EndoPackageManager.install`, `GitRemote.fetch`, and Web methods therefore have
the same guards and result shapes whether the host daemon or a later sandbox
backend executes them.
Backend choice is host deployment policy and may change between compatible
reconstructions without changing session identity or widening grants.

The only persistent backend fact is a compatibility/version marker needed to
reject a reconstruction that cannot honor the recorded behavior.
It is not exposed as a model global and is not part of capability identity.

## Safe Daemon-Backed Package Installation

`EndoPackageManager` remains the JavaScript package-manager capability for npm,
pnpm, and Yarn.
Manager detection, structured inputs, fixed-argv translation, cancellation,
and the injectable backend come from the portable package-manager predecessor.
The tool projection remains a peer grant rather than a filesystem, Git,
remote, or shell bundle.
Registry resolution and fetch for daemon module import remain the separate
`EndoRegistry` concern.

The host backend supports only dependency hydration from a present, matching
lockfile in its first milestone.
It rejects lockfile update, package addition, Corepack download, lifecycle
enablement, and every `run` request before spawn.
The capability may retain the portable `run` method for backend interchange,
but the daemon policy reports it unavailable and the agent-tool projection
must omit `runPackageScript` for this backend.
The same availability filter removes any lifecycle-enablement option from the
advertised install tool.

Host-shell and exo-shell are never the engine for untrusted package code.
The backend may directly spawn one trusted, pinned package-manager executable
with a fixed argv array; it never constructs a shell command or calls a Shell
capability.
No method accepts an arbitrary subcommand, executable, option, or package
binary.

### Manager-specific fail-closed profiles

The final argv and environment are version-specific contracts, not one generic
`ignore scripts` assumption.
The backend pins tested manager major versions and refuses an unknown version
or a requested feature that the selected version cannot express.
The following is the minimum final profile after the portable argv builder and
daemon backend compose:

| Manager | Frozen, no-code invocation | Additional fail-closed checks |
|---|---|---|
| npm 11.18+ | `npm ci --ignore-scripts --no-audit --no-fund --allow-git=none --allow-remote=none --allow-file=root --allow-directory=root` | Require a matching `package-lock.json` or `npm-shrinkwrap.json`; reject `exec`, `npx`, every Git or arbitrary URL dependency, non-root file/directory dependencies, unsafe project registry/proxy/path settings, and every lifecycle/run request. Refuse npm versions without all four `allow-*` controls. |
| pnpm 11 | `pnpm install --frozen-lockfile --ignore-scripts --ignore-pnpmfile --no-runtime` | Require `pnpm-lock.yaml`; `--ignore-pnpmfile` is mandatory because `--ignore-scripts` alone does not suppress `.pnpmfile.cjs`/`.pnpmfile.mjs`; reject configured plugins/hooks, Git or arbitrary URL sources, path/store escapes, and runtime download. Refuse pnpm versions without `--no-runtime`. |
| Yarn 1 | `yarn install --frozen-lockfile --ignore-scripts --non-interactive` | Set `YARN_IGNORE_PATH=1`, require `yarn.lock`, reject project `yarn-path`, plugins, unsafe registry/proxy/path settings, Git dependencies, and every script/run surface. |
| Yarn 2 | `yarn install --immutable --skip-builds` | Set `YARN_IGNORE_PATH=1`, `YARN_ENABLE_SCRIPTS=0`, and telemetry off; reject project plugins, `yarnPath`, injected environment files, executable configuration, Git dependencies, and unsupported offline/production modes. Refuse other Yarn 2 variants if the legacy flag cannot be proven. |
| Yarn 3+ | `yarn install --immutable --mode=skip-build` | Apply the same environment and configuration denials as Yarn 2. `skip-build` mode is required because `enableScripts: false` alone can still treat workspace scripts differently. Refuse versions whose supported invocation does not match the portable predecessor's major-version branch. |

These flags are grounded in the npm `ci` documentation's `ignore-scripts`,
`audit`, and `fund` behavior, pnpm's `install` and `pnpmfile` documentation,
and Yarn's version-specific skip-build behavior, `enableScripts`, and
`ignorePath` contracts.
The portable predecessor's reviewed argv builder supplies `--skip-builds` only
for Yarn 2 and `--mode=skip-build` for Yarn 3 and later:

- <https://docs.npmjs.com/cli/v11/commands/npm-ci/>
- <https://pnpm.io/cli/install>
- <https://pnpm.io/pnpmfile>
- <https://yarnpkg.com/cli/install>
- <https://yarnpkg.com/configuration/yarnrc/>

The backend tests the complete supported-version matrix with fixtures whose
root and dependency packages declare every lifecycle hook.
Success means none of those hooks runs, not merely that the manager exits zero.
An unsupported flag, ignored setting, changed default, or manager version is a
`manager-unavailable` or `policy-denied` failure before workspace mutation.

### Process, filesystem, and output envelope

Every package-manager process receives:

- a workspace-confined canonical `cwd` and manager-owned cache/scratch paths;
- a generated empty HOME and trusted manager configuration;
- a minimal environment containing only a fixed `PATH`, locale, proxy endpoint,
  deterministic CI settings, and the manager-specific deny settings above;
- no `NODE_OPTIONS`, package tokens, npmrc/Yarn credentials, SSH agent, cloud
  credentials, user HOME, or inherited proxy bypass;
- closed stdin, bounded stdout and stderr, a deadline, and an operation-scoped
  cancellation signal; and
- a process group or parent-death launcher so daemon shutdown and crash cleanup
  cannot leave a manager or helper alive.

The backend preflights manifests, lockfiles, manager configuration, source
protocols, workspace paths, cache paths, and resolved registry origins before
spawn.
It records an inspection digest and atomically revalidates the files immediately
before execution, matching the portable backend's snapshot contract.

Hitting either output cap terminates the process group immediately, continues
only bounded draining, escalates to a hard kill after a fixed grace period, and
reaps before returning a truncation result.
Cancellation follows the same kill-and-reap path.
A child that keeps a pipe open after the manager exits must not delay completion
past the deadline.

Package installation places package source and links in the workspace but does
not grant authority to execute them.
Code mode cannot call `run`, a lifecycle hook, a package binary, `npm exec`,
`npx`, `pnpm dlx`, `yarn dlx`, or a manager-specific equivalent on the host
backend.
Those operations are candidates only for the optional confined execution
backend.

## Mediated Web Fetch and Search

General research should use purpose-specific `webFetch` and `webSearch`
surfaces, not a raw network socket and not a broadly networked host process.
The daemon mints a backend-independent `WebResearch` capability with bounded
`fetch(url, options)` and `search(query, options)` methods.
`@endo/agent-tools` projects it as the `web` code-mode global and, where a
discrete tool catalog is used, under the existing Genie names `webFetch` and
`webSearch`.

This does not duplicate Genie's product surface.
Genie's current tool definitions become adapters over an injected
`WebResearch` capability and stop using ambient `globalThis.fetch`.
Its DuckDuckGo HTML parser may remain an initial search-provider adapter, but
provider selection, request execution, limits, and address policy belong to the
daemon mediator.

The landed `@endo/http-confine` and `HttpClient` supply method/header checks,
origin policy, rate limits, manual redirect handling, timeout, revocation, and
response-byte caps.
Their current daemon injection of `globalThis.fetch` is insufficient for an
open public-Web grant because origin comparison does not authorize the resolved
destination address.
The public-Web mediator therefore injects a host dialer that enforces the
following on every connection:

- only HTTP and HTTPS are parsed, with HTTPS the default policy and explicit
  denial of URL userinfo and credential-bearing query fields;
- localhost names, the host's own services, Unix sockets, and every non-public
  address class are denied, including loopback, unspecified, private/LAN,
  carrier-grade NAT, link-local, multicast, documentation/benchmark ranges,
  and IPv4-mapped IPv6 forms;
- cloud-metadata names and addresses are denied explicitly, including
  `169.254.169.254`, IPv6 metadata endpoints, and provider metadata hostnames;
- every A and AAAA answer is classified after resolution and before connect;
  a mixed public/private answer set is rejected rather than selecting the
  public member;
- the authorized public address is pinned for that connection while TLS SNI
  and HTTP Host continue to use the validated hostname;
- every redirect is parsed, authorized, resolved, classified, and pinned from
  scratch; and
- every re-resolution repeats the checks, so short TTLs, DNS rebinding, and
  connection reuse cannot inherit authority from an earlier answer.

Search sends a normalized query only to a configured provider origin through
the same mediator.
It returns bounded title, URL, and snippet records.
Result URLs are inert data; returning them does not fetch or authorize them.
Fetching one requires a separate `webFetch` call and the complete destination
check.

Response bodies, decompression, redirects, requests per minute, total bytes,
content types, and text decoding are bounded.
Tests cover direct IP literals, alternate IP encodings, localhost aliases,
redirect-to-private, redirect loops, dual-stack answers, DNS rebinding,
metadata endpoints, oversized compressed bodies, cancellation, and revocation.

## Narrow Network Authority

The daemon owns three distinct outbound mediators:

| Purpose | Authority |
|---|---|
| Web research | HTTP(S) to arbitrary public destinations after the complete SSRF check, with strict request and response bounds. |
| Package installation | HTTPS only to explicitly granted registry and tarball origins through a registry broker; no arbitrary Web, Git, SSH, or direct-IP destination. |
| Git remote | HTTPS only to the normalized origin in one `GitRemote` policy through a Git broker; no arbitrary Web, SSH, `git:`, helper, or local-file transport in production. |

The package-manager and Git processes are trusted fixed-argv clients, not
arbitrary project processes.
They receive a loopback proxy endpoint selected by the daemon runner, with
proxy bypass disabled and project configuration unable to replace it.
The broker performs DNS and redirect checks and enforces the operation's origin
allowlist.
Conformance tests prove the pinned client versions cannot bypass the broker;
if a client or version can connect directly, that backend is unavailable.

This mediated use does not grant unconstrained network authority to a daemon
Shell, package script, package binary, Git helper, hook, filter, editor, or any
other host process.
No such process is started by this milestone.

## Safe Native Git Remotes

The current native backend is the starting point.
It already prepends fixed hardening configuration, clears ambient config and
credential helpers, disables hooks, fsmonitor, attributes filters, signing,
pagers, and prompts, rejects executable or transport-rewriting repository
configuration, restricts protocols per URL, checks repository identity, and
passes explicit policy URLs to fetch and push.
`provideGitClone` also requires a daemon-minted writable destination mount and
an empty destination.

The first remote cut supports credential-free public HTTPS clone and fetch.
It changes `GitRemoteEndpoint` so HTTPS does not intrinsically require a
credential, while preserving the rule that a supplied credential must be a
daemon-minted capability whose audience exactly matches the normalized origin.
Public push is not claimed as useful behavior.

Each operation:

- accepts only a normalized HTTPS URL with no userinfo;
- uses the policy URL directly rather than `remote.origin.url` or another
  repository-configured endpoint;
- adds `protocol.allow=never` and `protocol.https.allow=always` and refuses
  `url.*.insteadOf`, proxy, credential, include, SSH-command, helper, hook,
  filter, and executable configuration escapes;
- uses the Git HTTPS broker described above, which permits only the policy
  origin and applies the public-address, redirect, DNS, and rebinding checks;
- confines clone destinations and repository roots to the granted canonical
  workspace mount; and
- runs with bounded output, deadline, cancellation, process-group cleanup, and
  no interactive input.

The existing local-file transport remains an explicit test-only policy and is
never accepted in production code-mode provisioning.
HTTP, SSH, scp-like syntax, `git:`, `ext`, remote helpers, submodule recursion,
and arbitrary credential helpers are denied.

Authenticated fetch and push are a second cut.
They require a separately granted, operation-scoped credential whose audience,
direction, remote formula, and refspec policy match the operation.
The current daemon credential formula retains identity and audience while
keeping material process-local; after restart material is unavailable until a
trusted host channel reprovisions it.

The native backend may retain its anonymous askpass pipe, with these additional
requirements:

- material is requested only after endpoint and refspec authorization;
- only the intended Git process and fixed askpass helper inherit the descriptor;
- the secret never enters argv, an environment value, Git configuration,
  persistent storage, logs, output, or model context;
- cancellation, revocation, timeout, and daemon shutdown close the pipe and
  kill and reap the process; and
- a credential change during the operation invalidates the result, preserving
  the current version fence.

Credentialed operations remain unavailable until concurrent-process,
redaction, cancellation, restart, and broker-bypass tests pass.
SSH keys and agent forwarding are later work.

## Code-Mode and endo-pi Provisioning

`provisionEndoCodeMode` remains the product entry point.
After the evaluate-only Pi predecessor, the Pi extension remains a thin client:
it supplies a normalized policy, reconnects to the retained daemon guest,
registers only `evaluate`, and closes its CapTP connection without disposing
durable resources.

The versioned policy adds the new grant fields and uses the harness-scoped
`code-mode/pi/session-<sha256>/...` controller layout when that predecessor is
current.
Host realization performs the following in one deterministic order:

1. compare the complete normalized policy with the retained copy and reject
   any widening or change;
2. create or recover the canonical workspace mount once;
3. create only the requested workspace, Git, remote, package-manager, and Web
   formulas over their respective policies;
4. bind their exact identifiers into the retained guest under lexical names;
5. construct code-mode globals and optional tool records only for those held
   capabilities and their advertised operations; and
6. return a caller cleanup function that closes only local CapTP resources.

The raw host runner, network broker, operation journal controller, credential
material, proxy address, host path, and any later execution-backend handle are
never guest bindings.

## Dependency-Ordered Implementation Plan

Each cut is independently useful and has a fail-closed stop condition.

1. **Portable package-manager predecessors.** Land the portable capability on
   `llm` and its tool projection on the existing portable-capability stack.
   Stop when the portable interface, backend snapshot contract, cancellation,
   fixed argv, and peer tool group are available without a native process.
2. **Canonical session grants and safe install.** Converge code-mode
   provisioning onto one workspace mount, add the package-manager formula and
   native backend in `packages/package-manager`, restrict it to frozen
   no-lifecycle installs, and filter unavailable tool operations.
   Stop when npm, pnpm, Yarn 1, and supported Yarn 2+ fixtures hydrate through
   fixed final profiles with no script canary, host-path write, ambient-secret,
   orphan, or output-cap escape.
3. **Mediated Web fetch and search.** Add the public-address dialer and
   `WebResearch` formula, adapt Genie's `webFetch`/`webSearch` definitions to an
   injected capability, and expose matching agent-tools surfaces.
   Stop when real public research works and the complete SSRF, redirect,
   rebinding, metadata, size, rate, timeout, cancellation, and revocation suite
   passes.
4. **Public HTTPS Git remotes.** Permit credential-free public HTTPS endpoints,
   route clone/fetch through the origin-bound broker, and preserve existing
   configuration and repository-identity hardening.
   Stop when a fresh session can clone and fetch a public repository into its
   granted workspace while every protocol/configuration/destination escape is
   denied.
5. **Authenticated Git fetch and push.** Bind current Git credentials to one
   authorized operation and broker origin, preserve anonymous descriptor
   transport and version fencing, and add push acceptance.
   Stop when credential rotation, revocation, cancellation, daemon restart,
   redaction, refspec denial, and concurrent-process isolation pass.
6. **endo-pi provisioning and end-to-end acceptance.** Extend the retained
   policy and declarations, provision only requested globals, and exercise the
   shipped Pi extension from the evaluate-only predecessor.
   Stop when endo-pi can research, clone or open a repository, inspect/edit it,
   safely install declared dependencies, commit, fetch, and conditionally push;
   an intervening daemon restart must preserve identity and state, report an
   interrupted operation, and require explicit retry.

## Acceptance and Safety Tests

The base milestone is complete only when tests prove:

- zero grants yields only `evaluate`, and every combination of workspace, Git,
  package-manager, Web fetch, and Web search omits ungranted siblings;
- one canonical mount identity backs every granted workspace-facing
  capability, including after restart;
- a writable Git or package-manager request over a read-only mount fails before
  mutation;
- package installs for every supported manager execute no lifecycle, project,
  plugin, package-binary, or package-script code and cannot write outside the
  workspace plus explicit cache/scratch paths;
- Web, registry, and Git mediators cannot reach localhost, host services,
  private/LAN/link-local, metadata, rebinding, or redirect escape targets;
- public HTTPS clone/fetch works without a credential, while authenticated
  operations require the exact separately granted credential and policy;
- output caps terminate before EOF, cancellation reaps process groups, and a
  daemon crash leaves no manager or Git child;
- restart preserves durable identities, workspace bytes, grants, and policy but
  never a process or in-flight operation; and
- out-of-band store purge is reported and tested as destructive rather than as
  ordinary reconstruction.

## Alternatives Rejected

- **Sandbox-first usability:** delays safe workspace, Git, installation, and
  research capabilities that already have narrower daemon-backed paths.
- **A `SandboxHandle` in session identity:** confuses an ephemeral backend
  incarnation with durable capability identity and prevents backend exchange.
- **Raw host shell or exo-shell:** turns structured install or Git authority
  into arbitrary process authority and can execute project-selected code.
- **Treating `--ignore-scripts` as manager-neutral:** misses pnpmfile execution,
  Yarn version differences, project plugins, and changing manager defaults.
- **One general network grant:** lets a registry or Git operation become an
  arbitrary host-network process and defeats independent attenuation.
- **Genie and endo-pi each owning a Web transport:** duplicates policy and
  leaves one ambient-fetch path outside daemon enforcement.
- **Automatic replay after restart:** repeats non-idempotent Git, install, or
  network effects without a live caller decision.

## Open Questions

None block the dependency order.
The exact supported manager versions, search provider, registry origin set, and
deployment broker implementation are host policy selected from implementations
that pass the same conformance suite and fail closed when unavailable.

## Prompt

> Rework the session design so the useful, safe daemon-backed endo-pi path is
> the base design and an optional sandbox is a later interchangeable backend.
> Preserve durable restart semantics, independent workspace/Git/package-manager
> and Web grants, mediated public Internet with SSRF defenses, safe native Git
> remotes, fixed-argv npm/pnpm/Yarn installation with no host execution of
> untrusted package code, bounded output, cancellation, and end-to-end
> acceptance.
> Treat the portable package-manager and tool-projection pull requests as
> independent predecessors, and do not implement runtime code.
