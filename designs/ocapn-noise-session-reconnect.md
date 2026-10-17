# OCapN-Noise Session Reconnect

| | |
|---|---|
| **Created** | 2026-05-14 |
| **Updated** | 2026-10-17 |
| **Author** | Kris Kowal (prompted) |
| **Status** | Proposed |
| **Source** | Amends [ocapn-noise-network](ocapn-noise-network.md) and [ocapn-tcp-syrup-framing](ocapn-tcp-syrup-framing.md). |

## What is the Problem Being Solved?

TCP alone is not a sufficient liveness signal for a long-lived CapTP session.
The default TCP keepalive timeout on most systems is roughly two hours
(Linux's `tcp_keepalive_time` defaults to 7200 seconds; see
`man 7 tcp` and
[`Documentation/networking/ip-sysctl.rst`](https://www.kernel.org/doc/Documentation/networking/ip-sysctl.rst));
when `tcp_keepalive` is left off entirely a half-open connection persists
until the application surfaces an error on the next write attempt and the
kernel completes its retransmission ladder, which on Linux is
`tcp_retries2 = 15` (RFC 1122 § 4.2.3.5 mandates the user-configurable
R2 retransmission threshold be at least 100 s; the Linux default
yields a worst-case partition tolerance on the order of days, see
RFC 5482 and the `tcp_retries2` discussion in `ip-sysctl.rst`).
Neither bound is acceptable for a capability protocol where the application
must know within seconds whether the peer is reachable so that it can
release resources, retry, or surface the partition to a user.

The OCapN-Noise network as currently designed
([ocapn-noise-network](ocapn-noise-network.md)) inherits this deficiency.
The handshake provides confidentiality, integrity, and mutual authentication,
but once the encrypted session is up there is no liveness probe; an idle
session looks alive long after the peer has crashed or the network has
partitioned.

Across CapTP implementations the consensus has been to build a
*meta-TCP* session layer that
(a) maintains a short logical timeout independent of the TCP keepalive,
(b) runs a continuous ping/pong heartbeat for liveness,
(c) re-establishes the underlying TCP transport on detected loss without
tearing down the CapTP session, and
(d) keeps the session continuous across the reconnect so that the
application sees one session even as the byte pipe changes underneath.

This document amends the OCapN-Noise design to add that meta-TCP session
layer.
The amendment is structured as six concerns, each with normative content
and one or more explicit open questions for the OCapN spec group.

## Rationale

Four facts taken together force the design:

1. **TCP's idle behavior is not a liveness signal.** Neither the default
   keepalive timeout (two hours) nor the absence of keepalive (effectively
   forever on most kernels, capped near four days) is the right timescale
   for a capability session. CapTP needs seconds-to-tens-of-seconds.

2. **Noise provides no liveness primitive of its own.** The Noise Protocol
   delivers an authenticated, encrypted channel and nothing else; idle
   detection is the caller's responsibility.

3. **Noise's nonce state is fragile under reconnect.**
   The Noise transport uses ChaCha20-Poly1305 AEAD; each direction has
   a `CipherState` that is a `(key, nonce)` pair; the nonce increments
   per encrypted message.
   The Noise spec's `CipherState.n` counter is per-direction and
   per-key.
   Reusing a `(key, nonce)` pair with ChaCha20-Poly1305 is a
   catastrophic compromise: it leaks the XOR of the two plaintexts and
   lets an attacker forge the authenticator.
   Any reconnect scheme MUST either continue the counter monotonically
   on the same key or rotate the key entirely (a fresh handshake).

4. **OCapN today has no application-level ping.** The operation set
   (`op:start-session`, `op:deliver`, `op:deliver-only`, `op:abort`,
   `op:listen`, `op:gc-export`, `op:gc-answer`) does not carry a ping.
   A heartbeat above the transport needs a new op or must piggy-back on
   an existing one.

Out of these: the amendment proposes a short logical session timeout, a
continuous heartbeat via a new `op:ping` operation, transparent TCP
reconnection on heartbeat loss, and a fresh Noise handshake on every
reconnect, so that no `(key, nonce)` pair can be reused.

## Design

### 1. Heartbeat Protocol

The session carries a continuous ping/pong heartbeat at the OCapN
operation layer.
Every `HEARTBEAT_INTERVAL` (default: 5 s), each side sends one heartbeat
operation; if no operation of any kind has arrived from the peer within
`SESSION_TIMEOUT` (default: 30 s), the session is declared lost on this
TCP pipe and the reconnection procedure begins.

The heartbeat is a *single* operation (not a request/response pair).
Each side independently emits its own heartbeat on its own schedule;
the receiving side treats any incoming traffic (heartbeat or otherwise)
as evidence of liveness and resets its own per-peer timeout timer.
The protocol is symmetric and avoids the question of who pings first.

#### Tentative OCapN Extension: `op:ping`

The amendment proposes (pending wider OCapN consensus) a new operation:

```text
<op:ping epoch sequence>
```

Field semantics:

- `epoch`: the session epoch (see § Session epoch below). A uint64.
- `sequence`: a monotonic counter that increments on every `op:ping` this
  side emits in this session epoch. A uint64.

A separate `op:pong` operation (defined below) carries the explicit
ack of the peer's last-decrypted nonce. For ordinary liveness,
however, the receipt of *any* operation from the peer (including
but not limited to `op:pong`) is treated as evidence of liveness;
each side emits its own `op:ping` on its own clock and does not
block on a matching `op:pong`.

Every OCapN codec carries `op:ping`. The syrup encoding (analogous to
existing ops in `packages/ocapn/src/codecs/operations.js`) carries
the record tag `op:ping`, a uint64 epoch, and a uint64 sequence; the
CBOR encoding carries the same fields under the corresponding CBOR
tag; any future codec MUST do the same. Heartbeat liveness is a
network-level property and cannot be codec-dependent: a peer that
negotiated CBOR rather than syrups still needs to be told whether the
session is alive.

The amendment uses a *single* `op:ping` opcode for the liveness signal
(rather than paired `op:ping` / `op:pong` request/response on the
liveness path): each side emits `op:ping` on its own clock, and any
incoming op resets the per-peer timeout. A separate `op:pong` exists
for the explicit-ack path (defined below; carries the
`last_acked_recv_nonce` that bounds the replay buffer of § 4),
not for liveness.

#### Tentative OCapN Extension: `op:pong`

The amendment also proposes (pending wider OCapN consensus) an
`op:pong` operation, used to carry the explicit acknowledgment of
the peer's last-decrypted nonce on a heartbeat cadence:

```text
<op:pong epoch sequence last_acked_recv_nonce>
```

Field semantics:

- `epoch`: the session epoch, as for `op:ping`. A uint64.
- `sequence`: a monotonic counter that increments on every `op:pong`
  this side emits in this session epoch. A uint64. Independent of
  the `op:ping` sequence.
- `last_acked_recv_nonce`: the number of session frames this side
  has decrypted successfully in the current session epoch. A uint64.
  Because every transport instance rekeys (§ 4), this equals the Noise
  recv-nonce of the current CipherState; the count, not the nonce, is
  the contract, and it restarts at 0 with each epoch.

`op:pong` is the explicit-ack form C2 (§ 4) calls out. A side that
receives `op:pong` updates its `peer_acked_recv_nonce` for the
incoming direction, and may release every frame that ack covers:
those frames never need replaying after a TCP-instance break (§ 4).
`op:pong` is also useful for measuring round-trip time, though
that is not its primary purpose.

The heartbeat lives **inside the Noise encrypted channel only**.
A below-Noise (TCP-level) ping would avoid waking the cipher on
purely idle channels, but a single authenticated liveness
mechanism is preferable to two parallel ones; the inside-only
form is what this amendment specifies.

### 2. Session Epoch and TCP Transport Instances

Distinguish two concepts:

- The **CapTP session**, identified by a (`initiator-designator`,
  `responder-designator`) pair. It survives reconnects.
- A **transport instance** within that session: one concrete TCP
  connection. The session has a sequence of these.

Each transport instance is numbered by the **session epoch**, a uint64
starting at 0 for the handshake's TCP connection and incrementing by 1
on each successful reconnect.
Both sides track the current epoch independently and the reconnection
procedure synchronizes it (see § Reconnection).

The session epoch is what the `op:ping` epoch field carries.
A peer that receives an `op:ping` with an epoch earlier than its own
current epoch silently drops it; this protects against late-arriving
stragglers from an obsolete TCP instance.

### 3. Reconnection

When side A's session timeout fires on the current transport instance,
A:

1. Closes the local TCP socket (if not already closed).
2. Marks the session as "reconnecting"; queues outbound CapTP operations.
3. Opens a new TCP connection to the peer's transport hints.
4. Runs a **reconnect handshake** (see § 4): a fresh Noise IK handshake
   and `op:start-session` exchange, followed by a record that proves
   the new TCP pipe belongs to the same session and advances the epoch.
5. Replays what the peer has not acknowledged, then resumes draining
   the outbound queue.

Side B, on detecting loss (independent timeout, or an incoming
reconnect handshake), does the symmetric thing.

#### Crossed-Hellos Tiebreaker

Both sides may detect loss simultaneously and both may attempt to open
a new TCP connection. The tiebreaker is **lexicographic comparison of
the two session designators**: the side whose designator (treated as a
32-byte big-endian unsigned integer) is numerically **smaller** is the
*responder* for the new transport instance; the other side is the
*initiator*. Both sides know both designators (they exchanged them at
session establishment in Noise IK), so the tiebreaker is unambiguous.

The **designator material** is each side's **ephemeral x25519 public
key** used as the session's static-equivalent material in the Noise IK
handshake (`e` from the initiator's first message and `e` from the
responder's reply), *not* either side's long-term signing Ed25519
public key. Using the per-session ephemeral keeps the tiebreaker tied
to the current session: a fresh session reseats the comparison without
biasing any peer toward initiator-or-responder across reconnect
attempts. Using a long-term signing key would bias each peer the same
direction on every session it ever participates in (and would
incentivize rerolling peer identifiers to win the tiebreaker), which
is undesirable.

The procedure when crossed-hellos is detected:

1. Each side is mid-`connect()` toward the peer when it accepts an
   incoming `connect()` from the peer.
2. Each side computes which peer is responder by designator
   comparison.
3. The peer who computes "I am responder" cancels its outbound socket
   and accepts the inbound one.
4. The peer who computes "I am initiator" cancels its inbound socket
   and proceeds with its outbound one.
5. Both sides converge on a single TCP transport instance and complete
   the reconnect handshake on it.

**Open question (P3).** Is designator comparison the right tiebreaker,
or should it be a per-session value (e.g., the hash of the initial
handshake transcript)? Designator comparison has the advantage that
both sides can compute it without exchanging any new data; transcript
comparison guarantees independence from key-reuse across sessions but
needs the transcript to be remembered on both sides. The amendment
leans toward designator comparison.

### 4. Rekey on Every Reconnect

The Noise Protocol's `CipherState` is a `(key, nonce)` pair, separate
per direction.
The nonce is the 64-bit counter `n` that the Noise spec mandates
MUST monotonically increase and MUST NOT wrap on the local
CipherState.
After the handshake, both sides hold an `initiator->responder` cipher
state and a `responder->initiator` cipher state; each is incremented
on every encrypted message it processes.

**Every new TCP transport instance runs a fresh Noise IK handshake
(Rekey).**
The previous instance's CipherStates are discarded, never carried
across the boundary.
The new instance gets new keys from its own handshake, and its nonces
start at 0 under those keys.
This settles Open question C1 as recommendation R3 of the
cryptographic review in [#1475](https://github.com/endojs/endo-but-for-bots/pull/1475), which rewrites
[ocapn-noise-cryptographic-review](ocapn-noise-cryptographic-review.md)
and carries the reasoning in its section 6, "Reconnect: Rekey, not
Resume".
Until [#1475](https://github.com/endojs/endo-but-for-bots/pull/1475) lands, the copy of that file on this branch is the
earlier, deprecated review and does not contain R3.
It reverses the tentative decision recorded on
[#252](https://github.com/endojs/endo-but-for-bots/pull/252) ("Tentatively
run with resume and rekey-cap"), so it needs the maintainer's
confirmation (Open question C1 below).
The reasoning:

- With IK a Rekey is two Noise messages, 213 bytes and one round trip.
- Continuing a CipherState (the former Option Resume) would require
  both sides to keep live keys and nonce high-water marks across TCP
  connections.
  A single crash-restore or forked copy of that state would then reuse
  a `(key, nonce)` pair, which under ChaCha20-Poly1305 reveals the XOR
  of two plaintexts and the Poly1305 one-time key.
  Rekey makes that impossible by construction.
- Rekey gives each transport instance its own forward secrecy.
- The channel-bound `op:start-session` exchange proves on every new
  instance that the same two identities are at both ends.

**Reconnect handshake.**
On the new TCP transport, after TCP connect succeeds:

1. The two sides run the Noise IK handshake and the `op:start-session`
   exchange exactly as for a new session.
   The responder's key-confirmation rule applies unchanged: nothing on
   the new instance counts as the peer until its `op:start-session`
   verifies.
2. Inside the new encrypted channel, the reconnecting side names the
   session it is reconnecting (a token bound to that session, such as
   its opening handshake hash, so a reconnect cannot be pointed at a
   different session) and the next epoch, `previous_epoch + 1`.
3. The other side validates that the named session exists with this
   peer and that the epoch advances by exactly one, then answers.
   A side that no longer holds the session refuses, and the
   reconnecting side ends the session rather than waiting out
   `SESSION_HARD_TIMEOUT`.
4. Each side tells the other how many session frames it has received.
   Each side then replays, in order, the frames the peer has not
   received, ahead of anything queued during the gap.
   The `last_acked_recv_nonce` counts carried by `op:pong` (§ 1) bound
   how much each side must retain for replay.

**Replay idempotence at the CapTP layer.**
Step 4 above replays unacknowledged operations under the new
instance's keys.
At the Noise layer this is sound (no `(key, nonce)` pair is reused).
Frames received but not yet counted when the old instance broke are
replayed, so the receiver must absorb a duplicate delivery
idempotently.
Each CapTP operation type carries this requirement on the receiver:

- `op:deliver` (request-response): the receiver dedupes by
  `(session, answer-position)`.
  An incoming `op:deliver` whose `answer-position` was already resolved
  is acknowledged with the previously computed answer rather than
  re-executed.
- `op:deliver-only` (at-most-once fire-and-forget): the receiver dedupes
  by `(session, deliver-id)` and silently drops a repeat.
  Without this dedup, the at-most-once contract is violated on every
  reconnect that crosses an unacknowledged `op:deliver-only`.
- `op:gc-export` and `op:gc-answer`: idempotent by construction
  (releasing an already-released reference is a no-op).
- `op:listen`: idempotent by construction (re-subscribing the same
  resolver to the same promise is a no-op).
- `op:ping`: a duplicate is silently absorbed by the heartbeat
  receiver; the `(epoch, sequence)` pair makes duplicates trivially
  identifiable, and only liveness is observed, not application state.
- `op:pong`: a duplicate is silently absorbed; the receiver takes the
  max of its current `peer_acked_recv_nonce` and the incoming value,
  so out-of-order or replayed `op:pong` cannot rewind the ack.

Where dedup state is not already maintained, this design adds the
requirement.
This is in scope for the implementation of this amendment in
`packages/ocapn-noise-network` and the consuming CapTP layer.

**Resolution of C2 (was: implicit vs. explicit ack).**
`last_acked_recv_nonce` is acknowledged explicitly, via the
`op:pong` operation defined in § 1. Each side emits `op:pong`
on the heartbeat cadence (independent of its `op:ping` cadence)
carrying its current `last_acked_recv_nonce`; the receiver of
`op:pong` updates its `peer_acked_recv_nonce` for the matching
direction. The explicit form is preferred over implicit-via-any-op
because it lets each side release frames it no longer needs to replay
without per-op bookkeeping at the application layer, and because it
bounds the lag between a successful decrypt
and the peer's knowledge of that ack to at most one heartbeat
interval rather than to "the next op of any kind."

**Critical non-negotiable.** Under no circumstance may a
`(key, nonce)` pair be reused. This is the rule that protects the
ChaCha20-Poly1305 guarantee. Rekey on every reconnect makes it hold
trivially: no key outlives the transport instance that negotiated it.

### 5. Timeout Values

The amendment proposes the following defaults and tunable ranges. All
are configurable per-network; the network records them in its session
state.

| Parameter | Default | Range | Meaning |
|---|---|---|---|
| `HEARTBEAT_INTERVAL` | 5 s | 1 s – 60 s | How often each side emits `op:ping`. |
| `SESSION_TIMEOUT` | 30 s | `>= 3 * HEARTBEAT_INTERVAL` | How long without any incoming traffic before declaring loss and initiating reconnect. |
| `RECONNECT_BACKOFF_INITIAL` | 250 ms | 50 ms – 5 s | First retry delay after a failed reconnect attempt. |
| `RECONNECT_BACKOFF_MAX` | 30 s | up to `SESSION_HARD_TIMEOUT` | Cap on the exponential backoff. |
| `SESSION_HARD_TIMEOUT` | 10 min | up to `Infinity` | Total time the session may remain in "reconnecting" before being abandoned. |

**Hard-timeout queue terminal semantics.**
When `SESSION_HARD_TIMEOUT` fires, the session is abandoned and the
queue of operations accumulated during the reconnect window has a
defined terminal state.
The amendment specifies the following:

- Each pending operation in the queue settles with a session-aborted
  rejection.
  For `op:deliver`'s answer promise this is a rejection at the caller's
  promise; for `op:deliver-only` this is surfaced as a delivery-failed
  notification on the same promise pipeline that posted the operation
  (the operation is never silently dropped, which would violate
  `op:deliver-only`'s at-most-once-or-fail contract).
  For `op:gc-export` and `op:gc-answer` the side issuing the GC retains
  the reference state locally (the peer is gone; the GC's purpose is
  moot until a new session establishes).
- The session itself transitions to **aborted** and emits an
  `op:abort`-equivalent terminal event upward to the CapTP-using
  application.
  The application's existing `op:abort` handling path (whatever
  resource-release semantics it carries) covers the
  `SESSION_HARD_TIMEOUT` exit.
- Once a session is in the "approaching `SESSION_HARD_TIMEOUT`" window
  (within the last `RECONNECT_BACKOFF_MAX` of the budget), new
  enqueues from the application MAY be rejected immediately rather
  than allowed to accumulate.
  This is fail-fast for callers who would otherwise see a long delay
  followed by a rejection.

The terminal semantics avoid the silent at-most-once violation an
indefinite-drop policy would create.

**Open question (T1).** Are 5 s / 30 s the right defaults? For a
LAN-local session 1 s / 3 s is plenty; for a session crossing a
high-latency or lossy wide-area link 30 s / 90 s may be needed to
avoid spurious reconnects. The amendment proposes a configurable
default and suggests that the OCapN spec group recommend a profile
range rather than a single number.

**Open question (T2).** Should the heartbeat be adaptive (probe more
slowly while traffic is flowing, faster when idle) or fixed? Fixed
is simpler and is what this amendment recommends.

### 6. Where in the Stack the Amendment Lives

The session-reconnect logic lives **in the OCapN-Noise network**
(`packages/ocapn-noise-network` per
[ocapn-noise-network](ocapn-noise-network.md) § Package Structure),
not in OCapN core and not in the transport plugins.
Rationale:

- OCapN core (per
  [ocapn-network-transport-separation](ocapn-network-transport-separation.md))
  receives an already-established session from the network; it has no
  visibility into transport-instance churn.
- The transport plugins
  (`ocapn-noise-ws`, `ocapn-noise-tcp`) deliver a byte stream and know
  nothing about Noise state.
- Only the network sits at the seam where both the Noise CipherStates
  and the transport selection are visible.

The `OcapnNetwork.connect` contract is unchanged; what changes is the
internal implementation of the returned session, which now
transparently survives transport-instance changes.

For TCP-syrups (per
[ocapn-tcp-syrup-framing](ocapn-tcp-syrup-framing.md)) the framer
operates per-transport-instance: each new TCP connection mounts a
fresh `makeSyrupsReader` / `makeSyrupsWriter` pair. The session-level
queue of outbound operations bridges across the framer instances.

## Diagrams

### Steady-State Heartbeat to TCP Drop to Reconnect with Rekey

```mermaid
sequenceDiagram
    autonumber
    participant A as Side A
    participant T as TCP transport
    participant B as Side B

    Note over A,B: epoch=0, both CipherStates established
    A->>T: op:ping epoch=0 seq=N
    T->>B: op:ping epoch=0 seq=N
    B->>T: op:pong epoch=0 seq=P last_acked_recv_nonce=R_B
    T->>A: op:pong epoch=0 seq=P last_acked_recv_nonce=R_B
    B->>T: op:ping epoch=0 seq=M
    T->>A: op:ping epoch=0 seq=M
    A->>T: op:pong epoch=0 seq=Q last_acked_recv_nonce=R_A
    T->>B: op:pong epoch=0 seq=Q last_acked_recv_nonce=R_A
    Note over A,B: SESSION_TIMEOUT (30 s) sliding window resets on each receive;<br/>op:pong cadence updates each side's peer_acked_recv_nonce

    Note over T: TCP drop (B side crash or network partition)
    A->>T: op:ping epoch=0 seq=N+1
    Note over A: no reply within SESSION_TIMEOUT
    A->>A: declare loss; close socket; queue outbound ops

    A->>T: TCP connect (new instance)
    T->>B: TCP accept
    A->>B: Noise IK message 1 (SYN)
    B->>A: Noise IK message 2 (SYNACK)
    Note over A,B: new keys, nonces restart at 0
    A->>B: op:start-session, then reconnect(session, epoch=1, received)
    B->>A: op:start-session, then reconnect(session, epoch=1, received)
    Note over A,B: epoch advance: 0 -> 1<br/>each side replays the frames the peer did not receive

    A->>T: op:ping epoch=1 seq=0 (encrypted under the new CipherState)
    T->>B: op:ping epoch=1 seq=0
    B->>T: op:ping epoch=1 seq=0
    T->>A: op:ping epoch=1 seq=0
    Note over A,B: heartbeat resumes; CapTP session continuous
```

### Crossed-Hellos Tiebreaker

```mermaid
sequenceDiagram
    autonumber
    participant A as Side A<br/>(designator d_A)
    participant B as Side B<br/>(designator d_B)
    Note over A,B: both detect loss at epoch=0; both initiate reconnect

    par A's outbound
        A->>B: TCP SYN (to B's hints)
    and B's outbound
        B->>A: TCP SYN (to A's hints)
    end

    A->>A: compute tiebreaker:<br/>d_A vs d_B as u256
    B->>B: compute tiebreaker:<br/>d_A vs d_B as u256

    alt d_A < d_B
        Note over A,B: A is responder, B is initiator
        A->>A: cancel my outbound socket;<br/>accept B's inbound
        B->>B: cancel my inbound socket;<br/>proceed with my outbound
        B->>A: reconnect handshake on B's outbound socket
    else d_A > d_B
        Note over A,B: A is initiator, B is responder
        B->>B: cancel my outbound socket;<br/>accept A's inbound
        A->>A: cancel my inbound socket;<br/>proceed with my outbound
        A->>B: reconnect handshake on A's outbound socket
    end
    Note over A,B: exactly one TCP transport instance survives;<br/>epoch advances by 1
```

## Affected Packages

- `packages/ocapn-noise-network` (per
  [ocapn-noise-network](ocapn-noise-network.md)): owns the session
  state machine described here.
- `packages/ocapn`: gets the new `op:ping` and `op:pong` operations in
  every codec under `src/codecs/` (syrup and CBOR today, and any future
  codec) and the corresponding readers/writers.
- `packages/ocapn-noise`: unchanged. The CipherState lifecycle is the
  network's concern; the bindings just expose encrypt/decrypt.

## Dependencies

| Design | Relationship |
|---|---|
| [ocapn-noise-network](ocapn-noise-network.md) | Direct: this amendment extends that network with reconnection semantics. |
| [ocapn-noise-cryptographic-review](ocapn-noise-cryptographic-review.md) | Direct: its recommendation R3, as rewritten in [#1475](https://github.com/endojs/endo-but-for-bots/pull/1475), settles Open question C1 as Rekey. |
| [ocapn-network-transport-separation](ocapn-network-transport-separation.md) | Indirect: this design lives entirely inside the network layer that document establishes. |
| [ocapn-tcp-syrup-framing](ocapn-tcp-syrup-framing.md) | Indirect: each TCP transport instance mounts a fresh framer; the session-level operation queue bridges across instances. |

## Security Considerations

- The non-negotiable rule is no `(key, nonce)` pair is ever reused under
  ChaCha20-Poly1305. Rekey on every reconnect preserves it by
  construction: no Noise key outlives its transport instance.
- A reconnect is authenticated exactly like a new session (Noise IK plus
  the channel-bound `op:start-session`). The record naming the session
  and epoch travels inside the new encrypted channel, so a
  man-in-the-middle cannot inject a forged reconnect, and a record
  captured from one session cannot reconnect another.
- The designator-comparison tiebreaker is deterministic and uses the
  per-session ephemeral x25519 (not the long-term signing Ed25519),
  so the comparison is fresh every session and does not bias any peer
  across reconnect attempts. It does not leak information beyond what
  is already exchanged in the Noise IK handshake.
- A spurious reconnect (false heartbeat-loss detection) costs one TCP
  handshake and one Noise IK handshake (213 bytes, one round trip); it
  does not compromise confidentiality or integrity.

## Test Plan

- Unit: heartbeat scheduler emits `op:ping` on schedule; receive of any
  op resets the timeout.
- Unit: timeout fires after `SESSION_TIMEOUT` of silence; session
  transitions to reconnecting.
- Integration: kill the TCP connection mid-session; both sides
  reconnect; CapTP messages issued during the gap arrive on the new
  instance.
- Integration: crossed-hellos. Force both sides to detect loss
  simultaneously; verify exactly one transport instance survives.
- Integration: nonce freshness. Across successive reconnects, verify
  each transport instance runs its own handshake and that no
  CipherState is carried from one instance to the next.
- Adversarial: replay an `op:ping` from a previous epoch; verify it is
  silently dropped (per § 2).
- Adversarial: CapTP replay idempotence. Force a reconnect that
  replays unacknowledged `op:deliver` and `op:deliver-only` on the new
  instance; verify the receiver dedupes by
  `(session, answer-position)` and `(session, deliver-id)`
  respectively, so the application observes each operation exactly
  once.
- Adversarial: hard-timeout queue drain. Wedge the reconnect so it
  exhausts `SESSION_HARD_TIMEOUT`; verify the queue settles per the §
  5 terminal-semantics block (caller-side answer-promise rejections
  for `op:deliver`, delivery-failed notifications for
  `op:deliver-only`, and an `op:abort`-equivalent upward terminal
  event on the session itself).
- Adversarial: cross-session reconnect. Attempt a reconnect that names
  a session other than the one the peer holds with this identity, or an
  epoch other than `previous + 1`; verify the responder refuses (per
  § 4 step 3) and does not advance any session's epoch.

## Phased Implementation

1. **Phase 1: `op:ping` and `op:pong` on the wire, every codec.** Add
   the operations to `packages/ocapn/src/codecs/operations.js` (syrup)
   and the matching CBOR codec entry, with readers/writers in both.
   No reconnection yet; just heartbeat-as-liveness on the existing
   tcp-test-only transport. Verify that an idle session is detected
   as lost in seconds rather than hours, and that both codecs round-trip
   `op:ping` and `op:pong` identically.

2. **Phase 2: Session epoch and queue.** Introduce the session-level
   queue of outbound operations and the per-session epoch counter,
   still on a single TCP instance.
   The Phase 2 deliverable's own consumer is a simulated-stall fault
   injector: stall the underlying TCP `write` for longer than
   `HEARTBEAT_INTERVAL` (but less than `SESSION_TIMEOUT`), verify
   outbound operations accumulate in the queue and replay correctly
   when the stall clears, and verify the heartbeat-derived liveness
   signal still distinguishes stall-with-recovery from true loss.
   Phase 2 thus has shippable value independent of Phase 3 (the
   queue+epoch infrastructure plus its own fault-injection harness)
   while remaining the structural prerequisite for Phase 3's
   reconnect-with-rekey path.

3. **Phase 3: Reconnect with Rekey.** Implement transparent reconnect
   using a fresh Noise handshake on the new TCP transport. This
   exercises the queue/epoch/tiebreaker logic and never carries a
   CipherState across instances.

4. **Phase 4: Crossed-hellos.** Add the designator-comparison
   tiebreaker. Most easily tested with a fault injector that forces
   simultaneous loss detection.

## Design Decisions

1. **`op:ping` is a single liveness opcode; `op:pong` is the explicit
   ack carrier.** Each side emits `op:ping` on its own clock and does
   not block on a paired pong; any incoming op resets the per-peer
   liveness timeout. `op:pong` is emitted on its own heartbeat cadence
   and carries the explicit `last_acked_recv_nonce`, resolving C2.

2. **Tiebreaker by designator, not by transcript.**
   Both sides already know both designators and can compute the
   comparison without exchange. Flagged for review (Open question P3).

3. **Rekey on every reconnect; no Resume.**
   A fresh Noise IK handshake costs one round trip and rules out
   `(key, nonce)` reuse by construction (§ 4). Pending maintainer
   confirmation (Open question C1).

4. **Session state lives in the network, not in OCapN core.**
   Consistent with the layering established by
   [ocapn-network-transport-separation](ocapn-network-transport-separation.md).
   OCapN core sees one session; the network hides transport churn.

5. **Heartbeat inside the Noise channel only.**
   One end-to-end authenticated liveness mechanism, no below-Noise
   parallel path. Settled (was Open question P2).

6. **Defaults are tunable but anchored.**
   5 s / 30 s anchor the spec; profile ranges (LAN, WAN, lossy)
   adjust without forking the protocol. Open question T1.

## Open Questions

Consolidated from the sections above. Each is marked with the section
that introduced it.

- **P3** (§ 3): Designator comparison vs. transcript hash for the
  crossed-hellos tiebreaker. Amendment leans toward designator.
- **T1** (§ 5): Default `HEARTBEAT_INTERVAL` / `SESSION_TIMEOUT` and
  whether the OCapN spec recommends a profile range.
- **T2** (§ 5): Fixed vs. adaptive heartbeat. Amendment leans toward
  fixed.
- **C1** (§ 4): Rekey on every reconnect, per R3 of the cryptographic
  review in [#1475](https://github.com/endojs/endo-but-for-bots/pull/1475). This reverses the tentative Resume-with-rekey-cap
  decision on #252 and awaits the maintainer's confirmation.

The following were open in earlier drafts and are now settled:

- **P1** (was § 1): single `op:ping` for liveness, separate `op:pong`
  for explicit nonce ack. Settled per maintainer review on PR #252.
- **P2** (was § 1): heartbeat inside the Noise channel only.
  Settled per maintainer review on PR #252.
- **C2** (was § 4): explicit ack via `op:pong` (not implicit-by-traffic).
  Settled per maintainer review on PR #252.

## Compatibility Considerations

- **Implementation scope: provisional, Noise netlayer only.** The
  `op:ping` and `op:pong` operations and the session-reconnect machinery
  are implemented provisionally in this amendment and used **only** in
  the Noise Protocol netlayer. The other OCapN netlayers
  (`tcp-testing-only`, `tcp-syrups`) do not adopt `op:ping`,
  `op:pong`, or the meta-TCP session layer in this amendment. The
  intent is to validate the design in one netlayer before proposing
  it across the OCapN operation set.
- The `op:ping` and `op:pong` operations are new OCapN operations. The
  amendment flags both as *proposed, pending OCapN-org review*. Until
  the operations are registered in the OCapN spec, OCapN-Noise running
  this amendment is interoperable only with implementations that have
  adopted the same proposal.
- The session epoch and the reconnect handshake live entirely inside
  the OCapN-Noise network and do not affect other networks
  (`tcp-testing-only`, `tcp-syrups`, etc.).
- The behavior is opt-in by network identifier: a locator with
  `network=np` gets the reconnect semantics; a locator with
  `network=tcp-syrups` does not.

## Upgrade Considerations

- Existing OCapN-Noise sessions (if any deployments existed) would
  need to negotiate the heartbeat capability.
  The OCapN-Noise handshake as it stands on `llm`
  (per [ocapn-noise-network](ocapn-noise-network.md)) does not today
  carry a capability-flag field on `op:start-session` or on the
  Noise-side SYNACK.
  The amendment proposes adding such a field as itself an extension
  that ships with this amendment, scoped to a single bit (or short
  bitset) signaling heartbeat support.
  Default behavior: if both sides advertise heartbeat support, the
  heartbeat is on; otherwise the pre-amendment behavior is used.
  Because the capability negotiation itself is new, this is a
  proposal for the OCapN spec group rather than a use of an existing
  hook. Flagged as part of the *proposed, pending OCapN-org review*
  status of the `op:ping` extension.

## Prompt

> When I was discussing OCapN Noise Protocol transports with @erights,
> he reminded me that the TCP default timeout is four days and it does
> not do liveness checks. This generally has led in the direction of
> meta-TCP protocols for CapTP where sessions have a much shorter
> timeout, continuous ping/pong heartbeat, and can be reestablished
> with a TCP reconnect by either side (crossed hellos being accounted
> for). This would have implications for the Noise Protocol
> cryptography, which does have a path for sequencing encrypted packets
> where the sequence may continue across a sequence of TCP sessions.
> Please dispatch a designer to amend the Noise Protocol as it stands
> on llm. This may require tentatively extending OCapN to handle
> op:ping messages (which would be heard as pong by the recipient, if
> that name distinction is useful).
