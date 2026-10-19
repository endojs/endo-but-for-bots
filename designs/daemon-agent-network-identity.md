# Daemon Agent Network Identity

| | |
|---|---|
| **Created** | 2026-03-02 |
| **Author** | Kris Kowal (prompted) |
| **Status** | In Progress |
| **Updated** | 2026-10-19 |

## What is the Problem Being Solved?

The [daemon-256-bit-identifiers](daemon-256-bit-identifiers.md) design
migrated the daemon to 256-bit identifiers and gave every host and guest
agent its own Ed25519 keypair (accessible via the `@keypair` special name).
The core migration is complete: keypairs are generated, stored as formulas,
and available to agents.

However, the keypairs are not yet fully integrated. Four pieces of work
connect per-agent keypairs to the network layer and to the formula identifier
system:

1. **~~Locator construction with agent keys.~~** *(Done)* Each agent now
   stamps outgoing locators with its own Ed25519 public key. Two agents on
   the same daemon produce different locators for the same underlying formula.

2. **~~LOCAL_NODE for formula storage.~~** *(Done)* Locally-stored formula
   identifiers use `LOCAL_NODE` (`'0'.repeat(64)`) as the node component.
   The daemon maintains a `localKeys` registry of all agent public keys;
   `isLocalKey` recognizes any of them. `externalizeId` replaces LOCAL_NODE
   with the agent's key; `internalizeLocator` normalizes any local key back
   to LOCAL_NODE. Pet store repair handles old-format identifiers on startup.

3. **~~Per-agent networks (NETS).~~** *(Done)* Each agent has its own NETS
   special name pointing to a networks directory that determines which
   network addresses appear as connection hints in locators produced by
   `locate()`, `locateForSharing()`, and `invite()`. A guest gets a fresh,
   empty networks directory unless its creator supplies one. See
   "Per-Agent Networks" section below.

4. **~~Network registration.~~** *(Done)* The daemon registers each
   incarnated agent's public key with the networks in that agent's own
   NETS, and unregisters it when the agent's context is cancelled or the
   network leaves the agent's NETS. The OCapN-Noise network keeps the
   registered keys and answers `servesAgent(publicKey)` on its peer entry
   point. See "Network Registration" below.

The per-agent connection hints (relay requirements, transport preferences)
remain unbuilt; see "Per-Agent Connection Hints" below.

## Design

### Network Registration

Each installed network (accessible through the NETS formula) needs to know
the public keys of all active agents so the network layer can accept and
negotiate connections on behalf of any persona.

**Registration flow:**

1. When an agent with a keypair is incarnated, the daemon registers that
   agent's public key with every network in the agent's own NETS. An agent
   with an empty NETS is registered with no network, so no network can
   disclose that the daemon hosts it (see "Persona privacy" below).
2. Before an agent reads its network addresses (`locate`, `getPeerInfo`,
   invitations), the daemon reconciles the registrations of every agent
   sharing that NETS directory: it registers with networks added since the
   last reconciliation and unregisters from networks since removed. A
   network added to an agent's NETS therefore holds the agent's key before
   any locator advertising that network leaves the daemon. Reviving the
   root networks on startup reconciles every incarnated agent, covering
   agents incarnated before their networks.
3. When the agent's context is cancelled (collection, or daemon shutdown),
   the daemon unregisters its key from every network that holds it.
4. When a network receives an inbound connection, it can identify which local
   agent the remote peer is trying to reach by matching the target public key.
   The OCapN-Noise network exposes this as `servesAgent(publicKey)` on its
   peer entry point.

**Interface:**

```typescript
interface EndoNetwork {
  // ... existing methods ...
  registerAgentKey(publicKey: string, agentId: FormulaIdentifier): Promise<void>;
  unregisterAgentKey(publicKey: string): Promise<void>;
}
```

This is additive. Both methods are optional; the daemon checks a network's
method names and skips networks that lack them. The daemon root keypair is
always registered as the default: the OCapN-Noise network serves its own node
from startup and refuses to unregister it.

### Per-Agent Networks (NETS)

Currently `NETS` is a special name only on the root host. It points to a
networks directory formula, and all child hosts created via `formulateHost`
share the same `networksDirectoryId`. Guests have no NETS at all.

**Goal:** Every agent (host and guest) gets its own `NETS` special name
pointing to its own networks directory. This controls which network addresses
appear as connection hints in locators produced by that agent's `locate()`,
`locateForSharing()`, `getPeerInfo()`, and `invite()`.

**Design:**

1. **Root agent startup.** The root host's NETS directory is the only one
   whose networks are pinned and started on daemon startup (the `endo`
   formula references `networks`). This is unchanged.

2. **Agent incarnation.** When any agent (host or guest) is incarnated, the
   daemon formulates a new networks directory for it and wires it as the
   agent's `NETS` special name. The guest formula gains a `networks` field
   (currently absent).

3. **Default contents.** A newly created agent's NETS directory starts
   empty. The creating host can populate it (e.g., by copying network
   references from its own NETS) or leave it empty if the agent should not
   be directly reachable.

4. **Connection hint resolution.** `getAllNetworkAddresses(networksDirectoryId)`
   already accepts a per-directory ID. The host passes its own
   `networksDirectoryId` to `locateForSharing`, `getPeerInfo`, and
   invitation construction. No change needed in the resolution path — only
   in how the directory ID is provisioned.

5. **Persona privacy.** An agent with an empty NETS produces locators
   without connection hints. Peers must already know how to reach the
   daemon through other means (e.g., they received hints from a different
   agent). This is the foundation for anonymizing personas that never
   reveal direct addresses.

**Formula changes:**

```typescript
// GuestFormula gains a networks field:
interface GuestFormula {
  type: 'guest';
  // ... existing fields ...
  networks: FormulaIdentifier;  // NEW: per-guest networks directory
}

// HostFormula already has networks — no change needed.
```

**Implementation steps:**

1. `formulateGuestDependencies`: formulate a new networks directory and
   include `networksDirectoryId` in the returned identifiers.
2. `formulateNumberedGuest`: add `networks: identifiers.networksDirectoryId`
   to `GuestFormula`.
3. Guest maker: accept `networksDirectoryId`, wire as `NETS` special name.
4. Guest `extractLabeledDeps`: include `['networks', formula.networks]`.

### Per-Agent Connection Hints

Each agent/persona can independently manage connection hints that control how
peers reach them on the network. This builds on Per-Agent Networks above:
each agent's NETS directory determines which transports it advertises.

**Examples of per-agent connection policies:**

- **Require anonymizing relay**: A pseudonymous persona may require all inbound
  connections to arrive through a relay, never revealing the daemon's network
  address.
- **Allow direct connections**: A named persona may accept direct TCP
  connections for lower latency.
- **Prefer specific transports**: A persona may prefer WebSocket over raw TCP,
  or vice versa.

**Storage:** Connection hints are stored per-agent alongside the keypair:

```typescript
type AgentConnectionHints = {
  publicKey: string;                // 64-char hex Ed25519 public key
  requireRelay?: boolean;           // force connections through relay
  allowDirectConnect?: boolean;     // accept direct inbound connections
  preferredTransports?: string[];   // ordered list of transport preferences
  relayAddresses?: string[];        // specific relay nodes to use
};
```

Connection hints are advisory — the network layer uses them to configure
listener behavior and to advertise appropriate addresses to peers, but the
agent's keypair is the ultimate identity.

### Locator Construction with Agent Keys

When an agent constructs a locator for external consumption, it should use
*its own* public key as the peer/node component, not `localNodeNumber`. This
means the same local formula can appear under different locators depending on
which agent is sharing it.

### Null Local Node in Formula Keys

With multiple agent public keys, there is no single canonical
`localNodeNumber` to embed in formula keys for locally-stored formulas. Using
any specific agent's public key would create an artificial dependency between
formula storage and agent identity.

**Sentinel Local Node:**

Use 64 characters of `'0'` (`'0'.repeat(64)`) as a sentinel local node value
in locally-stored formula keys. This is analogous to how `0.0.0.0` works in
networking — a "this host" placeholder that is never a valid Ed25519 public key
(since the all-zeros point is not on the curve).

```js
const LOCAL_NODE = /** @type {NodeNumber} */ ('0'.repeat(64));
```

**Formula key construction:**

```js
// Local formula key (stored on disk)
const localId = formatId({ number: formulaNumber, node: LOCAL_NODE });

// Locator for external consumption (agent-specific)
const locator = formatId({ number: formulaNumber, node: agentPublicKey });
```

**`isLocalId` change:**

```js
// Current
const isLocalId = id => parseId(id).node === localNodeNumber;

// Proposed
const isLocalId = id => parseId(id).node === LOCAL_NODE;
```

**Inbound locator normalization:** When receiving a locator from the network
and converting it to a formula key for local storage, the daemon replaces the
agent's public key with `LOCAL_NODE`:

```js
const normalizeInboundId = id => {
  const { number, node } = parseId(id);
  if (isKnownLocalKey(node)) {
    return formatId({ number, node: LOCAL_NODE });
  }
  return id; // remote formula, keep as-is
};
```

**Outbound locator construction:** When constructing a locator for external
consumption, the daemon replaces `LOCAL_NODE` with the sharing agent's public
key:

```js
const externalizeId = (id, agentPublicKey) => {
  const { number, node } = parseId(id);
  if (node === LOCAL_NODE) {
    return formatId({ number, node: agentPublicKey });
  }
  return id; // remote formula, keep as-is
};
```

## Dependencies

- [daemon-256-bit-identifiers](daemon-256-bit-identifiers.md) — provides the
  per-agent keypairs and 256-bit identifier infrastructure this design builds
  on.
- [ocapn-network-transport-separation](ocapn-network-transport-separation.md)
  — the network abstraction layer that will implement `registerAgentKey`.
- [daemon-capability-persona](daemon-capability-persona.md) — the persona
  system that motivates per-agent network identity.

## Related Designs

- [daemon-256-bit-identifiers](daemon-256-bit-identifiers.md) — parent design;
  this was originally the "Future Work" section of that document.
- [daemon-locator-terminology](daemon-locator-terminology.md) — locator format
  changes that interact with local-node normalization.
- [ocapn-noise-network](ocapn-noise-network.md) — the OCapN-Noise protocol
  that uses Ed25519 keys for peer authentication.
