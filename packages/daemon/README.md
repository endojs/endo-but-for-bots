# Endo Daemon

This package provides the Endo daemon and controller.
The controller manages the Endo daemon lifecycle.

The Endo daemon is a persistent host for managing guest programs in hardened
JavaScript worker processes.
The daemon communicates through a Unix domain socket or named pipe associated
with the user, and manages per-user storage and compute access.

Over that channel, the daemon communicates in CapTP over netstring message
envelopes.
The bootstrap provides the user agent API from which one can derive facets for
other agents.

## Debugging

The daemon has structured logging and environment variable flags for
debugging formula lifecycle, CapTP messages, dependency graphs, and more.
See [DEBUGGING.md](./DEBUGGING.md) for the full guide.

Quick reference:

```sh
ENDO_GC=0 endo start           # disable formula garbage collection
ENDO_CAPTP_TRACE=1 endo start  # trace CapTP messages
ENDO_FORMULA_GRAPH=1 endo start # dump dependency graph at startup
endo log --all -f               # follow daemon + worker logs
```

## Gateway

The daemon runs a unified HTTP/WebSocket gateway server.
Set the `ENDO_ADDR` environment variable before running `endo start` to control the listen address and port (default `127.0.0.1:8920`).

```sh
ENDO_ADDR=127.0.0.1:9000 endo start
```

### Remote access

By default the gateway only accepts WebSocket connections from localhost
(`127.0.0.1`, `::1`, `::ffff:127.0.0.1`).  Connections from any other
client IP are closed with `"Only local connections allowed"`.

To accept connections from non-localhost clients (for example, over a VPN or
LAN), you must both **bind to a reachable interface** via `ENDO_ADDR` and
**opt in** with one of the two environment variables below.

#### Allow all remote connections

Set `ENDO_GATEWAY=remote` to disable the client-IP check entirely.
Every address that can reach the gateway port will be allowed through.

```sh
ENDO_ADDR=0.0.0.0:8920 ENDO_GATEWAY=remote endo start
```

#### Allow specific IP ranges (CIDR allowlist)

Set `ENDO_GATEWAY_ALLOWED_CIDRS` to a comma-separated list of CIDRs.
Localhost is always allowed in addition to the listed ranges.

```sh
ENDO_ADDR=0.0.0.0:8920 \
  ENDO_GATEWAY_ALLOWED_CIDRS="10.0.0.0/8,100.64.0.0/10" \
  endo start
```

Both IPv4 and IPv6 CIDRs are supported.  A bare address without a `/prefix`
is treated as a host route (`/32` for IPv4, `/128` for IPv6).  Invalid
entries are silently ignored.

IPv4-mapped IPv6 addresses (`::ffff:10.1.2.3`) are normalized before
matching, so an IPv4 CIDR like `10.0.0.0/8` will match connections that
arrive as `::ffff:10.x.x.x`.

#### Common CIDR examples

| Range | Description |
|---|---|
| `10.0.0.0/8` | RFC 1918 private (Class A) |
| `172.16.0.0/12` | RFC 1918 private (Class B) |
| `192.168.0.0/16` | RFC 1918 private (Class C) |
| `100.64.0.0/10` | CGNAT / Tailscale |
| `fd00::/8` | IPv6 unique local addresses |

> **Security note:** These options control which client IPs may establish a
> WebSocket connection to the gateway.  They do not add authentication or
> encryption.  Use a VPN or other transport-layer protection when exposing
> the gateway beyond localhost.

### Formula disposal and reconstruction

An unconfined module receives a context with `whenCancelled()`,
`whenDisposed()`, and `addDisposalHook(hook)` methods.
Register a remotable callable hook using eventual send and await registration
before starting work that requires cleanup.
Registration after cancellation is refused.
The daemon invokes the hook by eventual send and awaits its result.

Cancellation withdraws the old controller immediately, but reconstruction of
that exact formula is refused while its disposal is pending.
After successful disposal, a subsequent lookup can reconstruct the formula.
Failed disposal keeps reconstruction fenced for the life of that daemon;
repeated lookup attempts do not discard the failure or construct a successor.
Pending and failed disposal have distinct errors.
Lookup does not implicitly wait for disposal: cleanup hooks that look up each
other's cancelled formulas must fail instead of deadlocking on each other.

Collection also fences each exact formula before withdrawing its controller,
including formulas with no live controller. The fence remains until durable
deletion and cleanup succeed; uncertain deletion or cleanup leaves a failed
fence for the daemon's lifetime. Reads already in flight are invalidated before
collection and cannot put stale formula bytes back into the graph, even after
successful cleanup clears its fence. These read tokens exist only while reads
are in flight; successful collection does not accumulate permanent tombstones.

Hooks must fence retained application facets and drain admitted operations;
revoking a client's route alone does not stop activity already running in a
worker.
This barrier orders incarnations of one formula, not independently created
formulas over the same resources.
It is not persistent proof of native resource cleanup after daemon or host loss.
