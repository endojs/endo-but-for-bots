# Iroh migration — moving fleet services off open ports onto dial-by-pubkey

Status as of this commit (field-preact): the **transport layer is adopted and proven**; what remains is the
**operational rollout** of specific services + Kumavis's real endpoint. Background: `~/endo-bfb/IROH-V1-DESIGN.md`.

## What's landed (proven + live)

- **`src/transports/iroh.js`** — `makeIrohTransport({secretKey?, alpn?, preset?})`: the existing
  `OcapnNoiseTransport` shape (`connect(hints)` / `listen(handler)` → a `{reader,writer}` byte-stream) over a
  `@number0/iroh` QUIC bidi stream. Dial-by-EndpointId, **no host:port**; netstring-framed; stable EndpointId
  from a persisted 32-byte seed. `@number0/iroh` is an **optionalDependency**.
- **Real ocap over iroh** — `test/iroh-captp.test.js`: a genuine `@endo/ocapn` `E(greeter).hello()` round-trips
  over the iroh transport through the **unchanged** `makeOcapnNoiseNetwork`+`makeOcapn` stack (so attenuation/
  revocation/swissnums ride on top unchanged). Location carries `iroh:id`/`iroh:addr`, no `tcp:*`.
- **`iroh-root.mjs`** — a deployable root node over iroh (the migration template). `test/iroh-root.test.js`
  spawns it and asserts via `ss` that the process has **zero TCP listeners**.
- **The "Kumavis fix"** (voice-agent `objects` power, live) — `callObject` now **dials** endo-iroh refs over
  the iroh transport (`src/iroh-dialer.js` + `voice-agent/iroh-objects.mjs`, lazy-loaded so the native binding
  can't crash server boot). A legacy `origin:"null"` ref still fails legibly.
- **The 65519-byte Noise message ceiling is dissolved** by QUIC (a 200 KB single frame round-trips) — the
  chunked-BytesReader workaround can be dropped for iroh-backed caps.

## Migrate a service (the netlayer swap)

A noise-over-TCP service binds `net.addTransport(makeTcpTransport({port, host}))`. The iroh version:

```js
import { makeIrohTransport } from '@endo/ocapn-noise/transport/iroh';
const seed = /* persisted 32 bytes — same seed ⇒ stable EndpointId across restarts */;
await net.addTransport(await makeIrohTransport({ secretKey: seed, preset: 'minimal' }));
// net.locationFor(keyId).hints now has iroh:id (+ iroh:addr) and NO tcp:host/tcp:port.
```

Everything above the transport (caps, attenuation, revocation, swissnums) is **untouched**. `iroh-root.mjs`
is a copy-paste template. The new cap-link / dial form is:

```
ocapn://<keyId>.np?iroh:id=<EndpointId>&iroh:addr=<ip:port>
```

### Per-service checklist
1. Swap the transport line (above); delete `--port`/`--host`. Keep the seed-persistence for a stable identity.
2. Re-mint the service's cap link in the new dial form (carry a **direct `iroh:addr` hint** — see Discovery).
3. Remove the systemd port exposure / any nftables accept rule for the old TCP port.
4. Verify: `ss -tlnp` shows the service PID has **no** TCP listener; dial it by EndpointId from a client.

### Candidate services (current open ports)
- **keystone** (`endo-noise-root`, tcp `0.0.0.0:8920`) — a **proof node** (low risk, reversible). NOTE: it runs
  from the **`endo-bfb`** checkout (branch `iroh-daemon-netlayer`), which does not yet have `src/transports/iroh.js`
  — port the transport there (cherry-pick this commit) or repoint the unit at `endo-bfb-llm` before flipping.
  Flip = change its `ExecStart` to the iroh root (`iroh-root.mjs --seed …`) + `systemctl --user restart`.
- **GpuLease**, **friky-plex / keystone services0** — same recipe; migrate after keystone validates live.

## Discovery / relay
`preset:'minimal'` = direct UDP only (no external deps) — the dialer **must** be given a direct `iroh:addr`
hint (key-only resolution is NOT available, proven empirically; even n0 discovery failed key-only here). Bake
`iroh:id` + `iroh:addr` into the cap link (StaticProvider) — this doubles as an allowlist. For off-LAN / NAT
traversal, switch the service to `preset:'n0'` (n0 relays + hole-punch) or run a self-hosted relay.

## Kumavis (the objects-power dial)
The transport is wired; to actually reach Kumavis: **re-accept** the invite with a real
`iroh://<EndpointId>?addr=<ip:port>` link (the stored ref has `origin:"null"` and no address — pre-fix), and
ensure Kumavis's endpoint is reachable (direct addr or a relay). Then `callObject` dials it over QUIC.

## Clean-netlayer follow-on (deliberate debt)
Routing through `makeOcapnNoiseNetwork` to reuse the transport seam still runs the Noise-IK handshake **inside**
the QUIC tunnel (TLS-inside-TLS). That's fine and proves the swap. The production target retires Noise and rides
CapTP **directly** on the QUIC stream (Iroh's QUIC already gives TLS1.3 + mutual Ed25519 auth) — `IROH-V1-DESIGN.md`
§3/§8. A thin `captp-over-iroh` netlayer that skips the redundant Noise handshake is the next architectural step.
