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

## Named guest authority

`EndoHost.provideGuest` can give a retained, host-named guest an immutable
graph of attenuated mounts, Git capabilities, and Git remotes.
The operation works on an existing `EndoHost`; opening and closing a client
connection remains the caller's responsibility.

```js
import { E } from '@endo/eventual-send';

const guest = await E(host).provideGuest('documentation-agent', {
  authority: {
    mount: {
      workspace: {
        path: '/repo',
        deniedSegments: ['.env'],
      },
      docs: {
        path: '/repo/docs',
        readOnly: true,
      },
    },
    git: {
      repo: {
        mount: 'workspace',
        path: [],
      },
      docsHistory: {
        mount: 'docs',
        path: [],
        readOnly: true,
      },
    },
    gitRemote: {
      originCap: {
        git: 'repo',
        name: 'origin',
        url: 'https://github.com/endojs/endo.git',
        credential: ['credentials', 'github'],
      },
      mirrorCap: {
        git: 'repo',
        name: 'mirror',
        url: 'https://example.com/endo-mirror.git',
      },
    },
  },
  endowments: {
    '@main': 'documentation-worker',
    calendar: 'calendar-service',
  },
});
```

The singular collection names are categories, and each property key is the
binding the guest receives.
The example therefore gives the guest two mounts (`workspace` and `docs`), two
Git capabilities (`repo` and `docsHistory`), and two remote capabilities
(`originCap` and `mirrorCap`).
An object cannot repeat a property key, so duplicate bindings are structurally
impossible and record order does not imply realization order.

Every Git entry explicitly selects a mount binding, and every Git remote entry
explicitly selects a Git binding.
A remote's guest binding key is distinct from its Git protocol `name`, matching
`provideGitRemote(gitCap, petName, options)`.
Mount options align with `provideMount` (`readOnly` and `deniedSegments`), and
Git options align with `provideGit` (`readOnly` and
`allowHistoryRewrite`).
Writable Git requires a writable selected mount, so Git cannot bypass the
filesystem posture that bounds its worktree.

Omitted categories grant no authority.
The host resolves symlinks, retains canonical roots and credential formula
identities privately, records the closed policy before minting aliases, and
rejects a repeated `provideGuest` call if its authority differs.
Reacquire the guest with `provideGuest('documentation-agent')`; the host reloads
the retained policy and revalidates credential references and audiences.
Callers do not persist or resubmit a normalized authority record.
Changing or widening a retained policy fails closed.

A retained guest is endowed through a single `endowments` map from guest-side
names to the providing host's pet names. The guest-side name (the map key)
determines policy: a key beginning with `@` is a special, indelible endowment
and any other key is an ordinary, mutable introduction. The map's values are the
providing host's pet names, never formula identifiers; the daemon resolves each
to a formula identifier behind its boundary.

Every freshly provisioned guest receives its own worker at `@main`. The creating
host may replace that binding, or add another non-daemon-reserved special name,
by mapping it under an `@` key (`endowments: { '@main': 'a-worker' }`) while it
first supplies retained authority. A special endowment resolves its host source
once and persists that identity in the guest formula, retaining the formula-graph
edge; its host source must exist. A guest cannot remove or rebind a special name.

An ordinary endowment (a non-`@` key) keeps the existing `provideGuest`
missing-source behavior: the guest receives the named guest-side pet name, and a
missing host source is simply ignored so binding the host pet name and
reconnecting repairs it. An ordinary key must not collide with a provisioned
authority binding.

The whole `endowments` map is part of the immutable retained policy, so a
repeated provide must supply a map that resolves to the same identifiers; a bare
reacquisition preserves the original policy and a later provisioning call that
differs is rejected. Credential references use host pet names or name paths;
credential material and live capabilities never enter the inert authority record.

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
