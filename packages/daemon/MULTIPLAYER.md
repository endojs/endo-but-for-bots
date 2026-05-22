# Multiplayer Demo: Cross-Node Chat

This guide walks through connecting two Endo daemons and exchanging
messages and capabilities between them using the chat UI.

## Overview

Each Endo daemon runs on a separate machine (or in a separate directory on
the same machine). After enabling networking on both daemons, one side
creates an invitation and the other accepts it. From that point on, both
sides can send messages, share values, and make requests across the
network.

Three network transports are available:

- **OCapN-Noise** (`setup-ocapn.js`): Daemon-to-daemon connections
  carried by an authenticated, encrypted OCapN-Noise session over TCP.
  This is the transport the daemon is migrating to for all
  daemon-to-daemon connectivity — see
  [`designs/daemon-ocapn-external-connectivity.md`](../../designs/daemon-ocapn-external-connectivity.md).
- **TCP** (`/network`): Direct TCP connections with netstring framing,
  carrying plaintext JSON CapTP. Requires an open port. Retained for
  now; superseded by the OCapN-Noise transport.
- **iroh** (`/network-iroh`): Peer-to-peer over iroh ("dial keys, not
  IPs"). Peers are dialed by their Ed25519 NodeId and resolved through
  iroh discovery and relays over mutually authenticated, encrypted QUIC.
  No open ports needed; NAT traversal and relay fallback are built in.

The OCapN-Noise transport uses the OCapN (Object Capability Network)
protocol for capability transport; the TCP and iroh transports use
CapTP (Capability Transfer Protocol). In all three, object identity is
preserved across the wire — capabilities sent in a message can be
adopted by the recipient and used as if they were local. CapTP also
carries the daemon's local edges (daemon-to-worker, daemon-to-CLI, and
the browser web gateway), which are unaffected by the OCapN migration.

## Prerequisites

- Two running Endo daemons (see below for single-machine setup)
- The chat UI running against each daemon (`yarn dev` in `packages/chat`)
- The network module path on disk (TCP or iroh)

### Single-Machine Setup

To run two daemons on one machine, start each with separate state
directories. Endo uses the XDG base directory variables and `ENDO_SOCK`
to locate its state, cache, ephemeral state, and Unix socket.

Define a helper for each persona to avoid repeating the env vars:

```bash
# Alice uses the system default (no env vars needed)
alias alice='yarn exec endo'

# Bob uses a separate state tree
alias bob='XDG_STATE_HOME=/tmp/endo-bob/state \
  XDG_RUNTIME_DIR=/tmp/endo-bob/run \
  XDG_CACHE_HOME=/tmp/endo-bob/cache \
  ENDO_SOCK=/tmp/endo-bob/endo.sock \
  ENDO_ADDR=127.0.0.1:8921 \
  yarn exec endo'
```

Create Bob's directories and start both daemons. Use `restart` rather
than `start` — `start` hangs if a daemon is already running on the same
socket:

```bash
mkdir -p /tmp/endo-bob/{state,run,cache}
alice restart
bob restart
```

Verify both are responsive:

```bash
alice ping   # prints "ok"
bob ping     # prints "ok"
```

Run a chat UI instance for each daemon. The Vite dev server uses the
system daemon by default; for a second instance, pass the same env vars
Bob's daemon uses so the plugin reads the correct state directory,
connects to the correct gateway, and listens on a different port:

```bash
# Terminal 1 — Alice's chat (default port 5173)
yarn dev

# Terminal 2 — Bob's chat (port 5174)
XDG_STATE_HOME=/tmp/endo-bob/state \
  ENDO_SOCK=/tmp/endo-bob/endo.sock \
  ENDO_ADDR=127.0.0.1:8921 \
  VITE_PORT=5174 \
  yarn dev
```

## Step 1: Enable TCP Networking

Both daemons need a TCP network transport before they can connect to each
other. The transport is an unconfined caplet that opens a TCP listener.

### Using the Chat UI

In each chat window, run:

```
/network
```

Fill in the fields:

- **Module**: The `file://` URL to the TCP network module.
  Typically `file:///path/to/endo/packages/daemon/src/networks/tcp-netstring.js`
  (auto-detected when running via `yarn dev`)
- **Host**: `127.0.0.1` (default)
- **Port**: `8940` (default; use `0` for an OS-assigned ephemeral port)

The command stores the listen address, installs the network module as an
unconfined caplet, and moves it to the `NETS/tcp` directory where the
daemon discovers it as an active transport.

### Using the CLI

```bash
# Store the listen address so the network module can find it
yarn exec endo store --text "127.0.0.1:8940" --name tcp-listen-addr

# Install the network as an unconfined module (needs Node.js access for `net`)
yarn exec endo make --UNCONFINED packages/daemon/src/networks/tcp-netstring.js --powers @agent --name network-service

# Move to the networks directory
yarn exec endo mv network-service NETS/tcp
```

After this step, each daemon listens on an ephemeral TCP port and includes
its address in `getPeerInfo()`.

## Step 1b: Enable iroh Networking (Alternative)

iroh (https://www.iroh.computer) connects daemons by their Ed25519 NodeId
rather than by IP address — "dial keys, not IPs". It needs **no open ports
and no self-hosted infrastructure**: iroh discovery and its relay mesh
resolve a NodeId to live network paths and hole-punch a direct,
mutually authenticated, encrypted QUIC connection, falling back to relays
when a direct path is unavailable.

This is a good transport for connecting daemons across different networks
or behind NATs. It relies on the optional native
`@number0/iroh` binding, which is installed automatically where a prebuilt
binary is available.

### Using the Chat UI

In each chat window, run:

```
/network-iroh
```

Fill in the fields:

- **Module**: The `file://` URL to the iroh network module.
  Typically `file:///path/to/endo/packages/daemon/src/networks/iroh.js`

The module binds an in-memory iroh endpoint, derives a stable NodeId, and
registers itself in the daemon's `NETS/iroh` directory. No listen address
or relay configuration is needed.

### Using the CLI

```bash
# Install the iroh network (self-configures via iroh discovery, registers at NETS/iroh)
yarn exec endo run --UNCONFINED packages/daemon/src/networks/setup-iroh.js --powers @agent
```

After this step, each daemon has an iroh NodeId and is reachable through
iroh discovery and relays. The `endo://` invitation locator will include
an `iroh+captp0://` address alongside any TCP addresses.

For the security and identity model behind this transport — including how
the NodeId relates to the Endo node identity — see
[designs/iroh-network-design.md](./designs/iroh-network-design.md).

### Using Multiple Transports Together

You can enable any combination of these transports on the same daemon.
Invitation locators will include addresses for all active networks. When
the accepting daemon connects, it tries each address in order and uses the
first one that succeeds.

## Step 1c: Enable OCapN-Noise Networking

The OCapN-Noise transport carries daemon-to-daemon traffic over an
authenticated, encrypted OCapN session instead of plaintext CapTP. It
is installed as an unconfined caplet, the same way the other
transports are, and registers itself under `@nets/ocapn`.

### Using the Chat UI

In each chat window, run:

```
/network-ocapn
```

Fill in the fields:

- **Module**: The `file://` URL to the OCapN network module.
  Typically `file:///path/to/endo/packages/daemon/src/networks/ocapn.js`
  (auto-detected when running via `yarn dev`)
- **Host**: `127.0.0.1` (default)
- **Port**: `0` (default; OS-assigned ephemeral port)

The command stores the listen address under `ocapn-listen-addr`,
installs the network module as an unconfined caplet, and moves it to
`@nets/ocapn` where the daemon discovers it as an active transport.

### Using the CLI

```bash
# Install the OCapN-Noise network (registers at @nets/ocapn)
yarn exec endo run --UNCONFINED packages/daemon/src/networks/setup-ocapn.js --powers @agent
```

By default the transport binds an ephemeral local TCP port. To pin a
listen address, store it under `ocapn-listen-addr` before installing:

```bash
yarn exec endo store --text "127.0.0.1:8950" --name ocapn-listen-addr
```

After this step, each daemon advertises an `ocapn+noise+tcp://`
connection hint in the locators produced by `invite()`,
`locateForSharing()`, and `getPeerInfo()`. When the accepting daemon
connects, the session is established over OCapN-Noise.

> **Known limitation.** Until the
> [`daemon-agent-network-identity`](../../designs/daemon-agent-network-identity.md)
> work lands, the OCapN-Noise transport mints a fresh signing key per
> network rather than reusing the daemon agent's `@keypair`. The
> connection hint carries the full OCapN location so dialing still
> works, but the OCapN session identity is not yet bound to the
> daemon node number.

## Step 2: Create and Accept an Invitation

One side creates an invitation; the other accepts it. This establishes a
peer session and registers each side's host handle in the other's pet
store.

### Alice Creates the Invitation

In Alice's chat:

```
/invite
```

Fill in the **Guest name** field with the local name for the remote peer —
for example, `bob`. The command prints an `endo://` locator URL. Copy it.

For a daemon with TCP networking enabled, the locator looks like:

```
endo://abc123/42@tcp%2Bnetstring%2Bjson%2Bcaptp0%3A%2F%2F127.0.0.1%3A54321?type=invitation&from=7
```

The URL path is a sequence of `@`-delimited components.
The first component (here `42`) is the invitation's formula address; each
subsequent component is a connection hint of the form
`<transport-prefix>:<transport-payload>`, URL-encoded so that `@`, `/`,
and `?` inside a hint round-trip cleanly.

For a daemon with OCapN-Noise networking enabled, the locator instead
carries an `ocapn+noise+tcp:` connection hint that embeds the full
OCapN location (the agent's Ed25519 public key as the `designator`,
plus the TCP host/port hints).

When the accepting daemon dials this hint, the Noise IK handshake
authenticates Alice's agent against the `designator` (her Ed25519
public key) cryptographically — Alice's identity is *proven* by the
handshake rather than *asserted* in a `hello` string the way the TCP
path does it. Subsequent `E(remoteGateway).provide(formulaId)` calls
flow as native OCapN `op:deliver` messages on that one session; no
CapTP framing sits on top of the OCapN wire.

If a daemon has more than one transport installed (e.g. both
`@nets/tcp` and `@nets/ocapn`), the locator carries a connection hint
per transport and the accepting daemon dials the first one whose
protocol a local network module `supports`.

### Bob Accepts the Invitation

In Bob's chat:

```
/accept
```

Fill in:

- **Invitation**: Paste the `endo://` locator URL from Alice
- **Save as**: The local name for Alice — for example, `alice`

After acceptance, Alice's pet store has `bob` pointing to Bob's host
handle, and Bob's pet store has `alice` pointing to Alice's host handle.

### CLI Equivalent

Using the `alice` and `bob` aliases from the setup section:

```bash
alice invite bob
# (prints locator URL)

echo "endo://..." | bob accept alice
```

## Step 3: Send Messages

With the connection established, both sides can send messages with
attached capabilities.

### Sending a Message

In Alice's chat, type a message to Bob using the `@` reference syntax:

```
@bob Hello from Alice!
```

Press Enter to send. Bob's inbox will show the message.

### Sending a Message with Attached Values

First, create a value to share. In Alice's chat:

```
/js 'Hello, World!'
```

Save the result as `greeting` when prompted.

Then send it:

```
@bob Here is a greeting @greeting
```

The `@greeting` reference attaches the value's formula ID to the message.
Bob receives both the text and a reference to the value.

### Adopting Values from Messages

When Bob receives a message with attached values, he can adopt them into
his own pet store.

In Bob's chat:

```
/adopt
```

Fill in:

- **Message #**: The message number (shown in the inbox)
- **Edge**: The edge name from the message (e.g., `greeting`)
- **Save as**: A local pet name (e.g., `bobs-greeting`)

Bob can now use `bobs-greeting` as a local name. Looking it up resolves
the value through the peer connection:

```
/show bobs-greeting
```

This displays `'Hello, World!'` — fetched from Alice's daemon.

## Step 4: Requests and Replies

### Making a Request

Alice can request something from Bob:

```
/request
```

Fill in:

- **From**: `bob`
- **Description**: `Please share a number`
- **Save as**: `bobs-number` (where the resolved value will appear)

Bob sees the request in his inbox.

### Resolving a Request

Bob creates a value and resolves the request:

```
/js 42
```

Save as `answer`, then:

```
/resolve
```

Fill in:

- **Message #**: The request message number
- **Value**: `answer`

Alice's `bobs-number` now resolves to `42`.

### Replying to Messages

When Bob sees a message from Alice, he can reply directly. Select the
message in the inbox and use the reply action, or compose a new message to
`@alice`.

## How It Works

### Connection Lifecycle

The lifecycle has the same four stages regardless of transport; only
the bytes-and-handshake layer differs.

1. **Transport**: Each daemon runs a listener — TCP for `tcp-netstring`,
   TCP carrying an OCapN-Noise session for `ocapn`, or libp2p's
   transport stack for `libp2p`.
2. **Invitation URL**: Encodes the inviter's node id, host handle id,
   and one or more connection-hint addresses (TCP `at=tcp+netstring+
   json+captp0://…`, OCapN `at=ocapn+noise+tcp://…`, or libp2p
   multiaddrs).
3. **Accept**: The acceptor parses the locator, registers the inviter's
   peer info, iterates installed networks for one that `supports` the
   hint's protocol, dials it, and runs the `hello` handshake to
   exchange host-handle ids.
4. **Session**: A persistent session carries all subsequent `E()` calls
   between the daemons. Under `tcp-netstring` and `libp2p` this is a
   CapTP session over the dialled transport; under `ocapn` it is a
   single OCapN-Noise session — authenticated by the peer's Ed25519
   public key and encrypted by the Noise handshake — that the
   `EndoGreeter`/`EndoGateway` peer protocol rides on top of as
   `E()` calls inside the OCapN session.

The bootstrap object on each side is the same `EndoGreeter` regardless
of transport; under `ocapn` the dialing peer first fetches an
`EndoOcapnBootstrap` exo from the OCapN locator at a well-known
swissnum and pulls the greeter from it, while under
`tcp-netstring`/`libp2p` it is the CapTP session bootstrap directly.

### Formula IDs Across Nodes

Every value in Endo has a formula identifier that encodes both a formula
number and a node number. When Alice sends a value to Bob, the message
carries Alice's formula ID. When Bob adopts it, Bob's pet store records
the remote formula ID as a string. When Bob looks up the value, the daemon
detects the foreign node number, connects to Alice's daemon via the peer
gateway, and calls `E(gateway).provide(id)` to fetch the value.

### Reconnection

If the transport drops the underlying socket, the network module
cancels the peer formula context, which evicts the stale controller
from the daemon's cache. The next `provide()` call for any value on
the remote node triggers a fresh connection through the
`RemoteControl` state machine (which resets to its `start` state on
disconnection) and a fresh handshake — over a fresh CapTP session for
`tcp-netstring`/`libp2p`, over a fresh OCapN-Noise session for
`ocapn`. Persistent formula graph entries, pet store entries, and
message records are all strings that survive the reconnection.

Old live-object proxies (CapTP `Far` references, or OCapN imports)
are invalidated by a connection drop and must be re-resolved via
`provide(formulaId)`.

## Troubleshooting

### "Cannot connect to peer: no supported addresses"

The daemon has no network transport installed, or the one it has does
not `supports` the protocol named in the connection hint. Install one:
`/network` for TCP+CapTP, `/network-libp2p` for libp2p, or
`endo run --UNCONFINED packages/daemon/src/networks/setup-ocapn.js
--powers @agent` for OCapN-Noise.

### Invitation locator doesn't work

- Verify both daemons have networking enabled (TCP or iroh)
- For TCP: check that the address in the locator is reachable from the
  accepting machine (use `127.0.0.1` only for same-machine setups)
- For iroh: ensure both daemons have internet access (needed for iroh
  discovery and relay fallback)
- Ensure the inviting daemon is still running

### Adopted value hangs on lookup

The remote daemon may be unreachable. Check that:

- The remote daemon is running
- For TCP: the TCP port is accessible and no firewall is blocking it
- For iroh: both daemons have internet access for discovery and relay
  fallback (re-run `/invite` to get a fresh locator if paths change)

### Messages not appearing

- Check that the invitation was accepted on both sides
- Verify the recipient name matches the pet name from invite/accept
- Use `/ls` to confirm the peer name exists in the inventory

## Chat Commands Reference

| Command           | Description                                                |
|-------------------|------------------------------------------------------------|
| `/network`        | Enable TCP networking (module path + listen address)       |
| `/network-iroh`   | Enable iroh networking (no open ports needed)              |
| `/network-ocapn`  | Enable OCapN-Noise authenticated networking over TCP       |
| `/invite`         | Create an invitation for a peer (prints `endo://` locator) |
| `/accept`         | Accept an invitation locator and name the peer             |
| `/adopt`          | Adopt a value from a received message                      |
| `/request`        | Send a request to a peer                                   |
| `/resolve`        | Resolve a pending request with a value                     |
| `/reject`         | Reject a pending request                                   |
| `/show`           | Inspect a value (works for remote values too)              |
| `/ls`             | List names in inventory                                    |
