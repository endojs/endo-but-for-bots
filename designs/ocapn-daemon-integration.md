# OCapN integration with the daemon: per-agent `@transports`

| | |
|---|---|
| **Created** | 2026-05-07 |
| **Updated** | 2026-08-31 |
| **Author** | kriscendobot (steward, prompted by kriskowal) |
| **Status** | Not Started |
| **Source** | Issue [endojs/endo-but-for-bots#118](https://github.com/endojs/endo-but-for-bots/issues/118) |

## What is the Problem Being Solved?

The daemon today exposes the OCapN-adjacent network surface as a single
host-wide `@nets` capability.
`packages/daemon/src/host.js` and `packages/daemon/src/guest.js` both
inject the same `networksDirectoryId` under the special name `@nets`,
which resolves to a daemon-singleton directory of named netlayer
formulas (loopback, ws-relay, tcp-netstring, iroh, and, since
2026-08-25, a daemon-side OCapN-Noise netlayer,
`packages/daemon/src/networks/ocapn.js`, registered at `@nets/ocapn`
by `setup-ocapn.js`).
Every agent the daemon hosts sees the same registry, can list every
registered net, and can connect through every net the daemon knows
about.

The just-consolidated OCapN-Noise stack
(PR [endojs/endo-but-for-bots#118](https://github.com/endojs/endo-but-for-bots/issues/118)
item (a), folding PRs
[endojs/endo-but-for-bots#111](https://github.com/endojs/endo-but-for-bots/issues/111),
[endojs/endo-but-for-bots#112](https://github.com/endojs/endo-but-for-bots/issues/112),
[endojs/endo-but-for-bots#113](https://github.com/endojs/endo-but-for-bots/issues/113)
into `llm`, the repository's integration branch) introduces a real,
mutually authenticated transport family for the daemon to mediate.
Bringing that stack online while keeping `@nets` as the agent-facing
surface would fix the singleton problem in the wrong layer and would
foreclose several capabilities-discipline properties the daemon should
preserve.

The limitations of `@nets` as a singleton are:

1. **No scoping.**
   Every agent sees every net.
   A guest cannot be granted access to a Noise session over a private
   substrate while being denied the public WebSocket relay; both
   live on the same `@nets` directory.

2. **No revocation.**
   Removing a net from `@nets` affects every agent at once.
   There is no per-agent kill-switch for a network capability that
   was over-granted, and no way for an agent to drop its own
   transports without reaching into a shared directory.

3. **No per-agent identity.**
   The Ed25519 signing key for OCapN-Noise is materialized inside
   the netlayer formula, which is shared.
   An agent cannot present a distinct network identity from its
   sibling without instantiating a separate netlayer, which then
   conflicts with the singleton structure.

4. **Lifetime mismatch.**
   `@nets` is tied to the daemon's lifetime.
   An agent's network access does not end when the agent is
   disincarnated, restarted, or revoked; it merely becomes
   unreachable through one path.
   Sockets, listeners, and Noise sessions remain bound to the
   shared directory.

5. **No composition with mounts and other agent caps.**
   Other agent-held capabilities (`@main`, `@host`, `Mount` from
   `daemon-mount`) live inside the agent's confinement boundary.
   `@nets` punches a hole in that boundary by exposing the host's
   network registry directly.
   The cap-handoff pattern used by `provideMount` and (per the
   in-flight `feat/platform-fs` work) `daemon-mount`/`platform-fs`
   integration does not apply here.

## Goals and Scope

### Goals

- Replace the host-singleton `@nets` directory with a per-agent
  `@transports` capability that the daemon mints on the agent's
  behalf.
- Preserve OCapN-Noise IK netlayer compatibility with the
  consolidated
  [endojs/endo-but-for-bots#111](https://github.com/endojs/endo-but-for-bots/issues/111)/[endojs/endo-but-for-bots#112](https://github.com/endojs/endo-but-for-bots/issues/112)/[endojs/endo-but-for-bots#113](https://github.com/endojs/endo-but-for-bots/issues/113)
  stack.
- Define the cap-handoff path: how the daemon manufactures
  per-agent transports, how an agent obtains them, how they are
  revoked, and how they cohabit with mounts and other agent-held
  caps.
- Reuse the in-guest-backend / host-side-proxy pattern from the
  cross-platform sandbox work (jcorbin, `PLAN/endo_posix_sandbox.md`)
  and the agent-held + daemon-mediated pattern from the in-flight
  `Mount` reshape
  (PR [endojs/endo-but-for-bots#122](https://github.com/endojs/endo-but-for-bots/issues/122),
  `designs/platform-fs-daemon-integration.md`
  on `feat/platform-fs`).

### Out of Scope

- OCapN spec changes; the wire format and locator structure are
  governed by `ocapn-network-transport-separation` and
  `ocapn-noise-network`, both of which are upstream of this design.
- Cross-language transport adapters (a Go or Rust daemon's
  `@transports` is its own concern; the JS daemon ships first).
- New transport schemes (QUIC, WebTransport).
  Schemes are added in their own designs; the `@transports`
  envelope must accommodate them but does not specify them.
- Cross-peer revocation propagation (when a remote daemon revokes
  a session, how the local daemon learns of it).
  The OCapN GC story handles session liveness; this design covers
  the local cap-handoff only.

## Design

### Capability Surface

#### Agent Side: `Transports`

Each agent holds a single `Transports` exo, registered in its
pet store under the special name `@transports`.
The exo presents these methods:

```js
const TransportsInterface = M.interface('Transports', {
  // Discovery
  list: M.call().returns(M.promise()),                // -> string[] (available scheme names)
  has: M.call(M.string()).returns(M.promise()),        // scheme -> boolean

  // Outgoing sessions
  connect: M.call(M.any())                             // Locator: ed25519 public key + connection hint
    .optional(M.record())                              // { hints? } dial overrides; see below
    .returns(M.promise()),                             // -> Session

  // Incoming sessions
  listen: M.call(M.string())                           // scheme
    .optional(M.record())                              // { port?, host? }
    .returns(M.promise()),                             // -> Listener

  // Lifecycle
  disconnect: M.call(M.any()).returns(M.promise()),    // a Session or Listener (from connect/listen)
  shutdown: M.call().returns(M.promise()),

  help: M.call().returns(M.string()),
});
```

The shape mirrors the `OcapnNetwork` interface defined in
`designs/ocapn-network-transport-separation.md` but is a per-agent
surface, not a host-singleton.
A `Session` is the same authenticated, encrypted CapTP-bearing
session that `OcapnNetwork.connect` returns, and a `Listener`
delivers `Session` instances over a name-changes-style follow.

The `handle` that `disconnect` accepts **is** a `Session` or a
`Listener` — the very value `connect` or `listen` returned — not a
separate opaque id. `disconnect(session)` drops that one session;
`disconnect(listener)` stops that one listener (and, being the
narrowest teardown, is what the CLI's per-handle `revoke` verb fronts,
Design Decision #9). The `M.any()` guard on the parameter is only
because `Session`/`Listener` are remotable exos rather than a matcher
literal; semantically the input shape of `disconnect` is exactly the
output shape of `connect`/`listen`.

`connect`'s optional second argument, `{ hints? }`, does **not**
duplicate the locator's own embedded connection hint (Design Decision
#4): the locator's hint is the *default* dial target the peer
advertised, and `hints` is a per-call **override/supplement** the
caller supplies when it has better local knowledge (a specific relay
to prefer, an alternate host:port for the same identity). Precedence
is caller-first: a field present in `hints` overrides the same field
read out of the locator; fields absent from `hints` fall back to the
locator's hint. The routing target — the Ed25519 public key — is
**never** taken from `hints`; it comes only from the locator and stays
authoritative for routing (Design Decision #4). A caller that has
nothing to override omits the argument entirely and dials on the
locator's hint alone.

`list()` enumerates the transport **schemes** this agent may use
(the direct replacement for enumerating the old `@nets` directory):
it returns an array of scheme-name strings such as `['np',
'tcp+syrups']`, filtered to the agent's `allowedSchemes`. It does
not return peer `Locator`s (a peer address is supplied *to*
`connect`, not enumerated by `list`), and `has(scheme)` is the
membership test for the same set. This is the single return-shape
statement for `list()`; Design Decision #10's "the host reaches
netlayers through `@transports.list()`" refers to this same
scheme enumeration.

#### Daemon Side: `TransportFactory`

`HostInterface` (`packages/daemon/src/interfaces.js`) gains:

```js
provideTransports(petName, options): Promise<Transports>
updateTransportsPolicy(petName, policyPatch): Promise<void>
revokeTransports(petName): Promise<void>
registerNetwork(scheme, networkServiceId): Promise<void>
```

`registerNetwork` is the host-privileged write side of the
daemon-internal netlayer registry, the cutover replacement for the
bootstrap scripts' `move(..., ['@nets', X])` (see *Netlayer
Registration Moves to a Host-Internal Path*); it is never reachable
from an agent's `@transports`.

`revokeTransports(petName)` is the host-side, whole-agent
kill-switch: it tears down the named agent's entire `Transports`
view: every outstanding listener and session fails, the agent's
per-agent signing keys are de-registered from the shared netlayers'
inbound demux, and subsequent `connect`/`listen` calls on that
view reject. It is the coarse counterpart to the agent-side
`disconnect(handle)` (drops one session) and `shutdown()` (agent
retires its own view); `revokeTransports` is the only one a *host*
can invoke against an agent it no longer trusts. Sibling agents are
unaffected. It is idempotent: revoking an already-revoked or
never-provisioned petName resolves without error. (The CLI's
per-handle `endo agent <name> transports revoke <handle>` in Design
Decision #9 is the finer-grained, agent-facing verb and fronts
`disconnect(handle)`, not this host method; the two share the word
"revoke" for deliberately different granularities.)

where `options` carries:

- `allowedSchemes`: `['np', 'tcp+syrups', ...]`. The schemes the
  agent may use; defaults to the host's currently-enabled set.
- `signingKeys`: optional, defaults to a fresh per-agent Ed25519
  pair (see `daemon-agent-network-identity`); a host may supply
  its own keys for agents that need a stable network identity.
- `listenPolicy`: `'none' | 'request' | 'allow'`. Whether the
  agent may open listening sockets, may request that the daemon
  open one on its behalf, or may not listen at all.
- `outboundPolicy`: optional address allowlist or matcher.

These fields split into two lifecycles: `signingKeys` is **durable
identity** (persisted across restart per *Daemon Restart*, and
deliberately preserved for delegated children per Design Decision #9),
while `allowedSchemes`/`listenPolicy`/`outboundPolicy` are **revisable
policy** an operator narrows or tightens mid-lifetime. Because those
lifecycles differ, policy is revised through its own method rather
than by re-formulating identity — see Design Decision #11 for
`updateTransportsPolicy` and the semantics of re-calling
`provideTransports` on an already-provisioned petName.

The host side wraps each agent's `Transports` exo over the
daemon's underlying network primitives.
The wrapper is the host-side proxy in the in-guest-backend +
host-side-proxy pattern: the agent holds the facade, the daemon
holds the actual netlayer instances and routes between them.

Each underlying transport is a **single shared instance per
scheme**, not one instance per agent.
Every agent that uses a given transport shares that transport
instance, which listens on **one per-transport port** (not a
per-agent port) and is responsible for **relaying each incoming
session to the owning agent by the peer's Ed25519 public key**.
Routing is on Ed25519 identity throughout: every transport must be
able to demultiplex sessions by public key.

For inbound Noise IK sessions this demultiplexing must happen
*before* the handshake completes: the responder static key is the
owning agent's per-agent identity, so the daemon has to select the
correct agent's private key before it can decrypt the initiator's
first handshake message. The transport therefore carries the
target agent's Ed25519 public key in an unencrypted routing
preamble ahead of the Noise handshake (an SNI-style selector); the
daemon looks up the owning local agent and its responder key from
that preamble and hands the session to that agent's `Transports`
view. It does not trial-decrypt against every local agent's key,
so inbound dispatch stays O(1) in the number of hosted agents. The
concrete preamble framing is fixed in the implementation PR
against the `ocapn-noise-network` netlayer (see *Affected
Packages*).

**Tradeoff — the routing preamble exposes the target identity in
cleartext.** The SNI-style selector carries the target agent's
Ed25519 public key unencrypted, ahead of the Noise handshake, so any
on-path observer learns *which agent, by identity,* a given inbound
session addresses before encryption begins. This is the same
metadata leak plaintext-SNI is known for, and it does cut against the
scoping/isolation framing elsewhere in this design (Goal/Problem #1,
Design Decision #3): identity-based routing that puts the identity on
the wire is a weaker confidentiality property than one that hides it.
We accept the leak deliberately, on two grounds. First, under Noise
**IK** the initiator must already know the responder's static public
key out-of-band to even attempt the handshake, so the preamble
reveals to an observer only what a would-be initiator necessarily
already possesses — it exposes no identity the protocol was keeping
secret from a party able to connect at all. Second, the alternative
that would hide it (trial-decryption against every local agent's
responder key) reintroduces the O(hosted-agents) inbound cost this
selector exists to remove, and still leaks timing. What the leak does
*not* weaken is the scoping property Goal #1 actually asserts: an
observer learning *whom* a session addresses does not let a guest
*reach* a scheme or peer its `allowedSchemes`/`outboundPolicy` denies
— routing visibility is not routing authority. Hiding the responder
selector (e.g. a blinded or rendezvous-style identifier) is possible
but is a wire-format concern owned by `ocapn-noise-network`, out of
scope here; this design records the exposure rather than silently
trading it for the dispatch win.

The per-agent `Transports` exo is therefore a scoped *view* over
shared, identity-routed transport instances. It isolates
discovery, revocation, accounting, and identity per agent while
the physical socket, port, and connection coalescing stay shared.

### Layer Cake

```mermaid
flowchart TD
    subgraph agent["Agent (worker realm)"]
        A["Transports exo (per-agent)<br/>connect(locator), listen(scheme),<br/>disconnect(h), list(), shutdown(), help()"]
    end

    subgraph host["TransportFactory exo (host-side proxy)"]
        F["holds ref to underlying netlayer registry<br/>per-agent state: signing keys, allowed schemes,<br/>outstanding listeners, outstanding sessions,<br/>revocation handles"]
    end

    subgraph netlayers["Underlying netlayer formulas (daemon singletons)"]
        N1["OCapN-Noise (np): @endo/ocapn-noise bindings"]
        N2["TCP+Syrups (tcp+syrups): @endo/syrups framing"]
        N3["Loopback: in-process queues"]
        N4["ws-relay: WebSocket via relay server"]
    end

    subgraph core["@endo/ocapn"]
        C1["@endo/ocapn (NonceLocator, CBOR codec, OCapN core)"]
        C2["@endo/ocapn-noise (Noise IK handshake, ChaCha20-Poly1305)"]
    end

    A -->|"daemon-side membrane (CapTP / formula boundary)"| F
    F -->|"netlayer membrane"| netlayers
    netlayers -->|"@endo/ocapn membrane"| core
```

The daemon retains the netlayer registry; the agent never sees it.
The agent sees only the `Transports` exo, which decides per-call
which netlayer to dispatch to based on locator scheme and policy.

### Lifecycle

#### Creation

When an agent is formulated (`makeHost`, `makeGuest`), the daemon
calls `formulateTransports(agentId, options)` instead of injecting
`networksDirectoryId` under `@nets`.
The resulting `transportsId` is stored under `@transports` in the
agent's special-store map.
The formulation is durable (a new `Transports` formula type) so
that the cap survives daemon restart with the same identity but
fresh socket state.

`@nets` is not provided at all, neither to new agents nor to
existing ones.
The agent-facing surface is `@transports` outright: there is no
`@nets`/`@transports` coexistence window.
`@nets` is not widely deployed, so a staged migration is
unnecessary; the swap is a single cutover (see *Replacing
`@nets`*).

#### Revocation

Two granularities:

1. **Per-handle**: the agent calls `disconnect(handle)` to drop a
   single session or listener.
   The daemon-side proxy invalidates that handle's underlying
   socket and any CapTP-level references hanging off it.

2. **Per-agent**: `shutdown()` revokes the entire `Transports`
   capability.
   The daemon may also call into the proxy from outside (e.g.,
   when the host disinherits the agent) to force a shutdown
   regardless of agent cooperation.

Sibling agents are unaffected.
The host's underlying netlayers continue to serve other
`Transports` proxies.

#### Garbage Collection

A `Transports` proxy participates in the daemon's existing
`thisDiesIfThatDies` chain.
When the agent dies, its proxy dies, which cascades to outstanding
sockets and listeners.
Underlying netlayer formulas have no incoming reference from the
proxy; they are pinned by the daemon's `@endo` formula and
collected only at daemon shutdown.

When a shared transport *instance* is itself collected (its
formula garbage-collected and the instance consequently
cancelled/disincarnated) it must **close all of its sessions**,
so that every presence and promise carried over those sessions is
partitioned/rejected.
This is the one revocation invariant this design owes the wider
session-partitioning story (see *Cross-peer revocation
propagation* under Out of Scope, Future Work).

#### Daemon Restart

Per-agent signing keys are persisted with the `Transports`
formula's deferred-task params so that the restored agent presents
the same network identity.
Outstanding sessions do not persist; they are re-established on
demand.
Listeners re-bind to their configured ports if the host policy
permits; otherwise the agent must re-call `listen()`.

### Capability Sharing Across Agents (Same-Daemon)

When two agents within the same daemon need to talk over the same
Noise session, they do not coordinate via the `Transports` exo.
The daemon brokers internally:

- Agent A calls `connect(locatorB)` against its `Transports`.
- The proxy resolves `locatorB` to a local agent and returns a
  loopback session (no Noise handshake; in-process direct cap
  forwarding).

The cross-daemon counterpart (two agents on different daemons,
each holding its own Noise session over the shared wire) is
covered under *Capability Sharing Across Agents (Cross-Daemon)*
below.

The netlayer is responsible for connection coalescing (one Noise
socket carrying CapTP for many local-agent sessions); the
`Transports` proxy presents an independent session per agent so
that revocation, accounting, and identity remain per-agent.

### Replacing `@nets`

`@nets` is not widely deployed, so there is no migration window,
no shadowing, and no deprecation period: `@transports` replaces
`@nets` in a single cutover, all in the one change.

#### Agents Get `@transports`, Not `@nets`

Add a `Transports` formula type and a `provideTransports` host
method.
Formulation populates `@transports`; `@nets` is never injected.
There is no dual-population and no agent-side
`@transports`-then-`@nets` fallback probe.

#### Internal Callers Move to `@transports`

The current callers of the literal `@nets` name, from
`grep -rn '@nets' --include=*.js packages/` (scope: every JS file
under `packages/`, source and test) at this PR's base, are:

- **Injection sites** (`host.js:499`, `guest.js:102`): the two
  `specialNames['@nets'] = networksDirectoryId` writes removed by
  *`@nets` Injection Is Removed* below.
- **Netlayer bootstrap scripts** (`networks/setup-{tcp,ws-relay,
  ocapn,iroh}.js`): the `E(powers).move(..., ['@nets', X])`
  registrations retargeted onto `registerNetwork` (see *Netlayer
  Registration Moves to a Host-Internal Path*).
- **Chat slash-commands in `packages/spaces-util/src/command-executor.js`**
  (`command-executor.js:731`, `:770`, `:803`, `:849`): four live,
  non-test, host-privileged `E(powers).move([...], ['@nets', scheme])`
  write sites backing the `/network`, `/network-ocapn`,
  `/network-iroh`, and `/network-ws-relay` commands. These are the
  same registration pattern as the setup scripts and **must retarget
  onto `registerNetwork` in the same cutover** — with no `@nets`
  target to `move()` into, they would otherwise throw the moment the
  cutover lands. `packages/spaces-util/` is listed in *Affected
  Packages* accordingly.
- **Test fixtures** (`packages/daemon/test/{_multiplayer-suite,
  invite-retention-ocapn,endo,ws-relay,channel-relay}.js`,
  `packages/claude-sandbox/test/live-daemon.test.js`): updated to
  `@transports` in the same change.

Note that `manager.js` (the daemon core, formerly `daemon.js`,
renamed in the already-landed `daemon-rename-to-manager` work)
contains **no** literal `@nets` reference: `makePeer`
(`manager.js:6383`) and `getAllNetworkAddresses`
(`manager.js:6230`) take the `networksDirectoryId` id as a
parameter and never resolve the `@nets` pet name, so they need no
call-site edit — they already operate on the retained internal
registry. Agent-facing callers that previously listed nets and
selected one instead look up `@transports` and call
`connect(locator)`; `getAllNetworkAddresses` stays a
daemon-internal helper used by the `TransportFactory` proxy, not
surfaced to agents.

#### `@nets` Injection Is Removed

`@nets` is removed from `specialNames` in `host.js` (the
injection site is `host.js:499`) and `guest.js`.
The `networksDirectoryId` parameter remains on the formulation
path because the daemon still needs the underlying netlayer
registry; only the agent-facing surface is removed.

#### Netlayer Registration Moves to a Host-Internal Path

Removing the agent-facing `@nets` name also removes the path the
daemon's own bootstrap scripts use to *install* a netlayer today.
The four operational setup scripts
(`packages/daemon/src/networks/setup-{tcp,ws-relay,ocapn,iroh}.js`)
each register a network service by moving it into the `@nets`
directory of an agent's powers:
`E(powers).move(['network-service-X'], ['@nets', 'X'])` under
`--powers @agent`. This is how the `ocapn.js` netlayer this design
repurposes gets registered (`setup-ocapn.js`). Once `@nets` names
nothing in any pet store, that `move()` target no longer resolves,
so registration must retarget the daemon-internal registry that the
retained `networksDirectoryId` designates.

The registry keeps a **write side** distinct from the agent-facing
read side. `@transports.list()`/`has()` are read-only scheme
enumeration for agents (per *Capability Surface*); installing a
netlayer is a **host-privileged** operation, never reachable from an
agent's `@transports`. The daemon exposes it as a host method on
`HostInterface` alongside `provideTransports`:

```js
registerNetwork(scheme, networkServiceId): Promise<void>
```

which moves the named network service into the daemon's internal
netlayer registry (the directory `networksDirectoryId` designates)
under `scheme`. The setup scripts change their one `move()` call
from `E(powers).move(['network-service-X'], ['@nets', 'X'])` to
`E(host).registerNetwork('X', networkServiceId)` (reached through
`@host`, which survives the cutover), so a netlayer is installed
without any agent-visible `@nets` directory. The
`TransportFactory` proxy then dispatches over whatever schemes the
registry holds, and `@transports.list()` reflects the resulting set.
Registration stays host-only: an agent can neither enumerate the
registry's write side nor install a netlayer, only use the schemes
its policy allows.

#### Per-Agent Signing Keys

With `@transports` in place, the per-agent Ed25519 key path
(blocked today on the singleton) becomes natural.
This is `daemon-agent-network-identity` (M2, Not Started); the
two designs land together.

### Capability Sharing Across Agents (Cross-Daemon)

Two daemons connecting over OCapN-Noise:

- Daemon X's agent A calls `connect(locator)` where `locator`
  designates an agent B on daemon Y.
- A's `Transports` proxy on X dispatches to the `np` netlayer.
- The `np` netlayer either reuses an existing Noise session to
  Y (if X and Y are already connected) or initiates a new Noise
  IK handshake.
- The session delivers a CapTP channel scoped to A and B; other
  agents on X with their own sessions to agents on Y reuse the
  same Noise session at the wire level but hold independent
  CapTP channels at the cap level.

This matches the `OcapnNetwork` model from
`ocapn-network-transport-separation`; the per-agent layer sits
on top of (not in lieu of) the per-daemon netlayer.

## Affected Packages

- `packages/daemon/`: `host.js`, `guest.js`, `manager.js` (the
  daemon core, formerly `daemon.js`), `interfaces.js`,
  `types.d.ts`, `formula-type.js`, `help-text-data.js`, and the
  netlayer bootstrap scripts
  `networks/setup-{tcp,ws-relay,ocapn,iroh}.js` (retarget their
  `move(..., ['@nets', X])` onto `registerNetwork`, see *Netlayer
  Registration Moves to a Host-Internal Path*).
- `packages/spaces-util/`: `src/command-executor.js` — the
  `/network`, `/network-ocapn`, `/network-iroh`, and
  `/network-ws-relay` chat slash-commands each do
  `E(powers).move([...], ['@nets', scheme])` (`command-executor.js:731`,
  `:770`, `:803`, `:849`) and retarget onto `registerNetwork` in the
  same cutover (see *Internal Callers Move to `@transports`*); left
  unretargeted they throw once `@nets` names nothing.
- `packages/ocapn/`: must expose `OcapnNetwork` registration
  surface that the proxy consumes (depends on
  `ocapn-network-transport-separation`).
- `packages/ocapn-noise/`: no changes; bindings are consumed by
  the netlayer that the proxy fronts.
- **Daemon-side OCapN-Noise netlayer, already landed, repurposed,
  not rebuilt.** The `np` netlayer the proxy dispatches to already
  exists as `packages/daemon/src/networks/ocapn.js` +
  `setup-ocapn.js` (protocol `ocapn+noise+tcp`, registered at
  `@nets/ocapn`), landed 2026-08-25, six days before this PR's
  base. This design does **not** introduce a parallel
  `packages/ocapn-noise-network/` package; it **repurposes** the
  landed `ocapn.js` netlayer as the shared per-daemon substrate
  that the per-agent `TransportFactory` proxy fronts. The
  implementation work is therefore wiring the proxy over the
  existing netlayer (per-agent signing-key registration/revocation,
  identity-routed inbound demux, much of which
  `@endo/ocapn-noise`'s `network.js` already provides via
  `addSigningKeys`/`removeSigningKeys` and its per-key `registeredKeys`
  map), not standing up a new netlayer. Where earlier references in
  this doc cite `ocapn-noise-network`, they name the design that
  motivated `ocapn.js`, not a package still to be built.
  Note that the shipped code (`packages/ocapn-noise`) and this
  design use Noise **IK**; the `ocapn-noise-network` design doc
  still describes Noise **XX** in places and is stale on that
  point. The IK handshake as implemented is authoritative, and the
  `ocapn-noise-network` doc is to be reconciled to IK. Do not
  reintroduce the `np` netlayer to the XX shape.
- `packages/cli/`: per-agent
  `endo agent <name> transports {list,add,revoke}` verbs and the
  `endo mkguest <child> --transports-from <parent>` delegation flag
  (each bound to a named method, see *Design Decisions* #9);
  `endo nets` is retired alongside `@nets` (#10).

## Design Decisions

The questions raised during design review are resolved as follows
(the resolutions are directives from the review, not open choices).

1. **`Transports` is a formula.**
   It gets durability and named-pet-store presence for free at the
   cost of a formula boundary per method call, matching the `Mount`
   precedent.
   Restart handling is the deferred-task-params path in
   *Daemon restart*; there is no exo-with-daemon-internals variant.

2. **The listen port is per-transport, not per-agent.**
   A transport *instance* is shared by all peers that use it and
   listens on **one** port; the physical transport relays each
   incoming session to the owning agent by the peer's Ed25519
   public key (see *Layer cake*).
   There is therefore no 100-agents-100-ports pool to allocate and
   no per-agent port quota: `listen({ port: 0 })` binds (or reuses)
   the single per-transport port, and demultiplexing to agents is
   by identity, not by port.

3. **We route on Ed25519 identity; gateway and `Transports`
   converge.**
   The two are not distinct ingress paths.
   The gateway's bearer-token boundary
   (`gateway-bearer-token-auth`) and the Noise ingress both resolve
   to an Ed25519 identity, and routing keys on that identity in
   both cases; the bearer token maps onto the same identity the
   transport routes on rather than standing up a parallel scheme.

4. **`connect()` accepts a public key and a connection hint from
   the locator.**
   The locator supplies the peer's Ed25519 public key (the routing
   target) together with a connection hint (`tcp:host=...`, relay
   address, etc.).
   `connect` takes the locator (exo or serialized string) and
   reads the public key and hint out of it; the public key, not the
   hint, is authoritative for routing.
   `connect`'s optional `{ hints? }` second argument is a per-call
   override of the locator's connection hint only (caller-first
   precedence; see *Capability Surface*), never of the routing key.

5. **`outboundPolicy` is a concrete matcher.**
   The proxy enforces `outboundPolicy` against the locator's
   connection hint before dispatching.
   A minimal policy is a suffix-match allowlist, with CIDR support
   for IP hints:

   ```js
   const outboundPolicy = {
     // allow if the hint host matches any suffix...
     allowHostSuffixes: ['.internal.example', 'localhost'],
     // ...or falls in any CIDR block
     allowCidrs: ['10.0.0.0/8', 'fd00::/8'],
     // schemes this agent may dial at all
     allowSchemes: ['np', 'tcp+syrups'],
     // default when nothing matches
     otherwise: 'deny', // 'deny' | 'allow'
   };
   ```

   `connect(locator)` extracts the hint (`{ scheme, host, port }`),
   checks `allowSchemes`, then requires a match in
   `allowHostSuffixes` or `allowCidrs`; a miss throws under
   `otherwise: 'deny'`.
   The routing target (the Ed25519 key) is not policy-checked here:
   `outboundPolicy` gates *where on the wire* the agent may dial,
   not *whom* it may address.

6. **An unregistered scheme throws.**
   If the agent calls `connect(npLocator)` and the daemon has no
   `np` netlayer, `connect` rejects.
   Silent fallback is rejected as a cap-discipline violation.

7. **The proxy does not expose underlying netlayer versions or
   capabilities to the agent.**
   Leaking host configuration outweighs the diagnostic value.
   `help()` returns a static string; there is no
   netlayer-capability introspection surface.

8. **Transports and `daemon-mount` stay independent for now.**
   A transport and a mount are both agent-held caps, but they do
   not share a revocation/audit surface in this design.
   A common surface is revisited when the capability-bus /
   capability-bank design lands (see *Capability bank
   integration*).

9. **The CLI is per-agent, and subagents can be created with
   delegated transports.**
   Per-agent suffices: fold the verbs into
   `endo agent <name> transports {list,add,revoke <handle>}`
   rather than a top-level `endo transports`. Each verb binds to a
   named method on the agent's `Transports` exo (*Capability
   Surface*):
   - `list` → `list()` (enumerate the agent's allowed schemes).
   - `add <scheme> [--port N] [--host H]` → `listen(scheme, opts)`:
     "adding a transport" means opening an inbound **listener** on a
     scheme, the durable, managed counterpart to a transient
     locator-driven `connect` (which the CLI does not surface as a
     verb — an outbound dial is issued by an agent from code with a
     locator in hand, not typed as a standing `transports` entry).
     The returned `Listener` is the handle a later `revoke` names.
   - `revoke <handle>` → `disconnect(handle)` (drop one session or
     listener; the fine-grained agent-facing verb, distinct from the
     host's whole-agent `revokeTransports`, see *Daemon Side*).

   It must be possible to create a subagent with **delegated**
   transports: a parent agent grants a subset of its transports
   (schemes, outbound policy, listen policy) to a child at
   formulation time, so delegation is a first-class CLI and API
   operation, not just host-minted provisioning. Its **named
   surface** is the same host method that mints any transports view —
   `provideTransports(childPetName, { delegateFrom: parentPetName,
   allowedSchemes, listenPolicy, outboundPolicy })` — invoked at
   subagent formulation with `delegateFrom` naming the parent and the
   policy fields narrowing (never widening) the parent's grant; the
   daemon rejects any field that exceeds the parent's. This is a
   `provideTransports` of a **new** child petName, so it does not
   collide with the reject-on-existing rule of Decision #11. The CLI
   spelling is a flag on the subagent-creation command
   (`endo mkguest <child> --transports-from <parent>
   [--schemes np,tcp+syrups] [--listen none|request|allow]
   [--outbound <policy>]`), not the `add` verb above — `add` operates
   on an existing agent's own view, delegation provisions a child's.
   The delegated child gets its **own fresh** per-agent Ed25519
   identity (a distinct `Transports` capability provisioned with a
   narrowed slice of the parent's policy), not a share of the
   parent's signing key. Because routing, revocation, and demux all
   key on Ed25519 identity (Decision #3), sharing the parent's key
   would collapse the child's sessions when the parent is revoked
   or `shutdown()`, violating the per-agent isolation this design
   rests on. With a forked identity the child survives parent
   revocation; the parent-to-child liveness edge is instead carried
   by the formulation `thisDiesIfThatDies` chain (see *Garbage
   Collection*), so disincarnating the parent still cascades to the
   child, but revoking the parent's *transports* does not.

10. **Retire `@nets`.**
    `@nets` is not kept as a host-only special name.
    The host reads the available schemes through
    `@transports.list()` and installs netlayers through the
    host-only `registerNetwork(scheme, networkServiceId)` method
    (the daemon-internal registry's write side, see *Netlayer
    Registration Moves to a Host-Internal Path*); there is no
    surviving directory-shaped `@nets` view for any agent, host
    included.
    The cutover (see *Replacing `@nets`*) removes `@nets`
    outright, with no deprecation window.

11. **Policy is revised without regenerating identity;
    re-`provideTransports` is a reject, not a silent re-mint.**
    `provideTransports` bundles a durable identity (`signingKeys`)
    with revisable policy (`allowedSchemes`/`listenPolicy`/
    `outboundPolicy`), which have different natural lifecycles:
    tightening an allowlist or narrowing a scheme grant is the exact
    mid-lifetime operation Limitation #2 ("No revocation") motivates,
    while the identity must stay put so peers keep recognizing the
    agent (and so a delegated child's identity is not disturbed by the
    parent's, Decision #9). So the host exposes a dedicated
    `updateTransportsPolicy(petName, policyPatch)` that replaces the
    policy fields on an existing `Transports` in place — same formula,
    same `signingKeys`, same durable identity — and takes effect on
    subsequent `connect`/`listen` calls (in-flight sessions already
    admitted are not retroactively torn down; a tightening operator
    who needs immediate teardown uses `revokeTransports`). Narrowing
    a policy therefore never requires round-tripping the old signing
    keys back through a re-provision. Correspondingly,
    `provideTransports` on a petName that is **already provisioned
    rejects** rather than replacing in place or silently minting a
    fresh identity: it is provisioning, not update. Re-provisioning
    from scratch is `revokeTransports(petName)` (which tears the old
    view down, identity included) followed by a fresh
    `provideTransports`; the two-call shape makes the identity
    discontinuity explicit at the call site rather than hiding it
    inside an overloaded formulate.

## Out of Scope, Future Work

- **Cross-language transport adapters.**
  The `endor` Rust daemon will need its own `@transports`
  implementation; the cap surface should be portable but the
  implementation is per-runtime.
  Concretely, `endor` should be able to benefit from transports
  implemented in Node.js workers, and this design should be
  integrated well enough to make that path available **for parity
  testing**: the JS-worker transport is the reference the Rust
  runtime is checked against, not a throwaway.

- **Alternative transports (QUIC, WebTransport, Tor).**
  Each is its own design and is left as an exercise for the
  future; we do intend to support some of these.
  The `@transports` envelope must accept any scheme the
  netlayer registry supports.

- **Cross-peer revocation propagation.**
  This is orthogonal to this change.
  The daemon supports multiple levels of revocation, and OCapN
  (and other CapTPs) are responsible for ensuring that session
  termination both revokes all pending promises over the session
  and partitions presences.
  Partitioning presences is not yet visible, and there are designs
  in flight to address that; this change need not carry the
  concern, **except** for one invariant that *is* in scope: when a
  transport's formula is collected and its instance is consequently
  cancelled/disincarnated, it must **close all of its sessions**,
  so that every presence and promise carried over them is
  partitioned/rejected.
  (When daemon Y revokes agent B, agent A on daemon X may still
  hold a `Session` handle; today that session simply fails on next
  message, and a future design may add a revocation notification
  channel.)

- **Fine-grained per-locator policy.**
  Today the `outboundPolicy` is a single allowlist (per *Design
  Decisions* #5).
  Per-target rate limits, audit logging, and budget enforcement
  are deferred to a **follow-up design that we plan to post upon
  completion of this change**.

- **Capability bank integration.**
  The capability bank is an abstract requirement: it does not
  impose requirements on this proposal other than that it should
  exist.
  When `daemon-capability-bank` (M5) lands, `@transports` becomes
  one of the capabilities the bank manages, alongside `@mount`,
  `@timer`, etc.
  This design does not pre-empt that integration; the `Transports`
  exo is shaped to fit a future bank surface.

## Test Plan

Concrete tests come with the implementation PR.
Shape only:

- **Unit: `Transports` exo.**
  Mock `TransportFactory`; verify `connect`, `listen`,
  `disconnect`, `shutdown` dispatch, and revocation.

- **Integration: per-agent isolation.**
  Two agents on the same daemon, each with `@transports`.
  Agent A's `shutdown()` does not affect agent B's sessions.
  Agent A cannot enumerate agent B's listeners.

- **Integration: per-agent identity.**
  Two agents present distinct Ed25519 identities to a remote
  peer.
  The remote sees two distinct `OcapnLocation` designators.

- **Integration: inbound identity demux (Design Decision #2).**
  Two agents both `listen()` on the same shared per-transport
  port. An inbound session addressed to agent A's Ed25519 key is
  delivered only to A's `Transports` view and never to B, and a
  session addressed to B never reaches A. Exercises the shared
  socket / identity-routed demultiplexing that Design Decision #2
  rests on (the inverse of the outbound "per-agent identity" case
  above).

- **Integration: revocation.**
  Host calls `revokeTransports(petName)`; agent's outstanding
  sessions fail; sibling agents unaffected.

- **Integration: daemon restart.**
  Agent's `Transports` formula restores; signing keys
  preserved; outstanding sessions are not preserved (correct
  behavior, documented).

- **Integration: `@nets` is gone.**
  A formulated agent exposes `@transports` and no `@nets`;
  a lookup of `@nets` fails (there is no coexistence window to
  test; the cutover is complete).

- **Integration: cross-agent loopback.**
  Two local agents connect via `connect(locatorOfSibling)`;
  no Noise handshake; in-process delivery.

- **Integration: cross-daemon Noise.**
  Two daemons, each with one agent; A connects to B over `np`
  netlayer; CapTP message round-trips.

- **Unit: `outboundPolicy` matcher (Design Decision #5).**
  Drive the matcher directly: a hint whose host matches
  `allowHostSuffixes` connects; one in an `allowCidrs` block
  connects; a scheme absent from `allowSchemes` throws; a hint
  matching neither suffix nor CIDR throws under `otherwise: 'deny'`
  and connects under `otherwise: 'allow'`. Confirms the gate runs on
  the locator's connection hint (the wire target), never on the
  Ed25519 routing key.

- **Integration: unregistered scheme throws (Design Decision #6).**
  With no `np` netlayer registered, `connect(npLocator)` rejects;
  assert no silent fallback to another scheme. Symmetrically,
  `listen('np')` rejects.

- **Integration: privilege separation of `registerNetwork`.**
  An agent's `@transports` view exposes no way to install a
  netlayer: assert `registerNetwork` is absent from the
  `Transports` interface and is reachable only as a host method on
  `@host`; a formulated agent holding only `@transports` cannot
  enumerate or write the daemon-internal registry, only use the
  schemes its policy allows (see *Netlayer Registration Moves to a
  Host-Internal Path*, Design Decision #10).

- **Integration: delegated subagent transports (Design Decision #9).**
  A parent provisioned with `['np', 'tcp+syrups']` delegates via
  `provideTransports(child, { delegateFrom: parent, allowedSchemes:
  ['np'] })`: assert the child gets a **fresh** Ed25519 identity
  distinct from the parent's (a remote peer sees two designators),
  that a delegation attempting to widen beyond the parent's grant
  (e.g. `allowedSchemes: ['np','tcp+syrups','iroh']`) is rejected,
  and — the asymmetric liveness/revocation split — that
  `revokeTransports(parent)` leaves the child's sessions **alive**
  (forked identity) while disincarnating the parent agent **cascades**
  to the child through the `thisDiesIfThatDies` chain (see *Garbage
  Collection*).

- **Integration: policy update preserves identity (Design Decision #11).**
  `updateTransportsPolicy(agent, { allowedSchemes: ['np'] })` on an
  agent provisioned with `['np','tcp+syrups']` narrows the grant —
  a subsequent `connect` on `tcp+syrups` throws — while the agent's
  Ed25519 identity is unchanged (same designator to a remote peer);
  and `provideTransports` on the already-provisioned petName rejects
  rather than re-minting.

## Compatibility Considerations

- This is a breaking change to the agent-facing API.
  `@nets` becomes `@transports` with a different shape.
  Agents that look up `@nets` directly break; because this is
  not widely deployed there is no compatibility shim; the few
  such agents are updated to `@transports` in the same change.

- The daemon's persistence format gains a new formula type
  (`Transports`).
  Old daemon state files lack it; on resolve the daemon
  formulate-on-first-resolve populates `@transports` for any
  agent that lacks it and drops `@nets`.

- The CLI gains per-agent
  `endo agent <name> transports` verbs (Design Decisions #9);
  `endo nets` is **retired** together with `@nets` (#10) outright,
  with no deprecation window (there is no migration window to
  warn through).

## Upgrade Considerations

- Agents bundled with the daemon (Lal, Fae, Familiar) must be
  updated to use `@transports`.
  This is coordinated with the consolidated
  [endojs/endo-but-for-bots#111](https://github.com/endojs/endo-but-for-bots/issues/111)/[endojs/endo-but-for-bots#112](https://github.com/endojs/endo-but-for-bots/issues/112)/[endojs/endo-but-for-bots#113](https://github.com/endojs/endo-but-for-bots/issues/113)
  stack
  (item (a) of [endojs/endo-but-for-bots#118](https://github.com/endojs/endo-but-for-bots/issues/118)).

- External consumers of `@endo/ocapn` are unaffected; the
  network-transport-separation work governs their surface.

- The `loopback-network` formula in
  `packages/daemon/src/networks/loopback.js` is repurposed:
  the `TransportFactory` proxy uses it as the default for
  in-daemon sibling connections.
  Existing test fixtures that use `@nets` to reach the loopback
  are updated to `@transports` in the same change; there is no
  migration shim.
