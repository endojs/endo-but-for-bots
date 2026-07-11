# Cross-host Pet-Daemon ↔ Pet-Daemon invite/accept over `wss://` + Noise (M5)

This demo closes the literal M5 goal: **two real Endo Pet Daemons on different
hosts** pairing through the **invite/accept workflow** over `wss://` + Noise IK +
CBOR, then round-tripping a capability.

- **Inviter / publisher** — the full Endo Pet Daemon deployed on **minion.town**
  (EC2 `i-0380cd68b90020fad`, Docker container `endo-pet-daemon`, `@nets/ocapn`
  WS+Noise, reachable at `wss://minion.town/ocapn-daemon` through Caddy TLS 443).
  Stood up by the sibling `packages/daemon/deploy/` Dockerfile job.
- **Acceptor / caller** — a full Endo Pet Daemon booted **locally** (here, in the
  garden container) with the same `@nets/ocapn` network installed.

It complements PR #688's `demo/two-daemon-invite-accept/`, which proves the same
invite/accept + round-trip between **two daemons on one host** (TCP and WS). This
demo is the genuinely **cross-host** case.

## Why the local side rewrites the `ws:url` hint

The minion daemon binds a **loopback** WebSocket port (`ws://127.0.0.1:8930`
inside its container) and advertises that as its `ws:url` transport hint. The
world reaches that port only through Caddy TLS on 443. So the invitation locator
minted on minion carries a hint no external peer can dial directly.

The Noise IK handshake authenticates the location **designator** (the daemon's
session public key), **not** the transport URL. So the acceptor rewrites *only*
the `ws:url` hint in every advertised connection hint to the public endpoint
`wss://minion.town/ocapn-daemon`, leaving the designator untouched — the same
public-endpoint rewrite the `deploy/ocapn-bootstrap-client.mjs` demo client
carries. `rewritePublicWsUrl` in `local-accept-invitation.mjs` does this.

## Direction is fixed by reachability

The garden container has no public address, so minion can never dial back to it.
The pairing is therefore one-directional at the transport layer:

- minion is the **inviter** and capability **publisher**;
- local is the **acceptor** and capability **caller**, dialing OUT to minion.

The single CapTP session local opens over `wss://` is bidirectional once
established, which is what lets `E(invitation).accept(...)` call back to minion
and the capability result flow home over the same Noise session.

## Files

| File | Runs on | What it does |
| --- | --- | --- |
| `minion-mint-invitation.mjs` | minion (in-container, `/data/endo.sock`) | mints an invitation + publishes a `Far` capability; prints both locators |
| `local-accept-invitation.mjs` | local | boots a Pet Daemon, rewrites `ws:url`, `accept`s the invitation, invokes the capability |
| `minion-ssm.py` | anywhere with AWS creds | boto3 SSM helper (an `aws`-CLI-free alternative to `demo/minion-town/ssm.sh`) |
| `run-cross-host.sh` | local | drives steps 1–3 end to end |
| `transcript-cross-host.txt` | — | captured live run |
| `transcript-tcp-local.txt` | — | companion: local TCP two-daemon invite/accept (minion blocks non-443, so remote TCP is out of scope) |

## Run it

Prerequisites: the minion `endo-pet-daemon` container up (see `../../deploy/`), a
built monorepo (`yarn install` from the repo root — on a `noexec` `/tmp` set
`TMPDIR` to an exec-capable dir for the install **only**; the daemon's unix
socket must stay on a short path such as `/tmp`), and SSM reach to the host.

```sh
cd packages/daemon
./demo/cross-host-invite-accept/run-cross-host.sh
```

Or the two steps by hand:

```sh
# 1. On minion (inside the container), mint + publish:
docker exec endo-pet-daemon \
  node demo/cross-host-invite-accept/minion-mint-invitation.mjs
#    -> prints INVITATION <locator>, ADDER <locator>, NODE <id>

# 2. Locally, accept over wss:// and invoke back:
WS_URL_OVERRIDE=wss://minion.town/ocapn-daemon \
INVITATION='<locator from step 1>' ADDER='<locator from step 1>' \
  node demo/cross-host-invite-accept/local-accept-invitation.mjs
```

Expected tail:

```
local: ✓ invitation bound the minion.town peer under pet name "minion"
local: ← remote result: 2 + 3 = 5
local: ← remote greeting: "hello local Pet Daemon in the garden container from minion.town"
local: CROSS-HOST DEMO PASSED
```

## Gap vs. the full CLI pet-name invitation flow

This drives the **programmatic** host facet (`E(host).invite` /
`E(host).accept` / `E(host).evaluate`) — the same objects the `endo invite` /
`endo accept` CLI subcommands wrap — rather than the CLI binaries. Reaching
minion's host facet requires its control socket, reached here via
`docker exec` over SSM; the public `wss://` surface exposes only the
network-level `EndoOcapnBootstrap` (swissnum `endo-bootstrap`,
`getNodeId`/`getAgentBinding`/`getGreeter`/`help`), not the pet-store host. The
invite/accept workflow itself — mint on one daemon, accept on the other, durable
guest + peer-info registration on both sides, capability round-trip — is exercised
end to end and cross-host. Driving the `endo` CLI over an interactive shell on
minion, and mutual (bidirectional-dialable) pairing, remain follow-ups.
