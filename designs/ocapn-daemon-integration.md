# OCapN integration with the daemon: per-agent `@transports`

| | |
|---|---|
| **Created** | 2026-05-07 |
| **Author** | kriscendobot (steward, prompted by kriskowal) |
| **Status** | Not Started |
| **Source** | Issue [endojs/endo-but-for-bots#118](https://github.com/endojs/endo-but-for-bots/issues/118) |

## What is the Problem Being Solved?

The daemon today exposes the OCapN-adjacent network surface as a single
host-wide `@nets` capability.
`packages/daemon/src/host.js` and `packages/daemon/src/guest.js` both
inject the same `networksDirectoryId` under the special name `@nets`,
which resolves to a daemon-singleton directory of named netlayer
formulas (loopback, ws-relay, libp2p, tcp-netstring).
Every agent the daemon hosts sees the same registry, can list every
registered net, and can connect through every net the daemon knows
about.

The just-consolidated OCapN-Noise stack
(PR [endojs/endo-but-for-bots#118](https://github.com/endojs/endo-but-for-bots/issues/118)
item (a), folding PRs
[endojs/endo-but-for-bots#111](https://github.com/endojs/endo-but-for-bots/issues/111),
[endojs/endo-but-for-bots#112](https://github.com/endojs/endo-but-for-bots/issues/112),
[endojs/endo-but-for-bots#113](https://github.com/endojs/endo-but-for-bots/issues/113)
into `llm`) introduces a real, mutually
authenticated transport family for the daemon to mediate.
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

### Out of scope

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

### Capability surface

#### Agent side: `Transports`

Each agent holds a single `Transports` exo, registered in its
pet store under the special name `@transports`.
The exo presents these methods:

```js
const TransportsInterface = M.interface('Transports', {
  // Discovery
  list: M.call().returns(M.promise()),                // → Locator[]
  has: M.call(M.string()).returns(M.promise()),        // scheme

  // Outgoing sessions
  connect: M.call(M.any())                             // Locator | string
    .optional(M.record())                              // { hints? }
    .returns(M.promise()),                             // → Session

  // Incoming sessions
  listen: M.call(M.string())                           // scheme
    .optional(M.record())                              // { port?, host? }
    .returns(M.promise()),                             // → Listener

  // Lifecycle
  disconnect: M.call(M.any()).returns(M.promise()),    // handle
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

#### Daemon side: `TransportFactory`

`HostInterface` (`packages/daemon/src/interfaces.js`) gains:

```js
provideTransports(petName, options): Promise<Transports>
```

where `options` carries:

- `allowedSchemes`: `['np', 'tcp+syrups', ...]` — the schemes the
  agent may use; defaults to the host's currently-enabled set.
- `signingKeys`: optional, defaults to a fresh per-agent Ed25519
  pair (see `daemon-agent-network-identity`); a host may supply
  its own keys for agents that need a stable network identity.
- `listenPolicy`: `'none' | 'request' | 'allow'` — whether the
  agent may open listening sockets, may request that the daemon
  open one on its behalf, or may not listen at all.
- `outboundPolicy`: optional address allowlist or matcher.

The host side wraps each agent's `Transports` exo over the
daemon's underlying network primitives.
The wrapper is the host-side proxy in the in-guest-backend +
host-side-proxy pattern: the agent holds the facade, the daemon
holds the actual netlayer instances and routes between them.

### Layer cake

```
Agent (worker realm)
  ↑ holds: Transports exo (per-agent)
       methods: connect(locator), listen(scheme), disconnect(h),
                list(), shutdown(), help()
─── daemon-side membrane (CapTP / formula boundary) ───
TransportFactory exo (host-side proxy)
  ↑ holds: ref to underlying netlayer registry
       per-agent state: signing keys, allowed schemes,
                        outstanding listeners, outstanding
                        sessions, revocation handles
─── netlayer membrane ───
Underlying netlayer formulas (daemon singletons)
  • OCapN-Noise (`np`) — uses `@endo/ocapn-noise` bindings
  • TCP+Syrups (`tcp+syrups`) — uses `@endo/syrups` framing
  • Loopback — uses in-process queues
  • ws-relay — uses WebSocket via relay server
─── @endo/ocapn membrane ───
@endo/ocapn (NonceLocator, CBOR codec, OCapN core)
@endo/ocapn-noise (Noise IK handshake, ChaCha20-Poly1305)
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

`@nets` is not provided to new agents.
Existing agents whose pet stores contain `@nets` continue to
resolve it during the migration window (see Migration path).

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

#### Garbage collection

A `Transports` proxy participates in the daemon's existing
`thisDiesIfThatDies` chain.
When the agent dies, its proxy dies, which cascades to outstanding
sockets and listeners.
Underlying netlayer formulas have no incoming reference from the
proxy; they are pinned by the daemon's `@endo` formula and
collected only at daemon shutdown.

#### Daemon restart

Per-agent signing keys are persisted with the `Transports`
formula's deferred-task params so that the restored agent presents
the same network identity.
Outstanding sessions do not persist; they are re-established on
demand.
Listeners re-bind to their configured ports if the host policy
permits; otherwise the agent must re-call `listen()`.

### Capability sharing across agents

When two agents within the same daemon need to talk over the same
Noise session, they do not coordinate via the `Transports` exo.
The daemon brokers internally:

- Agent A calls `connect(locatorB)` against its `Transports`.
- The proxy resolves `locatorB` to a local agent and returns a
  loopback session (no Noise handshake; in-process direct cap
  forwarding).
- For two agents on different daemons, each holds its own Noise
  session over the underlying transport; they share the wire
  but not the capability.

The netlayer is responsible for connection coalescing (one Noise
socket carrying CapTP for many local-agent sessions); the
`Transports` proxy presents an independent session per agent so
that revocation, accounting, and identity remain per-agent.

### Migration path from `@nets`

#### Step 1: shadow the singleton

Add a `Transports` formula type and `provideTransports` host
method.
For new agents, populate `@transports` instead of `@nets`.
For existing agents, populate both during the transition.
The agent-side code can probe `@transports` first and fall back
to `@nets`.

#### Step 2: route `@nets` callers through `@transports`

The current callers of `@nets` (per `grep`, primarily test
fixtures, `host.js:200`, and `daemon.js:4762` `makePeer`) move
to look up `@transports` and call `connect(locator)` rather than
listing nets and selecting one.
`getAllNetworkAddresses` becomes a daemon-internal helper used by
the `TransportFactory` proxy; it is not surfaced to agents.

#### Step 3: remove `@nets` injection

Once all internal callers have migrated and a deprecation period
has elapsed, remove `@nets` from `specialNames` in `host.js` and
`guest.js`.
The `networksDirectoryId` parameter remains on the formulation
path because the daemon still needs the underlying netlayer
registry; only the agent-facing surface is removed.

#### Step 4: per-agent signing keys

With `@transports` in place, the per-agent Ed25519 key path
(blocked today on the singleton) becomes natural.
This is `daemon-agent-network-identity` (M2, Not Started); the
two designs land together.

### Capability sharing across agents (cross-daemon)

Two daemons connecting over OCapN-Noise:

- Daemon X's agent A calls `connect(locator)` where `locator`
  designates an agent B on daemon Y.
- A's `Transports` proxy on X dispatches to the `np` netlayer.
- The `np` netlayer either reuses an existing Noise session to
  Y (if X and Y are already connected) or initiates a new Noise
  IK handshake.
- The session delivers a CapTP channel scoped to A↔B; other
  agents on X with their own sessions to agents on Y reuse the
  same Noise session at the wire level but hold independent
  CapTP channels at the cap level.

This matches the `OcapnNetwork` model from
`ocapn-network-transport-separation`; the per-agent layer sits
on top of (not in lieu of) the per-daemon netlayer.

## Affected Packages

- `packages/daemon/` — `host.js`, `guest.js`, `daemon.js`,
  `interfaces.js`, `types.d.ts`, `formula-type.js`,
  `help-text-data.js`.
- `packages/ocapn/` — must expose `OcapnNetwork` registration
  surface that the proxy consumes (depends on
  `ocapn-network-transport-separation`).
- `packages/ocapn-noise/` — no changes; bindings are consumed by
  the netlayer that the proxy fronts.
- `packages/ocapn-noise-network/` (new, per `ocapn-noise-network`
  design) — provides the `np` netlayer the proxy dispatches to.
- `packages/cli/` — `endo transports` verb (parallel to
  `endo nets`).

## Open Questions

1. **Should `Transports` be a formula or an exo with daemon
   internals?**
   A formula gets durability and named-pet-store presence for
   free, but every method call crosses a formula boundary.
   An exo with daemon internals is faster but needs explicit
   restart handling.
   The `Mount` precedent (formula) suggests the former.

2. **Where does the listening-port allocator live?**
   If 100 agents each `listen({ port: 0 })`, the daemon hands
   out 100 ephemeral ports from a single host pool.
   Should the host hold a per-agent quota, or is the OS-level
   ephemeral pool sufficient?

3. **How does `@transports` interact with the gateway's bearer
   token auth?**
   `gateway-bearer-token-auth` mints session keys at the
   gateway boundary.
   When a remote agent connects via Noise, it presents an
   Ed25519 identity, not a bearer token.
   Do we map between them, or are gateway and `Transports`
   distinct ingress paths?

4. **Should `connect()` accept a `Locator` exo (handle) or a
   serialized locator string?**
   Both are useful: exos are GC-friendly, strings are
   composable into config.
   Probably accept either, with a runtime branch.

5. **How are transport hints validated against `outboundPolicy`?**
   A locator carries connection hints (`tcp:host=...`).
   The proxy must enforce `outboundPolicy` before dispatching.
   What is the policy DSL?
   A simple suffix-match allowlist is the minimum; CIDR support
   would be useful.

6. **What is the failure mode when an agent's allowed scheme is
   not registered in the daemon?**
   The agent calls `connect(npLocator)` but the daemon has no
   `np` netlayer.
   Throw, or silently fall back?
   Throwing is the cap-discipline answer.

7. **Should a `Transports` proxy expose the underlying netlayer
   versions / capabilities to the agent?**
   E.g., "this daemon's `np` netlayer supports IK pattern but
   not XX".
   Useful for diagnostics; risks leaking host configuration.
   `help()` returning a static string is the minimum.

8. **How does the proxy interact with `daemon-mount`'s confinement
   boundary?**
   A mount is an agent-held filesystem cap; a transport is an
   agent-held network cap.
   Should they share a common revocation/audit surface, or
   stay independent?
   Probably independent for now; revisit when the capability-bus
   design lands.

9. **What CLI surface does the user see?**
   `endo transports list`, `endo transports add`, `endo
   transports revoke <handle>`?
   Or fold into `endo agent <name> transports ...`?

10. **Do we keep `@nets` as a host-only special name?**
    The host (the root agent) might still benefit from a
    directory-shaped view of registered netlayers.
    Or is `@transports.list()` plus a daemon-internal API
    sufficient even for the host?

## Out of Scope, Future Work

- **Cross-language transport adapters.**
  The `endor` Rust daemon will need its own `@transports`
  implementation; the cap surface should be portable but the
  implementation is per-runtime.

- **Alternative transports (QUIC, WebTransport, Tor).**
  Each is its own design.
  The `@transports` envelope must accept any scheme the
  netlayer registry supports.

- **Cross-peer revocation propagation.**
  When daemon Y revokes agent B, agent A on daemon X may still
  hold a `Session` handle.
  Today, the session simply fails on next message.
  A future design may add a revocation notification channel.

- **Fine-grained per-locator policy.**
  Today the `outboundPolicy` is a single allowlist.
  A future design may add per-target rate limits, audit
  logging, or budget enforcement.

- **Capability bank integration.**
  When `daemon-capability-bank` (M5) lands, `@transports`
  becomes one of the capabilities the bank manages, alongside
  `@mount`, `@timer`, etc.
  This design does not pre-empt that integration; the
  `Transports` exo is shaped to fit a future bank surface.

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

- **Integration: revocation.**
  Host calls `revokeTransports(petName)`; agent's outstanding
  sessions fail; sibling agents unaffected.

- **Integration: daemon restart.**
  Agent's `Transports` formula restores; signing keys
  preserved; outstanding sessions are not preserved (correct
  behavior, documented).

- **Integration: migration.**
  Agent with `@nets` (legacy) and `@transports` (new) coexist;
  `@nets` callers continue to work; new callers prefer
  `@transports`.

- **Integration: cross-agent loopback.**
  Two local agents connect via `connect(locatorOfSibling)`;
  no Noise handshake; in-process delivery.

- **Integration: cross-daemon Noise.**
  Two daemons, each with one agent; A connects to B over `np`
  netlayer; CapTP message round-trips.

## Compatibility Considerations

- This is a breaking change to the agent-facing API.
  `@nets` becomes `@transports` with a different shape.
  Agents that lookup `@nets` directly will break unless they
  fall back via the migration path.

- The daemon's persistence format gains a new formula type
  (`Transports`).
  Old daemon state files lack it; the daemon must
  formulate-on-first-resolve when an agent's pet store has
  `@nets` but no `@transports`.

- The CLI gains `endo transports` verbs; `endo nets` is
  deprecated and emits a warning pointing at `endo
  transports`.

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
  Existing test fixtures that use `@nets` to reach the
  loopback continue to work via the migration shim.
