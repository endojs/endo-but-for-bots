# `@endo/ocapn-noise` two-peer demo

A bespoke minimal server + client that establish a Noise (IK) session between two
peers over a **real transport** and round-trip an OCapN capability — proving the
netlayer end-to-end across OS processes, not just in the in-process test mesh.

## Run it

```sh
cd packages/ocapn-noise
bash demo/run-all.sh            # M1 + M2 on both transports, captures demo/transcripts/
```

Pieces:

```sh
bash demo/run-local-pair.sh ws  Alice   # two-process capability round-trip, WebSocket/HTTP
bash demo/run-local-pair.sh tcp Bob     # two-process capability round-trip, TCP+CBOR (netstring)
node demo/scenarios.mjs ws              # Crossed Hellos + reverse peer auth, WebSocket
node demo/scenarios.mjs tcp             # Crossed Hellos + reverse peer auth, TCP+CBOR
```

## What it demonstrates

- **Capability round-trip (M1).** `demo/server.mjs` publishes a `Greeter` `Far`
  object and prints its `OcapnLocation`; `demo/client.mjs` reads the location,
  opens a Noise session, fetches `Greeter` via a SturdyRef, and calls
  `E(greeter).hello(name)` — a real CapTP delivery over Noise, over both a real
  WebSocket and a real TCP+CBOR socket, between two separate processes.
- **Reverse peer authentication (M2).** A dial-only client reaches a listener that
  was told *nothing* about the client's address; after the handshake the listener
  holds the client's cryptographically-authenticated identity
  (`session.remoteLocation.designator === clientKeyId`) purely from the in-band
  post-handshake identity exchange.
- **Crossed Hellos (M2).** Two peers `provideSession(other)` simultaneously and
  converge on a single shared session (identical 32-byte `sessionId`, exactly one
  initiator per the ephemeral-key tiebreaker), and the surviving channel carries
  traffic both ways.

## Files

- `peer.mjs` — shared `makeNoisePeer({ name, transport, locator })` (the
  integration-test helper, generalized to take a live transport).
- `server.mjs` / `client.mjs` — the two processes; `run-local-pair.sh` wires them.
- `scenarios.mjs` — the Crossed Hellos + reverse-auth checks.
- `run-all.sh` — runs everything and captures `demo/transcripts/`.

## Note on `sessionId`

`session.sessionId` is an **immutable** `ArrayBuffer`. `new Uint8Array(sessionId)`
reads it as **length 0** — copy via `sessionId.slice(0)` before reading bytes.
`scenarios.mjs` does this; see also the fix to `test/crossed-hellos.test.js`, whose
prior assertion compared two empty views.
