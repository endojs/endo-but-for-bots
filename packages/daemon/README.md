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

## systemd socket activation

On Linux, systemd can create the daemon's Unix socket before the daemon starts,
start the daemon lazily when the first client connects, and preserve the
listening socket across clean service restarts so clients do not see a
connection-refused window.
The daemon implements the conventional `LISTEN_PID` / `LISTEN_FDS` protocol and
accepts the first inherited listener on file descriptor 3.

The default socket path is `$XDG_RUNTIME_DIR/endo/captp0.sock`, so the following
user units use systemd's `%t` runtime-directory specifier for the same path.
Install them as `~/.config/systemd/user/endo.socket` and
`~/.config/systemd/user/endo.service`.

```systemd
# endo.socket
[Unit]
Description=Endo daemon socket

[Socket]
ListenStream=%t/endo/captp0.sock
SocketMode=0600
DirectoryMode=0700
Accept=no

[Install]
WantedBy=sockets.target
```

```systemd
# endo.service
[Unit]
Description=Endo daemon
Requires=endo.socket
After=endo.socket

[Service]
Type=simple
ExecStart=/usr/bin/env endo run-daemon
Restart=on-failure

[Install]
WantedBy=default.target
```

Ensure that `endo` is on the user service manager's `PATH`, then load and enable
the units with `systemctl --user daemon-reload` and
`systemctl --user enable --now endo.socket`.
No `ExecStartPre` socket setup is necessary: the socket unit owns the socket
path's lifecycle.
With `Accept=no`, systemd passes one file descriptor for the whole listening
socket, using the file-descriptor-3 contract above rather than starting one
process per connection.

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
