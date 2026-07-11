# OCapN-over-Noise between real peers — demonstration report

Goal (from `OCapN.md`): prove an OCapN Network built on the Noise IK handshake,
carried over **WebSocket/HTTP** and **TCP+CBOR**, between real peers — including
the previously-unproven **Crossed Hellos** and **reverse peer authentication**
paths — culminating in a Pet-Daemon-to-Pet-Daemon invite/accept connection.

Status: **Milestones 1 and 2 are done and reproducibly demonstrated.**
Milestones 3–5 are blocked on access to / changes on the live `minion.town`
host and on daemon-side integration that is not yet landed (details below).

---

## Where this runs

- Package: `@endo/ocapn-noise` on branch **`llm`** of `endojs/endo-but-for-bots`.
- Working checkout: `/home/kris/garden/scratch/ocapn-noise-demo` (a fresh
  worktree of `llm` HEAD `249e02758d`; the deployed `worktrees/endojs-endo/llm`
  checkout had a stale git pointer and was not used).
- Install: `corepack yarn install` (Yarn 4, pnpm linker). The Noise WASM blob
  `packages/ocapn-noise/gen/ocapn-noise.wasm` ships in-tree, so no Rust build.

## Reproduce

```sh
cd packages/ocapn-noise
bash demo/run-all.sh          # runs M1 + M2 on both transports, captures logs
```

Captured transcripts live in `demo/transcripts/`. Individual pieces:

```sh
bash demo/run-local-pair.sh ws  Alice   # M1: two-process capability round-trip, WebSocket
bash demo/run-local-pair.sh tcp Bob     # M1: two-process capability round-trip, TCP+CBOR
node demo/scenarios.mjs ws              # M2: crossed hellos + reverse peer auth, WebSocket
node demo/scenarios.mjs tcp             # M2: crossed hellos + reverse peer auth, TCP+CBOR
```

Harness files (all new, under `demo/`): `peer.mjs` (shared `makeNoisePeer`),
`server.mjs`, `client.mjs`, `run-local-pair.sh`, `scenarios.mjs`, `run-all.sh`.

---

## Milestone 1 — toy server + client, local pair, capability round-trips

Two **separate OS processes** (`demo/server.mjs`, `demo/client.mjs`), each with
its own `makeOcapnNoiseNetwork` + a real transport. The server publishes a
`Greeter` capability and prints its `OcapnLocation`; the client reads the
location, opens a Noise IK session, fetches `Greeter` via a SturdyRef, and calls
`E(greeter).hello(name)` — a genuine CapTP capability invocation, not a raw byte
echo.

- **WebSocket/HTTP** — `demo/transcripts/m1-ws-capability-roundtrip.log`
  Location hint `ws:url = ws://127.0.0.1:<port>`; reply `hello, Alice`. **PASS.**
- **TCP+CBOR (netstring framing)** — `demo/transcripts/m1-tcp-capability-roundtrip.log`
  Location hints `tcp:host / tcp:port`; reply `hello, Bob`. **PASS.**

This exceeds the repo tests: `test/network-tcp.test.js` / `test/ws-transport.test.js`
only round-trip raw bytes over a session, and `test/integration.test.js` does a
full CapTP round-trip but only over the in-process mock **mesh** transport. The
demo does a full CapTP round-trip over a **real socket across two processes**.

## Milestone 2 — Crossed Hellos and reverse peer authentication

`demo/scenarios.mjs`, run on each real transport. Transcripts:
`demo/transcripts/m2-ws-scenarios.log`, `m2-tcp-scenarios.log`. All checks pass
on both transports.

**(A) Reverse peer authentication.** A listener `S` and a dial-only peer `C`.
`C` is given only `S`'s location; `S` is told *nothing* about `C`'s address.
After `C.provideSession(locS)` / `S.waitForInboundSession(C.keyId)`:

- dialer authenticated listener: `sessC.remoteLocation.designator === S.keyId`
- **listener authenticated dialer** (the reverse direction):
  `sessS.remoteLocation.designator === C.keyId` — established purely from the
  in-band post-handshake identity exchange, with no prior knowledge of `C`.
- both ends share one 32-byte `sessionId`; exactly one side is initiator (the
  dialer); the mutually-authenticated channel then carries a message.

**(B) Crossed Hellos.** Two listening peers `A`, `B` each call
`provideSession(other)` **simultaneously** (`Promise.all`). Both converge on a
**single shared session**:

- identical non-empty 32-byte `sessionId` on both sides (e.g. WS run
  `01647659be27f2a3…`, TCP run `355b5261c2075847…`);
- exactly one side wins as initiator (the internal tiebreaker keeps the session
  whose initiator ephemeral key is bytewise-lesser and closes the loser);
- both directions carry traffic on the surviving channel (`ping-from-A` /
  `pong-from-B`).

---

## Findings / gaps

1. **`test/crossed-hellos.test.js` has a vacuous session-id assertion.**
   `sessionId` is an *immutable* `ArrayBuffer` (a double-SHA256, 32 bytes). Reading
   it with `new Uint8Array(sessionId)` yields a **length-0** view — you must
   `sessionId.slice(0)` first. The test asserts
   `t.deepEqual(new Uint8Array(sessionA.sessionId), new Uint8Array(sessionB.sessionId))`,
   i.e. it compares **two empty arrays** — it would pass even if the two session
   ids differed. `demo/scenarios.mjs` reads the bytes correctly (via `.slice(0)`)
   and additionally asserts the id is non-empty and 64 hex chars, so its
   convergence check is real. Worth fixing the test (and auditing other
   `new Uint8Array(<immutable-buffer>)` reads).

2. **`demo/web.html` is stale.** It calls a removed 3-message bindings API
   (`initiator.randomKeys()`, `.syn()`, `responder.synack()`, `initiator.ack()`).
   The current `src/bindings.js` is a 2-message flow (`asInitiator()` →
   `initiatorWriteSyn` / `initiatorReadSynack`, `asResponder()` →
   `responderReadSynWriteSynack`; no `ack`). The page will not run as written.

3. **The Pet Daemon does not yet wire the Noise netlayer.** `grep` for
   `makeOcapnNoiseNetwork` / `ocapn-noise` in `packages/daemon/src` finds nothing
   on `llm`. M4/M5 therefore need new daemon-side integration, not just wiring an
   existing path. (A board survey job — `ocapn-noise-daemon-survey` — is running
   to map the exact daemon netlayer/invite-accept surface and landed-vs-in-flight
   PRs; its report will refine this.)

---

## Milestones 3–5 — status and blockers

**M3 (local ↔ minion.town, toy server).** Blocked on host access from this
environment:
- This container is a **follower** garden instance with **no `aws` CLI/creds**,
  so no SSM. minion.town has **SSH closed (SSM-only)** and a security group that
  allows **inbound 80/443 only** — so a raw **TCP+CBOR** port on minion.town is
  unreachable from outside without a security-group change or a 443 tunnel.
- minion.town:443 is fronted by **Caddy behind an OAuth gate** (`GET /` →
  `302 /oauth2/sign_in`). A **WSS** demo would need a Caddy route
  (`wss://minion.town/<path>` → a local listener) and a way past the auth gate.
- Running any peer there also needs node + the `@endo/ocapn-noise` package
  deployed on the host.

**M4/M5 (Pet Daemon serves OCapN-over-Noise; invite/accept between daemons).**
Additionally blocked on the not-yet-landed daemon integration in finding #3.

### Options to proceed (need a decision)

- **(a) Drive M3–M5 from the leader host via the board.** The leader
  (`endolin-garden2`) holds AWS/SSM and can deploy to / reconfigure minion.town.
  I can post an orchestration job that (i) deploys the toy `server.mjs` behind a
  Caddy `wss://minion.town/ocapn-demo` route, (ii) dials it from a local peer,
  then (iii) builds the daemon noise-netlayer integration for M4/M5. This touches
  the **live production host** (Caddy config, possibly the security group) — a
  consequential, outward-facing change that needs maintainer authorization.
- **(b) You run a couple of `! aws ssm …` commands** to give me recon (what's
  deployed, is an Endo daemon running, current Caddy routes) so I can plan M3–M5
  precisely before any change.
- **(c) Scope tonight to M1/M2** (the core "prove it between real peers on both
  transports, with Crossed Hellos + reverse auth" result, now done) and defer the
  minion.town graduation to a follow-up with the access sorted out.
