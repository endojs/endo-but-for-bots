# Two Pet Daemons: invite/accept + capability round-trip over OCapN-Noise

A live, standalone demonstration of two Endo Pet Daemons pairing through the
**invite/accept** workflow over the OCapN-Noise netlayer (Noise IK + CBOR), then
invoking a real capability across the resulting session.

Each daemon is a separate OS process (`start()` spawns it). The only network
installed on either daemon is `@nets/ocapn`, so the invitation's connection hints
necessarily advertise `ocapn+noise+tcp` (or `ocapn+noise+ws`), and the accepting
daemon routes its dial-back through that netlayer — the same routing the
`test/invite-retention-ocapn*.test.js` forked-two-daemon suite locks down.

## Run

From `packages/daemon` (deps must be installed — pnpm per-package `node_modules`):

```sh
node demo/two-daemon-invite-accept/run.mjs          # ocapn+noise+tcp
OCAPN_WS=1 node demo/two-daemon-invite-accept/run.mjs   # ocapn+noise+ws
```

The script boots daemon A (inviter) and daemon B (acceptor), has A `invite('bob')`,
prints the invitation locator (showing the `ocapn+noise+…` hint), has B
`accept(…, 'alice')`, then:

1. A publishes `Far('Adder', { add })`; B invokes `E(adder).add(2, 3)` and receives
   `5` back — a remote method call whose computed result crosses the Noise session.
2. A publishes `Far('Echoer', { echo })`; B sends a fresh `Far` token through it and
   confirms identity is preserved — proving the edge carries pass-by-reference.

## Captured transcripts

- [`transcript-tcp.txt`](./transcript-tcp.txt) — `ocapn+noise+tcp`
- [`transcript-ws.txt`](./transcript-ws.txt) — `ocapn+noise+ws`

For the **local ↔ minion.town** WebSocket demonstration (a local peer dialing a
remote Pet-Daemon-shaped OCapN-Noise-WS service through Caddy's TLS 443), see
[`../minion-town/`](../minion-town/) and its
[`transcript-minion-live.txt`](../minion-town/transcript-minion-live.txt).
